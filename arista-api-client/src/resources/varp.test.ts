/**
 * `VarpResource` / `VarpInterfacesResource` — W2b (#38), the virtual-ARP surface on the M7 (#9) framework.
 * Driven through `MockTransport` over the real `Node` (`node.varp`, `node.varp.interfaces`), so every read
 * answer is device text and every write answer is an exact command list (docs/TESTING.md §3). Fixture config
 * comes from `test/fixtures/config/varp-virtual-router.conf` (hand-authored per its `manifest.json.provenance`:
 * never captured from the 7050TX-64, and modelled on pyeapi's own `test/fixtures/running_config.varp`) plus
 * inline config for the shapes upstream cannot read.
 *
 * ## Upstream port ledger
 *
 * `pyeapi/test/unit/test_api_varp.py` — **17** test methods (verified by `grep -n 'def test'` on 2026-11-05;
 * spans in `varp.ts`'s header). Ported as behaviour, because upstream's assertions include answers this
 * client refuses:
 *  - `test_instance` (`:51-53`) — the `varp` row of `RESOURCE_FACTORIES` and `Node.varp`, asserted in
 *    `registry.test.ts`; `test_get` (`:55-60`) — the record's two halves, both from one read;
 *    `test_get_interfaces_none` / `_already_defined` (`:62-65`, `:67-70`) — the property-memo identity of
 *    `node.varp.interfaces`, which upstream reaches by calling `EntityCollection.__call__`
 *    (`abstract.py:214-215`) and which DR-004 replaces with `getAll()`.
 *  - `test_set_mac_address_with_value` / `_with_positional_value` (`:72-76`, `:78-82`) — one `setMacAddress`
 *    method, one text (`ip virtual-router mac-address aa:bb:cc:dd:ee:ff`).
 *  - `test_set_mac_address_with_disable` (`:84-87`) / `_with_default` (`:97-100`) — pinned **verbatim with
 *    the current mac appended**: `no ip virtual-router mac-address 00:11:22:33:44:55` /
 *    `default ip virtual-router mac-address 00:11:22:33:44:55`. Our fixture's value stands in for
 *    upstream's, and the "switch has none" second shape (probe: the bare command) is pinned too.
 *  - `test_set_mac_address_with_no_value` (`:89-91`) / `_with_bad_value` (`:93-95`) — assert `ValueError`
 *    for `None` and `'0011.2233.4455'`. Here a `NotSupportedError` per bad value (DR-005/DR-010), and the
 *    guard is end-anchored where upstream's is not: probe — `set_mac_address('aa:bb:cc:dd:ee:ffXX')` is
 *    **accepted** upstream and reaches the wire, `'AA:BB:CC:DD:EE:FF'` raises, and a non-string raises
 *    `TypeError: expected string or bytes-like object`. All pinned below.
 *  - `test_get_with_no_interface` (`:110-114`) — `undefined` (DR-027); `test_add_address_when_interface_does_not_exist`
 *    (`:122-127`) — writing to an interface with no section still creates the addresses, so this is **not** a
 *    `NotFoundError` (upstream reaches it by swallowing `TypeError` in a bare `except Exception`, `:178-181`; probe).
 *  - `test_add_address_with_value` (`:116-120`), `_with_no_value` (`:129-132`), `_with_empty_list`
 *    (`:134-137`), `_with_default` (`:139-142`), `_with_disable` (`:144-147`) — every command list reproduced
 *    verbatim (no trailing `exit`, removals before adds). Upstream's multi-change order is Python set order
 *    (probe: `no 1.1.2.4 / 1.1.2.2 / 1.1.2.5 / 1.1.2.3` then `add 9.9.9.9 / 1.1.2.1`), so only the
 *    single-change cases above are order-pinned upstream; the deterministic order this module documents
 *    (removals in device order, adds in caller order, one transaction) is pinned here, §5 row 166.
 *
 * Probe claims were run on 2026-11-05 against the pinned clone using upstream's own harness
 * (`Node(None)` + `_running_config` + a mocked `node.config`, `test/lib/testlib.py:73-84`). Anything about
 * EOS itself — whether this SKU runs VARP on routed ports, whether `default ip virtual-router address`
 * exists, what a `/len` address form means, and what `no ip virtual-router mac-address` requires — is
 * **not** claimed here: unit tests never reach a device, so those read "unverified on hardware,
 * M12 (#14) to capture".
 *
 * `MockTransport` key strings are whole joined command lists (`testing/mock-transport.ts:83-88`), spelled by
 * the `writeKey()` helper below so a multi-command write names every command it sends.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { Node } from '../command-layer'
import { CommandError, ConfigParseError, EapiErrorCode, NotSupportedError } from '../errors'
import { mockTransport, type MockTransport } from '../testing/mock-transport'
import { VarpInterfacesResource, VarpResource } from './varp'

/** Join lines into config text so a trailing-space line cannot be lost to an editor. */
const textOf = (lines: readonly string[]): string => lines.join('\n')

/** The committed hand-authored fixture: one global mac, three Vlan interfaces, one routed port with VARP. */
const VARP_FIXTURE = readFileSync(
  fileURLToPath(new URL('../../test/fixtures/config/varp-virtual-router.conf', import.meta.url)),
  'utf8',
)

/** Upstream's own fixture shape, transcribed for the tests that need its exact five-address interface. */
const PYEAPI_SHAPE = textOf([
  'ip virtual-router mac-address 00:11:22:33:44:55',
  '!',
  'interface Vlan4001',
  '   ip address 1.1.1.1/24',
  '   ip virtual-router address 1.1.1.2',
  '!',
  'interface Vlan4002',
  '   ip virtual-router address 1.1.2.2',
  '   ip virtual-router address 1.1.2.3',
  '   ip virtual-router address 1.1.2.4',
  '   ip virtual-router address 1.1.2.5',
  '   ip virtual-router address 1.1.2.6',
  '!',
  'interface Vlan4003',
  '   ip address 1.1.3.1/24',
  '!',
  'end',
])

/** Every command list a `Node` write sends, from the opener pyeapi's `enable`/`configure terminal` pair. */
const writeKey = (cmds: readonly string[]): string => ['enable', 'configure terminal', ...cmds].join('\n')

function configTransport(config: string): MockTransport {
  return mockTransport().replies('enable\nshow running-config all', [{}, { output: config }])
}

function nodeFor(config: string): { node: Node; transport: MockTransport } {
  const transport = configTransport(config)
  return { node: new Node(transport), transport }
}

/** The subject the way a caller reaches it: the `Node`'s static accessor (DR-052). */
function varpFor(config: string): VarpResource {
  return nodeFor(config).node.varp
}

/** …and its per-interface half, which is upstream's `interfaces` property (`varp.py:59-63`). */
function varpInterfacesFor(config: string): VarpInterfacesResource {
  return nodeFor(config).node.varp.interfaces
}

function outcome(fn: () => Promise<unknown>): Promise<unknown> {
  return fn().then(() => 'resolved' as const, (thrown: unknown) => thrown)
}

async function expectError(fn: () => Promise<unknown>, message: RegExp): Promise<void> {
  const thrown = await outcome(fn)
  expect(thrown).toBeInstanceOf(Error)
  expect((thrown as Error).message).toMatch(message)
}

describe('VarpResource.get — varp.py:66-93 over the committed fixture', () => {
  it('one read answers the global mac and the whole per-interface table (DR-030 read budget)', async () => {
    const { node, transport } = nodeFor(VARP_FIXTURE)
    const settings = await node.varp.get()
    expect(settings.macAddress).toBe('00:1b:1b:00:00:01')
    expect([...settings.interfaces.keys()]).toEqual(['Vlan10', 'Vlan20', 'Vlan30'])
    expect(settings.interfaces.get('Vlan10')).toEqual({ name: 'Vlan10', addresses: ['10.10.0.254'] })
    expect(settings.interfaces.get('Vlan20')).toEqual({ name: 'Vlan20', addresses: ['10.20.0.254', '10.20.0.253'] })
    // An interface the switch has with NO virtual-router address is still in the table with an empty list
    // (probe: upstream answers {'addresses': []} for Vlan4003), because "none configured" is an answer about
    // a section the device wrote.
    expect(settings.interfaces.get('Vlan30')).toEqual({ name: 'Vlan30', addresses: [] })
    expect(transport.callCount()).toBe(1)
    expect(transport.sent()).toEqual([['enable', 'show running-config all']])
    // Upstream pays more than one wire read: `self.config` re-runs a `show running-config` on each access
    // (`abstract.py:74-76`, row 15) and `_parse_interfaces` (`:102-104`) builds a SECOND `VarpInterfaces`
    // whose `getall` then does one `get_block` per hit (`:159-166` → `:149`).
  })

  it('a switch with no VARP at all answers an empty table and no mac field, not a crash', async () => {
    const settings = await varpFor(textOf(['hostname quiet', '!', 'interface Vlan40', '   ip address 10.40.0.1/24', 'end'])).get()
    expect(settings.macAddress).toBeUndefined()
    // The interface section still belongs to the table, with no addresses — "none configured" is an answer
    // about a section the device wrote (probe: upstream answers {'addresses': []} for Vlan4003).
    expect([...settings.interfaces.keys()]).toEqual(['Vlan40'])
    expect(settings.interfaces.get('Vlan40')).toEqual({ name: 'Vlan40', addresses: [] })
    // Probe: upstream answers mac_address None plus that interfaces dict — DR-027 turns the None into absence.
    expect('macAddress' in settings).toBe(false)
  })

  it('the routed-port VARP address the fixture carries is NOT in the table — pyeapi scans Vlan only (:161)', async () => {
    const settings = await varpFor(VARP_FIXTURE).get()
    expect(settings.interfaces.has('Ethernet1')).toBe(false)
    // `^interface\s(Vlan\d+)$` (`:161`) is the collection rule both upstream and here, so the record is the
    // VLAN table rather than the whole truth about VARP state (divergence 1). The other half —
    // `get('Ethernet1')` DOES see it — is pinned where the per-name reads live below.
    expect([...(await varpFor(VARP_FIXTURE).interfaces.getAll()).keys()]).toEqual(['Vlan10', 'Vlan20', 'Vlan30'])
  })

  it('an unparseable global mac line is a ConfigParseError, never "the switch has none"', async () => {
    // Probe: upstream answers `mac_address: None` for this text (`[a-f0-9]` only, `:96-97`), i.e. it reports
    // an unset value for a switch that has one. Divergences 2/3.
    await expectError(() => varpFor(textOf(['ip virtual-router mac-address AA:BB:CC:DD:EE:FF', 'end'])).get(), /cannot read 'ip virtual-router mac-address AA:BB:CC:DD:EE:FF' in/)
    await expectError(() => varpFor(textOf(['ip virtual-router mac-address 00-1B-1B-00-00-01', 'end'])).get(), /not six lowercase hex octets/)
    await expectError(() => varpFor(textOf(['ip virtual-router mac-address', 'end'])).get(), /carries no mac address/)
  })

  it('a VARP line inside a banner body cannot configure the switch — the section-key read replaces a whole-text scan', async () => {
    // Probe of upstream: `banner login` bodies are written at column 0 (`client.py:747-752`), and
    // `_parse_mac_address` runs `re.M` over the WHOLE config (`:99`), so it answers
    // 11:22:33:44:55:66 as the device's virtual-router MAC. Here the source is the chunked document's keys.
    const bannerConfig = textOf(['hostname b', 'banner login', 'ip virtual-router mac-address 11:22:33:44:55:66', 'EOF', '!', 'end'])
    expect((await varpFor(bannerConfig).get()).macAddress).toBeUndefined()
  })

  it('a negated or sub-interface key is not a global value (parity with the anchored pattern)', async () => {
    // `^ip\svirtual-router\smac-address\s<mac>$` (`:96-97`) will not read a `no …` line either, so `show
    // running-config all`-style negations answer "unset" on both sides.
    const negated = textOf(['no ip virtual-router mac-address 00:1b:1b:00:00:01', 'end'])
    expect((await varpFor(negated).get()).macAddress).toBeUndefined()
    // A sub-interface section is not `Vlan\d+` (`:161`), so it is out of the table on both sides.
    const subif = textOf(['interface Vlan10.100', '   ip virtual-router address 10.10.100.1', 'end'])
    expect((await varpFor(subif).get()).interfaces.size).toBe(0)
  })

  it('several global lines answer the FIRST one, as upstream .search does (:99)', async () => {
    // The chunker keeps keys in document order, so first-in-config wins on both sides. (Two such keys is
    // device text this client has not verified — M12 (#14) — so it is pinned as ordering only, not as legal.)
    const two = textOf(['ip virtual-router mac-address 00:11:22:33:44:55', 'ip virtual-router mac-address 00:ff:ff:ff:ff:ff', 'end'])
    expect((await varpFor(two).get()).macAddress).toBe('00:11:22:33:44:55')
  })

  it('an address line the grammar cannot read is reported instead of vanishing (:197-198)', async () => {
    // Probe: upstream's \S+$ requirement makes `ip virtual-router address 2.2.2.2 junk` match NOTHING, so the
    // line simply disappears from its answer. Divergence 7.
    await expectError(
      () => varpFor(textOf(['interface Vlan7', '   ip virtual-router address 1.1.1.1 junk', 'end'])).interfaces.getAll(),
      /cannot read 'ip virtual-router address 1.1.1.1 junk' in 'interface Vlan7'/,
    )
    // A `/len` token is a single token, so it is reportable as the device wrote it (probe: upstream keeps it too).
    const lenToken = textOf(['interface Vlan7', '   ip virtual-router address 1.1.1.1/24', 'end'])
    expect((await varpFor(lenToken).get()).interfaces.get('Vlan7')?.addresses).toEqual(['1.1.1.1/24'])
    // A bare keyword names no address, so it contributes nothing (parity with `valuesAfterKeyword`, and
    // with the \S+ the upstream pattern needs).
    const bare = textOf(['interface Vlan7', '   ip virtual-router address', 'end'])
    expect((await varpFor(bare).get()).interfaces.get('Vlan7')?.addresses).toEqual([])
  })
})

describe('VarpInterfacesResource reads — varp.py:148-166', () => {
  it('get() answers ANY interface section while getAll() is Vlan-only, exactly as upstream does', async () => {
    // Probe: `get('Ethernet1')` answers the routed-port address because `get_block('interface %s')` takes any
    // name (`:149`), and `getall()` misses it (`:161`). Keeping both halves is what makes the asymmetry an
    // operator-visible fact instead of a silent gap (divergence 1).
    expect((await varpInterfacesFor(VARP_FIXTURE).get('Ethernet1'))?.addresses).toEqual(['10.99.0.2'])
    expect((await varpInterfacesFor(VARP_FIXTURE).getAll()).has('Ethernet1')).toBe(false)
  })

  it('an interface the switch does not have is undefined — test_get_with_no_interface (:110-114)', async () => {
    expect(await varpInterfacesFor(VARP_FIXTURE).get('Vlan1000')).toBeUndefined()
    expect(await varpInterfacesFor('').get('Vlan1000')).toBeUndefined()
    // Upstream answers None the same way (`:150-152`), which its test asserts with assertIsNone.
  })

  it('a name is a name, not a pattern — probe: upstream reads get("Ether.*") as a regex', async () => {
    // `get_block('interface %s')` (`:149` → `abstract.py:98` → `client.py:793-797`) interpolates the caller's
    // string, and probe confirms upstream's get('Ether.*') answers Ethernet1's addresses. Here a name with a
    // metacharacter never reaches the lookup at all: the shared `assertInterfaceName` guard (divergence 6)
    // refuses it, so a typo cannot quietly report some other interface's state.
    const transport = configTransport(VARP_FIXTURE)
    const interfaces = new Node(transport).varp.interfaces
    await expectError(() => interfaces.get('Ether.*'), /invalid interface 'Ether\.\*'/)
    await expectError(() => interfaces.get('Vlan(10|20)'), /invalid interface/)
    // A legal name the switch simply does not have is an ordinary miss, not a guard failure.
    expect(await interfaces.get('Vlan1')).toBeUndefined()
    expect(transport.sent()).toEqual([['enable', 'show running-config all']])
  })

  it('the interfaces object is ONE per Node — the interfaces property memo (:59-63, tests :62-70)', async () => {
    const { node, transport } = nodeFor(VARP_FIXTURE)
    expect(node.varp).toBe(node.varp)
    expect(node.varp.interfaces).toBe(node.varp.interfaces)
    expect(node.varp.interfaces).toBe(node.varp.interfaces)
    await node.varp.get()
    await node.varp.interfaces.getAll()
    await node.varp.interfaces.get('Vlan10')
    // Upstream's `Varp.get` throws away the memo'd property and builds a SECOND VarpInterfaces per call
    // (`:103`); the reads above cost one request because the Node memo is the read budget (DR-026/DR-030).
    expect(transport.callCount()).toBe(1)
  })

  it('keys/has/entries ride the same single read and stay Vlan-only', async () => {
    const { node, transport } = nodeFor(VARP_FIXTURE)
    expect(await node.varp.interfaces.has('Vlan20')).toBe(true)
    expect(await node.varp.interfaces.has('Ethernet1')).toBe(false)
    expect(await node.varp.interfaces.keys()).toEqual(['Vlan10', 'Vlan20', 'Vlan30'])
    expect(transport.callCount()).toBe(1)
  })

  it('an interface name is guarded before any read (DR-053; upstream has no guard at all)', async () => {
    const transport = configTransport(VARP_FIXTURE)
    const interfaces = new Node(transport).varp.interfaces
    for (const bad of ['', '   ', 'Vlan 10', 'Vlan10\x07', 5, undefined]) {
      await expectError(() => interfaces.get(bad as never), /invalid interface /)
    }
    expect(transport.sent()).toEqual([])
  })
})

describe('VarpResource mac-address writes — varp.py:132-141 and the three arms of set_mac_address', () => {
  it('setMacAddress sends the pinned text and reads nothing first', async () => {
    // `test_set_mac_address_with_value` / `_with_positional_value` (:72-82); the two upstream spellings are
    // one method here, because DR-037 removed the positional/keyword split.
    const transport = mockTransport().replies(writeKey(['ip virtual-router mac-address aa:bb:cc:dd:ee:ff']), [{}, {}, {}])
    await new Node(transport).varp.setMacAddress('aa:bb:cc:dd:ee:ff')
    expect(transport.sent()).toEqual([['enable', 'configure terminal', 'ip virtual-router mac-address aa:bb:cc:dd:ee:ff']])
  })

  it('unset/default name the CURRENT value in the command, as upstream reads it in (:132-137)', async () => {
    // `test_set_mac_address_with_disable` (:84-87) and `_with_default` (:97-100) pin:
    //   no ip virtual-router mac-address 00:11:22:33:44:55
    //   default ip virtual-router mac-address 00:11:22:33:44:55
    const transport = mockTransport()
      .replies('enable\nshow running-config all', [{}, { output: PYEAPI_SHAPE }])
      .replies(writeKey(['no ip virtual-router mac-address 00:11:22:33:44:55']), [{}, {}, {}])
      .replies(writeKey(['default ip virtual-router mac-address 00:11:22:33:44:55']), [{}, {}, {}])
    const varp = new Node(transport).varp
    await varp.unsetMacAddress()
    await varp.defaultMacAddress()
    // Each negating arm reads first, and the write in between drops the Node memo (DR-026), so the second arm
    // re-reads rather than reusing a value the switch may have changed. Probe: upstream re-runs
    // `_parse_mac_address()` per call for the same reason (`:133-137`), with `client.py:665-669` invalidating
    // its own cache on every config call.
    expect(transport.sent().map((cmds) => cmds.map(String))).toEqual([
      ['enable', 'show running-config all'],
      ['enable', 'configure terminal', 'no ip virtual-router mac-address 00:11:22:33:44:55'],
      ['enable', 'show running-config all'],
      ['enable', 'configure terminal', 'default ip virtual-router mac-address 00:11:22:33:44:55'],
    ])
  })

  it('with nothing configured, both negating arms send the bare command (probe: upstream does the same)', async () => {
    const transport = mockTransport()
      .replies('enable\nshow running-config all', [{}, { output: textOf(['hostname none', 'end']) }])
      .replies(writeKey(['no ip virtual-router mac-address']), [{}, {}, {}])
      .replies(writeKey(['default ip virtual-router mac-address']), [{}, {}, {}])
    const varp = new Node(transport).varp
    await varp.unsetMacAddress()
    await varp.defaultMacAddress()
    expect(transport.sent().map((cmds) => cmds.map(String))).toEqual([
      ['enable', 'show running-config all'],
      ['enable', 'configure terminal', 'no ip virtual-router mac-address'],
      ['enable', 'show running-config all'],
      ['enable', 'configure terminal', 'default ip virtual-router mac-address'],
    ])
    // Probe: upstream's `if default or disable and not mac_address:` guard parses as
    // `default or (disable and not mac_address)`, so `set_mac_address(disable=True, mac_address='aa:…')`
    // sends the bare `no …` while `disable=True` alone names the current value. The three-method split makes
    // that contradiction unrepresentable (divergence 4, §5 row 165), so only the two honest shapes above exist.
  })

  it('every MAC the read side could not report is refused, and nothing reaches the device', async () => {
    // `test_set_mac_address_with_no_value` (:89-91) and `_with_bad_value` (:93-95) assert ValueError. Here
    // each bad value is pinned on its own, and the set of refusals is wider than upstream's:
    // `'aa:bb:cc:dd:ee:ffXX'` is PROBE-ACCEPTED upstream (re.match is not end-anchored, `:127-128`) and a
    // non-string raises TypeError there.
    const transport = configTransport(VARP_FIXTURE)
    const varp = new Node(transport).varp
    for (const bad of ['', '   ', '0011.2233.4455', 'AA:BB:CC:DD:EE:FF', 'aa:bb:cc:dd:ee:ffXX', 'aa:bb:cc:dd:ee', 'aa:bb:cc:dd:ee:ff:00', 'aa-bb-cc-dd-ee-ff', 5, undefined, null]) {
      await expectError(() => varp.setMacAddress(bad as never), /invalid virtual-router mac address/)
    }
    expect(transport.sent()).toEqual([])
    expect(transport.callCount()).toBe(0)
  })

  it('a device rejection rejects with CommandError and failedCommand (DR-005, not a False + .error)', async () => {
    const transport = mockTransport().rejects('configure terminal', {
      code: EapiErrorCode.COMMAND_INVALID,
      message: "CLI command 3 of 3 'ip virtual-router mac-address aa:bb:cc:dd:ee:ff' failed: invalid mac address",
    })
    const thrown = await outcome(() => new Node(transport).varp.setMacAddress('aa:bb:cc:dd:ee:ff'))
    expect(thrown).toBeInstanceOf(CommandError)
    expect((thrown as CommandError).failedCommand).toBe('ip virtual-router mac-address aa:bb:cc:dd:ee:ff')
    // pyeapi answers False and parks the exception on `connection.error` (`abstract.py:117-127`, DR-005).
  })
})

describe('VarpInterfacesResource address writes — varp.py:168-194', () => {
  it('setAddresses diffs against the device: removal then add, one transaction (test :116-120)', async () => {
    const transport = mockTransport()
      .replies('enable\nshow running-config all', [{}, { output: PYEAPI_SHAPE }])
      .replies(writeKey(['interface Vlan4001', 'no ip virtual-router address 1.1.1.2', 'ip virtual-router address 1.1.1.4']), [{}, {}, {}, {}, {}])
    await new Node(transport).varp.interfaces.setAddresses('Vlan4001', ['1.1.1.4'])
    expect(transport.sent().map((cmds) => cmds.map(String))).toEqual([
      ['enable', 'show running-config all'],
      ['enable', 'configure terminal', 'interface Vlan4001', 'no ip virtual-router address 1.1.1.2', 'ip virtual-router address 1.1.1.4'],
    ])
    // Upstream sends the same two lines but never an `exit` (`:186-189`), which is how `vlans.ts` and
    // `interfaces.ts` close a submode on this client too — so the list stays short on both sides.
  })

  it('an interface with no section still gets its addresses — test :122-127, and NOT a NotFoundError', async () => {
    // Probe: upstream reaches this by swallowing `TypeError: 'NoneType' object is not subscriptable` in the
    // bare `except Exception` at `:178-181`. Here the read is explicit (`?.addresses ?? []`) because absence of
    // a SECTION is not absence of an interface — default-configured interfaces have no section at all.
    const transport = mockTransport()
      .replies('enable\nshow running-config all', [{}, { output: textOf(['hostname x', 'end']) }])
      .replies(writeKey(['interface Vlan10', 'ip virtual-router address 1.1.1.4']), [{}, {}, {}, {}])
    await new Node(transport).varp.interfaces.setAddresses('Vlan10', ['1.1.1.4'])
    expect(transport.sent().map((cmds) => cmds.map(String))).toEqual([
      ['enable', 'show running-config all'],
      ['enable', 'configure terminal', 'interface Vlan10', 'ip virtual-router address 1.1.1.4'],
    ])
  })

  it('unsetAddresses sends the bare negation; an explicit [] negates EACH address the interface has', async () => {
    // `test_add_address_with_no_value` (:129-132) and `_with_empty_list` (:134-137) are two different arms
    // upstream collapses on "no addresses argument"; here they are two verbs, each pinned.
    const transport = mockTransport()
      .replies('enable\nshow running-config all', [{}, { output: PYEAPI_SHAPE }])
      .replies(writeKey(['interface Vlan4002', 'no ip virtual-router address']), [{}, {}, {}, {}])
      .replies(writeKey(['interface Vlan4001', 'no ip virtual-router address 1.1.1.2']), [{}, {}, {}, {}])
    const interfaces = new Node(transport).varp.interfaces
    await interfaces.unsetAddresses('Vlan4002')
    await interfaces.setAddresses('Vlan4001', [])
    expect(transport.sent().map((cmds) => cmds.map(String))).toEqual([
      // `unsetAddresses` needs no read to build its text, so it goes out first; the diff verb then reads once.
      ['enable', 'configure terminal', 'interface Vlan4002', 'no ip virtual-router address'],
      ['enable', 'show running-config all'],
      ['enable', 'configure terminal', 'interface Vlan4001', 'no ip virtual-router address 1.1.1.2'],
    ])
  })

  it('defaultAddresses / setDefault send the default arm — test :139-142 (and delete is the same text as unset)', async () => {
    // DR-095: the base class's presence verbs are mapped onto upstream's flag arms rather than invented, and
    // `delete` is deliberately NOT `no interface …`.
    const transport = mockTransport()
      .replies(writeKey(['interface Vlan4001', 'default ip virtual-router address']), [{}, {}, {}, {}])
      .replies(writeKey(['interface Vlan4001', 'no ip virtual-router address']), [{}, {}, {}, {}])
    const interfaces = new Node(transport).varp.interfaces
    await interfaces.defaultAddresses('Vlan4001')
    await interfaces.setDefault('Vlan4001')
    await interfaces.delete('Vlan4001')
    expect(transport.sent().map((cmds) => cmds.map(String))).toEqual([
      ['enable', 'configure terminal', 'interface Vlan4001', 'default ip virtual-router address'],
      ['enable', 'configure terminal', 'interface Vlan4001', 'default ip virtual-router address'],
      ['enable', 'configure terminal', 'interface Vlan4001', 'no ip virtual-router address'],
    ])
  })

  it('remove one address without touching the others (the common UI edit)', async () => {
    const transport = mockTransport()
      .replies('enable\nshow running-config all', [{}, { output: PYEAPI_SHAPE }])
      .replies(writeKey(['interface Vlan4002', 'no ip virtual-router address 1.1.2.4']), [{}, {}, {}, {}])
    await new Node(transport).varp.interfaces.setAddresses('Vlan4002', ['1.1.2.2', '1.1.2.3', '1.1.2.5', '1.1.2.6'])
    expect(transport.sent()[1]?.map(String)).toEqual(['enable', 'configure terminal', 'interface Vlan4002', 'no ip virtual-router address 1.1.2.4'])
  })

  it('multi-change order is deterministic: removals in device order, adds in caller order (row 166)', async () => {
    // Probe of upstream over this same interface: `no 1.1.2.4 / no 1.1.2.2 / no 1.1.2.5 / no 1.1.2.3` then
    // `ip … 9.9.9.9 / ip … 1.1.2.1` — Python's hash order for both set-difference loops (`:183-189`), so a
    // reviewer cannot predict the script. Here the order below is the order this module documents.
    const transport = mockTransport()
      .replies('enable\nshow running-config all', [{}, { output: PYEAPI_SHAPE }])
      .replies(writeKey([
        'interface Vlan4002',
        'no ip virtual-router address 1.1.2.2',
        'no ip virtual-router address 1.1.2.3',
        'ip virtual-router address 9.9.9.9',
        'ip virtual-router address 1.1.2.1',
      ]), [{}, {}, {}, {}, {}, {}, {}])
    await new Node(transport).varp.interfaces.setAddresses('Vlan4002', ['9.9.9.9', '1.1.2.4', '1.1.2.5', '1.1.2.6', '1.1.2.1'])
    expect(transport.sent()).toHaveLength(2)
  })

  it('a list that already matches the device writes nothing — probe: upstream still sends the submode opener', async () => {
    const transport = mockTransport()
      .replies('enable\nshow running-config all', [{}, { output: PYEAPI_SHAPE }])
    await new Node(transport).varp.interfaces.setAddresses('Vlan4002', ['1.1.2.2', '1.1.2.3', '1.1.2.4', '1.1.2.5', '1.1.2.6'])
    expect(transport.sent().map((cmds) => cmds.map(String))).toEqual([['enable', 'show running-config all']])
    // Probe: upstream sends `['interface Vlan4002']`, i.e. one config transaction that changes nothing
    // (`:194`'s `if commands` only guards the empty LIST, and the opener is always index 0). §5 row 166.
  })

  it('a duplicate in the caller list is written once (upstream dedupes through set() by accident)', async () => {
    const transport = mockTransport()
      .replies('enable\nshow running-config all', [{}, { output: textOf(['interface Vlan7', 'end']) }])
      .replies(writeKey(['interface Vlan7', 'ip virtual-router address 1.1.1.1']), [{}, {}, {}, {}])
    await new Node(transport).varp.interfaces.setAddresses('Vlan7', ['1.1.1.1', '1.1.1.1', '1.1.1.1'])
    expect(transport.sent()[1]?.map(String)).toEqual(['enable', 'configure terminal', 'interface Vlan7', 'ip virtual-router address 1.1.1.1'])
  })

  it('an address the device wrote with a /len is removable but never re-addable (divergence 7)', async () => {
    const withLen = textOf(['interface Vlan7', '   ip virtual-router address 1.1.1.1/24', 'end'])
    const transport = mockTransport()
      .replies('enable\nshow running-config all', [{}, { output: withLen }])
      .replies(writeKey(['interface Vlan7', 'no ip virtual-router address 1.1.1.1/24']), [{}, {}, {}, {}])
    // Removal uses the device's own token, which is the only text that can match what EOS stored.
    await new Node(transport).varp.interfaces.setAddresses('Vlan7', [])
    expect(transport.sent()[1]?.map(String)).toEqual(['enable', 'configure terminal', 'interface Vlan7', 'no ip virtual-router address 1.1.1.1/24'])
    // …and the same token cannot be handed back as a new address.
    await expectError(() => new Node(transport).varp.interfaces.setAddresses('Vlan8', ['1.1.1.1/24']), /invalid virtual-router address/)
  })

  it('addresses are validated before anything is read or written', async () => {
    const transport = configTransport(VARP_FIXTURE)
    const interfaces = new Node(transport).varp.interfaces
    for (const bad of ['', '   ', 'banana', '1.1.1', '1.1.1.256', '1.1.1.1/24', '1.1.1.1 2.2.2.2', 5, undefined, null]) {
      await expectError(() => interfaces.setAddresses('Vlan10', [bad as never]), /invalid virtual-router address/)
      await expectError(() => interfaces.create('Vlan10', { addresses: [bad as never] }), /invalid virtual-router address/)
    }
    expect(transport.sent()).toEqual([])
    expect(transport.callCount()).toBe(0)
  })

  it('create writes the interface opener plus each address, with NO read first (DR-095)', async () => {
    const transport = mockTransport().replies(
      writeKey(['interface Vlan99', 'ip virtual-router address 10.99.0.2', 'ip virtual-router address 10.99.0.3']),
      [{}, {}, {}, {}, {}],
    )
    await new Node(transport).varp.interfaces.create('Vlan99', { addresses: ['10.99.0.2', '10.99.0.3'] })
    expect(transport.sent()).toEqual([
      ['enable', 'configure terminal', 'interface Vlan99', 'ip virtual-router address 10.99.0.2', 'ip virtual-router address 10.99.0.3'],
    ])
    // pyeapi's `create` on this class is inherited `NotImplementedError` (`abstract.py:218-224`), so there is
    // no upstream text to copy: these are the address-arm texts of `set_addresses` (`:188`) without a diff.
  })

  it('create refuses to enter a submode that adds nothing', async () => {
    const transport = configTransport(VARP_FIXTURE)
    const interfaces = new Node(transport).varp.interfaces
    await expectError(() => interfaces.create('Vlan99'), /create needs the addresses/)
    await expectError(() => interfaces.create('Vlan99', { addresses: [] }), /create needs the addresses/)
    expect(transport.sent()).toEqual([])
  })

  it('a device rejection of an address write rejects with CommandError and failedCommand', async () => {
    const transport = mockTransport()
      .replies('enable\nshow running-config all', [{}, { output: VARP_FIXTURE }])
      .rejects('interface Vlan10', {
        code: EapiErrorCode.COMMAND_INVALID,
        message: "CLI command 4 of 4 'ip virtual-router address 10.10.0.9' failed: address already in use",
      })
    const thrown = await outcome(() => new Node(transport).varp.interfaces.setAddresses('Vlan10', ['10.10.0.9']))
    expect(thrown).toBeInstanceOf(CommandError)
    expect((thrown as CommandError).failedCommand).toBe('ip virtual-router address 10.10.0.9')
  })

  it('an unparseable address line blocks the diff read, because the diff needs to trust what it read', async () => {
    const transport = configTransport(textOf(['interface Vlan10', '   ip virtual-router address 1.1.1.1 oops', 'end']))
    const thrown = await outcome(() => new Node(transport).varp.interfaces.setAddresses('Vlan10', ['2.2.2.2']))
    expect(thrown).toBeInstanceOf(ConfigParseError)
    expect(transport.sent()).toEqual([['enable', 'show running-config all']])
  })
})

describe('varp wiring — the registry row, the accessors, and the module surface', () => {
  it('the module is reachable the documented way', async () => {
    const { node } = nodeFor(VARP_FIXTURE)
    expect(node.varp).toBeInstanceOf(VarpResource)
    expect(node.varp.interfaces).toBeInstanceOf(VarpInterfacesResource)
    expect(node.hasResource('varp')).toBe(true)
  })

  it('a guard failure never becomes a device call, so the UI can show a form error (USAGE.md §7)', async () => {
    const transport = configTransport(VARP_FIXTURE)
    const thrown = await outcome(() => new Node(transport).varp.setMacAddress('00-1b-1b-00-00-01'))
    expect(thrown).toBeInstanceOf(NotSupportedError)
    expect(transport.callCount()).toBe(0)
  })
})
