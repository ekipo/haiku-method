// orchestrator/prompts/unresolved_dependencies.ts — Some unit's
// `depends_on` references a unit name that doesn't exist. Tells the
// agent to fix the references then retry.

import { definePromptBuilder } from "./define.js"

export default definePromptBuilder(({ slug, action }) => {
	return `## Unresolved Dependencies\n\n${action.message || "No details provided."}\n\n### Instructions\n\nFix the \`depends_on\` fields in the affected unit files to reference existing unit names, then call \`haiku_run_next { intent: "${slug}" }\` to retry.`
})
