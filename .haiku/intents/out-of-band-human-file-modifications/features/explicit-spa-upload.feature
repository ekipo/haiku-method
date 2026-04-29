Feature: Explicit SPA upload of out-of-band human files
  As a Designer, Product Owner, or Reviewer using the browse/review SPA
  I want to attach or replace files for an active intent through a deliberate UI affordance
  So that my contribution is registered against a stage without using the filesystem or chat

  Background:
    Given an active intent "demo-intent" is loaded in the browse SPA
    And the SPA is connected to the H·AI·K·U review server for that intent
    And the intent has stage "design" as the active stage
    And the agent is not currently mid-bolt
    And the User is signed in as a human reviewer

  # ---------------------------------------------------------------------------
  # Happy Path: stage output replacement upload
  # ---------------------------------------------------------------------------

  Scenario: Designer replaces a stage output file via the SPA upload UI
    Given the SPA is showing the "Outputs" section of stage "design"
    And the existing output "dashboard-layout.html" is listed
    When the Designer chooses "Replace" on "dashboard-layout.html"
    And the Designer selects a new local file "dashboard-v2.html"
    And the Designer confirms the replacement
    Then the SPA writes the new content to "stages/design/outputs/dashboard-layout.html" in the active worktree
    And the SPA does NOT call any agent-write MCP tool
    And the existing PreToolUse workflow-managed-file hook does not fire for this write
    And the upload is treated as out-of-band by definition
    And on the next agent tick, the pre-tick out-of-band gate detects the SHA change

  Scenario: Product Owner attaches a new knowledge file via the SPA
    Given the SPA is showing the "Knowledge" section for the intent
    And no file named "competitive-analysis.pdf" exists in "knowledge/"
    When the Product Owner chooses "Upload" in the Knowledge section
    And selects "competitive-analysis.pdf" from the local filesystem
    And confirms the upload
    Then the SPA writes "knowledge/competitive-analysis.pdf" into the worktree
    And the file is attributed to author "human" via post-write metadata
    And on the next agent tick, the pre-tick out-of-band gate detects the file as added

  # ---------------------------------------------------------------------------
  # Edge cases: stage availability and target selection
  # ---------------------------------------------------------------------------

  Scenario Outline: Upload availability per stage
    Given the SPA is showing stage "<stage>"
    When the User opens the upload affordance
    Then the SPA shows the "<surface>" target as available
    And the User can complete an upload to that surface

    Examples:
      | stage       | surface    |
      | inception   | knowledge  |
      | design      | outputs    |
      | development | knowledge  |
      | review      | knowledge  |

  Scenario: Upload affordance is hidden for a stage with no defined target surface
    Given the SPA is showing stage "delivery"
    And stage "delivery" has no configured upload target
    When the User opens the upload menu
    Then no "Upload" or "Replace" affordance is shown
    And a help message reads "This stage does not accept human file uploads"

  Scenario: Replace is available only for files written by the agent
    Given the SPA is showing the "Outputs" section of stage "design"
    And "dashboard-layout.html" was last written by the agent
    And "human-attached-screenshot.png" was last written by a previous human upload
    Then the "Replace" action is enabled on "dashboard-layout.html"
    And the "Replace" action is enabled on "human-attached-screenshot.png"
    And the "Delete" action is disabled on agent-written files
    And the "Delete" action is enabled on human-attached files

  # ---------------------------------------------------------------------------
  # Error scenarios
  # ---------------------------------------------------------------------------

  Scenario: Upload to a non-existent intent
    Given the User has the SPA open for an intent that has been archived since session start
    When the User attempts to upload a file
    Then the SPA returns an error "Intent is archived; uploads are disabled"
    And no file is written to disk

  Scenario: Upload fails because the worktree path is read-only
    Given the active worktree is on a read-only filesystem
    When the User confirms an upload
    Then the SPA returns an error "Unable to write to worktree (read-only)"
    And the SPA suggests checking out an editable worktree
    And no partial file is left on disk

  Scenario: Upload exceeds the configured size limit
    Given the configured upload size limit is 50 MB
    When the User selects a file of size 120 MB
    Then the SPA refuses the upload before any bytes are written
    And the SPA shows the message "File exceeds 50 MB limit"
    And no temporary file is created in the worktree

  Scenario: Upload is attempted while the worktree is locked
    Given the active worktree is currently locked by another process
    When the User confirms an upload
    Then the SPA waits up to 5 seconds for the lock to release
    And if the lock does not release the SPA shows "Worktree is busy; try again"
    And no partial file is left on disk

  # ---------------------------------------------------------------------------
  # Visibility: the human sees the result
  # ---------------------------------------------------------------------------

  Scenario: Uploaded file appears in the SPA before the next tick
    Given the SPA is showing the "Outputs" section of stage "design"
    When the Designer completes a Replace upload of "dashboard-layout.html"
    Then the SPA immediately reflects the new file's metadata (size, modified-at)
    And a "Pending agent assessment" badge is shown next to the file
    And the badge persists until the next "manual_change_assessment" classification completes
