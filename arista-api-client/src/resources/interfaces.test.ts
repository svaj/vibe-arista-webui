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
 *  - `TestApiEthernetInterface.test_instance_functions` (`:191-209`) and
 *    `test_instance_functions_exceptions` (`:211-224`) — `interface X`, `no interface X`,
 *    `default interface Ethernet1`, and Ethernet create/delete refused for the **physical** name
 *    (divergence 5: M10a landed the refusal naming M10b as the owner; M10b (#12) then composed the
 *    dotted form upstream itself pins, so the refusal now covers only `Ethernet1`-shaped names).
 *  - MTU: **no upstream twin in this module** — `interfaces.py` has no MTU verb — so every bound asserted
 *    below is this client's (divergence 7), with the device keeping authority via a pinned `CommandError`.
 *
 * The **M10b/M10c** groups at the end of this file (#12, second round) port the two remaining classes:
 * `TestApiEthernetInterface` (`:174-303`, **14** methods — `test_get` `:183-189`, `test_instance_functions`
 * `:191-209`, `test_instance_functions_exceptions` `:211-224`, the six flow-control tests `:225-267`, the
 * four sFlow tests `:269-295`, `test_set_vrf` `:297-302`) and `TestApiPortchannelInterface` (`:305-428`,
 * **19** methods — `test_get` `:318-326`, the four min-links tests `:328-348`, `test_set_lacp_timeout_with_value`
 * `:350-354`, the four fallback tests `:356-374`, `test_get_lacp_mode` `:375-377`, `test_get_members`
 * `:379-381`, the five `test_set_members_*` `:383-414`, `test_set_lacp_mode` `:416-422`,
 * `test_set_lacp_mode_invalid_mode` `:424-426`). 20 + 33 + 19 = 72. `TestApiVxlanInterface`
 * (class at `:429`, methods `:436-531`, **19** strong — the wave-3 handoff's `:434-:529` band was
 * re-measured by grep on 2026-11-07 and is off at both ends) is ported by the **M10d** groups at the
 * very end of this file (#52): `test_get` `:436-442` (which pins only the ten-key set), the four writer
 * trios (`set_source_interface` `:443-457`, `set_multicast_group` `:458-472`, `set_multicast_decap`
 * `:473-487`, `set_udp_port` `:488-502`), `test_update_vlan` `:503-507`, `test_remove_vlan` `:508-512`
 * (whose pinned text passes upstream only because `testlib.py:97-107` accepts ANY `CliVariants.expand`-ed
 * spelling — the variant tests below pin the ordered transactions upstream's suite cannot see), and the
 * four VTEP pins `:513-531`. Upstream's fixture `test/fixtures/running_config.vxlan` (50 lines, body
 * indent three spaces) is quoted **byte-exactly** in `VXLAN_FIXTURE` at the foot of this file —
 * labelled a verbatim pyeapi test-material copy, not a device capture — while its sibling
 * `test/fixtures/vxlan.json` exists upstream but is referenced by **no** upstream test (grep 2026-11-07,
 * the only hit is `.git/index`), has no reader in this module, and is not ported. Every command text
 * those classes pin is reproduced
 * verbatim below, with upstream's own fixture lines quoted where a read is involved
 * (`running_config.portchannel:18`/`:19`/`:20`/`:147`/`:278`, `running_config.text:550`/`:551`/`:652`,
 * `show_portchannel.json`'s `Active Ports` block) — each re-opening of the pinned clone on 2026-11-05.
 * Two claims in the earlier draft of this file's prose did **not** survive that re-reading and are corrected
 * in `interfaces.ts` / MIGRATION.md row 127 alongside these specs: upstream's `test_get` `sflow: True` for
 * `interface Ethernet1` is **not** a section with no sFlow line (`sflow enable` sits at
 * `running_config.text:652`, inside the `:542-675` range cited), and `_parse_sflow`'s answer is the
 * assignment at `:378` (`value = 'no sflow' not in config`), not the `return` at `:379`. The fabricated
 * `true` is pinned here against a config of our own instead of against that fixture.
 *
 * Upstream drives all of it through `EapiConfigUnitTest`, whose `MockConnection` answers `{}` to anything
 * it was not told about. Here an unscripted request is a loud failure and (`testing/mock-transport.ts:83-88`)
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
import {
  FLOWCONTROL_DIRECTIONS,
  FLOWCONTROL_VALUES,
  INTERFACE_STATUS_COMMAND,
  InterfacesResource,
  LACP_FALLBACK_MODES,
  LACP_MODES,
  membersFromOutput,
  type FlowcontrolDirection,
  type FlowcontrolValue,
  type Interface,
  type InterfaceStatusMode,
  type InterfacesReadOptions,
  type LacpFallbackMode,
  type LacpMode,
} from './interfaces'
import type { ResourceTable } from './types'
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
    await expectRefusal(() => interfaces.delete('Ethernet0010'), "invalid delete interface 'Ethernet0010'", 'expected a non-Ethernet name with no subinterface suffix')
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
    expect((thrown as Error).message).toContain('expected a non-Ethernet name with no subinterface suffix')
    expect((thrown as Error).message).toContain('NotImplementedError')
    // pyeapi pins the same refusal one class up: EthernetInterface.create raises NotImplementedError
    // (test_api_interfaces.py:211-224) — DR-006 has no class dispatch, so the refusal is in the verb.
    // M10b (#12) is the slice that landed: the refusal is now the **physical** form only (divergence 5),
    // and the dotted form below is what upstream's own positive pin sends.
    expect(transport.sent()).toEqual([])
  })

  it('create/delete compose the Ethernet SUBINTERFACE form, which is what upstream\'s own pins send (interfaces.py:429/445)', async () => {
    const transport = configTransport(FLAT_CONFIG)
    const interfaces = new Node(transport).interfaces
    for (const cmds of [['interface Ethernet1.100'], ['no interface Ethernet1.100']]) scriptWrite(transport, cmds)
    await interfaces.create('Ethernet1.100')
    await interfaces.delete('Ethernet1.100')
    expect(sentAsText(transport)).toEqual([
      ['enable', 'configure terminal', 'interface Ethernet1.100'],
      ['enable', 'configure terminal', 'no interface Ethernet1.100'],
    ])
    // test_api_interfaces.py:191-209 pins exactly this pair for `intf + '.1'`; the dotted form is
    // accepted here only for Ethernet, because that is the kind whose class carries the rule.
  })

  it('create refuses a dotted name of any OTHER kind while open item 7 stays open', async () => {
    const transport = configTransport(FLAT_CONFIG)
    const interfaces = new Node(transport).interfaces
    for (const dotted of ['Port-Channel1.1', 'Vlan1.1']) {
      const thrown = await outcome(() => interfaces.create(dotted))
      expect(thrown).toBeInstanceOf(NotSupportedError)
      expect((thrown as Error).message).toContain(`invalid create interface '${dotted}'`)
      expect((thrown as Error).message).toContain('a dotted name of any other kind stays refused')
    }
    expect(transport.sent()).toEqual([])
    // No upstream class composes a dotted header for these kinds, and which kinds may carry one on
    // 4.28.13.1M is still an M12 (#14) capture (open item 7).
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
    for (const bad of ['Po1', 'Et1', 'Ethernet', 'Vlan', 'interface Ethernet1', 'Ethernet1 ', 'Ethernet1/1', 'Port-Channel1.1', 'Nope1']) {
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

// ====================================================================================================
// M10b / M10c (#12): `EthernetInterface` (`interfaces.py:330-577`) and `PortchannelInterface`
// (`:578-813`). Command texts and fixture lines below are re-read from the pinned clone on 2026-11-05;
// upstream's `ValueError`/`return False` bad-input answers land here as typed refusals (divergence 17,
// DR-077) and its invented read defaults (`0` / `'disabled'` / `90` / `'off'` / `sflow True`) as absence
// (divergence 13/16, DR-076), each pinned next to the upstream line it replaces.
// ====================================================================================================

/** The one `show version` read behind the VRF keyword choice (`vrfKeyword`, one memoised call per Node). */
const versionKey = 'enable\nshow version'

/** Script a version answer with BOTH fields `parseVersionProperties` requires (a missing one is a `ProtocolError`). */
const versionReply = (version: string): MockReply => [{}, { version, modelName: 'DCS-7050TX-64' }]

/**
 * A `show port-channel <id> all-ports` **text** body. The two-port form is pyeapi's capture verbatim —
 * `test/fixtures/show_portchannel.json`: `"Port Channel Port-Channel1:\n  Active Ports: Ethernet5 Ethernet6 \n"`
 * (trailing space included, which is why this is built rather than written as a literal) — and the other
 * arities are hand-authored in that same layout. None of it is a claim about what a 7050TX-64 prints
 * (DR-043): the expression that reads it is pyeapi's own (`:674-675`), ported verbatim as
 * {@link membersFromOutput}.
 */
const activePortsText = (ports: readonly string[]): string => `Port Channel Port-Channel1:\n  Active Ports: ${ports.map((port) => `${port} `).join('')}\n`

/** Script a running-config plus the live `show port-channel <gid> all-ports` text the LAG verbs read. */
function lagTransport(config: string, ports: readonly string[], gid = '1'): MockTransport {
  return mockTransport()
    .replies('enable\nshow running-config all', [{}, { output: config }])
    .replies(`enable\nshow port-channel ${gid} all-ports`, [{}, { output: activePortsText(ports) }])
}

/** Members E5/E6 with the fixture's own relation lines (`running_config.portchannel:147` / `:278`) and the group section. */
const LAG_CONFIG = textOf([
  'interface Port-Channel1',
  '   no shutdown',
  '!',
  'interface Ethernet5',
  '   channel-group 1 mode on',
  '!',
  'interface Ethernet6',
  '   channel-group 1 mode on',
  '!',
  'end',
])

/** Members the device reports but whose config lines name no mode — the shape upstream hands `mode None` to the wire (`:712-714`). */
const LAG_MEMBERS_WITHOUT_MODE = textOf([
  'interface Port-Channel1',
  '   no shutdown',
  '!',
  'interface Ethernet5',
  '   channel-group 1',
  '!',
  'interface Ethernet6',
  '   channel-group 1',
  '!',
  'end',
])

/** Read one config as a one-read table (no status leg), the shape every read spec below asserts against. */
async function readTable(config: string): Promise<ResourceTable<string, Interface>> {
  return interfacesFor(config).getAll({ status: 'skip' })
}

describe('InterfacesResource Ethernet field reads — M10b: interfaces.py:335-414 plus the VRF read this client adds (divergence 16, DR-076)', () => {
  it('the two sFlow command lines answer true/false as whole body commands', async () => {
    const on = await readTable(textOf(['interface Ethernet1', '   sflow enable', 'end']))
    expect(on.get('Ethernet1')).toEqual({ name: 'Ethernet1', kind: 'Ethernet', ethernet: { sflow: true } })
    const off = await readTable(textOf(['interface Ethernet1', '   no sflow enable', 'end']))
    expect(off.get('Ethernet1')).toEqual({ name: 'Ethernet1', kind: 'Ethernet', ethernet: { sflow: false } })
    // `sflow enable` is what the fixture writes inside its interface sections (`running_config.text:652`
    // inside `interface Ethernet1`, and the global block's `sflow sample 1048576`/`no sflow source` at
    // `:261-266`), so both command words here are device text rather than this client's vocabulary.
  })

  it('neither line means ABSENT — never the `true` upstream\'s substring rule invents (:378)', async () => {
    const all = await readTable(textOf(['interface Ethernet1', '   no shutdown', 'end']))
    expect(all.get('Ethernet1')).toEqual({ name: 'Ethernet1', kind: 'Ethernet', shutdown: false })
    // `_parse_sflow` is `value = 'no sflow' not in config` (`:367-379`, the assignment at `:378`), so a
    // section carrying no sFlow line at all reads `sflow: True`. Upstream's own `test_get` (`:183-189`) is
    // NOT the proof of that — the fixture section it reads really does carry `sflow enable`
    // (`running_config.text:652`), which is why its `sflow: True` is a real line answering. The rule is
    // what is ported-not, and it is pinned here against a config of our own (DR-029/DR-057).
  })

  it('a near-miss sFlow line never answers, although the substring rule says it should (:378)', async () => {
    const all = await readTable(textOf([
      'interface Ethernet1',
      '   sflow sample 1048576',
      '   sflow polling-interval 2',
      '   no sflow source',
      '   description no sflow in prose',
      'end',
    ]))
    expect(all.get('Ethernet1')).toEqual({ name: 'Ethernet1', kind: 'Ethernet', description: 'no sflow in prose' })
    // Four body lines copied from the pinned fixture's global sFlow block (`running_config.text:261-266`),
    // and every one of them makes upstream answer `false` for the interface — the description line included,
    // since `'no sflow'` is searched across the whole block (`:378`).
  })

  it('both sFlow forms in one block: device order answers, no rule is invented', async () => {
    const offFirst = await readTable(textOf(['interface Ethernet1', '   no sflow enable', '   sflow enable', 'end']))
    expect(offFirst.get('Ethernet1')?.ethernet).toEqual({ sflow: false })
    const onFirst = await readTable(textOf(['interface Ethernet1', '   sflow enable', '   no sflow enable', 'end']))
    expect(onFirst.get('Ethernet1')?.ethernet).toEqual({ sflow: true })
  })

  it('flow-control: a negated line is ABSENT, not upstream\'s hard-coded \'off\' (:392, :398)', async () => {
    const all = await readTable(textOf(['interface Ethernet1', '   no flowcontrol send', '   no flowcontrol receive', 'end']))
    expect(all.get('Ethernet1')).toEqual({ name: 'Ethernet1', kind: 'Ethernet' })
    // Exactly the two lines the fixture writes in `interface Ethernet1` (`running_config.text:550-551`),
    // where upstream's `_parse_flowcontrol_send`/`_parse_flowcontrol_receive` answer `'off'` because their
    // regex needs a value after the keyword and their default is a module constant — so `no …`,
    // `default …` and "line absent" all collapse to the same answer there. Its `test_get` (`:183-189`)
    // pins that collapse; here the three states stay three states.
  })

  it('flow-control values read the word behind the keyword, per direction', async () => {
    const all = await readTable(textOf(['interface Ethernet1', '   flowcontrol send on', '   flowcontrol receive off', 'end']))
    expect(all.get('Ethernet1')?.ethernet).toEqual({ flowcontrolSend: 'on', flowcontrolReceive: 'off' })
  })

  it('the reader reports a word the writer refuses, so a read is never coerced into the writer\'s pair', async () => {
    // The line is deliberately synthetic — EOS's own pair is `on|off` and nothing here claims the device
    // writes otherwise. What is pinned is the division of labour (DR-059/DR-069): the reader answers what
    // the section says, and the write guard is the only place `on|off` is enforced. Upstream's regex
    // (`flowcontrol send (\w+)$`, `:393`) answers the same token, then refuses to let it be written back.
    const all = await readTable(textOf(['interface Ethernet1', '   default flowcontrol send', '   flowcontrol send', '   flowcontrol receive asymmetric', 'end']))
    expect(all.get('Ethernet1')?.ethernet).toEqual({ flowcontrolReceive: 'asymmetric' })
    await expectRefusal(() => interfacesFor('').setFlowcontrol('Ethernet1', 'receive', 'asymmetric' as FlowcontrolValue), 'invalid flowcontrol value', /expected one of on \/ off/)
  })

  it('a longer word beginning with the keyword does not answer (the keyword boundary, config-block.ts)', async () => {
    const all = await readTable(textOf(['interface Ethernet1', '   flowcontrol sends on', '   sflow-enabled x', 'end']))
    expect(all.get('Ethernet1')).toEqual({ name: 'Ethernet1', kind: 'Ethernet' })
  })

  it('the VRF binding reads back although upstream has no reader for it at all (divergence 14)', async () => {
    const forwarding = await readTable(textOf(['interface Ethernet1', '   vrf forwarding MGMT', 'end']))
    expect(forwarding.get('Ethernet1')?.ethernet).toEqual({ vrf: 'MGMT' })
    // `vrf DAT` is the fixture's 4.13-era single-keyword line (`running_config.text:1475`, inside
    // `interface Ethernet48.2044` at `:1468`), and `vrf default` at `:2130`/`:2189` is the same shape in a
    // non-interface section — both forms this client's own `setVrf` composes (divergence 18) read back.
    const bare = await readTable(textOf(['interface Ethernet4', '   vrf DAT', 'end']))
    expect(bare.get('Ethernet4')?.ethernet).toEqual({ vrf: 'DAT' })
  })

  it('an absent or malformed VRF line answers nothing, never the default VRF\'s name (open item 2\'s family)', async () => {
    const all = await readTable(textOf(['interface Ethernet1', '   vrf', '   vrflite MGMT', 'end']))
    expect(all.get('Ethernet1')).toEqual({ name: 'Ethernet1', kind: 'Ethernet' })
    // `vrf default` reading back as `'default'` would be a claim about what 4.28.13.1M writes for a port in
    // the default VRF — that is a device capture (DECISIONS.md open item 2's VRF-licensing family), not an
    // inference from a line this reader happens to see elsewhere.
  })

  it('the field group is kind-gated: only an Ethernet section carries it', async () => {
    const vlan = await readTable(textOf(['interface Vlan20', '   vrf MGMT', '   sflow enable', '   flowcontrol send on', 'end']))
    expect(vlan.get('Vlan20')).toEqual({ name: 'Vlan20', kind: 'Vlan' })
    const chassis = await readTable(textOf(['interface Ethernet1/1', '   vrf MGMT', '   sflow enable', 'end']))
    expect(chassis.get('Ethernet1/1')).toEqual({ name: 'Ethernet1/1', kind: null })
    // A header this grammar cannot read keeps its row with `kind: null` (divergence 2) and no field group —
    // the group is attached by what the name *is*, which is also why upstream's class dispatch
    // (`interface[0:2]`, `:120-127`) is not needed here (DR-068).
  })

  it('one group object, every found field inside it (DR-068: fields, never per-kind objects)', async () => {
    const all = await readTable(textOf([
      'interface Ethernet1',
      '   no sflow enable',
      '   flowcontrol send on',
      '   flowcontrol receive on',
      '   vrf MGMT',
      'end',
    ]))
    expect(all.get('Ethernet1')?.ethernet).toEqual({ sflow: false, flowcontrolSend: 'on', flowcontrolReceive: 'on', vrf: 'MGMT' })
    expect(Object.keys(all.get('Ethernet1') ?? {}).sort()).toEqual(['ethernet', 'kind', 'name'])
  })
})

describe('InterfacesResource Port-Channel field reads — M10c: the channel-group relation plus this section\'s own LAG lines (DR-075/076/079)', () => {
  it('members come from the members\' own `channel-group` lines, from ONE config read (divergence 15)', async () => {
    const { node, transport } = nodeFor(LAG_CONFIG)
    const all = await node.interfaces.getAll({ status: 'skip' })
    expect(all.get('Port-Channel1')?.portChannel).toEqual({ members: ['Ethernet5', 'Ethernet6'], lacpMode: 'on' })
    expect(all.get('Ethernet5')?.portChannel).toBeUndefined()
    expect(transport.callCount()).toBe(1)
    expect(sentAsText(transport)).toEqual([['enable', 'show running-config all']])
    // Upstream gets the same two names — but from a **text scrape** of `show port-channel 1 all-ports`
    // (`:660-675`), a second device read it pays for in `get` (`:611`) as well; its own `test_get`
    // (`:318-326`) pins `members: ['Ethernet5','Ethernet6']` from that scrape against
    // `show_portchannel.json`. Here the read is the config the members already show, which is also where
    // upstream's `get_lacp_mode` looks (`:655-658`), and the live scrape stays a separate verb.
  })

  it('members keep running-config order, and a member whose section repeats the line joins once', async () => {
    const all = await readTable(textOf([
      'interface Port-Channel1',
      '   no shutdown',
      '!',
      'interface Ethernet6',
      '   channel-group 1 mode on',
      '!',
      'interface Ethernet5',
      '   channel-group 1 mode on',
      '   channel-group 1 mode on',
      '!',
      'end',
    ]))
    expect(all.get('Port-Channel1')?.portChannel).toEqual({ members: ['Ethernet6', 'Ethernet5'], lacpMode: 'on' })
  })

  it('the group id is the decimal run exactly as written on both sides (upstream\'s extraction, :671/:699/:734)', async () => {
    const all = await readTable(textOf([
      'interface Port-Channel0001',
      '   no shutdown',
      '!',
      'interface Ethernet1',
      '   channel-group 0001 mode active',
      '!',
      'interface Ethernet2',
      '   channel-group 1 mode active',
      '!',
      'end',
    ]))
    expect(all.get('Port-Channel0001')?.portChannel).toEqual({ members: ['Ethernet1'], lacpMode: 'active' })
    // Whether EOS normalises `Port-Channel0001` and `channel-group 1` into one group is a device question
    // (M12, #14); the client deliberately keeps the token parity upstream's `%s` interpolation has.
  })

  it('a relation naming a group the config has no section for invents no entry, and a memberless group gets no fields', async () => {
    const all = await readTable(textOf([
      'interface Port-Channel1',
      '   no shutdown',
      '!',
      'interface Ethernet1',
      '   channel-group 2 mode active',
      '!',
      'end',
    ]))
    expect(all.get('Port-Channel1')).toEqual({ name: 'Port-Channel1', kind: 'Port-Channel', shutdown: false })
    expect(all.has('Port-Channel2')).toBe(false)
    expect([...all.keys()]).toEqual(['Port-Channel1', 'Ethernet1'])
  })

  it('only Ethernet sections feed a group, so a Vlan or an unreadable header cannot be a member', async () => {
    const all = await readTable(textOf([
      'interface Port-Channel1',
      '   port-channel min-links 3',
      '!',
      'interface Vlan20',
      '   channel-group 1 mode active',
      '!',
      'interface Ethernet1/1',
      '   channel-group 1 mode active',
      '!',
      'end',
    ]))
    expect(all.get('Port-Channel1')?.portChannel).toEqual({ minimumLinks: 3 })
    expect(all.get('Vlan20')?.portChannel).toBeUndefined()
    // The members array would be a claim about a LAG this client cannot even name in a write verb
    // (`assertPortChannelName`'s grammar), which is why the kind gate is the reader's too (row 128).
  })

  it('the first member line naming a mode wins, and every member is scanned (contrast :655-658)', async () => {
    const all = await readTable(textOf([
      'interface Port-Channel1',
      '   no shutdown',
      '!',
      'interface Ethernet5',
      '   channel-group 1 mode active',
      '!',
      'interface Ethernet6',
      '   channel-group 1 mode passive',
      '!',
      'end',
    ]))
    expect(all.get('Port-Channel1')?.portChannel).toEqual({ members: ['Ethernet5', 'Ethernet6'], lacpMode: 'active' })
    // Upstream `return`s inside its FIRST loop iteration (`:655-658`), so a second member's contradicting
    // mode is never looked at; here both members are in `members` and the mode is the first one the device
    // wrote, which is the statement the config actually supports.
  })

  it('a channel-group mode outside LACP_MODES is reported, not published as a mode (DR-079)', async () => {
    const thrown = await outcome(() => readTable(textOf([
      'interface Port-Channel1',
      '   no shutdown',
      '!',
      'interface Ethernet5',
      '   channel-group 1 mode fast',
      '!',
      'end',
    ])))
    expect(thrown).toBeInstanceOf(ConfigParseError)
    expect((thrown as Error).message).toContain("interfaces: cannot read the channel-group mode in 'interface Ethernet5'")
    expect((thrown as Error).message).toContain("'fast' is not one of active / passive / on")
    expect(LACP_MODES).toEqual(['active', 'passive', 'on'])
    // Upstream hands the raw word back unchecked (`:656-658`) and writes an unchecked word to the wire in
    // `set_members` (`:712-714`), so its `mode` can be anything — a table here cannot show a mode its own
    // LACP verbs would refuse, or carry it into the next rewrite (row 129).
  })

  it('a `channel-group <id>` with no mode word contributes a member and no mode (the members read survives it)', async () => {
    const all = await readTable(LAG_MEMBERS_WITHOUT_MODE)
    expect(all.get('Port-Channel1')?.portChannel).toEqual({ members: ['Ethernet5', 'Ethernet6'] })
    // EOS's own syntax carries a mode, so this shape is a tolerated reading rather than a claimed device
    // spelling (M12, #14, to capture what a memberless-mode config looks like). It is pinned because
    // `setMembers` behaves differently in exactly this state — see the `mode None` refusal below.
  })

  it('min-links: the value line answers, and the `no`/`default`/absent forms answer nothing (upstream\'s 0, :618-623)', async () => {
    const set = await readTable(textOf(['interface Port-Channel1', '   port-channel min-links 2', 'end']))
    expect(set.get('Port-Channel1')?.portChannel).toEqual({ minimumLinks: 2 })
    for (const line of ['   no port-channel min-links', '   default port-channel min-links']) {
      const all = await readTable(textOf(['interface Port-Channel1', line, 'end']))
      expect(all.get('Port-Channel1')).toEqual({ name: 'Port-Channel1', kind: 'Port-Channel' })
    }
    // `no port-channel min-links` is the fixture's own line (`running_config.portchannel:18`), which
    // upstream reads back as the invented `minimum_links: 0` — the same answer as a section that never
    // mentions the command. Upstream's `test_get` (`:322`) pins that invented 0 (row 126).
  })

  it('lacp fallback: individual/static read verbatim; the `no`, bare, and near-miss forms read nothing', async () => {
    for (const [line, expected] of [
      ['   port-channel lacp fallback individual', 'individual'],
      ['   port-channel lacp fallback static', 'static'],
      ['   port-channel lacp fallback\tindividual', 'individual'],
    ] as const) {
      const all = await readTable(textOf(['interface Port-Channel1', line, 'end']))
      expect(all.get('Port-Channel1')?.portChannel, line).toEqual({ lacpFallback: expected })
    }
    for (const line of [
      '   no port-channel lacp fallback',
      '   default port-channel lacp fallback',
      '   port-channel lacp fallback',
      '   port-channel lacp fallbackxyz individual',
    ]) {
      const all = await readTable(textOf(['interface Port-Channel1', line, 'end']))
      expect(all.get('Port-Channel1'), line).toEqual({ name: 'Port-Channel1', kind: 'Port-Channel' })
    }
    // The last two lines of the table are the two arms the reader has to distinguish: a bare keyword and a
    // near-miss word are not values, and the `timeout` sub-command's line must not report the mode
    // `'timeout 90'` — while the SAME line is honestly the timeout field, which the next spec pins.
    const timeoutLine = await readTable(textOf(['interface Port-Channel1', '   port-channel lacp fallback timeout 90', 'end']))
    expect(timeoutLine.get('Port-Channel1')?.portChannel).toEqual({ lacpTimeout: 90 })
    // `no port-channel lacp fallback` is the fixture's line (`running_config.portchannel:19`) that upstream
    // reads as the module constant `'disabled'` (`:625-631` + `:68`, pinned at `test_api_interfaces.py:323`),
    // and `port-channel lacp fallback timeout 90` (`:20`) is the line that reader must NOT treat as the mode
    // `timeout 90` — hence the keyword-boundary and `timeout`-skip arms below.
  })

  it('the fallback value and its timeout are different fields read from different lines', async () => {
    const all = await readTable(textOf(['interface Port-Channel1', '   port-channel lacp fallback static', '   port-channel lacp fallback timeout 4', 'end']))
    expect(all.get('Port-Channel1')?.portChannel).toEqual({ lacpFallback: 'static', lacpTimeout: 4 })
    const bareTimeout = await readTable(textOf(['interface Port-Channel1', '   port-channel lacp fallback timeout', 'end']))
    expect(bareTimeout.get('Port-Channel1')).toEqual({ name: 'Port-Channel1', kind: 'Port-Channel' })
    expect(LACP_FALLBACK_MODES).toEqual(['individual', 'static'])
  })

  it('lacp fallback timeout: the line answers, absence answers nothing (upstream\'s 90, :632-637)', async () => {
    const all = await readTable(textOf(['interface Port-Channel1', '   port-channel lacp fallback timeout 90', 'end']))
    expect(all.get('Port-Channel1')?.portChannel).toEqual({ lacpTimeout: 90 })
    const none = await readTable(textOf(['interface Port-Channel1', '   no shutdown', 'end']))
    expect(none.get('Port-Channel1')).toEqual({ name: 'Port-Channel1', kind: 'Port-Channel', shutdown: false })
    // The 90 read above is honest — it is the fixture's own line (`running_config.portchannel:20`). The
    // invented 90 is `DEFAULT_LACP_FALLBACK_TIMEOUT` (`:69`) standing in for a section that writes nothing,
    // which is what upstream's `test_get` pins at `:323`; here "the switch wrote 90" and "the client
    // guessed 90" remain different statements (DR-029/DR-076).
  })

  it('a non-decimal min-links or timeout is a parse failure naming section and keyword (DR-059, no truncation)', async () => {
    for (const [keyword, line] of [['port-channel min-links', '   port-channel min-links 2.5'], ['port-channel lacp fallback timeout', '   port-channel lacp fallback timeout nine']] as const) {
      const thrown = await outcome(() => readTable(textOf(['interface Port-Channel1', line, 'end'])))
      expect(thrown, keyword).toBeInstanceOf(ConfigParseError)
      expect((thrown as Error).message).toContain(`interfaces: cannot read '${keyword}' in 'interface Port-Channel1'`)
      expect((thrown as Error).message).toContain('not a decimal number')
    }
    const huge = await outcome(() => readTable(textOf(['interface Port-Channel1', '   port-channel min-links 999999999999999999999', 'end'])))
    expect(huge).toBeInstanceOf(ConfigParseError)
    expect((huge as Error).message).toContain('cannot hold as an integer index')
  })

  it('a full Port-Channel record: the group facts and the section\'s own lines in one object', async () => {
    const all = await readTable(textOf([
      'interface Port-Channel1',
      '   description ops bay',
      '   no shutdown',
      '   port-channel min-links 2',
      '   port-channel lacp fallback individual',
      '   port-channel lacp fallback timeout 90',
      '!',
      'interface Ethernet5',
      '   channel-group 1 mode active',
      '!',
      'end',
    ]))
    expect(all.get('Port-Channel1')).toEqual({
      name: 'Port-Channel1',
      kind: 'Port-Channel',
      shutdown: false,
      description: 'ops bay',
      portChannel: { members: ['Ethernet5'], lacpMode: 'active', minimumLinks: 2, lacpFallback: 'individual', lacpTimeout: 90 },
    })
  })

  it('the config relation and the live scrape can disagree, and both stay visible (divergence 15)', async () => {
    const transport = lagTransport(LAG_CONFIG, ['Ethernet7'])
    const interfaces = new Node(transport).interfaces
    const all = await interfaces.getAll({ status: 'skip' })
    expect(all.get('Port-Channel1')?.portChannel?.members).toEqual(['Ethernet5', 'Ethernet6'])
    expect(await interfaces.getMembers('Port-Channel1')).toEqual(['Ethernet7'])
    expect(sentAsText(transport)).toEqual([
      ['enable', 'show running-config all'],
      ['enable', 'show port-channel 1 all-ports'],
    ])
    // "What the running-config declares" and "what the switch reports the LAG holds" are different facts,
    // and a review screen has to be able to show them out of agreement rather than have one overwrite the
    // other (DR-075). The record reads never issue the show — the second request here is the explicit verb.
  })

  it('an indented channel-group line inside a sub-mode joins the group (divergence 10\'s shared limitation)', async () => {
    const all = await readTable(textOf([
      'interface Port-Channel1',
      '   no shutdown',
      '!',
      'interface Ethernet7',
      '   some sub-mode',
      '      channel-group 1 mode active',
      '!',
      'end',
    ]))
    expect(all.get('Port-Channel1')?.portChannel).toEqual({ members: ['Ethernet7'], lacpMode: 'active' })
    // `ConfigLine.indent` is deliberately unfiltered, exactly as pyeapi's `get_block` + `re.search` reach
    // into a nested block (`:655-658`). Whether interface sub-modes carry these commands is M12's capture;
    // if they do, the fix is one indent bound in `config-block.ts` for every module (divergence 10).
  })
})

describe('InterfacesResource sFlow writes — EthernetInterface.set_sflow (interfaces.py:526-548, tests :269-295)', () => {
  it('the three arms are three verbs, each sending the text upstream pins (:269-278, :286-290)', async () => {
    const transport = configTransport(FLAT_CONFIG)
    for (const inner of ['sflow enable', 'no sflow enable', 'default sflow enable']) scriptWrite(transport, pair('Ethernet1', inner))
    const interfaces = new Node(transport).interfaces
    await interfaces.setSflow('Ethernet1')
    await interfaces.unsetSflow('Ethernet1')
    await interfaces.defaultSflow('Ethernet1')
    expect(sentAsText(transport)).toEqual([
      ['enable', 'configure terminal', 'interface Ethernet1', 'sflow enable'],
      ['enable', 'configure terminal', 'interface Ethernet1', 'no sflow enable'],
      ['enable', 'configure terminal', 'interface Ethernet1', 'default sflow enable'],
    ])
    // Upstream reaches `no sflow enable` by THREE call spellings — `value=False` (`:269-278` pins that arm),
    // no value at all (the deprecated `'no %s'` fall-through at `abstract.py:160-161`, pinned at `:280-284`),
    // and `disable=True` — and its only guard (`if value not in [True, False, None]: raise ValueError`,
    // `:542-543`) is a **bare** raise carrying no message at all. DR-037/DR-077 make that one name per
    // intent, with a refusal that says what was wrong.
    expect(transport.callCount()).toBe(3)
  })

  it('a non-Ethernet name is refused by every sFlow verb, naming the class that owns them (row 128)', async () => {
    const transport = configTransport(FLAT_CONFIG)
    const interfaces = new Node(transport).interfaces
    const wrong: readonly string[] = ['Vlan22', 'Port-Channel3', 'Management1', 'Loopback2', 'Vxlan5', 'Ethernet1/1', 'Ethernet1.100', 'Po1', 'Ethernet']
    for (const name of wrong) {
      for (const verb of ['setSflow', 'unsetSflow', 'defaultSflow'] as const) {
        await expectRefusal(() => interfaces[verb](name), `invalid ${verb} interface`)
      }
      await expectRefusal(() => interfaces.setSflow(name), 'invalid setSflow interface', 'expected a plain `Ethernet<digits>` name')
    }
    expect(transport.sent()).toEqual([])
    // Upstream's facade would route the four other kinds to a `BaseInterface` with no such method —
    // `AttributeError` (`:120-127` + `INTERFACE_CLASS_MAP` `:1093-1097`, pinned at `:89-91`) — while its
    // **instance** tests happily drive `set_sflow` over `Vlan1234`, `Management1`, `Port-Channel1` and
    // `Vxlan1` (the module-level `INTERFACES`, `test_api_interfaces.py:44-45`, feeding `:280`/`:286`/`:292`)
    // and over `Ethernet1/1` (`:269-278`). DR-006 has no dispatch to reproduce, so the surface is the type:
    // the refusal is client policy, and whether the 7050TX-64 binds sFlow to another kind anyway is an
    // M12 (#14) capture — the message never claims it cannot.
  })

  it('the device keeps authority over an Ethernet name this client accepts (CommandError, DR-005)', async () => {
    const transport = configTransport(FLAT_CONFIG).rejects(writeKey(pair('Ethernet1', 'sflow enable')), {
      code: EapiErrorCode.COMMAND_INVALID,
      message: "CLI command 4 of 4 'sflow enable' failed: command not available on this unit",
    })
    const thrown = await outcome(() => new Node(transport).interfaces.setSflow('Ethernet1'))
    expect(thrown).toBeInstanceOf(CommandError)
    expect((thrown as CommandError).failedCommand).toBe('sflow enable')
    // Whether 4.28.13.1M needs a licence or a role for sFlow is a device answer (DECISIONS.md open item 2's
    // licensing family) — what is pinned is that a rejection never becomes a silent success.
  })
})

describe('InterfacesResource flow-control writes — set_flowcontrol and its direction wrappers (:447-472, :491-524, tests :225-267)', () => {
  it('both directions × both values send `flowcontrol <direction> <value>` (:225-232)', async () => {
    const transport = configTransport(FLAT_CONFIG)
    const interfaces = new Node(transport).interfaces
    const combos: readonly (readonly [FlowcontrolDirection, FlowcontrolValue])[] = [
      ['send', 'on'], ['send', 'off'], ['receive', 'on'], ['receive', 'off'],
    ]
    for (const [direction, value] of combos) scriptWrite(transport, pair('Ethernet1', `flowcontrol ${direction} ${value}`))
    for (const [direction, value] of combos) await interfaces.setFlowcontrol('Ethernet1', direction, value)
    expect(sentAsText(transport)).toEqual(combos.map(([direction, value]) => ['enable', 'configure terminal', 'interface Ethernet1', `flowcontrol ${direction} ${value}`]))
    expect(FLOWCONTROL_VALUES).toEqual(['on', 'off'])
    expect(FLOWCONTROL_DIRECTIONS).toEqual(['send', 'receive'])
  })

  it('the send/receive wrappers compose the same texts upstream\'s six loops pin', async () => {
    const transport = configTransport(FLAT_CONFIG)
    const interfaces = new Node(transport).interfaces
    const texts: string[] = []
    for (const direction of ['send', 'receive'] as const) {
      for (const inner of [`flowcontrol ${direction} on`, `no flowcontrol ${direction}`, `default flowcontrol ${direction}`]) {
        scriptWrite(transport, pair('Ethernet1', inner))
        texts.push(inner)
      }
    }
    await interfaces.setFlowcontrolSend('Ethernet1', 'on')
    await interfaces.unsetFlowcontrolSend('Ethernet1')
    await interfaces.defaultFlowcontrolSend('Ethernet1')
    await interfaces.setFlowcontrolReceive('Ethernet1', 'on')
    await interfaces.unsetFlowcontrolReceive('Ethernet1')
    await interfaces.defaultFlowcontrolReceive('Ethernet1')
    expect(sentAsText(transport)).toEqual(texts.map((inner) => ['enable', 'configure terminal', 'interface Ethernet1', inner]))
    // The wrappers are pyeapi's `set_flowcontrol_send`/`_receive` (`:447-450`, `:469-472`), which only ever
    // call `set_flowcontrol` with the direction baked in — so these six transactions are its
    // `test_set_flowcontrol_with_value`/`_with_no_value`/`_with_disable`/`_with_default` loops (`:225-267`),
    // where the no-value and `disable=True` arms BOTH answer `no flowcontrol <direction>` (`:521-523`).
  })

  it('a bad value or direction is a typed refusal, not upstream\'s ValueError (:513-518)', async () => {
    const transport = configTransport(FLAT_CONFIG)
    const interfaces = new Node(transport).interfaces
    for (const direction of ['send', 'receive'] as const) {
      await expectRefusal(() => interfaces.setFlowcontrol('Ethernet1', direction, 'auto' as FlowcontrolValue), 'invalid flowcontrol value', /expected one of on \/ off/)
      await expectRefusal(() => interfaces.setFlowcontrol('Ethernet1', direction, true as unknown as FlowcontrolValue), 'invalid flowcontrol value')
      await expectRefusal(() => interfaces.setFlowcontrol('Ethernet1', direction, undefined as unknown as FlowcontrolValue), 'invalid flowcontrol value')
    }
    for (const direction of ['both', 'tx', '', 'Send']) {
      await expectRefusal(() => interfaces.setFlowcontrol('Ethernet1', direction as unknown as FlowcontrolDirection, 'on'), 'invalid flowcontrol direction', /expected one of send \/ receive/)
      await expectRefusal(() => interfaces.unsetFlowcontrol('Ethernet1', direction as unknown as FlowcontrolDirection), 'invalid flowcontrol direction')
      await expectRefusal(() => interfaces.defaultFlowcontrol('Ethernet1', direction as unknown as FlowcontrolDirection), 'invalid flowcontrol direction')
    }
    expect(transport.sent()).toEqual([])
    // pyeapi's guards are `ValueError('invalid flowcontrol value')` (`:513-515`, pinned at
    // `test_api_interfaces.py:239-243`) and `ValueError('invalid direction specified')` (`:517-518`, `:234-238`).
  })

  it('when both arguments are bad the DIRECTION is what this client reports (upstream checks the value first)', async () => {
    const interfaces = interfacesFor(FLAT_CONFIG)
    await expectRefusal(() => interfaces.setFlowcontrol('Ethernet1', 'both' as unknown as FlowcontrolDirection, 'auto' as FlowcontrolValue), 'invalid flowcontrol direction')
    // Upstream's guard order is the other way round — value at `:513-515`, direction at `:517-518` — so its
    // message for a doubly-bad call names the value. Either order refuses before the wire and every
    // single-bad-argument case above agrees with upstream; the ordering difference is recorded rather than
    // smoothed over, because a caller reading a message should be able to tell what was looked at first.
  })

  it('the Ethernet-only surface is enforced on the flow-control family too, dotted name included', async () => {
    const transport = configTransport(FLAT_CONFIG)
    const interfaces = new Node(transport).interfaces
    for (const name of ['Port-Channel3', 'Vlan20', 'Management1', 'Ethernet48.2044', 'Ethernet1/1']) {
      await expectRefusal(() => interfaces.setFlowcontrolSend(name, 'on'), 'invalid setFlowcontrol interface')
      await expectRefusal(() => interfaces.unsetFlowcontrolReceive(name), 'invalid unsetFlowcontrol interface')
      await expectRefusal(() => interfaces.defaultFlowcontrolSend(name), 'invalid defaultFlowcontrol interface')
    }
    expect(transport.sent()).toEqual([])
  })

  it('a flow-control write the device refuses arrives as its CommandError', async () => {
    const transport = configTransport(FLAT_CONFIG).rejects(writeKey(pair('Ethernet1', 'flowcontrol receive off')), {
      code: EapiErrorCode.COMMAND_INVALID,
      message: "CLI command 4 of 4 'flowcontrol receive off' failed: command not available on this unit",
    })
    const thrown = await outcome(() => new Node(transport).interfaces.setFlowcontrolReceive('Ethernet1', 'off'))
    expect(thrown).toBeInstanceOf(CommandError)
    expect((thrown as CommandError).failedCommand).toBe('flowcontrol receive off')
    expect((thrown as CommandError).commands).toEqual(['enable', 'configure terminal', 'interface Ethernet1', 'flowcontrol receive off'])
  })
})

describe('InterfacesResource VRF binding — set_vrf and its version-selected keyword (:550-577, tests :297-302; divergences 14/18, DR-078)', () => {
  it.each([
    ['4.28.13.1M', 'vrf'],
    ['4.28.14M', 'vrf'],
    ['4.23.0F', 'vrf'],
    ['5.0.1F', 'vrf'],
    ['4.22.2F', 'vrf forwarding'],
    ['4.17.1.1F-3512479.41711F', 'vrf forwarding'],
    ['4.9.13.1F', 'vrf forwarding'],
    ['3.21.1F', 'vrf forwarding'],
  ] as const)('setVrf on %s composes `%s MGMT`', async (version, keyword) => {
    const transport = configTransport(FLAT_CONFIG).replies(versionKey, versionReply(version))
    const cmds = pair('Ethernet1', `${keyword} MGMT`)
    scriptWrite(transport, cmds)
    await new Node(transport).interfaces.setVrf('Ethernet1', 'MGMT')
    expect(sentAsText(transport)).toEqual([
      ['enable', 'show version'],
      ['enable', 'configure terminal', ...cmds],
    ])
  })

  it('the 4.9 case is the recorded divergence: upstream\'s STRING compare picked the newer keyword (:568)', async () => {
    // `if self.version_number >= '4.23':` is a lexicographic compare, and `'4.9' >= '4.23'` is true
    // character-wise — so a 4.9-era box is handed the bare `vrf`. The mock node upstream tests against is
    // pinned at `'4.17.1.1'` (`test/lib/testlib.py:81`), which is why its only VRF test (`:297-302`) pins
    // `vrf forwarding testvrf` and never sees the bug. This client compares release SEGMENTS as numbers
    // (`versionFloorCompare`), and the difference is stated rather than silently patched (row 131, DR-078).
    const transport = configTransport(FLAT_CONFIG).replies(versionKey, versionReply('4.9.13.1F'))
    const cmds = pair('Ethernet1', 'vrf forwarding MGMT')
    scriptWrite(transport, cmds)
    await new Node(transport).interfaces.setVrf('Ethernet1', 'MGMT')
    expect(sentAsText(transport)).toEqual([
      ['enable', 'show version'],
      ['enable', 'configure terminal', ...cmds],
    ])
  })

  it('a version this client cannot classify composes no command at all (DR-032/DR-057)', async () => {
    for (const version of ['software-version-string', '4', 'v4.23', '999999999999999999999.1', '4.999999999999999999999']) {
      const transport = configTransport(FLAT_CONFIG).replies(versionKey, versionReply(version))
      const thrown = await outcome(() => new Node(transport).interfaces.setVrf('Ethernet1', 'MGMT'))
      expect(thrown, version).toBeInstanceOf(NotSupportedError)
      expect((thrown as Error).message).toContain('cannot pick the VRF command form')
      expect(sentAsText(transport)).toEqual([['enable', 'show version']])
    }
    // The last two forms exercise the segment compare's own guard: a `major`/`minor` that cannot be held as
    // an integer is not a release this client can order, so neither arm is chosen — where pyeapi would
    // string-compare whatever the device said and pick one anyway (`:568`).
  })

  it('the version read is the Node\'s memo — three VRF writes, one `show version`', async () => {
    const transport = configTransport(FLAT_CONFIG).replies(versionKey, versionReply('4.28.13.1M'))
    for (const cmds of [pair('Ethernet1', 'vrf MGMT'), pair('Ethernet2', 'no vrf'), pair('Ethernet3', 'default vrf')]) scriptWrite(transport, cmds)
    const interfaces = new Node(transport).interfaces
    await interfaces.setVrf('Ethernet1', 'MGMT')
    await interfaces.unsetVrf('Ethernet2')
    await interfaces.defaultVrf('Ethernet3')
    expect(transport.bodies().filter((body) => body.params.cmds.some((c) => String(c) === 'show version'))).toHaveLength(1)
    expect(sentAsText(transport)).toEqual([
      ['enable', 'show version'],
      ['enable', 'configure terminal', 'interface Ethernet1', 'vrf MGMT'],
      ['enable', 'configure terminal', 'interface Ethernet2', 'no vrf'],
      ['enable', 'configure terminal', 'interface Ethernet3', 'default vrf'],
    ])
  })

  it('the no/default arms drop the VRF name in both keyword forms, exactly as upstream composes them', async () => {
    const older = configTransport(FLAT_CONFIG).replies(versionKey, versionReply('4.17.1.1'))
    for (const cmds of [pair('Ethernet1', 'vrf forwarding MGMT'), pair('Ethernet1', 'no vrf forwarding'), pair('Ethernet1', 'default vrf forwarding')]) scriptWrite(older, cmds)
    const interfaces = new Node(older).interfaces
    await interfaces.setVrf('Ethernet1', 'MGMT')
    await interfaces.unsetVrf('Ethernet1')
    await interfaces.defaultVrf('Ethernet1')
    expect(sentAsText(older)).toEqual([
      ['enable', 'show version'],
      ['enable', 'configure terminal', 'interface Ethernet1', 'vrf forwarding MGMT'],
      ['enable', 'configure terminal', 'interface Ethernet1', 'no vrf forwarding'],
      ['enable', 'configure terminal', 'interface Ethernet1', 'default vrf forwarding'],
    ])
    // `set_vrf(name, vrf, disable=True)` / `default=True` reach `command_builder`'s mode arms
    // (`abstract.py:152-155`), which return `no <keyword>` / `default <keyword>` and lose the name — so this
    // client never composes `no vrf MGMT`. Whether such a form exists on 4.28.13.1M is an M12 (#14)
    // capture, not something to invent here (row 131).
  })

  it('a VRF name this client could not read back is refused before the version read (reader-derived)', async () => {
    const transport = configTransport(FLAT_CONFIG).replies(versionKey, versionReply('4.28.13.1M'))
    const interfaces = new Node(transport).interfaces
    const cases: readonly (readonly [unknown, RegExp])[] = [
      ['', /an empty VRF name is refused/],
      ['   ', /an empty VRF name is refused/],
      [' MGMT', /leading or trailing whitespace cannot read back/],
      ['MGMT ', /leading or trailing whitespace cannot read back/],
      ['MG M', /inner whitespace cannot round-trip/],
      ['MG\x07MT', /control character would break/],
      [42, /expected a string VRF name/],
      [undefined, /expected a string VRF name/],
    ]
    for (const [value, why] of cases) {
      const thrown = await outcome(() => interfaces.setVrf('Ethernet1', value as string))
      expect(thrown, String(value)).toBeInstanceOf(NotSupportedError)
      expect((thrown as Error).message).toContain('invalid interface vrf')
      expect((thrown as Error).message).toMatch(why)
    }
    expect(transport.sent()).toEqual([])
    // Upstream interpolates whatever arrives (`:569`/`:573` through `abstract.py:158-159`) and its test uses
    // the single-token `'testvrf'` (`:297`), so every value above would reach its wire and then fail to read
    // back through `VRF_BODY_LINE`. What EOS itself permits in a VRF name stays an open item (DR-057).
  })

  it('the name guard runs first, so a wrong-kind name is what a bad call reports', async () => {
    const transport = configTransport(FLAT_CONFIG).replies(versionKey, versionReply('4.28.13.1M'))
    const interfaces = new Node(transport).interfaces
    for (const name of ['Vlan20', 'Port-Channel3', 'Management1', 'Ethernet48.2044', 'PortChannel1']) {
      await expectRefusal(() => interfaces.setVrf(name, 'MG M'), 'invalid setVrf interface')
      await expectRefusal(() => interfaces.unsetVrf(name), 'invalid unsetVrf interface')
      await expectRefusal(() => interfaces.defaultVrf(name), 'invalid defaultVrf interface')
    }
    expect(transport.sent()).toEqual([])
  })

  it('the write round-trips: the binding setVrf composes is the binding a read reports (divergence 14)', async () => {
    const transport = mockTransport()
      .repliesOnce('enable\nshow running-config all', [{}, { output: 'end' }])
      .replies(versionKey, versionReply('4.28.13.1M'))
      .replies(writeKey(pair('Ethernet1', 'vrf MGMT')), okFor(pair('Ethernet1', 'vrf MGMT')))
      .repliesOnce('enable\nshow running-config all', [{}, { output: textOf(['interface Ethernet1', '   vrf MGMT', 'end']) }])
    const interfaces = new Node(transport).interfaces
    expect((await interfaces.getAll({ status: 'skip' })).get('Ethernet1')?.ethernet).toBeUndefined()
    await interfaces.setVrf('Ethernet1', 'MGMT')
    expect((await interfaces.getAll({ status: 'skip' })).get('Ethernet1')?.ethernet).toEqual({ vrf: 'MGMT' })
    expect(sentAsText(transport)).toEqual([
      ['enable', 'show running-config all'],
      ['enable', 'show version'],
      ['enable', 'configure terminal', 'interface Ethernet1', 'vrf MGMT'],
      ['enable', 'show running-config all'],
    ])
    // pyeapi cannot do this at all: `set_vrf` (`:550-577`) has no reader anywhere in the module, since
    // `EthernetInterface.get` composes only sflow and the two flow-control directions (`:335-366`).
  })

  it('both keyword forms stay the device\'s to refuse — a CommandError arrives either way', async () => {
    for (const [version, keyword] of [['4.17.1.1', 'vrf forwarding'], ['4.28.13.1M', 'vrf']] as const) {
      const transport = configTransport(FLAT_CONFIG)
        .replies(versionKey, versionReply(version))
        .rejects(writeKey(pair('Ethernet1', `${keyword} MGMT`)), {
          code: EapiErrorCode.COMMAND_INVALID,
          message: `CLI command 4 of 4 '${keyword} MGMT' failed: vrf not configured for this interface`,
        })
      const thrown = await outcome(() => new Node(transport).interfaces.setVrf('Ethernet1', 'MGMT'))
      expect(thrown, version).toBeInstanceOf(CommandError)
      expect((thrown as CommandError).failedCommand).toBe(`${keyword} MGMT`)
    }
    // The failure message's *reason* is a paraphrase of a device answer, not a claim about one (DR-057):
    // the routed-mode/VRF-licensing question lives in DECISIONS.md open item 2.
  })
})

describe('InterfacesResource LAG reads — get_members (interfaces.py:660-675) and get_lacp_mode (:639-658)', () => {
  it('the live member list is the fixture scrape, ported with its exact expression (:379-381)', async () => {
    const transport = lagTransport(LAG_CONFIG, ['Ethernet5', 'Ethernet6'])
    expect(await new Node(transport).interfaces.getMembers('Port-Channel1')).toEqual(['Ethernet5', 'Ethernet6'])
    expect(sentAsText(transport))
      .toEqual([['enable', 'show port-channel 1 all-ports']])
    // One read, `format:'text'`, exactly the command upstream builds at `:671-672`, and the reply is
    // `show_portchannel.json`'s verbatim output — so this pins the same answer as upstream's
    // `test_get_members` (`:379-381`).
  })

  it('the group id comes from the name\'s first decimal run, zero padding kept (:671 parity)', async () => {
    const transport = lagTransport(LAG_CONFIG, [], '0010')
    expect(await new Node(transport).interfaces.getMembers('Port-Channel0010')).toEqual([])
    expect(sentAsText(transport)).toEqual([['enable', 'show port-channel 0010 all-ports']])
    // `re.search(r'(\d+)', name).group()` keeps the run as written, and upstream `.group()`s on `None` —
    // a `TypeError` — for a digit-less name (`:671`, `:699`, `:734`). The guard below is where that crash
    // becomes a refusal instead.
  })

  it('the Peer look-around does NOT exclude the hyphenated MLAG spelling — upstream\'s expression verbatim (:674)', async () => {
    const transport = lagTransport(LAG_CONFIG, ['Ethernet5', 'Ethernet1/1'])
    expect(await new Node(transport).interfaces.getMembers('Port-Channel1')).toEqual(['Ethernet5', 'Ethernet1/1'])
    expect(membersFromOutput(activePortsText(['Ethernet5', 'Ethernet1/1']))).toEqual(['Ethernet5', 'Ethernet1/1'])
    // The probe that settles this, run against the pinned clone on 2026-11-05:
    //   re.findall(r'\b(?!Peer)Ethernet[\d/]*\b', '  Peer-Ethernet1 Ethernet2') -> ['Ethernet1', 'Ethernet2']
    //   re.findall(r'\b(?!Peer)Ethernet[\d/]*\b', 'PeerEthernet1 Ethernet2')    -> ['Ethernet2']
    // A hyphen is itself a word boundary, so the match position begins at `Ethernet` and the look-around —
    // which only rejects a position whose own text starts with `Peer` — never fires. The JS port reproduces
    // that exactly, and `[\d/]*` is what keeps the `Ethernet1/1` slot form legible as a member the device
    // reports although this client's grammar refuses to configure it. Whether 4.28.13.1M prints a peer port
    // inside this block at all is an M12 (#14) capture, so what is being retired here is the code comment's
    // claim, not a device fact (row 125, DR-075).
    expect(membersFromOutput('Port Channel Port-Channel1:\n  Peer-Ethernet1 Ethernet2\n')).toEqual(['Ethernet1', 'Ethernet2'])
    expect(membersFromOutput('PeerEthernet1 Ethernet2')).toEqual(['Ethernet2'])
  })

  it('an empty answer is an empty member list — and it is not the same statement as a failure', async () => {
    const transport = lagTransport(LAG_CONFIG, [])
    expect(await new Node(transport).interfaces.getMembers('Port-Channel1')).toEqual([])
    expect(membersFromOutput('Port Channel Port-Channel1:\n  No members\n')).toEqual([])
  })

  it('a refused or malformed show arrives as a typed failure, never as "no members" (DR-029)', async () => {
    const refused = mockTransport().rejects('enable\nshow port-channel 1 all-ports', {
      code: EapiErrorCode.COMMAND_INVALID,
      message: "CLI command 2 of 2 'show port-channel 1 all-ports' failed: command not available",
    })
    const thrown = await outcome(() => new Node(refused).interfaces.getMembers('Port-Channel1'))
    expect(thrown).toBeInstanceOf(CommandError)
    expect((thrown as CommandError).failedCommand).toBe('show port-channel 1 all-ports')
    expect(refused.callCount()).toBe(1)

    const shapeless = mockTransport().replies('enable\nshow port-channel 1 all-ports', [{}, { interfaces: {} }])
    const badShape = await outcome(() => new Node(shapeless).interfaces.getMembers('Port-Channel1'))
    expect(badShape).toBeInstanceOf(ProtocolError)
    expect((badShape as Error).message).toContain("no string 'output' member")
    // Upstream reads `config[0]['result']['output']` positionally off the `enable` answer (`:673-675`) and
    // raises `TypeError`/`IndexError` in exactly these states; the typed errors carry the same information
    // (DR-005/DR-010).
  })

  it('a name the Port-Channel guard refuses composes nothing, for every LAG verb at once', async () => {
    const transport = lagTransport(LAG_CONFIG, ['Ethernet5', 'Ethernet6'])
    const interfaces = new Node(transport).interfaces
    for (const name of ['Ethernet1', 'Vlan20', 'Management1', 'Loopback2', 'Vxlan5', 'PortChannel1', 'Po1', 'Port-Channel1.1', 'Ethernet1/1']) {
      await expectRefusal(() => interfaces.getMembers(name), 'invalid getMembers interface')
      await expectRefusal(() => interfaces.getLacpMode(name), 'invalid getLacpMode interface')
      await expectRefusal(() => interfaces.setMembers(name, ['Ethernet5']), 'invalid setMembers interface')
      await expectRefusal(() => interfaces.setLacpMode(name, 'active'), 'invalid setLacpMode interface')
      await expectRefusal(() => interfaces.setMinimumLinks(name, 2), 'invalid setMinimumLinks interface')
      await expectRefusal(() => interfaces.setLacpFallback(name, 'static'), 'invalid setLacpFallback interface')
    }
    expect(transport.sent()).toEqual([])
    await expectRefusal(() => interfaces.getMembers('PortChannel1'), 'invalid getMembers interface', 'expected a plain `PortChannel<n>` name whose digits carry the channel-group id')
    // Upstream's class checks no name at all on these verbs — its tests drive them with the literal
    // `'Port-Channel1'` only — but the group extraction crashes on a digit-less name (`:671`/`:699`/`:734`),
    // which is the second half of this guard (row 128).
  })

  it('getLacpMode answers from the members it can read, scanning past the ones it cannot (:639-658)', async () => {
    const transport = lagTransport(LAG_CONFIG, ['Ethernet1/1', 'Ethernet9', 'Ethernet5'])
    const interfaces = new Node(transport).interfaces
    expect(await interfaces.getLacpMode('Port-Channel1')).toBe('on')
    expect(sentAsText(transport)).toEqual([
      ['enable', 'show port-channel 1 all-ports'],
      ['enable', 'show running-config all'],
    ])
    // Three members, three states: a name the grammar cannot read (skipped before any lookup), a name with
    // no running-config section (`getBlock` answers `undefined`, where upstream's `re.search(pattern, None)`
    // raises `TypeError` at `:656-657`), and the one section carrying the relation. Upstream `return`s
    // inside its FIRST loop iteration, so only the first name it fetched is ever examined (row 129).
  })

  it('no member naming a mode means ABSENT, not the DEFAULT_LACP_MODE upstream fabricates (:651-653)', async () => {
    expect(await new Node(lagTransport(LAG_CONFIG, [])).interfaces.getLacpMode('Port-Channel1')).toBeUndefined()
    // `return DEFAULT_LACP_MODE` (`:67`, `:653`) answers `'on'` for a group with no members, and upstream's
    // `test_get_lacp_mode` (`:375-377`) pins exactly that `'on'` — a mode for a LAG holding nothing.
    const withoutMode = lagTransport(LAG_MEMBERS_WITHOUT_MODE, ['Ethernet5', 'Ethernet6'])
    expect(await new Node(withoutMode).interfaces.getLacpMode('Port-Channel1')).toBeUndefined()
  })

  it('a member naming a mode outside LACP_MODES is reported, not handed to a caller to rewrite (DR-079)', async () => {
    const transport = lagTransport(textOf(['interface Port-Channel1', '!', 'interface Ethernet5', '   channel-group 1 mode fast', 'end']), ['Ethernet5'])
    const thrown = await outcome(() => new Node(transport).interfaces.getLacpMode('Port-Channel1'))
    expect(thrown).toBeInstanceOf(ConfigParseError)
    expect((thrown as Error).message).toContain("cannot read the channel-group mode in 'interface Ethernet5'")
  })
})

describe('InterfacesResource setMembers — the remove/add diff and its mode side call (interfaces.py:677-716, tests :383-414; divergence 20, DR-080)', () => {
  it('the diff removes the ex-members then adds the new ones, reusing the mode the members carry (:383-388)', async () => {
    const transport = lagTransport(LAG_CONFIG, ['Ethernet5', 'Ethernet6'])
    const cmds = ['interface Ethernet6', 'no channel-group 1', 'interface Ethernet7', 'channel-group 1 mode on']
    scriptWrite(transport, cmds)
    await new Node(transport).interfaces.setMembers('Port-Channel1', ['Ethernet5', 'Ethernet7'])
    expect(sentAsText(transport)).toEqual([
      ['enable', 'show port-channel 1 all-ports'],
      ['enable', 'show running-config all'],
      ['enable', 'configure terminal', ...cmds],
    ])
    // Upstream computes the same four lines — `set(current_members).difference(members)` then
    // `set(members).difference(current_members)` (`:706-714`) — but iterates Python **sets**, so its order is
    // hash order rather than the device's; here removes follow the scraped order and adds follow the
    // caller's array, which is what makes the batch reviewable (DR-060 is the general rule). The `'on'` comes
    // from the members' own `channel-group 1 mode on` config lines (`running_config.portchannel:147`/`:278`),
    // where upstream answers it from `get_lacp_mode`'s regex instead.
  })

  it('a mode change costs TWO transactions and both are pinned (upstream\'s test can only see the last, :397-402)', async () => {
    const transport = lagTransport(LAG_CONFIG, ['Ethernet5', 'Ethernet6'])
    const detachAll = [
      'interface Ethernet5', 'no channel-group 1',
      'interface Ethernet6', 'no channel-group 1',
      'interface Ethernet5', 'channel-group 1 mode active',
      'interface Ethernet6', 'channel-group 1 mode active',
    ]
    const diff = ['interface Ethernet6', 'no channel-group 1', 'interface Ethernet7', 'channel-group 1 mode active']
    scriptWrite(transport, detachAll)
    scriptWrite(transport, diff)
    await new Node(transport).interfaces.setMembers('Port-Channel1', ['Ethernet5', 'Ethernet7'], 'active')
    expect(sentAsText(transport)).toEqual([
      ['enable', 'show port-channel 1 all-ports'],
      ['enable', 'show running-config all'],
      ['enable', 'configure terminal', ...detachAll],
      ['enable', 'configure terminal', ...diff],
    ])
    // `set_members` calls `self.set_lacp_mode(<grpid>, mode)` (`:702-704`) when the requested mode differs,
    // and that verb detaches and re-attaches **every** current member in one flat remove-then-add batch
    // (`:736-745`) — so a mode change momentarily drops the whole LAG before the diff runs. Upstream's
    // `test_set_members_update_mode` asserts against the **last** `config` call only
    // (`test/lib/testlib.py:100`), so the detach batch is invisible in its own suite (row 130, DR-080).
    expect(transport.callCount()).toBe(4)
    // PLAN.md §M10's phrase "shutdown member interfaces before joining" describes no upstream command:
    // `set_members`/`set_lacp_mode` contain no `shutdown` at all (re-read `:677-745`, 2026-11-05), so the
    // transaction order pinned here is the whole of the safety story the code actually tells.
  })

  it('a mode equal to the members\' current one rewrites nothing and costs one transaction', async () => {
    const transport = lagTransport(LAG_CONFIG, ['Ethernet5', 'Ethernet6'])
    const cmds = ['interface Ethernet7', 'channel-group 1 mode on']
    scriptWrite(transport, cmds)
    await new Node(transport).interfaces.setMembers('Port-Channel1', ['Ethernet5', 'Ethernet6', 'Ethernet7'], 'on')
    expect(sentAsText(transport)).toEqual([
      ['enable', 'show port-channel 1 all-ports'],
      ['enable', 'show running-config all'],
      ['enable', 'configure terminal', ...cmds],
    ])
  })

  it('no diff means no configuration transaction at all (:716, upstream\'s cmds=None pin at :411-414)', async () => {
    const transport = lagTransport(LAG_CONFIG, ['Ethernet5', 'Ethernet6'])
    await new Node(transport).interfaces.setMembers('Port-Channel1', ['Ethernet5', 'Ethernet6'])
    expect(sentAsText(transport)).toEqual([
      ['enable', 'show port-channel 1 all-ports'],
      ['enable', 'show running-config all'],
    ])
    // `return self.configure(commands) if commands else True` (`:716`) — and `testlib.py:109` turns that
    // `cmds=None` pin into `config.call_count == 0`, so upstream opens no transaction either. The
    // running-config read is still spent here, because the mode for a hypothetical add must be found first.
  })

  it('an empty target detaches every member: removes only, never an add for a member the caller dropped', async () => {
    const transport = lagTransport(LAG_CONFIG, ['Ethernet5', 'Ethernet6'])
    const cmds = ['interface Ethernet5', 'no channel-group 1', 'interface Ethernet6', 'no channel-group 1']
    scriptWrite(transport, cmds)
    await new Node(transport).interfaces.setMembers('Port-Channel1', [])
    expect(sentAsText(transport)).toEqual([
      ['enable', 'show port-channel 1 all-ports'],
      ['enable', 'show running-config all'],
      ['enable', 'configure terminal', ...cmds],
    ])
  })

  it('a modeless group is written modeless — the DEFAULT_LACP_MODE answer upstream interpolates is refused (:712-714)', async () => {
    const transport = lagTransport(LAG_CONFIG, [])
    const cmds = ['interface Ethernet5', 'channel-group 1']
    scriptWrite(transport, cmds)
    await new Node(transport).interfaces.setMembers('Port-Channel1', ['Ethernet5'])
    expect(sentAsText(transport)).toEqual([
      ['enable', 'show port-channel 1 all-ports'],
      ['enable', 'configure terminal', ...cmds],
    ])
    // With no members, upstream's `get_lacp_mode` returns `DEFAULT_LACP_MODE` (`:67`, `:651-653`) and the add
    // line becomes `channel-group 1 mode on` — a mode invented for a group nothing declares. No running-config
    // read is needed here: there is no current member to read a mode from (compare the refusal below, where
    // members exist but name none).
  })

  it('members that name no mode plus a caller who gives none: a refusal, not pyeapi\'s literal `mode None`', async () => {
    const transport = lagTransport(LAG_MEMBERS_WITHOUT_MODE, ['Ethernet5', 'Ethernet6'])
    const thrown = await outcome(() => new Node(transport).interfaces.setMembers('Port-Channel1', ['Ethernet5', 'Ethernet6', 'Ethernet7']))
    expect(thrown).toBeInstanceOf(NotSupportedError)
    expect((thrown as Error).message).toContain('no mode given and no current member names a channel-group mode to reuse')
    expect((thrown as Error).message).toContain('channel-group 1 mode None')
    expect(sentAsText(transport)).toEqual([
      ['enable', 'show port-channel 1 all-ports'],
      ['enable', 'show running-config all'],
    ])
    // Upstream's `test_set_members_mode_none` (`:404-409`) pins `channel-group 1 mode on` for its `mode=None`
    // call **because** its fixture members do name `on`; the writing-`None` case is what `get_lacp_mode`'s
    // `None` answer produces (`:639-658` into `:712-714`) and its suite never drives it. Interpolating a
    // Python `None` into a LAG write is not a command to send and say nothing about (DR-077).
  })

  it('a scraped member this client cannot name is still removed — no local guard strands it (DR-005)', async () => {
    const transport = lagTransport(LAG_CONFIG, ['Ethernet5', 'Ethernet1/1'])
    const cmds = ['interface Ethernet1/1', 'no channel-group 1']
    scriptWrite(transport, cmds)
    await new Node(transport).interfaces.setMembers('Port-Channel1', ['Ethernet5'])
    expect(sentAsText(transport)).toEqual([
      ['enable', 'show port-channel 1 all-ports'],
      ['enable', 'show running-config all'],
      ['enable', 'configure terminal', ...cmds],
    ])
    // `Ethernet1/1` is what upstream's own expression scrapes (`:674-675`) — and its Ethernet test class
    // drives methods on that very name (`:176`) — yet `parseInterfaceName` refuses it (open item 7). A
    // member-side guard would silently strand such a port in the LAG, so the member lines reach the device
    // unguarded and the device answers.
  })

  it('a bad mode refuses before any device read, and upstream\'s two bad-mode answers are both unusable', async () => {
    const transport = lagTransport(LAG_CONFIG, ['Ethernet5', 'Ethernet6'])
    const interfaces = new Node(transport).interfaces
    await expectRefusal(() => interfaces.setMembers('Port-Channel1', ['Ethernet5'], 'fast' as unknown as LacpMode), 'invalid lacp mode', /expected one of active \/ passive \/ on/)
    await expectRefusal(() => interfaces.setLacpMode('Port-Channel1', 'auto' as unknown as LacpMode), 'invalid lacp mode', /RETURNING False/)
    for (const junk of ['both', '', 7, null] as const) {
      await expectRefusal(() => interfaces.setMembers('Port-Channel1', ['Ethernet5'], junk as unknown as LacpMode), 'invalid lacp mode')
    }
    expect(transport.sent()).toEqual([])
    // Upstream's bad-mode answers are `return False` in `set_lacp_mode` (`:731-732`, pinned non-raising at
    // `test_api_interfaces.py:424-426`) and **no check at all** in `set_members`, where an unknown mode
    // reaches the wire as `channel-group 1 mode <junk>` (`:712-714`). Neither is usable from TS (DR-005).
  })

  it('the device refuses the diff and the CommandError arrives with the whole batch (:706-714 is one transaction)', async () => {
    const transport = lagTransport(LAG_CONFIG, ['Ethernet5', 'Ethernet6']).rejects(writeKey(['interface Ethernet6', 'no channel-group 1', 'interface Ethernet7', 'channel-group 1 mode on']), {
      code: EapiErrorCode.COMMAND_INVALID,
      message: "CLI command 6 of 6 'channel-group 1 mode active' failed: interface is configured as a channel member",
    })
    const thrown = await outcome(() => new Node(transport).interfaces.setMembers('Port-Channel1', ['Ethernet5', 'Ethernet7']))
    expect(thrown).toBeInstanceOf(CommandError)
    expect((thrown as CommandError).failedCommand).toBe('channel-group 1 mode active')
    expect((thrown as CommandError).commands).toEqual([
      'enable',
      'configure terminal',
      'interface Ethernet6',
      'no channel-group 1',
      'interface Ethernet7',
      'channel-group 1 mode on',
    ])
    // The message names the command the device complained about, which is not the last line of the batch —
    // a device-side refusal mid-transaction is reported as it arrives rather than re-rolled by this client.
  })
})

describe('InterfacesResource LAG field writes — set_lacp_mode / set_minimum_links / set_lacp_fallback / set_lacp_timeout (:718-811, tests :328-374, :416-426)', () => {
  it('setLacpMode removes every member then re-adds every member, in ONE flat transaction (:416-422)', async () => {
    const transport = lagTransport(LAG_CONFIG, ['Ethernet5', 'Ethernet6'])
    const expected: string[][] = []
    for (const mode of LACP_MODES as readonly LacpMode[]) {
      const cmds = [
        'interface Ethernet5', 'no channel-group 1',
        'interface Ethernet6', 'no channel-group 1',
        'interface Ethernet5', `channel-group 1 mode ${mode}`,
        'interface Ethernet6', `channel-group 1 mode ${mode}`,
      ]
      scriptWrite(transport, cmds)
      expected.push(['enable', 'show port-channel 1 all-ports'], ['enable', 'configure terminal', ...cmds])
    }
    const interfaces = new Node(transport).interfaces
    for (const mode of LACP_MODES as readonly LacpMode[]) await interfaces.setLacpMode('Port-Channel1', mode)
    expect(sentAsText(transport)).toEqual(expected)
    expect(LACP_MODES).toEqual(['active', 'passive', 'on'])
    // Each call asks the device who its members are — `get_members` is called inside the loop body upstream
    // too (`:739`), and neither side memoises it — so three mode changes cost three shows and three
    // transactions. That is the honest count, pinned rather than assumed.
    // The eight-line expectation at `test_api_interfaces.py:416-422` is upstream's, verbatim for `'active'`:
    // removes for all members before adds for all members (`:740-743`, sent at `:745`). The three modes are
    // the set its docstrings list (`:688`, `:726`) and its only guard accepts (`:731`). The order
    // momentarily detaches the whole LAG, which is why the batch is pinned as exactly one transaction.
  })

  it('no members means no transaction — where upstream would still open a configure terminal (:745)', async () => {
    const transport = lagTransport(LAG_CONFIG, [])
    await new Node(transport).interfaces.setLacpMode('Port-Channel1', 'active')
    expect(sentAsText(transport)).toEqual([['enable', 'show port-channel 1 all-ports']])
    // `self.configure(remove_commands + add_commands)` with both lists empty (`:745`) still opens a
    // `configure terminal` transaction carrying nothing (through `abstract.py:103-127`). A no-op
    // transaction against a switch is a surprise, so this client sends nothing (divergence 20's close).
  })

  it('min-links writes the trio, every arm in the interface-submode pair shape (:328-348)', async () => {
    const transport = configTransport(FLAT_CONFIG)
    for (const inner of ['port-channel min-links 2', 'no port-channel min-links', 'default port-channel min-links']) {
      scriptWrite(transport, pair('Port-Channel1', inner))
    }
    const interfaces = new Node(transport).interfaces
    await interfaces.setMinimumLinks('Port-Channel1', 2)
    await interfaces.unsetMinimumLinks('Port-Channel1')
    await interfaces.defaultMinimumLinks('Port-Channel1')
    expect(sentAsText(transport)).toEqual([
      ['enable', 'configure terminal', 'interface Port-Channel1', 'port-channel min-links 2'],
      ['enable', 'configure terminal', 'interface Port-Channel1', 'no port-channel min-links'],
      ['enable', 'configure terminal', 'interface Port-Channel1', 'default port-channel min-links'],
    ])
    // Upstream reaches the `no` text two ways — no value at all (`:335-338`, the deprecated `'no %s'`
    // fall-through at `abstract.py:160-161`) and `disable=True` (`:345-348`) — and the fixture's own line is
    // that same negation (`running_config.portchannel:18`). One name per intent here (DR-037).
  })

  it('min-links accepts any positive safe integer and refuses the rest, naming the reason (client policy)', async () => {
    const transport = configTransport(FLAT_CONFIG)
    const interfaces = new Node(transport).interfaces
    const values: readonly number[] = [1, 2, 16, 4096, Number.MAX_SAFE_INTEGER]
    for (const value of values) scriptWrite(transport, pair('Port-Channel1', `port-channel min-links ${value}`))
    for (const value of values) await interfaces.setMinimumLinks('Port-Channel1', value)
    expect(sentAsText(transport).map((cmds) => String(cmds.at(-1)))).toEqual(values.map((value) => `port-channel min-links ${value}`))
    for (const bad of [0, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2', null, undefined, true]) {
      const thrown = await outcome(() => interfaces.setMinimumLinks('Port-Channel1', bad as unknown as number))
      expect(thrown, String(bad)).toBeInstanceOf(NotSupportedError)
      expect((thrown as Error).message).toContain('invalid minimum links value')
      expect((thrown as Error).message).toContain('expected a positive integer')
    }
    // pyeapi validates nothing here (`:747-769`; its test draws a random 1..16 at `:329`) and the platform
    // ceiling is a device answer, so the bound pinned above is DR-037's falsy trap and nothing more
    // (DR-032/DR-057) — which is why 4096 is sent and let the device object (the next-but-one spec).
  })

  it('the lacp fallback family: two value-carrying modes, one named negation, and no silent False (:356-374)', async () => {
    const transport = configTransport(FLAT_CONFIG)
    for (const inner of ['port-channel lacp fallback individual', 'port-channel lacp fallback static', 'no port-channel lacp fallback']) {
      scriptWrite(transport, pair('Port-Channel1', inner))
    }
    const interfaces = new Node(transport).interfaces
    await interfaces.setLacpFallback('Port-Channel1', 'individual')
    await interfaces.setLacpFallback('Port-Channel1', 'static')
    await interfaces.unsetLacpFallback('Port-Channel1')
    expect(sentAsText(transport)).toEqual([
      ['enable', 'configure terminal', 'interface Port-Channel1', 'port-channel lacp fallback individual'],
      ['enable', 'configure terminal', 'interface Port-Channel1', 'port-channel lacp fallback static'],
      ['enable', 'configure terminal', 'interface Port-Channel1', 'no port-channel lacp fallback'],
    ])
    // Upstream's value set is exactly these three words (`:787`: `['disabled', 'static', 'individual']`), with
    // `'disabled'` mapped to `disable=True` at `:789` and pinned at `test_api_interfaces.py:366-369`; the mode
    // word and the negation are separate intents here (DR-037), and the config-side mirror of the negation is
    // the fixture's line at `running_config.portchannel:19`.
    for (const bad of ['disabled', 'auto', '', 'Individual', 7, null] as const) {
      const thrown = await outcome(() => interfaces.setLacpFallback('Port-Channel1', bad as unknown as LacpFallbackMode))
      expect(thrown, String(bad)).toBeInstanceOf(NotSupportedError)
      expect((thrown as Error).message).toContain('invalid lacp fallback mode')
      expect((thrown as Error).message).toMatch(bad === 'disabled' ? /that intent is the verb unsetLacpFallback\(\)/ : /RETURNING False/)
    }
    expect(transport.bodies().filter((body) => body.params.cmds.includes('configure terminal'))).toHaveLength(3)
  })

  it('lacp fallback timeout writes the value arm and has no negation twin in this slice (:350-354)', async () => {
    const transport = configTransport(FLAT_CONFIG)
    const cmds = pair('Port-Channel1', 'port-channel lacp fallback timeout 90')
    scriptWrite(transport, cmds)
    await new Node(transport).interfaces.setLacpTimeout('Port-Channel1', 90)
    expect(sentAsText(transport)).toEqual([['enable', 'configure terminal', ...cmds]])
    // The absent-value arm deliberately has no verb here: upstream's `set_lacp_timeout(name)` with no value
    // falls through `command_builder` to the deprecated `'no %s'` answer (`abstract.py:160-161`), i.e.
    // `no port-channel lacp fallback timeout`, and DR-037 refuses to let an omitted argument produce a write.
    // So this slice ships the value verb only — a negation is a named verb for a later decision, and the read
    // side keeps that same line honest (row 126).
    expect((interfacesFor(FLAT_CONFIG) as unknown as Record<string, unknown>)['unsetLacpTimeout']).toBeUndefined()
  })

  it('the timeout value is guarded like min-links, and a legal-but-unwelcome value is the device\'s to refuse', async () => {
    const transport = configTransport(FLAT_CONFIG)
    const interfaces = new Node(transport).interfaces
    for (const bad of [0, -5, 0.5, Number.NaN, '90', {}, undefined]) {
      const thrown = await outcome(() => interfaces.setLacpTimeout('Port-Channel1', bad as unknown as number))
      expect(thrown, String(bad)).toBeInstanceOf(NotSupportedError)
      expect((thrown as Error).message).toContain('invalid lacp fallback timeout')
      expect((thrown as Error).message).toContain('expected a positive integer')
    }
    expect(transport.sent()).toEqual([])
    const refused = configTransport(FLAT_CONFIG).rejects(writeKey(pair('Port-Channel1', 'port-channel lacp fallback timeout 99999')), {
      code: EapiErrorCode.COMMAND_INVALID,
      message: "CLI command 4 of 4 'port-channel lacp fallback timeout 99999' failed: timeout out of range",
    })
    const thrown = await outcome(() => new Node(refused).interfaces.setLacpTimeout('Port-Channel1', 99999))
    expect(thrown).toBeInstanceOf(CommandError)
    expect((thrown as CommandError).failedCommand).toBe('port-channel lacp fallback timeout 99999')
    // The range is the device's: upstream's only timeout test uses a random 1..16 (`:351`) and its module
    // carries no bound anywhere, so what 4.28.13.1M accepts is an M12 (#14) capture, not a constant here.
  })

  it('a min-links write the device refuses keeps the device\'s code, command and message (DR-005)', async () => {
    const transport = configTransport(FLAT_CONFIG).rejects(writeKey(pair('Port-Channel1', 'port-channel min-links 2')), {
      code: EapiErrorCode.COMMAND_INVALID,
      message: "CLI command 4 of 4 'port-channel min-links 2' failed: command not available on this unit",
    })
    const thrown = await outcome(() => new Node(transport).interfaces.setMinimumLinks('Port-Channel1', 2))
    expect(thrown).toBeInstanceOf(CommandError)
    expect((thrown as CommandError).code).toBe(EapiErrorCode.COMMAND_INVALID)
    expect((thrown as CommandError).failedCommand).toBe('port-channel min-links 2')
  })

  it('no Port-Channel field write reads a config first, and each is exactly one transaction (DR-030)', async () => {
    const transport = configTransport(FLAT_CONFIG)
    const interfaces = new Node(transport).interfaces
    const batches: readonly (readonly string[])[] = [
      pair('Port-Channel1', 'port-channel min-links 3'),
      pair('Port-Channel1', 'default port-channel min-links'),
      pair('Port-Channel1', 'port-channel lacp fallback static'),
      pair('Port-Channel1', 'port-channel lacp fallback timeout 4'),
    ]
    for (const cmds of batches) scriptWrite(transport, cmds)
    await interfaces.setMinimumLinks('Port-Channel1', 3)
    await interfaces.defaultMinimumLinks('Port-Channel1')
    await interfaces.setLacpFallback('Port-Channel1', 'static')
    await interfaces.setLacpTimeout('Port-Channel1', 4)
    expect(transport.callCount()).toBe(4)
    expect(transport.bodies().filter((body) => body.params.cmds.some((c) => String(c) === 'show running-config all'))).toEqual([])
  })
})

// ================================================================================================
// M10d (W3b lane B, #52): the `VxlanInterface` slice — pyeapi/api/interfaces.py:814-1090 and its
// suite's `TestApiVxlanInterface` (class :429, methods :436-531, re-grepped 2026-11-07).
// ================================================================================================

/**
 * `pyeapi/test/fixtures/running_config.vxlan`, all 50 lines, **byte-exact verbatim copy** (body indent
 * three spaces preserved, `interface Vxlan1` at `:1`, the six VXLAN families at `:39-49`, the `!` at
 * `:50`) — pyeapi's own test material, NOT a device capture; nothing here is evidence about the
 * DCS-7050TX-64 (DR-043's discipline, and whether VXLAN is even supported on this SKU is a probe
 * question, DR-033). Inlined rather than shipped under `test/fixtures/config/` for the vrfs.test.ts
 * (W2d) reason: no `manifest.json`/oracle edits from a lane that is not fixing them this round, and
 * the section is small enough to read at the call site. `end` is appended only because that is how
 * every config answer in this suite's chunker is terminated.
 */
const VXLAN_FIXTURE = textOf([
  'interface Vxlan1',
  '   no description',
  '   no shutdown',
  '   default load-interval',
  '   logging event link-status use-global',
  '   switchport access vlan 1',
  '   switchport trunk native vlan 1',
  '   switchport trunk allowed vlan 1-4094',
  '   switchport mode access',
  '   switchport mac address learning',
  '   no switchport private-vlan mapping',
  '   switchport',
  '   default encapsulation dot1q vlan',
  '   no l2-protocol encapsulation dot1q vlan 0',
  '   snmp trap link-status',
  '   no switchport port-security',
  '   switchport port-security maximum 1',
  '   sflow enable',
  '   no spanning-tree portfast',
  '   spanning-tree portfast auto',
  '   no spanning-tree link-type',
  '   no spanning-tree bpduguard',
  '   no spanning-tree bpdufilter',
  '   no spanning-tree cost',
  '   spanning-tree port-priority 128',
  '   no spanning-tree guard',
  '   no spanning-tree bpduguard rate-limit',
  '   logging event spanning-tree use-global',
  '   switchport tap native vlan 1',
  '   no switchport tap identity',
  '   switchport tap allowed vlan 1-4094',
  '   switchport tool allowed vlan 1-4094',
  '   no switchport tool identity',
  '   no switchport tap truncation',
  '   no switchport tool truncation',
  '   no switchport tap default group',
  '   no switchport tool group',
  '   no switchport tool dot1q remove outer',
  '   vxlan multicast-group 239.10.10.10',
  '   vxlan source-interface Loopback0',
  '   no vxlan controller-client',
  '   vxlan udp-port 4789',
  '   vxlan vlan 10 vni 10',
  '   vxlan vlan 10 flood vtep 3.3.3.3 4.4.4.4',
  '   vxlan flood vtep 1.1.1.1 2.2.2.2',
  '   no vxlan vlan flood vtep',
  '   no vxlan learn-restrict vtep',
  '   no vxlan vlan learn-restrict vtep',
  '   no vxlan multicast-group decap',
  '!',
  'end',
])

describe('InterfacesResource Vxlan field reads — M10d: the six pyeapi readers (:862-919), quirks pinned, defaults refused (divergences 21/22, DR-076)', () => {
  it('the pyeapi fixture section, verbatim: all six answers at once (upstream test_get :436-442 pins only the key set)', async () => {
    const all = await readTable(VXLAN_FIXTURE)
    expect(all.get('Vxlan1')).toEqual({
      name: 'Vxlan1',
      kind: 'Vxlan',
      shutdown: false,
      vxlan: {
        sourceInterface: 'Loopback0', // :40
        multicastGroup: '239.10.10.10', // :39
        multicastDecap: false, // :49 — see the decap test below for WHY upstream's answer here is right by accident
        udpPort: 4789, // :42
        vlans: new Map([['10', { vni: 10, floodList: ['3.3.3.3', '4.4.4.4'] }]]), // :43/:44; upstream keeps the vni a STRING (:906)
        floodList: ['1.1.1.1', '2.2.2.2'], // :45
      },
    })
    expect(Object.keys(all.get('Vxlan1') ?? {}).sort()).toEqual(['kind', 'name', 'shutdown', 'vxlan'])
    // Upstream's own answer is the same VALUES plus its `type: 'vxlan'` class label (`:851`), which is
    // divergence 2's `kind` here, and its header fields come from the SAME section in one pass rather
    // than from a second `get_block` fetch (`get :822`'s own `get_block('^interface %s')` at `:846` +
    // `super().get` at `:850`) — so `get('Vxlan1')` and `getAll()` cannot disagree. The `no description`
    // at `:2` answers nothing, and the `sflow enable` at `:18` belongs to the Ethernet group only
    // (DR-068's kind gating — pinned for the vxlan group by name below). The `default encapsulation
    // dot1q vlan` at `:13` and `no l2-protocol …` at `:14` stay non-values for the same
    // keyword-anchor reason divergence 6 pinned. Upstream also had 10 keys because both always-answer
    // fields are present even when bare; here the ten become six fields + the shared three, with the
    // absent ones simply not present.
    expect(all.get('Vxlan1')?.vxlan?.vlans?.get('10')?.vni).toBe(10)
  })

  it('none of upstream\'s invented answers survives: ""-constants, the missing-udp-port crash, and the always-false decap all read ABSENT (:816-817, :877, :884, :894)', async () => {
    const negated = await readTable(textOf(['interface Vxlan1', '   no vxlan source-interface', '   no vxlan udp-port', 'end']))
    expect(negated.get('Vxlan1')).toEqual({ name: 'Vxlan1', kind: 'Vxlan' })
    // Upstream on this shape: `source_interface: ''` and `multicast_group: ''` from the module
    // constants `DEFAULT_SRC_INTF`/`DEFAULT_MCAST_GRP` (`:816-817`, applied at `:877`/`:884`) — one
    // answer for \"not configured\" and \"configured empty\" — and for `udp_port` it does not answer at
    // ALL: `_parse_udp_port` int()s an unchecked match (`value = int(match.group(1))`, `:894`) so the
    // `None.group` AttributeError takes `get`/`getall` down with it. The fixture at
    // `running_config.vxlan:42` is the only reason pyeapi's suite never sees its own crash. Here the
    // three states are one honest state: absent (DR-076's family, divergence 21).
  })

  it('the group read keeps upstream\'s verbatim pattern — three-digit leading octet IN, anything else unread (:881-882)', async () => {
    const twoDigit = await readTable(textOf(['interface Vxlan1', '   vxlan multicast-group 23.10.10.10', 'end']))
    expect(twoDigit.get('Vxlan1')).toEqual({ name: 'Vxlan1', kind: 'Vxlan' })
    const fourDigit = await readTable(textOf(['interface Vxlan1', '   vxlan multicast-group 1234.10.10.10', 'end']))
    expect(fourDigit.get('Vxlan1')).toEqual({ name: 'Vxlan1', kind: 'Vxlan' })
    // Both quirked reads are faithful to `([\d]{3}\.[\d]+\.[\d]+\.[\d]+)` (`:881-882`): exactly
    // three digits for the leading octet — EOS multicast groups (`224`-`239`) hide that upstream never
    // noticed, and even the unanchored search cannot rescue `1234.` because the class must land right
    // after the keyword space. The write guard (see the writes describe) refuses to CREATE this
    // one-way door; the reader reports what it can read and nothing else.
    const negated = await readTable(textOf(['interface Vxlan1', '   no vxlan multicast-group 239.10.10.10', 'end']))
    expect(negated.get('Vxlan1')?.vxlan).toEqual({ multicastGroup: '239.10.10.10' })
    // A deliberately-kept upstream behaviour: the pattern is UNANCHORED (`re.search`, `:881`) so a
    // value hidden behind `no …` still answers — pyeapi does the same. No EOS capture of such a line
    // exists here (M12 #14); this pin documents the port's reach, not device behaviour.
    const decapOnly = await readTable(textOf(['interface Vxlan1', '   vxlan multicast-group decap', 'end']))
    expect(decapOnly.get('Vxlan1')?.vxlan).toEqual({ multicastDecap: true })
    // `decap` never answers as a group — the pattern needs a digit, here and at `:881`.
  })

  it('decap: the two exact command lines answer; upstream\'s XOR-of-substrings is NOT ported (:887-889)', async () => {
    const neither = await readTable(textOf(['interface Vxlan1', '   vxlan udp-port 4789', 'end']))
    expect(neither.get('Vxlan1')?.vxlan).toEqual({ udpPort: 4789 })
    // Upstream answers `multicast_decap: False` on this section from `bool(val1 ^ val2)` over the raw
    // block (`:887-889`) — the ABSENCE of both substrings collapses into a state (DR-029). Its answer
    // for the fixture's `no vxlan multicast-group decap` line (`:49`) is likewise False but for the
    // coincidental reason that the negation line CONTAINS the positive substring, making both sides
    // true. Neither reach survives here; the whole-command pair does the intended job.
    const prose = await readTable(textOf(['interface Vxlan1', '   description vxlan multicast-group decap', 'end']))
    expect(prose.get('Vxlan1')).toEqual({ name: 'Vxlan1', kind: 'Vxlan', description: 'vxlan multicast-group decap' })
    // Upstream reads `True` here — val1 is a substring hit inside a description, val2 misses. The
    // sflowFromBlock lesson (divergence 16) applied to Vxlan.
    const both = await readTable(textOf(['interface Vxlan1', '   vxlan multicast-group decap', '   no vxlan multicast-group decap', 'end']))
    expect(both.get('Vxlan1')?.vxlan).toEqual({ multicastDecap: true })
    // First body line in device order wins — divergence 3's already-pinned rule restated; upstream's
    // order-blind XOR answers False at either order. A section writing both is not a shape EOS is
    // known to emit (same caveat as the shutdown pair).
  })

  it('the vlan map: the unanchored findall kept verbatim, first-appearance order replacing the frozenset dice (:896-913)', async () => {
    const mixed = await readTable(textOf([
      'interface Vxlan1',
      '   vxlan vlan 20 flood vtep 5.5.5.5  6.6.6.6',
      '   vxlan vlan 10 vni 100',
      '   no vxlan vlan 12 flood vtep',
      'end',
    ]))
    const group = mixed.get('Vxlan1')?.vxlan
    expect([...(group?.vlans?.keys() ?? [])]).toEqual(['20', '10', '12'])
    // Insertion order of the nested Map == first appearance — an object could not pin this, its
    // canonical-integer keys would have surfaced as 10, 12, 20 regardless of write order (divergence 22).
    // The fixture's `no vxlan vlan flood vtep`/`no vxlan vlan learn-restrict vtep` (:46/:48) prove the
    // no-digit forms create nothing (fixture test above); a DIGIT behind `no` does — `vxlan vlan (\d+)`
    // is unanchored at `:902` — and 12 joins as a profile with nothing under it. That is upstream's
    // entry creation verbatim; the `flood vtep`-bare line matches neither side's per-vid flood pattern
    // (both require the space the line does not have), so the list stays empty. (A running-config
    // `no vxlan vlan <n>` line is itself M12 (#14) territory; this pin is about the port rule.)
    expect(group?.vlans?.get('20')).toEqual({ floodList: ['5.5.5.5', '', '6.6.6.6'] })
    // The double space producing an empty STRING entry is upstream's own `matches.group(1).split(' ')`
    // (`:910`) verbatim — not normalised away, because normalising it here while the writer never
    // emits it would hide a shape the reader has to stay honest about.
    expect(group?.vlans?.get('10')).toEqual({ vni: 100, floodList: [] })
    expect(group?.vlans?.get('12')).toEqual({ floodList: [] })
    // Upstream stores `values[vid]['vni'] = match.group(1)` — a STRING — or None (`:905-906`); the
    // number here is `numberFieldFromBlock`'s existing conversion (DR-059), the ABSENT vni is DR-076.
  })

  it('a vni this client cannot hold is reported, not stringified; and the flood class refuses whole lines (:905, :915-919)', async () => {
    const huge = await outcome(() => readTable(textOf(['interface Vxlan1', '   vxlan vlan 10 vni 999999999999999999999999', 'end'])))
    expect(huge).toBeInstanceOf(ConfigParseError)
    expect((huge as Error).message).toContain(`'vxlan vlan 10 vni' in 'interface Vxlan1'`)
    expect((huge as Error).message).toContain('cannot hold as an integer index')
    // Upstream would have stored that 24-digit run as a string (Python ints are unbounded) — a TS
    // number reading it back would silently round, which DR-059 refuses for every field in this file.
    const unreadable = await readTable(textOf(['interface Vxlan1', '   vxlan flood vtep fe80::1', 'end']))
    expect(unreadable.get('Vxlan1')).toEqual({ name: 'Vxlan1', kind: 'Vxlan' })
    // `([\d. ]+)` (`:915`) cannot match `fe80::1`, so the WHOLE line is unread — upstream then answers
    // its `values = list()` default (`:916-919`): a [] that says \"no VTEPs\" about a section that named
    // one. Absence is the honest answer (divergence 21); whether 4.28.13.1M floods to IPv6 VTEPs at
    // all is a device capture, not a claim (DR-032/DR-033), and the write guard below refuses to
    // compose lines this reader would drop.
  })

  it('a non-decimal udp-port is a parse failure naming section and keyword — upstream\'s regex would truncate to 4 (:893, DR-059)', async () => {
    const thrown = await outcome(() => readTable(textOf(['interface Vxlan1', '   vxlan udp-port 4a789', 'end'])))
    expect(thrown).toBeInstanceOf(ConfigParseError)
    expect((thrown as Error).message).toContain(`cannot read 'vxlan udp-port' in 'interface Vxlan1'`)
    expect((thrown as Error).message).toContain('not a decimal number')
    // pyeapi's unanchored `vxlan udp-port (\d+)` (`:893`) happily matches the leading `4` and answers
    // `udp_port: 4` — M9's ipinterfaces truncation (`ipinterfaces.py:126`) in a new place. The
    // keyword-anchored read + {@link numberFieldFromBlock} reports the line instead (rows 43/44's rule,
    // DR-059), and the whole table for that read throws naming the section (DR-059's \"report, never
    // drop\" — same as the min-links pin above).
  })

  it('the group is kind-gated and group-empty sections stay bare (DR-068, divergence 2)', async () => {
    const vlan = await readTable(textOf(['interface Vlan20', '   vxlan udp-port 4789', '   vxlan flood vtep 1.1.1.1', 'end']))
    expect(vlan.get('Vlan20')).toEqual({ name: 'Vlan20', kind: 'Vlan' })
    const unreadHeader = await readTable(textOf(['interface Vx1', '   vxlan udp-port 4789', 'end']))
    expect(unreadHeader.get('Vx1')).toEqual({ name: 'Vx1', kind: null })
    const bare = await readTable(textOf(['interface Vxlan9', '   no shutdown', 'end']))
    expect(bare.get('Vxlan9')).toEqual({ name: 'Vxlan9', kind: 'Vxlan', shutdown: false })
    // `Vx1` is not in the grammar (divergence 1/2's `kind: null` row stays), a Vlan section never
    // carries the Vxlan group whatever its body claims — upstream's class map would likewise route
    // `Vlan20` to `BaseInterface` and never run a `_parse_vxlan`-anything (`:1093-1097`) — and a bare
    // Vxlan section keeps exactly the M10a answer `FLAT_CONFIG`'s `Vxlan5` rows already pin.
  })
})

describe('InterfacesResource Vxlan writes — M10d: interfaces.py:921-1090, the variant pairs and the VTEP truth table (divergences 23/24)', () => {
  it('the source-interface trio sends the texts upstream pins (:443-457)', async () => {
    const transport = configTransport(FLAT_CONFIG)
    for (const inner of ['vxlan source-interface Loopback0', 'no vxlan source-interface', 'default vxlan source-interface']) scriptWrite(transport, pair('Vxlan1', inner))
    const interfaces = new Node(transport).interfaces
    await interfaces.setSourceInterface('Vxlan1', 'Loopback0')
    await interfaces.unsetSourceInterface('Vxlan1')
    await interfaces.defaultSourceInterface('Vxlan1')
    expect(sentAsText(transport)).toEqual([
      ['enable', 'configure terminal', 'interface Vxlan1', 'vxlan source-interface Loopback0'],
      ['enable', 'configure terminal', 'interface Vxlan1', 'no vxlan source-interface'],
      ['enable', 'configure terminal', 'interface Vxlan1', 'default vxlan source-interface'],
    ])
  })

  it('setMulticastGroup attempts the DECAP spelling first — upstream\'s variant order, invisible to its own pins (:960-967, testlib.py:97-107)', async () => {
    const transport = configTransport(FLAT_CONFIG).rejects(writeKey(pair('Vxlan1', 'vxlan multicast-group decap 239.10.10.10')), {
      code: EapiErrorCode.COMMAND_INVALID,
      message: `CLI command 4 of 4 'vxlan multicast-group decap 239.10.10.10' failed: invalid input (the scripted answer this suite invents, not a captured device line)`,
    })
    scriptWrite(transport, pair('Vxlan1', 'vxlan multicast-group 239.10.10.10'))
    await new Node(transport).interfaces.setMulticastGroup('Vxlan1', '239.10.10.10')
    expect(sentAsText(transport)).toEqual([
      ['enable', 'configure terminal', 'interface Vxlan1', 'vxlan multicast-group decap 239.10.10.10'],
      ['enable', 'configure terminal', 'interface Vxlan1', 'vxlan multicast-group 239.10.10.10'],
    ])
    expect(transport.callCount()).toBe(2)
    // `CliVariants(cmds_new, cmds_dpr)` (`:966-967`, with the new-spelling commands built at
    // `:963-965` and the deprecated at `:960-962`): upstream really tries the decap-integrated
    // keyword FIRST, and its suite cannot show that — `testlib.py:97-107` expands every variant and
    // accepts the legacy text `test_set_multicast_group_with_value` (`:458-462`) pins. Whether any
    // real 4.28 train has the first spelling is exactly why upstream kept a fallback — and a probe
    // question here (DR-033), not a support claim.
  })

  it('when BOTH multicast group spellings fail, the last CommandError re-raises — the client.py:644-653 twin', async () => {
    const decapKey = writeKey(pair('Vxlan1', 'vxlan multicast-group decap 224.0.0.1'))
    const legacyKey = writeKey(pair('Vxlan1', 'vxlan multicast-group 224.0.0.1'))
    const transport = configTransport(FLAT_CONFIG)
      .rejects(decapKey, { code: EapiErrorCode.COMMAND_INVALID, message: `CLI command 4 of 4 'vxlan multicast-group decap 224.0.0.1' failed: invalid input (scripted)` })
      .rejects(legacyKey, { code: EapiErrorCode.COMMAND_INVALID, message: `CLI command 4 of 4 'vxlan multicast-group 224.0.0.1' failed: command not authorized (scripted)` })
    const thrown = await outcome(() => new Node(transport).interfaces.setMulticastGroup('Vxlan1', '224.0.0.1'))
    expect(thrown).toBeInstanceOf(CommandError)
    expect((thrown as CommandError).failedCommand).toBe('vxlan multicast-group 224.0.0.1')
    expect(sentAsText(transport).map((cmds) => String(cmds.at(-1)))).toEqual(['vxlan multicast-group decap 224.0.0.1', 'vxlan multicast-group 224.0.0.1'])
    // pyeapi re-raises the LAST variant's error (`raise err`, `client.py:653`); `tryVariants` states
    // the same rule (internal/variants.ts) and the pin shows which message reaches the UI — the legacy
    // spelling, the one upstream's docstrings call canonical.
  })

  it('the no/default arms keep the same variant pairs, and the happy path pays ONE transaction (:961-967)', async () => {
    const transport = configTransport(FLAT_CONFIG)
    for (const inner of ['no vxlan multicast-group decap', 'default vxlan multicast-group decap']) scriptWrite(transport, pair('Vxlan1', inner))
    const interfaces = new Node(transport).interfaces
    await interfaces.unsetMulticastGroup('Vxlan1')
    await interfaces.defaultMulticastGroup('Vxlan1')
    expect(sentAsText(transport)).toEqual([
      ['enable', 'configure terminal', 'interface Vxlan1', 'no vxlan multicast-group decap'],
      ['enable', 'configure terminal', 'interface Vxlan1', 'default vxlan multicast-group decap'],
    ])
    expect(transport.callCount()).toBe(2)
    // Upstream's pins for these two arms (`:463-467`, `:468-472`) show the legacy texts and were
    // accepted as ANY variant — same blind spot as the value arm; a success needs no fallback, so
    // exactly one transaction each is what the wire sees.
  })

  it('the multicast-decap trio: the bare keyword IS the enable, as upstream composes it (:986-991, :473-487)', async () => {
    const transport = configTransport(FLAT_CONFIG)
    for (const inner of ['vxlan multicast-group decap', 'no vxlan multicast-group decap', 'default vxlan multicast-group decap']) scriptWrite(transport, pair('Vxlan1', inner))
    const interfaces = new Node(transport).interfaces
    await interfaces.setMulticastDecap('Vxlan1')
    await interfaces.unsetMulticastDecap('Vxlan1')
    await interfaces.defaultMulticastDecap('Vxlan1')
    expect(sentAsText(transport)).toEqual([
      ['enable', 'configure terminal', 'interface Vxlan1', 'vxlan multicast-group decap'],
      ['enable', 'configure terminal', 'interface Vxlan1', 'no vxlan multicast-group decap'],
      ['enable', 'configure terminal', 'interface Vxlan1', 'default vxlan multicast-group decap'],
    ])
    // Upstream's third branch spells the enable as the bare string list (`cmds = [string]`, `:990`) and
    // only routes through `command_builder` for default/disable (`:986-988`); `commandBuilder`'s
    // `{ value: true }` row produces the identical text (DR-037's table), so one keyword, three modes.
  })

  it('the udp-port trio (:488-502) with the client policy floor — upstream validates nothing (:994-1011)', async () => {
    const transport = configTransport(FLAT_CONFIG)
    for (const inner of ['vxlan udp-port 1024', 'no vxlan udp-port', 'default vxlan udp-port']) scriptWrite(transport, pair('Vxlan1', inner))
    const interfaces = new Node(transport).interfaces
    await interfaces.setUdpPort('Vxlan1', 1024)
    await interfaces.unsetUdpPort('Vxlan1')
    await interfaces.defaultUdpPort('Vxlan1')
    expect(sentAsText(transport)).toEqual([
      ['enable', 'configure terminal', 'interface Vxlan1', 'vxlan udp-port 1024'],
      ['enable', 'configure terminal', 'interface Vxlan1', 'no vxlan udp-port'],
      ['enable', 'configure terminal', 'interface Vxlan1', 'default vxlan udp-port'],
    ])
    await expectRefusal(() => interfaces.setUdpPort('Vxlan1', 0), 'invalid vxlan udp-port value', 'positive integer')
    await expectRefusal(() => interfaces.setUdpPort('Vxlan1', 4789.5), 'invalid vxlan udp-port value')
    await expectRefusal(() => interfaces.setUdpPort('Vxlan1', '1024' as unknown as number), 'invalid vxlan udp-port value')
    // Upstream's test hands the string `'1024'` (`:488-492`) and `command_builder` interpolates it —
    // here the number keeps the write/read pair type-honest (the reader answers a number, divergence
    // 21's conversion); the floor exists so a 0 or a fraction cannot compose a line that drops on
    // read-back (`vni/udp-port (\d+)`, `:893`). The platform's own port range is the device's
    // (DR-032/DR-057 — no 4789/8472 magic here either; 1024 is just the number upstream pins).
  })

  it('addVtep/removeVtep: bare and vlan-scoped are DIFFERENT command texts, both pinned (:513-531)', async () => {
    const transport = configTransport(FLAT_CONFIG)
    for (const inner of ['vxlan flood vtep add 1.1.1.1', 'vxlan vlan 10 flood vtep add 1.1.1.1', 'vxlan flood vtep remove 1.1.1.1', 'vxlan vlan 10 flood vtep remove 1.1.1.1']) scriptWrite(transport, pair('Vxlan1', inner))
    const interfaces = new Node(transport).interfaces
    await interfaces.addVtep('Vxlan1', '1.1.1.1')
    await interfaces.addVtep('Vxlan1', '1.1.1.1', '10')
    await interfaces.removeVtep('Vxlan1', '1.1.1.1')
    await interfaces.removeVtep('Vxlan1', '1.1.1.1', 10)
    expect(sentAsText(transport)).toEqual([
      ['enable', 'configure terminal', 'interface Vxlan1', 'vxlan flood vtep add 1.1.1.1'],
      ['enable', 'configure terminal', 'interface Vxlan1', 'vxlan vlan 10 flood vtep add 1.1.1.1'],
      ['enable', 'configure terminal', 'interface Vxlan1', 'vxlan flood vtep remove 1.1.1.1'],
      ['enable', 'configure terminal', 'interface Vxlan1', 'vxlan vlan 10 flood vtep remove 1.1.1.1'],
    ])
    expect(transport.callCount()).toBe(4)
    // The four upstream pins verbatim: `add_vtep('Vxlan1','1.1.1.1')` (`:513-517`), `vlan='10'`
    // (`:518-522`), and the two remove spells (`:523-531`). A numeric scope (the `10` in the fourth
    // call) interpolates to the same text Python's format() gives — pyeapi stringifies whatever it is
    // handed at `:1033`/`:1055`. Upstream passes the command as a bare string to
    // `configure_interface` (`:1034`/`:1056`); `configureInterface` wraps the one-element list the same
    // way (abstract.py:176-177 was already ported for the base verbs).
  })

  it('the scope argument\'s truthiness is a pinned table: undefined, "" and 0 take the bare arm; the string "0" scopes to vlan 0 (:1030/:1052)', async () => {
    const transport = configTransport(FLAT_CONFIG)
    const bare = pair('Vxlan1', 'vxlan flood vtep add 2.2.2.2')
    const zero = pair('Vxlan1', 'vxlan vlan 0 flood vtep add 2.2.2.2')
    for (let i = 0; i < 3; i++) scriptWrite(transport, bare)
    scriptWrite(transport, zero)
    const interfaces = new Node(transport).interfaces
    await interfaces.addVtep('Vxlan1', '2.2.2.2')
    await interfaces.addVtep('Vxlan1', '2.2.2.2', '')
    await interfaces.addVtep('Vxlan1', '2.2.2.2', 0)
    await interfaces.addVtep('Vxlan1', '2.2.2.2', '0')
    expect(sentAsText(transport).map((cmds) => String(cmds.at(-1)))).toEqual([
      'vxlan flood vtep add 2.2.2.2',
      'vxlan flood vtep add 2.2.2.2',
      'vxlan flood vtep add 2.2.2.2',
      'vxlan vlan 0 flood vtep add 2.2.2.2',
    ])
    // `if not vlan:` (`:1030`, mirrored at `:1052`) is Python truthiness, and the whole point of
    // pinning it as a table is that \"fixing\" the falsy number would change which command an existing
    // pyeapi caller-equivalent gets (divergence 24). The string `'0'` is truthy in Python and composes
    // `vlan 0` — an id pyeapi would happily send and this client faithfully copies; whether the device
    // has such a vlan is its own answer (DR-005).
  })

  it('updateVlan sends the literal `vxlan vlan add <vid> vni <vni>` upstream pins (:503-507, :1072)', async () => {
    const transport = configTransport(FLAT_CONFIG)
    scriptWrite(transport, pair('Vxlan1', 'vxlan vlan add 10 vni 10'))
    await new Node(transport).interfaces.updateVlan('Vxlan1', 10, 10)
    expect(sentAsText(transport)).toEqual([['enable', 'configure terminal', 'interface Vxlan1', 'vxlan vlan add 10 vni 10']])
    // Upstream composes with `%s` on both ints (`:1072`) and its test passes ints 10/10 (`:503-507`) —
    // same command text from the typed numbers here. The add-vs-read asymmetry (the config line the
    // reader parses has no `add`, cf. running_config.vxlan:43) is upstream's, documented on the verb.
    const interfaces = new Node(transport).interfaces
    await expectRefusal(() => interfaces.updateVlan('Vxlan1', 0, 10), 'invalid vlan')
    await expectRefusal(() => interfaces.updateVlan('Vxlan1', 4095, 10), 'invalid vlan')
    await expectRefusal(() => interfaces.updateVlan('Vxlan1', 10, 0), 'invalid vni value', 'positive integer')
    await expectRefusal(() => interfaces.updateVlan('Vxlan1', 10, 1.5), 'invalid vni value')
    // vid through the shared assertVlanId (1..4094, pyeapi's own vlans.py:78 range — the scope is a
    // real vlan on the box), vni by {@link assertVniValue}'s floor with NO invented ceiling: pyeapi
    // bounds nothing (`:1058-1073`) and the platform VNI range is a capture (DR-032/DR-057).
  })

  it('removeVlan attempts the literal-`$` pyeapi really sends, then the clean fallback (:1088-1090, :508-512)', async () => {
    const transport = configTransport(FLAT_CONFIG)
    scriptWrite(transport, pair('Vxlan1', 'vxlan vlan remove 10 vni $'))
    await new Node(transport).interfaces.removeVlan('Vxlan1', 10)
    expect(sentAsText(transport)).toEqual([['enable', 'configure terminal', 'interface Vxlan1', 'vxlan vlan remove 10 vni $']])
    // Yes, the FIRST spelling sent is the `$`-suffixed one: `CliVariants(f'vxlan vlan remove {vid} vni $',
    // f'vxlan vlan remove {vid} vni')` at `:1088-1090`, tried in list order per `client.py:646-652`.
    // Upstream's pin (`:508-512`) shows only the clean text because testlib accepts any expansion — and
    // a probe run on the pinned clone (session notes, 2026-11-06) confirmed the marker reaches
    // `node.config` unfixed, so this client ports the composition verbatim, quirk first.
  })

  it('removeVlan falls back only after a rejection, and a double failure re-raises the clean attempt', async () => {
    const dollarKey = writeKey(pair('Vxlan1', 'vxlan vlan remove 12 vni $'))
    const cleanKey = writeKey(pair('Vxlan1', 'vxlan vlan remove 12 vni'))
    const transport = configTransport(FLAT_CONFIG)
      .rejects(dollarKey, { code: EapiErrorCode.COMMAND_INVALID, message: `CLI command 4 of 4 'vxlan vlan remove 12 vni $' failed: invalid input (scripted)` })
      .replies(cleanKey, okFor(['interface Vxlan1', 'vxlan vlan remove 12 vni']))
    await new Node(transport).interfaces.removeVlan('Vxlan1', 12)
    expect(sentAsText(transport).map((cmds) => String(cmds.at(-1)))).toEqual(['vxlan vlan remove 12 vni $', 'vxlan vlan remove 12 vni'])
    // A SECOND node, so the double-failure path scripts fresh keys — MockTransport keeps the first
    // scripted answer that matches, and re-scripting a replied key would be shadowed, not overridden.
    const both = configTransport(FLAT_CONFIG)
      .rejects(dollarKey, { code: EapiErrorCode.COMMAND_INVALID, message: `CLI command 4 of 4 'vxlan vlan remove 12 vni $' failed: invalid input (scripted)` })
      .rejects(cleanKey, { code: EapiErrorCode.COMMAND_INVALID, message: `CLI command 4 of 4 'vxlan vlan remove 12 vni' failed: vlan not found (scripted)` })
    const thrown = await outcome(() => new Node(both).interfaces.removeVlan('Vxlan1', 12))
    expect(thrown).toBeInstanceOf(CommandError)
    expect((thrown as CommandError).failedCommand).toBe('vxlan vlan remove 12 vni')
    expect(both.callCount()).toBe(2)
    // A non-CommandError would abort before the fallback (tryVariants re-throws it immediately) —
    // that guard belongs to internal/variants.ts and its own suite; the ordering pins here are the
    // module-local consequence (divergence 23).
  })

  it('the reader-derived value guards refuse everything these readers would drop, without touching the wire', async () => {
    const transport = configTransport(FLAT_CONFIG)
    const interfaces = new Node(transport).interfaces
    await expectRefusal(() => interfaces.setSourceInterface('Vxlan1', ''), 'invalid vxlan source-interface', 'unsetSourceInterface')
    await expectRefusal(() => interfaces.setSourceInterface('Vxlan1', 'Loop back'), 'invalid vxlan source-interface', 'single token')
    await expectRefusal(() => interfaces.setSourceInterface('Vxlan1', 'Loopback0 ' as string), 'invalid vxlan source-interface')
    await expectRefusal(() => interfaces.setMulticastGroup('Vxlan1', '23.10.10.10'), 'invalid vxlan multicast-group', 'THREE-digit')
    await expectRefusal(() => interfaces.setMulticastGroup('Vxlan1', 'decap'), 'invalid vxlan multicast-group')
    await expectRefusal(() => interfaces.addVtep('Vxlan1', 'fe80::1'), 'invalid vxlan vtep', 'dotted-quad')
    await expectRefusal(() => interfaces.addVtep('Vxlan1', 'vtep1'), 'invalid vxlan vtep')
    await expectRefusal(() => interfaces.removeVtep('Vxlan1', '1.1.1.1 extra'), 'invalid vxlan vtep')
    await expectRefusal(() => interfaces.addVtep('Vxlan1', '1.1.1.1', 'ten'), 'invalid vxlan vlan scope')
    await expectRefusal(() => interfaces.removeVtep('Vxlan1', '1.1.1.1', -7), 'invalid vxlan vlan scope')
    await expectRefusal(() => interfaces.addVtep('Vxlan1', '1.1.1.1', Number.MAX_SAFE_INTEGER + 1), 'invalid vxlan vlan scope')
    await expectRefusal(() => interfaces.setSourceInterface('Vxlan1', 42 as unknown as string), 'invalid vxlan source-interface')
    await expectRefusal(() => interfaces.setSourceInterface('Vxlan1', 'Loop\u0007back'), 'invalid vxlan source-interface', 'control character')
    await expectRefusal(() => interfaces.setMulticastGroup('Vxlan1', 239 as unknown as string), 'invalid vxlan multicast-group')
    await expectRefusal(() => interfaces.addVtep('Vxlan1', 1 as unknown as string), 'invalid vxlan vtep')
    await expectRefusal(() => interfaces.updateVlan('Vxlan1', 10, '100' as unknown as number), 'invalid vni value')
    expect(transport.sent()).toEqual([])
    // Every refusal names what its own reader cannot reproduce: the token pattern `([^\s]+)` (:876),
    // the group octet shape (:881-882 — `'decap'` is the SUB-FORM keyword, served by
    // setMulticastDecap, never a group value), the flood class `([\d. ])` (:915), the scope token
    // `vxlan vlan (\d+)` (:902). Pyeapi itself validates none of this (:921-1090 interpolate raw) —
    // the guards are client policy, the device remains the authority (divergence 24, DR-053).
  })

  it('every Vxlan verb refuses non-Vxlan and dotted names, naming the `Vx` class-map surface (:120-127, :1093-1097)', async () => {
    const transport = configTransport(FLAT_CONFIG)
    const interfaces = new Node(transport).interfaces
    const wrong: readonly string[] = ['Ethernet1', 'Port-Channel1', 'Vlan22', 'Management1', 'Loopback2', 'Vxlan1.1', 'Vxlan', 'Vx1', 'vxlan1']
    for (const name of wrong) {
      await expectRefusal(() => interfaces.setSourceInterface(name, 'Loopback0'), `invalid setSourceInterface interface`)
      await expectRefusal(() => interfaces.unsetSourceInterface(name), 'invalid unsetSourceInterface interface')
      await expectRefusal(() => interfaces.setMulticastGroup(name, '239.10.10.10'), 'invalid setMulticastGroup interface')
      await expectRefusal(() => interfaces.setMulticastDecap(name), 'invalid setMulticastDecap interface')
      await expectRefusal(() => interfaces.setUdpPort(name, 4789), 'invalid setUdpPort interface')
      await expectRefusal(() => interfaces.addVtep(name, '1.1.1.1'), 'invalid addVtep interface')
      await expectRefusal(() => interfaces.removeVtep(name, '1.1.1.1'), 'invalid removeVtep interface')
      await expectRefusal(() => interfaces.updateVlan(name, 10, 100), 'invalid updateVlan interface')
      await expectRefusal(() => interfaces.removeVlan(name, 10), 'invalid removeVlan interface')
    }
    expect(transport.sent()).toEqual([])
    // The same facade-surface decision as assertEthernetName/assertPortChannelName (row 128's
    // argument, DR-068): upstream's instance methods would happily run these on any kind — its suite
    // drives the base verbs over the six-kind INTERFACES list (`test_api_interfaces.py:44-45`) — but
    // the only surface pyeapi itself has is the `Vx` prefix of `get_instance` + `INTERFACE_CLASS_MAP`
    // (`:120-127`, `:1093-1097`), and no kind OTHER than Vxlan carries a `vxlan …` sub-mode anywhere in
    // upstream. Whether the 7050TX-64 binds them elsewhere anyway stays an M12 (#14) capture
    // (DR-032/DR-033); the refusal message never claims the platform cannot.
  })

  it('the device keeps authority on an accepted Vxlan name — and VXLAN support itself is probe territory (DR-005/DR-033)', async () => {
    const transport = configTransport(FLAT_CONFIG).rejects(writeKey(pair('Vxlan1', 'vxlan source-interface Loopback0')), {
      code: EapiErrorCode.COMMAND_INVALID,
      message: `CLI command 4 of 4 'vxlan source-interface Loopback0' failed: this command is not available on this platform (scripted mock text, NOT a captured device line)`,
    })
    const thrown = await outcome(() => new Node(transport).interfaces.setSourceInterface('Vxlan1', 'Loopback0'))
    expect(thrown).toBeInstanceOf(CommandError)
    expect((thrown as CommandError).failedCommand).toBe('vxlan source-interface Loopback0')
    // The mock's message is the suite's own fixture wording; what is pinned is the SHAPE of the
    // answer — a rejection on a name and value this client accepts arrives as the device's
    // CommandError, never as a silent True (DR-005) and never as a swallowed success. Whether the
    // 7050TX-64 supports VXLAN at all is UNVERIFIED (probe question, DR-033): every command in both
    // M10d describes is pyeapi-faithful, that is the only claim.
  })

  it('presence verbs need NO Vxlan-specific work — upstream inherits BaseInterface and M10a\'s pins already carry the kind (divergence 25)', async () => {
    const transport = configTransport(FLAT_CONFIG)
    const createKey = writeKey(['interface Vxlan1'])
    const deleteKey = writeKey(['no interface Vxlan1'])
    const transport2 = transport.replies(createKey, okFor(['interface Vxlan1'])).replies(deleteKey, okFor(['no interface Vxlan1']))
    const interfaces = new Node(transport2).interfaces
    await interfaces.create('Vxlan1')
    await interfaces.delete('Vxlan1')
    expect(sentAsText(transport2)).toEqual([
      ['enable', 'configure terminal', 'interface Vxlan1'],
      ['enable', 'configure terminal', 'no interface Vxlan1'],
    ])
    // `VxlanInterface` overrides no `create`/`delete`/`default` — pyeapi composes these three from
    // `BaseInterface` (`:211-254`) for it via the `Vx` class-map row (`:1096`), and its suite pins none
    // of them for Vxlan specifically. The M10a create/delete loops have carried `Vxlan5`/`Vxlan9`
    // since PR #30 (this file, the `names` arrays at :1050/:1102 — verified 2026-11-07), so the port
    // here is a no-op by design and this test is the pin saying so out loud (the refusal-vs-port
    // convention includes the null cases).
  })
})
