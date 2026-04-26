// tools/state/haiku_feedback_update.ts — Update mutable fields on a
// feedback item (status, closed_by, resolution). Agent caller —
// privilege guards in updateFeedbackFile prevent agents from closing
// human-authored items.

import { enforceStageBranch } from "../../state/active-stage.js"
import {
	findFeedbackFile,
	updateFeedbackFile,
} from "../../state/feedback.js"
import { gitCommitState, injectPushWarning } from "../../state/git-commit.js"
import { defineTool } from "../define.js"
import { text } from "./_text.js"

export default defineTool({
	name: "haiku_feedback_update",
	description:
		"Update a feedback item's status / closed_by / resolution (agent caller). Refuses closing human-authored items.",
	inputSchema: {
		type: "object" as const,
		properties: {
			intent: { type: "string" },
			stage: { type: "string" },
			feedback_id: { type: "string" },
			status: { type: "string" },
			closed_by: { type: "string" },
			resolution: { type: "string" },
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

		const updateFields: {
			status?: string
			closed_by?: string
			resolution?: string | null
		} = {}
		if (args.status !== undefined) updateFields.status = args.status as string
		if (args.closed_by !== undefined)
			updateFields.closed_by = args.closed_by as string
		if (args.resolution !== undefined) {
			const raw = args.resolution
			updateFields.resolution =
				typeof raw === "string" && raw.length > 0 ? (raw as string) : null
		}

		const branchErr = enforceStageBranch(intent, stage || undefined)
		if (branchErr) return branchErr

		const updateResult = updateFeedbackFile(
			intent,
			stage,
			feedbackId,
			updateFields,
			"agent",
		)

		if (!updateResult.ok) {
			return {
				content: [{ type: "text" as const, text: updateResult.error }],
				isError: true,
			}
		}

		const gitResult = gitCommitState(
			stage
				? `feedback: update ${feedbackId} in ${stage}`
				: `feedback: update ${feedbackId} (intent-scope)`,
		)

		const found = findFeedbackFile(intent, stage, feedbackId)
		const response: Record<string, unknown> = {
			feedback_id: feedbackId,
			file: found
				? stage
					? `.haiku/intents/${intent}/stages/${stage}/feedback/${found.filename}`
					: `.haiku/intents/${intent}/feedback/${found.filename}`
				: undefined,
			updated_fields: updateResult.updated_fields,
			message: `Feedback ${feedbackId} updated.`,
		}
		return text(JSON.stringify(injectPushWarning(response, gitResult), null, 2))
	},
})
