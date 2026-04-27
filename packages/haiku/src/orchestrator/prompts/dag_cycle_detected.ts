// orchestrator/prompts/dag_cycle_detected.ts — Surfaces the cycle
// detector's message verbatim.

import { definePromptBuilder } from "./define.js"

export default definePromptBuilder(({ action }) => {
	return `## Circular Dependency Detected\n\n${action.message}`
})
