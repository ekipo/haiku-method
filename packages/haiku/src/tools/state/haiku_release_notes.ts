// tools/state/haiku_release_notes.ts — Read CHANGELOG.md and surface
// the most-recent versions (or a specific one if requested).

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { resolvePluginRoot } from "../../config.js"
import { defineTool } from "../define.js"
import { text } from "./_text.js"

export default defineTool({
	name: "haiku_release_notes",
	description:
		"Read CHANGELOG.md (Keep-a-Changelog format) and return either a single version's notes or the 5 most-recent versions.",
	inputSchema: {
		type: "object" as const,
		properties: {
			version: {
				type: "string",
				description:
					"Specific version to look up (e.g. '1.105.0'). Omit to get the 5 most-recent.",
			},
		},
	},
	handle(args) {
		const version = (args.version as string) || ""
		// Search for CHANGELOG.md — try plugin root first, then walk up from cwd
		let changelogPath = ""
		const pluginRoot = resolvePluginRoot()
		if (pluginRoot) {
			const p = join(pluginRoot, "CHANGELOG.md")
			if (existsSync(p)) changelogPath = p
		}
		if (!changelogPath) {
			let dir = process.cwd()
			for (let i = 0; i < 20; i++) {
				const p = join(dir, "CHANGELOG.md")
				if (existsSync(p)) {
					changelogPath = p
					break
				}
				const parent = join(dir, "..")
				if (parent === dir) break
				dir = parent
			}
		}
		if (!changelogPath) return text("No CHANGELOG.md found.")

		const changelog = readFileSync(changelogPath, "utf8")
		const versionPattern = /^## \[([^\]]+)\]/gm
		const matches: Array<{ version: string; start: number }> = []
		let match = versionPattern.exec(changelog)
		while (match !== null) {
			matches.push({ version: match[1], start: match.index })
			match = versionPattern.exec(changelog)
		}

		if (matches.length === 0)
			return text("No versioned entries found in CHANGELOG.md.")

		if (version) {
			const idx = matches.findIndex((m) => m.version === version)
			if (idx === -1)
				return text(
					`Version '${version}' not found in CHANGELOG.md. Available: ${matches
						.slice(0, 10)
						.map((m) => m.version)
						.join(", ")}`,
				)
			const endIdx =
				idx + 1 < matches.length ? matches[idx + 1].start : changelog.length
			const section = changelog.slice(matches[idx].start, endIdx).trim()
			return text(
				`# Release Notes\n\n${section}\n\n---\nTotal releases in changelog: ${matches.length}`,
			)
		}

		const recent = matches.slice(0, 5)
		let out = "# Recent Release Notes\n"
		for (let i = 0; i < recent.length; i++) {
			const endIdx =
				i + 1 < matches.length ? matches[i + 1].start : changelog.length
			out += `\n${changelog.slice(recent[i].start, endIdx).trim()}\n`
		}
		out += `\n---\nTotal releases in changelog: ${matches.length}\n`
		return text(out)
	},
})
