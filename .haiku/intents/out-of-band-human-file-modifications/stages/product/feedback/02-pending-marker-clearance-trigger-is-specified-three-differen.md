---
title: >-
  Pending-marker clearance trigger is specified three different ways across
  three artifacts
status: fixing
origin: adversarial-review
author: feasibility
author_type: agent
created_at: '2026-04-29T03:41:51Z'
iteration: 1
visit: 1
source_ref: null
closed_by: null
bolt: 3
triaged_at: '2026-04-29T03:41:51Z'
resolution: null
replies: []
---
## Finding

The trigger condition for clearing a `PendingMarker` was specified inconsistently across four product-stage artifacts:

1. **DATA-CONTRACTS.md §4.4** (`haiku_baseline_clear_marker`): said `"feedback-addressed"` was the **primary trigger** for `surface-as-feedback` markers — fired at `addressed`, before `closed`.
2. **`pending_marker_schema.feature`** (line 82): scenario "PendingMarker is cleared when linked feedback transitions to addressed" — aligned with DATA-CONTRACTS.md §4.4.
3. **`manual-change-assessment.feature`** (line 48): scenario "surface-as-feedback baseline is updated when feedback reaches a terminal state" — used `closed` as the trigger.
4. **Unit-01 acceptance criteria + ACCEPTANCE-CRITERIA.md AC-G5/AC-SF3**: stated "closed and rejected clear; addressed does NOT" with explicit rationale that `addressed` FBs can be reopened so only terminal states are safe.

## Diagnosis (bolt 3 — re-investigated)

- **Current state:** four documents specified four different triggers (`addressed` fires; `addressed` does not fire; `closed` fires; both `closed`+`rejected` fire). Development could not determine the correct implementation.
- **Desired state:** one normative trigger contract, propagated identically across all four artifacts.
- **Gap:** DATA-CONTRACTS.md §4.4 + §6.3 + `pending_marker_schema.feature` were the outliers — they specified `addressed` as a clearance trigger when the ratified product spec (unit-01 AC-G5/AC-SF3 and DATA-CONTRACTS.md §3.5 narrative at line 414) had already chosen the conservative path: only terminal states (`closed`, `rejected`) clear the marker. `manual-change-assessment.feature` was correct in using a terminal state but only covered `closed`, missing `rejected`.
- **Comparable working sibling:** the unit-01 acceptance criteria + the §3.5 narrative in DATA-CONTRACTS.md ("clearance fires when the linked feedback transitions to a terminal state (closed or rejected)") already state the conservative contract explicitly with rationale.
- **Bolt 2 status:** body was authored claiming completion but no edits to artifacts were committed. Bolt 3 actually applies the planned fix.

## Normative decision

**Only `closed` and `rejected` clear the `surface-as-feedback` PendingMarker. `addressed` does NOT clear.** Rationale (already in unit-01): `addressed` feedback can be reopened; only immutable terminal states provide the certainty needed to update the baseline and lift re-detection suppression.

## Fix (bolt 3 — committed)

- `stages/product/outputs/DATA-CONTRACTS.md` §4.4 — rewrote Purpose + R5 trigger contract; trigger enum now `"feedback-closed" | "feedback-rejected" | "revisit-complete"` (dropped `"feedback-addressed"`); added explicit cross-references to `pending_marker_schema.feature`, `manual-change-assessment.feature`, and unit-01 AC-G5/AC-SF3.
- `stages/product/outputs/DATA-CONTRACTS.md` §6.3 (`pending_marker_cleared` event) — same enum tightening + worked-example fix (`"trigger": "feedback-closed"`); added explicit "addressed is not a clearance trigger" note.
- `stages/product/outputs/features/pending_marker_schema.feature` — replaced the lone "transitions to addressed" scenario with three: closed-clears, rejected-clears, and an explicit addressed-does-NOT-clear with rationale.
- `features/manual-change-assessment.feature` — converted the terminal-state scenario to a Scenario Outline parameterized over `closed | rejected` (now invokes `haiku_baseline_clear_marker` with the matching trigger); added an explicit "addressed does NOT clear" scenario with rationale.

## Out-of-scope contradictions logged separately

`internal_events.feature` (lines 120, 148, 169) and `mcp_tools.feature` (lines 221, 266, 281, 303–307) also reference `feedback-addressed` as a clearance trigger and need the same enum tightening. These were not explicitly cited in this FB body — logging as a follow-up FB rather than expanding scope here.

## Status

Closed by bolt 3 — single normative decision propagated consistently across DATA-CONTRACTS.md §4.4 + §6.3, `pending_marker_schema.feature`, `manual-change-assessment.feature`. All four artifacts now agree on the conservative terminal-only contract.
