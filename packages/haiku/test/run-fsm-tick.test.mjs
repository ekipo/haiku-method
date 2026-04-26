#!/usr/bin/env npx tsx
// End-to-end test for the xstate FSM integration. Verifies the full
// loop: disk fixture → deriveCurrentState → optionally run the
// machine → return a tick result.
//
// Tests both paths:
//   - xstate-native states (terminal states migrated as PoC) emit
//     a snapshot.
//   - runNext-driven states (everything else for now) return without
//     a snapshot and signal the legacy driver.

import assert from "node:assert"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
process.env.CLAUDE_PLUGIN_ROOT = resolve(__dirname, "..", "..", "..", "plugin")

const { runFsmTick, XSTATE_NATIVE_STATES } = await import(
	"../src/orchestrator/fsm/run-fsm-tick.ts"
)

let passed = 0
let failed = 0

function test(name, fn) {
	try {
		fn()
		passed++
		console.log(`  ✓ ${name}`)
	} catch (err) {
		failed++
		console.log(`  ✗ ${name}`)
		console.log(`    ${err.message}`)
	}
}

function fixture(slug, frontmatter, stages = {}) {
	const root = mkdtempSync(join(tmpdir(), "haiku-fsm-tick-"))
	const haikuRoot = join(root, ".haiku")
	const iDir = join(haikuRoot, "intents", slug)
	mkdirSync(iDir, { recursive: true })

	const fmLines = ["---"]
	for (const [k, v] of Object.entries(frontmatter)) {
		if (v == null) continue
		if (typeof v === "boolean") fmLines.push(`${k}: ${v}`)
		else if (Array.isArray(v))
			fmLines.push(`${k}: [${v.map((x) => `"${x}"`).join(", ")}]`)
		else fmLines.push(`${k}: "${v}"`)
	}
	fmLines.push("---", "", "# Intent body")
	writeFileSync(join(iDir, "intent.md"), fmLines.join("\n"))

	for (const [stageName, stageState] of Object.entries(stages)) {
		const sd = join(iDir, "stages", stageName)
		mkdirSync(sd, { recursive: true })
		writeFileSync(join(sd, "state.json"), JSON.stringify(stageState, null, 2))
	}

	return {
		haikuRoot,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	}
}

console.log("=== Driver routing ===")

test("missing intent returns null", () => {
	const result = runFsmTick("nonexistent", "/tmp/does-not-exist")
	assert.strictEqual(result, null)
})

test("non-xstate-native state routes to runNext driver", () => {
	const { haikuRoot, cleanup } = fixture("test", {
		studio: "software",
		active_stage: "design",
	})
	const result = runFsmTick("test", haikuRoot)
	cleanup()
	assert.ok(result)
	assert.strictEqual(result.state, "start_stage")
	assert.strictEqual(result.driver, "runNext")
	assert.strictEqual(result.snapshot, null)
})

test("complete state routes to xstate driver", () => {
	const { haikuRoot, cleanup } = fixture("test", {
		studio: "software",
		status: "completed",
	})
	const result = runFsmTick("test", haikuRoot)
	cleanup()
	assert.ok(result)
	assert.strictEqual(result.state, "complete")
	assert.strictEqual(result.driver, "xstate")
	assert.ok(result.snapshot, "xstate path should produce a snapshot")
})

test("archived state (terminal=complete) routes to xstate driver", () => {
	const { haikuRoot, cleanup } = fixture("test", {
		studio: "software",
		archived: true,
	})
	const result = runFsmTick("test", haikuRoot)
	cleanup()
	assert.ok(result)
	assert.strictEqual(result.state, "complete")
	assert.strictEqual(result.driver, "xstate")
})

test("complete-without-studio falls back to runNext (xstate is studio-keyed)", () => {
	const { haikuRoot, cleanup } = fixture("test", {
		status: "completed",
	})
	const result = runFsmTick("test", haikuRoot)
	cleanup()
	assert.ok(result)
	assert.strictEqual(result.state, "complete")
	// No studio means no machine to instantiate — driver is runNext.
	assert.strictEqual(result.driver, "runNext")
})

console.log("\n=== xstate-native registry ===")

test("registry contains the migrated terminal states", () => {
	for (const name of ["complete", "error", "escalate", "blocked"]) {
		assert.ok(
			XSTATE_NATIVE_STATES.has(name),
			`registry should include '${name}'`,
		)
	}
})

test("registry does NOT contain unmigrated states", () => {
	for (const name of ["elaborate", "execute", "review", "gate_review"]) {
		assert.ok(
			!XSTATE_NATIVE_STATES.has(name),
			`registry should NOT include unmigrated '${name}' yet`,
		)
	}
})

console.log("\n=== Snapshot shape ===")

test("xstate snapshot reports the initial machine state", () => {
	const { haikuRoot, cleanup } = fixture("test", {
		studio: "software",
		status: "completed",
	})
	const result = runFsmTick("test", haikuRoot)
	cleanup()
	const snapshot = result.snapshot
	// Initial state of every studio machine is select_studio. Once
	// per-state migration ports the FSM to drive from derived state,
	// this assertion will change to expect snapshot.value === derived.
	assert.strictEqual(snapshot.value, "select_studio")
})

test("runNext-driven results carry context but no snapshot", () => {
	const { haikuRoot, cleanup } = fixture("test", {
		studio: "software",
		active_stage: "development",
	}, {
		development: { status: "active", phase: "execute" },
	})
	const result = runFsmTick("test", haikuRoot)
	cleanup()
	assert.strictEqual(result.driver, "runNext")
	assert.strictEqual(result.snapshot, null)
	assert.strictEqual(result.context.currentStage, "development")
	assert.strictEqual(result.context.currentPhase, "execute")
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
