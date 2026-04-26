// orchestrator/fsm/actions/enter-gate.ts — Entry action for a
// stage's `gate` phase.
//
// FIRES WHEN: a stage transitions to its terminal gate state via
// `review.clean` (no findings) or via the review_fix `done`
// terminal (all findings closed). The gate emission then drives
// the per-stage approval mechanism — auto, ask, external, await,
// or compound — based on the stage's configured `review:` field.
//
// CONTEXT IT READS:
//   - context.slug, context.currentStage — telemetry + dispatch.
//   - StageConfig.gate (via the stage sub-machine's meta) — which
//     gate type to render.
//
// SIDE EFFECTS (current): telemetry only.
//
// SIDE EFFECTS (when migrated): the entry will mark the stage
// state.json's phase=gate (today done by fsmGateAsk), then either:
//   - For auto gate: immediately advance via fsmAdvanceStage.
//   - For ask gate: open the local review UI session and emit a
//     `gate_review` action that haiku_run_next.ts blocks on.
//   - For external gate: emit `awaiting_external_review` and
//     install the polling-for-approval check.
//   - For await gate: same shape as external but a different
//     blocking signal (customer response, pipeline, etc).
//   - For compound gate: render a chooser, agent picks one path.
//
// EMISSION (when migrated): { action: "gate_review" |
// "awaiting_external_review", intent, stage, gate_type, gate_context,
// next_stage, next_phase, message }. Already covered by the
// matching prompt builder at orchestrator/prompts/gate_review.ts
// (extracted in task #13).
//
// RUNNEXT CORRESPONDENCE: orchestrator.ts where phase === "gate" —
// the gate emission. The actual UI session lifecycle lives in
// haiku_run_next.ts (the gate_review handler that calls
// _openReviewAndWait).

import { assign } from "xstate"
import { type ActionContext, traceEntry } from "./_shared.js"

export default assign(({ context }) => {
	const ctx = context as ActionContext
	traceEntry("gate", {
		slug: ctx.slug ?? "",
		stage: ctx.currentStage ?? "",
	})
	return {
		_lastEntry: "gate",
		_lastEntryMeta: { stage: ctx.currentStage ?? "" },
	}
})
