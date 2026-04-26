// tools/state/haiku_decision_record.ts — Append a decision-log entry
// (or declare no-decisions with a rationale) to a stage's state.json.
//
// Validates: at least 2 options must be presented, the recorded choice
// must be one of those options, source must name how the decision was
// reached. The decision-log is provenance — these guards keep it from
// drifting into a fictional record.

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { sealIntentState } from "../../state-integrity.js"
import { resolveActiveStage } from "../../state/active-stage.js"
import {
	intentDir,
	timestamp,
	writeJson,
} from "../../state/shared.js"
import { emitTelemetry } from "../../telemetry.js"
import { defineTool } from "../define.js"
import { text } from "./_text.js"

export default defineTool({
	name: "haiku_decision_record",
	description:
		"Append a decision-log entry to the stage state, or declare no-decisions with a rationale.",
	inputSchema: {
		type: "object" as const,
		properties: {
			intent: { type: "string" },
			stage: { type: "string" },
			no_decisions: { type: "boolean" },
			rationale: { type: "string" },
			decision: { type: "string" },
			options: { type: "array", items: { type: "string" } },
			choice: { type: "string" },
			source: { type: "string", enum: ["user", "autonomous-acknowledged"] },
		},
		required: ["intent"],
	},
	handle(args) {
		const intentArg = args.intent as string
		const requestedStage = args.stage as string | undefined
		const stage = requestedStage || resolveActiveStage(intentArg)
		if (!stage) {
			return text(
				JSON.stringify({
					error: "no_active_stage",
					message:
						"No stage specified and no active stage found on the intent.",
				}),
			)
		}

		const stageDir = join(intentDir(intentArg), "stages", stage)
		const stateFile = join(stageDir, "state.json")
		if (!existsSync(stateFile)) {
			return text(
				JSON.stringify({
					error: "stage_state_missing",
					message: `Stage state file not found: ${stateFile}`,
				}),
			)
		}
		const stageState = JSON.parse(
			readFileSync(stateFile, "utf8"),
		) as Record<string, unknown>

		const noDecisions = args.no_decisions === true
		const rationale = (args.rationale as string | undefined)?.trim()

		if (noDecisions) {
			if (!rationale || rationale.length < 10) {
				return text(
					JSON.stringify({
						error: "rationale_required",
						message:
							"no_decisions=true requires a rationale of at least 10 characters explaining why no architectural decisions are in scope for this stage. State the convention or constraint that makes the work routine (e.g. 'all units follow the team's standard CRUD scaffolding; no architectural choices remain after design stage').",
					}),
				)
			}
			stageState.elaboration_no_decisions = true
			stageState.elaboration_no_decisions_rationale = rationale
			stageState.elaboration_no_decisions_at = timestamp()
			writeJson(stateFile, stageState)
			sealIntentState(intentArg)
			emitTelemetry("haiku.elaboration.no_decisions_declared", {
				intent: intentArg,
				stage,
			})
			return text(
				JSON.stringify({
					ok: true,
					intent: intentArg,
					stage,
					no_decisions: true,
					rationale,
				}),
			)
		}

		const decision = (args.decision as string | undefined)?.trim()
		const options = args.options as string[] | undefined
		const choice = (args.choice as string | undefined)?.trim()
		const source = args.source as string | undefined

		if (!decision || !options || !choice || !source) {
			return text(
				JSON.stringify({
					error: "missing_fields",
					message:
						"haiku_decision_record requires `decision`, `options`, `choice`, and `source` (or `no_decisions: true` with `rationale`).",
				}),
			)
		}

		if (!Array.isArray(options) || options.length < 2) {
			return text(
				JSON.stringify({
					error: "options_too_few",
					message:
						"`options` must be an array of at least 2 concrete alternatives. A 'decision' with only one option isn't a decision — it's just doing the work. If the work is forced, use `no_decisions: true` with a rationale instead.",
				}),
			)
		}

		if (!options.includes(choice)) {
			return text(
				JSON.stringify({
					error: "choice_not_in_options",
					message: `\`choice\` must match one of the entries in \`options\`. Got choice=${JSON.stringify(choice)}; options=${JSON.stringify(options)}. The decision-log is provenance — recording a choice that wasn't in the presented alternatives corrupts the very property the log exists to preserve.`,
				}),
			)
		}

		if (source !== "user" && source !== "autonomous-acknowledged") {
			return text(
				JSON.stringify({
					error: "invalid_source",
					message:
						'`source` must be "user" (the user picked between the options) or "autonomous-acknowledged" (you chose and surfaced the choice for the user to veto, and they did not push back).',
				}),
			)
		}

		const log = ((stageState.decision_log as unknown[]) || []) as Array<
			Record<string, unknown>
		>
		log.push({
			decision,
			options,
			choice,
			source,
			rationale: rationale || null,
			recorded_at: timestamp(),
		})
		stageState.decision_log = log
		writeJson(stateFile, stageState)
		sealIntentState(intentArg)
		emitTelemetry("haiku.decision.recorded", {
			intent: intentArg,
			stage,
			source,
		})
		return text(
			JSON.stringify({
				ok: true,
				intent: intentArg,
				stage,
				decision_count: log.length,
			}),
		)
	},
})
