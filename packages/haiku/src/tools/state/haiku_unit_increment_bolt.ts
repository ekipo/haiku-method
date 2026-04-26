// tools/state/haiku_unit_increment_bolt.ts — Bump a unit's bolt counter
// and re-seal the intent integrity hash.
//
// Enforces MAX_UNIT_BOLTS — exceeding the cap returns a structured
// error so callers can surface the escalation cleanly.

import { readFileSync } from "node:fs"
import { sealIntentState } from "../../state-integrity.js"
import { enforceStageBranch } from "../../state/active-stage.js"
import { setFrontmatterField } from "../../state/frontmatter.js"
import { MAX_UNIT_BOLTS } from "../../state/iterations.js"
import { parseFrontmatter, unitPath } from "../../state/shared.js"
import { emitTelemetry } from "../../telemetry.js"
import { defineTool } from "../define.js"
import { text } from "./_text.js"

export default defineTool({
	name: "haiku_unit_increment_bolt",
	description:
		"Increment a unit's bolt counter (full hat-sequence iteration). Reseals intent integrity. Caps at MAX_UNIT_BOLTS.",
	inputSchema: {
		type: "object" as const,
		properties: {
			intent: { type: "string" },
			stage: { type: "string" },
			unit: { type: "string" },
		},
		required: ["intent", "stage", "unit"],
	},
	handle(args) {
		const branchErr = enforceStageBranch(
			args.intent as string,
			args.stage as string,
		)
		if (branchErr) return branchErr
		const path = unitPath(
			args.intent as string,
			args.stage as string,
			args.unit as string,
		)
		const { data } = parseFrontmatter(readFileSync(path, "utf8"))
		const current = (data.bolt as number) || 0

		if (current + 1 > MAX_UNIT_BOLTS) {
			return text(
				JSON.stringify({
					error: "max_bolts_exceeded",
					bolt: current,
					max: MAX_UNIT_BOLTS,
					message: `Unit has exceeded ${MAX_UNIT_BOLTS} bolt iterations. Escalate to the user — this unit may need to be redesigned or split.`,
				}),
			)
		}

		setFrontmatterField(path, "bolt", current + 1)
		sealIntentState(args.intent as string)
		emitTelemetry("haiku.bolt.iteration", {
			intent: args.intent as string,
			stage: args.stage as string,
			unit: args.unit as string,
			bolt: String(current + 1),
		})
		return text(String(current + 1))
	},
})
