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

/** @param {ReturnType<typeof labConfig>} cfg */
/**
 * Pick a free private /24 under 172.31.16.0–172.31.255.0 for the run's mgmt bridge.
 * The mgmt network MUST carry a pinned static subnet because the published-port path
 * leans on a deterministically-addressed PRIMARY endpoint (see the NIC-topology note
 * in `cmdUp` and DR-034's exact-endpoint rule). Existing networks are read once and
 * the scan starts at a random octet so racing workers do not pick the same first
 * candidate. IPv6 ipam entries and link-local noise are ignored.
 * @returns {{ octetBase: string, cidr: string }}
 */
function pickMgmtSubnet() {
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
  const start = crypto.randomInt(16, 256)
  for (let k = 0; k < 240; k++) {
    const o = 16 + ((start + k) % 240)
    const cand = [172, 31, o, 0]
    if (!used.some((u) => overlaps(cand, 24, u.addr, u.plen))) return { octetBase: `172.31.${o}`, cidr: `172.31.${o}.0/24` }
  }
  refuse('no free 172.31.16-255.0/24 subnet for the lab mgmt bridge — clean up stale Docker networks before retrying', EXIT.internal)
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
    const mgmtSubnet = pickMgmtSubnet()
    const mgmtIp = `${mgmtSubnet.octetBase}.10`
    for (const net of [names.mgmt, names.data1, names.data2]) {
      const netArgs = ['network', 'create', `--label=${LABEL_RUN}=${runId}`, `--label=${LABEL_MANAGER}=${MANAGER}`]
      if (net === names.mgmt) netArgs.push(`--subnet=${mgmtSubnet.cidr}`)
      netArgs.push(net)
      docker(netArgs)
    }
    log(`[up] mgmt network pinned to ${mgmtSubnet.cidr} (container ${mgmtIp}); data nets carry the front-panel NICs`)
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
      `--network=${names.mgmt}`,
      `--ip=${mgmtIp}`,
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
    // endpoint for the port-forward resolution (topology note above).
    for (const net of [names.data1, names.data2]) {
      docker(['network', 'connect', net, names.container])
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

    // Issue #62: the captures the UI screens need only answer in the configured shape,
    // so `up` now provisions that shape before anything is read. A refusal here lands in
    // the catch below: teardown runs, no probe is taken, no half-configured capture set exists.
    const provisionStart = Date.now()
    const provision = provisionLab(names.container, frontPanels[0], frontPanels[1])
    const provisionMs = Date.now() - provisionStart
    if (!provision.ok) {
      const detail =
        provision.stage === 'verification'
          ? `show vlan after commit is missing VLAN(s) ${provision.missingVlans.join(', ')} — the commit transcript said more than the device did`
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

    const state = {
      runId,
      schema: 3,
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
      versionJson,
      interfacesJson,
      httpCommandsJson,
    }
    writeState(state)
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          runId,
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

/**
 * The staging lines, in apply order, aimed at the OBSERVED front-panel ports.
 * Indentation mirrors the CLI's sub-mode style used by `bootstrapLab`, so the
 * transcript is readable to a reviewer.
 * @param {string} ethA @param {string} ethB
 */
function provisionStaging(ethA, ethB) {
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
  // Routing + a static next hop so `show ip route` / `show ip interface brief` answer as configured.
  'ip routing',
  'ip route 10.20.0.0/24 10.0.100.2',
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
function provisionLab(container, ethA, ethB) {
  const stagingInput = [`configure session ${PROVISION_SESSION}`, ...provisionStaging(ethA, ethB)]
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
  const missingVlans = ['10', '100', '110'].filter((v) => !present.includes(v))
  if (missingVlans.length > 0) {
    return { ok: false, stage: 'verification', errors, fatal: [], staged: staged + '\n' + committed, aborted: '', missingVlans }
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
      `forwarder: ${forwarderStatus}`,
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
  { command: 'show spanning-tree', format: 'json', id: 'ceos-lab-capability', note: 'the provisioner touches MST priority 0 + portfast/bpduguard on Eth1 (bare global `spanning-tree` answers `% Incomplete command` on this image — probed 2026-11-07); feeds B3 (#88) and S15 (#85)' },
  {
    command: 'show spanning-tree detail',
    format: 'json',
    id: 'ceos-lab-capability',
    note: '#62 asks for detail "if accepted" — acceptance is exactly what is unknown, so a 1002 here is a recorded negative, not a skipped file',
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
  { command: 'show ip route', format: 'json', id: 'ceos-lab-capability', note: 'populated by the provisioned SVI connected routes + the provisioned static route; prerequisite of S10 (#80). cEOS-lab refused `ip routing` outright (tolerated probe), so this capture documents what the routing table answers with routing globally unavailable — the `ip routing` verdict on the hardware stays #14 §3' },
  { command: 'show vrrp', format: 'json', id: 'ceos-lab-capability', note: 'probed: VRRP config was refused on cEOS-lab 4.28.14M and the read answers nothing usable — record as a negative result (never a file), with the staging transcript as the capability evidence' },
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
 *     <value>`, `login`/`passphrase`); the encryption-type keyword is part of the command, so the
 *     token that gets replaced is the one AFTER it — M12c's `show running-config all` capture made
 *     that distinction load-bearing, because the pre-existing pattern stopped at `secret` and would
 *     have committed a real `$6$…` SHA-512 hash (observed 2026-11-06 on this image's own config);
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
function redactCredentialText(text, userPatterns) {
  let out = text
    .replace(/(username\s+\S+\s+(?:privilege\s+\d+\s+)?(?:role\s+\S+\s+)?secret\s+(?:(?:sha512|sha256|md5|plain)\s+|[0-7]\s+)?)[^\s]+/gi, '$1<redacted-lab-secret>')
    .replace(/(enable\s+algorithm\s+\S+\s+password\s+)[^\s]+/gi, '$1<redacted-lab-secret>')
    .replace(/(enable\s+password\s+)[^\s]+/gi, '$1<redacted-lab-secret>')
    .replace(/(username\s+\S+\s+secret\s+)[^\s]+/gi, '$1<redacted-lab-secret>')
    .replace(/((?:enable|login|passphrase)\s+)(?:\S+)/gi, '$1<redacted-lab-secret>')
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
          'username/secret and enable/passphrase text replaced with <redacted-lab-secret>, including the encryption-type form (`secret sha512 <hash>`, `enable algorithm <algo> password <hash>`) and **object keys**, because `show running-config` in `json` format keys its `cmds` map by the whole command line — the lab `username … secret sha512 $6$…` line is a key there, not a value (observed 2026-11-06)',
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
  dropNetwork(networkName(runId, 'mgmt'))
  dropNetwork(networkName(runId, 'data')) // pre-#62 topologies (idempotent for newer runs)
  dropNetwork(networkName(runId, 'data1'))
  dropNetwork(networkName(runId, 'data2'))

  // Stop the run-owned loopback forwarder BEFORE its state file dies, so the
  // cmdline-verified SIGTERM path wins over the forwarder's state-watch watchdog
  // (which would self-exit within 5s anyway). Idempotent: a recycled pid is skipped.
  if (state?.forwarderPid) stopForwarder(state)

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
    // The run's declared spare VLAN for the `requireScratchVlan` gate (`live-guard.ts`): outside the
    // provisioned 10/100/110, outside EOS's reserved 1006-1199, and outside the >=2000 block the
    // SVI-owning suites (varp/ipinterfaces/vrrp) create per-case. Guard still validates the value.
    EAPI_SCRATCH_VLAN: '1201',
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
  return ['fixtures', 'no-fixtures', 'fixtures-force', 'yes', 'all', 'list', 'quiet', 'help', 'no-digest', 'no-full-write'].includes(name)
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
  }
  if (!['auto', 'eapi', 'cli'].includes(cfg.captureVia)) {
    refuse(`--capture-via must be auto, eapi, or cli, got ${JSON.stringify(cfg.captureVia)}`, EXIT.usage)
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
