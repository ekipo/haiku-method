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
import changes_requested from "./changes_requested.js"
import complete from "./complete.js"
import dag_cycle_detected from "./dag_cycle_detected.js"
import design_direction_required from "./design_direction_required.js"
import discovery_missing from "./discovery_missing.js"
import elaboration_insufficient from "./elaboration_insufficient.js"
import error from "./error.js"
import external_review_requested from "./external_review_requested.js"
import fix_quality_gates from "./fix_quality_gates.js"
import gate_blocked from "./gate_blocked.js"
import inputs_missing from "./inputs_missing.js"
import intent_approved from "./intent_approved.js"
import outputs_missing from "./outputs_missing.js"
import safe_intent_repair from "./safe_intent_repair.js"
import select_studio from "./select_studio.js"
import spec_validation_failed from "./spec_validation_failed.js"
import type { PromptBuilder } from "./types.js"
import unit_inputs_missing from "./unit_inputs_missing.js"
import unit_naming_invalid from "./unit_naming_invalid.js"
import unresolved_dependencies from "./unresolved_dependencies.js"

export const actionPromptBuilders: ReadonlyMap<string, PromptBuilder> = new Map<
	string,
	PromptBuilder
>([
	["advance_phase", advance_phase],
	["changes_requested", changes_requested],
	["complete", complete],
	["dag_cycle_detected", dag_cycle_detected],
	["design_direction_required", design_direction_required],
	["discovery_missing", discovery_missing],
	["elaboration_insufficient", elaboration_insufficient],
	["error", error],
	["external_review_requested", external_review_requested],
	["fix_quality_gates", fix_quality_gates],
	["gate_blocked", gate_blocked],
	["inputs_missing", inputs_missing],
	["intent_approved", intent_approved],
	["outputs_missing", outputs_missing],
	["safe_intent_repair", safe_intent_repair],
	["select_studio", select_studio],
	["spec_validation_failed", spec_validation_failed],
	["unit_inputs_missing", unit_inputs_missing],
	["unit_naming_invalid", unit_naming_invalid],
	["unresolved_dependencies", unresolved_dependencies],
])
