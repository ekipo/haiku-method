// orchestrator/fsm/state-builders.ts — Pure functions that build
// the xstate state-node config object for each major state type
// (stage, execute, review_fix). Composed by createMachineForStudio()
// per-stage from the StudioConfig.
//
// Builders return PLAIN config objects — no closures, no runtime
// mutation. xstate's visualizer reads the config statically; any
// runtime-only construction would defeat the visualization.
//
// Action/guard implementations live in orchestrator/fsm/actions/
// (added in step 4). Builders reference them by string name; the
// factory provides the real implementations to createMachine() via
// its second argument.
//
// Cross-state escapes (blocked, escalate, parent-stage gate) are
// NOT modeled as direct transitions in this step — xstate's static
// validator rejects unresolved IDs at machine-creation time. They
// land in step 4 via top-level event handlers + actions, after the
// per-state files declare their own IDs.

import { MAX_FIX_LOOP_BOLTS } from "../../state-tools.js"
import type { HatConfig, StageConfig } from "./studio-config.js"

/** Internal: the xstate-config type we emit. We use `unknown` rather
 *  than xstate's `StateNodeConfig` because the latter is heavily
 *  generic and our composition shape is simpler — we just need a
 *  serializable object literal. */
export type StateConfigObject = Record<string, unknown>

/** Build the execute sub-machine for a stage. Hats are enumerated as
 *  serial sub-states. The terminal sub-state (`done`) is `final` —
 *  the parent stage handles the cross-machine `execute.complete`
 *  event in step 4. */
export function buildExecuteSubMachine(
	hats: readonly HatConfig[],
): StateConfigObject {
	if (hats.length === 0) {
		return {
			initial: "done",
			states: {
				done: { type: "final" },
			},
		}
	}

	const states: Record<string, StateConfigObject> = {}
	for (let i = 0; i < hats.length; i++) {
		const hatName = hats[i].name
		const isFirst = i === 0
		const isLast = i === hats.length - 1
		const next = isLast ? "done" : hats[i + 1].name
		const prev = isFirst ? hatName : hats[i - 1].name

		states[hatName] = {
			meta: { hat: hatName, position: i, total: hats.length },
			entry: "dispatchHat",
			on: {
				"hat.advance": next,
				"hat.reject": prev,
			},
		}
	}

	states.done = {
		type: "final",
		meta: { hat: "done" },
	}

	return {
		initial: hats[0].name,
		states,
	}
}

/** Build the review_fix sub-machine for a stage. Each bolt enumerates
 *  the fix-hat sequence + a per-bolt `validated` terminal that
 *  decides closed → done OR open → next bolt OR exceeded → escalated.
 *
 *  Empty fixHats means the stage opted out of fix-loop dispatch —
 *  the state still exists for symmetry but transitions
 *  unconditionally to the `escalated` terminal. */
export function buildReviewFixSubMachine(
	fixHats: readonly HatConfig[],
): StateConfigObject {
	if (fixHats.length === 0) {
		return {
			initial: "escalated",
			states: {
				escalated: {
					type: "final",
					meta: { reason: "stage opted out of fix-loop dispatch" },
				},
			},
		}
	}

	const states: Record<string, StateConfigObject> = {
		done: { type: "final", meta: { reason: "all findings closed" } },
		escalated: {
			type: "final",
			meta: { reason: "bolt cap reached, surfaced to human" },
		},
	}

	for (let bolt = 1; bolt <= MAX_FIX_LOOP_BOLTS; bolt++) {
		const boltKey = `bolt_${bolt}`
		const boltStates: Record<string, StateConfigObject> = {}
		for (let i = 0; i < fixHats.length; i++) {
			const hatName = fixHats[i].name
			const isLast = i === fixHats.length - 1
			const nextHatName = isLast ? "validated" : fixHats[i + 1].name

			boltStates[hatName] = {
				meta: { hat: hatName, bolt, position: i },
				entry: "dispatchFixHat",
				on: {
					"fix.advance": nextHatName,
				},
			}
		}

		// Terminal-per-bolt: the assessor's verdict.
		const nextBoltKey = bolt < MAX_FIX_LOOP_BOLTS ? `bolt_${bolt + 1}` : null
		boltStates.validated = {
			meta: { bolt, terminal: true },
			on: {
				"feedback.closed": { target: "..done", reenter: true },
				"feedback.open": nextBoltKey
					? { target: `..${nextBoltKey}`, reenter: true }
					: { target: "..escalated", reenter: true },
			},
		}

		states[boltKey] = {
			initial: fixHats[0].name,
			states: boltStates,
		}
	}

	return {
		initial: "bolt_1",
		states,
	}
}

/** Build the per-stage sub-machine. Composes the phase progression
 *  (start_stage → elaborate → execute → review → review_fix → gate)
 *  with the stage's specific hat / fix-hat lists. The `gate` state
 *  is non-final; the parent machine routes its outcome via
 *  `stage.advance`. */
export function buildStageSubMachine(stage: StageConfig): StateConfigObject {
	const execute = buildExecuteSubMachine(stage.hats)
	const reviewFix = buildReviewFixSubMachine(stage.fixHats)

	return {
		initial: "start_stage",
		meta: {
			stage: stage.name,
			gate: stage.gate,
			hats: stage.hats.map((h) => h.name),
			fixHats: stage.fixHats.map((h) => h.name),
		},
		states: {
			start_stage: {
				entry: "startStage",
				on: { tick: "elaborate" },
			},
			elaborate: {
				entry: "enterElaborate",
				on: {
					"elaborate.advance": "execute",
					"feedback.pending": "review_fix",
				},
			},
			execute: {
				...execute,
				onDone: "review",
			},
			review: {
				entry: "enterReview",
				on: {
					"review.clean": "gate",
					"review.findings": "review_fix",
				},
			},
			review_fix: {
				...reviewFix,
				onDone: "gate",
			},
			gate: {
				type: "final",
				entry: "enterGate",
				meta: { gate: stage.gate },
			},
		},
	}
}
