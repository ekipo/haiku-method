// tools/orchestrator/haiku_intent_archive.ts — Set archived: true on
// the intent's frontmatter. Idempotent (no-op if already archived).
// Lands the write on intent-main so the mutation is visible from any
// stage branch.

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { ensureOnStageBranch } from "../../git-worktree.js"
import {
	findHaikuRoot,
	gitCommitState,
	parseFrontmatter,
	setFrontmatterField,
} from "../../state-tools.js"
import { defineTool } from "../define.js"
import { text } from "./_text.js"

export default defineTool({
	name: "haiku_intent_archive",
	description:
		"Archive an intent — sets the `archived: true` frontmatter flag so the intent is hidden from default list views. Reversible via haiku_intent_unarchive. Does not prompt for confirmation.",
	inputSchema: {
		type: "object" as const,
		properties: {
			intent: { type: "string", description: "Intent slug to archive" },
		},
		required: ["intent"],
	},
	handle(args) {
		const slug = args.intent as string
		const root = findHaikuRoot()
		const intentFile = join(root, "intents", slug, "intent.md")

		if (!existsSync(intentFile)) {
			return {
				content: [
					{ type: "text" as const, text: `Intent '${slug}' not found.` },
				],
				isError: true,
			}
		}

		// Single-read idempotency check: parse once with parseFrontmatter
		// (which normalizes dates). If already archived, noop. Otherwise
		// delegate the write to setFrontmatterField — it re-reads but
		// preserves the normalizeDates() pass we depend on for stable YAML
		// output.
		const { data } = parseFrontmatter(readFileSync(intentFile, "utf8"))

		if (data.archived === true) {
			return text(
				JSON.stringify(
					{
						action: "noop",
						slug,
						path: intentFile,
						message: `Intent '${slug}' is already archived.`,
					},
					null,
					2,
				),
			)
		}

		// Archive is intent-scoped metadata — land on intent-main so the
		// mutation is visible everywhere, not split-brain on whatever stage
		// branch the agent happens to be on when they archive.
		const archiveGuard = ensureOnStageBranch(slug, undefined)
		if (!archiveGuard.ok) {
			return {
				content: [
					{
						type: "text" as const,
						text: `Error: branch enforcement failed for intent archive '${slug}' — ${archiveGuard.message}. Resolve manually and retry.`,
					},
				],
				isError: true,
			}
		}

		setFrontmatterField(intentFile, "archived", true)
		gitCommitState(`haiku: archive intent ${slug}`)

		return text(
			JSON.stringify(
				{
					action: "intent_archived",
					slug,
					path: intentFile,
					message: `Intent '${slug}' has been archived. Call haiku_intent_unarchive to restore it.`,
				},
				null,
				2,
			),
		)
	},
})
