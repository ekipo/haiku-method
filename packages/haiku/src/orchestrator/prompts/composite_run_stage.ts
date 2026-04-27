// orchestrator/prompts/composite_run_stage.ts — A composite intent
// is borrowing a stage from another studio. Inline the foreign
// studio + stage definitions so the agent has the right mandate
// without leaving the prompt.

import { readStageDef, readStudio } from "../../studio-reader.js"
import { definePromptBuilder } from "./define.js"

export default definePromptBuilder(({ slug, studio, action }) => {
	const stage = action.stage as string
	const compositeStudio = (action.studio as string) || studio
	const hats = (action.hats as string[]) || []

	const parts: string[] = []

	const compositeStudioData = readStudio(compositeStudio)
	if (compositeStudioData?.body) {
		parts.push(`### Studio: ${compositeStudio}\n\n${compositeStudioData.body}`)
	}

	const compositeStageDef = readStageDef(compositeStudio, stage)
	parts.push(`## Composite: Run ${compositeStudio}:${stage}`)
	parts.push(`Hats: ${hats.join(" -> ")}`)
	if (compositeStageDef) {
		parts.push(`### Stage Definition\n\n${compositeStageDef.body}`)
	}

	parts.push(
		`### Instructions\n\nThe orchestrator is running a composite studio:stage. This stage belongs to the "${compositeStudio}" studio.\n\nCall \`haiku_run_next { intent: "${slug}" }\` to get the next action.`,
	)

	return parts.join("\n\n")
})
