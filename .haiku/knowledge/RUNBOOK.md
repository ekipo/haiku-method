# Drift Detection — Operational Runbook

This runbook covers operational scenarios introduced by the out-of-band human file modifications feature: the per-stage drift-detection gate, the upstream-reconciliation gate, the pending-assessment marker store, the human-attributed write tool, the SPA upload endpoints, and the SPA drift visibility panel.

Reach for it when something fires unexpectedly, when a baseline corrupts, when findings flood, when a human-attributed write goes wrong, when an SPA upload misroutes, when the drift visibility panel shows something confusing, or when the gate needs to be turned off fast.

Path conventions used throughout (verified against `packages/haiku/src/orchestrator/workflow/drift-detection-gate.ts`, `drift-baseline.ts`, `drift-markers.ts`, `upstream-reconciliation.ts`, `run-tick.ts`):

- Per-stage baseline: `.haiku/intents/{slug}/stages/{stage}/baseline.json`
- Per-stage baseline content sidecars: `.haiku/intents/{slug}/stages/{stage}/baseline-content/{sha256}`
- Per-stage drift assessments: `.haiku/intents/{slug}/stages/{stage}/drift-assessments/DA-NN.json`
- Per-stage state.json: `.haiku/intents/{slug}/stages/{stage}/state.json` (carries `upstream_reconciliation_fingerprint`, `upstream_reconciliation_acknowledged`, `drift_baseline_established_at`)
- Intent-root pending-marker store: `.haiku/intents/{slug}/drift-markers.json`
- Intent-root active drift dispatch: `.haiku/intents/{slug}/drift-dispatch.json`
- Intent-root action log: `.haiku/intents/{slug}/action-log.jsonl`
- Intent-root write-audit log: `.haiku/intents/{slug}/write-audit.jsonl`
- Intent-root features: `.haiku/intents/{slug}/features/*.feature`
- Repo settings: `.haiku/settings.yml`

The kill-switch (scenario 2) is the universal rollback for the per-stage drift-detection gate. `haiku_reconciliation_acknowledge` is the per-stage release valve for the upstream-reconciliation gate. They have different scopes; the rest of the runbook leans on these two as backstops.

---

## Scenario 1 — False-positive finding flood after upgrade

Owns the `silent-filesystem-drop-detection.feature` migration path.

**Symptom.** An existing intent's first tick after upgrade produces dozens of `manual_change_assessment` findings, or the first elaborate of a stage emits an `upstream_reconciliation_required` action that surfaces pre-existing upstream drift the user already knows about.

**Diagnostic.**

1. Confirm the per-stage baseline exists. Read `.haiku/intents/{slug}/stages/{stage}/baseline.json`. If the file is absent, the gate runs in establish-mode on the next tick (no findings) — confirm by re-running `haiku_run_next` and watching the response action.
2. Confirm the upstream-reconciliation fingerprint is stamped. Read `.haiku/intents/{slug}/stages/{stage}/state.json` and look for `upstream_reconciliation_fingerprint`. If it is null/missing on a stage with completed prior stages, the next tick will silently establish it (`stampFingerprint` short-circuit at `run-tick.ts:334`).
3. Compare the telemetry traffic and saturation signals. `haiku.drift.gate.tick` should fire once per tick. `haiku.drift.findings.count` should be zero in steady state. `haiku.drift.surface.size` tells you whether the surface enumeration matches expectations.

**Remediation.** Both auto-heal paths are designed exactly for this:

- The drift gate's silent establish path in `drift-detection-gate.ts` (`baseline === null` → write fresh baseline, `baselineEstablished: true`, `action: null`) handles a missing baseline automatically.
- The previously-unseen-file silent auto-add inside the steady-state scan (`drift-detection-gate.ts:480-501`) prevents brand-new tracked-surface files from showing up as synthetic out-of-band findings on first sight.
- The fingerprint short-circuit in `run-tick.ts:334-340` silently establishes the upstream-corpus fingerprint the first time it sees a stage and on every subsequent tick that finds a matching fingerprint.

Re-run `haiku_run_next` and confirm the action transitions to a normal phase response. If the gate keeps firing despite a present baseline and stamped fingerprint, jump to scenario 2 and use the kill-switch as the failsafe while you investigate.

**Escalation.** Persistent post-establish flood that the kill-switch silences but you cannot otherwise explain → file an issue with the `findings` payload and `state.json` snapshot.

---

## Scenario 2 — Kill-switch (per-stage drift detection disabled)

**Symptom.** The user wants the per-stage drift-detection gate off entirely — for triage, load-shedding, or to unblock work while a deeper bug is investigated.

**Diagnostic.** None — this is an explicit user choice.

**Remediation.** Add `drift_detection: false` to `.haiku/settings.yml`. The setting is read by `isDriftDetectionDisabled(haikuRoot)` in `drift-baseline.ts:723`, which is the first check inside `runDriftDetectionGate`. When disabled the gate is a complete no-op (`{ findings: [], baselineEstablished: false, action: null }`). Confirm by checking that the `haiku.drift.gate.tick` telemetry event reports the kill-switch path on the next tick.

**Scope clause (CRITICAL).** `drift_detection: false` disables only the per-stage drift-detection gate. It does NOT silence the upstream-reconciliation gate. To silence reconciliation findings on a specific stage, run:

```
haiku_reconciliation_acknowledge { intent: "{slug}", stage: "{stage}", rationale: "load-shedding while investigating <issue>" }
```

The rationale must be at least 10 characters (`state-tools.ts:8405`). To silence both gates in concert, set the kill-switch and acknowledge each affected stage. If you find yourself doing this often, file a feature request — there is no combined kill-switch by design.

**Escalation.** None — this is the universal rollback. If the kill-switch does not stop the gate from firing, the issue is upstream of operations and must be investigated as a defect.

---

## Scenario 3 — Baseline corruption

Backs scenario 1 when the baseline file is present but unreadable.

**Symptom.** The drift gate returns `error: 'baseline_corrupt'` with a `BaselineCorruptError`-derived `errorMessage`. The pre-tick gate result has `action: null` and no findings — the workflow refuses to advance until the baseline is repaired.

**Diagnostic.**

1. Read `.haiku/intents/{slug}/stages/{stage}/baseline.json`. Expect either unparseable JSON or a structurally valid JSON object that fails the baseline schema (missing `entries`, malformed entry record, etc.).
2. Confirm the file is readable but invalid — a missing baseline is establish-mode, not corruption.

**Remediation.** Run `haiku_repair { intent: "{slug}" }`. The repair pass scans the intent for metadata issues and applies safe mechanical fixes. If `haiku_repair` cannot recover the baseline, the safe manual path is:

1. Copy `.haiku/intents/{slug}/stages/{stage}/baseline.json` aside to `baseline.json.bak`.
2. Delete `baseline.json` (the gate treats a missing baseline as establish-mode).
3. Re-run `haiku_run_next`. The gate's silent-establish path in `drift-detection-gate.ts:402-442` writes a fresh baseline from current disk state and returns `baselineEstablished: true, action: null`.

You will lose the SHA history that lived in the corrupted baseline; the next tick treats current disk content as the new baseline.

**Escalation.** `haiku_repair` itself fails, or the baseline keeps corrupting after a fresh establish → file an issue with the corrupted file content and the repair output. Use the kill-switch (scenario 2) to keep work moving while the issue is investigated.

---

## Scenario 4 — Baseline write failure (graceful degradation)

Owns the unit-02 emitter `haiku.drift.baseline.write_failed`.

**Symptom.** Telemetry shows repeated `haiku.drift.baseline.write_failed` events with the same `path` attribute. The `site` attribute identifies the failing call site: `establish` (silent-establish path, `drift-detection-gate.ts:434`) or `post-write` (post-finding silent auto-add, `drift-detection-gate.ts:600`). Each emit also carries `error: <stringified Error>`.

**Diagnostic.**

1. Filesystem permissions on `.haiku/intents/{slug}/stages/{stage}/`. The baseline write is `writeBaselineSync(intentDir, activeStage, baseline)` — the process needs write access to the stage directory.
2. Disk space. `df -h` on the worktree filesystem.
3. Concurrent process holding the file open. The atomic write goes through a tempfile + rename in the same directory; another process holding `baseline.json` open does not block the rename, but it can leave a stale `.tmp` sidecar — check for `.baseline-*.json.tmp` siblings.
4. Filesystem readonly toggling (mounted volume, container layer, network filesystem hiccup).

**Remediation.** Fix the underlying I/O issue (permissions, space, mount). Re-run `haiku_run_next` and observe whether `haiku.drift.baseline.write_failed` stops firing. If the failure persists, set `drift_detection: false` in `.haiku/settings.yml` (scenario 2) to break the loop while investigating; the gate stays silent and stops attempting writes.

**Escalation.** Persistent failure with no obvious I/O cause → file an issue with the `error` and `site` attributes from the telemetry events plus a `ls -la` of the stage directory.

---

## Scenario 5 — Reconciliation fingerprint mismatch (legitimate corpus drift)

**Symptom.** A stage's first elaborate emits `upstream_reconciliation_required` with a non-empty `findings` array. The findings list one or more `kind` values from `tool_name`, `http_status`, `field_name`, each with a `concept` and `occurrences` cross-referencing the divergent files. Telemetry shows `haiku.reconciliation.fingerprint.drifted` followed by emit of the findings count.

**Diagnostic.**

1. Read the finding list. Each entry names its `kind`, `concept`, and the `occurrences` (file + line + excerpt) showing both sides of the divergence.
2. Confirm the corpus actually drifted by checking `state.json.upstream_reconciliation_fingerprint` against the current corpus fingerprint (the gate logs both before deciding).
3. Inspect the cited files at the intent root and at `.haiku/intents/{slug}/stages/{prior}/{artifacts,discovery,outputs}/...`.

**Remediation.** Two paths, both implemented in `run-tick.ts:367-400`:

- **Reconcile.** Edit the upstream artifacts so the divergent identifiers/codes/field names converge on one canonical form. Re-run `haiku_run_next`. The reconciliation gate recomputes the fingerprint, finds no findings, and silently stamps the new fingerprint via `stampFingerprint` (run-tick.ts:346).
- **Acknowledge.** If the divergence is intentional (the artifacts genuinely describe different surfaces), call:
  ```
  haiku_reconciliation_acknowledge { intent: "{slug}", stage: "{stage}", rationale: "<≥10 chars explaining why>" }
  ```
  This sets `upstream_reconciliation_acknowledged: true` on the stage's state.json (`state-tools.ts:8422`); the gate short-circuits on subsequent ticks via the `upstream_reconciliation_acknowledged === true` check at `run-tick.ts:271`.

**Escalation.** Detector emits a finding the user is sure is wrong → file an issue with the `kind`, `concept`, and full `occurrences` payload. Acknowledge to unblock; the fix lives upstream of operations.

---

## Scenario 6 — Manual change assessment classification went wrong

Owns `manual-change-assessment.feature`.

**Symptom.** A `manual_change_assessment` finding was classified `ignore` or `inline-fix` but the user expected `surface-as-feedback` (or `trigger-revisit`). The wrong classification has been written to disk and the workflow has advanced past it.

**Diagnostic.**

1. Read the assessment record at `.haiku/intents/{slug}/stages/{stage}/drift-assessments/DA-NN.json` (per-stage path — NOT at intent root). The record shows the classification outcome the agent chose plus the dispatched DriftFinding.
2. Cross-check via the SPA's drift-assessments view (scenario 9 path — `/api/drift-assessments` style endpoints) for the same record.
3. If the file under-classification was masked by an active marker, read `.haiku/intents/{slug}/drift-markers.json` and check whether an open marker for that path is suppressing fresh detection.

**Remediation.**

- **Interactive mode.** Edit the file again to retrigger the gate (a new SHA on the same path produces a fresh dispatch on the next tick, provided the existing marker is stale per `isStaleMarker` at `drift-markers.ts:361`). Classify correctly the second time.
- **Autopilot mode.** Open feedback against the producing stage so the next iteration revisits with the corrected expectation. Use:
  ```
  haiku_feedback { intent: "{slug}", stage: "{stage}", title: "Re-classify drift on {path}", body: "<context>", origin: "agent", resolution: "stage_revisit" }
  ```

**Escalation.** The dispatch will not re-fire even after the file SHA changes → check the marker store (scenario 10).

---

## Scenario 7 — `haiku_human_write` misuse

Owns `agent-writes-on-behalf-of-human.feature`.

**Symptom.** Either (a) a write attributed to the user that the user did not request, or (b) a `haiku_human_write` call rejected with `code: "path_outside_tracked_surface"`.

**Diagnostic.**

1. Read the write-audit trail: `.haiku/intents/{slug}/write-audit.jsonl`. Each line is one human-attributed write with `path`, `sha`, `tick_counter`, `author_class: "human-via-mcp"`, and the calling tool/route.
2. Cross-reference with `.haiku/intents/{slug}/action-log.jsonl` — both logs are appended on a successful human write (`haiku_human_write.ts` and `http/upload-routes.ts`).
3. For a `path_outside_tracked_surface` rejection, confirm the target was inside one of the allowed roots: `knowledge/`, `stages/{stage}/knowledge/`, `stages/{stage}/discovery/`, `stages/{stage}/artifacts/` (or the `outputs/` alias). Workflow-managed files (`units/`, `feedback/`, `intent.md`, `state.json`, `write-audit.jsonl`) are refused by design.

**Remediation.**

- **Unwanted write landed.** Revert the file in git (`git checkout HEAD -- {path}` from the worktree), and file feedback against the agent's hat:
  ```
  haiku_feedback { intent: "{slug}", stage: "{stage}", title: "Spurious haiku_human_write on {path}", body: "<what the agent did and why it was wrong>", origin: "agent" }
  ```
  The next gate tick treats the revert as a normal modification and emits a `manual_change_assessment` for the agent to re-classify. The audit trail in `write-audit.jsonl` is append-only and preserves the misuse evidence.
- **`path_outside_tracked_surface` rejection.** Confirm whether the target is genuinely a tracked-surface path. If the user wants the write under a non-tracked path (e.g., into a new top-level directory), the request itself is wrong — explain the boundary and pick a tracked destination. If the user is targeting a workflow-managed file (`units/`, `feedback/`, etc.), redirect them to the appropriate MCP tool (`haiku_unit_write`, `haiku_feedback_write`, etc.).

**Escalation.** Persistent unexplained `path_outside_tracked_surface` rejections on paths that should be tracked → file an issue and include the target path plus the resolved canonical path (the tool's error message includes the canonicalised form).

---

## Scenario 8 — SPA upload landed in the wrong place

Owns `explicit-spa-upload.feature`.

**Symptom.** Either (a) a knowledge upload via the review web UI doesn't appear in the next elaborate phase, or (b) a stage-output replacement upload doesn't trigger drift detection on the next tick.

**Diagnostic.**

1. Find the upload entry in `.haiku/intents/{slug}/write-audit.jsonl` (uploads are recorded the same way `haiku_human_write` records are). Confirm the recorded `path` matches the expected destination.
2. Check the HTTP server log around the upload time for the matching `POST /api/intents/{slug}/uploads/knowledge` or `POST /api/intents/{slug}/uploads/stage-output` route.
3. Confirm the file exists at the expected canonical path:
   - Knowledge upload (intent-scope): `.haiku/intents/{slug}/knowledge/{target_filename}`
   - Knowledge upload (stage-scope): `.haiku/intents/{slug}/stages/{stage}/knowledge/{target_filename}`
   - Stage output replacement: `.haiku/intents/{slug}/stages/{stage}/artifacts/{target_path}` (the `outputs/` alias canonicalises to `artifacts/`).
4. Confirm the file is present in the next tick's tracked-surface enumeration. The drift gate calls `enumerateTrackedSurface(intentDir, activeStage)`. If the file is in the right place but the gate doesn't see it, run with telemetry on and check `haiku.drift.surface.size` for the change.

**Remediation.**

- File landed in the wrong spot → re-upload to the correct path. The audit log records both writes; the misplaced one will be picked up by the next drift gate tick as its own finding (or as a removed file if you delete it before the next tick).
- File landed in the right spot but isn't surfacing → confirm the next tick saw it via `haiku.drift.surface.size` and `haiku.drift.findings.count`. The upload deliberately does NOT update the baseline; the next gate tick is what surfaces the change (`upload-routes.ts:10`). If the gate is silenced (kill-switch enabled), no surfacing happens — re-enable the gate.
- Upload UI is routing to the wrong path → file a bug with the request payload (`stage`, `target_path`, `target_filename`) and the actual destination on disk.

**Escalation.** Upload writes succeeded per audit log but the file is not on disk → likely a tempfile-cleanup race (`upload-routes.ts:30` notes the guard deletes tempfiles on rejection). File an issue with the audit entry plus a directory listing.

---

## Scenario 9 — Drift assessments panel shows stale or empty findings

Owns `drift-assessment-visibility.feature`.

**Symptom.** The SPA's drift banner or assessments view does not reflect a finding the user knows the gate emitted.

**Diagnostic.**

1. Read the per-stage assessment directory directly: `.haiku/intents/{slug}/stages/{stage}/drift-assessments/*.json`. Each file is one historical assessment record.
   - Files exist on disk but the panel is empty → SPA cached stale state. Refresh.
   - No files on disk → the gate did not write any. Check telemetry `haiku.drift.findings.count` over the relevant tick window. Zero findings means the gate genuinely saw none; non-zero means the gate emitted but the dispatch handler failed to land an assessment record (look for orchestrator errors in the tick log).
2. Confirm the active dispatch is sane: `.haiku/intents/{slug}/drift-dispatch.json`. The classify tool reads this to validate `tick_id`; a stale dispatch can mask a fresh one if the file isn't cleared on success.
3. Confirm the open marker count: telemetry `haiku.drift.markers.open_count` plus `total_count`. A high open count without matching assessments suggests the SPA is filtering by marker state and missing some.

**Remediation.** SPA cache → refresh (cache bust). Missing on-disk records but non-zero findings count → check the orchestrator tick log for dispatch errors; restart the MCP if a partial-write left an inconsistent state. Stale `drift-dispatch.json` → the classify tool deletes it on success; if it persists across multiple ticks, file an issue.

**Escalation.** SPA refresh does not reflect on-disk state → check `/api/drift-assessments` route handler (HTTP server log) for read errors; file a bug with the on-disk file list and the SPA payload.

---

## Scenario 10 — Pending-marker store leak

**Symptom.** A finding keeps re-firing after the agent classified it, or telemetry `haiku.drift.markers.open_count` grows monotonically across ticks while `total_count` matches.

**Diagnostic.**

1. Read `.haiku/intents/{slug}/drift-markers.json` (intent root, NOT per-stage). Look for entries where `path` matches the re-firing finding and `cleared_at` is null.
2. For each open marker, check the linked-resolution invariant. Per `drift-markers.ts:43-48` (MarkerInvariantError), exactly one of `linked_feedback_id` or `linked_revisit_target_stage` must be non-null. A leak almost always traces to a marker whose linked feedback was never closed/rejected (for `surface-as-feedback` outcome) or whose revisit never completed (for `trigger-revisit` outcome).
3. Confirm via telemetry: `haiku.drift.markers.open_count` is the saturation signal that flags this in real time (per unit-02 spec). `haiku.drift.clear_marker_failed` (emitted at `state-tools.ts:7618`) shows clear-time failures.

**Remediation.** Three escalating options:

1. **Resolve the linked artifact.** If the marker's `linked_feedback_id` is set, find the feedback file and resolve it (close or reject). The `clearMarkersForFeedbackSync` path (`baseline-clear-marker.ts:495`) clears all markers whose `linked_feedback_id` matches the closed feedback. If `linked_revisit_target_stage` is set, complete the revisit; the marker clears on revisit-complete via the legality matrix (`drift-markers.ts:299`).
2. **Manual edit (last-resort).** Copy `.haiku/intents/{slug}/drift-markers.json` to `drift-markers.json.bak` BEFORE editing. Set the offending entry's `cleared_at` to a current ISO-8601 timestamp and `resolved_sha` to the file's current SHA-256, conforming to the `PendingMarkerSchema` at `drift-markers.ts:85`. Atomically replace the file (write new content to `drift-markers.json.tmp` and `mv` into place, mirroring the `writeMarkersSync` pattern). Re-run `haiku_run_next` and observe whether the file stops re-firing.
3. **Kill-switch.** Set `drift_detection: false` in `.haiku/settings.yml` (scenario 2). The marker store is read by the gate; with the gate silenced, leaked markers stop influencing behavior. Use this while a deeper bug is investigated and file an issue with the offending marker JSON.

**Escalation.** Manual edit clears the marker but the same path leaks again on the next dispatch → the dispatch path itself is creating a marker without a valid linked artifact. File an issue with the marker JSON, the linked artifact (or absence thereof), and the dispatch tick id.

---

## Scenario 11 — Reconciliation gate fires on a stage with stable corpus

**Symptom.** `upstream_reconciliation_required` fires on a stage whose upstream corpus you believe is consistent. Telemetry shows `haiku.reconciliation.fingerprint.drifted` then `haiku.reconciliation.fingerprint.duration_ms` for the detector pass, then a non-empty findings list.

**Diagnostic.**

1. Compare the finding's cited files. Open each `occurrences[].file` at the listed line. The detector reports `tool_name`, `http_status`, or `field_name` divergences with cross-file evidence; if both occurrences point at the same identifier with no real divergence, the detector is mis-clustering.
2. Read `state.json.upstream_reconciliation_fingerprint` and recompute via `computeCorpusFingerprint(...)` (or trigger a re-tick and watch the telemetry). A mismatch means the corpus genuinely changed since the last successful scan; an exact match with the gate still firing is itself the bug.
3. Cross-check the synonym matrix at `upstream-reconciliation.ts:216-223` (tool-name verb classes) and `:439-446` (field-name pairs). False positives almost always trace to one of these heuristics treating two genuinely-distinct concepts as synonyms.

**Remediation.** Acknowledge to unblock:
```
haiku_reconciliation_acknowledge { intent: "{slug}", stage: "{stage}", rationale: "<≥10-char explanation>" }
```
The fix lives upstream of operations: file an issue with the offending finding's `kind`, `concept`, and full `occurrences` payload so the detector heuristic can be tightened.

**Escalation.** The same false positive recurs on multiple intents → the detector is genuinely too eager. File a single consolidated issue covering the pattern; do not file one per intent.

---

## Telemetry cross-reference

Every diagnostic step that says "check telemetry" or "check the metric" names an event from unit-02's completion criteria. The events used in this runbook:

| Event | Used in scenario |
|---|---|
| `haiku.drift.gate.tick` | 1, 2 |
| `haiku.drift.gate.duration_ms` | (latency budget; not cited inline) |
| `haiku.drift.findings.count` | 1, 9 |
| `haiku.drift.surface.size` | 1, 8 |
| `haiku.drift.baseline.corrupt` | 3 |
| `haiku.drift.baseline.write_failed` | 4 |
| `haiku.drift.markers.open_count` | 9, 10 |
| `haiku.drift.markers.total_count` | 9, 10 |
| `haiku.drift.assessments.count` | (saturation; not cited inline) |
| `haiku.drift.clear_marker_failed` | 10 |
| `haiku.reconciliation.fingerprint.drifted` | 5, 11 |
| `haiku.reconciliation.fingerprint.duration_ms` | 11 |
| `haiku.reconciliation.fingerprint.matched` | (steady state; not cited inline) |
| `haiku.reconciliation.fingerprint.established` | (first-time; not cited inline) |

If a needed event isn't listed above, the diagnostic step is wrong, not the runbook is incomplete — file feedback against unit-02 to extend the emitter set rather than referencing an undefined event.

---

## Feature coverage map

| Scenario | Feature file (under `.haiku/intents/out-of-band-human-file-modifications/features/`) |
|---|---|
| 1 | `silent-filesystem-drop-detection.feature` |
| 6 | `manual-change-assessment.feature` |
| 7 | `agent-writes-on-behalf-of-human.feature` |
| 8 | `explicit-spa-upload.feature` |
| 9 | `drift-assessment-visibility.feature` |

Scenarios 2, 3, 4, 5, 10, and 11 are operational footprint that the gate-detection features depend on but do not own — kill-switch behavior, baseline integrity, write-failure resilience, reconciliation-gate operations, marker-store hygiene, and false-positive triage.

---

## Closed issues / historical observability

### Marker-store concurrency race (closed via `removeMarkersSync`)

The drift gate originally used fire-and-forget async marker removal inside the synchronous tick path. Rapid successive ticks could re-detect the same stale marker before the async write landed, dispatching duplicate `manual_change_assessment` actions for the same file. The fix: a single synchronous batch-remove (`drift-markers.ts:393-405`, `removeMarkersSync`) called from the gate (`drift-detection-gate.ts:585-593`).

**How to verify the assumption still holds.** Confirm `removeMarkersSync` is the only marker-removal entry point in the gate's hot path. Specifically:

```
grep -n "removeMarker\|removeMarkersSync" packages/haiku/src/orchestrator/workflow/drift-detection-gate.ts
```

The gate file should reference `removeMarkersSync` only. Any new call to async `removeMarker` from within `runDriftDetectionGate` regresses the race; treat as a code-review red flag.
