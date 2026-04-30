// orchestrator/workflow/action-log.ts — Per-tick action log.
//
// Responsibilities:
//   - `appendActionLogEntry(intentDir, tickCounter, entry)` — append an
//     `ActionLogEntry` to the intent-scope action log.
//   - `readActionLogForTick(intentDir, tickCounter)` — return entries for
//     a given tick counter.
//   - `findActionLogEntryForPath(entries, pathRel)` — return the most
//     recent entry for a file path, or null.
//
// Storage: a single intent-scope JSONL file at
//   `.haiku/intents/{slug}/action-log.jsonl`
// Each line is a complete `ActionLogEntry` JSON object. The entry carries
// its own `tick_counter` so the file is a unified append-only log that
// can be filtered by tick. The drift-detection gate calls
// `readActionLogForTick` to distinguish `human-via-mcp` from
// `human-implicit` writes (ARCHITECTURE.md §6.2).
//
// No new external dependencies: node:fs/promises only.

import { mkdirSync } from "node:fs"
import { open, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { ActionLogEntry } from "./write-audit.js"

// Re-export so callers can import the type from either module.
export type { ActionLogEntry } from "./write-audit.js"

// ── Path helper ────────────────────────────────────────────────────────────

/** Returns the absolute path of the action log for an intent directory. */
export function actionLogPath(intentDir: string): string {
	return join(intentDir, "action-log.jsonl")
}

// ── Append ─────────────────────────────────────────────────────────────────

/** Append an `ActionLogEntry` to the intent-scope action log using O_APPEND
 *  semantics and fsync (same atomicity contract as `appendWriteAudit`).
 *
 *  The entry's `tick_counter` field is used for per-tick filtering by
 *  `readActionLogForTick`. Parent directories are created if absent.
 *
 *  Returns `{ ok: true }` on success or `{ ok: false, reason: string }`
 *  on failure — never throws. */
export async function appendActionLogEntry(
	intentDir: string,
	_tickCounter: number,
	entry: ActionLogEntry,
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const filePath = actionLogPath(intentDir)

	try {
		mkdirSync(dirname(filePath), { recursive: true })
	} catch (err) {
		return { ok: false, reason: String(err) }
	}

	let fd: Awaited<ReturnType<typeof open>> | null = null
	try {
		fd = await open(filePath, "a")
		const line = `${JSON.stringify(entry)}\n`
		await fd.write(line)
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

// ── Read ───────────────────────────────────────────────────────────────────

/** Read all action-log entries for a given tick counter. Returns an empty
 *  array if the file does not exist or has no entries for that tick.
 *
 *  Lines that are not valid JSON or do not parse as `ActionLogEntry` are
 *  silently skipped (graceful degradation). */
export async function readActionLogForTick(
	intentDir: string,
	tickCounter: number,
): Promise<ActionLogEntry[]> {
	const filePath = actionLogPath(intentDir)

	let raw: string
	try {
		raw = await readFile(filePath, "utf-8")
	} catch {
		// File may not exist yet — that's normal on the first tick.
		return []
	}

	const results: ActionLogEntry[] = []
	for (const line of raw.split("\n")) {
		const trimmed = line.trim()
		if (!trimmed) continue
		try {
			const parsed = JSON.parse(trimmed) as ActionLogEntry
			if (parsed.tick_counter === tickCounter) {
				results.push(parsed)
			}
		} catch {
			// Malformed line — skip.
		}
	}
	return results
}

// ── Query ──────────────────────────────────────────────────────────────────

/** Return the most recent `ActionLogEntry` for a given file path from a
 *  pre-loaded entry list, or `null` if none exists.
 *
 *  "Most recent" is determined by array order: the last matching entry in
 *  the list wins. Callers that need cross-tick ordering should sort entries
 *  by timestamp before calling this function; within a single tick, array
 *  order (insertion order from the append log) is sufficient. */
export function findActionLogEntryForPath(
	entries: ActionLogEntry[],
	pathRel: string,
): ActionLogEntry | null {
	let result: ActionLogEntry | null = null
	for (const entry of entries) {
		if (entry.path === pathRel) {
			result = entry
		}
	}
	return result
}
