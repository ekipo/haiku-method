// app/_home-helpers/index.tsx — Layout + presentational primitives used
// throughout HomeContent.tsx.
//
// These were inline at the bottom of HomeContent.tsx (lines 2174–2388)
// before this extraction. They're pure presentational components — no
// state, no router knowledge — so the move is safe (the JSX is
// identical to what HomeContent rendered before).
//
// Underscore-prefixed dir name keeps Next.js from picking it up as a
// route. Imported from HomeContent.tsx as
// `from "./_home-helpers"`.

import { motion } from "framer-motion"
import { HatArrow, HatCard } from "../components/guide"

// Local copy of the fade-in spec from HomeContent.tsx so this module
// is self-contained.
const fadeIn = {
	initial: { opacity: 0, y: 20 },
	whileInView: { opacity: 1, y: 0 },
	viewport: { once: true, margin: "-40px" as const },
	transition: { duration: 0.5 },
}

export function Section({
	id,
	children,
}: { id: string; children: React.ReactNode }) {
	return (
		<section
			id={id}
			className="border-t border-gray-200 px-4 py-16 sm:py-20 dark:border-gray-800"
		>
			{children}
		</section>
	)
}

export function Container({ children }: { children: React.ReactNode }) {
	return <div className="mx-auto max-w-4xl">{children}</div>
}

export function Wide({ children }: { children: React.ReactNode }) {
	return <div className="mx-auto max-w-5xl">{children}</div>
}

export function Legend({ color, label }: { color: string; label: string }) {
	return (
		<div className="flex items-center gap-2">
			<span className={`inline-block h-3 w-3 rounded-full ${color}`} />
			<span className="text-xs text-gray-500 dark:text-gray-400">{label}</span>
		</div>
	)
}

export function CastList({ items }: { items: React.ReactNode[] }) {
	return (
		<ul className="mt-2 space-y-1 text-xs text-gray-500 dark:text-gray-400">
			{items.map((item, i) => (
				<li
					key={typeof item === "string" ? item : `item-${i}`}
					className="flex gap-1.5"
				>
					<span className="text-gray-400">&bull;</span>
					<span>{item}</span>
				</li>
			))}
		</ul>
	)
}

export function WorkflowGroup({
	name,
	badge,
	bgClass,
	labelColor,
	borderColor,
	hats,
}: {
	name: string
	badge: string
	bgClass: string
	labelColor: string
	borderColor: string
	hats: { icon: string; name: string; desc: string }[]
}) {
	return (
		<motion.div {...fadeIn} className={`mb-8 rounded-xl p-5 ${bgClass}`}>
			<div
				className={`mb-3.5 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider ${labelColor}`}
			>
				{name}
				<span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[0.65rem] font-semibold normal-case tracking-normal">
					{badge}
				</span>
			</div>
			<div className="flex flex-wrap items-stretch gap-3 max-sm:flex-col">
				{hats.map((hat, i) => (
					<div
						key={`${hat.name}-${hat.desc.slice(0, 20)}`}
						className="contents"
					>
						{i > 0 && <HatArrow />}
						<HatCard
							icon={hat.icon}
							name={hat.name}
							description={hat.desc}
							borderColor={`border-l-[3px] ${borderColor}`}
						/>
					</div>
				))}
			</div>
		</motion.div>
	)
}

export function PhaseSummary({
	icon,
	label,
	labelColor,
	desc,
}: {
	icon: string
	label: string
	labelColor: string
	desc: string
}) {
	return (
		<div className="text-center">
			<div className="mb-1.5 text-xl">{icon}</div>
			<div className="text-xs text-gray-500 dark:text-gray-400">
				<strong className={labelColor}>{label}</strong> {desc}
			</div>
		</div>
	)
}

export function ShortcutPill({
	cmd,
	desc,
}: { cmd: string; desc: string }) {
	return (
		<div className="flex items-center gap-2 rounded-full border border-gray-200 bg-white px-5 py-2.5 dark:border-gray-700 dark:bg-gray-900">
			<code className="text-sm font-bold text-amber-500">{cmd}</code>
			<span className="text-xs text-gray-500 dark:text-gray-400">{desc}</span>
		</div>
	)
}

export function WorkflowPill({
	name,
	flow,
	recommended,
}: {
	name: string
	flow: string
	recommended?: boolean
}) {
	return (
		<div
			className={`flex flex-wrap items-center gap-2.5 rounded-lg border px-3.5 py-2 text-sm ${
				recommended
					? "border-green-300 bg-green-50/50 dark:border-green-700 dark:bg-green-950/10"
					: "border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900"
			}`}
		>
			<span className="font-semibold text-gray-800 dark:text-gray-200">
				{name}
			</span>
			<span className="text-xs text-gray-500 dark:text-gray-400">{flow}</span>
			{recommended && (
				<span className="ml-auto rounded-lg bg-green-100 px-2 py-0.5 text-[0.65rem] font-semibold text-green-500 dark:bg-green-900/30">
					recommended
				</span>
			)}
		</div>
	)
}

export function DagUnit({
	id,
	name,
	deps,
}: {
	id: string
	name: string
	deps: string
}) {
	return (
		<div className="flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 bg-white p-2.5 dark:border-gray-700 dark:bg-gray-950">
			<span className="min-w-[60px] text-sm font-bold text-amber-500">
				{id}
			</span>
			<span className="flex-1 text-sm text-gray-800 dark:text-gray-200">
				{name}
			</span>
			<span className="text-xs text-gray-500 dark:text-gray-400">{deps}</span>
		</div>
	)
}

export function DagArrow() {
	return <div className="ml-7 h-3 w-0.5 bg-gray-300 dark:bg-gray-600" />
}

export function MiniCard({
	title,
	titleColor,
	desc,
}: {
	title: string
	titleColor: string
	desc: string
}) {
	return (
		<div className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-950">
			<div className={`mb-1 text-xs font-semibold ${titleColor}`}>{title}</div>
			<div className="text-xs text-gray-500 dark:text-gray-400">{desc}</div>
		</div>
	)
}

export function FinishStage({
	num,
	numColor,
	children,
}: {
	num: number
	numColor: string
	children: React.ReactNode
}) {
	return (
		<motion.div
			{...fadeIn}
			className="relative rounded-xl border border-gray-200 bg-white p-7 pl-20 dark:border-gray-700 dark:bg-gray-900 max-sm:pl-7 max-sm:pt-16"
		>
			<span
				className={`absolute left-6 top-7 flex h-10 w-10 items-center justify-center rounded-full text-lg font-extrabold ${numColor} max-sm:top-4`}
			>
				{num}
			</span>
			{children}
		</motion.div>
	)
}
