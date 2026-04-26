// tools/state/haiku_studio_list.ts — List every studio (plugin + project),
// with name/slug/aliases + help links.

import { listStudios } from "../../studio-reader.js"
import { defineTool } from "../define.js"
import { text } from "./_text.js"

export default defineTool({
	name: "haiku_studio_list",
	description:
		"List every available studio (plugin + project), with name, slug, aliases, description, and stage list. Honors STUDIO.md frontmatter.",
	inputSchema: { type: "object" as const, properties: {} },
	handle() {
		const studios = listStudios().map((s) => ({
			name: s.name,
			slug: s.slug,
			aliases: s.aliases,
			dir: s.dir,
			description: s.description,
			category: s.category,
			stages: s.stages,
			source: s.source,
			path: s.path,
			studio_md: s.studioFile,
			body: s.body.slice(0, 200),
		}))
		return text(JSON.stringify(studios, null, 2))
	},
})
