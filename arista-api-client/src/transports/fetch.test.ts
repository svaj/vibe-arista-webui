/**
 * Browser-safe transport behaviour over a real loopback listener — M2 (#4), PLAN's M2 test list:
 * headers, error mapping, the `AbortController` deadline, and pyeapi's connection-level cases.
 *
 * Ported from upstream (DR-003: ported by **behaviour**, so the assertion targets stay comparable):
 *  - `test_eapilib.py::TestEapiConnection::test_send` (POST `/command-api`) → "posts to `/command-api`"
 *  - `::test_send_with_authentication` (an authenticated send still completes) → the header parity block
 *  - `::test_send_unauthorized_user` (401) → `AuthError`, where pyeapi raised `ConnectionError` (row 21)
 *  - `::test_send_raises_connection_error` (a body that is not JSON) → typed error, not a parse failure
 *  - `::test_send_raises_connection_socket_error` (socket trouble) → `TransportError`/`ConnectError`.
 *    pyeapi folds every wire failure into one `ConnectionError(connection, 'Socket error during eAPI
 *    connection: …')` (`eapilib.py:473-478`), so upstream cannot distinguish "nothing reached the
 *    switch" from "the switch may already have run my write". This suite asserts the split, and asserts
 *    the `retryable` flag on each class, because that flag is what a UI renders as "this config write
 *    may have landed" (DR-019).
 *  - `::test_create_http_connection` / `::test_create_https_connection` (construction + `__str__`) →
 *    the `address` assertions
 * The `http.client`/`ssl` plumbing those upstream tests assert with `Mock`s (`transport.putrequest`,
 * `getresponse().read`) has no TS analogue: instead of verifying the *calls made to a stdlib client*,
 * these tests verify what an actual listener *receives*, which is the part that has to match pyeapi.
 *
 * Offline and deterministic: `127.0.0.1` on ephemeral ports only, closed in `afterEach`; the one
 * non-loopback name used is `.invalid`, which RFC 2606 reserves so resolution always fails locally
 * (docs/TESTING.md §1). No device credential is ever sent anywhere.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { clearWarningRegistry } from '../internal/warn'
import { AuthError, ConnectError, NotSupportedError, ProtocolError, TimeoutError, TlsError, TransportError } from '../errors'
import { createTransport } from './create'
import { EAPI_CONTENT_TYPE, FetchTransport, HttpTransport } from './fetch'
import { basicAuth } from './auth'
import { DEFAULT_TIMEOUT_MS } from './contract'
import { listenHttp, listenHttps, closedPort, healthyDevice, type LoopbackDevice, type LoopbackRequest } from '../testing/loopback-device'

let device: LoopbackDevice | undefined
/** Every `warnOnce` line emitted by the current case — these warnings are behaviour (DR-008/DR-013/DR-014). */
let warnings: string[] = []

beforeEach(() => {
  // The warnings are process-wide (`warnOnce`), so each case starts from a clean registry and asserts on
  // its own captured output instead of inheriting another case's state — or printing to stderr.
  warnings = []
  clearWarningRegistry()
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]): void => {
    warnings.push(args.map((value) => String(value)).join(' '))
  })
})

afterEach(async () => {
  await device?.close()
  device = undefined
})

describe('the headers an eAPI POST carries (pyeapi eapilib.py:432-437)', () => {
  beforeEach(async () => {
    device = await listenHttp(healthyDevice())
  })

  it('posts application/json-rpc to /command-api, to any path a pyeapi profile would have named', async () => {
    const transport = createTransport({ kind: 'http', host: device?.host, port: device?.port, allowInsecureTransport: true })
    await transport.execute('show version')
    const request = device?.last() as LoopbackRequest
    expect(request.method).toBe('POST')
    expect(request.url).toBe('/command-api')
    expect(request.headers['content-type']).toBe(EAPI_CONTENT_TYPE)
    expect(request.headers['content-type']).toBe('application/json-rpc')
  })

  it('honours `path`, which pyeapi accepts in the constructor and then ignores in send() (row 24)', async () => {
    const transport = createTransport({ kind: 'http', host: device?.host as string, port: device?.port, path: '/api/command-api', allowInsecureTransport: true })
    await transport.execute('show version')
    expect(transport.address).toBe(`http://127.0.0.1:${String(device?.port)}/api/command-api`)
    expect((device?.last() as LoopbackRequest).url).toBe('/api/command-api')
  })

  it('sends the byte-exact Basic header pyeapi sends for admin: (DR-009)', async () => {
    const transport = createTransport({ kind: 'http', host: device?.host as string, port: device?.port, username: 'admin', password: '', allowInsecureTransport: true })
    await transport.execute('show version')
    expect((device?.last() as LoopbackRequest).headers.authorization).toBe('Basic YWRtaW46')
    expect((device?.last() as LoopbackRequest).headers.authorization).toBe(basicAuth('admin', ''))
  })

  it('encodes the UTF-8 bytes of a non-ASCII password, not the UTF-16 code units (pyeapi .encode())', async () => {
    const transport = createTransport({ kind: 'http', host: device?.host as string, port: device?.port, username: 'api', password: 'päss-word', allowInsecureTransport: true })
    await transport.execute('show version')
    expect((device?.last() as LoopbackRequest).headers.authorization).toBe('Basic YXBpOnDDpHNzLXdvcmQ=')
  })

  it('sends no Authorization header at all when there are no credentials', async () => {
    const transport = createTransport({ kind: 'http', host: device?.host as string, port: device?.port, allowInsecureTransport: true })
    await transport.execute('show version')
    const request = device?.last() as LoopbackRequest
    expect(request.headers.authorization).toBeUndefined()
  })

  it('sets Content-Length from the byte length, because EOS nginx rejects a chunked eAPI POST (eapilib.py:434)', async () => {
    const transport = createTransport({ kind: 'http', host: device?.host as string, port: device?.port, username: 'admin', password: 'ünïcode', allowInsecureTransport: true })
    await transport.execute([{ cmd: 'show version', input: '多行 input\nEOF\n' }])
    const request = device?.last() as LoopbackRequest
    const bodyBytes = new TextEncoder().encode(request.body).length
    expect(Number(request.headers['content-length'])).toBe(bodyBytes)
    // The server must see the enable-style input untouched: redaction is a *logging* rule (DR-011),
    // and a command layer that redacted on the wire could never authenticate.
    expect(request.body).toContain('多行 input')
    expect(request.body).not.toContain('<removed>')
  })

  it('reports the same endpoint string the error messages will quote (pyeapi __str__)', () => {
    const transport = createTransport({ kind: 'http', host: '127.0.0.1', port: device?.port, allowInsecureTransport: true })
    expect(transport.address).toBe(`http://127.0.0.1:${String(device?.port)}/command-api`)
    expect(String(transport)).toBe(transport.address)
    expect(transport.kind).toBe('http')
  })

  it('joins a baseUrl path prefix instead of replacing it, which is the DR-036 dev-proxy shape', async () => {
    const transport = createTransport({ kind: 'http', baseUrl: `http://127.0.0.1:${String(device?.port)}/proxy/eapi`, allowInsecureTransport: true })
    await transport.execute('show version')
    expect(transport.address).toBe(`http://127.0.0.1:${String(device?.port)}/proxy/eapi/command-api`)
    expect((device?.last() as LoopbackRequest).url).toBe('/proxy/eapi/command-api')
  })
})

describe('a successful round trip keeps M1 codec behaviour intact', () => {
  it('returns the result array with the encoding that actually answered', async () => {
    device = await listenHttp(healthyDevice((commands) => commands.map((command) => ({ output: { command: String(command), response: {} } }))))
    const transport = createTransport({ kind: 'http', baseUrl: device.origin, allowInsecureTransport: true })
    const outcome = await transport.execute(['show version', 'show interfaces'])
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.encoding).toBe('json')
    expect(outcome.viaTextRetry).toBe(false)
    expect(outcome.result).toHaveLength(2)
    expect(outcome.request.params.cmds).toEqual(['show version', 'show interfaces'])
  })

  it('echoes a device error envelope as a typed failure instead of throwing it (M1 rule, kept)', async () => {
    // The id here is the id the transport actually sent. It used to be the literal `"x"`, which was
    // harmless while nothing compared ids; M2 (#4) correlation (`src/transports/correlate.ts`,
    // MIGRATION.md §5 row 29) rejects a reply that answers a *different* request, and this case is
    // about the envelope, not about pairing. The correlation contract has its own spec file.
    device = await listenHttp((request) => {
      const { id } = JSON.parse(request.body) as { id: string }
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', error: { code: 1002, message: 'CLI ERROR', data: [{ errors: ['bad'] }] }, id }),
      }
    })
    const transport = createTransport({ kind: 'http', baseUrl: device.origin, allowInsecureTransport: true })
    const outcome = await transport.execute('bad command')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error.name).toBe('CommandError')
    expect(outcome.error.message).toContain('CLI ERROR')
    // DR-017: the envelope's own id is the error's `requestId`, so a device log line and this error
    // object can be grepped against each other.
    expect(outcome.error.requestId).toBe(outcome.request.id)
  })
})

describe('HTTP status mapping, before the body is parsed (row 21)', () => {
  it('401 with an HTML body is AuthError, not the "unable to connect to eAPI" pyeapi reports', async () => {
    device = await listenHttp(() => ({ status: 401, statusText: 'Unauthorized', headers: { 'content-type': 'text/html' }, body: '<html><body>401 Unauthorized</body></html>' }))
    const transport = createTransport({ kind: 'http', baseUrl: device.origin, username: 'admin', password: 'wrong', allowInsecureTransport: true })
    const failure = await transport.execute('show version').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AuthError)
    const typed = failure as InstanceType<typeof AuthError>
    expect(typed.status).toBe(401)
    expect(typed.endpoint).toBe(`${device.origin}/command-api`)
    expect(typed.commands).toEqual(['show version'])
    expect(typed.message).toMatch(/HTTP 401 Unauthorized/)
    expect(typed.message).not.toMatch(/unable to connect/u)
  })

  it('403 is AuthError too — eAPI uses 403 when AAA rejects an authenticated user', async () => {
    device = await listenHttp(() => ({ status: 403, statusText: 'Forbidden', body: 'Forbidden' }))
    const transport = createTransport({ kind: 'http', baseUrl: device.origin, allowInsecureTransport: true })
    await expect(transport.execute('show version')).rejects.toBeInstanceOf(AuthError)
  })

  it('405 is ProtocolError: eAPI is POST + application/json-rpc only', async () => {
    device = await listenHttp(() => ({ status: 405, statusText: 'Method Not Allowed', body: '405 Not Allowed' }))
    const transport = createTransport({ kind: 'http', baseUrl: device.origin, allowInsecureTransport: true })
    const failure = await transport.execute('show version').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ProtocolError)
    expect((failure as InstanceType<typeof ProtocolError>).code).toBe(-32600)
    expect((failure as InstanceType<typeof ProtocolError>).rawBody).toContain('405 Not Allowed')
  })

  it('404 names the DR-036 topology, the single most common mistake with the Vite proxy', async () => {
    device = await listenHttp(() => ({ status: 404, statusText: 'Not Found', body: 'not found' }))
    const transport = createTransport({ kind: 'http', baseUrl: device.origin, allowInsecureTransport: true })
    await expect(transport.execute('show version')).rejects.toThrow(/404/)
    await expect(transport.execute('show version')).rejects.toBeInstanceOf(ProtocolError)
  })

  it('5xx is a TransportError that refuses to promise a safe resend', async () => {
    device = await listenHttp(() => ({ status: 502, statusText: 'Bad Gateway', body: 'upstream timed out' }))
    const transport = createTransport({ kind: 'http', baseUrl: device.origin, allowInsecureTransport: true })
    const failure = await transport.execute('show version').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(TransportError)
    expect((failure as InstanceType<typeof TransportError>).status).toBe(502)
    expect((failure as InstanceType<typeof TransportError>).retryable).toBeUndefined()
  })

  it('a 302 is reported instead of followed, so credentials cannot be re-posted to another origin', async () => {
    device = await listenHttp(() => ({ status: 302, statusText: 'Found', headers: { location: 'http://127.0.0.1:1/moved' }, body: '' }))
    const transport = createTransport({ kind: 'http', baseUrl: device.origin, username: 'admin', password: 'pw', allowInsecureTransport: true })
    const failure = await transport.execute('show version').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(TransportError)
    expect((failure as InstanceType<typeof TransportError>).retryable).toBe(false)
    expect(device.callCount()).toBe(1)
  })

  it('a 200 whose body is not an envelope is a ProtocolError carrying the redacted body', async () => {
    device = await listenHttp(() => ({ status: 200, body: '<html>proxy error</html>' }))
    const transport = createTransport({ kind: 'http', baseUrl: device.origin, allowInsecureTransport: true })
    const outcome = await transport.execute('show version')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error.name).toBe('ProtocolError')
    expect((outcome.error as InstanceType<typeof ProtocolError>).code).toBe(-32700)
  })
})

describe('transport-level failures below HTTP', () => {
  it('a refused port is ConnectError with `retryable: true` (nothing reached the device)', async () => {
    // `closedPort()` binds an ephemeral listener, closes it and waits for the kernel to actually
    // answer ECONNREFUSED. The obvious "close it and reuse the number" race asserted a false
    // premise: for a moment after `close()` the kernel still completes the handshake and then sends
    // RST, which is a *reset* (`read ECONNRESET`) and maps to a different class on purpose.
    const deadPort = await closedPort()
    const transport = createTransport({ kind: 'http', host: '127.0.0.1', port: deadPort, allowInsecureTransport: true })
    const failure = await transport.execute('show version').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ConnectError)
    expect((failure as InstanceType<typeof ConnectError>).retryable).toBe(true)
    expect((failure as InstanceType<typeof ConnectError>).commands).toEqual(['show version'])
    expect((failure as InstanceType<typeof ConnectError>).endpoint).toBe(`http://127.0.0.1:${String(deadPort)}/command-api`)
    expect((failure as InstanceType<typeof ConnectError>).message).toMatch(/ECONNREFUSED/u)
  })

  it('a name that cannot resolve is ConnectError as well (.invalid is RFC 2606 reserved)', async () => {
    const transport = createTransport({ kind: 'https', host: 'eapi-no-such-host.invalid' })
    const failure = await transport.execute('show version').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ConnectError)
    expect((failure as InstanceType<typeof ConnectError>).retryable).toBe(true)
  })

  it('a listener that closes the socket mid-request is a TransportError that refuses to promise a resend', async () => {
    // undici reports this as `UND_ERR_SOCKET` ("other side closed") with the whole request already
    // written. Whether EOS's nginx passed it to the CLI before dying is unknowable, so `retryable`
    // must be false — that flag is what a UI uses to decide whether a config write may have landed.
    device = await listenHttp(() => ({ hangUp: 'fin' }))
    const transport = createTransport({ kind: 'http', baseUrl: device.origin, allowInsecureTransport: true })
    const failure = await transport.execute([{ cmd: 'configure', input: 'vlan 42\nEOF\n' }]).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(TransportError)
    expect(failure).not.toBeInstanceOf(ConnectError)
    expect(failure).not.toBeInstanceOf(ProtocolError)
    const typed = failure as InstanceType<typeof TransportError>
    expect(typed.retryable).toBe(false)
    expect(typed.message).toMatch(/closed the connection mid-request/u)
    expect(typed.message).toMatch(/may already have run/u)
    expect(typed.commands).toEqual([{ cmd: 'configure', input: 'vlan 42\nEOF\n' }])
    // It is not mistaken for a parse failure, and the listener really did see the request.
    expect(device.callCount()).toBe(1)
  })

  it('a listener that resets the connection mid-request maps the same way (bare ECONNRESET)', async () => {
    // The RST variant arrives as a syscall-level `ECONNRESET` with no undici socket stats. Same
    // conclusion, different error shape — the taxonomy must not depend on which one the runtime
    // happened to surface.
    device = await listenHttp(() => ({ hangUp: 'rst' }))
    const transport = createTransport({ kind: 'http', baseUrl: device.origin, allowInsecureTransport: true })
    const failure = await transport.execute('show version').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(TransportError)
    expect((failure as InstanceType<typeof TransportError>).retryable).toBe(false)
    expect((failure as InstanceType<typeof TransportError>).message).toMatch(/closed the connection mid-request/u)
  })

  it('a 200 with no body at all is the transport failure it looks like, not malformed JSON', async () => {
    // The listener answered the request and produced nothing. `parseResponse` would call that
    // `-32700`, which sends the operator looking at their JSON instead of at the switch.
    device = await listenHttp(() => ({ status: 200, body: '' }))
    const transport = createTransport({ kind: 'http', baseUrl: device.origin, allowInsecureTransport: true })
    const failure = await transport.execute('show version').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(TransportError)
    expect(failure).not.toBeInstanceOf(ProtocolError)
    expect((failure as InstanceType<typeof TransportError>).status).toBe(200)
    expect((failure as InstanceType<typeof TransportError>).retryable).toBe(false)
    expect((failure as InstanceType<typeof TransportError>).message).toMatch(/empty body/u)
  })

  it('the self-signed certificate a stock switch serves fails with TlsError from fetch (DR-013)', async () => {
    device = await listenHttps(healthyDevice())
    const transport = new FetchTransport({ kind: 'https', host: device.host, port: device.port })
    const failure = await transport.execute('show version').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(TlsError)
    expect((failure as InstanceType<typeof TlsError>).message).toMatch(/self-signed|verify|certificate/u)
    expect((failure as InstanceType<typeof TlsError>).message).toMatch(/dangerouslyDisableTlsVerification/u)
  })

  it('a caller-supplied AbortSignal is reported as a cancellation, not as a device timeout', async () => {
    device = await listenHttp(() => ({ delayMs: 5_000, body: '{}' }))
    const transport = createTransport({ kind: 'http', baseUrl: device.origin, allowInsecureTransport: true })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 30).unref?.()
    const failure = await transport.execute('show running-config', { signal: controller.signal }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(TransportError)
    expect(failure).not.toBeInstanceOf(TimeoutError)
    expect((failure as InstanceType<typeof TransportError>).message).toMatch(/cancelled/u)
  })
})

describe('the client-side deadline (DR-019, pyeapi timeout is seconds — row 22)', () => {
  it('AbortController fires at the configured ms and yields TimeoutError, never ProtocolError', async () => {
    device = await listenHttp(() => ({ delayMs: 5_000, body: '{}' }))
    const transport = createTransport({ kind: 'http', baseUrl: device.origin, timeoutMs: 40, allowInsecureTransport: true })
    const started = performance.now()
    const failure = await transport.execute('show version').catch((error: unknown) => error)
    const elapsed = performance.now() - started
    expect(failure).toBeInstanceOf(TimeoutError)
    expect(failure).not.toBeInstanceOf(ProtocolError)
    expect(failure).not.toBeInstanceOf(ConnectError)
    expect(elapsed).toBeGreaterThanOrEqual(35)
    expect(elapsed).toBeLessThan(2_000)
    expect((failure as InstanceType<typeof TimeoutError>).message).toMatch(/after 40 ms/u)
    expect((failure as InstanceType<typeof TimeoutError>).retryable).toBe(false)
    expect((failure as InstanceType<typeof TimeoutError>).commands).toEqual(['show version'])
  })

  it('per-call timeoutMs overrides the connection deadline', async () => {
    device = await listenHttp(() => ({ delayMs: 5_000, body: '{}' }))
    const transport = createTransport({ kind: 'http', baseUrl: device.origin, timeoutMs: 30_000, allowInsecureTransport: true })
    const failure = await transport.execute('show version', { timeoutMs: 40 }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(TimeoutError)
  })

  it('defaults to 60 000 ms, the ms form of pyeapi\'s timeout=60 s (row 22)', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(60_000)
    const transport = createTransport({ kind: 'http', host: '127.0.0.1', allowInsecureTransport: true })
    expect(transport).toBeInstanceOf(HttpTransport)
  })

  it('does not confuse the client deadline with the server-side requestTimeout parameter (DR-016)', async () => {
    device = await listenHttp(healthyDevice())
    const transport = createTransport({ kind: 'http', baseUrl: device.origin, timeoutMs: 20, allowInsecureTransport: true })
    await transport.execute('show version', { requestTimeout: 30 })
    const body = JSON.parse((device?.last() as LoopbackRequest).body) as { params: Record<string, unknown> }
    expect(body.params.requestTimeout).toBe(30)
    expect(body.params).not.toHaveProperty('timeoutMs')
  })
})

describe('cleartext gating on the http kind (DR-008)', () => {
  it('allows loopback, but says out loud that it is the switch-local cleartext listener (DR-014)', async () => {
    device = await listenHttp(healthyDevice())
    const transport = createTransport({ kind: 'http', baseUrl: device.origin })
    await transport.execute('show version')
    expect(device.callCount()).toBe(1)
    expect(warnings.join('\n')).toMatch(/switch-local listener and is cleartext/u)
  })

  it('refuses a non-loopback cleartext endpoint unless allowInsecureTransport is stated', () => {
    expect(() => createTransport({ kind: 'http', host: 'switch1.lan' })).toThrow(NotSupportedError)
    const transport = createTransport({ kind: 'http', host: 'switch1.lan', allowInsecureTransport: true })
    expect(transport.address).toBe('http://switch1.lan:80/command-api')
    expect(warnings.join('\n')).toMatch(/credentials are going over cleartext http/u)
  })

  it('keeps the 60 000 ms default of pyeapi\'s timeout=60 s in the option surface (row 22)', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(60_000)
    // Nothing is opened by a constructor, so this endpoint never has to exist (DR-030: no I/O in init).
    const transport = createTransport({ kind: 'http', host: '127.0.0.1', allowInsecureTransport: true })
    expect(transport).toBeInstanceOf(HttpTransport)
    expect(transport.address).toBe('http://127.0.0.1:80/command-api')
  })
})
