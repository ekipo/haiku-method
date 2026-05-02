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
outputs: []
model: sonnet
quality_gates:
  - name: knowledge-upload-rejects-html-extension
    command: >-
      grep -qE
      'allowed.*extensions|allowedExtensions|extension.*allowlist|html.*reject|rejectExtension'
      packages/haiku/src/http/upload-routes.ts
  - name: stage-output-upload-rejects-html-extension
    command: >-
      grep -qE
      '\.html.*reject|reject.*\.html|allowedExtensions|allowed.*extensions'
      packages/haiku/src/http/upload-routes.ts
  - name: upload-mime-allowlist-defined
    command: >-
      grep -qE 'ALLOWED_MIMES|allowedMimes|mimeAllowlist|MIME_ALLOWLIST'
      packages/haiku/src/http/upload-routes.ts
  - name: upload-size-cap-bounded
    command: >-
      bash -c 'grep -qE
      "HAIKU_UPLOAD_MAX_BYTES.*Math\\.min|MAX_UPLOAD_BYTES_HARD_CAP|uploadMaxBytesHardCap|hardCap.*upload"
      packages/haiku/src/http/upload-routes.ts'
  - name: upload-tests-for-rejected-extensions
    command: >-
      grep -rqE 'reject.*\.html|\.html.*reject|allowed.*extensions.*test'
      packages/haiku/test/upload-routes.test.mjs
  - name: haiku-suite-passes
    command: bun run --cwd packages/haiku test
status: pending
---
# Unit 01 — Upload content validation

## Scope

Close four vuln-report findings about the SPA upload paths in `packages/haiku/src/http/upload-routes.ts`:

- **V-01 (HIGH)** stored XSS via `/api/intents/:intent/uploads/knowledge` — `.html` upload renders inline because `serveFile`'s MIME map matches HTML.
- **V-02 (HIGH)** same class on `/api/intents/:intent/uploads/stage-output`.
- **V-07 (MED)** `HAIKU_UPLOAD_MAX_BYTES` has no upper bound — a 10GB upload combined with sync SHA-256 in the drift gate stalls the workflow tick.
- **V-09 (LOW)** unbounded `agent_rationale` writes bloat `DA-NN.json`.

## Approach

Add an explicit allowlist of (MIME, extension) tuples per upload route. Reject everything else with 415 Unsupported Media Type before writing to disk. Add a hard upper cap on `HAIKU_UPLOAD_MAX_BYTES` (e.g. `Math.min(envOrDefault, 50 * 1024 * 1024)` — 50 MB) so a misconfigured env can't enable the OOM/stall primitive. For V-09, cap `agent_rationale` at 4 KB before serialization.

## Completion criteria

- `packages/haiku/src/http/upload-routes.ts` defines an `ALLOWED_MIMES` (or equivalent) constant per route, rejecting `text/html`, `application/javascript`, etc., with 415.
- Reject `.html`, `.htm`, `.svg`, `.xml` extensions explicitly even when MIME spoofs to image/png.
- `HAIKU_UPLOAD_MAX_BYTES` is bounded by a constant hard cap (e.g. 50 MB); env values above the cap clamp down with a warning log.
- `agent_rationale` size cap enforced in the drift-assessment write path.
- New tests in `packages/haiku/test/upload-routes.test.mjs` cover: HTML upload rejected, oversize upload rejected, agent_rationale truncation.
- Full `bun run --cwd packages/haiku test` passes.

## Out of scope

- Rate limiting (V-08 covers CSRF/origin in unit-04).
- The `serveFile` MIME map itself (we reject at upload, not serve, so the MIME map can stay).

## References

- `.haiku/intents/out-of-band-human-file-modifications/knowledge/VULN-REPORT.md` (findings V-01, V-02, V-07, V-09)
- `packages/haiku/src/http/upload-routes.ts`
- `packages/haiku/test/upload-routes.test.mjs`
