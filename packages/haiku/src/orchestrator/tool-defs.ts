// orchestrator/tool-defs.ts — MCP tool surface for orchestration tools.
//
// Single source of truth: the surface is derived from the handler registry
// in `tools/orchestrator/index.ts`. Each handler's `defineTool({...})` carries
// the canonical name/description/inputSchema; we strip the `handle` function
// and forward the rest to MCP. This guarantees that a tool wired into the
// dispatcher (`handleOrchestratorTool`) is also advertised on the MCP surface,
// closing the class of bug where a new orchestrator tool is implemented and
// dispatched but never appears in the agent's tool list.

import { orchestratorToolHandlers } from "../tools/orchestrator/index.js"

export const orchestratorToolDefs = Array.from(
	orchestratorToolHandlers.values(),
).map(({ name, description, inputSchema }) => ({
	name,
	description,
	inputSchema,
}))
