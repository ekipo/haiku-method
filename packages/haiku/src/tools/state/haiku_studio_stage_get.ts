// tools/state/haiku_studio_stage_get.ts — Read a single STAGE.md
// (frontmatter + body) from a studio.

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parseFrontmatter } from "../../state/shared.js"
import { resolveStudio } from "../../studio-reader.js"
import { defineTool } from "../define.js"
import { text } from "./_text.js"

export default defineTool({
	name: "haiku_studio_stage_get",
	description: "Read a studio's STAGE.md (frontmatter + body) for a stage",
	inputSchema: {
		type: "object" as const,
		properties: {
			studio: { type: "string" },
			stage: { type: "string" },
		},
		required: ["studio", "stage"],
	},
	handle(args) {
		const studio = resolveStudio(args.studio as string)
		if (!studio) return text("")
		const sgName = args.stage as string
		const stageFile = join(studio.path, "stages", sgName, "STAGE.md")
		if (!existsSync(stageFile)) return text("")
		const raw = readFileSync(stageFile, "utf8")
		const { data, body } = parseFrontmatter(raw)
		return text(
			JSON.stringify(
				{
					...data,
					body,
					studio: studio.name,
					studio_dir: studio.dir,
					stage_md: stageFile,
				},
				null,
				2,
			),
		)
	},
})
