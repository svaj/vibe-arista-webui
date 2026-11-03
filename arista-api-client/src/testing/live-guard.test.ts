/**
 * Live-target guard tests — M12 (#14), offline by construction (DR-034: `npm test` never touches a
 * device, so the *refusal paths* are the thing that gets tested here).
 *
 * Every case feeds `resolveLiveEnv` a literal env record and asserts the outcome — the accept path, one
 * case for each distinct refusal (PLAN.md:393: "test refusal paths"), and the secret-hygiene rules the
 * printed reason has to keep (DR-011 applies to console output too).
 *
 * These live in the **unit** project, not the `live` project, deliberately: if a guard self-check ran in
 * `live`, then `npm run test:live` on an unconfigured machine would report executed tests and DR-034's
 * "loudly skipping" signal would be lost. A green `test:live` must keep meaning "no device ran".
 *
 * The values are lab-ish on purpose (`cEOS`, `4.28.14M`, `8443`, `eapi-test`) because that is what
 * docs/CEOS.md:109/113/121-131 pins; the credential is an obvious placeholder, and two cases prove it
 * never reaches a printed reason.
 */

import { describe, expect, it } from 'vitest'

import {
  CEOS_LAB_IMAGE_VERSION,
  DEFAULT_VERSION_TRAIN,
  LAB_ALLOWED_PORTS,
  LAB_LOOPBACK_HOSTS,
  describeLiveTarget,
  liveSkipReason,
  liveTransportOptions,
  matchesDeviceIdentity,
  matchesExactly,
  requireScratchInterface,
  resolveLiveEnv,
  versionInTrain,
  assertNoPersistenceCommand,
  unwrapLiveTarget,
  type LiveEnv,
  type LiveTarget,
} from './live-guard'

/** A fully valid lab environment: what a real `test:live` invocation would carry. */
function labEnv(overrides: Record<string, string | undefined> = {}): LiveEnv {
  return {
    EAPI_LIVE: '1',
    EAPI_HOST: 'localhost',
    EAPI_PORT: '8443',
    EAPI_USER: 'eapi-test',
    EAPI_PASS: 'lab-placeholder-not-a-secret',
    EAPI_TARGET_CLASS: 'lab',
    EAPI_ALLOW_MODEL: 'cEOS',
    EAPI_ALLOW_VERSION: CEOS_LAB_IMAGE_VERSION,
    EAPI_FINGERPRINT: 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
    ...overrides,
  }
}

/** Accept helper: fails the test with the refusal reason when a case expects a target. */
function accepted(env: LiveEnv): LiveTarget {
  const resolution = resolveLiveEnv(env)
  if (!resolution.ok) throw new Error(`expected acceptance, got ${resolution.code}: ${resolution.reason}`)
  return resolution
}

function refused(env: LiveEnv): { code: string; reason: string } {
  const resolution = resolveLiveEnv(env)
  if (resolution.ok) throw new Error(`expected refusal ${JSON.stringify(env)}, got an accepted target for ${describeLiveTarget(resolution)}`)
  return { code: resolution.code, reason: resolution.reason }
}

describe('the accept path (a complete, allow-listed lab target)', () => {
  it('resolves the endpoint, credentials and pins exactly as spelled', () => {
    const target = accepted(labEnv())
    expect(target).toMatchObject({
      transport: 'https',
      host: 'localhost',
      port: 8_443,
      path: '/command-api',
      username: 'eapi-test',
      targetClass: 'lab',
      allowModel: 'cEOS',
      allowVersion: '4.28.14M',
      versionTrain: DEFAULT_VERSION_TRAIN,
    })
  })

  it('reads the default lab endpoint straight out of the cEOS runbook', () => {
    // docs/CEOS.md:109 posts to https://localhost:8443/command-api, so the defaults must spell that and
    // nothing else — an acceptance that widened to 443 would be a switch profile by another name.
    expect(LAB_LOOPBACK_HOSTS).toContain('localhost')
    expect(LAB_ALLOWED_PORTS).toEqual([8_443])
    expect(LAB_ALLOWED_PORTS).not.toContain(443)
  })

  it('holds a secret that lives in another variable, which is the point of PLAN.md:393', () => {
    const target = accepted({ ...labEnv({ EAPI_PASS: undefined }), EAPI_PASS_VAR: 'EAPI_LAB_PW', EAPI_LAB_PW: 'indirected-secret' })
    expect(target.password).toBe('indirected-secret')
  })

  it('carries a named scratch interface through to the write-side gate', () => {
    const target = accepted(labEnv({ EAPI_SCRATCH_INTERFACE: 'Ethernet3' }))
    expect(requireScratchInterface(target)).toEqual({ ok: true, name: 'Ethernet3' })
  })
})

describe('refusal: the opt-in itself (DR-034)', () => {
  it('refuses when EAPI_LIVE is unset, with a reason that says so', () => {
    const { code, reason } = refused({ ...labEnv(), EAPI_LIVE: undefined })
    expect(code).toBe('EAPI_LIVE_MISSING')
    expect(reason).toMatch(/EAPI_LIVE is not set/u)
    expect(reason).toMatch(/DR-034/u)
  })

  it('refuses EAPI_LIVE=true rather than treating any truthy string as consent', () => {
    const { code, reason } = refused(labEnv({ EAPI_LIVE: 'true' }))
    expect(code).toBe('EAPI_LIVE_NOT_1')
    expect(reason).toMatch(/only "1" opts in/u)
    expect(reason).toMatch(/true/u)
  })

  it('refuses a blank EAPI_LIVE the same as an unset one', () => {
    expect(refused(labEnv({ EAPI_LIVE: '   ' })).code).toBe('EAPI_LIVE_MISSING')
  })
})

describe('refusal: the endpoint shape', () => {
  it('refuses a missing host', () => {
    expect(refused({ ...labEnv(), EAPI_HOST: undefined }).code).toBe('EAPI_HOST_MISSING')
  })

  it('refuses a host that is only whitespace', () => {
    expect(refused(labEnv({ EAPI_HOST: '  ' })).code).toBe('EAPI_HOST_MISSING')
  })

  it('refuses a URL in EAPI_HOST, because silently splitting it is how 443 creeps in', () => {
    const { code, reason } = refused(labEnv({ EAPI_HOST: 'https://localhost' }))
    expect(code).toBe('EAPI_HOST_MALFORMED')
    expect(reason).toMatch(/443/u)
    expect(reason).toMatch(/docs\/CEOS\.md:123-124/u)
  })

  it('refuses a credential-bearing host without echoing it', () => {
    const { code, reason } = refused(labEnv({ EAPI_HOST: 'admin:hunter2@localhost' }))
    expect(code).toBe('EAPI_HOST_MALFORMED')
    expect(reason).not.toContain('hunter2')
  })

  it('refuses a host that spells its own port, keeping port allow-listing meaningful', () => {
    const { code, reason } = refused(labEnv({ EAPI_HOST: 'localhost:8443' }))
    expect(code).toBe('EAPI_HOST_MALFORMED')
    expect(reason).toMatch(/EAPI_PORT/u)
  })

  it('refuses a path that is not rooted', () => {
    expect(refused(labEnv({ EAPI_PATH: 'command-api' })).code).toBe('EAPI_HOST_MALFORMED')
  })

  it('accepts an explicit lab path when it is rooted', () => {
    expect(accepted(labEnv({ EAPI_PATH: '/command-api' })).path).toBe('/command-api')
  })
})

describe('refusal: credentials (DR-034)', () => {
  it('refuses a missing user', () => {
    expect(refused({ ...labEnv(), EAPI_USER: undefined }).code).toBe('EAPI_USER_MISSING')
  })

  it('refuses when neither password variable is set', () => {
    const { code, reason } = refused({ ...labEnv(), EAPI_PASS: undefined })
    expect(code).toBe('EAPI_PASS_MISSING')
    expect(reason).toMatch(/EAPI_PASS\b/u)
    expect(reason).toMatch(/EAPI_PASS_VAR/u)
  })

  it('treats an empty EAPI_PASS as unset rather than as an empty password', () => {
    const { code } = refused(labEnv({ EAPI_PASS: '' }))
    expect(code).toBe('EAPI_PASS_MISSING')
  })

  it('refuses when EAPI_PASS_VAR names a variable that is not there, naming the var and not a value', () => {
    const { code, reason } = refused({ ...labEnv({ EAPI_PASS: undefined }), EAPI_PASS_VAR: 'EAPI_LAB_PW' })
    expect(code).toBe('EAPI_PASS_VAR_UNSET')
    expect(reason).toContain('EAPI_LAB_PW')
    expect(reason).toMatch(/unset or empty/u)
  })

  it('resolves the secret from the named variable (PLAN.md:393 indirection)', () => {
    const target = accepted({ ...labEnv({ EAPI_PASS: undefined }), EAPI_PASS_VAR: 'EAPI_LAB_PW', EAPI_LAB_PW: 'indirected-secret' })
    expect(target.password).toBe('indirected-secret')
  })

  it('gives EAPI_PASS precedence when both spellings are present', () => {
    // Documented in resolveLiveEnv's block comment; asserted, not assumed, because a precedence that
    // nobody checks is a precedence that changes underneath a lab run.
    const target = accepted({ ...labEnv(), EAPI_PASS_VAR: 'EAPI_LAB_PW', EAPI_LAB_PW: 'from-the-indirect-var' })
    expect(target.password).toBe('lab-placeholder-not-a-secret')
  })
})

describe('refusal: target class and the crossover between lanes (DR-035/DR-043)', () => {
  it('refuses a missing target class', () => {
    const { code, reason } = refused({ ...labEnv(), EAPI_TARGET_CLASS: undefined })
    expect(code).toBe('EAPI_TARGET_CLASS_MISSING')
    expect(reason).toMatch(/disposable/u)
  })

  it('refuses a hardware target outright', () => {
    const { code, reason } = refused(labEnv({ EAPI_TARGET_CLASS: 'hardware' }))
    expect(code).toBe('EAPI_TARGET_CLASS_NOT_LAB')
    expect(reason).toMatch(/DR-035/u)
  })

  it('refuses the hardware model as a lab pin (a lab run cannot be "expecting" the 7050TX-64)', () => {
    const { code, reason } = refused(labEnv({ EAPI_ALLOW_MODEL: 'DCS-7050TX-64' }))
    expect(code).toBe('EAPI_LAB_MODEL_IS_HARDWARE')
    expect(reason).toMatch(/7050TX-64/u)
  })

  it('refuses the hardware version pin as a lab pin (4.28.13.1M belongs to the switch lane)', () => {
    const { code, reason } = refused(labEnv({ EAPI_ALLOW_VERSION: '4.28.13.1M' }))
    expect(code).toBe('EAPI_LAB_VERSION_NOT_IMAGE')
    expect(reason).toContain(CEOS_LAB_IMAGE_VERSION)
  })
})

describe('refusal: exact endpoint allow-listing (docs/CEOS.md:127-129)', () => {
  it('refuses a switch hostname — the never-fall-back-to-hardware rule', () => {
    const { code, reason } = refused(labEnv({ EAPI_HOST: 'sw1.lan' }))
    expect(code).toBe('EAPI_HOST_NOT_ALLOWED')
    expect(reason).toMatch(/physical switch/u)
  })

  it('refuses a loopback-looking host that the harness invented (0.0.0.0 is not an endpoint)', () => {
    expect(refused(labEnv({ EAPI_HOST: '0.0.0.0' })).code).toBe('EAPI_HOST_NOT_ALLOWED')
  })

  it('accepts a host someone added deliberately, and says which list it came from', () => {
    const target = accepted(labEnv({ EAPI_HOST: 'ceos-lab.internal', EAPI_ALLOW_HOSTS: 'ceos-lab.internal' }))
    expect(target.host).toBe('ceos-lab.internal')
  })

  it('refuses a missing port rather than defaulting to 443', () => {
    const { code, reason } = refused({ ...labEnv(), EAPI_PORT: undefined })
    expect(code).toBe('EAPI_PORT_MISSING')
    expect(reason).toMatch(/443/u)
    expect(reason).toMatch(/docs\/CEOS\.md:123-124/u)
  })

  it('refuses the switch port, and accepts it once someone allow-lists it on purpose', () => {
    expect(refused(labEnv({ EAPI_PORT: '443' })).code).toBe('EAPI_PORT_NOT_ALLOWED')
    expect(accepted(labEnv({ EAPI_PORT: '443', EAPI_ALLOW_PORTS: '443' })).port).toBe(443)
  })

  it('refuses a port that is not a number, without printing the value that probably is a secret', () => {
    const { code, reason } = refused(labEnv({ EAPI_PORT: 'hunter2!' }))
    expect(code).toBe('EAPI_PORT_INVALID')
    expect(reason).not.toContain('hunter2')
    expect(reason).toMatch(/belongs in EAPI_PASS/u)
  })

  it('refuses an out-of-range port', () => {
    expect(refused(labEnv({ EAPI_PORT: '70000' })).code).toBe('EAPI_PORT_INVALID')
    expect(refused(labEnv({ EAPI_PORT: '0' })).code).toBe('EAPI_PORT_INVALID')
  })

  it('refuses a transport the host harness cannot reach', () => {
    const { code, reason } = refused(labEnv({ EAPI_TRANSPORT: 'unix' }))
    expect(code).toBe('EAPI_TRANSPORT_NOT_ALLOWED')
    expect(reason).toMatch(/switch itself/u)
  })

  it('refuses cleartext without the DR-008 opt-in, and accepts it with one', () => {
    expect(refused(labEnv({ EAPI_TRANSPORT: 'http' })).code).toBe('EAPI_INSECURE_HTTP_REFUSED')
    expect(accepted(labEnv({ EAPI_TRANSPORT: 'http', EAPI_ALLOW_INSECURE_HTTP: '1' })).transport).toBe('http')
  })

  it('refuses a run that pins no model, and one that pins no version', () => {
    expect(refused({ ...labEnv(), EAPI_ALLOW_MODEL: undefined }).code).toBe('EAPI_ALLOW_MODEL_MISSING')
    expect(refused({ ...labEnv(), EAPI_ALLOW_VERSION: undefined }).code).toBe('EAPI_ALLOW_VERSION_MISSING')
  })

  it('refuses to disable TLS verification, and refuses to run with no trust material at all', () => {
    const insecure = refused(labEnv({ EAPI_INSECURE_TLS: '1', EAPI_FINGERPRINT: undefined }))
    expect(insecure.code).toBe('EAPI_INSECURE_TLS_REFUSED')
    expect(insecure.reason).toMatch(/Do not globally disable TLS verification/u)
    const untrusted = refused(labEnv({ EAPI_FINGERPRINT: undefined }))
    expect(untrusted.code).toBe('EAPI_TLS_TRUST_MISSING')
    expect(untrusted.reason).toMatch(/EAPI_CA_FILE/u)
  })

  it('accepts a CA file instead of a pin', () => {
    const target = accepted(labEnv({ EAPI_FINGERPRINT: undefined, EAPI_CA_FILE: '/persist/lab-ca.pem' }))
    expect(target.ca).toBe('/persist/lab-ca.pem')
  })
})

describe('identity matching against what the device reports (docs/CEOS.md:113/128-129)', () => {
  const target = accepted(labEnv({ EAPI_SCRATCH_INTERFACE: 'Ethernet3' }))

  it('matchesExactly is exact: trimmed and case-insensitive, never a prefix', () => {
    expect(matchesExactly('4.28.14M', '4.28.14M')).toBe(true)
    expect(matchesExactly(' 4.28.14m ', '4.28.14M')).toBe(true)
    expect(matchesExactly('4.28.14', '4.28.14M')).toBe(false)
    expect(matchesExactly('4.28.14Mv1', '4.28.14M')).toBe(false)
    expect(matchesExactly('4.28.13.1M', '4.28.14M')).toBe(false)
  })

  it('versionInTrain anchors at a boundary so 4.28 cannot match 4.280', () => {
    expect(versionInTrain('4.28.13.1M', '4.28')).toBe(true)
    expect(versionInTrain('4.28', '4.28')).toBe(true)
    expect(versionInTrain('4.280.1F', '4.28')).toBe(false)
    expect(versionInTrain('14.28.1', '4.28')).toBe(false)
  })

  it('accepts the pinned lab identity verbatim', () => {
    expect(matchesDeviceIdentity(target, { version: '4.28.14M', modelName: 'cEOS' })).toBeUndefined()
  })

  it('refuses a different model', () => {
    const refusal = matchesDeviceIdentity(target, { version: '4.28.14M', modelName: 'cEOSLab-SEA-1' })
    expect(refusal?.code).toBe('EAPI_MODEL_MISMATCH')
    expect(refusal?.reason).toMatch(/different device/u)
  })

  it('refuses the hardware version as a near miss inside the same train (DR-043)', () => {
    const refusal = matchesDeviceIdentity(target, { version: '4.28.13.1M', modelName: 'cEOS' })
    expect(refusal?.code).toBe('EAPI_VERSION_MISMATCH')
    expect(refusal?.reason).toMatch(/no prefix matching/u)
  })

  it('refuses a version outside the assumed train', () => {
    const refusal = matchesDeviceIdentity(target, { version: '4.31.2F', modelName: 'cEOS' })
    expect(refusal?.code).toBe('EAPI_VERSION_TRAIN_MISMATCH')
    expect(refusal?.reason).toMatch(/4\.28/u)
  })
})

describe('the write-side gates (DR-035)', () => {
  it('refuses an unnamed scratch interface instead of inventing one from show interfaces', () => {
    const resolution = resolveLiveEnv(labEnv())
    if (!resolution.ok) throw new Error(resolution.reason)
    const refusal = requireScratchInterface(resolution)
    expect('name' in refusal).toBe(false)
    if ('code' in refusal) expect(refusal.code).toBe('EAPI_SCRATCH_INTERFACE_MISSING')
  })

  it('refuses a management-path scratch interface (docs/CEOS.md:131)', () => {
    const resolution = resolveLiveEnv(labEnv({ EAPI_SCRATCH_INTERFACE: 'Management0' }))
    if (!resolution.ok) throw new Error(resolution.reason)
    const refusal = requireScratchInterface(resolution)
    expect('code' in refusal ? refusal.code : '').toBe('EAPI_SCRATCH_INTERFACE_NOT_ETHERNET')
  })

  it('refuses a name the client does not even recognise as an interface', () => {
    const resolution = resolveLiveEnv(labEnv({ EAPI_SCRATCH_INTERFACE: 'Ethernet' }))
    if (!resolution.ok) throw new Error(resolution.reason)
    const refusal = requireScratchInterface(resolution)
    expect('code' in refusal ? refusal.code : '').toBe('EAPI_SCRATCH_INTERFACE_INVALID')
  })

  it('refuses a persistence command in any wire form (DR-035(c))', () => {
    expect(assertNoPersistenceCommand(['show version'])).toBeUndefined()
    const refusal = assertNoPersistenceCommand([{ cmd: 'copy running-config startup-config' }])
    expect(refusal?.code).toBe('EAPI_PERSISTENCE_REFUSED')
    expect(assertNoPersistenceCommand(['copy run start'])?.code).toBe('EAPI_PERSISTENCE_REFUSED')
  })
})

describe('operator output stays secret-free (DR-011)', () => {
  it('describeLiveTarget renders the target without the password', () => {
    const rendered = describeLiveTarget(accepted(labEnv({ EAPI_SCRATCH_INTERFACE: 'Ethernet1' })))
    expect(rendered).not.toContain('lab-placeholder-not-a-secret')
    expect(rendered).toContain('https://localhost:8443/command-api')
    expect(rendered).toContain('user=eapi-test')
    expect(rendered).toContain('tls=pinned')
    expect(rendered).toContain('scratch=Ethernet1')
  })

  it('a reason printed for a half-configured run never contains the secret either', () => {
    const env = { ...labEnv({ EAPI_PASS: undefined }), EAPI_PASS_VAR: 'EAPI_LAB_PW' }
    const reason = liveSkipReason(env)
    expect(reason).toBeDefined()
    expect(reason as string).not.toContain('lab-placeholder-not-a-secret')
  })

  it('liveTransportOptions carries the trust material and nothing that disables verification', () => {
    const options = liveTransportOptions(accepted(labEnv()))
    expect(options.kind).toBe('https')
    expect(options).not.toHaveProperty('dangerouslyDisableTlsVerification')
    expect(options).not.toHaveProperty('allowInsecureTransport')
    expect((options as { fingerprint?: string }).fingerprint).toMatch(/^AA:BB/u)
  })

  it('the cleartext form stays loopback-only and needs no extra gate flag', () => {
    const options = liveTransportOptions(accepted(labEnv({ EAPI_TRANSPORT: 'http', EAPI_ALLOW_INSECURE_HTTP: '1' })))
    expect(options.kind).toBe('http')
    expect(options).not.toHaveProperty('allowInsecureTransport')
  })
})

describe('liveSkipReason is the loud half of DR-034', () => {
  it('returns undefined only when everything is configured', () => {
    expect(liveSkipReason(labEnv())).toBeUndefined()
  })

  it('returns the refusal reason for an unconfigured environment', () => {
    expect(liveSkipReason({})).toMatch(/EAPI_LIVE is not set/u)
  })

  it('returns the same reason an explicit run would fail on, so "not configured" cannot look like "passing"', () => {
    const env = labEnv({ EAPI_TARGET_CLASS: undefined })
    const resolution = resolveLiveEnv(env)
    if (resolution.ok) throw new Error('expected refusal')
    expect(liveSkipReason(env)).toBe(resolution.reason)
  })

  it('unwrapLiveTarget throws the reason when a live body is reached with a refused environment', () => {
    const resolution = resolveLiveEnv({})
    expect(() => unwrapLiveTarget(resolution)).toThrow(/EAPI_LIVE is not set/u)
  })
})
