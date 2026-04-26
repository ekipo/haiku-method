"use client"

import { motion } from "framer-motion"
import { DeepDive, LifecycleFlow } from "../components/guide"
import {
	Container,
	PhaseSummary,
	Section,
	ShortcutPill,
} from "../_home-helpers"
import { fadeIn } from "./_shared"

interface Props {
	isRef: boolean
}

export function Act1({ isRef }: Props) {
	return (
		<Section id="act1">
			<Container>
				<motion.h2 {...fadeIn} className="mb-2 text-3xl font-bold">
					Act 1: The Big Picture
				</motion.h2>
				<motion.p
					{...fadeIn}
					className="mb-2 text-gray-500 dark:text-gray-400"
				>
					Every feature follows the same rhythm. Four steps. Then repeat.
				</motion.p>

				<LifecycleFlow />

				{/* Phase summaries */}
				<motion.div
					{...fadeIn}
					className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
				>
					<PhaseSummary
						icon="&#x1F4AC;"
						label="Plan:"
						labelColor="text-blue-500"
						desc="You describe what you want. The AI asks questions until it truly understands."
					/>
					<PhaseSummary
						icon="&#x1F528;"
						label="Build:"
						labelColor="text-amber-400"
						desc="The AI writes code, runs tests, and reviews its own work -- all autonomously."
					/>
					<PhaseSummary
						icon="&#x1F4E6;"
						label="Deliver:"
						labelColor="text-green-500"
						desc="The AI packages everything into a pull request. You review and approve."
					/>
					<PhaseSummary
						icon="&#x1F4A1;"
						label="Learn:"
						labelColor="text-violet-500"
						desc="The AI reflects on what went well and what to improve for next time."
					/>
				</motion.div>

				<motion.p
					{...fadeIn}
					className="mt-8 mb-4 text-center text-gray-500 dark:text-gray-400"
				>
					For cross-functional teams, <strong>passes</strong> let design,
					product, and dev each run this loop independently -- the output of
					one becomes the input to the next.
				</motion.p>

				<motion.p
					{...fadeIn}
					className="mt-4 mb-4 text-center text-gray-500 dark:text-gray-400"
				>
					Most features follow this full cycle. But there are shortcuts:
				</motion.p>

				<motion.div
					{...fadeIn}
					className="flex flex-col items-center gap-4 sm:flex-row sm:justify-center"
				>
					<ShortcutPill
						cmd="/haiku:quick"
						desc="Skip everything for tiny fixes -- typos, config changes, one-liners"
					/>
					<ShortcutPill
						cmd="/haiku:autopilot"
						desc="AI handles the whole cycle autonomously for well-understood features"
					/>
				</motion.div>

				{/* Deep Dive: Plugin Architecture */}
				<DeepDive
					title="Deep Dive: Plugin Architecture -- What's Inside the Box"
					forceOpen={isRef}
				>
					<p className="mb-3">
						H·AI·K·U is a Claude plugin with a well-organized file structure.
						Everything is self-contained.
					</p>
					<div className="rounded-lg border border-gray-200 bg-gray-50 p-4 font-mono text-xs leading-relaxed dark:border-gray-700 dark:bg-gray-950">
						<div>
							<span className="font-semibold text-blue-500">plugin/</span>
						</div>
						<div className="pl-5">
							<span className="font-semibold text-blue-500">
								.claude-plugin/
							</span>{" "}
							<span className="text-gray-400">-- Plugin manifest</span>
						</div>
						<div className="pl-5">
							<span className="font-semibold text-blue-500">studios/</span>{" "}
							<span className="text-gray-400">
								{"-- 120+ hat definitions in studios/*/stages/*/hats/"}
							</span>
						</div>
						<div className="pl-5">
							<span className="font-semibold text-blue-500">hooks/</span>{" "}
							<span className="text-gray-400">
								-- 10 lifecycle hooks (compiled TypeScript)
							</span>
						</div>
						<div className="pl-5">
							<span className="font-semibold text-blue-500">lib/</span>{" "}
							<span className="text-gray-400">
								-- 16 foundation libraries
							</span>
						</div>
						<div className="pl-5">
							<span className="font-semibold text-blue-500">providers/</span>{" "}
							<span className="text-gray-400">
								-- 4 external integration specs
							</span>
						</div>
						<div className="pl-5">
							<span className="font-semibold text-blue-500">schemas/</span>{" "}
							<span className="text-gray-400">
								-- JSON schemas for settings + providers
							</span>
						</div>
						<div className="pl-5">
							<span className="font-semibold text-blue-500">skills/</span>{" "}
							<span className="text-gray-400">-- 34 skill definitions</span>
						</div>
						<div className="pl-5">
							<span className="font-semibold text-blue-500">bin/</span>{" "}
							<span className="text-gray-400">-- Compiled haiku binary</span>
						</div>
					</div>
				</DeepDive>
			</Container>
		</Section>
	)
}
