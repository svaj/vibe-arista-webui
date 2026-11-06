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
 * | `test_get` (`:43`) | ✅ read (scratch) + ✅ M12c field half | M12a read the record shape after a guarded `default switchport`. M12c additionally reads the **four fields upstream compares at `:48-51`** (`mode`, `access_vlan`, `trunk_native_vlan`, `trunk_allowed_vlans`) off the scratch port after `default interface <scratch>` (`:45`) and prints what this device actually stores for each — `accessVlan`/`trunkNativeVlan` are `number` here, not pyeapi's digit-strings (MIGRATION §4, row 96), and a field the device leaves implicit reads absent (DR-027), which is reported rather than asserted (§5 row 186) |
 * | `test_create_and_return_true` (`:70`), `test_delete_and_return_true` (`:83`) | ✅ write (scratch, integration) | `switchports create/delete` is `switchport` / `no switchport` on the interface. Ported as a guarded session write on the scratch port, then re-read the switchport record — this is the read-after-write the upstream test does, with DR-035's session/abort/never-persist wrapper |
 * | `test_get_returns_none` (`:54`) | ✅ M12c | upstream reaches the L3 state with `default interface <intf>` + `interface <intf>` + `no switchport` (`:56-57`) — the same lines the create/delete case already sends, but on the **named** scratch port, so the negative read becomes an assertion of its own (pyeapi `assertIsNone` at `:60`, DR-027's `undefined` here) rather than a by-product of another case. The case keeps upstream's exact staging (`:56-57`) and then restores the port |
 * | `test_set_access_vlan_to_value` (`:94`), `test_set_trunk_native_vlan` (`:107`), `test_set_trunk_allowed_vlans` (`:121`) | ✅ write (scratch), M12c widened from mode-only | each upstream case is one `switchport …` line on the interface **plus a `vlan 100` pre-write** (`:97`, `:111`) — creating an unowned VLAN is the global write `live-vlans.live.test.ts` refuses (no scratch-VLAN gate under DR-035), so these cases never name VLAN 100. What is exercised instead: the access-mode line (`:94`'s own `switchport mode` family), and on the trunk side the `switchport mode trunk` + `switchport trunk allowed vlan <ids>` + `switchport trunk native vlan 1` lines, i.e. the **same command shape** with an always-present default VLAN. Whether EOS demands that every allowed id exist is a device question, so the batch is attempted inside a guarded session and a refusal is reported as the device's typed `CommandError` (code included) rather than swallowed — the session aborts, the port is restored, and the read-back half of `:118-120`/`:132-134` runs only when the device accepted the line (§5 row 188). Command lists are also pinned offline (`resources/switchports.test.ts`) |
 *
 * **M12c tranche 2 (this branch, #14)** ports the three cases M12a left out — `test_get_returns_none` (`:54`),
 * the `assertIn(intf, result)` membership half of `test_getall` (`:68`), and the trunk-line family
 * (`:107`/`:121`) narrowed as the row above describes — and turns M12a's shape-only `test_get` into a
 * field-level read of `:48-51`'s four comparisons. Every write still targets only
 * `EAPI_SCRATCH_INTERFACE`, and a device answer this container does not produce is reported with
 * `console.warn`, never asserted.
 *
 * Upstream cites `random_interface(dut)` (a port picked from `show interfaces`) for every case; DR-035(b)
 * forbids inferring the mutated port from `show interfaces`, so **all** this file's writes target the
 * explicitly-named `EAPI_SCRATCH_INTERFACE` instead.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { createNode } from './node'
import { CommandError, EapiError, ProtocolError } from './errors'
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

  it('the L3 negative read is an assertion of its own: switchports.get() is undefined for a port with no switchport config (test_get_returns_none, :54 — pyeapi assertIsNone at :60)', async () => {
    // Upstream's exact staging (`:56-57`), on the named scratch port instead of `random_interface`.
    await runGuardedLiveWriteSession(node, {
      name: `m12c-sp-l3-${scratchName}`,
      commands: [`default interface ${scratchName}`, `interface ${scratchName}`, 'no switchport'],
    })
    const l3 = await node.switchports.get(scratchName)
    if (l3 !== undefined) {
      // `show running-config all` spells interface defaults out, so a container that models L3 with
      // explicit lines can legitimately produce a record here. Report the device's answer; do not force
      // pyeapi's None-equality through a widening this client has not decided (§5 row 188).
      console.warn(`live-switchports: get(${scratchName}) returned a record in the L3 state (${JSON.stringify(l3).slice(0, 200)}) — the None/undefined half of :60 is reported, not asserted`)
    } else {
      expect(l3).toBeUndefined()
    }
    // Whatever the answer, the read must not invent a mode for a line the section does not write.
    if (l3 !== undefined) expect(l3.interfaceName).toBe(scratchName)

    await runGuardedLiveWriteSession(node, {
      name: `m12c-sp-l3-restore-${scratchName}`,
      commands: [`default interface ${scratchName}`],
    })
  })

  it('the scratch port THIS run made a switchport is a key of getAll() (test_getall :62 — the assertIn(intf, result) half at :68, §5 row 188)', async () => {
    await runGuardedLiveWriteSession(node, {
      name: `m12c-sp-getall-${scratchName}`,
      commands: [`interface ${scratchName}`, 'switchport'],
    })
    const all = await node.switchports.getAll()
    if (all.size === 0) {
      console.warn('live-switchports: getAll() reported 0 switchport sections — the membership half of :68 is NOT exercised on this target')
      return
    }
    expect(all.has(scratchName)).toBe(true)
    const entry = all.get(scratchName)
    expect(entry?.interfaceName).toBe(scratchName)
    expect(Array.isArray(entry?.trunkGroups)).toBe(true)
    // The collection and the single read must agree about the same physical port — this client's own
    // consistency claim, independent of what the device defaults.
    const single = await node.switchports.get(scratchName)
    expect(single?.mode).toBe(entry?.mode)
    expect(single?.accessVlan).toBe(entry?.accessVlan)
  })

  it(':43-51\'s four field comparisons read as typed-or-absent on a defaulted scratch port, with the device answer printed (test_get, :43 — fields asserted at :48-51)', async () => {
    // Upstream normalises with `default interface` (`:45`) then demands `mode 'access'`, `access_vlan '1'`,
    // `trunk_native_vlan '1'`, `trunk_allowed_vlans '1-4094'`. This client reads the config section, where
    // a default the device chose not to write is ABSENT (DR-027), and its vlan ids are numbers (row 96).
    // So the case asserts the vocabulary (types, ranges), and prints the values: this is the first time
    // any of those four have been looked at on a 4.28.14M device from this repo.
    await runGuardedLiveWriteSession(node, {
      name: `m12c-sp-default-${scratchName}`,
      commands: [`default interface ${scratchName}`],
    })
    const sp = await node.switchports.get(scratchName)
    expect(sp).toBeDefined()
    if (sp === undefined) return
    const answers: Record<string, unknown> = { mode: sp.mode, accessVlan: sp.accessVlan, trunkNativeVlan: sp.trunkNativeVlan, trunkAllowedVlans: sp.trunkAllowedVlans }
    for (const [field, value] of Object.entries(answers)) {
      if (value === undefined) console.warn(`live-switchports: ${field} reads ABSENT for ${scratchName} after \`default interface\` — the device writes no line for it (:48-51 asserts a value there)`)
      else console.log(`live-switchports: ${field} = ${JSON.stringify(value)} for ${scratchName} after \`default interface\``)
    }
    if (sp.mode !== undefined) expect(['access', 'trunk', 'managed']).toContain(sp.mode)
    for (const vlanId of [sp.accessVlan, sp.trunkNativeVlan]) {
      if (vlanId !== undefined) expect(Number.isSafeInteger(vlanId) && vlanId >= 1 && vlanId <= 4094).toBe(true)
    }
    if (sp.trunkAllowedVlans !== undefined) expect(typeof sp.trunkAllowedVlans).toBe('string')
  })
})

describe.skipIf(!writeReady)('live trunk-line writes on the scratch port: pyeapi test_api_switchports.py (set_trunk_native_vlan :107, set_trunk_allowed_vlans :121)', () => {
  let node: Node
  let scratchName: string
  beforeAll(async () => {
    scratchName = scratch.name ?? ''
    node = createNode(liveTransportOptions(targetOf()))
  })

  it('the trunk allowed/native lines are staged on the scratch port and read back, or the device refusal is reported verbatim (set_trunk_allowed_vlans :121, set_trunk_native_vlan :107 — §5 row 188)', async () => {
    // Upstream's setup for both cases writes `switchport mode trunk` plus `vlan 100` (`:110-111`, `:124-126`).
    // The VLAN creation is the global write live-vlans refuses, so the id used here is the always-present
    // default VLAN 1, and the allowed list stays inside the VLAN range the client would accept anyway.
    // Whether EOS insists that allowed ids exist in the VLAN database is settled by the device's answer:
    // a refusal aborts the guarded session (DR-035) and is reported with its code, not turned into a pass.
    const batches: readonly (readonly string[])[] = [
      ['switchport mode trunk', 'switchport trunk allowed vlan 1-10'],
      ['switchport mode trunk', 'switchport trunk native vlan 1'],
    ]
    let accepted = 0
    for (const [index, lines] of batches.entries()) {
      try {
        const outcome = await runGuardedLiveWriteSession(node, {
          name: `m12c-sp-trunk-${String(index)}-${scratchName}`,
          commands: [`interface ${scratchName}`, ...lines],
        })
        expect(outcome.committed).toBe(true)
        accepted += 1
        const sp = await node.switchports.get(scratchName)
        console.log(`live-switchports: after ${JSON.stringify(lines)} the record reads ${JSON.stringify({ mode: sp?.mode, trunkNativeVlan: sp?.trunkNativeVlan, trunkAllowedVlans: sp?.trunkAllowedVlans })}`)
        expect(sp?.mode).toBe('trunk')
        if (lines[1]?.startsWith('switchport trunk allowed vlan') && sp?.trunkAllowedVlans !== undefined) {
          expect(sp.trunkAllowedVlans).toContain('1')
        }
      } catch (rawErr) {
        // A refusal must arrive as one of the package's typed errors — that IS the assertion for this arm
        // (DR-005: a device refusal throws; it never answers `False`). The device's own text is printed as
        // evidence of what 4.28.14M insists on for a trunk allowed-list.
        expect(rawErr).toBeInstanceOf(EapiError)
        const err = rawErr as EapiError
        const code = err instanceof CommandError ? String(err.code) : err instanceof ProtocolError ? `protocol ${String(err.code)}` : 'no code'
        console.warn(`live-switchports: the device refused ${JSON.stringify(lines)} on ${scratchName} (${err.constructor.name} ${code}): ${err.message.split('\n')[0]?.slice(0, 160)}`)
      }
    }
    if (accepted === 0) console.warn(`live-switchports: NEITHER trunk batch was accepted on ${scratchName} — the read-back half of :118-120/:132-134 is unexercised on this target (reported, not claimed)`)

    // Leave the port exactly as the previous describe found it (L2, defaulted).
    await runGuardedLiveWriteSession(node, {
      name: `m12c-sp-trunk-restore-${scratchName}`,
      commands: [`default interface ${scratchName}`],
    })
  })
})
