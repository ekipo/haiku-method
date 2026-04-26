// orchestrator/fsm/actions/start-stage.ts — Entry action for a
// stage's `start_stage` sub-state.
//
// FIRES WHEN: a stage transitions from "not yet entered" to its
// initial sub-state. Specifically, when intent.active_stage is
// empty (first-ever entry into the intent's first stage) OR the
// active stage's state.json has status="pending" (re-entry after
// a reset, or a freshly-created stage on the next tick after
// stage-advance).
//
// CONTEXT IT READS:
//   - context.slug — telemetry correlation.
//   - context.currentStage — the stage being started. Empty when
//     active_stage isn't set yet; the deeper migration will need
//     to resolve "first stage from studio" using StudioConfig.
//
// SIDE EFFECTS (current): telemetry only.
//
// SIDE EFFECTS (when migrated): the heavyweight `fsmStartStage()`
// from orchestrator.ts:1425. That function performs:
//   - createIntentBranch(slug) — git topology setup
//   - cleanupOrphanedStageBranches(slug) — pre-stage sweep
//   - merge prev stage → main + delete its branch
//   - Guard 1 pos-0 reset (state.json on intent main)
//   - Stage branch checkout (or create) + merge-forward
//   - Local pos-0 mirror + first iteration append
//   - intent.md `active_stage` field write + git commit + reseal
//
// EMISSION (when migrated): the OrchestratorAction shape is { action:
// "start_stage", intent, studio, stage, hats, phase: "elaborate",
// stage_metadata, follows?, parent_knowledge?, message }. The hats
// list comes from resolveStageHats(studio, stage); follows/
// parent_knowledge from intent frontmatter + filesystem walk of
// the parent intent's knowledge directory.
//
// RUNNEXT CORRESPONDENCE: orchestrator.ts:2434-2470 — the `if
// (!phase || stageStatus === "pending")` branch. The emission and
// side effect (fsmStartStage call + error wrap) live there today.

import { assign } from "xstate"
import { type ActionContext, traceEntry } from "./_shared.js"

export default assign(({ context }) => {
	const ctx = context as ActionContext
	traceEntry("start_stage", {
		slug: ctx.slug ?? "",
		stage: ctx.currentStage ?? "",
	})
	return {
		_lastEntry: "start_stage",
		_lastEntryMeta: { stage: ctx.currentStage ?? "" },
	}
})
