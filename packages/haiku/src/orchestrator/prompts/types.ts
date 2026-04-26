// orchestrator/prompts/types.ts — Per-action prompt-builder contract.
//
// Each `case` in buildRunInstructions's giant switch becomes a
// PromptBuilder living in its own file under
// orchestrator/prompts/{action}.ts. The builder receives the slug,
// studio, action object, and intent-dir, and returns one or more
// prompt sections that get concatenated into the final markdown
// instructions returned to the agent.
//
// Returning `null` is the "decline" signal — the framework falls
// back to the legacy switch arm in orchestrator.ts. This lets the
// migration land per-action without touching every case at once.

import type { OrchestratorAction } from "../../orchestrator.js"

export interface PromptBuilderContext {
	readonly slug: string
	readonly studio: string
	readonly action: OrchestratorAction
	readonly dir: string
}

export type PromptBuilder = (ctx: PromptBuilderContext) => string | null
