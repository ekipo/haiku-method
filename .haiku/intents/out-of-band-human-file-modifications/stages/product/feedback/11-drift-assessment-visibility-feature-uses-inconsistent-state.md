---
title: >-
  drift-assessment-visibility.feature uses inconsistent state names not grounded
  in Assessment schema
status: pending
origin: adversarial-review
author: completeness
author_type: agent
created_at: '2026-04-29T03:43:29Z'
iteration: 1
visit: 1
source_ref: null
closed_by: null
bolt: 0
triaged_at: '2026-04-29T03:43:29Z'
resolution: inline_fix
replies: []
---

## Finding

`drift-assessment-visibility.feature` uses three state names for the pending-revisit lifecycle that are inconsistent with each other and with the `Assessment.revisit_invoked_at` field defined in DATA-CONTRACTS.md §2.3:

- Line 44: `"pending-revisit"` — used for state before haiku_revisit is called (consistent with DATA-CONTRACTS.md)
- Line 49: `"revisit-triggered"` — used for state after haiku_revisit is called on the next tick
- Line 56: `"resolved"` — used for final state after the revisited stage re-passes its gate

**DATA-CONTRACTS.md §2.3** (reconciliation requirement R7) defines exactly two states:
- `pending-revisit`: `Assessment.outcome === "trigger-revisit"` AND `revisit_invoked_at IS NULL`
- `revisit-invoked`: `revisit_invoked_at` is set to a non-null timestamp

The feature file's `"revisit-triggered"` (line 49) does not match the contract's `"revisit-invoked"`. These are different identifiers and the feature file does not define a mapping. A third state `"resolved"` (line 56) is also undefined in DATA-CONTRACTS.md — the contract shows only two states in the Assessment lifecycle.

This is a completeness failure: the behavioral specification for the SPA's pending-revisit state transition does not use the canonical state names defined in the data contracts. The development stage cannot implement a consistent state machine from this spec.

## Required fix

`drift-assessment-visibility.feature` must use the canonical state names from DATA-CONTRACTS.md §2.3:
- `"pending-revisit"` (before `haiku_revisit` is called — correct at line 44)
- `"revisit-invoked"` (after `haiku_revisit` is called — replace `"revisit-triggered"` at line 49)
- Define or cite what `"resolved"` means (line 56) — this state name is not in the Assessment schema and needs either a definition or a reference to a named status transition
