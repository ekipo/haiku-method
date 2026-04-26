// state/scope.ts — Unit-scope validation + output auto-population.
//
// At unit completion the FSM checks whether the agent's writes stayed
// within the stage's declared scope (output templates + always-allowed
// FSM metadata). Same module also auto-populates the unit's outputs[]
// list from the diff so the unit spec stays a faithful record of what
// landed.

import { execSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import matter from "gray-matter"
import { readStageArtifactDefs } from "../studio-reader.js"
import {
	findHaikuRoot,
	intentDir,
	isGitRepo,
	matchesGlob,
	parseFrontmatter,
	unitPath,
} from "./shared.js"

/**
 * Resolve the intent dir for unit-produced artifact validation. Returns
 * the unit's worktree intent dir if the worktree exists on disk, else
 * the main intent dir. Used to validate unit-produced artifacts BEFORE
 * the worktree merges back to the parent branch — otherwise validation
 * runs against the parent's (still stale) copy and false-reports missing.
 */
export function unitIntentDir(slug: string, unit: string): string {
	const workTreePath = join(findHaikuRoot(), "worktrees", slug, unit)
	const workTreeIntentDir = join(workTreePath, ".haiku", "intents", slug)
	if (existsSync(workTreeIntentDir)) return workTreeIntentDir
	return intentDir(slug)
}

/**
 * Check if an intent-relative output path exists in either the unit's
 * worktree or the main intent dir. Returns true if present at EITHER
 * location.
 */
export function unitOutputExists(
	slug: string,
	unit: string,
	outputPath: string,
): boolean {
	const mainResolved = resolve(intentDir(slug), outputPath)
	if (existsSync(mainResolved)) return true
	const wtRoot = join(findHaikuRoot(), "worktrees", slug, unit)
	const wtIntentDir = join(wtRoot, ".haiku", "intents", slug)
	if (existsSync(wtIntentDir)) {
		const wtResolved = resolve(wtIntentDir, outputPath)
		if (existsSync(wtResolved)) return true
	}
	// Repo-relative: auto-populated outputs from `scope: repo` stages record
	// paths like `packages/foo/src/bar.ts`. Resolve against the repo root,
	// or the worktree root when running inside a unit worktree.
	const repoRoot = (() => {
		try {
			return execSync("git rev-parse --show-toplevel", {
				encoding: "utf8",
			}).trim()
		} catch {
			return null
		}
	})()
	if (repoRoot) {
		const repoResolved = resolve(repoRoot, outputPath)
		if (existsSync(repoResolved)) return true
	}
	if (existsSync(wtRoot)) {
		const wtRepoResolved = resolve(wtRoot, outputPath)
		if (existsSync(wtRepoResolved)) return true
	}
	return false
}

/**
 * List files changed in the unit's worktree since it forked from its
 * stage branch. Returns paths relative to the worktree root (intent
 * root). Git-only. Returns null if not in git mode or worktree missing.
 */
function getUnitWorktreeChanges(
	slug: string,
	unit: string,
	stage: string,
): string[] | null {
	if (!isGitRepo()) return null
	const unitBase = unit.replace(/\.md$/, "")
	const worktreePath = join(findHaikuRoot(), "worktrees", slug, unitBase)
	if (!existsSync(worktreePath)) return null
	try {
		const unitBranch = `haiku/${slug}/${unitBase}`
		const stageBranch = `haiku/${slug}/${stage}`
		const forkSha = execSync(`git merge-base ${unitBranch} ${stageBranch}`, {
			cwd: worktreePath,
			encoding: "utf8",
		})
			.toString()
			.trim()
		const lines = new Set<string>()
		const add = (s: string) => {
			for (const line of s.split("\n").map((l) => l.trim())) {
				if (line) lines.add(line)
			}
		}
		add(
			execSync(`git diff --name-only ${forkSha}..HEAD`, {
				cwd: worktreePath,
				encoding: "utf8",
			}).toString(),
		)
		add(
			execSync("git diff --name-only HEAD", {
				cwd: worktreePath,
				encoding: "utf8",
			}).toString(),
		)
		add(
			execSync("git diff --name-only --cached", {
				cwd: worktreePath,
				encoding: "utf8",
			}).toString(),
		)
		add(
			execSync("git ls-files --others --exclude-standard", {
				cwd: worktreePath,
				encoding: "utf8",
			}).toString(),
		)
		return [...lines]
	} catch {
		return null
	}
}

/**
 * Compute the allowed write scope for a stage. Derives from:
 *   - Stage output templates' `location:` fields (with `scope:` intent|repo)
 *   - Stage discovery templates' `location:` fields (for pre-execute hats)
 *   - Always-allowed FSM metadata paths
 */
function computeStageScope(
	slug: string,
	studio: string,
	stage: string,
	unit: string,
): { intentGlobs: string[]; repoGlobs: string[]; repoWildcard: boolean } {
	const unitBase = unit.replace(/\.md$/, "")
	const intentGlobs: string[] = [
		`stages/${stage}/units/${unitBase}.md`,
		`stages/${stage}/state.json`,
		`stages/${stage}/iteration.json`,
		`stages/${stage}/feedback/**`,
		`stages/${stage}/artifacts/**`,
		`stages/${stage}/outputs/**`,
		`stages/${stage}/discovery/**`,
		"state/**",
		".integrity.json",
		"knowledge/**",
	]
	const repoGlobs: string[] = []
	let repoWildcard = false

	const defs = readStageArtifactDefs(studio, stage)

	for (const def of defs) {
		const loc = (def.location || "").trim()
		const declaredScope = def.scope || "intent"
		if (!loc) {
			if (declaredScope === "repo") repoWildcard = true
			continue
		}
		if (loc.startsWith("(") && loc.endsWith(")")) {
			if (declaredScope === "repo") repoWildcard = true
			continue
		}
		const expanded = loc
			.replace(/\{intent-slug\}/g, slug)
			.replace(/\{stage\}/g, stage)
		if (declaredScope === "repo") {
			repoGlobs.push(expanded)
		} else {
			const prefix = `.haiku/intents/${slug}/`
			const stripped = expanded.startsWith(prefix)
				? expanded.slice(prefix.length)
				: expanded
			intentGlobs.push(stripped)
		}
	}
	return { intentGlobs, repoGlobs, repoWildcard }
}

/**
 * List changed files for this unit since its worktree forked from the
 * stage branch. Returns null if we can't determine the diff reliably.
 *
 * Scope enforcement is a GIT-mode feature. Filesystem-mode (no git) falls
 * through to no changes — mtime is too noisy a heuristic in practice.
 */
function getUnitChanges(
	slug: string,
	stage: string,
	unit: string,
	_hatStartedAt: string | undefined,
): string[] {
	const gitChanged = getUnitWorktreeChanges(slug, unit, stage)
	if (gitChanged !== null) return gitChanged
	return []
}

/**
 * Classify a changed-file path against the stage's scope. Returns true
 * if the path is allowed, false if it's a scope violation.
 */
function pathInStageScope(
	file: string,
	slug: string,
	scope: { intentGlobs: string[]; repoGlobs: string[]; repoWildcard: boolean },
	gitMode: boolean,
): boolean {
	const intentPrefix = `.haiku/intents/${slug}/`
	const intentRel = gitMode
		? file.startsWith(intentPrefix)
			? file.slice(intentPrefix.length)
			: null
		: file

	if (intentRel !== null) {
		if (scope.intentGlobs.some((g) => matchesGlob(intentRel, g))) return true
	}
	if (gitMode && intentRel === null) {
		if (scope.repoWildcard) return true
		if (scope.repoGlobs.some((g) => matchesGlob(file, g))) return true
	}
	return false
}

/**
 * Auto-track writes into unit.outputs[]. Called at advance_hat to record
 * what the unit actually wrote. Harness-agnostic replacement for the CC
 * track-outputs PostToolUse hook (which keeps working for real-time CC
 * tracking but isn't required).
 */
function autoPopulateOutputs(
	slug: string,
	stage: string,
	unit: string,
	changed: string[],
): void {
	if (changed.length === 0) return
	const spec = unitPath(slug, stage, unit)
	if (!existsSync(spec)) return
	const raw = readFileSync(spec, "utf8")
	const { data, content } = matter(raw)
	const existing = new Set<string>(
		((data.outputs as string[]) || []).map((o) => o),
	)
	const unitBase = unit.replace(/\.md$/, "")
	const bookkeeping = new Set<string>([
		`stages/${stage}/units/${unitBase}.md`,
		`stages/${stage}/state.json`,
		`stages/${stage}/iteration.json`,
		".integrity.json",
	])
	const bookkeepingPrefixes = [`stages/${stage}/feedback/`, "state/"]
	const gitMode = isGitRepo()
	const intentPrefix = `.haiku/intents/${slug}/`
	const toAdd: string[] = []
	for (const file of changed) {
		const intentRel = gitMode
			? file.startsWith(intentPrefix)
				? file.slice(intentPrefix.length)
				: null
			: file
		if (intentRel !== null) {
			if (bookkeeping.has(intentRel)) continue
			if (bookkeepingPrefixes.some((p) => intentRel.startsWith(p))) continue
		}
		const record = intentRel ?? file
		if (existing.has(record)) continue
		existing.add(record)
		toAdd.push(record)
	}
	if (toAdd.length === 0) return
	const merged = [...((data.outputs as string[]) || []), ...toAdd]
	data.outputs = merged
	writeFileSync(spec, matter.stringify(content, data))
}

/**
 * Validate that the unit's writes stay within the stage's declared scope
 * (output templates + always-allowed FSM metadata). Called at unit
 * completion (last hat advance_hat) BEFORE the worktree merges back.
 *
 * Scope source of truth:
 *   - Stage's output templates' `location:` + `scope:` fields (intent|repo)
 *   - Templates with `scope: repo` and descriptive locations grant a
 *     repo-wide wildcard
 *   - Always-allowed FSM metadata (unit spec, state files, feedback dir,
 *     intent state dir, integrity, knowledge)
 *
 * Unit.outputs[] is AUTO-POPULATED from the diff as a side effect — no
 * CC hook dependency. The outputs list becomes a record of actual writes.
 *
 * Returns {violations, scope} if scope was violated, or null if OK.
 */
export function validateUnitScope(
	slug: string,
	studio: string,
	stage: string,
	unit: string,
): {
	violations: string[]
	scope: { intentGlobs: string[]; repoGlobs: string[]; repoWildcard: boolean }
} | null {
	const spec = unitPath(slug, stage, unit)
	if (!existsSync(spec)) return null
	const { data } = parseFrontmatter(readFileSync(spec, "utf8"))
	const hatStartedAt = data.hat_started_at as string | undefined

	const changed = getUnitChanges(slug, stage, unit, hatStartedAt)
	if (changed.length === 0) return null

	const scope = computeStageScope(slug, studio, stage, unit)
	const gitMode = isGitRepo()
	const violations: string[] = []
	for (const file of changed) {
		if (!pathInStageScope(file, slug, scope, gitMode)) {
			violations.push(file)
		}
	}

	// Only auto-populate outputs[] when scope is clean. Writing violating
	// paths into outputs[] would pollute the unit spec: after the agent
	// reverts the bad file, the unit would fail `unit_outputs_missing` on
	// the next advance for a path it never meant to record.
	if (violations.length > 0) {
		return { violations, scope }
	}
	autoPopulateOutputs(slug, stage, unit, changed)
	return null
}
