#!/usr/bin/env npx tsx
// Tests for write-audit.ts and action-log.ts
//
// Coverage:
//   1. Append-only invariant: write three records, read them back in order;
//      no exported truncate/clear function exposed.
//   2. Each record is one complete JSON object on its own line (round-trip
//      via JSON.parse after split('\n')).
//   3. Failed disk write surfaces { ok: false, reason } instead of throwing.
//   4. Concurrent appends from two simulated writers produce two distinct
//      lines (no interleaved bytes).
//   5. nextEntryId(42, 1) returns "HWM-42-01"; nextEntryId(42, 12) returns "HWM-42-12".
//   6. appendActionLogEntry round-trips through readActionLogForTick.
//   7. findActionLogEntryForPath returns the newest entry when multiple entries
//      reference the same path.
//   8. truncateInstruction("a".repeat(250)) returns 203 chars (200 + "...").
//   9. Audit-log append never fails the caller's parent write — even when the
//      audit-log filesystem is read-only, appendWriteAudit returns
//      { ok: false, reason } and the test verifies the parent caller can continue.

import assert from "node:assert"
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { chmod } from "node:fs/promises"
import { tmpdir, platform } from "node:os"
import { join } from "node:path"

const tmp = mkdtempSync(join(tmpdir(), "haiku-write-audit-test-"))

const {
	appendWriteAudit,
	nextEntryId,
	truncateInstruction,
} = await import("../src/orchestrator/workflow/write-audit.ts")

const {
	appendActionLogEntry,
	readActionLogForTick,
	findActionLogEntryForPath,
} = await import("../src/orchestrator/workflow/action-log.ts")

let passed = 0
let failed = 0
const pending = []

function test(name, fn) {
	try {
		const r = fn()
		if (r && typeof r.then === "function") {
			const p = r.then(
				() => {
					passed++
					console.log(`  ✓ ${name}`)
				},
				(e) => {
					failed++
					console.log(`  ✗ ${name}: ${e.message}`)
					if (process.env.VERBOSE) console.error(e)
				},
			)
			pending.push(p)
			return p
		}
		passed++
		console.log(`  ✓ ${name}`)
	} catch (e) {
		failed++
		console.log(`  ✗ ${name}: ${e.message}`)
		if (process.env.VERBOSE) console.error(e)
	}
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeIntentDir(name) {
	const intentDir = join(tmp, name)
	mkdirSync(intentDir, { recursive: true })
	return intentDir
}

function makeAuditRecord(overrides = {}) {
	return {
		timestamp: "2026-04-28T12:00:00.000Z",
		entry_id: "HWM-1-01",
		path: "knowledge/test.md",
		sha: "a".repeat(64),
		author_class: "human-via-mcp",
		human_author_id: null,
		rationale: null,
		user_instruction_excerpt: null,
		tick_counter: 1,
		session_id: null,
		overwrite: true,
		dirs_created: [],
		audit_log_appended: true,
		...overrides,
	}
}

function makeActionEntry(overrides = {}) {
	return {
		entry_type: "human_write",
		path: "knowledge/test.md",
		sha: "a".repeat(64),
		author_class: "human-via-mcp",
		timestamp: "2026-04-28T12:00:00.000Z",
		human_author_id: null,
		entry_id: "HWM-1-01",
		tick_counter: 1,
		...overrides,
	}
}

// ── Tests: nextEntryId ───────────────────────────────────────────────────────

console.log("\n=== nextEntryId ===")

test("nextEntryId(42, 1) returns 'HWM-42-01'", () => {
	assert.strictEqual(nextEntryId(42, 1), "HWM-42-01")
})

test("nextEntryId(42, 12) returns 'HWM-42-12'", () => {
	assert.strictEqual(nextEntryId(42, 12), "HWM-42-12")
})

test("nextEntryId(0, 99) returns 'HWM-0-99'", () => {
	assert.strictEqual(nextEntryId(0, 99), "HWM-0-99")
})

test("nextEntryId(100, 5) returns 'HWM-100-05'", () => {
	assert.strictEqual(nextEntryId(100, 5), "HWM-100-05")
})

// ── Tests: truncateInstruction ───────────────────────────────────────────────

console.log("\n=== truncateInstruction ===")

test("truncateInstruction('a'.repeat(250)) returns 203 chars (200 + '...')", () => {
	const input = "a".repeat(250)
	const result = truncateInstruction(input)
	assert.strictEqual(result.length, 203)
	assert.ok(result.endsWith("..."))
	assert.strictEqual(result.slice(0, 200), "a".repeat(200))
})

test("truncateInstruction does not truncate when text <= 200 chars", () => {
	const input = "hello world"
	assert.strictEqual(truncateInstruction(input), "hello world")
})

test("truncateInstruction does not truncate when text is exactly 200 chars", () => {
	const input = "x".repeat(200)
	assert.strictEqual(truncateInstruction(input), input)
	assert.strictEqual(truncateInstruction(input).length, 200)
})

test("truncateInstruction custom max works", () => {
	const result = truncateInstruction("abcdef", 3)
	assert.strictEqual(result, "abc...")
	assert.strictEqual(result.length, 6)
})

// ── Tests: appendWriteAudit ──────────────────────────────────────────────────

console.log("\n=== appendWriteAudit — append-only invariant ===")

await test("write three records, read them back in order", async () => {
	const intentDir = makeIntentDir("append-three")
	const r1 = makeAuditRecord({ entry_id: "HWM-1-01", path: "knowledge/a.md" })
	const r2 = makeAuditRecord({ entry_id: "HWM-1-02", path: "knowledge/b.md" })
	const r3 = makeAuditRecord({ entry_id: "HWM-1-03", path: "knowledge/c.md" })

	await appendWriteAudit(intentDir, r1)
	await appendWriteAudit(intentDir, r2)
	await appendWriteAudit(intentDir, r3)

	const auditPath = join(intentDir, "write-audit.jsonl")
	assert.ok(existsSync(auditPath), "write-audit.jsonl should exist")

	const lines = readFileSync(auditPath, "utf-8")
		.split("\n")
		.filter((l) => l.trim().length > 0)

	assert.strictEqual(lines.length, 3, "should have 3 lines")

	const parsed = lines.map((l) => JSON.parse(l))
	assert.strictEqual(parsed[0].entry_id, "HWM-1-01")
	assert.strictEqual(parsed[1].entry_id, "HWM-1-02")
	assert.strictEqual(parsed[2].entry_id, "HWM-1-03")
})

test("no exported truncate/clear function on write-audit module", async () => {
	// The module should not expose any way to clear/truncate the audit log.
	const mod = await import("../src/orchestrator/workflow/write-audit.ts")
	assert.ok(typeof mod.appendWriteAudit === "function", "appendWriteAudit must be exported")
	assert.ok(!("truncateAuditLog" in mod), "truncateAuditLog must not be exported")
	assert.ok(!("clearAuditLog" in mod), "clearAuditLog must not be exported")
	assert.ok(!("deleteAuditLog" in mod), "deleteAuditLog must not be exported")
})

console.log("\n=== appendWriteAudit — one-JSON-per-line invariant ===")

await test("each record is one complete JSON object on its own line", async () => {
	const intentDir = makeIntentDir("jsonl-shape")
	const r1 = makeAuditRecord({ entry_id: "HWM-2-01" })
	const r2 = makeAuditRecord({ entry_id: "HWM-2-02" })

	await appendWriteAudit(intentDir, r1)
	await appendWriteAudit(intentDir, r2)

	const raw = readFileSync(join(intentDir, "write-audit.jsonl"), "utf-8")
	const lines = raw.split("\n").filter((l) => l.trim().length > 0)

	for (const line of lines) {
		// Each line must be independently parseable.
		const obj = JSON.parse(line)
		assert.ok(typeof obj.entry_id === "string", "entry_id should be string")
		// Stringify+parse round-trip must be identical.
		assert.deepStrictEqual(JSON.parse(JSON.stringify(obj)), obj)
	}
})

console.log("\n=== appendWriteAudit — error handling ===")

await test("failed disk write returns { ok: false, reason } instead of throwing", async () => {
	// Point at a non-existent deeply nested path that cannot be created.
	// We use a path where a file exists at an intermediate directory position
	// (i.e., a file is named the same as a directory we'd need to create).
	const intentDir = makeIntentDir("error-handling")
	// Create a FILE named "write-audit.jsonl" inside a dir named "write-audit.jsonl"
	// is impossible — instead, create a directory at the exact path of the JSONL file.
	// write-audit.jsonl will need to be a file, but we'll make the intentDir read-only
	// on unix to force an EACCES.

	// Skip on Windows — chmod read-only doesn't work the same way.
	if (process.platform === "win32") {
		console.log("    (skipped on Windows)")
		return
	}

	const readOnlyDir = join(intentDir, "readonly")
	mkdirSync(readOnlyDir, { recursive: true })
	// Make directory non-writable.
	await chmod(readOnlyDir, 0o555)

	try {
		const record = makeAuditRecord({ entry_id: "HWM-3-01" })
		const result = await appendWriteAudit(readOnlyDir, record)
		assert.strictEqual(result.ok, false, "should return ok: false on EACCES")
		assert.ok(typeof result.reason === "string", "should include reason string")
		assert.ok(result.reason.length > 0, "reason should not be empty")
	} finally {
		// Restore permissions so cleanup works.
		await chmod(readOnlyDir, 0o755).catch(() => {})
	}
})

await test("parent caller can continue after audit-log failure", async () => {
	if (process.platform === "win32") {
		console.log("    (skipped on Windows)")
		return
	}

	const intentDir = makeIntentDir("audit-fail-continue")
	const readOnlyDir = join(intentDir, "readonly")
	mkdirSync(readOnlyDir, { recursive: true })
	await chmod(readOnlyDir, 0o555)

	let parentWriteContinued = false
	try {
		const record = makeAuditRecord({ entry_id: "HWM-4-01" })
		const result = await appendWriteAudit(readOnlyDir, record)
		// The important thing: this doesn't throw; the caller can inspect ok and continue.
		assert.strictEqual(result.ok, false)
		// Simulate parent caller continuing after the audit failure.
		parentWriteContinued = true
	} catch {
		assert.fail("appendWriteAudit must not throw even on disk failure")
	} finally {
		await chmod(readOnlyDir, 0o755).catch(() => {})
	}

	assert.ok(parentWriteContinued, "parent write should continue after audit failure")
})

console.log("\n=== appendWriteAudit — concurrent appends ===")

await test("concurrent appends from two writers produce two distinct lines (no interleaved bytes)", async () => {
	const intentDir = makeIntentDir("concurrent-appends")
	const r1 = makeAuditRecord({ entry_id: "HWM-5-01", path: "knowledge/x.md" })
	const r2 = makeAuditRecord({ entry_id: "HWM-5-02", path: "knowledge/y.md" })

	// Fire both appends concurrently.
	await Promise.all([
		appendWriteAudit(intentDir, r1),
		appendWriteAudit(intentDir, r2),
	])

	const auditPath = join(intentDir, "write-audit.jsonl")
	const raw = readFileSync(auditPath, "utf-8")
	const lines = raw.split("\n").filter((l) => l.trim().length > 0)

	assert.strictEqual(lines.length, 2, "should have exactly 2 lines")

	// Each line must parse cleanly.
	for (const line of lines) {
		const obj = JSON.parse(line)
		assert.ok(
			obj.entry_id === "HWM-5-01" || obj.entry_id === "HWM-5-02",
			`unexpected entry_id: ${obj.entry_id}`,
		)
	}

	// Both entry IDs must be present (no dropped write).
	const ids = lines.map((l) => JSON.parse(l).entry_id)
	assert.ok(ids.includes("HWM-5-01"), "HWM-5-01 must be present")
	assert.ok(ids.includes("HWM-5-02"), "HWM-5-02 must be present")
})

// ── Tests: appendActionLogEntry / readActionLogForTick ────────────────────────

console.log("\n=== action log: round-trip ===")

await test("appendActionLogEntry round-trips through readActionLogForTick", async () => {
	const intentDir = makeIntentDir("action-log-roundtrip")
	const entry = makeActionEntry({ entry_id: "HWM-10-01", tick_counter: 10 })

	await appendActionLogEntry(intentDir, 10, entry)

	const entries = await readActionLogForTick(intentDir, 10)
	assert.ok(Array.isArray(entries), "should return an array")
	assert.strictEqual(entries.length, 1, "should have one entry")
	assert.deepStrictEqual(entries[0], entry)
})

await test("readActionLogForTick returns entries only for the requested tick", async () => {
	const intentDir = makeIntentDir("action-log-tick-scope")
	const e10 = makeActionEntry({ entry_id: "HWM-10-01", tick_counter: 10 })
	const e11 = makeActionEntry({ entry_id: "HWM-11-01", tick_counter: 11 })

	await appendActionLogEntry(intentDir, 10, e10)
	await appendActionLogEntry(intentDir, 11, e11)

	const tick10 = await readActionLogForTick(intentDir, 10)
	assert.strictEqual(tick10.length, 1)
	assert.strictEqual(tick10[0].entry_id, "HWM-10-01")

	const tick11 = await readActionLogForTick(intentDir, 11)
	assert.strictEqual(tick11.length, 1)
	assert.strictEqual(tick11[0].entry_id, "HWM-11-01")
})

await test("readActionLogForTick returns empty array when no entries exist for tick", async () => {
	const intentDir = makeIntentDir("action-log-empty-tick")
	const entries = await readActionLogForTick(intentDir, 99)
	assert.deepStrictEqual(entries, [])
})

// ── Tests: findActionLogEntryForPath ─────────────────────────────────────────

console.log("\n=== findActionLogEntryForPath ===")

test("returns newest entry when multiple entries reference the same path", () => {
	const older = makeActionEntry({
		entry_id: "HWM-1-01",
		path: "knowledge/file.md",
		timestamp: "2026-04-28T10:00:00.000Z",
	})
	const newer = makeActionEntry({
		entry_id: "HWM-1-02",
		path: "knowledge/file.md",
		timestamp: "2026-04-28T12:00:00.000Z",
	})
	// Pass in order: older first, newer second.
	const result = findActionLogEntryForPath([older, newer], "knowledge/file.md")
	assert.ok(result !== null, "should find an entry")
	assert.strictEqual(result.entry_id, "HWM-1-02", "should return the newest entry")
})

test("returns null when no entry matches the given path", () => {
	const entry = makeActionEntry({ path: "knowledge/other.md" })
	const result = findActionLogEntryForPath([entry], "knowledge/file.md")
	assert.strictEqual(result, null)
})

test("returns the only entry when exactly one matches", () => {
	const entry = makeActionEntry({
		entry_id: "HWM-2-01",
		path: "knowledge/unique.md",
	})
	const result = findActionLogEntryForPath([entry], "knowledge/unique.md")
	assert.ok(result !== null)
	assert.strictEqual(result.entry_id, "HWM-2-01")
})

test("returns null for empty array", () => {
	assert.strictEqual(findActionLogEntryForPath([], "knowledge/file.md"), null)
})

// ── Wait for all async tests ─────────────────────────────────────────────────

await Promise.all(pending)

// ── Cleanup + summary ────────────────────────────────────────────────────────

try {
	rmSync(tmp, { recursive: true, force: true })
} catch {}

console.log("")
console.log(`  ${passed + failed} tests: ${passed} passed, ${failed} failed`)
console.log("")

process.exit(failed > 0 ? 1 : 0)
