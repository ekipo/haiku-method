// state/frontmatter.ts — Frontmatter mutation + intent enumeration helpers.
//
// `parseFrontmatter` lives in shared.ts (it's needed by everything). This
// module owns the WRITE side: setting fields on intent.md / unit.md files,
// listing visible (non-archived) intents, and resolving the current intent
// from the git branch.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import matter from "gray-matter"
import { getCurrentBranch } from "../git-worktree.js"
import {
	findHaikuRoot,
	isGitRepo,
	normalizeDates,
	parseFrontmatter,
	unitPath,
} from "./shared.js"

/** Enumerate visible (non-archived) intents in a directory, returning both
 *  slug and parsed frontmatter data. Reuses parseFrontmatter so callers
 *  don't have to re-parse each intent.md for downstream work.
 *
 *  Set `opts.includeArchived` to true to return all intents (both archived
 *  and non-archived). */
export function listVisibleIntents(
	intentsDir: string,
	opts?: { includeArchived?: boolean },
): Array<{ slug: string; data: Record<string, unknown> }> {
	if (!existsSync(intentsDir)) return []
	const includeArchived = opts?.includeArchived === true
	const results: Array<{ slug: string; data: Record<string, unknown> }> = []
	for (const d of readdirSync(intentsDir)) {
		const intentFile = join(intentsDir, d, "intent.md")
		if (!existsSync(intentFile)) continue
		const { data } = parseFrontmatter(readFileSync(intentFile, "utf8"))
		if (!includeArchived && data.archived === true) continue
		results.push({ slug: d, data })
	}
	return results
}

export function listVisibleIntentSlugs(
	intentsDir: string,
	opts?: { includeArchived?: boolean },
): string[] {
	return listVisibleIntents(intentsDir, opts).map((i) => i.slug)
}

/**
 * Parse an intent slug (and optionally a stage) out of the current git
 * branch. Supports the two H·AI·K·U branch shapes:
 *
 *   haiku/<slug>/main
 *   haiku/<slug>/<stage>
 *
 * Returns null if the current checkout isn't on a haiku branch or the
 * environment isn't git-backed. Used by pickup/revisit/run_next to
 * auto-resolve the intent when the user's checkout already tells us
 * which intent they want to work on — keeps skills thin and the
 * logic centrally owned.
 */
export function intentFromCurrentBranch(): {
	slug: string
	stage: string | null
} | null {
	if (!isGitRepo()) return null
	const branch = getCurrentBranch()
	if (!branch) return null
	const match = branch.match(/^haiku\/([^/]+)\/([^/]+)$/)
	if (!match) return null
	const slug = match[1]
	const stagePart = match[2]
	return { slug, stage: stagePart === "main" ? null : stagePart }
}

export function setFrontmatterField(
	filePath: string,
	field: string,
	value: unknown,
): void {
	const raw = readFileSync(filePath, "utf8")
	const parsed = matter(raw)
	// Spread to avoid mutating gray-matter's returned data object in place —
	// in-place mutation can corrupt gray-matter's internal cache and cause
	// subsequent parseFrontmatter calls to return stale values.
	const updated = { ...parsed.data, [field]: value }
	writeFileSync(
		filePath,
		matter.stringify(
			parsed.content,
			normalizeDates(updated as Record<string, unknown>),
		),
	)
}

/** Write a unit frontmatter field to BOTH the parent worktree's copy AND
 *  the unit's dedicated worktree (if one exists). The dual write is what
 *  keeps the workflow engine's reads (parent) in sync with the merge commits produced
 *  by `mergeUnitWorktree` (unit worktree). Missing either side causes the
 *  status-drift bug where a unit completes in one view but appears active
 *  in the other. */
export function setUnitFrontmatterField(
	slug: string,
	stage: string,
	unit: string,
	field: string,
	value: unknown,
): void {
	const parentPath = unitPath(slug, stage, unit)
	if (existsSync(parentPath)) setFrontmatterField(parentPath, field, value)
	const worktreeBase = join(findHaikuRoot(), "worktrees", slug, unit)
	if (!existsSync(worktreeBase)) return
	const worktreeUnitPath = join(
		worktreeBase,
		".haiku",
		"intents",
		slug,
		"stages",
		stage,
		"units",
		unit.endsWith(".md") ? unit : `${unit}.md`,
	)
	if (existsSync(worktreeUnitPath)) {
		setFrontmatterField(worktreeUnitPath, field, value)
	}
}

export function parseYaml(raw: string): Record<string, unknown> {
	// Wrap raw YAML in frontmatter delimiters so gray-matter can parse it
	const { data } = matter(`---\n${raw}\n---\n`)
	return normalizeDates(data as Record<string, unknown>)
}

export function getNestedField(
	obj: Record<string, unknown>,
	path: string,
): unknown {
	const parts = path.split(".")
	let current: unknown = obj
	for (const part of parts) {
		if (current == null || typeof current !== "object") return undefined
		current = (current as Record<string, unknown>)[part]
	}
	return current
}
