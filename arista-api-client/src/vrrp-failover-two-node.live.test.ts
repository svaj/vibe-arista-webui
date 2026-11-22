/**
 * Two-node VRRP failover blast live suite (#87 item 1, container lane).
 *
 * Runs ONLY against a `--nodes 2 --vrrp` lab:
 *   `npm run lab:run -- --nodes 2 --vrrp --no-fixtures -- npm -w arista-api-client run
 *    test:live -- src/vrrp-failover-two-node.live.test.ts` (docs/CEOS.md).
 * The harness wires a SHARED L2 segment between the pair and provisions a VRRP pair on
 * Vlan200 (A priority 150 / B priority 100, one VIP), exported to this child as
 * `EAPI_VRRP_*`. Any other live run SKIPS this file with a named reason; `npm test`
 * never reaches a device at all (DR-034).
 *
 * What it claims (cEOS-lab 4.28.14M container evidence, never 7050TX parity, DR-043):
 *   1. a VRRP pair forms over the shared segment: A is MASTER, B is BACKUP for the VIP
 *      (the DR-122 "show vrrp answers 1002" verdict was an UNCONFIGURED-container
 *      reading — with a configured group the eAPI model populates, 2026-11-22 probe);
 *   2. THE MEASUREMENT #87 item 1 asked for: disabling the group on the MASTER (the
 *      client's own `disabled` arm, committed through a configSession) promotes the
 *      BACKUP — the elapsed ms from commit to B-MASTER is the failover blast timing the
 *      webui's second-confirm copy has always said is unmeasured;
 *   3. the reverse: re-enabling on A preempts the master role back (A 150 > B 100,
 *      preempt on both), and B returns to BACKUP — measured too;
 *   4. net-zero: both Vlan200 stanzas back to the provisioning shape, no open sessions.
 * Time bounds are generous (the device-side master_down interval is ~3.6 s at default
 * timers); the OBSERVED timings land in the evidence artifact
 * (`EAPI_TWO_NODE_EVIDENCE=1` → docs/evidence/vrrp-failover-two-node.ceos.json — review
 * evidence, never fixtures).
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
 * Mirrors `VRRP_LINK` in scripts/ceos-lab.mjs, with the run's exported values preferred
 * when present (the harness exports what it provisioned; drift fails test 1 loudly).
 */
const VRRP = {
  vlan: Number(process.env['EAPI_VRRP_VLAN'] ?? '200'),
  vip: process.env['EAPI_VRRP_VIP'] ?? '10.0.200.254',
  vrid: Number(process.env['EAPI_VRRP_VRID'] ?? '1'),
  aIp: process.env['EAPI_VRRP_A_IP'] ?? '10.0.200.1',
  bIp: process.env['EAPI_VRRP_B_IP'] ?? '10.0.200.2',
  aPriority: Number(process.env['EAPI_VRRP_A_PRIORITY'] ?? '150'),
  bPriority: Number(process.env['EAPI_VRRP_B_PRIORITY'] ?? '100'),
} as const
const SVI = `Vlan${String(VRRP.vlan)}`

const primary = resolveLiveEnv(process.env)

/** Re-key the run's `EAPI_PEER_*` set into the standard contract so the peer passes the
 * SAME guard the primary does — loopback-only, cert-pinned, model/version-pinned. */
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
const hasVrrp = process.env['EAPI_VRRP_VIP'] !== undefined && process.env['EAPI_VRRP_VIP'].trim() !== ''
const peer: LiveResolution | undefined = primary.ok && hasPeer ? resolvePeerEnv(process.env) : undefined

const fullWrite = process.env['EAPI_LAB_FULL_WRITE'] === '1'
const runnable = primary.ok && peer !== undefined && peer.ok && fullWrite && hasVrrp
const labClass = primary.ok && primary.targetClass === 'lab'

if (!runnable) {
  const why = !primary.ok
    ? `primary refused (DR-034): ${primary.reason}`
    : peer === undefined
      ? 'no EAPI_PEER_* in the environment — start the run with `npm run lab:run -- --nodes 2 --vrrp …` (#87)'
      : !peer.ok
        ? `peer refused its guard: ${peer.reason}`
        : !hasVrrp
          ? 'no EAPI_VRRP_* in the environment — the run was not built with --vrrp (#87)'
          : 'EAPI_LAB_FULL_WRITE=1 is required — this suite commits on both nodes'
  console.warn(`vrrp-failover-two-node: SKIPPED — ${why}`)
} else if (!labClass) {
  console.warn('vrrp-failover-two-node: SKIPPED — lab class only; never point this suite at a physical switch (#87, DR-035)')
}

let nodeA: Node | undefined
let nodeB: Node | undefined
interface FailoverEvidence {
  generatedAt: string | undefined
  targetClass: string
  harness: string
  vrrp: typeof VRRP
  observations: Record<string, unknown>[]
}
const evidence: FailoverEvidence = {
  generatedAt: undefined,
  targetClass: 'ceos-lab-container',
  harness: 'scripts/ceos-lab.mjs --nodes 2 --vrrp',
  vrrp: VRRP,
  observations: [],
}
const observe = (step: string, data: Record<string, unknown>): void => {
  evidence.observations.push({ step, at: new Date().toISOString(), ...data })
}

/** One JSON read, unwrapped (the run-5 lesson: the device reply lives under `result`). */
async function jsonRead(node: Node, command: string): Promise<Record<string, unknown>> {
  const [item] = await node.exec([command], { format: 'json' })
  if (item === undefined) throw new Error(`no reply for ${command}`)
  const unwrapped = (item as { result?: unknown }).result ?? item
  return (unwrapped as Record<string, unknown>) ?? {}
}

/** `show vrrp` entries for THIS lane's SVI/VRID. The model is `virtualRouters: []` on an
 * unconfigured box (DR-122) and a populated array once a group is live (2026-11-22
 * probe) — entries are matched by interface + groupId, never by array position. */
function vrrpEntry(model: Record<string, unknown>): Record<string, unknown> | undefined {
  const routers = (model as { virtualRouters?: unknown }).virtualRouters
  const list: Record<string, unknown>[] = Array.isArray(routers)
    ? (routers as Record<string, unknown>[])
    : (Object.values((routers as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>[])
  return list.find((e) => String(e['interface'] ?? '') === SVI && Number(e['groupId'] ?? -1) === VRRP.vrid)
}

async function readVrrp(node: Node): Promise<Record<string, unknown> | undefined> {
  return vrrpEntry(await jsonRead(node, 'show vrrp'))
}

/** Poll a read until `done` answers true or the bound expires. Returns elapsed ms, or -1
 * when the bound expired (DR-019: a missed transition reads as a failed assertion). */
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
  console.log(`vrrp-failover-two-node: A=${describeLiveTarget(unwrapLiveTarget(primary))} · B=${describeLiveTarget(unwrapLiveTarget(peer))}`)
  const versionPin = process.env['EAPI_ALLOW_VERSION'] ?? ''
  for (const [label, node, target] of [['A', nodeA, unwrapLiveTarget(primary)], ['B', nodeB, unwrapLiveTarget(peer)]] as const) {
    const id = await identityOf(node)
    const mismatch = matchesDeviceIdentity(target, id)
    expect(
      mismatch === undefined || mismatch.code === 'EAPI_VERSION_MISMATCH',
      `identity gate for ${label} (reported ${JSON.stringify(id)}): ${mismatch?.reason ?? ''}`,
    ).toBe(true)
    expect(id.modelName, `${label} must be a cEOS container (DR-043)`).toMatch(/^ceos/iu)
    if (versionPin !== '') expect(id.version.includes(versionPin), `${label} release must carry ${versionPin}`).toBe(true)
    observe('identity', { node: label, ...id })
  }
}, 120_000)

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
    const out = path.resolve(process.cwd(), '..', 'docs', 'evidence', 'vrrp-failover-two-node.ceos.json')
    mkdirSync(path.dirname(out), { recursive: true })
    writeFileSync(out, `${text}\n`, 'utf8')
    console.log(`vrrp-failover-two-node: evidence written to ${out} (review artifact, never a fixture — #87)`)
  } else {
    console.log(`vrrp-failover-two-node: evidence (EAPI_TWO_NODE_EVIDENCE unset — printed only)\n${text}`)
  }
}, 30_000)

describe.skipIf(!runnable || !labClass)('two-node VRRP failover blast (#87 item 1, container evidence only)', () => {
  it('the pair forms: A is MASTER (150), B is BACKUP (100) for the VIP', { timeout: 300_000 }, async () => {
    expect(nodeA).toBeDefined()
    expect(nodeB).toBeDefined()
    const aMs = await pollUntil(240_000, 5_000, async () => {
      const e = await readVrrp(nodeA as Node)
      return e !== undefined && String(e['state'] ?? '').toLowerCase() === 'master'
    })
    expect(aMs, `A must hold the VIP as MASTER within 240s (shared-L2 formation + STP convergence)`).toBeGreaterThan(-1)
    const entryA = await readVrrp(nodeA as Node)
    expect(String(entryA?.['virtualIp'] ?? ''), 'A-side entry must carry the VIP').toBe(VRRP.vip)
    expect(Number(entryA?.['priority'] ?? -1), 'A must run the provisioned master priority').toBe(VRRP.aPriority)
    const bMs = await pollUntil(120_000, 5_000, async () => {
      const e = await readVrrp(nodeB as Node)
      return e !== undefined && String(e['state'] ?? '').toLowerCase() === 'backup'
    })
    expect(bMs, 'B must see A advertising and settle as BACKUP').toBeGreaterThan(-1)
    const entryB = await readVrrp(nodeB as Node)
    expect(Number(entryB?.['priority'] ?? -1), 'B must run the provisioned backup priority').toBe(VRRP.bPriority)
    expect(String(entryB?.['masterAddr'] ?? ''), 'B must name A as the current master').toBe(VRRP.aIp)
    observe('pair-formed', { aMasterAfterMs: aMs, bBackupAfterMs: bMs, entryA, entryB })
  })

  it('blast — disabling the group on A promotes B to MASTER; the reverse restores A by preempt', { timeout: 600_000 }, async () => {
    const session = await (nodeA as Node).configSession({ name: 'vrrp-blast-disable', description: '#87 blast: master leaves the group' })
    let restored = false
    try {
      await session.run([`interface ${SVI}`, `vrrp ${String(VRRP.vrid)} disabled`])
      await session.commit()
      // The measurement: commit → B-MASTER. Device-side master_down at default timers is
      // ~3.6s; the bound is generous and the OBSERVED ms is the artifact's payload.
      const promotedMs = await pollUntil(180_000, 1_000, async () => {
        const e = await readVrrp(nodeB as Node)
        return e !== undefined && String(e['state'] ?? '').toLowerCase() === 'master'
      })
      expect(promotedMs, 'B must TAKE the VIP once A stops advertising (the failover blast)').toBeGreaterThan(-1)
      const entryB = await readVrrp(nodeB as Node)
      expect(String(entryB?.['masterAddr'] ?? ''), 'B must see itself as master').toBe(VRRP.bIp)
      const aLeftMs = await pollUntil(60_000, 1_000, async () => {
        const e = await readVrrp(nodeA as Node)
        return e === undefined || String(e['state'] ?? '').toLowerCase() !== 'master'
      })
      expect(aLeftMs, 'A must no longer claim MASTER once its group is disabled').toBeGreaterThan(-1)

      const reverse = await (nodeA as Node).configSession({ name: 'vrrp-blast-restore', description: '#87 blast: master rejoins and preempts back' })
      restored = true
      try {
        await reverse.run([`interface ${SVI}`, `no vrrp ${String(VRRP.vrid)} disabled`])
        await reverse.commit()
      } finally {
        if (reverse.isOpen) await reverse.abort().catch(() => undefined)
      }
      const preemptMs = await pollUntil(180_000, 1_000, async () => {
        const e = await readVrrp(nodeA as Node)
        return e !== undefined && String(e['state'] ?? '').toLowerCase() === 'master'
      })
      expect(preemptMs, 'A (priority 150, preempt) must take the VIP back after re-enable').toBeGreaterThan(-1)
      const bBackMs = await pollUntil(120_000, 2_000, async () => {
        const e = await readVrrp(nodeB as Node)
        return e !== undefined && String(e['state'] ?? '').toLowerCase() === 'backup'
      })
      expect(bBackMs, 'B must yield BACKUP after A preempts (net-zero roles)').toBeGreaterThan(-1)
      observe('blast-failover', { bPromotedAfterMs: promotedMs, aLeftAfterMs: aLeftMs, aPreemptedBackAfterMs: preemptMs, bYieldedAfterMs: bBackMs, bEntryAtMaster: entryB })
    } finally {
      if (!restored && session.isOpen) await session.abort().catch(() => undefined)
    }
  })

  it('net-zero — both Vlan200 stanzas are back to the provisioning shape and no sessions stay open', { timeout: 120_000 }, async () => {
    for (const [label, node, sviIp, priority] of [
      ['A', nodeA as Node, VRRP.aIp, VRRP.aPriority],
      ['B', nodeB as Node, VRRP.bIp, VRRP.bPriority],
    ] as const) {
      const [item] = await node.exec([`show running-config | section interface ${SVI}`], { format: 'text' })
      const text = hwReadBackOutput(item)
      expect(text, `${label}: SVI addressing intact`).toContain(sviIp)
      expect(text, `${label}: vrrp arm intact`).toContain(`vrrp ${String(VRRP.vrid)} ipv4 ${VRRP.vip}`)
      // Priority/preempt are asserted on the RUNTIME model, not the text: EOS stores
      // neither a priority-level equal to the default (100 — B's line never lands in
      // running-config, verified 2026-11-22) nor the default-on `preempt`, and it
      // reorders the stored lines (priority-level before ipv4 on A).
      expect(text, `${label}: no disabled line left behind`).not.toContain(`vrrp ${String(VRRP.vrid)} disabled`)
      const entry = await readVrrp(node)
      expect(Number(entry?.['priority'] ?? -1), `${label}: runtime priority back to provisioned`).toBe(priority)
      expect(String(entry?.['preempt'] ?? ''), `${label}: preempt back on`).toBe('true')
      expect(String(entry?.['state'] ?? '').toLowerCase(), `${label}: role back to the provisioned one`).toBe(label === 'A' ? 'master' : 'backup')
      // Assert THIS lane's blast sessions are gone — not "no session exists": the harness
      // deliberately leaves a `lab-pending-capture` session open (a #62 capture), so a
      // blanket pending/open filter would fail on harness topology, not on the lane.
      const sessions = await jsonRead(node, 'show configuration sessions')
      const mine = Object.keys((sessions as { sessions?: Record<string, unknown> }).sessions ?? {}).filter((name) => name.startsWith('vrrp-blast'))
      expect(mine, `${label}: blast sessions must not linger open/pending`).toEqual([])
      observe('net-zero', { node: label, lingeringBlastSessions: mine, priority: entry?.['priority'], preempt: entry?.['preempt'], state: entry?.['state'] })
    }
  })
})
