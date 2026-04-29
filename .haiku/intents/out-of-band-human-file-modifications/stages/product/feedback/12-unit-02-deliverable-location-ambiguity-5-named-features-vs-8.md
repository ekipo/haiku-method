---
title: >-
  Unit-02 deliverable location ambiguity: 5 named features vs 8 different files
  in outputs/features/
status: fixing
origin: adversarial-review
author: completeness
author_type: agent
created_at: '2026-04-29T03:43:46Z'
iteration: 1
visit: 1
source_ref: null
closed_by: null
bolt: 1
triaged_at: '2026-04-29T03:43:46Z'
resolution: null
replies: []
---

## Finding

Unit-02's completion criteria (behavioral specifications) specifies exactly 5 named `.feature` files:
1. `silent-filesystem-drop-detection.feature`
2. `explicit-spa-upload.feature`
3. `agent-writes-on-behalf-of-human.feature`
4. `manual-change-assessment.feature`
5. `drift-assessment-visibility.feature`

These 5 files exist at `.haiku/intents/out-of-band-human-file-modifications/features/`.

However, the product stage's `outputs/features/` directory contains a **completely different** set of 8 files:
- `assessment_schema.feature`
- `baseline_schema.feature`
- `cross_surface_naming.feature`
- `drift_finding_and_action.feature`
- `http_api.feature`
- `internal_events.feature`
- `mcp_tools.feature`
- `pending_marker_schema.feature`

Neither set of files appears at both locations. This creates a completeness gap: it is unclear which set is the canonical unit-02 deliverable that downstream stages (development, unit-04 coverage-validation) will consume.

Unit-04's coverage-validation (unit-04 scope) says it maps "The `.feature` scenario(s) in `.haiku/intents/{slug}/features/*.feature`" — pointing to the `features/` root (the 5-file set), not `outputs/features/` (the 8-file set).

If the 8-file set in `outputs/features/` is the actual unit-02 deliverable, then:
- They are not at the path unit-04 expects
- They use different organizational structure (schema-centric vs behavior-centric)
- They are missing some scenarios the 5 named files contain (e.g., pending-revisit visibility, SPA upload affordance UI)

If the 5-file set in `features/` is the deliverable, then the `outputs/features/` contents are unaccounted for supplementary material.

## Impact

This ambiguity breaks the unit-04 coverage mapping: unit-04 cannot produce a correct scenario-traceability matrix if it doesn't know which feature files are authoritative.

## Required fix

The product stage deliverable must resolve this ambiguity explicitly:
1. Define which directory is the canonical unit-02 output
2. Either move the 5 named files to `outputs/features/` (replacing the 8-file set), or document that `outputs/features/` is supplementary and the 5 files at `features/` are the primary deliverable
3. Unit-04 coverage mapping must reference the correct paths
