"use client"

import { motion } from "framer-motion"
import {
	CriteriaCompare,
	InsightBox,
	SpecComparison,
} from "../components/guide"
import { Section, Wide } from "../_home-helpers"
import { fadeIn } from "./_shared"

export function Specs() {
	return (
		<Section id="specs">
			<Wide>
				<motion.h2 {...fadeIn} className="mb-2 text-3xl font-bold">
					Why Specs Matter
				</motion.h2>
				<motion.p
					{...fadeIn}
					className="mb-2 text-gray-500 dark:text-gray-400"
				>
					The difference between hoping for the best and knowing what done
					looks like.
				</motion.p>

				<SpecComparison />
				<InsightBox />

				<motion.h3 {...fadeIn} className="mt-10 mb-1 text-xl font-bold">
					See the difference
				</motion.h3>
				<motion.p
					{...fadeIn}
					className="mb-5 text-gray-500 dark:text-gray-400"
				>
					Good criteria are the ones an AI can check without asking you.
				</motion.p>

				<CriteriaCompare />
			</Wide>
		</Section>
	)
}
