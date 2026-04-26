// tools/state/haiku_feedback_list.ts — List feedback items across one
// stage, all stages of an intent, or just the intent-scope (no stage
// filter → also include intent-scope items written by the studio-
// level pre-intent-completion review layer).
//
// Aligns the checkout to the right stage branch first — feedback files
// live on the stage branch, not main, so reading from intent-main can
// silently miss items.

import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { enforceStageBranch, resolveActiveStage } from "../../state/active-stage.js"
import {
	FEEDBACK_STATUSES,
	readFeedbackFiles,
} from "../../state/feedback.js"
import { intentDir } from "../../state/shared.js"
import { defineTool } from "../define.js"
import { text } from "./_text.js"

export default defineTool({
	name: "haiku_feedback_list",
	description:
		"List feedback items for an intent. Without `stage`, returns items from every stage plus intent-scope. Filter by status with `status`.",
	inputSchema: {
		type: "object" as const,
		properties: {
			intent: { type: "string" },
			stage: { type: "string" },
			status: { type: "string" },
		},
		required: ["intent"],
	},
	handle(args) {
		const intent = args.intent as string
		const stageFilt = (args.stage as string) || undefined
		const statusFilt = (args.status as string) || undefined

		if (!intent)
			return {
				content: [{ type: "text" as const, text: "Error: intent is required" }],
				isError: true,
			}

		const listIntentFile = join(intentDir(intent), "intent.md")
		if (!existsSync(listIntentFile))
			return {
				content: [
					{
						type: "text" as const,
						text: `Error: intent '${intent}' not found`,
					},
				],
				isError: true,
			}

		if (
			statusFilt &&
			!(FEEDBACK_STATUSES as readonly string[]).includes(statusFilt)
		) {
			return {
				content: [
					{
						type: "text" as const,
						text: `Error: status must be one of: ${FEEDBACK_STATUSES.join(", ")}`,
					},
				],
				isError: true,
			}
		}

		// Align branch BEFORE reading — feedback files live on the stage
		// branch. Without this, drift between main and stage shows a stale
		// list. Use the provided stage filter if any, otherwise active.
		const listBranchErr = enforceStageBranch(
			intent,
			stageFilt ?? resolveActiveStage(intent),
		)
		if (listBranchErr) return listBranchErr

		let stagesToList: string[]
		if (stageFilt) {
			stagesToList = [stageFilt]
		} else {
			const stagesPath = join(intentDir(intent), "stages")
			if (!existsSync(stagesPath)) {
				stagesToList = []
			} else {
				stagesToList = readdirSync(stagesPath).filter((s) =>
					existsSync(join(stagesPath, s)),
				)
			}
		}

		const allItems: Array<Record<string, unknown>> = []
		for (const stg of stagesToList) {
			const items = readFeedbackFiles(intent, stg)
			for (const item of items) {
				if (statusFilt && item.status !== statusFilt) continue
				const entry: Record<string, unknown> = {
					feedback_id: item.id,
					file: item.file,
					title: item.title,
					status: item.status,
					origin: item.origin,
					author: item.author,
					author_type: item.author_type,
					created_at: item.created_at,
					visit: item.visit,
					source_ref: item.source_ref,
					closed_by: item.closed_by,
					bolt: item.bolt,
					upstream_stage: item.upstream_stage,
				}
				if (!stageFilt) {
					entry.stage = stg
				}
				allItems.push(entry)
			}
		}

		// Intent-scope feedback (studio-level review findings) when no
		// stage filter was provided.
		if (!stageFilt) {
			const intentItems = readFeedbackFiles(intent, "")
			for (const item of intentItems) {
				if (statusFilt && item.status !== statusFilt) continue
				allItems.push({
					feedback_id: item.id,
					file: item.file,
					title: item.title,
					status: item.status,
					origin: item.origin,
					author: item.author,
					author_type: item.author_type,
					created_at: item.created_at,
					visit: item.visit,
					source_ref: item.source_ref,
					closed_by: item.closed_by,
					bolt: item.bolt,
					upstream_stage: item.upstream_stage,
					stage: null,
				})
			}
		}

		const listResponse: Record<string, unknown> = {
			intent,
			stage: stageFilt || null,
			count: allItems.length,
			items: allItems,
		}
		return text(JSON.stringify(listResponse, null, 2))
	},
})
