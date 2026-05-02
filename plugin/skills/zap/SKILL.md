---
name: zap
description: Zero-ceremony single-unit execution — run one task directly through a stage's hat loop without intent or workflow scaffolding
---

# Zap

Run a single task directly through a stage's hat loop. No intent file, no unit decomposition, no workflow tick — just the studio's hat sequence applied inline to the work.

**Use for:** bug fixes, typos, config tweaks, small refactors — any task where the cost of a mistake is "edit and re-run," not "rollback a pipeline."

**Not for:** tasks that span multiple stages, need architecture decisions, or involve multiple sub-systems. Use `/haiku:quick` or `/haiku:start` for those.

## Arguments

- `studio` — Studio slug (e.g. `software`, `marketing`, `documentation`). Optional — defaults to `software` if the project has a git repo and no other context narrows it.
- `stage` — Stage within the studio (e.g. `development`, `inception`, `design`). Optional — defaults to the most execution-oriented stage in the studio (e.g. `development` for `software`).

## Process

### 1. Resolve studio and stage

**If studio is provided:** validate it exists via `haiku_studio_stage_get`. If not found, call `haiku_studio_list` and surface the available options via `AskUserQuestion`.

**If studio is NOT provided:**
1. Call `haiku_studio_list` to see what's available.
2. Check project context (language files, existing `.haiku/settings.yml`) to infer the best fit.
3. Default to `software` if it exists and no other signal is stronger.

**If stage is NOT provided:** use the studio's primary execution stage. For `software` this is `development`. For others, pick the build-class stage from the studio's `stages:` list (the one that produces code/artifacts, not research or design).

### 2. Load stage context

Call `haiku_studio_stage_get { studio: "<studio>", stage: "<stage>" }`.

The response contains:
- `hats` — ordered list of hat names (e.g. `["planner", "builder", "reviewer"]`)
- `stage_md` — absolute path to the STAGE.md file
- `body` — the stage's prose description

Derive the hats directory path: `dirname(stage_md) + "/hats/"`. Each hat file lives at `<hats_dir>/<hat>.md`.

Read every hat file in the `hats:` list with the Read tool before dispatching.

### 3. Clarify the task (brief prelaboration)

If the user's task description is vague (no clear action, no clear target, or under one sentence), ask ONE focused question via `AskUserQuestion` with pre-populated `options[]`. Otherwise skip.

**Do NOT** run a full elaboration phase — one question at most.

### 4. Run the hat loop

Execute each hat in the `hats:` list as a **sequential** subagent. Each hat receives the prior hat's output. Do NOT parallelize.

For each hat, spawn a subagent (Task tool) with the prompt below. Wait for it to return before spawning the next one.

---

#### Hat subagent prompt

```
You are executing a zap task as the **<HAT>** hat in stage **<STAGE>** of studio **<STUDIO>**.

This is a zap run — no workflow engine, no unit files, no haiku_* tool calls. Work directly on the repo.

## Stage scope

<STAGE.md body — paste verbatim>

## Your mandate: <HAT>

<hat.md body — paste verbatim>

## Task

<user's task description>

<if this is not the first hat:>
## Input from prior hat (<PRIOR_HAT>)

<prior hat's returned output — paste verbatim>

## Instructions

<hat-specific instructions — see below>
```

---

#### Per-hat instructions

**Planner hat (first hat, plan role):**
```
1. Read the task and stage scope above.
2. Produce a concise implementation plan:
   - Files to inspect or modify (with reasoning)
   - Step-by-step approach (3–5 items)
   - Risks or edge cases to watch for
3. Return your plan as plain text. Do NOT implement — planning only.
```

**Builder / doer hat (do role):**
```
1. Read the plan from the prior hat.
2. Implement the task according to the plan.
3. If the project has quality gates (tests, lint, typecheck), run them and fix failures.
4. Commit your changes: `git add -A && git commit -m "<brief description>"`.
5. Return a summary: what you changed, which files, and quality gate results.
```

**Verifier / reviewer hat (final hat, verify role):**
```
1. Read the task description and the builder's output summary.
2. Verify the work meets the task's success criteria:
   - Does the change address exactly what was asked?
   - Is the code internally consistent and free of obvious regressions?
   - Are there edge cases the builder missed that the stage scope would flag?
3. Your final message MUST be exactly one of:
   - `PASS — <one-sentence summary of what was verified>`
   - `FAIL: <specific reason the task is not complete or correct>`
4. Do NOT run quality gates — that was the builder's job. Focus on correctness and fit.
5. Do NOT call any haiku_* tools.
```

---

### 5. Handle the verifier verdict

After the verifier hat returns:

**If `PASS`:** report success to the user. Briefly describe what was done (files changed, tests run). Done.

**If `FAIL`:** surface the failure reason to the user. Ask via `AskUserQuestion`:
- options: `["Retry the full hat loop with this failure as context", "Abandon — I'll fix it manually"]`

If the user picks retry: re-run from step 4 with the failure reason prepended to the task description as `## Prior failure context: <reason>`.

If the user picks abandon: acknowledge and stop.

## Guardrails

- **Scope check:** if the task description spans multiple stages (e.g. "redesign the auth flow AND implement the backend AND write the tests"), recommend `/haiku:quick` or `/haiku:start` and explain why. Don't blindly zap a multi-stage task through a single stage's hat loop.
- **Stage validation:** if `haiku_studio_stage_get` returns `found: false`, explain the issue and list valid studios/stages via `haiku_studio_list`.
- **Stateless:** no `.haiku/` files are written. If the user needs formal traceability, suggest `/haiku:quick`.
- **Hat count:** most stages have 3 hats. If a stage has more (adversarial loops, etc.), run all of them in sequence — the hat order in `hats:` is the authority.
