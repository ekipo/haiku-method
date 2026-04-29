---
title: Feedback reconciliation — close 6 unvalidated fix-loop findings
model: sonnet
depends_on:
  - unit-01-acceptance-criteria
  - unit-02-behavioral-specs
  - unit-03-data-contracts
  - unit-04-coverage-validation
closes:
  - FB-02
  - FB-03
  - FB-07
  - FB-10
  - FB-11
  - FB-12
inputs:
  - intent.md
  - product/ACCEPTANCE-CRITERIA.md
  - product/DATA-CONTRACTS.md
  - product/COVERAGE-MAPPING.md
  - >-
    stages/product/feedback/02-pending-marker-clearance-trigger-is-specified-three-differen.md
  - >-
    stages/product/feedback/03-assessment-append-only-guarantee-contradicts-mutable-resulti.md
  - >-
    stages/product/feedback/07-trigger-revisit-baseline-update-timing-is-deferred-to-archit.md
  - >-
    stages/product/feedback/10-agent-writes-on-behalf-of-human-feature-references-non-exist.md
  - >-
    stages/product/feedback/11-drift-assessment-visibility-feature-uses-inconsistent-state.md
  - >-
    stages/product/feedback/12-unit-02-deliverable-location-ambiguity-5-named-features-vs-8.md
outputs:
  - >-
    .haiku/intents/out-of-band-human-file-modifications/product/DATA-CONTRACTS.md
  - >-
    .haiku/intents/out-of-band-human-file-modifications/product/COVERAGE-MAPPING.md
status: pending
---
# Feedback reconciliation — close 6 unvalidated fix-loop findings

Reconcile six adversarial-review findings against the product-stage artifacts. The fixes are line-level cross-document consistency edits — no new architectural decisions. Each finding has a single normative resolution that's already either present in some artifact and contradicted in another, or absent entirely and trivial to add. Prior fix-loop bolts already authored each fix on per-FB isolation worktrees but the assessor wave never validated them due to a parent-side dispatch bug (https://github.com/gigsmart/haiku-method/issues/271). This unit re-applies and consolidates the fixes on the stage branch in a single coordinated pass.

## Pre-condition: tracked-file inventory

Before applying any edit, the executor MUST verify the artifact set on disk. Both `features/` (intent-root, 5 canonical user-behavior features) and `outputs/features/` (under `stages/product/outputs/`, 8 supplementary contract-verification scenarios) must exist with the file lists below. If any file is absent, the executor STOPS and logs an `inventory_missing` finding via `haiku_feedback` rather than fabricating stubs — missing files mean an upstream merge dropped them, which is a different problem than this unit's scope.

**Expected `features/` (5 files):**
- `silent-filesystem-drop-detection.feature`
- `explicit-spa-upload.feature`
- `agent-writes-on-behalf-of-human.feature`
- `manual-change-assessment.feature`
- `drift-assessment-visibility.feature`

**Expected `outputs/features/` (8 files):**
- `assessment_schema.feature` — verifies §2.3 Assessment
- `pending_marker_schema.feature` — verifies §2.2 PendingMarker
- `baseline_schema.feature` — verifies §2.1 Baseline
- `drift_finding_and_action.feature` — verifies §3.1–§3.2 DriftFinding + manual_change_assessment payload
- `internal_events.feature` — verifies §6 internal events
- `mcp_tools.feature` — verifies §4 MCP tool contracts
- `http_api.feature` — verifies §5 HTTP API surface
- `cross_surface_naming.feature` — verifies §7 cross-surface naming audit

These mappings ARE the routing-table the unit's FB-12 deliverable will publish — pinning them here so the executor doesn't have to infer.

## Per-finding resolution

Apply each edit to the artifacts in `.haiku/intents/out-of-band-human-file-modifications/`. The order below is intentional — FB-02, FB-03, FB-07 set the lifecycle contracts that FB-10, FB-11 then enforce in scenarios; FB-12 (the catalog and Appendix A) lands LAST so its cites resolve cleanly.

### FB-02 — Pending-marker clearance trigger (terminal-only)

Pin the `PendingMarker` clearance trigger to **`feedback-closed | feedback-rejected | revisit-complete`** in every artifact. Drop `feedback-addressed` as a clearance trigger — it does NOT clear surface-as-feedback markers. This direction matches `unit-01-acceptance-criteria` AC-G5/AC-SF3.

**Edits required (all 5 must land — assessor will sweep all 5):**

1. `product/DATA-CONTRACTS.md` §3.5 (`haiku_baseline_clear_marker` MCP tool contract section): rewrite the trigger-contract paragraph to state clearance fires on `feedback-closed`, `feedback-rejected`, or `revisit-complete` only. Add a normative note that `feedback-addressed` does NOT trigger clearance. (This explicitly overrides `unit-03-data-contracts` reconciliation requirement #5, which encoded the opposite contract — that's the reason this unit closes FB-02.)
2. `product/DATA-CONTRACTS.md` §4.4 (clearance-trigger enum): rewrite the enum to the three terminal states; add a normative paragraph stating `addressed` is mid-state and does NOT clear; reflect this in §6 internal-events so `pending_marker_cleared.trigger` accepts only the three values.
3. `features/manual-change-assessment.feature`: scenario covering the surface-as-feedback lifecycle uses `feedback-closed` (or `feedback-rejected`) as the clearance trigger. Add an explicit "addressed does NOT clear" scenario.
4. **`features/silent-filesystem-drop-detection.feature` lines 164–188** (the three scenarios that currently treat `feedback-addressed` as the primary trigger with `feedback-closed` as fallback): rewrite to mirror the terminal-only contract — clearance fires on `feedback-closed`/`feedback-rejected`/`revisit-complete`, no `feedback-addressed` trigger. Replace any "addressed-clears" scenario with an "addressed does NOT clear" scenario.
5. `outputs/features/pending_marker_schema.feature`: clearance trigger enum is terminal-only; add the addressed-no-clear scenario.

### FB-03 — Assessment append-only invariant + PendingMarker.resolved_sha

Preserve `Assessment` as strictly append-only after creation. The post-clearance SHA is carried by a SEPARATE entity (`PendingMarker.resolved_sha`), not by mutating an Assessment field.

**Edits to `product/DATA-CONTRACTS.md`:**

- §2.3 `Assessment` schema: `resulting_sha` is `null` at write time for non-terminal outcomes (`surface-as-feedback`, `trigger-revisit`); for terminal outcomes (`ignore`, `inline-fix`) it captures the SHA at write time. The field is set once at creation and never updated.
- §2.2 `PendingMarker` schema: ADD `resolved_sha: string | null` (null while pending, populated atomically when the marker is cleared). This is the single mutable lifecycle field on PendingMarker; document the one-write-at-clearance contract. Cross-surface naming audit table (§7) must list `resolved_sha`.
- §6.3 `pending_marker_cleared` event: payload includes `resolved_sha` from the cleared marker.
- §3.5 / §3.6: any prose that previously said "Assessment.resulting_sha is rewritten on marker clearance" must be replaced with the PendingMarker.resolved_sha pattern.

**Edits to `outputs/features/`:**

- `assessment_schema.feature` line ~80 ("resulting_sha is updated at marker-clearance time for non-terminal outcomes"): **DELETE this scenario** (asserts Assessment mutation, incompatible with append-only). Replace with: `PendingMarker.resolved_sha` is populated at clearance time while the Assessment record is unchanged.
- `outputs/features/mcp_tools.feature` line ~224 (haiku_baseline_clear_marker scenario): rewrite `"the Assessment record's resulting_sha is updated"` to `"the PendingMarker's resolved_sha is updated"`. Same assertion as above, separate file — the assessor will sweep both.
- `pending_marker_schema.feature`: ADD scenarios for the `resolved_sha` lifecycle (null → atomic populate at clearance, never mutated after).

### FB-07 — Inline trigger-revisit baseline-update timing

`product/DATA-CONTRACTS.md` must self-contain the `trigger-revisit` baseline-update timing rule rather than deferring to ARCHITECTURE.md §5.4 (a design-stage artifact).

**Edits to `product/DATA-CONTRACTS.md`:**

- ADD §3.6 mirroring §3.5's structure for `trigger-revisit`:
  - Atomic-ordering steps: classification → revisit-invoked → revisit-complete → marker-clear
  - `Assessment.revisit_invoked_at` field semantics (null until next tick invokes `haiku_revisit`)
  - `PendingMarker.resolved_sha` populated atomically with marker clearance on the `revisit-complete` trigger
  - `(outcome, trigger)` legality matrix in §4.4: `surface-as-feedback` clears on `feedback-closed`/`feedback-rejected`; `trigger-revisit` clears on `revisit-complete`; mismatched (outcome, trigger) pairs return `trigger_outcome_mismatch` error.
- §4.3 (atomic-ordering steps): replace any prior reference to "see ARCHITECTURE.md §5.4" with the in-stage §3.6 cite.

**`trigger_outcome_mismatch` coverage trace:** This new error code falls under the existing AC-EE* row in `unit-01-acceptance-criteria` covering tool-call error paths in the Classification & Response domain. Update `product/COVERAGE-MAPPING.md` to extend that SC-N row's DC column to include §3.6 + §4.4 legality-matrix entries — NOT a new SC-N row. If the executor cannot identify the matching AC-EE* row, log a coverage-trace finding via `haiku_feedback` rather than inventing one.

### FB-10 — `acknowledged_by` → `author_class`

`acknowledged_by` is not a canonical field. The canonical field is `author_class` per `product/DATA-CONTRACTS.md` §2.1, with enum `agent | human-via-mcp | human-implicit`.

**Edits to `features/agent-writes-on-behalf-of-human.feature`:**

- Lines 38, 46, 88: replace every `acknowledged_by` with `author_class` and every value `"human"` with `"human-via-mcp"`.
- Line 88 (security-review scenario `Then` clause): the field `acknowledged_by` becomes `author_class`. **Leave `acknowledged_via "human-write-tool"` unchanged** — that's a separate canonical field per `product/DATA-CONTRACTS.md` §2.1 (enum `human-write-tool | spa-upload | filesystem-drop`).
- Sweep the entire file to confirm no other `acknowledged_by` instances remain. Replace any value `"human"` carried over.

**Edits to `product/DATA-CONTRACTS.md`:**

- §1 naming conventions table: REMOVE the `author_type: "human"` row (it introduces a third name for the same concept). The canonical field is `author_class`. If the table previously documented `author_type` as a deprecated alias for `feedback.author_type`, replace that row with: `author_class — canonical field on Baseline rows for who authored the file's current SHA. Enum: agent | human-via-mcp | human-implicit. Mirrors feedback.author_type only by convention; the two are independent fields on independent records.`
- §2.1 Baseline schema: confirm field is named `author_class` (NOT `acknowledged_by`). If the schema still uses `acknowledged_by`, rename it.

### FB-11 — Canonical `revisit-invoked` state name + UI-grounding

**Edits to `features/drift-assessment-visibility.feature`:**

- Line 49: replace `"revisit-triggered"` with the canonical `"revisit-invoked"` (matches `Assessment.revisit_invoked_at` per `DATA-CONTRACTS.md` §2.3).
- The `pending-revisit` SPA state corresponds to `Assessment.outcome === "trigger-revisit"` AND `Assessment.revisit_invoked_at == null`. Add an inline comment grounding this in §2.3.
- The `resolved` SPA UI label maps to `PendingMarker.resolved_sha != null` (FB-03's new field), set atomically at marker clearance per §2.2. Add the inline grounding citing §2.2.
- Transition chain reads: `pending-revisit → revisit-invoked → resolved`. The prior file's chain referenced `revisit-triggered`, which doesn't exist in any canonical schema.
- Line ~119 (Scenario Outline Examples): the badge_text `"Revisit triggered"` is UI copy, not an API enum value. Update it to `"Revisit invoked"` so the SPA badge text matches the underlying state name. Add an inline comment noting the badge is UI copy and may diverge from the enum if a future design decision requires user-friendlier wording — for now, kept identical to the state.

### FB-12 — outputs/features/ disambiguation (LAND LAST)

`features/` (intent-root) has 5 canonical user-behavior `.feature` files. `outputs/features/` (under `stages/product/outputs/`) has 8 supplementary contract-verification scenarios. Disambiguate for the development stage's step-definition layer.

**Order of operations (mutual reference): write Appendix A FIRST, README SECOND.**

**Step 1 — Add Appendix A to `product/DATA-CONTRACTS.md`** listing the 8 supplementary files by name with what each verifies and the canonical-vs-supplementary distinction. Use the file-to-section mapping from the Pre-condition section above (verbatim — those mappings are normative).

**Step 2 — Add `stages/product/outputs/features/README.md`** with:
- Header: "outputs/features/ — supplementary contract-verification scenarios (NOT canonical user behavior; see /features/ at intent root for the 5 canonical features)."
- A markdown table with three columns: `File`, `DATA-CONTRACTS.md Section(s)`, `Verifies`. Every row cites a real section heading by name (e.g., `§2.2 PendingMarker`, `§4.4 Clearance trigger`). Files that verify multiple sections get multiple rows. No row may have an empty `DATA-CONTRACTS.md Section(s)` column. The table must include all 8 files — partial coverage fails the criterion.
- A short paragraph routing downstream consumers: development stage's step-definitions layer binds against `features/` (canonical 5). The 8 in `outputs/features/` are scenario-level contract verifications consumed by the development stage's contract-test layer, not the user-behavior step-definition layer.

## change_kind enum reconciliation (folds in across FB-02 / FB-07 scope)

The `change_kind` enum diverges across artifacts:
- `product/DATA-CONTRACTS.md` §3.1 currently uses one set
- `features/manual-change-assessment.feature` (legality Scenario Outline lines 75–87) and `outputs/features/internal_events.feature` line ~41 use another set

`unit-02-behavioral-specs` reconciliation requirement 1 pinned the canonical values to `added | modified | deleted` (lowercase, no aliases — this matches what the .feature files already use). `unit-03-data-contracts` reconciliation requirement 1 pinned the same enum in `DATA-CONTRACTS.md` §3.1. If the on-disk `DATA-CONTRACTS.md` §3.1 currently uses anything other than `added | modified | deleted` (e.g. `new-file-detected | modified | file-removed`), the executor MUST update §3.1 to the canonical lowercase three-value set so the artifacts converge — the .feature files are correct; DATA-CONTRACTS is the one that drifted.

## Completion Criteria

- All 6 listed feedback items have their fixes applied to the stage branch (not isolation worktrees) and pass the feedback-assessor's two-stage check (spec match + no regressions).
- `product/DATA-CONTRACTS.md` has new §3.6 (trigger-revisit baseline timing) AND Appendix A (outputs/features/ catalog with all 8 files mapped to their verification sections) AND §2.2 PendingMarker schema includes `resolved_sha: string | null` with one-write-at-clearance contract.
- `product/DATA-CONTRACTS.md` §3.1 `change_kind` enum is exactly `added | modified | deleted` (lowercase, no aliases).
- `product/DATA-CONTRACTS.md` §1 naming conventions table does NOT include a freestanding `author_type: "human"` row; `author_class` is the canonical field name.
- `product/DATA-CONTRACTS.md` §3.5 (`haiku_baseline_clear_marker` MCP tool contract section) trigger paragraph uses only the three terminal-state triggers; `feedback-addressed` is explicitly called out as non-triggering.
- `features/manual-change-assessment.feature`, `features/agent-writes-on-behalf-of-human.feature`, `features/drift-assessment-visibility.feature`, `features/silent-filesystem-drop-detection.feature` use only canonical enum values (no `acknowledged_by`, no `revisit-triggered`, no `feedback-addressed`-clears semantics, `change_kind` exactly the three values).
- `outputs/features/pending_marker_schema.feature`, `assessment_schema.feature`, `internal_events.feature`, `mcp_tools.feature` use the terminal-only clearance-trigger enum AND remove all Assessment-mutation assertions (Assessment is append-only; PendingMarker.resolved_sha carries post-clearance SHA).
- `outputs/features/README.md` exists with a markdown table of all 8 files mapped to real DATA-CONTRACTS.md section headings; no row has an empty section column.
- `product/COVERAGE-MAPPING.md` Validation Outcome remains `APPROVED` after the edits. The `trigger_outcome_mismatch` error code introduced in FB-07 traces to an existing AC-EE* row in the Classification & Response domain (DC column extended, no new SC-N row added). The new `PendingMarker.resolved_sha` field traces to an existing AC-G* row (DC column extended). If a trace cannot be made cleanly, the executor logs a coverage-trace finding rather than fabricating an SC-N row.
- No new acceptance criteria are added to `ACCEPTANCE-CRITERIA.md` — the existing AC-G5/AC-SF3/AC-G7/etc. already encode the contracts; this unit's job is to MAKE the artifacts consistent with those AC, not to add new ones.
