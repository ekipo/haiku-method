// orchestrator/fsm/actions/select-studio.ts — Entry action for the
// `select_studio` state.
//
// FIRES WHEN: a tick lands on the machine's `select_studio` state —
// either the machine's initial state on first entry, or via the
// `studio.selected` event firing on the parent (which currently
// transitions to the first stage, but the entry action runs at
// machine creation regardless).
//
// CONTEXT IT READS:
//   - context.slug — the intent identifier, used for telemetry
//     correlation.
//
// SIDE EFFECTS (current): telemetry only.
//
// SIDE EFFECTS (when migrated): none. `select_studio` is a pure
// "tell the agent to call haiku_select_studio" emission. The actual
// studio writes happen in the haiku_select_studio MCP tool, not
// here.
//
// EMISSION (when migrated): runFsmTick already routes the live
// runtime to xstate for this state via emitNativeAction in
// run-fsm-tick.ts. The action here is the telemetry/tracing side;
// the OrchestratorAction shape is built by emitNativeAction. This
// split exists because the emission is studio-list-dependent
// (listStudios()) and per-action files don't read studio state
// directly — that lives in StudioConfig.
//
// RUNNEXT CORRESPONDENCE: orchestrator.ts:2161-2177 — `if
// (!studio)` branch returning { action: "select_studio", intent,
// available_studios, message }. emitNativeAction at
// run-fsm-tick.ts:emitNativeAction is byte-identical.

import { assign } from "xstate"
import { type ActionContext, traceEntry } from "./_shared.js"

export default assign(({ context }) => {
	const ctx = context as ActionContext
	traceEntry("select_studio", { slug: ctx.slug ?? "" })
	return { _lastEntry: "select_studio" }
})
