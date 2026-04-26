// orchestrator/fsm/actions/index.ts — Registry of per-file FSM
// actions. Each entry maps the action's name (referenced in state
// configs via `entry: "name"`) to its implementation file.
//
// As per-state migrations land, new actions get their own file
// here and register in the map. The createMachine factory passes
// `buildFsmActions()` as the `actions` field of the
// implementations object, which xstate uses to resolve
// string-named entry/exit refs at runtime.

import dispatchFixHat from "./dispatch-fix-hat.js"
import dispatchHat from "./dispatch-hat.js"
import dispatchStudioFixLoop from "./dispatch-studio-fix-loop.js"
import enterElaborate from "./enter-elaborate.js"
import enterGate from "./enter-gate.js"
import enterIntentCompletionGate from "./enter-intent-completion-gate.js"
import enterIntentCompletionReview from "./enter-intent-completion-review.js"
import enterReview from "./enter-review.js"
import selectStudio from "./select-studio.js"
import startStage from "./start-stage.js"

/** Build the actions object passed to createMachine's
 *  implementation argument. Function form (vs a frozen const) so
 *  the per-action modules can be lazy-loaded if needed in the
 *  future and to keep the call site symmetric with the existing
 *  buildFsmActions() interface in actions.ts. */
export function buildFsmActions() {
	return {
		dispatchFixHat,
		dispatchHat,
		dispatchStudioFixLoop,
		enterElaborate,
		enterGate,
		enterIntentCompletionGate,
		enterIntentCompletionReview,
		enterReview,
		selectStudio,
		startStage,
	}
}
