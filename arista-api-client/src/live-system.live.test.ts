/**
 * `*.live.test.ts` port of `pyeapi/test/system/test_api_system.py` @ `6816d9e` — M12a (#14), a
 * read-mostly live suite. Follows `live-wiring.live.test.ts` as the exemplar and `src/testing/live-guard.ts`
 * as the ONLY gate.
 *
 * ## Loud skip (DR-034), then the upstream ledger
 * With `EAPI_LIVE!=1` or an incomplete lab env this file prints the guard's refusal reason and skips every
 * case — `npm run test:live` green still means "no device ran", and it never affects offline `npm test`
 * (the `unit` project excludes `*.live.test.ts`). The guard reads `process.env` once at module load, before
 * any `describe`; `unwrapLiveTarget` is only called inside `it`/`beforeAll` bodies, which do not execute
 * under `describe.skipIf`, so a misconfigured run cannot crash during collection.
 *
 * | upstream (verified line @6816d9e) | ported? | here / why |
 * |---|---|---|
 * | `test_get` (`:44`) | ✅ shape | `node.system.get()` returns the typed record ({hostname, ipRouting, banner}); assertion is on **keys/types**, not the dynamic upstream value — the container's hostname/`ip routing` are whatever the lab booted |
 * | `test_get_with_period` (`:52`), `test_get_check_hostname` (`:58`) | ❌ skipped | each writes a **global** hostname (`hostname host.domain.net` / `hostname teststring`, `:53`/`:59`) then reads it back. A global hostname mutation is outside `EAPI_SCRATCH_INTERFACE` (DR-035(b), `docs/CEOS.md:131`) and is not an interface a per-run scratch port can roll back — the helper's `abort` cannot undo renaming the DUT without risking the endpoint we are connected through. Read-only value comparison stays a fixture question, not a live write |
 * | `test_get_check_banners` (`:64`), `test_get_banner_with_EOF` (`:74`) | ❌ skipped | configure MOTD/login banners (`dut.config([dict(cmd="banner motd", input=…)])`, `:68-69`/`:77`) — again a whole-config write, not a scratch-port field; the banner round-trip is already covered offline by `resources/system.test.ts` against the EOF chunker. A live banner write would leave banner text on the switch that the scratch-session rollback does not scope |
 * | the 15 `test_set_*` cases (`:81`–`:217`) | ❌ skipped | hostname / `ip routing` / banner setters — all global-config mutations, none an `Ethernet…` scratch write, so forbidden for this suite by DR-035. Their command lists and refusals are pinned offline in `system.test.ts` |
 *
 * The `read`-side here is deliberately the *typed record*, not pyeapi's snake_case dict: `test_get`'s
 * `self.assertEqual(sorted(keys), …)` (`:49`) is against `['hostname','iprouting','banner_motd','banner_login']`
 * — the snake_case names MIGRATION.md §4 replaces, so the port asserts the shape of `SystemSettings`, which
 * is the honest current contract (DR-003/row 90), not the upstream one.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { createNode } from './node'
import { resolveLiveEnv, unwrapLiveTarget, liveTransportOptions, matchesDeviceIdentity, describeLiveTarget } from './testing/live-guard'
import type { Node } from './command-layer'

const resolution = resolveLiveEnv(process.env)
if (!resolution.ok) {
  console.warn(`live-system: SKIPPED (DR-034) — ${resolution.reason}`)
}
const ready = resolution.ok

describe.skipIf(!ready)('live read-mostly: pyeapi test_api_system.py (test_get, :44)', () => {
  let node: Node

  beforeAll(async () => {
    const target = unwrapLiveTarget(resolution)
    console.log(`live-system: target = ${describeLiveTarget(target)}`)
    node = createNode(liveTransportOptions(target))
    // Readiness/identity gate (docs/CEOS.md:113/128-129): the device must say what the guard required,
    // before any read below is interpreted as "the software does X".
    const reported = await node.getVersion()
    const mismatch = matchesDeviceIdentity(target, { version: reported.version, modelName: reported.modelName })
    if (mismatch !== undefined) throw new Error(`live-system readiness: ${mismatch.reason}`)
  })

  it('system.get() answers the typed record, not pyeapi\'s snake_case dict (shape-level)', async () => {
    const settings = await node.system.get()
    // Keys the record always has (upstream `test_get`, :44-50, proves the same field set exists — under the
    // old names). Types, never values: hostname/ipRouting/banner are lab-dependent on a running target.
    expect(typeof settings.hostname).toBe('string')
    expect(typeof settings.ipRouting).toBe('boolean')
    expect(settings.banner).toBeTypeOf('object')
    // DR-027 vocabulary: a configured switch reports a non-empty hostname; the fallback is `''`, never pyeapi's
    // invented 'localhost' (system.ts divergence 1). We do not hard-assert non-empty (a bare lab default may be
    // empty), only that the field round-trips as a string the reader produced.
    expect(settings.hostname).not.toBe('localhost')
  })
})
