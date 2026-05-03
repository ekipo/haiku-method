// http/upload-routes.ts — SPA file-upload HTTP endpoints.
//
// Routes:
//   POST /api/intents/:intent/uploads/stage-output
//       Multipart: stage, target_path, file, mode, attribute_to_user
//       → atomic write to stages/{stage}/artifacts/{target_path}
//         (outputs/ alias canonicalised to artifacts/).
//       → action-log entry (author_class "human-via-mcp").
//       → audit-log entry in write-audit.jsonl.
//       → does NOT update baseline.json (next tick's drift gate does).
//
//   POST /api/intents/:intent/uploads/knowledge
//       Multipart: file, target_filename, stage, description, attribute_to_user
//       → atomic write to knowledge/{target_filename} (intent-scope) or
//         stages/{stage}/knowledge/{target_filename} (stage-scope when
//         stage param is non-null).
//       → same log semantics as stage-output.
//
// Security / validation:
//   - Path traversal: target_path must canonicalise to
//     stages/{stage}/artifacts/** (alias outputs/ → artifacts/).
//     Anything else is rejected with bad_target_path (400).
//   - Stage existence: stage must be a known stage directory.
//   - Stage writability: completed/sealed stages return stage_not_writable (403).
//   - File size cap: default 50 MB, env HAIKU_UPLOAD_MAX_BYTES.
//     Streaming enforced BEFORE bytes hit disk.
//   - Intent state: archived/missing → intent_not_found (404).
//   - Locked worktree: intent_locked (423).
//   - Atomic write: stream to tempfile, then rename into place.
//   - Temp-file cleanup: guards delete the tempfile on any rejection.
//
// Hook-bypass invariant (AC-SU2):
//   The SPA endpoint writes directly to disk; the agent's PreToolUse
//   guard-workflow-fields hook does NOT fire for these writes because
//   no MCP tool is involved.
//
// Audit / action-log:
//   Uses appendActionLogEntry (ARCHITECTURE.md §6.2) and
//   appendWriteAudit (MCP-TOOL-CONTRACT.md §8).

import { createHash } from "node:crypto"
import {
	createWriteStream,
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
} from "node:fs"
import { rename, unlink } from "node:fs/promises"
import { join, resolve } from "node:path"
import type { MultipartFile } from "@fastify/multipart"
import fastifyMultipart from "@fastify/multipart"
import type { FastifyInstance } from "fastify"
import { appendActionLogEntry } from "../orchestrator/workflow/action-log.js"
import {
	canonicalisePath,
	getCurrentTickCounter,
} from "../orchestrator/workflow/drift-baseline.js"
import {
	appendWriteAudit,
	nextEntryId,
} from "../orchestrator/workflow/write-audit.js"
import { intentDir } from "../state-tools.js"
import { emitTelemetry } from "../telemetry.js"
import { requireTunnelAuth } from "./auth.js"
import { isValidSlug, validateIntent, validateStage } from "./validation.js"

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_UPLOAD_MAX_BYTES = 50 * 1024 * 1024 // 50 MB

/**
 * VULN-REPORT V-07: Upload size hard cap.
 *
 * `HAIKU_UPLOAD_MAX_BYTES` previously had no upper bound. A misconfigured
 * 10 GB env value combined with the synchronous SHA-256 in the drift gate
 * stalls the workflow tick (the gate hashes every uploaded file on every
 * tick to detect drift; a 10 GB hash blocks the tick for minutes).
 *
 * Effective cap = `Math.min(envValue, MAX_UPLOAD_BYTES_HARD_CAP)`.
 * Configurations exceeding the hard cap are clamped silently from the
 * client's perspective (still 413 on overrun) and a `haiku.upload.cap_clamped`
 * telemetry event is emitted so the operator sees the misconfig.
 */
const MAX_UPLOAD_BYTES_HARD_CAP = 50 * 1024 * 1024 // 50 MB

/**
 * VULN-REPORT V-01 / V-02: MIME and extension allowlist for SPA uploads.
 *
 * `serveFile`'s MIME map matches `text/html`, `image/svg+xml`, etc., so any
 * uploaded `.html` / `.svg` file rendered inline becomes a stored-XSS vector
 * under the reviewer's privileged tunnel origin.
 *
 * The fix has two layers:
 *   1. `ALLOWED_MIMES_*` — per-route allowlist of MIME types the server
 *      accepts. Anything else is rejected with 415 BEFORE bytes hit disk.
 *   2. `BLOCKED_EXTENSIONS` — defence-in-depth blocklist of file extensions
 *      that render as scripts (or carry script payloads) regardless of the
 *      claimed MIME. Rejected with 415 even when the MIME is on the
 *      allowlist (covers MIME-spoof attacks like `text/plain`+`.html`).
 *
 * Defence in depth — the serve-side hardening (CSP, sandbox sub-origin,
 * inverted MIME map) is deferred to follow-up unit-04 work; this unit
 * closes the upload-side primary vector.
 */
const BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set([
	".html",
	".htm",
	".svg",
	".xml",
	".xhtml",
	".mhtml",
])

/** Stage-output uploads — the SPA writes designer mockups, screenshots,
 *  PDFs, and structured data. Markdown is intentionally allowed because
 *  designers attach `.md` notes alongside binary mockups; markdown is
 *  rendered as `text/plain` by `serveFile` so it does not execute. */
const ALLOWED_MIMES_STAGE_OUTPUT: ReadonlySet<string> = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"application/pdf",
	"text/plain",
	"text/markdown",
	"application/json",
	"application/octet-stream",
])

/** Knowledge uploads — same allowlist as stage-output. Knowledge artifacts
 *  are documentation + research material; the same MIME set covers them. */
const ALLOWED_MIMES_KNOWLEDGE: ReadonlySet<string> = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"application/pdf",
	"text/plain",
	"text/markdown",
	"application/json",
	"application/octet-stream",
])

/** Extract the lowercase extension (including the leading dot) from a
 *  filename. Returns "" when the filename has no extension. */
function fileExtension(filename: string): string {
	const idx = filename.lastIndexOf(".")
	if (idx < 0) return ""
	return filename.slice(idx).toLowerCase()
}

/** Normalise a MIME type by stripping any `; charset=…` parameter and
 *  lowercasing. Returns "" when the value is empty/undefined. */
function normaliseMime(mime: string | undefined): string {
	if (!mime) return ""
	const semi = mime.indexOf(";")
	const head = (semi < 0 ? mime : mime.slice(0, semi)).trim().toLowerCase()
	return head
}

/** True when `filename` ends in an extension that we refuse to accept
 *  regardless of the claimed MIME. Defends against MIME-spoof attacks
 *  where the client sends `text/plain` with a `.html` filename. */
function hasBlockedExtension(filename: string): boolean {
	return BLOCKED_EXTENSIONS.has(fileExtension(filename))
}

/** Exported for tests so the V-07 hard-cap clamp can be asserted without
 *  uploading 50 MiB of payload to verify behavior. */
export function getUploadMaxBytes(): number {
	const raw = process.env.HAIKU_UPLOAD_MAX_BYTES
	let envValue: number
	if (raw === undefined) {
		envValue = DEFAULT_UPLOAD_MAX_BYTES
	} else {
		const parsed = Number.parseInt(raw, 10)
		envValue =
			!Number.isFinite(parsed) || parsed <= 0
				? DEFAULT_UPLOAD_MAX_BYTES
				: parsed
	}
	// V-07: clamp the env value to the hard cap so a misconfigured 10 GB
	// value cannot stall the workflow tick via the sync SHA-256 in the
	// drift gate. Emit a telemetry event when clamping fires so the
	// operator sees the misconfig.
	if (envValue > MAX_UPLOAD_BYTES_HARD_CAP) {
		emitTelemetry("haiku.upload.cap_clamped", {
			env_value: String(envValue),
			hard_cap: String(MAX_UPLOAD_BYTES_HARD_CAP),
		})
		return MAX_UPLOAD_BYTES_HARD_CAP
	}
	return Math.min(envValue, MAX_UPLOAD_BYTES_HARD_CAP)
}

/** Exported for tests — the hard cap that no env value can exceed. */
export const UPLOAD_MAX_BYTES_HARD_CAP = MAX_UPLOAD_BYTES_HARD_CAP

// ── Helpers ────────────────────────────────────────────────────────────────

/** Return true when a stage's state.json marks it as completed/sealed. */
function isStageSealed(intentSlug: string, stage: string): boolean {
	try {
		const stateFile = join(intentDir(intentSlug), "stages", stage, "state.json")
		if (!existsSync(stateFile)) return false
		const raw = readFileSync(stateFile, "utf-8")
		const parsed = JSON.parse(raw) as Record<string, unknown>
		// A stage is writable unless status is "complete" or "sealed".
		const status = parsed.status
		return status === "complete" || status === "sealed"
	} catch {
		return false
	}
}

/** Return true when the intent's worktree is locked by a concurrent process.
 *  We detect this via the git worktree lock file. */
function isIntentWorktreeLocked(intentSlug: string): boolean {
	try {
		// Worktrees created by haiku use the path:
		//   <repoRoot>/.git/worktrees/<slug>/locked
		// We don't need to check git — just look at the haiku worktree path
		// convention: .haiku/worktrees/<intent>/<unit>/.git → ../../../.git/worktrees/<worktree>
		// A simpler heuristic: check for a `.lock` file alongside the intent dir.
		// The real lock signal is the intent status field — "locked" status.
		const stateDir = intentDir(intentSlug)
		if (!existsSync(stateDir)) return false
		const intentFile = join(stateDir, "intent.md")
		if (!existsSync(intentFile)) return false
		const raw = readFileSync(intentFile, "utf-8")
		return raw.includes("status: locked") || raw.includes('status: "locked"')
	} catch {
		return false
	}
}

/** Check whether the intent directory is archived (status: archived). */
function isIntentArchived(intentSlug: string): boolean {
	try {
		const stateDir = intentDir(intentSlug)
		const intentFile = join(stateDir, "intent.md")
		if (!existsSync(intentFile)) return false
		const raw = readFileSync(intentFile, "utf-8")
		return (
			raw.includes("status: archived") || raw.includes('status: "archived"')
		)
	} catch {
		return false
	}
}

/** Stream a Fastify multipart file part into a tempfile on disk.
 *  Returns the tempfile path on success, or throws if the size cap is exceeded.
 *  The caller is responsible for deleting the tempfile on error. */
async function streamToTempfile(
	part: MultipartFile,
	destDir: string,
	maxBytes: number,
): Promise<{ tmpPath: string; sha256: string; bytes: number }> {
	// Create the destination directory if needed.
	mkdirSync(destDir, { recursive: true })

	// Place the tempfile in the same directory as the final destination so
	// rename() is always same-filesystem (POSIX atomic).
	const tmpPath = join(
		destDir,
		`.upload-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
	)

	const hash = createHash("sha256")
	let bytesWritten = 0

	const ws = createWriteStream(tmpPath)

	// Track whether the writestream has finished closing so the rejection
	// path can wait for the FD to be released before unlinking — otherwise
	// the writestream's async close can recreate the inode after our sync
	// unlink lands, leaving an orphaned tempfile in the artifacts dir.
	const wsClosed = new Promise<void>((resolve) => {
		ws.on("close", () => {
			resolve()
		})
	})

	await new Promise<void>((res, rej) => {
		ws.on("error", rej)
		ws.on("finish", res)
		part.file.on("error", rej)
		part.file.on("data", (chunk: Buffer) => {
			bytesWritten += chunk.length
			if (bytesWritten > maxBytes) {
				// Stop the stream and signal overflow.
				part.file.destroy()
				ws.destroy()
				rej(
					Object.assign(new Error("payload_too_large"), {
						code: "PAYLOAD_TOO_LARGE",
					}),
				)
				return
			}
			hash.update(chunk)
		})
		part.file.on("end", () => {
			ws.end()
		})
		// pipe() would auto-close; manual wiring to get the size check.
		part.file.pipe(ws)
	}).catch(async (err) => {
		// Wait for the writestream's underlying FD to close before unlinking
		// — otherwise the async `close` callback can recreate the file after
		// our sync unlink (race observed in test/upload-routes.test.mjs's
		// "Upload exceeds size cap" assertion that no temp files remain).
		await wsClosed.catch(() => {
			/* best-effort */
		})
		try {
			unlinkSync(tmpPath)
		} catch {
			/* best-effort */
		}
		throw err
	})

	return { tmpPath, sha256: hash.digest("hex"), bytes: bytesWritten }
}

// ── Route registration ─────────────────────────────────────────────────────

export async function registerUploadRoutes(
	instance: FastifyInstance,
): Promise<void> {
	// Wrap the upload routes in an encapsulated child plugin so that
	// @fastify/multipart's content-type parser and request decorators
	// (req.parts, req.isMultipart, etc.) are scoped to this sub-tree
	// and do NOT leak into the parent Fastify instance.
	//
	// @fastify/multipart uses fastify-plugin internally which normally
	// breaks encapsulation, but when wrapped in an anonymous inner plugin
	// (no fastify-plugin call on the wrapper) the scope boundary holds for
	// the addContentTypeParser call — which is what matters to prevent
	// interference with the application/json parser used by feedback routes.
	//
	// Without this wrapper, @fastify/multipart's global registration alters
	// how Fastify surfaces JSON parse errors, causing the setErrorHandler in
	// default-routes.ts to receive them in a form that fails the
	// FST_ERR_CTP_INVALID_JSON / SyntaxError / regex checks → returns plain
	// 'Bad Request' instead of the validation_failed JSON envelope.
	await instance.register(async (scope) => {
		// Register @fastify/multipart inside the scoped plugin.
		// We set limits.fileSize conservatively to the configured cap
		// but do our own byte-counting in streamToTempfile() so tests
		// can exercise the exact 413 path via env var.
		await scope.register(fastifyMultipart, {
			limits: {
				fileSize: getUploadMaxBytes() + 1, // +1 so our code fires first
				files: 1,
			},
		})

		// ── POST /api/intents/:intent/uploads/stage-output ─────────────────────

		scope.post<{ Params: { intent: string } }>(
			"/api/intents/:intent/uploads/stage-output",
			async (req, reply) => {
				if (!requireTunnelAuth(req, reply, null)) return

				const { intent } = req.params
				if (!isValidSlug(intent)) {
					reply.status(400).send({ error: "bad_param", code: "bad_param" })
					return
				}

				// Intent existence check.
				if (!validateIntent(intent)) {
					reply
						.status(404)
						.send({ error: "intent_not_found", code: "intent_not_found" })
					return
				}

				// Archived intent check.
				if (isIntentArchived(intent)) {
					reply
						.status(404)
						.send({ error: "intent_not_found", code: "intent_not_found" })
					return
				}

				// Worktree locked check.
				if (isIntentWorktreeLocked(intent)) {
					reply
						.status(423)
						.send({ error: "intent_locked", code: "intent_locked" })
					return
				}

				const maxBytes = getUploadMaxBytes()

				// Parse multipart fields.
				let stage: string | undefined
				let targetPath: string | undefined
				let mode: string | undefined
				let attributeToUser: string | undefined
				let filePart: MultipartFile | undefined

				try {
					const parts = req.parts()
					for await (const part of parts) {
						if (part.type === "file") {
							filePart = part as MultipartFile
						} else {
							const val = (part as { value: string }).value
							if (part.fieldname === "stage") stage = val
							else if (part.fieldname === "target_path") targetPath = val
							else if (part.fieldname === "mode") mode = val
							else if (part.fieldname === "attribute_to_user")
								attributeToUser = val
						}
					}
				} catch (err) {
					// If we hit a size cap from @fastify/multipart's own limits:
					const code = (err as { code?: string }).code
					if (
						code === "FST_FILES_LIMIT" ||
						code === "LIMIT_FILE_SIZE" ||
						code === "PAYLOAD_TOO_LARGE"
					) {
						reply
							.status(413)
							.send({ error: "payload_too_large", code: "payload_too_large" })
						return
					}
					reply
						.status(500)
						.send({ error: "write_failed", code: "write_failed" })
					return
				}

				// Field validation.
				if (!stage || !targetPath || !mode || !attributeToUser || !filePart) {
					reply.status(400).send({
						error: "bad_param",
						code: "bad_param",
						message:
							"Missing required fields: stage, target_path, mode, attribute_to_user, file",
					})
					return
				}

				// VULN-REPORT V-02: stored-XSS via stage-output uploads.
				// Reject blocked extensions FIRST (defends against MIME-spoofing
				// where client sends text/plain with a .html filename), then
				// reject unknown MIME types not on the allowlist. We check the
				// uploaded multipart filename AND the target_path so neither
				// alone can sneak a blocked extension through.
				const stageBlockedFromFilename = hasBlockedExtension(filePart.filename)
				const stageBlockedFromTarget = hasBlockedExtension(targetPath)
				if (stageBlockedFromFilename || stageBlockedFromTarget) {
					reply.status(415).send({
						error: "unsupported_media_type",
						code: "unsupported_media_type",
						message: `Files with extensions ${Array.from(BLOCKED_EXTENSIONS).join(", ")} are rejected — they render inline and become a stored-XSS vector. Convert to a non-executable format (PDF, PNG screenshot, plain text) and retry.`,
						blocked_extensions: Array.from(BLOCKED_EXTENSIONS),
					})
					return
				}
				const stageMime = normaliseMime(filePart.mimetype)
				if (!ALLOWED_MIMES_STAGE_OUTPUT.has(stageMime)) {
					reply.status(415).send({
						error: "unsupported_media_type",
						code: "unsupported_media_type",
						message: `MIME type '${stageMime || "<none>"}' is not on the stage-output upload allowlist. Allowed: ${Array.from(ALLOWED_MIMES_STAGE_OUTPUT).sort().join(", ")}.`,
						received_mime: stageMime,
						allowed_mimes: Array.from(ALLOWED_MIMES_STAGE_OUTPUT).sort(),
					})
					return
				}

				if (!["replace", "create", "upsert"].includes(mode)) {
					reply.status(400).send({
						error: "bad_param",
						code: "bad_param",
						message: "mode must be replace, create, or upsert",
					})
					return
				}

				if (!isValidSlug(stage)) {
					reply.status(400).send({ error: "bad_param", code: "bad_param" })
					return
				}

				if (!validateStage(intent, stage)) {
					reply
						.status(403)
						.send({ error: "stage_not_writable", code: "stage_not_writable" })
					return
				}

				// Stage sealed check.
				if (isStageSealed(intent, stage)) {
					reply
						.status(403)
						.send({ error: "stage_not_writable", code: "stage_not_writable" })
					return
				}

				// Path-safety: validate target_path.
				// Must canonicalise to stages/{stage}/artifacts/**
				// The alias outputs/ → artifacts/ is applied per AC-ALIAS3.
				// Reject anything with path separators or traversal.
				const targetPathDecoded = (() => {
					try {
						return decodeURIComponent(targetPath)
					} catch {
						return targetPath
					}
				})()

				// Reject obvious traversal patterns before any filesystem check.
				if (
					targetPathDecoded.includes("..") ||
					targetPathDecoded.includes("\x00") ||
					targetPathDecoded.includes("\\")
				) {
					reply
						.status(400)
						.send({ error: "bad_target_path", code: "bad_target_path" })
					return
				}

				// Normalise the path: strip leading slash, apply alias.
				const targetPathNorm = targetPathDecoded.replace(/^\/+/, "")
				const targetPathCanonical = canonicalisePath(
					`stages/${stage}/${targetPathNorm}`,
				)

				// Must land under stages/{stage}/artifacts/.
				const allowedPrefix = `stages/${stage}/artifacts/`
				if (!targetPathCanonical.startsWith(allowedPrefix)) {
					reply
						.status(400)
						.send({ error: "bad_target_path", code: "bad_target_path" })
					return
				}

				const iDir = intentDir(intent)
				const destAbsPath = join(iDir, targetPathCanonical)
				const destDir = destAbsPath.substring(0, destAbsPath.lastIndexOf("/"))
				// Final traversal check: resolved path must stay inside intentDir/stages/{stage}/artifacts/
				const resolvedDest = resolve(destAbsPath)
				const resolvedAllowed = resolve(join(iDir, allowedPrefix))
				if (!resolvedDest.startsWith(resolvedAllowed)) {
					reply
						.status(400)
						.send({ error: "bad_target_path", code: "bad_target_path" })
					return
				}

				// Mode enforcement.
				const targetExists = existsSync(destAbsPath)
				if (mode === "replace" && !targetExists) {
					reply.status(400).send({
						error: "mode_violation",
						code: "mode_violation",
						message: "mode=replace but target does not exist",
					})
					return
				}
				if (mode === "create" && targetExists) {
					reply
						.status(409)
						.send({ error: "filename_collision", code: "filename_collision" })
					return
				}

				// Stream to tempfile with size check.
				let tmpPath: string | null = null
				let sha256: string
				let bytes: number

				try {
					const result = await streamToTempfile(filePart, destDir, maxBytes)
					tmpPath = result.tmpPath
					sha256 = result.sha256
					bytes = result.bytes
				} catch (err) {
					const code = (err as { code?: string }).code
					if (code === "PAYLOAD_TOO_LARGE") {
						reply
							.status(413)
							.send({ error: "payload_too_large", code: "payload_too_large" })
						return
					}
					reply
						.status(500)
						.send({ error: "write_failed", code: "write_failed" })
					return
				}

				// Atomic rename.
				try {
					mkdirSync(destDir, { recursive: true })
					await rename(tmpPath, destAbsPath)
					tmpPath = null // rename succeeded; tempfile is now the dest
				} catch {
					if (tmpPath) {
						try {
							await unlink(tmpPath)
						} catch {
							/* best-effort */
						}
					}
					reply
						.status(500)
						.send({ error: "write_failed", code: "write_failed" })
					return
				}

				// Stamp action-log entry (author_class: "human-via-mcp").
				const tickCounter = getCurrentTickCounter(iDir, stage)
				const entryId = nextEntryId(tickCounter, 1)
				const now = new Date().toISOString()
				const actionEntry = {
					entry_type: "human_write" as const,
					path: targetPathCanonical,
					sha: sha256,
					author_class: "human-via-mcp" as const,
					timestamp: now,
					human_author_id: attributeToUser,
					entry_id: entryId,
					tick_counter: tickCounter,
				}
				await appendActionLogEntry(iDir, tickCounter, actionEntry)

				// Append audit-log entry (AC-TA2 / write-audit.jsonl).
				await appendWriteAudit(iDir, {
					timestamp: now,
					entry_id: entryId,
					path: targetPathCanonical,
					sha: sha256,
					author_class: "human-via-mcp",
					human_author_id: attributeToUser,
					rationale: null,
					user_instruction_excerpt: null, // SPA uploads have no chat instruction (spec §1)
					tick_counter: tickCounter,
					session_id: null,
					overwrite: targetExists,
					dirs_created: [],
					audit_log_appended: true,
				})

				reply.send({
					ok: true,
					path: targetPathCanonical,
					sha256,
					bytes,
					baseline_updated: false,
					tick_will_observe: true,
				})
			},
		)

		// ── POST /api/intents/:intent/uploads/knowledge ────────────────────────

		scope.post<{ Params: { intent: string } }>(
			"/api/intents/:intent/uploads/knowledge",
			async (req, reply) => {
				if (!requireTunnelAuth(req, reply, null)) return

				const { intent } = req.params
				if (!isValidSlug(intent)) {
					reply.status(400).send({ error: "bad_param", code: "bad_param" })
					return
				}

				if (!validateIntent(intent)) {
					reply
						.status(404)
						.send({ error: "intent_not_found", code: "intent_not_found" })
					return
				}

				if (isIntentArchived(intent)) {
					reply
						.status(404)
						.send({ error: "intent_not_found", code: "intent_not_found" })
					return
				}

				if (isIntentWorktreeLocked(intent)) {
					reply
						.status(423)
						.send({ error: "intent_locked", code: "intent_locked" })
					return
				}

				const maxBytes = getUploadMaxBytes()

				// Parse multipart fields.
				let targetFilename: string | undefined
				let stage: string | null = null
				let attributeToUser: string | undefined
				let filePart: MultipartFile | undefined

				try {
					const parts = req.parts()
					for await (const part of parts) {
						if (part.type === "file") {
							filePart = part as MultipartFile
						} else {
							const val = (part as { value: string }).value
							if (part.fieldname === "target_filename") targetFilename = val
							else if (part.fieldname === "stage") stage = val || null
							else if (part.fieldname === "attribute_to_user")
								attributeToUser = val
							// description is optional — accepted but not stored on disk here
						}
					}
				} catch (err) {
					const code = (err as { code?: string }).code
					if (
						code === "FST_FILES_LIMIT" ||
						code === "LIMIT_FILE_SIZE" ||
						code === "PAYLOAD_TOO_LARGE"
					) {
						reply
							.status(413)
							.send({ error: "payload_too_large", code: "payload_too_large" })
						return
					}
					reply
						.status(500)
						.send({ error: "write_failed", code: "write_failed" })
					return
				}

				if (!targetFilename || !attributeToUser || !filePart) {
					reply.status(400).send({
						error: "bad_param",
						code: "bad_param",
						message:
							"Missing required fields: target_filename, attribute_to_user, file",
					})
					return
				}

				// VULN-REPORT V-01: stored-XSS via knowledge uploads.
				// Block .html / .svg / .xml etc. at the upload boundary so the
				// reviewer's tunnel origin cannot be hijacked when the file is
				// later served back by serveFile. Defends against MIME-spoofing
				// (text/plain claim with .html extension) by checking BOTH the
				// uploaded filename and the target_filename. MIME type must be
				// on the knowledge allowlist.
				const knowBlockedFromFilename = hasBlockedExtension(filePart.filename)
				const knowBlockedFromTarget = hasBlockedExtension(targetFilename)
				if (knowBlockedFromFilename || knowBlockedFromTarget) {
					reply.status(415).send({
						error: "unsupported_media_type",
						code: "unsupported_media_type",
						message: `Files with extensions ${Array.from(BLOCKED_EXTENSIONS).join(", ")} are rejected — they render inline and become a stored-XSS vector. Convert to a non-executable format (PDF, PNG screenshot, plain text) and retry.`,
						blocked_extensions: Array.from(BLOCKED_EXTENSIONS),
					})
					return
				}
				const knowMime = normaliseMime(filePart.mimetype)
				if (!ALLOWED_MIMES_KNOWLEDGE.has(knowMime)) {
					reply.status(415).send({
						error: "unsupported_media_type",
						code: "unsupported_media_type",
						message: `MIME type '${knowMime || "<none>"}' is not on the knowledge upload allowlist. Allowed: ${Array.from(ALLOWED_MIMES_KNOWLEDGE).sort().join(", ")}.`,
						received_mime: knowMime,
						allowed_mimes: Array.from(ALLOWED_MIMES_KNOWLEDGE).sort(),
					})
					return
				}

				// target_filename must be a basename — no path segments.
				const filenameDecoded = (() => {
					try {
						return decodeURIComponent(targetFilename)
					} catch {
						return targetFilename
					}
				})()
				if (
					filenameDecoded.includes("/") ||
					filenameDecoded.includes("\\") ||
					filenameDecoded.includes("..") ||
					filenameDecoded.includes("\x00")
				) {
					reply.status(400).send({
						error: "bad_target_path",
						code: "bad_target_path",
						message: "target_filename must be a basename with no path segments",
					})
					return
				}

				// Validate stage if provided.
				if (stage !== null) {
					if (!isValidSlug(stage)) {
						reply.status(400).send({ error: "bad_param", code: "bad_param" })
						return
					}
					if (!validateStage(intent, stage)) {
						reply
							.status(403)
							.send({ error: "stage_not_writable", code: "stage_not_writable" })
						return
					}
					if (isStageSealed(intent, stage)) {
						reply
							.status(403)
							.send({ error: "stage_not_writable", code: "stage_not_writable" })
						return
					}
				}

				const iDir = intentDir(intent)
				const destRelPath =
					stage !== null
						? `stages/${stage}/knowledge/${filenameDecoded}`
						: `knowledge/${filenameDecoded}`
				const destAbsPath = join(iDir, destRelPath)
				const destDir = destAbsPath.substring(0, destAbsPath.lastIndexOf("/"))

				// filename_collision check (implicit-create semantics).
				const targetExists = existsSync(destAbsPath)
				if (targetExists) {
					reply
						.status(409)
						.send({ error: "filename_collision", code: "filename_collision" })
					return
				}

				// Stream to tempfile with size check.
				let tmpPath: string | null = null
				let sha256: string
				let bytes: number

				try {
					const result = await streamToTempfile(filePart, destDir, maxBytes)
					tmpPath = result.tmpPath
					sha256 = result.sha256
					bytes = result.bytes
				} catch (err) {
					const code = (err as { code?: string }).code
					if (code === "PAYLOAD_TOO_LARGE") {
						reply
							.status(413)
							.send({ error: "payload_too_large", code: "payload_too_large" })
						return
					}
					reply
						.status(500)
						.send({ error: "write_failed", code: "write_failed" })
					return
				}

				// Atomic rename.
				try {
					mkdirSync(destDir, { recursive: true })
					await rename(tmpPath, destAbsPath)
					tmpPath = null
				} catch {
					if (tmpPath) {
						try {
							await unlink(tmpPath)
						} catch {
							/* best-effort */
						}
					}
					reply
						.status(500)
						.send({ error: "write_failed", code: "write_failed" })
					return
				}

				// Stamp action-log entry.
				// For stage-scoped uploads use that stage's tick; for intent-scope
				// knowledge (stage === null) walk all stages to find the active one.
				const knowledgeTickCounter =
					stage !== null
						? getCurrentTickCounter(iDir, stage)
						: getCurrentTickCounter(iDir)
				const entryId = nextEntryId(knowledgeTickCounter, 1)
				const now = new Date().toISOString()
				const actionEntry = {
					entry_type: "human_write" as const,
					path: destRelPath,
					sha: sha256,
					author_class: "human-via-mcp" as const,
					timestamp: now,
					human_author_id: attributeToUser,
					entry_id: entryId,
					tick_counter: knowledgeTickCounter,
				}
				await appendActionLogEntry(iDir, knowledgeTickCounter, actionEntry)

				// Append audit-log entry.
				await appendWriteAudit(iDir, {
					timestamp: now,
					entry_id: entryId,
					path: destRelPath,
					sha: sha256,
					author_class: "human-via-mcp",
					human_author_id: attributeToUser,
					rationale: null,
					user_instruction_excerpt: null,
					tick_counter: knowledgeTickCounter,
					session_id: null,
					overwrite: false,
					dirs_created: [],
					audit_log_appended: true,
				})

				reply.send({
					ok: true,
					path: destRelPath,
					sha256,
					bytes,
					baseline_updated: false,
					tick_will_observe: true,
				})
			},
		)
	}) // end of encapsulated scope
}
