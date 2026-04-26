// tools/state/haiku_intent_get.ts — Read a single field from an intent's
// frontmatter.

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { intentDir, parseFrontmatter } from "../../state/shared.js"
import { defineTool } from "../define.js"
import { text } from "./_text.js"

export default defineTool({
	name: "haiku_intent_get",
	description: "Read a field from an intent's frontmatter",
	inputSchema: {
		type: "object" as const,
		properties: { slug: { type: "string" }, field: { type: "string" } },
		required: ["slug", "field"],
	},
	handle(args) {
		const file = join(intentDir(args.slug as string), "intent.md")
		if (!existsSync(file)) return text("")
		const { data } = parseFrontmatter(readFileSync(file, "utf8"))
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
