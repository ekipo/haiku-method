Feature: Drift assessment visibility in chat and SPA
  As a Human collaborator (Designer, Product Owner, Reviewer)
  I want to see what was detected, what was decided, and why
  So that I can trust the framework with my work product without re-checking it manually

  Background:
    Given an active intent "demo-intent" is loaded in the browse SPA
    And the SPA's "Drift assessments" view exists per intent
    And classification records are written at intent scope and survive session restarts

  # ---------------------------------------------------------------------------
  # Happy Path: SPA drift assessment view
  # ---------------------------------------------------------------------------

  Scenario: Drift assessment view lists recent classifications most-recent-first
    Given three classification records exist with timestamps t1 < t2 < t3
    When the User opens the "Drift assessments" view
    Then the records are listed in order: t3, t2, t1
    And each row shows: file path(s), change_type, outcome, timestamp, rationale snippet
    And clicking a row reveals the full unified diff and full rationale

  Scenario: Pending-assessment badge appears on the affected file in the SPA
    Given drift is detected on "stages/design/outputs/dashboard-layout.html"
    And the agent has not yet classified the change
    When the User opens the "Outputs" section of stage "design"
    Then "dashboard-layout.html" shows a "Pending agent assessment" badge
    When the agent classifies the change with any outcome
    Then the badge is replaced with the outcome label (e.g., "Acknowledged", "Extending", "Surfaced as FB-NN", "Revisited inception")

  Scenario: Outcome badge links to the underlying record
    Given a classification with outcome "surface-as-feedback" producing feedback "FB-07" exists
    When the User clicks the outcome badge "Surfaced as FB-07"
    Then the SPA navigates to the feedback detail view for FB-07

  # ---------------------------------------------------------------------------
  # Happy Path: chat surface notification
  # ---------------------------------------------------------------------------

  Scenario: Agent surfaces the classification result in chat after an autopilot tick
    Given the intent is in mode "autopilot"
    And drift was detected on one file and classified as "inline-fix"
    When the next agent message renders in chat
    Then the message states: which file changed, what was decided, and why
    And the message links to the SPA drift assessment view for full context

  Scenario: User asked the agent to write a file; the chat acknowledges the human-attributed write
    When the agent successfully invokes the sanctioned human-write tool
    Then the next agent message states "Saved <path> as a human-attributed file in stage <stage>"
    And the message includes a one-line note that the next tick will assess the change

  # ---------------------------------------------------------------------------
  # Edge cases: large change sets and noise control
  # ---------------------------------------------------------------------------

  Scenario: Many files classified in one tick are summarized
    Given a single tick produced 12 classifications across 12 files
    When the next agent message renders in chat
    Then the message summarizes "12 changes detected" with breakdown by outcome
    And the message includes a deep link to the SPA drift assessment view filtered to this tick
    And no individual diff is inlined into the chat message

  Scenario: Successive ignore-classifications do not spam chat
    Given the previous three ticks each classified one file as "ignore"
    When the most recent agent message renders in chat
    Then ignore-only classifications appear as a single line summary
    And no per-file rationale is inlined

  # ---------------------------------------------------------------------------
  # Error scenarios
  # ---------------------------------------------------------------------------

  Scenario: Drift assessment view loads with zero records
    Given no classifications have ever fired for this intent
    When the User opens the "Drift assessments" view
    Then the view shows an empty state with copy: "No out-of-band changes detected yet"
    And the view does not error

  Scenario: Classification record file is corrupted
    Given the classification record file for one entry has invalid JSON
    When the User opens the "Drift assessments" view
    Then the corrupted entry is shown with a "Record could not be parsed" warning
    And the remaining entries render normally
    And the view logs a recoverable error to the SPA console

  # ---------------------------------------------------------------------------
  # Edge cases: archived and locked intents
  # ---------------------------------------------------------------------------

  Scenario: Archived intent's drift records are still viewable read-only
    Given an intent has been archived
    When the User unarchives the intent and opens the "Drift assessments" view
    Then all historical classification records are visible
    And the view is read-only until the intent is unarchived
