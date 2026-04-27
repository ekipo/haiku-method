// orchestrator/prompts/advance_phase.ts — Prompt for the
// advance_phase action. Notifies the agent which phase it just
// transitioned into and instructs it to call haiku_run_next
// immediately.

import { definePromptBuilder } from "./define.js"

export default definePromptBuilder(({ slug, action }) => {
	const toPhase = action.to_phase as string
	return `## Advance Phase\n\nPhase advanced to "${toPhase}" by the orchestrator.\n\n**Call \`haiku_run_next { intent: "${slug}" }\` immediately.** Do NOT ask the user — the transition was already approved.`
})
