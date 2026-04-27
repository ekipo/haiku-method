// orchestrator/prompts/design_direction_required.ts — Stage needs
// HTML wireframe variants before proceeding. Tells the agent to
// generate them, call pick_design_direction, then resume.

import { definePromptBuilder } from "./define.js"

export default definePromptBuilder(({ slug }) => {
	return `## Design Direction Required\n\nThis stage requires wireframe variants before proceeding.\n\n1. Generate 2-3 distinct design approaches as HTML wireframe snippets\n2. Call \`pick_design_direction\` with the variants\n3. After the user selects a direction, call \`haiku_run_next { intent: "${slug}", design_direction_selected: true }\`\n\nCheck for design provider MCPs (\`mcp__pencil__*\`, \`mcp__openpencil__*\`) and use them if available.`
})
