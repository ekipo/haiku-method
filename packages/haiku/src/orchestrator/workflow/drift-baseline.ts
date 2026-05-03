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

import { createHash, randomBytes } from "node:crypto"
import {
	closeSync,
	createReadStream,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs"
import { open, rename, unlink, writeFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import matter from "gray-matter"
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
 *  concurrent reader never observes a partial write.
 *
 *  Atomicity note: the tempfile is created in the SAME directory as the
 *  target file. This matters because POSIX `rename(2)` is only guaranteed
 *  atomic when source and destination are on the same filesystem. Using
 *  `os.tmpdir()` would put the tempfile on a potentially different
 *  filesystem (e.g. a tmpfs mount) and `rename` would fall back to
 *  copy-then-unlink, which is NOT atomic — a concurrent reader could
 *  observe the partial copy. */
export async function writeBaseline(
	intentDir: string,
	stage: string,
	baseline: Baseline,
): Promise<void> {
	const targetPath = baselinePath(intentDir, stage)
	const targetDir = dirname(targetPath)

	// Ensure the stage directory exists so writeFile/rename have a home.
	mkdirSync(targetDir, { recursive: true })

	// Build disk object with SORTED keys (canonical form). JSON.stringify
	// preserves insertion order, so we must sort the keys explicitly before
	// constructing the object.
	const sortedKeys = Array.from(baseline.entries.keys()).sort()
	const diskObj: Record<string, BaselineEntry> = {}
	for (const key of sortedKeys) {
		const entry = baseline.entries.get(key)
		if (entry !== undefined) diskObj[key] = entry
	}

	// Canonical JSON: 2-space indent, trailing newline.
	const json = `${JSON.stringify(diskObj, null, 2)}\n`

	// Tempfile in the target directory so rename is same-filesystem (atomic).
	// Use a random suffix to avoid collisions across concurrent writers.
	const tmpPath = join(
		targetDir,
		`.baseline-${process.pid}-${randomBytes(6).toString("hex")}.json.tmp`,
	)

	try {
		await writeFile(tmpPath, json, "utf-8")
		await rename(tmpPath, targetPath)
	} catch (err) {
		// Best-effort cleanup of the tempfile if the rename never landed.
		await unlink(tmpPath).catch(() => {})
		throw err
	}

	// Write content sidecars so diff generation can read "before" content
	// without relying on git (which uses SHA-1, not SHA-256).
	// Intent-scope entries (stage === null) get a sidecar at the intent level.
	for (const [, entry] of baseline.entries) {
		if (entry.is_binary) continue
		const isIntentScope = entry.stage === null
		const sidecarPath = isIntentScope
			? baselineIntentContentPath(intentDir, entry.sha256)
			: baselineContentPath(intentDir, stage, entry.sha256)
		if (existsSync(sidecarPath)) continue
		try {
			const filePath = join(intentDir, entry.path)
			if (!existsSync(filePath)) continue
			const buf = readFileSync(filePath)
			const computedSha = createHash("sha256").update(buf).digest("hex")
			if (computedSha !== entry.sha256) continue
			if (isIntentScope) {
				writeBaselineIntentContentSync(intentDir, entry.sha256, buf)
			} else {
				writeBaselineContentSync(intentDir, stage, entry.sha256, buf)
			}
		} catch {
			// Non-fatal: sidecar is best-effort.
		}
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
	// V-11 — operator-only baseline-corrupt acknowledgement marker.
	".baseline-ack",
	// V-11 — baseline-corruption thrash counter.
	"baseline-thrash.json",
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
	/** Path relative to the intent directory, in CANONICAL form
	 *  (`stages/{stage}/artifacts/...` even when the file lives under the
	 *  `outputs/` alias on disk). This is the baseline key. */
	pathRel: string
	/** Absolute path on disk — points to the ACTUAL file location on the
	 *  filesystem, which for the `outputs/` alias differs from `pathRel`.
	 *  Hashing/stat must use this path; baseline lookups use `pathRel`. */
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
	// `absPath` is anchored to the file's REAL location on disk (so it works
	// for the `outputs/` alias too); `pathRel` is the canonicalised baseline
	// key (`outputs/` → `artifacts/`).
	function addDir(
		absDir: string,
		trackingClass: TrackingClass,
		stageOwner: string | null,
	) {
		if (!existsSync(absDir)) return
		const files = walkDir(absDir, intentDir)
		for (const rel of files) {
			const canonical = canonicalisePath(rel)
			if (isWorkflowManaged(canonical)) continue
			// absPath uses the original (un-canonicalised) relative path so it
			// resolves to the actual file on disk, even for the outputs/ alias.
			const absPath = join(intentDir, rel)
			results.push({ pathRel: canonical, absPath, trackingClass, stageOwner })
		}
	}

	// Stage-scoped tracked surface:
	const stageBase = join(intentDir, "stages", stage)

	// artifacts/ (canonical) — stage-output class.
	addDir(join(stageBase, "artifacts"), "stage-output", stage)

	// outputs/ (alias → treated as artifacts/) — stage-output class.
	// We enumerate the directory but canonicalise the pathRel; absPath
	// stays anchored to the on-disk outputs/ location.
	addDir(join(stageBase, "outputs"), "stage-output", stage)

	// knowledge/ — knowledge class.
	addDir(join(stageBase, "knowledge"), "knowledge", stage)

	// discovery/ — knowledge class.
	addDir(join(stageBase, "discovery"), "knowledge", stage)

	// Intent-scope knowledge/ — stageOwner null.
	addDir(join(intentDir, "knowledge"), "knowledge", null)

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

// ── Sync helpers for use in synchronous gate context ──────────────────────

/** Chunk size for the streaming sync SHA-256 read. 64 KiB matches Node's
 *  default high-water mark for fs streams and keeps per-file memory
 *  bounded regardless of artifact size. */
const SHA256_SYNC_CHUNK_BYTES = 64 * 1024

/** Synchronous SHA-256 computation. Streams the file in fixed-size chunks
 *  (`SHA256_SYNC_CHUNK_BYTES`) via openSync/readSync so memory use stays
 *  bounded even on multi-MB artifacts (the drift-detection gate hashes
 *  every tracked file on every tick — image-heavy stages would otherwise
 *  load 50+ MB binaries fully into memory each pass). For async callers
 *  prefer the streaming `computeFileSha256`. */
export function computeFileSha256Sync(absolutePath: string): string {
	const hash = createHash("sha256")
	const buf = Buffer.allocUnsafe(SHA256_SYNC_CHUNK_BYTES)
	const fd = openSync(absolutePath, "r")
	try {
		while (true) {
			const bytesRead = readSync(fd, buf, 0, SHA256_SYNC_CHUNK_BYTES, null)
			if (bytesRead === 0) break
			hash.update(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead))
		}
	} finally {
		closeSync(fd)
	}
	return hash.digest("hex")
}

/** Synchronous binary-detection heuristic. Mirror of the async `isBinary`
 *  but uses sync I/O. Same algorithm: null byte in first 8192 bytes OR
 *  UTF-8 decode failure. */
export function isBinarySync(absolutePath: string): boolean {
	try {
		const st = statSync(absolutePath)
		const bytesToRead = Math.min(st.size, BINARY_CHECK_BYTES)
		if (bytesToRead === 0) return false

		const buf = Buffer.alloc(bytesToRead)
		const fd = openSync(absolutePath, "r")
		let bytesRead = 0
		try {
			bytesRead = readSync(fd, buf, 0, bytesToRead, 0)
		} finally {
			closeSync(fd)
		}
		const slice = buf.subarray(0, bytesRead)

		for (let i = 0; i < slice.length; i++) {
			if (slice[i] === 0) return true
		}
		try {
			new TextDecoder("utf-8", { fatal: true }).decode(slice)
		} catch {
			return true
		}
		return false
	} catch {
		return false
	}
}

/** Synchronous baseline write. Uses a direct `writeFileSync` rather than
 *  the atomic-rename pattern in `writeBaseline`. Acceptable for the
 *  establish-mode first write (no concurrent reader exists for a file that
 *  did not exist a moment ago). Callers in update-mode should prefer
 *  `writeBaseline` for atomicity. */
export function writeBaselineSync(
	intentDir: string,
	stage: string,
	baseline: Baseline,
): void {
	const targetPath = baselinePath(intentDir, stage)
	const targetDir = dirname(targetPath)
	mkdirSync(targetDir, { recursive: true })

	const sortedKeys = Array.from(baseline.entries.keys()).sort()
	const diskObj: Record<string, BaselineEntry> = {}
	for (const key of sortedKeys) {
		const entry = baseline.entries.get(key)
		if (entry !== undefined) diskObj[key] = entry
	}

	writeFileSync(targetPath, `${JSON.stringify(diskObj, null, 2)}\n`, "utf-8")

	// Write content sidecars so diff generation can read "before" content
	// without relying on git (which uses SHA-1, not SHA-256).
	// Intent-scope entries (stage === null) get a sidecar at the intent level.
	for (const [, entry] of baseline.entries) {
		if (entry.is_binary) continue
		const isIntentScope = entry.stage === null
		const sidecarPath = isIntentScope
			? baselineIntentContentPath(intentDir, entry.sha256)
			: baselineContentPath(intentDir, stage, entry.sha256)
		if (existsSync(sidecarPath)) continue
		try {
			const filePath = join(intentDir, entry.path)
			if (!existsSync(filePath)) continue
			const buf = readFileSync(filePath)
			const computedSha = createHash("sha256").update(buf).digest("hex")
			if (computedSha !== entry.sha256) continue
			if (isIntentScope) {
				writeBaselineIntentContentSync(intentDir, entry.sha256, buf)
			} else {
				writeBaselineContentSync(intentDir, stage, entry.sha256, buf)
			}
		} catch {
			// Non-fatal: sidecar is best-effort.
		}
	}
}

// ── Content sidecar helpers ────────────────────────────────────────────────

/** Returns the absolute path to the content-sidecar directory for a stage.
 *  Sidecars store the raw file content at baseline-write time, keyed by
 *  SHA-256, so that `buildUnifiedDiff` can retrieve "before" content without
 *  relying on git (which uses SHA-1 object addresses, not SHA-256). */
export function baselineContentDir(intentDir: string, stage: string): string {
	return join(intentDir, "stages", stage, "baseline-content")
}

/** Returns the absolute path for a specific sidecar file. */
export function baselineContentPath(
	intentDir: string,
	stage: string,
	sha256: string,
): string {
	return join(baselineContentDir(intentDir, stage), sha256)
}

// ── Intent-scope sidecar helpers ───────────────────────────────────────────

/** Returns the absolute path to the intent-level content-sidecar directory.
 *  Used for intent-scope knowledge/ entries whose `stageOwner` is null —
 *  those files are not owned by any stage, so the sidecar must live at the
 *  intent level to survive stage transitions. */
export function baselineIntentContentDir(intentDir: string): string {
	return join(intentDir, "baseline-content")
}

/** Returns the absolute path for a specific intent-level sidecar file. */
export function baselineIntentContentPath(
	intentDir: string,
	sha256: string,
): string {
	return join(baselineIntentContentDir(intentDir), sha256)
}

/** Write a content sidecar. Non-fatal on error. */
export function writeBaselineContentSync(
	intentDir: string,
	stage: string,
	sha256: string,
	content: Buffer,
): void {
	try {
		const dir = baselineContentDir(intentDir, stage)
		mkdirSync(dir, { recursive: true })
		writeFileSync(baselineContentPath(intentDir, stage, sha256), content)
	} catch {
		// Non-fatal.
	}
}

/** Write an intent-level content sidecar. Non-fatal on error. */
export function writeBaselineIntentContentSync(
	intentDir: string,
	sha256: string,
	content: Buffer,
): void {
	try {
		const dir = baselineIntentContentDir(intentDir)
		mkdirSync(dir, { recursive: true })
		writeFileSync(baselineIntentContentPath(intentDir, sha256), content)
	} catch {
		// Non-fatal.
	}
}

/** Read a content sidecar. Returns null when absent or unreadable. */
export function readBaselineContent(
	intentDir: string,
	stage: string,
	sha256: string,
): Buffer | null {
	try {
		return readFileSync(baselineContentPath(intentDir, stage, sha256))
	} catch {
		return null
	}
}

/** Read a content sidecar, checking the stage path first and falling back to
 *  the intent-level path. This enables legacy stage-stamped sidecars for
 *  knowledge/ files to still resolve after being moved to intent scope. */
export function readBaselineContentWithFallback(
	intentDir: string,
	stage: string,
	sha256: string,
): Buffer | null {
	// Try stage path first (stage-owned files, and legacy knowledge sidecars).
	const stageBuf = readBaselineContent(intentDir, stage, sha256)
	if (stageBuf !== null) return stageBuf
	// Fall back to intent-level path (intent-scope knowledge files).
	try {
		return readFileSync(baselineIntentContentPath(intentDir, sha256))
	} catch {
		return null
	}
}

// ── Tick-counter helper ────────────────────────────────────────────────────

/** Read the current tick counter (iteration) from the active stage's
 *  state.json. When `stage` is supplied, reads only that stage's state.json.
 *  When omitted, walks all stage directories and returns the first `iteration`
 *  found (for callers that don't know the active stage).
 *  Returns 0 when not determinable (safe default for entry-ID purposes). */
export function getCurrentTickCounter(
	intentDir: string,
	stage?: string,
): number {
	const stagesDir = join(intentDir, "stages")
	if (!existsSync(stagesDir)) return 0

	const tryRead = (stateFile: string): number | null => {
		if (!existsSync(stateFile)) return null
		try {
			const state = JSON.parse(readFileSync(stateFile, "utf-8")) as Record<
				string,
				unknown
			>
			const iter = state.iteration
			return typeof iter === "number" ? iter : null
		} catch {
			return null
		}
	}

	if (stage !== undefined) {
		return tryRead(join(stagesDir, stage, "state.json")) ?? 0
	}

	try {
		const stageDirs = readdirSync(stagesDir, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name)
		for (const s of stageDirs) {
			const v = tryRead(join(stagesDir, s, "state.json"))
			if (v !== null) return v
		}
	} catch {
		// ignore
	}
	return 0
}

// ── Kill-switch helper ─────────────────────────────────────────────────────

/** Return true when `drift_detection: false` is set in `.haiku/settings.yml`.
 *  Default is enabled (returns false). Never throws.
 *
 *  Extracted here so `drift-detection-gate.ts`, `haiku_human_write.ts`, and
 *  `haiku_baseline_init.ts` all share one implementation. */
export function isDriftDetectionDisabled(haikuRoot: string): boolean {
	const settingsPath = join(haikuRoot, "settings.yml")
	if (!existsSync(settingsPath)) return false
	try {
		const raw = readFileSync(settingsPath, "utf-8")
		const { data } = matter(`---\n${raw}\n---\n`)
		return (data as Record<string, unknown>).drift_detection === false
	} catch {
		return false
	}
}

/** Return all stage directory names present on disk for an intent.
 *  Returns an empty array when the stages/ directory doesn't exist.
 *
 *  Extracted here so `haiku_human_write.ts` and `haiku_baseline_init.ts`
 *  share one implementation alongside the other shared drift helpers. */
export function getIntentStages(intentDir: string): string[] {
	const stagesDir = join(intentDir, "stages")
	if (!existsSync(stagesDir)) return []
	try {
		return readdirSync(stagesDir, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name)
	} catch {
		return []
	}
}

/** Read the action log for a specific tick synchronously.
 *  Returns an empty array when the file doesn't exist.
 *  Silently skips malformed lines. */
export function readActionLogSync(
	intentDir: string,
	tickCounter: number,
): Array<{
	entry_type: string
	path: string
	sha: string
	author_class: string
	tick_counter: number
}> {
	const filePath = join(intentDir, "action-log.jsonl")
	if (!existsSync(filePath)) return []

	let raw: string
	try {
		raw = readFileSync(filePath, "utf-8")
	} catch {
		return []
	}

	const results: Array<{
		entry_type: string
		path: string
		sha: string
		author_class: string
		tick_counter: number
	}> = []
	for (const line of raw.split("\n")) {
		const trimmed = line.trim()
		if (!trimmed) continue
		try {
			const parsed = JSON.parse(trimmed) as {
				entry_type: string
				path: string
				sha: string
				author_class: string
				tick_counter: number
			}
			if (parsed.tick_counter === tickCounter) {
				results.push(parsed)
			}
		} catch {
			// Malformed line — skip.
		}
	}
	return results
}

// ── V-11: baseline-corrupt operator-only acknowledgement gate ───────────────
//
// Defends against the "attacker corrupts baseline.json → next tick
// silent-establishes attacker content" primitive.
//
// The threat: baseline.json is the trust anchor for drift detection. If
// an attacker can corrupt it AND influence what's on disk (e.g. via a
// V-04 chain or a co-resident process), the legacy behaviour
// (`baseline === null` → silent establish from disk) launders attacker
// content into the trusted baseline with zero operator visibility.
//
// The defence has four layers:
//
//  1. The drift-detection gate REFUSES to silent-establish when the
//     stage's state.json already records `drift_baseline_established_at`
//     (i.e. we've established before — this isn't a first-tick case).
//     Returns the existing `baseline_corrupt` error envelope, but no
//     amount of `haiku_run_next` ticks can clear it.
//
//  2. `reconstructPriorBaseline(intentDir, stage)` rebuilds the
//     last-known-good baseline from `baseline-content/` (the durable
//     per-file content snapshots, sha256-validated) plus
//     `action-log.jsonl` (the chronological event stream).
//
//  3. The operator-only acknowledgement marker lives at
//     `stages/{stage}/.baseline-ack` (intentionally a hidden filename,
//     and intentionally OUTSIDE every `haiku_human_write` allow-list
//     so the agent has no MCP-tool path to write it). It contains a
//     JSON envelope with `diff_hash` (sha256 of the reconstructed-vs-
//     on-disk diff) and `created_at`. The gate accepts a reset only
//     when this file is present AND its diff_hash matches what the
//     operator confirmed.
//
//  4. `recordBaselineCorruption()` + `isBaselineThrashing()` track the
//     count of corruption events in a rolling 10-tick window in
//     `stages/{stage}/baseline-thrash.json`. When > 3 events fire, the
//     gate emits `haiku.security.baseline_thrash` telemetry AND
//     refuses auto-recovery even with a valid ack marker — the
//     operator must use a follow-up override (CLI flag) to break out.
//
// All four layers are file-based and synchronous so the gate stays
// synchronous and the trail is on-disk-auditable.

/** Path to the per-stage baseline-ack marker. Hidden filename + outside
 *  the allow-list so no MCP tool can write it; only an operator with
 *  shell access (or `haiku_repair` running with explicit confirmation
 *  flags) can place it. */
export function baselineAckMarkerPath(
	intentDir: string,
	stage: string,
): string {
	return join(intentDir, "stages", stage, ".baseline-ack")
}

/** The on-disk shape of the ack marker. */
export interface BaselineAckMarker {
	/** sha256 of the reconstructed-vs-on-disk diff that the operator
	 *  confirmed via /haiku:repair --confirm-baseline-reset. */
	diff_hash: string
	/** ISO-8601 timestamp when the operator created this marker. */
	created_at: string
	/** Optional free-text rationale the operator typed. */
	rationale?: string
}

/** Read the ack marker. Returns null when absent or unparseable
 *  (treated identically — the gate refuses to silent-establish either
 *  way; missing file is the common case). */
export function readBaselineAckMarker(
	intentDir: string,
	stage: string,
): BaselineAckMarker | null {
	const markerPath = baselineAckMarkerPath(intentDir, stage)
	if (!existsSync(markerPath)) return null
	try {
		const raw = readFileSync(markerPath, "utf-8")
		const parsed = JSON.parse(raw) as Record<string, unknown>
		const diff = parsed.diff_hash
		const ts = parsed.created_at
		if (typeof diff !== "string" || diff.length !== 64) return null
		if (typeof ts !== "string" || ts.length === 0) return null
		const out: BaselineAckMarker = { diff_hash: diff, created_at: ts }
		if (typeof parsed.rationale === "string") out.rationale = parsed.rationale
		return out
	} catch {
		return null
	}
}

/** Write the ack marker. Operator-only — caller MUST be `haiku_repair`
 *  with explicit `confirm_baseline_reset` + `confirm_diff_hash` args
 *  (validated at the MCP-tool layer, NOT here). This function is
 *  intentionally not exposed to the agent through any MCP tool —
 *  agents have no path to call it. The function is exported only so
 *  the repair tool's TypeScript handler can call it from the same
 *  process. */
export function writeBaselineAckMarker(
	intentDir: string,
	stage: string,
	marker: BaselineAckMarker,
): void {
	const markerPath = baselineAckMarkerPath(intentDir, stage)
	mkdirSync(dirname(markerPath), { recursive: true })
	writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, "utf-8")
}

/** Clear the ack marker after a successful reset — single-use semantics
 *  prevent the marker from authorising a future silent re-establish. */
export function clearBaselineAckMarker(
	intentDir: string,
	stage: string,
): void {
	const markerPath = baselineAckMarkerPath(intentDir, stage)
	if (existsSync(markerPath)) {
		try {
			unlinkSync(markerPath)
		} catch {
			// Non-fatal — best-effort cleanup. The next reset attempt
			// will re-validate the (still-present) marker against the
			// new diff and reject the mismatch.
		}
	}
}

/** Path to the per-stage baseline-corruption thrash counter. */
function baselineThrashPath(intentDir: string, stage: string): string {
	return join(intentDir, "stages", stage, "baseline-thrash.json")
}

/** The on-disk shape of the thrash counter. A list of recent
 *  corruption-event timestamps + tick counters; the gate trims it to
 *  the last 10 ticks before evaluating. */
interface BaselineThrashRecord {
	events: Array<{ at: string; tick_counter: number }>
}

const BASELINE_THRASH_WINDOW_TICKS = 10
const BASELINE_THRASH_THRESHOLD = 3

function readThrashRecord(
	intentDir: string,
	stage: string,
): BaselineThrashRecord {
	const p = baselineThrashPath(intentDir, stage)
	if (!existsSync(p)) return { events: [] }
	try {
		const raw = readFileSync(p, "utf-8")
		const parsed = JSON.parse(raw) as { events?: unknown }
		if (!Array.isArray(parsed.events)) return { events: [] }
		const events: Array<{ at: string; tick_counter: number }> = []
		for (const e of parsed.events) {
			if (
				typeof e === "object" &&
				e !== null &&
				typeof (e as { at?: unknown }).at === "string" &&
				typeof (e as { tick_counter?: unknown }).tick_counter === "number"
			) {
				events.push({
					at: (e as { at: string }).at,
					tick_counter: (e as { tick_counter: number }).tick_counter,
				})
			}
		}
		return { events }
	} catch {
		return { events: [] }
	}
}

function writeThrashRecord(
	intentDir: string,
	stage: string,
	record: BaselineThrashRecord,
): void {
	const p = baselineThrashPath(intentDir, stage)
	mkdirSync(dirname(p), { recursive: true })
	writeFileSync(p, `${JSON.stringify(record, null, 2)}\n`, "utf-8")
}

/** Record a baseline-corruption event for the thrash counter. Returns
 *  the trimmed event count (events within the last
 *  BASELINE_THRASH_WINDOW_TICKS ticks). The caller decides what to do
 *  with the count — typically: emit telemetry if > threshold, refuse
 *  auto-recovery if so. */
export function recordBaselineCorruption(
	intentDir: string,
	stage: string,
	tickCounter: number,
): number {
	const record = readThrashRecord(intentDir, stage)
	const minTick = tickCounter - BASELINE_THRASH_WINDOW_TICKS
	const trimmed = record.events.filter((e) => e.tick_counter >= minTick)
	trimmed.push({ at: new Date().toISOString(), tick_counter: tickCounter })
	writeThrashRecord(intentDir, stage, { events: trimmed })
	return trimmed.length
}

/** Returns true when the stage has experienced > BASELINE_THRASH_THRESHOLD
 *  corruption events within the last BASELINE_THRASH_WINDOW_TICKS ticks.
 *  Read-only — does NOT record a new event. Used by the gate to decide
 *  whether to even consider an ack marker as authorising recovery
 *  (under thrash conditions, the operator MUST escalate via an
 *  explicit `--override-thrash-circuit-breaker` flag, NOT just
 *  re-confirm a diff hash). */
export function isBaselineThrashing(
	intentDir: string,
	stage: string,
	tickCounter: number,
): { thrashing: boolean; recentCount: number } {
	const record = readThrashRecord(intentDir, stage)
	const minTick = tickCounter - BASELINE_THRASH_WINDOW_TICKS
	const recent = record.events.filter((e) => e.tick_counter >= minTick)
	return {
		thrashing: recent.length > BASELINE_THRASH_THRESHOLD,
		recentCount: recent.length,
	}
}

/** Reconstruct the last-known-good baseline by replaying the durable
 *  per-file content snapshots in `baseline-content/` (sha256-validated)
 *  and the action-log entries in `action-log.jsonl`. Returns null when
 *  reconstruction fails (no usable sidecars, no action log, every
 *  reconstruction candidate fails sha256 validation).
 *
 *  This is the input to the operator-confirmation diff: the operator
 *  sees the difference between this reconstructed baseline and what's
 *  currently on disk, and confirms (or rejects) the reset.
 *
 *  Reconstruction strategy:
 *   1. Walk every entry in `baseline-content/` (and intent-level
 *      `baseline-content/` for intent-scope knowledge files).
 *   2. For each sidecar, compute the sha256 of the file content. If
 *      it matches the filename (the filename IS the sha256 of the
 *      content at write-time), the sidecar is verifiably untampered.
 *   3. Walk `action-log.jsonl` for entries that reference each
 *      validated sidecar. Take the latest entry per path; that gives
 *      us the path → sha256 mapping for the last-known baseline.
 *   4. Construct a Baseline object whose entries reflect the last
 *      validated sha256 for each path. */
export function reconstructPriorBaseline(
	intentDir: string,
	stage: string,
): Baseline | null {
	const sidecarDir = baselineContentDir(intentDir, stage)
	const intentSidecarDir = baselineIntentContentDir(intentDir)

	// 1. Validate every sidecar by recomputing its sha256.
	const validatedShas = new Set<string>()
	const candidates: Array<{ dir: string; isIntentScope: boolean }> = []
	if (existsSync(sidecarDir)) {
		candidates.push({ dir: sidecarDir, isIntentScope: false })
	}
	if (existsSync(intentSidecarDir)) {
		candidates.push({ dir: intentSidecarDir, isIntentScope: true })
	}
	for (const c of candidates) {
		let names: string[]
		try {
			names = readdirSync(c.dir)
		} catch {
			continue
		}
		for (const name of names) {
			if (!/^[0-9a-f]{64}$/.test(name)) continue
			const full = join(c.dir, name)
			try {
				const buf = readFileSync(full)
				const actual = createHash("sha256").update(buf).digest("hex")
				if (actual === name) validatedShas.add(name)
			} catch {
				// Skip unreadable.
			}
		}
	}

	if (validatedShas.size === 0) return null

	// 2. Walk action-log.jsonl for the latest validated entry per path.
	const logPath = join(intentDir, "action-log.jsonl")
	if (!existsSync(logPath)) return null
	let logRaw: string
	try {
		logRaw = readFileSync(logPath, "utf-8")
	} catch {
		return null
	}

	interface LogEntry {
		path: string
		sha: string
		author_class?: string
		timestamp?: string
		entry_type?: string
	}
	const latestPerPath = new Map<string, LogEntry>()
	for (const line of logRaw.split("\n")) {
		const trimmed = line.trim()
		if (!trimmed) continue
		try {
			const parsed = JSON.parse(trimmed) as Record<string, unknown>
			const p = parsed.path
			const sha = parsed.sha
			if (typeof p !== "string" || typeof sha !== "string") continue
			if (!validatedShas.has(sha)) continue
			latestPerPath.set(p, {
				path: p,
				sha,
				author_class:
					typeof parsed.author_class === "string"
						? (parsed.author_class as string)
						: undefined,
				timestamp:
					typeof parsed.timestamp === "string"
						? (parsed.timestamp as string)
						: undefined,
				entry_type:
					typeof parsed.entry_type === "string"
						? (parsed.entry_type as string)
						: undefined,
			})
		} catch {
			// Malformed line — skip.
		}
	}

	if (latestPerPath.size === 0) return null

	// 3. Build the Baseline from the validated entries. We don't have
	//    the original mtime_ns / bytes / is_binary here; we use the
	//    sidecar file's stats as the most accurate surrogate. The
	//    reconstructed baseline is for OPERATOR DIFF DISPLAY purposes
	//    primarily — it must not be silently committed back to
	//    baseline.json without operator confirmation (that's the V-11
	//    primitive we're defending against).
	const entries = new Map<string, BaselineEntry>()
	for (const [pathRel, log] of latestPerPath) {
		// Locate the sidecar to read stats.
		const stagePath = baselineContentPath(intentDir, stage, log.sha)
		const intentPath = baselineIntentContentPath(intentDir, log.sha)
		const sidecarFull = existsSync(stagePath)
			? stagePath
			: existsSync(intentPath)
				? intentPath
				: null
		let bytes = 0
		let mtimeNs = 0
		if (sidecarFull) {
			try {
				const st = statSync(sidecarFull)
				bytes = st.size
				mtimeNs = Math.round(st.mtimeMs * 1_000_000)
			} catch {
				// Use defaults.
			}
		}
		entries.set(pathRel, {
			path: pathRel,
			sha256: log.sha,
			bytes,
			mtime_ns: mtimeNs,
			is_binary: false, // unknown; conservative default
			author_class:
				log.author_class === "agent" ||
				log.author_class === "human-via-mcp" ||
				log.author_class === "human-implicit"
					? log.author_class
					: "agent",
			acknowledged_at: log.timestamp ?? new Date().toISOString(),
			acknowledged_via: "baseline-init",
			stage: stage || null,
			tracking_class: "stage-output", // unknown; conservative
		})
	}

	return { entries }
}

/** Return true when the stage's state.json indicates the baseline was
 *  previously established (the `drift_baseline_established_at` field
 *  is present and non-empty). Used by the gate to distinguish
 *  legitimate first-tick establish (allowed) from suspicious
 *  re-establish-after-corruption (BLOCKED unless ack marker present). */
export function wasBaselinePreviouslyEstablished(
	intentDir: string,
	stage: string,
): boolean {
	const stateFile = join(intentDir, "stages", stage, "state.json")
	if (!existsSync(stateFile)) return false
	try {
		const raw = readFileSync(stateFile, "utf-8")
		const parsed = JSON.parse(raw) as Record<string, unknown>
		const stamp = parsed.drift_baseline_established_at
		return typeof stamp === "string" && stamp.length > 0
	} catch {
		return false
	}
}
