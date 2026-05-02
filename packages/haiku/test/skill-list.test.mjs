#!/usr/bin/env npx tsx
// Tests for haiku_skill_list MCP tool and applicable_skills hat prompt injection
// Run: npx tsx test/skill-list.test.mjs

import assert from "node:assert"
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

// Point CLAUDE_PLUGIN_ROOT to the real plugin dir so studio files resolve
const origCwd = process.cwd()
process.env.CLAUDE_PLUGIN_ROOT = join(origCwd, "..", "..", "plugin")

import {
	handleStateTool,
	listInstalledSkills,
} from "../src/state-tools.ts"

// ── Setup ──────────────────────────────────────────────────────────────────

const tmp = mkdtempSync(join(tmpdir(), "haiku-skill-list-"))

// Create a fake project with .claude/skills/ structure
const projDir = join(tmp, "project")
const skillsDir = join(projDir, ".claude", "skills")
mkdirSync(join(skillsDir, "test"), { recursive: true })
mkdirSync(join(skillsDir, "refactor"), { recursive: true })

writeFileSync(
	join(skillsDir, "test", "SKILL.md"),
	`---
name: test
description: Write tests for code using TDD principles
---

Run this skill to add tests.
`,
)

writeFileSync(
	join(skillsDir, "refactor", "SKILL.md"),
	`---
name: refactor
description: Restructure code to improve quality without changing behavior
---

Run this skill to refactor code.
`,
)

// Stub git so anything that shells out doesn't blow up.
const fakeBin = join(tmp, "fake-bin")
mkdirSync(fakeBin, { recursive: true })
writeFileSync(join(fakeBin, "git"), "#!/bin/sh\nexit 0\n")
import { chmodSync } from "node:fs"
chmodSync(join(fakeBin, "git"), 0o755)
process.env.PATH = `${fakeBin}:${process.env.PATH}`

let passed = 0
let failed = 0

function test(name, fn) {
	try {
		fn()
		passed++
		console.log(`  ✓ ${name}`)
	} catch (e) {
		failed++
		console.log(`  ✗ ${name}: ${e.message}`)
	}
}

async function testAsync(name, fn) {
	try {
		await fn()
		passed++
		console.log(`  ✓ ${name}`)
	} catch (e) {
		failed++
		console.log(`  ✗ ${name}: ${e.message}`)
		if (e.stack) console.log(e.stack)
	}
}

function getTextResult(result) {
	return result.content?.[0]?.text ?? ""
}

/** Extract the prompt_file path from a <subagent prompt_file="..."> block. */
function extractPromptFilePath(text) {
	const match = text.match(/prompt_file="([^"]+)"/)
	return match?.[1] ?? null
}

// ── Tests ──────────────────────────────────────────────────────────────────

try {
	process.chdir(projDir)

	console.log("\n=== listInstalledSkills ===")

	test("returns project-local skills", () => {
		const skills = listInstalledSkills()
		const slugs = skills.map((s) => s.slug)
		assert.ok(
			slugs.includes("test"),
			`Expected 'test' in skills, got: ${slugs.join(", ")}`,
		)
		assert.ok(
			slugs.includes("refactor"),
			`Expected 'refactor' in skills, got: ${slugs.join(", ")}`,
		)
	})

	test("each skill has slug, name, description, source", () => {
		const skills = listInstalledSkills()
		const testSkill = skills.find((s) => s.slug === "test")
		assert.ok(testSkill, "Expected 'test' skill to be found")
		assert.strictEqual(testSkill.name, "test")
		assert.strictEqual(
			testSkill.description,
			"Write tests for code using TDD principles",
		)
		assert.strictEqual(testSkill.source, "project")
	})

	test("de-duplicates by slug (first occurrence wins)", () => {
		const skills = listInstalledSkills()
		const testSkills = skills.filter((s) => s.slug === "test")
		assert.strictEqual(testSkills.length, 1, "Expected exactly one 'test' entry")
	})

	test("returns empty array gracefully when no skills dir exists", () => {
		const emptyDir = join(tmp, "empty-project")
		mkdirSync(emptyDir, { recursive: true })
		process.chdir(emptyDir)
		try {
			const skills = listInstalledSkills()
			assert.ok(Array.isArray(skills))
		} finally {
			process.chdir(projDir)
		}
	})

	console.log("\n=== haiku_skill_list MCP tool ===")

	test("haiku_skill_list returns skills array", () => {
		const result = handleStateTool("haiku_skill_list", {})
		assert.ok(!result.isError, `Tool returned error: ${getTextResult(result)}`)
		const parsed = JSON.parse(getTextResult(result))
		assert.ok(
			Array.isArray(parsed.skills),
			"Expected skills to be an array",
		)
	})

	test("haiku_skill_list includes project-local skills with correct shape", () => {
		const result = handleStateTool("haiku_skill_list", {})
		const parsed = JSON.parse(getTextResult(result))
		const testSkill = parsed.skills.find((s) => s.slug === "test")
		assert.ok(testSkill, "Expected 'test' skill in haiku_skill_list result")
		assert.strictEqual(testSkill.name, "test")
		assert.ok(
			typeof testSkill.description === "string",
			"Expected description to be a string",
		)
		assert.ok(
			typeof testSkill.source === "string",
			"Expected source to be a string",
		)
	})

	await testAsync("haiku_skill_list is in stateToolDefs", async () => {
		const { stateToolDefs } = await import("../src/state-tools.ts")
		const def = stateToolDefs.find((t) => t.name === "haiku_skill_list")
		assert.ok(def, "haiku_skill_list must be in stateToolDefs")
		assert.ok(def.description, "haiku_skill_list must have a description")
		assert.ok(def.outputSchema, "haiku_skill_list must have an outputSchema")
	})

	await testAsync("applicable_skills is in UNIT_FRONTMATTER_SCHEMA", async () => {
		const { UNIT_FRONTMATTER_SCHEMA, AGENT_AUTHORABLE_UNIT_FIELDS } =
			await import("../src/state-tools.ts")
		assert.ok(
			"applicable_skills" in UNIT_FRONTMATTER_SCHEMA.properties,
			"applicable_skills must be in UNIT_FRONTMATTER_SCHEMA.properties",
		)
		assert.ok(
			AGENT_AUTHORABLE_UNIT_FIELDS.includes("applicable_skills"),
			"applicable_skills must be in AGENT_AUTHORABLE_UNIT_FIELDS",
		)
	})

	console.log("\n=== applicable_skills in hat prompt ===")

	await testAsync(
		"start_unit prompt file includes skills section when unit has applicable_skills",
		async () => {
			// Create a project with a custom studio (avoids needing plugin root for STAGE.md)
			const studio = "software"
			const stage = "inception"
			const slug = "skill-test-intent"

			const intentDir = join(
				projDir,
				".haiku",
				"intents",
				slug,
			)
			const stageDir = join(intentDir, "stages", stage)
			const unitsDir = join(stageDir, "units")
			mkdirSync(unitsDir, { recursive: true })

			writeFileSync(
				join(intentDir, "intent.md"),
				`---
title: Skill Test Intent
studio: ${studio}
mode: continuous
active_stage: ${stage}
status: active
started_at: 2026-01-01T00:00:00Z
completed_at: null
---

Test intent for skill injection.
`,
			)

			writeFileSync(
				join(stageDir, "state.json"),
				JSON.stringify({
					stage,
					status: "active",
					phase: "execute",
					started_at: "2026-01-01T00:01:00Z",
					completed_at: null,
					gate_entered_at: null,
					gate_outcome: null,
				}),
			)

			// Write a unit with applicable_skills in frontmatter
			writeFileSync(
				join(unitsDir, "unit-01-write-tests.md"),
				`---
title: Write Tests
type: task
status: pending
depends_on: []
bolt: 1
hat: builder
applicable_skills:
  - test
  - refactor
---

Write comprehensive tests for the feature.
`,
			)

			const { default: startUnitBuilder } = await import(
				"../src/orchestrator/prompts/start_unit.ts"
			)

			const ctx = {
				slug,
				studio,
				action: {
					action: "continue_unit",
					stage,
					unit: "unit-01-write-tests",
					hat: "builder",
					hats: ["planner", "builder", "verifier"],
					bolt: 1,
				},
				dir: intentDir,
			}

			const result = startUnitBuilder(ctx)
			assert.ok(
				typeof result === "string" && result.length > 0,
				"Builder should return a non-empty string",
			)

			// The prompt body is written to a tmpfile; parse the path from the block.
			const promptFilePath = extractPromptFilePath(result)
			assert.ok(
				promptFilePath !== null,
				"Expected prompt_file attribute in subagent dispatch block",
			)
			assert.ok(
				existsSync(promptFilePath),
				`Expected prompt file to exist at: ${promptFilePath}`,
			)

			const promptBody = readFileSync(promptFilePath, "utf8")
			assert.ok(
				promptBody.includes("## Skills available"),
				"Expected '## Skills available' section in prompt file",
			)
			assert.ok(
				promptBody.includes("/test"),
				"Expected /test skill to appear in prompt file",
			)
			assert.ok(
				promptBody.includes("/refactor"),
				"Expected /refactor skill to appear in prompt file",
			)
			assert.ok(
				promptBody.includes("Write tests for code using TDD principles"),
				"Expected test skill description to appear in prompt file",
			)
		},
	)

	await testAsync(
		"start_unit prompt file omits skills section when unit has no applicable_skills",
		async () => {
			const studio = "software"
			const stage = "inception"
			const slug = "no-skills-intent"

			const intentDir = join(projDir, ".haiku", "intents", slug)
			const unitsDir = join(intentDir, "stages", stage, "units")
			mkdirSync(unitsDir, { recursive: true })

			writeFileSync(
				join(intentDir, "intent.md"),
				`---
title: No Skills Intent
studio: ${studio}
mode: continuous
active_stage: ${stage}
status: active
started_at: 2026-01-01T00:00:00Z
completed_at: null
---

Test intent without applicable_skills.
`,
			)

			writeFileSync(
				join(intentDir, "stages", stage, "state.json"),
				JSON.stringify({
					stage,
					status: "active",
					phase: "execute",
					started_at: "2026-01-01T00:01:00Z",
					completed_at: null,
					gate_entered_at: null,
					gate_outcome: null,
				}),
			)

			writeFileSync(
				join(unitsDir, "unit-01-basic.md"),
				`---
title: Basic Unit
type: task
status: pending
depends_on: []
bolt: 1
hat: builder
---

A unit without skill annotations.
`,
			)

			const { default: startUnitBuilder } = await import(
				"../src/orchestrator/prompts/start_unit.ts"
			)

			const ctx = {
				slug,
				studio,
				action: {
					action: "continue_unit",
					stage,
					unit: "unit-01-basic",
					hat: "builder",
					hats: ["planner", "builder", "verifier"],
					bolt: 1,
				},
				dir: intentDir,
			}

			const result = startUnitBuilder(ctx)
			assert.ok(
				typeof result === "string" && result.length > 0,
				"Builder should return a non-empty string",
			)

			// Read the prompt file to check its contents
			const promptFilePath = extractPromptFilePath(result)
			if (promptFilePath && existsSync(promptFilePath)) {
				const promptBody = readFileSync(promptFilePath, "utf8")
				assert.ok(
					!promptBody.includes("## Skills available"),
					"Expected no 'Skills available' section when unit has no applicable_skills",
				)
			} else {
				// If no prompt_file (non-subagent harness), check the result directly
				assert.ok(
					!result.includes("## Skills available"),
					"Expected no 'Skills available' section when unit has no applicable_skills",
				)
			}
		},
	)

	// ── Summary ────────────────────────────────────────────────────────────────

	console.log(`\n${passed} passed, ${failed} failed\n`)
} finally {
	process.chdir(origCwd)
	rmSync(tmp, { recursive: true })
	process.exit(failed > 0 ? 1 : 0)
}
