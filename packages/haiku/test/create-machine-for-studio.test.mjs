#!/usr/bin/env npx tsx
// Tests for the per-studio xstate machine factory.
//
// The factory composes an entire machine from a StudioConfig: every
// stage becomes a top-level state, every hat sequence is enumerated
// inside its stage's execute sub-machine, every fix-bolt-hat is
// enumerated in review_fix.
//
// The tests verify the structural shape — state names exist at the
// expected paths. Running the machine is out of scope; that belongs
// in the per-state migration tests (step 5).

import assert from "node:assert"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
process.env.CLAUDE_PLUGIN_ROOT = resolve(__dirname, "..", "..", "..", "plugin")

const { buildStudioConfig } = await import(
	"../src/orchestrator/fsm/build-studio-config.ts"
)
const { createMachineForStudio } = await import(
	"../src/orchestrator/fsm/create-machine-for-studio.ts"
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

const config = buildStudioConfig("software")
assert.ok(config, "software studio should resolve")
const studioMachine = createMachineForStudio(config)

console.log("=== Top-level state structure ===")

test("machine carries the studio identifier", () => {
	assert.strictEqual(studioMachine.studio, "software")
})

test("config has setup state", () => {
	const states = studioMachine.config.states
	assert.ok(states.select_studio, "select_studio missing")
})

test("config has every studio stage as a top-level state", () => {
	const states = studioMachine.config.states
	for (const stageName of config.defaultStages) {
		assert.ok(states[stageName], `stage state '${stageName}' missing`)
	}
})

test("config has terminal states", () => {
	const states = studioMachine.config.states
	for (const terminal of ["complete", "error", "escalate", "blocked"]) {
		assert.ok(states[terminal], `terminal state '${terminal}' missing`)
		assert.strictEqual(
			states[terminal].type,
			"final",
			`'${terminal}' should be type=final`,
		)
	}
})

test("config has intent-completion review states (software studio ships agents)", () => {
	const states = studioMachine.config.states
	assert.ok(states.intent_completion_review, "review state missing")
	assert.ok(states.intent_completion_gate, "gate state missing")
})

console.log("\n=== Per-stage sub-machine ===")

test("development stage exposes its phase progression", () => {
	const dev = studioMachine.config.states.development
	assert.ok(dev.states, "development has no nested states")
	for (const phase of [
		"start_stage",
		"elaborate",
		"execute",
		"review",
		"review_fix",
		"gate",
	]) {
		assert.ok(dev.states[phase], `development.${phase} missing`)
	}
})

test("development.execute enumerates the hat sequence", () => {
	const exec = studioMachine.config.states.development.states.execute
	assert.ok(exec.states, "execute has no nested states")
	const hatNames = config.stages.development.hats.map((h) => h.name)
	for (const hat of hatNames) {
		assert.ok(exec.states[hat], `execute.${hat} missing`)
	}
	assert.ok(exec.states.done, "execute.done terminal missing")
})

test("development.review_fix enumerates bolts and fix-hats", () => {
	const fix = studioMachine.config.states.development.states.review_fix
	assert.ok(fix.states, "review_fix has no nested states")
	// MAX_FIX_LOOP_BOLTS = 3 (state-tools.ts).
	for (let bolt = 1; bolt <= 3; bolt++) {
		const boltKey = `bolt_${bolt}`
		assert.ok(fix.states[boltKey], `review_fix.${boltKey} missing`)
		const fixHatNames = config.stages.development.fixHats.map((h) => h.name)
		for (const hat of fixHatNames) {
			assert.ok(
				fix.states[boltKey].states[hat],
				`review_fix.${boltKey}.${hat} missing`,
			)
		}
		assert.ok(
			fix.states[boltKey].states.validated,
			`review_fix.${boltKey}.validated terminal missing`,
		)
	}
})

test("stage carries gate type in meta", () => {
	const dev = studioMachine.config.states.development
	const gate = dev.meta?.gate
	assert.deepStrictEqual(gate, ["external", "ask"])
})

test("stage carries hat names in meta", () => {
	const dev = studioMachine.config.states.development
	assert.deepStrictEqual(dev.meta?.hats, ["planner", "builder", "reviewer"])
})

console.log("\n=== Machine instance ===")

test("machine instance is created", () => {
	assert.ok(studioMachine.machine, "machine missing")
	assert.strictEqual(studioMachine.machine.id, "haiku-fsm-software")
})

test("machine config is JSON-serializable (no closures)", () => {
	// JSON.stringify on a config with closures throws or produces
	// "[Function]" placeholders. We verify the shape round-trips
	// — that's the visualization invariant.
	const json = JSON.stringify(studioMachine.config)
	assert.ok(json.length > 0)
	const parsed = JSON.parse(json)
	assert.strictEqual(parsed.id, "haiku-fsm-software")
	assert.ok(parsed.states.development, "development survived round-trip")
})

console.log("\n=== Stage transitions ===")

test("first stage flows from select_studio", () => {
	const select = studioMachine.config.states.select_studio
	const onSelected = select.on?.["studio.selected"]
	assert.strictEqual(onSelected, config.defaultStages[0])
})

test("non-final stage advances to next stage via onDone", () => {
	const inception = studioMachine.config.states.inception
	const expectedNext = config.defaultStages[1]
	assert.strictEqual(inception.onDone, expectedNext)
})

test("final stage advances to intent_completion_review via onDone", () => {
	const lastStageName = config.defaultStages[config.defaultStages.length - 1]
	const lastStage = studioMachine.config.states[lastStageName]
	assert.strictEqual(lastStage.onDone, "intent_completion_review")
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
