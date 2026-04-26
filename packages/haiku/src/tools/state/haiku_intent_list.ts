// tools/state/haiku_intent_list.ts — Enumerate intents in the workspace.
//
// `listVisibleIntents` already parses each intent.md once for the
// archived filter; we reuse the parsed data so we don't re-parse the
// same files for the response body. Also annotates the entry whose
// slug matches the current git branch — pickup/revisit skills use
// this to skip the "which intent?" prompt when the user's checkout
// already names the intent.

import { existsSync } from "node:fs"
import { join } from "node:path"
import {
	intentFromCurrentBranch,
	listVisibleIntents,
} from "../../state/frontmatter.js"
import { findHaikuRoot } from "../../state/shared.js"
import { defineTool } from "../define.js"
import { text } from "./_text.js"

export default defineTool({
	name: "haiku_intent_list",
	description: "List all intents in the workspace",
	inputSchema: {
		type: "object" as const,
		properties: {
			include_archived: {
				type: "boolean",
				description:
					"When true, include archived intents in the result and add an 'archived' field to each response object. Defaults to false.",
			},
		},
	},
	handle(args) {
		const root = findHaikuRoot()
		const intentsDir = join(root, "intents")
		if (!existsSync(intentsDir)) return text("[]")
		const includeArchived = args.include_archived === true
		const entries = listVisibleIntents(intentsDir, { includeArchived })
		const branchMatch = intentFromCurrentBranch()
		const intents = entries.map(({ slug, data }) => {
			const base: Record<string, unknown> = {
				slug,
				studio: data.studio,
				status: data.status,
				active_stage: data.active_stage,
			}
			if (includeArchived) {
				base.archived = data.archived === true
			}
			if (branchMatch && branchMatch.slug === slug) {
				base.current_branch = true
				if (branchMatch.stage) base.current_branch_stage = branchMatch.stage
			}
			return base
		})
		return text(JSON.stringify(intents, null, 2))
	},
})
