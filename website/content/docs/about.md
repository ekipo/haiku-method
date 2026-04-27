---
title: About H·AI·K·U
description: The evolution from AWS's AI-DLC paper to a universal lifecycle framework — born at The Bushido Collective, now owned and maintained by GigSmart, open source under Apache 2.0
order: 100
---

*Born at The Bushido Collective. Now owned and maintained by GigSmart.*

## The Lineage

H·AI·K·U didn't appear overnight. It evolved through three generations, each building on the last, each absorbing lessons from real-world failure.

### Generation 1: The AWS Paper (2024)

**Raja SP** at Amazon Web Services published *AI-Driven Development Lifecycle (AI-DLC) Method Definition* — the paper that named the core artifacts. **Intent** (what you're building), **Unit** (a self-contained piece of work), **Bolt** (a rapid iteration cycle). The paper argued that existing methodologies — Scrum, Kanban, Waterfall — were designed for human-speed iteration cycles measured in weeks. AI makes iteration nearly free. The methods needed reimagining, not retrofitting.

Raja introduced **Mob Elaboration**: a collaborative ritual where AI proposes a breakdown of an intent into units and user stories, and the whole team — product, engineering, QA — refines it together in a single room. The paper also embedded design techniques (DDD, BDD, TDD) directly into the methodology instead of leaving them as separate concerns.

The concepts were strong. The implementation was prompts in an appendix — copy-paste instructions for ChatGPT. No tooling, no enforcement, no state machine. The methodology existed on paper.

### The Ralph Wiggum Influence

Around the same time, **Geoffrey Huntley** created the [Ralph Wiggum Software Development Technique](https://github.com/mikeyobrien/ralph-orchestrator) — named for the Simpsons character who fails forward through sheer persistence. The core insight: wrap an AI agent in a loop. Plan, execute, evaluate, retry. Don't stop until the quality gates pass or you hit a limit.

Ralph introduced **hat-based orchestration** — specialized personas (code-assist, debug, review, research) that cycle through work in sequence. Instead of one agent doing everything at once, different "hats" bring different perspectives to the same unit of work. The pattern enforced completeness: an architect hat thinks about structure, a builder hat writes the code, a reviewer hat catches what the builder missed.

**Boris Cherny** at Anthropic built the Ralph Wiggum plugin for Claude Code, proving the pattern worked in production. **This hat rotation pattern became the direct inspiration for H·AI·K·U's multi-hat execution model** — the idea that a single unit of work should pass through distinct behavioral roles (planner, builder, reviewer) rather than being handled by one monolithic agent.

### Generation 2: AI-DLC 2026

In January 2026, [Jason Waldrip](https://github.com/jwaldrip) — CTO of GigSmart — took Raja's paper, absorbed the Ralph loop philosophy, and started writing a production methodology. [Chris Driscol](https://github.com/cdriscol), [Josh Elliott](https://github.com/jcelliott), and [Craig McDonald](https://github.com/thrackle) provided critical insights and contributions — challenging assumptions, shaping the patterns that survived contact with reality, and ensuring the methodology held up under the pressure of real production work.

The 2026 paper credited its foundations explicitly — Raja's artifacts and "reimagine, don't retrofit" philosophy, Huntley's autonomous loop patterns, Steve Wilson's Human-on-the-Loop governance, paddo.dev's analysis of SDLC collapse and the "19-agent trap," and HumanLayer's 12 Factor Agents principles.

What the 2026 paper added:

- **Backpressure over prescription** — don't tell the agent how to work; define quality gates that reject bad work. "Better to fail predictably than succeed unpredictably."
- **Completion criteria as exit conditions** — every unit has programmatically verifiable success conditions. The human defines "done"; the AI figures out how.
- **Files as memory** — context windows reset between sessions, but the filesystem persists. Git history, modified files, and organizational artifacts (tickets, runbooks, wikis) are memory providers the agent can access.
- **The 19-agent trap** — mapping AI agents to org chart roles (analyst agent, PM agent, architect agent, developer agent, QA agent) performs worse than simpler alternatives. Context loss from inter-agent handoffs dominates. One agent with hat rotation outperforms a swarm.
- **Three operating modes** — Interactive (human-in-the-loop for every step), One-Human-on-the-Loop (agent runs, human approves at gates), and Autonomous (agent runs with backpressure only).

It was battle-tested at [GigSmart](https://gigsmart.com) — a large Elixir/Phoenix platform with complex billing, real-time matching, and multi-tenant architecture. Real features, real deadlines, real users. Every weakness in the methodology surfaced there.

### Generation 3: H·AI·K·U (Human + AI Knowledge Unification)

The breakthrough was realizing that the lifecycle patterns weren't specific to software.

Legal review follows the same shape: understand the problem, research precedent, draft the work, review for completeness, deliver. Marketing campaigns: research the audience, design the messaging, create the assets, review for brand consistency, publish. Incident response: triage, investigate, mitigate, resolve, write the postmortem.

Every domain has stages. Every stage has behavioral roles. Every piece of work needs quality gates. The artifacts differ, but the structure is universal.

H·AI·K·U universalized the framework with the **studio model**: named lifecycle templates that define stages, hats, and review gates for any domain. The software studio is one of twenty — alongside marketing, legal, HR, finance, incident response, security assessment, compliance, documentation, and more.

What H·AI·K·U added beyond AI-DLC 2026:

- **Studios** — domain-specific lifecycle templates with their own stages, hats, and review agents
- **workflow enforcement** — a state machine drives all transitions; the agent cannot bypass gates, skip stages, or produce work outside its scope
- **Stage-scoped execution** — elaboration produces the plan, execution produces the work, and the two never mix
- **Worktree isolation** — parallel units execute in isolated git worktrees that merge back on completion
- **Visual review UI** — browser-based review pages with comments, annotations, DAG visualization, and approve/decline controls
- **MCP-native architecture** — the entire plugin runs as an MCP server with tools, prompts, and elicitation

The methodology is for everyone — not just developers.

## Origins

H·AI·K·U is built and maintained by [GigSmart](https://gigsmart.com). The framework was forged in GigSmart's production environment — a large Elixir/Phoenix platform with complex billing, real-time matching, and multi-tenant architecture — where real features with real deadlines and real users exposed every weakness in the methodology.

We believe:
- Single-pass human-AI collaboration is the ideal; multi-pass is a concession
- Quality comes from structure, not from hoping the AI gets it right
- The AI shouldn't manage its own lifecycle — a state machine should
- Files are memory; completion criteria enable autonomy; backpressure beats prescription

H·AI·K·U was originally developed at [The Bushido Collective](https://thebushido.co) as an open-source project. In 2026, ownership transferred to [GigSmart](https://gigsmart.com), where the framework continues to be actively developed and maintained.

The GigSmart team battle-tested the studio/stage/hat model across real features, validated the inception -> design -> product -> development -> operations -> security pipeline, pushed the limits of parallel execution and worktree isolation, and provided the real-world feedback that shaped the review UI, gate behavior, and workflow enforcement.

## Acknowledgments

H·AI·K·U stands on the shoulders of:

- **Raja SP** (AWS) — the AI-DLC paper that named Intent, Unit, Bolt and argued for reimagination over retrofitting
- **Geoffrey Huntley** — the Ralph Wiggum technique and the philosophy of autonomous loops with hat-based orchestration
- **Boris Cherny** (Anthropic) — the Ralph Wiggum plugin for Claude Code that proved loop orchestration in production
- **Steve Wilson** (OWASP) — Human-on-the-Loop governance frameworks
- **paddo.dev** — analysis of SDLC collapse and the 19-agent trap
- **HumanLayer** — 12 Factor Agents principles and context engineering research

## Built With

H·AI·K·U is built on:
- [Claude Code](https://claude.com/claude-code) by Anthropic — the AI backbone
- [MCP (Model Context Protocol)](https://modelcontextprotocol.io) — the integration standard
- TypeScript + esbuild — the plugin runtime
- React + Vite — the review UI

## Contributing

H·AI·K·U is open source under the Apache 2.0 license. Contributions welcome:
- [GitHub Repository](https://github.com/gigsmart/haiku-method)
- [Website](https://haikumethod.ai)
