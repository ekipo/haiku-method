// tools/state/haiku_version_info.ts — Report the running MCP binary
// version + plugin version, plus pending-update info.

import { getPendingVersion, hasPendingUpdate } from "../../auto-update.js"
import { getPluginVersion, MCP_VERSION } from "../../version.js"
import { defineTool } from "../define.js"
import { text } from "./_text.js"

export default defineTool({
	name: "haiku_version_info",
	description:
		"Return the running MCP binary version and plugin version. " +
		"MCP version is baked into the binary at build time; plugin version is read from plugin.json at runtime.",
	inputSchema: { type: "object" as const, properties: {} },
	handle() {
		const info: Record<string, string> = {
			mcp_version: MCP_VERSION,
			plugin_version: getPluginVersion(),
		}
		const pending = getPendingVersion()
		if (pending) info.pending_update = pending
		if (hasPendingUpdate())
			info.update_note =
				"A new version has been downloaded and will activate on the next tool call."
		return text(JSON.stringify(info, null, 2))
	},
})
