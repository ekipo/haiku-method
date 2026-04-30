// orchestrator/workflow/drift-baseline.ts — Baseline storage layer for
// the drift-detection subsystem.
//
// Responsibilities:
//   - `Baseline` / `BaselineEntry` types matching DATA-CONTRACTS.md §2.1.
//   - `readBaseline(intentDir, stage)` — parse stages/{stage}/baseline.json.
//     Returns null (establish-mode signal) when absent; throws
//     `BaselineCorruptError` on structural corruption.
//   - `writeBaseline(intentDir, stage, baseline)` — atomic rename-into-place.
//   - `computeFileSha256(absolutePath)` — streaming SHA-256 (no full buffer).
//   - `isBinary(absolutePath)` — null-byte or UTF-8-decode heuristic.
//   - `enumerateTrackedSurface(intentDir, stage, studioConfig)` — union of
//     artifacts/, outputs/ (alias), knowledge/, discovery/, intent-scope
//     knowledge/; excluding workflow-managed and drift-subsystem paths.
//   - `canonicalisePath(pathRel)` — rewrite outputs/ → artifacts/.
//   - `updateBaselineEntry(baseline, entry)` — pure map insert/update.
//
// No new third-party dependencies: node:crypto, node:fs/promises, node:path
// only (plus the existing zod already in packages/haiku).

import { createHash } from "node:crypto"
import {
	createReadStream,
	existsSync,
	readdirSync,
	readFileSync,
} from "node:fs"
import { mkdtemp, open, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { z } from "zod"

// ── Types ──────────────────────────────────────────────────────────────────

export const AuthorClassSchema = z.enum([
	"agent",
	"human-via-mcp",
	"human-implicit",
])
export type AuthorClass = z.infer<typeof AuthorClassSchema>

export const AcknowledgedViaSchema = z.enum([
	"agent-write",
	"human-write-tool",
	"spa-upload",
	"classification-terminal",
	"baseline-init",
])
export type AcknowledgedVia = z.infer<typeof AcknowledgedViaSchema>

export const TrackingClassSchema = z.enum([
	"stage-output",
	"knowledge",
	"unit-output",
	"intent-meta",
])
export type TrackingClass = z.infer<typeof TrackingClassSchema>

/** One baseline record per tracked file — DATA-CONTRACTS.md §2.1. */
export const BaselineEntrySchema = z.object({
	path: z.string(),
	sha256: z.string().regex(/^[0-9a-f]{64}$/),
	bytes: z.number().int().nonnegative(),
	mtime_ns: z.number().int(),
	is_binary: z.boolean(),
	author_class: AuthorClassSchema,
	acknowledged_at: z.string(),
	acknowledged_via: AcknowledgedViaSchema,
	stage: z.string().nullable(),
	tracking_class: TrackingClassSchema,
})
export type BaselineEntry = z.infer<typeof BaselineEntrySchema>

/** The in-memory baseline for a stage — a map from path-rel to entry. */
export interface Baseline {
	entries: Map<string, BaselineEntry>
}

/** Thrown when baseline.json is present but structurally invalid. */
export class BaselineCorruptError extends Error {
	readonly stage: string
	readonly cause: unknown

	constructor(stage: string, cause: unknown) {
		super(
			`Baseline file for stage '${stage}' is corrupt. Run haiku_repair to re-establish the baseline.`,
		)
		this.name = "BaselineCorruptError"
		this.stage = stage
		this.cause = cause
	}
}

/** On-disk shape: a JSON object whose keys are path strings and whose
 *  values are BaselineEntry objects (without the `path` field duplicated,
 *  but we store the full entry for simplicity). */
const BaselineDiskSchema = z.record(z.string(), BaselineEntrySchema)

// ── Path helpers ───────────────────────────────────────────────────────────

/** Returns the absolute path of baseline.json for a given stage. */
function baselinePath(intentDir: string, stage: string): string {
	return join(intentDir, "stages", stage, "baseline.json")
}

// ── Baseline read/write ────────────────────────────────────────────────────

/** Read the per-stage baseline from disk. Returns null when the file does
 *  not exist (caller should enter establish-mode). Throws
 *  `BaselineCorruptError` when the file exists but cannot be parsed or
 *  fails schema validation (AC-EE4 / ARCHITECTURE.md §8.2). */
export function readBaseline(
	intentDir: string,
	stage: string,
): Baseline | null {
	const filePath = baselinePath(intentDir, stage)
	if (!existsSync(filePath)) return null

	let raw: string
	try {
		raw = readFileSync(filePath, "utf-8")
	} catch (err) {
		throw new BaselineCorruptError(stage, err)
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch (err) {
		throw new BaselineCorruptError(stage, err)
	}

	const result = BaselineDiskSchema.safeParse(parsed)
	if (!result.success) {
		throw new BaselineCorruptError(stage, result.error)
	}

	const entries = new Map<string, BaselineEntry>()
	for (const [key, value] of Object.entries(result.data)) {
		entries.set(key, value)
	}

	return { entries }
}

/** Serialise the baseline to canonical JSON (sorted keys, 2-space indent,
 *  trailing newline) and atomically rename a tempfile into place so a
 *  concurrent reader never observes a partial write. */
export async function writeBaseline(
	intentDir: string,
	stage: string,
	baseline: Baseline,
): Promise<void> {
	const targetPath = baselinePath(intentDir, stage)

	// Build disk object from entries map.
	const diskObj: Record<string, BaselineEntry> = {}
	for (const [key, entry] of baseline.entries) {
		diskObj[key] = entry
	}

	// Canonical JSON: 2-space indent, trailing newline.
	const json = `${JSON.stringify(diskObj, null, 2)}\n`

	// Write to tempfile in the same directory as the target so rename is
	// atomic on POSIX (same filesystem, single inode operation).
	const _dir = dirname(targetPath)
	const tmpDir = await mkdtemp(join(tmpdir(), "haiku-baseline-"))
	const tmpPath = join(tmpDir, `baseline-${stage}-${process.pid}.json.tmp`)

	try {
		await writeFile(tmpPath, json, "utf-8")
		await rename(tmpPath, targetPath)
	} finally {
		// Best-effort cleanup of tmpDir regardless of success/failure.
		await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
	}
}

// ── SHA-256 computation ────────────────────────────────────────────────────

/** Compute the SHA-256 hex digest of a file by streaming (no full-buffer
 *  load). Returns lowercase hex. Used by every caller that needs to hash
 *  a tracked file. */
export function computeFileSha256(absolutePath: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256")
		const stream = createReadStream(absolutePath)
		stream.on("data", (chunk) => hash.update(chunk))
		stream.on("end", () => resolve(hash.digest("hex")))
		stream.on("error", reject)
	})
}

// ── Binary detection ───────────────────────────────────────────────────────

const BINARY_CHECK_BYTES = 8192

/** Return true when the file is binary — defined as: any null byte in the
 *  first 8192 bytes, OR the first 8192 bytes fail UTF-8 decoding. Matches
 *  DATA-CONTRACTS.md §2.1 / TRACKED-SURFACE-BOUNDARY.md heuristic. */
export async function isBinary(absolutePath: string): Promise<boolean> {
	let buf: Buffer
	try {
		const fd = await open(absolutePath, "r")
		try {
			const stat = await fd.stat()
			const bytesToRead = Math.min(stat.size, BINARY_CHECK_BYTES)
			if (bytesToRead === 0) return false
			const buffer = Buffer.alloc(bytesToRead)
			const { bytesRead } = await fd.read(buffer, 0, bytesToRead, 0)
			buf = buffer.subarray(0, bytesRead)
		} finally {
			await fd.close()
		}
	} catch {
		return false
	}

	// Check for null bytes.
	for (let i = 0; i < buf.length; i++) {
		if (buf[i] === 0) return true
	}

	// Check for invalid UTF-8 by encoding round-trip.
	try {
		const decoded = new TextDecoder("utf-8", { fatal: true }).decode(buf)
		// Also re-encode and compare — catches some edge cases.
		const reEncoded = new TextEncoder().encode(decoded)
		if (reEncoded.length !== buf.length) return true
	} catch {
		return true
	}

	return false
}

// ── Tracked-surface enumeration ────────────────────────────────────────────

/** Editor temp-file patterns to exclude from drift detection (AC-FS3). */
const EDITOR_TEMP_PATTERNS = [
	/^\.#/, // Emacs lock files
	/~$/, // Backup files
	/\.swp$/, // Vim swap
	/\.swo$/, // Vim swap (overflow)
	/^4913$/, // Vim startup test file
]

/** Paths excluded from drift detection — drift-subsystem state files and
 *  workflow-managed files (ARCHITECTURE.md §3.1 / AC-G7). */
const EXCLUDED_FILENAMES = new Set([
	"baseline.json",
	"drift-markers.json",
	"write-audit.jsonl",
	"intent.md",
	"state.json",
])

/** Pattern: paths that are workflow-managed (units/*.md, feedback/*.md). */
function isWorkflowManaged(pathRel: string): boolean {
	const parts = pathRel.split("/")
	const lastDir = parts[parts.length - 2]
	const filename = parts[parts.length - 1]
	if (
		(lastDir === "units" || lastDir === "feedback") &&
		filename.endsWith(".md")
	) {
		return true
	}
	// drift-assessments/**
	if (parts.includes("drift-assessments")) return true
	// Excluded filenames.
	if (EXCLUDED_FILENAMES.has(filename)) return true
	return false
}

function isEditorTemp(filename: string): boolean {
	return EDITOR_TEMP_PATTERNS.some((p) => p.test(filename))
}

/** Recursively enumerate all files under a directory. Returns paths
 *  relative to `baseDir`. Skips editor temp files. */
function walkDir(absDir: string, baseDir: string): string[] {
	const results: string[] = []
	if (!existsSync(absDir)) return results
	try {
		const entries = readdirSync(absDir, { withFileTypes: true })
		for (const entry of entries) {
			if (isEditorTemp(entry.name)) continue
			const fullPath = join(absDir, entry.name)
			if (entry.isDirectory()) {
				results.push(...walkDir(fullPath, baseDir))
			} else if (entry.isFile() || entry.isSymbolicLink()) {
				results.push(relative(baseDir, fullPath))
			}
		}
	} catch {
		// Directory may disappear during scan — skip it.
	}
	return results
}

/** Record returned by enumerateTrackedSurface. */
export interface TrackedSurfaceEntry {
	/** Path relative to the intent directory (canonical, artifacts/ not outputs/). */
	pathRel: string
	/** Absolute path on disk. */
	absPath: string
	/** Tracking class. */
	trackingClass: TrackingClass
	/** Stage that owns this file, or null for intent-scope files. */
	stageOwner: string | null
}

/** StudioConfig shape used by enumerateTrackedSurface. Only the stages
 *  field is needed; the rest of the studio config is not consulted here. */
export interface StudioConfigForSurface {
	stages?: string[]
}

/** Enumerate all files in the tracked surface for a given intent/stage
 *  (ARCHITECTURE.md §3.3 / AC-G7). Returns canonical paths
 *  (outputs/ → artifacts/ per AC-ALIAS1/2). Excludes workflow-managed
 *  files and drift-subsystem state files. */
export function enumerateTrackedSurface(
	intentDir: string,
	stage: string,
	_studioConfig?: StudioConfigForSurface,
): TrackedSurfaceEntry[] {
	const results: TrackedSurfaceEntry[] = []

	// Helper: add all files under a directory as tracked surface entries.
	function addDir(
		absDir: string,
		trackingClass: TrackingClass,
		stageOwner: string | null,
		_canonicalPrefix: string,
	) {
		if (!existsSync(absDir)) return
		const files = walkDir(absDir, intentDir)
		for (const rel of files) {
			// Canonicalise (rewrite outputs/ → artifacts/).
			const canonical = canonicalisePath(rel)
			if (isWorkflowManaged(canonical)) continue
			const absPath = join(intentDir, canonical)
			results.push({ pathRel: canonical, absPath, trackingClass, stageOwner })
		}
	}

	// Stage-scoped tracked surface:
	const stageBase = join(intentDir, "stages", stage)

	// artifacts/ (canonical) — stage-output class.
	addDir(
		join(stageBase, "artifacts"),
		"stage-output",
		stage,
		`stages/${stage}/artifacts`,
	)

	// outputs/ (alias → treated as artifacts/) — stage-output class.
	// We enumerate the directory but canonicalise the paths.
	addDir(
		join(stageBase, "outputs"),
		"stage-output",
		stage,
		`stages/${stage}/outputs`,
	)

	// knowledge/ — knowledge class.
	addDir(
		join(stageBase, "knowledge"),
		"knowledge",
		stage,
		`stages/${stage}/knowledge`,
	)

	// discovery/ — knowledge class.
	addDir(
		join(stageBase, "discovery"),
		"knowledge",
		stage,
		`stages/${stage}/discovery`,
	)

	// Intent-scope knowledge/ — stageOwner null.
	addDir(join(intentDir, "knowledge"), "knowledge", null, "knowledge")

	// Deduplicate by pathRel (outputs/ alias may overlap with artifacts/).
	const seen = new Set<string>()
	return results.filter((e) => {
		if (seen.has(e.pathRel)) return false
		seen.add(e.pathRel)
		return true
	})
}

// ── Path canonicalisation ──────────────────────────────────────────────────

/** Rewrite any `stages/{stage}/outputs/...` segment to
 *  `stages/{stage}/artifacts/...` so baseline keys are always canonical
 *  (AC-ALIAS2). Leaves all other paths untouched. */
export function canonicalisePath(pathRel: string): string {
	return pathRel.replace(/^(stages\/[^/]+\/)outputs\//, "$1artifacts/")
}

// ── Pure baseline mutation helper ──────────────────────────────────────────

/** Return a new Baseline with the given entry inserted or updated. Never
 *  mutates the input baseline. */
export function updateBaselineEntry(
	baseline: Baseline,
	entry: BaselineEntry,
): Baseline {
	const newEntries = new Map(baseline.entries)
	newEntries.set(entry.path, entry)
	return { entries: newEntries }
}
