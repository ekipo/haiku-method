// Hook definition helper.
//
// `defineHook` is an identity function — locks in the HookDef shape so
// per-hook files get full IntelliSense and the dispatcher can rely on a
// uniform handler signature.

import type { HookDef } from "./types.js"

export function defineHook(def: HookDef): HookDef {
	return def
}
