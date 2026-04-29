---
title: Behavioral specifications (Gherkin features)
model: sonnet
depends_on:
  - unit-01-acceptance-criteria
inputs:
  - intent.md
  - knowledge/DISCOVERY.md
  - stages/design/artifacts/ARCHITECTURE.md
  - stages/design/artifacts/SPA-UI-SPECS.md
  - stages/design/artifacts/MCP-TOOL-CONTRACT.md
  - product/ACCEPTANCE-CRITERIA.md
outputs:
  - >-
    .haiku/intents/out-of-band-human-file-modifications/features/silent-filesystem-drop-detection.feature
  - >-
    .haiku/intents/out-of-band-human-file-modifications/features/explicit-spa-upload.feature
  - >-
    .haiku/intents/out-of-band-human-file-modifications/features/agent-writes-on-behalf-of-human.feature
  - >-
    .haiku/intents/out-of-band-human-file-modifications/features/manual-change-assessment.feature
  - >-
    .haiku/intents/out-of-band-human-file-modifications/features/drift-assessment-visibility.feature
status: pending
---
# Behavioral specifications (Gherkin features)

Ratify the 5 Gherkin `.feature` files produced by the behavioral-spec discovery (already merged at `.haiku/intents/out-of-band-human-file-modifications/features/`) and ensure each one is implementation-ready: scenarios use domain language consistent with the design specs, every AC from unit-01 has at least one matching scenario, edge cases and error paths are covered, and step phrasing is consistent across files so the development stage's step-definition layer can be uniform.

## Scope

The 5 feature files cover the full behavioral surface of this intent. Each must be:

- **silent-filesystem-drop-detection.feature** — implicit pre-tick SHA-baseline drift detection. Covers the 3 motivating scenarios (designer replaces layout, PO edits and asks AI to extend, user uploads knowledge), edge cases (editor temp files, baseline-establishment first-tick, multi-file ticks, mid-bolt timing, deletions, mime-only changes for binaries).
- **explicit-spa-upload.feature** — SPA upload affordance with per-stage availability scenario outline, replace-vs-upload semantics, hook-bypass invariant, size limit, locked worktree, archived intent.
- **agent-writes-on-behalf-of-human.feature** — sanctioned haiku_human_write_file-style MCP tool semantics, authorship integrity, audit log, refusals (workflow-managed paths, escape paths, empty content), interactive vs autopilot mode integrity stances.
- **manual-change-assessment.feature** — agent classification into the four canonical outcomes (ignore / inline-fix / surface-as-feedback / trigger-revisit), cross-stage cascade decision, idempotency loop avoidance, binary diff degraded mode, pagination cap.
- **drift-assessment-visibility.feature** — SPA drift assessment view, pending/outcome badges, chat-surface notifications in autopilot, noise control for many-ignore runs.

## Completion Criteria

- All 5 .feature files exist at the declared output paths and are valid Gherkin (parseable by Cucumber)
- Each .feature file has at least one error scenario in addition to happy-path scenarios
- Steps use domain language consistent with the inception/design artifacts: terms `manual_change_assessment`, `pre-tick out-of-band gate`, `tracked surface`, `eventual consistency`, `haiku_run_next`, the four classification outcomes verbatim
- Step phrasing is consistent across files for the same underlying action
- Actors are named roles (Designer, Product Owner, User, Reviewer, Agent, Workflow Engine) — never bare "user"
- Scenario Outlines are used wherever the behavior is parameterized (per-stage upload availability)
- Each AC-G* general rule and AC-EE* edge case from product/ACCEPTANCE-CRITERIA.md has at least one matching scenario (traceability checked by unit-04 coverage-validation)
- No feature file inlines schema definitions or HTTP/MCP request shapes — those belong in DATA-CONTRACTS.md (cite by reference)
- No feature file inlines design decisions or architectural rationale — feature files are behavioral, not justificatory
