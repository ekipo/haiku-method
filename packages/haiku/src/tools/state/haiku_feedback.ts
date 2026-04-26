// tools/state/haiku_feedback.ts — Create a feedback item.
//
// Stage feedback lands on the stage branch; intent-scope feedback
// (stage omitted) lands on intent-main and is consumed by the
// pre-intent-completion review layer. ensureOnStageBranch with a
// falsy stage already falls back to intent main, so the same call
// covers both cases.
//
// upstream_stage validation is strict: typos would silently route
// findings into a ghost stage the FSM never visits. Self-reference
// is also rejected — pointing upstream at the current stage is
// meaningless and would cause the gate vs. intent-completion layer
// to classify the same finding inconsistently.

import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { enforceStageBranch } from "../../state/active-stage.js"
import {
	FEEDBACK_ORIGINS,
	writeFeedbackFile,
} from "../../state/feedback.js"
import { gitCommitState, injectPushWarning } from "../../state/git-commit.js"
import {
	intentDir,
	parseFrontmatter,
	stageDir,
} from "../../state/shared.js"
import { defineTool } from "../define.js"
import { text } from "./_text.js"

export default defineTool({
	name: "haiku_feedback",
	description:
		"Create a feedback item under intent[/stage]. Omit `stage` for intent-scope feedback (studio-level pre-intent-completion review).",
	inputSchema: {
		type: "object" as const,
		properties: {
			intent: { type: "string" },
			stage: { type: "string" },
			title: { type: "string" },
			body: { type: "string" },
			origin: { type: "string" },
			source_ref: { type: "string" },
			author: { type: "string" },
			upstream_stage: { type: "string" },
		},
		required: ["intent", "title", "body"],
	},
	handle(args) {
		const intent = args.intent as string
		const stage = (args.stage as string) || ""
		const title = args.title as string
		const body = args.body as string
		const origin = (args.origin as string) || undefined
		const sourceRef = (args.source_ref as string) || undefined
		const author = (args.author as string) || undefined
		const upstreamStage = (args.upstream_stage as string) || undefined

		if (!intent)
			return {
				content: [{ type: "text" as const, text: "Error: intent is required" }],
				isError: true,
			}
		if (!title)
			return {
				content: [{ type: "text" as const, text: "Error: title is required" }],
				isError: true,
			}
		if (!body)
			return {
				content: [{ type: "text" as const, text: "Error: body is required" }],
				isError: true,
			}
		if (title.length > 120)
			return {
				content: [
					{
						type: "text" as const,
						text: "Error: title must be 120 characters or fewer",
					},
				],
				isError: true,
			}

		const intentFile = join(intentDir(intent), "intent.md")
		if (!existsSync(intentFile))
			return {
				content: [
					{ type: "text" as const, text: `Error: intent '${intent}' not found` },
				],
				isError: true,
			}

		if (origin && !(FEEDBACK_ORIGINS as readonly string[]).includes(origin)) {
			return {
				content: [
					{
						type: "text" as const,
						text: `Error: origin must be one of: ${FEEDBACK_ORIGINS.join(", ")}`,
					},
				],
				isError: true,
			}
		}

		const branchErr = enforceStageBranch(intent, stage || undefined)
		if (branchErr) return branchErr

		if (stage) {
			const stgDir = stageDir(intent, stage)
			if (!existsSync(stgDir)) {
				const { data: intentData } = parseFrontmatter(
					readFileSync(intentFile, "utf8"),
				)
				const stages = (intentData.stages as string[]) || []
				if (!stages.includes(stage)) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Error: stage '${stage}' not found under intent '${intent}'`,
							},
						],
						isError: true,
					}
				}
				mkdirSync(stgDir, { recursive: true })
			}
		}

		if (upstreamStage) {
			const { data: intentData } = parseFrontmatter(
				readFileSync(intentFile, "utf8"),
			)
			const stages = (intentData.stages as string[]) || []
			if (!stages.includes(upstreamStage)) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Error: upstream_stage '${upstreamStage}' is not a stage of intent '${intent}'. Valid stages: ${stages.join(", ")}`,
						},
					],
					isError: true,
				}
			}
			if (stage && upstreamStage === stage) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Error: upstream_stage '${upstreamStage}' equals the current stage. Omit upstream_stage for in-scope findings; set it only when the root cause lives in a DIFFERENT stage.`,
						},
					],
					isError: true,
				}
			}
		}

		const result = writeFeedbackFile(intent, stage, {
			title,
			body,
			origin,
			author,
			source_ref: sourceRef ?? null,
			upstream_stage: upstreamStage || null,
		})

		const gitResult = gitCommitState(
			stage
				? `feedback: create ${result.feedback_id} in ${stage}`
				: `feedback: create ${result.feedback_id} (intent-scope)`,
		)
		const response: Record<string, unknown> = {
			feedback_id: result.feedback_id,
			file: result.file,
			status: "pending",
			message: `Feedback ${result.feedback_id} created.`,
		}
		return text(
			JSON.stringify(injectPushWarning(response, gitResult), null, 2),
		)
	},
})
