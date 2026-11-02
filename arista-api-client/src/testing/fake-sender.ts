/**
 * The M1 request-side fake (issue #3). `WireSender` is the seam the codec needs in order to
 * re-issue a request for the DR-012 `1003` → `format: 'text'` retry, and M1 owns **no** transport
 * (`FetchTransport`, TLS, cookies, unix sockets and the full `MockTransport` are M2, #4).
 *
 * A fake instead of a real sender keeps `npm test` offline (DR-034) and gives M2/M4 the same
 * assertion surface they will want later: the exact `JsonRpcRequest` objects the codec produced,
 * in order, including the id each attempt used.
 */

import type { JsonRpcRequest, WireSender } from '../types/eapi'

export interface FakeSender {
  /** Pass this to `sendRequest` / `runRequest`. */
  readonly sender: WireSender
  /** Every request the codec sent, in send order — the primary assertion surface. */
  readonly requests: readonly JsonRpcRequest[]
  /** Append more response bodies (e.g. the `format: 'text'` answer a 1003 retry should receive). */
  queue(...bodies: readonly string[]): void
}

/**
 * Script raw response **text**, not objects: `parseResponse` stays the only place that validates a
 * device answer, so a fake cannot accidentally invent an envelope shape EOS never sends.
 * Running out of scripted bodies throws loudly — never an implicit `{}` (docs/TESTING.md §3).
 */
export function createFakeSender(bodies: readonly string[] = []): FakeSender {
  const pending = [...bodies]
  const requests: JsonRpcRequest[] = []
  const sender: WireSender = {
    send(request: JsonRpcRequest): string {
      requests.push(request)
      const body = pending.shift()
      if (body === undefined) {
        throw new Error(`fake sender has no scripted response for request ${JSON.stringify(request)}`)
      }
      return body
    },
  }
  return { sender, requests, queue: (...more: readonly string[]) => void pending.push(...more) }
}
