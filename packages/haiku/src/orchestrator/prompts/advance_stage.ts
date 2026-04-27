// orchestrator/prompts/advance_stage.ts — Gate passed. The
// orchestrator already advanced to the next stage; the agent just
// needs to call haiku_run_next to drive the next action.

import { definePromptBuilder } from "./define.js"

export default definePromptBuilder(({ slug, action }) => {
	const stage = action.stage as string
	const nextStage = action.next_stage as string
	return `## Advance Stage\n\nGate passed. The orchestrator has advanced from "${stage}" to "${nextStage}".\n\n**Call \`haiku_run_next { intent: "${slug}" }\` immediately.** Do NOT ask the user for confirmation — the gate was already approved. Do NOT present summaries or ask "want me to continue?" — just call the tool.`
})
