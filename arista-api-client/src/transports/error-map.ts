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
 *  - `AbortError` from an `AbortController` (our deadline, or the caller's `signal`);
 *  - `TypeError: fetch failed`, whose `cause` carries the real syscall/TLS code;
 *  - `Error: socket hang up` / `ECONNRESET` from a listener that closed the connection mid-request.
 */
const TLS_CODES: readonly string[] = [
  'CERT_HAS_EXPIRED',
  'CERT_REVOKED',
  'CERT_UNTRUSTED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
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
  'ENOENT',
  'EACCES',
  'EPERM',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_DESTROYED',
  'UND_ERR_CONNECT',
]

const HANGUP_CODES: readonly string[] = ['ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE']

/** Fallback patterns, used only when there is no `code` to match — intermediaries in front of EOS vary. */
const TLS_TEXT = /\bssl\b|\btls\b|certificate|handshake|self[- ]signed|altname|cipher|record layer|wrong version number|unsupported protocol/i
const HANGUP_TEXT = /socket hang up|other side closed|premature close|connection reset/i
const CONNECT_TEXT = /econnrefused|enotfound|eai_again|getaddrinfo|connection refused|network unreachable|no such file or directory|unix socket/i

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

export type WireFailureClass = 'abort' | 'tls' | 'connect' | 'hangup' | 'unknown'

/** Classify one wire failure into the taxonomy: code first, message text only as a fallback. */
export function classifyWireFailure(error: unknown): WireFailureClass {
  const chain = errorChain(error)
  const codes = codesOf(chain)
  const text = textsOf(chain)
  if (namesOf(chain).includes('AbortError')) return 'abort'
  if (codes.some((code) => TLS_CODE_PREFIXES.some((prefix) => code.startsWith(prefix)) || TLS_CODES.includes(code))) return 'tls'
  if (codes.some((code) => CONNECT_CODES.includes(code))) return 'connect'
  if (codes.some((code) => HANGUP_CODES.includes(code))) return 'hangup'
  if (TLS_TEXT.test(text)) return 'tls'
  if (HANGUP_TEXT.test(text)) return 'hangup'
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
      return new TlsError(
        `TLS failure connecting to ${ctx.endpoint}: ${detail}. EOS ships a self-signed certificate, so give this transport "ca" or "fingerprint", or — deliberately, and with a warning — "dangerouslyDisableTlsVerification" (DR-013).`,
        options,
      )
    case 'connect':
      return new ConnectError(`cannot reach eAPI at ${ctx.endpoint}: ${detail}`, { ...options, retryable: true })
    case 'hangup':
      return new TransportError(`the eAPI listener at ${ctx.endpoint} closed the connection mid-request: ${detail}`, {
        ...options,
        retryable: true,
      })
    default:
      return new TransportError(`transport failure talking to ${ctx.endpoint}: ${detail}`, options)
  }
}
