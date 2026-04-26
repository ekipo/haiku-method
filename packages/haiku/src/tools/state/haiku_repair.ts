// tools/state/haiku_repair.ts — Scan intents for metadata issues and
// optionally auto-apply safe fixes.
//
// Default behavior in a git repo: scan ALL intent branches sequentially
// via temporary worktrees, auto-apply safe fixes, push to each branch,
// and open a PR/MR if the branch was already merged into mainline.
//
// Args:
//   intent        — single intent slug to repair (cwd only, skips multi-branch)
//   apply         — auto-apply safe fixes (default: true)
//   skip_branches — force cwd-only mode even in a git repo
//
// The MCP applies what it can mechanically; the agent handles judgment calls.

import {
	buildMultiBranchReport,
	buildRepairReport,
	type RepairCwdResult,
	repairAllBranches,
	repairCwd,
} from "../../state/repair.js"
import { findHaikuRoot, isGitRepo } from "../../state/shared.js"
import { defineTool } from "../define.js"
import { text } from "./_text.js"

export default defineTool({
	name: "haiku_repair",
	description:
		"Scan intent metadata, auto-apply safe fixes, and report what's left. In a git repo, scans every intent branch via temp worktrees by default; pass `skip_branches: true` or `intent: <slug>` to limit scope.",
	inputSchema: {
		type: "object" as const,
		properties: {
			intent: {
				type: "string",
				description:
					"Single intent slug. Forces cwd-only mode (skips multi-branch scan).",
			},
			apply: {
				type: "boolean",
				description: "Auto-apply safe fixes. Default true.",
			},
			skip_branches: {
				type: "boolean",
				description: "Force cwd-only mode even in a git repo.",
			},
		},
	},
	handle(args) {
		const repairIntentArg = args.intent as string | undefined
		const repairAutoApply = args.apply !== false
		const repairSkipBranches = args.skip_branches === true

		// Multi-branch path: in a git repo, no single-intent restriction,
		// branches not skipped. Runs even with no active branches — the
		// archived pass handles the all-merged case.
		if (isGitRepo() && !repairIntentArg && !repairSkipBranches) {
			try {
				const { summaries, mainline, archivedSummary } =
					repairAllBranches(repairAutoApply)
				if (summaries.length > 0 || archivedSummary) {
					return text(
						buildMultiBranchReport(summaries, mainline, archivedSummary),
					)
				}
				// No active branches AND no archived intents — fall through.
			} catch (err) {
				return text(
					`Multi-branch repair failed: ${err instanceof Error ? err.message : String(err)}`,
				)
			}
		}

		// Single-cwd path
		try {
			findHaikuRoot()
		} catch {
			return text("No .haiku/ directory found.")
		}

		let cwdResult: RepairCwdResult
		try {
			cwdResult = repairCwd(undefined, repairIntentArg, repairAutoApply)
		} catch (err) {
			return text(
				`Repair failed: ${err instanceof Error ? err.message : String(err)}`,
			)
		}

		if (repairIntentArg && cwdResult.scanned === 0) {
			return text(`Intent '${repairIntentArg}' not found.`)
		}
		if (cwdResult.scanned === 0) return text("No intents found.")

		return text(buildRepairReport(cwdResult))
	},
})
