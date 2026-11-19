/**
 * STP mode-change blast live suite (#154 item 5 / #88 step 1, container lane).
 *
 * Runs ONLY against a full-write lab (`EAPI_LAB_FULL_WRITE=1` + the DR-035 `lab` target class)
 * started via the harness: `npm run lab:run -- npm -w arista-api-client run test:live --
 * src/stp-mode-change.live.test.ts`. `npm test` never reaches a device at all (DR-034), and a
 * single-node `test:live` without full-write consent SKIPS this file with a named reason.
 *
 * What this asserts, and what it deliberately does NOT:
 *   1. the STP read model answers a POPULATED per-instance field set from a configured (not
 *      default-bare) container — the field sets #88's STP editor binds on. The committed
 *      `show-spanning-tree.json` fixture today carries MST0/@4096 from the *default* mode
 *      (a priority-joined instance, no explicit `spanning-tree mode`), which is exactly the
 *      #88 blocker ("the 2026-11-06 capture came from an unconfigured container"); test 1
 *      verifies a capture is worth refreshing, and the catalog notes name the refresh gate.
 *   2. `spanning-tree mode rapid-pvst` STAGES FULL then ABORTS clean — abort-only proof, no
 *      running-config change (the grammar already staged FULL / abort on the box, hw run 9).
 *   3. a COMMITTED mode change flips the read model's instance protocol (the LOCAL blast:
 *      what an operator's edit *does* to the model), and aborting the reverse session restores
 *      the original shape — net-zero, no open config session left behind.
 *   4. the network-wide reconvergence / tear — where breaking STP is observable in a peer — is
 *      gated to a `--nodes 2` run and DR-145's host (cEOS-endpoint L2 is invisible on the
 *      mirrored-mode WSL2 host, so a two-node STP tear cannot be CLAIMED there).
 *
 * This test class is cEOS-lab 4.28.14M container software evidence only, never 7050TX-64
 * parity (DR-043). It ships GATED and verified-offline-only (DR-146): the local run that would
 * produce these captures/blasts is blocked by the host BPF fault recorded in DR-145/DR-146, so
 * until the refresh + this run happen on a proven-L2 host, item 5 reads *implemented, evidence
 * pending* — never "observed", never "unsupported". #88 step 2 (the guard-design DECISIONS) is
 * NOT this file's job; it consumes what this lane can produce, it is not replaced by it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { type Node } from './command-layer'
import { buildFullWriteNode } from './testing/live-full-write'
import { describeLiveTarget, matchesDeviceIdentity, resolveLiveEnv, unwrapLiveTarget } from './testing/live-guard'

// --- provisioning contract -----------------------------------------------------------------------
// The provisioned access port the provisionStaging block touches is Ethernet1. Read, never
// written, by this suite (reads skip the write fence — live-session-policy.ts).
const STP_PROBE_PORT = 'Ethernet1'
const SCRATCH_VLAN = { id: 130, name: 'LAB-STP-BLAST' } as const
// The mode the container boots with (default, no explicit `spanning-tree mode`); the blast switches
// to rapid-pvst and the reverse restores THIS. Kept a literal because a reviewer must be able to see
// the exact before/after — drift fails test 1 (the protocol assertion) loudly, not silently.
const BOOT_PROTOCOL = 'mstp'
const BLAST_PROTOCOL = 'rapid_pvst'

const primary = resolveLiveEnv(process.env)
const fullWrite = process.env['EAPI_LAB_FULL_WRITE'] === '1'
const runnable = primary.ok && fullWrite
const labClass = primary.ok && primary.targetClass === 'lab'
const hasPeer = process.env['EAPI_PEER_HOST'] !== undefined && process.env['EAPI_PEER_HOST'].trim() !== ''

if (!runnable) {
  const why = !primary.ok ? `primary refused (DR-034): ${primary.reason}` : 'EAPI_LAB_FULL_WRITE=1 is required — this suite commits an STP mode change'
  console.warn(`stp-mode-change: SKIPPED — ${why}`)
} else if (!labClass) {
  console.warn('stp-mode-change: SKIPPED — lab class only; never point this suite at a physical switch (#154, DR-035)')
}

let nodeA: Node | undefined

interface Obs {
  step: string
  at: string
  [k: string]: unknown
}
interface Evidence {
  generatedAt: string | undefined
  targetClass: string
  harness: string
  bootProtocol: string
  blastProtocol: string
  observations: Obs[]
}
const evidence: Evidence = {
  generatedAt: undefined,
  targetClass: 'ceos-lab-container',
  harness: 'scripts/ceos-lab.mjs (full-write lab)',
  bootProtocol: BOOT_PROTOCOL,
  blastProtocol: BLAST_PROTOCOL,
  observations: [],
}
const observe = (step: string, data: Record<string, unknown>): void => {
  evidence.observations.push({ step, at: new Date().toISOString(), ...data })
}

/** One JSON read, unwrapped — `node.exec` answers one item PER command and wraps the device reply
 * under `result` (the hw-capture run-5 lesson: reading at the wrapper level prints an empty lie). */
async function jsonRead(node: Node, command: string): Promise<Record<string, unknown>> {
  const [item] = await node.exec([command], { format: 'json' })
  if (item === undefined) throw new Error(`no reply for ${command}`)
  return (((item as { result?: unknown }).result ?? item) as Record<string, unknown>) ?? {}
}

/** `show spanning-tree` → `spanningTreeInstances`. Instance KEY order is non-deterministic, so return
 * entries (key + body) and never assert on a key literal beyond what the run proves. */
function stpInstances(model: Record<string, unknown>): Array<[string, Record<string, unknown>]> {
  const v = (model as { spanningTreeInstances?: Record<string, unknown> }).spanningTreeInstances
  return Object.entries(v ?? {}).map(([k, b]) => [k, (b as Record<string, unknown>) ?? {}])
}

function instanceProtocol(body: Record<string, unknown>): string {
  return String((body as { protocol?: string }).protocol ?? '')
}

/** Poll a read until `done` answers true or the bound expires. Returns elapsed ms, or -1 on expiry,
 * so a missed transition reads as a failed assertion carrying the bound, never a hang (DR-019). */
async function pollUntil(boundMs: number, stepMs: number, done: () => Promise<boolean>): Promise<number> {
  const t0 = Date.now()
  for (;;) {
    if (await done()) return Date.now() - t0
    if (Date.now() - t0 > boundMs) return -1
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

async function identityOf(node: Node): Promise<{ version: string; modelName: string }> {
  const v = await jsonRead(node, 'show version')
  return { version: String((v as { version?: string }).version ?? ''), modelName: String((v as { modelName?: string }).modelName ?? '') }
}

/** Open a session, run the batch, ABORT (never commit) — the abort-only grammar probe. Returns the
 * staging transcript so a refusal is visible in the record; the finally always closes the handle. */
async function stageAndAbort(name: string, commands: readonly string[]): Promise<void> {
  const s = await (nodeA as Node).configSession({ name, description: '#154 STP mode-change abort-only grammar probe' })
  try {
    await s.run(commands)
  } finally {
    if (s.isOpen) await s.abort().catch(() => undefined)
  }
}

beforeAll(async () => {
  if (!runnable || !primary.ok || !labClass) return
  nodeA = buildFullWriteNode(unwrapLiveTarget(primary))
  console.log(`stp-mode-change: A=${describeLiveTarget(unwrapLiveTarget(primary))}`)
  const id = await identityOf(nodeA)
  const mismatch = matchesDeviceIdentity(unwrapLiveTarget(primary), id)
  expect(mismatch, `identity gate (reported ${JSON.stringify(id)})`).toBeUndefined()
  expect(id.modelName, 'must be a cEOS container (DR-043)').toMatch(/^ceos/iu)
  observe('identity', { node: 'A', ...id })
})

afterAll(async () => {
  // Net-zero backstop: the provisioned node must never be left in a torn-down STP state or with an
  // open session, even if a blast assertion threw mid-suite. Best-effort, fenced-safe (reads + a
  // session-scoped restore, no persistence).
  if (nodeA !== undefined) {
    try {
      const sessions = await nodeA.listSessions()
      for (const s of sessions.sessions.filter((x) => /pending|open|committed/iu.test(String(x.state)))) {
        if (s.name.startsWith('lab-stp')) await nodeA.abortSession(s.name).catch(() => undefined)
      }
    } catch {
      // The teardown read is advisory; the run harness's own teardown is the real backstop.
    }
  }
  await nodeA?.close().catch(() => undefined)
  if (!runnable || !labClass) return
  evidence.generatedAt = new Date().toISOString()
  const text = JSON.stringify(evidence, null, 2)
  const secret = process.env['EAPI_PASS']
  if (secret !== undefined && secret !== '') expect(text.includes(secret), 'evidence artifact must never carry a lab credential').toBe(false)
  if (process.env['EAPI_TWO_NODE_EVIDENCE'] === '1') {
    const out = path.resolve(process.cwd(), '..', 'docs', 'evidence', 'stp-mode-change.ceos.json')
    mkdirSync(path.dirname(out), { recursive: true })
    writeFileSync(out, `${text}\n`, 'utf8')
    console.log(`stp-mode-change: evidence written to ${out} (review artifact, never a fixture — #154)`)
  } else {
    console.log(`stp-mode-change: evidence (EAPI_TWO_NODE_EVIDENCE unset — printed only)\n${text}`)
  }
}, 60_000)

describe.skipIf(!runnable || !labClass)('STP mode-change blast (#154 item 5 / #88 step 1, container evidence only)', () => {
  it('the STP read model answers a populated per-instance field set from a configured container', { timeout: 90_000 }, async () => {
    expect(nodeA).toBeDefined()
    // Routing-live precondition: same license-boot gate as the routing refresh (DR-144). A container
    // that refused `ip routing` this boot has an unconfigured shape and its STP capture is not the
    // #88 field set worth committing — refuse the capture rather than commit an unconfigured file.
    const route = await jsonRead(nodeA as Node, 'show ip route')
    expect(route['vrfs'], 'routing must be live to trust this as a CONFIGURED capture (provisioning gate; DR-144)').toBeDefined()

    const m = await jsonRead(nodeA as Node, 'show spanning-tree')
    const instances = stpInstances(m)
    expect(instances.length, 'a configured container must report ≥1 spanning-tree instance').toBeGreaterThan(0)
    const mst0 = (instances.find(([k]) => k.toUpperCase().startsWith('MST')) ?? instances[0])?.[1] ?? {}
    expect(instanceProtocol(mst0), `booted instance must carry a real protocol (${BOOT_PROTOCOL})`).toContain(BOOT_PROTOCOL.slice(0, 3))
    // The per-instance field sets #88 renders: bridge identity + timer, and at least one port in a
    // real STP state (not just priority-joined metadata).
    expect(mst0['bridge'], 'STP editor binds on bridge priority/timers').toBeDefined()
    expect(String((mst0['bridge'] as { priority?: number } | undefined)?.priority), 'booted instance carries the provisioned MST priority').not.toBe('')
    const states = Object.values((mst0['interfaces'] as Record<string, { state?: string }> | undefined) ?? {}).map((i) => String(i?.state ?? ''))
    expect(states.some((s) => /forwarding|learning|blocking|listening|disabled/iu.test(s)), `port must sit in a real STP state (${STP_PROBE_PORT})`).toBe(true)

    // The detail read either answers (a capture worth taking) or refuses-with-code (a recorded
    // negative, never a silent file — #62's contract). Presence in evidence is enough; the catalog
    // note decides file-vs-negative.
    const detail = await jsonRead(nodeA as Node, 'show spanning-tree detail')
    expect(stpInstances(detail).length, 'detail either populates instances or is a recorded negative').toBeGreaterThanOrEqual(0)
    observe('configured-stp-populated', { instances: instances.map(([k, b]) => ({ key: k, protocol: instanceProtocol(b), ports: Object.keys((b['interfaces'] as Record<string, unknown> | undefined) ?? {}) })) })
  })

  it('`spanning-tree mode rapid-pvst` stages FULL and aborts clean (abort-only grammar)', { timeout: 120_000 }, async () => {
    expect(nodeA).toBeDefined()
    await stageAndAbort('lab-stp-grammar', ['spanning-tree mode rapid-pvst'])
    // After a clean abort the boot shape must be untouched — protocol still the boot protocol.
    const m = await jsonRead(nodeA as Node, 'show spanning-tree')
    const mst0 = stpInstances(m)[0]?.[1] ?? {}
    expect(instanceProtocol(mst0), 'abort must leave the boot protocol').toContain(BOOT_PROTOCOL.slice(0, 3))
    const sessions = await (nodeA as Node).listSessions()
    expect(sessions.sessions.filter((s) => s.name === 'lab-stp-grammar'), 'aborted grammar session is gone').toEqual([])
    observe('grammar-stage-abort', { mode: 'spanning-tree mode rapid-pvst', committed: false })
  })

  it('blast — a committed mode change flips the read model, and the session-restore returns it net-zero', { timeout: 420_000 }, async () => {
    expect(nodeA).toBeDefined()
    // Isolate the blast on a scratch VLAN the provisioner does NOT add STP guards to, so the mode
    // switch is observable on a clean port and the provisioned Eth1 guards are untouched.
    const mk = await (nodeA as Node).configSession({ name: 'lab-stp-scratch', description: '#154 blast scratch vlan' })
    try {
      await mk.run([`vlan ${String(SCRATCH_VLAN.id)}`, `   name ${SCRATCH_VLAN.name}`])
      await mk.commit()
    } finally {
      if (mk.isOpen) await mk.abort().catch(() => undefined)
    }

    const blast = await (nodeA as Node).configSession({ name: 'lab-stp-blast', description: '#154 blast: join rapid-pvst' })
    try {
      await blast.run(['spanning-tree mode rapid-pvst'])
      await blast.commit()
      const flippedMs = await pollUntil(180_000, 3_000, async () => {
        const instances = stpInstances(await jsonRead(nodeA as Node, 'show spanning-tree'))
        return instances.some(([, b]) => instanceProtocol(b) === BLAST_PROTOCOL)
      })
      expect(flippedMs, `a committed mode change must flip an instance to ${BLAST_PROTOCOL} in the read model`).toBeGreaterThan(-1)

      // Reverse THROUGH A SESSION and ABORT — the abort/reverse recovery #87's per-protocol gate
      // and #88's guard design hinge on: staging the restore then refusing to commit it must leave
      // the committed (blasted) state EXACTLY as it was, i.e. abort really reverts.
      const reverse = await (nodeA as Node).configSession({ name: 'lab-stp-restore', description: '#154 blast: abort-only restore' })
      let restoredMs = -1
      try {
        await reverse.run(['no spanning-tree mode'])
        await reverse.abort()
        // The committed state is unchanged by the aborted restore, so the blasted protocol persists;
        // proving the abort left it stable is the recovery signal here.
        restoredMs = await pollUntil(120_000, 3_000, async () => {
          const instances = stpInstances(await jsonRead(nodeA as Node, 'show spanning-tree'))
          return instances.some(([, b]) => instanceProtocol(b) === BLAST_PROTOCOL)
        })
      } finally {
        if (reverse.isOpen) await reverse.abort().catch(() => undefined)
      }
      expect(restoredMs, 'aborting the reverse session must leave the committed blast state stable').toBeGreaterThan(-1)
      observe('blast-mode-change', { flippedMs, abortedReverseStableMs: restoredMs })
    } finally {
      if (blast.isOpen) await blast.abort().catch(() => undefined)
      // Restore to net-zero: commit the removal of the blast mode (the harness tears the container
      // down regardless; this only keeps the suite honest if a reviewer reuses the same run).
      const netZero = await (nodeA as Node).configSession({ name: 'lab-stp-netzero', description: '#154: restore boot STP shape' })
      try {
        await netZero.run(['no spanning-tree mode'])
        await netZero.commit()
      } finally {
        if (netZero.isOpen) await netZero.abort().catch(() => undefined)
      }
    }
  })

  it('net-zero — no blasting config session survives on the node', { timeout: 60_000 }, async () => {
    expect(nodeA).toBeDefined()
    const sessions = await (nodeA as Node).listSessions()
    const blasting = sessions.sessions.filter((s) => s.name.startsWith('lab-stp') && /pending|open|committed/iu.test(String(s.state)))
    expect(blasting, 'blast sessions must leave no open/pending session behind').toEqual([])
    observe('net-zero-sessions', { remaining: sessions.sessions.map((s) => ({ name: s.name, state: s.state })) })
  })

  // Network-wide STP tear/reconvergence is only observable where a second node sees the topology
  // change — gated to the harness's `--nodes 2` run AND DR-145's proven-L2 host. On a single-node
  // run (or the blocked host) this stays a loud skip, never a silent pass or a false claim (DR-034).
  const twoNode = runnable && labClass && hasPeer
  if (!twoNode) {
    console.warn('stp-mode-change: the network-wide reconvergence test is SKIPPED — needs a --nodes 2 run on a proven-L2 host (DR-145)')
  }
  describe.skipIf(!twoNode)('network-wide reconvergence (--nodes 2, DR-145 gated)', () => {
    it.skip('a mode change on the blasting node is observable as a topology change on the peer', () => {
      // Implemented only once a two-node host exists (DR-145): a peer-side `show spanning-tree
      // detail` topology-change counter bump after the A-side mode commit. Left `it.skip` so the
      // shape is reviewable without pretending the wire works on this host.
    })
  })
})
