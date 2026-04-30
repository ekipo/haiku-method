// orchestrator/prompts/manual_change_assessment.ts — Pre-tick drift gate.
//
// Fires when the drift-detection gate detects one or more files in the
// tracked surface whose SHA-256 has changed since the last baseline
// acknowledgment. The agent must classify each finding before the normal
// stage handler runs.
//
// Action shape (emitted by drift-detection-gate.ts):
//   { action: "manual_change_assessment", findings: DriftFinding[], slug: string }
//
// Classification options per finding:
//   A. Accept the change — call haiku_baseline_init to re-baseline (acknowledges as human-implicit).
//   B. Reject / revert the change — restore the prior file; baseline stays.
//   C. Surface as feedback — create a feedback item via haiku_feedback; a
//      pending-assessment marker is written automatically.
//   D. Trigger a revisit — call haiku_feedback_move to relocate the finding
//      to an earlier stage; marker is written.

import { definePromptBuilder } from "./define.js"

interface DriftFinding {
	path: string
	change_kind: "new-file-detected" | "modified" | "file-removed"
	is_binary: boolean
	diff_unified: string | null
	before_sha256: string | null
	after_sha256: string | null
	before_bytes: number | null
	after_bytes: number | null
	tracking_class: string
	stage: string | null
	context_unit: string | null
	is_baseline_oom?: boolean
}

function formatFinding(finding: DriftFinding, index: number): string {
	const lines: string[] = []

	const kindLabel: Record<string, string> = {
		"new-file-detected": "New file",
		modified: "Modified",
		"file-removed": "Deleted",
	}
	const kind = kindLabel[finding.change_kind] ?? finding.change_kind
	const binaryNote = finding.is_binary ? " (binary)" : ""

	lines.push(`#### ${index + 1}. \`${finding.path}\` — ${kind}${binaryNote}`)

	if (finding.before_sha256 !== null) {
		lines.push(`- Before SHA-256: \`${finding.before_sha256.slice(0, 16)}…\``)
	}
	if (finding.after_sha256 !== null) {
		lines.push(`- After SHA-256:  \`${finding.after_sha256.slice(0, 16)}…\``)
	}
	if (finding.before_bytes !== null && finding.after_bytes !== null) {
		lines.push(`- Size: ${finding.before_bytes} → ${finding.after_bytes} bytes`)
	} else if (finding.after_bytes !== null) {
		lines.push(`- Size: ${finding.after_bytes} bytes (new file)`)
	} else if (finding.before_bytes !== null) {
		lines.push(`- Size: ${finding.before_bytes} bytes (deleted)`)
	}
	if (finding.tracking_class) {
		lines.push(`- Tracking class: \`${finding.tracking_class}\``)
	}

	if (finding.diff_unified) {
		lines.push("", "```diff", finding.diff_unified, "```")
	} else if (!finding.is_binary && finding.change_kind !== "file-removed") {
		lines.push(
			"- _No unified diff available (git history unreachable for this SHA)._",
		)
	}

	return lines.join("\n")
}

export default definePromptBuilder(({ slug, action }) => {
	const findings = (action.findings as DriftFinding[]) || []

	if (findings.length === 0) {
		return [
			"## Manual Change Assessment",
			"",
			"The drift-detection gate fired but produced no findings. This is unexpected.",
			"Call `haiku_run_next` to retry.",
		].join("\n")
	}

	const isOom = findings.length === 1 && findings[0].is_baseline_oom === true

	if (isOom) {
		const stage = findings[0].stage ?? "unknown"
		return [
			"## Manual Change Assessment — Baseline Out-of-Sync",
			"",
			`More than 50% of the tracked surface for stage \`${stage}\` has drifted from the baseline. ` +
				"This typically indicates a large-scale human replacement or an out-of-band sync event.",
			"",
			"**Required action:**",
			"",
			"Call `haiku_baseline_init` to re-establish the baseline against the current worktree state " +
				"before proceeding. This acknowledges all current files as the new baseline.",
			"",
			"If the changes represent unreviewed human work that should be classified individually, " +
				"restore the prior baseline manually and classify each file one at a time.",
			"",
			`Once the baseline is updated, call \`haiku_run_next { intent: "${slug}" }\`.`,
		].join("\n")
	}

	const findingBlocks = findings.map(formatFinding).join("\n\n")

	return [
		"## Manual Change Assessment Required",
		"",
		`The pre-tick drift-detection gate detected **${findings.length} change${findings.length !== 1 ? "s" : ""}** ` +
			"in the tracked surface since the last baseline acknowledgment.",
		"",
		"You must classify every finding below before the normal stage handler can run.",
		"",
		"### Findings",
		"",
		findingBlocks,
		"",
		"### Classification options",
		"",
		"For each finding, choose one of:",
		"",
		"**A. Accept the change** — the human edit is intentional and should be incorporated.",
		"  - Call `haiku_baseline_init` to re-baseline all tracked files.",
		"  - This acknowledges all current on-disk content and clears pending-assessment markers.",
		"",
		"**B. Revert the change** — the human edit should be discarded.",
		"  - Restore the prior file content from the baseline SHA (via `git checkout` or manually).",
		"  - The baseline entry remains unchanged; no marker is written.",
		"",
		"**C. Surface as feedback** — the change should be reviewed in the feedback loop.",
		"  - Call `haiku_feedback` to create a feedback item describing the finding.",
		"  - A pending-assessment marker is written automatically.",
		"  - The gate will suppress re-detection of this file until the feedback reaches a terminal state.",
		"",
		"**D. Trigger a revisit** — the change is relevant to an earlier stage.",
		"  - Call `haiku_feedback_move` to relocate the finding to the appropriate stage.",
		"  - The pre-tick triage gate will revisit the earlier stage on the next tick.",
		"",
		`When every finding is classified, call \`haiku_run_next { intent: "${slug}" }\`.`,
	].join("\n")
})
