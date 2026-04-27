// orchestrator/workflow/handlers/composite.ts — Emit for composite
// (multi-studio) intents.
//
// Composite intents declare a list of `composite: [{ studio, stages
// }, ...]` plus `sync: [{ wait, then }]` rules across studios.
// Routing semantics differ from single-studio intents — each studio
// progresses independently through its declared stages, with sync
// barriers enforcing cross-studio dependencies.
//
// Sub-cases handled:
//   1. First runnable studio:stage (skip completed studios, skip
//      stages outside the studio's declared list, honor sync waits)
//      → composite_run_stage
//   2. All studios complete → completeOrReviewIntent delegate
//   3. Every runnable stage is sync-blocked → blocked

import {
	completeOrReviewIntent,
	resolveStageHats,
} from "../../../orchestrator.js"
import type { WorkflowHandler } from "./_types.js"

const emit: WorkflowHandler = (ctx) => {
	const slug = ctx.slug
	const intent = ctx.intent
	if (!intent.composite) return null

	const composite = intent.composite as Array<{
		studio: string
		stages: string[]
	}>
	const compositeState = (intent.composite_state || {}) as Record<
		string,
		string
	>
	const syncRules = (intent.sync || []) as Array<{
		wait: string[]
		then: string[]
	}>

	for (const entry of composite) {
		const current = compositeState[entry.studio] || entry.stages[0]
		if (current === "complete") continue
		if (!entry.stages.includes(current)) continue

		let blocked = false
		for (const rule of syncRules) {
			for (const thenStage of rule.then) {
				if (thenStage === `${entry.studio}:${current}`) {
					for (const waitStage of rule.wait) {
						const [ws, wst] = waitStage.split(":")
						const wsState = compositeState[ws] || ""
						const wsStages =
							composite.find((c) => c.studio === ws)?.stages || []
						const wsIdx = wsStages.indexOf(wst)
						const currentIdx = wsStages.indexOf(wsState)
						if (currentIdx <= wsIdx) {
							blocked = true
							break
						}
					}
					if (blocked) break
				}
			}
			if (blocked) break
		}

		if (!blocked) {
			return {
				action: "composite_run_stage",
				intent: slug,
				studio: entry.studio,
				stage: current,
				hats: resolveStageHats(entry.studio, current),
				message: `Composite: run '${entry.studio}:${current}'`,
			}
		}
	}

	const allComplete = composite.every(
		(e) => compositeState[e.studio] === "complete",
	)
	if (allComplete) {
		return completeOrReviewIntent(
			slug,
			"composite",
			`All composite studios complete for '${slug}'.`,
		)
	}

	return {
		action: "blocked",
		intent: slug,
		message: "All runnable stages are sync-blocked — waiting for dependencies",
	}
}

export default emit
