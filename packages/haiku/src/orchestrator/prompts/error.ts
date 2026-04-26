// orchestrator/prompts/error.ts — Generic error surface. Whatever
// produced the error attached the human-readable text to
// action.message; the prompt just renders it.

import { definePromptBuilder } from "./define.js"

export default definePromptBuilder(({ action }) => {
	return `## Error\n\n${action.message}`
})
