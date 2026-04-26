// orchestrator/prompts/awaiting_external_review.ts — Stage is
// blocked on an external review. Tells the agent to inform the user
// — the orchestrator polls automatically and /haiku:pickup resumes
// once approval lands.

import { definePromptBuilder } from "./define.js"

export default definePromptBuilder(({ action }) => {
	const externalUrl = (action.external_review_url as string) || ""
	return `## Awaiting External Review\n\n${
		externalUrl
			? `The stage is awaiting external review at: ${externalUrl}`
			: "The stage is awaiting external review but no review URL has been recorded."
	}\n\nThe orchestrator checks for approval automatically. Neither detected approval yet.\n\nInform the user that the stage is waiting on external review. After the review is approved, run \`/haiku:pickup\` to continue.`
})
