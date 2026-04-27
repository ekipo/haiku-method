// orchestrator/prompts/gate_review.ts — Stage gate is open and
// awaiting human approval. Tells the agent to call haiku_run_next,
// which opens the review UI and blocks until the user decides.

import { definePromptBuilder } from "./define.js"

export default definePromptBuilder(({ slug, action }) => {
	const stage = action.stage as string
	const nextStage = action.next_stage as string | null

	return `## Gate: Awaiting Approval\n\nStage "${stage}" is complete and awaiting your approval to advance${nextStage ? ` to "${nextStage}"` : ""}.\n\n### Instructions\n\n1. Call \`haiku_run_next { intent: "${slug}" }\` — the orchestrator opens the review UI and blocks until the user responds\n2. If approved: the the workflow engine advances automatically\n3. If changes_requested: analyze annotations and route to /haiku:refine for the appropriate upstream stage`
})
