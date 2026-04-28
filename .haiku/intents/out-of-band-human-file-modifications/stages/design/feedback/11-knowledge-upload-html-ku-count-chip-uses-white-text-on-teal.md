---
title: >-
  knowledge-upload.html: ku-count-chip uses white text on teal-500 (~3.2:1) —
  fails 4.5:1 for 10px text
status: pending
origin: adversarial-review
author: accessibility
author_type: agent
created_at: '2026-04-28T20:32:17Z'
iteration: 1
visit: 1
source_ref: null
closed_by: null
bolt: 0
triaged_at: '2026-04-28T20:32:17Z'
resolution: null
replies: []
---

## Finding

The `ku-count-chip` in `wireframes/knowledge-upload.html` is styled as:

```css
.ku-count-chip {
  background: var(--color-upload-affordance-fg);  /* teal-500 family, oklch(62% 0.14 185) */
  color: white;
  font-size: 10px;
  font-weight: 600;
  ...
}
```

White text (`oklch(100% 0 0)`) on teal-500 (`oklch(62% 0.14 185)`) produces approximately 3.2:1 contrast. WCAG AA requires:
- **4.5:1** for normal text (text below 18pt / 14pt bold threshold)
- **3:1** for large text (18pt or 14pt bold)

`10px` at weight 600 does not meet the "large text" exception — it is well below 14pt bold (approximately 18.67px). The applicable threshold is **4.5:1**, which 3.2:1 fails.

`SPA-UI-SPECS.md §4.4` does not include the `ku-count-chip` foreground/background pair in its contrast table, so this combination was not verified during spec authoring.

The chip appears in multiple states: uploaded (line 528 with `aria-label="3 files staged"`), uploading (line 598, no aria-label), error (line 657, no aria-label), tablet (line 725, no aria-label), and mobile (line 772, no aria-label). The contrast failure affects all instances.

Additionally: most instances of `ku-count-chip` lack the `aria-label="N files staged"` annotation present only at line 528. A screen reader user encounters a standalone number ("3", "2", "1") without context on all other instances. This compounds the failing because the number alone is both low-contrast and contextually ambiguous.

## Required fix

1. Darken the chip background to teal-700 family (`oklch(~45% 0.14 185)`) to achieve ≥4.5:1 against white, OR switch to dark text on a lighter teal-100 background with sufficient contrast. Add the verified ratio to `SPA-UI-SPECS.md §4.4`.
2. Add `aria-label="N files staged"` to all `ku-count-chip` instances, not just the staged-files state. The pattern is established at line 528; propagate it.

## File:line references

- `wireframes/knowledge-upload.html:175–186` — `.ku-count-chip` CSS definition
- `wireframes/knowledge-upload.html:528` — only instance with `aria-label`; 598, 657, 725, 772 are missing it
- `artifacts/SPA-UI-SPECS.md:409–411` — §4.4 contrast table omits the chip token pair

