---
title: Out-of-band human file modifications
studio: software
mode: continuous
autopilot: true
status: active
created_at: '2026-04-28'
stages:
  - inception
  - design
  - product
  - development
  - operations
  - security
active_stage: product
intent_reviewed: true
started_at: '2026-04-28T07:52:19-06:00'
---

# Out-of-band human file modifications

Users need a sanctioned way to modify intent-associated files outside the feedback loop — replacing stage outputs (figma/html/image), uploading knowledge into elaborate, or making small edits the agent should extend. Detection runs both ways: explicit (SPA upload UI, dedicated MCP tool, "hey claude write this file") and implicit (SHA baselines per stage stored in state, diffed by a pre-tick gate so pure filesystem drops are caught with no announcement). The workflow-managed file hook stays intact for agent writes (units/feedback/intent.md/state.json remain MCP-only); human writes via SPA/review-app/filesystem are out-of-band and not policed by hooks. On detected drift, a new workflow action `manual_change_assessment` fires — the agent reads the diff, classifies impact, and decides ignore / inline-fix / surface-as-FB / trigger revisit. Concurrency model is eventual-consistency: no locking, the next `haiku_run_next` tick observes drift and reacts. Sync surface: paper (new lifecycle concept), plugin (state baselines, pre-tick gate, new workflow action, MCP tool, SPA upload UI), website docs.

User invoked /haiku:autopilot from a parked worktree with no active intent matching the branch. Provided three motivating examples: designer replaces a layout, PO does a small edit + asks AI to extend, user uploads knowledge to inception. Confirmed scope decisions in a Q&A: detection is both explicit and implicit (must catch silent filesystem drops); SPA/review-app edits bypass hooks because they're out-of-band human actions; all three change types in scope; new workflow action (not FB-triage piggyback); software studio with full paper+plugin+website sync; UX = SPA upload UI + manual filesystem + Claude-writes-knowledge-out-of-band; concurrency = next run_next tick observes and reacts.
