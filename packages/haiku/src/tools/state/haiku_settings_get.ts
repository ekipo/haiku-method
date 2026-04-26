// tools/state/haiku_settings_get.ts — Read a nested field from
// `.haiku/settings.yml`.

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
	getNestedField,
	parseYaml,
} from "../../state/frontmatter.js"
import { findHaikuRoot } from "../../state/shared.js"
import { defineTool } from "../define.js"
import { text } from "./_text.js"

export default defineTool({
	name: "haiku_settings_get",
	description: "Read a (possibly nested) field from .haiku/settings.yml",
	inputSchema: {
		type: "object" as const,
		properties: { field: { type: "string" } },
		required: ["field"],
	},
	handle(args) {
		const field = args.field as string
		let settingsPath = ""
		try {
			settingsPath = join(findHaikuRoot(), "settings.yml")
		} catch {
			/* */
		}
		if (!(settingsPath && existsSync(settingsPath))) return text("")
		const raw = readFileSync(settingsPath, "utf8")
		const settings = parseYaml(raw)
		const val = getNestedField(settings, field)
		if (val == null) return text("")
		return text(typeof val === "object" ? JSON.stringify(val) : String(val))
	},
})
