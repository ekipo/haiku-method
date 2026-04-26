// tools/state/haiku_feedback_reject.ts — Reject an agent-authored
// feedback item with a documented reason. Sets status to "rejected"
// and appends the reason to the body.

import { writeFileSync } from "node:fs"
import matter from "gray-matter"
import { enforceStageBranch } from "../../state/active-stage.js"
import { findFeedbackFile } from "../../state/feedback.js"
import { gitCommitState, injectPushWarning } from "../../state/git-commit.js"
import { defineTool } from "../define.js"
import { text } from "./_text.js"

export default defineTool({
	name: "haiku_feedback_reject",
	description:
		"Reject an agent-authored feedback item with a reason. Refuses human-authored items and already-terminal items.",
	inputSchema: {
		type: "object" as const,
		properties: {
			intent: { type: "string" },
			stage: { type: "string" },
			feedback_id: { type: "string" },
			reason: { type: "string" },
		},
		required: ["intent", "feedback_id", "reason"],
	},
	handle(args) {
		const intent = args.intent as string
		const stage = (args.stage as string) || ""
		const feedbackId = args.feedback_id as string
		const reason = args.reason as string

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
		if (!reason)
			return {
				content: [
					{
						type: "text" as const,
						text: "Error: reason is required when rejecting feedback",
					},
				],
				isError: true,
			}

		// Branch alignment BEFORE the file read — if main has drifted ahead
		// the file may only exist on the stage branch.
		const branchErr = enforceStageBranch(intent, stage || undefined)
		if (branchErr) return branchErr

		const found = findFeedbackFile(intent, stage, feedbackId)
		if (!found) {
			return {
				content: [
					{
						type: "text" as const,
						text: stage
							? `Error: feedback '${feedbackId}' not found in stage '${stage}'`
							: `Error: feedback '${feedbackId}' not found (intent-scope)`,
					},
				],
				isError: true,
			}
		}

		// Guard: agents cannot reject human-authored feedback (only the
		// user can reject it via the review UI).
		if (found.data.author_type === "human") {
			return {
				content: [
					{
						type: "text" as const,
						text: "Error: agents cannot reject human-authored feedback. Only the user can reject it via the review UI.",
					},
				],
				isError: true,
			}
		}

		const currentStatus = found.data.status as string
		if (currentStatus === "closed" || currentStatus === "rejected") {
			return {
				content: [
					{
						type: "text" as const,
						text: `Error: feedback '${feedbackId}' is already '${currentStatus}' -- cannot reject again`,
					},
				],
				isError: true,
			}
		}

		const rejectData = { ...found.data, status: "rejected" }
		const rejectBody = `${found.body}\n\n---\n\n**Rejection reason:** ${reason}`
		writeFileSync(
			found.path,
			matter.stringify(`\n${rejectBody}\n`, rejectData),
		)

		const gitResult = gitCommitState(
			stage
				? `feedback: reject ${feedbackId} in ${stage}`
				: `feedback: reject ${feedbackId} (intent-scope)`,
		)

		const response: Record<string, unknown> = {
			feedback_id: feedbackId,
			status: "rejected",
			message: `Feedback ${feedbackId} rejected: ${reason}`,
		}
		return text(JSON.stringify(injectPushWarning(response, gitResult), null, 2))
	},
})
