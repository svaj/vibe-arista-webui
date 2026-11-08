/**
 * `*.live.test.ts` port of `pyeapi/test/system/test_api_mlag.py` @ `6816d9e` — #14 **D2**, the
 * **read-only half** of the full-write lane (DR-126). Upstream has **21** methods (`:43`–`:236`); this file
 * ports the state READ (`test_get`, `:43`) and **refuses the other 20 on policy**, not on capability.
 *
 * ## The single-node rule — why no `mlag` write runs here, even with `EAPI_LAB_FULL_WRITE=1`
 * An MLAG domain is a **two-switch** construct: a domain id, a `local-interface` SVI, a `peer-link` and a
 * `peer-address` describe one half of a pair that does not exist in this lab. The harness states the rule at
 * the provisioning layer — *"the MLAG domain stays OFF on a single node (#64/#84's foot-gun rule)"*
 * (`scripts/ceos-lab.mjs:1102`) — and DR-122 repeats it for the staged lab config
 * (`arista-api-client/docs/DECISIONS.md:1908`), while `docs/CEOS.md:211` parks the question for a future
 * two-node lab ("*they still do not validate physical-switch forwarding or platform support*"). Staging
 * `mlag configuration` from a test would (a) contradict the container's declared shape, which every #62
 * capture and every fixture read in this repo was taken against, and (b) write a peer address/link that can
 * put the single node's control plane into a half-configured MLAG state for the *next* suite in the same
 * container. The `mlag.ts` module header already declares the same position for this milestone — those 21
 * system methods "*are **not ported and cannot be** by this lane, which is stated as a skip rather than
 * faked*" (`src/resources/mlag.ts:47-50`, and `src/resources/mlag.test.ts:19-22`). This file is where that
 * decision becomes executable evidence instead of a comment: the read runs, the writes stay ledgered.
 *
 * That is a *narrower* refusal than the rest of D2 deliberately has: `liveFullWriteReadiness` is still the
 * gate (this file lives in the same lane and is run by the same runner), but nothing in it stages config,
 * so a consent-flagged run executes exactly one read path plus one optional `show` read.
 *
 * ## What the read is actually asserting
 * `MlagResource.get()` is a **config-text** read — `mlag configuration` plus every `interface Po…` section
 * — never `show mlag` JSON (`src/resources/mlag.ts:16-26`, DR-101). On a node with no MLAG domain upstream's
 * `get()` **crashes**: `get_block` answers `None` and `_parse_domain_id`'s `re.search(r'domain-id (.+)$',
 * None)` raises `TypeError` (`mlag.py:99`/`:119`, recorded as `mlag.ts` divergence 1, and the code marker is
 * at `src/resources/mlag.ts:291`). The behaviour under test is therefore precisely that asymmetry: this
 * client answers a **record** whose every field is absent (`shutdown` included — divergence 3's derivation
 * cannot fire without a section, so it is *not* invented as `false`), and its interface half is an empty
 * keyed `Map`. The captured container backs the shape: `test/fixtures/live/ceos-4.28.14M/show-running-config.json`
 * contains **zero** `mlag` occurrences, and the sibling `show-mlag.json` answers `state: "disabled"` with
 * empty `localInterface`/`peerLink` — container evidence only (`hardwareEvidence: none`, DR-043).
 *
 * | upstream (verified line @6816d9e) | ported? | here / why |
 * |---|---|---|
 * | `test_get` (`:43`, normalising stage `:45-46`, `get()` `:47`, expected dict `:48-50`, `assertEqual` `:51`) | ✅ (**read half only**) | upstream first writes `no interface Port-Channel1-2000` and `default mlag configuration` (`:45-46`) to force the all-`None` answer, then demands that answer. The write is exactly what the single-node rule forbids, and it is also unnecessary here: this lab never configures MLAG, so the not-configured shape is already the device's own answer (`show-running-config.json` has no `mlag` section). Ported as `node.mlag.get()` shape evidence — `config` answers with **no** keys and no invented `shutdown`, `interfaces` is a keyed `Map` whose keys can only be the chunker's `interface Po…` headers (the `Po` filter is upstream's own, `mlag.py:186`, kept by divergence 4) — plus the fact that no `TypeError` reaches the caller, which is divergence 1 live. If the section is ever present, the case prints the leak and stops claiming the empty half instead of flexing the assertion |
 * | `test_set_domain_id_with_value` (`:53`), `_with_no_value` (`:63`), `_with_default` (`:72`) | ❌ refused (single-node) | each stages `default mlag configuration` (`:55`) or `mlag configuration` + `domain-id test` (`:65`, `:74`) through `dut.config`, then writes `domain-id …` and greps the block text (`:61`, `:70`, `:79`). Refused by `scripts/ceos-lab.mjs:1102` / DR-122 (`DECISIONS.md:1908`): a domain id is half of a pair. The command texts (`domain-id X` / `no domain-id` / `default domain-id`, `mlag.py:200-211`) stay pinned offline (`src/resources/mlag.test.ts`) |
 * | `test_set_local_interface_with_value` (`:81`), `_with_no_value` (`:90`), `_with_default` (`:99`) | ❌ refused (single-node) | these also create an SVI (`interface Vlan1234` in the stage at `:92`, `:101`) — a Vlan SVI is not `EAPI_SCRATCH_INTERFACE` (`requireScratchInterface` refuses non-`Ethernet`, `live-guard.ts:609-611`) and `Vlan1234` is not the declared spare VLAN |
 * | `test_set_peer_address_with_value` (`:108`), `_with_no_value` (`:117`), `_with_default` (`:129`) | ❌ refused (single-node) | a `peer-address` names a peer that does not exist in this lab; `:119-120`/`:131-132` additionally stage `interface Vlan1234` with `ip address 1.2.3.1/24`, i.e. an unowned SVI + L3 address |
 * | `test_set_peer_link_with_value` (`:141`), `_with_value_portchannel` (`:151`), `_with_no_value` (`:161`), `_with_default` (`:170`) | ❌ refused (single-node) | `set_peer_link('Ethernet1')` (`:146`) targets the port `lab-provision` owns (#62, DR-122), and the Port-Channel arm creates `interface Port-Channel5` (`:154`) whose memberless bundle the harness's own Po1 topology does not expect |
 * | `test_set_shutdown_with_true` (`:180`), `_with_false` (`:189`), `_with_no_value` (`:198`), `_with_default` (`:207`) | ❌ refused (single-node) | `set_shutdown(True/False/disable/default)` inside `mlag configuration` (`:182-187`, `:191-196`, `:200-205`, `:209-214`) — the block only exists once a domain is configured, so these are domain writes by another name. (`mlag.ts`'s own `shutdown` derivation, divergence 3, is offline-pinned.) |
 * | `test_set_mlag_id_with_value` (`:216`), `_with_no_value` (`:225`), `_with_default` (`:236`) | ❌ refused (single-node) | the per-interface arms create/destroy `interface Port-Channel10` (`:218`, `:227-228`, `:238-239`) and write `mlag 100` inside it (`:223`, `:234`, `:245`). A Port-Channel is not a scratch interface (`requireScratchInterface`'s `Ethernet…` rule), and `mlag <id>` ties the bundle to the refused domain |
 *
 * Upstream's `assertTrue(result)` idiom is pyeapi's `configure` returning `True`/`False`
 * (`abstract.py:117-127`); this client has no `False` (DR-005) — a refused write is a thrown `CommandError`
 * with the failing command attached. Since no write is issued here, that difference is ledgered rather than
 * exercised, and `src/resources/mlag.test.ts` pins the throwing arms offline.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { EapiError } from './errors'
import { buildFullWriteNode, liveFullWriteReadiness } from './testing/live-full-write'
import { describeLiveTarget, matchesDeviceIdentity, unwrapLiveTarget } from './testing/live-guard'
import type { Node } from './command-layer'

const SUITE = 'live-mlag'

const gate = liveFullWriteReadiness(process.env)
if (!gate.runnable) {
  console.warn(`${SUITE}: SKIPPED (DR-034/DR-126) — ${gate.skipReason ?? 'gate refused the run'}`)
}

function firstLine(message: string): string {
  return message.split('\n')[0]?.slice(0, 200) ?? message
}

describe.skipIf(!gate.runnable)('live read-only: pyeapi test_api_mlag.py (test_get, :43 — reads only, single-node rule)', () => {
  let node: Node

  beforeAll(async () => {
    const target = unwrapLiveTarget(gate.resolution)
    console.log(`${SUITE}: target = ${describeLiveTarget(target)}`)
    node = buildFullWriteNode(target)
    const reported = await node.getVersion()
    const mismatch = matchesDeviceIdentity(target, { version: reported.version, modelName: reported.modelName })
    // Tolerate only the suffix-driven EAPI_VERSION_MISMATCH (the cEOS `version` field carries an
    // engineering-build suffix the base pin cannot exactly match); the probe enforces base identity (DR-066).
    if (mismatch !== undefined && mismatch.code !== 'EAPI_VERSION_MISMATCH') {
      throw new Error(`${SUITE} readiness: ${mismatch.reason}`)
    }
    if (mismatch?.code === 'EAPI_VERSION_MISMATCH') {
      console.warn(`${SUITE}: reported version "${reported.version}" vs pin "${target.allowVersion}" (base-level enforced by the probe, DR-066)`)
    }
  })

  it('mlag.get() answers a typed not-configured record on a single node where pyeapi raises TypeError (test_get, :43 — :47-51, read half)', async () => {
    // Upstream writes `no interface Port-Channel1-2000` + `default mlag configuration` (:45-46) to manufacture
    // the all-None answer, then asserts that answer (:48-51). Neither half is reproduced: the write is the
    // single-node refusal (header), and the shape is already the device's own — the lab container is not
    // provisioned with an MLAG domain (scripts/ceos-lab.mjs:1102, DR-122).
    const state = await node.mlag.get()
    // Upstream's crash is the thing being disproved: `get_block` answers None and its `re.search` raises
    // TypeError (mlag.py:119, mlag.ts divergence 1). Reaching this line at all is the port's first claim.
    expect(state).toBeDefined()
    expect(typeof state.config).toBe('object')
    expect(typeof state.interfaces.has).toBe('function')

    const fields = Object.keys(state.config)
    if (fields.length === 0) {
      // Divergences 1 and 3, live: no section → every field absent, and `shutdown` is NOT invented as false.
      expect(state.config.domainId).toBeUndefined()
      expect(state.config.localInterface).toBeUndefined()
      expect(state.config.peerAddress).toBeUndefined()
      expect(state.config.peerLink).toBeUndefined()
      expect(state.config.shutdown).toBeUndefined()
      console.log(`${SUITE}: the container answers no \`mlag configuration\` section — config={} (upstream raises TypeError here, mlag.py:119), interfaces=${String(state.interfaces.size)}`)
    } else {
      console.warn(`${SUITE}: an \`mlag configuration\` section IS present (${JSON.stringify(state.config)}) — the not-configured half of :48-51 is NOT claimed. This suite never stages MLAG config, so that section leaked from another run; the single-node rule (scripts/ceos-lab.mjs:1102) says the lab owner should re-bootstrap`)
      expect([true, false, undefined]).toContain(state.config.shutdown)
    }

    // Divergence 4, live: the interface rows come from the chunker's section keys, so a name can only be an
    // actual `interface Po…` header (upstream's `^interface (Po.+)$`, mlag.py:186) and its id is digits.
    for (const [name, entry] of state.interfaces) {
      expect(entry.name).toBe(name)
      expect(name).toMatch(/^Po/u)
      expect(/^\d+$/u.test(entry.mlagId)).toBe(true)
    }
    // Upstream also demands `interfaces == {}` (:50). Empty is expected on this lab but is the device's to
    // decide, so the count is printed rather than asserted — a Po section belonging to another suite must
    // not turn this read into a false failure (DR-043's "report, do not invent").
    console.log(`${SUITE}: mlag interface rows = ${JSON.stringify([...state.interfaces.keys()])} (upstream asserts an empty dict at :50)`)
  })

  it('the config-text read stays separate from `show mlag` state: the JSON contract is still M12-owned (test_get shape cross-check, :47 — mlag.ts:16-26, DR-101)', async () => {
    // This module reads config text, never `show mlag` (mlag.ts:16-26), and the JSON has no contract yet —
    // `ShowReply<'show mlag'>` is `unknown` (src/types/eapi.test.ts:107). The case therefore RECORDS the
    // device's own state text, asserts nothing about its wording, and proves the refusal class is typed
    // rather than a crash. That is the boundary DR-101 pins: config reads are ours, state reads are M12's.
    try {
      const shown = await node.showText('show mlag')
      console.log(`${SUITE}: \`show mlag\` text → ${JSON.stringify(shown.trim().split('\n').slice(0, 6))} (no assertion: the JSON/state contract is an M12 #14 question, mlag.ts:24-26)`)
    } catch (rawErr) {
      if (!(rawErr instanceof EapiError)) throw rawErr
      console.warn(`${SUITE}: \`show mlag\` refused on this target (${rawErr.constructor.name}): ${firstLine(rawErr.message)} — recorded as a capability answer; the typed config read above does not depend on it`)
    }
  })
})
