/**
 * Two-node OSPF adjacency + blast-behavior live suite (#154 items 2+4, container lane).
 *
 * Runs ONLY against a `--nodes 2` lab: `npm run lab:run -- --nodes 2 --no-fixtures --
 * npm -w arista-api-client run test:live -- src/ospf-two-node.live.test.ts` (docs/CEOS.md).
 * The harness exports the pair: the primary target lives in the standard EAPI_* set, and
 * the peer arrives as `EAPI_PEER_*` (second loopback forwarder, own cert anchor — same
 * trust triple shape, DR-013). A single-node live run therefore SKIPS this file with a
 * named reason; `npm test` never reaches a device at all (DR-034).
 *
 * What it claims (cEOS-lab 4.28.14M container evidence, never 7050TX parity, DR-043):
 *   1. a real OSPF adjacency forms over the harness-wired transit link (neighbor FULL,
 *      both directions — the field sets #87's read-only tabs bind on with a POPULATED
 *      neighbor table, which provisioning a single node can never produce);
 *   2. the route model reacts to a peer-side routing edit made through the client's own
 *      `configSession` verbs (withdraw → source-A watch → restore), i.e. the blast half
 *      of #87's per-protocol review has observed evidence, not reasoning;
 *   3. the stronger blast: a neighbor goes DOWN and comes back FULL through the same
 *      edit/reverse cycle;
 *   4. net-zero afterwards: both running-configs back to the provisioning shape and no
 *      open config sessions on either node.
 * Time bounds are the ones a reviewer can challenge; observed timings land in the
 * evidence artifact (`EAPI_TWO_NODE_EVIDENCE=1` → docs/evidence/ospf-two-node.ceos.json,
 * review evidence, never fixtures — fixtures stay the single-node contract).
 *
 * BGP gets no adjacency test on purpose: its JSON read model is unreachable on this
 * image even when configured (2026-11-18 catalog verdict, and the hardware lane's own
 * run-7 `% Not supported`) — an unobservable adjacency proves nothing (#154).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { type Node } from './command-layer'
import { buildFullWriteNode } from './testing/live-full-write'
import { hwReadBackOutput } from './testing/hw-capture'
import {
  describeLiveTarget,
  matchesDeviceIdentity,
  resolveLiveEnv,
  unwrapLiveTarget,
  type LiveResolution,
} from './testing/live-guard'

/**
 * Mirrors `PEER_LINK` in scripts/ceos-lab.mjs (the wire both nodes were provisioned
 * against; the harness refuses to start a nodes=2 run whose ports disagree). Kept as a
 * literal because scripts/ is not an importable module — drift here fails test 1 loudly
 * (the neighbor address assertion) rather than silently.
 */
const PEER_LINK = {
  aIp: '10.155.0.1',
  bIp: '10.155.0.2',
  subnet: '10.155.0.0/30',
  bLoopback: '10.156.0.2',
  area: '0',
} as const

const primary = resolveLiveEnv(process.env)

/** Re-key the run's `EAPI_PEER_*` set into the standard contract so the peer passes the
 * SAME guard the primary does — loopback-only, cert-pinned, model/version-pinned. A real
 * switch can never satisfy it, which is the point of routing the peer through here. */
function resolvePeerEnv(env: Readonly<Record<string, string | undefined>>): LiveResolution {
  const allowPorts = [env['EAPI_ALLOW_PORTS'], env['EAPI_PEER_PORT']].filter((v) => v !== undefined && v !== '').join(',')
  return resolveLiveEnv({
    ...env,
    EAPI_HOST: env['EAPI_PEER_HOST'],
    EAPI_PORT: env['EAPI_PEER_PORT'],
    EAPI_USER: env['EAPI_PEER_USER'],
    EAPI_PASS: env['EAPI_PEER_PASS'],
    EAPI_CA_FILE: env['EAPI_PEER_CA_FILE'],
    EAPI_FINGERPRINT: env['EAPI_PEER_FINGERPRINT'],
    EAPI_SERVER_NAME: env['EAPI_PEER_SERVER_NAME'],
    EAPI_ALLOW_PORTS: allowPorts === '' ? undefined : allowPorts,
  })
}

const hasPeer = process.env['EAPI_PEER_HOST'] !== undefined && process.env['EAPI_PEER_HOST'].trim() !== ''
const peer: LiveResolution | undefined = primary.ok && hasPeer ? resolvePeerEnv(process.env) : undefined

const fullWrite = process.env['EAPI_LAB_FULL_WRITE'] === '1'
const runnable = primary.ok && peer !== undefined && peer.ok && fullWrite
const labClass = primary.ok && primary.targetClass === 'lab'

if (!runnable) {
  const why = !primary.ok
    ? `primary refused (DR-034): ${primary.reason}`
    : peer === undefined
      ? 'no EAPI_PEER_* in the environment — start the run with `npm run lab:run -- --nodes 2 …` (#154)'
      : !peer.ok
        ? `peer refused its guard: ${peer.reason}`
        : 'EAPI_LAB_FULL_WRITE=1 is required — this suite commits on the peer node'
  console.warn(`ospf-two-node: SKIPPED — ${why}`)
} else if (!labClass) {
  console.warn('ospf-two-node: SKIPPED — lab class only; never point this suite at a physical switch (#154, DR-035)')
}

let nodeA: Node | undefined
let nodeB: Node | undefined
interface TwoNodeEvidence {
  generatedAt: string | undefined
  targetClass: string
  harness: string
  link: typeof PEER_LINK
  observations: Record<string, unknown>[]
}
const evidence: TwoNodeEvidence = {
  generatedAt: undefined,
  targetClass: 'ceos-lab-container',
  harness: 'scripts/ceos-lab.mjs --nodes 2',
  link: PEER_LINK,
  observations: [],
}
const observe = (step: string, data: Record<string, unknown>): void => {
  evidence.observations.push({ step, at: new Date().toISOString(), ...data })
}

/** One JSON read, unwrapped. `node.exec` answers one item PER command and wraps the
 * device reply under `result` (the run-5 lesson `hw-capture.ts` documents) — reading at
 * the wrapper level is how a lane prints an empty lie. */
async function jsonRead(node: Node, command: string): Promise<Record<string, unknown>> {
  const [item] = await node.exec([command], { format: 'json' })
  if (item === undefined) throw new Error(`no reply for ${command}`)
  const unwrapped = (item as { result?: unknown }).result ?? item
  return (unwrapped as Record<string, unknown>) ?? {}
}

/** Neighbor entries: `ospfNeighborEntries` is an array on this image; the object shape is
 * tolerated so a future model revision fails on CONTENT, not on key type. */
function neighborEntries(model: Record<string, unknown>): Record<string, unknown>[] {
  const v = (model as { vrfs?: Record<string, { instList?: Record<string, { ospfNeighborEntries?: unknown }> }> }).vrfs?.default?.instList?.['1']?.ospfNeighborEntries
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : (Object.values((v as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>[])
}

function routeKeys(model: Record<string, unknown>): string[] {
  const v = (model as { vrfs?: Record<string, { routes?: Record<string, unknown> }> }).vrfs?.default?.routes
  return Object.keys(v ?? {})
}

/** Poll a read until `done` answers true or the bound expires. Returns elapsed ms, or -1
 * when the bound expired — callers assert on the number so a missed transition reads as
 * a failed assertion carrying the bound, never a hang (DR-019). */
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

beforeAll(async () => {
  if (!runnable || !primary.ok || peer === undefined || !peer.ok) return
  if (!labClass) return
  nodeA = buildFullWriteNode(unwrapLiveTarget(primary))
  nodeB = buildFullWriteNode(unwrapLiveTarget(peer))
  console.log(`ospf-two-node: A=${describeLiveTarget(unwrapLiveTarget(primary))} · B=${describeLiveTarget(unwrapLiveTarget(peer))}`)
  // Release/model gates (live-guard semantics) — the identity must match what the harness
  // pinned, or the adjacency below is measuring the wrong box entirely.
  const versionPin = process.env['EAPI_ALLOW_VERSION'] ?? ''
  for (const [label, node, target] of [['A', nodeA, unwrapLiveTarget(primary)], ['B', nodeB, unwrapLiveTarget(peer)]] as const) {
    const id = await identityOf(node)
    const mismatch = matchesDeviceIdentity(target, id)
    expect(mismatch, `peer-side identity gate for ${label} (reported ${JSON.stringify(id)})`).toBeUndefined()
    expect(id.modelName, `${label} must be a cEOS container (DR-043)`).toMatch(/^ceos/iu)
    if (versionPin !== '') expect(id.version.includes(versionPin), `${label} release must carry ${versionPin}`).toBe(true)
    observe('identity', { node: label, ...id })
  }
})

afterAll(async () => {
  await nodeA?.close().catch(() => undefined)
  await nodeB?.close().catch(() => undefined)
  if (!runnable) return
  evidence.generatedAt = new Date().toISOString()
  const text = JSON.stringify(evidence, null, 2)
  for (const secret of [process.env['EAPI_PASS'], process.env['EAPI_PEER_PASS']]) {
    if (secret !== undefined && secret !== '') expect(text.includes(secret), 'evidence artifact must never carry a lab credential').toBe(false)
  }
  if (process.env['EAPI_TWO_NODE_EVIDENCE'] === '1') {
    const out = path.resolve(process.cwd(), '..', 'docs', 'evidence', 'ospf-two-node.ceos.json')
    mkdirSync(path.dirname(out), { recursive: true })
    writeFileSync(out, `${text}\n`, 'utf8')
    console.log(`ospf-two-node: evidence written to ${out} (review artifact, never a fixture — #154)`)
  } else {
    console.log(`ospf-two-node: evidence (EAPI_TWO_NODE_EVIDENCE unset — printed only)\n${text}`)
  }
}, 30_000)

describe.skipIf(!runnable || !labClass)('two-node OSPF (#154 items 2+4, container evidence only)', () => {
  it('a real OSPF adjacency is FULL in both directions', { timeout: 300_000 }, async () => {
    expect(nodeA).toBeDefined()
    expect(nodeB).toBeDefined()
    const downMsA = await pollUntil(240_000, 5_000, async () => {
      const entries = neighborEntries(await jsonRead(nodeA as Node, 'show ip ospf neighbor'))
      return entries.some((e) => /full/iu.test(JSON.stringify(e)))
    })
    expect(downMsA, 'A must see B FULL within 240s (container timers: hello 10s/dead 40s + LSA exchange)').toBeGreaterThan(-1)
    const modelA = await jsonRead(nodeA as Node, 'show ip ospf neighbor')
    const entriesA = neighborEntries(modelA)
    expect(entriesA).toHaveLength(1)
    expect(JSON.stringify(entriesA[0]), 'A-side entry must name the peer link address').toContain(PEER_LINK.bIp)
    const downMsB = await pollUntil(60_000, 5_000, async () => {
      const entries = neighborEntries(await jsonRead(nodeB as Node, 'show ip ospf neighbor'))
      return entries.some((e) => /full/iu.test(JSON.stringify(e)))
    })
    expect(downMsB, 'B must see A FULL').toBeGreaterThan(-1)
    observe('adjacency-formed', { aSeesBms: downMsA, bSeesAms: downMsB, aEntry: entriesA[0] })
  })

  it('the route model carries the peer loopback via OSPF', { timeout: 90_000 }, async () => {
    const gotMs = await pollUntil(60_000, 3_000, async () => routeKeys(await jsonRead(nodeA as Node, 'show ip route')).includes(`${PEER_LINK.bLoopback}/32`))
    expect(gotMs, `A must learn ${PEER_LINK.bLoopback}/32 from B through OSPF`).toBeGreaterThan(-1)
    const detail = await jsonRead(nodeA as Node, `show ip route ${PEER_LINK.bLoopback}`)
    observe('peer-route-present', { learnedAfterMs: gotMs, detail })
  })

  it('blast 1 — a session-committed withdraw on B removes the route at A; the reverse restores it', { timeout: 420_000 }, async () => {
    const session = await (nodeB as Node).configSession({ name: 'ospf-blast-route', description: '#154 blast: withdraw loopback advertisement' })
    let reverseCommitted = false
    try {
      await session.run([`router ospf 1`, `no network ${PEER_LINK.bLoopback}/32 area ${PEER_LINK.area}`])
      await session.commit()
      const withdrawnMs = await pollUntil(180_000, 3_000, async () => !routeKeys(await jsonRead(nodeA as Node, 'show ip route')).includes(`${PEER_LINK.bLoopback}/32`))
      expect(withdrawnMs, 'A must LOSE the peer route once B withdraws the advertisement').toBeGreaterThan(-1)

      const reverse = await (nodeB as Node).configSession({ name: 'ospf-blast-route-restore', description: '#154 blast: restore loopback advertisement' })
      reverseCommitted = true
      try {
        await reverse.run([`router ospf 1`, `network ${PEER_LINK.bLoopback}/32 area ${PEER_LINK.area}`])
        await reverse.commit()
      } finally {
        if (reverse.isOpen) await reverse.abort().catch(() => undefined)
      }
      const restoredMs = await pollUntil(180_000, 3_000, async () => routeKeys(await jsonRead(nodeA as Node, 'show ip route')).includes(`${PEER_LINK.bLoopback}/32`))
      expect(restoredMs, 'the route must come back after the reverse commit (net-zero)').toBeGreaterThan(-1)
      observe('blast-route', { withdrawnMs, restoredMs })
    } finally {
      if (!reverseCommitted && session.isOpen) await session.abort().catch(() => undefined)
    }
  })

  it('blast 2 — B leaving the transit network drops the adjacency at A; rejoining restores FULL', { timeout: 600_000 }, async () => {
    const session = await (nodeB as Node).configSession({ name: 'ospf-blast-adj', description: '#154 blast: B leaves OSPF on the transit link' })
    let restored = false
    try {
      await session.run([`router ospf 1`, `no network ${PEER_LINK.subnet} area ${PEER_LINK.area}`])
      await session.commit()
      const droppedMs = await pollUntil(240_000, 4_000, async () => neighborEntries(await jsonRead(nodeA as Node, 'show ip ospf neighbor')).length === 0)
      expect(droppedMs, 'A must DROP the neighbor once B leaves the area on the wire').toBeGreaterThan(-1)

      const reverse = await (nodeB as Node).configSession({ name: 'ospf-blast-adj-restore', description: '#154 blast: B rejoins OSPF on the transit link' })
      restored = true
      try {
        await reverse.run([`router ospf 1`, `network ${PEER_LINK.subnet} area ${PEER_LINK.area}`])
        await reverse.commit()
      } finally {
        if (reverse.isOpen) await reverse.abort().catch(() => undefined)
      }
      const reformedMs = await pollUntil(300_000, 4_000, async () => {
        const entries = neighborEntries(await jsonRead(nodeA as Node, 'show ip ospf neighbor'))
        return entries.some((e) => /full/iu.test(JSON.stringify(e)))
      })
      expect(reformedMs, 'the adjacency must reform FULL after the reverse commit (net-zero)').toBeGreaterThan(-1)
      observe('blast-adjacency', { droppedMs, reformedMs })
    } finally {
      if (!restored && session.isOpen) await session.abort().catch(() => undefined)
    }
  })

  it('net-zero — both OSPF configs are back to the provisioning shape and no sessions stay open', { timeout: 120_000 }, async () => {
    for (const [label, node, loopback] of [['A', nodeA as Node, '10.156.0.1'], ['B', nodeB as Node, PEER_LINK.bLoopback]] as const) {
      const [item] = await node.exec(['show running-config | section router ospf'], { format: 'text' })
      // The lane's own unwrapper: text replies carry the body under output|text, at the
      // reply level or under the exec wrapper — both shapes, never a silent ''.
      const text = hwReadBackOutput(item)
      expect(text, `${label}: transit network restored`).toContain(PEER_LINK.subnet)
      expect(text, `${label}: loopback advertisement restored`).toContain(`${loopback}/32`)
      const sessions = await jsonRead(node, 'show configuration sessions')
      const open = Object.entries((sessions as { sessions?: Record<string, { state?: string }> }).sessions ?? {}).filter(([, s]) => /pending|open|committed/iu.test(String(s?.state ?? '')))
      expect(open, `${label}: blast sessions must leave no open/pending session behind`).toEqual([])
      observe('net-zero', { node: label })
    }
  })
})
