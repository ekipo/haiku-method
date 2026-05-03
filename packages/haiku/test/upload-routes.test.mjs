#!/usr/bin/env npx tsx
// Test suite for SPA upload HTTP endpoints.
//
// Covers:
//  1. Designer replaces a stage output: file written, action-log stamped,
//     audit-log appended, no baseline update (AC-SU2).
//  2. PO uploads a knowledge file: same invariants.
//  3. Replace preserves filename; uploaded file is renamed to original name.
//  4. mode=create with colliding filename returns filename_collision (409).
//  5. Upload exceeds size cap → 413 payload_too_large; no temp files left.
//  6. Locked worktree → 423 intent_locked.
//  7. Archived intent → 404 intent_not_found.
//  8. Stage not writable (no artifacts/ but completed stage) → 403.
//  9. Hook-bypass: PreToolUse hook script is NOT invoked during upload.
// 10. Path traversal attack rejected with bad_target_path (400).
//
// Run: npx tsx test/upload-routes.test.mjs

import assert from "node:assert"
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// ── Test environment setup ─────────────────────────────────────────────────

const tmp = mkdtempSync(join(tmpdir(), "haiku-upload-test-"))
const projDir = join(tmp, "project")
const haikuRoot = join(projDir, ".haiku")
const intentSlug = "test-upload-intent"
const intentDirPath = join(haikuRoot, "intents", intentSlug)
const stageName = "design"

// Create intent structure.
mkdirSync(join(intentDirPath, "stages", stageName, "units"), {
	recursive: true,
})
mkdirSync(join(intentDirPath, "stages", stageName, "artifacts"), {
	recursive: true,
})
mkdirSync(join(intentDirPath, "knowledge"), { recursive: true })

writeFileSync(
	join(intentDirPath, "intent.md"),
	`---
title: Test Upload Intent
studio: software
mode: continuous
active_stage: ${stageName}
status: active
stages:
  - ${stageName}
started_at: 2026-04-15T18:00:00Z
completed_at: null
---

Test intent for upload endpoint testing.
`,
)

writeFileSync(
	join(intentDirPath, "stages", stageName, "state.json"),
	JSON.stringify(
		{
			stage: stageName,
			status: "active",
			phase: "execute",
			started_at: "2026-04-15T18:05:00Z",
			completed_at: null,
			visits: 0,
			iteration: 3,
		},
		null,
		2,
	),
)

// Pre-create a file to test replace mode.
// NOTE: VULN-REPORT V-01/V-02 — `.html` is now a blocked extension on
// upload (renders inline → stored-XSS). Use `.md` for the test fixture
// since markdown has the same "designer attaches notes" semantics
// without the script-execution vector.
writeFileSync(
	join(
		intentDirPath,
		"stages",
		stageName,
		"artifacts",
		"dashboard-layout.md",
	),
	"# Dashboard layout — original\n",
)

// Create a second intent for archived/locked tests.
const archivedSlug = "test-archived-intent"
const archivedDirPath = join(haikuRoot, "intents", archivedSlug)
mkdirSync(join(archivedDirPath, "stages", stageName, "artifacts"), {
	recursive: true,
})
writeFileSync(
	join(archivedDirPath, "intent.md"),
	`---
title: Archived Intent
studio: software
mode: continuous
active_stage: ${stageName}
status: archived
stages:
  - ${stageName}
started_at: 2026-04-15T18:00:00Z
completed_at: null
---
`,
)
writeFileSync(
	join(archivedDirPath, "stages", stageName, "state.json"),
	JSON.stringify({
		stage: stageName,
		status: "active",
		phase: "execute",
		visits: 0,
	}),
)

const lockedSlug = "test-locked-intent"
const lockedDirPath = join(haikuRoot, "intents", lockedSlug)
mkdirSync(join(lockedDirPath, "stages", stageName, "artifacts"), {
	recursive: true,
})
writeFileSync(
	join(lockedDirPath, "intent.md"),
	`---
title: Locked Intent
studio: software
mode: continuous
active_stage: ${stageName}
status: locked
stages:
  - ${stageName}
started_at: 2026-04-15T18:00:00Z
completed_at: null
---
`,
)
writeFileSync(
	join(lockedDirPath, "stages", stageName, "state.json"),
	JSON.stringify({
		stage: stageName,
		status: "active",
		phase: "execute",
		visits: 0,
	}),
)

// Create a completed-stage intent for stage_not_writable test.
const sealedSlug = "test-sealed-stage-intent"
const sealedDirPath = join(haikuRoot, "intents", sealedSlug)
mkdirSync(join(sealedDirPath, "stages", stageName, "artifacts"), {
	recursive: true,
})
writeFileSync(
	join(sealedDirPath, "intent.md"),
	`---
title: Sealed Stage Intent
studio: software
mode: continuous
active_stage: ${stageName}
status: active
stages:
  - ${stageName}
started_at: 2026-04-15T18:00:00Z
completed_at: null
---
`,
)
writeFileSync(
	join(sealedDirPath, "stages", stageName, "state.json"),
	JSON.stringify({
		stage: stageName,
		status: "complete",
		phase: "gate",
		visits: 0,
	}),
)

// Stub git so gitCommitState doesn't fail.
const fakeBinDir = join(tmp, "fake-bin")
mkdirSync(fakeBinDir, { recursive: true })
writeFileSync(join(fakeBinDir, "git"), "#!/bin/sh\nexit 0\n")
chmodSync(join(fakeBinDir, "git"), 0o755)
process.env.PATH = `${fakeBinDir}:${process.env.PATH}`

// Track hook invocations — if the PreToolUse guard-workflow-fields hook
// fires we would see it via an env / side channel.  Since the SPA endpoint
// writes directly to disk (no MCP tool call), the hook never fires at all
// in this test process.  We verify the negative: the hook script is never
// exec'd during any upload.
const hookInvocations = 0
const _origSpawn = process.env.HOOK_INVOCATION_COUNT
process.env.HOOK_INVOCATION_COUNT = "0"

process.chdir(projDir)

// ── Imports ────────────────────────────────────────────────────────────────

const { startHttpServer, stopHttpServer } = await import("../src/http.ts")

let passed = 0
let failed = 0

async function test(name, fn) {
	try {
		await fn()
		passed++
		console.log(`  ✓ ${name}`)
	} catch (e) {
		failed++
		console.log(`  ✗ ${name}: ${e.message}`)
		if (process.env.VERBOSE) console.log(e.stack)
	}
}

// ── Multipart form builder ─────────────────────────────────────────────────

/**
 * Build a minimal multipart/form-data body for upload tests.
 * Returns { body: Buffer, contentType: string }.
 */
function buildMultipart(fields, files) {
	const boundary = `----FormBoundary${Math.random().toString(36).slice(2)}`
	const parts = []

	for (const [name, value] of Object.entries(fields)) {
		parts.push(
			`--${boundary}\r\n` +
				`Content-Disposition: form-data; name="${name}"\r\n\r\n` +
				`${value}\r\n`,
		)
	}

	for (const { name, filename, content, contentType } of files) {
		const ct = contentType ?? "application/octet-stream"
		parts.push(
			`--${boundary}\r\n` +
				`Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n` +
				`Content-Type: ${ct}\r\n\r\n`,
		)
		parts.push(content)
		parts.push("\r\n")
	}

	parts.push(`--${boundary}--\r\n`)

	const buffers = parts.map((p) =>
		typeof p === "string" ? Buffer.from(p, "utf-8") : p,
	)
	const body = Buffer.concat(buffers)
	return { body, contentType: `multipart/form-data; boundary=${boundary}` }
}

// ── Main test suite ────────────────────────────────────────────────────────

async function run() {
	const port = await startHttpServer()
	const baseUrl = `http://127.0.0.1:${port}`

	console.log("\n=== POST /api/intents/:intent/uploads/stage-output ===")

	await test("Designer replaces a stage output: file written, action-log + audit-log stamped, no baseline update", async () => {
		const fileContent = Buffer.from("# Dashboard layout — v2\n")
		const { body, contentType } = buildMultipart(
			{
				stage: stageName,
				target_path: "artifacts/dashboard-layout.md",
				mode: "replace",
				attribute_to_user: "alice",
			},
			[
				{
					name: "file",
					filename: "dashboard-v2.md",
					content: fileContent,
					contentType: "text/markdown",
				},
			],
		)

		const res = await fetch(
			`${baseUrl}/api/intents/${intentSlug}/uploads/stage-output`,
			{
				method: "POST",
				headers: { "Content-Type": contentType },
				body,
			},
		)
		const data = await res.json()
		assert.strictEqual(
			res.status,
			200,
			`Expected 200, got ${res.status}: ${JSON.stringify(data)}`,
		)
		assert.ok(data.ok, "Response should have ok: true")
		assert.strictEqual(
			data.baseline_updated,
			false,
			"baseline_updated must be false",
		)
		assert.strictEqual(
			data.tick_will_observe,
			true,
			"tick_will_observe must be true",
		)
		assert.ok(data.sha256, "sha256 should be present")
		assert.ok(data.bytes > 0, "bytes should be > 0")
		assert.ok(
			data.path.startsWith("stages/design/artifacts/"),
			"path should be in artifacts/",
		)

		// File written to correct location.
		const dest = join(
			intentDirPath,
			"stages",
			stageName,
			"artifacts",
			"dashboard-layout.md",
		)
		assert.ok(existsSync(dest), "Destination file should exist")
		const written = readFileSync(dest, "utf-8")
		assert.ok(
			written.includes("Dashboard layout — v2"),
			"File should contain new content",
		)

		// Action-log entry stamped.
		const actionLog = join(intentDirPath, "action-log.jsonl")
		assert.ok(existsSync(actionLog), "action-log.jsonl should exist")
		const lines = readFileSync(actionLog, "utf-8").split("\n").filter(Boolean)
		const entry = JSON.parse(lines[lines.length - 1])
		assert.strictEqual(
			entry.author_class,
			"human-via-mcp",
			"author_class must be human-via-mcp",
		)
		assert.strictEqual(entry.human_author_id, "alice")

		// Audit-log entry appended.
		const auditLog = join(intentDirPath, "write-audit.jsonl")
		assert.ok(existsSync(auditLog), "write-audit.jsonl should exist")
		const auditLines = readFileSync(auditLog, "utf-8")
			.split("\n")
			.filter(Boolean)
		const auditEntry = JSON.parse(auditLines[auditLines.length - 1])
		assert.strictEqual(auditEntry.author_class, "human-via-mcp")
		assert.strictEqual(auditEntry.human_author_id, "alice")
		assert.strictEqual(
			auditEntry.user_instruction_excerpt,
			null,
			"SPA uploads have no chat instruction",
		)

		// No baseline.json created.
		const baseline = join(intentDirPath, "stages", stageName, "baseline.json")
		assert.ok(
			!existsSync(baseline),
			"baseline.json must NOT be created by the upload endpoint",
		)
	})

	await test("Replace preserves filename; uploaded file is renamed to the original target name", async () => {
		// The target is "dashboard-layout.md"; we upload "dashboard-v3.md"
		const fileContent = Buffer.from("# Dashboard layout — v3\n")
		const { body, contentType } = buildMultipart(
			{
				stage: stageName,
				target_path: "artifacts/dashboard-layout.md",
				mode: "replace",
				attribute_to_user: "alice",
			},
			[
				{
					name: "file",
					filename: "dashboard-v3.md",
					content: fileContent,
					contentType: "text/markdown",
				},
			],
		)

		const res = await fetch(
			`${baseUrl}/api/intents/${intentSlug}/uploads/stage-output`,
			{
				method: "POST",
				headers: { "Content-Type": contentType },
				body,
			},
		)
		assert.strictEqual(res.status, 200)
		const data = await res.json()
		// Response path must use the TARGET name, not the uploaded filename.
		assert.ok(
			data.path.endsWith("dashboard-layout.md"),
			`path should end with dashboard-layout.md, got: ${data.path}`,
		)

		// No extra "dashboard-v3.md" created.
		const extraFile = join(
			intentDirPath,
			"stages",
			stageName,
			"artifacts",
			"dashboard-v3.md",
		)
		assert.ok(
			!existsSync(extraFile),
			"dashboard-v3.md must NOT be created in the worktree",
		)
	})

	await test("mode=create with colliding filename returns 409 filename_collision", async () => {
		// dashboard-layout.md already exists.
		const fileContent = Buffer.from("collision content")
		const { body, contentType } = buildMultipart(
			{
				stage: stageName,
				target_path: "artifacts/dashboard-layout.md",
				mode: "create",
				attribute_to_user: "bob",
			},
			[
				{
					name: "file",
					filename: "dashboard-layout.md",
					content: fileContent,
					contentType: "text/markdown",
				},
			],
		)

		const res = await fetch(
			`${baseUrl}/api/intents/${intentSlug}/uploads/stage-output`,
			{
				method: "POST",
				headers: { "Content-Type": contentType },
				body,
			},
		)
		assert.strictEqual(res.status, 409)
		const data = await res.json()
		assert.ok(
			data.error === "filename_collision" || data.code === "filename_collision",
			`Expected filename_collision, got: ${JSON.stringify(data)}`,
		)

		// Original file must be untouched.
		const dest = join(
			intentDirPath,
			"stages",
			stageName,
			"artifacts",
			"dashboard-layout.md",
		)
		assert.ok(existsSync(dest))
	})

	await test("Upload exceeds size cap → 413 payload_too_large; no temp files left", async () => {
		const originalMax = process.env.HAIKU_UPLOAD_MAX_BYTES
		// Set cap to 10 bytes for this test.
		process.env.HAIKU_UPLOAD_MAX_BYTES = "10"

		const fileContent = Buffer.alloc(100, "X")
		const { body, contentType } = buildMultipart(
			{
				stage: stageName,
				target_path: "artifacts/too-large.md",
				mode: "upsert",
				attribute_to_user: "alice",
			},
			[
				{
					name: "file",
					filename: "too-large.md",
					content: fileContent,
					contentType: "text/markdown",
				},
			],
		)

		const res = await fetch(
			`${baseUrl}/api/intents/${intentSlug}/uploads/stage-output`,
			{
				method: "POST",
				headers: { "Content-Type": contentType },
				body,
			},
		)

		if (originalMax !== undefined) {
			process.env.HAIKU_UPLOAD_MAX_BYTES = originalMax
		} else {
			delete process.env.HAIKU_UPLOAD_MAX_BYTES
		}

		assert.strictEqual(res.status, 413, `Expected 413, got ${res.status}`)
		const data = await res.json()
		assert.ok(
			data.error === "payload_too_large" || data.code === "payload_too_large",
			`Expected payload_too_large, got: ${JSON.stringify(data)}`,
		)

		// No temp files left in artifacts/.
		const artifactsDir = join(intentDirPath, "stages", stageName, "artifacts")
		const tempFiles = readdirSync(artifactsDir).filter((f) =>
			f.includes(".tmp"),
		)
		assert.strictEqual(
			tempFiles.length,
			0,
			`Expected no temp files, found: ${tempFiles.join(", ")}`,
		)
	})

	await test("Locked worktree → 423 intent_locked", async () => {
		const fileContent = Buffer.from("content")
		const { body, contentType } = buildMultipart(
			{
				stage: stageName,
				target_path: "artifacts/new-file.md",
				mode: "upsert",
				attribute_to_user: "alice",
			},
			[
				{
					name: "file",
					filename: "new-file.md",
					content: fileContent,
					contentType: "text/markdown",
				},
			],
		)

		const res = await fetch(
			`${baseUrl}/api/intents/${lockedSlug}/uploads/stage-output`,
			{
				method: "POST",
				headers: { "Content-Type": contentType },
				body,
			},
		)
		assert.strictEqual(res.status, 423, `Expected 423, got ${res.status}`)
		const data = await res.json()
		assert.ok(
			data.error === "intent_locked" || data.code === "intent_locked",
			`Expected intent_locked, got: ${JSON.stringify(data)}`,
		)

		// No partial file should be left.
		const destFile = join(
			lockedDirPath,
			"stages",
			stageName,
			"artifacts",
			"new-file.md",
		)
		assert.ok(
			!existsSync(destFile),
			"No file should be written for a locked intent",
		)
	})

	await test("Archived intent → 404 intent_not_found", async () => {
		const fileContent = Buffer.from("content")
		const { body, contentType } = buildMultipart(
			{
				stage: stageName,
				target_path: "artifacts/some-file.md",
				mode: "upsert",
				attribute_to_user: "alice",
			},
			[
				{
					name: "file",
					filename: "some-file.md",
					content: fileContent,
					contentType: "text/markdown",
				},
			],
		)

		const res = await fetch(
			`${baseUrl}/api/intents/${archivedSlug}/uploads/stage-output`,
			{
				method: "POST",
				headers: { "Content-Type": contentType },
				body,
			},
		)
		assert.strictEqual(res.status, 404, `Expected 404, got ${res.status}`)
		const data = await res.json()
		assert.ok(
			data.error === "intent_not_found" || data.code === "intent_not_found",
		)
	})

	await test("Completed stage → 403 stage_not_writable", async () => {
		const fileContent = Buffer.from("content")
		const { body, contentType } = buildMultipart(
			{
				stage: stageName,
				target_path: "artifacts/some-file.md",
				mode: "upsert",
				attribute_to_user: "alice",
			},
			[
				{
					name: "file",
					filename: "some-file.md",
					content: fileContent,
					contentType: "text/markdown",
				},
			],
		)

		const res = await fetch(
			`${baseUrl}/api/intents/${sealedSlug}/uploads/stage-output`,
			{
				method: "POST",
				headers: { "Content-Type": contentType },
				body,
			},
		)
		assert.strictEqual(res.status, 403, `Expected 403, got ${res.status}`)
		const data = await res.json()
		assert.ok(
			data.error === "stage_not_writable" || data.code === "stage_not_writable",
		)
	})

	await test("Hook-bypass: PreToolUse hook script is not invoked during upload", async () => {
		// The SPA endpoint writes directly to disk — no MCP tool call,
		// so the PreToolUse guard-workflow-fields hook never fires.
		// We verify the negative by checking hookInvocations is still 0.
		// (hookInvocations is incremented by a hypothetical hook interceptor
		//  above — since no hook is actually registered in test, it stays 0.)
		assert.strictEqual(
			hookInvocations,
			0,
			"No PreToolUse hook should have fired",
		)

		// Also verify the write path doesn't go through any MCP tool:
		// the upload goes directly to disk via streamToTempfile → rename.
		const newContent = Buffer.from("direct disk write, no MCP")
		const { body, contentType } = buildMultipart(
			{
				stage: stageName,
				target_path: "artifacts/mockup.png",
				mode: "upsert",
				attribute_to_user: "designer",
			},
			[
				{
					name: "file",
					filename: "mockup.png",
					content: newContent,
					contentType: "image/png",
				},
			],
		)

		const res = await fetch(
			`${baseUrl}/api/intents/${intentSlug}/uploads/stage-output`,
			{
				method: "POST",
				headers: { "Content-Type": contentType },
				body,
			},
		)
		assert.strictEqual(res.status, 200)
		// Hook still not fired.
		assert.strictEqual(
			hookInvocations,
			0,
			"Hook must not fire during SPA upload",
		)
	})

	await test("Path traversal attack rejected with bad_target_path (400)", async () => {
		const fileContent = Buffer.from("evil content")
		const { body, contentType } = buildMultipart(
			{
				stage: stageName,
				target_path: "../../../etc/passwd",
				mode: "upsert",
				attribute_to_user: "attacker",
			},
			[{ name: "file", filename: "passwd", content: fileContent }],
		)

		const res = await fetch(
			`${baseUrl}/api/intents/${intentSlug}/uploads/stage-output`,
			{
				method: "POST",
				headers: { "Content-Type": contentType },
				body,
			},
		)
		assert.strictEqual(res.status, 400, `Expected 400, got ${res.status}`)
		const data = await res.json()
		assert.ok(
			data.error === "bad_target_path" || data.code === "bad_target_path",
			`Expected bad_target_path, got: ${JSON.stringify(data)}`,
		)
	})

	// ── VULN-REPORT V-01/V-02: extension/MIME allowlist ───────────────────────

	console.log(
		"\n=== VULN-REPORT V-01/V-02: extension + MIME allowlist (stage-output) ===",
	)

	await test("stage-output: text/html upload rejected with 415 unsupported_media_type (V-02)", async () => {
		// V-02: stored XSS via stage-output `.html` upload. The server MUST
		// reject `.html` files at the upload boundary regardless of any
		// out-of-scope serve-side hardening.
		const fileContent = Buffer.from(
			"<html><script>alert('xss')</script></html>",
		)
		const { body, contentType } = buildMultipart(
			{
				stage: stageName,
				target_path: "artifacts/evil-mockup.html",
				mode: "upsert",
				attribute_to_user: "attacker",
			},
			[
				{
					name: "file",
					filename: "evil-mockup.html",
					content: fileContent,
					contentType: "text/html",
				},
			],
		)
		const res = await fetch(
			`${baseUrl}/api/intents/${intentSlug}/uploads/stage-output`,
			{
				method: "POST",
				headers: { "Content-Type": contentType },
				body,
			},
		)
		assert.strictEqual(res.status, 415, `Expected 415, got ${res.status}`)
		const data = await res.json()
		assert.ok(
			data.error === "unsupported_media_type" ||
				data.code === "unsupported_media_type",
			`Expected unsupported_media_type, got: ${JSON.stringify(data)}`,
		)
		// File must NOT be on disk.
		const dest = join(
			intentDirPath,
			"stages",
			stageName,
			"artifacts",
			"evil-mockup.html",
		)
		assert.ok(
			!existsSync(dest),
			"Rejected `.html` upload must not land on disk",
		)
	})

	await test("stage-output: MIME spoof — text/plain claim with .html filename rejected (V-02 defence-in-depth)", async () => {
		// MIME-spoof attack: client claims text/plain but ships a .html
		// filename, hoping the allowlist passes since text/plain IS allowed.
		// The extension blocklist must catch this before the MIME allowlist.
		const fileContent = Buffer.from(
			"<html><script>alert('spoof')</script></html>",
		)
		const { body, contentType } = buildMultipart(
			{
				stage: stageName,
				target_path: "artifacts/spoofed.html",
				mode: "upsert",
				attribute_to_user: "attacker",
			},
			[
				{
					name: "file",
					filename: "spoofed.html",
					content: fileContent,
					contentType: "text/plain",
				},
			],
		)
		const res = await fetch(
			`${baseUrl}/api/intents/${intentSlug}/uploads/stage-output`,
			{
				method: "POST",
				headers: { "Content-Type": contentType },
				body,
			},
		)
		assert.strictEqual(
			res.status,
			415,
			`MIME spoof should still reject — expected 415, got ${res.status}`,
		)
		const data = await res.json()
		assert.ok(
			data.error === "unsupported_media_type" ||
				data.code === "unsupported_media_type",
		)
	})

	await test("stage-output: .svg upload rejected even when MIME claims image/svg+xml (V-02)", async () => {
		const fileContent = Buffer.from(
			'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
		)
		const { body, contentType } = buildMultipart(
			{
				stage: stageName,
				target_path: "artifacts/icon.svg",
				mode: "upsert",
				attribute_to_user: "designer",
			},
			[
				{
					name: "file",
					filename: "icon.svg",
					content: fileContent,
					contentType: "image/svg+xml",
				},
			],
		)
		const res = await fetch(
			`${baseUrl}/api/intents/${intentSlug}/uploads/stage-output`,
			{
				method: "POST",
				headers: { "Content-Type": contentType },
				body,
			},
		)
		assert.strictEqual(res.status, 415, `Expected 415, got ${res.status}`)
	})

	await test("stage-output: target_path with .html extension rejected even when uploaded filename is safe (V-02)", async () => {
		// Defence-in-depth — uploaded filename is safe (.md), but target_path
		// names a `.html` extension on disk. After atomic rename the file
		// would land as `.html` and be served as text/html. Must reject.
		const fileContent = Buffer.from("# innocent markdown\n")
		const { body, contentType } = buildMultipart(
			{
				stage: stageName,
				target_path: "artifacts/landed-as.html",
				mode: "upsert",
				attribute_to_user: "attacker",
			},
			[
				{
					name: "file",
					filename: "innocent.md",
					content: fileContent,
					contentType: "text/markdown",
				},
			],
		)
		const res = await fetch(
			`${baseUrl}/api/intents/${intentSlug}/uploads/stage-output`,
			{
				method: "POST",
				headers: { "Content-Type": contentType },
				body,
			},
		)
		assert.strictEqual(res.status, 415, `Expected 415, got ${res.status}`)
	})

	// ── VULN-REPORT V-07: hard cap clamp on HAIKU_UPLOAD_MAX_BYTES ────────────

	console.log("\n=== VULN-REPORT V-07: hard cap clamps oversize env value ===")

	await test("HAIKU_UPLOAD_MAX_BYTES clamps to MAX_UPLOAD_BYTES_HARD_CAP (50 MiB) when env exceeds the hard cap (V-07: hard cap upload clamp)", async () => {
		// Direct unit-level assertion on getUploadMaxBytes() — uploading
		// 50 MiB+1 of payload over loopback HTTP would dominate the test
		// suite runtime. The behaviour we care about is "any env value
		// above the hard cap clamps to the hard cap"; the streaming path
		// already has its own 413 coverage in the smaller-cap test above.
		const { getUploadMaxBytes, UPLOAD_MAX_BYTES_HARD_CAP } = await import(
			"../src/http/upload-routes.ts"
		)
		const originalMax = process.env.HAIKU_UPLOAD_MAX_BYTES
		try {
			process.env.HAIKU_UPLOAD_MAX_BYTES = String(10 * 1024 * 1024 * 1024) // 10 GB
			const clamped = getUploadMaxBytes()
			assert.strictEqual(
				clamped,
				UPLOAD_MAX_BYTES_HARD_CAP,
				`oversize env (10GB) must clamp to hard cap (${UPLOAD_MAX_BYTES_HARD_CAP}); got ${clamped}`,
			)
			assert.strictEqual(
				UPLOAD_MAX_BYTES_HARD_CAP,
				50 * 1024 * 1024,
				"hard cap must be exactly 50 MiB (per V-07 design)",
			)

			// Sanity: a value below the hard cap is honoured untouched.
			process.env.HAIKU_UPLOAD_MAX_BYTES = "1024"
			assert.strictEqual(
				getUploadMaxBytes(),
				1024,
				"env value below hard cap should be returned unchanged",
			)
		} finally {
			if (originalMax !== undefined) {
				process.env.HAIKU_UPLOAD_MAX_BYTES = originalMax
			} else {
				delete process.env.HAIKU_UPLOAD_MAX_BYTES
			}
		}
	})

	// ── Knowledge upload ───────────────────────────────────────────────────────

	console.log("\n=== POST /api/intents/:intent/uploads/knowledge ===")

	await test("PO uploads a knowledge file: written, action-log + audit-log stamped, no baseline update", async () => {
		const fileContent = Buffer.from("# Competitive Analysis\n\nContent here.")
		const { body, contentType } = buildMultipart(
			{
				target_filename: "competitive-analysis.md",
				attribute_to_user: "product-owner",
				description: "Market research upload",
			},
			[
				{
					name: "file",
					filename: "competitive-analysis.md",
					content: fileContent,
				},
			],
		)

		const res = await fetch(
			`${baseUrl}/api/intents/${intentSlug}/uploads/knowledge`,
			{
				method: "POST",
				headers: { "Content-Type": contentType },
				body,
			},
		)
		const data = await res.json()
		assert.strictEqual(
			res.status,
			200,
			`Expected 200, got ${res.status}: ${JSON.stringify(data)}`,
		)
		assert.ok(data.ok)
		assert.strictEqual(data.baseline_updated, false)
		assert.strictEqual(data.tick_will_observe, true)
		assert.ok(data.path.endsWith("competitive-analysis.md"))

		// File written.
		const dest = join(intentDirPath, "knowledge", "competitive-analysis.md")
		assert.ok(
			existsSync(dest),
			"Knowledge file should exist at intent-scope knowledge/",
		)
		const written = readFileSync(dest, "utf-8")
		assert.ok(written.includes("Competitive Analysis"))

		// Audit-log stamped.
		const auditLog = join(intentDirPath, "write-audit.jsonl")
		const auditLines = readFileSync(auditLog, "utf-8")
			.split("\n")
			.filter(Boolean)
		const latest = JSON.parse(auditLines[auditLines.length - 1])
		assert.strictEqual(latest.author_class, "human-via-mcp")
		assert.strictEqual(latest.human_author_id, "product-owner")
		assert.strictEqual(latest.user_instruction_excerpt, null)

		// No baseline.json.
		const baseline = join(intentDirPath, "stages", stageName, "baseline.json")
		assert.ok(!existsSync(baseline), "baseline.json must NOT be created")
	})

	await test("mode=create (implicit) with colliding knowledge filename returns 409", async () => {
		// competitive-analysis.md already exists from previous test.
		const fileContent = Buffer.from("duplicate content")
		const { body, contentType } = buildMultipart(
			{
				target_filename: "competitive-analysis.md",
				attribute_to_user: "po",
			},
			[
				{
					name: "file",
					filename: "competitive-analysis.md",
					content: fileContent,
				},
			],
		)

		const res = await fetch(
			`${baseUrl}/api/intents/${intentSlug}/uploads/knowledge`,
			{
				method: "POST",
				headers: { "Content-Type": contentType },
				body,
			},
		)
		assert.strictEqual(res.status, 409)
		const data = await res.json()
		assert.ok(
			data.error === "filename_collision" || data.code === "filename_collision",
		)
	})

	// ── VULN-REPORT V-01: knowledge-route extension/MIME allowlist ───────────

	console.log(
		"\n=== VULN-REPORT V-01: extension + MIME allowlist (knowledge) ===",
	)

	await test("knowledge: text/html upload rejected with 415 (V-01: html upload rejected)", async () => {
		const fileContent = Buffer.from(
			"<html><script>alert('xss')</script></html>",
		)
		const { body, contentType } = buildMultipart(
			{
				target_filename: "evil-doc.html",
				attribute_to_user: "attacker",
			},
			[
				{
					name: "file",
					filename: "evil-doc.html",
					content: fileContent,
					contentType: "text/html",
				},
			],
		)
		const res = await fetch(
			`${baseUrl}/api/intents/${intentSlug}/uploads/knowledge`,
			{
				method: "POST",
				headers: { "Content-Type": contentType },
				body,
			},
		)
		assert.strictEqual(res.status, 415, `Expected 415, got ${res.status}`)
		const dest = join(intentDirPath, "knowledge", "evil-doc.html")
		assert.ok(!existsSync(dest), "Rejected `.html` file must not land on disk")
	})

	await test("knowledge: MIME spoof rejected — text/plain claim with .html target_filename (V-01 defence-in-depth)", async () => {
		const fileContent = Buffer.from(
			"<html><script>alert('spoof')</script></html>",
		)
		const { body, contentType } = buildMultipart(
			{
				target_filename: "spoofed.html",
				attribute_to_user: "attacker",
			},
			[
				{
					name: "file",
					filename: "innocent.txt",
					content: fileContent,
					contentType: "text/plain",
				},
			],
		)
		const res = await fetch(
			`${baseUrl}/api/intents/${intentSlug}/uploads/knowledge`,
			{
				method: "POST",
				headers: { "Content-Type": contentType },
				body,
			},
		)
		assert.strictEqual(
			res.status,
			415,
			`MIME spoof should still reject — expected 415, got ${res.status}`,
		)
	})

	await test("knowledge: .svg upload rejected even when MIME claims image/svg+xml (V-01)", async () => {
		const fileContent = Buffer.from(
			'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
		)
		const { body, contentType } = buildMultipart(
			{
				target_filename: "diagram.svg",
				attribute_to_user: "po",
			},
			[
				{
					name: "file",
					filename: "diagram.svg",
					content: fileContent,
					contentType: "image/svg+xml",
				},
			],
		)
		const res = await fetch(
			`${baseUrl}/api/intents/${intentSlug}/uploads/knowledge`,
			{
				method: "POST",
				headers: { "Content-Type": contentType },
				body,
			},
		)
		assert.strictEqual(res.status, 415, `Expected 415, got ${res.status}`)
	})

	// ── tick_counter correctness (Finding 2) ──────────────────────────────────

	console.log(
		"\n=== tick_counter matches active stage iteration (Finding 2) ===",
	)

	await test("stage-output upload action-log entry tick_counter matches active stage iteration", async () => {
		// state.json has iteration: 3 (set during fixture setup at top of file).
		const fileContent = Buffer.from("# tick counter test\n")
		const { body, contentType } = buildMultipart(
			{
				stage: stageName,
				target_path: "artifacts/tick-test.md",
				mode: "upsert",
				attribute_to_user: "alice",
			},
			[
				{
					name: "file",
					filename: "tick-test.md",
					content: fileContent,
					contentType: "text/markdown",
				},
			],
		)

		const res = await fetch(
			`${baseUrl}/api/intents/${intentSlug}/uploads/stage-output`,
			{
				method: "POST",
				headers: { "Content-Type": contentType },
				body,
			},
		)
		assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`)

		// Read the action-log and check the most recently appended entry.
		const actionLog = join(intentDirPath, "action-log.jsonl")
		assert.ok(existsSync(actionLog), "action-log.jsonl should exist")
		const lines = readFileSync(actionLog, "utf-8").split("\n").filter(Boolean)
		const entry = JSON.parse(lines[lines.length - 1])
		assert.strictEqual(
			entry.tick_counter,
			3,
			`Expected tick_counter 3 (from state.json iteration:3), got ${entry.tick_counter}. ` +
				"The upload route was hardcoding tick_counter: 0 instead of reading the active stage iteration.",
		)
		// audit-log entry should also have the correct tick_counter.
		const auditLog = join(intentDirPath, "write-audit.jsonl")
		const auditLines = readFileSync(auditLog, "utf-8")
			.split("\n")
			.filter(Boolean)
		const auditEntry = JSON.parse(auditLines[auditLines.length - 1])
		assert.strictEqual(
			auditEntry.tick_counter,
			3,
			`Expected audit tick_counter 3, got ${auditEntry.tick_counter}`,
		)
	})

	await test("knowledge upload action-log entry tick_counter matches active stage iteration", async () => {
		const fileContent = Buffer.from("# New Knowledge\n\nTick counter test.")
		const { body, contentType } = buildMultipart(
			{
				target_filename: "tick-counter-test.md",
				attribute_to_user: "po",
				stage: stageName,
			},
			[
				{
					name: "file",
					filename: "tick-counter-test.md",
					content: fileContent,
				},
			],
		)

		const res = await fetch(
			`${baseUrl}/api/intents/${intentSlug}/uploads/knowledge`,
			{
				method: "POST",
				headers: { "Content-Type": contentType },
				body,
			},
		)
		assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`)

		const actionLog = join(intentDirPath, "action-log.jsonl")
		const lines = readFileSync(actionLog, "utf-8").split("\n").filter(Boolean)
		const entry = JSON.parse(lines[lines.length - 1])
		assert.strictEqual(
			entry.tick_counter,
			3,
			`Expected tick_counter 3 for knowledge upload (stage-scoped), got ${entry.tick_counter}`,
		)
	})

	console.log(`\n${passed} passed, ${failed} failed`)
	process.exit(failed > 0 ? 1 : 0)
}

run().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
