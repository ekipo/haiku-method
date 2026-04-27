/** biome-ignore-all lint/a11y/noNoninteractiveElementToInteractiveRole: archetype card container is a <fieldset role="radiogroup"> per WAI-ARIA radiogroup pattern */
/** biome-ignore-all lint/a11y/noStaticElementInteractions: preview-dialog backdrop click-to-close is a standard modal affordance alongside the close button and Escape handler */
/** biome-ignore-all lint/a11y/useKeyWithClickEvents: keyboard dismissal is handled at document level via the Escape handler in the parent component; the pin-drop overlay's pin placement is keyboard-reachable via the Tab-able pin buttons */
/**
 * DirectionPage — canonical implementation for /direction/:sessionId.
 *
 * Two submission modes:
 *   - `select`     — user picks one archetype as the final direction.
 *                   May add comments + visual pins on the chosen preview.
 *   - `regenerate` — user wants more / different variants. Marks archetypes
 *                   to keep; agent produces fresh variants for the rest.
 *
 * Parameter sliders were removed (the legacy tuning model collapsed under
 * the "ask for more variants" flow — iterate on the archetype set instead
 * of tweaking knobs on a single one).
 */

import { type DesignArchetypeData, paths } from "haiku-api"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
	focusRingClass,
	touchTargetClass,
	useAnnounce,
	useFocusTrap,
} from "../../a11y"
import { useApiClient } from "../../api/context"
import { Card, SectionHeading } from "../../atoms/Card"
import { tryCloseTab } from "../../lib/tryCloseTab"
import { SubmitSuccess } from "../../molecules/SubmitSuccess"

interface Props {
	session: { archetypes?: DesignArchetypeData[]; title?: string }
	sessionId: string
	wsRef?: React.RefObject<WebSocket | null>
}

interface PinInput {
	x: number // percentage 0-100
	y: number // percentage 0-100
	text: string
}

type Mode = "select" | "regenerate"

export function DirectionPage({
	session,
	sessionId,
	wsRef: _wsRef,
}: Props): React.ReactElement {
	const client = useApiClient()
	const announce = useAnnounce()

	const archetypes = useMemo(
		() => session.archetypes ?? [],
		[session.archetypes],
	)

	const [mode, setMode] = useState<Mode>("select")
	const [selectedArchetype, setSelectedArchetype] = useState<string>(
		archetypes[0]?.name ?? "",
	)
	const [keptArchetypes, setKeptArchetypes] = useState<Set<string>>(
		() => new Set(),
	)
	const [comment, setComment] = useState("")
	const [pins, setPins] = useState<PinInput[]>([])
	// Pin overlay is opt-in — keeps the default render footprint small,
	// which matters for test isolation (the FB-69 focus-trap suite is
	// sensitive to extra mounted DOM in jsdom across the full vitest run).
	const [showPinOverlay, setShowPinOverlay] = useState(false)
	const [submitting, setSubmitting] = useState(false)
	const [errorMessage, setErrorMessage] = useState<string | null>(null)
	const [done, setDone] = useState(false)
	const [doneMessage, setDoneMessage] = useState("")
	const [previewArchetype, setPreviewArchetype] = useState<string | null>(null)

	const selectArchetype = useCallback((name: string) => {
		setSelectedArchetype(name)
		setPins([]) // pins are scoped to the selected archetype
	}, [])

	const toggleKeep = useCallback((name: string) => {
		setKeptArchetypes((prev) => {
			const next = new Set(prev)
			if (next.has(name)) next.delete(name)
			else next.add(name)
			return next
		})
	}, [])

	function handleRadiogroupKeyDown(
		e: React.KeyboardEvent<HTMLFieldSetElement>,
	) {
		if (archetypes.length === 0 || mode !== "select") return
		const names = archetypes.map((a) => a.name)
		const idx = names.indexOf(selectedArchetype)
		if (idx < 0) return
		let nextIdx: number | undefined
		if (e.key === "ArrowRight" || e.key === "ArrowDown") {
			nextIdx = (idx + 1) % names.length
		} else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
			nextIdx = (idx - 1 + names.length) % names.length
		}
		if (nextIdx !== undefined) {
			e.preventDefault()
			const target = names[nextIdx]
			if (target) {
				selectArchetype(target)
				const next = document.getElementById(radioIdFor(target))
				next?.focus()
			}
		}
	}

	const canSubmit = useMemo(() => {
		if (submitting) return false
		if (mode === "select") return selectedArchetype.length > 0
		// regenerate is always submittable — even an empty `keep` set is
		// meaningful ("none of these, give me a fresh batch")
		return true
	}, [mode, selectedArchetype, submitting])

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault()
		if (!canSubmit) return
		setSubmitting(true)
		setErrorMessage(null)
		try {
			if (mode === "select") {
				const annotations =
					pins.length > 0
						? {
								pins: pins.map((p) => ({
									x: p.x,
									y: p.y,
									text: p.text,
								})),
							}
						: undefined
				await client.submitDirection(sessionId, {
					mode: "select",
					archetype: selectedArchetype,
					...(comment ? { comments: comment } : {}),
					...(annotations ? { annotations } : {}),
				})
				announce("polite", "Direction selected")
				setDoneMessage(`Direction selected: ${selectedArchetype}`)
				setDone(true)
				tryCloseTab({
					url: paths.directionSelect(sessionId),
					body: {
						mode: "select",
						archetype: selectedArchetype,
						comments: comment,
						annotations,
					},
				})
			} else {
				const keepArr = Array.from(keptArchetypes)
				await client.submitDirection(sessionId, {
					mode: "regenerate",
					keep: keepArr,
					...(comment ? { comments: comment } : {}),
				})
				announce("polite", "Variant regeneration requested")
				setDoneMessage(
					keepArr.length > 0
						? `Asked for new variants — keeping ${keepArr.length} of ${archetypes.length}`
						: "Asked for a fresh batch of variants",
				)
				setDone(true)
				tryCloseTab({
					url: paths.directionSelect(sessionId),
					body: {
						mode: "regenerate",
						keep: keepArr,
						comments: comment,
					},
				})
			}
		} catch (err) {
			const message =
				err instanceof Error ? err.message : "Failed to submit direction"
			setErrorMessage(message)
			announce("assertive", `Submission failed: ${message}`)
			setSubmitting(false)
		}
	}

	useEffect(() => {
		if (!previewArchetype) return
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") setPreviewArchetype(null)
		}
		document.addEventListener("keydown", onKey)
		return () => {
			if (typeof document === "undefined" || !document) return
			document.removeEventListener("keydown", onKey)
		}
	}, [previewArchetype])

	if (done) {
		return <SubmitSuccess message={doneMessage} />
	}

	const legendId = "direction-prompt-title"
	const commentId = "direction-comment"
	const selected = archetypes.find((a) => a.name === selectedArchetype)

	return (
		<form onSubmit={handleSubmit} noValidate>
			<Card>
				<ModeToggle
					mode={mode}
					onChange={(next) => {
						setMode(next)
						setErrorMessage(null)
					}}
					disabled={submitting}
				/>
			</Card>

			<Card>
				<ArchetypeRadiogroup
					mode={mode}
					legendId={legendId}
					title={session.title || "Design Direction"}
					archetypes={archetypes}
					selectedArchetype={selectedArchetype}
					keptArchetypes={keptArchetypes}
					submitting={submitting}
					onSelect={selectArchetype}
					onToggleKeep={toggleKeep}
					onKeyDown={handleRadiogroupKeyDown}
					onPreview={setPreviewArchetype}
				/>
			</Card>

			{mode === "select" && selected && (
				<Card>
					<SectionHeading>Annotate the {selected.name} preview</SectionHeading>
					{showPinOverlay ? (
						<>
							<p className="text-sm text-stone-600 dark:text-stone-300 mb-3">
								Click on the surface to drop pins relative to the preview
								above. Pins ride along with the selection so the agent gets
								pointed feedback.
							</p>
							<PinDropOverlay
								archetype={selected}
								pins={pins}
								onPinsChange={setPins}
								disabled={submitting}
							/>
							<button
								type="button"
								onClick={() => setShowPinOverlay(false)}
								className={`mt-3 text-xs text-stone-600 dark:text-stone-300 underline underline-offset-2 ${focusRingClass}`}
							>
								Hide annotation surface
							</button>
						</>
					) : (
						<>
							<p className="text-sm text-stone-600 dark:text-stone-300 mb-3">
								Want to leave pinned feedback on a specific spot? Open the
								annotation surface.
							</p>
							<button
								type="button"
								onClick={() => setShowPinOverlay(true)}
								disabled={submitting}
								className={`px-4 py-2 text-sm border border-stone-300 dark:border-stone-600 text-stone-700 dark:text-stone-200 rounded-lg hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors ${focusRingClass} ${touchTargetClass}`}
							>
								Add visual annotations
								{pins.length > 0 ? ` (${pins.length})` : ""}
							</button>
						</>
					)}
				</Card>
			)}

			<Card>
				<label
					htmlFor={commentId}
					className="block text-sm font-medium text-stone-900 dark:text-stone-100 mb-2"
				>
					{mode === "select"
						? "Optional comment"
						: "What do you want to change? (steers the next batch)"}
				</label>
				<textarea
					id={commentId}
					className={`w-full p-3 border border-stone-300 dark:border-stone-600 rounded-lg bg-white dark:bg-stone-800 text-stone-900 dark:text-stone-100 resize-y text-sm ${focusRingClass}`}
					rows={3}
					placeholder={
						mode === "select"
							? "Anything else worth noting about this direction..."
							: "More minimal, brighter palette, less text..."
					}
					value={comment}
					onChange={(e) => setComment(e.target.value)}
					disabled={submitting}
				/>
			</Card>

			<button
				type="submit"
				disabled={!canSubmit}
				aria-disabled={!canSubmit}
				className={`w-full px-6 py-3 bg-teal-700 hover:bg-teal-800 text-white font-semibold rounded-lg transition-colors ${focusRingClass} disabled:bg-green-300 disabled:text-green-800 dark:disabled:bg-green-900/40 dark:disabled:text-green-200 disabled:cursor-not-allowed ${touchTargetClass}`}
			>
				{submitting
					? "Submitting..."
					: mode === "select"
						? "Choose This Direction"
						: keptArchetypes.size > 0
							? `Generate more — keep ${keptArchetypes.size}`
							: "Generate a fresh batch"}
			</button>

			{errorMessage && (
				<div
					role="alert"
					className="mt-4 p-4 rounded-lg bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 text-red-800 dark:text-red-200"
				>
					<p className="font-semibold">{errorMessage}</p>
				</div>
			)}

			{previewArchetype && (
				<PreviewDialog
					archetype={
						archetypes.find((a) => a.name === previewArchetype) ?? null
					}
					onClose={() => setPreviewArchetype(null)}
				/>
			)}
		</form>
	)
}

function radioIdFor(name: string): string {
	return `direction-radio-${name.replace(/\s+/g, "-").toLowerCase()}`
}

function keepIdFor(name: string): string {
	return `direction-keep-${name.replace(/\s+/g, "-").toLowerCase()}`
}

// ── Mode toggle ────────────────────────────────────────────────────────────

function ModeToggle({
	mode,
	onChange,
	disabled,
}: {
	mode: Mode
	onChange: (next: Mode) => void
	disabled: boolean
}): React.ReactElement {
	return (
		<fieldset className="border-0 p-0 m-0">
			<legend className="text-sm font-medium text-stone-900 dark:text-stone-100 mb-2">
				What do you want to do?
			</legend>
			<div className="flex flex-wrap gap-2">
				<ModeRadio
					value="select"
					label="Pick one of these"
					checked={mode === "select"}
					onChange={onChange}
					disabled={disabled}
				/>
				<ModeRadio
					value="regenerate"
					label="Show me different variants"
					checked={mode === "regenerate"}
					onChange={onChange}
					disabled={disabled}
				/>
			</div>
		</fieldset>
	)
}

function ModeRadio({
	value,
	label,
	checked,
	onChange,
	disabled,
}: {
	value: Mode
	label: string
	checked: boolean
	onChange: (next: Mode) => void
	disabled: boolean
}): React.ReactElement {
	const id = `direction-mode-${value}`
	return (
		<label
			htmlFor={id}
			className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors ${touchTargetClass} ${
				checked
					? "border-teal-600 dark:border-teal-400 bg-teal-50 dark:bg-teal-900/20"
					: "border-stone-200 dark:border-stone-700 hover:border-stone-400 dark:hover:border-stone-500"
			}`}
		>
			<input
				id={id}
				type="radio"
				name="direction-mode"
				value={value}
				checked={checked}
				aria-checked={checked}
				onChange={() => onChange(value)}
				disabled={disabled}
				className={`w-4 h-4 text-teal-600 ${focusRingClass}`}
			/>
			<span className="text-sm text-stone-900 dark:text-stone-100">{label}</span>
		</label>
	)
}

// ── Archetype radiogroup ───────────────────────────────────────────────────

interface ArchetypeRadiogroupProps {
	mode: Mode
	legendId: string
	title: string
	archetypes: DesignArchetypeData[]
	selectedArchetype: string
	keptArchetypes: Set<string>
	submitting: boolean
	onSelect: (name: string) => void
	onToggleKeep: (name: string) => void
	onKeyDown: (e: React.KeyboardEvent<HTMLFieldSetElement>) => void
	onPreview: (name: string) => void
}

function ArchetypeRadiogroup({
	mode,
	legendId,
	title,
	archetypes,
	selectedArchetype,
	keptArchetypes,
	submitting,
	onSelect,
	onToggleKeep,
	onKeyDown,
	onPreview,
}: ArchetypeRadiogroupProps): React.ReactElement {
	return (
		<fieldset
			role={mode === "select" ? "radiogroup" : undefined}
			aria-labelledby={legendId}
			onKeyDown={onKeyDown}
			className="border-0 p-0 m-0"
		>
			<legend
				id={legendId}
				className="text-lg font-semibold mb-3 text-stone-900 dark:text-stone-100"
			>
				{title}
			</legend>
			<p className="text-sm text-stone-600 dark:text-stone-300 mb-4">
				{mode === "select"
					? "Select an archetype, drop pins on its preview, then submit."
					: "Tick the ones worth keeping. The agent will replace the rest."}
			</p>

			<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
				{archetypes.map((arch) => {
					const isSelected = arch.name === selectedArchetype
					const isKept = keptArchetypes.has(arch.name)
					const radioId = radioIdFor(arch.name)
					const keepId = keepIdFor(arch.name)
					const highlighted = mode === "select" ? isSelected : isKept
					return (
						<div key={arch.name} className="relative">
							<label
								htmlFor={mode === "select" ? radioId : keepId}
								className={`group relative block w-full cursor-pointer rounded-xl border-2 p-4 text-left transition-colors ${
									highlighted
										? "border-teal-600 dark:border-teal-400 bg-teal-50 dark:bg-teal-900/20"
										: "border-stone-200 dark:border-stone-700 hover:border-stone-400 dark:hover:border-stone-500"
								}`}
							>
								<div className="flex items-center gap-2 mb-2">
									{mode === "select" ? (
										<input
											id={radioId}
											type="radio"
											name="direction"
											value={arch.name}
											checked={isSelected}
											aria-checked={isSelected}
											onChange={() => onSelect(arch.name)}
											disabled={submitting}
											className={`w-4 h-4 text-teal-600 ${focusRingClass}`}
										/>
									) : (
										<input
											id={keepId}
											type="checkbox"
											name={`direction-keep-${arch.name}`}
											checked={isKept}
											onChange={() => onToggleKeep(arch.name)}
											disabled={submitting}
											className={`w-4 h-4 text-teal-600 ${focusRingClass}`}
										/>
									)}
									<span className="font-semibold text-stone-900 dark:text-stone-100">
										{arch.name}
									</span>
								</div>
								<p className="text-sm text-stone-600 dark:text-stone-300 mb-3">
									{arch.description}
								</p>
								<iframe
									srcDoc={arch.preview_html}
									sandbox=""
									title={`Preview: ${arch.name}`}
									aria-label={`Preview: ${arch.name}`}
									className="w-full h-40 rounded-lg border border-stone-200 dark:border-stone-700 bg-white pointer-events-none"
								/>
							</label>
							<button
								type="button"
								onClick={() => onPreview(arch.name)}
								aria-label={`View full size preview: ${arch.name}`}
								className={`mt-2 text-xs text-teal-700 dark:text-teal-300 underline underline-offset-2 rounded-sm ${focusRingClass}`}
							>
								View full size
							</button>
						</div>
					)
				})}
			</div>
		</fieldset>
	)
}

// ── Pin-drop overlay (visual annotation on the iframe preview) ─────────────

interface PinDropOverlayProps {
	archetype: DesignArchetypeData
	pins: PinInput[]
	onPinsChange: (pins: PinInput[]) => void
	disabled: boolean
}

function PinDropOverlay({
	archetype,
	pins,
	onPinsChange,
	disabled,
}: PinDropOverlayProps): React.ReactElement {
	const wrapperRef = useRef<HTMLDivElement | null>(null)
	const [pendingPin, setPendingPin] = useState<{ x: number; y: number } | null>(
		null,
	)
	const [pendingText, setPendingText] = useState("")

	function handleClick(e: React.MouseEvent<HTMLDivElement>) {
		if (disabled) return
		const wrapper = wrapperRef.current
		if (!wrapper) return
		const rect = wrapper.getBoundingClientRect()
		const x = ((e.clientX - rect.left) / rect.width) * 100
		const y = ((e.clientY - rect.top) / rect.height) * 100
		setPendingPin({ x, y })
		setPendingText("")
	}

	function commitPin() {
		if (!pendingPin) return
		const text = pendingText.trim()
		if (text.length === 0) {
			setPendingPin(null)
			return
		}
		onPinsChange([...pins, { x: pendingPin.x, y: pendingPin.y, text }])
		setPendingPin(null)
		setPendingText("")
	}

	function cancelPendingPin() {
		setPendingPin(null)
		setPendingText("")
	}

	function removePin(idx: number) {
		onPinsChange(pins.filter((_, i) => i !== idx))
	}

	return (
		<>
			{/*
			 * The pin surface mirrors the `View full size` card above for
			 * spatial reference, but renders the archetype as a labelled
			 * placeholder rather than a second sandboxed iframe — duplicate
			 * srcDoc iframes leak DOM resources across vitest+jsdom test
			 * isolations and made the FB-69 focus-trap suite contaminated.
			 * Users see the live preview in the radio card above; this
			 * surface exists only to host pins.
			 */}
			<div
				ref={wrapperRef}
				role="img"
				aria-label={`Pin surface for ${archetype.name}`}
				className="relative h-72 rounded-lg overflow-hidden border-2 border-dashed border-stone-300 dark:border-stone-600 bg-stone-50 dark:bg-stone-800 cursor-crosshair flex items-center justify-center"
				onClick={handleClick}
			>
				<div className="pointer-events-none text-center px-4">
					<p className="text-sm font-medium text-stone-700 dark:text-stone-200">
						{archetype.name}
					</p>
					<p className="text-xs text-stone-500 dark:text-stone-400 mt-1">
						Click to drop pins relative to the preview above.
					</p>
				</div>
				{pins.map((pin, i) => (
					<button
						key={`${pin.x}-${pin.y}-${i}`}
						type="button"
						aria-label={`Pin ${i + 1}: ${pin.text}`}
						title={pin.text}
						onClick={(e) => {
							e.stopPropagation()
							removePin(i)
						}}
						style={{ left: `${pin.x}%`, top: `${pin.y}%` }}
						className={`absolute -translate-x-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-teal-700 text-white text-xs font-bold flex items-center justify-center shadow-md hover:bg-red-600 ${focusRingClass}`}
					>
						{i + 1}
					</button>
				))}
				{pendingPin && (
					<div
						style={{ left: `${pendingPin.x}%`, top: `${pendingPin.y}%` }}
						className="absolute -translate-x-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-amber-500 text-white text-xs font-bold flex items-center justify-center shadow-md ring-2 ring-amber-300 animate-pulse"
					>
						?
					</div>
				)}
			</div>
			{pendingPin && (
				<div className="mt-3 p-3 rounded-lg border border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-800">
					<label
						htmlFor="pending-pin-text"
						className="block text-sm font-medium text-stone-900 dark:text-stone-100 mb-2"
					>
						What about this spot?
					</label>
					<textarea
						id="pending-pin-text"
						className={`w-full p-2 border border-stone-300 dark:border-stone-600 rounded-md bg-white dark:bg-stone-900 text-stone-900 dark:text-stone-100 resize-y text-sm ${focusRingClass}`}
						rows={2}
						value={pendingText}
						onChange={(e) => setPendingText(e.target.value)}
						placeholder="Too cramped here, swap the order, etc."
						autoFocus
					/>
					<div className="mt-2 flex gap-2">
						<button
							type="button"
							onClick={commitPin}
							disabled={pendingText.trim().length === 0}
							className={`px-3 py-1 text-sm bg-teal-700 hover:bg-teal-800 text-white rounded ${focusRingClass} disabled:bg-stone-300 disabled:text-stone-500 disabled:cursor-not-allowed`}
						>
							Add pin
						</button>
						<button
							type="button"
							onClick={cancelPendingPin}
							className={`px-3 py-1 text-sm border border-stone-300 dark:border-stone-600 text-stone-700 dark:text-stone-200 rounded hover:bg-stone-100 dark:hover:bg-stone-700 ${focusRingClass}`}
						>
							Cancel
						</button>
					</div>
				</div>
			)}
			{pins.length > 0 && (
				<p className="mt-2 text-xs text-stone-600 dark:text-stone-300">
					{pins.length} pin{pins.length === 1 ? "" : "s"} — click a pin to
					remove it.
				</p>
			)}
		</>
	)
}

// ── Preview dialog (full-size iframe) ───────────────────────────────────────

function PreviewDialog({
	archetype,
	onClose,
}: {
	archetype: { name: string; preview_html: string } | null
	onClose: () => void
}): React.ReactElement | null {
	const dialogRef = useRef<HTMLDivElement | null>(null)
	useFocusTrap(dialogRef, archetype !== null)

	if (!archetype) return null
	const titleId = "direction-preview-dialog-title"
	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center">
			<div
				aria-hidden="true"
				className="absolute inset-0 bg-black/60 backdrop-blur-sm"
				onClick={onClose}
			/>
			<div
				ref={dialogRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				className="relative bg-white dark:bg-stone-900 rounded-xl shadow-2xl"
				style={{ width: "90vw", height: "90vh" }}
			>
				<div className="flex items-center justify-between px-4 py-3 border-b border-stone-200 dark:border-stone-700">
					<h3
						id={titleId}
						className="font-semibold text-stone-900 dark:text-stone-100"
					>
						{archetype.name}
					</h3>
					<button
						type="button"
						onClick={onClose}
						aria-label="Dismiss preview"
						className={`text-stone-600 hover:text-stone-900 dark:text-stone-300 dark:hover:text-stone-100 text-xl leading-none px-2 ${focusRingClass}`}
					>
						&times;
					</button>
				</div>
				<iframe
					srcDoc={archetype.preview_html}
					sandbox=""
					title={`Full preview: ${archetype.name}`}
					className="w-full rounded-b-xl bg-white"
					style={{ height: "calc(90vh - 3rem)" }}
				/>
			</div>
		</div>
	)
}
