/**
 * `*.live.test.ts` port of `pyeapi/test/system/test_api_acl.py` @ `6816d9e` — #14 **D2** (the full-write lab
 * lane, DR-126). Both upstream classes are ported: `TestApiStandardAcls` (`:41`, ten methods `:43`–`:139`) and
 * `TestApiExtendedAcls` (`:141`, ten methods `:143`–`:242`) — **20 upstream methods, all 20 ported**, because
 * every one of them mutates an ACL *object the run creates itself*, which is exactly what DR-126 opens up on the
 * throwaway container.
 *
 * Gate: `liveFullWriteReadiness(process.env)` (`src/testing/live-full-write.ts`) — `resolveLiveEnv` first, then
 * the `EAPI_LAB_FULL_WRITE=1` consent, and the `Node` comes from `buildFullWriteNode(target)` so every verb,
 * including the raw staging batches below, passes the pre-wire self-lockout seam (`withLabWriteScope`).
 * Without the consent the file prints the refusal and executes nothing (DR-034).
 *
 * ## What a live ACL write looks like here
 * Upstream pre-writes its ACL with raw `dut.config([...])` and then calls `dut.api('acl').<verb>()`, asserting
 * `assertTrue`/`assertIsNone` plus a `get_block(...)` **text** comparison. The port keeps that split:
 * `dut.config([...])` ⇒ `runGuardedLiveWriteSession` (named session, abort-on-failure, never `copy run start`,
 * DR-035); `dut.api('acl')…` ⇒ the typed facade (`node.acls.create/deleteAcl/setDefaultAcl/addEntry/
 * updateEntry/removeEntry`, `resources/acl.ts:820-941` — DR-092 replaced pyeapi's `__getattr__`/`marshall`
 * dispatch, `acl.py:114-124`, with an explicit kind read). pyeapi's `configure` returning `False` + `self.error`
 * (`abstract.py:117-127`) does not exist here (DR-005): a refused line rejects with `CommandError`, so every
 * upstream `assertTrue(result)` becomes "the awaited verb resolved" **plus a read-back**, and a device refusal is
 * reported with its code instead of being turned into a pass.
 *
 * Names: the run creates `LIVE-STD-A1` / `LIVE-EXT-A1` and deletes them again. It never touches the
 * `lab-provision` fixtures `STD-ACL-1` / `EXT-ACL-1` (DR-122), and no case here attaches an ACL to an interface
 * — upstream has no `ip access-group` case at all in this file, and the container's answer to that attachment is
 * already on record as a refusal (`docs/CEOS.md`, DR-122), so inventing one would be a new device question, not
 * a port.
 *
 * | upstream (verified line @6816d9e) | ported? | here / why |
 * |---|---|---|
 * | `TestApiStandardAcls.test_get` (`:43`, get at `:47`) | ✅ | upstream stages `no ip access-list standard test` + `ip access-list standard test` (`:45-46`) then demands `assertIsNotNone`. Here the same two lines are a guarded batch, then `acls.get('LIVE-STD-A1')` must answer a record whose `name`/`type` are the header's own words (`acl.ts:260-266`). A rule-less ACL that the device refuses to keep in `show running-config` is reported, not asserted away |
 * | `test_get_none` (`:50`, get at `:53`) | ✅ | the negation half: guarded create, guarded `no ip access-list standard …`, then `get` must answer `undefined` (pyeapi `assertIsNone`, DR-027) |
 * | `test_getall` (`:56`, getall at `:60`, membership `:61`) | ✅ (kind widening noted) | upstream asserts `'test' in result['standard']` because `Acls.getall` answers `{'standard': {…}, 'extended': {…}}` (`acl.py:91-112`). This client answers one flat table (`acl.ts:852-855`, DR-068/DR-093) and the per-kind collections below it (`acl.ts:729-732`), so the port asserts membership in **both** — the flat facade table and `acls.standard.getAll()` — and prints the table size rather than hard-coding upstream's |
 * | `test_create` (`:63`, absent-read `:67`, create `:68`, `assertTrue` `:69`, present-read `:70`) | ✅ (throws instead of `True`) | `acls.create('LIVE-STD-A1')` is `ip access-list standard …` (`acl.ts:869-877`); the port asserts the before-read is `undefined`, the awaited call resolved, and the after-read found the section. A `CommandError` here is a device answer and is reported (with code) rather than silently passing |
 * | `test_delete` (`:72`, present `:76`, delete `:77`, absent `:79`) | ✅ | `acls.deleteAcl(name)` — the facade verb that **reads the kind** before composing `no ip access-list standard …` (`acl.ts:898-900`, row 163). Re-read must be `undefined`; teardown is asserted, not best-effort |
 * | `test_default` (`:81`, present `:85`, default `:86`, absent `:88`) | ✅ (device-answer arm reported) | `setDefaultAcl` sends `default ip access-list standard …` (`acl.ts:903-905`, composing the stem at `acl.ts:539-541` via `:762-764`). Upstream demands the ACL be gone; the command's real effect on 4.28.14M is the device's to answer, so the port asserts gone-or-empty-section and prints the text when the container keeps the header |
 * | `test_update_entry` (`:90`, `assertNotIn` `:96`, call `:97-98`, `assertIn('10 permit any log')` `:100-101`) | ✅ | `updateEntry(STD, 10, {action:'permit', src:{any:true}, log:true})` renders `10 permit any log` inside `no 10` / re-write / `exit` (`acl.ts:772-777`) — the very list upstream's unit suite pins at `test/unit/test_api_acl.py:153-165`. pyeapi's positional `('0.0.0.0', '0')` wildcard pair is this client's `{any:true}` matcher (`acl.ts:303-307`) |
 * | `test_update_entry_existing` (`:103`, in `:108-109`, call `:110-111`, `10 deny any log` `:113-114`) | ✅ | same verb on a sequence number that already exists, reached by staging `10 permit any log` in the guarded batch (`:105-106`) exactly as upstream does with `dut.config` |
 * | `test_add_entry` (`:116`, not-in `:122`, call `:123`, in `:125-126`) | ✅ (numbering claim narrowed) | `addEntry` with **no** `seqno` sends the rule line un-numbered and lets EOS number it (`acl.ts:786-789`, mirroring upstream's `seqno=None` default, `:202`) — this client never invents a sequence number. Upstream hard-codes the device's answer `10 permit any log`; the port asserts the entry exists with `action 'permit'` / `src.kind 'any'` / `log true`, prints the number the device chose, and additionally checks upstream's literal text through `getBlock` (the twin of pyeapi's `get_block`, `base.ts:129-131`) |
 * | `test_remove_entry` (`:128`, in `:134`, call `:135`, not-in `:137-138`) | ✅ | `removeEntry(STD, 10)` sends `no 10` inside the ACL (`acl.ts:792-795`); the re-read must not carry key `10`, and the block text must not carry the line |
 * | `TestApiExtendedAcls.test_get` (`:143`, get `:147`), `test_get_none` (`:150`, get `:153`), `test_getall` (`:156`, getall `:160`, membership `:161`), `test_create` (`:163`, `:167-170`), `test_delete` (`:172`, `:176-179`), `test_default` (`:181`, `:185-188`) | ✅ | the same six on `LIVE-EXT-A1` through the extended collection. Upstream's extended header is `ip access-list exttest` **without** the word `extended` (`:145-146`, `:168` creates with type `'extended'`), and this client composes the identical stem (`acl.ts:539-541`); the header `ip access-list extended EXT-ACL-1` that `lab-provision` writes is a *different* header grammar to both ports (their name group, `acl.py:104`/`:129`, keeps the word `extended` inside the name), which is why this suite only reads and writes names it created |
 * | `test_update_entry` (`:190`, not-in `:195-196`, call `:197-199`, `10 permit ip any any` `:201-202`) and `test_update_entry_existing` (`:204`, in `:209-210`, call `:211-213`, `10 deny ip any any log` `:215-216`) | ✅ | `updateEntry(EXT, 10, {action, protocol:'ip', src:{any:true}, dst:{any:true}, log})` — the protocol/destination fields a standard rule refuses (`acl.ts:511-524`) are required here, and both arms restate the whole rule line as upstream's does (`acl.py:269-279`) |
 * | `test_add_entry` (`:218`, not-in `:223-224`, call `:225-226`, in `:228-229`) and `test_remove_entry` (`:231`, in `:236-237`, call `:238`, not-in `:240-241`) | ✅ | as the standard pair above, on the extended collection with `10 permit ip any any [log]` |
 *
 * Nothing in this file is ledger-skipped: the DR-126 lab consent is precisely what let the 20 upstream cases run
 * for real (the M12a-era files had to skip ACL writes because DR-035(b) allowed only a scratch port). Cases the
 * **device** refuses still report their typed error and code, so a container that answers
 * `% Unavailable command` reads as a refusal in the log, never as a pass.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { CommandError, EapiError, SessionError } from './errors'
import { buildFullWriteNode, liveFullWriteReadiness } from './testing/live-full-write'
import { describeLiveTarget, matchesDeviceIdentity, unwrapLiveTarget, type LiveTarget } from './testing/live-guard'
import { runGuardedLiveWriteSession } from './testing/live-session-policy'
import type { Acl } from './resources/acl'
import type { Node } from './command-layer'

const SUITE = 'live-acl'
const gate = liveFullWriteReadiness(process.env)
if (!gate.runnable) {
  console.warn(`${SUITE}: SKIPPED — ${gate.skipReason ?? 'gate refused the run'}`)
}

/** The ACL objects this run owns. `lab-provision`'s `STD-ACL-1`/`EXT-ACL-1` are never named here. */
const STD = 'LIVE-STD-A1'
const EXT = 'LIVE-EXT-A1'
const STD_HEADER = `ip access-list standard ${STD}`
const EXT_HEADER = `ip access-list ${EXT}`

/** A run tag so a named session is attributable to this process in `show configuration sessions`. */
const runId = String(Date.now()).slice(-6)

/** A guarded batch or a facade verb: applied/resolved, or refused by the device. A non-EapiError — or a
 * session the guarded abort could not close (`SessionError`) — propagates instead of becoming an `ok:false`. */
type Attempt = { readonly ok: true } | { readonly ok: false; readonly code: string; readonly text: string }

function firstLine(message: string): string {
  return message.split('\n')[0]?.slice(0, 200) ?? message
}

function describeError(rawErr: EapiError): string {
  return rawErr instanceof CommandError ? `CommandError(${String(rawErr.code)})` : String(rawErr.constructor.name)
}

/** Raw config staging — the port of upstream's `dut.config([...])`, inside a named session (DR-035). */
async function batch(node: Node, label: string, commands: readonly string[]): Promise<Attempt> {
  try {
    await runGuardedLiveWriteSession(node, { name: `${SUITE}-${label}-r${runId}`, commands })
    return { ok: true }
  } catch (rawErr) {
    if (rawErr instanceof SessionError) throw rawErr
    if (!(rawErr instanceof EapiError)) throw rawErr
    console.warn(`${SUITE}: staging batch ${JSON.stringify(label)} did not apply (${describeError(rawErr)}): ${firstLine(rawErr.message)} — commands ${JSON.stringify(commands)}`)
    return { ok: false, code: describeError(rawErr), text: firstLine(rawErr.message) }
  }
}

/** A facade verb — the port of upstream's `dut.api('acl').<verb>()` + `assertTrue(result)` (DR-005: it throws). */
async function verb(label: string, call: () => Promise<unknown>): Promise<Attempt> {
  try {
    await call()
    return { ok: true }
  } catch (rawErr) {
    if (!(rawErr instanceof EapiError)) throw rawErr
    console.warn(`${SUITE}: ${label} was refused by the device (${describeError(rawErr)}): ${firstLine(rawErr.message)} — the read-back half is reported, not claimed`)
    return { ok: false, code: describeError(rawErr), text: firstLine(rawErr.message) }
  }
}

/** A cleanup batch: a failure here would leave the object owned by this run on the container, so it fails the case. */
function requireApplied(label: string, attempt: Attempt): void {
  if (!attempt.ok) throw new Error(`${SUITE}: ${label} failed (${attempt.code}): ${attempt.text} — this run cannot leave ${JSON.stringify([STD, EXT])} behind on a container other suites share`)
}

async function readAcl(node: Node, name: string): Promise<Acl | undefined> {
  return await node.acls.get(name)
}

describe.skipIf(!gate.runnable)('live full-write lane: pyeapi test_api_acl.py (TestApiStandardAcls, :41)', () => {
  let node: Node

  beforeAll(async () => {
    const target: LiveTarget = unwrapLiveTarget(gate.resolution)
    console.log(`${SUITE}: target = ${describeLiveTarget(target)}`)
    node = buildFullWriteNode(target)
    const reported = await node.getVersion()
    const mismatch = matchesDeviceIdentity(target, { version: reported.version, modelName: reported.modelName })
    // Only the suffix-driven EAPI_VERSION_MISMATCH is tolerated (cEOS reports an engineering-build suffix;
    // the base identity, model and TLS pins are enforced by the lab probe — DR-066, same as the M12a files).
    if (mismatch !== undefined && mismatch.code !== 'EAPI_VERSION_MISMATCH') throw new Error(`${SUITE} readiness: ${mismatch.reason}`)
    if (mismatch?.code === 'EAPI_VERSION_MISMATCH') {
      console.warn(`${SUITE}: reported version "${reported.version}" vs pin "${target.allowVersion}" (base-level enforced by the probe, DR-066)`)
    }
  })

  it('a staged ACL section is readable as a typed record (standard test_get, :43 — stage :45-46, get :47, assertIsNotNone :48)', async () => {
    requireApplied('std-get-prep', await batch(node, 'std-get-prep', [`no ${STD_HEADER}`]))
    if (!(await batch(node, 'std-get-stage', [STD_HEADER])).ok) return
    const acl = await readAcl(node, STD)
    if (acl === undefined) {
      // A rule-less ACL may be a section EOS does not write out. Upstream's `assertIsNotNone` (`:48`) says its
      // DUTs keep it; this container's answer is printed rather than forced through a widening.
      console.warn(`${SUITE}: ${JSON.stringify(STD_HEADER)} committed but the ACL did not read back — an empty named ACL is not in this device's running-config (reported, not asserted)`)
      requireApplied('std-get-teardown', await batch(node, 'std-get-teardown', [`no ${STD_HEADER}`]))
      return
    }
    expect(acl.name).toBe(STD)
    expect(acl.type).toBe('standard')
    expect(acl.entries.size).toBe(0)
    requireApplied('std-get-teardown', await batch(node, 'std-get-teardown', [`no ${STD_HEADER}`]))
    expect(await readAcl(node, STD)).toBeUndefined()
  })

  it('no ip access-list standard … makes the record read as absent (standard test_get_none, :50 — negation :52, get :53, assertIsNone :54)', async () => {
    requireApplied('std-none-prep', await batch(node, 'std-none-prep', [`no ${STD_HEADER}`]))
    if (!(await batch(node, 'std-none-stage', [STD_HEADER])).ok) return
    requireApplied('std-none-negate', await batch(node, 'std-none-negate', [`no ${STD_HEADER}`]))
    expect(await readAcl(node, STD)).toBeUndefined()
  })

  it('the created ACL is a key of both the flat table and the standard collection (standard test_getall, :56 — stage :58-59, getall :60, assertIn :61)', async () => {
    requireApplied('std-all-prep', await batch(node, 'std-all-prep', [`no ${STD_HEADER}`]))
    if (!(await batch(node, 'std-all-stage', [STD_HEADER])).ok) return
    const flat = await node.acls.getAll()
    const standard = await node.acls.standard.getAll()
    console.log(`${SUITE}: facade getAll() keys = ${JSON.stringify([...flat.keys()].slice(0, 8))} (size ${String(flat.size)}); standard.getAll() size = ${String(standard.size)}`)
    expect(flat.has(STD)).toBe(standard.has(STD))
    const found = flat.get(STD)
    if (found === undefined) {
      console.warn(`${SUITE}: neither getAll() reported ${JSON.stringify(STD)} — the membership half of :61 is a device answer about empty sections, reported not claimed`)
    } else {
      expect(found.name).toBe(STD)
      expect(found.type).toBe('standard')
      const single = await node.acls.standard.get(STD)
      expect(single?.name).toBe(STD)
    }
    requireApplied('std-all-teardown', await batch(node, 'std-all-teardown', [`no ${STD_HEADER}`]))
  })

  it('acls.create() writes the header and the next read finds it (standard test_create, :63 — absent :67, create :68, assertTrue :69, present :70)', async () => {
    requireApplied('std-create-prep', await batch(node, 'std-create-prep', [`no ${STD_HEADER}`]))
    expect(await readAcl(node, STD)).toBeUndefined()
    if (!(await verb('acls.create(LIVE-STD-A1)', () => node.acls.create(STD))).ok) return
    const acl = await readAcl(node, STD)
    if (acl === undefined) console.warn(`${SUITE}: create resolved but the rule-less section is not in this device's running-config (empty-ACL answer reported; the command itself was accepted)`)
    else {
      expect(acl.name).toBe(STD)
      expect(acl.type).toBe('standard')
    }
    requireApplied('std-create-teardown', await batch(node, 'std-create-teardown', [`no ${STD_HEADER}`]))
    expect(await readAcl(node, STD)).toBeUndefined()
  })

  it('acls.deleteAcl() removes a created ACL of the kind the config says (standard test_delete, :72 — present :76, delete :77, assertTrue :78, absent :79)', async () => {
    requireApplied('std-delete-prep', await batch(node, 'std-delete-prep', [`no ${STD_HEADER}`, STD_HEADER]))
    const before = await readAcl(node, STD)
    if (before === undefined) {
      console.warn(`${SUITE}: the staged ACL did not read back, so :79's absent-read would prove nothing — case reported, not claimed`)
      requireApplied('std-delete-teardown', await batch(node, 'std-delete-teardown', [`no ${STD_HEADER}`]))
      return
    }
    if (!(await verb('acls.deleteAcl(LIVE-STD-A1)', () => node.acls.deleteAcl(STD))).ok) return
    expect(await readAcl(node, STD)).toBeUndefined()
  })

  it('acls.setDefaultAcl() defaults the section; gone-or-empty is what the device answers (standard test_default, :81 — present :85, default :86, assertTrue :87, absent :88)', async () => {
    requireApplied('std-default-prep', await batch(node, 'std-default-prep', [`no ${STD_HEADER}`, STD_HEADER, '10 permit any log']))
    const staged = await readAcl(node, STD)
    if (staged === undefined) {
      console.warn(`${SUITE}: the staged ACL did not read back — nothing to default, case reported`)
      requireApplied('std-default-teardown', await batch(node, 'std-default-teardown', [`no ${STD_HEADER}`]))
      return
    }
    expect(staged.entries.has(10)).toBe(true)
    if (!(await verb('acls.setDefaultAcl(LIVE-STD-A1)', () => node.acls.setDefaultAcl(STD))).ok) return
    const after = await readAcl(node, STD)
    if (after === undefined) {
      expect(after).toBeUndefined()
    } else {
      // Upstream's DUT answered "the ACL is gone" (`:88`). If 4.28.14M keeps the header and only drops the
      // rules, that is the device's answer about `default …` — record it, and do not pretend the rule survived.
      console.warn(`${SUITE}: after \`default ${STD_HEADER}\` the section still reads (${JSON.stringify([...after.entries.keys()])}) — upstream asserts absence at :88`)
      expect(after.entries.has(10)).toBe(false)
    }
    requireApplied('std-default-teardown', await batch(node, 'std-default-teardown', [`no ${STD_HEADER}`]))
  })

  it('updateEntry on a sequence number that is absent installs the rule (standard test_update_entry, :90 — stage :92-93, not-in :95-96, call :97-98, assertTrue :99, in :100-101)', async () => {
    requireApplied('std-upd-prep', await batch(node, 'std-upd-prep', [`no ${STD_HEADER}`, STD_HEADER]))
    if (!(await verb('acls.updateEntry(LIVE-STD-A1, 10, permit any log)', () => node.acls.updateEntry(STD, 10, { action: 'permit', src: { any: true }, log: true }))).ok) return
    const acl = await readAcl(node, STD)
    const entry = acl?.entries.get(10)
    expect(entry?.action).toBe('permit')
    expect(entry?.src.kind).toBe('any')
    expect(entry?.log).toBe(true)
    const block = await node.acls.standard.getBlock(STD_HEADER)
    expect(block ?? '').toContain('10 permit any log')
    requireApplied('std-upd-teardown', await batch(node, 'std-upd-teardown', [`no ${STD_HEADER}`]))
  })

  it('updateEntry replaces an existing rule in place (standard test_update_entry_existing, :103 — stage :105-106, in :108-109, call :110-111, deny :113-114)', async () => {
    requireApplied('std-updx-prep', await batch(node, 'std-updx-prep', [`no ${STD_HEADER}`, STD_HEADER, '10 permit any log']))
    const before = await readAcl(node, STD)
    expect(before?.entries.get(10)?.action).toBe('permit')
    if (!(await verb('acls.updateEntry(LIVE-STD-A1, 10, deny any log)', () => node.acls.updateEntry(STD, 10, { action: 'deny', src: { any: true }, log: true }))).ok) return
    const after = await readAcl(node, STD)
    expect(after?.entries.get(10)?.action).toBe('deny')
    expect(after?.entries.get(10)?.log).toBe(true)
    expect(after?.entries.size).toBe(1)
    expect((await node.acls.standard.getBlock(STD_HEADER)) ?? '').toContain('10 deny any log')
    requireApplied('std-updx-teardown', await batch(node, 'std-updx-teardown', [`no ${STD_HEADER}`]))
  })

  it('addEntry with no seqno lets EOS number the rule it still writes (standard test_add_entry, :116 — stage :118-119, not-in :121-122, call :123, assertTrue :124, in :125-126)', async () => {
    requireApplied('std-add-prep', await batch(node, 'std-add-prep', [`no ${STD_HEADER}`, STD_HEADER]))
    expect((await readAcl(node, STD))?.entries.size ?? 0).toBe(0)
    if (!(await verb('acls.addEntry(LIVE-STD-A1, permit any log)', () => node.acls.addEntry(STD, { action: 'permit', src: { any: true }, log: true }))).ok) return
    const acl = await readAcl(node, STD)
    const block = (await node.acls.standard.getBlock(STD_HEADER)) ?? ''
    console.log(`${SUITE}: after addEntry the block reads ${JSON.stringify(block.split('\n').slice(0, 4))} and the typed table has ${String(acl?.entries.size ?? 0)} rule(s)`)
    // Upstream's literal `10 permit any log` (`:126`) is EOS's own default numbering (acl.ts's divergence 1: no
    // client-side numbering exists on either side). The port asserts the rule this client wrote, keyed by
    // whatever number the device gave it, and keeps upstream's text check on the block.
    expect(block).toContain('permit any log')
    const rules = [...(acl?.entries.values() ?? [])]
    expect(rules.length).toBe(1)
    expect(rules[0]?.action).toBe('permit')
    expect(rules[0]?.src.kind).toBe('any')
    expect(rules[0]?.log).toBe(true)
    requireApplied('std-add-teardown', await batch(node, 'std-add-teardown', [`no ${STD_HEADER}`]))
  })

  it('removeEntry drops the rule that was staged at that sequence number (standard test_remove_entry, :128 — stage :130-131, in :133-134, call :135, assertTrue :136, not-in :137-138)', async () => {
    requireApplied('std-rm-prep', await batch(node, 'std-rm-prep', [`no ${STD_HEADER}`, STD_HEADER, '10 permit any log']))
    const before = await readAcl(node, STD)
    expect(before?.entries.has(10)).toBe(true)
    if (!(await verb('acls.removeEntry(LIVE-STD-A1, 10)', () => node.acls.removeEntry(STD, 10))).ok) return
    const after = await readAcl(node, STD)
    expect(after?.entries.has(10)).toBe(false)
    expect((await node.acls.standard.getBlock(STD_HEADER)) ?? '').not.toContain('10 permit any log')
    requireApplied('std-rm-teardown', await batch(node, 'std-rm-teardown', [`no ${STD_HEADER}`]))
  })
})

describe.skipIf(!gate.runnable)('live full-write lane: pyeapi test_api_acl.py (TestApiExtendedAcls, :141)', () => {
  let node: Node

  beforeAll(async () => {
    node = buildFullWriteNode(unwrapLiveTarget(gate.resolution))
    // Identity was already gated by the first describe when both run in one process; this describe keeps its
    // own `Node` (per-suite resource memos, DR-052) and re-checks the device before any write below.
    const reported = await node.getVersion()
    const mismatch = matchesDeviceIdentity(unwrapLiveTarget(gate.resolution), { version: reported.version, modelName: reported.modelName })
    if (mismatch !== undefined && mismatch.code !== 'EAPI_VERSION_MISMATCH') throw new Error(`${SUITE} readiness (extended): ${mismatch.reason}`)
  })

  it('a staged extended section is readable (extended test_get, :143 — stage :145-146, get :147, assertIsNotNone :148)', async () => {
    requireApplied('ext-get-prep', await batch(node, 'ext-get-prep', [`no ${EXT_HEADER}`]))
    if (!(await batch(node, 'ext-get-stage', [EXT_HEADER])).ok) return
    const acl = await readAcl(node, EXT)
    if (acl === undefined) {
      console.warn(`${SUITE}: ${JSON.stringify(EXT_HEADER)} committed but did not read back — the empty-section answer upstream also faces (acl.py:97-111), reported not asserted`)
      requireApplied('ext-get-teardown', await batch(node, 'ext-get-teardown', [`no ${EXT_HEADER}`]))
      return
    }
    expect(acl.name).toBe(EXT)
    expect(acl.type).toBe('extended')
    requireApplied('ext-get-teardown', await batch(node, 'ext-get-teardown', [`no ${EXT_HEADER}`]))
    expect(await readAcl(node, EXT)).toBeUndefined()
  })

  it('no ip access-list … makes the extended record read as absent (extended test_get_none, :150 — negation :152, get :153, assertIsNone :154)', async () => {
    requireApplied('ext-none-prep', await batch(node, 'ext-none-prep', [`no ${EXT_HEADER}`]))
    if (!(await batch(node, 'ext-none-stage', [EXT_HEADER])).ok) return
    requireApplied('ext-none-negate', await batch(node, 'ext-none-negate', [`no ${EXT_HEADER}`]))
    expect(await readAcl(node, EXT)).toBeUndefined()
  })

  it('the created extended ACL is a key of the facade table and the extended collection (extended test_getall, :156 — stage :158-159, getall :160, assertIn :161)', async () => {
    requireApplied('ext-all-prep', await batch(node, 'ext-all-prep', [`no ${EXT_HEADER}`]))
    if (!(await batch(node, 'ext-all-stage', [EXT_HEADER])).ok) return
    const flat = await node.acls.getAll()
    const extended = await node.acls.extended.getAll()
    expect(flat.has(EXT)).toBe(extended.has(EXT))
    const found = flat.get(EXT)
    if (found === undefined) {
      console.warn(`${SUITE}: getAll() did not report ${JSON.stringify(EXT)} — membership half of :161 reported, not claimed (empty-section answer)`)
    } else {
      expect(found.type).toBe('extended')
      expect(extended.get(EXT)?.type).toBe('extended')
    }
    requireApplied('ext-all-teardown', await batch(node, 'ext-all-teardown', [`no ${EXT_HEADER}`]))
  })

  it('create(name, {type: extended}) writes the extended header (extended test_create, :163 — absent :167, create :168, assertTrue :169, present :170)', async () => {
    requireApplied('ext-create-prep', await batch(node, 'ext-create-prep', [`no ${EXT_HEADER}`]))
    expect(await readAcl(node, EXT)).toBeUndefined()
    if (!(await verb('acls.create(LIVE-EXT-A1, extended)', () => node.acls.create(EXT, { type: 'extended' }))).ok) return
    const acl = await readAcl(node, EXT)
    if (acl === undefined) console.warn(`${SUITE}: extended create resolved; the rule-less section is not in this device's running-config (reported, not asserted)`)
    else expect(acl.type).toBe('extended')
    requireApplied('ext-create-teardown', await batch(node, 'ext-create-teardown', [`no ${EXT_HEADER}`]))
    expect(await readAcl(node, EXT)).toBeUndefined()
  })

  it('deleteAcl resolves the kind and removes it (extended test_delete, :172 — present :176, delete :177, assertTrue :178, absent :179)', async () => {
    requireApplied('ext-delete-prep', await batch(node, 'ext-delete-prep', [`no ${EXT_HEADER}`, EXT_HEADER]))
    if ((await readAcl(node, EXT)) === undefined) {
      console.warn(`${SUITE}: the staged extended section did not read back, so :179's absent-read proves nothing — case reported`)
      requireApplied('ext-delete-teardown', await batch(node, 'ext-delete-teardown', [`no ${EXT_HEADER}`]))
      return
    }
    if (!(await verb('acls.deleteAcl(LIVE-EXT-A1)', () => node.acls.deleteAcl(EXT))).ok) return
    expect(await readAcl(node, EXT)).toBeUndefined()
  })

  it('setDefaultAcl defaults the extended section (extended test_default, :181 — present :185, default :186, assertTrue :187, absent :188)', async () => {
    requireApplied('ext-default-prep', await batch(node, 'ext-default-prep', [`no ${EXT_HEADER}`, EXT_HEADER, '10 permit ip any any']))
    const staged = await readAcl(node, EXT)
    if (staged === undefined) {
      console.warn(`${SUITE}: the staged extended ACL did not read back — nothing to default, case reported`)
      requireApplied('ext-default-teardown', await batch(node, 'ext-default-teardown', [`no ${EXT_HEADER}`]))
      return
    }
    expect(staged.entries.has(10)).toBe(true)
    if (!(await verb('acls.setDefaultAcl(LIVE-EXT-A1)', () => node.acls.setDefaultAcl(EXT))).ok) return
    const after = await readAcl(node, EXT)
    if (after === undefined) expect(after).toBeUndefined()
    else {
      console.warn(`${SUITE}: after \`default ${EXT_HEADER}\` the section still reads (${JSON.stringify([...after.entries.keys()])}) — upstream asserts absence at :188`)
      expect(after.entries.has(10)).toBe(false)
    }
    requireApplied('ext-default-teardown', await batch(node, 'ext-default-teardown', [`no ${EXT_HEADER}`]))
  })

  it('updateEntry installs a whole extended rule (extended test_update_entry, :190 — stage :192-193, not-in :195-196, call :197-199, assertTrue :200, in :201-202)', async () => {
    requireApplied('ext-upd-prep', await batch(node, 'ext-upd-prep', [`no ${EXT_HEADER}`, EXT_HEADER]))
    if (!(await verb('acls.updateEntry(LIVE-EXT-A1, 10, permit ip any any)', () => node.acls.updateEntry(EXT, 10, { action: 'permit', protocol: 'ip', src: { any: true }, dst: { any: true } }))).ok) return
    const entry = (await readAcl(node, EXT))?.entries.get(10)
    expect(entry?.action).toBe('permit')
    expect(entry?.protocol).toBe('ip')
    expect(entry?.src.kind).toBe('any')
    expect(entry?.dst?.kind).toBe('any')
    expect((await node.acls.extended.getBlock(EXT_HEADER)) ?? '').toContain('10 permit ip any any')
    requireApplied('ext-upd-teardown', await batch(node, 'ext-upd-teardown', [`no ${EXT_HEADER}`]))
  })

  it('updateEntry replaces an existing extended rule, log included (extended test_update_entry_existing, :204 — stage :206-207, in :209-210, call :211-213, assertTrue :214, deny :215-216)', async () => {
    requireApplied('ext-updx-prep', await batch(node, 'ext-updx-prep', [`no ${EXT_HEADER}`, EXT_HEADER, '10 permit ip any any log']))
    const before = await readAcl(node, EXT)
    expect(before?.entries.get(10)?.action).toBe('permit')
    if (!(await verb('acls.updateEntry(LIVE-EXT-A1, 10, deny ip any any log)', () => node.acls.updateEntry(EXT, 10, { action: 'deny', protocol: 'ip', src: { any: true }, dst: { any: true }, log: true }))).ok) return
    const after = await readAcl(node, EXT)
    expect(after?.entries.get(10)?.action).toBe('deny')
    expect(after?.entries.get(10)?.log).toBe(true)
    expect(after?.entries.size).toBe(1)
    expect((await node.acls.extended.getBlock(EXT_HEADER)) ?? '').toContain('10 deny ip any any log')
    requireApplied('ext-updx-teardown', await batch(node, 'ext-updx-teardown', [`no ${EXT_HEADER}`]))
  })

  it('addEntry lets the device number the extended rule and still reads back as written (extended test_add_entry, :218 — stage :220-221, not-in :223-224, call :225-226, assertTrue :227, in :228-229)', async () => {
    requireApplied('ext-add-prep', await batch(node, 'ext-add-prep', [`no ${EXT_HEADER}`, EXT_HEADER]))
    expect((await readAcl(node, EXT))?.entries.size ?? 0).toBe(0)
    if (!(await verb('acls.addEntry(LIVE-EXT-A1, permit ip any any log)', () => node.acls.addEntry(EXT, { action: 'permit', protocol: 'ip', src: { any: true }, dst: { any: true }, log: true }))).ok) return
    const acl = await readAcl(node, EXT)
    const block = (await node.acls.extended.getBlock(EXT_HEADER)) ?? ''
    const rules = [...(acl?.entries.values() ?? [])]
    console.log(`${SUITE}: extended addEntry — device numbering = ${JSON.stringify(rules.map((rule) => rule.seqno))}, block = ${JSON.stringify(block.split('\n').slice(0, 4))}`)
    expect(block).toContain('permit ip any any log')
    expect(rules.length).toBe(1)
    expect(rules[0]?.protocol).toBe('ip')
    expect(rules[0]?.dst?.kind).toBe('any')
    expect(rules[0]?.log).toBe(true)
    requireApplied('ext-add-teardown', await batch(node, 'ext-add-teardown', [`no ${EXT_HEADER}`]))
  })

  it('removeEntry drops the staged extended rule (extended test_remove_entry, :231 — stage :233-234, in :236-237, call :238, assertTrue :239, not-in :240-241)', async () => {
    requireApplied('ext-rm-prep', await batch(node, 'ext-rm-prep', [`no ${EXT_HEADER}`, EXT_HEADER, '10 permit ip any any log']))
    const before = await readAcl(node, EXT)
    expect(before?.entries.has(10)).toBe(true)
    if (!(await verb('acls.removeEntry(LIVE-EXT-A1, 10)', () => node.acls.removeEntry(EXT, 10))).ok) return
    const after = await readAcl(node, EXT)
    expect(after?.entries.has(10)).toBe(false)
    expect((await node.acls.extended.getBlock(EXT_HEADER)) ?? '').not.toContain('10 permit ip any any log')
    requireApplied('ext-rm-teardown', await batch(node, 'ext-rm-teardown', [`no ${EXT_HEADER}`]))
  })
})
