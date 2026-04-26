// state/tool-defs.ts — MCP tool definitions for state-domain tools.
//
// Pure declaration of name + description + inputSchema for every
// haiku_* tool that reads or writes intent / stage / unit / feedback
// state. Handlers live separately in state-tools.ts (handleStateTool
// switch) — keeping the defs here means adding a new tool is one
// schema entry here + one case there, no further state-tools surface
// to grow.

// ── Tool definitions ───────────────────────────────────────────────────────

export const stateToolDefs = [
	// Intent tools
	{
		name: "haiku_intent_get",
		description: "Read a field from an intent's frontmatter",
		inputSchema: {
			type: "object" as const,
			properties: { slug: { type: "string" }, field: { type: "string" } },
			required: ["slug", "field"],
		},
	},
	{
		name: "haiku_intent_list",
		description: "List all intents in the workspace",
		inputSchema: {
			type: "object" as const,
			properties: {
				include_archived: {
					type: "boolean",
					description:
						"When true, include archived intents in the result and add an 'archived' field to each response object. Defaults to false.",
				},
			},
		},
	},
	// Stage tools
	{
		name: "haiku_stage_get",
		description: "Read a field from a stage's state",
		inputSchema: {
			type: "object" as const,
			properties: {
				intent: { type: "string" },
				stage: { type: "string" },
				field: { type: "string" },
			},
			required: ["intent", "stage", "field"],
		},
	},
	// Unit tools
	{
		name: "haiku_unit_get",
		description: "Read a field from a unit's frontmatter",
		inputSchema: {
			type: "object" as const,
			properties: {
				intent: { type: "string" },
				stage: { type: "string" },
				unit: { type: "string" },
				field: { type: "string" },
			},
			required: ["intent", "stage", "unit", "field"],
		},
	},
	{
		name: "haiku_unit_set",
		description: "Set a field in a unit's frontmatter",
		inputSchema: {
			type: "object" as const,
			properties: {
				intent: { type: "string" },
				stage: { type: "string" },
				unit: { type: "string" },
				field: { type: "string" },
				value: { type: "string" },
			},
			required: ["intent", "stage", "unit", "field", "value"],
		},
	},
	{
		name: "haiku_unit_list",
		description: "List all units in a stage with their status",
		inputSchema: {
			type: "object" as const,
			properties: { intent: { type: "string" }, stage: { type: "string" } },
			required: ["intent", "stage"],
		},
	},
	{
		name: "haiku_unit_start",
		description:
			"Mark a unit as started. The system resolves the stage and first hat internally.",
		inputSchema: {
			type: "object" as const,
			properties: { intent: { type: "string" }, unit: { type: "string" } },
			required: ["intent", "unit"],
		},
	},
	{
		name: "haiku_unit_advance_hat",
		description:
			"Advance a unit to the next hat in the sequence. When called on the last hat, auto-completes the unit and progresses the FSM. The system resolves the current hat, next hat, and stage internally.",
		inputSchema: {
			type: "object" as const,
			properties: { intent: { type: "string" }, unit: { type: "string" } },
			required: ["intent", "unit"],
		},
	},
	{
		name: "haiku_unit_reject_hat",
		description:
			"Reject the current hat's work — moves back to the previous hat and increments bolt. Pass `reason` so the unit's iteration history records why the hat was rejected (what failed, which criterion wasn't met).",
		inputSchema: {
			type: "object" as const,
			properties: {
				intent: { type: "string" },
				unit: { type: "string" },
				reason: {
					type: "string",
					description:
						"Short explanation of why the current hat's output was rejected (e.g. 'touch targets <44px on mobile', 'missing dark-mode tokens'). Recorded in the unit's iterations history.",
				},
			},
			required: ["intent", "unit"],
		},
	},
	{
		name: "haiku_unit_increment_bolt",
		description: "Increment a unit's bolt counter (new iteration cycle)",
		inputSchema: {
			type: "object" as const,
			properties: {
				intent: { type: "string" },
				stage: { type: "string" },
				unit: { type: "string" },
			},
			required: ["intent", "stage", "unit"],
		},
	},
	{
		name: "haiku_decision_record",
		description:
			"Record an elaboration decision in the stage's decision_log, OR declare 'no architectural decisions in scope' for the stage. Used in collaborative-mode stages to track meaningful human-AI knowledge-unification moments instead of counting interaction turns. Each entry is an architectural choice the user picked between options, OR a choice the agent made and surfaced for veto-style approval. Padding questions don't count.",
		inputSchema: {
			type: "object" as const,
			properties: {
				intent: { type: "string" },
				stage: {
					type: "string",
					description:
						"Stage name. Defaults to the intent's active_stage when omitted.",
				},
				no_decisions: {
					type: "boolean",
					description:
						"When true, declare that no architectural decisions are in scope for this stage. `rationale` (≥10 chars) is required. The agent should use this honestly when the work is purely conventional with no real choices to make.",
				},
				decision: {
					type: "string",
					description:
						"Short title of the decision being recorded (required unless no_decisions=true). Example: 'Authentication strategy'.",
				},
				options: {
					type: "array",
					items: { type: "string" },
					description:
						"≥2 concrete alternatives considered (required unless no_decisions=true). A 'decision' with only one option isn't a decision — it's just doing the work.",
				},
				choice: {
					type: "string",
					description:
						"The chosen option (required unless no_decisions=true). Should match one of the entries in `options`.",
				},
				source: {
					type: "string",
					enum: ["user", "autonomous-acknowledged"],
					description:
						"Who made the call. 'user' = the user picked between options the agent presented. 'autonomous-acknowledged' = the agent chose and surfaced the choice for veto-style approval (the user reviewed and didn't push back).",
				},
				rationale: {
					type: "string",
					description:
						"Optional for decisions (recommended for future-reader provenance); required when no_decisions=true.",
				},
			},
			required: ["intent"],
		},
	},
	// Knowledge tools
	{
		name: "haiku_knowledge_list",
		description: "List knowledge artifacts for an intent",
		inputSchema: {
			type: "object" as const,
			properties: { intent: { type: "string" } },
			required: ["intent"],
		},
	},
	{
		name: "haiku_knowledge_read",
		description: "Read a knowledge artifact",
		inputSchema: {
			type: "object" as const,
			properties: { intent: { type: "string" }, name: { type: "string" } },
			required: ["intent", "name"],
		},
	},
	// Studio tools
	{
		name: "haiku_studio_list",
		description:
			"List all available studios with their description, stages, and category. Project-level studios (.haiku/studios/) override built-in ones on name collision.",
		inputSchema: { type: "object" as const, properties: {} },
	},
	{
		name: "haiku_studio_get",
		description:
			"Read a studio's STUDIO.md — returns frontmatter fields and body text. Resolves project-level override first, then built-in.",
		inputSchema: {
			type: "object" as const,
			properties: { studio: { type: "string" } },
			required: ["studio"],
		},
	},
	{
		name: "haiku_studio_stage_get",
		description:
			"Read a stage's STAGE.md from a studio — returns frontmatter fields (hats, review, requires, produces) and body text. Resolves project-level override first, then built-in.",
		inputSchema: {
			type: "object" as const,
			properties: { studio: { type: "string" }, stage: { type: "string" } },
			required: ["studio", "stage"],
		},
	},
	// Settings tools
	{
		name: "haiku_settings_get",
		description:
			"Read a field from .haiku/settings.yml (e.g. studio, stack.compute, providers, workspace, default_announcements, review_agents, operations_runtime). Returns empty string if not set.",
		inputSchema: {
			type: "object" as const,
			properties: {
				field: {
					type: "string",
					description:
						"Dot-separated path (e.g. 'studio', 'stack.compute', 'review_agents')",
				},
			},
			required: ["field"],
		},
	},
	// Aggregate / report tools
	{
		name: "haiku_dashboard",
		description:
			"Returns a formatted dashboard of all intents showing status, studio, active stage, mode, and per-stage status tables.",
		inputSchema: { type: "object" as const, properties: {} },
	},
	{
		name: "haiku_capacity",
		description:
			"Returns a capacity report grouped by studio — completed/active counts and median bolt counts per stage.",
		inputSchema: {
			type: "object" as const,
			properties: {
				studio: {
					type: "string",
					description: "Optional: filter to a specific studio",
				},
			},
		},
	},
	{
		name: "haiku_reflect",
		description:
			"Returns detailed reflection data for an intent — per-stage summaries, unit completion counts, bolt counts, and analysis instructions.",
		inputSchema: {
			type: "object" as const,
			properties: { intent: { type: "string" } },
			required: ["intent"],
		},
	},
	{
		name: "haiku_review",
		description:
			"Runs a git diff against main/upstream and returns formatted pre-delivery code review instructions with diff, stats, review guidelines, and review-agent config.",
		inputSchema: {
			type: "object" as const,
			properties: {
				intent: {
					type: "string",
					description: "Optional: intent slug for context",
				},
			},
		},
	},
	{
		name: "haiku_review_open",
		description:
			'Open an ad-hoc review pane in the browser for the active intent and BLOCK until the reviewer clicks Done or Request Changes (or the pane times out at 30min). The UI swaps Approve for Done/Close, shows an "Ad-hoc review" badge, and never mutates FSM state on its own. Return value is a concrete next-step instruction: on Done the tool returns "no changes requested"; on Request Changes it returns a nudge to call haiku_run_next so the durable feedback routes through the normal fix-loop / revisit path.',
		inputSchema: {
			type: "object" as const,
			properties: {
				intent: {
					type: "string",
					description:
						"Optional intent slug. Defaults to the sole active intent (errors if ambiguous).",
				},
				stage: {
					type: "string",
					description:
						"Optional stage name to land the reviewer on. Defaults to the intent's active_stage.",
				},
			},
		},
	},
	{
		name: "haiku_backlog",
		description:
			"Manage the backlog: list items, add new items, review items interactively, or promote items to intents.",
		inputSchema: {
			type: "object" as const,
			properties: {
				action: {
					type: "string",
					description: "list | add | review | promote (default: list)",
				},
				description: {
					type: "string",
					description: "Description for the new backlog item (used with add)",
				},
			},
		},
	},
	{
		name: "haiku_seed",
		description:
			"Manage seeds (future ideas): list by status, plant a new seed, or check planted seeds for trigger conditions.",
		inputSchema: {
			type: "object" as const,
			properties: {
				action: {
					type: "string",
					description: "list | plant | check (default: list)",
				},
			},
		},
	},
	// Feedback tools
	{
		name: "haiku_feedback",
		description:
			"Create a feedback item for an intent. Writes a markdown file with frontmatter tracking status, origin, and author. Omit `stage` to log an intent-scope finding (used by the studio-level pre-intent-completion review layer).",
		inputSchema: {
			type: "object" as const,
			properties: {
				intent: { type: "string", description: "Intent slug" },
				stage: {
					type: "string",
					description:
						"Stage name. Omit (or pass empty) to log an intent-scope finding from the studio-level review layer.",
				},
				title: {
					type: "string",
					description: "Short title for the feedback item (max 120 chars)",
				},
				body: {
					type: "string",
					description: "Markdown body describing the finding",
				},
				origin: {
					type: "string",
					description:
						"Source: adversarial-review | studio-review | external-pr | external-mr | user-visual | user-chat | agent (default: agent)",
				},
				source_ref: {
					type: "string",
					description:
						"Optional reference — PR URL, review agent name, annotation ID",
				},
				author: {
					type: "string",
					description: "Who created it (default: agent)",
				},
				upstream_stage: {
					type: "string",
					description:
						"When the finding's root cause lives in a DIFFERENT stage than the one being reviewed, name it here. The FSM surfaces cross-stage findings to the human rather than routing them through the current stage's fix loop — the wrong hats cannot fix a different stage's artifacts.",
				},
			},
			required: ["intent", "title", "body"],
		},
	},
	{
		name: "haiku_feedback_update",
		description:
			"Update mutable fields on an existing feedback item. Agents cannot close human-authored feedback. Omit `stage` for intent-scope feedback.",
		inputSchema: {
			type: "object" as const,
			properties: {
				intent: { type: "string", description: "Intent slug" },
				stage: {
					type: "string",
					description: "Stage name. Omit for intent-scope feedback.",
				},
				feedback_id: {
					type: "string",
					description: "FB-NN identifier or numeric prefix",
				},
				status: {
					type: "string",
					description:
						"New status: pending | fixing | addressed | answered | closed | rejected",
				},
				closed_by: {
					type: "string",
					description:
						"Identifier of who/what closed the feedback. For stage feedback: the unit slug whose work the feedback-assessor validated. For fix-loop closures: `fix-loop:<FB-ID>:bolt-<N>`. For intent-scope closures: `intent-fix:<FB-ID>:bolt-<N>`.",
				},
				resolution: {
					type: "string",
					description:
						"Routing hint for the feedback resolver. One of: `question` (reply, no code delta), `inline_fix` (one fix_hats bolt against this finding), `stage_revisit` (re-loop the whole stage), `upstream_rewind` (surface to human; root cause is in an upstream stage). Pass `null` / empty to clear.",
				},
			},
			required: ["intent", "feedback_id"],
		},
	},
	{
		name: "haiku_feedback_delete",
		description:
			"Delete a feedback file. Cannot delete pending items. Agents cannot delete human-authored items. Omit `stage` for intent-scope feedback.",
		inputSchema: {
			type: "object" as const,
			properties: {
				intent: { type: "string", description: "Intent slug" },
				stage: {
					type: "string",
					description: "Stage name. Omit for intent-scope feedback.",
				},
				feedback_id: {
					type: "string",
					description: "FB-NN identifier or numeric prefix",
				},
			},
			required: ["intent", "feedback_id"],
		},
	},
	{
		name: "haiku_feedback_reject",
		description:
			"Reject an agent-authored feedback item with a reason. Sets status to rejected and appends rejection reason to body. Omit `stage` for intent-scope feedback.",
		inputSchema: {
			type: "object" as const,
			properties: {
				intent: { type: "string", description: "Intent slug" },
				stage: {
					type: "string",
					description: "Stage name. Omit for intent-scope feedback.",
				},
				feedback_id: {
					type: "string",
					description: "FB-NN identifier or numeric prefix",
				},
				reason: {
					type: "string",
					description: "Explanation for why this feedback is being rejected",
				},
			},
			required: ["intent", "feedback_id", "reason"],
		},
	},
	{
		name: "haiku_feedback_list",
		description:
			"List feedback items with optional filtering. Omit stage to list across all stages.",
		inputSchema: {
			type: "object" as const,
			properties: {
				intent: { type: "string", description: "Intent slug" },
				stage: {
					type: "string",
					description: "Stage name (optional — omit to list all stages)",
				},
				status: {
					type: "string",
					description:
						"Filter by status: pending | addressed | closed | rejected",
				},
			},
			required: ["intent"],
		},
	},
	{
		name: "haiku_release_notes",
		description:
			"Extract release notes from CHANGELOG.md — a specific version or the 5 most recent entries.",
		inputSchema: {
			type: "object" as const,
			properties: {
				version: {
					type: "string",
					description: "Optional: specific version to extract (e.g. '1.2.0')",
				},
			},
		},
	},
	{
		name: "haiku_repair",
		description:
			"Scan intents for metadata issues and auto-apply safe fixes. In a git repo, scans all intent branches sequentially, auto-applies safe fixes, syncs changes, and opens PRs/MRs for already-merged branches. In filesystem mode, scans intents in the current working directory. Pass `intent` to repair a single intent only. Pass `skip_branches: true` to force cwd-only mode in a git repo. Pass `apply: false` to scan without applying fixes.",
		inputSchema: {
			type: "object" as const,
			properties: {
				intent: {
					type: "string",
					description:
						"Specific intent slug to scan in the current working directory (skips multi-branch mode)",
				},
				apply: {
					type: "boolean",
					description: "Auto-apply safe mechanical fixes (default: true)",
				},
				skip_branches: {
					type: "boolean",
					description:
						"Force cwd-only mode even when in a git repo (default: false)",
				},
			},
		},
	},
	{
		name: "haiku_version_info",
		description:
			"Return the running MCP binary version and plugin version. " +
			"MCP version is baked into the binary at build time; plugin version is read from plugin.json at runtime.",
		inputSchema: { type: "object" as const, properties: {} },
	},
]
