// orchestrator/workflow/handlers/manual-change-assessment.ts — Build and emit
// the `manual_change_assessment` action payload (unit-05).
//
// This module exposes two things:
//
//   1. `buildManualChangeAssessmentAction(ctx, findings)` — the builder
//      called by `runWorkflowTick` when the drift gate returns findings.
//      It constructs the fully-typed action payload the agent receives as
//      its `tool_use_result`, including:
//        - stable per-dispatch DRF-NN finding IDs
//        - legal_outcomes map (filtered per AC-CO1 + DATA-CONTRACTS.md §3.4)
//        - tick_id carrying (intent_slug, tickCounter, ISO timestamp)
//        - instructions prose naming `haiku_classify_drift` and the four outcomes
//
//   2. A default WorkflowHandler (`emit`) — registered in handlers/index.ts for
//      completeness. In practice, `manual_change_assessment` is emitted directly
//      by runWorkflowTick before reaching normal dispatch, so this handler is
//      never reached under normal operation.
//
// Spec references:
//   unit-05-manual-change-assessment-handler.md
//   DATA-CONTRACTS.md §3.1, §3.2, §3.4
//   ACCEPTANCE-CRITERIA.md AC-CO1, AC-EO1, AC-EE5

import type { OrchestratorAction } from "../../../orchestrator.js"
import type { DerivedContext } from "../derive-state.js"
import type { DriftFinding } from "../drift-detection-gate.js"
import type { WorkflowHandler } from "./_types.js"

// ── Types ──────────────────────────────────────────────────────────────────

/** The four legal classification outcomes, as named in DATA-CONTRACTS.md §3.3. */
export type ClassificationOutcome =
	| "ignore"
	| "inline-fix"
	| "surface-as-feedback"
	| "trigger-revisit"

/** The `manual_change_assessment` action payload shape (DATA-CONTRACTS.md §3.2). */
export interface ManualChangeAssessmentAction extends OrchestratorAction {
	action: "manual_change_assessment"
	/** Intent slug (mirrors `intent_slug` naming in DATA-CONTRACTS.md §3.2). */
	intent_slug: string
	/** Active stage at tick time. */
	stage: string
	/**
	 * Tick identifier carrying (intent_slug, tick_counter, ISO timestamp).
	 * Used by `haiku_classify_drift` to reject stale tick IDs.
	 */
	tick_id: string
	/** The drift findings the agent must classify in this dispatch (>= 1). */
	findings: DriftFinding[]
	/** Current invocation mode from intent frontmatter. */
	mode: string
	/** Agent-facing instructions string, built by the orchestrator. */
	instructions: string
	/**
	 * Map from finding path → array of legal classification outcomes for that
	 * finding. Pre-filtered using the legality matrix in DATA-CONTRACTS.md §3.4
	 * and AC-CO1 (current-stage findings exclude `trigger-revisit`).
	 */
	legal_outcomes: Record<string, ClassificationOutcome[]>
}

/** Type guard: returns true when `action` is a `ManualChangeAssessmentAction`. */
export function isManualChangeAssessment(
	action: OrchestratorAction,
): action is ManualChangeAssessmentAction {
	return action.action === "manual_change_assessment"
}

// ── Legal-outcomes helpers ─────────────────────────────────────────────────

const ALL_OUTCOMES: ClassificationOutcome[] = [
	"ignore",
	"inline-fix",
	"surface-as-feedback",
	"trigger-revisit",
]

/**
 * Compute the legal outcomes for a single finding.
 *
 * Rules (DATA-CONTRACTS.md §3.4 + AC-CO1):
 *   - `file-removed` findings exclude `inline-fix` (nothing on disk to fix inline).
 *   - Current-stage findings (stage_owner === activeStage) exclude `trigger-revisit`
 *     (revisit-of-self is a no-op per AC-CO1).
 *   - All other combinations are legal.
 */
function legalOutcomesFor(
	finding: DriftFinding,
	activeStage: string,
): ClassificationOutcome[] {
	const stageOwner = finding.stage ?? activeStage

	return ALL_OUTCOMES.filter((outcome) => {
		// Exclude inline-fix for file-removed (DATA-CONTRACTS.md §3.4).
		if (outcome === "inline-fix" && finding.change_kind === "file-removed") {
			return false
		}
		// Exclude trigger-revisit for current-stage findings (AC-CO1).
		if (outcome === "trigger-revisit" && stageOwner === activeStage) {
			return false
		}
		return true
	})
}

// ── Tick ID builder ────────────────────────────────────────────────────────

/**
 * Build a tick_id that carries (intent_slug, tickCounter, ISO timestamp).
 * The classify tool rejects stale tick IDs, so the timestamp provides
 * freshness and the counter provides uniqueness per dispatch (AC-EE5).
 */
function buildTickId(intentSlug: string, tickCounter: number): string {
	const iso = new Date().toISOString().replace(/[:.]/g, "-")
	return `tick-${intentSlug}-${tickCounter}-${iso}`
}

// ── Instructions builder ───────────────────────────────────────────────────

/** Build the agent-facing instructions string for a `manual_change_assessment`
 *  dispatch. Tells the agent to call `haiku_classify_drift`, lists the four
 *  outcomes, names each finding's allowed outcomes, and reminds the agent to
 *  populate `agent_rationale` and per-finding `rationale_excerpt` (AC-EE5). */
function buildInstructions(
	intentSlug: string,
	findings: DriftFinding[],
	legalOutcomes: Record<string, ClassificationOutcome[]>,
): string {
	const lines: string[] = [
		`## Out-of-band Human File Modification — Classification Required`,
		``,
		`The drift-detection gate found **${findings.length} change${findings.length !== 1 ? "s" : ""}** ` +
			`in the tracked surface. You must classify every finding before the ` +
			`normal stage handler runs.`,
		``,
		`### Call \`haiku_classify_drift\` to submit your classifications`,
		``,
		`\`haiku_classify_drift\` accepts:`,
		`- \`intent_slug\`: "${intentSlug}"`,
		`- \`tick_id\`: (provided in this action payload — copy it verbatim)`,
		`- \`agent_rationale\`: your overall prose explanation (≥ 1 non-whitespace character — **required**)`,
		`- \`classifications[]\`: one entry per finding`,
		``,
		`**The four valid classification outcomes:**`,
		``,
		`  A. \`ignore\`          — change observed, no further action; baseline updates immediately.`,
		`  B. \`inline-fix\`      — human edit is intentional; agent absorbs it in the current bolt; baseline updates immediately.`,
		`  C. \`surface-as-feedback\` — change warrants formal review; a feedback item is created; baseline does NOT update until feedback closes/rejects.`,
		`  D. \`trigger-revisit\` — change invalidates prior stage work; a stage revisit is dispatched; baseline does NOT update until revisit completes.`,
		``,
		`**Per-finding \`rationale_excerpt\` is required for every non-\`ignore\` outcome** (AC-EE5). ` +
			`An empty \`rationale_excerpt\` on a non-\`ignore\` classification will be rejected.`,
		``,
		`### Findings and their allowed outcomes`,
		``,
	]

	for (let i = 0; i < findings.length; i++) {
		const finding = findings[i]
		const findingId = `DRF-${String(i + 1).padStart(2, "0")}`
		const allowed = legalOutcomes[finding.path] ?? ALL_OUTCOMES
		lines.push(
			`**${findingId}** \`${finding.path}\` (${finding.change_kind}): ` +
				`allowed outcomes: ${allowed.map((o) => `\`${o}\``).join(", ")}`,
		)
	}

	lines.push(``)
	lines.push(
		`Submit a \`rationale_excerpt\` per classification (≥ 1 char for non-ignore).`,
	)

	return lines.join("\n")
}

// ── Public builder ─────────────────────────────────────────────────────────

/**
 * Build the `manual_change_assessment` action payload for a tick where the
 * drift gate emitted findings.
 *
 * Called by `runWorkflowTick` when `driftResult.action === 'manual_change_assessment'`.
 *
 * @param ctx - Derived context from `deriveCurrentState`.
 * @param findings - Non-empty array of drift findings from the gate.
 * @returns A fully-typed `ManualChangeAssessmentAction` ready for the agent.
 */
export function buildManualChangeAssessmentAction(
	ctx: DerivedContext,
	findings: DriftFinding[],
): ManualChangeAssessmentAction {
	const { slug, intent, currentStage, stageState } = ctx

	// Assign stable per-dispatch DRF-NN IDs (zero-padded, 1-indexed).
	// The IDs are ephemeral — they exist only for the duration of the
	// classification step and are carried into the assessment record for
	// correlation (DATA-CONTRACTS.md §4.2).
	const findingsWithIds = findings.map((f, i) => ({
		...f,
		finding_id: `DRF-${String(i + 1).padStart(2, "0")}`,
	}))

	// Build legal_outcomes per finding (DATA-CONTRACTS.md §3.2 + AC-CO1 + §3.4).
	const legalOutcomes: Record<string, ClassificationOutcome[]> = {}
	for (const finding of findingsWithIds) {
		legalOutcomes[finding.path] = legalOutcomesFor(finding, currentStage)
	}

	// Tick counter from stage state (or 0 when unavailable).
	const tickCounter =
		typeof stageState.iteration === "number"
			? (stageState.iteration as number)
			: 0

	const tickId = buildTickId(slug, tickCounter)

	const mode = (intent.mode as string) || "interactive"

	const instructions = buildInstructions(slug, findingsWithIds, legalOutcomes)

	return {
		action: "manual_change_assessment",
		intent_slug: slug,
		stage: currentStage,
		tick_id: tickId,
		findings: findingsWithIds,
		mode,
		instructions,
		legal_outcomes: legalOutcomes,
	}
}

// ── Default handler (registration shim) ───────────────────────────────────

/** Registered in REGISTRY in handlers/index.ts for completeness.
 *
 *  `manual_change_assessment` is emitted directly by `runWorkflowTick` when
 *  the drift gate fires — before normal per-state dispatch. This handler is
 *  never reached under normal operation. If it IS reached, it means the gate
 *  wiring in run-tick.ts is broken. */
const emit: WorkflowHandler = (_ctx) => {
	return {
		action: "error",
		message:
			"manual_change_assessment handler reached via normal dispatch — this state should only " +
			"be emitted directly by the drift-detection gate in runWorkflowTick. " +
			"Check run-tick.ts drift gate wiring.",
	}
}

export default emit
