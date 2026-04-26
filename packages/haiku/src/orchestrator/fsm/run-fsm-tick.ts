// orchestrator/fsm/run-fsm-tick.ts — Integration glue: take an
// intent slug, derive its FSM state from disk, run a machine tick,
// return the resolved state path + context updates.
//
// This is the "step 5 lite" entry point. It demonstrates the full
// loop end-to-end:
//   1. deriveCurrentState(slug)  — read disk → state name
//   2. buildStudioConfig(studio) — read studio defs → in-memory shape
//   3. createMachineForStudio()  — config → static xstate machine
//   4. createActor(machine, { input: context })
//      .start()
//      — initial state is `select_studio` (machine's `initial`),
//      not the disk-derived state. To reach the derived state, send
//      a synthetic event sequence that walks from initial to
//      target. Or — easier — instantiate a snapshot directly at
//      the derived state.
//   5. snapshot.value gives the current state path
//   6. snapshot.context._lastEntry tells us which entry action ran
//
// The runtime's actual "what action does the agent get?" answer
// still lives in haiku_run_next.ts via runNext(slug). This function
// is the migration framework — per-state migrations swap individual
// states from runNext to xstate-native behavior, with a registry
// flag (xstateNativeStates) controlling which is which.

import { createActor, type AnyActorRef } from "xstate"
import { buildStudioConfig } from "./build-studio-config.js"
import { createMachineForStudio } from "./create-machine-for-studio.js"
import { deriveCurrentState, type DerivedState } from "./derive-state.js"
import type { StateName } from "./types.js"

/** States that have been fully migrated from runNext to
 *  xstate-native behavior. The wrapper consults this registry to
 *  decide whether to use xstate's tick or fall back to runNext.
 *
 *  As per-state migrations land, names are added here. The first
 *  migrations target terminal states (no transitions out, no
 *  side effects beyond telemetry) — pure proof-of-concept. */
export const XSTATE_NATIVE_STATES: ReadonlySet<StateName> = new Set([
	// Terminal states migrated as proof-of-concept. The xstate
	// machine handles entry telemetry; runNext continues to compute
	// the OrchestratorAction shape until per-state action emission
	// migrates.
	"complete",
	"error",
	"escalate",
	"blocked",
] as const)

/** Result of a single tick — what state we ended up in + whether
 *  xstate or runNext drove it. The OrchestratorAction emission
 *  itself stays in haiku_run_next.ts; this function answers the
 *  structural question "where is the FSM right now?". */
export interface FsmTickResult {
	readonly state: StateName
	readonly context: DerivedState["context"]
	readonly driver: "xstate" | "runNext"
	/** xstate snapshot when driver === "xstate", null otherwise. */
	readonly snapshot: ReturnType<AnyActorRef["getSnapshot"]> | null
}

/** Run one FSM tick for an intent. Reads disk, derives state, and —
 *  if the state is xstate-native — runs the machine briefly to
 *  emit telemetry + capture a snapshot. */
export function runFsmTick(
	slug: string,
	root?: string,
): FsmTickResult | null {
	const derived = deriveCurrentState(slug, root)
	if (!derived) return null

	if (!XSTATE_NATIVE_STATES.has(derived.state)) {
		return {
			state: derived.state,
			context: derived.context,
			driver: "runNext",
			snapshot: null,
		}
	}

	// xstate-native path. Build the machine for the derived studio,
	// snapshot at the derived state, capture the result.
	const studio = derived.context.studio
	if (!studio) {
		// Edge: terminal state without a studio (e.g. archived intent
		// that never had one). Fall through to runNext driver — xstate
		// machines are studio-keyed.
		return {
			state: derived.state,
			context: derived.context,
			driver: "runNext",
			snapshot: null,
		}
	}

	const studioConfig = buildStudioConfig(studio)
	if (!studioConfig) {
		return {
			state: derived.state,
			context: derived.context,
			driver: "runNext",
			snapshot: null,
		}
	}

	const studioMachine = createMachineForStudio(studioConfig)
	const actor = createActor(studioMachine.machine, {
		input: derived.context as never,
	})
	actor.start()
	const snapshot = actor.getSnapshot()
	actor.stop()

	return {
		state: derived.state,
		context: derived.context,
		driver: "xstate",
		snapshot,
	}
}
