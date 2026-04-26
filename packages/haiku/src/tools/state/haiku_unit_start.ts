// tools/state/haiku_unit_start.ts — Begin work on a unit. Resolves
// the active stage + first hat, marks the unit active, seeds bolt=1
// and timestamps, and returns the stage scope context the agent
// needs to start working.
//
// Refuses if the unit is already active — prevents duplicate work.

import { existsSync, readFileSync } from "node:fs"
import { sealIntentState } from "../../state-integrity.js"
import {
	enforceStageBranch,
	resolveActiveStage,
	resolveStageHats,
	resolveStageScope,
	syncSessionMetadata,
} from "../../state/active-stage.js"
import { setFrontmatterField } from "../../state/frontmatter.js"
import { gitCommitState, pushWarning } from "../../state/git-commit.js"
import { startUnitIteration } from "../../state/iterations.js"
import {
	parseFrontmatter,
	timestamp,
	unitPath,
} from "../../state/shared.js"
import { logSessionEvent } from "../../session-metadata.js"
import { emitTelemetry } from "../../telemetry.js"
import { defineTool } from "../define.js"
import { text } from "./_text.js"

export default defineTool({
	name: "haiku_unit_start",
	description:
		"Begin work on a unit. Resolves the active stage + first hat, marks the unit active, returns stage-scope context.",
	inputSchema: {
		type: "object" as const,
		properties: {
			intent: { type: "string" },
			unit: { type: "string" },
			state_file: { type: "string" },
		},
		required: ["intent", "unit"],
	},
	handle(args) {
		const stage = resolveActiveStage(args.intent as string)
		if (!stage)
			return text(
				JSON.stringify({
					error: "no_active_stage",
					message:
						"No active stage found for this intent. Call haiku_run_next first.",
				}),
			)
		const branchErr = enforceStageBranch(args.intent as string, stage)
		if (branchErr) return branchErr
		const uPath = unitPath(args.intent as string, stage, args.unit as string)

		// Refuse if already active — prevents duplicate work.
		if (existsSync(uPath)) {
			const { data: existingFm } = parseFrontmatter(
				readFileSync(uPath, "utf8"),
			)
			if (existingFm.status === "active") {
				const scope = resolveStageScope(args.intent as string, stage)
				return text(
					JSON.stringify({
						error: "unit_already_active",
						unit: args.unit,
						hat: existingFm.hat || "",
						message: `Unit '${args.unit}' is already active (hat: ${existingFm.hat || "unknown"}). Do not start it again — continue working on it or call haiku_unit_advance_hat when done.`,
					}) + (scope ? `\n\n${scope}` : ""),
				)
			}
		}

		const stageHats = resolveStageHats(args.intent as string, stage)
		const firstHat = stageHats[0] || ""

		setFrontmatterField(uPath, "status", "active")
		setFrontmatterField(uPath, "bolt", 1)
		setFrontmatterField(uPath, "hat", firstHat)
		setFrontmatterField(uPath, "started_at", timestamp())
		setFrontmatterField(uPath, "hat_started_at", timestamp())
		startUnitIteration(uPath, firstHat)
		// Reseal: these are UNIT_FIELDS, so the tamper detector needs the
		// updated checksum before the next verifyIntentState() call.
		sealIntentState(args.intent as string)
		emitTelemetry("haiku.unit.started", {
			intent: args.intent as string,
			stage,
			unit: args.unit as string,
			hat: firstHat,
		})
		const sf = args.state_file as string | undefined
		if (sf)
			logSessionEvent(sf, {
				event: "unit_started",
				intent: args.intent,
				stage,
				unit: args.unit,
				hat: firstHat,
			})
		const gitResult = gitCommitState(`haiku: start unit ${args.unit as string}`)
		syncSessionMetadata(
			args.intent as string,
			args.state_file as string | undefined,
		)
		const scope = resolveStageScope(args.intent as string, stage)
		return text((scope ? `ok\n\n${scope}` : "ok") + pushWarning(gitResult))
	},
})
