// orchestrator/workflow/handlers/complete.ts — Emit for the `complete`
// terminal state.
//
// FIRES WHEN: derive-state sees `intent.status === "completed"`.
// Pure function of context.slug; the runNext counterpart at
// orchestrator.ts:2200 produces the byte-identical shape.
//
// Defensive checkout: re-asserts `haiku/<slug>/main` on every tick
// against an already-completed intent, in case a prior subagent or
// manual merge left HEAD on a stage branch.

import { ensureOnIntentMain } from "../../../git-worktree.js"
import type { WorkflowHandler } from "./_types.js"

const emit: WorkflowHandler = (ctx) => {
	ensureOnIntentMain(ctx.slug)
	return {
		action: "complete",
		message: `Intent '${ctx.slug}' is already completed`,
	}
}

export default emit
