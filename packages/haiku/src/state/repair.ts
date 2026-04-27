// state/repair.ts — Intent repair / autofix subsystem.
//
// Lifted out of state-tools.ts as a standalone domain. Surface:
//   - applyAutoFixes        : apply mechanical fixes to one intent
//   - scanOneIntent         : detect issues in one intent (pure scan)
//   - repairCwd             : scan + optional autofix in a single .haiku root
//   - repairAllBranches     : worktree-per-branch repair across every intent
//   - repairArchivedOnMainline : archived-intent repair via fresh PR branch
//   - buildRepairReport, buildMultiBranchReport : markdown report builders
//   - intentTitleNeedsRepair, INTENT_TITLE_MAX_LENGTH : title validity check

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { dedupeFrontmatterKeys } from "@haiku/shared/frontmatter"
import matter from "gray-matter"
import { resolvePluginRoot } from "../config.js"
import {
	addTempWorktree,
	commitAndPushFromWorktree,
	consolidateStageBranches,
	fetchOrigin,
	getMainlineBranch,
	isBranchMerged,
	listIntentBranches,
	listOrphanDiscreteIntents,
	openPullRequest,
	readFileFromBranch,
	removeTempWorktree,
} from "../git-worktree.js"
import { scanOneIntent } from "./scan-intent.js"
import { findHaikuRoot, parseFrontmatter, readJson, writeJson } from "./shared.js"

// ── Intent title derivation ────────────────────────────────────────────────

/** Maximum length for an intent title. Anything longer is treated as a
 *  description that needs summarizing. */
export const INTENT_TITLE_MAX_LENGTH = 80

/** Whether a title value needs repair (too long, multiline, or empty). */
export function intentTitleNeedsRepair(title: unknown): boolean {
	if (typeof title !== "string") return true
	const trimmed = title.trim()
	if (trimmed.length === 0) return true
	if (trimmed.length > INTENT_TITLE_MAX_LENGTH) return true
	if (/\n/.test(trimmed)) return true
	return false
}

// ── Auto-fix application for repair ────────────────────────────────────────

export interface RepairIssue {
	intent: string
	field: string
	severity: "error" | "warning"
	message: string
	fix: string
}

export interface AppliedFix {
	intent: string
	field: string
	description: string
}

/** Apply mechanical, judgment-free fixes to an intent's intent.md.
 *  Currently handles: overlong/multiline title, legacy `created` rename,
 *  missing `created_at`, missing `mode`, stages mismatch with studio,
 *  legacy `studio: software` alias migration to `application-development`.
 *  Returns the fixes applied and any issues that still need attention. */
export function applyAutoFixes(
	intentRoot: string,
	slug: string,
	issues: RepairIssue[],
): { applied: AppliedFix[]; remaining: RepairIssue[] } {
	const intentPath = join(intentRoot, slug, "intent.md")
	if (!existsSync(intentPath)) return { applied: [], remaining: issues }

	const applied: AppliedFix[] = []

	// Pre-pass: any file with duplicate top-level frontmatter keys gets rewritten
	// with deduped frontmatter (last-wins semantics via js-yaml `json: true`).
	// Must run before we try to parse intent.md/unit.md normally below, because
	// the default gray-matter/js-yaml parser throws on duplicate keys.
	const dedupeTargets: string[] = [intentPath]
	const stagesDirForDedupe = join(intentRoot, slug, "stages")
	if (existsSync(stagesDirForDedupe)) {
		for (const stageEntry of readdirSync(stagesDirForDedupe, {
			withFileTypes: true,
		})) {
			if (!stageEntry.isDirectory()) continue
			const unitsDir = join(stagesDirForDedupe, stageEntry.name, "units")
			if (!existsSync(unitsDir)) continue
			for (const f of readdirSync(unitsDir, { withFileTypes: true })) {
				if (f.isFile() && f.name.endsWith(".md")) {
					dedupeTargets.push(join(unitsDir, f.name))
				}
			}
		}
	}
	for (const targetPath of dedupeTargets) {
		const raw = readFileSync(targetPath, "utf8")
		const { text: rewritten, removed } = dedupeFrontmatterKeys(raw)
		if (removed.length === 0) continue
		writeFileSync(targetPath, rewritten)
		const rel = targetPath.startsWith(join(intentRoot, slug))
			? targetPath.slice(join(intentRoot, slug).length + 1)
			: targetPath
		applied.push({
			intent: slug,
			field: `${rel}:frontmatter`,
			description: `Deduped frontmatter keys: ${removed.join(", ")}`,
		})
	}
	// Issues flagged for duplicate keys are resolved by the rewrite above;
	// drop them from the work list so they don't end up in `remaining`.
	const issuesAfterDedupe = issues.filter(
		(i) => !i.field.endsWith(":frontmatter-duplicate-keys"),
	)

	// Read after the dedupe pre-pass so matter() doesn't choke on duplicate keys.
	const raw = readFileSync(intentPath, "utf8")
	const parsed = matter(raw)
	const data = parsed.data
	const body = parsed.content
	let changed = false
	const remaining: RepairIssue[] = []

	for (const issue of issuesAfterDedupe) {
		let fixedHere = false

		// Title: overlong, multiline, or otherwise non-conforming.
		if (
			issue.field === "title" &&
			typeof data.title === "string" &&
			intentTitleNeedsRepair(data.title)
		) {
			const oldTitle = (data.title as string).replace(/\s+/g, " ").trim()
			const preview =
				oldTitle.length > 120 ? `${oldTitle.slice(0, 117)}...` : oldTitle
			remaining.push({
				intent: slug,
				field: "title",
				severity: "error",
				message: `Title is ${oldTitle.length} chars — looks auto-truncated or is a full description, not a title`,
				fix: `Rewrite as a crisp 3–8 word summary (≤80 chars, single line, no trailing period). Preserve the current text as a paragraph in the body under the H1 if it isn't there already. Original: "${preview}"`,
			})
			fixedHere = true
		}

		// Legacy `created` field → `created_at`
		if (issue.field === "created" && data.created && !data.created_at) {
			data.created_at = data.created
			delete data.created
			applied.push({
				intent: slug,
				field: "created",
				description: "Renamed legacy `created` to `created_at`",
			})
			fixedHere = true
			changed = true
		}

		// Missing `created_at`: use file mtime as the best-effort fallback
		if (issue.field === "created_at" && !data.created && !data.created_at) {
			const stat = statSyncSafe(intentPath)
			data.created_at = stat
				? stat.mtime.toISOString()
				: new Date().toISOString()
			applied.push({
				intent: slug,
				field: "created_at",
				description: "Added `created_at` from file mtime",
			})
			fixedHere = true
			changed = true
		}

		// Missing `mode`: default to continuous
		if (issue.field === "mode" && !data.mode) {
			data.mode = "continuous"
			applied.push({
				intent: slug,
				field: "mode",
				description: "Defaulted `mode` to 'continuous'",
			})
			fixedHere = true
			changed = true
		}

		// Stages mismatch — apply the expected stages from the studio
		if (
			issue.field === "stages" &&
			issue.message.startsWith("Stages don't match")
		) {
			const expectedMatch = issue.fix.match(/Expected: \[([^\]]+)\]/)
			if (expectedMatch) {
				const expected = expectedMatch[1]
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean)
				if (expected.length > 0) {
					data.stages = expected
					applied.push({
						intent: slug,
						field: "stages",
						description: `Updated stages to match studio definition: [${expected.join(", ")}]`,
					})
					fixedHere = true
					changed = true
				}
			}
		}

		// Git-based date repair: created_at, started_at, completed_at
		if (issue.field === "created_at" && issue.message.includes("git history")) {
			const dateMatch = issue.fix.match(/'([^']+)' \(from git/)
			if (dateMatch) {
				data.created_at = dateMatch[1]
				applied.push({
					intent: slug,
					field: "created_at",
					description: `Updated created_at to '${dateMatch[1]}' from git history`,
				})
				fixedHere = true
				changed = true
			}
		}

		if (issue.field === "started_at" && issue.fix.includes("from git")) {
			const dateMatch = issue.fix.match(/'([^']+)' \(from git/)
			if (dateMatch) {
				data.started_at = dateMatch[1]
				applied.push({
					intent: slug,
					field: "started_at",
					description: `Updated started_at to '${dateMatch[1]}' from git history`,
				})
				fixedHere = true
				changed = true
			}
		}

		if (issue.field === "completed_at" && issue.fix.includes("from git")) {
			const dateMatch = issue.fix.match(/'([^']+)' \(from git/)
			if (dateMatch) {
				data.completed_at = dateMatch[1]
				applied.push({
					intent: slug,
					field: "completed_at",
					description: `Updated completed_at to '${dateMatch[1]}' from git history`,
				})
				fixedHere = true
				changed = true
			}
		}

		if (!fixedHere) remaining.push(issue)
	}

	if (changed) {
		writeFileSync(intentPath, matter.stringify(body, data))
	}

	// Strip deprecated `type` field from all unit files
	const stagesDir = join(intentRoot, slug, "stages")
	if (existsSync(stagesDir)) {
		for (const stageEntry of readdirSync(stagesDir, { withFileTypes: true })) {
			if (!stageEntry.isDirectory()) continue
			const unitsDir = join(stagesDir, stageEntry.name, "units")
			if (!existsSync(unitsDir)) continue
			for (const unitEntry of readdirSync(unitsDir, { withFileTypes: true })) {
				if (!(unitEntry.isFile() && unitEntry.name.endsWith(".md"))) continue
				const unitPath = join(unitsDir, unitEntry.name)
				const unitRaw = readFileSync(unitPath, "utf8")
				const unitParsed = matter(unitRaw)
				if ("type" in unitParsed.data) {
					const { type: _removed, ...rest } = unitParsed.data
					writeFileSync(unitPath, matter.stringify(unitParsed.content, rest))
					applied.push({
						intent: slug,
						field: `stages/${stageEntry.name}/units/${unitEntry.name}:type`,
						description: "Removed deprecated `type` field from unit",
					})
				}
			}
		}
	}

	// Second pass: auto-apply unit `inputs:` from the fix instructions.
	const inputsRemaining: RepairIssue[] = []
	const unitInputsRe = /^stages\/([^/]+)\/units\/([^/]+):inputs$/
	for (const issue of remaining) {
		const m = issue.field.match(unitInputsRe)
		if (
			!(m && issue.message.includes("Unit has no `inputs:`")) ||
			typeof issue.fix !== "string"
		) {
			inputsRemaining.push(issue)
			continue
		}
		const stageName = m[1]
		const unitFile = m[2]
		const unitPath = join(
			intentRoot,
			slug,
			"stages",
			stageName,
			"units",
			unitFile,
		)
		if (!existsSync(unitPath)) {
			inputsRemaining.push(issue)
			continue
		}

		let inputsToWrite: string[] = []
		const upstreamMatch = issue.fix.match(/upstream paths:\s*(.+?)\s*$/)
		if (upstreamMatch) {
			inputsToWrite = upstreamMatch[1]
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean)
		} else {
			const fallback: string[] = ["intent.md"]
			const knowledgeDir = join(intentRoot, slug, "knowledge")
			if (existsSync(knowledgeDir)) {
				for (const f of readdirSync(knowledgeDir)) {
					if (f.endsWith(".md")) fallback.push(`knowledge/${f}`)
				}
			}
			inputsToWrite = fallback
		}

		if (inputsToWrite.length === 0) {
			inputsRemaining.push(issue)
			continue
		}

		const unitRaw = readFileSync(unitPath, "utf8")
		const unitParsed = matter(unitRaw)
		const existing = (unitParsed.data.inputs as string[]) || []
		if (existing.length > 0) {
			continue
		}
		unitParsed.data.inputs = inputsToWrite
		writeFileSync(
			unitPath,
			matter.stringify(unitParsed.content, unitParsed.data),
		)
		applied.push({
			intent: slug,
			field: issue.field,
			description: `Linked ${inputsToWrite.length} input(s): ${inputsToWrite.join(", ")}`,
		})
	}

	// Third pass: fix stage-level state.json issues (completion synthesis)
	const stageRemaining: RepairIssue[] = []
	for (const issue of inputsRemaining) {
		let fixedHere = false

		if (
			issue.field.match(/^stages\/[^/]+\/state\.json$/) &&
			issue.message.includes("before active_stage")
		) {
			const stageMatch = issue.field.match(/^stages\/([^/]+)\/state\.json$/)
			if (stageMatch) {
				const stageName = stageMatch[1]
				const stageDir = join(intentRoot, slug, "stages", stageName)
				const stateFile = join(stageDir, "state.json")
				mkdirSync(stageDir, { recursive: true })

				const now = new Date().toISOString()
				const completedState: Record<string, unknown> = {
					stage: stageName,
					status: "completed",
					phase: "gate",
					started_at: data.started_at || data.created_at || now,
					completed_at:
						data.completed_at || data.started_at || data.created_at || now,
					gate_entered_at: null,
					gate_outcome: "advanced",
				}
				writeJson(stateFile, completedState)
				applied.push({
					intent: slug,
					field: issue.field,
					description: `Synthesized completion record for stage '${stageName}' (before active_stage)`,
				})
				fixedHere = true
			}
		}

		if (!fixedHere) stageRemaining.push(issue)
	}

	return { applied, remaining: stageRemaining }
}

function statSyncSafe(path: string): { mtime: Date } | null {
	try {
		return statSync(path)
	} catch {
		return null
	}
}

// ── Repair scanning ─────────────────────────────────────────────────────────

// scanOneIntent + the git-date helpers live in ./scan-intent.ts. Re-exported
// so existing callers (`repair-branches.ts`, tools) keep importing
// from `state/repair.js`.
export { scanOneIntent }

/** Build a map of available studios → their stages, scanning project + plugin paths. */
export function buildStudioMap(root: string): {
	studioMap: Map<string, string[]>
	searchPaths: string[]
} {
	const studioMap = new Map<string, string[]>()
	const pluginRoot = resolvePluginRoot()
	const searchPaths = [join(root, "studios"), join(pluginRoot, "studios")]
	for (const base of searchPaths) {
		if (!existsSync(base)) continue
		for (const d of readdirSync(base, { withFileTypes: true })) {
			if (!d.isDirectory() || studioMap.has(d.name)) continue
			const studioMd = join(base, d.name, "STUDIO.md")
			if (!existsSync(studioMd)) continue
			const { data: stData } = parseFrontmatter(readFileSync(studioMd, "utf8"))
			const stStages = Array.isArray(stData.stages)
				? (stData.stages as string[])
				: []
			studioMap.set(d.name, stStages)
		}
	}
	return { studioMap, searchPaths }
}


export interface RepairCwdResult {
	scanned: number
	cleanIntents: string[]
	issues: RepairIssue[]
	applied: AppliedFix[]
	remaining: RepairIssue[]
}

/** Run repair scan + optional auto-fix. `rootOverride` is the absolute path to a
 *  `.haiku` directory — pass it when operating on a worktree other than `cwd`.
 *  When omitted, falls back to walking up from the current working directory. */
export function repairCwd(
	rootOverride: string | undefined,
	intentArg: string | undefined,
	autoApply: boolean,
): RepairCwdResult {
	const root = rootOverride ?? findHaikuRoot()
	const intentsDir = join(root, "intents")
	if (!existsSync(intentsDir)) {
		return {
			scanned: 0,
			cleanIntents: [],
			issues: [],
			applied: [],
			remaining: [],
		}
	}
	const { studioMap, searchPaths } = buildStudioMap(root)

	let slugs: string[]
	if (intentArg) {
		if (/[/\\]|\.\./.test(intentArg))
			throw new Error(`Invalid intent slug: "${intentArg}"`)
		if (!existsSync(join(intentsDir, intentArg, "intent.md"))) {
			return {
				scanned: 0,
				cleanIntents: [],
				issues: [],
				applied: [],
				remaining: [],
			}
		}
		slugs = [intentArg]
	} else {
		slugs = readdirSync(intentsDir, { withFileTypes: true })
			.filter(
				(d) =>
					d.isDirectory() && existsSync(join(intentsDir, d.name, "intent.md")),
			)
			.map((d) => d.name)
	}

	const allIssues: RepairIssue[] = []
	const cleanIntents: string[] = []
	const allApplied: AppliedFix[] = []
	const allRemaining: RepairIssue[] = []

	for (const slug of slugs) {
		let issues = scanOneIntent(intentsDir, slug, studioMap, searchPaths)
		if (autoApply && issues.length > 0) {
			const result = applyAutoFixes(intentsDir, slug, issues)
			allApplied.push(...result.applied)
			if (result.applied.length > 0) {
				issues = scanOneIntent(intentsDir, slug, studioMap, searchPaths)
			}
		}
		if (issues.length === 0) {
			cleanIntents.push(slug)
		} else {
			allIssues.push(...issues)
			allRemaining.push(...issues)
		}
	}

	return {
		scanned: slugs.length,
		cleanIntents,
		issues: allIssues,
		applied: allApplied,
		remaining: allRemaining,
	}
}

/** Build a markdown report from a single-cwd repair result. */
export function buildRepairReport(
	result: RepairCwdResult,
	headingPrefix = "",
): string {
	if (result.issues.length === 0 && result.applied.length === 0) {
		return `${headingPrefix}All intents passed validation. No repairs needed.`
	}

	const issuesByIntent = new Map<string, RepairIssue[]>()
	for (const issue of result.issues) {
		const list = issuesByIntent.get(issue.intent) || []
		list.push(issue)
		issuesByIntent.set(issue.intent, list)
	}

	const lines: string[] = [
		`${headingPrefix}# Intent Repair Report`,
		"",
		`Scanned ${result.scanned} intent(s). Auto-applied ${result.applied.length} fix(es). ${result.remaining.length} issue(s) remaining.`,
		"",
	]

	if (result.applied.length > 0) {
		lines.push("## Auto-Applied Fixes")
		lines.push("")
		for (const fix of result.applied) {
			lines.push(`- **${fix.intent}** / \`${fix.field}\` — ${fix.description}`)
		}
		lines.push("")
	}

	for (const [slug, issues] of issuesByIntent) {
		const errors = issues.filter((i) => i.severity === "error").length
		const warnings = issues.filter((i) => i.severity === "warning").length
		lines.push(`## ${slug} — ${errors} error(s), ${warnings} warning(s)`)
		lines.push("")
		lines.push("| # | Severity | Field | Issue | Fix |")
		lines.push("|---|----------|-------|-------|-----|")
		issues.forEach((issue, idx) => {
			lines.push(
				`| ${idx + 1} | ${issue.severity} | ${issue.field} | ${issue.message} | ${issue.fix} |`,
			)
		})
		lines.push("")
	}

	if (result.cleanIntents.length > 0) {
		lines.push("## Intents with no issues")
		for (const slug of result.cleanIntents) {
			lines.push(`- ${slug}`)
		}
		lines.push("")
	}

	if (result.remaining.length > 0) {
		lines.push(
			"---",
			"",
			"Auto-fixes were applied for safe issues. Remaining issues need agent or user attention. For each:",
			"1. Read the intent.md file",
			"2. Apply the fix listed in the table above",
			"3. After fixing, report what you changed",
		)
	}

	return lines.join("\n")
}

