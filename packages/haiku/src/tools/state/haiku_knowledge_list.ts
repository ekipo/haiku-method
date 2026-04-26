// tools/state/haiku_knowledge_list.ts — List knowledge files for an intent.

import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { intentDir } from "../../state/shared.js"
import { defineTool } from "../define.js"
import { text } from "./_text.js"

export default defineTool({
	name: "haiku_knowledge_list",
	description: "List knowledge files for an intent",
	inputSchema: {
		type: "object" as const,
		properties: { intent: { type: "string" } },
		required: ["intent"],
	},
	handle(args) {
		const dir = join(intentDir(args.intent as string), "knowledge")
		if (!existsSync(dir)) return text("[]")
		const files = readdirSync(dir).filter((f) => f.endsWith(".md"))
		return text(JSON.stringify(files))
	},
})
