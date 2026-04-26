// state/quality-gates.ts — Inline quality-gate runner for hookless
// harnesses. Mirrors the quality-gate Stop hook logic but runs inside
// haiku_unit_advance_hat so the same enforcement applies in
// environments without the Claude Code Stop hook (Cowork, raw MCP).

import { execSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { findHaikuRoot, parseFrontmatter } from "./shared.js"

export interface QualityGateResult {
	error: string
	message: string
	failures: Array<{
		name: string
		command: string
		exit_code: number
		output: string
	}>
}

/** Run the intent + unit `quality_gates` declarations as shell commands.
 *  Returns null if all gates pass (or none are declared), or a structured
 *  failure record if any gate exits non-zero. Non-fatal — errors get
 *  packaged into the return shape rather than thrown. */
export function runInlineQualityGates(
	intentSlug: string,
	unitPath: string,
): QualityGateResult | null {
	const root = findHaikuRoot()
	const intentFile = join(root, "intents", intentSlug, "intent.md")

	function readGates(filePath: string): Array<Record<string, string>> {
		if (!existsSync(filePath)) return []
		const raw = readFileSync(filePath, "utf8")
		const { data } = parseFrontmatter(raw)
		const gates = data.quality_gates
		if (!Array.isArray(gates)) return []
		return gates as Array<Record<string, string>>
	}

	const intentGates = readGates(intentFile)
	const unitGates = readGates(unitPath)
	const allGates = [...intentGates, ...unitGates]
	if (allGates.length === 0) return null

	// Resolve repo root for cwd
	let repoRoot = process.cwd()
	try {
		repoRoot = execSync("git rev-parse --show-toplevel", {
			encoding: "utf8",
		}).trim()
	} catch {
		/* use cwd */
	}

	const failures: Array<{
		name: string
		command: string
		exit_code: number
		output: string
	}> = []

	for (let i = 0; i < allGates.length; i++) {
		const gate = allGates[i]
		const gateName = gate.name ?? `gate-${i}`
		const gateCmd = gate.command ?? ""
		if (!gateCmd) continue

		const cwd = gate.dir ? resolve(repoRoot, gate.dir) : repoRoot

		// Per-gate timeout defaults to 30s; override via HAIKU_GATE_TIMEOUT_MS.
		const gateTimeoutMs =
			Number.parseInt(process.env.HAIKU_GATE_TIMEOUT_MS ?? "", 10) || 30000
		try {
			execSync(gateCmd, {
				cwd,
				encoding: "utf8",
				timeout: gateTimeoutMs,
				stdio: ["pipe", "pipe", "pipe"],
			})
		} catch (err: unknown) {
			const execErr = err as {
				status?: number
				stdout?: string
				stderr?: string
			}
			failures.push({
				name: gateName,
				command: gateCmd,
				exit_code: execErr.status ?? 1,
				output: ((execErr.stdout ?? "") + (execErr.stderr ?? "")).slice(0, 500),
			})
		}
	}

	if (failures.length === 0) return null

	return {
		error: "quality_gate_failed",
		message: `Cannot advance hat: ${failures.length} quality gate(s) failed. Fix the issues and try again.\n${failures.map((f) => `- ${f.name}: '${f.command}' exited ${f.exit_code}${f.output ? `: ${f.output}` : ""}`).join("\n")}`,
		failures,
	}
}
