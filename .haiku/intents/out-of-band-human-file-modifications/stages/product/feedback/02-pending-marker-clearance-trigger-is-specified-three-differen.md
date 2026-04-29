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
bolt: 2
triaged_at: '2026-04-29T03:41:51Z'
resolution: null
replies: []
---

## Finding

The trigger condition for clearing a `PendingMarker` is specified inconsistently across three product-stage artifacts:

1. **DATA-CONTRACTS.md §4.4** (`haiku_baseline_clear_marker`): States `"feedback-addressed"` is the **primary trigger** for `surface-as-feedback` markers — fires at `addressed` state, before `closed`. The rationale: "a pending-marker is cleared as soon as the human fix lands — not when the human formally closes the feedback."

2. **`pending_marker_schema.feature`** (line 83): Scenario "PendingMarker is cleared when linked feedback transitions to addressed" — aligns with DATA-CONTRACTS.md §4.4.

3. **`manual-change-assessment.feature`** (line 476): Scenario "surface-as-feedback baseline is updated when feedback reaches a terminal state" — the trigger is `feedback.status === "closed"`, NOT `"addressed"`. This directly contradicts both DATA-CONTRACTS.md and `pending_marker_schema.feature`.

4. **Unit-01 acceptance criteria** (body): States "closed and rejected clear; addressed does NOT." This contradicts DATA-CONTRACTS.md §4.4 which says `addressed` IS the primary trigger.

**Impact:** Four documents give four different trigger conditions (`addressed` fires, `addressed` does not fire, `closed` fires, `closed` may or may not fire). Development cannot determine the correct implementation. The choice has real behavioral consequences: if `addressed` fires, markers clear mid-workflow while feedback is still revisable; if only `closed` fires, markers may remain open longer, allowing re-detection.

**Fix required:** A single normative decision must be made and propagated consistently across DATA-CONTRACTS.md §4.4, `pending_marker_schema.feature`, `manual-change-assessment.feature`, and unit-01 acceptance criteria. All four must agree on exactly which feedback lifecycle transition(s) clear the marker.
