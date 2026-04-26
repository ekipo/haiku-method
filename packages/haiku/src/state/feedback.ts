// state/feedback.ts — Feedback domain (origins, statuses, file CRUD,
// reply threads, fix-loop bolt counter).
//
// Lifted out of state-tools.ts as a self-contained domain. The fix-loop
// constants (MAX_FIX_LOOP_BOLTS, MAX_INTEGRATOR_ATTEMPTS,
// MAX_CONCURRENT_SUBAGENTS) live here too — they're conceptually
// adjacent to the lifecycle and were already grouped together in the
// source.

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs"
import { join } from "node:path"
import matter from "gray-matter"
import {
	intentDir,
	normalizeDates,
	parseFrontmatter,
	readJson,
	stageDir,
	stageStatePath,
	timestamp,
} from "./shared.js"

// ── Constants ──────────────────────────────────────────────────────────────

/** Valid origin values for feedback items. */
export const FEEDBACK_ORIGINS = [
	"adversarial-review",
	"studio-review",
	"external-pr",
	"external-mr",
	"user-visual",
	"user-chat",
	"user-question",
	"agent",
] as const

export type FeedbackOrigin = (typeof FEEDBACK_ORIGINS)[number]

/** Valid status values for feedback items.
 *
 * Lifecycle:
 *   pending    — open finding. Stays pending until an independent assessor
 *                verifies resolution. A unit completing with `closes: [FB-XX]`
 *                writes `closed_by: <unit>` on the feedback item but DOES
 *                NOT change its status — the agent doing the work cannot
 *                self-certify.
 *   fixing     — the FSM is mid-fix-loop on this finding (one or more
 *                `fix_hats` bolts have run against it).
 *   addressed  — an independent actor (feedback-assessor hat, human via the
 *                review UI, or another agent) verified the closure.
 *   answered   — resolved by a reply with no code delta (questions).
 *   closed     — terminal; the feedback author confirmed resolution.
 *   rejected   — terminal; rejected with reason.
 */
export const FEEDBACK_STATUSES = [
	"pending",
	"fixing",
	"addressed",
	"answered",
	"closed",
	"rejected",
] as const

export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number]

/** Maximum number of fix-loop bolts we will run against a single feedback
 *  item before escalating to the human. */
export const MAX_FIX_LOOP_BOLTS = 3

/** Cap on how many times the FSM will dispatch the integrator subagent
 *  against a single fix-chain merge conflict before giving up. */
export const MAX_INTEGRATOR_ATTEMPTS = 3

/** Cap on concurrent subagents the parent may have in flight at any point.
 *  Override with env var `HAIKU_MAX_CONCURRENT_SUBAGENTS`. */
export const MAX_CONCURRENT_SUBAGENTS = (() => {
	const raw = process.env.HAIKU_MAX_CONCURRENT_SUBAGENTS
	const parsed = raw ? Number.parseInt(raw, 10) : NaN
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 5
})()

/** Origins that imply a human author. Any origin produced by a human-facing
 *  entry point (review UI composer, HTTP endpoints, external VCS review
 *  systems) MUST be listed here so `deriveAuthorType()` classifies the
 *  resulting feedback as `"human"` and the agent-facing privilege guards
 *  in `updateFeedbackFile` / `deleteFeedbackFile` refuse to let agents
 *  close or delete it. */
const HUMAN_ORIGINS: ReadonlySet<string> = new Set([
	"user-visual",
	"user-chat",
	"user-question",
	"external-pr",
	"external-mr",
])

/** Derive author_type from origin. */
export function deriveAuthorType(origin: string): "human" | "agent" {
	return HUMAN_ORIGINS.has(origin) ? "human" : "agent"
}

/** Derive default author from origin. */
function deriveDefaultAuthor(origin: string): string {
	return deriveAuthorType(origin) === "human" ? "user" : "agent"
}

/** Slugify a title for use as a filename component. */
export function slugifyTitle(title: string, maxLen = 60): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-{2,}/g, "-")
		.slice(0, maxLen)
		.replace(/-+$/, "")
}

/** Path to the feedback directory for an intent. When `stage` is falsy,
 *  returns the intent-scope feedback dir used by the pre-intent-completion
 *  review layer. Otherwise returns the per-stage dir. */
export function feedbackDir(slug: string, stage: string): string {
	if (stage) return join(stageDir(slug, stage), "feedback")
	return join(intentDir(slug), "feedback")
}

/** Resolve the next sequential NN prefix in a feedback directory. */
function nextFeedbackNumber(dir: string): number {
	if (!existsSync(dir)) return 1
	const files = readdirSync(dir).filter((f) => f.endsWith(".md"))
	let max = 0
	for (const f of files) {
		const match = f.match(/^(\d+)-/)
		if (match) {
			const n = Number.parseInt(match[1], 10)
			if (n > max) max = n
		}
	}
	return max + 1
}

/** Zero-pad a number to two digits. */
function zeroPad(n: number): string {
	return n.toString().padStart(2, "0")
}

// ── Types ─────────────────────────────────────────────────────────────────

/** One reply on a feedback thread. Append-only. */
export interface FeedbackReply {
	author: string
	author_type: "human" | "agent"
	body: string
	created_at: string
}

/** One per-bolt entry in a feedback's fix-loop history. */
export interface FeedbackIteration {
	bolt: number
	hat: string
	started_at?: string
	completed_at?: string
	result?: "advanced" | "closed" | "reopened" | "rejected"
	commit?: string
	reason?: string
}

/** Parsed feedback item returned by readFeedbackFiles. */
export interface FeedbackItem {
	id: string
	num: number
	slug: string
	file: string
	title: string
	body: string
	status: string
	origin: string
	author: string
	author_type: string
	created_at: string
	visit: number
	source_ref: string | null
	closed_by: string | null
	bolt: number
	upstream_stage: string | null
	resolution: string | null
	replies: FeedbackReply[]
	iterations: FeedbackIteration[]
	inline_anchor: {
		selected_text: string
		paragraph: number
		location: string
		comment_id?: string
		file_path?: string
		content_sha?: string
	} | null
}

// ── CRUD ───────────────────────────────────────────────────────────────────

/** Read the current iteration count from a stage state JSON. Mirrors
 *  `getStageIterationCount` in state-tools — kept inline here so feedback.ts
 *  doesn't import upward. Prefers the `iterations` array length, falls back
 *  to the legacy `visits` scalar. */
function readIterationCount(stageState: Record<string, unknown>): number {
	const arr = stageState.iterations
	if (Array.isArray(arr)) return arr.length
	const legacy = stageState.visits
	return typeof legacy === "number" ? legacy : 0
}

/** Create a feedback file under the given intent/stage. */
export function writeFeedbackFile(
	slug: string,
	stage: string,
	opts: {
		title: string
		body: string
		origin?: string
		author?: string
		source_ref?: string | null
		upstream_stage?: string | null
		resolution?: string | null
		attachmentDataUrl?: string | null
		inlineAnchor?: {
			selectedText: string
			paragraph: number
			location: string
			commentId?: string
			filePath?: string
			contentSha?: string
		} | null
	},
): { feedback_id: string; file: string; num: number } {
	const dir = feedbackDir(slug, stage)
	mkdirSync(dir, { recursive: true })

	const num = nextFeedbackNumber(dir)
	const nn = zeroPad(num)
	const fileSlug = slugifyTitle(opts.title)
	const filename = `${nn}-${fileSlug}.md`
	const filePath = join(dir, filename)

	const origin = opts.origin || "agent"
	const authorType = deriveAuthorType(origin)
	const author = opts.author || deriveDefaultAuthor(origin)

	let iteration = 0
	if (stage) {
		const stateFile = stageStatePath(slug, stage)
		const stageState = readJson(stateFile)
		iteration = readIterationCount(stageState)
	}

	// Persist a sidecar attachment if the caller passed one. SVG is rejected
	// at this gate (the serve path renders image/svg+xml inline → script
	// execution risk).
	let attachmentBasename: string | null = null
	if (opts.attachmentDataUrl) {
		const match = opts.attachmentDataUrl.match(
			/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/,
		)
		if (match) {
			const mime = match[1]
			const ext = mime === "jpeg" ? "jpg" : mime
			attachmentBasename = `${nn}-${fileSlug}.${ext}`
			const attachmentPath = join(dir, attachmentBasename)
			writeFileSync(attachmentPath, Buffer.from(match[2], "base64"))
		}
	}

	const bodyWithAttachment = attachmentBasename
		? `${opts.body.trim()}\n\n![annotation](/api/feedback-attachment/${encodeURIComponent(slug)}/${encodeURIComponent(stage)}/${encodeURIComponent(attachmentBasename)})\n`
		: opts.body

	const allowedResolutions = new Set([
		"question",
		"inline_fix",
		"stage_revisit",
		"upstream_rewind",
	])
	const normalizedResolution =
		typeof opts.resolution === "string" &&
		allowedResolutions.has(opts.resolution)
			? opts.resolution
			: null
	const frontmatter: Record<string, unknown> = {
		title: opts.title,
		status: "pending",
		origin,
		author,
		author_type: authorType,
		created_at: timestamp(),
		iteration,
		visit: iteration,
		source_ref: opts.source_ref ?? null,
		closed_by: null,
		bolt: 0,
		upstream_stage: opts.upstream_stage || null,
		resolution: normalizedResolution,
		replies: [],
		...(attachmentBasename ? { attachment: attachmentBasename } : {}),
		...(opts.inlineAnchor
			? {
					inline_anchor: {
						selected_text: opts.inlineAnchor.selectedText,
						paragraph: opts.inlineAnchor.paragraph,
						location: opts.inlineAnchor.location,
						...(opts.inlineAnchor.commentId
							? { comment_id: opts.inlineAnchor.commentId }
							: {}),
						...(opts.inlineAnchor.filePath
							? { file_path: opts.inlineAnchor.filePath }
							: {}),
						...(opts.inlineAnchor.contentSha
							? { content_sha: opts.inlineAnchor.contentSha }
							: {}),
					},
				}
			: {}),
	}

	const content = matter.stringify(`\n${bodyWithAttachment}\n`, frontmatter)
	writeFileSync(filePath, content)

	const relPath = stage
		? `.haiku/intents/${slug}/stages/${stage}/feedback/${filename}`
		: `.haiku/intents/${slug}/feedback/${filename}`
	return { feedback_id: `FB-${nn}`, file: relPath, num }
}

/** Read and parse all feedback files in a stage's feedback directory. */
export function readFeedbackFiles(slug: string, stage: string): FeedbackItem[] {
	const dir = feedbackDir(slug, stage)
	if (!existsSync(dir)) return []

	const files = readdirSync(dir)
		.filter((f) => f.endsWith(".md"))
		.sort()
	const items: FeedbackItem[] = []

	for (const f of files) {
		const match = f.match(/^(\d+)-(.+)\.md$/)
		if (!match) continue
		const num = Number.parseInt(match[1], 10)
		const fileSlug = match[2]
		const raw = readFileSync(join(dir, f), "utf8")
		const { data, body } = parseFrontmatter(raw)

		const resolutionRaw = (data as { resolution?: unknown }).resolution
		const resolution =
			typeof resolutionRaw === "string" &&
			resolutionRaw.length > 0 &&
			resolutionRaw !== "null"
				? resolutionRaw
				: null
		const rawReplies = (data as { replies?: unknown }).replies
		const replies: FeedbackReply[] = Array.isArray(rawReplies)
			? rawReplies
					.filter(
						(r): r is Record<string, unknown> =>
							typeof r === "object" && r !== null,
					)
					.map((r) => ({
						author: typeof r.author === "string" ? r.author : "unknown",
						author_type: r.author_type === "agent" ? "agent" : "human",
						body: typeof r.body === "string" ? r.body : "",
						created_at: typeof r.created_at === "string" ? r.created_at : "",
					}))
			: []
		items.push({
			id: `FB-${zeroPad(num)}`,
			num,
			slug: fileSlug,
			file: stage
				? `.haiku/intents/${slug}/stages/${stage}/feedback/${f}`
				: `.haiku/intents/${slug}/feedback/${f}`,
			title: (data.title as string) || "",
			body,
			status: (data.status as string) || "pending",
			origin: (data.origin as string) || "agent",
			author: (data.author as string) || "agent",
			author_type: (data.author_type as string) || "agent",
			created_at: (data.created_at as string) || "",
			visit: (data.visit as number) || 0,
			source_ref: (data.source_ref as string) || null,
			closed_by: (data.closed_by as string) || null,
			bolt: typeof data.bolt === "number" ? (data.bolt as number) : 0,
			upstream_stage:
				typeof data.upstream_stage === "string" &&
				(data.upstream_stage as string).length > 0
					? (data.upstream_stage as string)
					: null,
			resolution,
			replies,
			inline_anchor: parseInlineAnchor(data),
			iterations: parseFeedbackIterations(data),
		})
	}

	return items
}

function parseFeedbackIterations(
	data: Record<string, unknown>,
): FeedbackIteration[] {
	const raw = data.iterations
	if (!Array.isArray(raw)) return []
	const out: FeedbackIteration[] = []
	for (const entry of raw) {
		if (!(entry && typeof entry === "object")) continue
		const e = entry as Record<string, unknown>
		const bolt = typeof e.bolt === "number" ? e.bolt : 0
		const hat = typeof e.hat === "string" ? e.hat : ""
		if (!hat) continue
		const result = e.result
		const validResult =
			result === "advanced" ||
			result === "closed" ||
			result === "reopened" ||
			result === "rejected"
		out.push({
			bolt,
			hat,
			...(typeof e.started_at === "string" ? { started_at: e.started_at } : {}),
			...(typeof e.completed_at === "string"
				? { completed_at: e.completed_at }
				: {}),
			...(validResult ? { result: result as FeedbackIteration["result"] } : {}),
			...(typeof e.commit === "string" ? { commit: e.commit } : {}),
			...(typeof e.reason === "string" ? { reason: e.reason } : {}),
		})
	}
	return out
}

/** Append one entry to a feedback file's `iterations:` frontmatter array. */
export function appendFeedbackIteration(
	slug: string,
	stage: string,
	feedbackId: string,
	entry: FeedbackIteration,
): void {
	const dir = feedbackDir(slug, stage)
	if (!existsSync(dir)) return
	const nn = feedbackId.replace(/^FB-/, "")
	const file = readdirSync(dir).find(
		(f) => f.startsWith(`${nn}-`) && f.endsWith(".md"),
	)
	if (!file) return
	const path = join(dir, file)
	const raw = readFileSync(path, "utf8")
	const parsed = matter(raw)
	const current = Array.isArray(
		(parsed.data as { iterations?: unknown }).iterations,
	)
		? ((parsed.data as { iterations: unknown[] }).iterations as unknown[])
		: []
	const next = [
		...current,
		{
			bolt: entry.bolt,
			hat: entry.hat,
			...(entry.started_at ? { started_at: entry.started_at } : {}),
			...(entry.completed_at ? { completed_at: entry.completed_at } : {}),
			...(entry.result ? { result: entry.result } : {}),
			...(entry.commit ? { commit: entry.commit } : {}),
			...(entry.reason ? { reason: entry.reason } : {}),
		},
	]
	const updated = {
		...(parsed.data as Record<string, unknown>),
		iterations: next,
	}
	writeFileSync(path, matter.stringify(parsed.content, normalizeDates(updated)))
}

function parseInlineAnchor(
	data: Record<string, unknown>,
): FeedbackItem["inline_anchor"] {
	const raw = data.inline_anchor
	if (!(raw && typeof raw === "object")) return null
	const a = raw as Record<string, unknown>
	const selectedText = a.selected_text ?? a.selectedText
	const paragraph = a.paragraph
	const location = a.location
	if (
		typeof selectedText !== "string" ||
		typeof paragraph !== "number" ||
		typeof location !== "string"
	) {
		return null
	}
	return {
		selected_text: selectedText,
		paragraph,
		location,
		...(typeof a.comment_id === "string" ? { comment_id: a.comment_id } : {}),
		...(typeof a.file_path === "string" ? { file_path: a.file_path } : {}),
		...(typeof a.content_sha === "string"
			? { content_sha: a.content_sha }
			: {}),
	}
}

/** Count feedback items that still block the stage gate. */
export function countPendingFeedback(slug: string, stage: string): number {
	return readFeedbackFiles(slug, stage).filter((item) => {
		const closedBy = (item as { closed_by?: unknown }).closed_by
		if (typeof closedBy === "string" && closedBy.length > 0) return false
		if (
			item.status === "closed" ||
			item.status === "addressed" ||
			item.status === "answered" ||
			item.status === "rejected"
		)
			return false
		return true
	}).length
}

/** Find a feedback file by its FB-NN identifier (or bare numeric prefix). */
export function findFeedbackFile(
	slug: string,
	stage: string,
	feedbackId: string,
): {
	path: string
	filename: string
	data: Record<string, unknown>
	body: string
} | null {
	const dir = feedbackDir(slug, stage)
	if (!existsSync(dir)) return null

	const nn = feedbackId.replace(/^FB-/i, "")
	const prefix = `${nn}-`

	const files = readdirSync(dir).filter((f) => f.endsWith(".md"))
	const match = files.find((f) => f.startsWith(prefix))
	if (!match) return null

	const raw = readFileSync(join(dir, match), "utf8")
	const parsed = parseFrontmatter(raw)
	return {
		path: join(dir, match),
		filename: match,
		data: parsed.data,
		body: parsed.body,
	}
}

/** Update mutable fields on an existing feedback file. */
export function updateFeedbackFile(
	slug: string,
	stage: string,
	feedbackId: string,
	fields: {
		status?: string
		closed_by?: string | null
		resolution?: string | null
	},
	callerContext: "agent" | "human" = "agent",
): { ok: true; updated_fields: string[] } | { ok: false; error: string } {
	const found = findFeedbackFile(slug, stage, feedbackId)
	if (!found) {
		return {
			ok: false,
			error: stage
				? `Error: feedback '${feedbackId}' not found in stage '${stage}'`
				: `Error: feedback '${feedbackId}' not found (intent-scope)`,
		}
	}

	if (
		fields.status === undefined &&
		fields.closed_by === undefined &&
		fields.resolution === undefined
	) {
		return {
			ok: false,
			error:
				"Error: at least one of 'status' / 'closed_by' / 'resolution' must be provided",
		}
	}

	if (
		fields.resolution !== undefined &&
		fields.resolution !== null &&
		!new Set([
			"question",
			"inline_fix",
			"stage_revisit",
			"upstream_rewind",
		]).has(fields.resolution)
	) {
		return {
			ok: false,
			error:
				"Error: resolution must be one of: question, inline_fix, stage_revisit, upstream_rewind (or null to clear).",
		}
	}

	if (
		fields.status !== undefined &&
		!(FEEDBACK_STATUSES as readonly string[]).includes(fields.status)
	) {
		return {
			ok: false,
			error: `Error: status must be one of: ${FEEDBACK_STATUSES.join(", ")}`,
		}
	}

	if (
		callerContext === "agent" &&
		typeof fields.closed_by === "string" &&
		fields.closed_by.length > 0 &&
		found.data.author_type === "human"
	) {
		return {
			ok: false,
			error:
				"Error: agents cannot close human-authored feedback. Only the original author may set `closed_by` via the review UI.",
		}
	}

	// FB-24: parallel guard against the `status: "closed"` bypass path.
	if (
		callerContext === "agent" &&
		fields.status === "closed" &&
		found.data.author_type === "human"
	) {
		return {
			ok: false,
			error:
				"Error: agents cannot set status='closed' on human-authored feedback. Only the original author may close the item, via the review UI.",
		}
	}

	// Ghost-unit ledger guard: closed_by referencing a unit that doesn't exist.
	if (
		typeof fields.closed_by === "string" &&
		/^unit-\d+[-_]/i.test(fields.closed_by) &&
		stage
	) {
		const unitBase = fields.closed_by.replace(/\.md$/, "")
		const unitFile = join(stageDir(slug, stage), "units", `${unitBase}.md`)
		if (!existsSync(unitFile)) {
			return {
				ok: false,
				error: `Error: closed_by='${fields.closed_by}' references a unit that does not exist at stages/${stage}/units/${unitBase}.md. Agents cannot mark findings closed via a ghost unit. Either create the unit spec first (additive elaboration), or close via a fix-loop marker (e.g. 'fix-loop:${feedbackId}:bolt-N').`,
			}
		}
	}

	const updated: string[] = []
	const newData = { ...found.data }

	if (fields.status !== undefined) {
		newData.status = fields.status
		updated.push("status")
	}
	if (fields.closed_by !== undefined) {
		if (fields.closed_by === null) {
			newData.closed_by = undefined
		} else {
			newData.closed_by = fields.closed_by
		}
		updated.push("closed_by")
	}
	if (fields.resolution !== undefined) {
		newData.resolution = fields.resolution
		updated.push("resolution")
	}

	writeFileSync(found.path, matter.stringify(`\n${found.body}\n`, newData))
	return { ok: true, updated_fields: updated }
}

/** Append a reply to a feedback thread. `close_as_answered` flips the
 *  parent's `status` to `answered` in the same write. */
export function appendFeedbackReply(
	slug: string,
	stage: string,
	feedbackId: string,
	reply: {
		author: string
		author_type: "human" | "agent"
		body: string
	},
	opts: { close_as_answered?: boolean } = {},
):
	| { ok: true; reply_index: number; status: string }
	| { ok: false; error: string } {
	const found = findFeedbackFile(slug, stage, feedbackId)
	if (!found) {
		return {
			ok: false,
			error: stage
				? `Error: feedback '${feedbackId}' not found in stage '${stage}'`
				: `Error: feedback '${feedbackId}' not found (intent-scope)`,
		}
	}
	const trimmed = reply.body.trim()
	if (trimmed.length === 0) {
		return { ok: false, error: "Error: reply body cannot be empty" }
	}
	const newReply = {
		author: reply.author || "unknown",
		author_type: reply.author_type,
		body: trimmed,
		created_at: timestamp(),
	}
	const existingReplies = Array.isArray(found.data.replies)
		? (found.data.replies as unknown[])
		: []
	const replies = [...existingReplies, newReply]
	const newData: Record<string, unknown> = { ...found.data, replies }
	if (opts.close_as_answered) newData.status = "answered"
	writeFileSync(found.path, matter.stringify(`\n${found.body}\n`, newData))
	return {
		ok: true,
		reply_index: replies.length - 1,
		status:
			(newData.status as string) || (found.data.status as string) || "pending",
	}
}

/** Increment the fix-loop bolt counter on a feedback item and set status to
 *  "fixing". Does NOT validate the ceiling — callers must check
 *  `MAX_FIX_LOOP_BOLTS` themselves. */
export function incrementFeedbackBolt(
	slug: string,
	stage: string,
	feedbackId: string,
): { bolt: number } | null {
	const found = findFeedbackFile(slug, stage, feedbackId)
	if (!found) return null
	const currentBolt =
		typeof found.data.bolt === "number" ? (found.data.bolt as number) : 0
	const newBolt = currentBolt + 1
	const newData = { ...found.data, bolt: newBolt, status: "fixing" }
	writeFileSync(found.path, matter.stringify(`\n${found.body}\n`, newData))
	return { bolt: newBolt }
}

/** Delete a feedback file with guards. */
export function deleteFeedbackFile(
	slug: string,
	stage: string,
	feedbackId: string,
	callerContext: "agent" | "human" = "agent",
): { ok: true } | { ok: false; error: string } {
	const found = findFeedbackFile(slug, stage, feedbackId)
	if (!found) {
		return {
			ok: false,
			error: stage
				? `Error: feedback '${feedbackId}' not found in stage '${stage}'`
				: `Error: feedback '${feedbackId}' not found (intent-scope)`,
		}
	}

	if (found.data.status === "pending" || found.data.status === "fixing") {
		return {
			ok: false,
			error: `Error: cannot delete ${found.data.status} feedback. Address, close, or reject it first.`,
		}
	}

	if (callerContext === "agent" && found.data.author_type === "human") {
		return {
			ok: false,
			error:
				"Error: agents cannot delete human-authored feedback. Use the review UI.",
		}
	}

	unlinkSync(found.path)
	return { ok: true }
}
