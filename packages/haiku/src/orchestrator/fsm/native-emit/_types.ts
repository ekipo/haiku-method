// orchestrator/fsm/native-emit/_types.ts — Per-state OrchestratorAction
// emitter contract.
//
// Each file in native-emit/ exports a default function with this
// signature. The registry in `index.ts` collects them keyed by
// StateName. `runFsmTick` consults the registry; if the derived
// state has a per-state emitter that returns non-null, the result
// flows back as the xstate-driver action. If the emitter returns
// null (a sub-case it doesn't handle), the wrapper falls back to
// runNext until that sub-case ports too.
//
// This pattern is the single source of truth for emission as states
// migrate. Adding a state = adding a file + registering it. Deleting
// the corresponding runNext branch = the state is fully migrated.

import type { OrchestratorAction } from "../../../orchestrator.js"
import type { DerivedContext } from "../derive-state.js"

/** Emit an OrchestratorAction for a derived state. May perform side
 *  effects (FSM writes, git operations) — the runNext counterpart
 *  does. Return null to defer to runNext when this emitter doesn't
 *  yet handle the input's sub-case. */
export type NativeEmitter = (
	context: DerivedContext,
) => OrchestratorAction | null
