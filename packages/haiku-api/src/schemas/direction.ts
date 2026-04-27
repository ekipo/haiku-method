/**
 * Design-direction select endpoint — POST /direction/:sessionId/select
 *
 * Two submission modes:
 *   - `select`     — user picked one archetype as the final direction.
 *                   Carries archetype + optional comments + optional
 *                   visual annotations (pins on the rendered preview).
 *   - `regenerate` — user wants the agent to produce more variants.
 *                   Carries `keep[]` (archetype names to preserve) and
 *                   optional comments steering the next generation. The
 *                   agent re-runs `pick_design_direction` after producing
 *                   replacements for the unkept slots.
 *
 * `parameters` is intentionally absent — the legacy slider-tuning model
 * collapsed under the "ask for more variants" flow.
 */

import { z } from "zod"
import { PinSchema } from "./common.js"

/** Annotation bundle attached to a direction selection — pin-style
 *  visual feedback on the chosen archetype's preview. Mirrors the
 *  review-side `ReviewAnnotations` shape minus the screenshot field
 *  (preview iframes can't be canvas-captured client-side without a
 *  third-party html2canvas dep). */
export const DirectionAnnotationsSchema = z
	.object({
		pins: z.array(PinSchema).optional(),
	})
	.describe("Annotations attached to a design-direction selection")
export type DirectionAnnotations = z.infer<typeof DirectionAnnotationsSchema>

const DirectionSelectModeSchema = z
	.object({
		mode: z.literal("select"),
		archetype: z
			.string()
			.max(64)
			.describe(
				"Archetype name selected by the user from the design-direction set",
			),
		comments: z
			.string()
			.max(10_000)
			.optional()
			.describe("Optional free-text comments accompanying the selection"),
		annotations: DirectionAnnotationsSchema.optional(),
	})
	.describe("Final selection — user picked one archetype")

const DirectionRegenerateModeSchema = z
	.object({
		mode: z.literal("regenerate"),
		keep: z
			.array(z.string().max(64))
			.max(50)
			.describe(
				"Archetype names the user wants preserved; the agent should produce fresh variants for the remaining slots",
			),
		comments: z
			.string()
			.max(10_000)
			.optional()
			.describe(
				"Optional steering notes for the next generation — what to change, what to lean into",
			),
	})
	.describe("Regenerate request — user wants more / different variants")

export const DirectionSelectRequestSchema = z
	.discriminatedUnion("mode", [
		DirectionSelectModeSchema,
		DirectionRegenerateModeSchema,
	])
	.describe("POST /direction/:sessionId/select request body")
export type DirectionSelectRequest = z.infer<typeof DirectionSelectRequestSchema>

export const DirectionSelectResponseSchema = z
	.object({
		ok: z.literal(true),
	})
	.describe("POST /direction/:sessionId/select response body")
export type DirectionSelectResponse = z.infer<
	typeof DirectionSelectResponseSchema
>
