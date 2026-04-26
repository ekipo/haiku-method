// state-tools.ts — H·AI·K·U resource MCP tools
//
// One tool per resource per operation. Under the hood: frontmatter + JSON files.
// The caller doesn't need to know file paths — just resource identifiers.

import { execFileSync, execSync, spawn, spawnSync } from "node:child_process"
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs"
import { join, resolve } from "node:path"
import {
	dedupeFrontmatterKeys,
	isDuplicateKeyError,
} from "@haiku/shared/frontmatter"
import matter from "gray-matter"
import { getPendingVersion, hasPendingUpdate } from "./auto-update.js"
import { features, resolvePluginRoot } from "./config.js"
// fsm-fields module retained for state-integrity sealing; no direct imports
// needed here since the completion-only guard is narrow to status/completed.
import {
	addTempWorktree,
	commitAndPushFromWorktree,
	consolidateStageBranches,
	ensureOnStageBranch,
	fetchOrigin,
	getCurrentBranch,
	getMainlineBranch,
	isBranchMerged,
	listIntentBranches,
	listOrphanDiscreteIntents,
	mergeUnitWorktree,
	openPullRequest,
	readFileFromBranch,
	removeTempWorktree,
} from "./git-worktree.js"
import { getCapabilities } from "./harness.js"
import { escalate } from "./model-selection.js"
import { reportError } from "./sentry.js"
import { logSessionEvent, writeHaikuMetadata } from "./session-metadata.js"
import { sealIntentState } from "./state-integrity.js"
import {
	listStudios,
	readHatDefs,
	readOperationDefs,
	readReflectionDefs,
	readStageArtifactDefs,
	resolveStudio,
} from "./studio-reader.js"
import {
	resultPathFor,
	setSessionId,
	writeResultFile,
} from "./subagent-prompt-file.js"
import {
	type AppliedFix,
	applyAutoFixes,
	buildMultiBranchReport,
	buildRepairReport,
	INTENT_TITLE_MAX_LENGTH,
	intentTitleNeedsRepair,
	type RepairCwdResult,
	type RepairIssue,
	repairAllBranches,
	repairCwd,
} from "./state/repair.js"
import {
	appendFeedbackIteration,
	appendFeedbackReply,
	countPendingFeedback,
	deleteFeedbackFile,
	deriveAuthorType,
	feedbackDir,
	FEEDBACK_ORIGINS,
	type FeedbackIteration,
	type FeedbackItem,
	type FeedbackOrigin,
	type FeedbackReply,
	FEEDBACK_STATUSES,
	type FeedbackStatus,
	findFeedbackFile,
	incrementFeedbackBolt,
	MAX_CONCURRENT_SUBAGENTS,
	MAX_FIX_LOOP_BOLTS,
	MAX_INTEGRATOR_ATTEMPTS,
	readFeedbackFiles,
	slugifyTitle,
	updateFeedbackFile,
	writeFeedbackFile,
} from "./state/feedback.js"
import {
	type AppendIterationResult,
	appendStageIteration,
	closeCurrentStageIteration,
	computeFeedbackSignature,
	getStageIterationCount,
	MAX_STAGE_ITERATIONS,
	MAX_UNIT_BOLTS,
	type StageIteration,
	type StageIterationResult,
	type StageIterationTrigger,
	startUnitIteration,
	completeUnitIteration,
	type UnitHatResult,
	type UnitIteration,
} from "./state/iterations.js"
import {
	getNestedField,
	intentFromCurrentBranch,
	listVisibleIntents,
	listVisibleIntentSlugs,
	parseYaml,
	setFrontmatterField,
	setUnitFrontmatterField,
} from "./state/frontmatter.js"
import {
	type GitCommitResult,
	gitCommitState,
	gitCommitStateBackgroundPush,
	injectPushWarning,
	pushWarning,
	validateBranch,
} from "./state/git-commit.js"
import {
	enforceStageBranch,
	FEEDBACK_ASSESSOR_HAT,
	findUnitFile,
	getRunNextHandler,
	resolveActiveStage,
	resolveStageHats,
	resolveStageScope,
	resolveUnitHats,
	type RunNextHandler,
	setRunNextHandler,
	syncSessionMetadata,
} from "./state/active-stage.js"
import {
	type QualityGateResult,
	runInlineQualityGates,
} from "./state/quality-gates.js"
import {
	unitIntentDir,
	unitOutputExists,
	validateUnitScope,
} from "./state/scope.js"
import { stateToolDefs } from "./state/tool-defs.js"
import { stateToolHandlers } from "./tools/state/index.js"

export { stateToolDefs }
import {
	_resetIsGitRepoForTests,
	findHaikuRoot,
	intentDir,
	isGitRepo,
	matchesGlob,
	normalizeDates,
	parseFrontmatter,
	readJson,
	stageDir,
	stageStatePath,
	timestamp,
	unitPath,
	writeJson,
} from "./state/shared.js"
import { emitTelemetry } from "./telemetry.js"
import { getPluginVersion, MCP_VERSION } from "./version.js"

// Re-export shared helpers + repair surface so existing consumers (orchestrator,
// tests, prompts) that imported from "./state-tools" continue to resolve. The
// move to ./state/{shared,repair} reduces this file by ~1650 lines without
// breaking anyone's imports.
export {
	_resetIsGitRepoForTests,
	findHaikuRoot,
	intentDir,
	isGitRepo,
	matchesGlob,
	parseFrontmatter,
	readJson,
	stageDir,
	stageStatePath,
	timestamp,
	unitPath,
	writeJson,
}
export {
	type AppliedFix,
	applyAutoFixes,
	INTENT_TITLE_MAX_LENGTH,
	intentTitleNeedsRepair,
	type RepairCwdResult,
	type RepairIssue,
}
export {
	appendFeedbackIteration,
	appendFeedbackReply,
	countPendingFeedback,
	deleteFeedbackFile,
	deriveAuthorType,
	feedbackDir,
	FEEDBACK_ORIGINS,
	type FeedbackIteration,
	type FeedbackItem,
	type FeedbackOrigin,
	type FeedbackReply,
	FEEDBACK_STATUSES,
	type FeedbackStatus,
	findFeedbackFile,
	incrementFeedbackBolt,
	MAX_CONCURRENT_SUBAGENTS,
	MAX_FIX_LOOP_BOLTS,
	MAX_INTEGRATOR_ATTEMPTS,
	readFeedbackFiles,
	slugifyTitle,
	updateFeedbackFile,
	writeFeedbackFile,
}
export {
	getNestedField,
	intentFromCurrentBranch,
	listVisibleIntents,
	listVisibleIntentSlugs,
	parseYaml,
	setFrontmatterField,
	setUnitFrontmatterField,
}
export {
	type AppendIterationResult,
	appendStageIteration,
	closeCurrentStageIteration,
	completeUnitIteration,
	computeFeedbackSignature,
	getStageIterationCount,
	MAX_STAGE_ITERATIONS,
	MAX_UNIT_BOLTS,
	type StageIteration,
	type StageIterationResult,
	type StageIterationTrigger,
	startUnitIteration,
	type UnitHatResult,
	type UnitIteration,
}
export {
	type GitCommitResult,
	gitCommitState,
	gitCommitStateBackgroundPush,
	injectPushWarning,
	pushWarning,
	validateBranch,
}
export {
	enforceStageBranch,
	FEEDBACK_ASSESSOR_HAT,
	findUnitFile,
	resolveActiveStage,
	resolveStageHats,
	resolveStageScope,
	resolveUnitHats,
	type RunNextHandler,
	setRunNextHandler,
	syncSessionMetadata,
}
export {
	unitIntentDir,
	unitOutputExists,
	validateUnitScope,
}

// ── Slug validation ─────────────────────────────────────────────────────────

/**
 * Validate every path-identifier arg in a tool args object. Returns null if
 * everything is fine, or a pre-built MCP error response if any arg contains
 * path traversal / separator characters. Use at the top of MCP tool
 * handlers to reject malicious identifiers before any filesystem access.
 *
 * Checked keys: `intent`, `slug`, `stage`, `unit`, `feedback_id`. All five
 * are used to construct filesystem paths (e.g.
 * `intent/{slug}/stages/{stage}/units/{unit}.md`,
 * `intent/{slug}/stages/{stage}/feedback/{feedback_id}`)
 * in various handlers, so any of them can be a traversal vector.
 */
export function validateSlugArgs(
	args: Record<string, unknown>,
): { content: Array<{ type: "text"; text: string }>; isError: true } | null {
	for (const key of ["intent", "slug", "stage", "unit", "feedback_id"]) {
		const val = args[key]
		if (typeof val === "string" && /[/\\]|\.\./.test(val)) {
			return {
				content: [
					{
						type: "text" as const,
						text: `Invalid ${key}: "${val}" — path identifiers must not contain path separators or traversal sequences.`,
					},
				],
				isError: true,
			}
		}
	}
	return null
}

// ── Tool handlers ──────────────────────────────────────────────────────────

export function handleStateTool(
	name: string,
	args: Record<string, unknown>,
): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
	const text = (s: string) => ({
		content: [{ type: "text" as const, text: s }],
	})

	// Capture the CC session id from the hook-injected _session_context so
	// subagent-prompt tmpfiles are scoped to the right session dir instead
	// of falling back to process PID.
	const ctx = args._session_context as Record<string, string> | undefined
	if (ctx?.CLAUDE_SESSION_ID) {
		setSessionId(ctx.CLAUDE_SESSION_ID)
	}

	const validationError = validateSlugArgs(args)
	if (validationError) return validationError

	// Per-tool handlers in tools/state/* take priority over the legacy
	// switch. Migrated tools live in their own file with defineTool();
	// the switch below handles the rest until they all migrate.
	const perToolHandler = stateToolHandlers.get(name)
	if (perToolHandler) {
		const result = perToolHandler.handle(args)
		// Per-tool handlers may be sync; legacy contract is sync, so
		// preserve that. If a future handler returns a promise, await it.
		if (result instanceof Promise) {
			throw new Error(
				`Tool '${name}' returned a Promise but handleStateTool is synchronous`,
			)
		}
		return result
	}

	switch (name) {
		// ── Unit ──
		case "haiku_unit_set": {
			// Guard: only `status = "completed"` is FSM-protected. Agents may
			// freely change status to pending/active/blocked and set any other
			// field for legitimate repair — the FSM owns the completion moment
			// exclusively (via advance_hat's auto-complete on the last hat).
			// Direct "completed" writes bypass merge-back, scope validation,
			// and the feedback-assessor, so they're the only value blocked.
			const field = args.field as string
			const value = args.value
			if (field === "status" && value === "completed") {
				return text(
					JSON.stringify({
						error: "fsm_completion_protected",
						field,
						value,
						message:
							'Cannot set status to "completed" directly — unit completion is FSM-controlled. Call `haiku_unit_advance_hat` to let the FSM auto-complete the unit\'s last hat, which runs scope validation, feedback-assessor closure, and worktree merge-back. Setting status to other values (pending, active, blocked) is fine.',
					}),
				)
			}
			const unitSetBranchErr = enforceStageBranch(
				args.intent as string,
				args.stage as string,
			)
			if (unitSetBranchErr) return unitSetBranchErr
			const path = unitPath(
				args.intent as string,
				args.stage as string,
				args.unit as string,
			)
			setFrontmatterField(path, args.field as string, args.value)
			return text("ok")
		}
		case "haiku_unit_start": {
			// Resolve stage and first hat internally
			const stage = resolveActiveStage(args.intent as string)
			if (!stage)
				return text(
					JSON.stringify({
						error: "no_active_stage",
						message:
							"No active stage found for this intent. Call haiku_run_next first.",
					}),
				)
			const unitStartBranchErr = enforceStageBranch(
				args.intent as string,
				stage,
			)
			if (unitStartBranchErr) return unitStartBranchErr
			const uPath = unitPath(args.intent as string, stage, args.unit as string)

			// Guard: reject if unit is already active (prevents duplicate work)
			if (existsSync(uPath)) {
				const { data: existingFm } = parseFrontmatter(
					readFileSync(uPath, "utf8"),
				)
				if (existingFm.status === "active") {
					const scope = resolveStageScope(args.intent as string, stage)
					return text(
						JSON.stringify({
							error: "unit_already_active",
							unit: args.unit,
							hat: existingFm.hat || "",
							message: `Unit '${args.unit}' is already active (hat: ${existingFm.hat || "unknown"}). Do not start it again — continue working on it or call haiku_unit_advance_hat when done.`,
						}) + (scope ? `\n\n${scope}` : ""),
					)
				}
			}

			const stageHats = resolveStageHats(args.intent as string, stage)
			const firstHat = stageHats[0] || ""

			setFrontmatterField(uPath, "status", "active")
			setFrontmatterField(uPath, "bolt", 1)
			setFrontmatterField(uPath, "hat", firstHat)
			setFrontmatterField(uPath, "started_at", timestamp())
			setFrontmatterField(uPath, "hat_started_at", timestamp())
			startUnitIteration(uPath, firstHat)
			// Reseal: these are UNIT_FIELDS, so the tamper detector needs the
			// updated checksum before the next verifyIntentState() call.
			sealIntentState(args.intent as string)
			emitTelemetry("haiku.unit.started", {
				intent: args.intent as string,
				stage,
				unit: args.unit as string,
				hat: firstHat,
			})
			const sf = args.state_file as string | undefined
			if (sf)
				logSessionEvent(sf, {
					event: "unit_started",
					intent: args.intent,
					stage,
					unit: args.unit,
					hat: firstHat,
				})
			const gitResult = gitCommitState(
				`haiku: start unit ${args.unit as string}`,
			)
			syncSessionMetadata(
				args.intent as string,
				args.state_file as string | undefined,
			)
			const scope = resolveStageScope(args.intent as string, stage)
			return text((scope ? `ok\n\n${scope}` : "ok") + pushWarning(gitResult))
		}
		case "haiku_unit_advance_hat": {
			// Align branch BEFORE findUnitFile — the unit spec lives on the stage
			// branch, so lookups from intent-main spuriously report unit_not_found.
			// Use active_stage as the best-guess stage to align; findUnitFile below
			// handles the rare cross-stage case internally.
			const advPreBranchErr = enforceStageBranch(
				args.intent as string,
				resolveActiveStage(args.intent as string),
			)
			if (advPreBranchErr) return advPreBranchErr

			// Resolve stage and unit path internally
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

			// Guard: reject if unit is already completed
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

			// ── Hat backpressure: prevent rapid-fire advancement ──
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

			// ── Validate declared outputs exist (every hat transition) ──
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
					(o) =>
						!unitOutputExists(args.intent as string, args.unit as string, o),
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

			// ── Per-hat opt-in quality gates with auto-reject ─────────────
			// A hat may declare `run_quality_gates: true` in its frontmatter.
			// When the agent calls advance_hat from such a hat, the FSM runs
			// the unit's quality_gates BEFORE allowing the transition. On
			// failure, the FSM auto-rejects the hat (bolt+1, same hat retries)
			// rather than returning an error and asking the agent to fix-and-
			// retry. This eliminates the agent decision point ("is this gate
			// failure something I fix here, or do I reject_hat?") — gate fail
			// always means "this hat's output didn't pass; same hat, next bolt."
			//
			// Opt-in by hat (not unit-wide) so early hats like a planner that
			// haven't produced verifiable artifacts yet don't trip on gates
			// the builder will satisfy later. The builder hat is the typical
			// declarer.
			//
			// Runs harness-agnostic: hookless harnesses already run gates at
			// the LAST hat's advance unconditionally (see below); this layer
			// adds an EARLIER opt-in checkpoint AND swaps the failure mode
			// from agent-retry to auto-reject. For Claude Code (hooks), the
			// Stop hook still runs gates as a backstop after the tool call
			// completes — but with the boolean set, the auto-reject already
			// fired here so the Stop hook sees a clean state.
			if (currentHat) {
				// Defer the intent.md read + frontmatter parse until we know we
				// have a current hat — most advance_hat calls hit this path,
				// but skipping the I/O for the no-hat edge case keeps the
				// hot path lean.
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
								`FSM Result written to: ${resultPath}\n\nYOUR FINAL MESSAGE TO THE PARENT MUST BE EXACTLY ONE LINE:\n\nFSM Result: ${resultPath}\n\nDo NOT add prose or summary. Parent reads the file to drive the rebolt — gates failed (${gateResult.failures.map((f) => f.name).join(", ")}), bolt ${currentBolt + 1}/${MAX_UNIT_BOLTS}, retrying ${currentHat}.`,
							)
						}
					}
				}
			}

			if (isLastHat) {
				// ── AUTO-COMPLETE: This was the last hat ──

				// ── Quality gate enforcement for hookless harnesses ──
				// When hooks are available (Claude Code, Kiro), the Stop hook runs
				// quality_gates commands. For hookless harnesses, run them here
				// before allowing the unit to complete.
				//
				// Run unconditionally on unit completion — runInlineQualityGates
				// is a no-op when the unit has no quality_gates defined, so this
				// works for any stage/hat combination including custom studios
				// that use non-standard hat names.
				if (!getCapabilities().hooks) {
					const qualityGates = runInlineQualityGates(
						args.intent as string,
						advPath,
					)
					if (qualityGates) {
						return text(JSON.stringify(qualityGates))
					}
				}

				// ── Scope enforcement + output auto-population (harness-agnostic) ──
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
									`Allowed paths (stage output templates + FSM metadata):\n${allowedSummary}\n\n` +
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
				// counter bumped by a prior reject cycle would persist through
				// a clean advance and falsely escalate the next reject cycle.
				// Reseal immediately because subsequent early returns
				// (unit_outputs_empty / criteria_not_met) would otherwise exit
				// with an unsealed counter write, tripping tamper detection
				// on the next runNext.
				if (
					(((unitFmAfter.scope_reject_attempts as number) ?? 0) as number) > 0
				) {
					setFrontmatterField(advPath, "scope_reject_attempts", 0)
					sealIntentState(args.intent as string)
				}

				// Require at least one tracked output.
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
								"Cannot complete unit: no outputs were produced. Every unit must write at least one artifact that the FSM can detect (stage artifact under `stages/<stage>/...` excluding `units/`/`state.json`, knowledge document under `knowledge/`, or a file matching a stage output template `location:`). The FSM auto-populates `outputs:` from the git diff at advance time; if you've written files but they're not showing up, verify they've been committed in the unit worktree, or add them explicitly to the unit's `outputs:` frontmatter field.",
						}),
					)
				}

				// Verify completion criteria are checked
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

				// Scope enforcement already ran above (moved before the
				// outputs-empty check so validateUnitScope can auto-populate
				// outputs[] before we validate non-emptiness).

				completeUnitIteration(advPath, "advance")
				// Dual-write: parent (for FSM reads) AND unit worktree (so
				// the merge commit captures the completion state).
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
				// Reseal: UNIT_FIELDS write before _runNext triggers verify.
				sealIntentState(args.intent as string)

				// Feedback closure is the exclusive responsibility of the
				// `feedback-assessor` hat. The unit's `closes:` field is the
				// CLAIM (written at elaborate time); the assessor reads that
				// claim, verifies the unit's outputs against each feedback
				// body, and — on advance — sets `closed_by` on the feedback
				// items it validated. Any other hat completing the unit does
				// NOT touch feedback state; it cannot self-certify.
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
						// Agents cannot close human-authored feedback — the
						// human author must do that themselves. Leave such
						// items untouched; the review UI will surface them.
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

				// Merge the unit branch into its STAGE branch. Units ALWAYS
				// fan in to their stage branch regardless of whatever branch
				// the MCP's parent worktree happens to be on — the FSM works
				// in the scope of the stage, not the parent worktree.
				// `mergeUnitWorktree` uses a temp worktree so the MCP's
				// checkout is never disturbed.
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

				// Internally call runNext to progress the FSM state, but DO NOT
				// return orchestration-level actions (start_units, start_unit) to
				// the caller — those are for the PARENT agent, not the subagent
				// that just finished its hat. The subagent's job ends here; the
				// parent calls haiku_run_next after all wave subagents return.
				//
				// Phase/stage transitions (advance_phase, advance_stage, review,
				// intent_complete) are returned so the last caller can propagate
				// the signal back to the parent via its final message.
				const _runNext = getRunNextHandler()
				if (_runNext) {
					const next = _runNext(args.intent as string)
					const subagentLocalActions = new Set([
						"continue_unit",
						"continue_units",
						"blocked",
						"start_units",
						"start_unit",
					])
					if (subagentLocalActions.has(next.action as string)) {
						return text(
							`Unit ${args.unit} completed (last hat)${mergeNote}. FSM next action (${next.action}) is for the parent orchestrator — this subagent's job ends here. The parent will call haiku_run_next when all wave subagents return.${pushWarning(completeGit)}`,
						)
					}
					// Phase/stage-level transitions (advance_phase, review, advance_stage,
					// intent_complete, etc.) — return so the last wave subagent can
					// signal the transition back to the parent.
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
						`FSM Result written to: ${resultPath}\n\nYOUR FINAL MESSAGE TO THE PARENT MUST BE EXACTLY ONE LINE:\n\nFSM Result: ${resultPath}\n\nDo NOT add prose, summary, or description. The parent reads the file to drive the next FSM action (phase/stage/intent transition).`,
					)
				}

				return text(
					`completed (last hat)${mergeNote}${pushWarning(completeGit)}`,
				)
			}

			// ── NOT last hat: advance to next ──
			// NOTE: Quality gates run ONLY at unit completion (last hat) on
			// hookless harnesses. The intent-+-unit gate list is unscoped —
			// running them per-hat would punish early hats for outputs the
			// later hats haven't produced yet (e.g. `npm test` before any
			// code is written). CC's Stop hook fires per-subagent but each
			// subagent's Stop is the "natural endpoint" for its hat's work;
			// we don't have that signal in hookless mode, so we enforce the
			// safer "once at completion" boundary.
			//
			// Scope validation DOES run at every hat transition — it has
			// per-hat meaning (out-of-bounds writes accumulate forever until
			// surfaced) and no false-positive risk for early hats.
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
								`Allowed paths (stage output templates + FSM metadata):\n${allowedSummary}\n\n` +
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
			// Reseal: UNIT_FIELDS write before _runNext triggers verify.
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
			// Internally call runNext — returns continue_unit with next hat context for the parent
			const _runNext = getRunNextHandler()
			if (_runNext) {
				const next = _runNext(args.intent as string)
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
					`FSM Result written to: ${resultPath}\n\nYOUR FINAL MESSAGE TO THE PARENT MUST BE EXACTLY ONE LINE:\n\nFSM Result: ${resultPath}\n\nDo NOT add prose, summary, or description. The parent reads the file to drive the next FSM action.`,
				)
			}

			const hatScope = resolveStageScope(args.intent as string, advStage)
			return text(
				(hatScope
					? `advanced to ${nextHat}\n\n${hatScope}`
					: `advanced to ${nextHat}`) + pushWarning(advGit),
			)
		}
		case "haiku_unit_reject_hat": {
			// Align branch BEFORE findUnitFile — see haiku_unit_advance_hat for
			// the rationale. Without this, a unit file that lives only on the
			// stage branch spuriously returns unit_not_found when checkout is
			// on intent-main.
			const rejectPreBranchErr = enforceStageBranch(
				args.intent as string,
				resolveActiveStage(args.intent as string),
			)
			if (rejectPreBranchErr) return rejectPreBranchErr

			// Hat failed — move back one hat, increment bolt count
			const rejectInfo = findUnitFile(
				args.intent as string,
				args.unit as string,
			)
			if (!rejectInfo)
				return text(
					JSON.stringify({
						error: "unit_not_found",
						message: `Unit '${args.unit}' not found in any stage of intent '${args.intent}'.`,
					}),
				)
			const failPath = rejectInfo.path
			const rejectStage = rejectInfo.stage

			// Re-enforce for cross-stage case; idempotent when already aligned.
			const rejectBranchErr = enforceStageBranch(
				args.intent as string,
				rejectStage,
			)
			if (rejectBranchErr) return rejectBranchErr

			const { data: failData } = parseFrontmatter(
				readFileSync(failPath, "utf8"),
			)
			const currentHat = (failData.hat as string) || ""
			const currentBolt = (failData.bolt as number) || 1

			// Enforce max bolt limit FIRST — this is the absolute escape
			// hatch. Must run before the scope gate so a repeatedly-rejected
			// unit with a committed scope violation can still hit MAX_BOLTS
			// and escalate to the user instead of deadlocking.
			if (currentBolt + 1 > MAX_UNIT_BOLTS) {
				return text(
					JSON.stringify({
						error: "max_bolts_exceeded",
						bolt: currentBolt,
						max: MAX_UNIT_BOLTS,
						message: `Unit has exceeded ${MAX_UNIT_BOLTS} bolt iterations. Escalate to the user — this unit may need to be redesigned, split, or have a persistent scope violation manually reverted (\`git reset --hard $(git merge-base HEAD haiku/${args.intent as string}/${rejectStage})\` in the unit worktree).`,
					}),
				)
			}

			// Scope-validate before rollback. CRITICAL: we increment a
			// separate `scope_reject_attempts` counter on every scope-failure
			// return so that repeated failures accumulate toward MAX_BOLTS.
			// Without the counter bump the bolt field never advances (it only
			// moves on SUCCESSFUL reject), and the agent loops forever.
			{
				const intentFile = `${intentDir(args.intent as string)}/intent.md`
				const { data: iFm } = parseFrontmatter(readFileSync(intentFile, "utf8"))
				const scopeStudio = (iFm.studio as string) || ""
				const scopeResult = scopeStudio
					? validateUnitScope(
							args.intent as string,
							scopeStudio,
							rejectStage,
							args.unit as string,
						)
					: null
				if (scopeResult) {
					// Persisted counter of scope-violation returns from reject_hat.
					// Accumulates across calls so MAX_UNIT_BOLTS trips even when
					// the agent never clears the violation. Reset to 0 on any
					// successful scope-clean reject (see below).
					const { data: attemptsFm } = parseFrontmatter(
						readFileSync(failPath, "utf8"),
					)
					const prevAttempts =
						Number(attemptsFm.scope_reject_attempts as number | undefined) || 0
					const newAttempts = prevAttempts + 1
					setFrontmatterField(failPath, "scope_reject_attempts", newAttempts)
					sealIntentState(args.intent as string)

					if (newAttempts >= MAX_UNIT_BOLTS) {
						return text(
							JSON.stringify({
								error: "max_bolts_exceeded",
								reason: "persistent_scope_violation",
								attempts: newAttempts,
								max: MAX_UNIT_BOLTS,
								violations: scopeResult.violations,
								message: `Unit has hit ${newAttempts} consecutive scope-violation rejects. Escalate to the user. The worktree still contains out-of-scope commits that must be reverted manually: \`git reset --hard $(git merge-base HEAD haiku/${args.intent as string}/${rejectStage})\` in the unit worktree.`,
							}),
						)
					}

					return text(
						JSON.stringify({
							error: "unit_scope_violation_on_reject",
							bolt: currentBolt,
							scope_reject_attempts: newAttempts,
							max_attempts: MAX_UNIT_BOLTS,
							violations: scopeResult.violations,
							scope: scopeResult.scope,
							message:
								`Cannot reject hat: the unit worktree still contains ${scopeResult.violations.length} out-of-scope write(s) that must be reverted first. ` +
								`Attempt ${newAttempts}/${MAX_UNIT_BOLTS} — after ${MAX_UNIT_BOLTS} scope-violation rejects, the FSM escalates to the user.\n\n` +
								`Out-of-bounds files:\n${scopeResult.violations.map((v) => `  - ${v}`).join("\n")}\n\n` +
								`Revert the out-of-bounds commits in the unit worktree: drop all unit commits with \`git reset --hard $(git merge-base HEAD haiku/${args.intent as string}/${rejectStage})\`, or amend a single file out with \`git rm <file> && git commit --amend --no-edit\`, or \`git revert --no-edit <commit-sha>\` for a whole commit. NOTE: \`git checkout HEAD -- <file>\` is a NO-OP on committed files and will not clear the violation. After the revert, call reject_hat again.`,
						}),
					)
				}

				// Clean scope — reset the persistent counter.
				const { data: cleanFm } = parseFrontmatter(
					readFileSync(failPath, "utf8"),
				)
				if ((((cleanFm.scope_reject_attempts as number) ?? 0) as number) > 0) {
					setFrontmatterField(failPath, "scope_reject_attempts", 0)
				}
			}

			// Resolve the hat sequence — unit-aware so `feedback-assessor`
			// participates in reject-to-previous-hat transitions.
			const stageHats = resolveUnitHats(
				args.intent as string,
				rejectStage,
				args.unit as string,
			)
			const hatIdx = stageHats.indexOf(currentHat)
			// Feedback-assessor rejections always bolt to the FIRST hat
			// (designer) — the assessor is verifying the work itself, not the
			// prior reviewer's judgment, so the fix requires new artifact
			// output, not a re-review. All other hat rejections step back one.
			const prevHat =
				currentHat === FEEDBACK_ASSESSOR_HAT
					? stageHats[0]
					: hatIdx > 0
						? stageHats[hatIdx - 1]
						: stageHats[0]

			// Auto-escalate model tier on rejection (gated by features.modelSelection)
			if (features.modelSelection) {
				const currentModel = failData.model as string | undefined
				const escalated = escalate(currentModel)
				if (currentModel && escalated) {
					setFrontmatterField(failPath, "model_original", currentModel)
					setFrontmatterField(failPath, "model", escalated)
					console.error(
						`[haiku] model escalated: ${currentModel} → ${escalated} (hat rejected, bolt ${currentBolt + 1})`,
					)
				}
			}

			const rejectReason = (args.reason as string) || undefined
			completeUnitIteration(failPath, "reject", rejectReason)
			setFrontmatterField(failPath, "hat", prevHat)
			setFrontmatterField(failPath, "bolt", currentBolt + 1)
			setFrontmatterField(failPath, "hat_started_at", timestamp())
			startUnitIteration(failPath, prevHat)
			// Reseal: UNIT_FIELDS write; next haiku_run_next triggers verify.
			sealIntentState(args.intent as string)
			{
				const sf = args.state_file as string | undefined
				if (sf)
					logSessionEvent(sf, {
						event: "unit_failed",
						intent: args.intent,
						stage: rejectStage,
						unit: args.unit,
						from_hat: currentHat,
						to_hat: prevHat,
						bolt: currentBolt + 1,
					})
			}
			emitTelemetry("haiku.unit.failed", {
				intent: args.intent as string,
				stage: rejectStage,
				unit: args.unit as string,
				hat: currentHat,
				prev_hat: prevHat,
				bolt: String(currentBolt + 1),
			})
			const rejectGit = gitCommitState(
				`haiku: fail ${args.unit as string} — back to ${prevHat}, bolt ${currentBolt + 1}`,
			)
			syncSessionMetadata(
				args.intent as string,
				args.state_file as string | undefined,
			)
			{
				const resultPath = resultPathFor({
					unit: args.unit as string,
					hat: currentHat,
					bolt: currentBolt,
				})
				writeResultFile(resultPath, {
					action: "continue_unit",
					intent: args.intent,
					stage: rejectStage,
					unit: args.unit,
					hat: prevHat,
					bolt: currentBolt + 1,
					reason: rejectReason ?? null,
					_rejected_from: currentHat,
					_push_warning: pushWarning(rejectGit) || undefined,
				})
				return text(
					`FSM Result written to: ${resultPath}\n\nYOUR FINAL MESSAGE TO THE PARENT MUST BE EXACTLY ONE LINE:\n\nFSM Result: ${resultPath}\n\nDo NOT add prose or summary. Parent reads the file to drive the rebolt.`,
				)
			}
		}

		case "haiku_decision_record": {
			const intentArg = args.intent as string
			const requestedStage = args.stage as string | undefined
			const stage = requestedStage || resolveActiveStage(intentArg)
			if (!stage) {
				return text(
					JSON.stringify({
						error: "no_active_stage",
						message:
							"No stage specified and no active stage found on the intent.",
					}),
				)
			}

			const stageDir = join(intentDir(intentArg), "stages", stage)
			const stateFile = join(stageDir, "state.json")
			if (!existsSync(stateFile)) {
				return text(
					JSON.stringify({
						error: "stage_state_missing",
						message: `Stage state file not found: ${stateFile}`,
					}),
				)
			}
			const stageState = JSON.parse(readFileSync(stateFile, "utf8")) as Record<
				string,
				unknown
			>

			const noDecisions = args.no_decisions === true
			const rationale = (args.rationale as string | undefined)?.trim()

			if (noDecisions) {
				if (!rationale || rationale.length < 10) {
					return text(
						JSON.stringify({
							error: "rationale_required",
							message:
								"no_decisions=true requires a rationale of at least 10 characters explaining why no architectural decisions are in scope for this stage. State the convention or constraint that makes the work routine (e.g. 'all units follow the team's standard CRUD scaffolding; no architectural choices remain after design stage').",
						}),
					)
				}
				stageState.elaboration_no_decisions = true
				stageState.elaboration_no_decisions_rationale = rationale
				stageState.elaboration_no_decisions_at = timestamp()
				writeJson(stateFile, stageState)
				sealIntentState(intentArg)
				emitTelemetry("haiku.elaboration.no_decisions_declared", {
					intent: intentArg,
					stage,
				})
				return text(
					JSON.stringify({
						ok: true,
						intent: intentArg,
						stage,
						no_decisions: true,
						rationale,
					}),
				)
			}

			const decision = (args.decision as string | undefined)?.trim()
			const options = args.options as string[] | undefined
			const choice = (args.choice as string | undefined)?.trim()
			const source = args.source as string | undefined

			if (!decision || !options || !choice || !source) {
				return text(
					JSON.stringify({
						error: "missing_fields",
						message:
							"haiku_decision_record requires `decision`, `options`, `choice`, and `source` (or `no_decisions: true` with `rationale`).",
					}),
				)
			}

			if (!Array.isArray(options) || options.length < 2) {
				return text(
					JSON.stringify({
						error: "options_too_few",
						message:
							"`options` must be an array of at least 2 concrete alternatives. A 'decision' with only one option isn't a decision — it's just doing the work. If the work is forced, use `no_decisions: true` with a rationale instead.",
					}),
				)
			}

			if (!options.includes(choice)) {
				return text(
					JSON.stringify({
						error: "choice_not_in_options",
						message: `\`choice\` must match one of the entries in \`options\`. Got choice=${JSON.stringify(choice)}; options=${JSON.stringify(options)}. The decision-log is provenance — recording a choice that wasn't in the presented alternatives corrupts the very property the log exists to preserve.`,
					}),
				)
			}

			if (source !== "user" && source !== "autonomous-acknowledged") {
				return text(
					JSON.stringify({
						error: "invalid_source",
						message:
							'`source` must be "user" (the user picked between the options) or "autonomous-acknowledged" (you chose and surfaced the choice for the user to veto, and they did not push back).',
					}),
				)
			}

			const log = ((stageState.decision_log as unknown[]) || []) as Array<
				Record<string, unknown>
			>
			log.push({
				decision,
				options,
				choice,
				source,
				rationale: rationale || null,
				recorded_at: timestamp(),
			})
			stageState.decision_log = log
			writeJson(stateFile, stageState)
			sealIntentState(intentArg)
			emitTelemetry("haiku.decision.recorded", {
				intent: intentArg,
				stage,
				source,
			})
			return text(
				JSON.stringify({
					ok: true,
					intent: intentArg,
					stage,
					decision_count: log.length,
				}),
			)
		}

		// ── Settings ──

		// ── Dashboard ──
		case "haiku_dashboard": {
			let root: string
			try {
				root = findHaikuRoot()
			} catch {
				return text("No intents found. Use /haiku:start to create one.")
			}
			const intentsDir = join(root, "intents")
			if (!existsSync(intentsDir))
				return text("No intents found. Use /haiku:start to create one.")
			const entries = listVisibleIntents(intentsDir)
			if (entries.length === 0)
				return text("No intents found. Use /haiku:start to create one.")

			let out = "# Dashboard\n"
			for (const { slug, data } of entries) {
				out += `\n## ${slug}\n`
				out += `- Status: ${data.status || "unknown"}\n`
				out += `- Studio: ${data.studio || "none"}\n`
				out += `- Active Stage: ${data.active_stage || "none"}\n`
				out += `- Mode: ${data.mode || "interactive"}\n`

				const isDiscrete =
					(data.mode as string) === "discrete" ||
					(data.mode as string) === "hybrid"

				const stagesPath = join(intentsDir, slug, "stages")
				if (existsSync(stagesPath)) {
					const stages = readdirSync(stagesPath).filter((s) =>
						existsSync(join(stagesPath, s, "state.json")),
					)
					const stagesFromBranches: string[] = []
					if (isDiscrete && isGitRepo()) {
						try {
							const branchList = execFileSync(
								"git",
								["branch", "--list", `haiku/${slug}/*`],
								{ encoding: "utf8", stdio: "pipe" },
							).trim()
							for (const line of branchList.split("\n")) {
								const branch = line.trim().replace(/^\* /, "")
								const stageName = branch.replace(`haiku/${slug}/`, "")
								// Skip main branch and unit branches (unit-NN-*)
								if (
									stageName &&
									stageName !== "main" &&
									!/^unit-\d+/.test(stageName) &&
									!stages.includes(stageName)
								) {
									stagesFromBranches.push(stageName)
								}
							}
						} catch {
							/* non-fatal */
						}
					}

					const allStages = [...stages, ...stagesFromBranches]
					if (allStages.length > 0) {
						out += "\n| Stage | Status | Phase |\n|-------|--------|-------|\n"
						for (const s of stages) {
							const state = readJson(join(stagesPath, s, "state.json"))
							out += `| ${s} | ${state.status || "pending"} | ${state.phase || ""} |\n`
						}
						for (const s of stagesFromBranches) {
							const branch = `haiku/${slug}/${s}`
							const relPath = `.haiku/intents/${slug}/stages/${s}/state.json`
							const raw = readFileFromBranch(branch, relPath)
							if (raw) {
								try {
									const state = JSON.parse(raw)
									out += `| ${s} | ${state.status || "pending"} | ${state.phase || ""} |\n`
								} catch {
									out += `| ${s} | ? | ? |\n`
								}
							} else {
								out += `| ${s} | (on branch) | |\n`
							}
						}
						// List units with model assignments for active stages
						for (const s of stages) {
							const unitsDir = join(stagesPath, s, "units")
							if (!existsSync(unitsDir)) continue
							const unitFiles = readdirSync(unitsDir).filter((f) =>
								f.endsWith(".md"),
							)
							const unitsWithModel = unitFiles
								.map((f) => {
									const { data } = parseFrontmatter(
										readFileSync(join(unitsDir, f), "utf8"),
									)
									return {
										name: f.replace(".md", ""),
										model: data.model as string | undefined,
									}
								})
								.filter((u) => u.model)
							if (unitsWithModel.length > 0) {
								out += `\n**${s} unit models:**\n`
								for (const u of unitsWithModel) {
									out += `- ${u.name}: ${u.model}\n`
								}
							}
						}
					}
				}
			}
			return text(out)
		}

		// ── Capacity ──
		case "haiku_capacity": {
			const filterStudio = (args.studio as string) || ""
			let root: string
			try {
				root = findHaikuRoot()
			} catch {
				return text("No .haiku directory found.")
			}
			const intentsDir = join(root, "intents")
			if (!existsSync(intentsDir)) return text("No intents found.")
			const entries = listVisibleIntents(intentsDir)

			const median = (arr: number[]): number => {
				if (arr.length === 0) return 0
				const sorted = [...arr].sort((a, b) => a - b)
				const mid = Math.floor(sorted.length / 2)
				return sorted.length % 2 !== 0
					? sorted[mid]
					: (sorted[mid - 1] + sorted[mid]) / 2
			}

			// Group intents by studio
			const byStudio = new Map<
				string,
				Array<{ slug: string; status: string; data: Record<string, unknown> }>
			>()
			for (const { slug, data } of entries) {
				const studio = (data.studio as string) || "unassigned"
				if (filterStudio && studio !== filterStudio) continue
				if (!byStudio.has(studio)) byStudio.set(studio, [])
				byStudio
					.get(studio)
					?.push({ slug, status: (data.status as string) || "unknown", data })
			}

			if (byStudio.size === 0)
				return text(
					filterStudio
						? `No intents found for studio '${filterStudio}'.`
						: "No intents found.",
				)

			let out = "# Capacity Report\n"
			for (const [studio, intents] of byStudio) {
				const completed = intents.filter((i) => i.status === "completed").length
				const active = intents.filter((i) => i.status === "active").length
				out += `\n## Studio: ${studio}\n`
				out += `- Total intents: ${intents.length}\n`
				out += `- Completed: ${completed}\n`
				out += `- Active: ${active}\n`

				// Collect bolt counts per stage across all intents in this studio
				const stageBolts = new Map<string, number[]>()
				for (const intent of intents) {
					const stagesPath = join(intentsDir, intent.slug, "stages")
					if (!existsSync(stagesPath)) continue
					for (const stage of readdirSync(stagesPath)) {
						const unitsDir = join(stagesPath, stage, "units")
						if (!existsSync(unitsDir)) continue
						if (!stageBolts.has(stage)) stageBolts.set(stage, [])
						for (const f of readdirSync(unitsDir).filter((f) =>
							f.endsWith(".md"),
						)) {
							const { data: ud } = parseFrontmatter(
								readFileSync(join(unitsDir, f), "utf8"),
							)
							if (typeof ud.bolt === "number")
								stageBolts.get(stage)?.push(ud.bolt)
						}
					}
				}

				if (stageBolts.size > 0) {
					out +=
						"\n| Stage | Units | Median Bolts |\n|-------|-------|--------------|\n"
					for (const [stage, bolts] of stageBolts) {
						out += `| ${stage} | ${bolts.length} | ${median(bolts)} |\n`
					}
				}
			}
			return text(out)
		}

		// ── Reflect ──
		case "haiku_reflect": {
			const intentSlug = args.intent as string
			let root: string
			try {
				root = findHaikuRoot()
			} catch {
				return text("No .haiku directory found.")
			}
			const intentFile = join(root, "intents", intentSlug, "intent.md")
			if (!existsSync(intentFile))
				return text(`Intent '${intentSlug}' not found.`)

			const { data: intentData } = parseFrontmatter(
				readFileSync(intentFile, "utf8"),
			)
			let out = "## Intent Metadata\n"
			out += `- Slug: ${intentSlug}\n`
			out += `- Studio: ${intentData.studio || "none"}\n`
			out += `- Mode: ${intentData.mode || "interactive"}\n`
			out += `- Status: ${intentData.status || "unknown"}\n`
			out += `- Created: ${intentData.created_at || "unknown"}\n`
			out += `- Completed: ${intentData.completed_at || "in progress"}\n`

			const stagesPath = join(root, "intents", intentSlug, "stages")
			if (existsSync(stagesPath)) {
				out += "\n## Per-Stage Summary\n"
				for (const stage of readdirSync(stagesPath)) {
					const state = readJson(join(stagesPath, stage, "state.json"))
					out += `\n### ${stage}\n`
					out += `- Status: ${state.status || "pending"}\n`
					out += `- Phase: ${state.phase || ""}\n`
					out += `- Started: ${state.started_at || "not started"}\n`
					out += `- Completed: ${state.completed_at || "in progress"}\n`

					const unitsDir = join(stagesPath, stage, "units")
					if (existsSync(unitsDir)) {
						const unitFiles = readdirSync(unitsDir).filter((f) =>
							f.endsWith(".md"),
						)
						let completedUnits = 0
						let totalBolts = 0
						const unitDetails: string[] = []
						for (const f of unitFiles) {
							const { data: ud } = parseFrontmatter(
								readFileSync(join(unitsDir, f), "utf8"),
							)
							const uName = f.replace(".md", "")
							const uBolt = (ud.bolt as number) || 0
							totalBolts += uBolt
							if (ud.status === "completed") completedUnits++
							unitDetails.push(
								`  - ${uName}: status=${ud.status || "pending"}, bolts=${uBolt}, hat=${ud.hat || "none"}`,
							)
						}
						out += `- Units: ${completedUnits}/${unitFiles.length} completed, Total bolts: ${totalBolts}\n`
						if (unitDetails.length > 0) out += `${unitDetails.join("\n")}\n`
					}
				}
			}

			const studio = (intentData.studio as string) || ""
			if (studio) {
				const dims = readReflectionDefs(studio)
				if (Object.keys(dims).length > 0) {
					out += "\n## Reflection Dimensions\n\n"
					out += "Analyze this intent along each dimension below:\n\n"
					for (const [name, content] of Object.entries(dims)) {
						out += `### ${name}\n\n${content}\n\n`
					}
				} else {
					out += "\n## Analysis Instructions\n"
					out +=
						"1. Execution patterns — which units went smoothly, which required retries\n"
					out += "2. Criteria satisfaction\n"
					out += "3. Process observations\n"
					out += "4. Blocker analysis\n"
				}
			} else {
				out += "\n## Analysis Instructions\n"
				out +=
					"1. Execution patterns — which units went smoothly, which required retries\n"
				out += "2. Criteria satisfaction\n"
				out += "3. Process observations\n"
				out += "4. Blocker analysis\n"
			}
			// Studio operations — surface available post-intent operations
			if (studio) {
				const ops = readOperationDefs(studio)
				if (Object.keys(ops).length > 0) {
					out += "\n## Available Operations\n\n"
					out +=
						"The following post-delivery operations are defined for this studio:\n\n"
					for (const [name, content] of Object.entries(ops)) {
						out += `### ${name}\n\n${content}\n\n`
					}
				}
			}

			out += "\n## Output\n"
			out +=
				"Write reflection.md and settings-recommendations.md to the intent directory.\n"
			return text(out)
		}

		// ── Review ──
		case "haiku_review": {
			// Determine diff base — prefer the tracked upstream, fall back to the
			// detected mainline (origin/HEAD-aware), then to a last-resort "main".
			let base = getMainlineBranch()
			try {
				const upstream = spawnSync(
					"git",
					["rev-parse", "--abbrev-ref", "@{upstream}"],
					{ encoding: "utf8", stdio: "pipe" },
				)
				if (upstream.status === 0 && upstream.stdout.trim()) {
					base = upstream.stdout.trim()
				}
			} catch {
				/* fallback to detected mainline */
			}

			// Get diff, stat, and changed files
			let diff = ""
			let stat = ""
			let changedFiles = ""
			try {
				const diffResult = spawnSync("git", ["diff", `${base}...HEAD`], {
					encoding: "utf8",
					stdio: "pipe",
					maxBuffer: 10 * 1024 * 1024,
				})
				diff = diffResult.stdout || ""
				const statResult = spawnSync(
					"git",
					["diff", "--stat", `${base}...HEAD`],
					{ encoding: "utf8", stdio: "pipe" },
				)
				stat = statResult.stdout || ""
				const namesResult = spawnSync(
					"git",
					["diff", "--name-only", `${base}...HEAD`],
					{ encoding: "utf8", stdio: "pipe" },
				)
				changedFiles = namesResult.stdout || ""
			} catch {
				/* git not available */
			}

			// Truncate diff at 100k chars
			const MAX_DIFF = 100_000
			if (diff.length > MAX_DIFF) {
				diff = `${diff.slice(0, MAX_DIFF)}\n\n... [TRUNCATED at 100k chars] ...`
			}

			// Read REVIEW.md and CLAUDE.md if they exist
			let reviewGuidelines = ""
			const cwd = process.cwd()
			for (const name of ["REVIEW.md", "CLAUDE.md"]) {
				const p = join(cwd, name)
				if (existsSync(p)) {
					reviewGuidelines += `\n### ${name}\n${readFileSync(p, "utf8").slice(0, 5000)}\n`
				}
			}

			// Read review_agents from settings
			let reviewAgents = ""
			try {
				const settingsPath = join(findHaikuRoot(), "settings.yml")
				if (existsSync(settingsPath)) {
					const settings = parseYaml(readFileSync(settingsPath, "utf8"))
					const agents = getNestedField(settings, "review_agents")
					if (agents)
						reviewAgents = `\n### Review Agents Config\n\`\`\`json\n${JSON.stringify(agents, null, 2)}\n\`\`\`\n`
				}
			} catch {
				/* no settings */
			}

			let out = "## Pre-Delivery Code Review\n"
			out += `Diff base: ${base}\n\n`
			out += `Changed files:\n\`\`\`\n${changedFiles || "none"}\`\`\`\n\n`
			out += `Diff stats:\n\`\`\`\n${stat || "none"}\`\`\`\n`
			if (reviewGuidelines)
				out += `\n### Review Guidelines\n${reviewGuidelines}\n`
			if (reviewAgents) out += reviewAgents
			out += `\n### Full Diff\n\`\`\`diff\n${diff || "No changes detected."}\n\`\`\`\n`
			out += "\n### Instructions\n"
			out +=
				"1. Spawn review agents in parallel (one per configured agent or area)\n"
			out += "2. Collect findings, deduplicate across agents\n"
			out += "3. Fix all HIGH severity findings before delivery\n"
			out += "4. Report findings summary to the user\n"
			return text(out)
		}

		// ── Backlog ──
		case "haiku_backlog": {
			const action = (args.action as string) || "list"
			let root: string
			try {
				root = findHaikuRoot()
			} catch {
				return text("No .haiku directory found.")
			}
			const backlogDir = join(root, "backlog")

			switch (action) {
				case "list": {
					if (!existsSync(backlogDir)) return text("No backlog items found.")
					const files = readdirSync(backlogDir).filter((f) => f.endsWith(".md"))
					if (files.length === 0) return text("No backlog items found.")

					let out =
						"# Backlog\n\n| # | Item | Priority | Created |\n|---|------|----------|---------|\n"
					for (let i = 0; i < files.length; i++) {
						const { data } = parseFrontmatter(
							readFileSync(join(backlogDir, files[i]), "utf8"),
						)
						out += `| ${i + 1} | ${files[i].replace(".md", "")} | ${data.priority || "unset"} | ${data.created_at || "unknown"} |\n`
					}
					return text(out)
				}
				case "add": {
					const desc = (args.description as string) || ""
					let out = "## Add Backlog Item\n\n"
					out +=
						"Create a new file in `.haiku/backlog/` with this template:\n\n"
					out += `\`\`\`markdown\n---\npriority: medium\ncreated_at: ${timestamp()}\n---\n\n`
					out += `${desc || "Description of the backlog item"}\n\`\`\`\n`
					out +=
						"\nFilename should be a slug of the item description (e.g. `improve-error-handling.md`).\n"
					return text(out)
				}
				case "review": {
					if (!existsSync(backlogDir))
						return text("No backlog items to review.")
					const files = readdirSync(backlogDir).filter((f) => f.endsWith(".md"))
					if (files.length === 0) return text("No backlog items to review.")

					let out =
						"## Backlog Review\n\nPresent each item to the user and ask: **Keep / Reprioritize / Drop / Promote / Skip**\n\n"
					for (let i = 0; i < files.length; i++) {
						const raw = readFileSync(join(backlogDir, files[i]), "utf8")
						const { data, body } = parseFrontmatter(raw)
						out += `### ${i + 1}. ${files[i].replace(".md", "")}\n`
						out += `- Priority: ${data.priority || "unset"}\n`
						out += `- Created: ${data.created_at || "unknown"}\n`
						out += `${body.slice(0, 300)}\n\n`
					}
					out += "---\nFor each item, ask the user and apply their choice.\n"
					return text(out)
				}
				case "promote": {
					let out = "## Promote Backlog Item\n\n"
					out += "To promote a backlog item to an intent:\n"
					out += "1. Read the backlog item file\n"
					out +=
						"2. Use /haiku:start to create an intent from its description\n"
					out += "3. Delete the backlog file after the intent is created\n"
					return text(out)
				}
				default:
					return text(
						`Unknown backlog action: '${action}'. Valid actions: list, add, review, promote.`,
					)
			}
		}

		// ── Seed ──
		case "haiku_seed": {
			const action = (args.action as string) || "list"
			let root: string
			try {
				root = findHaikuRoot()
			} catch {
				return text("No .haiku directory found.")
			}
			const seedsDir = join(root, "seeds")

			switch (action) {
				case "list": {
					if (!existsSync(seedsDir)) return text("No seeds found.")
					const files = readdirSync(seedsDir).filter((f) => f.endsWith(".md"))
					if (files.length === 0) return text("No seeds found.")

					// Group by status
					const groups = new Map<
						string,
						Array<{ name: string; data: Record<string, unknown> }>
					>()
					for (const f of files) {
						const { data } = parseFrontmatter(
							readFileSync(join(seedsDir, f), "utf8"),
						)
						const status = (data.status as string) || "planted"
						if (!groups.has(status)) groups.set(status, [])
						groups.get(status)?.push({ name: f.replace(".md", ""), data })
					}

					let out = "# Seeds\n"
					for (const [status, seeds] of groups) {
						out += `\n## ${status.charAt(0).toUpperCase() + status.slice(1)} (${seeds.length})\n\n`
						out +=
							"| Seed | Trigger | Planted |\n|------|---------|----------|\n"
						for (const s of seeds) {
							out += `| ${s.name} | ${s.data.trigger || "none"} | ${s.data.created_at || "unknown"} |\n`
						}
					}
					return text(out)
				}
				case "plant": {
					let out = "## Plant a Seed\n\n"
					out += "Create a new file in `.haiku/seeds/` with this template:\n\n"
					out += `\`\`\`markdown\n---\nstatus: planted\ntrigger: "<condition that should cause this to surface>"\ncreated_at: ${timestamp()}\n---\n\n`
					out += "Description of the idea or future work.\n```\n"
					out +=
						"\nFilename should be a slug of the seed idea (e.g. `add-caching-layer.md`).\n"
					return text(out)
				}
				case "check": {
					if (!existsSync(seedsDir)) return text("No seeds to check.")
					const files = readdirSync(seedsDir).filter((f) => f.endsWith(".md"))
					const planted = files.filter((f) => {
						const { data } = parseFrontmatter(
							readFileSync(join(seedsDir, f), "utf8"),
						)
						return (data.status as string) === "planted"
					})
					if (planted.length === 0) return text("No planted seeds to check.")

					let out =
						"## Seed Check\n\nEvaluate each planted seed's trigger condition against the current project state:\n\n"
					for (const f of planted) {
						const { data, body } = parseFrontmatter(
							readFileSync(join(seedsDir, f), "utf8"),
						)
						out += `### ${f.replace(".md", "")}\n`
						out += `- Trigger: ${data.trigger || "none defined"}\n`
						out += `- Description: ${body.slice(0, 300)}\n\n`
					}
					out +=
						"---\nFor each seed: if the trigger condition is met, update its status to 'surfaced'. If not, leave as 'planted'.\n"
					return text(out)
				}
				default:
					return text(
						`Unknown seed action: '${action}'. Valid actions: list, plant, check.`,
					)
			}
		}

		// ── Release Notes ──

		case "haiku_repair": {
			// ── Repair: scan intents for metadata issues ──
			//
			// Default behavior in a git repo: scan ALL intent branches sequentially
			// via temporary worktrees, auto-apply safe fixes, push to each branch,
			// and open a PR/MR if the branch was already merged into mainline.
			//
			// Args:
			//   intent        — single intent slug to repair (cwd only, skips multi-branch)
			//   apply         — auto-apply safe fixes (default: true)
			//   skip_branches — force cwd-only mode even in a git repo
			//
			// The MCP applies what it can mechanically; the agent handles judgment calls.
			const repairIntentArg = args.intent as string | undefined
			const repairAutoApply = args.apply !== false // default true
			const repairSkipBranches = args.skip_branches === true

			// Multi-branch path: in a git repo, no single-intent restriction, branches not skipped.
			// Runs whether or not active haiku/<slug>/main branches exist — the archived pass
			// handles the case where all intents have already been merged and their branches deleted.
			if (isGitRepo() && !repairIntentArg && !repairSkipBranches) {
				try {
					const { summaries, mainline, archivedSummary } =
						repairAllBranches(repairAutoApply)
					if (summaries.length > 0 || archivedSummary) {
						return text(
							buildMultiBranchReport(summaries, mainline, archivedSummary),
						)
					}
					// No active branches AND no archived intents — fall through to cwd repair
				} catch (err) {
					return text(
						`Multi-branch repair failed: ${err instanceof Error ? err.message : String(err)}`,
					)
				}
			}

			// Single-cwd path
			try {
				findHaikuRoot()
			} catch {
				return text("No .haiku/ directory found.")
			}

			let cwdResult: RepairCwdResult
			try {
				cwdResult = repairCwd(undefined, repairIntentArg, repairAutoApply)
			} catch (err) {
				return text(
					`Repair failed: ${err instanceof Error ? err.message : String(err)}`,
				)
			}

			if (repairIntentArg && cwdResult.scanned === 0) {
				return text(`Intent '${repairIntentArg}' not found.`)
			}
			if (cwdResult.scanned === 0) return text("No intents found.")

			return text(buildRepairReport(cwdResult))
		}

		// ── Feedback ──
		case "haiku_feedback": {
			const intent = args.intent as string
			// `stage` is now optional — omit to log an intent-scope finding
			// (used by the studio-level pre-intent-completion review layer).
			const stage = (args.stage as string) || ""
			const title = args.title as string
			const body = args.body as string
			const origin = (args.origin as string) || undefined
			const sourceRef = (args.source_ref as string) || undefined
			const author = (args.author as string) || undefined
			const upstreamStage = (args.upstream_stage as string) || undefined

			// Validation
			if (!intent)
				return {
					content: [{ type: "text", text: "Error: intent is required" }],
					isError: true,
				}
			if (!title)
				return {
					content: [{ type: "text", text: "Error: title is required" }],
					isError: true,
				}
			if (!body)
				return {
					content: [{ type: "text", text: "Error: body is required" }],
					isError: true,
				}
			if (title.length > 120)
				return {
					content: [
						{
							type: "text",
							text: "Error: title must be 120 characters or fewer",
						},
					],
					isError: true,
				}

			// Validate intent exists
			const intentFile = join(intentDir(intent), "intent.md")
			if (!existsSync(intentFile))
				return {
					content: [
						{ type: "text", text: `Error: intent '${intent}' not found` },
					],
					isError: true,
				}

			// Validate origin enum
			if (origin && !(FEEDBACK_ORIGINS as readonly string[]).includes(origin)) {
				return {
					content: [
						{
							type: "text",
							text: `Error: origin must be one of: ${FEEDBACK_ORIGINS.join(", ")}`,
						},
					],
					isError: true,
				}
			}

			// Branch enforcement — stage feedback lands on the stage branch;
			// intent-scope feedback (stage omitted) lands on intent-main.
			// `ensureOnStageBranch(slug, "")` already falls back to intent
			// main when the stage arg is falsy, so the same helper covers
			// both cases.
			const feedbackBranchErr = enforceStageBranch(intent, stage || undefined)
			if (feedbackBranchErr) return feedbackBranchErr

			if (stage) {
				const stgDir = stageDir(intent, stage)
				if (!existsSync(stgDir)) {
					const { data: intentData } = parseFrontmatter(
						readFileSync(intentFile, "utf8"),
					)
					const stages = (intentData.stages as string[]) || []
					if (!stages.includes(stage)) {
						return {
							content: [
								{
									type: "text",
									text: `Error: stage '${stage}' not found under intent '${intent}'`,
								},
							],
							isError: true,
						}
					}
					mkdirSync(stgDir, { recursive: true })
				}
			}

			// If upstream_stage is provided, validate it names a real stage
			// under this intent — otherwise a typo silently routes findings
			// into a ghost stage the FSM never visits. Also reject self-
			// reference — pointing upstream at the current stage is
			// meaningless and would leave the FSM classifying the finding
			// inconsistently between the stage gate (treats self-ref as
			// in-scope) and the intent-completion layer (treats it as
			// cross-stage).
			if (upstreamStage) {
				const { data: intentData } = parseFrontmatter(
					readFileSync(intentFile, "utf8"),
				)
				const stages = (intentData.stages as string[]) || []
				if (!stages.includes(upstreamStage)) {
					return {
						content: [
							{
								type: "text",
								text: `Error: upstream_stage '${upstreamStage}' is not a stage of intent '${intent}'. Valid stages: ${stages.join(", ")}`,
							},
						],
						isError: true,
					}
				}
				if (stage && upstreamStage === stage) {
					return {
						content: [
							{
								type: "text",
								text: `Error: upstream_stage '${upstreamStage}' equals the current stage. Omit upstream_stage for in-scope findings; set it only when the root cause lives in a DIFFERENT stage.`,
							},
						],
						isError: true,
					}
				}
			}

			const result = writeFeedbackFile(intent, stage, {
				title,
				body,
				origin,
				author,
				source_ref: sourceRef ?? null,
				// Coalesce empty string to null — "" is not nullish, so `?? null`
				// would persist the empty string on disk and leak a "present
				// but empty" upstream_stage that readFeedbackFiles only
				// normalizes on read. Using `||` avoids the data-hygiene drift.
				upstream_stage: upstreamStage || null,
			})

			const gitResult = gitCommitState(
				stage
					? `feedback: create ${result.feedback_id} in ${stage}`
					: `feedback: create ${result.feedback_id} (intent-scope)`,
			)
			const response: Record<string, unknown> = {
				feedback_id: result.feedback_id,
				file: result.file,
				status: "pending",
				message: `Feedback ${result.feedback_id} created.`,
			}
			return text(
				JSON.stringify(injectPushWarning(response, gitResult), null, 2),
			)
		}

		case "haiku_feedback_update": {
			const intent = args.intent as string
			// `stage` is optional for intent-scope feedback (stage omitted on
			// create → stage omitted on update/delete/reject).
			const stage = (args.stage as string) || ""
			const feedbackId = args.feedback_id as string

			if (!intent)
				return {
					content: [{ type: "text", text: "Error: intent is required" }],
					isError: true,
				}
			if (!feedbackId)
				return {
					content: [{ type: "text", text: "Error: feedback_id is required" }],
					isError: true,
				}

			const updateFields: {
				status?: string
				closed_by?: string
				resolution?: string | null
			} = {}
			if (args.status !== undefined) updateFields.status = args.status as string
			if (args.closed_by !== undefined)
				updateFields.closed_by = args.closed_by as string
			if (args.resolution !== undefined) {
				const raw = args.resolution
				updateFields.resolution =
					typeof raw === "string" && raw.length > 0 ? (raw as string) : null
			}

			// Intent-scope ("") enforces intent-main; stage-scoped enforces the stage branch.
			const feedbackUpdateBranchErr = enforceStageBranch(
				intent,
				stage || undefined,
			)
			if (feedbackUpdateBranchErr) return feedbackUpdateBranchErr

			const updateResult = updateFeedbackFile(
				intent,
				stage,
				feedbackId,
				updateFields,
				"agent",
			)

			if (!updateResult.ok) {
				return {
					content: [{ type: "text", text: updateResult.error }],
					isError: true,
				}
			}

			const updateGitResult = gitCommitState(
				stage
					? `feedback: update ${feedbackId} in ${stage}`
					: `feedback: update ${feedbackId} (intent-scope)`,
			)

			const found = findFeedbackFile(intent, stage, feedbackId)
			const updateResponse: Record<string, unknown> = {
				feedback_id: feedbackId,
				file: found
					? stage
						? `.haiku/intents/${intent}/stages/${stage}/feedback/${found.filename}`
						: `.haiku/intents/${intent}/feedback/${found.filename}`
					: undefined,
				updated_fields: updateResult.updated_fields,
				message: `Feedback ${feedbackId} updated.`,
			}
			return text(
				JSON.stringify(
					injectPushWarning(updateResponse, updateGitResult),
					null,
					2,
				),
			)
		}





		default:
			return text(`Unknown tool: ${name}`)
	}
}
