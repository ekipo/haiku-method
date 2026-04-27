// orchestrator/prompts/complete.ts — Already-complete signal. Same
// shape as error/discovery_missing — just render action.message.

import { definePromptBuilder } from "./define.js"

export default definePromptBuilder(({ action }) => {
	return `## Already Complete\n\n${action.message}`
})
