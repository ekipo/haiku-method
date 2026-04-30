# Implementation Plan — unit-10-spa-upload-http-endpoints

**Hat:** planner  
**Unit:** unit-10-spa-upload-http-endpoints  
**Stage:** development

---

## 1. Scope Summary

This unit delivers the three HTTP endpoints the review SPA calls for stage-output replacements, knowledge uploads, and reading the drift assessment list, plus tests for all scenarios.

Prior units in context:
- **unit-03**: `write-audit.ts` / `action-log.ts` — `appendActionLogEntry`, `appendWriteAudit`, `ActionLogEntry`, `WriteAuditRecord`, `nextEntryId`, `truncateInstruction`. These are the stamping primitives the upload endpoint must use.
- **unit-01**: `drift-baseline.ts` — `canonicalisePath` (alias outputs/ → artifacts/). The endpoint does NOT update baseline.json — that's the tick's job. But we use `canonicalisePath` when constructing the intent-relative path stored in the action log entry.

Deliverables:
1. `packages/haiku/src/http/upload-routes.ts` — Fastify route registration for `POST /api/intents/:intent/uploads/stage-output` and `POST /api/intents/:intent/uploads/knowledge`.
2. `packages/haiku/src/http/assessments-routes.ts` — Fastify route registration for `GET /api/intents/:intent/assessments` and `GET /api/intents/:intent/assessments/:assessmentId`.
3. Modification to `packages/haiku/src/http/default-routes.ts` — wire new route registrations into `registerDefaultRoutes` (or the caller in `http.ts`). Wiring will be in `http.ts` following the pattern of `registerFeedbackRoutes`, `registerFileServeRoutes`, etc.
4. Tests:
   - `packages/haiku/test/upload-routes.test.mjs`
   - `packages/haiku/test/assessments-routes.test.mjs`

---

## 2. File-by-File Plan

### 2.1 `packages/haiku/src/http/upload-routes.ts` (NEW)

**Dependencies:**
- `node:crypto` — `createHash` for SHA-256 computation on uploaded bytes.
- `node:fs` — `existsSync`, `mkdirSync` (sync variant safe here; HTTP handlers run in the event loop but file ops are brief).
- `node:fs/promises` — `rename`, `unlink`, `writeFile` for atomic tempfile write.
- `node:os` — `tmpdir()` for temp file placement.
- `node:path` — `join`, `resolve`, `dirname`, `basename`, `relative`.
- `busboy` — multipart parsing. Already in `node_modules` (transitive dep). Import as: `import Busboy from "busboy"`.
- `fastify` — `FastifyInstance` type.
- `../../orchestrator/workflow/action-log.js` — `appendActionLogEntry`, `ActionLogEntry`.
- `../../orchestrator/workflow/write-audit.js` — `appendWriteAudit`, `WriteAuditRecord`, `nextEntryId`.
- `../../orchestrator/workflow/drift-baseline.js` — `canonicalisePath`.
- `../state-tools.js` — `intentDir`, `validateIntent` (or use the local `validation.ts` equivalents).
- `./validation.js` — `isValidSlug`, `validateIntent`, `validateStage`.
- `./auth.js` — `requireTunnelAuth`.
- `./path-safety.js` — `resolvePathSafe` for traversal defence.

**`POST /api/intents/:intent/uploads/stage-output`**

Request: `multipart/form-data` with fields:
- `stage` (string) — stage slug
- `target_path` (string) — stage-relative path (e.g. `artifacts/layout-v2.html` or `outputs/layout-v2.html`)
- `file` (binary) — the uploaded content
- `mode` (`"replace"` | `"create"` | `"upsert"`) 
- `attribute_to_user` (string)

Processing order:
1. Auth check via `requireTunnelAuth`.
2. Parse multipart with `busboy` (stream the file field into memory/temp, collecting all text fields first).
3. Enforce size cap (50 MB default, `HAIKU_UPLOAD_MAX_BYTES` env override). Stream counting bytes — once cap exceeded, drain and return 413 before tempfile touches disk. See AC note below.
4. Validate slug via `isValidSlug`.
5. Validate intent exists via `validateIntent`. If not found → 404 `intent_not_found`.
6. Check intent not archived: read `intent.md` frontmatter, check `archived` field → 404 `intent_not_found` (per unit spec: "Archived intent → 404 `intent_not_found`").
7. Validate `stage` param exists via `validateStage`. If not found → 400.
8. Check stage not sealed/completed: read `stages/{stage}/state.json`, check `status !== "completed"` → 403 `stage_not_writable`.
9. Check worktree not locked: look for `locked` file in the git worktree directory (`.git/worktrees/<name>/locked` from reading the `.git` gitfile). If found → 423 `intent_locked`.
10. Canonicalise `target_path`: apply `canonicalisePath` on `stages/{stage}/{target_path}` to normalise `outputs/` → `artifacts/`.
11. Validate `target_path` resolves to `stages/{stage}/artifacts/**`: reject paths that escape that directory → 400 `bad_target_path`.
12. Validate `mode` semantics: `create` when target exists → 409 `filename_collision`; `replace` when target missing → 400 `mode_violation`; `upsert` always passes.
13. Write file atomically: stream bytes to a temp file under `os.tmpdir()`, then `rename` into the final destination. On any error, `unlink` the temp file before returning the error.
14. Compute SHA-256 of bytes during streaming (via `createHash('sha256').update(chunk).digest('hex')`).
15. Stamp action-log entry via `appendActionLogEntry`:
    ```ts
    {
      entry_type: "human_write",
      path: canonicalisedIntentRelativePath,  // e.g. "stages/design/artifacts/layout-v2.html"
      sha: sha256,
      author_class: "human-via-mcp",
      timestamp: new Date().toISOString(),
      human_author_id: attribute_to_user,
      entry_id: nextEntryId(0, seq),  // tickCounter=0 for HTTP path (no tick context)
      tick_counter: 0,
    }
    ```
16. Append write-audit entry via `appendWriteAudit`:
    ```ts
    {
      timestamp: ...,
      entry_id: ...,
      path: ...,
      sha: ...,
      author_class: "human-via-mcp",
      human_author_id: attribute_to_user,
      rationale: null,
      user_instruction_excerpt: null,  // SPA uploads have no chat instruction
      tick_counter: 0,
      session_id: null,
      overwrite: existedBefore,
      dirs_created: [...],
      audit_log_appended: true,
    }
    ```
17. Return 200: `{ ok: true, path, sha256, bytes, baseline_updated: false, tick_will_observe: true }`.

**`POST /api/intents/:intent/uploads/knowledge`**

Fields: `file`, `target_filename` (basename only), `stage` (string|null), `description` (optional), `attribute_to_user`.

Processing:
1–9. Same auth/validation/locked-check flow as stage-output endpoint.
10. Validate `target_filename` has no path segments (`/`) → 400 `bad_target_path`.
11. Resolve destination: if `stage` is null → `knowledge/`, else `stages/{stage}/knowledge/`.
12. Check collision: if destination file exists and mode is implicit-create → 409 `filename_collision`.
13–17. Same atomic write + action-log + audit-log + response as stage-output.

**Multipart parsing detail (busboy):**
- Register a `addContentTypeParser('multipart/form-data', ...)` on the Fastify instance so the raw request stream is available to busboy. Fastify by default parses `application/json`; multipart needs its own parser or we bypass default body parsing by setting `bodyLimit: 0` and consuming the raw stream manually.
- Pattern: use Fastify's `addContentTypeParser` with `parseAs: 'stream'` → pass the stream directly to `busboy`. Collect fields into a Map and the file buffer/sha. The file field must be streamed with a byte counter to enforce the size cap before writing.
- If the file field exceeds the cap while streaming: abort busboy, return 413, no temp file touches disk (bytes are counted in-flight before the temp write begins; alternatively, if we've started writing to temp, unlink it before returning).

**Size cap enforcement strategy (per unit spec AC):**
- Stream bytes through a counting wrapper. Once `bytesRead > SIZE_CAP`, drain the rest of the stream (to avoid connection hang), unlink any partial tempfile, return 413. This ensures "no temporary file is created in the worktree" for oversized uploads.

---

### 2.2 `packages/haiku/src/http/assessments-routes.ts` (NEW)

**Dependencies:**
- `node:fs` — `existsSync`, `readdirSync`, `readFileSync`.
- `node:path` — `join`.
- `fastify` — `FastifyInstance`.
- `../state-tools.js` — `intentDir`.
- `./validation.js` — `isValidSlug`, `validateIntent`.
- `./auth.js` — `requireTunnelAuth`.

**`GET /api/intents/:intent/assessments`**

Query params: `limit` (int ≤ 200, default 50), `since` (RFC 3339), `stage` (string), `outcome` (string).

Processing:
1. Auth check.
2. Validate slug and intent existence.
3. Walk `stages/*/drift-assessments/DA-*.json` for all stages under the intent. Use `readdirSync` on `stages/` to enumerate stage directories, then check each for a `drift-assessments/` subdirectory.
4. Read each `DA-*.json` file, parse as JSON (skip silently on parse error).
5. Apply filters: `since` (filter by `created_at > since`), `stage` (filter by `findings[*].stage` or the `stage` field on the assessment), `outcome` (filter by `classifications[*].outcome`).
6. Sort descending by `created_at`.
7. Apply `limit` + compute `has_more`.
8. Return: `{ ok: true, assessments: [...], total, has_more }`.

Error handling:
- Invalid `limit` / `since` param → 400 `bad_param`.
- Intent not found → 404 `intent_not_found`.

**`GET /api/intents/:intent/assessments/:assessmentId`**

Processing:
1. Auth check.
2. Validate slug and intent existence.
3. Validate `assessmentId` format: must match `/^DA-\d+$/` → 404 `assessment_not_found` if not.
4. Walk all stage `drift-assessments/` directories for `assessmentId + ".json"`.
5. If not found → 404 `assessment_not_found`.
6. Parse JSON and return: `{ ok: true, assessment: {...} }`.

---

### 2.3 `packages/haiku/src/http.ts` (MODIFY)

Add two imports and two registration calls after the existing `registerFeedbackRoutes`, `registerFileServeRoutes`, `registerSessionRoutes` calls:

```ts
import { registerUploadRoutes } from "./http/upload-routes.js"
import { registerAssessmentsRoutes } from "./http/assessments-routes.js"
// ...
registerUploadRoutes(app)
registerAssessmentsRoutes(app)
```

Registration is in the `buildApp()` function, alongside the other route registrations.

---

## 3. Worktree Lock Detection

The unit spec requires 423 `intent_locked` when "the active worktree is locked by a concurrent operation". Git marks a worktree as locked by creating a `locked` file alongside the worktree's git metadata. The detection:

1. Read the `.git` file in the intent's working directory (the git worktree root, which is the cwd). Since the HTTP server always runs in the project root, we check: is there a `locked` file in the worktree's git directory?
2. Resolution: from `intentDir(slug)`, the working tree root is the project's cwd (not the intent dir itself). The git worktree lock file is at `<gitdir>/locked` where `<gitdir>` is the path in the `.git` file.

Simpler implementation: check if `<projectRoot>/.git` is a file (gitfile, meaning we're in a worktree), read it to get the gitdir path, then check if `<gitdir>/locked` exists. If so → 423.

For non-worktree setups (`.git` is a directory), no lock file exists and the check returns false.

Helper function `isWorktreeLocked(projectRoot: string): boolean` in `upload-routes.ts`.

---

## 4. Multipart Parser Registration

Since `@fastify/multipart` is not in the dependency list, use `busboy` directly (which is available as a transitive dep). Register a content-type parser in `registerUploadRoutes`:

```ts
instance.addContentTypeParser(
  'multipart/form-data',
  { parseAs: 'stream' },
  (_req, body, done) => { done(null, body) }
)
```

Then in each route handler, wrap `req.body` (the raw stream) with `busboy`. The size cap is enforced at the busboy level via `limits.fileSize`.

---

## 5. Test Plan

### `test/upload-routes.test.mjs`

Test harness: same pattern as `http-feedback.test.mjs` — `mkdtempSync`, setup fixture, `startHttpServer()`, then HTTP fetches using `fetch(baseUrl + ...)`.

For multipart POST tests, construct `FormData` using the built-in `FormData` global (Node 18+) or build raw multipart body manually with a boundary string.

Scenarios:
1. **Happy path stage-output replace**: POST stage-output with mode=upsert, existing file → 200, file written, action-log stamped (check `action-log.jsonl`), audit-log appended (check `write-audit.jsonl`), no `baseline.json` update, response shape correct.
2. **Happy path knowledge upload**: POST knowledge with null stage → 200, file written to `knowledge/`, action-log stamped, audit-log appended.
3. **Replace preserves filename**: upload `new-name.html` as replacement for `target.html` → file exists as `target.html`, no `new-name.html` created.
4. **Create mode collision**: POST knowledge mode=create where file exists → 409 `filename_collision`.
5. **Size cap exceeded**: build a >50MB request body → 413 `payload_too_large`, no temp files in worktree.
6. **Locked worktree**: create a fake `locked` file in the worktree gitdir → 423 `intent_locked`.
7. **Archived intent**: set `archived: true` in intent.md → 404 `intent_not_found`.
8. **Stage not writable**: set stage `state.json` `status: "completed"` → 403 `stage_not_writable`.
9. **Hook bypass**: assert that the `guard-workflow-fields` hook script path is not invoked. This is structurally guaranteed (the SPA endpoint writes directly via Node fs, not through the agent tool pipeline); the test verifies the file IS written when the hook would otherwise block (upload a file to `stages/design/artifacts/` and confirm it lands on disk without error — the hook only fires inside the Claude Code harness, not in the test process).
10. **Path traversal**: POST stage-output with `target_path = "../../../etc/passwd"` → 400 `bad_target_path`.

### `test/assessments-routes.test.mjs`

Scenarios:
1. **Most-recent-first ordering**: write three `DA-*.json` files with different `created_at` → GET assessments returns them newest first.
2. **Filter by stage**: write assessments for two stages → filter by `stage=design` returns only design stage assessments.
3. **Filter by outcome**: write assessments with different `outcome` values → filter works.
4. **Single assessment GET**: GET `/assessments/DA-01` returns the full record.
5. **404 missing intent**: GET assessments for unknown intent → 404.
6. **404 missing assessment**: GET `/assessments/DA-99` where file doesn't exist → 404.

---

## 6. Risks and Blockers

**Risk 1: `busboy` API version.** `busboy` 1.x vs 2.x have slightly different APIs. The transitive dep version may be from `@fastify/cors` or another dep — check `node_modules/busboy/package.json` to confirm the major version before importing. Use `import Busboy from "busboy"` and check if it's a class or factory function.

**Risk 2: Size cap before disk write.** The unit spec requires "no temporary file is created in the worktree" on oversized uploads. To honour this cleanly, count bytes in-flight during busboy's file event. When the byte count exceeds the cap, call `busboy.destroy()`, drain the stream, return 413. Since we haven't opened the tempfile yet (we open it only after the file field is fully received or we buffer enough to know it fits), there's no temp cleanup needed.

Alternatively (simpler): use busboy's built-in `limits.fileSize` — when it fires `truncated: true` on the file field, no bytes have landed on disk (busboy just emits truncated). The handler checks `file.truncated` after receiving the file, before writing to disk, and returns 413 + cleans up nothing (no temp file was created).

**Risk 3: Fastify content-type parser collision.** If two routes try to register the same content-type parser, Fastify 5 throws at build time. Use `instance.hasContentTypeParser('multipart/form-data')` guard or register the parser once at the app level in `buildApp()` in `http.ts`.

**Risk 4: `attribute_to_user` as required field.** The DATA-CONTRACTS.md §5.1 requires it. The feature scenario ("Designer replaces a stage output") implies the reviewer is signed in. For tests, pass a literal string `"test-user"`.

**Risk 5: No `@fastify/multipart` plugin.** Need to use `busboy` directly or find another approach. The busboy approach is clean and avoids adding a new explicit dependency.

---

## 7. Files to Modify vs Create

| File | Action | Notes |
|---|---|---|
| `packages/haiku/src/http/upload-routes.ts` | CREATE | New file |
| `packages/haiku/src/http/assessments-routes.ts` | CREATE | New file |
| `packages/haiku/src/http.ts` | MODIFY | Add imports + two registerX calls in buildApp() |
| `packages/haiku/test/upload-routes.test.mjs` | CREATE | New test file |
| `packages/haiku/test/assessments-routes.test.mjs` | CREATE | New test file |

No changes to `default-routes.ts` itself — wiring goes in `http.ts` which calls `buildApp()` and registers all routes.

---

## 8. Completion Checklist

- [ ] `upload-routes.ts` exports `registerUploadRoutes(instance: FastifyInstance): void`
- [ ] `assessments-routes.ts` exports `registerAssessmentsRoutes(instance: FastifyInstance): void`
- [ ] Both exported functions registered in `http.ts` `buildApp()`
- [ ] All scenarios in `features/explicit-spa-upload.feature` covered by `upload-routes.test.mjs`
- [ ] All assessment-visibility scenarios covered by `assessments-routes.test.mjs`
- [ ] `tsc --noEmit` clean
- [ ] `bun run --cwd packages/haiku test` passes (all tests green)
- [ ] No placeholders
