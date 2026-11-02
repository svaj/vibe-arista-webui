/**
 * Wire-level failure mapping — M2 (#4), PLAN's "Error mapping" bullet.
 *
 * pyeapi has exactly two failure channels below the JSON-RPC layer (`eapilib.py:466-483`): an
 * `OSError` becomes `ConnectionError(str(self), 'Socket error during eAPI connection: …')` and a
 * `ValueError` (which is what "the body was not JSON" means in Python, including an HTML 401 page)
 * becomes `ConnectionError(…, 'unable to connect to eAPI')`. HTTP 401 is special-cased into its own
 * `ConnectionError` *before* that. So on a typo'd password pyeapi reports "unable to connect", and a
 * proxy that answers `GET` reports the same. MIGRATION.md §5 row 21 records the split.
 *
 * Here, classification is by data: the Node/undici error `code` (a stable string, even across
 * versions) with a message-pattern fallback, because a `TypeError: fetch failed` carries the real
 * cause one level down. No `node:` import is needed to read `err.code`, which keeps this module
 * reachable from the browser entry (DR-002).
 */

import {
  AuthError,
  ConnectError,
  EapiErrorCode,
  ProtocolError,
  TimeoutError,
  TlsError,
  TransportError,
  type TransportErrorOptions,
} from '../errors'
import { MAX_RAW_BODY } from '../internal/wire'
import { redactCommands, redactWireText } from '../internal/redact'
import type { CommandSpec, JsonRpcRequest } from '../types/eapi'

/** What a mapped error needs in order to be actionable in a UI (DR-005: errors carry their context). */
export interface WireErrorContext {
  /** Where the request went — quoted in the message and stored on the error. */
  readonly endpoint: string
  /** The built request, when one exists. A `/login` POST has no `runCmds` request (DR-018). */
  readonly request?: JsonRpcRequest | undefined
  /** Commands to attach, redacted on the way out — pyeapi attaches them in `execute` (`:641-644`). */
  readonly commands?: readonly CommandSpec[] | undefined
  /** The client deadline in force, so the message can name the number that expired (DR-019). */
  readonly timeoutMs?: number | undefined
}

function baseContext(ctx: WireErrorContext): TransportErrorOptions {
  const request = ctx.request
  const commands = ctx.commands ?? request?.params.cmds
  return {
    endpoint: ctx.endpoint,
    ...(request?.id === undefined ? {} : { requestId: request.id }),
    ...(commands === undefined ? {} : { commands: redactCommands(commands) }),
  }
}

/**
 * A `200` whose body is empty is a listener that answered without producing anything, not a body that
 * happens to be unparseable. Reported as `TransportError` by **both** senders (`fetch` and
 * `node:https`) so the two runtimes agree; without it `parseResponse` would call it `-32700` malformed
 * JSON and point the operator at the wrong thing. `retryable: false` because the request did reach the
 * listener, so a write may have been applied before the response went empty.
 */
export function guardEmptyResponseBody(body: string, ctx: WireErrorContext): string {
  if (body.trim() !== '') return body
  throw new TransportError(
    `eAPI at ${ctx.endpoint} answered HTTP 200 with an empty body. The listener accepted the request and produced nothing, so no command result can be reported — check the switch's eAPI state before re-sending (DR-019).`,
    { ...baseContext(ctx), status: 200, retryable: false },
  )
}

/** Body text prepared for an error message: DR-011 redaction, one line, truncation. */
export function safeBodyText(body: string): string {
  const oneLine = redactWireText(body).replace(/\s+/g, ' ').trim()
  if (oneLine === '') return '<empty response body>'
  if (oneLine.length <= MAX_RAW_BODY) return oneLine
  const hidden = oneLine.length - MAX_RAW_BODY
  return `${oneLine.slice(0, MAX_RAW_BODY)}… [truncated ${String(hidden)} chars]`
}

/**
 * An HTTP response line that is not a JSON-RPC envelope.
 *
 * - 401/403 → `AuthError`, where pyeapi raised `ConnectionError`; the body is included only after
 *   `redactWireText` + truncation, because nginx's short 401 text is genuinely useful and a proxy
 *   stack trace is genuinely not (row 26).
 * - 405/406 → `ProtocolError`: eAPI is `POST` + `application/json-rpc` only, so this is a
 *   client/proxy contract mistake, not an infrastructure one.
 * - 404 → `ProtocolError` naming the DR-036 topology, the single most common misconfiguration for
 *   the Vite dev proxy.
 * - 5xx → `TransportError`; the request **may** have reached EOS through a proxy, so `retryable`
 *   is left undefined rather than promising a safe resend.
 */
export function mapHttpStatus(
  status: number,
  statusText: string,
  body: string,
  ctx: WireErrorContext,
): TransportError | ProtocolError {
  const detail = safeBodyText(body)
  const options = baseContext(ctx)
  if (status === 401 || status === 403) {
    return new AuthError(`eAPI rejected the credentials at ${ctx.endpoint}: HTTP ${String(status)} ${statusText}. ${detail}`, {
      ...options,
      status,
    })
  }
  if (status >= 300 && status < 400) {
    // pyeapi's `http.client` never followed redirects either; following one would also silently
    // re-send credentials to a new origin, so the redirect is reported instead of obeyed.
    return new TransportError(
      `eAPI redirected at ${ctx.endpoint}: HTTP ${String(status)} ${statusText}. This client does not follow redirects for POST /command-api; point the transport at the final origin (DR-036).`,
      { ...options, status, retryable: false },
    )
  }
  if (status === 405 || status === 406) {
    return new ProtocolError(
      `eAPI does not accept this request shape at ${ctx.endpoint}: HTTP ${String(status)} ${statusText}. eAPI is POST with Content-Type application/json-rpc. ${detail}`,
      { ...options, code: EapiErrorCode.INVALID_REQUEST, rawBody: detail },
    )
  }
  if (status === 404) {
    return new ProtocolError(
      `no eAPI listener at ${ctx.endpoint}: HTTP 404 ${statusText}. Check the request path, or the dev-proxy rule that stands in for it (DR-036). ${detail}`,
      { ...options, code: EapiErrorCode.INVALID_REQUEST, rawBody: detail },
    )
  }
  if (status === 413) {
    return new TransportError(
      `eAPI refused the request body at ${ctx.endpoint}: HTTP 413 ${statusText}. Too much text for one request — split the batch (M6 #8 chunks config text for exactly this). ${detail}`,
      { ...options, status, retryable: false },
    )
  }
  if (status >= 500) {
    return new TransportError(`eAPI endpoint at ${ctx.endpoint} failed: HTTP ${String(status)} ${statusText}. ${detail}`, {
      ...options,
      status,
    })
  }
  return new TransportError(`unexpected HTTP status at ${ctx.endpoint}: ${String(status)} ${statusText}. ${detail}`, {
    ...options,
    status,
    retryable: false,
  })
}

/**
 * The error shapes we expect from `fetch`/undici and from `node:https`:
 *  - `AbortError` (a `DOMException` in undici) from an `AbortController` — our deadline, or the
 *    caller's `signal`;
 *  - `TypeError: fetch failed`, whose **`cause` carries the real syscall/TLS code** — undici wraps
 *    everything one level down, so classification must walk the chain rather than read `error.code`;
 *  - `SocketError: other side closed` (`UND_ERR_SOCKET`) or a bare `read ECONNRESET` from a listener
 *    that closed the connection mid-request;
 *  - `UND_ERR_HEADERS_TIMEOUT`/`UND_ERR_BODY_TIMEOUT` when undici's own socket timeouts win the race
 *    against our `AbortController`.
 *
 * `node:https` reports the syscall code directly (no `cause` layer), which is why the same table
 * serves both `fetch` transports and the Node transports.
 */
const TLS_CODES: readonly string[] = [
  'CERT_HAS_EXPIRED',
  'CERT_REVOKED',
  'CERT_UNTRUSTED',
  'CERT_COMMON_NAME_INVALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'HOSTNAME_MISMATCH',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNSUPPORTED_PROTOCOL',
  'WRONG_VERSION_NUMBER',
]

/** Codes that mean "the TLS layer itself failed", matched as a prefix family (`ERR_SSL_*`, `ERR_TLS_*`). */
const TLS_CODE_PREFIXES: readonly string[] = ['ERR_SSL', 'ERR_TLS']

/** Codes that mean "nothing reached the device": refused, unroutable, unresolvable, missing socket. */
const CONNECT_CODES: readonly string[] = [
  'ECONNREFUSED',
  'ECONNABORTED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'ENETRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_FAIL',
  'EAI_NONAME',
  'ENOENT',
  'EACCES',
  'EPERM',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_DESTROYED',
  'UND_ERR_CONNECT',
]

/**
 * Codes for a connection that died **after** the request was on its way: the far end hung up, reset,
 * or was torn down. `UND_ERR_SOCKET` is undici's "other side closed" and carries `bytesWritten` for
 * the whole request; a bare `ECONNRESET` is the RST equivalent from `node:https`/`net`.
 */
const HANGUP_CODES: readonly string[] = ['ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE']

/** undici's own idle/read timeouts: the request went, the answer did not come back. */
const RESPONSE_TIMEOUT_CODES: readonly string[] = ['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']

/** Cancellation, whichever layer noticed it first. */
const ABORT_CODES: readonly string[] = ['ABORT_ERROR', 'UND_ERR_ABORTED']

/** Fallback patterns, used only when there is no `code` to match — intermediaries in front of EOS vary. */
const TLS_TEXT = /\bssl\b|\btls\b|certificate|handshake|self[- ]signed|altname|cipher|record layer|wrong version number|unsupported protocol|unable to get issuer|too many certificates/i
const HANGUP_TEXT = /socket hang up|other side closed|premature close|connection reset/i
const CONNECT_TEXT = /econnrefused|enotfound|eai_again|getaddrinfo|connection refused|network unreachable|no such file or directory|unix socket/i
const TIMEOUT_TEXT = /headers timeout|body timeout/i

/** Walk the `cause` chain — undici hides the syscall code under a `TypeError: fetch failed`. */
function errorChain(error: unknown): readonly unknown[] {
  const chain: unknown[] = []
  let current: unknown = error
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
    chain.push(current)
    current = typeof current === 'object' ? (current as { cause?: unknown }).cause : undefined
  }
  return chain
}

function codesOf(chain: readonly unknown[]): string[] {
  return chain
    .map((entry) => (typeof entry === 'object' && entry !== null ? (entry as { code?: unknown }).code : undefined))
    .filter((code): code is string => typeof code === 'string')
}

function namesOf(chain: readonly unknown[]): string[] {
  return chain
    .map((entry) => (typeof entry === 'object' && entry !== null ? (entry as { name?: unknown }).name : undefined))
    .filter((name): name is string => typeof name === 'string')
}

function textsOf(chain: readonly unknown[]): string {
  return chain
    .map((entry) => {
      if (entry instanceof Error) return `${entry.name} ${entry.message}`
      if (typeof entry === 'string') return entry
      return ''
    })
    .join(' ')
}

export type WireFailureClass = 'abort' | 'tls' | 'connect' | 'hangup' | 'response-timeout' | 'unknown'

/**
 * Classify one wire failure into the taxonomy: code first, message text only as a fallback.
 *
 * Order matters. TLS is checked before connect/hangup because a failed handshake often arrives as a
 * connection-level error too, and `TlsError` (from our own fingerprint pin, `node-tls.ts`) is checked
 * before anything else so a deliberate trust decision is never reclassified as infrastructure noise.
 */
export function classifyWireFailure(error: unknown): WireFailureClass {
  const chain = errorChain(error)
  const codes = codesOf(chain)
  const names = namesOf(chain)
  const text = textsOf(chain)
  if (names.includes('TlsError')) return 'tls'
  if (names.includes('AbortError') || codes.some((code) => ABORT_CODES.includes(code.toUpperCase()))) return 'abort'
  if (codes.some((code) => TLS_CODE_PREFIXES.some((prefix) => code.startsWith(prefix)) || TLS_CODES.includes(code))) return 'tls'
  if (codes.some((code) => CONNECT_CODES.includes(code))) return 'connect'
  if (codes.some((code) => HANGUP_CODES.includes(code))) return 'hangup'
  if (codes.some((code) => RESPONSE_TIMEOUT_CODES.includes(code))) return 'response-timeout'
  if (TLS_TEXT.test(text)) return 'tls'
  if (HANGUP_TEXT.test(text)) return 'hangup'
  if (TIMEOUT_TEXT.test(text)) return 'response-timeout'
  if (CONNECT_TEXT.test(text)) return 'connect'
  return 'unknown'
}

function describeCause(error: unknown): string {
  const parts = errorChain(error)
    .map((entry) => (entry instanceof Error ? `${entry.name}: ${entry.message}`.replace(/\s+/g, ' ') : typeof entry === 'string' ? entry : ''))
    .filter((part) => part !== '')
  return parts.length > 0 ? parts.join(' caused by ') : String(error)
}

/**
 * Map a thrown wire failure to the error taxonomy. `deadlineHit` distinguishes *our* timeout
 * (`TimeoutError`, DR-019) from a caller's `AbortSignal` (`TransportError`, which is not a device
 * problem): the difference between "the switch did not answer" and "you cancelled".
 *
 * ## What `retryable` means here, and why the UI depends on it
 *
 * `true` — the request demonstrably never reached the device, so re-sending cannot double-apply a
 * write. `false` — the commands may already have run (a reset after the body was written, any
 * timeout), which for a configuration write is the only answer that matters. `undefined` — we cannot
 * tell, and the UI must say so instead of guessing. DR-019's own retry only ever fires on
 * `ConnectError`, so a `true` on another class makes a resend *safe*, not automatic.
 */
export function mapWireFailure(error: unknown, ctx: WireErrorContext, deadlineHit: boolean): TransportError {
  const options = baseContext(ctx)
  if (deadlineHit) {
    const after = ctx.timeoutMs === undefined ? '' : ` after ${String(ctx.timeoutMs)} ms`
    return new TimeoutError(
      `eAPI request to ${ctx.endpoint} timed out${after}. The device may still have applied the commands — check its state before re-sending a write (DR-019).`,
      { ...options, retryable: false },
    )
  }
  const detail = describeCause(error)
  switch (classifyWireFailure(error)) {
    case 'abort':
      return new TransportError(`eAPI request to ${ctx.endpoint} was cancelled before it completed`, { ...options, retryable: false })
    case 'tls':
      // Nothing reached the CLI, so a resend is safe — but this class is never auto-retried by
      // DR-019, because the failure is deterministic: the same trust configuration fails again.
      return new TlsError(
        `TLS failure connecting to ${ctx.endpoint}: ${detail}. EOS ships a self-signed certificate, so give this transport "ca" or "fingerprint", or — deliberately, and with a warning — "dangerouslyDisableTlsVerification" (DR-013).`,
        { ...options, retryable: true },
      )
    case 'connect':
      return new ConnectError(`cannot reach eAPI at ${ctx.endpoint}: ${detail}`, { ...options, retryable: true })
    case 'hangup':
      // The request had already been written when the far end hung up. EOS's nginx may have passed it
      // to the CLI before the socket died, so this is the one class where "retry it" can silently
      // apply a configuration twice. Conservative flag, and the message says why.
      return new TransportError(
        `the eAPI listener at ${ctx.endpoint} closed the connection mid-request: ${detail}. The commands may already have run on the switch — check its state before re-sending (DR-019).`,
        { ...options, retryable: false },
      )
    case 'response-timeout':
      return new TimeoutError(
        `the eAPI listener at ${ctx.endpoint} accepted the request and never answered it: ${detail}. The device may still have applied the commands — check its state before re-sending a write (DR-019).`,
        { ...options, retryable: false },
      )
    default:
      return new TransportError(`transport failure talking to ${ctx.endpoint}: ${detail}`, options)
  }
}
