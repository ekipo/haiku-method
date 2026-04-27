// orchestrator/fsm/native-emit/index.ts — Registry of per-state
// OrchestratorAction emitters.
//
// The registry IS the migration progress indicator: every state
// listed here has its own per-state file that owns emission for that
// state name. As more states port, more entries appear here, and the
// corresponding runNext branches get deleted.
//
// `XSTATE_NATIVE_STATES` is derived from the registry keys — there's
// no separate flag to keep in sync. Adding an entry to the registry
// is what makes a state xstate-native.

import type { OrchestratorAction } from "../../../orchestrator.js"
import type { DerivedContext } from "../derive-state.js"
import type { StateName } from "../types.js"
import complete from "./complete.js"
import error from "./error.js"
import selectStudio from "./select-studio.js"
import type { NativeEmitter } from "./_types.js"

/** Per-state emitter registry. Key = state name returned by
 *  derive-state. Value = the emitter for that state. Each emitter
 *  may return null to defer to runNext (see error.ts for the
 *  variant-not-handled-yet case). */
const REGISTRY: Partial<Record<StateName, NativeEmitter>> = {
	complete,
	select_studio: selectStudio,
	error,
}

/** Set of state names that have a registered emitter. Equivalent to
 *  the legacy `XSTATE_NATIVE_STATES` constant — derived from the
 *  registry rather than hand-maintained. */
export const XSTATE_NATIVE_STATES: ReadonlySet<StateName> = new Set(
	Object.keys(REGISTRY) as StateName[],
)

/** Look up a state's emitter and run it. Returns null when the state
 *  isn't registered OR when the emitter returns null (sub-case
 *  deferral to runNext). */
export function emitNativeAction(
	state: StateName,
	context: DerivedContext,
): OrchestratorAction | null {
	const emitter = REGISTRY[state]
	if (!emitter) return null
	return emitter(context)
}
