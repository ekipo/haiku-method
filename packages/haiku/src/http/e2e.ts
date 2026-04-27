// http/e2e.ts — E2E encryption envelope as a Fastify onSend hook.
//
// When an outbound response is for a session-scoped URL AND the
// session has an active E2E key, replace the response body with the
// encrypted blob and rewrite the Content-Type so the client decrypts
// before parsing. Skipped for error responses (4xx/5xx) and 204/205/304
// — encrypting a zero-byte body adds no privacy and breaks browsers
// that strict-check those status codes.

import type { FastifyReply, FastifyRequest } from "fastify"
import { e2eEncrypt, isE2EActive } from "../tunnel.js"

/** Extract the session id from the leading path segment of the URL.
 *  Returns null when the URL is not session-scoped (health checks,
 *  static SPA shells, etc.). Used both for E2E key lookup and for
 *  routing checks elsewhere in the HTTP layer. */
export function extractSessionIdFromPath(path: string): string | null {
	const match = path.match(
		/\/(?:api\/session|review|question|direction|files|mockups|wireframe|stage-artifacts|question-image)\/([^/]+)/,
	)
	return match?.[1] ?? null
}

export async function e2eOnSend(
	req: FastifyRequest,
	reply: FastifyReply,
	payload: unknown,
): Promise<unknown> {
	if (reply.statusCode >= 400) return payload
	if (
		reply.statusCode === 204 ||
		reply.statusCode === 205 ||
		reply.statusCode === 304
	) {
		return payload
	}
	const sessionId = extractSessionIdFromPath(req.url.split("?")[0])
	if (!sessionId || !isE2EActive(sessionId)) return payload
	const contentType =
		(reply.getHeader("content-type") as string | undefined) ??
		"application/octet-stream"
	let bodyBuffer: Buffer
	if (typeof payload === "string") {
		bodyBuffer = Buffer.from(payload, "utf8")
	} else if (Buffer.isBuffer(payload)) {
		bodyBuffer = payload
	} else if (payload instanceof Uint8Array) {
		bodyBuffer = Buffer.from(payload)
	} else if (payload && typeof payload === "object") {
		bodyBuffer = Buffer.from(JSON.stringify(payload), "utf8")
	} else {
		return payload
	}
	const encrypted = e2eEncrypt(sessionId, bodyBuffer)
	if (!encrypted) return payload
	reply.header("Content-Type", "application/octet-stream")
	reply.header("X-Original-Content-Type", contentType)
	reply.header("X-E2E-Encrypted", "1")
	return encrypted
}
