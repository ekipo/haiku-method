// orchestrator/fsm/actions/dispatch-hat.ts — Entry action for each
// hat sub-state inside a stage's `execute` phase.
//
// FIRES WHEN: the execute sub-machine transitions from one hat to
// the next (or from the initial hat on first entry). The state
// builders enumerate one sub-state per hat per stage; this same
// action runs on entry to ALL of them (the action reads the hat
// name from event payload + meta).
//
// CONTEXT IT READS:
//   - context.slug, context.currentStage — telemetry correlation.
//   - event.hat — which hat's sub-state was entered. Carried on
//     the `hat.advance` event when transitioning between hats; not
//     present on initial entry (the first hat fires the action with
//     no hat field, falling back to "" — telemetry tolerates that).
//
// SIDE EFFECTS (current): telemetry only.
//
// SIDE EFFECTS (when migrated): no FSM writes. The hat dispatch
// itself is the agent spawning a subagent with the hat's mandate.
// The orchestrator's job at entry is to compute the per-unit
// dispatch payload (model tier, agent_type, scoped inputs, the
// inline subagent prompt). All of that is read-only relative to
// disk state.
//
// EMISSION (when migrated): { action: "start_unit" | "continue_unit"
// | "start_units" | "continue_units", intent, stage, unit | units,
// hat | first_hat, hats, bolt, worktree | worktrees,
// stage_metadata, hat_def, model, agent_type, message }.
// Wave-vs-single dispatch depends on whether multiple units are
// ready (DAG topo + dependency resolution from listUnits).
//
// RUNNEXT CORRESPONDENCE: orchestrator.ts:3300-3500 (the execute
// phase branch — start_unit / start_units emission). The most
// frequently-executed FSM path; per-unit waves dispatch through
// here on every advance_hat completion.

import { assign } from "xstate"
import { type ActionContext, traceEntry } from "./_shared.js"

export default assign(({ context, event }) => {
	const ctx = context as ActionContext
	const e = event as { hat?: string }
	const hat = e.hat ?? ""
	traceEntry("execute.hat", {
		slug: ctx.slug ?? "",
		stage: ctx.currentStage ?? "",
		hat,
	})
	return {
		_lastEntry: "execute.hat",
		_lastEntryMeta: { stage: ctx.currentStage ?? "", hat },
	}
})
