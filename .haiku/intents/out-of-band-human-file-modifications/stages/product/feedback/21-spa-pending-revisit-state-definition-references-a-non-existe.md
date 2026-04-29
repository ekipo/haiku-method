---
title: >-
  SPA pending-revisit state definition references a non-existent PendingMarker
  field
status: pending
origin: adversarial-review
author: feasibility
author_type: agent
created_at: '2026-04-29T20:33:39Z'
iteration: 2
visit: 2
source_ref: null
closed_by: null
bolt: 0
triaged_at: '2026-04-29T20:33:39Z'
resolution: null
replies: []
---

**Mandate lens:** Data contracts must be compatible with existing schemas; the SPA's state machine must be derivable from the defined fields.

**Finding:**

`drift-assessment-visibility.feature` lines 57–63 contains this comment and scenario:

```
# SPA state: "resolved" = PendingMarker.resolved_sha != null (DATA-CONTRACTS.md §2.2 — set atomically
# with cleared_at at marker clearance time; never null after clearance)
```

However, `DATA-CONTRACTS.md §2.2` defines the `PendingMarker` schema and its field table contains NO `resolved_sha` field. The fields defined are: `path`, `created_at`, `created_by_assessment_id`, `outcome`, `linked_feedback_id`, `linked_revisit_target_stage`, `cleared_at`.

The feature file's comment invents a `resolved_sha` field that does not exist in the schema. There is no `resolved_sha` in §2.2's field table, no mention of it in the `PendingMarker` schema, and the cross-surface naming audit in §7 does not include it.

**Impact:** The SPA's "resolved" state check (`PendingMarker.resolved_sha != null`) cannot be implemented against the defined schema. Development would either add an undocumented field (breaking the product-stage schema authority claim) or use `cleared_at != null` as the proxy (which is the semantically correct substitute — but then the feature file comment is wrong and misleading, creating ongoing documentation drift).

**Location:** `features/drift-assessment-visibility.feature` lines 57–59 (comment above the "resolved" scenario), cross-referenced against `DATA-CONTRACTS.md §2.2` `PendingMarker` field table.
