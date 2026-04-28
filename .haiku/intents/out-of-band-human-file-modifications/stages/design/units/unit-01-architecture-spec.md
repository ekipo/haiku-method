---
title: Drift-detection architecture spec
model: sonnet
inputs: >-
  ["stages/design/DESIGN-BRIEF.md", "knowledge/DISCOVERY.md",
  "knowledge/DESIGN-DECISIONS.md", "knowledge/IMPLEMENTATION-MAP.md"]
outputs:
  - stages/design/artifacts/ARCHITECTURE.md
status: active
bolt: 1
hat: designer
started_at: '2026-04-28T15:30:35Z'
hat_started_at: '2026-04-28T15:30:35Z'
iterations:
  - hat: designer
    started_at: '2026-04-28T15:30:35Z'
    completed_at: null
    result: null
---
# Drift-detection architecture spec

Produce a formal architecture spec — `stages/design/artifacts/ARCHITECTURE.md` — that defines how the system detects, classifies, and reacts to out-of-band human file modifications. This is the load-bearing technical-design document the development stage will implement against. It locks down: where baselines are stored, when the pre-tick gate fires, how the new workflow action is wired in, what the four classification outcomes do to the baseline, where classification records are stored, what happens on ambiguous diffs, and how the kill-switch flag interacts with the gate.

## Scope

The ARCHITECTURE.md must specify:

- **Baseline storage layer** — abstract data shape (per-stage map of tracked-file-path → content hash + author-class + last-updated-tick), where it lives in the existing state directory hierarchy, when it's written (after every agent write), when it's read (pre-tick gate). Do not dictate format-specific details (JSON vs SQLite vs other) — name the contract, defer format to development.
- **Pre-tick drift-detection gate** — sits in the existing pre-tick gate chain alongside feedback-triage. Order: tamper-detection → feedback-triage → drift-detection → per-state dispatch. Spec what the gate computes (current SHA per tracked file, diff against baseline), what it emits (drift event with file path + diff summary + author-class), what blocks the tick if drift is observed.
- **`manual_change_assessment` workflow action** — input shape (list of drift events from the gate), output shape (per-event classification: `ignore` / `inline-fix` / `surface-as-feedback` / `trigger-revisit`), where the action sits in the workflow-engine action set, how the agent is dispatched to perform the classification (autonomous — no user buttons; the agent classifies during normal `haiku_run_next` flow).
- **Classification outcome semantics** — for each of the four outcomes, define exactly:
  - What the agent does (writes a fix into the next bolt? logs a feedback FB? calls `revisit()` on an upstream stage?)
  - What happens to the baseline (when does it update; deferred-marker behavior for non-terminal outcomes)
  - What the user sees (passive indicator only — drift badge / banner; no Accept/Reject/Surface button)
- **Baseline-update contract** — explicit rules per outcome (terminal: immediate baseline update; non-terminal: pending-assessment marker; closure of the marker on resolution).
- **Author-class tracking** — how the system distinguishes "agent wrote this file" from "human wrote this file" (the human-attributed-write MCP tool stamps a marker; SPA uploads stamp via the upload pathway; silent filesystem drops are inferred as human-class because no agent stamp exists).
- **Classification-record durability and location** — where the agent's classification of each drift event is recorded so the SPA can render a drift-history view and the record survives branch operations / worktree switches. Pick a stance and document it: either (a) a new `stages/{stage}/drift/` directory with one record per classification (paralleling `feedback/`), or (b) an append-only log embedded in the stage's `state.json`. Justify the pick against the durability requirement (records must survive `git checkout` between stage branches and `/haiku:revisit`-driven branch reuse).
- **Ambiguous-diff fallback behavior** — when the agent cannot confidently classify a diff (e.g., binary file replacement, large-scale restructuring that could be intentional or accidental), the default outcome is `surface-as-feedback` with a `cannot-determine-intent` note in the FB body. Document this as the fifth fallback path; it is not a fifth classification outcome (it's surface-as-feedback with a specific reason code).
- **Concurrency model** — eventual consistency, no locking. If the agent is mid-bolt when a human edit lands, the next tick reconciles. Document the partial-state risk explicitly.
- **Failure modes** — what happens if the baseline is missing (first-tick: establish, do not fire), corrupt (refuse to advance, escalate), or out of sync (re-baseline as "drift-detected" event with a trigger-revisit default).
- **Kill-switch integration** — the architecture must reference the `drift_detection: false` plugin-settings flag (specced in detail in unit-05's ROLLOUT-AND-BASELINE-ESTABLISHMENT.md). When set, the pre-tick gate becomes a no-op (does not compute SHAs, does not emit drift events, does not gate the tick). The two artifacts together form a consistent pair — the architecture knows the gate can be disabled; the rollout doc names the flag and its purpose.

## Completion Criteria

- ARCHITECTURE.md exists at `stages/design/artifacts/ARCHITECTURE.md` and is at least 6KB of substantive prose
- Document specifies the baseline storage contract: data shape (tracked-file-path → SHA + author-class + last-updated-tick), location (under the intent's existing state directory), write triggers (after every agent write to a tracked file), read triggers (pre-tick gate)
- Document specifies the pre-tick gate's position in the gate chain (relative to tamper-detection and feedback-triage) and the gate's emit shape (drift event)
- Document specifies the `manual_change_assessment` action's input/output JSON shape and where it sits in the workflow-engine action enum
- Document specifies all four classification outcomes (ignore / inline-fix / surface-as-feedback / trigger-revisit) with: agent action, baseline behavior, user-visible signal — for each outcome
- Document specifies the baseline-update contract per outcome — terminal outcomes update baseline immediately; non-terminal outcomes (surface-as-FB, trigger-revisit) write a pending-assessment marker that closes on resolution; the steady-state-loop risk from DISCOVERY.md is addressed
- Document specifies the author-class field with three values (`agent`, `human-via-mcp`, `human-implicit`) and the rule for inferring `human-implicit` (any baseline-tracked file whose SHA changed without an intervening agent stamp)
- Document specifies the classification-record durability and location with a chosen stance (drift directory OR state.json append-log) and a rationale citing branch-operation survival
- Document specifies the ambiguous-diff fallback behavior (default to `surface-as-feedback` with a `cannot-determine-intent` reason code) and gives ≥2 examples (binary replacement, large restructure)
- Document specifies the eventual-consistency concurrency model and explicitly acknowledges mid-bolt partial-state work as a documented behavior, not a bug
- Document specifies failure-mode handling for missing/corrupt/out-of-sync baseline cases, including the first-tick-after-deploy "establish, don't fire" rule
- Document references the `drift_detection: false` kill-switch flag (named in unit-05) and specifies the gate's no-op behavior when the flag is set
- Document does NOT contain TypeScript file paths under `packages/haiku/src/`, function signatures, or shell commands — those belong in development-stage units. Working labels (action names, field names) are permitted.
- Document is internally consistent with DESIGN-DECISIONS.md — every decision recorded there shows up in the architecture, and no architectural choice contradicts a recorded decision
