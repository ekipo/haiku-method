// orchestrator/workflow/handlers/manual-change-assessment.ts — Emit for the
// `manual_change_assessment` state.
//
// This state is dispatched by the pre-tick drift-detection gate when one or
// more files in the tracked surface have changed since the last baseline
// acknowledgment. The handler's only job is to surface the findings as a
// structured OrchestratorAction so the prompt builder can render actionable
// instructions for the agent.
//
// The actual DriftFinding[] is embedded in the action by the gate. This
// handler just passes it through — the gate already did the analysis.
//
// Note: `manual_change_assessment` is a pre-tick synthetic state that bypasses
// normal derive-state / REGISTRY dispatch. The handler is registered in the
// REGISTRY for completeness (so WORKFLOW_STATES includes it and the prompt
// builder is reachable), but in practice the state is returned directly from
// runWorkflowTick when the drift gate fires.

import type { WorkflowHandler } from "./_types.js"

const emit: WorkflowHandler = (_ctx) => {
	// The drift gate embeds findings in the action object it returns directly.
	// When this handler is reached via normal dispatch, it means something went
	// wrong in the gate routing. Return an error to surface the misconfiguration.
	return {
		action: "error",
		message:
			"manual_change_assessment handler reached via normal dispatch — this state should only " +
			"be emitted directly by the drift-detection gate in runWorkflowTick. " +
			"Check run-tick.ts drift gate wiring.",
	}
}

export default emit
