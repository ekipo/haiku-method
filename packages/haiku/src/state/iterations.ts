// state/iterations.ts — Stage + unit iteration tracking.
//
// Stage-level iterations replace the legacy scalar `visits` counter. Each
// entry records why a fresh elaborate cycle started (trigger), when it
// opened, when it closed, and what resolved it (result), and a signature
// of the feedback set that drove it (for loop detection).
//
// Unit-level iterations record per-hat progression on the unit itself so
// the unit frontmatter carries its own history. Orthogonal to the unit's
// bolt counter — bolts track full designer → reviewer cycles; iterations
// track individual hat runs.

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import matter from "gray-matter"
import { emitTelemetry } from "../telemetry.js"
import {
	parseFrontmatter,
	readJson,
	stageStatePath,
	timestamp,
	writeJson,
} from "./shared.js"

// ── Stage iterations ──────────────────────────────────────────────────────

export type StageIterationTrigger =
	| "initial"
	| "external-changes"
	| "feedback"
	| "user-revisit"

export type StageIterationResult =
	| "advanced"
	| "feedback-revisit"
	| "external-changes"
	| "user-revisit"
	| "rejected"

export interface StageIteration {
	index: number
	started_at: string
	completed_at: string | null
	trigger: StageIterationTrigger
	result: StageIterationResult | null
	reason?: string
	/** SHA1 of the sorted-joined feedback titles pending at the moment this
	 *  iteration opened. Two consecutive iterations with the same signature
	 *  indicate a loop — the agent keeps generating the same findings. */
	feedback_signature?: string
}

/** Maximum number of agent-invoked iterations allowed before the FSM
 *  escalates to the human. User-invoked revisits (`trigger: "user-revisit"`)
 *  are NOT capped — explicit user intent always wins.
 *
 *  Dropped from 5 → 2 (2026-04-19): the goal is 0 rejections via upfront
 *  spec rigor (pre-execution adversarial review + full-stage gate scope +
 *  executable gates). Two agent-invoked retries is enough to catch the
 *  rare emergent issue; more than that indicates a spec problem the human
 *  must resolve. */
export const MAX_STAGE_ITERATIONS = 2

/**
 * Maximum number of bolts (full hat-sequence iterations) a unit can run.
 *
 * Used by THREE distinct rejection paths — keep them coupled here so the
 * limit doesn't silently diverge if one is tuned.
 */
export const MAX_UNIT_BOLTS = 5

/** Build a loop-detection signature from a list of feedback titles.
 *  Stable hash of the sorted, normalized title set. */
export function computeFeedbackSignature(titles: string[]): string {
	const norm = titles
		.map((t) => (t || "").trim().toLowerCase())
		.filter((t) => t.length > 0)
		.sort()
	if (norm.length === 0) return ""
	// djb2 — plenty for "same set of findings as last iteration".
	let hash = 5381
	for (const s of norm) {
		for (let i = 0; i < s.length; i++) {
			hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0
		}
		hash = ((hash << 5) + hash + 0x2c) | 0
	}
	return `sig:${(hash >>> 0).toString(16)}`
}

export interface AppendIterationResult {
	count: number
	exceeded: boolean
	loopDetected: boolean
	signature: string
}

/** Normalized iteration count — prefer the iterations array, fall back to
 *  the legacy `visits` scalar so existing state files stay readable. */
export function getStageIterationCount(
	stageState: Record<string, unknown>,
): number {
	const arr = stageState.iterations as StageIteration[] | undefined
	if (Array.isArray(arr)) return arr.length
	const legacy = stageState.visits as number | undefined
	return typeof legacy === "number" ? legacy : 0
}

/** Read the iterations array with a migration fallback from `visits: N`. */
function readIterations(stageState: Record<string, unknown>): StageIteration[] {
	const arr = stageState.iterations as StageIteration[] | undefined
	if (Array.isArray(arr)) return arr.slice()
	const legacyVisits = (stageState.visits as number) || 0
	if (legacyVisits <= 0) return []
	const now = timestamp()
	return Array.from({ length: legacyVisits }, (_, i) => ({
		index: i + 1,
		started_at: now,
		completed_at: i < legacyVisits - 1 ? now : null,
		trigger: "initial" as StageIterationTrigger,
		result: i < legacyVisits - 1 ? ("advanced" as StageIterationResult) : null,
	}))
}

/** Append a new stage iteration. Closes the previous one (if open) with
 *  `prevResult`, then opens a fresh entry. */
export function appendStageIteration(
	slug: string,
	stage: string,
	entry: {
		trigger: StageIterationTrigger
		reason?: string
		feedbackTitles?: string[]
	},
	prevResult: StageIterationResult = "feedback-revisit",
): AppendIterationResult {
	const path = stageStatePath(slug, stage)
	const state = readJson(path)
	const iters = readIterations(state)
	const now = timestamp()
	if (iters.length > 0) {
		const last = iters[iters.length - 1]
		if (!last.completed_at) last.completed_at = now
		if (!last.result) last.result = prevResult
	}
	const signature = entry.feedbackTitles
		? computeFeedbackSignature(entry.feedbackTitles)
		: ""
	iters.push({
		index: iters.length + 1,
		started_at: now,
		completed_at: null,
		trigger: entry.trigger,
		result: null,
		...(entry.reason ? { reason: entry.reason } : {}),
		...(signature ? { feedback_signature: signature } : {}),
	})
	state.iterations = iters
	state.visits = iters.length
	writeJson(path, state)

	const count = iters.length
	const isAgentInvoked =
		entry.trigger === "feedback" || entry.trigger === "external-changes"
	const exceeded = isAgentInvoked && count > MAX_STAGE_ITERATIONS
	let loopDetected = false
	if (signature && isAgentInvoked && iters.length >= 2) {
		const prev = iters[iters.length - 2]
		if (prev.feedback_signature && prev.feedback_signature === signature) {
			loopDetected = true
		}
	}

	emitTelemetry("haiku.stage.iteration", {
		intent: slug,
		stage,
		iteration: String(count),
		trigger: entry.trigger,
		signature,
		exceeded: String(exceeded),
		loop_detected: String(loopDetected),
	})

	return { count, exceeded, loopDetected, signature }
}

/** Close the currently-open iteration with a terminal result (used when a
 *  stage advances or is rejected without spawning a new iteration). */
export function closeCurrentStageIteration(
	slug: string,
	stage: string,
	result: StageIterationResult,
	reason?: string,
): void {
	const path = stageStatePath(slug, stage)
	const state = readJson(path)
	const iters = readIterations(state)
	if (iters.length === 0) {
		iters.push({
			index: 1,
			started_at: timestamp(),
			completed_at: timestamp(),
			trigger: "initial",
			result,
			...(reason ? { reason } : {}),
		})
	} else {
		const last = iters[iters.length - 1]
		if (!last.completed_at) last.completed_at = timestamp()
		last.result = result
		if (reason) last.reason = reason
	}
	state.iterations = iters
	state.visits = iters.length
	writeJson(path, state)
}

// ── Unit iterations ───────────────────────────────────────────────────────

export type UnitHatResult = "advance" | "reject"

export interface UnitIteration {
	hat: string
	started_at: string
	completed_at: string | null
	result: UnitHatResult | null
	reason?: string
}

/** Append a hat-start event to a unit's iterations. */
export function startUnitIteration(unitFile: string, hat: string): void {
	if (!existsSync(unitFile)) return
	const { data, body } = parseFrontmatter(readFileSync(unitFile, "utf8"))
	const iters = Array.isArray(data.iterations)
		? (data.iterations as UnitIteration[]).slice()
		: []
	iters.push({
		hat,
		started_at: timestamp(),
		completed_at: null,
		result: null,
	})
	data.iterations = iters
	writeFileSync(unitFile, matter.stringify(body, data))
}

/** Close the most recent iteration on the unit with a result + optional
 *  reason. No-op if the file doesn't exist or no open iteration is found. */
export function completeUnitIteration(
	unitFile: string,
	result: UnitHatResult,
	reason?: string,
): void {
	if (!existsSync(unitFile)) return
	const { data, body } = parseFrontmatter(readFileSync(unitFile, "utf8"))
	const iters = Array.isArray(data.iterations)
		? (data.iterations as UnitIteration[]).slice()
		: []
	if (iters.length === 0) return
	const last = iters[iters.length - 1]
	if (last.completed_at) return
	last.completed_at = timestamp()
	last.result = result
	if (reason) last.reason = reason
	data.iterations = iters
	writeFileSync(unitFile, matter.stringify(body, data))
}
