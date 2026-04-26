// orchestrator/prompts/safe_intent_repair.ts — Repair pass produced
// either synthesized stages, a phase regression, or both. Surfaces
// what it did and tells the agent to address remaining manual-review
// items before resuming.

import { definePromptBuilder } from "./define.js"

export default definePromptBuilder(({ slug, action }) => {
	const synthesizedStages = (action.synthesized_stages as string[]) || []
	const phaseWasRegressed = action.phase_regressed as boolean
	const parts: string[] = [`## Safe Intent Repair\n\n${action.message}`]
	if (synthesizedStages.length > 0) {
		parts.push(`**Synthesized stages:** ${synthesizedStages.join(", ")}`)
	}
	if (phaseWasRegressed) {
		parts.push(
			"**Phase regressed:** The active stage was regressed from `execute` to `elaborate` because some units are missing `inputs:` declarations. Address the missing inputs before proceeding.",
		)
	}
	parts.push(
		`### Instructions\n\nResolve any stages needing manual review, then call \`haiku_run_next { intent: "${slug}" }\` again.`,
	)
	return parts.join("\n\n")
})
