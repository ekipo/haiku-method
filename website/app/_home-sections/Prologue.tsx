"use client"

import { motion } from "framer-motion"
import { CastCard, DeepDive, HatExplainer } from "../components/guide"
import {
	CastList,
	MiniCard,
	Section,
	Wide,
	WorkflowGroup,
} from "../_home-helpers"
import { fadeIn } from "./_shared"

interface Props {
	isRef: boolean
}

export function Prologue({ isRef }: Props) {
	return (
		<Section id="prologue">
			<Wide>
				<motion.h2 {...fadeIn} className="mb-2 text-3xl font-bold">
					Prologue: Meet the Cast
				</motion.h2>
				<motion.p
					{...fadeIn}
					className="mb-8 text-gray-500 dark:text-gray-400"
				>
					Before the story begins, let&rsquo;s meet the players. Every
					character has a role. Nobody works alone.
				</motion.p>

				{/* Top row: Human + AI */}
				<div className="grid gap-5 sm:grid-cols-2">
					<CastCard
						icon="&#x1F9D1;"
						name="You (Human)"
						nameColor="text-blue-500"
						borderColor="border-l-4 border-l-blue-500"
						description="You provide the vision and make key decisions."
					>
						<CastList
							items={[
								"During planning: you answer questions and approve specs",
								"During building: you watch, step away, or unblock",
								"During reflection: you validate insights and choose next steps",
							]}
						/>
					</CastCard>

					<CastCard
						icon="&#x1F916;"
						name="Claude (Session Agent)"
						nameColor="text-amber-400"
						borderColor="border-l-4 border-l-amber-400"
						description="The AI you're talking to right now. One agent, many roles."
					>
						<CastList
							items={[
								"Elaborator during planning -- asks questions, explores your codebase, writes specs",
								"Executor during building -- manages the unit queue, spawns hat agents, tracks progress",
								"Analyst during reflection -- analyzes what happened, recommends improvements",
								"Spawns fresh specialist agents for each unit of work",
							]}
						/>
					</CastCard>
				</div>

				{/* Hatted agents — full-width card with expandable detail */}
				<motion.div
					{...fadeIn}
					className="mt-6 rounded-xl border border-amber-200 bg-white p-6 dark:border-amber-800/50 dark:bg-gray-900"
				>
					<div className="mb-4 flex items-start gap-4">
						<span className="text-4xl">&#x1F3A9;</span>
						<div className="flex-1">
							<h3 className="text-lg font-bold text-amber-400">
								The Hatted Agents
							</h3>
							<p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
								When it&rsquo;s time to build, Claude spawns fresh specialist
								agents — each wearing a different &ldquo;hat&rdquo; that
								defines their role. A hat is a set of injected instructions
								that tells the agent how to behave, what gates to pass, and
								when to hand off.
							</p>
							<div className="mt-3 flex flex-wrap gap-2">
								{[
									"Planner",
									"Builder",
									"Reviewer",
									"Designer",
									"Red Team",
									"Blue Team",
									"Test Writer",
									"Implementer",
									"Refactorer",
									"Observer",
									"Hypothesizer",
									"Experimenter",
									"Analyst",
								].map((hat) => (
									<span
										key={hat}
										className="rounded-md bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
									>
										{hat}
									</span>
								))}
							</div>
						</div>
					</div>

					<details className="group">
						<summary className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-violet-500 hover:text-violet-400">
							<svg
								className="h-4 w-4 transition-transform group-open:rotate-90"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
								aria-hidden="true"
							>
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={2}
									d="M9 5l7 7-7 7"
								/>
							</svg>
							See all workflows and hat details
						</summary>
						<div className="mt-5 border-t border-gray-200 pt-5 dark:border-gray-700">
							<HatExplainer />

							{/* Workflow groups */}
							<WorkflowGroup
								name="Default Workflow"
								badge="most common"
								bgClass="bg-amber-500/5 dark:bg-amber-500/5"
								labelColor="text-amber-400"
								borderColor="border-l-amber-400"
								hats={[
									{
										icon: "\u{1F4CB}",
										name: "Planner",
										desc: "Reads the criteria, checks for blockers, creates a tactical plan for this iteration.",
									},
									{
										icon: "\u{1F528}",
										name: "Builder",
										desc: "Implements code incrementally, runs quality gates after every change, fixes what breaks.",
									},
									{
										icon: "\u{1F50D}",
										name: "Reviewer",
										desc: "Verifies every success criterion with evidence, checks code quality, approves or sends back.",
									},
								]}
							/>

							<WorkflowGroup
								name="Adversarial Workflow"
								badge="security-focused"
								bgClass="bg-rose-500/5 dark:bg-rose-500/5"
								labelColor="text-rose-500"
								borderColor="border-l-rose-500"
								hats={[
									{
										icon: "\u{1F4CB}",
										name: "Planner",
										desc: "Reads the criteria, checks for blockers, creates a tactical plan.",
									},
									{
										icon: "\u{1F528}",
										name: "Builder",
										desc: "Implements code incrementally, runs quality gates.",
									},
									{
										icon: "⚔️",
										name: "Red Team",
										desc: "Attacks the code: tests for injection, auth bypass, data exposure.",
									},
									{
										icon: "\u{1F6E1}️",
										name: "Blue Team",
										desc: "Fixes what Red Team found: patches root causes, adds security tests.",
									},
									{
										icon: "\u{1F50D}",
										name: "Reviewer",
										desc: "Verifies every success criterion with evidence.",
									},
								]}
							/>

							<WorkflowGroup
								name="TDD Workflow"
								badge="test-driven"
								bgClass="bg-cyan-500/5 dark:bg-cyan-500/5"
								labelColor="text-cyan-400"
								borderColor="border-l-cyan-400"
								hats={[
									{
										icon: "✍️",
										name: "Test Writer",
										desc: "Writes ONE failing test for ONE behavior. The test MUST fail.",
									},
									{
										icon: "⚙️",
										name: "Implementer",
										desc: "Writes the minimum code to make the test pass. Nothing more.",
									},
									{
										icon: "\u{1F9F9}",
										name: "Refactorer",
										desc: "Cleans up the code without changing behavior. Runs tests after every change.",
									},
									{
										icon: "\u{1F50D}",
										name: "Reviewer",
										desc: "Verifies every success criterion with evidence.",
									},
								]}
							/>

							<WorkflowGroup
								name="Design Workflow"
								badge="UI/UX"
								bgClass="bg-violet-500/5 dark:bg-violet-500/5"
								labelColor="text-violet-500"
								borderColor="border-l-violet-500"
								hats={[
									{
										icon: "\u{1F4CB}",
										name: "Planner",
										desc: "Reads the criteria, checks for blockers, creates a tactical plan.",
									},
									{
										icon: "\u{1F3A8}",
										name: "Designer",
										desc: "Guided by the project's design direction and blueprint. Produces wireframes, tokens, and component specs -- not production code.",
									},
									{
										icon: "\u{1F50D}",
										name: "Reviewer",
										desc: "Verifies every success criterion with evidence.",
									},
								]}
							/>

							<WorkflowGroup
								name="Hypothesis Workflow"
								badge="debugging"
								bgClass="bg-green-500/5 dark:bg-green-500/5"
								labelColor="text-green-500"
								borderColor="border-l-green-500"
								hats={[
									{
										icon: "\u{1F441}️",
										name: "Observer",
										desc: "Reproduces the bug, captures errors, logs, timeline. Reports facts only.",
									},
									{
										icon: "\u{1F4A1}",
										name: "Hypothesizer",
										desc: "Generates 3+ theories about the cause.",
									},
									{
										icon: "\u{1F9EA}",
										name: "Experimenter",
										desc: "Tests hypotheses one at a time. Isolates variables.",
									},
									{
										icon: "\u{1F4CA}",
										name: "Analyst",
										desc: "Confirms root cause, designs minimal fix, adds regression test.",
									},
								]}
							/>
						</div>
					</details>
				</motion.div>

				{/* Supporting cast */}
				<div className="mt-8 grid gap-5 sm:grid-cols-3">
					<CastCard
						icon="&#x1F52C;"
						name="The Helpers"
						nameColor="text-amber-300"
						borderColor="border-l-4 border-l-amber-300"
						description="One-shot subagents during elaboration only."
					>
						<CastList
							items={[
								"Discovery Agent -- Explores codebase structure, APIs, schemas",
								"Wireframe Agent -- Generates HTML mockups for UI units",
								"Ticket Sync Agent -- Creates epics and tickets in your project tracker",
								"Spec Reviewer -- Validates completeness and consistency of the spec",
							]}
						/>
					</CastCard>

					<CastCard
						icon="&#x2705;"
						name="The Integrator"
						nameColor="text-green-500"
						borderColor="border-l-4 border-l-green-500"
						description="Spawned once after ALL units are done."
					>
						<CastList
							items={[
								"Validates everything works together on the merged branch",
								"Runs the 10-step integration check",
								"Reports ACCEPT or REJECT",
							]}
						/>
					</CastCard>

					<CastCard
						icon="&#x2699;&#xFE0F;"
						name="The System"
						nameColor="text-gray-500 dark:text-gray-400"
						borderColor="border-l-4 border-l-gray-400 dark:border-l-gray-600"
						description="Automated hooks (shell scripts) that run silently."
					>
						<CastList
							items={[
								"Saves progress so nothing is lost between sessions",
								"Enforces quality gates, warns about context limits",
								"Makes the whole thing resilient to context window resets",
							]}
						/>
					</CastCard>
				</div>

				<motion.p
					{...fadeIn}
					className="mt-5 text-center text-xs italic text-gray-400 dark:text-gray-500"
				>
					The hatted agents are all Claude -- fresh instances with clean
					context, each focused on one job for one unit.
				</motion.p>

				{/* Deep Dive: Agent Types */}
				<DeepDive
					title="Deep Dive: Agent Types -- The Specialized Roles"
					forceOpen={isRef}
				>
					<p className="mb-3">
						The session agent (Claude) wears different hats at different
						times, and spawns specialized agents when needed.
					</p>
					<h4 className="mb-2 font-semibold text-gray-800 dark:text-gray-200">
						Three Operating Modes
					</h4>
					<div className="grid gap-3 sm:grid-cols-3">
						<MiniCard
							title="HITL -- Human-in-the-Loop"
							titleColor="text-green-500"
							desc="Human validates each step. Maximum control."
						/>
						<MiniCard
							title="OHOTL -- Observed Human-on-the-Loop"
							titleColor="text-amber-500"
							desc="Human watches in real-time, can intervene."
						/>
						<MiniCard
							title="AHOTL -- Autonomous Human-on-the-Loop"
							titleColor="text-cyan-400"
							desc="AI iterates autonomously. Human reviews results."
						/>
					</div>
				</DeepDive>
			</Wide>
		</Section>
	)
}
