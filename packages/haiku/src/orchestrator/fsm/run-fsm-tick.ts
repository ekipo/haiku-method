// orchestrator/fsm/run-fsm-tick.ts — Workflow-engine tick. Read disk
// → derive current state → run pre-tick consistency repair → dispatch
// the per-state handler → return the action.
//
// This is the runtime entry point for the H·AI·K·U workflow engine.
// State of record is on disk (intent.md frontmatter + per-stage
// state.json files); each tick is a fresh derive-from-disk →
// dispatch → emit cycle. There is no in-memory state machine, no
// long-lived actor — the durability + replayability comes from the
// fact that every tick reads its own truth.
//
// Per-state handlers live in `native-emit/{state}.ts`. The registry
// in `native-emit/index.ts` maps state names to handlers. Adding a
// new state name = adding the entry to the registry + the file.

import type { OrchestratorAction } from "../../orchestrator.js"
import { verifyIntentState } from "../../state-integrity.js"
import {
	type DerivedState,
	deriveCurrentState,
} from "./derive-state.js"
import {
	emitNativeAction as registryEmit,
	XSTATE_NATIVE_STATES as REGISTRY_KEYS,
} from "./native-emit/index.js"
import { preTickConsistency } from "./pre-tick.js"
import type { StateName } from "./types.js"

/** Set of state names with a registered handler. Currently every
 *  derive-state output has one. Kept as a public re-export for
 *  back-compat with tests that probed registry membership during the
 *  migration. */
export const XSTATE_NATIVE_STATES: ReadonlySet<StateName> = REGISTRY_KEYS

/** The dispatch function. Look up a state's handler in the registry
 *  and run it. Re-exported so callers can invoke a handler directly
 *  (mostly used by tests verifying handler-level behavior). */
export const emitNativeAction = registryEmit

/** Result of a single workflow tick. The `action` field is the
 *  OrchestratorAction the agent should follow. `driver` is always
 *  "xstate" today (back-compat field name; the runtime is our own
 *  dispatch loop, not xstate — see CLAUDE.md notes on the rip). */
export interface FsmTickResult {
	readonly state: StateName
	readonly context: DerivedState["context"]
	readonly driver: "xstate" | "runNext"
	readonly action: OrchestratorAction | null
	readonly snapshot: null
}

/** Run one workflow tick for an intent. Steps:
 *
 *   1. Pre-tick consistency repair (may mutate disk, may short-circuit
 *      with a safe_intent_repair action).
 *   2. Derive the current state from disk.
 *   3. Tamper detection (refuse to advance on integrity-violated
 *      intents).
 *   4. Look up the handler for the derived state and run it.
 *
 *  Returns null only when the intent doesn't exist on disk. */
export function runFsmTick(
	slug: string,
	root?: string,
): FsmTickResult | null {
	const repair = preTickConsistency(slug, root)

	const derived = deriveCurrentState(slug, root)
	if (!derived) return null

	if (repair) {
		return {
			state: "error",
			context: derived.context,
			driver: "xstate",
			action: repair,
			snapshot: null,
		}
	}

	const tamperError = verifyIntentState(slug)
	if (tamperError) {
		return {
			state: "error",
			context: derived.context,
			driver: "xstate",
			action: { action: "error", message: tamperError },
			snapshot: null,
		}
	}

	const action = emitNativeAction(derived.state, derived.context, root)

	return {
		state: derived.state,
		context: derived.context,
		driver: action ? "xstate" : "runNext",
		action,
		snapshot: null,
	}
}
