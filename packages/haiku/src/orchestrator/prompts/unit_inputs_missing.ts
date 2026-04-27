// orchestrator/prompts/unit_inputs_missing.ts — Unit declared
// inputs: that don't exist as artifacts on disk. Surfaces the
// validator message verbatim.

import { definePromptBuilder } from "./define.js"

export default definePromptBuilder(({ action }) => {
	return `## Missing Unit Inputs\n\n${action.message}`
})
