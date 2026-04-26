// orchestrator/fsm/actions/dispatch-fix-hat.ts — Entry action for
// each fix-hat sub-state inside a stage's `review_fix` phase.
//
// FIRES WHEN: the review_fix sub-machine transitions between fix-
// hats within a bolt. State builders enumerate one sub-state per
// fix-hat per bolt (bolt_1.builder, bolt_1.feedback_assessor,
// bolt_2.builder, ..., up to MAX_FIX_LOOP_BOLTS).
//
// CONTEXT IT READS:
//   - context.slug, context.currentStage — telemetry.
//   - event.hat, event.bolt — which fix-hat at which bolt was
//     entered. Carried on the `fix.advance` event when transitioning
//     between fix-hats within a bolt.
//
// SIDE EFFECTS (current): telemetry only.
//
// SIDE EFFECTS (when migrated): no FSM-state writes. The fix loop
// is a per-finding hat chain dispatched in parallel; each chain
// runs serially. The orchestrator emits the dispatch payload + the
// agent spawns subagents. Bolt counter increments live in the
// feedback file frontmatter, not the stage state.
//
// EMISSION (when migrated): { action: "review_fix", intent, stage,
// fix_hats: stageConfig.fixHats, items: [{ feedback_id,
// feedback_file, feedback_title, bolt, worktree, branch }],
// total_pending, escalated_count, max_bolts: MAX_FIX_LOOP_BOLTS,
// message }. The items list requires reading every pending
// feedback file in the stage feedback directory and computing
// per-finding bolt counts. That's a pure read of disk state.
//
// RUNNEXT CORRESPONDENCE: the review_fix dispatch path in
// orchestrator.ts (search for `action: "review_fix"`). The bolt-cap
// → escalate transition is handled by the per-bolt `validated`
// terminal state (state-builders.ts), which routes feedback.open
// to the next bolt or to the `escalated` terminal at cap.

import { assign } from "xstate"
import { type ActionContext, traceEntry } from "./_shared.js"

export default assign(({ context, event }) => {
	const ctx = context as ActionContext
	const e = event as { hat?: string; bolt?: number }
	const hat = e.hat ?? ""
	const bolt = e.bolt ?? 1
	traceEntry("review_fix.hat", {
		slug: ctx.slug ?? "",
		stage: ctx.currentStage ?? "",
		hat,
		bolt: String(bolt),
	})
	return {
		_lastEntry: "review_fix.hat",
		_lastEntryMeta: {
			stage: ctx.currentStage ?? "",
			hat,
			bolt,
		},
	}
})
