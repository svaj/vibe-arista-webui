/**
 * `ClientCertTransport` — pyeapi `https_certs` (`HTTPSCertConnection` + `HttpsEapiCertConnection`,
 * `eapilib.py:212-273`, `:675-712`), M2 (#4). Upstream's own suite does have cases here
 * (`TestHTTPSCertConnection` 10 + `TestHttpsEapiCertConnection` 6 = 16 methods), but most of them
 * assert *calls made to Python's `ssl` module* — `Mock(SSLContext)`, `load_cert_chain`,
 * `create_default_context` plumbing — which has no TS analogue. What is ported here is the behaviour:
 * the mandatory cert/key pair (`eapilib.py:220-222` raises `ValueError`), the
 * `'https://host:port//command-api - <key>,<cert>'` string (row 25), and the fact that a `ca` decides
 * whether the **server** gets verified (`HTTPSCertConnection.connect`, `eapilib.py:230-247`).
 *
 * The mTLS cases run against a real `node:https` listener that requests **and verifies** a client
 * certificate, so "the transport presented one" is something the listener observed, not something a
 * spy claimed. All material is the synthetic pair in `test/fixtures/tls/` — never a device key, and the
 * private key bytes are asserted never to appear in an error or a `toString()`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NotSupportedError, TlsError, TransportError } from '../errors'
import { clearWarningRegistry } from '../internal/warn'
import { certificateFingerprint, healthyDevice, listenHttps, tlsFixture, tlsFixturePath, type LoopbackDevice, type LoopbackRequest } from '../testing/loopback-device'
import { ClientCertTransport, clientCertDescription } from './node-client-cert'
import type { ClientCertTransportOptions } from './contract'
import { createTransport } from '../node'

const CLIENT_PEM = tlsFixture('loopback-client.crt')
const CLIENT_KEY = tlsFixture('loopback-client.key')
const SERVER_PEM = tlsFixture('loopback-self-signed.crt')

let device: LoopbackDevice | undefined
let warnings: string[] = []

/** A well-formed mTLS options record for the running listener; `ca` is what each case varies. */
function certOptions(extra: Partial<ClientCertTransportOptions> = {}): ClientCertTransportOptions {
  return {
    kind: 'https-client-cert',
    host: device?.host as string,
    port: device?.port as number,
    cert: extra.cert ?? CLIENT_PEM,
    key: extra.key ?? CLIENT_KEY,
    ...extra,
  }
}

/** The half-identity cases the option type forbids (`cert`/`key` are required): the runtime half. */
function buildUnchecked(options: object): ClientCertTransport {
  return new ClientCertTransport(options as ClientCertTransportOptions)
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

describe('half an mTLS identity is a programming mistake, so it is refused at construction (row 25)', () => {
  it('missing cert, missing key, or either one empty is TypeError with pyeapi wording in it', () => {
    const halves: readonly object[] = [{}, { cert: CLIENT_PEM }, { key: CLIENT_KEY }, { cert: '' }, { key: '' }, { cert: CLIENT_PEM, key: '' }]
    for (const half of halves) {
      let thrown: unknown
      try {
        buildUnchecked({ kind: 'https-client-cert', host: 'switch1.lan', ...half })
      } catch (error) {
        thrown = error
      }
      expect(thrown, JSON.stringify(Object.keys(half))).toBeInstanceOf(TypeError)
      const message = (thrown as InstanceType<typeof TypeError>).message
      expect(message).toMatch(/both cert and key are required/u)
      // The pyeapi sentence is quoted, because an operator moving an `eapi.conf` profile expects it.
      expect(message).toMatch(/both a key_file and cert_file are required/u)
      expect(message).toMatch(/a ca is recommended/u)
    }
  })

  it('the refusal happens before any socket exists, so a mistyped profile cannot reach the network', async () => {
    device = await listenHttps(healthyDevice(), { mutual: true })
    const { host, port } = device
    expect(() => buildUnchecked({ kind: 'https-client-cert', host, port, cert: CLIENT_PEM })).toThrow(TypeError)
    expect(device.callCount()).toBe(0)
  })

  it('cert and key given together are accepted, and nothing is connected by the constructor (DR-030)', () => {
    const transport = new ClientCertTransport({ kind: 'https-client-cert', host: 'switch1.lan', cert: CLIENT_PEM, key: CLIENT_KEY })
    expect(transport.kind).toBe('https-client-cert')
    expect(transport.address).toBe('https://switch1.lan:443/command-api')
  })
})

describe('a mutual listener: the device sees the certificate we present', () => {
  it('completes the round trip and the listener records the client certificate subject', async () => {
    device = await listenHttps(healthyDevice(), { mutual: true })
    const transport = new ClientCertTransport(certOptions({ ca: SERVER_PEM }))
    const outcome = await transport.execute('show version')
    expect(outcome.ok).toBe(true)
    expect(device.callCount()).toBe(1)
    const request = device.last() as LoopbackRequest
    expect(request.url).toBe('/command-api')
    expect(request.method).toBe('POST')
    // The subject comes from the handshake as observed by the server, which is the only honest way to
    // assert an mTLS client certificate exists at all. Node spells the RDN short names (`CN`) rather
    // than long ones (`commonName`) for this certificate, and that has varied by version, so both are
    // accepted and the *value* is what is pinned.
    const subject = (request.clientCertSubject ?? {}) as Record<string, string>
    expect(Object.keys(subject).length, 'the listener saw no client certificate at all').toBeGreaterThan(0)
    expect(subject.CN ?? subject.commonName).toBe('eapi-test-client')
    expect(subject.O ?? subject.organizationName).toBe('arista-eapi tests')
  })

  it('a client certificate the listener does not trust: nothing runs, and the failure is what Node reports', async () => {
    device = await listenHttps(healthyDevice(), { mutual: true })
    // pyeapi's "present no identity" case cannot even be built here: this kind refuses a half identity.
    // The realistic version is the *wrong* one — the server's own self-signed pair is not signed by the
    // CA the mutual listener trusts.
    const transport = new ClientCertTransport(certOptions({ cert: SERVER_PEM, key: tlsFixture('loopback-self-signed.key'), ca: SERVER_PEM }))
    const failure = await transport.execute('show version').catch((error: unknown) => error)
    // FINDING (reported, not fixed from a spec task): a rejected **client** certificate arrives as
    // `ECONNRESET` / "socket hang up", with no TLS alert code on the client side at all, so the taxonomy
    // can only classify it as a dropped connection. Verified with a plain `node:https` probe: Node
    // reports the server-side rejection of the client certificate as a socket reset. The safe half of
    // the behaviour is right (nothing reached the CLI, and a `TransportError` whose `retryable` is not
    // `true` cannot silently resend a write), but the operator-visible message is about the connection,
    // not about the certificate — worth a follow-up that checks the handshake outcome before blaming
    // the listener.
    expect(failure).toBeInstanceOf(TransportError)
    expect(failure).not.toBeInstanceOf(TlsError)
    expect((failure as InstanceType<typeof TransportError>).retryable).not.toBe(true)
    // Nothing became an HTTP request, so the command never ran.
    expect(device.callCount()).toBe(0)
  })

  it('cert/key given as file paths behave exactly as inline PEM, which is the eapi.conf form (row 25)', async () => {
    device = await listenHttps(healthyDevice(), { mutual: true })
    const transport = new ClientCertTransport({
      kind: 'https-client-cert',
      host: device.host,
      port: device.port,
      cert: tlsFixturePath('loopback-client.crt'),
      key: tlsFixturePath('loopback-client.key'),
      ca: tlsFixturePath('loopback-self-signed.crt'),
    })
    expect((await transport.execute('show version')).ok).toBe(true)
    const subject = ((device.last() as LoopbackRequest).clientCertSubject ?? {}) as Record<string, string>
    expect(subject.CN ?? subject.commonName).toBe('eapi-test-client')
    expect(warnings).toEqual([])
  })

  it('an unreadable key path is a construction-time TlsError naming the path, not the PEM (DR-013)', () => {
    let thrown: unknown
    try {
      buildUnchecked({ kind: 'https-client-cert', host: 'switch1.lan', cert: CLIENT_PEM, key: '/nonexistent/eapi-client.key' })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(TlsError)
    expect((thrown as InstanceType<typeof TlsError>).message).toMatch(/cannot read client private key/u)
    expect((thrown as InstanceType<typeof TlsError>).message).toMatch(/\/nonexistent\/eapi-client\.key/u)
  })
})

describe('`ca` decides whether the device certificate is verified — pyeapi semantics, kept and shouted about', () => {
  it('with a ca, the self-signed fixture verifies and nothing is warned about', async () => {
    device = await listenHttps(healthyDevice())
    const transport = new ClientCertTransport(certOptions({ ca: SERVER_PEM }))
    expect((await transport.execute('show version')).ok).toBe(true)
    expect(device.callCount()).toBe(1)
    expect(warnings).toEqual([])
  })

  it('with the wrong ca, it fails: supplying *a* certificate is not the same as trusting *this* one', async () => {
    device = await listenHttps(healthyDevice())
    const transport = new ClientCertTransport(certOptions({ ca: CLIENT_PEM }))
    const failure = await transport.execute('show version').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(TlsError)
    expect(device.callCount()).toBe(0)
  })

  it('without a ca the device certificate is not verified (upstream behaviour), and that is printed once', async () => {
    device = await listenHttps(healthyDevice())
    const transport = new ClientCertTransport(certOptions())
    expect((await transport.execute('show version')).ok).toBe(true)
    expect((await transport.execute('show version')).ok).toBe(true)
    // `HTTPSCertConnection.connect()` (`eapilib.py:230-247`) verifies only when a ca_file was given.
    // Reproducing that faithfully is a deliberate choice; DR-013 exists to make it visible, so the
    // warning names the host:port that is now unauthenticated.
    const said = warnings.join('\n')
    expect(said).toMatch(/no "ca"/u)
    expect(said).toMatch(/device certificate for 127\.0\.0\.1:\d+ is not verified/u)
    expect(said).toMatch(/Give "ca" or "fingerprint" to close it/u)
    expect(warnings.filter((line) => /is not verified/u.test(line))).toHaveLength(1)
  })

  it('a fingerprint pin without a `ca` is NOT enforced on this kind — reported, and pinned as the gap it is', async () => {
    device = await listenHttps(healthyDevice())
    const pinned = new ClientCertTransport(certOptions({ fingerprint: certificateFingerprint(SERVER_PEM, 'sha256') }))
    expect((await pinned.execute('show version')).ok).toBe(true)
    const wrong = new ClientCertTransport(certOptions({ fingerprint: certificateFingerprint(CLIENT_PEM, 'sha256') }))
    const outcome = await wrong.execute('show version')
    // FINDING (reported, not papered over): `https-client-cert` resolves TLS in mode
    // `'off-without-ca'`, which sets `rejectUnauthorized: false`; Node only calls
    // `checkServerIdentity` while *verifying*, so a `fingerprint` supplied without a `ca` never runs.
    // The pin is silently inert — while the `client-cert-no-ca` warning tells the operator to
    // "give `ca` or `fingerprint` to close it". The two claims cannot both hold, and this case is the
    // proof. It is left to the maintainer to choose the fix (enforce the pin post-handshake, or refuse
    // `fingerprint` without `ca` on this kind) rather than have a spec task decide it silently.
    expect(outcome.ok).toBe(true)
    expect(warnings.join('\n')).toMatch(/Give "ca" or "fingerprint" to close it/u)
  })

  it('with a `ca`, the same pin is checked: the certificate has to match both the bundle and the pin', async () => {
    device = await listenHttps(healthyDevice())
    const ok = new ClientCertTransport(certOptions({ ca: SERVER_PEM, fingerprint: certificateFingerprint(SERVER_PEM, 'sha256') }))
    expect((await ok.execute('show version')).ok).toBe(true)
    const wrong = new ClientCertTransport(certOptions({ ca: SERVER_PEM, fingerprint: certificateFingerprint(CLIENT_PEM, 'sha256') }))
    const failure = await wrong.execute('show version').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(TlsError)
    expect((failure as InstanceType<typeof TlsError>).message).toMatch(/does not match the pinned sha256 fingerprint/u)
    expect(device.callCount()).toBe(1)
  })

  it('dangerouslyDisableTlsVerification warns once and is never implied by the presence of a client certificate', async () => {
    device = await listenHttps(healthyDevice(), { mutual: true })
    const transport = new ClientCertTransport(certOptions({ dangerouslyDisableTlsVerification: true }))
    expect((await transport.execute('show version')).ok).toBe(true)
    expect(warnings.join('\n')).toMatch(/dangerouslyDisableTlsVerification/u)
    expect(warnings.filter((line) => /are not verified/u.test(line))).toHaveLength(1)
  })
})

describe('the secret-free connection string pyeapi renders (eapilib.py:224-232)', () => {
  it('lists key then cert, in that order, and drops upstreams doubled slash', () => {
    // The paths are real files, because DR-030 makes an unreadable identity fail at construction —
    // which is itself asserted below, and is why a log-only description cannot be built from a phantom
    // `/persist/eapi.crt` the way pyeapi's `__str__` builds one.
    const transport = new ClientCertTransport({
      kind: 'https-client-cert',
      host: 'sw1.lan',
      cert: tlsFixturePath('loopback-client.crt'),
      key: tlsFixturePath('loopback-client.key'),
    })
    expect(String(transport)).toBe(`https://sw1.lan:443/command-api - ${tlsFixturePath('loopback-client.key')},${tlsFixturePath('loopback-client.crt')}`)
    expect(String(transport)).not.toContain('//command-api')
    expect(transport.address).toBe('https://sw1.lan:443/command-api')
  })

  it('inline PEM is described, never echoed — neither the key nor the certificate body reaches a string', () => {
    const description = clientCertDescription(
      { scheme: 'https', host: 'sw1', port: 443, path: '/command-api', url: new URL('https://sw1/command-api'), address: 'https://sw1:443/command-api' },
      { kind: 'https-client-cert', cert: CLIENT_PEM, key: CLIENT_KEY },
    )
    expect(description).toBe('https://sw1:443/command-api - <inline PEM>,<inline PEM>')
    expect(description).not.toContain('BEGIN')
    expect(description).not.toContain(CLIENT_KEY.slice(0, 40))
  })

  it('missing material reads <missing>, which is what a half-configured profile looks like in a log', () => {
    const endpoint = { scheme: 'https', host: 'sw1', port: 443, path: '/command-api', url: new URL('https://sw1/command-api'), address: 'https://sw1:443/command-api' } as const
    expect(clientCertDescription(endpoint, { kind: 'https-client-cert', cert: '/a.crt', key: undefined as unknown as string })).toBe('https://sw1:443/command-api - <missing>,/a.crt')
  })
})

describe('the mistakes the option record should not let through', () => {
  it('TLS material on a cleartext endpoint is refused rather than dropped (DR-013)', () => {
    let thrown: unknown
    try {
      buildUnchecked({ kind: 'https-client-cert', baseUrl: 'http://switch1.lan', cert: CLIENT_PEM, key: CLIENT_KEY })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(NotSupportedError)
    expect((thrown as InstanceType<typeof NotSupportedError>).message).toMatch(/cannot apply to a cleartext http endpoint/u)
    expect((thrown as InstanceType<typeof NotSupportedError>).message).toMatch(/Use kind 'https'/u)
  })

  it('socket and local-listener options are not this kinds options (the `{ kind: "unix", host: … }` family)', () => {
    for (const key of ['socketPath', 'allowLocalUnauthenticated', 'allowInsecureTransport']) {
      const attempt = (): unknown =>
        createTransport({ kind: 'https-client-cert', host: 'switch1.lan', cert: CLIENT_PEM, key: CLIENT_KEY, [key]: key === 'socketPath' ? '/var/run/command-api.sock' : true } as never)
      expect(attempt, key).toThrow(NotSupportedError)
      expect(attempt, key).toThrow(new RegExp(`unsupported option '${key}' for transport kind 'https-client-cert'`, 'u'))
    }
  })

  it('an https-client-cert transport is not built by the browser entry, at all (DR-002)', async () => {
    const { createTransport: browserCreate } = await import('../index')
    const attempt = (): unknown => browserCreate({ kind: 'https-client-cert', host: 'switch1.lan', cert: CLIENT_PEM, key: CLIENT_KEY } as never)
    expect(attempt).toThrow(NotSupportedError)
    expect(attempt).toThrow(/Node-only/u)
    expect(attempt).toThrow(/arista-eapi\/node/u)
  })

  it('an unreadable ca path fails at construction, before a handshake (DR-030)', () => {
    expect(() => buildUnchecked({ kind: 'https-client-cert', host: 'switch1.lan', cert: CLIENT_PEM, key: CLIENT_KEY, ca: '/nonexistent/ca.pem' })).toThrow(/cannot read CA certificate/u)
  })
})
