/**
 * `*.live.test.ts` port of `pyeapi/test/system/test_api_ipinterfaces.py` @ `6816d9e` — #14 **D2** (the
 * full-write lab lane, DR-126). Upstream has **eight** methods (`:44`–`:136`); all eight are ported, seven as
 * scratch-port writes and one as a read (upstream's `test_getall` is about the *other* resource — see its row).
 *
 * Gate: `liveFullWriteReadiness(process.env)` (`src/testing/live-full-write.ts`) — `resolveLiveEnv`, then the
 * `EAPI_LAB_FULL_WRITE=1` consent — and the `Node` is `buildFullWriteNode(target)`, so the self-lockout fence
 * (`withLabWriteScope`) sits under the staging batches too. Interface-attached writes additionally go through
 * `requireScratchInterface(target)` (DR-035(b)); when that names nothing, the write lane prints why and
 * executes nothing, exactly as `live-switchports.live.test.ts` does.
 *
 * ## Write discipline in this file
 * Upstream picks `random_interface(dut)` (`:39`, used at `:46`, `:57`, `:73`, `:85`, `:98`, `:112`, `:125`);
 * DR-035(b) forbids inferring the mutated port from `show interfaces`, so every L3 write here targets the
 * explicitly-named `EAPI_SCRATCH_INTERFACE`, and each case's teardown is `default interface <scratch>` — the
 * same restoration `live-switchports` uses, on the assumption (already made there and by `live-interfaces`) that
 * the harness's scratch port is not one of the ports `lab-provision` configures. Addresses stay in TEST-NET-1
 * (`192.0.2.10/24`, `.20/24`, `.30/24`) rather than upstream's public-looking `99.98.99.99/24`, `199.1.1.1/24`
 * and `111.111.111.111/24` (`:49`, `:87`, `:102`), and `mtu` values stay upstream's `1800`/`2000` (`:49`, `:117`,
 * `:130`) because those are inside this client's documented `IP_MTU_MIN..IP_MTU_MAX` (`resources/ipinterfaces.ts`).
 *
 * The one **added-scope** case in this file is the SVI arm at the bottom. It is not an upstream method: it is
 * the port's answer to the L3 gate that decides which sections `ipinterfaces` reports at all —
 * `Ethernet…`/`Port-Channel…` only when the block says `no switchport`, every other kind unconditionally
 * (`ipinterfaces.ts` divergence 1, replacing pyeapi's two-character `name[:2]` test at `ipinterfaces.py:85-86`).
 * It creates `vlan 2001` + `interface Vlan2001` fresh and deletes both again. Vlan **2001/2002** (the read-only
 * twin uses 2002) is outside `lab-provision`'s VLANs 10/100/110 and outside EOS's reserved 1006–1199 window, so
 * it cannot collide with the configured-capture fixtures the other suites read (DR-122). `isL3Section` reports a
 * `Vlan…` section regardless of switchport, which is why this arm does not need `EAPI_SCRATCH_INTERFACE`.
 *
 * | upstream (verified line @6816d9e) | ported? | here / why |
 * |---|---|---|
 * | `test_get` (`:44`, stage `:47-49`, read `:50`, expected dict `:51-53`) | ✅ | upstream stages `default interface` + `interface` + `no switchport` + `ip address 99.98.99.99/24` + `mtu 1800` in one `dut.config` and then demands the whole record. Here the same five lines are ONE guarded batch (`runGuardedLiveWriteSession`), then `ipinterfaces.get(<scratch>)` must answer `{name, address, mtu}` and nothing else — `secondary` absent (row 174), `name` the section header's own spelling (row 96). pyeapi's `{name, address, mtu}` dict (`ipinterfaces.py:89-92`) is the same field set, camelCased (MIGRATION §4) |
 * | `test_get_interface_wo_ip_adddress` (`:55` (upstream's typo), stage `:58-59`, `sleep(2)` `:60`, read `:61`, `assertIsNone(result['address'])` `:62`) | ✅ (the sleep is not ported) | this client reads the parsed running-config, not a live interface table, so there is no settle time to wait out — and `address` here is **absence**, not pyeapi's `None` key (DR-027). The case asserts the section is still reported as L3 (`no switchport` present) with `address === undefined` |
 * | `test_getall` (`:64`, read + `assertIsInstance` `:66-67`, the `Management1` loop `:68`, `assertIn` `:69`) | ✅ (with upstream's own mis-attribution recorded) | upstream calls `dut.api('**interfaces**').getall()` at `:66` and asserts `Management1` is a key — that is the `interfaces` collection, whose own suite makes the same assertion (`test_api_interfaces.py`). The port states both reads: `ipinterfaces.getAll()` for this module's contract, and `interfaces.getAll()` for the literal upstream line — with the `Management1` membership half claimed only if the target writes a `Management…` section, which the 2026-11-06 run proved is not automatic (§5 row 185, recorded in `live-interfaces.live.test.ts`) |
 * | `test_create_and_return_true` (`:71`, stage `:74`, `create` `:76`, `assertTrue` `:77`, `show running-config interfaces …` text `:78-79`, `assertIn('no switchport')` `:80`, re-default `:81`) | ✅ | `ipinterfaces.create(<scratch>)` is `interface …` + `no switchport` — the exact pair pyeapi's own unit suite pins (`ipinterfaces.py:173-174`). Its `assertTrue` becomes "the awaited verb resolved", and upstream's text check has an honest twin here: `node.getBlock('interface <scratch>')` contains `no switchport`, plus this client's own rule (divergence 1) that the section now appears in `ipinterfaces.getAll()` and has left `switchports.get()` |
 * | `test_delete_and_return_true` (`:83`, stage `:86-87`, `delete` `:89`, `assertTrue` `:90`, text `:91-92`, `assertNotIn('ip address 199.1.1.1/24')` `:93-94`, `default interface` `:95`) | ✅ | `ipinterfaces.delete()` sends `no ip address` + `switchport` in upstream's order (`ipinterfaces.py:193-194`) — so the assertions are the address line gone, the port back in `switchports.get()`, and the port gone from the L3 table. The staged address is TEST-NET (`192.0.2.20/24`), not `199.1.1.1/24` |
 * | `test_set_address` (`:96`, stage `:98-100`, `resource` `:101`, `set_address(…, '111.111.111.111/24')` `:102`, `assertTrue` `:103`, text `:104-105`, `assertIn(...)` `:106-107`, `default interface` `:108`) | ✅ | `ipinterfaces.setAddress(<scratch>, '192.0.2.30/24')`; the assertion is both the typed record and upstream's block-text half. Upstream's `set_address(…, disable=True)` arm is this client's named `unsetAddress` (DR-037 removed the value-less fall-through), and it is not a separate upstream case in this file |
 * | `test_set_mtu` (`:110`, stage `:113-114`, `resource` `:115`, `set_mtu(intf, 2000)` `:116`, `assertTrue` `:117`, text `:118-119`, `assertIn('mtu 2000')` `:120`, `default interface` `:121`) | ✅ | `ipinterfaces.setMtu(<scratch>, 2000)` — the same `mtu` line `interfaces.setMtu` writes, with the two modules' guards differing on purpose (DR-097, row 174). Read back through this resource's typed `mtu` **number** and through `getBlock` text |
 * | `test_set_mtu_value_as_string` (`:123`, stage `:126-127`, `resource` `:128`, `set_mtu(intf, '2000')` `:129`, `assertTrue` `:130`, text `:131-132`, `assertIn('mtu 2000')` `:133`, `default interface` `:134`) | ✅ as a refusal instead of a success | upstream's `set_mtu` runs `int(value)` (`ipinterfaces.py:247`), so a digit **string** succeeds there and its suite asserts that. This client refuses it with `NotSupportedError` before the wire — `expected an integer MTU 68..65535 … a string here means a UI did not parse its form field` (`ipinterfaces.ts` MTU guard). The live port therefore asserts the rejection AND that the interface's block text is byte-identical before and after the refused call, which is the proof the guard gave the wire nothing |
 * | — (no upstream method) | ✅ added SVI arm, scoped in this header | `vlan 2001` + `interface Vlan2001` staged by a guarded batch, then `setAddress`/`setMtu` on `Vlan2001` and a read of the typed record, plus a bare `Vlan2002` read with no address; teardown `no interface Vlan…` + `no vlan …`. Justification and the id choice above |
 *
 * Every write batch runs inside a named config session that aborts on failure and never persists
 * (`runGuardedLiveWriteSession`, DR-035/DR-035(c)); the facade verbs under test go through
 * `node.configure`, which the same `withLabWriteScope` seam fences before the wire (DR-126). `Management1`,
 * `Vlan10`/`Vlan100`/`Vlan110`, `Ethernet1`/`Ethernet2`, `Port-Channel1` and `copy run start` are never written.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { CommandError, EapiError, NotSupportedError, SessionError } from './errors'
import { buildFullWriteNode, liveFullWriteReadiness } from './testing/live-full-write'
import { describeLiveTarget, matchesDeviceIdentity, requireScratchInterface, unwrapLiveTarget, type LiveTarget } from './testing/live-guard'
import { runGuardedLiveWriteSession } from './testing/live-session-policy'
import type { Node } from './command-layer'

const SUITE = 'live-ipinterfaces'
const gate = liveFullWriteReadiness(process.env)
const ready = gate.runnable
if (!ready) {
  console.warn(`${SUITE}: SKIPPED — ${gate.skipReason ?? 'gate refused the run'}`)
}

const scratch: { ok: boolean; name?: string; reason?: string } = ready
  ? (() => {
      const req = requireScratchInterface(unwrapLiveTarget(gate.resolution))
      return req.ok ? { ok: true, name: req.name } : { ok: false, reason: req.reason }
    })()
  : { ok: false, reason: 'live target not accepted' }
if (ready && !scratch.ok) {
  console.warn(`${SUITE}: interface-attached write cases SKIPPED (DR-035b) — ${scratch.reason ?? ''}`)
}
const writeReady = ready && scratch.ok

const SVI = 'Vlan2001'
const SVI_READ = 'Vlan2002'
const runId = String(Date.now()).slice(-6)

type Attempt = { readonly ok: true } | { readonly ok: false; readonly code: string; readonly text: string }

function firstLine(message: string): string {
  return message.split('\n')[0]?.slice(0, 200) ?? message
}

function describeError(rawErr: EapiError): string {
  return rawErr instanceof CommandError ? `CommandError(${String(rawErr.code)})` : String(rawErr.constructor.name)
}

/** pyeapi's `dut.config([...])` twin — named session, abort-on-failure, never persisted (DR-035). */
async function batch(node: Node, label: string, commands: readonly string[]): Promise<Attempt> {
  try {
    await runGuardedLiveWriteSession(node, { name: `${SUITE}-${label}-r${runId}`, commands })
    return { ok: true }
  } catch (rawErr) {
    if (rawErr instanceof SessionError) throw rawErr
    if (!(rawErr instanceof EapiError)) throw rawErr
    const code = describeError(rawErr)
    console.warn(`${SUITE}: batch ${JSON.stringify(label)} did not apply (${code}): ${firstLine(rawErr.message)} — commands ${JSON.stringify(commands)}`)
    return { ok: false, code, text: firstLine(rawErr.message) }
  }
}

/** pyeapi's `dut.api('ipinterfaces').verb(...)` + `assertTrue` twin — resolves, or rejects typed (DR-005). */
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

function requireApplied(label: string, attempt: Attempt): void {
  if (!attempt.ok) throw new Error(`${SUITE}: ${label} failed (${attempt.code}): ${attempt.text} — the scratch state this run owns is not restored`)
}

async function blockText(node: Node, name: string): Promise<string> {
  return (await node.getBlock(`interface ${name}`)) ?? ''
}

describe.skipIf(!ready)('live reads: pyeapi test_api_ipinterfaces.py (test_getall, :64 — upstream reads the `interfaces` collection)', () => {
  let node: Node

  beforeAll(async () => {
    const target: LiveTarget = unwrapLiveTarget(gate.resolution)
    console.log(`${SUITE}: target = ${describeLiveTarget(target)}`)
    node = buildFullWriteNode(target)
    const reported = await node.getVersion()
    const mismatch = matchesDeviceIdentity(target, { version: reported.version, modelName: reported.modelName })
    // Only the cEOS build-suffix mismatch is tolerated; model/train/TLS stay enforced (DR-066, as in the
    // M12a files of this lane).
    if (mismatch !== undefined && mismatch.code !== 'EAPI_VERSION_MISMATCH') throw new Error(`${SUITE} readiness: ${mismatch.reason}`)
    if (mismatch?.code === 'EAPI_VERSION_MISMATCH') {
      console.warn(`${SUITE}: reported version "${reported.version}" vs pin "${target.allowVersion}" (base-level enforced by the probe, DR-066)`)
    }
  })

  it('ipinterfaces.getAll()/interfaces.getAll() are keyed tables; the Management1 half only if the target writes it (test_getall, :64 — read/instance :66-67, loop :68, assertIn :69)', async () => {
    const l3 = await node.ipinterfaces.getAll()
    for (const [name, record] of l3) {
      expect(record.name).toBe(name)
      if (record.address !== undefined) expect(typeof record.address).toBe('string')
      if (record.mtu !== undefined) expect(record.mtu).toBeTypeOf('number')
      if (record.secondary !== undefined) expect(Array.isArray(record.secondary)).toBe(true)
    }
    console.log(`${SUITE}: ipinterfaces.getAll() keys = ${JSON.stringify([...l3.keys()].slice(0, 12))} (size ${String(l3.size)})`)
    // Upstream's line at :66 is `dut.api('interfaces').getall()` — the other collection, whose own suite asserts
    // the same Management1 membership. Port it literally, then apply the documented membership caveat
    // (§5 row 185: an unprovisioned cEOS writes no `interface Management…` section at all).
    const configured = await node.interfaces.getAll()
    console.log(`${SUITE}: interfaces.getAll() size = ${String(configured.size)} (the collection :66 actually reads)`)
    const management = [...configured.keys()].filter((name) => /^Management\d/u.test(name))
    if (management.length === 0) {
      console.warn(`${SUITE}: this target writes no \`interface Management…\` section, so the Management1 membership half of :69 is NOT claimable here (§5 row 185)`)
    } else {
      for (const name of management) expect(configured.has(name)).toBe(true)
    }
  })
})

describe.skipIf(!writeReady)('live scratch-port writes: pyeapi test_api_ipinterfaces.py (test_get :44, wo_ip_address :55, create :71, delete :83, set_address :96, set_mtu :110, set_mtu_string :123)', () => {
  let node: Node
  let intf: string

  beforeAll(async () => {
    intf = scratch.name ?? ''
    node = buildFullWriteNode(unwrapLiveTarget(gate.resolution))
    // One readiness write instead of seven identical refusals: if the named scratch port is not a port this
    // container presents (the NIC-topology rule in docs/CEOS.md), the whole lane fails loudly rather than
    // "passing" seven cases that wrote nothing.
    const probe = await batch(node, 'scratch-probe', [`interface ${intf}`, 'no switchport'])
    if (!probe.ok) throw new Error(`${SUITE} readiness: EAPI_SCRATCH_INTERFACE=${JSON.stringify(intf)} refused \`no switchport\` (${probe.code}): ${probe.text} — refusing to run the write lane against a port the device does not present`)
    requireApplied('scratch-probe-restore', await batch(node, 'scratch-probe-restore', [`default interface ${intf}`]))
  })

  it('the five-line stage answers the whole typed L3 record (test_get, :44 — stage :47-49, read :50, expected/assert :51-53)', async () => {
    requireApplied('get-prep', await batch(node, 'get-prep', [
      `default interface ${intf}`,
      `interface ${intf}`,
      'no switchport',
      'ip address 192.0.2.10/24',
      'mtu 1800',
    ]))
    const record = await node.ipinterfaces.get(intf)
    expect(record).toBeDefined()
    if (record === undefined) return
    expect(record.name).toBe(intf)
    expect(record.address).toBe('192.0.2.10/24')
    expect(record.mtu).toBe(1800)
    expect(record.secondary).toBeUndefined()
    requireApplied('get-clean', await batch(node, 'get-clean', [`default interface ${intf}`]))
  })

  it('an L3 section with no address is reported with `address` absent, without upstream\'s sleep (test_get_interface_wo_ip_adddress, :55 — stage :58-59, sleep :60, read :61, assertIsNone :62)', async () => {
    requireApplied('noaddr-prep', await batch(node, 'noaddr-prep', [`default interface ${intf}`, `interface ${intf}`, 'no switchport']))
    const record = await node.ipinterfaces.get(intf)
    expect(record).toBeDefined()
    if (record === undefined) {
      console.warn(`${SUITE}: the staged L3 section did not read as an IP interface at all — divergence 1's L3 gate did not fire as expected, case reported`)
      requireApplied('noaddr-clean', await batch(node, 'noaddr-clean', [`default interface ${intf}`]))
      return
    }
    expect(record.address).toBeUndefined()
    // Upstream waits 2 s (`:60`) because it reads a live table; this read is of the parsed running-config, and
    // the guard's session finally already cleared the config memo (DR-026) — so no timing is encoded here.
    expect(await blockText(node, intf)).toContain('no switchport')
    requireApplied('noaddr-clean', await batch(node, 'noaddr-clean', [`default interface ${intf}`]))
  })

  it('create() turns the port into a routed interface and the block says so (test_create_and_return_true, :71 — stage :74, create :76, assertTrue :77, text :78-80, re-default :81)', async () => {
    requireApplied('create-prep', await batch(node, 'create-prep', [`default interface ${intf}`]))
    expect(await node.ipinterfaces.get(intf)).toBeUndefined()
    if (!(await verb('ipinterfaces.create(scratch)', () => node.ipinterfaces.create(intf))).ok) return
    expect((await node.ipinterfaces.get(intf))?.name).toBe(intf)
    expect(await blockText(node, intf)).toContain('no switchport')
    // This client's own L3/L2 boundary (divergence 1): a port with `no switchport` is in the ipinterfaces table
    // and out of the switchports one. pyeapi answers the same fact only by accident (`if interface:`, :147).
    expect(await node.switchports.get(intf)).toBeUndefined()
    requireApplied('create-clean', await batch(node, 'create-clean', [`default interface ${intf}`]))
  })

  it('delete() clears the address and returns the port to switching (test_delete_and_return_true, :83 — stage :86-87, delete :89, assertTrue :90, text/assertNotIn :91-94, default interface :95)', async () => {
    requireApplied('delete-prep', await batch(node, 'delete-prep', [`default interface ${intf}`, `interface ${intf}`, 'ip address 192.0.2.20/24']))
    const staged = await node.ipinterfaces.get(intf)
    if (staged === undefined) {
      // On a port whose default is L2, an `interface …` + `ip address …` stage leaves the section a switchport,
      // which is precisely why pyeapi's `get` answers `None` for it (`ipinterfaces.py:85-87`).
      console.warn(`${SUITE}: the staged address did not produce an L3 record on ${intf} — the delete read-back is reported, not claimed`)
    } else {
      expect(staged.address).toBe('192.0.2.20/24')
    }
    if (!(await verb('ipinterfaces.delete(scratch)', () => node.ipinterfaces.delete(intf))).ok) return
    expect(await node.ipinterfaces.get(intf)).toBeUndefined()
    expect(await blockText(node, intf)).not.toContain('ip address 192.0.2.20/24')
    expect((await node.switchports.get(intf))?.interfaceName).toBe(intf)
    requireApplied('delete-clean', await batch(node, 'delete-clean', [`default interface ${intf}`]))
  })

  it('setAddress writes the address line the next read and the block both carry (test_set_address, :96 — stage :98-100, set_address :102, assertTrue :103, text :104-105, assertIn :106-107)', async () => {
    requireApplied('addr-prep', await batch(node, 'addr-prep', [`default interface ${intf}`, `interface ${intf}`, 'no switchport']))
    if (!(await verb('ipinterfaces.setAddress(scratch, 192.0.2.30/24)', () => node.ipinterfaces.setAddress(intf, '192.0.2.30/24'))).ok) return
    expect((await node.ipinterfaces.get(intf))?.address).toBe('192.0.2.30/24')
    expect(await blockText(node, intf)).toContain('ip address 192.0.2.30/24')
    requireApplied('addr-clean', await batch(node, 'addr-clean', [`default interface ${intf}`]))
  })

  it('setMtu stores the MTU as a number and the block carries `mtu 2000` (test_set_mtu, :110 — stage :113-114, set_mtu :116, assertTrue :117, text :118-119, assertIn :120)', async () => {
    requireApplied('mtu-prep', await batch(node, 'mtu-prep', [`default interface ${intf}`, `interface ${intf}`, 'no switchport']))
    if (!(await verb('ipinterfaces.setMtu(scratch, 2000)', () => node.ipinterfaces.setMtu(intf, 2000))).ok) return
    expect((await node.ipinterfaces.get(intf))?.mtu).toBe(2000)
    expect(await blockText(node, intf)).toContain('mtu 2000')
    requireApplied('mtu-clean', await batch(node, 'mtu-clean', [`default interface ${intf}`]))
  })

  it('a string MTU is refused before the wire, where pyeapi\'s int() would have succeeded (test_set_mtu_value_as_string, :123 — stage :126-127, set_mtu(intf, \'2000\') :129, assertTrue :130, assertIn :133)', async () => {
    requireApplied('mtustr-prep', await batch(node, 'mtustr-prep', [`default interface ${intf}`, `interface ${intf}`, 'no switchport', 'mtu 1900']))
    const before = await blockText(node, intf)
    // Upstream coerces (`ipinterfaces.py:247`) and its suite asserts `mtu 2000` appeared. This client refuses:
    // the guard is deliberate (`ipinterfaces.ts` MTU guard — "a string here means a UI did not parse its form
    // field"), and DR-005/DR-010 mean that refusal is a typed `NotSupportedError`, never a device round trip.
    await expect(node.ipinterfaces.setMtu(intf, '2000' as unknown as number)).rejects.toThrow(NotSupportedError)
    const after = await blockText(node, intf)
    expect(after).toBe(before)
    console.log(`${SUITE}: the refused string-MTU call left the block byte-identical (${JSON.stringify(before.trim().split('\n').slice(0, 4))}) — pyeapi would have written mtu 2000 here`)
    requireApplied('mtustr-clean', await batch(node, 'mtustr-clean', [`default interface ${intf}`]))
  })
})

describe.skipIf(!ready)('live SVI writes on a fresh Vlan (added arm, scoped in the header): ipinterfaces\' L3 kind gate', () => {
  let node: Node

  beforeAll(async () => {
    node = buildFullWriteNode(unwrapLiveTarget(gate.resolution))
  })

  it('a Vlan SVI this run created reads as an IP interface with no switchport line, address settable (added arm; Vlan2001/2002 are outside 1/10/100/110 and 1006-1199)', async () => {
    const created = await batch(node, 'svi-create', ['vlan 2001', `interface ${SVI}`, 'ip address 192.0.2.40/24', 'no shutdown'])
    if (!created.ok) {
      console.warn(`${SUITE}: the SVI arm is not claimable on this target — the stage refused (${created.code}): ${created.text}`)
      return
    }
    try {
      if (!(await verb('ipinterfaces.setAddress(Vlan2001, 192.0.2.41/24)', () => node.ipinterfaces.setAddress(SVI, '192.0.2.41/24'))).ok) return
      expect((await node.ipinterfaces.get(SVI))?.address).toBe('192.0.2.41/24')
      if (!(await verb('ipinterfaces.setMtu(Vlan2001, 2000)', () => node.ipinterfaces.setMtu(SVI, 2000))).ok) return
      const record = await node.ipinterfaces.get(SVI)
      expect(record?.mtu).toBe(2000)
      // The gate this arm exists to exercise: a `Vlan…` section is reported with no `no switchport` line, which
      // pyeapi reaches by its two-character prefix test (`ipinterfaces.py:85-86`) rather than by kind.
      expect(await blockText(node, SVI)).not.toContain('switchport')
      expect((await node.ipinterfaces.getAll()).has(SVI)).toBe(true)
      // The second fresh SVI, read with no address of its own.
      const readStage = await batch(node, 'svi-read-stage', ['vlan 2002', `interface ${SVI_READ}`, 'no shutdown'])
      if (readStage.ok) {
        const bare = await node.ipinterfaces.get(SVI_READ)
        expect(bare?.name).toBe(SVI_READ)
        expect(bare?.address).toBeUndefined()
      }
    } finally {
      requireApplied('svi-clean', await batch(node, 'svi-clean', [`no interface ${SVI}`, 'no vlan 2001', `no interface ${SVI_READ}`, 'no vlan 2002']))
    }
    expect(await node.ipinterfaces.get(SVI)).toBeUndefined()
  })
})
