/**
 * `SessionCookieTransport` — pyeapi `http_session` / `https_session` (`SessionApiConnection`,
 * `eapilib.py:713-756`), M2 (#4, DR-018).
 *
 * **Upstream has no analogue for any of this.** `pyeapi/test/unit/test_eapilib.py` (38 methods:
 * `TestEapiConnection` 20, `TestHTTPSCertConnection` 10, `TestHttpsEapiCertConnection` 6,
 * `TestCommandError` 2) never touches the session mix-ins, and `test_client.py` never builds an
 * `http_session`/`https_session` profile. So these are written from the behaviour of the code plus the
 * divergences MIGRATION.md §5 rows 23/26/27 record — not ports. That also explains why this file is
 * the largest coverage gap in M2 (#4): nothing upstream ever pressed on it.
 *
 * What is asserted, and why:
 *  - the `/login` POST is byte-compatible with pyeapi (exact body key order/shape, `Content-Type:
 *    application/json`, no `Authorization` anywhere) because the device contract, not the class name,
 *    is what has to match (row 23);
 *  - `Set-Cookie` attributes are dropped and the pair is replayed on `/command-api`
 *    (`SimpleCookie(...).output(header="", attrs=[])`, `eapilib.py:736`);
 *  - a failed `/login` is `AuthError` **without** the response body — pyeapi's
 *    `'%s. %s' % (resp.reason, resp.read())` puts whatever the login page echoed into the exception
 *    (row 26), so the sentinel below must not appear anywhere in the error;
 *  - `close()` logs out, best-effort: EOS's `/logout` contract is a STATUS.md §3 sweep item, so a
 *    broken logout must never mask the error a caller is already handling;
 *  - deferred + shared login: pyeapi authenticates inside `client.connect()`, which reports a credential
 *    typo with no `commands` attached (`execute()` only decorates exceptions raised *after* the request
 *    exists — `eapilib.py:626-631`). Deferring to the first request keeps that promise; row 30.
 *
 * Offline and deterministic: an in-process loopback listener on an ephemeral `127.0.0.1` port, closed in
 * `afterEach`. `synthetic` credentials only — never a device password, and nothing here can reach a
 * switch (docs/TESTING.md §1).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AuthError, NotSupportedError, ProtocolError, TlsError, TransportError } from '../errors'
import { clearWarningRegistry } from '../internal/warn'
import { healthyDevice, listenHttp, listenHttps, tlsFixture, type LoopbackAnswer, type LoopbackDevice, type LoopbackRequest, type LoopbackResponder } from '../testing/loopback-device'
import { cookiePairs, LOGIN_PATH, LOGOUT_PATH, SessionCookieTransport } from './node-cookie'
import type { SessionTransportOptions, WireTraceRecord } from './contract'

/** The cookie the fake listener hands out. Asserted against, never logged by the transport (DR-011). */
const SESSION_COOKIE = 'eapi_session=0a1b2c3d4e5f'
const COOKIE_VALUE = '0a1b2c3d4e5f'

const healthy = healthyDevice()

let device: LoopbackDevice | undefined
let warnings: string[] = []

/**
 * A fake eAPI listener with pyeapi's session shape, dispatched by path: `POST /login` hands out a
 * cookie, `POST /command-api` answers the batch, `POST /logout` drops the session. Those three paths
 * are the whole surface this transport touches, and each one is overridable per case.
 */
interface SessionBehaviour {
  /** Force a non-200 answer on `/login`. */
  readonly loginStatus?: number
  readonly loginBody?: string
  /** The `Set-Cookie` values `/login` returns; `[]` means "200, but no session to reuse". */
  readonly setCookies?: readonly string[] | undefined
  /** Override the `/logout` answer (a broken or connection-killing logout). */
  readonly logout?: () => LoopbackAnswer
  /** Override the `/command-api` answer. */
  readonly command?: (request: LoopbackRequest, index: number) => LoopbackAnswer
}

function sessionResponder(options: SessionBehaviour = {}): LoopbackResponder {
  return (request, index) => {
    if (request.url === LOGIN_PATH) {
      if (options.loginStatus !== undefined) {
        return { status: options.loginStatus, statusText: 'Unauthorized', body: options.loginBody ?? 'login failed', headers: { 'content-type': 'text/html' } }
      }
      return {
        status: 200,
        headers: { 'set-cookie': options.setCookies ?? [`${SESSION_COOKIE}; path=/; HttpOnly`] },
        body: '',
      }
    }
    if (request.url === LOGOUT_PATH) return options.logout?.() ?? { status: 200, body: '' }
    return options.command?.(request, index) ?? healthy(request, index)
  }
}

/** Cleartext loopback session listener (pyeapi `http_session`). */
function sessionDevice(options: SessionBehaviour = {}): Promise<LoopbackDevice> {
  return listenHttp(sessionResponder(options))
}

/** TLS loopback session listener on the synthetic fixture (pyeapi `https_session`) — DR-013 applies. */
function secureSessionDevice(options: SessionBehaviour = {}): Promise<LoopbackDevice> {
  return listenHttps(sessionResponder(options))
}

/** The requests that hit one path, in arrival order — the surface for "exactly one login"-style claims. */
function ofPath(url: string): LoopbackRequest[] {
  return (device?.requests() ?? []).filter((request: LoopbackRequest) => request.url === url) as LoopbackRequest[]
}

/**
 * A session transport for the running listener. `host`/`port` alone would mean the **https** default
 * (pyeapi `https_session`), so the endpoint is given as a `baseUrl` whose scheme is the listener's —
 * which is also how a caller selects `http_session` (row 23: one kind, scheme from the endpoint).
 */
function session(extra: Partial<SessionTransportOptions> = {}): SessionCookieTransport {
  return new SessionCookieTransport({
    kind: 'session',
    username: 'synthetic-admin',
    password: 'synthetic-password',
    ...extra,
    baseUrl: extra.baseUrl ?? (device as LoopbackDevice).origin,
  })
}

function paths(): string[] {
  return (device?.requests() ?? []).map((request: LoopbackRequest) => request.url)
}

beforeEach(() => {
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

describe('the cookie pair extractor (pyeapi `SimpleCookie(...).output(header="", attrs=[])`)', () => {
  it('keeps name=value and drops every attribute', () => {
    expect(cookiePairs(['TSID=abc; path=/; HttpOnly', 'X=1; Secure'])).toEqual(['TSID=abc', 'X=1'])
  })

  it('tolerates a blank or attribute-only header value instead of sending a malformed Cookie header', () => {
    expect(cookiePairs(['', '  ', 'HttpOnly', 'novalue'])).toEqual([])
  })

  it('hands back exactly what a `Cookie` header needs, joined the way the jar joins it', () => {
    expect(cookiePairs(['a=1; path=/']).join('; ')).toBe('a=1')
  })
})

describe('`POST /login`, byte for byte (eapilib.py:716-726)', () => {
  it('posts the two pyeapi keys, in pyeapi order, with pyeapi Content-Type', async () => {
    device = await sessionDevice()
    await session().execute('show version')
    const [login, command] = device.requests() as readonly [LoopbackRequest, LoopbackRequest]
    expect(login.method).toBe('POST')
    expect(login.url).toBe(LOGIN_PATH)
    // Byte-exact: pyeapi sends `{"username": …, "password": …}` with no space after the colon beyond
    // json.dumps' default separators, and `Content-type: application/json` — not `json-rpc`.
    expect(JSON.parse(login.body)).toEqual({ username: 'synthetic-admin', password: 'synthetic-password' })
    expect(login.headers['content-type']).toBe('application/json')
    expect(Number(login.headers['content-length'])).toBe(Buffer.byteLength(login.body))
    // A cookie session never sends Basic credentials: pyeapi's MRO puts the session `authentication`
    // ahead of the Basic one, so on the wire there is no Authorization header at all.
    expect(login.headers.authorization).toBeUndefined()
    expect(command.headers.authorization).toBeUndefined()
    expect(command.url).toBe('/command-api')
  })

  it('sends an empty password rather than omitting the key, the shape pyeapi builds from `password=None`', async () => {
    device = await sessionDevice()
    await session({ username: 'nobody', password: undefined }).execute('show version')
    // `{ "username": …, "password": "" }`: the key is always present, because pyeapi serialises
    // `{'username': username, 'password': password}` with `password or ''` never applied upstream.
    expect(JSON.parse((ofPath(LOGIN_PATH)[0] as LoopbackRequest).body)).toEqual({ username: 'nobody', password: '' })
  })

  it('the commands on a refused login are attached redacted, never as the raw batch (DR-011)', async () => {
    device = await sessionDevice({ loginStatus: 401 })
    const failure = await session().execute([{ cmd: 'enable', input: 'enable-secret\nEOF\n' }]).catch((error: unknown) => error)
    const typed = failure as InstanceType<typeof AuthError>
    expect(typed).toBeInstanceOf(AuthError)
    expect(typed.commands).toEqual([{ cmd: 'enable', input: '<redacted>' }])
    expect(JSON.stringify(typed)).not.toContain('enable-secret')
  })

  it('refuses to build a session transport with no username, instead of POSTing {"username": null} for the device to complain about', () => {
    expect(() => new SessionCookieTransport({ kind: 'session', host: '127.0.0.1' } as SessionTransportOptions)).toThrow(TypeError)
    expect(() => new SessionCookieTransport({ kind: 'session', host: '127.0.0.1' } as SessionTransportOptions)).toThrow(/needs a username/u)
  })
})

describe('`Set-Cookie` is replayed on the next `/command-api` (DR-018)', () => {
  it('replays the name=value pair and nothing else', async () => {
    device = await sessionDevice()
    const transport = session()
    await transport.execute('show version')
    await transport.execute('show interfaces')
    const command = (device.requests() as readonly LoopbackRequest[]).find((request) => request.url === '/command-api') as LoopbackRequest
    expect(command.headers.cookie).toBe('eapi_session=0a1b2c3d4e5f')
    expect(device.callCount()).toBe(3)
  })

  it('replays several cookies as one header, and uses `application/json-rpc` for the command POST', async () => {
    device = await sessionDevice({ setCookies: ['A=1; path=/', 'B=2; HttpOnly'] })
    await session().execute('show version')
    const command = (device.requests() as readonly LoopbackRequest[]).find((request) => request.url === '/command-api') as LoopbackRequest
    expect(command.headers.cookie).toBe('A=1; B=2')
    expect(command.headers['content-type']).toBe('application/json-rpc')
  })

  it('a 200 login that sets no cookie is AuthError — the transport would otherwise send an empty Cookie header forever', async () => {
    device = await sessionDevice({ setCookies: [] })
    const failure = await session().execute('show version').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AuthError)
    expect((failure as InstanceType<typeof AuthError>).message).toMatch(/no Set-Cookie header/u)
    expect((failure as InstanceType<typeof AuthError>).message).toMatch(/DR-018/u)
    expect(device.callCount()).toBe(1)
  })

  it('the jar survives across calls: one login for three command batches', async () => {
    device = await sessionDevice()
    const transport = session()
    for (const command of ['show version', 'show hostname', 'show interfaces']) {
      expect((await transport.execute(command)).ok).toBe(true)
    }
    expect(paths().filter((url) => url === LOGIN_PATH)).toHaveLength(1)
    expect(paths().filter((url) => url === '/command-api')).toHaveLength(3)
  })

  it('it traces the cookie **name** to a `trace` sink and never the value (DR-011)', async () => {
    device = await sessionDevice()
    const traces: WireTraceRecord[] = []
    await session({ trace: (entry) => traces.push(entry) }).execute('show version')
    const loginTrace = traces.find((entry) => entry.endpoint.endsWith(LOGIN_PATH) && entry.direction === 'response')
    expect(loginTrace, 'the login response should be traced').toBeDefined()
    expect(loginTrace?.body).toContain('cookieNames')
    expect(loginTrace?.body).toContain('eapi_session')
    expect(loginTrace?.body).not.toContain(COOKIE_VALUE)
    // The command POST itself is traced by the shared composition in `base.ts`.
    expect(traces.some((entry) => entry.direction === 'request' && entry.endpoint.endsWith('/command-api'))).toBe(true)
  })
})

describe('a failed login (pyeapi raises `ConnectionError(reason + resp.read())` — row 26)', () => {
  it('401 is AuthError, and the login page body is not echoed into it', async () => {
    device = await sessionDevice({ loginStatus: 401, loginBody: '<html>echoed form field: synthetic-password-LEAK</html>' })
    const failure = await session().execute('show version').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AuthError)
    const typed = failure as InstanceType<typeof AuthError>
    expect(typed.status).toBe(401)
    expect(typed.message).toMatch(/HTTP 401 Unauthorized/u)
    expect(typed.message).toMatch(/response body is not shown/u)
    expect(typed.message).not.toMatch(/LEAK/u)
    expect(typed.message).not.toContain('echoed form field')
    expect(typed.endpoint).toBe(`${device.origin}${LOGIN_PATH}`)
  })

  it('the failed login still carries the commands and the request id (DR-005 — pyeapi attaches commands only after a request exists)', async () => {
    device = await sessionDevice({ loginStatus: 403 })
    const transport = session({ seed: 'fixed', nonce: 'cookie' })
    const failure = await transport.execute(['show version', 'show hostname']).catch((error: unknown) => error)
    const typed = failure as InstanceType<typeof AuthError>
    expect(typed).toBeInstanceOf(AuthError)
    expect(typed.commands).toEqual(['show version', 'show hostname'])
    // Deferred login is what makes this possible at all: the id the codec *would have* sent is known.
    expect(typed.requestId).toBe('cookie-fixed-1')
    expect(typed.status).toBe(403)
  })

  it('a login redirect is AuthError-shaped too, because a 3xx is not a session', async () => {
    device = await sessionDevice({ loginStatus: 302 })
    await expect(session().execute('show version')).rejects.toBeInstanceOf(AuthError)
  })
})

describe('`close()` logs out — pyeapi never does, and leaves the device-side session open (DR-018)', () => {
  it('posts /logout with the jar it is holding', async () => {
    device = await sessionDevice()
    const transport = session()
    await transport.execute('show version')
    await transport.close()
    expect(paths()).toContain(LOGOUT_PATH)
    const logout = (device.requests() as readonly LoopbackRequest[]).find((request) => request.url === LOGOUT_PATH) as LoopbackRequest
    expect(logout.headers.cookie).toBe('eapi_session=0a1b2c3d4e5f')
    expect(logout.headers['content-type']).toBe('application/json')
  })

  it('close() is idempotent: a second close logs out nobody', async () => {
    device = await sessionDevice()
    const transport = session()
    await transport.execute('show version')
    await expect(transport.close()).resolves.toBeUndefined()
    // The first close() logged out; the second has no jar left, so nothing happens at all.
    await transport.close()
    expect(ofPath(LOGOUT_PATH)).toHaveLength(1)
  })

  it('a logout the device answers 500 warns and still resolves (cleanup must not mask the caller)', async () => {
    device = await sessionDevice({
      logout: () => ({ status: 500, statusText: 'Internal Server Error', body: 'logout unsupported' }),
    })
    const transport = session()
    await transport.execute('show version')
    await expect(transport.close()).resolves.toBeUndefined()
    expect(warnings.join('\n')).toMatch(/POST \/logout/u)
    expect(warnings.join('\n')).toMatch(/HTTP 500 Internal Server Error/u)
    expect(warnings.join('\n')).toMatch(/may still be open/u)
    // Unverified contract, so it is a warning rather than an error: the sweep has not seen /logout.
    expect(warnings.join('\n')).toMatch(/unverified on 4\.28/u)
  })

  it('a logout that kills the connection also resolves, with the failure text summarised once', async () => {
    device = await sessionDevice({ logout: () => ({ hangUp: 'rst' }) })
    const transport = session()
    await transport.execute('show version')
    await expect(transport.close()).resolves.toBeUndefined()
    const said = warnings.join('\n')
    expect(said).toMatch(/POST \/logout at .* failed/u)
    expect(warnings.filter((line) => /POST \/logout/u.test(line))).toHaveLength(1)
  })

  it('a session that was never used logs out nobody (no /logout, no connection)', async () => {
    device = await sessionDevice()
    await expect(session().close()).resolves.toBeUndefined()
    expect(device.callCount()).toBe(0)
  })

  it('and `execute()` after `close()` is refused rather than silently re-opening a session', async () => {
    device = await sessionDevice()
    const transport = session()
    await transport.execute('show version')
    await transport.close()
    const failure = await transport.execute('show version').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(TransportError)
    expect((failure as InstanceType<typeof TransportError>).message).toMatch(/is closed/u)
    // `close()` dropped the jar, but the transport is terminal: nothing re-logs in behind the caller's back.
    expect(ofPath(LOGOUT_PATH)).toHaveLength(1)
    expect(ofPath(LOGIN_PATH)).toHaveLength(1)
    // login + command-api + logout, and nothing after `close()`.
    expect(device.callCount()).toBe(3)
  })
})

describe('concurrent `execute()` calls share exactly one login (row 30)', () => {
  it('three parallel batches produce one /login and three /command-api posts', async () => {
    device = await sessionDevice()
    const transport = session()
    const results = await Promise.all([transport.execute('show version'), transport.execute('show hostname'), transport.execute('show interfaces')])
    expect(results.every((outcome) => outcome.ok)).toBe(true)
    // 1 login + 3 command posts = 4, and exactly one login is the assertion that matters.
    expect(device.callCount()).toBe(4)
    expect(paths().filter((url) => url === LOGIN_PATH)).toHaveLength(1)
  })

  it('a failing concurrent login surfaces to every waiter and is retried by the next call', async () => {
    let attempts = 0
    device = await listenHttp((request) => {
      if (request.url === LOGOUT_PATH) return { status: 200, body: '' }
      if (request.url === LOGIN_PATH) {
        attempts += 1
        if (attempts === 1) return { status: 401, statusText: 'Unauthorized', body: 'transient' }
        return { status: 200, headers: { 'set-cookie': [SESSION_COOKIE] }, body: '' }
      }
      return healthy(request, 0)
    })
    const transport = session()
    const settled = await Promise.allSettled([transport.execute('show version'), transport.execute('show hostname')])
    expect(settled.every((entry) => entry.status === 'rejected')).toBe(true)
    expect(attempts).toBe(1)
    // The shared promise is cleared on failure, so a later call is allowed to try again.
    expect((await transport.execute('show version')).ok).toBe(true)
    expect(paths().filter((url) => url === LOGIN_PATH)).toHaveLength(2)
  })
})

describe('401 on `/command-api`, and what the client does about it (parity with upstream, deliberately)', () => {
  it('reports AuthError with the command list, and does not silently re-authenticate', async () => {
    device = await listenHttp((request) => {
      if (request.url === LOGIN_PATH) return { status: 200, headers: { 'set-cookie': [SESSION_COOKIE] }, body: '' }
      if (request.url === LOGOUT_PATH) return { status: 200, body: '' }
      return { status: 401, statusText: 'Unauthorized', body: 'session expired' }
    })
    const transport = session()
    const first = await transport.execute('show version').catch((error: unknown) => error)
    expect(first).toBeInstanceOf(AuthError)
    expect((first as InstanceType<typeof AuthError>).status).toBe(401)
    expect((first as InstanceType<typeof AuthError>).commands).toEqual(['show version'])
    const second = await transport.execute('show version').catch((error: unknown) => error)
    expect(second).toBeInstanceOf(AuthError)
    // As coded, and as upstream behaves: a cookie session authenticates once. The jar is not cleared by a
    // 401, so the second call replays the same cookie rather than logging in again — the honest recovery
    // is `close()` (which drops the jar *and* logs out, ending the transport) or a fresh transport.
    // Inventing a transparent re-login would hide which calls the device refused, and pyeapi's
    // `authentication()` likewise runs exactly once (`eapilib.py:714`) with nothing re-running it.
    expect(paths().filter((url) => url === LOGIN_PATH)).toHaveLength(1)
    expect(paths().filter((url) => url === '/command-api')).toHaveLength(2)
    // The stale jar really was replayed, which is the observable fact a UI needs.
    const replays = (device.requests() as readonly LoopbackRequest[]).filter((request) => request.url === '/command-api')
    expect(replays.map((request) => request.headers.cookie)).toEqual(['eapi_session=0a1b2c3d4e5f', 'eapi_session=0a1b2c3d4e5f'])
  })

  it('a login on an https session rides the same trust configuration as the command POST (one resolveTlsConnect per transport)', async () => {
    // Nothing observable distinguishes "the login used a different TLS config" from "it used the same
    // one" except that both calls are made over the verified listener, which is what this asserts.
    device = await secureSessionDevice()
    const transport = new SessionCookieTransport({
      kind: 'session',
      host: device.host,
      port: device.port,
      username: 'synthetic-admin',
      password: 'synthetic-password',
      ca: tlsFixture('loopback-self-signed.crt'),
    })
    expect((await transport.execute('show version')).ok).toBe(true)
    expect(transport.address).toBe(`${device.origin}/command-api`)
    expect(paths()).toEqual([LOGIN_PATH, '/command-api'])
    expect(warnings).toEqual([])
  })})

describe('scheme, gates and warnings around the session kind', () => {
  it('an https session with no trust material never reaches /login: the handshake fails first (DR-013)', async () => {
    device = await secureSessionDevice()
    const failure = await session().execute('show version').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(TlsError)
    // The fake listener never saw a byte: a session transport cannot be used to reach across a
    // management network without saying who to trust (the inverse of pyeapi, which silently built an
    // unverified context — `HttpsEapiConnection.disable_certificate_verification`, `eapilib.py:688-701`).
    expect(device.callCount()).toBe(0)
  })

  it('an https session with the default (system CA) trust mode speaks TLS, not cleartext (row 23)', async () => {
    // `http_session` and `https_session` collapse into one kind whose scheme comes from the endpoint, so
    // `host` + no scheme says TLS here — the two pyeapi classes differ only in the `http.client` base
    // they mix in (`eapilib.py:750-756`), which is exactly what is *not* ported.
    device = await secureSessionDevice()
    const transport = session()
    expect(transport.address).toBe(`https://${device.host}:${String(device.port)}/command-api`)
    const failure = await transport.execute('show version').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(TlsError)
    expect(device.callCount()).toBe(0)
  })

  it('login and logout endpoints keep the resolved scheme and port while swapping only the path', () => {
    const transport = new SessionCookieTransport({ kind: 'session', host: 'switch1.lan', username: 'u', password: 'p', allowInsecureTransport: true })
    expect(transport.address).toBe('https://switch1.lan:443/command-api')
    expect(String(transport)).toBe('https://switch1.lan:443/command-api (session)')
    expect(transport.kind).toBe('session')
  })

  it('a cleartext session to a non-loopback host is refused (DR-008/DR-013): the password rides in the *body*', () => {
    // Worse than `kind: 'http'`, which puts the credential in a header: pyeapi `http_session` POSTs
    // {"username":…, "password":…} in cleartext, so the gate has to cover the session kind too.
    expect(() => session({ baseUrl: 'http://switch1.lan:80' })).toThrow(NotSupportedError)
    expect(() => session({ baseUrl: 'http://switch1.lan:80' })).toThrow(/cleartext http/u)
    // Stated out loud, it is allowed — with the warning that says what is being accepted.
    const transport = session({ baseUrl: 'http://switch1.lan:80', allowInsecureTransport: true })
    expect(transport.address).toBe('http://switch1.lan:80/command-api')
    expect(warnings.join('\n')).toMatch(/credentials are going over cleartext http/u)
  })

  it('a loopback cleartext session is allowed quietly-ish, but said out loud once (DR-014)', async () => {
    device = await sessionDevice()
    expect((await session().execute('show version')).ok).toBe(true)
    expect(warnings.join('\n')).toMatch(/switch-local listener and is cleartext/u)
  })

  it('an empty 200 on /command-api stays a TransportError, not a parse failure', async () => {
    device = await sessionDevice({ command: () => ({ status: 200, body: '    ' }) })
    const failure = await session().execute('show version').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(TransportError)
    expect((failure as InstanceType<typeof TransportError>).status).toBe(200)
    expect((failure as InstanceType<typeof TransportError>).retryable).toBe(false)
  })

  it('a 404 on /command-api is the same ProtocolError the other transports report, on this endpoint too', async () => {
    device = await sessionDevice({ command: () => ({ status: 404, statusText: 'Not Found', body: 'no such path' }) })
    const failure = await session().execute('show version').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ProtocolError)
    expect((failure as InstanceType<typeof ProtocolError>).message).toMatch(/no eAPI listener/u)
  })
})
