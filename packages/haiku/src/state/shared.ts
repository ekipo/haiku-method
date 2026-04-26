// state/shared.ts — Tiny helpers shared by every state subsystem.
//
// These used to live in the middle of state-tools.ts, but as the file
// got carved into per-domain modules (repair, feedback, paths, scope,
// iterations, etc.) every one of those modules ended up needing the same
// 4–5 helpers. Lifting them here breaks the circular-import shape that
// would otherwise form between state-tools.ts and the new modules.

import { execFileSync } from "node:child_process"
import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs"
import { join } from "node:path"
import {
	dedupeFrontmatterKeys,
	isDuplicateKeyError,
} from "@haiku/shared/frontmatter"
import matter from "gray-matter"
import { reportError } from "../sentry.js"

// ── Environment detection ──────────────────────────────────────────────────

/** Cached flag: are we in a git repository? Detected once at startup. */
let _isGitRepo: boolean | null = null

export function isGitRepo(): boolean {
	if (_isGitRepo !== null) return _isGitRepo
	try {
		execFileSync("git", ["rev-parse", "--git-dir"], {
			encoding: "utf8",
			stdio: "pipe",
		})
		_isGitRepo = true
	} catch {
		_isGitRepo = false
	}
	return _isGitRepo
}

/** Reset the cached git-repo detection. Intended for tests that change cwd
 *  between different repos (real git / non-git / different real git). Not
 *  called in production — the process runs with a single cwd. */
export function _resetIsGitRepoForTests(): void {
	_isGitRepo = null
}

// ── Path resolution ────────────────────────────────────────────────────────

export function findHaikuRoot(): string {
	// Walk up from cwd looking for .haiku/
	let dir = process.cwd()
	for (let i = 0; i < 20; i++) {
		if (existsSync(join(dir, ".haiku"))) return join(dir, ".haiku")
		const parent = join(dir, "..")
		if (parent === dir) break
		dir = parent
	}
	throw new Error("No .haiku/ directory found")
}

export function intentDir(slug: string): string {
	return join(findHaikuRoot(), "intents", slug)
}

// ── JSON helpers ───────────────────────────────────────────────────────────

export function readJson(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {}
	return JSON.parse(readFileSync(path, "utf8"))
}

export function writeJson(path: string, data: Record<string, unknown>): void {
	mkdirSync(join(path, ".."), { recursive: true })
	writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`)
}

// ── Frontmatter parsing ────────────────────────────────────────────────────

export function normalizeDates(
	data: Record<string, unknown>,
): Record<string, unknown> {
	const result = { ...data }
	for (const key in result) {
		if (result[key] instanceof Date) {
			result[key] = (result[key] as Date).toISOString().split("T")[0]
		}
	}
	return result
}

export function parseFrontmatter(raw: string): {
	data: Record<string, unknown>
	body: string
} {
	// Auto-recover from duplicate top-level YAML keys by keeping the last
	// occurrence and reparsing. haiku_repair separately flags these files so
	// they get rewritten on disk; this keeps the FSM running in the meantime.
	const tryParse = (text: string) => {
		const { data, content } = matter(text)
		return {
			data: normalizeDates(data as Record<string, unknown>),
			body: content.trim(),
		}
	}
	try {
		return tryParse(raw)
	} catch (err) {
		if (!isDuplicateKeyError(err)) throw err
		const { text, removed } = dedupeFrontmatterKeys(raw)
		if (removed.length === 0) throw err
		// Report the recovery so we can see which files are drifting and how often
		// — the file is still live with deduped values until haiku_repair rewrites it.
		reportError(err, {
			context: "parseFrontmatter:dedup-recovery",
			removed_keys: removed,
		})
		return tryParse(text)
	}
}
