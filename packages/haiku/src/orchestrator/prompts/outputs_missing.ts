// orchestrator/prompts/outputs_missing.ts — Stage didn't produce
// required output artifacts. Surfaces the validator message verbatim.

import { definePromptBuilder } from "./define.js"

export default definePromptBuilder(({ action }) => {
	return `## Missing Required Outputs\n\n${action.message}`
})
