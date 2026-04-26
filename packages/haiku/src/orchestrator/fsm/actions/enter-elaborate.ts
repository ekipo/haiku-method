// orchestrator/fsm/actions/enter-elaborate.ts — Entry action for a
// stage's `elaborate` phase.
//
// FIRES WHEN: a stage's phase advances to elaborate. This happens
// on:
//   - First entry to any stage (start_stage → elaborate is the
//     internal transition fired by the `tick` event).
//   - Feedback revisit causing a rollback to elaborate (covered by
//     a separate transition; this entry still fires when the new
//     phase becomes elaborate).
//
// CONTEXT IT READS:
//   - context.slug, context.currentStage — telemetry + dispatch.
//
// SIDE EFFECTS (current): telemetry only.
//
// SIDE EFFECTS (when migrated): no FSM-state writes — the elaborate
// phase is the agent doing creative work (research + unit
// decomposition). The orchestrator's job at entry is to compute the
// rendering payload for the agent. Side effects belong in the
// agent's tools (haiku_unit_set, haiku_decision_record, etc.), not
// in this entry action.
//
// EMISSION (when migrated): the OrchestratorAction shape is { action:
// "elaborate", intent, studio, stage, elaboration: "collaborative" |
// "autonomous", iteration, completed_units, pending_units,
// iterative, pending_feedback, validation_error?, message }. Most
// fields come from the stage's state.json + iteration.json + the
// stage's units directory + the stage's feedback directory. The
// `iterative` flag and pending_feedback list require pure reads of
// disk state; both are computable from derived context.
//
// RUNNEXT CORRESPONDENCE: orchestrator.ts:2474+ — the `if (phase ===
// "elaborate")` branch. The emission has three sub-paths
// (iterative re-entry, revisit, fresh elaborate) each with
// substantial discovery fan-out logic. Migrating this state is the
// single largest port surface in the FSM.

import { assign } from "xstate"
import { type ActionContext, traceEntry } from "./_shared.js"

export default assign(({ context }) => {
	const ctx = context as ActionContext
	traceEntry("elaborate", {
		slug: ctx.slug ?? "",
		stage: ctx.currentStage ?? "",
	})
	return {
		_lastEntry: "elaborate",
		_lastEntryMeta: { stage: ctx.currentStage ?? "" },
	}
})
