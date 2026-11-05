/**
 * `SessionCookieTransport` — pyeapi `http_session` / `https_session`
 * (`SessionApiConnection.authentication`, `eapilib.py:713-748`, mixed into the two classes at
 * `:750-756`), M2 (#4). **Node-only** (DR-018): a cross-origin browser `fetch` cannot set `Cookie`, so
 * cookie auth is for Node scripts and the dev proxy, never the page.
 *
 * Two deliberate changes over pyeapi, both DR-018:
 *  1. `close()` sends `POST /logout`. pyeapi never logs out, so every script leaves a device-side
 *     session behind. The EOS `/logout` contract is **not** in pyeapi and has not been verified on
 *     4.28 (it is a STATUS.md §3 sweep item), so the call is best-effort: a failure is warned about,
 *     and `close()` never throws — cleanup must not mask the error the caller is already handling.
 *  2. A failed `/login` becomes `AuthError` **without echoing the response body**. pyeapi raises
 *     `ConnectionError('%s. %s' % (resp.reason, resp.read()))`, which puts whatever the login page
 *     said (including, on some builds, an echoed form field) into the exception message. Recorded as
 *     MIGRATION.md §5 row 26.
 *
 * `POST /login` body and headers are kept byte-compatible with pyeapi: exactly
 * `{"username":…,"password":…}` and `Content-Type: application/json`.
 *
 * Node-only file.
 */

import { AuthError } from '../errors'
import { redactCommands } from '../internal/redact'
import { warnOnce } from '../internal/warn'
import type { RawWireRequest } from '../types/eapi'
import { TransportBase, idPolicyFrom, type RawSend, type RawSendContext, type TransportKernel } from './base'
import { DEFAULT_HTTPS_PORT, DEFAULT_TIMEOUT_MS, type SessionTransportOptions } from './contract'
import { resolveEndpoint, type ResolvedEndpoint } from './endpoint'
import { guardEmptyResponseBody, mapHttpStatus, type WireErrorContext } from './error-map'
import { assertCleartextAllowed } from './local'
import { nodeCall } from './node-http'
import { resolveTlsConnect, type NodeTlsConnect } from './node-tls'

/** pyeapi hard-codes these two paths in `SessionApiConnection` (`:716`) and `DEFAULT_HTTP_PATH`. */
export const LOGIN_PATH = '/login'
export const LOGOUT_PATH = '/logout'

/** A `Set-Cookie` value -> the `name=value` pair a following request must send back (attrs dropped). */
export function cookiePairs(setCookies: readonly string[]): string[] {
  return setCookies
    .map((value) => (value.split(';')[0] ?? '').trim())
    .filter((pair) => pair !== '' && pair.includes('='))
}

export class SessionCookieTransport extends TransportBase {
  constructor(options: SessionTransportOptions) {
    super(sessionKernel(options))
  }
}

function sessionKernel(options: SessionTransportOptions): TransportKernel {
  if (options.username === undefined) {
    throw new TypeError(
      "kind 'session' needs a username (and a password): pyeapi would POST {\"username\": null} to /login and let the device complain about it",
    )
  }
  const api = resolveEndpoint(options, { scheme: 'https', port: DEFAULT_HTTPS_PORT })
  const loginEndpoint = resolveEndpoint({ ...options, path: LOGIN_PATH }, { scheme: api.scheme, port: api.port })
  const logoutEndpoint = resolveEndpoint({ ...options, path: LOGOUT_PATH }, { scheme: api.scheme, port: api.port })
  if (api.scheme === 'http') {
    assertCleartextAllowed(api.host, api.port, api.address, options.allowInsecureTransport)
  }
  const tls: NodeTlsConnect = resolveTlsConnect(
    options,
    { scheme: api.scheme, host: api.host, port: api.port },
    'system',
  )

  let jar: string | undefined
  let inflight: Promise<void> | undefined

  /**
   * Deferred login: pyeapi authenticates inside the constructor, which means a credential typo is
   * reported by a constructor with no commands and no request id attached to it. Deferring to the first
   * request keeps the promise that **every** error carries its `commands` (ARCHITECTURE §4) and costs
   * nothing observable. Concurrent callers share one login (MIGRATION.md §5 row 30).
   */
  async function performLogin(request: RawWireRequest, ctx: RawSendContext): Promise<void> {
    const context: WireErrorContext = { endpoint: loginEndpoint.address, request, timeoutMs: ctx.timeoutMs }
    const body = JSON.stringify({ username: options.username, password: options.password ?? '' })
    const response = await nodeCall(
      {
        url: loginEndpoint.url,
        body,
        headers: { 'Content-Type': 'application/json' },
        tls,
        timeoutMs: ctx.timeoutMs,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      },
      context,
    )
    const attached = {
      endpoint: loginEndpoint.address,
      ...(request.id === undefined ? {} : { requestId: request.id }),
      // A M11 method call has no `cmds` to name: a login failure that happened while asking for
      // completions says so with the request id, and does not invent a command list (DR-011 keeps the
      // list redacted rather than dropped when there is one).
      commands: redactCommands(request.method === 'runCmds' ? request.params.cmds : []),
    }
    if (response.status !== 200) {
      // Body deliberately not echoed (row 26) — pyeapi's `resp.read()` there can leak an echoed field.
      throw new AuthError(
        `eAPI /login at ${loginEndpoint.address} rejected the credentials: HTTP ${String(response.status)} ${response.statusText}. The response body is not shown (DR-011/DR-018).`,
        { ...attached, status: response.status },
      )
    }
    const pairs = cookiePairs(response.setCookies)
    if (pairs.length === 0) {
      throw new AuthError(
        `eAPI /login at ${loginEndpoint.address} answered HTTP 200 with no Set-Cookie header, so there is no session to reuse on /command-api (DR-018)`,
        { ...attached, status: response.status },
      )
    }
    jar = pairs.join('; ')
    options.trace?.({
      direction: 'response',
      endpoint: loginEndpoint.address,
      requestId: String(request.id),
      // The cookie value is a credential: trace only its name, never the value (DR-011).
      body: JSON.stringify({ status: response.status, cookieNames: pairs.map((pair) => pair.split('=')[0]) }),
    })
  }

  async function ensureSession(request: RawWireRequest, ctx: RawSendContext): Promise<void> {
    if (jar !== undefined) return
    inflight ??= performLogin(request, ctx).then(
      () => {
        inflight = undefined
      },
      (error: unknown) => {
        inflight = undefined
        throw error
      },
    )
    await inflight
  }

  const send: RawSend = async (request, ctx) => {
    await ensureSession(request, ctx)
    const context: WireErrorContext = { endpoint: api.address, request, timeoutMs: ctx.timeoutMs }
    const response = await nodeCall(
      {
        url: api.url,
        body: JSON.stringify(request),
        // No `Authorization` here: this kind authenticates with the session cookie, exactly as pyeapi's
        // MRO puts `SessionApiConnection.authentication` ahead of the Basic-auth one.
        headers: { 'Content-Type': 'application/json-rpc', Cookie: jar ?? '' },
        tls,
        timeoutMs: ctx.timeoutMs,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      },
      context,
    )
    if (response.status >= 300) throw mapHttpStatus(response.status, response.statusText, response.body, context)
    // The same guard the `fetch` and `node:https` senders apply (DR-019): an empty 200 is a listener
    // that answered with nothing, and `parseResponse` calling that "malformed JSON" points the operator
    // at their own body instead of at the switch. Not applied to `/login`, where an empty 200 with a
    // `Set-Cookie` is the *expected* answer.
    return guardEmptyResponseBody(response.body, context)
  }

  async function endSession(): Promise<void> {
    const cookie = jar
    jar = undefined
    if (cookie === undefined) return
    try {
      const response = await nodeCall(
        {
          url: logoutEndpoint.url,
          body: '{}',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          tls,
          timeoutMs: DEFAULT_TIMEOUT_MS,
        },
        { endpoint: logoutEndpoint.address },
      )
      if (response.status >= 300) {
        warnOnce(
          'session-logout-status',
          `POST /logout at ${logoutEndpoint.address} answered HTTP ${String(response.status)} ${response.statusText}; the device-side session may still be open. EOS's /logout contract is unverified on 4.28 (DR-018, STATUS.md §3).`,
        )
      }
    } catch (error) {
      warnOnce(
        'session-logout-failed',
        `POST /logout at ${logoutEndpoint.address} failed: ${error instanceof Error ? error.message : String(error)}. The device-side session may still be open (DR-018).`,
      )
    }
  }

  return {
    kind: 'session',
    address: api.address,
    description: describeSession(api),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.trace === undefined ? {} : { trace: options.trace }),
    ids: idPolicyFrom(options),
    send,
    onClose: endSession,
  }
}

/** pyeapi's `__str__` for a session connection is the plain endpoint string; keep the cookie state out of it. */
function describeSession(api: ResolvedEndpoint): string {
  return `${api.address} (session)`
}
