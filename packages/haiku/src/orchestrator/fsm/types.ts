// FSM state-machine types.
//
// The `StateName` union enumerates every state the FSM can be in,
// matching the action surface produced by runNext + the per-state
// migrations in run-fsm-tick.ts. Keeping the union exhaustive lets
// TypeScript catch missing cases when emitNativeAction or per-state
// files dispatch on state name.
//
// `FsmContext` is the runtime context xstate threads through every
// state — populated by deriveCurrentState from disk + filled in
// for each machine actor invocation.

/** Runtime context the FSM threads through every state. The legacy
 *  runNext recomputes much of this on every tick by reading
 *  frontmatter + iteration files; the xstate port consolidates
 *  those reads via deriveCurrentState. */
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

/** Discriminator across every concrete state. The string union
 *  mirrors the action types returned by the legacy switch —
 *  extracted from `runNext` and the per-action prompt builders.
 *  Keep this exhaustive so xstate's `assertEvent` and TS
 *  exhaustiveness checks catch missing cases. */
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
	| "pre_review_waiting"
	// intent-completion review
	| "intent_completion_review"
	| "intent_completion_fix"
	// revisit
	| "feedback_revisit"
	| "feedback_dispatch"
	| "revisited"
	| "upstream_finding_surfaced"
	// gates
	| "gate_review"
	| "intent_approved"
	| "awaiting_external_review"
	| "external_review_requested"
	| "external_changes_requested"
	| "gate_blocked"
	| "changes_requested"
	| "revise_unit_specs"
	// validation failures
	| "outputs_missing"
	| "elaboration_insufficient"
	| "discovery_missing"
	| "dag_cycle_detected"
	| "unit_inputs_missing"
	| "unresolved_dependencies"
	| "unit_naming_invalid"
	// ops
	| "commit_wip"
	// terminal / special
	| "blocked"
	| "complete"
	| "error"
	| "escalate"
	| "design_direction_required"
	| "safe_intent_repair"
	| "composite_run_stage"
