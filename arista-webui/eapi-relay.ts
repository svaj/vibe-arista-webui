/**
 * The #140a runtime-eAPI relay — a Vite **dev-server** plugin that lets the browser install a
 * same-origin `/command-api` target at runtime (connect screen → POST → in-memory target →
 * forwarded eAPI), so a fresh clone can connect a switch without `.env.local` + restart.
 *
 * Contract and rationale live in `src/eapi/relay-protocol.ts` (shared, browser-safe). This file is
 * the Node half only: it is imported by `vite.config.ts`, never by app source, so nothing here can
 * reach the browser bundle — the same boundary that keeps node:buffer out of `src/`.
 *
 * Trust posture (DR-143):
 * - The relay exists only on the dev server, which this config binds to `127.0.0.1`. Same-machine
 *   operator == the same trust model as today's env-var proxy; no new network surface.
 * - Credentials live in this module's closure ONLY: never written to disk, never echoed by
 *   `status`, never logged (the request body is buffered, forwarded, and dropped).
 * - While the env-var proxy is configured the relay is inert by design: `setup` answers 409 and
 *   `/command-api` falls through to the boot-time proxy, so the dev/e2e/CI lanes can never be
 *   silently re-pointed by a browser POST.
 * - The upstream hop mirrors the env-var proxy EXACTLY: `https` + no certificate verification
 *   (`secure:false` ≡ `rejectUnauthorized:false`) — DR-036's trade-off, moved from a config file
 *   to a form field on the same machine, not widened.
 */
import { Buffer } from 'node:buffer'
import https from 'node:https'
import type { OutgoingHttpHeaders } from 'node:http'
import type { Duplex, Readable } from 'node:stream'
import type { Plugin } from 'vite'

import {
  RELAY_ENDPOINTS,
  RELAY_UPSTREAM_TIMEOUT_MS,
  validateRelayCredentials,
  validateRelayHost,
  type RelayStatus,
} from './src/eapi/relay-protocol.js'

/** The env-var proxy's content type for eAPI (the relay must not rewrite what the device reads). */
const EAPI_CONTENT_TYPE = 'application/json-rpc'

/** Cap on the connect form body: three short strings — a bigger POST is not this endpoint's job. */
const SETUP_BODY_LIMIT_BYTES = 16 * 1024
/** Cap on a forwarded command batch: generous for `show running-config all` re-reads, finite. */
const COMMAND_BODY_LIMIT_BYTES = 8 * 1024 * 1024

interface RelayTargetState {
  readonly hostname: string
  readonly port: number
  readonly display: string
  readonly username: string
  readonly authorization: string
}

/** Minimal shapes of the connect middleware trio — real values are node's req/res; tests pass stubs. */
export interface RelayRequest {
  readonly url?: string
  readonly method?: string
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown
  on(event: 'end' | 'error', listener: (arg?: unknown) => void): unknown
}

export interface RelayResponse {
  readonly headersSent: boolean
  writeHead(status: number, headers?: OutgoingHttpHeaders): unknown
  end(chunk?: Uint8Array | string): unknown
  destroy(error?: Error): unknown
}

export type RelayNext = () => void

/** The slice of `https.request` the relay uses — injectable so tests never open a socket. */
export type UpstreamRequest = (
  options: https.RequestOptions & { rejectUnauthorized?: boolean; timeout?: number },
  onResponse: (response: Readable & { statusCode?: number; headers: OutgoingHttpHeaders }) => void,
) => Pick<Duplex, 'on' | 'write' | 'end' | 'destroy'>

export interface RelayMiddlewareOptions {
  /** True when `createEapiProxy(env)` produced a boot-time proxy — status says `env`, relay stays inert. */
  readonly envProxyConfigured: boolean
  /** Injected for tests; production always dials with node:https. */
  readonly upstreamRequest?: UpstreamRequest
}

export type RelayMiddleware = (req: RelayRequest, res: RelayResponse, next: RelayNext) => void

/**
 * The middleware proper, exported apart from the plugin so it is unit-testable without a Vite
 * server. Route table (also what `relayEndpoints()` documents for the README):
 *
 * | route                       | behavior                                                            |
 * |-----------------------------|---------------------------------------------------------------------|
 * | `GET  /__eapi/status`       | `{configured: 'env' \| 'runtime' \| null, host?, username?}`        |
 * | `POST /__eapi/setup`        | installs the runtime target (409 while env owns the server)         |
 * | `POST /__eapi/disconnect`   | drops it                                                            |
 * | `POST /command-api`         | forwards ONLY while a runtime target is installed; else `next()`     |
 * | anything else / bad method  | `next()` (unchanged dev-server behavior) or 405 on relay routes      |
 */
export function createRelayMiddleware(options: RelayMiddlewareOptions): RelayMiddleware {
  const dail = options.upstreamRequest ?? defaultUpstreamRequest
  let state: RelayTargetState | null = null

  return function relay(req, res, next) {
    const path = (req.url ?? '').split('?')[0] ?? ''
    const method = req.method ?? 'GET'

    if (path === RELAY_ENDPOINTS.status) {
      if (method !== 'GET') return sendJson(res, 405, { error: 'status-is-get-only' })
      const status: RelayStatus = options.envProxyConfigured
        ? { configured: 'env' }
        : state !== null
          ? { configured: 'runtime', host: state.display, username: state.username }
          : { configured: null }
      return sendJson(res, 200, status)
    }

    // Everything below is the runtime path; the env-var proxy keeps authority while configured.
    if (options.envProxyConfigured) {
      if (path === RELAY_ENDPOINTS.setup || path === RELAY_ENDPOINTS.disconnect) {
        // The screen renders this refusal too (env banner); on the wire so no client decides policy.
        return sendJson(res, 409, { error: 'env-proxy-authoritative' })
      }
      return next()
    }

    if (path === RELAY_ENDPOINTS.setup || path === RELAY_ENDPOINTS.disconnect) {
      if (method !== 'POST') return sendJson(res, 405, { error: 'relay-setups-are-post-only' })
      if (path === RELAY_ENDPOINTS.disconnect) {
        state = null
        return sendJson(res, 200, { configured: null })
      }
      if (!isJsonRequest(req)) return sendJson(res, 415, { error: 'setup-expects-application-json' })
      void readCapped(req, SETUP_BODY_LIMIT_BYTES).then((body) => {
        if (!body.ok) return sendJson(res, body.status, { error: body.code })
        let parsed: unknown
        try {
          parsed = JSON.parse(body.text)
        } catch {
          return sendJson(res, 400, { error: 'setup-body-is-not-json' })
        }
        const record = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : undefined
        if (record === undefined) return sendJson(res, 400, { error: 'setup-body-is-not-an-object' })
        const keys = Object.keys(record)
        // Strict allow-list: silence about unknown fields would hide client bugs (DR-016 posture).
        if (!keys.every((key) => key === 'host' || key === 'username' || key === 'password')) {
          return sendJson(res, 400, { error: 'setup-body-carries-unknown-or-missing-fields' })
        }
        const hostCheck = validateRelayHost(String(record['host'] ?? ''))
        if (!hostCheck.ok) return sendJson(res, 400, { error: 'invalid-host', refusal: hostCheck.refusal })
        const credentialCheck = validateRelayCredentials(record['username'], record['password'])
        if (!credentialCheck.ok) return sendJson(res, 400, { error: 'invalid-credentials', refusal: credentialCheck.refusal })
        state = {
          hostname: hostCheck.target.hostname,
          port: hostCheck.target.port,
          display: hostCheck.target.display,
          username: credentialCheck.username,
          // Same Basic encoding the env-var proxy precomputes at boot (vite.config.ts).
          authorization: `Basic ${Buffer.from(`${credentialCheck.username}:${credentialCheck.password}`, 'utf8').toString('base64')}`,
        }
        // Echo only what status would: proving the install is also the password's only trip back,
        // and it does not ride along.
        return sendJson(res, 200, { configured: 'runtime', host: state.display, username: state.username })
      })
      return undefined
    }

    if (path === RELAY_ENDPOINTS.commandApi) {
      if (state === null) return next() // inert: exactly today's behavior (vite 404 or env proxy).
      if (method !== 'POST') return sendJson(res, 405, { error: 'eapi-is-post-only' })
      forwardEapi(dail, state, req, res)
      return undefined
    }

    return next()
  }
}

/** The plugin. `env-proxy-authoritative` logic lives in the middleware, not here. */
export function eapiRelayPlugin(pluginOptions: { envProxyConfigured: boolean }): Plugin {
  const middleware = createRelayMiddleware(pluginOptions)
  return {
    name: 'eapi-runtime-relay',
    configureServer(server) {
      // configureServer middlewares run BEFORE Vite's internal proxy middleware — required: a
      // runtime target must win its own route, and with env configured the relay never accepts one.
      // The cast is the seam between node's `IncomingMessage/ServerResponse` (what connect sends,
      // and what satisfies our read side) and the deliberately-loose `RelayRequest/RelayResponse`
      // (what the unit tests drive without a socket).
      server.middlewares.use(middleware as unknown as (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, next: () => void) => void)
    },
  }
}

function forwardEapi(dail: UpstreamRequest, state: RelayTargetState, req: RelayRequest, res: RelayResponse): void {
  void readCapped(req, COMMAND_BODY_LIMIT_BYTES).then((body) => {
    if (!body.ok) return sendJson(res, body.status, { error: body.code })
    const upstream = dail(
      {
        hostname: state.hostname,
        port: state.port,
        path: RELAY_ENDPOINTS.commandApi,
        method: 'POST',
        headers: {
          'content-type': EAPI_CONTENT_TYPE,
          'content-length': String(body.bytes),
          authorization: state.authorization,
        },
        // Mirrors the env-var proxy's `secure: false` — self-signed device certs are the norm (DR-036).
        rejectUnauthorized: false,
        timeout: RELAY_UPSTREAM_TIMEOUT_MS,
      },
      (upstreamResponse) => {
        const headers: OutgoingHttpHeaders = {
          // `content-type` can arrive as number|string|string[] by the header type; the device only
          // ever sends one string, and String() keeps the forwarded value honest without lying types.
          'content-type': String(upstreamResponse.headers['content-type'] ?? 'application/json'),
        }
        res.writeHead(upstreamResponse.statusCode ?? 502, headers)
        upstreamResponse.pipe(res as unknown as NodeJS.WritableStream)
      },
    )
    // Node only *emits* the socket idle timeout; destroying with a coded error both aborts the
    // dial and gives the browser-facing 502 an honest `code` instead of "unknown".
    upstream.on('timeout', () => upstream.destroy(Object.assign(new Error('relay-upstream-timeout'), { code: 'ETIMEDOUT' })))
    upstream.on('error', (error: unknown) => {
      if (res.headersSent) return res.destroy(error instanceof Error ? error : undefined)
      // Codes and short sentences only — an upstream Error message never carries our credentials,
      // but its `cause` chain could echo request context; we forward nothing but the shape.
      const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code) : 'unknown'
      return sendJson(res, 502, { error: 'relay-upstream-failed', code })
    })
    upstream.end(body.raw)
  })
}

/** The production dial: node:https with the certificate posture of the env-var proxy. ClientRequest
 * satisfies the used surface (`on`/`write`/`end`/`destroy`); the cast is the seam that lets tests
 * substitute a PassThrough instead of pretending node's request is a duplex. */
const defaultUpstreamRequest: UpstreamRequest = (opts, onResponse) =>
  https.request(opts, (response) => onResponse(response as Readable & { statusCode?: number; headers: OutgoingHttpHeaders })) as unknown as Pick<Duplex, 'on' | 'write' | 'end' | 'destroy'>

function isJsonRequest(req: RelayRequest): boolean {
  const value = req.headers['content-type']
  const single = Array.isArray(value) ? value[0] : value
  return typeof single === 'string' && single.trim().toLowerCase().startsWith('application/json')
}

interface BodyOk { readonly ok: true; readonly text: string; readonly bytes: number; readonly raw: Buffer }
interface BodyFail { readonly ok: false; readonly status: number; readonly code: string }

function readCapped(req: RelayRequest, limit: number): Promise<BodyOk | BodyFail> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (outcome: BodyOk | BodyFail): void => {
      if (settled) return
      settled = true
      resolve(outcome)
    }
    req.on('data', (chunk) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
      size += buf.length
      if (size > limit) {
        settled = true
        return finish({ ok: false, status: 413, code: 'payload-too-large' })
      }
      chunks.push(buf)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      finish({ ok: true, text: raw.toString('utf8'), bytes: raw.length, raw })
    })
    req.on('error', () => finish({ ok: false, status: 400, code: 'body-stream-error' }))
  })
}

function sendJson(res: RelayResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' })
  res.end(text)
}
