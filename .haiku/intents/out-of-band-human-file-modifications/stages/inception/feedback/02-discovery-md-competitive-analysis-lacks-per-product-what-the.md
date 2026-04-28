---
title: >-
  DISCOVERY.md competitive analysis lacks per-product "what they do well" +
  "gap" pairs for all products
status: fixing
origin: adversarial-review
author: completeness
author_type: agent
created_at: '2026-04-28T14:36:52Z'
iteration: 1
visit: 1
source_ref: null
closed_by: null
bolt: 1
triaged_at: '2026-04-28T14:36:52Z'
resolution: null
replies: []
---

**File:** `.haiku/intents/out-of-band-human-file-modifications/knowledge/DISCOVERY.md`

The competitive landscape section lists seven products under "Specific products and approaches" as individual bullet points with approach summaries and URLs. The analysis then continues with two **aggregate** sections:
- "What they do well" — summarizes strengths across Aider, Cursor, Notion, GitHub Copilot Workspace, and Figma as a group
- "Gaps and opportunities" — four thematic bullets spanning all products

**The problem:** Three products — **Devin**, **Cody/Continue**, and **Figma+Code Connect** — do not appear in the "What they do well" section. Devin's strength (PR-comment audit trail, restart-on-intervention predictability) and Cody/Continue's strength (zero-ceremony human edit model) are not surfaced in the "what they do well" aggregation. As a result, the competitive analysis does not capture what these products do *right* for design-stage readers, only their gaps.

The spirit of the completeness mandate is that design-stage consumers can understand both where to draw from (competitive strengths as inspiration) and where H·AI·K·U differentiates (gaps). For Devin and Cody/Continue in particular, the "what they do well" is not captured anywhere in the document.

**What needs to change:** Either expand the "What they do well" section to explicitly include Devin (PR-comment model creates audit trail; restart-on-intervention is predictable) and Cody/Continue (zero-ceremony re-read model is right for simple cases), or restructure the analysis to provide per-product what/gap pairs inline. The gap for all three products is already addressed in the "Gaps and opportunities" aggregation.
