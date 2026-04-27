// orchestrator.ts — H·AI·K·U stage loop orchestration
//
// Deterministic workflow driver. `runNext()` reads state, determines the next
// action, performs the state mutation as a side effect, and returns the action
// to the agent. The agent only calls `haiku_run_next` to advance — it never
// mutates stage/intent state directly.
//
// Primary tool: haiku_run_next { intent }
// Returns an action object the agent follows.

import { execFileSync, execSync } from "node:child_process"
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { join, resolve } from "node:path"
import matter from "gray-matter"
import { resolvePluginRoot } from "./config.js"
import { computeWaves, topologicalSort } from "./dag.js"
import {
	branchExists,
	cleanupFixChainWorktree,
	cleanupIntentWorktrees,
	cleanupOrphanedStageBranches,
	createFixChainWorktree,
	createIntentBranch,
	createStageBranch,
	createUnitWorktree,
	deleteStageBranch,
	discoveryBranchName,
	discoveryWorktreePath,
	ensureOnStageBranch,
	finalizeIntentBranches,
	fixChainBranchName,
	fixChainWorktreePath,
	isBranchMerged,
	isOnStageBranch,
	mergeDiscoveryWorktree,
	mergeFixChainWorktree,
	mergeStageBranchForward,
	mergeStageBranchIntoMain,
	prepareRevisitBranch,
	writeOnIntentMain,
} from "./git-worktree.js"
import { dispatchOrchestratorAction } from "./orchestrator/workflow/run-tick.js"
import { actionPromptBuilders } from "./orchestrator/prompts/index.js"
import { orchestratorToolDefs } from "./orchestrator/tool-defs.js"
import { sealIntentState, verifyIntentState } from "./state-integrity.js"
import {
	appendStageIteration,
	closeCurrentStageIteration,
	countPendingFeedback,
	type FeedbackItem,
	findFeedbackFile,
	findHaikuRoot,
	getStageIterationCount,
	gitCommitState,
	incrementFeedbackBolt,
	intentDir,
	isGitRepo,
	MAX_FIX_LOOP_BOLTS,
	MAX_INTEGRATOR_ATTEMPTS,
	MAX_STAGE_ITERATIONS,
	parseFrontmatter,
	readFeedbackFiles,
	readJson,
	setFrontmatterField,
	stageStatePath,
	timestamp,
	validateSlugArgs,
	writeFeedbackFile,
	writeJson,
} from "./state-tools.js"
import {
	filterReviewAgentsByScope,
	listStudios,
	readHatDefs,
	readReviewAgentPaths,
	readStageArtifactDefs,
	readStudioFixHatPaths,
	readStudioReviewAgentPaths,
	resolveStudio,
	studioSearchPaths,
} from "./studio-reader.js"
import { emitTelemetry } from "./telemetry.js"
import { orchestratorToolHandlers } from "./tools/orchestrator/index.js"
import type { DAGGraph } from "./types.js"

export { orchestratorToolDefs }

/** Back-compat re-export of the workflow dispatcher. Older callers
 *  (and tests) imported this as `runNext` from orchestrator.ts; new
 *  code should prefer `dispatchOrchestratorAction` directly from
 *  `orchestrator/workflow/run-tick.js`. */
export const runNext = dispatchOrchestratorAction

// Re-exports from extracted submodules. Callers of the old monolith
// continue to import from "./orchestrator.js"; new code can import
// directly from the per-concern modules.
export {
	checkExternalState,
	handleExternalChangesRequested,
	type ExternalReviewState,
} from "./orchestrator/external-review.js"
export {
	buildOutputRequirements,
	runQualityGates,
	validateDiscoveryArtifacts,
	validateStageOutputs,
	validateUnitInputs,
	validateUnitNaming,
	writeReviewFeedbackFiles,
} from "./orchestrator/validators.js"
export {
	completeOrReviewIntent,
	workflowAdvancePhase,
	workflowAdvanceStage,
	workflowCompleteStage,
	workflowGateAsk,
	workflowIntentComplete,
	workflowStartStage,
} from "./orchestrator/workflow/side-effects.js"
export {
	buildElaboratorInstruction,
	buildGuardResponse,
	maybeEscalate,
	summarizeFeedback,
} from "./orchestrator/actions.js"
export {
	buildFeedbackAssessorPrompt,
	resolveIntentStages,
	resolveStageHats,
	resolveStageMetadata,
	resolveStageReview,
	resolveStudioFilePath,
	resolveStudioStages,
	resolveUnitHatsInStudio,
} from "./orchestrator/studio.js"
export {
	cleanupPreExecuteFeedback,
	computeUnitWaves,
	currentWaveNumber,
	isStagePreExecute,
	listUnits,
	type UnitInfo,
} from "./orchestrator/units.js"
export {
	classifyPendingForRevisit,
	resetFixLoopBolts,
	revisit,
	revisitCurrentStage,
} from "./orchestrator/revisit.js"

// ── Action types ───────────────────────────────────────────────────────────

export interface OrchestratorAction {
	action: string
	[key: string]: unknown
}

// Private helper still used by code remaining in this file (revisit
// logic, unit listing). Duplicates the version in extracted modules.
function readFrontmatter(filePath: string): Record<string, unknown> {
	if (!existsSync(filePath)) return {}
	const raw = readFileSync(filePath, "utf8")
	const { data } = parseFrontmatter(raw)
	return data
}

// Local alias for the re-exported resolveIntentStages so revisit
// logic below can call it without an import cycle through the
// re-export.
import { resolveIntentStages as _resolveIntentStages } from "./orchestrator/studio.js"
const resolveIntentStages = _resolveIntentStages


// ── Main orchestration function ────────────────────────────────────────────


// ── Action preview enrichment ─────────────────────────────────────────────
//
// Adds `tell_user` (what the agent should announce) and `next_step` (what
// comes after this action) to every orchestrator action. This lets the
// agent tell the user what's happening and what's coming next.

export function enrichActionWithPreview(action: OrchestratorAction): void {
	const stage = (action.stage as string) || ""
	const unit = (action.unit as string) || ""
	const hat = (action.hat as string) || (action.first_hat as string) || ""
	const nextStage = (action.next_stage as string) || ""

	let tell_user = ""
	let next_step = ""

	switch (action.action) {
		case "select_studio":
			tell_user =
				"I need to select a lifecycle studio for this intent before we can begin."
			next_step =
				"After studio selection, the first stage will start with elaboration."
			break

		case "start_stage":
			tell_user = `Starting stage '${stage}' — I'll elaborate the work into units with completion criteria.`
			next_step =
				"Next I'll break the work down into units, then validate them and open a review gate for your approval."
			break

		case "elaborate": {
			const iteration =
				(action.iteration as number) || (action.visits as number) || 0
			const fbCount = (action.pending_feedback as unknown[])?.length || 0
			const validationErr = action.validation_error as string | undefined
			if (iteration > 1) {
				tell_user = validationErr
					? `Revisiting stage '${stage}' (iteration ${iteration}) — fixing validation on in-flight units before advancing.`
					: `Revisiting stage '${stage}' (iteration ${iteration}) — ${fbCount} pending feedback item(s) to address with new units.`
				next_step =
					"I'll draft units that close each pending feedback item, then advance to execution once validated."
			} else {
				tell_user = `Elaborating stage '${stage}' — defining units of work and their completion criteria.`
				next_step =
					"After units are defined, the orchestrator validates them and opens a review gate for your approval before execution begins."
			}
			break
		}

		case "elaboration_insufficient":
			tell_user = `I need to engage you more on the plan for stage '${stage}' before finalizing.`
			next_step =
				"After sufficient collaboration, I'll finalize units and open the review gate."
			break

		case "gate_review": {
			const gateContext = (action.gate_context as string) || "stage_gate"
			if (gateContext === "intent_review") {
				tell_user =
					"The intent specs are ready — opening the review gate for your approval."
				next_step =
					"After approval, execution begins. If changes are requested, I'll revise and re-submit."
			} else if (gateContext === "elaborate_to_execute") {
				tell_user =
					"Unit specs are validated — opening the review gate for your approval before execution."
				next_step =
					"After approval, I'll begin executing units in wave order. If changes are requested, I'll revise the specs."
			} else {
				tell_user = `Stage '${stage}' is complete — opening the review gate.`
				next_step = nextStage
					? `After approval, I'll advance to stage '${nextStage}'. If changes are requested, I'll address the feedback.`
					: "After approval, the intent is complete."
			}
			break
		}

		case "intent_approved":
			tell_user = "Intent approved — moving to execution."
			next_step = "I'll begin executing units in wave order."
			break

		case "advance_phase": {
			const toPhase = (action.to_phase as string) || ""
			if (toPhase === "execute") {
				tell_user = `Specs approved for stage '${stage}' — beginning execution.`
				next_step = "I'll execute units in wave order, one hat at a time."
			} else if (toPhase === "review") {
				tell_user = `All units complete in stage '${stage}' — moving to review.`
				next_step =
					"I'll run quality gates and adversarial review agents, then open the stage gate."
			} else if (toPhase === "gate") {
				tell_user = `Review complete for stage '${stage}' — moving to the gate.`
				next_step =
					"The stage gate will determine whether to advance, request changes, or send for external review."
			} else {
				tell_user = `Advancing stage '${stage}' to ${toPhase} phase.`
				next_step = ""
			}
			break
		}

		case "start_unit":
			tell_user = `Starting unit '${unit}' with hat '${hat}' in stage '${stage}'.`
			next_step =
				"I'll execute the unit work per the hat definition, then advance to the next hat or next unit."
			break

		case "start_units": {
			const units = (action.units as string[]) || []
			tell_user = `Starting ${units.length} units in parallel: ${units.join(", ")}.`
			next_step = isGitRepo()
				? "Each unit runs in its own worktree. After all complete, the next wave starts or we advance to review."
				: "After all units complete, the next wave starts or we advance to review."
			break
		}

		case "continue_unit":
			tell_user = `Continuing unit '${unit}' — hat: ${hat}, bolt: ${action.bolt || 1}.`
			next_step =
				"I'll continue the work, then advance to the next hat or complete the unit."
			break

		case "continue_units": {
			const entries =
				(action.units as Array<{ name: string; hat: string; bolt: number }>) ||
				[]
			tell_user = `Continuing ${entries.length} units in parallel: ${entries.map((u) => `${u.name}(${u.hat}#${u.bolt})`).join(", ")}.`
			next_step =
				"Each active unit resumes in its own worktree. After all subagents return, the the workflow engine advances."
			break
		}

		case "escalate": {
			const escReason = (action.reason as string) || "unknown"
			const escIteration = (action.iteration as number) || 0
			const escMax = (action.max_iterations as number) || MAX_STAGE_ITERATIONS
			tell_user =
				escReason === "loop_detected"
					? `Stage '${stage}' is stuck in a loop — iteration ${escIteration} regenerated the same feedback set as iteration ${escIteration - 1}.`
					: `Stage '${stage}' hit the ${escMax}-iteration ceiling (now at ${escIteration}) — stopping the autonomous loop.`
			next_step =
				"STOP. Surface this to the human: the autonomous loop is halted. Do NOT call haiku_run_next again until the human makes a decision (reject feedback items, use haiku_revisit to force another cycle, or terminate the intent)."
			break
		}

		case "review":
			tell_user = `Quality gates passed — running adversarial review agents for stage '${stage}'.`
			next_step = "After review agents pass, the stage gate opens for approval."
			break

		case "fix_quality_gates":
			tell_user = `Quality gates failed in stage '${stage}' — I need to fix the issues before review.`
			next_step =
				"After fixing, I'll retry the quality gates and then proceed to adversarial review."
			break

		case "advance_stage":
			tell_user = `Stage '${stage}' complete — advancing to '${nextStage}'.`
			next_step = nextStage
				? `I'll start stage '${nextStage}' with elaboration.`
				: "The intent is complete."
			break

		case "intent_complete":
			tell_user = "All stages are complete — the intent is done."
			next_step = ""
			break

		case "integrate_fix_chains": {
			const icItems = (action.items as Array<{ feedback_id: string }>) || []
			const icScope = (action.scope as string) || "intent"
			tell_user = `${icItems.length} fix-chain merge${icItems.length === 1 ? "" : "s"} conflicted when landing on ${icScope === "intent" ? "intent main" : `stage '${icScope}'`} — dispatching the integrator to resolve.`
			next_step =
				"After integrators return, I'll call run_next to complete the merges."
			break
		}

		case "changes_requested":
			tell_user =
				"Changes were requested on the review — I'll address the feedback."
			next_step = "After revisions, I'll re-submit for review."
			break

		case "external_review_requested":
			tell_user = `Stage '${stage}' needs external review — submit the work through your project's review process.`
			next_step = "After external approval, run /haiku:pickup to continue."
			break

		case "awaiting_external_review":
			tell_user = `Stage '${stage}' is waiting on external review.`
			next_step = "Run /haiku:pickup after the review is approved."
			break

		case "blocked":
			tell_user = `Some units in stage '${stage}' are blocked — dependencies not met.`
			next_step = "Unblock the dependencies, then retry."
			break

		case "design_direction_required":
			tell_user = `Stage '${stage}' requires a design direction selection before proceeding.`
			next_step = "After you select a direction, elaboration continues."
			break

		case "outputs_missing":
			tell_user = `Stage '${stage}' is missing required output artifacts.`
			next_step = "Create the missing artifacts, then retry."
			break

		case "discovery_missing":
			tell_user = `Stage '${stage}' is missing required discovery artifacts.`
			next_step = "Create the missing artifacts, then retry."
			break

		case "unresolved_dependencies":
			tell_user =
				"Some unit dependencies reference units that don't exist — I need to fix the references."
			next_step = "After fixing, I'll retry advancement."
			break

		case "dag_cycle_detected":
			tell_user =
				"A dependency cycle was detected in the unit graph — I need to break the cycle."
			next_step = "After fixing, I'll retry advancement."
			break

		case "unit_naming_invalid":
			tell_user =
				"Some unit files don't follow the required naming convention — I need to rename them."
			next_step = "After fixing, I'll retry advancement."
			break

		case "gate_blocked":
			tell_user =
				"Gate review couldn't be completed — the review UI and elicitation both failed."
			next_step = "Run haiku_run_next again to retry the gate review."
			break

		case "complete":
			tell_user = "Intent is already completed."
			next_step = ""
			break

		case "composite_run_stage":
			tell_user = `Running composite stage '${stage}'.`
			next_step = "The composite orchestrator will advance through sub-stages."
			break

		case "error":
			tell_user = (action.message as string) || "An error occurred."
			next_step = ""
			break

		default:
			break
	}

	if (tell_user) action.tell_user = tell_user
	if (next_step) action.next_step = next_step
}

// ── Inline subagent context for hookless harnesses ────────────────────────
//
// When hooks are available (Claude Code, Kiro), the subagent-hook injects
// hat isolation, workflow rules, and bootstrap instructions automatically.
// For hookless harnesses, we must inline this context directly into the
// orchestrator's instructions so the agent (or its subagent equivalent)
// receives the same guidance.

/**
 * Read a file from disk and emit it as a fenced markdown block with a
 * heading. Used to inline referenced files into subagent prompts so the
 * subagent reads ONE file (the prompt tmpfile) instead of fanning out N
 * Read tool calls.
 *
 * Returns "" if the file doesn't exist (caller decides whether to include).
 * Large files are NOT truncated — size is bounded by the studio's file
 * design, not this function.
 */
/**
 * Standard error-recovery appendix for subagent prompts. Documents the
 * shape of advance_hat / reject_hat error responses and the correct
 * recovery for each. Without this, subagents stuck on scope violations
 * get only an opaque error JSON and try wrong things (e.g. git checkout).
 */
// ── Run instruction builder ───────────────────────────────────────────────

export function buildRunInstructions(
	slug: string,
	studio: string,
	action: OrchestratorAction,
	dir: string,
): string {
	// Strip tell_user/next_step from the JSON output — they appear in the
	// announcement section already, no need to duplicate in the raw action.
	const { tell_user, next_step, ...actionForJson } =
		action as OrchestratorAction & { tell_user?: string; next_step?: string }
	const actionJson = JSON.stringify(actionForJson, null, 2)
	const sections: string[] = []

	// Agent announcement directive — tell the user what's happening
	if (tell_user || next_step) {
		const parts: string[] = [
			"## Announce to User (MANDATORY)\n",
			`**Before doing ANY work**, tell the user what you're about to do:`,
		]
		if (tell_user) parts.push(`> ${tell_user}`)
		if (next_step) parts.push(`\n_${next_step}_`)
		parts.push(
			"\nKeep the announcement concise — one or two sentences. Do NOT skip this step.",
		)
		sections.push(parts.join("\n"))
	}

	sections.push(`## Orchestrator Action\n\n\`\`\`json\n${actionJson}\n\`\`\``)

	// All per-action prompts live in orchestrator/prompts/* per-file
	// modules registered in actionPromptBuilders. The legacy switch is
	// gone — unknown actions fall through to the default JSON dump
	// below for forward-compat with new action types.
	const perActionBuilder = actionPromptBuilders.get(action.action)
	if (perActionBuilder) {
		const built = perActionBuilder({ slug, studio, action, dir })
		if (built !== null) {
			sections.push(built)
			return sections.join("\n\n")
		}
	}

	sections.push(
		`## Unknown Action: ${action.action}\n\n${JSON.stringify(action, null, 2)}`,
	)
	return sections.join("\n\n")
}

// ── Tool definitions ───────────────────────────────────────────────────────

// ── Tool handlers ──────────────────────────────────────────────────────────

/**
 * Callback for opening a review and blocking until the user decides.
 * Set by server.ts at startup to avoid circular imports.
 */
let _openReviewAndWait:
	| ((
			intentDir: string,
			reviewType: string,
			gateType?: string,
			/** Abort signal propagated from the MCP tool call so the review
			 *  session can be torn down (and its WebSocket closed) if the
			 *  user cancels the tool. */
			signal?: AbortSignal,
	  ) => Promise<{ decision: string; feedback: string; annotations?: unknown }>)
	| null = null

/**
 * Callback for elicitation — asks the user a question via the MCP client's native UI.
 * Used as fallback when the review UI fails to open.
 */
let _elicitInput:
	| ((params: { message: string; requestedSchema: unknown }) => Promise<{
			action: string
			content?: unknown
	  }>)
	| null = null

export function setOpenReviewHandler(handler: typeof _openReviewAndWait): void {
	_openReviewAndWait = handler
}

export function setElicitInputHandler(handler: typeof _elicitInput): void {
	_elicitInput = handler
}

/** Per-tool orchestrator handlers reach the elicit handler through this
 *  getter — keeps the variable module-private while still allowing
 *  extracted per-tool files to call it. */
export function getElicitInput(): typeof _elicitInput {
	return _elicitInput
}

/** Per-tool orchestrator handlers reach the open-review handler
 *  through this getter — same pattern as getElicitInput. */
export function getOpenReviewAndWait(): typeof _openReviewAndWait {
	return _openReviewAndWait
}

export async function handleOrchestratorTool(
	name: string,
	args: Record<string, unknown>,
	_signal?: AbortSignal,
): Promise<{
	content: Array<{ type: "text"; text: string }>
	isError?: boolean
}> {
	const text = (s: string) => ({
		content: [{ type: "text" as const, text: s }],
	})

	const validationError = validateSlugArgs(args)
	if (validationError) return validationError

	// Per-tool handlers in tools/orchestrator/* take priority over the
	// legacy if-chain. Migrated tools live in their own file with
	// defineTool(); the chain below handles the rest until they all
	// migrate.
	const perToolHandler = orchestratorToolHandlers.get(name)
	if (perToolHandler) {
		const result = perToolHandler.handle(args)
		return result instanceof Promise ? await result : result
	}

	return text(`Unknown orchestrator tool: ${name}`)
}
