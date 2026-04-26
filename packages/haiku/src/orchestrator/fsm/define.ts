// FSM state definition helper.
//
// `defineState` is an identity function that locks in the `FsmState`
// shape so per-state files type-check against the discriminator union
// and the central registry can build a `Map<StateName, FsmState>`
// without losing the per-state name narrowing.

import type { FsmState, StateName } from "./types.js"

export function defineState<N extends StateName>(
	state: FsmState<N>,
): FsmState<N> {
	return state
}
