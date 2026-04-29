# Acceptance Criteria — Out-of-band Human File Modifications

> **Scope axis:** acceptance-criteria — what "done" looks like from the user's perspective.
> Sibling artifacts in this stage cover behavioral spec, data contracts, and coverage mapping; their substance is not duplicated here.
> Implementation details (tool signatures, baseline storage format, gate ordering) are specified in the design-stage artifacts (`ARCHITECTURE.md`, `MCP-TOOL-CONTRACT.md`, `TRACKED-SURFACE-BOUNDARY.md`, `ROLLOUT-AND-BASELINE-ESTABLISHMENT.md`) and referenced here for traceability.
>
> **Design decision traceability:** Entries that address a recorded design decision cite it as **[DEC-N]** (referencing `knowledge/DESIGN-DECISIONS.md`).
> **Directory convention:** `artifacts/` is the canonical name for a stage's output directory per `TRACKED-SURFACE-BOUNDARY.md §2`. References to `outputs/` in earlier drafts map to `artifacts/`; this document uses `artifacts/` exclusively.

---

## Variability Brief

The behavior of out-of-band detection and reaction varies along the following dimensions. Each is enumerated here so the General Rules and variant-specific subsections below can be grounded.

1. **Write-path origin** **[DEC-1, DEC-6, DEC-7]** — Three sanctioned origins produce the same downstream detection signal but differ at the entry point. All three flow through the unified per-tick SHA baseline gate — the gate cannot distinguish origins; origin is recorded separately via the action log. **[DEC-1]**
   - `spa-upload` — file authored via the browse/review SPA upload affordance. The SPA writes to disk and stamps the action log with `human-via-mcp`; the next tick's gate emits the drift event. **[DEC-7]**
   - `filesystem-drop` — file written directly into the worktree (designer's local tool, IDE save, drag-and-drop, `cp`, etc.) with no SPA involvement. Detected purely by SHA divergence; inferred class `human-implicit`. **[DEC-1]**
   - `agent-on-behalf` — agent writes via the sanctioned `haiku_human_write` MCP tool in response to a user instruction in chat ("hey claude write this file"). Stamps action log with `human-via-mcp`; does NOT update `baseline.json` directly; next tick classifies. **[DEC-7, DEC-9]** Trust + audit stance resolved by design: no confirmation round-trip required; audit log appended to `write-audit.jsonl`.

2. **Tracked-surface class** **[DEC-1, DEC-2]** — Per `TRACKED-SURFACE-BOUNDARY.md §1`, the tracked surface covers:
   - `stage-output` — `stages/{stage}/artifacts/**` (canonical name). Deliverable files produced by a stage hat (layouts, generated HTML, screenshots, figma exports). Note: `outputs/` is a legacy alias; the canonical directory name is `artifacts/`. **[DEC-2]**
   - `knowledge-input` — `stages/{stage}/knowledge/**` and `knowledge/**` (intent-level). Reference / context files (research notes, design tokens, market data). **[DEC-1]**
   - `stage-discovery` — `stages/{stage}/discovery/**`. Fan-out subagent research artifacts.
   - `unit-output` — files inside `stages/{stage}/units/` are **out of scope for v1** — these are workflow-managed files guarded by the existing PreToolUse hook. **[DEC-2]** See `TRACKED-SURFACE-BOUNDARY.md §3.1`.
   - Files outside `.haiku/intents/{slug}/` are explicitly excluded. **[DEC-2]**

3. **File payload type** — Diff payload available to the agent at classification time. Binary detection uses extension list from `TRACKED-SURFACE-BOUNDARY.md §5.2` plus null-byte heuristic.
   - `text` — full unified diff (3 lines of context, capped at 200 lines per `ARCHITECTURE.md §3.6`) is meaningful and shown.
   - `binary` — only file-changed signal + SHA delta + mime hint; no textual diff. Applies to: `.png`, `.jpg`, `.figma`, `.pdf`, `.pen`, `.sketch`, and extensions listed in `TRACKED-SURFACE-BOUNDARY.md §5.2`.

4. **Stage-of-ownership vs. active stage** **[DEC-5]** — The drifted file may be owned by:
   - `current` — the stage currently active on this intent.
   - `earlier` — a stage upstream of the active stage (already-passed gate).
   The harness does **not** automatically trigger revisit on cross-stage drift — the agent's classification step owns this decision. **[DEC-5]**

5. **Operating mode** — At drift-detection time the intent is in one of:
   - `interactive` (HITL) — agent is in conversation with a human.
   - `pickup` (OHOTL) — `/haiku:pickup` resumed; one human is on call but not actively chatting.
   - `autopilot` (AHOTL) — `/haiku:autopilot` is driving without human-in-loop.
   Mode does not change the detection path or classification behavior. v1 default is **silent classification** across all three modes, surfaced via the SPA's drift assessment view and the chat surface on the next interactive turn. **[DEC-3]**

6. **First-tick-after-upgrade vs. steady-state** **[DEC-1]** — On the first tick after the feature ships for any existing intent, `drift_baseline_established_at` is absent from `state.json`; the gate runs in establish mode (record SHAs, emit nothing). The `drift_detection: false` kill-switch is the operator's escape hatch if the gate misbehaves. **`ROLLOUT-AND-BASELINE-ESTABLISHMENT.md §2, §8`**

7. **Classification outcome** **[DEC-3]** — One of four, agent-owned, not harness-enforced:
   - `ignore` — change observed, no further action; baseline updates immediately to observed SHA.
   - `inline-fix` — agent absorbs the change into the current bolt; baseline updates immediately.
   - `surface-as-feedback` — open feedback item created via `haiku_feedback`; baseline holds; pending-assessment marker at `drift-markers.json` recorded; updates when feedback closes. **`ARCHITECTURE.md §5`**
   - `trigger-revisit` — earlier stage revisited via `haiku_revisit`; baseline holds; pending-assessment marker recorded; updates when revisit completes. **`ARCHITECTURE.md §5`**

---

## User Stories

### US-01: Designer Replaces a Stage Output File

**As** a designer collaborating on an active intent,
**I want to** replace a stage output file (layout HTML, figma export, screenshot) by saving over it in the worktree,
**so that** my updated design lands in the lifecycle without me having to invoke MCP tools or fight the framework.

**Priority:** P0

### US-02: Product Owner Edits a Deliverable and Asks the Agent to Extend

**As** a product owner reviewing a deliverable mid-flight,
**I want to** make a small edit to a file the agent produced and then ask the agent in chat to "extend this,"
**so that** the agent treats my edit as the new baseline and builds on it instead of regenerating from its prior state.

**Priority:** P0

### US-03: User Drops Knowledge Into the Elaborate Phase

**As** a user with reference material relevant to inception/elaboration,
**I want to** drop a knowledge file (research notes, design tokens, market data) into the intent's knowledge directory or upload it via the SPA,
**so that** the agent picks it up on the next workflow tick and integrates it into the elaboration phase without me having to paste it into chat.

**Priority:** P0

### US-04: User Asks the Agent to Write a Knowledge File on Their Behalf

**As** a user in conversation with the agent,
**I want to** say "hey claude, save this Tailwind config to the design references" and have the resulting file land as a human-attributed write,
**so that** the file is tracked as out-of-band human content (subject to drift detection on subsequent ticks) rather than as an agent-generated artifact.

**Priority:** P0

### US-05: User Reviews a Drift Assessment Decision in the SPA

**As** a user (designer, PO, or anyone reviewing the intent),
**I want to** see what files changed out-of-band, what the agent classified each change as, and the rationale,
**so that** I can verify the agent's response to my edits and understand how my change was handled.

**Priority:** P0

### US-06: User Catches a Misclassification and Overrides

**As** a user reviewing a drift assessment in the SPA,
**I want to** override the agent's classification (e.g., elevate an "ignore" to "trigger-revisit", or downgrade a "trigger-revisit" to "inline-fix") with a reason,
**so that** misclassifications don't silently waste a stage or silently drop my intent.

**Priority:** P1

### US-07: User Drops a Binary Stage Output (Image, Figma Export)

**As** a designer replacing a screenshot or exporting a new figma asset over the prior version,
**I want to** the system to treat the file as changed (even though no textual diff is available) and let the agent acknowledge the change without ceremony,
**so that** binary handoffs are not blocked by "I can't read this diff" failures.

**Priority:** P0

### US-08: User Operates an Existing Intent After Feature Upgrade

**As** a user with an active intent that pre-dates this feature shipping,
**I want to** the first tick after upgrade to silently establish baselines without firing a flood of `manual_change_assessment` actions for files that have drifted for unrelated reasons (cleanup, rebases, prior manual edits),
**so that** the upgrade is non-disruptive.

**Priority:** P0

### US-09: User Watches a Cross-Stage Drift Get Surfaced as Feedback or Revisit

**As** a user editing a file owned by an earlier stage (e.g., touching a product-stage spec while the intent is mid-development),
**I want to** the agent to classify the drift and route it appropriately (small typo → ignore or inline-fix; semantic redirect → trigger-revisit; ambiguous → surface-as-feedback),
**so that** earlier-stage edits don't silently corrupt downstream work and don't gratuitously restart the intent for cosmetic changes.

**Priority:** P0

### US-10: User Uses the SPA Upload Affordance Per Stage

**As** a user wanting an explicit upload UI rather than a filesystem drop,
**I want to** upload files through the SPA at the appropriate per-stage target (knowledge for elaborate-class stages, outputs for output-producing stages),
**so that** I have a sanctioned, discoverable path that doesn't require me to know the worktree layout.

**Priority:** P1 (filesystem drop covers the base case; SPA upload is a UX upgrade)

### US-11: User Resolves a Pending Drift Assessment by Closing the Underlying Feedback

**As** a user (or agent) closing a feedback item that was opened by `surface-as-feedback`,
**I want to** the pending-assessment marker to clear and the baseline to update to the file's then-current state,
**so that** the same drift doesn't re-fire on the next tick.

**Priority:** P0

### US-12: User Edits a File While the Agent Is Mid-Bolt

**As** a user who realizes mid-bolt they need to tweak a file,
**I want to** edit the file even though the agent is still running, and have the agent see my edit on the next tick (not blocked, not lost),
**so that** I'm never locked out of my own work product.

**Priority:** P0

---

## Acceptance Criteria

### General Rules

#### AC-G1: Drift detection runs on every workflow tick **[DEC-1]**

- **Given** an active intent with at least one tracked file and `drift_detection` plugin setting is `true` (default)
- **When** `haiku_run_next` is called
- **Then** before any per-state dispatch, a drift-detection gate walks the tracked surface (per `TRACKED-SURFACE-BOUNDARY.md §1`) and compares each file's current SHA-256 against its recorded baseline SHA from `stages/{stage}/baseline.json`
- **And** any file whose current SHA does not match its baseline is recorded as a drift event for this tick
- **And** the gate position in the pre-tick chain is: `tamper-detection → feedback-triage → drift-detection → per-state dispatch` (per `ARCHITECTURE.md §3.1`)
- **Defers to:** `BEHAVIORAL-SPEC` for the exact gate ordering semantics; `DATA-CONTRACTS` for the `baseline.json` schema.

#### AC-G2: Drift events emit a single workflow action per tick **[DEC-3]**

- **Given** one or more drift events recorded on a tick
- **When** the drift-detection gate completes
- **Then** the workflow emits a single `manual_change_assessment` action carrying the full set of drift events for that tick
- **And** the action payload includes, per event: `finding_id` (format: `DRF-NN`), file path, owning stage, `event_type` (`modified`/`added`/`deleted`), `author_class`, `is_binary`, unified diff (if text, capped at 200 lines) or `null` (if binary), prior `baseline_sha`, current `current_sha`
- **And** no `manual_change_assessment` action is emitted on a tick with zero drift events
- **Defers to:** `BEHAVIORAL-SPEC` for the wire-level payload shape; `ARCHITECTURE.md §4.2` is the authoritative payload contract.

#### AC-G3: Classification is agent-driven, not harness-driven **[DEC-3]**

- **Given** a `manual_change_assessment` action has been emitted
- **When** the agent processes the action
- **Then** the agent classifies each drift event into exactly one of four outcomes: `ignore`, `inline-fix`, `surface-as-feedback`, `trigger-revisit`
- **And** the harness does not pre-classify based on heuristics (file extension, size delta, file class, payload type)
- **And** the agent's classification rationale (1-3 sentences, human-readable) is recorded alongside each outcome in the durable assessment record at `stages/{stage}/drift-assessments/DA-{NN}.json`
- **And** the agent's default for ambiguous or binary diffs is `surface-as-feedback` (see AC-B2, AC-G13)

#### AC-G4: Baseline-update contract by outcome **[DEC-3, DEC-4]**

- **Given** an agent classification of a drift event
- **When** the classification is `ignore`
- **Then** the baseline SHA for that file updates immediately to the observed SHA in `stages/{stage}/baseline.json`
- **And** no further action is recorded; the assessment record is the only durable artifact
- **When** the classification is `inline-fix`
- **Then** the baseline SHA for that file updates immediately to the observed SHA
- **And** the agent treats the human's edit as the new ground truth for the current bolt (re-reads before proceeding)
- **When** the classification is `surface-as-feedback`
- **Then** a feedback item is created via `haiku_feedback` with `origin: "manual-change-assessment"` on the owning stage
- **And** a pending-assessment marker is recorded at `drift-markers.json` for this file, linking it to the feedback item
- **And** the baseline SHA is NOT updated at classification time
- **And** the drift-detection gate skips this file on subsequent ticks while the marker is open
- **When** the classification is `trigger-revisit`
- **Then** a revisit is dispatched via `haiku_revisit` targeting the stage that owns the drifted file
- **And** a pending-assessment marker is recorded at `drift-markers.json` for this file, linking it to the revisit stage
- **And** the baseline SHA is NOT updated at classification time
- **And** the drift-detection gate skips this file on subsequent ticks while the marker is open
- **Defers to:** `DATA-CONTRACTS` for the `baseline.json` and `drift-markers.json` schema; `ARCHITECTURE.md §5.4` is the authoritative contract table.

#### AC-G5: Pending-assessment marker lifecycle **[DEC-3]**

- **Given** a pending-assessment marker is open for a file at `drift-markers.json` (from `surface-as-feedback` or `trigger-revisit`)
- **When** the underlying feedback item closes (status becomes `addressed`, `closed`, or `rejected`)
- **Then** the marker is cleared from `drift-markers.json`
- **And** the baseline SHA in `stages/{stage}/baseline.json` updates to the file's SHA at marker-clearing time
- **When** the underlying revisit completes (the targeted stage re-passes its gate)
- **Then** the marker is cleared
- **And** the baseline SHA updates to the file's SHA at marker-clearing time
- **And** the next tick observes no drift on this file (assuming no further edit since marker-clearing)
- **Defers to:** `DATA-CONTRACTS` for the `drift-markers.json` schema; `ARCHITECTURE.md §5.3` for the full marker lifecycle contract.

#### AC-G6: Existing PreToolUse hook on workflow-managed files is unchanged **[DEC-2]**

- **Given** an agent attempts to write directly to a workflow-managed file (`stages/*/units/*.md`, `stages/*/feedback/*.md`, `intent.md`, `stages/*/state.json`) via `Write` or `Edit`
- **When** the PreToolUse hook fires
- **Then** the write is blocked with the existing redirect message naming the correct MCP tool
- **And** this behavior is identical before and after this feature ships; the guardrail is the boundary for agent writes only — humans may still write these files via the filesystem (out of scope per DEC-2)

#### AC-G7: Workflow-managed files are not in the tracked surface **[DEC-2]**

- **Given** the drift-detection gate walks the tracked surface
- **When** it encounters a workflow-managed file (`stages/*/units/*.md`, `stages/*/feedback/*.md`, `intent.md`, `stages/*/state.json`, `drift-markers.json`, `write-audit.jsonl`, `stages/*/baseline.json`)
- **Then** the file is excluded from baselining and from drift detection
- **And** no drift event is emitted for these files regardless of their on-disk state
- **Note:** Workflow-managed files are covered by the existing tamper-detection gate, which provides separate integrity guarantees. Adding drift detection would create conflicting ownership. `TRACKED-SURFACE-BOUNDARY.md §3.1, §3.2` details all excluded paths.

#### AC-G8: First-tick-after-upgrade silently establishes baselines **[DEC-1]**

- **Given** an intent stage where `drift_baseline_established_at` is absent or `null` in `stages/{stage}/state.json`
- **When** the next `haiku_run_next` tick runs
- **Then** the gate enumerates all tracked files, records their SHA-256 as the baseline with `author_class: "agent"` (conservative default), and writes `stages/{stage}/baseline.json`
- **And** the gate writes `drift_baseline_established_at` (ISO 8601 timestamp) to `stages/{stage}/state.json`
- **And** zero `manual_change_assessment` actions are emitted on this establishment tick, regardless of on-disk state
- **And** all subsequent ticks with `drift_baseline_established_at` present run in normal detection mode
- **Defers to:** `ROLLOUT-AND-BASELINE-ESTABLISHMENT.md §2–3` for the full establishment contract; `DATA-CONTRACTS` for the `state.json` field schema.

#### AC-G9: Concurrency model — eventual consistency, no locking **[DEC-4]**

- **Given** the agent is mid-bolt
- **When** a human writes to a tracked file (filesystem, SPA, or via the `haiku_human_write` MCP tool)
- **Then** the write is not blocked and does not interrupt the agent's current bolt
- **And** the next `haiku_run_next` tick observes the drift via the gate
- **And** the agent's mid-bolt result may be partially based on the pre-edit version of the file; this is explicitly accepted behavior, not a bug
- **Note:** No locking, no optimistic concurrency tokens, no real-time notification. The tick is the reconciliation unit. `ARCHITECTURE.md §7` specifies the full concurrency contract.

#### AC-G10: All three write-path origins produce the same downstream detection signal **[DEC-1, DEC-7]**

- **Given** a file is written via `spa-upload`, `filesystem-drop`, or `agent-on-behalf` (`haiku_human_write`)
- **When** the next workflow tick runs
- **Then** the drift-detection gate observes the SHA mismatch identically in all three cases
- **And** the resulting `manual_change_assessment` action payload structure is identical regardless of origin
- **And** the `author_class` field distinguishes: `human-via-mcp` (for SPA upload and `haiku_human_write`, both of which stamp the action log at write time) vs. `human-implicit` (for filesystem drops, inferred from absent action-log entry)
- **Note:** The three paths were unified through the design decision to require all detection to go through the per-tick SHA gate. `ARCHITECTURE.md §10, DEC-1` records this explicitly.

#### AC-G11: Drift assessment record is durable and human-readable **[DEC-3]**

- **Given** an agent classifies a drift event
- **When** the classification is recorded
- **Then** an assessment record is written to `stages/{stage}/drift-assessments/DA-{NN}.json` (append-only, one file per assessment dispatch)
- **And** the record contains: tick counter, timestamp, full findings list with diff payloads, classification per finding, rationale strings, `stage_owner` for cross-stage findings
- **And** the record survives branch switches, worktree operations, and session restarts (committed to git alongside intent state)
- **And** the record is visible in the SPA's drift assessment view (US-05)
- **Defers to:** `DATA-CONTRACTS` for the `DA-{NN}.json` schema; `ARCHITECTURE.md §4.6` for the authoritative record contract.

#### AC-G12: Same-tick multiple drift events are processed atomically **[DEC-3]**

- **Given** multiple files have drifted since the last tick
- **When** the gate emits `manual_change_assessment`
- **Then** all drift events are presented to the agent in a single action payload
- **And** the agent's classification of each event is recorded as a single batch in a single `DA-{NN}.json` assessment record
- **And** baselines for all `ignore` / `inline-fix` outcomes update together
- **And** pending-assessment markers for all `surface-as-feedback` / `trigger-revisit` outcomes are recorded together

#### AC-G13: Ambiguous-diff default is `surface-as-feedback` **[DEC-3]**

- **Given** the agent cannot confidently classify a drift event (binary file changed with no context, large-scale restructuring of ambiguous intent, or file outside the agent's domain knowledge)
- **When** the agent produces its classification
- **Then** the default outcome is `surface-as-feedback` with a standard rationale note: "Unable to determine intent from the available diff. Surfacing as feedback for human review."
- **And** this conservative default produces a human-reviewable feedback item rather than silently ignoring or acting on the change
- **Note:** `ARCHITECTURE.md §4.5` specifies the default and the binary-file exceptions. Agent-judgment guideline, not a harness-enforced rule.

---

### Variant: Write-Path Origin — `spa-upload`

#### AC-SU1: SPA upload affordance is available per stage where a target exists **[DEC-7]**

- **Given** the SPA is rendering an intent's stage view
- **When** the stage has a defined upload target (a `knowledge/` directory for elaborate-class stages, an `artifacts/` directory for output-producing stages — per `TRACKED-SURFACE-BOUNDARY.md §1` and `ARCHITECTURE.md §9`)
- **Then** an upload affordance is visible in that stage's view; the destination selector enumerates available targets dynamically from the intent's stage structure
- **When** the stage has no defined upload target
- **Then** no upload affordance is rendered in that stage's view

#### AC-SU2: SPA upload writes to the worktree and stamps the action log **[DEC-1, DEC-7]**

- **Given** a user uploads a file via the SPA upload affordance
- **When** the upload completes
- **Then** the file is written to the appropriate target directory in the worktree (`knowledge/` or `artifacts/`)
- **And** the SPA upload endpoint stamps an action-log entry with `author_class: "human-via-mcp"` (mirroring `haiku_human_write` semantics)
- **And** the upload does NOT directly update `stages/{stage}/baseline.json`
- **And** the next `haiku_run_next` tick's drift-detection gate observes the new or changed file and emits a drift event with `author_class: "human-via-mcp"`
- **And** `manual_change_assessment` classifies the upload; the SPA shows a "manual change pending" chip until classification completes
- **Note:** `ARCHITECTURE.md §7.3` specifies the SPA upload endpoint's exact protocol; `SPA-UI-SPECS.md §4 Surface 3` specifies the Drift-Detected Banner lifecycle.

#### AC-SU3: SPA upload preserves the file name unless the user renames **[DEC-7]**

- **Given** a user uploads `figma-export-v2.png` via the SPA
- **When** the upload completes
- **Then** the file is written under the original name `figma-export-v2.png` in the destination directory
- **When** a file with the same name already exists at the target path
- **Then** the upload replaces the existing file (the resulting drift is detected and classified by the agent on the next tick)

---

### Variant: Write-Path Origin — `filesystem-drop`

#### AC-FS1: Manual filesystem writes require zero tooling knowledge **[DEC-1]**

- **Given** a user writes a file directly into the worktree using any local tool (editor save, `cp`, drag-and-drop, IDE) at a path inside the tracked surface
- **When** the next `haiku_run_next` tick runs
- **Then** the drift-detection gate observes the file as drifted (SHA divergence) or new (no baseline entry)
- **And** the user did not invoke any MCP tool, skill, or SPA action
- **And** no announcement step is required from the user; detection is automatic and implicit
- **Note:** This is the "silent filesystem drop" case that distinguishes H·AI·K·U from all comparable tools. `DISCOVERY.md §Differentiator summary` names it as a genuine differentiator.

#### AC-FS2: New files under tracked paths are detected as drift events **[DEC-1]**

- **Given** a file appears under a tracked path (`knowledge/`, `stages/{stage}/knowledge/`, `stages/{stage}/artifacts/`, `stages/{stage}/discovery/`) with no prior baseline entry
- **When** the gate runs
- **Then** the file is recorded as a drift event with `event_type: "added"` and `baseline_sha: null`
- **And** for text files, the diff payload carries the file's full current content
- **And** for binary files, the diff payload is `null` with `is_binary: true`
- **And** the agent's classification covers new files identically to changed files (all four outcomes apply)

#### AC-FS3: Editor temp files do not produce false positives **[DEC-1]**

- **Given** a user's editor writes via tempfile-then-rename (e.g., `.foo.txt.swp`, then rename to `foo.txt`) or creates common editor temp patterns (`.*\.swp$`, `.*~$`, `\.#.*`, `4913`, `*__jb_tmp__*`)
- **When** the gate runs
- **Then** transient temp files matching these patterns are excluded from baselining and drift detection
- **And** the post-rename final file (the committed content) is detected normally on the next scan
- **Defers to:** `DATA-CONTRACTS` for the authoritative temp-file exclusion pattern set.

---

### Variant: Write-Path Origin — `agent-on-behalf`

#### AC-AB1: Sanctioned MCP tool exists for human-attributed writes **[DEC-7, DEC-9]**

- **Given** a user instructs the agent in chat: "hey claude, save this content to `<path>`"
- **When** the agent decides to honor the instruction
- **Then** the agent invokes `haiku_human_write` (design-stage-final name per `MCP-TOOL-CONTRACT.md §2`) with the file content and destination path
- **And** the agent does NOT use its normal `Write` tool for this purpose (normal `Write` would not stamp the action log with `human-via-mcp` and the file would appear as `human-implicit` on the next tick)
- **And** the tool path must fall within the allow-list (`knowledge/`, `stages/{stage}/knowledge/`, `stages/{stage}/artifacts/`, `stages/{stage}/discovery/`) per `MCP-TOOL-CONTRACT.md §5.1`
- **And** the tool refuses all deny-listed paths (`stages/*/units/*.md`, `stages/*/feedback/*.md`, `intent.md`, `state.json`, `baseline.json`, `drift-markers.json`, `write-audit.jsonl`) per `MCP-TOOL-CONTRACT.md §5.2`

#### AC-AB2: Agent-on-behalf writes are detected as drift on the next tick **[DEC-1, DEC-7]**

- **Given** the agent invoked `haiku_human_write` successfully
- **When** the next `haiku_run_next` tick runs
- **Then** the drift-detection gate observes the file as drifted (or new), because `haiku_human_write` does NOT update `stages/{stage}/baseline.json` directly — this is intentional and load-bearing
- **And** the gate emits a drift event with `author_class: "human-via-mcp"` (read from the action-log entry stamped at write time)
- **And** `manual_change_assessment` is dispatched; the agent classifies the write (typically `inline-fix` or `ignore` since the user's intent is explicit)
- **And** the durable assessment record (`DA-{NN}.json`) is the audit trail linking the write to the classification
- **Note:** `ARCHITECTURE.md §6.2` specifies the action-log entry contract; `MCP-TOOL-CONTRACT.md §6.3` states the "Baseline-Update Intentional Non-Update" rationale.

#### AC-AB3: Conversation surface acknowledges the human-attributed write **[DEC-7]**

- **Given** the agent has invoked `haiku_human_write` successfully
- **When** the agent's response in chat completes
- **Then** the chat surface includes an acknowledgment noting the file was saved with human attribution (e.g., "saved as a human-attributed file at `knowledge/brand-guide.md` in stage `inception` — the next tick will classify this write")
- **And** the user understands the write was tracked, not silently regenerated

#### AC-AB4: Sanctioned tool uses trust-plus-audit integrity stance **[DEC-9]**

- **Resolved by design:** `ARCHITECTURE.md §6.3` and `MCP-TOOL-CONTRACT.md §10` resolve Decision 9 as **trust + audit**. No confirmation round-trip is required.
- **Given** a user instructs the agent to write a file via `haiku_human_write`
- **When** the tool executes
- **Then** the write completes without a confirmation prompt
- **And** the tool appends a record to `write-audit.jsonl` carrying: timestamp, `entry_id` (`HWM-{tick}-{n}`), path, SHA, `author_class: "human-via-mcp"`, `human_author_id`, `rationale`, and `user_instruction_excerpt` (first 200 chars)
- **And** the audit log record is the primary evidence that the write originated from an explicit user instruction
- **And** a security reviewer can verify any `human-via-mcp` baseline entry has a corresponding `write-audit.jsonl` record with user instruction context

#### AC-AB5: `haiku_human_write` tool output confirms attribution **[DEC-9]**

- **Given** the agent invokes `haiku_human_write` with a valid path and content
- **When** the tool completes successfully
- **Then** the response includes: `ok: true`, canonical `path`, `sha` (SHA-256 of content written), `author_class: "human-via-mcp"`, `timestamp`, `action_log_entry_id` (format `HWM-{tick}-{n}`), `audit_log_appended` (boolean)
- **And** the response `sha` matches the SHA that the drift-detection gate will compute on the next tick for this file

---

### Variant: Tracked-Surface Class — `stage-output`

#### AC-SO1: Stage output replacement is detected and classifiable **[DEC-6]**

- **Given** a file in a stage's `artifacts/` directory (e.g., `stages/design/artifacts/layout.html`; `stages/design/outputs/layout.html` is an alias that maps to the same canonical path)
- **When** the file is replaced by a human via any write-path origin (filesystem, SPA, or `haiku_human_write`)
- **Then** the drift-detection gate emits a drift event with `stage_owner: "design"` and the appropriate `is_binary` flag
- **And** the `manual_change_assessment` action dispatches with this context, enabling the agent to leverage its current stage / hat / unit context for classification

#### AC-SO2: Stage output drift on a non-active (earlier) stage is classified by the agent, not auto-revisited **[DEC-5]**

- **Given** the active stage is `development` and the drifted file is owned by `design` (its `stage_owner` field is `design`)
- **When** the agent classifies the drift event
- **Then** the harness does not automatically dispatch a revisit regardless of the cross-stage nature of the finding
- **And** all four classification outcomes (`ignore`, `inline-fix`, `surface-as-feedback`, `trigger-revisit`) are available to the agent
- **And** if the classification is `trigger-revisit`, the revisit targets the file's `stage_owner` (`design`), not the currently-active stage
- **And** the agent's rationale should reflect the cross-stage nature of the change (e.g., whether a typo correction vs. a semantic redesign warrants revisit)

#### AC-SO3: Stage output `artifacts/` is the canonical directory name **[DEC-2]**

- **Given** any system component (gate, SPA, `haiku_human_write`, assessment records) references a stage's output directory
- **When** the path is resolved
- **Then** `stages/{stage}/artifacts/` is the canonical path; `stages/{stage}/outputs/` is treated as a legacy alias
- **And** no separate `outputs/` directory is created in any intent; the alias maps to the canonical `artifacts/` path
- **Note:** `TRACKED-SURFACE-BOUNDARY.md §2 (Canonical Directory Name)` establishes this alias unambiguously.

---

### Variant: Tracked-Surface Class — `knowledge-input`

#### AC-KI1: Knowledge directory drops are detected as new-file drift events **[DEC-1, DEC-6]**

- **Given** a user drops a new file into the intent-level `knowledge/` directory or into `stages/{stage}/knowledge/`
- **When** the gate runs
- **Then** the file is recorded as a drift event with `event_type: "added"`, `stage_owner` reflecting the owning stage (or the inception stage for intent-level `knowledge/`), and `baseline_sha: null`
- **And** for text files, the full file content appears as the diff payload (the entire new file is "new")
- **And** for binary files (e.g., `.pdf`, `.png`), `diff_payload: null` and `is_binary: true`
- **And** `manual_change_assessment` is dispatched; the agent classifies the new knowledge file

#### AC-KI2: Knowledge integration during elaborate-class phases biases toward `inline-fix` **[DEC-3, DEC-6]**

- **Given** the active stage is in an elaborate-class phase and a new-file drift event is presented for the `knowledge/` directory
- **When** the agent classifies the event
- **Then** the agent should classify as `inline-fix` in the typical case — incorporate the new knowledge into the next elaboration bolt (this is the "user drops a reference document" scenario from DISCOVERY.md)
- **And** `surface-as-feedback` is appropriate when the new file appears to be a finding or concern rather than reference material (e.g., a "here's a bug report" PDF)
- **And** `ignore` is appropriate when the new file is a duplicate or superseded by an existing knowledge artifact
- **Note:** Agent-judgment guideline per `ARCHITECTURE.md §4.5`. The harness does not enforce bias; the agent reasons from context.

#### AC-KI3: Intent-level `knowledge/` is tracked across all stages **[DEC-1]**

- **Given** the intent-level `knowledge/` directory (at `knowledge/` relative to the intent root) contains files
- **When** the drift-detection gate runs on any active stage
- **Then** files under `knowledge/` are included in the tracked surface scan regardless of which stage is currently active
- **And** drift events on `knowledge/` files carry `stage_owner` referencing the inception stage (the stage that originally owns this directory)
- **Note:** `TRACKED-SURFACE-BOUNDARY.md §1.2` specifies that `knowledge/**` is accessible to all stages and is the primary landing zone for human-uploaded reference material.

---

### Variant: Tracked-Surface Class — `unit-output`

#### AC-UO1: Unit files are explicitly out of scope for drift detection **[DEC-2]**

- **Resolved by design:** `TRACKED-SURFACE-BOUNDARY.md §3.1` and `ARCHITECTURE.md §3.3` explicitly exclude `stages/{stage}/units/*.md` from the tracked surface. These are workflow-managed files guarded by the existing PreToolUse hook and the tamper-detection gate.
- **Given** a file under `stages/{stage}/units/` (a unit specification or working output)
- **When** the drift-detection gate runs
- **Then** the file is NOT included in the tracked surface scan
- **And** no drift event is emitted for changes to unit files
- **And** the existing tamper-detection gate and PreToolUse hook continue to govern these files as before
- **Note:** This is an accepted v1 boundary. The tracked surface for v1 is strictly `artifacts/`, `knowledge/`, and `discovery/`. Per-unit output tracking would require separate design work that is out of scope.

---

### Variant: File Payload Type — `text`

#### AC-T1: Text-file diff is presented to the agent **[DEC-3]**

- **Given** a drifted file is text (not matching the binary extension list in `TRACKED-SURFACE-BOUNDARY.md §5.2` and not containing null bytes in the first 8,192 bytes)
- **When** `manual_change_assessment` is emitted
- **Then** the action payload includes a standard unified diff (3 lines of context) between the baseline content and the current on-disk content
- **And** the diff is presented in `diff_payload` as a string suitable for the agent to read and classify

#### AC-T2: Diff size is capped at 200 lines **[DEC-3]**

- **Resolved by design:** `ARCHITECTURE.md §3.6` sets the cap at 200 lines with a trailing truncation note.
- **Given** a drifted text file whose unified diff exceeds 200 lines
- **When** the action payload is constructed
- **Then** the diff is truncated to the first 200 lines with a trailing note indicating truncation (e.g., "[truncated — view full diff via `haiku_knowledge_read` or equivalent]")
- **And** the file's full intent-relative path is included so the agent can fetch the full content if needed for classification
- **And** the agent classifies based on the available truncated diff; the classification record notes if the full diff was not examined

---

### Variant: File Payload Type — `binary`

#### AC-B1: Binary drift presents a degraded payload **[DEC-3]**

- **Given** a drifted file is binary (matches the binary extension list in `TRACKED-SURFACE-BOUNDARY.md §5.2` — e.g., `.png`, `.jpg`, `.figma`, `.pdf`, `.pen`, `.sketch` — or contains null bytes in the first 8,192 bytes)
- **When** `manual_change_assessment` is emitted
- **Then** the action payload includes: `file_path`, `stage_owner`, `event_type`, `is_binary: true`, `diff_payload: null`, `baseline_sha`, `current_sha`, mime hint (derived from extension at dispatch time)
- **And** no textual diff is included (SHA comparison is the only content signal)
- **Note:** `ARCHITECTURE.md §3.6` and `TRACKED-SURFACE-BOUNDARY.md §5.4` specify the binary drift event shape.

#### AC-B2: Default classification for binary drift is `surface-as-feedback` absent stage context **[DEC-3]**

- **Resolved by design:** `ARCHITECTURE.md §4.5` sets the unambiguous default as `surface-as-feedback`. The draft's `inline-fix` default was superseded by the architecture.
- **Given** a binary drift event where the agent lacks stage-specific context making the change unambiguous
- **When** the agent classifies the event
- **Then** the default outcome is `surface-as-feedback` with rationale: "Binary file changed; content diff unavailable. Surfacing for human review."
- **And** `inline-fix` is appropriate when the agent has sufficient stage context — e.g., the intent is in the `design` stage, the active hat involves design artifact production, and the changed file is in `stages/design/artifacts/` (a deliberate designer replacement)
- **And** `inline-fix` is also appropriate for new binary files under `knowledge/` (the user uploaded a reference image or PDF)
- **Note:** Agent-judgment guideline per `ARCHITECTURE.md §4.5`. The conservative `surface-as-feedback` default ensures no binary change is silently discarded.

#### AC-B3: Vision tool invocation is permitted but not required **[DEC-3]**

- **Given** the agent receives a binary drift event for an image file
- **When** the agent's classification rationale would benefit from visual inspection
- **Then** the agent may invoke a vision tool (e.g., `Read` on the image path, `ask_user_visual_question`) to inform classification
- **And** the agent is not required to invoke a vision tool for any specific case
- **And** invoking a vision tool does not change the baseline-update contract or the four-outcome taxonomy; the classification outcome is the same regardless of how the agent formed its judgment

---

### Variant: Stage-of-Ownership — `current`

#### AC-CO1: Current-stage drift cannot trigger revisit of self **[DEC-5]**

- **Given** a drift event whose `stage_owner` equals the currently-active stage
- **When** the agent classifies the event
- **Then** the valid classification outcomes are `ignore`, `inline-fix`, or `surface-as-feedback`
- **And** `trigger-revisit` is rejected by the harness with a redirect to one of the three valid current-stage outcomes (see AC-TR3 for the harness enforcement rule)
- **Note:** Revisiting the currently-active stage from within that stage would create a recursive revisit loop with undefined semantics. The harness guards against this.

---

### Variant: Stage-of-Ownership — `earlier`

#### AC-EO1: Earlier-stage drift may classify to any of the four outcomes **[DEC-5]**

- **Given** a drift event whose `stage_owner` is earlier than the currently-active stage
- **When** the agent classifies the event
- **Then** all four classification outcomes are valid: `ignore`, `inline-fix`, `surface-as-feedback`, `trigger-revisit`
- **And** the agent's rationale should explicitly reflect the cross-stage nature of the change (e.g., whether it is a cosmetic correction or a semantic redesign that invalidates downstream work)
- **And** the harness does not apply additional restrictions on earlier-stage drift outcomes

#### AC-EO2: `inline-fix` on earlier-stage drift does not advance or rewind the workflow **[DEC-5]**

- **Given** an `inline-fix` classification on a drift event owned by an earlier stage
- **When** the classification is recorded
- **Then** the baseline for the file updates immediately to the current on-disk SHA
- **And** the active stage does not change — the workflow stays at the current stage with no gate re-validation
- **And** the agent's downstream context (what it knows about earlier stage outputs) is updated for subsequent bolts, but the earlier stage's gate does not re-run
- **Note:** `inline-fix` on earlier-stage drift is "the agent absorbs the change and proceeds" — a low-cost acknowledgment. If the earlier-stage change actually invalidates the current stage's work, `trigger-revisit` (not `inline-fix`) is the appropriate outcome.

---

### Variant: Operating Mode — `interactive` / `pickup` / `autopilot`

#### AC-OM1: Detection and classification behave identically across modes **[DEC-3]**

- **Given** any operating mode (interactive / pickup / autopilot)
- **When** drift is detected and classified
- **Then** the gate execution, action emission, four-outcome classification, and baseline-update contract are identical regardless of mode
- **And** the durable assessment record (`DA-{NN}.json`) is written and the SPA drift assessment view (US-05) reflects it across all modes

#### AC-OM2: v1 default is silent classification across all modes **[DEC-3]**

- **Given** the intent is in any operating mode (including autopilot)
- **When** drift is detected and classified
- **Then** the agent classifies without pausing for human confirmation in any mode
- **And** the classification is surfaced passively: via the SPA drift assessment view (US-05) and via the chat surface on the next interactive turn
- **And** the three new SPA surfaces (Knowledge Upload Panel, Stage Output Replacement Card, Drift-Detected Banner) are **read-only indicators with no assessment-trigger affordance** — the user's only role during the assessment window is to observe (per `SPA-UI-SPECS.md §0, §4.6`)
- **Note:** `ARCHITECTURE.md §4.1` states the action is autonomous. A future enhancement may add per-mode confirmation policies; v1 is uniformly silent.

---

### Variant: Classification Outcome — `ignore`

#### AC-CI1: `ignore` updates baseline and produces no further action **[DEC-3]**

- **Given** an `ignore` classification
- **When** the classification is recorded
- **Then** the baseline SHA in `stages/{stage}/baseline.json` updates immediately to the observed SHA with the originating `author_class`
- **And** no feedback item is created
- **And** no revisit is dispatched
- **And** no pending-assessment marker is written
- **And** the assessment record `DA-{NN}.json` is the only durable artifact of the event; the SPA drift assessment view surfaces it for human review

---

### Variant: Classification Outcome — `inline-fix`

#### AC-IF1: `inline-fix` updates baseline and feeds the current bolt **[DEC-3, DEC-4]**

- **Given** an `inline-fix` classification on any drift event (current or earlier-stage)
- **When** the classification is recorded
- **Then** the baseline SHA in `stages/{stage}/baseline.json` updates immediately to the observed SHA
- **And** the agent's next action in the bolt treats the human's edit as the new ground truth — re-reads the file before proceeding (Aider-style "human edit is authoritative")
- **And** no feedback item is created
- **And** no revisit is dispatched
- **And** no pending-assessment marker is written

---

### Variant: Classification Outcome — `surface-as-feedback`

#### AC-SF1: `surface-as-feedback` creates a normal feedback item **[DEC-3]**

- **Given** a `surface-as-feedback` classification
- **When** the classification is recorded
- **Then** a feedback item is created via `haiku_feedback` on the owning stage
- **And** the feedback's `origin` is set to `"agent-detected"` to identify it as drift-derived (per `ARCHITECTURE.md §4.4.3`)
- **And** the feedback's body cites the file path, the diff payload (truncated if necessary), the finding_id (`DRF-NN`), and the agent's rationale
- **And** the feedback item appears in the SPA's feedback list with the `agent-detected` origin badge

#### AC-SF2: Pending-assessment marker is keyed to the feedback item **[DEC-3]**

- **Resolved by design:** `ARCHITECTURE.md §5.2` specifies the marker storage at `drift-markers.json`.
- **Given** a `surface-as-feedback` classification
- **When** the assessment record and feedback item are written
- **Then** a pending-assessment marker is recorded in `drift-markers.json` keyed by file path, linking it to the feedback item path and the `baseline_sha_at_creation`
- **And** the marker prevents re-detection of drift on this file while the feedback is open (gate skips files with open markers)
- **And** if the file is edited again while the marker is open and the SHA changes from `baseline_sha_at_creation`, the marker is treated as stale and a new drift event is emitted (see AC-EE6)

#### AC-SF3: Closing the feedback clears the marker and updates the baseline **[DEC-3]**

- **Given** an open pending-assessment marker linked to feedback item FB-NN in `drift-markers.json`
- **When** FB-NN's status transitions to a terminal state (`addressed`, `closed`, or `rejected`)
- **Then** the marker entry for the linked file is removed from `drift-markers.json`
- **And** the baseline SHA in `stages/{stage}/baseline.json` updates to the file's SHA at marker-clearing time
- **And** the next tick observes no drift on this file (assuming no further edit since marker-clearing)

---

### Variant: Classification Outcome — `trigger-revisit`

#### AC-TR1: `trigger-revisit` invokes revisit on the owning stage via `haiku_revisit` **[DEC-3, DEC-5]**

- **Resolved by design:** `ARCHITECTURE.md §4.4.4` confirms the existing `haiku_revisit` MCP tool is the dispatch mechanism (no new workflow path needed).
- **Given** a `trigger-revisit` classification on a drift event whose `stage_owner` is earlier than the active stage
- **When** the classification is recorded
- **Then** a revisit is dispatched via `haiku_revisit` targeting the `stage_owner` stage
- **And** a pending-assessment marker is recorded in `drift-markers.json` referencing the revisit stage
- **And** the baseline SHA in `stages/{stage}/baseline.json` does NOT update at classification time

#### AC-TR2: Revisit completion clears the marker and updates the baseline **[DEC-3, DEC-5]**

- **Given** an open pending-assessment marker in `drift-markers.json` linked to a revisit dispatch on stage S
- **When** stage S re-passes its gate (revisit completes — the revisited stage advances back to its pre-revisit position)
- **Then** the marker entry for the linked file is removed from `drift-markers.json`
- **And** the baseline SHA in the owning stage's `baseline.json` updates to the file's SHA at marker-clearing time

#### AC-TR3: Harness rejects `trigger-revisit` for current-stage drift **[DEC-5]**

- **Given** a drift event whose `stage_owner` equals the active stage (current-stage drift; covered by AC-CO1)
- **When** the agent attempts to classify as `trigger-revisit`
- **Then** the harness rejects the classification with a redirect message specifying the three valid current-stage outcomes (`ignore`, `inline-fix`, `surface-as-feedback`)
- **And** the agent must re-classify using one of the three valid options before the assessment record is written
- **Note:** This prevents revisit-of-self loops. `ARCHITECTURE.md §4.4.4` specifies that `trigger-revisit` requires the `target_stage` to differ from the active stage.

---

## Edge Cases & Error Paths

#### AC-EE1: Concurrent same-tick drift on the same file (race condition) **[DEC-4]**

- **Failure mode:** Agent mid-bolt write and human filesystem write both land in the same working-tree state between two ticks.
- **Expected response:** The gate observes the file's final on-disk SHA (whichever write landed last) and emits a single drift event. The agent classification proceeds normally using the final state.
- **Verification:** Write two conflicting versions of a tracked file in rapid succession before triggering a tick; confirm a single drift event with the final SHA; confirm no double-dispatch of `manual_change_assessment`.
- **Note:** `ARCHITECTURE.md §7.2` explicitly acknowledges this as accepted behavior under the eventual-consistency model. The agent's classification rationale field is where ambiguity ("human edit appears to target the pre-bolt version") should be surfaced.

#### AC-EE2: Tracked file deleted by human **[DEC-3]**

- **Failure mode:** A previously-baselined file is removed from the worktree (via `rm`, SPA delete affordance, or equivalent).
- **Expected response:** The gate emits a drift event with `event_type: "deleted"`, `current_sha: null`, and `diff_payload` carrying prior content if recoverable from git history. The agent classifies the deletion using the four-outcome taxonomy: `ignore` = deletion stands, baseline entry drops; `inline-fix` = agent re-creates the file from baseline content; `surface-as-feedback` = open feedback citing the deletion; `trigger-revisit` = revisit the owning stage if the deleted file was foundational.
- **Verification:** Delete a tracked file; trigger a tick; confirm `event_type: "deleted"` in the drift event; confirm the agent classifies and the baseline removes the entry (or marks it appropriately); confirm no subsequent re-detection on the next tick.

#### AC-EE3: File written outside the tracked surface is invisible to the gate **[DEC-2]**

- **Failure mode:** Human writes a file to a location outside the tracked surface (e.g., a project source directory under `src/`, a config file at repo root, any path outside `.haiku/intents/{slug}/`).
- **Expected response:** The gate does not detect the file. No drift event is emitted. The framework's behavior is identical to pre-feature behavior for that file.
- **Verification:** Write to a path outside `.haiku/intents/{slug}/`; trigger ticks; confirm no drift event; confirm no `manual_change_assessment` dispatch.
- **Note:** This is an accepted v1 limitation. `TRACKED-SURFACE-BOUNDARY.md §3.4` documents the exclusion rationale (I/O overhead, normal development activity).

#### AC-EE4: Baseline file storage corrupted or missing **[DEC-1]**

- **Failure mode:** `stages/{stage}/baseline.json` is corrupt (JSON parse error, schema violation, invalid SHA format, unrecognized `author_class`) or absent.
- **Expected response for corrupt baseline:** Per `ARCHITECTURE.md §8.2`, the gate halts and emits a `baseline_corrupt` signal. The tick does not advance to per-state dispatch. The workflow surfaces an error to the agent: "Baseline file for stage `{stage}` is corrupt. Run `haiku_repair` to re-establish the baseline."
- **Expected response for absent baseline:** Gate runs in establishment mode — enumerates tracked surface, writes new `baseline.json`, writes `drift_baseline_established_at`, emits zero drift events. Normal operation on subsequent ticks.
- **Verification:** Corrupt a `baseline.json` with invalid JSON; trigger a tick; confirm the tick halts with `baseline_corrupt`; run `haiku_repair`; confirm re-establishment on next tick with zero events.

#### AC-EE5: Agent classification times out or fails **[DEC-3]**

- **Failure mode:** The agent receives `manual_change_assessment` but fails to produce a valid classification (bolt timeout, tool call error, malformed response).
- **Expected response:** The drift event is re-emitted on the next tick (the gate still observes the SHA divergence; no pending-assessment marker was written because classification did not complete). The prior failed attempt is recorded in the assessment record as a failed attempt for audit purposes. No baseline update occurs from the failed attempt.
- **Verification:** Simulate a classification failure; trigger subsequent ticks; confirm the drift event re-appears; confirm the assessment record includes a failed-attempt entry; confirm baseline is unchanged.

#### AC-EE6: File drifts a second time while a pending-assessment marker is open **[DEC-4]**

- **Failure mode:** An open pending-assessment marker exists for file F (from a `surface-as-feedback` outcome). Before the marker clears, file F is edited again.
- **Expected response:** Per `ARCHITECTURE.md §5.3`, the gate compares the file's current SHA against `baseline_sha_at_creation` in the marker. If the SHA has changed since the marker was written, the marker is treated as stale — the gate removes it and emits a new drift event for the second edit. If the SHA matches `baseline_sha_at_creation` (the file was restored to its original drifted state), the marker remains open and the gate suppresses the event.
- **Verification:** Write file F, classify as `surface-as-feedback` (marker open), then write F again with different content; trigger a tick; confirm a new drift event fires; confirm the old marker is removed and a new marker is written if the re-classification is again non-terminal.
- **Note:** This is a v1 correctness boundary. The stale-marker detection (`SHA vs. baseline_sha_at_creation`) prevents double-edits from being silently swallowed.

#### AC-EE7: SPA classification override is a P1 feature **[DEC-3]**

- **Failure mode / user concern:** Agent misclassifies a drift event (e.g., classifies "ignore" when the user intended "trigger-revisit"). User has no mechanism to override without creating a separate manual feedback item.
- **Expected response (v1 behavior):** No in-SPA override mechanism exists. The user's recourse is: (a) create a manual feedback item describing the correct outcome, or (b) invoke `haiku_revisit` directly if a revisit is needed.
- **Expected response (P1 target):** Per US-06, the SPA assessment view allows the user to select an override outcome and enter a rationale. The assessment record is updated with `override.outcome`, `override.reason`, and `override.author`. Side effects of the override fire (revisit dispatched, baseline rolled back if classification had updated it, new pending marker written if applicable).
- **Verification (P1):** Open a completed assessment in the SPA; trigger an override; confirm the assessment record reflects the override; confirm the side-effect fires correctly.
- **Note:** Override mechanics are P1 (US-06). v1 ships without override.

#### AC-EE8: Kill-switch `drift_detection: false` disables the gate completely **[DEC-1]**

- **Failure mode / operator scenario:** A bug in the drift-detection gate produces false-positive storms or a performance regression. Operator needs rapid disable without rolling back the plugin.
- **Expected response:** Setting `drift_detection: false` in plugin settings makes the pre-tick drift-detection gate a complete no-op: no enumeration, no SHA computation, no baseline reads, no drift events, no `manual_change_assessment` dispatch. The gate chain reduces to `tamper-detection → feedback-triage → per-state dispatch`. Existing baseline files remain on disk untouched.
- **Verification:** Set `drift_detection: false`; write to a tracked file; trigger ticks; confirm no drift events; confirm `manual_change_assessment` never dispatches; set flag back to `true`; confirm the gate resumes from existing baselines on the next tick (accumulated drift since disable appears as a single batch of drift events).
- **Defers to:** `ROLLOUT-AND-BASELINE-ESTABLISHMENT.md §8` for the full kill-switch contract.

---

## Prioritization Summary

### P0 (must-have for completion)

All entries required to ship the core detection, classification, and baseline-update lifecycle:

- **User stories:** US-01, US-02, US-03, US-04, US-05, US-07, US-08, US-09, US-11, US-12
- **General Rules:** AC-G1 through AC-G13 (13 entries)
- **Write-path origin — filesystem-drop:** AC-FS1, AC-FS2, AC-FS3
- **Write-path origin — agent-on-behalf:** AC-AB1, AC-AB2, AC-AB3, AC-AB4 (trust+audit stance — resolved), AC-AB5
- **Tracked-surface class — stage-output:** AC-SO1, AC-SO2, AC-SO3
- **Tracked-surface class — knowledge-input:** AC-KI1, AC-KI2, AC-KI3
- **Tracked-surface class — unit-output:** AC-UO1 (resolved as out-of-scope for v1)
- **File payload type — text:** AC-T1, AC-T2 (200-line cap resolved)
- **File payload type — binary:** AC-B1, AC-B2 (`surface-as-feedback` default resolved), AC-B3
- **Stage-of-ownership — current:** AC-CO1
- **Stage-of-ownership — earlier:** AC-EO1, AC-EO2
- **Operating mode:** AC-OM1, AC-OM2
- **Classification outcome — ignore:** AC-CI1
- **Classification outcome — inline-fix:** AC-IF1
- **Classification outcome — surface-as-feedback:** AC-SF1, AC-SF2, AC-SF3
- **Classification outcome — trigger-revisit:** AC-TR1, AC-TR2, AC-TR3
- **Edge cases:** AC-EE1 through AC-EE6, AC-EE8 (kill-switch)

### P1 (follow-up)

Nice-to-have post-v1 items. Filesystem-drop covers base cases; SPA upload and classification override are UX upgrades.

- **User story:** US-06 (SPA override of classification), US-10 (SPA upload affordance per stage)
- **Write-path origin — SPA upload:** AC-SU1, AC-SU2, AC-SU3
- **Edge case:** AC-EE7 (SPA classification override mechanics)

### Previously Deferred — Now Resolved

The following items were listed as "Open / Deferred to Design" in the prior draft and have been resolved by the design-stage artifacts. They are now included in the P0 set above.

| Prior Open Item | Resolution | Design Artifact |
|---|---|---|
| AC-AB4 — Human-write-path integrity stance (Decision 9) | Trust + audit; no confirmation round-trip | `ARCHITECTURE.md §6.3`, `MCP-TOOL-CONTRACT.md §10` |
| AC-UO1 — Tracked-surface boundary on `units/` | Explicitly excluded from v1 tracked surface | `TRACKED-SURFACE-BOUNDARY.md §3.1`, `ARCHITECTURE.md §3.3` |
| AC-T2 — Diff size cap | 200 lines, not 200KB | `ARCHITECTURE.md §3.6` |
| AC-FS3 — Temp-file pattern set | Deferred to `DATA-CONTRACTS` for the authoritative set | `DATA-CONTRACTS` (sibling artifact) |
| AC-B2 — Binary default classification | `surface-as-feedback`, not `inline-fix` | `ARCHITECTURE.md §4.5` |
| Pending-assessment marker storage location | `drift-markers.json` at intent root | `ARCHITECTURE.md §5.2` |
| Baseline storage location | `stages/{stage}/baseline.json` | `ARCHITECTURE.md §2.2` |
| Canonical output directory name (`outputs/` vs `artifacts/`) | `artifacts/` is canonical; `outputs/` is alias | `TRACKED-SURFACE-BOUNDARY.md §2` |

---

## Decision Traceability Summary

All nine design decisions from `knowledge/DESIGN-DECISIONS.md` are addressed in this document. The table below maps each decision to the ACs that implement its acceptance boundary.

| Decision | Summary | Primary ACs |
|---|---|---|
| **DEC-1** | Both explicit and implicit detection required; unified SHA gate | AC-G1, AC-G2, AC-G8, AC-G10, AC-FS1, AC-FS2, AC-SU2, AC-AB2, AC-KI3, AC-EE8 |
| **DEC-2** | Agent guardrail boundary unchanged; workflow-managed files excluded | AC-G6, AC-G7, AC-UO1, AC-SO3, AC-EE3 |
| **DEC-3** | New `manual_change_assessment` action; agent-owned classification | AC-G2, AC-G3, AC-G4, AC-G5, AC-G11, AC-G12, AC-G13, AC-CI1, AC-IF1, AC-SF1–3, AC-TR1–3, AC-OM2 |
| **DEC-4** | Eventual consistency; no file locking | AC-G9, AC-IF1, AC-EE1, AC-EE6 |
| **DEC-5** | Cross-stage drift is agent-classified; no automatic revisit | AC-SO2, AC-EO1, AC-EO2, AC-CO1, AC-TR1–3 |
| **DEC-6** | All three change types in scope; unified mechanism | AC-SO1, AC-KI1, AC-KI2, AC-FS1, AC-AB1, AC-EE2 |
| **DEC-7** | Three write paths unified by SHA gate; SPA upload + `haiku_human_write` both stamp action log | AC-G10, AC-SU2, AC-AB1–5, AC-KI1 |
| **DEC-8** | Full three-component sync (paper + plugin + website) | N/A — methodology sync discipline; covered by CLAUDE.md sync table |
| **DEC-9** | Trust + audit stance for human-write-path integrity | AC-AB4, AC-AB5 |

---

## Context Boundaries (Cross-Cutting Notes)

The following observations surfaced while writing acceptance criteria but their substance belongs in sibling product-stage artifacts. They are noted here so they are not lost at integration time.

- **Behavioral spec dependency** — The `manual_change_assessment` action's exact wire-level payload shape (JSON schema, field types, null vs. absent semantics), ordering relative to existing pre-tick gates (feedback-triage), and lifecycle inside the workflow engine are behavioral-spec territory. AC-G2 and related ACs reference the action at the user-observable level; `BEHAVIORAL-SPEC` authors the wire-level contract. The authoritative payload reference is `ARCHITECTURE.md §4.2`.

- **Data contracts dependency** — The on-disk schemas for `baseline.json`, `drift-markers.json`, `write-audit.jsonl`, `DA-{NN}.json` assessment records, and `drift_baseline_established_at` in `state.json` are data-contract territory. ACs in the General Rules and Edge Cases sections reference these at the user-observable level (durability, survival across operations); `DATA-CONTRACTS` authors the schemas. The authoritative structural reference is `ARCHITECTURE.md §2–5`.

- **Coverage mapping dependency** — Mapping each AC to specific test layers (unit, integration, e2e) and identifying which existing test surfaces (orchestrator harness, SPA Playwright suite, `haiku_human_write` tool contract tests) cover which AC is `COVERAGE-MAPPING` territory.

- **Security boundary** — The trust + audit stance (DEC-9, now resolved as AC-AB4) leaves a v2 harness-level enforcement path open. `ARCHITECTURE.md §6.3` and `MCP-TOOL-CONTRACT.md §10` acknowledge that if misuse patterns appear in production audit logs, harness-level enforcement (e.g., a hook requiring a human turn before the tool fires) is the v2 mitigation. That enforcement path is not specced here or in the design stage; it would require a new inception pass if adopted.

- **Migration / upgrade story** — AC-G8 and AC-EE8 cover the user-facing first-tick-after-upgrade behavior and the kill-switch. The full operations and rollout story (telemetry event set, staged rollout per project, re-enable behavior) is in `ROLLOUT-AND-BASELINE-ESTABLISHMENT.md` and the operations stage, not here.

- **SPA component architecture** — The SPA's upload affordance and drift assessment view are specified at the behavioral level in this document (AC-SU1–3, AC-OM2, US-05) and at the component level in `SPA-UI-SPECS.md`. Implementation overlap with the `remote-review-spa` branch (noted in `DISCOVERY.md §Overlap Awareness`) is a development-stage coordination signal, not a product-stage concern.
