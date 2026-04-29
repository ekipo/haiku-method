---
title: Data contracts
model: sonnet
depends_on:
  - unit-01-acceptance-criteria
inputs:
  - intent.md
  - knowledge/DISCOVERY.md
  - stages/design/artifacts/ARCHITECTURE.md
  - stages/design/artifacts/MCP-TOOL-CONTRACT.md
  - stages/design/artifacts/TRACKED-SURFACE-BOUNDARY.md
  - knowledge/DATA-CONTRACTS.md
outputs:
  - >-
    .haiku/intents/out-of-band-human-file-modifications/product/DATA-CONTRACTS.md
status: pending
---
# Data contracts

Ratify the data-contracts knowledge artifact (produced by the discovery fan-out at `.haiku/intents/out-of-band-human-file-modifications/knowledge/DATA-CONTRACTS.md`) and finalize it as the product-stage `DATA-CONTRACTS.md` at `product/DATA-CONTRACTS.md` (the canonical product-stage location). The file documents every persistence schema, workflow-action payload, MCP tool contract, HTTP API surface, and internal event payload that this intent introduces, with field-level types and worked JSON examples.

## Scope

DATA-CONTRACTS.md must cover, with explicit field tables (name, type, required/optional, default, constraints) and worked JSON examples:

- **Naming conventions** — pinned canonical entity names: `baseline`, `tracked_file`, `drift_finding`, `assessment`, `classification`, `pending_marker` — used identically across persistence, action payloads, MCP, HTTP, events
- **Persistent state schemas** — `Baseline` (per-stage map of tracked_file_path → SHA + author_class + last_updated_tick), `PendingMarker` (open assessment-pending records for non-terminal classifications), `Assessment` (closed classification records with outcome, agent rationale, baseline-update timestamp)
- **Workflow-action payloads** — `DriftFinding` shape emitted by the pre-tick gate, the `manual_change_assessment` action input/output JSON, `Classification` shape per finding (one of: ignore / inline-fix / surface-as-feedback / trigger-revisit), legality matrix per change_kind (added / modified / deleted / mime-changed), pre-tick gate ordering vs feedback-triage gate
- **MCP tool contracts** — `haiku_human_write_file`, `haiku_baseline_init`, `haiku_classify_drift`, `haiku_baseline_clear_marker` (or whatever the design stage's MCP-TOOL-CONTRACT.md named them) with request/response/error tables and atomic side-effect ordering
- **HTTP API surface** — `POST /uploads/stage-output`, `POST /uploads/knowledge`, `GET /assessments`, `GET /assessments/{id}` with multipart shapes and full HTTP error tables
- **Internal events** — `drift_detected`, `assessment_recorded`, `pending_marker_cleared` with payload, producer, consumers
- **Cross-surface naming audit** — explicit table proving every entity has the same name across disk, action payload, MCP, HTTP, and events; document any intentional variance with the conversion rule

## Completion Criteria

- DATA-CONTRACTS.md exists at `.haiku/intents/out-of-band-human-file-modifications/product/DATA-CONTRACTS.md` and is at least 6KB of substantive prose with worked JSON examples
- Every persistence schema (Baseline, PendingMarker, Assessment) has a field table with name / type / required / default / constraints columns
- Every MCP tool contract has request / response / error tables and at least one worked JSON example
- Every HTTP endpoint has request shape (including multipart parts), response shape, and an error-code table covering at least 4xx classes (400/401/403/404/409/413) and the 5xx catch-all
- Every internal event has payload / producer / consumers documented
- Cross-surface naming audit table is present and proves entity names match across all 5 surfaces (disk, action, MCP, HTTP, events); any intentional variance is documented with the conversion rule
- Document is internally consistent with ARCHITECTURE.md's baseline-update contract and MCP-TOOL-CONTRACT.md's tool semantics — no schema field contradicts a design decision
- Document does NOT contain TypeScript file paths under packages/ or shell commands — those belong in development-stage units
- Boundary callouts to development stage are explicit: tracked-surface boundary substance, storage location, tick ID format, diff cap, SPA host process — referenced, not authored here
