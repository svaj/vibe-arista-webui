/**
 * `InterfacesResource` — M10a (#12), the `Interfaces` + `BaseInterface` + per-kind name-parser slice of
 * `pyeapi/api/interfaces.py`, driven through `MockTransport` over the real `Node` (`node.interfaces`),
 * so every read answer is device text and every write answer is an exact `cmds` list (docs/TESTING.md §3).
 *
 * ## Why this fixture work is inline, not a `.conf`
 *
 * M9's two `EntityCollection` specs read a committed `test/fixtures/config/*.conf`; this one does not,
 * because everything this module must pin is either a small shape worth reading at the call site (an
 * interface header, a banner body, a nested sub-mode) or a status reply asserted inline so the column in
 * question sits next to the expectation. Those replies use **captured** spellings and values:
 * `interfaceStatuses` / `linkStatus` come from `test/fixtures/live/ceos-4.28.14M/show-interfaces-status.json`
 * (cEOS-lab 4.28.14M, `hardwareEvidence: "none"` — DR-043) and `interfaces` / `interfaceStatus` / `hardware`
 * / `mtu` from pyeapi's vendor-shipped `test/fixtures/show_interfaces.json` (the **sibling** `show
 * interfaces` command: `interfaceStatus` `:63`, `lineProtocolStatus` `:65`, `mtu` `:66`), so `connected` /
 * `disabled` / `up` are words a real EOS answered rather than vocabulary invented here — and no value set
 * is claimed closed ({@link InterfaceStatus.status} stays the device's raw string, DR-032/DR-057). Adding a
 * config fixture would also mean editing `test/fixtures/config/manifest.json`, which is outside this
 * milestone's file list — `interfaces.ts` states which claims that defers to M12 (#14).
 *
 * ## Upstream port ledger
 *
 * `pyeapi/test/unit/test_api_interfaces.py` has **72** test methods (re-counted by AST on 2026-11-04);
 * the M10a scope is `TestFunctions` (`:48-62`), `TestApiInterfaces` (`:65-91`) and `TestApiBaseInterface`
 * (`:94-171`), and every command text those three pin is reproduced verbatim below:
 *  - `test_isvalidinterface_returns_true` (`:50-53`) / `_returns_false` (`:55-58`) — the six kind names
 *    yes, `Po1`/the shorthands no. Upstream's `isvalidinterface` (`interfaces.py:81-83`) is an **unanchored
 *    prefix match** ∩ `VALID_INTERFACES` (`:71-78`), so a bare kind and `Ethernet1 mode on` are valid and
 *    `Et1` is not; the parser answers that family its own way — anchored, index required — with the
 *    differences pinned beside each case (row 76, divergence 1).
 *  - `test_instance` (`:60-62`), `test_proxy_method_success` (`:85-87`), `test_proxy_method_raises_attribute_error`
 *    (`:89-91`) — the `__getattr__`/`marshall` dispatch (`interfaces.py:117-139`) is not ported (DR-006);
 *    the named verbs plus the guard refusals below replace what those three assert.
 *  - `test_get_interface_generic` (`:72-75`) / `_ethernet` (`:77-79`) / `test_get_invalid_interface` (`:81-83`)
 *    — record shapes and `None` for an unknown name (DR-027 keeps `undefined`). Upstream's `type` label names
 *    the **class** that answered; here `kind` names what the **name** is (divergence 2), so
 *    `get('Ethernet1')` answers `kind: 'Ethernet'` on today's build with the shared `BaseInterface` field set
 *    either way.
 *  - `test_getall` (`:95-115`) — upstream regex-scans the whole config with `(?<=^interface\s)(.+)$` under
 *    `re.M`, so a column-0 `interface …` inside a `banner login` body becomes an entry and a multi-token
 *    remainder becomes a name. Here the source is the chunked document (DR-055) and both are pinned as
 *    *no phantom entry* — including upstream's own proof that column-0 body lines exist
 *    (`test/fixtures/running_config.text:411`, the `vlan 1` line inside `banner login`, which is why its
 *    `test_getall` counts 5 entries from 6 matches).
 *  - `test_set_description_with_value` / `_with_no_value` / `_with_default` (`:107-124`) and `test_set_shutdown`
 *    / `_with_disable` / `_with_default` (`:126-142`) — the six `interface X` pairs
 *    (`description V` / `no description` / `default description`, `shutdown` / `no shutdown` / `default shutdown`)
 *    pinned exactly, as are the `mtu` trio this module adds (divergence 7).
 *  - the five `test_set_encapsulation_*` (`:144-171`) — `interface Ethernet1.1` + `encapsulation dot1q vlan 1`,
 *    the vid-less `no`/`default` arms, and upstream's two `NotImplementedError` refusals (no dot, wrong prefix),
 *    which the per-kind grammar makes structural (divergence 6).
 *  - `TestApiInterfaces.create/delete/default` (`:186-209`) and `test_ethernet_interface_create` (`:211-224`)
 *    — `interface X`, `no interface X`, `default interface Ethernet1`, and Ethernet create/delete refused
 *    (divergence 5: the refusal is a typed one naming M10b (#12, wave 2) as the owner).
 *  - MTU: **no upstream twin in this module** — `interfaces.py` has no MTU verb — so every bound asserted
 *    below is this client's (divergence 7), with the device keeping authority via a pinned `CommandError`.
 *
 * Upstream drives all of it through `EapiConfigUnitTest`, whose `MockConnection` answers `{}` to anything
 * it was not told about. Here an unscripted request is a loud failure and (`testing/mock-transport.ts:167`)
 * a string matcher is compared against the **whole joined command list**, never a prefix — so every batch
 * below spells every command it sends, `enable` and `configure terminal` included, and asserts `sent()`
 * entries rather than a bare count wherever the text matters.
 *
 * Anything about EOS itself — whether 4.28.13.1M accepts a dotted header on this SKU (DECISIONS.md open
 * item 7), whether it quotes a description, what its L2 MTU bounds are, what **its own** `show interfaces
 * status` model carries (only the cEOS-lab answer is captured), whether an interface sub-mode re-enters
 * rather than erroring — is **not** claimed here: unit tests never reach a device, a container capture is
 * not hardware evidence (DR-043), and this workspace has no readable CLI sources, so those read
 * "unverified on hardware, M12 (#14) to capture" in `interfaces.ts`.
 */

import { describe, expect, it } from 'vitest'

import { Node } from '../command-layer'
import { CommandError, ConfigParseError, EapiErrorCode, NotSupportedError, ProtocolError } from '../errors'
import { mockTransport, type MockReply, type MockTransport } from '../testing/mock-transport'
import { INTERFACE_STATUS_COMMAND, InterfacesResource, type InterfaceStatusMode, type InterfacesReadOptions } from './interfaces'
import { INTERFACE_KINDS, assertInterfaceName, assertVlanId, isInterfaceName, parseInterfaceName } from './validators'

/** Join lines into config text so a trailing-space line cannot be lost to an editor. */
const textOf = (lines: readonly string[]): string => lines.join('\n')

/**
 * Working operator-shaped config covering every kind the grammar has, in device order, deliberately flat
 * (`chunkConfig` hoists a section's sub-section keys ahead of the outer keys, `config/chunk.ts`, so nesting
 * belongs in the tests that are about nesting rather than in the one that is about header order).
 */
const FLAT_CONFIG = textOf([
  'hostname lab-sw1',
  'vlan internal allocation policy ascending',
  '!',
  'interface Ethernet1',
  '   description WAN uplink',
  '   no shutdown',
  '   mtu 9216',
  '!',
  'interface Ethernet2',
  '   shutdown',
  '!',
  'interface Ethernet0010',
  '   no shutdown',
  '!',
  'interface Port-Channel3',
  '   description ops bay',
  '   no shutdown',
  '   encapsulation dot1q vlan 40',
  '!',
  'interface Ethernet48.2044',
  '   encapsulation dot1q vlan 2044',
  '!',
  'interface Loopback2',
  '!',
  'interface Vlan20',
  '   mtu 1500',
  '!',
  'interface Management1',
  "   description Don't do this",
  '!',
  'interface Vxlan5',
  '!',
  'interface Ethernet1/1',
  '   no shutdown',
  '!',
  'interface link tracking group 1',
  '   no shutdown',
  '!',
  'no interface Ethernet7',
  '!',
  'end',
])

/** The ten `interface <one token>` headers FLAT_CONFIG carries, in device order. */
const FLAT_ORDER: readonly string[] = [
  'Ethernet1',
  'Ethernet2',
  'Ethernet0010',
  'Port-Channel3',
  'Ethernet48.2044',
  'Loopback2',
  'Vlan20',
  'Management1',
  'Vxlan5',
  'Ethernet1/1',
]

function configTransport(config: string): MockTransport {
  return mockTransport().replies('enable\nshow running-config all', [{}, { output: config }])
}

function nodeFor(config: string): { node: Node; transport: MockTransport } {
  const transport = configTransport(config)
  return { node: new Node(transport), transport }
}

/** The subject the way a caller reaches it: the `Node`'s static accessor (DR-052). */
function interfacesFor(config: string): InterfacesResource {
  return nodeFor(config).node.interfaces
}

/** A batch key: `configure()` prepends `enable` + `configure terminal`, and `configureInterface` the parent line. */
const writeKey = (cmds: readonly string[]): string => ['enable', 'configure terminal', ...cmds].join('\n')

/** Empty per-command replies for a successful config transaction: `enable`, `configure terminal`, then the batch. */
const okFor = (cmds: readonly string[]): MockReply => Array.from({ length: cmds.length + 2 }, () => ({}))

/** Script a whole config transaction, keyed by the exact command list it must carry. */
function scriptWrite(transport: MockTransport, cmds: readonly string[]): MockTransport {
  return transport.replies(writeKey(cmds), okFor(cmds))
}

/** The key for the hybrid read's second request — `Node.show` prepends `enable`, `showCommand` keeps the literal. */
const statusKey = `enable\n${INTERFACE_STATUS_COMMAND}`

/**
 * One `show interfaces status` answer in the **sibling command's** spelling: enable's reply, then
 * `interfaces` — pyeapi's `test/fixtures/show_interfaces.json` shape, kept readable as the fallback
 * (divergence 12).
 */
const statusReply = (rows: Record<string, unknown>): MockReply => [{}, { interfaces: rows }]

/**
 * The same answer in this command's **recorded** spelling — `interfaceStatuses`, from the cEOS-lab 4.28.14M
 * capture at `test/fixtures/live/ceos-4.28.14M/show-interfaces-status.json`. The row below is that file's
 * `result.interfaceStatuses.Ethernet1` verbatim (typo variant key included), so these pins read the same
 * JSON a real EOS answered; the container identity stays in the capture file (DR-043).
 */
const labStatusReply = (rows: Record<string, unknown>): MockReply => [{}, { interfaceStatuses: rows }]

/** The captured cEOS-lab row for `Ethernet1`, verbatim from that recording's `result`. */
const LAB_ROW_ETHERNET1 = {
  vlanInformation: { interfaceMode: 'bridged', vlanId: 1, interfaceForwardingModel: 'bridged' },
  bandwidth: 1000000000,
  interfaceType: 'EbraTestPhyPort',
  description: '',
  autoNegotiateActive: false,
  duplex: 'duplexFull',
  // The recording really carries both spellings of this one — the mis-cased sibling is device data, not ours.
  autoNegotigateActive: false,
  linkStatus: 'connected',
  lineProtocolStatus: 'up',
}

/** A reply that is **not** this command's model — the two-block `{ output }` shape a `format:'text'` answer has. */
const textReply: MockReply = [{}, { output: 'Ethernet1                 up   0 always   9216' }]

/** `configureInterface(parent, commands)` — the pair shape every field verb sends (abstract.py:166-178). */
const pair = (name: string, inner: string): readonly string[] => [`interface ${name}`, inner]

function outcome(fn: () => Promise<unknown>): Promise<unknown> {
  return fn().then(() => 'resolved' as const, (thrown: unknown) => thrown)
}

async function expectError(fn: () => Promise<unknown>, message: RegExp): Promise<void> {
  const thrown = await outcome(fn)
  expect(thrown).toBeInstanceOf(Error)
  expect((thrown as Error).message).toMatch(message)
}

/**
 * A guard rejection: the class, then the `refuse` prefix (`invalid <label> <repr> —`, `validators.ts` /
 * `interfaces.ts`), then the reason. M8 pinned the identical shape in `system.test.ts`, so nothing here
 * re-types a message this client never produces.
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

describe('interface name grammar — parseInterfaceName replaces interfaces.py:81-83 (the M10a validation split)', () => {
  it('reads Ethernet1 as the Ethernet arm with a numeric index', () => {
    expect(parseInterfaceName('Ethernet1')).toEqual({ kind: 'Ethernet', index: 1, name: 'Ethernet1', subinterface: undefined })
  })

  it('keeps the device spelling in `name` and drops leading zeros from `index` (row 76)', () => {
    expect(parseInterfaceName('Ethernet0010')).toEqual({ kind: 'Ethernet', index: 10, name: 'Ethernet0010' })
    expect(isInterfaceName('Ethernet0010')).toBe(true)
  })

  it('only Ethernet and Port-Channel may carry the `.<n>` suffix (interfaces.py:271-277)', () => {
    expect(parseInterfaceName('Ethernet1.100')).toEqual({ kind: 'Ethernet', index: 1, name: 'Ethernet1.100', subinterface: 100 })
    expect(parseInterfaceName('Port-Channel1.1')).toEqual({ kind: 'Port-Channel', index: 1, name: 'Port-Channel1.1', subinterface: 1 })
  })

  it('Port-Channel also has the plain arm, and its hyphen is part of the kind', () => {
    expect(parseInterfaceName('Port-Channel4')).toEqual({ kind: 'Port-Channel', index: 4, name: 'Port-Channel4' })
    expect(parseInterfaceName('PortChannel4')).toBeUndefined()
    expect(parseInterfaceName('port-channel4')).toBeUndefined()
  })

  it('the four suffix-free kinds answer with their own kind and no subinterface', () => {
    expect(parseInterfaceName('Management1')).toEqual({ kind: 'Management', index: 1, name: 'Management1' })
    expect(parseInterfaceName('Loopback12')).toEqual({ kind: 'Loopback', index: 12, name: 'Loopback12' })
    expect(parseInterfaceName('Vlan20')).toEqual({ kind: 'Vlan', index: 20, name: 'Vlan20' })
    expect(parseInterfaceName('Vxlan1')).toEqual({ kind: 'Vxlan', index: 1, name: 'Vxlan1' })
  })

  it('index zero is a name, not an absence', () => {
    expect(parseInterfaceName('Management0')).toEqual({ kind: 'Management', index: 0, name: 'Management0' })
    expect(isInterfaceName('Loopback0')).toBe(true)
    expect(isInterfaceName('Vlan0')).toBe(true)
    // `0` being falsy in no way makes the name illegible — the DR-037 trap lives in the *value* guards.
  })

  it('a bare kind with no index is refused (upstream ACCEPTED it: `[a-z-C]+` needs no digits, :82)', () => {
    const bare = ['Ethernet', 'Port-Channel', 'Management', 'Loopback', 'Vlan', 'Vxlan']
    expect(bare).toHaveLength(INTERFACE_KINDS.length)
    for (const kind of bare) {
      expect(parseInterfaceName(kind)).toBeUndefined()
      expect(isInterfaceName(kind)).toBe(false)
    }
    // `interface Vlan` is not a command an operator can send, which is why the index is required here.
  })

  it('the two-character shorthands are refused, which upstream also refused (probe: `Po1` → `Po` ∉ set)', () => {
    for (const short of ['Po1', 'Et1', 'E1', 'P1', 'M1', 'L1', 'V1', 'Vx1', 't1', 'Vlan20x']) {
      expect(parseInterfaceName(short)).toBeUndefined()
    }
    // `t1` is what upstream's switchports-class character accident accepted (`[Et|Po]`); the name grammar
    // here never had that hole, and `validators.test.ts` pins the same boundary for M7.
  })

  it('the pattern is fully anchored, so a command line cannot wander into a name position', () => {
    for (const junk of ['Ethernet1 mode on', 'Ethernet1/1', 'Ethernet1.', 'Ethernet1.1.2', 'Ethernet0x', ' Ethernet1', 'Vlan 20', 'Port Channel1']) {
      expect(parseInterfaceName(junk)).toBeUndefined()
    }
    // Upstream's unanchored `re.match` answers the `Ethernet` kind for the first and fourth of those.
  })

  it('trailing whitespace is refused too, but a zero-padded index past the safe bound is not', () => {
    expect(parseInterfaceName('Ethernet1 ')).toBeUndefined()
    expect(parseInterfaceName('Ethernet00000000000000000000001')).toEqual({ kind: 'Ethernet', index: 1, name: 'Ethernet00000000000000000000001' })
  })

  it('the chassis/slot form keeps M9\'s boundary (DECISIONS.md open item 7, refused not guessed)', () => {
    expect(parseInterfaceName('Ethernet1/1')).toBeUndefined()
    expect(parseInterfaceName('Peer-Ethernet1')).toBeUndefined()
    expect(isInterfaceName('Ethernet1/1')).toBe(false)
  })

  it('spelling is never normalised, so case variants are refused rather than folded', () => {
    for (const wrong of ['ethernet1', 'PORT-CHANNEL1', 'VxLAN1', 'vlan20']) expect(parseInterfaceName(wrong)).toBeUndefined()
  })

  it('a non-string is a failed parse, not a thrown one (readers call this on device text)', () => {
    for (const value of [1, 0, null, undefined, true, false, ['Ethernet1'], { kind: 'Ethernet' }]) {
      expect(parseInterfaceName(value)).toBeUndefined()
      expect(isInterfaceName(value)).toBe(false)
    }
  })

  it('an index or a suffix that cannot be held fails the parse rather than answering partially (DR-059)', () => {
    expect(parseInterfaceName('Ethernet999999999999999999999')).toBeUndefined()
    expect(parseInterfaceName('Ethernet1.999999999999999999999')).toBeUndefined()
  })

  it('isInterfaceName is the parser\'s answer minus the suffix, which is what the write guards share', () => {
    expect(isInterfaceName('Ethernet1')).toBe(true)
    expect(isInterfaceName('Ethernet1.100')).toBe(false)
    expect(isInterfaceName('Port-Channel1.1')).toBe(false)
  })

  it('the kind patterns are pairwise non-overlapping, so Vlan1 and Vxlan1 cannot shadow each other', () => {
    expect(parseInterfaceName('Vlan1')?.kind).toBe('Vlan')
    expect(parseInterfaceName('Vxlan1')?.kind).toBe('Vxlan')
    expect(parseInterfaceName('Vlan')?.kind).toBeUndefined()
  })

  it('assertInterfaceName accepts one name per kind, in INTERFACE_KINDS order', () => {
    const names = ['Ethernet1', 'Management0', 'Loopback12', 'Port-Channel4', 'Vlan20', 'Vxlan1']
    expect(names).toHaveLength(INTERFACE_KINDS.length)
    for (const name of names) {
      assertInterfaceName(name)
      expect(isInterfaceName(name)).toBe(true)
    }
  })

  it('assertInterfaceName refuses a subinterface name with the shared guard, and says who reads it', () => {
    expect(() => assertInterfaceName('Ethernet1.1')).toThrow(NotSupportedError)
    expect(() => assertInterfaceName('Ethernet1.1')).toThrow(/invalid interface 'Ethernet1\.1'/)
    expect(() => assertInterfaceName('Ethernet1.1')).toThrow(/with no subinterface suffix/)
    expect(() => assertInterfaceName('Port-Channel1.1')).toThrow(/setEncapsulation/)
  })

  it('assertInterfaceName refuses the shorthands, a bare kind, and the empty name by name', () => {
    for (const bad of ['Po1', 'Et1', 'Vlan', '']) {
      expect(() => assertInterfaceName(bad)).toThrow(/invalid interface/)
      expect(() => assertInterfaceName(bad)).toThrow(bad === '' ? "invalid interface '' —" : `invalid interface '${bad}' —`)
    }
  })

  it('a rejected non-string is rendered pyeapi\'s way, so `undefined` never appears in a message', () => {
    for (const value of [null, undefined, 20, true]) {
      expect(() => assertInterfaceName(value)).toThrow(/invalid interface/)
    }
    expect(() => assertInterfaceName(null)).toThrow(/invalid interface None/)
    expect(() => assertInterfaceName(20)).toThrow(/invalid interface 20/)
    expect(() => assertInterfaceName(true)).toThrow(/invalid interface True/)
  })

  it('the message lists the six kinds in the load-bearing order (validators.test.ts pins the spelling)', () => {
    expect(() => assertInterfaceName('interface t1')).toThrow(
      /Ethernet \/ Management \/ Loopback \/ Port-Channel \/ Vlan \/ Vxlan followed by an index/,
    )
    expect(INTERFACE_KINDS.join(' / ')).toBe('Ethernet / Management / Loopback / Port-Channel / Vlan / Vxlan')
  })

  it('a name guard and a VLAN-id guard are different guards on different verbs (DR-053)', () => {
    expect(parseInterfaceName('Vlan9999')?.index).toBe(9999)
    expect(() => assertVlanId(9999)).toThrow(/invalid vlan 9999 — expected an integer VLAN id 1\.\.4094/)
    // The top of the range is inclusive, so 4094 is accepted and no guard message is produced.
    assertVlanId(4094)
  })
})

describe('InterfacesResource read matrix — interfacesFromSections over the chunked document (divergences 1/2/3)', () => {
  it('the whole table comes from ONE running-config, in device order (DR-030/DR-055)', async () => {
    const { node, transport } = nodeFor(FLAT_CONFIG)
    const all = await node.interfaces.getAll({ status: 'skip' })
    expect([...all.keys()]).toEqual(FLAT_ORDER)
    expect(all.size).toBe(FLAT_ORDER.length)
    // The lines that must not become entries: multi-token header, negated header, and non-interface sections.
    expect(all.has('link tracking group 1')).toBe(false)
    expect(all.has('Ethernet7')).toBe(false)
    expect(transport.callCount()).toBe(1)
    expect(sentAsText(transport)).toEqual([['enable', 'show running-config all']])
  })

  it('an Ethernet section answers the shared BaseInterface field set (interfaces.py:147-177)', async () => {
    const all = await interfacesFor(FLAT_CONFIG).getAll({ status: 'skip' })
    expect(all.get('Ethernet1')).toEqual({ name: 'Ethernet1', kind: 'Ethernet', shutdown: false, description: 'WAN uplink', mtu: 9216 })
  })

  it('the two administrative command lines answer opposite booleans', async () => {
    const all = await interfacesFor(FLAT_CONFIG).getAll({ status: 'skip' })
    expect(all.get('Ethernet2')).toEqual({ name: 'Ethernet2', kind: 'Ethernet', shutdown: true })
    expect(all.get('Ethernet0010')).toEqual({ name: 'Ethernet0010', kind: 'Ethernet', shutdown: false })
    expect(all.get('Management1')).toEqual({ name: 'Management1', kind: 'Management', description: "Don't do this" })
  })

  it('DR-027: a block that writes neither line answers ABSENT, not the device default (divergence 3)', async () => {
    const all = await interfacesFor(FLAT_CONFIG).getAll({ status: 'skip' })
    expect(all.get('Loopback2')).toEqual({ name: 'Loopback2', kind: 'Loopback' })
    expect(all.get('Vxlan5')).toEqual({ name: 'Vxlan5', kind: 'Vxlan' })
    // pyeapi's `'no shutdown' not in config` (`interfaces.py:190`) answers `shutdown: True` for both of
    // these from the absence of a line alone — the same shape as its own fixture's `interface Loopback2`
    // (running_config.text:1600), a section its suite never looks at (test_api_interfaces.py:72-75 checks
    // `type` for `Loopback0`). Deriving the EOS default from config text is the claim DR-057 refuses.
  })

  it('Port-Channel and the subinterface header carry the fields this module reads (divergence 6)', async () => {
    const all = await interfacesFor(FLAT_CONFIG).getAll({ status: 'skip' })
    expect(all.get('Port-Channel3')).toEqual({ name: 'Port-Channel3', kind: 'Port-Channel', shutdown: false, description: 'ops bay', encapsulation: 40 })
    expect(all.get('Ethernet48.2044')).toEqual({ name: 'Ethernet48.2044', kind: 'Ethernet', encapsulation: 2044 })
  })

  it('Vlan / Management / Vxlan interfaces are entries of THIS module (where switchports excludes them)', async () => {
    const all = await interfacesFor(FLAT_CONFIG).getAll({ status: 'skip' })
    expect(all.get('Vlan20')).toEqual({ name: 'Vlan20', kind: 'Vlan', mtu: 1500 })
    expect(all.get('Vxlan5')).toEqual({ name: 'Vxlan5', kind: 'Vxlan' })
    // Reading a Vxlan section is not a claim that VXLAN is configurable on this SKU — M10d, wave 3.
  })

  it('a header this grammar cannot read keeps its row with kind null, and is findable by get()', async () => {
    const all = await interfacesFor(FLAT_CONFIG).getAll({ status: 'skip' })
    expect(all.get('Ethernet1/1')).toEqual({ name: 'Ethernet1/1', kind: null, shutdown: false })
    // `get` looks the same table up, so the two can never disagree (upstream routes `get` by name[0:2]
    // instead, `interfaces.py:121`, which sends Vlan/Loopback/Management to BaseInterface by accident).
    const interfaces = interfacesFor(FLAT_CONFIG)
    expect(await interfaces.get('Ethernet1/1', { status: 'skip' })).toEqual({ name: 'Ethernet1/1', kind: null, shutdown: false })
    await expectError(() => interfaces.setDefault('Ethernet1/1'), /invalid interface 'Ethernet1\/1'/)
  })

  it('a multi-token header, a negated header and a bare keyword are not entries (divergence 1)', async () => {
    const all = await interfacesFor(textOf([
      'interface Ethernet1',
      '   no shutdown',
      '!',
      'interface link tracking group 1',
      '   no shutdown',
      '!',
      'no interface Ethernet7',
      '!',
      'interface',
      '   no shutdown',
      'end',
    ])).getAll({ status: 'skip' })
    expect([...all.keys()]).toEqual(['Ethernet1'])
    // Upstream keeps the whole line remainder as a name (`(.+)$`, :108), then `Interfaces.get` prefix-matches
    // `link` and the `if interface:` filter at `:111` drops it — a coincidental agreement this client reaches
    // by refusing the name shape instead.
  })

  it('an `interface …` line inside a banner body cannot become an entry (upstream answers a phantom)', async () => {
    const all = await interfacesFor(textOf([
      'hostname sw1',
      'banner login',
      'interface Ethernet99',
      '   description inside the banner',
      '   no shutdown',
      'EOF',
      'interface Ethernet1',
      '   no shutdown',
      '!',
      'end',
    ])).getAll({ status: 'skip' })
    expect([...all.keys()]).toEqual(['Ethernet1'])
    expect(all.get('Ethernet99')).toBeUndefined()
    // Upstream's re.M scan matches that column-0 body line; its own fixture proves such lines exist
    // (`vlan 1` inside `banner login` at running_config.text:411 — why its test_getall counts 5 of 6 matches).
  })

  it('an indented copy of the header is not an interface either (the indent-0 anchor)', async () => {
    const all = await interfacesFor(textOf([
      'management api http-commands',
      '   no shutdown',
      '   interface Ethernet5',
      '      no shutdown',
      '      logging enabled',
      '!',
      'end',
    ])).getAll({ status: 'skip' })
    expect([...all.keys()]).toEqual([])
    // chunkConfig does hand that indented line out as a sub-section key, so `^interface …$` is what prunes
    // it — and the `no shutdown` above is a global command, not any interface's state.
  })

  it('has()/keys()/entries() ride one getAll each — never one read per element', async () => {
    const { node, transport } = nodeFor(FLAT_CONFIG)
    transport.replies(statusKey, statusReply({ Ethernet1: { interfaceStatus: 'connected' } }))
    expect(await node.interfaces.has('Ethernet1')).toBe(true)
    expect(await node.interfaces.has('Ethernet99')).toBe(false)
    const keys = await node.interfaces.keys()
    const entries = await node.interfaces.entries()
    expect(keys).toEqual([...FLAT_ORDER])
    expect(entries.map(([name]) => name)).toEqual([...FLAT_ORDER])
    // One config read + one status read per collection verb, and the config memo (DR-026) means the
    // later verbs pay only the status leg.
    expect(transport.callCount()).toBe(5)
  })

  it('an unknown name answers undefined, keeping upstream\'s None (test_api_interfaces.py:81-83)', async () => {
    const interfaces = interfacesFor(FLAT_CONFIG)
    expect(await interfaces.get('Ethernet99', { status: 'skip' })).toBeUndefined()
    expect(await interfaces.get('Po1', { status: 'skip' })).toBeUndefined()
    expect(await interfaces.has('Ethernet1.1')).toBe(false)
    // No name guard runs on a read: upstream's facade `get` validates nothing either (`:92-93`), and a
    // name this client refuses to write is simply not a key here.
  })

  it('an empty config is an empty table, not an error — the empty state a UI must render as "none"', async () => {
    const all = await interfacesFor('').getAll({ status: 'skip' })
    expect(all.size).toBe(0)
    expect([...all.keys()]).toEqual([])
  })

  it('`default shutdown` in a body is neither answer, so the state stays absent', async () => {
    const all = await interfacesFor(textOf(['interface Ethernet1', '   default shutdown', 'end'])).getAll({ status: 'skip' })
    expect(all.get('Ethernet1')).toEqual({ name: 'Ethernet1', kind: 'Ethernet' })
    // Upstream reads that very line as administratively UP (`'no shutdown' not in config`, :190) while
    // emitting `default shutdown` itself (test_api_interfaces.py:138-142).
  })

  it('whole-command matching, so a near-miss line cannot answer (rows 43/44\'s rule, at this layer)', async () => {
    const all = await interfacesFor(textOf(['interface Ethernet1', '   no shutdowns today', '   shutdown now', 'end'])).getAll({ status: 'skip' })
    expect(all.get('Ethernet1')).toEqual({ name: 'Ethernet1', kind: 'Ethernet' })
  })

  it('with both administrative forms in one block, device order wins and no rule is invented', async () => {
    const down = await interfacesFor(textOf(['interface Ethernet1', '   shutdown', '   no shutdown', 'end'])).getAll({ status: 'skip' })
    expect(down.get('Ethernet1')?.shutdown).toBe(true)
    const up = await interfacesFor(textOf(['interface Ethernet1', '   no shutdown', '   shutdown', 'end'])).getAll({ status: 'skip' })
    expect(up.get('Ethernet1')?.shutdown).toBe(false)
  })

  it('the description keyword is anchored at its start and the first line wins, like upstream\'s re.search', async () => {
    const all = await interfacesFor(textOf([
      'interface Ethernet1',
      '   description first one wins',
      '   description second one ignored',
      '   no description cleared elsewhere',
      '   descriptionless x',
      'end',
    ])).getAll({ status: 'skip' })
    expect(all.get('Ethernet1')?.description).toBe('first one wins')
    // Upstream's unanchored `description (.+)$` (`:206`) agrees on the winner but answers for the last two
    // lines too — the negated one and the `descriptionless` word.
  })

  it('EOS "quoting" is stripped when balanced and inner whitespace survives (row 49)', async () => {
    const all = await interfacesFor(textOf([
      'interface Ethernet1',
      '   description "WAN in quotes"',
      '!',
      'interface Ethernet2',
      '   description " WAN uplink "',
      'end',
    ])).getAll({ status: 'skip' })
    expect(all.get('Ethernet1')?.description).toBe('WAN in quotes')
    expect(all.get('Ethernet2')?.description).toBe(' WAN uplink ')
    // pyeapi keeps the quotes verbatim (`:206` is a raw remainder), so a UI would show them; the write
    // side refuses exactly these values, which the write tests pin.
  })

  it('an unbalanced quote is reported as the device wrote it, never "repaired"', async () => {
    const all = await interfacesFor(textOf(['interface Ethernet1', '   description "quote"inside"', 'end'])).getAll({ status: 'skip' })
    expect(all.get('Ethernet1')?.description).toBe('"quote"inside"')
  })

  it('the whitespace run after the keyword collapses, but inner runs do not', async () => {
    const all = await interfacesFor(textOf(['interface Ethernet1', '   description    WAN   uplink', 'end'])).getAll({ status: 'skip' })
    expect(all.get('Ethernet1')?.description).toBe('WAN   uplink')
  })

  it('fields cannot read each other (contrast interfaces.py:190/:206 whole-block scans)', async () => {
    const all = await interfacesFor(textOf(['interface Ethernet1', '   description mtu 9216', 'end'])).getAll({ status: 'skip' })
    expect(all.get('Ethernet1')).toEqual({ name: 'Ethernet1', kind: 'Ethernet', description: 'mtu 9216' })
    // Upstream's `description (.+)$` answers the same string but its `_parse_shutdown` would also see
    // nothing here only by luck; a `mtu` value inside another word never votes (config-block.ts, row 91).
  })

  it('a non-decimal numeric field is a parse failure naming section and keyword (no truncation)', async () => {
    for (const bad of ['banana', '20.5', '-1', '9 216', '0x100']) {
      const thrown = await outcome(() => interfacesFor(textOf(['interface Ethernet1', `   mtu ${bad}`, 'end'])).getAll({ status: 'skip' }))
      expect(thrown, bad).toBeInstanceOf(ConfigParseError)
      expect((thrown as Error).message).toContain("interfaces: cannot read 'mtu' in 'interface Ethernet1'")
      expect((thrown as Error).message).toContain('not a decimal number')
    }
    // `ipinterfaces.py:126` answers `20` for the `20.5` shape — truncating device text is what row 43/44
    // forbids, and a resource that truncates cannot show a reviewable diff.
  })

  it('a decimal too large to hold is its own refusal, not a rounded answer', async () => {
    const thrown = await outcome(() => interfacesFor(textOf(['interface Ethernet1', '   mtu 999999999999999999999', 'end'])).getAll({ status: 'skip' }))
    expect(thrown).toBeInstanceOf(ConfigParseError)
    expect((thrown as Error).message).toContain('cannot hold as an integer index')
  })

  it('one unreadable section poisons the whole read naming itself, and disappears from nothing (DR-059)', async () => {
    const thrown = await outcome(() => interfacesFor(textOf([
      'interface Ethernet1',
      '   no shutdown',
      '!',
      'interface Ethernet2',
      '   mtu nope',
      '!',
      'interface Ethernet3',
      '   no shutdown',
      'end',
    ])).getAll({ status: 'skip' }))
    expect(thrown).toBeInstanceOf(ConfigParseError)
    expect((thrown as Error).message).toContain("in 'interface Ethernet2'")
    // Upstream's `getall` has no answer at all in this case once a `_parse_*` raises (:111-114), and a
    // falsy record silently vanishes from the table (divergence 8's counter-argument).
  })

  it('the encapsulation keyword is anchored at its own start, so negated/default lines are not values', async () => {
    const all = await interfacesFor(textOf([
      'interface Ethernet48.2044',
      '   default encapsulation dot1q vlan',
      '   no encapsulation dot1q vlan 0',
      '!',
      'interface Ethernet49.1',
      '   encapsulation dot1q vlan 1',
      'end',
    ])).getAll({ status: 'skip' })
    expect(all.get('Ethernet48.2044')).toEqual({ name: 'Ethernet48.2044', kind: 'Ethernet' })
    expect(all.get('Ethernet49.1')).toEqual({ name: 'Ethernet49.1', kind: 'Ethernet', encapsulation: 1 })
    // pyeapi's fixture writes that `default …` line inside `interface Ethernet1`
    // (test/fixtures/running_config.text:565) beside its `no l2-protocol encapsulation dot1q vlan 0` (:566).
  })

  it('a nested sub-mode body line answers for the interface (divergence 10, shared limitation)', async () => {
    const all = await interfacesFor(textOf([
      'interface Ethernet6',
      '   management description hooks',
      '      mtu 64',
      '      default shutdown',
      'end',
    ])).getAll({ status: 'skip' })
    expect(all.get('Ethernet6')).toEqual({ name: 'Ethernet6', kind: 'Ethernet', mtu: 64 })
    // `ConfigLine.indent` is deliberately not filtered — M9's shipped extractors do not filter it either,
    // and pyeapi's whole-block substring/regex reads already behave this way (`:190`, `:206`). The fix, if
    // M12 (#14) shows interface sub-modes carry these commands, is one indent bound in config-block.ts.
  })

  it('the keys keep the device\'s own zero-padded spelling, which the presence verbs take back', async () => {
    const { node, transport } = nodeFor(FLAT_CONFIG)
    const interfaces = node.interfaces
    const keys = await interfaces.keys()
    expect(keys.filter((key) => key.startsWith('Ethernet0'))).toEqual(['Ethernet0010'])
    await expectRefusal(() => interfaces.delete('Ethernet0010'), "invalid delete interface 'Ethernet0010'", 'and not an Ethernet')
    scriptWrite(transport, ['default interface Ethernet0010'])
    await interfaces.setDefault('Ethernet0010')
    expect(sentAsText(transport)).toEqual([
      ['enable', 'show running-config all'],
      ['enable', 'show interfaces status'],
      ['enable', 'configure terminal', 'default interface Ethernet0010'],
    ])
    // `index` (10) is deliberately not stitched back into the name: a UI that renamed the entry would be
    // claiming a device spelling it never saw. The zero-padded header is also still an Ethernet, so it
    // keeps the create/delete refusal — which `setDefault` shows is a per-verb rule, not a name rule.
  })
})

describe('InterfacesResource hybrid read — configuration decides existence (divergences 8/9/11)', () => {
  it('{ status: "skip" } is one request, for a table that shows no operational column', async () => {
    const transport = configTransport(FLAT_CONFIG)
    const all = await new Node(transport).interfaces.getAll({ status: 'skip' })
    expect(all.size).toBe(FLAT_ORDER.length)
    expect(transport.callCount()).toBe(1)
    expect(sentAsText(transport)).toEqual([['enable', 'show running-config all']])
  })

  it('a device that models the show pays 2 requests and merges the row onto config entries only', async () => {
    const transport = configTransport(FLAT_CONFIG).replies(statusKey, statusReply({
      Ethernet1: { description: 'WAN uplink', interfaceStatus: 'connected', mtu: 9216 },
    }))
    const all = await new Node(transport).interfaces.getAll()
    expect(all.get('Ethernet1')).toEqual({
      name: 'Ethernet1',
      kind: 'Ethernet',
      shutdown: false,
      description: 'WAN uplink',
      mtu: 9216,
      status: { name: 'Ethernet1', description: 'WAN uplink', status: 'connected', mtu: 9216 },
    })
    expect(all.get('Ethernet2')).toEqual({ name: 'Ethernet2', kind: 'Ethernet', shutdown: true })
    expect(transport.callCount()).toBe(2)
    expect(sentAsText(transport)).toEqual([
      ['enable', 'show running-config all'],
      ['enable', 'show interfaces status'],
    ])
  })

  it('config = existence: a status-only row never joins the table (divergence 8)', async () => {
    const transport = configTransport(FLAT_CONFIG).replies(statusKey, statusReply({
      Ethernet1: { interfaceStatus: 'connected' },
      Ethernet9: { interfaceStatus: 'disabled' },
    }))
    const all = await new Node(transport).interfaces.getAll()
    expect(all.size).toBe(FLAT_ORDER.length)
    expect(all.has('Ethernet9')).toBe(false)
    // Driving from the show instead would strand a port the model lists with no config block for, where
    // this client has no honest `shutdown` answer — and would inherit column spellings from a sibling
    // command's capture, which is exactly what DR-031 refuses for this unconfirmed show.
  })

  it('an unscripted status read leaves the config table intact — the auto fallback counts 2', async () => {
    const transport = configTransport(FLAT_CONFIG)
    const all = await new Node(transport).interfaces.getAll()
    expect(all.size).toBe(FLAT_ORDER.length)
    expect([...all.values()].every((entry) => entry.status === undefined)).toBe(true)
    expect(transport.callCount()).toBe(2)
    expect(sentAsText(transport)).toEqual([
      ['enable', 'show running-config all'],
      ['enable', 'show interfaces status'],
    ])
  })

  it('a 1002 on the status leg leaves the config table intact', async () => {
    const transport = configTransport(FLAT_CONFIG).rejects(statusKey, {
      code: EapiErrorCode.COMMAND_INVALID,
      message: "CLI command 2 of 2 'show interfaces status' failed: command not available on this unit",
    })
    const all = await new Node(transport).interfaces.getAll()
    expect(all.size).toBe(FLAT_ORDER.length)
    expect(all.get('Ethernet1')?.status).toBeUndefined()
    expect(transport.callCount()).toBe(2)
  })

  it('a 1003 costs a third request and still leaves the table intact (DR-012 text retry)', async () => {
    const transport = configTransport(FLAT_CONFIG)
      .repliesOnce(statusKey, { error: { code: EapiErrorCode.COMMAND_UNCONVERTED, message: "CLI command 2 of 2 'show interfaces status' failed: no json model" } })
      .replies(statusKey, textReply)
    const all = await new Node(transport).interfaces.getAll()
    expect(all.size).toBe(FLAT_ORDER.length)
    expect(all.get('Ethernet1')?.status).toBeUndefined()
    expect(transport.callCount()).toBe(3)
    expect(sentAsText(transport)).toEqual([
      ['enable', 'show running-config all'],
      ['enable', 'show interfaces status'],
      ['enable', 'show interfaces status'],
    ])
    // The retry answer is a `format:'text'` block, which statusRowsFrom refuses rather than reading as
    // "a switch with no interfaces" — which is why the next test pins the ProtocolError wording.
  })

  it('{ status: "require" } re-throws instead of hiding, for both failure kinds', async () => {
    const thrown = await outcome(() => nodeFor(FLAT_CONFIG).node.interfaces.getAll({ status: 'require' }))
    expect(thrown).toBeInstanceOf(NotSupportedError)
    expect((thrown as Error).message).toContain('show interfaces status')

    const transport = configTransport(FLAT_CONFIG).rejects(statusKey, {
      code: EapiErrorCode.COMMAND_UNAUTHORIZED,
      message: "CLI command 2 of 2 'show interfaces status' failed: insufficient role",
    })
    const failed = await outcome(() => new Node(transport).interfaces.getAll({ status: 'require' }))
    expect(failed).toBeInstanceOf(CommandError)
    expect((failed as CommandError).failedCommand).toBe('show interfaces status')
    expect((failed as CommandError).code).toBe(EapiErrorCode.COMMAND_UNAUTHORIZED)
  })

  it('the three-mode union is the whole vocabulary, and auto is the default (InterfacesReadOptions)', () => {
    const modes: readonly InterfaceStatusMode[] = ['auto', 'skip', 'require']
    expect([...modes]).toEqual(['auto', 'skip', 'require'])
    const skipped: InterfacesReadOptions = { status: 'skip' }
    const required: InterfacesReadOptions = { status: 'require' }
    expect(skipped.status).toBe('skip')
    expect(required.status).toBe('require')
    expect(INTERFACE_STATUS_COMMAND).toBe('show interfaces status')
    // The default is `{}` — no status key — which is what `options.status ?? 'auto'` then means.
    const empty: InterfacesReadOptions = {}
    expect(empty.status).toBeUndefined()
  })

  it('getStatus() answers the status table alone, keyed by the model\'s own member names', async () => {
    const transport = configTransport(FLAT_CONFIG).replies(statusKey, statusReply({
      Ethernet1: { description: 'WAN uplink', interfaceStatus: 'connected', lineProtocolStatus: 'up', hardware: 'ethernet', mtu: 9216 },
      Ethernet9: { interfaceStatus: 'disabled' },
    }))
    const rows = await new Node(transport).interfaces.getStatus()
    expect([...rows.keys()]).toEqual(['Ethernet1', 'Ethernet9'])
    expect(rows.get('Ethernet1')).toEqual({
      name: 'Ethernet1',
      description: 'WAN uplink',
      status: 'connected',
      protocol: 'up',
      hardware: 'ethernet',
      mtu: 9216,
    })
    expect(rows.get('Ethernet9')).toEqual({ name: 'Ethernet9', status: 'disabled' })
    expect(transport.callCount()).toBe(1)
    expect(sentAsText(transport)).toEqual([['enable', 'show interfaces status']])
  })

  it('divergence 11: a wrong-typed column reads absent, and `null` never becomes 0', async () => {
    const transport = configTransport(FLAT_CONFIG).replies(statusKey, statusReply({
      Ethernet1: { interfaceStatus: 7, mtu: null, hardware: undefined, description: ['list'], name: 'Ethernet1' },
    }))
    const rows = await new Node(transport).interfaces.getStatus()
    expect(rows.get('Ethernet1')).toEqual({ name: 'Ethernet1' })
    // A `0` here is the value pyeapi's habit of `int()`-ing anything would produce, and a UI cannot tell
    // an invented MTU from the device's own.
  })

  it('a member that is not an object is skipped and keeps the good rows (DR-027)', async () => {
    const transport = configTransport(FLAT_CONFIG).replies(statusKey, statusReply({
      Ethernet1: { interfaceStatus: 'connected' },
      Ethernet2: null,
      Ethernet3: ['x'],
      Ethernet4: { mtu: 9216 },
    }))
    const rows = await new Node(transport).interfaces.getStatus()
    expect([...rows.keys()]).toEqual(['Ethernet1', 'Ethernet4'])
    expect(rows.get('Ethernet4')).toEqual({ name: 'Ethernet4', mtu: 9216 })
  })

  it('a reply that is not this command\'s model throws, naming the text-block case (no silent empty table)', async () => {
    const transport = configTransport(FLAT_CONFIG).replies(statusKey, [{}, {}])
    const thrown = await outcome(() => new Node(transport).interfaces.getStatus())
    expect(thrown).toBeInstanceOf(ProtocolError)
    expect((thrown as Error).message).toContain('so no status row can be read')

    const textNode = configTransport(FLAT_CONFIG).replies(statusKey, textReply)
    const textThrown = await outcome(() => new Node(textNode).interfaces.getStatus())
    expect(textThrown).toBeInstanceOf(ProtocolError)
    expect((textThrown as Error).message).toContain("`format: 'text'` output block")
    // Reading nothing from an `{ output }` block and answering "no interfaces" from it is the wrong
    // answer this client refuses; `getStatus()` is the verb that reports it instead of swallowing.
  })

  it('an EMPTY interfaces map is an empty status table, distinct from an absent one', async () => {
    const transport = configTransport(FLAT_CONFIG).replies(statusKey, statusReply({}))
    const rows = await new Node(transport).interfaces.getStatus()
    expect(rows.size).toBe(0)
    const all = await new Node(transport).interfaces.getAll()
    expect(all.size).toBe(FLAT_ORDER.length)
    expect([...all.values()].every((entry) => entry.status === undefined)).toBe(true)
  })

  it('the status description is verbatim — empty and quoted values, unlike the configured half', async () => {
    const transport = configTransport(FLAT_CONFIG).replies(statusKey, statusReply({
      Management1: { description: '', interfaceStatus: 'connected' },
      Ethernet1: { description: '"WAN quoted"', interfaceStatus: 'connected' },
    }))
    const interfaces = new Node(transport).interfaces
    const merged = await interfaces.getAll()
    expect(merged.get('Management1')?.status).toEqual({ name: 'Management1', description: '', status: 'connected' })
    expect(merged.get('Ethernet1')?.status).toEqual({ name: 'Ethernet1', description: '"WAN quoted"', status: 'connected' })
    // The capture carries an empty description on `Management1`, so absence is not a fair reading there;
    // the *write* side refuses an empty value because `unsetDescription` is that intent (DR-037).
    await expectRefusal(() => interfaces.setDescription('Management1', ''), "invalid interface description ''")
  })

  it('the merged entry keeps every configured field and adds exactly one key', async () => {
    const transport = configTransport(FLAT_CONFIG).replies(statusKey, statusReply({ 'Port-Channel3': { interfaceStatus: 'disabled' } }))
    const merged = await new Node(transport).interfaces.getAll()
    expect(merged.get('Port-Channel3')).toEqual({
      name: 'Port-Channel3',
      kind: 'Port-Channel',
      shutdown: false,
      description: 'ops bay',
      encapsulation: 40,
      status: { name: 'Port-Channel3', status: 'disabled' },
    })
  })

  it('get() after getAll() reuses the config memo but re-reads the status leg', async () => {
    const transport = configTransport(FLAT_CONFIG).replies(statusKey, statusReply({ Ethernet1: { interfaceStatus: 'connected' } }))
    const interfaces = new Node(transport).interfaces
    expect((await interfaces.getAll()).has('Ethernet1')).toBe(true)
    expect((await interfaces.get('Ethernet1'))?.description).toBe('WAN uplink')
    expect(transport.callCount()).toBe(3)
    expect(transport.bodies().filter((body) => body.params.cmds.some((c) => String(c) === 'show running-config all'))).toHaveLength(1)
    // `{ status: 'skip' }` is how a caller asks for the one-read table; note the option follows `get` too.
    const cheap = await interfaces.get('Ethernet2', { status: 'skip' })
    expect(cheap).toEqual({ name: 'Ethernet2', kind: 'Ethernet', shutdown: true })
    expect(transport.callCount()).toBe(3)
  })

  it('a write drops the chunk memo so the next read sees the device\'s fresh text (DR-026 seam)', async () => {
    const transport = mockTransport()
      .repliesOnce('enable\nshow running-config all', [{}, { output: FLAT_CONFIG }])
      .replies(writeKey(pair('Ethernet2', 'no shutdown')), okFor(pair('Ethernet2', 'no shutdown')))
      .repliesOnce('enable\nshow running-config all', [{}, { output: textOf(['interface Ethernet2', '   no shutdown', 'end']) }])
    const interfaces = new Node(transport).interfaces
    expect((await interfaces.getAll({ status: 'skip' })).get('Ethernet2')?.shutdown).toBe(true)
    await interfaces.noShutdown('Ethernet2')
    expect((await interfaces.getAll({ status: 'skip' })).get('Ethernet2')?.shutdown).toBe(false)
    expect(transport.callCount()).toBe(3)
    expect(sentAsText(transport)).toEqual([
      ['enable', 'show running-config all'],
      ['enable', 'configure terminal', 'interface Ethernet2', 'no shutdown'],
      ['enable', 'show running-config all'],
    ])
  })

  it('a config read the device refuses rejects with the device error, not an empty table', async () => {
    const transport = mockTransport().rejects('show running-config all', {
      code: EapiErrorCode.COMMAND_INVALID,
      message: "CLI command 2 of 2 'show running-config all' failed: invalid input",
    })
    const thrown = await outcome(() => new Node(transport).interfaces.getAll())
    expect(thrown).toBeInstanceOf(CommandError)
    expect((thrown as CommandError).failedCommand).toBe('show running-config all')
    expect(sentAsText(transport)).toEqual([['enable', 'show running-config all']])
    // The status leg is never reached: existence unknown means the enrichment cannot rescue anything,
    // which is the whole point of reading the config first (divergence 8).
  })

  it('an unreachable device rejects with the transport failure rather than a blank panel (DR-019)', async () => {
    const transport = mockTransport().connectFailure()
    const thrown = await outcome(() => new Node(transport).interfaces.getAll())
    expect(thrown, 'unreachable').toBeInstanceOf(Error)
    expect((thrown as Error).message).toContain('mock scripted connection failure')
    // The read path asks for `readOnly: true`, so a retryable wire failure is re-sent once before it
    // throws — the request count is the transport's contract, not this module's, so it is not pinned here.
  })
})

describe('InterfacesResource status rows — the recorded cEOS-lab spelling wins over the sibling capture (divergence 12)', () => {
  it('the captured `interfaceStatuses` / `linkStatus` shape reads, column for column', async () => {
    const transport = configTransport(FLAT_CONFIG).replies(statusKey, labStatusReply({ Ethernet1: LAB_ROW_ETHERNET1 }))
    const rows = await new Node(transport).interfaces.getStatus()
    expect([...rows.keys()]).toEqual(['Ethernet1'])
    // Exactly what the two captures have in common plus this command's own link column. The container's
    // `bandwidth`, `duplex`, `interfaceType` and `vlanInformation` are real device data this client does
    // not model — unread columns are ignored data, not an error, and not a place to invent an `InterfaceStatus`
    // field a screen never shows (DR-032).
    expect(rows.get('Ethernet1')).toEqual({
      name: 'Ethernet1',
      description: '',
      status: 'connected',
      protocol: 'up',
    })
  })

  it('`interfaceType` is not this client\'s port class, and the capture\'s typo variant is not the link column', async () => {
    const transport = configTransport(FLAT_CONFIG).replies(statusKey, labStatusReply({ Ethernet1: LAB_ROW_ETHERNET1 }))
    const row = (await new Node(transport).interfaces.getStatus()).get('Ethernet1')
    // `EbraTestPhyPort` answers a PHY name, not the sibling capture's `ethernet`/`loopback` port class, and
    // the recording really carries both `autoNegotiateActive` and the mis-cased `autoNegotigateActive`.
    // Substituting either would be this client speaking for a column the capture never spells.
    expect(row?.hardware).toBeUndefined()
    expect(row?.mtu).toBeUndefined()
    expect(row?.status).toBe('connected')
  })

  it('a reply carrying both maps takes the recorded spelling, not the sibling\'s', async () => {
    const transport = configTransport(FLAT_CONFIG).replies(statusKey, [{}, {
      interfaceStatuses: { Ethernet1: { linkStatus: 'connected' } },
      interfaces: { Ethernet1: { interfaceStatus: 'disabled' }, Ethernet8: { interfaceStatus: 'disabled' } },
    }])
    const rows = await new Node(transport).interfaces.getStatus()
    expect([...rows.keys()]).toEqual(['Ethernet1'])
    expect(rows.get('Ethernet1')).toEqual({ name: 'Ethernet1', status: 'connected' })
  })

  it('`linkStatus` falls through to `interfaceStatus` only when the recorded column is missing or untyped', async () => {
    const transport = configTransport(FLAT_CONFIG).replies(statusKey, labStatusReply({
      Ethernet1: { linkStatus: 7, interfaceStatus: 'disabled' },
      Ethernet2: { interfaceStatus: 'disabled' },
    }))
    const rows = await new Node(transport).interfaces.getStatus()
    expect(rows.get('Ethernet1')).toEqual({ name: 'Ethernet1', status: 'disabled' })
    expect(rows.get('Ethernet2')).toEqual({ name: 'Ethernet2', status: 'disabled' })
  })

  it('an EMPTY `interfaceStatuses` map is an empty status table, distinct from an absent one', async () => {
    const transport = configTransport(FLAT_CONFIG).replies(statusKey, labStatusReply({}))
    const rows = await new Node(transport).interfaces.getStatus()
    expect(rows.size).toBe(0)
    const all = await new Node(transport).interfaces.getAll()
    expect(all.size).toBe(FLAT_ORDER.length)
    expect([...all.values()].every((entry) => entry.status === undefined)).toBe(true)
  })

  it('a lab-shaped row merges onto the config table by name (divergence 8 still holds)', async () => {
    const transport = configTransport(FLAT_CONFIG).replies(statusKey, labStatusReply({ Ethernet1: LAB_ROW_ETHERNET1 }))
    const merged = await new Node(transport).interfaces.getAll()
    expect(merged.get('Ethernet1')).toEqual({
      name: 'Ethernet1',
      kind: 'Ethernet',
      shutdown: false,
      description: 'WAN uplink',
      mtu: 9216,
      status: { name: 'Ethernet1', description: '', status: 'connected', protocol: 'up' },
    })
    // Two operational words in one record: `description`/`mtu` are the configured half, `status` is the row.
    expect(merged.get('Ethernet2')?.status).toBeUndefined()
  })

  it('the refusal names both spellings, so a shape failure says what was looked for', async () => {
    const transport = configTransport(FLAT_CONFIG).replies(statusKey, [{}, {}])
    const thrown = await outcome(() => new Node(transport).interfaces.getStatus())
    expect((thrown as Error).message).toContain('`interfaceStatuses` or `interfaces`')
    expect((thrown as Error).message).toContain('DR-043')
  })
})

describe('InterfacesResource presence verbs — interfaces.py:211-254, with DR-006\'s named verbs', () => {
  it('create enters the submode with exactly `interface <name>`, for every kind it may create', async () => {
    const transport = configTransport(FLAT_CONFIG)
    const interfaces = new Node(transport).interfaces
    const names: readonly string[] = ['Port-Channel1', 'Vlan21', 'Management1', 'Loopback2', 'Vxlan5']
    for (const name of names) scriptWrite(transport, [`interface ${name}`])
    for (const name of names) await interfaces.create(name)
    expect(sentAsText(transport)).toEqual(names.map((name) => ['enable', 'configure terminal', `interface ${name}`]))
  })

  it('create on a physical Ethernet refuses, naming the class that owns it (divergence 5)', async () => {
    const transport = configTransport(FLAT_CONFIG)
    const interfaces = new Node(transport).interfaces
    const thrown = await outcome(() => interfaces.create('Ethernet1'))
    expect(thrown).toBeInstanceOf(NotSupportedError)
    expect((thrown as Error).message).toContain("invalid create interface 'Ethernet1'")
    expect((thrown as Error).message).toContain('and not an Ethernet')
    expect((thrown as Error).message).toContain('M10b')
    expect(transport.sent()).toEqual([])
    // pyeapi pins the same refusal one class up: EthernetInterface.create raises NotImplementedError
    // (test_api_interfaces.py:211-224) — DR-006 has no class dispatch, so the refusal is in the verb.
  })

  it('create refuses every subinterface name while open item 7 is open', async () => {
    const transport = configTransport(FLAT_CONFIG)
    const interfaces = new Node(transport).interfaces
    for (const dotted of ['Ethernet1.100', 'Port-Channel1.1']) {
      const thrown = await outcome(() => interfaces.create(dotted))
      expect(thrown).toBeInstanceOf(NotSupportedError)
      expect((thrown as Error).message).toContain(`invalid create interface '${dotted}'`)
    }
    expect(transport.sent()).toEqual([])
    // Upstream's EthernetInterface *does* create `Ethernet1.1` (the same test pins the text); this client
    // waits for M12 (#14) to capture which kinds may carry a dotted header on 4.28.13.1M.
  })

  it('delete answers `no interface <name>` for the same kinds (interfaces.py:228-243)', async () => {
    const transport = configTransport(FLAT_CONFIG)
    const interfaces = new Node(transport).interfaces
    const names: readonly string[] = ['Port-Channel9', 'Vlan9', 'Management0', 'Loopback1', 'Vxlan9']
    for (const name of names) scriptWrite(transport, [`no interface ${name}`])
    for (const name of names) await interfaces.delete(name)
    expect(sentAsText(transport)).toEqual(names.map((name) => ['enable', 'configure terminal', `no interface ${name}`]))
  })

  it('delete on a physical Ethernet is refused with the delete label', async () => {
    const thrown = await outcome(() => interfacesFor(FLAT_CONFIG).delete('Ethernet2'))
    expect(thrown).toBeInstanceOf(NotSupportedError)
    expect((thrown as Error).message).toContain("invalid delete interface 'Ethernet2'")
  })

  it('setDefault is available for every kind, Ethernet included (test_api_interfaces.py:191-209)', async () => {
    const transport = configTransport(FLAT_CONFIG)
    scriptWrite(transport, ['default interface Ethernet1'])
    await new Node(transport).interfaces.setDefault('Ethernet1')
    expect(sentAsText(transport)).toEqual([['enable', 'configure terminal', 'default interface Ethernet1']])
  })

  it('setDefault still refuses the dotted and chassis forms through the shared guard (row 76)', async () => {
    const interfaces = interfacesFor(FLAT_CONFIG)
    for (const bad of ['Ethernet1.100', 'Ethernet1/1', 't1', '']) {
      const thrown = await outcome(() => interfaces.setDefault(bad))
      expect(thrown).toBeInstanceOf(NotSupportedError)
      expect((thrown as Error).message).toContain('invalid interface')
    }
  })

  it('create carries attrs inside the SAME submode transaction (M9 precedent, one round trip)', async () => {
    const transport = configTransport(FLAT_CONFIG)
    const cmds: readonly string[] = ['interface Port-Channel8', 'description spare bay', 'mtu 9216']
    scriptWrite(transport, cmds)
    await new Node(transport).interfaces.create('Port-Channel8', { description: 'spare bay', mtu: 9216 })
    expect(sentAsText(transport)).toEqual([['enable', 'configure terminal', ...cmds]])
    // Field order is the field verbs' order — description then mtu — never a re-ordered surprise, and
    // upstream needs two transactions for the same thing (create :211, then set_description :284).
  })

  it('an attrs value this client could not read back is refused before the transaction opens', async () => {
    const transport = configTransport(FLAT_CONFIG)
    const thrown = await outcome(() => new Node(transport).interfaces.create('Port-Channel8', { description: '  padded ' }))
    expect(thrown).toBeInstanceOf(NotSupportedError)
    expect((thrown as Error).message).toContain('invalid interface description')
    expect((thrown as Error).message).toContain('leading or trailing whitespace cannot read back')
    expect(transport.sent()).toEqual([])
  })

  it('no presence verb reads the config first — DR-030 scopes the budget, upstream agrees', async () => {
    const transport = configTransport(FLAT_CONFIG)
    const interfaces = new Node(transport).interfaces
    scriptWrite(transport, ['interface Port-Channel7'])
    scriptWrite(transport, ['no interface Port-Channel7'])
    scriptWrite(transport, ['default interface Port-Channel7'])
    await interfaces.create('Port-Channel7')
    await interfaces.delete('Port-Channel7')
    await interfaces.setDefault('Port-Channel7')
    expect(transport.bodies().filter((body) => body.params.cmds.some((c) => String(c) === 'show running-config all'))).toEqual([])
    expect(transport.callCount()).toBe(3)
  })

  it('a device refusal of a write rejects with CommandError, failedCommand and commands (DR-005)', async () => {
    const transport = mockTransport().rejects('configure terminal', {
      code: EapiErrorCode.COMMAND_INVALID,
      message: "CLI command 3 of 3 'no interface Port-Channel1' failed: port-channel 1 has members",
    })
    const thrown = await outcome(() => new Node(transport).interfaces.delete('Port-Channel1'))
    expect(thrown).toBeInstanceOf(CommandError)
    expect((thrown as CommandError).failedCommand).toBe('no interface Port-Channel1')
    expect((thrown as CommandError).commands).toEqual(['enable', 'configure terminal', 'no interface Port-Channel1'])
    expect((thrown as CommandError).code).toBe(EapiErrorCode.COMMAND_INVALID)
    // pyeapi answers False and parks the exception on connection.error (abstract.py:117-127); its docstring
    // has to explain that check, which is what DR-005 removes.
  })

  it('a name every guard refuses never reaches the device — four states from one seam (USAGE.md §7)', async () => {
    const transport = configTransport(FLAT_CONFIG)
    const interfaces = new Node(transport).interfaces
    for (const bad of ['Po1', 'Et1', 'Ethernet', 'Vlan', 'interface Ethernet1', 'Ethernet1 ', 'Ethernet1/1', 'Ethernet1.1']) {
      await expectRefusal(() => interfaces.create(bad), `invalid create interface '${bad}'`)
      await expectRefusal(() => interfaces.delete(bad), 'invalid delete interface')
      await expectRefusal(() => interfaces.setDefault(bad), 'invalid interface')
    }
    expect(transport.sent()).toEqual([])
  })
})

describe('InterfacesResource field writes — the command_builder families (interfaces.py:284-327 + the mtu addition)', () => {
  it('setDescription sends the exact pair upstream\'s test pins (test_api_interfaces.py:107-112)', async () => {
    const transport = configTransport(FLAT_CONFIG)
    const cmds = pair('Vlan20', 'description PROD access')
    scriptWrite(transport, cmds)
    await new Node(transport).interfaces.setDescription('Vlan20', 'PROD access')
    expect(sentAsText(transport)).toEqual([['enable', 'configure terminal', 'interface Vlan20', 'description PROD access']])
  })

  it('every kind reaches the same submode pair, since no family is kind-specific here', async () => {
    const transport = configTransport(FLAT_CONFIG)
    const interfaces = new Node(transport).interfaces
    const names: readonly string[] = ['Ethernet1', 'Port-Channel3', 'Vlan20', 'Management1', 'Loopback2', 'Vxlan5']
    for (const name of names) scriptWrite(transport, pair(name, 'description labelled'))
    for (const name of names) await interfaces.setDescription(name, 'labelled')
    expect(sentAsText(transport)).toEqual(names.map((name) => ['enable', 'configure terminal', `interface ${name}`, 'description labelled']))
  })

  it('unsetDescription / defaultDescription are the no and default arms (abstract.py:154-155 / :152-153)', async () => {
    const transport = configTransport(FLAT_CONFIG)
    transport.replies(writeKey(pair('Ethernet1', 'no description')), okFor(pair('Ethernet1', 'no description')))
    transport.replies(writeKey(pair('Ethernet1', 'default description')), okFor(pair('Ethernet1', 'default description')))
    const interfaces = new Node(transport).interfaces
    await interfaces.unsetDescription('Ethernet1')
    await interfaces.defaultDescription('Ethernet1')
    expect(sentAsText(transport)).toEqual([
      ['enable', 'configure terminal', 'interface Ethernet1', 'no description'],
      ['enable', 'configure terminal', 'interface Ethernet1', 'default description'],
    ])
  })

  it('shutdown / noShutdown / defaultShutdown are three whole commands (test_api_interfaces.py:126-142)', async () => {
    const transport = configTransport(FLAT_CONFIG)
    for (const inner of ['shutdown', 'no shutdown', 'default shutdown']) scriptWrite(transport, pair('Ethernet1', inner))
    const interfaces = new Node(transport).interfaces
    await interfaces.shutdown('Ethernet1')
    await interfaces.noShutdown('Ethernet1')
    await interfaces.defaultShutdown('Ethernet1')
    expect(sentAsText(transport)).toEqual([
      ['enable', 'configure terminal', 'interface Ethernet1', 'shutdown'],
      ['enable', 'configure terminal', 'interface Ethernet1', 'no shutdown'],
      ['enable', 'configure terminal', 'interface Ethernet1', 'default shutdown'],
    ])
  })

  it('the two intents are two named verbs, not upstream\'s `disable=True` default (DR-037)', async () => {
    // pyeapi's `set_shutdown(name)` defaults `disable=True` (interfaces.py:305), so its no-argument call
    // is the `no shutdown` arm. Nothing here takes a `{ disable }` kwarg bag, so the intent cannot invert
    // by omission — and `default shutdown` is the third arm upstream emits (:325-326).
    const transport = configTransport(FLAT_CONFIG)
    scriptWrite(transport, pair('Loopback12', 'no shutdown'))
    await new Node(transport).interfaces.noShutdown('Loopback12')
    expect(sentAsText(transport)).toEqual([['enable', 'configure terminal', 'interface Loopback12', 'no shutdown']])
  })

  it('the description refusals are reader-derived and each names its own reason', async () => {
    const transport = configTransport(FLAT_CONFIG)
    const illegal: readonly [unknown, RegExp][] = [
      ['', /an empty description is refused/],
      ['   ', /an empty description is refused/],
      ['PROD ', /leading or trailing whitespace cannot read back/],
      [' PROD', /leading or trailing whitespace cannot read back/],
      ['ing\x07rat', /control character would break/],
      ['seven"ops', /cannot round-trip/],
      [7, /expected a string description/],
      [undefined, /expected a string description/],
    ]
    for (const [value, why] of illegal) {
      const thrown = await outcome(() => new Node(transport).interfaces.setDescription('Ethernet1', value as string))
      expect(thrown, `setDescription(${String(value)})`).toBeInstanceOf(NotSupportedError)
      expect((thrown as Error).message).toContain('invalid interface description')
      expect((thrown as Error).message).toMatch(why)
    }
    expect(transport.sent()).toEqual([])
    // pyeapi interpolates whatever arrives (`:302` through command_builder), so all of these reach its
    // wire and then read back differently — which is why this client refuses rather than round-trips oddly.
  })

  it('what the refusals allow is exact: an apostrophe and inner runs round-trip without quoting', async () => {
    const transport = configTransport(FLAT_CONFIG)
    const value = "Don't  do this"
    scriptWrite(transport, pair('Management1', `description ${value}`))
    await new Node(transport).interfaces.setDescription('Management1', value)
    expect(sentAsText(transport)).toEqual([['enable', 'configure terminal', 'interface Management1', "description Don't  do this"]])
    const read = await interfacesFor(textOf(['interface Management1', `   description ${value}`, 'end'])).getAll({ status: 'skip' })
    expect(read.get('Management1')?.description).toBe(value)
    // The impl quotes nothing on the write path — it refuses everything that would need quoting instead,
    // which is the decision this file pins against the wire text rather than against EOS.
  })

  it('mtu writes the trio `mtu <n>` / `no mtu` / `default mtu` (divergence 7: no twin in interfaces.py)', async () => {
    const transport = configTransport(FLAT_CONFIG)
    for (const inner of ['mtu 1500', 'no mtu', 'default mtu']) scriptWrite(transport, pair('Ethernet1', inner))
    const interfaces = new Node(transport).interfaces
    await interfaces.setMtu('Ethernet1', 1500)
    await interfaces.unsetMtu('Ethernet1')
    await interfaces.defaultMtu('Ethernet1')
    expect(sentAsText(transport)).toEqual([
      ['enable', 'configure terminal', 'interface Ethernet1', 'mtu 1500'],
      ['enable', 'configure terminal', 'interface Ethernet1', 'no mtu'],
      ['enable', 'configure terminal', 'interface Ethernet1', 'default mtu'],
    ])
  })

  it('the client bound is a positive safe integer, so 67 and 9215/9216 are NOT refused', async () => {
    const transport = configTransport(FLAT_CONFIG)
    const interfaces = new Node(transport).interfaces
    const values: readonly number[] = [1, 67, 68, 9214, 9215, 9216, Number.MAX_SAFE_INTEGER]
    for (const value of values) scriptWrite(transport, pair('Ethernet1', `mtu ${value}`))
    for (const value of values) await interfaces.setMtu('Ethernet1', value)
    expect(sentAsText(transport).map((cmds) => String(cmds.at(-1)))).toEqual(values.map((value) => `mtu ${value}`))
    // PLAN.md §M10's "68..9214 read from show interfaces" is not encodable offline (DR-032): 68 is
    // pyeapi's IP_MTU_MIN for a *different command* (ipinterfaces.py:54-55) and 9214 appears nowhere in
    // the pinned clone, so encoding either would be the invention DR-057 names.
  })

  it('what the client does refuse, it refuses naming value and reason — including `0`, DR-037\'s trap', async () => {
    const transport = configTransport(FLAT_CONFIG)
    const interfaces = new Node(transport).interfaces
    const bad: readonly unknown[] = [0, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1500', null, undefined, true]
    for (const value of bad) {
      const thrown = await outcome(() => interfaces.setMtu('Ethernet1', value as number))
      expect(thrown, `setMtu(${String(value)})`).toBeInstanceOf(NotSupportedError)
      expect((thrown as Error).message).toContain('invalid interface mtu')
      expect((thrown as Error).message).toContain('expected a positive integer MTU')
      expect((thrown as Error).message).toContain('client-side policy')
    }
    expect(transport.sent()).toEqual([])
    // `-0` renders the pyeapi way, which is how DR-037's falsy-value case stays visible in a log line.
    const negatively = await outcome(() => interfaces.setMtu('Ethernet1', -0))
    expect(negatively).toBeInstanceOf(NotSupportedError)
    expect((negatively as Error).message).toContain('invalid interface mtu -0.0')
    // Upstream's `set_mtu(name, 0)` produced `no mtu` through `elif value:` (abstract.py:158-161) — a
    // config the operator never asked for, which is what this guard removes.
  })

  it('the device keeps authority for a client-legal MTU it dislikes (CommandError, not a client ceiling)', async () => {
    const transport = configTransport(FLAT_CONFIG).rejects(writeKey(pair('Ethernet1', 'mtu 9216')), {
      code: EapiErrorCode.COMMAND_INVALID,
      message: "CLI command 4 of 4 'mtu 9216' failed: exceeding hardware register width",
    })
    const thrown = await outcome(() => new Node(transport).interfaces.setMtu('Ethernet1', 9216))
    expect(thrown).toBeInstanceOf(CommandError)
    expect((thrown as CommandError).failedCommand).toBe('mtu 9216')
    expect((thrown as CommandError).code).toBe(EapiErrorCode.COMMAND_INVALID)
  })

  it('a field write on an interface the switch has no block for still goes to the device (no read first)', async () => {
    const transport = configTransport(FLAT_CONFIG)
    scriptWrite(transport, pair('Ethernet99', 'no shutdown'))
    await new Node(transport).interfaces.noShutdown('Ethernet99')
    expect(sentAsText(transport)).toEqual([['enable', 'configure terminal', 'interface Ethernet99', 'no shutdown']])
    // Unlike a trunk-group setter there is no lookup to fail: the name guard admits the spelling and
    // whether the port exists is the device's answer — what EOS does with it is an M12 (#14) capture.
  })

  it('the shared guard refuses every field verb on a subinterface name, but the reader still parses one', async () => {
    const { node, transport } = nodeFor(FLAT_CONFIG)
    const interfaces = node.interfaces
    for (const write of [
      () => interfaces.setMtu('Ethernet48.2044', 9216),
      () => interfaces.setDescription('Ethernet48.2044', 'labelled'),
      () => interfaces.shutdown('Ethernet48.2044'),
      () => interfaces.noShutdown('Ethernet48.2044'),
      () => interfaces.unsetMtu('Ethernet48.2044'),
    ]) {
      const thrown = await outcome(write)
      expect(thrown).toBeInstanceOf(NotSupportedError)
      expect((thrown as Error).message).toContain("invalid interface 'Ethernet48.2044'")
      expect((thrown as Error).message).toContain('with no subinterface suffix')
    }
    // Not one of those refusals read the config or reached the wire — so the empty `sent()` list is also
    // the proof that no config read happened behind a rejected write.
    expect(transport.sent()).toEqual([])
    // The reader has no such limit: a device that writes a dotted header gets its full field set back,
    // which is exactly why open item 7 has to be captured rather than guessed by widening the guard.
    const all = await interfacesFor(textOf(['interface Ethernet48.2044', '   mtu 9216', '!', 'end'])).getAll({ status: 'skip' })
    expect(all.get('Ethernet48.2044')).toEqual({ name: 'Ethernet48.2044', kind: 'Ethernet', mtu: 9216 })
  })
})

describe('InterfacesResource encapsulation — interfaces.py:256-282, the grammar replaces the prefix tests', () => {
  it('setEncapsulation sends the exact pair for a subinterface (test_api_interfaces.py:156-159)', async () => {
    const transport = configTransport(FLAT_CONFIG)
    const cmds: readonly string[] = ['interface Ethernet1.1', 'encapsulation dot1q vlan 1']
    scriptWrite(transport, cmds)
    await new Node(transport).interfaces.setEncapsulation('Ethernet1.1', 1)
    expect(sentAsText(transport)).toEqual([['enable', 'configure terminal', ...cmds]])
  })

  it('Port-Channel subinterfaces take the same verb, because the grammar says which kinds may', async () => {
    const transport = configTransport(FLAT_CONFIG)
    const cmds: readonly string[] = ['interface Port-Channel1.2', 'encapsulation dot1q vlan 40']
    scriptWrite(transport, cmds)
    await new Node(transport).interfaces.setEncapsulation('Port-Channel1.2', 40)
    expect(sentAsText(transport)).toEqual([['enable', 'configure terminal', ...cmds]])
  })

  it('unset / default keep the keyword and drop the vid, as upstream emits (:279 / :278)', async () => {
    const transport = configTransport(FLAT_CONFIG)
    for (const inner of ['no encapsulation dot1q vlan', 'default encapsulation dot1q vlan']) {
      scriptWrite(transport, ['interface Ethernet1.1', inner])
    }
    const interfaces = new Node(transport).interfaces
    await interfaces.unsetEncapsulation('Ethernet1.1')
    await interfaces.defaultEncapsulation('Ethernet1.1')
    expect(sentAsText(transport)).toEqual([
      ['enable', 'configure terminal', 'interface Ethernet1.1', 'no encapsulation dot1q vlan'],
      ['enable', 'configure terminal', 'interface Ethernet1.1', 'default encapsulation dot1q vlan'],
    ])
  })

  it('a plain Ethernet is refused — upstream\'s first NotImplementedError arm (:271-273)', async () => {
    const interfaces = interfacesFor(FLAT_CONFIG)
    await expectRefusal(() => interfaces.setEncapsulation('Ethernet1', 1), "invalid setEncapsulation interface 'Ethernet1'", 'expected an Ethernet or Port-Channel subinterface')
    await expectRefusal(() => interfaces.setEncapsulation('Port-Channel1', 1), 'setEncapsulation interface', /expected an Ethernet or Port-Channel subinterface/)
  })

  it('a wrong kind is refused — upstream\'s second arm (`name[0:2] in [Et, Po]`, :274-277)', async () => {
    const interfaces = interfacesFor(FLAT_CONFIG)
    for (const name of ['Management1', 'Loopback1.1', 'Vlan20.1', 'Vxlan1.1', 'Ethernet1/1', ' Ethernet1.1']) {
      const thrown = await outcome(() => interfaces.setEncapsulation(name, 1))
      expect(thrown).toBeInstanceOf(NotSupportedError)
      expect((thrown as Error).message).toContain('invalid setEncapsulation interface')
      expect((thrown as Error).message).toContain('expected an Ethernet or Port-Channel subinterface')
    }
    // Upstream would send `interface Vlan20.1` for one of these; here "it parsed and it has a suffix" *is*
    // its two prefix tests, so the grammar needs no follow-up prefix code.
  })

  it('the vid is a VLAN id, so assertVlanId guards it (pyeapi calls str(vid) and checks nothing, :280)', async () => {
    const transport = configTransport(FLAT_CONFIG)
    const interfaces = new Node(transport).interfaces
    for (const vid of [0, 4095, -1, 20.5, Number.NaN, '20']) {
      const thrown = await outcome(() => interfaces.setEncapsulation('Ethernet1.1', vid as number))
      expect(thrown, `vid ${String(vid)}`).toBeInstanceOf(NotSupportedError)
      expect((thrown as Error).message).toContain('invalid vlan')
      expect((thrown as Error).message).toContain('expected an integer VLAN id 1..4094')
    }
    expect(transport.sent()).toEqual([])
  })

  it('both vid bounds are accepted, since the range is inclusive of 1 and 4094', async () => {
    const transport = configTransport(FLAT_CONFIG)
    const interfaces = new Node(transport).interfaces
    const bounds: readonly (readonly [string, number])[] = [['Ethernet1.1', 1], ['Port-Channel2.3', 4094]]
    for (const [name, vid] of bounds) {
      const cmds: readonly string[] = [`interface ${name}`, `encapsulation dot1q vlan ${vid}`]
      scriptWrite(transport, cmds)
      await interfaces.setEncapsulation(name, vid)
      expect(sentAsText(transport).at(-1)).toEqual(['enable', 'configure terminal', ...cmds])
    }
  })

  it('the write round-trips: a set encapsulation is a value the reader answers back', async () => {
    const transport = mockTransport()
      .repliesOnce('enable\nshow running-config all', [{}, { output: 'end' }])
      .replies(writeKey(['interface Ethernet48.2044', 'encapsulation dot1q vlan 2044']), okFor(['interface Ethernet48.2044', 'encapsulation dot1q vlan 2044']))
      .repliesOnce('enable\nshow running-config all', [{}, { output: textOf(['interface Ethernet48.2044', '   encapsulation dot1q vlan 2044', 'end']) }])
    const interfaces = new Node(transport).interfaces
    expect((await interfaces.getAll({ status: 'skip' })).size).toBe(0)
    await interfaces.setEncapsulation('Ethernet48.2044', 2044)
    const after = await interfaces.getAll({ status: 'skip' })
    expect(after.get('Ethernet48.2044')).toEqual({ name: 'Ethernet48.2044', kind: 'Ethernet', encapsulation: 2044 })
    expect(transport.callCount()).toBe(3)
    // pyeapi's own fixture writes the same pair on `interface Ethernet48.2044`
    // (test/fixtures/running_config.text:1468 / :1473), which is why this round trip is worth pinning.
  })

  it('setEncapsulation enters the submode itself, so the shared guard never double-refuses it', async () => {
    // The verb cannot call configureInterface — whose name guard refuses the dotted form that this
    // command legitimately needs (open item 7) — and interfaces.ts states that deviation rather than
    // quietly widening a guard every other verb shares.
    const transport = configTransport(FLAT_CONFIG)
    const cmds: readonly string[] = ['interface Ethernet3.1', 'encapsulation dot1q vlan 4094']
    scriptWrite(transport, cmds)
    await new Node(transport).interfaces.setEncapsulation('Ethernet3.1', 4094)
    expect(sentAsText(transport)).toEqual([['enable', 'configure terminal', ...cmds]])
  })
})

describe('InterfacesResource wiring — one accessor per Node (DR-006/DR-052)', () => {
  it('node.interfaces is the same instance as node.resource("interfaces"), memoised per Node', async () => {
    const { node } = nodeFor(FLAT_CONFIG)
    expect(node.interfaces).toBe(node.resource('interfaces'))
    expect(node.interfaces).toBeInstanceOf(InterfacesResource)
    const other = nodeFor(FLAT_CONFIG).node
    expect(node.interfaces).not.toBe(other.interfaces)
    // Two switches, two resource objects — the module-level singleton pyeapi's import-time Config()
    // violates is what ARCHITECTURE.md §7 forbids, and the accessor is not a second cache (DR-052).
    expect((await other.interfaces.getAll({ status: 'skip' })).size).toBe(FLAT_ORDER.length)
  })

  it('the accessor reads one config round trip for the whole table, plus the optional status leg', async () => {
    const { node, transport } = nodeFor(FLAT_CONFIG)
    const interfaces = node.interfaces
    expect(interfaces).toBe(node.resource('interfaces'))
    const entries = await interfaces.entries()
    expect(entries.map(([name]) => name)).toEqual([...FLAT_ORDER])
    // One config read + one unscripted status read (auto), which is what `{ status: 'skip' }` would drop.
    expect(transport.callCount()).toBe(2)
    expect(sentAsText(transport)).toEqual([
      ['enable', 'show running-config all'],
      ['enable', 'show interfaces status'],
    ])
  })

  it('an unregistered name still throws naming what IS registered (row 79), not undefined', async () => {
    const node = nodeFor(FLAT_CONFIG).node
    expect(() => node.resource('bogus' as never)).toThrow(NotSupportedError)
    expect(() => node.resource('bogus' as never)).toThrow(/bogus/)
    expect(node.hasResource('bogus')).toBe(false)
    expect(node.hasResource('interfaces')).toBe(true)
  })

  it('the reads this module performs are the running-config and `show interfaces status` — nothing else', async () => {
    const transport = configTransport(FLAT_CONFIG).replies(statusKey, statusReply({ Ethernet1: { interfaceStatus: 'connected' } }))
    const interfaces = new Node(transport).interfaces
    expect((await interfaces.getAll()).size).toBe(FLAT_ORDER.length)
    expect((await interfaces.getStatus()).size).toBe(1)
    expect(sentAsText(transport)).toEqual([
      ['enable', 'show running-config all'],
      ['enable', 'show interfaces status'],
      ['enable', 'show interfaces status'],
    ])
    // `configSections` is a protected `ResourceBase` read (base.ts) — the startup-config seam lives on the
    // base and is pinned there by base.test.ts, so no read option is invented on this module's verbs.
  })
})
