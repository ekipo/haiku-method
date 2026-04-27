// orchestrator/prompts/external_changes_requested.ts — External
// review (PR/MR) returned changes-requested. The orchestrator
// captured the reviewer's feedback into a feedback file, rolled
// the phase back to elaborate, and bumped the iteration counter.
// Tells the agent to read the feedback file and address it before
// re-submitting.

import { definePromptBuilder } from "./define.js"

export default definePromptBuilder(({ slug, action }) => {
	const message = (action.message as string) || ""
	const externalUrl = (action.external_review_url as string) || ""
	const provider = (action.provider as string) || ""
	const feedbackId = (action.feedback_id as string) || ""
	const feedbackFile = (action.feedback_file as string) || ""
	const stage = (action.stage as string) || ""

	const parts: string[] = [`## External Review: Changes Requested`, "", message]

	if (provider || externalUrl) {
		parts.push(
			"",
			"### Source",
			"",
			provider ? `- **Provider:** ${provider}` : "",
			externalUrl ? `- **Review URL:** ${externalUrl}` : "",
		)
	}

	if (feedbackFile) {
		parts.push(
			"",
			`### Feedback File\n\n\`${feedbackFile}\` — read this in full before drafting any units. The body carries the reviewer's concrete asks.`,
		)
	}

	parts.push(
		"",
		"### Instructions",
		"",
		`1. Read \`${feedbackFile || `the feedback file for ${feedbackId}`}\` in full.`,
		"2. Draft new units (or revise specs) that close the finding. Each new unit's `closes:` MUST reference this feedback id.",
		`3. Call \`haiku_run_next { intent: "${slug}" }\` once the work is done — the orchestrator re-validates and re-submits to ${stage || "the active stage"}.`,
	)

	return parts.filter((p) => p !== "").join("\n")
})
