---
title: Design decisions
model: sonnet
depends_on:
  - unit-01-discovery-document
inputs:
  - intent.md
  - knowledge/CONVERSATION-CONTEXT.md
  - knowledge/DISCOVERY.md
  - stages/inception/decision_log.json
outputs:
  - >-
    .haiku/intents/out-of-band-human-file-modifications/knowledge/DESIGN-DECISIONS.md
status: pending
---
# Design Decisions

Distill the architectural decisions reached in the elaboration Q&A and the discovery research into a structured DESIGN-DECISIONS.md. This is the inception-stage record of "what we decided before design started" — the design stage consumes it as authoritative input rather than re-litigating these choices. Each decision states the alternatives considered, the chosen path, and the rationale. No implementation specifics — those belong to design and development.

## Scope

The DESIGN-DECISIONS.md must capture, at minimum, decisions across these axes:

- **Detection model** — explicit (UI / dedicated tool / "claude write this") AND implicit (per-stage SHA baseline diffed by a pre-tick gate). Both modes are required because silent filesystem drops must be caught with no announcement.
- **Edit-surface boundary** — workflow-managed files (units, feedback, intent.md, state.json) remain MCP-only at the agent level via the existing PreToolUse hook; humans editing via SPA / review-app / direct filesystem are out-of-band and not policed by hooks.
- **Reaction mechanism** — a new workflow action `manual_change_assessment` is introduced (NOT piggybacked onto feedback-triage). The agent classifies the diff into one of four outcomes: ignore, inline-fix, surface-as-feedback, trigger-revisit.
- **Concurrency model** — eventual consistency. No locking. The next `haiku_run_next` tick's pre-tick gate observes drift and reacts. Mid-bolt concurrency is acceptable; the agent's mid-bolt work may be partially based on the pre-edit version.
- **Cascade policy** — when drift is detected on a stage earlier than the active stage, the classification step decides whether to trigger a revisit or surface as feedback; the agent owns the decision, not the harness.
- **Three change-type coverage** — designer replaces output, product owner does small edit + asks AI to extend, user uploads knowledge. All three in scope for v1; all three resolve through the same `manual_change_assessment` action with different agent classifications.
- **UX surface composition** — SPA upload UI + manual filesystem drops + agent-writes-knowledge-via-MCP-tool-on-user-instruction. All three paths feed the same detection model; the implicit baseline gate is the unifier.
- **Sync surface** — full three-component change: paper (new lifecycle concept), plugin (baselines, gate, action, tool, SPA upload), website (docs).

For each decision, the document records:

- The decision itself (one or two sentences)
- The alternatives that were considered and rejected
- The rationale citing the specific risk or capability the decision addresses

## Completion Criteria

- DESIGN-DECISIONS.md exists at `.haiku/intents/out-of-band-human-file-modifications/knowledge/DESIGN-DECISIONS.md` and is at least 4KB of substantive prose
- Document captures ≥7 decisions covering: detection model, edit-surface boundary, reaction mechanism (new action vs feedback-triage piggyback), concurrency model, cascade policy, three-change-type coverage, UX surface composition, sync surface scope
- Each decision section names the chosen path, lists ≥1 rejected alternative with a one-line reason, and a rationale citing either a specific risk from DISCOVERY.md or a specific capability need
- Document references DISCOVERY.md for each major risk/capability cited, with a section anchor or quoted phrase — no naked claims
- Document does NOT specify file paths under `packages/haiku/src/`, MCP tool method names, JSON schemas, database column names, or shell commands — those are design-stage artifacts
- Document explicitly addresses the four `manual_change_assessment` outcomes (ignore / inline-fix / surface-as-FB / trigger-revisit) at a behavioral level (when each fires, what the agent does in each case)
- Document records the eventual-consistency model with the explicit acknowledgment that mid-bolt concurrency may produce partial-state work
- Document ends with an "Open for design" section listing decisions deliberately deferred to design (e.g., specific tracked-surface boundary, exact storage location of baselines, baseline-establishment-on-upgrade behavior)
