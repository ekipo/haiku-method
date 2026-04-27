// orchestrator/prompts/start_stage.ts — Stage just started. Inline
// the studio + stage definitions and the hat sequence so the agent
// has the full mandate up front. If the intent `follows` another
// intent, instruct loading parent knowledge first.

import { readStageDef, readStudio } from "../../studio-reader.js"
import { definePromptBuilder } from "./define.js"

export default definePromptBuilder(({ slug, studio, action }) => {
	const stage = action.stage as string
	const hats = (action.hats as string[]) || []
	const stageDef = readStageDef(studio, stage)
	const studioData = readStudio(studio)

	const parts: string[] = []
	if (studioData?.body) {
		parts.push(`### Studio: ${studio}\n\n${studioData.body}`)
	}
	parts.push(`## Stage: ${stage}`)
	parts.push(`Hats: ${hats.join(" -> ")}`)
	if (stageDef) {
		parts.push(`### Stage Definition\n\n${stageDef.body}`)
	}
	if (action.follows) {
		parts.push(
			`### Follow-up Context\n\nThis intent follows "${action.follows}". ` +
				`Load parent knowledge artifacts: ${JSON.stringify(action.parent_knowledge)}`,
		)
	}
	parts.push(
		`### Instructions\n\nStage has been started by the orchestrator (status: active, phase: elaborate).\n\n${
			action.follows
				? `1. Load parent knowledge via \`haiku_knowledge_read\` for each file in parent_knowledge\n2. Call \`haiku_run_next { intent: "${slug}" }\` to get the next action\n`
				: `1. Call \`haiku_run_next { intent: "${slug}" }\` to get the next action\n`
		}`,
	)
	return parts.join("\n\n")
})
