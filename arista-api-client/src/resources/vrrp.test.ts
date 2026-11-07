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
 * byte-for-byte from `pyeapi/test/fixtures/running_config.vrrp` @ `6816d9e`: the four section headers
 * (`:7`, `:126`, `:265`, `:415`) and every vrrp line (`:248-263`, `:399-413`, `:474-531`) — with the
 * non-`vrrp` body lines of each block omitted (no
 * vrrp reader consults them; the census regex `vrrp.py:200` and all fourteen parsers see only the
 * lines kept). The `!` separators and the trailing `end` keep the chunking shape. Never captured
 * from the 7050TX-64, and no EOS-side acceptance is claimed (M12 #14 owns that).
 *
 * ## Upstream port ledger
 *
 * `pyeapi/test/unit/test_api_vrrp.py` has **23** test methods (verified in the pinned clone on
 * 2026-11-06; every range verified by awk of the def lines): `test_instance` (`:147-150`), `test_get`
 * (`:151-159`), `test_get_non_existent_interface` (`:160-165`), `test_get_invalid_parameters`
 * (`:166-172`), `test_getall` (`:173-177`), `test_create` (`:178-300`, THREE sub-cases: full config
 * `:184-222`, all-`'no'` `:224-259`, all-`'default'` `:261-300`), `test_delete` (`:301-313`),
 * `test_default` (`:314-326`), `test_set_enable` (`:327-347`, incl. ValueError cases `:342-346`),
 * `test_set_primary_ip` (`:348-374`, cases `:354-359`, invalid `:368-373`), `test_set_priority`
 * (`:375-399`, invalid `:393-398`), `test_set_description` (`:400-419`), `test_set_ip_version`
 * (`:420-443`, invalid `:437-442`), `test_set_secondary_ips` (`:444-496`, invalid `:486-495`),
 * `test_set_timers_advertise` (`:497-522`, invalid `:516-521`), `test_set_mac_addr_adv_interval`
 * (`:523-549`, invalid `:543-548`), `test_set_preempt` (`:550-575`, invalid `:569-574`),
 * `test_set_preempt_delay_min` (`:576-604`), `test_set_preempt_delay_reload` (`:605-633`),
 * `test_set_delay_reload` (`:634-659`), `test_set_tracks` (`:660-730`, invalid `:718-729`),
 * `test_set_bfd_ip` (`:731-757`), `test_vrconf_format` (`:758-808`).
 * All twenty-three are ported below with their pinned command texts reproduced **verbatim**, and note
 * WHICH family upstream pins: the fake node pins `version_number = '4.17.1.1'`
 * (`test/lib/testlib.py:75`), so every text is the legacy arm (`ip`, `shutdown`, `track`,
 * `timers advertise`, `description`, `priority`, `delay reload`, `ip version`) — which the config-text
 * detection (DR-099's vrrp twin) reproduces from this fixture's own legacy lines. The modern arm is
 * exercised by the sibling lanes' captures, not by extra suite mass this round.
 *
 * Two upstream order-dependencies are called out where the port breaks them:
 *  - `known_vrrps` is MUTATED by `test_get` (`:155-156` runs `vrconf_format` over each entry in
 *    place), which is what un-breaks its `track` list ordering for `test_getall` (`:173-177`) —
 *    Python sorts parsed tracks by `(name, action)` (`vrrp.py:388`, so `Ethernet11` lands
 *    BETWEEN `Ethernet1` and `Ethernet2`), while the literal lists at `:92-99`/`:113-116` are in
 *    file order. Here the expected records are written once, in the parsed (sorted) order, and both
 *    tests compare the same values.
 *  - `test_get` re-formats with `vrconf_format` before comparing (`:156`); applied to already-parsed
 *    records that pass is identity (no sentinels in them), so the port compares parsed records
 *    directly and `test_vrconf_format` pins the formatter itself.
 */

import { describe, expect, it } from 'vitest'

import { Node } from '../command-layer'
import { ConfigParseError } from '../errors'
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
 * actively EXCLUDE it — upstream excludes it by the falsy-`get()` rule (`:246-248`: no census match,
 * `vrrp.py:201-202`), and this port excludes it the identical way.
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
 * The upstream `known_vrrps` literal (`test_api_vrrp.py:48-135`) restated in the parsed (get-shape) form,
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
      // `sorted(key=(name, action))`, vrrp.py:388 — Ethernet11 sorts between Ethernet1 and
      // Ethernet2 (string compare), which the upstream literal list at :92-99 only reveals AFTER its
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

describe('W3c wiring — port of test_instance (test_api_vrrp.py:147-150) into the registry', () => {
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

describe('VrrpResource reads — get (port test_get :151-159) and getAll (port test_getall :173-177)', () => {
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

  it('an interface the switch does not have answers undefined (port test_get_non_existent_interface :160-165)', async () => {
    expect(await vrrpFor().get('Vlan2000')).toBeUndefined()
    // And an interface the switch HAS but that carries no vrrp lines: upstream `get` returns None
    // via the empty-census path (`:201-202`) — Vlan2000 exercises the missing-block path (`:194-196`);
    // Port-Channel1 below exercises the census-empty path through getAll.
    expect(await vrrpFor().get('Port-Channel1')).toBeUndefined()
  })

  it("get's empty/None names refuse (port test_get_invalid_parameters :166-172) and cost zero reads", async () => {
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
    // Port-Channel1 is a candidate (`:242` matches it too) but is EXCLUDED by the empty-census rule.
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

describe('VrrpResource create/delete/default — test_api_vrrp.py:178-326, texts verbatim', () => {
  it('create of a full configuration sends the whole _vrrp_set sequence in ONE transaction (port :184-222)', async () => {
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

  it("create with every property set to 'no' composes the negation set (port :224-259)", async () => {
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

  it("create with every property set to 'default' composes the default set (port :261-300)", async () => {
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

  it('delete/default send the bare pair lines (port test_delete :301-313, test_default :314-326)', async () => {
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

  it('the four primary_ip quadrants pin test_set_primary_ip :354-359 exactly', async () => {
    const { node, transport } = nodeFor(VRRP_CONFIG)
    const cases: Array<{ options: { value?: string; mode?: 'no' | 'default' }; cmd: string }> = [
      { options: { value: '10.10.4.110' }, cmd: 'vrrp 10 ip 10.10.4.110' },
      { options: { mode: 'no' }, cmd: 'no vrrp 10 ip 10.10.4.10' },
      { options: { mode: 'default' }, cmd: 'default vrrp 10 ip 10.10.4.10' },
      // Upstream :358 hands BOTH disable=True and default=True — default wins (the `if default is
      // True:` at vrrp.py:527 precedes the `elif` at `:534`), reproduced by passing only
      // mode:'default' (this client's mode bag has no both-set state).
      { options: { mode: 'default' }, cmd: 'default vrrp 10 ip 10.10.4.10' },
    ]
    for (const { options, cmd } of cases) {
      scriptWrite(transport, [`interface ${upd.iface}`, cmd])
      expect(await node.vrrp.setPrimaryIp('Vlan50', 10, options)).toBe(cmd)
    }
    const sent = writeScripts(transport).slice(-cases.length)
    expect(sent.map((s) => s.at(-1))).toEqual(cases.map(({ cmd }) => cmd))
  })

  it("invalid primary_ip values refuse, and setPrimaryIp's dry-run still composes (ValueError arm :368-374 of the test, vrrp.py:545-548)", async () => {
    const { node, transport } = nodeFor(VRRP_CONFIG)
    for (const bad of ['abc', '500', '101.101']) {
      await expectError(() => node.vrrp.setPrimaryIp('Vlan50', 10, { value: bad }), /primary_ip/)
    }
    await expectError(() => node.vrrp.setPrimaryIp('Vlan50', 10, { value: 500 as unknown as string }), /primary_ip/)
    // Upstream tests pass 500 POSITIONALLY — an int reaching its `str(value)` regex test (`vrrp.py:541`)
    // and refusing; same outcome from this client, via the type-level string plus the runtime grammar.
    // The framework's own row-73 refusal stands between a JS `false` and a command (vrrp.ts
    // divergence 4's refusal of the accidental `value is None` arm):
    await expectError(() => node.vrrp.setPrimaryIp('Vlan50', 10, {}), /mode: "no"/)
    expect(onlyReads(transport)).toBe(true)
    // Dry run (upstream's run=False, :495-503 twin) composes without sending:
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

  it('priority: value/default/default-both/no cases pin test_set_priority :379-389', async () => {
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

  it('priority invalid values refuse (upstream ValueError set :393-398)', async () => {
    const { node, transport } = nodeFor(VRRP_CONFIG)
    await expectError(() => node.vrrp.setPriority('Vlan50', 10, { value: 'abc' as unknown as number }), /range 1-254/)
    await expectError(() => node.vrrp.setPriority('Vlan50', 10, { value: 500 }), /range 1-254/)
    await expectError(() => node.vrrp.setPriority('Vlan50', 10, { value: false as unknown as number }), /range 1-254/)
    expect(onlyReads(transport)).toBe(true)
  })

  it('description cases pin test_set_description :404-417 — the value passes through with spaces', async () => {
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

  it('ip_version cases and invalid refuse pin test_set_ip_version :423-442', async () => {
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

  it('timers_advertise cases and invalid refuse pin test_set_timers_advertise :501-521', async () => {
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

  it('mac_addr_adv_interval cases and invalid refuse pin test_set_mac_addr_adv_interval :528-548', async () => {
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

  it('preempt: false composes through mode:"no" and STILL answers the upstream text (port test_set_preempt :554-574)', async () => {
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

  it('the three delay timers pin :580-658 (preempt_delay_min :580-596, preempt_delay_reload :609-625, delay_reload :638-653)', async () => {
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

  it('bfd_ip pins test_set_bfd_ip :737-756 — the era-neutral stem and the quad grammar', async () => {
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

  it("set_enable pins :331-346's two texts and its strict boolean rule", async () => {
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

describe('VrrpResource diffing verbs — setSecondaryIps (:444-496) and setTracks (:660-730)', () => {
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
      // the third address of this case deliberately REUSES curr4 — the keep-side upstream pins at :465:
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

  it('a non-address inside the list refuses per element (upstream invalid list :486-495)', async () => {
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

  // The six current tracks (fixture, Vlan50 vrid 10) and six new ones, exactly as upstream :663-678.
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

  it('the three track-diff cases compose the same texts upstream sorts against (:683-708)', async () => {
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

  it('every malformed track dict refuses — the five upstream ValueErrors (:718-729) each pinned separately', async () => {
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

describe('vrconfFormat — port of test_vrconf_format (:758-808), the PLAN §4 named helper', () => {
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
    // Upstream `fixed = dict(vrconfig)` (`:1433`) copies first — the caller's lists never sort in
    // place; the same non-mutation rule row 71 holds for the bag itself:
    expect(vrconf.secondaryIp).toEqual(['10.10.4.22', '10.10.4.21'])
    expect(vrconf.track?.[0]?.action).toBe('shutdown')
  })

  it('the formatter is identity on parsed records — the equivalence test_get leans on (:156)', async () => {
    const vrrp = vrrpFor()
    const table = await vrrp.get('Vlan50')
    const formatted = new Map<number, VrrpConf>()
    for (const [vrid, entry] of table as VrrpVridTable) formatted.set(vrid, vrrp.vrconfFormat(entry as VrrpConf))
    expect(formatted).toEqual(table as unknown as Map<number, VrrpConf>)
  })

  it("the preempt-null quirk survives: ('no','default') normalize, null does NOT (vrrp.py:1460)", () => {
    const vrrp = vrrpFor()
    expect(vrrp.vrconfFormat({ preempt: null })).toEqual({ preempt: null })
    expect(vrrp.vrconfFormat({ preempt: 'no' })).toEqual({ preempt: false })
  })
})

/* ------------------------------------------------------------------ *
 * Divergence pins (W3c round 2, 2026-11-07).
 *
 * One focused test per quirk recorded against the pinned clone
 * (`/home/svaj/development/arista/pyeapi` @ 6816d9e). Every upstream line
 * ref below was re-verified this round by grep of the exact construct or by
 * awk over the def lines (the round-1 citation lesson: verify BEFORE citing,
 * never hand-sweep a range). The MIGRATION.md §5 rows for these behaviours
 * are 213-224 and the DECISIONS.md entries DR-116..121, filed by this same
 * round after these tests went green.
 *
 * Modern-family configs are HAND-AUTHORED: each line is spelled straight
 * from an upstream parser/setter arm of the pinned clone — they are not
 * device captures and no EOS acceptance is claimed (M12 #14 owns that).
 * ------------------------------------------------------------------ */

/**
 * Hand-authored provenance above: the modern-era lines come from upstream's
 * `>= '4.21.3'` arms (`_parse_enable` `:255`, `_parse_primary_ip` `:264`, `_parse_priority` `:274`,
 * `_parse_timers_advertise` `:284`, `_parse_secondary_ip` `:300`, `_parse_description` `:310`,
 * `_parse_ip_version` `:347`, `_parse_delay_reload` `:357`, `_parse_track` `:367`), and the
 * era-neutral ones from the ungated readers (`mac-address advertisement-interval` `:319-:324`,
 * `preempt` `:292-:297`, the two `preempt delay` readers `:325-:330`/`:331-:336`,
 * `bfd ip` `:337-:344`). `vrrp 20 tracked-object Ethernet1 decrement 0` deliberately carries the
 * `if amount:` probe (`:383`).
 */
const MODERN_CONFIG = textOf([
  'router community-list EX COMM1',
  '!',
  'interface Vlan60',
  '   vrrp 20 priority-level 120',
  '   vrrp 20 advertisement interval 2',
  '   vrrp 20 timers delay reload 30',
  '   vrrp 20 ipv4 10.10.70.10',
  '   vrrp 20 ipv4 10.10.70.20 secondary',
  '   vrrp 20 session description modern description',
  '   vrrp 20 ipv4 version 2',
  '   vrrp 20 disabled',
  '   vrrp 20 tracked-object Ethernet1 decrement 0',
  '   vrrp 20 tracked-object Ethernet2 shutdown',
  '   vrrp 20 preempt',
  '   vrrp 20 preempt delay minimum 0',
  '   vrrp 20 preempt delay reload 0',
  '   vrrp 20 mac-address advertisement-interval 30',
  '   vrrp 20 bfd ip 10.10.70.33',
  '!',
  'vlan 1000',
  '!',
  'end',
])

/** Modern-wins probe: one block spelling BOTH eras (`vrrp.py:242`'s getall sees it too). */
const MIXED_CONFIG = textOf([
  'interface Loopback21',
  '   vrrp 9 disabled',
  '   vrrp 9 ip 10.10.21.1 secondary',
  'end',
])

/** Era-neutral lines only: speaks NEITHER family, so the floor (modern) answers. */
const NEUTRAL_CONFIG = textOf([
  'interface Vlan90',
  '   vrrp 10 shutdown',
  '   vrrp 10 ip 1.2.3.4',
  'end',
])

/** Census + parser probes: the bare `bfd ip` (null answer), the blind-spot lines, inner spacing. */
const BFD_CENSUS_QUIRK_CONFIG = textOf([
  'interface Vlan95',
  '   vrrp 10 preempt',
  '   vrrp 10 bfd ip',
  '!',
  'interface Vlan96',
  '   vrrp 10 preempt',
  '   no vrrp 10 bfd ip',
  'end',
])
const CENSUS_BLIND_CONFIG = textOf([
  'interface Loopback87',
  '   vrrp 10 preempt',
  '   default vrrp 9 ip 10.10.94.1',
  'vrrp 10 ip 10.10.94.2',
  'end',
])

/** Diffing-verb fixture: one vrid 10 entry with exactly one secondary. */
const SEC_CONFIG = textOf([
  'interface Vlan70',
  '   vrrp 10 ip 10.10.8.10',
  '   vrrp 10 ip 10.10.8.20 secondary',
  'end',
])

const modern = () => nodeFor(MODERN_CONFIG)

describe('divergence pin 1 — the command family comes from the config text (vrrp.ts divergence 1; §5 row 213, DR-116)', () => {
  it('a modern-spelling block reads with the modern arms, per upstream arm-for-arm', async () => {
    const { node, transport } = modern()
    const table = await node.vrrp.get('Vlan60')
    expect(table?.get(20)).toEqual({
      enable: false, // `vrrp 20 disabled` votes through the modern arm (`_parse_enable` `:255`); absent would vote True (`:259-:260`)
      primaryIp: '10.10.70.10', // `ipv4` arm `:264`; the `… secondary` line cannot match the `…$`-anchored primary pattern
      priority: 120, // `priority-level` arm `:274`
      timersAdvertise: 2, // `advertisement interval` arm `:284`
      preempt: true, // era-neutral (`_parse_preempt` `:292-:297` — the family gate is absent there, ported)
      secondaryIp: ['10.10.70.20'], // modern findall `:300`
      description: 'modern description', // `session description` arm `:310`
      macAddrAdvInterval: 30, // era-neutral `:319-:324`
      preemptDelayMin: 0, // era-neutral `:325-:330` — a parsed 0 STAYS 0 (unlike track amounts, `:383`)
      preemptDelayReload: 0, // era-neutral `:331-:336`
      delayReload: 30, // `timers delay reload` arm `:357`
      ipVersion: 2, // `ipv4 version` arm `:347`
      // `_parse_track` modern arm `:367` + the `if amount:` truthiness filter `:383`: the parsed 0
      // rides through WITHOUT the amount key. `sorted(key=(name, action))` `:388`.
      track: [{ name: 'Ethernet1', action: 'decrement' }, { name: 'Ethernet2', action: 'shutdown' }],
      bfdIp: '10.10.70.33', // era-neutral `:337-:344`
    })
    // A mixed section-key space costs nothing: non-interface keys are skipped, and the modern block
    // picks its family with the LEGACY-evidence arm answering false (pickFamily line 353 taken, 354 not).
    expect(transport.callCount()).toBe(1)
  })

  it('the modern family also drives the dry-run WRITE texts — run=False stays a string, both verbs (vrrp.py:495-504 set_enable, :550-560 siblings; §5 row 214)', async () => {
    const { node, transport } = modern()
    expect(await node.vrrp.setEnable('Vlan60', 20, false, { run: false })).toBe('vrrp 20 disabled') // :482
    expect(await node.vrrp.setEnable('Vlan60', 20, true, { run: false })).toBe('no vrrp 20 disabled') // :487
    expect(await node.vrrp.setPrimaryIp('Vlan60', 20, { value: '10.10.70.50', run: false })).toBe('vrrp 20 ipv4 10.10.70.50') // :543
    expect(await node.vrrp.setPriority('Vlan60', 20, { value: 150, run: false })).toBe('vrrp 20 priority-level 150') // :588
    expect(await node.vrrp.setDescription('Vlan60', 20, { value: 'hello world', run: false })).toBe('vrrp 20 session description hello world') // :629
    expect(await node.vrrp.setIpVersion('Vlan60', 20, { value: 3, run: false })).toBe('vrrp 20 ipv4 version 3') // :674
    expect(await node.vrrp.setTimersAdvertise('Vlan60', 20, { value: 4, run: false })).toBe('vrrp 20 advertisement interval 4') // :796
    expect(await node.vrrp.setDelayReload('Vlan60', 20, { value: 45, run: false })).toBe('vrrp 20 timers delay reload 45') // :1015
    // Era-neutral stems speak neither family, so their text must NOT drift with the family (upstream
    // composes them ungated — mac `:847`, preempt `:890`, the delay pair `:931`/`:973`, bfd ip `:1217`):
    expect(await node.vrrp.setMacAddrAdvInterval('Vlan60', 20, { value: 2, run: false })).toBe('vrrp 20 mac-address advertisement-interval 2')
    expect(await node.vrrp.setPreempt('Vlan60', 20, { value: false, run: false })).toBe('no vrrp 20 preempt')
    expect(await node.vrrp.setPreemptDelayMin('Vlan60', 20, { value: 5, run: false })).toBe('vrrp 20 preempt delay minimum 5')
    expect(await node.vrrp.setBfdIp('Vlan60', 20, { value: '10.10.70.60', run: false })).toBe('vrrp 20 bfd ip 10.10.70.60')
    // Every one of those composed WITHOUT touching the wire beyond reads (the first read primes the
    // whole-config scan; the latch means none of the others re-read).
    expect(onlyReads(transport)).toBe(true)
    expect(transport.callCount()).toBe(1)
  })

  it('modern WINS a block that spells both eras, and the modern reader answers [] for a legacy secondary line', async () => {
    const { node } = nodeFor(MIXED_CONFIG)
    const table = await node.vrrp.get('Loopback21')
    // read evidence (line 353): modern true even though `vrrp 9 ip … secondary` is legacy evidence too.
    expect(table?.get(9)).toMatchObject({ enable: false }) // the `disabled` line votes modern
    // Upstream would run the modern findall (`:300`) over a config spelling the LEGACY line (`:303`)
    // and answer nothing — the same one-dialect-per-verb posture this port takes:
    expect(table?.get(9)?.secondaryIp).toEqual([])
  })

  it('era-neutral lines vote NO family on EITHER side, so the repo floor (modern) answers — silently and loudly — and the latch skips re-reads', async () => {
    const { node, transport } = nodeFor(NEUTRAL_CONFIG)
    const table = await node.vrrp.get('Vlan90')
    // The block carries only era-neutral spells (`shutdown`, legacy `ip`), which match NEITHER of
    // this client's evidence lists, so the READ floors modern — and that is exactly what upstream
    // answers on a >= '4.21.3' device over the same lines: `_parse_enable`'s `disabled` arm (:255)
    // cannot see the legacy `shutdown` POSITIVE line either, so enable keeps its True default
    // (`:259-:260`), and the `ipv4` arm (`:264`) reads nothing from `ip 1.2.3.4`… except this client
    // answers primaryIp '1.2.3.4' because that line IS legacy evidence — the family pick scans
    // EVERY vrrp line, and `vrrp 10 ip(?![-\w])` proves the legacy arm for the whole block.
    // Pinned as the block votes:
    expect(table?.get(10)).toMatchObject({
      enable: false, // the POSITIVE legacy `shutdown` line votes through the legacy arm — legacy won the block
      primaryIp: '1.2.3.4', // legacy arm (`:267`) — the same config text that made the choice is the text it reads
      preempt: false,
      description: '',
      secondaryIp: [],
      bfdIp: '',
    })
    // THE era-neutral floor, pinned where it can only show: a whole config whose vrrp lines speak
    // NEITHER family (preempt + bare bfd ip) — BFD_CENSUS_QUIRK_CONFIG in pin 6 drives the write arm
    // there. What this test adds is the LATCH: three dry-run verbs on the legacy-voted block,
    // ONE whole-config scan (the DR-099 precedent; `.some()` short-circuits at the legacy `ip`
    // pattern, and every later call rides both the config memo and the latched family).
    expect(await node.vrrp.setEnable('Vlan90', 10, false, { run: false })).toBe('vrrp 10 shutdown') // legacy arm `:484`
    expect(await node.vrrp.setPrimaryIp('Vlan90', 10, { value: '10.10.90.11', run: false })).toBe('vrrp 10 ip 10.10.90.11') // `:545`
    const callsAfterWrites = transport.callCount()
    expect(await node.vrrp.setDelayReload('Vlan90', 10, { value: 20, run: false })).toBe('vrrp 10 delay reload 20') // `:1019`
    expect(transport.callCount(), 'the family latch must not re-read per verb').toBe(callsAfterWrites)
    expect(onlyReads(transport)).toBe(true)
  })
})

describe('divergence pin 2 — getAll shape guards: skip, phantom header, near-miss (upstream getall :231-:252; §5 row 220)', () => {
  it('non-interface section keys are skipped before any header parse', async () => {
    const { node } = modern()
    const all = await node.vrrp.getAll()
    expect([...all.keys()]).toEqual(['Vlan60'])
    expect(all.get('Vlan60')?.size).toBe(1)
  })

  it('a header whose remainder is not one token is a ConfigParseError naming the section, not a phantom name', async () => {
    // Upstream's `re.findall(r'^interface\\s(\\S+)', self.config, re.M)` (vrrp.py:242) keys
    // `interface Ethernet 1` as the phantom `Ethernet`; probe of its own get_block
    // ('^%s$' anchoring, abstract.py:98) then finds no such section and get() answers None — the
    // phantom never even reaches the readers. This client reports instead.
    const { node, transport } = nodeFor(textOf(['interface Ethernet 1', 'end']))
    const thrown = await outcome(() => node.vrrp.getAll())
    expect(thrown).toBeInstanceOf(ConfigParseError)
    expect((thrown as Error).message).toMatch(/cannot read the interface name in 'interface Ethernet 1'/)
    expect(onlyReads(transport)).toBe(true)
  })

  it('a dotted remainder is ONE token to (\\S+), so a subinterface-style header is a candidate, not a report', async () => {
    // `interface Ethernet1.100` names the interface in EOS prose (DECISIONS open item 7) — pyeapi's
    // getall regex (\S+) at :242 keys it whole and its get_block reads its vrrps, and upstream's own
    // readers parse them. Here it is a chunk key candidate, and the empty census excludes it exactly
    // as upstream's falsy-`get` filter (:245-:248) would. The framework's name guard still refuses it
    // for the PAIR verbs (the get-side refusal is pinned in the get tests above via the same
    // assertInterfaceName grammar).
    const { node } = nodeFor(textOf(['interface Ethernet1.100', '   vrrp 10 shutdown', 'end']))
    const all = await node.vrrp.getAll()
    expect(all.has('Ethernet1.100')).toBe(true) // the vrrp 10 line votes the census, so the section IS a table
    // (a vrrp-less dotted section would drop out — the empty-census rule above pins that side)
  })
})

describe('divergence pin 3 — refusal surface: the pair guards and the two omitted-value arms (§5 rows 216, 217)', () => {
  it('the VRID guard refuses each non-%d formattable id, verb by verb — upstream crashes mid-verb instead', async () => {
    // Upstream interpolates the vrid with "%d"/"%s" and validates NOTHING ("no vrrp %d" at :436, the
    // enable stems :482-:489); a float reaches "%d" and raises TypeError mid-call in Python. Each bad
    // form is pinned individually (union loops drop cases silently).
    const { node, transport } = nodeFor(VRRP_CONFIG)
    await expectError(() => node.vrrp.setTracks('Vlan50', '10' as unknown as number, []), /vrrp id/)
    await expectError(() => node.vrrp.setTracks('Vlan50', 10.5, []), /vrrp id/)
    await expectError(() => node.vrrp.setTracks('Vlan50', -1, []), /vrrp id/)
    await expectError(() => node.vrrp.setTracks('Vlan50', Infinity, []), /vrrp id/)
    await expectError(() => node.vrrp.setTracks('Vlan50', null as never, []), /vrrp id/)
    await expectError(() => node.vrrp.create('Vlan50', '10' as unknown as number, {}), /vrrp id/)
    await expectError(() => node.vrrp.delete('Vlan50', 10.5), /vrrp id/)
    await expectError(() => node.vrrp.setDefault('Ethernet1', -1), /vrrp id/)
    expect(onlyReads(transport)).toBe(true)
    // vrid 0 is NOT bounded away — upstream has no bound and the image's limit is a device answer (DR-032):
    const { node: zeroNode } = nodeFor(textOf(['interface Loopback77', '   vrrp 0 preempt', 'end']))
    expect([...(await zeroNode.vrrp.get('Loopback77') as VrrpVridTable).keys()]).toEqual([0])
  })

  it('a create/default/delete with a bad NAME stays a client-side interface refusal', async () => {
    const { node, transport } = nodeFor(VRRP_CONFIG)
    await expectError(() => node.vrrp.create('', 10, {}), /invalid interface/)
    await expectError(() => node.vrrp.delete('not-an-interface', 10), /invalid interface/)
    await expectError(() => node.vrrp.setDefault('Vlan 50', 10), /invalid interface/)
    expect(transport.sent()).toEqual([])
  })

  it("setPrimaryIp's omitted value is refused with THIS module's wording; setDescription's is refused by the shared builder (upstream falls through to 'no %s', abstract.py:158-:161)", async () => {
    const { node, transport } = nodeFor(VRRP_CONFIG)
    await expectError(() => node.vrrp.setDescription('Vlan50', 10, {}), /no value and no mode/)
    await expectError(() => node.vrrp.setDescription('Vlan50', '10' as unknown as number, { value: 'x' }), /vrrp id/)
    expect(onlyReads(transport)).toBe(true)
  })

  it("setDescription's explicit '' is refused HERE; upstream composes the literal negation text through command_builder's falsy fall-through", async () => {
    // Upstream has NO guard of its own (`:629`/`:633` feed `command_builder`), and `elif value:` at
    // abstract.py:158-:161 sends the deprecated `'no %s'` for ANY falsy value — so
    // `set_description(value='')` writes the literal `no vrrp 10 description`: an operator asking to
    // blank a description gets a negation (row 73's family, the vrrp site of it).
    const { node, transport } = nodeFor(VRRP_CONFIG)
    await expectError(() => node.vrrp.setDescription('Vlan50', 10, { value: '' }), /empty value would send a trailing space/)
    await expectError(() => node.vrrp.setDescription('Vlan50', 10, { value: '   ' }), /empty value would send a trailing space/)
    expect(onlyReads(transport)).toBe(true)
    // The parser side keeps its own truth table: a POSITIVE session/description line with nothing after
    // it reads `''` either way (`(.*)` + lstrip, `:310-:318`), and inner spacing survives —
    // `vrrp 10 description   three   spaced` answers 'three   spaced', exactly upstream's lstrip answer:
    const spaced = textOf(['interface Loopback55', '   vrrp 10 preempt', '   vrrp 10 description   three   spaced', 'end'])
    expect(await vrrpFor(spaced).get('Loopback55')).toEqual(new Map([[10, {
      enable: true,
      description: 'three   spaced',
      secondaryIp: [],
      preempt: true,
      track: [],
      bfdIp: '',
    }]]))
  })
})

describe('divergence pin 4 — the list verbs (setSecondaryIps :693-:768, set_tracks :1034-:1191; §5 rows 219, 221, 223)', () => {
  it('secondary-IP diffing: duplicates collapse, a no-op composes [] yet still opens the submode, and a missing pair reads current as []', async () => {
    const { node, transport } = nodeFor(SEC_CONFIG)
    // (a) upstream set-diffs through Python sets (`set(curr) - set(inter)` etc., :741-:744), so a
    // duplicated input addresses compose exactly ONE command.
    const dup = await node.vrrp.setSecondaryIps('Vlan70', 10, ['10.10.8.31', '10.10.8.31', '10.10.8.31'], { run: false })
    expect(dup).toEqual(['no vrrp 10 ip 10.10.8.20 secondary', 'vrrp 10 ip 10.10.8.31 secondary']) // sorted (:756): "no " sorts before the positive form
    // (b) an identical list composes NOTHING — and when run, upstream still calls
    // configure_interface with [] (:758-:763), i.e. the submode opener alone reaches the wire.
    const noopScript = ['interface Vlan70']
    scriptWrite(transport, noopScript)
    const noop = await node.vrrp.setSecondaryIps('Vlan70', 10, ['10.10.8.20'])
    expect(noop).toEqual([])
    expect(sentScripts(transport).at(-1)).toEqual(['enable', 'configure terminal', 'interface Vlan70'])
    // (c) a vrid whose entry has no secondary list (the `?? []` twin of upstream's guarded read
    // `if vrrps and vrid in vrrps` :726-:728) and an interface with NO table at all both compose
    // additions only. Port-Channel1 exists in the config but carries no vrrp lines (its table is
    // undefined, exactly upstream's falsy `vrrps`), and Vlan2000 is no section at all (None block).
    const noSecondary = await node.vrrp.setSecondaryIps('Port-Channel1', 10, ['10.10.8.99'], { run: false })
    expect(noSecondary).toEqual(['vrrp 10 ip 10.10.8.99 secondary'])
    const absent = await node.vrrp.setSecondaryIps('Ethernet1', 999, ['10.10.8.99'], { run: false })
    expect(absent).toEqual(['vrrp 999 ip 10.10.8.99 secondary'])
    const none = await node.vrrp.setSecondaryIps('Vlan2000', 10, ['10.10.8.98'], { run: false })
    expect(none).toEqual(['vrrp 10 ip 10.10.8.98 secondary'])
    // (the ONLY configure transaction this node sent is the opener-only no-op above)
    expect(writeScripts(transport)).toEqual([['enable', 'configure terminal', 'interface Vlan70']])
  })

  it('the secondary stems follow the family — modern spelling is ipv4, and an absent pair forces the []-current arm', async () => {
    const { node, transport } = nodeFor(MODERN_CONFIG)
    const cmds = await node.vrrp.setSecondaryIps('Vlan90', 10, ['10.10.90.11'], { run: false })
    // Vlan90 is not even a section here: upstream's guard (`if vrrps and vrid in vrrps`, :726-:728)
    // answers no current list and this port takes the undefined-table arm of its own read.
    expect(cmds).toEqual(['vrrp 10 ipv4 10.10.90.11 secondary']) // :752 arm
    const removed = await node.vrrp.setSecondaryIps('Vlan60', 20, [], { run: false })
    expect(removed).toEqual(['no vrrp 20 ipv4 10.10.70.20 secondary']) // :746 arm
    expect(onlyReads(transport)).toBe(true)
  })

  it('the write side spells name/action/amount VERBATIM while the read side can never see those lines — the config/write asymmetry, reproduced token-for-token', async () => {
    const { node, transport } = nodeFor(VRRP_CONFIG)
    const parsed = await node.vrrp.get('Vlan50')
    // Python probe of upstream's OWN findall (`:365-:370`) on this round-2 branch, run 2026-11-07:
    //   `track Foo with space shutdown`  -> []   (the (\S+) action group never sees 'shutdown')
    //   `track Ethernet1 noaction`       -> []   (the action must be one of the two verbs)
    // The port reproduces the blind spot EXACTLY (answers [] for both), so a spaced name can only
    // reach the wire from the WANTED side — where :1172-:1175 interpolates name/action/amount
    // VERBATIM: the add below. Had a spaced entry ever sat in the CURRENT set, :1148's re-extraction
    // ((\S+)\s+(\S+)\s+(\S+) on the tid triple) would compose the removal as
    // `no vrrp 10 track Foo with space` with action-group = `space` — the tid collapse in its
    // purest form — but the parser cannot produce such a current entry, so that leg is
    // unreachable-by-construction here and documented in vrrp.ts's compose note instead of forced
    // with fabricated state (the discipline of commit 9ca0d9b). Pinned as divergence, never asserted
    // as SANE: this repo adds no name-charset rule upstream lacks — the image's grammar stays
    // authoritative (DR-032), and no EOS acceptance of any of these texts is claimed.
    expect(parsed?.get(10)?.track.some((entry) => entry.name.includes(' '))).toBe(false) // parser: spelled by the write, invisible to the read
    const spaced: VrrpTrack = { name: 'Foo with space', action: 'shutdown' }
    const cmds = await node.vrrp.setTracks('Vlan50', 10, [
      spaced,
      { name: 'Ethernet1', action: 'decrement', amount: 10 },
      { name: 'Ethernet1', action: 'shutdown' },
      { name: 'Ethernet2', action: 'decrement', amount: 50 },
      { name: 'Ethernet2', action: 'shutdown' },
      { name: 'Ethernet11', action: 'decrement', amount: 75 },
      { name: 'Ethernet11', action: 'shutdown' },
    ], { run: false })
    // The six parsed entries all match wanted (no-ops); the spaced entry has no current twin, so it
    // composes as a sole verbatim ADDITION — the only command this call produces.
    expect(cmds).toEqual(['vrrp 10 track Foo with space shutdown'])
    expect(onlyReads(transport)).toBe(true)
  })

  it('track decrement 0 is INVISIBLE to the parser but VISIBLE to the diff — the round-trip asymmetry of `if amount:` (:383) vs the bare-amount arm (:1169/:1177)', async () => {
    const { node, transport } = nodeFor(MODERN_CONFIG)
    const parsed = await node.vrrp.get('Vlan60')
    expect(parsed?.get(20)?.track).toEqual([{ name: 'Ethernet1', action: 'decrement' }, { name: 'Ethernet2', action: 'shutdown' }])
    // Replacing the set with what the operator MEANT (the 0 amount) no longer matches the current
    // parse, so BOTH a removal and an addition compose — and the ADDITION keeps the 0 verbatim
    // (Python probe of the :1115 tid formula on the same round-2 branch: amount 0 present becomes the
    // text '0', not `_none_`, so :1169's `amount == unset` test never fires). The lossy leg is the
    // READ: re-applying what get() ANSWERED composes the bare no-amount text (:1120's `'amount' in
    // track` test lands 'Ethernet1   decrement   _none_'), which the config cannot answer back.
    const cmds = await node.vrrp.setTracks('Vlan60', 20, [
      { name: 'Ethernet1', action: 'decrement', amount: 0 },
      { name: 'Ethernet2', action: 'shutdown' },
    ], { run: false })
    expect(cmds).toEqual([
      'no vrrp 20 tracked-object Ethernet1 decrement', // current side lost the 0 (`if amount:` :383)
      'vrrp 20 tracked-object Ethernet1 decrement 0', // wanted side keeps it (tid text '0', :1115 + :1169)
    ].sort())
    expect(onlyReads(transport)).toBe(true)
    // The lossy leg pinned directly — the re-application of the PARSED entry composes the bare
    // rstripped text (the `:1122`/`:1169`/`:1177` chain), and the explicit no-amount decrement is
    // spelled the same way from the wanted side:
    const explicit = await node.vrrp.setTracks('Vlan60', 20, [
      { name: 'Ethernet1', action: 'decrement' }, // exactly what get() answered for the decrement-0 line
      { name: 'Ethernet2', action: 'shutdown' },
    ], { run: false })
    // The parsed entry and the wanted bare entry share the SAME tid ('_none_'), so the diff is empty —
    // this verb cannot tell `decrement` from `decrement 0`, in either direction.
    expect(explicit).toEqual([])
    const forced = await node.vrrp.setTracks('Vlan60', 20, [
      { name: 'Ethernet2', action: 'shutdown' },
      { name: 'Bar', action: 'decrement' },
    ], { run: false })
    expect(forced).toEqual([
      'no vrrp 20 tracked-object Ethernet1 decrement',
      'vrrp 20 tracked-object Bar decrement', // wanted-side bare amount: rstripped, no trailing space (`:1172` + rstrip)
    ].sort())
  })

  it("with AMOUNT KEY PRESENT pyeapi validates str(None) — 'None'.isdigit() is False, so an amount of None refuses; with it ABSENT the _none_ stand-in passes (:1101/:1122, :1107-:1109)", async () => {
    const { node, transport } = nodeFor(MODERN_CONFIG)
    await expectError(
      () => node.vrrp.setTracks('Vlan60', 20, [{ name: 'Ethernet3', action: 'decrement', amount: null as unknown as number }]),
      /invalid vrrp track entry/,
    )
    const ok = await node.vrrp.setTracks('Vlan60', 20, [{ name: 'Ethernet3', action: 'decrement' }], { run: false })
    expect(ok).toEqual([
      'no vrrp 20 tracked-object Ethernet1 decrement',
      'no vrrp 20 tracked-object Ethernet2 shutdown',
      'vrrp 20 tracked-object Ethernet3 decrement',
    ].sort())
    expect(ok.every((cmd) => !/\s$/u.test(cmd)), 'the rstrips (:1161/:1177) never leave a trailing space').toBe(true)
    expect(onlyReads(transport)).toBe(true)
  })
})

describe('divergence pin 5 — create/`_vrrp_set` (upstream :391-:417, :1231-:1420; §5 rows 215, 223)', () => {
  it('create WITHOUT the enable key composes the injected `vrrp N shutdown` FIRST and never writes through the caller bag', async () => {
    // pyeapi:413-:414 injects `kwargs['enable'] = False` when the key is absent — so even a bare
    // `create('Ethernet1', 10, {})` ships the shutdown line first (:1244-:1245 is the enable leg, and
    // set_enable's default kwarg is `value=False`, :461). The caller dict survives its frame write
    // upstream (kwargs is a copy), so the only divergence here is honest hygiene (row 71).
    const { node, transport } = nodeFor(VRRP_CONFIG)
    const scripts = ['interface Ethernet1', 'vrrp 10 shutdown']
    scriptWrite(transport, scripts)
    const attrs: VrrpAttrs = {}
    await node.vrrp.create('Ethernet1', 10, attrs)
    expect(sentScripts(transport).at(-1)).toEqual(['enable', 'configure terminal', ...scripts])
    expect(attrs, 'the caller bag is never written through').toEqual({})
  })

  it('the full mixed sentinel bag composes _vrrp_set order exactly: null is the exact twin of no, preempt null follows the False arm, and the list legs splice whole', async () => {
    const { node, transport } = nodeFor(VRRP_CONFIG)
    const attrs: VrrpAttrs = {
      enable: true,
      primaryIp: null, // :1248 `in ('no', None)` — same arm as 'no' (create :224-:259 pins that twin)
      priority: 'default', // :1263 arm
      description: null, // :1273 arm
      ipVersion: 3, // positive leg, modern/legacy stem from the config text (legacy here)
      timersAdvertise: null, // :1305 arm
      macAddrAdvInterval: 3, // positive leg
      preempt: null, // :1341 lists ('no', False) — upstream's None lands in the POSITIVE leg and
      // set_preempt's own strict guard (`value is not True and value is not False`, :885-:888) raises
      // ValueError: None is NOT accepted upstream here, and this client routes null to the same
      // negate arm as 'no'/False (vrrpAttrs carries the documented twin) — the deliberate widening,
      // pinned below as text and refusal-free.
      preemptDelayMin: null, // :1353 arm
      preemptDelayReload: null, // :1369 arm
      delayReload: null, // :1385 arm
      bfdIp: null, // :1404 arm
    }
    const scripts = [
      'interface Ethernet1',
      'no vrrp 10 shutdown', // enable: true (the injected default's opposite — row 223)
      'no vrrp 10 ip 10.10.6.10', // the CURRENT address named back, exactly like :535-:540 reading vrrps[vrid]
      'default vrrp 10 priority',
      'no vrrp 10 description',
      'vrrp 10 ip version 3',
      'no vrrp 10 timers advertise',
      'vrrp 10 mac-address advertisement-interval 3',
      'no vrrp 10 preempt', // null here (upstream would raise — the honest divergence, pinned in the row)
      'no vrrp 10 preempt delay minimum',
      'no vrrp 10 preempt delay reload',
      'no vrrp 10 delay reload',
      'no vrrp 10 bfd ip',
    ]
    scriptWrite(transport, scripts)
    await node.vrrp.create('Ethernet1', 10, attrs)
    expect(sentScripts(transport).at(-1)).toEqual(['enable', 'configure terminal', ...scripts])
  })

  it('the same bag on a MODERN-spelling device composes the modern stems leg-for-leg with every arm class', async () => {
    const { node, transport } = modern()
    const attrs: VrrpAttrs = {
      enable: false, // positive leg on the modern text (`:482`)
      primaryIp: 'no', // :1248 no-leg on the modern stem; current address named back (`:538`)
      priority: 'no', // no-leg, :588 stem
      description: 'no', // no-leg, :629 stem
      ipVersion: 'default', // default-leg, :674 stem
      secondaryIp: ['10.10.70.20', '10.10.70.61'], // :1299-:1301 splices the set-diff whole; the KEEP
      // side (10.10.70.20 is already current) composes NOTHING, the add is the :752 ipv4 text
      timersAdvertise: 'no', // no-leg, :796 stem
      preempt: 'no', // no-leg on the era-neutral stem (`:890` — family never touches it)
      preemptDelayMin: 5, // positive leg, era-neutral stem (`:931`)
      preemptDelayReload: null, // :1369 null arm — upstream's (`'no', None`) tuple selects the DISABLE arm (`:973` builder with disable=True composes `no …`, NOT `default`)
      delayReload: 45, // positive leg, modern arm `:1015`
      track: [{ name: 'Ethernet2', action: 'shutdown' }, { name: 'Ethernet9', action: 'decrement', amount: 9 }], // :1398-:1400 splice: Ethernet2 is the keep side; the Ethernet1 remove carries the decrement-0 invisibility (no amount), the add is the :1172 text
      bfdIp: null, // :1404 null arm -> the DISABLE text (`no …`), the same twin 'no' selects
    }
    const scripts = [
      'interface Vlan60',
      'vrrp 20 disabled',
      'no vrrp 20 ipv4 10.10.70.10',
      'no vrrp 20 priority-level',
      'no vrrp 20 session description',
      'default vrrp 20 ipv4 version',
      'vrrp 20 ipv4 10.10.70.61 secondary',
      'no vrrp 20 advertisement interval',
      'no vrrp 20 preempt',
      'vrrp 20 preempt delay minimum 5',
      'no vrrp 20 preempt delay reload',
      'vrrp 20 timers delay reload 45',
      'no vrrp 20 tracked-object Ethernet1 decrement',
      'vrrp 20 tracked-object Ethernet9 decrement 9',
      'no vrrp 20 bfd ip',
    ]
    scriptWrite(transport, scripts)
    await node.vrrp.create('Vlan60', 20, attrs)
    expect(sentScripts(transport).at(-1)).toEqual(['enable', 'configure terminal', ...scripts])
  })
})

describe('divergence pin 6 — the reader truth tables: bfd ip, the census, formatter vs parser (§5 rows 218, 220, 224)', () => {
  it('the BARE positive `vrrp N bfd ip` line answers null; a negated line answers the empty string; the family vote is unaffected', async () => {
    // `_parse_bfd_ip` (:337-:344) matches ` bfd ip(?: (quad)|)$` — the empty alternative matches the
    // bare positive line and group(1) is None, which upstream hands back as bfd_ip=None. No line at all
    // (the `no vrrp N bfd ip` negation never matches the positive pattern) answers ''. Three answers,
    // pinned; the bare line ALSO votes the census (`(?:no |)vrrp` finds the positive form, :200).
    const { node, transport } = nodeFor(BFD_CENSUS_QUIRK_CONFIG)
    expect((await node.vrrp.get('Vlan95'))?.get(10)).toMatchObject({ bfdIp: null })
    expect((await node.vrrp.get('Vlan96'))?.get(10)).toMatchObject({ bfdIp: '' })
    // The family vote is unaffected by the bare line: `bfd ip` is era-neutral upstream (`:337`, and the
    // ungated setter at `:1217`), and here the config carries no family evidence at all, so BOTH the
    // block read and the whole-config write scan floor to modern — the dry-run write below proves the
    // write path never mistakes the bare-era-null answer for legacy evidence.
    expect(await node.vrrp.setPrimaryIp('Vlan95', 10, { value: '10.10.95.11', run: false })).toBe('vrrp 10 ipv4 10.10.95.11')
    expect(onlyReads(transport)).toBe(true)
  })

  it('the census is blind to `default vrrp N` lines, and every reader is blind to zero-indent lines — upstream regexes verbatim', async () => {
    // :200's `^\s+(?:no |)vrrp (\d+)` never matches `default vrrp 9 …` — which is exactly what the
    // `default` verb itself writes (:1415's sibling at :459), so a defaulted v rid cannot seed the
    // vrid set; and `^\s+` on EVERY parser pattern (:253-:391) skips a zero-indent `vrrp` line, which
    // the census also cannot see (its `\s+` is mandatory). Both are upstream's blind spots, pinned.
    const { node } = nodeFor(CENSUS_BLIND_CONFIG)
    const table = await node.vrrp.get('Loopback87')
    expect([...(table as VrrpVridTable).keys()]).toEqual([10])
    expect(table?.get(10)?.primaryIp).toBeUndefined() // the zero-indent ip line is invisible to `^\s+`
  })

  it('upstream answers "" where this client makes fields ABSENT, and the formatter normalizes description to null where the parser answers string — kept verbatim, not reconciled', async () => {
    const { node } = nodeFor(VRRP_CONFIG)
    const entry = (await node.vrrp.get('Ethernet1'))?.get(10)
    // The formatter's own rule for 'no'-shape inputs contradicts the record it is supposed to predict
    // (get answers `description: ''` — `:317` — but `vrconf_format` writes None at `:1443`): upstream's
    // inconsistency, ported deliberately so a round-trip validator built on it behaves like pyeapi's.
    const vrrp = node.vrrp
    expect(vrrp.vrconfFormat({ description: 'no' })).toEqual({ description: null })
    expect(vrrp.vrconfFormat({ description: 'default' })).toEqual({ description: null })
    // false is not in the ('no','default') tuple at :1460 and null never is either (the round-1 pin
    // covers null): a REAL boolean — even false — rides through untouched.
    expect(vrrp.vrconfFormat({ preempt: false })).toEqual({ preempt: false })
    // and upstream indexes EVERY scalar key unguarded (`fixed['primary_ip']` at :1436 — a missing key
    // is a KeyError); here the partial bag passes with untouched absent keys:
    expect(entry?.description).toBe('vrrp 10 on Ethernet1')
    expect(vrrp.vrconfFormat({ priority: 'default' })).toEqual({ priority: 100 })
  })
})
