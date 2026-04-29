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
bolt: 2
triaged_at: '2026-04-29T03:43:46Z'
resolution: null
replies: []
---

## Finding

Unit-02's completion criteria specifies exactly 5 named user-behavior `.feature` files at `.haiku/intents/out-of-band-human-file-modifications/features/`. The product stage's `outputs/features/` directory contained a different set of 8 schema/contract-verification `.feature` files with no documentation of which set is canonical or how the two relate. Unit-04's coverage-validation maps to `features/*.feature` (the 5-file set), creating a routing ambiguity for downstream consumers (development stage step definitions, adversarial reviewers, future contributors).

## Root cause

The 8 files in `outputs/features/` are contract-verification scenarios generated alongside `outputs/DATA-CONTRACTS.md` — they restate field-level schemas, HTTP API shapes, MCP tool shapes, and event payloads in executable Gherkin so a development harness can regression-test the contract layer. They cannot be unit-02 deliverables because unit-02's completion criteria explicitly forbid feature files that inline schema or HTTP/MCP request shapes. Their role was correct; the routing was simply undocumented.

## Resolution

Disambiguation is now explicit in two places downstream consumers will read:

1. **`stages/product/outputs/features/README.md`** (new) — declares the directory SUPPLEMENTARY (not the unit-02 deliverable), names the 5 canonical files at `.haiku/intents/{slug}/features/`, cites unit-02's "no schema in feature files" constraint, and provides a routing table mapping each consumer (unit-04 coverage matrix, development step definitions, contract regression harness, adversarial reviewers, future stages) to the correct location.

2. **`stages/product/outputs/DATA-CONTRACTS.md` Appendix A** (new) — names the 8 companion files, states they are NOT the unit-02 deliverable, names the 5 canonical files and their location, and points to the README for the full routing table.

## Routing (now canonical)

| Consumer | Reads from |
|---|---|
| Unit-04 `COVERAGE-MAPPING.md` (SC → AC → scenario chain) | `features/*.feature` (5 canonical) |
| Development-stage step definitions for user behaviors | `features/*.feature` (5 canonical) |
| Development-stage contract regression harness | `outputs/features/*.feature` (8 supplementary) + `outputs/DATA-CONTRACTS.md` |
| Adversarial reviewers checking AC coverage | `features/*.feature` (5 canonical) |

## Files changed

- `stages/product/outputs/features/README.md` (created) — directory disambiguation + routing table
- `stages/product/outputs/DATA-CONTRACTS.md` (Appendix A added) — cross-reference to the README and the 5 canonical files
