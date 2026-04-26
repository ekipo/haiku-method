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
import haiku_intent_get from "./haiku_intent_get.js"
import haiku_intent_list from "./haiku_intent_list.js"
import haiku_knowledge_list from "./haiku_knowledge_list.js"
import haiku_knowledge_read from "./haiku_knowledge_read.js"
import haiku_stage_get from "./haiku_stage_get.js"
import haiku_studio_get from "./haiku_studio_get.js"
import haiku_studio_list from "./haiku_studio_list.js"
import haiku_studio_stage_get from "./haiku_studio_stage_get.js"
import haiku_unit_get from "./haiku_unit_get.js"

export const stateToolHandlers: ReadonlyMap<string, ToolDef> = new Map(
	(
		[
			haiku_intent_get,
			haiku_intent_list,
			haiku_knowledge_list,
			haiku_knowledge_read,
			haiku_stage_get,
			haiku_studio_get,
			haiku_studio_list,
			haiku_studio_stage_get,
			haiku_unit_get,
		] satisfies ToolDef[]
	).map((t) => [t.name, t]),
)
