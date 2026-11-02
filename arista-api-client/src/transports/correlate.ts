/**
 * Request/response id correlation — M2 (#4), closing the gap PR #19 recorded for M1.
 *
 * M1 (#3) generates `<clientId>-<seq>` ids (DR-017) and `parseResponse` already reads the echoed
 * `id`, but nothing compared the two: pyeapi never does either (`eapilib.py:347` sets
 * `reqid = id(self)` and the reply's `id` is dropped on the floor). ARCHITECTURE §7 promises
 * "each request has its own id and the response is matched by id", and a *single* operator talking to
 * *one* switch is exactly the case where a mismatch means something real: a proxy that replayed a
 * cached answer, a load balancer with two switches behind one address, or a test double that scripted
 * the wrong body. All three are silent-wrong-answer bugs, which on a switch means configuring device A
 * while you are looking at device B.
 *
 * **Decision (not deferred to M4):** validate it, at the transport seam, and fail as `ProtocolError`.
 * Why the transport rather than the codec: pairing a response with the request that produced it is a
 * property of the round trip, not of the bytes, and M1's fixture suite deliberately decodes samples
 * independently of which request they answered (DR-003 keeps those portable). The codec still learns
 * the id — `ResponseContext.requestId` fills `requestId` on every error it builds (§ `wire.ts`).
 *
 * A response that omits `id` is tolerated: EOS always echoes one, but `test/fixtures/wire/` has
 * samples without it, and the JSON-RPC envelope types already model `id` as optional.
 */

import { EapiErrorCode, ProtocolError } from '../errors'
import { MAX_RAW_BODY } from '../internal/wire'
import { redactCommands, redactWireText } from '../internal/redact'
import type { CommandSpec, JsonRpcId, JsonRpcRequest } from '../types/eapi'

/** The echoed id, when the body is a JSON object with a scalar `id`. `undefined` = cannot tell. */
function echoedId(text: string): JsonRpcId | undefined {
  let decoded: unknown
  try {
    decoded = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return undefined
  const value = (decoded as Record<string, unknown>)['id']
  return typeof value === 'string' || typeof value === 'number' ? value : undefined
}

function truncate(text: string): string {
  const redacted = redactWireText(text)
  if (redacted.length <= MAX_RAW_BODY) return redacted
  return `${redacted.slice(0, MAX_RAW_BODY)}… [truncated ${String(redacted.length - MAX_RAW_BODY)} chars]`
}

/** Commands attached to the error, redacted — an `enable` input must never reach an error object (DR-011). */
function attached(request: JsonRpcRequest): { commands: readonly CommandSpec[]; requestId: JsonRpcId } {
  return { commands: redactCommands(request.params.cmds), requestId: request.id }
}

/**
 * Throw `ProtocolError` when the reply's `id` is present and disagrees with the request it answered.
 * Called once per byte-level round trip, so the DR-012 text retry gets its own fresh id checked too.
 */
export function assertResponseIdMatches(request: JsonRpcRequest, text: string): void {
  const actual = echoedId(text)
  if (actual === undefined || String(actual) === String(request.id)) return
  throw new ProtocolError(
    `eAPI response id ${JSON.stringify(String(actual))} does not match the request id ${JSON.stringify(String(request.id))} it answered (DR-017). ` +
      'Something is replying on the device\'s behalf: a proxy cache, a second switch behind this address, or a scripted test double.',
    { ...attached(request), code: EapiErrorCode.INVALID_REQUEST, rawBody: truncate(text) },
  )
}
