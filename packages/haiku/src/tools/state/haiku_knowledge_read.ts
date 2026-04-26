// tools/state/haiku_knowledge_read.ts — Read the contents of a knowledge file.

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { intentDir } from "../../state/shared.js"
import { defineTool } from "../define.js"
import { text } from "./_text.js"

export default defineTool({
	name: "haiku_knowledge_read",
	description: "Read a knowledge file's contents for an intent",
	inputSchema: {
		type: "object" as const,
		properties: {
			intent: { type: "string" },
			name: { type: "string" },
		},
		required: ["intent", "name"],
	},
	handle(args) {
		const path = join(
			intentDir(args.intent as string),
			"knowledge",
			args.name as string,
		)
		if (!existsSync(path)) return text("")
		return text(readFileSync(path, "utf8"))
	},
})
