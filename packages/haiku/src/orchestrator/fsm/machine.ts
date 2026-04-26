// orchestrator/fsm/machine.ts — xstate v5 machine skeleton.
//
// This is the scaffolding the per-state migration lands against. The
// machine itself is empty for now — it has the stage × phase
// hierarchy declared (the structure that motivated the xstate choice)
// but no transitions wired yet. The legacy `runNext` switch in
// orchestrator.ts continues to drive the FSM until per-state files
// are migrated one-at-a-time and registered here.
//
// Design notes:
//   - `tick` is the synthetic event the wrapper sends each `runNext`
//     call. xstate v5's `getNextSnapshot` resolves the next state
//     from a synthetic event, so we get the pull-based contract
//     `runNext()` requires (return one action per call).
//   - The snapshot's `output` is the OrchestratorAction the agent
//     follows. Per-state `output` selectors compute it from `context`.
//   - `context` carries the per-tick read of intent/stage/phase so
//     state-decision logic stays pure (no filesystem reads inside
//     `decide` — those happen in the wrapper before sending `tick`).

import { type AnyMachineSnapshot, createMachine } from "xstate"
import type { OrchestratorAction } from "../../orchestrator.js"
import type { FsmContext } from "./types.js"

export type FsmEvent =
	| { type: "tick" }
	| { type: "advance"; to: string }
	| { type: "blocked"; reason: string }

/** Skeleton machine. The states block uses the canonical stage × phase
 *  hierarchy from the legacy FSM — same names, same nesting. The
 *  per-state `entry`, `exit`, and `on.tick` handlers will land as the
 *  migration progresses. Until then the wrapper in `dispatch.ts` falls
 *  back to the legacy `runNext` switch. */
export const fsmMachine = createMachine({
	id: "haiku-fsm",
	types: {} as {
		context: FsmContext
		events: FsmEvent
		output: OrchestratorAction
	},
	initial: "select_studio",
	context: ({ input }) => input as FsmContext,
	states: {
		// ── Setup ──────────────────────────────────────────────────────────
		select_studio: { on: { tick: { target: "start_stage" } } },
		start_stage: { on: { tick: { target: "stage_active" } } },

		// ── Stage × phase hierarchy ────────────────────────────────────────
		stage_active: {
			initial: "elaborate",
			states: {
				elaborate: {},
				execute: {},
				review: {},
				gate_review: {},
				review_fix: {},
			},
		},

		// ── Intent-completion review (studio-level) ────────────────────────
		intent_completion_review: {},
		intent_completion_fix: {},

		// ── Revisit + upstream routing ─────────────────────────────────────
		feedback_revisit: {},
		upstream_finding_surfaced: {},

		// ── Terminal ──────────────────────────────────────────────────────
		complete: { type: "final" },
		error: { type: "final" },
		blocked: { type: "final" },
	},
})

/** Type alias for the snapshot — used by the wrapper to read state +
 *  context after each `tick`. */
export type FsmSnapshot = AnyMachineSnapshot
