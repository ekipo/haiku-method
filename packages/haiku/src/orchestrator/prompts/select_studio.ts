// orchestrator/prompts/select_studio.ts — Tells the agent to call
// haiku_select_studio so the user can pick a lifecycle template.

import { definePromptBuilder } from "./define.js"

export default definePromptBuilder(({ slug }) => {
	return `## Studio Selection Required\n\nThis intent has no studio selected yet.\n\nCall \`haiku_select_studio { intent: "${slug}" }\` to choose a lifecycle studio.\nThe tool will present available studios via elicitation.`
})
