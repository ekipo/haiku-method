// orchestrator/workflow/write-audit.ts — Write-audit JSONL log +
// shared types for human-attributed write events.
//
// Responsibilities:
//   - `WriteAuditRecord`  — per-invocation record written to
//     `.haiku/intents/{slug}/write-audit.jsonl`
//     (MCP-TOOL-CONTRACT.md §8.1).
//   - `ActionLogEntry`    — per-tick action-log entry (ARCHITECTURE.md §6.2).
//   - `nextEntryId(tick, seq)` — format `HWM-{tick}-{NN}`.
//   - `truncateInstruction(text, max)` — truncate to 200 chars with `...`.
//   - `appendWriteAudit(intentDir, record)` — atomic O_APPEND + fsync.
//
// No new external dependencies: node:fs/promises only.

import { mkdirSync } from "node:fs"
import { open } from "node:fs/promises"
import { dirname, join } from "node:path"

// ── Types ──────────────────────────────────────────────────────────────────

/** Per-invocation audit record appended to `write-audit.jsonl`
 *  (MCP-TOOL-CONTRACT.md §8.1). Every field is present in stored records;
 *  `audit_log_appended` is always `true` in the file itself.
 *
 *  Author-identity attribution carries TWO keys (V-03 mitigation):
 *    - `claimed_author_id` — canonical, written on every new line. The
 *      name signals that this value is SELF-REPORTED (agent-supplied or
 *      SPA-form-supplied) and not server-resolved. Consumers MUST treat
 *      it as a claim, not an authority.
 *    - `human_author_id`   — legacy name, mirrored on writes for forward
 *      compatibility. Existing on-disk audit lines retain only the
 *      legacy key; readers honour `claimed_author_id ?? human_author_id`. */
export interface WriteAuditRecord {
	timestamp: string
	entry_id: string
	path: string
	sha: string
	author_class: "human-via-mcp"
	/** Self-reported attribution. New canonical field name. */
	claimed_author_id: string | null
	/** Legacy alias, mirrored to `claimed_author_id` on writes. */
	human_author_id: string | null
	rationale: string | null
	user_instruction_excerpt: string | null
	tick_counter: number
	session_id: string | null
	overwrite: boolean
	dirs_created: string[]
	audit_log_appended: true
	/** Tick scope — "stage" for per-stage tick counter (default), "intent"
	 *  for SPA intent-scope uploads stamped via getIntentScopeTickCounter.
	 *  Drift-gate consumer keys its action-log union by this scope (V-05). */
	tick_scope?: "stage" | "intent"
}

/** Per-tick action-log entry (ARCHITECTURE.md §6.2).
 *  Written by `haiku_human_write` and the SPA upload endpoint.
 *  Read by the drift-detection gate to classify author_class.
 *
 *  Author-identity carries `claimed_author_id` (canonical) and
 *  `human_author_id` (legacy alias) — see WriteAuditRecord above. */
export interface ActionLogEntry {
	entry_type: "human_write" | "agent_write"
	path: string
	sha: string
	author_class: "human-via-mcp" | "agent"
	timestamp: string
	/** Self-reported attribution. New canonical field name. */
	claimed_author_id: string | null
	/** Legacy alias, mirrored to `claimed_author_id` on writes. */
	human_author_id: string | null
	entry_id: string
	tick_counter: number
	/** Tick scope — "stage" for per-stage counter (default), "intent" for
	 *  intent-scope (SPA `stage === null` uploads, V-05). */
	tick_scope?: "stage" | "intent"
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Format a write entry identifier: `HWM-{tickCounter}-{NN}` where NN is
 *  zero-padded to at least 2 digits (MCP-TOOL-CONTRACT.md §4.1). */
export function nextEntryId(
	tickCounter: number,
	sequenceNumber: number,
): string {
	const nn = String(sequenceNumber).padStart(2, "0")
	return `HWM-${tickCounter}-${nn}`
}

/** Truncate `text` to `max` characters, appending `...` when truncated.
 *  The result is at most `max + 3` chars when truncated, or ≤ max chars
 *  when the input already fits.
 *
 *  Per MCP-TOOL-CONTRACT.md §8.2: "the first 200 characters of the user's
 *  instruction … truncated to 200 chars." This helper truncates to `max`
 *  and appends `...` so the output is `max + 3` = 203 chars maximum. */
export function truncateInstruction(text: string, max = 200): string {
	if (text.length <= max) return text
	return `${text.slice(0, max)}...`
}

// ── Audit-log path ─────────────────────────────────────────────────────────

/** Returns the absolute path of the audit log for an intent directory. */
export function writeAuditPath(intentDir: string): string {
	return join(intentDir, "write-audit.jsonl")
}

// ── Append helpers ─────────────────────────────────────────────────────────

/** Append one line to a JSONL file using O_APPEND semantics and fsync.
 *  The file is opened in append mode so each `write()` call is atomic
 *  under POSIX for payloads ≤ PIPE_BUF (~4 KiB on most platforms).
 *  An fsync follows to ensure durability before returning.
 *
 *  Parent directories are created if they do not exist.
 *
 *  Returns `{ ok: true }` on success or `{ ok: false, reason: string }`
 *  on failure — never throws. */
async function appendJsonlLine(
	filePath: string,
	line: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
	try {
		mkdirSync(dirname(filePath), { recursive: true })
	} catch (err) {
		return { ok: false, reason: String(err) }
	}

	let fd: Awaited<ReturnType<typeof open>> | null = null
	try {
		fd = await open(filePath, "a")
		await fd.write(`${line}\n`)
		await fd.sync()
		return { ok: true }
	} catch (err) {
		return { ok: false, reason: String(err) }
	} finally {
		if (fd !== null) {
			await fd.close().catch(() => {})
		}
	}
}

/** Append a `WriteAuditRecord` to `write-audit.jsonl` (MCP-TOOL-CONTRACT.md §8).
 *
 *  Uses O_APPEND + single write + fsync for atomicity and durability.
 *  POSIX guarantees that write()s ≤ PIPE_BUF (4 KiB on most platforms)
 *  to an O_APPEND file are atomic — no interleaved bytes from concurrent
 *  writers. v1 audit records comfortably fit within that bound.
 *
 *  Failures do NOT throw — the caller surfaces them via the
 *  `audit_log_appended` field on the tool response
 *  (MCP-TOOL-CONTRACT.md §4.1). */
export async function appendWriteAudit(
	intentDir: string,
	record: WriteAuditRecord,
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const filePath = writeAuditPath(intentDir)
	const line = JSON.stringify(record)
	return appendJsonlLine(filePath, line)
}
