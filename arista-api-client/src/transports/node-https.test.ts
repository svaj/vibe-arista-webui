/**
 * `TlsTransport` — the Node `kind: 'https'` sender against a **real TLS listener** (M2 #4, DR-013).
 *
 * What is being pinned here is the trust posture, end to end, with no mocks in the middle: an
 * in-process `node:https` listener on an ephemeral `127.0.0.1` port serving the synthetic self-signed
 * fixture from `test/fixtures/tls/` — which is exactly the shape of EOS's own certificate
 * (`/persist/secure/capi.pem`, self-signed, SAN'd for the loopback names). So "what happens when a Node
 * client meets a stock switch" is answerable offline, and answerable honestly.
 *
 * pyeapi cross-reference: `HttpsEapiConnection` (`eapilib.py:646-673`) plus
 * `TestEapiConnection.test_send`-style behaviour. Upstream's `connect()` builds an **unverified** SSL
 * context unless `enforce_verification` is passed (`eapilib.py:672-701`, under a `TODO` admitting the
 * risk), so upstream's own suite has no analogue for cases 1–2 below; they are the DR-013 inversion,
 * and they are the reason `enforce_verification` is not ported (MIGRATION.md §7).
 *
 * Fingerprints are **computed** from the fixture with `certificateFingerprint`, never hard-coded hex,
 * so regenerating the fixtures (see the command in `test/fixtures/tls/`) cannot rot these assertions.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TlsError } from '../errors'
import { clearWarningRegistry } from '../internal/warn'
import {
  certificateFingerprint,
  healthyDevice,
  listenHttps,
  tlsFixture,
  tlsFixturePath,
  type LoopbackDevice,
  type LoopbackRequest,
} from '../testing/loopback-device'
import { TlsTransport } from './node-https'
import type { HttpsTransportOptions } from './contract'

let device: LoopbackDevice | undefined
let warnings: string[]

/** Options for the running listener, typed as the `https` kind accepts them. */
function optionsFor(extra: Omit<HttpsTransportOptions, 'kind' | 'host' | 'port'> = {}): HttpsTransportOptions {
  return { kind: 'https', host: device?.host as string, port: device?.port as number, ...extra }
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

describe('the certificate a stock switch serves: what the default configuration does', () => {
  it('fails with TlsError when nothing vouches for the device certificate (DR-013 is the point, not a bug)', async () => {
    device = await listenHttps(healthyDevice())
    const transport = new TlsTransport(optionsFor())
    const failure = await transport.execute('show version').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(TlsError)
    const typed = failure as InstanceType<typeof TlsError>
    // pyeapi would have connected happily here, unverified. The message must say what to do instead.
    expect(typed.message).toMatch(/self[- ]signed|unable to verify|self signed/u)
    expect(typed.message).toMatch(/ca|fingerprint|dangerouslyDisableTlsVerification/u)
    expect(typed.endpoint).toBe(`${device.origin}/command-api`)
    expect(typed.commands).toEqual(['show version'])
    // A trust failure is deterministic: nothing reached the CLI, and re-sending cannot help.
    expect(typed.retryable).toBe(true)
    expect(device.callCount()).toBe(0)
  })

  it('pinning a fingerprint without a `ca` does not bypass chain verification (pin ⊂ trust, never a replacement)', async () => {
    device = await listenHttps(healthyDevice())
    const pem = tlsFixture('loopback-self-signed.crt')
    const transport = new TlsTransport(optionsFor({ fingerprint: certificateFingerprint(pem, 'sha256') }))
    const failure = await transport.execute('show version').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(TlsError)
    expect(device.callCount()).toBe(0)
  })
})

describe('`ca`: an operator-supplied trust bundle makes the loopback certificate verify', () => {
  it('inline PEM `ca` completes the round trip and posts to /command-api', async () => {
    device = await listenHttps(healthyDevice())
    const transport = new TlsTransport(optionsFor({ ca: tlsFixture('loopback-self-signed.crt') }))
    const outcome = await transport.execute('show version')
    expect(outcome.ok).toBe(true)
    expect(device.callCount()).toBe(1)
    expect((device.last() as LoopbackRequest).url).toBe('/command-api')
    expect(transport.kind).toBe('https')
    expect(transport.address).toBe(`${device.origin}/command-api`)
    expect(String(transport)).toBe(transport.address)
    expect(warnings).toEqual([])
  })

  it('the same bundle as a file path behaves identically — both readings of DR-013 material', async () => {
    device = await listenHttps(healthyDevice())
    const transport = new TlsTransport(optionsFor({ ca: tlsFixturePath('loopback-self-signed.crt') }))
    expect((await transport.execute('show version')).ok).toBe(true)
    expect(warnings).toEqual([])
  })

  it('a `ca` that is not the issuing certificate still fails: trust is not "some PEM was supplied"', async () => {
    device = await listenHttps(healthyDevice())
    const transport = new TlsTransport(optionsFor({ ca: tlsFixture('loopback-client.crt') }))
    const failure = await transport.execute('show version').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(TlsError)
    expect(device.callCount()).toBe(0)
  })

  it('an unreadable `ca` path is a construction-time TlsError, with no socket opened (DR-030: no I/O in init)', async () => {
    device = await listenHttps(healthyDevice())
    let built = false
    try {
      new TlsTransport(optionsFor({ ca: '/nonexistent/eapi-ca.pem' }))
      built = true
    } catch (error) {
      expect(error).toBeInstanceOf(TlsError)
      expect((error as InstanceType<typeof TlsError>).message).toMatch(/cannot read CA certificate/u)
    }
    expect(built).toBe(false)
    expect(device.callCount()).toBe(0)
  })
})

describe('`dangerouslyDisableTlsVerification`: the loud escape hatch, per DR-013', () => {
  it('connects to the untrusted listener and warns once, naming the host:port that is now unauthenticated', async () => {
    device = await listenHttps(healthyDevice())
    const transport = new TlsTransport(optionsFor({ dangerouslyDisableTlsVerification: true }))
    expect((await transport.execute('show version')).ok).toBe(true)
    expect(device.callCount()).toBe(1)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/dangerouslyDisableTlsVerification/u)
    expect(warnings[0]).toMatch(new RegExp(`certificates from ${device.host}:${String(device.port)} are not verified`, 'u'))
    expect(warnings[0]).toMatch(/machine-in-the-middle/u)
  })

  it('it is never implied by a fingerprint pin, or by a failed verification (DR-013 stays closed by default)', async () => {
    device = await listenHttps(healthyDevice())
    const pem = tlsFixture('loopback-self-signed.crt')
    const pinned = new TlsTransport(optionsFor({ ca: pem, fingerprint: certificateFingerprint(pem, 'sha256') }))
    expect((await pinned.execute('show version')).ok).toBe(true)
    expect(warnings).toEqual([])
  })
})

describe('`fingerprint`: pinned certificate, exact match only', () => {
  it('accepts a sha256 pin computed from the fixture it is serving', async () => {
    device = await listenHttps(healthyDevice())
    const pem = tlsFixture('loopback-self-signed.crt')
    const transport = new TlsTransport(optionsFor({ ca: pem, fingerprint: certificateFingerprint(pem, 'sha256') }))
    expect((await transport.execute('show version')).ok).toBe(true)
    expect(device.callCount()).toBe(1)
  })

  it('accepts a colon-separated sha1 pin — the form `show management api http-commands https certificate` prints', async () => {
    device = await listenHttps(healthyDevice())
    const pem = tlsFixture('loopback-self-signed.crt')
    const transport = new TlsTransport(optionsFor({ ca: pem, fingerprint: certificateFingerprint(pem, 'sha1') }))
    expect((await transport.execute('show version')).ok).toBe(true)
  })

  it('rejects a pin for a different certificate, and says which is which (a changed cert vs an interception)', async () => {
    device = await listenHttps(healthyDevice())
    const offered = tlsFixture('loopback-self-signed.crt')
    const wrong = tlsFixture('loopback-client.crt')
    for (const algorithm of ['sha256', 'sha1'] as const) {
      const transport = new TlsTransport(optionsFor({ ca: offered, fingerprint: certificateFingerprint(wrong, algorithm) }))
      const failure = await transport.execute('show version').catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(TlsError)
      const message = (failure as InstanceType<typeof TlsError>).message
      expect(message).toMatch(new RegExp(`does not match the pinned ${algorithm} fingerprint`, 'u'))
      expect(message).toMatch(new RegExp(`expected [0-9a-f]{${algorithm === 'sha1' ? '40' : '64'}}`, 'u'))
      expect(message).toMatch(/switch regenerated it or someone is intercepting/u)
      // Fail-closed both times: the pin mismatch is noticed before any command is sent.
      expect(device.callCount()).toBe(0)
    }
  })

  it('a pin does not waive hostname verification: the name still has to match the certificate', async () => {
    device = await listenHttps(healthyDevice())
    const pem = tlsFixture('loopback-self-signed.crt')
    const transport = new TlsTransport(optionsFor({ ca: pem, fingerprint: certificateFingerprint(pem, 'sha256'), serverName: 'eapi-not-in-the-cert.invalid' }))
    const failure = await transport.execute('show version').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(TlsError)
    expect(device.callCount()).toBe(0)
  })
})

describe('`serverName`: the SNI/verification name when the address differs from the certificate', () => {
  it('verifies against `serverName` while connecting to the loopback address (a NAT in front of the switch)', async () => {
    device = await listenHttps(healthyDevice())
    // The fixture SANs are `localhost` + `127.0.0.1`; `127.0.0.1` is the address, `localhost` is the name.
    const transport = new TlsTransport(optionsFor({ ca: tlsFixture('loopback-self-signed.crt'), serverName: 'localhost' }))
    expect((await transport.execute('show version')).ok).toBe(true)
    expect(device.callCount()).toBe(1)
  })

  it('a name that is not in the certificate is a TlsError, not a warning', async () => {
    device = await listenHttps(healthyDevice())
    const transport = new TlsTransport(optionsFor({ ca: tlsFixture('loopback-self-signed.crt'), serverName: 'sw1.lan' }))
    const failure = await transport.execute('show version').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(TlsError)
    expect((failure as InstanceType<typeof TlsError>).message).toMatch(/sw1\.lan/u)
    expect(device.callCount()).toBe(0)
  })
})

describe('TLS material on the wrong scheme, and other construction mistakes', () => {
  it('TLS trust options on an http endpoint are refused by the Node factory (DR-013)', async () => {
    device = await listenHttps(healthyDevice())
    // TLS trust material on a cleartext endpoint is the mistake the other direction: `{ kind: 'http', ca }`
    // would silently discard the trust the caller thinks they configured. `{ kind: 'http', ca }` is
    // already a **compile** error (`ca?: never` on that kind); this asserts the runtime half, which
    // covers a caller who arrives through a cast or builds the options dynamically.
    const { createTransport } = await import('../node')
    const misplaced = {
      kind: 'http',
      host: '127.0.0.1',
      port: device.port,
      ca: tlsFixture('loopback-self-signed.crt'),
      allowInsecureTransport: true,
    } as unknown as Parameters<typeof createTransport>[0]
    // The refusal is worded like `buildRequest`'s parameter allow-list (DR-016): name the offending
    // key, name the kind, and list what that kind does accept — rather than a bespoke sentence.
    expect(() => createTransport(misplaced)).toThrow(/unsupported option 'ca' for transport kind 'http'/u)
    expect(() => createTransport(misplaced)).toThrow(/accepts [^)]*allowInsecureTransport/u)
  })
})
