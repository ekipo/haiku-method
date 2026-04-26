// orchestrator/prompts/revise_unit_specs.ts — Pre-execute gate
// rejected. Nothing has been built — there are no artifacts to
// critique, so no feedback files were created. Resolution is
// editing unstarted unit specs in place (or adding new ones if the
// scope needs expansion). NOT additive elaboration; do not draft a
// new wave of units.

import { definePromptBuilder } from "./define.js"

export default definePromptBuilder(({ slug, action }) => {
	const message = (action.message as string) || ""
	const stage = (action.stage as string) || ""
	const unstartedUnits = (action.unstarted_units as string[]) || []
	const annotations = action.annotations as
		| Array<{ path?: string; body?: string }>
		| undefined

	const parts: string[] = [`## Revise Unit Specs: ${stage}`, "", message]

	if (annotations && annotations.length > 0) {
		parts.push(
			"",
			"### Annotations",
			"",
			...annotations.map(
				(a) => `- ${a.path ? `**${a.path}:** ` : ""}${a.body || ""}`,
			),
		)
	}

	if (unstartedUnits.length > 0) {
		parts.push(
			"",
			`### Unstarted Units (${unstartedUnits.length})`,
			"",
			...unstartedUnits.map((u) => `- \`${u}\``),
		)
	}

	parts.push(
		"",
		"### Instructions",
		"",
		"1. Read each annotation above and identify which unit spec(s) it lands on.",
		"2. Edit the unit `.md` files in place — frontmatter or body — to address every annotation.",
		"3. Add new unit files only if the scope needs expansion (do NOT draft a full new wave; that's a post-execute flow).",
		`4. Call \`haiku_run_next { intent: "${slug}" }\` to re-open the review gate.`,
		"",
		"**No `haiku_feedback_update` calls** — nothing was persisted as feedback. The annotations above are the spec-level work.",
	)

	return parts.join("\n")
})
