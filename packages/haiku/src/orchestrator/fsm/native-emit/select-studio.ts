// orchestrator/fsm/native-emit/select-studio.ts — Emit for the
// `select_studio` state.
//
// FIRES WHEN: derive-state sees no studio set on intent.md.
// Reads the studio registry to surface available studios for the
// agent. The runNext counterpart at orchestrator.ts:2161 produces
// the byte-identical shape.

import { listStudios } from "../../../studio-reader.js"
import type { NativeEmitter } from "./_types.js"

const emit: NativeEmitter = (ctx) => {
	const available = listStudios().map((s) => ({
		name: s.name,
		slug: s.slug,
		aliases: s.aliases,
		description: s.description,
		category: s.category,
	}))
	return {
		action: "select_studio",
		intent: ctx.slug,
		available_studios: available,
		message: `Intent '${ctx.slug}' has no studio selected. Call haiku_select_studio { intent: "${ctx.slug}" } to choose a lifecycle studio.`,
	}
}

export default emit
