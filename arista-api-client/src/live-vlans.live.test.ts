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
 * | `test_create_and_return_true` (`:60`), `_return_false` (`:69`) | ❌ skipped | creates a **random** VLAN (`random_int(2,4094)`) or the invalid `5000`. There is no `EAPI_SCRATCH_VLAN` in the guard (`live-guard.ts` gates a scratch *interface* only), so creating unowned VLAN ids has no named session that DR-035's audit rule can point at, and `create('5000')` tests a client-side id guard already pinned offline (`vlans.ts`, `assertVlanId`) |
 * | `test_delete_and_return_true`/`_false` (`:74`,`:83`), `test_default` (`:88`) | ❌ skipped | `no vlan …` / `default vlan …` on arbitrary ids — same missing scratch-VLAN gate as above; and an id out of range reaches the offline `NotSupportedError` guard, not a device |
 * | `test_set_name` (`:99`), `test_set_state_*` (`:110`,`:120`), `test_set_trunk_groups*` (`:130`,`:142`,`:156`), `test_add/remove_trunk_group` (`:171`,`:182`) | ❌ skipped | every case first `dut.config(['no vlan X','vlan X', …])` to create a scratch VLAN, which is the write the previous block explains as forbidden. Trunk-group support itself is DECISIONS open item 4 (unverified on the 7050TX-64), so this suite must not answer it from a container. Command lists + refusals are pinned in `resources/vlans.test.ts` |
 *
 * Consequence: this file ports the two genuinely readable cases (`test_get`, `test_getall`) and reports the
 * other 13 as skipped for a *policy* reason (no scratch-VLAN gate under DR-035), not because the client is
 * wrong — those behaviours stay offline-verified.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { createNode } from './node'
import { resolveLiveEnv, unwrapLiveTarget, liveTransportOptions, matchesDeviceIdentity, describeLiveTarget } from './testing/live-guard'
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
    if (mismatch !== undefined) throw new Error(`live-vlans readiness: ${mismatch.reason}`)
  })

  it('vlans.get(1) answers the default VLAN as a typed record (test_get, :44 — read half)', async () => {
    const vlan = await node.vlans.get(1)
    // VLAN 1 is present on any running EOS; upstream reaches it the same way once its normalising
    // `no vlan 1`/`vlan 1` write has run (:45). We read whatever the lab already has — the write is a global
    // mutation this suite does not make.
    expect(vlan).toBeDefined()
    if (vlan === undefined) return
    expect(vlan.id).toBe(1)
    expect(['active', 'suspend']).toContain(vlan.state)
    expect(Array.isArray(vlan.trunkGroups)).toBe(true)
    if (vlan.name !== undefined) expect(typeof vlan.name).toBe('string')
  })

  it('vlans.getAll() returns a keyed table containing the default VLAN (test_getall, :52 — read half)', async () => {
    const all = await node.vlans.getAll()
    expect(typeof all.has).toBe('function') // a ReadonlyMap<number, Vlan>, not pyeapi's plain dict
    expect(all.has(1)).toBe(true)
    const vlan1 = all.get(1)
    expect(vlan1?.id).toBe(1)
  })
})
