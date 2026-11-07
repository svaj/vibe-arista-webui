/**
 * `VrrpResource` — W3c (#51), the VRRP collection on the M7 framework, sibling of `vrfs.ts` and
 * `staticroute.ts`. Driven through `MockTransport` over the real `Node` (`node.vrrp`): every read
 * answer is device text, every write answer an exact joined command script (docs/TESTING.md §3,
 * DR-083's full-list keys). Config for the tests is **inline** — deliberately NOT a new file under
 * `test/fixtures/config/`: the sibling W3 lanes touch that directory's `manifest.json` +
 * `pyeapi-oracle.json` in parallel and a third writer would collide (the orchestrator can promote
 * these blobs at merge), and the upstream `test/fixtures/running_config.vrrp` (13 KB of queue/QoS
 * boilerplate around the vrrp lines) buys nothing whole for this suite. Provenance of the config
 * below: the `interface` headers and EVERY `vrrp`-prefixed line are **verbatim pyeapi copies** —
 * byte-for-byte from `pyeapi/test/fixtures/running_config.vrrp` @ `6816d9e`, `:7`/`:248-263`/
 * `:265`/`:399-413`/`:415`/`:474-531` — with the non-`vrrp` body lines of each block omitted (no
 * vrrp reader consults them; the census regex `vrrp.py:200` and all fourteen parsers see only the
 * lines kept). The `!` separators and the trailing `end` keep the chunking shape. Never captured
 * from the 7050TX-64, and no EOS-side acceptance is claimed (M12 #14 owns that).
 *
 * ## Upstream port ledger
 *
 * `pyeapi/test/unit/test_api_vrrp.py` has **23** test methods (verified in the pinned clone on
 * 2026-11-06): `test_instance` (`:147-148`), `test_get` (`:150-157`), `test_get_non_existent_interface`
 * (`:159-163`), `test_get_invalid_parameters` (`:165-171`), `test_getall` (`:179-182`), `test_create`
 * (`:184-311`, THREE sub-cases: full config, all-`'no'`, all-`'default'`), `test_delete` (`:313-326`),
 * `test_default` (`:328-341`), `test_set_enable` (`:343-365`, incl. ValueError cases `:360-365`),
 * `test_set_primary_ip` (`:367-397`), `test_set_priority` (`:399-423`), `test_set_description`
 * (`:425-443`), `test_set_ip_version` (`:445-467`), `test_set_secondary_ips` (`:469-520`),
 * `test_set_timers_advertise` (`:522-546`), `test_set_mac_addr_adv_interval` (`:548-575`),
 * `test_set_preempt` (`:577-601`), `test_set_preempt_delay_min` (`:603-631`),
 * `test_set_preempt_delay_reload` (`:633-661`), `test_set_delay_reload` (`:663-688`),
 * `test_set_tracks` (`:690-756`), `test_set_bfd_ip` (`:758-785`), `test_vrconf_format` (`:787-809`).
 * All twenty-three are ported below with their pinned command texts reproduced **verbatim**, and note
 * WHICH family upstream pins: the fake node pins `version_number = '4.17.1.1'`
 * (`test/lib/testlib.py:75`), so every text is the legacy arm (`ip`, `shutdown`, `track`,
 * `timers advertise`, `description`, `priority`, `delay reload`, `ip version`) — which the config-text
 * detection (DR-099's vrrp twin) reproduces from this fixture's own legacy lines. The modern arm is
 * exercised by the sibling lanes' captures, not by extra suite mass this round.
 *
 * Two upstream order-dependencies are called out where the port breaks them:
 *  - `known_vrrps` is MUTATED by `test_get` (`:152-154` runs `vrconf_format` over each entry in
 *    place), which is what un-breaks its `track` list ordering for `test_getall` (`:179-182`) —
 *    Python sorts parsed tracks by `(name, action)` (`vrrp.py:388-391`, so `Ethernet11` lands
 *    BETWEEN `Ethernet1` and `Ethernet2`), while the literal lists in `:70-79`/`:100-105` are in
 *    file order. Here the expected records are written once, in the parsed (sorted) order, and both
 *    tests compare the same values.
 *  - `test_get` re-formats with `vrconf_format` before comparing (`:153`); applied to already-parsed
 *    records that pass is identity (no sentinels in them), so the port compares parsed records
 *    directly and `test_vrconf_format` pins the formatter itself.
 */

import { describe, expect, it } from 'vitest'

import { Node } from '../command-layer'
import { mockTransport, type MockReply, type MockTransport } from '../testing/mock-transport'
import type { Vrrp, VrrpAttrs, VrrpConf, VrrpTrack, VrrpVridTable } from './vrrp'

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

/** Empty per-command replies for a successful config transaction (openers included). */
const okFor = (cmds: readonly string[]): MockReply => Array.from({ length: cmds.length + 2 }, () => ({}))

function scriptWrite(transport: MockTransport, cmds: readonly string[]): MockTransport {
  return transport.replies(writeKey(cmds), okFor(cmds))
}

const sentScripts = (transport: MockTransport): string[][] => transport.sent().map((cmds) => cmds.map(String))

/**
 * Only the CONFIGURE scripts among everything sent. Reads interleave by design: the Node's config
 * memo is invalidated by every write (command-layer.ts — pyeapi's own `config` property re-ran the
 * `show` per access, MIGRATION §5 row 15), and the current-state reads (write-family detection,
 * setSecondaryIps/setTracks diff context, setPrimaryIp's address-naming arms) therefore pay a fresh
 * read after the first write — upstream behavior, pinned rather than hidden.
 */
const writeScripts = (transport: MockTransport): string[][] =>
  sentScripts(transport).filter((cmds) => cmds.includes('configure terminal'))

function outcome(fn: () => Promise<unknown>): Promise<unknown> {
  return fn().then(() => 'resolved' as const, (thrown: unknown) => thrown)
}

async function expectError(fn: () => Promise<unknown>, message: RegExp): Promise<void> {
  const thrown = await outcome(fn)
  expect(thrown, 'expected a rejection').toBeInstanceOf(Error)
  expect((thrown as Error).message).toMatch(message)
}

/** Nothing but `show` traffic ever reached the wire (every refusure stays client-side). */
const onlyReads = (transport: MockTransport): boolean =>
  sentScripts(transport).every((cmds) => !cmds.includes('configure terminal'))

/**
 * The pyeapi fixture's vrrp-bearing shape, inline, verbatim vrrp lines only (see the header's
 * provenance note). `interface Port-Channel1` keeps its slot so getAll's candidate sweep must
 * actively EXCLUDE it — upstream `:245-246` excludes it by the falsy-`get()` rule (block has no
 * vrrp census match, `vrrp.py:200-203`), and this port excludes it the identical way.
 */
const VRRP_CONFIG = textOf([
  'interface Port-Channel1',
  '!',
  'interface Port-Channel10',
  '   vrrp 10 priority 150',
  '   vrrp 10 timers advertise 1',
  '   vrrp 10 mac-address advertisement-interval 30',
  '   vrrp 10 preempt',
  '   vrrp 10 preempt delay minimum 0',
  '   vrrp 10 preempt delay reload 0',
  '   vrrp 10 delay reload 0',
  '   no vrrp 10 authentication',
  '   vrrp 10 ip 10.10.5.10',
  '   vrrp 10 ip 10.10.5.20 secondary',
  '   vrrp 10 ipv6 ::',
  '   vrrp 10 description vrrp 10 on Port-Channel10',
  '   no vrrp 10 shutdown',
  '   no vrrp 10 bfd ip',
  '   no vrrp 10 bfd ipv6',
  '   vrrp 10 ip version 2',
  '!',
  'interface Ethernet1',
  '   vrrp 10 priority 175',
  '   vrrp 10 timers advertise 1',
  '   vrrp 10 mac-address advertisement-interval 30',
  '   vrrp 10 preempt',
  '   vrrp 10 preempt delay minimum 0',
  '   vrrp 10 preempt delay reload 0',
  '   vrrp 10 delay reload 0',
  '   no vrrp 10 authentication',
  '   vrrp 10 ip 10.10.6.10',
  '   vrrp 10 ipv6 ::',
  '   vrrp 10 description vrrp 10 on Ethernet1',
  '   no vrrp 10 shutdown',
  '   no vrrp 10 bfd ip',
  '   no vrrp 10 bfd ipv6',
  '   vrrp 10 ip version 2',
  '!',
  'interface Vlan50',
  '   vrrp 10 priority 200',
  '   vrrp 10 timers advertise 3',
  '   vrrp 10 mac-address advertisement-interval 30',
  '   vrrp 10 preempt',
  '   vrrp 10 preempt delay minimum 0',
  '   vrrp 10 preempt delay reload 0',
  '   vrrp 10 delay reload 0',
  '   no vrrp 10 authentication',
  '   vrrp 10 ip 10.10.4.10',
  '   vrrp 10 ip 10.10.4.21 secondary',
  '   vrrp 10 ip 10.10.4.22 secondary',
  '   vrrp 10 ip 10.10.4.23 secondary',
  '   vrrp 10 ip 10.10.4.24 secondary',
  '   vrrp 10 ipv6 ::',
  '   no vrrp 10 description',
  '   no vrrp 10 shutdown',
  '   vrrp 10 track Ethernet1 decrement 10',
  '   vrrp 10 track Ethernet1 shutdown',
  '   vrrp 10 track Ethernet2 decrement 50',
  '   vrrp 10 track Ethernet2 shutdown',
  '   vrrp 10 track Ethernet11 decrement 75',
  '   vrrp 10 track Ethernet11 shutdown',
  '   no vrrp 10 bfd ip',
  '   no vrrp 10 bfd ipv6',
  '   vrrp 10 ip version 2',
  '   vrrp 20 priority 100',
  '   vrrp 20 timers advertise 5',
  '   vrrp 20 mac-address advertisement-interval 30',
  '   no vrrp 20 preempt',
  '   vrrp 20 preempt delay minimum 0',
  '   vrrp 20 preempt delay reload 0',
  '   vrrp 20 delay reload 0',
  '   vrrp 20 authentication text 12345',
  '   vrrp 20 ip 10.10.4.20',
  '   vrrp 20 ipv6 ::',
  '   no vrrp 20 description',
  '   vrrp 20 shutdown',
  '   vrrp 20 track Ethernet1 shutdown',
  '   vrrp 20 track Ethernet2 decrement 1',
  '   vrrp 20 track Ethernet2 shutdown',
  '   no vrrp 20 bfd ip',
  '   no vrrp 20 bfd ipv6',
  '   vrrp 20 ip version 2',
  '   vrrp 30 priority 50',
  '   vrrp 30 timers advertise 1',
  '   vrrp 30 mac-address advertisement-interval 30',
  '   vrrp 30 preempt',
  '   vrrp 30 preempt delay minimum 0',
  '   vrrp 30 preempt delay reload 0',
  '   vrrp 30 delay reload 0',
  '   vrrp 30 authentication ietf-md5 key-string 7 bu1yTgzm0RDgraNS0MNkaA==',
  '   vrrp 30 ip 10.10.4.30',
  '   vrrp 30 ipv6 ::',
  '   no vrrp 30 description',
  '   no vrrp 30 shutdown',
  '   vrrp 30 bfd ip 10.10.4.33',
  '   no vrrp 30 bfd ipv6',
  '   vrrp 30 ip version 2',
  '!',
  'end',
])

/**
 * The upstream `known_vrrps` (`test_api_vrrp.py:48-113`) restated in the parsed (get-shape) form,
 * camelCased, with the `track` lists already in parser sort order (the header's note on upstream's
 * `vrconf_format`-mutation order dependency). Field-absence is upstream-None→undefined (divergence
 * 6 of `vrrp.ts`): this fixture answers every field, so none is absent here.
 */
const KNOWN: Record<string, Map<number, Vrrp>> = {
  'Port-Channel10': new Map([[10, {
    enable: true,
    primaryIp: '10.10.5.10',
    priority: 150,
    description: 'vrrp 10 on Port-Channel10',
    secondaryIp: ['10.10.5.20'],
    ipVersion: 2,
    timersAdvertise: 1,
    macAddrAdvInterval: 30,
    preempt: true,
    preemptDelayMin: 0,
    preemptDelayReload: 0,
    delayReload: 0,
    track: [],
    bfdIp: '',
  }]]),
  Ethernet1: new Map([[10, {
    enable: true,
    primaryIp: '10.10.6.10',
    priority: 175,
    description: 'vrrp 10 on Ethernet1',
    secondaryIp: [],
    ipVersion: 2,
    timersAdvertise: 1,
    macAddrAdvInterval: 30,
    preempt: true,
    preemptDelayMin: 0,
    preemptDelayReload: 0,
    delayReload: 0,
    track: [],
    bfdIp: '',
  }]]),
  Vlan50: new Map([
    [10, {
      enable: true,
      primaryIp: '10.10.4.10',
      priority: 200,
      description: '',
      secondaryIp: ['10.10.4.21', '10.10.4.22', '10.10.4.23', '10.10.4.24'],
      ipVersion: 2,
      timersAdvertise: 3,
      macAddrAdvInterval: 30,
      preempt: true,
      preemptDelayMin: 0,
      preemptDelayReload: 0,
      delayReload: 0,
      // `sorted(key=(name, action))`, vrrp.py:388-391 — Ethernet11 sorts between Ethernet1 and
      // Ethernet2 (string compare), which the upstream literal list at :70-79 only reveals AFTER its
      // own test_get re-formats it.
      track: [
        { name: 'Ethernet1', action: 'decrement', amount: 10 },
        { name: 'Ethernet1', action: 'shutdown' },
        { name: 'Ethernet11', action: 'decrement', amount: 75 },
        { name: 'Ethernet11', action: 'shutdown' },
        { name: 'Ethernet2', action: 'decrement', amount: 50 },
        { name: 'Ethernet2', action: 'shutdown' },
      ],
      bfdIp: '',
    }],
    [20, {
      enable: false,
      primaryIp: '10.10.4.20',
      priority: 100,
      description: '',
      secondaryIp: [],
      ipVersion: 2,
      timersAdvertise: 5,
      macAddrAdvInterval: 30,
      preempt: false,
      preemptDelayMin: 0,
      preemptDelayReload: 0,
      delayReload: 0,
      track: [
        { name: 'Ethernet1', action: 'shutdown' },
        { name: 'Ethernet2', action: 'decrement', amount: 1 },
        { name: 'Ethernet2', action: 'shutdown' },
      ],
      bfdIp: '',
    }],
    [30, {
      enable: true,
      primaryIp: '10.10.4.30',
      priority: 50,
      description: '',
      secondaryIp: [],
      ipVersion: 2,
      timersAdvertise: 1,
      macAddrAdvInterval: 30,
      preempt: true,
      preemptDelayMin: 0,
      preemptDelayReload: 0,
      delayReload: 0,
      track: [],
      bfdIp: '10.10.4.33',
    }],
  ]),
}

const vrrpFor = (config: string = VRRP_CONFIG) => nodeFor(config).node.vrrp

describe('W3c wiring — port of test_instance (test_api_vrrp.py:147-148) into the registry', () => {
  it('node.vrrp is the memoised registry instance of VrrpResource', () => {
    const { node } = nodeFor(VRRP_CONFIG)
    expect(node.vrrp).toBe(node.vrrp)
    expect(node.vrrp).toBe(node.resource('vrrp'))
    expect(node.vrrp.constructor.name).toBe('VrrpResource')
    // pyeapi's `instance(node)` twin (`vrrp.py:1483-1493`) is exactly what the RESOURCE_FACTORIES
    // row replaces (DR-006); the row/`registered:` pins carry the listing proof in registry.test.ts
    // and index.test.ts, flipped to `pim` as wave 3's permanent negative control.
  })
})

describe('VrrpResource reads — get (port test_get :150-157) and getAll (port test_getall :179-182)', () => {
  it('get answers the per-vrid table for every interface the upstream known_vrrps covers', async () => {
    const vrrp = vrrpFor()
    for (const iface of Object.keys(KNOWN)) {
      expect(await vrrp.get(iface), iface).toEqual(KNOWN[iface])
    }
    // Vlan50 alone carries three vrids — the census regex (`vrrp.py:200`) keys 10, 20 and 30 from
    // first appearance, and the table preserves that order (upstream's set() order is arbitrary;
    // the dict equality it tests never cared).
    expect([...(await vrrp.get('Vlan50'))?.keys() ?? []]).toEqual([10, 20, 30])
  })

  it('an interface the switch does not have answers undefined (port test_get_non_existent_interface :159-163)', async () => {
    expect(await vrrpFor().get('Vlan2000')).toBeUndefined()
    // And an interface the switch HAS but that carries no vrrp lines: upstream `get` returns None
    // via the empty-census path (`:201-203`) — Vlan2000 exercises the missing-block path (`:194-196`);
    // Port-Channel1 below exercises the census-empty path through getAll.
    expect(await vrrpFor().get('Port-Channel1')).toBeUndefined()
  })

  it("get's empty/None names refuse (port test_get_invalid_parameters :165-171) and cost zero reads", async () => {
    const { node, transport } = nodeFor(VRRP_CONFIG)
    await expectError(() => node.vrrp.get(''), /invalid interface/)
    await expectError(() => node.vrrp.get(null as never), /invalid interface/)
    await expectError(() => node.vrrp.get(undefined as never), /invalid interface/)
    // Upstream raises ValueError with its own message (`vrrp.py:188-190`) ONLY for empty/None;
    // this client routes through the framework's assertInterfaceName, whose six-kind grammar also
    // refuses a typo'd kind — the honest difference, pinned here:
    await expectError(() => node.vrrp.get('Vlan nope'), /invalid interface/)
    expect(transport.sent()).toEqual([])
  })

  it('getAll nests interface→vrid exactly like upstream\'s docstring shape and costs ONE read (DR-030)', async () => {
    const { node, transport } = nodeFor(VRRP_CONFIG)
    const all = await node.vrrp.getAll()
    // Port-Channel1 is a candidate (`:238` matches it too) but is EXCLUDED by the empty-census rule.
    expect([...all.keys()]).toEqual(['Port-Channel10', 'Ethernet1', 'Vlan50'])
    for (const iface of Object.keys(KNOWN)) {
      expect(all.get(iface), iface).toEqual(KNOWN[iface])
    }
    expect(transport.callCount()).toBe(1)
    // get() after getAll() rides the same memoised chunk document:
    await node.vrrp.get('Vlan50')
    expect(transport.callCount()).toBe(1)
  })
})

describe('VrrpResource create/delete/default — test_api_vrrp.py:184-341, texts verbatim', () => {
  it('create of a full configuration sends the whole _vrrp_set sequence in ONE transaction (port :184-239)', async () => {
    const { node, transport } = nodeFor(VRRP_CONFIG)
    const configuration: VrrpAttrs = {
      primaryIp: '10.10.60.10',
      priority: 200,
      description: 'modified vrrp 10 on Ethernet1',
      secondaryIp: ['10.10.60.20', '10.10.60.30'],
      ipVersion: 3,
      timersAdvertise: 2,
      macAddrAdvInterval: 3,
      preempt: true,
      preemptDelayMin: 1,
      preemptDelayReload: 1,
      delayReload: 1,
      track: [
        { name: 'Ethernet1', action: 'decrement', amount: 1 },
        { name: 'Ethernet1', action: 'shutdown' },
        { name: 'Ethernet2', action: 'decrement', amount: 1 },
        { name: 'Ethernet2', action: 'shutdown' },
      ],
      bfdIp: '10.10.60.30',
    }
    const scripts = [
      'interface Ethernet1',
      'vrrp 10 shutdown',
      'vrrp 10 ip 10.10.60.10',
      'vrrp 10 priority 200',
      'vrrp 10 description modified vrrp 10 on Ethernet1',
      'vrrp 10 ip version 3',
      'vrrp 10 ip 10.10.60.20 secondary',
      'vrrp 10 ip 10.10.60.30 secondary',
      'vrrp 10 timers advertise 2',
      'vrrp 10 mac-address advertisement-interval 3',
      'vrrp 10 preempt',
      'vrrp 10 preempt delay minimum 1',
      'vrrp 10 preempt delay reload 1',
      'vrrp 10 delay reload 1',
      'vrrp 10 track Ethernet1 decrement 1',
      'vrrp 10 track Ethernet1 shutdown',
      'vrrp 10 track Ethernet2 decrement 1',
      'vrrp 10 track Ethernet2 shutdown',
      'vrrp 10 bfd ip 10.10.60.30',
    ]
    scriptWrite(transport, scripts)
    await node.vrrp.create('Ethernet1', 10, configuration)
    expect(sentScripts(transport).at(-1)).toEqual(['enable', 'configure terminal', ...scripts])
  })

  it("create with every property set to 'no' composes the negation set (port :241-275)", async () => {
    const { node, transport } = nodeFor(VRRP_CONFIG)
    const configuration: VrrpAttrs = {
      primaryIp: 'no',
      priority: 'no',
      description: 'no',
      secondaryIp: [],
      ipVersion: 'no',
      timersAdvertise: 'no',
      macAddrAdvInterval: 'no',
      preempt: 'no',
      preemptDelayMin: 'no',
      preemptDelayReload: 'no',
      delayReload: 'no',
      track: [],
      bfdIp: 'no',
    }
    const scripts = [
      'interface Ethernet1',
      'vrrp 10 shutdown',
      // The current address is read back off the interface's own state — exactly like upstream's
      // unguarded `vrrps[vrid]['primary_ip']` at `:535-536`, which this port reads through
      // currentPrimaryIp (vrrp.ts divergence 4).
      'no vrrp 10 ip 10.10.6.10',
      'no vrrp 10 priority',
      'no vrrp 10 description',
      'no vrrp 10 ip version',
      'no vrrp 10 timers advertise',
      'no vrrp 10 mac-address advertisement-interval',
      'no vrrp 10 preempt',
      'no vrrp 10 preempt delay minimum',
      'no vrrp 10 preempt delay reload',
      'no vrrp 10 delay reload',
      'no vrrp 10 bfd ip',
    ]
    scriptWrite(transport, scripts)
    await node.vrrp.create('Ethernet1', 10, configuration)
    expect(sentScripts(transport).at(-1)).toEqual(['enable', 'configure terminal', ...scripts])
  })

  it("create with every property set to 'default' composes the default set (port :277-311)", async () => {
    const { node, transport } = nodeFor(VRRP_CONFIG)
    const configuration: VrrpAttrs = {
      primaryIp: 'default',
      priority: 'default',
      description: 'default',
      secondaryIp: [],
      ipVersion: 'default',
      timersAdvertise: 'default',
      macAddrAdvInterval: 'default',
      preempt: 'default',
      preemptDelayMin: 'default',
      preemptDelayReload: 'default',
      delayReload: 'default',
      track: [],
      bfdIp: 'default',
    }
    const scripts = [
      'interface Ethernet1',
      'vrrp 10 shutdown',
      'default vrrp 10 ip 10.10.6.10',
      'default vrrp 10 priority',
      'default vrrp 10 description',
      'default vrrp 10 ip version',
      'default vrrp 10 timers advertise',
      'default vrrp 10 mac-address advertisement-interval',
      'default vrrp 10 preempt',
      'default vrrp 10 preempt delay minimum',
      'default vrrp 10 preempt delay reload',
      'default vrrp 10 delay reload',
      'default vrrp 10 bfd ip',
    ]
    scriptWrite(transport, scripts)
    await node.vrrp.create('Ethernet1', 10, configuration)
    expect(sentScripts(transport).at(-1)).toEqual(['enable', 'configure terminal', ...scripts])
  })

  it('delete/default send the bare pair lines (port test_delete :313-326, test_default :328-341)', async () => {
    const { node, transport } = nodeFor(VRRP_CONFIG)
    const del = ['interface Ethernet1', 'no vrrp 10']
    const def = ['interface Ethernet1', 'default vrrp 10']
    scriptWrite(transport, del).replies(writeKey(def), okFor(def))
    await node.vrrp.delete('Ethernet1', 10)
    await node.vrrp.setDefault('Ethernet1', 10)
    expect(sentScripts(transport).slice(-2)).toEqual([
      ['enable', 'configure terminal', 'interface Ethernet1', 'no vrrp 10'],
      ['enable', 'configure terminal', 'interface Ethernet1', 'default vrrp 10'],
    ])
  })
})

describe('VrrpResource scalar setters — port of the nine set_* value/mode/invalid tests', () => {
  // The upstream pair-updating loops ((value, disable, default, cmd) tuples) become one
  // explicit list of the same four-quadrant cases per verb (memory rule: pin each case rather
  // than lean on an inferred loop).
  const upd = { iface: 'Vlan50', vrid: 10 } as const

  it('the four primary_ip quadrants pin test_set_primary_ip :372-384 exactly', async () => {
    const { node, transport } = nodeFor(VRRP_CONFIG)
    const cases: Array<{ options: { value?: string; mode?: 'no' | 'default' }; cmd: string }> = [
      { options: { value: '10.10.4.110' }, cmd: 'vrrp 10 ip 10.10.4.110' },
      { options: { mode: 'no' }, cmd: 'no vrrp 10 ip 10.10.4.10' },
      { options: { mode: 'default' }, cmd: 'default vrrp 10 ip 10.10.4.10' },
      // Upstream :380 hands BOTH disable=True and default=True — default wins (the `if default`
      // precedes at `:526`), reproduced by passing only mode:'default' (the mode bag has no both-set state).
      { options: { mode: 'default' }, cmd: 'default vrrp 10 ip 10.10.4.10' },
    ]
    for (const { options, cmd } of cases) {
      scriptWrite(transport, [`interface ${upd.iface}`, cmd])
      expect(await node.vrrp.setPrimaryIp('Vlan50', 10, options)).toBe(cmd)
    }
    const sent = writeScripts(transport).slice(-cases.length)
    expect(sent.map((s) => s.at(-1))).toEqual(cases.map(({ cmd }) => cmd))
  })

  it("invalid primary_ip values refuse, and setPrimaryIp's dry-run still composes (ValueError arm :386-395)", async () => {
    const { node, transport } = nodeFor(VRRP_CONFIG)
    for (const bad of ['abc', '500', '101.101']) {
      await expectError(() => node.vrrp.setPrimaryIp('Vlan50', 10, { value: bad }), /primary_ip/)
    }
    await expectError(() => node.vrrp.setPrimaryIp('Vlan50', 10, { value: 500 as unknown as string }), /primary_ip/)
    // Upstream tests pass 500 POSITIONALLY — an int reaching its `str(value)` regex test (`:543`)
    // and refusing; same outcome from this client, via the type-level string plus the runtime grammar.
    // The framework's own row-73 refusal stands between a JS `false` and a command (vrrp.ts
    // divergence 4's refusal of the accidental `value is None` arm):
    await expectError(() => node.vrrp.setPrimaryIp('Vlan50', 10, {}), /mode: "no"/)
    expect(onlyReads(transport)).toBe(true)
    // Dry run (upstream's run=False, :496-503 twin) composes without sending:
    const staged = await node.vrrp.setPrimaryIp('Vlan50', 10, { value: '10.10.4.111', run: false })
    expect(staged).toBe('vrrp 10 ip 10.10.4.111')
    expect(onlyReads(transport)).toBe(true)
  })

  it('the current-address refusals have no upstream analogue because upstream CRASHES there (vrrp.ts divergence 4)', async () => {
    // Upstream: `vrrps[vrid]['primary_ip']` with NO guard (`:528-529`, `:535-536`) — TypeError on an
    // interface without vrrps, KeyError on an absent vrid, and the literal text `no vrrp 10 ip None`
    // when an entry exists without a primary ip. All three become NotFoundError here, and nothing ships.
    const { node, transport } = nodeFor(VRRP_CONFIG)
    await expectError(() => node.vrrp.setPrimaryIp('Port-Channel1', 10, { mode: 'no' }), /has no vrrp configuration/)
    await expectError(() => node.vrrp.setPrimaryIp('Vlan50', 999, { mode: 'no' }), /no vrid 999/)
    expect(onlyReads(transport)).toBe(true)
    // The entry-exists-without-a-primary-ip case: `vrrp 1 shutdown` carries the census hit, and the
    // parser answers no primary ip — upstream would compose the literal text 'no vrrp 1 ip None'.
    const sparse = textOf(['interface Loopback9', '   vrrp 1 shutdown', 'end'])
    const { node: sparseNode, transport: sparseTransport } = nodeFor(sparse)
    expect((await sparseNode.vrrp.get('Loopback9'))?.get(1)?.primaryIp).toBeUndefined()
    await expectError(() => sparseNode.vrrp.setPrimaryIp('Loopback9', 1, { mode: 'default' }), /no primary_ip/)
    expect(onlyReads(sparseTransport)).toBe(true)
  })

  it('priority: value/default/default-both/no cases pin test_set_priority :380-391', async () => {
    const { node, transport } = nodeFor(VRRP_CONFIG)
    const cases: Array<[unknown, string]> = [
      [{ value: 150 }, 'vrrp 10 priority 150'],
      [{ mode: 'default' }, 'default vrrp 10 priority'],
      [{ mode: 'default' }, 'default vrrp 10 priority'],
      [{ mode: 'no' }, 'no vrrp 10 priority'],
    ]
    for (const [options, cmd] of cases) {
      scriptWrite(transport, [`interface ${upd.iface}`, cmd])
      expect(await node.vrrp.setPriority('Vlan50', 10, options as { value?: number; mode?: 'no' | 'default' })).toBe(cmd)
    }
  })

  it('priority invalid values refuse (upstream ValueError set :393-401)', async () => {
    const { node, transport } = nodeFor(VRRP_CONFIG)
    await expectError(() => node.vrrp.setPriority('Vlan50', 10, { value: 'abc' as unknown as number }), /range 1-254/)
    await expectError(() => node.vrrp.setPriority('Vlan50', 10, { value: 500 }), /range 1-254/)
    await expectError(() => node.vrrp.setPriority('Vlan50', 10, { value: false as unknown as number }), /range 1-254/)
    expect(onlyReads(transport)).toBe(true)
  })

  it('description cases pin test_set_description :405-425 — the value passes through with spaces', async () => {
    const { node, transport } = nodeFor(VRRP_CONFIG)
    const cases: Array<[unknown, string]> = [
      [{ value: 'test description' }, 'vrrp 10 description test description'],
      [{ mode: 'default' }, 'default vrrp 10 description'],
      [{ mode: 'default' }, 'default vrrp 10 description'],
      [{ mode: 'no' }, 'no vrrp 10 description'],
    ]
    for (const [options, cmd] of cases) {
      scriptWrite(transport, [`interface ${upd.iface}`, cmd])
      expect(await node.vrrp.setDescription('Vlan50', 10, options as { value?: string; mode?: 'no' | 'default' })).toBe(cmd)
    }
  })

  it('ip_version cases and invalid refuse pin test_set_ip_version :443-471', async () => {
    const { node, transport } = nodeFor(VRRP_CONFIG)
    const cases: Array<[unknown, string]> = [
      [{ value: 2 }, 'vrrp 10 ip version 2'],
      [{ mode: 'default' }, 'default vrrp 10 ip version'],
      [{ mode: 'default' }, 'default vrrp 10 ip version'],
      [{ mode: 'no' }, 'no vrrp 10 ip version'],
    ]
    for (const [options, cmd] of cases) {
      scriptWrite(transport, [`interface ${upd.iface}`, cmd])
      expect(await node.vrrp.setIpVersion('Vlan50', 10, options as { value?: number; mode?: 'no' | 'default' })).toBe(cmd)
    }
    const writesBeforeInvalid = writeScripts(transport).length
    await expectError(() => node.vrrp.setIpVersion('Vlan50', 10, { value: 'a' as unknown as number }), /must be 2 or 3/)
    await expectError(() => node.vrrp.setIpVersion('Vlan50', 10, { value: 5 }), /must be 2 or 3/)
    expect(writeScripts(transport)).toHaveLength(writesBeforeInvalid)
  })

  it('timers_advertise cases and invalid refuse pin test_set_timers_advertise :494-528', async () => {
    const { node, transport } = nodeFor(VRRP_CONFIG)
    const cases: Array<[unknown, string]> = [
      [{ value: 50 }, 'vrrp 10 timers advertise 50'],
      [{ mode: 'default' }, 'default vrrp 10 timers advertise'],
      [{ mode: 'default' }, 'default vrrp 10 timers advertise'],
      [{ mode: 'no' }, 'no vrrp 10 timers advertise'],
    ]
    for (const [options, cmd] of cases) {
      scriptWrite(transport, [`interface ${upd.iface}`, cmd])
      expect(await node.vrrp.setTimersAdvertise('Vlan50', 10, options as { value?: number; mode?: 'no' | 'default' })).toBe(cmd)
    }
    const writesBeforeInvalid = writeScripts(transport).length
    await expectError(() => node.vrrp.setTimersAdvertise('Vlan50', 10, { value: 256 }), /range 1-255/)
    await expectError(() => node.vrrp.setTimersAdvertise('Vlan50', 10, { value: 0 }), /range 1-255/)
    await expectError(() => node.vrrp.setTimersAdvertise('Vlan50', 10, { value: 'a' as unknown as number }), /range 1-255/)
    expect(writeScripts(transport)).toHaveLength(writesBeforeInvalid)
  })

  it('mac_addr_adv_interval cases and invalid refuse pin test_set_mac_addr_adv_interval :520-552', async () => {
    const { node, transport } = nodeFor(VRRP_CONFIG)
    const stem = 'vrrp 10 mac-address advertisement-interval'
    const cases: Array<[unknown, string]> = [
      [{ value: 50 }, `${stem} 50`],
      [{ mode: 'default' }, `default ${stem}`],
      [{ mode: 'default' }, `default ${stem}`],
      [{ mode: 'no' }, `no ${stem}`],
    ]
    for (const [options, cmd] of cases) {
      scriptWrite(transport, [`interface ${upd.iface}`, cmd])
      expect(await node.vrrp.setMacAddrAdvInterval('Vlan50', 10, options as { value?: number; mode?: 'no' | 'default' })).toBe(cmd)
    }
    const writesBeforeInvalid = writeScripts(transport).length
    await expectError(() => node.vrrp.setMacAddrAdvInterval('Vlan50', 10, { value: 'a' as unknown as number }), /range 1-3600/)
    await expectError(() => node.vrrp.setMacAddrAdvInterval('Vlan50', 10, { value: 10000 }), /range 1-3600/)
    expect(writeScripts(transport)).toHaveLength(writesBeforeInvalid)
  })

  it('preempt: false composes through mode:"no" and STILL answers the upstream text (port test_set_preempt :553-581)', async () => {
    const { node, transport } = nodeFor(VRRP_CONFIG)
    const cases: Array<[unknown, string]> = [
      // Upstream reaches `no vrrp 10 preempt` via command_builder's falsy fall-through
      // (abstract.py:155-161) — refused by this client and composed through mode:'no' instead,
      // same text (vrrp.ts divergence 3).
      [{ value: false }, 'no vrrp 10 preempt'],
      [{ value: true }, 'vrrp 10 preempt'],
      [{ mode: 'default' }, 'default vrrp 10 preempt'],
      [{ mode: 'default' }, 'default vrrp 10 preempt'],
      [{ mode: 'no' }, 'no vrrp 10 preempt'],
    ]
    for (const [options, cmd] of cases) {
      scriptWrite(transport, [`interface ${upd.iface}`, cmd])
      expect(await node.vrrp.setPreempt('Vlan50', 10, options as { value?: boolean; mode?: 'no' | 'default' })).toBe(cmd)
    }
    const writesBeforeInvalid = writeScripts(transport).length
    await expectError(() => node.vrrp.setPreempt('Vlan50', 10, { value: 'a' as unknown as boolean }), /must be true or false/)
    await expectError(() => node.vrrp.setPreempt('Vlan50', 10, { value: 5 as unknown as boolean }), /must be true or false/)
    expect(writeScripts(transport)).toHaveLength(writesBeforeInvalid)
  })

  it('the three delay timers pin :583-688 (preempt_delay_min, preempt_delay_reload, delay_reload)', async () => {
    const { node, transport } = nodeFor(VRRP_CONFIG)
    const trio: Array<{ run: (o: { value?: number; mode?: 'no' | 'default' }) => Promise<string>; value: number; stem: string }> = [
      { run: (o) => node.vrrp.setPreemptDelayMin('Vlan50', 10, o), value: 2500, stem: 'vrrp 10 preempt delay minimum' },
      { run: (o) => node.vrrp.setPreemptDelayReload('Vlan50', 10, o), value: 1500, stem: 'vrrp 10 preempt delay reload' },
      // delay_reload is the family-gated one: a legacy-text config (this fixture) gets the legacy
      // stem `delay reload`; the modern twin (`timers delay reload`) is the same verb on modern text.
      { run: (o) => node.vrrp.setDelayReload('Vlan50', 10, o), value: 1750, stem: 'vrrp 10 delay reload' },
    ]
    for (const { run, value, stem } of trio) {
      const cases: Array<[{ value?: number; mode?: 'no' | 'default' }, string]> = [
        [{ value }, `${stem} ${String(value)}`],
        [{ mode: 'default' }, `default ${stem}`],
        [{ mode: 'default' }, `default ${stem}`],
        [{ mode: 'no' }, `no ${stem}`],
      ]
      for (const [options, cmd] of cases) {
        scriptWrite(transport, [`interface ${upd.iface}`, cmd])
        expect(await run(options)).toBe(cmd)
      }
      const writesBeforeInvalid = writeScripts(transport).length
      await expectError(() => run({ value: 'a' as unknown as number }), /range 1-3600/)
      await expectError(() => run({ value: 3601 }), /range 1-3600/)
      expect(writeScripts(transport)).toHaveLength(writesBeforeInvalid)
    }
  })

  it('bfd_ip pins test_set_bfd_ip :736-762 — the era-neutral stem and the quad grammar', async () => {
    const { node, transport } = nodeFor(VRRP_CONFIG)
    const cases: Array<[unknown, string]> = [
      [{ value: '10.10.4.101' }, 'vrrp 10 bfd ip 10.10.4.101'],
      [{ mode: 'no' }, 'no vrrp 10 bfd ip'],
      [{ mode: 'default' }, 'default vrrp 10 bfd ip'],
      [{ mode: 'default' }, 'default vrrp 10 bfd ip'],
    ]
    for (const [options, cmd] of cases) {
      scriptWrite(transport, [`interface ${upd.iface}`, cmd])
      expect(await node.vrrp.setBfdIp('Vlan50', 10, options as { value?: string; mode?: 'no' | 'default' })).toBe(cmd)
    }
    const writesBeforeInvalid = writeScripts(transport).length
    for (const bad of ['abc', '101.101', 500 as unknown as string]) {
      await expectError(() => node.vrrp.setBfdIp('Vlan50', 10, { value: bad }), /bfd_ip/)
    }
    expect(writeScripts(transport)).toHaveLength(writesBeforeInvalid)
  })

  it("set_enable pins :343-365's two texts and its strict boolean rule", async () => {
    const { node, transport } = nodeFor(VRRP_CONFIG)
    for (const [value, cmd] of [[false, 'vrrp 10 shutdown'], [true, 'no vrrp 10 shutdown']] as const) {
      scriptWrite(transport, [`interface ${upd.iface}`, cmd])
      expect(await node.vrrp.setEnable('Vlan50', 10, value)).toBe(cmd)
    }
    const writesBeforeInvalid = writeScripts(transport).length
    await expectError(() => node.vrrp.setEnable('Vlan50', 10, 'a' as unknown as boolean), /must be true or false/)
    await expectError(() => node.vrrp.setEnable('Vlan50', 10, 200 as unknown as boolean), /must be true or false/)
    expect(writeScripts(transport)).toHaveLength(writesBeforeInvalid)
  })
})

describe('VrrpResource diffing verbs — setSecondaryIps (:469-520) and setTracks (:690-756)', () => {
  const upd = { iface: 'Vlan50', vrid: 10 } as const
  const curr1 = '10.10.4.21'
  const curr2 = '10.10.4.22'
  const curr3 = '10.10.4.23'
  const curr4 = '10.10.4.24'
  const new1 = '10.10.4.31'
  const new2 = '10.10.4.32'
  const new3 = '10.10.4.33'

  it('the three secondary-ips diff cases compose add/remove sets, sorted, exactly like upstream', async () => {
    const { node, transport } = nodeFor(VRRP_CONFIG)
    const cases: Array<[readonly string[], string[]]> = [
      [[new1, new2, new3], [new1, new2, new3].map((ip) => `vrrp 10 ip ${ip} secondary`)
        .concat([curr1, curr2, curr3, curr4].map((ip) => `no vrrp 10 ip ${ip} secondary`))
        .sort()],
      // new2 of this case deliberately REUSES curr4 — the keep-side that upstream :480 pins:
      [[new1, new2, curr4], [new1, new2].map((ip) => `vrrp 10 ip ${ip} secondary`)
        .concat([curr1, curr2, curr3].map((ip) => `no vrrp 10 ip ${ip} secondary`))
        .sort()],
      [[], [curr1, curr2, curr3, curr4].map((ip) => `no vrrp 10 ip ${ip} secondary`).sort()],
    ]
    for (const [secondaryIps, cmds] of cases) {
      const script = [`interface ${upd.iface}`, ...cmds]
      scriptWrite(transport, script)
      expect(await node.vrrp.setSecondaryIps('Vlan50', 10, secondaryIps)).toEqual(cmds)
    }
    expect(writeScripts(transport).slice(-3).map((s) => s.slice(3))).toEqual(cases.map(([, cmds]) => cmds))
  })

  it('a non-address inside the list refuses per element (upstream :511-519)', async () => {
    const { node, transport } = nodeFor(VRRP_CONFIG)
    const badLists: readonly unknown[][] = [
      [new1, new2, 'abc'],
      [new1, new2, '10.10.10'],
      [new1, new2, true],
    ]
    for (const bad of badLists) {
      await expectError(() => node.vrrp.setSecondaryIps('Vlan50', 10, bad as readonly string[]), /secondary_ip/)
    }
    expect(onlyReads(transport)).toBe(true)
  })

  it('dry-run secondary ips compose without sending AND diff against the live state', async () => {
    const { node, transport } = nodeFor(VRRP_CONFIG)
    const cmds = await node.vrrp.setSecondaryIps('Vlan50', 10, [curr1, '10.10.4.99'], { run: false })
    // curr2,curr3,curr4 must go; 99 must come; curr1 stays. Sorted like upstream `:756`.
    expect(cmds).toEqual([
      'no vrrp 10 ip 10.10.4.22 secondary',
      'no vrrp 10 ip 10.10.4.23 secondary',
      'no vrrp 10 ip 10.10.4.24 secondary',
      'vrrp 10 ip 10.10.4.99 secondary',
    ])
    expect(onlyReads(transport)).toBe(true)
  })

  // The six current tracks (fixture, Vlan50 vrid 10) and six new ones, exactly as upstream :690-703.
  const currT1: VrrpTrack = { name: 'Ethernet1', action: 'decrement', amount: 10 }
  const currT2: VrrpTrack = { name: 'Ethernet1', action: 'shutdown' }
  const currT3: VrrpTrack = { name: 'Ethernet2', action: 'decrement', amount: 50 }
  const currT4: VrrpTrack = { name: 'Ethernet2', action: 'shutdown' }
  const currT5: VrrpTrack = { name: 'Ethernet11', action: 'decrement', amount: 75 }
  const currT6: VrrpTrack = { name: 'Ethernet11', action: 'shutdown' }
  const newT2: VrrpTrack = { name: 'Ethernet2', action: 'decrement', amount: 49 }
  const newT3: VrrpTrack = { name: 'Ethernet3', action: 'shutdown' }
  const newT4: VrrpTrack = { name: 'Ethernet4', action: 'decrement', amount: 50 }
  const newT5: VrrpTrack = { name: 'Ethernet5', action: 'shutdown' }
  const newT6: VrrpTrack = { name: 'Ethernet9', action: 'decrement', amount: 75 }

  const legacyTrack = (t: VrrpTrack): string =>
    `vrrp 10 track ${t.name} ${t.action}${t.amount === undefined ? '' : ` ${String(t.amount)}`}`
  const legacyNoTrack = (t: VrrpTrack): string => `no ${legacyTrack(t)}`

  it('the three track-diff cases compose the same texts upstream sorts against (:705-736)', async () => {
    const { node, transport } = nodeFor(VRRP_CONFIG)
    const cases: Array<[readonly VrrpTrack[], VrrpTrack[], VrrpTrack[]]> = [
      // add [newT2]; remove currT2, currT3, currT4 (newT1 IS currT1 — the keep-side).
      [[currT6, currT5, currT1, newT2], [newT2], [currT2, currT3, currT4]],
      [[newT2, newT3, newT4, newT5, newT6], [newT2, newT3, newT4, newT5, newT6], [currT1, currT2, currT3, currT4, currT5, currT6]],
      [[], [], [currT1, currT2, currT3, currT4, currT5, currT6]],
    ]
    for (const [tracks, adds, removes] of cases) {
      const cmds = adds.map(legacyTrack).concat(removes.map(legacyNoTrack)).sort()
      const script = [`interface ${upd.iface}`, ...cmds]
      scriptWrite(transport, script)
      expect(await node.vrrp.setTracks('Vlan50', 10, tracks)).toEqual(cmds)
      expect(sentScripts(transport).at(-1)).toEqual(['enable', 'configure terminal', ...script])
    }
  })

  it('every malformed track dict refuses — the five upstream ValueErrors (:738-752) each pinned separately', async () => {
    const { node, transport } = nodeFor(VRRP_CONFIG)
    const badCases: readonly unknown[][] = [
      [{ name: 'Ethernet1', action: 'disable', amount: 10 }],
      [{ name: 'Ethernet1', action: 'decrement', amount: true }],
      [{ name: 'Ethernet1', action: 'shutdown', amount: 10 }],
      [{ action: 'decrement', amount: 10 }],
      [{ name: 'Ethernet1', action: 'decrement', amount: 10, bad: 1 }],
    ]
    for (const tracks of badCases) {
      await expectError(() => node.vrrp.setTracks('Vlan50', 10, tracks as readonly VrrpTrack[]), /invalid vrrp track entry/)
    }
    expect(onlyReads(transport)).toBe(true)
  })

  it('dry-run tracks compose with the rstripped no-amount text and stay un-sent', async () => {
    const { node, transport } = nodeFor(VRRP_CONFIG)
    const cmds = await node.vrrp.setTracks('Vlan50', 10, [currT1, currT2, { name: 'Ethernet3', action: 'decrement', amount: 40 }], { run: false })
    // current-minus-wanted removes T3/T4/T5/T6 (T1/T2 already align); wanted-minus-current adds
    // Ethernet3. The two `shutdown` removals pin the rstripped no-amount text (no trailing space,
    // vrrp.py:1161/:1177).
    expect(cmds).toEqual([
      'no vrrp 10 track Ethernet11 decrement 75',
      'no vrrp 10 track Ethernet11 shutdown',
      'no vrrp 10 track Ethernet2 decrement 50',
      'no vrrp 10 track Ethernet2 shutdown',
      'vrrp 10 track Ethernet3 decrement 40',
    ].sort())
    expect(onlyReads(transport)).toBe(true)
  })
})

describe('vrconfFormat — port of test_vrconf_format (:787-809), the PLAN §4 named helper', () => {
  it('the documented normalization table applies, shallow-copy, lists sorted', () => {
    const vrconf: VrrpConf = {
      priority: null,
      timersAdvertise: null,
      macAddrAdvInterval: null,
      preempt: 'default',
      preemptDelayMin: null,
      preemptDelayReload: null,
      delayReload: null,
      primaryIp: null,
      secondaryIp: ['10.10.4.22', '10.10.4.21'],
      description: null,
      enable: true,
      track: [
        { name: 'Ethernet1', action: 'shutdown' },
        { name: 'Ethernet1', action: 'decrement', amount: 10 },
      ],
      bfdIp: null,
      ipVersion: null,
    }
    const fixed: VrrpConf = {
      priority: 100,
      timersAdvertise: 1,
      macAddrAdvInterval: 30,
      preempt: false,
      preemptDelayMin: 0,
      preemptDelayReload: 0,
      delayReload: 0,
      primaryIp: '0.0.0.0',
      secondaryIp: ['10.10.4.21', '10.10.4.22'],
      description: null,
      enable: true,
      track: [
        { name: 'Ethernet1', action: 'decrement', amount: 10 },
        { name: 'Ethernet1', action: 'shutdown' },
      ],
      bfdIp: '',
      ipVersion: 2,
    }
    const vrrp = vrrpFor()
    expect(vrrp.vrconfFormat(vrconf)).toEqual(fixed)
    // Upstream `fixed = dict(vrconfig)` (`:1426`) copies first — the caller's lists never sort in
    // place; the same non-mutation rule row 71 holds for the bag itself:
    expect(vrconf.secondaryIp).toEqual(['10.10.4.22', '10.10.4.21'])
    expect(vrconf.track?.[0]?.action).toBe('shutdown')
  })

  it('the formatter is identity on parsed records — the equivalence test_get leans on (:150-157)', async () => {
    const vrrp = vrrpFor()
    const table = await vrrp.get('Vlan50')
    const formatted = new Map<number, VrrpConf>()
    for (const [vrid, entry] of table as VrrpVridTable) formatted.set(vrid, vrrp.vrconfFormat(entry as VrrpConf))
    expect(formatted).toEqual(table as unknown as Map<number, VrrpConf>)
  })

  it("the preempt-null quirk survives: ('no','default') normalize, null does NOT (vrrp.py:1452)", () => {
    const vrrp = vrrpFor()
    expect(vrrp.vrconfFormat({ preempt: null })).toEqual({ preempt: null })
    expect(vrrp.vrconfFormat({ preempt: 'no' })).toEqual({ preempt: false })
  })
})
