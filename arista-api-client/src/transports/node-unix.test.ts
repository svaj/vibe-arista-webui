/**
 * `kind: 'unix'` — pyeapi `socket` / `SocketEapiConnection` (`eapilib.py:170-186`, `:696-701`),
 * M2 (#4, DR-002/DR-008/DR-014).
 *
 * The wire shape is kept from upstream: an ordinary cleartext `POST /command-api` over an `AF_UNIX`
 * socket with `Host: localhost` — pyeapi builds an `HTTPConnection('localhost')` and then swaps in an
 * `AF_UNIX` socket (`SocketConnection`), which is exactly what Node's `socketPath` option does. What is
 * *not* kept: the casualness. On 4.28 that listener is `DISABLE_AAA` (priv-15, no authentication), so
 * the `allowLocalUnauthenticated: true` literal is mandatory and the consequence is printed (DR-008/
 * DR-014). Upstream's suite has no local-transport tests beyond constructing the connection object.
 *
 * Offline and honest about where this runs: the socket lives in a fresh temp directory that is removed
 * afterwards. EOS's real path is `/var/run/command-api.sock`, and this suite never touches it — the
 * default is only ever asserted as a string, because opening it would mean talking to a switch.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConnectError, NotSupportedError, TransportError } from '../errors'
import { clearWarningRegistry } from '../internal/warn'
import { healthyDevice, listenUnix, type LoopbackRequest, type LoopbackSocketDevice } from '../testing/loopback-device'
import { createTransport } from '../node'
import { DEFAULT_UNIX_PATH } from './contract'
import { UnixSocketTransport, unixAddress } from './node-unix'
import type { TransportOptions, UnixTransportOptions } from './contract'

/** Loopback-only, and deliberately short: an AF_UNIX path has a ~108 byte limit. */
let socketDir: string
const sockets: LoopbackSocketDevice[] = []
let warnings: string[] = []

async function serve(behaviour: Parameters<typeof listenUnix>[1] = healthyDevice()): Promise<LoopbackSocketDevice> {
  const socketPath = join(socketDir, `eapi-${String(sockets.length) + 1}.sock`)
  const device = await listenUnix(socketPath, behaviour)
  sockets.push(device)
  return device
}

/** Options the `unix` kind accepts, typed the way a caller writes them. */
function build(options: UnixTransportOptions): UnixSocketTransport {
  return new UnixSocketTransport(options)
}

/**
 * The cases the option type forbids: a missing `allowLocalUnauthenticated` (a required literal `true`,
 * so omitting it is a compile error — DR-008), a `username` on a `never` key, TLS material on a
 * socket. Asserting them at runtime covers a JS caller, an `eapi.conf` profile from M3 (#5), or a
 * cast — the compile-time half is checked by the `@ts-expect-error` cases in `contract.test.ts`.
 */
function buildUnchecked(options: object): UnixSocketTransport {
  return new UnixSocketTransport(options as UnixTransportOptions)
}

beforeEach(() => {
  socketDir = mkdtempSync(join(tmpdir(), 'eapi-unix-'))
  warnings = []
  clearWarningRegistry()
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]): void => {
    warnings.push(args.map((value) => String(value)).join(' '))
  })
})

afterEach(async () => {
  for (const device of sockets.splice(0)) await device.close()
  rmSync(socketDir, { recursive: true, force: true })
})

describe('the address a unix transport reports (pyeapi `SocketConnection.__str__`)', () => {
  it('unix:<path>, and the default path is EOS listener path itself', () => {
    expect(unixAddress('/var/run/command-api.sock')).toBe(`unix:${DEFAULT_UNIX_PATH}`)
    // Nothing is opened by a constructor (DR-030), so the default can be asserted without root, without
    // a switch, and without a `/var/run` entry.
    const transport = build({ kind: 'unix', allowLocalUnauthenticated: true })
    expect(transport.address).toBe('unix:/var/run/command-api.sock')
    expect(String(transport)).toBe('unix:/var/run/command-api.sock')
    expect(transport.kind).toBe('unix')
  })

  it('an explicit socketPath is reported verbatim, including in the error text a failure produces', async () => {
    const device = await serve()
    const transport = build({ kind: 'unix', socketPath: device.socketPath, allowLocalUnauthenticated: true })
    expect(transport.address).toBe(`unix:${device.socketPath}`)
    expect(String(transport)).toBe(transport.address)
    // A dead socket path proves the address in the message is the one actually dialed.
    const missing = build({ kind: 'unix', socketPath: join(socketDir, 'absent.sock'), allowLocalUnauthenticated: true })
    const failure = await missing.execute('show version').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ConnectError)
    expect((failure as InstanceType<typeof ConnectError>).endpoint).toBe(`unix:${join(socketDir, 'absent.sock')}`)
    expect(device.callCount()).toBe(0)
  })
})

describe('the DR-008/DR-014 gate, before anything is reachable', () => {
  it('refuses a unix transport unless allowLocalUnauthenticated is the literal true', () => {
    for (const optIn of [undefined, false, 'yes', 1]) {
      let thrown: unknown
      try {
        buildUnchecked({ kind: 'unix', socketPath: '/var/run/command-api.sock', ...(optIn === undefined ? {} : { allowLocalUnauthenticated: optIn }) })
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(NotSupportedError)
      expect((thrown as InstanceType<typeof NotSupportedError>).message).toMatch(/refusing to build the 'unix' transport/u)
    }
    expect(warnings).toEqual([])
  })

  it('prints the unauthenticated-priv-15 warning once, with the socket path in it', async () => {
    const device = await serve()
    const transport = build({ kind: 'unix', socketPath: device.socketPath, allowLocalUnauthenticated: true })
    await transport.execute('show version')
    // A second transport on the same listener must not repeat the same process-wide fact.
    const second = build({ kind: 'unix', socketPath: device.socketPath, allowLocalUnauthenticated: true })
    await second.execute('show version')
    expect(warnings.filter((line) => /unauthenticated priv-15/u.test(line))).toHaveLength(1)
    expect(warnings[0]).toContain(`unix:${device.socketPath}`)
    expect(device.callCount()).toBe(2)
  })

  it('refuses credentials rather than ignoring them on a DISABLE_AAA listener (DR-014)', () => {
    for (const credentials of [{ username: 'admin' }, { password: 'x' }, { username: 'admin', password: 'x' }]) {
      let thrown: unknown
      try {
        buildUnchecked({ kind: 'unix', socketPath: '/var/run/command-api.sock', allowLocalUnauthenticated: true, ...credentials })
      } catch (error) {
        thrown = error
      }
      expect(thrown, JSON.stringify(credentials)).toBeInstanceOf(NotSupportedError)
      expect((thrown as InstanceType<typeof NotSupportedError>).message).toMatch(/takes no username\/password/u)
    }
  })

  it('the gate runs before the socket is opened, so a refusal costs no connection', async () => {
    const device = await serve()
    expect(() => buildUnchecked({ kind: 'unix', socketPath: device.socketPath })).toThrow(NotSupportedError)
    expect(device.callCount()).toBe(0)
  })
})

describe('a real round trip over a temp-directory socket (pyeapi `socket` shape)', () => {
  it('posts /command-api over AF_UNIX, with Host: localhost', async () => {
    const device = await serve()
    const transport = build({ kind: 'unix', socketPath: device.socketPath, allowLocalUnauthenticated: true, seed: 'u', nonce: 'sock' })
    const outcome = await transport.execute('show version')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.result).toEqual([{}])
    const request = device.last() as LoopbackRequest
    expect(request.method).toBe('POST')
    expect(request.url).toBe('/command-api')
    // pyeapi hands `HTTPConnection('localhost')` the host name, so the request line addresses localhost
    // even though the bytes travel through a filesystem socket.
    expect(request.headers.host).toBe('localhost')
    expect(request.headers['content-type']).toBe('application/json-rpc')
    // No Authorization header exists to send: the listener is unauthenticated (DR-014).
    expect(request.headers.authorization).toBeUndefined()
    expect(request.body).toContain('"id":"sock-u-1"')
  })

  it('keeps every command batch on the same socket path and reuses no TLS at all', async () => {
    const device = await serve()
    const transport = build({ kind: 'unix', socketPath: device.socketPath, allowLocalUnauthenticated: true })
    for (const command of ['show version', 'show hostname']) {
      expect((await transport.execute(command)).ok).toBe(true)
    }
    // A socket is not a TLS session: there is no `ca` to configure and none was implied.
    expect(device.callCount()).toBe(2)
    expect(device.requests().every((request) => request.url === '/command-api')).toBe(true)
    expect(device.address).toBe(`unix:${device.socketPath}`)
  })

  it('speaks the same error taxonomy as the network kinds: a 401 on an unauthenticated listener is loud', async () => {
    const device = await serve(() => ({ status: 401, statusText: 'Unauthorized', body: 'unexpected' }))
    const transport = build({ kind: 'unix', socketPath: device.socketPath, allowLocalUnauthenticated: true })
    const failure = await transport.execute('show version').catch((error: unknown) => error)
    // pyeapi would report "unable to connect to eAPI" here; a 401 from the socket listener is a real
    // finding about the switch's state (AAA re-enabled underneath us), so it is typed as an auth problem.
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).name).toBe('AuthError')
    expect((failure as InstanceType<typeof Error>).message).toMatch(/HTTP 401/u)
  })

  it('an empty 200 on the socket is the transport failure it looks like, not malformed JSON (DR-019)', async () => {
    const device = await serve(() => ({ status: 200, body: '' }))
    const transport = build({ kind: 'unix', socketPath: device.socketPath, allowLocalUnauthenticated: true })
    const failure = await transport.execute('show version').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(TransportError)
    expect((failure as InstanceType<typeof TransportError>).message).toMatch(/empty body/u)
    expect((failure as InstanceType<typeof TransportError>).retryable).toBe(false)
  })

  it('a dead socket path is ConnectError with retryable: true — nothing reached the switch (DR-019)', async () => {
    const device = await serve()
    const transport = build({ kind: 'unix', socketPath: device.socketPath, allowLocalUnauthenticated: true })
    await transport.execute('show version')
    await device.close()
    const failure = await transport.execute('show version').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ConnectError)
    expect((failure as InstanceType<typeof ConnectError>).retryable).toBe(true)
    expect((failure as InstanceType<typeof ConnectError>).commands).toEqual(['show version'])
  })

  it('the deadline applies to a socket too: a listener that never answers crosses it (DR-019)', async () => {
    const device = await serve(() => ({ delayMs: 2_000, body: '{}' }))
    const transport = build({ kind: 'unix', socketPath: device.socketPath, allowLocalUnauthenticated: true, timeoutMs: 40 })
    const failure = await transport.execute('show version').catch((error: unknown) => error)
    // Not ProtocolError from an empty read: the client stopped waiting, and the message says for how long.
    expect((failure as Error).name).toBe('TimeoutError')
    expect((failure as Error).message).toMatch(/after 40 ms/u)
  })
})

describe('the unix option record refuses the options that belong to a network kind', () => {
  it('a socketPath is the only address this kind takes (docs/TESTING.md §6)', () => {
    const options: UnixTransportOptions = { kind: 'unix', socketPath: '/var/run/command-api.sock', allowLocalUnauthenticated: true }
    expect(options.socketPath).toBe(DEFAULT_UNIX_PATH)
  })

  it('TLS trust material is not an option this kind takes, at either seam (DR-013)', () => {
    // The factory half: the option allow-list refuses the key rather than letting it be ignored, in the
    // same wording `buildRequest` uses for a bogus `runCmds` parameter (DR-016).
    const attempt = (): unknown =>
      createTransport({ kind: 'unix', socketPath: '/var/run/command-api.sock', allowLocalUnauthenticated: true, ca: 'inline PEM' } as unknown as TransportOptions)
    expect(attempt).toThrow(NotSupportedError)
    expect(attempt).toThrow(/unsupported option 'ca' for transport kind 'unix'/u)
    // The message lists what the kind *does* take, and a caller reading it can find the flag that matters.
    expect(attempt).toThrow(/it accepts [^)]*socketPath/u)
    expect(attempt).toThrow(/DR-016/u)
    // And pyeapi `SocketConnection` has no TLS at all: on a cleartext socket a `ca` is an option that
    // does nothing, which is precisely what the allow-list exists to prevent.
    expect(buildUnchecked({ kind: 'unix', socketPath: '/var/run/command-api.sock', allowLocalUnauthenticated: true, ca: 'inline PEM' }).address).toBe('unix:/var/run/command-api.sock')
  })
})
