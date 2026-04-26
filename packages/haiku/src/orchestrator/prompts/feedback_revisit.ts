// orchestrator/prompts/feedback_revisit.ts — Phase rolled back to
// elaborate because pending feedback blocks the gate. Tells the
// agent this is an ADDITIVE elaboration (not a re-plan): create
// new units that close each pending feedback item.

import { definePromptBuilder } from "./define.js"

interface PendingItem {
	feedback_id: string
	title: string
	origin: string
	author: string
}

export default definePromptBuilder(({ slug, action }) => {
	const fbStage = action.stage as string
	const fbPendingCount = action.pending_count as number
	const fbIteration =
		(action.iteration as number) || (action.visits as number) || 0
	const fbItems = (action.pending_items as PendingItem[]) || []

	const itemList = fbItems
		.map(
			(item) =>
				`- **${item.feedback_id}**: ${item.title} (origin: ${item.origin}, author: ${item.author})`,
		)
		.join("\n")

	return `## Feedback Revisit: ${fbStage}\n\n**${fbPendingCount} pending feedback item(s) block the gate.** The FSM has rolled the phase back to \`elaborate\` (iteration #${fbIteration}).\n\n### Pending Feedback\n\n${itemList}\n\n### Instructions (Additive Elaboration)\n\nThis is an **additive elaborate** cycle — do NOT re-plan existing units.\n\n1. Read each pending feedback file from \`.haiku/intents/${slug}/stages/${fbStage}/feedback/\`\n2. For each feedback item, create a new unit that addresses the finding\n3. Each new unit MUST have a \`closes:\` frontmatter field referencing the feedback ID(s) it addresses — e.g. \`closes: [FB-01, FB-03]\`\n4. When all pending items are covered by units, call \`haiku_run_next { intent: "${slug}" }\`\n5. The agent will execute the new units and re-enter review → gate\n\n**Do NOT modify or re-queue existing completed units from prior iterations.**`
})
