// tools/state/haiku_unit_get.ts — Read a single field from a unit's
// frontmatter.

import { existsSync, readFileSync } from "node:fs"
import { parseFrontmatter, unitPath } from "../../state/shared.js"
import { defineTool } from "../define.js"
import { text } from "./_text.js"

export default defineTool({
	name: "haiku_unit_get",
	description: "Read a field from a unit's frontmatter",
	inputSchema: {
		type: "object" as const,
		properties: {
			intent: { type: "string" },
			stage: { type: "string" },
			unit: { type: "string" },
			field: { type: "string" },
		},
		required: ["intent", "stage", "unit", "field"],
	},
	handle(args) {
		const path = unitPath(
			args.intent as string,
			args.stage as string,
			args.unit as string,
		)
		if (!existsSync(path)) return text("")
		const { data } = parseFrontmatter(readFileSync(path, "utf8"))
		const val = data[args.field as string]
		return text(
			val == null
				? ""
				: typeof val === "object"
					? JSON.stringify(val)
					: String(val),
		)
	},
})
