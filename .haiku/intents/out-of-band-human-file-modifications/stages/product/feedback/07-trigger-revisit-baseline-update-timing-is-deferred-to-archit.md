---
title: >-
  trigger-revisit baseline update timing is deferred to ARCHITECTURE.md §5.4
  which is not a product-stage artifact
status: pending
origin: adversarial-review
author: feasibility
author_type: agent
created_at: '2026-04-29T03:42:47Z'
iteration: 1
visit: 1
source_ref: null
closed_by: null
bolt: 0
triaged_at: '2026-04-29T03:42:47Z'
resolution: null
replies: []
---

## Finding

DATA-CONTRACTS.md §4.3 (`haiku_classify_drift` atomic side-effect ordering), step 7 states: "For `trigger-revisit`: write a `PendingMarker` (baseline NOT updated at classification time — updated on revisit completion, per §5.4 of ARCHITECTURE.md)."

DATA-CONTRACTS.md §8 explicitly lists "Baseline storage format / location" as deferred to `stages/design/artifacts/ARCHITECTURE.md §2.2`. The trigger-revisit baseline update timing is governed by a design-stage artifact (`ARCHITECTURE.md §5.4`) that is not part of the product-stage outputs on this branch.

**Impact:** Development implementing the `trigger-revisit` baseline-update contract cannot resolve this from the product-stage artifacts alone. They must cross-reference a design-stage architecture document. If ARCHITECTURE.md §5.4 changes after the product stage is approved, the product-stage contract silently becomes stale. This is a tractability issue — the product stage's data contracts should be self-contained for the trigger-revisit timing, or at minimum cite the exact rule being delegated.

Additionally, `haiku_baseline_clear_marker` response schema (§4.4) shows `baseline_updated: true` for revisit completion clearing. But `haiku_classify_drift` step 7 says baseline is NOT updated at classification time for `trigger-revisit`. This is consistent — but the gap between the two writes (classification → revisit completion) has no defined mechanism for the intermediate state. When does `resulting_sha` get its final value in the Assessment for `trigger-revisit` outcomes? The Assessment schema (§2.3) shows `resulting_sha` as required and populated at write time — but for `trigger-revisit`, the final SHA isn't known until revisit completion.

**Fix required:** DATA-CONTRACTS.md must either (a) inline the trigger-revisit baseline-update timing rule from ARCHITECTURE.md §5.4 (even as a normative excerpt), or (b) define what value `resulting_sha` holds in the Assessment for trigger-revisit at write time (e.g., the pre-drift SHA, or null, or the post-drift SHA) and when it is updated. The deferred reference to ARCHITECTURE.md §5.4 leaves a tractability hole in the product-stage contract.
