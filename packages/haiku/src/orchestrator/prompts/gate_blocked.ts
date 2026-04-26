// orchestrator/prompts/gate_blocked.ts — Stage gate review couldn't
// run (transient). Tells the agent to retry once and escalate if it
// persists.

import { definePromptBuilder } from "./define.js"

export default definePromptBuilder(({ slug, action }) => {
	return `## Gate Review Blocked\n\n${action.message || "No details provided."}\n\n### Instructions\n\nCall \`haiku_run_next { intent: "${slug}" }\` to retry the gate review. If the issue persists, ask the user for guidance.`
})
