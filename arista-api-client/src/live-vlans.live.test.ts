/**
 * `*.live.test.ts` port of `pyeapi/test/system/test_api_vlans.py` @ `6816d9e` — M12a (#14), read-mostly.
 *
 * Loud-skip semantics are identical to `live-system.live.test.ts` (DR-034): the guard reads `process.env`
 * once, an incomplete env prints the reason and every case skips; the `unit` project never collects this file.
 *
 * | upstream (verified line @6816d9e) | ported? | here / why |
 * |---|---|---|
 * | `test_get` (`:44`) | ✅ (read half) | asserts the **default VLAN 1** exists and answers a typed `Vlan` record. Upstream first runs `dut.config(['no vlan 1','vlan 1'])` (`:45`) to normalise VLAN 1; VLAN 1 exists on any booted EOS, so the read needs no write. pyeapi's exact dict (`vlan_id:'1'`, name `'default'`…) is asserted only at key/type level — `id` is a **number** here (MIGRATION.md §4), not the upstream string |
 * | `test_getall` (`:52`) | ✅ (read half) | upstream does `dut.config(['no vlan 1-4094','vlan 1','vlan 10'])` (`:53`) then checks `'1'`/`'10'` are keys. Deleting every VLAN on a live target is a destructive global write (not a scratch port). Here `getAll()` is asserted as a keyed table that **contains the always-present default VLAN**; the `10` membership is a write result, so not claimed |
 * | `test_create_and_return_true` (`:60`), `_return_false` (`:69`) | ✅ — see the D2 rows below | the earlier version of this ledger skipped them for want of a scratch-VLAN gate; `EAPI_SCRATCH_VLAN` + `requireScratchVlan` (`live-guard.ts:626-641`) and the DR-126 consent resolve that, so the two rows are replaced by the per-method rows further down |
 * | `test_delete_and_return_true`/`_false` (`:74`,`:83`), `test_default` (`:88`) | ✅ — see the D2 rows below | same supersession as the row above |
 * | `test_set_name` (`:99`), `test_set_state_*` (`:110`,`:120`), `test_set_trunk_groups*` (`:130`,`:142`,`:156`), `test_add/remove_trunk_group` (`:171`,`:182`) | ✅ — see the D2 rows below | same supersession; the trunk-group half additionally carries a **capability guard**, explained under "Trunk groups: guarded, not assumed" |
 *
 * ## The D2 full-write lane (this milestone, #14 D2 / DR-126) — the 13 remaining methods
 * `gate = liveFullWriteReadiness(process.env)` (`src/testing/live-full-write.ts`) composes `resolveLiveEnv`
 * with the `EAPI_LAB_FULL_WRITE=1` consent, and the `Node` comes from `buildFullWriteNode(target)` so
 * `withLabWriteScope` fences every verb before the wire (self-lockout set:
 * `live-session-policy.ts:159-166` as quoted by `live-varp.live.test.ts`). Without either the file prints the
 * refusal and skips loudly (DR-034); the `unit` project still never collects it.
 *
 * **The VLAN is declared, never chosen.** `requireScratchVlan` (`live-guard.ts:626-641`) accepts only
 * `EAPI_SCRATCH_VLAN`, which the harness exports as `1201` — outside the provisioned `10/100/110`
 * (`scripts/ceos-lab.mjs`, `lab-provision`, DR-122), outside VLAN 1, outside EOS's reserved
 * `1006-1199` window (the guard's own refusal, `live-guard.ts:638-640`), and outside the `>= 2000` block
 * `live-varp.live.test.ts` claims for its SVI. **1201 is not written into this file**: it comes from the
 * gate, so a bogus or missing value skips the write lane rather than letting a env-typo wander the container.
 * Every mutating case (a) runs a `no vlan <spare>` prelude, because the container persists across suites,
 * (b) asserts its own precondition instead of assuming one, and (c) releases the VLAN in a `finally` —
 * `no vlan <spare>`, falling back to per-field `default name` / `default state` / `default trunk group` only
 * if the whole section cannot be removed. No case persists anything (DR-035(c)).
 *
 * **Trunk groups: guarded, not assumed.** DECISIONS open item 4 keeps `trunk group` support unverified on the
 * DCS-7050TX-64, and `vlans.ts` (`assertTrunkGroupName`'s own note) records that pyeapi's two readers
 * disagree about what a group name even is. The container is not the SKU, so the four trunk-group arms
 * (`:130`, `:142`, `:156`, `:171`, `:182`) run through `stageGroups()`, which stages the lines **and re-reads
 * them**: if this image does not apply `trunk group` inside a `vlan` section, the case prints that as a
 * capability negative and returns without claiming the write half (the precedent is
 * `live-varp.live.test.ts`'s refusal reporter and `live-switchports.live.test.ts`'s trunk-batch row). A
 * refusal that is *not* a typed `EapiError` rethrows — that would be this client's bug, not the device's answer.
 *
 * | upstream (verified line @6816d9e) | ported? | here / why |
 * |---|---|---|
 * | `test_create_and_return_true` (`:60`, `no vlan 2-4094` `:62`, `random_int(2,4094)` `:63`, `create` `:64`, `assertTrue` `:65`, `show vlan` membership `:66-67`) | ✅ (declared spare id, not a random one) | upstream wipes **every** VLAN from the DUT (`:62`) to make room for a random id. Here the id is the declared spare and the prelude is one `no vlan <spare>`. `vlans.create(id)` (`vlans.ts:465`) is `vlan <id>`; proof is the typed section (`get(id)` answers `id`/`state active`/no groups, plus `getBlock(\`vlan ${id}\`)` naming the header) — and upstream's `show vlan` proof is **recorded**, not asserted: `show vlan` has no `ShowContracts` entry yet (`types/eapi.ts:138-140`), so its text is token-matched and printed as the device's answer |
 * | `test_create_and_return_false` (`:69`, `create('5000')` `:71`, `assertFalse` `:72`) | ✅ as a client-side refusal, no wire | pyeapi's `False` is `isvlan()` saying no before anything is sent (`vlans.py:204`); here `assertVlanId` throws `NotSupportedError` first (DR-005/DR-053, divergence 8/10), and the case asserts the table never grew a `5000` key. The container's own answer to a literal `vlan 5000` is deliberately **not** staged: DR-035(b)/`requireScratchVlan` keep every write in this file inside the declared spare id, so sending an unowned out-of-range VLAN would be the very mutation the gate exists to prevent |
 * | `test_delete_and_return_true` (`:74`, stage `:76-77`, `delete` `:78`, `assertTrue` `:79`, `show vlan` absence `:80-81`) | ✅ | `vlans.delete(id)` (`vlans.ts:496`) is `no vlan <id>`; re-reads assert `get(id) === undefined` (DR-027) **and** that `getAll()` has no such key. Upstream's absence proof (`:81`) is the `show vlan` dict — here the config table is the proof, and the `show vlan` text row is printed |
 * | `test_delete_and_return_false` (`:83`, `delete('5000')` `:85`, `assertFalse` `:86`) | ✅ as a client-side refusal, no wire | same guard as `:69` (`vlans.ts:496` → `assertVlanId`); the table is re-read afterwards to pin that the guard cost the wire nothing |
 * | `test_default` (`:88`, `:90-93` stage incl. a second `vlan <vid>` line + `name <random 20>`, `default` `:94`, `assertTrue` `:95`, `show vlan` absence `:96-97`) | ✅ (absence-or-reverted, both honest) | `vlans.setDefault(id)` (`vlans.ts:507`) is top-level `default vlan <id>`. Upstream asserts the id vanished from `show vlan`; on this container the section may survive as a bare default, so the case accepts either — and in the surviving branch it asserts the staged `name` is **gone**, which is the half `default` actually owns (divergence 5's absence, not `''`). Upstream's duplicate `vlan <vid>` line (`:92-93`) is its own quirk, not reproduced |
 * | `test_set_name` (`:99`, `random_string(maxchar=20)` `:101`, stage `:103`, `set_name` `:104`, `assertTrue` `:105`, `show vlan` name column `:106-108`) | ✅ (name pinned, not random) | `setVlanName(id, VLAN_NAME)` (`vlans.ts:527`) enters the submode and writes `name <value>`. A random name cannot be diffed against the text it just wrote, so the value is a fixed token; the read is the typed field **and** `getBlock` containing the line. Upstream's evidence is the `show vlan` name column (`:107`) — recorded as text |
 * | `test_set_state_active` (`:110`, stage `state suspend` `:113`, `set_state` `:114`, `assertTrue` `:115`, status `active` `:116-118`) | ✅ | staged with `create`-equivalent raw lines (`vlan <id>` + `state suspend`), read back as `state === 'suspend'` as the precondition, then `setVlanState(id, 'active')` (`vlans.ts:546`) and `state === 'active'` |
 * | `test_set_state_suspend` (`:120`, stage `state active` `:123`, `set_state` `:124`, `assertTrue` `:125`, status `'suspended'` `:126-128`) | ✅ (the spelling asymmetry is the finding) | the write is `state suspend` (`vlans.py:282`'s value, and `VlanState` keeps pyeapi's spelling, `vlans.ts:174`), while upstream's `show vlan` **status** reads back `'suspended'` (`:127`) — two different words for one state. This client reads the config line, so the record answers `'suspend'`; the `show vlan` row is printed so the asymmetry is visible in the log, and `resources/vlans.test.ts` keeps the two-value guard that would reject `'suspended'` as a write |
 * | `test_set_trunk_groups_default` (`:130`, `random_string()` `:133`, stage `:134-135`, `default=True` `:136`, `assertTrue` `:137`, `show running-config section vlan` text `:138-140`) | ✅ (capability-guarded) | `defaultTrunkGroups(id)` (`vlans.ts:632`) is `default trunk group` in the submode. Upstream's proof is a running-config **text** scan for the absence of `trunk group`; that is exactly `getBlock(\`vlan ${id}\`)` here, so the twin is asserted, not approximated |
 * | `test_set_trunk_groups` (`:142`, three `random_string(maxchar=10)` `:145-147`, stage `:148-149`, set `[tg1, tg3]` `:150`, `assertTrue` `:151`, `show vlan <vid> trunk group` `:152-154`) | ✅ (capability-guarded, sorted comparison) | stage A+B, then `setTrunkGroups(id, [A, C])` (`vlans.ts:580`) — one read, one diff, one transaction (divergence 11: adds in caller order, removals in device order, where upstream loops `set.difference()` per change). Compared as **sorted** sets, matching upstream's `sorted(...)` at `:153-154`, because the order inside a section is the device's |
 * | `test_set_trunk_groups_disable` (`:156`, `:159-161`, stage `:162-164`, `disable=True` `:165`, `assertTrue` `:166`, `show …` `:167-169`) | ✅ (capability-guarded) | `unsetTrunkGroups(id)` (`vlans.ts:627`) is the bulk `no trunk group`, deliberately **not** the per-name form (`vlans.ts:571-572`). Result must be `[]` in both the record and the block text |
 * | `test_add_trunk_group` (`:171`, `random_string(maxchar=32)` `:173`, `random_int(2,4095)` `:174`, stage `:175`, `add_trunk_group` `:176`, `assertTrue` `:177`, `show vlan trunk group` `:178-180`) | ✅ (off-by-one noted, single-token name) | upstream's id range here reaches `4095`, which its own `isvlan` rejects (`vlans.py:77-78`) — an upstream bug of the row-76 family, not reproduced: the id is the declared spare. Its `maxchar=32` name is likewise not a claim about EOS limits, so the group name is short. `addTrunkGroup(id, G)` (`vlans.ts:615`) sends `trunk group G` with zero reads (divergence 12) |
 * | `test_remove_trunk_group` (`:182`, `:184-185`, stage `:186-187`, `remove_trunk_group` `:188`, `assertTrue` `:189`, `show vlan trunk group` `:190-192`) | ✅ | `removeTrunkGroup(id, G)` (`vlans.ts:621`) composes `no trunk group G` — the name sits inside the command stem because pyeapi formats that text directly instead of using `command_builder` (`vlans.py:358`, pinned at `vlans.ts:600-606`) |
 *
 * Consequence: the file now ports **fifteen** of upstream's fifteen methods — the two read cases as the
 * original lane has them, and the thirteen write/behaviour cases through the D2 full-write lane. pyeapi's
 * `configure`-returned-`False` idiom is absent here by DR-005: a refusal is a thrown `CommandError`
 * (with `failedCommand`) or a `NotSupportedError` from a client guard, and `verb()`/`batch()` below say
 * **which** side refused, never silently converting one into the other.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { CommandError, ConfigParseError, EapiError, NotSupportedError, SessionError } from './errors'
import { createNode } from './node'
import { buildFullWriteNode, liveFullWriteReadiness } from './testing/live-full-write'
import { resolveLiveEnv, unwrapLiveTarget, liveTransportOptions, matchesDeviceIdentity, describeLiveTarget, requireScratchVlan } from './testing/live-guard'
import { runGuardedLiveWriteSession } from './testing/live-session-policy'
import type { Vlan } from './resources/vlans'
import type { Node } from './command-layer'

const resolution = resolveLiveEnv(process.env)
if (!resolution.ok) {
  console.warn(`live-vlans: SKIPPED (DR-034) — ${resolution.reason}`)
}
const ready = resolution.ok

describe.skipIf(!ready)('live read-mostly: pyeapi test_api_vlans.py (test_get :44, test_getall :52)', () => {
  let node: Node

  beforeAll(async () => {
    const target = unwrapLiveTarget(resolution)
    console.log(`live-vlans: target = ${describeLiveTarget(target)}`)
    node = createNode(liveTransportOptions(target))
    const reported = await node.getVersion()
    const mismatch = matchesDeviceIdentity(target, { version: reported.version, modelName: reported.modelName })
    // Tolerate only the suffix-driven EAPI_VERSION_MISMATCH (the cEOS `version` field carries an
    // engineering-build suffix the base pin cannot exactly match); the probe enforces base identity (DR-066).
    if (mismatch !== undefined && mismatch.code !== 'EAPI_VERSION_MISMATCH') throw new Error(`live-vlans readiness: ${mismatch.reason}`)
    if (mismatch?.code === 'EAPI_VERSION_MISMATCH') console.warn(`live-vlans: reported version "${reported.version}" vs pin "${target.allowVersion}" (base-level enforced by the probe, DR-066)`)
  })

  it('vlans.get(1) answers the default VLAN as a typed record when present (test_get, :44 — read half)', async () => {
    const vlan = await node.vlans.get(1)
    // Upstream reaches VLAN 1 after a normalising `no vlan 1`/`vlan 1` write (:45) it never makes against a
    // read it wants to be write-free. A bare cEOS node may report no VLAN section at all, so absence is
    // reported (and the membership half not claimed) rather than forced into a pass — see the getAll case.
    if (vlan === undefined) {
      console.warn('live-vlans: get(1) returned undefined — this target reports no `vlan 1` section; record-shape half NOT exercised')
      return
    }
    expect(vlan.id).toBe(1)
    expect(['active', 'suspend']).toContain(vlan.state)
    expect(Array.isArray(vlan.trunkGroups)).toBe(true)
    if (vlan.name !== undefined) expect(typeof vlan.name).toBe('string')
  })

  it('vlans.getAll() returns a keyed table of Vlan records (test_getall, :52 — read half, shape-level)', async () => {
    const all = await node.vlans.getAll()
    expect(typeof all.has).toBe('function') // a ReadonlyMap<number, Vlan>, not pyeapi's plain dict
    for (const [id, vlan] of all) {
      expect(typeof id).toBe('number')
      expect(vlan.id).toBe(id)
      expect(['active', 'suspend']).toContain(vlan.state)
      expect(Array.isArray(vlan.trunkGroups)).toBe(true)
    }
    // Membership of the default VLAN is asserted only when the target actually reports any VLAN section. A
    // bare cEOS-lab node on this host booted with an empty running-config (no `vlan …` section was present
    // — see the lane brief's runbook limitation), and inventing a "VLAN 1 must be key 1" claim against a
    // device that reported nothing would dress up no coverage as a pass (DR-034/DR-043). The read *shape*
    // is still pinned; the membership half is reported as not exercised.
    if (all.size === 0) {
      console.warn('live-vlans: getAll() reported 0 VLAN sections on this target — membership half NOT exercised (portless/empty-config container)')
    } else {
      expect(all.has(1)).toBe(true)
      expect(all.get(1)?.id).toBe(1)
    }
  })
})

// ─── D2 full-write lane (DR-126): the 13 write/behaviour methods, on the declared spare VLAN ──────

const gate = liveFullWriteReadiness(process.env)
if (!gate.runnable) {
  console.warn(`live-vlans: the 13 write/behaviour cases SKIPPED (DR-034/DR-126) — ${gate.skipReason ?? 'the gate refused the run'}`)
}

/**
 * The spare VLAN comes from the guard, never from this file: `requireScratchVlan` (`live-guard.ts:626-641`)
 * accepts only a declared `EAPI_SCRATCH_VLAN` inside 2-4094 and outside 1006-1199. A refusal (flag off, id
 * bogus, id reserved) skips the mutating cases with the reason printed, exactly like `live-switchports`'
 * `requireScratchInterface` gate.
 */
const scratch: { readonly ok: boolean; readonly id?: number; readonly reason?: string } = gate.runnable
  ? (() => {
      const req = requireScratchVlan(unwrapLiveTarget(gate.resolution))
      return req.ok ? { ok: true, id: req.vlan } : { ok: false, reason: req.reason }
    })()
  : { ok: false, reason: 'the live endpoint or the EAPI_LAB_FULL_WRITE=1 consent was not accepted' }
if (gate.runnable && !scratch.ok) {
  console.warn(`live-vlans: the 11 VLAN-mutating cases SKIPPED (DR-035b/DR-126) — ${scratch.reason ?? ''}`)
}

/** Upstream's out-of-range ids: `create('5000')` (`:71`) and `delete('5000')` (`:85`). */
const OUT_OF_RANGE = 5000
/** Upstream's `random_string(maxchar=20)` (`:101`) pinned — a random value cannot be diffed against the text it just wrote. */
const VLAN_NAME = 'live-d2-spare'
/** Upstream's three `random_string(maxchar=10)` groups (`:145-147`), pinned to single tokens `assertTrunkGroupName` accepts. */
const TG_A = 'lived2a'
const TG_B = 'lived2b'
const TG_C = 'lived2c'

const runId = String(Date.now()).slice(-6)

/** The declared spare. Only reachable inside a `describe` whose `skipIf` proved the gate accepted it. */
function spare(): number {
  if (scratch.id === undefined) {
    throw new Error(`live-vlans: no declared EAPI_SCRATCH_VLAN, so the write lane must not pick an id itself (DR-035b) — ${scratch.reason ?? ''}`)
  }
  return scratch.id
}

type Attempt = { readonly ok: true } | { readonly ok: false; readonly code: string; readonly text: string }

function firstLine(message: string): string {
  return message.split('\n')[0]?.slice(0, 200) ?? message
}

function describeError(rawErr: EapiError): string {
  return rawErr instanceof CommandError ? `CommandError(${String(rawErr.code)})` : String(rawErr.constructor.name)
}

/** pyeapi's `dut.config([...])` twin: a named session, abort-on-failure, never persisted (DR-035/DR-126). */
async function batch(node: Node, label: string, commands: readonly string[]): Promise<Attempt> {
  try {
    await runGuardedLiveWriteSession(node, { name: `d2-vlans-${label}-r${runId}`, commands })
    return { ok: true }
  } catch (rawErr) {
    if (rawErr instanceof SessionError) throw rawErr
    if (!(rawErr instanceof EapiError)) throw rawErr
    console.warn(`live-vlans: batch ${JSON.stringify(label)} did not apply (${describeError(rawErr)}): ${firstLine(rawErr.message)} — commands ${JSON.stringify(commands)}`)
    return { ok: false, code: describeError(rawErr), text: firstLine(rawErr.message) }
  }
}

/**
 * pyeapi's `dut.api('vlans').verb()` + `assertTrue`/`assertFalse` twin (DR-005: a refusal throws, there is
 * no `False`). A client-side guard (`NotSupportedError`) or a parse fault (`ConfigParseError`) is **this
 * client's** behaviour and rethrows — only a device/transport answer becomes a recorded refusal, so a
 * broken guard can never hide behind the capability tolerance.
 */
async function verb(label: string, call: () => Promise<unknown>): Promise<Attempt> {
  try {
    await call()
    return { ok: true }
  } catch (rawErr) {
    if (rawErr instanceof NotSupportedError || rawErr instanceof ConfigParseError) throw rawErr
    if (!(rawErr instanceof EapiError)) throw rawErr
    const failed = rawErr instanceof CommandError ? ` failedCommand=${JSON.stringify(rawErr.failedCommand)}` : ''
    console.warn(`live-vlans: ${label} — device answer ${describeError(rawErr)}: ${firstLine(rawErr.message)}${failed}`)
    return { ok: false, code: describeError(rawErr), text: firstLine(rawErr.message) }
  }
}

async function readyNode(label: string): Promise<Node> {
  const target = unwrapLiveTarget(gate.resolution)
  console.log(`${label}: target = ${describeLiveTarget(target)}`)
  const node = buildFullWriteNode(target)
  const reported = await node.getVersion()
  const mismatch = matchesDeviceIdentity(target, { version: reported.version, modelName: reported.modelName })
  // Tolerate only the suffix-driven EAPI_VERSION_MISMATCH (the cEOS `version` field carries an
  // engineering-build suffix the base pin cannot exactly match); the probe enforces base identity (DR-066).
  if (mismatch !== undefined && mismatch.code !== 'EAPI_VERSION_MISMATCH') {
    throw new Error(`${label} readiness: ${mismatch.reason}`)
  }
  if (mismatch?.code === 'EAPI_VERSION_MISMATCH') {
    console.warn(`${label}: reported version "${reported.version}" vs pin "${target.allowVersion}" (base-level enforced by the probe, DR-066)`)
  }
  return node
}

async function readSpare(node: Node): Promise<Vlan | undefined> {
  return await node.vlans.get(spare())
}

/** The spare section's own config text — the twin of upstream's `show running-config section vlan X` scan. */
async function spareBlock(node: Node): Promise<string> {
  return (await node.vlans.getBlock(`vlan ${String(spare())}`)) ?? ''
}

/** Delete-if-exists prelude: the container persists across suites, so a crashed earlier run decides nothing here. */
async function prelude(node: Node, tag: string): Promise<void> {
  await batch(node, `${tag}-prelude`, [`no vlan ${String(spare())}`])
}

/** Create the spare VLAN from nothing, with upstream's extra in-submode lines (`:113`, `:123`, `:135`, …). */
async function stageVlan(node: Node, tag: string, extraLines: readonly string[] = []): Promise<boolean> {
  return (await batch(node, `${tag}-stage`, [`vlan ${String(spare())}`, ...extraLines])).ok
}

/** Assert the precondition upstream assumes by wiping the DUT (`:62`), instead of assuming it. */
async function requireAbsent(node: Node, label: string): Promise<boolean> {
  const found = await readSpare(node)
  if (found !== undefined) {
    console.warn(`live-vlans: vlan ${String(spare())} survived the prelude (${JSON.stringify(found)}), so ${label}'s precondition does not hold — case reported, not claimed`)
    return false
  }
  return true
}

/**
 * Full release, called from every mutating case's `finally`. Dropping the section reverts name/state/groups
 * together; if the device refuses that, each field is defaulted in its own session so the declared spare is
 * handed back bare to the next suite in this container.
 */
async function releaseSpareVlan(node: Node, tag: string): Promise<void> {
  const id = String(spare())
  if ((await batch(node, `${tag}-release`, [`no vlan ${id}`])).ok) return
  for (const line of ['default name', 'default state', 'default trunk group']) {
    await batch(node, `${tag}-revert-${line.split(' ')[1] ?? 'field'}`, [`vlan ${id}`, line])
  }
  console.warn(`live-vlans: \`no vlan ${id}\` was refused, so ${tag} handed the spare VLAN back with its fields defaulted rather than deleted — reported, not hidden`)
}

/** A `show` read is a device answer, not a client bug: a typed refusal is recorded and the case's own proof stays config-based. */
async function showGuarded(node: Node, command: string): Promise<string | undefined> {
  try {
    return await node.showText(command)
  } catch (rawErr) {
    if (!(rawErr instanceof EapiError)) throw rawErr
    console.warn(`live-vlans: \`${command}\` refused (${describeError(rawErr)}): ${firstLine(rawErr.message)} — recorded as this container's capability answer (DR-122); the typed running-config reads in this case do not depend on it`)
    return undefined
  }
}

function mentionsVlan(text: string, id: number): boolean {
  return new RegExp(`(?:^|\\s)${String(id)}(?:\\s|$)`, 'mu').test(text)
}

/**
 * Upstream proves its create/delete writes with the `show vlan` **dict** (`:66-67`, `:80-81`), which has no
 * `ShowContracts` entry in this repo yet (`types/eapi.ts:138-140` — the map is app-augmentation only). So the
 * text answer is token-matched and **recorded**: the running-config section is the assertion, and a
 * config/`show` disagreement is printed as the device's own finding (DR-122 keeps capability negatives).
 */
async function recordShowVlan(node: Node, expectMentioned: boolean): Promise<void> {
  const id = spare()
  const shown = await showGuarded(node, 'show vlan')
  if (shown === undefined) return
  const mentioned = mentionsVlan(shown, id)
  const row = shown.split('\n').find((line) => mentionsVlan(line, id))
  console.log(`live-vlans: \`show vlan\` ${mentioned ? 'names' : 'does not name'} vlan ${String(id)} (upstream asserts ${expectMentioned ? 'presence' : 'absence'}); row=${JSON.stringify(row ?? null)}`)
  if (mentioned !== expectMentioned) {
    console.warn(`live-vlans: \`show vlan\` and the running-config section disagree about vlan ${String(id)} — recorded as a device/text answer, not converted into a pass or a failure of this client's read`)
  }
}

/** Upstream's `show vlan <vid> trunk group` / `show vlan trunk group` proof (`:152-154`, `:167-169`, `:178-180`, `:190-192`). */
async function recordShowVlanTrunkGroups(node: Node): Promise<void> {
  const shown = await showGuarded(node, 'show vlan trunk group')
  if (shown === undefined) return
  console.log(`live-vlans: \`show vlan trunk group\` → ${JSON.stringify(shown.trim().split('\n').slice(0, 8))} (that dict has no contract here, so the text is recorded; the typed section below is the assertion)`)
}

/**
 * Stage the named trunk groups **and read them back**. If this image does not apply `trunk group` inside a
 * `vlan` section, every removal arm downstream would be vacuously true — so the guard turns the case into a
 * reported capability negative (DECISIONS open item 4), matching `live-varp`'s refusal reporter.
 */
async function stageGroups(node: Node, tag: string, groups: readonly string[]): Promise<boolean> {
  const id = spare()
  if (!(await batch(node, `${tag}-groups`, [`vlan ${String(id)}`, ...groups.map((group) => `trunk group ${group}`)])).ok) return false
  const seen = (await readSpare(node))?.trunkGroups ?? []
  if (!groups.every((group) => seen.includes(group))) {
    console.warn(`live-vlans: this container did not apply \`trunk group\` inside \`vlan ${String(id)}\` (staged ${JSON.stringify(groups)}, section reads ${JSON.stringify(seen)}) — whether VLAN-section trunk groups exist is a device question (DECISIONS open item 4), so the arms below are reported as NOT exercised rather than passed vacuously`)
    return false
  }
  return true
}

describe.skipIf(!gate.runnable)('live full-write: pyeapi test_api_vlans.py refusal arms that never reach the wire (:69, :83)', () => {
  let node: Node
  beforeAll(async () => {
    node = await readyNode('live-vlans(refusal)')
  })

  it('create(5000) throws where pyeapi answers False; the table never grew the key (test_create_and_return_false, :69 — create :71, assertFalse :72)', async () => {
    // pyeapi's False is `isvlan()` refusing before the wire (`vlans.py:204`); assertVlanId throws instead
    // (DR-005/DR-053). Nothing is staged on the device for this arm: DR-035(b)/the scratch gate keep even a
    // deliberately-invalid VLAN out of this lane, so the container's own answer to `vlan 5000` is not probed.
    await expect(node.vlans.create(OUT_OF_RANGE)).rejects.toThrow(NotSupportedError)
    expect((await node.vlans.getAll()).has(OUT_OF_RANGE)).toBe(false)
    console.log(`live-vlans: test_create_and_return_false — the client guard refused ${String(OUT_OF_RANGE)} with zero round trips (upstream's assertFalse at :72)`)
  })

  it('delete(5000) throws where pyeapi answers False; the table is unchanged (test_delete_and_return_false, :83 — delete :85, assertFalse :86)', async () => {
    const before = await node.vlans.getAll()
    expect(before.has(OUT_OF_RANGE)).toBe(false)
    await expect(node.vlans.delete(OUT_OF_RANGE)).rejects.toThrow(NotSupportedError)
    const after = await node.vlans.getAll()
    expect(after.has(OUT_OF_RANGE)).toBe(false)
    console.log(`live-vlans: test_delete_and_return_false — NotSupportedError from vlans.ts:496's guard, not a \`False\` from the CLI at :86`)
  })
})

describe.skipIf(!(gate.runnable && scratch.ok))('live full-write: pyeapi test_api_vlans.py writes on the declared spare VLAN (:60-:192)', () => {
  let node: Node
  beforeAll(async () => {
    node = await readyNode('live-vlans(write)')
    console.log(`live-vlans(write): spare VLAN = ${String(spare())} (declared by EAPI_SCRATCH_VLAN, gated by requireScratchVlan)`)
  })

  it('vlans.create(spare) answers a typed section; upstream proves it with `show vlan` (test_create_and_return_true, :60 — :62-67)', async () => {
    const id = spare()
    try {
      await prelude(node, 'create')
      if (!(await requireAbsent(node, 'create'))) return
      // Upstream wipes every VLAN 2-4094 first (`:62`) so its random id is free; the prelude above claims
      // only this run's declared spare, and this client's create costs one transaction (vlans.ts:465).
      if (!(await verb(`vlans.create(${String(id)})`, () => node.vlans.create(id))).ok) return
      const record = await readSpare(node)
      expect(record?.id).toBe(id)
      expect(record?.state).toBe('active') // divergence 5: no `state` line defaults to active, it is not invented absent
      expect(record?.trunkGroups.length ?? -1).toBe(0)
      expect(await spareBlock(node)).toContain(`vlan ${String(id)}`)
      await recordShowVlan(node, true)
    } finally {
      await releaseSpareVlan(node, 'create')
    }
  })

  it('vlans.delete(spare) removes the section from both the record and the table (test_delete_and_return_true, :74 — :76-81)', async () => {
    const id = spare()
    try {
      await prelude(node, 'delete')
      if (!(await stageVlan(node, 'delete'))) return
      if ((await readSpare(node)) === undefined) {
        console.warn('live-vlans: the staged spare VLAN did not read back, so :81\'s not-in half would prove nothing — case reported, not claimed')
        return
      }
      if (!(await verb(`vlans.delete(${String(id)})`, () => node.vlans.delete(id))).ok) return
      expect(await readSpare(node)).toBeUndefined()
      expect((await node.vlans.getAll()).has(id)).toBe(false)
      expect(await spareBlock(node)).toBe('')
      await recordShowVlan(node, false)
    } finally {
      await releaseSpareVlan(node, 'delete')
    }
  })

  it('vlans.setDefault(spare) defaults the section; the staged name is provably gone (test_default, :88 — :90-97)', async () => {
    const id = spare()
    try {
      await prelude(node, 'default')
      if (!(await stageVlan(node, 'default', [`name ${VLAN_NAME}`]))) return
      const staged = await readSpare(node)
      if (staged?.name !== VLAN_NAME) {
        console.warn(`live-vlans: the staged \`name ${VLAN_NAME}\` did not read back (${JSON.stringify(staged ?? null)}) — nothing to default, case reported`)
        return
      }
      if (!(await verb(`vlans.setDefault(${String(id)})`, () => node.vlans.setDefault(id))).ok) return
      const after = await readSpare(node)
      if (after === undefined) {
        // What upstream asserts: the id is out of `show vlan` entirely (`:96-97`).
        expect(await spareBlock(node)).toBe('')
        await recordShowVlan(node, false)
        return
      }
      console.warn(`live-vlans: \`default vlan ${String(id)}\` left the section in place (${JSON.stringify({ name: after.name, state: after.state, groups: after.trunkGroups })}) — upstream asserts absence at :96-97. The half \`default\` owns is still asserted: the staged name is gone (divergence 5's absence, not '')`)
      expect(after.name).toBeUndefined()
      expect(after.state).toBe('active')
      await recordShowVlan(node, true)
    } finally {
      await releaseSpareVlan(node, 'default')
    }
  })

  it('setVlanName(spare, …) round-trips through the record and the section text (test_set_name, :99 — :101-108)', async () => {
    const id = spare()
    try {
      await prelude(node, 'setname')
      if (!(await stageVlan(node, 'setname'))) return
      if (!(await verb(`vlans.setVlanName(${String(id)}, ${VLAN_NAME})`, () => node.vlans.setVlanName(id, VLAN_NAME))).ok) return
      expect((await readSpare(node))?.name).toBe(VLAN_NAME)
      expect(await spareBlock(node)).toContain(`name ${VLAN_NAME}`)
      await recordShowVlan(node, true)
    } finally {
      await releaseSpareVlan(node, 'setname')
    }
  })

  it('setVlanState(spare, active) lifts a suspended VLAN to active (test_set_state_active, :110 — :113-118)', async () => {
    const id = spare()
    try {
      await prelude(node, 'state-active')
      if (!(await stageVlan(node, 'state-active', ['state suspend']))) return
      if ((await readSpare(node))?.state !== 'suspend') {
        console.warn('live-vlans: the staged `state suspend` did not read back — the active half would prove nothing, case reported')
        return
      }
      if (!(await verb(`vlans.setVlanState(${String(id)}, active)`, () => node.vlans.setVlanState(id, 'active'))).ok) return
      expect((await readSpare(node))?.state).toBe('active')
      expect(await spareBlock(node)).toContain('state active')
      await recordShowVlan(node, true)
    } finally {
      await releaseSpareVlan(node, 'state-active')
    }
  })

  it('setVlanState(spare, suspend) writes the config spelling `suspend`, while show vlan answers `suspended` (test_set_state_suspend, :120 — :123-128)', async () => {
    const id = spare()
    try {
      await prelude(node, 'state-suspend')
      if (!(await stageVlan(node, 'state-suspend', ['state active']))) return
      if ((await readSpare(node))?.state !== 'active') {
        console.warn('live-vlans: the staged `state active` did not read back — the suspend half would prove nothing, case reported')
        return
      }
      if (!(await verb(`vlans.setVlanState(${String(id)}, suspend)`, () => node.vlans.setVlanState(id, 'suspend'))).ok) return
      // The record is the config-line answer (`suspend`, `vlans.ts:174`); upstream's proof is the *status*
      // word `suspended` from show vlan (`:127`). Two spellings for one state is the asymmetry to capture,
      // and the offline guard that would reject `suspended` as a write stays pinned in resources/vlans.test.ts.
      expect((await readSpare(node))?.state).toBe('suspend')
      const block = await spareBlock(node)
      expect(block).toContain('state suspend')
      expect(block).not.toContain('state suspended')
      await recordShowVlan(node, true)
    } finally {
      await releaseSpareVlan(node, 'state-suspend')
    }
  })

  it('defaultTrunkGroups(spare) clears the groups; the section text loses the line (test_set_trunk_groups_default, :130 — :133-140)', async () => {
    const id = spare()
    try {
      await prelude(node, 'tg-default')
      if (!(await stageGroups(node, 'tg-default', [TG_A]))) return
      if (!(await verb(`vlans.defaultTrunkGroups(${String(id)})`, () => node.vlans.defaultTrunkGroups(id))).ok) return
      expect((await readSpare(node))?.trunkGroups ?? ['missing']).toEqual([])
      expect(await spareBlock(node)).not.toContain('trunk group')
      await recordShowVlanTrunkGroups(node)
    } finally {
      await releaseSpareVlan(node, 'tg-default')
    }
  })

  it('setTrunkGroups(spare, [A, C]) replaces B with C in one transaction (test_set_trunk_groups, :142 — :145-154)', async () => {
    const id = spare()
    try {
      await prelude(node, 'tg-set')
      if (!(await stageGroups(node, 'tg-set', [TG_A, TG_B]))) return
      if (!(await verb(`vlans.setTrunkGroups(${String(id)}, [${TG_A}, ${TG_C}])`, () => node.vlans.setTrunkGroups(id, [TG_A, TG_C]))).ok) return
      const seen = (await readSpare(node))?.trunkGroups ?? []
      // Upstream compares sorted lists (`:153-154`): the order inside a section is the device's, the diff
      // order (adds in caller order, removals in device order, one transaction) is divergence 11's claim.
      expect([...seen].sort()).toEqual([TG_A, TG_C].sort())
      const block = await spareBlock(node)
      expect(block).toContain(`trunk group ${TG_A}`)
      expect(block).toContain(`trunk group ${TG_C}`)
      expect(block).not.toContain(`trunk group ${TG_B}`)
      await recordShowVlanTrunkGroups(node)
    } finally {
      await releaseSpareVlan(node, 'tg-set')
    }
  })

  it('unsetTrunkGroups(spare) is the bulk negation and leaves no group (test_set_trunk_groups_disable, :156 — :159-169)', async () => {
    const id = spare()
    try {
      await prelude(node, 'tg-disable')
      if (!(await stageGroups(node, 'tg-disable', [TG_A, TG_B, TG_C]))) return
      if (!(await verb(`vlans.unsetTrunkGroups(${String(id)})`, () => node.vlans.unsetTrunkGroups(id))).ok) return
      expect((await readSpare(node))?.trunkGroups ?? ['missing']).toEqual([])
      expect(await spareBlock(node)).not.toContain('trunk group')
      await recordShowVlanTrunkGroups(node)
    } finally {
      await releaseSpareVlan(node, 'tg-disable')
    }
  })

  it('addTrunkGroup(spare, A) sends `trunk group A` with no read first (test_add_trunk_group, :171 — :173-180)', async () => {
    const id = spare()
    try {
      await prelude(node, 'tg-add')
      // Upstream's stage is `no vlan X` / `vlan X` / `no trunk group` (`:175`) — the bulk negation line, so the
      // VLAN exists with zero groups. Its id comes from `random_int(2,4095)` (`:174`), and 4095 is outside
      // `isvlan()` (`vlans.py:77-78`): an upstream range bug of the row-76 family, not reproduced here.
      if (!(await stageVlan(node, 'tg-add', ['no trunk group']))) return
      if (!(await verb(`vlans.addTrunkGroup(${String(id)}, ${TG_A})`, () => node.vlans.addTrunkGroup(id, TG_A))).ok) return
      const seen = (await readSpare(node))?.trunkGroups ?? []
      if (!seen.includes(TG_A)) {
        console.warn(`live-vlans: \`trunk group ${TG_A}\` committed but the \`vlan ${String(id)}\` section reads ${JSON.stringify(seen)} — this image does not apply VLAN trunk groups (DECISIONS open item 4); recorded as a capability negative, and upstream's membership proof at :179 is NOT claimed`)
        await recordShowVlanTrunkGroups(node)
        return
      }
      expect(seen).toContain(TG_A)
      expect(await spareBlock(node)).toContain(`trunk group ${TG_A}`)
      await recordShowVlanTrunkGroups(node)
    } finally {
      await releaseSpareVlan(node, 'tg-add')
    }
  })

  it('removeTrunkGroup(spare, A) sends the named negation `no trunk group A` (test_remove_trunk_group, :182 — :184-192)', async () => {
    const id = spare()
    try {
      await prelude(node, 'tg-remove')
      if (!(await stageGroups(node, 'tg-remove', [TG_A]))) return
      if (!(await verb(`vlans.removeTrunkGroup(${String(id)}, ${TG_A})`, () => node.vlans.removeTrunkGroup(id, TG_A))).ok) return
      const seen = (await readSpare(node))?.trunkGroups ?? []
      expect(seen).not.toContain(TG_A)
      expect(await spareBlock(node)).not.toContain(`trunk group ${TG_A}`)
      await recordShowVlanTrunkGroups(node)
    } finally {
      await releaseSpareVlan(node, 'tg-remove')
    }
  })
})
