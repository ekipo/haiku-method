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

export const FSM_CONTRACTS_REVIEW_BLOCK = [
	"### FSM Contracts (REQUIRED — reminder during review)",
	"",
	"> ## ⟁ REVIEWERS LOG, NEVER EDIT.",
	"> Your only output channel is `haiku_feedback`. Any file write is a scope violation, regardless of how trivial the fix looks.",
	"",
	"- Review agents MUST NOT write, edit, or create any file. Their ONLY output channel is `haiku_feedback`. Any file write is a scope violation.",
	"- Conditional review: each agent's `applies_to:` frontmatter (glob list) scopes it to matching output kinds. The FSM filters agents whose scope doesn't match; agents without `applies_to:` always run.",
	'- Findings with concrete reproducible claims (file:line + gate command + proposed fix) accelerate resolution. Vague concerns ("looks wrong") are less actionable — prefer concrete.',
	"- **Scope routing is mandatory.** If a finding's root cause is in a different stage than the one being reviewed (e.g. a design reviewer notices an inception assumption is wrong), pass `upstream_stage: \"<stage-name>\"` to `haiku_feedback`. The FSM surfaces cross-stage findings to the human rather than routing them through this stage's fix loop — the wrong hats cannot fix a different stage's artifacts.",
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
	"### FSM Contracts (REQUIRED — reminder during fix loop)",
	"",
	"> ## ⟁ NO FIX WITHOUT INVESTIGATION.",
	"> Read the artifact, verify the finding, state the gap *before* editing. Bolts spent on guesses don't come back.",
	"",
	"- The fix loop runs the stage's `fix_hats:` sequence against every eligible pending finding in parallel. Each finding's hat chain is serial (e.g. designer → feedback-assessor); chains run in parallel across findings. The feedback file IS the scope — do NOT synthesize a new unit spec.",
	'- Every hat in the sequence reads the feedback body + the flagged artifact path and acts within its mandate. The sequence typically ends with a `feedback-assessor` hat that independently verifies the fix and, if satisfied, calls `haiku_feedback_update { status: "closed", closed_by: "fix-loop:<bolt-id>" }`.',
	"- If the feedback-assessor is NOT satisfied, it leaves the feedback open (no `closed_by`, no status change). The FSM increments the bolt counter and may dispatch another loop, up to 3 bolts per finding. Exceeding 3 escalates to the human.",
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
 *  carries FSM metadata that the orchestrator already consumed — the
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
