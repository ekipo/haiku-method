// orchestrator/prompts/_helpers.ts — Shared helpers used by per-action
// prompt builders. Lifted out of orchestrator.ts so per-prompt files
// don't have to reach into the giant module for every primitive.
//
// Contents:
//   - FSM_CONTRACTS_REVIEW_BLOCK / FSM_CONTRACTS_FIX_LOOP_BLOCK
//     — the contract reminders prepended to review and fix-loop
//     dispatch prompts.
//   - readInterpretation / buildInterpretationBlock — render the
//     `interpretation: lens|strict` mandate-mode block.
//   - inlineFile — strip frontmatter and emit a fenced inline block.
//   - emitSubagentDispatchBlock — write the prompt to a tmpfile and
//     emit the parent's `<subagent>` dispatch block.
//   - resolveReviewAgentModel — cascade hat → stage → studio for the
//     review/fix-hat model tier.
//   - batchDispatchDirective — concurrency-cap discipline (slot pool
//     vs batch-serial depending on harness capabilities).

import { existsSync, readFileSync } from "node:fs"
import matter from "gray-matter"
import { features } from "../../config.js"
import { getCapabilities } from "../../harness.js"
import { type ModelTier, resolveModel } from "../../model-selection.js"
import {
	MAX_CONCURRENT_SUBAGENTS,
	MAX_STAGE_ITERATIONS,
	parseFrontmatter,
} from "../../state-tools.js"
import {
	readModelFromPath,
	readStageDef,
	readStudio,
} from "../../studio-reader.js"
import { writeSubagentPrompt } from "../../subagent-prompt-file.js"

export const FSM_CONTRACTS_ELABORATE_BLOCK = [
	"### Workflow Contracts (REQUIRED — global framework rules)",
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
	"- The the workflow engine validates naming at `haiku_run_next` — non-compliant files block the advance.",
	"",
	"#### Unit DAG (`depends_on:`)",
	"",
	"- Each unit's `depends_on:` frontmatter lists the names of units in the **same stage** that must complete before this unit starts. Omit the field (or empty list) for units with no dependencies.",
	"- The DAG MUST be acyclic. The workflow engine computes topological waves; a cycle blocks the advance.",
	"- Cross-stage dependencies go in the stage's `inputs:` (STAGE.md) and resolve to concrete output files from prior stages.",
	"",
	"#### Quality gates",
	"",
	"- `quality_gates:` frontmatter MUST be a list of **executable gate objects** — `{ name, command, dir? }` — not prose strings. The workflow engine runs each `command` at `haiku_unit_advance_hat` time; non-zero exit blocks the advance. Prose-only gates are silently skipped and give no enforcement.",
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
	"- Set `model:` on EVERY unit you create. The workflow engine reads this at hat-dispatch time and spawns the subagent with the matching tier.",
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
	"- A **bolt** is one full cycle through the stage's hat sequence for a unit. The the workflow engine advances hats via `haiku_unit_advance_hat`; agents NEVER mutate `bolt`, `hat`, `status`, or `iterations` fields directly (the harness blocks those writes).",
	"- The agent's responsibility per hat: produce the hat's outputs, then call `haiku_unit_advance_hat`. On reject: call `haiku_unit_reject_hat` with a reason.",
	"- Maximum bolts per unit: 5. Exceeding escalates to the human.",
	"",
	"#### Revisit cycles — `closes:` frontmatter",
	"",
	"- On an iteration > 1 (feedback-revisit or post-execute rollback), new units MUST declare `closes: [FB-NN, FB-MM, …]` listing every feedback id they address.",
	"- Every pending feedback id MUST be referenced by at least one new unit's `closes:` — orphans block advancement.",
	"- Resolution paths: (a) draft new units that close findings (additive-elaboration), OR (b) fix existing unit specs and close the findings via `haiku_feedback_update status=closed` (pre-execute spec revisit), OR (c) reject stale/invalid findings via `haiku_feedback_reject` with a concrete reason.",
	"",
	"#### MCP tool contracts — what the agent calls vs. what the workflow engine owns",
	"",
	"- `haiku_run_next { intent }` is the sole workflow driver. Agents call it to advance the lifecycle; they never write `state.json`, `intent.md` frontmatter, or unit workflow fields directly.",
	"- `haiku_unit_advance_hat` / `haiku_unit_reject_hat` are called by subagents inside each hat; they return the result path the parent reads to drive the next action.",
	"- `haiku_feedback` / `haiku_feedback_update` / `haiku_feedback_reject` / `haiku_feedback_delete` are the sole channels for logging and resolving review findings.",
	"- Branch topology, merge semantics, worktree creation, and stage-branch enforcement are owned by the workflow engine — the agent does not `git checkout`, `git merge`, or create branches manually during stage work.",
	"",
	"#### Unit content quality (validated at advance)",
	"",
	"- Placeholder strings are forbidden in unit specs and frontmatter. The the workflow engine rejects unit advancement when any of these appear: `TBD`, `tbd`, `similar to`, `add error handling`, `etc.`, or a literal `...` placeholder. Either write the concrete value or surface it as a question.",
	"- Every acceptance criterion MUST be testable: include the command or condition that proves it. `tests pass` is rejected; the verify-command must be concrete and exit-code-driven (e.g. `pnpm test --run path/to/file` exits 0, or `pytest tests/foo.py` exits 0, or `cargo test --test bar` exits 0 — match the project's actual stack).",
	"- Criteria are drafted as **pairs**: the goal-prose lives in the unit body under `## Completion criteria`; the executable check lives in the unit's `quality_gates:` frontmatter. Two coupled fields, written together at elaboration time. Per-stage ELABORATION.md files supply domain-specific examples; this contract supplies the rule.",
	"- A criterion that cannot be expressed as a command/condition is a spec gap — surface it (`ask_user_visual_question` or reject the elaborate phase), do not paper over with prose.",
	"",
	"##### Specific-but-unverifiable criteria (a common failure mode)",
	"",
	"Criteria that *sound* concrete but have no executable check produce specs that look complete but the the workflow engine cannot enforce. Watch for these shapes — they apply across every studio:",
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

export const FSM_CONTRACTS_EXECUTE_BLOCK = [
	"### Workflow Contracts (REQUIRED — reminder during execute)",
	"",
	"> ## ⟁ NO ADVANCE WITHOUT VERIFICATION.",
	"> Run the gate command, read the exit code, *then* call `haiku_unit_advance_hat`. Hedged advances burn bolts on broken work.",
	"",
	"- The agent operates inside ONE hat at a time. Each hat runs in a fresh subagent with the hat's mandate loaded from `hats/{hat}.md`. Hat context does not leak across hats — that isolation is the framework's defense against self-reinforcing errors.",
	"- After the hat's work is done, the subagent calls `haiku_unit_advance_hat` (success) or `haiku_unit_reject_hat { reason }` (failure). The workflow engine writes the result; the subagent does not.",
	"- Quality gates run automatically at the end of the hat sequence (last hat's `haiku_unit_advance_hat`). A failing gate at unit completion blocks the advance with a concrete error — fix the failure, don't retry the tool call.",
	"- **Per-hat opt-in gates.** A hat may declare `run_quality_gates: true` in its frontmatter. When it does, gates run on THAT hat's `advance_hat` (not just the last hat's), AND failure auto-rejects: bolt counter increments, the same hat retries, no agent decision required. Bolt cap (5) still applies. This is the framework's way of saying \"this hat produces verifiable artifacts; gates are part of its definition of done.\"",
	"- Cross-unit writes within a stage are forbidden without explicit `inputs:` / `outputs:` declarations on the unit.",
	"",
	"#### Verification before advance",
	"",
	"- Before calling `haiku_unit_advance_hat`, RUN the gate command(s) and READ the exit code. Do not advance on the assumption that the build/tests/lints pass — if your hat declares `run_quality_gates: true`, the workflow auto-rejects on gate failure and burns one of your 5 bolts.",
	"- Your one-line return summary MUST contain a verb of completed action (`edited X`, `added Y test`, `updated Z`) and ZERO hedging words: `should`, `seems`, `probably`, `might`, `looks like`. Hedging means you are not sure — call `haiku_unit_reject_hat` with that uncertainty as the reason instead of advancing with hedged language.",
	"",
	"#### Red flags (STOP and re-read this contract if you catch yourself thinking)",
	"",
	'- "I\'ll skip the gate just this once" — the gate is the contract; bypass is a scope violation.',
	"- \"I'll touch the related file too while I'm here\" — out-of-scope edits create regressions other hats cannot see; if it's broken, log it via the next review.",
	"- **Did you re-run the gate command and read the exit code 0?** If not, you don't know whether the build/tests/lints actually pass — \"probably\" isn't evidence. Re-run before calling `haiku_unit_advance_hat`.",
	"- \"Another hat's responsibility overlaps with mine, I'll cover it\" — stay in your lane; another hat will catch what you skip.",
	'- "The user said go fast, so I\'ll abbreviate the work" — speed comes from fewer rejections, not skipped steps.',
].join("\n")

export const SUBAGENT_ERROR_RECOVERY = [
	"## Error Recovery (if advance_hat / reject_hat returns an error)",
	"",
	'Tool responses containing `"error": "..."` mean the workflow engine refused the action. Read the `message` field — it describes the exact fix. Common errors and recovery:',
	"",
	"- `unit_scope_violation` (from advance_hat) / `unit_scope_violation_on_reject` (from reject_hat) — your unit worktree contains commits that wrote files outside the stage's declared scope. **`git checkout HEAD -- <file>` is a NO-OP on committed files.** Use ONE of:",
	"  - `git reset --hard $(git merge-base HEAD <stage-branch>)` — drops ALL unit commits (recommended early in a unit)",
	"  - `git rm <file> && git commit --amend --no-edit` — removes a single file from the latest commit",
	"  - `git revert --no-edit <commit-sha>` — creates a new commit that undoes a bad commit",
	"  Then re-run `git add -A && git commit` if needed, and retry `advance_hat` / `reject_hat`.",
	"- `unit_outputs_empty` — your unit made no tracked writes. Either produce an artifact in a scope-allowed path and commit, or explicitly add paths to the unit's `outputs:` frontmatter field if they exist outside auto-detection.",
	"- `unit_outputs_missing` — a declared output path doesn't exist on disk. Create it, or remove the path from `outputs:` if declared in error.",
	"- `unit_outputs_escaped` — a declared output path resolves outside the intent dir. Fix the path to be intent-relative or repo-relative; absolute paths and `..` escapes are rejected.",
	"- `hat_too_fast` — less than 30 seconds since hat start. Do real work before advancing.",
	"- `max_bolts_exceeded` — unit hit the iteration ceiling. Stop and report to the user; this needs human intervention.",
	"",
	"After fixing the underlying issue, call the SAME tool again (advance_hat or reject_hat as appropriate). Do NOT call haiku_run_next as a bypass — the workflow engine will return the same error.",
	"",
	"**Persistent advance failure?** If `advance_hat` keeps returning `unit_scope_violation` and you cannot clear it in-place, call `reject_hat` instead. reject_hat tracks consecutive scope-violation attempts and escalates via `max_bolts_exceeded` after 5, surfacing the stuck state to the user. advance_hat has no such ceiling on its own — reject_hat is the correct escape.",
].join("\n")

export const FSM_CONTRACTS_REVIEW_BLOCK = [
	"### Workflow Contracts (REQUIRED — reminder during review)",
	"",
	"> ## ⟁ REVIEWERS LOG, NEVER EDIT.",
	"> Your only output channel is `haiku_feedback`. Any file write is a scope violation, regardless of how trivial the fix looks.",
	"",
	"- Review agents MUST NOT write, edit, or create any file. Their ONLY output channel is `haiku_feedback`. Any file write is a scope violation.",
	"- Conditional review: each agent's `applies_to:` frontmatter (glob list) scopes it to matching output kinds. The workflow engine filters agents whose scope doesn't match; agents without `applies_to:` always run.",
	'- Findings with concrete reproducible claims (file:line + gate command + proposed fix) accelerate resolution. Vague concerns ("looks wrong") are less actionable — prefer concrete.',
	"- **Scope routing is mandatory.** If a finding's root cause is in a different stage than the one being reviewed (e.g. a design reviewer notices an inception assumption is wrong), pass `upstream_stage: \"<stage-name>\"` to `haiku_feedback`. The workflow surfaces cross-stage findings to the human rather than routing them through this stage's fix loop — the wrong hats cannot fix a different stage's artifacts.",
	`- A stage's retry budget is TIGHT: agent-invoked rejection cycles are capped at ${MAX_STAGE_ITERATIONS} iterations (\`MAX_STAGE_ITERATIONS=${MAX_STAGE_ITERATIONS}\`). Beyond that, the framework escalates to the human — repeated rejections indicate a spec problem the pre-execute review should have caught, and the correct response is to fix the plan, not keep building against a broken plan.`,
	"",
	"#### Red flags (STOP and re-read this contract if you catch yourself thinking)",
	"",
	'- "This finding is trivial, I\'ll just fix it myself" — file write = scope violation; log it as feedback no matter how small.',
	"- \"The mandate doesn't quite cover this, but it's clearly wrong\" — if it's in your mandate's spirit, log it; if not, leave it for another agent.",
	"- **Did you open the artifact at HEAD, or are you reading the diff alone?** The diff lies about deletions, renames, and unchanged-but-relevant context. Read both — the diff for what changed, the artifact for the surrounding code that constrains the change.",
	'- "I\'ll batch related concerns into one finding" — atomic findings let the fix loop dispatch in parallel; merged findings serialize.',
	"- \"This finding's root cause is upstream, I'll route it through this stage's hats anyway\" — set `upstream_stage:` so the framework surfaces it; this stage's hats cannot fix the wrong stage's artifacts.",
	"- \"It's not on my checklist, so I'll skip it\" — if your mandate has `interpretation: lens`, the checklist is examples; the mandate is the lens. In-spirit findings count.",
	'- "I was dispatched, I should find something" — out-of-mandate findings are noise; zero findings is a valid result for a clean review.',
	'- "It passes the literal check but it\'s clearly wrong" — the spirit-violation IS the finding. State the spirit-violation explicitly in the body.',
].join("\n")

export const FSM_CONTRACTS_FIX_LOOP_BLOCK = [
	"### Workflow Contracts (REQUIRED — reminder during fix loop)",
	"",
	"> ## ⟁ NO FIX WITHOUT INVESTIGATION.",
	"> Read the artifact, verify the finding, state the gap *before* editing. Bolts spent on guesses don't come back.",
	"",
	"- The fix loop runs the stage's `fix_hats:` sequence against every eligible pending finding in parallel. Each finding's hat chain is serial (e.g. designer → feedback-assessor); chains run in parallel across findings. The feedback file IS the scope — do NOT synthesize a new unit spec.",
	'- Every hat in the sequence reads the feedback body + the flagged artifact path and acts within its mandate. The sequence typically ends with a `feedback-assessor` hat that independently verifies the fix and, if satisfied, calls `haiku_feedback_update { status: "closed", closed_by: "fix-loop:<bolt-id>" }`.',
	"- If the feedback-assessor is NOT satisfied, it leaves the feedback open (no `closed_by`, no status change). The workflow engine increments the bolt counter and may dispatch another loop, up to 3 bolts per finding. Exceeding 3 escalates to the human.",
	"- A fix-loop hat is NOT a unit hat. Do NOT call `haiku_unit_advance_hat` or `haiku_unit_reject_hat` — those are for unit execution. The fix-loop is orchestrated by the parent; each fix hat completes its work and returns, and the parent calls `haiku_run_next` after every wave completes to advance.",
	"- Parallel chains may edit the same artifact concurrently. Each final hat validates closure independently — a chain whose fix was clobbered by another chain will leave its finding open, and the next bolt will retry. Budget is spent, not lost.",
	"",
	"#### Per-hat action rules live in the subagent prompts",
	"",
	"This contract covers dispatch coordination, the bolt cap, and the per-finding scoping rule. The action-rules each fix-mode hat follows during its own work — investigate root cause before editing, verify the finding against the artifact before fixing (and `haiku_feedback_reject` if the finding is stale or invalid), no hedging in summaries, no out-of-scope edits — live as numbered steps in the per-hat subagent prompts emitted below. Every fix-mode hat reads its own rules; this block exists so the dispatching agent understands the contract its subagents will follow.",
].join("\n")

/** Read the `interpretation:` field from a hat-like frontmatter file.
 *  Returns "lens" | "strict" | undefined (unset). Universal field on
 *  hat/review-agent/fix-hat frontmatter. */
export function readInterpretation(
	filePath: string | undefined,
): "lens" | "strict" | undefined {
	if (!filePath || !existsSync(filePath)) return undefined
	try {
		const { data } = parseFrontmatter(readFileSync(filePath, "utf8"))
		const v = data.interpretation
		if (v === "lens" || v === "strict") return v
		return undefined
	} catch {
		return undefined
	}
}

/** Build the interpretive block injected into a dispatch prompt right
 *  after the agent's mandate is inlined. Returns "" when interpretation
 *  is unset (no block emitted). */
export function buildInterpretationBlock(
	mode: "lens" | "strict" | undefined,
): string {
	if (!mode) return ""
	if (mode === "lens") {
		return [
			"## Mandate interpretation: LENS",
			"",
			"Your mandate above is a **lens**, not a checklist.",
			"",
			"- **In-spirit findings count.** A finding obviously within your mandate's lens but not listed as an explicit checklist item is IN scope. The mandate names representative concerns, not the exhaustive set.",
			"- **Out-of-mandate findings are NOT in scope, even if visible.** If your glob matched a file but the change has nothing to do with your lens, return zero findings. Inventing findings to justify dispatch is a scope violation, not thoroughness.",
			"- **Letter and spirit are not separable.** A change that technically passes a literal check but obviously violates what the check exists to enforce IS a finding. State the spirit-violation explicitly in the body so the fix loop knows what to address.",
		].join("\n")
	}
	return [
		"## Mandate interpretation: STRICT",
		"",
		"Your mandate above is a **literal checklist**.",
		"",
		'- Findings MUST be tied to a specific named item in your mandate. Do NOT extend to "in-spirit" issues — for this review, false positives carry the same weight as false negatives.',
		"- If you see something concerning outside the checklist, do NOT log it through this agent. Log it through a different review agent if one exists, or surface it as an out-of-scope observation in your summary.",
		"- Cite the specific checklist item each finding maps to in the `body:` field so the fix loop can verify scope.",
	].join("\n")
}

/** Strip YAML frontmatter and emit a fenced inline block. Frontmatter
 *  carries workflow metadata that the orchestrator already consumed — the
 *  subagent should see only the authoritative body. ~~~~ fences survive
 *  inlined content that contains triple backticks. */
export function inlineFile(absPath: string, heading: string): string {
	if (!existsSync(absPath)) return ""
	const raw = readFileSync(absPath, "utf8")
	let body: string
	try {
		body = matter(raw).content.trim()
	} catch {
		body = raw
	}
	if (!body) return ""
	return `### ${heading}\n\n*Source: \`${absPath}\`*\n\n~~~~\n${body}\n~~~~\n`
}

/** Emit a `<subagent>` block whose body is a tmpfile pointer instead
 *  of an inlined prompt. The full prompt is written to a session-scoped
 *  tmpfile; the parent's instruction tells the spawning agent to read
 *  it. */
export function emitSubagentDispatchBlock(opts: {
	unit: string
	hat: string
	bolt: number
	agentType: string
	model?: string | null
	promptBody: string
	heading?: string
	toolAttr?: boolean
}): string {
	const { unit, hat, bolt, agentType, model, promptBody, heading, toolAttr } =
		opts
	const { path, parentInstruction } = writeSubagentPrompt({
		unit,
		hat,
		bolt,
		content: promptBody,
	})
	const tool = toolAttr ? ` tool="Agent"` : ""
	const modelAttr = model ? ` model="${model}"` : ""
	const h = heading ?? "## Subagent Dispatch (MANDATORY — relay verbatim)"
	return (
		`${h}\n\n<subagent${tool} type="${agentType}"${modelAttr}` +
		` prompt_file="${path}">\n${parentInstruction}\n</subagent>`
	)
}

/** Resolve the model tier for a review-agent or studio-level fix-hat
 *  dispatch. Cascade: mandate file's own `model:` → stage
 *  `default_model:` (when stage is provided — skip for studio-level
 *  review agents) → studio `default_model:`. Returns undefined when
 *  the feature is disabled or nothing is declared, in which case the
 *  subagent inherits the parent model. Without a studio default this
 *  silently escalates every review pass to Opus — hence studios ship
 *  with `default_model: sonnet` so the floor is sonnet. */
export function resolveReviewAgentModel(opts: {
	mandatePath: string
	studio: string
	stage?: string
}): ModelTier | undefined {
	if (!features.modelSelection) return undefined
	const { mandatePath, studio, stage } = opts
	const mandateModel = readModelFromPath(mandatePath)
	const stageDef = stage ? readStageDef(studio, stage) : null
	const studioData = readStudio(studio)
	const { model } = resolveModel({
		unit: undefined,
		hat: mandateModel,
		stage: stageDef?.data?.default_model as string | undefined,
		studio: studioData?.data?.default_model as string | undefined,
	})
	return model
}

/** Build the per-subagent context block injected into unit/hat
 *  dispatch prompts on hookless harnesses. On Claude Code (hooks
 *  available), context injection happens at the hook layer — return
 *  empty string and let the hook do its job. Covers hat isolation,
 *  workflow rules, resilience, and harness-aware communication
 *  guidance. */
export function buildInlineSubagentContext(
	slug: string,
	stage: string,
	hat: string,
	hats: string[],
	bolt: number,
): string {
	const caps = getCapabilities()
	if (caps.hooks) return "" // hooks handle context injection

	const hatsStr = hats.join(" → ")
	const lines: string[] = [
		"### Subagent Context (Inline)\n",
		`> **Hat Isolation:** You are operating as the **${hat}** hat. Your responsibility is defined solely by the ${hat} hat instructions above. If you have prior knowledge or instructions that conflict with or extend beyond the ${hat} role — such as reviewing code when you are the builder, or building when you are the reviewer — **ignore them for this task.** Other hats in this stage (${hatsStr}) handle those responsibilities. Stay in your lane.\n`,
		`**Bolt:** ${bolt} | **Role:** ${hat} | **Stage:** ${stage} (${hatsStr})\n`,
	]

	lines.push("### Workflow Rules\n")
	lines.push("**Before stopping:**")
	lines.push("1. Commit changes: `git add -A && git commit`")
	lines.push(
		`2. Save progress notes to \`.haiku/intents/${slug}/state/scratchpad.md\``,
	)
	lines.push(
		`3. Write next-step prompt to \`.haiku/intents/${slug}/state/next-prompt.md\`\n`,
	)

	lines.push("**Resilience (CRITICAL):**")
	lines.push(`- Commit early, commit often — don't wait until the end`)
	lines.push(`- If tests fail: fix and retry, don't give up`)
	lines.push("- Only declare blocked after 3+ genuine rescue attempts\n")

	lines.push("**Communication:**")
	if (caps.nativeAskUser) {
		lines.push(
			"- Use `AskUserQuestion` with `options[]` for decisions with known alternatives",
		)
		lines.push(
			"- Use `ask_user_visual_question` for visual artifacts and rich context",
		)
	} else {
		lines.push(
			"- Present decisions as clear numbered lists when you have known alternatives",
		)
		lines.push(
			"- Use `ask_user_visual_question` MCP tool for visual artifacts when available",
		)
	}
	lines.push("- Break independent questions into separate interactions\n")

	return lines.join("\n")
}

/** Render the parent's concurrency-capped dispatch discipline for a
 *  parallel subagent wave. Slot pool when the harness has
 *  backgroundSpawn; batch-serial otherwise. */
export function batchDispatchDirective(
	count: number,
	label = "subagents",
): string {
	const backgroundSpawn = getCapabilities().subagents.backgroundSpawn

	if (count <= MAX_CONCURRENT_SUBAGENTS) {
		if (backgroundSpawn) {
			return `**Concurrency cap:** up to ${MAX_CONCURRENT_SUBAGENTS} concurrent background ${label} (env \`HAIKU_MAX_CONCURRENT_SUBAGENTS\`). This wave has ${count} — spawn all ${count} as background ${label} in a single turn and react to completion notifications as they arrive.`
		}
		return `**Concurrency cap:** up to ${MAX_CONCURRENT_SUBAGENTS} concurrent ${label} (env \`HAIKU_MAX_CONCURRENT_SUBAGENTS\`). This wave has ${count} — spawn them all in a single turn and wait for every ${label.replace(/s$/, "")} to return before proceeding.`
	}

	if (backgroundSpawn) {
		return [
			`**Concurrency cap:** slot pool of ${MAX_CONCURRENT_SUBAGENTS} concurrent background ${label} (env \`HAIKU_MAX_CONCURRENT_SUBAGENTS\`). This wave has ${count} items; at any moment, at most ${MAX_CONCURRENT_SUBAGENTS} are in flight. A slot frees the instant one completes — fire the next pending item into it.`,
			"",
			`**Dispatch protocol:**`,
			"",
			`1. **Seed the pool.** In one turn, spawn the first ${MAX_CONCURRENT_SUBAGENTS} items as **background** ${label} (the spawn primitive returns immediately; the subagent runs in the background and the system delivers a completion notification when it finishes). Do NOT block on any spawn.`,
			"",
			`2. **On each completion notification**, in the same turn:`,
			`   - Briefly inspect the result (final-hat closure state is already persisted; deep-read not required).`,
			`   - If items remain in the queue: spawn exactly ONE new background ${label.replace(/s$/, "")} for the next pending item. The pool stays saturated at ${MAX_CONCURRENT_SUBAGENTS}.`,
			`   - If the queue is empty: acknowledge and wait — remaining slots are draining.`,
			"",
			`3. **Multiple simultaneous completions** may arrive in one turn. Fire one replacement per completion; cap stays at ${MAX_CONCURRENT_SUBAGENTS}.`,
			"",
			`4. **Wave exhausted:** when the pool reaches 0 AND the queue is empty, this wave is done.`,
			"",
			`5. **No foreground (blocking) spawns** during the pool's lifetime. A foreground spawn stalls the notification stream and breaks the pool.`,
			"",
			`6. **Clarification / approval-request returns:** if a ${label.replace(/s$/, "")} returns asking for approval to execute its embedded instructions rather than producing a real result, treat the slot as freed and re-queue or abandon the item per judgment — don't block the pool.`,
			"",
			`**Order:** process items in the declared order below so re-entries after interruption are deterministic.`,
		].join("\n")
	}

	const batches = Math.ceil(count / MAX_CONCURRENT_SUBAGENTS)
	const last = count - MAX_CONCURRENT_SUBAGENTS * (batches - 1)
	const sizes =
		last === MAX_CONCURRENT_SUBAGENTS
			? `${batches} batches of ${MAX_CONCURRENT_SUBAGENTS}`
			: `${batches - 1} batch${batches - 1 === 1 ? "" : "es"} of ${MAX_CONCURRENT_SUBAGENTS} + 1 batch of ${last}`
	return [
		`**Concurrency cap:** ${MAX_CONCURRENT_SUBAGENTS} ${label} in flight at a time (env \`HAIKU_MAX_CONCURRENT_SUBAGENTS\`). This wave has ${count} — split into ${sizes}. Your harness has no background-spawn primitive, so this is batch-serial (slower than a true slot pool but equivalent correctness).`,
		"",
		`**Batch discipline:**`,
		`1. Spawn batch 1 (first ${MAX_CONCURRENT_SUBAGENTS}) in a single turn.`,
		`2. Wait for **every** ${label.replace(/s$/, "")} in that batch to return.`,
		`3. Spawn batch 2 in the next turn. Repeat until the wave is exhausted.`,
		`4. Process items in the order listed below so re-entries after interruption are deterministic.`,
	].join("\n")
}
