// state/git-commit.ts — git add/commit/push for lifecycle state changes.
//
// All state mutations the FSM performs are committed via these helpers.
// They are no-ops in non-git environments (filesystem mode), and never
// throw — git failures are reported via the return shape so callers can
// surface them in tool output.

import { execFileSync, spawn } from "node:child_process"
import { getCurrentBranch } from "../git-worktree.js"
import { findHaikuRoot, isGitRepo } from "./shared.js"

export interface GitCommitResult {
	committed: boolean
	pushed: boolean
	pushError?: string
}

/** Git add + commit + push for lifecycle state changes. */
export function gitCommitState(message: string): GitCommitResult {
	if (!isGitRepo()) return { committed: false, pushed: false }
	try {
		const haikuRoot = findHaikuRoot()
		execFileSync("git", ["add", haikuRoot], { encoding: "utf8", stdio: "pipe" })
		execFileSync("git", ["commit", "-m", message, "--allow-empty"], {
			encoding: "utf8",
			stdio: "pipe",
		})
		try {
			execFileSync("git", ["push"], { encoding: "utf8", stdio: "pipe" })
			return { committed: true, pushed: true }
		} catch (pushErr) {
			const pushError =
				pushErr instanceof Error ? pushErr.message : String(pushErr)
			return { committed: true, pushed: false, pushError }
		}
	} catch {
		return { committed: false, pushed: false }
	}
}

/**
 * Like `gitCommitState`, but commits synchronously and pushes in the
 * background via an unref'd child process. Use for HTTP mutation
 * handlers where the caller is waiting on an HTTP response — pushing
 * inline adds a network round trip per mutation, which is perceptible
 * as UI lag on every approve/reject/delete. The commit is the real
 * durability boundary; push is for sharing state with remote tooling
 * and can safely slip a few hundred ms.
 */
export function gitCommitStateBackgroundPush(message: string): {
	committed: boolean
} {
	if (!isGitRepo()) return { committed: false }
	try {
		const haikuRoot = findHaikuRoot()
		execFileSync("git", ["add", haikuRoot], { encoding: "utf8", stdio: "pipe" })
		execFileSync("git", ["commit", "-m", message, "--allow-empty"], {
			encoding: "utf8",
			stdio: "pipe",
		})
	} catch {
		return { committed: false }
	}
	try {
		const child = spawn("git", ["push"], {
			stdio: "ignore",
			detached: true,
		})
		child.unref()
		child.on("error", () => {
			/* Background push failures are non-fatal. */
		})
	} catch {
		/* swallow — commit already landed */
	}
	return { committed: true }
}

/**
 * Validate the agent is on the correct git branch for the current operation.
 * Returns an error message if on the wrong branch, empty string if OK.
 */
export function validateBranch(
	intent: string,
	expectedType: "intent" | "unit",
	unit?: string,
): string {
	if (!isGitRepo()) return ""
	const current = getCurrentBranch()
	if (!current) return ""

	const intentPrefix = `haiku/${intent}/`
	if (expectedType === "intent") {
		if (!current.startsWith(intentPrefix)) {
			return `⚠️ WRONG BRANCH: Expected a branch under '${intentPrefix}' but on '${current}'. Run \`git checkout haiku/${intent}/main\` or the appropriate stage branch. Custom branch names break the H·AI·K·U lifecycle.`
		}
	} else if (expectedType === "unit" && unit) {
		const expectedUnit = `haiku/${intent}/${unit}`
		if (current !== expectedUnit && !current.startsWith(intentPrefix)) {
			return `⚠️ WRONG BRANCH: Expected '${expectedUnit}' or a branch under '${intentPrefix}' but on '${current}'. Ensure you're working in the correct worktree.`
		}
	}
	return ""
}

/** Returns a warning string if git push failed, empty string otherwise.
 *  Safe to append to plain text responses. */
export function pushWarning(result: GitCommitResult): string {
	if (result.pushed || !result.committed) return ""
	return `\n\n⚠️ GIT PUSH FAILED: ${result.pushError || "unknown error"}. Run \`git pull --rebase && git push\` to sync with remote. If there are conflicts, resolve them then push again.`
}

/** Injects push warning into a JSON object's message field if push failed. */
export function injectPushWarning(
	obj: Record<string, unknown>,
	result: GitCommitResult,
): Record<string, unknown> {
	if (result.pushed || !result.committed) return obj
	return {
		...obj,
		push_failed: true,
		push_error: result.pushError || "unknown error",
		message: `${obj.message || ""}. ⚠️ GIT PUSH FAILED: ${result.pushError || "unknown error"}. Run \`git pull --rebase && git push\` to resolve.`,
	}
}
