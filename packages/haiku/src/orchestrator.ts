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

// ── Path helpers ───────────────────────────────────────────────────────────

/**
 * Resolve a studio-scoped file path. Returns the first existing path found in
 * the studio search order (project overrides plugin), or null if nothing matches.
 * The path returned is what a subagent should open — NOT the file content.
 */
export function resolveStudioFilePath(subpath: string): string | null {
	for (const base of studioSearchPaths()) {
		const full = join(base, subpath)
		if (existsSync(full)) return full
	}
	return null
}

// (The live workflow-contract prompt blocks live in
// `orchestrator/prompts/_helpers.ts` — `WORKFLOW_CONTRACTS_*_BLOCK`.
// The duplicate that previously lived here has been removed.)

/**
 * Compact feedback summary for orchestrator action responses.
 * Returns id/title/origin/author/status + file path — NO body.
 * Callers MUST read the file to understand the finding; a preview here
 * invites shortcut-thinking and missing critical detail in the body.
 */
export function summarizeFeedback(f: {
	id: string
	title: string
	origin: string
	author: string
	status: string
	file: string
}) {
	return {
		feedback_id: f.id,
		title: f.title,
		status: f.status,
		origin: f.origin,
		author: f.author,
		file: f.file,
	}
}

/**
 * Guardrails for agent-invoked stage iterations. When `appendStageIteration`
 * flags `exceeded` (> MAX_STAGE_ITERATIONS) or `loopDetected` (same feedback
 * signature as the previous iteration), return an `escalate` action so the
 * parent agent stops the autonomous loop and surfaces the situation to the
 * human. User-invoked revisits (`trigger: "user-revisit"`) never hit these
 * guards — explicit human intent always wins.
 */
/**
 * Build an MCP response for a failed stage-branch enforcement.
 *
 * When the guard failed because uncommitted changes block a checkout, we
 * return a structured `commit_wip` action. That action tells the agent
 * exactly what to commit (the specific files git refused to overwrite,
 * which belong on the branch they currently sit on) and to retry — no
 * human needs to step in to resolve the dirty tree.
 *
 * Other block types (merge_conflict, merge_in_progress) still ask the
 * agent to resolve, but expose the structured block code so the agent
 * handles the right case. Hard errors remain only for truly unresolvable
 * states.
 */
export function buildGuardResponse(
	slug: string,
	stage: string | undefined,
	guard: {
		ok: boolean
		branch: string
		message: string
		block?: "dirty_tree" | "merge_conflict" | "merge_in_progress"
		dirty_files?: string[]
		target_branch?: string
	},
	contextLabel: string,
): {
	content: { type: "text"; text: string }[]
	isError: true
} {
	const stageLabel = stage || "(none)"
	const target = guard.target_branch || "the target branch"
	const files = guard.dirty_files || []
	if (guard.block === "dirty_tree") {
		const filesBlock =
			files.length > 0
				? `\n\nFiles to commit:\n${files.map((f) => `  - ${f}`).join("\n")}`
				: ""
		const action = {
			action: "commit_wip",
			intent: slug,
			stage: stage || null,
			context: contextLabel,
			current_branch: guard.branch,
			target_branch: target,
			dirty_files: files,
			message: `Uncommitted changes on branch '${guard.branch}' block the switch to '${target}'. These changes belong on '${guard.branch}' — commit them there, then call \`haiku_run_next\` again. The workflow engine will retry the branch switch automatically.${filesBlock}\n\nNo human intervention needed — just:\n  1. \`git add ${files.length > 0 ? files.join(" ") : "<files listed above>"}\`\n  2. \`git commit -m "haiku: wip on ${guard.branch}"\`\n  3. Call \`haiku_run_next\` to retry.`,
		}
		return {
			content: [
				{ type: "text" as const, text: JSON.stringify(action, null, 2) },
			],
			isError: true,
		}
	}
	return {
		content: [
			{
				type: "text" as const,
				text: `Error: stage-branch enforcement failed for intent '${slug}', stage '${stageLabel}' (${contextLabel}) — ${guard.message}`,
			},
		],
		isError: true,
	}
}

export function maybeEscalate(
	slug: string,
	stage: string,
	iter: {
		count: number
		exceeded: boolean
		loopDetected: boolean
		signature: string
	},
	trigger: "feedback" | "external-changes",
	pendingItems: Array<{ feedback_id: string; title: string }> = [],
): OrchestratorAction | null {
	if (!(iter.exceeded || iter.loopDetected)) return null

	const reason = iter.exceeded ? "iteration_limit" : "loop_detected"
	const message = iter.exceeded
		? `Stage '${stage}' has exceeded ${MAX_STAGE_ITERATIONS} agent-invoked iterations (now at ${iter.count}). The autonomous loop has stopped — a human must decide whether to keep pushing, reject feedback items, split the work, or terminate the intent. Use \`haiku_revisit { intent: "${slug}" }\` (user-invoked, uncapped) to force another cycle, \`haiku_feedback_reject\` to dismiss specific items, or mark the stage complete manually.`
		: `Stage '${stage}' is in a loop: iteration ${iter.count}'s feedback set is the same as the previous iteration's. The agent keeps regenerating identical findings, which usually means the spec is wrong or the criteria are unreachable. A human must intervene — adjust the feedback items, relax the criteria, or terminate the intent.`

	emitTelemetry("haiku.stage.escalate", {
		intent: slug,
		stage,
		reason,
		iteration: String(iter.count),
		trigger,
		signature: iter.signature,
	})

	return {
		action: "escalate",
		intent: slug,
		stage,
		reason,
		trigger,
		iteration: iter.count,
		max_iterations: MAX_STAGE_ITERATIONS,
		signature: iter.signature,
		pending_items: pendingItems,
		message,
	}
}

/**
 * Instruction text for the elaborate action's message field.
 * Tells the caller WHAT to do — read every feedback file, draft units with
 * `closes:`, ask the user when trade-offs are unclear. Deliberately does NOT
 * prescribe HOW (no subagent-delegation guidance) — the parent decides how to
 * structure the work within its own context.
 */
export function buildElaboratorInstruction(opts: {
	visits: number
	pendingFeedbackCount: number
	stage: string
	situation?: string
}) {
	const { visits, pendingFeedbackCount, stage, situation } = opts
	const lead =
		visits > 0
			? `Revisit elaborate (visit ${visits}) for stage '${stage}'. ${pendingFeedbackCount} pending feedback item(s) must be addressed with new units.`
			: `Elaborate stage '${stage}' into units with completion criteria.`

	const body = [
		"",
		"Inputs (read each file directly — do not trust titles alone):",
		"- every `pending_feedback[].file` in this action's payload",
		"- `stage_metadata` (STAGE.md body + review agents)",
		"- `completed_units` (the stage's prior units, read-only reference)",
		"- the intent's `intent.md` for overall goals",
		"",
		"Responsibilities:",
		"- Read every `pending_feedback[].file` COMPLETELY. The title is only a handle; the body carries requirements, tests, and acceptance criteria.",
		"- Draft one or more new units whose `closes:` frontmatter references the feedback items they resolve.",
		"- Every pending feedback item MUST be referenced by at least one new unit's `closes:` (orphans block advancement).",
		"- When drafting is complete, call `haiku_run_next` to advance. The workflow engine opens a review gate where the user inspects and approves the drafted units via the review UI — that is the ONLY approval path.",
		"",
		"## Turn discipline",
		"",
		"Elaboration is COLLABORATIVE and DETAILED. Take as many turns as you need to draft a thorough, well-scoped unit set — but every turn must earn its place.",
		"",
		"- **Each turn MUST ask a meaningful question.** A meaningful question is one whose answer changes what you draft — trade-offs, scope boundaries, acceptance criteria, architectural choices with two-plus viable options, priorities between conflicting requirements, or requirement ambiguities that can't be resolved from the intent body alone. Use `AskUserQuestion` with a pre-populated `options[]` array.",
		"- **NEVER ask about things covered elsewhere in the flow.** The following are handled by other parts of the system — asking about them here duplicates work:",
		'  - Unit-set approval ("how do these units look", "does this scope work", "are these acceptable", "should I proceed", "do you approve") — handled by the review gate UI after drafting completes',
		"  - Per-unit feedback (reject / request-changes on specific units) — handled by the review gate's annotation + changes-requested path",
		'  - Feedback closure verification ("did my unit address FB-N") — handled by the feedback-assessor hat during execution',
		'  - Gate decisions ("should we advance the stage") — handled by the gate itself',
		'  - Quality-gate results ("did tests pass") — handled by advance_hat',
		"- **Use `AskUserQuestion` with `questions[]` when several decisions are related** so the user answers them in one UI exchange. Independent questions can still be separate turns — collaboration is the point.",
		"- **When information is genuinely absent from the intent and there are no viable defaults, ask.** When you have reasonable inference based on intent goals + stage scope + prior units, draft it and let the review gate surface disagreements.",
	].join("\n")

	return situation ? `${lead}\n\n${situation}${body}` : `${lead}${body}`
}

function readFrontmatter(filePath: string): Record<string, unknown> {
	if (!existsSync(filePath)) return {}
	const raw = readFileSync(filePath, "utf8")
	const { data } = parseFrontmatter(raw)
	return data
}

// ── Studio resolution ──────────────────────────────────────────────────────

/**
 * Compute the effective stage list for an intent.
 *
 * Resolution order:
 *   1. Start with the studio's full stage list (from STUDIO.md).
 *   2. If `intent.stages` is an explicit non-empty array, intersect with
 *      studio stages (preserves studio order; rejects unknown stages).
 *      This is how `/haiku:quick` restricts a multi-stage studio to a
 *      single stage without having to enumerate skip_stages.
 *   3. Apply `intent.skip_stages` filter on the result.
 *
 * Callers that need the full studio list (not intent-filtered) should call
 * `resolveStudioStages` directly.
 */
export function resolveIntentStages(
	intent: Record<string, unknown>,
	studio: string,
): string[] {
	const studioStages = resolveStudioStages(studio)
	const explicit = Array.isArray(intent.stages)
		? (intent.stages as string[])
		: []
	const allowed = explicit.length > 0 ? new Set(explicit) : null
	const skipStages = (intent.skip_stages as string[]) || []
	return studioStages.filter((s) => {
		if (allowed && !allowed.has(s)) return false
		if (skipStages.includes(s)) return false
		return true
	})
}

export function resolveStudioStages(studio: string): string[] {
	// Accept any identifier (dir, name, slug, alias); falls back to direct lookup
	// for robustness with legacy callers that pass a dir name already.
	const info = resolveStudio(studio)
	if (info) return info.stages
	const pluginRoot = resolvePluginRoot()
	for (const base of [
		join(process.cwd(), ".haiku", "studios"),
		join(pluginRoot, "studios"),
	]) {
		const studioFile = join(base, studio, "STUDIO.md")
		if (existsSync(studioFile)) {
			const fm = readFrontmatter(studioFile)
			return (fm.stages as string[]) || []
		}
	}
	return []
}

export function resolveStageHats(studio: string, stage: string): string[] {
	// Accept any identifier (dir, name, slug, alias); falls back to raw arg
	// for robustness when the studio cache isn't warm yet.
	const info = resolveStudio(studio)
	const dir = info ? info.dir : studio
	const pluginRoot = resolvePluginRoot()
	for (const base of [
		join(process.cwd(), ".haiku", "studios"),
		join(pluginRoot, "studios"),
	]) {
		const stageFile = join(base, dir, "stages", stage, "STAGE.md")
		if (existsSync(stageFile)) {
			const fm = readFrontmatter(stageFile)
			return (fm.hats as string[]) || []
		}
	}
	return []
}

/**
 * Read the ordered `fix_hats:` list declared on a stage. When set, pending
 * feedback findings are routed through this sequence instead of the legacy
 * "draft new units that close feedback" path. Empty list (or missing
 * field) keeps the legacy behavior. Each named hat must have a real
 * `hats/{hat}.md` mandate file (validated at dispatch time); fix hats
 * may live OUTSIDE the main `hats:` rotation so a `feedback-assessor` hat
 * can exist solely for fix-mode use without intruding on the execute loop.
 */
function resolveStageFixHats(studio: string, stage: string): string[] {
	const info = resolveStudio(studio)
	const dir = info ? info.dir : studio
	const pluginRoot = resolvePluginRoot()
	for (const base of [
		join(process.cwd(), ".haiku", "studios"),
		join(pluginRoot, "studios"),
	]) {
		const stageFile = join(base, dir, "stages", stage, "STAGE.md")
		if (existsSync(stageFile)) {
			const fm = readFrontmatter(stageFile)
			const fixHats = fm.fix_hats
			if (Array.isArray(fixHats)) return fixHats as string[]
			return []
		}
	}
	return []
}

/** Build the subagent prompt for the auto-injected `feedback-assessor` hat.
 *  The assessor's job is independent verification of the unit's `closes:`
 *  claims — it reads every feedback body and every output the unit produced,
 *  then decides whether each claim actually resolves the finding. On
 *  approve: workflow engine promotes each FB item's status to `closed`/`addressed` and
 *  the unit completes. On reject: the unit bolts back to the first hat with
 *  a reason naming the specific unresolved items. */
export function buildFeedbackAssessorPrompt(opts: {
	slug: string
	studio: string
	stage: string
	unit: string
	bolt: number
	worktreePath: string
	intentRoot: string
	unitAbsPath: string
	closes: string[]
	feedbackFiles: Array<{ id: string; file: string }>
	unitOutputs: string[]
}): string {
	const {
		slug,
		stage,
		unit,
		bolt,
		worktreePath,
		intentRoot,
		unitAbsPath,
		closes,
		feedbackFiles,
		unitOutputs,
	} = opts
	const lines: string[] = []
	lines.push(
		`You are the **feedback-assessor** hat for unit **${unit}** (bolt ${bolt}) in stage **${stage}** of intent **${slug}**.`,
		"",
		"## Role",
		"",
		"You are the independent verifier. The prior hats produced work claiming to close specific feedback items. You decide — by reading the feedback bodies and the unit's actual outputs — whether each claimed closure is valid. The designer/reviewer cannot self-certify; that is why this hat exists.",
		"",
	)
	if (worktreePath) {
		lines.push(
			`**Unit worktree:** \`${worktreePath}\` (intent dir: \`${intentRoot}\`). Read and write at this path — it contains prior-hat commits not yet merged. **Your FIRST Bash command MUST be \`cd <worktree path>\`.** Every git, npm, node, and shell command that follows must run from inside the worktree. Git commits land on the unit's branch only if you are inside the worktree's tree. Absolute paths below are for Read/Write tool references, but shell-layer work (install, build, test, commit) requires the cwd to be the worktree. Verify with \`pwd\` after \`cd\` if in doubt.

**Bash timeouts are MANDATORY on long-running commands.** Never let a test, build, install, or lint hang the hat indefinitely. Every Bash call that runs \`npm test\`, \`vitest\`, \`npx tsc\`, \`npm run build\`, \`npm install\`, \`playwright\`, or any Node CLI must pass an explicit \`timeout\` parameter:

- typecheck / lint: \`timeout: 120000\` (2 min)
- test runs: \`timeout: 300000\` (5 min)
- builds / install: \`timeout: 600000\` (10 min; the hard cap)

If a command times out, do NOT retry blindly — diagnose why (hanging test, network fetch, infinite loop in a watcher) and fix the underlying cause. A command that legitimately needs more than 10 minutes is a spec problem, not a timeout problem; surface it via \`haiku_unit_reject_hat\` rather than hanging the bolt.`,
			"",
		)
	}
	lines.push(
		"## Required reading",
		"",
		`- Unit spec (for \`closes:\` array + output list) — \`${unitAbsPath}\``,
	)
	for (const out of unitOutputs) {
		lines.push(`- Unit output — \`${join(intentRoot, out)}\``)
	}
	lines.push("", "## Feedback items the unit claims to close", "")
	for (const fb of feedbackFiles) {
		lines.push(
			`- **${fb.id}** — \`${join(intentRoot, fb.file)}\` (read the full body)`,
		)
	}
	if (closes.length === 0) {
		lines.push(
			"- _(none — this assessor was spawned but the unit has no `closes:` references; advance immediately)_",
		)
	}
	lines.push(
		"",
		"## Assessment procedure",
		"",
		"For each feedback item above:",
		"1. Read the feedback body in full. Extract the concrete requirement(s) it is asserting must change.",
		"2. Read the unit's outputs listed above (or glob the unit's artifacts dir if not listed).",
		"3. Judge independently: does the output *demonstrably* resolve the finding? Be strict — a partial gesture is not a fix.",
		"4. Record your verdict per feedback item: **closed** (resolved) or **still-pending** (not resolved, with a specific reason).",
		"",
		"## Outcome",
		"",
		`- **All items closed:** call \`haiku_unit_advance_hat { intent: "${slug}", unit: "${unit}" }\`. The workflow engine will promote each feedback item to \`closed\` (agent-authored) or \`addressed\` (human-authored) automatically.`,
		`- **Any still-pending:** call \`haiku_unit_reject_hat { intent: "${slug}", unit: "${unit}", reason: "<which items aren't closed and why>" }\`. The unit bolts back to the first hat. The failing feedback items stay \`pending\` — they will be re-addressed on the next bolt.`,
		"",
		"## Guardrails",
		"",
		"- Do NOT edit any artifacts. You verify only.",
		"- Do NOT call `haiku_feedback_update` yourself — advance_hat does the status promotion atomically.",
		"- Be specific in reject reasons: name each feedback id (FB-NN) that isn't closed and one-line why.",
		"- Trust the unit's output list but also scan the artifacts directory — if a claimed close hinges on an artifact the unit didn't list, flag it.",
	)
	return lines.join("\n")
}

/** Append `feedback-assessor` as the terminal hat when a unit declares
 *  `closes:` items. Mirrors state-tools.ts's resolveUnitHats. */
export function resolveUnitHatsInStudio(
	studio: string,
	stage: string,
	slug: string,
	unit: string,
): string[] {
	const stageHats = resolveStageHats(studio, stage)
	const dir = intentDir(slug)
	const unitFile = join(
		dir,
		"stages",
		stage,
		"units",
		unit.endsWith(".md") ? unit : `${unit}.md`,
	)
	if (!existsSync(unitFile)) return stageHats
	try {
		const { data } = parseFrontmatter(readFileSync(unitFile, "utf8"))
		const closes = (data.closes as string[]) || []
		if (closes.length > 0 && !stageHats.includes("feedback-assessor")) {
			return [...stageHats, "feedback-assessor"]
		}
	} catch {
		/* non-fatal */
	}
	return stageHats
}

export function resolveStageReview(studio: string, stage: string): string {
	// Accept any identifier (dir, name, slug, alias); falls back to raw arg
	// for robustness when the studio cache isn't warm yet.
	const info = resolveStudio(studio)
	const dir = info ? info.dir : studio
	const pluginRoot = resolvePluginRoot()
	for (const base of [
		join(process.cwd(), ".haiku", "studios"),
		join(pluginRoot, "studios"),
	]) {
		const stageFile = join(base, dir, "stages", stage, "STAGE.md")
		if (existsSync(stageFile)) {
			const fm = readFrontmatter(stageFile)
			const review = fm.review
			// Return every declared review kind joined with commas so downstream
			// callers (which use `.includes("external")`, `.includes("ask")`, etc.)
			// see all kinds. Previously this collapsed `[external, ask]` to just
			// `"external"`, silently dropping the "ask" half of the gate.
			if (Array.isArray(review)) return (review as string[]).join(",")
			return (review as string) || "auto"
		}
	}
	return "auto"
}

export function resolveStageMetadata(
	studio: string,
	stage: string,
): { description: string; body: string } | null {
	// Accept any identifier (dir, name, slug, alias); falls back to raw arg
	// for robustness when the studio cache isn't warm yet.
	const info = resolveStudio(studio)
	const dir = info ? info.dir : studio
	const pluginRoot = resolvePluginRoot()
	for (const base of [
		join(process.cwd(), ".haiku", "studios"),
		join(pluginRoot, "studios"),
	]) {
		const stageFile = join(base, dir, "stages", stage, "STAGE.md")
		if (existsSync(stageFile)) {
			const raw = readFileSync(stageFile, "utf8")
			const fm = readFrontmatter(stageFile)
			const { content } = matter(raw)
			return {
				description: (fm.description as string) || stage,
				body: content.trim(),
			}
		}
	}
	return null
}


// ── Action types ───────────────────────────────────────────────────────────

export interface OrchestratorAction {
	action: string
	[key: string]: unknown
}


// ── Main orchestration function ────────────────────────────────────────────

// ── Unit listing with dependency resolution ────────────────────────────────

export interface UnitInfo {
	name: string
	status: string
	hat: string
	bolt: number
	dependsOn: string[]
	depsComplete: boolean
}

/**
 * Pre-execute means no unit in the stage has ever reached `completed`.
 * Semantically: "nothing has been built yet." Feedback files do not apply
 * here — they track defects on artifacts that exist, and pre-exec has no
 * artifacts. Any review rejection at this phase goes inline, not through
 * the persistent feedback model.
 */
export function isStagePreExecute(
	intentDirPath: string,
	stage: string,
): boolean {
	const units = listUnits(intentDirPath, stage)
	if (units.length === 0) return true
	return !units.some((u) => u.status === "completed")
}

/**
 * Clean up any legacy feedback files in a pre-execute stage's feedback/
 * directory. Intents created before pre-exec-feedback was removed may have
 * FB-NN.md files left behind; deleting them makes the state consistent with
 * the new invariant (no FB persistence pre-execute) and prevents the workflow
 * from re-triggering old pre-review code paths.
 */
export function cleanupPreExecuteFeedback(
	intentDirPath: string,
	stage: string,
): string[] {
	if (!isStagePreExecute(intentDirPath, stage)) return []
	const feedbackDir = join(intentDirPath, "stages", stage, "feedback")
	if (!existsSync(feedbackDir)) return []
	const removed: string[] = []
	for (const f of readdirSync(feedbackDir)) {
		if (f.endsWith(".md") && /^\d+-/.test(f)) {
			try {
				rmSync(join(feedbackDir, f), { force: true })
				removed.push(f)
			} catch {
				/* best-effort */
			}
		}
	}
	return removed
}

export function listUnits(intentDirPath: string, stage: string): UnitInfo[] {
	const unitsDir = join(intentDirPath, "stages", stage, "units")
	if (!existsSync(unitsDir)) return []

	const files = readdirSync(unitsDir).filter((f) => f.endsWith(".md"))
	const units: UnitInfo[] = files.map((f) => {
		const fm = readFrontmatter(join(unitsDir, f))
		return {
			name: f.replace(".md", ""),
			status: (fm.status as string) || "pending",
			hat: (fm.hat as string) || "",
			bolt: (fm.bolt as number) || 0,
			dependsOn: (fm.depends_on as string[]) || [],
			depsComplete: false,
		}
	})

	// Resolve dependency completion
	const statusMap = new Map(units.map((u) => [u.name, u.status]))
	for (const unit of units) {
		unit.depsComplete = unit.dependsOn.every(
			(dep) => statusMap.get(dep) === "completed",
		)
	}

	return units
}

/**
 * Build a DAGGraph from UnitInfo[] and compute wave assignments.
 * Returns { waves, unitWave, totalWaves } where:
 *  - waves: Map<waveNumber, unitName[]>
 *  - unitWave: Map<unitName, waveNumber>
 *  - totalWaves: total number of waves
 */
export function computeUnitWaves(units: UnitInfo[]): {
	waves: Map<number, string[]>
	unitWave: Map<string, number>
	totalWaves: number
} {
	// Build a DAGGraph from UnitInfo[]
	const nodes = units.map((u) => ({ id: u.name, status: u.status }))
	const edges: Array<{ from: string; to: string }> = []
	const adjacency = new Map<string, string[]>()

	for (const u of units) {
		adjacency.set(u.name, [])
	}
	for (const u of units) {
		for (const dep of u.dependsOn) {
			if (!adjacency.has(dep)) continue // cross-stage dep — skip
			edges.push({ from: dep, to: u.name })
			const existing = adjacency.get(dep)
			if (existing) {
				existing.push(u.name)
			}
		}
	}

	const dag: DAGGraph = { nodes, edges, adjacency }
	let waves: Map<number, string[]>
	try {
		waves = computeWaves(dag)
	} catch {
		// Cycle — put all in wave 0 as fallback (cycle should be caught earlier at elaborate→execute)
		waves = new Map([[0, units.map((u) => u.name)]])
	}

	// Build reverse map: unit name → wave number
	const unitWave = new Map<string, number>()
	let totalWaves = 0
	for (const [wave, names] of waves) {
		for (const name of names) {
			unitWave.set(name, wave)
		}
		if (wave + 1 > totalWaves) totalWaves = wave + 1
	}

	return { waves, unitWave, totalWaves }
}

/**
 * Find the current wave: the lowest wave number that still has pending units.
 */
export function currentWaveNumber(
	units: UnitInfo[],
	unitWave: Map<string, number>,
	totalWaves: number,
): number {
	for (let w = 0; w < totalWaves; w++) {
		const hasIncomplete = units.some(
			(u) => unitWave.get(u.name) === w && u.status !== "completed",
		)
		if (hasIncomplete) return w
	}
	return 0
}

// ── Go back (stage/phase regression) ──────────────────────────────────────

/**
 * Bucket pending feedback on a stage by the `resolution` field the
 * reviewer (or a prior triage pass) wrote. The revisit entry point
 * uses this to decide whether to actually roll the stage back or to
 * hand the resolution work off to the agent without a rollback.
 *
 * Resolution semantics:
 *   - `null`           → reviewer didn't pick a path; the agent
 *                        triages each one during `feedback_dispatch`
 *                        (read the finding, decide on a resolution,
 *                        call `haiku_feedback_update` to persist,
 *                        then dispatch per the chosen bucket).
 *                        NOT treated as `stage_revisit` — the nuclear
 *                        option should never be the silent default.
 *   - `stage_revisit`  → the stage needs a full re-loop; this is the
 *                        ONLY bucket that triggers `revisitCurrentStage`.
 *   - `question`       → agent replies via POST .../replies with
 *                        close_as_answered: true, no code delta.
 *   - `inline_fix`     → agent dispatches ONE bolt of the stage's
 *                        fix_hats against the finding. The existing
 *                        fix-loop machinery (`review_fix` action)
 *                        takes it from there.
 *   - `upstream_rewind`→ surface to the human via the existing
 *                        `upstream_finding_surfaced` path.
 */
interface FeedbackClassification {
	questions: FeedbackItem[]
	inlineFixes: FeedbackItem[]
	upstreamRewinds: FeedbackItem[]
	stageRevisits: FeedbackItem[] // EXPLICIT stage_revisit only
	needsTriage: FeedbackItem[] // null resolution — agent decides
}

export function classifyPendingForRevisit(
	items: FeedbackItem[],
): FeedbackClassification {
	const out: FeedbackClassification = {
		questions: [],
		inlineFixes: [],
		upstreamRewinds: [],
		stageRevisits: [],
		needsTriage: [],
	}
	for (const it of items) {
		if (it.status !== "pending") continue
		const r = (it as { resolution?: string | null }).resolution ?? null
		switch (r) {
			case "question":
				out.questions.push(it)
				break
			case "inline_fix":
				out.inlineFixes.push(it)
				break
			case "upstream_rewind":
				out.upstreamRewinds.push(it)
				break
			case "stage_revisit":
				out.stageRevisits.push(it)
				break
			default:
				// null / unset → needs triage by the agent. Do NOT default
				// to stage_revisit — the reviewer's "I didn't pick" is a
				// request for the agent to read the finding and decide,
				// not an implicit nuclear reset.
				out.needsTriage.push(it)
				break
		}
	}
	return out
}

/**
 * Compose a `feedback_dispatch` action the agent can act on without a
 * stage rollback. Each bucket becomes a block of instructions keyed
 * off the feedback id, so the agent can dispatch them serially
 * (questions first, inline-fixes next, upstream-rewinds surfaced to
 * the user). Returned only when every pending item routes through
 * one of the non-revisit paths.
 */
function buildFeedbackDispatchAction(
	slug: string,
	stage: string,
	classification: FeedbackClassification,
): OrchestratorAction {
	const summaryOf = (it: FeedbackItem): string => `- **${it.id}** — ${it.title}`
	const sections: string[] = []
	if (classification.needsTriage.length > 0) {
		// Put triage first — the agent must assign resolutions to null
		// items before (or alongside) dispatching the explicit ones, so
		// the next `haiku_run_next` tick sees a fully classified queue.
		sections.push(
			`### Triage — reviewer left resolution unset (${classification.needsTriage.length})\n\nFor each item below, read the title + body (and any attachment/source_ref) and decide which resolution applies:\n- **question** — the reviewer wants a reply with no code delta\n- **inline_fix** — small, scoped change; dispatch one fix_hats bolt against just this finding\n- **stage_revisit** — the stage's elaboration or execution missed something fundamental; a full re-loop is warranted\n- **upstream_rewind** — root cause lives in an upstream stage; surface to human\n\nPersist your decision by calling \`haiku_feedback_update { intent: "${slug}", stage: "${stage}", feedback_id, resolution: "<choice>" }\`. After setting resolutions on every item below, call \`haiku_run_next\` again — the router will re-classify and dispatch.\n\n${classification.needsTriage.map(summaryOf).join("\n")}`,
		)
	}
	if (classification.questions.length > 0) {
		sections.push(
			`### Reply to questions (${classification.questions.length})\n\nFor each item below, read the body, formulate a reply, and POST it to \`/api/feedback/${encodeURIComponent(slug)}/${encodeURIComponent(stage)}/<feedback_id>/replies\` with \`{ body: <reply>, close_as_answered: true }\`. No code delta needed.\n\n${classification.questions.map(summaryOf).join("\n")}`,
		)
	}
	if (classification.inlineFixes.length > 0) {
		sections.push(
			`### Inline fixes (${classification.inlineFixes.length})\n\nFor each item below, run ONE bolt of the stage's \`fix_hats\` sequence against the single finding. The fix hat must land a real code change; a planning-only hat (planner/strategist) will fail to close the finding. On success, the feedback_assessor hat (terminal validator) flips the item to \`closed\`.\n\n${classification.inlineFixes.map(summaryOf).join("\n")}`,
		)
	}
	if (classification.upstreamRewinds.length > 0) {
		sections.push(
			`### Upstream rewinds — SURFACE TO HUMAN (${classification.upstreamRewinds.length})\n\nThese items' root causes live in an upstream stage. DO NOT auto-fix. Present each to the user and let them choose: \`haiku_revisit { intent, stage: <upstream> }\` to roll upstream, \`haiku_feedback_reject\` to dismiss, or accept as-is.\n\n${classification.upstreamRewinds.map(summaryOf).join("\n")}`,
		)
	}
	return {
		action: "feedback_dispatch",
		intent: slug,
		stage,
		counts: {
			needs_triage: classification.needsTriage.length,
			questions: classification.questions.length,
			inline_fixes: classification.inlineFixes.length,
			upstream_rewinds: classification.upstreamRewinds.length,
		},
		message: `Resolve pending feedback on stage '${stage}' WITHOUT rolling the stage back. Dispatch each item per its resolution:\n\n${sections.join("\n\n")}\n\nAfter dispatching all items, call \`haiku_run_next { intent: "${slug}" }\` to re-check the gate.`,
	}
}

export function revisit(
	slug: string,
	requestedStage?: string,
): OrchestratorAction {
	const root = findHaikuRoot()
	const iDir = join(root, "intents", slug)
	const intentFile = join(iDir, "intent.md")

	if (!existsSync(intentFile)) {
		return { action: "error", message: `Intent '${slug}' not found` }
	}

	const intent = readFrontmatter(intentFile)
	const studio = (intent.studio as string) || ""
	if (!studio) {
		return {
			action: "error",
			message: `Intent '${slug}' has no studio selected. Call haiku_select_studio first.`,
		}
	}
	const currentActiveStage = (intent.active_stage as string) || ""

	if (!currentActiveStage) {
		return { action: "error", message: "No active stage to revisit from" }
	}

	// Before rolling back anything, inspect the pending feedback on the
	// active stage. If every pending item explicitly routes through a
	// non-revisit path (question / inline_fix / upstream_rewind), we
	// return a `feedback_dispatch` action instead — the stage stays
	// intact, the agent resolves each finding per its declared
	// resolution, and the next `haiku_run_next` re-checks the gate.
	// When the requested stage is the current stage OR omitted, the
	// classification applies; an explicit earlier-stage revisit is the
	// reviewer declaring "roll back," so we skip the check and let the
	// existing flow run.
	const shouldClassify =
		!requestedStage || requestedStage === currentActiveStage
	if (shouldClassify) {
		const pending = readFeedbackFiles(slug, currentActiveStage)
		const classification = classifyPendingForRevisit(pending)
		const hasAny =
			classification.questions.length +
				classification.inlineFixes.length +
				classification.upstreamRewinds.length +
				classification.stageRevisits.length +
				classification.needsTriage.length >
			0
		// Rollback ONLY when the reviewer explicitly tagged at least
		// one item `stage_revisit`. Null/unset resolutions route through
		// the dispatch action and the agent triages them there — silent
		// defaulting to rollback was the "ran next and got rewound"
		// footgun.
		if (hasAny && classification.stageRevisits.length === 0) {
			return buildFeedbackDispatchAction(
				slug,
				currentActiveStage,
				classification,
			)
		}
	}

	const studioStages = resolveIntentStages(intent, studio)
	const currentIdx = studioStages.indexOf(currentActiveStage)

	if (currentIdx < 0) {
		return {
			action: "error",
			message: `Active stage '${currentActiveStage}' is not in the studio's stage list: [${studioStages.join(", ")}]. Run haiku_repair to fix.`,
		}
	}

	// If a specific stage was requested, validate and jump there
	if (requestedStage) {
		const targetIdx = studioStages.indexOf(requestedStage)
		if (targetIdx < 0) {
			return {
				action: "error",
				message: `Stage '${requestedStage}' not found in studio stages: [${studioStages.join(", ")}]`,
			}
		}
		if (targetIdx > currentIdx) {
			return {
				action: "error",
				message: `Cannot revisit '${requestedStage}' — it's ahead of current stage '${currentActiveStage}'. Use haiku_run_next to advance.`,
			}
		}
		if (targetIdx === currentIdx) {
			// Same stage — reset to elaborate
			return revisitCurrentStage(slug, iDir, intentFile, currentActiveStage)
		}
		// Jump to the requested earlier stage
		return revisitEarlierStage(
			slug,
			iDir,
			intentFile,
			currentActiveStage,
			requestedStage,
		)
	}

	// No stage specified — infer target from current position.
	// If in execute/review/gate → revisit elaborate in the current stage.
	const path = stageStatePath(slug, currentActiveStage)
	const stageState = readJson(path)
	const currentPhase = (stageState.phase as string) || "elaborate"

	if (currentPhase !== "elaborate") {
		return revisitCurrentStage(slug, iDir, intentFile, currentActiveStage)
	}

	// Already in elaborate — the target is ambiguous. Silently falling back
	// to "previous stage" has historically caused active_stage to jump
	// backwards unexpectedly (e.g. after a feedback_revisit escalation that
	// pre-flipped phase to elaborate). Force the caller to be explicit
	// about which stage they want to revisit.
	if (currentIdx <= 0) {
		return {
			action: "error",
			message: `Stage '${currentActiveStage}' is already in the elaborate phase and is the first stage — there is no earlier stage to revisit. If you intend to re-elaborate '${currentActiveStage}', pass \`stage: "${currentActiveStage}"\` explicitly.`,
		}
	}
	const prevStage = studioStages[currentIdx - 1]
	return {
		action: "error",
		message: `Stage '${currentActiveStage}' is already in the elaborate phase — \`haiku_revisit\` cannot infer whether you want to re-elaborate '${currentActiveStage}' or jump back to '${prevStage}'. Pass \`stage\` explicitly (\`stage: "${currentActiveStage}"\` to re-elaborate the current stage, \`stage: "${prevStage}"\` to revisit the prior one).`,
	}
}

function uncompleteIntent(slug: string, intentFile: string): void {
	const intent = readFrontmatter(intentFile)
	let dirty = false
	if (intent.status === "completed") {
		setFrontmatterField(intentFile, "status", "active")
		setFrontmatterField(intentFile, "completed_at", null)
		dirty = true
	}
	// A completed intent may have landed in `awaiting_completion_review`
	// earlier; reviving it for a revisit must drop out of that phase or
	// the next `haiku_run_next` tick will re-enter the completion-review
	// branch instead of the revisited stage.
	if (
		intent.phase === "awaiting_completion_review" ||
		intent.completion_review_dispatched === true
	) {
		setFrontmatterField(intentFile, "phase", "active")
		setFrontmatterField(intentFile, "completion_review_dispatched", false)
		setFrontmatterField(intentFile, "completion_review_skipped", false)
		dirty = true
	}
	if (dirty) {
		// All the above fields are workflow-tracked in INTENT_FIELDS; reseal so
		// the next verifyIntentState() doesn't false-positive as tampering.
		sealIntentState(slug)
	}
}

export function revisitCurrentStage(
	slug: string,
	iDir: string,
	intentFile: string,
	currentActiveStage: string,
): OrchestratorAction {
	const path = stageStatePath(slug, currentActiveStage)
	const stageState = readJson(path)
	const currentPhase = (stageState.phase as string) || "elaborate"

	stageState.phase = "elaborate"
	stageState.gate_entered_at = null
	stageState.gate_outcome = null
	// Reset pre-review state so the revisit re-audits the (edited) unit specs.
	stageState.pre_review_dispatched = false
	stageState.pre_review_dispatched_at = null
	stageState.pre_review_skipped_no_agents = false
	stageState.pre_review_reviewers_acknowledged = false
	stageState.pre_review_reviewers_acknowledged_at = null
	writeJson(path, stageState)

	// If the intent was marked completed OR in the completion-review
	// phase, revisit reactivates it (and reseals the integrity checksum).
	uncompleteIntent(slug, intentFile)

	// Unified flow (both continuous and discrete): merge main forward into the
	// current stage branch (non-destructive) and clean up unit worktrees so the
	// re-queued units start fresh. We keep the stage branch history so feedback
	// files and partial artifacts from prior attempts are preserved — the unit
	// state reset below re-queues the work without losing context.
	gitCommitState(`haiku: revisit elaborate ${currentActiveStage} (pre-merge)`)
	cleanupIntentWorktrees(slug)
	const prepared = prepareRevisitBranch(
		slug,
		currentActiveStage,
		currentActiveStage,
	)
	if (!prepared.success) {
		return {
			action: "error",
			message: `Failed to prepare stage branch '${currentActiveStage}' for revisit: ${prepared.message}. Resolve conflicts on the stage branch manually, then retry.`,
		}
	}

	// Re-queue all units to pending
	const unitsDir = join(iDir, "stages", currentActiveStage, "units")
	if (existsSync(unitsDir)) {
		const files = readdirSync(unitsDir).filter((f) => f.endsWith(".md"))
		for (const f of files) {
			const unitFile = join(unitsDir, f)
			setFrontmatterField(unitFile, "status", "pending")
			setFrontmatterField(unitFile, "bolt", 0)
			setFrontmatterField(unitFile, "hat", "")
			setFrontmatterField(unitFile, "started_at", null)
			setFrontmatterField(unitFile, "completed_at", null)
		}
	}

	// Reset fix-loop bolt counters on any pending/fixing feedback. Without
	// this, a revisit that landed at the bolt cap would re-escalate
	// immediately on the first tick — the human's explicit revisit is a
	// deliberate "try again" signal that should restart the budget.
	resetFixLoopBolts(slug, currentActiveStage)

	emitTelemetry("haiku.revisit.phase", {
		intent: slug,
		stage: currentActiveStage,
		from_phase: currentPhase,
		to_phase: "elaborate",
	})
	gitCommitState(`haiku: revisit elaborate in ${currentActiveStage}`)

	return {
		action: "revisited",
		intent: slug,
		stage: currentActiveStage,
		target_phase: "elaborate",
		message: `Revisiting elaborate phase in stage '${currentActiveStage}' — all units re-queued`,
	}
}

/**
 * Reset the fix-loop bolt counter (and "fixing" status) on every feedback
 * file in the given stage that isn't terminal. Called when the human
 * explicitly revisits a stage — their revisit is a deliberate "try again"
 * signal, and the fix-loop budget should restart. Terminal items
 * (closed / addressed / rejected) are left alone.
 *
 * Pass stage = "" for intent-scope feedback (used when the intent-completion
 * review gate is rejected and we re-enter the completion phase).
 */
export function resetFixLoopBolts(slug: string, stage: string): void {
	const items = readFeedbackFiles(slug, stage)
	for (const item of items) {
		// Terminal findings stay put. `closed_by` is the source of truth
		// for closure (countPendingFeedback honors it even when status
		// didn't get flipped by the writer), so resetting status/bolt on
		// a closed_by-marked item would reopen a finding that was
		// legitimately closed through the human review UI.
		if (
			item.status === "closed" ||
			item.status === "addressed" ||
			item.status === "rejected"
		)
			continue
		if (item.closed_by) continue
		if (item.bolt === 0 && item.status === "pending") continue
		const full = findFeedbackFile(slug, stage, item.id)
		if (!full) continue
		const newData = { ...full.data, bolt: 0, status: "pending" }
		writeFileSync(full.path, matter.stringify(`\n${full.body}\n`, newData))
	}
}

/**
 * Mark every stage AFTER `targetStage` as stale so the workflow re-enters them
 * on advance rather than fast-forwarding past a `completed` marker.
 *
 * When the human revisits stage X, every stage that was built against X's
 * previous output is now based on obsolete artifacts. Without this reset,
 * the workflow engine's advance_stage logic sees those stages as still `completed`
 * and blithely walks past them, shipping work rooted in the old design.
 *
 * We rewind status → "active", phase → "elaborate", completed_at → null.
 * workflowStartStage will do the rest of the reset when each stage gets re-
 * entered (iterations, started_at, etc.). The stage's artifacts and units
 * are kept on disk — a re-run that finds them still valid can close
 * immediately; a re-run that finds them broken starts from the feedback
 * the reviewers raise.
 */
function markDownstreamStagesStale(
	slug: string,
	_iDir: string,
	targetStage: string,
	intentFile: string,
): void {
	const intent = readFrontmatter(intentFile)
	const studio = (intent.studio as string) || ""
	const stages = resolveIntentStages(intent, studio)
	const targetIdx = stages.indexOf(targetStage)
	if (targetIdx < 0) return
	// Guard 2: write pos-0 defaults on main for the target AND every
	// downstream stage via temp worktree. That way the reset is visible
	// from every stage branch on its next merge-main-forward, and there's
	// exactly one source of truth. We do NOT conditionally "only rewind
	// completed stages" — the revisit is explicit human intent, and the
	// defaults are always safe (fresh start). Local in-progress state on a
	// downstream stage was built on the obsolete upstream anyway.
	const toReset = [targetStage, ...stages.slice(targetIdx + 1)]
	for (const stage of toReset) {
		const posZero = {
			stage,
			status: "active",
			phase: "elaborate",
			started_at: null,
			completed_at: null,
			gate_entered_at: null,
			gate_outcome: null,
			visits: 0,
			stale_reason: `revisit of upstream stage '${targetStage}'`,
			stale_marked_at: timestamp(),
		}
		const relPath = `.haiku/intents/${slug}/stages/${stage}/state.json`
		writeOnIntentMain(
			slug,
			relPath,
			`${JSON.stringify(posZero, null, 2)}\n`,
			`haiku: reset ${stage} state.json on revisit from '${targetStage}' (Guard 2)`,
		)
		// Also update the currently checked-out copy so the in-flight tick
		// sees the reset without waiting for a merge forward.
		const localPath = stageStatePath(slug, stage)
		if (existsSync(localPath)) {
			writeJson(localPath, posZero)
		}
	}
}

function revisitEarlierStage(
	slug: string,
	iDir: string,
	intentFile: string,
	fromStage: string,
	targetStage: string,
): OrchestratorAction {
	// Only the target stage is reset. Intermediate stages between target and
	// fromStage keep their completed status — when the agent finishes the
	// revisited stage and calls haiku_run_next, the workflow engine's consistency check
	// sees them as completed and fast-forwards through to the next incomplete
	// stage. This is intentional: revisit fixes one stage without forcing a
	// full replay of everything that came after.

	// Unified flow (both continuous and discrete): merge BOTH intent main
	// (approved upstream) AND the fromStage branch (unapproved future-stage
	// work — feedback files and in-flight artifacts) into the target stage
	// branch. This ensures feedback and artifacts raised on fromStage survive
	// the revisit even when they haven't been merged into intent main yet.
	// Non-destructive: the target stage branch's own history is preserved; the
	// unit state reset below re-queues the work without losing context.
	gitCommitState(`haiku: revisit from ${fromStage}`)
	// Clean up unit worktrees tied to the target stage first so the
	// re-queued units start fresh.
	cleanupIntentWorktrees(slug)
	const prepared = prepareRevisitBranch(slug, fromStage, targetStage)
	if (!prepared.success) {
		return {
			action: "error",
			message: `Failed to prepare stage branch '${targetStage}' for revisit from '${fromStage}': ${prepared.message}. Resolve conflicts on the target branch manually, then retry.`,
		}
	}

	// Reset the target stage's state
	const targetPath = stageStatePath(slug, targetStage)
	const data: Record<string, unknown> = {
		stage: targetStage,
		status: "active",
		phase: "elaborate",
		started_at: timestamp(),
		completed_at: null,
		gate_entered_at: null,
		gate_outcome: null,
	}
	writeJson(targetPath, data)

	// Re-queue all units in the target stage to pending
	const unitsDir = join(iDir, "stages", targetStage, "units")
	if (existsSync(unitsDir)) {
		const files = readdirSync(unitsDir).filter((f) => f.endsWith(".md"))
		for (const f of files) {
			const unitFile = join(unitsDir, f)
			setFrontmatterField(unitFile, "status", "pending")
			setFrontmatterField(unitFile, "bolt", 0)
			setFrontmatterField(unitFile, "hat", "")
			setFrontmatterField(unitFile, "started_at", null)
			setFrontmatterField(unitFile, "completed_at", null)
		}
	}

	// Reset fix-loop bolt counters on the target stage's feedback so the
	// explicit human revisit restarts the budget.
	resetFixLoopBolts(slug, targetStage)

	// Mark every downstream stage as needing revalidation. They were built
	// against pre-revisit artifacts; their "completed" status is stale. If
	// we left them alone, the workflow engine's next-stage logic would fast-forward
	// through all of them without ever running them — shipping work that
	// depended on the obsolete upstream.
	//
	// Setting status="active", phase="elaborate", completed_at=null makes
	// the workflow re-enter each stage in order. workflowStartStage then decides
	// whether prior work still applies (via merge forward from main) or
	// needs a fresh pass. A `revalidation_of_visit` field records the
	// target's pre-revisit visit count so downstream stages can show "this
	// stage was rerun because <targetStage> changed in visit N+1".
	markDownstreamStagesStale(slug, iDir, targetStage, intentFile)

	// Update intent's active_stage. `active_stage` is workflow-tracked in
	// INTENT_FIELDS, so we must reseal after the write — uncompleteIntent
	// only reseals when IT mutates something. Call it first so a single
	// reseal covers both writes on the completed-intent path.
	uncompleteIntent(slug, intentFile)
	setFrontmatterField(intentFile, "active_stage", targetStage)
	sealIntentState(slug)

	emitTelemetry("haiku.revisit.stage", {
		intent: slug,
		from_stage: fromStage,
		to_stage: targetStage,
	})
	gitCommitState(`haiku: revisit stage ${targetStage}`)

	return {
		action: "revisited",
		intent: slug,
		target_stage: targetStage,
		reset_phase: "elaborate",
		message: `Revisiting stage '${targetStage}' — stage reset to elaborate, all units re-queued`,
	}
}

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
