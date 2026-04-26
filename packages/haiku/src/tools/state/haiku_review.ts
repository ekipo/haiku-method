// tools/state/haiku_review.ts — Pre-delivery code review snapshot.
// Collects diff vs upstream/mainline, project review guidelines
// (REVIEW.md / CLAUDE.md), and configured review-agent settings.

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { getMainlineBranch } from "../../git-worktree.js"
import { getNestedField, parseYaml } from "../../state/frontmatter.js"
import { findHaikuRoot } from "../../state/shared.js"
import { defineTool } from "../define.js"
import { text } from "./_text.js"

export default defineTool({
	name: "haiku_review",
	description:
		"Capture diff vs upstream/mainline + REVIEW/CLAUDE guidelines + review-agent settings for a pre-delivery review snapshot.",
	inputSchema: { type: "object" as const, properties: {} },
	handle() {
		// Diff base: prefer tracked upstream, fall back to detected mainline,
		// then last-resort "main".
		let base = getMainlineBranch()
		try {
			const upstream = spawnSync(
				"git",
				["rev-parse", "--abbrev-ref", "@{upstream}"],
				{ encoding: "utf8", stdio: "pipe" },
			)
			if (upstream.status === 0 && upstream.stdout.trim()) {
				base = upstream.stdout.trim()
			}
		} catch {
			/* fallback */
		}

		let diff = ""
		let stat = ""
		let changedFiles = ""
		try {
			const diffResult = spawnSync("git", ["diff", `${base}...HEAD`], {
				encoding: "utf8",
				stdio: "pipe",
				maxBuffer: 10 * 1024 * 1024,
			})
			diff = diffResult.stdout || ""
			const statResult = spawnSync(
				"git",
				["diff", "--stat", `${base}...HEAD`],
				{ encoding: "utf8", stdio: "pipe" },
			)
			stat = statResult.stdout || ""
			const namesResult = spawnSync(
				"git",
				["diff", "--name-only", `${base}...HEAD`],
				{ encoding: "utf8", stdio: "pipe" },
			)
			changedFiles = namesResult.stdout || ""
		} catch {
			/* git not available */
		}

		const MAX_DIFF = 100_000
		if (diff.length > MAX_DIFF) {
			diff = `${diff.slice(0, MAX_DIFF)}\n\n... [TRUNCATED at 100k chars] ...`
		}

		let reviewGuidelines = ""
		const cwd = process.cwd()
		for (const name of ["REVIEW.md", "CLAUDE.md"]) {
			const p = join(cwd, name)
			if (existsSync(p)) {
				reviewGuidelines += `\n### ${name}\n${readFileSync(p, "utf8").slice(0, 5000)}\n`
			}
		}

		let reviewAgents = ""
		try {
			const settingsPath = join(findHaikuRoot(), "settings.yml")
			if (existsSync(settingsPath)) {
				const settings = parseYaml(readFileSync(settingsPath, "utf8"))
				const agents = getNestedField(settings, "review_agents")
				if (agents)
					reviewAgents = `\n### Review Agents Config\n\`\`\`json\n${JSON.stringify(agents, null, 2)}\n\`\`\`\n`
			}
		} catch {
			/* no settings */
		}

		let out = "## Pre-Delivery Code Review\n"
		out += `Diff base: ${base}\n\n`
		out += `Changed files:\n\`\`\`\n${changedFiles || "none"}\`\`\`\n\n`
		out += `Diff stats:\n\`\`\`\n${stat || "none"}\`\`\`\n`
		if (reviewGuidelines)
			out += `\n### Review Guidelines\n${reviewGuidelines}\n`
		if (reviewAgents) out += reviewAgents
		out += `\n### Full Diff\n\`\`\`diff\n${diff || "No changes detected."}\n\`\`\`\n`
		out += "\n### Instructions\n"
		out +=
			"1. Spawn review agents in parallel (one per configured agent or area)\n"
		out += "2. Collect findings, deduplicate across agents\n"
		out += "3. Fix all HIGH severity findings before delivery\n"
		out += "4. Report findings summary to the user\n"
		return text(out)
	},
})
