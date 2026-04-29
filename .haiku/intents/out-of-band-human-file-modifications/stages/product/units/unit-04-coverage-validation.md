---
title: Coverage validation
model: sonnet
depends_on:
  - unit-01-acceptance-criteria
  - unit-02-behavioral-specs
  - unit-03-data-contracts
inputs:
  - intent.md
  - knowledge/DISCOVERY.md
  - knowledge/DESIGN-DECISIONS.md
  - stages/design/artifacts/ARCHITECTURE.md
  - stages/design/artifacts/SPA-UI-SPECS.md
  - stages/design/artifacts/MCP-TOOL-CONTRACT.md
  - stages/design/artifacts/TRACKED-SURFACE-BOUNDARY.md
  - stages/design/artifacts/ROLLOUT-AND-BASELINE-ESTABLISHMENT.md
  - product/ACCEPTANCE-CRITERIA.md
  - product/DATA-CONTRACTS.md
  - knowledge/COVERAGE-MAPPING.md
outputs:
  - >-
    .haiku/intents/out-of-band-human-file-modifications/product/COVERAGE-MAPPING.md
status: pending
---
# Coverage validation

Promote the coverage-mapping discovery artifact (`knowledge/COVERAGE-MAPPING.md`) into the product-stage canonical location (`product/COVERAGE-MAPPING.md`) and validate that every success criterion from the upstream specs has a matching artifact in the product stage's outputs. This unit is the product stage's terminal traceability check: if any AC, .feature scenario, or DATA-CONTRACTS entity is missing or orphaned, the gate doesn't open.

## Scope

COVERAGE-MAPPING.md must contain:

- **Full coverage matrix** — one row per success criterion (SC-N) sourced from intent goal, DESIGN-DECISIONS.md (DEC-1..DEC-9), and design unit completion criteria (DESN-01..DESN-06). Every SC-N row maps to:
  - The AC-N entry in `product/ACCEPTANCE-CRITERIA.md` that asserts it
  - The .feature scenario(s) in `.haiku/intents/{slug}/features/*.feature` that demonstrate it
  - The DC-N entity/contract in `product/DATA-CONTRACTS.md` that schemas it (when applicable — non-data SCs may have empty DC column)
- **Orphan detection** — every AC, scenario, and DC entry must trace back to at least one SC-N. Orphans are flagged as either spec-creep (drop) or missing-SC (add).
- **Gap detection** — every SC-N must have at least one AC, one scenario, and (when applicable) one DC entry. Gaps are blockers.
- **Out-of-scope dispositions** — explicit list of SCs intentionally deferred to later stages (development, operations, security) with disposition rationale
- **Validation outcome** — terminal section: `APPROVED` (no gaps, no orphans) or `GAPS FOUND` (list of unblock conditions)

## Completion Criteria

- COVERAGE-MAPPING.md exists at `.haiku/intents/out-of-band-human-file-modifications/product/COVERAGE-MAPPING.md` and is at least 5KB of substantive prose
- File contains a coverage matrix with ≥6 capability domains and ≥40 SC-N rows (Detection, Classification & Response, Write Paths, Tracked Surface & Rollout, User-Visible SPA Signals, Cross-cutting & Non-functional)
- Every row has populated AC-N column (or explicit "deferred to {stage}") and feature-scenario column (or explicit "data-only, no scenario")
- Every row has populated DC-N column for data-bearing SCs; non-data SCs explicitly state "n/a (no data contract)"
- Orphan-detection section lists every AC and scenario that doesn't trace to an SC, OR explicitly asserts "no orphans found" with a reproducible verification command
- Gap-detection section lists every SC missing AC/scenario/DC coverage, OR explicitly asserts "no gaps found" with a reproducible verification command
- Out-of-scope dispositions section names every SC intentionally deferred with disposition (development / operations / security) and rationale
- Document ends with a Validation Outcome section that is either `APPROVED` (and explicitly confirms zero gaps + zero orphans) or `GAPS FOUND` (and lists the blocker conditions)
- File is consistent with the actual on-disk artifacts — no SC references an AC-N or scenario name that doesn't exist in `product/ACCEPTANCE-CRITERIA.md` or `features/*.feature`
