// git/lifecycle.ts — Intent-completion + revisit branch lifecycle.
//
// Cleanup (orphan stage branches, intent worktree dirs), branch
// deletion (with the safety guards that keep us from deleting our
// own checkout), intent-completion finalization (merge → main →
// delete every stage branch), and revisit preparation (merge main
// AND fromStage forward into targetStage so unapproved future-stage
// work survives a go-back).

import { rmSync } from "node:fs"
import { join } from "node:path"
import { isGitRepo } from "../state/shared.js"
import {
	branchExists,
	getCurrentBranch,
	isBranchMerged,
} from "./branches.js"
import { run, tryRun } from "./internal.js"

/**
 * Sweep merged stage branches (`haiku/<slug>/<stage>`) — both local
 * and remote — leaving the intent main branch untouched. Run this
 * after a stage completes, so orphan stage branches never accumulate.
 *
 * Returns the list of deleted branches. Safe to call when no orphans
 * exist — it's a no-op. Non-fatal on individual delete failures.
 */
export function cleanupOrphanedStageBranches(slug: string): {
	deleted_local: string[]
	deleted_remote: string[]
} {
	const result = {
		deleted_local: [] as string[],
		deleted_remote: [] as string[],
	}
	if (!isGitRepo()) return result
	const mainBranch = `haiku/${slug}/main`
	if (!branchExists(mainBranch)) return result

	// Local pass
	const local = tryRun([
		"git",
		"for-each-ref",
		"--format=%(refname:short)",
		`refs/heads/haiku/${slug}`,
	])
	for (const line of local.split("\n").filter(Boolean)) {
		// Skip main + unit-* branches; only touch stage branches.
		if (line === mainBranch) continue
		const segment = line.slice(`haiku/${slug}/`.length)
		if (segment.startsWith("unit-")) continue
		if (!isBranchMerged(line, mainBranch)) continue
		if (tryRun(["git", "branch", "-D", line])) {
			result.deleted_local.push(line)
		} else {
			// branch -D can fail if the branch is checked out in another
			// worktree; record and continue.
			result.deleted_local.push(line)
		}
	}

	// Remote pass — best-effort. We don't fetch first (caller decides).
	const remote = tryRun([
		"git",
		"for-each-ref",
		"--format=%(refname:short)",
		`refs/remotes/origin/haiku/${slug}`,
	])
	for (const line of remote.split("\n").filter(Boolean)) {
		const stripped = line.startsWith("origin/")
			? line.slice("origin/".length)
			: line
		if (stripped === mainBranch) continue
		const segment = stripped.slice(`haiku/${slug}/`.length)
		if (segment.startsWith("unit-")) continue
		if (!isBranchMerged(stripped, mainBranch)) continue
		// git push origin --delete is destructive; wrap in tryRun so a
		// permission or network issue doesn't crash the workflow engine.
		if (tryRun(["git", "push", "origin", "--delete", stripped])) {
			result.deleted_remote.push(stripped)
		}
	}

	return result
}

/** Clean up all worktrees for an intent. */
export function cleanupIntentWorktrees(slug: string): void {
	const worktreeBase = join(process.cwd(), ".haiku", "worktrees", slug)
	try {
		rmSync(worktreeBase, { recursive: true, force: true })
	} catch {
		/* non-fatal */
	}
	tryRun(["git", "worktree", "prune"])
}

/**
 * Delete a local branch. Non-fatal. Will not delete the branch you are
 * currently on (caller must checkout something else first). Force-delete
 * is used so already-merged-via-squash branches can still be reaped.
 */
export function deleteBranch(branch: string): boolean {
	if (!isGitRepo()) return false
	if (getCurrentBranch() === branch) return false
	if (!branchExists(branch)) return false
	return tryRun(["git", "branch", "-D", branch]) !== ""
}

/**
 * Delete a stage branch (`haiku/{slug}/{stage}`) and any worktrees
 * backing it. Also prunes the worktree registry so the branch is
 * actually removable. Non-fatal — never throws.
 */
export function deleteStageBranch(slug: string, stage: string): boolean {
	if (!isGitRepo()) return false
	if (stage === "main") return false
	const branch = `haiku/${slug}/${stage}`
	// Any unit worktrees tied to this stage should already be removed by
	// mergeUnitWorktree, but prune defensively so branch -D succeeds.
	tryRun(["git", "worktree", "prune"])
	return deleteBranch(branch)
}

/**
 * Finalize an intent's branches when the intent completes:
 *   1. Merge any unmerged stage branches forward into `haiku/{slug}/main`
 *      (handles the final stage which workflowStartStage never got to consolidate).
 *   2. Checkout `haiku/{slug}/main` so the user lands on the intent hub.
 *   3. Delete every merged `haiku/{slug}/{stage}` branch.
 *   4. Prune worktrees.
 *
 * The merge step delegates to `mergeStageBranchIntoMain` which lives in
 * the main git-worktree module — passed in as a callback to avoid a
 * circular import.
 *
 * No-op in non-git environments.
 */
export function finalizeIntentBranches(
	slug: string,
	stages: string[],
	mergeStageBranchIntoMain: (
		slug: string,
		stage: string,
	) => { success: boolean; message: string },
): { success: boolean; merged: string[]; deleted: string[]; message: string } {
	const mainBranch = `haiku/${slug}/main`
	if (!isGitRepo())
		return { success: true, merged: [], deleted: [], message: "no git" }
	if (!branchExists(mainBranch))
		return {
			success: true,
			merged: [],
			deleted: [],
			message: `no intent main branch (${mainBranch})`,
		}

	const merged: string[] = []
	const deleted: string[] = []

	// 1. Merge any unmerged stage branches into intent main, in stage order.
	for (const stage of stages) {
		const stageBranch = `haiku/${slug}/${stage}`
		if (!branchExists(stageBranch)) continue
		if (isBranchMerged(stageBranch, mainBranch)) continue
		const res = mergeStageBranchIntoMain(slug, stage)
		if (!res.success) {
			return {
				success: false,
				merged,
				deleted,
				message: `merge of '${stage}' into main failed: ${res.message}`,
			}
		}
		merged.push(stageBranch)
	}

	// 2. Make sure we end up on intent main.
	if (getCurrentBranch() !== mainBranch) {
		try {
			run(["git", "checkout", mainBranch])
		} catch (err) {
			return {
				success: false,
				merged,
				deleted,
				message: `checkout ${mainBranch} failed: ${err instanceof Error ? err.message : String(err)}`,
			}
		}
	}

	// 3. Delete every merged stage branch.
	for (const stage of stages) {
		const stageBranch = `haiku/${slug}/${stage}`
		if (!branchExists(stageBranch)) continue
		if (!isBranchMerged(stageBranch, mainBranch)) continue
		if (deleteBranch(stageBranch)) deleted.push(stageBranch)
	}

	// 4. Prune any lingering worktree entries.
	tryRun(["git", "worktree", "prune"])

	return {
		success: true,
		merged,
		deleted,
		message: `finalized ${slug}: merged ${merged.length}, deleted ${deleted.length}`,
	}
}

/**
 * Prepare the target stage branch for a go-back revisit.
 *
 * Per workflow contract: on revisit from fromStage → targetStage, the target
 * stage merges in BOTH intent main (approved upstream changes) AND the
 * fromStage branch (unapproved future work — feedback files, in-flight
 * artifacts, state notes). This ensures feedback and artifacts from the
 * stage we are currently on survive the revisit even when those changes
 * haven't been merged into intent main yet.
 *
 * Non-destructive: never deletes branches. All commits on fromStage and
 * targetStage are preserved. Unit state reset (re-queueing to pending)
 * is the caller's responsibility and happens in a separate step via the
 * workflow state-writing code path.
 *
 * No-op in non-git environments.
 */
export function prepareRevisitBranch(
	slug: string,
	fromStage: string,
	targetStage: string,
): { success: boolean; message: string } {
	if (!isGitRepo()) return { success: true, message: "no git" }
	if (targetStage === "main")
		return { success: false, message: "cannot revisit 'main'" }

	const targetBranch = `haiku/${slug}/${targetStage}`
	const fromBranch = fromStage ? `haiku/${slug}/${fromStage}` : ""
	const mainBranch = `haiku/${slug}/main`

	// If main doesn't exist yet there's nothing to merge. Caller (e.g. a
	// revisit invoked before the intent has been branched, or a test harness
	// running without real git state) should treat this as a no-op rather
	// than a hard failure.
	if (!branchExists(mainBranch))
		return {
			success: true,
			message: `${mainBranch} does not exist — nothing to merge`,
		}

	// List conflicted files by reading git's unmerged index entries (code U*/AA/DD).
	function listConflicts(): string[] {
		const status = tryRun(["git", "status", "--porcelain"])
		if (!status) return []
		return status
			.split("\n")
			.filter(
				(l) =>
					l.startsWith("UU ") ||
					l.startsWith("AA ") ||
					l.startsWith("DD ") ||
					l.startsWith("AU ") ||
					l.startsWith("UA ") ||
					l.startsWith("DU ") ||
					l.startsWith("UD "),
			)
			.map((l) => l.slice(3).trim())
	}

	try {
		// 1. Ensure target branch exists — fork from main if missing.
		if (!branchExists(targetBranch)) {
			run(["git", "branch", targetBranch, mainBranch])
		}

		// 2. Switch to target branch so merges land there.
		if (getCurrentBranch() !== targetBranch) {
			run(["git", "checkout", targetBranch])
		}

		// 3. Merge main → target (approved upstream changes). On conflict,
		//    leave the repo in the merging state so the agent can resolve
		//    files and commit, then retry the revisit (idempotent — a clean
		//    retry will see main as already merged and skip).
		const mainAhead = tryRun([
			"git",
			"rev-list",
			"--count",
			`${targetBranch}..${mainBranch}`,
		])
		if (mainAhead && Number.parseInt(mainAhead, 10) > 0) {
			try {
				run([
					"git",
					"merge",
					mainBranch,
					"--no-edit",
					"-m",
					`haiku: merge main → ${targetStage} (revisit prep)`,
				])
			} catch (mergeErr) {
				const conflicts = listConflicts()
				return {
					success: false,
					message:
						conflicts.length > 0
							? `Merge main → ${targetStage} left ${conflicts.length} conflicted file(s): ${conflicts.join(", ")}. Resolve conflicts on branch '${targetBranch}' (edit files, \`git add\`, \`git commit\`), then retry the revisit — the workflow engine will detect main is already merged and continue with the ${fromStage} merge.`
							: `Merge main → ${targetStage} failed: ${mergeErr instanceof Error ? mergeErr.message : String(mergeErr)}`,
				}
			}
		}

		// 4. Merge fromStage → target (carry unapproved future-stage work
		//    like feedback files and in-flight artifacts forward so they
		//    survive the revisit). On conflict, leave the repo merging and
		//    return a detailed error — the agent resolves and retries. The
		//    main merge from step 3 is NOT rolled back: partial progress is
		//    valuable, and the retry is idempotent.
		if (fromBranch && fromStage !== targetStage && branchExists(fromBranch)) {
			const fromAhead = tryRun([
				"git",
				"rev-list",
				"--count",
				`${targetBranch}..${fromBranch}`,
			])
			if (fromAhead && Number.parseInt(fromAhead, 10) > 0) {
				try {
					run([
						"git",
						"merge",
						fromBranch,
						"--no-edit",
						"-m",
						`haiku: merge ${fromStage} → ${targetStage} (revisit carries future-stage work back)`,
					])
				} catch (mergeErr) {
					const conflicts = listConflicts()
					return {
						success: false,
						message:
							conflicts.length > 0
								? `Merge ${fromStage} → ${targetStage} left ${conflicts.length} conflicted file(s): ${conflicts.join(", ")}. Resolve conflicts on branch '${targetBranch}' (edit files, \`git add\`, \`git commit\`), then retry the revisit. Main has already been merged cleanly and won't be remerged.`
								: `Merge ${fromStage} → ${targetStage} failed: ${mergeErr instanceof Error ? mergeErr.message : String(mergeErr)}`,
					}
				}
			}
		}

		return {
			success: true,
			message: `prepared ${targetBranch} with main${fromBranch && fromStage !== targetStage ? ` + ${fromStage}` : ""} merged in`,
		}
	} catch (err) {
		return {
			success: false,
			message: err instanceof Error ? err.message : String(err),
		}
	}
}
