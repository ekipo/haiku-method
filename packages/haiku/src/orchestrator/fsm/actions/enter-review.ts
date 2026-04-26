// orchestrator/fsm/actions/enter-review.ts — Entry action for a
// stage's `review` phase.
//
// FIRES WHEN: the execute sub-machine reaches its `done` final
// state, causing the parent stage to transition execute → review.
// At that point all units in the stage are completed and the
// adversarial review can fire.
//
// CONTEXT IT READS:
//   - context.slug, context.currentStage — telemetry correlation.
//
// SIDE EFFECTS (current): telemetry only.
//
// SIDE EFFECTS (when migrated): the entry action will mark the
// stage state.json's phase=review (today done by fsmAdvancePhase),
// then dispatch the per-stage review-agent fan-out. Side effect is
// a single state.json write + git commit.
//
// EMISSION (when migrated): { action: "review", intent, stage,
// agents (filtered by applies_to + cross-stage includes), message
// }. The agent list comes from readReviewAgentPaths +
// filterReviewAgentsByScope, plus review-agents-include from the
// stage's STAGE.md frontmatter (cross-stage agent reuse). All of
// that is captured in StudioConfig.stages[stage].reviewAgents +
// reviewAgentsInclude.
//
// RUNNEXT CORRESPONDENCE: orchestrator.ts where phase === "review"
// — the adversarial review dispatch. Emission shape lives in the
// matching prompt builder at orchestrator/prompts/review.ts (which
// has already been extracted in task #13).

import { assign } from "xstate"
import { type ActionContext, traceEntry } from "./_shared.js"

export default assign(({ context }) => {
	const ctx = context as ActionContext
	traceEntry("review", {
		slug: ctx.slug ?? "",
		stage: ctx.currentStage ?? "",
	})
	return {
		_lastEntry: "review",
		_lastEntryMeta: { stage: ctx.currentStage ?? "" },
	}
})
