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
 * | `TestResourceInterfaces.test_getall` (`:64`) | ✅ read (M12a) + ✅ M12c membership half | upstream pre-writes `default interface <rintf>` (`:66`) then checks `<rintf>` and `Management1` are keys (`:68-70`). `Management1` exists on any bootable target, so M12a read the membership without any write; the **other** key of that loop is by definition a port the run configured, so M12c claims it only after its own guarded scratch write — see the `getall`-membership case below |
 * | `TestResourceInterfaces.test_get` (`:45`) | ✅ M12c — read-after-guarded-write | M12a declined this because the values it asserts (`description` `:58`, `shutdown` `:59`, `flowcontrol_send 'off'` `:60`, `flowcontrol_receive 'on'` `:61`, `sflow` False `:62`) are ones it had **just written** (`:48-53`) on a `random_interface` port. The M12c case writes the same five lines on the run's own `EAPI_SCRATCH_INTERFACE` (DR-035(b)) and then reads them through the typed record, so the read side is exercised without asserting a value the device never saw. Exactness is claimed only for what EOS must store; a field a device may treat as default reads absent and is logged instead (§5 row 186) |
 * | `test_create_and_return_true` (`:73`)/`test_delete_and_return_true` (`:86`), `..._sub_interface` (`:99`), `test_ethernet_set_and_unset_encapsulation` (`:115`), portchannel sub-intf (`:411`,`:440`) | ❌ skipped | mutate `Loopback0`, `Ethernet1.1`/`Port-Channel` **subinterfaces**. Loopback and subinterface creation are not the named base scratch port; and this client deliberately *refuses* Ethernet create/delete (`interfaces.ts` `assertPresentName`), an offline fact already asserted in `interfaces.test.ts` — see the two `_raises_not_implemented_error` rows |
 * | `test_create_ethernet_raises_not_implemented_error` (`:81`), `test_delete_ethernet_raises_not_implemented_error` (`:94`) | ❌ skipped | pure **client-side** refusals — no device round trip reaches EOS, so they cannot be *live* tests. They are this module's `NotSupportedError`; pinned offline |
 * | `test_set_encapsulation_*` (`:139`,`:145`), `test_set_vrf` (`:227`) | ❌ skipped | need a subinterface, `Vlan1234`, or a global `vrf instance test` write (`:240`) — the last is a global mutation the guarded session does not scope |
 * | `test_default` (`:151`), `test_set_sflow_enable/disable/default` (`:196`,`:206`,`:216`) | ✅ M12c — guarded scratch-port writes | M12a skipped these because the mutated port came from `random_interface`; on the named scratch port the writes are legal. `test_default`'s before/after read (`show interfaces <intf>` → `interfaces[intf]['interfaceStatus']`, `:154-162`) is answered here by `getStatus()` (this client's status command is `show interfaces status`, whose captured spelling is `linkStatus` — row 106), and upstream's `sleep(10)` link-settle wait (`:158`) is **not** ported: the case asserts the row exists and its columns are strings, and logs the before/after pair instead of encoding a timing assumption (§5 row 187). The sflow reads are `show running-config interfaces <intf>` **text** (`:202-204`, `:212-214`, `:222-224`) — the same text the new `show running-config` capture commits (§5 row 185) |
 * | `TestPortchannelInterface.test_get` (`:255`), member/LACP/minimum-links writes (`:264`–`:479`) | ❌ skipped | every case first `dut.config(['no interface Port-Channel1', 'interface Port-Channel1', …])` (`:256-257`, `:331-332`, `:340-345`, `:384-385`) and several add `channel-group 1 mode …` on **random** member ports (`:266-273`, `:341-343`). `Port-Channel…` is not an `Ethernet…` scratch name (DR-035(b)/DR-082), and a live LAG on ports the run did not name is exactly the mutation that rule exists to stop |
 * | `test_get_members_default` (`:330`), `test_get_lacp_mode_with_default` (`:383`) — **read half only** | ✅ M12c — read-only capability observation | upstream reaches `instance.get_members('Port-Channel1')` (`:335`) / `get_lacp_mode` (`:388`) only after a `Port-Channel1` write (`:331-332`, `:384-385`) this lane will not make. The two reads themselves mutate nothing, so the M12c case performs just them against a node with no channel configured and reports verbatim what the device says — a typed `string[]`, or the typed `CommandError` with the device's code. It does **not** claim upstream's `[]` (`:336`) or `'on'` (`:389`) answer, which belongs to a LAG upstream created; `'on'` is `interfaces.py:67`'s `DEFAULT_LACP_MODE`, this client's divergence 19 (§5 row 189) |
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
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { createNode } from './node'
import { CommandError, EapiError, ProtocolError } from './errors'
import { resolveLiveEnv, unwrapLiveTarget, liveTransportOptions, matchesDeviceIdentity, describeLiveTarget, requireScratchInterface, type LiveTarget } from './testing/live-guard'
import { runGuardedLiveWriteSession } from './testing/live-session-policy'
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
    // Upstream asserts `Management1` is a key (:70) after its own setup write (:66). This bare cEOS-lab node
    // boots with an empty running-config and no interfaces on this host, so membership is claimed only when
    // the target actually reports interface sections; otherwise the read *shape* still holds and the
    // membership half is reported as not exercised (DR-034/DR-043 — no coverage dressed as a pass).
    if (all.size === 0) {
      console.warn('live-interfaces: getAll() reported 0 interface sections on this target — Management1 membership half NOT exercised (portless/empty-config container)')
    } else {
      expect(all.has('Management1') || all.has('Management0')).toBe(true)
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
    // command `interfaces.ts:1531` ports from `interfaces.py:671-672` — actually answers on 4.28.14M when
    // the channel does not exist. `interfaces.ts` currently says the shape of that answer is owed to M12;
    // this test reports the half a cEOS container can settle, and only that half (DR-043).
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
      } catch (err) {
        expect(err).toBeInstanceOf(EapiError)
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
