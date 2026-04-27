// Tool definition helpers.
//
// `defineTool` is an identity function — its job is to lock in the
// `ToolDef` shape so the per-tool files get full IntelliSense + compile
// errors when the schema and handler drift.
//
// `validateSlugArgs` is the shared path-traversal guard run before every
// tool handler — moved here from state-tools.ts so both registries can
// share it without circular imports.

import type { ToolDef, ToolResult } from "./types.js"

export function defineTool(def: ToolDef): ToolDef {
	return def
}

/** Reject any arg whose value contains a path separator or `..` segment.
 *  Returns an error ToolResult on rejection, `null` if all clear. */
export function validateSlugArgs(
	args: Record<string, unknown>,
): (ToolResult & { isError: true }) | null {
	for (const key of ["intent", "slug", "stage", "unit", "feedback_id"]) {
		const val = args[key]
		if (typeof val === "string" && /[/\\]|\.\./.test(val)) {
			return {
				content: [
					{
						type: "text" as const,
						text: `Invalid ${key}: "${val}" — path identifiers must not contain path separators or traversal sequences.`,
					},
				],
				isError: true,
			}
		}
	}
	return null
}
