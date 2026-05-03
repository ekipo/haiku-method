---
title: >-
  Upload content validation: MIME/extension allowlist + size cap (V-01, V-02,
  V-07, V-09)
depends_on: []
inputs:
  - .haiku/intents/out-of-band-human-file-modifications/knowledge/VULN-REPORT.md
  - >-
    .haiku/intents/out-of-band-human-file-modifications/features/explicit-spa-upload.feature
  - packages/haiku/src/http/upload-routes.ts
  - packages/haiku/src/http/default-routes.ts
  - packages/haiku/src/http/assessments-routes.ts
  - packages/haiku/src/http/path-safety.ts
outputs: []
model: sonnet
quality_gates:
  - name: v01-v02-allowed-mimes-defined
    command: >-
      grep -qE 'ALLOWED_MIMES|allowedMimes|MIME_ALLOWLIST'
      packages/haiku/src/http/upload-routes.ts
  - name: v01-v02-html-extension-rejected-test-named
    command: >-
      grep -qE 'rejects.*\.html|html.*rejected|text/html.*415'
      packages/haiku/test/upload-routes.test.mjs
  - name: v07-upload-max-bytes-hard-cap
    command: >-
      grep -qE
      'MAX_UPLOAD_BYTES_HARD_CAP|Math\.min.*HAIKU_UPLOAD_MAX_BYTES|uploadHardCap'
      packages/haiku/src/http/upload-routes.ts
  - name: v07-oversize-clamp-test-named
    command: >-
      grep -qE
      'clamps.*oversize|HAIKU_UPLOAD_MAX_BYTES.*clamp|hard.*cap.*upload'
      packages/haiku/test/upload-routes.test.mjs
  - name: v09-rationale-cap-10kb-and-excerpt-cap-1kb
    command: >-
      bash -c 'grep -qE
      "agent_rationale.*10\\s*\\*\\s*1024|10240|MAX_RATIONALE_BYTES"
      packages/haiku/src/state-tools.ts && grep -qE
      "rationale_excerpt.*1024|MAX_RATIONALE_EXCERPT_BYTES"
      packages/haiku/src/state-tools.ts'
  - name: v09-list-endpoint-truncates-rationale
    command: >-
      grep -qE
      'truncate.*rationale|rationale.*truncate|listView.*rationale|TRUNCATE_RATIONALE'
      packages/haiku/src/http/assessments-routes.ts
  - name: v09-rationale-too-long-test-named
    command: >-
      grep -qE
      'rationale.*too.*long|rationale.*over.*KB.*reject|agent_rationale.*reject'
      packages/haiku/test/state-tools-handlers.test.mjs
  - name: haiku-suite-passes
    command: bun run --cwd packages/haiku test
status: pending
---
# Unit 01 — Upload content validation

## Scope

Close four vuln-report findings about the SPA upload paths in `packages/haiku/src/http/upload-routes.ts`:

- **V-01 (HIGH)** stored XSS via `/api/intents/:intent/uploads/knowledge` — `.html` upload renders inline because `serveFile`'s MIME map matches HTML.
- **V-02 (HIGH)** same class on `/api/intents/:intent/uploads/stage-output`.
- **V-07 (MED)** `HAIKU_UPLOAD_MAX_BYTES` has no upper bound — a misconfigured 10GB env value combined with sync SHA-256 in the drift gate stalls the workflow tick.
- **V-09 (LOW)** unbounded `agent_rationale` AND `rationale_excerpt` writes bloat `DA-NN.json`; the assessments-list endpoint reads them all back unsummarized.

## Approach

1. **MIME/extension allowlist** (V-01, V-02): define per-route `ALLOWED_MIMES` constants in `upload-routes.ts`. Reject everything else with 415 before writing. Reject `.html`, `.htm`, `.svg`, `.xml`, `.xhtml`, `.mhtml` extensions explicitly even when MIME spoofs.
2. **Hard cap on upload size** (V-07): `MAX_UPLOAD_BYTES_HARD_CAP = 50 * 1024 * 1024` (50 MB). Effective cap = `Math.min(envValue, MAX_UPLOAD_BYTES_HARD_CAP)`. Log clamp event to telemetry when env exceeds cap.
3. **Rationale schema caps** (V-09 fix #1): in `haiku_classify_drift` (state-tools.ts), reject `agent_rationale > 10 KB` and per-classification `rationale_excerpt > 1 KB` at schema-validation time with `agent_rationale_too_long` / `rationale_excerpt_too_long` structured errors. The 10 KB/1 KB sizes match the report's recommendation.
4. **List-endpoint truncation** (V-09 fix #2): in `assessments-routes.ts` list handler, truncate `agent_rationale` and `rationale_excerpt` to a list-view-safe length (256 chars + `…`); return full fields only on per-id detail endpoint.

## Out of scope (deferred to unit-04 ASSESSMENTS.md residual risk)

- Inverting `serveFile`'s MIME map to "only known-safe types render inline; everything else is `application/octet-stream` + `Content-Disposition: attachment`" (VULN-REPORT V-01 fix #2).
- Adding `Content-Security-Policy: default-src 'none'; sandbox; frame-ancestors 'none'` headers on served knowledge artifacts (V-01 fix #3).
- Sandboxed sub-origin for stage-output HTML mockups (V-02).

These serve-side defenses are real defense-in-depth gaps but the upload-side allowlist closes the primary attack vector. Unit-04's ASSESSMENTS.md MUST file a `stage_revisit` FB tagged "follow-up: serve-side hardening" against a future security iteration.

## Completion criteria

- `packages/haiku/src/http/upload-routes.ts` defines `ALLOWED_MIMES` per route + extension blocklist.
- `MAX_UPLOAD_BYTES_HARD_CAP` constant defined; effective cap clamps env values via `Math.min`.
- `agent_rationale` and `rationale_excerpt` rejected at schema-validation time with structured errors per the byte caps above.
- `assessments-routes.ts` list handler truncates both rationale fields.
- New tests in `packages/haiku/test/upload-routes.test.mjs` cover: HTML upload rejected (415), oversize upload clamped, MIME spoof rejected.
- New tests in `packages/haiku/test/state-tools-handlers.test.mjs` cover: rationale-too-long structured error.
- Full `bun run --cwd packages/haiku test` passes.

## References

- VULN-REPORT.md V-01, V-02, V-07, V-09
- `packages/haiku/src/http/upload-routes.ts`, `assessments-routes.ts`, `path-safety.ts`
- `packages/haiku/src/state-tools.ts` (haiku_classify_drift schema)
- `packages/haiku/test/upload-routes.test.mjs`, `state-tools-handlers.test.mjs`
