// orchestrator.ts — H·AI·K·U stage loop orchestration
//
// Deterministic FSM driver. `runNext()` reads state, determines the next
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
	setRunNextHandler,
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

// ── FSM Contracts (global rules, ONE source of truth) ────────────────────────
//
// These blocks are injected into the orchestrator's tool_use_result for the
// corresponding phase actions. They define GLOBAL framework rules — not
// per-studio or per-stage content. Per-studio files (STAGE.md, hats/*.md,
// review-agents/*.md, phases/*.md) carry domain-specific guidance ONLY; they
// MUST NOT restate FSM mechanics (they would drift and conflict).
//
// If a rule changes here, it changes for every studio at once.

const _FSM_CONTRACTS_ELABORATE_BLOCK = [
	"### FSM Contracts (REQUIRED — global framework rules)",
	"",
	"> ## ⟁ NO UNIT ADVANCES WITHOUT A VERIFICATION PATH.",
	"> Every acceptance criterion pairs with a command, condition, or review-agent mandate that proves it. No exceptions.",
	"",
	"These rules apply to **every studio and every stage**. They are enforced by the framework, not by prose. Re-stating them in per-studio files is forbidden (they would drift).",
	"",
	"#### Unit file naming",
	"",
	"- `stages/{stage}/units/unit-NN-slug.md` — zero-padded NN (`01`, `02`, … `10`, `11`); kebab-case slug; `.md` extension.",
	"- NN is monotonically increasing across the stage's lifetime, including revisits. Never reuse a number.",
	"- The FSM validates naming at `haiku_run_next` — non-compliant files block the advance.",
	"",
	"#### Unit DAG (`depends_on:`)",
	"",
	"- Each unit's `depends_on:` frontmatter lists the names of units in the **same stage** that must complete before this unit starts. Omit the field (or empty list) for units with no dependencies.",
	"- The DAG MUST be acyclic. The FSM computes topological waves; a cycle blocks the advance.",
	"- Cross-stage dependencies go in the stage's `inputs:` (STAGE.md) and resolve to concrete output files from prior stages.",
	"",
	"#### Quality gates",
	"",
	"- `quality_gates:` frontmatter MUST be a list of **executable gate objects** — `{ name, command, dir? }` — not prose strings. The FSM runs each `command` at `haiku_unit_advance_hat` time; non-zero exit blocks the advance. Prose-only gates are silently skipped and give no enforcement.",
	"- Canonical shape:",
	"",
	"  ```yaml",
	"  quality_gates:",
	"    - name: no-banned-tokens",
	"      command: \"! grep -rnE 'bg-gray-|text-gray-' .haiku/intents/{slug}/stages/{stage}/artifacts/\"",
	"      dir: .            # optional; default repo root",
	"  ```",
	"",
	"- **Scope rule**: gate commands MUST audit the **full stage artifact directory** (e.g. `stages/{stage}/artifacts/`), not only the unit's declared `inputs:`. Enforcement scope must match rule scope — narrower enforcement lets regressions accumulate on files no unit audited.",
	"- Commands should be idempotent and fast (< 5s each). Negate banned-pattern greps (`! grep …`) so exit 0 means the gate passes.",
	"- Prose descriptions of what the gate *means* belong in the unit body under `## Completion criteria`, NOT in the frontmatter.",
	"",
	"#### Model selection (`model:` frontmatter on each unit)",
	"",
	"- Set `model:` on EVERY unit you create. The FSM reads this at hat-dispatch time and spawns the subagent with the matching tier.",
	"- Valid values: `haiku` (cheap/fast), `sonnet` (standard), `opus` (deep reasoning). No other values are honored — unknown strings fall through to the next cascade level.",
	"- **Calibrate per-unit to the work.** The entire point of per-unit model is that different units have different cognitive load; picking one tier for the whole intent wastes budget on the trivial units and starves the hard ones.",
	"  - `haiku` — mechanical edits, rename sweeps, formatter passes, simple CRUD additions, boilerplate scaffolding, small docs updates. Decisions are obvious from context; no architectural judgment needed.",
	"  - `sonnet` — most real work. Feature implementation, API design decisions within a known pattern, moderate refactors, UI flows, data transformations, test writing. Default when you're unsure.",
	"  - `opus` — novel design, deep debugging of distributed/timing issues, cross-cutting architecture changes, complex algorithm design, research-heavy tasks. Reserve for units where a cheaper tier is likely to produce the wrong answer.",
	"- The cascade (`unit > hat > stage > studio`) lets studio/stage defaults carry most units; unit-level overrides are for outliers on either end of the distribution.",
	"- Omitting `model:` on a unit is valid — the cascade will fall through to hat/stage/studio defaults. Omit ONLY when the default tier is the right pick; do not omit as a sidestep.",
	"",
	"#### Bolts, hats, advance",
	"",
	"- A **bolt** is one full cycle through the stage's hat sequence for a unit. The FSM advances hats via `haiku_unit_advance_hat`; agents NEVER mutate `bolt`, `hat`, `status`, or `iterations` fields directly (the harness blocks those writes).",
	"- The agent's responsibility per hat: produce the hat's outputs, then call `haiku_unit_advance_hat`. On reject: call `haiku_unit_reject_hat` with a reason.",
	"- Maximum bolts per unit: 5. Exceeding escalates to the human.",
	"",
	"#### Revisit cycles — `closes:` frontmatter",
	"",
	"- On an iteration > 1 (feedback-revisit or post-execute rollback), new units MUST declare `closes: [FB-NN, FB-MM, …]` listing every feedback id they address.",
	"- Every pending feedback id MUST be referenced by at least one new unit's `closes:` — orphans block advancement.",
	"- Resolution paths: (a) draft new units that close findings (additive-elaboration), OR (b) fix existing unit specs and close the findings via `haiku_feedback_update status=closed` (pre-execute spec revisit), OR (c) reject stale/invalid findings via `haiku_feedback_reject` with a concrete reason.",
	"",
	"#### MCP tool contracts — what the agent calls vs. what the FSM owns",
	"",
	"- `haiku_run_next { intent }` is the sole FSM driver. Agents call it to advance the lifecycle; they never write `state.json`, `intent.md` frontmatter, or unit FSM fields directly.",
	"- `haiku_unit_advance_hat` / `haiku_unit_reject_hat` are called by subagents inside each hat; they return the result path the parent reads to drive the next action.",
	"- `haiku_feedback` / `haiku_feedback_update` / `haiku_feedback_reject` / `haiku_feedback_delete` are the sole channels for logging and resolving review findings.",
	"- Branch topology, merge semantics, worktree creation, and stage-branch enforcement are owned by the FSM — the agent does not `git checkout`, `git merge`, or create branches manually during stage work.",
	"",
	"#### Unit content quality (validated at advance)",
	"",
	"- Placeholder strings are forbidden in unit specs and frontmatter. The FSM rejects unit advancement when any of these appear: `TBD`, `tbd`, `similar to`, `add error handling`, `etc.`, or a literal `...` placeholder. Either write the concrete value or surface it as a question.",
	"- Every acceptance criterion MUST be testable: include the command or condition that proves it. `tests pass` is rejected; the verify-command must be concrete and exit-code-driven (e.g. `pnpm test --run path/to/file` exits 0, or `pytest tests/foo.py` exits 0, or `cargo test --test bar` exits 0 — match the project's actual stack).",
	"- Criteria are drafted as **pairs**: the goal-prose lives in the unit body under `## Completion criteria`; the executable check lives in the unit's `quality_gates:` frontmatter. Two coupled fields, written together at elaboration time. Per-stage ELABORATION.md files supply domain-specific examples; this contract supplies the rule.",
	"- A criterion that cannot be expressed as a command/condition is a spec gap — surface it (`ask_user_visual_question` or reject the elaborate phase), do not paper over with prose.",
	"",
	"##### Specific-but-unverifiable criteria (a common failure mode)",
	"",
	"Criteria that *sound* concrete but have no executable check produce specs that look complete but the FSM cannot enforce. Watch for these shapes — they apply across every studio:",
	"",
	'- "X is well-organized" / "Output is clean" — no command proves "well-organized"',
	'- "Performance is acceptable" / "Process is fast" — needs a numeric threshold AND a measurement command (e.g. `p95 < 200ms`)',
	'- "X is user-friendly" / "Output is professional" — needs a review pass or a literal allow-list of acceptable phrasings',
	'- "Coverage is comprehensive" / "Treatment is thorough" — needs a structural check counting items, not a subjective judgment',
	"",
	"Per-studio ELABORATION.md files may add domain-specific bad-unverifiable examples (e.g. design's *Visual hierarchy is clear*, product's *Behavior is intuitive*). The ones above are universal; do not restate them in studio files.",
	"",
	"#### Red flags (STOP and re-read this contract if you catch yourself thinking)",
	"",
	"- \"I'll write `TBD` for the parts I'm unsure about\" — placeholders block advancement; write the concrete value or surface it as a question.",
	'- "I\'ll add `similar to unit-XX` to save typing" — copy the relevant content explicitly; cross-references rot when the source changes.',
	'- "The criteria are obvious; I\'ll keep them prose" — every criterion needs a command or condition that proves it.',
	'- "This unit can be huge; the executor will figure it out" — units that take more than one bolt to scope are decomposition failures, not execution failures.',
	'- "I\'ll batch the missing info as assumptions in the spec" — assumptions become silent regressions; ask the user instead.',
].join("\n")

/**
 * Compact feedback summary for orchestrator action responses.
 * Returns id/title/origin/author/status + file path — NO body.
 * Callers MUST read the file to understand the finding; a preview here
 * invites shortcut-thinking and missing critical detail in the body.
 */
function summarizeFeedback(f: {
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
			message: `Uncommitted changes on branch '${guard.branch}' block the switch to '${target}'. These changes belong on '${guard.branch}' — commit them there, then call \`haiku_run_next\` again. The FSM will retry the branch switch automatically.${filesBlock}\n\nNo human intervention needed — just:\n  1. \`git add ${files.length > 0 ? files.join(" ") : "<files listed above>"}\`\n  2. \`git commit -m "haiku: wip on ${guard.branch}"\`\n  3. Call \`haiku_run_next\` to retry.`,
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

function maybeEscalate(
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
function buildElaboratorInstruction(opts: {
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
		"- When drafting is complete, call `haiku_run_next` to advance. The FSM opens a review gate where the user inspects and approves the drafted units via the review UI — that is the ONLY approval path.",
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
 *  approve: FSM promotes each FB item's status to `closed`/`addressed` and
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
		`- **All items closed:** call \`haiku_unit_advance_hat { intent: "${slug}", unit: "${unit}" }\`. The FSM will promote each feedback item to \`closed\` (agent-authored) or \`addressed\` (human-authored) automatically.`,
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
function resolveUnitHatsInStudio(
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

function resolveStageReview(studio: string, stage: string): string {
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

// ── External review detection ─────────────────────────────────────────────
//
// Two-tier signal detection for external/await gates:
//
// Tier 1: Branch merge detection (structural). In git workflows, external
//   review gates use a stage branch (`haiku/{slug}/{stage}`) that gets merged
//   into the intent hub (`haiku/{slug}/main`) when the review is approved.
//   `isBranchMerged()` detects this — including squash merges. This is the
//   primary, tamper-resistant signal: the merge is a structural fact, not
//   something the agent can self-assert.
//
// Tier 2: URL-based CLI probing (fallback). The orchestrator shells out to
//   `gh` or `glab` to check PR/MR status when a review URL was recorded.
//   Used when branch detection is unavailable (non-git workflows) or as a
//   secondary check. Supports GitHub `reviewDecision` and GitLab `approved`.
//
// The agent never self-approves gates. If neither tier detects approval,
// the orchestrator returns `awaiting_external_review` and the user must
// run `/haiku:pickup` after the external review is actually approved.

/**
 * Tier 2 (fallback): URL-based synchronous check of external review state.
 * Supports GitHub PRs (gh) and GitLab MRs (glab). Returns a structured
 * `ExternalReviewState` so the orchestrator can distinguish approved,
 * changes-requested, pending, and unknown states.
 *
 * For GitHub: checks `reviewDecision` (APPROVED / CHANGES_REQUESTED /
 * REVIEW_REQUIRED) and `state` (MERGED = already accepted).
 *
 * For GitLab: checks approval status, merge state, and non-approved open MRs.
 */
/**
 * Result from checking external review state.
 * `status` describes the review state:
 *   - `approved`          — reviews approved or PR/MR merged
 *   - `changes_requested` — reviewer requested changes
 *   - `pending`           — no definitive review decision yet
 *   - `unknown`           — CLI not available, network error, or unrecognised URL
 */
export interface ExternalReviewState {
	status: "approved" | "changes_requested" | "pending" | "unknown"
	provider?: "github" | "gitlab"
	url?: string
}

export function checkExternalState(url: string): ExternalReviewState {
	try {
		if (url.includes("github.com") && url.includes("/pull/")) {
			// GitHub PR — check review decision AND merge state (argument array avoids shell injection)
			const output = execFileSync(
				"gh",
				[
					"pr",
					"view",
					url,
					"--json",
					"state,reviewDecision",
					"-q",
					"[.state, .reviewDecision]",
				],
				{ encoding: "utf8", stdio: "pipe", timeout: 15000 },
			).trim()
			const parsed = JSON.parse(output) as [string, string]
			const [state, reviewDecision] = parsed
			if (state === "MERGED" || reviewDecision === "APPROVED") {
				return { status: "approved", provider: "github", url }
			}
			if (reviewDecision === "CHANGES_REQUESTED") {
				return { status: "changes_requested", provider: "github", url }
			}
			// REVIEW_REQUIRED, COMMENTED, or empty — no definitive decision yet
			return { status: "pending", provider: "github", url }
		}
		if (url.includes("gitlab") && url.includes("/merge_requests/")) {
			// GitLab MR — check via glab CLI (argument array avoids shell injection)
			const output = execFileSync(
				"glab",
				["mr", "view", url, "--output", "json"],
				{ encoding: "utf8", stdio: "pipe", timeout: 15000 },
			).trim()
			const mr = JSON.parse(output) as {
				state?: string
				approved?: boolean
			}
			if (mr.state === "merged" || mr.approved === true) {
				return { status: "approved", provider: "gitlab", url }
			}
			// GitLab: approved === false on an open MR means changes requested
			if (mr.state === "opened" && mr.approved === false) {
				return { status: "changes_requested", provider: "gitlab", url }
			}
			return { status: "pending", provider: "gitlab", url }
		}
		// Unknown URL type — can't check via CLI
		return { status: "unknown" }
	} catch {
		// CLI not available, timeout, or network error
		return { status: "unknown" }
	}
}

// ── External changes-requested helper ─────────────────────────────────────

/**
 * Handle the "changes_requested" outcome from an external review.
 * Creates a feedback file, rolls the FSM back to elaborate, emits telemetry,
 * and returns the orchestrator action.
 */
function handleExternalChangesRequested(
	slug: string,
	currentStage: string,
	externalUrl: string,
	provider: "github" | "gitlab" | undefined,
): OrchestratorAction {
	const originType = provider === "gitlab" ? "external-mr" : "external-pr"
	const fbResult = writeFeedbackFile(slug, currentStage, {
		title: "External review requested changes",
		body: `The external review at ${externalUrl} requested changes. Review the PR/MR comments and address the reviewer's feedback before re-submitting for review.`,
		origin: originType,
		author: "user",
		source_ref: externalUrl,
	})
	gitCommitState(
		`feedback: create ${fbResult.feedback_id} from external review in ${currentStage}`,
	)

	// Roll FSM back to elaborate for a revisit cycle
	const statePath = stageStatePath(slug, currentStage)
	const stateData = readJson(statePath)
	stateData.status = "active"
	stateData.phase = "elaborate"
	stateData.gate_outcome = null
	writeJson(statePath, stateData)
	const iterResult = appendStageIteration(
		slug,
		currentStage,
		{
			trigger: "external-changes",
			reason: `External review at ${externalUrl} requested changes`,
			feedbackTitles: [fbResult.feedback_id],
		},
		"external-changes",
	)
	gitCommitState(
		`revisit ${currentStage}: external changes requested (iteration ${iterResult.count})`,
	)

	emitTelemetry("haiku.gate.resolved", {
		intent: slug,
		stage: currentStage,
		gate_type: "external",
		outcome: "changes_requested",
	})

	const escalateResult = maybeEscalate(
		slug,
		currentStage,
		iterResult,
		"external-changes",
	)
	if (escalateResult) return escalateResult

	return {
		action: "external_changes_requested",
		intent: slug,
		stage: currentStage,
		external_review_url: externalUrl,
		provider,
		feedback_id: fbResult.feedback_id,
		feedback_file: fbResult.file,
		iteration: iterResult.count,
		visits: iterResult.count, // legacy alias — prefer `iteration`
		message: `External review at ${externalUrl} requested changes. Created ${fbResult.feedback_id} and rolled back to elaborate phase (iteration ${iterResult.count}). Address the reviewer's feedback, then call haiku_run_next to continue.`,
	}
}

// ── Output validation ─────────────────────────────────────────────────────

/**
 * Validate that required stage outputs were created during execution.
 * Returns an error action if outputs are missing, null if all present.
 */
function validateStageOutputs(
	slug: string,
	stage: string,
	studio: string,
): OrchestratorAction | null {
	const pluginRoot = resolvePluginRoot()

	// Read output definitions from the stage's outputs/ directory
	for (const base of [
		join(process.cwd(), ".haiku", "studios"),
		join(pluginRoot, "studios"),
	]) {
		const outputsDir = join(base, studio, "stages", stage, "outputs")
		if (!existsSync(outputsDir)) continue

		const outputDefs = readdirSync(outputsDir).filter((f) => f.endsWith(".md"))
		const missing: Array<{ name: string; location: string }> = []

		for (const f of outputDefs) {
			const raw = readFileSync(join(outputsDir, f), "utf8")
			const { data } = matter(raw)
			const required = data.required !== false // default true
			if (!required) continue

			const location = (data.location as string) || ""
			if (!location) continue

			// Skip project-tree outputs (code, deployment configs) — can't validate a specific path
			if (location.startsWith("(")) continue

			// Resolve location with intent slug
			const resolved = location.replace("{intent-slug}", slug)
			const absPath = join(process.cwd(), resolved)

			if (resolved.endsWith("/")) {
				// Directory — check at least one file exists
				if (
					!existsSync(absPath) ||
					readdirSync(absPath).filter((e) => e !== ".gitkeep").length === 0
				) {
					missing.push({ name: (data.name as string) || f, location: resolved })
				}
			} else {
				// Specific file
				if (!existsSync(absPath)) {
					missing.push({ name: (data.name as string) || f, location: resolved })
				}
			}
		}

		if (missing.length > 0) {
			return {
				action: "outputs_missing",
				intent: slug,
				stage,
				missing,
				message: `Cannot advance to review: ${missing.length} required output(s) not found.\n${missing.map((m) => `- ${m.name}: expected at ${m.location}`).join("\n")}\n\nThe execution phase must produce these artifacts. Go back and create them, then call haiku_run_next again.`,
			}
		}
		break // Project-level outputs dir takes precedence over plugin-level (first match wins)
	}

	return null
}

// ── Review feedback writer helper ────────────────────────────────────────

/**
 * Write feedback files from a review-UI changes_requested result.
 * Extracts annotation pins, inline comments, and free-form feedback text
 * into individual feedback files with appropriate origins.
 * Returns the list of created feedback IDs.
 */
export function writeReviewFeedbackFiles(
	slug: string,
	stage: string,
	reviewResult: { feedback?: string; annotations?: unknown },
): string[] {
	const createdIds: string[] = []
	const annotations = reviewResult.annotations as
		| {
				pins?: Array<{ x: number; y: number; text: string }>
				comments?: Array<{
					selectedText: string
					comment: string
					paragraph: number
					location?: string
				}>
				screenshot?: string
		  }
		| undefined

	// Walk pins — each becomes a feedback file
	if (annotations?.pins) {
		for (const pin of annotations.pins) {
			if (!pin.text) continue
			const title =
				pin.text.length > 120 ? `${pin.text.slice(0, 117)}...` : pin.text
			const result = writeFeedbackFile(slug, stage, {
				title,
				body: pin.text,
				origin: "user-visual",
				author: "user",
				source_ref: `pin:${pin.x},${pin.y}`,
			})
			createdIds.push(result.feedback_id)
		}
	}

	// Walk inline comments — each becomes a feedback file. The feedback
	// body carries BOTH the reviewer's comment AND the exact selected
	// text, formatted as a blockquote so the agent sees what was
	// highlighted alongside the critique. Location (file path) goes
	// into source_ref so consumers can jump straight to the file.
	if (annotations?.comments) {
		for (const comment of annotations.comments) {
			if (!comment.comment) continue
			const title =
				comment.comment.length > 120
					? `${comment.comment.slice(0, 117)}...`
					: comment.comment
			const quoted = comment.selectedText
				? comment.selectedText
						.split("\n")
						.map((l) => `> ${l}`)
						.join("\n")
				: ""
			const locationLine = comment.location
				? `**Location:** \`${comment.location}\` (paragraph ${comment.paragraph})`
				: `**Location:** paragraph ${comment.paragraph}`
			const bodyParts = [locationLine]
			if (quoted) {
				bodyParts.push("", "**Selected text:**", "", quoted)
			}
			bodyParts.push("", "**Comment:**", "", comment.comment)
			const body = bodyParts.join("\n")
			const srcRefBase = comment.location
				? `${comment.location}:paragraph=${comment.paragraph}`
				: `paragraph:${comment.paragraph}`
			const result = writeFeedbackFile(slug, stage, {
				title,
				body,
				origin: "user-visual",
				author: "user",
				source_ref: srcRefBase,
			})
			createdIds.push(result.feedback_id)
		}
	}

	// Free-form feedback text — one file if non-empty
	if (reviewResult.feedback?.trim()) {
		const fb = reviewResult.feedback.trim()
		const title = fb.length > 120 ? `${fb.slice(0, 117)}...` : fb
		const result = writeFeedbackFile(slug, stage, {
			title,
			body: fb,
			origin: "user-chat",
			author: "user",
		})
		createdIds.push(result.feedback_id)
	}

	if (createdIds.length > 0) {
		gitCommitState(
			stage
				? `feedback: create ${createdIds.join(", ")} from review UI in ${stage}`
				: `feedback: create ${createdIds.join(", ")} from review UI (intent-scope)`,
		)
	}

	return createdIds
}

// ── Output template injection ────────────────────────────────────────────

/**
 * Build a compact output-requirements block.
 * Lists each output artifact's name/location/format + a PATH to the full
 * template (never inlines the template body). Subagent reads the template
 * file directly if it needs the detail — keeps main-agent AND subagent
 * contexts small. Returns "" if no output artifacts are defined.
 */
export function buildOutputRequirements(
	studio: string,
	stage: string,
	heading = "## Output Requirements",
): string {
	const artifactDefs = readStageArtifactDefs(studio, stage)
	const outputDefs = artifactDefs.filter((d) => d.kind === "output")
	if (outputDefs.length === 0) return ""
	const parts = [
		heading,
		"Full template bodies live at the paths below — read each one you're expected to produce.",
		"",
	]
	for (const od of outputDefs) {
		// Resolve the template file path for subagent reading
		const templatePath = resolveStudioFilePath(
			join(studio, "stages", stage, "outputs", `${od.name}.md`),
		)
		const pathHint = templatePath ? ` | **Template:** \`${templatePath}\`` : ""
		parts.push(
			`- **${od.name}**${od.required ? " (REQUIRED)" : ""} — location: \`${od.location}\`, format: ${od.format}${pathHint}`,
		)
	}
	return parts.join("\n")
}

// ── Discovery artifact validation ────────────────────────────────────────

/**
 * Validate that required discovery artifacts exist before advancing from elaborate to execute.
 * Reads discovery definitions from studios/{studio}/stages/{stage}/discovery/ and checks
 * that each required artifact exists at its specified location.
 * Returns an error action if artifacts are missing, null if all present.
 */
function validateDiscoveryArtifacts(
	slug: string,
	stage: string,
	studio: string,
): OrchestratorAction | null {
	const pluginRoot = resolvePluginRoot()

	// Read discovery definitions from the stage's discovery/ directory
	for (const base of [
		join(process.cwd(), ".haiku", "studios"),
		join(pluginRoot, "studios"),
	]) {
		const discoveryDir = join(base, studio, "stages", stage, "discovery")
		if (!existsSync(discoveryDir)) continue

		const discoveryDefs = readdirSync(discoveryDir).filter((f) =>
			f.endsWith(".md"),
		)
		const missing: Array<{ name: string; location: string }> = []

		for (const f of discoveryDefs) {
			const raw = readFileSync(join(discoveryDir, f), "utf8")
			const { data } = matter(raw)
			const required = data.required !== false // default true
			if (!required) continue

			const location = (data.location as string) || ""
			if (!location) continue

			// Skip project-tree locations (code, deployment configs) — can't validate a specific path
			if (location.startsWith("(")) continue

			// Resolve location with intent slug
			const resolved = location.replace("{intent-slug}", slug)
			const absPath = join(process.cwd(), resolved)

			if (resolved.endsWith("/")) {
				// Directory — check at least one file exists
				if (
					!existsSync(absPath) ||
					readdirSync(absPath).filter((e) => e !== ".gitkeep").length === 0
				) {
					missing.push({ name: (data.name as string) || f, location: resolved })
				}
			} else {
				// Specific file
				if (!existsSync(absPath)) {
					missing.push({ name: (data.name as string) || f, location: resolved })
				}
			}
		}

		if (missing.length > 0) {
			return {
				action: "discovery_missing",
				intent: slug,
				stage,
				missing,
				message: `Cannot advance to execution: ${missing.length} required discovery artifact(s) not found.\n${missing.map((m) => `- ${m.name}: expected at ${m.location}`).join("\n")}\n\nThe elaboration phase must produce these artifacts. Go back and create them, then call haiku_run_next again.`,
			}
		}
		break // Project-level discovery dir takes precedence over plugin-level (first match wins)
	}

	return null
}

/**
 * Validate unit file naming convention in a stage.
 * Files MUST match `unit-NN-slug.md` (e.g., unit-01-data-model.md).
 * Returns violations or null if all pass.
 */
const UNIT_NAMING_PATTERN = /^unit-\d{2,}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/
function validateUnitNaming(
	intentDirPath: string,
	stage: string,
): OrchestratorAction | null {
	const unitsDir = join(intentDirPath, "stages", stage, "units")
	if (!existsSync(unitsDir)) return null

	const allFiles = readdirSync(unitsDir).filter((f) => f.endsWith(".md"))
	if (allFiles.length === 0) return null

	const violations: Array<{ file: string; issue: string }> = []
	const seenNumbers = new Map<number, string>()

	for (const f of allFiles) {
		// Check basic pattern
		if (!UNIT_NAMING_PATTERN.test(f)) {
			// Give a specific hint about what's wrong
			if (!f.startsWith("unit-")) {
				violations.push({ file: f, issue: "must start with 'unit-'" })
			} else if (!/^unit-\d+/.test(f)) {
				violations.push({
					file: f,
					issue:
						"must have a zero-padded number after 'unit-' (e.g., unit-01-...)",
				})
			} else if (!/^unit-\d{2,}/.test(f)) {
				violations.push({
					file: f,
					issue:
						"number must be zero-padded to at least 2 digits (e.g., 01, 02)",
				})
			} else {
				violations.push({
					file: f,
					issue:
						"slug must be kebab-case (lowercase letters, numbers, hyphens). Expected: unit-NN-slug.md",
				})
			}
			continue
		}

		// Check for duplicate numbers
		const numMatch = f.match(/^unit-(\d+)/)
		if (numMatch) {
			const num = Number.parseInt(numMatch[1], 10)
			if (seenNumbers.has(num)) {
				violations.push({
					file: f,
					issue: `duplicate number ${numMatch[1]} (also used by ${seenNumbers.get(num)})`,
				})
			} else {
				seenNumbers.set(num, f)
			}
		}
	}

	if (violations.length > 0) {
		const slug = intentDirPath.split("/intents/")[1] || ""
		return {
			action: "unit_naming_invalid",
			intent: slug,
			stage,
			violations,
			message: `${violations.length} unit file(s) have invalid naming in stage '${stage}'. Files MUST be named \`unit-NN-slug.md\` (e.g., \`unit-01-data-model.md\`):\n\n${violations.map((v) => `- \`${v.file}\`: ${v.issue}`).join("\n")}\n\nRename the files to match the convention, then call \`haiku_run_next { intent: "${slug}" }\` again.`,
		}
	}

	return null
}

// ── Unit inputs validation ───────────────────────────────────────────────

/**
 * Validate that all units in a stage have a non-empty `inputs:` field.
 * Every unit must declare what upstream artifacts it references.
 * Returns an error action if any units are missing inputs, null if all pass.
 */
function validateUnitInputs(
	intentDirPath: string,
	stage: string,
): OrchestratorAction | null {
	const unitsDir = join(intentDirPath, "stages", stage, "units")
	if (!existsSync(unitsDir)) return null

	const unitFiles = readdirSync(unitsDir).filter((f) => f.endsWith(".md"))
	if (unitFiles.length === 0) return null

	const missing: string[] = []
	for (const f of unitFiles) {
		const fm = readFrontmatter(join(unitsDir, f))
		const status = (fm.status as string) || ""
		if (["complete", "skipped", "failed"].includes(status)) continue
		const inputs = (fm.inputs as string[]) || (fm.refs as string[]) || []
		if (inputs.length === 0) {
			missing.push(f.replace(/\.md$/, ""))
		}
	}

	if (missing.length > 0) {
		const slug = intentDirPath.split("/intents/")[1] || ""
		return {
			action: "unit_inputs_missing",
			intent: slug,
			stage,
			missing_units: missing,
			message: `Cannot advance to execution: ${missing.length} unit(s) have no \`inputs:\` field.\n\nEvery unit MUST declare its inputs — the upstream artifacts, knowledge docs, and prior-stage outputs it references. At minimum, include the intent document and discovery docs.\n\nUnits missing inputs:\n${missing.map((u) => `- ${u}`).join("\n")}\n\nAdd \`inputs:\` to each unit's frontmatter with paths relative to the intent directory (e.g., \`knowledge/DISCOVERY.md\`, \`stages/design/DESIGN-BRIEF.md\`), then call \`haiku_run_next { intent: "${slug}" }\` again.`,
		}
	}

	return null
}

// ── Quality gate runner ───────────────────────────────────────────────────

interface QualityGateResult {
	name: string
	command: string
	dir: string
	exit_code: number
	output: string
}

/**
 * Read quality_gates from intent.md and all unit files in a stage,
 * execute each gate command, and return failures.
 */
function runQualityGates(slug: string, stage: string): QualityGateResult[] {
	const root = findHaikuRoot()
	const iDir = join(root, "intents", slug)
	const intentFile = join(iDir, "intent.md")

	// Determine repo root for default cwd
	let repoRoot: string
	try {
		repoRoot = execSync("git rev-parse --show-toplevel", {
			encoding: "utf8",
		}).trim()
	} catch {
		repoRoot = process.cwd()
	}

	// Parse quality_gates from frontmatter using gray-matter (already imported)
	function parseGates(
		filePath: string,
	): Array<{ name: string; command: string; dir: string }> {
		const data = readFrontmatter(filePath)
		const raw = Array.isArray(data.quality_gates) ? data.quality_gates : []
		return raw
			.filter(
				(g: Record<string, unknown>): g is Record<string, string> =>
					!!g?.command,
			)
			.map((g: Record<string, string>) => ({
				name: g.name ?? "",
				command: g.command,
				dir: g.dir ?? "",
			}))
	}

	// Collect gates from intent + all units in this stage
	const allGates = parseGates(intentFile)
	const unitsDir = join(iDir, "stages", stage, "units")
	if (existsSync(unitsDir)) {
		for (const f of readdirSync(unitsDir).filter(
			(f) => f.startsWith("unit-") && f.endsWith(".md"),
		)) {
			allGates.push(...parseGates(join(unitsDir, f)))
		}
	}

	// Deduplicate by command+dir (same command in different dirs is legitimate in monorepos)
	const seen = new Set<string>()
	const uniqueGates = allGates.filter((g) => {
		const key = `${g.command}::${g.dir}`
		if (seen.has(key)) return false
		seen.add(key)
		return true
	})

	// Execute each gate. Timeout is 120s by default — monorepo test suites
	// regularly push past 30s (e.g. `npm test --workspaces` on this repo
	// clocks ~40s real time). Override with `HAIKU_QUALITY_GATE_TIMEOUT_MS`
	// for environments that need longer runs. 500-char output truncation
	// keeps failure payloads scoped to what the agent needs to see.
	const gateTimeoutMs = (() => {
		const raw = process.env.HAIKU_QUALITY_GATE_TIMEOUT_MS
		const parsed = raw ? Number.parseInt(raw, 10) : NaN
		return Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000
	})()
	const failures: QualityGateResult[] = []
	for (let i = 0; i < uniqueGates.length; i++) {
		const gate = uniqueGates[i]
		const cwd = gate.dir ? resolve(repoRoot, gate.dir) : repoRoot
		let output = ""
		let exitCode = 0

		try {
			output = execSync(gate.command, {
				cwd,
				encoding: "utf8",
				timeout: gateTimeoutMs,
				stdio: ["pipe", "pipe", "pipe"],
			})
		} catch (err: unknown) {
			const execErr = err as {
				status?: number
				stdout?: string
				stderr?: string
				signal?: string
			}
			exitCode = execErr.status ?? 1
			const timedOut = execErr.signal === "SIGTERM"
			const rawOut = (execErr.stdout ?? "") + (execErr.stderr ?? "")
			const prefix = timedOut
				? `[timeout after ${gateTimeoutMs}ms — command killed with SIGTERM]\n`
				: ""
			output = (prefix + rawOut).slice(0, 500)
		}

		if (exitCode !== 0) {
			failures.push({
				name: gate.name || `gate-${i}`,
				command: gate.command,
				dir: gate.dir,
				exit_code: exitCode,
				output,
			})
		}
	}

	return failures
}

// ── Action types ───────────────────────────────────────────────────────────

export interface OrchestratorAction {
	action: string
	[key: string]: unknown
}

// ── FSM side-effect helpers ────────────────────────────────────────────────

/**
 * Resolve the effective branching mode for a given stage.
 * Returns "discrete" or "continuous".
 *
 * Special case: stages with an `external` review gate are always isolated to
 * their own stage branch regardless of the intent's mode. This prevents
 * multiple external-review PRs from stacking on a shared intent main branch —
 * each external-gated stage opens a distinct PR from its own
 * `haiku/{slug}/{stage}` branch back to the intent main branch.
 */
/** Find the previous completed stage for branch chaining */
function findPreviousStage(slug: string, stage: string): string | undefined {
	const intentFile = join(intentDir(slug), "intent.md")
	const intent = readFrontmatter(intentFile)
	const studio = (intent.studio as string) || ""
	const studioStages = resolveIntentStages(intent, studio)
	const idx = studioStages.indexOf(stage)
	return idx > 0 ? studioStages[idx - 1] : undefined
}

export function fsmStartStage(slug: string, stage: string): void {
	const intentFile = join(intentDir(slug), "intent.md")

	// Branch isolation first — if this fails (merge conflict), no state is mutated.
	// Unified topology (continuous and discrete intents share the same branching
	// mechanism): every stage runs on its own branch `haiku/<slug>/<stage>`, and
	// `haiku/<slug>/main` is the consolidation hub. Stage advance A → B:
	//   1. Ensure main exists.
	//   2. Guard 3 (pre-stage cleanup): delete any merged stage branches that
	//      shouldn't still exist — e.g. a prior stage whose work is on main
	//      but whose branch lingered because an earlier session crashed.
	//   3. If prev stage branch A exists and isn't merged, merge A → main.
	//   4. Reap A's branch (its commits now live on main). Delete on remote too.
	//   5. Checkout B: if B's branch already exists (go-back), merge main forward
	//      into it; otherwise create B from main.
	//   6. Guard 1 (entry pos-0 reset): write pos-0 default state.json onto main
	//      for the entered stage via temp worktree. After the stage-branch
	//      checkout merges main forward, this reset is visible on the stage
	//      branch too. The local state.json write below keeps the currently
	//      checked-out branch in sync with main's pos-0 for this tick.
	//   7. Guard 3 (post-stage cleanup): scan again for any orphans that slipped
	//      through the merge-reap cycle.
	// The intent's `mode` field controls other concerns (how the agent iterates,
	// review cadence) but not the branching topology — both modes branch per-stage.
	createIntentBranch(slug)

	// Guard 3 (pre-stage): sweep orphan stage branches before touching anything.
	cleanupOrphanedStageBranches(slug)

	const prevStage = findPreviousStage(slug, stage)
	const prevStageBranch = prevStage ? `haiku/${slug}/${prevStage}` : ""
	if (
		prevStage &&
		branchExists(prevStageBranch) &&
		!isBranchMerged(prevStageBranch, `haiku/${slug}/main`)
	) {
		const mergeResult = mergeStageBranchIntoMain(slug, prevStage)
		if (!mergeResult.success) {
			throw new Error(
				`Merge of completed stage '${prevStage}' into main failed: ${mergeResult.message}. Resolve conflicts on 'haiku/${slug}/main' manually, then retry.`,
			)
		}
	}

	// Reap the previous stage branch locally + push-delete remote so we don't
	// accumulate one dead branch per completed stage.
	if (prevStage && branchExists(prevStageBranch)) {
		deleteStageBranch(slug, prevStage)
		// Best-effort remote delete — don't crash if offline/no push perms.
		try {
			execFileSync("git", ["push", "origin", "--delete", prevStageBranch], {
				stdio: "pipe",
			})
		} catch {
			/* non-fatal */
		}
	}

	// Guard 1 (entry pos-0 reset on main): write the stage's default state.json
	// onto main before we switch branches. This is the authoritative reset;
	// downstream readers can trust main's copy even if a stage branch's local
	// snapshot is stale.
	const posZeroState = {
		stage,
		status: "active",
		phase: "elaborate",
		started_at: timestamp(),
		completed_at: null,
		gate_entered_at: null,
		gate_outcome: null,
		visits: 0,
	}
	const stageStateRelPath = `.haiku/intents/${slug}/stages/${stage}/state.json`
	writeOnIntentMain(
		slug,
		stageStateRelPath,
		`${JSON.stringify(posZeroState, null, 2)}\n`,
		`haiku: reset ${stage} state.json to pos 0 on stage entry (Guard 1)`,
	)

	if (!isOnStageBranch(slug, stage)) {
		const stageBranch = `haiku/${slug}/${stage}`
		if (branchExists(stageBranch) && prevStage) {
			// Stage branch already exists (go-back scenario) — merge main forward
			const mergeResult = mergeStageBranchForward(slug, "main", stage)
			if (!mergeResult.success) {
				throw new Error(
					`Merge forward from main to '${stage}' failed: ${mergeResult.message}. Resolve conflicts on branch '${stageBranch}' manually, then retry.`,
				)
			}
		} else {
			createStageBranch(slug, stage)
		}
	}

	// Mirror the pos-0 reset onto the local (now stage-branch) state file.
	// Guard 1 already wrote main; this keeps the checked-out copy coherent for
	// the rest of this tick without waiting for a subsequent merge-forward.
	const path = stageStatePath(slug, stage)
	writeJson(path, posZeroState)

	// Open the first iteration every time the stage is entered — Guard 1 wipes
	// the state so there's always exactly one fresh iteration on entry.
	appendStageIteration(slug, stage, { trigger: "initial" })

	if (existsSync(intentFile)) {
		setFrontmatterField(intentFile, "active_stage", stage)
	}

	// Guard 3 (post-stage): sweep again after the stage-branch checkout in
	// case the prior delete didn't clean up every merged remote.
	cleanupOrphanedStageBranches(slug)

	emitTelemetry("haiku.stage.started", { intent: slug, stage })
	gitCommitState(`haiku: start stage ${stage}`)
	sealIntentState(slug)
}

export function fsmAdvancePhase(
	slug: string,
	stage: string,
	toPhase: string,
): void {
	const path = stageStatePath(slug, stage)
	const data = readJson(path)
	data.phase = toPhase
	writeJson(path, data)
	emitTelemetry("haiku.stage.phase", { intent: slug, stage, phase: toPhase })
	sealIntentState(slug)
}

export function fsmCompleteStage(
	slug: string,
	stage: string,
	gateOutcome: string,
): void {
	const path = stageStatePath(slug, stage)
	const data = readJson(path)
	data.status = "completed"
	data.completed_at = timestamp()
	data.gate_outcome = gateOutcome
	writeJson(path, data)
	// Close the current iteration as advanced/rejected so the history is
	// self-describing even for stages that only ran a single pass.
	closeCurrentStageIteration(
		slug,
		stage,
		gateOutcome === "advanced" ? "advanced" : "rejected",
	)
	emitTelemetry("haiku.stage.completed", {
		intent: slug,
		stage,
		gate_outcome: gateOutcome,
	})
	gitCommitState(`haiku: complete stage ${stage}`)
	sealIntentState(slug)
}

export function fsmAdvanceStage(
	slug: string,
	currentStage: string,
	nextStage: string,
): void {
	// Complete current stage
	fsmCompleteStage(slug, currentStage, "advanced")

	// Update intent's active_stage to next. Must happen before fsmStartStage
	// runs its own frontmatter write so the seal covers the final value.
	const intentFile = join(intentDir(slug), "intent.md")
	if (existsSync(intentFile)) {
		setFrontmatterField(intentFile, "active_stage", nextStage)
	}

	// Atomic advance: immediately enter the next stage in the same tick.
	// This merges the completed stage branch into intent main, reaps it, and
	// creates/resets the next stage branch — all before run_next returns.
	// Without this, the FSM leaves dirty state on the completed branch while
	// the next tick's `ensureOnStageBranch` guard checks out intent main
	// (ops branch doesn't exist yet → fall back to main) via an auto-commit
	// WIP detour, stranding the advance on a branch that never gets merged.
	// fsmStartStage is idempotent w.r.t. pos-0 state — it will overwrite
	// whatever was there with the fresh default.
	fsmStartStage(slug, nextStage)

	// Reseal: fsmCompleteStage sealed against active_stage=currentStage,
	// then fsmStartStage rewrote frontmatter again; the prior checksums are
	// stale and verifyIntentState() would false-positive as tampering.
	sealIntentState(slug)
}

function fsmGateAsk(slug: string, stage: string): void {
	const path = stageStatePath(slug, stage)
	const data = readJson(path)
	data.phase = "gate"
	data.gate_entered_at = timestamp()
	writeJson(path, data)
	emitTelemetry("haiku.gate.entered", { intent: slug, stage })
	sealIntentState(slug)
}

/**
 * Enter the intent-completion-review phase. Stage work is done; the intent
 * awaits a terminal review before completion. This is the bookend that
 * prevents a stage-level auto-gate from silently completing the whole
 * intent. Users can opt out by setting `skip_intent_completion_review:
 * true` on intent frontmatter.
 *
 * Note: distinct from the existing `intent_review` gate_context which
 * fires at the FIRST stage's elaborate→execute gate to review initial
 * specs. This one fires at the END, after the final stage's gate passes.
 */
function fsmEnterIntentCompletionReview(slug: string): void {
	const intentFile = join(intentDir(slug), "intent.md")
	if (!existsSync(intentFile)) return
	setFrontmatterField(intentFile, "phase", "awaiting_completion_review")
	setFrontmatterField(intentFile, "completion_review_entered_at", timestamp())
	emitTelemetry("haiku.intent.completion_review_entered", { intent: slug })
	sealIntentState(slug)
}

/**
 * Merge the just-completed final stage's branch into intent main, reap
 * the stage branch (local + remote), and switch the current checkout
 * to intent main.
 *
 * Mirror of the prev-stage merge+reap that `fsmStartStage` runs on
 * every non-final stage transition. There's no next stage to trigger
 * that merge when the final stage completes — without this, the
 * primary worktree stays parked on the dead stage branch, intent
 * main misses the final stage's commits, and intent-completion work
 * (studio-level review + fix loop + final gate) runs on stale
 * state.
 *
 * Best-effort: merge conflicts don't throw. The completion-review
 * phase still opens so a human can diagnose + reconcile manually
 * rather than blocking the intent forever on an unresolved merge.
 */
function fsmFinalizeStageIntoIntentMain(slug: string, stage: string): void {
	if (!isGitRepo()) return
	if (!stage) return
	const stageBranch = `haiku/${slug}/${stage}`
	const intentMain = `haiku/${slug}/main`

	if (branchExists(stageBranch) && !isBranchMerged(stageBranch, intentMain)) {
		const mergeResult = mergeStageBranchIntoMain(slug, stage)
		if (!mergeResult.success) {
			console.error(
				`[fsmFinalizeStageIntoIntentMain] merge ${stageBranch}→${intentMain} failed: ${mergeResult.message}.\nIntent-completion review will still open; resolve the merge manually before approving the final gate.\nRecovery paths for the stage branch if the reap below loses it before you can merge:\n  - \`git reflog show ${stageBranch}\` — the branch's tip is still in reflog until gc runs (default 90 days).\n  - \`origin/${stageBranch}\` — if the branch was pushed, the remote tracking ref still has the tip.\n  - \`git fsck --lost-found\` — catches dangling commits even after the branch ref is deleted.`,
			)
			// Intentionally don't return — still try to switch to main so
			// at least subsequent operations run against the correct
			// branch. If the merge half-landed, the switch itself may
			// also fail; the caller can detect and surface.
		}
	}

	if (branchExists(stageBranch)) {
		deleteStageBranch(slug, stage)
		// Best-effort remote delete — same pattern as fsmStartStage's
		// prev-stage reap.
		try {
			execFileSync("git", ["push", "origin", "--delete", stageBranch], {
				stdio: "pipe",
			})
		} catch {
			/* non-fatal: offline, no push perms, or branch already gone */
		}
	}

	// Land the primary worktree on intent main. `ensureOnStageBranch`
	// with stage=undefined resolves the target to intent main.
	ensureOnStageBranch(slug, undefined)
}

/**
 * Shared completion path used by every gate-pass site that used to call
 * `fsmIntentComplete` + return `intent_complete` directly. Returns the
 * correct action for the current opt-in/opt-out state:
 *   - skip_intent_completion_review = true → fire intent_complete as before
 *   - otherwise → enter completion-review phase, open a gate_review
 *
 * This decouples stage-gate approval from intent completion. Stages
 * approving (auto or otherwise) must NEVER by themselves mark an intent
 * completed — the terminal review is a separate, explicit step.
 */
export function completeOrReviewIntent(
	slug: string,
	studio: string,
	sourceMessage: string,
): OrchestratorAction {
	const intentFile = join(intentDir(slug), "intent.md")
	const intent = existsSync(intentFile) ? readFrontmatter(intentFile) : {}
	// Opt-OUT: the studio-level intent-completion review is on by default.
	// Authors can disable it per-intent with `intent_completion_review: false`
	// on intent frontmatter — useful for tight delivery loops, legacy
	// intents predating the review layer, or studios without reviewers.
	// Absent field = enabled. The goal is to measure findings over time:
	// if the studio-level review consistently produces fewer findings, the
	// specs and stage-level reviews upstream have gotten sharper.
	const reviewOnCompletion = intent.intent_completion_review !== false

	// Final-stage branch cleanup: fsmAdvanceStage does this atomically
	// mid-intent via fsmStartStage(nextStage), but when the *final*
	// stage completes there's no nextStage to drive it — the branch
	// sits on disk, intent main misses the final-stage commits, and
	// our worktree stays parked on a dead branch. Intent-completion
	// work (studio review + fix loop + final gate) should always
	// happen on intent main, so merge + reap + switch here.
	const finalStage =
		typeof intent.active_stage === "string"
			? (intent.active_stage as string)
			: ""
	if (finalStage) {
		fsmFinalizeStageIntoIntentMain(slug, finalStage)
	}

	if (!reviewOnCompletion) {
		fsmIntentComplete(slug)
		return {
			action: "intent_complete",
			intent: slug,
			studio,
			message: sourceMessage,
		}
	}
	fsmEnterIntentCompletionReview(slug)
	// Next `haiku_run_next` tick enters the `awaiting_completion_review`
	// handler, which dispatches studio-level review agents (if any),
	// orchestrates the intent-scope fix loop, and only opens the final
	// gate_review once every finding is closed or rejected. We don't
	// jump straight to gate_review here — the extra hop lets the
	// studio-level review layer run before the user sees the gate.
	return {
		action: "advance_phase",
		intent: slug,
		stage: null,
		from_phase: (intent.phase as string) || "active",
		to_phase: "awaiting_completion_review",
		message: `${sourceMessage} All stages passed — entering intent-completion review phase. Call \`haiku_run_next { intent: "${slug}" }\` to dispatch studio-level review agents (if any) and the final gate.`,
	}
}

/**
 * Orchestrate the intent-scope adversarial review layer. Fires only when
 * `intent_completion_review: true` is set on the intent AND the phase is
 * `awaiting_completion_review`. Mirrors the stage-level fix loop in
 * structure: dispatch review agents once, then loop through findings via
 * studio fix-hats until every finding is closed or rejected, then open
 * the human gate. Cross-stage findings (upstream_stage != null) are
 * SURFACED — this layer explicitly forbids auto-revisiting stages.
 */
function runIntentCompletionReview(
	slug: string,
	studio: string,
	intent: Record<string, unknown>,
): OrchestratorAction {
	const intentFile = join(intentDir(slug), "intent.md")

	// Classify pending intent-scope feedback. Findings here were authored
	// by studio-level review agents; `stage: ""` in the storage path.
	const allFeedback = readFeedbackFiles(slug, "")

	// Reconcile studio-level fix-chain worktrees from the prior tick.
	// Closed findings merge back into intent main; conflicts route to the
	// integrator (capped at MAX_INTEGRATOR_ATTEMPTS); anything else is
	// reaped. Mirrors the stage-level reconciliation in run_next's gate
	// handler.
	const pendingIntegrationIC: Array<{
		feedback_id: string
		feedback_title: string
		feedback_file: string
		worktree: string
		branch: string
		conflict_files: string[]
		attempt: number
	}> = []
	const exhaustedIntegrationIC: Array<{
		feedback_id: string
		title: string
		attempts: number
	}> = []
	if (isGitRepo()) {
		for (const fb of allFeedback) {
			const wtPath = fixChainWorktreePath(slug, "intent", fb.id)
			if (!existsSync(wtPath)) continue
			const isClosed =
				fb.status === "closed" ||
				fb.status === "addressed" ||
				fb.status === "rejected" ||
				!!fb.closed_by
			if (!isClosed) {
				cleanupFixChainWorktree(slug, "intent", fb.id)
				emitTelemetry("haiku.intent_fix_chain.cleaned", {
					intent: slug,
					feedback_id: fb.id,
				})
				continue
			}

			const res = mergeFixChainWorktree(slug, "intent", fb.id)
			if (res.success) {
				emitTelemetry("haiku.intent_fix_chain.merged", {
					intent: slug,
					feedback_id: fb.id,
				})
				continue
			}

			if (!res.isConflict) {
				console.error(
					`[haiku] intent fix-chain merge failed for ${fb.id}: ${res.message}. Leaving worktree in place; next tick will retry.`,
				)
				continue
			}

			// fb.file is repo-relative (e.g. `.haiku/intents/.../feedback/NN.md`)
			// so it joins from process.cwd(), NOT findHaikuRoot() — findHaikuRoot
			// already returns `<cwd>/.haiku` which would double the prefix.
			const fbAbsPath = join(process.cwd(), fb.file)
			const { data: fbFM } = parseFrontmatter(readFileSync(fbAbsPath, "utf8"))
			const prevAttempts = Number(
				(fbFM as { integrator_attempts?: number }).integrator_attempts ?? 0,
			)
			const nextAttempt = prevAttempts + 1
			setFrontmatterField(fbAbsPath, "integrator_attempts", nextAttempt)
			if (nextAttempt > MAX_INTEGRATOR_ATTEMPTS) {
				exhaustedIntegrationIC.push({
					feedback_id: fb.id,
					title: fb.title,
					attempts: nextAttempt - 1,
				})
				emitTelemetry("haiku.intent_integrator.exhausted", {
					intent: slug,
					feedback_id: fb.id,
					attempts: String(nextAttempt - 1),
				})
			} else {
				pendingIntegrationIC.push({
					feedback_id: fb.id,
					feedback_title: fb.title,
					feedback_file: fb.file,
					worktree: wtPath,
					branch: fixChainBranchName(slug, "intent", fb.id),
					conflict_files: res.conflictFiles || [],
					attempt: nextAttempt,
				})
				emitTelemetry("haiku.intent_integrator.dispatched", {
					intent: slug,
					feedback_id: fb.id,
					attempt: String(nextAttempt),
				})
			}
		}
	}

	if (exhaustedIntegrationIC.length > 0) {
		const target = exhaustedIntegrationIC[0]
		return {
			action: "escalate",
			intent: slug,
			stage: null,
			reason: "integrator_cap_exceeded",
			iteration: target.attempts,
			max_iterations: MAX_INTEGRATOR_ATTEMPTS,
			message: `Intent-scope fix-chain for ${target.feedback_id} ("${target.title}") still has unresolved merge conflicts after ${target.attempts} integrator attempt(s). Automated conflict resolution failed. ${exhaustedIntegrationIC.length - 1 > 0 ? `${exhaustedIntegrationIC.length - 1} other chain(s) are also exhausted. ` : ""}Resolve manually inside the fix-chain worktrees, commit, then run \`haiku_run_next\`.`,
			pending_items: exhaustedIntegrationIC.map((e) => ({
				feedback_id: e.feedback_id,
				title: e.title,
			})),
		}
	}

	if (pendingIntegrationIC.length > 0) {
		gitCommitState(
			`haiku: integrate_fix_chains dispatch ${pendingIntegrationIC.length} conflict(s) at intent scope`,
		)
		return {
			action: "integrate_fix_chains",
			intent: slug,
			studio,
			stage: null,
			scope: "intent",
			max_attempts: MAX_INTEGRATOR_ATTEMPTS,
			items: pendingIntegrationIC,
			message: `Intent-completion fix-chain merges hit conflicts on ${pendingIntegrationIC.length} finding(s). Dispatching the integrator subagent per chain to resolve in-place.`,
		}
	}

	const pendingItems = allFeedback.filter((item) => {
		if (item.closed_by) return false
		return (
			item.status !== "closed" &&
			item.status !== "addressed" &&
			item.status !== "rejected"
		)
	})

	// Upstream findings at the intent layer are advisory — a studio-level
	// reviewer flagging a specific stage must be surfaced to the human.
	// We NEVER auto-revisit stages from this layer (that's the whole point
	// of the "surface, don't route" contract for cross-stage findings).
	const upstreamItems = pendingItems.filter(
		(item) => item.upstream_stage !== null,
	)
	if (upstreamItems.length > 0) {
		emitTelemetry("haiku.intent.upstream_finding_surfaced", {
			intent: slug,
			count: String(upstreamItems.length),
		})
		return {
			action: "upstream_finding_surfaced",
			intent: slug,
			studio,
			stage: null,
			upstream_items: upstreamItems.map((item) => ({
				feedback_id: item.id,
				title: item.title,
				status: item.status,
				origin: item.origin,
				author: item.author,
				file: item.file,
				upstream_stage: item.upstream_stage as string,
			})),
			message: `Intent '${slug}' has ${upstreamItems.length} cross-stage finding(s) from the studio-level review. These will NOT be auto-fixed. Present them to the user; they can revisit upstream via \`haiku_revisit\`, reject via \`haiku_feedback_reject\`, or accept manually. Do NOT call \`haiku_run_next\` until the user decides.`,
		}
	}

	// Dispatch the studio-level review agents exactly once per completion
	// phase. The flag lives on the intent frontmatter so a post-fix-loop
	// re-tick doesn't re-dispatch the agents — they already flagged their
	// concerns; the fix loop addresses them.
	const reviewDispatched =
		(intent.completion_review_dispatched as boolean) === true
	if (!reviewDispatched) {
		const agentPaths = readStudioReviewAgentPaths(studio)
		if (Object.keys(agentPaths).length === 0) {
			// No studio-level agents → skip straight to the gate so we don't
			// loop forever in this phase. Mark dispatched so the next tick
			// sees no pending + dispatched=true and opens the gate.
			setFrontmatterField(intentFile, "completion_review_dispatched", true)
			setFrontmatterField(intentFile, "completion_review_skipped", true)
			sealIntentState(slug)
		} else {
			setFrontmatterField(intentFile, "completion_review_dispatched", true)
			setFrontmatterField(
				intentFile,
				"completion_review_dispatched_at",
				timestamp(),
			)
			sealIntentState(slug)
			emitTelemetry("haiku.intent.completion_review_dispatched", {
				intent: slug,
				agents: String(Object.keys(agentPaths).length),
			})
			return {
				action: "intent_completion_review",
				intent: slug,
				studio,
				agents: Object.keys(agentPaths),
				message: `Dispatching ${Object.keys(agentPaths).length} studio-level review agent(s) for intent '${slug}'. Each reviews the whole-intent artifacts and logs findings at intent scope via \`haiku_feedback\` (with stage omitted).`,
			}
		}
	}

	// Pending in-scope findings → dispatch studio fix hat sequence
	const inScopePending = pendingItems.filter(
		(item) => item.upstream_stage === null,
	)
	if (inScopePending.length > 0) {
		const fixHatPaths = readStudioFixHatPaths(studio)
		const fixHatNames = Object.keys(fixHatPaths)
		if (fixHatNames.length === 0) {
			return {
				action: "error",
				intent: slug,
				message: `Intent '${slug}' has ${inScopePending.length} pending intent-scope finding(s) but studio '${studio}' defines no fix-hats in \`plugin/studios/${studio}/fix-hats/\`. Either add fix hats, reject the findings, or close them manually.`,
			}
		}

		// Partition: eligible (under bolt cap) vs escalated. Deterministic
		// ordering so re-entries are stable. Batch-dispatch all eligible in
		// parallel chains — conflict risk is accepted, each chain's final
		// hat validates closure independently.
		const sortedScope = [...inScopePending].sort((a, b) => a.num - b.num)
		const eligibleScope = sortedScope.filter((i) => i.bolt < MAX_FIX_LOOP_BOLTS)
		const escalatedScope = sortedScope.filter(
			(i) => i.bolt >= MAX_FIX_LOOP_BOLTS,
		)

		if (eligibleScope.length === 0 && escalatedScope.length > 0) {
			const target = escalatedScope[0]
			emitTelemetry("haiku.intent.fix_loop_escalate", {
				intent: slug,
				feedback_id: target.id,
				bolt: String(target.bolt),
			})
			return {
				action: "escalate",
				intent: slug,
				stage: null,
				reason: "fix_loop_cap_exceeded",
				iteration: target.bolt,
				max_iterations: MAX_FIX_LOOP_BOLTS,
				message:
					`Intent-scope feedback ${target.id} ("${target.title}") has exceeded the fix-loop cap of ${MAX_FIX_LOOP_BOLTS} bolts. Present the finding to the user; they can reject, edit, or close it manually. ${escalatedScope.length - 1 > 0 ? `${escalatedScope.length - 1} other finding(s) are also blocked at the cap.` : ""}`.trim(),
				pending_items: escalatedScope.map((i) => ({
					feedback_id: i.id,
					title: i.title,
					status: i.status,
					origin: i.origin,
					author: i.author,
					file: i.file,
				})),
			}
		}

		// Allocate an isolation worktree per intent-scope chain (scope =
		// "intent"), forked off intent main. Same rationale as the stage
		// fix loop: parallel chains cannot clobber each other, and no
		// chain can accidentally commit on a foreign branch.
		const dispatchedScope: {
			feedback_id: string
			feedback_file: string
			feedback_title: string
			bolt: number
			worktree: string | null
			branch: string | null
		}[] = []
		for (const item of eligibleScope) {
			const bumped = incrementFeedbackBolt(slug, "", item.id)
			if (!bumped) continue
			const wt = createFixChainWorktree(slug, "intent", item.id)
			dispatchedScope.push({
				feedback_id: item.id,
				feedback_file: item.file,
				feedback_title: item.title,
				bolt: bumped.bolt,
				worktree: wt,
				branch: wt ? fixChainBranchName(slug, "intent", item.id) : null,
			})
		}

		if (dispatchedScope.length === 0) {
			return {
				action: "error",
				intent: slug,
				message: `Failed to increment fix-loop bolts on any of ${eligibleScope.length} eligible intent-scope finding(s) — feedback files may have been deleted mid-tick.`,
			}
		}

		gitCommitState(
			`haiku: intent_completion_fix dispatch ${dispatchedScope.length} finding(s)`,
		)
		emitTelemetry("haiku.intent.completion_fix_dispatch", {
			intent: slug,
			count: String(dispatchedScope.length),
			escalated: String(escalatedScope.length),
		})
		return {
			action: "intent_completion_fix",
			intent: slug,
			studio,
			fix_hats: fixHatNames,
			max_bolts: MAX_FIX_LOOP_BOLTS,
			items: dispatchedScope,
			total_pending: inScopePending.length,
			escalated_count: escalatedScope.length,
			message: `Dispatching intent-completion fix loop for ${dispatchedScope.length} finding(s) in parallel. Per-finding studio fix-hats: ${fixHatNames.join(" → ")} (serial within chain). Chains run in parallel.${escalatedScope.length > 0 ? ` ${escalatedScope.length} additional finding(s) are at the bolt cap and will escalate after these complete.` : ""}`,
		}
	}

	// All findings resolved (or none produced) → open the human gate. This
	// is the terminal bookend; `fsmIntentComplete` only fires after
	// approval.
	return {
		action: "gate_review",
		intent: slug,
		studio,
		stage: null,
		gate_type: "ask",
		gate_context: "intent_completion",
		message: `Intent '${slug}' has passed all stages and all studio-level review checks${(intent.completion_review_skipped as boolean) ? " (no studio-level reviewers configured)" : ""}. Opening final review gate.`,
	}
}

export function fsmIntentComplete(slug: string): void {
	const intentFile = join(intentDir(slug), "intent.md")
	if (existsSync(intentFile)) {
		setFrontmatterField(intentFile, "status", "completed")
		setFrontmatterField(intentFile, "completed_at", timestamp())
	}
	emitTelemetry("haiku.intent.completed", { intent: slug })
	gitCommitState(`haiku: complete intent ${slug}`)

	// Fan the last stage (and any unmerged prior stages) into intent main,
	// checkout intent main, and reap every merged stage branch so the intent
	// lands on a single clean ref — no stale haiku/<slug>/<stage> branches
	// left behind.
	const intent = existsSync(intentFile) ? readFrontmatter(intentFile) : {}
	const studio = (intent.studio as string) || ""
	const stages = studio ? resolveIntentStages(intent, studio) : []
	if (stages.length > 0) {
		const finalized = finalizeIntentBranches(slug, stages)
		if (!finalized.success) {
			console.error(
				`[haiku] finalizeIntentBranches warning for ${slug}: ${finalized.message}`,
			)
		}
	}
	// Any orphaned unit worktrees from mid-stage bolts go with it.
	cleanupIntentWorktrees(slug)
	sealIntentState(slug)
}

// ── Main orchestration function ────────────────────────────────────────────

export function runNext(slug: string): OrchestratorAction {
	const root = findHaikuRoot()
	const iDir = join(root, "intents", slug)
	const intentFile = join(iDir, "intent.md")

	if (!existsSync(intentFile)) {
		return { action: "error", message: `Intent '${slug}' not found` }
	}

	// Tamper detection: verify FSM state wasn't modified via direct file writes.
	// Only active for hookless harnesses (Claude Code/Kiro have guard-fsm-fields hook).
	const tamperError = verifyIntentState(slug)
	if (tamperError) {
		return { action: "error", message: tamperError }
	}

	const intent = readFrontmatter(intentFile)
	const studio = (intent.studio as string) || ""

	// No studio selected yet — agent must call haiku_select_studio
	if (!studio) {
		// Include available studios so the agent can present them conversationally
		// even if elicitation is unavailable (e.g., cowork mode)
		const available = listStudios().map((s) => ({
			name: s.name,
			slug: s.slug,
			aliases: s.aliases,
			description: s.description,
			category: s.category,
		}))
		return {
			action: "select_studio",
			intent: slug,
			available_studios: available,
			message: `Intent '${slug}' has no studio selected. Call haiku_select_studio { intent: "${slug}" } to choose a lifecycle studio.`,
		}
	}

	const status = (intent.status as string) || "active"
	const activeStage = (intent.active_stage as string) || ""
	const intentPhase = (intent.phase as string) || "active"

	// Intent is in the final-completion-review phase. Before opening the
	// human-facing gate, we run the studio-level adversarial review:
	//   1. If review agents exist and haven't dispatched yet → dispatch them
	//   2. If their findings produced pending intent-scope feedback → loop
	//      through the studio-level fix hats (one finding per tick) until
	//      every finding is closed or rejected
	//   3. Only then open the gate_review UI for human approval
	//
	// This is the symmetric intent-scope counterpart of the stage-level
	// fix loop: same review → fix → re-review mechanics, different scope
	// (intent-wide artifacts, studio-level hats with studio-wide mandates).
	if (intentPhase === "awaiting_completion_review" && status !== "completed") {
		return runIntentCompletionReview(slug, studio, intent)
	}

	if (status === "completed") {
		return {
			action: "complete",
			message: `Intent '${slug}' is already completed`,
		}
	}

	if (status === "archived") {
		return {
			action: "error",
			message: `Intent '${slug}' has status: archived (legacy/terminal). haiku_intent_unarchive only clears the new \`archived\` field — it does not touch \`status\`. To recover, run \`/haiku:repair\` or manually edit \`.haiku/intents/${slug}/intent.md\` and set \`status: active\`.`,
		}
	}

	if (intent.archived === true) {
		return {
			action: "error",
			message: `Intent '${slug}' is archived. Call haiku_intent_unarchive to restore it.`,
		}
	}

	// Composite intent handling
	if (intent.composite) {
		return runNextComposite(slug, intent, iDir)
	}

	const allStudioStages = resolveStudioStages(studio)
	if (allStudioStages.length === 0) {
		return { action: "error", message: `Studio '${studio}' has no stages` }
	}

	// Resolve effective stages: honors `intent.stages` as an allow-list (used
	// by /haiku:quick to restrict a multi-stage studio to a single stage) and
	// `intent.skip_stages` as a deny-list. Either, both, or neither.
	const studioStages = resolveIntentStages(intent, studio)

	// Determine current stage — with consistency check
	let currentStage = activeStage
	if (!currentStage) {
		currentStage = studioStages[0]
	}

	// Consistency check: verify all stages before active_stage are completed.
	// If not, either synthesize completion records (safe repair) or reset to
	// the first incomplete stage. Safe repair triggers when the active stage
	// has real work (units) — this indicates a migrated intent where earlier
	// stages were never elaborated. Resetting backwards would force
	// re-elaboration of empty stages while real work sits in a later stage.
	const activeIdx = studioStages.indexOf(currentStage)
	if (activeIdx > 0) {
		// Collect all incomplete prior stages in one pass
		const incompletePrior: string[] = []
		for (let i = 0; i < activeIdx; i++) {
			const prevState = readJson(
				join(iDir, "stages", studioStages[i], "state.json"),
			)
			const prevStatus = (prevState.status as string) || "pending"
			if (prevStatus !== "completed") {
				incompletePrior.push(studioStages[i])
			}
		}

		if (incompletePrior.length > 0) {
			// Check if the active stage has real work — units on disk
			const activeUnitsDir = join(iDir, "stages", currentStage, "units")
			const activeUnitFiles = existsSync(activeUnitsDir)
				? readdirSync(activeUnitsDir).filter((f) => f.endsWith(".md"))
				: []

			if (activeUnitFiles.length > 0) {
				// ── Safe intent repair ──────────────────────────────────────
				// The active stage has real work but earlier stages are incomplete.
				// This is a migration artifact (e.g., AIDLC → H·AI·K·U migration
				// that only populated the development stage). Synthesize completion
				// records for incomplete prior stages so the FSM can proceed without
				// forcing re-elaboration of empty stages.
				//
				// Safety constraints:
				// 1. Only synthesizes for stages with NO units (truly empty)
				//    — stages with units but incomplete status are left for manual review
				// 2. Uses the same completion record format as haiku_repair
				// 3. The agent cannot trigger this — it's FSM-internal
				// 4. No hook bypass — this runs inside haiku_run_next

				const synthesized: string[] = []
				const needsManualReview: string[] = []
				const now = timestamp()
				const intentStarted =
					(intent.started_at as string) || (intent.created_at as string) || now

				for (const stageName of incompletePrior) {
					const priorUnitsDir = join(iDir, "stages", stageName, "units")
					const priorUnitFiles = existsSync(priorUnitsDir)
						? readdirSync(priorUnitsDir).filter((f) => f.endsWith(".md"))
						: []

					if (priorUnitFiles.length > 0) {
						// Stage has units but isn't completed — this needs manual attention
						needsManualReview.push(stageName)
					} else {
						// Truly empty prior stage — safe to synthesize completion
						const stageDir = join(iDir, "stages", stageName)
						mkdirSync(stageDir, { recursive: true })
						const statePath = join(stageDir, "state.json")
						writeJson(statePath, {
							stage: stageName,
							status: "completed",
							phase: "gate",
							started_at: intentStarted,
							completed_at: intentStarted,
							gate_entered_at: null,
							gate_outcome: "advanced",
						})
						synthesized.push(stageName)
					}
				}

				// Check if the active stage's units need input backfill.
				// If the stage is in execute phase but units lack inputs, regress
				// to elaborate so the normal backpressure can enforce input declarations.
				const activeStageState = readJson(
					join(iDir, "stages", currentStage, "state.json"),
				)
				const activePhase = (activeStageState.phase as string) || ""
				let phaseRegressed = false
				const missingInputs: string[] = []
				if (activePhase === "execute") {
					for (const f of activeUnitFiles) {
						const fm = readFrontmatter(join(activeUnitsDir, f))
						const unitStatus = (fm.status as string) || ""
						if (["completed", "skipped", "failed"].includes(unitStatus))
							continue
						const inputs =
							(fm.inputs as string[]) || (fm.refs as string[]) || []
						if (inputs.length === 0) missingInputs.push(f)
					}
					if (missingInputs.length > 0) {
						// Regress phase to elaborate so validateUnitInputs catches this
						activeStageState.phase = "elaborate"
						writeJson(
							join(iDir, "stages", currentStage, "state.json"),
							activeStageState,
						)
						phaseRegressed = true
					}
				}

				if (synthesized.length > 0 || phaseRegressed) {
					gitCommitState(
						`haiku: safe-repair ${slug} — synthesize ${synthesized.join(", ")}${phaseRegressed ? "; regress phase to elaborate" : ""}`,
					)
				}

				emitTelemetry("haiku.fsm.safe_repair", {
					intent: slug,
					active_stage: currentStage,
					synthesized_stages: synthesized.join(","),
					needs_manual_review: needsManualReview.join(","),
					phase_regressed: String(phaseRegressed),
				})

				// If all incomplete stages were synthesized, proceed normally
				// by falling through to the rest of runNext. If any need manual
				// review, return an action so the agent can report the situation.
				if (needsManualReview.length > 0) {
					return {
						action: "safe_intent_repair",
						intent: slug,
						studio,
						stage: currentStage,
						synthesized_stages: synthesized,
						needs_manual_review: needsManualReview,
						phase_regressed: phaseRegressed,
						units_missing_inputs: missingInputs,
						message: `Intent '${slug}' was in an inconsistent state — work exists in '${currentStage}' but earlier stages were incomplete.\n\n${synthesized.length > 0 ? `Synthesized completion records for empty stages: [${synthesized.join(", ")}]\n` : ""}Stages needing manual review (have units but aren't completed): [${needsManualReview.join(", ")}]\n${phaseRegressed ? `\nAdditionally, phase was regressed from 'execute' to 'elaborate' because some units are missing \`inputs:\` declarations.\n` : ""}Resolve these stages manually, then call haiku_run_next again.`,
					}
				}

				// All prior stages synthesized — if phase was regressed, let the
				// agent know so it can address missing inputs before execution.
				// Otherwise fall through to normal processing.
				if (phaseRegressed) {
					return {
						action: "safe_intent_repair",
						intent: slug,
						studio,
						stage: currentStage,
						synthesized_stages: synthesized,
						needs_manual_review: [],
						phase_regressed: true,
						units_missing_inputs: missingInputs,
						message: `Intent '${slug}' repaired — synthesized completion for [${synthesized.join(", ")}]. Phase regressed from 'execute' to 'elaborate' because some units are missing \`inputs:\` declarations. Add inputs to the flagged units, then call haiku_run_next to proceed.`,
					}
				}

				// Clean repair with no phase regression — fall through to normal
				// runNext processing. The agent doesn't need to take special action.
			} else {
				// No units in the active stage — normal consistency reset.
				// The intent may have been corrupted or active_stage set incorrectly.
				currentStage = incompletePrior[0]
				setFrontmatterField(intentFile, "active_stage", currentStage)
				emitTelemetry("haiku.fsm.consistency_fix", {
					intent: slug,
					stale_stage: activeStage,
					corrected_stage: currentStage,
				})
			}
		}
	}

	// If current stage is no longer in the effective stage list (either
	// explicitly skipped or excluded by `intent.stages` allow-list), hop
	// forward to the next included stage.
	const effectiveStageSet = new Set(studioStages)
	if (!effectiveStageSet.has(currentStage)) {
		const idx = allStudioStages.indexOf(currentStage)
		const next = allStudioStages
			.slice(idx + 1)
			.find((s) => effectiveStageSet.has(s))
		if (!next) {
			return completeOrReviewIntent(
				slug,
				studio,
				`All remaining stages in intent '${slug}' are skipped.`,
			)
		}
		currentStage = next
	}

	// Load stage state
	const stageState = readJson(join(iDir, "stages", currentStage, "state.json"))
	const phase = (stageState.phase as string) || ""
	const stageStatus = (stageState.status as string) || "pending"

	// Stage not started yet
	if (!phase || stageStatus === "pending") {
		const hats = resolveStageHats(studio, currentStage)
		const follows = (intent.follows as string) || ""
		const parentKnowledge: string[] = []
		if (follows && currentStage === studioStages[0]) {
			// First stage of a follow-up intent — surface parent knowledge
			const parentKnowledgeDir = join(root, "intents", follows, "knowledge")
			if (existsSync(parentKnowledgeDir)) {
				parentKnowledge.push(
					...readdirSync(parentKnowledgeDir).filter((f) => f.endsWith(".md")),
				)
			}
		}

		// FSM side effect: start the stage
		try {
			fsmStartStage(slug, currentStage)
		} catch (err) {
			return {
				action: "error",
				message: err instanceof Error ? err.message : String(err),
			}
		}

		return {
			action: "start_stage",
			intent: slug,
			studio,
			stage: currentStage,
			hats,
			phase: "elaborate",
			stage_metadata: resolveStageMetadata(studio, currentStage),
			...(follows ? { follows, parent_knowledge: parentKnowledge } : {}),
			message: follows
				? `Start stage '${currentStage}' — this intent follows '${follows}'. Load parent knowledge before elaborating.`
				: `Start stage '${currentStage}' — elaborate the work into units`,
		}
	}

	// Stage in elaboration phase
	if (phase === "elaborate" || phase === "decompose") {
		const unitsDir = join(iDir, "stages", currentStage, "units")
		const hasUnits =
			existsSync(unitsDir) &&
			readdirSync(unitsDir).filter((f) => f.endsWith(".md")).length > 0

		// Legacy cleanup: pre-execute stages must have no feedback files.
		// Intents created before pre-exec-feedback was removed may have FB
		// files left over. Wipe them here so the invariant holds and the
		// FSM never re-enters stale pre-review code paths.
		const cleanedPreExecFb = cleanupPreExecuteFeedback(iDir, currentStage)
		if (cleanedPreExecFb.length > 0) {
			console.error(
				`[haiku] cleaned ${cleanedPreExecFb.length} legacy pre-execute feedback file(s) from ${slug}/${currentStage}: ${cleanedPreExecFb.join(", ")}`,
			)
		}

		// Read elaboration mode from STAGE.md
		const pluginRoot = resolvePluginRoot()
		let elaborationMode = "collaborative"
		for (const base of [
			join(process.cwd(), ".haiku", "studios"),
			join(pluginRoot, "studios"),
		]) {
			const stageFile = join(base, studio, "stages", currentStage, "STAGE.md")
			if (existsSync(stageFile)) {
				const fm = readFrontmatter(stageFile)
				elaborationMode = (fm.elaboration as string) || "collaborative"
				break
			}
		}

		// Track elaboration turns for collaborative enforcement
		const elaborationTurns = (stageState.elaboration_turns as number) || 0
		const updatedTurns = elaborationTurns + 1
		writeJson(join(iDir, "stages", currentStage, "state.json"), {
			...stageState,
			elaboration_turns: updatedTurns,
		})

		// ── Discovery worktree reconciliation ─────────────────────────────
		// Before emitting the elaborate action, merge any discovery worktrees
		// allocated on a prior tick. Subagents wrote their artifacts inside
		// those worktrees; we need to land the artifacts on the stage branch
		// so the parent can read them for unit decomposition.
		//
		// Merge conflicts route to the integrator via `integrate_fix_chains`
		// (same flow as fix-chain conflicts). The parent dispatches
		// integrator subagents per conflicting worktree; the next run_next
		// sees MERGE_HEAD + clean resolution and forward-merges.
		if (isGitRepo()) {
			const discoveryTemplates: string[] = []
			{
				const seen = new Set<string>()
				for (const base of [...studioSearchPaths()].reverse()) {
					const discoveryDir = join(
						base,
						studio,
						"stages",
						currentStage,
						"discovery",
					)
					if (!existsSync(discoveryDir)) continue
					for (const f of readdirSync(discoveryDir).filter((f) =>
						f.endsWith(".md"),
					)) {
						if (seen.has(f)) continue
						seen.add(f)
						discoveryTemplates.push(f.replace(/\.md$/i, "").toLowerCase())
					}
				}
			}

			const pendingDiscoveryIntegration: Array<{
				feedback_id: string
				feedback_title: string
				feedback_file: string
				worktree: string
				branch: string
				conflict_files: string[]
				attempt: number
			}> = []
			const exhaustedDiscoveryIntegration: Array<{
				feedback_id: string
				title: string
				attempts: number
			}> = []
			for (const template of discoveryTemplates) {
				const wtPath = discoveryWorktreePath(slug, currentStage, template)
				if (!existsSync(wtPath)) continue
				const res = mergeDiscoveryWorktree(slug, currentStage, template)
				if (res.success) {
					emitTelemetry("haiku.discovery.merged", {
						intent: slug,
						stage: currentStage,
						template,
					})
					continue
				}
				if (!res.isConflict) {
					console.error(
						`[haiku] discovery merge failed for ${template}: ${res.message}. Leaving worktree; next tick will retry.`,
					)
					continue
				}
				// Track per-template integrator attempts in stage state since
				// discovery templates don't have feedback files to annotate.
				const attemptKey = `discovery_${template}_integrator_attempts`
				const stateOnDisk = readJson(
					join(iDir, "stages", currentStage, "state.json"),
				)
				const prevAttempts = Number(
					(stateOnDisk as Record<string, unknown>)[attemptKey] ?? 0,
				)
				const nextAttempt = prevAttempts + 1
				writeJson(join(iDir, "stages", currentStage, "state.json"), {
					...stateOnDisk,
					[attemptKey]: nextAttempt,
				})
				if (nextAttempt > MAX_INTEGRATOR_ATTEMPTS) {
					exhaustedDiscoveryIntegration.push({
						feedback_id: `DISC-${template}`,
						title: `discovery artifact: ${template}`,
						attempts: nextAttempt - 1,
					})
				} else {
					pendingDiscoveryIntegration.push({
						feedback_id: `DISC-${template}`,
						feedback_title: `discovery artifact: ${template}`,
						feedback_file: `(discovery template ${template})`,
						worktree: wtPath,
						branch: discoveryBranchName(slug, currentStage, template),
						conflict_files: res.conflictFiles || [],
						attempt: nextAttempt,
					})
				}
			}

			if (exhaustedDiscoveryIntegration.length > 0) {
				const target = exhaustedDiscoveryIntegration[0]
				return {
					action: "escalate",
					intent: slug,
					stage: currentStage,
					reason: "integrator_cap_exceeded",
					iteration: target.attempts,
					max_iterations: MAX_INTEGRATOR_ATTEMPTS,
					message: `Discovery worktree ${target.feedback_id} still has unresolved conflicts after ${target.attempts} integrator attempts. Resolve manually inside the worktree, commit, then run \`haiku_run_next\`.`,
					pending_items: exhaustedDiscoveryIntegration.map((e) => ({
						feedback_id: e.feedback_id,
						title: e.title,
					})),
				}
			}

			if (pendingDiscoveryIntegration.length > 0) {
				gitCommitState(
					`haiku: integrate_fix_chains dispatch ${pendingDiscoveryIntegration.length} discovery conflict(s) in ${currentStage}`,
				)
				return {
					action: "integrate_fix_chains",
					intent: slug,
					studio,
					stage: currentStage,
					scope: currentStage,
					max_attempts: MAX_INTEGRATOR_ATTEMPTS,
					items: pendingDiscoveryIntegration,
					message: `Discovery worktree merges hit conflicts on ${pendingDiscoveryIntegration.length} artifact(s) in stage '${currentStage}'. Dispatching the integrator per worktree.`,
				}
			}
		}

		// ── Re-entry iterative elaborate ───────────────────────────────────
		// When the stage is entered with pre-existing completed units (e.g.
		// a fresh fsmStartStage after intent iteration, or the user coming
		// back through a stage that was previously finished), do NOT skip
		// elaborate. Completed units are knowledge, not rework. Emit an
		// iterative-mode elaborate action so the agent:
		//   - sees the completed units as context
		//   - decides whether the intent has evolved enough to warrant new
		//     units, revisions to pending units, or no changes at all
		//   - signals "no changes needed" by calling run_next without adding
		//     new units — the FSM detects the no-op on the second tick
		//     (elaboration_turns > 1 with no pending units) and advances
		//     directly to the gate (skips pre_review + execute).
		//
		// Detection uses the `elaboration_turns` counter (already persisted
		// for collaborative enforcement) + the unit census. No separate
		// snapshot fields — they were fragile against downstream writes
		// that reintroduced the old values via `{...stageState, ...}`.
		//
		// State machine (iteration === 1 only — iteration > 1 takes the
		// additive-elaborate path below with `closes:` validation):
		//   pendingUnits > 0                         → normal flow (user
		//                                              has pending work
		//                                              already drafted)
		//   completedUnits > 0, pendingUnits === 0:
		//     updatedTurns === 1 (this tick is 1st)  → emit iterative
		//     updatedTurns > 1 (2nd+ tick)           → no-op, advance to gate
		const existingUnits = hasUnits ? listUnits(iDir, currentStage) : []
		const completedUnitsList = existingUnits.filter(
			(u) => u.status === "completed",
		)
		const pendingUnitsList = existingUnits.filter(
			(u) => u.status !== "completed",
		)
		const iterativeEntryIteration = getStageIterationCount(stageState)

		if (
			iterativeEntryIteration === 1 &&
			completedUnitsList.length > 0 &&
			pendingUnitsList.length === 0
		) {
			if (updatedTurns === 1) {
				// First tick of this iteration — agent hasn't been given a
				// decision point yet. Emit the iterative-mode elaborate
				// action so the agent can either draft new units or call
				// run_next to signal no-op.
				return {
					action: "elaborate",
					intent: slug,
					studio,
					stage: currentStage,
					elaboration: elaborationMode,
					iteration: iterativeEntryIteration,
					visits: iterativeEntryIteration,
					iterative: true,
					completed_units: completedUnitsList.map((u) => u.name),
					pending_units: pendingUnitsList.map((u) => u.name),
					stage_metadata: resolveStageMetadata(studio, currentStage),
					message: `Re-entering stage '${currentStage}' with ${completedUnitsList.length} completed unit(s) from prior iteration(s). Treat completed work as knowledge; decide whether this iteration needs new or modified units.`,
				}
			}
			// Second+ tick with no pending units added — agent declared
			// no-op (option C from the decision block). Nothing new to
			// review or execute for this iteration. Skip straight to the
			// gate so the human can approve or request changes.
			fsmAdvancePhase(slug, currentStage, "gate")
			return {
				action: "advance_phase",
				intent: slug,
				studio,
				stage: currentStage,
				from_phase: "elaborate",
				to_phase: "gate",
				message: `No new units needed for this iteration of '${currentStage}' — advancing directly to the gate.`,
			}
		}

		if (!hasUnits) {
			return {
				action: "elaborate",
				intent: slug,
				studio,
				stage: currentStage,
				elaboration: elaborationMode,
				stage_metadata: resolveStageMetadata(studio, currentStage),
				message: `Elaborate stage '${currentStage}' into units with completion criteria`,
			}
		}

		// ── Additive elaborate mode (iteration > 1, post-execute only) ─────
		// Fires ONLY when we're revisiting a stage after real work has landed
		// (at least one unit completed). Pre-execute stages — even on
		// iteration > 1 — go through the plain elaborate path: edit the
		// existing unstarted unit specs directly, no `closes:` requirement,
		// no per-feedback validation. Nothing has been built, so there is no
		// feedback model to enforce.
		const iteration = getStageIterationCount(stageState)
		if (iteration > 1 && !isStagePreExecute(iDir, currentStage)) {
			const allUnits = listUnits(iDir, currentStage)
			const completedUnits = allUnits.filter((u) => u.status === "completed")
			const pendingUnits = allUnits.filter((u) => u.status !== "completed")
			const pendingFeedback = readFeedbackFiles(slug, currentStage).filter(
				(item) => item.status === "pending",
			)

			// Shared payload for every revisit-mode elaborate return
			const basePayload = {
				action: "elaborate" as const,
				intent: slug,
				studio,
				stage: currentStage,
				elaboration: elaborationMode,
				iteration,
				visits: iteration, // legacy alias
				completed_units: completedUnits.map((u) => u.name),
				pending_feedback: pendingFeedback.map(summarizeFeedback),
				stage_metadata: resolveStageMetadata(studio, currentStage),
			}

			// Validate closes: fields on any in-flight (non-completed) units
			const validFeedbackIds = new Set(pendingFeedback.map((f) => f.id))
			const unitsWithoutCloses: string[] = []
			const invalidCloseRefs: Array<{ unit: string; ref: string }> = []

			for (const u of pendingUnits) {
				const unitFile = join(
					iDir,
					"stages",
					currentStage,
					"units",
					`${u.name}.md`,
				)
				if (!existsSync(unitFile)) continue
				const fm = readFrontmatter(unitFile)
				const closes = (fm.closes as string[]) || []
				if (closes.length === 0) {
					unitsWithoutCloses.push(u.name)
				} else {
					for (const ref of closes) {
						if (!validFeedbackIds.has(ref)) {
							invalidCloseRefs.push({ unit: u.name, ref })
						}
					}
				}
			}

			// Case 1: new units written but missing closes: fields
			if (pendingUnits.length > 0 && unitsWithoutCloses.length > 0) {
				const validation_error = `New units missing \`closes:\` field: ${unitsWithoutCloses.join(", ")}. Every new unit in a revisit cycle MUST declare \`closes: [FB-NN]\` referencing the feedback items it addresses.`
				return {
					...basePayload,
					validation_error,
					message: buildElaboratorInstruction({
						visits: iteration,
						pendingFeedbackCount: pendingFeedback.length,
						stage: currentStage,
						situation: `Validation error: ${validation_error}`,
					}),
				}
			}

			// Case 2: closes: references that don't match any feedback id
			if (invalidCloseRefs.length > 0) {
				const validation_error = `Invalid \`closes:\` references: ${invalidCloseRefs.map((r) => `${r.unit} → ${r.ref}`).join(", ")}. References must match existing pending feedback IDs.`
				return {
					...basePayload,
					validation_error,
					message: buildElaboratorInstruction({
						visits: iteration,
						pendingFeedbackCount: pendingFeedback.length,
						stage: currentStage,
						situation: `Validation error: ${validation_error}`,
					}),
				}
			}

			// Case 3: orphaned feedback — some pending items have no unit closing them
			if (pendingUnits.length > 0 && pendingFeedback.length > 0) {
				const closedFeedbackIds = new Set<string>()
				for (const u of pendingUnits) {
					const unitFile = join(
						iDir,
						"stages",
						currentStage,
						"units",
						`${u.name}.md`,
					)
					if (!existsSync(unitFile)) continue
					const fm = readFrontmatter(unitFile)
					const closes = (fm.closes as string[]) || []
					for (const ref of closes) closedFeedbackIds.add(ref)
				}
				const orphaned = pendingFeedback.filter(
					(f) => !closedFeedbackIds.has(f.id),
				)
				if (orphaned.length > 0) {
					const validation_error = `Orphaned feedback — not referenced by any unit's \`closes:\` field: ${orphaned.map((f) => `${f.id}: ${f.title}`).join("; ")}. Create units for these or reject the feedback items.`
					return {
						...basePayload,
						validation_error,
						message: buildElaboratorInstruction({
							visits: iteration,
							pendingFeedbackCount: pendingFeedback.length,
							stage: currentStage,
							situation: `Validation error: ${validation_error}`,
						}),
					}
				}
			}

			// Case 4: post-elab gate predicate — pending feedback with no in-flight units
			// (FB-09: this is the only true block; closes-presence / orphan checks above
			// complement it when the agent is mid-elaboration)
			if (pendingUnits.length === 0 && pendingFeedback.length > 0) {
				return {
					...basePayload,
					message: buildElaboratorInstruction({
						visits: iteration,
						pendingFeedbackCount: pendingFeedback.length,
						stage: currentStage,
					}),
				}
			}

			// All feedback addressed + units validated — fall through to normal elaborate flow
		}

		// Enforce collaborative elaboration — measure decisions, not turns.
		//
		// The prior turn-count gate (`elaboration_turns < 3`) was Goodhart-prone:
		// agents padded with low-information questions to satisfy the counter.
		// The new gate measures what we actually want — knowledge-unification
		// moments where the human's input shaped the plan, OR an honest
		// declaration that no architectural decisions are in scope. The
		// `elaboration_turns` counter still ticks for telemetry, but it no
		// longer gates advancement.
		if (elaborationMode === "collaborative") {
			const decisionLog = (stageState.decision_log as unknown[]) || []
			const noDecisionsDeclared = stageState.elaboration_no_decisions === true
			if (decisionLog.length === 0 && !noDecisionsDeclared) {
				return {
					action: "elaboration_insufficient",
					intent: slug,
					stage: currentStage,
					turns: updatedTurns,
					decisions_recorded: decisionLog.length,
					message: `Collaborative elaboration advances when (a) at least one decision has been recorded in the stage's \`decision_log\` via \`haiku_decision_record\`, OR (b) you have honestly declared that no architectural decisions are in scope via \`haiku_decision_record { no_decisions: true, rationale: "..." }\`. ${updatedTurns} turn(s) so far, 0 decisions recorded. A decision is a real architectural choice between concrete options — either user-resolved (the user picked) or autonomous-acknowledged (you chose and surfaced the choice for veto-style approval, the user did not push back). Padding questions don't count. If the work is genuinely conventional with no choices to make, declare no_decisions=true with a rationale.`,
				}
			}
		}

		// Units exist — validate DAG for unresolved deps and cycles
		{
			const unitsDir = join(iDir, "stages", currentStage, "units")
			const unitFiles = readdirSync(unitsDir).filter((f) => f.endsWith(".md"))
			const nodeIds = new Set(unitFiles.map((f) => f.replace(".md", "")))
			const dagNodes = unitFiles.map((f) => {
				const fm = readFrontmatter(join(unitsDir, f))
				return {
					id: f.replace(".md", ""),
					status: (fm.status as string) || "pending",
				}
			})
			const dagEdges: Array<{ from: string; to: string }> = []
			const dagAdj = new Map<string, string[]>()
			for (const n of dagNodes) dagAdj.set(n.id, [])

			const unresolvedDeps: Array<{ unit: string; dep: string }> = []
			for (const f of unitFiles) {
				const fm = readFrontmatter(join(unitsDir, f))
				const id = f.replace(".md", "")
				for (const dep of (fm.depends_on as string[]) || []) {
					if (nodeIds.has(dep)) {
						dagEdges.push({ from: dep, to: id })
						dagAdj.get(dep)?.push(id)
					} else {
						unresolvedDeps.push({ unit: id, dep })
					}
				}
			}

			if (unresolvedDeps.length > 0) {
				return {
					action: "unresolved_dependencies",
					intent: slug,
					stage: currentStage,
					unresolvedDeps,
					message: `${unresolvedDeps.length} depends_on reference(s) don't match any unit filename:\n\n${unresolvedDeps.map((d) => `- \`${d.unit}\` depends on \`${d.dep}\` — not found`).join("\n")}\n\nValid unit slugs: ${[...nodeIds].join(", ")}\ndepends_on must use the full filename without .md (e.g., \`unit-01-data-model\`, not \`data-model\`).\n\nFix the depends_on fields, then call \`haiku_run_next { intent: "${slug}" }\` again.`,
				}
			}

			try {
				topologicalSort({ nodes: dagNodes, edges: dagEdges, adjacency: dagAdj })
			} catch (err) {
				if (
					err instanceof Error &&
					err.message.includes("Circular dependency")
				) {
					return {
						action: "dag_cycle_detected",
						intent: slug,
						stage: currentStage,
						message: `${err.message}. Fix the depends_on fields in the unit files to remove the cycle, then call haiku_run_next again.`,
					}
				}
			}
		}

		// Validate unit file naming before allowing execution
		const namingViolation = validateUnitNaming(iDir, currentStage)
		if (namingViolation) return namingViolation

		// Validate discovery artifacts exist before advancing
		const discoveryViolation = validateDiscoveryArtifacts(
			slug,
			currentStage,
			studio,
		)
		if (discoveryViolation) return discoveryViolation

		// Validate all units have declared inputs
		const inputsViolation = validateUnitInputs(iDir, currentStage)
		if (inputsViolation) return inputsViolation

		// Note: adversarial review of elaboration specs is included in the gate_review
		// instructions. The gate review handler opens the review UI which shows specs
		// and lets the user approve or request changes. No separate review_elaboration
		// step — it was causing a redundant haiku_run_next round-trip.

		// Check if the stage requires a design direction selection before proceeding.
		// Read the STAGE.md body — if it mentions pick_design_direction (RFC 2119 MUST),
		// enforce that design_direction_selected is set in state.json.
		const designDirectionSelected =
			stageState.design_direction_selected as boolean
		if (!designDirectionSelected) {
			const stageMetaForDesign = resolveStageMetadata(studio, currentStage)
			if (stageMetaForDesign?.body?.includes("pick_design_direction")) {
				return {
					action: "design_direction_required",
					intent: slug,
					studio,
					stage: currentStage,
					message:
						"This stage requires a design direction selection before proceeding. Call pick_design_direction with wireframe variants — the state will be updated automatically when the user selects a direction.",
				}
			}
		}

		// Validate unit naming and types across ALL stages — catch legacy issues from before validation existed
		const stagesDir = join(iDir, "stages")
		if (existsSync(stagesDir)) {
			for (const stageEntry of readdirSync(stagesDir, { withFileTypes: true })
				.filter((e) => e.isDirectory())
				.sort((a, b) => a.name.localeCompare(b.name))) {
				if (stageEntry.name === currentStage) continue // already validated above
				const crossNaming = validateUnitNaming(iDir, stageEntry.name)
				if (crossNaming) return crossNaming
			}
		}

		// ── Pre-execution adversarial review (2026-04-19) ────────────────
		//
		// Before advancing elaborate → execute, run adversarial review
		// against the unit SPECS (not artifacts — those don't exist yet).
		// Catches: missing inputs, unfalsifiable criteria, sibling conflicts,
		// prose-only gates. Fixing spec bugs BEFORE execute avoids the much
		// larger cost of execute → post-review → reject cycles.
		//
		// State machine (two-pass):
		//   First pass  (no dispatch flag): emit `pre_review` action; flag
		//     set so agent runs reviewers once.
		//   Second pass (flag set, pending feedback): emit `pre_review_revisit`
		//     with spec-edit instructions.
		//   Second pass (flag set, no pending feedback): fall through to
		//     normal execute advance.
		{
			const preReviewDispatched = stageState.pre_review_dispatched as boolean

			if (!preReviewDispatched) {
				// Skip pre-review if no applicable review agents exist — avoids
				// spurious pre_review actions on stages/studios without agents.
				const agentPaths = filterReviewAgentsByScope(
					readReviewAgentPaths(studio, currentStage),
					join(iDir, "stages", currentStage, "artifacts"),
					{ studio, stage: currentStage },
				)
				if (Object.keys(agentPaths).length === 0) {
					stageState.pre_review_dispatched = true
					stageState.pre_review_dispatched_at = timestamp()
					stageState.pre_review_skipped_no_agents = true
					writeJson(
						join(iDir, "stages", currentStage, "state.json"),
						stageState,
					)
					// Fall through to the normal auto/ask-review path.
				} else {
					stageState.pre_review_dispatched = true
					stageState.pre_review_dispatched_at = timestamp()
					writeJson(
						join(iDir, "stages", currentStage, "state.json"),
						stageState,
					)
					gitCommitState(
						`haiku: dispatch pre-execute review on ${currentStage} unit specs`,
					)
					return {
						action: "pre_review",
						intent: slug,
						studio,
						stage: currentStage,
						units_dir: `.haiku/intents/${slug}/stages/${currentStage}/units/`,
						message:
							"Pre-execute adversarial review of unit SPECS. Spawn conditional review agents against every unit.md file and log findings via haiku_feedback. When all findings are resolved (closed or rejected), call haiku_run_next to advance.",
					}
				}
			}

			// Note: the `pre_review_revisit` path used to fire here when pending
			// feedback existed on pre-exec unit specs. That path was removed —
			// pre-execute reviews (both adversarial and user gate_review) now
			// return findings INLINE in their action payloads, and the agent
			// edits unit specs directly. The `cleanupPreExecuteFeedback` call
			// at the top of this phase handler wipes any stale FB files from
			// legacy intents so the old path can't re-trigger.

			// TOCTOU mitigation for BUG 4 (fast-retry race): if reviewer
			// dispatch was recent AND we see zero pending feedback, reviewer
			// subagents may still be running. Refuse to advance until either
			// a grace window elapses or the agent explicitly confirms
			// reviewers completed by setting
			// `pre_review_reviewers_acknowledged: true` in the stage state.
			//
			// Skipped when pre-review itself was skipped (no applicable
			// agents) — there's no race to guard against if no reviewers
			// were ever dispatched.
			const skippedNoAgents = stageState.pre_review_skipped_no_agents === true
			if (!skippedNoAgents) {
				const dispatchedAtStr =
					typeof stageState.pre_review_dispatched_at === "string"
						? (stageState.pre_review_dispatched_at as string)
						: ""
				const dispatchedAtMs = dispatchedAtStr
					? new Date(dispatchedAtStr).getTime()
					: 0
				const ackd = stageState.pre_review_reviewers_acknowledged === true
				const elapsedMs = dispatchedAtMs
					? Date.now() - dispatchedAtMs
					: Number.POSITIVE_INFINITY
				const GRACE_MS =
					Number.parseInt(process.env.HAIKU_PRE_REVIEW_GRACE_MS ?? "", 10) ||
					15000
				if (!ackd && elapsedMs < GRACE_MS) {
					return {
						action: "pre_review_waiting",
						intent: slug,
						studio,
						stage: currentStage,
						dispatched_at: dispatchedAtStr,
						grace_remaining_ms: Math.max(0, GRACE_MS - elapsedMs),
						message: `Pre-execute review dispatched ${Math.floor(elapsedMs / 1000)}s ago — reviewer subagents may still be running. Wait for all subagents to return, then call haiku_run_next again. (Grace window: ${GRACE_MS}ms; override via HAIKU_PRE_REVIEW_GRACE_MS. To skip the grace window when you're confident reviewers have all returned, set stage state \`pre_review_reviewers_acknowledged: true\`.)`,
					}
				}
				if (!ackd) {
					// Grace elapsed and nobody bumped the ack — treat as
					// implicit acknowledgment and record it, so subsequent
					// calls advance cleanly and audit logs show the state.
					stageState.pre_review_reviewers_acknowledged = true
					stageState.pre_review_reviewers_acknowledged_at = timestamp()
					writeJson(
						join(iDir, "stages", currentStage, "state.json"),
						stageState,
					)
				}
			}
		}

		// All units valid — either auto-advance or open review gate before execution.
		//
		// Spec-gate rule (elaborate → execute boundary):
		//   - Discrete intent mode: ALWAYS ask (every stage's specs get human
		//     sign-off in discrete — matches the per-stage-branch / per-stage
		//     PR model).
		//   - Continuous/hybrid intent mode: ASK unless the stage's own
		//     review type is `auto` — `auto` stages skip both the spec gate
		//     and the stage gate by design (studio trusts the FSM).
		//
		// For the first stage of a fresh intent (not yet reviewed), this gate
		// doubles as the intent review — CC review agents have already run
		// during the review phase, so the user sees validated specs.
		// Note: if the user rejects and the agent revises, this re-presents
		// with intent_review context until intent_reviewed is set to true.
		const intentReviewed = intent.intent_reviewed as boolean
		const isIntentReview = currentStage === studioStages[0] && !intentReviewed
		const stageReviewType = resolveStageReview(studio, currentStage)
		const intentMode = (intent.mode as string) || "continuous"
		const specGateAsks =
			intentMode === "discrete" ? true : stageReviewType !== "auto"

		// Auto gates: skip review UI and advance directly to execution.
		if (!specGateAsks) {
			if (isIntentReview) {
				setFrontmatterField(intentFile, "intent_reviewed", true)
				gitCommitState(`haiku: intent ${slug} auto-approved`)
			}
			fsmAdvancePhase(slug, currentStage, "execute")
			emitTelemetry("haiku.gate.auto_advanced", {
				intent: slug,
				stage: currentStage,
				gate_context: isIntentReview ? "intent_review" : "elaborate_to_execute",
			})
			return {
				action: isIntentReview ? "intent_approved" : "advance_phase",
				intent: slug,
				studio,
				stage: currentStage,
				from_phase: "elaborate",
				to_phase: "execute",
				message: isIntentReview
					? `Auto-gate: intent approved — advancing to execution. Call haiku_run_next { intent: "${slug}" } immediately.`
					: `Auto-gate: specs validated — advancing to execution. Call haiku_run_next { intent: "${slug}" } immediately.`,
			}
		}

		// Non-auto gates: open review UI
		return {
			action: "gate_review",
			intent: slug,
			studio,
			stage: currentStage,
			next_phase: "execute",
			gate_type: "ask",
			gate_context: isIntentReview ? "intent_review" : "elaborate_to_execute",
			message: isIntentReview
				? `Intent '${slug}' specs ready for review — presenting for your approval`
				: "Specs validated — opening review before execution",
		}
	}

	// Stage in execute phase
	if (phase === "execute") {
		// Validate unit naming on every execute call — catch violations that snuck through
		const execNamingViolation = validateUnitNaming(iDir, currentStage)
		if (execNamingViolation) return execNamingViolation

		const units = listUnits(iDir, currentStage)
		const activeUnits = units.filter((u) => u.status === "active")
		const allComplete = units.every((u) => u.status === "completed")

		// Compute waves from the DAG so we only release one wave at a time.
		// A wave completes when all its units are completed; then the next
		// wave's units become ready.
		const { unitWave, totalWaves } = computeUnitWaves(units)
		const wave = currentWaveNumber(units, unitWave, totalWaves)

		// Filter ready units to only those in the current wave
		const readyUnits = units.filter(
			(u) =>
				u.status === "pending" &&
				u.depsComplete &&
				unitWave.get(u.name) === wave,
		)

		if (allComplete) {
			// Pre-gate check: validate required outputs were created
			const outputValidation = validateStageOutputs(slug, currentStage, studio)
			if (outputValidation) return outputValidation

			// FSM side effect: advance phase
			fsmAdvancePhase(slug, currentStage, "review")

			return {
				action: "advance_phase",
				intent: slug,
				stage: currentStage,
				from_phase: "execute",
				to_phase: "review",
				message: `All units complete — begin adversarial review of stage '${currentStage}'`,
			}
		}

		if (activeUnits.length > 0) {
			const worktreeFor = (unitName: string): string | null => {
				const p = join(process.cwd(), ".haiku", "worktrees", slug, unitName)
				return existsSync(p) ? p : null
			}

			// Only serialize when exactly one unit is in-flight. When N units are
			// all active in the same wave, emit a continue_units batch so the
			// parent fans them out in parallel — same as start_units.
			if (activeUnits.length === 1) {
				const unit = activeUnits[0]
				const hats = resolveUnitHatsInStudio(
					studio,
					currentStage,
					slug,
					unit.name,
				)
				return {
					action: "continue_unit",
					intent: slug,
					stage: currentStage,
					unit: unit.name,
					hat: unit.hat,
					bolt: unit.bolt,
					wave: unitWave.get(unit.name) ?? wave,
					total_waves: totalWaves,
					hats,
					worktree: worktreeFor(unit.name),
					stage_metadata: resolveStageMetadata(studio, currentStage),
					message: `Continue unit '${unit.name}' — hat: ${unit.hat}, bolt: ${unit.bolt}, wave: ${unitWave.get(unit.name) ?? wave}/${totalWaves}`,
				}
			}
			const hats = resolveStageHats(studio, currentStage)

			const unitEntries = activeUnits.map((u) => ({
				name: u.name,
				hat: u.hat,
				bolt: u.bolt,
				worktree: worktreeFor(u.name),
			}))
			return {
				action: "continue_units",
				intent: slug,
				studio,
				stage: currentStage,
				wave,
				total_waves: totalWaves,
				hats,
				units: unitEntries,
				stage_metadata: resolveStageMetadata(studio, currentStage),
				message: `Continue ${activeUnits.length} units in parallel: ${activeUnits.map((u) => `${u.name}(${u.hat}#${u.bolt})`).join(", ")}`,
			}
		}

		// Resolve once for unit worktree creation below
		// Units always fork from their stage branch now. The branch-mode
		// distinction lives elsewhere (how the stage itself relates to intent
		// main); unit fan-in is always stage-scoped.

		if (readyUnits.length > 1) {
			// Multiple units ready — create worktrees for parallel execution
			const hats = resolveStageHats(studio, currentStage)
			const unitWorktrees: Record<string, string | null> = {}
			for (const u of readyUnits) {
				unitWorktrees[u.name] = createUnitWorktree(slug, u.name, currentStage)
			}
			return {
				action: "start_units",
				intent: slug,
				studio,
				stage: currentStage,
				wave,
				total_waves: totalWaves,
				units: readyUnits.map((u) => u.name),
				first_hat: hats[0] || "",
				hats,
				worktrees: unitWorktrees,
				stage_metadata: resolveStageMetadata(studio, currentStage),
				message: `Wave ${wave}/${totalWaves} — ${readyUnits.length} units ready for parallel execution: ${readyUnits.map((u) => u.name).join(", ")}`,
			}
		}

		if (readyUnits.length > 0) {
			const unit = readyUnits[0]
			const hats = resolveStageHats(studio, currentStage)
			// Create worktree for solo unit too — all units are isolated
			const worktreePath = createUnitWorktree(slug, unit.name, currentStage)
			return {
				action: "start_unit",
				intent: slug,
				studio,
				stage: currentStage,
				wave,
				total_waves: totalWaves,
				unit: unit.name,
				first_hat: hats[0] || "",
				hats,
				worktree: worktreePath,
				stage_metadata: resolveStageMetadata(studio, currentStage),
				message: `Wave ${wave}/${totalWaves} — start unit '${unit.name}' with hat '${hats[0] || ""}' in stage '${currentStage}'`,
			}
		}

		// All units either completed or blocked
		const blockedUnits = units.filter((u) => u.status !== "completed")
		return {
			action: "blocked",
			intent: slug,
			stage: currentStage,
			wave,
			total_waves: totalWaves,
			blocked_units: blockedUnits.map((u) => u.name),
			message: `${blockedUnits.length} unit(s) blocked — dependencies not met or manual intervention needed`,
		}
	}

	// Stage in review phase
	if (phase === "review") {
		// Secondary output validation — hard check before adversarial review
		const reviewOutputCheck = validateStageOutputs(slug, currentStage, studio)
		if (reviewOutputCheck) return reviewOutputCheck

		// Run quality gates (tests, lint, typecheck) before subjective review agents.
		// If any gate fails, send the agent back to fix them — don't waste review cycles
		// on code that doesn't compile or pass tests.
		const gateFailures = runQualityGates(slug, currentStage)
		if (gateFailures.length > 0) {
			// Stay in review phase — agent must fix and call haiku_run_next again
			return {
				action: "fix_quality_gates",
				intent: slug,
				stage: currentStage,
				failures: gateFailures,
				message: `Quality gate(s) failed — fix before adversarial review:\n\n${gateFailures
					.map(
						(f) =>
							`- **${f.name}**: \`${f.command}\` (exit ${f.exit_code})${f.dir !== "" ? ` in ${f.dir}` : ""}\n  ${f.output.split("\n").slice(0, 5).join("\n  ")}`,
					)
					.join("\n\n")}`,
			}
		}

		// FSM side effect: advance to gate phase so next haiku_run_next call
		// proceeds to gate logic after the agent completes the review work.
		fsmAdvancePhase(slug, currentStage, "gate")

		return {
			action: "review",
			intent: slug,
			studio,
			stage: currentStage,
			message: `Quality gates passed — run adversarial review agents for stage '${currentStage}'`,
		}
	}

	// Note: "persist" phase removed — artifacts are committed during execution
	// via gitCommitState() in MCP state tools (stage_start/complete, unit_start/complete).
	// If phase is "persist" (legacy), treat as gate-ready.
	if (phase === "persist") {
		// FSM side effect: auto-advance to gate
		fsmAdvancePhase(slug, currentStage, "gate")

		return {
			action: "advance_phase",
			intent: slug,
			stage: currentStage,
			from_phase: "persist",
			to_phase: "gate",
			message: "Artifacts already persisted — proceeding to gate",
		}
	}

	// Stage in gate phase — determine whether to auto-advance or open review UI.
	// Gate behavior:
	//   - Discrete intent mode: always "external" (Submit for External Review + Request Changes)
	//   - Continuous/hybrid intent mode: based on the stage's review field
	//     - auto → auto-advance without user interaction (autonomous gate)
	//     - ask → "ask" (Approve + Request Changes)
	//     - external → "external" (Submit for External Review + Request Changes)
	//     - [external, ask] → as-is (Approve + Submit for External Review + Request Changes)
	//     - await → "external" (awaits external event after submission)
	//   Note: continuous intents may have discrete branch isolation for external-review
	//   stages (PR isolation), but the gate options still reflect the stage's review field.
	//
	//   Non-git environments: `external` gates fall back to `ask` because there is no
	//   structural signal (branch merge) to enforce external review. Without git, the
	//   only safe option is local human approval. Compound gates containing `external`
	//   strip it and keep remaining types (e.g., [external, ask] → ask).
	if (phase === "gate") {
		// ── Fix-chain worktree reconciliation ─────────────────────────────
		// A prior `review_fix` dispatch may have allocated per-finding
		// isolation worktrees. Before we decide what to do with the current
		// gate:
		//   - Findings that closed → merge their worktree back. If the merge
		//     conflicts (base advanced under the chain), collect the chain
		//     for integrator dispatch.
		//   - Findings that didn't close → reap the worktree so the next
		//     bolt (if any) starts fresh.
		//
		// If any chains need the integrator, return `integrate_fix_chains`
		// immediately — the integrator resolves the conflict markers
		// in-place, and the next run_next tick picks up `MERGE_HEAD` and
		// forward-merges automatically. Merge conflicts never persist
		// unresolved at the gate.
		//
		// Skip in non-git environments — no worktrees were ever created.
		const pendingIntegration: Array<{
			feedback_id: string
			feedback_title: string
			feedback_file: string
			worktree: string
			branch: string
			conflict_files: string[]
			attempt: number
		}> = []
		const exhaustedIntegration: Array<{
			feedback_id: string
			title: string
			attempts: number
		}> = []
		if (isGitRepo()) {
			const allFeedback = readFeedbackFiles(slug, currentStage)
			for (const fb of allFeedback) {
				const wtPath = fixChainWorktreePath(slug, currentStage, fb.id)
				if (!existsSync(wtPath)) continue
				const isClosed =
					fb.status === "closed" ||
					fb.status === "addressed" ||
					fb.status === "rejected" ||
					!!fb.closed_by
				if (!isClosed) {
					cleanupFixChainWorktree(slug, currentStage, fb.id)
					emitTelemetry("haiku.fix_chain.cleaned", {
						intent: slug,
						stage: currentStage,
						feedback_id: fb.id,
					})
					continue
				}

				const res = mergeFixChainWorktree(slug, currentStage, fb.id)
				if (res.success) {
					emitTelemetry("haiku.fix_chain.merged", {
						intent: slug,
						stage: currentStage,
						feedback_id: fb.id,
					})
					continue
				}

				if (!res.isConflict) {
					console.error(
						`[haiku] fix-chain merge failed for ${fb.id}: ${res.message}. Leaving worktree in place; next tick will retry.`,
					)
					continue
				}

				// Conflict detected — increment integrator attempt counter
				// on the feedback frontmatter and route to the integrator
				// (or escalate if we've already burned the budget).
				// fb.file is repo-relative (e.g. `.haiku/intents/.../feedback/NN.md`)
				// so it joins from process.cwd(), NOT findHaikuRoot() — findHaikuRoot
				// already returns `<cwd>/.haiku` which would double the prefix.
				const fbAbsPath = join(process.cwd(), fb.file)
				const { data: fbFM } = parseFrontmatter(readFileSync(fbAbsPath, "utf8"))
				const prevAttempts = Number(
					(fbFM as { integrator_attempts?: number }).integrator_attempts ?? 0,
				)
				const nextAttempt = prevAttempts + 1
				setFrontmatterField(fbAbsPath, "integrator_attempts", nextAttempt)
				if (nextAttempt > MAX_INTEGRATOR_ATTEMPTS) {
					exhaustedIntegration.push({
						feedback_id: fb.id,
						title: fb.title,
						attempts: nextAttempt - 1,
					})
					emitTelemetry("haiku.integrator.exhausted", {
						intent: slug,
						stage: currentStage,
						feedback_id: fb.id,
						attempts: String(nextAttempt - 1),
					})
				} else {
					pendingIntegration.push({
						feedback_id: fb.id,
						feedback_title: fb.title,
						feedback_file: fb.file,
						worktree: wtPath,
						branch: fixChainBranchName(slug, currentStage, fb.id),
						conflict_files: res.conflictFiles || [],
						attempt: nextAttempt,
					})
					emitTelemetry("haiku.integrator.dispatched", {
						intent: slug,
						stage: currentStage,
						feedback_id: fb.id,
						attempt: String(nextAttempt),
					})
				}
			}
		}

		if (exhaustedIntegration.length > 0) {
			const target = exhaustedIntegration[0]
			return {
				action: "escalate",
				intent: slug,
				stage: currentStage,
				reason: "integrator_cap_exceeded",
				iteration: target.attempts,
				max_iterations: MAX_INTEGRATOR_ATTEMPTS,
				message: `Fix-chain for ${target.feedback_id} ("${target.title}") still has unresolved merge conflicts after ${target.attempts} integrator attempt(s). Automated conflict resolution failed. ${exhaustedIntegration.length - 1 > 0 ? `${exhaustedIntegration.length - 1} other chain(s) are also exhausted. ` : ""}Resolve the conflicts manually inside the fix-chain worktrees (listed below), commit, then run \`haiku_run_next\` — the merge will retry.`,
				pending_items: exhaustedIntegration.map((e) => ({
					feedback_id: e.feedback_id,
					title: e.title,
				})),
			}
		}

		if (pendingIntegration.length > 0) {
			gitCommitState(
				`haiku: integrate_fix_chains dispatch ${pendingIntegration.length} conflict(s) in ${currentStage}`,
			)
			return {
				action: "integrate_fix_chains",
				intent: slug,
				studio,
				stage: currentStage,
				scope: currentStage,
				max_attempts: MAX_INTEGRATOR_ATTEMPTS,
				items: pendingIntegration,
				message: `Fix-chain merges hit conflicts on ${pendingIntegration.length} finding(s) in stage '${currentStage}'. Dispatching the integrator subagent per chain to resolve in-place.`,
			}
		}

		// ── Pending feedback check ─────────────────────────────────────────
		// Before any gate logic, check if there are unresolved feedback items.
		// When pending feedback exists we have three routes, in priority order:
		//   1. Cross-stage findings (upstream_stage != currentStage) are
		//      SURFACED to the human via `upstream_finding_surfaced` — we do
		//      not attempt to fix upstream artifacts with downstream hats.
		//   2. If the stage declares `fix_hats:`, dispatch that sequence
		//      directly against one pending finding via `review_fix`. The
		//      feedback body replaces the unit spec as scope — no new unit
		//      synthesis, no "telephone game" of feedback → unit → execute.
		//   3. Legacy path: no `fix_hats:` → roll back to elaborate and ask
		//      the agent to draft units that close each finding (the
		//      additive-elaboration model that `fix_hats:` is replacing).
		const pendingCount = countPendingFeedback(slug, currentStage)
		if (pendingCount > 0) {
			// Blocking = items countPendingFeedback counts: no closed_by AND
			// status is not closed/addressed/rejected. Stay in sync with
			// countPendingFeedback so count and list never diverge.
			const pendingItems = readFeedbackFiles(slug, currentStage).filter(
				(item) => {
					if (item.closed_by) return false
					return (
						item.status !== "closed" &&
						item.status !== "addressed" &&
						item.status !== "rejected"
					)
				},
			)

			// ── Route 1: cross-stage findings ─────────────────────────────
			// A reviewer in stage X can flag root causes in stage Y — e.g. the
			// design reviewer notices the inception brief assumed a constraint
			// that's actually wrong. We cannot fix that with stage X's hats;
			// the user must decide whether to revisit Y, reject the finding,
			// or accept it. Never auto-revisit upstream without explicit
			// human approval.
			const upstreamItems = pendingItems.filter(
				(item) =>
					item.upstream_stage !== null && item.upstream_stage !== currentStage,
			)
			if (upstreamItems.length > 0) {
				emitTelemetry("haiku.gate.upstream_finding_surfaced", {
					intent: slug,
					stage: currentStage,
					count: String(upstreamItems.length),
				})
				return {
					action: "upstream_finding_surfaced",
					intent: slug,
					studio,
					stage: currentStage,
					upstream_items: upstreamItems.map((item) => ({
						...summarizeFeedback(item),
						upstream_stage: item.upstream_stage as string,
					})),
					message: `Stage '${currentStage}' has ${upstreamItems.length} cross-stage finding(s) whose root cause is in a DIFFERENT stage. These will NOT be auto-fixed by this stage's hats. Present them to the user and ask how to proceed — revisit the upstream stage via \`haiku_revisit\`, reject the finding with \`haiku_feedback_reject\`, or accept as-is. Do NOT call \`haiku_run_next\` until the user decides.`,
				}
			}

			// ── Route 1.5: human-in-the-loop for human-authored feedback ──
			// If ANY pending item is human-authored AND has no explicit
			// `resolution` set, the human hasn't signed off on dispatch.
			// Open the gate review UI instead of auto-firing the fix
			// loop — the reviewer needs to see the items, triage them
			// (pick a resolution per item or leave them for agent
			// triage), then click "Send to agent" which routes through
			// `haiku_revisit` → `feedback_dispatch` (or stage rollback).
			//
			// Agent-authored findings (adversarial-review, studio-review,
			// origin: agent) skip this short-circuit: they're the
			// existing fix-loop contract — find, fix, move on, no human
			// intervention required.
			const needsHumanReview = pendingItems.some(
				(item) =>
					item.author_type === "human" &&
					(!(item as { resolution?: string | null }).resolution ||
						(item as { resolution?: string | null }).resolution === null),
			)
			if (needsHumanReview) {
				const stageIdxForGate = studioStages.indexOf(currentStage)
				const nextStageForGate =
					stageIdxForGate >= 0 && stageIdxForGate < studioStages.length - 1
						? studioStages[stageIdxForGate + 1]
						: null
				fsmGateAsk(slug, currentStage)
				return {
					action: "gate_review",
					intent: slug,
					studio,
					stage: currentStage,
					next_stage: nextStageForGate,
					gate_type: "ask",
					gate_context: "stage_gate",
					message: `Stage '${currentStage}' has ${pendingItems.length} pending feedback item(s), including human-authored comments awaiting triage. Open the review UI so the reviewer can classify each (reply, inline fix, stage revisit, upstream rewind) before the agent dispatches.`,
				}
			}

			// ── Route 1.6: auto-dispatch on explicit rewind-causing resolutions ──
			// If any pending item is explicitly tagged `stage_revisit` or
			// `upstream_rewind`, run_next should just DO the thing — no prose
			// handoff, no "call run_next again." The reviewer (or triage
			// pass) already decided; prompting the agent to dispatch adds
			// a round trip and leaves room for the chain to stall.
			const gateClassification = classifyPendingForRevisit(pendingItems)
			if (gateClassification.stageRevisits.length > 0) {
				// Write a deterministic audit line of which items forced the
				// revisit — a post-revisit trace is the only way to tell from
				// a git log why the stage rolled back.
				const revisitIds = gateClassification.stageRevisits
					.map((it) => it.id)
					.join(", ")
				emitTelemetry("haiku.gate.auto_revisit", {
					intent: slug,
					stage: currentStage,
					feedback_ids: revisitIds,
				})
				return revisitCurrentStage(slug, iDir, intentFile, currentStage)
			}
			if (gateClassification.upstreamRewinds.length > 0) {
				emitTelemetry("haiku.gate.upstream_rewind_surfaced", {
					intent: slug,
					stage: currentStage,
					count: String(gateClassification.upstreamRewinds.length),
				})
				return {
					action: "upstream_finding_surfaced",
					intent: slug,
					studio,
					stage: currentStage,
					upstream_items:
						gateClassification.upstreamRewinds.map(summarizeFeedback),
					message: `Stage '${currentStage}' has ${gateClassification.upstreamRewinds.length} finding(s) tagged \`upstream_rewind\`. Present them to the user and ask which upstream stage to revisit (or whether to reject / accept as-is). Do NOT call \`haiku_run_next\` until the user decides.`,
				}
			}

			// ── Route 2: fix_hats fix loop ────────────────────────────────
			// When the stage declares fix_hats, batch-dispatch the sequence
			// against EVERY eligible (under bolt-cap) pending finding in one
			// tick. Findings run in parallel chains; within a chain, hats run
			// serially (e.g. designer → feedback-assessor). The final fix hat
			// in each chain validates closure and calls haiku_feedback_update
			// status=closed. If a chain fails to close, the assessor leaves
			// status=fixing and the next run_next picks it up with an
			// incremented bolt. Conflict risk: two chains editing the same
			// artifact may overwrite each other — the assessor catches it,
			// the finding stays open, and the next bolt retries. Budget is
			// spent, not lost.
			const fixHats = resolveStageFixHats(studio, currentStage)
			if (fixHats.length > 0 && pendingItems.length > 0) {
				// Ensure each fix-hat has a real mandate file. Fix-mode hats
				// may live outside the primary `hats:` rotation (e.g. a
				// `feedback-assessor` hat that only runs during fix loops),
				// so we check `hats/{hat}.md` existence, not the `hats:`
				// list. A ghost mandate blocks dispatch with a concrete error.
				const hatDefs = readHatDefs(studio, currentStage)
				const missing = fixHats.filter((h) => !hatDefs[h])
				if (missing.length > 0) {
					return {
						action: "error",
						intent: slug,
						message: `Stage '${currentStage}' declares fix_hats: [${fixHats.join(", ")}] but [${missing.join(", ")}] have no mandate file in plugin/studios/<studio>/stages/${currentStage}/hats/. Create the missing files or remove them from fix_hats.`,
					}
				}

				// Partition: eligible (under bolt cap) vs escalated (at/over).
				// Deterministic ordering so re-entries are stable.
				const sorted = [...pendingItems].sort((a, b) => a.num - b.num)
				const eligibleItems = sorted.filter((i) => i.bolt < MAX_FIX_LOOP_BOLTS)
				const escalatedItems = sorted.filter(
					(i) => i.bolt >= MAX_FIX_LOOP_BOLTS,
				)

				// If every remaining finding has already burned its bolt
				// budget, the whole queue is blocked — surface the first
				// escalation to the human. Other escalated items ride along
				// in the pending_items list so visibility isn't lost.
				if (eligibleItems.length === 0 && escalatedItems.length > 0) {
					const target = escalatedItems[0]
					emitTelemetry("haiku.feedback.fix_loop_escalate", {
						intent: slug,
						stage: currentStage,
						feedback_id: target.id,
						bolt: String(target.bolt),
					})
					return {
						action: "escalate",
						intent: slug,
						stage: currentStage,
						reason: "fix_loop_cap_exceeded",
						iteration: target.bolt,
						max_iterations: MAX_FIX_LOOP_BOLTS,
						message:
							`Feedback ${target.id} ("${target.title}") has exceeded the fix-loop cap of ${MAX_FIX_LOOP_BOLTS} bolts. The fix hats cannot resolve this finding autonomously — the finding itself, the spec it's flagging, or the hat mandates likely need human intervention. Present the finding to the user; they can revisit upstream, reject the finding, edit the spec, or mark it resolved manually. ${escalatedItems.length - 1 > 0 ? `${escalatedItems.length - 1} other finding(s) are also blocked at the cap.` : ""}`.trim(),
						pending_items: escalatedItems.map(summarizeFeedback),
					}
				}

				// Increment bolt for every eligible item and build dispatch
				// batch. Items whose increment fails (file deleted mid-tick)
				// are skipped, not fatal — the tick still dispatches the rest.
				//
				// Allocate an isolation worktree per chain so parallel fix
				// subagents can't clobber each other's edits (and can't
				// accidentally commit on a foreign branch — the cwd is
				// pinned to the worktree). Chains run `ops-engineer →
				// feedback-assessor` inside the worktree; the gate's
				// reconciliation pass merges the worktree back into the
				// stage branch when the assessor closes the finding, or
				// reaps it otherwise. No-op (null path) in non-git mode.
				const dispatched: {
					feedback_id: string
					feedback_file: string
					feedback_title: string
					bolt: number
					worktree: string | null
					branch: string | null
				}[] = []
				for (const item of eligibleItems) {
					const bumped = incrementFeedbackBolt(slug, currentStage, item.id)
					if (!bumped) continue
					const wt = createFixChainWorktree(slug, currentStage, item.id)
					dispatched.push({
						feedback_id: item.id,
						feedback_file: item.file,
						feedback_title: item.title,
						bolt: bumped.bolt,
						worktree: wt,
						branch: wt ? fixChainBranchName(slug, currentStage, item.id) : null,
					})
				}

				if (dispatched.length === 0) {
					return {
						action: "error",
						intent: slug,
						message: `Failed to increment fix-loop bolts on any of ${eligibleItems.length} eligible finding(s) — feedback files may have been deleted mid-tick.`,
					}
				}

				gitCommitState(
					`haiku: review_fix dispatch ${dispatched.length} finding(s) in ${currentStage}`,
				)
				emitTelemetry("haiku.gate.review_fix", {
					intent: slug,
					stage: currentStage,
					count: String(dispatched.length),
					escalated: String(escalatedItems.length),
				})
				return {
					action: "review_fix",
					intent: slug,
					studio,
					stage: currentStage,
					fix_hats: fixHats,
					max_bolts: MAX_FIX_LOOP_BOLTS,
					items: dispatched,
					total_pending: pendingItems.length,
					escalated_count: escalatedItems.length,
					message: `Dispatching fix loop for ${dispatched.length} finding(s) in parallel — stage '${currentStage}'. Per-finding hat sequence: ${fixHats.join(" → ")} (serial within chain). Chains run in parallel across findings.${escalatedItems.length > 0 ? ` ${escalatedItems.length} additional finding(s) are at the bolt cap and will escalate after these complete.` : ""}`,
				}
			}

			// ── Route 3: legacy feedback_revisit (no fix_hats) ────────────
			//
			// Iteration accounting must run BEFORE any FSM state writes so the
			// escalation check sees the real iteration count. If we're about
			// to escalate, leave the stage phase as-is (gate/review) — a
			// follow-up haiku_revisit call will then correctly route through
			// revisitCurrentStage (phase != elaborate ⇒ same-stage revisit)
			// instead of falling into the "already in elaborate, jump to
			// previous stage" branch, which was silently flipping active_stage
			// back to the previous stage on every escalation.
			const statePath = stageStatePath(slug, currentStage)
			const iterResult = appendStageIteration(
				slug,
				currentStage,
				{
					trigger: "feedback",
					reason: `${pendingCount} pending feedback item(s)`,
					feedbackTitles: pendingItems.map((i) => i.title),
				},
				"feedback-revisit",
			)
			emitTelemetry("haiku.gate.feedback_revisit", {
				intent: slug,
				stage: currentStage,
				pending_count: String(pendingCount),
				iteration: String(iterResult.count),
			})
			const escalation = maybeEscalate(
				slug,
				currentStage,
				iterResult,
				"feedback",
				pendingItems.map((i) => ({
					feedback_id: i.id,
					title: i.title,
				})),
			)
			if (escalation) {
				gitCommitState(
					`haiku: feedback_revisit escalated in ${currentStage} (${pendingCount} pending, iteration ${iterResult.count})`,
				)
				return escalation
			}

			// Escalation check passed — commit the phase flip so the revisit
			// actually re-enters elaborate with pre-review state reset.
			const gateState = readJson(statePath)
			gateState.phase = "elaborate"
			// Reset pre-review state so post-execute revisits re-audit the
			// (potentially edited) unit specs before re-entering execute.
			gateState.pre_review_dispatched = false
			gateState.pre_review_dispatched_at = null
			gateState.pre_review_skipped_no_agents = false
			gateState.pre_review_reviewers_acknowledged = false
			gateState.pre_review_reviewers_acknowledged_at = null
			writeJson(statePath, gateState)
			gitCommitState(
				`haiku: feedback_revisit in ${currentStage} (${pendingCount} pending, iteration ${iterResult.count})`,
			)
			return {
				action: "feedback_revisit",
				intent: slug,
				studio,
				stage: currentStage,
				pending_count: pendingCount,
				iteration: iterResult.count,
				visits: iterResult.count, // legacy alias — prefer `iteration`
				pending_items: pendingItems.map(summarizeFeedback),
				message: `${pendingCount} pending feedback item(s) found — rolling back to elaborate (iteration ${iterResult.count}). YOU MUST read every feedback file at pending_items[].file in full before elaborating — the body carries the requirements. Address all pending feedback before the gate can advance.`,
			}
		}

		// ── External review state detection ────────────────────────────────
		// If this stage was already completed+blocked (external review submitted),
		// check if the external review state changed (approved / changes_requested)
		// before opening the gate review UI again.
		const gateOutcomeInGate = (stageState.gate_outcome as string) || ""
		if (stageStatus === "completed" && gateOutcomeInGate === "blocked") {
			let extApproved = false
			let externalState: ExternalReviewState = { status: "unknown" }
			const externalUrl = (stageState.external_review_url as string) || ""

			// Tier 1: Branch merge detection
			if (isGitRepo()) {
				const stageBranch = `haiku/${slug}/${currentStage}`
				const mainline = `haiku/${slug}/main`
				if (isBranchMerged(stageBranch, mainline)) {
					extApproved = true
				}
			}

			// Tier 2: URL-based CLI probing
			if (!extApproved && externalUrl) {
				externalState = checkExternalState(externalUrl)
				if (externalState.status === "approved") {
					extApproved = true
				}
			}

			if (extApproved) {
				const statePath = stageStatePath(slug, currentStage)
				const stateData = readJson(statePath)
				stateData.gate_outcome = "advanced"
				writeJson(statePath, stateData)
				emitTelemetry("haiku.gate.resolved", {
					intent: slug,
					stage: currentStage,
					gate_type: "external",
					outcome: "approved",
				})
				// Fall through to advance logic (auto-gate or non-auto gate
				// will see gate_outcome "advanced" and advance the stage)
			} else if (externalState.status === "changes_requested") {
				return handleExternalChangesRequested(
					slug,
					currentStage,
					externalUrl,
					externalState.provider,
				)
			} else if (externalUrl) {
				return {
					action: "awaiting_external_review",
					intent: slug,
					stage: currentStage,
					external_review_url: externalUrl,
					message: `Stage '${currentStage}' is awaiting external review at: ${externalUrl}. Neither branch merge detection nor CLI-based check detected approval yet. Run /haiku:pickup after the review is approved.`,
				}
			}
			// No URL or approval detected via branch merge — fall through to
			// re-show the gate review UI so the user can provide the URL or
			// confirm approval.
		}

		const rawReviewType = resolveStageReview(studio, currentStage)
		// Autopilot promotion: if the intent is in autopilot and the stage's
		// review type is `ask`, treat it as `auto`. External gates are NEVER
		// promoted — they represent structural signals (PR/MR merge) the FSM
		// can't synthesize. Compound gates with external stay external.
		const autopilot = intent.autopilot === true
		const reviewType =
			autopilot && rawReviewType === "ask" ? "auto" : rawReviewType
		const stageIdx = studioStages.indexOf(currentStage)
		const nextStage =
			stageIdx < studioStages.length - 1 ? studioStages[stageIdx + 1] : null

		const gitAvailable = isGitRepo()

		// Auto gates: advance without user interaction.
		// "auto" review type means the studio author trusts the FSM to advance
		// without human approval. Skip the gate UI entirely regardless of mode —
		// discrete mode affects branching strategy, not review type semantics.
		if (reviewType === "auto") {
			emitTelemetry("haiku.gate.auto_advanced", {
				intent: slug,
				stage: currentStage,
				gate_context: "stage_gate",
			})
			if (nextStage) {
				fsmAdvanceStage(slug, currentStage, nextStage)
				return {
					action: "advance_stage",
					intent: slug,
					studio,
					stage: currentStage,
					next_stage: nextStage,
					gate_outcome: "advanced",
					message: `Auto-gate passed — advancing to '${nextStage}'. Call haiku_run_next { intent: "${slug}" } immediately.`,
				}
			}
			fsmCompleteStage(slug, currentStage, "advanced")
			return completeOrReviewIntent(
				slug,
				studio,
				`Auto-gate passed — all stages complete for intent '${slug}'.`,
			)
		}

		// Non-auto gates: open review UI
		let effectiveGateType: string
		if (!gitAvailable && reviewType.includes("external")) {
			// Non-git environment: external gates have no structural signal (no branch
			// merge to detect). Fall back to ask — local human approval is the only
			// safe option. For compound gates like "external,ask", strip external.
			const remaining = reviewType
				.split(",")
				.filter((t) => t !== "external")
				.join(",")
			effectiveGateType = remaining || "ask"
		} else if (reviewType === "ask") {
			effectiveGateType = "ask"
		} else if (reviewType === "await") {
			effectiveGateType = "external"
		} else {
			// Compound gates (e.g., "external,ask") pass through as-is
			effectiveGateType = reviewType
		}

		fsmGateAsk(slug, currentStage)
		return {
			action: "gate_review",
			intent: slug,
			studio,
			stage: currentStage,
			next_stage: nextStage,
			gate_type: effectiveGateType,
			message: `Stage '${currentStage}' complete — opening review`,
		}
	}

	// Stage completed — find next (or wait for external approval)
	if (stageStatus === "completed") {
		const gateOutcome = (stageState.gate_outcome as string) || "advanced"

		// Blocked on external review — check if approved or changes requested
		if (gateOutcome === "blocked") {
			let approved = false
			let externalState: ExternalReviewState = { status: "unknown" }
			const externalUrl = (stageState.external_review_url as string) || ""

			// Tier 1: Branch merge detection (structural, tamper-resistant)
			if (isGitRepo()) {
				const stageBranch = `haiku/${slug}/${currentStage}`
				const mainline = `haiku/${slug}/main`
				if (isBranchMerged(stageBranch, mainline)) {
					approved = true
				}
			}

			// Tier 2: URL-based CLI probing (fallback)
			if (!approved && externalUrl) {
				externalState = checkExternalState(externalUrl)
				if (externalState.status === "approved") {
					approved = true
				}
			}

			if (approved) {
				// External approval detected — advance
				const statePath = stageStatePath(slug, currentStage)
				const stateData = readJson(statePath)
				stateData.gate_outcome = "advanced"
				writeJson(statePath, stateData)
				emitTelemetry("haiku.gate.resolved", {
					intent: slug,
					stage: currentStage,
					gate_type: "external",
					outcome: "approved",
				})
				// Fall through to advance logic below
			} else if (externalState.status === "changes_requested") {
				return handleExternalChangesRequested(
					slug,
					currentStage,
					externalUrl,
					externalState.provider,
				)
			} else {
				return {
					action: "awaiting_external_review",
					intent: slug,
					stage: currentStage,
					...(externalUrl ? { external_review_url: externalUrl } : {}),
					message: externalUrl
						? `Stage '${currentStage}' is awaiting external review at: ${externalUrl}. Neither branch merge detection nor CLI-based check detected approval yet. Run /haiku:pickup after the review is approved.`
						: `Stage '${currentStage}' is awaiting external review but no review URL was recorded. Run /haiku:pickup after the review is approved.`,
				}
			}
		}

		const stageIdx = studioStages.indexOf(currentStage)
		const nextStage =
			stageIdx < studioStages.length - 1 ? studioStages[stageIdx + 1] : null
		if (!nextStage) {
			return completeOrReviewIntent(
				slug,
				studio,
				`All stages approved for intent '${slug}'.`,
			)
		}
		const hats = resolveStageHats(studio, nextStage)

		// FSM side effect: start next stage
		try {
			fsmStartStage(slug, nextStage)
		} catch (err) {
			return {
				action: "error",
				message: err instanceof Error ? err.message : String(err),
			}
		}

		return {
			action: "start_stage",
			intent: slug,
			studio,
			stage: nextStage,
			hats,
			phase: "elaborate",
			stage_metadata: resolveStageMetadata(studio, nextStage),
			message: `Start stage '${nextStage}'`,
		}
	}

	return {
		action: "error",
		message: `Unknown state for stage '${currentStage}' — phase: ${phase}, status: ${stageStatus}`,
	}
}

// ── Composite orchestration ────────────────────────────────────────────────

function runNextComposite(
	slug: string,
	intent: Record<string, unknown>,
	_intentDirPath: string,
): OrchestratorAction {
	const composite = intent.composite as Array<{
		studio: string
		stages: string[]
	}>
	const compositeState = (intent.composite_state || {}) as Record<
		string,
		string
	>
	const syncRules = (intent.sync || []) as Array<{
		wait: string[]
		then: string[]
	}>

	// Find the first runnable studio:stage
	for (const entry of composite) {
		const current = compositeState[entry.studio] || entry.stages[0]
		if (current === "complete") continue
		if (!entry.stages.includes(current)) continue

		// Check sync points
		let blocked = false
		for (const rule of syncRules) {
			for (const thenStage of rule.then) {
				if (thenStage === `${entry.studio}:${current}`) {
					for (const waitStage of rule.wait) {
						const [ws, wst] = waitStage.split(":")
						const wsState = compositeState[ws] || ""
						const wsStages =
							composite.find((c) => c.studio === ws)?.stages || []
						const wsIdx = wsStages.indexOf(wst)
						const currentIdx = wsStages.indexOf(wsState)
						if (currentIdx <= wsIdx) {
							blocked = true
							break
						}
					}
					if (blocked) break
				}
			}
			if (blocked) break
		}

		if (!blocked) {
			return {
				action: "composite_run_stage",
				intent: slug,
				studio: entry.studio,
				stage: current,
				hats: resolveStageHats(entry.studio, current),
				message: `Composite: run '${entry.studio}:${current}'`,
			}
		}
	}

	// Check if all complete
	const allComplete = composite.every(
		(e) => compositeState[e.studio] === "complete",
	)
	if (allComplete) {
		return completeOrReviewIntent(
			slug,
			"composite",
			`All composite studios complete for '${slug}'.`,
		)
	}

	return {
		action: "blocked",
		intent: slug,
		message: "All runnable stages are sync-blocked — waiting for dependencies",
	}
}

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
 * the new invariant (no FB persistence pre-execute) and prevents the FSM
 * from re-triggering old pre-review code paths.
 */
function cleanupPreExecuteFeedback(
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
function computeUnitWaves(units: UnitInfo[]): {
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
function currentWaveNumber(
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

function classifyPendingForRevisit(
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
		// All the above fields are FSM-tracked in INTENT_FIELDS; reseal so
		// the next verifyIntentState() doesn't false-positive as tampering.
		sealIntentState(slug)
	}
}

function revisitCurrentStage(
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
 * Mark every stage AFTER `targetStage` as stale so the FSM re-enters them
 * on advance rather than fast-forwarding past a `completed` marker.
 *
 * When the human revisits stage X, every stage that was built against X's
 * previous output is now based on obsolete artifacts. Without this reset,
 * the FSM's advance_stage logic sees those stages as still `completed`
 * and blithely walks past them, shipping work rooted in the old design.
 *
 * We rewind status → "active", phase → "elaborate", completed_at → null.
 * fsmStartStage will do the rest of the reset when each stage gets re-
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
	// revisited stage and calls haiku_run_next, the FSM's consistency check
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
	// we left them alone, the FSM's next-stage logic would fast-forward
	// through all of them without ever running them — shipping work that
	// depended on the obsolete upstream.
	//
	// Setting status="active", phase="elaborate", completed_at=null makes
	// the FSM re-enter each stage in order. fsmStartStage then decides
	// whether prior work still applies (via merge forward from main) or
	// needs a fresh pass. A `revalidation_of_visit` field records the
	// target's pre-revisit visit count so downstream stages can show "this
	// stage was rerun because <targetStage> changed in visit N+1".
	markDownstreamStagesStale(slug, iDir, targetStage, intentFile)

	// Update intent's active_stage. `active_stage` is FSM-tracked in
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

// Register runNext callback so state-tools can call it without circular imports
setRunNextHandler(runNext)

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
				"Each active unit resumes in its own worktree. After all subagents return, the FSM advances."
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
