// FSM state-machine types.
//
// These mirror the action surface produced by the legacy
// `runNext()` switch in orchestrator.ts. The xstate v5 port lives in
// `./machine.ts` (added in a later commit) and consumes these types.
// Writing them up front lets per-state files type-check independently
// of the machine itself, so the migration can happen state-by-state
// without breaking the world.

import type { OrchestratorAction } from "../../orchestrator.js"

/** Runtime context the FSM threads through every state. The legacy
 *  runNext recomputes much of this on every tick by reading frontmatter
 *  + iteration files; the xstate port consolidates those reads here. */
export interface FsmContext {
	readonly slug: string
	readonly studio: string
	readonly intentDirPath: string
	readonly intent: Record<string, unknown>
	readonly currentStage: string
	readonly currentPhase: string
	/** Optional URL when the agent is signalling external review state. */
	readonly externalReviewUrl?: string
}

/** Outcome of a single state's `decide()` evaluation. */
export type Transition =
	| { kind: "advance"; to: StateName; action: OrchestratorAction }
	| { kind: "stay"; action: OrchestratorAction }
	| { kind: "terminal"; action: OrchestratorAction }

/** Discriminator across every concrete state. The string union mirrors
 *  the action types returned by the legacy switch — extracted from
 *  `runNext` and `buildRunInstructions` in orchestrator.ts. Keep this
 *  exhaustive so xstate's `assertEvent` and TS exhaustiveness checks
 *  catch missing cases. */
export type StateName =
	// setup
	| "select_studio"
	| "start_stage"
	// phase progression
	| "elaborate"
	| "advance_phase"
	| "execute"
	| "advance_stage"
	| "intent_complete"
	// units
	| "start_unit"
	| "start_units"
	| "continue_unit"
	| "continue_units"
	// review loop
	| "review"
	| "review_fix"
	| "fix_quality_gates"
	| "integrate_fix_chains"
	| "pre_review"
	| "pre_review_revisit"
	| "review_elaboration"
	// intent-completion review
	| "intent_completion_review"
	| "intent_completion_fix"
	// revisit
	| "feedback_revisit"
	| "upstream_finding_surfaced"
	// gates
	| "gate_review"
	| "intent_approved"
	| "awaiting_external_review"
	| "external_review_requested"
	| "gate_blocked"
	| "changes_requested"
	// validation failures
	| "outputs_missing"
	| "elaboration_insufficient"
	| "spec_validation_failed"
	| "discovery_missing"
	| "dag_cycle_detected"
	| "unit_inputs_missing"
	| "unresolved_dependencies"
	| "unit_naming_invalid"
	| "inputs_missing"
	// terminal / special
	| "blocked"
	| "complete"
	| "error"
	| "escalate"
	| "design_direction_required"
	| "safe_intent_repair"
	| "composite_run_stage"

/** A single FSM state. xstate's machine config will translate these into
 *  state nodes with `entry`, `exit`, and event handlers. The interface
 *  is shaped so a hand-rolled fallback dispatcher could also consume it
 *  if we ever need to bypass xstate (debugging, snapshot inspection). */
export interface FsmState<Name extends StateName = StateName> {
	readonly name: Name
	/** Runs once when the FSM enters this state. Pure side effects:
	 *  state-file mutations, git commits, telemetry. Must NOT decide
	 *  the next transition. */
	onEnter?(ctx: FsmContext): void
	/** Runs once when the FSM leaves this state. Symmetric counterpart
	 *  to `onEnter` for cleanup work (closing iterations, etc.). */
	onExit?(ctx: FsmContext): void
	/** Pure decision function. Reads context, returns a Transition.
	 *  Side effects belong in onEnter/onExit, NOT here. */
	decide(ctx: FsmContext): Transition
}
