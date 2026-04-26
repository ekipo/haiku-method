// orchestrator/prompts/pre_review_revisit.ts — Pending spec-level
// findings block the advance to execute. Resolution mode is SPEC
// EDIT (not new units): each finding is a bug in an existing unit
// spec, fix in place. Closure happens through haiku_feedback_update,
// not by drafting new units.

import { definePromptBuilder } from "./define.js"

interface PendingItem {
	feedback_id: string
	title: string
	file: string
	origin: string
	author: string
}

export default definePromptBuilder(({ slug, action }) => {
	const stage = action.stage as string
	const unitsDir = (action.units_dir as string) || ""
	const pendingCount = (action.pending_count as number) || 0
	const pendingItems = (action.pending_items as PendingItem[]) || []

	const sections: string[] = []
	sections.push(`## Pre-Execute Spec Revisit: ${stage}`)
	sections.push(
		`**${pendingCount} pending spec-level feedback item(s) block the advance to execute.**`,
	)
	sections.push(
		`**Resolution mode: SPEC EDIT (not new units).** This is NOT additive-elaboration. The findings are about bugs in existing unit specs — fix them by editing the unit.md files in \`${unitsDir}\`. Do not draft new units.`,
	)
	sections.push(
		`### Pending Spec Findings\n\n${pendingItems
			.map(
				(f) =>
					`- **${f.feedback_id}** — ${f.title}\n  - file: \`${f.file}\`\n  - origin: ${f.origin} · author: ${f.author}`,
			)
			.join("\n")}`,
	)
	sections.push(
		`### Mechanics\n\n1. Read each pending feedback file IN FULL — the body carries the concrete spec edit the reviewer proposed.\n2. Apply the edit to the referenced unit.md file (frontmatter or body as appropriate).\n3. Close the feedback via \`haiku_feedback_update { intent: "${slug}", stage: "${stage}", feedback_id: "FB-NN", status: "closed", closed_by: "<unit-name>" }\`. If you disagree with a finding, reject it with \`haiku_feedback_reject\` and a concrete reason.\n4. When zero pending feedback remains, call \`haiku_run_next\` to advance to execute.`,
	)

	return sections.join("\n\n")
})
