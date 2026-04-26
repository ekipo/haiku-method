// orchestrator/prompts/upstream_finding_surfaced.ts — Cross-stage
// findings surfaced from review. Groups items by upstream stage so
// the user can decide per-finding: revisit upstream, reject, or
// accept. The FSM never auto-fixes these — the wrong stage's hats
// can't address a different stage's artifacts.

import { definePromptBuilder } from "./define.js"

interface UpstreamItem {
	feedback_id: string
	title: string
	origin: string
	author: string
	upstream_stage: string
	file: string
}

export default definePromptBuilder(({ slug, action }) => {
	const ufsStage = action.stage as string
	const ufsItems = (action.upstream_items as UpstreamItem[]) || []
	const grouped = new Map<string, UpstreamItem[]>()
	for (const item of ufsItems) {
		const list = grouped.get(item.upstream_stage) ?? []
		list.push(item)
		grouped.set(item.upstream_stage, list)
	}
	const groupBlocks: string[] = []
	for (const [upstream, items] of grouped) {
		const lines = items
			.map(
				(i) =>
					`- **${i.feedback_id}** — ${i.title} (origin: ${i.origin}, author: ${i.author})\n  File: \`${i.file}\``,
			)
			.join("\n")
		groupBlocks.push(`**Upstream stage: \`${upstream}\`**\n\n${lines}`)
	}

	return [
		`## Cross-Stage Findings Surfaced: ${ufsStage}`,
		"",
		`Reviewers in stage **${ufsStage}** flagged findings whose root cause lives in a **different stage**. The FSM will NOT fix these with ${ufsStage}'s hats — the wrong hats cannot fix a different stage's artifacts. This is a human decision.`,
		"",
		"### Findings by Upstream Stage",
		"",
		groupBlocks.join("\n\n"),
		"",
		"### Instructions",
		"",
		"Present the findings to the user and ask them to pick ONE of the following per finding:",
		"",
		`1. **Revisit upstream** — call \`haiku_revisit { intent: "${slug}", stage: "<upstream-stage>" }\` to roll the FSM back to that stage. This re-enters the upstream stage's gate and will dispatch the upstream stage's fix loop against the cross-stage finding (which the FSM re-scopes as same-stage for that stage).`,
		`2. **Reject the finding** — call \`haiku_feedback_reject { intent: "${slug}", stage: "${ufsStage}", feedback_id: "<FB-XX>", reason: "<concrete reason>" }\` if the finding is stale, invalid, or out-of-scope for this intent.`,
		`3. **Accept as-is** — the user can manually close the finding via the review UI if they accept the tradeoff.`,
		"",
		"**Do NOT call `haiku_run_next` until the user has decided.** Autonomously choosing a path here is the opposite of what this surface is for.",
	].join("\n")
})
