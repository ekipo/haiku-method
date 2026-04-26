// tools/state/haiku_dashboard.ts — Render a Markdown dashboard listing
// every visible intent with its stages, statuses, phases, and per-stage
// unit model assignments.
//
// In discrete/hybrid mode, also surfaces stages that exist as
// `haiku/<slug>/<stage>` branches but don't have a state.json on the
// current checkout — pulled directly from the branch via
// readFileFromBranch.

import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { readFileFromBranch } from "../../git-worktree.js"
import { listVisibleIntents } from "../../state/frontmatter.js"
import {
	findHaikuRoot,
	isGitRepo,
	parseFrontmatter,
	readJson,
} from "../../state/shared.js"
import { defineTool } from "../define.js"
import { text } from "./_text.js"

export default defineTool({
	name: "haiku_dashboard",
	description:
		"Markdown dashboard of every visible intent with stage statuses, phases, and unit model assignments. Discrete-mode intents also surface branch-only stages.",
	inputSchema: { type: "object" as const, properties: {} },
	handle() {
		let root: string
		try {
			root = findHaikuRoot()
		} catch {
			return text("No intents found. Use /haiku:start to create one.")
		}
		const intentsDir = join(root, "intents")
		if (!existsSync(intentsDir))
			return text("No intents found. Use /haiku:start to create one.")
		const entries = listVisibleIntents(intentsDir)
		if (entries.length === 0)
			return text("No intents found. Use /haiku:start to create one.")

		let out = "# Dashboard\n"
		for (const { slug, data } of entries) {
			out += `\n## ${slug}\n`
			out += `- Status: ${data.status || "unknown"}\n`
			out += `- Studio: ${data.studio || "none"}\n`
			out += `- Active Stage: ${data.active_stage || "none"}\n`
			out += `- Mode: ${data.mode || "interactive"}\n`

			const isDiscrete =
				(data.mode as string) === "discrete" ||
				(data.mode as string) === "hybrid"

			const stagesPath = join(intentsDir, slug, "stages")
			if (!existsSync(stagesPath)) continue

			const stages = readdirSync(stagesPath).filter((s) =>
				existsSync(join(stagesPath, s, "state.json")),
			)
			const stagesFromBranches: string[] = []
			if (isDiscrete && isGitRepo()) {
				try {
					const branchList = execFileSync(
						"git",
						["branch", "--list", `haiku/${slug}/*`],
						{ encoding: "utf8", stdio: "pipe" },
					).trim()
					for (const line of branchList.split("\n")) {
						const branch = line.trim().replace(/^\* /, "")
						const stageName = branch.replace(`haiku/${slug}/`, "")
						// Skip main and unit branches
						if (
							stageName &&
							stageName !== "main" &&
							!/^unit-\d+/.test(stageName) &&
							!stages.includes(stageName)
						) {
							stagesFromBranches.push(stageName)
						}
					}
				} catch {
					/* non-fatal */
				}
			}

			const allStages = [...stages, ...stagesFromBranches]
			if (allStages.length === 0) continue

			out += "\n| Stage | Status | Phase |\n|-------|--------|-------|\n"
			for (const s of stages) {
				const state = readJson(join(stagesPath, s, "state.json"))
				out += `| ${s} | ${state.status || "pending"} | ${state.phase || ""} |\n`
			}
			for (const s of stagesFromBranches) {
				const branch = `haiku/${slug}/${s}`
				const relPath = `.haiku/intents/${slug}/stages/${s}/state.json`
				const raw = readFileFromBranch(branch, relPath)
				if (raw) {
					try {
						const state = JSON.parse(raw)
						out += `| ${s} | ${state.status || "pending"} | ${state.phase || ""} |\n`
					} catch {
						out += `| ${s} | ? | ? |\n`
					}
				} else {
					out += `| ${s} | (on branch) | |\n`
				}
			}
			for (const s of stages) {
				const unitsDir = join(stagesPath, s, "units")
				if (!existsSync(unitsDir)) continue
				const unitFiles = readdirSync(unitsDir).filter((f) =>
					f.endsWith(".md"),
				)
				const unitsWithModel = unitFiles
					.map((f) => {
						const { data } = parseFrontmatter(
							readFileSync(join(unitsDir, f), "utf8"),
						)
						return {
							name: f.replace(".md", ""),
							model: data.model as string | undefined,
						}
					})
					.filter((u) => u.model)
				if (unitsWithModel.length > 0) {
					out += `\n**${s} unit models:**\n`
					for (const u of unitsWithModel) {
						out += `- ${u.name}: ${u.model}\n`
					}
				}
			}
		}
		return text(out)
	},
})
