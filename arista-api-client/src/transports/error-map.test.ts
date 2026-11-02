/**
 * The wire-failure taxonomy — M2 (#4), PLAN's "Error mapping" bullet.
 *
 * pyeapi has two failure channels below HTTP and one error class for both: an `OSError` becomes
 * `ConnectionError(str(self), 'Socket error during eAPI connection: …')` and a `ValueError` (which is
 * what "the body was not JSON" means in Python) becomes
 * `ConnectionError(str(self), 'unable to connect to eAPI')` (`eapilib.py:473-483`). Upstream
 * therefore reports a typo'd password, an unreachable switch and a proxy HTML page with the same
 * sentence, and tells the caller nothing about whether the switch saw the request.
 *
 * This file pins the replacement: classification by **error code** (stable across Node versions), the
 * `cause` chain unwrapped (undici hides the syscall code one level down inside `TypeError: fetch
 * failed`), and `retryable` asserted for every class because it is the field a UI uses to decide
 * whether to say "this configuration write may have landed" (DR-019).
 *
 * These are constructed errors, not loopback traffic — the live shapes are asserted in
 * `fetch.test.ts` (refused port, both mid-request teardowns, TLS) and `node-tls.test.ts`.
 */

import { describe, expect, it } from 'vitest'

import { AuthError, ConnectError, ProtocolError, TimeoutError, TlsError, TransportError } from '../errors'
import { MAX_RAW_BODY } from '../internal/wire'
import { REDACTED } from '../internal/redact'
import { buildRequest } from '../internal/wire'
import {
  classifyWireFailure,
  guardEmptyResponseBody,
  mapHttpStatus,
  mapWireFailure,
  safeBodyText,
  type WireErrorContext,
} from './error-map'

const ctx: WireErrorContext = { endpoint: 'https://sw1.lan:443/command-api', timeoutMs: 60_000 }

/** Shaped like undici: a `TypeError: fetch failed` whose `cause` carries the real code. */
function undici(name: string, message: string, code?: string): Error {
  const cause = Object.assign(new Error(message), code === undefined ? {} : { code })
  return Object.assign(new TypeError('fetch failed'), { cause, name })
}

/** Shaped like `node:https`/`net`: the syscall error, unwrapped. */
function syscall(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

describe('classification is by code, with the cause chain unwrapped (undici buries it)', () => {
  const cases: readonly [string, unknown, string][] = [
    // "nothing reached the device"
    ['ECONNREFUSED via fetch', undici('TypeError', 'connect ECONNREFUSED 127.0.0.1:443', 'ECONNREFUSED'), 'connect'],
    ['ECONNREFUSED via node', syscall('connect ECONNREFUSED 10.0.0.9:443', 'ECONNREFUSED'), 'connect'],
    ['ENOTFOUND (DNS)', undici('TypeError', 'getaddrinfo ENOTFOUND sw1.lan', 'ENOTFOUND'), 'connect'],
    ['EAI_AGAIN (DNS temporarily broken)', syscall('getaddrinfo EAI_AGAIN sw1.lan', 'EAI_AGAIN'), 'connect'],
    ['EAI_FAIL', syscall('getaddrinfo EAI_FAIL sw1.lan', 'EAI_FAIL'), 'connect'],
    ['EHOSTUNREACH', syscall('connect EHOSTUNREACH 10.0.0.9:443', 'EHOSTUNREACH'), 'connect'],
    ['ENETUNREACH', syscall('connect ENETUNREACH 10.0.0.9:443', 'ENETUNREACH'), 'connect'],
    ['ENOENT (no unix socket at that path)', syscall('ENOENT: no such file or directory, connect', 'ENOENT'), 'connect'],
    ['EACCES (socket exists, not ours)', syscall('EACCES: permission denied, connect', 'EACCES'), 'connect'],
    ['undici connect timeout', syscall('Connect Timeout Error', 'UND_ERR_CONNECT_TIMEOUT'), 'connect'],
    // "the connection died after we sent the request"
    ['UND_ERR_SOCKET (other side closed)', undici('TypeError', 'other side closed', 'UND_ERR_SOCKET'), 'hangup'],
    ['ECONNRESET (RST)', undici('TypeError', 'read ECONNRESET', 'ECONNRESET'), 'hangup'],
    ['EPIPE (write to a dead socket)', syscall('EPIPE: broken pipe, write', 'EPIPE'), 'hangup'],
    ['ERR_STREAM_PREMATURE_CLOSE', syscall('Premature close', 'ERR_STREAM_PREMATURE_CLOSE'), 'hangup'],
    // "the request went, the answer never came"
    ['undici headers timeout', syscall('Headers Timeout Error', 'UND_ERR_HEADERS_TIMEOUT'), 'response-timeout'],
    ['undici body timeout (truncated response)', syscall('Body Timeout Error', 'UND_ERR_BODY_TIMEOUT'), 'response-timeout'],
    // TLS trust failures — every shape the handshake can fail in
    ['DEPTH_ZERO_SELF_SIGNED_CERT', syscall('self-signed certificate', 'DEPTH_ZERO_SELF_SIGNED_CERT'), 'tls'],
    ['SELF_SIGNED_CERT_IN_CHAIN', syscall('self-signed certificate in certificate chain', 'SELF_SIGNED_CERT_IN_CHAIN'), 'tls'],
    ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', syscall('unable to get local issuer certificate', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'), 'tls'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', syscall('unable to verify the first certificate', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'), 'tls'],
    ['CERT_HAS_EXPIRED', syscall('certificate has expired', 'CERT_HAS_EXPIRED'), 'tls'],
    ['CERT_REVOKED', syscall('certificate revoked', 'CERT_REVOKED'), 'tls'],
    ['ERR_TLS_CERT_ALTNAME_INVALID (host mismatch)', syscall('Hostname/IP does not match certificate altnames', 'ERR_TLS_CERT_ALTNAME_INVALID'), 'tls'],
    ['ERR_SSL_WRONG_VERSION_NUMBER', syscall('wrong version number', 'ERR_SSL_WRONG_VERSION_NUMBER'), 'tls'],
    ['ERR_SSL_DEPTH_EXCEEDED (chain too long)', syscall('chain too long', 'ERR_SSL_DEPTH_EXCEEDED'), 'tls'],
    ['WRONG_VERSION_NUMBER', syscall('wrong version number', 'WRONG_VERSION_NUMBER'), 'tls'],
    ['our own TlsError stays TLS', new TlsError('pinned fingerprint did not match'), 'tls'],
    // cancellation
    ['AbortError from our deadline', Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }), 'abort'],
    ['AbortError nested under fetch failed', undici('TypeError', 'The operation was aborted', 'DOMException_READ_ABORTED'), 'abort'],
    ['UND_ERR_ABORTED', syscall('The operation was aborted', 'UND_ERR_ABORTED'), 'abort'],
    // unmatched
    ['a plain Error nobody recognises', new Error('something odd happened in a middleware'), 'unknown'],
  ]

  for (const [label, error, expected] of cases) {
    it(`${label} → ${expected}`, () => {
      expect(classifyWireFailure(error)).toBe(expected)
    })
  }

  it('walks more than one cause level, because intermediaries wrap twice', () => {
    const deep = undici('TypeError', 'fetch failed')
    const middle = Object.assign(new Error('socket error'), { cause: syscall('read ECONNRESET', 'ECONNRESET') })
    // The `cause` of the outer TypeError is itself a wrapper with its own code-less message, and the
    // real code lives one level deeper: `classifyWireFailure` must find it.
    Object.assign(deep, { cause: middle })
    expect(classifyWireFailure(deep)).toBe('hangup')
  })

  it('falls back to message text only when there is no code to match', () => {
    // An intermediary in front of EOS (a load balancer, a Java proxy) rewrites the error and loses
    // `code`; the text patterns are the documented last resort, not the primary rule.
    expect(classifyWireFailure(new Error('socket hang up'))).toBe('hangup')
    expect(classifyWireFailure(new Error('getaddrinfo ENOTFOUND sw1'))).toBe('connect')
    expect(classifyWireFailure(new Error('unable to get local issuer certificate'))).toBe('tls')
    expect(classifyWireFailure(new Error('a totally unrelated failure'))).toBe('unknown')
  })
})

describe('the mapped error, per class: type, retryable, and the context a UI needs', () => {
  it('ECONNREFUSED → ConnectError, retryable true (nothing can have executed)', () => {
    const failure = mapWireFailure(syscall('connect ECONNREFUSED 10.0.0.9:443', 'ECONNREFUSED'), { ...ctx, request: buildRequest('vlan 42', { id: 'r-1' }) }, false)
    expect(failure).toBeInstanceOf(ConnectError)
    expect(failure.retryable).toBe(true)
    expect(failure.endpoint).toBe('https://sw1.lan:443/command-api')
    expect(failure.requestId).toBe('r-1')
    expect(failure.commands).toEqual(['vlan 42'])
    expect(failure.message).toMatch(/cannot reach eAPI/u)
  })

  it('a mid-request close → TransportError, retryable false (the write may have landed)', () => {
    const failure = mapWireFailure(undici('TypeError', 'other side closed', 'UND_ERR_SOCKET'), { ...ctx, request: buildRequest('vlan 42', { id: 'r-2' }) }, false)
    expect(failure).toBeInstanceOf(TransportError)
    expect(failure).not.toBeInstanceOf(ConnectError)
    expect(failure.retryable).toBe(false)
    expect(failure.message).toMatch(/may already have run/u)
    expect(failure.message).toMatch(/DR-019/u)
    expect(failure.commands).toEqual(['vlan 42'])
  })

  it('a TLS trust failure → TlsError naming the DR-013 remedies, and is never auto-retried', () => {
    const failure = mapWireFailure(syscall('self-signed certificate', 'DEPTH_ZERO_SELF_SIGNED_CERT'), { ...ctx, request: buildRequest('show version', { id: 'r-3' }) }, false)
    expect(failure).toBeInstanceOf(TlsError)
    // Safe to resend (the handshake never let a command through) — but DR-019's retry only fires on
    // ConnectError, because a trust problem is deterministic: the same configuration fails again.
    expect(failure.retryable).toBe(true)
    expect(failure.message).toMatch(/dangerouslyDisableTlsVerification/u)
    expect(failure.message).toMatch(/"ca" or "fingerprint"/u)
  })

  it('an abort from the caller is a cancellation, not a device timeout', () => {
    const failure = mapWireFailure(Object.assign(new Error('aborted by caller'), { name: 'AbortError' }), { ...ctx, timeoutMs: 40 }, false)
    expect(failure).toBeInstanceOf(TransportError)
    expect(failure).not.toBeInstanceOf(TimeoutError)
    expect(failure.retryable).toBe(false)
    expect(failure.message).toMatch(/cancelled/u)
  })

  it("our own deadline wins over whatever the socket reported, and names the number that expired", () => {
    const failure = mapWireFailure(syscall('read ECONNRESET', 'ECONNRESET'), { ...ctx, timeoutMs: 250 }, true)
    expect(failure).toBeInstanceOf(TimeoutError)
    expect(failure.retryable).toBe(false)
    expect(failure.message).toMatch(/after 250 ms/u)
    expect(failure.message).toMatch(/may still have applied the commands/u)
  })

  it("undici's own headers timeout is a TimeoutError, not an unknown transport failure", () => {
    const failure = mapWireFailure(syscall('Headers Timeout Error', 'UND_ERR_HEADERS_TIMEOUT'), ctx, false)
    expect(failure).toBeInstanceOf(TimeoutError)
    expect(failure.retryable).toBe(false)
    expect(failure.message).toMatch(/accepted the request and never answered it/u)
  })

  it('an unclassifiable failure keeps `retryable` undefined instead of guessing', () => {
    // "Cannot tell" is a real answer and must not be coerced into a boolean: a UI that sees
    // `undefined` has to render the uncertainty rather than offer a resend.
    const failure = mapWireFailure(new Error('something odd happened in a middleware'), ctx, false)
    expect(failure.name).toBe('TransportError')
    expect(failure.retryable).toBeUndefined()
    expect(failure.message).toMatch(/transport failure/u)
  })

  it('every mapped error serialises the fields a webui error panel renders', () => {
    const failure = mapWireFailure(syscall('connect ECONNREFUSED 10.0.0.9:443', 'ECONNREFUSED'), { ...ctx, request: buildRequest('show version', { id: 'r-9' }) }, false)
    const json = failure.toJSON()
    expect(json).toMatchObject({ name: 'ConnectError', requestId: 'r-9', endpoint: ctx.endpoint, retryable: true })
  })
})

describe('status mapping that fetch.test.ts does not already cover', () => {
  it('413 says the batch was too large, and is not safe to resend unchanged', () => {
    const failure = mapHttpStatus(413, 'Payload Too Large', 'too big', ctx)
    expect(failure).toBeInstanceOf(TransportError)
    expect(failure.status).toBe(413)
    expect(failure.retryable).toBe(false)
    expect(failure.message).toMatch(/split the batch/u)
  })

  it('an unexpected 4xx is reported with its status and refused a resend', () => {
    const failure = mapHttpStatus(418, "I'm a teapot", 'no coffee here', ctx)
    expect(failure.status).toBe(418)
    expect(failure.retryable).toBe(false)
    expect(failure.message).toMatch(/unexpected HTTP status/u)
  })

  it('a 3xx is reported instead of followed, so credentials cannot be re-posted elsewhere', () => {
    const failure = mapHttpStatus(301, 'Moved Permanently', '', { ...ctx, request: buildRequest('show version', { id: 'r-301' }) })
    expect(failure).toBeInstanceOf(TransportError)
    expect(failure.retryable).toBe(false)
    expect(failure.message).toMatch(/does not follow redirects/u)
    expect(failure.message).toMatch(/DR-036/u)
  })

  it('401 keeps the short nginx text and drops a long proxy body (row 26 discipline)', () => {
    const short = mapHttpStatus(401, 'Unauthorized', '401 Unauthorized', ctx)
    expect(short).toBeInstanceOf(AuthError)
    expect(short.message).toContain('401 Unauthorized')
    const long = mapHttpStatus(403, 'Forbidden', `<html>${'y'.repeat(MAX_RAW_BODY * 2)}</html>`, ctx)
    expect(long.message).toContain('truncated')
    expect(long.message.length).toBeLessThan(MAX_RAW_BODY + 400)
  })
})

describe('the response-body hygiene rules the mappers share', () => {
  it('safeBodyText redacts, flattens and truncates (DR-011)', () => {
    expect(safeBodyText('')).toBe('<empty response body>')
    expect(safeBodyText('   \n  ')).toBe('<empty response body>')
    expect(safeBodyText('username admin secret plain   pw')).toContain(REDACTED)
    expect(safeBodyText('line one\nline two')).toBe('line one line two')
    const big = safeBodyText('z'.repeat(MAX_RAW_BODY + 500))
    expect(big).toContain('truncated 500 chars')
    expect(big.length).toBeLessThanOrEqual(MAX_RAW_BODY + 40)
  })

  it('guardEmptyResponseBody turns an empty 200 into the transport failure it looks like', () => {
    const request = buildRequest('vlan 42', { id: 'r-empty' })
    expect(() => guardEmptyResponseBody('   ', { ...ctx, request })).toThrow(TransportError)
    try {
      guardEmptyResponseBody('', { ...ctx, request })
      throw new Error('expected the guard to throw')
    } catch (error) {
      const typed = error as InstanceType<typeof TransportError>
      expect(typed.status).toBe(200)
      expect(typed.retryable).toBe(false)
      expect(typed.requestId).toBe('r-empty')
      expect(typed.commands).toEqual(['vlan 42'])
    }
    expect(guardEmptyResponseBody('{"jsonrpc":"2.0"}', ctx)).toBe('{"jsonrpc":"2.0"}')
    expect(() => guardEmptyResponseBody('<html>proxy error</html>', ctx)).not.toThrow()
  })

  it('the protocol failure for a bad status keeps a redacted rawBody (405)', () => {
    const failure = mapHttpStatus(405, 'Method Not Allowed', '{"username":"api","password":"hunter2"}', ctx)
    expect(failure).toBeInstanceOf(ProtocolError)
    expect(failure.rawBody).not.toContain('hunter2')
    expect(failure.rawBody).toContain(REDACTED)
  })
})
