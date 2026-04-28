Feature: Agent writes a file on behalf of a human via a sanctioned tool
  As a User in chat with the agent
  I want to ask "hey claude, write this file for me" and have the result tracked as a human-attributed write
  So that my hand-instructed contribution is detected as out-of-band rather than silently regenerated later

  Background:
    Given an active intent "demo-intent" in stage "inception" at phase "elaborate"
    And the User is interacting with the agent in chat
    And per-stage SHA baselines have been established
    And a sanctioned MCP tool exists for human-attributed agent writes (working name: haiku_human_write)

  # ---------------------------------------------------------------------------
  # Happy Path: explicit user instruction
  # ---------------------------------------------------------------------------

  Scenario: User instructs the agent to save a file as human-attributed
    Given the User says "save this Tailwind config to knowledge/design-references/tailwind.config.js"
    When the agent invokes the sanctioned human-write MCP tool with:
      | path     | knowledge/design-references/tailwind.config.js |
      | content  | <provided config>                                |
      | source   | user-chat-instruction                            |
    Then the file is written to the worktree at the requested path
    And the write is attributed to author_type "human"
    And the SHA baseline is NOT updated by this write
    And on the next agent tick, the pre-tick out-of-band gate detects the file as added or changed
    And the workflow emits a "manual_change_assessment" action

  Scenario: User asks the agent to extend a file the User just edited
    Given the User edited "stages/design/outputs/spec.md" outside chat
    And the User says "extend the section I just added with the missing edge cases"
    When the agent calls haiku_run_next
    Then the pre-tick out-of-band gate detects the User's earlier edit
    And the workflow emits "manual_change_assessment"
    And the agent classifies the edit as "inline-fix" (extend in current bolt)
    When the agent completes the requested extension via a normal agent write
    Then the agent's extension is attributed to author_type "agent"
    And the User's prior edit is preserved (not overwritten)
    And the new combined SHA becomes the next baseline

  # ---------------------------------------------------------------------------
  # Authorship integrity
  # ---------------------------------------------------------------------------

  Scenario: Agent uses normal Write tool for its own work
    When the agent writes a unit-output file as part of its execute phase
    Then the agent uses the normal Write tool (not the sanctioned human-write tool)
    And the write is attributed to author_type "agent"
    And the SHA baseline IS updated by this write
    And no "manual_change_assessment" action fires for this file on the next tick

  Scenario: Agent attempts to use the human-write tool without explicit user instruction
    Given the User has not explicitly asked the agent to write a file on their behalf
    When the agent invokes the sanctioned human-write MCP tool
    Then the tool requires a non-empty "user_instruction_quote" argument
    And if the argument is missing the tool returns an error "Missing user instruction context"
    And no file is written

  Scenario: Audit record is created for every human-attributed agent write
    When the agent invokes the sanctioned human-write tool successfully
    Then an audit log entry is appended at intent scope
    And the entry records the path, the user_instruction_quote, the timestamp, and the agent identifier
    And the audit log is human-readable in the SPA's drift assessment view

  # ---------------------------------------------------------------------------
  # Error scenarios
  # ---------------------------------------------------------------------------

  Scenario: Sanctioned tool refuses to write to a workflow-managed path
    When the agent invokes the human-write tool with path "stages/design/state.json"
    Then the tool returns an error "Cannot write workflow-managed file via human-write path"
    And the error message names the correct MCP tool to use
    And no file is written

  Scenario: Sanctioned tool refuses to write outside the intent's tracked surface
    When the agent invokes the human-write tool with path "../../../etc/passwd"
    Then the tool returns an error "Path is outside the intent's tracked surface"
    And no file is written

  Scenario: Sanctioned tool refuses zero-byte content
    When the agent invokes the human-write tool with empty content
    Then the tool returns an error "Empty content is not permitted"
    And no file is written

  # ---------------------------------------------------------------------------
  # Edge cases: mode interactions
  # ---------------------------------------------------------------------------

  Scenario: Human-write tool is available in interactive mode
    Given the intent is running in mode "interactive"
    When the User says "save this file" and the agent invokes the human-write tool
    Then the write succeeds with author_type "human"

  Scenario: Human-write tool requires confirmation in autopilot mode
    Given the intent is running in mode "autopilot"
    And the operator has chosen the "explicit confirmation" integrity stance
    When the agent invokes the human-write tool
    Then the tool prompts the human via ask_user_visual_question for confirmation
    And the write completes only after a positive confirmation
    And if confirmation is declined the tool returns "Human write declined"
