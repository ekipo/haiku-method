// orchestrator/prompts/revisited.ts — `revisit()` succeeded. The
// workflow engine rolled the active stage's phase back (typically to elaborate)
// and re-queued units. The agent picks up from the new phase.

import { definePromptBuilder } from "./define.js"

export default definePromptBuilder(({ slug, action }) => {
	const message = (action.message as string) || ""
	const stage = (action.stage as string) || ""
	const targetPhase = (action.target_phase as string) || ""

	return `## Revisited: ${stage}\n\n${message}${targetPhase ? `\n\n**Target phase:** \`${targetPhase}\`` : ""}\n\n### Instructions\n\nCall \`haiku_run_next { intent: "${slug}" }\` to drive the new phase.`
})
