// orchestrator/prompts/spec_validation_failed.ts — Spec validation
// caught a structural problem (frontmatter, schema). Surfaces the
// validator message verbatim.

import { definePromptBuilder } from "./define.js"

export default definePromptBuilder(({ action }) => {
	return `## Spec Validation Failed\n\n${action.message}`
})
