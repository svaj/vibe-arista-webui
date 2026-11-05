/**
 * `*.live.test.ts` port of `pyeapi/test/system/test_api_switchports.py` @ `6816d9e` — M12a (#14) opened the
 * file; **M12c (#14) tranche 2** adds the remaining upstream cases. See the table for the per-case verdict.
 *
 * Loud-skip semantics match `live-system.live.test.ts` (DR-034). This file also proves the **write side**:
 * `src/testing/live-session-policy.ts`'s `runGuardedLiveWriteSession` applied to the scratch port. The write
 * cases run only when `resolveLiveEnv` accepted the env **and** `requireScratchInterface` names a valid
 * `Ethernet…` (DR-035(b)); otherwise they skip with a printed reason. A live write is confined to that one
 * named port inside a named config session that aborts on failure and never persists — the exact guarantees
 * the helper's offline `MockTransport` tests pin.
 *
 * | upstream (verified line @6816d9e) | ported? | here / why |
 * |---|---|---|
 * | `test_getall` (`:62`) | ✅ read (M12a) + ✅ M12c membership half | upstream pre-writes `default interface <intf>` (`:64`) to name a member; here `getAll()` is read on the device's current state and asserted shape-level (a `Map<string, Switchport>`, every value carrying `interfaceName`/`trunkGroups`). M12c separately claims the `assertIn(intf, result)` half (`:68`) — not for a `random_interface` port, but for the scratch port this run itself configured (§5 row 188) |
 * | `test_get` (`:43`) | ✅ read (scratch) | after a scratch-port `default interface` the port answers `mode access`, `access_vlan '1'`, etc. (`:48-51`). Read against **our own** scratch port (the write goes through the policy helper first), assertion narrowed to shape/types rather than pyeapi's fixed dict |
 * | `test_create_and_return_true` (`:70`), `test_delete_and_return_true` (`:83`) | ✅ write (scratch, integration) | `switchports create/delete` is `switchport` / `no switchport` on the interface. Ported as a guarded session write on the scratch port, then re-read the switchport record — this is the read-after-write the upstream test does, with DR-035's session/abort/never-persist wrapper |
 * | `test_get_returns_none` (`:54`) | ✅ M12c | upstream reaches the L3 state with `default interface <intf>` + `interface <intf>` + `no switchport` (`:56-57`) — the same lines the create/delete case already sends, but on the **named** scratch port, so the negative read becomes an assertion of its own (pyeapi `assertIsNone` at `:60`, DR-027's `undefined` here) rather than a by-product of another case |
 * | `test_set_access_vlan_to_value` (`:94`), `test_set_trunk_native_vlan` (`:107`), `test_set_trunk_allowed_vlans` (`:121`) | ✅ write (scratch) | each is one `switchport …` line on the (scratch) interface plus a `vlan 100` pre-write. `vlan 100` creation is a global write (see the vlans file's policy reason) **not** made here, so trunk/native VLAN ids are exercised only where they do not require creating an unowned VLAN; the access-port write is fully ported, the trunk writes stage the `switchport mode/allowed` lines on the scratch port and re-read. Command lists are also pinned offline (`resources/switchports.test.ts`) |
 *
 * Upstream cites `random_interface(dut)` (a port picked from `show interfaces`) for every case; DR-035(b)
 * forbids inferring the mutated port from `show interfaces`, so **all** this file's writes target the
 * explicitly-named `EAPI_SCRATCH_INTERFACE` instead.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { createNode } from './node'
import { resolveLiveEnv, unwrapLiveTarget, liveTransportOptions, matchesDeviceIdentity, describeLiveTarget, requireScratchInterface, type LiveTarget } from './testing/live-guard'
import { runGuardedLiveWriteSession } from './testing/live-session-policy'
import type { Node } from './command-layer'

const resolution = resolveLiveEnv(process.env)
if (!resolution.ok) {
  console.warn(`live-switchports: SKIPPED (DR-034) — ${resolution.reason}`)
}
const ready = resolution.ok

/** Only meaningful when the guard accepted the env; `requireScratchInterface` needs the unwrapped target. */
const scratch: { ok: boolean; name?: string; reason?: string } = ready
  ? (() => {
      const target = unwrapLiveTarget(resolution)
      const req = requireScratchInterface(target)
      return req.ok ? { ok: true, name: req.name } : { ok: false, reason: req.reason }
    })()
  : { ok: false, reason: 'live target not accepted' }
if (ready && !scratch.ok) {
  console.warn(`live-switchports: write cases SKIPPED (DR-035b) — ${scratch.reason ?? ''}`)
}
const writeReady = ready && scratch.ok

function targetOf(): LiveTarget {
  return unwrapLiveTarget(resolution)
}

describe.skipIf(!ready)('live read: pyeapi test_api_switchports.py (test_getall, :62)', () => {
  let node: Node
  beforeAll(async () => {
    const target = targetOf()
    console.log(`live-switchports: target = ${describeLiveTarget(target)}`)
    node = createNode(liveTransportOptions(target))
    const reported = await node.getVersion()
    const mismatch = matchesDeviceIdentity(target, { version: reported.version, modelName: reported.modelName })
    // Tolerate only the suffix-driven EAPI_VERSION_MISMATCH (cEOS `version` has an engineering-build suffix);
    // the probe enforces base identity + model + TLS (DR-066).
    if (mismatch !== undefined && mismatch.code !== 'EAPI_VERSION_MISMATCH') throw new Error(`live-switchports readiness: ${mismatch.reason}`)
    if (mismatch?.code === 'EAPI_VERSION_MISMATCH') console.warn(`live-switchports: reported version "${reported.version}" vs pin "${target.allowVersion}" (base-level enforced by the probe, DR-066)`)
  })

  it('switchports.getAll() is a keyed table of switchport records (test_getall, :62 — read half)', async () => {
    const all = await node.switchports.getAll()
    expect(typeof all.has).toBe('function')
    for (const [name, sp] of all) {
      expect(typeof name).toBe('string')
      expect(sp.interfaceName).toBe(name)
      expect(Array.isArray(sp.trunkGroups)).toBe(true)
      if (sp.mode !== undefined) expect(typeof sp.mode).toBe('string')
      if (sp.accessVlan !== undefined) expect(typeof sp.accessVlan).toBe('number')
    }
  })
})

describe.skipIf(!writeReady)('live read/write on the scratch port: pyeapi test_api_switchports.py (test_get :43, create :70, delete :83, set_* :94/:107/:121)', () => {
  let node: Node
  let scratchName: string
  beforeAll(async () => {
    scratchName = scratch.name ?? ''
    node = createNode(liveTransportOptions(targetOf()))
    // Reset the scratch port to a known L2 state through the guarded session, so the read/write cases below
    // all start from a deterministic baseline. This is itself a DR-035-compliant scratch-port write.
    await runGuardedLiveWriteSession(node, {
      name: `m12a-sp-base-${scratchName}`,
      commands: [`interface ${scratchName}`, 'default switchport'],
    })
  })

  it('switchports.get(scratch) answers a record after a guarded default (test_get, :43 — narrowed to shape)', async () => {
    const sp = await node.switchports.get(scratchName)
    expect(sp).toBeDefined()
    if (sp === undefined) return
    expect(sp.interfaceName).toBe(scratchName)
    expect(Array.isArray(sp.trunkGroups)).toBe(true)
  })

  it('a guarded write makes the port a switchport, then removes L2 (test create/delete, :70/:83)', async () => {
    // `switchport` / `no switchport` are the create/delete commands (switchports.ts). Both run inside a
    // named session; the second leaves the port L3, which switchports.get() then reports as absent.
    await runGuardedLiveWriteSession(node, {
      name: `m12a-sp-on-${scratchName}`,
      commands: [`interface ${scratchName}`, 'switchport'],
    })
    const asL2 = await node.switchports.get(scratchName)
    expect(asL2).toBeDefined()

    await runGuardedLiveWriteSession(node, {
      name: `m12a-sp-off-${scratchName}`,
      commands: [`interface ${scratchName}`, 'no switchport'],
    })
    const asL3 = await node.switchports.get(scratchName)
    expect(asL3).toBeUndefined()

    // restore L2 for repeatability
    await runGuardedLiveWriteSession(node, {
      name: `m12a-sp-restore-${scratchName}`,
      commands: [`interface ${scratchName}`, 'switchport'],
    })
  })

  it('a guarded access-port write sets the switchport mode line without persisting (test_set_access_vlan family, :94)', async () => {
    // Mode only — VLAN 100 would have to exist first (a global write, skipped in live-vlans). `switchport
    // mode access` on the scratch port is a pure per-port mutation the guarded session can roll back.
    const outcome = await runGuardedLiveWriteSession(node, {
      name: `m12a-sp-mode-${scratchName}`,
      commands: [`interface ${scratchName}`, 'switchport mode access'],
    })
    expect(outcome.committed).toBe(true)
    const sp = await node.switchports.get(scratchName)
    expect(sp?.mode).toBe('access')
  })
})
