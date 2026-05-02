---
title: 'Symlink TOCTOU + CSRF/origin protection (V-04, V-08, V-10, V-11)'
depends_on: []
inputs:
  - .haiku/intents/out-of-band-human-file-modifications/knowledge/VULN-REPORT.md
  - packages/haiku/src/state-tools.ts
  - packages/haiku/src/http/upload-routes.ts
  - packages/haiku/src/http/default-routes.ts
  - packages/haiku/src/orchestrator/workflow/drift-baseline.ts
outputs: []
model: sonnet
quality_gates:
  - name: human-write-realpath-resolves-before-mkdir
    command: >-
      bash -c 'grep -nE "haiku_human_write" packages/haiku/src/state-tools.ts |
      head -1 >/dev/null && grep -qE
      "realpathSync|fs\\.realpath|resolvedPath.*startsWith"
      packages/haiku/src/state-tools.ts'
  - name: csrf-origin-check-on-spa-post-routes
    command: >-
      grep -qE
      'allowed.*origin|originAllowlist|checkOrigin|sameOriginCheck|csrf'
      packages/haiku/src/http/upload-routes.ts
  - name: feedback-creates-body-sanitized
    command: >-
      grep -qE
      'sanitize.*feedback|feedback.*sanitize|stripDangerousMd|stripHtml'
      packages/haiku/src/http/feedback-api.ts
  - name: baseline-corrupt-not-silent-auto-establish
    command: >-
      bash -c 'grep -nE "baseline_corrupt"
      packages/haiku/src/orchestrator/workflow/drift-baseline.ts | head -1
      >/dev/null && ! grep -qE
      "baseline_corrupt.*silent.*establish|silent.*establish.*after.*corrupt"
      packages/haiku/src/orchestrator/workflow/drift-baseline.ts'
  - name: haiku-suite-passes
    command: bun run --cwd packages/haiku test
status: pending
---
# Unit 03 — Symlink TOCTOU + CSRF/origin protection

## Scope

Close four vuln-report findings:

- **V-04 (MED)** `haiku_human_write` symlink-escape check skips when parent dir doesn't exist; `mkdirSync(recursive: true)` then follows planted symlinks → TOCTOU write-outside-intent.
- **V-08 (MED)** No CSRF protection on POST routes; `?t=<jwt>` query-param token + multipart-form-data + no Origin check = classic cross-origin form auto-submit.
- **V-10 (LOW)** `feedback_creates[].body` from agent isn't sanitized server-side (defense-in-depth — agent could inject HTML/JS into feedback that the SPA later renders).
- **V-11 (LOW)** baseline-corrupt → silent auto-establish on next tick is an attacker primitive (corrupt baseline → fresh baseline blesses any modification).

## Approach

For V-04: in `haiku_human_write`, before the `mkdirSync(parent, { recursive: true })`, walk the path components and verify with `realpathSync` (with safe fallback) that no resolved component escapes the intent root. If parent doesn't exist, create the path component-by-component, calling `realpathSync` on each created leg before continuing.

For V-08: add an Origin allowlist check on every SPA POST route. Reject when `Origin` header is missing or not in the allowlist (env-configured: `HAIKU_ALLOWED_ORIGINS`, default `http://localhost:*`). Document why JWT-as-query-param is acceptable here (review-app session model) but Origin still required as defense-in-depth.

For V-10: add a server-side sanitization step on `feedback_creates[].body` (strip `<script>`, `<iframe>`, dangerous attributes; keep markdown safe). Reuse whatever the SPA is using to render — if SPA renders raw markdown, mirror its sanitization on input.

For V-11: when the gate detects `baseline_corrupt`, do NOT silently auto-establish on the next tick. Require explicit `haiku_repair` or `drift_detection: false` ack. Add a `baseline_corrupt_acknowledged` flag to stage state.json that the auto-establish path checks.

## Completion criteria

- `haiku_human_write` resolves and validates real paths before creating directories.
- All SPA POST routes (`/api/intents/:intent/uploads/*`, `/api/feedback`, etc.) check Origin against allowlist.
- `feedback_creates[].body` is sanitized server-side before write.
- Baseline-corrupt no longer silently auto-establishes; requires explicit acknowledgment.
- New tests cover: symlink-escape rejected, missing-Origin rejected, sanitized feedback body, baseline-corrupt requires ack.
- Full `bun run --cwd packages/haiku test` passes.

## References

- VULN-REPORT.md V-04, V-08, V-10, V-11
- `packages/haiku/src/state-tools.ts` (haiku_human_write)
- `packages/haiku/src/http/upload-routes.ts`, `default-routes.ts`, `feedback-api.ts`
- `packages/haiku/src/orchestrator/workflow/drift-baseline.ts`
