#!/usr/bin/env node
/**
 * Dependency-free smoke test for the BUILT `dist/` of `@devhax-heavy-industries/arista-eapi`.
 *
 * Why it exists: `engines.node >= 20` (DR-021) is a claim about the shipped runtime artifact, not
 * about the dev toolchain — and the toolchain cannot prove it here, because vitest 5.0.5
 * (`^22.12.0 || ^24.0.0 || >=26.0.0`) and jsdom 30 (`^22.22.2 || ^24.15.0 || >=26.0.0`) refuse Node
 * 20 outright. The `.github/workflows/ci.yml` matrix note records exactly that, and reserves this
 * lane: "prove it in M12 (#14) by running the built dist/ under Node 20 with a dependency-free
 * smoke script rather than by running the dev tooling there." So CI runs this as
 * `npm run build && node scripts/dist-smoke.mjs` on `node-version: 20` and nothing else — if `dist/`
 * uses a syntax feature or builtin newer than the floor, or a build chunk dangles, that job is where
 * it fails.
 *
 * It never touches a device or the network: every outbound primitive it can reach (`fetch`,
 * `http.request`, `https.request`) is replaced by a throwing tripwire BEFORE the package is imported,
 * and the only construction performed is factory-level — M2's rule is that a `Node` connects on the
 * first `await`, and nothing here awaits a device-facing verb. No profile file is read, so the
 * process never inherits an operator endpoint either.
 *
 * Exit codes: 0 all checks passed · 1 a check failed · 2 `dist/` is missing or unusable
 * (run `npm run build` first).
 *
 * Style note: plain Node ESM with **no imports from node_modules on purpose** — the leg deliberately
 * has zero devDependencies in play, so the only thing under test is the published artifact.
 */

import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..')
const PKG_DIR = path.join(REPO_ROOT, 'arista-api-client')
const DIST_DIR = path.join(PKG_DIR, 'dist')

const failures = []
const notes = []

/** @param {string} name @param {() => void} fn */
function check(name, fn) {
  try {
    fn()
    process.stdout.write(`  ok   ${name}\n`)
  } catch (err) {
    failures.push(name)
    process.stdout.write(`  FAIL ${name}\n       ${String(/** @type {Error} */ (err)?.message ?? err)}\n`)
  }
}

/** @param {unknown} condition @param {string} message */
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** @param {string} name @param {any} value */
function assertFunction(name, value) {
  assert(typeof value === 'function', `${name} is not a function (got ${typeof value})`)
}

/* ------------------------------------------------------- 0. the floor itself */

const [nodeMajor] = process.versions.node.split('.').map((part) => Number(part))
const floorFromEngines = (() => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'))
  const engines = /** @type {string | undefined} */ (pkg?.engines?.node)
  const match = />=(\d+)/.exec(engines ?? '')
  assert(engines !== undefined && match !== undefined, `package.json engines.node is missing or unreadable (got ${JSON.stringify(engines)})`)
  return Number(match?.[1])
})()

if (nodeMajor < floorFromEngines) {
  process.stdout.write(`FAIL this runtime (node ${process.versions.node}) is below the package floor (>=${floorFromEngines})\n`)
  process.exitCode = 1
  process.exit(1)
}
notes.push(`runtime node ${process.versions.node} · platform ${process.platform} · engines floor >=${floorFromEngines}`)

/* ------------------------------------------ 1. no network, no device: tripwire */

/** @param {string} what */
const tripwire = (what) => {
  throw new Error(`dist-smoke forbids outbound ${what}: this smoke must construct wiring, never reach an endpoint`)
}
globalThis.fetch = () => tripwire('fetch()')
http.request = () => tripwire('http.request()')
http.get = () => tripwire('http.get()')
https.request = () => tripwire('https.request()')
https.get = () => tripwire('https.get()')

/* ------------------------------------------------------ 2. the build is present */

const requiredChunks = ['index.js', 'index.d.ts', 'node.js', 'node.d.ts']
for (const file of requiredChunks) {
  if (!fs.existsSync(path.join(DIST_DIR, file))) {
    process.stdout.write(
      `FAIL dist/${file} is missing — build the workspace first: npm run build (exit 2 · nothing was executed)\n`,
    )
    process.exit(2)
  }
}

/**
 * Every relative specifier the two entry chunks import must exist on disk. Vite's lib build splits
 * `dist/index.js` and `dist/node.js` over a shared `src-<hash>.js` chunk, and a publish/`files`
 * mistake that ships an entry without its chunk is an ESM resolution crash at require time — which
 * is precisely the class of thing that only shows up on a runtime the dev tooling never runs.
 * @param {string} entry
 */
function relativeSpecifiers(entry) {
  const text = fs.readFileSync(path.join(DIST_DIR, entry), 'utf8')
  const specifiers = new Set()
  for (const match of text.matchAll(/(?:from|import)\s*['"](\.\/[^'"]+)['"]/g)) specifiers.add(match[1])
  return [...specifiers]
}

check('dist entry chunks resolve on disk', () => {
  for (const entry of ['index.js', 'node.js']) {
    const specs = relativeSpecifiers(entry)

    for (const spec of specs) {
      assert(fs.existsSync(path.join(DIST_DIR, spec)), `${entry} imports ${spec}, which is not in dist/ — the published artifact cannot resolve`)
    }
  }
  notes.push(`chunk graph: index.js [${relativeSpecifiers('index.js').join(', ') || 'none'}] · node.js [${relativeSpecifiers('node.js').join(', ') || 'none'}]`)
})

/* --------------------------------------------------------------- 3. load dist */

let browserEntry
let nodeEntry
try {
  browserEntry = /** @type {any} */ (await import(path.join(DIST_DIR, 'index.js')))
  nodeEntry = /** @type {any} */ (await import(path.join(DIST_DIR, 'node.js')))
} catch (err) {
  process.stdout.write(`FAIL importing dist under node ${process.versions.node}: ${String(/** @type {Error} */ (err)?.stack ?? err)}\n`)
  process.exit(1)
}

check('./index exposes the command layer, errors and redaction', () => {
  for (const name of [
    'Node',
    'createNode',
    'createConnection',
    'createTransport',
    'ConfigSession',
    'EapiError',
    'CommandError',
    'TransportError',
    'NotSupportedError',
    'ProtocolError',
    'parseVersionProperties',
    'redactCommands',
    'redactWireText',
    'assertVlanId',
    'parseInterfaceName',
    'parseEapiConf',
    'parseConfigBlock',
    'RESOURCE_FACTORIES',
  ]) {
    assert(name in browserEntry, `./index is missing export ${name} (the export map or a build change dropped public surface)`)
  }
  for (const name of ['createNode', 'createConnection', 'createTransport', 'parseVersionProperties', 'redactCommands']) {
    assertFunction(`./index ${name}`, browserEntry[name])
  }
})

check('./node is a superset of ./index and adds the Node-only transports', () => {
  const missing = Object.keys(browserEntry).filter((key) => !(key in nodeEntry))
  assert(missing.length === 0, `./node no longer re-exports ./index surface: ${missing.join(', ')}`)
  for (const name of [
    'UnixSocketTransport',
    'HttpLocalTransport',
    'SessionCookieTransport',
    'ClientCertTransport',
    'TlsTransport',
    'unixAddress',
    'resolveTlsConnect',
    'loadProfileStore',
    'loadEapiConf',
    'createNodeFor',
    'FileSessionJournal',
  ]) {
    assert(name in nodeEntry, `./node is missing the Node-only export ${name}`)
  }
  // Same class object through both entries: the shared chunk must not be duplicated, or `instanceof`
  // across the two entry points silently breaks for a consumer importing both.
  assert(nodeEntry.Node === browserEntry.Node, './node.Node is not ./index.Node — the bundle duplicated a class across entries')
  assert(nodeEntry.EapiError === browserEntry.EapiError, './node.EapiError is not ./index.EapiError')
})

check('DR-002: the browser entry still refuses a Node-only transport', () => {
  let thrown
  try {
    browserEntry.createConnection({ kind: 'unix', socketPath: '/var/run/command-api.sock' })
  } catch (err) {
    thrown = /** @type {Error} */ (err)
  }
  assert(thrown !== undefined, 'createConnection({kind:"unix"}) from ./index did NOT refuse — a browser bundle could reach a switch-local socket')
  assert(thrown instanceof browserEntry.NotSupportedError, `expected NotSupportedError, got ${thrown?.name}: ${thrown?.message}`)
  assert(/\/node/.test(String(thrown?.message)), `refusal does not name the ./node entry: ${thrown?.message}`)
})

check('both entries build a Node over an explicit endpoint without any I/O', () => {
  const browserNode = browserEntry.createNode({ kind: 'https', host: 'invalid.invalid', username: 'u', password: 'not-a-secret' })
  assert(browserNode.connection.address === 'https://invalid.invalid:443/command-api', `unexpected browser address: ${browserNode.connection.address}`)
  const labNode = nodeEntry.createNode({ kind: 'https', host: '127.0.0.1', port: 8443, username: 'labuser', password: 'not-a-secret' })
  assert(labNode.connection.address === 'https://127.0.0.1:8443/command-api', `unexpected node address: ${labNode.connection.address}`)
  assert(labNode instanceof browserEntry.Node, 'createNode from ./node did not produce the shared Node class')
  for (const resource of ['vlans', 'switchports', 'interfaces', 'system']) {
    assert(labNode[resource] !== undefined && labNode[resource] !== null, `Node.${resource} is absent from the built artifact`)
  }
  // The verbs a UI/M13 transaction depends on must survive the build, not just the type declarations.
  for (const verb of ['configSession', 'listSessions', 'abortSession', 'runCommands', 'exec', 'show', 'getConfig', 'getVersion']) {
    assertFunction(`Node.prototype.${verb}`, labNode[verb])
  }
})

check('the built artifact redacts a fake secret', () => {
  const redacted = browserEntry.redactCommands([{ cmd: 'enable', input: 'hunter2-not-real' }])
  const text = JSON.stringify(redacted)
  assert(!text.includes('hunter2-not-real'), `redactCommands leaked the enable input in the built artifact: ${text}`)
  assert(browserEntry.REDACTED === '<redacted>', `unexpected REDACTED marker: ${String(browserEntry.REDACTED)}`)
})

check('the built artifact parses the recorded cEOS shape, not a guess', () => {
  // Spellings taken from the committed capture (test/fixtures/live/ceos-4.28.14M/show-version.json),
  // so a dist that silently loses the parser is caught here rather than by a live run.
  const props = browserEntry.parseVersionProperties({
    version: '4.28.14M-50015774.42814M (engineering build)',
    internalVersion: '4.28.14M-50015774.42814M',
    modelName: 'cEOS-Lab',
    mfgName: 'Arista Networks',
  })
  assert(props.modelName === 'cEOS-Lab', `modelName parsing regressed: ${JSON.stringify(props)}`)
  assert(String(props.version).startsWith('4.28.'), `version parsing regressed: ${JSON.stringify(props)}`)
  const vlanChecks = [browserEntry.isVlanId(20) === true, browserEntry.isVlanId(4095) === false, browserEntry.isVlanId(0) === false]
  assert(vlanChecks.every(Boolean), `vlan validation regressed: ${JSON.stringify(vlanChecks)}`)
  const parsed = browserEntry.parseInterfaceName('Ethernet3')
  assert(parsed !== undefined && parsed !== null, 'parseInterfaceName("Ethernet3") returned nothing — name grammar regressed')
})

check('pure config/profile readers still work from dist', () => {
  // `[connection:<name>]` is the section spelling this port uses, and `[DEFAULT]` merging is part of
  // the profile contract (DR-044/DR-045) — both are engine code the UI depends on.
  const parsed = browserEntry.parseEapiConf('[DEFAULT]\ntransport: https\n\n[connection:smoke]\ntransport: https\nhost: invalid.invalid\n')
  assert(Array.isArray(parsed.issues), 'parseEapiConf returned no issues array')
  assert(parsed.issues.length === 0, `unexpected profile issues: ${JSON.stringify(parsed.issues.map((i) => i.kind))}`)
  const found = parsed.profiles.find((entry) => entry.name === 'smoke')
  assert(found && found.host === 'invalid.invalid' && found.transport === 'https', `profile not parsed from dist: ${JSON.stringify(parsed.profiles)}`)
  const block = browserEntry.parseConfigBlock('interface Ethernet3\n   description smoke\n   mtu 1500\n!', {
    header: (entry) => entry.header,
    // `body` is the engine's parsed line descriptors ({ text, indent, token, value }) — reading a
    // token is the cheapest way to prove the config engine survived the build, not just its types.
    description: (entry) => entry.body.find((line) => line.token === 'description')?.value?.trim() ?? null,
    mtu: (entry) => entry.body.find((line) => line.token === 'mtu')?.value?.trim() ?? null,
  })
  assert(String(block.header).includes('Ethernet3'), `config block header lost: ${JSON.stringify(block)}`)
  assert(block.description === 'smoke', `field extractor through dist failed: ${JSON.stringify(block)}`)
  assert(block.mtu === '1500', `second field extractor through dist failed: ${JSON.stringify(block)}`)
  notes.push(`profile reader: ${parsed.profiles.length} profile(s) · config reader: ${JSON.stringify(block.header)}`)
})

/* ------------------------------------------------------------------- verdict */

process.stdout.write(`${failures.length === 0 ? 'ok' : 'FAIL'} dist smoke · node ${process.versions.node} · ${Object.keys(browserEntry).length} exports from ./index, ${Object.keys(nodeEntry).length} from ./node\n`)
for (const note of notes) process.stdout.write(`  · ${note}\n`)
if (failures.length > 0) {
  process.stdout.write(`smoke failed: ${failures.length} check(s): ${failures.join('; ')}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(
    'note: this proves the built artifact loads and behaves under THIS runtime. The engines.node ' +
      `floor of ${floorFromEngines} is only literally exercised on the CI leg at node-version ${floorFromEngines}.\n`,
  )
}
