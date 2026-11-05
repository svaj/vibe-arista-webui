#!/usr/bin/env node
// @ts-check
/**
 * cEOS-lab harness for the opt-in real-EOS lane (M12, issue #14).
 *
 * Plain Node ESM, no npm dependencies — only `node:` builtins. Runbook contract:
 * docs/CEOS.md (§Manual lab setup, §Planned harness contract and safety),
 * arista-api-client/docs/PLAN.md §M12, DECISIONS.md DR-034/DR-035/DR-043.
 * Vendor env/flags: /home/svaj/development/arista/cEOS/cEOS-lab-README-generic.txt.
 *
 * Safety properties this file enforces:
 *  - **Run-owned resources only.** Every container/network is named `ceos-lab-<runId>`
 *    and labelled `dev.eapi-lab.run=<runId>`. Teardown re-reads the label and refuses
 *    to remove anything whose label does not match, so a wrong run id can never
 *    delete someone else's container. No `docker prune`, no image/volume deletion.
 *  - **Readiness = EOS answering authenticated eAPI**, never Docker reporting a
 *    running container. `up` waits for EOS's own CLI; `probe` polls
 *    `POST /command-api` with basic auth and asserts version/model identity.
 *  - **Single-flight per endpoint**: `scripts/.state/lock-<port>.json`, stale-aware
 *    (the owning pid is checked) per docs/CEOS.md "Single-flight execution per endpoint".
 *  - **Lab-only credentials**, random per run, printed once, stored in a 0600 state
 *    file in a 0700 directory, deleted on teardown. They never appear in argv (the
 *    bootstrap is fed to `Cli` on stdin) and never appear in an error message.
 *  - **TLS is pinned, never downgraded.** The trust anchor is the *public*
 *    certificate read out of the container's own filesystem with `docker exec`
 *    (a trusted local side channel, per docs/CEOS.md), and the peer must present a
 *    byte-identical certificate. `rejectUnauthorized` is never false.
 *  - **No fallback, ever.** This process only dials the loopback port of the
 *    container it created. It never loads connection profiles, and it refuses when
 *    an inherited environment names a non-loopback `EAPI_HOST` or a target class
 *    other than `lab`.
 *
 * Exit codes (each refusal path is distinct and prints one `refused:` line):
 *   0 ok · 1 internal · 2 usage · 3 unsafe target/model · 4 endpoint claimed
 *   5 image tag/digest guard · 6 privileged runtime unavailable · 7 readiness or
 *   trust-target mismatch · 8 docker CLI failure · 9 teardown failure · `run`
 *   returns the child's exit code.
 */

import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import https from 'node:https'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'
import tls from 'node:tls'
import { fileURLToPath } from 'node:url'

const EXIT = /** @type {const} */ ({
  ok: 0,
  internal: 1,
  usage: 2,
  unsafeTarget: 3,
  claimedPort: 4,
  imageGuard: 5,
  privileged: 6,
  readiness: 7,
  docker: 8,
  teardown: 9,
})

const LABEL_RUN = 'dev.eapi-lab.run'
const LABEL_MANAGER = 'dev.eapi-lab.managed-by'
const MANAGER = 'scripts/ceos-lab.mjs'
const NAME_PREFIX = 'ceos-lab-'

/**
 * Pin for the locally imported image. `docker import` creates **no** RepoDigest, so
 * the value `docker images --digests` prints for an imported image is its local image
 * ID (observed 2026-11-03). Pinning that ID is what turns "a different tar was
 * imported into the same tag" into a hard stop.
 */
const IMAGE_PIN = {
  tag: 'arista/ceos:4.28.14M',
  imageId: 'sha256:8fd4e31caeba5db82d706eaed00252d67a1caa7d68670e5bd7e2af54935f2e28',
}

const DEFAULTS = {
  /** Full `version` string cEOS 4.28.14M reports over eAPI (observed 2026-11-03). */
  expectVersionFull: '4.28.14M-50015774.42814M (engineering build)',
  /** Base release the runbook pins; matched against `version`/`internalVersion`. */
  expectVersion: '4.28.14M',
  hostIp: '127.0.0.1',
  containerApiPort: 443,
  cliTimeoutSec: 360,
  probeTimeoutSec: 240,
  requestTimeoutMs: 15_000,
  retryDelayMs: 5_000,
}

/**
 * Vendor env, verbatim from cEOS-lab-README-generic.txt's `docker create` line. The
 * same pairs are repeated as `systemd.setenv=` kernel cmdline args because systemd
 * inside cEOS does not hand the container env to the EOS agents it starts.
 */
const VENDOR_ENV = [
  ['INTFTYPE', 'eth'],
  ['ETBA', '1'],
  ['SKIP_ZEROTOUCH_BARRIER_IN_SYSDBINIT', '1'],
  ['CEOS', '1'],
  ['EOS_PLATFORM', 'ceoslab'],
  ['container', 'docker'],
]

/** Public certificate locations for the eAPI server, as observed in this image. */
const CERT_CANDIDATES = ['/persist/secure/capi.pem', '/persist/secure/ssl/cagateway.pem']

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..')
const STATE_DIR = path.join(SCRIPT_DIR, '.state')
const FIXTURE_DIR = path.join(REPO_ROOT, 'arista-api-client', 'test', 'fixtures', 'live', 'ceos-4.28.14M')

/* ------------------------------------------------------------------ support */

class LabError extends Error {
  /** @param {number} code @param {string} message */
  constructor(code, message) {
    super(message)
    this.code = code
    this.name = 'LabError'
  }
}

/** @param {string} message @param {number} [code] */
function refuse(message, code = EXIT.internal) {
  throw new LabError(code, message)
}

/** Progress/diagnostic lines go to stderr so stdout stays parseable JSON.
 * @param {string} msg */
function log(msg) {
  process.stderr.write(`${msg}\n`)
}

/** @param {number} ms */
function secs(ms) {
  return (ms / 1000).toFixed(1)
}

function nowIso() {
  return new Date().toISOString()
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Run a program without a shell. Nothing that can carry the lab secret is ever put in
 * argv — `Cli` receives the bootstrap on stdin for exactly that reason.
 * @param {string} bin
 * @param {string[]} args
 * @param {{input?: string, timeoutMs?: number}} [opts]
 */
function run(bin, args, opts = {}) {
  const res = spawnSync(bin, args, {
    input: opts.input,
    timeout: opts.timeoutMs ?? 120_000,
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'utf8',
  })
  if (res.error) {
    refuse(`${bin} could not be run: ${res.error.message}`, bin === 'docker' ? EXIT.docker : EXIT.internal)
  }
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '', signal: res.signal }
}

/** @param {string[]} args @param {{input?: string, timeoutMs?: number}} [opts] */
function docker(args, opts) {
  const res = run('docker', args, opts)
  if (res.status !== 0) {
    const tail = (res.stderr || res.stdout || '(no output)').trim().split('\n').slice(-2).join(' | ')
    refuse(`docker ${args[0]} failed (exit ${res.status}): ${tail}`, EXIT.docker)
  }
  return res.stdout
}

/** docker call that never throws — diagnostics and ownership checks.
 * @param {string[]} args @param {{input?: string, timeoutMs?: number}} [opts] */
function dockerOpt(args, opts) {
  return run('docker', args, opts)
}

/**
 * Feed `commands` to EOS's CLI inside the container.
 * Observed 2026-11-03: `docker exec -i <c> Cli -p 15` takes a newline-separated
 * transcript on stdin (including `configure … end` and `| json` pipes), while
 * `Cli -c "a|b"` lets the shell eat the pipes and `Cli -c "<cmd> | json"` is
 * rejected as `% Invalid input`.
 * @param {string} container @param {string[]} commands @param {number} [timeoutMs]
 */
function cliScript(container, commands, timeoutMs = 90_000) {
  return docker(['exec', '-i', container, 'Cli', '-p', '15'], {
    input: `${commands.join('\n')}\n`,
    timeoutMs,
  })
}

/** EOS CLI transcript returning JSON (`<cmd> | json`).
 * @param {string} container @param {string} cmd */
function cliJson(container, cmd) {
  const out = cliScript(container, [`${cmd} | json`])
  const start = out.indexOf('{')
  if (start < 0) refuse(`no JSON object returned by "Cli" for "${cmd}": ${(out || '(empty)').slice(0, 200)}`, EXIT.internal)
  return JSON.parse(out.slice(start))
}

/** @param {string} runId */
function containerName(runId) {
  return `${NAME_PREFIX}${runId}`
}
/** @param {string} runId @param {'mgmt'|'data'} kind */
function networkName(runId, kind) {
  return `${NAME_PREFIX}${runId}-${kind}`
}

function newRunId() {
  return `lab-${process.pid}-${crypto.randomBytes(3).toString('hex')}`
}

/**
 * Random lab-only credentials. The alphabet deliberately excludes shell-active
 * characters: observed 2026-11-03, a `!` in the secret made zsh history-expand a
 * diagnostic `curl` argument, and a secret that cannot be safely quoted leaks.
 */
function makeLabCredentials() {
  const userAlphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const secretAlphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789-_'
  const pick = (/** @type {number} */ n, /** @type {string} */ alphabet) =>
    Array.from(crypto.randomBytes(n), (b) => alphabet[b % alphabet.length]).join('')
  return {
    user: `eapilab${pick(6, userAlphabet)}`,
    secret: `Aa9${pick(20, secretAlphabet)}`,
  }
}

/* ------------------------------------------------------- state and lock file */

/** @param {string} runId */
function statePath(runId) {
  return path.join(STATE_DIR, `session-${runId}.json`)
}
/** Public certificate anchor for a run (never key material), so children can pin the
 * same certificate the harness verified against. 0600 and git-ignored like the state.
 * @param {string} runId */
function certFilePath(runId) {
  return path.join(STATE_DIR, `cert-${runId}.pem`)
}
/** @param {number} port */
function lockPath(port) {
  return path.join(STATE_DIR, `lock-${port}.json`)
}

function ensureStateDir() {
  // recursive:true so an existing dir (left by an interrupted run) is fine; the
  // chmod keeps the 0700 guard even when the directory predates this call.
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  fs.chmodSync(STATE_DIR, 0o700)
}

/** The state file holds the lab secret, so it is 0600 inside a 0700 directory under
 * `scripts/.state/`, which `scripts/.gitignore` keeps out of git.
 * @param {Record<string, any>} state */
function writeState(state) {
  ensureStateDir()
  const p = statePath(state.runId)
  fs.writeFileSync(p, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  fs.chmodSync(p, 0o600)
  return p
}

/** @param {string} runId */
function readState(runId) {
  const p = statePath(runId)
  if (!fs.existsSync(p)) return undefined
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    refuse(`state file ${p} for run ${runId} is not valid JSON`, EXIT.usage)
  }
  if (!parsed?.runId || !parsed?.container) refuse(`state file ${p} is missing runId/container`, EXIT.usage)
  return parsed
}

/** @param {number} port */
function readLock(port) {
  const p = lockPath(port)
  if (!fs.existsSync(p)) return undefined
  try {
    return { path: p, ...JSON.parse(fs.readFileSync(p, 'utf8')) }
  } catch {
    return { path: p, runId: '<unreadable>', pid: -1 }
  }
}

/** @param {number} pid */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return /** @type {NodeJS.ErrnoException} */ (err).code === 'EPERM'
  }
}

/** @param {number} port @param {string} runId */
function claimLock(port, runId) {
  ensureStateDir()
  const existing = readLock(port)
  if (existing) {
    if (existing.runId !== runId && pidAlive(existing.pid)) {
      refuse(
        `endpoint ${DEFAULTS.hostIp}:${port} is already claimed by lab run ${existing.runId} (pid ${existing.pid}) — ` +
          'per-endpoint single-flight lock. Tear that run down (npm run lab:down) or use another port.',
        EXIT.claimedPort,
      )
    }
    log(`[lock] reclaiming stale lock for port ${port} (run ${existing.runId}, pid ${existing.pid} is gone)`)
  }
  const p = lockPath(port)
  fs.writeFileSync(
    p,
    `${JSON.stringify({ port, runId, pid: process.pid, claimedAt: nowIso() }, null, 2)}\n`,
    { mode: 0o600 },
  )
  return p
}

/** Remove this run's lock files, whichever port they name. @param {string} runId */
function releaseLocksForRun(runId) {
  if (!fs.existsSync(STATE_DIR)) return []
  const removed = []
  for (const entry of fs.readdirSync(STATE_DIR)) {
    if (!entry.startsWith('lock-')) continue
    const p = path.join(STATE_DIR, entry)
    let owner
    try {
      owner = JSON.parse(fs.readFileSync(p, 'utf8')).runId
    } catch {
      owner = undefined
    }
    if (owner === runId) {
      fs.rmSync(p, { force: true })
      removed.push(path.relative(REPO_ROOT, p))
    }
  }
  return removed
}

/* ---------------------------------------------------------------- guards */

/** DR-035/DR-043: target class `lab` or nothing. */
function guardTargetClass() {
  const tc = process.env['EAPI_TARGET_CLASS']
  if (tc !== undefined && tc !== 'lab') {
    refuse(
      `EAPI_TARGET_CLASS=${JSON.stringify(tc)} — this harness only creates disposable lab targets. ` +
        'Unset it, or set it to "lab"; it will not contact a physical switch.',
      EXIT.unsafeTarget,
    )
  }
}

/** An inherited EAPI_HOST that is not loopback means a real device is already
 * configured; refuse instead of letting a lab run share that environment. */
function guardInheritedHost() {
  const host = process.env['EAPI_HOST']
  if (host && host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    refuse(
      `EAPI_HOST=${JSON.stringify(host)} is inherited and is not a loopback lab endpoint. Refusing so a lab ` +
        'run can never be aimed at a pre-existing device (DR-043: no fallback).',
      EXIT.unsafeTarget,
    )
  }
}

/** Verify the tag exists locally and its image ID still matches the pin. Never pulls.
 * @param {{tag: string, imageId: string}} pin */
function inspectImage(pin) {
  if (pin.imageId && !/^sha256:[0-9a-f]{64}$/.test(pin.imageId)) {
    refuse(`image digest pin is malformed: ${JSON.stringify(pin.imageId)}`, EXIT.imageGuard)
  }
  const probe = dockerOpt(['image', 'inspect', '--format', '{{.Id}}\t{{.Size}}', pin.tag])
  if (probe.status !== 0) {
    refuse(
      `image tag ${pin.tag} is not present locally: ${(probe.stderr || 'docker image inspect failed').trim().split('\n')[0]}. ` +
        'Import the authorized cEOS-lab tar first (docs/CEOS.md §Manual lab setup). This harness never pulls an image.',
      EXIT.imageGuard,
    )
  }
  const [id, size] = probe.stdout.trim().split('\t')
  if (pin.imageId && !id.startsWith(pin.imageId)) {
    refuse(
      `image ${pin.tag} currently has ID ${id}, not the pinned ${pin.imageId}. A different image was imported into ` +
        'this tag, so the M12 image-identity pin fails and nothing is started.',
      EXIT.imageGuard,
    )
  }
  const digestsRaw = dockerOpt(['image', 'inspect', '--format', '{{json .RepoDigests}}', pin.tag]).stdout.trim()
  const digests = !digestsRaw || digestsRaw === '[]' ? [] : JSON.parse(digestsRaw)
  if (digests.length > 0 && pin.imageId && !digests.some((d) => String(d).endsWith(pin.imageId.slice('sha256:'.length)))) {
    refuse(
      `image ${pin.tag} carries registry digests (${digests.join(', ')}) none of which match the pinned ID ${pin.imageId}`,
      EXIT.imageGuard,
    )
  }
  const info = dockerOpt(['info', '--format', '{{.ServerVersion}}\t{{.OperatingSystem}}\t{{.Architecture}}'])
  if (info.status !== 0) {
    refuse(`the Docker daemon is not usable: ${(info.stderr || 'docker info failed').trim().split('\n')[0]}`, EXIT.docker)
  }
  const [serverVersion, operatingSystem, architecture] = info.stdout.trim().split('\t')
  return {
    tag: pin.tag,
    imageId: id,
    sizeBytes: Number(size),
    repoDigests: digests,
    note:
      digests.length === 0
        ? 'no RepoDigest: the tag came from `docker import` (no registry push), so the local image ID is the only stable identity'
        : 'RepoDigest present; for a locally imported tag Docker reports a digest equal to the local image ID (observed 2026-11-03), so the digest column is **not** proof of registry provenance',
    daemon: { serverVersion, operatingSystem, architecture },
  }
}

/* ------------------------------------------------------------------ eAPI */

/**
 * Look at the certificate the published port actually serves **without trusting it**.
 * The result is only used to detect that the pinned copy changed.
 * @param {{host: string, port: number}} target
 */
function peekServedCert(target) {
  return new Promise((resolve) => {
    const sock = tls.connect(
      { host: target.host, port: target.port, rejectUnauthorized: false, timeout: 10_000 },
      () => {
        const cert = sock.getPeerCertificate(true)
        const fingerprint = String(cert?.fingerprint256 ?? '').toUpperCase().replace(/:/g, '')
        const done = () => sock.destroy()
        if (typeof tls.shutdownSecureConnection === 'function') tls.shutdownSecureConnection(sock, done)
        else done()
        resolve({
          fingerprint256: fingerprint,
          subject: cert?.subject ? JSON.stringify(cert.subject) : null,
          issuer: cert?.issuer ? JSON.stringify(cert.issuer) : null,
          validFrom: cert?.valid_from ?? null,
          validTo: cert?.valid_to ?? null,
          serialNumber: cert?.serialNumber ?? null,
        })
      },
    )
    sock.on('error', (err) => resolve({ error: err.message, fingerprint256: null }))
    sock.on('timeout', () => sock.destroy(new Error('TLS handshake timed out')))
  })
}

/**
 * Read the API server's **public certificate** out of the container's own filesystem:
 * the local `docker exec` side channel, which is the trust anchor docs/CEOS.md asks
 * for ("Establish HTTPS trust from the local container/CLI, not from an unverified
 * network peer"). Only a `-----BEGIN CERTIFICATE-----` block is accepted, and any
 * file that also carries key material is reported, never used or printed.
 * @param {string} container
 */
function readContainerPublicCert(container) {
  /** @type {{path: string, reason: string}[]} */
  const tried = []
  for (const p of CERT_CANDIDATES) {
    const cat = dockerOpt(['exec', container, 'cat', p])
    if (cat.status !== 0) {
      tried.push({ path: p, reason: (cat.stderr || 'unreadable').trim().split('\n')[0] })
      continue
    }
    const block = cat.stdout.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/)
    if (!block) {
      tried.push({ path: p, reason: 'contains no CERTIFICATE block' })
      continue
    }
    const pem = block[0]
    const cert = new crypto.X509Certificate(pem)
    return {
      pem,
      path: p,
      fingerprint256: cert.fingerprint256.toUpperCase().replace(/:/g, ''),
      subject: cert.subject.replace(/\n/g, ' / '),
      issuer: cert.issuer.replace(/\n/g, ' / '),
      notBefore: cert.validFrom,
      notAfter: cert.validTo,
      serial: cert.serialNumber,
      keyType: cert.publicKey?.asymmetricKeyType ?? null,
      keyBits: cert.publicKey?.asymmetricKeyDetails?.modulusLength ?? cert.publicKey?.asymmetricKeySize ?? null,
      // Observed 2026-11-03: cEOS keeps the key in a sibling file (capikey.pem), so
      // this file is the public half — but only the public block is ever kept here.
      fileAlsoHeldPrivateKey: /-----BEGIN (RSA |EC )?(PRIVATE KEY|ENCRYPTED)/.test(cat.stdout),
      tried,
    }
  }
  return { pem: null, path: null, tried }
}

/**
 * Authenticated eAPI `runCmds`, pinned to the certificate extracted above.
 * Hostname/SAN validation is not achievable with this certificate (observed subject
 * `CN=self.signed`, no SAN), so identity comes from requiring a byte-identical pinned
 * certificate — never from disabling verification.
 * @param {{host: string, port: number, user: string, secret: string, anchor: {pem: string, fingerprint256: string}}} t
 * @param {{cmds: (string | {cmd: string, input?: string})[], format: 'json' | 'text', id: string, timeoutMs: number}} req
 */
function eapiRunCmds(t, req) {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    method: 'runCmds',
    params: { version: 1, format: req.format, cmds: req.cmds },
    id: req.id,
  })
  const auth = Buffer.from(`${t.user}:${t.secret}`, 'utf8').toString('base64')
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const request = https.request(
      {
        host: t.host,
        port: t.port,
        path: '/command-api',
        method: 'POST',
        ca: [t.anchor.pem],
        // Chain verification still runs against the extracted public certificate;
        // this only replaces the meaningless name check, which the secureConnect
        // guard below re-imposes as an exact-pin comparison.
        checkServerIdentity: () => undefined,
        headers: {
          'Content-Type': 'application/json-rpc',
          Accept: 'application/json-rpc',
          Authorization: `Basic ${auth}`,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 300)}`))
            return
          }
          let parsed
          try {
            parsed = JSON.parse(raw)
          } catch {
            reject(new Error(`HTTP 200 with a non-JSON body: ${raw.slice(0, 200)}`))
            return
          }
          if (parsed?.error) {
            const e = parsed.error
            const detail = Array.isArray(e?.data?.errors) ? e.data.errors.join(' | ') : ''
            reject(new Error(`JSON-RPC error ${e.code}: ${e.message}${detail ? ` [${detail}]` : ''}`))
            return
          }
          if (!Array.isArray(parsed?.result)) {
            reject(new Error(`runCmds reply carried no result[] (keys: ${Object.keys(parsed ?? {}).join(',')})`))
            return
          }
          resolve({ result: parsed.result, ms: Date.now() - started, statusCode: res.statusCode })
        })
      },
    )
    request.on('socket', (sock) => {
      sock.on('secureConnect', () => {
        if (!sock.authorized) {
          request.destroy(
            new Error(`TLS verification failed against the pinned certificate: ${sock.authorizationError}`),
          )
          return
        }
        const peer = sock.getPeerCertificate?.()
        const peerFp = String(peer?.fingerprint256 ?? '').toUpperCase().replace(/:/g, '')
        if (peerFp !== t.anchor.fingerprint256) {
          request.destroy(new Error(`served certificate fingerprint ${peerFp || '<none>'} !== pinned ${t.anchor.fingerprint256}`))
        }
      })
    })
    request.setTimeout(req.timeoutMs, () => request.destroy(new Error(`eAPI request timed out after ${req.timeoutMs} ms`)))
    request.on('error', reject)
    request.write(body)
    request.end()
  })
}

/* --------------------------------------------------------------- version */

/** @param {string} fullOrInternal */
function baseVersionOf(fullOrInternal) {
  const m = /^(\d+\.\d+(?:\.\d+)?[A-Za-z]*)/.exec(String(fullOrInternal ?? ''))
  return m ? m[1] : null
}

/** @param {any} v */
function identityFromShowVersion(v) {
  const full = typeof v?.version === 'string' ? v.version : null
  const internal = typeof v?.internalVersion === 'string' ? v.internalVersion : null
  return {
    versionVerbatim: full,
    internalVersionVerbatim: internal,
    baseFromVersion: baseVersionOf(full),
    baseFromInternal: baseVersionOf(internal),
    bareInternal: typeof internal === 'string' ? internal.replace(/-\d+\.[^-]*$/, '') : null,
    modelName: v?.modelName ?? null,
    mfgName: v?.mfgName ?? null,
    architecture: v?.architecture ?? null,
    kernelVersion: v?.kernelVersion ?? null,
    serialNumber: v?.serialNumber ?? null,
    systemMacAddress: v?.systemMacAddress ?? null,
    hwMacAddress: v?.hwMacAddress ?? null,
    configMacAddress: v?.configMacAddress ?? null,
    bootupTimestamp: v?.bootupTimestamp ?? null,
    bootupTimeIso:
      typeof v?.bootupTimestamp === 'number' ? new Date(v.bootupTimestamp * 1000).toISOString() : null,
    uptimeSeconds: v?.uptime ?? null,
    cEosToolsVersion: v?.cEosToolsVersion ?? null,
    imageFormatVersion: v?.imageFormatVersion ?? null,
    isIntlVersion: v?.isIntlVersion ?? null,
  }
}

/* ------------------------------------------------------------------- up */

/** Ephemeral loopback port plus the run-held lock, taking the lock before returning.
 * @param {string} hostIp @param {string} runId @param {number | null} requested */
async function allocateEndpoint(hostIp, runId, requested) {
  if (requested !== null) {
    if (!Number.isInteger(requested) || requested < 1024 || requested > 65_535) {
      refuse(`--port must be an unprivileged TCP port (1024-65535), got ${JSON.stringify(requested)}`, EXIT.usage)
    }
  }
  const port = await new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', (err) => {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code
      if (requested !== null && code === 'EADDRINUSE') {
        reject(new LabError(EXIT.claimedPort, `requested port ${requested} is already in use on ${hostIp}`))
        return
      }
      reject(new LabError(EXIT.claimedPort, `could not bind an ephemeral port on ${hostIp}: ${code ?? err}`))
    })
    srv.listen(requested ?? 0, hostIp, () => {
      const addr = srv.address()
      if (!addr || typeof addr === 'string') {
        srv.close()
        reject(new LabError(EXIT.claimedPort, `no port allocated on ${hostIp}`))
        return
      }
      const p = addr.port
      srv.close(() => resolve(p))
    })
  })
  claimLock(port, runId)
  return port
}

/** Bounded wait for EOS's own CLI to answer inside the container.
 * @param {string} container @param {number} timeoutSec */
async function waitForEosCli(container, timeoutSec) {
  const started = Date.now()
  /** @type {{attempt: number, elapsedSeconds: number, exitCode: number, line: string}[]} */
  const observations = []
  let attempt = 0
  let last = 'no attempt made'
  while (Date.now() - started < timeoutSec * 1000) {
    attempt += 1
    // `Cli` exits 0 as soon as the CLI binary runs, so readiness is proven by the
    // reply text, not by the exit code.
    const res = dockerOpt(['exec', container, 'Cli', '-p', '15', '-c', 'show version'])
    const elapsed = secs(Date.now() - started)
    if (res.status === 0 && /Software image version:/.test(res.stdout)) {
      log(`[up] EOS CLI answered on attempt ${attempt} after ${elapsed}s`)
      return { ready: true, attempt, elapsedMs: Date.now() - started, text: res.stdout, observations }
    }
    const line = (res.stderr || res.stdout || '(no output)').trim().split('\n').pop() ?? '(empty)'
    last = line
    observations.push({ attempt, elapsedSeconds: +elapsed, exitCode: res.status, line })
    log(`[up] attempt ${attempt} (${elapsed}s): EOS CLI not ready — ${line}`)
    if (/no space left|seccomp|AppArmor|permission denied|read-only file system|cgroup/i.test(res.stderr)) {
      refuse(
        `cEOS could not come up under this Docker runtime — privileged-mode failure suspected: ${line}`,
        EXIT.privileged,
      )
    }
    await sleep(DEFAULTS.retryDelayMs)
  }
  return { ready: false, attempt, elapsedMs: Date.now() - started, observations, last }
}

/* --------------------------------------------------------------- up command */

/** @param {ReturnType<typeof labConfig>} cfg */
async function cmdUp(cfg) {
  const t0 = Date.now()
  const runId = cfg.runId ?? newRunId()
  const names = {
    runId,
    container: containerName(runId),
    mgmt: networkName(runId, 'mgmt'),
    data: networkName(runId, 'data'),
  }
  /** @type {number} */
  let port
  try {
    const image = inspectImage(cfg.image)
    log(
      `[up] image ${image.tag} ${image.imageId.slice(0, 19)}… ${(image.sizeBytes / 1e9).toFixed(2)} GB · daemon ` +
        `docker ${image.daemon.serverVersion} / ${image.daemon.operatingSystem} / ${image.daemon.architecture}`,
    )
    port = await allocateEndpoint(cfg.hostIp, runId, cfg.port)
    log(`[up] run ${runId} · endpoint ${cfg.hostIp}:${port} -> ${names.container}:${cfg.containerApiPort}`)
    // ONE network attached — evidence 2026-11-04 (post-reboot verification of the 2026-11-03 runs).
    // Attaching `-mgmt` AND `-data` made the published port flap: `docker run -p` resolves the
    // container endpoint among the attachments with no documented tie-break, and bare cEOS (this
    // harness's ZTP-free boot) only plumbs a kernel route/address on the FIRST attachment — the
    // second NIC answers nothing on its docker-side IP, so whenever the picker chose that endpoint
    // every TCP+TLS connect to the published port died ECONNRESET (30/30 probe attempts) while
    // `docker exec` curl of the container's own eth0 returned 405. Detaching the second network at
    // runtime made the published path work instantly (405 = method, not transport). The data NIC has
    // no consumer yet — two-node MLAG topologies (DR-043) belong to a later lane, and when they come,
    // attach-then-publish must name the endpoint explicitly instead of relying on the picker.
    for (const net of [names.mgmt]) {
      docker(['network', 'create', `--label=${LABEL_RUN}=${runId}`, `--label=${LABEL_MANAGER}=${MANAGER}`, net])
    }
    const createArgs = [
      'create',
      `--name=${names.container}`,
      '--privileged',
      `--label=${LABEL_RUN}=${runId}`,
      `--label=${LABEL_MANAGER}=${MANAGER}`,
      `--network=${names.mgmt}`,
      `-p=${cfg.hostIp}:${port}:${cfg.containerApiPort}`,
    ]
    for (const [k, v] of VENDOR_ENV) createArgs.push('-e', `${k}=${v}`)
    createArgs.push('-i', image.tag, '/sbin/init')
    for (const [k, v] of VENDOR_ENV) createArgs.push(`systemd.setenv=${k}=${v}`)
    const cid = docker(createArgs).trim()
    // `docker inspect --format …` prints ONE object per item (no array wrapper), so
    // each field is read with its own template instead of parsing `{{json .}}`.
    const labelsOut = docker(['container', 'inspect', '--format', '{{json .Config.Labels}}', names.container]).trim()
    const inspectLabels = labelsOut === 'null' || !labelsOut ? {} : JSON.parse(labelsOut)
    if (inspectLabels[LABEL_RUN] !== runId) {
      refuse(`container ${names.container} does not carry ${LABEL_RUN}=${runId} — refusing to manage it`, EXIT.internal)
    }
    const privileged = docker(['container', 'inspect', '--format', '{{.HostConfig.Privileged}}', names.container]).trim()
    const imageRef = docker(['container', 'inspect', '--format', '{{.Config.Image}}', names.container]).trim()
    if (privileged !== 'true') {
      refuse(
        `docker recorded HostConfig.Privileged=${privileged} for ${names.container}; cEOS needs ` +
          '--privileged (vendor README). Fix the daemon policy instead of starting a degraded lab.',
        EXIT.privileged,
      )
    }
    log(`[up] created container ${names.container} (id ${cid.slice(0, 12)}, image ref ${imageRef})`)
    docker(['start', names.container])
    const cli = await waitForEosCli(names.container, cfg.cliTimeoutSec)
    if (!cli.ready) {
      const logs = dockerOpt(['container', 'logs', '--tail', '20', names.container])
      log(`[up] container log tail:\n${(logs.stdout + logs.stderr).trim().split('\n').slice(-8).join('\n')}`)
      const st = dockerOpt([
        'container', 'inspect', '--format',
        '{{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} started={{.State.StartedAt}}',
        names.container,
      ])
      refuse(
        `EOS never answered inside ${names.container} within ${cfg.cliTimeoutSec}s (${cli.attempt} attempts, last: ` +
          `${cli.last}; docker state: ${st.stdout.trim()}). The container can run while EOS is not up — readiness is EOS, not Docker.`,
        EXIT.readiness,
      )
    }
    const dockerIps = docker([
      'container', 'inspect', '--format',
      `{{range $k, $v := .NetworkSettings.Networks}}{{$k}}={{$v.IPAddress}}/{{$v.IPPrefixLen}} {{end}}`,
      names.container,
    ]).trim()
    const creds = makeLabCredentials()
    const bootstrapStart = Date.now()
    const bootstrapTranscript = bootstrapLab(names.container, creds)
    const bootstrapMs = Date.now() - bootstrapStart

    const versionJson = cliJson(names.container, 'show version')
    const interfacesJson = cliJson(names.container, 'show interfaces status')
    const httpCommandsJson = cliJson(names.container, 'show management api http-commands')

    const state = {
      runId,
      schema: 1,
      container: names.container,
      containerId: cid,
      networks: { mgmt: names.mgmt },
      hostIp: cfg.hostIp,
      port,
      containerApiPort: cfg.containerApiPort,
      imageTag: image.tag,
      imageId: image.imageId,
      repoDigests: image.repoDigests,
      user: creds.user,
      secret: creds.secret,
      createdAt: new Date(t0).toISOString(),
      cliReadyMs: cli.elapsedMs,
      cliReadyAttempts: cli.attempt,
      cliNotReadyObservations: cli.observations,
      bootstrapMs,
      bootstrapTranscript: redactCopy(bootstrapTranscript),
      dockerIps,
      versionJson,
      interfacesJson,
      httpCommandsJson,
    }
    const sp = writeState(state)
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          runId,
          container: names.container,
          containerId: cid,
          networks: names,
          endpoint: `${cfg.hostIp}:${port}`,
          published: `${cfg.hostIp}:${port} -> ${names.container}:${cfg.containerApiPort}`,
          image: {
            tag: image.tag,
            imageId: image.imageId,
            sizeBytes: image.sizeBytes,
            repoDigests: image.repoDigests,
            note: image.note,
          },
          containerIps: dockerIps,
          timings: {
            upWallSeconds: +secs(Date.now() - t0),
            startToEosCliSeconds: +secs(cli.elapsedMs),
            eosCliAttempts: cli.attempt,
            cliNotReadyObservations: cli.observations,
            bootstrapSeconds: +secs(bootstrapMs),
          },
          eosVersionFromCli: identityFromShowVersion(versionJson),
          eosInterfacesObserved: Object.keys(interfacesJson?.interfaceStatuses ?? interfacesJson?.interfaces ?? {}),
          httpCommandsAfterBootstrap: httpCommandsJson,
          credentialsPrintedOnce: { user: creds.user, secret: creds.secret },
          stateFile: path.relative(REPO_ROOT, sp),
          notYetReady: 'eAPI on the published port has not been probed yet — run `npm run lab:probe`',
          next: `npm run lab:probe -- --run ${runId}`,
        },
        null,
        2,
      )}\n`,
    )
    return { exitCode: EXIT.ok, runId, port }
  } catch (err) {
    reportError(err, 'up')
    const td = teardownRun(runId)
    if (!td.ok) log(`[up] cleanup after the failure also reported: ${td.problems.join('; ')}`)
    releaseLocksForRun(runId)
    return { exitCode: err instanceof LabError ? err.code : EXIT.internal, runId }
  }
}

/**
 * Bootstrap eAPI on the disposable node: a lab-only user plus the HTTPS API. Kept
 * deliberately small, and never persisted — `copy running-config startup-config` is
 * not issued (docs/CEOS.md: bootstrap afresh after recreating the lab).
 * @param {string} container @param {{user: string, secret: string}} creds
 */
function bootstrapLab(container, creds) {
  const out = cliScript(container, [
    'configure terminal',
    `username ${creds.user} privilege 15 role network-admin secret ${creds.secret}`,
    'management api http-commands',
    '   protocol https',
    '   no shutdown',
    'end',
    'show management api http-commands',
  ])
  // The container echoes the transcript back; drop the credential line before the
  // transcript is stored in the state file.
  return out
    .split('\n')
    .filter((line) => !/username\s+\S+\s+privilege/i.test(line))
    .join('\n')
    .slice(0, 3000)
}

/* ------------------------------------------------------------- probe command */

/** @param {ReturnType<typeof labConfig>} cfg @param {NonNullable<ReturnType<typeof readState>>} state */
async function cmdProbe(cfg, state) {
  const t0 = Date.now()
  const anchor = readContainerPublicCert(state.container)
  if (!anchor.pem) {
    refuse(
      `no public certificate anchor was readable inside the container (tried: ${anchor.tried
        .map((t) => `${t.path} — ${t.reason}`)
        .join('; ')}). Without the container-side certificate there is no trust anchor, and this harness ` +
        'will not fall back to an unverified peer.',
      EXIT.readiness,
    )
  }
  const served = await peekServedCert({ host: cfg.hostIp, port: state.port })
  log(
    `[probe] published port ${cfg.hostIp}:${state.port} serves fingerprint=${served.fingerprint256 ?? served.error} subject=${served.subject ?? '-'}`,
  )
  log(`[probe] container file ${anchor.path} fingerprint=${anchor.fingerprint256} subject=${JSON.stringify(anchor.subject)}`)
  // Hand the *public* certificate to child processes through a 0600 git-ignored file so
  // they can pin the same anchor with real chain verification, instead of being handed
  // the fingerprint and a "verify nothing" escape hatch.
  ensureStateDir()
  const certFile = certFilePath(state.runId)
  fs.writeFileSync(certFile, `${anchor.pem}\n`, { mode: 0o600 })
  fs.chmodSync(certFile, 0o600)

  const pin = { host: cfg.hostIp, port: state.port, user: state.user, secret: state.secret, anchor }
  let attempt = 0
  let lastReason = 'not attempted'
  /** @type {{attempt: number, elapsedSeconds: number, ok: boolean, reason: string}[]} */
  const attempts = []
  while (Date.now() - t0 < cfg.probeTimeoutSec * 1000) {
    attempt += 1
    try {
      const reply = await eapiRunCmds(pin, {
        cmds: ['show version'],
        format: 'json',
        id: 'ceos-lab-ready',
        timeoutMs: cfg.requestTimeoutMs,
      })
      const version = reply.result[0]
      const identity = identityFromShowVersion(version)
      if (!identity.versionVerbatim || !identity.modelName) {
        lastReason = `reply had no version/modelName (keys: ${Object.keys(version ?? {}).slice(0, 8).join(',')})`
        attempts.push({ attempt, elapsedSeconds: +secs(Date.now() - t0), ok: false, reason: lastReason })
        log(`[probe] attempt ${attempt} (${secs(Date.now() - t0)}s): ${lastReason}`)
        await sleep(cfg.retryDelayMs)
        continue
      }
      const baseOk =
        identity.baseFromVersion === cfg.expectVersion ||
        identity.baseFromInternal === cfg.expectVersion ||
        identity.bareInternal === cfg.expectVersion
      if (!baseOk) {
        refuse(
          `the release reported by ${JSON.stringify(cfg.hostIp)}:${state.port} is base=` +
            `${JSON.stringify(identity.baseFromVersion ?? identity.baseFromInternal)} (full ` +
            `${JSON.stringify(identity.versionVerbatim)}), not the pinned ${JSON.stringify(cfg.expectVersion)} — ` +
            'unexpected image/target; no fixtures are recorded and no tests are run.',
          EXIT.readiness,
        )
      }
      if (typeof identity.modelName !== 'string' || !/^ceos/i.test(identity.modelName)) {
        refuse(
          `modelName ${JSON.stringify(identity.modelName)} is not a cEOS container model. This harness only accepts ` +
            'the disposable container it started; a hardware model here would mean the endpoint is not ours.',
          EXIT.unsafeTarget,
        )
      }
      log(`[probe] attempt ${attempt}: authenticated eAPI ready after ${secs(Date.now() - t0)}s`)

      const versionJsonCapture = { command: 'show version', format: 'json', ok: true, result: version }
      const extraCaptures = await captureFromEapi(cfg, pin)
      const interfacesJson = await captureJson(pin, 'show interfaces status')
      const httpCommandsJson = await captureJson(pin, 'show management api http-commands')
      const written = writeFixtures(cfg, state, {
        anchor,
        served,
        identity,
        versionJsonCapture,
        interfacesJson,
        httpCommandsJson,
        captures: extraCaptures,
      })
      const createToReadyMs = Date.now() - new Date(state.createdAt).getTime()
      writeState({ ...state, certFile, probedAt: nowIso(), probeElapsedMs: Date.now() - t0 })
      const out = {
        ok: true,
        runId: state.runId,
        endpoint: `${cfg.hostIp}:${state.port}`,
        readiness: {
          ready: true,
          attempts: attempt,
          probeElapsedSeconds: +secs(Date.now() - t0),
          createToReadySeconds: +secs(createToReadyMs),
          startToEosCliSeconds: +secs(state.cliReadyMs),
          eosCliAttempts: state.cliReadyAttempts,
          bootstrapSeconds: +secs(state.bootstrapMs),
          probeAttempts: attempts,
        },
        identity,
        versionReplyKeys: Object.keys(version).sort(),
        versionReply: version,
        modelNote:
          'modelName is what cEOS reports for itself. It is not, and must never be used as, DCS-7050TX-64 / ' +
          '4.28.13.1M hardware evidence (docs/CEOS.md, DR-043).',
        tls: {
          anchorSource: `docker exec cat ${anchor.path}`,
          anchorFingerprint256: anchor.fingerprint256,
          servedFingerprint256: served.fingerprint256 ?? null,
          pinMatchesServed: served.fingerprint256 === anchor.fingerprint256,
          anchorSubject: anchor.subject,
          anchorIssuer: anchor.issuer,
          anchorNotBefore: anchor.notBefore,
          anchorNotAfter: anchor.notAfter,
          anchorSerial: anchor.serial,
          anchorKeyType: anchor.keyType,
          anchorKeyBits: anchor.keyBits,
          anchorPublicCertFile: certFile,
          anchorFileAlsoHeldPrivateKey: anchor.fileAlsoHeldPrivateKey,
          certCandidateSearch: anchor.tried,
          peekError: served.error ?? null,
          verification:
            'chain verified against the container-side public certificate, then an exact fingerprint comparison; ' +
            'hostname/SAN checking is not available (the cert has no SAN, CN=self.signed); rejectUnauthorized was never disabled',
        },
        interfacesJson,
        httpCommandsJson,
        captures: extraCaptures,
        fixturesWritten: written,
      }
      process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
      return { exitCode: EXIT.ok, runId: state.runId, result: out }
    } catch (err) {
      if (err instanceof LabError) throw err
      lastReason = err?.message ?? String(err)
      attempts.push({ attempt, elapsedSeconds: +secs(Date.now() - t0), ok: false, reason: lastReason })
      log(`[probe] attempt ${attempt} (${secs(Date.now() - t0)}s): ${lastReason}`)
    }
    await sleep(cfg.retryDelayMs)
  }
  const logs = dockerOpt(['container', 'logs', '--tail', '20', state.container])
  const api = dockerOpt(['exec', '-i', state.container, 'Cli', '-p', '15'], {
    input: 'show management api http-commands\n',
  })
  log(
    `[probe] REFUSED: authenticated eAPI never succeeded on ${cfg.hostIp}:${state.port} within ${cfg.probeTimeoutSec}s ` +
      `(${attempt} attempts, last: ${lastReason})`,
  )
  log(`[probe] EOS-side API state:\n${api.stdout.trim().split('\n').slice(0, 12).join('\n')}`)
  log(`[probe] container log tail:\n${(logs.stdout + logs.stderr).trim().split('\n').slice(-8).join('\n')}`)
  return { exitCode: EXIT.readiness, runId: state.runId, reason: lastReason, attempts }
}

/** @param {Parameters<typeof eapiRunCmds>[0]} pin @param {string} cmd */
async function captureJson(pin, cmd) {
  try {
    const reply = await eapiRunCmds(pin, { cmds: [cmd], format: 'json', id: 'ceos-lab-capture', timeoutMs: 20_000 })
    return { command: cmd, format: 'json', ok: true, result: reply.result[0] }
  } catch (err) {
    return { command: cmd, format: 'json', ok: false, error: err?.message ?? String(err) }
  }
}

/**
 * Extra read-only captures, including deliberate capability probes whose failures are
 * reported verbatim as negative results (a cEOS-lab gap is evidence, not something to
 * hide).
 * @param {ReturnType<typeof labConfig>} cfg @param {Parameters<typeof eapiRunCmds>[0]} pin
 */
async function captureFromEapi(cfg, pin) {
  /** @type {{command: string, format: string, ok: boolean, result?: any, note?: string, error?: string}[]} */
  const out = []
  for (const cmd of [
    'show version',
    'show interfaces status',
    'show management api http-commands',
    'show ip interface brief',
    'show running-config',
  ]) {
    try {
      const reply = await eapiRunCmds(pin, { cmds: [cmd], format: 'text', id: 'ceos-lab-text', timeoutMs: 20_000 })
      out.push({ command: cmd, format: 'text', ok: true, result: reply.result[0] })
    } catch (err) {
      out.push({ command: cmd, format: 'text', ok: false, error: err?.message ?? String(err) })
    }
  }
  for (const cmd of [
    'show interfaces switching',
    'show platform overview',
    'show mlag',
    'show vlan',
    'show lldp neighbors',
    'show agents',
  ]) {
    try {
      const reply = await eapiRunCmds(pin, { cmds: [cmd], format: 'json', id: 'ceos-lab-capability', timeoutMs: 20_000 })
      out.push({ command: cmd, format: 'json', ok: true, result: reply.result[0], note: 'capability observation' })
    } catch (err) {
      out.push({
        command: cmd,
        format: 'json',
        ok: false,
        error: err?.message ?? String(err),
        note: 'capability observation — negative result recorded verbatim',
      })
    }
  }
  void cfg
  return out
}

/* ---------------------------------------------------------------- fixtures */

/**
 * Fixture scrubbing. Three layers, deliberately blunt so a reviewer can see what was
 * removed:
 *  1. credential-shaped text (`username … secret …`, `enable …`, `secret <value>`);
 *  2. this run's **random username**, as an object key and inside strings — observed
 *     2026-11-03: `show management api http-commands` reports per-user stats, so the
 *     lab user's name otherwise lands in every API fixture;
 *  3. any string that looks like a PEM private key (never expected, but a fixture
 *     carrying key material is a security incident, not a typo).
 * @param {unknown} value
 * @param {string[]} [labUsernames]
 */
function redactCopy(value, labUsernames = []) {
  const userPatterns = labUsernames.filter((u) => u && u.length >= 3).map((u) => new RegExp(escapeRegExp(u), 'g'))
  if (typeof value === 'string') {
    let out = value
      .replace(/(username\s+\S+\s+privilege\s+\d+\s+role\s+\S+\s+secret\s+)\S+/gi, '$1<redacted-lab-secret>')
      .replace(/(username\s+\S+\s+secret\s+)\S+/gi, '$1<redacted-lab-secret>')
      .replace(/((?:enable|login|passphrase)\s+)(?:\S+)/gi, '$1<redacted-lab-secret>')
    for (const p of userPatterns) out = out.replace(p, '<redacted-lab-user>')
    if (/-----BEGIN (RSA |EC )?(PRIVATE KEY|ENCRYPTED)/.test(out)) out = '<redacted-private-key-material>'
    return out
  }
  if (Array.isArray(value)) return value.map((v) => redactCopy(v, labUsernames))
  if (value && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      const key = userPatterns.length > 0 && labUsernames.includes(k) ? '<redacted-lab-user>' : k
      if (/^(secret|password|passphrase|token|authorization|sshPublic?Key|publicKey|privateKey)$/i.test(key)) {
        out[key] = '<redacted-lab-secret>'
        continue
      }
      out[key] = redactCopy(v, labUsernames)
    }
    return out
  }
  return value
}

/** @param {string} s */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Write the probe's real replies as committed, redacted fixtures. Refresh is explicit:
 * an existing file is never overwritten without `--fixtures-force` (docs/CEOS.md:
 * "Refresh is explicit and reviewed"; cEOS captures must also never land on hardware
 * fixture paths).
 * @param {ReturnType<typeof labConfig>} cfg
 * @param {NonNullable<ReturnType<typeof readState>>} state
 * @param {any} probe
 */
function writeFixtures(cfg, state, probe) {
  if (!cfg.fixtureDir) return []
  if (!/fixtures[\\/]live[\\/]ceos-/.test(cfg.fixtureDir)) {
    refuse(
      `refusing to write cEOS captures outside fixtures/live/ceos-<version>/ (${cfg.fixtureDir}) — hardware ` +
        'recordings must never be overwritten by container captures',
      EXIT.unsafeTarget,
    )
  }
  fs.mkdirSync(cfg.fixtureDir, { recursive: true })
  const specs = [
    probe.versionJsonCapture,
    probe.interfacesJson,
    probe.httpCommandsJson,
    ...probe.captures.filter((c) => c.ok),
  ]
  const written = []
  for (const spec of specs) {
    if (!spec || !spec.ok || spec.result === undefined) continue
    const isJson = spec.format === 'json'
    const file = isJson
      ? `${spec.command.replace(/\s+/g, '-').toLowerCase()}.json`
      : `${spec.command.replace(/\s+/g, '-').toLowerCase()}--text.json`
    const result = redactCopy(spec.result, [state.user])
    if (result && typeof result === 'object') {
      for (const key of ['systemMacAddress', 'hwMacAddress', 'configMacAddress']) {
        if (key in result) result[key] = '00:00:00:00:00:00'
      }
    }
    const envelope = {
      metadata: {
        targetClass: 'lab',
        targetKind: 'ceos-container',
        imageTag: state.imageTag,
        imageId: state.imageId,
        imageRepoDigests: state.repoDigests,
        aristaVersion: probe.identity.versionVerbatim,
        aristaVersionBase: probe.identity.baseFromVersion,
        internalVersion: probe.identity.internalVersionVerbatim,
        modelName: probe.identity.modelName,
        hardwareEvidence: 'none — cEOS-lab container capture; not DCS-7050TX-64 / 4.28.13.1M evidence (DR-043)',
        runId: state.runId,
        capturedAt: nowIso(),
        capturedBy: MANAGER,
        endpoint: `${state.hostIp}:${state.port}`,
        transport: 'https + HTTP basic auth to the run-owned published loopback port; container-side pinned certificate',
        tlsPinFingerprint256: probe.anchor.fingerprint256,
        bootupTimestamp: probe.identity.bootupTimestamp,
        redactionApplied: [
          'username/secret and enable/passphrase text replaced with <redacted-lab-secret>',
          `this run's random lab username replaced with <redacted-lab-user> (API user-stats otherwise leak it)`,
          'systemMacAddress / hwMacAddress / configMacAddress zeroed',
          'no key material: the container keeps the key in a sibling file (capikey.pem) that is never read',
          'serialNumber is the empty string on this cEOS-lab image and is kept verbatim',
        ],
      },
      command: spec.command,
      format: spec.format,
      result,
    }
    const p = path.join(cfg.fixtureDir, file)
    if (fs.existsSync(p) && !cfg.fixturesForce) {
      log(`[fixtures] refusing to overwrite ${path.relative(REPO_ROOT, p)} — review the diff, then re-run with --fixtures-force`)
      written.push({ file: path.relative(REPO_ROOT, p), status: 'kept (not overwritten)' })
      continue
    }
    fs.writeFileSync(p, `${JSON.stringify(envelope, null, 2)}\n`)
    written.push({ file: path.relative(REPO_ROOT, p), status: 'written', bytes: fs.statSync(p).size })
  }
  return written
}

/* --------------------------------------------------------- fixtures:refresh */

/**
 * `fixtures` — the named refresh entry PLAN §M12 asks for (`npm run fixtures:refresh`). The
 * capability already existed as `probe`'s guarded writes + `--fixtures-force` (§5 row 112); this
 * chains it into ONE run the process owns: `up` → `probe` (fixture writes are the whole point) →
 * `down`, with teardown on every path, including a probe that refuses.
 *
 * The consent gate is checked FIRST, before anything that could touch Docker: a refused refresh is
 * provably side-effect free (no `docker image inspect`, no container, no network, no eAPI request),
 * which is also what makes the refusal testable offline. `--yes` is required because a refresh
 * replaces committed, **reviewed** device captures — docs/CEOS.md: "Refresh is explicit and
 * reviewed". `--yes` implies `--fixtures-force` for this command only, and the path rule in
 * {@link writeFixtures} is deliberately NOT relaxed: writes outside `fixtures/live/ceos-<version>/`
 * still refuse with exit 3, so a container capture can never overwrite a hardware recording (DR-043).
 * @param {ReturnType<typeof labConfig>} cfg
 */
async function cmdFixtures(cfg) {
  if (cfg.fixtureDir === null) {
    refuse(
      '`fixtures` cannot be combined with --no-fixtures: writing the captures IS this command. Drop the flag ' +
        '(the default target is fixtures/live/ceos-<version>/)',
      EXIT.usage,
    )
  }
  const relDir = path.relative(REPO_ROOT, cfg.fixtureDir)
  const existing = fs.existsSync(cfg.fixtureDir) ? fs.readdirSync(cfg.fixtureDir).filter((f) => f.endsWith('.json')) : []
  const endpoint = cfg.port === null ? `an ephemeral ${cfg.hostIp}:<auto> port (locked per endpoint)` : `${cfg.hostIp}:${cfg.port}`
  if (!cfg.refreshConfirmed) {
    refuse(
      '`fixtures` replaces committed device captures, so it requires the explicit --yes confirmation flag. Nothing was ' +
        `started: no image was inspected, no container or network was created, no eAPI request was sent. With --yes this ` +
        `command would create one run-owned lab on ${endpoint}, replace ${String(existing.length)} existing capture file(s) ` +
        `under ${relDir} (overwrite stays confined to fixtures/live/ceos-<version>/), then tear that run down in all paths. ` +
        'Review the diff afterwards: refresh is explicit and reviewed, and a container capture is never 7050TX-64 evidence ' +
        '(docs/CEOS.md, DR-043). Re-run as: npm run fixtures:refresh -- --yes',
      EXIT.usage,
    )
  }
  log(
    `[fixtures] confirmed refresh · target ${relDir} (${String(existing.length)} existing capture(s)) · endpoint ${endpoint} ` +
      '· existing files will be replaced (implied --fixtures-force, confined to the ceos-<version> path guard)',
  )
  // Pre-generate the run id so the teardown below always names the run this call owns, even on a
  // path where `cmdUp` failed after creating resources (its own catch already tears down + releases).
  const runId = cfg.runId ?? newRunId()
  const owned = { ...cfg, runId, fixturesForce: true }
  const up = await cmdUp(owned)
  if (up.exitCode !== EXIT.ok) return { exitCode: up.exitCode, runId: up.runId, stage: 'up' }
  /** @type {{exitCode: number, runId?: string, stage?: string, result?: any, reason?: string}} */
  let outcome
  try {
    const state = readState(up.runId)
    if (!state) refuse(`state for run ${up.runId} vanished between up and probe`, EXIT.internal)
    outcome = await cmdProbe(owned, state)
    if (outcome.exitCode !== EXIT.ok) {
      log(
        `[fixtures] probe refused (exit ${String(outcome.exitCode)}${outcome.reason ? `: ${outcome.reason}` : ''}) — this path ` +
          'wrote no captures, and there is no fallback target to read them from',
      )
    }
  } catch (err) {
    // A version/model mismatch in `cmdProbe` throws rather than returning: the run still has to die.
    reportError(err, 'fixtures')
    outcome = { exitCode: err instanceof LabError ? err.code : EXIT.internal, runId: up.runId, stage: 'probe' }
  }
  const td = teardownRun(up.runId)
  if (!td.ok) {
    log(`[fixtures] teardown reported problems, so the refresh fails even if captures were written: ${td.problems.join('; ')}`)
    return { exitCode: EXIT.teardown, runId: up.runId, stage: 'teardown', teardown: td, probe: outcome }
  }
  log(
    `[fixtures] run ${up.runId} torn down cleanly · ${String(outcome.exitCode === EXIT.ok ? (outcome.result?.fixturesWritten?.length ?? 0) : 0)} ` +
      `capture file(s) processed under ${relDir}`,
  )
  return { ...outcome, runId: up.runId, teardown: { ok: td.ok, removed: td.removed } }
}

/* ------------------------------------------------------------------- down */

/** @param {unknown} labels @param {string} key */
function labelOf(labels, key) {
  if (typeof labels === 'string') {
    const m = new RegExp(`(?:^|,)\\s*${key}=([^,]*)`).exec(labels)
    return m ? m[1] : null
  }
  if (labels && typeof labels === 'object') {
    return String(/** @type {any} */ (labels)[key] ?? '') || null
  }
  return null
}

/**
 * Docker's `--format '{{json .}}'` emits **one JSON object per line** (JSONL), not a
 * JSON array, so `JSON.parse` of the whole buffer only works by accident when there
 * is exactly zero or one item. Parse per line.
 * @param {string} raw @param {string} what
 */
function parseJsonLines(raw, what) {
  const items = []
  for (const line of String(raw ?? '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      items.push(JSON.parse(trimmed))
    } catch (err) {
      refuse(
        `docker returned the ${what} listing in an unparseable form (${String(err?.message ?? err)}): ${trimmed.slice(0, 200)}`,
        EXIT.internal,
      )
    }
  }
  return items
}

/** Containers/networks labelled by this harness. Listed, never bulk-deleted. */
function listLabResources() {
  const containers = parseJsonLines(
    docker(['container', 'ls', '-a', '--filter', `label=${LABEL_RUN}`, '--format', '{{json .}}']),
    'container',
  ).map((c) => ({
    // `docker container ls --format '{{json .}}'` uses the key `ID` (observed
    // 2026-11-03) even though `docker container inspect` uses `Id`.
    id: String(c.ID ?? c.Id ?? ''),
    name: String(c.Names ?? ''),
    state: String(c.State ?? ''),
    status: String(c.Status ?? ''),
    run: labelOf(c.Labels, LABEL_RUN),
  }))
  const networks = parseJsonLines(
    docker(['network', 'ls', '--filter', `label=${LABEL_RUN}`, '--format', '{{json .}}']),
    'network',
  ).map((n) => ({ id: String(n.ID ?? ''), name: String(n.Name ?? ''), run: labelOf(n.Labels, LABEL_RUN) }))
  return { containers, networks }
}

/**
 * Remove exactly one run's container and networks. Ownership is proven by re-reading
 * the label; already-absent resources are fine (idempotent); nothing else is touched.
 * @param {string} runId
 */
function teardownRun(runId) {
  const removed = { containers: [], networks: [], stateFiles: [], locks: [] }
  /** @type {string[]} */
  const problems = []

  /** @param {string} name @param {string|undefined} id */
  const dropContainer = (name, id) => {
    const labels = dockerOpt(['container', 'inspect', '--format', '{{json .Config.Labels}}', name])
    if (labels.status !== 0) {
      if (/no such object|no such container|not found/i.test(labels.stderr)) {
        log(`[down] container ${name} already absent (idempotent)`)
        return
      }
      problems.push(`could not inspect container ${name}: ${(labels.stderr || '').trim().split('\n')[0]}`)
      return
    }
    const parsed = JSON.parse(labels.stdout || '{}')
    if (parsed?.[LABEL_RUN] !== runId) {
      problems.push(`refused to remove container ${name}: its label says run=${parsed?.[LABEL_RUN] ?? '<absent>'}, not ${runId}`)
      return
    }
    const logs = dockerOpt(['container', 'logs', '--tail', '15', name])
    const tailText = (logs.stdout + logs.stderr).trim().split('\n').slice(-5).join('\n')
    if (tailText) log(`[down] last container log lines for ${name}:\n${tailText}`)
    const rm = dockerOpt(['container', 'rm', '-f', id || name])
    if (rm.status !== 0) problems.push(`docker container rm -f ${name}: ${(rm.stderr || 'failed').trim().split('\n')[0]}`)
    else removed.containers.push(name)
  }

  /** @param {string} name */
  const dropNetwork = (name) => {
    const labels = dockerOpt(['network', 'inspect', '--format', '{{json .Labels}}', name])
    if (labels.status !== 0) {
      if (/no such network|not found|no such object/i.test(labels.stderr)) {
        log(`[down] network ${name} already absent (idempotent)`)
        return
      }
      problems.push(`could not inspect network ${name}: ${(labels.stderr || '').trim().split('\n')[0]}`)
      return
    }
    const parsed = JSON.parse(labels.stdout || '{}')
    if (parsed?.[LABEL_RUN] !== runId) {
      problems.push(`refused to remove network ${name}: its label says run=${parsed?.[LABEL_RUN] ?? '<absent>'}, not ${runId}`)
      return
    }
    const rm = dockerOpt(['network', 'rm', name])
    if (rm.status !== 0) problems.push(`docker network rm ${name}: ${(rm.stderr || 'failed').trim().split('\n')[0]}`)
    else removed.networks.push(name)
  }

  const state = readState(runId)
  dropContainer(containerName(runId), state?.containerId)
  dropNetwork(networkName(runId, 'mgmt'))
  dropNetwork(networkName(runId, 'data'))

  const sp = statePath(runId)
  if (fs.existsSync(sp)) {
    // The only file that holds the lab secret: deleted here, git-ignored always.
    fs.rmSync(sp, { force: true })
    removed.stateFiles.push(path.relative(REPO_ROOT, sp))
  }
  const cf = certFilePath(runId)
  if (fs.existsSync(cf)) {
    // Public certificate only, but it is run-owned scratch and dies with the run.
    fs.rmSync(cf, { force: true })
    removed.stateFiles.push(path.relative(REPO_ROOT, cf))
  }
  removed.locks = releaseLocksForRun(runId)

  const leftovers = listLabResources()
  if (leftovers.containers.length > 0 || leftovers.networks.length > 0) {
    log(
      '[down] leftover lab resources still present (listed, NOT removed — they may belong to another live run): ' +
        leftovers.containers
          .map((c) => `container ${c.name} [${c.state}]`)
          .concat(leftovers.networks.map((n) => `network ${n.name}`))
          .join(', '),
    )
  }
  if (problems.length > 0) log(`[down] problems: ${problems.join('; ')}`)
  return { ok: problems.length === 0, runId, removed, problems, leftovers }
}

/* -------------------------------------------------------------------- run */

/** @param {ReturnType<typeof labConfig>} cfg @param {string[]} childArgv */
async function cmdRun(cfg, childArgv) {
  if (childArgv.length === 0) {
    refuse('lab:run needs a child command: `npm run lab:run -- <command…>`', EXIT.usage)
  }
  const up = await cmdUp(cfg)
  if (up.exitCode !== EXIT.ok) return up
  const state = readState(up.runId)
  if (!state) refuse(`state for run ${up.runId} vanished between up and probe`, EXIT.internal)
  const probed = await cmdProbe(cfg, state)
  if (probed.exitCode !== EXIT.ok) {
    log(`[run] readiness probe failed — tearing down ${up.runId} without starting the child (there is no fallback target)`)
    const td = teardownRun(up.runId)
    return { exitCode: td.ok ? probed.exitCode : EXIT.teardown, runId: up.runId, teardown: td }
  }
  const ifaces = probed.result.interfacesJson?.result ?? {}
  const scratchInterfaces = Object.keys(ifaces?.interfaceStatuses ?? ifaces?.interfaces ?? {})
    .filter((name) => /^Ethernet\d+(-\d+)?$/.test(name))
    .join(',')
  const childEnv = {
    ...process.env,
    EAPI_LIVE: '1',
    EAPI_TARGET_CLASS: 'lab',
    EAPI_HOST: cfg.hostIp,
    EAPI_PORT: String(state.port),
    EAPI_USER: state.user,
    EAPI_PASS: state.secret,
    EAPI_ALLOW_MODEL: String(probed.result.identity.modelName ?? ''),
    EAPI_EXPECT_VERSION: cfg.expectVersion,
    EAPI_IMAGE_TAG: state.imageTag,
    EAPI_IMAGE_ID: state.imageId,
    EAPI_LAB_RUN: state.runId,
    EAPI_LAB_STATE: statePath(state.runId),
    EAPI_LAB_CERT: probed.result.tls.anchorPublicCertFile ?? '',
    EAPI_LAB_CERT_FINGERPRINT: probed.result.tls.anchorFingerprint256,
    EAPI_SCRATCH_INTERFACES: scratchInterfaces,
  }
  let childExit = null
  let childSignal = null
  let interrupted = null
  /** @type {Record<string, () => void>} */
  const handlers = {}
  try {
    await new Promise((resolve) => {
      const child = spawn(childArgv[0], childArgv.slice(1), { cwd: process.cwd(), env: childEnv, stdio: 'inherit' })
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        handlers[sig] = () => {
          interrupted = sig
          log(`[run] ${sig} received — forwarding to the child, then tearing the lab down in the finally path`)
          child.kill(sig)
        }
        process.on(sig, handlers[sig])
      }
      child.on('error', (err) => {
        log(`[run] child ${JSON.stringify(childArgv[0])} could not start: ${err.message}`)
        childExit = EXIT.internal
        resolve()
      })
      child.on('exit', (code, sig) => {
        childExit = code
        childSignal = sig
        resolve()
      })
    })
  } finally {
    for (const [sig, h] of Object.entries(handlers)) process.removeListener(sig, h)
    const outcome = interrupted ?? childSignal ?? (childExit === EXIT.ok ? 'exit 0' : `exit ${childExit}`)
    log(`[run] child finished (${outcome}) — tearing down run ${state.runId} in the finally path`)
  }
  const td = teardownRun(state.runId)
  if (!td.ok) return { exitCode: EXIT.teardown, runId: state.runId, teardown: td, childExit, childSignal }
  return { exitCode: childExit ?? EXIT.internal, runId: state.runId, teardown: { ok: td.ok, removed: td.removed }, childExit, childSignal }
}

/* ------------------------------------------------------------ arg parsing */

/** @param {string} name */
function isKnownBoolFlag(name) {
  return ['fixtures', 'no-fixtures', 'fixtures-force', 'yes', 'all', 'list', 'quiet', 'help', 'no-digest'].includes(name)
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {string[]} */
  const positional = []
  /** @type {Record<string, string | boolean>} */
  const flags = {}
  /** @type {string[]} */
  let passthrough = []
  let sawDoubleDash = false
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (!sawDoubleDash && a === '--') {
      sawDoubleDash = true
      passthrough = argv.slice(i + 1)
      break
    }
    if (!sawDoubleDash && a.startsWith('--')) {
      const body = a.slice(2)
      const eq = body.indexOf('=')
      if (eq >= 0) flags[body.slice(0, eq)] = body.slice(eq + 1)
      else if (!isKnownBoolFlag(body) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        flags[body] = argv[i + 1]
        i += 1
      } else flags[body] = true
    } else if (positional.length === 0) positional.push(a)
    else passthrough.push(a)
  }
  return { command: positional[0], flags, passthrough }
}

/** @param {Record<string, string | boolean>} flags */
function labConfig(flags) {
  /** @param {string} key @param {string} dflt */
  const str = (key, dflt) => (typeof flags[key] === 'string' ? /** @type {string} */ (flags[key]) : dflt)
  /** @param {string} key @param {number} dflt */
  const int = (key, dflt) => {
    if (flags[key] === undefined || flags[key] === true) return dflt
    const n = Number(flags[key])
    if (!Number.isInteger(n) || n <= 0) {
      refuse(`--${key} must be a positive integer, got ${JSON.stringify(flags[key])}`, EXIT.usage)
    }
    return n
  }
  const cfg = {
    image: {
      tag: str('image', IMAGE_PIN.tag),
      // `--no-digest` opts out of the image-identity pin (discouraged; the usage text
      // says so). A bare `--digest` with no value is an error, not an accidental opt-out.
      imageId:
        flags['no-digest'] === true
          ? ''
          : flags['digest'] === true
            ? refuse('--digest needs a sha256:<64hex> value; pass --no-digest to skip the pin', EXIT.usage)
            : typeof flags['digest'] === 'string'
              ? String(flags.digest)
              : IMAGE_PIN.imageId,
    },
    expectVersion: str('expect-version', DEFAULTS.expectVersion),
    expectVersionFull: str('expect-version-full', DEFAULTS.expectVersionFull),
    hostIp: str('host-ip', DEFAULTS.hostIp),
    containerApiPort: int('container-port', DEFAULTS.containerApiPort),
    cliTimeoutSec: int('cli-timeout', DEFAULTS.cliTimeoutSec),
    probeTimeoutSec: int('timeout', DEFAULTS.probeTimeoutSec),
    requestTimeoutMs: int('request-timeout', DEFAULTS.requestTimeoutMs),
    retryDelayMs: int('retry-delay', DEFAULTS.retryDelayMs),
    port: flags['port'] === undefined || flags['port'] === true ? null : Number(flags['port']),
    runId: typeof flags['run'] === 'string' ? flags['run'] : undefined,
    fixtureDir: flags['fixtures'] === false || flags['no-fixtures'] === true ? null : str('fixtures', FIXTURE_DIR),
    fixturesForce: flags['fixtures-force'] === true,
    // The explicit confirmation the `fixtures` command requires before it may replace reviewed
    // captures. Nothing else reads it: `up`/`probe`/`run` keep their existing semantics.
    refreshConfirmed: flags['yes'] === true,
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(cfg.image.tag)) {
    refuse(`--image is not a valid docker reference: ${cfg.image.tag}`, EXIT.usage)
  }
  if (!/^[\w.-]+$/.test(cfg.expectVersion)) refuse(`--expect-version looks malformed: ${cfg.expectVersion}`, EXIT.usage)
  if (!/^[0-9A-Za-z.:-]+$/.test(cfg.hostIp)) refuse(`--host-ip is not a usable address: ${cfg.hostIp}`, EXIT.usage)
  return cfg
}

function usage() {
  process.stdout.write(
    `ceos-lab — run-owned cEOS-lab harness for the live eAPI lane (M12, #14)

usage: node scripts/ceos-lab.mjs <command> [flags] [-- <child args>]

  up      create + start one disposable lab (labelled container, mgmt + data bridge,
          ephemeral published loopback port) and bootstrap eAPI. Prints the run-owned
          credentials exactly once. Waits for EOS's own CLI, not for Docker.
  probe   poll authenticated eAPI "show version" with a bounded deadline, assert the
          pinned release and the container model, then print identity, TLS pin,
          interface and capability observations (negative results included verbatim).
  down    remove one run's container + networks (label-verified, idempotent) plus its
          state and lock files. Other lab runs are listed, never removed.
  run     up + probe, exec the child with EAPI_LIVE / EAPI_HOST / EAPI_PORT / EAPI_USER
          / EAPI_PASS / EAPI_TARGET_CLASS=lab …, then down in a finally — also on
          SIGINT/SIGTERM or child failure.
  fixtures
          the refresh entry (npm run fixtures:refresh): up + probe with captures written to
          --fixtures (default the committed cEOS dir) + down, on a run this process owns.
          Refuses with exit 2 BEFORE any docker call unless --yes is present; --yes implies
          --fixtures-force inside the guarded ceos-<version> path only.
  list    list every container/network labelled ${LABEL_RUN} plus this harness's state files.

flags
  --image <tag>                default ${IMAGE_PIN.tag}
  --digest <sha256:64hex>      image-ID pin (default: the pinned ${IMAGE_PIN.imageId.slice(0, 22)}…)
  --no-digest                  skip the image-identity pin (discouraged: it is what detects a
                               different tar imported into the same tag)
  --expect-version <base>      exact release base, default ${DEFAULTS.expectVersion}
  --port <n>                   publish a specific loopback port (default: ephemeral)
  --host-ip <ip>               publish address, default ${DEFAULTS.hostIp}
  --container-port <n>         container eAPI port, default ${DEFAULTS.containerApiPort}
  --cli-timeout <sec>          bounded EOS-CLI wait inside the container, default ${DEFAULTS.cliTimeoutSec}
  --timeout <sec>              bounded eAPI readiness wait, default ${DEFAULTS.probeTimeoutSec}
  --request-timeout <ms>       per-request deadline, default ${DEFAULTS.requestTimeoutMs}
  --retry-delay <ms>           delay between attempts, default ${DEFAULTS.retryDelayMs}
  --run <id>                   act on an existing run id
  --fixtures <dir>             write probe captures to a fixture dir (default ${path.relative(REPO_ROOT, FIXTURE_DIR)})
  --no-fixtures                never write fixtures
  --fixtures-force             allow overwriting existing fixture files
  --yes                        required by the fixtures command: confirms replacing reviewed captures
  --all                        with down: tear down every labelled run
  --help                       this text
`,
  )
}

/** @param {unknown} err @param {string} where */
function reportError(err, where) {
  if (err instanceof LabError) log(`[${where}] refused (exit ${err.code}): ${err.message}`)
  else log(`[${where}] internal error: ${/** @type {Error} */ (err)?.stack ?? String(err)}`)
}

function latestRunId() {
  if (!fs.existsSync(STATE_DIR)) return undefined
  const entries = fs
    .readdirSync(STATE_DIR)
    .filter((f) => f.startsWith('session-') && f.endsWith('.json'))
    .map((f) => ({ name: f, mtime: fs.statSync(path.join(STATE_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  if (entries.length === 0) return undefined
  return entries[0].name.replace(/^session-/, '').replace(/\.json$/, '')
}

/** @param {string[]} argv */
async function main(argv) {
  const parsed = parseArgs(argv)
  if (!parsed.command || parsed.flags.help === true) {
    usage()
    return { exitCode: parsed.flags.help === true ? EXIT.ok : EXIT.usage }
  }
  const cfg = labConfig(parsed.flags)
  guardTargetClass()
  switch (parsed.command) {
    case 'up': {
      guardInheritedHost()
      return cmdUp(cfg)
    }
    case 'probe': {
      const runId = cfg.runId ?? latestRunId()
      if (!runId) refuse('no lab run to probe — run `npm run lab:up` first, or pass --run <id>', EXIT.usage)
      const state = readState(runId)
      if (!state) refuse(`nothing owned by this harness for run ${runId}`, EXIT.usage)
      return cmdProbe(cfg, state)
    }
    case 'down': {
      if (parsed.flags.all === true) {
        const runs = [...new Set(listLabResources().containers.map((c) => c.run).filter(Boolean))]
        const results = runs.map((id) => teardownRun(String(id)))
        const failed = results.filter((r) => !r.ok)
        process.stdout.write(`${JSON.stringify({ ok: failed.length === 0, runsRemoved: results.length, results }, null, 2)}\n`)
        return { exitCode: failed.length === 0 ? EXIT.ok : EXIT.teardown }
      }
      const runId = cfg.runId ?? latestRunId()
      if (!runId) {
        log('[down] nothing to do: this harness has no state file and no labelled lab resources exist')
        process.stdout.write(`${JSON.stringify({ ok: true, idempotent: true, runId: null, leftovers: listLabResources() }, null, 2)}\n`)
        return { exitCode: EXIT.ok }
      }
      const td = teardownRun(runId)
      process.stdout.write(`${JSON.stringify(td, null, 2)}\n`)
      return { exitCode: td.ok ? EXIT.ok : EXIT.teardown, runId }
    }
    case 'run': {
      guardInheritedHost()
      return cmdRun(cfg, parsed.passthrough)
    }
    case 'fixtures': {
      // No docker call happens before cmdFixtures' own --yes refusal, so the refusal path is
      // exercisable on any machine (docs/CEOS.md keeps the lab itself trusted-host only).
      guardInheritedHost()
      return cmdFixtures(cfg)
    }
    case 'list': {
      const resources = listLabResources()
      const stateFiles = fs.existsSync(STATE_DIR)
        ? fs.readdirSync(STATE_DIR, { withFileTypes: true }).map((e) => ({ name: e.name, mode: (e.mode & 0o777).toString(8) }))
        : []
      process.stdout.write(
        `${JSON.stringify(
          {
            labelKey: LABEL_RUN,
            manager: MANAGER,
            stateDir: path.relative(REPO_ROOT, STATE_DIR),
            resources,
            stateFiles,
            note: "0600 state files hold the current run's lab credentials and are git-ignored",
          },
          null,
          2,
        )}\n`,
      )
      return { exitCode: EXIT.ok }
    }
    default:
      refuse(`unknown command ${JSON.stringify(parsed.command)} — see --help`, EXIT.usage)
  }
}

const outcome = await main(process.argv.slice(2)).catch((err) => {
  reportError(err, 'ceos-lab')
  return { exitCode: err instanceof LabError ? err.code : EXIT.internal }
})
process.exitCode = outcome?.exitCode ?? EXIT.internal
