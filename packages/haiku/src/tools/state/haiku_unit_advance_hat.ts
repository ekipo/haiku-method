// tools/state/haiku_unit_advance_hat.ts — Advance a unit to the
// next hat. On the last hat, auto-completes the unit and progresses
// the workflow engine via the runNext callback.
//
// Hot-path. Performs in order:
//   1. Branch alignment (pre-find + post-find re-align for cross-stage cases)
//   2. Already-completed guard
//   3. Hat backpressure (30s minimum since hat_started_at)
//   4. Output validation (escape-from-intent + missing)
//   5. Per-hat opt-in quality gates with auto-reject (run_quality_gates: true)
//   6a. Last-hat path: hookless-harness gates → scope validation +
//       output auto-population → outputs-empty check → criteria
//       check → completion → feedback closure (assessor only) →
//       merge unit worktree → runNext callback → return phase/
//       stage transition for the parent
//   6b. Non-last-hat path: scope validation → reset-attempts
//       counter → advance to next hat → runNext callback

import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { mergeUnitWorktree } from "../../git-worktree.js"
import { getCapabilities } from "../../harness.js"
import { logSessionEvent } from "../../session-metadata.js"
import { sealIntentState } from "../../state-integrity.js"
import {
	enforceStageBranch,
	FEEDBACK_ASSESSOR_HAT,
	findUnitFile,
	resolveActiveStage,
	resolveUnitHats,
	syncSessionMetadata,
} from "../../state/active-stage.js"
import { runWorkflowTick } from "../../orchestrator/workflow/run-tick.js"

/** Run a workflow tick and return the OrchestratorAction-shaped
 *  result for caller convenience. Used by advance_hat to internally
 *  progress the workflow after unit completion or hat transition. */
function tickWorkflow(slug: string): {
	action: string
	[key: string]: unknown
} {
	const tick = runWorkflowTick(slug)
	if (tick?.action) return tick.action as { action: string; [k: string]: unknown }
	if (!tick) return { action: "error", message: `Intent '${slug}' not found` }
	return {
		action: "error",
		message: `runWorkflowTick produced no action for intent '${slug}' (state: ${tick.state}).`,
	}
}
import {
	findFeedbackFile,
	updateFeedbackFile,
} from "../../state/feedback.js"
import {
	setFrontmatterField,
	setUnitFrontmatterField,
} from "../../state/frontmatter.js"
import {
	gitCommitState,
	injectPushWarning,
	pushWarning,
} from "../../state/git-commit.js"
import {
	completeUnitIteration,
	MAX_UNIT_BOLTS,
	startUnitIteration,
} from "../../state/iterations.js"
import { runInlineQualityGates } from "../../state/quality-gates.js"
import {
	unitOutputExists,
	validateUnitScope,
} from "../../state/scope.js"
import {
	intentDir,
	parseFrontmatter,
	timestamp,
} from "../../state/shared.js"
import { readHatDefs } from "../../studio-reader.js"
import {
	resultPathFor,
	writeResultFile,
} from "../../subagent-prompt-file.js"
import { emitTelemetry } from "../../telemetry.js"
import { defineTool } from "../define.js"
import { text } from "./_text.js"

export default defineTool({
	name: "haiku_unit_advance_hat",
	description:
		"Advance a unit to the next hat in the sequence. When called on the last hat, auto-completes the unit and progresses the workflow. The system resolves the current hat, next hat, and stage internally.",
	inputSchema: {
		type: "object" as const,
		properties: {
			intent: { type: "string" },
			unit: { type: "string" },
			state_file: { type: "string" },
		},
		required: ["intent", "unit"],
	},
	handle(args) {
		// Align branch BEFORE findUnitFile — the unit spec lives on the stage
		// branch, so lookups from intent-main spuriously report unit_not_found.
		// Use active_stage as the best-guess stage to align; findUnitFile below
		// handles the rare cross-stage case internally.
		const advPreBranchErr = enforceStageBranch(
			args.intent as string,
			resolveActiveStage(args.intent as string),
		)
		if (advPreBranchErr) return advPreBranchErr

		const unitInfo = findUnitFile(args.intent as string, args.unit as string)
		if (!unitInfo)
			return text(
				JSON.stringify({
					error: "unit_not_found",
					message: `Unit '${args.unit}' not found in any stage of intent '${args.intent}'.`,
				}),
			)
		const advPath = unitInfo.path
		const advStage = unitInfo.stage

		// Re-enforce if findUnitFile resolved to a different stage (rare but
		// possible for cross-stage go-backs); idempotent when already aligned.
		const advBranchErr = enforceStageBranch(args.intent as string, advStage)
		if (advBranchErr) return advBranchErr

		const unitRaw = readFileSync(advPath, "utf8")
		const { data: unitFm } = parseFrontmatter(unitRaw)

		if (unitFm.status === "completed") {
			return text(
				JSON.stringify({
					error: "unit_already_completed",
					unit: args.unit,
					message: `Unit '${args.unit}' is already completed. Cannot advance hat on a completed unit.`,
				}),
			)
		}

		const currentHat = (unitFm.hat as string) || ""

		// Hat backpressure: prevent rapid-fire advancement.
		const hatStartedAt = unitFm.hat_started_at as string | undefined
		if (hatStartedAt) {
			const elapsed = (Date.now() - new Date(hatStartedAt).getTime()) / 1000
			if (elapsed < 30) {
				return text(
					JSON.stringify({
						error: "hat_too_fast",
						elapsed_seconds: Math.round(elapsed),
						minimum_seconds: 30,
						message:
							"Cannot advance hat — the current hat started less than 30 seconds ago. Each hat must do meaningful work before advancing.",
					}),
				)
			}
		}

		// Validate declared outputs exist (every hat transition).
		// Artifacts may live in the UNIT'S worktree (if running via start_units)
		// OR the main intent dir — check both. Merging to the parent branch
		// happens AFTER this validation, so we can't require parent-dir presence.
		const unitOutputs = (unitFm.outputs as string[]) || []
		if (unitOutputs.length > 0) {
			const iDir = intentDir(args.intent as string)
			const escaped = unitOutputs.filter((o) => {
				const resolved = resolve(iDir, o)
				return !resolved.startsWith(`${resolve(iDir)}/`)
			})
			if (escaped.length > 0) {
				return text(
					JSON.stringify({
						error: "unit_outputs_escaped",
						escaped,
						message: `Cannot advance hat: ${escaped.length} output path(s) escape the intent directory: ${escaped.join(", ")}. Fix the outputs in the unit frontmatter.`,
					}),
				)
			}
			const missing = unitOutputs.filter(
				(o) => !unitOutputExists(args.intent as string, args.unit as string, o),
			)
			if (missing.length > 0) {
				const sf = args.state_file as string | undefined
				if (sf)
					logSessionEvent(sf, {
						event: "outputs_missing",
						intent: args.intent,
						stage: advStage,
						unit: args.unit,
						missing,
					})
				return text(
					JSON.stringify({
						error: "unit_outputs_missing",
						missing,
						message: `Cannot advance hat: ${missing.length} declared output(s) not found in unit worktree or main intent dir: ${missing.join(", ")}. Create them (in the unit worktree if you have one, otherwise in the main intent dir) or remove them from the outputs list.`,
					}),
				)
			}
		}

		// Resolve hat sequence — unit-aware so `feedback-assessor` is
		// appended when the unit declares `closes:` feedback items.
		const stageHats = resolveUnitHats(
			args.intent as string,
			advStage,
			args.unit as string,
		)
		const currentIdx = stageHats.indexOf(currentHat)
		const nextIdx = currentIdx + 1
		const isLastHat = nextIdx >= stageHats.length

		// Per-hat opt-in quality gates with auto-reject. Opt-in by hat (not
		// unit-wide) so early hats like a planner that haven't produced
		// verifiable artifacts yet don't trip on gates the builder will
		// satisfy later. On failure, workflow auto-rejects (bolt+1, same hat
		// retries) rather than asking the agent to fix-and-retry.
		if (currentHat) {
			const intentFile = `${intentDir(args.intent as string)}/intent.md`
			const { data: iFm } = parseFrontmatter(readFileSync(intentFile, "utf8"))
			const gateStudio = (iFm.studio as string) || ""
			if (gateStudio) {
				const hatDefs = readHatDefs(gateStudio, advStage)
				const hatDef = hatDefs[currentHat]
				if (hatDef?.run_quality_gates === true) {
					const gateResult = runInlineQualityGates(
						args.intent as string,
						advPath,
					)
					if (gateResult) {
						const currentBolt = (unitFm.bolt as number) || 1
						if (currentBolt + 1 > MAX_UNIT_BOLTS) {
							return text(
								JSON.stringify({
									error: "max_bolts_exceeded",
									reason: "quality_gate_auto_reject",
									bolt: currentBolt,
									max: MAX_UNIT_BOLTS,
									failures: gateResult.failures,
									message: `Quality gates failed on hat '${currentHat}' and the unit has hit ${MAX_UNIT_BOLTS} bolt iterations. Escalate to the user — the gates are catching real issues this hat cannot resolve in another bolt.\n\n${gateResult.failures.map((f) => `- ${f.name}: '${f.command}' exited ${f.exit_code}${f.output ? `\n  ${f.output.split("\n").slice(0, 3).join("\n  ")}` : ""}`).join("\n")}`,
								}),
							)
						}

						const reason = `auto-reject: quality_gate_failed (${gateResult.failures.map((f) => f.name).join(", ")})`
						completeUnitIteration(advPath, "reject", reason)
						setFrontmatterField(advPath, "hat", currentHat)
						setFrontmatterField(advPath, "bolt", currentBolt + 1)
						setFrontmatterField(advPath, "hat_started_at", timestamp())
						startUnitIteration(advPath, currentHat)
						sealIntentState(args.intent as string)
						{
							const sf = args.state_file as string | undefined
							if (sf)
								logSessionEvent(sf, {
									event: "hat_auto_rejected_gate",
									intent: args.intent,
									stage: advStage,
									unit: args.unit,
									hat: currentHat,
									bolt: currentBolt + 1,
									failed_gates: gateResult.failures.map((f) => f.name),
								})
						}
						emitTelemetry("haiku.hat.auto_reject_gate", {
							intent: args.intent as string,
							stage: advStage,
							unit: args.unit as string,
							hat: currentHat,
							bolt: String(currentBolt + 1),
							failed_gate_count: String(gateResult.failures.length),
						})
						const autoRejectGit = gitCommitState(
							`haiku: auto-reject ${args.unit as string} on ${currentHat} (gate fail) — bolt ${currentBolt + 1}`,
						)
						syncSessionMetadata(
							args.intent as string,
							args.state_file as string | undefined,
						)
						const resultPath = resultPathFor({
							unit: args.unit as string,
							hat: currentHat,
							bolt: currentBolt,
						})
						writeResultFile(resultPath, {
							action: "continue_unit",
							intent: args.intent,
							stage: advStage,
							unit: args.unit,
							hat: currentHat,
							bolt: currentBolt + 1,
							reason,
							_auto_rejected: "quality_gate_failed",
							_failed_gates: gateResult.failures.map((f) => ({
								name: f.name,
								command: f.command,
								exit_code: f.exit_code,
								output: f.output.split("\n").slice(0, 5).join("\n"),
							})),
							_push_warning: pushWarning(autoRejectGit) || undefined,
						})
						return text(
							`Workflow Result written to: ${resultPath}\n\nYOUR FINAL MESSAGE TO THE PARENT MUST BE EXACTLY ONE LINE:\n\nWorkflow Result: ${resultPath}\n\nDo NOT add prose or summary. Parent reads the file to drive the rebolt — gates failed (${gateResult.failures.map((f) => f.name).join(", ")}), bolt ${currentBolt + 1}/${MAX_UNIT_BOLTS}, retrying ${currentHat}.`,
						)
					}
				}
			}
		}

		if (isLastHat) {
			// AUTO-COMPLETE: This was the last hat.

			// Quality gate enforcement for hookless harnesses. When hooks are
			// available (Claude Code, Kiro), the Stop hook runs quality_gates
			// commands. For hookless harnesses, run them here before allowing
			// the unit to complete. runInlineQualityGates is a no-op when no
			// gates are defined, so this works for any stage/hat combination.
			if (!getCapabilities().hooks) {
				const qualityGates = runInlineQualityGates(
					args.intent as string,
					advPath,
				)
				if (qualityGates) {
					return text(JSON.stringify(qualityGates))
				}
			}

			// Scope enforcement + output auto-population (harness-agnostic).
			// MUST run before the outputs-empty check: validateUnitScope
			// auto-populates unit.outputs[] from the git diff as a side
			// effect, so hookless harnesses end up with a correctly populated
			// outputs list. Also catches writes outside the stage's declared
			// scope.
			{
				const intentFile = `${intentDir(args.intent as string)}/intent.md`
				const { data: iFm } = parseFrontmatter(
					readFileSync(intentFile, "utf8"),
				)
				const scopeStudio = (iFm.studio as string) || ""
				const scopeResult = scopeStudio
					? validateUnitScope(
							args.intent as string,
							scopeStudio,
							advStage,
							args.unit as string,
						)
					: null
				if (scopeResult) {
					const sf = args.state_file as string | undefined
					if (sf)
						logSessionEvent(sf, {
							event: "unit_scope_violation",
							intent: args.intent,
							stage: advStage,
							unit: args.unit,
							violations: scopeResult.violations,
						})
					const allowedSummary = [
						...scopeResult.scope.intentGlobs.map(
							(g) => `  - \`${g}\` (intent-relative)`,
						),
						...scopeResult.scope.repoGlobs.map(
							(g) => `  - \`${g}\` (repo-relative)`,
						),
						scopeResult.scope.repoWildcard
							? "  - any repo-level path (stage declares scope: repo with wildcard location)"
							: "",
					]
						.filter(Boolean)
						.join("\n")
					return text(
						JSON.stringify({
							error: "unit_scope_violation",
							violations: scopeResult.violations,
							scope: scopeResult.scope,
							message:
								`Cannot complete unit: ${scopeResult.violations.length} file(s) were written outside the stage's declared scope.\n\n` +
								`Out-of-bounds files:\n${scopeResult.violations.map((v) => `  - ${v}`).join("\n")}\n\n` +
								`Allowed paths (stage output templates + workflow metadata):\n${allowedSummary}\n\n` +
								`To resolve (in the unit worktree): (a) drop ALL unit commits with \`git reset --hard $(git merge-base HEAD haiku/${args.intent as string}/${advStage})\` — recommended if the unit just started and few commits landed; or (b) amend the bad file out of the latest commit with \`git rm <file> && git commit --amend --no-edit\`; or (c) whole-commit rollback with \`git revert --no-edit <commit-sha>\` for each bad commit.\n\nNOTE: \`git checkout HEAD -- <file>\` does NOT work on committed files (it's a no-op when the file matches HEAD). Use one of the above.\n\nAlternatively: (d) update the stage's output template \`location:\` / \`scope:\` if this pattern is legitimate, or (e) call \`haiku_revisit\` if the scope itself is wrong.`,
						}),
					)
				}
			}

			// Re-read the unit frontmatter: validateUnitScope may have
			// auto-populated outputs[] from the git diff.
			const unitRawAfterPopulate = readFileSync(advPath, "utf8")
			const { data: unitFmAfter } = parseFrontmatter(unitRawAfterPopulate)
			const unitOutputsAfter = (unitFmAfter.outputs as string[]) || []

			// Clean scope — reset the reject-attempts counter. Otherwise a
			// counter bumped by a prior reject cycle would persist through a
			// clean advance and falsely escalate the next reject cycle. Reseal
			// immediately because subsequent early returns would otherwise
			// exit with an unsealed counter write, tripping tamper detection
			// on the next runNext.
			if (
				(((unitFmAfter.scope_reject_attempts as number) ?? 0) as number) > 0
			) {
				setFrontmatterField(advPath, "scope_reject_attempts", 0)
				sealIntentState(args.intent as string)
			}

			if (unitOutputsAfter.length === 0) {
				const sf = args.state_file as string | undefined
				if (sf)
					logSessionEvent(sf, {
						event: "outputs_empty",
						intent: args.intent,
						stage: advStage,
						unit: args.unit,
					})
				return text(
					JSON.stringify({
						error: "unit_outputs_empty",
						message:
							"Cannot complete unit: no outputs were produced. Every unit must write at least one artifact that the the workflow engine can detect (stage artifact under `stages/<stage>/...` excluding `units/`/`state.json`, knowledge document under `knowledge/`, or a file matching a stage output template `location:`). The workflow engine auto-populates `outputs:` from the git diff at advance time; if you've written files but they're not showing up, verify they've been committed in the unit worktree, or add them explicitly to the unit's `outputs:` frontmatter field.",
					}),
				)
			}

			const unchecked = (unitRaw.match(/- \[ \]/g) || []).length
			if (unchecked > 0) {
				const sf = args.state_file as string | undefined
				if (sf)
					logSessionEvent(sf, {
						event: "criteria_not_met",
						intent: args.intent,
						stage: advStage,
						unit: args.unit,
						unchecked,
					})
				return text(
					JSON.stringify({
						error: "criteria_not_met",
						unchecked,
						message: `Cannot complete unit: ${unchecked} completion criteria still unchecked. Address them, then call haiku_unit_advance_hat again.`,
					}),
				)
			}

			completeUnitIteration(advPath, "advance")
			// Dual-write: parent (for workflow reads) AND unit worktree (so the
			// merge commit captures the completion state).
			setUnitFrontmatterField(
				args.intent as string,
				advStage,
				args.unit as string,
				"status",
				"completed",
			)
			setUnitFrontmatterField(
				args.intent as string,
				advStage,
				args.unit as string,
				"completed_at",
				timestamp(),
			)
			sealIntentState(args.intent as string)

			// Feedback closure is the exclusive responsibility of the
			// `feedback-assessor` hat. The unit's `closes:` field is the CLAIM
			// (written at elaborate time); the assessor reads that claim,
			// verifies the unit's outputs against each feedback body, and —
			// on advance — sets `closed_by` on the feedback items it
			// validated. Any other hat completing the unit does NOT touch
			// feedback state; it cannot self-certify.
			if (currentHat === FEEDBACK_ASSESSOR_HAT) {
				const unitRaw2 = readFileSync(advPath, "utf8")
				const unitParsed = parseFrontmatter(unitRaw2)
				const closes = (unitParsed.data.closes as string[]) || []
				for (const fbId of closes) {
					const found = findFeedbackFile(
						args.intent as string,
						advStage,
						fbId,
					)
					// Agents cannot close human-authored feedback — the human
					// author must do that themselves. Leave such items
					// untouched; the review UI will surface them.
					if (found?.data.author_type === "human") continue
					updateFeedbackFile(
						args.intent as string,
						advStage,
						fbId,
						{ status: "closed", closed_by: args.unit as string },
						"agent",
					)
				}
			}

			emitTelemetry("haiku.unit.completed", {
				intent: args.intent as string,
				stage: advStage,
				unit: args.unit as string,
			})
			{
				const sf = args.state_file as string | undefined
				if (sf)
					logSessionEvent(sf, {
						event: "unit_completed",
						intent: args.intent,
						stage: advStage,
						unit: args.unit,
					})
			}
			const completeGit = gitCommitState(
				`haiku: complete unit ${args.unit as string}`,
			)

			// Merge the unit branch into its STAGE branch. Units ALWAYS fan
			// in to their stage branch regardless of whatever branch the
			// MCP's parent worktree happens to be on — the workflow engine works in the
			// scope of the stage, not the parent worktree. mergeUnitWorktree
			// uses a temp worktree so the MCP's checkout is never disturbed.
			const intentSlug = args.intent as string
			const parentBranchName = `haiku/${intentSlug}/${advStage}`
			const mergeResult = mergeUnitWorktree(
				intentSlug,
				args.unit as string,
				advStage,
			)
			if (!mergeResult.success) {
				const worktreePath = join(
					process.cwd(),
					".haiku",
					"worktrees",
					intentSlug,
					args.unit as string,
				)
				return text(
					JSON.stringify(
						{
							action: "merge_conflict",
							status: "completed_merge_failed",
							intent: args.intent,
							unit: args.unit,
							worktree: worktreePath,
							error: mergeResult.message,
							message: `Unit completed but merge to parent branch failed: ${mergeResult.message}. RESOLVE: cd to the parent branch (\`git checkout ${parentBranchName}\`), merge manually (\`git merge haiku/${intentSlug}/${args.unit} --no-edit\`), resolve any conflicts, then commit and push. If you cannot resolve, ask the user for help.`,
						},
						null,
						2,
					),
				)
			}

			syncSessionMetadata(
				args.intent as string,
				args.state_file as string | undefined,
			)
			const mergeNote =
				mergeResult.message === "no worktree"
					? ""
					: ` (${mergeResult.message})`

			// Internally call runNext to progress the workflow state, but DO NOT
			// return orchestration-level actions (start_units, start_unit) to
			// the caller — those are for the PARENT agent, not the subagent
			// that just finished its hat. The subagent's job ends here; the
			// parent calls haiku_run_next after all wave subagents return.
			//
			// Phase/stage transitions (advance_phase, advance_stage, review,
			// intent_complete) are returned so the last caller can propagate
			// the signal back to the parent via its final message.
			const next = tickWorkflow(args.intent as string)
			const subagentLocalActions = new Set([
				"continue_unit",
				"continue_units",
				"blocked",
				"start_units",
				"start_unit",
			])
			if (subagentLocalActions.has(next.action as string)) {
				return text(
					`Unit ${args.unit} completed (last hat)${mergeNote}. Next action (${next.action}) is for the parent orchestrator — this subagent's job ends here. The parent will call haiku_run_next when all wave subagents return.${pushWarning(completeGit)}`,
				)
			}
			const payload = injectPushWarning(
				{ ...next, _unit_completed: args.unit, _merge: mergeNote },
				completeGit,
			)
			const resultPath = resultPathFor({
				unit: args.unit as string,
				hat: currentHat,
				bolt: (unitFm.bolt as number) || 1,
			})
			writeResultFile(resultPath, payload)
			return text(
				`Workflow Result written to: ${resultPath}\n\nYOUR FINAL MESSAGE TO THE PARENT MUST BE EXACTLY ONE LINE:\n\nWorkflow Result: ${resultPath}\n\nDo NOT add prose, summary, or description. The parent reads the file to drive the next workflow action (phase/stage/intent transition).`,
			)
		}

		// NOT last hat: advance to next.
		// Quality gates run ONLY at unit completion (last hat) on hookless
		// harnesses. The intent-+-unit gate list is unscoped — running them
		// per-hat would punish early hats for outputs the later hats haven't
		// produced yet (e.g. `npm test` before any code is written). CC's
		// Stop hook fires per-subagent but each subagent's Stop is the
		// "natural endpoint" for its hat's work; we don't have that signal
		// in hookless mode, so we enforce the safer "once at completion"
		// boundary.
		//
		// Scope validation DOES run at every hat transition — out-of-bounds
		// writes accumulate forever until surfaced.
		{
			const intentFile = `${intentDir(args.intent as string)}/intent.md`
			const { data: iFm } = parseFrontmatter(readFileSync(intentFile, "utf8"))
			const scopeStudio = (iFm.studio as string) || ""
			const scopeResult = scopeStudio
				? validateUnitScope(
						args.intent as string,
						scopeStudio,
						advStage,
						args.unit as string,
					)
				: null
			if (scopeResult) {
				const sf = args.state_file as string | undefined
				if (sf)
					logSessionEvent(sf, {
						event: "unit_scope_violation",
						intent: args.intent,
						stage: advStage,
						unit: args.unit,
						hat: currentHat,
						violations: scopeResult.violations,
					})
				const allowedSummary = [
					...scopeResult.scope.intentGlobs.map(
						(g) => `  - \`${g}\` (intent-relative)`,
					),
					...scopeResult.scope.repoGlobs.map(
						(g) => `  - \`${g}\` (repo-relative)`,
					),
					scopeResult.scope.repoWildcard
						? "  - any repo-level path (stage declares scope: repo with wildcard location)"
						: "",
				]
					.filter(Boolean)
					.join("\n")
				return text(
					JSON.stringify({
						error: "unit_scope_violation",
						hat: currentHat,
						violations: scopeResult.violations,
						scope: scopeResult.scope,
						message:
							`Cannot advance hat '${currentHat}': ${scopeResult.violations.length} file(s) were written outside the stage's declared scope.\n\n` +
							`Out-of-bounds files:\n${scopeResult.violations.map((v) => `  - ${v}`).join("\n")}\n\n` +
							`Allowed paths (stage output templates + workflow metadata):\n${allowedSummary}\n\n` +
							`Revert the out-of-bounds commits in the unit worktree: drop all unit commits with \`git reset --hard $(git merge-base HEAD haiku/${args.intent as string}/${advStage})\`, or amend a single file out with \`git rm <file> && git commit --amend --no-edit\`, or \`git revert --no-edit <commit-sha>\` for a whole commit. NOTE: \`git checkout HEAD -- <file>\` is a no-op on committed files. Or update the stage's output template if this pattern is legitimate. Do NOT advance with scope violations — downstream hats will run blind.`,
					}),
				)
			}
		}

		// Clean scope — reset the reject-attempts counter.
		{
			const { data: advFm } = parseFrontmatter(readFileSync(advPath, "utf8"))
			if ((((advFm.scope_reject_attempts as number) ?? 0) as number) > 0) {
				setFrontmatterField(advPath, "scope_reject_attempts", 0)
			}
		}

		const nextHat = stageHats[nextIdx]

		completeUnitIteration(advPath, "advance")
		setFrontmatterField(advPath, "hat", nextHat)
		setFrontmatterField(advPath, "hat_started_at", timestamp())
		startUnitIteration(advPath, nextHat)
		sealIntentState(args.intent as string)
		{
			const sf = args.state_file as string | undefined
			if (sf)
				logSessionEvent(sf, {
					event: "hat_advanced",
					intent: args.intent,
					stage: advStage,
					unit: args.unit,
					hat: nextHat,
				})
		}
		emitTelemetry("haiku.hat.transition", {
			intent: args.intent as string,
			stage: advStage,
			unit: args.unit as string,
			hat: nextHat,
		})
		const advGit = gitCommitState(
			`haiku: advance hat to ${nextHat} on ${args.unit as string}`,
		)
		syncSessionMetadata(
			args.intent as string,
			args.state_file as string | undefined,
		)
		const next = tickWorkflow(args.intent as string)
		const payload = injectPushWarning(
			{ ...next, _hat_advanced: nextHat },
			advGit,
		)
		const resultPath = resultPathFor({
			unit: args.unit as string,
			hat: currentHat,
			bolt: (unitFm.bolt as number) || 1,
		})
		writeResultFile(resultPath, payload)
		return text(
			`Workflow Result written to: ${resultPath}\n\nYOUR FINAL MESSAGE TO THE PARENT MUST BE EXACTLY ONE LINE:\n\nWorkflow Result: ${resultPath}\n\nDo NOT add prose, summary, or description. The parent reads the file to drive the next workflow action.`,
		)
	},
})
