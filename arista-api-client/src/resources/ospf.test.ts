/**
 * `OspfResource` — W3a (#48), the OSPF entity module on the M7 framework, sibling of `mlag.ts`.
 * `node.ospf` over `MockTransport`: reads answer one hand-reduced config text, every write pins the
 * exact joined command list (docs/TESTING.md §3, DR-083). Config is inline — the four-writers-collide
 * reasoning `vrfs.test.ts`/`staticroute.test.ts`/`mlag.test.ts` established — and **hand-reduced from
 * pyeapi's own `test/fixtures/running_config.ospf`** (`:4-34` in the pinned `6816d9e` clone): the two
 * process blocks verbatim-minus-noise, never captured from the 7050TX-64. The negative half reuses a
 * reduced `running_config.bgp` (upstream's own negative fixture, `test_api_ospf.py:136`), because an
 * OSPF read against a BGP-only config must answer "no process". No EOS-side acceptance is claimed
 * (M12 #14 owns that).
 *
 * ## Upstream port ledger
 *
 * `pyeapi/test/unit/test_api_ospf.py` — **15** methods (verified in the pinned clone 2026-11-06), all
 * ported below with the pinned texts verbatim:
 *  - `test_get_no_vrf` (`:20-26`) — keys + `vrf == 'default'` (this suite additionally pins every
 *    reduced-fixture VALUE, which upstream leaves to its own fixture drift);
 *  - `test_get_with_vrf` (`:27-33`) — `get('test')` answers the vrf block (fixture `:30-34`);
 *  - `test_create` (`:34-39`) / `test_create_with_vrf` (`:40-46`) — `'router ospf 65000'` (string AND
 *    number spellings) and `'router ospf 65000 vrf test'`;
 *  - `test_create_invalid_id` (`:47-51`) — 66000 in both spellings refuses, upstream ValueError →
 *    the taxonomy's NotSupportedError refusal;
 *  - `test_delete` (`:52-56`) — read then `'no router ospf 65000'`;
 *  - `test_add_network` (`:57-67`) / `test_remove_network` (`:68-78`) — `router ospf 65000` opener +
 *    `network 172.16.10.0/24 area 0` (the `area 0` spelling EXACT — upstream passes the string `'0'`,
 *    the default is the number `0`, and both compose bare `area 0`), plus the `''`-network/''-mask
 *    ValueError arms mapped to refusals;
 *  - `test_set_router_id` (`:79-96`) — config/negate/default triad, the negate arm being upstream's
 *    NO-ARGUMENT fall-through to `no router-id` (DR-037 named verb here);
 *  - `test_set_shutdown` (`:97-105`) — `shutdown` / `no shutdown` (upstream's loop skips its own
 *    'default' state label — there is no default arm in ospf.py, only two methods);
 *  - `test_add_redistribution_no_route_map` (`:107-115`) / `test_add_redistribution_with_route_map`
 *    (`:116-124`) / `test_delete_redistribution_no_route_map` (`:126-141`) — four protocols each,
 *    `'no-proto'` refused;
 *  - `test_no_get` (`:143-145`) / `test_no_delete` (`:147-149`) — the negative fixture answers
 *    `undefined` / resolves with zero writes (upstream's `None` / `True`).
 *
 * `pyeapi/test/system/test_api_ospf.py` is device-territory (live config on a real box) — declared
 * skipped for this offline lane, not faked (docs/TESTING.md §5).
 */

import { describe, expect, it } from 'vitest'

import { Node } from '../command-layer'
import { ConfigParseError, NotFoundError } from '../errors'
import { mockTransport, type MockTransport } from '../testing/mock-transport'
import type { OspfRedistribution, OspfState } from './ospf'

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

/**
 * Reduced from pyeapi `test/fixtures/running_config.ospf:4-34` (6816d9e): BOTH process blocks with
 * their advertised routes / redistributions / router-ids kept, the noise lines (`max-lsa`, `timers…`,
 * `distance ospf…`, `adjacency…`, `point-to-point routes`, `no graceful-restart`, `no bfd…`,
 * `log-adjacency-changes`, `maximum-paths…`, `area 0.0.0.0 default-cost…`) dropped — this module
 * reads none of them. The first block has NO shutdown line at all, and the vrf block carries a bare
 * `shutdown` (`:35`): both derive `shutdown: true` under upstream's `_parse_shutdown` rule (`:181-183`).
 */
const OSPF_FIXTURE_CONFIG = textOf([
  'hostname lab-sw1',
  '!',
  'ip routing',
  '!',
  'router ospf 65000',
  '   router-id 1.1.1.1',
  '   redistribute bgp route-map RM-IN',
  '   redistribute bgp route-map RM-OUT',
  '   redistribute static',
  '   network 172.16.10.0/24 area 0.0.0.0',
  '   network 172.17.0.0/16 area 0.0.0.0',
  '!',
  'router ospf 10 vrf test',
  '   router-id 2.2.2.2',
  '   network 172.18.10.0/24 area 0.0.0.0',
  '   network 172.19.0.0/16 area 0.0.0.0',
  '   shutdown',
  '!',
  'end',
])

/** Reduced from pyeapi's NEGATIVE ospf fixture `test/fixtures/running_config.bgp` — no ospf section at all. */
const NO_OSPF_CONFIG = textOf([
  'router bgp 65000',
  '   router-id 1.1.1.1',
  '   neighbor test peer-group',
  '!',
  'end',
])

describe('OspfResource reads — one pass over the router ospf sections (ospf.py:51-183)', () => {
  it('the default-vrf half answers every upstream key, typed, and vrf reads \'default\' (port test_get_no_vrf, :20-26)', async () => {
    const { node, transport } = nodeFor(OSPF_FIXTURE_CONFIG)
    const state = await node.ospf.get()
    expect(state).toEqual<OspfState>({
      ospfProcessId: 65000, // upstream `int()`s it (:98) — a number here too
      vrf: 'default', // upstream spells the no-vrf answer 'default' (:109-112), and its test pins exactly that (:26)
      routerId: '1.1.1.1',
      networks: [
        { network: '172.16.10.0', netmask: '24', area: '0.0.0.0' },
        { network: '172.17.0.0', netmask: '16', area: '0.0.0.0' },
      ], // device order, all three groups STRINGS like upstream's match groups (:139-140)
      redistributions: [
        { protocol: 'bgp', routeMap: 'RM-IN' },
        { protocol: 'bgp', routeMap: 'RM-OUT' },
        { protocol: 'static' },
      ], // the fixture's doubled bgp lines BOTH survive — upstream appends (list, not dict, :153)
      shutdown: true, // NO shutdown line exists in this block, and upstream derives True from the ABSENCE of 'no shutdown' (:181-183) — kept (module divergence 3)
    })
    // ONE config read for the whole record (DR-030) — upstream runs six merges over one get_block scan.
    expect(transport.callCount()).toBe(1)
  })

  it('get(vrf) answers the VRF process — including a bare `shutdown` deriving true (port test_get_with_vrf, :27-33)', async () => {
    const state = await nodeFor(OSPF_FIXTURE_CONFIG).node.ospf.get('test')
    expect(state?.ospfProcessId).toBe(10)
    expect(state?.vrf).toBe('test')
    expect(state?.routerId).toBe('2.2.2.2')
    expect(state?.networks).toEqual([
      { network: '172.18.10.0', netmask: '24', area: '0.0.0.0' },
      { network: '172.19.0.0', netmask: '16', area: '0.0.0.0' },
    ])
    expect(state?.redistributions).toEqual([])
    expect(state?.shutdown).toBe(true)
  })

  it('a vrf the switch does not run answers undefined — suffix-match is TEXT, never a regex (module divergence 1; the getBlock row-39 hazard closes here)', async () => {
    const twoVrfs = textOf([
      'router ospf 3 vrf ab',
      '!',
      'router ospf 4 vrf abc',
      '!',
      'end',
    ])
    const { node } = nodeFor(twoVrfs)
    expect((await node.ospf.get('ab'))?.ospfProcessId).toBe(3)
    expect((await node.ospf.get('abc'))?.ospfProcessId).toBe(4)
    expect(await node.ospf.get('abcf')).toBeUndefined()
  })

  it('a BGP-only switch has no OSPF process: get answers undefined (port test_no_get, :143-145)', async () => {
    const state = await nodeFor(NO_OSPF_CONFIG).node.ospf.get()
    expect(state).toBeUndefined()
  })

  it('negations and mid-line phrases stop voting where upstream\'s findall reported them (module divergence 3)', async () => {
    const state = await nodeFor(textOf([
      'router ospf 65000',
      '   no redistribute bgp',
      '   description has router-id 9.9.9.9 inside',
      '   redistribute',
      '   redistribute connected metric-type 1',
      '   redistribute rip foo bar',
      '!',
      'end',
    ])).node.ospf.get()
    // Upstream: `redistribute .*` matches INSIDE the `no …` line (:157 — probe: findall answers
    // ['redistribute bgp', …]) → a bgp row appears upstream and NOT here; `router-id ([^\s]+)`
    // (:122) is not anchored → upstream reports router_id '9.9.9.9'.
    expect(state?.routerId).toBeUndefined()
    // The bare `redistribute` line is 1 token and drops (upstream's len checks at :162/:166 are both
    // false too). FOUR-token lines keep upstream's rule of taking token 3 as the route-map WHATEVER
    // it is (:167): `metric-type 1` reads as a route-map named '1', `foo bar` as one named 'bar'.
    expect(state?.redistributions).toEqual<OspfRedistribution[]>([
      { protocol: 'connected', routeMap: '1' },
      { protocol: 'rip', routeMap: 'bar' },
    ])
  })

  it('only dotted-quad areas read back — this module\'s own `area 0` writes are invisible to it (module divergence 4, upstream-faithful)', async () => {
    const state = await nodeFor(textOf([
      'router ospf 65000',
      '   network 10.0.0.0/8 area 0',
      '   network 10.1.0.0/16 area 0.0.0.0',
      '!',
      'end',
    ])).node.ospf.get()
    // `network (.+)/(\d+) area (\d+\.\d+\.\d+\.\d+)` (:141) simply does not match `area 0`.
    expect(state?.networks).toEqual([{ network: '10.1.0.0', netmask: '16', area: '0.0.0.0' }])
  })

  it('a section header without process digits is reported, where upstream attribute-crashes (module divergence 2)', async () => {
    const { node } = nodeFor(textOf(['router ospf FOO', '   no shutdown', '!', 'end']))
    await expectError(() => node.ospf.get(), /has no digits to name a process/)
    const thrown = await outcome(() => node.ospf.get())
    expect(thrown).toBeInstanceOf(ConfigParseError)
  })
})

describe('OspfResource lifecycle — create/delete and the no-process shapes (ospf.py:210-255)', () => {
  it('create accepts the string AND number spellings, read-first-free (port test_create, :34-39)', async () => {
    const transport = mockTransport().replies(writeKey(['router ospf 65000']), [{}, {}])
    const scriptsBefore = transport.callCount()
    const node = new Node(transport)
    await node.ospf.create('65000')
    await node.ospf.create(65000)
    expect(sentScripts(transport).slice(scriptsBefore)).toEqual([
      ['enable', 'configure terminal', 'router ospf 65000'],
      ['enable', 'configure terminal', 'router ospf 65000'],
    ])
    // create never reads: upstream has no get() on this verb (:224-243).
    expect(sentScripts(transport).slice(scriptsBefore).every((script) => !script.includes('show running-config all'))).toBe(true)
  })

  it('create with a vrf appends the vrf arm verbatim (port test_create_with_vrf, :40-46)', async () => {
    const transport = mockTransport().replies(writeKey(['router ospf 65000 vrf test']), [{}, {}])
    await new Node(transport).ospf.create(65000, 'test')
    expect(sentScripts(transport)).toEqual([['enable', 'configure terminal', 'router ospf 65000 vrf test']])
  })

  it('out-of-range and malformed process ids refuse at the guard, sending NOTHING (port test_create_invalid_id, :47-51, guards widened)', async () => {
    const { node, transport } = nodeFor(OSPF_FIXTURE_CONFIG)
    await expectError(() => node.ospf.create('66000'), /between 1 and 65535/)
    await expectError(() => node.ospf.create(66000), /between 1 and 65535/)
    await expectError(() => node.ospf.create(0), /between 1 and 65535/)
    await expectError(() => node.ospf.create(65536), /between 1 and 65535/)
    // Divergence 6's widening: pyeapi's int() passes padded digits and INTERPOLATES the raw string;
    // this client composes normalized digits only, so the padded form is refused instead.
    await expectError(() => node.ospf.create(' 65000 '), /expected digits/)
    await expectError(() => node.ospf.create(10.5), /safe integer/)
    // A vrf outside the reader grammar refuses too (divergence 9's write side): pyeapi checks nothing (:243).
    await expectError(() => node.ospf.create(10, 'mid-dash'), /vrf name/)
    expect(transport.sent()).toEqual([])
  })

  it('delete reads the first process and removes it whole (port test_delete, :52-56)', async () => {
    const { node, transport } = nodeFor(OSPF_FIXTURE_CONFIG)
    allowWrites(transport, ['no router ospf 65000'])
    await node.ospf.delete()
    expect(sentScripts(transport)).toEqual([
      ['enable', 'show running-config all'],
      ['enable', 'configure terminal', 'no router ospf 65000'],
    ])
  })

  it('delete on a no-OSPF switch resolves and sends NO config (port test_no_delete, :147-149 — upstream\'s bare `True`)', async () => {
    const { node, transport } = nodeFor(NO_OSPF_CONFIG)
    await node.ospf.delete() // a void resolve — NOT a rejection, NOT a command; pinned without notToThrow (the void-arrow typing trap)
    const writes = sentScripts(transport).filter((script) => script.includes('configure terminal'))
    expect(writes).toEqual([])
  })

  it('any submode write names the FIRST process even after reading a vrf one — upstream\'s configure_ospf has no vrf arm (module divergence 7)', async () => {
    const { node, transport } = nodeFor(OSPF_FIXTURE_CONFIG)
    allowWrites(transport, ['router ospf 65000', 'router-id 3.3.3.3'])
    await node.ospf.get('test') // reads the vrf block (2.2.2.2)…
    await node.ospf.setRouterId('3.3.3.3') // …and still writes into 65000 (ospf.py:251 calls get() with no vrf)
    const writes = sentScripts(transport).filter((script) => script.includes('configure terminal'))
    expect(writes).toEqual([['enable', 'configure terminal', 'router ospf 65000', 'router-id 3.3.3.3']])
  })

  it('configureOspf on a switch with no process is a loud NotFoundError, where upstream TypeError-crashed (module divergence family / DR-027)', async () => {
    const { node, transport } = nodeFor(NO_OSPF_CONFIG)
    await expectError(() => node.ospf.configureOspf(['router-id 1.1.1.1']), /no `router ospf …` section/)
    const thrown = await outcome(() => node.ospf.configureOspf('router-id 1.1.1.1'))
    expect(thrown).toBeInstanceOf(NotFoundError)
    expect(sentScripts(transport).filter((script) => script.includes('configure terminal'))).toEqual([])
  })
})

describe('OspfResource field writers — the two-line router-ospf transactions (ospf.py:257-357)', () => {
  it('router-id: set / unset / default, texts verbatim from upstream\'s tri-state loop (port test_set_router_id, :79-96)', async () => {
    const { node, transport } = nodeFor(OSPF_FIXTURE_CONFIG)
    allowWrites(transport,
      ['router ospf 65000', 'router-id 1.1.1.1'],
      ['router ospf 65000', 'no router-id'],
      ['router ospf 65000', 'default router-id'],
    )
    await node.ospf.setRouterId('1.1.1.1')
    await node.ospf.unsetRouterId() // upstream spells this a NO-ARG set_router_id() whose falsy value falls through to `no router-id` (abstract.py:160-161) — DR-037 verb
    await node.ospf.defaultRouterId() // upstream (rid, True): the third positional slot IS `default` (ospf.py:257)
    const writes = sentScripts(transport).filter((script) => script.includes('configure terminal'))
    expect(writes).toEqual([
      ['enable', 'configure terminal', 'router ospf 65000', 'router-id 1.1.1.1'],
      ['enable', 'configure terminal', 'router ospf 65000', 'no router-id'],
      ['enable', 'configure terminal', 'router ospf 65000', 'default router-id'],
    ])
  })

  it('router-id values are token-guarded before any read — a refusal costs zero round trips (guards family)', async () => {
    const { node, transport } = nodeFor(OSPF_FIXTURE_CONFIG)
    await expectError(() => node.ospf.setRouterId(''), /may not be empty|non-empty/)
    await expectError(() => node.ospf.setRouterId('two words') as unknown as Promise<void>, /splits the command line/)
    await expectError(() => node.ospf.setRouterId('bad\x07id'), /control character/)
    expect(transport.sent()).toEqual([])
  })

  it('shutdown / no shutdown are the two upstream methods, not flag arms (port test_set_shutdown, :97-105)', async () => {
    const { node, transport } = nodeFor(OSPF_FIXTURE_CONFIG)
    allowWrites(transport,
      ['router ospf 65000', 'shutdown'],
      ['router ospf 65000', 'no shutdown'],
    )
    await node.ospf.shutdown()
    await node.ospf.noShutdown()
    const writes = sentScripts(transport).filter((script) => script.includes('configure terminal'))
    expect(writes).toEqual([
      ['enable', 'configure terminal', 'router ospf 65000', 'shutdown'],
      ['enable', 'configure terminal', 'router ospf 65000', 'no shutdown'],
    ])
  })

  it('addNetwork composes the fixture text `network X/24 area 0` — the bare area, upstream-faithful (port test_add_network, :57-63)', async () => {
    const { node, transport } = nodeFor(OSPF_FIXTURE_CONFIG)
    allowWrites(transport,
      ['router ospf 65000', 'network 172.16.10.0/24 area 0'],
      ['router ospf 65000', 'network 172.16.10.0/24 area 0'],
    )
    await node.ospf.addNetwork('172.16.10.0', '24', '0') // upstream passes the STRING '0' (:59)
    await node.ospf.addNetwork('172.16.10.0', '24') // and DEFAULTS to the number 0 (:271) — same composed text
    const writes = sentScripts(transport).filter((script) => script.includes('configure terminal'))
    expect(writes).toEqual([
      ['enable', 'configure terminal', 'router ospf 65000', 'network 172.16.10.0/24 area 0'],
      ['enable', 'configure terminal', 'router ospf 65000', 'network 172.16.10.0/24 area 0'],
    ])
  })

  it('addNetwork empty-argument arms refuse like upstream\'s ValueError (port test_add_network exceptions, :64-67)', async () => {
    const { node, transport } = nodeFor(OSPF_FIXTURE_CONFIG)
    await expectError(() => node.ospf.addNetwork('', '24', '0'), /may not be empty/)
    await expectError(() => node.ospf.addNetwork('172.16.10.0', '', '0'), /may not be empty/)
    expect(transport.sent()).toEqual([])
  })

  it('removeNetwork composes the negated pair and refuses the same empty arms (port test_remove_network, :68-78)', async () => {
    const { node, transport } = nodeFor(OSPF_FIXTURE_CONFIG)
    allowWrites(transport, ['router ospf 65000', 'no network 172.16.10.0/24 area 0'])
    await node.ospf.removeNetwork('172.16.10.0', 24, '0') // a NUMBER mask normalizes to the same text (:69 uses '24')
    await expectError(() => node.ospf.removeNetwork('', '24'), /may not be empty/)
    await expectError(() => node.ospf.removeNetwork('172.16.10.0', ''), /may not be empty/)
    const writes = sentScripts(transport).filter((script) => script.includes('configure terminal'))
    expect(writes).toEqual([['enable', 'configure terminal', 'router ospf 65000', 'no network 172.16.10.0/24 area 0']])
  })

  it('every protocol on the allow-list adds bare, and the line-unsafe/off-list arms refuse (port test_add_redistribution_no_route_map, :107-115)', async () => {
    const { node, transport } = nodeFor(OSPF_FIXTURE_CONFIG)
    allowWrites(transport,
      ['router ospf 65000', 'redistribute bgp'],
      ['router ospf 65000', 'redistribute rip'],
      ['router ospf 65000', 'redistribute static'],
      ['router ospf 65000', 'redistribute connected'],
    )
    await node.ospf.addRedistribution('bgp')
    await node.ospf.addRedistribution('rip')
    await node.ospf.addRedistribution('static')
    await node.ospf.addRedistribution('connected')
    // Each malformed input is pinned per call — a shared loop's inferred union can hide a case (the
    // trap list this repo keeps re-proving).
    await expectError(() => node.ospf.addRedistribution('no-proto'), /must be one of/)
    await expectError(() => node.ospf.addRedistribution('OSPF'), /must be one of/)
    await expectError(() => node.ospf.addRedistribution('two words'), /must be one of/)
    const writes = sentScripts(transport).filter((script) => script.includes('configure terminal'))
    expect(writes).toEqual([
      ['enable', 'configure terminal', 'router ospf 65000', 'redistribute bgp'],
      ['enable', 'configure terminal', 'router ospf 65000', 'redistribute rip'],
      ['enable', 'configure terminal', 'router ospf 65000', 'redistribute static'],
      ['enable', 'configure terminal', 'router ospf 65000', 'redistribute connected'],
    ])
  })

  it('the route-map arm composes `redistribute P route-map R`, and a line-unsafe name is refused (port test_add_redistribution_with_route_map, :116-124)', async () => {
    const { node, transport } = nodeFor(OSPF_FIXTURE_CONFIG)
    allowWrites(transport, ['router ospf 65000', 'redistribute bgp route-map test'])
    await node.ospf.addRedistribution('bgp', 'test')
    await expectError(() => node.ospf.addRedistribution('bgp', ''), /may not be empty/)
    await expectError(() => node.ospf.addRedistribution('bgp', 'two words'), /splits the command line/)
    const writes = sentScripts(transport).filter((script) => script.includes('configure terminal'))
    expect(writes).toEqual([['enable', 'configure terminal', 'router ospf 65000', 'redistribute bgp route-map test']])
  })

  it('removeRedistribution always sends the BARE negation — no route-map argument exists upstream (port test_delete_redistribution_no_route_map, :126-141; module divergence 10)', async () => {
    const { node, transport } = nodeFor(OSPF_FIXTURE_CONFIG)
    allowWrites(transport,
      ['router ospf 65000', 'no redistribute bgp'],
      ['router ospf 65000', 'no redistribute rip'],
      ['router ospf 65000', 'no redistribute static'],
      ['router ospf 65000', 'no redistribute connected'],
    )
    for (const protocol of ['bgp', 'rip', 'static', 'connected'] as const) {
      await node.ospf.removeRedistribution(protocol)
    }
    await expectError(() => node.ospf.removeRedistribution('no-proto'), /must be one of/)
    await expectError(() => node.ospf.removeRedistribution(''), /must be one of/)
    const writes = sentScripts(transport).filter((script) => script.includes('configure terminal'))
    expect(writes).toEqual([
      ['enable', 'configure terminal', 'router ospf 65000', 'no redistribute bgp'],
      ['enable', 'configure terminal', 'router ospf 65000', 'no redistribute rip'],
      ['enable', 'configure terminal', 'router ospf 65000', 'no redistribute static'],
      ['enable', 'configure terminal', 'router ospf 65000', 'no redistribute connected'],
    ])
  })

  it('guards refuse BEFORE the process read — unlike the writers, a refusal costs zero device calls (the vrfs guard discipline)', async () => {
    const { node, transport } = nodeFor(OSPF_FIXTURE_CONFIG)
    await expectError(() => node.ospf.addNetwork('two words', '24'), /splits the command line/)
    await expectError(() => node.ospf.addNetwork('10.0.0.0', 'twenty-four'), /expected digits/)
    await expectError(() => node.ospf.addNetwork('10.0.0.0', '24', 'area 5'), /digits or a dotted quad/)
    await expectError(() => node.ospf.removeNetwork('10.0.0.0', '24', '1.2.3.4.5'), /digits or a dotted quad/)
    // Numeric arms of the mask/area guards reach their refuse branches too (the TS types say
    // `string | number`; a JS caller bypasses that, so the runtime branch must be real — the
    // `as unknown as` convention, cf. base.test.ts:418):
    await expectError(() => node.ospf.addNetwork('10.0.0.0', -3), /non-negative integer/)
    await expectError(() => node.ospf.addNetwork('10.0.0.0', 2.5), /non-negative integer/)
    await expectError(() => node.ospf.addNetwork('10.0.0.0', '24', -1), /non-negative integer/)
    // Non-string into a token guard: pyeapi would interpolate 5 into `router-id 5`; here the label
    // names the expected type first.
    await expectError(() => node.ospf.setRouterId(5 as unknown as string), /expected a string token/)
    expect(transport.sent()).toEqual([])
  })
})

describe('OspfResource registry wiring — row fourteen and fifteen land in this lane (DR-006/DR-052)', () => {
  it('node.ospf is the memoised registry instance', () => {
    const { node } = nodeFor(OSPF_FIXTURE_CONFIG)
    expect(node.ospf).toBe(node.ospf)
    expect(node.ospf).toBe(node.resource('ospf'))
    expect(node.ospf.constructor.name).toBe('OspfResource')
    expect(node.hasResource('ospf')).toBe(true)
  })
})
