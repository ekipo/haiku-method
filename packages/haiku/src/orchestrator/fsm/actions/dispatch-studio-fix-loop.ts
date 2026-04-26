// orchestrator/fsm/actions/dispatch-studio-fix-loop.ts — Entry
// action for the studio-level `intent_completion_fix` state.
//
// FIRES WHEN: studio-level review-agents produced findings (logged
// at intent scope, no `stage:` field). The FSM dispatches the
// studio's fix-hat sequence against each finding in parallel,
// similar to per-stage review_fix but at intent scope.
//
// CONTEXT IT READS:
//   - context.slug, context.studio — telemetry + dispatch.
//   - StudioConfig.studioFixHats — the fix-hat sequence.
//   - Pending intent-scope feedback files —
//     readFeedbackFiles(slug, "") returns intent-scope items.
//
// SIDE EFFECTS (current): telemetry only.
//
// SIDE EFFECTS (when migrated): for each finding, allocate an
// isolation worktree (createFixChainWorktree), increment per-finding
// bolt counter (incrementFeedbackBolt), commit the dispatch.
// All pure side effects on top of feedback frontmatter + git.
//
// EMISSION (when migrated): { action: "intent_completion_fix",
// intent, fix_hats: [...], items: [{ feedback_id, feedback_file,
// feedback_title, bolt, worktree, branch }, ...], total_pending,
// escalated_count, max_bolts: MAX_FIX_LOOP_BOLTS, message }.
// Mirrors the per-stage review_fix shape but with studio-level
// fix-hats and intent-scope feedback. Already covered by the
// prompt builder at orchestrator/prompts/intent_completion_fix.ts.
//
// RUNNEXT CORRESPONDENCE: orchestrator.ts where action ===
// "intent_completion_fix" — the dispatch path that allocates
// worktrees + emits the per-finding chain.

import { assign } from "xstate"
import { type ActionContext, traceEntry } from "./_shared.js"

export default assign(({ context }) => {
	const ctx = context as ActionContext
	traceEntry("intent_completion_fix", { slug: ctx.slug ?? "" })
	return { _lastEntry: "intent_completion_fix" }
})
