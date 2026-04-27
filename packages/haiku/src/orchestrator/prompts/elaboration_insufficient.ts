// orchestrator/prompts/elaboration_insufficient.ts — Elaborate phase
// produced specs that the validator deemed insufficient. Surfaces
// the validator message verbatim.

import { definePromptBuilder } from "./define.js"

export default definePromptBuilder(({ action }) => {
	return `## Elaboration Insufficient\n\n${action.message}`
})
