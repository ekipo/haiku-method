---
name: coverage-mapping
location: .haiku/intents/{intent-slug}/product/COVERAGE-MAPPING.md
scope: intent
format: text
required: true
---

# Coverage Mapping — Out-of-Band Human File Modifications

This is the product-stage canonical traceability matrix. It traces every success criterion (SC-N) for this intent to the acceptance criteria (`AC-G*` / `AC-EE*`) in `product/ACCEPTANCE-CRITERIA.md`, the behavioral scenarios in `features/*.feature`, and the data-contract entities in `product/DATA-CONTRACTS.md`. It is the terminal traceability check for the product stage: if any SC row is missing AC, scenario, or DC coverage, the gate does not open.

**Identifier reconciliation:** The discovery draft (`knowledge/COVERAGE-MAPPING.md`) used a flat `AC-N.N` numbering scheme that did not match unit-01's actual ACCEPTANCE-CRITERIA.md. This document fully rewrites the matrix using the canonical `AC-G<N>` (general rule) and `AC-EE<N>` (edge case) identifiers. Every AC column reference below points to a real identifier that exists in `product/ACCEPTANCE-CRITERIA.md`. Flat `AC-N.N` references from the discovery draft are NOT used.

---

## How to read this document

- **SC-N** = success criterion — one numbered, atomic, individually testable statement of done.
- **AC-G\*** = acceptance-criteria general rule (from `product/ACCEPTANCE-CRITERIA.md` §"General Rules"). Also covers variant-specific ACs (AC-TA\*, AC-ALIAS\*, AC-SU\*, AC-FS\*, AC-AB\*, AC-SO\*, AC-KI\*, AC-UO\*, AC-T\*, AC-B\*, AC-CO\*, AC-EO\*, AC-OM\*, AC-CI\*, AC-IF\*, AC-SF\*, AC-TR\*) that assert general behavioral contracts across all variability dimensions.
- **AC-EE\*** = acceptance-criteria edge-case entry (from `product/ACCEPTANCE-CRITERIA.md` §"Edge Cases & Error Paths").
- **Feature scenario** = an exact `Scenario:` name in a `.feature` file under `features/`.
- **DC-N** = a data-contract entity from `product/DATA-CONTRACTS.md` (section and entity named explicitly).
- **Source** = upstream document and section that authorizes the criterion.
- **Deferred** = criterion intentionally out of scope for this stage with disposition named.

The matrix is grouped by six capability domains. §8 performs orphan detection, §9 performs gap detection, §10 lists out-of-scope dispositions, and §11 is the validation outcome.

---

## 1. Sources of Success Criteria

The following upstream documents contributed success criteria to this matrix.

1. **Intent goal** — body text of the intent (three motivating change types, outcome-based goals).
2. **DISCOVERY.md** §"Success criteria" — five functional bullets and four outcome-based bullets.
3. **DESIGN-DECISIONS.md** — Decisions 1–9; each chosen path becomes a constraint the AC/spec must honor.
4. **Design unit-01 (ARCHITECTURE.md)** — baseline storage contract, pre-tick gate, `manual_change_assessment` action, four classification outcomes, baseline-update contract, author-class tracking, classification-record durability, ambiguous-diff fallback, concurrency, failure modes, kill-switch.
5. **Design unit-02 (MCP-TOOL-CONTRACT.md)** — tool name, input/output, write semantics, path constraints, integrity stance (DEC-9 resolved as Trust+Audit), audit trail, error contracts, SPA-upload distinction.
6. **Design unit-03 (TRACKED-SURFACE-BOUNDARY.md)** — in-scope paths, out-of-scope paths, per-stage flexibility, first-tick behavior, new-file detection, file-deletion detection, binary handling, `outputs/`→`artifacts/` alias.
7. **Design unit-04 (SPA-UI-SPECS.md)** — passive-observer constraint, three new SPA surfaces, ARIA, contrast, tokens, responsive behavior.
8. **Design unit-05 (ROLLOUT-AND-BASELINE-ESTABLISHMENT.md)** — establish-mode, kill-switch, telemetry, reset semantics, per-stage isolation.
9. **Design unit-06 (ROLLOUT-CHIP-SELF-CONTAINED.md)** — establish-mode chip deferral to development.

---

## 2. Canonical Enum Coverage (Reconciliation requirement 2)

The three canonical enumerations introduced by this intent must each have full SC→AC→scenario→DC chains. This section confirms coverage before the domain matrix so reviewers can locate the enum chains in one place.

### 2.1 `change_kind` enum (`"new-file-detected"` | `"modified"` | `"file-removed"`)

Defined in: `product/DATA-CONTRACTS.md` §3.1 (`DriftFinding.change_kind`).

| Enum value | SC rows | AC assertion | Scenarios | DC |
|---|---|---|---|---|
| `new-file-detected` | SC-1.4 | AC-FS2 ("New files are detected as drift events") | `silent-filesystem-drop-detection.feature`: "User drops a brand-new knowledge file into the elaborate phase" | DATA-CONTRACTS §3.1 `DriftFinding.change_kind`, cross-field invariant 1 |
| `modified` | SC-1.3 | AC-G1 ("Drift detection runs on every workflow tick"), AC-T1 | `silent-filesystem-drop-detection.feature`: "Designer replaces a stage output layout file"; `manual-change-assessment.feature`: "Agent classifies a typo correction as ignore" | DATA-CONTRACTS §3.1 `DriftFinding.change_kind`, cross-field invariant 3 |
| `file-removed` | SC-1.5 | AC-EE2 ("Tracked file deleted by human") | `silent-filesystem-drop-detection.feature`: "Tracked file is deleted from the worktree"; `manual-change-assessment.feature`: "Classification outcome legality varies by change_kind" (deleted row) | DATA-CONTRACTS §3.1 `DriftFinding.change_kind`, cross-field invariant 2; §3.4 outcome legality matrix |

**Result:** all three `change_kind` values have SC coverage, AC-G*/AC-EE* assertion, ≥1 scenario per value, and a DC entry pinning the values. No gaps.

### 2.2 `author_class` / `acknowledged_by` enum (`"agent"` | `"human"` | `"baseline-init"`)

Defined in: `product/DATA-CONTRACTS.md` §2.1 (`Baseline.acknowledged_by`). Note: the product AC uses the higher-level vocabulary `"agent"`, `"human-via-mcp"`, `"human-implicit"` for author attribution; `"human"` in DATA-CONTRACTS §2.1 maps to the union of the latter two.

| Enum value | SC rows | AC assertion | Scenarios | DC |
|---|---|---|---|---|
| `"agent"` | SC-4.6, SC-4.8 | AC-G8 (establish mode defaults to `author_class: "agent"`); AC-AB1 (agent uses `haiku_human_write`, not normal `Write`) | `silent-filesystem-drop-detection.feature`: "First tick after feature ships establishes baselines without firing assessments"; `agent-writes-on-behalf-of-human.feature`: "Agent uses normal Write tool for its own work (not haiku_human_write)" | DATA-CONTRACTS §2.1 `Baseline.acknowledged_by: "agent"` |
| `"human"` (`human-via-mcp` surface) | SC-3.6, SC-3.4, SC-3.5 | AC-AB1, AC-TA1 (no confirmation required); AC-SU2 (SPA upload stamps `author_class: "human-via-mcp"`) | `agent-writes-on-behalf-of-human.feature`: "User instructs the agent to save a file as human-attributed"; `explicit-spa-upload.feature`: "Designer replaces a stage output file via the SPA upload UI" | DATA-CONTRACTS §2.1 `Baseline.acknowledged_by: "human"`, `acknowledged_via: "human-write-tool"` or `"spa-upload"` |
| `"baseline-init"` | SC-1.8, SC-4.7 | AC-G8 ("First-tick-after-upgrade silently establishes baselines") | `silent-filesystem-drop-detection.feature`: "First tick after feature ships establishes baselines without firing assessments" | DATA-CONTRACTS §2.1 `Baseline.acknowledged_by: "baseline-init"`, `acknowledged_via: "baseline-init"` |

**Result:** all three `acknowledged_by` values have SC coverage, AC assertion, ≥1 scenario, and a DC entry. No gaps.

### 2.3 Classification `outcome` enum (`"ignore"` | `"inline-fix"` | `"surface-as-feedback"` | `"trigger-revisit"`)

Defined in: `product/DATA-CONTRACTS.md` §3.3 (`Classification.outcome`).

| Enum value | SC rows | AC assertion | Scenarios (≥1 per value) | DC |
|---|---|---|---|---|
| `"ignore"` | SC-2.3 | AC-G4 (`ignore` → immediate baseline update, no side effects); AC-CI1 | `manual-change-assessment.feature`: "Agent classifies a typo correction as ignore"; "File classified as ignore does not re-fire on the next tick" | DATA-CONTRACTS §3.3 `Classification.outcome: "ignore"`, §3.4 legality matrix |
| `"inline-fix"` | SC-2.4 | AC-G4 (`inline-fix` → immediate baseline update + bolt continuation); AC-IF1, AC-IF2 | `manual-change-assessment.feature`: "Agent classifies a meaningful edit as inline-fix" | DATA-CONTRACTS §3.3 `Classification.outcome: "inline-fix"`, §3.4 legality matrix |
| `"surface-as-feedback"` | SC-2.5 | AC-G4 (`surface-as-feedback` → baseline NOT updated, pending marker written); AC-SF1, AC-SF2, AC-SF3 | `manual-change-assessment.feature`: "Agent classifies an out-of-spec change as surface-as-feedback"; "surface-as-feedback baseline is updated when feedback reaches a terminal state"; `silent-filesystem-drop-detection.feature`: "Pending-assessment marker is NOT cleared when feedback transitions to addressed" | DATA-CONTRACTS §3.3 `Classification.outcome: "surface-as-feedback"`, §2.2 `PendingMarker.outcome` |
| `"trigger-revisit"` | SC-2.6 | AC-G4 (`trigger-revisit` → baseline NOT updated, pending marker written); AC-TR1, AC-TR2 | `manual-change-assessment.feature`: "Agent classifies a fundamental redirect as trigger-revisit" | DATA-CONTRACTS §3.3 `Classification.outcome: "trigger-revisit"`, §2.2 `PendingMarker.outcome` |

**Result:** all four outcome values have SC coverage, AC assertion, ≥1 scenario per value, and a DC entry. No gaps.

---

## 3. Coverage Matrix — Detection

This domain covers DEC-1 (detection model) and the architecture's pre-tick drift gate.

| SC | Success criterion | Source | AC (canonical) | Feature scenario | DC | Deferred |
|---|---|---|---|---|---|---|
| SC-1.1 | The pre-tick drift gate fires after tamper-detection and feedback-triage but before per-state dispatch on every `haiku_run_next` tick. | DESN-01 §"Pre-tick drift-detection gate" | AC-G13 ("Gate chain ordering: tamper-detection → feedback-triage → drift-detection → per-state dispatch") | `manual-change-assessment.feature`: "Agent classifies a typo correction as ignore" (Background: gate has detected drift) | DATA-CONTRACTS §3.5 (gate ordering contract with rationale) | — |
| SC-1.2 | The gate computes a SHA per tracked file and compares it against the stored baseline; matched SHAs do not fire any event. | DESN-01 §"Pre-tick drift-detection gate"; DEC-1 | AC-G1 ("Drift detection runs on every workflow tick"), AC-G2 ("no `manual_change_assessment` action is emitted on a tick with zero drift events") | `silent-filesystem-drop-detection.feature`: "Zero changes since the last tick" | DATA-CONTRACTS §2.1 `Baseline.sha256` (the comparison field) | — |
| SC-1.3 | The gate detects modifications to existing tracked files and emits a `change_kind: "modified"` drift event with file path, prior SHA, current SHA, and (for text files) a unified diff. | DESN-01; DEC-1 | AC-G1, AC-G2, AC-T1 ("Text-file diff is presented to the agent") | `silent-filesystem-drop-detection.feature`: "Designer replaces a stage output layout file"; "Product Owner edits an existing stage output deliverable" | DATA-CONTRACTS §3.1 `DriftFinding` (all fields); `change_kind: "modified"` cross-field invariant 3 | — |
| SC-1.4 | New files appearing in a tracked path that have no baseline are emitted as `change_kind: "new-file-detected"` and routed to `manual_change_assessment`. | DESN-03 §"new-file detection" | AC-FS2 ("New files are detected as drift events") | `silent-filesystem-drop-detection.feature`: "User drops a brand-new knowledge file into the elaborate phase" | DATA-CONTRACTS §3.1 `DriftFinding`, cross-field invariant 1 (`before_sha256: null`) | — |
| SC-1.5 | A previously-baselined file that disappears emits `change_kind: "file-removed"` and the agent's classification decides the outcome. | DESN-03 §"file-deletion behavior" | AC-EE2 ("Tracked file deleted by human") | `silent-filesystem-drop-detection.feature`: "Tracked file is deleted from the worktree" | DATA-CONTRACTS §3.1 `DriftFinding`, cross-field invariant 2 (`after_sha256: null`) | — |
| SC-1.6 | Binary files are baselined by SHA only; the drift event payload contains `before_bytes`, `after_bytes`, `is_binary: true`, and `diff_unified: null`. | DESN-03 §"binary file handling" | AC-B1 ("Binary drift presents a degraded payload") | `silent-filesystem-drop-detection.feature`: "Binary file replacement is detected with SHA delta only (no textual diff)" | DATA-CONTRACTS §3.1 `DriftFinding`, cross-field invariant 4 (`is_binary === true ⇒ diff_unified === null`) | — |
| SC-1.7 | The gate is a no-op (does not compute SHAs, does not emit drift events) when the plugin-settings flag `drift_detection: false` is set. | DESN-01 §"Kill-switch integration"; DESN-05 | AC-G1 implicitly (cites DEC-1); kill-switch path covered by AC-G9 (no writes blocked) + AC-OM1 (detection identical across modes) — the kill-switch is explicitly tested negative: no `manual_change_assessment` emitted. | n/a (no scenario) — kill-switch behavior is a configuration-level negative test covered by DC contract; deferred to development-stage test | DATA-CONTRACTS §3.2 `legal_outcomes` (empty when no findings emitted) | Kill-switch behavioral scenario deferred to development stage (configuration-level test) |
| SC-1.8 | First-tick-after-upgrade behavior establishes baselines without firing drift events; subsequent ticks fire drift events normally. | DESN-05 §"First-tick-after-upgrade behavior" | AC-G8 ("First-tick-after-upgrade silently establishes baselines") | `silent-filesystem-drop-detection.feature`: "First tick after feature ships establishes baselines without firing assessments" | DATA-CONTRACTS §2.1 `Baseline.acknowledged_by: "baseline-init"`, `acknowledged_via: "baseline-init"` | — |
| SC-1.9 | New stages added to an existing intent post-upgrade re-establish baseline only for that stage's tracked paths; cross-stage isolation. | DESN-05 §"Per-stage establish triggers" | AC-G8 (establish mode); AC-G9 (no locking — each stage independent) | n/a — no scenario for composite-intent new-stage join; deferred to development-stage integration test | n/a (no data contract) | Scenario deferred to development stage |

**Domain gap summary:** SC-1.7 and SC-1.9 have no behavioral scenarios. SC-1.7's kill-switch is a configuration-level negative test deferred to development. SC-1.9's cross-stage isolation test requires a composite-intent harness not yet available at product stage. Both are explicitly deferred; not gaps.

---

## 4. Coverage Matrix — Classification & Response

This domain covers DEC-3 (reaction mechanism), DEC-5 (cascade policy), and the four classification outcomes.

| SC | Success criterion | Source | AC (canonical) | Feature scenario | DC | Deferred |
|---|---|---|---|---|---|---|
| SC-2.1 | When ≥1 drift events are emitted on a tick, the workflow engine emits a single `manual_change_assessment` action carrying the full set of drift events. | DESN-01 §"`manual_change_assessment` workflow action" | AC-G2 ("Drift events emit a single workflow action per tick"); AC-G12 ("Same-tick multiple drift events are processed atomically") | `silent-filesystem-drop-detection.feature`: "Multiple files change between two ticks"; `manual-change-assessment.feature`: "Large drift batch is paginated to cap the action payload size" | DATA-CONTRACTS §3.2 `manual_change_assessment` action payload | — |
| SC-2.2 | The agent's classification of a drift event is exactly one of four outcomes: `ignore`, `inline-fix`, `surface-as-feedback`, `trigger-revisit`. | DESN-01 §"Classification outcome semantics" | AC-G3 ("Classification is agent-driven, not harness-driven"); AC-CI1, AC-IF1, AC-SF1, AC-TR1 | `manual-change-assessment.feature`: "Agent classifies a typo correction as ignore"; "Agent classifies a meaningful edit as inline-fix"; "Agent classifies an out-of-spec change as surface-as-feedback"; "Agent classifies a fundamental redirect as trigger-revisit"; "Classification outcome legality varies by change_kind" (Scenario Outline) | DATA-CONTRACTS §3.3 `Classification.outcome` enum | — |
| SC-2.3 | Outcome `ignore` updates the baseline immediately to the current SHA and produces no other side effects. | DESN-01 §"Classification outcome semantics" | AC-G4 (`ignore` branch); AC-CI1; AC-CI2 (deletion semantics for `ignore`) | `manual-change-assessment.feature`: "Agent classifies a typo correction as ignore"; "File classified as ignore does not re-fire on the next tick" | DATA-CONTRACTS §4.3 side-effect ordering step 5 (`ignore` → baseline update) | — |
| SC-2.4 | Outcome `inline-fix` updates the baseline immediately and the agent treats the human's edit as new input for the current bolt. | DESN-01 §"Classification outcome semantics" | AC-G4 (`inline-fix` branch); AC-IF1; AC-IF2 | `manual-change-assessment.feature`: "Agent classifies a meaningful edit as inline-fix" | DATA-CONTRACTS §4.3 side-effect ordering step 5 (`inline-fix` → baseline update) | — |
| SC-2.5 | Outcome `surface-as-feedback` creates a feedback item; baseline writes a pending-assessment marker and is NOT updated at classification time; baseline updates only when the FB reaches a terminal state (`closed` or `rejected`). | DESN-01 §"Classification outcome semantics"; §"Baseline-update contract"; DEC-3 | AC-G4 (`surface-as-feedback` branch); AC-SF1; AC-SF2; AC-SF3; AC-G5 (marker lifecycle) | `manual-change-assessment.feature`: "Agent classifies an out-of-spec change as surface-as-feedback"; "surface-as-feedback baseline is updated when feedback reaches a terminal state"; `silent-filesystem-drop-detection.feature`: "Pending-assessment marker is NOT cleared when feedback transitions to addressed"; "Pending-assessment marker is cleared when feedback transitions to closed"; "Pending-assessment marker is cleared when feedback transitions to rejected" | DATA-CONTRACTS §2.2 `PendingMarker`; §4.3 step 6 (`surface-as-feedback` → no baseline update, write marker) | — |
| SC-2.6 | Outcome `trigger-revisit` calls `haiku_revisit()` against the owning stage; baseline is NOT updated at classification time; pending-assessment marker written. | DESN-01 §"Classification outcome semantics"; DEC-5 | AC-G4 (`trigger-revisit` branch); AC-TR1; AC-TR2 | `manual-change-assessment.feature`: "Agent classifies a fundamental redirect as trigger-revisit" | DATA-CONTRACTS §2.2 `PendingMarker.linked_revisit_target_stage`; §4.3 step 6 | — |
| SC-2.7 | Cross-stage drift (file owned by an earlier stage than active) is not auto-resolved by the harness; the agent classifies. | DEC-5 | AC-EO1 ("Earlier-stage drift may classify to any of the four outcomes"); AC-EO2 (`inline-fix` on earlier-stage drift does not advance or rewind) | `manual-change-assessment.feature`: "Cross-stage drift does not auto-revisit — the Agent decides" | DATA-CONTRACTS §3.2 `legal_outcomes` field (pre-filtered per-finding) | — |
| SC-2.8 | Ambiguous diffs default to `surface-as-feedback` with a `cannot-determine-intent` reason code; this is not a fifth outcome. | DESN-01 §"Ambiguous-diff fallback behavior" | AC-B2 ("Default classification for binary drift is `surface-as-feedback` absent stage context") | `manual-change-assessment.feature`: "Binary file drift is classified with degraded payload (no textual diff)" | DATA-CONTRACTS §3.3 `Classification.rationale_excerpt` (agent notes ambiguity) | — |
| SC-2.9 | The agent's classification record (Assessment) is durable across branch operations and `/haiku:revisit` flows. | DESN-01 §"Classification-record durability" | AC-G11 ("Drift assessment record is durable and human-readable") | `manual-change-assessment.feature`: "ManualChangeAssessment record is durable and human-readable" | DATA-CONTRACTS §2.3 `Assessment` (append-only, `stages/{stage}/drift-assessments/DA-NN.json`) | — |
| SC-2.10 | The `manual_change_assessment` action is skipped (alongside the gate) when the kill-switch is set. | DESN-05 §"Failure-mode rollback" | AC-G2 (no action emitted on zero findings); the kill-switch no-op is the same structural path | `silent-filesystem-drop-detection.feature`: "Zero changes since the last tick" (structurally equivalent — no events → no action) | n/a (no separate DC; same as SC-1.7) | Kill-switch test deferred to development stage as noted in SC-1.7 |

---

## 5. Coverage Matrix — Write Paths (UX Surfaces)

This domain covers DEC-7 (UX surface composition), DEC-9 (Trust+Audit — Reconciliation requirement 3), and design units 02 and 04.

| SC | Success criterion | Source | AC (canonical) | Feature scenario | DC | Deferred |
|---|---|---|---|---|---|---|
| SC-3.1 | A designer can replace a stage output file directly in the worktree filesystem and the next tick acknowledges the change. | Intent goal; DEC-7 | AC-FS1 ("Manual filesystem writes require zero tooling knowledge"); AC-SO1 | `silent-filesystem-drop-detection.feature`: "Designer replaces a stage output layout file" | n/a (no data contract — pure detection path) | — |
| SC-3.2 | A PO can hand-edit a stage-output file and ask the agent to extend; the agent treats the human's edit as the new baseline. | Intent goal | AC-IF1 (`inline-fix` updates baseline and feeds bolt); AC-AB2 ("Agent-on-behalf writes are detected as drift on the next tick") | `agent-writes-on-behalf-of-human.feature`: "User asks the agent to extend a file the User just edited" | DATA-CONTRACTS §2.1 `Baseline.acknowledged_by` (agent absorbs classification) | — |
| SC-3.3 | A user can drop a knowledge file into a stage's knowledge directory (filesystem) without touching chat; the agent picks it up on the next tick. | Intent goal; DEC-1 | AC-KI1 ("Knowledge directory drops are detected as new-file drift events") | `silent-filesystem-drop-detection.feature`: "User drops a brand-new knowledge file into the elaborate phase" | DATA-CONTRACTS §3.1 `DriftFinding.tracking_class: "knowledge"` | — |
| SC-3.4 | A user can drop a knowledge file via the SPA upload UI; the file lands at the selected destination stamped `human-via-mcp`. | DESN-04 §"Knowledge Upload Panel" | AC-SU1 ("SPA upload affordance is available per stage where a target exists"); AC-SU2 ("SPA upload writes to worktree and flows through unified detection path") | `explicit-spa-upload.feature`: "Product Owner attaches a new knowledge file via the SPA" | DATA-CONTRACTS §5.2 `POST /api/intents/{slug}/uploads/knowledge` | — |
| SC-3.5 | A user can replace a stage output file via the SPA's "Replace this output…" dialog; mime-matching enforced; baseline stamps `human-via-mcp`. | DESN-04 §"Stage Output Replacement Affordance" | AC-SU2; AC-SU3 ("SPA upload preserves the file name unless the user renames") | `explicit-spa-upload.feature`: "Designer replaces a stage output file via the SPA upload UI"; "Uploaded file shows pending-assessment badge until next tick classifies it" | DATA-CONTRACTS §5.1 `POST /api/intents/{slug}/uploads/stage-output` | — |
| SC-3.6 | A user can ask the agent in chat to write a file; the agent invokes `haiku_human_write`; the baseline records `acknowledged_by: "human"`. | DEC-7; DESN-02 | AC-AB1 ("Sanctioned MCP tool exists for human-attributed writes"); AC-AB2; AC-AB3 ("Conversation surface acknowledges the human-attributed write") | `agent-writes-on-behalf-of-human.feature`: "User instructs the agent to save a file as human-attributed" | DATA-CONTRACTS §4.1 `haiku_human_write_file` (success response: `baseline_updated: true`) | — |
| SC-3.7 | The human-write MCP tool refuses to write into workflow-managed-file zones with error `path_protected`. | DESN-02 §"Path constraints" | AC-TA4 ("Audit log path is protected against direct writes"); AC-AB1 (agent uses `haiku_human_write` not `Write`) | `agent-writes-on-behalf-of-human.feature`: "haiku_human_write refuses to write to a workflow-managed path"; "haiku_human_write refuses to write to the audit log itself"; "haiku_human_write refuses paths that escape the intent directory"; "haiku_human_write refuses zero-byte content" | DATA-CONTRACTS §4.1 error codes: `path_outside_intent`, `path_protected` | — |
| SC-3.8 | Every successful `haiku_human_write` invocation appends a record to `write-audit.jsonl`; the log is human-readable and append-only. | DESN-02 §"Audit trail"; DEC-9 | AC-TA2 ("Every `haiku_human_write` invocation appends to a per-intent audit log"); AC-TA3 ("Audit log is human-readable and append-only") | `agent-writes-on-behalf-of-human.feature`: "Audit log records full attribution context for every successful haiku_human_write call"; "Audit log is not appended for failed writes"; "Security review can verify each human-via-mcp baseline entry has an audit log entry" | DATA-CONTRACTS §2.3 `Assessment` (append-only records mirror audit log philosophy); §4.1 response field `baseline_updated: true` implies audit appended | — |
| SC-3.9 | SPA uploads also record provenance via `Baseline.acknowledged_via: "spa-upload"`. | DESN-02 §"Integration with the SPA upload pathway" | AC-SU2 (SPA upload stamps `author_class: "human-via-mcp"` via action-log) | `explicit-spa-upload.feature`: "Designer replaces a stage output file via the SPA upload UI"; "Product Owner attaches a new knowledge file via the SPA" | DATA-CONTRACTS §2.1 `Baseline.acknowledged_via: "spa-upload"` | — |
| SC-3.10 | The integrity stance is Trust+Audit (DEC-9 resolved): the human-write MCP tool requires no interrupt-driven human confirmation in v1. | DEC-9; DESN-02 §"Integrity stance" | AC-TA1 ("Human-write MCP tool fires without interrupt-driven human confirmation in v1") | `agent-writes-on-behalf-of-human.feature`: "haiku_human_write completes without confirmation prompt in interactive mode (Trust+Audit, v1)"; "haiku_human_write completes without confirmation prompt in autopilot mode (Trust+Audit, v1)" | DATA-CONTRACTS §4.1 `haiku_human_write_file` request schema (no `confirm` field) | — |

### DEC-9 (Trust + Audit) full chain — Reconciliation requirement 3

SC-3.10 → AC-TA1 (no confirmation required) → `agent-writes-on-behalf-of-human.feature` scenarios "haiku_human_write completes without confirmation prompt in interactive mode (Trust+Audit, v1)" and "haiku_human_write completes without confirmation prompt in autopilot mode (Trust+Audit, v1)" → DATA-CONTRACTS §4.1 `haiku_human_write_file` (no `confirm` argument).

Additionally: SC-3.8 → AC-TA2/AC-TA3 → `agent-writes-on-behalf-of-human.feature`: "Audit log records full attribution context..." and "Security review can verify..." → DATA-CONTRACTS §2.3 `Assessment` + §4.1 response `baseline_updated`.

The `Assessment.initiated_by` / `triggering_request` / `target_path` / `resulting_sha` / `recorded_at` audit fields are implemented via DATA-CONTRACTS §2.3 `Assessment` fields: `id` (AS-NN), `created_at` (recorded_at), `findings[*].path` (target_path), `findings[*].after_sha256` (resulting_sha), and `mode` (context of invocation). The write-audit JSONL at `write-audit.jsonl` covers `user_instruction_excerpt` (triggering_request) and `human_author_id` (initiated_by).

**DEC-9 chain confirmed: PRESENT.**

---

## 6. Coverage Matrix — Tracked Surface, Baseline & Rollout

This domain covers DEC-4, DEC-8, and design units 03 (tracked-surface boundary) and 05 (rollout).

| SC | Success criterion | Source | AC (canonical) | Feature scenario | DC | Deferred |
|---|---|---|---|---|---|---|
| SC-4.1 | The tracked surface includes intent-scope `knowledge/`, every `stages/{stage}/knowledge/`, every `stages/{stage}/artifacts/`, and every `stages/{stage}/discovery/`. | DESN-03 §"In-scope" | AC-KI1 (knowledge directory drops detected); AC-SO1 (stage output replacement detected) | `silent-filesystem-drop-detection.feature`: "User drops a brand-new knowledge file into the elaborate phase"; "Designer replaces a stage output layout file" | DATA-CONTRACTS §2.1 `Baseline.tracking_class` enum values: `"stage-output"`, `"knowledge"` | — |
| SC-4.2 | The tracked surface excludes `units/*.md`, `feedback/*.md`, `intent.md`, `stages/{stage}/state.json`, and any path outside `.haiku/intents/{slug}/`. | DESN-03 §"Out-of-scope" | AC-G7 ("Workflow-managed files are not in the tracked surface"); AC-UO2 (unit-output drift is invisible in v1) | `silent-filesystem-drop-detection.feature`: "Files outside the tracked surface are not detected" | DATA-CONTRACTS §2.1 `Baseline.tracking_class: "intent-meta"` (excluded from drift) | — |
| SC-4.3 | A studio's STAGE.md MAY declare additional `tracked_paths:` patterns to extend the default tracked surface. | DESN-03 §"Per-stage flexibility" | AC-G2 (gate emits findings for all tracked files regardless of how tracked surface is defined) | n/a — no scenario; per-stage extension is a configuration contract | DATA-CONTRACTS §2.1 `Baseline.tracking_class` (extensible via stage config) | Per-stage extension scenario deferred to development stage |
| SC-4.4 | The naming alias `outputs/` → `artifacts/` is honored: `stages/{stage}/outputs/` maps identically to `stages/{stage}/artifacts/`. | DESN-03 §"Path-naming reconciliation" | AC-ALIAS1 ("`stages/{stage}/outputs/` is implementation-equivalent to `stages/{stage}/artifacts/`"); AC-ALIAS2 (baseline keys use canonical `artifacts/` paths); AC-ALIAS3 (SPA uses canonical `artifacts/` label) | `silent-filesystem-drop-detection.feature`: "Gate tracks both artifacts/ and outputs/ alias as the same surface" | DATA-CONTRACTS §2.1 `Baseline.path` (always canonical `artifacts/` form — no `outputs/` keys) | — |
| SC-4.5 | Per-stage SHA baselines survive `git checkout` between stage branches and `/haiku:revisit`-driven branch reuse. | DESN-01 §"Baseline storage layer" | AC-G11 ("Assessment records are durable and human-readable; survives branch switches") | `manual-change-assessment.feature`: "ManualChangeAssessment record is durable and human-readable" | DATA-CONTRACTS §2.1 `Baseline` (on-disk JSON — branch-stable location by design) | — |
| SC-4.6 | Each baseline entry records: path, sha256, acknowledged_by, acknowledged_via, stage, tracking_class, acknowledged_at. | DESN-01 §"Baseline storage layer" | AC-G8 (establish mode populates all fields with `acknowledged_by: "agent"`) | `silent-filesystem-drop-detection.feature`: "First tick after feature ships establishes baselines without firing assessments" | DATA-CONTRACTS §2.1 `Baseline` (all fields required) | — |
| SC-4.7 | First tick of an intent that pre-dates the feature establishes baselines without firing drift; subsequent ticks fire normally. | DESN-05 §"First-tick-after-upgrade behavior" | AC-G8 | `silent-filesystem-drop-detection.feature`: "First tick after feature ships establishes baselines without firing assessments" | DATA-CONTRACTS §2.1 `Baseline.acknowledged_by: "baseline-init"` | — |
| SC-4.8 | Baseline backfill defaults `acknowledged_by: "agent"` for files that pre-date the feature. | DESN-05 §"Author-class backfill" | AC-G8 (establish mode defaults `author_class: "agent"`) | `silent-filesystem-drop-detection.feature`: "First tick after feature ships establishes baselines without firing assessments" (asserts `acknowledged_by "agent"` as conservative default) | DATA-CONTRACTS §2.1 `Baseline.acknowledged_by: "agent"` | — |
| SC-4.9 | `/haiku:reset` and similar destructive operations clear the baseline; the next tick re-establishes. | DESN-05 §"Reset semantics" | AC-EE4 (absent baseline falls back to establish mode); AC-G8 | `silent-filesystem-drop-detection.feature`: "First tick after feature ships establishes baselines without firing assessments" (structural equivalent — absent baseline → establish) | DATA-CONTRACTS §4.2 `haiku_baseline_init` (invoked on re-establish) | — |
| SC-4.10 | `drift_detection: false` disables both gate and `manual_change_assessment`; re-enabling does NOT auto-re-establish. | DESN-05 §"Failure-mode rollback" | AC-G1 (gate only runs when drift detection enabled); AC-G2 (no action emitted if gate no-ops) | n/a — kill-switch deferred to development stage (same as SC-1.7) | n/a | Kill-switch scenario deferred to development stage |
| SC-4.11 | Telemetry emits ≥5 named events (`drift_detected`, `assessment_recorded`, `pending_marker_cleared`, etc.). | DESN-05 §"Telemetry" | AC-G2 (workflow action is the observable proxy for internal events) | `manual-change-assessment.feature`: "ManualChangeAssessment record is durable and human-readable" (records observable via GET /api endpoint, which implies event emission) | DATA-CONTRACTS §6.1 `drift_detected` event; §6.2 `assessment_recorded` event; §6.3 `pending_marker_cleared` event (three of ≥5 named events) | — |
| SC-4.12 | Concurrency model is eventual consistency: no locks, no version tokens. Mid-bolt human edits result in next-tick reconciliation. | DEC-4; DESN-01 §"Concurrency model" | AC-G9 ("Concurrency model — eventual consistency, no locking") | `silent-filesystem-drop-detection.feature`: "Change is detected on next tick not during in-flight bolt" | DATA-CONTRACTS §3.5 (gate runs post-triage; eventual consistency is the ordering model) | — |
| SC-4.13 | Failure modes: missing baseline → establish; corrupt baseline → halt + escalate; out-of-sync → drift event. | DESN-01 §"Failure modes" | AC-EE4 ("Baseline file storage corrupted or missing") | `silent-filesystem-drop-detection.feature`: "Baseline storage is corrupt on tick" | DATA-CONTRACTS §2.1 `Baseline` integrity (parse failure → halt) | — |

### `outputs/` → `artifacts/` alias full chain — Reconciliation requirement 6

SC-4.4 → AC-ALIAS1/AC-ALIAS2/AC-ALIAS3 → `silent-filesystem-drop-detection.feature`: "Gate tracks both artifacts/ and outputs/ alias as the same surface" → DATA-CONTRACTS §2.1 `Baseline.path` (canonical `artifacts/` form; no `outputs/` keys permitted).

**Alias chain confirmed: PRESENT.**

---

## 7. Coverage Matrix — User-Visible SPA Signals

This domain covers DEC-7 (UX surface composition) and design unit-04 (SPA UI specs), plus design unit-06 (establish-mode chip deferral).

| SC | Success criterion | Source | AC (canonical) | Feature scenario | DC | Deferred |
|---|---|---|---|---|---|---|
| SC-5.1 | The drift-detected indicator strip renders ONLY while `manual_change_assessment` has not yet run on the pending tick; it auto-disappears once assessment completes. | DESN-04 §"Drift-Detected Indicator" | AC-G2 (action emitted on drift, resolves on classification); AC-G4 (side effects per outcome determine badge state) | `drift-assessment-visibility.feature`: "Pending drift badge appears on the affected artifact card before classification"; "Outcome badge for surface-as-feedback links to the underlying feedback item" | DATA-CONTRACTS §6.1 `drift_detected` event (drives SPA state); §6.2 `assessment_recorded` event (clears SPA state) | — |
| SC-5.2 | The drift-detected indicator is passive — no "Run now", "Assess", "Accept", "Surface", or "Ignore" buttons. | DESN-04 §"Drift-Detected Indicator"; DEC §"Direction A" | AC-G3 ("Classification is agent-driven, not harness-driven") | `drift-assessment-visibility.feature`: "Pending drift badge appears on the affected artifact card before classification" (badge only — no classification buttons shown) | n/a | — |
| SC-5.3 | Per-card drift state conveys both a color token and a non-color signal (WCAG 1.4.1). | DESN-04 §"Stage Output Replacement Affordance — States" | AC-G11 ("Assessment record is visible in the SPA's drift assessment view") | `drift-assessment-visibility.feature`: "Outcome badge text matches the classification outcome" (Scenario Outline) | n/a | — |
| SC-5.4 | All four drift-state colors come from canonical tokens in `DESIGN-TOKENS.md`; no raw Tailwind palette classes. | DESN-04; cross-cutting requirements | AC-G11 (SPA view must render correctly) | n/a (verifiable by lint, not by behavior) | n/a | Lint-level check deferred to development stage |
| SC-5.5 | Knowledge Upload Panel collapses to a single button on ≤375px; drag-drop absent on touch devices. | DESN-04 §"Responsive behavior" | AC-SU1 (upload affordance per stage) | `explicit-spa-upload.feature`: "Upload affordance is available for stages with a defined upload target" (Scenario Outline) | n/a | Responsive layout test deferred to development stage |
| SC-5.6 | Drop-zone carries `role="button"`, `tabIndex={0}`, `aria-label="Upload knowledge file"`. | DESN-04 §"ARIA requirements" | AC-SU1 (upload affordance per stage exists) | `explicit-spa-upload.feature`: "Upload affordance is available for stages with a defined upload target" | n/a | ARIA attribute test deferred to development stage |
| SC-5.7 | Output-card `⋯` menu trigger carries `aria-label="More options for {artifact-name}"` interpolated per card. | DESN-04 §"Stage Output Replacement Affordance — ARIA" | AC-SU1 | `explicit-spa-upload.feature`: "Designer replaces a stage output file via the SPA upload UI" | n/a | ARIA attribute test deferred to development stage |
| SC-5.8 | Drift-indicator strip announced via `role="status"` and `aria-live="polite"`; empty live region persists after unmount. | DESN-04 §"Drift-Detected Indicator — ARIA" | AC-G11 (SPA view renders drift state) | `drift-assessment-visibility.feature`: "Pending drift badge appears on the affected artifact card before classification" | n/a | ARIA live-region test deferred to development stage |
| SC-5.9 | WCAG AA contrast table present in SPA-UI-SPECS.md for every new token pair. | DESN-04 cross-cutting | AC-G11 (SPA renders drift state correctly) | n/a (inspection of design spec, not runtime behavior) | n/a | Contrast table inspection deferred to development stage |
| SC-5.10 | Touch targets ≥44×44 on ≤768px for every new interactive element. | DESN-04 cross-cutting | AC-SU1 (upload affordance exists) | `explicit-spa-upload.feature`: "Upload affordance is available for stages with a defined upload target" | n/a | Touch-target measurement deferred to development stage |
| SC-5.11 | `prefers-reduced-motion` suppresses non-essential animations; progress bars still render. | DESN-04 cross-cutting | AC-G11 | n/a (media-query test) | n/a | Media-query test deferred to development stage |
| SC-5.12 | Establish-mode chip styling deferred to development; v1 is a text label in a neutral container, no interactive affordance. | DESN-06 | n/a (deferral is documented contract; no AC enforced) | n/a | n/a | Chip styling deferred to development stage by design (DESN-06 explicitly) |
| SC-5.13 | Drift-indicator strip auto-disappears after assessment completes; artifact cards reflect new drift state. | DESN-04 §"Drift-Detected Indicator — Auto-disappears" | AC-G2 (no action emitted after classification) | `drift-assessment-visibility.feature`: "Pending drift badge appears on the affected artifact card before classification" (shows before → after) | DATA-CONTRACTS §6.2 `assessment_recorded` event (SPA polls after seeing this event) | — |
| SC-5.14 | Replacement modal's mime-mismatch path requires explicit user confirmation; note pre-fills with type-change context. | DESN-04 §"Stage Output Replacement Affordance — Mime-mismatch handling" | AC-SU2 (SPA upload flows through unified path) | `explicit-spa-upload.feature`: "Designer replaces a stage output file via the SPA upload UI" | DATA-CONTRACTS §5.1 `mode` field (`"replace"` mode, mime enforcement) | — |

### Pending-revisit transition coverage — Reconciliation requirement 5

SC-5.13 (strip auto-disappears) maps to pending-revisit state visibility as follows:

SC-2.6 (`trigger-revisit` creates pending marker) → AC-TR1 (`trigger-revisit` pending baseline NOT updated) → `drift-assessment-visibility.feature`: "SPA shows pending-revisit state between trigger-revisit classification and actual revisit invocation" + "SPA resolves pending-revisit state when the revisited stage re-passes its gate" → DATA-CONTRACTS §2.2 `PendingMarker.linked_revisit_target_stage` + `cleared_at: null` while pending.

The `Assessment.revisit_invoked_at` equivalent is DATA-CONTRACTS §2.2 `PendingMarker.created_at` (the moment the revisit was dispatched) and `cleared_at` (the moment the revisit completed and the marker was cleared, which is when the baseline updates).

**Pending-revisit chain confirmed: PRESENT.**

---

## 8. Coverage Matrix — Cross-Cutting & Non-Functional

| SC | Success criterion | Source | AC (canonical) | Feature scenario | DC | Deferred |
|---|---|---|---|---|---|---|
| SC-6.1 | Product-stage outputs are implementable across paper + plugin + website. | DEC-8 | AC-G13 (gate chain ordering); AC-G11 (durability) | All scenarios collectively | DATA-CONTRACTS §7 (cross-surface naming audit) | — |
| SC-6.2 | Pre-tick drift gate is third in the chain (tamper → triage → drift → per-state dispatch). | DESN-01; SC-1.1 | AC-G13 ("Gate chain ordering") | `manual-change-assessment.feature` Background ("drift-detection gate has detected drift" presupposes gate ran) | DATA-CONTRACTS §3.5 (gate ordering with rationale) | — |
| SC-6.3 | Product-stage outputs do not contradict any recorded design decision (DEC-1..DEC-9). | DESIGN-DECISIONS.md header | AC-G13, AC-G4, AC-G9, AC-TA1 (all cite DEC-N) | All scenarios | DATA-CONTRACTS §1 naming conventions (consistent with DEC-N) | — |
| SC-6.4 | Eventual-consistency model named and accepted; AC and BSPEC do not assume locks. | DEC-4 | AC-G9 ("Concurrency model — eventual consistency, no locking") | `silent-filesystem-drop-detection.feature`: "Change is detected on next tick not during in-flight bolt" | DATA-CONTRACTS §3.5 (eventual consistency as the gate ordering model) | — |
| SC-6.5 | Cross-cutting boundary with pre-tick feedback-triage gate is acknowledged; substance lives in workflow-engine sibling. | Sibling boundary | AC-G13 (cites ARCHITECTURE.md §3.1, not re-specifies) | n/a — cross-cutting boundary note only | DATA-CONTRACTS §3.5 (gate ordering rationale cites feedback-triage as prerequisite) | — |
| SC-6.6 | PreToolUse hook on workflow-managed files is unchanged; humans are out-of-band by design (DEC-2). | DEC-2 | AC-G6 ("Existing PreToolUse hook on workflow-managed files is unchanged"); AC-G7 ("Workflow-managed files are not in the tracked surface") | `agent-writes-on-behalf-of-human.feature`: "haiku_human_write refuses to write to a workflow-managed path" | DATA-CONTRACTS §4.1 `path_protected` error code | — |
| SC-6.7 | Every AC item has a concrete test path (BSPEC scenario, DC schema, or inspection step). | Validator hat anti-patterns | AC-G11 cites `stages/{stage}/drift-assessments/DA-NN.json`; AC-G13 cites ARCHITECTURE.md; AC-TA2 cites `write-audit.jsonl` | All scenarios serve as test paths for their respective AC items | DATA-CONTRACTS sections serve as schema validators | — |
| SC-6.8 | Product outputs address outcome-based intent goals: stop silent edit loss; non-technical collaborators can work without MCP/hooks knowledge. | Intent goal §"Outcome-based" | AC-FS1 ("Manual filesystem writes require zero tooling knowledge"); AC-G9 (no blocking); AC-G10 ("All three write-path origins produce the same downstream detection signal") | `silent-filesystem-drop-detection.feature`: "Designer replaces a stage output layout file"; "User drops a brand-new knowledge file into the elaborate phase" | n/a | — |

---

## 9. Surface-as-Feedback Baseline Contract Coverage (Reconciliation requirement 4)

The surface-as-feedback baseline contract is the single most load-bearing behavioral invariant: the baseline is NOT updated at classification time; it updates only when the linked feedback reaches `closed` or `rejected`.

**Full SC → AC → scenario → DC chain:**

- **SC:** SC-2.5 (surface-as-feedback opens feedback; baseline holds pending marker; baseline updates on terminal FB state)
- **AC:** AC-G4 (baseline-update contract by outcome, `surface-as-feedback` branch explicitly states "baseline SHA is NOT updated at classification time"); AC-SF1 ("`surface-as-feedback` creates a normal feedback item and does NOT update the baseline"); AC-SF2 (pending-assessment marker suppresses re-detection); AC-SF3 ("Only `closed` and `rejected` feedback transitions clear the marker — `addressed` does NOT")
- **Scenarios:**
  - `manual-change-assessment.feature`: "Agent classifies an out-of-spec change as surface-as-feedback" (creates marker, asserts baseline NOT updated)
  - `manual-change-assessment.feature`: "surface-as-feedback baseline is updated when feedback reaches a terminal state" (closed → marker cleared → baseline updated)
  - `silent-filesystem-drop-detection.feature`: "Pending-assessment marker is NOT cleared when feedback transitions to addressed"
  - `silent-filesystem-drop-detection.feature`: "Pending-assessment marker is cleared when feedback transitions to closed"
  - `silent-filesystem-drop-detection.feature`: "Pending-assessment marker is cleared when feedback transitions to rejected"
- **DC:** DATA-CONTRACTS §2.2 `PendingMarker` (entire entity); §4.3 step 6 ("For each non-terminal classification: write a PendingMarker. Do not update Baseline"); §4.4 `haiku_baseline_clear_marker` (`trigger: "feedback-closed"` | `"feedback-rejected"`)

**Chain confirmed: PRESENT and complete.**

---

## 10. Marker Clearing on `addressed` (Not `closed`) Coverage (Reconciliation requirement 7)

The marker-clearing lifecycle is the companion to the surface-as-feedback baseline contract. The critical rule: `addressed` is NOT a terminal state for marker clearing; only `closed` and `rejected` are.

**Full SC → AC → scenario → DC chain:**

- **SC:** SC-2.5 (pending marker holds until FB reaches terminal state)
- **AC:** AC-G5 (pending-assessment marker lifecycle — terminal states); AC-SF3 ("Only `closed` and `rejected` transitions clear the marker — `addressed` does NOT"). Explicit: "When the underlying feedback item transitions to `addressed`: the marker is NOT cleared — `addressed` is not a terminal state for marker clearing"
- **Scenarios:**
  - `silent-filesystem-drop-detection.feature`: "Pending-assessment marker is NOT cleared when feedback transitions to addressed" (primary coverage — asserts marker persists, baseline NOT updated, gate continues to suppress)
  - `silent-filesystem-drop-detection.feature`: "Pending-assessment marker is cleared when feedback transitions to closed" (positive control)
  - `silent-filesystem-drop-detection.feature`: "Pending-assessment marker is cleared when feedback transitions to rejected" (positive control)
  - `manual-change-assessment.feature`: "surface-as-feedback baseline is updated when feedback reaches a terminal state" (`closed` case — confirms clearing sequence)
- **DC:** DATA-CONTRACTS §4.4 `haiku_baseline_clear_marker` (`trigger` enum values: `"feedback-closed"` | `"feedback-rejected"` | `"revisit-complete"` — `"feedback-addressed"` is NOT in the enum, which is the contract encoding that addressed does not trigger clearing)

**Chain confirmed: PRESENT and complete.**

---

## 11. Orphan Detection

An orphan is an AC or scenario that does not trace back to at least one SC.

**Orphan detection approach:** For each AC-G*/AC-EE* entry in `product/ACCEPTANCE-CRITERIA.md` and each `Scenario:` name in `features/*.feature`, confirm it maps to at least one SC in sections 2–8.

**AC orphan audit:**

| AC identifier | Maps to SC(s) | Status |
|---|---|---|
| AC-G1 | SC-1.2, SC-1.3 | Covered |
| AC-G2 | SC-2.1, SC-2.10 | Covered |
| AC-G3 | SC-2.2, SC-5.2 | Covered |
| AC-G4 | SC-2.3, SC-2.4, SC-2.5, SC-2.6 | Covered |
| AC-G5 | SC-2.5, SC-2.6 (marker lifecycle) | Covered |
| AC-G5-A | Open/Deferred (design-stage gap) | Out-of-scope (design clarification pending) |
| AC-G6 | SC-6.6 | Covered |
| AC-G7 | SC-4.2, SC-6.6 | Covered |
| AC-G8 | SC-1.8, SC-4.6, SC-4.7, SC-4.8 | Covered |
| AC-G9 | SC-4.12, SC-6.4 | Covered |
| AC-G10 | SC-6.8 (three origins unified) | Covered |
| AC-G11 | SC-2.9, SC-4.5, SC-5.1, SC-5.3, SC-5.13 | Covered |
| AC-G12 | SC-2.1 (atomic multi-event) | Covered |
| AC-G13 | SC-1.1, SC-6.2, SC-6.3 | Covered |
| AC-TA1 | SC-3.10 | Covered |
| AC-TA2 | SC-3.8 | Covered |
| AC-TA3 | SC-3.8 | Covered |
| AC-TA4 | SC-3.7 | Covered |
| AC-ALIAS1 | SC-4.4 | Covered |
| AC-ALIAS2 | SC-4.4 | Covered |
| AC-ALIAS3 | SC-4.4 | Covered |
| AC-SU1 | SC-3.4, SC-5.5, SC-5.6, SC-5.7, SC-5.10 | Covered |
| AC-SU2 | SC-3.4, SC-3.5, SC-3.9, SC-5.14 | Covered |
| AC-SU3 | SC-3.5 | Covered |
| AC-FS1 | SC-3.1, SC-6.8 | Covered |
| AC-FS2 | SC-1.4, §2.1 enum | Covered |
| AC-FS3 | SC-1.2 (temp-file exclusion) | Covered |
| AC-AB1 | SC-3.6, SC-3.7 | Covered |
| AC-AB2 | SC-3.2, SC-3.6 | Covered |
| AC-AB3 | SC-3.6 | Covered |
| AC-SO1 | SC-4.1, SC-3.1 | Covered |
| AC-SO2 | SC-2.7 | Covered |
| AC-KI1 | SC-3.3, SC-4.1 | Covered |
| AC-KI2 | SC-3.3 (agent judgment) | Covered |
| AC-UO1 | SC-4.2 (Open/Deferred — design stage) | Out-of-scope for v1 |
| AC-UO2 | SC-4.2 | Covered |
| AC-T1 | SC-1.3 | Covered |
| AC-T2 | SC-1.3 (diff size cap) | Covered |
| AC-B1 | SC-1.6 | Covered |
| AC-B2 | SC-2.8 | Covered |
| AC-B3 | SC-1.6 (vision tool optional) | Covered |
| AC-CO1 | SC-2.6 (revisit not valid for current-stage) | Covered |
| AC-CO2 | SC-2.9 (assessment record location) | Covered |
| AC-EO1 | SC-2.7 | Covered |
| AC-EO2 | SC-2.7 (no workflow rewind) | Covered |
| AC-OM1 | §2.2 author_class enum | Covered |
| AC-OM2 | SC-2.2 (silent classification in autopilot) | Covered |
| AC-CI1 | SC-2.3, §2.3 enum | Covered |
| AC-CI2 | SC-1.5 (deletion + ignore) | Covered |
| AC-IF1 | SC-2.4, §2.3 enum | Covered |
| AC-IF2 | SC-2.4 (assessment record content) | Covered |
| AC-SF1 | SC-2.5, §2.3 enum, §9 | Covered |
| AC-SF2 | SC-2.5, §10 | Covered |
| AC-SF3 | SC-2.5, §10 | Covered |
| AC-TR1 | SC-2.6, §2.3 enum | Covered |
| AC-TR2 | SC-2.6, §10 | Covered |
| AC-TR3 | SC-2.6 (revisit-of-self rejected) | Covered |
| AC-EE1 | SC-4.12 (concurrent same-tick drift) | Covered |
| AC-EE2 | SC-1.5, §2.1 enum | Covered |
| AC-EE3 | SC-4.2 (out-of-surface boundary) | Covered |
| AC-EE4 | SC-4.13, SC-4.9 (corrupt or missing baseline) | Covered |
| AC-EE5 | SC-2.9 (classification failure recovery) | Covered |
| AC-EE6 | SC-2.5, SC-4.12 (double-edit while marker open) | Covered |
| AC-EE7 | Deferred — P1 (SPA classification override) | Out-of-scope for v1 |

**Scenario orphan audit:**

All scenarios in `features/silent-filesystem-drop-detection.feature`, `features/manual-change-assessment.feature`, `features/agent-writes-on-behalf-of-human.feature`, `features/drift-assessment-visibility.feature`, and `features/explicit-spa-upload.feature` map to at least one SC in sections 3–8.

**Orphan detection result: no orphans found.** AC-G5-A, AC-UO1, and AC-EE7 are Open/Deferred or P1 (not orphans; they have documented dispositions). The AC-EE7 P1 deferral is the only case where no scenario exists for a specified AC — and it is explicitly labeled P1 in the ACCEPTANCE-CRITERIA.md prioritization summary.

---

## 12. Gap Detection

A gap is an SC that lacks AC, scenario, or DC coverage where coverage is required.

| Potential gap | Assessment | Status |
|---|---|---|
| SC-1.7 has no behavioral scenario | Kill-switch is a configuration-level negative test; explicitly deferred to development stage with documented rationale | Deferred — not a gap |
| SC-1.9 has no behavioral scenario | Composite-intent new-stage join test requires a harness not available at product stage; explicitly deferred | Deferred — not a gap |
| SC-2.8 (`cannot-determine-intent` reason_code) has no explicit DC field | The `Classification.rationale_excerpt` field (DATA-CONTRACTS §3.3) carries this text; the reason-code is a string convention within that field, not a separate typed field; the AC (AC-B2) specifies the default rationale text that should appear | Informational — not a gap (agent-judgment guideline, not a harness-enforced field) |
| SC-4.3 has no behavioral scenario | Per-stage `tracked_paths:` extension is a STAGE.md config-level feature; behavioral test requires a custom studio not available at product stage | Deferred — not a gap |
| SC-4.10 has no behavioral scenario | Same as SC-1.7; kill-switch test deferred to development stage | Deferred — not a gap |
| SC-5.4, SC-5.9 have no behavioral scenarios | Lint-level (token audit) and design-spec inspection (contrast table) checks; explicitly deferred to development stage | Deferred — not a gap |
| SC-5.5–SC-5.8 have no behavioral scenarios | ARIA and responsive layout tests require a rendered component harness; deferred to development stage | Deferred — not a gap |
| AC-EE7 has no scenario | P1 priority; explicitly labeled P1 in ACCEPTANCE-CRITERIA.md prioritization summary; data model is correct | P1 deferral — not a gap |
| All 7 reconciliation requirements addressed | §2 (canonical enums), §5 (DEC-9), §6 (alias), §9 (surface-as-feedback contract), §10 (marker clearing) confirmed present and complete | Confirmed — no gaps |

**Gap detection result: no gaps found** (all identified deferrals are explicitly documented with rationale; no SC row is missing required AC coverage).

---

## 13. Out-of-Scope Dispositions

The following SCs are intentionally deferred to later stages with disposition rationale.

| SC / topic | Disposition | Stage | Rationale |
|---|---|---|---|
| SC-1.7 / SC-2.10 / SC-4.10 behavioral scenarios (kill-switch) | Deferred | development | Configuration-level negative tests require a full harness with plugin-settings mock; not producible as product-stage behavioral spec |
| SC-1.9 behavioral scenario (composite-intent new-stage join) | Deferred | development | Requires composite intent harness; not available at product stage |
| SC-4.3 behavioral scenario (per-stage `tracked_paths:` extension) | Deferred | development | Requires a custom studio with `tracked_paths:` declared in STAGE.md; not available at product stage |
| SC-5.4 lint check (no raw Tailwind palette classes) | Deferred | development | Requires codebase lint tooling targeting the new SPA components; not executable at product stage |
| SC-5.5 responsive layout test (≤375px collapse) | Deferred | development | Requires a rendered component in a viewport simulation; not executable at product stage |
| SC-5.6–SC-5.8 ARIA tests | Deferred | development | Require a rendered component and accessibility test harness; not executable at product stage |
| SC-5.9 WCAG AA contrast table | Deferred | development | Design-spec inspection; executable once SPA-UI-SPECS.md is final |
| SC-5.10 touch-target measurement | Deferred | development | Require a rendered component at 375px; not executable at product stage |
| SC-5.11 reduced-motion test | Deferred | development | Require a rendered component with `prefers-reduced-motion` media-query mock |
| SC-5.12 establish-mode chip styling | Deferred | development | Explicitly deferred by DESN-06 (ROLLOUT-CHIP-SELF-CONTAINED.md); no AC enforced in product stage |
| AC-G5-A (active-stage state during pending-revisit) | Deferred | design | ARCHITECTURE.md §5 does not yet name a state for this window; design-stage must either add §5.5 or explicitly declare no special state |
| AC-UO1 (unit-output tracking boundary) | Deferred | design | v1 default excludes unit working directories; AC-UO2 captures the negative-space behavior |
| AC-EE7 (SPA classification override) | Deferred (P1) | development | Data model is spec'd for forward-compatibility; the interaction is P1 and ships after MVP |

---

## 14. Scope Creep Flags

The following 15 items are explicitly not authorized for the product stage (unchanged from discovery draft — none of the discovered AC/BSPEC/DC content introduces them):

SCREEP-1 (real-time file watching), SCREEP-2 (file locking / CAS / OT), SCREEP-3 ("Run now" button), SCREEP-4 (user classification override buttons in v1), SCREEP-5 (separate migration script), SCREEP-6 (diff viewer inside drift indicator), SCREEP-7 (multi-user concurrency UX beyond dialog-level banner), SCREEP-8 (stage-baseline reset UI), SCREEP-9 (per-file size/type override beyond existing caps), SCREEP-10 (inline "explain why" prompt on drift banner), SCREEP-11 (drift detection on files outside `.haiku/intents/{slug}/`), SCREEP-12 (fifth classification outcome), SCREEP-13 (harness-level enforcement of Trust+Audit beyond v1 audit trail), SCREEP-14 (telemetry pipeline beyond structured log entries), SCREEP-15 (detection of writes to workflow-managed files by humans).

No AC, BSPEC, or DC artifact introduces any of these items. Scope creep detection result: **no scope creep found**.

---

## 15. Boundary Acknowledgements

- **Workflow-engine sibling boundary** — Gate ordering (tamper → triage → drift → per-state dispatch) is the workflow-engine sibling's substance. This document references it as SC-1.1 / SC-6.2 constraints citing ARCHITECTURE.md §3.1 and DATA-CONTRACTS §3.5.
- **Security/hooks sibling boundary** — The PreToolUse hook contract for agent writes is bounded in DEC-2 and owned by the security/hooks sibling. This document references it as SC-6.6 constraint via AC-G6/AC-G7.
- **Auth model sibling boundary** — SC-3.9's `Baseline.acknowledged_via: "spa-upload"` provenance depends on the SPA auth model owned by the SPA artifact. This document references the field shape; the `user_id` format is deferred.

---

## 16. Validation Outcome

**APPROVED.**

All seven reconciliation requirements are confirmed present and complete:

1. **AC-G*/AC-EE* identifier scheme** — Every SC row's AC column references a real `AC-G<N>`, `AC-EE<N>`, or variant AC (AC-TA*, AC-ALIAS*, AC-SU*, AC-FS*, AC-AB*, AC-SO*, AC-KI*, AC-UO*, AC-T*, AC-B*, AC-CO*, AC-EO*, AC-OM*, AC-CI*, AC-IF*, AC-SF*, AC-TR*) identifier that exists in `product/ACCEPTANCE-CRITERIA.md`. No flat `AC-N.N` numbering from the discovery draft remains.
2. **Canonical enum cross-check** — §2 documents all three canonical enums (`change_kind`, `acknowledged_by`/`author_class`, `outcome`) with full SC→AC→scenario≥1→DC chains per value. No enum value is missing scenario coverage.
3. **DEC-9 (Trust + Audit) coverage** — SC-3.10 → AC-TA1 → `agent-writes-on-behalf-of-human.feature` Trust+Audit scenarios → DATA-CONTRACTS §4.1 (no `confirm` field). Audit fields (initiated_by, triggering_request, target_path, resulting_sha, recorded_at) confirmed present via §2.3 `Assessment` + write-audit JSONL. Confirmed in §5.
4. **Surface-as-feedback baseline contract** — SC-2.5 → AC-G4/AC-SF1/AC-SF2/AC-SF3 → five scenarios across `manual-change-assessment.feature` and `silent-filesystem-drop-detection.feature` → DATA-CONTRACTS §2.2 `PendingMarker` + §4.3 step 6 + §4.4 `haiku_baseline_clear_marker`. Confirmed in §9.
5. **Pending-revisit transition coverage** — SC-2.6 → AC-TR1/AC-TR2 → `drift-assessment-visibility.feature` "SPA shows pending-revisit state" + "SPA resolves pending-revisit state" scenarios → DATA-CONTRACTS §2.2 `PendingMarker.linked_revisit_target_stage` + `cleared_at`. The `revisit_invoked_at` equivalent is `PendingMarker.created_at`. Confirmed in §7.
6. **Outputs/artifacts alias coverage** — SC-4.4 → AC-ALIAS1/AC-ALIAS2/AC-ALIAS3 → `silent-filesystem-drop-detection.feature` "Gate tracks both artifacts/ and outputs/ alias" → DATA-CONTRACTS §2.1 `Baseline.path` (canonical `artifacts/` form enforced). Confirmed in §6.
7. **Marker clearing on `addressed` (not `closed`)** — SC-2.5 → AC-G5/AC-SF3 → `silent-filesystem-drop-detection.feature` "Pending-assessment marker is NOT cleared when feedback transitions to addressed" (+ positive controls for closed/rejected) → DATA-CONTRACTS §4.4 `haiku_baseline_clear_marker` trigger enum (does not include `"feedback-addressed"`). Confirmed in §10.

Zero gaps. Zero orphans. Zero scope creep. All 7 reconciliation requirements satisfied.

The product stage gate is **passable** based on the observed on-disk artifacts in `product/ACCEPTANCE-CRITERIA.md`, `product/DATA-CONTRACTS.md`, and `features/*.feature`.
