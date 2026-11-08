/**
 * `*.live.test.ts` port of `pyeapi/test/system/test_api_varp.py` @ `6816d9e` — the VARP half of the
 * **D2 full-write** lane (#14, DR-126): a global `ip virtual-router mac-address` knob plus per-interface
 * virtual-router addresses. It runs only with `EAPI_LAB_FULL_WRITE=1` against the disposable cEOS container,
 * and its Node comes from `buildFullWriteNode`, so the self-lockout fence (listener, `admin`/`netadmin`,
 * this run's `EAPI_USER`, the management path, `copy run start` — `live-session-policy.ts:159-166`) sits on
 * the transport seam for every verb in the file.
 *
 * ## Which interface this suite owns, and why that id
 * Upstream builds its own Vlan for the interface class: `no interface Vlan1000` / `interface Vlan1000` /
 * `ip address 1.1.1.1/24` (`:129-130` and the six siblings below). A Vlan SVI is **not** an
 * `EAPI_SCRATCH_INTERFACE` (`requireScratchInterface`, `live-guard.ts:601`, which refuses anything that is not
 * `Ethernet…`), and `requireScratchVlan` (`live-guard.ts:626-641`) is the *declared* single spare VLAN, which
 * the harness may or may not have exported for this run. So this file creates a **fresh** Vlan of its own and
 * deletes it again inside the same case:
 *
 * - id **2001** — `>= 2000` per the #14 D2 brief, so it cannot collide with the harness provisioning
 *   (`vlan 10`/`100`/`110` and their SVIs, `scripts/ceos-lab.mjs:1126-1144`), with VLAN 1, or with EOS's
 *   reserved 1006-1199 window (`live-guard.ts:639`'s refusal — the stated reason being that a suite which
 *   passes there on a container answers differently on the SKU).
 * - the SVI address stays upstream's own `1.1.1.1/24`, and the virtual-router addresses upstream's assertions
 *   use (`1.1.1.2`/`1.1.1.3` as the wanted set, `1.1.1.20`/`1.1.1.21` as pre-existing junk) — they are
 *   unrelated to the lab's `10.0.100.1/24`/`10.0.110.1/24` addressing.
 * - the case batch is `no interface Vlan2001` + `no vlan 2001` **first** (idempotence against a target that
 *   still holds it) and **again in a `finally`** (leaked state poisons the next suite in this container).
 *
 * ## The one tolerance in this file
 * cEOS-lab 4.28.14M refuses *some* L3/forwarding commands outright: the harness's own provisioning records
 * `vrrp … ip` and `ip access-group …` on the SVI, plus a bare `ip routing`, as tolerated `% Unavailable
 * command (not supported on this hardware platform)` answers (`scripts/ceos-lab.mjs:1188-1203`). VARP is a
 * different feature and this repo has never sent it to this image, so every VARP **write** in the file — the
 * global MAC arms and the per-interface address lines alike, plus upstream's null-out idiom (`:60-61` and
 * its siblings) — goes through one reporter: the refusal must be one of the package's typed errors, it is
 * printed with its code, and the read-back half of that upstream case is then reported as unexercised rather
 * than claimed (the precedent is `live-switchports.live.test.ts`'s trunk-batch case, §5 row 188). A
 * non-`EapiError` from the same call is **not** swallowed — it rethrows, because that would be this client's
 * bug, not the device's answer. A refusal of `ip virtual-router mac-address …` is the louder of the two
 * findings, since that line is the whole first class of this upstream file, and the case that sees it prints
 * the reason the read-back is not being claimed.
 *
 * | upstream (verified line @6816d9e) | ported? | here / why |
 * |---|---|---|
 * | `_null_virtual_mac_command` (`:48-56`) | ✅ as a verb, not a case | upstream's helper reads `dut.api('varp')._parse_mac_address()` (`:52`) and builds `no ip virtual-router mac-address <current>`, falling back to the bare negation when the switch has no MAC (`:53-56`). That is exactly {@link VarpResource.unsetMacAddress} (`varp.ts:408-410`, §5 row 165: the value-suffixed spelling is reproduced *including* the second shape), so it needs no test of its own — every MAC case below calls it, in a `finally`, to restore the container |
 * | `VIRT_ENTRY_A`/`_B`/`_C`, `IP_CMD` (`:40-43`) | n/a | `VIRT_ENTRY_C` (`:42`) and `IP_CMD` (`:43`) are **never used by any upstream method in this file** — verified by reading the file: the only `VIRT_ENTRY_*` references are `:68`, `:89`, `:92`, `:97`, `:99`, `:102`, `:107`, `:109`, `:112`, `:119`. Ported as the A/B MAC constants (`:40-41`); the dead constants are ledgered so the 1:1 method map is auditable |
 * | `test_basic_get` (`:58`) | ✅ | nulls the MAC (`:60-61`) then `assertIsNotNone` (`:63`). Here `get()` is an `Entity` read that always answers a record (`varp.ts:353`, DR-027), and its `interfaces` half is a `Map` of the Vlan sections this client can see (`varp.ts:446`) — asserted, and the MAC state printed rather than demanded |
 * | `test_get_with_value` (`:65`) | ✅ | nulls then configures `ip virtual-router mac-address 00:11:22:33:44:55` by raw line (`:67-68`), asserts the record and `mac_address == '00:11:22:33:44:55'` (`:69-71`). The staging uses **our** writer (`setMacAddress`), because the version-selected spellings of the sibling resources are this client's decision and duplicating a raw line would hide the arm choice (row 155's rule) |
 * | `test_get_none` (`:73`) | ✅ | after the null-out (`:78-79`) it asserts `mac_address in [None, '00:00:00:00:00:00']` (`:81-82`) — the pre/post-4.17 default-config change its own comment describes (`:74-76`, and the same note inside the helper at `:49-51`). Both halves are legitimate here: absence (DR-027) or the all-zeros MAC. Which one this image answers is printed, because that is precisely the 4.28 half of upstream's version note |
 * | `test_set_mac_address_with_value` (`:84`) | ✅ | null-out (`:86-87`), `assertNotIn(VIRT_ENTRY_A, api.config)` (`:89`), `set_mac_address('00:11:22:33:44:55')` (`:90`), `assertIn` (`:92`). Ported as set-after-clear with both reads through the typed record |
 * | `test_change_mac_address` (`:94`) | ✅ | null-out + A (`:96-97`), `assertIn` A (`:99`), write B (`:100`), `assertIn` B (`:102`). Upstream never checks that A **left** the config; the record here can only answer one MAC (first matching section key wins, `varp.ts:246-258`), so the case additionally counts the mac-address lines in the config text and reports if the device kept both — the replace-not-append claim of `varp.py:109-110` observed live |
 * | `test_remove_mac_address` (`:104`) | ✅ | null-out + A (`:106-107`), `assertIn` A (`:109`), `set_mac_address(disable=True)` (`:110`), `assertNotIn` A (`:112`). → `unsetMacAddress`, whose command **names the value it removes** (`varp.ts:408`, row 165) |
 * | `test_set_mac_address_with_bad_value` (`:114`) | ✅ | null-out (`:116-118`), `assertNotIn` (`:119`), then `assertRaises(ValueError)` around `set_mac_address('0011.2233.4455')` (`:121-122`). Both sides are client-side (`varp.py:128-132`'s guard, whose pattern is anchored only at the start), so it ports as `NotSupportedError` (DR-077) — and it ports **twice over**, because upstream's pattern is unanchored at the end: `varp.ts:219-224` also refuses `aa:bb:cc:dd:ee:ffXX`, the hole divergence 3 of this module records (`varp.ts:107-114`) |
 * | `TestApiVarpInterfaces` (`:125`) | ✅ seven of seven | the Vlan cases, on Vlan2001 as described above |
 * | `test_set_virtual_addr_with_values_clean` (`:127`) | ✅ | the three-line Vlan staging (`:129-130`), a pre-read `assertNotIn` over `get_block('interface Vlan1000')` text (`:132-133`), `set_addresses(Vlan1000, ['1.1.1.2','1.1.1.3'])` (`:134-136`), then two `assertIn` calls on the section text (`:138-141`). Here the read is the typed record (`varp.ts:459-469`), whose `addresses` array is compared to the wanted set — the record instead of the config substring, because that is this client's contract (DR-003/row 78) |
 * | `test_set_virtual_addr_with_values_dirty` (`:143`) | ✅ | staging leaves `ip virtual-router address 1.1.1.20` on the interface (`:145-147`), asserts it is there (`:149-150`), then `set_addresses(…, ['1.1.1.2','1.1.1.3'])` (`:151-153`) and asserts 2/3 in and 20 gone (`:154-160`). That is the diff path `varp.ts:521-542`, whose order rules (removals in device order, adds in caller order) this case is the first live look at |
 * | `test_default_virtual_addrs` (`:162`) | ✅ | stages 20 and 21 (`:164-167`), asserts both (`:169-172`), `set_addresses(…, default=True)` (`:173-174`), asserts neither survives (`:176-179`). → `setDefault`/`defaultAddresses`, `interface <name>` + `default ip virtual-router address` (`varp.ts:501-504`, whose upstream arm is `varp.py:174-175`) |
 * | `test_negate_virtual_addrs` (`:181`) | ✅ | stages 20/21 (`:183-186`), asserts both (`:188-191`), `set_addresses(…, addresses=None)` (`:192-193`), asserts both gone (`:195-198`). → the collection-shaped `delete` (`varp.ts:495-498`): **not** interface lifecycle (DR-095), which is why the case also deletes the Vlan itself in its `finally` |
 * | `test_negate_virtual_addrs_with_disable` (`:200`) | ✅ | stages (`:202-205`), asserts (`:207-210`), `set_addresses(…, disable=True)` (`:211-212`), asserts (`:214-217`). Upstream reaches one command text from two arms — `disable=True` (`varp.py:176-177`) and the `else` fall-through that both `addresses=None` and a missing argument take (`varp.py:191-192`) — and this client owns one negation verb (`varp.ts:545-548`), so the three upstream slots run through two names here and stay auditable either way |
 * | `test_empty_list_virtual_addrs` (`:219`) | ✅ | stages (`:221-224`), asserts (`:226-229`), `set_addresses(…, addresses=[])` (`:230-231`), asserts both gone (`:233-236`). `[]` is not `None`, so upstream's own arm here is the **diff** (`varp.py:178`, negating each entry at `:185-186`) — which is precisely what `varp.ts:528-534` does, so the wire shape agrees and the end-state assertion ports whole |
 * | `test_no_attr_virtual_addrs` (`:238`) | ✅ | stages (`:240-243`), asserts (`:245-248`), `set_addresses('Vlan1000')` with no addresses argument (`:249`), asserts both gone (`:251-254`) → `unsetAddresses`, the `else`-arm twin again (DR-095/DR-037) |
 *
 * What upstream cannot express and this lane must not either: pyeapi's `dut.config(...)` helpers happily send
 * `username admin …`, `interface Management1 …` or `copy running-config startup-config`, and its
 * `configure` answers `False` on a refusal (`Returns: True if the command succeeds, otherwise False`).
 * Neither idiom survives here — the first three are refused **before the wire** (DR-126) and the second is a
 * thrown `CommandError` with the failing command attached (DR-005).
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { CommandError, EapiError, NotSupportedError, ProtocolError } from './errors'
import { buildFullWriteNode, liveFullWriteReadiness } from './testing/live-full-write'
import { describeLiveTarget, matchesDeviceIdentity, unwrapLiveTarget, type LiveTarget } from './testing/live-guard'
import { runGuardedLiveWriteSession } from './testing/live-session-policy'
import type { Node } from './command-layer'

const gate = liveFullWriteReadiness(process.env)
if (!gate.runnable) {
  console.warn(`live-varp: SKIPPED (DR-034/DR-126) — ${gate.skipReason ?? 'reason unavailable'}`)
}

/** Upstream's `VIRT_ENTRY_A`/`VIRT_ENTRY_B` MACs (`test_api_varp.py:40-41`). `VIRT_ENTRY_C` (`:42`) is unused upstream. */
const MAC_A = '00:11:22:33:44:55'
const MAC_B = '00:11:22:33:44:56'
/** The all-zeros MAC the 4.17+ default form writes — upstream's own disjunction at `:82`. */
const MAC_ZERO = '00:00:00:00:00:00'

/** This suite's disposable Vlan. See the header for why 2001 and why the id is spelled here, not derived. */
const VARP_VLAN = 2001
/** The SVI name this suite owns and every interface-side case writes: `Vlan2001`. */
const VARIF = `Vlan${String(VARP_VLAN)}`
const SVI_ADDRESS = '1.1.1.1/24'
/** Upstream's address sets: the wanted pair (`:135-136`) and the pre-existing junk it stages for the diff/default/negation arms (`:147`, `:166-167`, …). */
const WANTED: readonly string[] = ['1.1.1.2', '1.1.1.3']
const STAGED: readonly string[] = ['1.1.1.20', '1.1.1.21']

function describeRefusal(rawErr: unknown): string {
  if (rawErr instanceof EapiError) {
    const code = rawErr instanceof CommandError ? String(rawErr.code) : rawErr instanceof ProtocolError ? `protocol ${String(rawErr.code)}` : 'no code'
    return `${rawErr.constructor.name} ${code}: ${rawErr.message.split('\n')[0]?.slice(0, 160) ?? ''}`
  }
  return rawErr instanceof Error ? `${rawErr.constructor.name}: ${rawErr.message.split('\n')[0]?.slice(0, 160) ?? ''}` : String(rawErr)
}

/**
 * Is the refusal of a VARP address line on **this image** a device answer, or a bug of ours? A typed
 * `EapiError` (typically 1002 `% Unavailable command`) is the device speaking — the tolerated class the
 * harness itself records for `vrrp … ip` on the SVI (`scripts/ceos-lab.mjs:1188-1203`). Anything else is a
 * client-side fault and must fail the case, so it rethrows.
 */
type DeviceAnswer = { ok: true } | { ok: false; why: string }

async function onDeviceAnswer(label: string, act: () => Promise<unknown>): Promise<DeviceAnswer> {
  try {
    await act()
    return { ok: true }
  } catch (rawErr) {
    if (!(rawErr instanceof EapiError)) throw rawErr
    const why = describeRefusal(rawErr)
    console.warn(`live-varp: this target refused ${label} (${why}) — the read-back half of the matching upstream case is NOT claimed here; see the header's tolerance note`)
    return { ok: false, why }
  }
}

async function readyNode(label: string): Promise<Node> {
  const target: LiveTarget = unwrapLiveTarget(gate.resolution)
  console.log(`${label}: target = ${describeLiveTarget(target)}`)
  const node = buildFullWriteNode(target)
  const reported = await node.getVersion()
  const mismatch = matchesDeviceIdentity(target, { version: reported.version, modelName: reported.modelName })
  // The cEOS build-suffix refusal is the only tolerated mismatch; model/train/TLS belong to the probe (DR-066).
  if (mismatch !== undefined && mismatch.code !== 'EAPI_VERSION_MISMATCH') throw new Error(`${label} readiness: ${mismatch.reason}`)
  if (mismatch?.code === 'EAPI_VERSION_MISMATCH') {
    console.warn(`${label}: reported version "${reported.version}" vs pin "${target.allowVersion}" (base-level enforced by the probe, DR-066)`)
  }
  return node
}

/**
 * Take Vlan2001 away. Tolerated on purpose: not-configured is the success state, and every case calls this —
 * at its start (the idempotence move) and again in its `finally` (the no-leak rule). The SVI and the VLAN are
 * dropped in **separate** sessions so a refusal of one cannot roll the other back and leave a stub behind.
 */
async function dropVarpVlan(node: Node, tag: string): Promise<void> {
  const steps: readonly string[] = [`no interface ${VARIF}`, `no vlan ${String(VARP_VLAN)}`]
  for (const [index, command] of steps.entries()) {
    try {
      await runGuardedLiveWriteSession(node, { name: `d2-varp-${tag}-drop${String(index)}-${String(VARP_VLAN)}`, commands: [command] })
    } catch (rawErr) {
      if (!(rawErr instanceof EapiError)) throw rawErr
      console.warn(`live-varp: cleanup step ${JSON.stringify(command)} was refused (${describeRefusal(rawErr)}) — the ${index === 0 ? 'SVI' : 'VLAN'} may survive into the next case; reported, not hidden`)
    }
  }
}

/** Create the SVI from nothing. Not tolerant: `vlan`/`interface`/`ip address` are ordinary EOS config. `extraLines` are whole staged commands, mirroring upstream's own raw staging lines. */
async function stageVarpVlan(node: Node, tag: string, extraLines: readonly string[] = []): Promise<DeviceAnswer> {
  await runGuardedLiveWriteSession(node, { name: `d2-varp-${tag}-vlan-${String(VARP_VLAN)}`, commands: [`vlan ${String(VARP_VLAN)}`] })
  await runGuardedLiveWriteSession(node, {
    name: `d2-varp-${tag}-svi-${String(VARP_VLAN)}`,
    commands: [`interface ${VARIF}`, `ip address ${SVI_ADDRESS}`, 'no shutdown'],
  })
  if (extraLines.length === 0) return { ok: true }
  return onDeviceAnswer(
    `${VARIF} staging lines ${JSON.stringify(extraLines)}`,
    () => runGuardedLiveWriteSession(node, {
      name: `d2-varp-${tag}-stage-addrs-${String(VARP_VLAN)}`,
      commands: [`interface ${VARIF}`, ...extraLines],
    }),
  )
}

/** Read the VARP record for this suite's Vlan, or `undefined` when the target has no such section. */
async function readVarpInterface(node: Node) {
  return await node.varp.interfaces.get(VARIF)
}

/** Upstream's null-out idiom (`:60-61`, `:67`, `:78-79`, `:86-87`, …), reported the same way as its writes. */
async function nullMac(node: Node, tag: string): Promise<void> {
  await onDeviceAnswer(`the null-out \`no ip virtual-router mac-address …\` (${tag})`, () => node.varp.unsetMacAddress())
}

describe.skipIf(!gate.runnable)('live full-write: pyeapi test_api_varp.py (TestApiVarp :48-:123)', () => {
  let node: Node
  beforeAll(async () => {
    node = await readyNode('live-varp')
  })

  it('varp.get() always answers a record, and its interfaces half is a keyed Vlan table (test_basic_get, :58 — :60-63)', async () => {
    await nullMac(node, 'basic-get')
    const settings = await node.varp.get()
    expect(settings).toBeDefined()
    expect(typeof settings.interfaces.has).toBe('function')
    for (const [name, entry] of settings.interfaces) {
      expect(entry.name).toBe(name)
      expect(Array.isArray(entry.addresses)).toBe(true)
    }
    // Upstream's only assertion is "not None" (`:63`). DR-027 says an Entity read always answers, so that is
    // a claim about this client, and the MAC state is this image's answer — printed, not demanded.
    console.log(`live-varp: after \`no ip virtual-router mac-address …\` the record is macAddress=${JSON.stringify(settings.macAddress ?? null)} interfaces=${JSON.stringify([...settings.interfaces.keys()])}`)
  })

  it('a MAC this client wrote reads back off the same record (test_get_with_value, :65 — :67-71)', async () => {
    await nullMac(node, 'get-with-value')
    try {
      const written = await onDeviceAnswer(`ip virtual-router mac-address ${MAC_A}`, () => node.varp.setMacAddress(MAC_A))
      if (!written.ok) return
      const settings = await node.varp.get()
      expect(settings.macAddress).toBe(MAC_A)
    } finally {
      await nullMac(node, 'get-with-value-restore')
    }
  })

  it('with no MAC configured the record answers absent-or-zeros — which half is this image\'s (test_get_none, :73 — :74-76, :81-82)', async () => {
    await nullMac(node, 'get-none')
    const settings = await node.varp.get()
    if (settings.macAddress === undefined) {
      expect(settings.macAddress).toBeUndefined()
      console.log('live-varp: no `ip virtual-router mac-address` section key — DR-027 absence, i.e. upstream\'s `None` arm of the :81-82 disjunction')
    } else {
      expect([MAC_ZERO, undefined]).toContain(settings.macAddress)
      console.log(`live-varp: the 4.28 default form leaves \`ip virtual-router mac-address ${settings.macAddress}\` in the config — upstream's other :82 arm ('4.17.x and on', its own comment at :49-51)`)
    }
  })

  it('setMacAddress after a clear installs the MAC (test_set_mac_address_with_value, :84 — :86-92)', async () => {
    await nullMac(node, 'set-with-value')
    const cleared = await node.varp.get()
    expect(cleared.macAddress).not.toBe(MAC_A)
    try {
      const written = await onDeviceAnswer(`setMacAddress(${MAC_A})`, () => node.varp.setMacAddress(MAC_A))
      if (!written.ok) return
      expect((await node.varp.get()).macAddress).toBe(MAC_A)
    } finally {
      await nullMac(node, 'set-with-value-restore')
    }
  })

  it('changing the MAC replaces it — and the config says whether the device kept one line (test_change_mac_address, :94 — :96-102)', async () => {
    let stage = await onDeviceAnswer(`staging ${MAC_A}`, () => node.varp.setMacAddress(MAC_A))
    if (!stage.ok) return
    try {
      expect((await node.varp.get()).macAddress).toBe(MAC_A)
      stage = await onDeviceAnswer(`setMacAddress(${MAC_B})`, () => node.varp.setMacAddress(MAC_B))
      if (!stage.ok) return
      expect((await node.varp.get()).macAddress).toBe(MAC_B)
      // Upstream only ever asserts the new line is present (`:102`); `varp.py:109-110` claims an overwrite.
      // Counting the section keys is how row 165's "the read takes the first match" claim gets a device answer.
      const config = await node.getRunningConfig()
      const lines = [...config.matchAll(/^ip virtual-router mac-address \S+$/gmu)].filter((match) => match[0] !== undefined).map((match) => match[0] as string)
      console.log(`live-varp: mac-address lines in \`show running-config all\` after A→B: ${JSON.stringify(lines)}`)
      expect(lines.filter((line) => line.endsWith(MAC_A))).toHaveLength(0)
    } finally {
      await nullMac(node, 'change-mac-restore')
    }
  })

  it('unsetMacAddress names the value it removes, and the MAC is gone afterwards (test_remove_mac_address, :104 — :106-112; row 165)', async () => {
    const stage = await onDeviceAnswer(`staging ${MAC_A}`, () => node.varp.setMacAddress(MAC_A))
    if (!stage.ok) return
    expect((await node.varp.get()).macAddress).toBe(MAC_A)
    // pyeapi reaches the same text through `set_mac_address(disable=True)` (`varp.py:106`, `:136-139`); this
    // client has one negation verb, and it re-reads the current value first, exactly like upstream's helper.
    const off = await onDeviceAnswer(`unsetMacAddress()`, () => node.varp.unsetMacAddress())
    expect(off.ok).toBe(true)
    const after = await node.varp.get()
    expect(after.macAddress).not.toBe(MAC_A)
    // The `default` arm of the same knob (`varp.py:106`'s `default=True`, our `defaultMacAddress`) is not an
    // upstream method in this file, so it is not asserted here — only noted as the third verb.
  })

  it('a MAC that cannot read back is refused with zero requests, twice over (test_set_mac_address_with_bad_value, :114 — :119-122)', async () => {
    await nullMac(node, 'bad-value')
    // upstream: `with self.assertRaises(ValueError): set_mac_address('0011.2233.4455')`. Both sides check
    // before the wire; the taxonomy here has one refusal class (DR-077/DR-010, no new error type).
    await expect(node.varp.setMacAddress('0011.2233.4455')).rejects.toBeInstanceOf(NotSupportedError)
    await expect(node.varp.setMacAddress(undefined as unknown as string)).rejects.toBeInstanceOf(NotSupportedError)
    // The anchored-at-the-start hole divergence 3 of this module records (`varp.ts:107-114`, whose upstream
    // pattern is `varp.py:128-129`): pyeapi writes `…ffXX` and then cannot read it back. `varp.ts:219-224`
    // refuses the same input instead.
    await expect(node.varp.setMacAddress(`${MAC_A}XX`)).rejects.toBeInstanceOf(NotSupportedError)
    await expect(node.varp.setMacAddress('00:11:22:33:44:5G')).rejects.toBeInstanceOf(NotSupportedError)
    const after = await node.varp.get()
    expect(after.macAddress).not.toBe('0011.2233.4455')
    expect(after.macAddress).not.toBe(`${MAC_A}XX`)
  })
})

describe.skipIf(!gate.runnable)('live full-write on a fresh Vlan SVI: pyeapi test_api_varp.py (TestApiVarpInterfaces :125 — :127/:143/:162/:181/:200/:219/:238)', () => {
  let node: Node
  beforeAll(async () => {
    node = await readyNode('live-varp/interfaces')
  })

  it('setAddresses on a clean SVI installs exactly the wanted pair (test_set_virtual_addr_with_values_clean, :127 — :128-141)', async () => {
    await dropVarpVlan(node, 'clean-pre')
    const staged = await stageVarpVlan(node, 'clean')
    try {
      if (!staged.ok) return
      expect((await readVarpInterface(node))?.addresses).toEqual([])
      const applied = await onDeviceAnswer(`setAddresses(${VARIF}, ${JSON.stringify(WANTED)})`, () => node.varp.interfaces.setAddresses(VARIF, WANTED))
      if (!applied.ok) return
      const record = await readVarpInterface(node)
      expect(record).toBeDefined()
      expect([...(record?.addresses ?? [])].sort()).toEqual([...WANTED].sort())
      expect(record?.name).toBe(VARIF)
      // The getAll() half of the claim: this client's table sees Vlan sections only (divergence 1), and
      // Vlan2001 is a Vlan section this run wrote, so it must appear — upstream's `get_block` text check
      // (`:138-141`) is the same membership fact through a substring.
      const table = await node.varp.interfaces.getAll()
      expect(table.has(VARIF)).toBe(true)
      expect([...(table.get(VARIF)?.addresses ?? [])].sort()).toEqual([...WANTED].sort())
    } finally {
      await dropVarpVlan(node, 'clean')
    }
  })

  it('setAddresses over an existing address diffs it out — the order rules read live for the first time (test_set_virtual_addr_with_values_dirty, :143 — :144-160)', async () => {
    await dropVarpVlan(node, 'dirty-pre')
    const staged = await stageVarpVlan(node, 'dirty', ['ip virtual-router address 1.1.1.20'])
    try {
      if (!staged.ok) return
      expect((await readVarpInterface(node))?.addresses).toEqual(['1.1.1.20'])
      const applied = await onDeviceAnswer(`setAddresses(${VARIF}, ${JSON.stringify(WANTED)}) over 1.1.1.20`, () => node.varp.interfaces.setAddresses(VARIF, WANTED))
      if (!applied.ok) return
      const record = await readVarpInterface(node)
      const addresses = record?.addresses ?? []
      expect([...addresses].sort()).toEqual([...WANTED].sort())
      expect(addresses).not.toContain('1.1.1.20')
      console.log(`live-varp: ${VARIF} after the diff, in device order: ${JSON.stringify(addresses)} — removals use the device's own token and adds the caller's order (varp.ts:521-542)`)    } finally {
      await dropVarpVlan(node, 'dirty')
    }
  })

  it('defaultAddresses returns the SVI VARP state to its device default (test_default_virtual_addrs, :162 — :163-180)', async () => {
    await dropVarpVlan(node, 'dflt-pre')
    const staged = await stageVarpVlan(node, 'dflt', STAGED.map((address) => `ip virtual-router address ${address}`))
    try {
      if (!staged.ok) return
      expect([...(await readVarpInterface(node))?.addresses ?? []].sort()).toEqual([...STAGED].sort())
      const applied = await onDeviceAnswer(`defaultAddresses(${VARIF})`, () => node.varp.interfaces.defaultAddresses(VARIF))
      if (!applied.ok) return
      const after = (await readVarpInterface(node))?.addresses ?? []
      for (const address of STAGED) expect(after).not.toContain(address)
      console.log(`live-varp: \`default ip virtual-router address\` left ${JSON.stringify(after)} on ${VARIF} — "empty" is this image's answer, and a device default this client did not invent (DR-027)`)
    } finally {
      await dropVarpVlan(node, 'dflt')
    }
  })

  it('delete() means "remove the VARP addresses", never the interface (test_negate_virtual_addrs, :181 — :182-199; DR-095)', async () => {
    await dropVarpVlan(node, 'neg1-pre')
    const staged = await stageVarpVlan(node, 'neg1', STAGED.map((address) => `ip virtual-router address ${address}`))
    try {
      if (!staged.ok) return
      expect([...(await readVarpInterface(node))?.addresses ?? []].sort()).toEqual([...STAGED].sort())
      const applied = await onDeviceAnswer(`interfaces.delete(${VARIF})`, () => node.varp.interfaces.delete(VARIF))
      if (!applied.ok) return
      const record = await readVarpInterface(node)
      expect(record).toBeDefined()
      expect(record?.addresses).toEqual([])
      // The DR-095 half, asserted: the SVI section is still there, because this verb is not interface
      // lifecycle. Upstream's `no interface Vlan1000` only ever appears in its *staging* (`:183`, `:202`, …).
      expect(record?.name).toBe(VARIF)
    } finally {
      await dropVarpVlan(node, 'neg1')
    }
  })

  it('the disable=True arm of pyeapi\'s set_addresses is this client\'s unsetAddresses (test_negate_virtual_addrs_with_disable, :200 — :201-218)', async () => {
    await dropVarpVlan(node, 'neg2-pre')
    const staged = await stageVarpVlan(node, 'neg2', STAGED.map((address) => `ip virtual-router address ${address}`))
    try {
      if (!staged.ok) return
      const applied = await onDeviceAnswer(`unsetAddresses(${VARIF})`, () => node.varp.interfaces.unsetAddresses(VARIF))
      if (!applied.ok) return
      expect((await readVarpInterface(node))?.addresses).toEqual([])
    } finally {
      await dropVarpVlan(node, 'neg2')
    }
  })

  it('setAddresses([]) negates each address the device reported rather than one bare line (test_empty_list_virtual_addrs, :219 — :220-237)', async () => {
    await dropVarpVlan(node, 'empty-pre')
    const staged = await stageVarpVlan(node, 'empty', STAGED.map((address) => `ip virtual-router address ${address}`))
    try {
      if (!staged.ok) return
      const applied = await onDeviceAnswer(`setAddresses(${VARIF}, [])`, () => node.varp.interfaces.setAddresses(VARIF, []))
      if (!applied.ok) return
      const after = (await readVarpInterface(node))?.addresses ?? []
      expect(after).toEqual([])
      // Divergence worth recording: upstream's `addresses=[]` is not `None`, so its own arm here is the diff
      // (`varp.py:178`) which negates each entry the device reported (`:185-186`) — the same wire shape
      // `varp.ts:528-534` emits. Its bare `no ip virtual-router address` (`varp.py:191-192`) belongs to the
      // `disable=True`/value-less arms, which are separate upstream methods and separate slots here.
      console.log(`live-varp: empty-list diff left ${JSON.stringify(after)} on ${VARIF}`)
    } finally {
      await dropVarpVlan(node, 'empty')
    }
  })

  it('the third upstream arm (no addresses argument at all) also lands on the one negation verb (test_no_attr_virtual_addrs, :238 — :239-255)', async () => {
    await dropVarpVlan(node, 'noattr-pre')
    const staged = await stageVarpVlan(node, 'noattr', STAGED.map((address) => `ip virtual-router address ${address}`))
    try {
      if (!staged.ok) return
      const applied = await onDeviceAnswer(`unsetAddresses(${VARIF}) for the value-less arm`, () => node.varp.interfaces.unsetAddresses(VARIF))
      if (!applied.ok) return
      expect((await readVarpInterface(node))?.addresses).toEqual([])
    } finally {
      await dropVarpVlan(node, 'noattr')
    }
  })

  it('create() refuses to write an `interface …` line with no address behind it (guard note, not an upstream method — upstream has no create on this class, DR-095)', async () => {
    await dropVarpVlan(node, 'create-pre')
    await stageVarpVlan(node, 'create')
    try {
      await expect(node.varp.interfaces.create(VARIF)).rejects.toBeInstanceOf(NotSupportedError)
      await expect(node.varp.interfaces.create(VARIF, { addresses: [] })).rejects.toBeInstanceOf(NotSupportedError)
      // The refusal is pre-wire, so the SVI is exactly as staged: an addressing with no VARP state.
      expect((await readVarpInterface(node))?.addresses).toEqual([])
      const applied = await onDeviceAnswer(`create(${VARIF}, {addresses:[${WANTED[0]}]})`, () => node.varp.interfaces.create(VARIF, { addresses: [WANTED[0] ?? '1.1.1.2'] }))
      if (applied.ok) expect([...(await readVarpInterface(node))?.addresses ?? []]).toEqual([WANTED[0]])
    } finally {
      await dropVarpVlan(node, 'create')
    }
  })
})
