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

const { runFsmTick, XSTATE_NATIVE_STATES, emitNativeAction } = await import(
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
	// Use an explicitly mid-execute stage state — `execute` isn't in
	// the native-emit registry, so the driver falls back to runNext.
	// (start_stage and other pre-stage states migrated to native-emit
	// in the per-state registry refactor.)
	const { haikuRoot, cleanup } = fixture(
		"test",
		{
			studio: "software",
			active_stage: "development",
		},
		{
			development: { status: "active", phase: "execute" },
		},
	)
	const result = runFsmTick("test", haikuRoot)
	cleanup()
	assert.ok(result)
	assert.strictEqual(result.state, "execute")
	assert.strictEqual(result.driver, "runNext")
})

test("complete state routes to xstate driver + emits action", () => {
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
	assert.ok(result.action, "xstate path should emit an action")
	assert.strictEqual(result.action.action, "complete")
	assert.strictEqual(
		result.action.message,
		`Intent 'test' is already completed`,
	)
})

test("archived (flag) routes to xstate error with unarchive instructions", () => {
	const { haikuRoot, cleanup } = fixture("test", {
		studio: "software",
		archived: true,
	})
	const result = runFsmTick("test", haikuRoot)
	cleanup()
	assert.ok(result)
	assert.strictEqual(result.state, "error")
	assert.strictEqual(result.driver, "xstate")
	assert.strictEqual(result.action.action, "error")
	assert.ok(
		result.action.message.includes("haiku_intent_unarchive"),
		"error message should reference haiku_intent_unarchive",
	)
})

test("status=archived (legacy) routes to xstate error with repair instructions", () => {
	const { haikuRoot, cleanup } = fixture("test", {
		studio: "software",
		status: "archived",
	})
	const result = runFsmTick("test", haikuRoot)
	cleanup()
	assert.ok(result)
	assert.strictEqual(result.state, "error")
	assert.strictEqual(result.driver, "xstate")
	assert.strictEqual(result.action.action, "error")
	assert.ok(
		result.action.message.includes("/haiku:repair"),
		"error message should reference /haiku:repair",
	)
})

test("complete-without-studio still emits action (snapshot omitted)", () => {
	const { haikuRoot, cleanup } = fixture("test", {
		status: "completed",
	})
	const result = runFsmTick("test", haikuRoot)
	cleanup()
	assert.ok(result)
	assert.strictEqual(result.state, "complete")
	// No studio = no snapshot side-effect, but emitNativeAction is
	// studio-independent for `complete`. The action is still emitted.
	assert.strictEqual(result.driver, "xstate")
	assert.strictEqual(result.action.action, "complete")
	assert.strictEqual(result.snapshot, null)
})

console.log("\n=== xstate-native registry ===")

test("registry contains the migrated states", () => {
	for (const name of ["complete", "select_studio", "error"]) {
		assert.ok(
			XSTATE_NATIVE_STATES.has(name),
			`registry should include '${name}'`,
		)
	}
})

test("registry does NOT contain stage-active states (still on runNext)", () => {
	for (const name of [
		"escalate",
		"blocked",
		"elaborate",
		"execute",
		"review",
		"gate_review",
	]) {
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

console.log("\n=== Parity vs runNext (complete state) ===")

test("emitNativeAction('complete') matches runNext's shape byte-for-byte", () => {
	// runNext emits this exact shape at orchestrator.ts:2200 when
	// it sees status=completed. The xstate-native emitter must
	// match byte-for-byte or the migration is a regression.
	const slug = "test-completion"
	const action = emitNativeAction("complete", {
		slug,
		studio: "software",
		intentDirPath: `/dummy/${slug}`,
		intent: { studio: "software", status: "completed" },
		currentStage: "",
		currentPhase: "",
		stageState: {},
	})
	assert.deepStrictEqual(action, {
		action: "complete",
		message: `Intent '${slug}' is already completed`,
	})
})

test("emitNativeAction returns null for unmigrated states", () => {
	for (const name of ["blocked", "escalate", "elaborate"]) {
		const action = emitNativeAction(name, {
			slug: "x",
			studio: "software",
			intentDirPath: "/dummy",
			intent: {},
			currentStage: "",
			currentPhase: "",
			stageState: {},
		})
		assert.strictEqual(
			action,
			null,
			`'${name}' should not have a native emission yet`,
		)
	}
})

test("emitNativeAction('error') without recognized variant falls back to runNext (returns null)", () => {
	// 'error' is in the registry, but without intent.archived or
	// status=archived the emitter doesn't know which variant to
	// emit — so it returns null and the wrapper falls back to
	// runNext. This guards against silently emitting wrong errors.
	const action = emitNativeAction("error", {
		slug: "x",
		studio: "software",
		intentDirPath: "/dummy",
		intent: {},
		currentStage: "",
		currentPhase: "",
		stageState: {},
	})
	assert.strictEqual(action, null)
})

test("emitNativeAction('error') for archived flag emits unarchive message", () => {
	const action = emitNativeAction("error", {
		slug: "test-archived",
		studio: "software",
		intentDirPath: "/dummy",
		intent: { archived: true },
		currentStage: "",
		currentPhase: "",
		stageState: {},
	})
	assert.ok(action)
	assert.strictEqual(action.action, "error")
	assert.ok(action.message.includes("haiku_intent_unarchive"))
})

test("emitNativeAction('select_studio') produces studio list + correct message", () => {
	const slug = "test-no-studio"
	const action = emitNativeAction("select_studio", {
		slug,
		studio: "",
		intentDirPath: `/dummy/${slug}`,
		intent: {},
		currentStage: "",
		currentPhase: "",
		stageState: {},
	})
	assert.ok(action, "should emit an action")
	assert.strictEqual(action.action, "select_studio")
	assert.strictEqual(action.intent, slug)
	assert.ok(
		Array.isArray(action.available_studios),
		"available_studios should be an array",
	)
	assert.ok(
		action.available_studios.length > 0,
		"plugin ships at least one studio",
	)
	assert.strictEqual(
		action.message,
		`Intent '${slug}' has no studio selected. Call haiku_select_studio { intent: "${slug}" } to choose a lifecycle studio.`,
	)
	// Verify studio entries have the expected shape — same fields
	// runNext returns at orchestrator.ts:2164.
	const first = action.available_studios[0]
	assert.ok("name" in first)
	assert.ok("slug" in first)
	assert.ok("aliases" in first)
	assert.ok("description" in first)
	assert.ok("category" in first)
})

test("runFsmTick routes a no-studio intent through xstate to select_studio", () => {
	const { haikuRoot, cleanup } = fixture("test", {
		title: "No studio yet",
	})
	const result = runFsmTick("test", haikuRoot)
	cleanup()
	assert.ok(result)
	assert.strictEqual(result.state, "select_studio")
	assert.strictEqual(result.driver, "xstate")
	assert.ok(result.action, "should emit an action")
	assert.strictEqual(result.action.action, "select_studio")
})

console.log("\n=== start_stage native-emit ===")

test("composite intent defers start_stage to runNext (returns null)", () => {
	const { haikuRoot, cleanup } = fixture("test", {
		studio: "software",
		composite: true,
	})
	const result = runFsmTick("test", haikuRoot)
	cleanup()
	assert.ok(result)
	assert.strictEqual(result.state, "start_stage")
	// Composite intents have their own multi-stage delegate not yet
	// ported — start-stage emitter returns null, wrapper falls back
	// to runNext.
	assert.strictEqual(result.driver, "runNext")
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
