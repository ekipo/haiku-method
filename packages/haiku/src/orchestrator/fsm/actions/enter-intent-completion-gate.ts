// orchestrator/fsm/actions/enter-intent-completion-gate.ts — Entry
// action for the final intent-completion gate state.
//
// FIRES WHEN: the studio-level review pass finishes clean (no
// findings) OR all studio-level fix-loop findings close. The gate
// then asks for explicit user approval to mark the intent
// completed — even when stage gates were auto/external, the
// completion bookend is opt-out, not opt-in.
//
// CONTEXT IT READS:
//   - context.slug, context.studio — telemetry.
//
// SIDE EFFECTS (current): telemetry only.
//
// SIDE EFFECTS (when migrated): the entry will set intent.phase =
// "intent_completion_gate" so derive-state can route subsequent
// ticks here. Approval flips status to completed (terminal); reject
// rolls phase back to active and resets the
// completion_review_dispatched flag so the next pass re-runs the
// studio review (which is the right behavior — fixes get a fresh
// audit).
//
// EMISSION (when migrated): { action: "gate_review", intent, stage:
// null, gate_context: "intent_completion", gate_type: "ask",
// next_stage: null, next_phase: null, message }. The
// haiku_run_next.ts gate handler routes by gate_context to apply
// fsmIntentComplete on approval (terminal) vs the rollback on
// reject. Prompt rendering reuses the gate_review builder.
//
// RUNNEXT CORRESPONDENCE: completeOrReviewIntent() emits the gate
// payload with gate_context: "intent_completion" — the only
// gate_context where approval transitions to intent_complete
// instead of advancing a stage.

import { assign } from "xstate"
import { type ActionContext, traceEntry } from "./_shared.js"

export default assign(({ context }) => {
	const ctx = context as ActionContext
	traceEntry("intent_completion_gate", { slug: ctx.slug ?? "" })
	return { _lastEntry: "intent_completion_gate" }
})
