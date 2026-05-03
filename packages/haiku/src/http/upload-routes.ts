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
	readFileSync,
	unlinkSync,
} from "node:fs"
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
import { requireTunnelAuth } from "./auth.js"
import { cleanupTempFile, safeMkdirAndRename } from "./path-safety.js"
import { isValidSlug, validateIntent, validateStage } from "./validation.js"

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_UPLOAD_MAX_BYTES = 50 * 1024 * 1024 // 50 MB

function getUploadMaxBytes(): number {
	const raw = process.env.HAIKU_UPLOAD_MAX_BYTES
	if (raw === undefined) return DEFAULT_UPLOAD_MAX_BYTES
	const parsed = Number.parseInt(raw, 10)
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_UPLOAD_MAX_BYTES
	return parsed
}

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
 *  The caller is responsible for deleting the tempfile on error.
 *
 *  V-04 (TOCTOU): the legacy version did `mkdirSync(destDir, { recursive: true })`
 *  here, which silently followed any planted symlink in the chain — that's
 *  the V-04 SPA mirror. The fix moves all destDir creation into
 *  `safeMkdirAndRename` (called by the caller after the tempfile is fully
 *  streamed), and stages the tempfile in `intentRoot` instead. The
 *  tempfile lives on the same filesystem as the destination (intentRoot
 *  is the worktree root, parent of every stage subtree) so `rename()`
 *  remains POSIX-atomic. */
async function streamToTempfile(
	part: MultipartFile,
	tempStagingDir: string,
	maxBytes: number,
): Promise<{ tmpPath: string; sha256: string; bytes: number }> {
	// Stage the tempfile in `tempStagingDir` (intentRoot from the caller).
	// Caller is responsible for calling safeMkdirAndRename to create the
	// real destDir + atomically rename — this function does NOT create the
	// destination directory (V-04 race fix).
	const tmpPath = join(
		tempStagingDir,
		`.upload-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
	)

	const hash = createHash("sha256")
	let bytesWritten = 0

	const ws = createWriteStream(tmpPath)

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
	}).catch((err) => {
		// Clean up the partial tempfile before propagating.
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
	// audit-allow: this file mentions fastify-plugin in commentary only;
	// the wrapper below is an anonymous inner plugin (NOT fastify-plugin)
	// so global hooks (including the V-08 csrfPreHandler) propagate.
	//
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

				// Stream to tempfile with size check. The tempfile is staged in
				// the intent root (NOT in destDir) so V-04 TOCTOU defence in
				// safeMkdirAndRename can validate the parent chain race-free
				// before the destDir is created.
				let tmpPath: string | null = null
				let sha256: string
				let bytes: number

				try {
					const result = await streamToTempfile(filePart, iDir, maxBytes)
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

				// V-04 (Symlink TOCTOU defence): atomic rename via the safe
				// helper. Refuses any pre-existing symlink in the parent chain,
				// creates missing dirs one segment at a time (no `recursive:
				// true` follow-symlink trap), and re-validates the parent's
				// realpath immediately before the rename.
				const safeResult = safeMkdirAndRename(iDir, destDir, tmpPath, destAbsPath)
				if (!safeResult.ok) {
					cleanupTempFile(tmpPath)
					tmpPath = null
					const isSymlinkAttack =
						safeResult.code === "parent_chain_contains_symlink" ||
						safeResult.code === "parent_chain_escape"
					if (isSymlinkAttack) {
						reply.status(400).send({
							error: "bad_target_path",
							code: "bad_target_path",
							reason: safeResult.code,
						})
					} else {
						reply
							.status(500)
							.send({ error: "write_failed", code: "write_failed" })
					}
					return
				}
				tmpPath = null // rename succeeded; tempfile is now the dest

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

				// Stream to tempfile (staged in iDir for V-04 TOCTOU safety —
				// see streamToTempfile docs).
				let tmpPath: string | null = null
				let sha256: string
				let bytes: number

				try {
					const result = await streamToTempfile(filePart, iDir, maxBytes)
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

				// V-04 (Symlink TOCTOU defence): atomic rename via the safe
				// helper. Same semantics as the stage-output route above.
				const safeResult = safeMkdirAndRename(iDir, destDir, tmpPath, destAbsPath)
				if (!safeResult.ok) {
					cleanupTempFile(tmpPath)
					tmpPath = null
					const isSymlinkAttack =
						safeResult.code === "parent_chain_contains_symlink" ||
						safeResult.code === "parent_chain_escape"
					if (isSymlinkAttack) {
						reply.status(400).send({
							error: "bad_target_path",
							code: "bad_target_path",
							reason: safeResult.code,
						})
					} else {
						reply
							.status(500)
							.send({ error: "write_failed", code: "write_failed" })
					}
					return
				}
				tmpPath = null // rename succeeded; tempfile is now the dest

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
