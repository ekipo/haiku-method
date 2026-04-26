// tools/state/haiku_stage_get.ts — Read a single field from a stage's
// state.json.

import { readJson, stageStatePath } from "../../state/shared.js"
import { defineTool } from "../define.js"
import { text } from "./_text.js"

export default defineTool({
	name: "haiku_stage_get",
	description: "Read a field from a stage's state.json",
	inputSchema: {
		type: "object" as const,
		properties: {
			intent: { type: "string" },
			stage: { type: "string" },
			field: { type: "string" },
		},
		required: ["intent", "stage", "field"],
	},
	handle(args) {
		const path = stageStatePath(args.intent as string, args.stage as string)
		const data = readJson(path)
		const val = data[args.field as string]
		return text(val == null ? "" : String(val))
	},
})
