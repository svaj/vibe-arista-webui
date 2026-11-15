#!/usr/bin/env node
/**
 * M13 / #91 — child supervisor for the opt-in browser E2E lane.
 *
 * Invoked ONLY as the `lab:run` child (its finally path owns container teardown, DR-043):
 *   npm run e2e -w arista-webui
 *   → node ../scripts/ceos-lab.mjs run --quiet --no-fixtures -- node ../scripts/e2e-run.mjs
 *
 * It owns the dev-server half and NOTHING else: validate the lab contract (refuse anything
 * but a loopback lab target — never the physical switch), run the pinned TLS/identity preflight
 * with scripts/ceos-lab-eapi-child.mjs, start four vite dev servers covering the four
 * browser-observable truth states, then run Playwright and always stop the servers:
 *
 *   :5173 connected    EAPI_HOST=<lab endpoint> + real lab creds  (creds live in THIS process
 *                      tree only; createEapiProxy injects Basic auth server-side, so the
 *                      browser's /command-api traffic carries no secret — the F8 artifact rule)
 *   :5174 unconfigured EAPI_* absent → __EAPI_PROXY_CONFIGURED__ false → honest prompt arm
 *   :5175 unreachable  proxy target = closed loopback port → real connection failure
 *   :5176 bad-auth     proxy creds = the guard's own placeholder pair → a real 401 from cEOS
 *
 * Dependency-free like the other scripts/*.mjs (node: builtins only). Exit codes:
 *   0 pass · 2 contract refusal (no device will be touched) · 6 vite failed to boot ·
 *   otherwise the Playwright exit code.
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const webui = path.join(root, 'arista-webui')

const PORTS = { connected: 5173, unconfigured: 5174, unreachable: 5175, badauth: 5176 }
const READY_BUDGET_MS = 120_000

/** Never printed, never written: stripped out of any captured child output before we echo it. */
const secretsToRedact = [process.env['EAPI_PASS'], process.env['EAPI_USER']]
  .filter((v) => typeof v === 'string' && v !== '' && v !== 'never-sent')

function redact(text) {
  let out = text
  for (const secret of secretsToRedact) out = out.split(secret).join('<redacted-lab-user-or-secret>')
  return out
}

function refuse(message, code = 2) {
  process.stderr.write(`e2e-run: REFUSED — ${message}\n`)
  process.exit(code)
}

// ── contract gate (mirrors scripts/ceos-lab-eapi-child.mjs refusals) ─────────────────────
if (process.env['EAPI_LIVE'] !== '1') refuse('EAPI_LIVE is not 1 — the E2E lane is opt-in via `npm run e2e`, never directly')
if (process.env['EAPI_TARGET_CLASS'] !== 'lab') refuse(`EAPI_TARGET_CLASS must be 'lab' (got ${JSON.stringify(process.env['EAPI_TARGET_CLASS'])}) — browser E2E against the physical switch is forbidden (DR-043)`)
const host = process.env['EAPI_HOST'] ?? ''
if (!['127.0.0.1', 'localhost', '::1'].includes(host)) refuse(`EAPI_HOST must be loopback for the lab class (got ${JSON.stringify(host)})`)
for (const name of ['EAPI_PORT', 'EAPI_USER', 'EAPI_PASS']) {
  if (process.env[name] === undefined || process.env[name] === '') refuse(`${name} is not set — expected from \`scripts/ceos-lab.mjs run\``)
}
const labEndpoint = `${host}:${process.env['EAPI_PORT']}`

// ── vite spawn helpers ───────────────────────────────────────────────────────────────────
const children = []
/** @returns {{ proc: import('node:child_process').ChildProcess, log: () => string }} */
function startVite(name, port, eapi) {
  let log = ''
  const proc = spawn(path.join(root, 'node_modules', '.bin', 'vite'), ['--port', String(port), '--strictPort'], {
    cwd: webui,
    env: { ...withoutEapi(process.env), ...eapi },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const capture = (chunk) => { log = (log + chunk.toString()).slice(-64 * 1024) }
  proc.stdout.on('data', capture)
  proc.stderr.on('data', capture)
  children.push({ name, proc })
  return { proc, log: () => log }
}

function withoutEapi(env) {
  const out = { ...env }
  delete out['EAPI_HOST']
  delete out['EAPI_USER']
  delete out['EAPI_PASS']
  return out
}

const PLACEHOLDER_USER = 'never-sent'
const PLACEHOLDER_PASS = 'replace-with-a-lab-only-password'
const servers = {
  connected: startVite('connected', PORTS.connected, { EAPI_HOST: labEndpoint, EAPI_USER: process.env['EAPI_USER'], EAPI_PASS: process.env['EAPI_PASS'] }),
  unconfigured: startVite('unconfigured', PORTS.unconfigured, {}),
  unreachable: startVite('unreachable', PORTS.unreachable, { EAPI_HOST: '127.0.0.1:1', EAPI_USER: process.env['EAPI_USER'], EAPI_PASS: process.env['EAPI_PASS'] }),
  badauth: startVite('badauth', PORTS.badauth, { EAPI_HOST: labEndpoint, EAPI_USER: PLACEHOLDER_USER, EAPI_PASS: PLACEHOLDER_PASS }),
}

const dead = new Set()
for (const { name, proc } of children) proc.on('exit', (code) => dead.add(`${name} (exit ${String(code)})`))

async function waitForVite(name, port, entry) {
  const deadline = Date.now() + READY_BUDGET_MS
  while (Date.now() < deadline) {
    if (dead.size > 0) {
      for (const [serverName, server] of Object.entries(servers)) {
        if (server.proc.exitCode !== null) process.stderr.write(`e2e-run: vite ${serverName} output:\n${redact(server.log())}\n`)
      }
      refuse(`dev server(s) died before readiness: ${[...dead].join(', ')} — port likely contested (lane owns 5173-5176)`, 6)
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`)
      if (response.ok) return
    } catch { /* not up yet */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
  }
  process.stderr.write(`e2e-run: ${name} (:${port}) log tail:\n${redact(entry.log()).slice(-4000)}\n`)
  refuse(`${name} dev server never became ready within ${READY_BUDGET_MS} ms`, 6)
}

function stopAll() {
  for (const { proc } of children) {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM')
  }
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => { stopAll(); process.exit(130) })
}

// ── run ──────────────────────────────────────────────────────────────────────────────────
try {
  // TLS-pinned identity preflight FIRST: reuse the contract proof from the API live lane so
  // "connected" can only ever mean pinned-https to the 4.28.14M cEOS we created (docs/CEOS.md
  // item 2 "validate trusted upstream TLS"). It exits non-zero on any identity/trust refusal.
  await new Promise((resolvePromise, rejectPromise) => {
    const preflight = spawn(process.execPath, [path.join(here, 'ceos-lab-eapi-child.mjs')], { cwd: root, stdio: 'inherit' })
    preflight.on('exit', (code) => (code === 0 ? resolvePromise() : rejectPromise(new Error(`TLS/identity preflight refused (exit ${String(code)})`))))
    preflight.on('error', rejectPromise)
  })

  await waitForVite('connected', PORTS.connected, servers.connected)
  await waitForVite('unconfigured', PORTS.unconfigured, servers.unconfigured)
  await waitForVite('unreachable', PORTS.unreachable, servers.unreachable)
  await waitForVite('bad-auth', PORTS.badauth, servers.badauth)

  const exitCode = await new Promise((resolvePromise, rejectPromise) => {
    const playwright = spawn(path.join(root, 'node_modules', '.bin', 'playwright'), ['test', '--config', 'playwright.config.ts'], {
      cwd: webui,
      stdio: 'inherit',
      env: {
        ...withoutEapi(process.env),
        E2E_BASE_URL: `http://127.0.0.1:${PORTS.connected}`,
        E2E_UNCONFIGURED_URL: `http://127.0.0.1:${PORTS.unconfigured}`,
        E2E_UNREACHABLE_URL: `http://127.0.0.1:${PORTS.unreachable}`,
        E2E_BADAUTH_URL: `http://127.0.0.1:${PORTS.badauth}`,
      },
    })
    playwright.on('exit', (code, signal) => resolvePromise(signal ? 128 : code ?? 1))
    playwright.on('error', rejectPromise)
  })
  process.exitCode = exitCode
} catch (error) {
  refuse(String(error instanceof Error ? error.message : error), process.exitCode === 0 ? 1 : Number(process.exitCode))
} finally {
  stopAll()
}
