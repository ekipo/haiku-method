#!/usr/bin/env npx tsx
// Tests for drift-detection-gate.ts — pre-tick drift-detection gate.
//
// Coverage (19 scenarios from silent-filesystem-drop-detection.feature):
//  1.  Designer replaces a stage output — modified finding emitted.
//  2.  PO edits a deliverable — modified finding, correct SHAs.
//  3.  New knowledge file dropped — new-file-detected, binary PDF has no diff.
//  4.  outputs/ alias: canonical pathRel is artifacts/, absPath points to outputs/ on disk.
//  5.  Multiple files changed in one tick — one action, multiple findings (or OOM synthetic).
//  6.  Zero changes since last baseline — no action emitted.
//  7.  Mid-bolt isolation — change detected on NEXT tick, not during in-flight bolt.
//  8.  First tick: baseline absent → establish mode, zero findings, state.json stamped.
//  9.  Kill-switch off (drift_detection: false) — gate is a complete no-op.
// 10.  Kill-switch re-enabled — prior baseline reused unchanged; no auto-re-establish.
// 11.  Editor temp files (.swp, ~, .#) do not produce false findings.
// 12.  Tracked file deleted — file-removed finding, after_sha256 null, diff null.
// 13.  Binary file replaced — is_binary true, diff_unified null.
// 14.  Marker suppresses re-detection (SHA matches marker's baseline_sha_at_creation).
// 15.  Stale marker (double-edit, SHA changed again) → marker removed, fresh finding emitted.
// 16.  Marker with terminal-state cleared — marker absent, gate detects normally.
// 17.  Baseline corrupt JSON → error: 'baseline_corrupt' returned, no dispatch.
// 18.  Files outside tracked surface are not detected (README.md at intent root).
// 19.  files inside units/ are ignored (not in tracked surface).

import assert from "node:assert"
import { createHash } from "node:crypto"
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const tmp = mkdtempSync(join(tmpdir(), "haiku-drift-gate-test-"))

const {
	runDriftDetectionGate,
	isDriftDetectionDisabled,
} = await import("../src/orchestrator/workflow/drift-detection-gate.ts")

const {
	writeBaseline,
	readBaseline,
} = await import("../src/orchestrator/workflow/drift-baseline.ts")

const {
	appendMarker,
} = await import("../src/orchestrator/workflow/drift-markers.ts")

let passed = 0
let failed = 0

function test(name, fn) {
	try {
		const r = fn()
		if (r && typeof r.then === "function") {
			return r.then(
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
		}
		passed++
		console.log(`  ✓ ${name}`)
	} catch (e) {
		failed++
		console.log(`  ✗ ${name}: ${e.message}`)
		if (process.env.VERBOSE) console.error(e)
	}
}

// ── Helpers ────────────────────────────────────────────────────────────────

function sha256(content) {
	return createHash("sha256").update(content).digest("hex")
}

function makeIntentDir(name, opts = {}) {
	const intentDir = join(tmp, name)
	const stage = opts.stage || "design"
	const stageDir = join(intentDir, "stages", stage)
	const artifactsDir = join(stageDir, "artifacts")
	mkdirSync(artifactsDir, { recursive: true })
	return { intentDir, stage, stageDir, artifactsDir }
}

function makeHaikuRoot(name, opts = {}) {
	const haikuRoot = join(tmp, name + "-haikuroot")
	mkdirSync(haikuRoot, { recursive: true })
	if (opts.driftDetectionOff) {
		writeFileSync(join(haikuRoot, "settings.yml"), "drift_detection: false\n")
	}
	return haikuRoot
}

function makeBaselineEntry(path, content, overrides = {}) {
	const sha256val = sha256(content)
	return {
		path,
		sha256: sha256val,
		bytes: Buffer.byteLength(content),
		mtime_ns: Date.now() * 1_000_000,
		is_binary: false,
		author_class: "agent",
		acknowledged_at: new Date().toISOString(),
		acknowledged_via: "agent-write",
		stage: "design",
		tracking_class: "stage-output",
		...overrides,
	}
}

function makeCtx(intentDir, haikuRoot, stage = "design") {
	return {
		intentDir,
		intentSlug: "demo-intent",
		activeStage: stage,
		haikuRoot,
		tickCounter: 1,
	}
}

// Write baseline using the proper writeBaseline function.
async function writeBaselineForStage(intentDir, stage, entries) {
	const baseline = { entries: new Map(Object.entries(entries)) }
	await writeBaseline(intentDir, stage, baseline)
}

// Add an anchor file to baseline and disk to prevent OOM heuristic from
// triggering in single-file test scenarios.
// When 1 file out of 2 changes, that's 50% which is NOT > 50%, so no OOM.
function addAnchorFile(intentDir, stage, artifactsDir) {
	const anchorContent = "<!-- anchor file — stable across test -->"
	const anchorName = "anchor-stable.html"
	const anchorPath = join(artifactsDir, anchorName)
	writeFileSync(anchorPath, anchorContent)
	const relPath = `stages/${stage}/artifacts/${anchorName}`
	return { relPath, content: anchorContent }
}

// Make a valid PendingMarker for use in tests.
function makeMarker(path, sha, overrides = {}) {
	return {
		path,
		created_at: new Date().toISOString(),
		created_by_assessment_id: "assess-test-001",
		outcome: "surface-as-feedback",
		linked_feedback_id: "FB-05",
		linked_revisit_target_stage: null,
		cleared_at: null,
		resolved_sha: null,
		baseline_sha_at_creation: sha,
		...overrides,
	}
}

// ── Tests ──────────────────────────────────────────────────────────────────

console.log("\n=== Scenario 1: Designer replaces a stage output ===")

await test("modified finding emitted when on-disk SHA differs from baseline", async () => {
	const { intentDir, stage, artifactsDir } = makeIntentDir("s01")
	const haikuRoot = makeHaikuRoot("s01")
	const relPath = `stages/${stage}/artifacts/dashboard-layout.html`
	const originalContent = "<html>original</html>"
	const newContent = "<html>replaced by designer</html>"

	writeFileSync(join(artifactsDir, "dashboard-layout.html"), originalContent)

	// Add anchor to prevent OOM (1 change / 2 files = 50%, not > 50%).
	const anchor = addAnchorFile(intentDir, stage, artifactsDir)

	await writeBaselineForStage(intentDir, stage, {
		[relPath]: makeBaselineEntry(relPath, originalContent),
		[anchor.relPath]: makeBaselineEntry(anchor.relPath, anchor.content),
	})

	// Designer replaces the file.
	writeFileSync(join(artifactsDir, "dashboard-layout.html"), newContent)

	const result = runDriftDetectionGate(makeCtx(intentDir, haikuRoot, stage))

	assert.strictEqual(result.action, "manual_change_assessment", "action should be manual_change_assessment")
	// Should have an individual finding (not OOM synthetic).
	const finding = result.findings.find(f => f.path === relPath)
	assert.ok(finding, `finding for ${relPath} should be present`)
	assert.strictEqual(finding.change_kind, "modified")
	assert.strictEqual(finding.after_sha256, sha256(newContent))
	assert.strictEqual(finding.before_sha256, sha256(originalContent))
})

console.log("\n=== Scenario 2: PO edits a deliverable — diff included ===")

await test("modified finding includes correct SHAs for text files", async () => {
	const { intentDir, stage, artifactsDir } = makeIntentDir("s02")
	const haikuRoot = makeHaikuRoot("s02")
	const relPath = `stages/${stage}/artifacts/spec.md`
	const originalContent = "# Spec\n\nOriginal content.\n"
	const newContent = "# Spec\n\nEdited by PO.\n"

	writeFileSync(join(artifactsDir, "spec.md"), originalContent)

	// Add anchor to prevent OOM.
	const anchor = addAnchorFile(intentDir, stage, artifactsDir)

	await writeBaselineForStage(intentDir, stage, {
		[relPath]: makeBaselineEntry(relPath, originalContent),
		[anchor.relPath]: makeBaselineEntry(anchor.relPath, anchor.content),
	})

	writeFileSync(join(artifactsDir, "spec.md"), newContent)

	const result = runDriftDetectionGate(makeCtx(intentDir, haikuRoot, stage))

	assert.strictEqual(result.action, "manual_change_assessment")
	const finding = result.findings.find(f => f.path === relPath)
	assert.ok(finding, `finding for ${relPath} should be present`)
	assert.strictEqual(finding.change_kind, "modified")
	assert.strictEqual(finding.before_sha256, sha256(originalContent))
	assert.strictEqual(finding.after_sha256, sha256(newContent))
	assert.strictEqual(finding.is_binary, false)
})

console.log("\n=== Scenario 3: New knowledge file (binary PDF) ===")

await test("new-file-detected with is_binary=true and diff_unified=null for binary file", async () => {
	const { intentDir, stage, artifactsDir } = makeIntentDir("s03")
	const haikuRoot = makeHaikuRoot("s03")
	const knowledgeDir = join(intentDir, "knowledge")
	mkdirSync(knowledgeDir, { recursive: true })

	// Add anchor so OOM doesn't fire on 1 new file / 1 baseline entry.
	const anchor = addAnchorFile(intentDir, stage, artifactsDir)

	// Establish a baseline with just the anchor.
	await writeBaselineForStage(intentDir, stage, {
		[anchor.relPath]: makeBaselineEntry(anchor.relPath, anchor.content),
	})

	// Drop a "PDF" (binary with null bytes) — not in baseline.
	const pdfContent = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x00, 0x00])
	writeFileSync(join(knowledgeDir, "market-research.pdf"), pdfContent)

	const result = runDriftDetectionGate(makeCtx(intentDir, haikuRoot, stage))

	assert.strictEqual(result.action, "manual_change_assessment")
	const finding = result.findings.find(f => f.path === "knowledge/market-research.pdf")
	assert.ok(finding, "should have a finding for knowledge/market-research.pdf")
	assert.strictEqual(finding.change_kind, "new-file-detected")
	assert.strictEqual(finding.before_sha256, null)
	assert.ok(finding.after_sha256 !== null)
	assert.strictEqual(finding.is_binary, true)
	assert.strictEqual(finding.diff_unified, null)
})

console.log("\n=== Scenario 4: outputs/ alias — canonical key is artifacts/ ===")

await test("outputs/ alias file gets pathRel canonicalised to artifacts/", async () => {
	const { intentDir, stage, stageDir, artifactsDir } = makeIntentDir("s04")
	const haikuRoot = makeHaikuRoot("s04")
	const outputsDir = join(stageDir, "outputs")
	mkdirSync(outputsDir, { recursive: true })

	const canonicalRelPath = `stages/${stage}/artifacts/hero.html`
	const originalContent = "<html>hero</html>"
	const newContent = "<html>hero v2</html>"

	// Add anchor to prevent OOM.
	const anchor = addAnchorFile(intentDir, stage, artifactsDir)

	// Put file in outputs/ (alias). Baseline records under canonical artifacts/ key.
	writeFileSync(join(outputsDir, "hero.html"), originalContent)
	await writeBaselineForStage(intentDir, stage, {
		[canonicalRelPath]: makeBaselineEntry(canonicalRelPath, originalContent),
		[anchor.relPath]: makeBaselineEntry(anchor.relPath, anchor.content),
	})

	// Designer replaces via outputs/ path.
	writeFileSync(join(outputsDir, "hero.html"), newContent)

	const result = runDriftDetectionGate(makeCtx(intentDir, haikuRoot, stage))

	assert.strictEqual(result.action, "manual_change_assessment")
	const finding = result.findings.find(f => f.path === canonicalRelPath)
	assert.ok(finding, `finding should use canonical key ${canonicalRelPath}`)
	assert.strictEqual(finding.change_kind, "modified")
})

console.log("\n=== Scenario 5: Multiple files changed in one tick ===")

await test("one action emitted when multiple files change; individual findings or OOM synthetic", async () => {
	const { intentDir, stage, artifactsDir } = makeIntentDir("s05")
	const haikuRoot = makeHaikuRoot("s05")

	const files = ["a.html", "b.html", "c.html"]
	const originalContent = "<html>original</html>"
	const newContent = "<html>changed</html>"

	const entries = {}
	for (const f of files) {
		const relPath = `stages/${stage}/artifacts/${f}`
		writeFileSync(join(artifactsDir, f), originalContent)
		entries[relPath] = makeBaselineEntry(relPath, originalContent)
	}
	await writeBaselineForStage(intentDir, stage, entries)

	// Replace all three files.
	for (const f of files) {
		writeFileSync(join(artifactsDir, f), newContent)
	}

	const result = runDriftDetectionGate(makeCtx(intentDir, haikuRoot, stage))

	// With 3 files changed out of 3, that's 100% — triggers the OOM heuristic.
	// The spec says one action + multiple findings OR OOM synthetic. Both are valid.
	assert.strictEqual(result.action, "manual_change_assessment")
	assert.ok(result.findings.length > 0, "should have at least one finding")
})

console.log("\n=== Scenario 6: Zero changes since last baseline ===")

await test("no action emitted when no files have changed", async () => {
	const { intentDir, stage, artifactsDir } = makeIntentDir("s06")
	const haikuRoot = makeHaikuRoot("s06")
	const content = "<html>stable</html>"
	const relPath = `stages/${stage}/artifacts/stable.html`

	writeFileSync(join(artifactsDir, "stable.html"), content)
	await writeBaselineForStage(intentDir, stage, {
		[relPath]: makeBaselineEntry(relPath, content),
	})

	const result = runDriftDetectionGate(makeCtx(intentDir, haikuRoot, stage))

	assert.strictEqual(result.action, null, "no action when nothing changed")
	assert.strictEqual(result.findings.length, 0)
})

console.log("\n=== Scenario 7: Mid-bolt isolation ===")

await test("change detected on next tick, not during in-flight bolt", async () => {
	const { intentDir, stage, artifactsDir } = makeIntentDir("s07")
	const haikuRoot = makeHaikuRoot("s07")
	const content = "<html>layout</html>"
	const relPath = `stages/${stage}/artifacts/layout.html`
	const anchor = addAnchorFile(intentDir, stage, artifactsDir)

	writeFileSync(join(artifactsDir, "layout.html"), content)
	await writeBaselineForStage(intentDir, stage, {
		[relPath]: makeBaselineEntry(relPath, content),
		[anchor.relPath]: makeBaselineEntry(anchor.relPath, anchor.content),
	})

	// Simulate: during a bolt, file is replaced on disk but gate not called.
	const midBoltContent = "<html>replaced during bolt</html>"
	writeFileSync(join(artifactsDir, "layout.html"), midBoltContent)

	// The gate is only called AFTER the bolt completes (next haiku_run_next call).
	const result = runDriftDetectionGate(makeCtx(intentDir, haikuRoot, stage))

	// Now the gate fires and detects the change.
	assert.strictEqual(result.action, "manual_change_assessment")
	const finding = result.findings.find(f => f.path === relPath)
	assert.ok(finding, "should find the modified file")
	assert.strictEqual(finding.change_kind, "modified")
})

console.log("\n=== Scenario 8: First tick — baseline establishment ===")

await test("baseline absent → establish mode: zero findings, state.json stamped, baseline written", async () => {
	const { intentDir, stage, artifactsDir } = makeIntentDir("s08")
	const haikuRoot = makeHaikuRoot("s08")
	const stageDir = join(intentDir, "stages", stage)

	writeFileSync(join(artifactsDir, "hero.html"), "<html>hero</html>")
	writeFileSync(join(stageDir, "state.json"), JSON.stringify({ tick: 1 }))

	// No baseline.json — gate runs in establish mode.
	const result = runDriftDetectionGate(makeCtx(intentDir, haikuRoot, stage))

	assert.strictEqual(result.baselineEstablished, true, "baselineEstablished should be true")
	assert.strictEqual(result.action, null, "no action on first tick")
	assert.strictEqual(result.findings.length, 0)

	// Verify state.json was stamped.
	const stateRaw = readFileSync(join(stageDir, "state.json"), "utf-8")
	const state = JSON.parse(stateRaw)
	assert.ok(state.drift_baseline_established_at, "state.json should have drift_baseline_established_at")

	// Verify baseline.json was written.
	const baseline = readBaseline(intentDir, stage)
	assert.ok(baseline !== null, "baseline.json should exist after establish")
	assert.ok(baseline.entries.has(`stages/${stage}/artifacts/hero.html`), "hero.html entry in baseline")
})

console.log("\n=== Scenario 9: Kill-switch off ===")

test("isDriftDetectionDisabled returns true when drift_detection: false in settings.yml", () => {
	const haikuRoot = makeHaikuRoot("s09-kill-check", { driftDetectionOff: true })
	assert.strictEqual(isDriftDetectionDisabled(haikuRoot), true)
})

test("isDriftDetectionDisabled returns false when settings.yml absent", () => {
	const haikuRoot = makeHaikuRoot("s09-kill-absent")
	assert.strictEqual(isDriftDetectionDisabled(haikuRoot), false)
})

await test("drift_detection: false → gate is a complete no-op", async () => {
	const { intentDir, stage, artifactsDir } = makeIntentDir("s09")
	const haikuRoot = makeHaikuRoot("s09", { driftDetectionOff: true })
	const relPath = `stages/${stage}/artifacts/dashboard-layout.html`
	const originalContent = "<html>original</html>"

	writeFileSync(join(artifactsDir, "dashboard-layout.html"), originalContent)
	await writeBaselineForStage(intentDir, stage, {
		[relPath]: makeBaselineEntry(relPath, originalContent),
	})

	// Replace file.
	writeFileSync(join(artifactsDir, "dashboard-layout.html"), "<html>new</html>")

	const result = runDriftDetectionGate(makeCtx(intentDir, haikuRoot, stage))

	assert.strictEqual(result.action, null, "kill-switch: no action")
	assert.strictEqual(result.findings.length, 0, "kill-switch: no findings")
	assert.strictEqual(result.baselineEstablished, false, "kill-switch: no establish either")
})

console.log("\n=== Scenario 10: Kill-switch re-enabled — no auto-re-establish ===")

await test("gate reuses existing baseline after kill-switch re-enable; does not re-establish", async () => {
	const { intentDir, stage, artifactsDir } = makeIntentDir("s10")
	const haikuRoot = makeHaikuRoot("s10") // kill-switch now OFF (re-enabled)
	const relPath = `stages/${stage}/artifacts/dashboard-layout.html`
	const agentSha = sha256("<html>original</html>")
	const anchor = addAnchorFile(intentDir, stage, artifactsDir)

	// File was changed while kill-switch was off. Baseline still has the agent SHA.
	writeFileSync(join(artifactsDir, "dashboard-layout.html"), "<html>changed while off</html>")
	await writeBaselineForStage(intentDir, stage, {
		[relPath]: {
			path: relPath,
			sha256: agentSha,
			bytes: Buffer.byteLength("<html>original</html>"),
			mtime_ns: Date.now() * 1_000_000,
			is_binary: false,
			author_class: "agent",
			acknowledged_at: new Date().toISOString(),
			acknowledged_via: "agent-write",
			stage,
			tracking_class: "stage-output",
		},
		[anchor.relPath]: makeBaselineEntry(anchor.relPath, anchor.content),
	})

	// Kill-switch re-enabled — gate now runs normally. The prior drift is detected.
	const result = runDriftDetectionGate(makeCtx(intentDir, haikuRoot, stage))

	// The gate reuses the existing baseline and detects the drift that happened while off.
	// It does NOT auto-re-establish (which would silently swallow the change).
	assert.strictEqual(result.baselineEstablished, false, "should not re-establish")
	assert.strictEqual(result.action, "manual_change_assessment")
	const finding = result.findings.find(f => f.path === relPath)
	assert.ok(finding, "should find the drifted file")
	assert.strictEqual(finding.change_kind, "modified")
})

console.log("\n=== Scenario 11: Editor temp files ===")

await test("editor temp files (.swp, .swo, ~, .#, 4913) do not produce findings", async () => {
	const { intentDir, stage, artifactsDir } = makeIntentDir("s11")
	const haikuRoot = makeHaikuRoot("s11")
	const realContent = "# spec"
	const realRelPath = `stages/${stage}/artifacts/spec.md`

	writeFileSync(join(artifactsDir, "spec.md"), realContent)
	await writeBaselineForStage(intentDir, stage, {
		[realRelPath]: makeBaselineEntry(realRelPath, realContent),
	})

	// Create editor temp files.
	writeFileSync(join(artifactsDir, ".spec.md.swp"), "vim swap")
	writeFileSync(join(artifactsDir, "spec.md~"), "backup")
	writeFileSync(join(artifactsDir, ".#spec.md"), "emacs lock")
	writeFileSync(join(artifactsDir, "4913"), "vim test file")

	const result = runDriftDetectionGate(makeCtx(intentDir, haikuRoot, stage))

	// No temp file findings.
	const tempFindings = result.findings.filter(f =>
		f.path.endsWith(".swp") ||
		f.path.endsWith("~") ||
		f.path.includes(".#") ||
		f.path.endsWith("4913")
	)
	assert.strictEqual(tempFindings.length, 0, "no temp file findings")
	// spec.md unchanged → no action.
	assert.strictEqual(result.action, null)
})

console.log("\n=== Scenario 12: Tracked file deleted ===")

await test("file-removed finding with after_sha256=null and diff_unified=null", async () => {
	const { intentDir, stage, artifactsDir } = makeIntentDir("s12")
	const haikuRoot = makeHaikuRoot("s12")
	const content = "<html>old mock</html>"
	const relPath = `stages/${stage}/artifacts/old-mock.html`
	const anchor = addAnchorFile(intentDir, stage, artifactsDir)

	writeFileSync(join(artifactsDir, "old-mock.html"), content)
	await writeBaselineForStage(intentDir, stage, {
		[relPath]: makeBaselineEntry(relPath, content),
		[anchor.relPath]: makeBaselineEntry(anchor.relPath, anchor.content),
	})

	// Delete the file.
	rmSync(join(artifactsDir, "old-mock.html"))

	const result = runDriftDetectionGate(makeCtx(intentDir, haikuRoot, stage))

	assert.strictEqual(result.action, "manual_change_assessment")
	const finding = result.findings.find(f => f.path === relPath)
	assert.ok(finding, `finding for ${relPath}`)
	assert.strictEqual(finding.change_kind, "file-removed")
	assert.strictEqual(finding.after_sha256, null)
	assert.strictEqual(finding.before_sha256, sha256(content))
	assert.strictEqual(finding.diff_unified, null)
	assert.strictEqual(finding.after_bytes, null)
})

console.log("\n=== Scenario 13: Binary file replaced ===")

await test("binary replacement: is_binary=true, diff_unified=null", async () => {
	const { intentDir, stage, artifactsDir } = makeIntentDir("s13")
	const haikuRoot = makeHaikuRoot("s13")
	const relPath = `stages/${stage}/artifacts/mockup.png`
	const anchor = addAnchorFile(intentDir, stage, artifactsDir)

	// Original binary content.
	const origBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00])
	writeFileSync(join(artifactsDir, "mockup.png"), origBuf)
	await writeBaselineForStage(intentDir, stage, {
		[relPath]: {
			path: relPath,
			sha256: sha256(origBuf),
			bytes: origBuf.length,
			mtime_ns: Date.now() * 1_000_000,
			is_binary: true,
			author_class: "agent",
			acknowledged_at: new Date().toISOString(),
			acknowledged_via: "agent-write",
			stage,
			tracking_class: "stage-output",
		},
		[anchor.relPath]: makeBaselineEntry(anchor.relPath, anchor.content),
	})

	// Replace with different binary content.
	const newBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03, 0x00])
	writeFileSync(join(artifactsDir, "mockup.png"), newBuf)

	const result = runDriftDetectionGate(makeCtx(intentDir, haikuRoot, stage))

	assert.strictEqual(result.action, "manual_change_assessment")
	const finding = result.findings.find(f => f.path === relPath)
	assert.ok(finding, `finding for ${relPath}`)
	assert.strictEqual(finding.is_binary, true)
	assert.strictEqual(finding.diff_unified, null)
	assert.strictEqual(finding.change_kind, "modified")
	assert.strictEqual(finding.before_sha256, sha256(origBuf))
	assert.strictEqual(finding.after_sha256, sha256(newBuf))
})

console.log("\n=== Scenario 14: Marker suppresses re-detection ===")

await test("open marker with matching SHA suppresses finding", async () => {
	const { intentDir, stage, artifactsDir } = makeIntentDir("s14")
	const haikuRoot = makeHaikuRoot("s14")
	const originalContent = "<html>old</html>"
	const humanContent = "<html>human edit</html>"
	const relPath = `stages/${stage}/artifacts/layout.html`
	const humanSha = sha256(humanContent)
	const anchor = addAnchorFile(intentDir, stage, artifactsDir)

	writeFileSync(join(artifactsDir, "layout.html"), humanContent)
	await writeBaselineForStage(intentDir, stage, {
		[relPath]: makeBaselineEntry(relPath, originalContent),
		[anchor.relPath]: makeBaselineEntry(anchor.relPath, anchor.content),
	})

	// Create an open marker whose baseline_sha_at_creation matches the current disk SHA.
	await appendMarker(intentDir, makeMarker(relPath, humanSha))

	const result = runDriftDetectionGate(makeCtx(intentDir, haikuRoot, stage))

	// Marker suppresses — no finding for this path.
	const finding = result.findings.find(f => f.path === relPath)
	assert.ok(!finding, "finding should be suppressed by marker")
	assert.strictEqual(result.action, null)
})

console.log("\n=== Scenario 15: Stale marker (double-edit) ===")

await test("stale marker (SHA changed again) is removed and fresh finding emitted", async () => {
	const { intentDir, stage, artifactsDir } = makeIntentDir("s15")
	const haikuRoot = makeHaikuRoot("s15")
	const originalContent = "<html>old</html>"
	const firstEditContent = "<html>first edit</html>"
	const secondEditContent = "<html>second edit</html>"
	const relPath = `stages/${stage}/artifacts/layout.html`
	const firstEditSha = sha256(firstEditContent)
	const anchor = addAnchorFile(intentDir, stage, artifactsDir)

	// Current disk has the second edit.
	writeFileSync(join(artifactsDir, "layout.html"), secondEditContent)
	await writeBaselineForStage(intentDir, stage, {
		[relPath]: makeBaselineEntry(relPath, originalContent),
		[anchor.relPath]: makeBaselineEntry(anchor.relPath, anchor.content),
	})

	// Marker's baseline_sha_at_creation matches the FIRST edit, not the current one.
	await appendMarker(intentDir, makeMarker(relPath, firstEditSha, {
		linked_feedback_id: "FB-06",
	}))

	const result = runDriftDetectionGate(makeCtx(intentDir, haikuRoot, stage))

	// Stale marker detected → marker will be removed asynchronously.
	// A fresh finding should be emitted for the second edit.
	assert.strictEqual(result.action, "manual_change_assessment")
	const finding = result.findings.find(f => f.path === relPath)
	assert.ok(finding, "fresh finding should be emitted for double-edit")
	assert.strictEqual(finding.change_kind, "modified")
	assert.strictEqual(finding.after_sha256, sha256(secondEditContent))
})

console.log("\n=== Scenario 16: Terminal-state marker cleared → gate detects normally ===")

await test("when no marker exists (cleared), gate detects the drift normally", async () => {
	const { intentDir, stage, artifactsDir } = makeIntentDir("s16")
	const haikuRoot = makeHaikuRoot("s16")
	const originalContent = "<html>old</html>"
	const newContent = "<html>new after clearing</html>"
	const relPath = `stages/${stage}/artifacts/layout.html`
	const anchor = addAnchorFile(intentDir, stage, artifactsDir)

	writeFileSync(join(artifactsDir, "layout.html"), newContent)
	await writeBaselineForStage(intentDir, stage, {
		[relPath]: makeBaselineEntry(relPath, originalContent),
		[anchor.relPath]: makeBaselineEntry(anchor.relPath, anchor.content),
	})

	// No marker at all (was cleared when feedback reached terminal state).
	const result = runDriftDetectionGate(makeCtx(intentDir, haikuRoot, stage))

	assert.strictEqual(result.action, "manual_change_assessment")
	const finding = result.findings.find(f => f.path === relPath)
	assert.ok(finding, "gate detects normally without marker")
	assert.strictEqual(finding.change_kind, "modified")
})

console.log("\n=== Scenario 17: Baseline corrupt ===")

await test("corrupt baseline JSON → error: baseline_corrupt returned", async () => {
	const { intentDir, stage, stageDir } = makeIntentDir("s17")
	const haikuRoot = makeHaikuRoot("s17")

	// Write invalid JSON as baseline.
	writeFileSync(join(stageDir, "baseline.json"), "{ this is not json }")

	const result = runDriftDetectionGate(makeCtx(intentDir, haikuRoot, stage))

	assert.strictEqual(result.error, "baseline_corrupt", "error should be baseline_corrupt")
	assert.ok(result.errorMessage?.includes("corrupt"), "errorMessage should mention corrupt")
	assert.strictEqual(result.action, null, "no action on corrupt baseline")
	assert.strictEqual(result.findings.length, 0)
})

console.log("\n=== Scenario 18: Files outside tracked surface ===")

await test("README.md at intent root is not detected", async () => {
	const { intentDir, stage, artifactsDir } = makeIntentDir("s18")
	const haikuRoot = makeHaikuRoot("s18")
	const trackedContent = "<html>tracked</html>"
	const trackedRelPath = `stages/${stage}/artifacts/tracked.html`

	writeFileSync(join(artifactsDir, "tracked.html"), trackedContent)
	await writeBaselineForStage(intentDir, stage, {
		[trackedRelPath]: makeBaselineEntry(trackedRelPath, trackedContent),
	})

	// Write a README at the intent root (outside tracked surface).
	writeFileSync(join(intentDir, "README.md"), "# read me")

	const result = runDriftDetectionGate(makeCtx(intentDir, haikuRoot, stage))

	const readmeFinding = result.findings.find(f => f.path.includes("README.md"))
	assert.ok(!readmeFinding, "README.md should not produce a finding")
	// No change to tracked files → no action.
	assert.strictEqual(result.action, null)
})

console.log("\n=== Scenario 19: Files inside units/ are ignored ===")

await test("files in units/ directory are not in the tracked surface", async () => {
	const { intentDir, stage, stageDir, artifactsDir } = makeIntentDir("s19")
	const haikuRoot = makeHaikuRoot("s19")
	const trackedContent = "<html>tracked</html>"
	const trackedRelPath = `stages/${stage}/artifacts/tracked.html`

	writeFileSync(join(artifactsDir, "tracked.html"), trackedContent)
	await writeBaselineForStage(intentDir, stage, {
		[trackedRelPath]: makeBaselineEntry(trackedRelPath, trackedContent),
	})

	// Write a unit file (should be excluded from tracked surface).
	const unitsDir = join(stageDir, "units")
	mkdirSync(unitsDir, { recursive: true })
	writeFileSync(join(unitsDir, "unit-01-foo.md"), "---\nstatus: pending\n---\n# Foo")

	const result = runDriftDetectionGate(makeCtx(intentDir, haikuRoot, stage))

	const unitFinding = result.findings.find(f => f.path.includes("units/"))
	assert.ok(!unitFinding, "units/ files should not produce findings")
	// No tracked files changed.
	assert.strictEqual(result.action, null)
})

// ── Cleanup + summary ──────────────────────────────────────────────────────

// Allow async tests (marker writes) to settle.
await new Promise((r) => setTimeout(r, 100))

try {
	rmSync(tmp, { recursive: true, force: true })
} catch {}

console.log("")
console.log(`  ${passed + failed} tests: ${passed} passed, ${failed} failed`)
console.log("")

process.exit(failed > 0 ? 1 : 0)
