---
title: >-
  Assessment append-only guarantee contradicts mutable resulting_sha for
  non-terminal outcomes
status: pending
origin: adversarial-review
author: feasibility
author_type: agent
created_at: '2026-04-29T03:42:04Z'
iteration: 1
visit: 1
source_ref: null
closed_by: null
bolt: 0
triaged_at: '2026-04-29T03:42:04Z'
resolution: null
replies: []
---

## Finding

DATA-CONTRACTS.md §2.3 declares the `Assessment` schema append-only: "Append-only. The durable record of what changed, what the agent decided, and why." The storage reference explicitly states: "records are never modified after writing."

`assessment_schema.feature` (line 80) includes the scenario: "resulting_sha is updated at marker-clearance time for non-terminal outcomes" — When feedback "FB-12" is resolved and `haiku_baseline_clear_marker` fires, the Assessment's `resulting_sha` is updated to the current on-disk SHA.

These are mutually exclusive properties. Either:
- `Assessment` is truly append-only (records cannot be modified), in which case `resulting_sha` cannot be updated post-write, OR
- `resulting_sha` is mutable post-write, in which case `Assessment` is not append-only.

**Impact:** This is a fundamental schema design contradiction. Development must choose one model and implement accordingly. An append-only `Assessment` cannot have fields updated after writing without violating the audit guarantee. If `resulting_sha` must reflect the post-clearance state, the correct approach is to either (a) write a separate `AssessmentResolution` record at clearance time, or (b) store `resulting_sha` only in the `PendingMarker` clearance event / `haiku_baseline_clear_marker` response, not in the `Assessment` record.

**Fix required:** Either remove `resulting_sha` from the `Assessment` schema (making the Assessment record truly immutable) and document where the resolved SHA is accessible, or explicitly drop the append-only guarantee and explain the mutable fields and their write windows. The scenario in `assessment_schema.feature` must be updated to match whichever model is chosen.
