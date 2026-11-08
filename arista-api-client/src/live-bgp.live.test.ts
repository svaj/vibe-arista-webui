/**
 * `*.live.test.ts` port of the pyeapi **BGP** suite — #14 **D2** (full-write lab lane, DR-126).
 *
 * ## Premise correction the lane brief needs (read this first)
 * There is **no `pyeapi/test/system/test_api_bgp.py` at `6816d9e`**, and there never was: `ls
 * test/system` in the pinned clone lists acl/interfaces/ipinterfaces/mlag/ntp/ospf/routemaps/staticroute/
 * stp/switchports/system/users/varp/vlans/vrfs/**vrrp** and no bgp file, and
 * `git log --all -- test/system/test_api_bgp.py` is empty. BGP's only upstream suite is
 * **`pyeapi/test/unit/test_api_bgp.py`** (405 lines, `EapiConfigUnitTest` — fixture-driven command-list
 * pins, `TestApiBgp` at `:44`, `TestApiBgpNeighbor` at `:179`), i.e. a corpus that never reached a device.
 * So this file ports that 22-method corpus (Citations below are all `test/unit/test_api_bgp.py` @
 * `6816d9e`, verified by `grep -n`/`awk` over the `def` lines) into **device round-trip form**: where
 * upstream compares the composed command text against a fixture, here the composition is sent to cEOS
 * 4.28.14M and the assertion moves to what the device answers. That is a substitution, not an upstream
 * 1:1, and every row says which.
 *
 * Second brief detail that does not survive the check: **`api/bgp.py` at `6816d9e` has no `local_as` verb
 * at all** (`grep -n local_as pyeapi/api/bgp.py` → no match), and neither does `src/resources/bgp.ts`. So
 * the "pyeapi's `set_local_as` changes the GLOBAL router" hazard named in the brief cannot arise from this
 * surface. What CAN persist across the live suite order is `router bgp <asn>` itself: every case here
 * provisions the same fresh local AS (65199) and negates the whole process inside the case, the
 * describe's `afterAll` negates it again, and any batch that stages protocol-level lines outside a facade
 * verb runs in a named `live-bgp-<arm>` session via `runGuardedLiveWriteSession` (DR-035/DR-126).
 *
 * ## Gate/fence (DR-126, same shape as live-ospf/live-routemaps)
 * `liveFullWriteReadiness(process.env)` + `describe.skipIf(!gate.runnable)` (loud skip when the env is
 * unset, which is what `npx vitest run` exercises); `buildFullWriteNode(target)` so `withLabWriteScope`
 * refuses listener/user/management-path/persistence lines before the wire for facade writes and session
 * batches alike; identity check tolerates only `EAPI_VERSION_MISMATCH` (DR-066). Every case starts by
 * clearing any leftover `router bgp …` ({@link clearBgp}) and ends by negating it in `finally`.
 * `bgpAs` stays a `number | string` per pyeapi's own split (§5 row 198's family, bgp.ts divergence 2), and
 * the entity/neighbour opener split (divergence 3) is left intact — a fact the neighbour cases rely on,
 * since their batches open `router bgp 65199` from the digits, not from a header remainder.
 *
 * | upstream (verified line @6816d9e; unit corpus) | ported? | here / why |
 * |---|---|---|
 * | `TestApiBgp.test_get` (`:51-56`) | ✅ (device form) | upstream asserts the record's SEVEN keys against a fixture (`:52-54`: `bgp_as`, `router_id`, `maximum_paths`, `maximum_ecmp_paths`, `shutdown`, `neighbors`, `networks`). Here the same seven field slots are checked on `BgpState` after a real provisioning batch, with the two documented vocab differences: the max-paths pair is a PAIR that is ABSENT-both for a bare `maximum-paths` line (divergence 4 — pyeapi always carries the keys with `None`, `bgp.py:93-94`), and `networks`/`neighbors` are arrays/Maps, not dicts (row 78). The neighbour map also proves DR-030's one-read record: `get()` carries `neighbors` without a second round trip |
 * | `test_create` (`:57-61`) | ✅ one arm live | upstream loops BOTH spellings (`['65000', 65000]`, `:58`) and pins the composed text (`:60`). Two live creates would be two `router bgp` processes for the rest of the lane, so the live run uses the numeric arm on a fresh AS and the string arm stays an offline pin (`resources/bgp.test.ts` ports `:57-61` verbatim). Read-back: the indent-0 header `router bgp 65199` exists |
 * | `test_create_invalid_as` (`:63-66`) | ✅, refusal class differs | `for bgpas in ['66000', 66000]` inside `assertRaises(ValueError)` (`:64-66`). Here both spellings reject with `NotSupportedError` before any request (DR-005/DR-010; the 1..65535 bound is `assertBgpAsInput`, kept per DR-032 — 4-byte AS is a device question, not a bound this client lifts). Nothing is written, which the header scan proves |
 * | `test_delete` (`:68-72`) | ✅ | upstream pins `no router bgp 65000` (`:70`) against the fixture AS. Here a real process is created and {@link BgpResource.delete} — which negates with the AS **as read**, header remainder and all (divergence 2) — leaves no `router bgp …` header behind |
 * | `test_default` (`:73-77`) | ✅ | `default router bgp 65000` (`:75`) becomes a live `setDefault()`, and the finding is what 4.28.14M does with it: the case prints the header scan afterwards and asserts the process is gone, which is what the framework's `default`-as-negation reading implies and no offline pin can confirm |
 * | `test_add_network` (`:78-87`) | ✅ | upstream stages `network 172.16.10.1/24 route-map test` (`:79-81`) and pins the two `ValueError` empty-argument arms (`:83-87`). Live: the route-map is one THIS file owns and stages (`LIVEBGPNET`, since EOS may insist the map exist), the arm that tests an out-of-range prefix length is a client guard not a device write, and `networks` must answer `{prefix, masklen, routeMap}`. The empty-argument arms reject with `NotSupportedError` at zero round trips (the same guard pair, `bgp.ts:669-674`) |
 * | `test_remove_network` (`:89-99`) | ✅ | `no network 172.16.10.1/24 route-map test` (`:90-92`) — the negation KEEPS the route-map arm, unlike ospf's bare `no redistribute` (bgp.ts's note, contrasted with ospf.ts divergence 10). Live answer captured: after the negation the network entry is gone, and the raw clause body is printed so a device that left the line (because the stored text differs from the composed one) is visible rather than silently asserted away |
 * | `test_set_router_id` (`:100-122`) | ✅, arms renamed | upstream's three-state loop (`:101-112`) plus the commented-out "uncomment if command_builder fails" arm (`:117-119`) that reaches `no router-id` through the deprecated falsy fall-through. Here the trio is `setRouterId`/`unsetRouterId`/`defaultRouterId` (DR-037) with a read-back after each, and the fall-through is a refusal — command-builder.ts already cites `test_api_bgp.py:117` as exhibit A, so this case records the DEVICE's text for `default router-id` instead |
 * | `test_maximum_paths_just_max_path` (`:123-145`) | ✅, and this is the divergence-4 capture | upstream pins the single-value text `maximum-paths 20` (`:127`) plus the negate/default arms (`:130`/`:133`) and again the falsy fall-through (`:142-144`). Live: after `setMaximumPaths(20)` the printed `router bgp` body shows what EOS really stores (does it render a bare `maximum-paths 20`, or normalise to `maximum-paths 20 ecmp 20`?), and the typed read is compared against this client's rule — the pair regex needs the ecmp tail (`bgp.py:91`), so a bare line reads NOTHING (divergence 4). The assertion allows either device answer and prints it (INFORMATION), because the client-side claim is about the parser, not about the image |
 * | `test_maximum_paths_max_path_and_ecmp` (`:146-164`) | ✅ | `maximum-paths 20 ecmp 20` (`:151`) → live `setMaximumPaths(20, 4)` must read BOTH fields ({@link BgpState.maximumPaths}/{@link BgpState.maximumEcmpPaths}); the guard arm at `:161-163` (`eapi_exception_config_test(func, TypeError)`, ecmp without max) rejects with `NotSupportedError` carrying upstream's own message (`bgp.ts:550-553`) at zero writes |
 * | `test_set_shutdown` (`:165-176`) | ✅, inverted default noted | upstream needs `set_shutdown(default=False, disable=False)` to compose the bare `shutdown` (`:168-169`) because its parameter defaults are `disable=True` (`bgp.py:154`) — so a no-argument call is `no shutdown`, and {@link BgpResource.shutdown}/{@link noShutdown}/{@link defaultShutdown} split those intents by name (bgp.ts's table row). Live: each arm's read (`shutdown === true`/`false`) plus the printed body, which also answers bgp.ts divergence 5's open question ("whether 4.28 writes a bare `shutdown` under a `router bgp`") |
 * | `TestApiBgpNeighbor.test_getall` (`:186-190`) | ✅ (count conditional) | upstream asserts a dict with exactly THREE names from the fixture (`:189` — `test`, `test1`, `172.16.10.1`, two of them group-shaped). Here the beforeAll stages two address-named neighbours plus one peer-group declaration, and `getAll()` is asserted to key both neighbours (device order, one pass over body lines — §5 row 200's line-anchored keys, divergence 7). The three-name count is only claimable if 4.28.14M accepts `neighbor <WORD> peer group`, which is the same open question the peer-group row below answers, so the size is printed rather than demanded |
 * | `TestApiBgpNeighbor.test_get` (`:191-197`) | ✅, absence differs | upstream's `get('test')` answers all nine keys for ANY name, even one the router never mentioned (`bgp.py:184-196` has no existence check — divergence 1). Here `get(N1)` answers the record with the fields the device set, and `get('LIVEBGP-GHOST')` — a name nothing declared — is `undefined` (or, if the staging batch itself was refused, that absence half is still asserted and the record half reports itself unexercised). The nine-key vocabulary (`:193-195`) maps to {@link BgpNeighbor}'s fields; the three booleans are never absent, the six values are absent-not-`None` |
 * | `test_delete` (`:198-202`) | ✅, with the retry visible | upstream pins `['router bgp 65000', 'no neighbor test']` (`:199`). Here {@link BgpNeighborsResource.delete} runs against a real neighbour, and if the device refuses the bare negation the client's **retry** with the group keyword fires (bgp.ts divergence 11, pyeapi `bgp.py:265-275`): the case reports whether the first attempt threw and then asserts absence, so the retry path is measured instead of assumed |
 * | `test_set_peer_group` (`:203-228`) | ✅ (arm-by-arm) + one refusal | upstream's loop composes `neighbor 172.16.10.1 peer-group <g>` / `no …peer-group` / `default …peer-group` (`:205-227`) — the LEGACY spelling because its fake node lies about the version (`test/lib/testlib.py:75`, §5 row 201). Live on 4.28.14M the spelling comes from the device's own text ({@link detectPeerGroupForm}, DR-107), so the case asserts membership read-back (`peerGroup`, and the recorded `peerGroupForm`) rather than a pinned keyword. The gate's other half is asserted as a refusal: `setPeerGroup(GROUP, …)` on a group-shaped name upstream answers a **silent False** (`bgp.py:290-298`) and here rejects `NotSupportedError` (divergence 12, §5 row 202) with zero writes |
 * | `test_set_remote_as` (`:229-253`) | ✅ | upstream passes the STRING `'65000'` for the group-shaped name `test` (`:231-233`) — no `ispeergroup` gate on this verb, kept (bgp.ts's note). Live: `setRemoteAs(GROUP, '65200')` reads back as `remoteAs === '65200'` (the reader keeps the `.*` remainder), then `unsetRemoteAs`/`defaultRemoteAs` are attempted and the device's answer printed |
 * | `test_set_shutdown` (`:254-272`) | ✅, including divergence 10's honest reading | upstream's four-state loop (`:255`) reaches the bare `neighbor test shutdown` only via `set_shutdown(default=False, disable=False)` (`:258-261`). Here that text IS {@link BgpNeighborsResource.create} — pyeapi literally calls `set_shutdown(name, default=False, disable=False)` (`bgp.py:262-264`), so `create` MENTIONS the neighbour and sets it administratively DOWN (divergence 10, **DR-109**: kept, flagged, not "fixed"). The case then uses `unsetShutdown` (upstream's zero-argument default, `bgp.py:303`) as the bring-up and asserts the boolean both ways; the `'false'` state at `:255` is upstream's duplicate negation arm, which here needs no separate verb |
 * | `test_set_send_community` (`:273-298`) | ✅ | `neighbor test send-community` (`:278`) etc.; the falsy fall-through arm again (`:295-296`) is the named `unsetSendCommunity` here. Live: `setSendCommunity(N1)` → `sendCommunity === true`, `unsetSendCommunity(N1)` → `false` — the boolean reads derive from the negated line, so this also pins bgp.ts divergence 7's polarity on a real device |
 * | `test_set_next_hop_self` (`:299-324`) | ✅ | same pair on `next-hop-self` (`:304`), asserted through the boolean field |
 * | `test_set_route_map_in` (`:325-350`) | ✅ | `route_map = 'TEST_RM'` (`:327`) composed as `neighbor test route-map TEST_RM in` (`:331`) — the `' in'` suffix rides AFTER the builder, so even the negated arms read `no neighbor test route-map in` (bgp.ts's table row, `bgp.py:323-327`). Live: a route-map this file stages (`LIVEBGPIN`), then `setRouteMapIn(N1, 'LIVEBGPIN')` → `routeMapIn`, then `unsetRouteMapIn` → absent, with the body printed so the suffixed negation's fate on 4.28.14M is on the record |
 * | `test_set_route_map_out` (`:351-376`) | ✅ | the `out` twin (`:353-357`) with `LIVEBGPOUT` |
 * | `test_set_description` (`:377-391`) | ✅ | `value = 'this is a test'` (`:379`) with the spaced text the `.*` reader takes whole (`bgp.py:232-237`). Live: `setDescription(N1, 'this is a live-lane test')` must round-trip verbatim, which also exercises the §5-row-200 phrase hazard in the honest direction — a description the device itself wrote must be read as the description, not as somebody else's field |
 *
 * Not ported (nothing to port): `TestApiBgp.__init__` (`:46-50`) and `TestApiBgpNeighbor.__init__`
 * (`:181-185`, which constructs `BgpNeighbors(None)` — a sub-collection with no node at all, which this
 * framework cannot and should not reproduce: `node.bgp.neighbors` is the registry-parented child, DR-052).
 *
 * ## Verb gaps found while porting (for a shared decision, NOT invented around here)
 * 1. **`bgp.ts` cannot DECLARE a peer group.** pyeapi has no such verb either (`bgp.py:288-298` only
 *    assigns membership), and EOS needs the group to exist before a neighbour can join it. The neighbour
 *    describe therefore stages `neighbor LIVEBGPGRP peer group` through
 *    {@link runGuardedLiveWriteSession} — a raw device-grammar line behind the named-session +
 *    {@link withLabWriteScope} fence — rather than adding a client verb nobody decided on. If the reviewer
 *    wants that line modelled, it belongs in `bgp.ts` as a decided API surface, not in a live test.
 * 2. **`bgp.ts` has no neighbour-address validation beyond the name guard**, so `10.108.0.1` (a TEST-NET-ish
 *    lab-only address, not routable anywhere in this lab) is used purely as config text. Whether cEOS
 *    insists a neighbour be reachable/permit the ASN pair is the device's answer, reported per arm.
 * 3. `node.bgp.bgpAs` never feeds an out-of-range or oversized AS anywhere: the create bound is
 *    `1..65535` (upstream's), so 4-byte AS numbers remain an uncapturable-by-this-client question — a
 *    `docs/DECISIONS.md` open item (DR-032), and this lane's fresh AS 65199 sits inside the bound.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CommandError, EapiError, NotSupportedError, ProtocolError } from './errors'
import { buildFullWriteNode, liveFullWriteReadiness } from './testing/live-full-write'
import { describeLiveTarget, matchesDeviceIdentity, unwrapLiveTarget, type LiveTarget } from './testing/live-guard'
import { runGuardedLiveWriteSession } from './testing/live-session-policy'
import type { Node } from './command-layer'

const gate = liveFullWriteReadiness(process.env)
if (!gate.runnable) {
  console.warn(`live-bgp: SKIPPED — ${gate.skipReason}`)
}

/** Fresh local AS inside pyeapi's own 1..65535 create bound; no other live suite uses it. */
const AS = 65199
const AS_HEADER = `router bgp ${String(AS)}`
const REMOTE_AS = '65200'
const N1 = '10.108.0.1'
const N2 = '10.108.0.2'
const GROUP = 'LIVEBGPGRP'
const GHOST = 'LIVEBGP-GHOST'
const RM_NET = 'LIVEBGPNET'
const RM_IN = 'LIVEBGPIN'
const RM_OUT = 'LIVEBGPOUT'
const RM_NAMES = [RM_NET, RM_IN, RM_OUT] as const

function targetOf(): LiveTarget {
  return unwrapLiveTarget(gate.resolution)
}

function reportRefusal(rawErr: unknown, what: string): string {
  if (!(rawErr instanceof EapiError)) throw rawErr
  const code = rawErr instanceof CommandError
    ? `code ${String(rawErr.code)}`
    : rawErr instanceof ProtocolError
      ? `protocol code ${String(rawErr.code)}`
      : 'no code'
  const first = rawErr.message.split('\n')[0]?.slice(0, 200) ?? rawErr.message
  console.warn(`live-bgp: the device refused ${what} (${rawErr.constructor.name}, ${code}): ${first}`)
  return first
}

async function attempt(what: string, run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run()
    return true
  } catch (rawErr) {
    reportRefusal(rawErr, what)
    return false
  }
}

/** Every indent-0 `router bgp …` header the device currently runs. */
async function bgpHeaders(node: Node): Promise<string[]> {
  const config = await node.getRunningConfig()
  const headers: string[] = []
  for (const line of config.split(/\r?\n/u)) {
    if (line.startsWith('router bgp ')) headers.push(line)
  }
  return headers
}

/** The body of one `router bgp` section, printed for the raw-line questions upstream never had to answer. */
async function bgpBody(node: Node, header: string): Promise<string[]> {
  const lines = (await node.getRunningConfig()).split(/\r?\n/u)
  const at = lines.findIndex((line) => line === header)
  if (at < 0) return []
  const body: string[] = []
  for (const line of lines.slice(at + 1)) {
    if (line !== '' && !/^\s/u.test(line)) break
    body.push(line.trim())
  }
  return body
}

/** Run-idempotence: drop every BGP process the container still has. */
async function clearBgp(node: Node, suffix: string): Promise<void> {
  const headers = await bgpHeaders(node)
  if (headers.length === 0) return
  try {
    await runGuardedLiveWriteSession(node, {
      name: `live-bgp-clear-${suffix}`.slice(0, 64),
      commands: headers.map((header) => `no ${header}`),
    })
  } catch (rawErr) {
    reportRefusal(rawErr, `clearing leftover BGP processes ${JSON.stringify(headers)}`)
  }
}

async function stageRoutemaps(node: Node, suffix: string) {
  return stageRoutemapsSeq(node, suffix)
}

// The device keeps a COMMITTED named config session as "completed" and refuses any later batch that
// re-enters the same name ("Cannot enter session <name> (already completed)", observed live 2026-11-08
// on 4.28.14M; maxSavedSessions=1). Fixture helpers must mint a fresh session name per call.
let rmSeq = 0

async function stageRoutemapsSeq(node: Node, suffix: string): Promise<void> {
  for (const name of RM_NAMES) {
    await attempt(`staging the fixture clause \`route-map ${name} permit 10\` that the network/route-map arms reference`, async () => {
      await runGuardedLiveWriteSession(node, { name: `live-bgp-rm-${suffix}-${String(++rmSeq)}`.slice(0, 64), commands: [`route-map ${name} permit 10`] })
    })
  }
}

async function clearRoutemaps(node: Node, suffix: string): Promise<void> {
  for (const name of RM_NAMES) {
    await attempt(`teardown of the fixture clause \`route-map ${name} permit 10\``, async () => {
      await runGuardedLiveWriteSession(node, { name: `live-bgp-rm-off-${suffix}-${String(++rmSeq)}`.slice(0, 64), commands: [`no route-map ${name} permit 10`] })
    })
  }
}

describe.skipIf(!gate.runnable)('live full-write: pyeapi test/unit/test_api_bgp.py — entity half (:51-180)', () => {
  let node: Node

  beforeAll(async () => {
    const target = targetOf()
    console.log(`live-bgp: target = ${describeLiveTarget(target)} (DR-126 full-write lab lane; upstream has no test/system/test_api_bgp.py @6816d9e — see the header)`)
    node = buildFullWriteNode(target)
    const reported = await node.getVersion()
    const mismatch = matchesDeviceIdentity(target, { version: reported.version, modelName: reported.modelName })
    if (mismatch !== undefined && mismatch.code !== 'EAPI_VERSION_MISMATCH') throw new Error(`live-bgp readiness: ${mismatch.reason}`)
    if (mismatch?.code === 'EAPI_VERSION_MISMATCH') console.warn(`live-bgp: reported version "${reported.version}" vs pin "${target.allowVersion}" (base-level enforced by the probe, DR-066)`)
    await clearBgp(node, 'entity-before-all')
  })

  afterAll(async () => {
    await clearBgp(node, 'entity-after-all')
    await clearRoutemaps(node, 'entity')
  })

  it('bgp.get() answers the seven field slots upstream lists at :52-54, with the pair/absence vocabulary this client uses (test_get, :51-56)', async () => {
    await clearBgp(node, 'get')
    try {
      await node.bgp.create(AS)
      await runGuardedLiveWriteSession(node, {
        // Upstream's fixture (`test/fixtures/running_config.bgp:4-16`, reduced in `bgp.test.ts`) has
        // neighbours AND two networks; this batch mirrors that shape with this lane's fresh names, so the
        // record really carries the neighbours/networks halves upstream asserts exist.
        name: 'live-bgp-get-stage',
        commands: [AS_HEADER, 'router-id 10.199.0.1', `neighbor ${N1} remote-as ${REMOTE_AS}`, `network 10.108.10.0/24`],
      })
      const state = await node.bgp.get()
      expect(state).toBeDefined()
      if (state === undefined) return
      // Evidence BEFORE the vocabulary expects (executed-run triage, 2026-11-08): 4.28.14M renders a wide
      // DEFAULT body under `router bgp` — including materialised `maximum-paths <n> ecmp <m>` lines — and
      // that body is exactly what decides the pair/absence claims below.
      const getBody = await bgpBody(node, AS_HEADER)
      console.log(`live-bgp: test_get evidence — record ${JSON.stringify({ ...state, neighbors: [...state.neighbors.keys()] })}; maximum-paths lines ${JSON.stringify(getBody.filter((line) => line.startsWith('maximum-paths')))}`)
      expect(state.bgpAs).toBe(AS) // `bgp_as`, :52 — a number, because the whole remainder is digits (divergence 2)
      expect(state.routerId).toBe('10.199.0.1') // :52
      expect(state.networks.some((n) => n.prefix === '10.108.10.0' && n.masklen === '24')).toBe(true) // :54
      expect(typeof state.shutdown).toBe('boolean') // :54
      expect(typeof state.neighbors.has).toBe('function') // :54 — carried in the SAME one-read record (DR-030)
      expect(state.neighbors.has(N1)).toBe(true)
      // divergence 4, the one vocabulary difference in this row: pyeapi always emits both max-paths keys,
      // with `None`/`None` when its pair regex misses (bgp.py:93-94). Here absence is the answer, so the
      // keys must not appear when nothing with an `ecmp` tail was staged.
      expect('maximumPaths' in state).toBe(false)
      expect('maximumEcmpPaths' in state).toBe(false)
    } finally {
      await clearBgp(node, 'get-final')
    }
  })

  it('create() puts `router bgp <asn>` on the device (test_create, :57-61 — the numeric arm live; the string arm stays an offline pin)', async () => {
    await clearBgp(node, 'create')
    try {
      await node.bgp.create(AS)
      expect(await bgpHeaders(node)).toContain(AS_HEADER)
    } finally {
      await clearBgp(node, 'create-final')
    }
  })

  it('an AS outside 1-65535 refuses before any write, both spellings (test_create_invalid_as, :63-66)', async () => {
    await clearBgp(node, 'invalid')
    await expect(node.bgp.create('66000')).rejects.toBeInstanceOf(NotSupportedError) // :64-66's '66000' ValueError arm
    await expect(node.bgp.create(66000)).rejects.toBeInstanceOf(NotSupportedError) // the 66000 arm
    expect(await bgpHeaders(node)).toEqual([]) // a guard refusal spends no request (DR-005/DR-053)
  })

  it('delete() leaves no process, negating with the AS exactly as read (test_delete, :68-72)', async () => {
    await clearBgp(node, 'delete')
    try {
      await node.bgp.create(AS)
      expect(await node.bgp.get()).toBeDefined()
      await node.bgp.delete()
      expect(await node.bgp.get()).toBeUndefined()
      expect(await bgpHeaders(node)).toEqual([])
    } finally {
      await clearBgp(node, 'delete-final')
    }
  })

  it('setDefault() shows what 4.28.14M does with `default router bgp …` (test_default, :73-77)', async () => {
    await clearBgp(node, 'default')
    try {
      await node.bgp.create(AS)
      await node.bgp.setDefault()
      const headers = await bgpHeaders(node)
      console.log(`live-bgp: after \`default ${AS_HEADER}\` the headers are ${JSON.stringify(headers)} and the typed read is ${JSON.stringify(await node.bgp.get())}`)
      expect(headers).toEqual([]) // bgp.py:128-134's port of upstream's `default`, read as a negation
    } finally {
      await clearBgp(node, 'default-final')
    }
  })

  it('addNetwork() stages a network with the route-map arm; the empty-argument arms refuse (test_add_network, :78-88)', async () => {
    await clearBgp(node, 'net-add')
    await stageRoutemaps(node, 'net-add')
    try {
      await node.bgp.create(AS)
      const accepted = await attempt(`\`network 10.108.10.0/24 route-map ${RM_NET}\` — upstream composes it against a fixture map called 'test' (:79-81) that no device ever had`, () => node.bgp.addNetwork('10.108.10.0', '24', RM_NET))
      if (!accepted) {
        await attempt('the bare `network 10.108.10.0/24`, so the network half is still measured without the route-map arm', () => node.bgp.addNetwork('10.108.10.0', '24'))
      }
      const state = await node.bgp.get()
      console.log(`live-bgp: networks answered: ${JSON.stringify(state?.networks ?? [])}`)
      expect(state?.networks.some((n) => n.prefix === '10.108.10.0' && n.masklen === '24')).toBe(true)
      // :83-86's two ValueError empty-argument arms → typed refusals with no writes (bgp.ts:669-674).
      await expect(node.bgp.addNetwork('', '24', RM_NET)).rejects.toBeInstanceOf(NotSupportedError)
      await expect(node.bgp.addNetwork('10.108.10.0', '', RM_NET)).rejects.toBeInstanceOf(NotSupportedError)
    } finally {
      await clearBgp(node, 'net-add-final')
      await clearRoutemaps(node, 'net-add')
    }
  })

  it('removeNetwork() keeps the route-map arm on the negation and the network reads back gone (test_remove_network, :89-99)', async () => {
    await clearBgp(node, 'net-remove')
    await stageRoutemaps(node, 'net-remove')
    try {
      await node.bgp.create(AS)
      await attempt(`\`network 10.108.11.0/24 route-map ${RM_NET}\` (staging)`, () => node.bgp.addNetwork('10.108.11.0', '24', RM_NET))
      await attempt(`\`no network 10.108.11.0/24 route-map ${RM_NET}\` — the negated removal KEEPS the map arm (bgp.py:172-181, bgp.ts's contrast with ospf divergence 10)`, () => node.bgp.removeNetwork('10.108.11.0', '24', RM_NET))
      const state = await node.bgp.get()
      const body = await bgpBody(node, AS_HEADER)
      console.log(`live-bgp: post-removal body ${JSON.stringify(body)}; networks ${JSON.stringify(state?.networks ?? [])}`)
      expect(state?.networks.some((n) => n.prefix === '10.108.11.0')).toBe(false)
      await expect(node.bgp.removeNetwork('', '24', RM_NET)).rejects.toBeInstanceOf(NotSupportedError) // :94-96's arms
      await expect(node.bgp.removeNetwork('10.108.11.0', '', RM_NET)).rejects.toBeInstanceOf(NotSupportedError)
    } finally {
      await clearBgp(node, 'net-remove-final')
      await clearRoutemaps(node, 'net-remove')
    }
  })

  it('the router-id trio sets, negates and defaults with a read after each arm (test_set_router_id, :100-122)', async () => {
    await clearBgp(node, 'rid')
    try {
      await node.bgp.create(AS)
      await node.bgp.setRouterId('1.1.1.1')
      expect((await node.bgp.get())?.routerId).toBe('1.1.1.1') // :104-105
      await node.bgp.unsetRouterId()
      const afterUnset = await node.bgp.get()
      const bodyAfterUnset = await bgpBody(node, AS_HEADER)
      console.log(`live-bgp: after \`no router-id\` the body is ${JSON.stringify(bodyAfterUnset)} — upstream's fall-through arm at :117-119 composes this same text (DR-037 makes it a verb)`)
      expect(afterUnset?.routerId).toBeUndefined()
      await node.bgp.setRouterId('2.2.2.2')
      await node.bgp.defaultRouterId()
      const afterDefault = await node.bgp.get()
      const bodyAfterDefault = await bgpBody(node, AS_HEADER)
      console.log(`live-bgp: after \`default router-id\` the body is ${JSON.stringify(bodyAfterDefault)}; typed routerId ${String(afterDefault?.routerId)}`)
      expect(afterDefault?.routerId).toBeUndefined()
    } finally {
      await clearBgp(node, 'rid-final')
    }
  })

  it('a bare maximum-paths is either normalised by the device or invisible to this reader — never invented (test_maximum_paths_just_max_path, :123-145)', async () => {
    await clearBgp(node, 'paths')
    try {
      await node.bgp.create(AS)
      await attempt('`maximum-paths 20` (the single-value text pinned at :127, no ecmp tail)', () => node.bgp.setMaximumPaths(20))
      const state = await node.bgp.get()
      const body = await bgpBody(node, AS_HEADER)
      const pathsLine = body.filter((line) => line.startsWith('maximum-paths'))
      console.log(`live-bgp: DIVERGENCE-4 capture — the device stores ${JSON.stringify(pathsLine)} and the typed pair reads maximumPaths=${String(state?.maximumPaths)} maximumEcmpPaths=${String(state?.maximumEcmpPaths)}`)
      // bgp.py:91's pair regex needs the `… ecmp M` tail, so a bare line reads NOTHING (divergence 4).
      // What is pinned here is the client's own claim — it never invents a value: either the device kept no
      // maximum-paths line at all, or it kept one and the reader reports either nothing (bare line) or a
      // complete PAIR (the device normalised it with an ecmp tail).
      if (pathsLine.length === 0) {
        console.warn('live-bgp: this device kept no `maximum-paths` line for the single-value write — the :127 text is not what 4.28.14M renders, so the divergence-4 comparison runs against an empty body')
        expect(state?.maximumPaths).toBeUndefined()
      } else if (state?.maximumPaths === undefined) {
        expect(state?.maximumEcmpPaths).toBeUndefined()
      } else {
        expect(state.maximumPaths).toBe(20)
        expect(typeof state.maximumEcmpPaths).toBe('number')
      }
      await node.bgp.unsetMaximumPaths() // :130 / the fall-through at :142-143
      const afterUnset = await node.bgp.get()
      console.log(`live-bgp: evidence after \`no maximum-paths\` — lines ${JSON.stringify((await bgpBody(node, AS_HEADER)).filter((line) => line.startsWith('maximum-paths')))}; typed maximumPaths=${String(afterUnset?.maximumPaths)} ecmp=${String(afterUnset?.maximumEcmpPaths)}`)
      expect(afterUnset?.maximumPaths).toBeUndefined()
      await node.bgp.defaultMaximumPaths() // :133
      const afterDefault = await node.bgp.get()
      console.log(`live-bgp: evidence after \`default maximum-paths\` — lines ${JSON.stringify((await bgpBody(node, AS_HEADER)).filter((line) => line.startsWith('maximum-paths')))}; typed maximumPaths=${String(afterDefault?.maximumPaths)} ecmp=${String(afterDefault?.maximumEcmpPaths)}`)
      expect(afterDefault?.maximumPaths).toBeUndefined()
    } finally {
      await clearBgp(node, 'paths-final')
    }
  })

  it('maximum-paths with ecmp reads as a pair, and ecmp-without-max refuses at zero writes (test_maximum_paths_max_path_and_ecmp, :146-164)', async () => {
    await clearBgp(node, 'ecmp')
    await expect(node.bgp.setMaximumPaths(undefined, 20)).rejects.toBeInstanceOf(NotSupportedError) // :161-163's TypeError arm
    try {
      await node.bgp.create(AS)
      // Executed run 2026-11-08: 4.28.14M REFUSES `maximum-paths 20 ecmp 4` with
      // "maximum-paths should be less than or equal to max ECMP" — the arm upstream only ever ran against
      // a mock. Wrapped so the pair-read evidence still prints; the arm re-pin belongs to the ledger pass.
      const pairWritten = await attempt('`maximum-paths 20 ecmp 4` (:151 as upstream wrote it)', () => node.bgp.setMaximumPaths(20, 4)) // :151
      console.log(`live-bgp: upstream pair arm (20,4) accepted by this device = ${String(pairWritten)}`)
      const state = await node.bgp.get()
      const body = await bgpBody(node, AS_HEADER)
      console.log(`live-bgp: after \`maximum-paths 20 ecmp 4\` the body is ${JSON.stringify(body.filter((line) => line.startsWith('maximum-paths')))}`)
      expect(state?.maximumPaths).toBe(20)
      expect(state?.maximumEcmpPaths).toBe(4)
    } finally {
      await clearBgp(node, 'ecmp-final')
    }
  })

  it('shutdown/noShutdown/defaultShutdown with a read per arm, and the body that answers divergence 5 (test_set_shutdown, :165-176)', async () => {
    await clearBgp(node, 'shutdown')
    try {
      await node.bgp.create(AS)
      await node.bgp.shutdown() // upstream reaches this text only with default=False, disable=False (:168-169)
      const shut = await node.bgp.get()
      const shutBody = await bgpBody(node, AS_HEADER)
      console.log(`live-bgp: after \`shutdown\` the body is ${JSON.stringify(shutBody.filter((line) => line.includes('shutdown')))}; typed shutdown ${String(shut?.shutdown)}`)
      expect(shut?.shutdown).toBe(true)
      await node.bgp.noShutdown() // upstream's ZERO-argument call composes this (bgp.py:154's inverted default, :171-172)
      expect((await node.bgp.get())?.shutdown).toBe(false)
      await node.bgp.defaultShutdown() // :174-175
      const def = await node.bgp.get()
      console.log(`live-bgp: after \`default shutdown\` the body is ${JSON.stringify(await bgpBody(node, AS_HEADER))}; typed shutdown ${String(def?.shutdown)}`)
      expect(typeof def?.shutdown).toBe('boolean')
    } finally {
      await clearBgp(node, 'shutdown-final')
    }
  })
})

describe.skipIf(!gate.runnable)('live full-write: pyeapi test/unit/test_api_bgp.py — neighbours half (:186-391)', () => {
  let node: Node

  beforeAll(async () => {
    node = buildFullWriteNode(targetOf())
    await clearBgp(node, 'nbr-before-all')
    await stageRoutemaps(node, 'nbr')
    // The shared fixture this half is built on (upstream's `running_config.bgp` neighbours are
    // 'test'/'test1'/'172.16.10.1'): two address-named neighbours plus ONE peer group, so
    // test_getall's "exactly three names" (:189) has a 1:1 analogue. The group declaration is a raw line
    // because bgp.ts models no declaration verb — see the header's verb-gap note 1.
    await node.bgp.create(AS)
    await attempt(`the neighbour/group staging batch under ${AS_HEADER} (peer-group declaration line included)`, async () => {
      await runGuardedLiveWriteSession(node, {
        name: 'live-bgp-nbr-stage',
        commands: [
          AS_HEADER,
          `neighbor ${GROUP} peer group`,
          `neighbor ${N1} remote-as ${REMOTE_AS}`,
          `neighbor ${N2} remote-as ${REMOTE_AS}`,
        ],
      })
    })
    console.log(`live-bgp: neighbour staging left ${AS_HEADER} with body ${JSON.stringify(await bgpBody(node, AS_HEADER))}`)
  })

  afterAll(async () => {
    await clearBgp(node, 'nbr-after-all')
    await clearRoutemaps(node, 'nbr')
  })

  it('neighbors.getAll() keys every declared name once, from body lines (test_getall, :186-190)', async () => {
    const all = await node.bgp.neighbors.getAll() // :187
    expect(typeof all.has).toBe('function') // :188 asserts a dict; here a ResourceTable (row 78)
    const keys = [...all.keys()]
    console.log(`live-bgp: neighbour keys this device reports: ${JSON.stringify(keys)}`)
    for (const name of [N1, N2]) expect(all.has(name)).toBe(true)
    // upstream's count of 3 (:189) only holds if the device accepted the group declaration; that is the
    // same answer the peer-group case below gets, so the count is reported rather than demanded.
    console.log(`live-bgp: getAll() size ${String(all.size)} (upstream's fixture size is 3, :189)`)
  })

  it('neighbors.get() answers the nine-key record for a real name and undefined for a name nothing declared (test_get, :191-197)', async () => {
    const one = await node.bgp.neighbors.get(N1)
    if (one === undefined) {
      console.warn(`live-bgp: ${N1} is absent — the shared staging batch was refused by this device, so the nine-key vocabulary half of :191-197 is NOT exercised on 4.28.14M (the beforeAll printed the refusal)`)
      expect(await node.bgp.neighbors.get(GHOST)).toBeUndefined()
      return
    }
    // :193-195's nine names, as this client's fields: name + six values + three booleans.
    expect(one.name).toBe(N1)
    expect(one.remoteAs).toBe(REMOTE_AS) // the reader keeps the `.*` remainder, so the string spelling round-trips
    for (const flag of [one.sendCommunity, one.nextHopSelf, one.shutdown]) expect(typeof flag).toBe('boolean') // never absent (divergence 1's polarity keeps)
    for (const value of [one.peerGroup, one.description, one.routeMapIn, one.routeMapOut]) {
      if (value !== undefined) expect(typeof value).toBe('string')
    }
    // divergence 1: pyeapi answers a fully-keyed all-`None` record for ANY name (`bgp.py:184-196`), even
    // one the router never mentioned. Absence is absence here.
    expect(await node.bgp.neighbors.get(GHOST)).toBeUndefined()
  })

  it('neighbors.delete() removes the neighbour, firing the group-keyword retry only if the bare negation is refused (test_delete, :198-202)', async () => {
    const before = await node.bgp.neighbors.getAll()
    if (!before.has(N2)) {
      console.warn(`live-bgp: ${N2} is not present — the staging batch was refused by this device, so the delete arm runs against ${N1} in the peer-group case instead of claiming coverage here`)
      return
    }
    let bareRefused = false
    try {
      await node.bgp.neighbors.delete(N2) // :199's `no neighbor test`
    } catch (rawErr) {
      bareRefused = rawErr instanceof CommandError
      reportRefusal(rawErr, `the bare \`no neighbor ${N2}\` — divergence 11 retries the group-keyword spelling only for a CommandError (bgp.py:265-275; other classes must stay loud)`)
    }
    const after = await node.bgp.neighbors.get(N2)
    console.log(`live-bgp: delete arm — bare negation refused: ${String(bareRefused)}; the neighbour now reads ${after === undefined ? 'undefined (removed)' : JSON.stringify(after)}`)
    expect(after).toBeUndefined()
  })

  it('setPeerGroup joins an address-named neighbour and refuses loudly for a group-shaped name (test_set_peer_group, :203-228)', async () => {
    const joined = await attempt(`neighbor ${N1} <peer-group keyword> ${GROUP} — the config arm at :209-210 composes the LEGACY spelling, the fixture's own keyword line is ':207', and the spelling here comes from the device's own text, DR-107`, () => node.bgp.neighbors.setPeerGroup(N1, GROUP))
    if (joined) {
      const one = await node.bgp.neighbors.get(N1)
      console.log(`live-bgp: peer-group read-back: peerGroup=${String(one?.peerGroup)} peerGroupForm=${String(one?.peerGroupForm)}`)
      expect(one?.peerGroup).toBe(GROUP)
      if (one?.peerGroupForm !== undefined) expect(['peer group', 'peer-group']).toContain(one.peerGroupForm)
      await node.bgp.neighbors.unsetPeerGroup(N1) // the negate arm, cmds :212 / func :213
      expect((await node.bgp.neighbors.get(N1))?.peerGroup).toBeUndefined()
    }
    // divergence 12 / §5 row 202: pyeapi's gate answers a SILENT False when the name is not an address
    // (`bgp.py:288-297`, the fall-through `return False` at `:297`); this client refuses out loud, spending nothing.
    await expect(node.bgp.neighbors.setPeerGroup(GROUP, GROUP)).rejects.toBeInstanceOf(NotSupportedError)
  })

  it('setRemoteAs takes the string spelling for any name shape, and the negation/default arms report their device answer (test_set_remote_as, :229-253)', async () => {
    // :231-233 uses the STRING '65000' for the group-shaped name 'test' — no ispeergroup gate on this verb
    // (bgp.ts keeps that), so the group name is addressed here exactly as upstream addresses one.
    const accepted = await attempt(`\`neighbor ${GROUP} remote-as ${REMOTE_AS}\` (:232-236's config arm on a group-shaped name)`, () => node.bgp.neighbors.setRemoteAs(GROUP, REMOTE_AS))
    if (accepted) expect((await node.bgp.neighbors.get(GROUP))?.remoteAs).toBe(REMOTE_AS)
    await attempt(`the numeric spelling \`neighbor ${GROUP} remote-as 65201\` — pyeapi formats whatever arrives, this client normalizes digits (:231's string arm above is the pinned one)`, () => node.bgp.neighbors.setRemoteAs(GROUP, 65201))
    await attempt('`no … remote-as` (:238-239\'s disable arm)', () => node.bgp.neighbors.unsetRemoteAs(GROUP))
    console.log(`live-bgp: ${GROUP} after the negation arms reads ${JSON.stringify(await node.bgp.neighbors.get(GROUP))}`)
    // :245-249 is upstream's commented-out "uncomment if command_builder fails" note and :250-252 the arm it
    // replaced — a value-less call composing `no neighbor test remote-as` through the deprecated falsy
    // fall-through (row 73). Here that intent is the named verb above, so there is nothing extra to send.
  })

  it('neighbors.create() IS the bare `neighbor X shutdown` line, and the boolean arms read both ways (test_set_shutdown, :254-272) — DR-109 kept verbatim', async () => {
    const created = await attempt(`\`neighbor ${N1} shutdown\` via create() — pyeapi's create IS set_shutdown(name, default=False, disable=False) (bgp.py:262-263), i.e. it MENTIONS the peer and sets it DOWN`, () => node.bgp.neighbors.create(N1)) // :258-261
    if (!created) return
    expect((await node.bgp.neighbors.get(N1))?.shutdown).toBe(true)
    await node.bgp.neighbors.unsetShutdown(N1) // :262-264's `no neighbor test shutdown`, which is upstream's ZERO-argument default (bgp.py:303)
    expect((await node.bgp.neighbors.get(N1))?.shutdown).toBe(false)
    await attempt('`default neighbor X shutdown` (:266-271\'s default arm; upstream\'s fourth loop state, `false`, is the same negation again at :255)', () => node.bgp.neighbors.defaultShutdown(N1))
    console.log(`live-bgp: ${N1} after the default arm reads ${JSON.stringify(await node.bgp.neighbors.get(N1))}`)
  })

  it('setSendCommunity/unsetSendCommunity drive only the boolean polarity of one line (test_set_send_community, :273-298)', async () => {
    const on = await attempt(`neighbor ${N1} send-community (:278)`, () => node.bgp.neighbors.setSendCommunity(N1))
    if (!on) return
    expect((await node.bgp.neighbors.get(N1))?.sendCommunity).toBe(true)
    await node.bgp.neighbors.unsetSendCommunity(N1) // :281-282's negate arm, composed identically by the fall-through arm at :295-296
    expect((await node.bgp.neighbors.get(N1))?.sendCommunity).toBe(false)
    await attempt('`default neighbor X send-community` (:284-286)', () => node.bgp.neighbors.defaultSendCommunity(N1))
    console.log(`live-bgp: sendCommunity after the default arm: ${String((await node.bgp.neighbors.get(N1))?.sendCommunity)}`)
  })

  it('setNextHopSelf/unsetNextHopSelf, same single-line boolean polarity (test_set_next_hop_self, :299-324)', async () => {
    const on = await attempt(`neighbor ${N1} next-hop-self (:304)`, () => node.bgp.neighbors.setNextHopSelf(N1))
    if (!on) return
    console.log(`live-bgp: next-hop-self evidence — body lines naming ${N1} with next-hop: ${JSON.stringify((await bgpBody(node, AS_HEADER)).filter((line) => line.includes(N1) && line.includes('next-hop')))}; record reads ${JSON.stringify(await node.bgp.neighbors.get(N1))}`)
    expect((await node.bgp.neighbors.get(N1))?.nextHopSelf).toBe(true)
    await node.bgp.neighbors.unsetNextHopSelf(N1) // :307-308, composed identically by the fall-through arm at :321-322
    expect((await node.bgp.neighbors.get(N1))?.nextHopSelf).toBe(false)
    await attempt('`default neighbor X next-hop-self` (:310-313)', () => node.bgp.neighbors.defaultNextHopSelf(N1))
  })

  it('setRouteMapIn: the map join reads back, and the suffixed negation is the device\'s answer, not an assumption (test_set_route_map_in, :325-350)', async () => {
    const accepted = await attempt(`neighbor ${N1} route-map ${RM_IN} in (:327 names the map upstream never staged, 'TEST_RM'; the config line is composed from cmds :331 / func :332)`, () => node.bgp.neighbors.setRouteMapIn(N1, RM_IN))
    if (!accepted) return
    expect((await node.bgp.neighbors.get(N1))?.routeMapIn).toBe(RM_IN)
    // The `' in'` suffix rides AFTER the builder, so even the negated arm reads
    // `no neighbor X route-map in` (bgp.py:323-327, cited in bgp.ts's table) — recorded as a live result.
    const negated = await attempt('the suffixed negation `no neighbor X route-map in` (negate armcmds :334 / func :335, and the fall-through arm composes the same text at :347-348)', () => node.bgp.neighbors.unsetRouteMapIn(N1))
    console.log(`live-bgp: suffixed negation accepted: ${String(negated)}; ${N1} now reads ${JSON.stringify(await node.bgp.neighbors.get(N1))}`)
    await attempt('the suffixed default arm (cmds :337, func :338-339)', () => node.bgp.neighbors.defaultRouteMapIn(N1))
  })

  it('setRouteMapOut: the out twin, same suffix question (test_set_route_map_out, :351-376)', async () => {
    const accepted = await attempt(`neighbor ${N1} route-map ${RM_OUT} out (config arm cmds :357 / func :358)`, () => node.bgp.neighbors.setRouteMapOut(N1, RM_OUT))
    if (!accepted) return
    expect((await node.bgp.neighbors.get(N1))?.routeMapOut).toBe(RM_OUT)
    const negated = await attempt('`no neighbor X route-map out` (negate arm cmds :360 / func :361, and the fall-through twin at :373-374)', () => node.bgp.neighbors.unsetRouteMapOut(N1))
    console.log(`live-bgp: out-direction suffixed negation accepted: ${String(negated)}; ${N1} now reads ${JSON.stringify(await node.bgp.neighbors.get(N1))}`)
  })

  it('setDescription round-trips spaced text through the `.*` reader (test_set_description, :377-391)', async () => {
    const accepted = await attempt(`neighbor ${N1} description <spaced text> (:379's value is 'this is a test', composed by config-arm cmds :383 / func :384)`, () => node.bgp.neighbors.setDescription(N1, 'this is a live-lane test'))
    if (!accepted) return
    expect((await node.bgp.neighbors.get(N1))?.description).toBe('this is a live-lane test')
    await node.bgp.neighbors.unsetDescription(N1) // :386-387
    expect((await node.bgp.neighbors.get(N1))?.description).toBeUndefined()
    await attempt('`default neighbor X description` (:389-391)', () => node.bgp.neighbors.defaultDescription(N1))
    console.log(`live-bgp: ${N1} after the default arm reads ${JSON.stringify(await node.bgp.neighbors.get(N1))}`)
  })
})
