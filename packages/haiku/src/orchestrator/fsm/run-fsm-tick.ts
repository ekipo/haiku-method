// orchestrator/fsm/run-fsm-tick.ts — Integration glue: take an
// intent slug, derive its FSM state from disk, run a machine tick,
// return the resolved state path + context updates.
//
// The action emission flows through the per-state registry in
// native-emit/. Each registered state has its own file owning its
// emission (and any side effects). When an emitter returns null —
// either the state isn't registered or the registered emitter
// deferred a sub-case — the wrapper falls back to runNext until that
// sub-case ports.
//
// As more states port to native-emit/, more entries appear in
// XSTATE_NATIVE_STATES, and the corresponding runNext branches get
// deleted. The registry IS the source of truth for migration
// progress; this file does not maintain a parallel switch.

import { createActor, type AnyActorRef } from "xstate"
import type { OrchestratorAction } from "../../orchestrator.js"
import { buildStudioConfig } from "./build-studio-config.js"
import { createMachineForStudio } from "./create-machine-for-studio.js"
import {
	type DerivedState,
	deriveCurrentState,
} from "./derive-state.js"
import {
	emitNativeAction as registryEmit,
	XSTATE_NATIVE_STATES as REGISTRY_KEYS,
} from "./native-emit/index.js"
import type { StateName } from "./types.js"

/** Re-export of the per-state registry's key set for callers that
 *  want to test "is this state migrated?" without importing the
 *  registry directly. Kept for back-compat with tests. */
export const XSTATE_NATIVE_STATES: ReadonlySet<StateName> = REGISTRY_KEYS

/** Re-export of the registry-backed emitter. Kept for back-compat
 *  with tests + external callers that still import this name. */
export const emitNativeAction = registryEmit

/** Result of a single tick. The `action` field is the
 *  OrchestratorAction the agent should follow when driver ===
 *  "xstate"; runNext-driven results carry null and the caller falls
 *  back to runNext(slug). */
export interface FsmTickResult {
	readonly state: StateName
	readonly context: DerivedState["context"]
	readonly driver: "xstate" | "runNext"
	readonly action: OrchestratorAction | null
	/** xstate snapshot when driver === "xstate", null otherwise. */
	readonly snapshot: ReturnType<AnyActorRef["getSnapshot"]> | null
}

/** Run one FSM tick for an intent. Reads disk, derives state, and —
 *  if the state has a per-state emitter registered — runs the
 *  emitter to produce the OrchestratorAction. Spins up the studio
 *  machine briefly to capture a snapshot for telemetry. */
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
			action: null,
			snapshot: null,
		}
	}

	const action = emitNativeAction(derived.state, derived.context, root)

	const studio = derived.context.studio
	let snapshot: ReturnType<AnyActorRef["getSnapshot"]> | null = null
	if (studio) {
		const studioConfig = buildStudioConfig(studio)
		if (studioConfig) {
			const studioMachine = createMachineForStudio(studioConfig)
			const actor = createActor(studioMachine.machine, {
				input: derived.context as never,
			})
			actor.start()
			snapshot = actor.getSnapshot()
			actor.stop()
		}
	}

	if (!action) {
		return {
			state: derived.state,
			context: derived.context,
			driver: "runNext",
			action: null,
			snapshot,
		}
	}

	return {
		state: derived.state,
		context: derived.context,
		driver: "xstate",
		action,
		snapshot,
	}
}
