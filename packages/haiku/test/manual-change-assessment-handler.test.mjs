#!/usr/bin/env npx tsx
// Tests for manual-change-assessment.ts — builder + action union guard.
//
// Coverage (unit-05 spec + features/manual-change-assessment.feature):
//  1. Builder produces action with action === 'manual_change_assessment'.
//  2. findings array length equals input length; ordering preserved.
//  3. legal_outcomes excludes trigger-revisit for current-stage findings (AC-CO1).
//  4. legal_outcomes includes all four for earlier-stage findings (AC-EO1).
//  5. legal_outcomes excludes inline-fix for file-removed change_kind (DATA-CONTRACTS §3.4).
//  6. tick_id is unique per dispatch — two consecutive dispatches return different IDs.
//  7. instructions mentions haiku_classify_drift and the four outcome strings.
//  8. Same-tick atomic batching: 60 findings produce one action with all 60.
//  9. isManualChangeAssessment guard returns true for the shape, false for others.

import assert from "node:assert"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const tmp = mkdtempSync(join(tmpdir(), "haiku-mca-test-"))

const {
	buildManualChangeAssessmentAction,
	isManualChangeAssessment,
} = await import(
	"../src/orchestrator/workflow/handlers/manual-change-assessment.ts"
)

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

/** Make a minimal DerivedContext for testing. */
function makeCtx(overrides = {}) {
	return {
		slug: "demo-intent",
		studio: "software",
		intentDirPath: join(tmp, "intents", "demo-intent"),
		intent: { mode: "interactive", status: "active", studio: "software" },
		currentStage: "design",
		currentPhase: "execute",
		stageState: { iteration: 7 },
		...overrides,
	}
}

/** Make a minimal DriftFinding for testing. */
function makeFinding(overrides = {}) {
	return {
		path: "stages/design/artifacts/spec.md",
		change_kind: "modified",
		is_binary: false,
		diff_unified: "--- a/spec.md\n+++ b/spec.md\n@@ -1 +1 @@\n-old\n+new\n",
		before_sha256: "aaaa".repeat(16),
		after_sha256: "bbbb".repeat(16),
		before_bytes: 100,
		after_bytes: 103,
		tracking_class: "stage-output",
		stage: "design",
		context_unit: null,
		...overrides,
	}
}

// ── Scenario 1: action discriminator ──────────────────────────────────────

console.log("\n=== Scenario 1: action discriminator ===")

test("builder produces action with action === 'manual_change_assessment'", () => {
	const ctx = makeCtx()
	const findings = [makeFinding()]
	const action = buildManualChangeAssessmentAction(ctx, findings)

	assert.strictEqual(action.action, "manual_change_assessment")
	assert.ok(action.intent_slug, "intent_slug should be set")
	assert.strictEqual(action.intent_slug, ctx.slug)
	assert.ok(action.stage, "stage should be set")
	assert.ok(action.tick_id, "tick_id should be set")
	assert.ok(Array.isArray(action.findings), "findings should be an array")
	assert.ok(typeof action.instructions === "string", "instructions should be a string")
	assert.ok(action.legal_outcomes && typeof action.legal_outcomes === "object", "legal_outcomes should be an object")
})

// ── Scenario 2: findings array length + ordering ───────────────────────────

console.log("\n=== Scenario 2: findings array length and ordering ===")

test("findings array length equals input length and ordering is preserved", () => {
	const ctx = makeCtx()
	const findings = [
		makeFinding({ path: "stages/design/artifacts/a.md" }),
		makeFinding({ path: "stages/design/artifacts/b.md" }),
		makeFinding({ path: "stages/design/artifacts/c.md" }),
	]
	const action = buildManualChangeAssessmentAction(ctx, findings)

	assert.strictEqual(action.findings.length, 3, "findings array length should match input")
	assert.strictEqual(action.findings[0].path, "stages/design/artifacts/a.md", "first finding path preserved")
	assert.strictEqual(action.findings[1].path, "stages/design/artifacts/b.md", "second finding path preserved")
	assert.strictEqual(action.findings[2].path, "stages/design/artifacts/c.md", "third finding path preserved")
})

// ── Scenario 3: legal_outcomes excludes trigger-revisit for current-stage (AC-CO1) ──

console.log("\n=== Scenario 3: legal_outcomes — current-stage excludes trigger-revisit (AC-CO1) ===")

test("current-stage finding has trigger-revisit excluded from legal_outcomes (AC-CO1)", () => {
	const ctx = makeCtx({ currentStage: "design" })
	const finding = makeFinding({
		path: "stages/design/artifacts/spec.md",
		stage: "design",  // same as activeStage
	})
	const action = buildManualChangeAssessmentAction(ctx, [finding])

	const outcomes = action.legal_outcomes[finding.path]
	assert.ok(Array.isArray(outcomes), "legal_outcomes should have an entry for the finding path")
	assert.ok(
		!outcomes.includes("trigger-revisit"),
		`trigger-revisit should be excluded for current-stage finding, got: [${outcomes.join(", ")}]`,
	)
	assert.ok(outcomes.includes("ignore"), "ignore should be allowed for current-stage finding")
	assert.ok(outcomes.includes("inline-fix"), "inline-fix should be allowed for current-stage modified finding")
	assert.ok(outcomes.includes("surface-as-feedback"), "surface-as-feedback should be allowed for current-stage finding")
})

// ── Scenario 4: legal_outcomes includes all four for earlier-stage (AC-EO1) ──

console.log("\n=== Scenario 4: legal_outcomes — earlier-stage includes all four (AC-EO1) ===")

test("earlier-stage finding has all four outcomes in legal_outcomes (AC-EO1)", () => {
	const ctx = makeCtx({ currentStage: "development" })
	const finding = makeFinding({
		path: "stages/design/artifacts/spec.md",
		stage: "design",  // earlier than activeStage "development"
	})
	const action = buildManualChangeAssessmentAction(ctx, [finding])

	const outcomes = action.legal_outcomes[finding.path]
	assert.ok(Array.isArray(outcomes), "legal_outcomes should have entry for the path")
	assert.ok(outcomes.includes("ignore"), "ignore allowed for earlier-stage")
	assert.ok(outcomes.includes("inline-fix"), "inline-fix allowed for earlier-stage")
	assert.ok(outcomes.includes("surface-as-feedback"), "surface-as-feedback allowed for earlier-stage")
	assert.ok(outcomes.includes("trigger-revisit"), "trigger-revisit allowed for earlier-stage (AC-EO1)")
})

// ── Scenario 5: legal_outcomes excludes inline-fix for file-removed (DATA-CONTRACTS §3.4) ──

console.log("\n=== Scenario 5: legal_outcomes — file-removed excludes inline-fix (DATA-CONTRACTS §3.4) ===")

test("file-removed finding has inline-fix excluded from legal_outcomes (DATA-CONTRACTS §3.4)", () => {
	const ctx = makeCtx({ currentStage: "development" })
	const finding = makeFinding({
		path: "stages/inception/artifacts/DISCOVERY.md",
		stage: "inception",  // earlier stage — so trigger-revisit IS allowed
		change_kind: "file-removed",
		after_sha256: null,
		after_bytes: null,
		diff_unified: null,
	})
	const action = buildManualChangeAssessmentAction(ctx, [finding])

	const outcomes = action.legal_outcomes[finding.path]
	assert.ok(Array.isArray(outcomes), "legal_outcomes should have entry for the path")
	assert.ok(
		!outcomes.includes("inline-fix"),
		`inline-fix should be excluded for file-removed, got: [${outcomes.join(", ")}]`,
	)
	assert.ok(outcomes.includes("ignore"), "ignore allowed for file-removed")
	assert.ok(outcomes.includes("surface-as-feedback"), "surface-as-feedback allowed for file-removed")
	assert.ok(outcomes.includes("trigger-revisit"), "trigger-revisit allowed for earlier-stage file-removed")
})

test("current-stage file-removed: both inline-fix AND trigger-revisit excluded", () => {
	const ctx = makeCtx({ currentStage: "design" })
	const finding = makeFinding({
		path: "stages/design/artifacts/removed.html",
		stage: "design",  // same as activeStage → trigger-revisit excluded (AC-CO1)
		change_kind: "file-removed",
		after_sha256: null,
		after_bytes: null,
		diff_unified: null,
	})
	const action = buildManualChangeAssessmentAction(ctx, [finding])

	const outcomes = action.legal_outcomes[finding.path]
	assert.ok(!outcomes.includes("inline-fix"), "inline-fix excluded (file-removed)")
	assert.ok(!outcomes.includes("trigger-revisit"), "trigger-revisit excluded (current-stage)")
	assert.ok(outcomes.includes("ignore"), "ignore still allowed")
	assert.ok(outcomes.includes("surface-as-feedback"), "surface-as-feedback still allowed")
})

// ── Scenario 6: tick_id unique per dispatch ────────────────────────────────

console.log("\n=== Scenario 6: tick_id unique per dispatch ===")

test("two consecutive dispatches produce different tick_ids", async () => {
	const ctx = makeCtx()
	const findings = [makeFinding()]

	const action1 = buildManualChangeAssessmentAction(ctx, findings)
	// Small delay to guarantee timestamp differs (tick_id includes ms timestamp).
	await new Promise((r) => setTimeout(r, 5))
	const action2 = buildManualChangeAssessmentAction(ctx, findings)

	assert.ok(
		action1.tick_id !== action2.tick_id,
		`tick_ids should differ: "${action1.tick_id}" vs "${action2.tick_id}"`,
	)
})

// ── Scenario 7: instructions mention haiku_classify_drift and four outcomes ──

console.log("\n=== Scenario 7: instructions mention haiku_classify_drift and four outcomes ===")

test("instructions mention haiku_classify_drift and all four outcome strings", () => {
	const ctx = makeCtx()
	const findings = [makeFinding()]
	const action = buildManualChangeAssessmentAction(ctx, findings)

	const instr = action.instructions
	assert.ok(
		instr.includes("haiku_classify_drift"),
		"instructions should mention haiku_classify_drift",
	)
	assert.ok(instr.includes("ignore"), "instructions should mention 'ignore' outcome")
	assert.ok(instr.includes("inline-fix"), "instructions should mention 'inline-fix' outcome")
	assert.ok(instr.includes("surface-as-feedback"), "instructions should mention 'surface-as-feedback' outcome")
	assert.ok(instr.includes("trigger-revisit"), "instructions should mention 'trigger-revisit' outcome")
})

// ── Scenario 8: same-tick atomic batching — 60 findings ───────────────────

console.log("\n=== Scenario 8: same-tick atomic batching (60 findings) ===")

test("60 findings produce one action with all 60 in the findings array (AC-G12)", () => {
	const ctx = makeCtx()
	const findings = Array.from({ length: 60 }, (_, i) =>
		makeFinding({
			path: `stages/design/artifacts/file-${String(i + 1).padStart(2, "0")}.md`,
		}),
	)
	const action = buildManualChangeAssessmentAction(ctx, findings)

	assert.strictEqual(action.action, "manual_change_assessment")
	assert.strictEqual(
		action.findings.length,
		60,
		`findings array should contain all 60 findings, got ${action.findings.length}`,
	)
	// Verify no pagination cursor or batch metadata.
	assert.ok(!("page" in action), "action should have no 'page' field")
	assert.ok(!("has_more" in action), "action should have no 'has_more' field")
	assert.ok(!("batch_id" in action), "action should have no 'batch_id' field")
})

// ── Scenario 9: isManualChangeAssessment guard ─────────────────────────────

console.log("\n=== Scenario 9: isManualChangeAssessment guard ===")

test("isManualChangeAssessment returns true for a manual_change_assessment shape", () => {
	const ctx = makeCtx()
	const action = buildManualChangeAssessmentAction(ctx, [makeFinding()])
	assert.ok(
		isManualChangeAssessment(action),
		"isManualChangeAssessment should return true for the new shape",
	)
})

test("isManualChangeAssessment returns false for other action shapes", () => {
	const others = [
		{ action: "elaborate" },
		{ action: "execute" },
		{ action: "error", message: "oops" },
		{ action: "gate_review" },
		{ action: "feedback_triage" },
	]
	for (const other of others) {
		assert.ok(
			!isManualChangeAssessment(other),
			`isManualChangeAssessment should return false for action '${other.action}'`,
		)
	}
})

// ── DRF-NN finding IDs are assigned and zero-padded ───────────────────────

console.log("\n=== Additional: DRF-NN finding_id assignment ===")

test("findings are assigned DRF-NN ids, zero-padded, starting at DRF-01", () => {
	const ctx = makeCtx()
	const findings = [
		makeFinding({ path: "stages/design/artifacts/a.md" }),
		makeFinding({ path: "stages/design/artifacts/b.md" }),
		makeFinding({ path: "stages/design/artifacts/c.md" }),
	]
	const action = buildManualChangeAssessmentAction(ctx, findings)

	assert.strictEqual(action.findings[0].finding_id, "DRF-01")
	assert.strictEqual(action.findings[1].finding_id, "DRF-02")
	assert.strictEqual(action.findings[2].finding_id, "DRF-03")
})

test("DRF-NN ids are zero-padded to two digits", () => {
	const ctx = makeCtx()
	const findings = Array.from({ length: 9 }, (_, i) =>
		makeFinding({ path: `stages/design/artifacts/file-${i}.md` }),
	)
	const action = buildManualChangeAssessmentAction(ctx, findings)

	for (let i = 0; i < 9; i++) {
		const expectedId = `DRF-0${i + 1}`
		assert.strictEqual(
			action.findings[i].finding_id,
			expectedId,
			`finding ${i} should have id ${expectedId}, got ${action.findings[i].finding_id}`,
		)
	}
})

// ── mode is sourced from intent frontmatter ────────────────────────────────

console.log("\n=== Additional: mode sourced from intent frontmatter ===")

test("mode field reflects intent.mode from context", () => {
	const ctx = makeCtx({ intent: { mode: "autopilot", status: "active", studio: "software" } })
	const action = buildManualChangeAssessmentAction(ctx, [makeFinding()])
	assert.strictEqual(action.mode, "autopilot")
})

test("mode defaults to 'interactive' when intent.mode is absent", () => {
	const ctx = makeCtx({ intent: { status: "active", studio: "software" } })
	const action = buildManualChangeAssessmentAction(ctx, [makeFinding()])
	assert.strictEqual(action.mode, "interactive")
})

// ── Cleanup + summary ──────────────────────────────────────────────────────

try {
	rmSync(tmp, { recursive: true, force: true })
} catch {}

console.log("")
console.log(`  ${passed + failed} tests: ${passed} passed, ${failed} failed`)
console.log("")

process.exit(failed > 0 ? 1 : 0)
