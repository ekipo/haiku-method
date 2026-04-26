// tools/orchestrator/_text.ts — Shared MCP-text helper for per-tool
// orchestrator handlers. Mirrors tools/state/_text.ts so neither
// registry has to import the other.

import type { ToolResult } from "../types.js"

export function text(s: string): ToolResult {
	return { content: [{ type: "text" as const, text: s }] }
}
