/**
 * `*.live.test.ts` port of `pyeapi/test/system/test_api_interfaces.py` @ `6816d9e` — M12a (#14),
 * read-mostly plus one scratch-port write. Same loud-skip gate as the other live files (DR-034); write cases
 * additionally require `requireScratchInterface` and run through `runGuardedLiveWriteSession`.
 *
 * This upstream file is the largest (48 methods across three classes) but the least *read*-able: a bare
 * `interfaces.get(x)` on upstream almost always follows a `dut.config([... 'interface x' …, <field>])` that
 * names x by first **creating/mutating** it, and most of those names (`Port-Channel1`, `Loopback0`,
 * `Vxlan1`, `Management1`, `Vlan1234`) are off-limits for a live write (DR-035(b): only an explicitly-named
 * `Ethernet…` scratch port, `docs/CEOS.md:131`). Read/write split below:
 *
 * | upstream (verified line @6816d9e) | ported? | here / why |
 * |---|---|---|
 * | `TestResourceInterfaces.test_getall` (`:64`) | ✅ read | upstream pre-writes `default interface <rintf>` (`:66`) then checks `<rintf>` and `Management1` are keys (`:68-70`). `Management1` exists on any bootable target, so the membership read is done without any write; the random-port membership is a write result and is not claimed here |
 * | `TestResourceInterfaces.test_get` (`:45`) | ❌ skipped as upstream-written | it asserts `description == 'this is a test'`, `flowcontrol_send == 'off'` etc. **because** it first writes them (`:46-51`). Those exact fields are a scratch-port mutation covered by the guarded `set_description` write below; asserting a hard-coded value on an unknown port is not shape-level, and flow-control/sflow fields are a M10c field question (DR-068), not this suite |
 * | `test_create_and_return_true` (`:73`)/`test_delete_and_return_true` (`:86`), `..._sub_interface` (`:99`), `test_ethernet_set_and_unset_encapsulation` (`:115`), portchannel sub-intf (`:411`,`:440`) | ❌ skipped | mutate `Loopback0`, `Ethernet1.1`/`Port-Channel` **subinterfaces**. Loopback and subinterface creation are not the named base scratch port; and this client deliberately *refuses* Ethernet create/delete (`interfaces.ts` `assertPresentName`), an offline fact already asserted in `interfaces.test.ts` — see the two `_raises_not_implemented_error` rows |
 * | `test_create_ethernet_raises_not_implemented_error` (`:81`), `test_delete_ethernet_raises_not_implemented_error` (`:94`) | ❌ skipped | pure **client-side** refusals — no device round trip reaches EOS, so they cannot be *live* tests. They are this module's `NotSupportedError`; pinned offline |
 * | `test_set_encapsulation_*` (`:139`,`:145`), `test_set_vrf` (`:227`) | ❌ skipped | need a subinterface, `Vlan1234`, or a global `vrf instance test` write (`:240`) — the last is a global mutation the guarded session does not scope |
 * | `test_default` (`:151`), `test_set_sflow_*` (`:196`,`:206`,`:216`) | ❌ skipped | `default interface`/sflow toggles on a `<rintf>` chosen by `random_interface` — a scratch-port write is legal, but the assertion is a `show interfaces` status round-trip (`interfaceStatus`) that this client models only as an *optional* enrichment (DR-057) and cannot assert shape-stably without the status capture; kept offline + fixture-driven |
 * | `TestPortchannelInterface.test_get` (`:255`) and all Port-Channel cases (`:255`–`:479`) | ❌ skipped | create/read `Port-Channel1`, members, LACP, minimum-links. `Port-Channel…` is not an `Ethernet…` scratch name (DR-035(b)); writing it would also risk a live LAG on random member ports |
 * | `TestApiVxlanInterface` (all 16, `:481`–`:659`) | ❌ skipped | `Vxlan1` source-interface/multicast/VTEP/VLAN — `Vxlan…` is neither an Ethernet scratch port nor a resource this client implements yet |
 *
 * So the file ports `test_getall` as a read, and exercises `test_set_description` (`:164`) as the guarded
 * scratch-port write (its negate/default siblings, `:174`/`:185`, are the same command in another mode and
 * are covered offline). Everything else is skipped for a *named, documented* reason — an off-limits interface
 * name, a global mutation outside the scratch rule, a client-side refusal that never reaches a device, or a
 * field whose live answer is already fixture-owned — not because it was overlooked.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { createNode } from './node'
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
    if (mismatch !== undefined) throw new Error(`live-interfaces readiness: ${mismatch.reason}`)
  })

  it('interfaces.getAll() is a keyed table including the management port (test_getall, :64 — read half)', async () => {
    const all = await node.interfaces.getAll()
    expect(typeof all.has).toBe('function')
    // `Management1` is asserted by upstream (:70) and exists on any booted target, so this membership needs
    // no write. The random-port membership upstream adds (:69) after `default interface` is not claimed.
    expect(all.has('Management1')).toBe(true)
    for (const [name, intf] of all) {
      expect(intf.name).toBe(name)
      // `kind` is DR-067's per-kind parse: a known kind or `null` for a header grammar this client cannot
      // parse (e.g. a chassis/ranges form) — both are legitimate, so assert the field exists and is one or the other.
      expect(intf.kind === 'Ethernet' || intf.kind === 'Management' || intf.kind === 'Port-Channel' || intf.kind === 'Loopback' || intf.kind === 'Vlan' || intf.kind === 'Vxlan' || intf.kind === null).toBe(true)
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
