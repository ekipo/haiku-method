#!/usr/bin/env node
// CI guard: assert the four named drift / reconciliation test files exist
// AND would be discovered by `packages/haiku/test/run-all.mjs`.
//
// Why this exists: the drift-detection-gate and upstream-reconciliation
// tests are the only safety net catching a silent regression of the two
// pre-tick gates (drift-gate silent-establish, reconciliation fingerprint
// short-circuit). A future test-glob refactor or accidental file rename
// could remove that coverage without breaking a single sibling test.
// This script names the four files explicitly so CI fails loud if any
// disappear or are excluded from the run-all.mjs discovery filter.
//
// Usage: node scripts/check-ci-covers-drift-tests.mjs
// Exit code: 0 = all four present + discoverable, 1 = at least one gap.

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const testDir = join(repoRoot, "packages", "haiku", "test")
const runAllPath = join(testDir, "run-all.mjs")

const REQUIRED_FILES = [
	"drift-detection-gate.test.mjs",
	"upstream-reconciliation.test.mjs",
	"drift-baseline.test.mjs",
	"drift-markers.test.mjs",
]

let failures = 0
const lines = []

// 1. Each required file must exist on disk.
for (const f of REQUIRED_FILES) {
	const full = join(testDir, f)
	if (!existsSync(full)) {
		lines.push(`  ✗ MISSING: packages/haiku/test/${f}`)
		failures++
	} else {
		lines.push(`  ✓ present: packages/haiku/test/${f}`)
	}
}

// 2. run-all.mjs must exist (the entry point CI invokes).
if (!existsSync(runAllPath)) {
	lines.push(`  ✗ MISSING: packages/haiku/test/run-all.mjs`)
	failures++
} else {
	lines.push(`  ✓ present: packages/haiku/test/run-all.mjs`)
}

// 3. Each required file must be picked up by the run-all.mjs discovery
//    filter (currently: `*.test.mjs` excluding state-tools.test.mjs).
//    We replay that filter against the actual directory listing rather
//    than parsing JS, so a future filter change (e.g. moving to a glob
//    library) is still validated empirically.
let discovered = []
if (existsSync(testDir)) {
	const runAllSource = existsSync(runAllPath)
		? readFileSync(runAllPath, "utf8")
		: ""
	// Best-effort replication of run-all.mjs filter:
	// `f.endsWith(".test.mjs") && f !== "state-tools.test.mjs"`
	// If run-all.mjs's filter changes shape, this script's job is to
	// catch the divergence — fail loudly rather than silently passing.
	const filterMatch = runAllSource.match(
		/\.endsWith\(["']\.test\.mjs["']\)\s*&&\s*f\s*!==\s*["']([^"']+)["']/,
	)
	const excluded = filterMatch ? filterMatch[1] : "state-tools.test.mjs"
	discovered = readdirSync(testDir)
		.filter((f) => f.endsWith(".test.mjs") && f !== excluded)
		.sort()

	for (const f of REQUIRED_FILES) {
		if (!discovered.includes(f)) {
			lines.push(`  ✗ NOT DISCOVERED by run-all.mjs: ${f}`)
			failures++
		}
	}
}

console.log("CI drift-test coverage check")
console.log("─".repeat(60))
for (const l of lines) console.log(l)
console.log("─".repeat(60))

if (failures > 0) {
	console.error(
		`\nFAIL: ${failures} drift-test coverage gap(s). The four named test files`,
	)
	console.error(
		"      lock in the drift-gate silent-establish and reconciliation",
	)
	console.error(
		"      fingerprint short-circuit contracts. Restore them or update",
	)
	console.error(
		"      this script's REQUIRED_FILES if the contract has moved.",
	)
	process.exit(1)
}

console.log(
	`\nOK: all ${REQUIRED_FILES.length} drift-test files present + discoverable by run-all.mjs.`,
)
process.exit(0)
