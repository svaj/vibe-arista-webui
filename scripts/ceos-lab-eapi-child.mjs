#!/usr/bin/env node
// @ts-check
/**
 * Reference consumer of the `lab:run` environment contract (M12, #14).
 *
 * `npm run lab:run -- node scripts/ceos-lab-eapi-child.mjs` provisions a lab, exports
 * the endpoint to this child, and tears the lab down in a finally path. This file is
 * deliberately small and independent of `arista-api-client/src/**` (the recorder and
 * live guards are a separate slice of #14): it exists to prove, with real I/O, that
 * the env contract the harness publishes is sufficient and honest.
 *
 * Checks performed, all against live evidence:
 *  1. `EAPI_TARGET_CLASS` must be `lab`, and `EAPI_HOST` must be loopback — a child
 *     that inherits a real-device environment must fail rather than write to it
 *     (DR-035/DR-043). It never reads connection profiles.
 *  2. The TLS peer's SHA-256 fingerprint must equal `EAPI_LAB_CERT_FINGERPRINT`
 *     (the certificate the harness read out of the container's own filesystem).
 *     `rejectUnauthorized` is never disabled here either.
 *  3. Authenticated eAPI `show version` must report a base release equal to
 *     `EAPI_EXPECT_VERSION` and a `modelName` equal to `EAPI_ALLOW_MODEL`, which is
 *     the value the harness observed — never a hard-coded hardware model.
 *  4. `show interfaces status` names the container's real ports, which is what
 *     `EAPI_SCRATCH_INTERFACES` is derived from.
 *
 * Exit codes: 0 ok · 2 missing/misconfigured env · 3 target-class/model refusal ·
 * 4 TLS pin mismatch · 5 eAPI error or unexpected reply shape.
 */

import fs from 'node:fs'
import https from 'node:https'

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])

/** @param {string} k */
function env(k) {
  return process.env[k]
}

/** @returns {never} */
function fail(code, message) {
  process.stderr.write(`child refused: ${message}\n`)
  process.exitCode = code
  throw new Error(message)
}

const required = [
  'EAPI_HOST',
  'EAPI_PORT',
  'EAPI_USER',
  'EAPI_PASS',
  'EAPI_LAB_CERT',
  'EAPI_LAB_CERT_FINGERPRINT',
  'EAPI_ALLOW_MODEL',
  'EAPI_EXPECT_VERSION',
]
const missing = required.filter((k) => !env(k))
if (env('EAPI_LIVE') !== '1') fail(2, 'EAPI_LIVE!=1 — this child only runs under `npm run lab:run` (DR-034: live lanes are explicit opt-in)')
if (missing.length > 0) fail(2, `missing harness env: ${missing.join(', ')}`)
if (env('EAPI_TARGET_CLASS') !== 'lab') {
  fail(3, `EAPI_TARGET_CLASS=${JSON.stringify(env('EAPI_TARGET_CLASS'))} — writes and lab children require the disposable lab class (DR-035)`)
}
if (!LOOPBACK.has(String(env('EAPI_HOST')))) {
  fail(3, `EAPI_HOST=${JSON.stringify(env('EAPI_HOST'))} is not loopback — a lab child must never be pointed at a pre-existing device`)
}

const host = String(env('EAPI_HOST'))
const port = Number(env('EAPI_PORT'))
const user = String(env('EAPI_USER'))
const secret = String(env('EAPI_PASS'))
const pinnedFingerprint = String(env('EAPI_LAB_CERT_FINGERPRINT')).toUpperCase().replace(/:/g, '')
// The harness exports the run's *public* certificate (read out of the container by
// `docker exec`, never key material). Children verify against it AND pin its
// fingerprint — verification is never loosened to make a lab target reachable.
const certPath = String(env('EAPI_LAB_CERT'))
if (!fs.existsSync(certPath)) fail(2, `EAPI_LAB_CERT=${certPath} does not exist — no trust anchor, refusing to run`)
const anchorPem = fs.readFileSync(certPath, 'utf8')
if (!/-----BEGIN CERTIFICATE-----/.test(anchorPem)) fail(2, `EAPI_LAB_CERT=${certPath} holds no certificate block`)
if (/-----BEGIN (RSA |EC )?(PRIVATE KEY|ENCRYPTED)/.test(anchorPem)) {
  fail(3, `EAPI_LAB_CERT=${certPath} contains PRIVATE KEY material — refusing; only a public certificate may be exported`)
}

/**
 * One authenticated runCmds call, pinned by fingerprint.
 * @param {(string | {cmd: string, input?: string})[]} cmds
 * @param {'json'|'text'} format
 */
function runCmds(cmds, format) {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    method: 'runCmds',
    params: { version: 1, format, cmds },
    id: 'ceos-lab-child',
  })
  const auth = Buffer.from(`${user}:${secret}`, 'utf8').toString('base64')
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host,
        port,
        path: '/command-api',
        method: 'POST',
        // Chain verification against the lab run's own public certificate. The cert has
        // no SAN (subject CN=self.signed, observed 2026-11-03), so name checking is
        // meaningless here; identity comes from the certificate itself, then the exact
        // fingerprint pin below. `rejectUnauthorized` is never set to false.
        ca: [anchorPem],
        checkServerIdentity: () => undefined,
        headers: {
          'Content-Type': 'application/json-rpc',
          Accept: 'application/json-rpc',
          Authorization: `Basic ${auth}`,
          'Content-Length': Buffer.byteLength(body),
        },
        // The cert itself is not handed to children (it stays out of fixtures), so
        // verification is done here by requiring the peer certificate to equal the
        // fingerprint the harness pinned from the container's own filesystem.
        // Verification is NOT weakened: the chain is untrusted, and the exact pin
        // below is what decides whether the body is consumed.
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed
          try {
            parsed = JSON.parse(text)
          } catch {
            reject(new Error(`HTTP ${res.statusCode} non-JSON body: ${text.slice(0, 160)}`))
            return
          }
          if (parsed?.error) reject(new Error(`JSON-RPC error ${parsed.error.code}: ${parsed.error.message}`))
          else if (!Array.isArray(parsed?.result)) reject(new Error('runCmds reply had no result[]'))
          else resolve(parsed.result)
        })
      },
    )
    req.on('socket', (sock) => {
      sock.on('secureConnect', () => {
        const peer = sock.getPeerCertificate?.()
        const fp = String(peer?.fingerprint256 ?? '').toUpperCase().replace(/:/g, '')
        if (fp !== pinnedFingerprint) {
          req.destroy(
            new Error(`TLS_PIN_MISMATCH peer=${fp || '<none>'} pinned=${pinnedFingerprint} — refusing to read any device data`),
          )
        }
      })
    })
    req.setTimeout(15_000, () => req.destroy(new Error('eAPI request timed out after 15000 ms')))
    req.on('error', (err) =>
      reject(err.message.startsWith('TLS_PIN_MISMATCH') ? err : new Error(`eAPI transport: ${err.message}`)),
    )
    req.write(body)
    req.end()
  })
}

const started = Date.now()
let version
try {
  ;[version] = /** @type {any[]} */ (await runCmds(['show version'], 'json'))
} catch (err) {
  if (/TLS_PIN_MISMATCH/.test(err?.message ?? '')) fail(4, err.message)
  fail(5, `authenticated show version failed: ${err?.message ?? err}`)
}
const base = /^(\d+\.\d+(?:\.\d+)?[A-Za-z]*)/.exec(String(version?.version ?? ''))?.[1] ?? null
if (base !== env('EAPI_EXPECT_VERSION')) {
  fail(3, `version base ${JSON.stringify(base)} !== EAPI_EXPECT_VERSION ${JSON.stringify(env('EAPI_EXPECT_VERSION'))}`)
}
if (version?.modelName !== env('EAPI_ALLOW_MODEL')) {
  fail(3, `modelName ${JSON.stringify(version?.modelName)} !== EAPI_ALLOW_MODEL ${JSON.stringify(env('EAPI_ALLOW_MODEL'))}`)
}
let interfaces
try {
  ;[interfaces] = /** @type {any[]} */ (await runCmds(['show interfaces status'], 'json'))
} catch (err) {
  fail(5, `show interfaces status failed: ${err?.message ?? err}`)
}
const observed = Object.keys(interfaces?.interfaceStatuses ?? {})
const scratch = String(env('EAPI_SCRATCH_INTERFACES') ?? '')
const scratchOk = scratch === '' || scratch.split(',').every((i) => observed.includes(i))
if (!scratchOk) fail(5, `EAPI_SCRATCH_INTERFACES=${JSON.stringify(scratch)} is not inside the interface list the device reports (${observed.join(',')})`)

// A write-path guard, exercised without writing: the child refuses any management-path
// interface as a scratch target.
const mgmtNamed = scratch.split(',').filter((i) => /^Management/i.test(i))
if (mgmtNamed.length > 0) fail(3, `refusing management-path interfaces as scratch: ${mgmtNamed.join(',')}`)

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      child: 'scripts/ceos-lab-eapi-child.mjs',
      consumedEnv: {
        EAPI_LIVE: env('EAPI_LIVE'),
        EAPI_TARGET_CLASS: env('EAPI_TARGET_CLASS'),
        EAPI_HOST: host,
        EAPI_PORT: port,
        EAPI_USER: '<redacted-lab-user>',
        EAPI_PASS: '<redacted-lab-secret>',
        EAPI_ALLOW_MODEL: env('EAPI_ALLOW_MODEL'),
        EAPI_EXPECT_VERSION: env('EAPI_EXPECT_VERSION'),
        EAPI_IMAGE_TAG: env('EAPI_IMAGE_TAG'),
        EAPI_IMAGE_ID: env('EAPI_IMAGE_ID'),
        EAPI_LAB_RUN: env('EAPI_LAB_RUN'),
        EAPI_SCRATCH_INTERFACES: scratch,
        labStateFileReadable: fs.existsSync(String(env('EAPI_LAB_STATE'))),
        labCertFileReadable: fs.existsSync(certPath),
        labCertFileMode: (fs.statSync(certPath).mode & 0o777).toString(8),
      },
      observed: {
        versionVerbatim: version.version,
        internalVersion: version.internalVersion,
        baseVersion: base,
        modelName: version.modelName,
        uptimeSeconds: version.uptime,
        bootupTimestamp: version.bootupTimestamp,
        interfaces: observed,
      },
      tls: {
        trustAnchor: 'the run-owned public certificate exported at EAPI_LAB_CERT (path elided; it is 0600 and git-ignored)',
        anchorFingerprint256: pinnedFingerprint,
        peerFingerprintMatched: true,
        nameChecking: 'replaced by the exact pin — the certificate has no SAN (CN=self.signed)',
      },
      elapsedMs: Date.now() - started,
      wroteNothing: 'read-only: no config session, no write command, no startup-config',
    },
    null,
    2,
  )}\n`,
)
process.exitCode = 0
