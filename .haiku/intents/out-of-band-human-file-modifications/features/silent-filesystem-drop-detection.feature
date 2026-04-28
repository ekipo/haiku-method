Feature: Silent filesystem drop detection
  As a Designer or Product Owner working alongside a H·AI·K·U intent
  I want files I drop into the worktree to be noticed by the workflow on the next tick
  So that my changes are never silently overwritten by the agent's next action

  Background:
    Given an active intent "demo-intent" in stage "design" running in studio "software"
    And per-stage SHA baselines have been established for stage "design"
    And the tracked surface for stage "design" includes "stages/design/outputs/"
    And no pending out-of-band assessments exist
    And the next workflow operation is the agent calling haiku_run_next

  # ---------------------------------------------------------------------------
  # Happy Path: implicit detection on next tick
  # ---------------------------------------------------------------------------

  Scenario: Designer replaces a stage output layout file
    Given the file "stages/design/outputs/dashboard-layout.html" was last written by the agent with SHA "agent-sha-001"
    When the Designer replaces "stages/design/outputs/dashboard-layout.html" via direct filesystem write with new content having SHA "human-sha-002"
    And the agent calls haiku_run_next
    Then the pre-tick out-of-band gate detects the SHA mismatch on "stages/design/outputs/dashboard-layout.html"
    And the workflow emits a "manual_change_assessment" action
    And the action payload lists "stages/design/outputs/dashboard-layout.html" as a changed file
    And the action payload includes the unified text diff for the file
    And the agent is instructed to classify the change before any normal stage handler runs

  Scenario: Product Owner edits an existing stage output deliverable
    Given the file "stages/design/outputs/spec.md" was last written by the agent with SHA "agent-sha-010"
    When the Product Owner hand-edits "stages/design/outputs/spec.md" outside any UI, producing SHA "human-sha-011"
    And the agent calls haiku_run_next
    Then the pre-tick out-of-band gate detects the SHA mismatch
    And the workflow emits a "manual_change_assessment" action
    And the action payload's diff shows only the lines the Product Owner changed

  Scenario: User drops a brand-new knowledge file into the elaborate phase
    Given the active intent is in stage "inception" at phase "elaborate"
    And the tracked surface for stage "inception" includes "knowledge/"
    And the file "knowledge/market-research.pdf" did not exist at the previous tick
    When the User drops "knowledge/market-research.pdf" into the worktree via direct filesystem write
    And the agent calls haiku_run_next
    Then the pre-tick out-of-band gate detects an added file under the tracked surface
    And the workflow emits a "manual_change_assessment" action with change_type "added"
    And the action payload lists "knowledge/market-research.pdf" with size and content-type metadata
    And the agent is instructed to classify the addition before continuing elaborate

  # ---------------------------------------------------------------------------
  # Edge cases: tick model boundaries
  # ---------------------------------------------------------------------------

  Scenario: Multiple files change between two ticks
    Given files "stages/design/outputs/a.html", "stages/design/outputs/b.html", and "stages/design/outputs/c.html" were last written by the agent
    When the Designer replaces all three files via filesystem writes
    And the agent calls haiku_run_next
    Then the workflow emits exactly one "manual_change_assessment" action
    And the action payload lists all three files
    And each file entry carries its own diff and change_type

  Scenario: Zero changes since the last tick
    Given no tracked file has changed since the last baseline
    When the agent calls haiku_run_next
    Then the pre-tick out-of-band gate detects no SHA mismatches
    And no "manual_change_assessment" action is emitted
    And the normal stage handler runs

  Scenario: Change is detected immediately on the next tick, not in real time
    Given the agent is mid-bolt processing a unit
    When the Designer replaces "stages/design/outputs/layout.html" while the bolt is in flight
    Then no detection event fires during the in-flight bolt
    And the agent's mid-bolt work continues against the pre-edit version of the file
    When the agent calls haiku_run_next at the end of the bolt
    Then the pre-tick out-of-band gate observes the drift
    And the workflow emits a "manual_change_assessment" action

  # ---------------------------------------------------------------------------
  # Edge cases: tracked-surface boundary
  # ---------------------------------------------------------------------------

  Scenario: Files outside the tracked surface are ignored
    Given the tracked surface for stage "design" is "stages/design/outputs/" and "knowledge/"
    When the User edits "README.md" at the repository root
    And the agent calls haiku_run_next
    Then the pre-tick out-of-band gate ignores "README.md"
    And no "manual_change_assessment" action is emitted

  Scenario: Editor temp files do not produce false drift
    Given the tracked surface includes "stages/design/outputs/"
    When a human editor briefly creates "stages/design/outputs/.spec.md.swp" during a save
    And the temp file is removed before the next tick fires
    And the agent calls haiku_run_next
    Then the pre-tick out-of-band gate sees no net change
    And no "manual_change_assessment" action is emitted

  # ---------------------------------------------------------------------------
  # Error scenarios
  # ---------------------------------------------------------------------------

  Scenario: Tracked file is deleted from the worktree
    Given the file "stages/design/outputs/old-mock.html" exists with a recorded baseline SHA
    When the User deletes "stages/design/outputs/old-mock.html" from the filesystem
    And the agent calls haiku_run_next
    Then the pre-tick out-of-band gate detects the deletion
    And the workflow emits a "manual_change_assessment" action with change_type "deleted"
    And the action payload includes the path of the deleted file
    And the diff payload is omitted with a flag "binary_or_missing"

  Scenario: Baseline storage is unreadable on tick
    Given the per-stage SHA baseline storage is corrupted or missing
    When the agent calls haiku_run_next
    Then the pre-tick out-of-band gate logs a recoverable error naming the storage location
    And the gate enters "recover-baseline" mode for this tick only
    And the gate re-establishes baselines from current SHAs without firing assessment
    And the normal stage handler runs

  Scenario: First tick after feature ships on a pre-existing intent
    Given a previously running intent has no per-stage SHA baselines recorded
    When the agent calls haiku_run_next for the first time after the feature ships
    Then the pre-tick out-of-band gate enters "establish-baseline" mode
    And current SHAs are recorded as the new baseline
    And no "manual_change_assessment" action is emitted on this first tick
    And subsequent ticks operate normally
