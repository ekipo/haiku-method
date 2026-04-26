// git/derived-worktrees.ts — Discovery + fix-chain worktrees.
//
// Both subsystems are nearly mirror images of each other: they fork a
// dedicated branch off the stage (or intent main, for studio-level fix
// loops), let a subagent work in isolation, then merge back with the
// same conflict-handling contract used by the integrator dispatch.
// Grouping them keeps the merge protocol in one place and makes it
// obvious where to look when the integrator needs a third worktree
// type with the same pattern.

import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import {
	branchExists,
	ensureStageBranch,
	getCurrentBranch,
} from "../git-worktree.js"
import { isGitRepo } from "../state/shared.js"
import { run, tryRun, withTempWorktree } from "./internal.js"

// ── Discovery worktrees ────────────────────────────────────────────────────

/** Path to a discovery subagent's isolation worktree. */
export function discoveryWorktreePath(
	slug: string,
	stage: string,
	template: string,
): string {
	return join(
		process.cwd(),
		".haiku",
		"worktrees",
		slug,
		`discovery-${stage}-${template}`,
	)
}

/** Branch name for a discovery subagent's isolation worktree. */
export function discoveryBranchName(
	slug: string,
	stage: string,
	template: string,
): string {
	return `haiku/${slug}/discovery-${stage}-${template}`
}

/**
 * Create a discovery worktree off the stage branch. Idempotent: returns
 * the existing path if already allocated. No-op (null) in non-git mode.
 */
export function createDiscoveryWorktree(
	slug: string,
	stage: string,
	template: string,
): string | null {
	if (!isGitRepo()) return null
	if (!stage || !template)
		throw new Error("createDiscoveryWorktree requires `stage` and `template`")

	const baseBranch = ensureStageBranch(slug, stage)
	const discBranch = discoveryBranchName(slug, stage, template)
	const worktreePath = discoveryWorktreePath(slug, stage, template)
	const worktreeBase = join(process.cwd(), ".haiku", "worktrees", slug)

	try {
		if (existsSync(worktreePath)) return worktreePath
		mkdirSync(worktreeBase, { recursive: true })
		if (!branchExists(discBranch)) {
			tryRun(["git", "branch", discBranch, baseBranch])
		}
		run(["git", "worktree", "add", worktreePath, discBranch])
		return worktreePath
	} catch {
		return null
	}
}

/**
 * Merge a discovery worktree back into the stage branch. Same
 * conflict-handling contract as `mergeFixChainWorktree` — on MERGE_HEAD
 * with unresolved markers, returns `{isConflict: true, conflictFiles}`
 * so the caller can dispatch the integrator.
 */
export function mergeDiscoveryWorktree(
	slug: string,
	stage: string,
	template: string,
): {
	success: boolean
	message: string
	isConflict?: boolean
	conflictFiles?: string[]
} {
	if (!isGitRepo()) return { success: true, message: "no worktree" }
	const baseBranch = ensureStageBranch(slug, stage)
	const discBranch = discoveryBranchName(slug, stage, template)
	const worktreePath = discoveryWorktreePath(slug, stage, template)

	if (!existsSync(worktreePath)) {
		if (branchExists(discBranch)) tryRun(["git", "branch", "-D", discBranch])
		return { success: true, message: "no worktree" }
	}

	const mergeInProgress = !!tryRun([
		"git",
		"-C",
		worktreePath,
		"rev-parse",
		"--verify",
		"-q",
		"MERGE_HEAD",
	])
	const unresolved = tryRun([
		"git",
		"-C",
		worktreePath,
		"diff",
		"--name-only",
		"--diff-filter=U",
	])
		.split("\n")
		.filter(Boolean)
	if (unresolved.length > 0) {
		return {
			success: false,
			isConflict: true,
			conflictFiles: unresolved,
			message: `${unresolved.length} file(s) with unresolved conflict markers in discovery worktree ${template} — integrator work incomplete`,
		}
	}

	try {
		if (mergeInProgress) {
			tryRun(["git", "-C", worktreePath, "add", "-A"])
			run([
				"git",
				"-C",
				worktreePath,
				"commit",
				"--no-edit",
				"-m",
				`haiku: integrate ${stage} into discovery ${template}`,
			])
		} else {
			tryRun(["git", "-C", worktreePath, "add", "-A"])
			tryRun([
				"git",
				"-C",
				worktreePath,
				"commit",
				"-m",
				`haiku: complete discovery ${template}`,
				"--allow-empty",
			])

			try {
				run([
					"git",
					"-C",
					worktreePath,
					"merge",
					baseBranch,
					"--no-edit",
					"-m",
					`haiku: sync ${stage} into discovery ${template}`,
				])
			} catch (mergeErr) {
				const freshConflicts = tryRun([
					"git",
					"-C",
					worktreePath,
					"diff",
					"--name-only",
					"--diff-filter=U",
				])
					.split("\n")
					.filter(Boolean)
				if (freshConflicts.length > 0) {
					return {
						success: false,
						isConflict: true,
						conflictFiles: freshConflicts,
						message: `merge conflict in ${freshConflicts.length} file(s) while pulling ${baseBranch} into discovery ${template}`,
					}
				}
				tryRun(["git", "-C", worktreePath, "merge", "--abort"])
				throw mergeErr
			}
		}

		const onBaseBranch = getCurrentBranch() === baseBranch
		const mergeHere = (cwd?: string) => {
			run([
				"git",
				...(cwd ? ["-C", cwd] : []),
				"merge",
				discBranch,
				"--no-edit",
				"-m",
				`haiku: merge discovery ${template} into ${stage}`,
			])
		}
		if (onBaseBranch) {
			mergeHere()
		} else {
			withTempWorktree(baseBranch, (tmpPath) => mergeHere(tmpPath))
		}

		tryRun(["git", "worktree", "remove", worktreePath, "--force"])
		tryRun(["git", "branch", "-D", discBranch])

		return {
			success: true,
			message: `merged ${discBranch} → ${baseBranch}`,
		}
	} catch (err) {
		return {
			success: false,
			message: err instanceof Error ? err.message : String(err),
		}
	}
}

/** Discard a discovery worktree without merging. */
export function cleanupDiscoveryWorktree(
	slug: string,
	stage: string,
	template: string,
): { success: boolean; message: string } {
	if (!isGitRepo()) return { success: true, message: "no git" }
	const discBranch = discoveryBranchName(slug, stage, template)
	const worktreePath = discoveryWorktreePath(slug, stage, template)
	if (existsSync(worktreePath)) {
		tryRun(["git", "worktree", "remove", worktreePath, "--force"])
	}
	if (branchExists(discBranch)) {
		tryRun(["git", "branch", "-D", discBranch])
	}
	return { success: true, message: `cleaned up ${discBranch}` }
}

// ── Fix-chain worktrees ───────────────────────────────────────────────────

/** Path to a fix-chain worktree. `scope` is either a stage name (for
 *  `review_fix`) or `"intent"` (for studio-level `intent_completion_fix`). */
export function fixChainWorktreePath(
	slug: string,
	scope: string,
	feedbackId: string,
): string {
	return join(
		process.cwd(),
		".haiku",
		"worktrees",
		slug,
		`fix-${scope}-${feedbackId}`,
	)
}

/** Branch name for a fix-chain worktree. */
export function fixChainBranchName(
	slug: string,
	scope: string,
	feedbackId: string,
): string {
	return `haiku/${slug}/fix-${scope}-${feedbackId}`
}

/**
 * Create a fix-chain worktree off the stage branch (or intent main for
 * studio-level intent-completion fix loops). Idempotent: returns the
 * existing path if the worktree already exists for this chain.
 *
 * `scope` is either a stage name (for `review_fix`) or `"intent"` (for
 * `intent_completion_fix`). The resulting branch is
 * `haiku/{slug}/fix-{scope}-{FB-NN}`, forked from the base branch at the
 * moment of creation. Subsequent bolts that reuse the same feedback ID
 * pick up the existing branch unless the prior bolt cleaned it up.
 *
 * No-op in non-git environments (returns null) — filesystem mode has no
 * branches/worktrees to isolate; parallel fix-chain subagents run
 * directly in the current working tree, same as today.
 */
export function createFixChainWorktree(
	slug: string,
	scope: string,
	feedbackId: string,
): string | null {
	if (!isGitRepo()) return null
	if (!scope)
		throw new Error(
			"createFixChainWorktree requires `scope` — stage name or 'intent'",
		)
	if (!feedbackId)
		throw new Error(
			"createFixChainWorktree requires `feedbackId` — the FB-NN of the chain",
		)

	const baseBranch =
		scope === "intent" ? `haiku/${slug}/main` : ensureStageBranch(slug, scope)
	const fixBranch = fixChainBranchName(slug, scope, feedbackId)
	const worktreePath = fixChainWorktreePath(slug, scope, feedbackId)
	const worktreeBase = join(process.cwd(), ".haiku", "worktrees", slug)

	try {
		if (existsSync(worktreePath)) return worktreePath
		mkdirSync(worktreeBase, { recursive: true })
		if (!branchExists(fixBranch)) {
			tryRun(["git", "branch", fixBranch, baseBranch])
		}
		run(["git", "worktree", "add", worktreePath, fixBranch])
		return worktreePath
	} catch {
		return null
	}
}

/**
 * Merge a fix-chain's branch into its base (stage branch for `review_fix`,
 * intent main for `intent_completion_fix`). Called when the chain's final
 * hat has signed off.
 *
 * Caller must ensure no subagent is still running in the worktree —
 * this function commits and removes the tree.
 */
export function mergeFixChainWorktree(
	slug: string,
	scope: string,
	feedbackId: string,
): {
	success: boolean
	message: string
	/** True when the merge failed specifically due to content conflicts an
	 *  integrator agent should resolve. */
	isConflict?: boolean
	/** Paths (repo-relative) with unresolved conflict markers. Populated
	 *  only when isConflict is true. */
	conflictFiles?: string[]
} {
	if (!isGitRepo()) return { success: true, message: "no worktree" }
	const baseBranch =
		scope === "intent" ? `haiku/${slug}/main` : ensureStageBranch(slug, scope)
	const fixBranch = fixChainBranchName(slug, scope, feedbackId)
	const worktreePath = fixChainWorktreePath(slug, scope, feedbackId)

	if (!existsSync(worktreePath)) {
		if (branchExists(fixBranch)) tryRun(["git", "branch", "-D", fixBranch])
		return { success: true, message: "no worktree" }
	}

	const mergeInProgress = !!tryRun([
		"git",
		"-C",
		worktreePath,
		"rev-parse",
		"--verify",
		"-q",
		"MERGE_HEAD",
	])
	const unresolved = tryRun([
		"git",
		"-C",
		worktreePath,
		"diff",
		"--name-only",
		"--diff-filter=U",
	])
		.split("\n")
		.filter(Boolean)
	if (unresolved.length > 0) {
		return {
			success: false,
			isConflict: true,
			conflictFiles: unresolved,
			message: `${unresolved.length} file(s) with unresolved conflict markers in fix-chain ${feedbackId} — integrator work incomplete`,
		}
	}

	try {
		if (mergeInProgress) {
			tryRun(["git", "-C", worktreePath, "add", "-A"])
			run([
				"git",
				"-C",
				worktreePath,
				"commit",
				"--no-edit",
				"-m",
				`haiku: integrate ${scope} into fix-chain ${feedbackId}`,
			])
		} else {
			tryRun(["git", "-C", worktreePath, "add", "-A"])
			tryRun([
				"git",
				"-C",
				worktreePath,
				"commit",
				"-m",
				`haiku: complete fix-chain ${feedbackId}`,
				"--allow-empty",
			])

			try {
				run([
					"git",
					"-C",
					worktreePath,
					"merge",
					baseBranch,
					"--no-edit",
					"-m",
					`haiku: sync ${scope} into fix-chain ${feedbackId}`,
				])
			} catch (mergeErr) {
				const freshConflicts = tryRun([
					"git",
					"-C",
					worktreePath,
					"diff",
					"--name-only",
					"--diff-filter=U",
				])
					.split("\n")
					.filter(Boolean)
				if (freshConflicts.length > 0) {
					return {
						success: false,
						isConflict: true,
						conflictFiles: freshConflicts,
						message: `merge conflict in ${freshConflicts.length} file(s) while pulling ${baseBranch} into fix-chain ${feedbackId}`,
					}
				}
				tryRun(["git", "-C", worktreePath, "merge", "--abort"])
				throw mergeErr
			}
		}

		const onBaseBranch = getCurrentBranch() === baseBranch
		const mergeHere = (cwd?: string) => {
			run([
				"git",
				...(cwd ? ["-C", cwd] : []),
				"merge",
				fixBranch,
				"--no-edit",
				"-m",
				`haiku: merge fix-chain ${feedbackId} into ${scope}`,
			])
		}
		if (onBaseBranch) {
			mergeHere()
		} else {
			withTempWorktree(baseBranch, (tmpPath) => mergeHere(tmpPath))
		}

		tryRun(["git", "worktree", "remove", worktreePath, "--force"])
		tryRun(["git", "branch", "-D", fixBranch])

		return {
			success: true,
			message: `merged ${fixBranch} → ${baseBranch}`,
		}
	} catch (err) {
		return {
			success: false,
			message: err instanceof Error ? err.message : String(err),
		}
	}
}

/**
 * Discard a fix-chain's worktree and branch without merging. Used when:
 *   - the feedback-assessor didn't close the finding (next bolt starts fresh)
 *   - the fix loop hit the bolt cap and escalated
 *   - a chain produced nothing useful and should be reaped before retry
 *
 * No-op if the worktree doesn't exist. Best-effort — never throws.
 */
export function cleanupFixChainWorktree(
	slug: string,
	scope: string,
	feedbackId: string,
): { success: boolean; message: string } {
	if (!isGitRepo()) return { success: true, message: "no git" }
	const fixBranch = fixChainBranchName(slug, scope, feedbackId)
	const worktreePath = fixChainWorktreePath(slug, scope, feedbackId)

	if (existsSync(worktreePath)) {
		tryRun(["git", "worktree", "remove", worktreePath, "--force"])
	}
	if (branchExists(fixBranch)) {
		tryRun(["git", "branch", "-D", fixBranch])
	}
	return {
		success: true,
		message: `cleaned up ${fixBranch}`,
	}
}
