// state/active-stage.ts — Active-stage routing, branch enforcement,
// hat resolution, and session-metadata sync.
//
// These helpers all answer the same question in different shapes:
// "what stage / unit / hat is the workflow currently on for this intent?"
// They're used by every state-mutating tool to align reads + writes
// with the right branch and hat sequence.

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import matter from "gray-matter"
import { resolvePluginRoot } from "../config.js"
import { ensureOnStageBranch } from "../git-worktree.js"
import { writeHaikuMetadata } from "../session-metadata.js"
import {
	findHaikuRoot,
	parseFrontmatter,
	readJson,
	stageDir,
	stageStatePath,
	unitPath,
} from "./shared.js"

// ── Active-stage resolution ───────────────────────────────────────────────

/** Resolve the active stage for an intent from its frontmatter. */
export function resolveActiveStage(intent: string): string {
	const root = findHaikuRoot()
	const intentFile = join(root, "intents", intent, "intent.md")
	if (!existsSync(intentFile)) return ""
	const { data } = parseFrontmatter(readFileSync(intentFile, "utf8"))
	return (data.active_stage as string) || ""
}

/**
 * Pre-flight branch enforcement for stage-scoped state-mutating tools.
 *
 * Ensures the MCP's current git checkout is on `haiku/{intent}/{stage}`
 * before the caller writes any stage state. If main drifted ahead (feedback
 * files or state leaked there), merges main → stage first so nothing is lost.
 *
 * Returns null on success (caller continues) or an MCP error response
 * (caller returns it directly) when the branch couldn't be aligned.
 * No-op in filesystem / non-git mode.
 */
export function enforceStageBranch(
	intent: string,
	stage: string | undefined,
): { content: Array<{ type: "text"; text: string }>; isError: true } | null {
	const guard = ensureOnStageBranch(intent, stage)
	if (!guard.ok) {
		// When the block is a dirty tree, return a structured commit_wip
		// action instead of a hard error. The agent commits the listed
		// files (which belong on the current branch) and retries — no
		// human intervention needed.
		if (guard.block === "dirty_tree") {
			const files = guard.dirty_files || []
			const filesBlock =
				files.length > 0
					? `\n\nFiles to commit:\n${files.map((f) => `  - ${f}`).join("\n")}`
					: ""
			const action = {
				action: "commit_wip",
				intent,
				stage: stage ?? null,
				context: "state-tool branch enforcement",
				current_branch: guard.branch,
				target_branch: guard.target_branch || "the target branch",
				dirty_files: files,
				message: `Uncommitted changes on branch '${guard.branch}' block the switch to '${guard.target_branch}'. These changes belong on '${guard.branch}' — commit them there, then retry the tool call. No human intervention needed.${filesBlock}\n\nSteps:\n  1. \`git add ${files.length > 0 ? files.join(" ") : "<files listed above>"}\`\n  2. \`git commit -m "haiku: wip on ${guard.branch}"\`\n  3. Retry the call.`,
			}
			return {
				content: [{ type: "text", text: JSON.stringify(action, null, 2) }],
				isError: true as const,
			}
		}
		return {
			content: [
				{
					type: "text",
					text: `Error: stage-branch enforcement failed for intent '${intent}', stage '${stage ?? "(none)"}' — ${guard.message}`,
				},
			],
			isError: true as const,
		}
	}
	return null
}

/** Find a unit file by searching through stages. Returns { path, stage } or null. */
export function findUnitFile(
	intent: string,
	unit: string,
): { path: string; stage: string } | null {
	const root = findHaikuRoot()
	const activeStage = resolveActiveStage(intent)
	if (activeStage) {
		const p = unitPath(intent, activeStage, unit)
		if (existsSync(p)) return { path: p, stage: activeStage }
	}
	const stagesDir = join(root, "intents", intent, "stages")
	if (!existsSync(stagesDir)) return null
	for (const stage of readdirSync(stagesDir)) {
		const p = unitPath(intent, stage, unit)
		if (existsSync(p)) return { path: p, stage }
	}
	return null
}

// ── Hat resolution ────────────────────────────────────────────────────────

/** The built-in terminal hat auto-injected on any unit that declares
 *  `closes:` feedback items. Verifies the unit's output actually resolves
 *  each claim and marks them closed/addressed; rejects back to the
 *  designer if not. */
export const FEEDBACK_ASSESSOR_HAT = "feedback-assessor"

/** Resolve hat sequence for a stage. Used by haiku_unit_advance_hat /
 *  haiku_unit_reject_hat. */
export function resolveStageHats(intent: string, stage: string): string[] {
	try {
		const root = findHaikuRoot()
		const intentFile = join(root, "intents", intent, "intent.md")
		if (!existsSync(intentFile)) return []
		const { data } = parseFrontmatter(readFileSync(intentFile, "utf8"))
		const studio = (data.studio as string) || ""
		if (!studio) return []

		const pluginRoot = resolvePluginRoot()
		for (const base of [
			join(process.cwd(), ".haiku", "studios"),
			join(pluginRoot, "studios"),
		]) {
			const stageFile = join(base, studio, "stages", stage, "STAGE.md")
			if (!existsSync(stageFile)) continue
			const { data: stageFm } = parseFrontmatter(
				readFileSync(stageFile, "utf8"),
			)
			return (stageFm.hats as string[]) || []
		}
	} catch {
		/* */
	}
	return []
}

/** Resolve the hat sequence for a specific unit. Starts from the stage's
 *  declared hats and appends `feedback-assessor` as the terminal hat when
 *  the unit has `closes:` references — so any unit claiming closures gets
 *  independently verified before completion. */
export function resolveUnitHats(
	intent: string,
	stage: string,
	unit: string,
): string[] {
	const stageHats = resolveStageHats(intent, stage)
	try {
		const p = unitPath(intent, stage, unit)
		if (!existsSync(p)) return stageHats
		const { data } = parseFrontmatter(readFileSync(p, "utf8"))
		const closes = (data.closes as string[]) || []
		if (closes.length > 0 && !stageHats.includes(FEEDBACK_ASSESSOR_HAT)) {
			return [...stageHats, FEEDBACK_ASSESSOR_HAT]
		}
	} catch {
		/* non-fatal */
	}
	return stageHats
}

/** Resolve stage metadata for scope context in tool responses. */
export function resolveStageScope(intent: string, stage: string): string {
	try {
		const root = findHaikuRoot()
		const intentFile = join(root, "intents", intent, "intent.md")
		if (!existsSync(intentFile)) return ""
		const { data } = parseFrontmatter(readFileSync(intentFile, "utf8"))
		const studio = (data.studio as string) || ""
		if (!studio) return ""

		const pluginRoot = resolvePluginRoot()
		for (const base of [
			join(process.cwd(), ".haiku", "studios"),
			join(pluginRoot, "studios"),
		]) {
			const stageFile = join(base, studio, "stages", stage, "STAGE.md")
			if (!existsSync(stageFile)) continue
			const raw = readFileSync(stageFile, "utf8")
			const fm = parseFrontmatter(raw)
			const { content } = matter(raw)
			const desc = (fm.data.description as string) || stage
			return `[stage_scope] ${stage}: ${desc} | ${content.trim().slice(0, 500)}`
		}
	} catch {
		/* */
	}
	return ""
}

// ── Session metadata sync ─────────────────────────────────────────────────

/** Collect current H·AI·K·U state and write to the caller-provided state
 *  file. The state_file path is injected by the pre_tool_use hook — the
 *  MCP server never resolves session IDs or config dirs. If no state_file,
 *  this is a no-op. */
export function syncSessionMetadata(
	intent: string,
	stateFile: string | undefined,
): void {
	if (!stateFile) return
	try {
		const root = findHaikuRoot()
		const intentFile = join(root, "intents", intent, "intent.md")
		if (!existsSync(intentFile)) return
		const { data: intentData } = parseFrontmatter(
			readFileSync(intentFile, "utf8"),
		)
		const studio = (intentData.studio as string) || ""
		const activeStage = (intentData.active_stage as string) || ""

		let phase = ""
		if (activeStage) {
			const sf = stageStatePath(intent, activeStage)
			const stageState = readJson(sf)
			phase = (stageState.phase as string) || ""
		}

		let activeUnit: string | null = null
		let hat: string | null = null
		let bolt: number | null = null
		if (activeStage) {
			const unitsDir = join(stageDir(intent, activeStage), "units")
			if (existsSync(unitsDir)) {
				for (const f of readdirSync(unitsDir).filter((f) =>
					f.endsWith(".md"),
				)) {
					const { data: unitData } = parseFrontmatter(
						readFileSync(join(unitsDir, f), "utf8"),
					)
					if (unitData.status === "active") {
						activeUnit = f.replace(".md", "")
						hat = (unitData.hat as string) || null
						bolt = (unitData.bolt as number) || null
						break
					}
				}
			}
		}

		let stageDescription = activeStage
		if (studio && activeStage) {
			const pluginRoot = resolvePluginRoot()
			for (const base of [
				join(process.cwd(), ".haiku", "studios"),
				join(pluginRoot, "studios"),
			]) {
				const sf = join(base, studio, "stages", activeStage, "STAGE.md")
				if (!existsSync(sf)) continue
				const { data: stageFm } = parseFrontmatter(readFileSync(sf, "utf8"))
				stageDescription = (stageFm.description as string) || activeStage
				break
			}
		}

		writeHaikuMetadata(stateFile, {
			intent,
			studio,
			active_stage: activeStage,
			phase,
			active_unit: activeUnit,
			hat,
			bolt,
			stage_description: stageDescription,
			updated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
		})
	} catch {
		/* non-fatal */
	}
}
