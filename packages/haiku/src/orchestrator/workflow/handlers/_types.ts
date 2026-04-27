// orchestrator/workflow/handlers/_types.ts — Per-state workflow
// handler contract.
//
// Each file in handlers/ exports a default function with this
// signature. The registry in `index.ts` collects them keyed by
// StateName. `runWorkflowTick` consults the registry; if the derived
// state has a registered handler that returns non-null, the result
// flows back as the workflow-driver action.
//
// This pattern is the single source of truth for orchestrator
// emission. Adding a state = adding a file + registering it.

import type { OrchestratorAction } from "../../../orchestrator.js"
import type { DerivedContext } from "../derive-state.js"

/** Emit an OrchestratorAction for a derived state. May perform side
 *  effects (workflow-managed frontmatter writes, git operations).
 *  Return null when the handler doesn't apply to the given context
 *  (the dispatcher falls back to a structural error in that case).
 *
 *  `root` is the absolute path to the .haiku directory (passed by
 *  test fixtures), or undefined to fall back to `findHaikuRoot()` for
 *  production callers. */
export type WorkflowHandler = (
	context: DerivedContext,
	root?: string,
) => OrchestratorAction | null
