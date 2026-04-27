// orchestrator/prompts/unit_naming_invalid.ts — Unit file doesn't
// match the unit-NN-slug.md pattern. Tells the agent to rename and
// retry.

import { definePromptBuilder } from "./define.js"

export default definePromptBuilder(({ slug, action }) => {
	return `## Unit Naming Invalid\n\n${action.message || "No details provided."}\n\n### Instructions\n\nRename the affected files to match the \`unit-NN-slug.md\` pattern (e.g., \`unit-01-data-model.md\`), then call \`haiku_run_next { intent: "${slug}" }\` to retry.`
})
