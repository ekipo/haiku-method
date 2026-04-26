// git/unit-worktrees.ts — Unit-scoped worktree lifecycle.
//
// A unit's worktree forks off the STAGE branch (always — never intent
// main), lives at `.haiku/worktrees/{slug}/{unit}`, and merges back
// into the stage branch when the unit completes. The merge is
// special-cased to auto-resolve the unit-md conflict (the FSM writes
// to the unit's own state file from the stage-branch side while the
// unit branch carries a frozen-at-fork copy — taking the stage side
// is correct because the unit worktree has no business mutating its
// own state file).

import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { isGitRepo } from "../state/shared.js"
import { getCurrentBranch } from "./branches.js"
import { run, tryRun, withTempWorktree } from "./internal.js"

/** Absolute path to a unit's worktree under
 *  `.haiku/worktrees/{slug}/{unit}`. */
export function unitWorktreePath(slug: string, unit: string): string {
	return join(process.cwd(), ".haiku", "worktrees", slug, unit)
}

/** Absolute path to the unit's spec file INSIDE its own worktree, so
 *  writes land in the scope that will be merged back. */
export function unitSpecInWorktree(
	slug: string,
	stage: string,
	unit: string,
): string {
	const wt = unitWorktreePath(slug, unit)
	const fname = unit.endsWith(".md") ? unit : `${unit}.md`
	return join(wt, ".haiku", "intents", slug, "stages", stage, "units", fname)
}

/**
 * Create a worktree for a unit, forked from the STAGE branch (always).
 * The caller must ensure the stage branch exists first (typically via
 * `ensureStageBranch`). The unit branch (`haiku/{slug}/{unit}`) is
 * created off the stage branch; a unit worktree is added at
 * `.haiku/worktrees/{slug}/{unit}`.
 *
 * Returns the absolute worktree path, or null when not in a git repo.
 */
export function createUnitWorktree(
	slug: string,
	unit: string,
	stageBranch: string,
): string | null {
	if (!isGitRepo()) return null
	if (!stageBranch)
		throw new Error(
			"createUnitWorktree requires `stageBranch` — units always fork from the stage branch",
		)
	const unitBranch = `haiku/${slug}/${unit}`
	const worktreeBase = join(process.cwd(), ".haiku", "worktrees", slug)
	const worktreePath = join(worktreeBase, unit)

	try {
		if (existsSync(worktreePath)) return worktreePath
		mkdirSync(worktreeBase, { recursive: true })
		tryRun(["git", "branch", unitBranch, stageBranch])
		run(["git", "worktree", "add", worktreePath, unitBranch])
		return worktreePath
	} catch {
		return null
	}
}

/**
 * Merge a unit's branch into its STAGE branch, using a temporary
 * worktree so the MCP's parent checkout is never touched. Cleans up the
 * unit worktree and the unit branch when done.
 *
 * Caller must ensure every state write for the unit has been flushed to
 * the unit worktree BEFORE calling this — we commit whatever is pending
 * in the unit worktree, then merge the unit branch into the stage
 * branch.
 *
 * No-op in non-git environments.
 */
export function mergeUnitWorktree(
	slug: string,
	unit: string,
	stage: string,
	stageBranch: string,
): { success: boolean; message: string } {
	if (!isGitRepo()) return { success: true, message: "no worktree" }
	if (!stageBranch)
		return {
			success: false,
			message:
				"mergeUnitWorktree requires `stageBranch` — units always merge into the stage branch",
		}
	const unitBranch = `haiku/${slug}/${unit}`
	const worktreePath = unitWorktreePath(slug, unit)

	if (!existsSync(worktreePath)) {
		return { success: true, message: "no worktree" }
	}

	try {
		// Commit any pending state writes in the unit worktree first.
		tryRun(["git", "-C", worktreePath, "add", "-A"])
		tryRun([
			"git",
			"-C",
			worktreePath,
			"commit",
			"-m",
			`haiku: complete ${unit}`,
			"--allow-empty",
		])

		// Merge strategy: if the MCP's current checkout is already on the
		// stage branch, merge directly here (temp-worktree would fail with
		// "branch already used by worktree"). Otherwise use a temp worktree
		// so we don't disturb whatever branch the user happens to be on.
		//
		// Conflict handling: the unit .md file under stages/<stage>/units/
		// routinely conflicts because the FSM writes iteration/hat state to
		// it from the stage-branch side while the unit branch carries a
		// frozen-at-fork copy. For those files only, take the stage side
		// (the live FSM state) — the unit worktree has no business mutating
		// its own state file. Non-unit-md conflicts still surface as real
		// conflicts the agent must resolve.
		const onStageBranch = getCurrentBranch() === stageBranch
		const mergeHere = (cwd?: string) => {
			const mergeArgs = [
				"git",
				...(cwd ? ["-C", cwd] : []),
				"merge",
				unitBranch,
				"--no-edit",
				"-m",
				`haiku: merge ${unit} into ${stage}`,
			]
			try {
				run(mergeArgs)
			} catch (err) {
				const unitMdRel = `.haiku/intents/${slug}/stages/${stage}/units/${unit}.md`
				const conflicts = tryRun([
					"git",
					...(cwd ? ["-C", cwd] : []),
					"diff",
					"--name-only",
					"--diff-filter=U",
				])
					.split("\n")
					.filter(Boolean)
				const nonUnitMd = conflicts.filter((p) => p !== unitMdRel)
				if (conflicts.length > 0 && nonUnitMd.length === 0) {
					run([
						"git",
						...(cwd ? ["-C", cwd] : []),
						"checkout",
						"--ours",
						unitMdRel,
					])
					run(["git", ...(cwd ? ["-C", cwd] : []), "add", unitMdRel])
					run(["git", ...(cwd ? ["-C", cwd] : []), "commit", "--no-edit"])
				} else {
					throw err
				}
			}
		}
		if (onStageBranch) {
			mergeHere()
		} else {
			withTempWorktree(stageBranch, (tmpPath) => mergeHere(tmpPath))
		}

		// Reap the unit worktree and local branch — its work is now on the
		// stage branch. Do NOT delete the remote unit branch here: if the
		// team opened a PR/MR against it for review, deletion would yank
		// the source out from under the review. Remote branch cleanup, if
		// desired, should happen at stage-complete (after fan-in) or be
		// driven by the review provider.
		tryRun(["git", "worktree", "remove", worktreePath, "--force"])
		tryRun(["git", "branch", "-D", unitBranch])

		return {
			success: true,
			message: `merged ${unitBranch} → ${stageBranch}`,
		}
	} catch (err) {
		return {
			success: false,
			message: err instanceof Error ? err.message : String(err),
		}
	}
}
