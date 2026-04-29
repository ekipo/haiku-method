# Acceptance Criteria — Out-of-band Human File Modifications

> **Scope axis:** acceptance-criteria — what "done" looks like from the user's perspective.
> Sibling artifacts in this stage cover behavioral spec, data contracts, and coverage mapping; their substance is not duplicated here.
> Implementation details (tool signatures, baseline storage format, gate ordering) are out of scope for this artifact — design-stage decisions feed back into AC at refinement time.

---

## Variability Brief

The behavior of out-of-band detection and reaction varies along the following dimensions. Each is enumerated here so the General Rules and variant-specific subsections below can be grounded.

1. **Write-path origin** — Three sanctioned origins produce the same downstream detection signal but differ at the entry point:
   - `spa-upload` — file authored via the browse/review SPA upload affordance.
   - `filesystem-drop` — file written directly into the worktree (designer's local tool, IDE save, drag-and-drop, `cp`, etc.) with no SPA involvement.
   - `agent-on-behalf` — agent writes via the sanctioned human-attributed MCP tool in response to a user instruction in chat ("hey claude write this file").
2. **Tracked-surface class** — The file under drift detection falls into one of three classes:
   - `stage-output` — a deliverable file produced by a stage hat (layouts, generated HTML, screenshots, figma exports).
   - `knowledge-input` — a reference / context file in a stage's knowledge directory (research notes, design tokens, market data).
   - `unit-output` — a file produced by a hat during execution within a unit's working surface (the design stage explicitly carved off as design-stage open question; v1 boundary set by design stage).
3. **File payload type** — Diff payload available to the agent at classification time:
   - `text` — full unified diff is meaningful and shown.
   - `binary` — only file-changed signal + size delta + mime hint; no textual diff.
4. **Stage-of-ownership vs. active stage** — The drifted file may be owned by:
   - `current` — the stage currently active on this intent.
   - `earlier` — a stage upstream of the active stage (already-passed gate).
   The harness does not branch on this dimension; the agent's classification step decides whether earlier-stage drift triggers revisit.
5. **Operating mode** — At drift-detection time the intent is in one of:
   - `interactive` (HITL) — agent is in conversation with a human.
   - `pickup` (OHOTL) — `/haiku:pickup` resumed; one human is on call but not actively chatting.
   - `autopilot` (AHOTL) — `/haiku:autopilot` is driving without human-in-loop.
   Mode does not change the detection path; it changes how the assessment outcome is surfaced to the human (silent log vs. confirmation prompt). v1 default behavior is consistent across all three modes (silent classification, surfaced via the SPA's drift assessment view and the chat surface on the next turn).
6. **First-tick-after-upgrade vs. steady-state** — On the first tick after the feature ships for any existing intent, the gate must establish baselines without firing assessments. After that, steady-state detection applies.
7. **Classification outcome** — One of four:
   - `ignore` — change observed, no further action; baseline updates immediately.
   - `inline-fix` — agent absorbs the change into the current bolt; baseline updates immediately.
   - `surface-as-feedback` — open feedback item created; baseline holds (pending-assessment marker recorded), updates when feedback closes.
   - `trigger-revisit` — earlier stage revisited; baseline holds (pending-assessment marker recorded), updates when revisit completes.

---

## User Stories

### US-01: Designer Replaces a Stage Output File

**As** a designer collaborating on an active intent,
**I want to** replace a stage output file (layout HTML, figma export, screenshot) by saving over it in the worktree,
**so that** my updated design lands in the lifecycle without me having to invoke MCP tools or fight the framework.

**Priority:** P0

### US-02: Product Owner Edits a Deliverable and Asks the Agent to Extend

**As** a product owner reviewing a deliverable mid-flight,
**I want to** make a small edit to a file the agent produced and then ask the agent in chat to "extend this,"
**so that** the agent treats my edit as the new baseline and builds on it instead of regenerating from its prior state.

**Priority:** P0

### US-03: User Drops Knowledge Into the Elaborate Phase

**As** a user with reference material relevant to inception/elaboration,
**I want to** drop a knowledge file (research notes, design tokens, market data) into the intent's knowledge directory or upload it via the SPA,
**so that** the agent picks it up on the next workflow tick and integrates it into the elaboration phase without me having to paste it into chat.

**Priority:** P0

### US-04: User Asks the Agent to Write a Knowledge File on Their Behalf

**As** a user in conversation with the agent,
**I want to** say "hey claude, save this Tailwind config to the design references" and have the resulting file land as a human-attributed write,
**so that** the file is tracked as out-of-band human content (subject to drift detection on subsequent ticks) rather than as an agent-generated artifact.

**Priority:** P0

### US-05: User Reviews a Drift Assessment Decision in the SPA

**As** a user (designer, PO, or anyone reviewing the intent),
**I want to** see what files changed out-of-band, what the agent classified each change as, and the rationale,
**so that** I can verify the agent's response to my edits and understand how my change was handled.

**Priority:** P0

### US-06: User Catches a Misclassification and Overrides

**As** a user reviewing a drift assessment in the SPA,
**I want to** override the agent's classification (e.g., elevate an "ignore" to "trigger-revisit", or downgrade a "trigger-revisit" to "inline-fix") with a reason,
**so that** misclassifications don't silently waste a stage or silently drop my intent.

**Priority:** P1

### US-07: User Drops a Binary Stage Output (Image, Figma Export)

**As** a designer replacing a screenshot or exporting a new figma asset over the prior version,
**I want to** the system to treat the file as changed (even though no textual diff is available) and let the agent acknowledge the change without ceremony,
**so that** binary handoffs are not blocked by "I can't read this diff" failures.

**Priority:** P0

### US-08: User Operates an Existing Intent After Feature Upgrade

**As** a user with an active intent that pre-dates this feature shipping,
**I want to** the first tick after upgrade to silently establish baselines without firing a flood of `manual_change_assessment` actions for files that have drifted for unrelated reasons (cleanup, rebases, prior manual edits),
**so that** the upgrade is non-disruptive.

**Priority:** P0

### US-09: User Watches a Cross-Stage Drift Get Surfaced as Feedback or Revisit

**As** a user editing a file owned by an earlier stage (e.g., touching a product-stage spec while the intent is mid-development),
**I want to** the agent to classify the drift and route it appropriately (small typo → ignore or inline-fix; semantic redirect → trigger-revisit; ambiguous → surface-as-feedback),
**so that** earlier-stage edits don't silently corrupt downstream work and don't gratuitously restart the intent for cosmetic changes.

**Priority:** P0

### US-10: User Uses the SPA Upload Affordance Per Stage

**As** a user wanting an explicit upload UI rather than a filesystem drop,
**I want to** upload files through the SPA at the appropriate per-stage target (knowledge for elaborate-class stages, outputs for output-producing stages),
**so that** I have a sanctioned, discoverable path that doesn't require me to know the worktree layout.

**Priority:** P1 (filesystem drop covers the base case; SPA upload is a UX upgrade)

### US-11: User Resolves a Pending Drift Assessment by Closing the Underlying Feedback

**As** a user (or agent) closing a feedback item that was opened by `surface-as-feedback`,
**I want to** the pending-assessment marker to clear and the baseline to update to the file's then-current state,
**so that** the same drift doesn't re-fire on the next tick.

**Priority:** P0

### US-12: User Edits a File While the Agent Is Mid-Bolt

**As** a user who realizes mid-bolt they need to tweak a file,
**I want to** edit the file even though the agent is still running, and have the agent see my edit on the next tick (not blocked, not lost),
**so that** I'm never locked out of my own work product.

**Priority:** P0

---

## Acceptance Criteria

### General Rules

#### AC-G1: Drift detection runs on every workflow tick

- **Given** an active intent with at least one tracked file
- **When** `haiku_run_next` is called
- **Then** before any per-state dispatch, a drift-detection gate walks the tracked surface and compares each file's current SHA against its recorded baseline SHA
- **And** any file whose current SHA does not match its baseline is recorded as a drift event for this tick

#### AC-G2: Drift events emit a single workflow action per tick

- **Given** one or more drift events recorded on a tick
- **When** the drift-detection gate completes
- **Then** the workflow emits a single `manual_change_assessment` action (working name) carrying the full set of drift events for that tick
- **And** the action payload includes, per event: file path, owning stage, file class (`stage-output` / `knowledge-input` / `unit-output`), payload type (`text` / `binary`), unified diff (if text) or change signal (if binary), prior baseline SHA, observed SHA
- **And** no `manual_change_assessment` action is emitted on a tick with zero drift events

#### AC-G3: Classification is agent-driven, not harness-driven

- **Given** a `manual_change_assessment` action has been emitted
- **When** the agent processes the action
- **Then** the agent classifies each drift event into exactly one of four outcomes: `ignore`, `inline-fix`, `surface-as-feedback`, `trigger-revisit`
- **And** the harness does not pre-classify based on heuristics (file extension, size delta, file class, payload type)
- **And** the agent's classification rationale is recorded alongside each outcome in the assessment record

#### AC-G4: Baseline-update contract by outcome

- **Given** an agent classification of a drift event
- **When** the classification is `ignore`
- **Then** the baseline SHA for that file updates immediately to the observed SHA
- **And** no further action is recorded
- **When** the classification is `inline-fix`
- **Then** the baseline SHA for that file updates immediately to the observed SHA
- **And** the agent treats the human's edit as the new input for the current bolt
- **When** the classification is `surface-as-feedback`
- **Then** an open feedback item is created describing the drift
- **And** a pending-assessment marker is recorded for this file
- **And** the baseline SHA is NOT updated at classification time
- **And** the drift-detection gate skips this file on subsequent ticks while the marker is open
- **When** the classification is `trigger-revisit`
- **Then** a revisit is dispatched targeting the stage that owns the drifted file
- **And** a pending-assessment marker is recorded for this file
- **And** the baseline SHA is NOT updated at classification time
- **And** the drift-detection gate skips this file on subsequent ticks while the marker is open

#### AC-G5: Pending-assessment marker lifecycle

- **Given** a pending-assessment marker is open for a file (from `surface-as-feedback` or `trigger-revisit`)
- **When** the underlying feedback item closes (status becomes `addressed`, `closed`, or `rejected`)
- **Then** the marker is cleared
- **And** the baseline SHA updates to the file's SHA at marker-clearing time
- **When** the underlying revisit completes (the targeted stage re-passes its gate)
- **Then** the marker is cleared
- **And** the baseline SHA updates to the file's SHA at marker-clearing time

#### AC-G6: Existing PreToolUse hook on workflow-managed files is unchanged

- **Given** an agent attempts to write directly to a workflow-managed file (`units/*.md`, `feedback/*.md`, `intent.md`, `stages/*/state.json`) via `Write` or `Edit`
- **When** the PreToolUse hook fires
- **Then** the write is blocked with the existing redirect message naming the correct MCP tool
- **And** this behavior is identical before and after this feature ships

#### AC-G7: Workflow-managed files are not in the tracked surface

- **Given** the drift-detection gate walks the tracked surface
- **When** it encounters a workflow-managed file (`units/*.md`, `feedback/*.md`, `intent.md`, `stages/*/state.json`)
- **Then** the file is excluded from baselining and from drift detection
- **Note:** Workflow-managed files are agent-only by contract. Human writes to them via the filesystem are out of scope for v1; they are treated as the user violating the framework contract, not as a sanctioned out-of-band write.

#### AC-G8: First-tick-after-upgrade silently establishes baselines

- **Given** an intent that existed before the feature shipped, and the feature has now shipped
- **When** the first `haiku_run_next` tick after upgrade runs
- **Then** the gate records a baseline SHA for every file in the tracked surface
- **And** zero `manual_change_assessment` actions are emitted on this first tick, regardless of how many files differ from any prior agent-written state
- **And** the gate records a "baselines established" marker for the intent so subsequent ticks know to fire assessments

#### AC-G9: Concurrency model — eventual consistency, no locking

- **Given** the agent is mid-bolt
- **When** a human writes to a tracked file (filesystem, SPA, or via the human-write MCP tool)
- **Then** the write is not blocked
- **And** the agent's mid-bolt work continues without interruption
- **And** the next `haiku_run_next` tick observes the drift via the gate
- **And** the agent's mid-bolt result may be partially based on the pre-edit version of the file; this is accepted

#### AC-G10: All three write-path origins produce the same downstream detection signal

- **Given** a file is written via `spa-upload`, `filesystem-drop`, or `agent-on-behalf`
- **When** the next workflow tick runs
- **Then** the drift-detection gate observes the SHA mismatch identically in all three cases
- **And** the resulting `manual_change_assessment` action payload does not differ structurally based on origin (the gate only sees SHAs and file content; the origin signal is recorded separately on the assessment record where it is available, but is not required for classification)

#### AC-G11: Drift assessment record is durable and human-readable

- **Given** an agent classifies a drift event
- **When** the classification is recorded
- **Then** an assessment record is persisted that survives branch switches, worktree operations, and session restarts
- **And** the record contains: timestamp, file path, owning stage, payload type, prior baseline SHA, observed SHA, write-path origin (if known), classification outcome, agent rationale
- **And** the record is visible in the SPA's drift assessment view (US-05)

#### AC-G12: Same-tick multiple drift events are processed atomically

- **Given** multiple files have drifted since the last tick
- **When** the gate emits `manual_change_assessment`
- **Then** all drift events are presented to the agent in a single action payload
- **And** the agent's classification of each event is recorded as a single batch
- **And** baselines for all "ignore" / "inline-fix" outcomes update together
- **And** pending-assessment markers for all "surface-as-feedback" / "trigger-revisit" outcomes are recorded together

---

### Variant: Write-Path Origin — `spa-upload`

#### AC-SU1: SPA upload affordance is available per stage where a target exists

- **Given** the SPA is rendering an intent's stage view
- **When** the stage has a defined upload target (knowledge directory for elaborate-class stages, outputs directory for output-producing stages)
- **Then** an upload affordance is visible in that stage's view
- **When** the stage has no defined upload target
- **Then** no upload affordance is rendered in that stage's view

#### AC-SU2: SPA upload writes to the worktree

- **Given** a user uploads a file via the SPA upload affordance
- **When** the upload completes
- **Then** the file is written to the appropriate target directory in the worktree (knowledge or outputs)
- **And** the upload does NOT directly invoke the workflow engine
- **And** the next `haiku_run_next` tick's drift-detection gate observes the new or changed file
- **Note:** The SPA writes to disk and lets the next tick discover the change. This keeps the implementation surface small and unifies SPA, filesystem-drop, and agent-on-behalf through the same detection path.

#### AC-SU3: SPA upload preserves the file name unless the user renames

- **Given** a user uploads `figma-export-v2.png` via the SPA
- **When** the upload completes
- **Then** the file is written under the original name `figma-export-v2.png`
- **When** a file with the same name already exists at the target path
- **Then** the upload replaces the existing file (the resulting drift is detected and classified by the agent)

---

### Variant: Write-Path Origin — `filesystem-drop`

#### AC-FS1: Manual filesystem writes require zero tooling knowledge

- **Given** a user writes a file directly into the worktree using any local tool (editor save, `cp`, drag-and-drop, IDE)
- **When** the next `haiku_run_next` tick runs
- **Then** the drift-detection gate observes the file as drifted (or new)
- **And** the user did not invoke any MCP tool, skill, or SPA action
- **And** no announcement step is required from the user

#### AC-FS2: New files are detected as drift events

- **Given** a file at a path inside the tracked surface that has no recorded baseline
- **When** the gate runs
- **Then** the file is recorded as a drift event with a "new file" signal (prior baseline SHA is null)
- **And** the agent's classification covers new files identically to changed files (four outcomes apply)

#### AC-FS3: Editor temp files do not produce false positives

- **Given** a user's editor writes via tempfile-then-rename (e.g., `.foo.txt.swp` then rename to `foo.txt`)
- **When** the gate runs
- **Then** transient temp files matching common editor patterns (e.g., `.*\.swp$`, `.*~$`, `\.#.*`, `4913`, etc.) are excluded from baselining and drift detection
- **And** the post-rename final file is detected normally

---

### Variant: Write-Path Origin — `agent-on-behalf`

#### AC-AB1: Sanctioned MCP tool exists for human-attributed writes

- **Given** a user instructs the agent in chat: "hey claude, save this content to `<path>`"
- **When** the agent decides to honor the instruction
- **Then** the agent invokes a sanctioned MCP tool (working name: `haiku_human_write` or equivalent — design-stage decision) that writes the file with human attribution
- **And** the agent does NOT use its normal `Write` tool for this purpose

#### AC-AB2: Agent-on-behalf writes are detected as drift on the next tick

- **Given** the agent invoked the sanctioned human-write tool successfully
- **When** the next `haiku_run_next` tick runs
- **Then** the drift-detection gate observes the file as drifted (or new) identically to any other write-path origin
- **And** the resulting `manual_change_assessment` action surfaces normally
- **Note:** This means the agent's own classification step will fire on a write the agent itself performed. This is intentional — the classification step is what binds the human-attributed write into the lifecycle. The agent should classify these as `inline-fix` or `ignore` in the typical case; the classification record is the audit trail.

#### AC-AB3: Conversation surface acknowledges the human-attributed write

- **Given** the agent has invoked the sanctioned human-write tool
- **When** the agent's response in chat completes
- **Then** the chat surface includes an acknowledgment of the form "saved as a human-attributed file at `<path>` in stage `<stage>`"
- **And** the user understands the write was tracked, not regenerated

#### AC-AB4: Sanctioned tool path-integrity stance (deferred to design)

- **Open in design (Decision 9 in inception):** The sanctioned human-write tool's invocation requirements (trust + audit vs. explicit human confirmation) are a design-stage choice. AC for this dimension will be added at design-refinement time after the stance is settled. The two candidate AC families are sketched below for design's reference, not committed:
  - *Trust + audit family* — the tool fires without confirmation; attribution + assessment record are the audit trail.
  - *Explicit confirmation family* — the tool blocks for an `ask_user_visual_question` (or equivalent) confirmation signal before completing.

---

### Variant: Tracked-Surface Class — `stage-output`

#### AC-SO1: Stage output replacement is detected and classifiable

- **Given** a file in a stage's outputs directory (e.g., `stages/design/artifacts/layout.html`)
- **When** the file is replaced by a human via any write-path origin
- **Then** the drift-detection gate emits a drift event with `file class: stage-output` and `owning stage: design`
- **And** the agent's classification is dispatched with that context

#### AC-SO2: Stage output drift on a non-active (earlier) stage is classified, not auto-revisited

- **Given** the active stage is `development` and the drifted file is owned by `design`
- **When** the agent classifies the drift event
- **Then** the harness does not automatically dispatch a revisit
- **And** the agent's classification outcome (any of the four) is what determines whether revisit is triggered
- **And** if the classification outcome is `trigger-revisit`, the revisit targets the stage that owns the file (`design`)

---

### Variant: Tracked-Surface Class — `knowledge-input`

#### AC-KI1: Knowledge directory drops are detected as new-file drift events

- **Given** a user drops a new file into a stage's knowledge directory (e.g., `stages/inception/knowledge/research-notes.md`)
- **When** the gate runs
- **Then** the file is recorded as a drift event with `file class: knowledge-input`, `owning stage: inception`, and "new file" signal
- **And** the agent's classification is dispatched

#### AC-KI2: Knowledge integration during elaborate-class phases biases toward `inline-fix`

- **Given** the active stage is in an elaborate-class phase and a knowledge-input drift event is presented
- **When** the agent classifies the event
- **Then** the agent should classify as `inline-fix` in the typical case (incorporate into elaboration)
- **And** `surface-as-feedback` is appropriate when the upload appears to be intended as a finding rather than a context input
- **And** `ignore` is appropriate when the upload is a duplicate or supersedes a prior knowledge file
- **Note:** This is an agent-judgment guideline, not a harness rule. The harness does not enforce it.

---

### Variant: Tracked-Surface Class — `unit-output`

#### AC-UO1: Unit-output tracking boundary is design-stage decision

- **Open in design (Open for Design / "Tracked-surface boundary"):** Whether files inside `units/{unit-slug}/` working directories are part of the tracked surface in v1 is a design-stage decision. AC for this class will be added at design-refinement time after the boundary is drawn.

---

### Variant: File Payload Type — `text`

#### AC-T1: Text-file diff is presented to the agent

- **Given** a drifted file is text (mime detection or extension-based heuristic — design-stage decision)
- **When** `manual_change_assessment` is emitted
- **Then** the action payload includes a unified diff between the prior baseline content and the observed content
- **And** the diff is suitable for the agent to read and reason about

#### AC-T2: Diff size has a reasonable cap

- **Given** a drifted file's unified diff exceeds a configured size cap (design-stage decision; e.g., 200KB)
- **When** the action payload is constructed
- **Then** the diff is truncated with a "[truncated — view full file]" marker
- **And** the file's full path is included so the agent can inspect via `haiku_knowledge_read` or equivalent if classification requires it

---

### Variant: File Payload Type — `binary`

#### AC-B1: Binary drift presents a degraded payload

- **Given** a drifted file is binary (e.g., `.png`, `.jpg`, `.figma`, `.pdf`)
- **When** `manual_change_assessment` is emitted
- **Then** the action payload includes: file path, owning stage, file class, "binary" payload type, prior baseline SHA, observed SHA, prior file size, observed file size, mime hint
- **And** no textual diff is included

#### AC-B2: Default classification for binary drift is `inline-fix` unless context dictates otherwise

- **Given** a binary drift event
- **When** the agent classifies the event with no contradicting context
- **Then** the recommended classification is `inline-fix` (acknowledge the human's intent, update the baseline, fold into the current bolt)
- **And** `trigger-revisit` is appropriate when the binary is owned by an earlier stage and the size delta or context strongly suggests a redesign rather than a tweak
- **And** `ignore` is appropriate when the binary's content is known to be regenerable and the change is non-substantive (e.g., a re-export with metadata-only changes)
- **Note:** Agent-judgment guideline.

#### AC-B3: Vision tool invocation is permitted but not required

- **Given** the agent receives a binary drift event for an image file
- **When** the agent's classification rationale would benefit from visual inspection
- **Then** the agent may invoke a vision tool (e.g., `Read` on the image, `ask_user_visual_question`) to inform classification
- **And** the agent is not required to do so for any specific case

---

### Variant: Stage-of-Ownership — `current`

#### AC-CO1: Current-stage drift never triggers revisit

- **Given** a drift event whose owning stage equals the active stage
- **When** the agent classifies the event
- **Then** the classification options are `ignore`, `inline-fix`, or `surface-as-feedback`
- **And** `trigger-revisit` is not a valid outcome for current-stage drift (revisit-of-self is a no-op)

---

### Variant: Stage-of-Ownership — `earlier`

#### AC-EO1: Earlier-stage drift may classify to any of the four outcomes

- **Given** a drift event whose owning stage is earlier than the active stage
- **When** the agent classifies the event
- **Then** all four classification outcomes are valid (`ignore`, `inline-fix`, `surface-as-feedback`, `trigger-revisit`)
- **And** the rationale should reflect the cross-stage nature of the change

#### AC-EO2: `inline-fix` on earlier-stage drift does not advance or rewind the workflow

- **Given** an `inline-fix` classification on earlier-stage drift
- **When** the classification is recorded
- **Then** the baseline updates immediately
- **And** the workflow stays on the active stage (no revisit, no re-run of the earlier stage's gate)
- **And** the agent's notion of the earlier stage's outputs is updated for downstream reference but the workflow does not re-validate

---

### Variant: Operating Mode — `interactive` / `pickup` / `autopilot`

#### AC-OM1: Detection and classification behave identically across modes

- **Given** any operating mode
- **When** drift is detected and classified
- **Then** the gate, the action emission, the four-outcome classification, and the baseline-update contract are identical
- **And** the assessment record is durable across all modes (visible in SPA, persisted on disk)

#### AC-OM2: v1 default in autopilot mode is silent classification

- **Given** the intent is in autopilot mode
- **When** drift is detected and classified
- **Then** the agent classifies without pausing for human confirmation
- **And** the classification is surfaced via the SPA drift assessment view (US-05) and via the chat surface on the next interactive turn (US-06 override path)
- **Note:** A future enhancement may add per-mode confirmation policies; v1 is silent across all modes.

---

### Variant: Classification Outcome — `ignore`

#### AC-CI1: `ignore` updates baseline and produces no further action

- **Given** an `ignore` classification
- **When** the classification is recorded
- **Then** the baseline SHA updates to the observed SHA
- **And** no feedback item is created
- **And** no revisit is dispatched
- **And** the assessment record is the only durable artifact of the event

---

### Variant: Classification Outcome — `inline-fix`

#### AC-IF1: `inline-fix` updates baseline and feeds the current bolt

- **Given** an `inline-fix` classification on the active stage's current unit
- **When** the classification is recorded
- **Then** the baseline SHA updates to the observed SHA
- **And** the agent's next action in the bolt treats the human's edit as the input baseline (e.g., "extend this" works against the post-edit content)
- **And** no feedback item is created
- **And** no revisit is dispatched

---

### Variant: Classification Outcome — `surface-as-feedback`

#### AC-SF1: `surface-as-feedback` creates a normal feedback item

- **Given** a `surface-as-feedback` classification
- **When** the classification is recorded
- **Then** a feedback item is created via the existing feedback mechanism (`haiku_feedback`) on the owning stage
- **And** the feedback's `origin` is set to a value that identifies it as drift-derived (working name: `manual-change-assessment` — design-stage decision)
- **And** the feedback's body cites the file path, the diff (truncated if necessary), and the agent's rationale

#### AC-SF2: Pending-assessment marker is keyed to the feedback item

- **Given** a `surface-as-feedback` classification
- **When** the assessment record and feedback item are written
- **Then** a pending-assessment marker is recorded that links the file path to the feedback item ID
- **And** the marker prevents re-detection of drift on this file while the feedback is open
- **Note:** Pending-assessment marker storage is open in design.

#### AC-SF3: Closing the feedback clears the marker and updates the baseline

- **Given** an open pending-assessment marker linked to feedback item FB-NN
- **When** FB-NN's status transitions to `addressed`, `closed`, or `rejected`
- **Then** the marker clears
- **And** the baseline SHA updates to the file's SHA at marker-clearing time
- **And** the next tick observes no drift on this file (assuming no further human edit since)

---

### Variant: Classification Outcome — `trigger-revisit`

#### AC-TR1: `trigger-revisit` invokes revisit on the owning stage

- **Given** a `trigger-revisit` classification on a drift event whose owning stage is earlier than the active stage
- **When** the classification is recorded
- **Then** a revisit is dispatched targeting the owning stage (existing `haiku_revisit` mechanism or equivalent workflow path — design-stage decision on whether to use the existing revisit action or a new dispatch)
- **And** a pending-assessment marker is recorded linking the file path to the revisit dispatch
- **And** the baseline SHA does not update at classification time

#### AC-TR2: Revisit completion clears the marker and updates the baseline

- **Given** an open pending-assessment marker linked to a revisit dispatch
- **When** the targeted stage re-passes its gate (revisit completes)
- **Then** the marker clears
- **And** the baseline SHA updates to the file's SHA at marker-clearing time

#### AC-TR3: Revisit on the same stage as a drifted file is not allowed for current-stage drift

- **Given** a drift event whose owning stage equals the active stage (covered by AC-CO1)
- **When** the agent attempts to classify as `trigger-revisit`
- **Then** the classification is rejected by the harness with a redirect to one of the three valid current-stage outcomes
- **Note:** This protects against revisit-of-self loops.

---

## Edge Cases & Error Paths

#### AC-EE1: Concurrent same-tick drift on the same file (rare race)

- **Given** the agent's mid-bolt write and the human's filesystem write both land between two ticks
- **When** the next tick's gate runs
- **Then** the gate observes the file's final SHA (whichever write landed last) and records a single drift event
- **And** the agent classification proceeds normally
- **Note:** The gate cannot reconstruct the order of writes within the tick window. The agent's classification rationale should account for the ambiguity if visible in the diff content.

#### AC-EE2: Tracked file deleted by human

- **Given** a tracked file is deleted from the worktree (e.g., `rm` or SPA delete affordance — if any)
- **When** the gate runs
- **Then** a drift event is recorded with payload type `deleted` and observed SHA `null`
- **And** the agent's classification covers deletions (the four outcomes apply, with semantics: `ignore` = the deletion stands and baseline drops; `inline-fix` = the agent re-creates the file; `surface-as-feedback` = open feedback that the file was deleted; `trigger-revisit` = revisit the owning stage)

#### AC-EE3: Tracked-surface boundary violation — file written outside watched paths

- **Given** a human writes a file outside the tracked-surface boundary (e.g., to a project source directory the gate does not watch)
- **When** subsequent ticks run
- **Then** the gate does not detect the file
- **And** no drift event is emitted
- **And** the framework's behavior is unchanged from pre-feature behavior for that file
- **Note:** This is an accepted v1 limitation. Out-of-band writes outside the tracked surface are invisible to detection.

#### AC-EE4: Baseline file storage corrupted or missing

- **Given** the per-stage baseline storage is corrupted (parse error) or missing on a tick
- **When** the gate attempts to read it
- **Then** the gate logs a recoverable error
- **And** the gate falls back to the first-tick-after-upgrade behavior (re-establish baselines, no `manual_change_assessment` emitted on this tick)
- **And** subsequent ticks resume normal operation

#### AC-EE5: Agent classification times out or fails

- **Given** the agent receives a `manual_change_assessment` action and fails to produce a classification (timeout, error)
- **When** the next tick runs
- **Then** the drift event is re-presented to the agent (the unresolved drift is still observable on the gate)
- **And** the assessment record marks the prior attempt as failed for audit purposes
- **And** no baseline update occurs from the failed attempt

#### AC-EE6: Same file drifts a second time while a pending-assessment marker is open

- **Given** an open pending-assessment marker on file F (from a `surface-as-feedback` outcome)
- **And** the file F is edited again before the marker clears
- **When** the gate runs
- **Then** the gate skips F (per AC-G4, AC-SF2)
- **And** no second drift event is emitted for F
- **And** when the underlying feedback closes, the baseline updates to F's then-current SHA (capturing the second edit silently)
- **Note:** This is an accepted simplification for v1. The second edit is bundled into the resolution of the first finding. A future enhancement may surface "marker re-trigger" events.

#### AC-EE7: User overrides classification via SPA (US-06)

- **Given** an assessment record with classification outcome `ignore`
- **When** the user opens the assessment in the SPA and selects an override (e.g., "elevate to trigger-revisit") with a reason
- **Then** the assessment record is updated with `override.outcome` and `override.reason` and `override.author` (human user)
- **And** the corresponding side effects fire (revisit dispatched in this case, baseline rolled back if the original classification had updated it, pending-assessment marker recorded if applicable)
- **Note:** Override mechanics are P1 (US-06). v1 may ship without override and rely on the user creating manual feedback to correct misclassifications.

---

## Prioritization Summary

### P0 (must-have for completion)

- US-01, US-02, US-03, US-04, US-05, US-07, US-08, US-09, US-11, US-12
- All General Rules AC-G1 through AC-G12
- All Variant ACs except: AC-SU1/AC-SU2/AC-SU3 (SPA upload — P1), AC-AB4 (deferred to design), AC-UO1 (deferred to design), AC-EE7 (override — P1)
- Edge cases AC-EE1 through AC-EE6

### P1 (follow-up)

- US-06 (SPA override of classification)
- US-10 (SPA upload affordance per stage — filesystem drop covers base case)
- AC-SU1, AC-SU2, AC-SU3 (SPA upload variant ACs)
- AC-EE7 (SPA classification override)

### Open / Deferred to Design

- AC-AB4 (Human-write-path integrity stance — Decision 9 in inception)
- AC-UO1 (Tracked-surface boundary on `units/` — Open for Design)
- AC-T2 size cap value (e.g., 200KB) — design-stage tunable
- AC-FS3 specific temp-file pattern set — design-stage decision
- Pending-assessment marker storage location — design-stage decision (named in inception's Open for Design)
- Baseline storage location — design-stage decision (named in inception's Open for Design)

---

## Context Boundaries (Cross-Cutting Notes)

These are observations that surfaced while researching acceptance criteria but whose substance belongs in sibling product-stage artifacts. They are noted here so they are not lost at integration time, but the substance is left for the sibling agent to author.

- **Behavioral spec dependency** — The `manual_change_assessment` action's exact payload shape, ordering relative to existing pre-tick gates (feedback-triage), and lifecycle inside the workflow engine are behavioral-spec territory. AC-G2 references the action and its payload at the user-observable level; the wire-level spec belongs in BEHAVIORAL-SPEC.
- **Data contracts dependency** — The on-disk shape of the baseline record, the pending-assessment marker, and the assessment record (frontmatter fields, file naming, directory layout) are data-contract territory. AC-G4 / AC-G5 / AC-G11 reference these at the user-observable level (durability, survival across operations); the schema belongs in DATA-CONTRACTS.
- **Coverage mapping dependency** — Mapping each AC above to specific test layers (unit, integration, e2e) and identifying which existing test surfaces (the orchestrator harness, the SPA's playwright suite, etc.) cover which AC is COVERAGE-MAPPING territory.
- **Security boundary (not in this stage)** — The "Hook bypass becomes a liability" risk in inception names a security concern that may produce a separate inception/design pass on the human-write-path integrity (Decision 9). This is referenced in AC-AB4 as deferred; the substance lives wherever Decision 9 is finally settled, not in this artifact.
- **Migration / upgrade story** — AC-G8 covers the user-facing first-tick-after-upgrade behavior; the operations and rollout story (feature flag, staged rollout, telemetry on the first-tick storm) lives in the operations stage, not here.
