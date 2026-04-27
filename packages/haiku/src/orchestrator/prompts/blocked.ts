// orchestrator/prompts/blocked.ts — Units are blocked. Report to
// the user and ask for guidance — no autonomous unblocking.

import { definePromptBuilder } from "./define.js"

export default definePromptBuilder(({ action }) => {
	const blockedUnits = (action.blocked_units as string[]) || []
	return `## Blocked\n\nUnits are blocked: ${blockedUnits.join(", ")}\n\n### Instructions\n\nReport which units are blocked and why. Ask the user for guidance.`
})
