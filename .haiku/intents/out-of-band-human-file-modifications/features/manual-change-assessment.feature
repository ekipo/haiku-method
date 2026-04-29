Feature: Manual change assessment classification by the agent
  As the workflow engine
  I need the agent to classify each detected out-of-band change into one of four outcomes
  So that human edits are routed to the right downstream behavior without harness-driven heuristics

  Background:
    Given an active intent "demo-intent" with stage "design"
    And the pre-tick out-of-band gate has detected drift on one or more tracked files
    And the workflow has emitted a "manual_change_assessment" action with the diff payload
    And the four valid classification outcomes are: ignore, inline-fix, surface-as-feedback, trigger-revisit

  # ---------------------------------------------------------------------------
  # Happy Path: each of the four outcomes
  # ---------------------------------------------------------------------------

  Scenario: Agent classifies a typo correction as ignore
    Given the diff shows a single-character change in a sentence in "stages/design/outputs/spec.md"
    And the change is on a stage owned by the active stage
    When the agent classifies the change with outcome "ignore"
    Then the classification record is persisted with outcome "ignore" and a one-line rationale
    And the new file state is recorded as the new SHA baseline
    And no feedback file is created
    And the workflow returns to its prior phase
    And on the next tick no "manual_change_assessment" fires for this file

  Scenario: Agent classifies a small-but-meaningful edit as inline-fix
    Given the diff shows a Product Owner adding two new acceptance criteria to "stages/design/outputs/spec.md"
    And the User asked the agent to "extend this"
    When the agent classifies the change with outcome "inline-fix"
    Then the classification record is persisted with outcome "inline-fix" and rationale
    And the agent continues the current bolt with the human's edit as the new starting state
    And the agent's subsequent writes do not regress the human's added lines
    And the new combined SHA becomes the next baseline

  Scenario: Agent classifies an out-of-spec change as surface-as-feedback
    Given the diff shows a designer replacing "stages/design/outputs/dashboard-layout.html" with a layout that contradicts an active acceptance criterion
    When the agent classifies the change with outcome "surface-as-feedback"
    Then a feedback item is created at the appropriate scope (stage or intent)
    And the feedback's body cites the specific conflicting acceptance criterion
    And the feedback's origin is "out-of-band-change"
    And the classification record references the new feedback id
    And the SHA baseline is updated to the human's new state
    And the next tick processes the feedback through the existing fix-loop

  Scenario: Agent classifies a fundamental redirect as trigger-revisit
    Given the diff shows the User replacing the entire problem statement in "stages/inception/outputs/intent.md"
    And the active stage is "design" (downstream of inception)
    When the agent classifies the change with outcome "trigger-revisit"
    Then the classification record names the target stage "inception" and the rationale
    And the workflow invokes haiku_revisit on stage "inception"
    And the SHA baseline is updated to the human's new state
    And subsequent stage handlers run from the revisited stage

  # ---------------------------------------------------------------------------
  # Cross-stage drift cascade policy
  # ---------------------------------------------------------------------------

  Scenario: Cross-stage drift does not auto-revisit; the agent decides
    Given drift is detected on "stages/design/outputs/spec.md"
    And the active stage is "development" (downstream of design)
    When the workflow emits "manual_change_assessment"
    Then the harness does NOT automatically invoke haiku_revisit
    And the action payload includes the file's owning stage as "design"
    And the agent receives all four outcomes as valid choices
    When the agent chooses outcome "trigger-revisit" with target stage "design"
    Then haiku_revisit is invoked with target "design"
    When the agent chooses outcome "surface-as-feedback" instead
    Then a feedback item is created scoped to stage "design"
    And no revisit is invoked

  # ---------------------------------------------------------------------------
  # Visibility and audit
  # ---------------------------------------------------------------------------

  Scenario: Classification record is durable and human-readable
    When the agent records any classification outcome
    Then the record is persisted at intent scope under a deterministic path
    And the record contains: timestamp, file paths, change_type, outcome, rationale
    And the SPA's drift assessment view lists all classification records for the intent
    And the records survive a session restart
    And the records survive a worktree branch switch

  Scenario: Each detected file is classified individually within one assessment
    Given drift is detected on three files in one tick
    When the agent processes the "manual_change_assessment" action
    Then the agent records one classification outcome per file
    And the outcomes may differ (e.g., file A "ignore", file B "inline-fix", file C "surface-as-feedback")
    And only one downstream effect fires per file (no double-counting)

  # ---------------------------------------------------------------------------
  # Error scenarios
  # ---------------------------------------------------------------------------

  Scenario: Agent returns an invalid classification outcome
    When the agent attempts to classify a change with outcome "delete"
    Then the workflow rejects the outcome with error "Invalid classification: must be one of [ignore, inline-fix, surface-as-feedback, trigger-revisit]"
    And no record is persisted
    And the workflow remains in the assessment-pending state
    And the next tick re-emits the same "manual_change_assessment" action

  Scenario: Agent omits the rationale on a non-ignore outcome
    When the agent classifies a change as "trigger-revisit" with empty rationale
    Then the workflow rejects the classification with error "Rationale required for non-ignore outcomes"
    And no revisit is invoked

  Scenario: Binary file diff is uninformative
    Given the changed file is "stages/design/outputs/mockup.png" (binary)
    When the workflow emits "manual_change_assessment"
    Then the action payload omits the textual diff
    And the payload sets a flag "binary_or_missing: true"
    And the payload includes file size delta and content-type
    And the agent's default outcome (per design-stage decision) is applied
    And the rationale notes "binary file, no textual diff available"

  # ---------------------------------------------------------------------------
  # Edge cases: idempotency and loops
  # ---------------------------------------------------------------------------

  Scenario: Classified-as-ignore file does not re-fire on the next tick
    Given a file was classified as "ignore" in the previous tick
    And the file has not changed since
    When the agent calls haiku_run_next
    Then the pre-tick out-of-band gate sees the file matches the new baseline
    And no "manual_change_assessment" fires for this file

  Scenario: Re-edited after classification fires a new assessment
    Given a file was classified as "ignore" with baseline updated
    When the User edits the file again with new content
    And the agent calls haiku_run_next
    Then the pre-tick out-of-band gate detects the new SHA mismatch
    And a fresh "manual_change_assessment" action fires for the same file

  Scenario: Maximum number of classifications per tick is bounded
    Given drift is detected on more than 50 files in a single tick
    When the workflow emits "manual_change_assessment"
    Then the action payload is paginated with the first 50 file entries
    And the payload includes a flag "more_pending: true" and the remaining count
    And the agent classifies the first batch
    And the next tick emits a second "manual_change_assessment" with the remaining files
