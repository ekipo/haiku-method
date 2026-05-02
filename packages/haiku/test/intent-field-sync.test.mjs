#!/usr/bin/env npx tsx
// Tests for setIntentField (mirrors writes to intent main) and the
// pre-tick intent.md divergence guard.

import assert from "node:assert"
import { execFileSync } from "node:child_process"
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
process.env.CLAUDE_PLUGIN_ROOT = resolve(__dirname, "..", "..", "..", "plugin")

const { setIntentField } = await import("../src/state-tools.ts")
const { preTickConsistency } = await import(
	"../src/orchestrator/workflow/pre-tick.ts"
)
const { _resetIsGitRepoForTests, setHaikuRootForTests, setIsGitRepoForTests } =
	await import("../src/state/shared.ts")

// ── Helpers ────────────────────────────────────────────────────────────────

function git(cwd, ...args) {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
}

function makeIntentFm(fields = {}) {
	const base = {
		title: "Test Intent",
		studio: "software",
		mode: "discrete",
		status: "active",
		active_stage: "inception",
		phase: "active",
		completed_at: null,
	}
	const merged = { ...base, ...fields }
	const lines = ["---"]
	for (const [k, v] of Object.entries(merged)) {
		if (v === null) lines.push(`${k}: null`)
		else if (typeof v === "boolean") lines.push(`${k}: ${v}`)
		else lines.push(`${k}: "${v}"`)
	}
	lines.push("---", "", "# Intent body")
	return lines.join("\n")
}

let passed = 0
let failed = 0

async function test(name, fn) {
	const origCwd = process.cwd()
	_resetIsGitRepoForTests()
	try {
		await fn()
		passed++
		console.log(`  ✓ ${name}`)
	} catch (e) {
		failed++
		console.log(`  ✗ ${name}: ${e.message}`)
		if (process.env.VERBOSE) console.error(e)
	} finally {
		process.chdir(origCwd)
		_resetIsGitRepoForTests()
		setHaikuRootForTests(null)
		setIsGitRepoForTests(null)
	}
}

// ── setIntentField: filesystem mode ───────────────────────────────────────

console.log("\n=== setIntentField: filesystem (non-git) mode ===")

await test("writes field locally and skips mirror in non-git mode", () => {
	const tmp = mkdtempSync(join(tmpdir(), "haiku-sif-test-"))
	const slug = "fs-intent"
	const iDir = join(tmp, "intents", slug)
	mkdirSync(iDir, { recursive: true })
	writeFileSync(join(iDir, "intent.md"), makeIntentFm({ status: "active" }))

	setHaikuRootForTests(tmp)
	setIsGitRepoForTests(false)

	setIntentField(slug, "status", "completed")

	const raw = readFileSync(join(iDir, "intent.md"), "utf8")
	assert.ok(raw.includes("status: completed"), "local intent.md should be updated")
	assert.ok(!raw.includes("status: active"), "old value should be replaced")

	rmSync(tmp, { recursive: true, force: true })
})

await test("writes multiple fields sequentially", () => {
	const tmp = mkdtempSync(join(tmpdir(), "haiku-sif-test-"))
	const slug = "multi-intent"
	const iDir = join(tmp, "intents", slug)
	mkdirSync(iDir, { recursive: true })
	writeFileSync(join(iDir, "intent.md"), makeIntentFm())

	setHaikuRootForTests(tmp)
	setIsGitRepoForTests(false)

	setIntentField(slug, "status", "completed")
	setIntentField(slug, "phase", "awaiting_completion_review")

	const raw = readFileSync(join(iDir, "intent.md"), "utf8")
	assert.ok(raw.includes("status: completed"), "status should be updated")
	assert.ok(
		raw.includes("awaiting_completion_review"),
		"phase should be updated",
	)

	rmSync(tmp, { recursive: true, force: true })
})

// ── setIntentField: git mode — mirrors write to intent main ───────────────

console.log("\n=== setIntentField: git mode (mirror to intent main) ===")

await test("mirrors write to intent main branch", () => {
	const tmp = mkdtempSync(join(tmpdir(), "haiku-sif-git-"))
	const slug = "git-intent"
	const haikuRoot = join(tmp, ".haiku")
	const iDir = join(haikuRoot, "intents", slug)
	const intentRelPath = `.haiku/intents/${slug}/intent.md`

	// Set up git repo
	git(tmp, "init", "--initial-branch=main")
	git(tmp, "config", "user.email", "test@haiku")
	git(tmp, "config", "user.name", "haiku-test")
	git(tmp, "config", "commit.gpgsign", "false")
	writeFileSync(join(tmp, "README.md"), "# test\n")
	git(tmp, "add", "-A")
	git(tmp, "commit", "-m", "initial")

	// Create intent main branch with intent.md
	git(tmp, "branch", `haiku/${slug}/main`, "main")
	git(tmp, "checkout", `haiku/${slug}/main`)
	mkdirSync(iDir, { recursive: true })
	writeFileSync(join(iDir, "intent.md"), makeIntentFm({ status: "active" }))
	git(tmp, "add", "-A")
	git(tmp, "commit", "-m", "seed intent")

	// Create a stage branch from main
	git(tmp, "checkout", "-b", `haiku/${slug}/inception`)

	process.chdir(tmp)
	setHaikuRootForTests(haikuRoot)

	// Write via setIntentField (status → completed)
	setIntentField(slug, "status", "completed")

	// Verify local file was updated
	const localRaw = readFileSync(join(iDir, "intent.md"), "utf8")
	assert.ok(
		localRaw.includes("completed"),
		"local intent.md should have status: completed",
	)

	// Verify intent main was also updated
	const mainContent = git(
		tmp,
		"show",
		`haiku/${slug}/main:${intentRelPath}`,
	)
	assert.ok(
		mainContent.includes("completed"),
		"intent main should also have status: completed after mirror",
	)

	rmSync(tmp, { recursive: true, force: true })
})

// ── preTickConsistency: divergence guard ──────────────────────────────────

console.log("\n=== preTickConsistency: intent.md divergence guard ===")

await test("no-op when intent main matches stage branch", () => {
	const tmp = mkdtempSync(join(tmpdir(), "haiku-ptc-nodiv-"))
	const slug = "no-diverge"
	const haikuRoot = join(tmp, ".haiku")
	const iDir = join(haikuRoot, "intents", slug)

	git(tmp, "init", "--initial-branch=main")
	git(tmp, "config", "user.email", "test@haiku")
	git(tmp, "config", "user.name", "haiku-test")
	git(tmp, "config", "commit.gpgsign", "false")
	writeFileSync(join(tmp, "README.md"), "# test\n")
	git(tmp, "add", "-A")
	git(tmp, "commit", "-m", "initial")

	git(tmp, "branch", `haiku/${slug}/main`, "main")
	git(tmp, "checkout", `haiku/${slug}/main`)
	mkdirSync(iDir, { recursive: true })
	writeFileSync(join(iDir, "intent.md"), makeIntentFm({ status: "active" }))
	mkdirSync(join(iDir, "stages", "inception"), { recursive: true })
	writeFileSync(
		join(iDir, "stages", "inception", "state.json"),
		JSON.stringify({ stage: "inception", status: "active", phase: "elaborate" }),
	)
	git(tmp, "add", "-A")
	git(tmp, "commit", "-m", "seed intent")

	git(tmp, "checkout", "-b", `haiku/${slug}/inception`)

	process.chdir(tmp)
	setHaikuRootForTests(haikuRoot)

	// Both branches have the same intent.md → no divergence
	const result = preTickConsistency(slug, haikuRoot)

	// Should not return divergence action (may return other repair or null)
	if (result !== null) {
		assert.notStrictEqual(
			result.action,
			"safe_intent_repair",
			"should not surface safe_intent_repair when intent.md matches",
		)
		// If it's a safe_intent_repair it must NOT be about divergence
		if (result.action === "safe_intent_repair") {
			assert.ok(
				!result.diverged_fields,
				"diverged_fields should not be set when there is no divergence",
			)
		}
	}

	rmSync(tmp, { recursive: true, force: true })
})

await test("surfaces safe_intent_repair when intent.md diverges between stage branch and intent main", () => {
	const tmp = mkdtempSync(join(tmpdir(), "haiku-ptc-div-"))
	const slug = "diverge-test"
	const haikuRoot = join(tmp, ".haiku")
	const iDir = join(haikuRoot, "intents", slug)

	git(tmp, "init", "--initial-branch=main")
	git(tmp, "config", "user.email", "test@haiku")
	git(tmp, "config", "user.name", "haiku-test")
	git(tmp, "config", "commit.gpgsign", "false")
	writeFileSync(join(tmp, "README.md"), "# test\n")
	git(tmp, "add", "-A")
	git(tmp, "commit", "-m", "initial")

	// Intent main: status "active"
	git(tmp, "branch", `haiku/${slug}/main`, "main")
	git(tmp, "checkout", `haiku/${slug}/main`)
	mkdirSync(iDir, { recursive: true })
	writeFileSync(join(iDir, "intent.md"), makeIntentFm({ status: "active" }))
	mkdirSync(join(iDir, "stages", "inception"), { recursive: true })
	writeFileSync(
		join(iDir, "stages", "inception", "state.json"),
		JSON.stringify({ stage: "inception", status: "active", phase: "elaborate" }),
	)
	git(tmp, "add", "-A")
	git(tmp, "commit", "-m", "seed intent on main")

	// Stage branch: status "completed" (simulates a stale write that bypassed the mirror)
	git(tmp, "checkout", "-b", `haiku/${slug}/inception`)
	writeFileSync(
		join(iDir, "intent.md"),
		makeIntentFm({ status: "completed", phase: "active" }),
	)
	git(tmp, "add", "-A")
	git(tmp, "commit", "-m", "stage branch: status diverged from main")

	process.chdir(tmp)
	setHaikuRootForTests(haikuRoot)

	// pre-tick should detect divergence and surface safe_intent_repair
	const result = preTickConsistency(slug, haikuRoot)

	assert.ok(result, "pre-tick should return an action when divergence exists")
	assert.strictEqual(
		result.action,
		"safe_intent_repair",
		"action should be safe_intent_repair",
	)
	assert.ok(
		Array.isArray(result.diverged_fields),
		"diverged_fields should be an array",
	)
	assert.ok(
		result.diverged_fields.includes("status"),
		`diverged_fields should include 'status', got: ${JSON.stringify(result.diverged_fields)}`,
	)
	assert.strictEqual(result.repaired, true, "repaired flag should be true")

	// Verify intent main was updated to match the stage branch
	const mainContent = git(
		tmp,
		"show",
		`haiku/${slug}/main:.haiku/intents/${slug}/intent.md`,
	)
	assert.ok(
		mainContent.includes("completed"),
		"intent main should be updated to match stage branch after repair",
	)

	rmSync(tmp, { recursive: true, force: true })
})

await test("divergence check is no-op in non-git mode", () => {
	const tmp = mkdtempSync(join(tmpdir(), "haiku-ptc-nogit-"))
	const slug = "nogit-test"
	const haikuRoot = join(tmp, ".haiku")
	const iDir = join(haikuRoot, "intents", slug)

	mkdirSync(iDir, { recursive: true })
	writeFileSync(join(iDir, "intent.md"), makeIntentFm({ status: "active" }))
	mkdirSync(join(iDir, "stages", "inception"), { recursive: true })
	writeFileSync(
		join(iDir, "stages", "inception", "state.json"),
		JSON.stringify({ stage: "inception", status: "active", phase: "elaborate" }),
	)

	setHaikuRootForTests(haikuRoot)
	setIsGitRepoForTests(false)

	// Without git, divergence guard cannot run (no intent main to compare)
	const result = preTickConsistency(slug, haikuRoot)

	// Should not surface divergence action (may return null or other action)
	if (result !== null && result.action === "safe_intent_repair") {
		assert.ok(
			!result.diverged_fields,
			"should not detect divergence in non-git mode",
		)
	}

	rmSync(tmp, { recursive: true, force: true })
})

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
