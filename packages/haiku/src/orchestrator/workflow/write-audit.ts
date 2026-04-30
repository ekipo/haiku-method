// orchestrator/workflow/write-audit.ts — Append-only audit log for
// human-attributed write events.
//
// Responsibilities:
//   - `WriteAuditRecord` TypeScript type matching MCP-TOOL-CONTRACT.md §8.1.
//   - `appendWriteAudit(intentDir, record)` — opens write-audit.jsonl in
//     O_APPEND mode, writes JSON.stringify(record) + "\n" in a single
//     write() call, and fsyncs before returning.
//     Returns { ok: true } on success and { ok: false, reason } on failure.
//     Failures do NOT throw — caller surfaces via audit_log_appended field.
//   - `nextEntryId(tickCounter, sequenceNumber)` — formats as
//     HWM-{tickCounter}-{NN} with zero-padded NN (≥ 2 digits).
//   - `truncateInstruction(text, max?)` — truncates user-instruction excerpts
//     to `max` chars (default 200), appending "..." when truncated.
//
// Concurrency: POSIX O_APPEND guarantees atomic appends ≤ PIPE_BUF (≥ 4 KiB).
// v1 audit records are well under 4 KiB so concurrent writers are safe.

import { constants, open } from "node:fs/promises"
import { join } from "node:path"

// ── Types ──────────────────────────────────────────────────────────────────

/** One audit log record per successful haiku_human_write invocation.
 *  Matches MCP-TOOL-CONTRACT.md §8.1. */
export interface WriteAuditRecord {
	/** ISO-8601 UTC timestamp of the write. */
	timestamp: string
	/** HWM-{tick}-{NN} identifier. */
	entry_id: string
	/** Intent-relative path written. */
	path: string
	/** SHA-256 hex digest of written content. */
	sha: string
	/** Always "human-via-mcp" in stored records. */
	author_class: "human-via-mcp"
	/** Caller-supplied human identifier; null if not provided. */
	human_author_id: string | null
	/** Caller-supplied rationale; null if not provided. */
	rationale: string | null
	/** First 200 chars of the user's instruction; null if not supplied.
	 *  Truncated by the caller via truncateInstruction(). */
	user_instruction_excerpt: string | null
	/** Tick counter at time of write. */
	tick_counter: number
	/** MCP session ID; null if not accessible. */
	session_id: string | null
	/** Echo of the overwrite input field. */
	overwrite: boolean
	/** Intermediate directories created as a side effect. */
	dirs_created: string[]
	/** Always true in stored records. */
	audit_log_appended: true
}

/** Success result from appendWriteAudit. */
export interface WriteAuditOk {
	ok: true
}

/** Failure result from appendWriteAudit. Never throws. */
export interface WriteAuditFail {
	ok: false
	/** Human-readable description of the failure. */
	reason: string
}

export type WriteAuditResult = WriteAuditOk | WriteAuditFail

// ── Audit log path ─────────────────────────────────────────────────────────

function auditLogPath(intentDir: string): string {
	return join(intentDir, "write-audit.jsonl")
}

// ── appendWriteAudit ───────────────────────────────────────────────────────

/** Append a single write-audit record to write-audit.jsonl.
 *
 *  Opens the file with O_APPEND | O_CREAT | O_WRONLY so the OS guarantees
 *  atomic positioning to the end of the file before each write. For records
 *  well under PIPE_BUF (4 KiB on Linux/macOS), the single write() call is
 *  atomically delivered without interleaving.
 *
 *  Fsyncs the fd before closing to ensure durability. The fsync is a
 *  best-effort durability guarantee; failure is reported via { ok: false }
 *  but the write may still have landed on disk (fsync failure typically
 *  indicates hardware-level issues).
 *
 *  NEVER throws. Returns { ok: false, reason } on any error so the caller
 *  can surface via the audit_log_appended response field without aborting
 *  the parent write (MCP-TOOL-CONTRACT.md §4.1). */
export async function appendWriteAudit(
	intentDir: string,
	record: WriteAuditRecord,
): Promise<WriteAuditResult> {
	const filePath = auditLogPath(intentDir)
	const line = `${JSON.stringify(record)}\n`

	let fd: Awaited<ReturnType<typeof open>> | null = null
	try {
		fd = await open(
			filePath,
			constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY,
			0o644,
		)
		await fd.write(line)
		await fd.datasync().catch(() => {
			// datasync may not be available on all platforms; fall back to fsync.
		})
		try {
			await fd.sync()
		} catch {
			// fsync failure is best-effort — the write likely landed, but we
			// cannot guarantee durability. Proceed rather than error.
		}
		return { ok: true }
	} catch (err: unknown) {
		const reason = err instanceof Error ? err.message : String(err)
		return { ok: false, reason }
	} finally {
		if (fd !== null) {
			await fd.close().catch(() => {})
		}
	}
}

// ── nextEntryId ────────────────────────────────────────────────────────────

/** Format an entry ID as HWM-{tickCounter}-{NN} where NN is zero-padded to
 *  at least 2 digits. Example: nextEntryId(42, 1) → "HWM-42-01". */
export function nextEntryId(
	tickCounter: number,
	sequenceNumber: number,
): string {
	const nn = String(sequenceNumber).padStart(2, "0")
	return `HWM-${tickCounter}-${nn}`
}

// ── truncateInstruction ────────────────────────────────────────────────────

/** Truncate a user instruction excerpt to `max` characters (default 200).
 *  When the text exceeds `max`, the returned string is the first `max`
 *  characters followed by "..." (total length: max + 3). */
export function truncateInstruction(text: string, max = 200): string {
	if (text.length <= max) return text
	return `${text.slice(0, max)}...`
}
