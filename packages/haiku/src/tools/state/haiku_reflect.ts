// tools/state/haiku_reflect.ts — Per-intent reflection scaffold:
// intent metadata + per-stage execution summary + studio-specific
// reflection dimensions + studio operations. The agent uses this to
// produce reflection.md and settings-recommendations.md.

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
	findHaikuRoot,
	parseFrontmatter,
	readJson,
} from "../../state/shared.js"
import {
	readOperationDefs,
	readReflectionDefs,
} from "../../studio-reader.js"
import { defineTool } from "../define.js"
import { text } from "./_text.js"

export default defineTool({
	name: "haiku_reflect",
	description:
		"Per-intent reflection scaffold: metadata, per-stage execution summary, studio reflection dimensions, available operations.",
	inputSchema: {
		type: "object" as const,
		properties: { intent: { type: "string" } },
		required: ["intent"],
	},
	handle(args) {
		const intentSlug = args.intent as string
		let root: string
		try {
			root = findHaikuRoot()
		} catch {
			return text("No .haiku directory found.")
		}
		const intentFile = join(root, "intents", intentSlug, "intent.md")
		if (!existsSync(intentFile))
			return text(`Intent '${intentSlug}' not found.`)

		const { data: intentData } = parseFrontmatter(
			readFileSync(intentFile, "utf8"),
		)
		let out = "## Intent Metadata\n"
		out += `- Slug: ${intentSlug}\n`
		out += `- Studio: ${intentData.studio || "none"}\n`
		out += `- Mode: ${intentData.mode || "interactive"}\n`
		out += `- Status: ${intentData.status || "unknown"}\n`
		out += `- Created: ${intentData.created_at || "unknown"}\n`
		out += `- Completed: ${intentData.completed_at || "in progress"}\n`

		const stagesPath = join(root, "intents", intentSlug, "stages")
		if (existsSync(stagesPath)) {
			out += "\n## Per-Stage Summary\n"
			for (const stage of readdirSync(stagesPath)) {
				const state = readJson(join(stagesPath, stage, "state.json"))
				out += `\n### ${stage}\n`
				out += `- Status: ${state.status || "pending"}\n`
				out += `- Phase: ${state.phase || ""}\n`
				out += `- Started: ${state.started_at || "not started"}\n`
				out += `- Completed: ${state.completed_at || "in progress"}\n`

				const unitsDir = join(stagesPath, stage, "units")
				if (!existsSync(unitsDir)) continue
				const unitFiles = readdirSync(unitsDir).filter((f) =>
					f.endsWith(".md"),
				)
				let completedUnits = 0
				let totalBolts = 0
				const unitDetails: string[] = []
				for (const f of unitFiles) {
					const { data: ud } = parseFrontmatter(
						readFileSync(join(unitsDir, f), "utf8"),
					)
					const uName = f.replace(".md", "")
					const uBolt = (ud.bolt as number) || 0
					totalBolts += uBolt
					if (ud.status === "completed") completedUnits++
					unitDetails.push(
						`  - ${uName}: status=${ud.status || "pending"}, bolts=${uBolt}, hat=${ud.hat || "none"}`,
					)
				}
				out += `- Units: ${completedUnits}/${unitFiles.length} completed, Total bolts: ${totalBolts}\n`
				if (unitDetails.length > 0) out += `${unitDetails.join("\n")}\n`
			}
		}

		const studio = (intentData.studio as string) || ""
		if (studio) {
			const dims = readReflectionDefs(studio)
			if (Object.keys(dims).length > 0) {
				out += "\n## Reflection Dimensions\n\n"
				out += "Analyze this intent along each dimension below:\n\n"
				for (const [name, content] of Object.entries(dims)) {
					out += `### ${name}\n\n${content}\n\n`
				}
			} else {
				out += "\n## Analysis Instructions\n"
				out +=
					"1. Execution patterns — which units went smoothly, which required retries\n"
				out += "2. Criteria satisfaction\n"
				out += "3. Process observations\n"
				out += "4. Blocker analysis\n"
			}
		} else {
			out += "\n## Analysis Instructions\n"
			out +=
				"1. Execution patterns — which units went smoothly, which required retries\n"
			out += "2. Criteria satisfaction\n"
			out += "3. Process observations\n"
			out += "4. Blocker analysis\n"
		}

		if (studio) {
			const ops = readOperationDefs(studio)
			if (Object.keys(ops).length > 0) {
				out += "\n## Available Operations\n\n"
				out +=
					"The following post-delivery operations are defined for this studio:\n\n"
				for (const [name, content] of Object.entries(ops)) {
					out += `### ${name}\n\n${content}\n\n`
				}
			}
		}

		out += "\n## Output\n"
		out +=
			"Write reflection.md and settings-recommendations.md to the intent directory.\n"
		return text(out)
	},
})
