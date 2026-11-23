/**
 * `persistence-hardware.live.test.ts` — the #89 physical persistence-verb lane, run only under the
 * owner authorization recorded 2026-11-21 ("copy run start is fine; a minimal change can be run via
 * configure replace and rollback; scripted and reviewable before executing"). This is the ONE file
 * `docs/TESTING.md:157-159` reserved for a dedicated persistence test, and the second lane ever
 * admitted past the hardware write fence (after `hw-session-probe`). It never calls
 * {@link assertNoPersistenceCommand} — that exemption is the whole point of the file — and no other
 * lane may borrow it.
 *
 * ## Consent chain (all must hold, or the file skips loudly — DR-034)
 * - `resolveLiveEnv` accepts the endpoint (hardware class: exact model/version pins + `EAPI_HW_CONSENT`
 *   echo; or lab class for the `--rehearse` path).
 * - `requireHwPersistenceConsent`: `EAPI_HW_PERSISTENCE=1` AND `EAPI_HW_PERSISTENCE_CONSENT` typed as an
 *   exact echo of `EAPI_SCRATCH_INTERFACE` (the operator names the mutated port by hand).
 * - the scratch port clears `requireScratchInterface` (hardware only through `hardwarePersistence: true`),
 *   and on hardware its `linkStatus` must not be `connected`/`errdisabled` before a mutating verb
 *   (the same "unused is the operator's declaration, connected is the device's contradiction" gate as
 *   `hw-session-probe`).
 * - the device must self-report the pinned identity before any write.
 *
 * ## The plan, and why each verb is shaped the way it is
 * `EAPI_HW_PERSISTENCE_VERBS` is a comma list of `copy`, `replace`, `rollback` (default `copy,rollback`
 * — the two the lane can run WITHOUT touching running-config destructively; `replace` must be named
 * explicitly because it is the wholesale one). Every step is observed and self-restoring:
 *
 * - **copy** (`copy running-config startup-config`): baseline `show startup-config` (TEXT — the JSON
 *   form answers 1003 on this build, captured 2026-11-16), run the save, re-read. The before/after flip
 *   is the persistence proof. Authorized explicitly; startup-config is the one file this verb may write.
 * - **replace** (`configure replace <surl>`): the ONLY step that mutates running-config, and it is
 *   fenced to a single scratch-interface line and fully restored. The lane snapshots current running to
 *   `flash:hw-persist-<tag>.cfg` (`copy running-config flash:` — a scratch file, never startup), commits
 *   a one-line marker on the scratch port through a named session, then `configure replace
 *   flash:hw-persist-<tag>.cfg` re-mounts the snapshot (marker gone). The snapshot file is left in flash
 *   (no `delete` — its prompt is a hang hazard over eAPI); the runner names it for hand-cleanup.
 * - **rollback** (`rollback clean-config`, `rollback <name>`): captured ABORT-ONLY. Each is staged inside
 *   a named session, its `session.diff()` recorded (the would-be blast), then the session is ABORTED —
 *   nothing is ever committed. A refusal is recorded as the answer (DR-134). This answers "does the verb
 *   exist on 4.28.13.1M and what is its diff" with zero applied change, which is the most a production
 *   box should ever see from a `clean-config` question.
 *
 * - **rollback-name** (S1, #182 — the `rollback <name>` decoupled slot probe): the confounded step
 *   above rolls back to the REPLACE step's committed session, so DR-158 could not separate "`configure
 *   replace` clears the one-slot completed store" from "the slot simply aged out." This verb commits its
 *   OWN scratch-port marker session and rolls back to THAT (no replace in its way), reading
 *   `show configuration sessions detail` immediately (does the fresh `completed` entry appear?) then
 *   again after a controlled ~60 s wait with NO intervening mutating op (does it survive elapsed time?).
 *   Comparing `completedSlotHoldsImmediate` to `completedSlotHoldsAged` separates seconds-fast aging
 *   (both empty) from commit+elapsed aging (present → empty); a clean run named WITHOUT `replace`
 *   isolates that from replace-window clearing (the DR-158/DR-159 open question that gates DR-160 §3's
 *   rollback UI affordance). Each `rollback <target>` is staged, diffed, and ABORTED; the marker the
 *   verb commits is cleared before it returns. Aborts only — the rollback diff is destructive by
 *   definition, so the net-zero guarantee is the whole design.
 * - **rollback-hyphenfree** (S1, #189 — the DR-161 grammar disambiguator): commits the same kind of
 *   scratch marker under an ALPHANUMERIC session name, verifies that exact name is present in the
 *   completed-slot detail listing, then stages `rollback <target>` in a fresh owned session. A 1002 at
 *   token 1 now points to the verb on this image; an accepted diff localises the refusal to hyphenated
 *   target names. The rollback is always aborted and the marker is always cleared.
 *
 * ## Rehearsal
 * `--rehearse` (the runner boots a throwaway cEOS and sets the lab class + `EAPI_LAB_FULL_WRITE=1`)
 * runs the SAME code path against a disposable container so the operator watches the plan work before
 * pointing it at the switch. Container results never settle hardware behavior (DR-043); the artifact
 * records the target class on every observation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { createNode } from './node'
import { CommandError } from './errors'
import type { ConfigSession } from './config-session'
import type { Node } from './command-layer'
import { describeLiveTarget, liveTransportOptions, matchesDeviceIdentity, requireHwPersistenceConsent, requireScratchInterface, resolveLiveEnv, unwrapLiveTarget, type LiveTarget } from './testing/live-guard'
import { hwProbeRunTag, hwScratchReadBackCommand, hwReadBackOutput } from './testing/hw-capture'

const resolution = resolveLiveEnv(process.env)
const hardware = resolution.ok && resolution.targetClass === 'hardware'
const lab = resolution.ok && resolution.targetClass === 'lab'
const persistenceOn = process.env['EAPI_HW_PERSISTENCE'] === '1'
const labFullWrite = process.env['EAPI_LAB_FULL_WRITE'] === '1'
// The rehearsal path is the lab class carrying the persistence consent with the fixed rehearsal
// echo (the harness picks the scratch port only after boot, so the operator cannot echo it in
// advance); it exists so the operator can watch the plan against a throwaway container. It is NOT
// hardware evidence (DR-043), and it grants no hardware access — the fence is hardware-class-only.
const REHEARSAL_ECHO = 'REHEARSAL-CEOS'
const consent = resolution.ok
  ? requireHwPersistenceConsent(process.env, resolution.targetClass === 'lab' ? { rehearsalEcho: REHEARSAL_ECHO } : {})
  : undefined
const runnable = resolution.ok && persistenceOn && consent === undefined && (hardware || (lab && labFullWrite))

const verbSet = new Set((process.env['EAPI_HW_PERSISTENCE_VERBS'] ?? 'copy,rollback').split(',').map((v) => v.trim().toLowerCase()).filter((v) => v !== ''))
const wants = (verb: string): boolean => verbSet.has(verb)

if (!runnable) {
  const why = !resolution.ok
    ? `endpoint refused (DR-034): ${resolution.ok === false ? resolution.reason : ''}`
    : consent !== undefined
      ? `persistence consent refused: ${consent.reason}`
      : !persistenceOn
        ? 'EAPI_HW_PERSISTENCE=1 is required — the physical persistence-verb lane runs only under the 2026-11-21 owner authorization'
        : 'target class must be hardware, or lab with EAPI_LAB_FULL_WRITE=1 for --rehearse'
  console.warn(`persistence-hardware: SKIPPED — ${why}`)
} else if (lab) {
  console.warn('persistence-hardware: REHEARSAL on a lab container — these observations do NOT settle hardware persistence behavior (DR-043)')
}

const runTag = hwProbeRunTag()
const snapshotFile = `flash:hw-persist-${runTag}.cfg`
const MARKER = `HW-PERSIST-${runTag}`

let node: Node | undefined
let target: LiveTarget
let scratch = ''
const scratchSessions = new Set<string>()
let markerCommitted = false

interface Obs { step: string; at: string; [k: string]: unknown }
const evidence: { generatedAt: string | undefined; targetClass: string; verbs: string[]; snapshotFile: string; observations: Obs[] } = {
  generatedAt: undefined,
  targetClass: resolution.ok ? resolution.targetClass : 'unknown',
  verbs: [...verbSet],
  snapshotFile,
  observations: [],
}
const observe = (step: string, data: Record<string, unknown>): void => {
  evidence.observations.push({ step, at: new Date().toISOString(), ...data })
}

/** Config diffs quote the WHOLE running-config, which on a provisioned device includes the
 *  `username … secret sha512 $6$…` line (observed in the 2026-11-20 rehearsal artifact — the
 *  plaintext-password scan alone does not catch a device-stored hash) AND the
 *  `username … ssh-key ssh-ed25519 AAAA… <comment>` line (observed in the 2026-11-21 HARDWARE
 *  artifact: the key material fell to the generic redactors but the key COMMENT — an operator
 *  workstation identity — survived). Every diff-derived observation passes through here:
 *  credential material is redacted, structure stays countable. */
function redactConfig(text: string): string {
  return text
    .replace(/(secret\s+)\S+/gu, '$1<redacted>')
    .replace(/\$6\$\S+/gu, '<redacted>')
    .replace(/\$1\$\S+/gu, '<redacted>')
    .replace(/^(\s*[-+]?)\s*username\s+\S+\s+ssh-key\s+.*$/gmu, '$1 <username ssh-key redacted>')
}

async function textRead(n: Node, command: string): Promise<string> {
  const [item] = await n.exec([command], { format: 'text' })
  return hwReadBackOutput(item)
}

/** A session as the listing reports it, by name; `detail` reaches completed entries (DR-136: the
 * plain form does not list them on the box). */
async function findSession(name: string, detail = false): Promise<{ state: string; commitBy?: number } | undefined> {
  if (node === undefined) throw new Error('node not built')
  const found = (await node.listSessions(detail ? { detail: true } : {})).sessions.find((s) => s.name === name)
  if (found === undefined) return undefined
  return found.commitBy === undefined ? { state: found.state } : { state: found.state, commitBy: found.commitBy }
}

/** The `completed` sessions the DETAIL form lists right now (the one-slot saved store, DR-136).
 *  A read failure is recorded as data, never thrown — the slot's (un)readability is itself a datum. */
async function completedSlotNames(): Promise<readonly string[]> {
  if (node === undefined) throw new Error('node not built')
  return await node
    .listSessions({ detail: true })
    .then((r) => r.sessions.filter((s) => /completed/iu.test(s.state)).map((s) => s.name))
    .catch((e: unknown) => [`<detail read refused: ${(e as Error).message.slice(0, 80)}>`])
}

/** Stage a scratch-port marker in a named session and commit it (running-config only, never persist). */
async function commitMarker(sessionName: string, marker: string): Promise<void> {
  if (node === undefined) throw new Error('node not built')
  scratchSessions.add(sessionName)
  const session = await node.configSession({ name: sessionName, description: `#89 persistence lane marker ${runTag}` })
  try {
    await session.run([`interface ${scratch}`, `   description ${marker}`])
    await session.commit()
    markerCommitted = true
  } finally {
    if (session.isOpen) await session.abort().catch(() => undefined)
  }
}

/** Restore the scratch port to no description through a named session (the final cleanup). */
async function clearMarker(sessionName: string): Promise<void> {
  if (node === undefined) throw new Error('node not built')
  scratchSessions.add(sessionName)
  const session = await node.configSession({ name: sessionName, description: `#89 persistence lane cleanup ${runTag}` })
  try {
    await session.run([`interface ${scratch}`, '   no description'])
    await session.commit()
    markerCommitted = false
  } finally {
    if (session.isOpen) await session.abort().catch(() => undefined)
  }
}

beforeAll(async () => {
  if (!runnable || !resolution.ok) return
  target = unwrapLiveTarget(resolution)
  const gate = requireScratchInterface(target, hardware ? { hardwarePersistence: true } : {})
  if (gate.ok !== true) throw new Error(`persistence-hardware: scratch gate refused: ${gate.reason}`)
  scratch = gate.name
  node = createNode(liveTransportOptions(target))
  console.log(`persistence-hardware: target=${describeLiveTarget(target)} class=${evidence.targetClass} scratch=${scratch} verbs=${[...verbSet].join(',')} snapshot=${snapshotFile}`)
  const identity = await node.getVersion()
  if (hardware) {
    const mismatch = matchesDeviceIdentity(target, { version: identity.version, modelName: identity.modelName })
    expect(mismatch, `hardware identity gate: ${JSON.stringify(identity)}`).toBeUndefined()
  }
  observe('identity', { class: evidence.targetClass, version: identity.version, modelName: identity.modelName })
  // The unused-scratch contradiction check runs only on hardware (a container scratch port may be up).
  if (hardware) {
    const [status] = await node.exec([`show interfaces ${scratch} status`], { format: 'json' })
    const link = ((status?.result as { interfaceStatuses?: Record<string, { linkStatus?: string }> } | undefined)?.interfaceStatuses ?? {})[scratch]?.linkStatus
    observe('scratch-link', { scratch, linkStatus: link ?? '<unread>' })
    if (link === 'connected' || link === 'errdisabled') {
      throw new Error(`persistence-hardware: refusing to mutate ${JSON.stringify(scratch)} — linkStatus=${link} contradicts the "unused scratch" declaration`)
    }
  }
})

afterAll(async () => {
  if (!runnable || node === undefined) return
  // Belt-and-braces restore: if a marker is somehow still live, clear it; abort any session still ours.
  if (markerCommitted) {
    await clearMarker(`hw-persist-clear-${runTag}`).catch((e) => console.error(`persistence-hardware: CLEANUP clearMarker failed: ${(e as Error).message}`))
  }
  for (const name of scratchSessions) {
    const s = await findSession(name).catch(() => undefined)
    if (s !== undefined && /pending/iu.test(s.state)) await node.abortSession(name).catch(() => undefined)
  }
  await node.close().catch(() => undefined)
  if (!runnable) return
  evidence.generatedAt = new Date().toISOString()
  const out = path.resolve(process.cwd(), 'docs', 'evidence', hardware ? 'persistence-hardware.json' : 'persistence-rehearsal.ceos.json')
  mkdirSync(path.dirname(out), { recursive: true })
  const text = JSON.stringify(evidence, null, 2)
  const secret = process.env['EAPI_PASS'] ?? process.env['EAPI_HW_PW']
  if (secret !== undefined && secret !== '') expect(text.includes(secret), 'evidence artifact must never carry a credential').toBe(false)
  // Device-stored hashes and ssh key material ride config diffs — the redactor above must have
  // caught them all (the ssh-key arm joined after the 2026-11-21 hardware run kept a key comment).
  expect(/\$6\$|\$1\$[a-zA-Z0-9./]{8}|ssh-key\s+\S*(ssh-|ecdsa-|sk-)|\bAAA[ABCEGHJKLMNPRSTVWXYZ]{2}\w{10,}/u.test(text), 'evidence artifact must never carry config secret or ssh-key material').toBe(false)
  writeFileSync(out, `${text}\n`, 'utf8')
  console.log(`persistence-hardware: wrote ${out}${hardware ? '' : ' (REHEARSAL — container only, DR-043)'}`)
})

describe.skipIf(!runnable)('physical persistence verbs (#89, owner-authorized 2026-11-21)', () => {
  it('copy running-config startup-config: baseline, save, verify the startup flip', { timeout: 120_000 }, async () => {
    if (!wants('copy')) { observe('copy', { skipped: 'not in EAPI_HW_PERSISTENCE_VERBS' }); return }
    expect(node).toBeDefined()
    // An ABSENT baseline is a legitimate state, not a failure: a never-saved device answers 1000
    // "Error displaying flash:/startup-config (No such file or directory)" in TEXT encoding — the
    // exact flip captured 2026-11-16 (unblock-persistence.ceos.json) and re-observed in the
    // 2026-11-20 rehearsal on a fresh container. The save's job is to create the file.
    let before = ''
    let baselineAbsent = false
    try {
      before = await textRead(node as Node, 'show startup-config')
    } catch (error) {
      if (!/No such file|not found|Error displaying/iu.test((error as Error).message)) throw error
      baselineAbsent = true
    }
    observe('copy-baseline-startup', { absent: baselineAbsent, hasMarker: before.includes(MARKER), lines: before.split(/\r?\n/u).length })
    const [reply] = await (node as Node).copyRunningToStartup()
    observe('copy-reply', { text: hwReadBackOutput(reply as never).trim().slice(0, 200) })
    const after = await textRead(node as Node, 'show startup-config')
    observe('copy-after-startup', { lines: after.split(/\r?\n/u).length, changedFromBaseline: after !== before })
  })

  it('configure replace: snapshot running to flash, commit a one-line marker, replace back to the snapshot', { timeout: 180_000 }, async () => {
    if (!wants('replace')) { observe('replace', { skipped: 'not in EAPI_HW_PERSISTENCE_VERBS' }); return }
    expect(node).toBeDefined()
    // 1. snapshot current running to a scratch flash file (never startup).
    await (node as Node).exec([`copy running-config ${snapshotFile}`], { format: 'text' })
    observe('replace-snapshot', { snapshotFile })
    // 2. commit a one-line marker on the scratch port (running-config only).
    await commitMarker(`hw-persist-rep-${runTag}`, MARKER)
    const withMarker = await textRead(node as Node, hwScratchReadBackCommand(scratch))
    observe('replace-marker-committed', { markerPresent: withMarker.includes(MARKER) })
    expect(withMarker, 'the marker must be live before the replace').toContain(MARKER)
    // 3. wholesale replace running-config from the snapshot (marker should vanish).
    try {
      const [r] = await (node as Node).configureReplace(snapshotFile)
      observe('replace-reply', { text: hwReadBackOutput(r as never).trim().slice(0, 200) })
    } catch (error) {
      observe('replace-refused', { errorName: (error as Error).name, message: (error as Error).message.slice(0, 240) })
      // A refusal here means the marker is still live — the finally-style cleanup in afterAll clears it.
      throw error
    }
    const afterReplace = await textRead(node as Node, hwScratchReadBackCommand(scratch))
    observe('replace-after', { markerPresent: afterReplace.includes(MARKER) })
    expect(afterReplace, 'configure replace must have restored the snapshot (marker gone)').not.toContain(MARKER)
    markerCommitted = false
  })

  it('rollback clean-config: stage in a named session, record the diff, ABORT (never commit)', { timeout: 120_000 }, async () => {
    if (!wants('rollback')) { observe('rollback-clean', { skipped: 'not in EAPI_HW_PERSISTENCE_VERBS' }); return }
    expect(node).toBeDefined()
    const name = `hw-persist-rbclean-${runTag}`
    scratchSessions.add(name)
    let session: ConfigSession | undefined
    try {
      session = await (node as Node).rollbackCleanConfig({ name, description: `#89 rollback clean-config probe ${runTag}` })
      const diff = await session.diff()
      observe('rollback-clean-diff', { diffLines: diff.split(/\r?\n/u).length, diffHead: diff.split(/\r?\n/u).slice(0, 8).map(redactConfig) })
    } catch (error) {
      observe('rollback-clean-refused', { errorName: (error as Error).name, code: error instanceof CommandError ? error.code : undefined, message: (error as Error).message.slice(0, 240) })
    } finally {
      if (session !== undefined && session.isOpen) await session.abort().catch(() => undefined)
    }
    // Nothing was committed: the scratch marker state is unchanged by this step.
    const still = await findSession(name)
    observe('rollback-clean-poststate', { sessionStillPending: still !== undefined && /pending/iu.test(still.state) })
  })

  it('rollback <name>: stage a named-session rollback, record the diff, ABORT (never commit)', { timeout: 120_000 }, async () => {
    if (!wants('rollback')) { observe('rollback-name', { skipped: 'not in EAPI_HW_PERSISTENCE_VERBS' }); return }
    expect(node).toBeDefined()
    // Roll back to the most recent completed session this lane committed (the one-slot saved store,
    // DR-136 — reached through the DETAIL form, since the plain form does not list completed entries
    // on the box). If the replace step did not run or the slot rotated, the step records that rather
    // than inventing a name.
    const lastCommit = `hw-persist-rep-${runTag}`
    const target0 = await findSession(lastCommit, true)
    if (target0 === undefined) {
      // The 2026-11-22 hardware run (DR-158) proved this skip message's guess is not safe: the
      // replace step HAD run (replace-after markerPresent:false) yet the marker session was gone
      // from the slot three seconds after its commit. Whether `configure replace` itself clears the
      // one-slot completed-session store is a device question — so record what the detail form DOES
      // list instead of guessing. Read failure must never mask the skip itself.
      const slotContents = await (node as Node)
        .listSessions({ detail: true })
        .then((r) => r.sessions.filter((s) => /completed/iu.test(s.state)).map((s) => s.name))
        .catch(() => ['<detail read refused>'])
      observe('rollback-name', {
        skipped: `no completed session ${lastCommit} to target (replace step did not run or the slot rotated) — DR-136 one-slot store`,
        completedSlotHolds: slotContents,
      })
      return
    }
    const name = `hw-persist-rbname-${runTag}`
    scratchSessions.add(name)
    let session: ConfigSession | undefined
    try {
      // Open the session OURSELVES (not node.rollbackToSession, which opens one internally and loses
      // the handle when the staged `rollback <name>` throws — e.g. the box rejects the name). A
      // stranded handle-less PENDING session then blocks every later named session (DR-025), so the
      // cleanup could never run. Owning the handle makes the finally-abort unconditional. Observed
      // 2026-11-23 (hardware): a 1002 `Invalid input` on `rollback <name>` stranded exactly this.
      session = await (node as Node).configSession({ name, description: `#89 rollback <name> probe ${runTag}` })
      await session.rollbackToSession(lastCommit)
      const diff = await session.diff()
      observe('rollback-name-diff', { target: lastCommit, diffLines: diff.split(/\r?\n/u).length, diffHead: diff.split(/\r?\n/u).slice(0, 8).map(redactConfig) })
    } catch (error) {
      observe('rollback-name-refused', { errorName: (error as Error).name, code: error instanceof CommandError ? error.code : undefined, message: (error as Error).message.slice(0, 240) })
    } finally {
      if (session !== undefined && session.isOpen) await session.abort().catch(() => undefined)
    }
  })

  it('rollback <name> (decoupled): own marker, immediate vs ~60s slot survival, stage+diff+ABORT, self-clean', { timeout: 240_000 }, async () => {
    if (!wants('rollback-name')) { observe('rollback-name-decoupled', { skipped: 'not in EAPI_HW_PERSISTENCE_VERBS' }); return }
    expect(node).toBeDefined()
    // A marker session THIS verb owns and commits — no `configure replace` between its commit and the
    // reads, which is exactly the separation DR-158 could not make (the confounded step above rolls
    // back to the replace step's session, so a cleared slot there is ambiguous).
    const rbMarker = `hw-persist-rbmark-${runTag}`
    const rbMarkerDesc = `HW-PERSIST-RBN-${runTag}`
    await commitMarker(rbMarker, rbMarkerDesc)
    // Batch 1 — read the detail form IMMEDIATELY after the commit: did the fresh `completed` entry land
    // in the one-slot store at all?
    const immediate = await completedSlotNames()
    observe('rollback-name-decoupled', {
      batch: 'immediate', target: rbMarker,
      completedSlotHoldsImmediate: immediate,
      immediateHoldsTarget: immediate.includes(rbMarker),
      replaceInThisRun: wants('replace'),
    })
    // Batch 2 — the controlled wait, with NO intervening mutating op (the whole point: the only thing
    // that could have evicted the slot between the two reads is elapsed time, not `configure replace`).
    await new Promise((resolve) => setTimeout(resolve, 60_000))
    const aged = await completedSlotNames()
    observe('rollback-name-decoupled', {
      batch: 'aged-60s', target: rbMarker,
      completedSlotHoldsAged: aged,
      agedHoldsTarget: aged.includes(rbMarker),
      // The separation this run exists to produce. Only interpretive; the operator reviews the artifact.
      agedOutWithoutReplace: immediate.includes(rbMarker) && !aged.includes(rbMarker) && !wants('replace'),
      neverLandedInSlot: !immediate.includes(rbMarker),
    })
    // Attempt the rollback against the target regardless of the reads, recording the device's answer
    // (accepted + diff, or the refusal code). Staged, diffed, ABORTed — never committed.
    const name = `hw-persist-rbnd-${runTag}`
    scratchSessions.add(name)
    let session: ConfigSession | undefined
    try {
      // Own the session handle (see the confounded step above): node.rollbackToSession loses its
      // internal session when `rollback <name>` throws, stranding a PENDING session that blocks the
      // self-clean. The 2026-11-23 hardware run hit precisely this on the 1002 name refusal.
      session = await (node as Node).configSession({ name, description: `#89 rollback <name> decoupled probe ${runTag}` })
      await session.rollbackToSession(rbMarker)
      const diff = await session.diff()
      observe('rollback-name-decoupled-diff', { target: rbMarker, diffLines: diff.split(/\r?\n/u).length, diffHead: diff.split(/\r?\n/u).slice(0, 8).map(redactConfig) })
    } catch (error) {
      observe('rollback-name-decoupled-refused', { errorName: (error as Error).name, code: error instanceof CommandError ? error.code : undefined, message: (error as Error).message.slice(0, 240) })
    } finally {
      if (session !== undefined && session.isOpen) await session.abort().catch(() => undefined)
    }
    // Self-clean: clear the marker this verb committed, so the final restore sees an unmarked scratch.
    await clearMarker(`hw-persist-rbnd-clear-${runTag}`)
  })

  it('rollback <hyphen-free name>: distinguish verb support from target-name grammar, then ABORT and self-clean', { timeout: 120_000 }, async () => {
    if (!wants('rollback-hyphenfree')) { observe('rollback-hyphenfree', { skipped: 'not in EAPI_HW_PERSISTENCE_VERBS' }); return }
    expect(node).toBeDefined()
    const rbMarker = `hwrbmark${runTag}`
    const rbMarkerDesc = `HW-PERSIST-RBH-${runTag}`
    await commitMarker(rbMarker, rbMarkerDesc)
    try {
      // The target is deliberately alphanumeric. Prove the completed slot holds the exact name before
      // interpreting the rollback answer; a missing target would not distinguish the two hypotheses.
      const slot = await completedSlotNames()
      observe('rollback-hyphenfree-slot', {
        target: rbMarker,
        targetContainsHyphen: rbMarker.includes('-'),
        completedSlotHoldsTarget: slot.includes(rbMarker),
        completedSlotHolds: slot,
      })
      const name = `hwrbprobe${runTag}`
      scratchSessions.add(name)
      let session: ConfigSession | undefined
      try {
        // Keep the handle local for the same reason as rollback-name: a rejected command must not
        // strand a PENDING session whose handle exists only inside node.rollbackToSession.
        session = await (node as Node).configSession({ name, description: `#89 rollback <hyphen-free name> probe ${runTag}` })
        await session.rollbackToSession(rbMarker)
        const diff = await session.diff()
        observe('rollback-hyphenfree-diff', { target: rbMarker, diffLines: diff.split(/\r?\n/u).length, diffHead: diff.split(/\r?\n/u).slice(0, 8).map(redactConfig) })
      } catch (error) {
        observe('rollback-hyphenfree-refused', { target: rbMarker, errorName: (error as Error).name, code: error instanceof CommandError ? error.code : undefined, message: (error as Error).message.slice(0, 240) })
      } finally {
        if (session !== undefined && session.isOpen) await session.abort().catch(() => undefined)
      }
    } finally {
      await clearMarker(`hwrbclear${runTag}`)
    }
  })

  it('final restore: the scratch port carries no lane marker', { timeout: 60_000 }, async () => {
    expect(node).toBeDefined()
    const now = await textRead(node as Node, hwScratchReadBackCommand(scratch))
    // Broadened from MARKER alone to the whole HW-PERSIST- lane prefix: the decoupled step leaves
    // `HW-PERSIST-RBN-<tag>` on the scratch port, which does NOT contain MARKER (`HW-PERSIST-<tag>`),
    // so a narrow MARKER-only check false-passes when only the RBN description leaks. Any lane
    // description on the scratch port must fail here. (Caught on the 2026-11-23 hardware run.)
    observe('final-scratch-state', { anyLaneMarkerPresent: now.includes('HW-PERSIST-'), thisRunMarkerPresent: now.includes(MARKER) })
    expect(now, 'the lane must leave the scratch port free of any HW-PERSIST-* description').not.toContain('HW-PERSIST-')
  })
})
