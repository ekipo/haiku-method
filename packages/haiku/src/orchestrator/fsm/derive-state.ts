// orchestrator/fsm/derive-state.ts — Pure function: read disk →
// return current FSM state name + minimal context.
//
// The function never writes; it only reads. Every call is a fresh
// snapshot of the on-disk state. Callers (xstate machine
// instantiation, visualization, debugging) consume the result without
// affecting future calls.
//
// State derivation mirrors the top-level branching in the legacy
// runNext switch. Where runNext does deep computation (DAG topo,
// pending-feedback scans, etc.) to decide which sub-state to enter,
// derivation here returns the COARSE state name and lets the per-
// state file's `decide` (or its xstate equivalent) handle the
// finer-grained branching at runtime. This is the contract:
//   - Derivation answers: "which state node am I conceptually in?"
//   - The state node answers: "given my current context, which
//     transition fires next?"
//
// The split keeps derivation testable in isolation — fixtures only
// need to set the fields derivation reads, not the full disk state
// runNext requires.

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
	intentDir,
	parseFrontmatter,
	readJson,
} from "../../state-tools.js"
import type { StateName } from "./types.js"

export interface DerivedContext {
	readonly slug: string
	readonly studio: string
	/** Absolute path to the intent dir (`.haiku/intents/{slug}`). */
	readonly intentDirPath: string
	/** Full intent.md frontmatter — readers may pull additional
	 *  fields beyond what derivation already extracted. */
	readonly intent: Record<string, unknown>
	/** Active stage when the FSM is mid-stage. Empty string for
	 *  pre-stage states (select_studio, start_stage with no active
	 *  stage yet) and post-final states. */
	readonly currentStage: string
	/** Stage phase (elaborate / execute / review / gate). Empty
	 *  string when stage is pending. */
	readonly currentPhase: string
	/** Stage state.json contents when a stage is active. Empty
	 *  object otherwise. */
	readonly stageState: Record<string, unknown>
}

export interface DerivedState {
	readonly state: StateName
	readonly context: DerivedContext
}

/** Derive the FSM state for an intent from disk. Pure read; the
 *  function never mutates. Returns null when the intent doesn't
 *  exist. */
export function deriveCurrentState(
	slug: string,
	root?: string,
): DerivedState | null {
	const iDir = root ? join(root, "intents", slug) : intentDir(slug)
	const intentFile = join(iDir, "intent.md")
	if (!existsSync(intentFile)) return null

	const { data: intent } = parseFrontmatter(readFileSync(intentFile, "utf8"))
	const studio = (intent.studio as string) || ""
	const status = (intent.status as string) || "active"
	const phase = (intent.phase as string) || ""
	const archived = intent.archived === true

	const baseContext = (
		stage: string,
		stagePhase: string,
		stageState: Record<string, unknown>,
	): DerivedContext => ({
		slug,
		studio,
		intentDirPath: iDir,
		intent,
		currentStage: stage,
		currentPhase: stagePhase,
		stageState,
	})

	// Terminal: archived or completed.
	if (archived || status === "completed") {
		return {
			state: "complete",
			context: baseContext("", "", {}),
		}
	}

	// Pre-studio: no studio selected yet.
	if (!studio) {
		return {
			state: "select_studio",
			context: baseContext("", "", {}),
		}
	}

	// Intent-level phases (intent_review and intent_completion) are
	// driven by intent.phase, not stage state. They short-circuit
	// stage processing.
	if (phase === "intent_review") {
		return {
			state: "gate_review",
			context: baseContext("", "", {}),
		}
	}
	if (phase === "intent_completion") {
		const dispatched = intent.completion_review_dispatched === true
		if (!dispatched) {
			return {
				state: "intent_completion_review",
				context: baseContext("", "", {}),
			}
		}
		// Dispatched — could be intent_completion_fix (pending
		// feedback) or gate_review (final approval). The fine-grained
		// pick happens inside the state's decide(); coarse derivation
		// returns intent_completion_fix as the entrypoint.
		return {
			state: "intent_completion_fix",
			context: baseContext("", "", {}),
		}
	}

	// Stage-driven phases. Read active_stage and its state.json.
	const activeStage = (intent.active_stage as string) || ""
	if (!activeStage) {
		// No active stage — FSM is about to enter the first
		// (or next) stage.
		return {
			state: "start_stage",
			context: baseContext("", "", {}),
		}
	}

	// Build the stage state.json path explicitly from iDir so test
	// fixtures rooted at a tmpdir resolve correctly. Mirrors the
	// shape of state-tools.ts's stageStatePath without depending on
	// process.cwd-based findHaikuRoot().
	const stageStateFile = join(iDir, "stages", activeStage, "state.json")
	const stageState: Record<string, unknown> = existsSync(stageStateFile)
		? (readJson(stageStateFile) as Record<string, unknown>)
		: {}
	const stagePhase = (stageState.phase as string) || ""
	const stageStatus = (stageState.status as string) || "pending"

	// Stage not started yet.
	if (!stagePhase || stageStatus === "pending") {
		return {
			state: "start_stage",
			context: baseContext(activeStage, "", stageState),
		}
	}

	// Stage in progress — map phase to state.
	switch (stagePhase) {
		case "elaborate":
			return {
				state: "elaborate",
				context: baseContext(activeStage, stagePhase, stageState),
			}
		case "execute":
			return {
				state: "execute",
				context: baseContext(activeStage, stagePhase, stageState),
			}
		case "review":
			return {
				state: "review",
				context: baseContext(activeStage, stagePhase, stageState),
			}
		case "gate":
			return {
				state: "gate_review",
				context: baseContext(activeStage, stagePhase, stageState),
			}
		default:
			// Unknown phase — surface as error so the test fixture
			// catches the corruption rather than the runtime fudging
			// it.
			return {
				state: "error",
				context: baseContext(activeStage, stagePhase, stageState),
			}
	}

}
