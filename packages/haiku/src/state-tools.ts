// state-tools.ts — H·AI·K·U resource MCP tools
//
// One tool per resource per operation. Under the hood: frontmatter + JSON files.
// The caller doesn't need to know file paths — just resource identifiers.

import {
	enforceStageBranch,
	FEEDBACK_ASSESSOR_HAT,
	findUnitFile,
	resolveActiveStage,
	resolveStageHats,
	resolveStageScope,
	resolveUnitHats,
	syncSessionMetadata,
} from "./state/active-stage.js"
import {
	appendFeedbackIteration,
	appendFeedbackReply,
	countPendingFeedback,
	deleteFeedbackFile,
	deriveAuthorType,
	FEEDBACK_ORIGINS,
	FEEDBACK_STATUSES,
	type FeedbackItem,
	type FeedbackIteration,
	type FeedbackOrigin,
	type FeedbackReply,
	type FeedbackStatus,
	feedbackDir,
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
	getNestedField,
	intentFromCurrentBranch,
	listVisibleIntentSlugs,
	listVisibleIntents,
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
} from "./state/iterations.js"
import {
	type AppliedFix,
	applyAutoFixes,
	INTENT_TITLE_MAX_LENGTH,
	intentTitleNeedsRepair,
	type RepairCwdResult,
	type RepairIssue,
} from "./state/repair.js"
import {
	unitIntentDir,
	unitOutputExists,
	validateUnitScope,
} from "./state/scope.js"
import { stateToolDefs } from "./state/tool-defs.js"
import { setSessionId } from "./subagent-prompt-file.js"
import { stateToolHandlers } from "./tools/state/index.js"

export { stateToolDefs }

import {
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
} from "./state/shared.js"

// Re-export shared helpers + repair surface so existing consumers (orchestrator,
// tests, prompts) that imported from "./state-tools" continue to resolve. The
// move to ./state/{shared,repair} reduces this file by ~1650 lines without
// breaking anyone's imports.
export {
	_resetIsGitRepoForTests,
	type AppendIterationResult,
	type AppliedFix,
	appendFeedbackIteration,
	appendFeedbackReply,
	appendStageIteration,
	applyAutoFixes,
	closeCurrentStageIteration,
	completeUnitIteration,
	computeFeedbackSignature,
	countPendingFeedback,
	deleteFeedbackFile,
	deriveAuthorType,
	enforceStageBranch,
	FEEDBACK_ASSESSOR_HAT,
	FEEDBACK_ORIGINS,
	FEEDBACK_STATUSES,
	type FeedbackItem,
	type FeedbackIteration,
	type FeedbackOrigin,
	type FeedbackReply,
	type FeedbackStatus,
	feedbackDir,
	findFeedbackFile,
	findHaikuRoot,
	findUnitFile,
	type GitCommitResult,
	getNestedField,
	getStageIterationCount,
	gitCommitState,
	gitCommitStateBackgroundPush,
	INTENT_TITLE_MAX_LENGTH,
	incrementFeedbackBolt,
	injectPushWarning,
	intentDir,
	intentFromCurrentBranch,
	intentTitleNeedsRepair,
	isGitRepo,
	listVisibleIntentSlugs,
	listVisibleIntents,
	MAX_CONCURRENT_SUBAGENTS,
	MAX_FIX_LOOP_BOLTS,
	MAX_INTEGRATOR_ATTEMPTS,
	MAX_STAGE_ITERATIONS,
	MAX_UNIT_BOLTS,
	matchesGlob,
	parseFrontmatter,
	parseYaml,
	pushWarning,
	type RepairCwdResult,
	type RepairIssue,
	readFeedbackFiles,
	readJson,
	resolveActiveStage,
	resolveStageHats,
	resolveStageScope,
	resolveUnitHats,
	type StageIteration,
	type StageIterationResult,
	type StageIterationTrigger,
	setFrontmatterField,
	setUnitFrontmatterField,
	slugifyTitle,
	stageDir,
	stageStatePath,
	startUnitIteration,
	syncSessionMetadata,
	timestamp,
	type UnitHatResult,
	type UnitIteration,
	unitIntentDir,
	unitOutputExists,
	unitPath,
	updateFeedbackFile,
	validateBranch,
	validateUnitScope,
	writeFeedbackFile,
	writeJson,
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

	// All state tools live in tools/state/* per-file modules registered
	// in stateToolHandlers. The legacy switch is gone — unknown names
	// fall through to the default response.
	const perToolHandler = stateToolHandlers.get(name)
	if (perToolHandler) {
		const result = perToolHandler.handle(args)
		if (result instanceof Promise) {
			throw new Error(
				`Tool '${name}' returned a Promise but handleStateTool is synchronous`,
			)
		}
		return result
	}

	return text(`Unknown tool: ${name}`)
}
