# Data Contracts — Out-of-band Human File Modifications

*Product-stage canonical source. This document supersedes the discovery-phase draft at
`.haiku/intents/out-of-band-human-file-modifications/knowledge/DATA-CONTRACTS.md`. When this
unit completes, every downstream stage (development, operations, security) reads from here.
All enum values, field names, and naming conventions in this document are normative —
deviations in code or documentation are reconciliation failures.*

---

## 0. Canonical Enum Pinning (normative)

Three enums are defined once here and referenced from every schema, action payload, MCP tool
contract, HTTP API, and event below. Any document that uses a different spelling for these
values is out of sync and must be updated before development begins.

### 0.1 `change_kind` enum

```
"added" | "modified" | "deleted"
```

*All lowercase. Three values exactly. No aliases.*

| Value | Meaning |
|---|---|
| `added` | File is present on disk but has no prior baseline entry |
| `modified` | File exists in the baseline and on disk; SHAs differ |
| `deleted` | File exists in the baseline but is absent on disk |

**Deprecated / forbidden aliases:** `created`, `updated`, `removed`, `replace`. If any prior document
(including `ARCHITECTURE.md` event-shape sketches, Gherkin `.feature` files, or the discovery draft
`DATA-CONTRACTS.md`) uses those aliases, they are reconciliation failures. The canonical values above
apply everywhere.

### 0.2 `author_class` enum

```
"agent" | "human-via-mcp" | "human-implicit"
```

*All lowercase with hyphens. Three values exactly. No aliases.*

| Value | Meaning |
|---|---|
| `agent` | File was written by the agent through its normal MCP tool pipeline |
| `human-via-mcp` | File was written through a sanctioned human-attributed channel (the `haiku_human_write` tool or the SPA upload endpoint) |
| `human-implicit` | SHA diverged with no intervening agent or tool stamp — inferred as an out-of-band filesystem write |

**Deprecated / forbidden aliases:** `user`, `external`, `manual`. The `Baseline` schema requires
`author_class` as a required, enum-typed field. See §2.1.

### 0.3 `outcome` enum

```
"ignore" | "inline-fix" | "surface-as-feedback" | "trigger-revisit"
```

*All lowercase with hyphens. Four values exactly. No aliases.*

| Value | Meaning |
|---|---|
| `ignore` | Change is not workflow-significant; baseline updated immediately |
| `inline-fix` | Human improvement to fold into the next bolt; baseline updated immediately |
| `surface-as-feedback` | Concern or regression; feedback item created; pending marker written; baseline deferred |
| `trigger-revisit` | Fundamental redirect; `haiku_revisit` invoked; pending marker written; baseline deferred |

**Deprecated / forbidden aliases:** `auto-fix`, `escalate`. The `Classification` and `Assessment`
schemas use this enum's values verbatim for the `outcome` field. The `manual_change_assessment`
action's `legal_outcomes` map uses these values as the allowed-outcome lists.

---

## 1. Naming Conventions

Entity names are pinned identically across all five surfaces: disk, action payloads, MCP tools,
HTTP API, and events. The table below is the single authoritative naming reference.

| Concept | Snake_case (disk, JSON) | PascalCase (TS interface) | Kebab-case (URLs) |
|---|---|---|---|
| Last-acknowledged content hash for a tracked file | `baseline` / `baseline_entry` | `Baseline` | `baselines` |
| A file being monitored by the drift-detection gate | `tracked_file` | `TrackedFile` | `tracked-files` |
| A detected divergence between baseline and on-disk state | `drift_finding` | `DriftFinding` | `drift-findings` |
| An agent-authored classification of a drift finding | `assessment` | `Assessment` | `assessments` |
| The four legal classification outcomes (§0.3) | `classification` (enum discriminant) | — | — |
| An open, unresolved non-terminal classification record | `pending_marker` | `PendingMarker` | `pending-markers` |

**Cross-surface naming audit:** See §7 for the proof table that every entity uses the same name
across all five surfaces.

---

## 2. Persistent State Schemas

Three new schemas persist to disk as part of the intent's state. The exact storage mechanism
(location, file format, encoding) is a development-stage decision. The field-level shapes are
normative and storage-agnostic.

### 2.1 `Baseline` — one entry per tracked file

The baseline is a map from tracked-file-path to a record with the following fields:

| Field | Type | Required | Default | Constraints |
|---|---|---|---|---|
| `path` | string | yes | — | POSIX path relative to the intent directory root (`.haiku/intents/{slug}/`). No leading slash. No `..` segments. Unique per intent. |
| `sha256` | string | yes | — | Lowercase hex SHA-256 digest of the file's full byte content at last acknowledgment. Exactly 64 characters. |
| `bytes` | integer | yes | — | File size in bytes at acknowledgment. Used as a pre-check skip hint before re-hashing; `sha256` is authoritative. |
| `mtime_ns` | integer | yes | — | File mtime in nanoseconds since epoch at acknowledgment. Hashing skip-hint only; `sha256` is authoritative. |
| `is_binary` | boolean | yes | `false` | True when the file fails the text heuristic (null bytes in first 8 KiB or extension in the binary list). Drives diff-payload behavior. |
| `author_class` | `"agent" \| "human-via-mcp" \| "human-implicit"` | yes | — | **Required enum field per reconciliation requirement R2.** The enum from §0.2. Records who/what last caused the workflow engine to acknowledge this baseline entry. |
| `acknowledged_at` | string (RFC 3339) | yes | — | UTC ISO-8601 timestamp with `Z` suffix. Example: `"2026-04-28T14:32:00Z"`. |
| `acknowledged_via` | `"agent-write" \| "human-write-tool" \| "spa-upload" \| "classification-terminal" \| "baseline-init"` | yes | — | The channel through which the baseline was last written. Distinct from `author_class`: `author_class` records *who* authored; `acknowledged_via` records *how* the write reached the workflow engine. |
| `stage` | string \| null | yes | — | Owning stage slug (e.g. `"product"`, `"design"`). `null` for intent-scope files. |
| `tracking_class` | `"stage-output" \| "knowledge" \| "unit-output" \| "intent-meta"` | yes | — | The category driving which directories are scanned and which UI affordances apply. |

**Note on `stage-output` vs `artifacts/`:** The tracked surface uses `stages/{stage}/artifacts/**`
as the canonical output directory name. `stages/{stage}/outputs/**` is a deprecated alias; the
canonical term used in code and in baseline keys is `artifacts`. See §2.1.1 for the full boundary
note.

#### 2.1.1 Tracked-Surface Boundary Note (normative)

The tracked surface for stage output artifacts uses `stages/{stage}/artifacts/**` as the canonical
path. `stages/{stage}/outputs/**` is a deprecated alias kept for backward compatibility with
documents that predate the TRACKED-SURFACE-BOUNDARY.md decision. In code: the canonical directory
name is **`artifacts/`**. A reference to `outputs/` in any schema, tool contract, or test fixture
should be treated as pointing to `artifacts/`. No separate `outputs/` directory is created at
runtime; both path patterns resolve to the same canonical location. The `tracking_class` value for
files under this path is `"stage-output"` in both the canonical and alias forms.

**Worked example — `Baseline` entry:**

```json
{
  "path": "stages/product/artifacts/DATA-CONTRACTS.md",
  "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "bytes": 14821,
  "mtime_ns": 1714312320123456789,
  "is_binary": false,
  "author_class": "agent",
  "acknowledged_at": "2026-04-28T14:32:00Z",
  "acknowledged_via": "agent-write",
  "stage": "product",
  "tracking_class": "stage-output"
}
```

**Storage reference:** `stages/{stage}/baseline.json` inside the intent directory. One file per
stage. Cross-stage entries (a design artifact modified while development is active) are stored in the
baseline file of the stage that originally produced the file.

**Logical indexes:** primary `(intent_slug, path)`; secondary `(intent_slug, stage)` for per-stage
scans; secondary `(intent_slug, tracking_class)` for SPA filters.

---

### 2.2 `PendingMarker` — one record per open non-terminal classification

Created when `haiku_classify_drift` records a classification with outcome `surface-as-feedback` or
`trigger-revisit`. Cleared when the linked downstream action resolves.

| Field | Type | Required | Default | Constraints |
|---|---|---|---|---|
| `path` | string | yes | — | Same shape as `Baseline.path`. Logical foreign key to the `Baseline` entry for this file. |
| `created_at` | string (RFC 3339) | yes | — | UTC timestamp when the marker was written. |
| `created_by_assessment_id` | string | yes | — | The `Assessment.id` (e.g. `"AS-07"`) that created this marker. |
| `outcome` | `"surface-as-feedback" \| "trigger-revisit"` | yes | — | The non-terminal outcome that produced this marker. Must be one of the two non-terminal values from §0.3. |
| `linked_feedback_id` | string \| null | yes | — | `"FB-NN"` of the feedback item this marker is waiting on, or `null` if `outcome === "trigger-revisit"`. Exactly one of `linked_feedback_id` / `linked_revisit_target_stage` is non-null (mutual exclusion enforced at write time). |
| `linked_revisit_target_stage` | string \| null | yes | — | Stage slug of the revisit target, or `null` if `outcome === "surface-as-feedback"`. |
| `cleared_at` | string (RFC 3339) \| null | yes | `null` | Set when the downstream action resolves; once non-null the marker is logically resolved. |

**Constraints:**
- `(intent_slug, path)` is **not** unique — multiple markers may queue on the same file across
  separate assessments. The drift gate's "skip if pending" check is: *any row with this `path` and
  `cleared_at IS NULL`*.
- The newest open marker (max `created_at` with `cleared_at IS NULL`) is the suppressing one.

**Storage reference:** Intent-scoped sidecar at `.haiku/intents/{slug}/drift-markers.json`. Not
stage-scoped, because cross-stage markers may be open while a later stage is active.

**Worked example:**

```json
{
  "path": "stages/design/artifacts/hero-layout.html",
  "created_at": "2026-04-28T14:35:12Z",
  "created_by_assessment_id": "AS-07",
  "outcome": "surface-as-feedback",
  "linked_feedback_id": "FB-12",
  "linked_revisit_target_stage": null,
  "cleared_at": null
}
```

---

### 2.3 `Assessment` — one record per classification dispatch

Append-only. The durable record of what changed, what the agent decided, and why. Written by
`haiku_classify_drift` on every `manual_change_assessment` dispatch.

| Field | Type | Required | Default | Constraints |
|---|---|---|---|---|
| `id` | string | yes | — | `"AS-NN"`, two-digit zero-padded sequential per intent. Mirrors the `FB-NN` / `unit-NN-*` ID conventions used elsewhere. |
| `created_at` | string (RFC 3339) | yes | — | UTC timestamp. |
| `tick_id` | string | yes | — | Identifier of the `haiku_run_next` tick that produced this assessment. Format is a development-stage decision (tick UUID or `(intent_slug, tick_seq)` tuple). |
| `findings` | array of `DriftFinding` | yes | — | The full set of findings the agent classified in this dispatch. At least one element. |
| `classifications` | array of `Classification` | yes | — | One classification per finding, parallel-indexed (`classifications[i]` corresponds to `findings[i]`). Length must equal `findings.length`. |
| `agent_rationale` | string | yes | — | The agent's prose explanation of why it classified each finding the way it did. At least one non-whitespace character. Surfaced in the SPA drift assessment view. |
| `initiated_by` | string | yes | — | **Required per reconciliation requirement R8 (DEC-9 audit fields).** Agent identity string — the agent or session that submitted the classification. |
| `triggering_request` | string | yes | — | **Required per R8.** Verbatim chat snippet (first 200 chars) or session ID that triggered this assessment dispatch. Provides post-hoc auditability of why the assessment fired. |
| `target_path` | string | yes | — | **Required per R8.** The primary file path targeted by this assessment. For multi-finding assessments, this is the first finding's path; the full list is in `findings`. |
| `resulting_sha` | string | yes | — | **Required per R8.** The SHA of the file after the assessment resolved. For terminal outcomes (`ignore`, `inline-fix`), this is the on-disk SHA at classification time. For non-terminal outcomes, updated at marker-clearance time. |
| `recorded_at` | string (RFC 3339) | yes | — | **Required per R8.** UTC timestamp when the assessment record was committed to disk. May differ from `created_at` by network or I/O latency. |
| `mode` | `"interactive" \| "pickup" \| "autopilot" \| "hybrid"` | yes | — | The invocation mode captured at assessment time. Enables the SPA to render mode-aware context. |
| `confirmed_by_user` | boolean | yes | `false` | True only when the user explicitly confirmed the agent's classification in interactive mode. False in autopilot. False when the user has not acted on a surfaced classification. |
| `revisit_invoked_at` | string (RFC 3339) \| null | yes | `null` | **Required per reconciliation requirement R7.** Set to the UTC timestamp when `haiku_revisit` is called by the workflow engine on the next tick. `null` until that call happens. Drives the SPA's `pending-revisit` vs. `revisit-invoked` UI state distinction. |

**`pending-revisit` vs. `revisit-invoked` state transition (R7):**

The SPA's `pending-revisit` UI state corresponds to an `Assessment` whose
`outcome === "trigger-revisit"` and whose `revisit_invoked_at IS NULL`. The state transitions
to `revisit-invoked` once the next tick calls `haiku_revisit` and writes a non-null timestamp
into `revisit_invoked_at`. This two-step transition is the only mechanism by which the SPA
distinguishes "the agent decided to revisit" from "the revisit actually started."

**Storage reference:** `stages/{stage}/drift-assessments/DA-{NN}.json` inside the intent directory.
One file per assessment dispatch. Append-only; records are never modified after writing. The `NN`
counter increments per assessment within a stage. Cross-stage findings include the `stage_owner`
field from the `DriftFinding` so the SPA can display correct stage attribution.

**Worked example:**

```json
{
  "id": "AS-07",
  "created_at": "2026-04-28T14:35:12Z",
  "tick_id": "tick-2026-04-28T14-35-00Z-7f2",
  "initiated_by": "haiku-agent-session-abc123",
  "triggering_request": "User uploaded a new hero layout via SPA Replace dialog",
  "target_path": "stages/design/artifacts/hero-layout.html",
  "resulting_sha": "ab12cd34ef567890ab12cd34ef567890ab12cd34ef567890ab12cd34ef567890",
  "recorded_at": "2026-04-28T14:35:14Z",
  "findings": [
    {
      "path": "stages/design/artifacts/hero-layout.html",
      "change_kind": "modified",
      "is_binary": false,
      "diff_unified": "@@ -12,3 +12,5 @@\n ...",
      "before_sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "after_sha256": "ab12cd34ef567890ab12cd34ef567890ab12cd34ef567890ab12cd34ef567890",
      "before_bytes": 4821,
      "after_bytes": 5104,
      "tracking_class": "stage-output",
      "stage": "design",
      "context_unit": null
    }
  ],
  "classifications": [
    {
      "path": "stages/design/artifacts/hero-layout.html",
      "outcome": "surface-as-feedback",
      "rationale_excerpt": "Designer replaced nav pattern not in spec — needs unit revision.",
      "linked_feedback_id": "FB-12",
      "linked_revisit_target_stage": null
    }
  ],
  "agent_rationale": "The diff replaces the navigation block with a sidebar variant not specified in the design unit. Surfacing as feedback so the design lead can confirm before we re-elaborate.",
  "mode": "autopilot",
  "confirmed_by_user": false,
  "revisit_invoked_at": null
}
```

---

## 3. Workflow-Action Payload Schemas

### 3.1 `DriftFinding` — emitted by the pre-tick drift-detection gate

This is the per-file payload the gate produces. It is embedded in the
`manual_change_assessment` action (§3.2) and in the `Assessment` record (§2.3).

| Field | Type | Required | Default | Constraints |
|---|---|---|---|---|
| `path` | string | yes | — | Same POSIX-relative shape as `Baseline.path`. |
| `change_kind` | `"added" \| "modified" \| "deleted"` | yes | — | **Canonical enum from §0.1.** No aliases. |
| `is_binary` | boolean | yes | — | True if either the prior baseline was binary or the current file fails the text heuristic. |
| `diff_unified` | string \| null | yes | — | Standard unified diff (3 lines context) for text files. `null` when `is_binary === true`, when `change_kind === "deleted"` and content is unavailable, or when `change_kind === "added"` and file exceeds the large-file threshold (a development-stage decision). For new text files under the threshold, carries the full content as a `+++`-only diff. |
| `before_sha256` | string \| null | yes | — | Baseline SHA. `null` when `change_kind === "added"`. |
| `after_sha256` | string \| null | yes | — | On-disk SHA. `null` when `change_kind === "deleted"`. |
| `before_bytes` | integer \| null | yes | — | Baseline file size. `null` for `"added"`. |
| `after_bytes` | integer \| null | yes | — | On-disk file size. `null` for `"deleted"`. |
| `tracking_class` | `"stage-output" \| "knowledge" \| "unit-output" \| "intent-meta"` | yes | — | Mirrors `Baseline.tracking_class`. |
| `stage` | string \| null | yes | — | Mirrors `Baseline.stage`. |
| `context_unit` | string \| null | yes | — | Unit slug if the file lives under `units/{unit-slug}/`; `null` otherwise. Provides classification context. |

**Cross-field invariants (enforced by the gate before dispatch):**

1. `change_kind === "added"` ⇒ `before_sha256 === null && before_bytes === null`.
2. `change_kind === "deleted"` ⇒ `after_sha256 === null && after_bytes === null && diff_unified === null`.
3. `change_kind === "modified"` ⇒ all four SHA/byte fields non-null AND `before_sha256 !== after_sha256`.
4. `is_binary === true` ⇒ `diff_unified === null`.

**Worked example:**

```json
{
  "path": "stages/design/artifacts/hero-layout.html",
  "change_kind": "modified",
  "is_binary": false,
  "diff_unified": "@@ -10,5 +10,7 @@\n   <nav>\n-    <ul>...</ul>\n+    <aside class=\"sidebar\">...</aside>\n+    <div class=\"overlay\">...</div>\n   </nav>",
  "before_sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "after_sha256": "ab12cd34ef567890ab12cd34ef567890ab12cd34ef567890ab12cd34ef567890",
  "before_bytes": 4821,
  "after_bytes": 5104,
  "tracking_class": "stage-output",
  "stage": "design",
  "context_unit": null
}
```

---

### 3.2 `manual_change_assessment` action payload (workflow engine → agent)

The `haiku_run_next` response dispatched when the pre-tick drift-detection gate has open findings
and no upstream feedback-triage findings are still pending.

| Field | Type | Required | Constraints |
|---|---|---|---|
| `action` | string | yes | Always the literal `"manual_change_assessment"`. Discriminator field. |
| `intent_slug` | string | yes | Active intent identifier. |
| `stage` | string | yes | Active stage at tick time. |
| `tick_id` | string | yes | Same shape as `Assessment.tick_id`. Must be echoed back in `haiku_classify_drift`. |
| `findings` | array of `DriftFinding` | yes | At least one element. The full set of findings the agent must classify. |
| `mode` | `"interactive" \| "pickup" \| "autopilot" \| "hybrid"` | yes | Current invocation mode. |
| `instructions` | string | yes | Agent-facing instructions string built by the orchestrator. Describes the classification taxonomy, tool to call, and any context hints. |
| `legal_outcomes` | object | yes | Map from `findings[i].path` → array of `outcome` strings (§0.3) the agent may legally pick for that finding. Pre-filtered using the legality matrix in §3.4. |

**Worked example (truncated):**

```json
{
  "action": "manual_change_assessment",
  "intent_slug": "out-of-band-human-file-modifications",
  "stage": "design",
  "tick_id": "tick-2026-04-28T14-35-00Z-7f2",
  "findings": [
    { "path": "stages/design/artifacts/hero-layout.html", "change_kind": "modified", "..." }
  ],
  "mode": "autopilot",
  "instructions": "Classify each finding by calling haiku_classify_drift. Review the diff carefully. Use 'inline-fix' for deliberate human improvements, 'surface-as-feedback' for concerns, 'trigger-revisit' for fundamental redirects, 'ignore' for incidental changes.",
  "legal_outcomes": {
    "stages/design/artifacts/hero-layout.html": ["ignore", "inline-fix", "surface-as-feedback", "trigger-revisit"]
  }
}
```

---

### 3.3 `Classification` — one decision per finding (agent → workflow engine)

The shape the agent submits for each finding via `haiku_classify_drift` (§4.3).

| Field | Type | Required | Constraints |
|---|---|---|---|
| `path` | string | yes | Must exactly match a `findings[i].path` from the dispatched action. |
| `outcome` | `"ignore" \| "inline-fix" \| "surface-as-feedback" \| "trigger-revisit"` | yes | **Canonical enum from §0.3.** Must be in the `legal_outcomes[path]` array for this finding. |
| `rationale_excerpt` | string | yes | Per-finding short rationale for the SPA's per-row label. At least one non-whitespace character. The agent's longer prose lives in `Assessment.agent_rationale`. |
| `linked_feedback_id` | string \| null | conditional | **Required when `outcome === "surface-as-feedback"`.** The `FB-NN` of a feedback item created in the same `haiku_classify_drift` call. `null` for all other outcomes. |
| `linked_revisit_target_stage` | string \| null | conditional | **Required when `outcome === "trigger-revisit"`.** A stage slug at or before the active stage. `null` for all other outcomes. |

---

### 3.4 Outcome legality matrix (per `change_kind`)

| `change_kind` \ `outcome` | `ignore` | `inline-fix` | `surface-as-feedback` | `trigger-revisit` |
|---|---|---|---|---|
| `added` | OK | OK | OK | OK |
| `modified` | OK | OK | OK | OK |
| `deleted` | OK | **rejected** | OK | OK |

A `deleted` finding cannot be classified `inline-fix` because there is nothing on disk to extend.
The agent must either re-create the file (which becomes an `added` finding on the next tick) or
pick another outcome. The gate enforces this in `legal_outcomes` before dispatch.

---

### 3.5 Pre-tick gate ordering and `surface-as-feedback` baseline-update contract

**Gate ordering (normative):**

```
tamper-detection → feedback-triage → drift-detection → per-state dispatch
```

Feedback-triage runs before drift-detection because untriaged feedback may trigger
`haiku_feedback_move`, which relocates files and would produce spurious drift events if drift-
detection ran first. The drift gate's findings are independent of feedback state so running second
is always safe.

**`surface-as-feedback` baseline-update contract (reconciliation requirement R6):**

When `Assessment.outcome === "surface-as-feedback"` (specifically: when the `haiku_classify_drift`
tool writes the `Classification` with that outcome), the `Baseline` row for the affected file is
**NOT updated at classification time**. Instead, a `PendingMarker` (§2.2) is written atomically
with the `Assessment` record. The `Assessment` and `PendingMarker` writes are committed together,
or neither is committed (rollback on failure). The `Baseline` is left unchanged.

Re-detection suppression is handled entirely by the `PendingMarker`: while an open marker
(`cleared_at IS NULL`) exists for a file, the drift-detection gate skips that file regardless of
on-disk SHA divergence. The baseline update is deferred until marker clearance (§4.4 —
`haiku_baseline_clear_marker`), which fires when the linked feedback transitions to a terminal
state (`closed` or `rejected`). At that point the baseline is updated to the file's then-current
on-disk SHA — which may differ from the SHA observed at classification time, since the file may
have been edited further while the feedback was open. This is the correct semantic: the workflow
engine acknowledges the resolved end-state, not an intermediate snapshot.

Cross-references that must agree with this contract:
- §0.3 outcome table — `surface-as-feedback` says "baseline deferred"
- §2.3 `Assessment.resulting_sha` — for non-terminal outcomes, updated at marker-clearance time
- §4.3 atomic side-effect ordering, step 6 — pending marker only, no baseline write
- §4.4 `haiku_baseline_clear_marker` — the tool that performs the deferred baseline update
- ARCHITECTURE.md §4.4.3 (design stage upstream) — the originating spec

**Re-detection of subsequent edits while a marker is open:** Suppression is per-file, not per-SHA.
If the human edits the file again while the marker is open, no new drift event fires (the marker
still suppresses). When the marker clears, the baseline is updated to the *then-current* SHA in
one step; any intermediate edits are folded into that single acknowledgment. The pending marker
is the sole suppression mechanism — there is no separate "expected SHA" tracked while the marker
is open.

---

## 4. MCP Tool Contracts

This section specifies the interface shapes for the four new MCP tools. Tool names match
`MCP-TOOL-CONTRACT.md` exactly and are finalized; the development stage does not rename them.

### 4.1 `haiku_human_write` — agent writes on behalf of human

**Purpose:** When a user instructs the agent in chat to write a file, the agent uses this tool
instead of `Write`. The write is attributed as `author_class: "human-via-mcp"` in the action log.
The baseline is **not** updated directly — the next tick's drift gate observes the SHA divergence,
emits a `DriftFinding` with `author_class: "human-via-mcp"`, and dispatches
`manual_change_assessment` to classify the write. This unified path applies to all three write
channels: filesystem drop, SPA upload, and `haiku_human_write`.

**Note:** The tool writes an audit log entry to `write-audit.jsonl` (append-only JSONL, one record
per invocation) recording: `timestamp`, `entry_id`, `path`, `sha256`, `author_class: "human-via-mcp"`,
`human_author_id`, `rationale`, `user_instruction_excerpt` (first 200 chars), `tick_counter`,
`session_id`, `overwrite`, `dirs_created`.

**Request:**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `path` | string | yes | Intent-relative or absolute (resolved to intent-relative). Must fall within the tracked surface allow-list (§5 of `MCP-TOOL-CONTRACT.md`). |
| `content` | string | yes | UTF-8 string or base64-encoded binary (when `content_encoding: "base64"`). |
| `content_encoding` | `"utf-8" \| "base64"` | no | Default: `"utf-8"`. |
| `human_author_id` | string | no | Human user's identifier. Captured in audit log. Self-reported; not validated. |
| `rationale` | string | no | Short free-text explanation of why the human requested the write. Captured in audit log and surfaced in the next tick's `manual_change_assessment` payload. |
| `overwrite` | boolean | no | Default: `true`. Pass `false` for create-only semantics. |
| `create_dirs` | boolean | no | Default: `true`. Creates intermediate directories if needed. |

**Response (success):**

```json
{
  "ok": true,
  "path": "knowledge/brand-guide.md",
  "sha": "a3f7c82e1d4b9f0517e6c2a84b3d5e9f1c7a2b4d6e8f0a2c4e6b8d0f2a4c6e8",
  "author_class": "human-via-mcp",
  "timestamp": "2026-04-28T15:42:07.123Z",
  "human_author_id": "jwaldrip@gigsmart.com",
  "dirs_created": [],
  "action_log_entry_id": "HWM-42-01",
  "audit_log_appended": true
}
```

**Error responses:**

| `error` (code) | HTTP-equivalent | When |
|---|---|---|
| `path_outside_tracked_surface` | 400/403 | Path escapes intent directory, matches deny-list (units, feedback, intent.md, state.json, baseline.json, drift-markers.json, write-audit.jsonl), or matches no allow-list pattern. Includes `reason` sub-field: `deny_list_match` / `no_allow_match` / `path_escape` / `invalid_stage`. |
| `rationale_required` | 400 | `human_write_require_rationale` plugin setting is `true` and `rationale` was absent. |
| `baseline_conflict` | 409 | A concurrent workflow tick updated the baseline for this path between validation and write. Transient — retry. |
| `path_already_exists` | 409 | `overwrite: false` and destination file already exists. Includes `existing_sha`. |
| `parent_dir_missing` | 400 | `create_dirs: false` and parent directory does not exist. |
| `invalid_content_encoding` | 400 | `content_encoding` is not `"utf-8"` or `"base64"`. |

**Error envelope:**
```json
{ "ok": false, "error": "path_outside_tracked_surface", "message": "Cannot write to 'stages/design/units/unit-02.md': unit files are workflow-managed.", "reason": "deny_list_match", "deny_rule": "stages/{stage}/units/*.md" }
```

---

### 4.2 `haiku_baseline_init` — bootstrap on upgrade

**Purpose:** First-tick baseline establishment without firing drift events. The drift-detection
gate runs this internally on any tick where `drift_baseline_established_at` is absent for a stage.
This tool is exposed for operator use (e.g., `haiku_repair` scenarios). Subsequent calls are no-ops
for already-baselined files.

**Request:**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `intent_slug` | string | yes | Active intent identifier. |
| `mode` | `"establish-all" \| "establish-paths"` | yes | `establish-all`: scan the full tracked surface; `establish-paths`: baseline only the listed paths. |
| `paths` | array of string | conditional | Required when `mode === "establish-paths"`. Intent-relative POSIX paths. |

**Response (success):**

```json
{
  "ok": true,
  "intent_slug": "out-of-band-human-file-modifications",
  "baselines_created": 47,
  "baselines_skipped_existing": 3,
  "tracking_classes": {
    "stage-output": 18,
    "knowledge": 12,
    "unit-output": 17,
    "intent-meta": 0
  },
  "drift_baseline_established_at": "2026-04-28T14:32:00Z"
}
```

**Error responses:**

| `error` | HTTP-equivalent | When |
|---|---|---|
| `intent_not_found` | 404 | `intent_slug` does not match any intent on disk. |
| `intent_not_active` | 409 | The slug exists but the intent is archived. |
| `tracked_surface_empty` | 200 (with `ok: true, warning: "tracked_surface_empty"`) | No files found in the tracked surface. Not an error — caller may want to know. |

**Worked example — `establish-paths` mode:**

```json
{
  "intent_slug": "out-of-band-human-file-modifications",
  "mode": "establish-paths",
  "paths": [
    "stages/design/artifacts/hero-layout.html",
    "knowledge/brand-guide.md"
  ]
}
```

---

### 4.3 `haiku_classify_drift` — submit classifications for a `manual_change_assessment` dispatch

**Purpose:** The agent's response to a `manual_change_assessment` action. Submits one
`Classification` per dispatched `DriftFinding`. Applies all side effects atomically.

**Request:**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `intent_slug` | string | yes | Active intent. |
| `tick_id` | string | yes | Must match the `tick_id` from the dispatched `manual_change_assessment` action. Stale tick IDs are rejected. |
| `classifications` | array of `Classification` | yes | One per dispatched finding, parallel-indexed. |
| `agent_rationale` | string | yes | The longer prose explanation. At least one non-whitespace character. |
| `feedback_creates` | array of `FeedbackCreateInline` | conditional | Required if any `classification.outcome === "surface-as-feedback"` and `linked_feedback_id` is not yet set. The tool atomically creates the feedback items and links them. |

**`FeedbackCreateInline` shape:**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `for_classification_path` | string | yes | The `path` of the `Classification` this feedback links to. |
| `title` | string | yes | Same constraints as existing `haiku_feedback` title field. |
| `body` | string | yes | Same constraints as existing `haiku_feedback` body field. |
| `origin` | string | yes | Must be `"agent"`. Other origins are rejected. |
| `resolution` | string \| null | no | `"question" \| "inline_fix" \| "stage_revisit" \| null`. Defaults to `"stage_revisit"`. |

**Atomic side-effect ordering (all-or-rollback):**

1. Write feedback files (from `feedback_creates`, if any).
2. Resolve `linked_feedback_id` for any classifications that omitted it.
3. Validate every classification against `legal_outcomes` for the dispatched tick.
4. Write the `Assessment` record (§2.3) including all DEC-9 audit fields.
5. For terminal outcomes (`ignore`, `inline-fix`): update `Baseline` to current on-disk SHA
   with `author_class` carried from the finding; set `acknowledged_via: "classification-terminal"`.
6. For `surface-as-feedback`: write a `PendingMarker` (§2.2) atomically with the `Assessment`
   record. The `Baseline` is **not** updated at classification time per R6 contract (§3.5);
   the deferred baseline update happens on marker clearance via `haiku_baseline_clear_marker`
   (§4.4) when the linked feedback transitions to `closed` or `rejected`.
7. For `trigger-revisit`: write a `PendingMarker` atomically with the `Assessment` record.
   `Baseline` is **not** updated at classification time — updated on revisit completion via
   `haiku_baseline_clear_marker`, per §5.4 of ARCHITECTURE.md.
8. Return the response.

**Response (success):**

```json
{
  "ok": true,
  "assessment_id": "AS-07",
  "feedback_created": ["FB-12"],
  "pending_markers_created": 1,
  "baselines_updated": 0,
  "next_tick_will": "dispatch_review_fix_for_FB-12"
}
```

*Note: `baselines_updated` is 0 here because `surface-as-feedback` defers the baseline update to
marker clearance (§3.5 R6, §4.4). The count reflects only baselines updated by this call —
terminal outcomes (`ignore`, `inline-fix`) and `haiku_baseline_clear_marker` invocations are the
only paths that increment it.*

**Error responses:**

| `error` | When |
|---|---|
| `tick_id_stale` | `tick_id` does not match the active drift dispatch (gate may have re-fired). |
| `classifications_count_mismatch` | `classifications.length !== findings.length` for the dispatched tick. |
| `illegal_outcome` | A classification has an outcome not in `legal_outcomes[path]`. |
| `missing_link` | `outcome === "surface-as-feedback"` but `linked_feedback_id` is null and no matching `feedback_creates` entry exists. |
| `path_unknown` | A classification's `path` is not in the dispatched findings. |
| `revisit_target_invalid` | `linked_revisit_target_stage` is not at-or-before the active stage. |

**Worked example — single finding classified as `surface-as-feedback`:**

```json
{
  "intent_slug": "out-of-band-human-file-modifications",
  "tick_id": "tick-2026-04-28T14-35-00Z-7f2",
  "classifications": [
    {
      "path": "stages/design/artifacts/hero-layout.html",
      "outcome": "surface-as-feedback",
      "rationale_excerpt": "Designer replaced nav pattern not in spec — needs unit revision.",
      "linked_feedback_id": null,
      "linked_revisit_target_stage": null
    }
  ],
  "agent_rationale": "The diff replaces the navigation block with a sidebar variant not specified in the design unit. Surfacing as feedback so the design lead can confirm before we re-elaborate.",
  "feedback_creates": [
    {
      "for_classification_path": "stages/design/artifacts/hero-layout.html",
      "title": "Hero layout replaced with unspecified sidebar pattern",
      "body": "Designer replaced `<ul>` nav with a sidebar pattern not in the unit spec. The diff shows the full navigation block rewritten. Please confirm this is the intended direction before development extends this artifact.",
      "origin": "agent",
      "resolution": "stage_revisit"
    }
  ]
}
```

---

### 4.4 `haiku_baseline_clear_marker` — clear a pending marker when downstream action resolves

**Purpose:** Invoked by the workflow engine (not the agent directly) when:
- A feedback item linked to a `surface-as-feedback` marker transitions to `addressed` state, OR
- A revisit linked to a `trigger-revisit` marker completes.

**Reconciliation requirement R5 — trigger contract:**
The tool fires when feedback transitions to `addressed` (a mid-lifecycle state, not just `closed`).
A pending marker is cleared as soon as the human fix lands — not when the human formally closes
the feedback. This ensures the drift gate does not continue suppressing re-detection for the same
file while the fix is in place but the feedback is still formally "open."

**Reconciliation requirement R5 — scope:**
This tool clears the `PendingMarker` for a **single tracked file path** per invocation. It is not
a batch-clear operation. Multiple markers (one per file) require multiple invocations.

**Request:**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `intent_slug` | string | yes | Active intent. |
| `path` | string | yes | The `PendingMarker.path` to clear. Clears the newest open marker for this path (max `created_at` with `cleared_at IS NULL`). |
| `trigger` | `"feedback-addressed" \| "feedback-closed" \| "feedback-rejected" \| "revisit-complete"` | yes | The event that caused the clearance. `"feedback-addressed"` is the primary trigger for `surface-as-feedback` markers (fires before `feedback-closed`). `"feedback-closed"` and `"feedback-rejected"` are fallback triggers if the marker was not cleared at `addressed` transition. |

**Response (success):**

```json
{ "ok": true, "marker_cleared": true, "baseline_updated": true, "path": "stages/design/artifacts/hero-layout.html" }
```

**Response (no open marker):**

```json
{ "ok": true, "marker_cleared": false, "reason": "no_open_marker", "path": "stages/design/artifacts/hero-layout.html" }
```

**Error responses:**

| `error` | When |
|---|---|
| `intent_not_found` | `intent_slug` unknown. |
| `path_not_in_tracked_surface` | `path` is not a known tracked-surface path for this intent. |

---

## 5. HTTP API Surface

The browse SPA communicates with the workflow engine over HTTP. Four endpoints support upload
affordances and the drift assessment view. Which process hosts these endpoints (current review-
server vs. a new MCP-app server) is a development-stage decision; the endpoint shapes are stable
regardless of host.

**Authentication:** All endpoints use session cookie authentication from the existing review-server
auth flow (same pattern as `/api/feedback`).

---

### 5.1 `POST /api/intents/{intent-slug}/uploads/stage-output`

Replace or attach a file in a stage's artifacts directory.

**Request (multipart/form-data):**

| Form field | Type | Required | Constraints |
|---|---|---|---|
| `stage` | string | yes | Stage slug. Must be a valid stage for the intent. |
| `target_path` | string | yes | Path **relative to the stage artifacts directory** (e.g., `artifacts/hero-layout.html`). Full intent-relative path is `stages/{stage}/{target_path}`. Escapes rejected. |
| `file` | file | yes | The uploaded content. Max 50 MB (operator-configurable). |
| `mode` | `"replace" \| "create" \| "upsert"` | yes | `replace`: target must exist. `create`: target must NOT exist. `upsert`: either. |
| `attribute_to_user` | string | yes | Authenticated user's display name. Written to audit log and to baseline provenance. |

**Response (200):**

```json
{
  "ok": true,
  "path": "stages/design/artifacts/hero-layout.html",
  "sha256": "ab12cd34ef567890ab12cd34ef567890ab12cd34ef567890ab12cd34ef567890",
  "bytes": 5104,
  "baseline_updated": false,
  "tick_will_observe": true
}
```

Note: `baseline_updated: false` because SPA uploads do NOT update `baseline.json` directly. The
next tick's drift gate observes the SHA divergence and dispatches `manual_change_assessment`.
`tick_will_observe: true` is the confirmation to the SPA that assessment will fire on the next tick.

**Error table:**

| HTTP | `error` | When |
|---|---|---|
| 400 | `bad_target_path` | `target_path` escapes the stage artifacts directory or contains `..`. |
| 400 | `mode_violation` | `mode === "replace"` but file does not exist, or `mode === "create"` but file already exists. |
| 401 | `unauthorized` | Session cookie absent or expired. |
| 403 | `stage_not_writable` | Stage's artifacts are sealed (completed and merged). |
| 404 | `intent_not_found` | `{intent-slug}` unknown. |
| 409 | `intent_locked` | Intent in a state that disallows uploads. |
| 413 | `payload_too_large` | File exceeds the configured size cap. |
| 415 | `unsupported_mime` | MIME type explicitly rejected (default: allow all). |
| 500 | `write_failed` | Disk write or action-log stamp failed. Baseline is NOT updated. |

**Error envelope:**
```json
{ "ok": false, "error": "stage_not_writable", "message": "Stage 'design' outputs are sealed — the stage has completed and its branch is merged." }
```

---

### 5.2 `POST /api/intents/{intent-slug}/uploads/knowledge`

Add a file to the intent's knowledge directory.

**Request (multipart/form-data):**

| Form field | Type | Required | Constraints |
|---|---|---|---|
| `file` | file | yes | The uploaded content. Max 50 MB. |
| `target_filename` | string | yes | Basename only; no path separators. Lands at `knowledge/{target_filename}` (intent-scope) or `stages/{stage}/knowledge/{target_filename}` (stage-scope). |
| `stage` | string \| null | conditional | Required when knowledge is per-stage; `null` for intent-scope. |
| `description` | string | no | Free-form note attached to the upload audit record. |
| `attribute_to_user` | string | yes | Authenticated user's display name. |

**Response:** Same shape as §5.1.

**Error table:** All errors from §5.1, plus:

| HTTP | `error` | When |
|---|---|---|
| 400 | `bad_target_filename` | `target_filename` contains path separators or invalid characters. |
| 409 | `filename_collision` | `target_filename` already exists at the target scope. The SPA should prompt the user to rename or confirm overwrite before retrying. |

**Worked example request body (multipart):**
```
--boundary
Content-Disposition: form-data; name="target_filename"
brand-guide-v2.pdf
--boundary
Content-Disposition: form-data; name="stage"
(empty — intent-scope upload)
--boundary
Content-Disposition: form-data; name="attribute_to_user"
jwaldrip
--boundary
Content-Disposition: form-data; name="file"; filename="brand-guide-v2.pdf"
Content-Type: application/pdf
[binary content]
--boundary--
```

---

### 5.3 `GET /api/intents/{intent-slug}/assessments`

List drift assessments for the SPA's drift assessment view.

**Query parameters:**

| Param | Type | Required | Default | Constraints |
|---|---|---|---|---|
| `limit` | integer | no | 50 | Max 200. |
| `since` | string (RFC 3339) | no | — | Only assessments with `created_at > since`. |
| `stage` | string | no | — | Filter by `findings[*].stage`. |
| `outcome` | `"ignore" \| "inline-fix" \| "surface-as-feedback" \| "trigger-revisit"` | no | — | Filter by classification outcome (§0.3). |

**Response (200):**

```json
{
  "ok": true,
  "assessments": [
    {
      "id": "AS-07",
      "created_at": "2026-04-28T14:35:12Z",
      "stage": "design",
      "findings_count": 1,
      "outcomes_summary": { "inline-fix": 0, "ignore": 0, "surface-as-feedback": 1, "trigger-revisit": 0 },
      "mode": "autopilot"
    }
  ],
  "total": 1,
  "has_more": false
}
```

**Error table:**

| HTTP | `error` | When |
|---|---|---|
| 400 | `bad_param` | A query parameter has an invalid format (e.g. malformed RFC 3339, invalid outcome value). |
| 401 | `unauthorized` | Session cookie absent or expired. |
| 404 | `intent_not_found` | `{intent-slug}` unknown. |

---

### 5.4 `GET /api/intents/{intent-slug}/assessments/{assessment-id}`

Fetch a single assessment for drill-in view.

**Path params:**

| Param | Type | Constraints |
|---|---|---|
| `intent-slug` | string | Active intent identifier. |
| `assessment-id` | string | `AS-NN` format. |

**Response (200):**

```json
{
  "ok": true,
  "assessment": { /* Full Assessment object as defined in §2.3 */ }
}
```

**Error table:**

| HTTP | `error` | When |
|---|---|---|
| 401 | `unauthorized` | Session cookie absent or expired. |
| 404 | `intent_not_found` | `{intent-slug}` unknown. |
| 404 | `assessment_not_found` | `{assessment-id}` does not exist for this intent. |

---

## 6. Internal Events

The workflow engine emits these events to the append-only structured log channel shared with
existing events (`feedback_triage_completed`, `unit_advanced`, etc.). Events are never modified
after writing. Consumers must treat them as immutable.

### 6.1 `drift_detected`

**Emitted by:** The drift-detection gate in the pre-tick pipeline, once per drift event (once per
diverging file per tick).

**Producer:** Workflow engine (drift-detection gate internal).

**Consumers:**
- Orchestrator — uses payload to construct the `manual_change_assessment` action.
- Telemetry / log sink.
- Future: SPA live-update WebSocket channel for real-time drift badges (out of scope for v1).

**Payload:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `event_type` | string | yes | Always `"drift_detected"`. |
| `event_at` | string (RFC 3339) | yes | UTC. |
| `intent_slug` | string | yes | Active intent. |
| `stage` | string | yes | Active stage at tick time. |
| `tick_id` | string | yes | Same shape as `Assessment.tick_id`. |
| `file_path` | string | yes | The specific file that drifted. Intent-relative POSIX path. |
| `change_kind` | `"added" \| "modified" \| "deleted"` | yes | **Canonical enum from §0.1.** |
| `author_class` | `"agent" \| "human-via-mcp" \| "human-implicit" \| null` | yes | The author class from the baseline entry. `null` for `"added"` events where no baseline entry exists. |
| `is_binary` | boolean | yes | Binary-file signal. |

**Note:** SHA values and diff payloads are NOT written to the event — those are in the assessment
record (`drift-assessments/DA-NN.json`). Telemetry events are for rate-monitoring, not diff review.

**Worked example:**

```json
{
  "event_type": "drift_detected",
  "event_at": "2026-04-28T14:35:00Z",
  "intent_slug": "out-of-band-human-file-modifications",
  "stage": "design",
  "tick_id": "tick-2026-04-28T14-35-00Z-7f2",
  "file_path": "stages/design/artifacts/hero-layout.html",
  "change_kind": "modified",
  "author_class": "human-implicit",
  "is_binary": false
}
```

---

### 6.2 `assessment_recorded`

**Emitted by:** `haiku_classify_drift` MCP tool handler, once per `manual_change_assessment`
dispatch (one event per classification batch, not one per finding).

**Producer:** `haiku_classify_drift` tool handler.

**Consumers:**
- Orchestrator — decides next-tick action (fix loop, revisit, etc.).
- Telemetry.
- SPA drift assessment view (polls `/api/intents/{slug}/assessments` after observing this event).

**Payload:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `event_type` | string | yes | Always `"assessment_recorded"`. |
| `event_at` | string (RFC 3339) | yes | UTC. |
| `intent_slug` | string | yes | Active intent. |
| `assessment_id` | string | yes | `"AS-NN"`. |
| `stage` | string | yes | Active stage. |
| `tick_id` | string | yes | The tick that triggered the assessment. |
| `outcomes_count` | object | yes | `{ "ignore": N, "inline-fix": N, "surface-as-feedback": N, "trigger-revisit": N }`. Uses canonical enum values from §0.3. |
| `feedback_ids_created` | array of string | yes | `["FB-12", ...]`. May be empty. |
| `baselines_updated` | integer | yes | Count of `Baseline` rows updated in this submission. |
| `pending_markers_created` | integer | yes | Count of new `PendingMarker` rows written. |
| `mode` | string | yes | Mirrors `Assessment.mode`. |

**Worked example:**

```json
{
  "event_type": "assessment_recorded",
  "event_at": "2026-04-28T14:35:14Z",
  "intent_slug": "out-of-band-human-file-modifications",
  "assessment_id": "AS-07",
  "stage": "design",
  "tick_id": "tick-2026-04-28T14-35-00Z-7f2",
  "outcomes_count": { "ignore": 0, "inline-fix": 0, "surface-as-feedback": 1, "trigger-revisit": 0 },
  "feedback_ids_created": ["FB-12"],
  "baselines_updated": 1,
  "pending_markers_created": 1,
  "mode": "autopilot"
}
```

---

### 6.3 `pending_marker_cleared`

**Emitted by:** `haiku_baseline_clear_marker` (the workflow engine's internal lifecycle handler).

**Producer:** Workflow engine.

**Consumers:**
- Orchestrator — updates downstream tick state.
- Telemetry.
- SPA — refreshes the corresponding assessment row's status pill from `pending` to `resolved`.

**Payload:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `event_type` | string | yes | Always `"pending_marker_cleared"`. |
| `event_at` | string (RFC 3339) | yes | UTC. |
| `intent_slug` | string | yes | Active intent. |
| `path` | string | yes | The marker's `path` (same as `PendingMarker.path`). |
| `assessment_id` | string | yes | The originating `Assessment.id`. |
| `trigger` | `"feedback-addressed" \| "feedback-closed" \| "feedback-rejected" \| "revisit-complete"` | yes | The event that caused the clearance. Mirrors `haiku_baseline_clear_marker.trigger`. |
| `linked_feedback_id` | string \| null | yes | The `PendingMarker.linked_feedback_id`. |
| `linked_revisit_target_stage` | string \| null | yes | The `PendingMarker.linked_revisit_target_stage`. |

**Worked example:**

```json
{
  "event_type": "pending_marker_cleared",
  "event_at": "2026-04-29T10:14:33Z",
  "intent_slug": "out-of-band-human-file-modifications",
  "path": "stages/design/artifacts/hero-layout.html",
  "assessment_id": "AS-07",
  "trigger": "feedback-addressed",
  "linked_feedback_id": "FB-12",
  "linked_revisit_target_stage": null
}
```

---

## 7. Cross-Surface Naming Audit

Every entity below must appear with the same name across all five surfaces. Any variance is a
reconciliation failure. The single intentional exception is documented with its conversion rule.

| Entity | On disk (§2) | In action payload (§3) | In MCP tool (§4) | In HTTP API (§5) | In events (§6) |
|---|---|---|---|---|---|
| Intent identifier | `intent_slug` | `intent_slug` | `intent_slug` | `{intent-slug}` (URL) / `intent_slug` (body) | `intent_slug` |
| Tracked file path | `path` (baseline key) | `path` (DriftFinding field) | `path` (request + response) | `path` (response) / `target_path` (upload request — intentional; see note below) | `file_path` (events) |
| `change_kind` enum | — | `change_kind` | — | — | `change_kind` |
| `author_class` enum | `author_class` (Baseline) | `author_class` (DriftFinding) | `author_class` (response) | — | `author_class` |
| `outcome` enum | `outcome` (Classification/Assessment) | `outcome` (Classification) | `outcome` (Classification request) | `outcome` (query param) | `outcomes_count` keys |
| Assessment ID | `id` (Assessment) | — | `assessment_id` (response) | `{assessment-id}` (URL) / `assessment_id` (list response) | `assessment_id` |
| Feedback ID | `linked_feedback_id` (PendingMarker, Classification, Assessment) | `linked_feedback_id` (Classification) | `linked_feedback_id` + `feedback_created` (response) | — | `feedback_ids_created` (assessment_recorded), `linked_feedback_id` (marker_cleared) |
| Stage | `stage` (Baseline, Assessment) | `stage` (action payload) | — (implicit in `path`) | `stage` (form field + query param) | `stage` |
| Tick identifier | `tick_id` (Assessment) | `tick_id` (action payload) | `tick_id` (request + assessment response) | — | `tick_id` |
| Pending marker path | `path` (PendingMarker) | — | `path` (haiku_baseline_clear_marker request) | — | `path` (pending_marker_cleared) |

**Intentional naming variance — `path` vs. `target_path` in HTTP upload requests:**

HTTP upload request bodies use `target_path` (stage-relative path, e.g. `artifacts/hero-layout.html`)
where all other surfaces use `path` (intent-relative, e.g. `stages/design/artifacts/hero-layout.html`).
This is the only naming variance, and it is intentional: SPA upload requests are always scoped to a
single stage, so the `stage` form field provides the prefix. The conversion rule is:

```
intent_relative_path = "stages/" + stage + "/" + target_path
```

The HTTP response body uses `path` (intent-relative), consistent with all other surfaces.

---

## 8. Boundary Notes (deferred to development stage)

The following decisions are NOT owned by this product-stage document. They are named here so
development has the framing.

- **Tracked-surface boundary specifics** — which exact paths the gate scans is documented in
  `stages/design/artifacts/TRACKED-SURFACE-BOUNDARY.md`. The product-stage contract is surface-
  agnostic with respect to path enumeration details.
- **Baseline storage format / location** — on-disk specifics (JSON file at `stages/{stage}/baseline.json`)
  are documented in `stages/design/artifacts/ARCHITECTURE.md` §2.2. This document specifies the
  field-level shape; storage location is the architecture artifact's domain.
- **Tick ID format** — UUID, monotonic counter, or `(intent, seq)` tuple. Owned by ARCHITECTURE.md.
- **Diff cap for `added` events** — the threshold above which `diff_unified` is `null` for new files.
  Owned by development.
- **SPA upload host process** — which server exposes the HTTP endpoints (§5). Owned by development.
- **`haiku_baseline_clear_marker` exposure level** — whether this tool is MCP-callable by the agent
  or is workflow-engine-internal-only. Owned by development.
- **Knowledge upload scope** — intent-scope vs. per-stage for the `POST /uploads/knowledge` endpoint
  is partially deferred (the endpoint supports both via the `stage` field, but the SPA's default is
  a development decision).

None of these affect the field-level shapes above. They affect where data lives and how it is
computed, not what it looks like at the boundary.

---

*Document version: product-stage-final. Supersedes `knowledge/DATA-CONTRACTS.md`.*
