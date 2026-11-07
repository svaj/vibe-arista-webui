/**
 * `BgpResource` + `BgpNeighborsResource` — W3a (#49), the BGP entity module on the M7 framework.
 * `node.bgp` / `node.bgp.neighbors` over `MockTransport`: reads answer one hand-reduced config text,
 * every write pins the exact joined command list (docs/TESTING.md §3, DR-083). Configs are inline,
 * **hand-reduced from pyeapi's `test/fixtures/running_config.bgp:4-17`** (6816d9e) — the bgp 65000
 * block with its three neighbours and two networks kept verbatim, surrounding noise dropped; never
 * captured from the 7050TX-64. Negative halves reuse a reduced `running_config.ospf` (upstream's own
 * negative source for bgp tests, `test_api_bgp.py` has no bgp-less class — the ospf suite's fixture
 * stands in, honest-provenance note in the module header). No EOS acceptance claimed (M12 #14).
 *
 * ## Upstream port ledger
 *
 * `pyeapi/test/unit/test_api_bgp.py` — **22** methods (verified in the pinned clone 2026-11-06), all
 * ported with texts verbatim:
 *  entity half — `test_get` (`:51-55`: keys `bgp_as/router_id/maximum_paths/maximum_ecmp_paths/
 *    shutdown/neighbors/networks` — here every value is pinned from the reduced fixture, and the
 *    max-paths keys answer ABSENT because the fixture has no `maximum-paths … ecmp …` line at all,
 *    which upstream renders as the pair of `None`s); `test_create` (`:56-62`);
 *    `test_create_invalid_as` (`:63-67`); `test_delete` (`:68-72`); `test_default` (`:73-77`);
 *    `test_add_network` (`:78-88`, route-map arm INCLUDED + the two `''` ValueError arms);
 *    `test_remove_network` (`:89-99`, same shape); `test_set_router_id` (`:100-122` — the
 *    `None`-fall-through pin at `:117-121` becomes the named negate verb);
 *    `test_maximum_paths_just_max_path` (`:123-145`, incl. its `:140-144` fall-through pin);
 *    `test_maximum_paths_max_path_and_ecmp` (`:146-164`, incl. the `:162-163` TypeError guard —
 *    ecmp without max refuses); `test_set_shutdown` (`:165-184` — the INVERTED parameter defaults
 *    family pinned via the three named verbs);
 *  neighbours half (upstream constructs `BgpNeighbors(None)` at `:188`) — `test_getall`
 *    (`:186-189`, len 3 — the same three names here); `test_get` (`:191-196`, nine keys — the same
 *    nine fields typed); `test_delete` (`:198-202`, first-try success); `test_set_peer_group`
 *    (`:203-228` — upstream's four `peer-group` texts, which THEIR suite can only produce because
 *    the fake node lies "4.17.1.1" (`test/lib/testlib.py:75`); this suite gets the SAME texts from
 *    the fixture's actual `peer-group` spelling via form detection, and pins the modern arm from a
 *    modern-spelling config); `test_set_remote_as` (`:229-253`); `test_set_shutdown` (`:254-272` —
 *    the 'false' state duplicates the negate text; upstream's parameter default IS the negate);
 *    `test_set_send_community` (`:273-298`, incl. the odd `value=False, default=True` default arm —
 *    DR-037 precedence makes it `default …` here too); `test_set_next_hop_self` (`:299-324`);
 *    `test_set_route_map_in` (`:325-350`) / `test_set_route_map_out` (`:351-376`) — including the
 *    negate/default texts `no|default neighbor test route-map in|out` (suffix OUTSIDE the prefix,
 *    `bgp.py:324-333`); `test_set_description` (`:377-391`, the three-word value).
 *  NOT ported, declared skipped: `pyeapi/test/system/test_api_bgp.py` (device territory,
 *  docs/TESTING.md §5) and upstream's commented-out "uncomment when command_builder raises" arms
 *  (those pre-armed ValueError expectations describe the fix DR-037 ALREADY made — the refuse paths
 *  are pinned in command-builder.test.ts instead).
 */

import { describe, expect, it } from 'vitest'

import { Node } from '../command-layer'
import { CommandError, NotFoundError, NotSupportedError } from '../errors'
import { mockTransport, type MockTransport } from '../testing/mock-transport'
import type { BgpNeighbor } from './bgp'

const textOf = (lines: readonly string[]): string => lines.join('\n')

function configTransport(config: string): MockTransport {
  return mockTransport().replies('enable\nshow running-config all', [{}, { output: config }])
}

function nodeFor(config: string): { node: Node; transport: MockTransport } {
  const transport = configTransport(config)
  return { node: new Node(transport), transport }
}

const writeKey = (cmds: readonly string[]): string => ['enable', 'configure terminal', ...cmds].join('\n')

const sentScripts = (transport: MockTransport): string[][] => transport.sent().map((cmds) => cmds.map(String))

const writeScripts = (transport: MockTransport): string[][] => sentScripts(transport).filter((script) => script.includes('configure terminal'))

/** Script the success replies for each write batch's FULL joined key (enable + configure terminal + cmds — one CommandResult per command, the mlag.test.ts idiom). */
function allowWrites(transport: MockTransport, ...scripts: Array<readonly string[]>): MockTransport {
  for (const cmds of scripts) transport.replies(writeKey(cmds), [{}, {}, ...cmds.map(() => ({}))])
  return transport
}

function outcome(fn: () => Promise<unknown>): Promise<unknown> {
  return fn().then(() => 'resolved' as const, (thrown: unknown) => thrown)
}

async function expectError(fn: () => Promise<unknown>, message: RegExp): Promise<void> {
  const thrown = await outcome(fn)
  expect(thrown, 'expected a rejection').toBeInstanceOf(Error)
  expect((thrown as Error).message).toMatch(message)
}

/** Reduced verbatim from pyeapi `test/fixtures/running_config.bgp:4-17`: the AS block, three neighbours (`test`, `test1` spoken of as GROUPS via bare declarations, `172.16.10.1` a member of `test`), two networks. No shutdown line, no maximum-paths line — both feed the derived/pair pins. The peer-group spelling HERE is the legacy `peer-group`, exactly as the upstream fixture spells it. */
const BGP_FIXTURE_CONFIG = textOf([
  'hostname lab-sw1',
  '!',
  'ip routing',
  '!',
  'router bgp 65000',
  '   router-id 1.1.1.1',
  '   neighbor test peer-group',
  '   neighbor test remote-as 65001',
  '   neighbor test maximum-routes 12000',
  '   neighbor test1 peer-group',
  '   neighbor test1 route-map RM-IN in',
  '   neighbor test1 route-map RM-OUT out',
  '   neighbor test1 maximum-routes 12000',
  '   neighbor 172.16.10.1 remote-as 65000',
  '   neighbor 172.16.10.1 maximum-routes 12000',
  '   neighbor 172.16.10.1 peer-group test',
  '   network 172.16.10.0/24',
  '   network 172.17.0.0/16',
  '!',
  'end',
])

/** Reduced from pyeapi `test/fixtures/running_config.ospf` — used for bgp's no-BGP negatives (the ospf suite's negative half runs the mirror image with the bgp fixture, `test_api_ospf.py:130-149`). */
const NO_BGP_CONFIG = textOf([
  'router ospf 65000',
  '   router-id 1.1.1.1',
  '   network 172.16.10.0/24 area 0.0.0.0',
  '!',
  'end',
])

describe('BgpResource reads — one config pass for the whole router record (bgp.py:62-107)', () => {
  it('the fixture half answers every upstream key, typed; max-paths is an ABSENT PAIR (port test_get, :51-55)', async () => {
    const { node, transport } = nodeFor(BGP_FIXTURE_CONFIG)
    const state = await node.bgp.get()
    expect(state?.bgpAs).toBe(65000) // `_parse_bgp_as` int()s an all-numeric remainder (:82-83)
    expect(state?.routerId).toBe('1.1.1.1')
    // Upstream ALWAYS emits both max-paths keys (:93-94) with None values when the
    // `maximum-paths N ecmp M` pair regex (:91) found nothing — here: both absent. The fixture has no
    // maximum-paths line at all; the bare-form invisibility pin lives below.
    expect(state?.maximumPaths).toBeUndefined()
    expect(state?.maximumEcmpPaths).toBeUndefined()
    // No shutdown line of any kind → upstream's substring rule derives True (:97), and so does the
    // line-scoped port (:95-98 module divergence 5 — whether 4.28 writes a bare `shutdown` here is
    // M12 #14 territory).
    expect(state?.shutdown).toBe(true)
    expect(state?.networks).toEqual([
      { prefix: '172.16.10.0', masklen: '24' },
      { prefix: '172.17.0.0', masklen: '16' },
    ]) // groups stay STRINGS (:104-106); no route map on either line
    // test_getall (:186-189) pins len 3 — the same three names, in device order, as typed rows.
    expect([...state?.neighbors.keys() ?? []]).toEqual(['test', 'test1', '172.16.10.1'])
    // ONE config read for entity + neighbours (the neighbours table rides the same chunked document,
    // DR-030; upstream pays a get_block scan per neighbour name at :204-205).
    expect(transport.callCount()).toBe(1)
  })

  it('neighbour rows keep upstream\'s derived booleans and field set (port TestApiBgpNeighbor.test_get keys, :191-196)', async () => {
    const neighbors = (await nodeFor(BGP_FIXTURE_CONFIG).node.bgp.get())?.neighbors
    // The fixture's bare `neighbor test peer-group` DECLARATION lines read no membership value —
    // upstream's peer_group regex finds nothing there (:211-214) and neither does this parser.
    expect(neighbors?.get('test')).toEqual<BgpNeighbor>({
      name: 'test',
      remoteAs: '65001',
      sendCommunity: true, // the derived default: no `no neighbor test send-community` line (:221-225)
      nextHopSelf: true, // same derivation family (:238-242)
      shutdown: false, // no positive `neighbor test shutdown` line (:226-231)
    })
    expect(neighbors?.get('test1')).toEqual<BgpNeighbor>({
      name: 'test1',
      routeMapIn: 'RM-IN',
      routeMapOut: 'RM-OUT',
      sendCommunity: true,
      nextHopSelf: true,
      shutdown: false,
    }) // `test1` carries no remote-as here either — upstream answers None, absence here
    // The only TRUE membership line in the fixture: peer-group spelling RECORDED (no upstream twin,
    // divergence 8 — the record is what makes the mixed-spelling question answerable at all).
    expect(neighbors?.get('172.16.10.1')).toEqual<BgpNeighbor>({
      name: '172.16.10.1',
      remoteAs: '65000',
      peerGroup: 'test',
      peerGroupForm: 'peer-group',
      sendCommunity: true,
      nextHopSelf: true,
      shutdown: false,
    })
    // `maximum-routes 12000` lines mention names (already keyed) and stay unmodelled — upstream's
    // eight parsers likewise ignore them.
  })

  it('a bare `maximum-paths N` is INVISIBLE, and the ecmp pair reads both numbers (module divergence 4 kept from bgp.py:91)', async () => {
    const bare = await nodeFor(textOf(['router bgp 1', '   maximum-paths 8', '!', 'end'])).node.bgp.get()
    expect(bare?.maximumPaths).toBeUndefined() // upstream's regex requires `… ecmp …` too (:91)
    expect(bare?.maximumEcmpPaths).toBeUndefined()
    const pair = await nodeFor(textOf(['router bgp 1', '   maximum-paths 4 ecmp 4', '!', 'end'])).node.bgp.get()
    expect(pair?.maximumPaths).toBe(4)
    expect(pair?.maximumEcmpPaths).toBe(4)
  })

  it('route-map names TRUNCATE at the first non-word char on read — the Python-probed upstream quirk kept (module divergence 6, bgp.py:101)', async () => {
    const state = await nodeFor(textOf([
      'router bgp 1',
      '   network 10.9.0.0/16 route-map RM-OUT',
      '   network 10.8.0.0/24 route-map plain',
      '!',
      'end',
    ])).node.bgp.get()
    // Probe of the pinned pattern in Python (2026-11-06): `(?: route-map (\w+))*` on the first line
    // answers the group as `RM` — the capture stops at the hyphen, the `*` loop takes one rep, and
    // `-OUT` silently drops. The JS port answers the identical `RM` (faithful, NOT an omitted value).
    expect(state?.networks).toEqual([
      { prefix: '10.9.0.0', masklen: '16', routeMap: 'RM' },
      { prefix: '10.8.0.0', masklen: '24', routeMap: 'plain' },
    ])
  })

  it('phrase-names and negated VALUES stop voting; names behind `no neighbor …` lines still join the table (module divergence 7)', async () => {
    const state = await nodeFor(textOf([
      'router bgp 1',
      '   neighbor test description mentions neighbor ghost inside',
      '   no neighbor brandnew peer-group BADGROUP',
      '   no neighbor brandnew send-community',
      '   no neighbor brandnew next-hop-self',
      '   no neighbor brandnew shutdown',
      '!',
      'end',
    ])).node.bgp.get()
    // Upstream's `neighbor ([^\s]+)` findall (:203) would key a `ghost` entry from the description,
    // and its per-name searches would report BADGROUP through the negation (:211) and
    // `description: 'mentions neighbor ghost inside'` (:234 matches THROUGH `no …`, but this line is
    // a POSITIVE description — ghost is the phantom, brandnew the real name).
    expect([...state?.neighbors.keys() ?? []]).toEqual(['test', 'brandnew'])
    // brandnew: named by negation lines (upstream would key it too) but NO peerGroup value voted —
    // the two boolean derivations DO key off negation lines, keeping upstream's polarity bookkeeping.
    expect(state?.neighbors.get('brandnew')).toEqual<BgpNeighbor>({
      name: 'brandnew',
      sendCommunity: false,
      nextHopSelf: false,
      shutdown: false, // `no neighbor brandnew shutdown` upstream's (?<!no ) rule reads False (:226-231); ours too
    })
    // And the description of `test` keeps its whole remainder — inner words intact:
    expect(state?.neighbors.get('test')?.description).toBe('mentions neighbor ghost inside')
  })

  it('an IPv6 neighbour parses, reads as one token, and is address-shaped for the peer-group gate (module divergence 9 scope)', async () => {
    const state = await nodeFor(textOf([
      'router bgp 1',
      '   neighbor fd00::1 remote-as 65001',
      '   neighbor fd00::1 peer group MYGROUP',
      '   neighbor gmodern peer group',
      '!',
      'end',
    ])).node.bgp.get()
    const row = state?.neighbors.get('fd00::1')
    expect(row).toEqual<BgpNeighbor>({
      name: 'fd00::1',
      remoteAs: '65001',
      peerGroup: 'MYGROUP',
      peerGroupForm: 'peer group',
      sendCommunity: true,
      nextHopSelf: true,
      shutdown: false,
    })
    // The bare MODERN declaration line names `gmodern` (upstream’s regex likewise reads no group
    // value from a declaration, :211-214) — and pins the modern-declaration branch of the parser.
    expect(state?.neighbors.get('gmodern')).toEqual<BgpNeighbor>({ name: 'gmodern', sendCommunity: true, nextHopSelf: true, shutdown: false })
    const { node } = nodeFor(NO_BGP_CONFIG)
    expect(node.bgp.neighbors.isPeerGroup('fd00::1')).toBe(false) // an ADDRESS — upstream netaddr agrees (:257)
    expect(node.bgp.neighbors.isPeerGroup('MYGROUP')).toBe(true) // group-shaped — upstream AddrFormatError
    expect(node.bgp.neighbors.isPeerGroup('1.2.3')).toBe(true) // netaddr parses this as 1.2.0.3; this conservative port does not (pinned narrowing, DR-110)
    // The full 8-hextet form, `::` compression at the tail, and the unspecified address all parse;
    // nine hextets and an out-of-range octet do not.
    expect(node.bgp.neighbors.isPeerGroup('2001:0db8:0000:0000:0000:0000:0000:0001')).toBe(false)
    expect(node.bgp.neighbors.isPeerGroup('fe80::')).toBe(false)
    expect(node.bgp.neighbors.isPeerGroup('::')).toBe(false)
    expect(node.bgp.neighbors.isPeerGroup('1:2:3:4:5:6:7:8:9')).toBe(true)
    expect(node.bgp.neighbors.isPeerGroup('999.1.1.1')).toBe(true)
  })

  it('a BGP-less switch answers undefined for the entity and an EMPTY table for neighbours (module divergence 1; the ospf fixture stands in, mirroring upstream\'s own negative pairing)', async () => {
    const { node, transport } = nodeFor(NO_BGP_CONFIG)
    expect(await node.bgp.get()).toBeUndefined()
    const empty = await node.bgp.neighbors.getAll()
    expect(empty.size).toBe(0)
    expect(await node.bgp.neighbors.get('test')).toBeUndefined()
    expect(transport.callCount()).toBe(1) // THREE reader calls, ONE device read — the DR-026 memo (upstream re-runs `show running-config` per access, row 15)
    expect(writeScripts(transport)).toEqual([])
  })

  it('the entity half and the neighbours half open DIFFERENT `router bgp` lines on a vrf-tailed header (module divergences 2/3 pinned)', async () => {
    const vrfBgp = textOf([
      'router bgp 100 vrf MGMT',
      '   neighbor 10.0.0.1 remote-as 65002',
      '!',
      'end',
    ])
    const { node, transport } = nodeFor(vrfBgp)
    allowWrites(transport,
      ['router bgp 100 vrf MGMT', 'router-id 9.9.9.9'],
      ['router bgp 100', 'neighbor 10.0.0.1 remote-as 65003'],
      ['no router bgp 100 vrf MGMT'],
    )
    const state = await node.bgp.get()
    expect(state?.bgpAs).toBe('100 vrf MGMT') // `.*` remainder + `isnumeric()` false → the WHOLE string (:80-83)
    await node.bgp.setRouterId('9.9.9.9')
    await node.bgp.neighbors.setRemoteAs('10.0.0.1', 65003)
    expect(writeScripts(transport)).toEqual([
      ['enable', 'configure terminal', 'router bgp 100 vrf MGMT', 'router-id 9.9.9.9'], // entity opener: the remainder (bgp.py:111)
      ['enable', 'configure terminal', 'router bgp 100', 'neighbor 10.0.0.1 remote-as 65003'], // neighbours opener: the digits (:281)
    ])
    await node.bgp.delete()
    expect(writeScripts(transport).at(-1)).toEqual(['enable', 'configure terminal', 'no router bgp 100 vrf MGMT'])
  })
})

describe('BgpResource lifecycle and entity writers — the `router bgp <as>` transaction (bgp.py:108-181)', () => {
  it('create accepts str AND int spellings with no prior read; 66000 refuses both ways (port test_create/test_create_invalid_as, :56-67)', async () => {
    const transport = mockTransport().replies(writeKey(['router bgp 65000']), [{}, {}])
    const node = new Node(transport)
    await node.bgp.create('65000')
    await node.bgp.create(65000)
    expect(sentScripts(transport)).toEqual([
      ['enable', 'configure terminal', 'router bgp 65000'],
      ['enable', 'configure terminal', 'router bgp 65000'],
    ])
    // create reads NOTHING (:114-120) and a guard refusal sends NOTHING:
    await expectError(() => node.bgp.create('66000'), /between 1 and 65535/)
    await expectError(() => node.bgp.create(66000), /between 1 and 65535/)
    await expectError(() => node.bgp.create(0), /between 1 and 65535/)
    await expectError(() => node.bgp.create(' 65000 '), /expected digits/)
    await expectError(() => node.bgp.create(65_535.5), /safe integer/)
    expect(sentScripts(transport)).toHaveLength(2)
  })

  it('delete/default are the read-then-`no|default router bgp 65000` pair (port test_delete/test_default, :68-77)', async () => {
    const { node, transport } = nodeFor(BGP_FIXTURE_CONFIG)
    allowWrites(transport, ['no router bgp 65000'], ['default router bgp 65000'])
    await node.bgp.delete()
    await node.bgp.setDefault() // framework naming of upstream\'s bare `default()` (:128-134), row 77
    expect(writeScripts(transport)).toEqual([
      ['enable', 'configure terminal', 'no router bgp 65000'],
      ['enable', 'configure terminal', 'default router bgp 65000'],
    ])
  })

  it('delete/default on a BGP-less switch answer void with NO write — like upstream\'s bare True (:123-125/:130-132)', async () => {
    const { node, transport } = nodeFor(NO_BGP_CONFIG)
    await node.bgp.delete()
    await node.bgp.setDefault()
    expect(writeScripts(transport)).toEqual([])
  })

  it('entity writers on a BGP-less switch raise "bgp is not configured", where configure_bgp would TypeError-crash', async () => {
    const { node, transport } = nodeFor(NO_BGP_CONFIG)
    await expectError(() => node.bgp.setRouterId('1.1.1.1'), /bgp is not configured/)
    const thrown = await outcome(() => node.bgp.setRouterId('1.1.1.1'))
    expect(thrown).toBeInstanceOf(NotFoundError)
    expect(writeScripts(transport)).toEqual([])
  })

  it('router-id set/negate/default (port test_set_router_id, :100-122 — incl. its value-None fall-through arm, named here)', async () => {
    const { node, transport } = nodeFor(BGP_FIXTURE_CONFIG)
    allowWrites(transport,
      ['router bgp 65000', 'router-id 1.1.1.1'],
      ['router bgp 65000', 'no router-id'],
      ['router bgp 65000', 'default router-id'],
    )
    await node.bgp.setRouterId('1.1.1.1')
    await node.bgp.unsetRouterId() // upstream\'s (None, False, True) arm (:111-113) AND its pre-armed fall-through (:117-121)
    await node.bgp.defaultRouterId() // (rid, True): third positional slot is `default`, not an "all_path_list" (dispatch ref WRONG — bgp.py:140 shows the truth for set_maximum_paths too)
    expect(writeScripts(transport)).toEqual([
      ['enable', 'configure terminal', 'router bgp 65000', 'router-id 1.1.1.1'],
      ['enable', 'configure terminal', 'router bgp 65000', 'no router-id'],
      ['enable', 'configure terminal', 'router bgp 65000', 'default router-id'],
    ])
  })

  it('maximum-paths: just max, max+ecmp, negate, default (port test_maximum_paths_just_max_path/test_maximum_paths_max_path_and_ecmp, :123-164)', async () => {
    const { node, transport } = nodeFor(BGP_FIXTURE_CONFIG)
    allowWrites(transport,
      ['router bgp 65000', 'maximum-paths 20'],
      ['router bgp 65000', 'maximum-paths 20 ecmp 20'],
      ['router bgp 65000', 'no maximum-paths'],
      ['router bgp 65000', 'default maximum-paths'],
    )
    await node.bgp.setMaximumPaths(20)
    await node.bgp.setMaximumPaths(20, 20)
    await node.bgp.unsetMaximumPaths() // upstream's disable=True arm (:133-134)
    await node.bgp.defaultMaximumPaths() // the default=True arm (:136-138)
    await node.bgp.setMaximumPaths() // upstream's fully-defaulted call answered `no maximum-paths` via the falsy fall-through (:140-144): mapped, not refused
    expect(writeScripts(transport)).toEqual([
      ['enable', 'configure terminal', 'router bgp 65000', 'maximum-paths 20'],
      ['enable', 'configure terminal', 'router bgp 65000', 'maximum-paths 20 ecmp 20'],
      ['enable', 'configure terminal', 'router bgp 65000', 'no maximum-paths'],
      ['enable', 'configure terminal', 'router bgp 65000', 'default maximum-paths'],
      ['enable', 'configure terminal', 'router bgp 65000', 'no maximum-paths'],
    ])
    // :162-163's TypeError guard, kept as a refusal — and it costs zero device calls:
    const before = writeScripts(transport).length
    await expectError(() => node.bgp.setMaximumPaths(undefined, 20), /without providing max_path/)
    expect(writeScripts(transport)).toHaveLength(before)
  })

  it('maximum-paths zeroes COMPOSE literal 0s where upstream would negate or skip them (the mlag divergence-6 family, DR-037)', async () => {
    const { node, transport } = nodeFor(BGP_FIXTURE_CONFIG)
    allowWrites(transport,
      ['router bgp 65000', 'maximum-paths 0'],
      ['router bgp 65000', 'maximum-paths 20 ecmp 0'],
    )
    await node.bgp.setMaximumPaths(0) // upstream `if max_path:` is falsy → value None → the deprecated `no maximum-paths` (abstract.py:160-161)
    await node.bgp.setMaximumPaths(20, 0) // upstream skips the ecmp arm on a falsy 0 (:149-150); this client composes it — the pair regex reads `0` back (:91)
    expect(writeScripts(transport)).toEqual([
      ['enable', 'configure terminal', 'router bgp 65000', 'maximum-paths 0'],
      ['enable', 'configure terminal', 'router bgp 65000', 'maximum-paths 20 ecmp 0'],
    ])
  })

  it('the INVERTED shutdown defaults: noShutdown is upstream\'s zero-arg call, shutdown needs the both-flags-false arm (port test_set_shutdown, :165-184)', async () => {
    const { node, transport } = nodeFor(BGP_FIXTURE_CONFIG)
    allowWrites(transport,
      ['router bgp 65000', 'shutdown'],
      ['router bgp 65000', 'no shutdown'],
      ['router bgp 65000', 'default shutdown'],
    )
    await node.bgp.shutdown() // upstream reaches this text ONLY via set_shutdown(default=False, disable=False) (:168-170 arm)
    await node.bgp.noShutdown() // the PARAMETER DEFAULT (`:154`, disable=True) — the zero-argument call means THIS
    await node.bgp.defaultShutdown() // default=True arm (:175-177)
    expect(writeScripts(transport)).toEqual([
      ['enable', 'configure terminal', 'router bgp 65000', 'shutdown'],
      ['enable', 'configure terminal', 'router bgp 65000', 'no shutdown'],
      ['enable', 'configure terminal', 'router bgp 65000', 'default shutdown'],
    ])
  })

  it('networks keep the route-map arm on BOTH the add and the remove texts (port test_add_network/test_remove_network, :78-99)', async () => {
    const { node, transport } = nodeFor(BGP_FIXTURE_CONFIG)
    allowWrites(transport,
      ['router bgp 65000', 'network 172.16.10.1/24 route-map test'],
      ['router bgp 65000', 'no network 172.16.10.1/24 route-map test'],
      ['router bgp 65000', 'no network 172.16.10.1/24'],
    )
    await node.bgp.addNetwork('172.16.10.1', '24', 'test')
    await node.bgp.removeNetwork('172.16.10.1', '24', 'test')
    await node.bgp.removeNetwork('172.16.10.1', '24') // bare negation arm too (:172-181 keeps it OPTIONAL, unlike ospf's redistribution negate which has no arm at all)
    expect(writeScripts(transport)).toEqual([
      ['enable', 'configure terminal', 'router bgp 65000', 'network 172.16.10.1/24 route-map test'],
      ['enable', 'configure terminal', 'router bgp 65000', 'no network 172.16.10.1/24 route-map test'],
      ['enable', 'configure terminal', 'router bgp 65000', 'no network 172.16.10.1/24'],
    ])
    // The ValueError arms of both tests (:85-88, :96-99), pinned as refusals before any read or write:
    const before = sentScripts(transport).length
    await expectError(() => node.bgp.addNetwork('', '24', 'test'), /may not be empty/)
    await expectError(() => node.bgp.addNetwork('172.16.10.1', '', 'test'), /may not be empty/)
    await expectError(() => node.bgp.removeNetwork('', '24', 'test'), /may not be empty/)
    await expectError(() => node.bgp.removeNetwork('172.16.10.1', '', 'test'), /may not be empty/)
    expect(sentScripts(transport)).toHaveLength(before)
  })

  it('write-argument guards refuse line-unsafe junk pyeapi would interpolate (DR-053 family)', async () => {
    const { node, transport } = nodeFor(BGP_FIXTURE_CONFIG)
    await expectError(() => node.bgp.setRouterId('two words'), /splits the command line|single token/)
    await expectError(() => node.bgp.setRouterId('bad\x07id'), /control character/)
    await expectError(() => node.bgp.addNetwork('two words', '24'), /single token/)
    await expectError(() => node.bgp.addNetwork('10.0.0.0', 'twenty'), /expected digits/)
    await expectError(() => node.bgp.addNetwork('10.0.0.0', '24', 'two words'), /empty value|splits the command line/)
    expect(transport.sent()).toEqual([])
  })
})

describe('BgpNeighborsResource — the sub-collection behind node.bgp.neighbors (bgp.py:182-338)', () => {
  it('the neighbours table is reached through the entity, ONE object, identity-stable (pyeapi\'s _neighbors memo, :55-60; the varp precedent)', () => {
    const { node } = nodeFor(BGP_FIXTURE_CONFIG)
    expect(node.bgp.neighbors).toBe(node.bgp.neighbors)
    expect(node.bgp.constructor.name).toBe('BgpResource')
    expect(node.bgp.neighbors.constructor.name).toBe('BgpNeighborsResource')
    // And it is NOT its own registry row (brief): no name to reach it by.
    expect(node.hasResource('bgpneighbors')).toBe(false)
  })

  it('delete\'s successful first try is exactly upstream\'s text, no fallback (port test_delete, :198-202)', async () => {
    const { node, transport } = nodeFor(BGP_FIXTURE_CONFIG)
    allowWrites(transport, ['router bgp 65000', 'no neighbor test'])
    await node.bgp.neighbors.delete('test')
    expect(writeScripts(transport)).toEqual([['enable', 'configure terminal', 'router bgp 65000', 'no neighbor test']])
  })

  it('delete falls back to the DETECTED group keyword after a device refusal, both batches on the wire (module divergence 11; bgp.py:265-275\'s False-branch retry)', async () => {
    const transport = nodeFor(BGP_FIXTURE_CONFIG).transport
      .rejects(writeKey(['router bgp 65000', 'no neighbor oldpeer']), { code: 1000, message: 'scripted refusal' })
      .replies(writeKey(['router bgp 65000', 'no neighbor oldpeer peer-group']), [{}, {}, {}])
    const node = new Node(transport)
    await node.bgp.neighbors.delete('oldpeer')
    expect(writeScripts(transport)).toEqual([
      ['enable', 'configure terminal', 'router bgp 65000', 'no neighbor oldpeer'],
      ['enable', 'configure terminal', 'router bgp 65000', 'no neighbor oldpeer peer-group'], // fixture block speaks the LEGACY spelling (divergence 8 detection), not the version-string arm
    ])
  })

  it('a modern-spelling block falls back with `peer group`, and a block with NO group lines falls back with the modern floor (divergence 8)', async () => {
    const modern = nodeFor(textOf(['router bgp 2', '   neighbor 10.0.0.2 peer group G1', '!', 'end']))
    modern.transport
      .rejects(writeKey(['router bgp 2', 'no neighbor g1']), { code: 1000, message: 'scripted refusal' })
      .replies(writeKey(['router bgp 2', 'no neighbor g1 peer group']), [{}, {}, {}])
    await modern.node.bgp.neighbors.delete('g1')
    expect(writeScripts(modern.transport).at(-1)).toEqual(['enable', 'configure terminal', 'router bgp 2', 'no neighbor g1 peer group'])

    const silent = nodeFor(textOf(['router bgp 3', '   neighbor 10.0.0.3 remote-as 1', '!', 'end']))
    silent.transport
      .rejects(writeKey(['router bgp 3', 'no neighbor nope']), { code: 1000, message: 'scripted refusal' })
      .replies(writeKey(['router bgp 3', 'no neighbor nope peer group']), [{}, {}, {}])
    await silent.node.bgp.neighbors.delete('nope')
    expect(writeScripts(silent.transport).at(-1)).toEqual(['enable', 'configure terminal', 'router bgp 3', 'no neighbor nope peer group']) // the client-convention default, DR-107 — a device that only speaks the old keyword answers its own CommandError
  })

  it('when the FALLBACK is also refused, its CommandError propagates — upstream\'s `return False` has no home here (module divergence 11, DR-005)', async () => {
    const transport = nodeFor(BGP_FIXTURE_CONFIG).transport
      .rejects(writeKey(['router bgp 65000', 'no neighbor oldpeer']), { code: 1002, message: 'invalid command' })
      .rejects(writeKey(['router bgp 65000', 'no neighbor oldpeer peer-group']), { code: 1002, message: 'still invalid' })
    const thrown = await outcome(() => new Node(transport).bgp.neighbors.delete('oldpeer'))
    expect(thrown).toBeInstanceOf(CommandError)
    expect(writeScripts(transport)).toHaveLength(2) // exactly two attempts, never a third
  })

  it('a transport-level failure is NOT retried — the attempted batch goes out ONCE (only a CommandError earns the fallback), and the write never lands twice', async () => {
    const transport = nodeFor(BGP_FIXTURE_CONFIG).transport.httpStatus(401, '')
    const thrown = await outcome(() => new Node(transport).bgp.neighbors.delete('test'))
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).name).toBe('AuthError')
    // sent() records the ATTEMPTED batch (the command list went through the codec before the
    // scripted 401 mapped to AuthError) — the honest pin is "exactly one attempt": no retry, and
    // of course the batch never actually reached a device.
    expect(writeScripts(transport)).toEqual([['enable', 'configure terminal', 'router bgp 65000', 'no neighbor test']])
  })

  it('setDefault refuses — there is no `default neighbor …` verb upstream to port (the abstract.py:208-224 stub, stp precedent)', async () => {
    const { node, transport } = nodeFor(BGP_FIXTURE_CONFIG)
    await expectError(() => node.bgp.neighbors.setDefault('test'), /no `default neighbor …` verb exists/)
    const thrown = await outcome(() => node.bgp.neighbors.setDefault('test'))
    expect(thrown).toBeInstanceOf(NotSupportedError)
    expect(transport.sent()).toEqual([])
  })

  it('create emits the bare SHUTDOWN, because that is literally how upstream wires it (module divergence 10 / DR-109 keep-faithful; bgp.py:262-264)', async () => {
    const { node, transport } = nodeFor(BGP_FIXTURE_CONFIG)
    allowWrites(transport,
      ['router bgp 65000', 'neighbor newpeer shutdown'],
      ['router bgp 65000', 'no neighbor newpeer shutdown'],
    )
    await node.bgp.neighbors.create('newpeer')
    expect(writeScripts(transport)).toEqual([['enable', 'configure terminal', 'router bgp 65000', 'neighbor newpeer shutdown']])
    // Read it as what it is: `set_shutdown(name, default=False, disable=False)`. The operator who
    // means "this peer is UP" wants the zero-argument arm's text — the verb below.
    await node.bgp.neighbors.unsetShutdown('newpeer')
    expect(writeScripts(transport).at(-1)).toEqual(['enable', 'configure terminal', 'router bgp 65000', 'no neighbor newpeer shutdown'])
  })

  it('peer-group set/negate/default on an ADDRESS name, legacy spelling from the fixture (port test_set_peer_group, :203-228)', async () => {
    const { node, transport } = nodeFor(BGP_FIXTURE_CONFIG)
    allowWrites(transport,
      ['router bgp 65000', 'neighbor 172.16.10.1 peer-group test'],
      ['router bgp 65000', 'no neighbor 172.16.10.1 peer-group'],
      ['router bgp 65000', 'default neighbor 172.16.10.1 peer-group'],
    )
    await node.bgp.neighbors.setPeerGroup('172.16.10.1', 'test')
    await node.bgp.neighbors.unsetPeerGroup('172.16.10.1') // upstream pins this EXACT text for its value-None fall-through too (:224-228)
    await node.bgp.neighbors.defaultPeerGroup('172.16.10.1')
    expect(writeScripts(transport)).toEqual([
      ['enable', 'configure terminal', 'router bgp 65000', 'neighbor 172.16.10.1 peer-group test'],
      ['enable', 'configure terminal', 'router bgp 65000', 'no neighbor 172.16.10.1 peer-group'],
      ['enable', 'configure terminal', 'router bgp 65000', 'default neighbor 172.16.10.1 peer-group'],
    ])
  })

  it('setPeerGroup on a GROUP-shaped name refuses out loud — upstream\'s silent False, asserted (module divergence 12)', async () => {
    const { node, transport } = nodeFor(BGP_FIXTURE_CONFIG)
    await expectError(() => node.bgp.neighbors.setPeerGroup('test', 'other'), /not an address/)
    await expectError(() => node.bgp.neighbors.unsetPeerGroup('test'), /not an address/)
    await expectError(() => node.bgp.neighbors.defaultPeerGroup('test'), /not an address/)
    expect(transport.sent()).toEqual([]) // and the refusal is guard-cheap: zero reads, zero writes
  })

  it('remote-as takes any name (no address gate — that is ONLY the peer-group verb), value as string or number (port test_set_remote_as, :229-253)', async () => {
    const { node, transport } = nodeFor(BGP_FIXTURE_CONFIG)
    allowWrites(transport,
      ['router bgp 65000', 'neighbor test remote-as 65000'],
      ['router bgp 65000', 'neighbor test remote-as 65001'],
      ['router bgp 65000', 'no neighbor test remote-as'],
      ['router bgp 65000', 'default neighbor test remote-as'],
    )
    await node.bgp.neighbors.setRemoteAs('test', '65000')
    await node.bgp.neighbors.setRemoteAs('test', 65001) // a number normalizes to the same token the reader keeps as .*(s :218)
    await node.bgp.neighbors.unsetRemoteAs('test') // (…,"" disable arm AND the value-None fall-through :248-252)
    await node.bgp.neighbors.defaultRemoteAs('test')
    expect(writeScripts(transport)).toEqual([
      ['enable', 'configure terminal', 'router bgp 65000', 'neighbor test remote-as 65000'],
      ['enable', 'configure terminal', 'router bgp 65000', 'neighbor test remote-as 65001'],
      ['enable', 'configure terminal', 'router bgp 65000', 'no neighbor test remote-as'],
      ['enable', 'configure terminal', 'router bgp 65000', 'default neighbor test remote-as'],
    ])
  })

  it('neighbour shutdown trio, texts from the four-state loop (port test_set_shutdown, :254-272 — "negate" and "false" ARE the same verb)', async () => {
    const { node, transport } = nodeFor(BGP_FIXTURE_CONFIG)
    allowWrites(transport,
      ['router bgp 65000', 'neighbor test shutdown'],
      ['router bgp 65000', 'no neighbor test shutdown'],
      ['router bgp 65000', 'default neighbor test shutdown'],
    )
    await node.bgp.neighbors.setShutdown('test') // config arm: default=False, disable=False (:257-259)
    await node.bgp.neighbors.unsetShutdown('test') // the PARAMETER DEFAULT arm (bgp.py:303, disable=True) and the duplicate 'false' state
    await node.bgp.neighbors.defaultShutdown('test') // default=True arm
    expect(writeScripts(transport)).toEqual([
      ['enable', 'configure terminal', 'router bgp 65000', 'neighbor test shutdown'],
      ['enable', 'configure terminal', 'router bgp 65000', 'no neighbor test shutdown'],
      ['enable', 'configure terminal', 'router bgp 65000', 'default neighbor test shutdown'],
    ])
  })

  it('send-community bare/armed/negate/default (port test_set_send_community, :273-298 — incl. its value=False+default=True oddity)', async () => {
    const { node, transport } = nodeFor(BGP_FIXTURE_CONFIG)
    allowWrites(transport,
      ['router bgp 65000', 'neighbor test send-community'],
      ['router bgp 65000', 'no neighbor test send-community'],
      ['router bgp 65000', 'default neighbor test send-community'],
    )
    await node.bgp.neighbors.setSendCommunity('test', true) // the upstream config arm spells value=True (:276-281) — the bare command
    await node.bgp.neighbors.unsetSendCommunity('test') // disable arm, and the value-None fall-through (:293-298)
    await node.bgp.neighbors.defaultSendCommunity('test') // upstream passes value=False WITH default=True (:288-291): DR-037 precedence makes the value moot
    expect(writeScripts(transport)).toEqual([
      ['enable', 'configure terminal', 'router bgp 65000', 'neighbor test send-community'],
      ['enable', 'configure terminal', 'router bgp 65000', 'no neighbor test send-community'],
      ['enable', 'configure terminal', 'router bgp 65000', 'default neighbor test send-community'],
    ])
  })

  it('next-hop-self trio (port test_set_next_hop_self, :299-324)', async () => {
    const { node, transport } = nodeFor(BGP_FIXTURE_CONFIG)
    allowWrites(transport,
      ['router bgp 65000', 'neighbor test next-hop-self'],
      ['router bgp 65000', 'no neighbor test next-hop-self'],
      ['router bgp 65000', 'default neighbor test next-hop-self'],
    )
    await node.bgp.neighbors.setNextHopSelf('test', true)
    await node.bgp.neighbors.unsetNextHopSelf('test')
    await node.bgp.neighbors.defaultNextHopSelf('test')
    expect(writeScripts(transport)).toEqual([
      ['enable', 'configure terminal', 'router bgp 65000', 'neighbor test next-hop-self'],
      ['enable', 'configure terminal', 'router bgp 65000', 'no neighbor test next-hop-self'],
      ['enable', 'configure terminal', 'router bgp 65000', 'default neighbor test next-hop-self'],
    ])
  })

  it('route-map in/out keep the direction suffix OUTSIDE the negate/default prefix (port test_set_route_map_in/out, :325-376)', async () => {
    const { node, transport } = nodeFor(BGP_FIXTURE_CONFIG)
    allowWrites(transport,
      ['router bgp 65000', 'neighbor test route-map TEST_RM in'],
      ['router bgp 65000', 'no neighbor test route-map in'],
      ['router bgp 65000', 'default neighbor test route-map in'],
      ['router bgp 65000', 'neighbor test route-map TEST_RM out'],
      ['router bgp 65000', 'no neighbor test route-map out'],
      ['router bgp 65000', 'default neighbor test route-map out'],
    )
    await node.bgp.neighbors.setRouteMapIn('test', 'TEST_RM')
    await node.bgp.neighbors.unsetRouteMapIn('test') // `no neighbor test route-map in` — the pinned oddity of suffix-after-builder (:324-326)
    await node.bgp.neighbors.defaultRouteMapIn('test') // `default neighbor test route-map in` (:336-340)
    await node.bgp.neighbors.setRouteMapOut('test', 'TEST_RM')
    await node.bgp.neighbors.unsetRouteMapOut('test')
    await node.bgp.neighbors.defaultRouteMapOut('test')
    expect(writeScripts(transport)).toEqual([
      ['enable', 'configure terminal', 'router bgp 65000', 'neighbor test route-map TEST_RM in'],
      ['enable', 'configure terminal', 'router bgp 65000', 'no neighbor test route-map in'],
      ['enable', 'configure terminal', 'router bgp 65000', 'default neighbor test route-map in'],
      ['enable', 'configure terminal', 'router bgp 65000', 'neighbor test route-map TEST_RM out'],
      ['enable', 'configure terminal', 'router bgp 65000', 'no neighbor test route-map out'],
      ['enable', 'configure terminal', 'router bgp 65000', 'default neighbor test route-map out'],
    ])
  })

  it('description keeps multi-word values whole (port test_set_description, :377-391 — the three-word value)', async () => {
    const { node, transport } = nodeFor(BGP_FIXTURE_CONFIG)
    allowWrites(transport,
      ['router bgp 65000', 'neighbor test description this is a test'],
      ['router bgp 65000', 'no neighbor test description'],
      ['router bgp 65000', 'default neighbor test description'],
    )
    await node.bgp.neighbors.setDescription('test', 'this is a test')
    await node.bgp.neighbors.unsetDescription('test')
    await node.bgp.neighbors.defaultDescription('test')
    expect(writeScripts(transport)).toEqual([
      ['enable', 'configure terminal', 'router bgp 65000', 'neighbor test description this is a test'],
      ['enable', 'configure terminal', 'router bgp 65000', 'no neighbor test description'],
      ['enable', 'configure terminal', 'router bgp 65000', 'default neighbor test description'],
    ])
  })

  it('name guards: whitespace/control/empty refuse BEFORE any round trip; a BGP-less neighbour write reports the same loud "not configured"', async () => {
    const { node, transport } = nodeFor(BGP_FIXTURE_CONFIG)
    await expectError(() => node.bgp.neighbors.setRemoteAs('two words', '1'), /splits the command line|one token/)
    await expectError(() => node.bgp.neighbors.setShutdown(''), /empty name composes/)
    await expectError(() => node.bgp.neighbors.delete('bad\x07name'), /control character/)
    await expectError(() => node.bgp.neighbors.setDescription('test', ' padded '), /outer whitespace/)
    // The remainder/token guards’ own branches (empty, non-string, NaN):
    await expectError(() => node.bgp.neighbors.setRemoteAs('test', ''), /empty remainder/)
    await expectError(() => node.bgp.neighbors.setRemoteAs('test', {} as unknown as string | number), /expected a string/)
    await expectError(() => node.bgp.setMaximumPaths(Number.NaN), /safe non-negative integer/)
    await expectError(() => node.bgp.neighbors.setPeerGroup('172.16.10.1', 5 as unknown as string), /expected a string token/)
    expect(transport.sent()).toEqual([])

    const neg = nodeFor(NO_BGP_CONFIG)
    await expectError(() => neg.node.bgp.neighbors.setShutdown('test'), /bgp is not configured/)
    expect(writeScripts(neg.transport)).toEqual([])
  })

  it('the neighbours table also answers for an explicitly fetched getAll with names FROM negation lines (getall grammar, bgp.py:203)', async () => {
    const neighbors = await nodeFor(BGP_FIXTURE_CONFIG).node.bgp.neighbors.getAll()
    expect(neighbors.size).toBe(3)
    expect(await nodeFor(BGP_FIXTURE_CONFIG).node.bgp.neighbors.get('nobody')).toBeUndefined() // upstream answers the all-None phantom; this port says absence (module divergence 1)
  })

  it('a second bgp process section (vrf) is NOT read — upstream\'s get_block picks the FIRST block, both halves (:68, :199)', async () => {
    const two = await nodeFor(textOf([
      'router bgp 1',
      '   neighbor first remote-as 1',
      '!',
      'router bgp 1 vrf CUSTOMER',
      '   neighbor second remote-as 2',
      '!',
      'end',
    ])).node.bgp.get()
    expect([...two?.neighbors.keys() ?? []]).toEqual(['first'])
    expect(two?.networks).toEqual([])
  })
})

describe('BgpResource registry wiring — rows for this lane (DR-006/DR-052; neighbours stay a sub-collection)', () => {
  it('node.bgp is the memoised registry instance and node.bgp.neighbors hangs off it', () => {
    const { node } = nodeFor(BGP_FIXTURE_CONFIG)
    expect(node.bgp).toBe(node.bgp)
    expect(node.bgp).toBe(node.resource('bgp'))
    expect(node.bgp.constructor.name).toBe('BgpResource')
    expect(node.hasResource('bgp')).toBe(true)
    expect(node.bgp.neighbors).toBe(node.bgp.neighbors)
  })
})
