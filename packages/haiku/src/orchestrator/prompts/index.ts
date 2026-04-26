// orchestrator/prompts/index.ts — Registry of per-action prompt
// builders.
//
// Each per-action file under this directory exports a
// `PromptBuilder` as its default export. The registry collects them
// into `actionPromptBuilders` (Map<actionName, PromptBuilder>) so
// buildRunInstructions can dispatch by name with a single lookup
// instead of a giant switch statement.
//
// The remaining (not-yet-extracted) action cases continue to live in
// orchestrator.ts's switch — buildRunInstructions checks the
// registry first, falls back to the switch for unmigrated actions.
// As more actions migrate, the switch shrinks toward zero.

import advance_phase from "./advance_phase.js"
import advance_stage from "./advance_stage.js"
import awaiting_external_review from "./awaiting_external_review.js"
import blocked from "./blocked.js"
import changes_requested from "./changes_requested.js"
import complete from "./complete.js"
import composite_run_stage from "./composite_run_stage.js"
import dag_cycle_detected from "./dag_cycle_detected.js"
import design_direction_required from "./design_direction_required.js"
import discovery_missing from "./discovery_missing.js"
import elaboration_insufficient from "./elaboration_insufficient.js"
import error from "./error.js"
import escalate from "./escalate.js"
import external_review_requested from "./external_review_requested.js"
import feedback_revisit from "./feedback_revisit.js"
import fix_quality_gates from "./fix_quality_gates.js"
import gate_blocked from "./gate_blocked.js"
import gate_review from "./gate_review.js"
import inputs_missing from "./inputs_missing.js"
import integrate_fix_chains from "./integrate_fix_chains.js"
import intent_approved from "./intent_approved.js"
import intent_complete from "./intent_complete.js"
import intent_completion_fix from "./intent_completion_fix.js"
import intent_completion_review from "./intent_completion_review.js"
import outputs_missing from "./outputs_missing.js"
import pre_review from "./pre_review.js"
import pre_review_revisit from "./pre_review_revisit.js"
import review from "./review.js"
import review_elaboration from "./review_elaboration.js"
import review_fix from "./review_fix.js"
import safe_intent_repair from "./safe_intent_repair.js"
import select_studio from "./select_studio.js"
import spec_validation_failed from "./spec_validation_failed.js"
import type { PromptBuilder } from "./types.js"
import unit_inputs_missing from "./unit_inputs_missing.js"
import unit_naming_invalid from "./unit_naming_invalid.js"
import unresolved_dependencies from "./unresolved_dependencies.js"
import upstream_finding_surfaced from "./upstream_finding_surfaced.js"

export const actionPromptBuilders: ReadonlyMap<string, PromptBuilder> = new Map<
	string,
	PromptBuilder
>([
	["advance_phase", advance_phase],
	["advance_stage", advance_stage],
	["awaiting_external_review", awaiting_external_review],
	["blocked", blocked],
	["changes_requested", changes_requested],
	["complete", complete],
	["composite_run_stage", composite_run_stage],
	["dag_cycle_detected", dag_cycle_detected],
	["design_direction_required", design_direction_required],
	["discovery_missing", discovery_missing],
	["elaboration_insufficient", elaboration_insufficient],
	["error", error],
	["escalate", escalate],
	["external_review_requested", external_review_requested],
	["feedback_revisit", feedback_revisit],
	["fix_quality_gates", fix_quality_gates],
	["gate_blocked", gate_blocked],
	["gate_review", gate_review],
	["inputs_missing", inputs_missing],
	["integrate_fix_chains", integrate_fix_chains],
	["intent_approved", intent_approved],
	["intent_complete", intent_complete],
	["intent_completion_fix", intent_completion_fix],
	["intent_completion_review", intent_completion_review],
	["outputs_missing", outputs_missing],
	["pre_review", pre_review],
	["pre_review_revisit", pre_review_revisit],
	["review", review],
	["review_elaboration", review_elaboration],
	["review_fix", review_fix],
	["safe_intent_repair", safe_intent_repair],
	["select_studio", select_studio],
	["spec_validation_failed", spec_validation_failed],
	["unit_inputs_missing", unit_inputs_missing],
	["unit_naming_invalid", unit_naming_invalid],
	["unresolved_dependencies", unresolved_dependencies],
	["upstream_finding_surfaced", upstream_finding_surfaced],
])
