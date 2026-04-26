// tools/state/_text.ts — Shared `text(s)` helper used by every state-tool
// handler. Wraps a string in the MCP text-content envelope.

import type { ToolResult } from "../types.js"

export function text(s: string): ToolResult {
	return { content: [{ type: "text" as const, text: s }] }
}
