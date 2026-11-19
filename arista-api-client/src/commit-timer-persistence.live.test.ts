/**
 * Commit-timer / persistence-verbs live suite (#154 item 6 = #89 open items 5 + 7, container lane).
 *
 * Runs ONLY against a full-write lab (`EAPI_LAB_FULL_WRITE=1` + DR-035 `lab` class):
 * `npm run lab:run -- npm -w arista-api-client run test:live -- src/commit-timer-persistence.live.test.ts`.
 * `npm test` never reaches a device (DR-034); a run without full-write consent SKIPS with a named reason.
 *
 * Why the container is the only place this class can run (#154 item 6 header): `copy run start` /
 * `configure replace` / `rollback clean-config` sit behind the hardware `HW_PROBE_FORBIDDEN` fence on
 * the real unit, and the commit-timer *revert handler* is native below the image's Python. This suite
 * is disposable by construction: it arms a short revert timer, observes across sessions, and lets the
 * harness destroy the container before any long timer could matter — nothing is persisted anywhere
 * (DR-035(c): no `copy run start`; `assertNoPersistenceCommand` fences it, and this suite never asks
 * for `persist: true`).
 *
 * What it answers (#89 open item 5 — the box already answered these in run 5 / DR-137; this is the
 * CONTAINER verdict, never a cross-claim, DR-043):
 *   1. does `commit timer <hh:mm:ss>` ACCEPT on cEOS-lab, and does the reentered session appear in
 *      the plain `show configuration sessions` listing carrying `commitBy` (the deadline) + a pending
 *      state? (container spelling of `state: "pendingCommitTimer"` is itself a finding);
 *   2. does the held revert actually FIRE (scratch VLAN vanishes at the deadline) — the revert-fires
 *      half of item 5 on the container;
 *   3. does a SECOND `commit` before the deadline (the client's `confirmRevertTimer`) END the revert,
 *      and does the change then PERSIST past the original deadline — confirming-vs-resetting, which
 *      is the still-open half even on hardware (DR-137);
 *   4. what does a held timer do to a LATER session — open + abort another session while armed, and
 *      record ACCEPT-or-refuse (a 1006 config-lock is a legitimate container answer, DR-134).
 *
 * #89 open item 7 (real session-name length/charset limits): the client's own bounds are asserted
 * OFFLINE here (test 5 — MAX_SESSION_NAME_LENGTH=64 + the charset refusals are THIS port's, fired
 * before the wire) and shown WORKABLE against the device (test 6). The DEVICE-bound discovery is left
 * a gated stub (tests 7+8): the command layer refuses a raw config opener via `exec` (by design), so
 * probing past the client's 64 needs a transport-level bypass under operator consent on a cleared
 * host — recorded as a concrete plan, NOT faked here. (item 8 — which verbs answer 1002/1004 — was
 * already settled by the 2026-11-16 part B: copy-run-start ACCEPTED, configure-replace exists,
 * rollback clean-config exec 1002; this suite does not re-litigate it.)
 *
 * GATED + verified-offline-only (DR-147): the local run that would produce these container verdicts is
 * blocked by the host BPF fault (DR-145/DR-146), so until the run happens on a cleared host, #89 items
 * 5-7 read implemented/evidence-pending — never observed, never unsupported.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { NotSupportedError } from './errors'
import { type Node } from './command-layer'
import { MAX_SESSION_NAME_LENGTH } from './config-session'
import { buildFullWriteNode } from './testing/live-full-write'
import { describeLiveTarget, matchesDeviceIdentity, resolveLiveEnv, unwrapLiveTarget } from './testing/live-guard'

// --- contract ------------------------------------------------------------------------------------
// Each timer arm uses its OWN scratch VLAN so the sequential revert/confirm cleanups cannot collide.
const SCRATCH_VLANS = { listing: 140, revert: 141, confirm: 142 } as const
// 00:02:00 is the shortest timer the box is known to accept (run 5 / DR-137 used it); 00:00:00 is
// refused ("Time value cannot be zero"). 2 min keeps the wall time bounded and reviewer-challengeable.
const TIMER = '00:02:00'
const TIMER_MS = 120_000
// Poll past the deadline by this margin before declaring the revert "fired"; a revert that has not
// fired by deadline+MARGIN is RECORDED as the answer (it may confirm/reset), not asserted away.
const DEADLINE_MARGIN_MS = 45_000
const PENDING_RE = /pending|committimer/iu

const primary = resolveLiveEnv(process.env)
const fullWrite = process.env['EAPI_LAB_FULL_WRITE'] === '1'
const runnable = primary.ok && fullWrite
const labClass = primary.ok && primary.targetClass === 'lab'

if (!runnable) {
  const why = !primary.ok ? `primary refused (DR-034): ${primary.reason}` : 'EAPI_LAB_FULL_WRITE=1 is required — this suite arms commit revert timers that mutate running-config'
  console.warn(`commit-timer-persistence: SKIPPED — ${why}`)
} else if (!labClass) {
  console.warn('commit-timer-persistence: SKIPPED — lab class only; never point this suite at a physical switch (#154, DR-035)')
}

let node: Node | undefined
const scratchSessions = new Set<string>()

interface Obs {
  step: string
  at: string
  [k: string]: unknown
}
const evidence: { generatedAt: string | undefined; observations: Obs[] } = { generatedAt: undefined, observations: [] }
const observe = (step: string, data: Record<string, unknown>): void => {
  evidence.observations.push({ step, at: new Date().toISOString(), ...data })
}

async function jsonRead(n: Node, command: string): Promise<Record<string, unknown>> {
  const [item] = await n.exec([command], { format: 'json' })
  if (item === undefined) throw new Error(`no reply for ${command}`)
  return (((item as { result?: unknown }).result ?? item) as Record<string, unknown>) ?? {}
}

function vlanPresent(n: Node, id: number): Promise<boolean> {
  return jsonRead(n, 'show vlan').then((m) => {
    const vlans = (m as { vlans?: Record<string, unknown> }).vlans
    return vlans !== undefined && Object.prototype.hasOwnProperty.call(vlans, String(id))
  })
}

/** A session as the plain listing reports it, by name, or undefined if absent. */
async function findSession(name: string): Promise<{ state: string; commitBy?: number } | undefined> {
  if (node === undefined) throw new Error('node not built')
  const sessions = await node.listSessions()
  const s = sessions.sessions.find((x) => x.name === name)
  if (s === undefined) return undefined
  return s.commitBy === undefined ? { state: s.state } : { state: s.state, commitBy: s.commitBy }
}

async function pollUntil(boundMs: number, stepMs: number, done: () => Promise<boolean>): Promise<number> {
  const t0 = Date.now()
  for (;;) {
    if (await done()) return Date.now() - t0
    if (Date.now() - t0 > boundMs) return -1
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function identityOf(n: Node): Promise<{ version: string; modelName: string }> {
  const v = await jsonRead(n, 'show version')
  return { version: String((v as { version?: string }).version ?? ''), modelName: String((v as { modelName?: string }).modelName ?? '') }
}

/** Arm a revert timer that CREATES `vlanId` on a freshly created scratch session; the session name is
 * tracked so the teardown can best-effort clean any that survive. `accepted:false` + a reason is a
 * recorded device refusal (DR-134), not a thrown failure. Returns the listed pending state if any. */
async function armScratchTimer(name: string, vlanId: number): Promise<{ accepted: boolean; reason?: string; session?: { state: string; commitBy?: number } }> {
  if (node === undefined) throw new Error('node not built')
  scratchSessions.add(name)
  try {
    const s = await node.configSession({ name, description: '#154 item 6 revert-timer scratch' })
    await s.run([`vlan ${String(vlanId)}`, `   name LAB-TIME-${String(vlanId)}`])
    await s.commitWithRevertTimer(TIMER) // closes the handle as 'committed' (finish) — nothing to abort
    const listing = await findSession(name)
    return { accepted: true, ...(listing === undefined ? {} : { session: listing }) }
  } catch (error) {
    const message = `${(error as Error).name}: ${(error as Error).message.slice(0, 200)}`
    return { accepted: false, reason: message }
  }
}

beforeAll(async () => {
  if (!runnable || !primary.ok || !labClass) return
  node = buildFullWriteNode(unwrapLiveTarget(primary))
  console.log(`commit-timer-persistence: target=${describeLiveTarget(unwrapLiveTarget(primary))}`)
  const id = await identityOf(node)
  const mismatch = matchesDeviceIdentity(unwrapLiveTarget(primary), id)
  expect(mismatch, `identity gate (reported ${JSON.stringify(id)})`).toBeUndefined()
  expect(id.modelName, 'must be a cEOS container (DR-043)').toMatch(/^ceos/iu)
  observe('identity', { ...id })
})

afterAll(async () => {
  // A revert timer that has not fired yet leaves a pending session holding the config lock; best-
  // effort abort of this suite's own scratch sessions. Never aborts a non-live/session we do not own.
  if (node !== undefined) {
    for (const name of scratchSessions) {
      await node.abortSession(name).catch(() => undefined)
    }
  }
  await node?.close().catch(() => undefined)
  if (!runnable || !labClass) return
  evidence.generatedAt = new Date().toISOString()
  const text = JSON.stringify(evidence, null, 2)
  const secret = process.env['EAPI_PASS']
  if (secret !== undefined && secret !== '') expect(text.includes(secret), 'evidence artifact must never carry a lab credential').toBe(false)
  if (process.env['EAPI_TWO_NODE_EVIDENCE'] === '1') {
    const out = path.resolve(process.cwd(), '..', 'docs', 'evidence', 'commit-timer-persistence.ceos.json')
    mkdirSync(path.dirname(out), { recursive: true })
    writeFileSync(out, `${text}\n`, 'utf8')
    console.log(`commit-timer-persistence: evidence written to ${out} (review artifact, never a fixture — #154)`)
  } else {
    console.log(`commit-timer-persistence: evidence (EAPI_TWO_NODE_EVIDENCE unset — printed only)\n${text}`)
  }
}, 30_000)

describe.skipIf(!runnable || !labClass)('commit timer / persistence verbs (#154 item 6 = #89 items 5+7, container evidence only)', () => {
  it('`commit timer` ACCEPTS on the container and the reentered session lists with commitBy + a pending state', { timeout: 120_000 }, async () => {
    expect(node).toBeDefined()
    const armed = await armScratchTimer('lab-timer-listing', SCRATCH_VLANS.listing)
    expect(armed.accepted, `\`commit timer ${TIMER}\` must be accepted (grammar verified in image; container verdict recorded here) — refused: ${armed.reason ?? ''}`).toBe(true)
    const listing = armed.session
    expect(listing, 'the armed session must appear on the plain `show configuration sessions` listing').toBeDefined()
    // The container spelling of the pending state is itself the finding (box used "pendingCommitTimer").
    expect(PENDING_RE.test(listing!.state), `armed session state is a pending/timer state (container answered ${JSON.stringify(listing!.state)})`).toBe(true)
    observe('commit-timer-accepted', { state: listing!.state, hasCommitBy: listing!.commitBy !== undefined, commitBy: listing!.commitBy })
  })

  it('an unattended revert timer FIRES: the scratch VLAN is gone at the deadline (item 5, revert half)', { timeout: 240_000 }, async () => {
    expect(node).toBeDefined()
    const armed = await armScratchTimer('lab-timer-revert', SCRATCH_VLANS.revert)
    expect(armed.accepted, `arm refused: ${armed.reason ?? ''}`).toBe(true)
    expect(await vlanPresent(node as Node, SCRATCH_VLANS.revert), 'scratch VLAN must be live right after the timed commit').toBe(true)
    const goneMs = await pollUntil(TIMER_MS + 2 * DEADLINE_MARGIN_MS, 5_000, async () => !(await vlanPresent(node as Node, SCRATCH_VLANS.revert)))
    observe('revert-fired', { vlanGoneAfterMs: goneMs })
    expect(goneMs, `the scratch VLAN must be reverted by ~deadline+margin (${TIMER}) — if it persisted, that is the confirm/reset finding, captured in the next test`).toBeGreaterThan(-1)
  })

  it('a SECOND commit before the deadline ends the revert (item 5, confirm-vs-reset still-open half)', { timeout: 300_000 }, async () => {
    expect(node).toBeDefined()
    const armed = await armScratchTimer('lab-timer-confirm', SCRATCH_VLANS.confirm)
    expect(armed.accepted, `arm refused: ${armed.reason ?? ''}`).toBe(true)
    // confirmRevertTimer = the client's intended "end the pending revert by committing again". The box
    // left this half open (DR-137); the container answer is what we record. If the session already
    // left the pending list, the device rejected the second commit — also the finding.
    const pending = armed.session !== undefined && PENDING_RE.test(armed.session.state)
    expect(pending, 'a revert must be pending before the second commit is meaningful').toBe(true)
    const s2 = await (node as Node).configSession({ name: 'lab-timer-confirm', description: '#154 item 6 second commit' })
    let endedPending = false
    try {
      await s2.confirmRevertTimer()
      endedPending = true
    } catch (error) {
      observe('confirm-revert-timer-refused', { errorName: (error as Error).name, message: (error as Error).message.slice(0, 200) })
    } finally {
      if (s2.isOpen) await s2.abort().catch(() => undefined)
    }
    if (endedPending) {
      // The revert was ended by the second commit; past the ORIGINAL deadline the change must persist.
      await sleep(TIMER_MS + DEADLINE_MARGIN_MS)
      const persisted = await vlanPresent(node as Node, SCRATCH_VLANS.confirm)
      const stillPending = await findSession('lab-timer-confirm')
      observe('second-commit-outcome', { endedPending, persistedPastDeadline: persisted, stillPendingState: stillPending?.state ?? null })
      expect(persisted, 'a second commit that ended the revert must let the change persist past the original deadline (confirms OR resets)')
        .toBe(true)
      // Best-effort cleanup: remove the persisted scratch VLAN so the run is net-zero if reused.
      const rm = await (node as Node).configSession({ name: 'lab-timer-cleanup', description: '#154 net-zero' })
      try {
        await rm.run([`no vlan ${String(SCRATCH_VLANS.confirm)}`])
        await rm.commit()
      } finally {
        if (rm.isOpen) await rm.abort().catch(() => undefined)
      }
    }
  })

  it('a held revert timer vs a LATER session: opening/aborting another session is ACCEPT or recorded refusal (item 5)', { timeout: 300_000 }, async () => {
    expect(node).toBeDefined()
    await armScratchTimer('lab-timer-blockcheck', SCRATCH_VLANS.confirm)
    // While the timer above is armed, a second, different scratch session tries to open + abort. The
    // box allowed this (DR-137); a container 1006 config-lock is a legitimate answer (DR-134) — the
    // verdict is the evidence, not a thrown failure.
    let opened = false
    let refused = ''
    try {
      const s = await (node as Node).configSession({ name: 'lab-timer-second', description: '#154 item 6 block-check' })
      scratchSessions.add('lab-timer-second')
      await s.run(['vlan 145', '   name LAB-TIMER-2ND'])
      opened = true
      await s.abort()
    } catch (error) {
      refused = `${(error as Error).name}: ${(error as Error).message.slice(0, 200)}`
    }
    observe('timer-vs-later-session', { laterSessionOpened: opened, refused: refused || null })
    expect(opened || refused !== '', 'the later-session outcome must be recorded either way (opened, or a named refusal)').toBe(true)
    // Leave no second-session residue if it opened and its abort was clean; the finally-above aborted it,
    // and the teardown aborts anything left.
  })

  it('CLIENT bounds: MAX_SESSION_NAME_LENGTH + charset refusals fire before the wire (#89 item 7, this port)', { timeout: 10_000 }, async () => {
    expect(node).toBeDefined()
    // These are THIS port's bounds (config-session.ts), not a captured device limit — assert them
    // offline-ishly here so the distinction is pinned next to the device-bound probes.
    const tooLong = 'x'.repeat(MAX_SESSION_NAME_LENGTH + 1)
    await expect(node!.configSession({ name: tooLong })).rejects.toBeInstanceOf(NotSupportedError)
    await expect(node!.configSession({ name: 'bad name' })).rejects.toBeInstanceOf(NotSupportedError)
    await expect(node!.configSession({ name: 'bad;name' })).rejects.toBeInstanceOf(NotSupportedError)
    await expect(node!.configSession({ name: '' })).rejects.toBeInstanceOf(NotSupportedError)
    observe('client-name-bounds', { max: MAX_SESSION_NAME_LENGTH, refusedBeforeWire: true })
  })

  it('a client-bound session name (≤64, safe charset) WORKS against the device and aborts clean (#89 item 7 workable)', { timeout: 60_000 }, async () => {
    expect(node).toBeDefined()
    const name = `lab-timer-name64-${'z'.repeat(MAX_SESSION_NAME_LENGTH - 17)}` // exactly 64 chars
    expect(name.length, 'probe name is exactly the client max').toBe(MAX_SESSION_NAME_LENGTH)
    scratchSessions.add(name)
    const s = await (node as Node).configSession({ name })
    expect(s.isOpen, 'the client-max name opens a real session').toBe(true)
    const listed = await findSession(name)
    // `configure session <name>` opened it; even before any staged write it may or may not list — the
    // honest assertion is that opening under the client bound did not error and aborts clean.
    await s.abort()
    observe('device-accepts-client-bound-name', { nameLength: name.length, listedWhileOpen: listed !== undefined, abortedClean: true })
    expect(await findSession(name), 'aborted client-bound name is gone from the listing').toBeUndefined()
  })

  // DEVICE-bound discovery — concrete plan, NOT faked here. The command layer refuses a raw config
  // opener via exec() (by design, command-layer), and buildFullWriteNode's Node has no raw-config
  // bypass; discovering the device's TRUE length/charset bounds (past the client's 64 / charset)
  // requires issuing `configure session <name>` at the transport level (bypassing assertSessionName)
  // under operator consent + a cleared host, then aborting any session that opens. Left as reviewable
  // stubs so the shape and the safety requirement are on record without pretending the wire works on
  // the BPF-blocked host (DR-146/DR-147).
  it.skip('DEVICE-bound session-name length discovery (#89 item 7 — needs a transport-level opener + cleared host)', () => {
    // Bisection over raw `configure session <alphanumeric 1..n>`; record max accepted length then
    // abort each opener. Never run past the client bound without a reviewable transport bypass.
  })
  it.skip('DEVICE-bound session-name charset discovery (#89 item 7 — needs a transport-level opener + cleared host)', () => {
    // For each single delimiter/quote byte the client also refuses, raw-open and record accept/refuse
    // then abort. HIGH RISK: bytes like ';' can terminate the opener, so requires a disposable target
    // (the harness container is one) and operator consent. Not blind-probed here.
  })
})
