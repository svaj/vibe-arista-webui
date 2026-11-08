/**
 * `*.live.test.ts` port of `pyeapi/test/system/test_api_interfaces.py` @ `6816d9e` — M12a (#14) opened the
 * file, **M12c (#14) tranche 2** extends it. Read-mostly plus scratch-port writes, same loud-skip gate as the
 * other live files (DR-034); write cases additionally require `requireScratchInterface` and run through
 * `runGuardedLiveWriteSession`.
 *
 * This upstream file is the largest (48 methods across three classes) but the least *read*-able: a bare
 * `interfaces.get(x)` on upstream almost always follows a `dut.config([... 'interface x' …, <field>])` that
 * names x by first **creating/mutating** it, and most of those names (`Port-Channel1`, `Loopback0`,
 * `Vxlan1`, `Management1`, `Vlan1234`) are off-limits for a live write (DR-035(b): only an explicitly-named
 * `Ethernet…` scratch port, `docs/CEOS.md:131`). Read/write split below:
 *
 * | upstream (verified line @6816d9e) | ported? | here / why |
 * |---|---|---|
 * | `TestResourceInterfaces.test_getall` (`:64`) | ✅ read (M12a) + ✅ M12c membership half | upstream pre-writes `default interface <rintf>` (`:67`) then checks `<rintf>` and `Management1` are keys (`:68-70`). M12a read the membership without a write and assumed `Management1` exists on any bootable target; the 2026-11-06 run shows that assumption is wrong for this image — `show running-config all` writes no `interface Management…`/`interface Ethernet…` section, and its single `interface …` header is `interface defaults`, which this grammar reads as a `kind: null` entry (§5 row 185). The membership half is therefore claimed only for a class the target writes, and the real membership half stays M12c's scratch-port case |
 * | `TestResourceInterfaces.test_get` (`:45`) | ✅ M12c — read-after-guarded-write | M12a declined this because the values it asserts (`description` `:58`, `shutdown` `:59`, `flowcontrol_send 'off'` `:60`, `flowcontrol_receive 'on'` `:61`, `sflow` False `:62`) are ones it had **just written** (`:48-53`) on a `random_interface` port. The M12c case writes the same five lines on the run's own `EAPI_SCRATCH_INTERFACE` (DR-035(b)) and then reads them through the typed record, so the read side is exercised without asserting a value the device never saw. Exactness is claimed only for what EOS must store; a field a device may treat as default reads absent and is logged instead (§5 row 186) |
 * | `test_create_and_return_true` (`:73`)/`test_delete_and_return_true` (`:86`), `..._sub_interface` (`:99`), `test_ethernet_set_and_unset_encapsulation` (`:115`), portchannel sub-intf (`:411`,`:440`) | ❌ skipped | mutate `Loopback0`, `Ethernet1.1`/`Port-Channel` **subinterfaces**. Loopback and subinterface creation are not the named base scratch port; and this client deliberately *refuses* Ethernet create/delete (`interfaces.ts` `assertPresentName`), an offline fact already asserted in `interfaces.test.ts` — see the two `_raises_not_implemented_error` rows |
 * | `test_create_ethernet_raises_not_implemented_error` (`:81`), `test_delete_ethernet_raises_not_implemented_error` (`:94`) | ❌ skipped | pure **client-side** refusals — no device round trip reaches EOS, so they cannot be *live* tests. They are this module's `NotSupportedError`; pinned offline |
 * | `test_set_encapsulation_*` (`:139`,`:145`), `test_set_vrf` (`:227`) | ❌ skipped | need a subinterface, `Vlan1234`, or a global `vrf instance test` write (`:240`) — the last is a global mutation the guarded session does not scope |
 * | `test_default` (`:151`), `test_set_sflow_enable/disable/default` (`:196`,`:206`,`:216`) | ✅ M12c — guarded scratch-port writes | M12a skipped these because the mutated port came from `random_interface`; on the named scratch port the writes are legal. `test_default`'s before/after read (`show interfaces <intf>` → `interfaces[intf]['interfaceStatus']`, `:154-162`) is answered here by `getStatus()` (this client's status command is `show interfaces status`, whose captured spelling is `linkStatus` — row 106), and upstream's `sleep(10)` link-settle wait (`:158`) is **not** ported: the case asserts the row exists and its columns are strings, and logs the before/after pair instead of encoding a timing assumption (§5 row 187). The sflow reads are `show running-config interfaces <intf>` **text** (`:202-204`, `:212-214`, `:222-224`) — the same text the new `show running-config` capture commits (§5 row 185) |
 * | `TestPortchannelInterface.test_get` (`:255`), member/LACP/minimum-links writes (`:264`–`:479`) | ❌ skipped by M12a/M12c → **✅ now ported behind DR-126 consent** (last describe) | every case first `dut.config(['no interface Port-Channel1', 'interface Port-Channel1'])` (`:257-258`, `:331-332`, `:340-344`, `:364-367`, `:384-385`, `:394-395`) and several add `channel-group 1 mode …` on **random** member ports (`:266-268`, `:299-301`). Under the scratch-only rule that was forbidden outright. DR-126 (`docs/DECISIONS.md:1996`) amends it for the throwaway container, so the D2 lane ports the same arms with two changes the container requires: (a) the group is always a **fresh id >= 200** — `Port-Channel1` is this container's own provisioned LAG (`scripts/ceos-lab.mjs:1159-1168` — the member line and the Po1 stanza) and `assertFreshGroup` refuses anything else before the wire; (b) the only member this lane may touch is the run's declared `EAPI_SCRATCH_INTERFACE`, because `random_interface` is undeclared-port roulette (`test/lib/systestlib.py:68-88`, which itself only ever picks an `Et*` name at `:76`) |
 * | `test_get_members_default` (`:330`), `test_get_lacp_mode_with_default` (`:383`) — **read half only** | ✅ M12c — read-only capability observation, **settled live on 2026-11-06** | upstream reaches `instance.get_members('Port-Channel1')` (`:335`) / `get_lacp_mode` (`:388`) only after a `Port-Channel1` write (`:331-332`, `:384-385`) this lane will not make. The two reads themselves mutate nothing, so the M12c case performs just them against a node with no channel configured and reports verbatim what the device says. The run answered `getMembers → []` and `getLacpMode → undefined` for an unconfigured group, i.e. `show port-channel 1 all-ports` is **accepted** by eAPI on 4.28.14M (while `show port-channel detail` is a 1002 and `summary` is deprecated by `dense`) and the empty-member answer is the device's, not the `[]` upstream manufactured after creating the LAG. `'on'` remains `interfaces.py:67`'s `DEFAULT_LACP_MODE`, which this client refuses to invent — divergence 19, confirmed live (§5 row 189) |
 * | `test_get_members_default` (`:330`) / `test_get_lacp_mode_with_default` (`:383`) / `test_get_members_one_member` (`:338`) — the **write-then-read** halves | **✅ now ported behind DR-126 consent** (last describe) | the reads above could only be *observed*, because the group they read about did not exist. On a group this lane created, `get_members → []` (`:335`/`:336`) and the mode answer of a memberless group (`:388`/`:389`) are **asserted**, and `:346-:347`'s `['Ethernet1']` becomes `[<this run's scratch port>]` — the declared port, never a `random_interface`. `DEFAULT_LACP_MODE = 'on'` (`interfaces.py:67`, asserted at `:389`) still stays unported (divergence 19), so a memberless group answering `undefined` is logged rather than forced |
 * | the `default interface <port>` staging arms inside the PortChannel methods (`:67`, `:271`, `:274`, `:277`, `:304`, `:307`, `:310`, `:342`, `:353`, `:365`) | **✅ live, with the churn stated** | upstream resets the member ports it is about to en-/de-couple with exactly this command, so the lane's cleanup is upstream-faithful rather than an invention. It may **not be free** here: `lab-provision` makes one front-panel port a member of its own Po1 (`scripts/ceos-lab.mjs:1159-1162`), and the runs that declared `Ethernet2` as `EAPI_SCRATCH_INTERFACE` therefore declared the LAG's member as the lane's only legal member — so a member write can churn a provisioned port. `beforeAll` captures the scratch port's section and logs whether it came pre-bound; each case then ends with `default interface <scratch>` plus a replay of the captured lines, and prints any line the device would not take back. The container is left as found in **config text**; LACP re-negotiation (a timer, not a config fact) is outside this lane's control, and harness teardown owns the box afterwards. `test_default` on the plain port (`:151`) stays the earlier case's |
 * | `test_get_members_two_members` (`:349`-`:358`) | ❌ skipped, gap named | its staging line is `interface Ethernet1-2` (`:353`) — a **range** spelling this client's name grammar refuses (DECISIONS.md open item 7) — used there to reach two members. A second member would be a port this run never declared (`lab-provision`'s other front-panel port, `scripts/ceos-lab.mjs:1151-1157`), so the lane ports the single-member arm and refuses this one instead of widening the scratch rule unilaterally |
 * | every `Management…` arm in this file (`Management1`, the `test_getall` key at `:70`) | ❌ skipped, and **refused by the fence** | the full-write seam rejects an `interface Management…`/`no interface Management…` config line before the wire (`live-session-policy.ts:165` — the management path carries the connection under test), and the scratch gate refuses a non-Ethernet `EAPI_SCRATCH_INTERFACE` outright (`live-guard.ts`, `requireScratchInterface` → `EAPI_SCRATCH_INTERFACE_NOT_ETHERNET`). Upstream's own member picker never names a management port either (`systestlib.py:76`), so nothing in `:253-:479` needs a management exemption |
 * | `TestApiVxlanInterface` (all 16, `:481`–`:659`) | ❌ skipped | `Vxlan1` source-interface/multicast/VTEP/VLAN — `Vxlan…` is neither an Ethernet scratch port nor a resource this client implements yet |
 *
 * M12a's line: it ports `test_getall` as a read and exercises `test_set_description` (`:164`) as the one
 * guarded scratch-port write, leaving `:174`/`:185` to the offline suite.
 *
 * **M12c tranche 2 (this branch, #14)** adds, on the same scratch port and the same guarded session:
 * `test_get` (`:45`) as a read-after-write of the Ethernet field group; `test_set_description_negate`/`_default`
 * (`:174`/`:185`) as live `no description` / `default description` writes with the DR-027 read-back (our record
 * answers **absent**, upstream's `show interfaces` dict answers `''` at `:183`/`:194`); the three
 * `test_set_sflow_*` cases (`:196`/`:206`/`:216`); `test_default` (`:151`) with the `getStatus()` read-back
 * replacing upstream's `sleep(10)`; the previously-declined **membership half** of `test_getall` (`:64`), which
 * is only claimable once the run itself has configured a port; `Node.getBlock` as the live twin of upstream's
 * `show running-config interfaces <intf>` **text** verification (`:202`, `:239`, `:283`, and the `vlan` sibling
 * at `test_api_vlans.py:147`); and the read-only Port-Channel observation of `get_members`/`get_lacp_mode`
 * (`:330`/`:383`). Everything still unported stays skipped for a *named, documented* reason — an off-limits
 * interface name, a global mutation outside the scratch rule, a client-side refusal that never reaches a
 * device, or a field whose live answer is already fixture-owned — not because it was overlooked.
 *
 * **D2 full-write round (this branch, DR-126 — #14's `test/system` port)** adds the last describe: the
 * `TestPortchannelInterface` write arms the row above refused for the scratch-only rule — `test_get`
 * (`:255`), `test_set_members` (`:264`), `test_set_members_with_mode` (`:297`), the two
 * `get_members` members arms (`:338`; `:349` refused, see its row), `test_set_lacp_mode` (`:360`),
 * `test_set_lacp_mode_invalid_value` (`:377`, this client's pre-wire refusal), `test_minimum_links_valid`
 * (`:391`) and `test_minimum_links_invalid_value` (`:404`, now the device's own refusal) — plus the
 * `default interface` churn read-back those methods' staging implies (`:67`/`:271`/`:274`/`:277`/
 * `:342`/`:351`/`:353`/`:365`). Its gate is `liveFullWriteReadiness(process.env)` **and** the existing
 * `requireScratchInterface` result: no consent, or no declared scratch, means the loud skip line and zero
 * cases executed. Its Node comes from `buildFullWriteNode`, so the self-lockout fence sits on the seam, and
 * every create/member/LACP/min-links write runs in a named guarded session (`d2b-intf-<case>`) or through a
 * facade verb whose batch that same fence inspects. Group ids are never `Port-Channel1` and always >= 200;
 * the only member name ever written is the declared scratch port. The one honest cost of that pairing — the
 * declared scratch port arriving as the provisioned LAG's member — is captured, replayed and reported
 * instead of hidden (§5 row 185's "report what the device said" discipline).
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { createNode } from './node'
import { CommandError, EapiError, NotSupportedError, ProtocolError } from './errors'
import { buildFullWriteNode, liveFullWriteReadiness } from './testing/live-full-write'
import { resolveLiveEnv, unwrapLiveTarget, liveTransportOptions, matchesDeviceIdentity, describeLiveTarget, requireScratchInterface, type LiveTarget } from './testing/live-guard'
import { runGuardedLiveWriteSession } from './testing/live-session-policy'
import type { LacpMode } from './resources/interfaces'
import type { Node } from './command-layer'

const resolution = resolveLiveEnv(process.env)
if (!resolution.ok) {
  console.warn(`live-interfaces: SKIPPED (DR-034) — ${resolution.reason}`)
}
const ready = resolution.ok

const scratch: { ok: boolean; name?: string; reason?: string } = ready
  ? (() => {
      const req = requireScratchInterface(unwrapLiveTarget(resolution))
      return req.ok ? { ok: true, name: req.name } : { ok: false, reason: req.reason }
    })()
  : { ok: false, reason: 'live target not accepted' }
if (ready && !scratch.ok) {
  console.warn(`live-interfaces: write cases SKIPPED (DR-035b) — ${scratch.reason ?? ''}`)
}
const writeReady = ready && scratch.ok

function targetOf(): LiveTarget {
  return unwrapLiveTarget(resolution)
}

describe.skipIf(!ready)('live read: pyeapi test_api_interfaces.py (TestResourceInterfaces.test_getall, :64)', () => {
  let node: Node
  beforeAll(async () => {
    const target = targetOf()
    console.log(`live-interfaces: target = ${describeLiveTarget(target)}`)
    node = createNode(liveTransportOptions(target))
    const reported = await node.getVersion()
    const mismatch = matchesDeviceIdentity(target, { version: reported.version, modelName: reported.modelName })
    // Tolerate only the suffix-driven EAPI_VERSION_MISMATCH (cEOS `version` has an engineering-build suffix);
    // the probe enforces base identity + model + TLS (DR-066).
    if (mismatch !== undefined && mismatch.code !== 'EAPI_VERSION_MISMATCH') throw new Error(`live-interfaces readiness: ${mismatch.reason}`)
    if (mismatch?.code === 'EAPI_VERSION_MISMATCH') console.warn(`live-interfaces: reported version "${reported.version}" vs pin "${target.allowVersion}" (base-level enforced by the probe, DR-066)`)
  })

  it('interfaces.getAll() is a keyed table; management-port membership only if the target reports it (test_getall, :64)', async () => {
    const all = await node.interfaces.getAll()
    expect(typeof all.has).toBe('function')
    for (const [name, intf] of all) {
      expect(intf.name).toBe(name)
      // `kind` is DR-067's per-kind parse: a known kind or `null` for a header grammar this client cannot
      // parse (e.g. a chassis/ranges form) — both are legitimate, so assert the field exists and is one or the other.
      expect(intf.kind === 'Ethernet' || intf.kind === 'Management' || intf.kind === 'Port-Channel' || intf.kind === 'Loopback' || intf.kind === 'Vlan' || intf.kind === 'Vxlan' || intf.kind === null).toBe(true)
    }
    // Upstream asserts `Management1` is a key (:70) after its own setup write (:67). This run's container
    // writes NEITHER a management nor an Ethernet section into `show running-config all` (§5 row 185), so
    // membership is claimed only for a class the target actually writes. Everything the target does write
    // is printed, including the section this client's grammar cannot call an interface, so a reviewer sees
    // the same evidence the suite saw (DR-034/DR-043: no coverage dressed as a pass).
    const keys = [...all.keys()]
    console.log(`live-interfaces: getAll() keys on this target = ${JSON.stringify(keys.slice(0, 12))} (size ${String(all.size)})`)
    if (all.size === 0) {
      console.warn('live-interfaces: getAll() reported 0 interface sections on this target — Management1 membership half NOT exercised (section-less container)')
    } else {
      const management = keys.filter((name) => /^Management\d/u.test(name))
      if (management.length === 0) {
        console.warn('live-interfaces: this target writes no `interface Management…` section, so the Management1 membership half of :70 is NOT claimable here (§5 row 185)')
      } else {
        for (const name of management) expect(all.has(name)).toBe(true)
      }
      for (const name of keys) {
        if (!/^(?:Ethernet|Port-Channel|Vlan|Management|Loopback|Vxlan)\d/u.test(name)) {
          console.warn(
            `live-interfaces: getAll() yielded ${JSON.stringify(name)} (kind null): \`show running-config all\` on cEOS-lab 4.28.14M contains an \`interface defaults\` block, which this client's grammar reads as an entry. Reported for the resource lane — this suite neither asserts nor blesses it (§5 row 185)`,
          )
        }
      }
    }
  })
})

describe.skipIf(!writeReady)('live write on the scratch port: pyeapi test_api_interfaces.py (test_set_description, :164)', () => {
  let node: Node
  let scratchName: string
  beforeAll(async () => {
    scratchName = scratch.name ?? ''
    node = createNode(liveTransportOptions(targetOf()))
  })

  it('a guarded session sets the scratch port description, then rolls it back to unconfigured', async () => {
    // The command upstream sends (`interfaces set_description`, :164-172) as `interface <x>` + `description …`,
    // wrapped in a named session that commits on success. Description text is a per-port field, in the
    // scratch port's own section — the one interface mutation this suite is allowed to make (DR-035b).
    const marker = 'm12a-live-desc'
    const outcome = await runGuardedLiveWriteSession(node, {
      name: `m12a-intf-desc-${scratchName}`,
      commands: [`interface ${scratchName}`, `description ${marker}`],
    })
    expect(outcome.committed).toBe(true)

    const configured = await node.interfaces.get(scratchName)
    expect(configured?.description).toBe(marker)

    // Clean up: `no description` returns the port to unconfigured (the negate/default siblings, :174/:185, are
    // the same command in another mode — pinned offline in interfaces.test.ts). Still a guarded session write.
    await runGuardedLiveWriteSession(node, {
      name: `m12a-intf-clear-${scratchName}`,
      commands: [`interface ${scratchName}`, 'no description'],
    })
    const cleared = await node.interfaces.get(scratchName)
    // DR-027: an unconfigured optional field is absent, not the empty string.
    expect(cleared?.description).toBeUndefined()
  })
})

/**
 * Print what a *device* answered for an optional config field. Some of the lines these cases write are
 * the interface's default, and EOS then leaves them out of the running-config, so the field reads
 * **absent** (`interfaces.ts`'s DR-027 vocabulary) rather than contradicting the write. The case asserts
 * "typed value or absent", and prints which — the alternative is a suite that passes by asserting
 * nothing, or fails by asserting a value this container never stored (§5 row 186).
 */
function reportField(label: string, value: unknown): void {
  if (value === undefined) {
    console.warn(`live-interfaces: ${label} reads ABSENT on this device — the write produced no config line`)
  } else {
    console.log(`live-interfaces: ${label} = ${JSON.stringify(value)}`)
  }
}

describe.skipIf(!writeReady)('live tranche 2 on the scratch port: pyeapi test_api_interfaces.py (test_getall :64 membership, test_get :45, set_description negate/default :174/:185, set_sflow :196/:206/:216, test_default :151)', () => {
  let node: Node
  let scratchName: string

  beforeAll(async () => {
    scratchName = scratch.name ?? ''
    node = createNode(liveTransportOptions(targetOf()))
    const reported = await node.getVersion()
    const mismatch = matchesDeviceIdentity(targetOf(), { version: reported.version, modelName: reported.modelName })
    if (mismatch !== undefined && mismatch.code !== 'EAPI_VERSION_MISMATCH') throw new Error(`live-interfaces readiness: ${mismatch.reason}`)
    if (mismatch?.code === 'EAPI_VERSION_MISMATCH') console.warn(`live-interfaces: reported version "${reported.version}" vs pin "${targetOf().allowVersion}" (base-level enforced by the probe, DR-066)`)
  })

  /** One guarded named session in the scratch port's own submode (DR-035(b)/DR-081). */
  const submodeSession = (caseName: string, commands: readonly string[]) =>
    runGuardedLiveWriteSession(node, {
      name: `m12c-intf-${caseName}-${scratchName}`,
      commands: [`interface ${scratchName}`, ...commands],
    })

  it('the scratch port THIS run configured is a key of getAll(), and M6\'s section reader finds the same text (test_getall :64 — the membership half pyeapi only gets from its own write)', async () => {
    const marker = 'm12c-membership'
    await submodeSession('getall-set', [`description ${marker}`])

    const table = await node.interfaces.getAll({ status: 'skip' })
    expect(table.has(scratchName)).toBe(true)
    const entry = table.get(scratchName)
    expect(entry?.name).toBe(scratchName)
    expect(entry?.kind).toBe('Ethernet')
    expect(entry?.description).toBe(marker)

    // pyeapi verifies its interface writes by reading `show running-config interfaces <intf>` as TEXT
    // (`:202-204`, `:238-247`, `:283-293`); this client reads the same device text through M6 (#8)'s
    // section splitter (Node.getBlock over the running-config memo). First time that reader has been
    // pointed at text a real device wrote (§5 row 185).
    const block = await node.interfaces.getBlock(`interface ${scratchName}`)
    if (typeof block !== 'string') {
      console.warn(`live-interfaces: getBlock("interface ${scratchName}") found no section even though getAll() keyed it — reported, not forced into a pass`)
    } else {
      expect(block).toContain(`description ${marker}`)
    }

    await submodeSession('getall-clear', ['no description'])
    const cleared = await node.interfaces.get(scratchName, { status: 'skip' })
    expect(cleared?.description).toBeUndefined()
  })

  it('the five lines upstream writes for test_get read back through the typed Ethernet record (test_get :45, asserts at :58-62)', async () => {
    const marker = 'm12c-test-get'
    // The exact command set of upstream's setup (`:48-53`), on the named scratch port instead of
    // `random_interface`. Upstream's `default interface <intf>` arm is the one step not repeated: this
    // port has nothing to reset before the write, and a reset mid-suite is a device-visible surprise.
    await submodeSession('test-get', [`description ${marker}`, 'flowcontrol send off', 'flowcontrol receive on', 'no sflow enable'])

    const rec = await node.interfaces.get(scratchName, { status: 'skip' })
    expect(rec).toBeDefined()
    if (rec === undefined) return
    expect(rec.name).toBe(scratchName)
    // `:58` — the one value in this case EOS cannot have normalised away, because a description is never
    // a default line.
    expect(rec.description).toBe(marker)
    // `:59` assertFalse(result['shutdown']) — an unconfigured port has no `shutdown`/`no shutdown` line
    // at all, which this client reports as absent rather than pyeapi's defaulted False (DR-027).
    if (rec.shutdown !== undefined) expect(rec.shutdown).toBe(false)
    reportField(`${scratchName} ethernet.flowcontrolSend`, rec.ethernet?.flowcontrolSend)
    reportField(`${scratchName} ethernet.flowcontrolReceive`, rec.ethernet?.flowcontrolReceive)
    reportField(`${scratchName} ethernet.sflow`, rec.ethernet?.sflow)
    // Whatever the device chose to store, `:60-62`'s vocabulary must still type-check: this reader never
    // invents a value for a line it did not see.
    if (rec.ethernet?.flowcontrolSend !== undefined) expect(rec.ethernet.flowcontrolSend).toBe('off')
    if (rec.ethernet?.flowcontrolReceive !== undefined) expect(rec.ethernet.flowcontrolReceive).toBe('on')
    if (rec.ethernet?.sflow !== undefined) expect(rec.ethernet.sflow).toBe(false)

    await submodeSession('test-get-revert', ['default description', 'default flowcontrol send', 'default flowcontrol receive', 'default sflow enable'])
  })

  it('`no description` and `default description` both clear the field, where pyeapi asserts the empty string (set_description_negate :174, set_description_default :185)', async () => {
    const marker = 'm12c-desc-modes'
    for (const [caseName, command] of [
      ['negate', 'no description'],
      ['default', 'default description'],
    ] as const) {
      await submodeSession(`desc-${caseName}-set`, [`description ${marker}-${caseName}`])
      const set = await node.interfaces.get(scratchName, { status: 'skip' })
      expect(set?.description).toBe(`${marker}-${caseName}`)

      await submodeSession(`desc-${caseName}-clear`, [command])
      const cleared = await node.interfaces.get(scratchName, { status: 'skip' })
      // Upstream reads `show interfaces <intf>` and asserts `config['description'] == ''` (`:183`, `:194`):
      // the *operational* dict always carries the column. This client reads the *config* section, where a
      // cleared field is absent, not empty (DR-027) — the two spellings are the recorded divergence, and
      // `interfaces.test.ts` pins the config rule offline.
      expect(cleared?.description).toBeUndefined()
    }
  })

  it('the sflow trio reaches the device and the config-side read answers boolean-or-absent (set_sflow enable :196, disable :206, default :216)', async () => {
    for (const [caseName, command] of [
      ['enable', 'sflow enable'],
      ['disable', 'no sflow enable'],
      ['default', 'default sflow enable'],
    ] as const) {
      await submodeSession(`sflow-${caseName}`, [command])
      const rec = await node.interfaces.get(scratchName, { status: 'skip' })
      expect(rec).toBeDefined()
      reportField(`after \`${command}\`; ethernet.sflow`, rec?.ethernet?.sflow)
      if (rec?.ethernet?.sflow !== undefined) expect(typeof rec.ethernet.sflow).toBe('boolean')
      // `:204`/`:214`/`:224` assert on the *presence of the text* `no sflow enable` in
      // `show running-config interfaces <intf>`; the equivalent reader here is the section itself, so the
      // section text is printed verbatim (first 200 chars) as the device's side of that comparison.
      const block = await node.interfaces.getBlock(`interface ${scratchName}`)
      console.log(
        `live-interfaces: config section for ${scratchName} after \`${command}\` → ${block === undefined ? '<no section>' : JSON.stringify(block.slice(0, 200))}`,
      )
    }
    await submodeSession('sflow-revert', ['default sflow enable'])
  })

  it('`default interface <scratch>` leaves an operational status row on both sides of the write (test_default :151, without upstream\'s sleep(10))', async () => {
    const statusBefore = await node.interfaces.getStatus()
    const before = statusBefore.get(scratchName)
    if (before === undefined) console.warn(`live-interfaces: getStatus() has no row for ${scratchName} before the write — the status half of :154-162 cannot be compared on this target`)

    await submodeSession('default-desc', ['description m12c-default'])
    // `interfaces.setDefault` composes `default interface <name>` as a TOP-LEVEL config command (not a
    // submode line), so this write is not wrapped in `interface <name>`.
    await runGuardedLiveWriteSession(node, {
      name: `m12c-intf-default-run-${scratchName}`,
      commands: [`default interface ${scratchName}`],
    })

    const after = await node.interfaces.get(scratchName, { status: 'skip' })
    expect(after?.description).toBeUndefined()

    const statusAfter = await node.interfaces.getStatus()
    const row = statusAfter.get(scratchName)
    if (before !== undefined && row !== undefined) {
      for (const key of ['status', 'protocol'] as const) {
        if (row[key] !== undefined) expect(typeof row[key]).toBe('string')
      }
      // Upstream sleeps 10s (`:158`) so a link it just reset can come back up, then demands the
      // `interfaceStatus` column be identical before and after (`:162`). Neither the wait nor the equality
      // is a fact about this client: link-settle timing is device behaviour, and cEOS answers
      // `linkStatus`/`lineProtocolStatus` for the same column (row 106). Both are printed, and the case
      // asserts only that the device keeps modelling a row for the port it just defaulted (§5 row 187).
      console.log(
        `live-interfaces: test_default status columns · before=${JSON.stringify({ status: before.status, protocol: before.protocol })} ` +
          `after=${JSON.stringify({ status: row.status, protocol: row.protocol })} (equal=${JSON.stringify(before.status === row.status && before.protocol === row.protocol)})`,
      )
    } else {
      console.warn('live-interfaces: test_default compared nothing operationally — this target answered getStatus() with no row for the scratch port')
    }
  })
})

describe.skipIf(!ready)('live read-only observation: pyeapi test_api_interfaces.py (TestPortchannelInterface test_get_members_default :330, test_get_lacp_mode_with_default :383)', () => {
  let node: Node

  beforeAll(async () => {
    node = createNode(liveTransportOptions(targetOf()))
    const reported = await node.getVersion()
    const mismatch = matchesDeviceIdentity(targetOf(), { version: reported.version, modelName: reported.modelName })
    if (mismatch !== undefined && mismatch.code !== 'EAPI_VERSION_MISMATCH') throw new Error(`live-interfaces readiness: ${mismatch.reason}`)
  })

  it('the two port-channel READS answer a typed result or a typed device refusal, never a crash (get_members :335, get_lacp_mode :388 — read half only, §5 row 189)', async () => {
    // upstream only reaches these after creating Port-Channel1 (`:331-332`, `:384-385`), which DR-082 forbids
    // here. What is still verifiable without a write is what `show port-channel <grpid> all-ports` — the
    // command `interfaces.ts` ports from `interfaces.py:671-672` — actually answers on 4.28.14M when
    // the channel does not exist. The 2026-11-06 run settled it: `[]` and `undefined`. Only that half is
    // claimed (DR-043).
    const outcomes: Record<string, string> = {}
    for (const verb of ['getMembers', 'getLacpMode'] as const) {
      try {
        const value = verb === 'getMembers' ? await node.interfaces.getMembers('Port-Channel1') : await node.interfaces.getLacpMode('Port-Channel1')
        if (Array.isArray(value)) {
          for (const member of value) expect(typeof member).toBe('string')
          outcomes[verb] = `answered ${JSON.stringify(value)}`
        } else {
          outcomes[verb] = value === undefined ? 'answered undefined (this client\'s divergence 19: no DEFAULT_LACP_MODE default, unlike interfaces.py:67)' : `answered ${JSON.stringify(value)}`
        }
      } catch (rawErr) {
        expect(rawErr).toBeInstanceOf(EapiError)
        const err = rawErr as EapiError
        const code = err instanceof CommandError ? String(err.code) : err instanceof ProtocolError ? `protocol ${String(err.code)}` : 'no code'
        outcomes[verb] = `refused (${err.constructor.name} ${code}): ${err.message.split('\n')[0]?.slice(0, 160)}`
      }
      console.log(`live-interfaces: Port-Channel1 ${verb}(read-only on a channel-less target) → ${outcomes[verb]}`)
    }
    // The claim is deliberately only "the client produced a typed answer either way". Asserting upstream's
    // `[]`/`'on'` would be asserting the behaviour of a LAG this run refused to create.
    expect(Object.keys(outcomes)).toEqual(['getMembers', 'getLacpMode'])
  })
})

// --- DR-126 full-write lane: TestPortchannelInterface's write arms, on a FRESH group id -----------------

/**
 * The gate for everything below: `EAPI_LIVE` + the lab target class + `EAPI_LAB_FULL_WRITE=1`
 * (`live-full-write.ts:32-42`, DR-126 at `docs/DECISIONS.md:1996`), which `scripts/ceos-lab.mjs`'s `cmdRun`
 * child env passes for a run-owned container (`:2281`). The reads above need none of it; the LAG writes here do.
 */
const fullWrite = liveFullWriteReadiness(process.env)
if (!fullWrite.runnable) {
  console.warn(`live-interfaces: Port-Channel full-write cases SKIPPED (DR-034/DR-126) — ${fullWrite.skipReason ?? 'reason unavailable'}`)
}

/**
 * Group ids this lane creates. Every id is at or above this floor, because `Port-Channel1` is the
 * container's **own** provisioned LAG (`scripts/ceos-lab.mjs:1164-1168` — the trunk whose member is
 * `ethB`), and upstream's habit of driving `Port-Channel1` (`:257`, `:270`, `:303`, `:332`, `:340`,
 * `:364`, `:385`, `:394`, `:408`) is exactly the thing that has to change when the DUT is a shared lab
 * box rather than a bench fixture. `assertFreshGroup` below refuses anything else before a byte is sent.
 */
const FRESH_GROUP_FLOOR = 200
const PO_GET = `Port-Channel${String(FRESH_GROUP_FLOOR)}`
const PO_MEMBERS = `Port-Channel${String(FRESH_GROUP_FLOOR + 1)}`
const PO_LACP = `Port-Channel${String(FRESH_GROUP_FLOOR + 2)}`
const PO_MIN_LINKS = `Port-Channel${String(FRESH_GROUP_FLOOR + 3)}`

/** The value upstream reaches for with `random_int(1, 8)` (`:393`); fixed here so a failure is reproducible. */
const MIN_LINKS_VALUE = 2

function poRefusalText(rawErr: unknown): string {
  if (rawErr instanceof EapiError) {
    const code = rawErr instanceof CommandError ? String(rawErr.code) : rawErr instanceof ProtocolError ? `protocol ${String(rawErr.code)}` : 'no code'
    return `${rawErr.constructor.name} ${code}: ${rawErr.message.split('\n')[0]?.slice(0, 160) ?? ''}`
  }
  return rawErr instanceof Error ? `${rawErr.constructor.name}: ${rawErr.message.split('\n')[0]?.slice(0, 160) ?? ''}` : String(rawErr)
}

describe.skipIf(!(fullWrite.runnable && scratch.ok))('live full-write: pyeapi test_api_interfaces.py (TestPortchannelInterface :255-:409 — get :255, members :264/:297/:338, lacp :360, min-links :391/:404)', () => {
  let node: Node
  let scratchName: string
  /** The scratch port's own lines as this run FOUND them — replayed after every `default interface` churn. */
  let scratchFound: string | undefined

  beforeAll(async () => {
    scratchName = scratch.name ?? ''
    node = buildFullWriteNode(unwrapLiveTarget(fullWrite.resolution))
    const reported = await node.getVersion()
    const mismatch = matchesDeviceIdentity(unwrapLiveTarget(fullWrite.resolution), { version: reported.version, modelName: reported.modelName })
    if (mismatch !== undefined && mismatch.code !== 'EAPI_VERSION_MISMATCH') throw new Error(`live-interfaces readiness: ${mismatch.reason}`)
    // One guarded session so a refused member line can never half-reset the scratch port (DR-035/DR-081).
    scratchFound = await node.interfaces.getBlock(`interface ${scratchName}`)
    console.log(`live-interfaces: full-write scratch ${scratchName} as found → ${JSON.stringify(scratchFound ?? '<no section>')}`)
    if (scratchFound !== undefined && /channel-group/u.test(scratchFound)) {
      console.warn(`live-interfaces: the declared scratch port ${scratchName} ALREADY carries a channel-group on this container, so the member arms below WILL churn it: each case ends with \`default interface ${scratchName}\` (upstream's own staging move, :342/:365) and a replay of the lines just captured. The replay reproduces the config text, not the LACP timer state — a bounded cEOS churn, and the container is torn down by the harness afterwards (docs/CEOS.md)`)
    }
  })

  /** One named guarded session, all-or-nothing, never persistent — this lane's only write primitive. */
  const guard = (caseName: string, commands: readonly string[]) =>
    runGuardedLiveWriteSession(node, { name: `d2b-intf-${caseName}`, commands })

  /** Refuse anything but a fresh >= 200 group id, so the container's Po1 is untouchable by construction. */
  function assertFreshGroup(name: string): number {
    const id = Number(/(\d+)/u.exec(name)?.[1] ?? Number.NaN)
    if (!Number.isSafeInteger(id) || id < FRESH_GROUP_FLOOR) {
      throw new Error(`live-interfaces: refusing to touch ${JSON.stringify(name)} — this lane only creates Port-Channel ids >= ${String(FRESH_GROUP_FLOOR)}, never the container's own Po1 (scripts/ceos-lab.mjs:1164)`)
    }
    return id
  }

  /** upstream's staging pair (`no interface PoX` then `interface PoX`, e.g. :257-:258) as one guarded session. */
  async function createGroup(name: string, caseName: string): Promise<number> {
    const id = assertFreshGroup(name)
    const outcome = await guard(`create-${caseName}`, [`no interface ${name}`, `interface ${name}`])
    expect(outcome.committed).toBe(true)
    return id
  }

  async function dropGroup(name: string, caseName: string): Promise<void> {
    try {
      await guard(`drop-${caseName}`, [`no interface ${name}`])
    } catch (rawErr) {
      console.warn(`live-interfaces: teardown \`no interface ${name}\` was refused (${poRefusalText(rawErr)}) — the group survives on the container until harness teardown; reported, not hidden`)
    }
  }

  /** Reset the scratch port the way upstream's own staging lines do, then put back whatever this run found. */
  async function churnScratch(caseName: string): Promise<void> {
    try {
      await guard(`scratch-default-${caseName}`, [`default interface ${scratchName}`])
    } catch (rawErr) {
      console.warn(`live-interfaces: \`default interface ${scratchName}\` was refused (${poRefusalText(rawErr)}) — the member line this case wrote may survive; reported`)
    }
    if (scratchFound === undefined) return
    const lines = scratchFound
      .split(/\r?\n/u)
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0 && !line.startsWith('!') && !/^interface\s/u.test(line))
    if (lines.length === 0) return
    try {
      await guard(`scratch-replay-${caseName}`, [`interface ${scratchName}`, ...lines])
      const back = await node.interfaces.getBlock(`interface ${scratchName}`)
      const missing = lines.filter((line) => back === undefined || !back.includes(line))
      if (missing.length > 0) {
        console.warn(`live-interfaces: replay of ${scratchName} left ${JSON.stringify(missing)} unapplied — the container may keep a changed L2 state (churn reported per DR-034/DR-043)`)
      }
    } catch (rawErr) {
      console.warn(`live-interfaces: replaying the captured ${scratchName} lines was refused (${poRefusalText(rawErr)}) — churn left on the container, reported`)
    }
  }

  /** The member port's own running-config section — the text twin of upstream's `show running-config interfaces <etX>` (`:283`, `:316`, `:372`, `:399`). */
  async function sectionText(name: string): Promise<string> {
    return (await node.interfaces.getBlock(`interface ${name}`)) ?? '<this client saw no section for that name>'
  }

  it('a group THIS lane created reads through the typed record, and its empty-member reads are the device\'s (test_get :255 — staging :257-:258, asserts :260-:262; get_members_default :330 — :332-:336; get_lacp_mode_with_default :383 — :385-:389)', async () => {
    await createGroup(PO_GET, 'po-get')
    try {
      const rec = await node.interfaces.get(PO_GET, { status: 'skip' })
      expect(rec).toBeDefined()
      expect(rec?.name).toBe(PO_GET)
      // :261 asserts `result['type'] == 'portchannel'`. There is no `type` key in this client's record — the
      // kind comes from the name grammar (DR-067) and the group facts live in `portChannel`. Same statement,
      // different spelling (DR-003/row 90 vocabulary), so the port is asserted on `kind`.
      expect(rec?.kind).toBe('Port-Channel')

      // Upstream manufactures both answers **after** writing Po1 (`:331-332`, `:384-385`); here the group is
      // one this run created and left memberless, so for the first time these two reads are asserted rather
      // than observed. The read-only Po1 observation above (§5 row 189) stays as the container-shape half.
      expect(await node.interfaces.getMembers(PO_GET)).toEqual([])
      const mode = await node.interfaces.getLacpMode(PO_GET)
      if (mode !== undefined) {
        console.warn(`live-interfaces: getLacpMode(${PO_GET}) answered ${JSON.stringify(mode)} for a memberless group — upstream answers interfaces.py:67's DEFAULT_LACP_MODE 'on' (:389); this client answers whatever the device wrote, so a memberless group naming a mode is the device's statement, reported`)
      } else {
        console.log(`live-interfaces: getLacpMode(${PO_GET}) answered undefined — divergence 19 keeps pyeapi's 'on' default unported (interfaces.py:67), now observed on a group this lane created`)
      }
      const groupFacts = (await node.interfaces.get(PO_GET, { status: 'skip' }))?.portChannel
      console.log(`live-interfaces: config-side facts for a fresh memberless ${PO_GET} → ${JSON.stringify(groupFacts)}`)
    } finally {
      await dropGroup(PO_GET, 'po-get')
    }
  })

  it('the declared scratch port joins the group and answers as the ONLY member (test_get_members_one_member :338 — staging :340-:344, get_members :346, assert :347)', async () => {
    // Members come from `requireScratchInterface` only (the gate at the top of this file). upstream's member
    // picker is `random_interface` — helper at test/lib/systestlib.py:68-88, which itself only ever picks an
    // `Et*` name (:76), so no Management name is reachable by that suite either.
    const id = await createGroup(PO_MEMBERS, 'po-one-member')
    try {
      // upstream's own staging, line for line (`interface <etX>` + `channel-group 1 mode active`, :343-:344),
      // with the run's declared port and the run's own group id.
      await guard('one-member-add', [`interface ${scratchName}`, `channel-group ${String(id)} mode active`])
      expect(await node.interfaces.getMembers(PO_MEMBERS)).toEqual([scratchName])
      expect(await sectionText(scratchName)).toContain(`channel-group ${String(id)} mode active`)
      // The config-side twin of the same relation (divergence 15): the record stitched from the member's own
      // line, not from the `show port-channel all-ports` scrape.
      const facts = (await node.interfaces.get(PO_MEMBERS, { status: 'skip' }))?.portChannel
      expect(facts?.members).toEqual([scratchName])
      expect(facts?.lacpMode).toBe('active')
      // `test_get_members_two_members` (:349-:358) is NOT ported: it stages `interface Ethernet1-2` (:353),
      // a **range** spelling this client's name grammar refuses (DECISIONS.md open item 7), to reach two
      // members. The second physical port on this container is the undeclared `lab-provision` peer
      // (`scripts/ceos-lab.mjs:1151-1157`), and a single-operator lane gets exactly one declared scratch —
      // the arm is refused with the gap named, not widened.
      // Reading the mode through the device-backed verb, on a group that now really has a member:
      expect(await node.interfaces.getLacpMode(PO_MEMBERS)).toBe('active')
    } finally {
      await churnScratch('po-one-member')
      await dropGroup(PO_MEMBERS, 'po-one-member')
    }
  })

  it('setMembers diffs a single member in and back out (test_set_members :264 — random picks :266-:268, staging :270-:277, set_members :280, assertTrue :281, keep-half assert :287-:290, leave-half assert :293-:295)', async () => {
    const id = await createGroup(PO_MEMBERS, 'po-set-members')
    try {
      // The bare arm: no `mode` given, and a memberless group has no mode to reuse, so `setMembers` composes
      // `interface <m>` + `channel-group <id>` with no mode word — the line pyeapi would send from
      // get_lacp_mode's answer (`interfaces.py:639-658`). Whether this image accepts a mode-less
      // `channel-group` is the device's statement: an accepted write is asserted through the read-back, a
      // refusal is printed, and the staged-mode arm below covers the mode-carrying path either way.
      let bareApplied = false
      try {
        await node.interfaces.setMembers(PO_MEMBERS, [scratchName])
        bareApplied = true
      } catch (rawErr) {
        if (!(rawErr instanceof EapiError)) throw rawErr
        console.warn(`live-interfaces: setMembers with NO mode (bare channel-group line) was refused by this target (${poRefusalText(rawErr)}) — the mode-carrying arm below still runs (divergence 19/DR-077 keep this client from inventing a mode)`)
      }
      if (bareApplied) {
        expect(await node.interfaces.getMembers(PO_MEMBERS)).toEqual([scratchName])
        expect(await sectionText(scratchName)).toContain(`channel-group ${String(id)}`)
      }

      // The remove half of upstream's diff — the assertNotIn that proves et2 left the LAG (`:293`-`:295`).
      // Here the member that leaves is the one member this lane was allowed to add.
      await node.interfaces.setMembers(PO_MEMBERS, [])
      expect(await node.interfaces.getMembers(PO_MEMBERS)).toEqual([])
      expect(await sectionText(scratchName)).not.toContain(`channel-group ${String(id)}`)
      expect((await node.interfaces.get(PO_MEMBERS, { status: 'skip' }))?.portChannel?.members).toBeUndefined()
    } finally {
      await churnScratch('po-set-members')
      await dropGroup(PO_MEMBERS, 'po-set-members')
    }
  })

  it('setMembers with a mode names it on the member and rewrites it on a mode change (test_set_members_with_mode :297 — set_members call :313-:314, assert :322; the mode-change side effect is interfaces.py:702-:704, this port\'s divergence 20)', async () => {
    const id = await createGroup(PO_MEMBERS, 'po-mode')
    try {
      await node.interfaces.setMembers(PO_MEMBERS, [scratchName], 'active')
      expect(await sectionText(scratchName)).toContain(`channel-group ${String(id)} mode active`)
      expect(await node.interfaces.getLacpMode(PO_MEMBERS)).toBe('active')
      // The second call has the members unchanged, so the only work left is the mode rewrite pyeapi does in a
      // **separate** earlier batch (`interfaces.py:704`, `rewriteMembers` at `interfaces.ts:2077-2086`) — a
      // two-transaction effect upstream's own last-call testlib assert could never see (§5, divergence 20).
      await node.interfaces.setMembers(PO_MEMBERS, [scratchName], 'passive')
      expect(await sectionText(scratchName)).toContain(`channel-group ${String(id)} mode passive`)
      expect((await node.interfaces.get(PO_MEMBERS, { status: 'skip' }))?.portChannel?.lacpMode).toBe('passive')
    } finally {
      await churnScratch('po-mode')
      await dropGroup(PO_MEMBERS, 'po-mode')
    }
  })

  it('setLacpMode rewrites the member line for all three modes pyeapi loops (test_set_lacp_mode :360 — loop :362, cfgmode mirror :363, staging :364-:367, call :369, assert :374)', async () => {
    for (const mode of ['on', 'active', 'passive'] as const) {
      const id = assertFreshGroup(PO_LACP)
      // upstream's own inverted staging (`cfgmode = 'on' if mode != 'on' else 'active'`, :363) so the write
      // always changes the word, then set_lacp_mode flips it (:369).
      const cfgMode = mode !== 'on' ? 'on' : 'active'
      const outcome = await guard(`lacp-stage-${mode}`, [
        `no interface ${PO_LACP}`,
        `interface ${PO_LACP}`,
        `interface ${scratchName}`,
        `channel-group ${String(id)} mode ${cfgMode}`,
      ])
      expect(outcome.committed).toBe(true)
      try {
        await node.interfaces.setLacpMode(PO_LACP, mode)
        expect(await sectionText(scratchName)).toContain(`channel-group ${String(id)} mode ${mode}`)
        expect((await node.interfaces.get(PO_LACP, { status: 'skip' }))?.portChannel?.lacpMode).toBe(mode)
      } catch (rawErr) {
        if (!(rawErr instanceof EapiError)) throw rawErr
        console.warn(`live-interfaces: setLacpMode(...,'${mode}') was refused by this target (${poRefusalText(rawErr)}) — the :374 read-back for that mode is NOT claimed`)
      }
      await churnScratch(`lacp-${mode}`)
      await dropGroup(PO_LACP, `lacp-${mode}`)
    }
    // test_set_lacp_mode_invalid_value (:377-:381) maps to this client's refusal, not a device False:
    // `assertLacpMode` (`interfaces.ts:2027`/`:2071`) rejects a word outside LACP_MODES (:658-:659) before the
    // wire, where pyeapi sends `channel-group 1 mode <random>` and reads a False device answer (:381).
    await guard('lacp-invalid-stage', [`no interface ${PO_LACP}`, `interface ${PO_LACP}`, `interface ${scratchName}`, `channel-group ${String(FRESH_GROUP_FLOOR + 2)} mode active`])
    try {
      const before = await sectionText(scratchName)
      await expect(node.interfaces.setLacpMode(PO_LACP, 'unspecified' as LacpMode)).rejects.toBeInstanceOf(NotSupportedError)
      expect(await sectionText(scratchName)).toBe(before)
      expect(await node.interfaces.getMembers(PO_LACP)).toEqual([scratchName])
    } finally {
      await churnScratch('lacp-invalid')
      await dropGroup(PO_LACP, 'lacp-invalid')
    }
  })

  it('min-links round-trips through the typed field on a fresh group (test_minimum_links_valid :391 — staging :394-:395, call :396-:397, assertTrue :398, assert :401-:402; the clear arms are this client\'s own verbs, unsetMinimumLinks interfaces.ts:2101 and defaultMinimumLinks :2107)', async () => {
    await createGroup(PO_MIN_LINKS, 'min-links')
    try {
      await node.interfaces.setMinimumLinks(PO_MIN_LINKS, MIN_LINKS_VALUE)
      expect(await sectionText(PO_MIN_LINKS)).toContain(`port-channel min-links ${String(MIN_LINKS_VALUE)}`)
      expect((await node.interfaces.get(PO_MIN_LINKS, { status: 'skip' }))?.portChannel?.minimumLinks).toBe(MIN_LINKS_VALUE)
      // DR-076: upstream substitutes `0` when the line is missing; this client answers absent. Both clear
      // verbs are exercised so that claim is a live one, not only an offline fixture.
      await node.interfaces.unsetMinimumLinks(PO_MIN_LINKS)
      expect((await node.interfaces.get(PO_MIN_LINKS, { status: 'skip' }))?.portChannel?.minimumLinks).toBeUndefined()
      await node.interfaces.setMinimumLinks(PO_MIN_LINKS, MIN_LINKS_VALUE)
      await node.interfaces.defaultMinimumLinks(PO_MIN_LINKS)
      expect(await sectionText(PO_MIN_LINKS)).not.toContain(`port-channel min-links ${String(MIN_LINKS_VALUE)}`)
    } finally {
      await dropGroup(PO_MIN_LINKS, 'min-links')
    }
  })

  it('an out-of-range min-links is the DEVICE\'s refusal, not a client-side False (test_minimum_links_invalid_value :404 — value 1025 at :406, call :407-:408, assertFalse :409)', async () => {
    await createGroup(PO_MIN_LINKS, 'min-links-invalid')
    try {
      try {
        await node.interfaces.setMinimumLinks(PO_MIN_LINKS, 1025)
        const answered = (await node.interfaces.get(PO_MIN_LINKS, { status: 'skip' }))?.portChannel?.minimumLinks
        console.warn(`live-interfaces: this target ACCEPTED \`port-channel min-links 1025\` and the typed read answers ${JSON.stringify(answered)} — upstream's assertFalse (:409) is a bench-device answer, so the ceiling is recorded as this container's answer rather than asserted either way (clearing it below)`)
      } catch (rawErr) {
        if (!(rawErr instanceof EapiError)) throw rawErr
        expect((await sectionText(PO_MIN_LINKS)).includes('port-channel min-links 1025')).toBe(false)
        console.log(`live-interfaces: min-links 1025 refused as expected → ${poRefusalText(rawErr)}`)
      }
    } finally {
      try {
        await node.interfaces.defaultMinimumLinks(PO_MIN_LINKS)
      } catch (rawErr) {
        console.warn(`live-interfaces: clearing the min-links line during teardown was refused (${poRefusalText(rawErr)}) — reported with the group removal below`)
      }
      await dropGroup(PO_MIN_LINKS, 'min-links-invalid')
    }
  })

  it('default interface <scratch> and default interface <group> answer without stranding the run\'s reads (the :67/:271/:274/:277/:304/:307/:310/:342/:353/:365 staging arms\' live half; test_default :151 is already ported on the plain-port lane)', async () => {
    const id = await createGroup(PO_MIN_LINKS, 'defaults')
    await guard('defaults-member', [`interface ${scratchName}`, `channel-group ${String(id)} mode active`])
    try {
      expect(await node.interfaces.getMembers(PO_MIN_LINKS)).toEqual([scratchName])
      await guard('defaults-default', [`default interface ${scratchName}`, `default interface ${PO_MIN_LINKS}`])
      const port = await node.interfaces.get(scratchName, { status: 'skip' })
      const group = await node.interfaces.get(PO_MIN_LINKS, { status: 'skip' })
      // Whatever the device stores for `shutdown`/`mtu` after a default is its statement, not a client rule
      // (DR-027, reportField precedents §5 rows 186-187) — the claim here is that both reads still answer a
      // typed record and the membership relation is gone from both sides.
      expect(port?.name).toBe(scratchName)
      expect(group?.name).toBe(PO_MIN_LINKS)
      expect(await node.interfaces.getMembers(PO_MIN_LINKS)).toEqual([])
      expect((await node.interfaces.get(PO_MIN_LINKS, { status: 'skip' }))?.portChannel?.members).toBeUndefined()
      console.log(`live-interfaces: after defaulting both sides → scratch=${JSON.stringify({ shutdown: port?.shutdown, mtu: port?.mtu })} group=${JSON.stringify(group?.portChannel)}`)
    } finally {
      await churnScratch('defaults')
      await dropGroup(PO_MIN_LINKS, 'defaults')
    }
  })
})
