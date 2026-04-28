---
title: Implementation map
model: sonnet
depends_on:
  - unit-01-discovery-document
  - unit-02-design-decisions
inputs:
  - intent.md
  - knowledge/DISCOVERY.md
  - knowledge/DESIGN-DECISIONS.md
outputs:
  - >-
    .haiku/intents/out-of-band-human-file-modifications/knowledge/IMPLEMENTATION-MAP.md
status: pending
---
# Implementation Map

Map the change surface across the three project components — paper, plugin, website — at the topology level. This is NOT the design (no file paths under `packages/haiku/src/`, no method signatures, no schemas). It is the WHO touches WHAT and WHY at the section/concept granularity, so the design stage can plan the actual implementation against a known shape of the work.

## Scope

The IMPLEMENTATION-MAP.md identifies, for each component, the conceptual surfaces this intent will modify or extend, with a one-paragraph description per surface. Component buckets:

- **Paper** (`website/content/papers/haiku-method.md`) — which methodology sections are extended or revised. Candidates: Quality Enforcement (the new pre-tick gate alongside feedback-triage), Principles (eventual-consistency posture for human writes), Operating Modes (how autopilot reacts to drift), Glossary (terms like "manual change assessment", "tracked surface", "baseline").
- **Plugin** (the workflow engine, MCP tools, hooks, providers, browse SPA) — conceptual layers affected: state baseline storage, pre-tick gate registration alongside feedback-triage, new workflow action, new MCP tool for human-attributed writes, browse SPA upload and drift-assessment surfaces. Layer-level only — no specific TypeScript file paths.
- **Website** (`website/content/docs/`) — which user-facing doc pages need updates or additions. Candidates: a new "Out-of-band human edits" doc, updates to "Concepts" (new term), updates to "Workflows" (drift detection cycle), updates to operating-modes doc (autopilot interaction).

For each surface, the map records:

- **Component** (paper / plugin / website)
- **Surface name** (section anchor for paper/website, conceptual layer for plugin)
- **Change type** (new section / extended section / new doc / new layer / extended layer)
- **One-paragraph description** of what the surface needs to cover, written so the design stage knows what to plan against
- **Cross-component links** when a paper section, a plugin capability, and a website doc all describe the same concept (sync discipline)

## Completion Criteria

- IMPLEMENTATION-MAP.md exists at `.haiku/intents/out-of-band-human-file-modifications/knowledge/IMPLEMENTATION-MAP.md` and is at least 3KB of substantive prose
- Document covers all three components — paper, plugin, website — each with ≥3 affected surfaces
- Plugin section identifies ≥5 conceptual layers: state baseline storage, pre-tick gate, new workflow action, new MCP tool for human-attributed writes, browse SPA upload + drift-assessment views
- Paper section identifies ≥3 sections to extend or revise, each named with the methodology section anchor and a one-paragraph description of the change
- Website section identifies ≥3 doc pages with the change type for each (new doc / extended doc) and a one-paragraph description
- Each surface entry includes a one-paragraph description that states WHAT needs to be there, written for the design stage's consumption — no implementation specifics
- Cross-component sync table or list identifies which paper section, plugin layer, and website doc map to each major concept (manual change assessment, tracked surface, baseline, drift classification)
- Document does NOT specify TypeScript file paths under `packages/haiku/src/`, function signatures, JSON schemas, database tables, or shell commands — those are design-stage artifacts
- Document is internally consistent with DISCOVERY.md and DESIGN-DECISIONS.md — no surface is mapped that contradicts a decision recorded in DESIGN-DECISIONS.md
