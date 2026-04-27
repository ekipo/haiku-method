#!/usr/bin/env node
/**
 * Export Mermaid stateDiagram-v2 source for every studio.
 *
 * Walks plugin/studios/<name>/STUDIO.md, builds a StudioConfig,
 * runs the Mermaid exporter, writes the result to
 * website/public/workflow-diagrams/<studio>.mmd. The website docs
 * (and eventually prototype-stage-flow.html) consume these.
 *
 * This closes the architecture-prototype-sync rule from CLAUDE.md:
 * every studio change → re-run this script → diagrams regenerate.
 *
 * Usage:
 *   node packages/haiku/scripts/export-workflow-diagrams.mjs
 *
 * The script is idempotent — it overwrites the diagram files in
 * place, so running it on a clean tree produces no diff.
 */

import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, "..", "..", "..")
const pluginRoot = join(repoRoot, "plugin")
const websiteRoot = join(repoRoot, "website")
const outDir = join(websiteRoot, "public", "workflow-diagrams")

// Point the studio reader at the plugin's bundled studios.
process.env.CLAUDE_PLUGIN_ROOT = pluginRoot

const { buildStudioConfig } = await import(
	"../src/orchestrator/workflow/build-studio-config.ts"
)
const { exportStudioMermaid } = await import(
	"../src/orchestrator/workflow/export-mermaid.ts"
)

mkdirSync(outDir, { recursive: true })

// Discover studios by walking plugin/studios/. Each subdir with a
// STUDIO.md is a studio.
const studiosDir = join(pluginRoot, "studios")
const candidates = readdirSync(studiosDir).filter((name) => {
	try {
		const stat = statSync(join(studiosDir, name))
		if (!stat.isDirectory()) return false
		statSync(join(studiosDir, name, "STUDIO.md"))
		return true
	} catch {
		return false
	}
})

let exported = 0
let skipped = 0
for (const studioDir of candidates) {
	const config = buildStudioConfig(studioDir)
	if (!config) {
		console.error(`  ⚠ ${studioDir}: failed to load StudioConfig — skipping`)
		skipped++
		continue
	}
	const mermaid = exportStudioMermaid(config)
	const outFile = join(outDir, `${studioDir}.mmd`)
	writeFileSync(outFile, `${mermaid}\n`)
	const lineCount = mermaid.split("\n").length
	console.log(
		`  ✓ ${studioDir.padEnd(20)} ${lineCount.toString().padStart(4)} lines → ${outFile}`,
	)
	exported++
}

console.log(`\nExported ${exported} studio diagram(s); skipped ${skipped}.`)
process.exit(0)
