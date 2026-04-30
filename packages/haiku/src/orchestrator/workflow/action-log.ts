// orchestrator/workflow/action-log.ts — Per-tick action log for the
// drift-detection subsystem.
//
// Responsibilities:
//   - `ActionLogEntry` TypeScript type (ARCHITECTURE.md §6.2).
//   - `appendActionLogEntry(intentDir, tickCounter, entry)` — appends to
//     .haiku/intents/{slug}/action-log.jsonl with atomic-append semantics.
//   - `readActionLogForTick(intentDir, tickCounter)` — returns all entries
//     for the given tick. The drift gate calls this to look up whether a
//     write came through haiku_human_write.
//   - `findActionLogEntryForPath(entries, pathRel)` — returns the most recent
//     entry for a given file path, or null. Used by the gate when classifying
//     author class.
//
// Storage: a single intent-scoped action-log.jsonl file at the intent root.
// Entries carry their own tick_counter field so queries can filter by tick.
//
// Concurrency: same O_APPEND atomic-write approach as write-audit.ts.

import { constants, open, readFile } from "node:fs/promises"
import { join } from "node:path"

// ── Types ──────────────────────────────────────────────────────────────────

/** An entry in the per-tick action log.
 *  Matches ARCHITECTURE.md §6.2. */
export interface ActionLogEntry {
	/** Type of the action logged. */
	entry_type: "human_write" | "agent_write"
	/** Intent-relative path written. */
	path: string
	/** SHA-256 hex digest of content written. */
	sha: string
	/** Author class at write time. */
	author_class: "human-via-mcp" | "agent"
	/** ISO-8601 UTC timestamp. */
	timestamp: string
	/** Human author identifier; null if not provided. */
	human_author_id: string | null
	/** HWM-{tick}-{NN} entry identifier cross-referencing the audit log. */
	entry_id: string
	/** Tick counter at time of write. */
	tick_counter: number
}

// ── Storage path ───────────────────────────────────────────────────────────

function actionLogPath(intentDir: string): string {
	return join(intentDir, "action-log.jsonl")
}

// ── appendActionLogEntry ───────────────────────────────────────────────────

/** Append a single action-log entry to action-log.jsonl.
 *
 *  Uses O_APPEND semantics for atomic positioning. For entries well under
 *  PIPE_BUF (4 KiB on Linux/macOS), a single write() is delivered atomically
 *  without interleaving from concurrent writers.
 *
 *  The tickCounter parameter is required so callers are explicit about which
 *  tick this entry belongs to. The entry itself also carries tick_counter so
 *  readers can filter by tick without needing separate files per tick.
 *
 *  Throws on disk error — unlike appendWriteAudit, action-log failures
 *  ARE surfaced to callers because missing action-log entries would cause
 *  the drift gate to misclassify human-via-mcp writes as human-implicit. */
export async function appendActionLogEntry(
	intentDir: string,
	_tickCounter: number,
	entry: ActionLogEntry,
): Promise<void> {
	const filePath = actionLogPath(intentDir)
	const line = `${JSON.stringify(entry)}\n`

	const fd = await open(
		filePath,
		constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY,
		0o644,
	)
	try {
		await fd.write(line)
		try {
			await fd.sync()
		} catch {
			// fsync best-effort; proceed.
		}
	} finally {
		await fd.close().catch(() => {})
	}
}

// ── readActionLogForTick ───────────────────────────────────────────────────

/** Read all action-log entries for a given tick counter.
 *
 *  Parses the full action-log.jsonl and returns only entries whose
 *  tick_counter matches the requested tick. Returns an empty array when the
 *  file does not exist or the tick has no entries. */
export async function readActionLogForTick(
	intentDir: string,
	tickCounter: number,
): Promise<ActionLogEntry[]> {
	const filePath = actionLogPath(intentDir)

	let raw: string
	try {
		raw = await readFile(filePath, "utf-8")
	} catch {
		return []
	}

	const entries: ActionLogEntry[] = []
	for (const line of raw.split("\n")) {
		const trimmed = line.trim()
		if (!trimmed) continue
		try {
			const entry = JSON.parse(trimmed) as ActionLogEntry
			if (entry.tick_counter === tickCounter) {
				entries.push(entry)
			}
		} catch {
			// Skip malformed lines.
		}
	}

	return entries
}

// ── findActionLogEntryForPath ──────────────────────────────────────────────

/** Return the most recent action-log entry for the given file path, or null
 *  when no entry matches.
 *
 *  "Most recent" is defined as the latest timestamp (ISO-8601 lexicographic
 *  sort is correct for UTC timestamps in this format). When multiple entries
 *  have the same timestamp the last one in array order wins (matching append
 *  order). */
export function findActionLogEntryForPath(
	entries: ActionLogEntry[],
	pathRel: string,
): ActionLogEntry | null {
	let best: ActionLogEntry | null = null

	for (const entry of entries) {
		if (entry.path !== pathRel) continue
		if (
			best === null ||
			entry.timestamp > best.timestamp ||
			entry.timestamp === best.timestamp
		) {
			// Last-write-wins for equal timestamps (append order preserved).
			best = entry
		}
	}

	return best
}
