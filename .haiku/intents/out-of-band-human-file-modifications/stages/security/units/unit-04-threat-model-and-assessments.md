---
title: Threat model + per-fix security assessments artifact
depends_on:
  - unit-01-upload-content-validation
  - unit-02-author-identity-binding
  - unit-03-symlink-toctou-and-csrf
inputs:
  - .haiku/intents/out-of-band-human-file-modifications/knowledge/VULN-REPORT.md
  - >-
    .haiku/intents/out-of-band-human-file-modifications/knowledge/DESIGN-DECISIONS.md
  - >-
    .haiku/intents/out-of-band-human-file-modifications/knowledge/IMPLEMENTATION-MAP.md
  - >-
    .haiku/intents/out-of-band-human-file-modifications/features/silent-filesystem-drop-detection.feature
  - >-
    .haiku/intents/out-of-band-human-file-modifications/features/agent-writes-on-behalf-of-human.feature
  - >-
    .haiku/intents/out-of-band-human-file-modifications/features/manual-change-assessment.feature
  - >-
    .haiku/intents/out-of-band-human-file-modifications/features/explicit-spa-upload.feature
  - >-
    .haiku/intents/out-of-band-human-file-modifications/features/drift-assessment-visibility.feature
outputs:
  - >-
    .haiku/intents/out-of-band-human-file-modifications/stages/security/artifacts/THREAT-MODEL.md
  - >-
    .haiku/intents/out-of-band-human-file-modifications/stages/security/artifacts/ASSESSMENTS.md
model: sonnet
quality_gates:
  - name: threat-model-exists
    command: >-
      test -f
      .haiku/intents/out-of-band-human-file-modifications/stages/security/artifacts/THREAT-MODEL.md
  - name: assessments-exists
    command: >-
      test -f
      .haiku/intents/out-of-band-human-file-modifications/stages/security/artifacts/ASSESSMENTS.md
  - name: threat-model-covers-stride
    command: >-
      bash -c 'for cat in spoofing tampering repudiation "information
      disclosure" "denial of service" "elevation of privilege"; do grep -qiE
      "$cat"
      .haiku/intents/out-of-band-human-file-modifications/stages/security/artifacts/THREAT-MODEL.md
      || { echo missing: $cat; exit 1; }; done'
  - name: threat-model-covers-trust-boundaries
    command: >-
      grep -qiE 'trust boundar|attack surface|entry point'
      .haiku/intents/out-of-band-human-file-modifications/stages/security/artifacts/THREAT-MODEL.md
  - name: threat-model-covers-each-feature
    command: >-
      bash -c 'for f in silent-filesystem-drop-detection
      agent-writes-on-behalf-of-human manual-change-assessment
      explicit-spa-upload drift-assessment-visibility; do grep -qE "$f"
      .haiku/intents/out-of-band-human-file-modifications/stages/security/artifacts/THREAT-MODEL.md
      || { echo missing: $f; exit 1; }; done'
  - name: assessments-cites-each-vuln
    command: >-
      bash -c 'for v in V-01 V-02 V-03 V-04 V-05 V-06 V-07 V-08 V-09 V-10 V-11;
      do grep -qE "$v\\b"
      .haiku/intents/out-of-band-human-file-modifications/stages/security/artifacts/ASSESSMENTS.md
      || { echo missing: $v; exit 1; }; done'
  - name: assessments-cites-each-fix-unit
    command: >-
      bash -c 'for u in unit-01-upload-content-validation
      unit-02-author-identity-binding unit-03-symlink-toctou-and-csrf; do grep
      -qE "$u"
      .haiku/intents/out-of-band-human-file-modifications/stages/security/artifacts/ASSESSMENTS.md
      || { echo missing: $u; exit 1; }; done'
status: pending
---
# Unit 04 — Threat model + assessments

## Scope

Author the two synthesis artifacts that the security stage owes:

1. **THREAT-MODEL.md** — STRIDE-based threat enumeration covering all entry points to the out-of-band human file modification feature: SPA upload routes, `haiku_human_write` MCP tool, drift gate, drift assessments. Identifies trust boundaries (agent ↔ workflow engine, workflow engine ↔ filesystem, browser ↔ MCP server) and dependencies (gray-matter, fastify, telemetry exporter).

2. **ASSESSMENTS.md** — links each of the 11 VULN-REPORT findings to the unit (or unit's quality gate) that closes it, plus residual risk for any deferred findings. This is the audit trail the gate-protocol's "no HIGH findings" condition checks against.

## Feature ownership (this unit's threat model surveys all five entry-point behaviors)

The threat model is the single synthesis artifact that maps every out-of-band-human-file-modification entry-point feature to its threat surface. Each of the five owned features describes a behavior whose attack surface this unit's threat model MUST enumerate:

- `features/silent-filesystem-drop-detection.feature` — pre-tick drift gate trust boundary; threats around baseline corruption (V-11) and the gate's silent-establish migration path.
- `features/agent-writes-on-behalf-of-human.feature` — `haiku_human_write` tool's author-attribution trust boundary; threats around self-reported author identity (V-03), symlink TOCTOU (V-04), and tick-counter determinism (V-05).
- `features/manual-change-assessment.feature` — drift-assessment dispatch and resolution; threats around unbounded `agent_rationale` writes (V-09).
- `features/explicit-spa-upload.feature` — SPA upload entry points; threats around content-type spoofing (V-01, V-02), upload-size DoS (V-07), CSRF on POST routes (V-08), and substring-based archived/locked checks (V-06).
- `features/drift-assessment-visibility.feature` — SPA assessment-rendering surface; threats around stored XSS landing in the rendered review UI (V-01, V-02 again, plus V-10 unsanitized feedback body).

## Approach

THREAT-MODEL.md uses STRIDE per entry point. For each row: threat actor, attack vector, impact, existing mitigation (cite code path), residual risk. The vuln-report findings are inputs — the threat model is the synthesis. Each of the five feature files above MUST be referenced by name in the threat-model body so the entry-point ↔ feature-spec linkage is auditable.

ASSESSMENTS.md is a finding-by-finding table: VULN-ID, severity, description (1 line), addressing unit (`unit-NN-xxx`), gate command verifying the fix, residual risk. For deferred findings (none currently expected — all 11 are mapped to units 01-03), residual risk includes a stage_revisit FB reference.

## Depends_on

- `unit-01-upload-content-validation` — closes V-01, V-02, V-07, V-09
- `unit-02-author-identity-binding` — closes V-03, V-05, V-06
- `unit-03-symlink-toctou-and-csrf` — closes V-04, V-08, V-10, V-11

This unit must run AFTER the fix units so the assessments can verify the gates pass.

## Completion criteria

- THREAT-MODEL.md exists with STRIDE coverage (all six categories named) and trust boundaries.
- THREAT-MODEL.md references each of the five feature files by basename: `silent-filesystem-drop-detection`, `agent-writes-on-behalf-of-human`, `manual-change-assessment`, `explicit-spa-upload`, `drift-assessment-visibility`.
- ASSESSMENTS.md exists, cites each of V-01 through V-11, and references each fix unit.
- Both artifacts under `.haiku/intents/out-of-band-human-file-modifications/stages/security/artifacts/`.

## References

- `.haiku/intents/out-of-band-human-file-modifications/knowledge/VULN-REPORT.md` (the discovery)
- `.haiku/intents/out-of-band-human-file-modifications/knowledge/DESIGN-DECISIONS.md`
- All four sibling units' specs
