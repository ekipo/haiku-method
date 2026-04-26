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

import { execFileSync } from "node:child_process"
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
import { resolveStudio } from "../studio-reader.js"
import {
	findHaikuRoot,
	isGitRepo,
	parseFrontmatter,
	readJson,
	writeJson,
} from "./shared.js"

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

/** Get the first (oldest) commit date for a file from git history.
 *  `gitCwd` allows running git from a worktree path. */
function gitFirstCommitDateForRepair(
	filePath: string,
	gitCwd?: string,
): string | null {
	if (!isGitRepo()) return null
	try {
		const result = execFileSync(
			"git",
			["log", "--diff-filter=A", "--follow", "--format=%aI", "--", filePath],
			{
				encoding: "utf8",
				timeout: 5000,
				stdio: ["pipe", "pipe", "pipe"],
				...(gitCwd ? { cwd: gitCwd } : {}),
			},
		).trim()
		const lines = result.split("\n").filter(Boolean)
		return lines.length > 0 ? lines[lines.length - 1] : null
	} catch {
		return null
	}
}

/** Get the most recent commit date for a file/directory from git history.
 *  `gitCwd` allows running git from a worktree path. */
function gitLastCommitDateForRepair(
	filePath: string,
	gitCwd?: string,
): string | null {
	if (!isGitRepo()) return null
	try {
		const result = execFileSync(
			"git",
			["log", "-1", "--format=%aI", "--", filePath],
			{
				encoding: "utf8",
				timeout: 5000,
				stdio: ["pipe", "pipe", "pipe"],
				...(gitCwd ? { cwd: gitCwd } : {}),
			},
		).trim()
		return result || null
	} catch {
		return null
	}
}

// ── Repair scanning ─────────────────────────────────────────────────────────

const REPAIR_UNIT_PATTERN = /^unit-\d{2,}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/

/** Build a map of available studios → their stages, scanning project + plugin paths. */
function buildStudioMap(root: string): {
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

/** Scan one intent for repair issues. Pure function — no mutation. */
export function scanOneIntent(
	intentsDir: string,
	slug: string,
	studioMap: Map<string, string[]>,
	searchPaths: string[],
): RepairIssue[] {
	const intentPath = join(intentsDir, slug, "intent.md")
	if (!existsSync(intentPath)) return []
	const raw = readFileSync(intentPath, "utf8")
	const { data: repairData } = parseFrontmatter(raw)
	const issues: RepairIssue[] = []

	// a0. Duplicate frontmatter keys
	const { removed: intentDupes } = dedupeFrontmatterKeys(raw)
	if (intentDupes.length > 0) {
		issues.push({
			intent: slug,
			field: "intent.md:frontmatter-duplicate-keys",
			severity: "warning",
			message: `Duplicate frontmatter keys: ${intentDupes.join(", ")}`,
			fix: "Rewrite frontmatter with duplicate keys removed (last value wins)",
		})
	}

	// a. Missing, overlong, or multiline title
	if (
		!repairData.title ||
		(typeof repairData.title === "string" && repairData.title.trim() === "")
	) {
		issues.push({
			intent: slug,
			field: "title",
			severity: "error",
			message: "Missing title field",
			fix: "Add `title` field with a short one-line name (≤80 chars)",
		})
	} else if (
		typeof repairData.title === "string" &&
		intentTitleNeedsRepair(repairData.title)
	) {
		const current = repairData.title as string
		const reason = /\n/.test(current)
			? "title contains newlines"
			: `title is ${current.length} chars (max ${INTENT_TITLE_MAX_LENGTH})`
		issues.push({
			intent: slug,
			field: "title",
			severity: "error",
			message: `Title should be a short one-liner — ${reason}`,
			fix: "Rewrite `title` as a crisp 3–8 word summary (≤80 chars, single line, no trailing period). Do NOT truncate the current value — write a deliberate human-readable summary. Preserve the original text as a paragraph in the body under the H1 if it isn't there already.",
		})
	}

	// b. Missing studio
	if (!repairData.studio) {
		issues.push({
			intent: slug,
			field: "studio",
			severity: "error",
			message: "Missing studio field",
			fix: "Set `studio` to an available studio",
		})
	}

	// c. Invalid studio (allow legacy aliases via resolveStudio)
	const repairStudio = repairData.studio as string | undefined
	if (repairStudio && !studioMap.has(repairStudio)) {
		const resolved = resolveStudio(repairStudio)
		if (!resolved) {
			const available = Array.from(studioMap.keys()).join(", ")
			issues.push({
				intent: slug,
				field: "studio",
				severity: "error",
				message: `Studio '${repairStudio}' not found`,
				fix: `Studio '${repairStudio}' not found. Available: ${available}`,
			})
		}
	}

	// d. Missing stages
	const repairStages = repairData.stages
	if (!Array.isArray(repairStages) || repairStages.length === 0) {
		if (repairStudio && studioMap.has(repairStudio)) {
			const expected = studioMap.get(repairStudio)?.join(", ")
			issues.push({
				intent: slug,
				field: "stages",
				severity: "error",
				message: "Missing or empty stages array",
				fix: `Set \`stages\` to match studio definition: [${expected}]`,
			})
		} else {
			issues.push({
				intent: slug,
				field: "stages",
				severity: "error",
				message: "Missing or empty stages array",
				fix: "Set `stages` to match studio definition",
			})
		}
	}

	// e. Stages mismatch
	if (Array.isArray(repairStages) && repairStages.length > 0 && repairStudio) {
		const expected = studioMap.get(repairStudio)
		if (expected) {
			const actual = repairStages as string[]
			if (JSON.stringify(expected) !== JSON.stringify(actual)) {
				issues.push({
					intent: slug,
					field: "stages",
					severity: "warning",
					message: "Stages don't match studio definition",
					fix: `Stages don't match studio definition. Expected: [${expected.join(", ")}], got: [${actual.join(", ")}]`,
				})
			}
		}
	}

	// f. Missing status
	if (!repairData.status) {
		issues.push({
			intent: slug,
			field: "status",
			severity: "error",
			message: "Missing status field",
			fix: "Set `status` to 'active' or 'completed'",
		})
	}

	// g. Missing mode
	if (!repairData.mode) {
		issues.push({
			intent: slug,
			field: "mode",
			severity: "error",
			message: "Missing mode field",
			fix: "Set `mode` to 'continuous' or 'discrete'",
		})
	}

	// h. Legacy created field
	if (repairData.created && !repairData.created_at) {
		issues.push({
			intent: slug,
			field: "created",
			severity: "warning",
			message: "Legacy `created` field found",
			fix: "Rename `created` to `created_at`",
		})
	}

	// i. Missing created_at
	if (!(repairData.created || repairData.created_at)) {
		issues.push({
			intent: slug,
			field: "created_at",
			severity: "warning",
			message: "Missing created_at field",
			fix: "Add `created_at` with an ISO date",
		})
	}

	// j. Invalid active_stage
	if (
		repairData.active_stage &&
		Array.isArray(repairStages) &&
		repairStages.length > 0
	) {
		if (
			!(repairStages as string[]).includes(repairData.active_stage as string)
		) {
			issues.push({
				intent: slug,
				field: "active_stage",
				severity: "error",
				message: `active_stage '${repairData.active_stage}' not in stages list`,
				fix: `active_stage '${repairData.active_stage}' not in stages list`,
			})
		}
	}

	// k. Missing active_stage for active intents
	if (repairData.status === "active" && !repairData.active_stage) {
		issues.push({
			intent: slug,
			field: "active_stage",
			severity: "warning",
			message: "Active intent has no active_stage",
			fix: "Active intent has no active_stage. Set to the first stage.",
		})
	}

	// l. Stage state consistency
	if (Array.isArray(repairStages) && repairStages.length > 0) {
		const repairStagesDir = join(intentsDir, slug, "stages")
		const repairActiveStage = repairData.active_stage as string | undefined
		const validStatuses = ["pending", "active", "completed"]
		for (const stageName of repairStages as string[]) {
			const repairStageDir = join(repairStagesDir, stageName)
			const repairStateFile = join(repairStageDir, "state.json")
			const activeIdx = repairActiveStage
				? (repairStages as string[]).indexOf(repairActiveStage)
				: -1
			const thisIdx = (repairStages as string[]).indexOf(stageName)
			const isBeforeActive = activeIdx > 0 && thisIdx < activeIdx

			if (existsSync(repairStateFile)) {
				const state = readJson(repairStateFile)
				if (state.status && !validStatuses.includes(state.status as string)) {
					issues.push({
						intent: slug,
						field: `stages/${stageName}/state.json`,
						severity: "error",
						message: `Invalid stage status: '${state.status}'`,
						fix: `Set status to one of: ${validStatuses.join(", ")}`,
					})
				} else if (isBeforeActive && (state.status as string) !== "completed") {
					issues.push({
						intent: slug,
						field: `stages/${stageName}/state.json`,
						severity: "warning",
						message: `Stage before active_stage has status '${state.status || "pending"}' — should be 'completed'`,
						fix: `Update state.json to status: "completed" (stage is before active_stage '${repairActiveStage}')`,
					})
				}
			} else if (isBeforeActive) {
				issues.push({
					intent: slug,
					field: `stages/${stageName}/state.json`,
					severity: "warning",
					message:
						"Missing state.json for stage before active_stage — FSM will reset backwards",
					fix: `Create state.json with status: "completed" (stage is before active_stage '${repairActiveStage}')`,
				})
			}
		}
	}

	// m/n/o. Unit filename + required fields + inputs
	if (Array.isArray(repairStages)) {
		for (const stageName of repairStages as string[]) {
			const repairUnitsDir = join(
				intentsDir,
				slug,
				"stages",
				stageName,
				"units",
			)
			if (!existsSync(repairUnitsDir)) continue

			const existingUpstreamPaths: string[] = []
			if (repairStudio) {
				let stageInputs: Array<{
					stage: string
					discovery?: string
					output?: string
				}> | null = null
				for (const base of searchPaths) {
					const stageMd = join(
						base,
						repairStudio,
						"stages",
						stageName,
						"STAGE.md",
					)
					if (!existsSync(stageMd)) continue
					const { data: stageData } = parseFrontmatter(
						readFileSync(stageMd, "utf8"),
					)
					if (Array.isArray(stageData.inputs) && stageData.inputs.length > 0) {
						stageInputs = stageData.inputs as Array<{
							stage: string
							discovery?: string
							output?: string
						}>
					}
					break
				}
				if (stageInputs) {
					const intentPath2 = join(intentsDir, slug)
					for (const input of stageInputs) {
						for (const base of searchPaths) {
							for (const kind of ["discovery", "outputs"] as const) {
								const artifactDir = join(
									base,
									repairStudio,
									"stages",
									input.stage,
									kind,
								)
								if (!existsSync(artifactDir)) continue
								for (const f of readdirSync(artifactDir).filter((af) =>
									af.endsWith(".md"),
								)) {
									const raw = readFileSync(join(artifactDir, f), "utf8")
									const { data: aData } = parseFrontmatter(raw)
									const aName = (aData.name as string) || f.replace(/\.md$/, "")
									const wanted =
										kind === "outputs" ? input.output : input.discovery
									if (aName !== wanted) continue
									const loc = (aData.location as string) || ""
									if (!loc) continue
									const relPath = loc.replace(
										/^\.haiku\/intents\/\{intent-slug\}\//,
										"",
									)
									const absPath = join(intentPath2, relPath)
									if (existsSync(absPath)) existingUpstreamPaths.push(relPath)
								}
							}
						}
					}
				}
			}

			for (const f of readdirSync(repairUnitsDir, { withFileTypes: true })) {
				if (!(f.isFile() && f.name.endsWith(".md"))) continue
				if (!REPAIR_UNIT_PATTERN.test(f.name)) {
					issues.push({
						intent: slug,
						field: `stages/${stageName}/units/${f.name}`,
						severity: "warning",
						message: `Unit filename doesn't match expected pattern`,
						fix: "Rename to match pattern: unit-NN-slug-name.md",
					})
				}
				const unitRaw = readFileSync(join(repairUnitsDir, f.name), "utf8")
				const { removed: unitDupes } = dedupeFrontmatterKeys(unitRaw)
				if (unitDupes.length > 0) {
					issues.push({
						intent: slug,
						field: `stages/${stageName}/units/${f.name}:frontmatter-duplicate-keys`,
						severity: "warning",
						message: `Duplicate frontmatter keys in unit: ${unitDupes.join(", ")}`,
						fix: "Rewrite frontmatter with duplicate keys removed (last value wins)",
					})
				}
				const { data: unitData } = parseFrontmatter(unitRaw)
				if (!unitData.status) {
					issues.push({
						intent: slug,
						field: `stages/${stageName}/units/${f.name}:status`,
						severity: "warning",
						message: `Unit missing 'status' field`,
						fix: "Add `status` field to unit frontmatter",
					})
				}
				const unitStatus = (unitData.status as string) || ""
				if (["complete", "skipped", "failed"].includes(unitStatus)) continue
				const unitInputs =
					(unitData.inputs as string[]) || (unitData.refs as string[]) || []
				if (unitInputs.length === 0) {
					const fix =
						existingUpstreamPaths.length > 0
							? `Add \`inputs:\` with upstream paths: ${existingUpstreamPaths.join(", ")}`
							: "Add `inputs:` with at minimum the intent doc and discovery docs"
					issues.push({
						intent: slug,
						field: `stages/${stageName}/units/${f.name}:inputs`,
						severity: "error",
						message: "Unit has no `inputs:` — execution will be blocked",
						fix,
					})
				}
			}
		}
	}

	// p. Git-based date repair: derive dates from commit history
	if (isGitRepo()) {
		const intentFilePath = join(intentsDir, slug, "intent.md")
		const gitCreated = gitFirstCommitDateForRepair(intentFilePath)
		const gitLastModified = gitLastCommitDateForRepair(join(intentsDir, slug))
		const currentCreatedAt = repairData.created_at as string | undefined
		const currentStartedAt = repairData.started_at as string | undefined
		const currentCompletedAt = repairData.completed_at as string | undefined

		if (gitCreated && currentCreatedAt) {
			const gitDate = gitCreated.slice(0, 10)
			const fmDate =
				typeof currentCreatedAt === "string"
					? currentCreatedAt.slice(0, 10)
					: ""
			if (gitDate !== fmDate) {
				issues.push({
					intent: slug,
					field: "created_at",
					severity: "warning",
					message: `created_at '${fmDate}' doesn't match git history '${gitDate}'`,
					fix: `Update created_at to '${gitCreated}' (from git first commit)`,
				})
			}
		}

		if (gitCreated && currentStartedAt) {
			const gitDate = gitCreated.slice(0, 10)
			const fmDate =
				typeof currentStartedAt === "string"
					? currentStartedAt.slice(0, 10)
					: ""
			if (gitDate !== fmDate) {
				issues.push({
					intent: slug,
					field: "started_at",
					severity: "warning",
					message: `started_at '${fmDate}' doesn't match git history '${gitDate}'`,
					fix: `Update started_at to '${gitCreated}' (from git first commit)`,
				})
			}
		}

		if (
			repairData.status === "completed" &&
			gitLastModified &&
			currentCompletedAt
		) {
			const gitDate = gitLastModified.slice(0, 10)
			const fmDate =
				typeof currentCompletedAt === "string"
					? currentCompletedAt.slice(0, 10)
					: ""
			if (gitDate !== fmDate) {
				issues.push({
					intent: slug,
					field: "completed_at",
					severity: "warning",
					message: `completed_at '${fmDate}' doesn't match git history '${gitDate}'`,
					fix: `Update completed_at to '${gitLastModified}' (from git last commit)`,
				})
			}
		}

		if (gitCreated && !currentStartedAt) {
			issues.push({
				intent: slug,
				field: "started_at",
				severity: "warning",
				message: "Missing started_at field",
				fix: `Set started_at to '${gitCreated}' (from git first commit)`,
			})
		}

		if (
			repairData.status === "completed" &&
			gitLastModified &&
			!currentCompletedAt
		) {
			issues.push({
				intent: slug,
				field: "completed_at",
				severity: "warning",
				message: "Completed intent missing completed_at field",
				fix: `Set completed_at to '${gitLastModified}' (from git last commit)`,
			})
		}
	}

	return issues
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

export interface BranchRepairSummary {
	slug: string
	branch: string
	scanned: number
	applied: AppliedFix[]
	remaining: RepairIssue[]
	committed: boolean
	pushed: boolean
	error?: string
	pushError?: string
	merged: boolean
	prUrl?: string
	prError?: string
	setupError?: string
}

/** Repair every haiku/<slug>/main branch sequentially using temporary worktrees. */
export function repairAllBranches(autoApply: boolean): {
	summaries: BranchRepairSummary[]
	mainline: string
	archivedSummary?: BranchRepairSummary
} {
	fetchOrigin()
	const mainline = getMainlineBranch()
	const summaries: BranchRepairSummary[] = []

	// Phase 1: Create missing main branches for orphan discrete intents.
	if (autoApply) {
		const orphans = listOrphanDiscreteIntents()
		for (const { slug, branches: stageBranches } of orphans) {
			const stageNames = stageBranches.map((b) =>
				b.replace(`haiku/${slug}/`, ""),
			)

			try {
				const firstBranch = stageBranches[0]
				const intentRaw = readFileFromBranch(
					firstBranch,
					`.haiku/intents/${slug}/intent.md`,
				)
				if (intentRaw) {
					const { data: intentFm } = parseFrontmatter(intentRaw)
					const studioName = (intentFm.studio as string) || ""
					if (studioName) {
						const studioInfo = resolveStudio(studioName)
						if (studioInfo && studioInfo.stages.length > 0) {
							const pipelineOrder = studioInfo.stages
							stageNames.sort((a, b) => {
								const ai = pipelineOrder.indexOf(a)
								const bi = pipelineOrder.indexOf(b)
								return (
									(ai === -1 ? pipelineOrder.length : ai) -
									(bi === -1 ? pipelineOrder.length : bi)
								)
							})
						}
					}
				}
			} catch {
				// Can't resolve pipeline order — alphabetical fallback
			}

			try {
				const result = consolidateStageBranches(slug, stageNames)
				if (result.success) {
					try {
						execFileSync(
							"git",
							["push", "-u", "origin", `haiku/${slug}/main`],
							{ encoding: "utf8", stdio: "pipe" },
						)
					} catch {
						// push failed — still continue with local repair
					}
				}
			} catch (err) {
				summaries.push({
					slug,
					branch: `haiku/${slug}/main`,
					scanned: 0,
					applied: [],
					remaining: [],
					committed: false,
					pushed: false,
					merged: false,
					pushError: `Failed to create main from stage branches: ${err instanceof Error ? err.message : String(err)}`,
				})
			}
		}
	}

	// Phase 2: Repair all main branches
	const branches = listIntentBranches()

	for (const slug of branches) {
		const branch = `haiku/${slug}/main`
		let worktreePath = ""
		const summary: BranchRepairSummary = {
			slug,
			branch,
			scanned: 0,
			applied: [],
			remaining: [],
			committed: false,
			pushed: false,
			merged: false,
		}
		try {
			worktreePath = addTempWorktree(branch, "haiku-repair", true)
		} catch (err) {
			summary.error = `Failed to create worktree: ${err instanceof Error ? err.message : String(err)}`
			summaries.push(summary)
			continue
		}

		try {
			const worktreeHaikuRoot = join(worktreePath, ".haiku")
			const result = repairCwd(worktreeHaikuRoot, undefined, autoApply)
			summary.scanned = result.scanned
			summary.applied = result.applied
			summary.remaining = result.remaining

			const intentMd = join(worktreeHaikuRoot, "intents", slug, "intent.md")
			if (existsSync(intentMd)) {
				const fm = parseFrontmatter(readFileSync(intentMd, "utf8"))
				if (
					fm.data.status === "completed" &&
					!isBranchMerged(branch, mainline)
				) {
					const issue: RepairIssue = {
						intent: slug,
						field: "status",
						severity: "error",
						message: `Intent marked 'completed' but branch '${branch}' is not merged into '${mainline}'`,
						fix: `Either merge the branch into '${mainline}' or set status to 'active'`,
					}
					summary.remaining.push(issue)
				}
			}

			if (autoApply && result.applied.length > 0) {
				const wasAlreadyMerged = isBranchMerged(branch, mainline)
				const messageLines = [
					`repair: auto-fix ${result.applied.length} metadata issue(s)`,
					"",
					...result.applied.map(
						(a) => `- ${a.intent}/${a.field}: ${a.description}`,
					),
				]
				const push = commitAndPushFromWorktree(
					worktreePath,
					branch,
					messageLines.join("\n"),
				)
				summary.committed = push.committed
				summary.pushed = push.pushed
				summary.pushError = push.pushError
				if (push.committed && push.pushed && wasAlreadyMerged) {
					summary.merged = true
					const prResult = openPullRequest(
						branch,
						mainline,
						`repair: metadata fixes for ${slug}`,
						`Auto-applied repair fixes (branch was already merged into \`${mainline}\`):\n\n${result.applied.map((a) => `- **${a.intent}/${a.field}**: ${a.description}`).join("\n")}`,
					)
					if (prResult.ok) summary.prUrl = prResult.url
					else summary.prError = prResult.error
				}
			}
		} finally {
			if (worktreePath) removeTempWorktree(worktreePath)
		}

		summaries.push(summary)
	}

	const archivedSummary = repairArchivedOnMainline(
		branches,
		mainline,
		autoApply,
	)

	return { summaries, mainline, archivedSummary }
}

/** Scan mainline for intents without a matching haiku/<slug>/main branch (archived)
 *  and repair them via a new branch + PR. Returns a combined summary or undefined
 *  if there's nothing to do. */
function repairArchivedOnMainline(
	activeBranches: string[],
	mainline: string,
	autoApply: boolean,
): BranchRepairSummary | undefined {
	const activeSet = new Set(activeBranches)
	const repairBranch = `repair/archived-intents-${Date.now()}`
	const summary: BranchRepairSummary = {
		slug: "<archived intents>",
		branch: repairBranch,
		scanned: 0,
		applied: [],
		remaining: [],
		committed: false,
		pushed: false,
		merged: false,
	}

	let worktreePath = ""
	try {
		worktreePath = addTempWorktree(mainline, "haiku-repair-archived", true)
	} catch (err) {
		summary.setupError = `Failed to create mainline worktree: ${err instanceof Error ? err.message : String(err)}`
		return summary
	}

	try {
		const worktreeHaikuRoot = join(worktreePath, ".haiku")
		const intentsDir = join(worktreeHaikuRoot, "intents")
		if (!existsSync(intentsDir)) {
			return undefined
		}

		const mainlineSlugs = readdirSync(intentsDir, { withFileTypes: true })
			.filter(
				(d) =>
					d.isDirectory() && existsSync(join(intentsDir, d.name, "intent.md")),
			)
			.map((d) => d.name)

		const archivedSlugs = mainlineSlugs.filter((s) => !activeSet.has(s))
		if (archivedSlugs.length === 0) {
			return undefined
		}

		const { studioMap, searchPaths } = buildStudioMap(worktreeHaikuRoot)

		for (const slug of archivedSlugs) {
			let issues = scanOneIntent(intentsDir, slug, studioMap, searchPaths)
			summary.scanned++
			if (autoApply && issues.length > 0) {
				const result = applyAutoFixes(intentsDir, slug, issues)
				summary.applied.push(...result.applied)
				if (result.applied.length > 0) {
					issues = scanOneIntent(intentsDir, slug, studioMap, searchPaths)
				}
			}
			if (issues.length > 0) summary.remaining.push(...issues)
		}

		if (autoApply && summary.applied.length > 0) {
			const messageLines = [
				`repair: auto-fix ${summary.applied.length} issue(s) in archived intent(s)`,
				"",
				...summary.applied.map(
					(a) => `- ${a.intent}/${a.field}: ${a.description}`,
				),
			]
			const push = commitAndPushFromWorktree(
				worktreePath,
				repairBranch,
				messageLines.join("\n"),
			)
			summary.committed = push.committed
			summary.pushed = push.pushed
			summary.pushError = push.pushError

			if (push.committed && push.pushed) {
				const prResult = openPullRequest(
					repairBranch,
					mainline,
					"repair: metadata fixes for archived intents",
					`Auto-applied repair fixes for archived intents on \`${mainline}\`:\n\n${summary.applied.map((a) => `- **${a.intent}/${a.field}**: ${a.description}`).join("\n")}`,
				)
				if (prResult.ok) summary.prUrl = prResult.url
				else summary.prError = prResult.error
			}
		}
	} finally {
		if (worktreePath) removeTempWorktree(worktreePath)
	}

	if (summary.scanned > 0 || summary.setupError) return summary
	return undefined
}

export function buildMultiBranchReport(
	summaries: BranchRepairSummary[],
	mainline: string,
	archivedSummary?: BranchRepairSummary,
): string {
	if (summaries.length === 0 && !archivedSummary) {
		return "No intent branches or archived intents found in this repository."
	}
	const lines: string[] = [
		"# Multi-Branch Repair Report",
		"",
		`Scanned ${summaries.length} intent branch(es). Mainline: \`${mainline}\`.`,
		"",
	]
	const totalApplied =
		summaries.reduce((sum, s) => sum + s.applied.length, 0) +
		(archivedSummary?.applied.length ?? 0)
	const totalRemaining =
		summaries.reduce((sum, s) => sum + s.remaining.length, 0) +
		(archivedSummary?.remaining.length ?? 0)
	const totalPushed =
		summaries.filter((s) => s.pushed).length + (archivedSummary?.pushed ? 1 : 0)
	const mergedBranchPRs = summaries.filter((s) => s.prUrl).length
	const archivedRepairPR = archivedSummary?.prUrl ? 1 : 0
	const prSummary =
		mergedBranchPRs > 0 && archivedRepairPR > 0
			? `${mergedBranchPRs} PR(s) for already-merged branches + 1 PR for archived intents`
			: mergedBranchPRs > 0
				? `${mergedBranchPRs} PR(s) opened for already-merged branches`
				: archivedRepairPR > 0
					? "1 PR opened for archived intents"
					: "no PRs opened"
	lines.push(
		`**Summary:** ${totalApplied} fix(es) auto-applied across ${totalPushed} branch(es); ${prSummary}; ${totalRemaining} issue(s) still need attention.`,
	)
	lines.push("")

	for (const s of summaries) {
		lines.push(`## \`${s.branch}\``)
		lines.push("")
		lines.push(`- Scanned: ${s.scanned} intent(s)`)
		lines.push(`- Auto-applied: ${s.applied.length}`)
		lines.push(`- Remaining: ${s.remaining.length}`)
		if (s.committed && s.pushed)
			lines.push(`- Committed and pushed to \`origin/${s.branch}\``)
		else if (s.committed)
			lines.push(
				`- Committed locally; push failed: ${s.pushError || "unknown"}`,
			)
		else if (s.error) lines.push(`- Error: ${s.error}`)
		else if (s.pushError) lines.push(`- Push error: ${s.pushError}`)
		if (s.merged && s.prUrl)
			lines.push(
				`- Branch already merged into \`${mainline}\` — opened PR/MR: ${s.prUrl}`,
			)
		else if (s.merged && s.prError)
			lines.push(
				`- Branch already merged into \`${mainline}\` — failed to open PR: ${s.prError}`,
			)
		if (s.applied.length > 0) {
			lines.push("")
			lines.push("**Fixes applied:**")
			for (const f of s.applied) {
				lines.push(`- ${f.intent}/${f.field}: ${f.description}`)
			}
		}
		if (s.remaining.length > 0) {
			lines.push("")
			lines.push("**Remaining issues (need agent attention):**")
			for (const i of s.remaining) {
				lines.push(
					`- **${i.intent}**/${i.field} (${i.severity}): ${i.message} → ${i.fix}`,
				)
			}
		}
		lines.push("")
	}

	if (archivedSummary) {
		lines.push("## Archived intents (mainline only)")
		lines.push("")
		if (archivedSummary.setupError) {
			lines.push(
				`- **Mainline worktree setup failed:** ${archivedSummary.setupError}`,
			)
			lines.push(
				"- No archived intents were scanned. Fix the underlying git/filesystem issue and re-run `/repair`.",
			)
			lines.push("")
			return lines.join("\n")
		}
		lines.push(`- Scanned: ${archivedSummary.scanned} archived intent(s)`)
		lines.push(`- Auto-applied: ${archivedSummary.applied.length}`)
		lines.push(`- Remaining: ${archivedSummary.remaining.length}`)
		if (archivedSummary.committed && archivedSummary.pushed) {
			lines.push(`- Pushed repair branch \`origin/${archivedSummary.branch}\``)
		} else if (archivedSummary.pushError) {
			lines.push(`- Push error: ${archivedSummary.pushError}`)
		}
		if (archivedSummary.prUrl) {
			lines.push(`- Opened PR/MR: ${archivedSummary.prUrl}`)
		} else if (archivedSummary.prError) {
			lines.push(`- Failed to open PR: ${archivedSummary.prError}`)
		}
		if (archivedSummary.applied.length > 0) {
			lines.push("")
			lines.push("**Fixes applied:**")
			for (const f of archivedSummary.applied) {
				lines.push(`- ${f.intent}/${f.field}: ${f.description}`)
			}
		}
		if (archivedSummary.remaining.length > 0) {
			lines.push("")
			lines.push("**Remaining issues (need agent attention):**")
			for (const i of archivedSummary.remaining) {
				lines.push(
					`- **${i.intent}**/${i.field} (${i.severity}): ${i.message} → ${i.fix}`,
				)
			}
		}
		lines.push("")
	}

	return lines.join("\n")
}
