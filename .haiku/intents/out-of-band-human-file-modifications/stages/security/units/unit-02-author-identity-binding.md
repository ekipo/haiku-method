---
title: >-
  Bind human author identity from JWT, not from agent-supplied params (V-03,
  V-05, V-06)
depends_on: []
inputs:
  - .haiku/intents/out-of-band-human-file-modifications/knowledge/VULN-REPORT.md
  - >-
    .haiku/intents/out-of-band-human-file-modifications/features/agent-writes-on-behalf-of-human.feature
  - packages/haiku/src/state-tools.ts
  - packages/haiku/src/http/upload-routes.ts
  - packages/haiku/src/http/feedback-api.ts
outputs: []
model: sonnet
quality_gates:
  - name: human-write-uses-jwt-author-not-agent-supplied
    command: >-
      bash -c 'grep -nE "human_author_id" packages/haiku/src/state-tools.ts |
      grep -qE "jwt|fromToken|claims|sessionUser" || grep -nE
      "function.*haiku_human_write" packages/haiku/src/state-tools.ts | grep -qE
      "author.*claim|jwt.*author"'
  - name: spa-upload-binds-author-from-jwt
    command: >-
      grep -qE 'reqUser|jwtUser|claims\.sub|claims\.user|sessionUser'
      packages/haiku/src/http/upload-routes.ts
  - name: stage-substring-locked-check-uses-frontmatter-parse
    command: >-
      bash -c 'grep -qE "matter\\(" packages/haiku/src/http/upload-routes.ts ||
      grep -qE "parseFrontmatter" packages/haiku/src/http/upload-routes.ts'
  - name: tick-counter-deterministic-for-null-stage
    command: >-
      bash -c 'grep -qE
      "getCurrentTickCounter.*intent.*stage|globalTickCounter|intentTickCounter"
      packages/haiku/src/state-tools.ts || grep -qE
      "intentScope.*tick|tick.*intent.*scope" packages/haiku/src/state-tools.ts'
  - name: haiku-suite-passes
    command: bun run --cwd packages/haiku test
status: pending
---
# Unit 02 — Author identity binding

## Scope

Close three vuln-report findings about authentication trust in the human-attribution and SPA upload paths:

- **V-03 (MED)** `human_author_id`, `attribute_to_user`, `rationale`, `user_instruction_excerpt` are self-reported by the agent and copied into `write-audit.jsonl` and `action-log.jsonl` with no JWT cross-check. The hardcoded-author pattern from FB-01 (feedback-reply path) exists but isn't applied here.
- **V-05 (MED)** `getCurrentTickCounter(intentDir)` for `stage=null` SPA uploads picks a non-deterministic stage's iteration; entry-IDs collide and drift gate's per-tick action-log lookup misses, downgrading provenance from `human-via-mcp` to `human-implicit`.
- **V-06 (MED)** SPA archived/locked checks use `raw.includes("status: locked")` substring match — false-positives on body content, false-negatives on `status: 'locked'`. Asymmetric with `haiku_human_write`'s `gray-matter` parse.

## Approach

For V-03: in `haiku_human_write` (state-tools.ts), pull `human_author_id` from the request session/JWT claims, not from the tool's `args`. Same for the SPA upload routes — bind from `reqUser`/`claims.sub`. Reject the tool call with `unauthorized_author_attribution` when the agent-supplied value disagrees with the JWT.

For V-05: introduce an intent-scope tick counter (`globalTickCounter` per intent dir) so SPA uploads with `stage=null` write entries with a deterministic, collision-free counter. The drift gate's action-log lookup learns the new key shape.

For V-06: replace substring matching on intent.md frontmatter with `gray-matter` parsing (already imported in state-tools.ts). Use the parsed `status` field directly.

## Completion criteria

- `haiku_human_write` and SPA upload routes derive `human_author_id` from JWT claims; agent-supplied values that disagree are rejected with `unauthorized_author_attribution` (HTTP 403 / MCP error).
- `getCurrentTickCounter(intentDir, stage = null)` returns a deterministic intent-scope counter when `stage === null`.
- Archive/lock checks use `gray-matter` (or equivalent frontmatter parser) — no `raw.includes(...)` against intent.md content.
- New tests in `packages/haiku/test/state-tools-handlers.test.mjs` cover: JWT/agent-author mismatch rejected, intent-scope tick determinism, gray-matter status check.
- Full `bun run --cwd packages/haiku test` passes.

## References

- VULN-REPORT.md V-03, V-05, V-06
- `packages/haiku/src/state-tools.ts` (haiku_human_write handler)
- `packages/haiku/src/http/upload-routes.ts`
- `packages/haiku/src/http/feedback-api.ts` (FB-01 hardcoded-author pattern reference)
