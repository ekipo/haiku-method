---
title: Rollout & baseline-establishment design
model: sonnet
depends_on:
  - unit-01-architecture-spec
  - unit-03-tracked-surface-boundary
inputs:
  - intent.md
  - knowledge/DISCOVERY.md
  - knowledge/DESIGN-DECISIONS.md
  - stages/design/artifacts/ARCHITECTURE.md
  - stages/design/artifacts/TRACKED-SURFACE-BOUNDARY.md
outputs:
  - stages/design/artifacts/ROLLOUT-AND-BASELINE-ESTABLISHMENT.md
status: pending
---
# Rollout & baseline-establishment design

Specify how the drift-detection feature reaches a steady state without flooding existing intents with false-positive `manual_change_assessment` events on the first tick after upgrade. Inception's DISCOVERY.md flagged "false-positive storm" as a top-priority risk; this unit closes it. Output: a rollout plan the development stage implements as a one-time migration + ongoing first-tick semantics.

## Scope

The ROLLOUT-AND-BASELINE-ESTABLISHMENT.md must specify:

- **First-tick-after-upgrade behavior** — when an intent that pre-dates this feature reaches its first `haiku_run_next` tick on the new build, the pre-tick drift gate runs in establish mode: it walks every in-scope tracked path, computes SHA + author-class (defaulting to `agent` for files with no provenance, since they were written by agents on the old build), and writes the baseline. NO drift events fire. The next tick is the first tick that fires drift events for actual human edits.
- **Baseline-establishment markers** — the per-stage state file gains a `drift_baseline_established_at` field. Absence triggers establish mode; presence triggers normal drift mode. Field is monotonic (once set, never cleared except by explicit reset).
- **Establish-mode visibility** — the SPA shows "drift detection initializing" indicator on stages whose baseline is still being established (one-tick window). Removed once the baseline is set.
- **Existing-intent migration** — no separate migration script needed; the establish-mode logic handles every existing intent transparently on its next tick. Document this explicitly so the development stage doesn't accidentally write a one-time backfill.
- **Author-class backfill** — for files that pre-date the feature, `author-class: agent` is the safe default (no human-provenance signal). Document this explicitly: false-negative is acceptable (a human edit that pre-dates the upgrade looks like an agent write — no drift fired), false-positive is not (would flood the user).
- **Per-stage establish triggers** — when a NEW stage is added to an existing intent post-upgrade, that stage's first tick runs in establish mode for its tracked paths only. Cross-stage isolation: establishing one stage's baseline doesn't affect another's.
- **Reset semantics** — `/haiku:reset` and similar destructive operations clear the baseline along with everything else; the next tick re-establishes. Documented for completeness.
- **Steady-state metrics** — what an operator should see in a healthy steady state: baseline file count = tracked surface count; drift events per tick averages near 0 in agent-only operation; spike on human edit; settles back to 0 within one tick after classification.
- **Failure-mode rollback** — if the feature has a bug that fires false drift events at scale, the disable path: a feature flag in plugin settings (`drift_detection: false`) makes the pre-tick gate a no-op. Document the flag's name and behavior.
- **Telemetry** — what events the system records to enable post-rollout debugging: baseline-established, drift-detected, classification-emitted, baseline-updated. Format: structured log entries; no separate telemetry pipeline.

## Completion Criteria

- ROLLOUT-AND-BASELINE-ESTABLISHMENT.md exists at `stages/design/artifacts/ROLLOUT-AND-BASELINE-ESTABLISHMENT.md` and is at least 3KB of substantive prose
- Document specifies first-tick establish-mode behavior with explicit detail on what fires and what doesn't (baselines yes, drift events no)
- Document specifies the `drift_baseline_established_at` per-stage field and the rule that determines establish vs normal mode
- Document specifies that no separate migration script is needed and explicitly tells the development stage not to write one
- Document specifies the author-class backfill rule (default `agent` for pre-feature files) with the rationale (false-negative acceptable, false-positive not) cited from DISCOVERY.md's "false-positive storm" risk
- Document specifies per-stage establish-mode isolation (a new stage on an existing intent re-establishes only its own baseline)
- Document specifies reset semantics (`/haiku:reset` clears baselines) and the disable feature flag (`drift_detection: false`) with its name and one-line behavior
- Document specifies steady-state metrics an operator can observe to confirm health
- Document specifies the telemetry event names and shape (structured log entries) — no separate telemetry pipeline
- Document does NOT contain TypeScript file paths, function signatures, or shell commands — capability-level rules and named fields/flags only
- Document is internally consistent with ARCHITECTURE.md and TRACKED-SURFACE-BOUNDARY.md
