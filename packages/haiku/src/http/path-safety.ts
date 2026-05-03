// http/path-safety.ts — Filesystem path-traversal defence + safe file
// serving. Used by every asset-serve route (mockups, wireframes,
// stage-artifacts, session files, feedback attachments) so a malicious
// `path` parameter can't escape the session's file root.
//
// SVG defence-in-depth: the feedback-attachment schema rejects
// `image/svg+xml` on POST, but legacy intent dirs may still contain
// `.svg` files. Inline SVG renders execute embedded `<script>` under
// the serving origin — in tunnel mode that's the reviewer's privileged
// tab. Force-download .svg responses so the browser can't render them.
//
// V-04 (Symlink TOCTOU defence): see `safeMkdirAndRename` below. Node's
// path-based APIs (`mkdirSync`/`renameSync`) follow symlinks at every
// intermediate segment, so the legacy "realpath check, then write"
// idiom is race-prone — an attacker who can plant a symlink in the
// chain between the realpath check and the write lands the file at
// the symlink's target. The helper walks the chain segment-by-segment
// with `lstatSync` (refuses any pre-existing symlink), creates missing
// segments individually, and re-validates `realpath(parent)` against
// `realpath(intentRoot)` immediately before the atomic rename. This is
// not pure `O_NOFOLLOW`/`openat` semantics (Node doesn't expose those
// to JS land without a native addon) but it closes every single-shot
// race window and the segment-by-segment lstat closes the V-04
// flagship "missing parent + planted symlink" case that the legacy
// `mkdirSync(parent, { recursive: true })` walked into. Residual race
// risk against an attacker who keeps flipping symlinks faster than
// the rename window is documented in unit-04 ASSESSMENTS.md.

import { readFile, realpath } from "node:fs/promises"
import {
	lstatSync,
	mkdirSync,
	realpathSync,
	renameSync,
	unlinkSync,
} from "node:fs"
import { extname, isAbsolute, relative, resolve, sep } from "node:path"
import type { FastifyReply } from "fastify"
import { FileServeParamsSchema } from "haiku-api"

const MIME_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".md": "text/markdown; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".pdf": "application/pdf",
}

/** Resolve `requested` against `root` and verify the resolved path
 *  stays inside the root after symlink resolution. Returns the real
 *  filesystem path on success, `{ ok: false }` on any traversal or
 *  realpath failure. */
export async function resolvePathSafe(
	root: string,
	requested: string,
): Promise<{ ok: true; path: string } | { ok: false }> {
	const resolvedRoot = resolve(root)
	const resolved = resolve(resolvedRoot, requested)
	if (!resolved.startsWith(`${resolvedRoot}/`) && resolved !== resolvedRoot) {
		return { ok: false }
	}
	try {
		const realResolved = await realpath(resolved).catch(() => null)
		const realBase = await realpath(resolvedRoot).catch(() => resolvedRoot)
		if (
			!realResolved ||
			(!realResolved.startsWith(`${realBase}/`) && realResolved !== realBase)
		) {
			return { ok: false }
		}
		return { ok: true, path: realResolved }
	} catch {
		return { ok: false }
	}
}

/**
 * Schema-level path refinement. Rejects adversarial `..`, `%2e%2e`,
 * null-byte, and backslash fixtures before we even reach the
 * filesystem. Returns true (and sends the 403) on rejection, false
 * when the path passes the schema check.
 */
export function rejectUnsafePathParam(
	reply: FastifyReply,
	sessionId: string,
	filePath: string,
): boolean {
	const parsed = FileServeParamsSchema.safeParse({ sessionId, path: filePath })
	if (parsed.success) return false
	reply.status(403).send({ error: "forbidden_path_traversal" })
	return true
}

export async function serveFile(
	reply: FastifyReply,
	realPath: string,
): Promise<void> {
	try {
		const data = await readFile(realPath)
		const ext = extname(realPath).toLowerCase()
		// SVG defence-in-depth: force download AND strip the MIME type
		// claim. Some browser extensions / proxies key on Content-Type
		// over Content-Disposition when deciding whether to render
		// inline; serving as application/octet-stream removes that
		// ambiguity entirely.
		if (ext === ".svg") {
			reply.header("Content-Type", "application/octet-stream")
			reply.header("Content-Disposition", "attachment")
		} else {
			const contentType = MIME_TYPES[ext] ?? "application/octet-stream"
			reply.header("Content-Type", contentType)
		}
		reply.send(data)
	} catch {
		reply.status(404).send("Not found")
	}
}

export async function serveUnderRoot(
	reply: FastifyReply,
	rootDir: string,
	filePath: string,
): Promise<void> {
	const safe = await resolvePathSafe(rootDir, filePath)
	if (!safe.ok) {
		reply.status(403).send({ error: "forbidden_path_traversal" })
		return
	}
	return serveFile(reply, safe.path)
}

// ── safeMkdirAndRename — V-04 race-free atomic write helper ────────────────
//
// Defends against the `mkdirSync(recursive: true)`-then-`rename` TOCTOU
// pattern flagged in V-04. The legacy idiom:
//
//     realpathSync(parent).startsWith(intentRoot)   // race window opens
//     mkdirSync(parent, { recursive: true })        // follows planted symlinks
//     rename(tmp, dest)                             // lands outside intentRoot
//
// is race-prone because `mkdirSync(recursive: true)` follows pre-existing
// symlinks at any intermediate segment. An attacker who plants a symlink
// in a missing-but-soon-to-be-created chain segment lands the file at
// the symlink's target.
//
// The helper:
//
// 1. Refuses any pre-existing **symlink** at any chain segment by
//    walking the path with `lstatSync` (which does NOT follow
//    symlinks). A planted `ln -s /tmp/owned stages/security/knowledge`
//    is detected before `mkdir` runs.
// 2. Creates missing intermediate dirs **one segment at a time** with
//    non-recursive `mkdirSync`, so a symlink planted between segment
//    N and N+1 cannot be silently followed by `recursive: true`.
// 3. Re-validates `realpathSync(parent)` against
//    `realpathSync(intentRoot)` IMMEDIATELY before the `rename`. The
//    window between this validation and `rename` is the only residual
//    race; by definition the rename is one syscall, so the window is
//    measured in microseconds rather than the milliseconds-to-seconds
//    a `mkdirSync(recursive: true)` walk takes. (Documented residual
//    in unit-04 ASSESSMENTS.md as out-of-scope for unit-03.)
// 4. Performs the atomic `rename`. If the rename fails, the caller is
//    responsible for cleaning up the temp file (we leave it where the
//    caller put it so the existing cleanup paths in
//    `haiku_human_write` and `upload-routes` continue to work).
//
// Errors are returned as a structured discriminated union so the
// caller can translate them to the right HTTP / MCP error code without
// leaking filesystem detail to the client.

export type SafeMkdirAndRenameResult =
	| { ok: true }
	| {
			ok: false
			code:
				| "parent_chain_contains_symlink"
				| "parent_chain_escape"
				| "parent_open_failed"
				| "rename_failed"
			detail: string
	  }

/**
 * Atomically rename `tmpPath` to `destPath` after creating any missing
 * intermediate directories under `parentDir`, refusing to traverse any
 * pre-existing symlink in the chain.
 *
 * @param intentRoot Absolute path to the intent directory. The full
 *   chain from `intentRoot` to `parentDir` is what gets validated; any
 *   segment OUTSIDE `intentRoot` is rejected as `parent_chain_escape`.
 * @param parentDir  Absolute path to the parent directory that `destPath`
 *   should land in. Must be `intentRoot` or below it.
 * @param tmpPath    Absolute path to the existing temp file (the
 *   caller has already streamed bytes into it).
 * @param destPath   Absolute path of the final destination file. Must
 *   live inside `parentDir`.
 *
 * The function is synchronous because (a) the underlying `lstatSync`,
 * `mkdirSync`, `realpathSync`, and `renameSync` are sync, and (b) keeping
 * the entire chain walk on a single tick narrows the race window even
 * further — async hops would let the event loop interleave attacker
 * filesystem ops between segments.
 */
export function safeMkdirAndRename(
	intentRoot: string,
	parentDir: string,
	tmpPath: string,
	destPath: string,
): SafeMkdirAndRenameResult {
	const rootAbs = resolve(intentRoot)
	const parentAbs = resolve(parentDir)
	const destAbs = resolve(destPath)

	// 1. Verify intentRoot is itself a real directory (not a symlink).
	let realRoot: string
	try {
		const st = lstatSync(rootAbs)
		if (st.isSymbolicLink()) {
			return {
				ok: false,
				code: "parent_chain_contains_symlink",
				detail: `intent root '${rootAbs}' is itself a symlink — refusing`,
			}
		}
		realRoot = realpathSync(rootAbs)
	} catch (err) {
		return {
			ok: false,
			code: "parent_open_failed",
			detail: `cannot stat intent root: ${stringifyError(err)}`,
		}
	}

	// 2. Verify parentAbs is at or below rootAbs (string-prefix check
	//    against the resolved-but-not-yet-realpath'd path).
	if (parentAbs !== rootAbs && !parentAbs.startsWith(`${rootAbs}${sep}`)) {
		return {
			ok: false,
			code: "parent_chain_escape",
			detail: `parent '${parentAbs}' is not inside intent root '${rootAbs}'`,
		}
	}

	// Same check for destAbs — the file itself must land below parentAbs
	// (parentAbs/file.md, no climbing).
	if (!destAbs.startsWith(`${parentAbs}${sep}`)) {
		return {
			ok: false,
			code: "parent_chain_escape",
			detail: `dest '${destAbs}' is not directly below parent '${parentAbs}'`,
		}
	}

	// 3. Walk the chain from rootAbs to parentAbs segment by segment.
	//    For each segment:
	//      a. lstatSync — if it exists AND is a symlink → refuse.
	//      b. lstatSync — if it exists AND is NOT a directory → refuse.
	//      c. lstatSync — if it does NOT exist → mkdirSync (non-recursive).
	const chainRel = relative(rootAbs, parentAbs)
	const segments = chainRel === "" ? [] : chainRel.split(sep)

	let cur = rootAbs
	for (const seg of segments) {
		// Defence against `..` and absolute segments slipping in via
		// caller-side path manipulation. `relative()` should never produce
		// these for paths that pass step 2's prefix check, but belt-and-
		// braces — refuse rather than walk past intentRoot.
		if (seg === "" || seg === "." || seg === ".." || isAbsolute(seg)) {
			return {
				ok: false,
				code: "parent_chain_escape",
				detail: `chain segment '${seg}' is invalid`,
			}
		}
		cur = resolve(cur, seg)

		try {
			const st = lstatSync(cur)
			if (st.isSymbolicLink()) {
				// V-04 flagship defence: a planted symlink in the chain.
				return {
					ok: false,
					code: "parent_chain_contains_symlink",
					detail: `segment '${cur}' is a symbolic link — refusing to traverse`,
				}
			}
			if (!st.isDirectory()) {
				return {
					ok: false,
					code: "parent_chain_escape",
					detail: `segment '${cur}' exists but is not a directory`,
				}
			}
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code
			if (code === "ENOENT") {
				// Segment missing — create it (non-recursive). If an
				// attacker races us by creating a symlink at this exact
				// path between the lstat and the mkdir, mkdirSync without
				// `recursive: true` returns EEXIST and we re-lstat to
				// detect the planted symlink.
				try {
					mkdirSync(cur)
				} catch (mkErr) {
					const mkCode = (mkErr as NodeJS.ErrnoException).code
					if (mkCode === "EEXIST") {
						// Re-validate: someone (attacker?) created the segment
						// between our lstat and our mkdir. Refuse if it's a
						// symlink or non-dir.
						try {
							const st2 = lstatSync(cur)
							if (st2.isSymbolicLink()) {
								return {
									ok: false,
									code: "parent_chain_contains_symlink",
									detail: `segment '${cur}' became a symlink during mkdir race`,
								}
							}
							if (!st2.isDirectory()) {
								return {
									ok: false,
									code: "parent_chain_escape",
									detail: `segment '${cur}' became a non-directory during mkdir race`,
								}
							}
							// Real dir created by a friendly racer — continue.
						} catch (statErr) {
							return {
								ok: false,
								code: "parent_open_failed",
								detail: `cannot stat segment after EEXIST: ${stringifyError(statErr)}`,
							}
						}
					} else {
						return {
							ok: false,
							code: "parent_open_failed",
							detail: `mkdir '${cur}' failed: ${stringifyError(mkErr)}`,
						}
					}
				}
			} else {
				return {
					ok: false,
					code: "parent_open_failed",
					detail: `lstat '${cur}' failed: ${stringifyError(err)}`,
				}
			}
		}
	}

	// 4. Final realpath gate IMMEDIATELY before rename. This closes the
	//    "attacker swapped a freshly-created intermediate dir for a
	//    symlink between our lstat and the rename" hole. The window
	//    between this realpath and the rename is one Node tick (no I/O
	//    in between except the rename itself), which is the smallest
	//    practical window.
	try {
		const realParent = realpathSync(parentAbs)
		if (
			realParent !== realRoot &&
			!realParent.startsWith(`${realRoot}${sep}`)
		) {
			return {
				ok: false,
				code: "parent_chain_escape",
				detail: `realpath(parent)='${realParent}' is not inside realpath(intentRoot)='${realRoot}'`,
			}
		}
	} catch (err) {
		return {
			ok: false,
			code: "parent_open_failed",
			detail: `realpath(parent) failed: ${stringifyError(err)}`,
		}
	}

	// 5. Atomic rename. POSIX `rename` is a single syscall — no race
	//    against parent-dir symlink swaps once we've passed step 4
	//    (the kernel resolves `destAbs` once, atomically).
	try {
		renameSync(tmpPath, destAbs)
	} catch (err) {
		return {
			ok: false,
			code: "rename_failed",
			detail: `rename '${tmpPath}' → '${destAbs}' failed: ${stringifyError(err)}`,
		}
	}

	return { ok: true }
}

function stringifyError(err: unknown): string {
	if (err instanceof Error) return err.message
	return String(err)
}

/** Best-effort cleanup of a temp file. Swallows ENOENT and any other
 *  error — the caller is past the point where it matters. Provided so
 *  the existing `haiku_human_write` and `upload-routes` cleanup paths
 *  can stop catching their own unlink errors and just call this. */
export function cleanupTempFile(tmpPath: string): void {
	try {
		unlinkSync(tmpPath)
	} catch {
		// best effort
	}
}
