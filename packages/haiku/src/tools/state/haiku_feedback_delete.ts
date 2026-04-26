// tools/state/haiku_feedback_delete.ts — Delete a feedback file (agent
// caller). Refuses to delete pending/fixing items + human-authored items
// (those guards live in deleteFeedbackFile itself).

import { enforceStageBranch } from "../../state/active-stage.js"
import { deleteFeedbackFile } from "../../state/feedback.js"
import { gitCommitState, injectPushWarning } from "../../state/git-commit.js"
import { defineTool } from "../define.js"
import { text } from "./_text.js"

export default defineTool({
	name: "haiku_feedback_delete",
	description:
		"Delete a feedback file. Refuses pending/fixing items and human-authored items (agent caller).",
	inputSchema: {
		type: "object" as const,
		properties: {
			intent: { type: "string" },
			stage: { type: "string" },
			feedback_id: { type: "string" },
		},
		required: ["intent", "feedback_id"],
	},
	handle(args) {
		const intent = args.intent as string
		const stage = (args.stage as string) || ""
		const feedbackId = args.feedback_id as string

		if (!intent)
			return {
				content: [{ type: "text" as const, text: "Error: intent is required" }],
				isError: true,
			}
		if (!feedbackId)
			return {
				content: [
					{ type: "text" as const, text: "Error: feedback_id is required" },
				],
				isError: true,
			}

		const branchErr = enforceStageBranch(intent, stage || undefined)
		if (branchErr) return branchErr

		const deleteResult = deleteFeedbackFile(intent, stage, feedbackId, "agent")
		if (!deleteResult.ok) {
			return {
				content: [{ type: "text" as const, text: deleteResult.error }],
				isError: true,
			}
		}

		const gitResult = gitCommitState(
			stage
				? `feedback: delete ${feedbackId} from ${stage}`
				: `feedback: delete ${feedbackId} (intent-scope)`,
		)

		const response: Record<string, unknown> = {
			feedback_id: feedbackId,
			deleted: true,
			message: stage
				? `Feedback ${feedbackId} deleted from stage '${stage}'.`
				: `Feedback ${feedbackId} deleted (intent-scope).`,
		}
		return text(JSON.stringify(injectPushWarning(response, gitResult), null, 2))
	},
})
