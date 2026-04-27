// orchestrator/prompts/WORKFLOW_CONTRACTS_FIX_LOOP_BLOCK.ts — Static
// prompt body. Injected verbatim into review_fix and
// intent_completion_fix dispatch prompts.

export const WORKFLOW_CONTRACTS_FIX_LOOP_BLOCK = [
	"### Workflow Contracts (REQUIRED — reminder during fix loop)",
	"",
	"> ## ⟁ NO FIX WITHOUT INVESTIGATION.",
	"> Read the artifact, verify the finding, state the gap *before* editing. Bolts spent on guesses don't come back.",
	"",
	"- The fix loop runs the stage's `fix_hats:` sequence against every eligible pending finding in parallel. Each finding's hat chain is serial (e.g. designer → feedback-assessor); chains run in parallel across findings. The feedback file IS the scope — do NOT synthesize a new unit spec.",
	'- Every hat in the sequence reads the feedback body + the flagged artifact path and acts within its mandate. The sequence typically ends with a `feedback-assessor` hat that independently verifies the fix and, if satisfied, calls `haiku_feedback_update { status: "closed", closed_by: "fix-loop:<bolt-id>" }`.',
	"- If the feedback-assessor is NOT satisfied, it leaves the feedback open (no `closed_by`, no status change). The workflow engine increments the bolt counter and may dispatch another loop, up to 3 bolts per finding. Exceeding 3 escalates to the human.",
	"- A fix-loop hat is NOT a unit hat. Do NOT call `haiku_unit_advance_hat` or `haiku_unit_reject_hat` — those are for unit execution. The fix-loop is orchestrated by the parent; each fix hat completes its work and returns, and the parent calls `haiku_run_next` after every wave completes to advance.",
	"- Parallel chains may edit the same artifact concurrently. Each final hat validates closure independently — a chain whose fix was clobbered by another chain will leave its finding open, and the next bolt will retry. Budget is spent, not lost.",
	"",
	"#### Per-hat action rules live in the subagent prompts",
	"",
	"This contract covers dispatch coordination, the bolt cap, and the per-finding scoping rule. The action-rules each fix-mode hat follows during its own work — investigate root cause before editing, verify the finding against the artifact before fixing (and `haiku_feedback_reject` if the finding is stale or invalid), no hedging in summaries, no out-of-scope edits — live as numbered steps in the per-hat subagent prompts emitted below. Every fix-mode hat reads its own rules; this block exists so the dispatching agent understands the contract its subagents will follow.",
].join("\n")
