/**
 * `StaticRouteResource` — W2d (#42), the IPv4 static-route module on the M7 framework, sibling of
 * `vlans.ts`/`vrfs.ts`. `node.staticroute` over `MockTransport`: reads answer device text, writes pin
 * exact joined command lists (docs/TESTING.md §3, DR-083). Config is **inline and hand-authored**,
 * deliberately not new files under `test/fixtures/config/` — the W2 lanes edit that directory's
 * `manifest.json` in parallel and a fourth writer would collide (same reasoning as `vrfs.test.ts`).
 * Provenance: hand-written from the route lines in pyeapi's own
 * `test/fixtures/running_config.text:2045-2048` and from `ROUTES_RE` (`staticroute.py:68-74`) — never
 * captured from the 7050TX-64, and no EOS-side acceptance is claimed (M12 #14 owns that).
 *
 * ## Upstream port ledger
 *
 * `pyeapi/test/unit/test_api_staticroute.py` has **8** test methods (verified in the pinned clone on
 * 2026-11-06): `test_instance` (`:53-54`), `test_get` (`:56-101`), `test_getall` (`:103-150`),
 * `test_create` (`:152-189`), `test_delete` (`:191-226`), `test_default` (`:228-263`),
 * `test_set_tag` (`:265-281`), `test_set_route_name` (`:283-299`). All eight land: `test_instance`
 * through the registry/index pins (`registry.test.ts`, `index.test.ts` — the sixth row), the other
 * seven below with the pinned command texts reproduced verbatim. The randomized
 * `choice`/`random_int`/`random_string` loops (create/delete/default) become deterministic cases —
 * one full-parameter line, one bare line, and the `0` arms made explicit rather than sampled.
 *  - `test_get`/`test_getall` — the fixture's four routes (two destinations) answer field-for-field,
 *    except that upstream's `None`-where-absent (`next_hop_ip`/`tag`/`route_name`) and `int` leaf keys
 *    (`distance`) become absent optional fields and a `distance` number (divergence 2).
 *  - `test_create` (`:152-189`) / `test_delete` (`:191-226`) / `test_default` (`:228-263`) —
 *    `ip route …` / `no ip route …` / `default ip route …` composed in the fixed segment order;
 *    `_build_commands:317`+`:322-327` and `_set_route:356-361` are the shape.
 *  - `test_set_tag` (`:265-281`) — `ip route 1.2.3.0/24 Ethernet1 1.1.1.1 10 tag 99`, string `'99'`
 *    accepted exactly as upstream's test spells it; `test_set_route_name` (`:283-299`) —
 *    `… name test99`.
 *
 * Everything EOS-side — whether `default ip route` really equals `no ip route` on 4.28
 * (upstream asserts the equivalence in a *docstring*, `:50-52`), whether the image ever runs a route
 * line without a distance, whether `ipv6 route` belongs in this module at all — is **not** claimed
 * here: unverified on hardware, M12 (#14) to capture.
 */

import { describe, expect, it } from 'vitest'

import { Node } from '../command-layer'
import { CommandError, EapiErrorCode, NotSupportedError } from '../errors'
import { mockTransport, type MockTransport } from '../testing/mock-transport'
import type { StaticRoute, StaticRouteResource } from './staticroute'

/** Join lines into config text so a trailing-space line cannot be lost to an editor. */
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

function outcome(fn: () => Promise<unknown>): Promise<unknown> {
  return fn().then(() => 'resolved' as const, (thrown: unknown) => thrown)
}

async function expectError(fn: () => Promise<unknown>, message: RegExp): Promise<void> {
  const thrown = await outcome(fn)
  expect(thrown, 'expected a rejection').toBeInstanceOf(Error)
  expect((thrown as Error).message).toMatch(message)
}

/**
 * Hand-authored from `pyeapi/test/fixtures/running_config.text:2045-2048` — the four route lines the
 * upstream suite asserts against, reduced to what this module reads. `0.0.0.0/0` exercises the
 * no-next-hop-ip slot AND `tag 0` (upstream reads it via `int('0')`, staticroute.py:166); `1.2.3.0/24`
 * exercises the multiple-next-hops-per-destination nesting and `name`.
 */
const ROUTES_CONFIG = textOf([
  'hostname lab-sw1',
  '!',
  'ip route 0.0.0.0/0 192.68.1.254 1 tag 0',
  'ip route 1.2.3.0/24 Ethernet1 1.1.1.1 1 tag 1 name test1',
  'ip route 1.2.3.0/24 Ethernet1 1.1.1.1 10 tag 1 name test1',
  'ip route 1.2.3.0/24 Ethernet1 10.1.1.1 20 tag 1 name test1',
  '!',
  'end',
])

const routesFor = (config: string): StaticRouteResource => nodeFor(config).node.staticroute

describe('StaticRouteResource reads — staticroute.py:123-179 + the DR-030 read budget', () => {
  it('the pinned fixture answers both destinations in one read (ports test_getall, :103-150)', async () => {
    const { node, transport } = nodeFor(ROUTES_CONFIG)
    const all = await node.staticroute.getAll()
    expect([...all.keys()]).toEqual(['0.0.0.0/0', '1.2.3.0/24'])
    // Upstream's 0.0.0.0/0 entry is the chain {'192.68.1.254': {None: {1: {'tag': 0, 'route_name': None}}}}
    // (:158-176) — the None KEY and the int KEY become absence and a number field (divergence 2),
    // and `tag 0` stays 0, NOT None: the falsy segment was already None-checked upstream (:166).
    expect(all.get('0.0.0.0/0')).toEqual<readonly StaticRoute[]>([
      { ipDest: '0.0.0.0/0', nextHop: '192.68.1.254', distance: 1, tag: 0 },
    ])
    // Three routes under one destination: the nesting upstream carries as two dict levels
    // (next_hop Ethernet1 → next_hop_ip 1.1.1.1/10.1.1.1 → distance leaves) becomes a flat list.
    expect(all.get('1.2.3.0/24')).toEqual<readonly StaticRoute[]>([
      { ipDest: '1.2.3.0/24', nextHop: 'Ethernet1', nextHopIp: '1.1.1.1', distance: 1, tag: 1, routeName: 'test1' },
      { ipDest: '1.2.3.0/24', nextHop: 'Ethernet1', nextHopIp: '1.1.1.1', distance: 10, tag: 1, routeName: 'test1' },
      { ipDest: '1.2.3.0/24', nextHop: 'Ethernet1', nextHopIp: '10.1.1.1', distance: 20, tag: 1, routeName: 'test1' },
    ])
    expect(transport.bodies()).toHaveLength(1)
    expect(transport.callCount()).toBe(1)
  })

  it('get answers the destination bucket, and an unknown destination is undefined (port test_get, :56-101)', async () => {
    const { node, transport } = nodeFor(ROUTES_CONFIG)
    expect(await node.staticroute.get('1.2.3.0/24')).toHaveLength(3)
    await node.staticroute.getAll()
    // Upstream: `getall().get('nope')` is None (the ONLY thing get does, :121); here undefined (DR-027),
    // and the shared memo keeps this at one device request total.
    expect(await node.staticroute.get('9.9.9.0/24')).toBeUndefined()
    expect(await node.staticroute.has('0.0.0.0/0')).toBe(true)
    expect([...(await node.staticroute.keys())]).toEqual(['0.0.0.0/0', '1.2.3.0/24'])
    expect(transport.callCount()).toBe(1)
  })

  it('an identical route line twice is ONE entry, the last line winning (divergence 2 — the dict assignments at :170-176)', async () => {
    const all = await routesFor(textOf([
      'ip route 5.0.0.0/8 1.1.1.1 5 tag 1 name first',
      'ip route 5.0.0.0/8 1.1.1.1 5 tag 2 name second',
      'end',
    ])).getAll()
    expect(all.get('5.0.0.0/8')).toEqual<readonly StaticRoute[]>([
      { ipDest: '5.0.0.0/8', nextHop: '1.1.1.1', distance: 5, tag: 2, routeName: 'second' },
    ])
    // A DIFFERENT distance is a different leaf key (:176) — both survive, as the pinned fixture's
    // 1/10 pair under 1.1.1.1 shows.
    const both = await routesFor(textOf([
      'ip route 5.0.0.0/8 1.1.1.1 5',
      'ip route 5.0.0.0/8 1.1.1.1 10',
      'end',
    ])).getAll()
    expect(both.get('5.0.0.0/8')?.map((r) => r.distance)).toEqual([5, 10])
  })

  it('no distance, or a vrf/ip route vrf header, or a bare `ip route` — invisible to BOTH grammars (divergence 6)', async () => {
    const all = await routesFor(textOf([
      'ip route 7.7.7.0/24 9.9.9.9',
      'ip route vrf red 8.8.8.0/24 1.1.1.1 1',
      'ip route',
      'ip route 2001:db8::/32 2001:db8::1 1',
      'end',
    ])).getAll()
    // ROUTES_RE's distance group is REQUIRED (:72) and the dest group must sit right behind the header
    // (:69), so pyeapi also answers {} for every line above — the VRF and IPv6 leaks are upstream shape,
    // pinned so nobody "fixes" the read silently (write verbs still SEND such grammars' lines, so the
    // leak stays visible in both languages: DR-100's "not fixed" note).
    expect([...all.keys()]).toEqual([])
  })

  it('a column-0 route line inside a banner body never votes (divergence 1 — pyeapi findall would read it)', async () => {
    const all = await routesFor(textOf([
      'banner login',
      'ip route 6.6.6.0/24 1.1.1.1 1',
      'EOF',
      '!',
      'ip route 7.7.7.0/24 2.2.2.2 1',
      'end',
    ])).getAll()
    expect([...all.keys()]).toEqual(['7.7.7.0/24'])
    // Upstream's findall over the raw config with re.M (:152) takes the banner line as a route and
    // then get_block never finds it; the chunker keys only the real leaf line.
  })

  it('trailing text past the last known segment is ignored, and tag/name order is FIXED (end-open grammar, :68-74)', async () => {
    const all = await routesFor(textOf([
      'ip route 9.9.9.0/24 1.2.3.4 5 extra junk here',
      'ip route 9.9.8.0/24 1.2.3.4 5 name foo tag 7',
      'end',
    ])).getAll()
    // No anchor at the end of ROUTES_RE, so both lines parse up to what the fixed order recognises:
    // the first stops after distance 5; the second's `tag 7` after `name foo` is trailing text.
    expect(all.get('9.9.9.0/24')).toEqual<readonly StaticRoute[]>([
      { ipDest: '9.9.9.0/24', nextHop: '1.2.3.4', distance: 5 },
    ])
    expect(all.get('9.9.8.0/24')).toEqual<readonly StaticRoute[]>([
      { ipDest: '9.9.8.0/24', nextHop: '1.2.3.4', distance: 5, routeName: 'foo' },
    ])
  })

  it('a config with no route sections answers an empty table, not a crash', async () => {
    const all = await routesFor(textOf(['hostname lab-sw1', '!', 'end'])).getAll()
    expect(all.size).toBe(0)
  })
})

describe('StaticRouteResource writes — _build_commands/_set_route (:299-371), one line per transaction', () => {
  it('create with every honoured kwarg composes the fixed segment order (port test_create, :152-189)', async () => {
    const { node, transport } = nodeFor(ROUTES_CONFIG)
    const cmds = ['ip route 11.111.11.0/24 Ethernet2 2.2.2.2 5 tag 42 name netB']
    transport.replies(writeKey(cmds), [{}, {}, {}])
    await node.staticroute.create('11.111.11.0/24', {
      nextHop: 'Ethernet2',
      nextHopIp: '2.2.2.2',
      distance: 5,
      tag: 42,
      routeName: 'netB',
    })
    expect(sentScripts(transport).at(-1)).toEqual(['enable', 'configure terminal', ...cmds])
    // Upstream's test builds the SAME string by appending `… %s`, `… tag %d`, `… name %s` (:169-176)
    // — the segment order dest, next-hop, next-hop-ip, distance, tag, name is its regex's order too.
    // And a route write never reads first: staticroute needs no config probe for its commands.
    const fresh = mockTransport().replies(writeKey(cmds), [{}, {}, {}])
    await new Node(fresh).staticroute.create('11.111.11.0/24', {
      nextHop: 'Ethernet2', nextHopIp: '2.2.2.2', distance: 5, tag: 42, routeName: 'netB',
    })
    expect(fresh.callCount()).toBe(1)
  })

  it('create with just the two positional parts sends the bare line (the None kwargs add nothing, :322-327)', async () => {
    const { node, transport } = nodeFor(ROUTES_CONFIG)
    const cmds = ['ip route 222.22.222.0/24 Null0']
    transport.replies(writeKey(cmds), [{}, {}, {}])
    await node.staticroute.create('222.22.222.0/24', { nextHop: 'Null0' })
    expect(sentScripts(transport).at(-1)).toEqual(['enable', 'configure terminal', ...cmds])
  })

  it('0 survives composition on the write side too — the is-not-None arms, unlike command_builder truthiness (divergence 3)', async () => {
    const { node, transport } = nodeFor(ROUTES_CONFIG)
    const cmds = ['ip route 0.0.0.0/0 192.68.1.254 0 tag 0']
    transport.replies(writeKey(cmds), [{}, {}, {}])
    // `_build_commands` checks `is not None` for distance (:323) and tag (:325) — NOT truthiness —
    // so upstream sends `0`/`tag 0` here, and the fixture's `tag 0` line is the same fact on the read
    // side (`None if match[4] == '' else int(...)`, :166). This is the one write path in this module
    // family where Python falsiness and pyeapi AGREE that zero is a value; `vrfs.create`'s `if rd:`
    // (:173) and `abstract.py:158` are the ones DR-037 repairs, and they are ported elsewhere.
    await node.staticroute.create('0.0.0.0/0', { nextHop: '192.68.1.254', distance: 0, tag: 0 })
    expect(sentScripts(transport).at(-1)).toEqual(['enable', 'configure terminal', ...cmds])
    // And the line this write would produce in a device answers this client reads back as zeros:
    const roundTrip = await routesFor(textOf([cmds[0] as string, 'end'])).get('0.0.0.0/0')
    expect(roundTrip).toEqual<readonly StaticRoute[]>([
      { ipDest: '0.0.0.0/0', nextHop: '192.68.1.254', distance: 0, tag: 0 },
    ])
  })

  it('delete prefixes the WHOLE composed line with no — kwargs.update delete=True at :222 (port test_delete, :191-226)', async () => {
    const { node, transport } = nodeFor(ROUTES_CONFIG)
    const cmds = ['no ip route 33.34.35.0/24 44.44.44.0 20 tag 1 name test1']
    transport.replies(writeKey(cmds), [{}, {}, {}])
    await node.staticroute.delete('33.34.35.0/24', {
      nextHop: '44.44.44.0',
      distance: 20,
      tag: 1,
      routeName: 'test1',
    })
    expect(sentScripts(transport).at(-1)).toEqual(['enable', 'configure terminal', ...cmds])
    // No existence check precedes it (divergence 5): upstream NEVER verifies the route is there, and
    // an under-specified delete targets a different whole-line match — both stay as upstream wrote them.
    const fresh = mockTransport().replies(writeKey(cmds), [{}, {}, {}])
    await new Node(fresh).staticroute.delete('33.34.35.0/24', { nextHop: '44.44.44.0', distance: 20, tag: 1, routeName: 'test1' })
    expect(fresh.callCount()).toBe(1)
  })

  it('setDefault is the default-prefixed twin — flag at :244; the equivalence note stays a docstring (port test_default, :228-263)', async () => {
    const { node, transport } = nodeFor(ROUTES_CONFIG)
    const cmds = ['default ip route 33.34.35.0/24 44.44.44.0']
    transport.replies(writeKey(cmds), [{}, {}, {}])
    await node.staticroute.setDefault('33.34.35.0/24', { nextHop: '44.44.44.0' })
    expect(sentScripts(transport).at(-1)).toEqual(['enable', 'configure terminal', ...cmds])
    // staticroute.py:50-52 asserts the two forms are "currently equivalent" — the port does NOT
    // collapse them, and whether 4.28 still agrees is M12's (#14) capture.
  })

  it('setTag re-sends the line with tag, accepting the string spelling upstream pins (port test_set_tag, :265-281)', async () => {
    const { node, transport } = nodeFor(ROUTES_CONFIG)
    const cmds = ['ip route 1.2.3.0/24 Ethernet1 1.1.1.1 10 tag 99']
    transport.replies(writeKey(cmds), [{}, {}, {}])
    // test_api_staticroute.py:272-277 spells tag as the STRING '99' and distance as the int 10 —
    // `_build_commands` interpolates both, so both spellings compose the same line here.
    await node.staticroute.setTag('1.2.3.0/24', 'Ethernet1', { nextHopIp: '1.1.1.1', distance: 10, tag: '99' })
    expect(sentScripts(transport).at(-1)).toEqual(['enable', 'configure terminal', ...cmds])
    // set_tag FORCES nothing (upstream just passes kwargs through, :271): leaving `tag` out of the
    // bag-shaped argument is a TS compile error here, and the runtime guard below refuses a bag
    // without it arriving from JS.
  })

  it('setRouteName re-sends the line with name (port test_set_route_name, :283-299)', async () => {
    const { node, transport } = nodeFor(ROUTES_CONFIG)
    const cmds = ['ip route 1.2.3.0/24 Ethernet1 1.1.1.1 10 name test99']
    transport.replies(writeKey(cmds), [{}, {}, {}])
    await node.staticroute.setRouteName('1.2.3.0/24', 'Ethernet1', { nextHopIp: '1.1.1.1', distance: 10, routeName: 'test99' })
    expect(sentScripts(transport).at(-1)).toEqual(['enable', 'configure terminal', ...cmds])
  })

  it('the module docstring warning stays true: setTag without the other fields resets what is not restated — this client cannot see that coming', async () => {
    // Upstream's Notes (:262-264, :288-291): "Any existing route_name value must be included in call
    // to set_tag, otherwise the tag will be reset by the call to EOS". The line IS a full replacement
    // in both grammars — a bare `ip route dest hop tag N` drops distance defaults and names — so the
    // honest port keeps the same single-line behaviour and this test pins that the client sends
    // exactly the sparse line the caller asked for, warnings and all (no silent field carry-over —
    // the read side is not consulted for writes, divergence 5).
    const { node, transport } = nodeFor(ROUTES_CONFIG)
    const cmds = ['ip route 1.2.3.0/24 Ethernet1 3 tag 1']
    transport.replies(writeKey(cmds), [{}, {}, {}])
    await node.staticroute.setTag('1.2.3.0/24', 'Ethernet1', { distance: 3, tag: 1 })
    expect(sentScripts(transport).at(-1)).toEqual(['enable', 'configure terminal', ...cmds])
  })

  it('a device refusal on a route write surfaces as CommandError with the whole line (DR-005)', async () => {
    const line = 'ip route 1.2.3.0/24 Ethernet1'
    const transport = mockTransport().rejects(writeKey([line]), {
      code: EapiErrorCode.COMMAND_INVALID,
      message: "CLI command 3 of 3 'ip route 1.2.3.0/24 Ethernet1' failed: invalid input (interpreted)",
    })
    const thrown = await outcome(() => new Node(transport).staticroute.create('1.2.3.0/24', { nextHop: 'Ethernet1' }))
    expect(thrown).toBeInstanceOf(CommandError)
    expect((thrown as CommandError).failedCommand).toBe(line)
    // Whether THAT is the sentence 4.28 says for a distance-less route (which this client would send
    // if asked to, and both grammars then fail to read back — divergence 6) is M12's (#14) capture;
    // the envelope shape, not the wording, is what this pins.
  })
})

describe('StaticRouteResource guards — staticroute.py validates nothing; refusals cost zero round trips (divergence 4)', () => {
  it('the next hop is required on every collection verb, before any read (upstream has it positional, :182/:203/:225)', async () => {
    const { node, transport } = nodeFor(ROUTES_CONFIG)
    const staticroute = node.staticroute
    await expectError(() => staticroute.create('1.2.3.0/24', {}), /attrs.nextHop is required/)
    await expectError(() => staticroute.create('1.2.3.0/24'), /attrs.nextHop is required/)
    await expectError(() => staticroute.delete('1.2.3.0/24', { distance: 5 }), /attrs.nextHop is required/)
    await expectError(() => staticroute.delete('1.2.3.0/24'), /attrs.nextHop is required/)
    await expectError(() => staticroute.setDefault('1.2.3.0/24'), /attrs.nextHop is required/)
    // Non-string positional-shaped entries ride the same guard family (upstream interpolates them,
    // staticroute.py:317): the bag spellings a JS caller can produce must refuse, not compose.
    await expectError(() => staticroute.create('1.2.3.0/24', { nextHop: 7 as unknown as string }), /expected a string interface name or address/)
    await expectError(() => staticroute.create('1.2.3.0/24', { nextHop: 'Ethernet1', nextHopIp: 7 as unknown as string }), /expected a string dotted address/)
    // Upstream's `set_tag` forces NOTHING — it is plain `_set_route` pass-through (`:271`), so a JS
    // caller who bypasses this client's required-`tag` signature gets exactly the sparse line upstream
    // would compose: the typed field documents the intent, the runtime invents nothing.
    const looseCmds = ['ip route 1.2.3.0/24 Ethernet1 5']
    transport.replies(writeKey(looseCmds), [{}, {}, {}])
    const loose = staticroute.setTag as unknown as (d: string, n: string, f: Record<string, unknown>) => Promise<void>
    await loose.call(staticroute, '1.2.3.0/24', 'Ethernet1', { distance: 5 })
    expect(sentScripts(transport).at(-1)).toEqual(['enable', 'configure terminal', ...looseCmds])
  })

  it('destinations outside the reader’s own shape are refused on every verb', async () => {
    const { node, transport } = nodeFor(ROUTES_CONFIG)
    const staticroute = node.staticroute
    const badDests: readonly unknown[] = ['10.0.0.0/8 extra', 'has space', '10.0.0.0', '/24', '2001:db8::/32', 'fe80::1/10', '', 7, null, undefined]
    for (const bad of badDests) {
      await expectError(() => staticroute.get(bad as string), /invalid static-route destination/)
      await expectError(() => staticroute.create(bad as string, { nextHop: 'Ethernet1' }), /invalid static-route destination/)
      await expectError(() => staticroute.delete(bad as string, { nextHop: 'Ethernet1' }), /invalid static-route destination/)
      await expectError(() => staticroute.setDefault(bad as string, { nextHop: 'Ethernet1' }), /invalid static-route destination/)
    }
    // The IPv6 refusals quote this module’s own scope, not an EOS claim (staticroute.py:68-74 has no
    // v6 grammar at all — divergence 4).
    await expectError(() => staticroute.get('2001:db8::/32'), /IPv6 static routes are outside this module/)
    expect(transport.sent()).toEqual([])
  })

  it('next hop and next-hop-ip refuse what the composed line or the reader could not echo back', async () => {
    const { node, transport } = nodeFor(ROUTES_CONFIG)
    const staticroute = node.staticroute
    await expectError(() => staticroute.create('1.2.3.0/24', { nextHop: '' }), /invalid static-route next hop/)
    await expectError(() => staticroute.create('1.2.3.0/24', { nextHop: 'has space' }), /splits the line/)
    await expectError(() => staticroute.create('1.2.3.0/24', { nextHop: 'Eth\x07ernet1' }), /control characters/)
    await expectError(() => staticroute.create('1.2.3.0/24', { nextHop: 'Ethernet1', nextHopIp: 'Ethernet1' }), /invalid static-route next-hop-ip/)
    await expectError(() => staticroute.create('1.2.3.0/24', { nextHop: 'Ethernet1', nextHopIp: '1.2.3' }), /dotted A.B.C.D group/)
    // Upstream would INTERPOLATE all of the above (staticroute.py:317/:322) and its next sweep would
    // either skip the mangled line or re-parse a different route than was written.
    expect(transport.sent()).toEqual([])
  })

  it('distance and tag accept zero, refuse everything the \\d+ groups could not produce', async () => {
    const { node, transport } = nodeFor(ROUTES_CONFIG)
    const staticroute = node.staticroute
    await expectError(() => staticroute.create('1.2.3.0/24', { nextHop: 'Ethernet1', distance: -1 }), /unsigned integer/)
    await expectError(() => staticroute.create('1.2.3.0/24', { nextHop: 'Ethernet1', distance: 1.5 }), /unsigned integer/)
    await expectError(() => staticroute.create('1.2.3.0/24', { nextHop: 'Ethernet1', tag: NaN }), /unsigned integer/)
    await expectError(() => staticroute.create('1.2.3.0/24', { nextHop: 'Ethernet1', tag: Infinity }), /unsigned integer/)
    await expectError(() => staticroute.create('1.2.3.0/24', { nextHop: 'Ethernet1', tag: 10n as unknown as number }), /number or digit string/)
    await expectError(() => staticroute.create('1.2.3.0/24', { nextHop: 'Ethernet1', distance: null as unknown as number }), /number or digit string/)
    await expectError(() => staticroute.create('1.2.3.0/24', { nextHop: 'Ethernet1', tag: '9 9' }), /digits the \\d\+ group/)
    await expectError(() => staticroute.create('1.2.3.0/24', { nextHop: 'Ethernet1', distance: Number.MAX_SAFE_INTEGER + 2 }), /unsigned integer/)
    // 0 reaches the wire (divergence 3) and digit strings ride upstream's own sloppy spelling —
    // leading zeros included, since `010` matches \\d+ and int('010') is 10 upstream (staticroute.py:162).
    const cmds = ['ip route 1.2.3.0/24 Ethernet1 0 tag 010']
    transport.replies(writeKey(cmds), [{}, {}, {}])
    await staticroute.create('1.2.3.0/24', { nextHop: 'Ethernet1', distance: 0, tag: '010' })
    expect(sentScripts(transport).at(-1)).toEqual(['enable', 'configure terminal', ...cmds])
    // The reader side of the same fact (the mock’s config text never changes; read a fresh node whose
    // answer carries that line): \d+ matches the digits, the value becomes the number pyeapi’s int() gives.
    const roundTrip = await routesFor(textOf([cmds[0] as string, 'end'])).getAll()
    expect(roundTrip.get('1.2.3.0/24')).toEqual<readonly StaticRoute[]>([
      { ipDest: '1.2.3.0/24', nextHop: 'Ethernet1', distance: 0, tag: 10 },
    ])
  })

  it('route names are single tokens; empty ones are refused rather than trailing a space', async () => {
    const { node, transport } = nodeFor(ROUTES_CONFIG)
    const staticroute = node.staticroute
    await expectError(() => staticroute.create('1.2.3.0/24', { nextHop: 'Ethernet1', routeName: '' }), /empty name/)
    await expectError(() => staticroute.create('1.2.3.0/24', { nextHop: 'Ethernet1', routeName: 7 as unknown as string }), /expected a string route tag name/)
    await expectError(() => staticroute.create('1.2.3.0/24', { nextHop: 'Ethernet1', routeName: 'two words' }), /one \\S\+ token/)
    await expectError(() => staticroute.setRouteName('1.2.3.0/24', 'Ethernet1', { routeName: 'ing\x07rat' }), /control characters/)
    expect(transport.sent()).toEqual([])
  })

  it('an unknown resource name never resolves, and the registry lists staticroute among the rows (port test_instance, :53-54)', () => {
    const { node } = nodeFor(ROUTES_CONFIG)
    expect(node.hasResource('staticroute')).toBe(true)
    expect(() => node.resource('notaroute' as never)).toThrow(NotSupportedError)
    // W3a (#48 #49) first and W3b lane B (#50) second appended to the registry table, so the listing
    // this row still provides as a negative control for resource-name typos (from any module) grows too.
    expect(() => node.resource('notaroute' as never)).toThrow(/registered: system, vlans, switchports, interfaces, users, ntp, acls, varp, stp, ipinterfaces, vrfs, staticroute, mlag, ospf, bgp, routemaps/)
  })
})
