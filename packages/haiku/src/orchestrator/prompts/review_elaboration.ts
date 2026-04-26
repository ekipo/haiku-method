// orchestrator/prompts/review_elaboration.ts — Run review agents on
// the elaboration specs (units + discovery artifacts) before the
// pre-execution gate opens. Same agent fan-out shape as `review`,
// just scoped to elaborate-phase artifacts. Findings persist via
// haiku_feedback (unlike pre_review which keeps findings inline).

import { join } from "node:path"
import {
	filterReviewAgentsByScope,
	readReviewAgentPaths,
	readStageDef,
} from "../../studio-reader.js"
import { findHaikuRoot } from "../../state-tools.js"
import {
	emitSubagentDispatchBlock,
	inlineFile,
	resolveReviewAgentModel,
} from "./_helpers.js"
import { definePromptBuilder } from "./define.js"

export default definePromptBuilder(({ slug, studio, action }) => {
	const stage = action.stage as string
	let agentPaths: Record<string, string> = readReviewAgentPaths(studio, stage)

	// Cross-stage includes (review-agents-include on STAGE.md).
	{
		const stageDef = readStageDef(studio, stage)
		if (
			stageDef?.data?.["review-agents-include"] &&
			Array.isArray(stageDef.data["review-agents-include"])
		) {
			const includes = stageDef.data["review-agents-include"] as Array<{
				stage: string
				agents: string[]
			}>
			for (const inc of includes) {
				if (!(inc.stage && Array.isArray(inc.agents))) continue
				const crossPaths = readReviewAgentPaths(studio, inc.stage)
				for (const agentName of inc.agents) {
					if (crossPaths[agentName] && !agentPaths[agentName]) {
						agentPaths[`${agentName} (from ${inc.stage})`] =
							crossPaths[agentName]
					}
				}
			}
		}
	}

	// Conditional review: skip agents whose `applies_to:` doesn't match.
	agentPaths = filterReviewAgentsByScope(
		agentPaths,
		join(findHaikuRoot(), "intents", slug, "stages", stage, "artifacts"),
		{ studio, stage },
	)

	const sections: string[] = []
	sections.push("## Review Elaboration Artifacts")
	sections.push(
		"Run adversarial review agents on the elaboration specs before the pre-execution gate opens.",
	)

	if (Object.keys(agentPaths).length > 0) {
		sections.push(
			"### Review Agent Fan-Out (REQUIRED)\n\n**Spawn exactly one subagent per review agent in parallel — no duplicates.** Each `<subagent>` block below is a complete prompt — relay verbatim. Prompts are path-based so the parent context stays small.\n",
		)
		for (const [name, mandatePath] of Object.entries(agentPaths)) {
			const prompt = [
				`You are the **${name}** review agent reviewing elaboration artifacts for stage "${stage}" of intent "${slug}".`,
				"",
				"## Required context (inlined below)",
				"Your review mandate is embedded in this prompt.",
				"",
				inlineFile(mandatePath, `Mandate: ${name}`),
				"",
				"## Write scope (STRICT)",
				"**You MUST NOT write, edit, or create any file.** Your ONLY output channel is the `haiku_feedback` MCP tool. If you're tempted to fix an issue yourself, log it as feedback instead. Any file write is a scope violation.",
				"",
				"## Instructions",
				"",
				"1. Use your mandate (above) as the lens for this review.",
				`2. Read the elaboration specs: unit files in \`.haiku/intents/${slug}/stages/${stage}/units/\`.`,
				`3. Read discovery artifacts in \`.haiku/intents/${slug}/knowledge/\`.`,
				"4. Review through your mandate's lens.",
				`5. For each issue you find, call \`haiku_feedback({ intent: "${slug}", stage: "${stage}", title: "<short title>", body: "<full description>", origin: "adversarial-review", author: "${name}" })\`.`,
				"6. Return only a summary count of how many findings you logged.",
			].join("\n")
			const elabReviewModel = resolveReviewAgentModel({
				mandatePath,
				studio,
				stage,
			})
			sections.push(
				`${emitSubagentDispatchBlock({
					unit: `review-elab-${stage}`,
					hat: name,
					bolt: 1,
					agentType: "general-purpose",
					model: elabReviewModel,
					promptBody: prompt,
					heading: `#### Subagent: \`${name}\``,
				})}\n`,
			)
		}
	}

	sections.push(
		`### Parent Instructions (do NOT include in subagent prompts)\n\nSpawn review subagents in parallel using the \`prompt_file\` attribute — pass \`"Read <prompt_file> and execute its instructions exactly."\` as the spawn prompt. They persist findings directly via haiku_feedback. After all complete, call \`haiku_run_next { intent: "${slug}" }\` to advance.`,
	)

	return sections.join("\n\n")
})
