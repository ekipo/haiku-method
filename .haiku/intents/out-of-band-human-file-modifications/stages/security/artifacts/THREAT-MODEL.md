# THREAT-MODEL.md — Out-of-Band Human File Modifications

Synthesis artifact for the security stage. Companion to `VULN-REPORT.md`
(per-finding evidence) and `ASSESSMENTS.md` (per-fix audit trail).

This document enumerates threats by STRIDE category against the entry-point
features delivered by this intent, names the trust regions that determine
severity, calls out third-party dependency risk, and records the
load-bearing assumptions every V-NN severity rests on.

---

## 1. Trust regions (the load-bearing axis)

VULN-REPORT calls this out explicitly: "If the THREAT-MODEL artifact
concludes the tunnel-mode trust boundary is weaker than assumed... every
Medium and High severity here may need to be revised upward." This section
is the source of truth that fixes the reference frame for every other
severity rating.

### 1.1. Local mode (loopback, fully trusted)

- **Network surface**: HTTP server bound to `127.0.0.1` only.
  `isRemoteReviewEnabled()` returns `false`; no public URL exists.
- **Auth posture**: `requireTunnelAuth` and `verifyFeedbackMutationAuth`
  short-circuit to `true`. Anything that can reach the loopback port
  already has localhost code-execution privilege and is assumed equivalent
  to the local user.
- **Trust verdict**: any caller is trusted-equivalent to the operator.
  Out-of-band file writes through SPA routes or `haiku_human_write` MCP
  tool are treated the same as the operator running `vim` on the file —
  the audit log records the action but does not gate it.
- **Implication for severity**: V-01, V-02, V-08 are downgraded to
  *informational* under local mode (no remote attacker can reach the
  routes). V-03, V-04, V-05, V-06, V-07, V-09, V-10, V-11 remain as rated
  because they are reachable by the agent itself or by misconfiguration.

### 1.2. Tunnel mode (JWT-bound, attacker-reachable)

- **Network surface**: server reachable over a public localtunnel URL
  (`https://<random>.loca.lt`). `isRemoteReviewEnabled()` returns `true`.
- **Auth posture**: every request must present an HS256 JWT signed with
  `EPHEMERAL_SECRET`. Token may be supplied as `Authorization: Bearer ...`
  or `?t=<jwt>` query-string (the query-param path is the V-08 CSRF root).
- **Trust verdict**: any caller is *partially trusted* — they have proof
  of holding a valid token at some point in the tunnel's lifetime, but
  token leakage is in-scope (Slack pastes, screenshots, accidental
  commits). Tokens scoped to one session can target writes to a different
  intent unless `verifyFeedbackMutationAuth` cross-checks (see V-03 R-01
  finding for the historical bypass on the upload routes).
- **Implication for severity**: every High and Medium in VULN-REPORT
  assumes tunnel mode unless the finding's text says otherwise. If any of
  the trust assumptions in §1.4 weakens, the severity rises.

### 1.3. `EPHEMERAL_SECRET` lifecycle

- **Generated**: `randomBytes(32)` at MCP server process start
  (`packages/haiku/src/tunnel.ts:11`). 256-bit HMAC key.
- **Rotated**: never within a process lifetime. Rotation only happens at
  process restart — a new secret invalidates every prior JWT.
- **Lifetime**: equal to the MCP server process. Long-running sessions
  (e.g. `bun haiku serve` left up overnight) keep the same secret for the
  full duration.
- **On rotation (process restart)**: every previously-minted token fails
  signature verification (`bad_signature`). Reviewers must re-bootstrap.
  This is also the *implicit* expiry mechanism for tokens whose `exp`
  claim outlives the process — restart wins over claim TTL.
- **Storage**: in-memory only; never written to disk, never logged.
  Process-memory disclosure (heap dump, debugger attach) is the only path
  to extract the secret without forging a valid token first.
- **Threat**: long-lived processes with frequent reviewer hand-offs widen
  the secret-leak blast radius — every compromised reviewer who pasted a
  token into Slack within the same process lifetime contributed to the
  same key's exposure surface. Mitigation: rotate the process on a
  schedule (deferred — see ASSESSMENTS.md).

### 1.4. JWT claim semantics (`tun` and `sid`)

- **`tun` claim**: bound to the currently-active localtunnel URL at mint
  time. `verifyTunnelJWT` rejects with `tunnel_mismatch` if the active
  tunnel has rotated. An attacker who captures a token issued for
  tunnel-A cannot replay it against tunnel-B (which has a different URL)
  even if both share the same `EPHEMERAL_SECRET`.
- **`sid` claim**: bound to the issuing review session. The intent-scoped
  `/api/review/current` route accepts any valid `sid`; mutating routes
  (uploads, feedback writes) use `verifyFeedbackMutationAuth` /
  `verifyIntentMutationAuth` to require `sid` matches the URL's intent
  slug. Pre-R-01 fix (unit-02 blue-team), the SPA upload routes called
  `requireTunnelAuth` with `expectedSid: null`, allowing cross-session
  writes — that bypass is closed at commit `4e5af2b76`.
- **What an attacker cannot forge**: signature (no key access), `tun`
  rebind (active tunnel URL is server-controlled), `exp` extension
  (signature breaks on edit). Algorithm-confusion (`alg: none`) is
  rejected by explicit header validation (`tunnel.ts:135-148`).
- **What an attacker can do with a leaked token**: every action the
  binding `(tun, sid)` permits, until either the process restarts (kills
  `EPHEMERAL_SECRET`) or `exp` passes. That includes uploads, feedback
  writes, and audit-log poisoning via `attribute_to_user` / `claimed_author_id`.
- **Token visibility**: tokens travel in URLs (`?t=`) for cross-tab SPA
  links. URL-bound tokens are visible to browser history, server logs
  (Origin proxy chain), and screen captures. Mitigation: ban `?t=` on
  mutating verbs (V-08 fix #1, landed in unit-03).

### 1.5. Consequence rule (must hold for severities below to stand)

If any of the following weakens, every Medium and High in VULN-REPORT
must be re-rated upward:

1. The localtunnel URL leak rate is materially higher than "sometimes
   pasted in Slack" (e.g. routinely indexed by search engines, logged in
   shared monitoring) — if so, the V-08 CSRF surface widens because the
   attacker doesn't need to phish the URL.
2. The `EPHEMERAL_SECRET` is somehow extractable from process memory
   without prior code execution (heap dump in a multi-tenant container,
   debug endpoint) — if so, every signature guarantee collapses and
   every JWT-protected route becomes attacker-callable.
3. The `tun` claim binding becomes weaker (e.g. localtunnel URL is
   reused across MCP processes, defeating the post-restart invalidation)
   — if so, token reuse across processes becomes possible.
4. `sid` cross-binding regresses (e.g. a future refactor ships
   `verifyIntentMutationAuth` with `expectedSid: null` again) — if so,
   the cross-session write bypass returns at full severity.

This is the contract: as long as the four assumptions hold, severities
in VULN-REPORT are correct. ASSESSMENTS.md records the regression-test
gates that prove each assumption is enforced today.

---

## 2. Concurrency model — eventual consistency, accepted

The intent goal sentence "Concurrency model is eventual-consistency: no
locking, the next `haiku_run_next` tick observes drift" is load-bearing
for V-04 (TOCTOU symlink) and V-05 (tick-counter determinism).

**Decision**: option (a). Confirm eventual-consistency is the intentional
design, accept the residual TOCTOU window from V-04 as documented in the
deferred-risk register.

### 2.1. Why eventual consistency

- The MCP server, the SPA upload route, the agent (via `haiku_human_write`),
  and out-of-band human edits (`vim`, `git checkout`) all write to the
  same intent directory. A locking primitive that covers all four would
  need to be a pid-aware advisory lock (e.g. `flock`) honored by every
  writer — `vim` does not honor `flock`, so the locking primitive is
  fundamentally incomplete.
- The drift gate is the compensating control: every tick re-hashes
  tracked surface and reconciles against the baseline + action log. The
  gate runs *after* writes, observing the post-write state regardless of
  ordering.

### 2.2. Residual risk accepted

- **V-04 TOCTOU window**: the symlink-escape race between
  `lstat`-validation and `mkdirSync` / `rename` cannot be fully closed
  without `O_NOFOLLOW`-everywhere via `openat`/`renameat`. Unit-03's fix
  (`safeMkdirAndRename` helper, commit `573c91da1`) closes the
  single-shot easy case via `realpathSync` re-check after `mkdirSync` and
  before `rename`. A determined attacker holding write access to the
  intent directory and able to keep flipping a symlink in tight loop can
  still race. Acceptance rationale: an attacker with concurrent
  intent-directory write access has already breached a layer that the
  server treats as trusted.
- **V-05 entry-id collision window**: closed by
  `getIntentScopeTickCounter(intentDir)` (unit-02, commit `399c2ee13`)
  for SPA uploads with `stage === null`. The drift-gate consumer reads
  the union of per-stage and intent-scope action-log entries so author
  classification routes correctly. Residual: two SPA uploads landing in
  the same wall-clock millisecond with `stage === null` still race the
  intent-tick counter inside the function — but the counter is
  `intent-tick.json`-backed and incremented under a single
  process-monotonic call, so collision requires two MCP processes
  serving the same intent (out of scope: deployment topology forbids).

### 2.3. Locking primitive consideration (rejected)

A POSIX advisory lock around the intent directory would close V-04 fully
but introduces three new failure modes: (a) lock-holder process crash
strands the lock; (b) `vim` and out-of-band editors do not participate;
(c) the locking layer becomes a single-process serializer for an
inherently concurrent SPA-plus-MCP flow. The compensating-control
posture (drift gate observes drift) is preferable.

---

## 3. STRIDE threat catalog (rows mapped to entry-point features)

Each STRIDE category has at least one threat row tied to a named
entry-point feature. Rows cite the V-NN finding from VULN-REPORT
where applicable.

### 3.1. Spoofing — author/identity forgery

| # | Threat | Feature | V-NN | Notes |
|---|---|---|---|---|
| S-1 | Agent passes `claimed_author_id` it invented; audit log records the forgery as authoritative | `agent-writes-on-behalf-of-human.feature` | V-03 | Unit-02 picked Option B — field renamed `human_author_id → claimed_author_id`. Consumers now read "what the caller claimed" rather than treating it as proof. |
| S-2 | SPA reviewer holding a leaked tunnel JWT writes uploads attributed to a forged `attribute_to_user` (e.g. `ceo@company.com`) | `explicit-spa-upload.feature` | V-03 | Same Option B mitigation. R-04 (commit `bfa4b7c91`) further constrains the field to a printable-character allowlist so it can't carry HTML/script payloads into audit-log viewers. |
| S-3 | Tunnel JWT for session A replayed against intent B via cross-session URL | `explicit-spa-upload.feature` | V-03 R-01 | Closed by `verifyIntentMutationAuth` (commit `4e5af2b76`) — `sid` claim now cross-checked against URL intent slug on upload routes. |
| S-4 | `alg: none` / `alg: HS256+RS256` algorithm-confusion forgery | `explicit-spa-upload.feature` (auth surface) | (not in VULN-REPORT) | Closed in `tunnel.ts:135-148` — explicit `alg !== "HS256"` rejection plus HMAC verify path always uses HS256. |

### 3.2. Tampering — write-surface integrity

| # | Threat | Feature | V-NN | Notes |
|---|---|---|---|---|
| T-1 | TOCTOU symlink swap during `haiku_human_write` parent-mkdir → write race | `agent-writes-on-behalf-of-human.feature` | V-04 | Unit-03 `safeMkdirAndRename` + post-mkdir realpath re-check (commit `573c91da1`). Residual race accepted; full `openat`/`renameat` deferred. |
| T-2 | Same TOCTOU class on SPA upload route (`upload-routes.ts:413-454`) | `explicit-spa-upload.feature` | V-04 | Same fix call site — both call `safeMkdirAndRename`. |
| T-3 | Direct `state.json` tamper to bypass V-11 baseline gate (red-team finding FB-05) | `silent-filesystem-drop-detection.feature` | V-11 + RT1/RT2/RT6 | Unit-03 anchors signals on tamper-evident surfaces (commit `3c3ccf1a0`); FB-05 was rejected because anchored detectors close the bypass. |
| T-4 | `baseline.json` corruption → silent auto-establish on next tick re-baselines attacker-chosen content | `silent-filesystem-drop-detection.feature` | V-11 | Unit-03 operator-only baseline-reset path with reconstructed-vs-on-disk diff; agent CANNOT set `baseline_corrupt_acknowledged`. |
| T-5 | Substring-match status check on `intent.md` accepts non-canonical YAML formatting | `explicit-spa-upload.feature` | V-06 | Unit-02 shared `isIntentLocked` / `isIntentArchived` helpers parse via `gray-matter`. R-03 closed coverage gap on MCP path. |

### 3.3. Repudiation — audit-log unreliability

| # | Threat | Feature | V-NN | Notes |
|---|---|---|---|---|
| R-1 | Audit log line for a write attributed to a forged user; later denial cannot be disproved | `agent-writes-on-behalf-of-human.feature` | V-03 | Field renamed `claimed_author_id` (Option B). Audit log now self-documents that attribution is self-reported. |
| R-2 | Audit-log line tampered post-write (no hash chain) | (cross-cutting) | V-03 fix #3 | **Deferred** — `prev_hash` field on `write-audit.jsonl` / `action-log.jsonl` not yet implemented. ASSESSMENTS.md records as residual risk. |
| R-3 | `tick_counter` non-determinism causes drift-gate to mis-classify SPA upload as `human-implicit` rather than `human-via-mcp` | `agent-writes-on-behalf-of-human.feature` | V-05 | Unit-02 producer + consumer fix (commit `399c2ee13`). Per-stage counter for stage-scope writes; intent-scope counter for `stage === null` writes; drift-gate union scan. |
| R-4 | Stale on-disk lines retain legacy `human_author_id` key while new lines write `claimed_author_id` — readers must coalesce | (cross-cutting) | V-03 | Mitigated via `readClaimedAuthorId(record)` helper that reads `claimed_author_id ?? human_author_id`. |

### 3.4. Information disclosure — content leak via served files

| # | Threat | Feature | V-NN | Notes |
|---|---|---|---|---|
| I-1 | Stored XSS via `.html` / `.htm` / `.svg` knowledge upload — script executes in tunnel-origin's security context, exfiltrates session token + intent contents | `drift-assessment-visibility.feature` (rendering chokepoint) | V-01 | Unit-01 ALLOWED_MIMES + BLOCKED_EXTENSIONS allowlist (commits `3867608a6`, `bfa4b7c91`). Serve-side hardening (CSP, sandboxed sub-origin, `Content-Disposition: attachment` for non-image/PDF) deferred — see ASSESSMENTS.md residual risk. |
| I-2 | Same class on stage-output upload path; HTML mock renders inline with full DOM access | `explicit-spa-upload.feature` + `drift-assessment-visibility.feature` | V-02 | Same allowlist mitigation. Sandboxed sub-origin for HTML mockups deferred — see ASSESSMENTS.md residual risk. |
| I-3 | Reflected XSS via reviewer-rendered feedback markdown (agent-authored body) | `manual-change-assessment.feature` + `drift-assessment-visibility.feature` | V-10 | Unit-03 server-side sanitizer in `feedback-api.ts` (commit `143a1ccbf`). |
| I-4 | OpenTelemetry exporter exfiltrates audit-log content / file paths / `claimed_author_id` to a configured collector | (cross-cutting telemetry) | (not in VULN-REPORT) | Mitigation: telemetry events redact path tail, never include file *content*. Deferred enhancement: PII allowlist for `claimed_author_id` (rate-limit / hash before export). |

### 3.5. Denial of service — resource exhaustion

| # | Threat | Feature | V-NN | Notes |
|---|---|---|---|---|
| D-1 | Misconfigured `HAIKU_UPLOAD_MAX_BYTES` accepts multi-GB payloads; fastify-multipart buffers + sync SHA in drift gate stalls workflow tick | `explicit-spa-upload.feature` | V-07 | Unit-01 `MAX_UPLOAD_BYTES_HARD_CAP = 50 MiB` (commit `3867608a6`). Effective cap clamps via `Math.min`; `haiku.upload.cap_clamped` telemetry on misconfig. |
| D-2 | Unbounded `agent_rationale` written to `DA-NN.json`; assessments-list endpoint reads them all into RAM | `manual-change-assessment.feature` | V-09 | Unit-01 schema-validation rejects `>10 KB` rationale / `>1 KB` excerpt; list-endpoint truncates to 256 chars + `…` (commit `0f87ed407`). |
| D-3 | `@fastify/multipart` decompression bomb / parser-confusion / slowloris on upload routes | `explicit-spa-upload.feature` | (dependency-class) | See §4.1 dependency enumeration. Mitigation: `MAX_UPLOAD_BYTES_HARD_CAP` caps payload size; default body parser timeout. Rate limiting deferred. |
| D-4 | `haiku_classify_drift` rapid-fire calls bloat assessment store and starve the drift gate | `manual-change-assessment.feature` | (rate-limit gap) | **Deferred** — per-session cap / per-IP rate-limit recorded as residual risk. |

### 3.6. Elevation of privilege — boundary crossings

| # | Threat | Feature | V-NN | Notes |
|---|---|---|---|---|
| E-1 | CSRF: cross-origin POST from attacker-controlled origin succeeds because `?t=<jwt>` is in URL + multipart-form-data is CORS-safe | `explicit-spa-upload.feature` | V-08 | Unit-03 three-layer defense: (1) ban `?t=` on mutating verbs, (2) Origin allowlist (`HAIKU_ALLOWED_ORIGINS`), (3) per-session CSRF nonce as `X-Haiku-CSRF` header (commit `bed443315`). Audit script enumerates routes to ensure preHandler coverage. |
| E-2 | Symlink-write via TOCTOU drops file outside intent dir into attacker-chosen path (e.g. `/etc/cron.d/`) | `agent-writes-on-behalf-of-human.feature` | V-04 | Same mitigation as T-1/T-2. Residual race accepted. |
| E-3 | `guard-workflow-fields` PreToolUse hook bypassed via Bash (agent writes workflow-managed file directly with `cat > ...`); compensating control is the drift gate | (cross-cutting — see §5) | (hook-class) | Drift-detection-gate is the compensating control. Residual risk if drift gate is disabled. See §5 row. |
| E-4 | `claimed_author_id` carrying HTML / shell-metacharacter payload poisons future SPA audit-log viewer (stored XSS sink) | `explicit-spa-upload.feature` + `agent-writes-on-behalf-of-human.feature` | V-03 R-04 | `ATTRIBUTE_TO_USER_PATTERN = /^[\w][\w\-.@ ]{0,127}$/` (commit `bfa4b7c91`). Wide enough for real human IDs, narrow enough to reject every HTML/JS sigil. |

---

## 4. Per-feature attack-surface map

Each entry-point feature gets a row with: trust boundary crossed, primary
threats, V-NN findings closed, V-NN findings deferred.

### 4.1. `silent-filesystem-drop-detection.feature`

- **Trust boundary**: out-of-band human writes (or rogue agent Bash
  bypass) → drift gate trust verdict.
- **Primary threats**: T-3, T-4 (baseline tamper), E-3 (guard bypass).
- **Closed**: V-11 RT1/RT2/RT6 anchored on tamper-evident surfaces
  (unit-03, commit `3c3ccf1a0`); V-11 operator-only baseline-reset path.
- **Deferred**: drift-gate kill-switch monitoring (operator alert if the
  gate is disabled) — see §5.

### 4.2. `agent-writes-on-behalf-of-human.feature`

- **Trust boundary**: agent → file system, with `haiku_human_write` as
  the chokepoint. Author attribution is the integrity hinge.
- **Primary threats**: S-1 (forged claimed_author_id), T-1 (symlink
  TOCTOU), R-3 (tick-counter non-determinism), E-2 (symlink escape).
- **Closed**: V-03 (Option B rename, commit `399c2ee13`), V-04 (single-shot
  TOCTOU close, commit `573c91da1`), V-05 (intent-scope counter +
  drift-gate union, commit `399c2ee13`).
- **Deferred**: V-03 fix #3 (audit-log hash chain) — see ASSESSMENTS.md
  residual risk; V-04 fix #1 (full `O_NOFOLLOW`-everywhere) — same.

### 4.3. `manual-change-assessment.feature`

- **Trust boundary**: agent → assessment store; agent-authored feedback
  bodies → reviewer SPA renderer.
- **Primary threats**: I-3 (stored XSS via feedback body), D-2 (rationale
  bloat), D-4 (rapid-fire classify).
- **Closed**: V-09 (rationale caps + list truncation, commit `0f87ed407`),
  V-10 (server-side feedback sanitizer, commit `143a1ccbf`).
- **Deferred**: per-session rate-limit on `haiku_classify_drift` — see
  ASSESSMENTS.md residual risk.

### 4.4. `explicit-spa-upload.feature`

- **Trust boundary**: tunnel-mode reviewer (JWT-bearing) → file system
  via `/api/intents/:intent/uploads/{stage-output,knowledge}`.
- **Primary threats**: I-1, I-2 (stored XSS via uploaded HTML/SVG), S-3
  (cross-session write), T-2 (TOCTOU on SPA path), T-5 (substring status
  check), D-1 (size DoS), E-1 (CSRF), E-4 (audit-log poisoning).
- **Closed**: V-01/V-02 (allowlist + extension blocklist, commits
  `3867608a6`, `bfa4b7c91`), V-03 R-01 (cross-session sid binding,
  `4e5af2b76`), V-06 (shared `gray-matter` status helpers, `399c2ee13`),
  V-07 (hard cap, `3867608a6`), V-08 (three-layer CSRF, `bed443315`).
- **Deferred**: serve-side `Content-Disposition: attachment` + CSP for
  non-image/PDF; sandboxed sub-origin for HTML mockups — see
  ASSESSMENTS.md residual risk.

### 4.5. `drift-assessment-visibility.feature`

- **Trust boundary**: reviewer browser ← assessment-rendering surface
  (markdown body, file content) ← agent / SPA writers.
- **Primary threats**: I-1, I-2 (stored XSS lands here when reviewer
  GETs the file), I-3 (feedback markdown), I-4 (OTel exfiltration of
  rendered content).
- **Closed**: V-09 (list truncation), V-10 (feedback sanitizer).
- **Deferred**: CSP on the rendered-assessment routes (defense-in-depth
  even after upload-side allowlist) — folded into "serve-side hardening"
  residual risk.

---

## 5. `guard-workflow-fields` PreToolUse-bypass class

The `guard-workflow-fields` hook denies generic `Read` / `Write` / `Edit`
on workflow-managed files (`units/*.md`, `feedback/*.md`, `intent.md`,
`stages/*/state.json`) and redirects the agent to MCP tools that enforce
lifecycle, frontmatter validation, and integrity sealing.

**The bypass class**: the agent can use `Bash` with `cat > file` /
`tee file` / `sed -i file` / `python -c 'open(...).write(...)'` to write
the same files without triggering PreToolUse. The hook is documented as
"not a hostile-agent control" — it redirects honest mistakes, not
adversarial bypass.

**Compensating control**: `silent-filesystem-drop-detection.feature` — the
drift gate observes the resulting file change on the next `haiku_run_next`
tick, hashes it against the baseline, and surfaces the unannounced write
as drift requiring reviewer classification (`haiku_classify_drift`). Bash
bypass becomes visible exactly because it doesn't go through the MCP
tool that would have stamped `human-via-mcp` on the action log.

**Residual risk**: if the drift-detection gate is disabled (via
`HAIKU_DRIFT_DETECTION=0` or operator kill-switch), the compensating
control evaporates and the agent's Bash bypass becomes silent. ASSESSMENTS
records this as a deferred risk: operator-alert if the kill-switch is
enabled, recommended target iteration to fold into the `silent-filesystem-
drop-detection` follow-up wave.

**`haiku_classify_drift` as its own MCP-tool entry point**: the tool
itself is the trust boundary between "drift observed" and "drift accepted
as authorized by a human." Writes through the tool stamp `tick_scope`,
`claimed_author_id`, and the classification result. V-09 (rationale
bloat) and V-10 (feedback body XSS) are the two findings on this entry
point; both closed in unit-01 and unit-03 respectively. The tool is
schema-bounded (input validation rejects oversize fields before any disk
write), so a hostile agent's blast radius is capped at the schema edge.

---

## 6. Third-party dependency threat enumeration

### 6.1. `@fastify/multipart`

- **Parser confusion**: malformed multipart boundary / nested-boundary
  attacks could cause field interleaving or field-stream desynchronization.
  Mitigation: fastify-multipart's parser is mature and documented to
  reject malformed boundaries; we further enforce content-type allowlist
  before reading the stream.
- **Decompression bomb**: gzip/deflate body with extreme expansion ratio
  could exhaust memory. Mitigation: we do not enable any decompression
  middleware ahead of the multipart parser; the raw byte cap
  (`MAX_UPLOAD_BYTES_HARD_CAP = 50 MiB`) bounds pre-decompression size.
- **Slowloris**: trickle a multipart body slowly to hold a connection.
  Mitigation: fastify default `connectionTimeout` (60 s) + Node HTTP
  parser idle timeout. Residual risk: a determined attacker can hold N
  connections within the timeout. Rate-limiting (deferred) closes this.
- **Recommendation**: pin minor version, watch GHSA advisories,
  re-audit on every `@fastify/multipart` major bump.

### 6.2. `gray-matter`

- **YAML deserialization**: gray-matter uses `js-yaml` under the hood.
  Default safe-load mode prevents JS-yaml deserialization gadgets
  (custom tags / `!!js/function` / `!!js/regexp`). We rely on the safe-load
  default and do not pass any custom schema.
- **Prototype pollution**: parsed frontmatter object could carry
  `__proto__` / `constructor` keys. Mitigation: we read specific fields
  (`status`, `archived`, etc.) by name rather than spreading the parsed
  object. A future code change that does `{ ...data }` would re-introduce
  the risk — call out in `ASSESSMENTS.md` as a code-review checklist item.
- **Resource exhaustion**: extremely large frontmatter blocks could
  exhaust memory during parse. Mitigation: `intent.md` is bounded by
  schema (workflow engine enforces structure). External callers cannot
  provide arbitrary frontmatter through the upload routes (uploads write
  body bytes; frontmatter is not parsed from upload content).
- **Recommendation**: never call `matter(raw, { ... })` with custom
  options that re-enable unsafe YAML loading; pin minor version.

### 6.3. `@opentelemetry/*`

- **Outbound exfiltration**: an attacker who can configure
  `OTEL_EXPORTER_OTLP_ENDPOINT` redirects telemetry — including any
  field passed to `recordEvent()` — to their collector. Threat applies
  if env-var override is reachable from a less-privileged context.
  Mitigation: env vars are operator-controlled at process start; no
  runtime API exposes endpoint reconfiguration.
- **PII leak**: every `recordEvent` payload should be reviewed for
  attribute names that include user/agent-supplied content (file paths,
  `claimed_author_id`, rationale text). Current policy: telemetry attrs
  are bounded to enums, counts, and path-tail hashes. A future event
  that adds `claimed_author_id` directly (rather than a hash) would leak
  reviewer identity to the OTel collector — call out in code review.
- **Dependency tree size**: `@opentelemetry/*` pulls a deep transitive
  tree. Each transitive dependency widens the supply-chain surface.
  Mitigation: lockfile review on bumps; `npm audit` in CI.
- **Recommendation**: never log raw rationale / feedback body / file
  content as a span attribute; restrict to enums + hashes.

### 6.4. `jsonwebtoken`

- **Algorithm-confusion (`alg: none`, RS-vs-HS swap)**: classic
  jsonwebtoken pitfall. We do *not* use `jsonwebtoken` — we sign and
  verify in `tunnel.ts` using `crypto.createHmac` directly, with explicit
  `alg !== "HS256"` rejection and constant-time signature compare. The
  dependency enumeration here is forward-looking: if a future refactor
  pulls in `jsonwebtoken` to replace the hand-rolled HMAC path, the
  sign/verify pair MUST be called with explicit `algorithms: ["HS256"]`
  on verify (the library defaults to all algorithms allowed pre-9.x).
- **Key-confusion via `EPHEMERAL_SECRET` rotation**: if the verify path
  is ever passed a stale secret (e.g. token minted under secret-A,
  verified under secret-B without re-issuing), `bad_signature` is the
  correct verdict. Today this is impossible because the secret is
  process-local and never rotated within a process. A future refactor
  that adds key rotation MUST track which secret each token was minted
  against and accept verify against any non-revoked key.
- **Recommendation**: keep using the hand-rolled HMAC path until there
  is a concrete reason to take the dependency; if added later, audit the
  verify call site for explicit `algorithms` allowlist.

---

## 7. Threat-to-control matrix (summary)

| Threat row | Closed by | Commit / location | Verifying gate |
|---|---|---|---|
| S-1, S-2 | Option B rename + `attribute_to_user` allowlist | `399c2ee13`, `bfa4b7c91` | unit-02 quality gate `v03-claimed-author-id-rename`; unit-01 bolt-3 red-team test |
| S-3 | `verifyIntentMutationAuth` cross-session sid bind | `4e5af2b76` | unit-02 blue-team regression test |
| S-4 | `alg: HS256`-only verify | `tunnel.ts:135-148` | (covered by tunnel-auth test suite) |
| T-1, T-2, E-2 | `safeMkdirAndRename` helper, both call sites | `573c91da1` | unit-03 quality gate; planted-symlink rejection test |
| T-3 | Anchored signals on tamper-evident surfaces | `3c3ccf1a0` | unit-03 BLUE-TEAM-VERIFICATION |
| T-4 | Operator-only baseline-reset path | unit-03 quality gate | reconstruct + diff-confirm flow |
| T-5 | Shared `gray-matter` status helpers | `399c2ee13` | unit-02 quality gate `v06-no-substring-status-checks-anywhere` |
| R-1 | `claimed_author_id` rename | `399c2ee13` | unit-02 quality gate |
| R-2 | (deferred — audit-log hash chain) | — | residual risk in ASSESSMENTS.md |
| R-3 | Producer + consumer tick-scope union | `399c2ee13` | unit-02 quality gate `v05-intent-scope-tick-counter` |
| R-4 | `readClaimedAuthorId` coalescing helper | `399c2ee13` | unit-02 quality gate |
| I-1, I-2 | ALLOWED_MIMES + BLOCKED_EXTENSIONS allowlist | `3867608a6`, `bfa4b7c91` | unit-01 upload-routes test, red-team-unit-01 inverted PoCs |
| I-3 | Server-side feedback sanitizer | `143a1ccbf` | unit-03 quality gate |
| D-1 | `MAX_UPLOAD_BYTES_HARD_CAP` clamp | `3867608a6` | unit-01 upload-routes hard-cap test |
| D-2 | Rationale schema caps + list-endpoint truncation | `0f87ed407` | unit-01 state-tools-handlers test, assessments-routes test |
| D-3 | (defense via D-1 size cap; rate-limit deferred) | — | partial — residual risk in ASSESSMENTS.md |
| D-4 | (deferred — per-session rate-limit) | — | residual risk in ASSESSMENTS.md |
| E-1 | Three-layer CSRF (query-param ban + Origin + nonce) | `bed443315` | unit-03 quality gate, audit-mutating-routes script |
| E-3 | Drift-detection gate is the compensating control | (existing — silent-filesystem-drop-detection.feature) | drift-gate tests in CI |
| E-4 | `ATTRIBUTE_TO_USER_PATTERN` allowlist | `bfa4b7c91` | unit-01 bolt-3 red-team test |

---

## 8. References

- VULN-REPORT.md — per-finding evidence
- ASSESSMENTS.md — per-fix audit trail with `gate_pass_evidence`
- features/silent-filesystem-drop-detection.feature
- features/agent-writes-on-behalf-of-human.feature
- features/manual-change-assessment.feature
- features/explicit-spa-upload.feature
- features/drift-assessment-visibility.feature
- packages/haiku/src/tunnel.ts (JWT mint/verify)
- packages/haiku/src/http/auth.ts (request auth)
- packages/haiku/src/hooks/guard-workflow-fields.ts (PreToolUse hook)
- packages/haiku/src/orchestrator/workflow/drift-detection-gate.ts (compensating control)
