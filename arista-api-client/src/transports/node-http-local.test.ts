/**
 * `kind: 'http-local'` — pyeapi `http_local` / `HttpLocalEapiConnection` (`eapilib.py:703-709`),
 * M2 (#4). DR-014 is the whole subject of this file, so the spec is written against the reverse-engineered
 * evidence rather than against upstream's constants:
 *
 *  - 4.28.13.1M generates **one** loopback listener: plain HTTP on 8080
 *    (`SuperServerPlugin/HttpService.py:563-565`, `HttpServicePlugin/Capi.py:83-124`);
 *  - pyeapi's `DEFAULT_HTTPS_LOCAL_PORT = 8443` matches nothing in that build, so it is dropped
 *    outright and there is **no `httpsLocal` kind**; the transport cannot be pointed at a TLS port, and
 *    the spec below proves it: an `http-local` transport aimed at a TLS listener fails the way a
 *    cleartext client fails against a TLS server, rather than quietly negotiating.
 *  - that listener is `DISABLE_AAA`, i.e. unauthenticated priv-15: `allowLocalUnauthenticated: true` is
 *    mandatory and credentials are refused instead of silently ignored (DR-008/DR-014).
 *
 * Everything binds an ephemeral `127.0.0.1` port and is closed in `afterEach`. The `8443` assertions are
 * about our own surface — no constant, no kind, no address — never about probing a port.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AuthError, NotSupportedError, TlsError, TransportError } from '../errors'
import * as browserEntry from '../index'
import * as nodeEntry from '../node'
import { clearWarningRegistry } from '../internal/warn'
import { healthyDevice, listenHttp, listenHttps, type LoopbackDevice, type LoopbackRequest } from '../testing/loopback-device'
import { DEFAULT_HTTP_LOCAL_PORT } from './contract'
import { HttpLocalTransport, LOCAL_HOST } from './node-http-local'
import type { HttpLocalTransportOptions } from './contract'

let device: LoopbackDevice | undefined
let warnings: string[] = []

function local(options: HttpLocalTransportOptions): HttpLocalTransport {
  return new HttpLocalTransport(options)
}

/** The cases the option type forbids (`never` keys, the required `true` literal): the runtime half. */
function localUnchecked(options: object): HttpLocalTransport {
  return new HttpLocalTransport(options as HttpLocalTransportOptions)
}

function withOptIn(port: number): HttpLocalTransportOptions {
  return { kind: 'http-local', port, allowLocalUnauthenticated: true }
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

describe('the endpoint this kind will talk to (pyeapi `http_local`, with DR-014 applied)', () => {
  it('defaults to 127.0.0.1:8080 — the one loopback listener 4.28.13.1M actually generates', () => {
    expect(DEFAULT_HTTP_LOCAL_PORT).toBe(8_080)
    expect(LOCAL_HOST).toBe('127.0.0.1')
    const transport = local({ kind: 'http-local', allowLocalUnauthenticated: true })
    expect(transport.address).toBe('http://127.0.0.1:8080/command-api')
    expect(transport.kind).toBe('http-local')
    expect(String(transport)).toBe('http://127.0.0.1:8080/command-api')
  })

  it('uses the literal loopback address, never the name `localhost`, so the cleartext gate cannot be argued about', async () => {
    device = await listenHttp(healthyDevice())
    const transport = local(withOptIn(device.port))
    expect(transport.address).toBe(`http://127.0.0.1:${String(device.port)}/command-api`)
    await transport.execute('show version')
    expect((device.last() as LoopbackRequest).headers.host).toBe(`127.0.0.1:${String(device.port)}`)
  })

  it('there is no httpsLocal kind, and no 8443 anywhere in the option surface', async () => {
    // pyeapi `DEFAULT_HTTPS_LOCAL_PORT = 8443` (`eapilib.py:63`) is dropped: MIGRATION.md §7.
    const exported = [...Object.keys(browserEntry), ...Object.keys(nodeEntry)]
    expect(exported.filter((name) => /8443|https.?local/iu.test(name))).toEqual([])
    // A numeric constant equal to 8443 would be the same trap wearing a different name.
    for (const value of [...Object.values(browserEntry), ...Object.values(nodeEntry)]) {
      expect(value).not.toBe(8_443)
      if (typeof value === 'object' && value !== null) {
        for (const inner of Object.values(value as Record<string, unknown>)) expect(inner).not.toBe(8_443)
      }
    }
    const { TRANSPORT_ALIASES, normalizeTransportKind } = await import('./contract')
    expect(normalizeTransportKind('https_local')).toBeUndefined()
    expect(normalizeTransportKind('httpsLocal')).toBeUndefined()
    // No alias resolves to a kind that does not exist, and none of the eight kinds is a local TLS one.
    for (const name of Object.keys(TRANSPORT_ALIASES)) {
      expect(normalizeTransportKind(name)).not.toBe('https-local')
    }
  })

  it('a path is honoured, because pyeapi accepts `path` for this kind and then ignores it (row 24)', async () => {
    device = await listenHttp(healthyDevice())
    const transport = local({ kind: 'http-local', port: device.port, path: '/api/command-api', allowLocalUnauthenticated: true })
    await transport.execute('show version')
    expect(transport.address).toBe(`http://127.0.0.1:${String(device.port)}/api/command-api`)
    expect((device.last() as LoopbackRequest).url).toBe('/api/command-api')
  })
})

describe('plain HTTP only: the transport cannot be pointed at a TLS port (DR-014)', () => {
  it('an http-local transport against a TLS listener dies at the connection layer and never negotiates', async () => {
    device = await listenHttps(healthyDevice())
    const transport = local(withOptIn(device.port))
    const failure = await transport.execute('show version').catch((error: unknown) => error)
    // The server is the side that cannot make sense of the bytes here: it expects a ClientHello and gets
    // a cleartext POST, so it closes the connection. The point of the assertion is what the failure is
    // *not* — there is no `TlsError` about a certificate, because this transport has no TLS to speak and
    // no option that would give it one. And the listener never parsed an HTTP request at all.
    expect(failure).toBeInstanceOf(TransportError)
    expect(failure).not.toBeInstanceOf(TlsError)
    expect((failure as InstanceType<typeof TransportError>).message).toMatch(/closed|reset|socket|not an https/iu)
    expect(device.callCount()).toBe(0)
  })

  it('the port an operator hands it is used as-is, but the scheme never becomes https', () => {
    // The pyeapi-era mistake was the *default* (8443), which matched no listener. An explicit port stays
    // explicit — and still cleartext, so nobody configures their way into an implied TLS session.
    const transport = local({ kind: 'http-local', port: 8_443, allowLocalUnauthenticated: true })
    expect(transport.address).toBe('http://127.0.0.1:8443/command-api')
    expect(transport.address).not.toMatch(/^https:/u)
  })

  it('TLS trust material is refused on this kind rather than ignored (DR-013)', () => {
    const attempt = (): unknown => nodeEntry.createTransport({ kind: 'http-local', allowLocalUnauthenticated: true, fingerprint: 'aa:bb' } as never)
    expect(attempt).toThrow(NotSupportedError)
    expect(attempt).toThrow(/unsupported option 'fingerprint' for transport kind 'http-local'/u)
  })
})

describe('the DR-008/DR-014 gate on the loopback listener', () => {
  it('refuses to build without allowLocalUnauthenticated: true, and explains why in the message', () => {
    for (const optIn of [undefined, false, 1]) {
      let thrown: unknown
      try {
        localUnchecked({ kind: 'http-local', port: 8_080, ...(optIn === undefined ? {} : { allowLocalUnauthenticated: optIn }) })
      } catch (error) {
        thrown = error
      }
      expect(thrown, JSON.stringify({ optIn })).toBeInstanceOf(NotSupportedError)
      expect((thrown as InstanceType<typeof NotSupportedError>).message).toMatch(/refusing to build the 'http-local' transport/u)
    }
    expect(warnings).toEqual([])
  })

  it('prints the unauthenticated priv-15 warning once, naming the address', async () => {
    device = await listenHttp(healthyDevice())
    await local(withOptIn(device.port)).execute('show version')
    await local(withOptIn(device.port)).execute('show version')
    expect(warnings.filter((line) => /unauthenticated priv-15/u.test(line))).toHaveLength(1)
    expect(warnings[0]).toContain(`http://127.0.0.1:${String(device.port)}/command-api`)
    expect(device.callCount()).toBe(2)
  })

  it('refuses credentials: the listener is DISABLE_AAA, so they would be ignored rather than honoured', () => {
    for (const credentials of [{ username: 'admin' }, { password: 'pw' }, { username: 'admin', password: 'pw' }]) {
      let thrown: unknown
      try {
        localUnchecked({ kind: 'http-local', port: 8_080, allowLocalUnauthenticated: true, ...credentials })
      } catch (error) {
        thrown = error
      }
      expect(thrown, JSON.stringify(credentials)).toBeInstanceOf(NotSupportedError)
      expect((thrown as InstanceType<typeof NotSupportedError>).message).toMatch(/takes no username\/password/u)
    }
  })

  it('the gate fires before any connection, so a refusal is also a listener that was never touched', async () => {
    device = await listenHttp(healthyDevice())
    const port = device.port
    expect(() => localUnchecked({ kind: 'http-local', port })).toThrow(NotSupportedError)
    expect(device.callCount()).toBe(0)
  })

  it('host, baseUrl and socketPath are not options this kind takes (the `{ kind: "unix", host: … }` family of mistakes)', () => {
    const attempts: readonly object[] = [
      { kind: 'http-local', host: 'localhost', allowLocalUnauthenticated: true },
      { kind: 'http-local', baseUrl: 'http://127.0.0.1:8080', allowLocalUnauthenticated: true },
      { kind: 'http-local', socketPath: '/var/run/command-api.sock', allowLocalUnauthenticated: true },
      { kind: 'unix', host: 'localhost', allowLocalUnauthenticated: true },
    ]
    for (const options of attempts) {
      const kind = (options as { kind: string }).kind
      const key = Object.keys(options)[1] as string
      expect(() => nodeEntry.createTransport(options as never), `${kind} + ${key}`).toThrow(/unsupported option/u)
      expect(() => nodeEntry.createTransport(options as never), `${kind} + ${key}`).toThrow(new RegExp(`'${key}' for transport kind '${kind}'`, 'u'))
    }
  })
})

describe('a real round trip over the loopback listener', () => {
  it('posts application/json-rpc to /command-api with no Authorization header', async () => {
    device = await listenHttp(healthyDevice())
    const transport = local({ kind: 'http-local', port: device.port, allowLocalUnauthenticated: true, seed: 'http', nonce: 'local' })
    const outcome = await transport.execute(['show version', 'show hostname'])
    expect(outcome.ok).toBe(true)
    const request = device.last() as LoopbackRequest
    expect(request.method).toBe('POST')
    expect(request.url).toBe('/command-api')
    expect(request.headers['content-type']).toBe('application/json-rpc')
    expect(request.headers.authorization).toBeUndefined()
    expect(request.body).toContain('"id":"local-http-1"')
  })

  it('a 401 from the listener is still AuthError, on a kind that cannot present credentials', async () => {
    device = await listenHttp(() => ({ status: 401, statusText: 'Unauthorized', body: 'aaa enabled after all' }))
    const transport = local(withOptIn(device.port))
    const failure = await transport.execute('show version').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AuthError)
    expect((failure as InstanceType<typeof AuthError>).endpoint).toBe(`http://127.0.0.1:${String(device.port)}/command-api`)
    expect((failure as InstanceType<typeof AuthError>).commands).toEqual(['show version'])
  })

  it('an empty 200 is reported by the Node sender as a TransportError, exactly as the fetch sender does (DR-019)', async () => {
    device = await listenHttp(() => ({ status: 200, body: '' }))
    const transport = local(withOptIn(device.port))
    const failure = await transport.execute('show version').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(TransportError)
    expect(failure).not.toBeInstanceOf(AuthError)
    expect((failure as InstanceType<typeof TransportError>).message).toMatch(/empty body/u)
    expect((failure as InstanceType<typeof TransportError>).status).toBe(200)
  })

  it('per-call options ride the same composition as every other kind (timeout, readOnly)', async () => {
    device = await listenHttp(() => ({ delayMs: 1_000, status: 200, body: '{}' }))
    const transport = local(withOptIn(device.port))
    const failure = await transport.execute('show version', { timeoutMs: 40 }).catch((error: unknown) => error)
    expect((failure as Error).name).toBe('TimeoutError')
    expect((failure as Error).message).toMatch(/after 40 ms/u)
  })

  it('close() is a no-op that still ends the transport (there is no session to drop)', async () => {
    device = await listenHttp(healthyDevice())
    const transport = local(withOptIn(device.port))
    await transport.close()
    await expect(transport.execute('show version')).rejects.toBeInstanceOf(TransportError)
    expect(device.callCount()).toBe(0)
  })
})
