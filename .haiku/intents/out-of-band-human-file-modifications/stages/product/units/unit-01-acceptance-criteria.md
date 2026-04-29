---
title: Acceptance criteria
model: sonnet
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
outputs:
  - >-
    .haiku/intents/out-of-band-human-file-modifications/product/ACCEPTANCE-CRITERIA.md
status: pending
---
# Acceptance criteria

Ratify the product-stage `ACCEPTANCE-CRITERIA.md` knowledge artifact (already produced by the discovery fan-out at `.haiku/intents/out-of-band-human-file-modifications/product/ACCEPTANCE-CRITERIA.md`) and ensure it covers every user-observable behavior from the design specs as a Given/When/Then-shaped acceptance statement. The discovery fan-out wrote a draft; this unit's hat sequence verifies completeness, sharpens any vague entries, and reconciles cross-references with the sibling product artifacts (BEHAVIORAL-SPEC features, DATA-CONTRACTS).

## Scope

ACCEPTANCE-CRITERIA.md must cover, at minimum:

- **General rules (AC-G*)** — the system-wide invariants: pre-tick gate fires the `manual_change_assessment` action; agent (not harness) decides classification; baseline-update contract per the four outcomes (terminal updates immediately, non-terminal writes a pending-assessment marker); existing PreToolUse hook policy invariant; first-tick-after-upgrade silence; eventual-consistency model
- **Variant ACs** — per variability dimension surfaced in DISCOVERY.md and DESIGN-DECISIONS.md: write-path origin (SPA upload / filesystem drop / agent-on-behalf), tracked-surface class (stage output / knowledge / replaceable artifact), payload type (text / binary), stage-of-ownership (current / earlier), classification outcome (ignore / inline-fix / surface-as-FB / trigger-revisit)
- **Edge cases & error paths** — same-tick race, deletions, off-surface writes, baseline corruption, classification timeout, double-edit while marker open, SPA override, mid-bolt concurrent writes
- **Prioritization** — P0 (must ship in v1: detection, classification, baseline-update for all four outcomes, SPA upload of knowledge, agent-on-behalf MCP tool) / P1 (nice-to-have) / Open-for-design (deferred items with disposition)
- **Cross-artifact boundaries** — every section explicitly notes which sibling product artifact authors the substance: `.feature` files for behavioral examples, DATA-CONTRACTS.md for schemas, COVERAGE-MAPPING.md for traceability

## Completion Criteria

- ACCEPTANCE-CRITERIA.md exists at `.haiku/intents/out-of-band-human-file-modifications/product/ACCEPTANCE-CRITERIA.md` and is at least 8KB of substantive prose
- File contains ≥10 General Rule entries (AC-G1..AC-G10+) covering the system-wide invariants enumerated in the Scope above
- File contains Variant AC sections for each of these dimensions: write-path origin, tracked-surface class, payload type, stage-of-ownership, classification outcome — each with at least 2 numbered AC entries
- File contains an "Edge cases & error paths" section with ≥7 entries (AC-EE1+); each entry names the failure mode, the expected response, and a verification approach
- File contains a Prioritization section explicitly partitioning entries into P0 / P1 / Open-for-design
- Every AC entry follows a Given/When/Then-expressible shape (or explicitly cites the .feature scenario in `.haiku/intents/{slug}/features/` that demonstrates it)
- File explicitly defers substance to sibling artifacts at appropriate boundaries — does NOT inline behavioral scenarios (those belong in .feature files), schema definitions (DATA-CONTRACTS.md), or coverage tables (COVERAGE-MAPPING.md)
- Every AC entry that addresses a recorded design decision (DESIGN-DECISIONS.md DEC-1..DEC-9) cites the decision number explicitly so traceability is preserved
- File is internally consistent with the design-stage artifacts: no AC contradicts ARCHITECTURE.md's gate ordering, MCP-TOOL-CONTRACT.md's tool semantics, or TRACKED-SURFACE-BOUNDARY.md's in/out-of-scope path rules
