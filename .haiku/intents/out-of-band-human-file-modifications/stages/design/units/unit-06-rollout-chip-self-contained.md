---
title: Replace SPA-UI-SPECS cross-reference with inline chip description
model: haiku
closes:
  - FB-03
  - FB-13
inputs:
  - stages/design/artifacts/ROLLOUT-AND-BASELINE-ESTABLISHMENT.md
  - >-
    stages/design/feedback/03-rollout-and-baseline-establishment-md-references-spa-ui-spec.md
  - >-
    stages/design/feedback/13-fb-03-fix-loop-exhausted-assessor-disagreed-with-designer-s.md
outputs:
  - stages/design/artifacts/ROLLOUT-AND-BASELINE-ESTABLISHMENT.md
status: pending
---
# Replace SPA-UI-SPECS cross-reference with inline chip description

Edit `stages/design/artifacts/ROLLOUT-AND-BASELINE-ESTABLISHMENT.md` to remove the cross-artifact reference to SPA-UI-SPECS.md in the §4.x establish-mode chip discussion and replace it with a self-contained inline description. The fix-loop hats spent 3 bolts trying to either bridge the reference (path + anchor) or redefine it; the assessor still rejected on each pass. The simpler path is to make the rollout doc not depend on SPA-UI-SPECS.md at all for the chip's visual treatment.

This unit closes FB-03 (the original cross-reference complaint) and FB-13 (the meta-finding that the fix loop couldn't resolve FB-03 in 3 bolts).

## Scope

Apply ONE of the following to ROLLOUT-AND-BASELINE-ESTABLISHMENT.md §4 (whichever subsection currently references SPA-UI-SPECS.md):

- **Inline description path**: replace the SPA-UI-SPECS.md reference with a self-contained chip description. Example wording: "The 'drift detection initializing' indicator is a passive informational chip — a short text label inside a neutral container with the same visual treatment as the existing stage-card status chips. It carries no interactive affordance and disappears when the establish-mode tick completes. Detailed chip styling and tokens are owned by the development stage at implementation time."
- **Explicit deferral path** (acceptable alternative): replace the SPA-UI-SPECS.md reference with "Chip styling for the establish-mode indicator is intentionally deferred to the development stage's design-system pass; the indicator is a text label in a neutral container until then."

Either rewording must:
- Remove every textual reference to SPA-UI-SPECS.md from ROLLOUT-AND-BASELINE-ESTABLISHMENT.md
- Leave the rest of the document unchanged (ROLLOUT-AND-BASELINE-ESTABLISHMENT.md is otherwise sound per FB-03's reviewer note)
- Not introduce a new cross-reference to any other design artifact

## Completion Criteria

- ROLLOUT-AND-BASELINE-ESTABLISHMENT.md no longer contains the substring `SPA-UI-SPECS.md` anywhere — verifiable by `! grep -n 'SPA-UI-SPECS\.md' stages/design/artifacts/ROLLOUT-AND-BASELINE-ESTABLISHMENT.md` returning exit 0
- The chip description in the affected section is self-contained: a reader who only has ROLLOUT-AND-BASELINE-ESTABLISHMENT.md can understand what visual treatment the indicator uses (neutral container, text label, passive)
- The document's overall structure (sections, headings, ordering) is unchanged outside the affected paragraph
- Document length is within ±200 bytes of the prior version (the edit is a localized substitution, not a rewrite)
- FB-03 and FB-13 are closed by the feedback-assessor in the fix-loop chain (handled by the framework via the `closes:` frontmatter on this unit)
