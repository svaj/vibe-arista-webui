/**
 * `FetchTransport` / `HttpTransport` — M2 (#4), the browser-safe half of the transport set
 * (DR-002). pyeapi's `HttpEapiConnection` and `HttpsEapiConnection` (`eapilib.py:600-645`) are the
 * behaviour being ported; the `http.client` plumbing under them is not (`MIGRATION.md` §7).
 *
 * Both kinds run on global `fetch`, which is why they live behind **both** entry points: Node ≥ 20
 * has it (`engines.node >= 20`, DR-021). No `node:` import appears in this file — that is what
 * `src/browser-safety.test.ts` and the Vite build guard enforce (DR-002).
 */

import { ProtocolError, TransportError } from '../errors'
import { authorizationHeader } from './auth'
import { assertCleartextAllowed } from './local'
import { TransportBase, idPolicyFrom, type RawSend, type TransportKernel } from './base'
import {
  DEFAULT_HTTP_PORT,
  DEFAULT_HTTPS_PORT,
  type CredentialOptions,
  type HttpTransportOptions,
  type HttpsTransportOptions,
  type TransportBaseOptions,
} from './contract'
import { resolveEndpoint, type ResolvedEndpoint, type ResolveEndpointDefaults } from './endpoint'
import { mapHttpStatus, mapWireFailure } from './error-map'
import type { JsonRpcRequest } from '../types/eapi'

/** The header eAPI documents and pyeapi sends (`eapilib.py:432`): `application/json-rpc`. */
export const EAPI_CONTENT_TYPE = 'application/json-rpc'

/**
 * One byte-level round trip over `fetch`, with the DR-019 deadline attached here (not per
 * connection) so a caller can override it per command batch.
 */
export function createFetchSender(endpoint: ResolvedEndpoint, credentials: CredentialOptions): RawSend {
  const auth = authorizationHeader(credentials)
  const address = endpoint.address
  return async function send(request: JsonRpcRequest, ctx): Promise<string> {
    const controller = new AbortController()
    let deadlineHit = false
    const timer = setTimeout(() => {
      deadlineHit = true
      controller.abort()
    }, ctx.timeoutMs)
    const signal = ctx.signal
    if (signal !== undefined) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', () => controller.abort(), { once: true })
    }
    const context = { endpoint: address, request, timeoutMs: ctx.timeoutMs }
    try {
      const response = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'Content-Type': EAPI_CONTENT_TYPE,
          ...(auth === undefined ? {} : { Authorization: auth }),
        },
        // `Content-Length` is computed by fetch from the string body; pyeapi sets it by hand because
        // `http.client` would otherwise use chunked encoding, which EOS's nginx rejects.
        body: JSON.stringify(request),
        signal: controller.signal,
        // A 3xx is reported, not obeyed: re-posting credentials to a redirect target is worse than
        // an error, and `http.client` (pyeapi) never followed one either.
        redirect: 'manual',
      })
      const body = await response.text()
      if (response.status >= 300) {
        // Thrown on purpose: a non-2xx body is not an eAPI envelope, so it must not reach
        // `parseResponse` and be reported as malformed JSON. (pyeapi parses first, which is why a
        // wrong password there surfaces as "unable to connect to eAPI" — MIGRATION.md §5 row 21.)
        throw mapHttpStatus(response.status, response.statusText, body, context)
      }
      return body
    } catch (error) {
      // Anything `mapHttpStatus` already typed stays typed — a 401 must not be re-classified as a
      // socket problem on the way past this catch.
      if (error instanceof TransportError || error instanceof ProtocolError) throw error
      throw mapWireFailure(error, context, deadlineHit)
    } finally {
      clearTimeout(timer)
    }
  }
}

function commonKernelOptions(options: TransportBaseOptions) {
  return {
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.trace === undefined ? {} : { trace: options.trace }),
    ids: idPolicyFrom(options),
  }
}

function fetchKernel(kind: 'https' | 'http', options: HttpsTransportOptions | HttpTransportOptions): TransportKernel {
  const defaults: ResolveEndpointDefaults =
    kind === 'https' ? { scheme: 'https', port: DEFAULT_HTTPS_PORT } : { scheme: 'http', port: DEFAULT_HTTP_PORT }
  const endpoint = resolveEndpoint(options, defaults)
  return {
    kind,
    address: endpoint.address,
    send: createFetchSender(endpoint, options),
    ...commonKernelOptions(options),
  }
}

/**
 * `kind: 'https'` over `fetch`. **TLS trust is not configurable here** (DR-013): from a browser the
 * only answers are "the CA already trusts the device cert" or "a Node proxy in front of it does"
 * (DR-036), and passing `ca`/`fingerprint`/`dangerouslyDisableTlsVerification` to the browser entry is
 * a mistake — caught at compile time by the `never` keys on the option type, and at runtime below.
 */
export class FetchTransport extends TransportBase {
  constructor(options: HttpsTransportOptions = { kind: 'https' }) {
    super(fetchKernel('https', options))
  }
}

/**
 * `kind: 'http'`, cleartext. Restricted to loopback, or an explicit `allowInsecureTransport: true`
 * that warns once per process. pyeapi has no such gate: `connection: test1 transport = http` in
 * `eapi.conf` silently sends `Authorization: Basic …` across a LAN (`MIGRATION.md` §5 row 27).
 */
export class HttpTransport extends TransportBase {
  constructor(options: HttpTransportOptions) {
    super(cleartextKernel(options))
  }
}

function cleartextKernel(options: HttpTransportOptions): TransportKernel {
  const kernel = fetchKernel('http', options)
  // Read the *resolved* target back off the kernel, so the gate decides on the host that is really
  // being contacted — including one that arrived through `baseUrl` rather than `host`.
  const target = new URL(kernel.address)
  assertCleartextAllowed(target.hostname, Number(target.port), kernel.address, options.allowInsecureTransport)
  return kernel
}
