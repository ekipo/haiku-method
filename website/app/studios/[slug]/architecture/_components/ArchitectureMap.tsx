"use client"

import { useRouter } from "next/navigation"
import {
	Fragment,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react"
import { ACTORS } from "../_data/actors"
import { HOOK_BY_NAME } from "../_data/hooks"
import { type PayloadResult, payloadFor, type TransitionKey, type TransitionOpts } from "../_data/payload-for"
import type {
	DerivedStage,
	ExecutionMode,
	ModalKind,
	StudioContentBundle,
	StudioContentEntry,
	StudioContentFile,
} from "../_data/types"
import "./arch.css"
import { HtmlBlock, Modal } from "./Modal"
import {
	branchName,
	demoWavesAndUnits,
	effectiveMode,
	escHTML,
	formatInputs,
	gateClass,
	gateFromReview,
	renderInline,
	renderMarkdown,
	shortHat,
} from "./utils"

interface ArchitectureMapProps {
	initialStudioDir: string
}

export function ArchitectureMap({ initialStudioDir }: ArchitectureMapProps) {
	const router = useRouter()
	const [bundle, setBundle] = useState<StudioContentBundle | null>(null)
	const [activeStudio, setActiveStudio] = useState(initialStudioDir)
	const [mode, setMode] = useState<ExecutionMode>("continuous")
	const [continuousFrom, setContinuousFrom] = useState<string>("")
	const [modal, setModal] = useState<ModalKind | null>(null)
	const [matchedArtifact, setMatchedArtifact] = useState<string | null>(null)
	const mainRef = useRef<HTMLDivElement>(null)

	// Fetch the bundle ONCE — it's a static JSON containing every studio.
	// Studio switching is a pure state change after this; no refetch.
	useEffect(() => {
		let cancelled = false
		fetch("/prototype-stage-content.json")
			.then((r) => r.json())
			.then((data: StudioContentBundle) => {
				if (cancelled) return
				setBundle(data)
			})
			.catch((err) => console.warn("studio content fetch failed", err))
		return () => {
			cancelled = true
		}
	}, [])

	// Once the bundle loads (or the active studio drifts to something the
	// bundle doesn't recognize), fall back to defaultStudio / first available.
	useEffect(() => {
		if (!bundle) return
		if (bundle.studios?.[activeStudio]) return
		const fallback =
			bundle.defaultStudio || Object.keys(bundle.studios || {})[0] || "software"
		setActiveStudio(fallback)
	}, [bundle, activeStudio])

	const studioContent: StudioContentEntry | null = bundle?.studios?.[activeStudio] ?? null

	const stages: DerivedStage[] = useMemo(() => {
		if (!studioContent) return []
		const order = Array.isArray(studioContent.stagesOrder) ? studioContent.stagesOrder : []
		const out: DerivedStage[] = []
		for (const key of order) {
			const stage = studioContent.stages?.[key]
			if (!stage) continue
			const fm = stage.frontmatter ?? {}
			const hats = Array.isArray(fm.hats) && fm.hats.length
				? (fm.hats as string[])
				: Object.keys(stage.hats ?? {})
			const reviewAgents = Object.keys(stage.reviewAgents ?? {})
			const gate = gateFromReview(fm.review)
			const outputsFromFm = Array.isArray(fm.outputs)
				? (fm.outputs as Array<{ discovery?: string; output?: string } | string>)
						.map((o) =>
							typeof o === "string"
								? o
								: (o?.discovery ?? o?.output ?? ""),
						)
						.filter(Boolean)
				: []
			const outputsUnion = new Set<string>([
				...outputsFromFm,
				...Object.keys(stage.discoveryDefs ?? {}),
				...Object.keys(stage.outputDefs ?? {}),
			])
			const { waves, units } = demoWavesAndUnits(hats.length)
			out.push({
				key,
				name: key.charAt(0).toUpperCase() + key.slice(1),
				reviewLabel: gate.label,
				hats,
				waves,
				units,
				reviewAgents,
				inputs: formatInputs(fm.inputs),
				outputs: Array.from(outputsUnion),
				gate: { type: gate.type, options: gate.options },
			})
		}
		return out
	}, [studioContent])

	useEffect(() => {
		if (mode !== "hybrid" || !stages.length) return
		const valid = stages.slice(1).map((s) => s.name.toLowerCase())
		if (!valid.includes(continuousFrom)) {
			setContinuousFrom(valid[Math.floor(valid.length / 2)] ?? valid[0] ?? "")
		}
	}, [mode, stages, continuousFrom])

	const continuousFromIdx = useMemo(
		() => stages.findIndex((s) => s.name.toLowerCase() === continuousFrom),
		[stages, continuousFrom],
	)

	const studioOptions = useMemo(() => {
		if (!bundle) return [] as Array<{ category: string; items: { dir: string; stageCount: number }[] }>
		const list = bundle.studioList ?? []
		const byCat = new Map<string, { dir: string; stageCount: number }[]>()
		for (const s of list) {
			const cat = s.category || "other"
			if (!byCat.has(cat)) byCat.set(cat, [])
			byCat.get(cat)?.push({ dir: s.dir, stageCount: s.stageCount })
		}
		return [...byCat.entries()]
			.sort((a, b) => a[0].localeCompare(b[0]))
			.map(([category, items]) => ({
				category,
				items: items.sort((a, b) => a.dir.localeCompare(b.dir)),
			}))
	}, [bundle])

	const closeModal = useCallback(() => setModal(null), [])

	// Artifact hover-pair: when hovering over an artifact chip, highlight all
	// matching artifacts (including in the knowledge pool sidebar).
	const matchArtifact = useCallback((key: string | null, query: string | null) => {
		if (!query) {
			setMatchedArtifact(null)
			return
		}
		setMatchedArtifact(query)
	}, [])

	const isArtifactMatch = useCallback(
		(key: string) => {
			if (!matchedArtifact) return false
			if (key === matchedArtifact) return true
			if (matchedArtifact.endsWith(".*")) {
				return key.startsWith(matchedArtifact.slice(0, -1))
			}
			if (key.endsWith(".*")) {
				return matchedArtifact.startsWith(key.slice(0, -1))
			}
			return false
		},
		[matchedArtifact],
	)

	const renderActorsStrip = () => {
		const arrows = [
			{ label: "conversation", glyph: "⇆" },
			{ label: "intercepts", glyph: "↔" },
			{ label: "tool calls", glyph: "→" },
			{ label: "openReviewAndWait", glyph: "→" },
		]
		const order: { key: string; cls: string }[] = [
			{ key: "user", cls: "user" },
			{ key: "agent", cls: "agent" },
			{ key: "hooks", cls: "hooks" },
			{ key: "orchestrator", cls: "orchestrator" },
			{ key: "webui", cls: "webui" },
		]
		return (
			<section className="actors-strip">
				<h2>Actors</h2>
				{order.map((actor, i) => {
					const def = ACTORS[actor.key]
					return (
						<Fragment key={actor.key}>
							<button
								type="button"
								className={`actor-box ${actor.cls}`}
								onClick={() => setModal({ kind: "actor", actorKey: actor.key })}
							>
								<div>
									<span className="actor-icon">{def.icon}</span>{" "}
									<span className="actor-name">{def.name}</span>
								</div>
								<div className="actor-role">{def.role.split(".")[0]}</div>
							</button>
							{i < order.length - 1 && arrows[i] ? (
								<div className="actor-arrow">
									<span>{arrows[i].glyph}</span>
									<span className="arrow-label">{arrows[i].label}</span>
								</div>
							) : null}
						</Fragment>
					)
				})}
			</section>
		)
	}

	const callPill = (
		stage: DerivedStage,
		idx: number,
		mStage: ExecutionMode,
		key: TransitionKey,
		opts: TransitionOpts = {},
		variant: "full" | "mini" = "full",
		caption?: string,
	) => {
		const p = payloadFor(stage, idx, mStage, key, opts)
		if (!p) return null
		const onClick = () =>
			setModal({
				kind: "payload",
				payload: { stage: stage.name, key, ...p },
			})
		// The mini chip's label IS the action — including hat-to-hat which is
		// actually `haiku_unit_advance_hat` (subagent-driven, not a workflow tick).
		const miniLabel = key === "hat-to-hat" ? "advance_hat" : "haiku_run_next"
		if (variant === "mini") {
			return (
				<button
					type="button"
					className="call-mini"
					onClick={onClick}
					title={`${p.action} — ${p.summary}`}
				>
					{miniLabel}
				</button>
			)
		}
		return (
			<div className="phase-arrow with-call">
				<button type="button" className="call-chip" onClick={onClick}>
					haiku_run_next
				</button>
				{caption ? (
					<span
						style={{
							fontFamily: "ui-monospace, 'SF Mono', monospace",
							fontSize: 9,
							color: "var(--muted)",
							marginTop: 2,
						}}
					>
						→ returns <strong style={{ color: "#1f2937" }}>{p.action}</strong> · {caption}
					</span>
				) : null}
				<span className="arrow-glyph">↓</span>
				<div className="call-tooltip">
					<div className="tt-action">{p.action}</div>
					<div className="tt-summary">{p.summary}</div>
					<div className="tt-hint">click for full payload &amp; validations</div>
				</div>
			</div>
		)
	}

	const renderStage = (stage: DerivedStage, idx: number) => {
		const mStage = effectiveMode(idx, mode, continuousFromIdx)
		const stageGate = effectiveGate(stage, mStage)
		const isAutoGate = stageGate.type === "auto" || stageGate.type.startsWith("auto ")
		const isContinuousMarker = mode === "hybrid" && idx === continuousFromIdx
		const lower = stage.name.toLowerCase()
		const isFirst = idx === 0

		return (
			<Fragment key={stage.key}>
				<section className={`stage${isContinuousMarker ? " continuous-marker-stage" : ""}`}>
					<header>
						<button
							type="button"
							className="clickable"
							style={{
								all: "unset",
								cursor: "pointer",
								fontSize: "15px",
								fontWeight: 600,
								letterSpacing: "0.02em",
								textTransform: "uppercase",
							}}
							onClick={() => setModal({ kind: "stageMd", stageKey: lower })}
							title="open STAGE.md"
						>
							{idx + 1}. {stage.name}
						</button>
					</header>

					<button
						type="button"
						onClick={() => setModal({ kind: "preTickTriage" })}
						style={{
							all: "unset",
							display: "flex",
							alignItems: "center",
							gap: 8,
							margin: "0 0 4px",
							padding: "5px 9px",
							background: "#0f172a",
							color: "#fbbf24",
							borderRadius: 6,
							fontSize: 9,
							lineHeight: 1.4,
							fontFamily: "ui-monospace, 'SF Mono', monospace",
							fontWeight: 700,
							letterSpacing: "0.06em",
							textTransform: "uppercase",
							cursor: "pointer",
							boxSizing: "border-box",
						}}
						title="Click for the pre-tick triage gate flow"
					>
						<span>⛓ pre-tick triage gate</span>
						<span style={{ color: "#94a3b8", fontWeight: 500, textTransform: "none", letterSpacing: 0 }}>
							run-tick.ts · runs BEFORE every handler tick
						</span>
						<span style={{ marginLeft: "auto", color: "#94a3b8", fontWeight: 500 }}>expand ↗</span>
					</button>

					{stage.inputs.length > 0 ? (
						<div className="artifacts-block">
							<div className="artifacts-label">inputs ← pool</div>
							<div className="artifacts in">
								{stage.inputs.map((i) => (
									<button
										key={i}
										type="button"
										className={`artifact${isArtifactMatch(i) ? " match" : ""}`}
										data-artifact={i}
										onMouseEnter={() => matchArtifact(i, i)}
										onMouseLeave={() => matchArtifact(null, null)}
										onClick={() => setModal({ kind: "artifact", artifactKey: i })}
										title={i}
									>
										{i}
									</button>
								))}
							</div>
						</div>
					) : (
						<div className="artifacts-block">
							<div className="artifacts-label">implicit input · seed</div>
							<div className="artifacts in">
								<span className="artifact" title="The first stage has no prior-stage inputs.">
									<code style={{ fontSize: "9px", background: "transparent", border: "none", padding: 0 }}>
										intent.md
									</code>{" "}
									(frontmatter + body)
								</span>
							</div>
						</div>
					)}

					<div className="phase" data-phase="elaborate">
						<h3>
							Elaborate
							<button
								type="button"
								className="revisit-chip"
								onClick={() => setModal({ kind: "revisit", stageKey: lower, stageIdx: idx })}
							>
								↺ /haiku:revisit
							</button>
						</h3>
						{mStage !== "auto" ? (
							<div className="elab-step">
								<div className="step-label">① conversation</div>
								<div className="elab-conversation">
									<div className="mini-actor">🧑</div>
									<div className="turn-glyph">⇆</div>
									<div className="mini-actor">🤖</div>
									<span className="turns-note">≥ 3 turns · collaborative</span>
								</div>
							</div>
						) : null}
						{(() => {
							const defs = studioContent?.stages?.[lower]?.discoveryDefs ?? {}
							const slugs = Object.keys(defs)
							if (!slugs.length) return null
							return (
								<div className="elab-step">
									<div className="step-label">
										② discovery artifacts{" "}
										<span style={{ textTransform: "none", letterSpacing: 0, color: "#7c3aed", fontWeight: 600 }}>
											· workflow engine fans out one ↗ subagent per artifact
										</span>
									</div>
									<div className="elab-discovery">
										{slugs.map((s) => {
											const key = `${lower}.${s}`
											return (
												<button
													key={s}
													type="button"
													className={`disc artifact${isArtifactMatch(key) ? " match" : ""}`}
													data-artifact={key}
													onMouseEnter={() => matchArtifact(key, key)}
													onMouseLeave={() => matchArtifact(null, null)}
													onClick={() => setModal({ kind: "artifact", artifactKey: key })}
													title={defs[s]?.path}
												>
													{s} <span style={{ color: "#7c3aed", fontWeight: 700 }}>↗</span>
												</button>
											)
										})}
									</div>
								</div>
							)
						})()}
						<div className="elab-step">
							<div className="step-label">③ units decomposed (work breakdown · DAG)</div>
							<div className="units">
								{stage.units.map((u) => (
									<button
										key={u.id}
										type="button"
										className="unit clickable"
										onClick={() =>
											setModal({ kind: "unit", stageName: stage.name, unitId: u.id, model: u.model })
										}
										title={`${u.id} · model: ${u.model}`}
									>
										{u.id}
										<span className="model-badge">{u.model}</span>
									</button>
								))}
							</div>
						</div>
						<div className="elab-step">
							<div className="step-label">④ validation</div>
							<div className="elab-validate">
								{["dag-acyclic", "unit-naming", "unit-types", "inputs-exist"].map((k) => (
									<button
										key={k}
										type="button"
										className="check"
										onClick={() => setModal({ kind: "validation", validationKey: k })}
									>
										✓ {k.replace("-", " ")}
									</button>
								))}
								{mStage !== "auto" ? (
									<button
										type="button"
										className="check"
										onClick={() => setModal({ kind: "validation", validationKey: "turns-min" })}
									>
										✓ turns ≥ 3
									</button>
								) : null}
							</div>
						</div>
					</div>

					<div className="phase-arrow">↓</div>

					<div className="gate-wrap" style={{ paddingLeft: 0, marginTop: 22 }}>
						{(() => {
							const p = payloadFor(stage, idx, mStage, "elab-to-prereview")
							return (
								<>
									<button
										type="button"
										className="call-chip gate-pill"
										onClick={() =>
											p && setModal({ kind: "payload", payload: { stage: stage.name, key: "elab-to-prereview", ...p } })
										}
										title={p ? `${p.action} — ${p.summary}` : ""}
									>
										haiku_run_next
									</button>
									<div
										className="nested-gate"
										style={{
											borderColor: "#0d9488",
											background: "#ecfdf5",
											cursor: "default",
										}}
									>
										<div className="ng-head">
											<span className="ng-caption" style={{ color: "#0f766e" }}>
												↳ inside this call · returns <code>pre_review</code> action
											</span>
											<span className="ig-type" style={{ color: "#0f766e" }}>
												dispatch reviewers
											</span>
											<span className="ig-ctx">runs in ALL modes</span>
										</div>
										<div
											style={{
												marginTop: 4,
												fontSize: 10,
												color: "#065f46",
												lineHeight: 1.45,
											}}
										>
											Conditional review agents audit every <code>unit-NN-*.md</code> file —
											artifacts don't exist yet, so reviewers audit the <em>plan</em>. Findings
											block advance; resolution is a spec edit. <strong>Auto mode does not skip
											this</strong> — only the human spec gate is gated by autopilot.
										</div>
									</div>
								</>
							)
						})()}
					</div>

					<div className="phase-arrow">↓</div>

					{isAutoGate ? (
						<div className="gate-wrap" style={{ paddingLeft: 0, marginTop: 22 }}>
							{(() => {
								const p = payloadFor(stage, idx, mStage, "prereview-to-gate")
								return (
									<>
										<button
											type="button"
											className="call-chip gate-pill"
											onClick={() =>
												p &&
												setModal({
													kind: "payload",
													payload: { stage: stage.name, key: "prereview-to-gate", ...p },
												})
											}
											title={p ? `${p.action} — ${p.summary}` : ""}
										>
											haiku_run_next
										</button>
										<div
											className="nested-gate"
											style={{
												borderColor: "#d97706",
												background: "#fef3c7",
												cursor: "default",
											}}
										>
											<div className="ng-head">
												<span className="ng-caption" style={{ color: "#92400e" }}>
													↳ inside this call · auto-advances · no review UI
												</span>
												<span className="ig-type" style={{ color: "#92400e" }}>auto</span>
												<span className="ig-ctx">advance_phase</span>
											</div>
											<div
												style={{
													marginTop: 4,
													fontSize: 10,
													color: "#92400e",
													lineHeight: 1.45,
												}}
											>
												<code>review: auto</code> — no gate review, advances directly to{" "}
												<code>execute</code>.
											</div>
										</div>
									</>
								)
							})()}
						</div>
					) : (
						<div className="gate-wrap" style={{ paddingLeft: 0, marginTop: 22 }}>
							{(() => {
								const p = payloadFor(stage, idx, mStage, "elab-to-gate")
								return (
									<>
										<button
											type="button"
											className="call-chip gate-pill"
											onClick={() =>
												p &&
												setModal({
													kind: "payload",
													payload: { stage: stage.name, key: "elab-to-gate", ...p },
												})
											}
											title={p ? `${p.action} — ${p.summary}` : ""}
										>
											haiku_run_next
										</button>
										<div
											className="nested-gate"
											role="button"
											tabIndex={0}
											onClick={() => setModal({ kind: "gateDetail", detailKey: "specs_gate_review" })}
											onKeyDown={(e) => {
												if (e.key === "Enter" || e.key === " ") {
													e.preventDefault()
													setModal({ kind: "gateDetail", detailKey: "specs_gate_review" })
												}
											}}
											style={{ cursor: "pointer" }}
											title="Click for the full specs_gate_review flow"
										>
											<div className="ng-head">
												<span className="ng-caption">
													↳ inside this call · opens <code>specs_gate_review</code> (blocking)
												</span>
												<span className="ig-type">ask</span>
												<span className="ig-ctx">
													{isFirst ? "intent_review" : "elaborate_to_execute"}
												</span>
											</div>
											<div className="ng-branch-row">
												<span className="ng-branch reject-branch">
													↑ reject → <strong>feedback_dispatch</strong>
												</span>
												<span className="ng-branch approve-branch">↓ approve → execute</span>
											</div>
										</div>
									</>
								)
							})()}
						</div>
					)}

					<div className="phase-arrow">↓</div>

					<div className="phase" data-phase="execute">
						<h3>Execute</h3>
						<div className="bolt-explainer">
							<span className="be-chip">bolt</span>
							<span className="be-text">
								one full <strong>hat rotation</strong> for a unit · starts at <code>1</code> · hat
								rejection (↻) rewinds one hat AND increments bolt · hard max{" "}
								<strong>5</strong> per unit
							</span>
						</div>
						<div className="execute-body">
							{stage.waves.map((w, wi) => (
								<Fragment key={w.label}>
									{wi > 0 ? (
										<div className="wave-divider">
											{callPill(stage, idx, mStage, "wave-to-wave", { from: String(wi), to: String(wi + 1), units: w.units }, "mini")}
										</div>
									) : null}
									<div className="wave">
										<span className="wave-label">{w.label}</span>
										<div style={{ gridColumn: 2, minWidth: 0 }}>
											<div className="wave-atomicity">
												↗ parent spawns {w.units.length === 1 ? "this subagent" : `all ${w.units.length} subagents`}{" "}
												in one response
											</div>
											<div className="cylinders">
												{w.units.map((uid) => {
													const unit = stage.units.find((x) => x.id === uid) ?? { id: uid, model: "" }
													return (
														<div key={uid} className="cylinder">
															<span className="cyl-label">
																{unit.id}
																{unit.model ? <span style={{ color: "#6b7280" }}> · {unit.model}</span> : null}
															</span>
															<button
																type="button"
																className="cyl-bolt"
																onClick={() => setModal({ kind: "schema", schemaKey: "unit" })}
															>
																bolt 1
															</button>
															<div className="cyl-body">
																{stage.hats.map((h, hi) => (
																	<Fragment key={h}>
																		<div
																			role="button"
																			tabIndex={0}
																			className="hat clickable"
																			onClick={() =>
																				setModal({ kind: "hat", stageKey: lower, hatName: h })
																			}
																			onKeyDown={(e) => {
																				if (e.key === "Enter" || e.key === " ") {
																					e.preventDefault()
																					setModal({ kind: "hat", stageKey: lower, hatName: h })
																				}
																			}}
																		>
																			{shortHat(h)}
																			<button
																				type="button"
																				className="subagent-badge"
																				onClick={(e) => {
																					e.stopPropagation()
																					setModal({ kind: "subagent", stageKey: lower, hatName: h })
																				}}
																			>
																				↗
																			</button>
																		</div>
																		{hi < stage.hats.length - 1 ? (
																			<div className="hat-arrow-wrap">
																				<button
																					type="button"
																					className="call-mini-hat call-mini"
																					onClick={() => {
																						const next = stage.hats[hi + 1]
																						const p = payloadFor(stage, idx, mStage, "hat-to-hat", {
																							from: h,
																							to: next,
																							unit: unit.id,
																						})
																						if (p)
																							setModal({
																								kind: "payload",
																								payload: { stage: stage.name, key: "hat-to-hat", ...p },
																							})
																					}}
																				>
																					↻
																				</button>
																				<svg className="back-arc" viewBox="0 0 18 52" aria-hidden="true">
																					<path d="M 2 48 L 10 48 Q 15 48 15 43 L 15 11 Q 15 6 10 6 L 4 6" />
																					<path className="head" d="M 2 6 l 6 -3 l 0 6 z" />
																				</svg>
																				<span className="bolt-tick">⚡+1</span>
																			</div>
																		) : null}
																	</Fragment>
																))}
															</div>
														</div>
													)
												})}
											</div>
										</div>
									</div>
								</Fragment>
							))}
						</div>
					</div>

					<div className="phase-arrow">↓</div>

					<div className="gate-wrap self-loop" style={{ paddingLeft: 0, marginTop: 22 }}>
						{(() => {
							const p = payloadFor(stage, idx, mStage, "execute-to-review")
							return (
								<>
									<button
										type="button"
										className="call-chip gate-pill"
										onClick={() =>
											p &&
											setModal({
												kind: "payload",
												payload: { stage: stage.name, key: "execute-to-review", ...p },
											})
										}
										title={p ? `${p.action} — ${p.summary}` : ""}
									>
										haiku_run_next
									</button>
									<div
										className="nested-gate"
										role="button"
										tabIndex={0}
										onClick={() => setModal({ kind: "gateDetail", detailKey: "quality_gates" })}
										onKeyDown={(e) => {
											if (e.key === "Enter" || e.key === " ") {
												e.preventDefault()
												setModal({ kind: "gateDetail", detailKey: "quality_gates" })
											}
										}}
										style={{ cursor: "pointer" }}
										title="Click for the full quality_gates flow"
									>
										<div className="ng-head">
											<span className="ng-caption">
												↳ inside this call · runs 🧪 <code>quality_gates</code>
											</span>
											<span className="ig-type">hard</span>
											<span className="ig-ctx">tests · lint · typecheck</span>
										</div>
										<div className="ng-branch-row">
											<span className="ng-branch reject-branch">↑ fail → fix in place, retry</span>
											<span className="ng-branch approve-branch">↓ pass → review agents</span>
										</div>
									</div>
								</>
							)
						})()}
					</div>

					<div className="phase-arrow">↓</div>

					<div className="phase" data-phase="review">
						<h3>Review</h3>
						<div className="agents">
							{stage.reviewAgents.map((a) => (
								<button
									key={a}
									type="button"
									className="agent clickable"
									onClick={() => setModal({ kind: "reviewAgent", stageKey: lower, agentName: a })}
								>
									{a}
								</button>
							))}
						</div>
						<div className="agents-caption" style={{ marginTop: 8, textAlign: "left", display: "flex", alignItems: "center", gap: 6 }}>
							{callPill(stage, idx, mStage, "review-to-gate", {}, "mini")}
							all agents approve → <code>advance_phase</code> to gate
						</div>
					</div>

					<div className="phase-arrow">↓</div>

					<div className="phase" data-phase="fix-loop" style={{ borderLeft: "3px solid #f59e0b" }}>
						<h3>
							Fix-loop{" "}
							<span style={{ fontSize: 10, color: "var(--muted)", fontWeight: "normal" }}>
								(when review surfaces open feedback)
							</span>
						</h3>
						{(() => {
							const fixHats = (studioContent?.stages?.[lower]?.frontmatter?.fix_hats as string[] | undefined) ?? []
							if (!fixHats.length) {
								return (
									<div
										className="agents-caption"
										style={{ textAlign: "left", fontSize: 11, lineHeight: 1.5, marginBottom: 6 }}
									>
										<strong>No <code>fix_hats:</code> declared on STAGE.md</strong> — the gate falls
										back to the legacy <code>feedback_revisit</code> action, which rolls the entire
										stage back to elaborate (vs. running an in-place fix chain per-finding).
									</div>
								)
							}
							return (
								<div className="elab-step" style={{ marginTop: 0 }}>
									<div className="step-label">fix_hats sequence (per finding · serial)</div>
									<div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
										{fixHats.map((h, i) => (
											<Fragment key={h}>
												<button
													type="button"
													className="hat clickable"
													style={{ width: "auto", height: "auto", padding: "4px 10px", fontSize: 10 }}
													onClick={() => setModal({ kind: "hat", stageKey: lower, hatName: h })}
												>
													{h}
												</button>
												{i < fixHats.length - 1 ? (
													<span style={{ color: "var(--muted)", fontSize: 12 }}>→</span>
												) : null}
											</Fragment>
										))}
									</div>
								</div>
							)
						})()}
						<div
							className="agents-caption"
							style={{ textAlign: "left", fontSize: 11, lineHeight: 1.5, marginTop: 8 }}
						>
							Dispatched directly against the FB file via <code>review_fix</code>.{" "}
							<strong>FB-as-unit:</strong> fixers edit the FB body; the flagged unit stays read-only.
							The chain progresses via <code>haiku_feedback_advance_hat</code>; the workflow engine
							auto-closes the FB on the last hat's advance.
						</div>
						<div
							style={{
								marginTop: 8,
								display: "grid",
								gridTemplateColumns: "1fr 1fr",
								gap: 6,
								fontSize: 10,
								lineHeight: 1.4,
							}}
						>
							<div
								style={{
									padding: "5px 8px",
									background: "#fef2f2",
									border: "1px solid var(--reject)",
									borderRadius: 6,
									color: "#7c2d12",
								}}
							>
								<strong>↗ escalate</strong> · per-finding cap{" "}
								<code>MAX_FIX_LOOP_BOLTS = 3</code>; if the chain can't close the FB after 3 bolts
								the orchestrator returns <code>action: escalate</code> with{" "}
								<code>reason: fix_loop_cap_exceeded</code> and the human triages.
							</div>
							<div
								style={{
									padding: "5px 8px",
									background: "#eff6ff",
									border: "1px solid #2563eb",
									borderRadius: 6,
									color: "#1e3a8a",
								}}
							>
								<strong>↗ integrate_fix_chains</strong> · when a fix-chain worktree's merge back
								into the stage branch hits conflicts, the gate dispatches an{" "}
								<strong>integrator</strong> subagent per chain (max{" "}
								<code>MAX_INTEGRATOR_ATTEMPTS = 3</code>; exhaustion escalates).
							</div>
						</div>
					</div>

					{stage.outputs.length > 0 ? (
						<div className="artifacts-block">
							<div className="artifacts-label">outputs → pool</div>
							<div className="artifacts out">
								{stage.outputs.map((o) => {
									const key = `${lower}.${o}`
									return (
										<button
											key={o}
											type="button"
											className={`artifact${isArtifactMatch(key) ? " match" : ""}`}
											data-artifact={key}
											onMouseEnter={() => matchArtifact(key, key)}
											onMouseLeave={() => matchArtifact(null, null)}
											onClick={() => setModal({ kind: "artifact", artifactKey: key })}
											title={key}
										>
											{o}
										</button>
									)
								})}
							</div>
						</div>
					) : null}
				</section>

				{renderGateColumn(stage, idx, mStage, isAutoGate)}

				{mStage === "discrete" && idx < stages.length - 1 ? (
					<div className="paused-chip">
						<div className="paused-chip-body">
							<div className="paused-icon">⏸</div>
							<div>paused</div>
							<button
								type="button"
								className="call-chip"
								style={{ fontSize: 9, padding: "2px 8px" }}
								onClick={() => setModal({ kind: "skill", skillName: "/haiku:pickup" })}
							>
								/haiku:pickup
							</button>
							<div>resumes next stage</div>
						</div>
					</div>
				) : null}
			</Fragment>
		)
	}

	const renderGateColumn = (
		stage: DerivedStage,
		idx: number,
		mStage: ExecutionMode,
		isAutoGate: boolean,
	) => {
		const isLast = idx === stages.length - 1
		const nextStageName = !isLast ? stages[idx + 1]?.name ?? null : null
		const stageGate = effectiveGate(stage, mStage)
		const p = payloadFor(stage, idx, mStage, "gate-to-next-stage", { isLast, nextStageName })
		const onPillClick = () => {
			if (!p) return
			setModal({
				kind: "payload",
				payload: { stage: stage.name, key: "gate-to-next-stage", ...p },
			})
		}
		return (
			<aside className={`gate${isAutoGate ? " gate-auto" : ""}`}>
				<div className="gate-wrap" style={{ paddingLeft: 0, marginTop: 22 }}>
					<button
						type="button"
						className="call-chip gate-pill"
						onClick={onPillClick}
						title={p ? `${p.action} — ${p.summary}` : ""}
					>
						haiku_run_next
					</button>
					{isAutoGate ? (
						<div className="gate-body gate-auto-body">
							<div className="gate-auto-label">⚡ auto</div>
							<div className="gate-auto-sub">
								no review — workflow engine advances{isLast ? " · intent_complete" : <> to <strong>{nextStageName}</strong></>}
							</div>
						</div>
					) : (
						<div className="gate-body">
							<div className="gate-label">gate</div>
						<div className="gate-type">{stageGate.type}</div>
						<ul className="gate-options">
							{stageGate.options.map((o) => {
								if (o === "external") {
									return (
										<li key={o} className="external">
											<div className="ext-head">
												<span className="team-icon">👥</span>
												<span>external<br />(team / human PR review)</span>
											</div>
											<div className="branch-name">
									{branchName(stage.name.toLowerCase(), mStage === "hybrid" ? "continuous" : mStage)}
								</div>
											<div className="ext-outcomes">
												<span style={{ color: "var(--approve)" }}>→ next</span>
												<span style={{ color: "var(--reject)" }}>↺ back</span>
											</div>
										</li>
									)
								}
								return (
									<li key={o} className={gateClass(o)}>
										{o}
									</li>
								)
							})}
						</ul>
						{stageGate.options.includes("external") ? (
							<div
								style={{
									marginTop: 6,
									padding: "5px 7px",
									background: "#fff",
									border: "1px dashed var(--external)",
									borderRadius: 6,
									fontSize: 8,
									lineHeight: 1.4,
									color: "#92400e",
									fontFamily: "ui-monospace, 'SF Mono', monospace",
								}}
							>
								<div style={{ fontWeight: 700, marginBottom: 2 }}>external reconciliation:</div>
								<div>1. branch-merge detection → approved</div>
								<div>
									2. CLI provider probe (gh / glab / etc) → approved · changes_requested · pending
								</div>
								<div>
									3. otherwise →{" "}
									<code
										style={{
											background: "rgba(245,158,11,0.12)",
											padding: "0 2px",
											borderRadius: 2,
											color: "#92400e",
											border: "none",
										}}
									>
										awaiting_external_review
									</code>
								</div>
							</div>
						) : null}
					</div>
				)}
				</div>
			</aside>
		)
	}

	const renderPreIntentCard = () => (
		<section className="pre-intent-card">
			<header>
				<h2>Pre-intent</h2>
				<span className="intent-meta">
					user ↔ agent clarification → <code>intent.md</code>
				</span>
			</header>
			<div
				className="pre-content"
				style={{ display: "flex", flexDirection: "column", gap: 0, alignItems: "stretch" }}
			>
				<button
					type="button"
					className="pre-phase creation-summary"
					onClick={() => setModal({ kind: "intentCreation" })}
					style={{ cursor: "pointer", textAlign: "left", border: "1.5px solid #e4a72b", background: "#fff" }}
				>
					<h3>
						<span>Intent creation</span>
						<span className="cs-skill-chip">/haiku:start</span>
						<span className="open-modal-hint">expand ↗</span>
					</h3>
					<div className="cs-loop">
						<div className="cs-box cs-user">
							<div className="cs-box-head">
								<span className="cs-avatar">🧑</span> you
							</div>
							<div className="cs-box-sample">"i want to add billing to the app"</div>
						</div>
						<div className="cs-arrows" aria-hidden="true">
							<div className="cs-arrow-top">→</div>
							<div className="cs-arrow-label">≥ 3 turns</div>
							<div className="cs-arrow-bot">←</div>
						</div>
						<div className="cs-box cs-agent">
							<div className="cs-box-head">
								<span className="cs-avatar">🤖</span> agent
							</div>
							<div className="cs-box-sample">"what payment provider, plans, currency?"</div>
						</div>
					</div>
				</button>
				<div className="phase-arrow">↓</div>
				<div className="gate-wrap" style={{ paddingLeft: 0, marginTop: 22 }}>
					{(() => {
						const stub = stages[0]
						const p = stub ? payloadFor(stub, 0, "continuous", "preelab-to-stage1") : null
						return (
							<>
								<button
									type="button"
									className="call-chip gate-pill"
									onClick={() => {
										if (!p || !stub) return
										setModal({
											kind: "payload",
											payload: { stage: stub.name, key: "preelab-to-stage1", ...p },
										})
									}}
									title={p ? `${p.action} — ${p.summary}` : ""}
								>
									haiku_run_next
								</button>
								<div
									className="nested-gate"
									style={{
										borderColor: "#e4a72b",
										background: "#fff",
									}}
								>
									<div className="ng-head">
										<span className="ng-caption" style={{ color: "#92400e" }}>
											↳ inside this call · opens <code>intent_review</code> gate (blocking)
										</span>
										<span className="ig-type" style={{ color: "#92400e" }}>ask</span>
										<span className="ig-ctx">first-tick gate</span>
									</div>
									<div className="ng-branch-row">
										<span className="ng-branch reject-branch">↑ request changes → loop creation</span>
										<span className="ng-branch approve-branch">↓ approve → start_stage</span>
									</div>
									<div
										style={{
											marginTop: 6,
											fontSize: 10,
											color: "#92400e",
											lineHeight: 1.45,
										}}
									>
										The user's click <strong>is</strong> the outcome of the{" "}
										<code>haiku_run_next</code> call. On approve: state.json created,{" "}
										<code>phase: elaborate</code> set on the first stage.
									</div>
								</div>
							</>
						)
					})()}
				</div>
			</div>
		</section>
	)

	const renderPostIntentCard = () => (
		<section className="post-intent-card">
			<header>
				<h2>Post-intent</h2>
				<span className="intent-meta">final gate → delivery · operations</span>
			</header>
			<div className="post-grid">
				<section className="post-intent" id="intent-completion-review" style={{ borderLeft: "3px solid #a855f7" }}>
					<header>
						<h2>
							Intent-completion review{" "}
							<span style={{ fontSize: 10, fontWeight: 500, color: "var(--muted)", marginLeft: 6, letterSpacing: 0, textTransform: "none" }}>
								· studio-level · default ON
							</span>
						</h2>
						<span className="subtitle-line">
							all stages approved → studio review-agents audit the whole intent → optional fix
							loop → final gate
						</span>
					</header>
					<div className="post-steps">
						<div className="post-step">
							<div className="step-title">📋 dispatch review-agents</div>
							<div className="step-desc">
								workflow runs <code>plugin/studios/{"{studio}"}/review-agents/*.md</code>{" "}
								against the whole intent. Skipped when no studio review-agents are configured —
								<code> completion_review_skipped: true</code> is set on the intent and the gate
								falls through immediately.
							</div>
						</div>
						<div className="step-arrow">→</div>
						<div className="post-step">
							<div className="step-title">🔁 studio fix loop</div>
							<div className="step-desc">
								if findings exist, dispatch <code>plugin/studios/{"{studio}"}/fix-hats/*.md</code>{" "}
								against intent-scope FBs. Caps mirror the per-stage chain (3 bolts;{" "}
								<code>integrate_fix_chains</code> on merge conflicts).
							</div>
						</div>
						<div className="step-arrow">→</div>
						<div className="post-step">
							<div className="step-title">✅ ready for final gate</div>
							<div className="step-desc">zero open intent-scope findings → falls through to delivery.</div>
						</div>
					</div>
					<div
						style={{
							marginTop: 4,
							padding: "6px 8px",
							background: "#fff",
							border: "1px dashed #a855f7",
							borderRadius: 6,
							fontSize: 10,
							lineHeight: 1.45,
							color: "#581c87",
						}}
					>
						<strong>Opt out per intent:</strong> set{" "}
						<code>intent_completion_review: false</code> on intent.md frontmatter to skip this
						entire layer — the final stage's gate becomes terminal.
					</div>
				</section>
				<section className="post-intent" id="delivery">
					<header>
						<h2>
							Delivery{" "}
							<span style={{ fontSize: 10, fontWeight: 500, color: "var(--muted)", marginLeft: 6, letterSpacing: 0, textTransform: "none" }}>
								· handled by your CI/CD infra, not H·AI·K·U
							</span>
						</h2>
						<span className="subtitle-line">final gate → merged → main → prod</span>
					</header>
					<div className="post-steps">
						<div className="post-step gate-step">
							<div className="step-title">🔍 final gate (PR/MR)</div>
							<div className="step-desc">last stage's approve routes here.</div>
						</div>
						<div className="step-arrow">→</div>
						<div className="post-step">
							<div className="step-title">🚀 merge</div>
							<div className="step-desc">into <code>main</code></div>
						</div>
						<div className="step-arrow">→</div>
						<div className="post-step">
							<div className="step-title">🧪 CI</div>
							<div className="step-desc">build · lint · tests</div>
						</div>
						<div className="step-arrow">→</div>
						<div className="post-step">
							<div className="step-title">📦 release</div>
							<div className="step-desc">tag · changelog · artifact</div>
						</div>
						<div className="step-arrow">→</div>
						<div className="post-step">
							<div className="step-title">🌐 deploy</div>
							<div className="step-desc">promote to prod</div>
						</div>
					</div>
				</section>
			</div>
		</section>
	)

	const renderModal = (m: ModalKind) => {
		switch (m.kind) {
			case "actor": {
				const a = ACTORS[m.actorKey]
				if (!a) return null
				return (
					<Modal open title={`${a.icon} ${a.name}`} subtitle="actor · runtime player" onClose={closeModal}>
						<div className="modal-section">
							<h3>role</h3>
							<HtmlBlock className="prose" html={renderInline(a.role)} />
						</div>
						<div className="modal-section">
							<h3>talks to</h3>
							<ul>
								{a.talks_to.map((t) => (
									<li key={t}>
										<HtmlBlock html={renderInline(t)} />
									</li>
								))}
							</ul>
						</div>
						<div className="modal-section">
							<h3>owns</h3>
							<ul>
								{a.owns.map((o) => (
									<li key={o}>
										<HtmlBlock html={renderInline(o)} />
									</li>
								))}
							</ul>
						</div>
						<div className="modal-section">
							<h3>notes</h3>
							<HtmlBlock className="md-content" html={renderMarkdown(a.notes)} />
						</div>
					</Modal>
				)
			}
			case "hook": {
				const h = HOOK_BY_NAME[m.hookName]
				if (!h) return null
				return (
					<Modal open title={m.hookName} subtitle={`hook · ${h.group}`} onClose={closeModal}>
						<div className="modal-section">
							<h3>role</h3>
							<HtmlBlock className="prose" html={renderInline(h.desc)} />
						</div>
						<div className="modal-section">
							<h3>where it fires</h3>
							<ul>
								{h.fires.map((f) => (
									<li key={f}>
										<code>{f}</code>
									</li>
								))}
							</ul>
						</div>
						<div className="modal-section">
							<h3>file</h3>
							<div className="payload-block">{h.file}</div>
						</div>
					</Modal>
				)
			}
			case "payload": {
				const d = m.payload
				return (
					<Modal open title="haiku_run_next" subtitle={`${d.stage} · ${d.key}`} onClose={closeModal}>
						<div className="modal-section">
							<h3>action</h3>
							<div className="payload-block" style={{ fontWeight: 600, color: "#2563eb" }}>
								{d.action}
							</div>
						</div>
						<div className="modal-section">
							<h3>summary</h3>
							<HtmlBlock className="prose" html={renderInline(d.summary)} />
						</div>
						<div className="modal-section">
							<h3>payload returned to agent</h3>
							<div className="payload-block">{JSON.stringify(d.payload, null, 2)}</div>
						</div>
						<div className="modal-section">
							<h3>orchestrator validations</h3>
							<ul>
								{d.validations.map((v) => (
									<li key={v}>
										<HtmlBlock html={renderInline(v)} />
									</li>
								))}
							</ul>
						</div>
						{d.writes && d.writes.length ? (
							<div className="modal-section">
								<h3>state writes (workflow engine persists to disk)</h3>
								<ul className="writes-list">
									{d.writes.map((w) => (
										<li key={w.path + w.change}>
											<code className="write-path">{w.path}</code>
											<HtmlBlock className="write-change" html={renderInline(w.change)} />
										</li>
									))}
								</ul>
							</div>
						) : null}
						{d.injection && d.injection.length ? (
							<div className="modal-section">
								<h3>how the result reaches the agent</h3>
								<ul className="writes-list">
									{d.injection.map((i) => (
										<li key={i.hook + i.target} style={{ borderLeftColor: "#2563eb" }}>
											<code className="write-path" style={{ color: "#1e3a8a" }}>{i.hook}</code>
											<HtmlBlock
												className="write-change"
												html={`→ <strong>${renderInline(i.target)}</strong>`}
											/>
											<HtmlBlock className="write-change" style={{ marginTop: 2 }} html={renderInline(i.what)} />
										</li>
									))}
								</ul>
							</div>
						) : null}
						<div className="modal-section">
							<h3>instructions</h3>
							<HtmlBlock className="prose" html={renderInline(d.instructions)} />
						</div>
					</Modal>
				)
			}
			case "stageMd": {
				const s = studioContent?.stages?.[m.stageKey]
				if (!s) return null
				return (
					<Modal
						open
						title={`${m.stageKey.toUpperCase()} · STAGE.md`}
						subtitle={s.stagePath}
						onClose={closeModal}
					>
						<HtmlBlock className="md-content" html={renderMdFile({ frontmatter: s.frontmatter, content: s.stageMd })} />
					</Modal>
				)
			}
			case "hat": {
				const file = studioContent?.stages?.[m.stageKey]?.hats?.[m.hatName]
				if (!file) return null
				return (
					<Modal open title={`${m.hatName} · hat`} subtitle={file.path} onClose={closeModal}>
						<HtmlBlock className="md-content" html={renderMdFile(file)} />
					</Modal>
				)
			}
			case "reviewAgent": {
				const file = studioContent?.stages?.[m.stageKey]?.reviewAgents?.[m.agentName]
				if (!file) return null
				return (
					<Modal open title={`${m.agentName} · review agent`} subtitle={file.path} onClose={closeModal}>
						<HtmlBlock className="md-content" html={renderMdFile(file)} />
					</Modal>
				)
			}
			case "subagent": {
				return (
					<Modal
						open
						title={`↗ ${m.hatName} runs in a subagent`}
						subtitle={`${m.stageKey} · subagent-context`}
						onClose={closeModal}
					>
						<div className="modal-section">
							<h3>what this means</h3>
							<HtmlBlock
								className="prose"
								html={renderInline(
									`Every hat — including \`${m.hatName}\` — runs inside its own Claude Code subagent. The orchestrator's pattern at execute time is "one subagent per unit per hat."`,
								)}
							/>
						</div>
						<div className="modal-section">
							<h3>tools the subagent uses</h3>
							<ul>
								<li><code>haiku_unit_start</code></li>
								<li><code>haiku_unit_advance_hat</code></li>
								<li><code>haiku_unit_reject_hat</code></li>
								<li><code>haiku_unit_increment_bolt</code></li>
							</ul>
						</div>
					</Modal>
				)
			}
			case "schema":
				return (
					<Modal open title={m.schemaKey} subtitle="schema reference" onClose={closeModal}>
						<HtmlBlock
							className="prose"
							html={renderInline(
								`See \`packages/haiku/src/state-tools.ts\` for the canonical type definitions of \`${m.schemaKey}\`.`,
							)}
						/>
					</Modal>
				)
			case "validation":
				return (
					<Modal
						open
						title={`✓ ${m.validationKey}`}
						subtitle="elaborate-phase validation gate"
						onClose={closeModal}
					>
						<HtmlBlock
							className="prose"
							html={renderInline(
								`Validation check enforced by \`packages/haiku/src/orchestrator/workflow/handlers/elaborate.ts\` and \`validators.ts\`. See repo for the full rule set.`,
							)}
						/>
					</Modal>
				)
			case "revisit": {
				const prev = m.stageIdx > 0 ? stages[m.stageIdx - 1]?.name ?? null : null
				const stageName = stages[m.stageIdx]?.name ?? m.stageKey
				return (
					<Modal open title="↺ /haiku:revisit" subtitle={`${stageName} · go-back semantics`} onClose={closeModal}>
						<div className="modal-section">
							<h3>summary</h3>
							<HtmlBlock
								className="prose"
								html={renderInline(
									"Bounces the workflow engine backwards to re-elaborate work that's already been done. Clears the target stage's `gate_outcome` and re-enters its `elaborate` phase.",
								)}
							/>
						</div>
						{prev ? (
							<div className="modal-section">
								<h3>cross-stage variant</h3>
								<HtmlBlock
									className="prose"
									html={renderInline(`From **${stageName}**'s elaborate → bounces back to **${prev}**'s elaborate.`)}
								/>
							</div>
						) : null}
					</Modal>
				)
			}
			case "gateDetail":
				return (
					<Modal
						open
						title={m.detailKey}
						subtitle="nested gate inside haiku_run_next"
						onClose={closeModal}
					>
						<HtmlBlock
							className="prose"
							html={renderInline(
								m.detailKey === "specs_gate_review"
									? "The post-elaboration review gate. Runs **inside the same** `haiku_run_next` call. After 2026-04-27, reject does not re-pop the UI: open feedback routes through `feedback_dispatch` (human, no resolution) or `review_fix` (inline-fix) until every FB closes."
									: "Hard quality gates — tests, lint, typecheck — run inside the same `haiku_run_next` call that transitions execute → review. Loop iterates within review; never goes back to execute.",
							)}
						/>
					</Modal>
				)
			case "tool":
				return (
					<Modal open title={m.toolName} subtitle={`mcp tool · ${m.contextKey ?? ""}`} onClose={closeModal}>
						<HtmlBlock
							className="prose"
							html={renderInline(
								`See \`packages/haiku/src/orchestrator.ts\` and \`state-tools.ts\` for the full schema of \`${m.toolName}\`.`,
							)}
						/>
					</Modal>
				)
			case "skill":
				return (
					<Modal open title={m.skillName} subtitle="skill" onClose={closeModal}>
						<HtmlBlock
							className="prose"
							html={renderInline(
								`See \`plugin/skills/${m.skillName.replace(/^\/haiku:/, "")}/SKILL.md\` for the full skill mandate.`,
							)}
						/>
					</Modal>
				)
			case "aux": {
				const file = studioContent?.[m.auxKind]?.[m.name]
				if (!file) return null
				return (
					<Modal
						open
						title={`${m.auxKind.replace(/s$/, "")} · ${m.name}`}
						subtitle={file.path}
						onClose={closeModal}
					>
						<HtmlBlock className="md-content" html={renderMdFile(file)} />
					</Modal>
				)
			}
			case "unit":
				return (
					<Modal open title={m.unitId} subtitle={`${m.stageName} · unit detail`} onClose={closeModal}>
						<HtmlBlock
							className="prose"
							html={renderInline(
								`Demo unit \`${m.unitId}\` (model: \`${m.model}\`). In a real intent, units live at \`.haiku/intents/{slug}/stages/${m.stageName.toLowerCase()}/units/\`.`,
							)}
						/>
					</Modal>
				)
			case "artifact": {
				const [stageKey, slug] = m.artifactKey.split(".")
				const def =
					stageKey && slug
						? (studioContent?.stages?.[stageKey]?.discoveryDefs?.[slug] ??
							studioContent?.stages?.[stageKey]?.outputDefs?.[slug] ??
							null)
						: null
				if (!def) {
					return (
						<Modal open title={m.artifactKey} subtitle="no template defined" onClose={closeModal}>
							<HtmlBlock
								className="prose"
								html={renderInline(
									`No \`discovery/\` or \`outputs/\` template was found in the studio for \`${m.artifactKey}\`. The artifact still flows through the pool — it's just not formally specified by the studio.`,
								)}
							/>
						</Modal>
					)
				}
				return (
					<Modal open title={m.artifactKey} subtitle={def.path} onClose={closeModal}>
						<HtmlBlock className="md-content" html={renderMdFile(def)} />
					</Modal>
				)
			}
			case "intentCreation":
				return (
					<Modal open title="Intent creation" subtitle="user ↔ agent · /haiku:start" onClose={closeModal}>
						<HtmlBlock
							className="prose"
							html={renderInline(
								"User and agent exchange Q&A until the agent has enough to draft `intent.md`. The agent calls `haiku_select_studio` (default inferred from prompt), then `haiku_intent_create`, then `haiku_run_next` to enter the first stage's elaborate phase.",
							)}
						/>
					</Modal>
				)
			case "preTickTriage":
				return (
					<Modal
						open
						title="⛓ pre-tick triage gate"
						subtitle="run-tick.ts · interceptor · runs BEFORE every per-state handler"
						onClose={closeModal}
					>
						<div className="modal-section">
							<h3>where it sits</h3>
							<HtmlBlock
								className="prose"
								html={renderInline(
									"Implemented in `packages/haiku/src/orchestrator/workflow/run-tick.ts` (`preTickFeedbackGate`). On every `haiku_run_next` tick — after structural repair (`preTickConsistency`) and tamper detection (`verifyIntentState`) but BEFORE the per-state handler — the gate walks stages 0..current plus intent-scope for open (non-terminal) feedback. The point: misplaced or untriaged feedback can't be force-fixed by the wrong stage's hats, and a stage handler can't re-pop the review UI while feedback is still unaddressed.",
								)}
							/>
						</div>
						<div className="modal-section">
							<h3>three priority outcomes</h3>
							<ul className="writes-list">
								<li>
									<HtmlBlock
										className="prose"
										html={renderInline(
											"**1. Untriaged FB found** — any open FB lacking `triaged_at:` → emit `feedback_triage`. Agent calls `haiku_feedback_move` (same-stage no-op confirms in place; cross-stage relocates the file to the correct stage's `feedback/` dir).",
										)}
									/>
								</li>
								<li>
									<HtmlBlock
										className="prose"
										html={renderInline(
											"**2. Triaged but on an earlier stage** — every open FB has `triaged_at:` but ≥ 1 sits on a stage earlier than `active_stage` → emit `revisited` targeting the earliest such stage. The existing revisit machinery handles branch state, downstream invalidation, and re-entry.",
										)}
									/>
								</li>
								<li>
									<HtmlBlock
										className="prose"
										html={renderInline(
											"**3. Triaged and in-scope (or no open FB)** — fall through to the per-state handler. The stage gate then routes pending feedback through `feedback_dispatch` (human comments without resolution) or the worktree-based `review_fix` chain (inline-fix items).",
										)}
									/>
								</li>
							</ul>
						</div>
						<div className="modal-section">
							<h3>why it exists</h3>
							<HtmlBlock
								className="prose"
								html={renderInline(
									"Before this gate, the per-stage handler could see open feedback on a downstream stage and dispatch it to its own `fix_hats` — wrong stage, wrong hats, wrong fix. It could also re-emit `gate_review` even when the user had left feedback that was never addressed (the loop fixed on 2026-04-27). Centralizing the triage check ensures every tick passes through the same chokepoint.",
								)}
							/>
						</div>
						<div className="modal-section">
							<h3>frontmatter convention</h3>
							<HtmlBlock
								className="prose"
								html={renderInline(
									"Agent-authored FBs (`origin: agent`, `adversarial-review`, `studio-review`, etc.) auto-stamp `triaged_at:` at creation time — they're filed in-context. Human origins (`user-chat`, `user-visual`, `user-question`) leave `triaged_at: null`, which is what triggers outcome 1 above.",
								)}
							/>
						</div>
					</Modal>
				)
		}
	}

	if (!bundle || !studioContent) {
		return (
			<div style={{ padding: "24px", color: "#6b7280", fontFamily: "ui-monospace, 'SF Mono', monospace", fontSize: "12px" }}>
				Loading studio content…
			</div>
		)
	}

	return (
		<div ref={mainRef} className="haiku-arch-map">
			<h1>H·AI·K·U Runtime Architecture</h1>
			<p className="subtitle">
				Every actor, every workflow engine tick, every state write — the studio's full intent
				lifecycle on one page. <strong>Hover anything for a tooltip · click for full detail.</strong>
			</p>

			{renderActorsStrip()}

			<div className="controls">
				<label htmlFor="studio-picker">Studio</label>
				<select
					id="studio-picker"
					value={activeStudio}
					onChange={(e) => {
						const next = e.target.value
						if (next === activeStudio) return
						router.push(`/studios/${next}/architecture/`)
					}}
				>
					{studioOptions.map((g) => (
						<optgroup key={g.category} label={g.category}>
							{g.items.map((s) => (
								<option key={s.dir} value={s.dir}>
									{s.dir} ({s.stageCount})
								</option>
							))}
						</optgroup>
					))}
				</select>
				<label htmlFor="mode-continuous">Execution mode</label>
				<div className="mode-group">
					{(["continuous", "discrete", "hybrid", "auto"] as const).map((m) => (
						<Fragment key={m}>
							<input
								type="radio"
								name="mode"
								id={`mode-${m}`}
								value={m}
								checked={mode === m}
								onChange={() => setMode(m)}
							/>
							<label htmlFor={`mode-${m}`}>{m === "auto" ? "autopilot" : m}</label>
						</Fragment>
					))}
				</div>
				{mode === "hybrid" ? (
					<span className="hybrid-picker">
						continuous_from:
						<select value={continuousFrom} onChange={(e) => setContinuousFrom(e.target.value)}>
							{stages.slice(1).map((s) => (
								<option key={s.key} value={s.name.toLowerCase()}>
									{s.name.toLowerCase()}
								</option>
							))}
						</select>
					</span>
				) : null}
			</div>

			<div className="page">
				<main className="main">
					<div className="card-stack">
						{renderPreIntentCard()}
						<div className="v-arrow" />
						<div className="intent-card">
							<header>
								<h2>Intent</h2>
								<span className="intent-meta">
									<code>.haiku/intents/{"{slug}"}/intent.md</code> · studio:{" "}
									<code>{activeStudio}</code>
								</span>
							</header>
							<div className="studio">{stages.map((s, i) => renderStage(s, i))}</div>
						</div>
						<div className="v-arrow approve-flow">
							<span className="label">approve → delivery</span>
							<span className="tip" />
						</div>
						{renderPostIntentCard()}
					</div>
				</main>
			</div>

			{modal ? renderModal(modal) : null}
		</div>
	)
}

function effectiveGate(stage: DerivedStage, mStage: ExecutionMode): { type: string; options: string[] } {
	if (mStage === "discrete") return { type: "external (discrete)", options: ["external"] }
	if (mStage === "auto") return { type: "auto (autopilot · /haiku:autopilot)", options: ["advance"] }
	return stage.gate
}

function renderMdFile(file: { frontmatter?: Record<string, unknown>; content?: string | null; body?: string }): string {
	const fm = file.frontmatter ?? {}
	const fmEntries = Object.entries(fm).filter(([, v]) => v !== undefined && v !== null && v !== "")
	const fmHtml = fmEntries.length
		? `<div class="fm-panel">${fmEntries
				.map(
					([k, v]) =>
						`<div class="fm-row"><span class="fm-key">${escHTML(k)}</span><span class="fm-val">${renderInline(
							typeof v === "string" ? v : JSON.stringify(v),
						)}</span></div>`,
				)
				.join("")}</div>`
		: ""
	const body = file.body ?? stripFrontmatter(file.content ?? "")
	return `${fmHtml}<div class="md-content">${renderMarkdown(body)}</div>`
}

function stripFrontmatter(src: string): string {
	if (!src) return ""
	const m = /^---\n[\s\S]*?\n---\n?/.exec(src)
	return m ? src.slice(m[0].length) : src
}

// HtmlBlock and renderInline / renderMarkdown re-imported above for the modals.
type _UnusedWatch = StudioContentFile
