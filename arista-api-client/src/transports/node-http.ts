/**
 * The Node byte-level sender — M2 (#4). `node:http` / `node:https` rather than `fetch`, so that the
 * things only the Node entry can do are expressible: a unix socket (`socketPath`), the DR-013 trust
 * material, a `Cookie` header the cookie transports own, and `Set-Cookie` read back verbatim
 * (DR-018 — the fetch response hides `Set-Cookie` behind a guard in browsers, and Node's undici has a
 * different redirect/cert surface again). Deterministic, and it behaves identically under tests.
 *
 * pyeapi equivalent: the `http.client.HTTPConnection`/`HTTPSConnection` subclasses at
 * `eapilib.py:170-273`, which are dropped on purpose (MIGRATION.md §7) in favour of this one function.
 *
 * Node-only: this file imports `node:*` and is reachable **only** from `src/node.ts`.
 */

import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import { request as httpsRequest, type RequestOptions } from 'node:https'
import { Buffer } from 'node:buffer'

import type { JsonRpcRequest } from '../types/eapi'
import { authorizationHeader } from './auth'
import { idPolicyFrom, type RawSend, type TransportKernel } from './base'
import type { CredentialOptions, TlsMaterialOptions, TransportBaseOptions, TransportKind } from './contract'
import { guardEmptyResponseBody, mapHttpStatus, mapWireFailure, type WireErrorContext } from './error-map'
import { EAPI_CONTENT_TYPE } from './fetch'
import { resolveTlsConnect, type NodeTlsConnect, type TlsMode } from './node-tls'
import type { ResolvedEndpoint } from './endpoint'

export interface NodeCallOptions {
  readonly url: URL
  readonly body: string
  /** Extra request headers (cookies, `Host` overrides). `Content-Type`/`Authorization` are added by the caller. */
  readonly headers?: Readonly<Record<string, string>> | undefined
  readonly socketPath?: string | undefined
  readonly tls?: NodeTlsConnect | undefined
  readonly timeoutMs: number
  readonly signal?: AbortSignal | undefined
}

export interface NodeCallResult {
  readonly status: number
  readonly statusText: string
  readonly headers: IncomingHttpHeaders
  /** The raw `Set-Cookie` values, for the cookie transports (DR-018). No browser could read these. */
  readonly setCookies: readonly string[]
  readonly body: string
}

function abortError(): Error {
  const error = new Error('aborted by caller')
  error.name = 'AbortError'
  return error
}

/**
 * One HTTP round trip. HTTP statuses are **returned, not thrown** — the caller decides whether 401 is
 * fatal (it is) and the cookie transport needs a 200/302 answer from `/login` in hand.
 * Socket/TLS/deadline failures reject with the mapped error taxonomy.
 */
export function nodeCall(options: NodeCallOptions, context: WireErrorContext): Promise<NodeCallResult> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) }
  // Node would chunk an unsized body; EOS's nginx has historically rejected chunked eAPI posts, and
  // pyeapi sets Content-Length for the same reason (`eapilib.py:433`).
  headers['Content-Length'] = String(Buffer.byteLength(options.body))
  const isHttps = options.url.protocol === 'https:'
  const target: RequestOptions = {
    protocol: options.url.protocol,
    hostname: options.url.hostname,
    port: options.url.port === '' ? undefined : Number(options.url.port),
    path: `${options.url.pathname}${options.url.search}`,
    method: 'POST',
    headers,
    ...(options.socketPath === undefined ? {} : { socketPath: options.socketPath }),
    ...(isHttps && options.tls !== undefined ? options.tls.connect : {}),
  }

  return new Promise<NodeCallResult>((resolve, reject) => {
    let deadlineHit = false
    let cancelledByCaller = false
    const request = isHttps ? httpsRequest(target, onResponse) : httpRequest(target, onResponse)

    const timer = setTimeout(() => {
      deadlineHit = true
      request.destroy()
    }, options.timeoutMs)
    // Never hold a process open for a request that is already being awaited.
    timer.unref?.()
    const onAbort = (): void => {
      cancelledByCaller = true
      request.destroy()
    }
    if (options.signal !== undefined) {
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }

    function onResponse(response: IncomingMessage): void {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.once('end', () => {
        cleanup()
        resolve({
          status: response.statusCode ?? 0,
          statusText: response.statusMessage ?? '',
          headers: response.headers,
          setCookies: response.headers['set-cookie'] ?? [],
          body: Buffer.concat(chunks).toString('utf8'),
        })
      })
      response.once('error', (error: Error) => {
        cleanup()
        reject(mapWireFailure(error, context, deadlineHit))
      })
    }

    request.once('error', (error: Error) => {
      cleanup()
      if (deadlineHit) reject(mapWireFailure(error, context, true))
      else if (cancelledByCaller) reject(mapWireFailure(abortError(), context, false))
      else reject(mapWireFailure(error, context, deadlineHit))
    })
    request.end(options.body)
  })
}

/** Headers every eAPI POST carries, mirroring pyeapi's `putheader` calls (`eapilib.py:432-436`). */
export function eapiHeaders(credentials: CredentialOptions, extra?: Readonly<Record<string, string>>): Record<string, string> {
  const auth = authorizationHeader(credentials)
  return {
    'Content-Type': EAPI_CONTENT_TYPE,
    ...(auth === undefined ? {} : { Authorization: auth }),
    ...(extra ?? {}),
  }
}

/**
 * Adapt {@link nodeCall} to M1's `WireSender` seam: build the request body, send it, and hand back raw
 * text (or the mapped failure). Statuses ≥ 300 are *thrown* here, because at this seam a non-2xx
 * answer can never be a JSON-RPC envelope.
 */
export function createNodeSender(params: {
  readonly endpoint: ResolvedEndpoint
  readonly credentials: CredentialOptions
  readonly socketPath?: string | undefined
  readonly tls?: NodeTlsConnect | undefined
  /** Per-attempt extra headers, evaluated per send — the cookie transports re-read their jar (DR-018). */
  readonly extraHeaders?: (() => Readonly<Record<string, string>>) | undefined
}): RawSend {
  const { endpoint, credentials, socketPath, tls } = params
  return async function send(request: JsonRpcRequest, ctx): Promise<string> {
    const context: WireErrorContext = { endpoint: endpoint.address, request, timeoutMs: ctx.timeoutMs }
    const response = await nodeCall(
      {
        url: endpoint.url,
        body: JSON.stringify(request),
        headers: eapiHeaders(credentials, params.extraHeaders?.()),
        ...(socketPath === undefined ? {} : { socketPath }),
        ...(tls === undefined ? {} : { tls }),
        timeoutMs: ctx.timeoutMs,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      },
      context,
    )
    if (response.status >= 300) {
      throw mapHttpStatus(response.status, response.statusText, response.body, context)
    }
    // Shared with the `fetch` sender: an empty 200 is a transport fact, not a JSON problem.
    return guardEmptyResponseBody(response.body, context)
  }
}

/**
 * The shared shape of every Node transport: resolve the DR-013 trust material once at construction
 * (so an unreadable CA fails loudly, not on the first device call), attach the per-connection id
 * policy, and let the class contribute only what is specific to its kind.
 */
export function createNodeKernel(params: {
  readonly kind: TransportKind
  readonly endpoint: ResolvedEndpoint
  readonly connection: TransportBaseOptions & CredentialOptions & TlsMaterialOptions
  readonly socketPath?: string | undefined
  readonly tlsMode?: TlsMode | undefined
  readonly description?: string | undefined
  readonly extraHeaders?: (() => Readonly<Record<string, string>>) | undefined
}): TransportKernel {
  const { kind, endpoint, connection } = params
  const tls = resolveTlsConnect(
    connection,
    { scheme: endpoint.scheme, host: endpoint.host, port: endpoint.port },
    params.tlsMode ?? 'system',
  )
  return {
    kind,
    address: endpoint.address,
    ...(params.description === undefined ? {} : { description: params.description }),
    ...(connection.timeoutMs === undefined ? {} : { timeoutMs: connection.timeoutMs }),
    ...(connection.trace === undefined ? {} : { trace: connection.trace }),
    ids: idPolicyFrom(connection),
    send: createNodeSender({
      endpoint,
      credentials: connection,
      ...(params.socketPath === undefined ? {} : { socketPath: params.socketPath }),
      tls,
      ...(params.extraHeaders === undefined ? {} : { extraHeaders: params.extraHeaders }),
    }),
  }
}
