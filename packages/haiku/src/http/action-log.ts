// http/action-log.ts — Structured action logging for feedback CRUD +
// revisit mutations.
//
// Fastify runs with `logger: false`, so we emit a single JSON line per
// feedback mutation / revisit to stderr. Every log line includes the
// request's `reqId` (same value returned in the `X-Request-Id` response
// header) plus the domain keys that let a human correlate
// "why did FB-03 get created twice?" across the stream:
//
//   { ts, reqId, action, intent, stage, feedbackId?, status, detail? }
//
// `status` is the HTTP status code we're about to send. `detail` is an
// optional one-line hint (e.g. error message or created feedback id).
//
// This does NOT replace full request logging (FB-01 tracks that) — it's
// the minimum correlation surface the reviewer asked for in FB-02.

export interface FeedbackActionLogFields {
	reqId: string
	action: string
	status: number
	intent?: string | null
	stage?: string | null
	feedbackId?: string | null
	detail?: string | null
}

export function logFeedbackAction(fields: FeedbackActionLogFields): void {
	try {
		const line = {
			ts: new Date().toISOString(),
			reqId: fields.reqId,
			action: fields.action,
			status: fields.status,
			...(fields.intent ? { intent: fields.intent } : {}),
			...(fields.stage ? { stage: fields.stage } : {}),
			...(fields.feedbackId ? { feedbackId: fields.feedbackId } : {}),
			...(fields.detail ? { detail: fields.detail } : {}),
		}
		process.stderr.write(`[haiku-mcp][feedback] ${JSON.stringify(line)}\n`)
	} catch {
		/* never let logging break a request */
	}
}
