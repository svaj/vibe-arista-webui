/**
 * `IpinterfacesResource` — W2c (#39 #40), the port of `pyeapi/api/ipinterfaces.py`, driven through
 * `MockTransport` over the real `Node` (`node.ipinterfaces`), so every read answer is device text and every
 * write answer is an exact command script (docs/TESTING.md §3). No fixture file is added by this suite: every
 * config below is inline and hand-authored, so `test/fixtures/config/` and its manifest stay untouched.
 *
 * ## Upstream port ledger (verified against the pinned clone on 2026-11-05)
 *
 * Upstream's suite is `pyeapi/test/unit/test_api_ipinterfaces.py` — **11** test methods (counted by AST and
 * re-opened line by line): `test_get` (`:55-63`), `test_getall` (`:65-68`), `test_instance_functions`
 * (`:70-79`), `test_set_address_with_value` (`:81-86`), `test_set_address_with_no_value` (`:88-92`),
 * `test_set_address_with_default` (`:94-98`), `test_set_address_invalid_value_raises_value_error`
 * (`:100-108`, which does **not** raise — its own comment at `:104-105` says "If command_builder fails
 * because value is None, uncomment above lines and remove below lines"), `test_set_mtu_with_values`
 * (`:110-115`), `test_set_mtu_with_no_value` (`:117-121`), `test_set_mtu_default` (`:123-127`),
 * `test_set_mtu_invalid_value_raises_value_error` (`:129-140`, with the same pre-armed comment at `:135-137`).
 *
 * The spans `ipinterfaces.ts` cited for that file were **off by eight** — it cited `test_get` at `:47-55`,
 * `test_instance_functions` at `:62-73` and the two pre-armed comments at `:99-101` / `:133-135`, which are
 * the *class* lines (`INTERFACES` is at `:47-48`) and an eight-line shift on everything after; fixed in this
 * commit. The module refs (`ipinterfaces.py:60-254` — the class body ends at `:254`; `instance` at `:257-268`
 * was cited right) and the framework refs (`abstract.py:82-101`,
 * `:129-164`, `:166-178`, `client.py:747-750`, `:789-798`) all resolve as cited.
 *
 * Two upstream test artifacts are worth naming because they shaped what got pinned:
 *  - `test_set_mtu_default` (`:123-127`), despite its name, only ever asserts `default mtu`: its body
 *    (`:124-126`) is the loop, the one-element `cmds` build and the `default=True` call — no `disable`
 *    value appears anywhere in it — so the `no mtu` arm has exactly one pin (`:117-121`). Both arms are
 *    pinned separately below.
 *  - `test_set_address_invalid_value_raises_value_error` (`:100-108`) and
 *    `test_set_mtu_invalid_value_raises_value_error` (`:129-140`) each pin the *negation* as a **success**,
 *    because upstream's `command_builder` still answers `value=None` with `'no %s'` (`abstract.py:160-161`).
 *    DR-037 turns those two comments-in-waiting into the named verbs {@link unsetAddress} /
 *    {@link unsetMtu}, which is what §5 row 73 counts as twelve such sites across upstream.
 *
 * Upstream drives everything through `EapiConfigUnitTest` (`test/lib/testlib.py:67-124`), whose
 * `MockConnection` answers `{}` to anything it was not told about; here an unscripted request is a hard
 * failure, so every batch below spells every command it sends — `testing/mock-transport.ts:114-121` compares
 * a string matcher against the **whole joined command list**, never a prefix.
 *
 * ## What the "probe" claims rest on
 *
 * Every upstream answer quoted below came from running the pinned classes (`pyeapi.api.ipinterfaces` at
 * `6816d9e`) against `pyeapi.client.Node(None)` with `_running_config` set to the config text named in that
 * test and `node.config` recording the command list — the same harness shape as `testlib.py:74-80`, run
 * 2026-11-05 for this suite. Reproduced by probe: `get('Ethernet99')`/`get('NoSuch9')`/`get('Et1')` raise
 * `TypeError: expected string or bytes-like object, got 'NoneType'`; `getall()` over a config whose
 * `banner login` body contains a column-0 `interface Et7` line raises the same way; `! ip address
 * 9.9.9.9/32` and `no ip address 5.5.5.5/32` both read as an address; `ip mtu 1400` answers `mtu: 1400`;
 * `mtu 1500 extra` answers `1500`; a section whose only address line is `… secondary` answers that token as
 * the **primary** with no `secondary` key; `ip address virtual Port-Channel1 secondary` answers
 * `secondary: ['virtual']`; `create('banana')` sends `['interface banana', 'no switchport']`; `set_address(…, 'x y')`
 * sends `ip address x y`; `set_mtu(…, '1500')` sends `mtu 1500` (the `int()` coercion at `:247`), `1500.5`
 * sends `mtu 1500`, `0`/`67`/`65536`/`'abc'` raise `ValueError`, and `set_mtu(…, None)` sends `no mtu`; the
 * class has no `default` method at all (`hasattr` false). Over the pinned fixture, `getall()` answers
 * exactly `['Loopback0', 'Loopback2', 'Management1', 'Vlan10']` — the four that `test_getall` (`:65-68`)
 * counts — because every `Ethernet…` section there is a switchport, and `create`'s command pair and
 * `delete`'s command triple are byte-identical to what is pinned below.
 *
 * Nothing below claims what the DCS-7050TX-64 or EOS 4.28.13.1M does. Whether a routed port on this unit
 * accepts `65535`, what the real L2 floor is, and whether `default ip address` / `default mtu` are commands
 * EOS answers all read "unverified on hardware, M12 (#14) to capture" (DR-032), and the `68..65535` pair is
 * an IP-MTU reading of RFC 791/8200 that pyeapi itself copied (`:54-55`), not a captured bound (**DR-097**).
 */

import { describe, expect, it } from 'vitest'

import { Node } from '../command-layer'
import { CommandError, ConfigParseError, EapiErrorCode, NotSupportedError } from '../errors'
import { mockTransport, type MockReply, type MockTransport } from '../testing/mock-transport'
import { IpinterfacesResource, IP_MTU_MAX, IP_MTU_MIN } from './ipinterfaces'
import type { IpInterfaceAttrs } from './ipinterfaces'

/** Join lines into config text so a trailing-space line cannot be lost to an editor. */
const textOf = (lines: readonly string[]): string => lines.join('\n')

/**
 * The read surface: one routed port with a primary, a secondary and an `mtu` line; one switchport that must
 * never appear; one L2-capable section with nothing in it; the `Et1` spelling the two-character gate admits
 * upstream; the four non-L2 kinds; and a banner body with a column-0 `interface` line in it.
 */
const IP_CONFIG = textOf([
  'hostname lab-sw1',
  '!',
  'interface Ethernet1',
  '   no switchport',
  '   ip address 10.0.0.1/24',
  '   ip address 10.0.1.1/24 secondary',
  '   mtu 1500',
  '!',
  'interface Ethernet2',
  '   switchport mode trunk',
  '   mtu 9214',
  '!',
  'interface Ethernet3',
  '!',
  'interface Et1',
  '   ip address 10.1.0.1/24',
  '!',
  'interface Loopback0',
  '   ip address 1.1.1.1/32',
  '   mtu 1500',
  '!',
  'interface Loopback2',
  '   ip address 2.2.2.2/32',
  '   ip address 3.255.255.1/24 secondary',
  '   ip address 4.255.255.1/24 secondary',
  '!',
  'interface Management1',
  '   ip address 192.168.1.16/24',
  '   mtu 1500',
  '!',
  'interface Vlan20',
  '   description office vlan',
  '!',
  'banner login EOF',
  'interface Et7',
  '   ip address 7.7.7.7/32',
  'EOF',
  '!',
  'end',
])

/**
 * The four IP-interface shapes of pyeapi's own `test/fixtures/running_config.text`, transcribed from what
 * probe of the pinned classes answers for them (`:47-48`/`:55-63`/`:65-68` of upstream's suite rest on the
 * same file), plus the two switchport sections that make the upstream count exactly four.
 */
const FIXTURE_SHAPED = textOf([
  'interface Ethernet1',
  '   switchport mode trunk',
  '   switchport access vlan 10',
  '!',
  'interface Ethernet2',
  '   switchport access vlan 10',
  '!',
  'interface Loopback0',
  '   ip address 1.1.1.1/32',
  '   mtu 1500',
  '!',
  'interface Loopback2',
  '   ip address 2.2.2.2/32',
  '   ip address 3.255.255.1/24 secondary',
  '   ip address 4.255.255.1/24 secondary',
  '!',
  'interface Management1',
  '   ip address 192.168.1.16/24',
  '   mtu 1500',
  '!',
  'interface Vlan10',
  '   name DATA',
  '   address virtual MAC address',
  '   ip address 6.7.5.6/24',
  '   mtu 1500',
  '!',
  'end',
])

function configTransport(config: string): MockTransport {
  return mockTransport().replies('enable\nshow running-config all', [{}, { output: config }])
}

function nodeFor(config: string): { node: Node; transport: MockTransport } {
  const transport = configTransport(config)
  return { node: new Node(transport), transport }
}

/** The subject the way a caller reaches it: the `Node`'s static accessor (DR-052). */
function ipinterfacesFor(config: string): IpinterfacesResource {
  return nodeFor(config).node.ipinterfaces
}

/** A batch key: `configure()` prepends `enable` + `configure terminal`, and `configureInterface` the parent line. */
const writeKey = (cmds: readonly string[]): string => ['enable', 'configure terminal', ...cmds].join('\n')

/** Empty per-command replies for a successful config transaction. */
const okFor = (cmds: readonly string[]): MockReply => Array.from({ length: cmds.length + 2 }, () => ({}))

function scriptWrite(transport: MockTransport, cmds: readonly string[]): MockTransport {
  return transport.replies(writeKey(cmds), okFor(cmds))
}

function outcome(fn: () => Promise<unknown>): Promise<unknown> {
  return fn().then(() => 'resolved' as const, (thrown: unknown) => thrown)
}

async function expectError(fn: () => Promise<unknown>, message: RegExp): Promise<void> {
  const thrown = await outcome(fn)
  expect(thrown, String(message)).toBeInstanceOf(Error)
  expect((thrown as Error).message).toMatch(message)
}

/**
 * A guard rejection: the class, then the message. The refusal form is `invalid <label> <repr> — <why>`
 * (`refuse` in `ipinterfaces.ts`, the same shape as `validators.ts:226-229`), and an empty argument renders
 * through `pythonRepr` as `None` (DR-010's CPython parity).
 */
async function expectRefusal(fn: () => Promise<unknown>, label: string, why?: RegExp | string): Promise<void> {
  const thrown = await outcome(fn)
  expect(thrown, label).toBeInstanceOf(NotSupportedError)
  expect((thrown as Error).message).toContain(label)
  if (typeof why === 'string') expect((thrown as Error).message).toContain(why)
  else if (why !== undefined) expect((thrown as Error).message).toMatch(why)
}

/** Every command list the transport saw, as strings — the primary parity surface (docs/TESTING.md §3). */
function sentAsText(transport: MockTransport): string[][] {
  return transport.sent().map((cmds) => cmds.map(String))
}

describe('IpinterfacesResource wiring and the DR-030 read budget — ipinterfaces.py:62-92, :129-149', () => {
  it('node.ipinterfaces is the registered resource, memoised per Node (registry row + DR-052)', () => {
    const node = new Node(mockTransport())
    expect(node.hasResource('ipinterfaces')).toBe(true)
    expect(node.ipinterfaces).toBeInstanceOf(IpinterfacesResource)
    expect(node.ipinterfaces).toBe(node.resource('ipinterfaces'))
    expect(node.ipinterfaces).toBe(node.ipinterfaces)
  })

  it('the MTU bounds this client writes are pyeapi\'s constants verbatim (ipinterfaces.py:54-55)', () => {
    expect(IP_MTU_MIN).toBe(68)
    expect(IP_MTU_MAX).toBe(65535)
  })

  it('getAll answers every L3 section in device order, from ONE running-config read (row 173/DR-030)', async () => {
    const { node, transport } = nodeFor(IP_CONFIG)
    const all = await node.ipinterfaces.getAll()
    // `interface Ethernet2` (a switchport) and `interface Ethernet3` (L2-capable, no `no switchport` line)
    // are not IP interfaces; the banner body\'s `interface Et7` is not a section at all.
    expect([...all.keys()]).toEqual(['Ethernet1', 'Et1', 'Loopback0', 'Loopback2', 'Management1', 'Vlan20'])
    expect(transport.callCount()).toBe(1)
    expect(sentAsText(transport)).toEqual([['enable', 'show running-config all']])
  })

  it('getAll over the four IP-interface shapes upstream\'s fixture has answers four entries (:65-68 reproduces)', async () => {
    // Probe of the pinned file: `getall()` keys are exactly `Loopback0`, `Loopback2`, `Management1`,
    // `Vlan10`. `test_getall` (`:65-68`) only ever asserts `len(result) == 4`; the names are the probe\'s,
    // and they hold here for the same shapes because every routed `Ethernet…` section in that file carries
    // a `switchport mode` line and no `no switchport` one.
    const all = await ipinterfacesFor(FIXTURE_SHAPED).getAll()
    expect([...all.keys()]).toEqual(['Loopback0', 'Loopback2', 'Management1', 'Vlan10'])
    expect(all.size).toBe(4)
  })

  it('get() after getAll() costs nothing extra; keys/has/entries ride the same single read (DR-026)', async () => {
    const { node, transport } = nodeFor(IP_CONFIG)
    const ipinterfaces = node.ipinterfaces
    expect((await ipinterfaces.get('Loopback0'))?.address).toBe('1.1.1.1/32')
    expect((await ipinterfaces.getAll()).size).toBe(6)
    expect(await ipinterfaces.has('Ethernet2')).toBe(false)
    expect(await ipinterfaces.has('Vlan20')).toBe(true)
    expect(await ipinterfaces.keys()).toEqual(['Ethernet1', 'Et1', 'Loopback0', 'Loopback2', 'Management1', 'Vlan20'])
    expect((await ipinterfaces.entries()).map(([name]) => name)).toEqual(['Ethernet1', 'Et1', 'Loopback0', 'Loopback2', 'Management1', 'Vlan20'])
    expect(transport.callCount()).toBe(1)
  })

  it('an empty running-config answers an empty table, not an error', async () => {
    const { node, transport } = nodeFor(textOf(['hostname lab', '!', 'end']))
    expect(await node.ipinterfaces.getAll()).toEqual(new Map())
    expect(await node.ipinterfaces.get('Ethernet1')).toBeUndefined()
    expect(transport.callCount()).toBe(1)
  })

  it('a read the device refuses rejects with the device error, never with an empty panel', async () => {
    const transport = mockTransport().rejects('show running-config all', {
      code: EapiErrorCode.COMMAND_INVALID,
      message: "CLI command 2 of 2 'show running-config all' failed: invalid input",
    })
    const thrown = await outcome(() => new Node(transport).ipinterfaces.getAll())
    expect(thrown).toBeInstanceOf(CommandError)
    expect((thrown as CommandError).failedCommand).toBe('show running-config all')
  })
})

describe('IpinterfacesResource.get — the L2 gate of ipinterfaces.py:85-87 and the crash its parsers cause (row 173)', () => {
  it('a routed Ethernet reports its address, its secondary list and its mtu (the shape :66-72 documents)', async () => {
    const entry = await ipinterfacesFor(IP_CONFIG).get('Ethernet1')
    expect(entry).toEqual({
      name: 'Ethernet1',
      address: '10.0.0.1/24',
      secondary: ['10.0.1.1/24'],
      mtu: 1500,
    })
  })

  it('the two records upstream\'s test_get pins come back the same — except for the `mtu: None` key (probe)', async () => {
    // `test_get` (`:55-63`) asserts `dict(name=\'Loopback0\', address=\'1.1.1.1/32\', mtu=1500)` and
    // `dict(name=\'Loopback2\', address=\'2.2.2.2/32\', secondary=[\'3.255.255.1/24\', \'4.255.255.1/24\'],
    // mtu=None)`. The first is reproduced byte-for-byte; the second differs in one field: `_parse_mtu`
    // answers the KEY with the value `None` when the section has no mtu line (`:127`), which DR-027 turns
    // into "no key" here, so the UI cannot render `None` as if it were a number.
    const ipinterfaces = ipinterfacesFor(FIXTURE_SHAPED)
    expect(await ipinterfaces.get('Loopback0')).toEqual({ name: 'Loopback0', address: '1.1.1.1/32', mtu: 1500 })
    expect(await ipinterfaces.get('Loopback2')).toEqual({
      name: 'Loopback2',
      address: '2.2.2.2/32',
      secondary: ['3.255.255.1/24', '4.255.255.1/24'],
    })
    expect('mtu' in (await ipinterfaces.get('Loopback2') ?? {})).toBe(false)
  })

  it('a switchport interface is not an IP interface, in either direction, and never gets fields', async () => {
    const ipinterfaces = ipinterfacesFor(IP_CONFIG)
    // Upstream\'s gate is `name[0:2] in [\'Et\', \'Po\'] and not SWITCHPORT_RE.search(config, re.M)` (`:85-87`),
    // which answers `None` for `interface Ethernet2`/`Ethernet3` because neither writes `no switchport`.
    expect(await ipinterfaces.get('Ethernet2')).toBeUndefined()
    expect(await ipinterfaces.get('Ethernet3')).toBeUndefined()
  })

  it('the gate is an exact `no switchport` command line, not an end-of-line substring (:57, switchports divergence 8)', async () => {
    // `SWITCHPORT_RE = re.compile(r\'no switchport$\', re.M)` (`:57`) is a *text* test, and `search(config,
    // re.M)` even passes `re.M` (value 8) as the pattern object\'s **pos** argument (`:86`) — a quirk the file
    // records rather than "fixes", because every real `interface …` header is longer than 8 bytes. Here the
    // rule is a parsed body line, so neither the terminator nor the section\'s position in the text decides:
    // `no switchport` as the final line of the config gates, and `no switchport mode access` does not.
    const unterminated = await ipinterfacesFor(textOf(['interface Ethernet4', '   no switchport'])).getAll()
    expect([...unterminated.keys()]).toEqual(['Ethernet4'])
    const negated = await ipinterfacesFor(textOf(['interface Ethernet5', '   no switchport mode access', '   switchport access vlan 12', 'end'])).getAll()
    expect([...negated.keys()]).toEqual([])
    // A comment that merely mentions the command does not route the port either.
    const commented = await ipinterfacesFor(textOf(['interface Ethernet6', '   ! no switchport', '   ip address 10.6.0.1/24', 'end'])).getAll()
    expect([...commented.keys()]).toEqual([])
  })

  it('the junk-prefix spellings upstream admits by two characters keep reading, and gain fields upstream denies them (row 173)', async () => {
    // Two-character-gate asymmetry, both halves probed:
    //   `interface Et1` **without** `no switchport`: upstream answers `None` (its prefix test fires and the
    //   block has no `no switchport` line); here `Et1` is not an L2-capable kind token, so the section is
    //   reported with its fields.
    //   `interface Et1` **with** `no switchport`: both report it — probe `get(\'Et1\')` over the fixture-shaped
    //   config answers a full record.
    const without = await ipinterfacesFor(IP_CONFIG).get('Et1')
    expect(without).toEqual({ name: 'Et1', address: '10.1.0.1/24' })
    const withGate = await ipinterfacesFor(textOf(['interface Et1', '   no switchport', '   ip address 10.1.0.1/24', 'end'])).get('Et1')
    expect(withGate).toEqual({ name: 'Et1', address: '10.1.0.1/24' })
    // A real name of a non-L2 kind is always an IP interface, which is what upstream\'s own `test_get`/
    // `test_getall` (`:55-68`) exercise on `Loopback0`, `Loopback2`, `Management1` and `Vlan10`.
    expect((await ipinterfacesFor(IP_CONFIG).get('Vlan20'))?.name).toBe('Vlan20')
  })

  it('an absent section answers undefined three ways over, where upstream raises TypeError (divergence 2, probe)', async () => {
    // Probe over this config: `get(\'Ethernet4\')`, `get(\'Vlan20\')` (absent here), `get(\'NoSuch9\')`,
    // `get(\'Et1\')` and `get(\'Loopback0\')` (absent there) all raise
    // `TypeError: expected string or bytes-like object, got \'NoneType\'` — `get_block` answers `None`
    // (`abstract.py:97-101`) and then `SWITCHPORT_RE.search(None, re.M)` or `re.findall(…, None)` runs on it,
    // despite the docstring\'s promise (`:81-82`) that a missing interface returns `None`. DR-027 plus the
    // chunked document replace every one of those answers, and no name guard runs on the read path.
    const config = textOf(['interface Ethernet1', '   no switchport', '   ip address 10.0.0.1/24', 'end'])
    const ipinterfaces = ipinterfacesFor(config)
    for (const name of ['Ethernet4', 'Vlan20', 'NoSuch9', 'Et1', 'Loopback0', 'Ethernet1/1', '']) {
      expect(await ipinterfaces.get(name), name).toBeUndefined()
    }
  })

  it('an `interface …` line inside a banner body is neither a member nor a fatal error (divergence 2, probe)', async () => {
    // Probe: over a config whose `banner login` body carries a column-0 `interface Et7` line, upstream\'s
    // `getall` (`:142`, `re.M` over the whole text) finds `Et7`, and `get(\'Et7\')` raises
    // `TypeError: expected string or bytes-like object, got \'NoneType\'`. `IP_CONFIG` has exactly that shape;
    // its table has no `Et7` and does not fail.
    const all = await ipinterfacesFor(IP_CONFIG).getAll()
    expect(all.has('Et7')).toBe(false)
    // The same shape upstream\'s own fixture exhibits (`running_config.text`\'s banner body, cited by
    // `vlans.ts` divergence 3) is why this is a real crash path, not a hypothetical one.
    expect([...all.keys()]).not.toContain('Et7')
  })
})

describe('IpinterfacesResource address parsing — ipinterfaces.py:94-111 with the secondary keyword in charge (row 174)', () => {
  it('the `secondary` word, not the line order, decides which address is primary (divergence 3, probes)', async () => {
    // Probe of the three answers `:108-109` produces by index alone:
    //   only `ip address 10.0.0.9/32 secondary`  -> address: \'10.0.0.9/32\', no secondary key
    //   secondary written before the primary     -> the secondary becomes the primary, and the primary a secondary
    // Here a record whose lines are all flagged has **no** `address` field, because that is the statement the
    // config supports; upstream\'s answer there is the lie.
    const secondOnly = await ipinterfacesFor(textOf(['interface Ethernet10', '   no switchport', '   ip address 10.0.0.9/32 secondary', 'end'])).get('Ethernet10')
    expect(secondOnly).toEqual({ name: 'Ethernet10', secondary: ['10.0.0.9/32'] })
    expect('address' in (secondOnly ?? {})).toBe(false)

    const reversedOrder = await ipinterfacesFor(textOf([
      'interface Ethernet11',
      '   no switchport',
      '   ip address 172.16.0.1/24 secondary',
      '   ip address 172.17.0.1/24',
      'end',
    ])).get('Ethernet11')
    expect(reversedOrder).toEqual({ name: 'Ethernet11', address: '172.17.0.1/24', secondary: ['172.16.0.1/24'] })

    const many = await ipinterfacesFor(textOf([
      'interface Ethernet16',
      '   no switchport',
      '   mtu 9214',
      '   ip address 10.16.0.1/24',
      '   ip address 10.16.1.1/24 secondary',
      '   ip address 10.16.2.1/24 secondary',
      'end',
    ])).get('Ethernet16')
    expect(many).toEqual({ name: 'Ethernet16', address: '10.16.0.1/24', secondary: ['10.16.1.1/24', '10.16.2.1/24'], mtu: 9214 })
  })

  it('a negated or commented address line cannot speak for an address (probe: upstream reads both)', async () => {
    // Probe: `! ip address 9.9.9.9/32` answers `address: \'9.9.9.9/32\'` and `no ip address 5.5.5.5/32`
    // answers `\'5.5.5.5/32\'` from the same whole-block `findall` (`:107`), which matches mid-line.
    // `valuesAfterKeyword` anchors on the command text, so neither counts, and a bare `no ip address` was
    // never matchable by upstream\'s pattern either (it needs a non-space after the space).
    for (const line of ['   ! ip address 9.9.9.9/32', '   no ip address 5.5.5.5/32', '   ip address', '   description ip address 8.8.8.8/32']) {
      const entry = await ipinterfacesFor(textOf(['interface Ethernet12', '   no switchport', line, 'end'])).get('Ethernet12')
      expect(entry, line).toEqual({ name: 'Ethernet12' })
      expect('address' in (entry ?? {})).toBe(false)
    }
  })

  it('the address token is kept verbatim, including the forms this client will not write (DR-059\'s read rule, row 174)', async () => {
    // `ip address virtual Port-Channel1 secondary` contributes the word `virtual` as an address upstream
    // reports as a secondary (probe over its fixture\'s `Vlan81`: `secondary: [\'virtual\']`). Reading it back
    // verbatim is deliberate — the write side refuses it (see the {@link setAddress} guards below), so a UI
    // sees what the device has and can refuse to touch it, rather than the client editing the device\'s text.
    const virtual = await ipinterfacesFor(textOf(['interface Vlan81', '   ip address 10.81.0.1/24', '   ip address virtual Port-Channel1 secondary', 'end'])).get('Vlan81')
    expect(virtual).toEqual({ name: 'Vlan81', address: '10.81.0.1/24', secondary: ['virtual'] })
    const dhcp = await ipinterfacesFor(textOf(['interface Ethernet18', '   no switchport', '   ip address dhcp', 'end'])).get('Ethernet18')
    expect(dhcp).toEqual({ name: 'Ethernet18', address: 'dhcp' })
  })

  it('an interface with no address line at all reports no address, with its other fields intact (:94-111 parity minus the lie)', async () => {
    const entry = await ipinterfacesFor(textOf(['interface Ethernet19', '   no switchport', '   mtu 1500', 'end'])).get('Ethernet19')
    expect(entry).toEqual({ name: 'Ethernet19', mtu: 1500 })
    // Upstream answers the `address` KEY with `None` in that case (`:111`, `dict(address=primary)`), which is
    // the second half of the shape its docstring (`:68-69`) describes as "(None if no ip configured)".
    expect('address' in (entry ?? {})).toBe(false)
  })
})

describe('IpinterfacesResource mtu parsing — ipinterfaces.py:113-127 and the overlap with the interfaces resource (row 174, DR-097)', () => {
  it('the interface `mtu` line is a keyword lookup, so `ip mtu` and `ipv6 mtu` cannot answer for it (probe: upstream reads them)', async () => {
    // Probe: a section carrying only `ip mtu 1400` answers `mtu: 1400` upstream, because
    // `re.search(r\'mtu (\\d+)\', config)` (`:126`) is unanchored over the whole block. Here the interface\'s
    // own L3 MTU is the indent-1 `mtu <n>` line, which is the same line the M10a `interfaces` resource reads
    // and writes — that is the overlap DR-097 records, not a second copy of the field.
    for (const line of ['   ip mtu 1400', '   ipv6 mtu 1280', '   description mtu 1500']) {
      const entry = await ipinterfacesFor(textOf(['interface Ethernet14', '   no switchport', line, 'end'])).get('Ethernet14')
      expect(entry, line).toEqual({ name: 'Ethernet14' })
      expect('mtu' in (entry ?? {})).toBe(false)
    }
    const own = await ipinterfacesFor(textOf(['interface Ethernet14', '   no switchport', '   ip mtu 1400', '   mtu 1500', 'end'])).get('Ethernet14')
    expect(own).toEqual({ name: 'Ethernet14', mtu: 1500 })
  })

  it('a non-decimal or oversized mtu is a parse failure naming the section, never a truncated number (probe: :126 truncates)', async () => {
    // Probe: `mtu 1500 extra` answers `1500` upstream — `(\\d+)` matches the prefix and the rest of the line
    // is never looked at (DR-059\'s report-don\'t-truncate rule, rows 43/44).
    const thrown = await outcome(() => ipinterfacesFor(textOf(['interface Ethernet15', '   no switchport', '   mtu 1500 extra', 'end'])).getAll())
    expect(thrown).toBeInstanceOf(ConfigParseError)
    expect((thrown as Error).message).toContain("ipinterfaces: cannot read 'mtu' in 'interface Ethernet15'")
    expect((thrown as Error).message).toContain("'1500 extra' is not a decimal number")

    const notDecimal = await outcome(() => ipinterfacesFor(textOf(['interface Ethernet15', '   no switchport', '   mtu ninety-nine', 'end'])).getAll())
    expect(notDecimal).toBeInstanceOf(ConfigParseError)
    // Reached through `get`, not `getAll`, because a single bad section in the document still fails the
    // whole table read — reporting is per section, and a partial table would be a wrong answer about the device.
    await expectError(
      () => ipinterfacesFor(textOf(['interface Ethernet15', '   no switchport', '   mtu nope', 'end'])).get('Ethernet15'),
      /cannot read 'mtu' in 'interface Ethernet15'/,
    )
    // A decimal number too big for the client to hold exactly is reported, not rounded — DR-059 again.
    const huge = await outcome(() => ipinterfacesFor(textOf(['interface Ethernet15', '   no switchport', '   mtu 99999999999999999999', 'end'])).getAll())
    expect(huge).toBeInstanceOf(ConfigParseError)
    expect((huge as Error).message).toContain('which this client cannot hold as an integer')
  })

  it('an oversized-but-valid range value reads back as written, because reading is not a range check (DR-032)', async () => {
    // `65535` is the top of the write range (`:55`) and a device could hold `2147483647`. The reader reports
    // the line, and only the writer compares to `IP_MTU_MIN..IP_MTU_MAX` — this is the asymmetry that keeps a
    // capture from silently becoming a claim (row 174).
    const entry = await ipinterfacesFor(textOf(['interface Ethernet1', '   no switchport', '   mtu 67', 'end'])).get('Ethernet1')
    expect(entry).toEqual({ name: 'Ethernet1', mtu: 67 })
  })

  it('the same line reads identically through `interfaces` and `ipinterfaces` — two resources, one writer rule (DR-097)', async () => {
    const config = textOf(['interface Ethernet1', '   no switchport', '   ip address 10.0.0.1/24', '   mtu 9214', 'end'])
    const { node } = nodeFor(config)
    const l3 = await node.ipinterfaces.get('Ethernet1')
    // `status: \'skip\'` keeps this a pure config read, which is the half the `mtu` field comes from
    // (`interfaces.ts` divergence 7 admits `ipinterfaces.py` is the closest upstream twin for that line).
    const l2 = (await node.interfaces.getAll({ status: 'skip' })).get('Ethernet1')
    expect(l3?.mtu).toBe(9214)
    expect(l2?.mtu).toBe(9214)
    expect(l3?.mtu).toBe(l2?.mtu)
  })
})

describe('IpinterfacesResource.create / delete — ipinterfaces.py:151-194 and the exact pairs test_api_ipinterfaces.py:70-79 pins', () => {
  it('create sends `interface X` + `no switchport`, in that order, for every name upstream drives its loop with', async () => {
    const transport = configTransport(IP_CONFIG)
    // `INTERFACES = [\'Ethernet1\', \'Ethernet1/1\', \'Vlan1234\', \'Management1\', \'Port-Channel1\']` (`:47-48`).
    // Four of the five are writable here; `Ethernet1/1` is refused by the name grammar (§5 row 173, open
    // item 7), and pinning that refusal is the other half of this ledger.
    for (const intf of ['Ethernet1', 'Vlan1234', 'Management1', 'Port-Channel1']) {
      scriptWrite(transport, [`interface ${intf}`, 'no switchport'])
    }
    const ipinterfaces = new Node(transport).ipinterfaces
    for (const intf of ['Ethernet1', 'Vlan1234', 'Management1', 'Port-Channel1']) await ipinterfaces.create(intf)
    expect(sentAsText(transport)).toEqual(
      ['Ethernet1', 'Vlan1234', 'Management1', 'Port-Channel1'].map((intf) => ['enable', 'configure terminal', `interface ${intf}`, 'no switchport']),
    )
  })

  it('delete sends the three-command triple upstream\'s order requires: clear the address, then go back to L2 (:70-79)', async () => {
    const transport = configTransport(IP_CONFIG)
    const batches: string[][] = [
      ['interface Ethernet1', 'no ip address', 'switchport'],
      ['interface Port-Channel1', 'no ip address', 'switchport'],
      ['interface Vlan1234', 'no ip address', 'switchport'],
    ]
    for (const batch of batches) scriptWrite(transport, batch)
    const ipinterfaces = new Node(transport).ipinterfaces
    await ipinterfaces.delete('Ethernet1')
    await ipinterfaces.delete('Port-Channel1')
    await ipinterfaces.delete('Vlan1234')
    // `no ip address` then `switchport` is upstream\'s list byte-for-byte (`:193`), and there is no
    // `no interface …` anywhere: this deletes the L3 logical interface, not the section (row 173).
    expect(sentAsText(transport)).toEqual(batches.map((batch) => ['enable', 'configure terminal', ...batch]))
  })

  it('create carries the optional address and mtu lines in the SAME transaction (no upstream twin: :173 sends two commands only)', async () => {
    const transport = configTransport(IP_CONFIG)
    const ipinterfaces = new Node(transport).ipinterfaces
    const cases: readonly [string, IpInterfaceAttrs | undefined, string[]][] = [
      ['Ethernet1', { address: '10.0.0.1/24', mtu: 1500 }, ['interface Ethernet1', 'no switchport', 'ip address 10.0.0.1/24', 'mtu 1500']],
      ['Ethernet2', { address: '10.0.2.1/24' }, ['interface Ethernet2', 'no switchport', 'ip address 10.0.2.1/24']],
      ['Ethernet3', { mtu: 9214 }, ['interface Ethernet3', 'no switchport', 'mtu 9214']],
      ['Ethernet4', undefined, ['interface Ethernet4', 'no switchport']],
    ]
    for (const [, , batch] of cases) scriptWrite(transport, batch)
    for (const [intf, attrs] of cases) await ipinterfaces.create(intf, attrs)
    expect(sentAsText(transport)).toEqual(cases.map(([, , batch]) => ['enable', 'configure terminal', ...batch]))
    expect(transport.callCount()).toBe(cases.length)
    // Upstream needs three calls to reach that first shape: `create` (`:174`), `set_address` (`:219`) and
    // `set_mtu` (`:254`) are three separate transactions.
  })

  it('create/delete refuse a name the grammar does not know, at zero round trips — upstream sends `interface banana` (probe, divergence 7)', async () => {
    // Probe: `create(\'Nope1\')` and `create(\'banana\')` send
    // `['interface Nope1', 'no switchport']` / `['interface banana', 'no switchport']` —
    // `ipinterfaces.py` has no name check anywhere (`:173`, `:194`, `:218`, `:251` interpolate).
    const transport = configTransport(IP_CONFIG)
    const ipinterfaces = new Node(transport).ipinterfaces
    for (const name of ['Nope1', 'banana', 'Et1', 'Po1', 'Poke1', 'Vlan', 'Ethernet', '', 'Ethernet1.100', 'Ethernet1/1']) {
      await expectRefusal(() => ipinterfaces.create(name), `invalid create interface '${name}'`, /six kinds validators\.ts:65-73 knows/)
      await expectRefusal(() => ipinterfaces.delete(name), `invalid delete interface '${name}'`)
    }
    expect(transport.sent()).toEqual([])
  })

  it('setDefault refuses: there is no default verb upstream to port (divergence 8, probe: `hasattr(default)` is False)', async () => {
    const transport = configTransport(IP_CONFIG)
    const ipinterfaces = new Node(transport).ipinterfaces
    const thrown = await outcome(() => ipinterfaces.setDefault('Ethernet1'))
    expect(thrown).toBeInstanceOf(NotSupportedError)
    expect((thrown as Error).message).toContain("ipinterfaces setDefault('Ethernet1') does not exist upstream")
    expect((thrown as Error).message).toContain('node.interfaces.setDefault')
    expect(transport.sent()).toEqual([])
  })

  it('a create the device refuses comes back as CommandError naming the failed line (DR-005, never upstream\'s False)', async () => {
    // attrs ride in the SAME batch, so the failure script has to name all four commands (row 173).
    const batch = ['interface Ethernet1', 'no switchport', 'ip address 10.0.0.1/24']
    const transport = mockTransport().rejects(writeKey(batch), {
      code: EapiErrorCode.COMMAND_INVALID,
      message: "CLI command 4 of 5 'no switchport' failed: command is not valid in this mode",
    })
    const thrown = await outcome(() => new Node(transport).ipinterfaces.create('Ethernet1', { address: '10.0.0.1/24' }))
    expect(thrown).toBeInstanceOf(CommandError)
    expect((thrown as CommandError).failedCommand).toBe('no switchport')
  })
})

describe('IpinterfacesResource.setAddress — ipinterfaces.py:196-219 and the three arms its tests split (:81-108)', () => {
  it('setAddress sends `ip address <A.B.C.D/E>`, the text test_set_address_with_value pins (:81-86)', async () => {
    const transport = configTransport(IP_CONFIG)
    for (const intf of ['Ethernet1', 'Vlan1234', 'Management1', 'Port-Channel1']) {
      scriptWrite(transport, [`interface ${intf}`, 'ip address 1.2.3.4/5'])
    }
    const ipinterfaces = new Node(transport).ipinterfaces
    // `test_set_address_with_value` (`:81-86`) drives all five of its names with the literal `1.2.3.4/5`
    // (`:83`) — a /5, which the grammar accepts because the prefix bound is the IPv4 fact, not a form check.
    for (const intf of ['Ethernet1', 'Vlan1234', 'Management1', 'Port-Channel1']) await ipinterfaces.setAddress(intf, '1.2.3.4/5')
    expect(sentAsText(transport)).toEqual(
      ['Ethernet1', 'Vlan1234', 'Management1', 'Port-Channel1'].map((intf) => ['enable', 'configure terminal', `interface ${intf}`, 'ip address 1.2.3.4/5']),
    )
    expect(transport.callCount()).toBe(4)
  })

  it('the optional `secondary` word goes out as the CLI spells it, and reads back through the same record (row 174)', async () => {
    const transport = configTransport(IP_CONFIG)
    scriptWrite(transport, ['interface Ethernet1', 'ip address 10.0.9.1/24 secondary'])
    await new Node(transport).ipinterfaces.setAddress('Ethernet1', '10.0.9.1/24 secondary')
    // Probe: upstream sends the same text, unchecked (`set_address(\'Vlan77\', \'10.0.0.1/24 secondary\')`).
    expect(sentAsText(transport)).toEqual([['enable', 'configure terminal', 'interface Ethernet1', 'ip address 10.0.9.1/24 secondary']])
    const readBack = await ipinterfacesFor(textOf(['interface Ethernet1', '   no switchport', '   ip address 10.0.9.1/24 secondary', 'end'])).get('Ethernet1')
    expect(readBack).toEqual({ name: 'Ethernet1', secondary: ['10.0.9.1/24'] })
  })

  it('unsetAddress and defaultAddress are the two kwarg arms, each pinned once (:88-98) — including the arm its own test commented out (:100-108)', async () => {
    const transport = configTransport(IP_CONFIG)
    const batches: string[][] = [
      ['interface Ethernet1', 'no ip address'],
      ['interface Ethernet1', 'default ip address'],
    ]
    for (const batch of batches) scriptWrite(transport, batch)
    const ipinterfaces = new Node(transport).ipinterfaces
    await ipinterfaces.unsetAddress('Ethernet1')
    await ipinterfaces.defaultAddress('Ethernet1')
    // Probe: `set_address(name, disable=True)` and `set_address(name, value=None)` answer the **same**
    // command text (`:217-218` → `abstract.py:154-155` vs `:160-161`), which is why `:100-108` cannot assert
    // a raise and its comment says so. With DR-037 the negation has one name, so the ambiguity is gone.
    expect(sentAsText(transport)).toEqual(batches.map((batch) => ['enable', 'configure terminal', ...batch]))
  })

  it('an address outside the A.B.C.D/E shape is refused by name, before anything is sent (divergence 7)', async () => {
    // Upstream checks nothing — probe: `set_address(\'Vlan77\', \'x y\')` sends
    // `interface Vlan77` + `ip address x y`. Here each bad shape is a separate pin, because the message is
    // how a UI finds out which half of the grammar it broke.
    const transport = configTransport(IP_CONFIG)
    const ipinterfaces = new Node(transport).ipinterfaces
    await expectRefusal(() => ipinterfaces.setAddress('Ethernet1', '10.0.0.1'), 'invalid ip address \'10.0.0.1\'', /four decimal octets, a slash, a prefix length/)
    await expectRefusal(() => ipinterfaces.setAddress('Ethernet1', '10.0.0.1/33'), 'invalid ip address \'10.0.0.1/33\'', 'the prefix length 33 is outside 0..32')
    await expectRefusal(() => ipinterfaces.setAddress('Ethernet1', '256.1.1.1/24'), 'invalid ip address \'256.1.1.1/24\'', 'the octet 256 is outside 0..255')
    await expectRefusal(() => ipinterfaces.setAddress('Ethernet1', 'virtual'), 'invalid ip address \'virtual\'', /the word virtual are shapes this client reads back verbatim but will not write/)
    await expectRefusal(() => ipinterfaces.setAddress('Ethernet1', 'dhcp'), 'invalid ip address \'dhcp\'')
    await expectRefusal(() => ipinterfaces.setAddress('Ethernet1', '10.0.0.1/24 tertiary'), 'invalid ip address \'10.0.0.1/24 tertiary\'', /optionally followed by the single word secondary/)
    await expectRefusal(() => ipinterfaces.setAddress('Ethernet1', 'x y'), 'invalid ip address \'x y\'', /optionally followed by the single word secondary/)
    await expectRefusal(() => ipinterfaces.setAddress('Ethernet1', ''), 'invalid ip address \'\'')
    // A control character would break the single-line command this client reads back (the `row 74` rule).
    await expectRefusal(() => ipinterfaces.setAddress('Ethernet1', '10.0.0.1/24\u0007x'), 'invalid ip address', /control character/)
    // Empty arguments render through `pythonRepr` as `None` (DR-010), not the JS word.
    await expectRefusal(() => ipinterfaces.setAddress('Ethernet1', undefined as unknown as string), 'invalid ip address None')
    await expectRefusal(() => ipinterfaces.setAddress('Ethernet1', 10 as unknown as string), 'invalid ip address 10')
    expect(transport.sent()).toEqual([])
  })

  it('a name the grammar refuses is refused with the verb named, at zero round trips (:81-86\'s Ethernet1/1 is not writable here)', async () => {
    const transport = configTransport(IP_CONFIG)
    const ipinterfaces = new Node(transport).ipinterfaces
    // Upstream\'s own loop drives `Ethernet1/1` through every setter (`:47-48`), and probe confirms it sends
    // `interface Ethernet1/1`. This client refuses that spelling until M12 #14 captures the chassis form
    // (DECISIONS open item 7) — the same asymmetry `switchports.test.ts:196-198` pins for its sibling module.
    await expectRefusal(() => ipinterfaces.setAddress('Ethernet1/1', '1.2.3.4/5'), "invalid setAddress interface 'Ethernet1/1'")
    await expectRefusal(() => ipinterfaces.unsetAddress('Ethernet1/1'), "invalid unsetAddress interface 'Ethernet1/1'")
    await expectRefusal(() => ipinterfaces.defaultAddress('Po1'), "invalid defaultAddress interface 'Po1'")
    expect(transport.sent()).toEqual([])
  })

  it('an address write the device answers with an error rejects with CommandError', async () => {
    const batch = ['interface Vlan20', 'ip address 10.0.0.1/24']
    const transport = mockTransport().rejects(writeKey(batch), {
      code: EapiErrorCode.COMMAND_INVALID,
      message: "CLI command 4 of 4 'ip address 10.0.0.1/24' failed: 10.0.0.0/24 overlaps with Vlan10",
    })
    const thrown = await outcome(() => new Node(transport).ipinterfaces.setAddress('Vlan20', '10.0.0.1/24'))
    expect(thrown).toBeInstanceOf(CommandError)
    expect((thrown as CommandError).failedCommand).toBe('ip address 10.0.0.1/24')
  })
})

describe('IpinterfacesResource.setMtu — ipinterfaces.py:222-254, its range check and its three arms (:110-140)', () => {
  it('the two edges upstream pins go out verbatim: `mtu 68` and `mtu 65535` (:110-115)', async () => {
    const transport = configTransport(IP_CONFIG)
    for (const value of [IP_MTU_MIN, IP_MTU_MAX]) scriptWrite(transport, ['interface Ethernet1', `mtu ${String(value)}`])
    const ipinterfaces = new Node(transport).ipinterfaces
    await ipinterfaces.setMtu('Ethernet1', IP_MTU_MIN)
    await ipinterfaces.setMtu('Ethernet1', IP_MTU_MAX)
    // `test_set_mtu_with_values` (`:110-115`) adds a `random_int(68, 65535)`, so the edges are the only
    // deterministic half of that pin — reproduced, with the random middle value left out on purpose.
    expect(sentAsText(transport)).toEqual([
      ['enable', 'configure terminal', 'interface Ethernet1', 'mtu 68'],
      ['enable', 'configure terminal', 'interface Ethernet1', 'mtu 65535'],
    ])
  })

  it('unsetMtu and defaultMtu are the two arms upstream folds into kwargs (:117-127)', async () => {
    const transport = configTransport(IP_CONFIG)
    const batches: string[][] = [
      ['interface Ethernet1', 'no mtu'],
      ['interface Ethernet1', 'default mtu'],
    ]
    for (const batch of batches) scriptWrite(transport, batch)
    const ipinterfaces = new Node(transport).ipinterfaces
    await ipinterfaces.unsetMtu('Ethernet1')
    await ipinterfaces.defaultMtu('Ethernet1')
    // Probe: `set_mtu(name, disable=True)` -> `no mtu`; `set_mtu(name, default=True)` -> `default mtu`;
    // `set_mtu(name)` (no value) -> `no mtu` as well, which `:129-140` pins as a **success** with its
    // `for value in [None]` loop and its own comment about `command_builder`.
    expect(sentAsText(transport)).toEqual(batches.map((batch) => ['enable', 'configure terminal', ...batch]))
  })

  it('a value outside 68..65535 is refused by name where upstream raises ValueError (:129-133)', async () => {
    // Upstream raises `ValueError('invalid mtu value')` from `:248-249`; here the refusal names the range,
    // says the constants are an IP-MTU reading rather than a captured bound, and points at `unsetMtu` for the
    // negation the `0` case used to reach by fall-through (`abstract.py:158-161`).
    const transport = configTransport(IP_CONFIG)
    const ipinterfaces = new Node(transport).ipinterfaces
    const range: RegExp = /expected 68\.\.65535, the range pyeapi checks at api\/ipinterfaces\.py:246-249/
    await expectRefusal(() => ipinterfaces.setMtu('Ethernet1', 67), 'invalid mtu 67', range)
    await expectRefusal(() => ipinterfaces.setMtu('Ethernet1', 65536), 'invalid mtu 65536', range)
    await expectRefusal(() => ipinterfaces.setMtu('Ethernet1', 0), 'invalid mtu 0', range)
    await expectRefusal(() => ipinterfaces.setMtu('Ethernet1', -1), 'invalid mtu -1', range)
    expect(transport.sent()).toEqual([])
  })

  it('a value that is not a number is refused without coercion — upstream\'s `int(value)` accepts a string and truncates a float (probe, divergence 7)', async () => {
    // Probe over `set_mtu(\'Ethernet1\', …)`: `'1500'` sends `mtu 1500` (`int()` at `:247`), `1500.5` sends
    // `mtu 1500` (truncation), `'abc'` raises `ValueError: invalid literal for int() with base 10: 'abc'`.
    // A string reaching this verb means a UI skipped parsing a form field, so the guard refuses it and the
    // refusal says which of the two mistakes it is (the same split `assertVlanId` makes, row 76).
    const transport = configTransport(IP_CONFIG)
    const ipinterfaces = new Node(transport).ipinterfaces
    await expectRefusal(() => ipinterfaces.setMtu('Ethernet1', '1500' as unknown as number), "invalid mtu '1500'", /pyeapi coerces with int\(value\) at api\/ipinterfaces\.py:247/)
    await expectRefusal(() => ipinterfaces.setMtu('Ethernet1', 1500.5), 'invalid mtu 1500.5', /expected an integer MTU/)
    await expectRefusal(() => ipinterfaces.setMtu('Ethernet1', Number.NaN), 'invalid mtu NaN')
    await expectRefusal(() => ipinterfaces.setMtu('Ethernet1', Infinity), 'invalid mtu Infinity')
    await expectRefusal(() => ipinterfaces.setMtu('Ethernet1', undefined as unknown as number), 'invalid mtu None')
    await expectRefusal(() => ipinterfaces.setMtu('Ethernet1', true as unknown as number), 'invalid mtu True')
    expect(transport.sent()).toEqual([])
  })

  it('the guard on this verb is not the guard on `interfaces.setMtu`, and each refusal says which range it checked (DR-097)', async () => {
    // Same config line, two resources, two deliberately different bounds: `ipinterfaces` keeps upstream\'s
    // IP-MTU range (`:54-55`, `:246-249`), `interfaces` refuses only a non-positive/non-integer because it
    // would not encode an IP bound on an L2 field (`interfaces.ts:710-713`). A UI that reads one resource and
    // writes the other has to know which guard it is passing — so both messages name their range.
    const transport = configTransport(IP_CONFIG)
    const node = new Node(transport)
    await expectRefusal(() => node.ipinterfaces.setMtu('Ethernet1', 67), 'invalid mtu 67', /expected 68\.\.65535/)
    await expectRefusal(() => node.interfaces.setMtu('Ethernet1', 0), 'invalid interface mtu 0', /expected a positive integer MTU/)
    scriptWrite(transport, ['interface Ethernet1', 'mtu 67'])
    await node.interfaces.setMtu('Ethernet1', 67)
    expect(sentAsText(transport)).toEqual([['enable', 'configure terminal', 'interface Ethernet1', 'mtu 67']])
  })

  it('a name guard runs before the value guard, in that order, so a bad name is reported even with a bad value', async () => {
    const transport = configTransport(IP_CONFIG)
    const ipinterfaces = new Node(transport).ipinterfaces
    // Order matters for a UI showing one message at a time: the section the operator named is the first
    // thing to reject, and it rejects with the verb label rather than the bare value label.
    await expectRefusal(() => ipinterfaces.setMtu('banana', 7), "invalid setMtu interface 'banana'")
    await expectRefusal(() => ipinterfaces.unsetMtu('Po1'), "invalid unsetMtu interface 'Po1'")
    await expectRefusal(() => ipinterfaces.defaultMtu('Ethernet1/1'), "invalid defaultMtu interface 'Ethernet1/1'")
    expect(transport.sent()).toEqual([])
  })

  it('an mtu write the device refuses rejects with CommandError naming the line', async () => {
    const batch = ['interface Ethernet1', 'mtu 68']
    const transport = mockTransport().rejects(writeKey(batch), {
      code: EapiErrorCode.COMMAND_INVALID,
      message: "CLI command 4 of 4 'mtu 68' failed: requested value below the platform minimum",
    })
    const thrown = await outcome(() => new Node(transport).ipinterfaces.setMtu('Ethernet1', 68))
    expect(thrown).toBeInstanceOf(CommandError)
    expect((thrown as CommandError).failedCommand).toBe('mtu 68')
  })
})

describe('IpinterfacesResource verb discipline — zero reads on the write path, one read per table (DR-030)', () => {
  it('every write verb issues exactly one batch and NEVER a config read', async () => {
    const transport = mockTransport()
    const batches: string[][] = [
      ['interface Ethernet1', 'no switchport'],
      ['interface Ethernet1', 'no ip address', 'switchport'],
      ['interface Ethernet1', 'ip address 10.0.0.1/24'],
      ['interface Ethernet1', 'no ip address'],
      ['interface Ethernet1', 'default ip address'],
      ['interface Ethernet1', 'mtu 1500'],
      ['interface Ethernet1', 'no mtu'],
      ['interface Ethernet1', 'default mtu'],
    ]
    for (const batch of batches) scriptWrite(transport, batch)
    const ipinterfaces = new Node(transport).ipinterfaces
    await ipinterfaces.create('Ethernet1')
    await ipinterfaces.delete('Ethernet1')
    await ipinterfaces.setAddress('Ethernet1', '10.0.0.1/24')
    await ipinterfaces.unsetAddress('Ethernet1')
    await ipinterfaces.defaultAddress('Ethernet1')
    await ipinterfaces.setMtu('Ethernet1', 1500)
    await ipinterfaces.unsetMtu('Ethernet1')
    await ipinterfaces.defaultMtu('Ethernet1')
    expect(sentAsText(transport)).toEqual(batches.map((batch) => ['enable', 'configure terminal', ...batch]))
    expect(transport.sent().some((cmds) => cmds.map(String).includes('show running-config all'))).toBe(false)
  })

  it('create validates its attribute bag before the transaction too, so a bad attrs list sends nothing (:151-174 has no twin for this)', async () => {
    const transport = configTransport(IP_CONFIG)
    const ipinterfaces = new Node(transport).ipinterfaces
    await expectRefusal(() => ipinterfaces.create('Ethernet1', { address: '10.0.0.1' }), "invalid ip address '10.0.0.1'")
    await expectRefusal(() => ipinterfaces.create('Ethernet1', { mtu: 67 }), 'invalid mtu 67')
    expect(transport.sent()).toEqual([])
  })

  it('a Vlan or Loopback section is a legal IP interface to write, and the `no switchport` line it does not need is the device\'s to answer', async () => {
    // Upstream\'s own fixture makes four of the five IP interfaces non-Ethernet kinds (`:55-68`), so refusing
    // them here would contradict the module being ported; whether EOS 4.28.13.1M accepts `no switchport`
    // under `interface Vlan20` is an M12 (#14) capture, and the pinned `CommandError` paths above are how a
    // refusal by the device reaches the caller (DR-005/DR-032).
    const transport = configTransport(IP_CONFIG)
    scriptWrite(transport, ['interface Loopback0', 'no switchport'])
    scriptWrite(transport, ['interface Vlan20', 'ip address 10.20.0.1/24'])
    const ipinterfaces = new Node(transport).ipinterfaces
    await ipinterfaces.create('Loopback0')
    await ipinterfaces.setAddress('Vlan20', '10.20.0.1/24')
    expect(sentAsText(transport)).toEqual([
      ['enable', 'configure terminal', 'interface Loopback0', 'no switchport'],
      ['enable', 'configure terminal', 'interface Vlan20', 'ip address 10.20.0.1/24'],
    ])
  })
})
