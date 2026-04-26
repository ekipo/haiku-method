// tools/state/index.ts — Registry of per-tool state handlers.
//
// Each per-tool file under this directory exports a `ToolDef` as its
// default export. The registry collects them into `stateToolHandlers`
// (Map<name, ToolDef>) so `handleStateTool` can dispatch by name with
// a single lookup instead of a giant switch statement.
//
// The remaining (not-yet-extracted) tool cases continue to live in
// state-tools.ts's switch — `handleStateTool` checks the registry
// first, falls back to the switch for unmigrated tools. As more
// tools migrate, the switch shrinks toward zero.

import type { ToolDef } from "../types.js"
import haiku_backlog from "./haiku_backlog.js"
import haiku_capacity from "./haiku_capacity.js"
import haiku_dashboard from "./haiku_dashboard.js"
import haiku_decision_record from "./haiku_decision_record.js"
import haiku_feedback from "./haiku_feedback.js"
import haiku_feedback_delete from "./haiku_feedback_delete.js"
import haiku_feedback_list from "./haiku_feedback_list.js"
import haiku_feedback_reject from "./haiku_feedback_reject.js"
import haiku_feedback_update from "./haiku_feedback_update.js"
import haiku_intent_get from "./haiku_intent_get.js"
import haiku_intent_list from "./haiku_intent_list.js"
import haiku_knowledge_list from "./haiku_knowledge_list.js"
import haiku_knowledge_read from "./haiku_knowledge_read.js"
import haiku_reflect from "./haiku_reflect.js"
import haiku_release_notes from "./haiku_release_notes.js"
import haiku_repair from "./haiku_repair.js"
import haiku_review from "./haiku_review.js"
import haiku_seed from "./haiku_seed.js"
import haiku_settings_get from "./haiku_settings_get.js"
import haiku_stage_get from "./haiku_stage_get.js"
import haiku_studio_get from "./haiku_studio_get.js"
import haiku_studio_list from "./haiku_studio_list.js"
import haiku_studio_stage_get from "./haiku_studio_stage_get.js"
import haiku_unit_get from "./haiku_unit_get.js"
import haiku_unit_increment_bolt from "./haiku_unit_increment_bolt.js"
import haiku_unit_list from "./haiku_unit_list.js"
import haiku_unit_set from "./haiku_unit_set.js"
import haiku_unit_start from "./haiku_unit_start.js"
import haiku_version_info from "./haiku_version_info.js"

export const stateToolHandlers: ReadonlyMap<string, ToolDef> = new Map(
	(
		[
			haiku_backlog,
			haiku_capacity,
			haiku_dashboard,
			haiku_decision_record,
			haiku_feedback,
			haiku_feedback_delete,
			haiku_feedback_list,
			haiku_feedback_reject,
			haiku_feedback_update,
			haiku_intent_get,
			haiku_intent_list,
			haiku_knowledge_list,
			haiku_knowledge_read,
			haiku_reflect,
			haiku_release_notes,
			haiku_repair,
			haiku_review,
			haiku_seed,
			haiku_settings_get,
			haiku_stage_get,
			haiku_studio_get,
			haiku_studio_list,
			haiku_studio_stage_get,
			haiku_unit_get,
			haiku_unit_increment_bolt,
			haiku_unit_list,
			haiku_unit_set,
			haiku_unit_start,
			haiku_version_info,
		] satisfies ToolDef[]
	).map((t) => [t.name, t]),
)
