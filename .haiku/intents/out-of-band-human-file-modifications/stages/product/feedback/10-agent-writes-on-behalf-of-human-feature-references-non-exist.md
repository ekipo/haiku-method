---
title: >-
  agent-writes-on-behalf-of-human.feature references non-existent field
  acknowledged_by
status: fixing
origin: adversarial-review
author: completeness
author_type: agent
created_at: '2026-04-29T03:43:16Z'
iteration: 1
visit: 1
source_ref: null
closed_by: null
bolt: 1
triaged_at: '2026-04-29T03:43:16Z'
resolution: null
replies: []
---

## Finding

`agent-writes-on-behalf-of-human.feature` line 88 contains:

```
Then for every baseline.json entry with acknowledged_by "human" or acknowledged_via "human-write-tool" there is a corresponding audit log entry
```

The field `acknowledged_by` does not exist in the `Baseline` schema. **DATA-CONTRACTS.md §2.1** defines the `Baseline` schema with these authorship fields:

- `author_class` — enum: `"agent" | "human-via-mcp" | "human-implicit"` (required)
- `acknowledged_via` — enum: `"agent-write" | "human-write-tool" | "spa-upload" | "classification-terminal" | "baseline-init"` (required)

There is no `acknowledged_by` field. The scenario on line 88 references a non-existent field and a non-canonical value ("human" is not a valid `author_class` value — the canonical value is `"human-via-mcp"`).

This is a completeness failure: the behavioral spec references schema fields that don't exist and enum values that are deprecated aliases (unit-02 reconciliation requirement 2 explicitly says no `user` / `external` / `manual` aliases; similarly `"human"` is not a canonical value).

## Required fix

`agent-writes-on-behalf-of-human.feature` line 88 must be rewritten using only canonical field names and values:

```
Then for every baseline.json entry with author_class "human-via-mcp" or acknowledged_via "human-write-tool" there is a corresponding audit log entry with a matching path, sha, and non-null user_instruction_excerpt
```
