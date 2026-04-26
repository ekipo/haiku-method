// tools/orchestrator/haiku_intent_create.ts — Create a new intent.
// One per session (rejects if the session already owns an intent).
// Forces a checkout to repo mainline FIRST so existsSync checks and
// the eventual createIntentBranch fork happen on a known-good base
// — otherwise a stray intents/{slug}/ on a foreign stage branch
// could spoof an intent_exists, or createIntentBranch would fork off
// the wrong base.
//
// Title is required and must be a deliberate 3–8 word summary, not a
// truncated description. Slug auto-derives from title when omitted.

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { getMainlineBranch } from "../../git-worktree.js"
import { validateIdentifier } from "../../prompts/helpers.js"
import { getSessionIntent, logSessionEvent } from "../../session-metadata.js"
import {
	findHaikuRoot,
	gitCommitState,
	intentTitleNeedsRepair,
	isGitRepo,
	timestamp,
} from "../../state-tools.js"
import { emitTelemetry } from "../../telemetry.js"
import { defineTool } from "../define.js"
import { text } from "./_text.js"

export default defineTool({
	name: "haiku_intent_create",
	description:
		"Create a new intent. Returns the slug + path. Title is required (crisp 3–8 word summary, ≤80 chars, single line). Studio is selected separately via haiku_select_studio. One intent per session.",
	inputSchema: {
		type: "object" as const,
		properties: {
			title: { type: "string" },
			description: { type: "string" },
			slug: { type: "string" },
			context: { type: "string" },
			mode: { type: "string" },
			stages: { type: "array", items: { type: "string" } },
			state_file: { type: "string" },
		},
		required: ["title", "description"],
	},
	handle(args) {
		const description = args.description as string
		const titleInput = args.title as string | undefined
		let slug = args.slug as string | undefined

		// Title is required: must be a crisp, human-readable summary the
		// agent writes deliberately. We do NOT derive it by truncating the
		// description.
		if (!titleInput || typeof titleInput !== "string") {
			return text(
				JSON.stringify({
					error: "missing_title",
					message:
						'haiku_intent_create requires a `title` parameter — a crisp 3–8 word summary (≤80 chars, single line, no trailing period). Write it deliberately; do NOT pass a truncated description. Example: title: "Add archivable intents".',
				}),
			)
		}
		// Reject newlines explicitly before normalization — otherwise `\s+`
		// would collapse them to spaces and hide the intent (a multi-line
		// title input is a sign the agent pasted a paragraph, not wrote a
		// title).
		if (/[\r\n]/.test(titleInput)) {
			return text(
				JSON.stringify({
					error: "invalid_title",
					message:
						"`title` must be a single line — got newlines. Rewrite as a crisp 3–8 word summary (≤80 chars) and call again.",
				}),
			)
		}
		const title = titleInput.trim().replace(/\s+/g, " ")
		if (intentTitleNeedsRepair(title)) {
			return text(
				JSON.stringify({
					error: "invalid_title",
					message: `\`title\` must be non-empty and ≤80 chars after trimming. Got ${title.length} chars. Rewrite as a 3–8 word summary and call again.`,
				}),
			)
		}

		if (!slug) {
			slug = title
				.toLowerCase()
				.replace(/[^a-z0-9\s-]/g, "")
				.replace(/\s+/g, "-")
				.replace(/-+/g, "-")
				.replace(/^-|-$/g, "")
				.slice(0, 50)
				.replace(/-$/, "")
		}

		slug = validateIdentifier(slug, "intent slug")

		// One intent per session — reject if this session already has an
		// active intent.
		const stateFile = args.state_file as string | undefined
		if (stateFile) {
			const existingIntent = getSessionIntent(stateFile)
			if (existingIntent) {
				return {
					content: [
						{
							type: "text" as const,
							text: `This session already has an active intent: '${existingIntent}'. Only one intent per session is allowed. Use /clear to start a new session, then create a new intent.`,
						},
					],
					isError: true,
				}
			}
		}

		// Force checkout of the repo mainline BEFORE ANY filesystem checks
		// or writes for the new intent. If we ran existsSync on the
		// current (potentially foreign) branch first, we could:
		//   - return spurious intent_exists when a stray intents/{slug}/
		//     dir sits on a foreign stage branch, or
		//   - miss a genuine existing intent on mainline.
		// Plus, subsequent createIntentBranch forks haiku/{new-slug}/main
		// off whatever branch is current — a fresh intent must be born on
		// the repo mainline so its haiku/{slug}/main starts from a clean
		// base.
		const root = findHaikuRoot()
		const iDir = join(root, "intents", slug)
		if (isGitRepo()) {
			try {
				const mainlineBranch = getMainlineBranch()
				let currentBranch = ""
				try {
					currentBranch = execFileSync(
						"git",
						["rev-parse", "--abbrev-ref", "HEAD"],
						{ encoding: "utf8", stdio: "pipe" },
					).trim()
				} catch {
					/* non-fatal: detached HEAD or similar */
				}
				if (mainlineBranch && currentBranch !== mainlineBranch) {
					execFileSync("git", ["checkout", mainlineBranch], {
						encoding: "utf8",
						stdio: "pipe",
					})
				}
			} catch (err) {
				const raw = err instanceof Error ? err.message : String(err)
				return {
					content: [
						{
							type: "text" as const,
							text: `Error: failed to checkout repo mainline before creating intent '${slug}'. Stash or commit uncommitted changes, then retry. Raw git error: ${raw}`,
						},
					],
					isError: true,
				}
			}
		}

		if (existsSync(join(iDir, "intent.md"))) {
			return text(
				JSON.stringify({
					error: "intent_exists",
					slug,
					message: `Intent '${slug}' already exists`,
				}),
			)
		}

		mkdirSync(join(iDir, "knowledge"), { recursive: true })
		mkdirSync(join(iDir, "stages"), { recursive: true })

		// Build intent.md with frontmatter + body (no studio — selected
		// separately). Title and description are distinct: title is a
		// short human-readable summary the agent wrote deliberately;
		// description is the full narrative body.
		const context = args.context as string | undefined
		const mode = (args.mode as string) || "continuous"
		const stagesOverride = args.stages as string[] | undefined
		const descriptionBody = (description || "").trim()
		const intentContent = [
			"---",
			`title: "${title.replace(/"/g, '\\"')}"`,
			`studio: ""`,
			`mode: ${mode}`,
			"status: active",
			...(stagesOverride
				? [`stages:\n${stagesOverride.map((s) => `  - ${s}`).join("\n")}`]
				: []),
			`created_at: ${timestamp()}`,
			"---",
			"",
			`# ${title}`,
			"",
			...(descriptionBody ? [descriptionBody, ""] : []),
			...(context ? [context, ""] : []),
		].join("\n")

		writeFileSync(join(iDir, "intent.md"), intentContent)

		// Also write conversation context to knowledge for
		// discoverability.
		if (context) {
			const knowledgeDir = join(iDir, "knowledge")
			mkdirSync(knowledgeDir, { recursive: true })
			writeFileSync(
				join(knowledgeDir, "CONVERSATION-CONTEXT.md"),
				`# Conversation Context\n\n${context}\n`,
			)
		}

		gitCommitState(`haiku: create intent ${slug}`)

		emitTelemetry("haiku.intent.created", { intent: slug })
		if (stateFile)
			logSessionEvent(stateFile, { event: "intent_created", intent: slug })

		return text(
			JSON.stringify(
				{
					action: "intent_created",
					slug,
					path: `.haiku/intents/${slug}`,
					message: `Intent '${slug}' created. Call haiku_run_next { intent: "${slug}" } to begin.`,
				},
				null,
				2,
			),
		)
	},
})
