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
 *    bootstrap is fed to `Cli` on stdin) and never appear in an error message. `--quiet`
 *    suppresses the one-time print for CI-collected logs; the state file stays the only
 *    copy, so an artifact cannot become the second place a lab secret lives.
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
  frontPanelTimeoutSec: 60,
  certWaitSec: 120,
  requestTimeoutMs: 15_000,
  retryDelayMs: 5_000,
  /** fixtures-command capture transport: see `--capture-via` in the usage text. */
  captureVia: 'auto',
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

/**
 * Feed `Cli` WITHOUT throwing on a non-zero Cli exit. `Cli -p 15` exits 1 when any
 * line of the transcript errored (observed 2026-11-07: one `% Unavailable command`
 * in a 46-line staging script killed `docker exec` through {@link docker} at exit 8,
 * before any verdict could be read). For transcripts whose errors ARE the finding,
 * this returns the merged output instead of refusing.
 * @param {string} container @param {string[]} commands @param {number} [timeoutMs]
 */
function cliScriptOpt(container, commands, timeoutMs = 90_000) {
  const res = dockerOpt(['exec', '-i', container, 'Cli', '-p', '15'], {
    input: `${commands.join('\n')}\n`,
    timeoutMs,
  })
  return `${res.stdout ?? ''}${res.stderr ?? ''}`
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

/**
 * The DNS-shaped identity a live child should dial this run's certificate with.
 * The cEOS `capi.pem` subject is `CN=self.signed` with no SAN (observed on every
 * executed run — see the childEnv note in cmdRun), and Node's name check falls
 * back to the subject CN only when the authority is DNS-shaped, so `EAPI_SERVER_NAME`
 * has to carry that CN for the `checkServerIdentity` fallback to have a chance.
 * Returns undefined when the subject carries no usable CN rather than inventing one.
 * @param {unknown} subject @returns {string | undefined}
 */
function serverNameFromCertSubject(subject) {
  const m = /(?:^|[/,])\s*CN\s*=\s*([^/,]+)/i.exec(String(subject ?? ''))
  const cn = m ? m[1].trim() : ''
  return /^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(cn) ? cn : undefined
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
 * Bounded wait for the certificate anchor. Observed 2026-11-07 (lab-1850303-1de0e9):
 * `management api http-commands` answers the config with `HTTPS server: starting` and
 * `/persist/secure/capi.pem` does not exist until the CApi service has actually bound
 * the port — reading the anchor ONCE after bootstrap races service start, and the
 * single-shot read turned a slow start into exit 7 while earlier identical runs passed
 * (the file existed by the time those probes grabbed it). The candidates are re-swept
 * on a bounded loop; a refused run after the timeout is still a refusal, not a fallback.
 * @param {string} container @param {number} timeoutSec
 */
async function readContainerPublicCertWait(container, timeoutSec) {
  const t0 = Date.now()
  let last = readContainerPublicCert(container)
  while (!last.pem && Date.now() - t0 < timeoutSec * 1000) {
    await sleep(5000)
    last = readContainerPublicCert(container)
  }
  return { ...last, certWaitMs: Date.now() - t0, certWaitFullTimeout: !last.pem && timeoutSec > 0 }
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

/**
 * Candidate pinned static /24s for the run's mgmt bridge, in order of trying.
 * The mgmt network MUST carry a pinned static subnet because the run-owned
 * relay dials a deterministically-addressed endpoint (see the NIC-topology
 * note in `cmdUp` and DR-034's exact-endpoint rule). TWO bands: the
 * documented pools for Docker dynamic bridging: the fixed 192.168.255.0/24 band first (the
 * mirrored-mode networking (the default since WSL 2.6; the `iif ethN
 * ipproto … lookup local` rules are the fingerprint) Windows HNS owns pieces
 * of 172.16.0.0/12, and its route reconciliation can silently strip the
 * connected route a fresh 172.31.x bridge just installed (observed 2026-11-08:
 * the .159/.193 class failed while .70/.132/.189 behaved — actions run
 * 42525119847 died exactly that way). `cmdUp` creates each candidate and
 * VERIFIES the route before keeping it (verifyMgmtBridgeRoute), so a poisoned
 * subnet costs one rm + retry, not a 4-minute probe timeout. Existing
 * networks, host routes and interface addresses are filtered out up front,
 * and each band starts at a random octet so racing workers do not pick the
 * same first candidate. IPv6 ipam entries and link-local noise are ignored.
 * @returns {{ octetBase: string, cidr: string }[]}
 */
/**
 * Parse a `--band` / `CEOS_LAB_MGMT_BAND` pinspec: a comma-separated list of dotted prefixes,
 * 1–3 octets wide (`10.177` pins the whole band, `10.177.204` pins one /24). `auto` / empty =
 * unpinned (today's default order). A malformed prefix is a USAGE refusal — a typo must never
 * silently widen back to the poisoned default order. Exported via the read-only `mgmt-bands`
 * command so an operator can see what a pin selects BEFORE starting a run.
 * @param {string | undefined} raw
 * @returns {{ parts: string[] }[] | undefined}
 */
function parseMgmtBandPin(raw) {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed === 'auto') return undefined
  return trimmed.split(',').map((piece) => {
    const parts = piece.trim().split('.')
    if (parts.length < 1 || parts.length > 3 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) {
      refuse(`--band / CEOS_LAB_MGMT_BAND expects 1-3 dotted octets per pin (e.g. 10.177 or 10.177.204), got ${JSON.stringify(piece)}`, EXIT.usage)
    }
    return { parts }
  })
}

/** Does an octetBase like `10.177.204` fall under a parsed pin prefix? */
function mgmtBandMatches(pin, octetBase) {
  const octets = octetBase.split('.')
  return pin.parts.every((p, i) => octets[i] === p)
}

/**
 * @param {string | undefined} bandPinSpec see {@link parseMgmtBandPin}
 */
function mgmtSubnetCandidates(bandPinSpec) {
  const pins = parseMgmtBandPin(bandPinSpec)
  const ids = docker(['network', 'ls', '-q']).trim().split('\n').filter(Boolean)
  /** @type {{addr: number[], plen: number}[]} */
  const used = []
  const absorb = (cidr) => {
    const [addr, plen] = cidr.split('/')
    if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(addr)) return
    used.push({ addr: addr.split('.').map(Number), plen: Math.min(Math.max(Number(plen ?? 24), 0), 32) })
  }
  for (let i = 0; i < ids.length; i += 40) {
    const res = dockerOpt(['network', 'inspect', ...ids.slice(i, i + 40), '--format', '{{range .IPAM.Config}}{{.Subnet}} {{end}}'])
    if (res.status !== 0) continue
    for (const cidr of res.stdout.trim().split(/\s+/).filter(Boolean)) absorb(cidr)
  }
  // Avoid ZOMBIE kernel bridges, not just Docker-visible ones. Observed twice on 2026-11-08 after a
  // WSL2 restart: `ip route` still carried `172.31.107.0/24 dev br-84e385ae4402` (and the run-10
  // bridge's twin) for networks `docker network ls` no longer lists — dockerd recreated its state but
  // the kernel bridge device/route survived. The freshly-created mgmt bridge then lost the route
  // lookup to the dead device and every probe died with EHOSTUNREACH at the forwarder's upstream.
  // Reading the host's main-route table and interface addresses covers that class; absent tooling
  // (non-Linux dev machines) just means no extra candidates are filtered.
  for (const args of [['-o', '-4', 'route', 'show', 'table', 'main'], ['-o', '-4', 'addr', 'show']]) {
    let res
    try {
      res = run('ip', args, {})
    } catch {
      continue // no `ip` tooling (non-Linux dev box): the docker-side filter still applies
    }
    if (res.status !== 0) continue
    for (const line of res.stdout.split('\n')) {
      for (const cidr of line.match(/\b\d{1,3}(\.\d{1,3}){3}\/\d+\b/g) ?? []) absorb(cidr)
    }
  }
  /** @param {number[]} a @param {number} ap @param {number[]} b @param {number} bp */
  const overlaps = (a, ap, b, bp) => {
    const bits = Math.min(ap, bp)
    for (let bit = 0; bit < bits; bit += 8) {
      const width = Math.min(8, bits - bit)
      const mask = (0xff << (8 - width)) & 0xff
      const ia = bit / 8
      if ((a[ia] & mask) !== (b[ia] & mask)) return false
    }
    return true
  }
  const bands = [
    // Proven first: 192.168.255.0/24 is the band the local green runs (incl. the 249/249
    // executed corpus, 2026-11-08) always pinned, and a CI dispatch with the bridge route
    // VERIFIED LIVE on 172.31.77.0/24 still died with `Client network socket disconnected
    // before secure TLS` on all 29 attempts and CApi `Hits: 0` — under WSL2 mirrored mode a
    // route inside Windows' 172.16/12 ownership can look perfect in `ip route` and still
    // have its traffic eaten. A verified route is necessary, not sufficient; try the
    // never-poisoned band before the wide pools.
    { a: 192, b: 168, min: 255, max: 255 },
    { a: 172, b: 31, min: 16, max: 255 },
    { a: 10, b: 177, min: 16, max: 255 },
  ]
  /** @type {{ octetBase: string, cidr: string }[]} */
  let out = []
  for (const band of bands) {
    const span = band.max - band.min + 1
    const start = crypto.randomInt(0, span)
    for (let k = 0; k < span; k += 1) {
      const o = band.min + ((start + k) % span)
      const cand = [band.a, band.b, o, 0]
      if (!used.some((u) => overlaps(cand, 24, u.addr, u.plen))) {
        out.push({ octetBase: `${band.a}.${band.b}.${o}`, cidr: `${band.a}.${band.b}.${o}.0/24` })
      }
    }
  }
  // #142 band pin: on this operator's WSL2 mirrored-mode host BOTH default-first bands proved
  // intermittently poisoned (B5 lane, 2026-11-15: 192.168.255.*/172.31.* bridges verified their
  // ROUTE live and then failed ARP mid-run — exit 7, `mgmt-path-owned-by-host-nat`; the green run
  // only landed after decoy networks forced the clean 10.177.x band, outside every HNS range).
  // Route verification is necessary, not sufficient, so a dispatch that must not flake pins the
  // band it knows is uncontested instead of trusting the order.
  if (pins !== undefined) {
    const matchesBand = (pin, band) =>
      pin.parts[0] === String(band.a)
      && (pin.parts.length === 1
        || (pin.parts[1] === String(band.b)
          && (pin.parts.length === 2 || (Number(pin.parts[2]) >= band.min && Number(pin.parts[2]) <= band.max))))
    if (!pins.some((pin) => bands.some((band) => matchesBand(pin, band)))) {
      refuse(
        `--band / CEOS_LAB_MGMT_BAND pin ${JSON.stringify(bandPinSpec ?? '')} selects nothing: this harness only ever bridges ` +
        'inside 192.168.255.0/24, 172.31.16-255, or 10.177.16-255 (mgmtSubnetCandidates) — pin a prefix inside one of those.',
        EXIT.usage,
      )
    }
    out = out.filter((cand) => pins.some((pin) => mgmtBandMatches(pin, cand.octetBase)))
    if (out.length === 0) {
      refuse(
        `pinned mgmt band ${JSON.stringify(bandPinSpec ?? '')} currently has no free /24 — every candidate overlaps a ` +
        'live docker network, host route, or interface address. Remove stale lab networks for THIS pin ' +
        '(npm run lab:list shows the harness-owned ones) or re-dispatch without the pin.',
        EXIT.internal,
      )
    }
  }
  if (out.length === 0) {
    refuse(
      'no free /24 candidate in 192.168.255, 172.31.16-255 or 10.177.16-255 for the lab mgmt bridge — clean up stale '
      + 'Docker networks and old bridge routes before retrying (docs/CEOS.md §Host-route reconciliation)',
      EXIT.internal,
    )
  }
  return out
}

/**
 * Did a pinned mgmt bridge actually settle a usable host-side route? TWO
 * conditions must hold together: the kernel route dockerd should have installed
 * is live in the main table, AND a lookup of the mgmt address resolves via the
 * bridge device instead of falling through to the default gateway. Healthy
 * sample (`ip route show <cidr>` / `ip route get <ip>`):
 *   `10.177.204.0/24 dev br-e8e1… proto kernel scope link src 10.177.204.1 linkdown`
 *   `10.177.204.10 dev br-e8e1… src 10.177.204.1`
 * Poisoned on this host (mirror of actions run 42525119847):
 *   show = empty, and `ip route get 172.31.193.10` -> `via 192.168.1.1 dev eth3`
 * — the LAN gateway answers for the whole /24, so every relay attempt dies
 * `EHOSTUNREACH` while dockerd happily reports the network created.
 * @param {string} cidr @param {string} mgmtIp
 */
function verifyMgmtBridgeRoute(cidr, mgmtIp) {
  if (!cidr || !mgmtIp) return { ok: true, why: 'no pinned mgmt subnet in state — trusting dockerd' }
  let show, lookup
  try {
    show = run('ip', ['route', 'show', cidr], {})
    lookup = run('ip', ['route', 'get', mgmtIp], {})
  } catch {
    return { ok: true, why: 'ip tooling not available on this host — trusting dockerd' }
  }
  const showText = String(show.stdout ?? '').trim()
  const showLine = showText.split('\n')[0] ?? ''
  const lookupLine = String(lookup.stdout ?? '').trim().split('\n')[0] ?? ''
  if (show.status !== 0 || showText === '') {
    return { ok: false, why: `the host routing table keeps no connected route for ${cidr}` }
  }
  if (!/\bdev br-/.test(showLine)) {
    return { ok: false, why: `connected route names an unexpected device: ${showLine}` }
  }
  if (/(^|\s)via\s+\S/.test(lookupLine)) {
    return { ok: false, why: `lookups for the mgmt address leave via the default gateway (${lookupLine}) — WSL2/Windows route reconciliation or HNS owns this /24` }
  }
  if (!/\bdev br-/.test(lookupLine)) {
    return { ok: false, why: `route lookup does not resolve through a bridge device: ${lookupLine}` }
  }
  return { ok: true, why: `connected route live (${showLine})` }
}

/**
 * The hop-level facts a probe refusal needs when `verifyMgmtBridgeRoute` says LIVE yet a connect
 * to the mgmt IP answers `EHOSTUNREACH`. That combination means the routing table is not the
 * failing hop — the candidates are (a) the mgmt endpoint never landed on the bridge the route
 * names (the Docker-29/WSL2 multi-attach endpoint class that also ate the old `-p` publish),
 * (b) the bridge device is administratively/carrier down, or (c) the container's own interface
 * never took the address, so host-side ARP simply fails. Each has a distinct fingerprint:
 *
 * - `docker inspect .NetworkSettings.Networks` → which network(s) the container is on and with
 *   which IP/endpoint id; compare the mgmt endpoint id against the bridge the route names.
 * - `ip -s link show <bridge>` → `LOWER_GROUP`/carrier plus RX/TX counters — a bridge that
 *   transmitted 0 bytes while the relay pushed bytes has a veth problem, not a route problem.
 * - `ip neigh show <mgmtIp>` → `REACHABLE` (path fine, app layer), `FAILED`/absent (ARP never
 *   answered: L2 or addressing), `PERMANENT` (someone pre-seeded it).
 * - `bridge link show` filtered to that bridge → whether a veth is attached at all.
 *
 * Every fact is best-effort: absent tooling or a container that just went away contributes a
 * marker instead of failing the diagnosis.
 * @param {string} container @param {string} cidr @param {string} mgmtIp
 * @returns {string[]} one line per fact, already labelled
 */
function pathEvidence(container, cidr, mgmtIp) {
  const lines = []
  const netJson = dockerOpt(['inspect', '--format', '{{json .NetworkSettings.Networks}}', container])
  if (netJson.status === 0) {
    try {
      /** @type {Record<string, {IPAddress?: string, NetworkID?: string}>} */
      const nets = JSON.parse(String(netJson.stdout))
      lines.push(`container networks: ${Object.entries(nets).map(([name, ep]) => `${name}=${String(ep.IPAddress ?? '?')}/${String(ep.NetworkID ?? '?').slice(0, 12)}`).join(' ') || '(none)'}`)
    } catch {
      lines.push('container networks: unparseable inspect output')
    }
  } else {
    lines.push(`container networks: inspect failed (${String(netJson.stderr ?? '').trim().split('\n')[0]})`)
  }
  const show = run('ip', ['route', 'show', cidr], {})
  const bridgeDev = (String(show.stdout ?? '').match(/\bdev\s+(br-\S+)/) ?? [])[1]
  if (bridgeDev === undefined) {
    lines.push(`bridge device: none named by \`ip route show ${cidr}\``)
    return lines
  }
  const link = run('ip', ['-s', 'link', 'show', bridgeDev], {})
  const linkText = String(link.stdout ?? '').replace(/\s+/g, ' ').trim()
  lines.push(`bridge ${bridgeDev}: ${link.status === 0 ? (linkText || '(empty)') : `ip link failed (${String(link.stderr ?? '').trim()})`}`)
  const neigh = run('ip', ['neigh', 'show', mgmtIp], {})
  lines.push(`arp for ${mgmtIp}: ${String(neigh.stdout ?? '').trim() || 'no neighbour entry (ARP never answered)'}`)
  const attached = run('bridge', ['link', 'show'], {})
  const veths = String(attached.stdout ?? '').split('\n').filter((line) => line.includes(`master ${bridgeDev}`))
  lines.push(`veths on ${bridgeDev}: ${veths.length === 0 ? (attached.status === 0 ? 'NONE attached' : '`bridge link` unavailable') : veths.map((line) => line.trim().split(':')[1]?.trim() ?? line.trim()).join(' ')}`)
  const inside = dockerOpt(['exec', container, 'cat', '/proc/net/route'])
  if (inside.status === 0) {
    lines.push(`container routes: ${String(inside.stdout).trim().split('\n').slice(1, 4).map((r) => r.split('\t')[1] + '→' + r.split('\t')[2]).join(' ') || '(only default)'}`)
  }
  const addrInside = dockerOpt(['exec', container, 'cat', '/proc/net/dev'])
  if (addrInside.status === 0) {
    lines.push(`container ifaces: ${String(addrInside.stdout).split('\n').slice(2).map((l) => l.split(':')[0].trim()).join(' ')}`)
  }
  return lines
}

/**
 * Poll the interface model until front-panel Ethernet ports exist. NICs bind at cEOS
 * boot, so this typically returns on the first pass; running out means the data
 * bridges did not produce ports, and staging would happily create orphan stanzas
 * (accepted as config, answered as `% Interface does not exist`) — which is exactly
 * the empty-capture rot #62 is here to fix.
 * @param {string} container @param {number} timeoutSec
 * @returns {Promise<string[]>} Ethernet names sorted by index
 */
async function waitForFrontPanelPorts(container, timeoutSec) {
  const t0 = Date.now()
  /** @type {string[]} */
  let names = []
  while (Date.now() - t0 < timeoutSec * 1000) {
    try {
      const model = cliJson(container, 'show interfaces status')
      names = Object.keys(model?.interfaceStatuses ?? {})
        .filter((n) => /^Ethernet\d+$/.test(n))
        .sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)))
      if (names.length > 0) return names
    } catch {
      // Cli can answer-but-not-ready here; the bounded loop is the diagnosis path.
    }
    await sleep(3000)
  }
  return names
}

async function cmdUp(cfg) {
  const t0 = Date.now()
  const runId = cfg.runId ?? newRunId()
  const names = {
    runId,
    container: containerName(runId),
    mgmt: networkName(runId, 'mgmt'),
    data1: networkName(runId, 'data1'),
    data2: networkName(runId, 'data2'),
    peer: networkName(runId, 'peer'),
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
    log(`[up] run ${runId} · loopback endpoint ${cfg.hostIp}:${port} reserved for the container mgmt endpoint (forwarder starts after bootstrap)`)
    // NIC topology, re-settled on 2026-11-07 for issue #62, twice. (1) cEOS binds
    // kernel NICs to front-panel Ethernet ports ONLY at boot: a single-NIC node
    // presents ZERO Ethernet ports (`interface Ethernet1` then answers `% Interface
    // does not exist … until the module is inserted`), and hot-plugging a network into
    // a RUNNING node inserts nothing (probed). So the data bridges must be attached
    // BEFORE `docker start`. (2) Attaching mgmt+data1+data2 at CREATE — all three in
    // one `docker create` — re-broke the published-port path: two back-to-back fixture
    // runs probe-refused with ECONNRESET on port 443 while EOS-side `show management
    // api http-commands` reported `HTTPS server: running`, i.e. the port forward
    // resolved to an endpoint EOS had taken off the kernel (the 2026-11-04 no-tie-break
    // finding, reproduced). The vendor README's own recipe, and a controlled
    // before-start-connect test on this same daemon the same day, both keep exactly
    // ONE attachment at create (the pinned mgmt bridge — the shape every trusted M12
    // run used, including capture run lab-1792145-121e25) and `docker network
    // connect` the data bridges AFTER create but BEFORE start. A full run of the #62
    // staging inside such a node changed nothing about the published TLS path
    // (10/10 fingerprint probes after the commit), so provisioning is proven innocent:
    // the flapping half was create-time multi-attach. The mgmt-side safeguards
    // (loopback publish, per-endpoint locks, model/version pins) are unchanged; the
    // two data bridges carry no published port — they exist to boot front-panel ports.
    // Create-and-verify loop: walk candidates until one settles a LIVE connected
    // route (verifyMgmtBridgeRoute — the WSL2 mirrored-mode/HNS class can strip
    // routes from fresh bridges, actions run 42525119847 evidence). The network
    // name is run-scoped and constant, so a failed candidate is removed before the
    // next create. Bounded at 40 tries: a fully-poisoned host fails in seconds with
    // the reason list, not in the probe window.
    /** @type {{ octetBase: string, cidr: string } | undefined} */
    let mgmtSubnet = undefined
    /** @type {string[]} */
    const mgmtTries = []
    for (const [i, cand] of mgmtSubnetCandidates(cfg.mgmtBand).entries()) {
      if (i >= 40) break
      const res = dockerOpt([
        'network', 'create',
        `--label=${LABEL_RUN}=${runId}`, `--label=${LABEL_MANAGER}=${MANAGER}`,
        `--subnet=${cand.cidr}`, names.mgmt,
      ])
      if (res.status !== 0) {
        dockerOpt(['network', 'rm', names.mgmt])
        mgmtTries.push(`${cand.cidr}: create refused (${(res.stderr || 'docker error').trim().split('\n')[0]})`)
        continue
      }
      const verdict = verifyMgmtBridgeRoute(cand.cidr, `${cand.octetBase}.10`)
      if (verdict.ok) {
        mgmtSubnet = cand
        mgmtTries.push(`${cand.cidr}: ${verdict.why}`)
        break
      }
      dockerOpt(['network', 'rm', names.mgmt])
      mgmtTries.push(`${cand.cidr}: ${verdict.why}`)
    }
    if (mgmtSubnet === undefined) {
      refuse(
        'no lab mgmt subnet settled a live connected route. Tried: '
        + `${mgmtTries.slice(0, 6).join(' · ')}${mgmtTries.length > 6 ? ` … (${String(mgmtTries.length)} candidates)` : ''}. `
        + 'This host silently drops or refuses kernel routes for Docker bridges: under WSL2 '
        + 'mirrored-mode networking (the default since WSL 2.6) Windows HNS owns pieces of '
        + '172.16.0.0/12 and its route reconciliation can void a fresh bridge or leave stale '
        + '`br-` devices behind. Fix the host (`[wsl2] networkingMode=NAT` in the Windows-side '
        + '.wslconfig, then `wsl --shutdown` — docs/CEOS.md '
        + '§Host-route reconciliation) or point the eos-lab runner at a native Linux host. No '
        + 'container is started and no eAPI call is made while the route path is unproven.',
        EXIT.readiness,
      )
    }
    const mgmtIp = `${mgmtSubnet.octetBase}.10`
    // #154 --nodes=2: the peer bridge joins the family of run-owned bridges created here;
    // it carries the back-to-back wire between the two nodes' front panels. #87 --vrrp
    // REUSES this same wire as the shared-L2 VRRP segment (no extra NIC: the 2026-11-22
    // debugging run proved a 5-NIC shape lets cEOS bind NICs out of attach order and
    // consume a data bridge as its internal NIC — the 4-NIC topology is the proven one).
    const extraNets = cfg.nodes === 2 ? [names.peer] : []
    for (const net of [names.data1, names.data2, ...extraNets]) {
      docker(['network', 'create', `--label=${LABEL_RUN}=${runId}`, `--label=${LABEL_MANAGER}=${MANAGER}`, net])
    }
    log(
      `[up] mgmt pinned to ${mgmtSubnet.cidr} with a verified connected route (container ${mgmtIp}); ` +
        `data nets carry the front-panel NICs; mgmt settle: ${mgmtTries[mgmtTries.length - 1] ?? ''}`,
    )
    const createArgs = [
      'create',
      `--name=${names.container}`,
      '--privileged',
      `--label=${LABEL_RUN}=${runId}`,
      `--label=${LABEL_MANAGER}=${MANAGER}`,
      // the ONLY create-time attachment, with the pinned address, so any port
      // forward resolves to the single endpoint mgmt endpoint — see the topology
      // note above. No `-p=` here: on Docker 29.9.2 / WSL2 kernel 6.18+. the
      // publish resolved to the run's *data1* bridge endpoint even in this
      // single-attach shape (observed 2026-08: `docker-proxy … -container-ip
      // 172.19.0.2` for a mgmt-pinned create; every handshake RST'd while EOS
      // reported `Hits: 0, Bytes in: 0`, while a host-direct connect to the mgmt
      // bridge IP answered perfectly). Docker's CLI has no way to qualify `-p`
      // with the container-side endpoint, so `up` runs the loopback endpoint
      // itself via scripts/eapi-port-forward.mjs after bootstrap.
      //
      // The `ifname=eth0` driver-opt pins the mgmt endpoint to kernel eth0. cEOS
      // maps EOS `Management1` to kernel eth0 and `EthernetN` to kernel ethN, and
      // Docker's kernel-index assignment is NOT reliably attach-order (two
      // 2026-11-22 runs bound mgmt as a front-panel Ethernet and consumed a data
      // bridge as Management1, so eAPI answered on no IP and the OSPF/VRRP wires
      // landed on the wrong ports). Pinning eth0 here — and eth1/eth2/eth3 on the
      // data/peer connects below — makes the positional frontPanels[0..2] mapping
      // the provisioning code relies on correct by construction.
      `--network=${`name=${names.mgmt},ip=${mgmtIp},driver-opt=com.docker.network.endpoint.ifname=eth0`}`,
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
    // Data bridges join AFTER create and BEFORE start: NICs exist at boot so cEOS
    // binds them as front-panel ports, while create-time attachment stays a single
    // endpoint for the port-forward resolution (topology note above). The peer bridge
    // (nodes=2) rides the same pre-start attach — a runtime connect inserts nothing.
    // Each connect pins the container-side ifname (eth1=data1, eth2=data2, eth3=peer)
    // so cEOS binds them as Ethernet1/2/3 in that fixed order — the positional
    // frontPanels[0..2] the provisioning relies on (see the createArgs note).
    for (const [net, ifname] of [[names.data1, 'eth1'], [names.data2, 'eth2'], ...extraNets.map((n, i) => [n, `eth${String(i + 3)}`])]) {
      docker(['network', 'connect', '--driver-opt', `com.docker.network.endpoint.ifname=${ifname}`, net, names.container])
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

    // The front-panel model must be populated BEFORE provisioning references the ports
    // (a staging line aimed at a noninserted module is accepted as orphan config and
    // poisons every interface capture). NICs bind at boot, so by the time Cli answers
    // this is usually already true; the bounded poll is for slow hosts, not optimism.
    const frontPanels = await waitForFrontPanelPorts(names.container, cfg.frontPanelTimeoutSec)
    if (frontPanels.length < 2) {
      refuse(
        `cEOS presented only ${String(frontPanels.length)} front-panel Ethernet port(s) ` +
          `(${frontPanels.join(',') || 'none'}) within ${String(cfg.frontPanelTimeoutSec)}s — the run's two data ` +
          'networks did not bind at boot; provisioning would stage orphan stanzas and the #62 captures would be empty.',
        EXIT.readiness,
      )
    }
    // #154 nodes=2: attach order (data1, data2, peer) maps to the Ethernet numbers cEOS
    // assigns at boot; the peer NIC must be the THIRD front panel or provisioning would
    // put the transit address on a port the representative config also owns. Refusing on
    // a mismatch beats capturing an adjacency that never forms for a naming reason. This
    // 4-NIC topology is the proven one (#154's green OSPF runs); #87 --vrrp REUSES the
    // peer NIC as the shared-L2 segment precisely to stay inside it — the 2026-11-22
    // debugging run showed a 5th NIC lets cEOS bind mgmt as a front panel and consume a
    // data bridge internally, which is exactly the silent mis-provisioning to avoid.
    if (cfg.nodes === 2 && (frontPanels.length !== 3 || frontPanels[2] === undefined)) {
      refuse(
        `--nodes=2 expects exactly 3 front-panel ports on the primary (data1+data2+peer), got ` +
          `${JSON.stringify(frontPanels)} — the peer bridge did not bind at boot, or the NIC→Ethernet ` +
          'mapping changed; refusing rather than stage the transit/VRRP onto the wrong port.',
        EXIT.readiness,
      )
    }

    // #154: routing features are license-gated on EOS and the cEOS-lab license daemon can
    // lag Cli readiness by many seconds (observed 2026-11-18: consecutive runs on the same
    // image — two committed the full routing block, one refused `router ospf 1` with
    // "% Unavailable command (not supported on this hardware platform)" at the same ~36 s
    // boot; `ip routing`'s documented shape-dependence is this same race). Stage-abort a
    // canary until the platform answers for routing, so provisioning either runs against a
    // ready feature set or refuses HERE with the canary's verdict instead of dying later
    // behind a mode-cascade wall of misleading per-line errors.
    const features = await waitForRoutingFeatures(names.container)
    if (!features.ready) {
      refuse(
        `lab provisioning aborted before staging: the abort-only routing canary (\`router ospf 1\` in session ` +
          `${FEATURE_CANARY_SESSION}) answered "not supported on this hardware platform" on all ${String(features.attemptsUsed)} attempt(s) — ` +
          'the license daemon never reported routing ready on this boot. This is a boot-time race, not a lab-shape verdict: ' +
          'teardown ran; recreate the run. Last canary transcript head: ' +
          features.last.split('\n').filter((l) => l.trim().startsWith('%')).slice(0, 2).join(' / '),
        EXIT.readiness,
      )
    }

    // Issue #62: the captures the UI screens need only answer in the configured shape,
    // so `up` now provisions that shape before anything is read. A refusal here lands in
    // the catch below: teardown runs, no probe is taken, no half-configured capture set exists.
    const provisionStart = Date.now()
    const provision = provisionLab(
      names.container,
      frontPanels[0],
      frontPanels[1],
      cfg.nodes === 2 ? { peerPort: frontPanels[2], vrrp: cfg.vrrp } : undefined,
    )
    const provisionMs = Date.now() - provisionStart
    if (!provision.ok) {
      const detail =
        provision.stage === 'verification'
          ? `show vlan after commit is missing VLAN(s) ${provision.missingVlans.join(', ')} — the commit transcript said more than the device did`
          : provision.stage === 'routing'
            ? `show ip route after commit is not a populated routing model (${provision.routingDown}) — this container shape refused ip routing, and the #154 routing captures require it live (see the tolerated-line verdict in the staging transcript)`
            : provision.fatal.map((e) => `${e.command} -> ${e.line}`).join('; ')
      refuse(
        `lab provisioning (issue #62, session ${PROVISION_SESSION}) failed during ${provision.stage}: ${detail}. ` +
          'The session was aborted (staging path) or the run is being destroyed (verification path), the running ' +
          'config was never persisted, and the harness refuses rather than capture a half-provisioned container.',
        EXIT.internal,
      )
    }

    const versionJson = cliJson(names.container, 'show version')
    const interfacesJson = cliJson(names.container, 'show interfaces status')
    const httpCommandsJson = cliJson(names.container, 'show management api http-commands')

    let forwarderPid = null
    const sp = statePath(runId)
    ensureStateDir()
    // Provisional state file BEFORE the forwarder starts: the forwarder's watchdog
    // self-extinguishes when its --state-file disappears, and the full state is only
    // written after the peer bring-up (~2 min on --nodes 2). Without this file the
    // primary's forwarder always dies mid-boot with "run state file removed"
    // (observed 2026-11-19, run lab-368804-9ba87d). The full writeState below
    // overwrites this one; teardown removes it, which is the signal the watchdog wants.
    writeState({
      runId,
      schema: 4,
      provisional: true,
      container: names.container,
      containerId: cid,
      hostIp: cfg.hostIp,
      port,
      containerApiPort: cfg.containerApiPort,
      mgmtSubnet: mgmtSubnet.cidr,
      mgmtContainerIp: mgmtIp,
    })
    {
      const fwd = startForwarder({
        hostIp: cfg.hostIp,
        port,
        mgmtIp,
        apiPort: cfg.containerApiPort,
        stateFile: sp,
      })
      forwarderPid = fwd.pid
      try {
        await fwd.ready
      } catch (err) {
        refuse(`loopback forwarder ${cfg.hostIp}:${port} -> ${mgmtIp}:${cfg.containerApiPort} never came up: ${String(err instanceof Error ? err.message : err)}`, EXIT.readiness)
      }
    }

    /**
     * #154 nodes=2: the peer comes up AFTER the primary is fully provisioned and its own
     * forwarder is listening — every failure path below still lands in cmdUp's catch, and
     * teardownRun drops the (label-verified) peer resources idempotently.
     * @type {Awaited<ReturnType<typeof bringUpPeerNode>> | null}
     */
    let nodesB = null
    if (cfg.nodes === 2) {
      log(`[up] --nodes=2: bringing up the peer node (wire bridge ${names.peer})…`)
      nodesB = await bringUpPeerNode(cfg, {
        image: { tag: image.tag, imageId: image.imageId },
        runId,
        aMgmtSubnet: mgmtSubnet.cidr,
        creds,
        stateFile: sp,
        aPeerPort: frontPanels[2],
      })
      log(`[up] peer ${nodesB.container} ready: interface-pair ${nodesB.aPeerInterface}<->${nodesB.peerInterface}, eAPI at ${cfg.hostIp}:${nodesB.port}`)
    }

    const state = {
      runId,
      schema: 4,
      container: names.container,
      containerId: cid,
      networks: { mgmt: names.mgmt, data1: names.data1, data2: names.data2 },
      mgmtSubnet: mgmtSubnet.cidr,
      mgmtContainerIp: mgmtIp,
      frontPanelPorts: frontPanels,
      hostIp: cfg.hostIp,
      port,
      forwarderPid,
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
      provisionMs,
      provisionSession: PROVISION_SESSION,
      provisionTolerated: provision.ok ? provision.tolerated : [],
      provisionTranscript: redactCopy(`${provision.staged}\n--commit--\n${provision.committed ?? ''}`.slice(0, 6000)),
      pendingSession: PENDING_SESSION,
      dockerIps,
      ...(cfg.vrrp ? { vrrp: true } : {}),
      versionJson,
      interfacesJson,
      httpCommandsJson,
      ...(nodesB === null ? {} : { nodesB }),
    }
    writeState(state)
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          runId,
          nodes: cfg.nodes,
          container: names.container,
          containerId: cid,
          networks: names,
          endpoint: `${cfg.hostIp}:${port}`,
          published: `${cfg.hostIp}:${port} -> ${mgmtIp}:${cfg.containerApiPort} (forwarder pid ${forwarderPid})`,
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
            provisioningSeconds: +secs(provisionMs),
          },
          provisioning: {
            session: PROVISION_SESSION,
            applied: true,
            pendingSessionLeftOpen: PENDING_SESSION,
            toleratedRefusals: provision.ok ? provision.tolerated.map((e) => `${e.command} -> ${e.line}`) : [],
            note: 'representative config per issue #62; container-side only, never persisted, discarded with the container',
          },
          eosVersionFromCli: identityFromShowVersion(versionJson),
          eosInterfacesObserved: Object.keys(interfacesJson?.interfaceStatuses ?? interfacesJson?.interfaces ?? {}),
          httpCommandsAfterBootstrap: httpCommandsJson,
          ...(nodesB === null ? {} : {
            peerNode: {
              container: nodesB.container,
              endpoint: `${cfg.hostIp}:${nodesB.port} -> ${nodesB.mgmtContainerIp}:${cfg.containerApiPort} (forwarder pid ${nodesB.forwarderPid})`,
              wireInterfacePair: { a: nodesB.aPeerInterface, b: nodesB.peerInterface },
              peerLink: PEER_LINK,
              note: 'OSPF runs on both nodes; adjacency formation and blast behavior are asserted by the two-node live suite, never assumed here',
            },
          }),
          credentialsPrintedOnce: cfg.quiet
            ? {
                user: creds.user,
                secret: '<withheld: --quiet; the run\'s 0600 state file is the only copy, and teardown deletes it>',
              }
            : { user: creds.user, secret: creds.secret },
          stateFile: path.relative(REPO_ROOT, sp),
          notYetReady: 'eAPI on the loopback endpoint has not been probed yet — run `npm run lab:probe`',
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

/* ------------------------------------------- lab provisioning (issue #62) */

/**
 * Representative config applied to the disposable node after eAPI bootstrap, so the
 * commands the UI screens read answer in the *configured* shape instead of the empty
 * models the 2026-11-06 run (`lab-811108-5dcd01`) recorded: `interfaceStatuses` was
 * empty, `show port-channel 1 all-ports` answered `{"portChannels":{}}`,
 * `show interfaces switchport` carried no groups, and whole command families had no
 * capture at all (issue #62's gap list).
 *
 * The apply runs in a **named config session**, staged in full and committed only if
 * the staging transcript carries no `%` error for a required command. The session
 * sandbox is what gives this all-or-nothing semantics: a failed apply `abort`s and
 * the running config stays exactly at bootstrap, so the harness never captures a
 * half-provisioned container and presents its mixed shapes as device behavior. On a
 * fatal staging error this refuses the run (exit 1); the caller's teardown still owns
 * the container.
 *
 * Deliberate non-goals, per #62's rules: the management path, `management api
 * http-commands`, usernames, and `copy running-config startup-config` are all untouched
 * (docs/CEOS.md: bootstrap afresh after recreating the lab), and the MLAG domain stays
 * OFF on a single node (#64/#84's foot-gun rule). This is run *setup*, not a test write,
 * so it sits outside DR-035's test write policy — but keeps its no-persistence half.
 *
 * Port budget: the front-panel Ethernet ports come from the run's two data-bridge
 * NICs (see the topology note in `cmdUp`); a boot without data networks presents
 * ZERO Ethernet ports and hot-plug after boot inserts nothing (both probed
 * 2026-11-07). Port names are therefore taken from the observed model — `ethA` is
 * the configured access port and `ethB` the LACP member whose Port-Channel carries
 * the trunk — never hard-coded. No interface on the management path is touched.
 */
const PROVISION_SESSION = 'lab-provision'
const PENDING_SESSION = 'lab-pending-capture'
const FEATURE_CANARY_SESSION = 'lab-feature-canary'
const PEER_SESSION = 'lab-peer-provision'
/**
 * #154 items 2+4 — the back-to-back transit link for `--nodes=2`. Fixed addresses on
 * purpose: the peer segment is harness-defined topology (not device-discovered), the
 * ranges collide with nothing the single-node provisioning uses (10.0.100/110, 10.20),
 * and the loopbacks give OSPF stable router-ids. `/30` keeps the wire point-to-point.
 * BGP is deliberately NOT specced between the pair: the BGP JSON read model is
 * unreachable on this image even when configured (2026-11-18 catalog finding), so a
 * BGP adjacency here would form something no reader can observe; OSPF answers for the
 * mechanics evidence instead.
 */
const PEER_LINK = /** @type {const} */ {
  subnet: '10.155.0.0/30',
  aIp: '10.155.0.1',
  bIp: '10.155.0.2',
  aLoopback: '10.156.0.1',
  bLoopback: '10.156.0.2',
  ospfArea: '0',
}

/**
 * #87 `--vrrp` — the VRRP pair that lives on the REUSED nodes=2 peer wire. The wire
 * itself is PEER_LINK's bridge; `--vrrp` simply provisions both peer NICs as Vlan200
 * access ports instead of the routed /30, so VRRP gets its broadcast/multicast L2
 * domain (224.0.0.18) with a real SVI on each node. Fixed addresses again
 * (harness-defined topology): Vlan200 is outside the single-node 10/100/110 set and
 * outside the >=2000 per-case block the SVI suites use, and the .254 VIP sits above both
 * nodes' SVI addresses (.1 / .2) so neither owns it. A is the intended MASTER (higher
 * priority); B is the BACKUP whose promotion the failover lane measures.
 */
const VRRP_LINK = /** @type {const} */ {
  vlan: 200,
  name: 'LAB-VRRP',
  subnet: '10.0.200.0/24',
  aIp: '10.0.200.1',
  bIp: '10.0.200.2',
  vip: '10.0.200.254',
  vrid: 1,
  aPriority: 150,
  bPriority: 100,
}

/**
 * The staging lines, in apply order, aimed at the OBSERVED front-panel ports.
 * Indentation mirrors the CLI's sub-mode style used by `bootstrapLab`, so the
 * transcript is readable to a reviewer.
 * @param {string} ethA @param {string} ethB @param {{ peerPort?: string, vrrp?: boolean } | undefined} peer
 */
function provisionStaging(ethA, ethB, peer) {
  return [
  // VLAN names belong in vlan sub-mode (probed 2026-11-07: `name …` under
  // `interface Vlan…` answers `% Invalid input`); the SVI stanza carries addressing only.
  'vlan 10',
  '   name LAB-NATIVE',
  'exit',
  'vlan 100',
  '   name LAB-ACCESS',
  'exit',
  'vlan 110',
  '   name LAB-SPARE',
  'exit',
  'interface Vlan100',
  '   ip address 10.0.100.1/24',
  '   no shutdown',
  '   vrrp 1 ip 10.0.100.254',
  '   ip access-group EXT-ACL-1 in',
  'exit',
  'interface Vlan110',
  '   ip address 10.0.110.1/24',
  '   no shutdown',
  'exit',
  // Bare global `spanning-tree` answered `% Incomplete command` on this image (probed
  // 2026-11-07); the mode knob already ships, so the touched default is MST priority 0.
  'spanning-tree mst 0 priority 4096',
  // Configured access port: switchport-model content + per-port STP guards. The ACL
  // attachment lives on the routed SVI (and is itself a tolerated probe — cEOS-lab 4.28.14M
  // refused it there on 2026-11-07; the hardware attachment stays #14 §3).
  `interface ${ethA}`,
  '   switchport',
  '   switchport mode access',
  '   switchport access vlan 100',
  '   spanning-tree portfast edge',
  '   spanning-tree bpduguard enable',
  '   no shutdown',
  'exit',
  // LACP: with two ports only, the member is ethB and Po1 is the trunk.
  `interface ${ethB}`,
  '   no shutdown',
  '   channel-group 1 mode active',
  'exit',
  'interface Port-Channel1',
  '   description LAB-LACP',
  '   switchport mode trunk',
  '   switchport trunk native vlan 10',
  '   switchport trunk allowed vlan 100-110',
  '   switchport trunk group LABGRP',
  'exit',
  // Routing: #154 items 1/3 promote this from "a static route so the table answers" to the
  // configured ROUTING shape — the field sets #87's read-only tabs bind on (OSPF process,
  // BGP neighbor summary, route-map entries). Every spelling below staged FULL on this
  // container on 2026-11-18 (abort-only proof on run lab-1809618-4b3cc0, post-abort residue
  // zero); the device itself composed `area 0.0.0.0` and `max-lsa 12000`. A single node
  // cannot form adjacencies — populated neighbor tables are #154 item 2's two-node lane.
  // `ip routing` stays in the batch (and stays tolerated) so its boot-race-dependent verdict
  // is always recorded in the transcript; `provisionLab` below turns a refusal into a
  // loud run failure instead of a silently unconfigured capture set.
  'ip routing',
  'ip route 10.20.0.0/24 10.0.100.2',
  'router ospf 1',
  '   router-id 10.0.110.1',
  '   network 10.0.100.0/24 area 0',
  '   network 10.0.110.0/24 area 0',
  'exit',
  'router bgp 65001',
  '   router-id 10.0.110.1',
  '   neighbor 10.0.110.2 remote-as 65002',
  '   network 10.20.0.0/24',
  'exit',
  'ip prefix-list PL-LAB-STATIC seq 5 permit 10.20.0.0/24 le 32',
  'route-map RM-LAB-IMPORT permit 10',
  '   match ip address prefix-list PL-LAB-STATIC',
  'exit',
  'route-map RM-LAB-IMPORT deny 20',
  'exit',
  // NTP: an unreachable server is intended — S12 reads the *shape* (`associations` entries, unsynced status).
  'ntp server 10.20.0.2',
  // Standard + extended ACLs. Attachment may be refused on cEOS-lab (see the tolerated
  // set), but the rule entries themselves are what S13's viewer reads.
  'ip access-list standard STD-ACL-1',
  '   10 permit 10.0.0.0/8',
  'exit',
  'ip access-list extended EXT-ACL-1',
  '   10 permit tcp any host 10.0.100.1 eq 443',
  '   20 permit icmp any any',
  'exit',
  // #154 --nodes=2 only: the transit to the peer node + OSPF over it. Re-entering
  // `router ospf 1` is normal EOS — the block above already created the process.
  // #87 --vrrp flips the SAME wire from routed /30 to a shared-L2 segment: the peer NIC
  // becomes a Vlan200 access port, the SVI carries the addressing + VRRP pair, and OSPF
  // runs over the SVI network instead of the /30. One wire, one topology, both lanes.
  ...(peer === undefined || peer.peerPort === undefined
    ? []
    : peer.vrrp === true
      ? [
          'interface Loopback1',
          `   ip address ${PEER_LINK.aLoopback}/32`,
          'exit',
          `vlan ${String(VRRP_LINK.vlan)}`,
          `   name ${VRRP_LINK.name}`,
          'exit',
          `interface ${peer.peerPort}`,
          '   switchport',
          '   switchport mode access',
          `   switchport access vlan ${String(VRRP_LINK.vlan)}`,
          '   no shutdown',
          'exit',
          `interface Vlan${String(VRRP_LINK.vlan)}`,
          `   ip address ${VRRP_LINK.aIp}/24`,
          '   no shutdown',
          `   vrrp ${String(VRRP_LINK.vrid)} ipv4 ${VRRP_LINK.vip}`,
          `   vrrp ${String(VRRP_LINK.vrid)} priority-level ${String(VRRP_LINK.aPriority)}`,
          `   vrrp ${String(VRRP_LINK.vrid)} preempt`,
          'exit',
        ]
      : [
          'interface Loopback1',
          `   ip address ${PEER_LINK.aLoopback}/32`,
          'exit',
          `interface ${peer.peerPort}`,
          '   no switchport',
          `   ip address ${PEER_LINK.aIp}/30`,
          '   no shutdown',
          'exit',
          'router ospf 1',
          `   network ${PEER_LINK.subnet} area ${PEER_LINK.ospfArea}`,
          `   network ${PEER_LINK.aLoopback}/32 area ${PEER_LINK.ospfArea}`,
          'exit',
        ]),
  ]
}

/**
 * Commands whose refusal is a **finding**, not a failure — they ride along to probe
 * capability, and the batch must not die on them. Probed 2026-11-07 on a configured
 * cEOS-lab 4.28.14M: `switchport trunk group` was ACCEPTED (partly settling DR-028's
 * cEOS half — DECISIONS open item 4; the 7050TX verdict stays in #14 §3), while
 * `vrrp … ip` and `ip access-group …` on the SVI and a bare `ip routing` each answered
 * `% Unavailable command (not supported on this hardware platform)`. None of that is a
 * 7050TX verdict (DR-043); the lines stay on the wire so the staging transcript
 * records today's container answer instead of the harness guessing for the device.
 *
 * The `ip routing` entry outlived its own refusal: the verdict is BOOT-dependent — a
 * license-daemon race, see `waitForRoutingFeatures` (refused 2026-11-07/09, accepted
 * post-#98 and again on 2026-11-18, run lab-1809618-4b3cc0), and since #154 the routing
 * captures DEPEND on it landing — so it stays tolerated for the transcript, while
 * `provisionLab` now verifies the routing model after commit and fails the run loudly
 * if this draw refuses again.
 *
 * The `vrrp 1 ip …` entry keeps the DEPRECATED spelling on the wire on purpose: 2026-11-18
 * (run lab-1841022-612e1d) answered "% Unavailable command (This command is deprecated by
 * 'vrrp ipv4')" — new wording — and the successor order `vrrp <id> ipv4 <addr>` stages FULL
 * abort-only on the same image (bench lab-1858323-0626ae). Switching the provisioned line
 * would buy a configured-VRRP capture; #154 scopes VRRP OUT, so the line stays as the
 * deprecation transcript and the switch is an owner call tracked on #154/#90.
 */
const PROVISION_TOLERATED = new Set([
  'switchport trunk group LABGRP',
  'vrrp 1 ip 10.0.100.254',
  'ip access-group EXT-ACL-1 in',
  'ip routing',
])

/**
 * Map `%`-error lines to the command that produced them. EOS's own error text carries
 * the position — `… at line N` — counted against the SAME input array this call was
 * fed, so that mapping is direct when the marker exists. The echo-scan fallback (last
 * echoed command line) covers errors without a line marker; an error attributable
 * neither way stays `(unattributed)` and therefore fatal — silently tolerating an
 * unknown failure is the worse failure mode.
 * @param {string} transcript
 * @param {readonly string[]} inputCommands every line fed to Cli, in order, including
 *   the `configure session …` opener, so `at line N` indexes this array at N-1.
 */
function findStagingErrors(transcript, inputCommands) {
  /** @type {{command: string, line: string}[]} */
  const errors = []
  let lastCommand = null
  for (const raw of transcript.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('%')) {
      const marker = /at line (\d+)/i.exec(line)
      const numbered = marker ? inputCommands[Number(marker[1]) - 1]?.trim() : undefined
      errors.push({ command: numbered ?? lastCommand ?? '(unattributed)', line })
      continue
    }
    for (const cmd of inputCommands) {
      const t = cmd.trim()
      if (t && line.includes(t)) {
        lastCommand = t
        break
      }
    }
  }
  return errors
}

/**
 * Provision the representative config. Returns `{ok:true, tolerated}` after a
 * verified commit (the check that actually proves apply: `show vlan` must list the
 * new VLANs, independent of the transcript), or `{ok:false, ...}` with the session
 * already aborted on the staging path.
 * @param {string} container
 */
function provisionLab(container, ethA, ethB, peer) {
  const stagingInput = [`configure session ${PROVISION_SESSION}`, ...provisionStaging(ethA, ethB, peer)]
  const staged = cliScriptOpt(container, stagingInput, 180_000)
  const errors = findStagingErrors(staged, stagingInput)
  const fatal = errors.filter((e) => !PROVISION_TOLERATED.has(e.command))
  if (fatal.length > 0) {
    const aborted = cliScriptOpt(container, [`configure session ${PROVISION_SESSION}`, 'abort', 'end'])
    return { ok: false, stage: /** @type {'staging' | 'verification'} */ ('staging'), errors, fatal, staged, aborted, missingVlans: [] }
  }
  const committed = cliScriptOpt(container, [`configure session ${PROVISION_SESSION}`, 'commit', 'end'], 120_000)
  // Independent proof of apply: parse the VLAN model back over the CLI, never trust the
  // commit transcript alone (a Cli echo can render success for a partial apply).
  const vlanModel = cliJson(container, 'show vlan')
  const present = Object.keys(vlanModel?.vlans ?? {}).map((v) => String(v))
  const missingVlans = ['10', '100', '110', ...(peer?.vrrp === true ? [String(VRRP_LINK.vlan)] : [])].filter((v) => !present.includes(v))
  if (missingVlans.length > 0) {
    return { ok: false, stage: 'verification', errors, fatal: [], staged: staged + '\n' + committed, aborted: '', missingVlans }
  }
  // #154: routing must be LIVE, not merely staged. `ip routing` is a tolerated line because
  // its cEOS verdict is shape-dependent, so WITHOUT this check a refusing container shape
  // would flow straight into the routing captures as an "answers-while-unconfigured" set —
  // files that claim to model configured state (#87's read-only tabs bind on those field
  // sets). Non-throwing reader on purpose: a refusal here is the expected negative, not a
  // transport failure, and the run's teardown must still name the stage that died.
  const routeRaw = cliScriptOpt(container, ['show ip route | json'])
  let routeModel = null
  try {
    const brace = routeRaw.indexOf('{')
    if (brace >= 0) routeModel = JSON.parse(routeRaw.slice(brace))
  } catch {
    routeModel = null
  }
  if (!routeModel?.vrfs?.default) {
    return {
      ok: false,
      stage: 'routing',
      errors,
      fatal: [],
      staged: staged + '\n' + committed,
      aborted: '',
      missingVlans: [],
      routingDown: routeRaw.trim().split('\n').find((l) => l.trim().startsWith('%')) ?? '(no % line found)',
    }
  }
  const pending = openPendingSession(container)
  return {
    ok: true,
    tolerated: errors.filter((e) => PROVISION_TOLERATED.has(e.command)),
    staged,
    committed,
    pending,
  }
}

/**
 * Bounded wait for the routing feature set to be LICENSE-ACTIVE (see the call site in `cmdUp`).
 * The canary stages `router ospf 1` and aborts — zero committed effect, same session sandbox
 * provisionLab uses. Only the platform-capability wording counts as not-ready; any other `%`
 * answer breaks the wait and lets the real staging transcript carry the verdict (the canary
 * must never swallow a genuine grammar finding — DR-141 lesson: probe answers belong to the
 * device, not to the harness's patience).
 * @param {string} container
 * @param {{ attempts?: number, sleepMs?: number }} [opts]
 */
async function waitForRoutingFeatures(container, opts = {}) {
  const attempts = opts.attempts ?? 10
  const sleepMs = opts.sleepMs ?? 5000
  const canaryInput = [`configure session ${FEATURE_CANARY_SESSION}`, 'router ospf 1', 'abort']
  /** @type {string} */
  let last = ''
  for (let i = 1; i <= attempts; i += 1) {
    last = cliScriptOpt(container, canaryInput, 60_000)
    if (!/not supported on this hardware platform/i.test(last)) {
      return { ready: true, attemptsUsed: i, last }
    }
    const headline = last.split('\n').find((l) => l.trim().startsWith('%')) ?? '% Unavailable command'
    log(`[up] routing features not ready (canary ${String(i)}/${String(attempts)}): ${headline.trim()} — waiting ${String(sleepMs)}ms`)
    await sleep(sleepMs)
  }
  return { ready: false, attemptsUsed: attempts, last }
}

/**
 * #154 `--nodes=2`: the minimal configured shape for the PEER node — routed transit
 * link + loopback + OSPF, in a named session with the same stage-all-then-commit (or
 * abort) discipline as `provisionLab`. Deliberately NOT the full single-node config: the
 * peer exists so adjacency-dependent reads answer with real neighbor state, and every
 * extra stanza on B only widens the drift surface between the two nodes' captures.
 * @param {string} container @param {string} peerPort @param {boolean} [vrrp]
 */
function provisionPeer(container, peerPort, vrrp) {
  const stagingInput = [
    `configure session ${PEER_SESSION}`,
    'ip routing',
    // #87 --vrrp: the peer NIC is a Vlan200 access port and the SVI carries the BACKUP
    // (lower priority, preempt); without it the NIC is the routed /30 transit for OSPF.
    ...(vrrp === true
      ? [
          `vlan ${String(VRRP_LINK.vlan)}`,
          `   name ${VRRP_LINK.name}`,
          'exit',
          `interface ${peerPort}`,
          '   switchport',
          '   switchport mode access',
          `   switchport access vlan ${String(VRRP_LINK.vlan)}`,
          '   no shutdown',
          'exit',
          `interface Vlan${String(VRRP_LINK.vlan)}`,
          `   ip address ${VRRP_LINK.bIp}/24`,
          '   no shutdown',
          `   vrrp ${String(VRRP_LINK.vrid)} ipv4 ${VRRP_LINK.vip}`,
          `   vrrp ${String(VRRP_LINK.vrid)} priority-level ${String(VRRP_LINK.bPriority)}`,
          `   vrrp ${String(VRRP_LINK.vrid)} preempt`,
          'exit',
        ]
      : [
          `interface ${peerPort}`,
          '   no switchport',
          `   ip address ${PEER_LINK.bIp}/30`,
          '   no shutdown',
          'exit',
        ]),
    'interface Loopback1',
    `   ip address ${PEER_LINK.bLoopback}/32`,
    'exit',
    'router ospf 1',
    `   router-id ${PEER_LINK.bLoopback}`,
    // On the --vrrp shape the transit is the VRRP segment: OSPF stays off it (no hello
    // traffic onto the measured wire) and keeps only the loopback advertisement.
    ...(vrrp === true ? [] : [`   network ${PEER_LINK.subnet} area ${PEER_LINK.ospfArea}`]),
    `   network ${PEER_LINK.bLoopback}/32 area ${PEER_LINK.ospfArea}`,
    'exit',
  ]
  const staged = cliScriptOpt(container, stagingInput, 180_000)
  const errors = findStagingErrors(staged, stagingInput).filter((e) => !PROVISION_TOLERATED.has(e.command))
  if (errors.length > 0) {
    const aborted = cliScriptOpt(container, [`configure session ${PEER_SESSION}`, 'abort', 'end'])
    return { ok: /** @type {boolean} */ (false), errors, staged, aborted }
  }
  const committed = cliScriptOpt(container, [`configure session ${PEER_SESSION}`, 'commit', 'end'], 120_000)
  // Apply proof from the independent direction, like provisionLab's `show vlan` check:
  // the peer link must answer with routing live before the run is declared two-node.
  const routeRaw = cliScriptOpt(container, ['show ip route | json'])
  let routeModel = null
  try {
    const brace = routeRaw.indexOf('{')
    if (brace >= 0) routeModel = JSON.parse(routeRaw.slice(brace))
  } catch {
    routeModel = null
  }
  if (!routeModel?.vrfs?.default) {
    return { ok: false, errors: [], staged: staged + '\n' + committed, aborted: '', routingDown: routeRaw.trim().split('\n').find((l) => l.trim().startsWith('%')) ?? '(no % line)' }
  }
  return { ok: true, errors: [], staged, committed }
}

/**
 * #154 `--nodes=2`: bring up the peer node on the run-owned peer bridge. Mirrors the
 * primary node's contract on every safety dimension that matters — pinned image,
 * label ownership, privileged check, one create-time (bmgmt) attachment with the data
 * bridge joined before START (NICs bind at boot only), the license canary before any
 * routing staging, a run-scoped band-pinned mgmt bridge (the forwarder dials it from
 * the host, so the live-route requirement is identical to the primary's), the pinned
 * release/model identity check over authenticated eAPI, and its own loopback forwarder
 * + public-cert anchor so child suites trust it with the same triple as the primary.
 * Shares the run's lab credentials and state file (A's — the watchdog self-extinguish
 * covers both forwarders, and one secret print stays true).
 * @param {ReturnType<typeof labConfig>} cfg
 * @param {{ image: { tag: string, imageId: string }, runId: string, aMgmtSubnet: string, creds: { user: string, secret: string }, stateFile: string, aPeerPort: string }} opts
 */
async function bringUpPeerNode(cfg, opts) {
  const { runId, image, creds } = opts
  const containerB = `${containerName(runId)}-b`
  const bmgmt = networkName(runId, 'bmgmt')
  const peer = networkName(runId, 'peer')
  // A second host-reachable mgmt bridge: same candidate walk as the primary, minus the
  // /24 the primary already holds. Same failure mode (mirrored-mode route ownership) —
  // same refusal.
  /** @type {{ octetBase: string, cidr: string } | undefined} */
  let bSubnet
  const bTries = []
  for (const cand of mgmtSubnetCandidates(cfg.mgmtBand)) {
    if (cand.cidr === opts.aMgmtSubnet) continue
    const res = dockerOpt(['network', 'create', `--label=${LABEL_RUN}=${runId}`, `--label=${LABEL_MANAGER}=${MANAGER}`, `--subnet=${cand.cidr}`, bmgmt])
    if (res.status !== 0) {
      dockerOpt(['network', 'rm', bmgmt])
      bTries.push(`${cand.cidr}: create refused`)
      continue
    }
    const verdict = verifyMgmtBridgeRoute(cand.cidr, `${cand.octetBase}.10`)
    if (verdict.ok) {
      bSubnet = cand
      bTries.push(`${cand.cidr}: ${verdict.why}`)
      break
    }
    dockerOpt(['network', 'rm', bmgmt])
    bTries.push(`${cand.cidr}: ${verdict.why}`)
  }
  if (bSubnet === undefined) {
    refuse(`no peer mgmt subnet settled a live connected route. Tried: ${bTries.slice(0, 4).join(' · ')}`, EXIT.readiness)
  }
  const bMgmtIp = `${bSubnet.octetBase}.10`
  // The peer wire bridge is NOT created here: cmdUp created it before the primary's
  // `docker start` (extraNets, f946281) because cEOS binds NICs to front-panel ports
  // only at boot — a create-time re-create here always died with
  // "network with name …-peer already exists" (exit 8, observed 2026-11-19).

  const createArgs = [
    'create',
    `--name=${containerB}`,
    '--privileged',
    `--label=${LABEL_RUN}=${runId}`,
    `--label=${LABEL_MANAGER}=${MANAGER}`,
    // Same ifname pinning as the primary: bmgmt=eth0 (Management1), peer=eth1
    // (Ethernet1 — B's single front panel, the transit/VRRP wire).
    `--network=${`name=${bmgmt},ip=${bMgmtIp},driver-opt=com.docker.network.endpoint.ifname=eth0`}`,
  ]
  for (const [k, v] of VENDOR_ENV) createArgs.push('-e', `${k}=${v}`)
  createArgs.push('-i', image.tag, '/sbin/init')
  for (const [k, v] of VENDOR_ENV) createArgs.push(`systemd.setenv=${k}=${v}`)
  const cidB = docker(createArgs).trim()
  // #87 --vrrp: the SAME peer bridge carries the shared-L2 VRRP segment — B's single peer
  // NIC becomes a Vlan200 access port instead of the routed /30 (provisionPeer below).
  docker(['network', 'connect', '--driver-opt', 'com.docker.network.endpoint.ifname=eth1', peer, containerB]) // pre-START: NICs bind at boot only
  const privileged = docker(['container', 'inspect', '--format', '{{.HostConfig.Privileged}}', containerB]).trim()
  if (privileged !== 'true') refuse(`docker recorded HostConfig.Privileged=${privileged} for ${containerB}`, EXIT.privileged)
  docker(['start', containerB])
  const cliB = await waitForEosCli(containerB, cfg.cliTimeoutSec)
  if (!cliB.ready) refuse(`peer EOS never answered within ${cfg.cliTimeoutSec}s (${cliB.attempt} attempts, last: ${cliB.last})`, EXIT.readiness)

  const bPanels = await waitForFrontPanelPorts(containerB, cfg.frontPanelTimeoutSec)
  if (bPanels.length < 1) refuse(`peer presented no front-panel Ethernet ports within ${cfg.frontPanelTimeoutSec}s — the peer bridge did not bind at boot`, EXIT.readiness)

  const bCreds = { user: creds.user, secret: creds.secret }
  bootstrapLab(containerB, bCreds)
  const bFeatures = await waitForRoutingFeatures(containerB)
  if (!bFeatures.ready) refuse('peer node: routing canary never went ready (license-daemon race) — recreate the run', EXIT.readiness)
  const bPorts = bPanels[0]
  const bProv = provisionPeer(containerB, bPorts, cfg.vrrp)
  if (!bProv.ok) {
    const why = 'routingDown' in bProv ? `peer routing not live after commit (${bProv.routingDown})` : bProv.errors.map((e) => `${e.command} -> ${e.line}`).join('; ')
    refuse(`peer provisioning (session ${PEER_SESSION}) failed: ${why}`, EXIT.internal)
  }

  const bPort = await allocateEndpoint(cfg.hostIp, runId, null)
  const { pid: bForwarderPid, ready: bReady } = startForwarder({ hostIp: cfg.hostIp, port: bPort, mgmtIp: bMgmtIp, apiPort: cfg.containerApiPort, stateFile: opts.stateFile })
  try {
    await bReady
  } catch (err) {
    refuse(`peer loopback forwarder ${cfg.hostIp}:${bPort} -> ${bMgmtIp}:${cfg.containerApiPort} never came up: ${String(err instanceof Error ? err.message : err)}`, EXIT.readiness)
  }
  const bAnchor = await readContainerPublicCertWait(containerB, cfg.certWaitSec)
  if (!bAnchor.pem) refuse('peer container exposed no public certificate anchor — no trust anchor, refusing', EXIT.readiness)
  const bCertFile = certFilePath(`${runId}-b`)
  fs.writeFileSync(bCertFile, `${bAnchor.pem}\n`, { mode: 0o600 })
  fs.chmodSync(bCertFile, 0o600)
  // Identity gate identical to the primary probe: same pinned base release, container model only.
  const reply = await eapiRunCmds(
    { host: cfg.hostIp, port: bPort, user: bCreds.user, secret: bCreds.secret, anchor: bAnchor },
    { cmds: ['show version'], format: 'json', id: 'ceos-lab-peer-ready', timeoutMs: cfg.requestTimeoutMs },
  )
  const identity = identityFromShowVersion(reply.result[0])
  const baseOk = identity.baseFromVersion === cfg.expectVersion || identity.baseFromInternal === cfg.expectVersion || identity.bareInternal === cfg.expectVersion
  if (!baseOk || !identity.modelName || !/^ceos/i.test(identity.modelName)) {
    refuse(`peer identity failed the release/model gate (base=${JSON.stringify(identity.baseFromVersion ?? identity.baseFromInternal)}, model=${JSON.stringify(identity.modelName)})`, EXIT.readiness)
  }
  return {
    container: containerB,
    containerId: cidB,
    networks: { bmgmt, peer },
    mgmtSubnet: bSubnet.cidr,
    mgmtContainerIp: bMgmtIp,
    port: bPort,
    forwarderPid: bForwarderPid,
    certFile: bCertFile,
    anchorFingerprint256: bAnchor.fingerprint256,
    anchorSubject: bAnchor.subject,
    frontPanelPorts: bPanels,
    peerInterface: bPorts,
    cliReadyMs: cliB.elapsedMs,
    aPeerInterface: opts.aPeerPort,
  }
}

/**
 * Leave a zero-write **open** config session behind on purpose: `show configuration
 * sessions [+detail]` (a #62 capture) otherwise has nothing to list, and the field set
 * `ConfigSessionSummary` models (§5 row 70's `maxOpenSessions`/start-time questions) is
 * only visible when the device reports at least one session. The session stages a
 * non-committed change (a hostname the run never applies) and is never committed or
 * aborted — it disappears with the container. Running-config is untouched by this.
 * @param {string} container
 */
function openPendingSession(container) {
  return cliScript(container, [`configure session ${PENDING_SESSION}`, 'hostname lab-pending-not-committed'])
}

/* ------------------------------------------------------- loopback forwarder */

/**
 * Hand the run's reserved loopback port to a detached instance of
 * scripts/eapi-port-forward.mjs dialing the container's mgmt-bridge IP. This
 * replaces Docker's `-p` publish, removed from createArgs after the 2026-11-08
 * WSL2-restart finding (last bullet of the createArgs note above): the publish
 * resolved to the run's data1 bridge, so the endpoint died at the Docker hop
 * while eAPI itself was healthy — `Hits: 0, Bytes in: 0` on the EOS side,
 * `read ECONNRESET` on ours. The forwarder is a pure byte relay: TLS passes
 * through untouched, so the certificate anchored from the container still
 * matches byte-for-byte (verified same-day), and the child's endpoint contract
 * (EAPI_HOST=127.0.0.1 + ephemeral port + CA pin) is unchanged.
 * @param {{hostIp: string, port: number, mgmtIp: string, apiPort: number, stateFile: string}} opts
 */
function startForwarder(opts) {
  const script = path.join(SCRIPT_DIR, 'eapi-port-forward.mjs')
  /** @type {() => void} */
  let onReady
  /** @type {(err: Error) => void} */
  let onFail
  const ready = new Promise((resolve, reject) => {
    onReady = resolve
    onFail = reject
  })
  // The refusal path rejects `ready` while a caller in cmdUp awaits it; attach a
  // no-op catch here so an unref'd orphan child can never become an
  // unhandled-rejection crash outside that await.
  ready.catch(() => {})
  const child = spawn(
    process.execPath,
    [
      script,
      '--port', String(opts.port),
      '--listen', opts.hostIp,
      '--target-ip', opts.mgmtIp,
      '--target-port', String(opts.apiPort),
      '--state-file', opts.stateFile,
    ],
    { detached: true, stdio: ['ignore', 'pipe', 'inherit'] },
  )
  let settled = false
  let buf = ''
  /** @param {Error} err */
  const fail = (err) => {
    if (settled) return
    settled = true
    onFail(err)
  }
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (/** @type {string} */ chunk) => {
    buf = (buf + chunk).slice(-4096)
    if (!settled && buf.includes('listening')) {
      settled = true
      onReady()
    }
  })
  child.on('error', (err) => fail(new Error(`forwarder failed to start: ${err.message}`)))
  child.on('exit', (code) => {
    const tail = buf.trim().split('\n').pop() ?? ''
    if (settled) {
      log(`[forwarder] pid ${String(child.pid)} exited (code ${String(code)})${tail === '' ? '' : `: ${tail}`} — the endpoint is gone; the next probe fails and teardown is idempotent`)
      return
    }
    fail(new Error(`forwarder exited (code ${String(code)}) before becoming ready${tail === '' ? '' : `: ${tail}`}`))
  })
  setTimeout(() => fail(new Error('forwarder produced no `listening` line within 10s')), 10_000).unref()
  child.unref()
  return { pid: child.pid ?? 0, ready }
}

/** @param {{forwarderPid?: number | null}} state */
function stopForwarder(state) {
  const pid = state?.forwarderPid
  if (!Number.isInteger(pid) || (pid ?? 0) <= 0) return
  // Ownership check before signalling: a bare pid can be recycled by an unrelated
  // process long after the run, so /proc/<pid>/cmdline must name the forwarder.
  let cmd = ''
  try {
    cmd = fs.readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8')
  } catch {
    return // already gone
  }
  if (!cmd.includes('eapi-port-forward')) {
    log(`[forwarder] pid ${String(pid)} is no longer the forwarder (recycled) — leaving it alone`)
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    /* racing the forwarder's own self-extinguish — fine */
  }
}

/* ------------------------------------------------------------- probe command */

/** @param {ReturnType<typeof labConfig>} cfg @param {NonNullable<ReturnType<typeof readState>>} state */
async function cmdProbe(cfg, state) {
  const t0 = Date.now()
  const anchor = await readContainerPublicCertWait(state.container, cfg.certWaitSec)
  if (!anchor.pem) {
    refuse(
      `no public certificate anchor was readable inside the container within ${String(cfg.certWaitSec)}s (tried: ${anchor.tried
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
    if (attempt === 2) {
      // Route-death fast-fail: `up` proved the connected route live at create time,
      // so repeated early handshake deaths mean reconciliation ate it during boot
      // (the 172.31.159/193-adjacent flake class). The remaining window cannot fix
      // a deleted host route, so check the path now and refuse with the fix.
      const routeCheck = verifyMgmtBridgeRoute(String(state.mgmtSubnet ?? ''), String(state.mgmtContainerIp ?? ''))
      if (!routeCheck.ok) {
        log(
          `[probe] REFUSED: the host route to ${String(state.mgmtContainerIp)} died mid-run — ${routeCheck.why}. `
          + 'Not waiting out the remaining window: a fresh run may land on a clean /24, but a host that '
          + 'keeps eating bridge routes needs docs/CEOS.md §Host-route reconciliation (NAT-mode '
          + '.wslconfig or a native Linux lab runner).',
        )
        return { exitCode: EXIT.readiness, runId: state.runId, reason: 'mgmt-route-lost-mid-run', detail: routeCheck.why }
      }
      // Second fast-fail, the mirrored-mode twin (CI run 42528431866, 2026-11-08): the
      // connected route reads live the whole time, yet a direct TLS/conn attempt to the
      // mgmt IP comes back EHOSTUNREACH and CApi records `Hits: 0` — the host's NAT layer
      // owns the /12 the bridge sits in and eats the traffic the kernel route says is local.
      // Detecting it at attempt 2 saves the whole 240 s window and names the band.
      const midRunPeek = state.mgmtContainerIp
        ? await peekServedCert({ host: String(state.mgmtContainerIp), port: cfg.containerApiPort })
        : { fingerprint256: null, error: 'no mgmtContainerIp in state' }
      if (!midRunPeek.fingerprint256 && /EHOSTUNREACH|ENETUNREACH|ECONNRESET/i.test(String(midRunPeek.error ?? ''))) {
        log(
          `[probe] REFUSED: the mgmt path to ${String(state.mgmtContainerIp)}:${String(cfg.containerApiPort)} is dead ` +
            `(${String(midRunPeek.error)}) even though the route reads live (${routeCheck.why}). This /24 is inside the ` +
            'range the host network stack owns (WSL2 mirrored-mode + Windows HNS on 172.16/12); docs/CEOS.md ' +
            '§Host-route reconciliation — NAT-mode .wslconfig, a native Linux lab runner, or pinning the lab to the ' +
            '192.168.255.0/24 band (the harness prefers it for exactly this reason).',
        )
        for (const line of pathEvidence(String(state.container), String(state.mgmtSubnet ?? ''), String(state.mgmtContainerIp ?? ''))) {
          log(`[probe] ${line}`)
        }
        return { exitCode: EXIT.readiness, runId: state.runId, reason: 'mgmt-path-owned-by-host-nat', detail: String(midRunPeek.error) }
      }
    }
    await sleep(cfg.retryDelayMs)
  }
  const logs = dockerOpt(['container', 'logs', '--tail', '20', state.container])
  const api = dockerOpt(['exec', '-i', state.container, 'Cli', '-p', '15'], {
    input: 'show management api http-commands\n',
  })
  // Endpoint attribution: untrusted TLS peeks at BOTH ends of the relay path tell
  // us who broke the round — `error` on the mgmt side means the container/eAPI
  // itself, fingerprint on mgmt but error at 127.0.0.1 means our forwarder, and
  // fingerprints on both with eAPI still refusing means application layer.
  const relayPeek = await peekServedCert({ host: cfg.hostIp, port: state.port })
  const directPeek = state.mgmtContainerIp
    ? await peekServedCert({ host: String(state.mgmtContainerIp), port: cfg.containerApiPort })
    : { fingerprint256: null, error: 'no mgmtContainerIp in state' }
  const routeVerdict = verifyMgmtBridgeRoute(String(state.mgmtSubnet ?? ''), String(state.mgmtContainerIp ?? ''))
  let forwarderStatus = 'none in state'
  if (Number.isInteger(state.forwarderPid) && state.forwarderPid > 0) {
    try {
      forwarderStatus = `pid ${String(state.forwarderPid)} ${fs.readFileSync(`/proc/${String(state.forwarderPid)}/cmdline`, 'utf8').includes('eapi-port-forward') ? 'alive' : 'RECYCLED pid'}`
    } catch {
      forwarderStatus = `pid ${String(state.forwarderPid)} gone`
    }
  }
  log(
    `[probe] REFUSED: authenticated eAPI never succeeded on ${cfg.hostIp}:${state.port} within ${cfg.probeTimeoutSec}s ` +
      `(${attempt} attempts, last: ${lastReason})`,
  )
  log(
    `[probe] endpoint diagnostics: relay 127.0.0.1:${String(state.port)} -> ` +
      `${relayPeek.fingerprint256 ? `cert ${String(relayPeek.fingerprint256).slice(0, 16)}…` : `error ${String(relayPeek.error ?? 'none')}`}; ` +
      `direct ${String(state.mgmtContainerIp)}:${String(cfg.containerApiPort)} -> ` +
      `${directPeek.fingerprint256 ? `cert ${String(directPeek.fingerprint256).slice(0, 16)}…` : `error ${String(directPeek.error ?? 'none')}`}; ` +
      `route: ${routeVerdict.ok ? 'live' : 'BROKEN'} (${routeVerdict.why}); ` +
      `forwarder: ${forwarderStatus}`,
  )
  for (const line of pathEvidence(String(state.container), String(state.mgmtSubnet ?? ''), String(state.mgmtContainerIp ?? ''))) {
    log(`[probe] ${line}`)
  }
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
 * The capture catalog — the read-only commands whose replies become committed fixtures.
 *
 * M12b's first run recorded nine files (§5 row 113: `show version[+text]`, `interfaces
 * status[+text]`, `vlan`, `mlag`, `lldp neighbors`, `management api http-commands[+text]`).
 * M12c (#14) extends the same machinery to the commands the **wave-1 resource modules**
 * actually depend on, and the additions are deliberately split by what a parser consumes:
 *  - `text` is the only format the config-text readers ever see: `src/resources/config-block.ts`,
 *    `src/resources/system.ts` and the interface/vlan/switchport section readers all parse EOS
 *    **text**, so `show running-config` (text) is the repository's first device-backed input to
 *    those parsers instead of hand-authored fixture text (row 113 retired the "synthetic until
 *    M12" note for nine commands only; this line retires it for the config text itself).
 *  - `json` is the model shape: `show interfaces` (full, not only the `status` subset) and
 *    `show port-channel detail` are the operational models M10a/M10c's parsers claim to follow
 *    without ever having held a capture of the sibling command (`interfaces.ts:179/212` cites the
 *    `show interfaces status` capture for the status half only).
 *
 * Requests are one command each, on the same pinned endpoint the readiness check used, and each is
 * framed the way this client frames a read: **`enable` is prepended** (`src/command-layer.ts`'s
 * `sendEnable` default, pyeapi `run_commands` at `client.py:876-925`, MIGRATION.md §5 row 82's
 * `['enable', 'show running-config all']`). That framing is not cosmetic — observed on 2026-11-06, a
 * bare `show running-config` / `show running-config all` request answers `1002 invalid command` while
 * the same command preceded by `enable` answers the config text, so a capture set recorded without it
 * would report the harness's framing as if it were the device's verdict. `json` entries keep
 * `id: 'ceos-lab-capability'` because that id is what the capability-probe refusal text in row 108's
 * evidence names. A command that fails is returned as a **negative result** (a cEOS-lab gap is evidence,
 * not something to hide) and simply never becomes a file — §5 row 113's count is derived from what the
 * device answered, never from what this list hoped for.
 *
 * @type {{command: string, format: 'text' | 'json', id: string, note?: string}[]}
 */
const CAPTURE_CATALOG = [
  // CLI text — parser-facing evidence (see the header above).
  { command: 'show version', format: 'text', id: 'ceos-lab-text' },
  { command: 'show interfaces status', format: 'text', id: 'ceos-lab-text' },
  { command: 'show management api http-commands', format: 'text', id: 'ceos-lab-text' },
  { command: 'show ip interface brief', format: 'text', id: 'ceos-lab-text' },
  {
    command: 'show running-config',
    format: 'text',
    id: 'ceos-lab-text',
    note: 'config text for the M6/M9/M10 section parsers — real device text replaces hand-authored fixture prose. This is the form the CLI shows an operator; over eAPI it answers only when preceded by `enable`, i.e. framed exactly as this client frames a read (both spellings of `show running-config` answered 1002 without it, observed 2026-11-06 — which is why the capture must not be recorded without the opener).',
  },
  {
    command: 'show running-config all',
    format: 'text',
    id: 'ceos-lab-text',
    note: 'the spelling this client actually puts on the wire (`configDefaults` defaults to pyeapi\'s `config_defaults` true, `client.py:506`), so this is the config text the parsers really see',
  },
  // JSON models.
  { command: 'show interfaces switching', format: 'json', id: 'ceos-lab-capability' },
  { command: 'show platform overview', format: 'json', id: 'ceos-lab-capability' },
  { command: 'show mlag', format: 'json', id: 'ceos-lab-capability' },
  { command: 'show vlan', format: 'json', id: 'ceos-lab-capability' },
  { command: 'show lldp neighbors', format: 'json', id: 'ceos-lab-capability' },
  { command: 'show agents', format: 'json', id: 'ceos-lab-capability' },
  {
    command: 'show running-config',
    format: 'json',
    id: 'ceos-lab-capability',
    note: 'JSON envelope of the same config text (`output` string), recorded beside the text capture so a reviewer can diff the two spellings',
  },
  {
    command: 'show running-config all',
    format: 'json',
    id: 'ceos-lab-capability',
    note: 'the JSON envelope of the accepted spelling, kept beside the text capture so a reviewer can diff the two transports of the same device text',
  },
  {
    command: 'show interfaces switchport',
    format: 'json',
    id: 'ceos-lab-capability',
    note: 'the model-backed switchport read DR-018/DR-029 have always owed (DECISIONS open item 4). The 2026-11-06 run settled the command exists on 4.28.14M — it answers the JSON model `{"switchports":{}}`, empty because this container has no configured L2 port — while `show interfaces switching` stays a 1002 even with `enable`. So the model is real and the missing half is a configured port, not a missing command',
  },
  {
    command: 'show interfaces',
    format: 'json',
    id: 'ceos-lab-capability',
    note: 'full per-interface operational model, the sibling of the `show interfaces status` capture M10a cites',
  },
  {
    command: 'show port-channel detail',
    format: 'json',
    id: 'ceos-lab-capability',
    note: 'M10c Port-Channel model; on cEOS-lab 4.28.14M this is a 1002 refusal and `show port-channel summary` is deprecated by `show port-channel dense` (both observed 2026-11-06), so the negative result is the finding',
  },
  {
    command: 'show port-channel 1 all-ports',
    format: 'json',
    id: 'ceos-lab-capability',
    note: 'the exact command `src/resources/interfaces.ts` sends for `getMembers` (the shape row 125 owed to M12). The 2026-11-06 run settled it: an unconfigured group answers `{"portChannels":{}}` over eAPI, which is why `getMembers` yields `[]` while the CLI says "Port-Channel1 not configured as LAG"',
  },
  /* ---- issue #62: configured-container re-capture batch. Every family below was
   * either MISSING (no capture at all) or answered EMPTY because `lab-811108-5dcd01`
   * ran against an unconfigured node. The `provisionLab` block above exists precisely
   * so these commands answer the way they do on a configured switch; the negative
   * results that stay negative are still the finding, recorded verbatim. ---- */
  {
    command: 'show lag',
    format: 'json',
    id: 'ceos-lab-capability',
    note: 'the reader of S5 (#75) pins its ShowContract key on this reply. Probed 2026-11-07 over the CLI: bare `show lag` answers `% Incomplete command` and `show lag summary`/`show lag detail` `% Invalid input` on cEOS-lab 4.28.14M — the configured Po1 evidence therefore lands in `show port-channel dense` and `show port-channel 1 all-ports` on this target, while `show lag resources` for the hardware stays a #14 §3 line',
  },
  {
    command: 'show port-channel summary',
    format: 'json',
    id: 'ceos-lab-capability',
    note: 'named explicitly by #62; re-probed 2026-11-07 against configured Po1: refuses with "This command is deprecated by show port-channel dense" — that negative is the cEOS verdict; `show port-channel dense` below carries the populated model',
  },
  {
    command: 'show port-channel dense',
    format: 'json',
    id: 'ceos-lab-capability',
    note: 'the replacement spelling 4.28 points at; probed configured container answered `numberOfAggregators/numberOfChannelsInUse/portChannels` 2026-11-07',
  },
  { command: 'show spanning-tree', format: 'json', id: 'ceos-lab-capability', note: 'the provisioner sets MST priority 4096 + portfast/bpduguard on Eth1 (bare global `spanning-tree` answers `% Incomplete command` — probed 2026-11-07), yet the committed capture is still a DEFAULT (priority-joined) instance, not the explicit-mode-joined per-instance state #88 names its blocker on (the 2026-11-06 file came from an unconfigured container). #154 item 5 adds the blast live suite `src/stp-mode-change.live.test.ts` (commit `spanning-tree mode rapid-pvst` → observe the flip → abort-restore, net-zero) alongside this refresh; BOTH capture and blast are GATED (DR-145/DR-146): the whole privileged cEOS start is refused on the mirrored-mode WSL2 host (`BPF_PROG_LOAD: bpf: permission denied`), so this refresh is pending on a proven-L2 host and #88 step 2 (guard-design DECISIONS) still consumes, never is replaced by, it' },
  {
    command: 'show spanning-tree detail',
    format: 'json',
    id: 'ceos-lab-capability',
    note: '#62 asks for detail "if accepted" — acceptance is what is unknown, so a 1002 here is a recorded negative, not a skipped file. #154 item 5 refreshes it from the CONFIGURED container alongside `show spanning-tree` and the blast suite (DR-146); refresh pending the proven-L2 host (DR-145)',
  },
  { command: 'show ntp status', format: 'json', id: 'ceos-lab-capability', note: 'configured-but-unreachable server is deliberate: S12 (#82) reads the unsynced shape' },
  { command: 'show ntp associations', format: 'json', id: 'ceos-lab-capability' },
  {
    command: 'show ip interface brief',
    format: 'json',
    id: 'ceos-lab-capability',
    note: 'the text capture exists from 2026-11-06; the json half was never recorded — #62 closes that gap against configured Vlan100/Vlan110',
  },
  {
    command: 'show access-lists',
    format: 'json',
    id: 'ceos-lab-capability',
    note: 'the counters half named by #62; probed 2026-11-07: this image answers `% Invalid input` for `show access-lists` — the negative is recorded, and the populated rule model lands in `show ip access-lists` next. Attachment was refused on cEOS-lab (see PROVISION_TOLERATED), so per-entry packet counters are a #14 §3 hardware question on this repo\u2019s evidence',
  },
  {
    command: 'show ip access-lists',
    format: 'json',
    id: 'ceos-lab-capability',
    note: 'the spelling this container accepts: STD-ACL-1 + EXT-ACL-1 rule entries (plus the read-only default-control-plane-acl, which the redactor must never touch and S13 must not render as user config)',
  },
  {
    command: 'show configuration sessions',
    format: 'json',
    id: 'ceos-lab-capability',
    note: 'captured while `lab-pending-capture` is deliberately left OPEN (zero committed effect) so the field set ConfigSessionSummary models — the §5 row 70 / B4 (#89) questions about maxOpenSessions, maxSavedSessions and start-time fields — has a listed session to model. The 7050TX half of this stays in #14 §3',
  },
  { command: 'show configuration sessions detail', format: 'json', id: 'ceos-lab-capability', note: 'verbatim per #62; feeds the same field-set questions' },
  { command: 'show vrf', format: 'json', id: 'ceos-lab-capability', note: 'read-only prerequisite of B6 (#90); answered `vrfs` on the probed container (cEOS-lab defaults to the default VRF only); empty/1002 answers are recorded as negative results, never files' },
  { command: 'show ip route', format: 'json', id: 'ceos-lab-capability', note: 'populated by the provisioned SVI connected routes + the provisioned static route; prerequisite of S10 (#80). Since #154 routing is LIVE at capture time (run lab-1841022-612e1d answered vrf `default` with both routes and the `routingDisabled` field visible) — the historic capture answered with routing globally unavailable, which was the license-boot race, not a platform refusal; the `ip routing` verdict on the hardware stays #14 §3' },
  { command: 'show vrrp', format: 'json', id: 'ceos-lab-capability', note: 'empty HERE is a provisioning artifact, NOT a read-capability negative (DR-157 corrects DR-122\'s 1002/empty verdict): the provisioned SVI line stays the OLD spelling `vrrp 1 ip …`, which 2026-11-18 (run lab-1841022-612e1d) refuses with "% Unavailable command (This command is deprecated by \'vrrp ipv4\')" — wording changed from the 2026-11-07 platform refusal, and the successor order `vrrp <id> ipv4 <addr>` stages FULL abort-only on the same image (bench lab-1858323-0626ae). With a group actually configured (the `--vrrp` two-node shape, run lab-1926138-47bd56) and read after initialisation through the enable-prefixed path, `show vrrp` answers with the FULL populated model — see docs/evidence/vrrp-failover-two-node.ceos.json. `show vrrp detail` stays a real 1002 on this image. A configured-VRRP capture in THIS probe is still a deliberate owner decision before provisioning changes (touches the out-of-scope line of #154 and the posture of #90)' },
  /* ---- 2026-11-15 unblock reads (companion to the hardware lane in src/testing/hw-capture.ts).
   * Since #154 the provisioning block carries a CONFIGURED routing shape (OSPF process, BGP
   * neighbor, route-map + prefix-list), gated by the license-readiness canary, so the routing
   * commands below answer as configured whenever the boot's license daemon is ready. The
   * historic "cEOS refuses ip routing" wording described a boot race, not a capability (see
   * `waitForRoutingFeatures`); a refusing draw still fails the run loudly at the post-commit
   * routing check. Every answer stays the cEOS-lab verdict, never a 7050TX one (DR-043); the
   * real box's grammar verdicts come from the abort-only staged probes in
   * docs/hw-capture-unblock.draft.json. ---- */
  { command: 'show vxlan interface', format: 'json', id: 'ceos-lab-capability', note: 'B1 (#86): does cEOS-lab 4.28.14M model a Vxlan interface at all; presence/schema here, the SKU verdict is the #14 §3 hardware read' },
  { command: 'show vxlan vni', format: 'json', id: 'ceos-lab-capability', note: 'B1 (#86): VNI<->VLAN mapping shape (empty unless configured; provisioning does not add a VTEP, so a 1002 or empty map is the finding)' },
  { command: 'show vxlan tunnel', format: 'json', id: 'ceos-lab-capability', note: 'B1 (#86): VTEP tunnel table shape from a configured VTEP — deliberately NOT configured here, so this documents the unconfigured-container answer' },
  { command: 'show ip ospf', format: 'json', id: 'ceos-lab-capability', note: 'B2 (#87): the per-instance field set for the OSPF status tab, CONFIGURED (run lab-1841022-612e1d: `vrfs.default.instList.1` with asbr, lsaInformation, spfInformation, maxLsaInformation, referenceBandwidth, gracefulRestartInfo, …). Single-node limits: no adjacencies exist here — populated neighbor state is #154 item 2 (two-node lane); the hardware own OSPF answers stay the run-7/run-9 recordings (DR-043)' },
  { command: 'show ip ospf neighbor', format: 'json', id: 'ceos-lab-capability', note: 'B2 (#87): the neighbor-table field set the read-only status tab would render (unknown-safe), configured-single-node answer `instList.1.ospfNeighborEntries: []` — a live table ENTRY shape needs a second node (#154 item 2); empty is the honest answer for this topology, not a refusal' },
  { command: 'show bgp summary', format: 'json', id: 'ceos-lab-capability', note: 'B2 (#87): 4.28 points at `show bgp` (not `show ip bgp`) — bare `show bgp` answers 1002 INCOMPLETE at token 1 (captured 2026-11-16), so the sub-keyed spelling is the real reader contract. #154 re-probed CONFIGURED (router bgp 65001 committed, run lab-1841022-612e1d): eAPI answers 1000 "could not run command" and the same container CLI answers `{"errors":["Not supported"]}`; `json raw` is invalid input and `json revision 2` prints nothing (bench lab-1858323-0626ae). VERDICT: the BGP JSON read model is unreachable on this image even when configured — the BGP tab of #87 cannot bind a container read model (the 7050TX half is the run-7 "% Not supported" recording — never a cross-claim, DR-043)' },
  { command: 'show bgp neighbors', format: 'json', id: 'ceos-lab-capability', note: 'B2 (#87): the second spelling #87 names outright; refused-with-code recorded as a negative result, never a file. #154 configured re-probe (bench lab-1858323-0626ae over Cli): `{"errors":["Invalid requested version for ModelMetaClass: no such revision 3, most current is 2","Not supported"]}` — the model exists at an older revision but NO spelling reachable from eAPI `format:json` can pin it, so the unreadable verdict stands for the reader contract' },
  { command: 'show route-map', format: 'json', id: 'ceos-lab-capability', note: 'B2 (#87): route-map model, now CONFIGURED by provisioning (#154: RM-LAB-IMPORT entries 10 permit/match prefix-list PL-LAB-STATIC and 20 deny, committed in run lab-1841022-612e1d) — the viewer reads populated `routeMaps.<name>.entries.<seq>` with match/set/description shapes; the earlier unconfigured `{routeMaps:{}}` capture still stands as the empty schema case in git history' },
  { command: 'show ip route vrf all', format: 'json', id: 'ceos-lab-capability', note: 'B6 (#90): per-VRF route-table shape with routing live (#154: default VRF populated with the connected/static routes); still default-VRF-only because provisioning adds no VRF instance — the multi-VRF table shape remains a #14 §3 question (run 7 answered POPULATED on the real box)' },
]

/**
 * Run {@link CAPTURE_CATALOG} against the run's own pinned endpoint.
 * @param {ReturnType<typeof labConfig>} cfg @param {Parameters<typeof eapiRunCmds>[0]} pin
 */
async function captureFromEapi(cfg, pin) {
  /** @type {{command: string, format: string, ok: boolean, result?: any, note?: string, error?: string}[]} */
  const out = []
  for (const entry of CAPTURE_CATALOG) {
    const { command, format, id, note } = entry
    // `enable` first, exactly like the client's own round trip, then pop its reply off (`client.py:922-923`
    // parity, asserted by `src/command-layer.config.test.ts`). The captured reply is the one for `command`.
    const cmds = ['enable', command]
    try {
      const reply = await eapiRunCmds(pin, { cmds, format, id, timeoutMs: 20_000 })
      if (!Array.isArray(reply.result) || reply.result.length < cmds.length) {
        throw new Error(`runCmds answered ${String(reply.result?.length)} result(s) for ${String(cmds.length)} command(s)`)
      }
      out.push({
        command,
        format,
        ok: true,
        result: reply.result[cmds.length - 1],
        ...(note === undefined ? {} : { note }),
        ...(format === 'json' && note === undefined ? { note: 'capability observation' } : {}),
      })
    } catch (err) {
      out.push({
        command,
        format,
        ok: false,
        error: err?.message ?? String(err),
        note: note === undefined ? 'capability observation — negative result recorded verbatim' : `${note} — negative result recorded verbatim`,
      })
    }
  }
  void cfg
  return out
}

/**
 * One catalog command executed through the container's own CLI.
 * `Cli -p 15` is enable-mode, so it is the SAME EOS agent and parser answering the
 * eAPI server — only the transport differs — and it is the only reach path that has
 * NEVER failed on this host: every provisioning/session interaction this harness
 * performs already rides through it. JSON replies are fenced by `| json`; text
 * replies drop the echoed-prompt preamble. A leading `%` error line throws — the
 * caller records it as a negative result, exactly like the eAPI path.
 * @param {string} container @param {string} command @param {'json'|'text'} format
 */
async function runCliCapture(container, command, format) {
  const raw = cliScriptOpt(container, [format === 'json' ? `${command} | json` : command], 60_000)
  if (format === 'json') {
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start < 0 || end <= start) throw new Error(`no JSON object in Cli reply for ${command}: ${(raw || '(empty)').slice(0, 200)}`)
    return JSON.parse(raw.slice(start, end + 1))
  }
  const lines = raw.split('\n')
  const echo = lines.findIndex((l) => /^\s*(>|localhost[>#])\s*\S/.test(l))
  const body = echo >= 0 ? lines.slice(echo + 1) : lines
  const first = body.find((l) => l.trim() !== '')
  if (first && first.trim().startsWith('%')) throw new Error(`Cli answered an error for ${command}: ${first.trim()}`)
  return { output: `${body.join('\n').replace(/\s+$/g, '')}\n` }
}

/**
 * Run {@link CAPTURE_CATALOG} through {@link runCliCapture}. Mirrors
 * {@link captureFromEapi}'s negative-result semantics verbatim.
 * @param {string} container
 */
async function captureFromCli(container) {
  /** @type {{command: string, format: string, ok: boolean, result?: any, note?: string, error?: string}[]} */
  const out = []
  for (const entry of CAPTURE_CATALOG) {
    const { command, format, note } = entry
    try {
      const result = await runCliCapture(container, command, format)
      out.push({
        command,
        format,
        ok: true,
        result,
        ...(note === undefined ? {} : { note }),
        ...(format === 'json' && note === undefined ? { note: 'capability observation' } : {}),
      })
    } catch (err) {
      out.push({
        command,
        format,
        ok: false,
        error: err?.message ?? String(err),
        note: note === undefined ? 'capability observation — negative result recorded verbatim' : `${note} — negative result recorded verbatim`,
      })
    }
  }
  return out
}

/**
 * The `fixtures` command's alternate collection path: capture the same catalog from
 * inside the run-owned container via `Cli` when the published eAPI port is not
 * usable. Motivation (settled 2026-11-07, #62): docker 29.9.2 on this host does not
 * deterministically port-forward to a multi-endpoint cEOS container — front-panel
 * ports REQUIRE extra bridges (#62's whole point), but every multi-attachment probe
 * session on this daemon has been a coin-flip between working TLS and ECONNRESET for
 * reasons outside the harness's control (inspect/direct-route experiments found the
 * live kernel path is the sole Management1 address, yet the published port died even
 * with that endpoint reachable, 405 on direct host:443 vs RST through the forward,
 * stable across restarts and data-NIC detach).
 *
 * This is NOT a trust or guard relaxation: the container identity check (model regex,
 * base-version pin) is re-applied here from the device's own `show version` before
 * anything is written, the same run-owned container/lock/teardown discipline applies,
 * and EVERY fixture envelope states `cliCapture: true` with the eAPI refusal reason
 * and `transport: docker exec Cli …` — reviewers see exactly how bytes were collected.
 * The live test lane (`lab:run`, CI) keeps the strict eAPI path: only the fixtures
 * collector has this fallback, gated by `--capture-via=auto` (default) or `=cli`.
 * @param {ReturnType<typeof labConfig>} cfg
 * @param {NonNullable<ReturnType<typeof readState>>} state
 * @param {{reason?: string}} probeFailure
 */
async function cliFixturesFallback(cfg, state, probeFailure) {
  const raw = cliScriptOpt(state.container, ['show version | json'], 60_000)
  const start = raw.indexOf('{')
  let version
  try {
    version = JSON.parse(raw.slice(start))
  } catch {
    return { exitCode: EXIT.readiness, reason: `Cli capture fallback refused: 'show version | json' produced no JSON (${(raw || '(empty)').slice(0, 200)})` }
  }
  const identity = identityFromShowVersion(version)
  if (!identity.versionVerbatim || !identity.modelName) {
    return { exitCode: EXIT.readiness, reason: `Cli fallback: show version lacked version/modelName (keys: ${Object.keys(version ?? {}).slice(0, 8).join(',')})` }
  }
  const baseOk =
    identity.baseFromVersion === cfg.expectVersion ||
    identity.baseFromInternal === cfg.expectVersion ||
    identity.bareInternal === cfg.expectVersion
  if (!baseOk) {
    refuse(
      `the release reported by the container CLI is base=${JSON.stringify(identity.baseFromVersion ?? identity.baseFromInternal)} ` +
        `(full ${JSON.stringify(identity.versionVerbatim)}), not the pinned ${JSON.stringify(cfg.expectVersion)} — refusing even the CLI path.`,
      EXIT.readiness,
    )
  }
  if (typeof identity.modelName !== 'string' || !/^ceos/i.test(identity.modelName)) {
    refuse(
      `modelName ${JSON.stringify(identity.modelName)} is not a cEOS container model; the CLI fallback only reads the disposable container it started.`,
      EXIT.unsafeTarget,
    )
  }
  const anchor = await readContainerPublicCertWait(state.container, cfg.certWaitSec)
  if (!anchor.pem) {
      return { exitCode: EXIT.readiness, reason: `Cli fallback: no certificate anchor readable inside the container (tried: ${anchor.tried.map((t) => `${t.path} — ${t.reason}`).join('; ')})` }
  }
  log(
    `[fixtures] CLI capture on ${state.container} · model=${identity.modelName} version=${identity.versionVerbatim} · ` +
      `anchor=${anchor.path} fingerprint=${anchor.fingerprint256} (identity guards re-applied from the container's own show version)`,
  )
  const captures = await captureFromCli(state.container)
  const interfacesCapture = await captureFromCliOnce(state.container, 'show interfaces status', 'json')
  const httpCommandsCapture = await captureFromCliOnce(state.container, 'show management api http-commands', 'json')
  const written = writeFixtures(cfg, state, {
    anchor,
    served: { fingerprint256: null, cliFallback: true },
    identity,
    versionJsonCapture: { command: 'show version', format: 'json', ok: true, result: version },
    interfacesJson: interfacesCapture,
    httpCommandsJson: httpCommandsCapture,
    captures,
    cliCapture: true,
    cliCaptureReason: probeFailure.reason ?? 'capture-via=cli selected',
  })
  const out = {
    ok: true,
    runId: state.runId,
    captureTransport: 'cli',
    eapiProbeFailureReason: probeFailure.reason ?? 'skipped (--capture-via=cli)',
    identity,
    modelNote:
      'modelName is what cEOS reports for itself. It is not, and must never be used as, DCS-7050TX-64 / ' +
      '4.28.13.1M hardware evidence (docs/CEOS.md, DR-043).',
    captures,
    fixturesWritten: written,
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
  return { exitCode: EXIT.ok, runId: state.runId, result: out, stage: 'cli-fallback' }
}

/** One-shot json/text CLI capture wrapped probe-style — for the two probe-extra specs. */
async function captureFromCliOnce(container, command, format) {
  try {
    return { command, format, ok: true, result: await runCliCapture(container, command, format) }
  } catch (err) {
    return { command, format, ok: false, error: err?.message ?? String(err) }
  }
}

/* ---------------------------------------------------------------- fixtures */

/**
 * Fixture scrubbing. Three layers, deliberately blunt so a reviewer can see what was
 * removed:
 *  1. credential-shaped text (`username … secret [sha512|5|plain] <value>`, `enable … password
 *     <value>`); the encryption-type keyword is part of the command, so the token that gets
 *     replaced is the one AFTER it — M12c's `show running-config all` capture made that distinction
 *     load-bearing, because the pre-existing pattern stopped at `secret` and would have committed a
 *     real `$6$…` SHA-512 hash (observed 2026-11-06 on this image's own config);
 *  2. this run's **random username**, as an object key and inside strings — observed
 *     2026-11-03: `show management api http-commands` reports per-user stats, so the
 *     lab user's name otherwise lands in every API fixture;
 *  3. any string that looks like a PEM private key (never expected, but a fixture
 *     carrying key material is a security incident, not a typo).
 *
 * The rules run on **object keys too**: `show running-config` in `json` format answers EOS's
 * structured config model, whose `cmds` map is keyed by the whole command line (observed
 * 2026-11-06), so the `username … secret sha512 $6$…` line arrives as a KEY with a null value.
 * Rewritten keys are made unique so a scrub can never silently drop a neighbouring entry.
 * @param {string} text
 * @param {readonly RegExp[]} userPatterns
 */
export function redactCredentialText(text, userPatterns) {
  let out = text
    .replace(/(username[ \t]+\S+[ \t]+(?:privilege[ \t]+\d+[ \t]+)?(?:role[ \t]+\S+[ \t]+)?secret[ \t]+(?:(?:sha512|sha256|md5|plain)[ \t]+|[0-7][ \t]+)?)[^\s]+/gi, '$1<redacted-lab-secret>')
    .replace(/(^[ \t]*enable[ \t]+algorithm[ \t]+\S+[ \t]+password[ \t]+)[^\s]+/gim, '$1<redacted-lab-secret>')
    .replace(/(^[ \t]*enable[ \t]+password[ \t]+)[^\s]+/gim, '$1<redacted-lab-secret>')
    .replace(/(^[ \t]*(?:passphrase|login[ \t]+(?:password|secret))[ \t]+)[^\s]+/gim, '$1<redacted-lab-secret>')
  for (const p of userPatterns) out = out.replace(p, '<redacted-lab-user>')
  if (/-----BEGIN (RSA |EC )?(PRIVATE KEY|ENCRYPTED)/.test(out)) out = '<redacted-private-key-material>'
  return out
}

/**
 * @param {unknown} value
 * @param {string[]} [labUsernames]
 */
function redactCopy(value, labUsernames = []) {
  const userPatterns = labUsernames.filter((u) => u && u.length >= 3).map((u) => new RegExp(escapeRegExp(u), 'g'))
  if (typeof value === 'string') return redactCredentialText(value, userPatterns)
  if (Array.isArray(value)) return value.map((v) => redactCopy(v, labUsernames))
  if (value && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {}
    /** @type {Set<string>} */
    const used = new Set()
    for (const [k, v] of Object.entries(value)) {
      let key = redactCredentialText(k, userPatterns)
      if (used.has(key)) {
        // Only a rewritten key can collide (the device's own map had unique keys), and a collision must
        // never cost an entry: keep both, visibly.
        let n = 1
        while (used.has(`${key} #${String(n)}`)) n += 1
        key = `${key} #${String(n)}`
      }
      used.add(key)
      if (/^(secret|password|passphrase|token|authorization|sshPublic?Key|publicKey|privateKey)$/i.test(key)) {
        out[key] = '<redacted-lab-secret>'
        continue
      }
      // M12c (#14): the catalog grew `show interfaces` and `show port-channel detail`, which carry a
      // MAC **per interface/peer**, not just the three top-level keys M12b zeroed. Rule is key-name
      // AND value-shape, so `learnedMacAddressCount: 0` (a number) is real data and stays, while any
      // MAC-shaped string under a `*mac*` key becomes the documented zero. A container MAC is derived
      // from the Docker IP allocation (docs/CEOS.md redaction list names MACs as identifying).
      if (/mac/i.test(key) && typeof v === 'string' && /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/.test(v)) {
        out[key] = '00:00:00:00:00:00'
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
    // All scrubbing happens in redactCopy (including the MAC rule M12c moved out of this call site,
    // where it only ever reached the top level of the reply). `result` is a fresh copy; the probe's
    // in-memory reply object is untouched.
    const result = redactCopy(spec.result, [state.user])
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
        ...(probe.cliCapture === true
          ? {
              cliCapture: true,
              cliCaptureReason: probe.cliCaptureReason,
              cliCaptureNote:
                'bytes collected with `docker exec <run-owned container> Cli -p 15 … | json` because the published eAPI port was ' +
                'unavailable for this run on this Docker daemon; same EOS agent/parser answers both transports, and the container ' +
                'identity pins (model regex + base version) were re-checked from this CLI reply before any file was written',
            }
          : {}),
        runId: state.runId,
        capturedAt: nowIso(),
        capturedBy: MANAGER,
        endpoint: `${state.hostIp}:${state.port}`,
        transport:
          probe.cliCapture === true
            ? `docker exec Cli -p 15 (enable-mode) inside the run-owned container ${state.container}; eAPI refusal: ${probe.cliCaptureReason ?? 'n/a'}`
            : 'https + HTTP basic auth to the run-owned published loopback port; container-side pinned certificate',
        tlsPinFingerprint256: probe.anchor.fingerprint256,
        bootupTimestamp: probe.identity.bootupTimestamp,
        redactionApplied: [
          'username/secret, enable-password, login-password/login-secret, and passphrase values replaced with <redacted-lab-secret>, including the encryption-type form (`secret sha512 <hash>`, `enable algorithm <algo> password <hash>`) and **object keys**, because `show running-config` in `json` format keys its `cmds` map by the whole command line — the lab `username … secret sha512 $6$…` line is a key there, not a value (observed 2026-11-06)',
          `this run's random lab username replaced with <redacted-lab-user> (API user-stats otherwise leak it)`,
          'every MAC-shaped string under a *mac*-named key zeroed, at any depth (M12c: `show interfaces` / `show port-channel detail` carry a MAC per interface, not only systemMacAddress/hwMacAddress/configMacAddress)',
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
  if (cfg.nodes !== 1) {
    refuse(
      '--nodes=2 writes no fixtures: CAPTURE_CATALOG is the SINGLE-node contract, and a two-node run ' +
        'would silently change interface/neighbor models under every pinned fixture. Two-node reads ' +
        'are review evidence (#154) and land under docs/evidence/, not fixtures/live/.',
      EXIT.usage,
    )
  }
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
    if (cfg.captureVia === 'cli') {
      log('[fixtures] --capture-via=cli — skipping the eAPI probe and capturing through the container CLI (guards re-applied there)')
      outcome = await cliFixturesFallback(owned, state, {})
    } else {
      outcome = await cmdProbe(owned, state)
      if (outcome.exitCode !== EXIT.ok) {
        if (cfg.captureVia === 'auto') {
          log(
            `[fixtures] eAPI probe refused (exit ${String(outcome.exitCode)}${outcome.reason ? `: ${outcome.reason}` : ''}) — ` +
              'falling back to the Cli collector INSIDE the same run-owned container; identity guards re-run there and every ' +
              'fixture envelope records the transport (capture-via=auto)',
          )
          outcome = await cliFixturesFallback(owned, state, { reason: outcome.reason })
        } else {
          log(
            `[fixtures] probe refused (exit ${String(outcome.exitCode)}${outcome.reason ? `: ${outcome.reason}` : ''}) — this path ` +
              'wrote no captures (capture-via=eapi keeps the strict published-eAPI requirement), and there is no fallback target to read them from',
          )
        }
      }
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
  // #154 nodes=2 peer resources — idempotent by design: single-node runs simply report
  // "already absent", and every removal is label-verified against THIS run.
  dropContainer(`${containerName(runId)}-b`, state?.nodesB?.containerId)
  dropNetwork(networkName(runId, 'bmgmt'))
  dropNetwork(networkName(runId, 'peer'))
  dropNetwork(networkName(runId, 'mgmt'))
  dropNetwork(networkName(runId, 'data')) // pre-#62 topologies (idempotent for newer runs)
  dropNetwork(networkName(runId, 'data1'))
  dropNetwork(networkName(runId, 'data2'))

  // Stop the run-owned loopback forwarder BEFORE its state file dies, so the
  // cmdline-verified SIGTERM path wins over the forwarder's state-watch watchdog
  // (which would self-exit within 5s anyway). Idempotent: a recycled pid is skipped.
  if (state?.forwarderPid) stopForwarder(state)
  if (state?.nodesB?.forwarderPid) stopForwarder(state.nodesB)

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
  const cfB = certFilePath(`${runId}-b`)
  if (fs.existsSync(cfB)) {
    fs.rmSync(cfB, { force: true })
    removed.stateFiles.push(path.relative(REPO_ROOT, cfB))
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
    // The names `src/testing/live-guard.ts` actually reads (its accepted-variable list is spelled
    // out in that module's header). Without these the child would be refused by its own consent
    // matrix — EAPI_PORT_NOT_ALLOWED first, then EAPI_ALLOW_VERSION_MISSING, then
    // EAPI_TLS_TRUST_MISSING — so the aliasing belongs HERE, at the seam that owns the run:
    //  - EAPI_ALLOW_PORTS: extended with ONLY the port this run published. That is the documented
    //    shape for a non-default published port (docs/CEOS.md: "Parallel jobs need separate
    //    containers, networks, and published ports"); it never widens the guard toward a switch.
    //  - EAPI_ALLOW_VERSION: the same pinned base the probe already verified over authenticated eAPI.
    //  - EAPI_CA_FILE + EAPI_FINGERPRINT + EAPI_SERVER_NAME: the run's TLS triple, measured from
    //    THIS container's own certificate. The guard refuses an https target with neither CA nor
    //    fingerprint, and `EAPI_INSECURE_TLS` is refused (DR-013). All three are needed because the
    //    cEOS CA-gateway certificate ships **no subjectAltName at all** (executed runs,
    //    2026-11-08: CA alone dies in the client's name check with `Hostname/IP does not match
    //    certificate's altnames: IP: 127.0.0.1 is not in the cert's list` for EVERY live suite),
    //    and this client deliberately does not let a fingerprint pin waive the name check
    //    (`src/transports/node-tls.ts`: "Pinning a key does not waive hostname verification").
    //    With a pin installed the identity host becomes `serverName`, and OpenSSL falls back to a
    //    subject-CN match when there is no SAN — so the pin (exact sha256) plus the CN the harness
    //    read out of the container's own file is strictly stronger than the harness probe's own
    //    posture (chain verify + exact fingerprint compare).
    //  - EAPI_SCRATCH_INTERFACE: exactly one Ethernet port chosen from the interfaces THIS container
    //    reported, so a write-side test never invents one (guard's EAPI_SCRATCH_INTERFACE rule);
    //    the plural list above stays as the observation for humans.
    ...(state.port === 8443 ? {} : { EAPI_ALLOW_PORTS: String(state.port) }),
    EAPI_ALLOW_VERSION: cfg.expectVersion,
    ...(probed.result.tls.anchorPublicCertFile ? { EAPI_CA_FILE: String(probed.result.tls.anchorPublicCertFile) } : {}),
    EAPI_FINGERPRINT: String(probed.result.tls.anchorFingerprint256),
    ...(serverNameFromCertSubject(probed.result.tls.anchorSubject)
      ? { EAPI_SERVER_NAME: serverNameFromCertSubject(probed.result.tls.anchorSubject) }
      : {}),
    ...(scratchInterfaces.split(',')[0] ? { EAPI_SCRATCH_INTERFACE: scratchInterfaces.split(',')[0] } : {}),
    // Endpoint contract (scripts/eapi-port-forward.mjs): since 2026-08 the loopback
    // port is served by the forwarder to the container's mgmt-bridge IP because the
    // WSL2-restart cycle showed Docker's `-p` publish resolving to the wrong endpoint
    // on a multi-attached privileged container. Nothing in EAPI_HOST/EAPI_PORT changes
    // for the child, and TLS pinning is untouched — pure byte relay, and the mgmt
    // address is one this process minted and pinned itself.
    // DR-126 (see cfg.fullWrite): the run-owned container is the declaration. The write-scope seam
    // (`live-session-policy.ts:withLabWriteScope` — listener/users-in-use/management/`copy run start`)
    // stays non-negotiable either way; `EAPI_LAB_FULL_WRITE=1` narrows nothing, it only lets the
    // suites past the scratch-ONLY gate for genuinely-spare objects.
    ...(cfg.fullWrite ? { EAPI_LAB_FULL_WRITE: '1' } : {}),
    // #154 nodes=2: the peer endpoint, same trust triple shape as the primary (own cert
    // anchor, own loopback forwarder). Suits that don't know the peer ignore these; the
    // two-node suite refuses to run without them, so a single-node live run can never
    // half-execute the adjacency assertions by accident.
    ...(state.nodesB
      ? {
          EAPI_PEER_HOST: cfg.hostIp,
          EAPI_PEER_PORT: String(state.nodesB.port),
          EAPI_PEER_USER: state.user,
          EAPI_PEER_PASS: state.secret,
          EAPI_PEER_CA_FILE: String(state.nodesB.certFile),
          EAPI_PEER_FINGERPRINT: String(state.nodesB.anchorFingerprint256),
          ...(serverNameFromCertSubject(state.nodesB.anchorSubject)
            ? { EAPI_PEER_SERVER_NAME: serverNameFromCertSubject(state.nodesB.anchorSubject) }
            : {}),
        }
      : {}),
    // The run's declared spare VLAN for the `requireScratchVlan` gate (`live-guard.ts`): outside the
    // provisioned 10/100/110, outside EOS's reserved 1006-1199, and outside the >=2000 block the
    // SVI-owning suites (varp/ipinterfaces/vrrp) create per-case. Guard still validates the value.
    EAPI_SCRATCH_VLAN: '1201',
    // #87 --vrrp: the shared-L2 VRRP pair the harness provisioned, exported so the failover
    // lane asserts against the topology it was handed instead of re-inventing literals.
    ...(cfg.vrrp
      ? {
          EAPI_VRRP_VLAN: String(VRRP_LINK.vlan),
          EAPI_VRRP_VIP: VRRP_LINK.vip,
          EAPI_VRRP_VRID: String(VRRP_LINK.vrid),
          EAPI_VRRP_A_IP: VRRP_LINK.aIp,
          EAPI_VRRP_B_IP: VRRP_LINK.bIp,
          EAPI_VRRP_A_PRIORITY: String(VRRP_LINK.aPriority),
          EAPI_VRRP_B_PRIORITY: String(VRRP_LINK.bPriority),
        }
      : {}),
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
  return ['fixtures', 'no-fixtures', 'fixtures-force', 'yes', 'all', 'list', 'quiet', 'help', 'no-digest', 'no-full-write', 'vrrp'].includes(name)
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
    frontPanelTimeoutSec: int('front-panel-timeout', DEFAULTS.frontPanelTimeoutSec),
    certWaitSec: int('cert-wait', DEFAULTS.certWaitSec),
    requestTimeoutMs: int('request-timeout', DEFAULTS.requestTimeoutMs),
    retryDelayMs: int('retry-delay', DEFAULTS.retryDelayMs),
    port: flags['port'] === undefined || flags['port'] === true ? null : Number(flags['port']),
    runId: typeof flags['run'] === 'string' ? flags['run'] : undefined,
    // #154: `--nodes 2` adds the back-to-back peer for OSPF adjacency + blast evidence.
    // Validated to 1|2 only — a typo must never silently halve topology.
    nodes: (() => {
      if (flags['nodes'] === true) refuse('--nodes needs a value: 1 or 2', EXIT.usage)
      const n = int('nodes', 1)
      if (n !== 1 && n !== 2) refuse(`--nodes supports 1 or 2, got ${String(n)}`, EXIT.usage)
      return n
    })(),
    /**
     * #87 VRRP failover lane: `--vrrp` repurposes the nodes=2 peer wire as a SHARED L2
     * segment — both nodes' peer NICs become Vlan200 access ports and a VRRP pair (A
     * master 150 / B backup 100, one VIP) lives on the SVI. It is meaningless without a
     * second node (a lone VRRP group is always MASTER), so it requires `--nodes 2` and
     * refuses otherwise — a typo must never silently build a single-node "failover" run
     * that can only ever observe one master.
     */
    vrrp: flags['vrrp'] === true,
    fixtureDir: flags['fixtures'] === false || flags['no-fixtures'] === true ? null : str('fixtures', FIXTURE_DIR),
    /**
     * DR-126 full-write lab lane: `lab:run` against a run-owned disposable container **is** the
     * operator declaration the consent flag stands for (locked user decision 2026-11-07: the
     * `test/system/*` port writes fully against cEOS — users, VLANs, routes, protocols — and the
     * container is thrown away). `--no-full-write` opts this run back to scratch-only: the flag is
     * simply not exported, and every full-write suite skips loudly instead. Same opt-in direction as
     * everything else here: the strict path stays the default when asked for explicitly.
     */
    fullWrite: flags['no-full-write'] !== true,
    fixturesForce: flags['fixtures-force'] === true,
    // The explicit confirmation the `fixtures` command requires before it may replace reviewed
    // captures. Nothing else reads it: `up`/`probe`/`run` keep their existing semantics.
    refreshConfirmed: flags['yes'] === true,
    // CI-collected logs must not contain the one-time credential print (docs/CEOS.md: archive only
    // redacted diagnostics). Default stays false so the operator recipe keeps printing.
    quiet: flags['quiet'] === true,
    captureVia: str('capture-via', DEFAULTS.captureVia),
    /**
     * #142: deterministic mgmt-band selection for CI (docs/CEOS.md §Browser E2E and CI plan item 5,
     * blocker 2). `--band <prefix[,prefix]>` wins over `CEOS_LAB_MGMT_BAND`; both accept 1-3 dotted
     * octets per pin and refuse typos. Undefined = the unpinned default candidate order.
     */
    mgmtBand:
      typeof flags['band'] === 'string'
        ? flags['band']
        : typeof process.env.CEOS_LAB_MGMT_BAND === 'string' && process.env.CEOS_LAB_MGMT_BAND.trim() !== ''
          ? process.env.CEOS_LAB_MGMT_BAND.trim()
          : undefined,
  }
  if (!['auto', 'eapi', 'cli'].includes(cfg.captureVia)) {
    refuse(`--capture-via must be auto, eapi, or cli, got ${JSON.stringify(cfg.captureVia)}`, EXIT.usage)
  }
  if (cfg.vrrp && cfg.nodes !== 2) {
    refuse('--vrrp builds a shared-L2 VRRP pair and is meaningless on one node (a lone group is always MASTER); pass --nodes 2 with --vrrp', EXIT.usage)
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
          --nodes 2 adds a second labelled container wired back-to-back to the first
          (#154: OSPF adjacency + blast evidence; its endpoint reaches child suites as
          EAPI_PEER_*). The fixtures command refuses --nodes 2 — captures stay single-node.
          --vrrp (needs --nodes 2) repurposes the peer wire as a SHARED L2 segment and
          provisions a VRRP pair on Vlan200 (A master 150 / B backup 100, VIP
          10.0.200.254) for the #87 failover-blast lane; the topology reaches child
          suites as EAPI_VRRP_*. The OSPF adjacency does not form on this shape (the
          transit is L2, not the routed /30) — run --nodes 2 without --vrrp for OSPF.
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
  --front-panel-timeout <sec>  bounded wait for front-panel Ethernet ports after start, default ${DEFAULTS.frontPanelTimeoutSec}
  --cert-wait <sec>            bounded wait for the eAPI certificate anchor to appear in /persist, default ${DEFAULTS.certWaitSec}
  --timeout <sec>              bounded eAPI readiness wait, default ${DEFAULTS.probeTimeoutSec}
  --request-timeout <ms>       per-request deadline, default ${DEFAULTS.requestTimeoutMs}
  --retry-delay <ms>           delay between attempts, default ${DEFAULTS.retryDelayMs}
  --run <id>                   act on an existing run id
  --fixtures <dir>             write probe captures to a fixture dir (default ${path.relative(REPO_ROOT, FIXTURE_DIR)})
  --no-fixtures                never write fixtures
  --no-full-write              (run) do NOT pass the DR-126 EAPI_LAB_FULL_WRITE consent to the live
                               child: full-write test/system suites skip loudly, scratch-only stays
  --fixtures-force             allow overwriting existing fixture files
  --yes                        required by the fixtures command: confirms replacing reviewed captures
  --capture-via <auto|eapi|cli>
                               fixtures command: how the catalog is collected. auto (default) = published
                               eAPI first, and only when that probe refuses for endpoint/reachability reasons,
                               re-run the catalog through 'docker exec Cli' inside the same run-owned container
                               (model/version guards re-applied; every envelope records cliCapture + reason).
                               eapi = strict (no fallback). cli = skip the eAPI probe and capture via Cli directly.
  --quiet                      suppress the one-time credential print (CI logs; the 0600 state file
                               remains the only copy and teardown deletes it)
  --band <prefix[,prefix]>     pin the mgmt bridge to dotted-prefix band(s) (1-3 octets each, e.g.
                               10.177). CI default via CEOS_LAB_MGMT_BAND; #142's band-determinism
                               blocker — route verification alone cannot see WSL2/HNS ARP poisoning,
                               so a CI dispatch pins the band known uncontested on its runner.
                               Read-only preview without creating anything: npm run lab:mgmt-bands
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
    case 'mgmt-bands': {
      // Read-only operator/CI aid (#142): print what the band pin selects, create nothing. Runs
      // only `docker network ls`/`ip` reads inside mgmtSubnetCandidates — no container, no network.
      const pin = cfg.mgmtBand
      const bands = mgmtSubnetCandidates(pin)
      process.stdout.write(
        `${JSON.stringify(
          {
            pin: pin ?? 'auto',
            totalFreeCandidates: bands.length,
            firstTen: bands.slice(0, 10).map((c) => c.cidr),
            note: 'candidates exclude every subnet a live docker network, host route, or interface address already holds',
          },
          null,
          2,
        )}\n`,
      )
      return { exitCode: EXIT.ok }
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outcome = await main(process.argv.slice(2)).catch((err) => {
    reportError(err, 'ceos-lab')
    return { exitCode: err instanceof LabError ? err.code : EXIT.internal }
  })
  process.exitCode = outcome?.exitCode ?? EXIT.internal
}
