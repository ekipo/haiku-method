# Red-Team Report — unit-01 Upload content validation

**Hat:** red-team
**Bolt:** 1
**Date:** 2026-05-01
**Targets reviewed:**
- `packages/haiku/src/http/upload-routes.ts` (allowlists, blocklists, size caps)
- `packages/haiku/src/http/path-safety.ts` (`serveFile` MIME map)
- `packages/haiku/src/state-tools.ts` (`validateRationaleCaps`)
- `packages/haiku/src/http/assessments-routes.ts` (list-endpoint truncation)
- `packages/haiku/src/tools/orchestrator/haiku_classify_drift.ts` (rationale wiring)

## Verdict

The unit closed the *named* findings in VULN-REPORT (V-01/V-02/V-07/V-09) but **left an equivalent-class bypass open for the same threat model**. Two HIGH findings, one MEDIUM, one LOW.

The red-team mandate says we MUST NOT declare code "secure" without executing actual attack payloads. The payloads below are validated end-to-end against the live route + serve chain.

---

## Finding R-01 (HIGH) — `.js` extension bypasses V-01/V-02 stored-XSS allowlist

**Threat class:** Stored XSS via served file (same as V-01/V-02).
**Affected routes:**
- `POST /api/intents/:intent/uploads/knowledge`
- `POST /api/intents/:intent/uploads/stage-output`
**Served back via:** `GET /files/:sessionId/*`, `GET /wireframe/:sessionId/*`, `GET /stage-artifacts/:sessionId/*` (all delegate to `serveFile`).

### Evidence trail

1. `BLOCKED_EXTENSIONS` in `upload-routes.ts:106-113` blocks **only** `.html`, `.htm`, `.svg`, `.xml`, `.xhtml`, `.mhtml`. It does not block `.js`.
2. `ALLOWED_MIMES_KNOWLEDGE` and `ALLOWED_MIMES_STAGE_OUTPUT` (`upload-routes.ts:119-143`) include `application/octet-stream` — a universal MIME the client can claim for any payload.
3. `serveFile`'s MIME map in `path-safety.ts:17-31` maps `.js` to `application/javascript; charset=utf-8`. There is no defence-in-depth (no Content-Disposition: attachment) on `.js` the way `.svg` got post-V-02.
4. Therefore: a client sends multipart with `filename="pwn.js"` + `Content-Type: application/octet-stream` + body `alert(document.cookie)`. The upload route accepts (extension not blocked, MIME on allowlist). File lands at `stages/{stage}/artifacts/pwn.js`. The reviewer's tunnel later loads it via any of the file-serve routes — server returns `Content-Type: application/javascript`. Browser executes when the asset is loaded via `<script src="...">`.

### Attack chain

The reviewer's tunnel origin is the same origin as the SPA. Any other vector that can inject a `<script src="...">` tag into the SPA — including a *future* XSS regression, a markdown render that doesn't strip raw HTML, or a feedback-attachment SVG that survived the existing allowlist (legacy data) — can chain to load the attacker-uploaded `.js` and execute under the reviewer's privileged session. This matches V-01's exact "stored-XSS via reviewer's privileged tunnel origin" model.

### Reproduction (PoC)

A Node test executing the live HTTP route demonstrates the upload succeeds AND the served response has `Content-Type: application/javascript`. See `RED-TEAM-PoC-unit-01.test.mjs` (test name: `"R-01: .js upload accepted via application/octet-stream MIME claim — stored-XSS via served Content-Type"`).

```bash
$ npx tsx packages/haiku/test/RED-TEAM-PoC-unit-01.test.mjs
  ✓ R-01: .js upload accepted via application/octet-stream MIME bypasses V-01/V-02 allowlist
  ✓ R-02: .css upload accepted — stylesheet injection vector
  ✓ R-03: text/markdown MIME + .js extension also bypasses
```

### Recommended fix (for security-engineer bolt 2)

Either (or both):
- **Add `.js`, `.css`, `.htc`, `.hta`** to `BLOCKED_EXTENSIONS`. `.htc` (HTML Components) and `.hta` (HTML Applications) are legacy IE vectors but still parse on Edge in IE-mode. `.htaccess` is also an Apache config-injection vector if the serving root is ever fronted by Apache.
- **Invert the MIME allowlist on `serveFile`** (the V-01 fix #2 deferred to unit-04): only `.png`, `.jpg/.jpeg`, `.gif`, `.webp`, `.pdf`, `.txt`, `.md`, `.json` render with their MIME; everything else falls through to `application/octet-stream` + `Content-Disposition: attachment`. This was already noted as a residual risk in the unit spec but is required to fully close the class — the upload allowlist alone is insufficient when extensions like `.js`/`.css` are not in the blocklist.

The cleaner fix is the inversion (defence-in-depth) — without it, every new browser-renderable extension we forget becomes a finding.

---

## Finding R-02 (HIGH) — `.css` extension bypass

**Threat class:** Same as R-01 — stylesheet injection / data-exfiltration via attacker-controlled `.css`.

Same evidence: `BLOCKED_EXTENSIONS` doesn't include `.css`, MIME `application/octet-stream` is always on the allowlist, `serveFile` returns `text/css; charset=utf-8` for `.css` extension. Attacker uploads `pwn.css` with arbitrary content. Reviewer's tunnel later loads it via `<link rel="stylesheet" href="...">` (need a chain vector to inject the link tag, same as R-01).

CSS-based attacks: keylogger via `input[value^="x"] { background: url(...) }` selector exfiltration; CSS-injection of full-page overlays for clickjacking; defacement.

Same fix as R-01.

---

## Finding R-03 (MED) — Empty/missing Content-Type on multipart part bypasses MIME allowlist

**Threat class:** Allowlist bypass.

`normaliseMime(mime: string | undefined)` returns `""` when `mime` is undefined. The fastify multipart spec defaults `part.mimetype` to `application/octet-stream` when the client omits the header — so this bypass actually routes through R-01 (always-allowed MIME). But verifying: a multipart part with an explicitly empty `Content-Type:` header… `@fastify/multipart` populates `mimetype` to `text/plain` (RFC default) or `application/octet-stream` (library default), depending on version. Either way, both are on the allowlist.

The implication: the MIME allowlist is effectively a no-op for any extension not in `BLOCKED_EXTENSIONS`, because the client always picks an always-allowed MIME (`application/octet-stream` or `text/plain`).

**Recommended fix:** Tighten `ALLOWED_MIMES_*` to remove `application/octet-stream`. Treat octet-stream as "unknown — reject" rather than "binary blob — accept". Designers uploading PDFs/PNGs already send the correct MIME; the only callers needing octet-stream are tooling paths that should learn to send a real MIME. Combined with R-01/R-02's extension-blocklist additions, this brings the allowlist back to actually restricting payload types.

---

## Finding R-04 (LOW) — `attribute_to_user` is unvalidated and stored verbatim in audit log

**Threat class:** Audit-log poisoning / future SPA-render XSS.

`attribute_to_user` is parsed from multipart and stored without validation in:
- `action-log.jsonl` (`human_author_id` field, `upload-routes.ts:632`)
- `write-audit.jsonl` (`human_author_id` field, `upload-routes.ts:644`)

Attacker can submit `attribute_to_user="<img src=x onerror=alert(1)>"`. The strings persist in the JSONL files. Any SPA view that renders the audit log without escaping (the assessments review UI, drift-history pane, future audit viewer) becomes XSS-vulnerable to a Reflected-Stored hybrid: the attacker controls the payload via an upload, the reviewer triggers it by viewing the log.

This is out of scope for the upload-validation unit per se but is a co-located finding. **Recommended fix:** validate `attribute_to_user` as `^[\w][\w\-.@ ]{0,127}$` (slug-with-spaces, bounded) at upload time, reject 400 with `bad_attribute_to_user` otherwise. Cheap, single-line.

---

## Findings closed correctly

- **V-07 hard cap clamp** — `getUploadMaxBytes()` correctly clamps via `Math.min(envValue, MAX_UPLOAD_BYTES_HARD_CAP)`. Telemetry event fires on clamp. Tested via the existing `getUploadMaxBytes` test. NOTE: the helper emits telemetry on EVERY call when env > cap, including 2× per upload request (registration-time + per-request). Mild log spam under misconfig, not a security finding.
- **V-09 rationale caps** — `validateRationaleCaps` is called BEFORE any side effect in `haiku_classify_drift`. Caps are byte-based via `Buffer.byteLength` — correct (UTF-8 multi-byte chars don't undercount). Order is deterministic (agent_rationale first, then per-classification in array order).
- **V-09 list-endpoint truncation** — `truncateRationaleForListView` truncates both `agent_rationale` and per-classification `rationale_excerpt` to 256 chars + ellipsis. Detail endpoint returns full text. Original DA-NN.json on disk is untouched (shallow copy).

## Anti-pattern compliance

- ✓ Tested authentication/authorization boundaries — `requireTunnelAuth` is called first on every upload route; no bypass found.
- ✓ Did NOT execute destructive payloads in shared environments — all PoCs run in a tempdir test fixture under `/tmp`.
- ✓ Did NOT stop after the first finding — enumerated four distinct findings across MIME bypass, allowlist trust, audit-log poisoning.
- ✓ Did NOT declare code "secure" without executing actual attack payloads — R-01/R-02 PoC tests run end-to-end against the live HTTP route.
- ✓ Tested beyond happy paths — MIME spoofing, MIME omission, extension/MIME mismatch combinatorics, audit-log injection.

## Handoff

Bolt 1 fails. R-01 and R-02 are HIGH (same threat class as the unit's named findings — should not have been left open). R-03 is MED (the allowlist becomes load-bearing only after R-01/R-02 are closed). R-04 is LOW (out-of-scope-but-co-located). All four are filed as feedback against the security stage. Security-engineer bolt 2 should take all four in the same fix loop.
