// orchestrator/prompts/changes_requested.ts — Reviewer asked for
// changes. Renders the message + any per-file annotations as a
// bulleted list, then tells the agent to address them and re-submit.

import { definePromptBuilder } from "./define.js"

export default definePromptBuilder(({ slug, action }) => {
	const annotations = action.annotations as
		| Array<{ path?: string; body?: string }>
		| undefined
	let body = `## Changes Requested\n\n${action.message || "No details provided."}`
	if (annotations && annotations.length > 0) {
		body += "\n\n### Annotations\n"
		for (const a of annotations) {
			body += `\n- ${a.path ? `**${a.path}:** ` : ""}${a.body || ""}`
		}
	}
	body += `\n\n### Instructions\n\nAddress each piece of feedback, then call \`haiku_run_next { intent: "${slug}" }\` to re-submit for review.`
	return body
})
