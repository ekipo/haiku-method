---
title: Discovery document
model: sonnet
inputs:
  - intent.md
  - knowledge/CONVERSATION-CONTEXT.md
outputs:
  - .haiku/intents/out-of-band-human-file-modifications/knowledge/DISCOVERY.md
status: pending
---
# Discovery Document

Produce the canonical DISCOVERY.md knowledge artifact for the out-of-band human file modifications intent. The discovery captures problem space, business context, competitive landscape, considerations & risks, and UI impact at the level the design stage will consume — WHAT and WHY, not HOW. This unit ratifies the artifact already written by the discovery fan-out subagent and ensures it meets the verifier's substance/citation/consistency bar.

## Scope

The DISCOVERY.md must cover:

- Business context — feature goal & vision, origin, success criteria (functional + outcome-based, observable by users)
- Competitive landscape — at least Cursor, Aider, GitHub Copilot Workspace, Devin, Figma+Code Connect, Notion/Coda AI, IDE agents (Cody/Continue), each with a one-paragraph approach summary and a real URL
- Considerations & risks — strategic considerations (compliance, rollout, behavior change for existing intents), capability needs (per-stage SHA baseline storage, per-tick diff detection, classification capability, sanctioned upload UI, sanctioned "agent writes on behalf of human" tool, diff presentation, rejection/acknowledgment record), open questions framed for the design stage to answer, risks at the strategic/product level
- UI impact — affected surfaces (browse SPA upload, knowledge upload, drift assessment view, chat, docs)
- Overlap awareness — scan of active haiku branches for file-level overlap

The artifact may NOT contain entity field names, API endpoints, file paths within `packages/haiku/src/`, code-archaeology summaries, performance budgets in implementation terms, or any specific shell commands. Those belong in design / development.

## Completion Criteria

- DISCOVERY.md exists at `.haiku/intents/out-of-band-human-file-modifications/knowledge/DISCOVERY.md` and is at least 8KB of substantive prose
- Business context section names primary user roles affected (designer, product owner, knowledge-uploading user) and each of the three motivating scenarios from CONVERSATION-CONTEXT.md is captured by name
- Competitive landscape names ≥6 specific products with a real URL each, a one-paragraph differentiation summary, and an explicit "what they do well" + "gap" pair
- Risks section lists ≥7 distinct failure modes — false-positive storm, classification loop, eventual-consistency surprise, mid-bolt concurrency, classification quality / trust erosion, non-tracked files, binary-diff blindness, hook bypass becoming a liability — each with a one-paragraph description
- Open questions section has ≥7 questions, each framed for design to answer, none paper over scope gaps with prose
- Capability needs section names ≥6 high-level dependencies at the capability level (not implementation level), e.g. "per-stage SHA baseline storage" not "a JSON file at .haiku/intents/{slug}/baselines.json"
- Cross-cutting boundary callouts to sibling artifacts (workflow engine, security/hooks) are present and explicitly do NOT author substance there
- Document distinguishes problem space from any specific solution: no entity field names, no file paths under `packages/haiku/src/`, no API method shapes, no shell commands
- Document ends with an Overlap Awareness section reporting the result of the active-branch scan
