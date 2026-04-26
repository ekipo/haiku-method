// tools/state/haiku_seed.ts — Manage .haiku/seeds/ — forward-looking
// ideas with trigger conditions. Sub-actions: list, plant, check.

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { findHaikuRoot, parseFrontmatter, timestamp } from "../../state/shared.js"
import { defineTool } from "../define.js"
import { text } from "./_text.js"

export default defineTool({
	name: "haiku_seed",
	description:
		"Manage .haiku/seeds/ forward-looking ideas with trigger conditions. action: list (default) | plant | check.",
	inputSchema: {
		type: "object" as const,
		properties: {
			action: { type: "string", enum: ["list", "plant", "check"] },
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
		const seedsDir = join(root, "seeds")

		switch (action) {
			case "list": {
				if (!existsSync(seedsDir)) return text("No seeds found.")
				const files = readdirSync(seedsDir).filter((f) => f.endsWith(".md"))
				if (files.length === 0) return text("No seeds found.")

				const groups = new Map<
					string,
					Array<{ name: string; data: Record<string, unknown> }>
				>()
				for (const f of files) {
					const { data } = parseFrontmatter(
						readFileSync(join(seedsDir, f), "utf8"),
					)
					const status = (data.status as string) || "planted"
					if (!groups.has(status)) groups.set(status, [])
					groups.get(status)?.push({ name: f.replace(".md", ""), data })
				}

				let out = "# Seeds\n"
				for (const [status, seeds] of groups) {
					out += `\n## ${status.charAt(0).toUpperCase() + status.slice(1)} (${seeds.length})\n\n`
					out += "| Seed | Trigger | Planted |\n|------|---------|----------|\n"
					for (const s of seeds) {
						out += `| ${s.name} | ${s.data.trigger || "none"} | ${s.data.created_at || "unknown"} |\n`
					}
				}
				return text(out)
			}
			case "plant": {
				let out = "## Plant a Seed\n\n"
				out += "Create a new file in `.haiku/seeds/` with this template:\n\n"
				out += `\`\`\`markdown\n---\nstatus: planted\ntrigger: "<condition that should cause this to surface>"\ncreated_at: ${timestamp()}\n---\n\n`
				out += "Description of the idea or future work.\n```\n"
				out +=
					"\nFilename should be a slug of the seed idea (e.g. `add-caching-layer.md`).\n"
				return text(out)
			}
			case "check": {
				if (!existsSync(seedsDir)) return text("No seeds to check.")
				const files = readdirSync(seedsDir).filter((f) => f.endsWith(".md"))
				const planted = files.filter((f) => {
					const { data } = parseFrontmatter(
						readFileSync(join(seedsDir, f), "utf8"),
					)
					return (data.status as string) === "planted"
				})
				if (planted.length === 0) return text("No planted seeds to check.")

				let out =
					"## Seed Check\n\nEvaluate each planted seed's trigger condition against the current project state:\n\n"
				for (const f of planted) {
					const { data, body } = parseFrontmatter(
						readFileSync(join(seedsDir, f), "utf8"),
					)
					out += `### ${f.replace(".md", "")}\n`
					out += `- Trigger: ${data.trigger || "none defined"}\n`
					out += `- Description: ${body.slice(0, 300)}\n\n`
				}
				out +=
					"---\nFor each seed: if the trigger condition is met, update its status to 'surfaced'. If not, leave as 'planted'.\n"
				return text(out)
			}
			default:
				return text(
					`Unknown seed action: '${action}'. Valid actions: list, plant, check.`,
				)
		}
	},
})
