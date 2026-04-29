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
status: active
bolt: 1
hat: specification
started_at: '2026-04-29T02:43:18Z'
hat_started_at: '2026-04-29T02:52:42Z'
iterations:
  - hat: product
    started_at: '2026-04-29T02:43:18Z'
    completed_at: '2026-04-29T02:52:42Z'
    result: advance
  - hat: specification
    started_at: '2026-04-29T02:52:42Z'
    completed_at: null
    result: null
---
# Acceptance criteria

Ratify and complete the product-stage `ACCEPTANCE-CRITERIA.md` (already drafted by discovery at `product/ACCEPTANCE-CRITERIA.md`). The discovery wrote a strong scaffold; this unit closes specific reconciliation gaps the pre-execute review surfaced — DEC-9 stance, `surface-as-feedback` baseline contract, pending-revisit active-stage transition, `outputs/` vs `artifacts/` alias.

## Reconciliation gaps to close (READ FIRST)

The pre-execute review on this unit surfaced cross-document inconsistencies that must be resolved here:

1. **DEC-9 closure (Trust+Audit stance).** AC-AB4 currently says the Decision-9 stance is deferred. DEC-9 is now resolved: v1 ships **Trust+Audit** (agent can call the human-write tool freely; git blame is the audit trail). Replace AC-AB4 with concrete acceptance criteria that assert: (a) the agent's invocation does not require an interrupt-driven human confirmation in v1, (b) every invocation appends to a per-intent audit log, (c) the audit log is human-readable and append-only.
2. **`surface-as-feedback` baseline behavior.** ARCHITECTURE.md §5.4 says: when the agent classifies a finding as `surface-as-feedback`, the baseline is **NOT** updated at classification time. A pending-assessment marker is written instead. The marker clears (and the baseline updates) only when the linked feedback transitions to a terminal state. AC-G4 / AC-SF* must reflect this exactly — no AC may say "baseline updated immediately on surface-as-feedback".
3. **Pending-revisit active-stage transition.** AC-G5 currently describes marker clearing but does not specify the active-stage state while a `trigger-revisit` marker is open. Add an AC stating: when a `trigger-revisit` marker is open against an upstream stage, the active stage transitions to `awaiting-revisit-resolution` (or the equivalent state ARCHITECTURE.md §5.5 names). The marker clears when the revisited stage's gate re-passes.
4. **`outputs/` vs `artifacts/` alias.** TRACKED-SURFACE-BOUNDARY.md §0 declares `artifacts/` canonical and `outputs/` an alias. Add an AC asserting: any AC, scenario, or contract that uses `stages/{stage}/outputs/` is implementation-equivalent to `stages/{stage}/artifacts/`; new code MUST write to `artifacts/`.
5. **`addressed` vs `closed` for marker clearing.** ARCHITECTURE.md §5.3 lists terminal states for marker clearing. Existing FB lifecycle has `addressed` distinct from `closed`. AC-G5 currently includes both; clarify which transition triggers marker clearing — pick the conservative path: `closed` and `rejected` clear; `addressed` does NOT (because addressed FBs can still be reopened).

## Scope

ACCEPTANCE-CRITERIA.md must cover:

- **General rules (AC-G*)** — pre-tick gate fires `manual_change_assessment`; agent owns classification; baseline-update contract per the four outcomes (terminal updates immediately, non-terminal writes pending-assessment marker); existing PreToolUse hook policy invariant; first-tick-after-upgrade silence; eventual-consistency model
- **Variant ACs** — per dimension: write-path origin, tracked-surface class, payload type, stage-of-ownership, classification outcome
- **Edge cases & error paths (AC-EE*)** — same-tick race, deletions, off-surface writes, baseline corruption, classification timeout, double-edit while marker open, SPA override (AC-EE7 even at P1)
- **Trust+Audit AC (replaces AC-AB4)** — DEC-9 resolved
- **`outputs/` vs `artifacts/` AC** — alias canonicalization
- **Active-stage state during pending-revisit** — workflow transition spec
- **Prioritization** — P0 / P1 / Open-for-design

## Completion Criteria

- ACCEPTANCE-CRITERIA.md exists at `product/ACCEPTANCE-CRITERIA.md` and is at least 8KB of substantive prose
- ≥10 General Rule entries (AC-G1+) covering system-wide invariants
- Variant AC sections for each dimension (write-path origin, tracked-surface class, payload type, stage-of-ownership, classification outcome) — each with ≥2 entries
- ≥7 Edge case / error path entries (AC-EE1..AC-EE7+); AC-EE7 (SPA classification override) is present even though it is P1
- AC-AB4 removed and replaced with concrete Trust+Audit acceptance criteria for DEC-9 (audit log append, no interrupt confirmation in v1, human-readable + append-only audit log)
- AC explicitly states `surface-as-feedback` does NOT update baseline at classification time — verifiable by grep against the file: every AC that mentions `surface-as-feedback` either says "baseline NOT updated" or cites the pending-marker mechanism
- AC explicitly states the active-stage transition during a pending `trigger-revisit` marker (whatever ARCHITECTURE.md §5.5 names — `awaiting-revisit-resolution` or equivalent)
- AC explicitly documents the `outputs/` → `artifacts/` alias canonicalization rule
- AC explicitly states which feedback statuses (closed / rejected) clear pending-assessment markers and which (addressed) do NOT
- Every AC entry follows a Given/When/Then-expressible shape OR explicitly cites the .feature scenario that demonstrates it
- Every AC entry that addresses a recorded design decision (DESIGN-DECISIONS.md DEC-1..DEC-9) cites the decision number explicitly
- File is internally consistent with design-stage artifacts: no AC contradicts ARCHITECTURE.md gate ordering, MCP-TOOL-CONTRACT.md tool semantics, or TRACKED-SURFACE-BOUNDARY.md path rules
- File defers to sibling product artifacts at appropriate boundaries — no inline schemas (DATA-CONTRACTS.md), inline scenarios (.feature files), or inline coverage tables (COVERAGE-MAPPING.md)
