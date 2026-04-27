// orchestrator/prompts/intent_complete.ts — All stages done.
// Different copy for git vs. filesystem persistence: git mode tells
// the agent to open ONE final-delivery MR; filesystem mode just
// reports completion. Either way the orchestrator already marked
// the intent completed.

import { getMainlineBranch } from "../../git-worktree.js"
import { isGitRepo } from "../../state-tools.js"
import { definePromptBuilder } from "./define.js"

export default definePromptBuilder(({ slug }) => {
	if (isGitRepo()) {
		const mainline = getMainlineBranch()
		return `## Intent Complete\n\nAll stages are done for intent "${slug}". The orchestrator has marked it as completed.\n\n### Instructions\n\n1. Report completion summary to the user\n2. Open ONE merge request from branch \`haiku/${slug}/main\` to \`${mainline}\` for final delivery\n3. Include the H·AI·K·U browse link in the description so reviewers can see the intent, units, and knowledge artifacts\n4. Record the review URL via \`haiku_run_next { intent: "${slug}", external_review_url: "<url>" }\``
	}
	return `## Intent Complete\n\nAll stages are done for intent "${slug}". The orchestrator has marked it as completed.\n\n### Instructions\n\nReport completion summary to the user.`
})
