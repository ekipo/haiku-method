// orchestrator/fsm/native-emit/error.ts — Emit for the `error`
// terminal state.
//
// VARIANTS HANDLED:
//   - Legacy `status === "archived"` (orchestrator.ts:2207) — recover
//     via `/haiku:repair`.
//   - New `archived === true` flag (orchestrator.ts:2214) — recover
//     via `haiku_intent_unarchive`.
//
// Returns null for other error sites (frontmatter parse failures,
// integrity-tamper messages, FSM internal errors) — those still emit
// from runNext until their per-case paths port. The wrapper falls
// back to runNext on null.

import type { NativeEmitter } from "./_types.js"

const emit: NativeEmitter = (ctx) => {
	const status = (ctx.intent.status as string) || ""
	if (status === "archived") {
		return {
			action: "error",
			message: `Intent '${ctx.slug}' has status: archived (legacy/terminal). haiku_intent_unarchive only clears the new \`archived\` field — it does not touch \`status\`. To recover, run \`/haiku:repair\` or manually edit \`.haiku/intents/${ctx.slug}/intent.md\` and set \`status: active\`.`,
		}
	}
	if (ctx.intent.archived === true) {
		return {
			action: "error",
			message: `Intent '${ctx.slug}' is archived. Call haiku_intent_unarchive to restore it.`,
		}
	}
	return null
}

export default emit
