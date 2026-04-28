---
title: Drift-detection architecture spec
model: sonnet
inputs:
  - intent.md
  - knowledge/DISCOVERY.md
  - knowledge/DESIGN-DECISIONS.md
  - knowledge/IMPLEMENTATION-MAP.md
  - stages/design/knowledge/DESIGN-BRIEF.md
outputs:
  - stages/design/artifacts/ARCHITECTURE.md
status: pending
---
# Drift-detection architecture spec

Produce a formal architecture spec — `stages/design/artifacts/ARCHITECTURE.md` — that defines how the system detects, classifies, and reacts to out-of-band human file modifications. This is the load-bearing technical-design document the development stage will implement against. It locks down: where baselines are stored, when the pre-tick gate fires, how the new workflow action is wired in, and what the four classification outcomes do to the baseline.

## Scope

The ARCHITECTURE.md must specify:

- **Baseline storage layer** — abstract data shape (per-stage map of tracked-file-path → content hash + author-class), where it lives in the existing state directory hierarchy, when it's written (after every agent write), when it's read (pre-tick gate). Do not dictate format-specific details (JSON vs SQLite vs other) — name the contract, defer format to development.
- **Pre-tick drift-detection gate** — sits in the existing pre-tick gate chain alongside feedback-triage. Order: tamper-detection → feedback-triage → drift-detection → per-state dispatch. Spec what the gate computes (current SHA per tracked file, diff against baseline), what it emits (drift event with file path + diff summary + author-class), what blocks the tick if drift is observed.
- **`manual_change_assessment` workflow action** — input shape (list of drift events from the gate), output shape (per-event classification: `ignore` / `inline-fix` / `surface-as-feedback` / `trigger-revisit`), where the action sits in the workflow-engine action set, how the agent is dispatched to perform the classification (autonomous — no user buttons; the agent classifies during normal `haiku_run_next` flow).
- **Classification outcome semantics** — for each of the four outcomes, define exactly:
  - What the agent does (writes a fix into the next bolt? logs a feedback FB? calls `revisit()` on an upstream stage?)
  - What happens to the baseline (when does it update; deferred-marker behavior for non-terminal outcomes)
  - What the user sees (passive indicator only — drift badge / banner; no Accept/Reject/Surface button)
- **Baseline-update contract** — explicit rules per outcome (terminal: immediate baseline update; non-terminal: pending-assessment marker; closure of the marker on resolution).
- **Author-class tracking** — how the system distinguishes "agent wrote this file" from "human wrote this file" (the human-attributed-write MCP tool stamps a marker; SPA uploads stamp via the upload pathway; silent filesystem drops are inferred as human-class because no agent stamp exists).
- **Concurrency model** — eventual consistency, no locking. If the agent is mid-bolt when a human edit lands, the next tick reconciles. Document the partial-state risk explicitly.
- **Failure modes** — what happens if the baseline is missing (first-tick: establish, do not fire), corrupt (refuse to advance, escalate), or out of sync (re-baseline as "drift-detected" event with a trigger-revisit default).

## Completion Criteria

- ARCHITECTURE.md exists at `stages/design/artifacts/ARCHITECTURE.md` and is at least 6KB of substantive prose
- Document specifies the baseline storage contract: data shape (tracked-file-path → SHA + author-class + last-updated-tick), location (under the intent's existing state directory), write triggers (after every agent write to a tracked file), read triggers (pre-tick gate)
- Document specifies the pre-tick gate's position in the gate chain (relative to tamper-detection and feedback-triage) and the gate's emit shape (drift event)
- Document specifies the `manual_change_assessment` action's input/output JSON shape and where it sits in the workflow-engine action enum
- Document specifies all four classification outcomes (ignore / inline-fix / surface-as-feedback / trigger-revisit) with: agent action, baseline behavior, user-visible signal — for each outcome
- Document specifies the baseline-update contract per outcome — terminal outcomes update baseline immediately; non-terminal outcomes (surface-as-FB, trigger-revisit) write a pending-assessment marker that closes on resolution; the steady-state-loop risk from DISCOVERY.md is addressed
- Document specifies the author-class field with three values (`agent`, `human-via-mcp`, `human-implicit`) and the rule for inferring `human-implicit` (any baseline-tracked file whose SHA changed without an intervening agent stamp)
- Document specifies the eventual-consistency concurrency model and explicitly acknowledges mid-bolt partial-state work as a documented behavior, not a bug
- Document specifies failure-mode handling for missing/corrupt/out-of-sync baseline cases, including the first-tick-after-deploy "establish, don't fire" rule
- Document does NOT contain TypeScript file paths under `packages/haiku/src/`, function signatures, or shell commands — those belong in development-stage units. Working labels (action names, field names) are permitted.
- Document is internally consistent with DESIGN-DECISIONS.md — every decision recorded there shows up in the architecture, and no architectural choice contradicts a recorded decision
