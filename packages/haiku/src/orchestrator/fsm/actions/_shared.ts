// orchestrator/fsm/actions/_shared.ts — Shared types and helpers
// for per-file FSM action modules.
//
// Each action file under this directory exports a single
// xstate-compatible action function as its default export. The
// registry in `./index.ts` collects them into the actions object
// passed to createMachine's second argument.
//
// Why per-file? Same reasoning as the rest of this refactor:
// per-file modules give the visualizer a click-target (Stately
// Studio's VS Code extension can jump from a state's `entry: "x"`
// label to actions/x.ts), they make the action's contract
// reviewable in isolation, and they let the per-action migration
// from runNext land state-by-state without disturbing siblings.
//
// The current implementation: each action is a thin wrapper that
// emits telemetry on entry + assigns _lastEntry metadata onto
// context. As per-state migrations port runNext's emission paths,
// each action will additionally:
//   1. Read the disk state derived in derive-state.ts.
//   2. Perform any side effects (FSM writes, git operations) that
//      the corresponding runNext branch performs today.
//   3. Assign the resulting OrchestratorAction onto context so the
//      wrapping runFsmTick reads it after the tick.
//
// The action contract:
//   - Receives { context, event } from xstate.
//   - Returns a partial context update via the `assign` helper.
//   - Pure-by-design as a Function (no closures captured at module
//     load); xstate will call it fresh on every state entry.

import { emitTelemetry } from "../../../telemetry.js"
import type { FsmContext } from "../types.js"

/** Context extension carrying state-entry tracing metadata. The
 *  wrapping runFsmTick reads `_lastEntry` to know which entry
 *  action ran during the tick. Per-state migrations will add more
 *  fields (e.g. `_outputAction`) as actions take over emission
 *  from runNext. */
export interface ActionContext extends FsmContext {
	readonly _lastEntry?: string
	readonly _lastEntryMeta?: Record<string, unknown>
}

/** Convenience: emit telemetry for state entry. Every action calls
 *  this with its state name and any extra fields. Centralizing it
 *  here means changing the telemetry contract once instead of in
 *  ten files. */
export function traceEntry(
	state: string,
	fields: Record<string, string> = {},
): void {
	emitTelemetry("haiku.fsm.entry", { state, ...fields })
}
