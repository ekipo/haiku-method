// tools/state/haiku_capacity.ts — Per-studio capacity report: intent
// counts (total / completed / active) plus median bolt counts per
// stage. Optional studio filter narrows the report.

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { listVisibleIntents } from "../../state/frontmatter.js"
import { findHaikuRoot, parseFrontmatter } from "../../state/shared.js"
import { defineTool } from "../define.js"
import { text } from "./_text.js"

function median(arr: number[]): number {
	if (arr.length === 0) return 0
	const sorted = [...arr].sort((a, b) => a - b)
	const mid = Math.floor(sorted.length / 2)
	return sorted.length % 2 !== 0
		? sorted[mid]
		: (sorted[mid - 1] + sorted[mid]) / 2
}

export default defineTool({
	name: "haiku_capacity",
	description:
		"Per-studio capacity report: intent counts (total/completed/active) and median bolt counts per stage. Pass `studio` to filter.",
	inputSchema: {
		type: "object" as const,
		properties: { studio: { type: "string" } },
	},
	handle(args) {
		const filterStudio = (args.studio as string) || ""
		let root: string
		try {
			root = findHaikuRoot()
		} catch {
			return text("No .haiku directory found.")
		}
		const intentsDir = join(root, "intents")
		if (!existsSync(intentsDir)) return text("No intents found.")
		const entries = listVisibleIntents(intentsDir)

		const byStudio = new Map<
			string,
			Array<{ slug: string; status: string; data: Record<string, unknown> }>
		>()
		for (const { slug, data } of entries) {
			const studio = (data.studio as string) || "unassigned"
			if (filterStudio && studio !== filterStudio) continue
			if (!byStudio.has(studio)) byStudio.set(studio, [])
			byStudio
				.get(studio)
				?.push({ slug, status: (data.status as string) || "unknown", data })
		}

		if (byStudio.size === 0)
			return text(
				filterStudio
					? `No intents found for studio '${filterStudio}'.`
					: "No intents found.",
			)

		let out = "# Capacity Report\n"
		for (const [studio, intents] of byStudio) {
			const completed = intents.filter((i) => i.status === "completed").length
			const active = intents.filter((i) => i.status === "active").length
			out += `\n## Studio: ${studio}\n`
			out += `- Total intents: ${intents.length}\n`
			out += `- Completed: ${completed}\n`
			out += `- Active: ${active}\n`

			const stageBolts = new Map<string, number[]>()
			for (const intent of intents) {
				const stagesPath = join(intentsDir, intent.slug, "stages")
				if (!existsSync(stagesPath)) continue
				for (const stage of readdirSync(stagesPath)) {
					const unitsDir = join(stagesPath, stage, "units")
					if (!existsSync(unitsDir)) continue
					if (!stageBolts.has(stage)) stageBolts.set(stage, [])
					for (const f of readdirSync(unitsDir).filter((f) =>
						f.endsWith(".md"),
					)) {
						const { data: ud } = parseFrontmatter(
							readFileSync(join(unitsDir, f), "utf8"),
						)
						if (typeof ud.bolt === "number")
							stageBolts.get(stage)?.push(ud.bolt)
					}
				}
			}

			if (stageBolts.size > 0) {
				out +=
					"\n| Stage | Units | Median Bolts |\n|-------|-------|--------------|\n"
				for (const [stage, bolts] of stageBolts) {
					out += `| ${stage} | ${bolts.length} | ${median(bolts)} |\n`
				}
			}
		}
		return text(out)
	},
})
