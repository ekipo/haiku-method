// tools/state/haiku_backlog.ts — Manage the .haiku/backlog/ parking
// lot for ideas not ready for planning. Sub-actions: list, add,
// review, promote.

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { findHaikuRoot, parseFrontmatter, timestamp } from "../../state/shared.js"
import { defineTool } from "../define.js"
import { text } from "./_text.js"

export default defineTool({
	name: "haiku_backlog",
	description:
		"Manage .haiku/backlog/ parking lot. action: list (default) | add | review | promote.",
	inputSchema: {
		type: "object" as const,
		properties: {
			action: { type: "string", enum: ["list", "add", "review", "promote"] },
			description: { type: "string" },
		},
	},
	handle(args) {
		const action = (args.action as string) || "list"
		let root: string
		try {
			root = findHaikuRoot()
		} catch {
			return text("No .haiku directory found.")
		}
		const backlogDir = join(root, "backlog")

		switch (action) {
			case "list": {
				if (!existsSync(backlogDir)) return text("No backlog items found.")
				const files = readdirSync(backlogDir).filter((f) => f.endsWith(".md"))
				if (files.length === 0) return text("No backlog items found.")

				let out =
					"# Backlog\n\n| # | Item | Priority | Created |\n|---|------|----------|---------|\n"
				for (let i = 0; i < files.length; i++) {
					const { data } = parseFrontmatter(
						readFileSync(join(backlogDir, files[i]), "utf8"),
					)
					out += `| ${i + 1} | ${files[i].replace(".md", "")} | ${data.priority || "unset"} | ${data.created_at || "unknown"} |\n`
				}
				return text(out)
			}
			case "add": {
				const desc = (args.description as string) || ""
				let out = "## Add Backlog Item\n\n"
				out += "Create a new file in `.haiku/backlog/` with this template:\n\n"
				out += `\`\`\`markdown\n---\npriority: medium\ncreated_at: ${timestamp()}\n---\n\n`
				out += `${desc || "Description of the backlog item"}\n\`\`\`\n`
				out +=
					"\nFilename should be a slug of the item description (e.g. `improve-error-handling.md`).\n"
				return text(out)
			}
			case "review": {
				if (!existsSync(backlogDir)) return text("No backlog items to review.")
				const files = readdirSync(backlogDir).filter((f) => f.endsWith(".md"))
				if (files.length === 0) return text("No backlog items to review.")

				let out =
					"## Backlog Review\n\nPresent each item to the user and ask: **Keep / Reprioritize / Drop / Promote / Skip**\n\n"
				for (let i = 0; i < files.length; i++) {
					const raw = readFileSync(join(backlogDir, files[i]), "utf8")
					const { data, body } = parseFrontmatter(raw)
					out += `### ${i + 1}. ${files[i].replace(".md", "")}\n`
					out += `- Priority: ${data.priority || "unset"}\n`
					out += `- Created: ${data.created_at || "unknown"}\n`
					out += `${body.slice(0, 300)}\n\n`
				}
				out += "---\nFor each item, ask the user and apply their choice.\n"
				return text(out)
			}
			case "promote": {
				let out = "## Promote Backlog Item\n\n"
				out += "To promote a backlog item to an intent:\n"
				out += "1. Read the backlog item file\n"
				out += "2. Use /haiku:start to create an intent from its description\n"
				out += "3. Delete the backlog file after the intent is created\n"
				return text(out)
			}
			default:
				return text(
					`Unknown backlog action: '${action}'. Valid actions: list, add, review, promote.`,
				)
		}
	},
})
