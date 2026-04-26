// tools/orchestrator/index.ts — Registry of per-tool orchestrator
// handlers. Each per-tool file under this directory exports a
// `ToolDef` as its default export. The registry collects them into
// `orchestratorToolHandlers` (Map<name, ToolDef>) so
// `handleOrchestratorTool` can dispatch by name with a single lookup.
//
// The remaining (not-yet-extracted) orchestrator tool cases continue
// to live in orchestrator.ts's if-chain. handleOrchestratorTool
// checks the registry first, falls back to the chain for unmigrated
// tools. As more tools migrate, the chain shrinks toward zero.

import type { ToolDef } from "../types.js"
import haiku_intent_archive from "./haiku_intent_archive.js"
import haiku_intent_unarchive from "./haiku_intent_unarchive.js"

export const orchestratorToolHandlers: ReadonlyMap<string, ToolDef> = new Map(
	(
		[haiku_intent_archive, haiku_intent_unarchive] satisfies ToolDef[]
	).map((t) => [t.name, t]),
)
