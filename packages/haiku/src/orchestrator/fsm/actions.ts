// orchestrator/fsm/actions.ts — Implementations for the named action
// refs declared in state-builders / create-machine-for-studio.
//
// xstate v5 design split: the state config carries action *names*
// (string refs), and the machine's second argument carries the real
// implementations. This keeps the config statically renderable
// (visualizer reads names, not closures) while the runtime gets
// concrete behavior.
//
// Current responsibility: side effects + context updates. Each
// action emits a telemetry beacon + assigns metadata onto context.
// The OrchestratorAction emission still happens in runNext during
// the per-state migration; xstate state nodes will take it over
// state-by-state in the migration loop (step 5 of task #12).
//
// Why stub the action emission now? Two reasons:
// 1. Parity testing requires the machine to drive end-to-end.
//    Doing that in one shot for 45 states means 45 untestable
//    states until the last one lands. Per-state migration with
//    xstate-fallback dispatch lets each state ship green.
// 2. The "tick" runtime currently lives in haiku_run_next.ts and
//    invokes runNext(slug). Wholesale replacement requires moving
//    every emission path simultaneously. Incremental migration is
//    the safe path the user explicitly chose.

import { assign } from "xstate"
import { emitTelemetry } from "../../telemetry.js"
import type { FsmContext } from "./types.js"

/** Context extension for action-driven updates. The xstate machine's
 *  context carries an optional `_lastEntry` marker — the wrapping
 *  runFsmTick reads this to know which state was just entered. */
export interface ActionContext extends FsmContext {
	readonly _lastEntry?: string
	readonly _lastEntryMeta?: Record<string, unknown>
}

/** Build the actions object for createMachine's second argument.
 *  Every named ref the state config uses must have an entry here,
 *  or xstate's static validator will throw on machine creation. */
export function buildFsmActions() {
	return {
		selectStudio: assign(({ context }: { context: ActionContext }) => {
			emitTelemetry("haiku.fsm.entry", {
				state: "select_studio",
				slug: context.slug ?? "",
			})
			return { _lastEntry: "select_studio" }
		}),

		startStage: assign(({ context }: { context: ActionContext }) => {
			emitTelemetry("haiku.fsm.entry", {
				state: "start_stage",
				slug: context.slug ?? "",
				stage: context.currentStage ?? "",
			})
			return {
				_lastEntry: "start_stage",
				_lastEntryMeta: { stage: context.currentStage ?? "" },
			}
		}),

		enterElaborate: assign(({ context }: { context: ActionContext }) => {
			emitTelemetry("haiku.fsm.entry", {
				state: "elaborate",
				slug: context.slug ?? "",
				stage: context.currentStage ?? "",
			})
			return {
				_lastEntry: "elaborate",
				_lastEntryMeta: { stage: context.currentStage ?? "" },
			}
		}),

		dispatchHat: assign(({ context, event }) => {
			const ctx = context as ActionContext
			const e = event as { hat?: string }
			const hat = e.hat ?? ""
			emitTelemetry("haiku.fsm.entry", {
				state: "execute.hat",
				slug: ctx.slug ?? "",
				stage: ctx.currentStage ?? "",
				hat,
			})
			return {
				_lastEntry: "execute.hat",
				_lastEntryMeta: { stage: ctx.currentStage ?? "", hat },
			}
		}),

		enterReview: assign(({ context }: { context: ActionContext }) => {
			emitTelemetry("haiku.fsm.entry", {
				state: "review",
				slug: context.slug ?? "",
				stage: context.currentStage ?? "",
			})
			return {
				_lastEntry: "review",
				_lastEntryMeta: { stage: context.currentStage ?? "" },
			}
		}),

		dispatchFixHat: assign(({ context, event }) => {
			const ctx = context as ActionContext
			const e = event as { hat?: string; bolt?: number }
			const hat = e.hat ?? ""
			const bolt = e.bolt ?? 1
			emitTelemetry("haiku.fsm.entry", {
				state: "review_fix.hat",
				slug: ctx.slug ?? "",
				stage: ctx.currentStage ?? "",
				hat,
				bolt: String(bolt),
			})
			return {
				_lastEntry: "review_fix.hat",
				_lastEntryMeta: {
					stage: ctx.currentStage ?? "",
					hat,
					bolt,
				},
			}
		}),

		enterGate: assign(({ context }: { context: ActionContext }) => {
			emitTelemetry("haiku.fsm.entry", {
				state: "gate",
				slug: context.slug ?? "",
				stage: context.currentStage ?? "",
			})
			return {
				_lastEntry: "gate",
				_lastEntryMeta: { stage: context.currentStage ?? "" },
			}
		}),

		enterIntentCompletionReview: assign(
			({ context }: { context: ActionContext }) => {
				emitTelemetry("haiku.fsm.entry", {
					state: "intent_completion_review",
					slug: context.slug ?? "",
				})
				return { _lastEntry: "intent_completion_review" }
			},
		),

		dispatchStudioFixLoop: assign(
			({ context }: { context: ActionContext }) => {
				emitTelemetry("haiku.fsm.entry", {
					state: "intent_completion_fix",
					slug: context.slug ?? "",
				})
				return { _lastEntry: "intent_completion_fix" }
			},
		),

		enterIntentCompletionGate: assign(
			({ context }: { context: ActionContext }) => {
				emitTelemetry("haiku.fsm.entry", {
					state: "intent_completion_gate",
					slug: context.slug ?? "",
				})
				return { _lastEntry: "intent_completion_gate" }
			},
		),
	}
}
