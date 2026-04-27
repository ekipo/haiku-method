// tools/state/haiku_unit_reject_hat.ts — Hat rejected; step back one
// hat, increment bolt, check scope + max-bolt limits.
//
// Two distinct max-bolt paths:
//   1. Honest bolt cap (currentBolt + 1 > MAX_UNIT_BOLTS) — checked
//      FIRST so a repeatedly-rejected unit with a committed scope
//      violation can still escalate instead of deadlocking.
//   2. Persistent scope-violation cap — `scope_reject_attempts` is a
//      separate counter on the unit frontmatter that bumps on every
//      scope-failure return. Without this, the bolt field would never
//      advance (it only moves on SUCCESSFUL reject) and the agent
//      would loop forever. Reset to 0 on any scope-clean reject.

import { readFileSync } from "node:fs"
import { features } from "../../config.js"
import { escalate } from "../../model-selection.js"
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
import { setFrontmatterField } from "../../state/frontmatter.js"
import { gitCommitState, pushWarning } from "../../state/git-commit.js"
import {
	completeUnitIteration,
	MAX_UNIT_BOLTS,
	startUnitIteration,
} from "../../state/iterations.js"
import { validateUnitScope } from "../../state/scope.js"
import {
	intentDir,
	parseFrontmatter,
	timestamp,
} from "../../state/shared.js"
import { resultPathFor, writeResultFile } from "../../subagent-prompt-file.js"
import { emitTelemetry } from "../../telemetry.js"
import { defineTool } from "../define.js"
import { text } from "./_text.js"

export default defineTool({
	name: "haiku_unit_reject_hat",
	description:
		"Hat failed — step back one hat, increment bolt, check scope. Auto-escalates model on rejection. Hits MAX_UNIT_BOLTS for either honest bolts or persistent scope violations.",
	inputSchema: {
		type: "object" as const,
		properties: {
			intent: { type: "string" },
			unit: { type: "string" },
			reason: { type: "string" },
			state_file: { type: "string" },
		},
		required: ["intent", "unit"],
	},
	handle(args) {
		// Align branch BEFORE findUnitFile — without this, a unit file
		// that lives only on the stage branch returns unit_not_found
		// when checkout is on intent-main.
		const preBranchErr = enforceStageBranch(
			args.intent as string,
			resolveActiveStage(args.intent as string),
		)
		if (preBranchErr) return preBranchErr

		const rejectInfo = findUnitFile(args.intent as string, args.unit as string)
		if (!rejectInfo)
			return text(
				JSON.stringify({
					error: "unit_not_found",
					message: `Unit '${args.unit}' not found in any stage of intent '${args.intent}'.`,
				}),
			)
		const failPath = rejectInfo.path
		const rejectStage = rejectInfo.stage

		const branchErr = enforceStageBranch(args.intent as string, rejectStage)
		if (branchErr) return branchErr

		const { data: failData } = parseFrontmatter(readFileSync(failPath, "utf8"))
		const currentHat = (failData.hat as string) || ""
		const currentBolt = (failData.bolt as number) || 1

		// Honest bolt cap FIRST so deadlocked units can escalate.
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

		// Scope-validate BEFORE rollback. Bumps a separate
		// `scope_reject_attempts` counter so persistent violations still
		// trip MAX_UNIT_BOLTS (the bolt field only advances on SUCCESSFUL
		// reject). Reset to 0 on any scope-clean reject.
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
							`Attempt ${newAttempts}/${MAX_UNIT_BOLTS} — after ${MAX_UNIT_BOLTS} scope-violation rejects, the workflow engine escalates to the user.\n\n` +
							`Out-of-bounds files:\n${scopeResult.violations.map((v) => `  - ${v}`).join("\n")}\n\n` +
							`Revert the out-of-bounds commits in the unit worktree: drop all unit commits with \`git reset --hard $(git merge-base HEAD haiku/${args.intent as string}/${rejectStage})\`, or amend a single file out with \`git rm <file> && git commit --amend --no-edit\`, or \`git revert --no-edit <commit-sha>\` for a whole commit. NOTE: \`git checkout HEAD -- <file>\` is a NO-OP on committed files and will not clear the violation. After the revert, call reject_hat again.`,
					}),
				)
			}

			// Clean scope — reset the persistent counter.
			const { data: cleanFm } = parseFrontmatter(readFileSync(failPath, "utf8"))
			if ((((cleanFm.scope_reject_attempts as number) ?? 0) as number) > 0) {
				setFrontmatterField(failPath, "scope_reject_attempts", 0)
			}
		}

		// Resolve hat sequence — unit-aware so feedback-assessor
		// participates in reject-to-previous-hat transitions.
		const stageHats = resolveUnitHats(
			args.intent as string,
			rejectStage,
			args.unit as string,
		)
		const hatIdx = stageHats.indexOf(currentHat)
		// Feedback-assessor rejections always bolt to the FIRST hat
		// (designer) — the assessor verifies the work itself, not the
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
			`Workflow Result written to: ${resultPath}\n\nYOUR FINAL MESSAGE TO THE PARENT MUST BE EXACTLY ONE LINE:\n\nWorkflow Result: ${resultPath}\n\nDo NOT add prose or summary. Parent reads the file to drive the rebolt.`,
		)
	},
})
