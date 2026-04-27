// orchestrator/prompts/fix_quality_gates.ts — Quality-gate failure
// fixup loop. Lists the failures and instructs the agent to fix +
// retry. Adversarial review re-runs after gates pass.

import { definePromptBuilder } from "./define.js"

export default definePromptBuilder(({ slug, action }) => {
	return `## Quality Gates Failed\n\n${action.message || "No details provided."}\n\n### Instructions\n\nFix each failing gate, then call \`haiku_run_next { intent: "${slug}" }\` to retry. The orchestrator will re-run the gates before proceeding to adversarial review.`
})
