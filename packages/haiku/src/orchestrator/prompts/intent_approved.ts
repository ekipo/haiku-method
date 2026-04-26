// orchestrator/prompts/intent_approved.ts — Prompt for the
// intent_approved action. Tiny — just tells the agent to call
// haiku_run_next immediately, since approval already happened.

import { definePromptBuilder } from "./define.js"

export default definePromptBuilder(({ slug }) => {
	return `## Intent Approved\n\nThe user has approved the intent.\n\n**Call \`haiku_run_next { intent: "${slug}" }\` immediately.** Do NOT ask the user — the transition was already approved.`
})
