// orchestrator/fsm/create-machine-for-studio.ts — Factory: take a
// StudioConfig, return a fully-elaborated, fully-static xstate
// machine. One machine per studio, generated once at module load.
//
// The returned machine is:
//   - JSON-serializable (no closures in the config object)
//   - Visualizable (Stately Studio, VS Code extension, @xstate/graph)
//   - Static post-load (regenerates only when StudioConfig changes)
//
// Action and guard implementations are referenced by string name in
// the config; real implementations are passed via createMachine's
// second argument. This split is what makes the static config
// renderable without running the runtime.
//
// Per-studio enumeration: every stage in the studio's defaultStages
// becomes a top-level state node in the machine. Each stage carries
// its own phase progression (start → elaborate → execute → review →
// review_fix → gate), with the execute and review_fix sub-machines
// parameterized by the stage's hat lists.

import { type AnyStateMachine, createMachine } from "xstate"
import type { OrchestratorAction } from "../../orchestrator.js"
import {
	buildStageSubMachine,
	type StateConfigObject,
} from "./state-builders.js"
import type { StudioConfig } from "./studio-config.js"
import type { FsmContext } from "./types.js"

export type StudioMachineEvent =
	| { type: "tick" }
	| { type: "hat.advance" }
	| { type: "hat.reject" }
	| { type: "unit.blocked" }
	| { type: "execute.complete" }
	| { type: "elaborate.advance" }
	| { type: "feedback.pending" }
	| { type: "feedback.closed" }
	| { type: "feedback.open" }
	| { type: "fix.advance" }
	| { type: "review.clean" }
	| { type: "review.findings" }
	| { type: "gate.approved" }
	| { type: "gate.changes_requested" }
	| { type: "gate.external_review" }
	| { type: "studio.selected" }
	| { type: "stage.advance" }
	| { type: "intent.complete" }
	| { type: "intent.archived" }

export interface StudioMachine {
	readonly studio: string
	readonly machine: AnyStateMachine
	readonly config: StateConfigObject
}

/** Build the top-level machine config from a StudioConfig. Composes
 *  per-stage sub-machines, the intent-completion review/fix layer,
 *  and the terminal states. */
function buildStudioMachineConfig(studio: StudioConfig): StateConfigObject {
	const states: Record<string, StateConfigObject> = {}

	// Setup states.
	states.select_studio = {
		entry: "selectStudio",
		on: { "studio.selected": studio.defaultStages[0] ?? "complete" },
	}

	// Per-stage enumerated sub-machines.
	for (let i = 0; i < studio.defaultStages.length; i++) {
		const stageName = studio.defaultStages[i]
		const stageConfig = studio.stages[stageName]
		if (!stageConfig) continue
		const isLast = i === studio.defaultStages.length - 1
		const next = isLast
			? studio.studioReviewAgents.length > 0
				? "intent_completion_review"
				: "complete"
			: studio.defaultStages[i + 1]

		states[stageName] = {
			...buildStageSubMachine(stageConfig),
			onDone: next,
		}
	}

	// Intent-completion review (studio-level).
	if (studio.studioReviewAgents.length > 0) {
		states.intent_completion_review = {
			meta: {
				agents: studio.studioReviewAgents.map((a) => a.name),
			},
			entry: "enterIntentCompletionReview",
			on: {
				"review.clean": "intent_completion_gate",
				"review.findings": "intent_completion_fix",
			},
		}
	}

	if (studio.studioFixHats.length > 0) {
		states.intent_completion_fix = {
			meta: {
				fixHats: studio.studioFixHats.map((h) => h.name),
			},
			entry: "dispatchStudioFixLoop",
			on: {
				"feedback.closed": "intent_completion_gate",
				"feedback.open": "intent_completion_fix",
			},
		}
	}

	if (studio.studioReviewAgents.length > 0) {
		states.intent_completion_gate = {
			entry: "enterIntentCompletionGate",
			on: {
				"gate.approved": "complete",
				"gate.changes_requested": studio.defaultStages[
					studio.defaultStages.length - 1
				] ?? "complete",
			},
		}
	}

	// Terminal states.
	states.complete = { type: "final", meta: { terminal: "complete" } }
	states.error = { type: "final", meta: { terminal: "error" } }
	states.escalate = { type: "final", meta: { terminal: "escalate" } }
	states.blocked = { type: "final", meta: { terminal: "blocked" } }

	return {
		id: `haiku-fsm-${studio.dir}`,
		initial: "select_studio",
		states,
		meta: {
			studio: studio.dir,
			defaultStages: studio.defaultStages,
		},
	}
}

/** Create the xstate machine for a studio. The returned object
 *  carries the raw config alongside the machine instance — callers
 *  that just want to render the structure (visualization, Mermaid
 *  export) read `config`; the runtime uses `machine`. */
export function createMachineForStudio(studio: StudioConfig): StudioMachine {
	const config = buildStudioMachineConfig(studio)

	const machine = createMachine({
		id: `haiku-fsm-${studio.dir}`,
		types: {} as {
			context: FsmContext
			events: StudioMachineEvent
			output: OrchestratorAction
		},
		initial: "select_studio",
		context: ({ input }) => input as FsmContext,
		// xstate v5 expects `states` typed against its StateNodeConfig,
		// but our buildStudioMachineConfig returns a generic object
		// shape for type-system simplicity. The cast is safe because
		// state-builders.ts only emits xstate-shaped configs.
		states: config.states as never,
	})

	return {
		studio: studio.dir,
		machine,
		config,
	}
}
