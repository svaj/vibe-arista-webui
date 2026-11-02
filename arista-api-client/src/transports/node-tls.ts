/**
 * Node TLS trust — M2 (#4), DR-013. Lives behind `./node` only (`node:fs` + `node:tls`), because
 * "which CA do I trust, and do I pin this fingerprint" is a decision a browser cannot delegate to a
 * library (DR-002).
 *
 * pyeapi's position on the same question (`eapilib.py:672-701`) was: build an unverified SSL context
 * **unless** the caller passed `enforce_verification`, under a `TODO` comment calling it a security
 * risk. We invert that: verification is on unless the caller says the words
 * `dangerouslyDisableTlsVerification`, which also prints a one-line warning. `enforce_verification`
 * and `context=` are not reproduced (MIGRATION.md §7).
 *
 * EOS generates a self-signed certificate at `/persist/secure/capi.pem`
 * (`HttpServiceConstants.py:30-33`), so an unprepared Node client against a real switch *should* fail
 * with `TlsError` — that is the documented posture, not a bug to work around. Which fingerprint the
 * switch actually serves is an open device-sweep item (STATUS.md §3), so nothing here is pre-seeded.
 */

import { readFileSync } from 'node:fs'
import { checkServerIdentity, type ConnectionOptions, type PeerCertificate } from 'node:tls'

import { NotSupportedError, TlsError } from '../errors'
import { warnOnce } from '../internal/warn'
import { TLS_MATERIAL_KEYS, type TlsMaterialOptions } from './contract'

/** Trust material after resolution: PEM text, never a path, so the caller can cache or log safely. */
export interface ResolvedTlsMaterial {
  readonly ca?: readonly string[] | undefined
  readonly cert?: string | undefined
  readonly key?: string | undefined
  readonly serverName?: string | undefined
  readonly fingerprint?: string | undefined
  readonly fingerprintAlgorithm: 'sha256' | 'sha1'
  readonly verify: boolean
}

export interface NodeTlsConnect {
  /** Spread into `https.request`'s options. Empty when the endpoint is cleartext. */
  readonly connect: ConnectionOptions
  readonly material: ResolvedTlsMaterial
}

export interface TlsTarget {
  readonly scheme: 'http' | 'https'
  readonly host: string
  readonly port: number
}

/**
 * How verification is decided when no `ca` is supplied:
 *  - `'system'`: verify against Node's system CAs (the `https` / `session` kinds — DR-013 keeps
 *    verification on, and against a stock EOS self-signed cert that *fails*, which is the point);
 *  - `'off-without-ca'`: pyeapi's `HTTPSCertConnection.connect()` semantics for `https_certs`
 *    (`eapilib.py:230-247`) — no CA means no server-certificate check, kept deliberately and warned about.
 */
export type TlsMode = 'system' | 'off-without-ca'

/**
 * `ca`/`cert`/`key` accept inline PEM **or** a file path, because both readings are common: an
 * operator copying `key_file`/`cert_file` out of an `eapi.conf`, and a test that never wants a
 * fixture on disk. Detecting PEM by its header keeps the rule obvious; anything else is a path.
 */
function readMaterial(value: string, label: string): string {
  if (value.includes('-----BEGIN') || value.includes('-----END')) return value
  try {
    return readFileSync(value, 'utf8')
  } catch (error) {
    throw new TlsError(
      `cannot read ${label} from ${JSON.stringify(value)}: ${error instanceof Error ? error.message : String(error)}. Pass inline PEM if the file is not on this filesystem (DR-013).`,
      { cause: error },
    )
  }
}

function materialList(value: string | readonly string[] | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined
  const items = typeof value === 'string' ? [value] : [...value]
  if (items.length === 0) return undefined
  return items.map((item) => readMaterial(item, 'CA certificate'))
}

/** Normalise `AA:BB:…` / `aabb…` / `0xaabb` to bare lowercase hex. */
export function normalizeFingerprint(fingerprint: string): string {
  return fingerprint.replace(/^0x/i, '').replace(/[\s:._-]/g, '').toLowerCase()
}

export function fingerprintAlgorithm(fingerprint: string): 'sha256' | 'sha1' {
  const normalized = normalizeFingerprint(fingerprint)
  if (/^[0-9a-f]{64}$/.test(normalized)) return 'sha256'
  if (/^[0-9a-f]{40}$/.test(normalized)) return 'sha1'
  throw new TypeError(
    `fingerprint must be 64 hex digits (SHA-256) or 40 hex digits (SHA-1), got ${JSON.stringify(fingerprint)}. On EOS the value comes from "show management api http-commands https certificate" — see the device sweep (STATUS.md §3)`,
  )
}

/** Cert display form for a mismatch message, without any trust decision baked in. */
function certFingerprint(cert: PeerCertificate, algorithm: 'sha256' | 'sha1'): string {
  return algorithm === 'sha256' ? cert.fingerprint256 : cert.fingerprint
}

/**
 * Build the `tls` options for one transport.
 *
 * @param mode `'system'` (the `https`/`session` kinds: verify against the CA bundle **or** Node's
 *   system CAs) or `'off-without-ca'` (pyeapi's `https_certs` semantics: no `ca` given, so the server
 *   certificate is not checked — with a warning, because that is exactly the hole DR-013 closes).
 */
export function resolveTlsConnect(
  input: TlsMaterialOptions,
  target: TlsTarget,
  mode: TlsMode,
): NodeTlsConnect {
  const given = input as Record<string, unknown>
  // Only the trust-material keys count here. A transport hands this function its **whole** options
  // record, so `Object.keys(input)` would read `kind`, `host`, `username` and `password` as if they
  // were DR-013 material and refuse a legitimate cleartext `session` transport outright.
  const supplied = TLS_MATERIAL_KEYS.filter((key) => given[key] !== undefined)
  if (target.scheme === 'http' && supplied.length > 0) {
    throw new NotSupportedError(
      `TLS options (${supplied.join(', ')}) cannot apply to a cleartext http endpoint (${target.host}:${String(target.port)}). Use kind 'https' or an https baseUrl (DR-013).`,
    )
  }
  if ((input.cert === undefined) !== (input.key === undefined)) {
    throw new TypeError('client cert/key must be given together: mTLS needs both halves (pyeapi raises the same for https_certs)')
  }

  const ca = materialList(input.ca)
  const cert = input.cert === undefined ? undefined : readMaterial(input.cert, 'client certificate')
  const key = input.key === undefined ? undefined : readMaterial(input.key, 'client private key')
  const disableRequested = input.dangerouslyDisableTlsVerification === true

  const verify = mode === 'system' ? !disableRequested : !disableRequested && ca !== undefined
  if (disableRequested) {
    warnOnce(
      'tls-verification-disabled',
      `dangerouslyDisableTlsVerification: certificates from ${target.host}:${String(target.port)} are not verified and the peer is not authenticated. Anyone on the path to the switch can impersonate it, including a machine-in-the-middle on the management network (DR-013).`,
    )
  } else if (mode === 'off-without-ca' && ca === undefined) {
    warnOnce(
      'client-cert-no-ca',
      `the https-client-cert transport has no "ca", so the device certificate for ${target.host}:${String(target.port)} is not verified — this is pyeapi's https_certs behaviour, kept on purpose. Give "ca" or "fingerprint" to close it (DR-013).`,
    )
  }

  const algorithm = input.fingerprint === undefined ? 'sha256' : fingerprintAlgorithm(input.fingerprint)
  const connect: { -readonly [K in keyof ConnectionOptions]: ConnectionOptions[K] } = {
    servername: input.serverName ?? (isIpLiteral(target.host) ? undefined : target.host),
    rejectUnauthorized: verify,
  }
  if (ca !== undefined) connect.ca = [...ca]
  if (cert !== undefined) connect.cert = cert
  if (key !== undefined) connect.key = key
  if (input.serverName !== undefined && !isIpLiteral(target.host)) connect.servername = input.serverName

  if (input.fingerprint !== undefined) {
    const expected = normalizeFingerprint(input.fingerprint)
    const identityHost = input.serverName ?? target.host
    connect.checkServerIdentity = (hostname: string, certPeer: PeerCertificate): Error | undefined => {
      const actual = certFingerprint(certPeer, algorithm)
      if (normalizeFingerprint(actual) !== expected) {
        return new TlsError(
          `TLS certificate fingerprint for ${hostname}:${String(target.port)} does not match the pinned ${algorithm} fingerprint: expected ${expected}, the device offered ${normalizeFingerprint(actual)}. A changed certificate means either the switch regenerated it or someone is intercepting the connection — resolve it before disabling verification (DR-013).`,
          { endpoint: `${target.scheme}://${target.host}:${String(target.port)}` },
        )
      }
      // Pinning a key does not waive hostname verification: the name still has to match, unless the
      // peer is an IP literal, where Node's own check already handles subjectAltName IP entries.
      return checkServerIdentity(identityHost, certPeer)
    }
  }

  return {
    connect,
    material: {
      ...(ca === undefined ? {} : { ca }),
      ...(cert === undefined ? {} : { cert }),
      ...(key === undefined ? {} : { key }),
      ...(input.serverName === undefined ? {} : { serverName: input.serverName }),
      ...(input.fingerprint === undefined ? {} : { fingerprint: normalizeFingerprint(input.fingerprint) }),
      fingerprintAlgorithm: algorithm,
      verify,
    },
  }
}

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')
}
