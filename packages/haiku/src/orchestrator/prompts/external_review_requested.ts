// orchestrator/prompts/external_review_requested.ts — External
// review (e.g. PR/MR) was requested. Surfaces the message verbatim.

import { definePromptBuilder } from "./define.js"

export default definePromptBuilder(({ action }) => {
	return `## External Review Requested\n\n${action.message || "No details provided."}`
})
