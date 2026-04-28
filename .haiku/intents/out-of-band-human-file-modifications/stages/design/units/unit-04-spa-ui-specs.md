---
title: 'SPA UI component specs (passive, no-action)'
model: sonnet
depends_on:
  - unit-01-architecture-spec
inputs:
  - intent.md
  - knowledge/DISCOVERY.md
  - knowledge/DESIGN-DECISIONS.md
  - stages/design/knowledge/DESIGN-BRIEF.md
  - stages/design/knowledge/DESIGN-TOKENS.md
  - stages/design/artifacts/ARCHITECTURE.md
  - stages/design/decision_log.json
outputs:
  - stages/design/artifacts/SPA-UI-SPECS.md
  - stages/design/artifacts/wireframes/knowledge-upload.html
  - stages/design/artifacts/wireframes/replacement-affordance.html
  - stages/design/artifacts/wireframes/drift-indicator.html
status: pending
---
# SPA UI component specs (passive, no-action)

Produce the concrete component specs and HTML wireframes for the three new SPA surfaces, locked to **Direction A: discrete + autonomous classification** per the design-stage decision register. Critical: per Decision 1 in this stage's decision log, **the UI surfaces are passive observers** — they show what was detected and what the agent decided. They do NOT contain "Run now ↻", "Assess", "Accept fix", "Surface as feedback", or "Ignore" buttons. The agent classifies and acts on the next tick automatically; the UI reflects state, it doesn't drive it.

## Scope

The SPA-UI-SPECS.md must specify, and the wireframes must demonstrate visually:

- **Knowledge Upload Panel**
  - Lives inside `FeedbackSidebar` (LEFT column of `ReviewPage`) as a collapsible `<details>` section below the existing feedback list
  - Drop-zone affordance: drag-and-drop on desktop, click-to-browse fallback everywhere
  - Staged-files list with destination selector (intent-scope vs. stage-scope knowledge)
  - On upload, file lands at the selected path stamped `human-via-mcp` author-class — NO confirmation dialog, NO classification preview; the next tick handles it
  - Mobile (≤375px): collapses to a single button that opens the existing `FeedbackSheet` with the upload UI as a sub-panel
  - States: default, dragover (highlight border), uploading (progress), uploaded (chip with filename), error (token-colored)
  - Tokens: `--color-upload-affordance-bg-resting` / `--color-upload-affordance-bg-hover` / `--color-upload-affordance-bg-dragover` (defined in DESIGN-TOKENS.md)
- **Stage Output Replacement Affordance**
  - Augments existing artifact cards in the `StageReview` Outputs tab
  - `⋯` menu on hover/focus reveals "Replace this output…" — opens a small modal with mime-matching drop zone
  - On drop, the file replaces the output and stamps `human-via-mcp` baseline — NO "this will be classified as inline-fix" preview; the agent decides on the next tick
  - Modal has an optional "note for the agent" field (becomes the rationale in the audit log)
  - States on the card itself: default, drift-detected (left border accent in `--color-drift-detected-bg` token), drift-acknowledged (subtle indicator that resolves on next tick)
  - Mime-mismatch handling: if the dropped file's mime doesn't match the original's, modal shows a one-line warning and a confirm checkbox; no auto-rejection
- **Drift-Detected Indicator** (passive)
  - Sticky strip between `StageBanner` and `RereviewBanner` — appears ONLY when the pre-tick gate has observed drift but `manual_change_assessment` has not yet run on the next tick
  - Content: "N file(s) changed since the last agent write — assessment runs on the next tick" (informational)
  - **NO "Run now ↻" button.** Per Decision 1, the user does not trigger assessment. The next normal `haiku_run_next` tick consumes the drift events and classifies.
  - Auto-disappears once the assessment completes; the per-file outcome is reflected in the artifact-card border accent (drift-acknowledged / drift-surfaced / drift-revisit)
  - Tokens: `--color-drift-detected-fg` / `--color-drift-detected-bg`
- **Cross-cutting requirements**
  - All three surfaces use existing tokens declared in DESIGN-TOKENS.md — no raw hex values
  - Touch targets ≥44×44 on ≤768px breakpoints via the existing `.touch-target` utility
  - Keyboard navigation: tab order documented for each surface
  - WCAG AA contrast on all token combinations (verifiable by automated checker against the OKLCH palette)
  - Reduced-motion: drift-indicator's appearance/disappearance respects the `prefers-reduced-motion` guard already in the SPA's `index.css`
  - Empty states: knowledge upload shows "drop files or click to browse" when zero files staged; replacement modal shows "drop a file matching {original-mime}" by default

## Completion Criteria

- SPA-UI-SPECS.md exists at `stages/design/artifacts/SPA-UI-SPECS.md` and is at least 5KB of substantive prose
- Three HTML wireframe files exist at `stages/design/artifacts/wireframes/{knowledge-upload,replacement-affordance,drift-indicator}.html`, each rendering at desktop (1280px) AND mobile (375px) breakpoints (single file with both via media queries OR two files)
- Each wireframe and the spec explicitly demonstrates the passive-observer constraint: NO "Run now", "Assess", "Accept", "Surface", "Ignore", or any other classification-triggering button on any of the three surfaces — verifiable by grep against the wireframe HTML for those phrases
- Spec specifies all interactive states (default, hover, focus, active, disabled, error, loading, empty, dragover, drift-detected, drift-acknowledged) for each surface
- Spec specifies responsive behavior at 375 / 768 / 1280 breakpoints for each surface, with explicit copy/layout differences (not "it's responsive")
- Spec lists the design tokens used per surface (referencing DESIGN-TOKENS.md) and confirms zero raw hex values appear in any wireframe — verifiable by grep `#[0-9a-fA-F]{3,6}` returning nothing in `stages/design/artifacts/wireframes/`
- Spec specifies tab order for keyboard navigation per surface and confirms touch targets ≥44px on mobile via the existing `.touch-target` utility
- Spec specifies reduced-motion behavior: the drift indicator's enter/exit animation respects `prefers-reduced-motion`
- Spec is internally consistent with Direction A (discrete) recorded in the design stage's `decision_log.json` — verifiable by inspection
- Spec is internally consistent with ARCHITECTURE.md — every UI signal corresponds to a known classification outcome or baseline state defined there
