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

Reconcile six adversarial-review findings against the product-stage artifacts. The fixes are line-level cross-document consistency edits — no new architectural decisions, no new schemas. Each finding has a single normative resolution that's already either present in some artifact and contradicted in another, or absent entirely and trivial to add.

The prior fix-loop bolts already landed each fix on its per-FB isolation worktree but the assessor wave never validated them due to a parent-side dispatch bug (see https://github.com/gigsmart/haiku-method/issues/271). This unit re-applies and consolidates the fixes on the stage branch in a single coordinated pass so the assessor can validate them once.

## Per-finding resolution

Apply each edit to the artifacts in `.haiku/intents/out-of-band-human-file-modifications/product/` (and the canonical `features/` directory where called out). The order below is intentional — FB-02, FB-03, FB-07 set the lifecycle contracts that FB-10, FB-11 then enforce in scenarios; FB-12 is an independent doc disambiguation.

### FB-02 — Pending-marker clearance trigger (terminal-only)

Pin the `PendingMarker` clearance trigger to **`feedback-closed | feedback-rejected | revisit-complete`** in every artifact that references it. Drop `feedback-addressed` as a clearance trigger across the board — it does NOT clear surface-as-feedback markers.

Specifically:
- `DATA-CONTRACTS.md` §4.4: rewrite the clearance-trigger enum to the three terminal states; add a normative paragraph stating `addressed` is mid-state and does NOT clear; reflect this in the §6 internal-events section so `pending_marker_cleared.trigger` accepts only the three values.
- `features/manual-change-assessment.feature`: scenario covering the surface-as-feedback lifecycle must use `feedback-closed` (or `feedback-rejected`) as the clearance trigger. Add an explicit "addressed does NOT clear" scenario.
- `outputs/features/pending_marker_schema.feature`: same — clearance trigger enum is terminal-only; add the addressed-no-clear scenario.

This aligns with `unit-01-acceptance-criteria`'s AC-G5/AC-SF3 which already established the conservative contract.

### FB-03 — Assessment append-only invariant

Preserve `Assessment` as strictly append-only after creation. The post-clearance SHA is carried by a SEPARATE entity, not by mutating an Assessment field.

Specifically in `DATA-CONTRACTS.md`:
- §2.3 `Assessment` schema: `resulting_sha` is `null` at write time for non-terminal outcomes (`surface-as-feedback`, `trigger-revisit`); for terminal outcomes (`ignore`, `inline-fix`) it captures the SHA at write time. The field is set once at creation and never updated.
- §2.2 `PendingMarker` schema: ADD a `resolved_sha: string | null` field — null while pending, populated atomically when the marker is cleared. This is the single mutable lifecycle field on PendingMarker; document the one-write-at-clearance contract.
- §6.3 `pending_marker_cleared` event: payload includes `resolved_sha` from the cleared marker.
- §3.5 / §3.6: any prose that previously said "Assessment.resulting_sha is rewritten on marker clearance" must be replaced with the PendingMarker.resolved_sha pattern.

Update `outputs/features/assessment_schema.feature` and `outputs/features/pending_marker_schema.feature` accordingly: split the prior Assessment-mutability scenarios into per-outcome cases; add the `PendingMarker.resolved_sha` lifecycle scenarios; remove any scenario that asserts Assessment fields change post-creation.

### FB-07 — Inline trigger-revisit baseline-update timing

`DATA-CONTRACTS.md` must self-contain the `trigger-revisit` baseline-update timing rule rather than deferring to ARCHITECTURE.md §5.4 (which is a design-stage artifact, not a product-stage contract).

Add a new `DATA-CONTRACTS.md` §3.6 that mirrors §3.5's structure for `trigger-revisit`:
- Atomic-ordering steps from classification → revisit-invoked → revisit-complete → marker-clear
- `Assessment.revisit_invoked_at` field semantics (null until next tick invokes `haiku_revisit`)
- `PendingMarker.resolved_sha` populated atomically with marker clearance on the `revisit-complete` trigger
- Add a `(outcome, trigger)` legality matrix to §4.4: `surface-as-feedback` clears on `feedback-closed`/`feedback-rejected`; `trigger-revisit` clears on `revisit-complete`; mismatched (outcome, trigger) pairs return `trigger_outcome_mismatch` error.

Update §4.3 (atomic-ordering steps) so any prior reference to "see ARCHITECTURE.md §5.4" is replaced with the in-stage §3.6 cite.

### FB-10 — `acknowledged_by` → `author_class`

The field name `acknowledged_by` does not exist in any schema. The canonical field is `author_class` per `DATA-CONTRACTS.md` §2.1, with enum `agent | human-via-mcp | human-implicit`.

In `features/agent-writes-on-behalf-of-human.feature`:
- Replace every reference to `acknowledged_by` with `author_class`.
- Replace any value `"human"` with the canonical `"human-via-mcp"`.
- Lines 38, 46, 88 are the known offenders; sweep the entire file to confirm no others remain.

### FB-11 — Canonical `revisit-invoked` state name

In `features/drift-assessment-visibility.feature`:
- Replace `revisit-triggered` with the canonical `revisit-invoked` (matches `Assessment.revisit_invoked_at` per `DATA-CONTRACTS.md` §2.3).
- The `pending-revisit` state corresponds to `Assessment.outcome === "trigger-revisit"` AND `revisit_invoked_at == null`. Add an inline comment grounding this in §2.3.
- The `resolved` UI label maps to `PendingMarker.cleared_at` (FB-03's new field) being non-null. Add the inline grounding.
- The transition chain must read: `pending-revisit → revisit-invoked → resolved` — the prior file claimed `pending-revisit → revisit-invoked → resolved` came from `revisit-triggered`, which doesn't exist.

### FB-12 — outputs/features/ disambiguation

`features/` (intent-root) has 5 canonical user-behavior `.feature` files. `outputs/features/` (under `stages/product/outputs/`) has 8 supplementary contract-verification scenarios. The naming collision is confusing for downstream consumers (development stage's step-definition layer needs to know which to bind).

Add `outputs/features/README.md` declaring the directory supplementary, with a routing table mapping each of the 8 files to the contract section in `DATA-CONTRACTS.md` it verifies, and a pointer to `features/` (intent-root) for the canonical 5 user-behavior features.

Add Appendix A to `DATA-CONTRACTS.md` listing the 8 supplementary files by name, what each verifies, and the canonical-vs-supplementary distinction.

## Completion Criteria

- All 6 listed feedback items have their fixes applied to the stage branch (not isolation worktrees) and pass the feedback-assessor's two-stage check (spec match + no regressions).
- `DATA-CONTRACTS.md` has new §3.6 (trigger-revisit baseline timing) and Appendix A (outputs/features/ catalog); §2.2 PendingMarker schema includes `resolved_sha` field.
- `features/manual-change-assessment.feature` and `features/agent-writes-on-behalf-of-human.feature` and `features/drift-assessment-visibility.feature` use only canonical enum values (no `acknowledged_by`, no `revisit-triggered`, no `feedback-addressed`-clears semantics).
- `outputs/features/pending_marker_schema.feature` and `outputs/features/assessment_schema.feature` and `outputs/features/internal_events.feature` and `outputs/features/mcp_tools.feature` use the terminal-only clearance-trigger enum.
- `outputs/features/README.md` exists with the routing table.
- `COVERAGE-MAPPING.md` Validation Outcome remains `APPROVED` after the edits (no SC-N row pointed at content that was removed; the new `PendingMarker.resolved_sha` and `DATA-CONTRACTS.md` §3.6 trace from the AC-G* rows that already existed).
- No new acceptance criteria are added to `ACCEPTANCE-CRITERIA.md` — the existing AC-G5, AC-SF3, AC-G7, etc. already encode the contracts; this unit's job is to MAKE the artifacts consistent with those AC, not to add new ones.
