// git/internal.ts — Shared low-level git primitives for the worktree
// modules. Not meant for general consumption — these are the private
// helpers that the per-domain worktree files (discovery, fix-chain,
// future stage / unit modules) all need to share without dragging in
// the entire git-worktree surface.

import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** Run a git/CLI command and return trimmed stdout. Throws on non-zero
 *  exit. Use `tryRun` if you'd rather get an empty string on failure. */
export function run(args: string[], cwd?: string): string {
	return execFileSync(args[0], args.slice(1), {
		encoding: "utf8",
		stdio: "pipe",
		cwd,
	}).trim()
}

/** Run + swallow exceptions, returning "" on failure. Use for git probes
 *  where "no such ref" / "no such branch" / "not a worktree" is normal. */
export function tryRun(args: string[], cwd?: string): string {
	try {
		return run(args, cwd)
	} catch {
		return ""
	}
}

/** Allocate a temporary worktree at `tmpdir()/haiku-merge-XXXXXX`,
 *  invoke `fn` with its absolute path, and clean up on exit (success
 *  OR exception). Used by every "merge X into Y when we're not on Y's
 *  branch" path so the merge runs in an isolated checkout instead of
 *  mutating the user's current tree. */
export function withTempWorktree<T>(
	branch: string,
	fn: (path: string) => T,
): T {
	const path = mkdtempSync(join(tmpdir(), "haiku-merge-"))
	try {
		run(["git", "worktree", "add", path, branch])
		try {
			return fn(path)
		} finally {
			tryRun(["git", "worktree", "remove", "--force", path])
		}
	} finally {
		try {
			rmSync(path, { recursive: true, force: true })
		} catch {
			/* non-fatal */
		}
	}
}
