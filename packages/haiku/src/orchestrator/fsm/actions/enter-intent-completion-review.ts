// orchestrator/fsm/actions/enter-intent-completion-review.ts — Entry
// action for the studio-level `intent_completion_review` state.
//
// FIRES WHEN: the final stage's gate has passed AND the studio
// ships studio-level review-agents AND
// intent.intent_completion_review !== false. This is the
// once-per-intent terminal bookend that audits cross-stage artifacts
// against studio-wide standards before the final approval gate.
//
// CONTEXT IT READS:
//   - context.slug, context.studio — for telemetry + dispatch.
//   - StudioConfig.studioReviewAgents (via the machine's meta) —
//     the list of agents to fan out.
//
// SIDE EFFECTS (current): telemetry only.
//
// SIDE EFFECTS (when migrated): set
// intent.completion_review_dispatched = true on intent.md so the
// next tick recognizes the review is in flight (and emits
// intent_completion_fix or the final gate when all findings close).
// fsmEnterIntentCompletionReview() does this work today; the
// migration moves it into this entry.
//
// EMISSION (when migrated): { action: "intent_completion_review",
// intent, studio, agents: [name1, name2, ...], message }. The
// studio review agents are read via readStudioReviewAgentPaths
// (already cached in StudioConfig). Already covered by the prompt
// builder at orchestrator/prompts/intent_completion_review.ts.
//
// RUNNEXT CORRESPONDENCE: completeOrReviewIntent() at
// orchestrator.ts:1713 — the branch that calls
// fsmEnterIntentCompletionReview() and emits the review action
// with the agent list.

import { assign } from "xstate"
import { type ActionContext, traceEntry } from "./_shared.js"

export default assign(({ context }) => {
	const ctx = context as ActionContext
	traceEntry("intent_completion_review", { slug: ctx.slug ?? "" })
	return { _lastEntry: "intent_completion_review" }
})
