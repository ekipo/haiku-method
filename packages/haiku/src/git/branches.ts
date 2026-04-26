// git/branches.ts — Branch primitives, mainline detection, intent-branch
// enumeration, merge-status checks, plus temporary-worktree + PR helpers.
//
// Grouped together because every operation here is "git ops that don't
// allocate a long-lived worktree" — the actual stage / unit / discovery
// / fix-chain worktree lifecycles live in their own modules.

import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { isGitRepo } from "../state/shared.js"
import { run, tryRun } from "./internal.js"

// ── Branch primitives ─────────────────────────────────────────────────────

/** Get the current branch name. */
export function getCurrentBranch(): string {
	return tryRun(["git", "rev-parse", "--abbrev-ref", "HEAD"])
}

/** Check if a branch exists (local). */
export function branchExists(branch: string): boolean {
	if (!isGitRepo()) return false
	return tryRun(["git", "rev-parse", "--verify", branch]) !== ""
}

/** Detect the mainline branch.
 *  Order of resolution:
 *    1. `origin/HEAD` symbolic ref — the remote's actual default branch (handles `dev`, `trunk`, etc.)
 *    2. `main`, `master` as local or remote refs
 *    3. `git config init.defaultBranch`
 *    4. `"main"` as a last-resort string (also used in non-git environments).
 */
export function getMainlineBranch(): string {
	if (!isGitRepo()) return "main"
	const originHead = tryRun([
		"git",
		"symbolic-ref",
		"--short",
		"refs/remotes/origin/HEAD",
	])
	if (originHead) {
		const m = originHead.match(/^origin\/(.+)$/)
		if (m) return m[1]
	}
	for (const candidate of ["main", "master"]) {
		if (tryRun(["git", "rev-parse", "--verify", candidate])) return candidate
		if (tryRun(["git", "rev-parse", "--verify", `origin/${candidate}`]))
			return candidate
	}
	const configured = tryRun(["git", "config", "--get", "init.defaultBranch"])
	return configured || "main"
}

/** Fetch from origin so subsequent ref lookups and worktree creations see
 *  the current remote state. Non-fatal — returns false on failure
 *  (offline, no remote). */
export function fetchOrigin(): boolean {
	if (!isGitRepo()) return false
	try {
		execFileSync("git", ["fetch", "--prune", "origin"], { stdio: "pipe" })
		return true
	} catch {
		return false
	}
}

/** List all H·AI·K·U intent branches (`haiku/<slug>/main`) — local +
 *  remote, deduped. Returns intent slugs in stable sort order. */
export function listIntentBranches(): string[] {
	if (!isGitRepo()) return []
	const slugs = new Set<string>()
	const local = tryRun([
		"git",
		"for-each-ref",
		"--format=%(refname:short)",
		"refs/heads/haiku",
	])
	for (const line of local.split("\n").filter(Boolean)) {
		const match = line.match(/^haiku\/([^/]+)\/main$/)
		if (match) slugs.add(match[1])
	}
	const remote = tryRun([
		"git",
		"for-each-ref",
		"--format=%(refname:short)",
		"refs/remotes/origin/haiku",
	])
	for (const line of remote.split("\n").filter(Boolean)) {
		const match = line.match(/^origin\/haiku\/([^/]+)\/main$/)
		if (match) slugs.add(match[1])
	}
	return Array.from(slugs).sort()
}

/** List intent slugs that have haiku/<slug>/<stage> branches but NO
 *  haiku/<slug>/main. These are discrete-mode intents created before
 *  the hub-branch convention. Returns { slug, branches } pairs so the
 *  caller knows what stage branches exist. */
export function listOrphanDiscreteIntents(): {
	slug: string
	branches: string[]
}[] {
	if (!isGitRepo()) return []

	const mainSlugs = new Set(listIntentBranches())
	const stageMap = new Map<string, string[]>()
	for (const prefix of ["refs/heads/haiku", "refs/remotes/origin/haiku"]) {
		const out = tryRun([
			"git",
			"for-each-ref",
			"--format=%(refname:short)",
			prefix,
		])
		for (const line of out.split("\n").filter(Boolean)) {
			const stripped = line.startsWith("origin/")
				? line.slice("origin/".length)
				: line
			const match = stripped.match(/^haiku\/([^/]+)\/(.+)$/)
			if (!match) continue
			const [, slug, segment] = match
			if (segment === "main") continue
			if (mainSlugs.has(slug)) continue
			if (!stageMap.has(slug)) stageMap.set(slug, [])
			const branches = stageMap.get(slug) ?? []
			const branchName = `haiku/${slug}/${segment}`
			if (!branches.includes(branchName)) branches.push(branchName)
		}
	}

	return Array.from(stageMap.entries())
		.map(([slug, branches]) => ({ slug, branches }))
		.sort((a, b) => a.slug.localeCompare(b.slug))
}

/** Check whether `branch` has been merged into `mainline` (i.e., its
 *  tip is an ancestor). Falls back to VCS platform (gh/glab) to detect
 *  squash merges where the original commits are no longer ancestors of
 *  the target. */
export function isBranchMerged(branch: string, mainline: string): boolean {
	if (!isGitRepo()) return false
	const targets = [mainline, `origin/${mainline}`]
	const branchRef =
		tryRun(["git", "rev-parse", "--verify", branch]) ||
		tryRun(["git", "rev-parse", "--verify", `origin/${branch}`])
	if (!branchRef) return false
	for (const target of targets) {
		const targetRef = tryRun(["git", "rev-parse", "--verify", target])
		if (!targetRef) continue
		try {
			execFileSync(
				"git",
				["merge-base", "--is-ancestor", branchRef, targetRef],
				{ stdio: "ignore" },
			)
			return true
		} catch {
			// not merged into this target — try next
		}
	}

	// Squash merges rewrite history so --is-ancestor fails.
	// Fall back to VCS platform to check for a merged PR/MR from this branch.
	const tool = detectPrTool()
	const branchName = branch.startsWith("origin/")
		? branch.slice("origin/".length)
		: branch
	if (tool === "gh") {
		const out = tryRun([
			"gh",
			"pr",
			"list",
			"--head",
			branchName,
			"--base",
			mainline,
			"--state",
			"merged",
			"--json",
			"number",
			"--limit",
			"1",
		])
		if (out && out.trim() !== "[]") return true
	} else if (tool === "glab") {
		const out = tryRun([
			"glab",
			"mr",
			"list",
			"--source-branch",
			branchName,
			"--target-branch",
			mainline,
			"--state",
			"merged",
			"--per-page",
			"1",
		])
		if (out && /^!(\d+)\b/m.test(out)) return true
	}
	return false
}

// ── Temporary worktrees ───────────────────────────────────────────────────

/** Add a temporary worktree for an existing branch. Returns the worktree
 *  path. When `preferRemote` is true, resolves to `origin/<branch>` first
 *  so the worktree reflects the current remote state rather than a stale
 *  local ref. */
export function addTempWorktree(
	branch: string,
	label = "haiku-repair",
	preferRemote = false,
): string {
	if (!isGitRepo()) throw new Error("not a git repo")
	const path = join(
		"/tmp",
		`${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
	)
	const localRef = tryRun(["git", "rev-parse", "--verify", branch])
	const remoteRef = tryRun(["git", "rev-parse", "--verify", `origin/${branch}`])
	let ref: string
	if (preferRemote) {
		ref = remoteRef ? `origin/${branch}` : localRef ? branch : ""
	} else {
		ref = localRef ? branch : remoteRef ? `origin/${branch}` : ""
	}
	if (!ref) throw new Error(`branch '${branch}' not found locally or on origin`)
	run(["git", "worktree", "add", "--detach", path, ref])
	return path
}

/** Remove a temporary worktree. Non-fatal — never throws. */
export function removeTempWorktree(path: string): void {
	if (!(path && existsSync(path))) return
	tryRun(["git", "worktree", "remove", "--force", path])
}

/** Commit and push changes in a temporary worktree on the given branch.
 *  Stages all changes (including untracked), commits with the given
 *  message, and pushes to origin. Returns true if a commit was made,
 *  false if there was nothing to commit. */
export function commitAndPushFromWorktree(
	worktreePath: string,
	branch: string,
	message: string,
): { committed: boolean; pushed: boolean; pushError?: string } {
	if (!isGitRepo())
		return { committed: false, pushed: false, pushError: "not a git repo" }
	// The worktree is created with `--detach`, so HEAD is a detached snapshot
	// of the target branch tip. We deliberately do NOT run `git checkout -B`
	// to create or move the local branch ref — doing so would force-overwrite
	// any local commits the user had on that branch and would collide with
	// the branch being checked out in another worktree. Instead, we commit in
	// the detached state and push the commit directly to `refs/heads/<branch>`
	// on origin via an explicit refspec. No local ref is touched.
	tryRun(["git", "-C", worktreePath, "add", "-A"])
	const status = tryRun(["git", "-C", worktreePath, "status", "--porcelain"])
	if (!status) return { committed: false, pushed: false }
	try {
		execFileSync("git", ["-C", worktreePath, "commit", "-m", message], {
			stdio: "pipe",
		})
	} catch (err) {
		return {
			committed: false,
			pushed: false,
			pushError: err instanceof Error ? err.message : String(err),
		}
	}
	const tryPush = (): { ok: boolean; error?: string } => {
		try {
			execFileSync(
				"git",
				["-C", worktreePath, "push", "origin", `HEAD:refs/heads/${branch}`],
				{ stdio: "pipe" },
			)
			return { ok: true }
		} catch (err) {
			return {
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			}
		}
	}

	const first = tryPush()
	if (first.ok) return { committed: true, pushed: true }

	// Non-fast-forward recovery: fetch + rebase onto origin/<branch>, retry push.
	// Without this, a stale-ref repair run loops forever — each run re-applies
	// fixes, push rejects as non-fast-forward, and the worktree's stale view of
	// the repo keeps reporting issues that are already fixed on the remote. (#206)
	//
	// Matching is intentionally narrow: we only recover from genuine NFF errors.
	// A bare "rejected" would also match protected-branch rejections, pre-receive
	// hook failures, and permission errors — rebasing on those would be wrong.
	const isNonFastForward =
		/non-fast-forward|fetch first|behind the remote/i.test(first.error ?? "")
	if (isNonFastForward) {
		tryRun(["git", "-C", worktreePath, "fetch", "origin", branch])
		try {
			execFileSync("git", ["-C", worktreePath, "rebase", `origin/${branch}`], {
				stdio: "pipe",
			})
		} catch (err) {
			tryRun(["git", "-C", worktreePath, "rebase", "--abort"])
			return {
				committed: true,
				pushed: false,
				pushError: `non-fast-forward; rebase onto origin/${branch} failed: ${
					err instanceof Error ? err.message : String(err)
				}`,
			}
		}
		const retry = tryPush()
		if (retry.ok) return { committed: true, pushed: true }
		return { committed: true, pushed: false, pushError: retry.error }
	}

	return { committed: true, pushed: false, pushError: first.error }
}

// ── Pull-request creation ─────────────────────────────────────────────────

/** Detect a PR/MR creation tool (`gh` or `glab`) on PATH. */
export function detectPrTool(): "gh" | "glab" | null {
	if (tryRun(["which", "gh"])) return "gh"
	if (tryRun(["which", "glab"])) return "glab"
	return null
}

/** Open a PR/MR from `branch` into `mainline` using the detected tool.
 *  Returns the PR URL on success, an error message on failure. */
export function openPullRequest(
	branch: string,
	mainline: string,
	title: string,
	body: string,
): { ok: boolean; url?: string; error?: string } {
	const tool = detectPrTool()
	if (!tool) return { ok: false, error: "no PR tool (gh/glab) found on PATH" }
	try {
		if (tool === "gh") {
			// Check for an existing PR for this branch first to avoid duplicates
			const existing = tryRun([
				"gh",
				"pr",
				"list",
				"--head",
				branch,
				"--state",
				"open",
				"--json",
				"url",
				"--jq",
				".[0].url",
			])
			if (existing) return { ok: true, url: existing }
			const out = execFileSync(
				"gh",
				[
					"pr",
					"create",
					"--base",
					mainline,
					"--head",
					branch,
					"--title",
					title,
					"--body",
					body,
				],
				{ encoding: "utf8" },
			).trim()
			return { ok: true, url: out }
		}
		// glab: `glab mr list` returns a tabular row like `!123  title  branch  ...`,
		// not JSON, so we extract the MR number via a !NNN regex (not a substring
		// includes, which would false-positive on labels or error text) and then
		// call `glab mr view --output json` to get a proper URL.
		const existing = tryRun([
			"glab",
			"mr",
			"list",
			"--source-branch",
			branch,
			"--state",
			"opened",
			"--per-page",
			"1",
		])
		const mrNumberMatch = existing.match(/^!(\d+)\b/m)
		if (mrNumberMatch) {
			const mrNum = mrNumberMatch[1]
			const viewJson = tryRun(["glab", "mr", "view", mrNum, "--output", "json"])
			if (viewJson) {
				try {
					const parsed = JSON.parse(viewJson) as { web_url?: string }
					if (parsed.web_url) return { ok: true, url: parsed.web_url }
				} catch {
					// Fall through and create a new MR
				}
			}
		}
		const out = execFileSync(
			"glab",
			[
				"mr",
				"create",
				"--target-branch",
				mainline,
				"--source-branch",
				branch,
				"--title",
				title,
				"--description",
				body,
			],
			{ encoding: "utf8" },
		).trim()
		return { ok: true, url: out }
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		}
	}
}
