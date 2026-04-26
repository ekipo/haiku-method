// orchestrator/prompts/inputs_missing.ts — Units lack required
// inputs: declarations. Tells the agent to add them and retry.

import { definePromptBuilder } from "./define.js"

export default definePromptBuilder(({ slug, action }) => {
	return `## Missing Inputs\n\n${action.message || "Units are missing required input references."}\n\n### Instructions\n\nAdd \`inputs:\` to each unit's frontmatter referencing the artifacts it needs, then call \`haiku_run_next { intent: "${slug}" }\` to retry.`
})
