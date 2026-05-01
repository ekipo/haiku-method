// orchestrator/workflow/drift-detection-gate.ts — Pre-tick drift-detection gate.
//
// Responsibilities:
//   - `runDriftDetectionGate(ctx)` — synchronous gate that:
//       1. Checks the kill-switch (`settings.drift_detection === false` → no-op).
//       2. Reads the pending-assessment marker store.
//       3. Reads the per-stage baseline (null → establish-mode; corrupt → error).
//       4. Enumerates the tracked surface.
//       5. Compares current SHA against baseline per file.
//       6. Applies marker suppression / stale-marker handling.
//       7. Emits `DriftFinding[]` per DATA-CONTRACTS.md §3.1.
//       8. Applies the out-of-sync heuristic (>50% surface drifted).
//       9. Returns the result (action: 'manual_change_assessment' | null).
//
// All I/O is synchronous so that `runWorkflowTick` stays synchronous.
//
// Position in the pre-tick gate chain (ARCHITECTURE.md §2.1 / AC-G13):
//   tamper-detection → feedback-triage → drift-detection → per-state dispatch
//
// Spec references: unit-04-pre-tick-drift-gate.md, ARCHITECTURE.md §3, §8,
// DATA-CONTRACTS.md §3.1, ACCEPTANCE-CRITERIA.md AC-G1 through AC-G13.

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
	type AuthorClass,
	type Baseline,
	type BaselineEntry,
	baselineContentPath,
	baselineIntentContentPath,
	computeFileSha256Sync,
	enumerateTrackedSurface,
	isBinarySync,
	isDriftDetectionDisabled,
	readActionLogSync,
	readBaseline,
	readBaselineContentWithFallback,
	type TrackingClass,
	writeBaselineContentSync,
	writeBaselineIntentContentSync,
	writeBaselineSync,
} from "./drift-baseline.js"

// Re-export so callers that import isDriftDetectionDisabled from this module
// continue to work (e.g. drift-detection-gate.test.mjs).
export { isDriftDetectionDisabled }

import {
	findOpenMarker,
	isStaleMarker,
	readMarkers,
	removeMarker,
} from "./drift-markers.js"

// ── Types ──────────────────────────────────────────────────────────────────

/** One detected divergence between baseline and disk (DATA-CONTRACTS.md §3.1). */
export interface DriftFinding {
	path: string
	change_kind: "new-file-detected" | "modified" | "file-removed"
	is_binary: boolean
	diff_unified: string | null
	before_sha256: string | null
	after_sha256: string | null
	before_bytes: number | null
	after_bytes: number | null
	tracking_class: TrackingClass
	stage: string | null
	context_unit: string | null
	/** True when this is a synthetic out-of-sync finding (ARCHITECTURE.md §8.3). */
	is_baseline_oom?: boolean
	/** Author class attributed to this finding (ARCHITECTURE.md §6.2).
	 *  Set by the gate from the action log; carried through dispatch so
	 *  haiku_classify_drift can write the correct author_class on the
	 *  baseline entry without re-reading the log. */
	author_class?: AuthorClass
}

/** Return type of `runDriftDetectionGate`. */
export interface DriftDetectionGateResult {
	findings: DriftFinding[]
	baselineEstablished: boolean
	action: "manual_change_assessment" | null
	error?: "baseline_corrupt"
	errorMessage?: string
}

/** Context passed to the gate by `runWorkflowTick`. */
export interface DriftGateCtx {
	/** Absolute path to the intent directory (.haiku/intents/{slug}). */
	intentDir: string
	/** Intent slug. */
	intentSlug: string
	/** Currently active stage name. */
	activeStage: string
	/** Absolute path to the .haiku root directory (for settings.yml). */
	haikuRoot: string
	/** Current tick counter (from stage state.json or 0 if unavailable). */
	tickCounter: number
}

// ── Diff generation ────────────────────────────────────────────────────────

const MAX_DIFF_LINES = 200
const NEW_FILE_BINARY_THRESHOLD = 256 * 1024 // 256 KB

/** Retrieve the "before" file content from the content sidecar and produce
 *  a unified diff against the current file content. Returns null when the
 *  sidecar is absent (not yet written) or any error occurs.
 *
 *  The sidecar lives at `stages/{stage}/baseline-content/{sha256}` and is
 *  written by `writeBaselineSync` / `writeBaseline` at baseline-write time
 *  and lazily during steady-state scans. This avoids relying on git's
 *  SHA-1 object store (git cat-file blob requires a SHA-1 address, not a
 *  SHA-256 digest). */
function buildUnifiedDiff(
	intentDir: string,
	activeStage: string,
	pathRel: string,
	beforeSha256: string,
	afterAbsPath: string,
): string | null {
	try {
		// Try stage path first, fall back to intent-level for knowledge/ files.
		const beforeBuf = readBaselineContentWithFallback(
			intentDir,
			activeStage,
			beforeSha256,
		)
		if (beforeBuf === null) return null

		const afterBuf = readFileSync(afterAbsPath)

		const before = beforeBuf.toString("utf-8").split("\n")
		const after = afterBuf.toString("utf-8").split("\n")

		const diffLines = generateUnifiedDiff(before, after, pathRel)
		if (diffLines.length === 0) return null

		const truncated =
			diffLines.length > MAX_DIFF_LINES
				? [
						...diffLines.slice(0, MAX_DIFF_LINES),
						`... (truncated, full diff at ${pathRel})`,
					]
				: diffLines

		return truncated.join("\n")
	} catch {
		return null
	}
}

/** Diff operation: equal, delete, or insert. */
type DiffOp =
	| { type: "equal"; bi: number; ai: number }
	| { type: "delete"; bi: number }
	| { type: "insert"; ai: number }

/** Compute LCS-based edit sequence via standard DP table.
 *  Returns a sequence of equal/delete/insert ops.
 *  O(N*M) space — capped by the caller to avoid pathological inputs. */
function lcsEditScript(before: string[], after: string[]): DiffOp[] {
	const N = before.length
	const M = after.length
	// Build LCS lengths table.
	const dp: number[][] = Array.from({ length: N + 1 }, () =>
		new Array(M + 1).fill(0),
	)
	for (let i = 1; i <= N; i++) {
		for (let j = 1; j <= M; j++) {
			if (before[i - 1] === after[j - 1]) {
				dp[i][j] = dp[i - 1][j - 1] + 1
			} else {
				dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
			}
		}
	}
	// Backtrack to produce ops.
	const ops: DiffOp[] = []
	let i = N
	let j = M
	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && before[i - 1] === after[j - 1]) {
			ops.push({ type: "equal", bi: i - 1, ai: j - 1 })
			i--
			j--
		} else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
			ops.push({ type: "insert", ai: j - 1 })
			j--
		} else {
			ops.push({ type: "delete", bi: i - 1 })
			i--
		}
	}
	ops.reverse()
	return ops
}

/** LCS-based unified diff generator with 3 lines of context.
 *  Produces a readable diff suitable for agent classification.
 *  Returns empty array when there are no differences. */
function generateUnifiedDiff(
	before: string[],
	after: string[],
	path: string,
): string[] {
	const CONTEXT = 3
	const MAX_LCS_CELLS = 200_000 // ~200 k cells ≈ 447×447 lines each side

	// Fall back to a simple full-replace diff for very large files to avoid
	// O(N*M) memory blow-up. This is intentionally conservative.
	let ops: DiffOp[]
	if (before.length * after.length > MAX_LCS_CELLS) {
		// Simple fallback: treat the whole file as replaced.
		ops = [
			...before.map((_, bi) => ({ type: "delete" as const, bi })),
			...after.map((_, ai) => ({ type: "insert" as const, ai })),
		]
	} else {
		ops = lcsEditScript(before, after)
	}

	// Check if there are any changes at all.
	const hasChanges = ops.some((op) => op.type !== "equal")
	if (!hasChanges) return []

	// Group ops into hunks (runs of non-equal ops, each padded with CONTEXT equal
	// lines on either side, with adjacent hunks merged when their context windows
	// overlap).
	type Hunk = { ops: DiffOp[]; bStart: number; aStart: number }
	const hunks: Hunk[] = []
	let hunk: Hunk | null = null
	// Track trailing equal-op count to trim excess context from a closed hunk.
	let trailingEqual = 0

	for (const op of ops) {
		if (op.type === "equal") {
			if (hunk !== null) {
				hunk.ops.push(op)
				trailingEqual++
				// If we've accumulated more than 2*CONTEXT equal lines since the
				// last change, close the hunk (keep only CONTEXT trailing lines).
				if (trailingEqual > 2 * CONTEXT) {
					// Trim excess trailing equal ops from the END, keeping CONTEXT.
					hunk.ops.splice(hunk.ops.length - (trailingEqual - CONTEXT))
					hunks.push(hunk)
					hunk = null
					trailingEqual = 0
				}
			}
			// Outside a hunk: track for leading context.
			// We don't buffer pre-hunk ops here; we reconstruct from indices below.
		} else {
			trailingEqual = 0
			if (hunk === null) {
				hunk = { ops: [], bStart: 0, aStart: 0 }
				// Back-fill up to CONTEXT leading equal ops.
				const bIdx = op.type === "delete" ? op.bi : -1
				const aIdx = op.type === "insert" ? op.ai : -1
				// Determine where we are in before/after.
				const leadBi = bIdx >= 0 ? bIdx : aIdx >= 0 ? aIdx : 0
				const leadAi = aIdx >= 0 ? aIdx : bIdx >= 0 ? bIdx : 0
				const leadStart = Math.max(0, Math.min(leadBi, leadAi) - CONTEXT)
				hunk.bStart = Math.max(0, leadBi - CONTEXT)
				hunk.aStart = Math.max(0, leadAi - CONTEXT)
				for (let k = leadStart; k < Math.min(leadBi, leadAi); k++) {
					if (k < before.length && k < after.length) {
						hunk.ops.push({ type: "equal", bi: k, ai: k })
					}
				}
			}
			hunk.ops.push(op)
		}
	}
	if (hunk !== null) {
		// Trim trailing equal ops beyond CONTEXT (remove excess from the END).
		if (trailingEqual > CONTEXT) {
			hunk.ops.splice(hunk.ops.length - (trailingEqual - CONTEXT))
		}
		hunks.push(hunk)
	}

	if (hunks.length === 0) return []

	const lines: string[] = []
	lines.push(`--- a/${path}`)
	lines.push(`+++ b/${path}`)

	for (const h of hunks) {
		// Count old/new lines in hunk for @@ header.
		let oldCount = 0
		let newCount = 0
		let oldStart = -1
		let newStart = -1
		for (const op of h.ops) {
			if (op.type === "equal") {
				if (oldStart < 0) oldStart = op.bi
				if (newStart < 0) newStart = op.ai
				oldCount++
				newCount++
			} else if (op.type === "delete") {
				if (oldStart < 0) oldStart = op.bi
				oldCount++
			} else {
				if (newStart < 0) newStart = op.ai
				newCount++
			}
		}
		if (oldStart < 0) oldStart = 0
		if (newStart < 0) newStart = 0
		lines.push(
			`@@ -${oldStart + 1},${oldCount} +${newStart + 1},${newCount} @@`,
		)
		for (const op of h.ops) {
			if (op.type === "equal") {
				lines.push(` ${before[op.bi] ?? ""}`)
			} else if (op.type === "delete") {
				lines.push(`-${before[op.bi] ?? ""}`)
			} else {
				lines.push(`+${after[op.ai] ?? ""}`)
			}
		}
	}

	return lines
}

/** Build a new-file diff payload (+++only) for a text file under the size threshold. */
function buildNewFileDiff(absPath: string, pathRel: string): string | null {
	try {
		const buf = readFileSync(absPath)
		if (buf.length > NEW_FILE_BINARY_THRESHOLD) return null
		const content = buf.toString("utf-8")
		const fileLines = content.split("\n")
		const header = [
			`--- /dev/null`,
			`+++ b/${pathRel}`,
			`@@ -0,0 +1,${fileLines.length} @@`,
		]
		const body = fileLines.map((l) => `+${l}`)
		const full = [...header, ...body]
		const truncated =
			full.length > MAX_DIFF_LINES
				? [
						...full.slice(0, MAX_DIFF_LINES),
						`... (truncated, full diff at ${pathRel})`,
					]
				: full
		return truncated.join("\n")
	} catch {
		return null
	}
}

// ── State.json stamping ────────────────────────────────────────────────────

/** Stamp `drift_baseline_established_at` in the stage's state.json when the
 *  gate runs in establish-mode (AC-G8). Non-fatal if state.json is absent. */
function stampBaselineEstablished(intentDir: string, stage: string): void {
	const stateFile = join(intentDir, "stages", stage, "state.json")
	try {
		let existing: Record<string, unknown> = {}
		if (existsSync(stateFile)) {
			try {
				existing = JSON.parse(readFileSync(stateFile, "utf-8")) as Record<
					string,
					unknown
				>
			} catch {
				return
			}
		}
		existing.drift_baseline_established_at = new Date().toISOString()
		writeFileSync(stateFile, `${JSON.stringify(existing, null, 2)}\n`, "utf-8")
	} catch {
		// Non-fatal.
	}
}

// ── Gate ───────────────────────────────────────────────────────────────────

/** Run the pre-tick drift-detection gate.
 *
 *  Returns a `DriftDetectionGateResult`:
 *   - `findings: []` + `action: null` when there is nothing to assess.
 *   - `findings: [...]` + `action: 'manual_change_assessment'` when drift found.
 *   - `baselineEstablished: true` + `action: null` on first-tick establish.
 *   - `error: 'baseline_corrupt'` when the baseline file is corrupt.
 *
 *  The function is synchronous so that `runWorkflowTick` stays synchronous.
 *
 *  @param ctx Gate context. See `DriftGateCtx`.
 */
export function runDriftDetectionGate(
	ctx: DriftGateCtx,
): DriftDetectionGateResult {
	const { intentDir, activeStage, haikuRoot, tickCounter } = ctx

	// 1. Kill-switch: if disabled, the gate is a complete no-op (AC-G1-KS).
	if (isDriftDetectionDisabled(haikuRoot)) {
		return { findings: [], baselineEstablished: false, action: null }
	}

	// 2. Read pending-assessment markers (non-fatal on missing/corrupt).
	const markerStore = readMarkers(intentDir)

	// 3. Read the baseline. null → establish mode. Corrupt → error.
	let baseline: Baseline | null
	try {
		baseline = readBaseline(intentDir, activeStage)
	} catch (err) {
		// BaselineCorruptError (ARCHITECTURE.md §8.2 / AC-EE4).
		const msg =
			err instanceof Error
				? err.message
				: `Baseline file for stage '${activeStage}' is corrupt. Run haiku_repair to re-establish the baseline.`
		return {
			findings: [],
			baselineEstablished: false,
			action: null,
			error: "baseline_corrupt",
			errorMessage: msg,
		}
	}

	// 4. Enumerate the tracked surface.
	const surface = enumerateTrackedSurface(intentDir, activeStage)

	// 5. Establish mode (AC-G8 / ARCHITECTURE.md §3.4).
	if (baseline === null) {
		const now = new Date().toISOString()
		const newEntries = new Map<string, BaselineEntry>()

		for (const entry of surface) {
			try {
				const sha256 = computeFileSha256Sync(entry.absPath)
				const binary = isBinarySync(entry.absPath)
				const st = statSync(entry.absPath)
				const mtime_ns = Math.round(st.mtimeMs * 1_000_000)
				const bytes = st.size

				newEntries.set(entry.pathRel, {
					path: entry.pathRel,
					sha256,
					bytes,
					mtime_ns,
					is_binary: binary,
					author_class: "agent",
					acknowledged_at: now,
					acknowledged_via: "baseline-init",
					stage: entry.stageOwner,
					tracking_class: entry.trackingClass,
				})
			} catch {
				// Unreadable file during establish — skip it.
			}
		}

		const newBaseline: Baseline = { entries: newEntries }
		try {
			writeBaselineSync(intentDir, activeStage, newBaseline)
		} catch {
			// Write failure during establish — continue (gate retries next tick).
		}

		stampBaselineEstablished(intentDir, activeStage)

		return { findings: [], baselineEstablished: true, action: null }
	}

	// 6. Read the action log for this tick (for author-class attribution).
	const actionLogEntries = readActionLogSync(intentDir, tickCounter)

	// 7. Steady-state scan.
	const findings: DriftFinding[] = []
	const surfacePaths = new Set<string>()

	// Stale marker paths — collected for async removal after the loop.
	const staleMarkerPaths: string[] = []

	for (const entry of surface) {
		surfacePaths.add(entry.pathRel)

		let currentSha: string
		let currentBytes: number
		let currentBinary: boolean

		try {
			currentSha = computeFileSha256Sync(entry.absPath)
			const st = statSync(entry.absPath)
			currentBytes = st.size
			currentBinary = isBinarySync(entry.absPath)
		} catch {
			// File disappeared between enumeration and hashing — treated as
			// deleted in the baseline-entry check below.
			continue
		}

		const baselineEntry = baseline.entries.get(entry.pathRel)

		if (baselineEntry === undefined) {
			// New file not in baseline (AC-FS2 / DATA-CONTRACTS.md §3.1).
			const diffUnified = currentBinary
				? null
				: buildNewFileDiff(entry.absPath, entry.pathRel)

			findings.push({
				path: entry.pathRel,
				change_kind: "new-file-detected",
				is_binary: currentBinary,
				diff_unified: diffUnified,
				before_sha256: null,
				after_sha256: currentSha,
				before_bytes: null,
				after_bytes: currentBytes,
				tracking_class: entry.trackingClass,
				stage: entry.stageOwner,
				context_unit: null,
			})
			continue
		}

		if (baselineEntry.sha256 === currentSha) {
			// No change — happy path. Lazily write the content sidecar so that
			// "before" content is available the next time this file changes.
			// Intent-scope entries (stageOwner === null) get a sidecar at the
			// intent level to survive stage transitions.
			if (!currentBinary && !baselineEntry.is_binary) {
				const isIntentScope = entry.stageOwner === null
				const sidecarPath = isIntentScope
					? baselineIntentContentPath(intentDir, currentSha)
					: baselineContentPath(intentDir, activeStage, currentSha)
				if (!existsSync(sidecarPath)) {
					try {
						const buf = readFileSync(entry.absPath)
						if (isIntentScope) {
							writeBaselineIntentContentSync(intentDir, currentSha, buf)
						} else {
							writeBaselineContentSync(intentDir, activeStage, currentSha, buf)
						}
					} catch {
						// Non-fatal.
					}
				}
			}
			continue
		}

		// SHA differs. Check markers before emitting.
		const openMarker = findOpenMarker(markerStore, entry.pathRel)

		if (openMarker !== null) {
			if (isStaleMarker(openMarker, currentSha)) {
				// Double-edit: SHA changed since marker was created (AC-EE6).
				staleMarkerPaths.push(entry.pathRel)
				// Fall through to emit a fresh finding.
			} else {
				// Marker is current — suppress (AC-SF2).
				continue
			}
		}

		// Determine author class from action log (ARCHITECTURE.md §6.2).
		const logEntry = actionLogEntries.find(
			(e) => e.path === entry.pathRel && e.entry_type === "human_write",
		)
		// authorClass is carried into the finding so the assessment handler
		// can populate the DriftFinding and Assessment records accurately.
		const authorClass = logEntry ? "human-via-mcp" : baselineEntry.author_class

		// Build diff for text files. Write a lazy sidecar for unchanged files
		// so "before" content is available when the file eventually changes.
		const bothText = !currentBinary && !baselineEntry.is_binary
		const diffUnified = bothText
			? buildUnifiedDiff(
					intentDir,
					activeStage,
					entry.pathRel,
					baselineEntry.sha256,
					entry.absPath,
				)
			: null

		findings.push({
			path: entry.pathRel,
			change_kind: "modified",
			is_binary: currentBinary || baselineEntry.is_binary,
			diff_unified: bothText ? diffUnified : null,
			before_sha256: baselineEntry.sha256,
			after_sha256: currentSha,
			before_bytes: baselineEntry.bytes,
			after_bytes: currentBytes,
			tracking_class: entry.trackingClass,
			stage: entry.stageOwner,
			context_unit: null,
			author_class: authorClass,
		})
	}

	// Remove stale markers (fire-and-forget, non-blocking).
	for (const pathRel of staleMarkerPaths) {
		removeMarker(intentDir, pathRel).catch(() => {
			// Non-fatal: the stale marker will be detected again on the next tick.
		})
	}

	// 8. Check for baseline entries whose files no longer exist (AC-EE2).
	for (const [pathRel, baselineEntry] of baseline.entries) {
		if (surfacePaths.has(pathRel)) continue
		// File was in baseline but not found in the surface scan.
		const absPath = join(intentDir, pathRel)
		if (!existsSync(absPath)) {
			findings.push({
				path: pathRel,
				change_kind: "file-removed",
				is_binary: baselineEntry.is_binary,
				diff_unified: null,
				before_sha256: baselineEntry.sha256,
				after_sha256: null,
				before_bytes: baselineEntry.bytes,
				after_bytes: null,
				tracking_class: baselineEntry.tracking_class,
				stage: baselineEntry.stage,
				context_unit: null,
			})
		}
	}

	// 9. Out-of-sync heuristic (ARCHITECTURE.md §8.3):
	//    When > 50% of the effective surface has drifted, emit a single
	//    synthetic finding instead of the full list.
	const effectiveSurfaceSize = Math.max(
		surface.length,
		baseline.entries.size,
		1,
	)
	if (findings.length > 0 && findings.length > effectiveSurfaceSize * 0.5) {
		const syntheticFinding: DriftFinding = {
			path: `<${activeStage}>`,
			change_kind: "modified",
			is_binary: false,
			diff_unified: null,
			before_sha256: null,
			after_sha256: null,
			before_bytes: null,
			after_bytes: null,
			tracking_class: "stage-output",
			stage: activeStage,
			context_unit: null,
			is_baseline_oom: true,
		}
		return {
			findings: [syntheticFinding],
			baselineEstablished: false,
			action: "manual_change_assessment",
		}
	}

	if (findings.length === 0) {
		return { findings: [], baselineEstablished: false, action: null }
	}

	return {
		findings,
		baselineEstablished: false,
		action: "manual_change_assessment",
	}
}
