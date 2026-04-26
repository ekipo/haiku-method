// Hook definition types.
//
// Hooks are stdin-in / stdout-out side-effect functions invoked by the
// CLI binary's `runHook(name, args)` dispatcher. They are advisory in
// most harnesses (Claude Code) and should never carry load-bearing
// enforcement on their own — every hook has an MCP-tool equivalent so
// the system works identically on harnesses that don't fire hooks.

export interface HookContext {
	/** Resolved plugin root — used to locate studios, schemas, and
	 *  generated artifacts on disk. */
	readonly pluginRoot: string
}

export type HookHandler = (
	input: Record<string, unknown>,
	ctx: HookContext,
) => Promise<void>

export interface HookDef {
	/** Name as registered in plugin/.claude-plugin/hooks.json. */
	readonly name: string
	/** Short description of when this hook fires and what it enforces. */
	readonly description: string
	/** Handler — runs when the harness fires the hook. */
	readonly handle: HookHandler
}
