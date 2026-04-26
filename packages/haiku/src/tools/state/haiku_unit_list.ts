// tools/state/haiku_unit_list.ts — List units in a stage with their
// frontmatter status / bolt / hat / model.
//
// Aligns the checkout to the stage branch first — unit files live on the
// stage branch, so reading from intent-main spuriously returns "no units".

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { enforceStageBranch } from "../../state/active-stage.js"
import { parseFrontmatter, stageDir } from "../../state/shared.js"
import { defineTool } from "../define.js"
import { text } from "./_text.js"

export default defineTool({
	name: "haiku_unit_list",
	description: "List all units in a stage with status / bolt / hat / model",
	inputSchema: {
		type: "object" as const,
		properties: {
			intent: { type: "string" },
			stage: { type: "string" },
		},
		required: ["intent", "stage"],
	},
	handle(args) {
		const branchErr = enforceStageBranch(
			args.intent as string,
			args.stage as string,
		)
		if (branchErr) return branchErr
		const dir = join(
			stageDir(args.intent as string, args.stage as string),
			"units",
		)
		if (!existsSync(dir)) return text("[]")
		const files = readdirSync(dir).filter((f) => f.endsWith(".md"))
		const units = files.map((f) => {
			const { data } = parseFrontmatter(readFileSync(join(dir, f), "utf8"))
			return {
				name: f.replace(".md", ""),
				status: data.status,
				bolt: data.bolt,
				hat: data.hat,
				model: data.model ?? null,
			}
		})
		return text(JSON.stringify(units, null, 2))
	},
})
