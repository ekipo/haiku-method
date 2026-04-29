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

DATA-CONTRACTS.md §2.3 declared the `Assessment` schema append-only ("records are never modified after writing"), yet the same section described `resulting_sha` as "updated at marker-clearance time for non-terminal outcomes." Mutually exclusive.

`assessment_schema.feature` line 80 reinforced the contradiction with a scenario named "resulting_sha is updated at marker-clearance time for non-terminal outcomes."

## Root cause

Two pieces of state were colliding on one record. The `Assessment` is the immutable audit record of what the agent decided (DEC-9). The post-clearance SHA is a separate piece of state that arrives later and belongs on the clearance side.

## Fix applied (bolt 3)

Chose option (a) from the reviewer's two suggestions: keep `Assessment` truly append-only and move the post-clearance SHA off the Assessment record.

### Edits to DATA-CONTRACTS.md

- §2.3 `Assessment.resulting_sha`: typed as `string | null`. For terminal outcomes (`ignore`, `inline-fix`) it is the on-disk SHA at classification time; for non-terminal outcomes (`surface-as-feedback`, `trigger-revisit`) it is `null` and **never updated**. Append-only invariant restored.
- §2.3 worked example: `resulting_sha` shown as `null` (the example is a `surface-as-feedback` case).
- §2.2 `PendingMarker`: added `resolved_sha: string | null` field. Set atomically with `cleared_at` at clearance time. Includes a "Mutation contract" note clarifying that `PendingMarker` is intentionally not append-only — `cleared_at` and `resolved_sha` are the only mutation, set together exactly once, after which the record is logically frozen.
- §2.2 worked example: `resolved_sha: null` shown for the open marker.
- §3.5 cross-reference list: replaced the "Assessment.resulting_sha — updated at marker-clearance time" bullet with the new model and added §2.2 / §6.3 references.
- §4.3 atomic side-effect ordering steps 4, 6, 7: clarified that `Assessment.resulting_sha` is `null` for non-terminal outcomes at write time and never updated; the resolved SHA lands on `PendingMarker.resolved_sha` at clearance.
- §4.4 `haiku_baseline_clear_marker`: added explicit "Side effects" section documenting the atomic write of `cleared_at` + `resolved_sha`, baseline update to the same value, and event emission. Response now includes `resolved_sha`. Explicit statement: "The `Assessment` record is **never** modified by this tool."
- §6.3 `pending_marker_cleared` event: added `resolved_sha` field to the payload table and to the worked example.

### Edits to features/assessment_schema.feature

- Schema-completeness scenario: `resulting_sha` typed as "string or null".
- Replaced contradicting scenario "resulting_sha is updated at marker-clearance time for non-terminal outcomes" with two scenarios:
  - "resulting_sha is null at classification time for non-terminal outcomes"
  - "Assessment.resulting_sha remains null for non-terminal outcomes after marker clearance" (asserts the resolved SHA goes to `PendingMarker.resolved_sha` and the `pending_marker_cleared` event payload, not the Assessment).

### Edits to features/pending_marker_schema.feature

- Schema-completeness scenario: added `resolved_sha` (string or null) and corrected `cleared_at` to "RFC3339 or null".
- Clearance scenarios: added assertions that `resolved_sha` is set to the on-disk SHA, baseline equals `resolved_sha`, and the originating Assessment is not modified.
- Added scenario "PendingMarker.cleared_at and PendingMarker.resolved_sha are set together exactly once."

### Edits to features/internal_events.feature

- `pending_marker_cleared` schema scenario: added `resolved_sha` (string, required).
- Added scenario asserting that for non-terminal outcomes, `pending_marker_cleared.resolved_sha` is the canonical post-resolution SHA and Assessment.resulting_sha remains null.

## Result

Single coherent model: `Assessment` is now truly append-only with no internal contradiction; the post-resolution SHA for non-terminal outcomes lives on `PendingMarker.resolved_sha` and is carried through the `pending_marker_cleared` event. All five surfaces (disk schema, action payloads, MCP tools, HTTP API, events) and Gherkin specs agree.
