// state/scan-intent.ts — Pure repair scanner for a single intent.
//
// Reads `.haiku/intents/<slug>/intent.md` (and stage state files / unit
// files / studio definitions) and returns the list of `RepairIssue`
// records the autofix layer can act on. No mutation here — this
// module is the validation half of the repair subsystem; mechanical
// fixes live in `repair.ts::applyAutoFixes`.

import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { dedupeFrontmatterKeys } from "@haiku/shared/frontmatter"
import { resolveStudio } from "../studio-reader.js"
import {
	INTENT_TITLE_MAX_LENGTH,
	intentTitleNeedsRepair,
	type RepairIssue,
} from "./repair.js"
import { isGitRepo, parseFrontmatter, readJson } from "./shared.js"

const REPAIR_UNIT_PATTERN = /^unit-\d{2,}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/

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
						"Missing state.json for stage before active_stage — workflow will reset backwards",
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
