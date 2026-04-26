// tools/state/haiku_unit_set.ts — Set a single field on a unit's
// frontmatter. Refuses status=completed direct writes (the FSM owns
// completion exclusively via advance_hat).

import { enforceStageBranch } from "../../state/active-stage.js"
import { setFrontmatterField } from "../../state/frontmatter.js"
import { unitPath } from "../../state/shared.js"
import { defineTool } from "../define.js"
import { text } from "./_text.js"

export default defineTool({
	name: "haiku_unit_set",
	description:
		"Set a field on a unit's frontmatter. Refuses status=completed (FSM-only).",
	inputSchema: {
		type: "object" as const,
		properties: {
			intent: { type: "string" },
			stage: { type: "string" },
			unit: { type: "string" },
			field: { type: "string" },
			value: {},
		},
		required: ["intent", "stage", "unit", "field", "value"],
	},
	handle(args) {
		const field = args.field as string
		const value = args.value
		if (field === "status" && value === "completed") {
			return text(
				JSON.stringify({
					error: "fsm_completion_protected",
					field,
					value,
					message:
						'Cannot set status to "completed" directly — unit completion is FSM-controlled. Call `haiku_unit_advance_hat` to let the FSM auto-complete the unit\'s last hat, which runs scope validation, feedback-assessor closure, and worktree merge-back. Setting status to other values (pending, active, blocked) is fine.',
				}),
			)
		}
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
		setFrontmatterField(path, args.field as string, args.value)
		return text("ok")
	},
})
