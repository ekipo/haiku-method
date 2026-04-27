// state/repair-branches.ts — Multi-branch repair: walk every
// haiku/<slug>/main branch via temp worktrees and apply autofixes.
// Plus the archived-intents fallback that scans mainline for
// intents whose stage-branches were reaped without a corresponding
// haiku/<slug>/main and fixes them via a fresh PR branch.
//
// Pure orchestration on top of the per-intent surface in
// state/repair.ts (scanOneIntent, applyAutoFixes, repairCwd).

import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
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
	applyAutoFixes,
	type AppliedFix,
	buildStudioMap,
	repairCwd,
	type RepairIssue,
	scanOneIntent,
} from "./repair.js"
import { parseFrontmatter } from "./shared.js"

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

/** Repair every haiku/<slug>/main branch sequentially using
 *  temporary worktrees. */
export function repairAllBranches(autoApply: boolean): {
	summaries: BranchRepairSummary[]
	mainline: string
	archivedSummary?: BranchRepairSummary
} {
	fetchOrigin()
	const mainline = getMainlineBranch()
	const summaries: BranchRepairSummary[] = []

	// Phase 1: Create missing main branches for orphan discrete
	// intents.
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

/** Scan mainline for intents without a matching haiku/<slug>/main
 *  branch (archived) and repair them via a new branch + PR. Returns
 *  a combined summary or undefined if there's nothing to do. */
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
