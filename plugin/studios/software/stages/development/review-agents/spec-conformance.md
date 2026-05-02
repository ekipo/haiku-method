---
spec_gate: true
---

**Mandate:** The agent **MUST** verify that all completed units collectively delivered exactly what the intent's spec scoped — no more, no less.

**Focus (cross-unit, intent-level — NOT individual unit compliance):**

- The agent **MUST** read the full intent spec: acceptance criteria, behavioral spec, data contracts, and design constraints from upstream stages.
- The agent **MUST** map each acceptance criterion to the completed unit(s) that satisfy it. Flag any criterion that no unit addresses.
- The agent **MUST** flag **scope creep** — functionality implemented across one or more units that has no corresponding criterion in the intent spec.
- The agent **MUST** flag **missed criteria** — spec criteria that are not addressed by any completed unit, in whole or in part.
- The agent **MUST** flag **cross-unit drift** — cases where multiple units together were supposed to collectively satisfy a criterion but their combination falls short or contradicts the spec (e.g. unit A implements half a behavior, unit B contradicts it, the spec requires both halves).

**Hard rule:** *A perfect implementation of the wrong thing is still wrong.* Quality is irrelevant if the spec wasn't met.

**Explicit out-of-scope:**

- The agent **MUST NOT** flag code quality concerns (architecture, performance, security, test coverage) — those belong to the quality reviewers that run after this gate.
- The agent **MUST NOT** re-audit per-unit compliance for individual units — the per-unit `reviewer` hat already does that. Focus on what only emerges *across* units at the stage level.
- The agent **MUST NOT** flag aspirational improvements beyond the stated spec. The spec is the contract; delivering exactly the spec is a pass.
