"use client"

import Link from "next/link"
import { ModeToggle } from "../components/guide"
import { Legend } from "../_home-helpers"

interface Props {
	mode: "story" | "reference"
	setMode: (mode: "story" | "reference") => void
}

export function Hero({ mode, setMode }: Props) {
	return (
		<section
			id="hero"
			className="relative overflow-hidden px-4 py-24 text-center sm:py-32"
		>
			<div className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_50%_0%,rgba(59,130,246,0.08),transparent_60%)]" />
			<div className="mx-auto max-w-4xl">
				<div className="mb-6 inline-block rounded-full border border-gray-200 bg-gray-50 px-4 py-1.5 text-xs font-semibold text-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
					By GigSmart
				</div>
				<h1 className="mb-4 bg-gradient-to-r from-blue-500 to-amber-400 bg-clip-text text-4xl font-extrabold tracking-tight text-transparent sm:text-5xl lg:text-6xl">
					H·AI·K·U: How It Works
				</h1>
				<p className="mx-auto mb-8 max-w-xl text-lg text-gray-500 dark:text-gray-400">
					Lifecycle orchestration &mdash; from idea to production.
				</p>

				<ModeToggle mode={mode} onChange={setMode} />

				{/* Color legend */}
				<div className="mx-auto mt-7 flex max-w-2xl flex-wrap justify-center gap-5">
					<Legend color="bg-blue-500" label="Blue = Human actions" />
					<Legend color="bg-amber-400" label="Gold = AI actions" />
					<Legend
						color="bg-gray-500 dark:bg-gray-600"
						label="Gray = System / automated"
					/>
					<Legend
						color="bg-violet-500"
						label="Purple = Deep Dive (reference)"
					/>
				</div>

				<p className="mt-4 text-xs text-gray-400 dark:text-gray-500">
					Scroll down. The story starts with the characters. Purple sections
					expand for deeper reference material.
				</p>

				{/* Install CTA */}
				<div className="mt-8 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
					<Link
						href="/docs/installation/"
						className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-blue-600 to-amber-500 px-6 py-3 text-sm font-semibold text-white transition hover:opacity-90"
					>
						Install Plugin
						<svg
							className="h-4 w-4"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
							aria-hidden="true"
						>
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={2}
								d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
							/>
						</svg>
					</Link>
					<Link
						href="/paper/"
						className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-6 py-3 text-sm font-semibold transition hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900"
					>
						Read the Paper
					</Link>
				</div>
			</div>
		</section>
	)
}
