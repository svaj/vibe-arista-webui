/**
 * DR-013 trust resolution — the pure half of `node-tls.ts` (M2 #4). `node-https.test.ts` covers what
 * an actual TLS listener answers to these decisions; this file pins the arithmetic around them:
 * which material is read (inline PEM vs a path), what `rejectUnauthorized` ends up as, what the
 * fingerprint helpers accept, and which mistakes are refused at construction rather than on the wire.
 *
 * pyeapi cross-reference (`eapilib.py:672-701`): upstream builds an **unverified** SSL context unless
 * the caller passes `enforce_verification`, under a `TODO` calling that a security risk. Every case
 * below asserts the inverted default, so a regression back to upstream's posture fails here
 * (MIGRATION.md §7 — `enforce_verification` and `context=` are deliberately not ported).
 *
 * Offline: no network at all. These calls resolve options; they never open a socket (DR-030), and the
 * only certificate material used is the synthetic loopback fixture in `test/fixtures/tls/`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { NotSupportedError, TlsError } from '../errors'
import { clearWarningRegistry, hasWarned } from '../internal/warn'
import { certificateFingerprint, tlsFixture, tlsFixturePath } from '../testing/loopback-device'
import { fingerprintAlgorithm, normalizeFingerprint, resolveTlsConnect } from './node-tls'
import type { ResolvedTlsMaterial, TlsTarget } from './node-tls'

/** The shape a real switch endpoint has: an IP-literal management address on 443. */
const TARGET: TlsTarget = { scheme: 'https', host: '127.0.0.1', port: 443 }

let warnings: string[]

beforeEach(() => {
  warnings = []
  clearWarningRegistry()
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]): void => {
    warnings.push(args.map((value) => String(value)).join(' '))
  })
})

describe('normalizeFingerprint / fingerprintAlgorithm (the pin syntax)', () => {
  it('accepts the colon-separated OpenSSL form EOS and `openssl x509 -fingerprint` print', () => {
    expect(normalizeFingerprint('AB:CD:EF')).toBe('abcdef')
  })

  it('accepts bare hex, `0x`-prefixed, spaced, dotted, dashed and upper-case forms', () => {
    expect(normalizeFingerprint('0xAABBCC')).toBe('aabbcc')
    expect(normalizeFingerprint('AA BB\nCC')).toBe('aabbcc')
    expect(normalizeFingerprint('aa-bb.cc')).toBe('aabbcc')
    expect(normalizeFingerprint('AABBCC')).toBe('aabbcc')
  })

  it('sizes the algorithm off the hex length: 64 → sha256, 40 → sha1', () => {
    expect(fingerprintAlgorithm('a'.repeat(64))).toBe('sha256')
    expect(fingerprintAlgorithm('B'.repeat(40))).toBe('sha1')
    // The same value written in OpenSSL's colon form has to pick the same algorithm.
    expect(fingerprintAlgorithm(certificateFingerprint(tlsFixture('loopback-self-signed.crt'), 'sha1'))).toBe('sha1')
    expect(fingerprintAlgorithm(certificateFingerprint(tlsFixture('loopback-self-signed.crt'), 'sha256'))).toBe('sha256')
  })

  it('refuses anything that is neither length, and names the EOS command the value comes from', () => {
    expect(() => fingerprintAlgorithm('abcdef')).toThrow(TypeError)
    expect(() => fingerprintAlgorithm('abcdef')).toThrow(/64 hex digits \(SHA-256\) or 40 hex digits \(SHA-1\)/u)
    expect(() => fingerprintAlgorithm('a'.repeat(63))).toThrow(/show management api http-commands/u)
  })
})

describe('what `rejectUnauthorized` becomes — the DR-013 default', () => {
  it('verification is ON with no options at all, even though that fails against a stock EOS self-signed cert', () => {
    const { connect, material } = resolveTlsConnect({}, TARGET, 'system')
    expect(connect.rejectUnauthorized).toBe(true)
    expect(material.verify).toBe(true)
    expect(material.ca).toBeUndefined()
    expect(warnings).toEqual([])
  })

  it('`ca` supplied: verifies against exactly that bundle, as an array Node can consume', () => {
    const { connect, material } = resolveTlsConnect({ ca: tlsFixture('loopback-self-signed.crt') }, TARGET, 'system')
    expect(connect.rejectUnauthorized).toBe(true)
    expect(material.verify).toBe(true)
    expect(material.ca).toHaveLength(1)
    expect(material.ca?.[0]).toContain('-----BEGIN CERTIFICATE-----')
    // pyeapi never warns about anything; DR-013 has nothing to say when the caller was explicit.
    expect(warnings).toEqual([])
  })

  it('`dangerouslyDisableTlsVerification` turns verification off and shouts once per process', () => {
    const first = resolveTlsConnect({ dangerouslyDisableTlsVerification: true }, TARGET, 'system')
    expect(first.connect.rejectUnauthorized).toBe(false)
    expect(first.material.verify).toBe(false)
    expect(warnings.join('\n')).toMatch(/dangerouslyDisableTlsVerification: certificates from 127\.0\.0\.1:443 are not verified/u)
    expect(warnings).toHaveLength(1)
    // Second transport, same process: the decision is still applied, the line is not repeated.
    const second = resolveTlsConnect({ dangerouslyDisableTlsVerification: true }, { ...TARGET, port: 8443 }, 'system')
    expect(second.connect.rejectUnauthorized).toBe(false)
    expect(warnings).toHaveLength(1)
    expect(hasWarned('tls-verification-disabled')).toBe(true)
  })

  it('`fingerprint` alone does not disable verification — pinning narrows trust, it does not replace it', () => {
    const { connect, material } = resolveTlsConnect({ fingerprint: certificateFingerprint(tlsFixture('loopback-self-signed.crt')) }, TARGET, 'system')
    expect(connect.rejectUnauthorized).toBe(true)
    expect(typeof connect.checkServerIdentity).toBe('function')
    expect(material.fingerprint).toBe(normalizeFingerprint(certificateFingerprint(tlsFixture('loopback-self-signed.crt'), 'sha256')))
  })

  it('`dangerouslyDisableTlsVerification: false` is not the same as `true`, and does not warn', () => {
    const { connect } = resolveTlsConnect({ dangerouslyDisableTlsVerification: false }, TARGET, 'system')
    expect(connect.rejectUnauthorized).toBe(true)
    expect(warnings).toEqual([])
  })
})

describe("the `'off-without-ca'` mode — pyeapi's `https_certs` behaviour, kept and warned about", () => {
  it('no `ca` in that mode: the server certificate is not verified, and that is said out loud', () => {
    const { connect, material } = resolveTlsConnect({ cert: tlsFixture('loopback-client.crt'), key: tlsFixture('loopback-client.key') }, TARGET, 'off-without-ca')
    expect(connect.rejectUnauthorized).toBe(false)
    expect(material.verify).toBe(false)
    expect(warnings.join('\n')).toMatch(/https-client-cert transport has no "ca"/u)
    expect(warnings.join('\n')).toMatch(/pyeapi's https_certs behaviour, kept on purpose/u)
    expect(hasWarned('client-cert-no-ca')).toBe(true)
  })

  it('`ca` in that mode: verification is on and the warning disappears', () => {
    const { connect, material } = resolveTlsConnect(
      { cert: tlsFixture('loopback-client.crt'), key: tlsFixture('loopback-client.key'), ca: tlsFixture('loopback-self-signed.crt') },
      TARGET,
      'off-without-ca',
    )
    expect(connect.rejectUnauthorized).toBe(true)
    expect(material.verify).toBe(true)
    expect(warnings).toEqual([])
  })

  it("`dangerouslyDisableTlsVerification` still wins over a supplied `ca` in that mode", () => {
    const { connect } = resolveTlsConnect({ ca: tlsFixture('loopback-self-signed.crt'), dangerouslyDisableTlsVerification: true }, TARGET, 'off-without-ca')
    expect(connect.rejectUnauthorized).toBe(false)
  })
})

describe('cert material resolution: inline PEM or a file path, by the same rule for all three', () => {
  /** How each key is supplied, plus the resolved value to look at, so the three rules stay one rule. */
  const CASES = [
    {
      label: 'ca',
      fixture: 'loopback-self-signed.crt' as const,
      missing: { ca: '/nonexistent/eapi-ca-bundle.pem' },
      present: (value: string) => ({ ca: value }),
      resolved: (material: ResolvedTlsMaterial) => material.ca?.[0],
    },
    {
      label: 'cert',
      fixture: 'loopback-client.crt' as const,
      missing: { cert: '/nonexistent/eapi-client.pem', key: tlsFixture('loopback-client.key') },
      present: (value: string) => ({ cert: value, key: tlsFixture('loopback-client.key') }),
      resolved: (material: ResolvedTlsMaterial) => material.cert,
    },
    {
      label: 'key',
      fixture: 'loopback-client.key' as const,
      missing: { cert: tlsFixture('loopback-client.crt'), key: '/nonexistent/eapi-client.key' },
      present: (value: string) => ({ cert: tlsFixture('loopback-client.crt'), key: value }),
      resolved: (material: ResolvedTlsMaterial) => material.key,
    },
  ]

  for (const testCase of CASES) {
    it(`${testCase.label}: a file path is read, and the path never survives into the resolved material`, () => {
      const path = tlsFixturePath(testCase.fixture)
      const resolved = testCase.resolved(resolveTlsConnect(testCase.present(path), TARGET, 'system').material)
      expect(resolved).toContain('-----BEGIN')
      expect(String(resolved)).not.toContain(path)
    })

    it(`${testCase.label}: inline PEM is passed through untouched, so a caller can supply it from memory`, () => {
      const pem = tlsFixture(testCase.fixture)
      expect(testCase.resolved(resolveTlsConnect(testCase.present(pem), TARGET, 'system').material)).toBe(pem)
    })

    it(`${testCase.label}: a string that is neither PEM nor a readable file is a TlsError, at construction not on the wire`, () => {
      const build = (): unknown => resolveTlsConnect(testCase.missing, TARGET, 'system')
      expect(build).toThrow(TlsError)
      expect(build).toThrow(/cannot read/u)
      // DR-013: the message points at the alternative, and never dumps file contents.
      expect(build).toThrow(/Pass inline PEM if the file is not on this filesystem/u)
      expect(build).toThrow(/nonexistent/u)
    })
  }

  it('an empty `ca` array means "no CA supplied", which DR-013 reads as system CAs — not as an empty bundle', () => {
    const { connect, material } = resolveTlsConnect({ ca: [] }, TARGET, 'system')
    expect(material.ca).toBeUndefined()
    expect(connect.ca).toBeUndefined()
    expect(connect.rejectUnauthorized).toBe(true)
  })

  it('several `ca` entries all arrive, as PEM, in order (a switch signed by an intermediate)', () => {
    const { connect, material } = resolveTlsConnect({ ca: [tlsFixturePath('loopback-self-signed.crt'), tlsFixture('loopback-client.crt')] }, TARGET, 'system')
    expect(material.ca).toHaveLength(2)
    expect(connect.ca).toHaveLength(2)
    expect((connect.ca as string[])[0]).toContain('-----BEGIN CERTIFICATE-----')
    expect((connect.ca as string[])[1]).toContain('-----BEGIN CERTIFICATE-----')
  })

  it('half an mTLS identity is refused with TypeError: cert without key, and key without cert', () => {
    // pyeapi raises `ValueError("both a key_file and cert_file are required")` in the connection
    // constructor (eapilib.py:220-222); here it is a TypeError, before any socket exists.
    expect(() => resolveTlsConnect({ cert: tlsFixture('loopback-client.crt') }, TARGET, 'off-without-ca')).toThrow(TypeError)
    expect(() => resolveTlsConnect({ key: tlsFixture('loopback-client.key') }, TARGET, 'off-without-ca')).toThrow(TypeError)
    for (const options of [{ cert: 'x' }, { key: 'x' }]) {
      expect(() => resolveTlsConnect(options, TARGET, 'off-without-ca')).toThrow(/cert\/key must be given together/u)
    }
  })

  it('TLS trust material on a cleartext endpoint is refused rather than silently dropped', () => {
    const cleartext: TlsTarget = { scheme: 'http', host: '127.0.0.1', port: 8080 }
    for (const options of [{ ca: tlsFixture('loopback-self-signed.crt') }, { fingerprint: 'aa:bb' }, { dangerouslyDisableTlsVerification: true }]) {
      const build = (): unknown => resolveTlsConnect(options, cleartext, 'system')
      expect(build).toThrow(NotSupportedError)
      expect(build).toThrow(/cannot apply to a cleartext http endpoint/u)
    }
    // The names of the offending keys are listed, so an `eapi.conf` profile mistake is findable.
    expect(() => resolveTlsConnect({ ca: 'pem', serverName: 'sw1' }, cleartext, 'system')).toThrow(/ca, serverName/u)
  })
})

describe('SNI / `servername`, which is how a NAT or proxy address in front of the switch still verifies', () => {
  it('an IP-literal endpoint sends no SNI name at all (RFC 6066 forbids one, and Node rejects it)', () => {
    const { connect } = resolveTlsConnect({}, TARGET, 'system')
    expect(connect.servername).toBeUndefined()
  })

  it('a DNS endpoint sends the host it was built from', () => {
    const { connect } = resolveTlsConnect({}, { scheme: 'https', host: 'sw1.lan', port: 443 }, 'system')
    expect(connect.servername).toBe('sw1.lan')
  })

  it('`serverName` overrides it for both address forms', () => {
    const { connect, material } = resolveTlsConnect({ serverName: 'sw1.lan' }, TARGET, 'system')
    expect(connect.servername).toBe('sw1.lan')
    expect(material.serverName).toBe('sw1.lan')
    expect(resolveTlsConnect({ serverName: 'other.lan' }, { scheme: 'https', host: 'sw1.lan', port: 443 }, 'system').connect.servername).toBe('other.lan')
  })

  it('an IPv6 loopback literal is an address, not a name — no SNI', () => {
    expect(resolveTlsConnect({}, { scheme: 'https', host: '::1', port: 443 }, 'system').connect.servername).toBeUndefined()
    expect(resolveTlsConnect({}, { scheme: 'https', host: '[::1]', port: 443 }, 'system').connect.servername).toBeUndefined()
  })
})

describe('the pinned-fingerprint callback', () => {
  it("sha256 is the default algorithm when the pin's length does not say otherwise", () => {
    const pem = tlsFixture('loopback-self-signed.crt')
    const withPin = resolveTlsConnect({ fingerprint: certificateFingerprint(pem, 'sha256') }, TARGET, 'system')
    expect(withPin.material.fingerprintAlgorithm).toBe('sha256')
    expect(typeof withPin.connect.checkServerIdentity).toBe('function')
  })

  it('a sha1 pin selects sha1, and is normalised to bare hex on the way in', () => {
    const pem = tlsFixture('loopback-self-signed.crt')
    const pinned = certificateFingerprint(pem, 'sha1')
    const { material } = resolveTlsConnect({ fingerprint: pinned.toLowerCase().replace(/:/gu, '') }, TARGET, 'system')
    expect(material.fingerprintAlgorithm).toBe('sha1')
    expect(material.fingerprint).toBe(pinned.toLowerCase().replace(/:/gu, ''))
  })

  it('a malformed pin is refused at construction, before any request is sent', () => {
    // The `ca` read fails first (TlsError), so the fingerprint is never the only thing checked.
    expect(() => resolveTlsConnect({ ca: '/nonexistent/ca.pem', fingerprint: certificateFingerprint(tlsFixture('loopback-self-signed.crt')) }, TARGET, 'system')).toThrow(TlsError)
    expect(() => resolveTlsConnect({ fingerprint: 'not-a-fingerprint' }, TARGET, 'system')).toThrow(TypeError)
  })
})
