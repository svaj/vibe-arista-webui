/**
 * `StpResource` / `StpInterfacesResource` / `StpInstancesResource` — W2c (#39 #40), the port of
 * `pyeapi/api/stp.py`, driven through `MockTransport` over the real `Node` (`node.stp`), so every read
 * answer is device text and every write answer is an exact command script (docs/TESTING.md §3). No fixture
 * file is added by this suite: every config below is inline and hand-authored, so `test/fixtures/config/`
 * and its manifest stay untouched.
 *
 * ## Upstream port ledger (verified against the pinned clone on 2026-11-05)
 *
 * Upstream's suite is `pyeapi/test/unit/test_api_stp.py` — **21** test methods (AST count, and the file this
 * lane's brief called `test/unit/test_stp.py` does not exist): 7 in `TestApiStp` (`:46-84`) and 14 in
 * `TestApiStpInterfaces` (`:86-184`). The spans in `stp.ts`'s header were **off by five** (they cite
 * `:44-108`/`:111-216` and `test_instance (:48-50)`, `test_set_mode_with_value (:60-65)`, `…_invalid_value
 * (:77-80)`); the real ones are listed here and in `stp.ts` (fixed in this commit):
 * `test_instance` (`:53-55`), `test_interfaces` (`:57-59`), `test_instances` (`:61-63`),
 * `test_set_mode_with_value` (`:65-69`), `test_set_mode_with_default` (`:71-74`),
 * `test_set_mode_with_disable` (`:76-79`), `test_set_mode_invalid_value_raises_value_error` (`:81-84`),
 * `TestApiStpInterfaces.test_getall` (`:95-97`), `test_set_portfast_type_with_value` (`:99-107`),
 * `test_set_portfast_type_with_no_value` (`:109-113`),
 * `test_set_portfast_type_invalid_value_raises_value_error` (`:115-119`),
 * `test_set_portfast_type_invalid_intf_raises_value_error` (`:121-124`),
 * `test_set_bpduguard_with_value` (`:126-133`), `test_set_bpduguard_with_no_value` (`:135-139`),
 * `test_set_bpduguard_with_default` (`:141-145`), `test_set_bpduguard_with_disable` (`:147-151`),
 * `test_set_bpduguard_invalid_intf_raises_value_error` (`:153-156`), `test_set_portfast_with_value`
 * (`:158-167`), `test_set_portfast_with_no_value` (`:169-173`), `test_set_portfast_with_default`
 * (`:175-179`), `test_set_portfast_invalid_intf_raises_value_error` (`:181-184`).
 * All 21 ride below. Upstream also drives everything through `EapiConfigUnitTest`, whose `MockConnection`
 * answers `{}` to anything it was not told about, and its assertions only cover the **write** side plus one
 * type check (`test_getall` at `:95-97` asserts `isinstance(result, dict)`): `Stp.get`, `StpInstances` and
 * `StpInterfaces.get`/`getall` content are never asserted. So the read assertions here are against configs of
 * our own, each one first probed against the pinned classes (see the probe note at the bottom).
 *
 * Upstream's own interface list, `INTERFACES = ['Ethernet1', 'Ethernet1/1', 'Port-Channel1']` (`:88`), is
 * reproduced here as far as this client's name grammar allows — and `Ethernet1/1` is where the two part:
 * writing a spanning-tree command to a chassis-slot name is what upstream does (its `isvalidinterface` is
 * only `value[0:2] in ['Et','Po']`, `:363`) and what {@link assertStpPortName} in `stp.ts` refuses pending
 * DECISIONS.md open item 7 (§5 row 168). Both answers are pinned below rather than smoothed over.
 *
 * ## What the "probe" claims rest on
 *
 * Every upstream answer quoted in an assertion comment below came from running the pinned classes
 * (`pyeapi.api.stp` at `6816d9e`) against `pyeapi.client.Node(None)` with `_running_config` set to the config
 * text named in that test and `node.config` recording the command list — the same shape as
 * `pyeapi/test/lib/testlib.py:74-80`, run 2026-11-05 for this suite (`isvalidinterface`'s accept/refuse split,
 * the `TypeError` behind `get('Ethernet99')`/`getall()` over a banner body, the always-populated defaults for
 * a bare `interface Ethernet9` section, `'spanning-tree portfast None'` for `set_portfast_type(…, None)`, the
 * `['interface Ethernet1', 'spanning-tree portfast normal']` list its default argument produces, and the
 * `ValueError('invalid interface value specified')` family). Nothing below claims what the DCS-7050TX-64 or
 * EOS 4.28.13.1M does: unit tests never reach a device and this workspace has no readable CLI sources for the
 * spanning-tree daemon, so every EOS-side rule reads "unverified on hardware, M12 (#14) to capture" —
 * including whether `rapid-pvst` exists on this SKU (**DR-096**, §5 row 167) and whether EOS accepts
 * `default spanning-tree mode` at all (§5 row 167).
 */

import { describe, expect, it } from 'vitest'

import { Node } from '../command-layer'
import { CommandError, EapiErrorCode, NotSupportedError } from '../errors'
import { mockTransport, type MockReply, type MockTransport } from '../testing/mock-transport'
import { isPortfastType, isStpMode, PORTFAST_TYPES, StpInstancesResource, StpInterfacesResource, StpResource, STP_MODES } from './stp'
import type { PortfastType, StpMode, StpSettings } from './stp'
import type { ResourceTable } from './types'

/** Join lines into config text so a trailing-space line cannot be lost to an editor. */
const textOf = (lines: readonly string[]): string => lines.join('\n')

/**
 * A spanning-tree-shaped config for the read tests: a mode line at indent 0, one port with the full
 * portfast/bpduguard pair, one bare `interface` section (the always-populated-defaults case), a
 * Port-Channel, the two junk-prefix spellings upstream's gate admits, and the four kinds it excludes.
 */
const STP_CONFIG = textOf([
  'hostname lab-sw1',
  'spanning-tree mode mstp',
  '!',
  'interface Ethernet1',
  '   spanning-tree bpduguard enable',
  '   spanning-tree portfast network',
  '!',
  'interface Ethernet9',
  '!',
  'interface Port-Channel3',
  '   spanning-tree portfast edge',
  '!',
  'interface Et1',
  '   no spanning-tree portfast',
  '!',
  'interface Poke1',
  '   spanning-tree bpduguard enable',
  '!',
  'interface Vlan20',
  '   ip address 10.20.0.1/24',
  '   spanning-tree mode none',
  '!',
  'interface Management1',
  '   ip address 192.168.1.16/24',
  '!',
  'interface Loopback0',
  '   ip address 1.1.1.1/32',
  '!',
  'interface Vxlan1',
  '   vxlan vlan 10 vni 1010',
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
function stpFor(config: string): StpResource {
  return nodeFor(config).node.stp
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
 * (`refuse` in `stp.ts`, the same shape as `validators.ts:226-229`), so `label` is a substring pin on the
 * labelled argument and `why` is a substring or a pattern.
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

describe('StpResource — wiring, the pyeapi composition parity (stp.py:88-91, :118-130)', () => {
  it('node.stp is the registered StpResource, memoised per Node (registry row + DR-052)', () => {
    const node = new Node(mockTransport())
    expect(node.hasResource('stp')).toBe(true)
    expect(node.stp).toBeInstanceOf(StpResource)
    expect(node.stp).toBe(node.resource('stp'))
    expect(node.stp).toBe(node.stp)
  })

  it('stp.interfaces is one memoised StpInterfacesResource — pyeapi test_interfaces (:57-59), the _interfaces field (:90)', async () => {
    const { node, transport } = nodeFor(STP_CONFIG)
    const interfaces = node.stp.interfaces
    expect(interfaces).toBeInstanceOf(StpInterfacesResource)
    expect(node.stp.interfaces).toBe(interfaces)
    // The sub-view shares this Node\'s config memo (DR-026), so two sequential reads of the table cost one
    // read in total — the same fact `node.switchports` pins (`switchports.test.ts:158-167`).
    await interfaces.getAll()
    await node.stp.interfaces.getAll()
    expect(transport.callCount()).toBe(1)
  })

  it('stp.instances is one memoised StpInstancesResource — pyeapi test_instances (:61-63), the _instances field (:91)', () => {
    const stp = stpFor(STP_CONFIG)
    expect(stp.instances).toBeInstanceOf(StpInstancesResource)
    expect(stp.instances).toBe(stp.instances)
    expect(stp.instances).toBeInstanceOf(StpInstancesResource)
  })

  it('the module vocabularies are upstream\'s literal sets (STP_MODES :151, the portfast chain :221-228 / :274)', () => {
    expect(STP_MODES).toEqual(['mstp', 'none'])
    expect(PORTFAST_TYPES).toEqual(['edge', 'network', 'normal'])
    expect(isStpMode('mstp')).toBe(true)
    expect(isStpMode('none')).toBe(true)
    // A token the device could write but this client does not spell is not one of the write-side modes
    // (DR-096): that is a vocabulary fact, not a claim that the SKU lacks the feature.
    expect(isStpMode('rapid-pvst')).toBe(false)
    expect(isStpMode(undefined)).toBe(false)
    expect(isPortfastType('edge')).toBe(true)
    // `auto` is what EOS writes beside `portfast edge`; upstream\'s chain never produces it and its writer
    // never lists it, yet a section can carry it — so the read keeps it and the narrow says so (row 170).
    expect(isPortfastType('auto')).toBe(false)
    expect(isPortfastType('disabled')).toBe(false)
  })
})

describe('StpResource.get — stp.py:93-116 plus the mode its docstring (:109-113) promises and its code omits', () => {
  it('answers interfaces, instances and the mode line in ONE running-config read (row 167/DR-030)', async () => {
    const { node, transport } = nodeFor(STP_CONFIG)
    const settings = await node.stp.get()
    expect([...settings.interfaces.keys()]).toEqual(['Ethernet1', 'Ethernet9', 'Port-Channel3', 'Et1', 'Poke1'])
    expect(settings.instances.size).toBe(0)
    expect(settings.mode).toBe('mstp')
    expect(transport.callCount()).toBe(1)
    expect(sentAsText(transport)).toEqual([['enable', 'show running-config all']])
  })

  it('upstream\'s get() has no mode key at all — the docstring shape (:109-113) is a lie its code tells (row 167)', async () => {
    // Probe over this same config: `Stp.get()` answers keys `['instances', 'interfaces']`, while `set_mode`
    // writes the line (`:154-155`) and `test_set_mode_with_value` (`:65-69`) pins that it is configured.
    // Here the key is present whenever the running-config carries it, so a UI does not scan config text by hand.
    const settings = await stpFor(STP_CONFIG).get()
    expect(Object.keys(settings).sort()).toEqual(['instances', 'interfaces', 'mode'])
  })

  it('an empty config answers empty tables and no mode key — the empty state is an answer, not a failure', async () => {
    const settings = await stpFor(textOf(['hostname lab', 'end'])).get()
    expect(settings.interfaces.size).toBe(0)
    expect(settings.instances.size).toBe(0)
    expect('mode' in settings).toBe(false)
    const empty: StpSettings = { interfaces: new Map(), instances: new Map() }
    expect(settings).toEqual(empty)
  })

  it('the mode is only read from an indent-0 section key: an interface sub-mode and a banner body cannot state it (row 84\'s rule)', async () => {
    // `interface Vlan20` above carries an indented `spanning-tree mode none` (not a real EOS line, which is
    // the point of writing it here): reading keys, not text, is what DR-055/row 84 established for
    // `hostname`, and what a `banner` body would otherwise defeat.
    const submode = await stpFor(textOf(['interface Vlan20', '   spanning-tree mode mstp', 'end'])).get()
    expect('mode' in submode).toBe(false)

    const banner = textOf(['banner login EOF', 'spanning-tree mode none', 'EOF', '!', 'interface Ethernet1', '   no spanning-tree portfast', '!', 'end'])
    const settings = await stpFor(banner).get()
    expect(settings.mode).toBeUndefined()
    // …and the banner body line is not a spanning-tree interface either (row 169).
    expect([...settings.interfaces.keys()]).toEqual(['Ethernet1'])
  })

  it('the first mode line in device order wins, and the token is kept verbatim even when it is not a mode this client writes', async () => {
    // Two mode lines is a malformed config, but the rule is the one M10a (#12) set for a field with two
    // spellings (row 102): device order decides. `rapid-pvst` reads here because reading is reporting —
    // writing it is refused, and which modes this build has is the M11 #13 probe\'s answer (DR-096).
    const settings = await stpFor(textOf(['spanning-tree mode rapid-pvst', 'spanning-tree mode mstp', 'end'])).get()
    expect(settings.mode).toBe('rapid-pvst')
    expect(isStpMode(settings.mode)).toBe(false)
    const both = await stpFor(textOf(['spanning-tree mode mstp', 'spanning-tree mode none', 'end'])).get()
    expect(both.mode).toBe('mstp')
    // `none` is a mode value, not an absent line.
    expect('mode' in both).toBe(true)
  })

  it('the interfaces half of get() is exactly what stp.interfaces.getAll() answers', async () => {
    const stp = stpFor(STP_CONFIG)
    expect((await stp.get()).interfaces).toEqual(await stp.interfaces.getAll())
  })

  it('a read the device refuses rejects with the device error, never with an empty panel', async () => {
    const transport = mockTransport().rejects('show running-config all', {
      code: EapiErrorCode.COMMAND_INVALID,
      message: "CLI command 2 of 2 'show running-config all' failed: invalid input",
    })
    const thrown = await outcome(() => new Node(transport).stp.get())
    expect(thrown).toBeInstanceOf(CommandError)
    expect((thrown as CommandError).failedCommand).toBe('show running-config all')
  })
})

describe('StpResource mode writers — stp.py:132-156 and the four command texts test_api_stp.py:65-84 pins', () => {
  it('setMode spells `spanning-tree mode mstp` / `spanning-tree mode none`, one batch, zero reads (:65-69)', async () => {
    const transport = configTransport(STP_CONFIG)
    const stp = new Node(transport).stp
    for (const mode of STP_MODES) scriptWrite(transport, [`spanning-tree mode ${mode}`])
    for (const mode of STP_MODES) await stp.setMode(mode)
    // Upstream hands `configure` a bare **string** here (`return self.configure(cmds)`, `:156`, where `cmds`
    // is the single string from `command_builder`), which probe records as one string, not a list — the TS
    // `configure` normalises through `toArray` (row 71), so the same one command leaves as one entry.
    expect(sentAsText(transport)).toEqual([
      ['enable', 'configure terminal', 'spanning-tree mode mstp'],
      ['enable', 'configure terminal', 'spanning-tree mode none'],
    ])
    expect(transport.callCount()).toBe(2)
  })

  it('unsetMode is upstream\'s disable=True arm: `no spanning-tree mode` (:76-79)', async () => {
    const transport = configTransport(STP_CONFIG)
    scriptWrite(transport, ['no spanning-tree mode'])
    await new Node(transport).stp.unsetMode()
    expect(sentAsText(transport)).toEqual([['enable', 'configure terminal', 'no spanning-tree mode']])
  })

  it('defaultMode sends `default spanning-tree mode` even though the docstring says the parameter is not defaultable (:71-74, :134-136)', async () => {
    const transport = configTransport(STP_CONFIG)
    scriptWrite(transport, ['default spanning-tree mode'])
    await new Node(transport).stp.defaultMode()
    // Probe: upstream `set_mode(default=True)` sends exactly this string (`:154-155` → `abstract.py:152-153`).
    // Whether EOS answers it or refuses is M12 #14; the pinned test only proves pyeapi sends it (DR-005).
    expect(sentAsText(transport)).toEqual([['enable', 'configure terminal', 'default spanning-tree mode']])
  })

  it('a mode outside the two this client spells is refused by name, at zero round trips (:81-84)', async () => {
    const transport = configTransport(STP_CONFIG)
    const stp = new Node(transport).stp
    // Upstream\'s guard is the literal list at `:151` and its `ValueError("Specified value must be one of
    // 'mstp', 'none'")`; probe confirms a random value never reaches `command_builder`. Here the refusal is
    // `NotSupportedError` naming the value, and it still refuses the mode upstream refuses.
    await expectRefusal(() => stp.setMode('banana' as unknown as StpMode), "invalid spanning-tree mode 'banana'", /expected one of mstp \/ none/)
    await expectRefusal(() => stp.setMode('rapid-pvst' as unknown as StpMode), "invalid spanning-tree mode 'rapid-pvst'", /7050X-family-derived/)
    // `undefined` is rendered as `None` because the rejected argument is shown with `pythonRepr`
    // (`internal/wire.ts`, the CPython-parity rendering DR-010 keeps for pyeapi error text).
    await expectRefusal(() => stp.setMode(undefined as unknown as StpMode), 'invalid spanning-tree mode None')
    await expectRefusal(() => stp.setMode('' as unknown as StpMode), "invalid spanning-tree mode ''")
    expect(transport.sent()).toEqual([])
  })

  it('a mode write the device refuses comes back as CommandError with the failed command (DR-005, never upstream\'s False)', async () => {
    const batch = ['spanning-tree mode mstp']
    const transport = mockTransport().rejects(writeKey(batch), {
      code: EapiErrorCode.COMMAND_INVALID,
      message: "CLI command 3 of 3 'spanning-tree mode mstp' failed: this platform does not support mst",
    })
    const thrown = await outcome(() => new Node(transport).stp.setMode('mstp'))
    expect(thrown).toBeInstanceOf(CommandError)
    expect((thrown as CommandError).failedCommand).toBe('spanning-tree mode mstp')
  })
})

describe('StpInterfacesResource reads — stp.py:181-248 with the module\'s own two-character gate (:244, :363)', () => {
  it('getAll keeps upstream\'s accept set, including the spellings this client will not write (row 168)', async () => {
    const { node, transport } = nodeFor(STP_CONFIG)
    const all = await node.stp.interfaces.getAll()
    // Probe of `isvalidinterface` (`:363`), run 2026-11-05: `Ethernet1`, `Ethernet1/1`, `Et1`, `Po1`,
    // `Poke1`, `Port-Channel1`, `Po1.100` and even a bare `Et` pass, while `Vlan20`, `Management1`,
    // `Loopback0`, `Vxlan1` and a bare `P` do not. `getall` (`:244`) applies the same `name[0:2]` test, so
    // the membership set below is that set — `Poke1` included, which no operator has on a switch.
    expect([...all.keys()]).toEqual(['Ethernet1', 'Ethernet9', 'Port-Channel3', 'Et1', 'Poke1'])
    expect(all.get('Vlan20')).toBeUndefined()
    expect(all.get('Management1')).toBeUndefined()
    expect(all.get('Loopback0')).toBeUndefined()
    expect(all.get('Vxlan1')).toBeUndefined()
    // Upstream pays a `section()` key scan plus three substring tests PER entry (`:245` → `get` → `get_block`
    // → `client.py:792-797`). Here the whole table is one read, and a single-field write costs none.
    expect(transport.callCount()).toBe(1)
  })

  it('a section with no spanning-tree line at all answers the three defaults upstream answers (row 170, :213-228)', async () => {
    const all = await stpFor(STP_CONFIG).interfaces.getAll()
    // Probe: `StpInterfaces.get('Ethernet9')` over a bare section answers
    // `{'bpduguard': False, 'portfast': True, 'portfast_type': 'edge'}` — a record, never an empty dict —
    // because all three `_parse_*` methods always return a value. Keeping those defaults is a parity choice
    // (row 170): inventing an "absent" marker for a field upstream always populates is a different resource.
    expect(all.get('Ethernet9')).toEqual({ interfaceName: 'Ethernet9', portfast: true, portfastType: 'edge', bpduguard: false })
    expect(all.get('Ethernet1')).toEqual({ interfaceName: 'Ethernet1', portfast: true, portfastType: 'network', bpduguard: true })
    // The entry is named from the section header, not from a `name` key upstream\'s docstring lists (`:186`)
    // but its code never sets (divergence 5, DR-029\'s rule as `switchports.ts` row 96 applies it).
    expect(all.get('Et1')).toEqual({ interfaceName: 'Et1', portfast: false, portfastType: 'normal', bpduguard: false })
  })

  it('get() answers upstream\'s None and its TypeError with the same absence, and costs no extra read (row 169, DR-027)', async () => {
    const { node, transport } = nodeFor(STP_CONFIG)
    const interfaces = node.stp.interfaces
    expect((await interfaces.get('Ethernet1'))?.bpduguard).toBe(true)
    // Upstream: `get('Vlan20')` answers `None` through the gate (`:203-204`), but `get('Ethernet99')` — a
    // name that passes the gate with no section — runs the `None` from `get_block` (`abstract.py:97-101`)
    // through `_parse_bpduguard` and raises `TypeError: argument of type 'NoneType' is not iterable` (probe).
    expect(await interfaces.get('Vlan20')).toBeUndefined()
    expect(await interfaces.get('Ethernet99')).toBeUndefined()
    // …and the shorthands behave the same way here even though they are members of the gate upstream admits:
    // with no `interface Et1` section in that config, upstream raises for `get('Et')`-shaped names too (probe:
    // `Et1`, `Po1`, `Poke1` all `TypeError` over the fixture that lacks those sections).
    const noShorthands = nodeFor(textOf(['interface Ethernet1', 'end'])).node.stp.interfaces
    expect(await noShorthands.get('Et1')).toBeUndefined()
    expect(await noShorthands.get('Poke1')).toBeUndefined()
    expect(transport.callCount()).toBe(1)
  })

  it('keys/has/entries ride the one read, in device order (row 78, DR-030)', async () => {
    const { node, transport } = nodeFor(STP_CONFIG)
    const interfaces = node.stp.interfaces
    expect(await interfaces.has('Port-Channel3')).toBe(true)
    expect(await interfaces.has('Vlan20')).toBe(false)
    expect(await interfaces.keys()).toEqual(['Ethernet1', 'Ethernet9', 'Port-Channel3', 'Et1', 'Poke1'])
    expect((await interfaces.entries()).map(([name]) => name)).toEqual(['Ethernet1', 'Ethernet9', 'Port-Channel3', 'Et1', 'Poke1'])
    expect(transport.callCount()).toBe(1)
  })

  it('an unconfigured table is an empty map, not an error — and one read still', async () => {
    const { node, transport } = nodeFor(textOf(['spanning-tree mode none', 'end']))
    const all = await node.stp.interfaces.getAll()
    expect(all.size).toBe(0)
    expect(all).toEqual(new Map())
    expect(transport.callCount()).toBe(1)
  })

  it('the negation of a portfast command is matched as a whole line, so a typed negation cannot flip the bare flag (row 170)', async () => {
    // Probe over `no spanning-tree portfast network`: upstream answers
    // `{'bpduguard': False, 'portfast': False, 'portfast_type': 'network'}` — `:218`\'s substring
    // `'no spanning-tree portfast' in config` fires inside the typed negation and flips the bare flag.
    // Here the check is one body line equal to `no spanning-tree portfast`, so the flag follows the type.
    const one = textOf(['interface Ethernet4', '   no spanning-tree portfast network', 'end'])
    // Neither field follows the negation here: the flag test wants the exact bare negation, and the token
    // lookup wants a line that *starts* with `spanning-tree portfast`, so the typed negation contributes
    // nothing and the fallback chain lands on `edge` (upstream, probe, answers `portfast: False` +
    // `portfast_type: 'network'` from the two substrings inside this one line).
    expect(await stpFor(one).interfaces.get('Ethernet4')).toEqual({
      interfaceName: 'Ethernet4',
      portfast: true,
      portfastType: 'edge',
      bpduguard: false,
    })
    // The bare negation still means what it means, and `portfastType` falls back to upstream\'s chain (:224-225).
    const bare = textOf(['interface Ethernet5', '   no spanning-tree portfast', 'end'])
    expect(await stpFor(bare).interfaces.get('Ethernet5')).toEqual({
      interfaceName: 'Ethernet5',
      portfast: false,
      portfastType: 'normal',
      bpduguard: false,
    })
  })

  it('portfastType keeps the token the device wrote; upstream\'s chain answers one of three words (row 170)', async () => {
    // Probe: a section carrying only `spanning-tree portfast auto` answers `portfast_type: 'edge'` upstream,
    // because `:221-227`\'s chain only inspects `network` and the negation. Here the token is the first
    // `spanning-tree portfast <token>` line, so `auto` survives — and `isPortfastType` narrows it for a UI
    // exactly as `isSwitchportMode` does for `Switchport.mode` (row 98).
    const auto = await stpFor(textOf(['interface Ethernet3', '   spanning-tree portfast auto', 'end'])).interfaces.get('Ethernet3')
    expect(auto?.portfastType).toBe('auto')
    expect(auto?.portfast).toBe(true)
    expect(isPortfastType(auto?.portfastType)).toBe(false)
    // A section writing both words: upstream\'s precedence answers `network`, here device order decides
    // (row 102\'s rule) — the one case where the two readers disagree on a well-formed config.
    const pair = await stpFor(textOf(['interface Ethernet6', '   spanning-tree portfast edge', '   spanning-tree portfast network', 'end'])).interfaces.get('Ethernet6')
    expect(pair?.portfastType).toBe('edge')
    expect(isPortfastType(pair?.portfastType)).toBe(true)
  })

  it('a comment, a negation or another command\'s text cannot state a spanning-tree field (probes: upstream reads all three)', async () => {
    // All three sections below answer `bpduguard: True` upstream — `'spanning-tree bpduguard enable' in
    // config` (`:214`) is a substring test over the raw block: a commented line (`! …`), a negated
    // `no spanning-tree bpduguard`, and a `description` that merely contains the command text.
    const config = textOf([
      'interface Ethernet6',
      '   ! spanning-tree bpduguard enable',
      '   no spanning-tree bpduguard',
      '!',
      'interface Ethernet7',
      '   description spanning-tree bpduguard enable',
      '!',
      'interface Ethernet8',
      '   spanning-tree bpduguard disable',
      'end',
    ])
    const all = await stpFor(config).interfaces.getAll()
    expect(all.get('Ethernet6')?.bpduguard).toBe(false)
    expect(all.get('Ethernet7')?.bpduguard).toBe(false)
    // The `disable` **word** is what `setBpduguard(false)` writes, and it reads back false — the writer and
    // this reader are the same contract (row 170/divergence 8).
    expect(all.get('Ethernet8')?.bpduguard).toBe(false)
    expect(all.get('Ethernet8')?.portfastType).toBe('edge')
    // The positive word is the only thing that answers true.
    const on = await stpFor(textOf(['interface Ethernet1', '   spanning-tree bpduguard enable', 'end'])).interfaces.get('Ethernet1')
    expect(on?.bpduguard).toBe(true)
  })

  it('a column-0 `interface …` line inside a banner body is neither a member nor a crash (row 169)', async () => {
    // Probe: over a config whose `banner login` body starts a line with `interface Et1`, upstream\'s
    // `getall()` (`:240` regex over the whole text) finds the name, `get_block` answers `None`, and
    // `_parse_bpduguard` raises `TypeError: argument of type 'NoneType' is not iterable` — the whole table
    // fails. Here membership is the chunked document\'s indent-0 keys (`src/config/chunk.ts`,
    // `client.py:747-750`), so the banner is its own section.
    const config = textOf(['banner login EOF', 'interface Et1', '   spanning-tree bpduguard enable', 'EOF', '!', 'interface Ethernet2', 'end'])
    const all = await stpFor(config).interfaces.getAll()
    expect([...all.keys()]).toEqual(['Ethernet2'])
    expect(await stpFor(config).interfaces.get('Et1')).toBeUndefined()
  })

  it('a subinterface section reads, and an indented copy of the command text is not a section (parity with :240 for the dotted form)', async () => {
    // Upstream\'s `getall` finds `Ethernet48.2044` in its own fixture (probe: `stp getall` keys include it),
    // and keeps only indent-0 `interface` headers here — an indented `interface …` line inside another
    // section cannot open a spanning-tree entry.
    const all = await stpFor(textOf(['interface Ethernet48.2044', '   spanning-tree bpduguard enable', '!', 'interface Ethernet1', '   interface Ethernet2', '   spanning-tree portfast network', 'end'])).interfaces.getAll()
    expect(all.get('Ethernet48.2044')?.bpduguard).toBe(true)
    expect(all.get('Ethernet2')).toBeUndefined()
    expect(all.get('Ethernet1')?.portfastType).toBe('network')
  })

  it('an interface-table read the device refuses rejects with CommandError', async () => {
    const transport = mockTransport().rejects('show running-config all', {
      code: EapiErrorCode.COMMAND_INVALID,
      message: "CLI command 2 of 2 'show running-config all' failed: invalid input",
    })
    const thrown = await outcome(() => new Node(transport).stp.interfaces.getAll())
    expect(thrown).toBeInstanceOf(CommandError)
    // `failedCommand` is derived from the CLI prefix the device prints (`internal/wire.ts:413-415`), so the
    // assertion doubles as a pin that the failing command is the read, not the `enable` opener.
    expect((thrown as CommandError).failedCommand).toBe('show running-config all')
  })
})

describe('StpInterfacesResource writers — stp.py:250-343 and the twelve command groups test_api_stp.py:95-184 pins', () => {
  /** The three names upstream drives its writer loops over (`:88`), as far as this client\'s grammar goes. */
  const UPSTREAM_INTERFACES = ['Ethernet1', 'Port-Channel1'] as const

  it('setPortfastType sends upstream\'s two-line pair for edge, and one line for network/normal (:99-107)', async () => {
    const transport = configTransport(STP_CONFIG)
    const batches: string[][] = [
      ['interface Ethernet1', 'spanning-tree portfast edge', 'spanning-tree portfast auto'],
      ['interface Ethernet1', 'spanning-tree portfast network'],
      ['interface Ethernet1', 'spanning-tree portfast normal'],
    ]
    for (const batch of batches) scriptWrite(transport, batch)
    const interfaces = new Node(transport).stp.interfaces
    for (const value of ['edge', 'network', 'normal'] as const) await interfaces.setPortfastType('Ethernet1', value)
    // The `spanning-tree portfast auto` partner line is upstream\'s own (`:277-279`), not an invention here:
    // probe records exactly `['interface Ethernet1', 'spanning-tree portfast edge', 'spanning-tree portfast auto']`.
    expect(sentAsText(transport)).toEqual(batches.map((batch) => ['enable', 'configure terminal', ...batch]))
  })

  it('setPortfastType with no argument does not exist here — upstream\'s default argument writes `normal` (:109-113) and its None arm writes the word `None` (row 172)', async () => {
    const transport = configTransport(STP_CONFIG)
    scriptWrite(transport, ['interface Ethernet1', 'spanning-tree portfast normal'])
    // Probe of the two upstream fall-throughs this client removes:
    //   set_portfast_type('Ethernet1')          -> [\'interface Ethernet1\', \'spanning-tree portfast normal\']  (:255 default)
    //   set_portfast_type('Ethernet1', None)    -> [\'interface Ethernet1\', \'spanning-tree portfast None\']    (:274 admits None, :277 interpolates it)
    // The first is DR-037\'s argument-less verb (the caller names `normal`); the second is refused by the
    // grammar, because a config line ending in the literal word `None` is never what an operator meant.
    const interfaces = new Node(transport).stp.interfaces
    await interfaces.setPortfastType('Ethernet1', 'normal')
    expect(sentAsText(transport)).toEqual([['enable', 'configure terminal', 'interface Ethernet1', 'spanning-tree portfast normal']])
    // Both empty arguments render through `pythonRepr` as `None` (DR-010), which is also the word upstream
    // interpolates into the command — the coincidence is why the message quotes the probe text.
    await expectRefusal(() => interfaces.setPortfastType('Ethernet1', undefined as unknown as PortfastType), 'invalid portfast type None', /spanning-tree portfast None/)
    await expectRefusal(() => interfaces.setPortfastType('Ethernet1', null as unknown as PortfastType), 'invalid portfast type None')
  })

  it('a portfast type outside the three upstream\'s chain knows is refused without a round trip (:115-119)', async () => {
    // Upstream checks `value not in ['network','edge','normal', None]` and raises
    // `ValueError('invalid portfast type value specified')`; here the same refusal carries the rejected
    // value and the upstream ref (DR-077/DR-053), and `disabled` — the word the *module* docstring lists at
    // `:49-50` while no code anywhere uses it — is refused like any other junk.
    const transport = configTransport(STP_CONFIG)
    const interfaces = new Node(transport).stp.interfaces
    await expectRefusal(() => interfaces.setPortfastType('Ethernet1', 'banana' as unknown as PortfastType), "invalid portfast type 'banana'", /expected one of edge \/ network \/ normal/)
    await expectRefusal(() => interfaces.setPortfastType('Ethernet1', 'disabled' as unknown as PortfastType), "invalid portfast type 'disabled'")
    // `auto` is a token the READ side keeps (§5 row 170) and the WRITE side refuses, because upstream never
    // writes it alone — `:277-279` only ever emits it beside `edge`.
    await expectRefusal(() => interfaces.setPortfastType('Ethernet1', 'auto' as unknown as PortfastType), "invalid portfast type 'auto'")
    expect(transport.sent()).toEqual([])
  })

  it('setPortfast / unsetPortfast / defaultPortfast are the three texts upstream folds into kwargs (:158-184)', async () => {
    const transport = configTransport(STP_CONFIG)
    const batches: string[][] = [
      ['interface Ethernet1', 'spanning-tree portfast'],
      ['interface Ethernet1', 'no spanning-tree portfast'],
      ['interface Ethernet1', 'default spanning-tree portfast'],
    ]
    for (const batch of batches) scriptWrite(transport, batch)
    const interfaces = new Node(transport).stp.interfaces
    await interfaces.setPortfast('Ethernet1')
    await interfaces.unsetPortfast('Ethernet1')
    await interfaces.defaultPortfast('Ethernet1')
    // Probe of upstream\'s four arms over the same verb: `value=True` -> the bare command; `value=False` ->
    // `no spanning-tree portfast` (`:307-308` folds the boolean into `disable`); `disable=True` -> the same
    // text; **no value at all** -> also `no spanning-tree portfast` through the deprecated fall-through
    // (`abstract.py:160-161`). Three intents, two texts upstream, three verbs here (DR-037) — pinned by
    // `:158-167` (True/False) and `:169-173` (the disable arm alone, because upstream has no verb for the
    // argument-less case to distinguish).
    expect(sentAsText(transport)).toEqual(batches.map((batch) => ['enable', 'configure terminal', ...batch]))
  })

  it('setBpduguard keeps upstream\'s boolean-to-word mapping, because those words are what the reader looks for (:126-133, row 170)', async () => {
    const transport = configTransport(STP_CONFIG)
    const batches: string[][] = [
      ['interface Ethernet1', 'spanning-tree bpduguard enable'],
      ['interface Ethernet1', 'spanning-tree bpduguard disable'],
    ]
    for (const batch of batches) scriptWrite(transport, batch)
    const interfaces = new Node(transport).stp.interfaces
    await interfaces.setBpduguard('Ethernet1', true)
    await interfaces.setBpduguard('Ethernet1', false)
    expect(sentAsText(transport)).toEqual(batches.map((batch) => ['enable', 'configure terminal', ...batch]))
  })

  it('a value-less setBpduguard upstream means the disable WORD, and negation is a different verb (:135-151, divergence 8)', async () => {
    const transport = configTransport(STP_CONFIG)
    const batches: string[][] = [
      ['interface Ethernet1', 'spanning-tree bpduguard disable'],
      ['interface Ethernet1', 'default spanning-tree bpduguard'],
      ['interface Ethernet1', 'no spanning-tree bpduguard'],
    ]
    for (const batch of batches) scriptWrite(transport, batch)
    const interfaces = new Node(transport).stp.interfaces
    // Probe: `set_bpduguard('Ethernet1')` (the `value=False` default at `:314`) sends
    // `spanning-tree bpduguard disable`, while `disable=True` sends `no spanning-tree bpduguard` — the pair
    // `:135-139` and `:147-151` pin separately, and `:141-145` pins the default form. `setBpduguard(name)`
    // does not exist here; the intent has to be named.
    await interfaces.setBpduguard('Ethernet1', false)
    await interfaces.defaultBpduguard('Ethernet1')
    await interfaces.unsetBpduguard('Ethernet1')
    expect(sentAsText(transport)).toEqual(batches.map((batch) => ['enable', 'configure terminal', ...batch]))
  })

  it('the writers round-trip into the reader: what setPortfastType/setBpduguard write is what getAll reports', async () => {
    const transport = configTransport(STP_CONFIG)
    scriptWrite(transport, ['interface Ethernet1', 'spanning-tree portfast edge', 'spanning-tree portfast auto'])
    scriptWrite(transport, ['interface Ethernet1', 'spanning-tree bpduguard enable'])
    const interfaces = new Node(transport).stp.interfaces
    await interfaces.setPortfastType('Ethernet1', 'edge')
    await interfaces.setBpduguard('Ethernet1', true)
    // A fresh Node reading the config the device would now say: the same two lines, read by row 170\'s rules.
    const readBack = stpFor(textOf(['interface Ethernet1', '   spanning-tree portfast edge', '   spanning-tree portfast auto', '   spanning-tree bpduguard enable', 'end'])).interfaces
    expect(await readBack.get('Ethernet1')).toEqual({ interfaceName: 'Ethernet1', portfast: true, portfastType: 'edge', bpduguard: true })
    expect(transport.callCount()).toBe(2)
  })

  it('a name the shared grammar refuses is refused before the kind guard, with the grammar\'s own label (row 168)', async () => {
    const transport = configTransport(STP_CONFIG)
    const interfaces = new Node(transport).stp.interfaces
    // `stp.ts` runs two guards in this order: `assertInterfaceName` (`validators.ts`), which is verb-
    // independent, then the STP kind test. Upstream has only the weak one (`:251-252`) and its own suite
    // writes `Ethernet1/1` for every writer (`:88`) — probe: `set_portfast('Ethernet1/1', True)` sends
    // `['interface Ethernet1/1', 'spanning-tree portfast']`. Here the chassis form is refused at zero round
    // trips until DECISIONS.md open item 7 / M12 #14 settle the spelling.
    for (const name of ['Ethernet1/1', 'Ethernet1.100', 'Et1', 'Po1', 'Poke1', 'Nope1', 'Vlan', '', 'et1']) {
      await expectRefusal(() => interfaces.setPortfastType(name, 'edge'), `invalid interface '${name}'`, /expected one of Ethernet/)
      await expectRefusal(() => interfaces.setPortfast(name), `invalid interface '${name}'`)
      await expectRefusal(() => interfaces.setBpduguard(name, true), `invalid interface '${name}'`)
    }
    expect(transport.sent()).toEqual([])
  })

  it('a real interface name that is not a spanning-tree port is refused by the STP kind guard, naming the verb (:121-124, :153-156, :181-184)', async () => {
    // Upstream gets one message for both mistakes — `ValueError('invalid interface value specified')` —
    // and its three `_invalid_intf_raises_value_error` tests pin that with a `random_string()` name, i.e.
    // the *shape* failure. Here the two failures are two messages, and a `Vlan20` (a perfectly shaped,
    // wrong-kind name) reaches the second one.
    const transport = configTransport(STP_CONFIG)
    const interfaces = new Node(transport).stp.interfaces
    for (const name of ['Vlan20', 'Management1', 'Loopback0', 'Vxlan1']) {
      await expectRefusal(() => interfaces.setBpduguard(name, true), `invalid configure_interface interface '${name}'`, /expected an Ethernet or Port-Channel name/)
      await expectRefusal(() => interfaces.unsetPortfast(name), `invalid configure_interface interface '${name}'`, /api\/stp.py:194-195/)
      await expectRefusal(() => interfaces.defaultPortfast(name), `invalid configure_interface interface '${name}'`)
    }
    expect(transport.sent()).toEqual([])
  })

  it('writes only to the two kinds the module documents, including the form upstream\'s gate admits by prefix (:88 parity where the grammar allows)', async () => {
    const transport = configTransport(STP_CONFIG)
    const batches: string[][] = UPSTREAM_INTERFACES.map((intf) => [`interface ${intf}`, 'spanning-tree bpduguard enable'])
    for (const batch of batches) scriptWrite(transport, batch)
    const interfaces = new Node(transport).stp.interfaces
    for (const intf of UPSTREAM_INTERFACES) await interfaces.setBpduguard(intf, true)
    expect(sentAsText(transport)).toEqual(batches.map((batch) => ['enable', 'configure terminal', ...batch]))
    // `interface Ethernet1/1` above: upstream\'s list includes it and its gate lets it through; this client
    // is narrower, and that narrowing is row 168 rather than an accident.
  })

  it('the parent line goes in exactly once, and the batch order is the order upstream\'s list had (:250-253, row 71)', async () => {
    const transport = configTransport(STP_CONFIG)
    scriptWrite(transport, ['interface Port-Channel1', 'spanning-tree portfast edge', 'spanning-tree portfast auto'])
    await new Node(transport).stp.interfaces.setPortfastType('Port-Channel1', 'edge')
    expect(sentAsText(transport)).toEqual([['enable', 'configure terminal', 'interface Port-Channel1', 'spanning-tree portfast edge', 'spanning-tree portfast auto']])
  })

  it('a spanning-tree write the device refuses rejects with CommandError naming the failed line', async () => {
    const batch = ['interface Ethernet1', 'spanning-tree bpduguard enable']
    const transport = mockTransport().rejects(writeKey(batch), {
      code: EapiErrorCode.COMMAND_INVALID,
      message: "CLI command 4 of 4 'spanning-tree bpduguard enable' failed: invalid input",
    })
    const thrown = await outcome(() => new Node(transport).stp.interfaces.setBpduguard('Ethernet1', true))
    expect(thrown).toBeInstanceOf(CommandError)
    expect((thrown as CommandError).failedCommand).toBe('spanning-tree bpduguard enable')
  })
})

describe('StpInterfacesResource entry verbs and the instances stub — stp.py:159-178, row 171/row 172', () => {
  it('create, delete and setDefault all refuse with upstream\'s own sentence about spanning-tree interfaces', async () => {
    // pyeapi has no such method on `StpInterfaces`: probe says `AttributeError`, and its class docstring
    // states the rule at `:177-178` ("spanning-tree interfaces cannot be created or deleted"). The
    // `EntityCollection` contract (`base.ts:221-245`) forces the verbs to exist, so they refuse rather than
    // half-work (DR-005), and no command leaves the client.
    const transport = configTransport(STP_CONFIG)
    const interfaces = new Node(transport).stp.interfaces
    const verbs: readonly ((name: string) => Promise<void>)[] = [
      (name) => interfaces.create(name),
      (name) => interfaces.delete(name),
      (name) => interfaces.setDefault(name),
    ]
    for (const [index, verb] of ['create', 'delete', 'setDefault'].entries()) {
      const thrown = await outcome(() => (verbs[index] as (name: string) => Promise<void>)('Ethernet1'))
      expect(thrown, verb).toBeInstanceOf(NotSupportedError)
      expect((thrown as Error).message).toContain(`stp interfaces: ${verb}('Ethernet1') is not a thing a spanning-tree interface is`)
      expect((thrown as Error).message).toContain('cannot be created or deleted')
    }
    expect(transport.sent()).toEqual([])
  })

  it('instances.getAll() answers an empty table with ZERO device reads — parity with the 2015 stub (:167-169)', async () => {
    // No script is installed, so a read would be a loud MockTransport failure rather than an empty answer.
    const transport = mockTransport()
    const instances = new Node(transport).stp.instances
    const all: ResourceTable<string, never> = await instances.getAll()
    expect(all).toEqual(new Map<string, never>())
    expect(all.size).toBe(0)
    expect(transport.sent()).toEqual([])
    expect(transport.callCount()).toBe(0)
  })

  it('instances.get answers undefined, where upstream inherits NotImplementedError (abstract.py:223-224)', async () => {
    const transport = mockTransport()
    expect(await new Node(transport).stp.instances.get('1')).toBeUndefined()
    expect(transport.callCount()).toBe(0)
  })

  it('instances.create, delete and setDefault refuse, naming what is unbuilt and the verb upstream lacks (:167-169, :223-224)', async () => {
    // Probe: `StpInstances(None).create(1)` -> `AttributeError: 'StpInstances' object has no attribute
    // 'create'`; `get` raises `NotImplementedError`; the class has no `default` either. The refusal text
    // switches on the verb (`default` vs `create`/`delete`), which the three pins below cover.
    const transport = mockTransport()
    const instances = new Node(transport).stp.instances
    const expected: readonly (readonly [string, string])[] = [
      ['create', 'defines no create at all'],
      ['delete', 'defines no delete at all'],
      ['setDefault', 'defines no default at all'],
    ]
    for (const [verb, phrase] of expected) {
      const call: (name: string) => Promise<void> =
        verb === 'create' ? (name) => instances.create(name)
        : verb === 'delete' ? (name) => instances.delete(name)
        : (name) => instances.setDefault(name)
      const thrown = await outcome(() => call('1'))
      expect(thrown, verb).toBeInstanceOf(NotSupportedError)
      expect((thrown as Error).message).toContain(`stp instances: ${verb}('1') is not implemented`)
      expect((thrown as Error).message).toContain(phrase)
      expect((thrown as Error).message).toContain('M11 #13 capability probe')
    }
    expect(transport.callCount()).toBe(0)
  })

  it('an MST-ish config changes nothing here: the reader is unimplemented, so nothing is hallucinated (row 171)', async () => {
    const config = textOf([
      'spanning-tree mode mstp',
      'spanning-tree mst 0 priority 4096',
      '!',
      'interface Ethernet1',
      '   spanning-tree mst 0 cost 100',
      'end',
    ])
    const settings = await stpFor(config).get()
    expect(settings.mode).toBe('mstp')
    expect(settings.instances.size).toBe(0)
    // The `spanning-tree mst 0 cost 100` line is inside an interface section, so it is not a spanning-tree
    // interface record either — the table is only Ethernet/Port-Channel sections (row 169).
    expect([...settings.interfaces.keys()]).toEqual(['Ethernet1'])
    expect(settings.interfaces.get('Ethernet1')).toEqual({ interfaceName: 'Ethernet1', portfast: true, portfastType: 'edge', bpduguard: false })
  })

  it('the read/write gate asymmetry is visible in one config: an `interface Et1` section is reported, and writing to Et1 is refused (row 168)', async () => {
    const { node, transport } = nodeFor(STP_CONFIG)
    const interfaces = node.stp.interfaces
    expect((await interfaces.get('Et1'))?.portfastType).toBe('normal')
    await expectRefusal(() => interfaces.setPortfast('Et1'), "invalid interface 'Et1'")
    expect(sentAsText(transport)).toEqual([['enable', 'show running-config all']])
  })
})
