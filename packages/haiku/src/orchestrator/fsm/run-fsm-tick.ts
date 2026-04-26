// orchestrator/fsm/run-fsm-tick.ts — Integration glue: take an
// intent slug, derive its FSM state from disk, run a machine tick,
// return the resolved state path + context updates.
//
// This is the "step 5 lite" entry point. It demonstrates the full
// loop end-to-end:
//   1. deriveCurrentState(slug)  — read disk → state name
//   2. buildStudioConfig(studio) — read studio defs → in-memory shape
//   3. createMachineForStudio()  — config → static xstate machine
//   4. createActor(machine, { input: context })
//      .start()
//      — initial state is `select_studio` (machine's `initial`),
//      not the disk-derived state. To reach the derived state, send
//      a synthetic event sequence that walks from initial to
//      target. Or — easier — instantiate a snapshot directly at
//      the derived state.
//   5. snapshot.value gives the current state path
//   6. snapshot.context._lastEntry tells us which entry action ran
//
// The runtime's actual "what action does the agent get?" answer
// still lives in haiku_run_next.ts via runNext(slug). This function
// is the migration framework — per-state migrations swap individual
// states from runNext to xstate-native behavior, with a registry
// flag (xstateNativeStates) controlling which is which.

import { createActor, type AnyActorRef } from "xstate"
import type { OrchestratorAction } from "../../orchestrator.js"
import { listStudios } from "../../studio-reader.js"
import { buildStudioConfig } from "./build-studio-config.js"
import { createMachineForStudio } from "./create-machine-for-studio.js"
import {
	type DerivedContext,
	type DerivedState,
	deriveCurrentState,
} from "./derive-state.js"
import type { StateName } from "./types.js"

/** States that have been fully migrated from runNext to
 *  xstate-native behavior — meaning the OrchestratorAction is
 *  emitted from this layer instead of from runNext. The wrapper
 *  consults this registry to decide whether to use xstate's tick
 *  or fall back to runNext.
 *
 *  Migration criterion: the OrchestratorAction can be emitted from
 *  the derived context alone. Terminal states whose emission depends
 *  on runNext-internal computation (escalate's iteration count,
 *  error's message, blocked's unit list) require a deeper port
 *  before they qualify. */
export const XSTATE_NATIVE_STATES: ReadonlySet<StateName> = new Set([
	// `complete` — pure function of context.slug. Byte-identical to
	// runNext's emission at orchestrator.ts:2200.
	"complete",
	// `select_studio` — emitted when intent.md has no studio set.
	// Payload: { intent, available_studios, message }. available_studios
	// is a pure read via listStudios() (cached, no mutation).
	// Byte-identical to runNext's emission at orchestrator.ts:2171.
	"select_studio",
	// `error` — emitted for the two archive-related terminal cases.
	// Variant chosen by emitNativeAction based on intent metadata.
	// Byte-identical to runNext's emissions at orchestrator.ts:2207
	// (legacy status=archived) and 2214 (archived flag set).
	// Other error sites (frontmatter parse failures, integrity
	// tamper, FSM internal errors) still emit through runNext.
	"error",
] as const)

/** Pure emitter: derive an OrchestratorAction from a state name +
 *  context, for states whose emission is a pure function of context.
 *  Returns null when the state isn't xstate-native or its emission
 *  requires runNext-internal computation.
 *
 *  Each entry here is a per-state migration. The function is the
 *  "state's entry action emits the OrchestratorAction" boundary —
 *  callers (haiku_run_next.ts) check this first and fall back to
 *  runNext when null. */
export function emitNativeAction(
	state: StateName,
	context: DerivedContext,
): OrchestratorAction | null {
	switch (state) {
		case "complete":
			return {
				action: "complete",
				message: `Intent '${context.slug}' is already completed`,
			}
		case "select_studio": {
			const available = listStudios().map((s) => ({
				name: s.name,
				slug: s.slug,
				aliases: s.aliases,
				description: s.description,
				category: s.category,
			}))
			return {
				action: "select_studio",
				intent: context.slug,
				available_studios: available,
				message: `Intent '${context.slug}' has no studio selected. Call haiku_select_studio { intent: "${context.slug}" } to choose a lifecycle studio.`,
			}
		}
		case "error": {
			// Two variants — legacy status=archived (recoverable via
			// /haiku:repair) and the newer archived flag (recoverable
			// via haiku_intent_unarchive). Other error sites stay on
			// runNext until their per-state migrations land.
			const status = (context.intent.status as string) || ""
			if (status === "archived") {
				return {
					action: "error",
					message: `Intent '${context.slug}' has status: archived (legacy/terminal). haiku_intent_unarchive only clears the new \`archived\` field — it does not touch \`status\`. To recover, run \`/haiku:repair\` or manually edit \`.haiku/intents/${context.slug}/intent.md\` and set \`status: active\`.`,
				}
			}
			if (context.intent.archived === true) {
				return {
					action: "error",
					message: `Intent '${context.slug}' is archived. Call haiku_intent_unarchive to restore it.`,
				}
			}
			// Derived `error` from an unknown phase — runNext doesn't
			// have a direct match here, fall back so it can surface
			// the corruption.
			return null
		}
		default:
			return null
	}
}

/** Result of a single tick. The `action` field is the
 *  OrchestratorAction the agent should follow when driver ===
 *  "xstate"; runNext-driven results carry null and the caller falls
 *  back to runNext(slug). */
export interface FsmTickResult {
	readonly state: StateName
	readonly context: DerivedState["context"]
	readonly driver: "xstate" | "runNext"
	readonly action: OrchestratorAction | null
	/** xstate snapshot when driver === "xstate", null otherwise. */
	readonly snapshot: ReturnType<AnyActorRef["getSnapshot"]> | null
}

/** Run one FSM tick for an intent. Reads disk, derives state, and —
 *  if the state is xstate-native — runs the machine briefly to
 *  emit telemetry + capture a snapshot. */
export function runFsmTick(
	slug: string,
	root?: string,
): FsmTickResult | null {
	const derived = deriveCurrentState(slug, root)
	if (!derived) return null

	if (!XSTATE_NATIVE_STATES.has(derived.state)) {
		return {
			state: derived.state,
			context: derived.context,
			driver: "runNext",
			action: null,
			snapshot: null,
		}
	}

	// xstate-native path. Emit the action via the pure native-action
	// emitter; spin up the machine for the snapshot/telemetry side
	// effect.
	const action = emitNativeAction(derived.state, derived.context)

	const studio = derived.context.studio
	let snapshot: ReturnType<AnyActorRef["getSnapshot"]> | null = null
	if (studio) {
		const studioConfig = buildStudioConfig(studio)
		if (studioConfig) {
			const studioMachine = createMachineForStudio(studioConfig)
			const actor = createActor(studioMachine.machine, {
				input: derived.context as never,
			})
			actor.start()
			snapshot = actor.getSnapshot()
			actor.stop()
		}
	}

	// If the emitter returned null (state is in the registry but no
	// pure emission path exists yet), fall back to runNext so the
	// caller still gets an OrchestratorAction.
	if (!action) {
		return {
			state: derived.state,
			context: derived.context,
			driver: "runNext",
			action: null,
			snapshot,
		}
	}

	return {
		state: derived.state,
		context: derived.context,
		driver: "xstate",
		action,
		snapshot,
	}
}
