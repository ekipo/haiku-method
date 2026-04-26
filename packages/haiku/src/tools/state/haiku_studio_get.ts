// tools/state/haiku_studio_get.ts — Read a single studio's full STUDIO.md
// (frontmatter + body).

import { resolveStudio } from "../../studio-reader.js"
import { defineTool } from "../define.js"
import { text } from "./_text.js"

export default defineTool({
	name: "haiku_studio_get",
	description:
		"Read a studio's full STUDIO.md (frontmatter + body). Returns empty string when the studio name/slug/alias does not resolve.",
	inputSchema: {
		type: "object" as const,
		properties: { studio: { type: "string" } },
		required: ["studio"],
	},
	handle(args) {
		const studio = resolveStudio(args.studio as string)
		if (!studio) return text("")
		return text(
			JSON.stringify(
				{
					name: studio.name,
					slug: studio.slug,
					aliases: studio.aliases,
					dir: studio.dir,
					description: studio.description,
					category: studio.category,
					stages: studio.stages,
					source: studio.source,
					path: studio.path,
					studio_md: studio.studioFile,
					body: studio.body,
					...studio.data,
				},
				null,
				2,
			),
		)
	},
})
