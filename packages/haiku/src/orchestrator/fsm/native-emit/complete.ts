// orchestrator/fsm/native-emit/complete.ts — Emit for the `complete`
// terminal state.
//
// FIRES WHEN: derive-state sees `intent.status === "completed"`.
// Pure function of context.slug; the runNext counterpart at
// orchestrator.ts:2200 produces the byte-identical shape.

import type { NativeEmitter } from "./_types.js"

const emit: NativeEmitter = (ctx) => ({
	action: "complete",
	message: `Intent '${ctx.slug}' is already completed`,
})

export default emit
