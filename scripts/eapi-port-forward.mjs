#!/usr/bin/env node
// @ts-check
/**
 * Run-owned loopback TCP forwarder for the cEOS-lab lane (docs/CEOS.md).
 *
 * Why this exists (observed 2026-08 WSL2 restart, Docker 29.9.2 / kernel
 * 6.18.33.2-microsoft-standard-WSL2): for a container attached to several user-
 * defined networks, Docker's `-p 127.0.0.1:<port>:443` publish resolved its
 * `docker-proxy` target to the alphabetically-first network's endpoint — the run's
 * `data1` bridge — instead of the pinned management endpoint. cEOS owns the data
 * NICs as front-panel Ethernet ports with no eAPI listener behind them, so every
 * handshake on the published port died at that hop (`read ECONNRESET` with
 * `show management api http-commands` reporting `Hits: 0, Bytes in: 0`), while a
 * direct connect from the host to the mgmt-bridge IP answered normally. Docker's
 * CLI has no way to qualify `-p` with the container-side IP, so the harness
 * publishes nothing through Docker and runs this tiny forwarder instead:
 * `listen-ip:listen-port -> target-ip:target-port`, exactly the endpoint contract
 * `probe`/live children already dial.
 *
 * Safety:
 *  - Pure byte relay — no TLS termination, inspection, or downgrade peer is
 *    introduced; the certificate the child pins via `EAPI_CA_FILE` is the
 *    container's own, byte-for-byte (DR-013 stays enforceable end-to-end).
 *  - The listen socket is refused unless `--listen` is a literal loopback
 *    address; `--target` is required and never defaults. The process serves one
 *    lab run: it dies when the run's state file disappears, on failure to listen
 *    (another proxy already holds the endpoint), or past `--max-life` (default
 *    3h) so an orphaned forwarder can never outlive its run.
 *
 * usage: node scripts/eapi-port-forward.mjs --target-ip <mgmt-ip> --target-port <n>
 *        [--listen 127.0.0.1] [--port <n>] [--state-file <path>]
 *        [--max-life-minutes <n>] [--idle-timeout-minutes <n>]
 *
 * Exit codes: 0 clean stop · 1 runtime failure (already-listening, no free port,
 * state file vanished mid-life, max/idle limit reached). `ceos-lab.mjs` treats a
 * dead forwarder exactly like a dead lab: the next probe fails, teardown cleans.
 */

import net from 'node:net'
import fs from 'node:fs'
import process from 'node:process'

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string | true>} */
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const body = a.slice(2)
    const eq = body.indexOf('=')
    if (eq >= 0) {
      flags[body.slice(0, eq)] = body.slice(eq + 1)
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      flags[body] = argv[i + 1]
      i += 1
    } else {
      flags[body] = true
    }
  }
  return flags
}

const flags = parseArgs(process.argv.slice(2))

/** @param {string} name @param {string | undefined} dflt */
function str(name, dflt) {
  const v = flags[name]
  if (v === undefined || v === true) return dflt
  return String(v)
}

/** @param {string} name @param {number} dflt */
function num(name, dflt) {
  const v = str(name, undefined)
  if (v === undefined) return dflt
  const n = Number(v)
  if (!Number.isFinite(n)) {
    process.stderr.write(`eapi-port-forward: --${name} is not a number: ${JSON.stringify(v)}\n`)
    process.exit(1)
  }
  return n
}

const LISTEN_IP = str('listen', '127.0.0.1')
const TARGET_IP = str('target-ip', undefined)
const LISTEN_PORT = num('port', 0)
const TARGET_PORT = num('target-port', 0)
const STATE_FILE = str('state-file', undefined)
const MAX_LIFE_MS = num('max-life-minutes', 180) * 60_000
const IDLE_MS = num('idle-timeout-minutes', 60) * 60_000

/** Literal IPv4 loopback check: the forwarder must never bind a reachable NIC (docs/CEOS.md security boundary). */
function isLoopbackV4(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip ?? '')
  return !!m && Number(m[1]) === 127 && m.slice(2).every((o) => Number(o) <= 255)
}

if (!isLoopbackV4(LISTEN_IP)) {
  process.stderr.write(`eapi-port-forward: refusing --listen ${JSON.stringify(LISTEN_IP)}: only 127.0.0.0/8 literals are accepted\n`)
  process.exit(1)
}
if (!TARGET_IP || TARGET_PORT <= 0 || LISTEN_PORT <= 0) {
  process.stderr.write('eapi-port-forward: --target-ip, --target-port and --port are required (no defaults)\n')
  process.exit(1)
}

const startedAt = Date.now()
let streamCount = 0
/** Rate-limited upstream diagnostics: first failure per kind, then every 10th. */
const upstreamErrors = new Map()
/** @param {string} kind @param {Error & {code?: string}} err */
function reportUpstream(kind, err) {
  const key = `${kind}:${err.code ?? err.message}`
  const n = (upstreamErrors.get(key) ?? 0) + 1
  upstreamErrors.set(key, n)
  if (n === 1 || n % 10 === 0) {
    process.stderr.write(
      `eapi-port-forward: upstream ${kind} ${TARGET_IP}:${TARGET_PORT} — ${err.code ?? err.message} (#${n})\n`,
    )
  }
}
/** @type {Array<[net.Socket, net.Socket]>} */
const pairs = []

/** @param {string} why */
function stopAll(why) {
  for (const [client, upstream] of pairs) {
    client.destroy()
    upstream.destroy()
  }
  server.close()
  process.stdout.write(`eapi-port-forward: closing (${why} after ${Math.round((Date.now() - startedAt) / 1000)}s)\n`)
  process.exit(0)
}

const server = net.createServer((client) => {
  const upstream = net.connect({ host: TARGET_IP, port: TARGET_PORT })
  pairs.push([client, upstream])
  streamCount += 1
  upstream.on('connect', () => {
    // Only wire the relay once the upstream is actually established: the client's
    // bytes buffer until then.
    client.pipe(upstream)
    upstream.pipe(client)
  })
  const drop = () => {
    client.destroy()
    upstream.destroy()
    const i = pairs.findIndex(([c]) => c === client)
    if (i >= 0) pairs.splice(i, 1)
  }
  client.on('error', drop)
  upstream.on('error', (err) => {
    reportUpstream('error', /** @type {Error & {code?: string}} */ (err))
    drop()
  })
  client.on('close', drop)
  upstream.on('close', (hadError) => {
    if (!hadError) reportUpstream('close-before-client-got-bytes', Object.assign(new Error('upstream closed'), { code: undefined }))
    drop()
  })
})

server.on('error', (err) => {
  process.stderr.write(`eapi-port-forward: listen ${LISTEN_IP}:${LISTEN_PORT} failed: ${err.message}\n`)
  process.exit(1)
})

server.listen(LISTEN_PORT, LISTEN_IP, () => {
  // The harness reads this exact line from the ready pipe before proceeding to probe.
  process.stdout.write(`eapi-port-forward: listening ${LISTEN_IP}:${LISTEN_PORT} -> ${TARGET_IP}:${TARGET_PORT}\n`)
})

// Ownership self-extinguishers. `--state-file` is the lab run's own state file:
// deleting it IS teardown, so the forwarder must not outlive it. The max-life and
// no-activity guards bound an operator who Ctrl-C'd the harness (SIGINT is
// already covered because the `up` catch path tears the run down; orphaned
// leftovers get cleaned on the next `lab:up` for the same port).
let lastActivity = Date.now()
server.on('connection', () => {
  lastActivity = Date.now()
})
const watchdog = setInterval(() => {
  const now = Date.now()
  if (STATE_FILE && !fs.existsSync(STATE_FILE)) stopAll('run state file removed')
  if (now - startedAt > MAX_LIFE_MS) stopAll('max-life reached')
  if (now - lastActivity > IDLE_MS) stopAll(`${IDLE_MS / 60_000}m without activity`)
}, 5_000)
watchdog.unref()
process.on('SIGTERM', () => stopAll('SIGTERM'))
process.on('SIGINT', () => stopAll('SIGINT'))
