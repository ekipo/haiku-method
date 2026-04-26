// orchestrator/prompts/discovery_missing.ts — Surfaces the validator
// message verbatim. The orchestrator builds the human-readable
// guidance into action.message.

import { definePromptBuilder } from "./define.js"

export default definePromptBuilder(({ action }) => {
	return `## Missing Discovery Artifacts\n\n${action.message}`
})
