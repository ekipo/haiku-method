"use client"

import { motion } from "framer-motion"
import {
	BubbleOption,
	ChatBubble,
	DeepDive,
	ExchangeLabel,
} from "../components/guide"
import {
	DagArrow,
	DagUnit,
	Section,
	Wide,
	WorkflowPill,
} from "../_home-helpers"
import { fadeIn } from "./_shared"

interface Props {
	isRef: boolean
}

export function Act2({ isRef }: Props) {
	return (
		<Section id="act2">
			<Wide>
				<motion.h2 {...fadeIn} className="mb-2 text-3xl font-bold">
					Act 2: Planning Together
				</motion.h2>
				<motion.p
					{...fadeIn}
					className="mb-6 text-gray-500 dark:text-gray-400"
				>
					This is the most important part. Good planning means the AI can
					build autonomously. Bad planning means it keeps asking you
					questions.
				</motion.p>

				{/* Conversation legend */}
				<motion.div
					{...fadeIn}
					className="mb-6 flex items-start gap-4 rounded-xl border border-blue-200 bg-blue-50/50 p-5 dark:border-blue-800 dark:bg-blue-950/20"
				>
					<span className="flex-shrink-0 text-3xl">&#x1F4AC;</span>
					<p className="text-sm text-gray-600 dark:text-gray-300">
						What follows is the actual conversation flow.{" "}
						<strong className="text-blue-500">
							Blue bubbles on the left
						</strong>{" "}
						are you.{" "}
						<strong className="text-amber-400">
							Gold bubbles on the right
						</strong>{" "}
						are the AI.{" "}
						<strong className="text-gray-500">
							Gray bubbles in the center
						</strong>{" "}
						are system events.
					</p>
				</motion.div>

				{/* The 9-exchange conversation */}
				<div className="space-y-6">
					{/* Exchange 1 */}
					<div className="space-y-3">
						<ExchangeLabel>
							Exchange 1 -- &ldquo;What do you want to build?&rdquo;
						</ExchangeLabel>
						<ChatBubble speaker="ai">
							What do you want to build or accomplish?
						</ChatBubble>
						<ChatBubble speaker="human">
							I want to add OAuth login to our app.
						</ChatBubble>
					</div>

					{/* Exchange 2 */}
					<div className="space-y-3">
						<ExchangeLabel>
							Exchange 2 -- &ldquo;Let me understand better&rdquo;
						</ExchangeLabel>
						<ChatBubble speaker="ai">
							<div>A few questions to narrow things down:</div>
							<div className="mt-2">
								<strong className="text-xs">Who uses this?</strong>
								<div className="mt-1 flex flex-wrap gap-1.5">
									<BubbleOption variant="gold">End users</BubbleOption>
									<BubbleOption variant="gold">Admin users</BubbleOption>
									<BubbleOption variant="gold">Both</BubbleOption>
								</div>
							</div>
							<div className="mt-2">
								<strong className="text-xs">Which OAuth providers?</strong>
								<div className="mt-1 flex flex-wrap gap-1.5">
									<BubbleOption variant="gold">Google</BubbleOption>
									<BubbleOption variant="gold">GitHub</BubbleOption>
									<BubbleOption variant="gold">Both</BubbleOption>
									<BubbleOption variant="gold">Custom</BubbleOption>
								</div>
							</div>
						</ChatBubble>
						<ChatBubble speaker="human">
							<div className="flex flex-wrap gap-1.5">
								<BubbleOption variant="selected">End users</BubbleOption>
								<BubbleOption variant="selected">
									Both (Google + GitHub)
								</BubbleOption>
								<BubbleOption variant="selected">Login page</BubbleOption>
							</div>
						</ChatBubble>
					</div>

					{/* Exchange 3 */}
					<div className="space-y-3">
						<ExchangeLabel>Exchange 3 -- AI goes exploring</ExchangeLabel>
						<ChatBubble speaker="system">
							<div className="my-3 text-3xl">&#x1F50D;</div>
							<strong>
								Claude delegates exploration to a Discovery Agent...
							</strong>
							<p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
								This is automatic. You wait. The AI reads your codebase --
								file structure, database schemas, API endpoints, existing
								patterns -- and writes its findings to a discovery document.
							</p>
							<div className="mt-3 grid grid-cols-2 gap-2">
								{[
									"Reading file structure",
									"Scanning database schemas",
									"Mapping API endpoints",
									"Finding existing patterns",
								].map((t) => (
									<div
										key={t}
										className="rounded-md border border-gray-200 bg-white px-2.5 py-2 text-xs dark:border-gray-700 dark:bg-gray-950"
									>
										<span className="text-amber-400">&#x25B8;</span> {t}
									</div>
								))}
							</div>
						</ChatBubble>
					</div>

					{/* Deep Dive: Domain Discovery */}
					<DeepDive
						title="Deep Dive: Domain Discovery -- What the Explorer Actually Finds"
						forceOpen={isRef}
					>
						<ul className="list-disc space-y-1.5 pl-4">
							<li>
								<strong>File structure & project layout</strong> -- Maps
								directories, identifies framework patterns
							</li>
							<li>
								<strong>Database schemas</strong> -- Reads migrations, models,
								entity relationships
							</li>
							<li>
								<strong>API surface</strong> -- Maps endpoints, authentication
								patterns, request/response shapes
							</li>
							<li>
								<strong>Existing patterns</strong> -- How the codebase handles
								auth, validation, error handling
							</li>
							<li>
								<strong>Dependencies</strong> -- Package manifest analysis,
								version constraints
							</li>
							<li>
								<strong>Project knowledge artifacts</strong> -- Synthesizes
								what it finds into persistent knowledge files (design tokens,
								architecture patterns, conventions, domain terms) so every
								future intent starts with context instead of from scratch
							</li>
						</ul>
					</DeepDive>

					{/* Design direction callout for greenfield projects */}
					<motion.div
						{...fadeIn}
						className="rounded-lg border border-violet-200 bg-violet-50/30 px-4 py-3 dark:border-violet-800/50 dark:bg-violet-950/10"
					>
						<p className="text-xs text-gray-600 dark:text-gray-300">
							<strong className="text-violet-500">New projects only:</strong>{" "}
							A visual design direction picker guides you through choosing an
							aesthetic -- Brutalist, Editorial, Dense, or Playful. Pick one
							as the final direction or ask the AI for more variants. The
							selection produces a design blueprint that shapes every wireframe
							and UI component downstream.
						</p>
					</motion.div>

					{/* Deep Dive: Greenfield Design Direction */}
					<DeepDive
						title="Deep Dive: Greenfield Projects -- Choosing a Design Direction"
						forceOpen={isRef}
					>
						<p className="mb-3">
							For brand-new projects, there&rsquo;s an extra step before
							building starts. The AI opens a visual picker in your browser
							where you choose a <strong>design direction</strong>.
						</p>
						<div className="mb-3 grid gap-2 sm:grid-cols-2">
							{[
								{
									name: "Brutalist",
									desc: "High contrast, raw borders, monospace",
								},
								{
									name: "Editorial",
									desc: "Magazine layouts, serif headings, whitespace",
								},
								{
									name: "Dense / Utilitarian",
									desc: "Packed info, dark theme, keyboard-first",
								},
								{
									name: "Playful / Warm",
									desc: "Rounded corners, vibrant colors, soft shadows",
								},
							].map((a) => (
								<div
									key={a.name}
									className="rounded-lg border border-gray-200 bg-white px-3 py-2 dark:border-gray-700 dark:bg-gray-950"
								>
									<div className="text-sm font-semibold">{a.name}</div>
									<div className="text-xs text-gray-500 dark:text-gray-400">
										{a.desc}
									</div>
								</div>
							))}
						</div>
						<p className="text-xs text-gray-500 dark:text-gray-400">
							If none of the previews land, ask the AI for more variants --
							keep the ones you like and steer the next batch with comments.
							You can also drop pinned annotations directly on the chosen
							preview for pointed feedback. The result is a{" "}
							<strong>design blueprint</strong> that feeds into wireframe
							generation and hat context -- so your wireframes carry the
							chosen aesthetic instead of generic gray boxes.
						</p>
					</DeepDive>

					{/* Exchange 4 */}
					<div className="space-y-3">
						<ExchangeLabel>
							Exchange 4 -- &ldquo;Here&rsquo;s what I found&rdquo;
						</ExchangeLabel>
						<ChatBubble speaker="ai">
							<strong>Domain model</strong>
							<div className="mt-2 space-y-2 rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs dark:border-gray-700 dark:bg-gray-950">
								<div>
									<strong className="text-cyan-400">Entities:</strong>{" "}
									<span className="text-gray-500">
										User, OAuth Token, Session
									</span>
								</div>
								<div>
									<strong className="text-cyan-400">Relationships:</strong>{" "}
									<span className="text-gray-500">
										User has many OAuth Tokens
									</span>
								</div>
								<div>
									<strong className="text-rose-500">Gap found:</strong>{" "}
									<span className="text-gray-500">
										No existing session management -- we&rsquo;ll need to add
										this
									</span>
								</div>
							</div>
						</ChatBubble>
						<ChatBubble speaker="human">
							<div className="flex flex-wrap gap-1.5">
								<BubbleOption variant="selected">Looks accurate</BubbleOption>
							</div>
						</ChatBubble>
					</div>

					{/* Exchange 5 */}
					<div className="space-y-3">
						<ExchangeLabel>
							Exchange 5 -- &ldquo;Which workflow should we use?&rdquo;
						</ExchangeLabel>
						<ChatBubble speaker="ai">
							I recommend the <strong>default</strong> workflow:
							<div className="mt-2 space-y-2">
								<WorkflowPill
									name="Default"
									flow="Planner -> Builder -> Reviewer"
									recommended
								/>
								<WorkflowPill
									name="Adversarial"
									flow="Planner -> Builder -> Red Team -> Blue Team -> Reviewer"
								/>
								<WorkflowPill
									name="TDD"
									flow="Test Writer -> Implementer -> Refactorer -> Reviewer"
								/>
								<WorkflowPill
									name="Design"
									flow="Planner -> Designer -> Reviewer"
								/>
								<WorkflowPill
									name="Hypothesis"
									flow="Observer -> Hypothesizer -> Experimenter -> Analyst"
								/>
							</div>
						</ChatBubble>
						<ChatBubble speaker="human">
							<div className="flex flex-wrap gap-1.5">
								<BubbleOption variant="selected">Default</BubbleOption>
							</div>
						</ChatBubble>
					</div>

					{/* Exchange 6 */}
					<div className="space-y-3">
						<ExchangeLabel>
							Exchange 6 -- &ldquo;What does success look like?&rdquo;
						</ExchangeLabel>
						<ChatBubble speaker="ai">
							Let&rsquo;s define 3-7 measurable success criteria:
							<div className="mt-2 space-y-1 text-sm">
								<div className="border-b border-gray-200 py-1 dark:border-gray-700">
									&#x2705; All tests in{" "}
									<code className="text-amber-500">tests/auth/</code> pass
								</div>
								<div className="border-b border-gray-200 py-1 dark:border-gray-700">
									&#x2705; OAuth flow completes in &lt;2s p95
								</div>
								<div className="py-1">
									&#x2705; OWASP top 10 -- no critical findings
								</div>
							</div>
						</ChatBubble>
						<ChatBubble speaker="human">
							Looks good. Add one more: &ldquo;Users can link multiple OAuth
							providers to one account.&rdquo;
						</ChatBubble>
					</div>

					{/* Exchange 7 */}
					<div className="space-y-3">
						<ExchangeLabel>
							Exchange 7 -- &ldquo;Here&rsquo;s how I&rsquo;ll break this
							down&rdquo;
						</ExchangeLabel>
						<ChatBubble speaker="ai">
							I&rsquo;ve elaborated this into four units of work:
							<div className="mt-3 space-y-2 rounded-xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-950">
								<DagUnit
									id="Unit 1"
									name="OAuth Provider Setup (backend)"
									deps="no dependencies"
								/>
								<DagArrow />
								<DagUnit
									id="Unit 2"
									name="Callback Handler (backend)"
									deps="depends on Unit 1"
								/>
								<DagArrow />
								<DagUnit
									id="Unit 3"
									name="Session Management (backend)"
									deps="depends on Unit 1"
								/>
								<DagArrow />
								<DagUnit
									id="Unit 4"
									name="Login UI (frontend)"
									deps="depends on Unit 2 & 3"
								/>
							</div>
							<p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
								Units 2 and 3 can run in parallel once Unit 1 is done. Unit 4
								waits for both.
							</p>
						</ChatBubble>
						<ChatBubble speaker="human">
							You review each unit individually:
							<div className="mt-2 flex flex-wrap gap-1.5">
								<BubbleOption variant="selected">
									Unit 1: Approved
								</BubbleOption>
								<BubbleOption variant="selected">
									Unit 2: Approved
								</BubbleOption>
								<BubbleOption variant="selected">
									Unit 3: Approved
								</BubbleOption>
								<BubbleOption variant="selected">
									Unit 4: Approved
								</BubbleOption>
							</div>
						</ChatBubble>
					</div>

					{/* Exchange 8 */}
					<div className="space-y-3">
						<ExchangeLabel>
							Exchange 8 -- &ldquo;How should we deliver?&rdquo;
						</ExchangeLabel>
						<ChatBubble speaker="ai">
							How would you like to review the work?
							<div className="mt-2 flex flex-wrap gap-1.5">
								<BubbleOption variant="gold">
									Review each unit as a separate PR
								</BubbleOption>
								<BubbleOption variant="gold">
									Build everything, one PR at the end
								</BubbleOption>
								<BubbleOption variant="gold">
									Build on main branch
								</BubbleOption>
							</div>
						</ChatBubble>
						<ChatBubble speaker="human">
							<div className="flex flex-wrap gap-1.5">
								<BubbleOption variant="selected">
									Review each unit as a separate PR
								</BubbleOption>
							</div>
						</ChatBubble>
					</div>

					{/* Exchange 9 */}
					<div className="space-y-3">
						<ExchangeLabel>
							Exchange 9 -- &ldquo;Ready to build!&rdquo;
						</ExchangeLabel>
						<ChatBubble speaker="ai">
							<div className="mb-3 space-y-1 rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs dark:border-gray-700 dark:bg-gray-950">
								<div>
									<strong>Intent:</strong>{" "}
									<span className="text-gray-500">Add OAuth login</span>
								</div>
								<div>
									<strong>Workflow:</strong>{" "}
									<span className="text-gray-500">
										Default (Planner &rarr; Builder &rarr; Reviewer)
									</span>
								</div>
								<div>
									<strong>Criteria:</strong>{" "}
									<span className="text-gray-500">
										4 success criteria defined
									</span>
								</div>
								<div>
									<strong>Units:</strong>{" "}
									<span className="text-gray-500">
										4 units with dependency ordering
									</span>
								</div>
								<div>
									<strong>Delivery:</strong>{" "}
									<span className="text-gray-500">Separate PRs per unit</span>
								</div>
							</div>
							Shall I start building, or open a PR for your team to review the
							spec first?
						</ChatBubble>
						<ChatBubble speaker="human">
							<div className="flex flex-wrap gap-1.5">
								<BubbleOption variant="selected">Start building</BubbleOption>
								<BubbleOption variant="blue">
									Open spec PR for review
								</BubbleOption>
							</div>
						</ChatBubble>
						<ChatBubble speaker="system">
							All artifacts committed to{" "}
							<code className="text-amber-500">
								haiku/&#123;slug&#125;/main
							</code>{" "}
							branch. The plan is saved. Time to build.
						</ChatBubble>
					</div>
				</div>

				{/* Planning done callout */}
				<motion.div
					{...fadeIn}
					className="mt-8 rounded-xl border border-green-200 bg-green-50/50 p-6 text-center dark:border-green-800 dark:bg-green-950/10"
				>
					<p className="mb-2 text-lg font-semibold text-green-500">
						That&rsquo;s it. Planning is done.
					</p>
					<p className="mx-auto max-w-lg text-sm text-gray-500 dark:text-gray-400">
						Nine exchanges. Maybe ten minutes of your time. The AI now has
						everything it needs to work autonomously. You can step away. You
						can watch. Either way, the building starts now.
					</p>
				</motion.div>
			</Wide>
		</Section>
	)
}
