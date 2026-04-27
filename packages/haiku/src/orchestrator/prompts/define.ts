// orchestrator/prompts/define.ts — Identity helper for per-action
// prompt builders. Locks in the PromptBuilder shape so per-file
// modules get full IntelliSense + compile errors when the
// signature drifts.

import type { PromptBuilder } from "./types.js"

export function definePromptBuilder(builder: PromptBuilder): PromptBuilder {
	return builder
}
