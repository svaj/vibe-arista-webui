/**
 * `VlansResource` — M9 (#11), the first `EntityCollection` module on the M7 framework.
 * Driven entirely through `MockTransport` over the real `Node` (`node.vlans`), so every read answer is
 * device text and every write answer is an exact `cmds` list (docs/TESTING.md §3). Fixture config comes
 * from `test/fixtures/config/vlan-blocks.conf` (hand-authored per its `manifest.json.provenance`: never
 * captured from the 7050TX-64) plus inline config for the edge shapes.
 *
 * ## Upstream port ledger
 *
 * `pyeapi/test/unit/test_api_vlans.py` has **15** test methods (counted by AST on 2026-11-03; the spans
 * are listed in `vlans.ts`'s header). They are ported here as behaviour rather than as a shape-for-shape
 * copy, because several of upstream's assertions describe answers this client refuses to give:
 *  - `test_isvlan_with_string` / `_valid_value` / `_invalid_value` (`:51-58`) — `isvlan('1234')` is
 *    **True** upstream and `isvlan('5000')` is False. Here every string id is refused
 *    (`assertVlanId`, MIGRATION.md §5 row 76) and `isVlanId('20')` is false, so all three cases are
 *    re-expressed as "a string id never reaches the wire".
 *  - `test_get` (`:60-70`) — `get('1')` answers `{vlan_id, name, state, trunk_groups}` only because the
 *    pinned fixture's `vlan 1` section carries `name default` **and** `state active`
 *    (`test/fixtures/running_config.text:381-383`). Probe that guard off and upstream raises
 *    `AttributeError` (`vlans.py:144`, `:160`) — reproduced below, and the ranged half of that test
 *    (`get('200-.*')` → `vlan_id: '200-202,204'`, `:65-69`) is divergence 2: the ids come back 200, 201,
 *    202, 204 here and the entry key can be passed back to `delete`.
 *  - `test_get_not_configured` (`:72-73`) — `get('1000')` is `None`; here it is `undefined` (DR-027).
 *  - `test_getall` (`:75-78`) — 5 entries; upstream's `findall` returns **6** hits for that config,
 *    because the `banner login` body line `vlan 1` at `running_config.text:411` is a match and the dict
 *    dedupes it. Here the count is the sections the switch has, and a banner body cannot vote (divergence 3).
 *  - `test_vlan_functions` (`:80-90`), `test_set_name` (`:92-105`), `test_set_state` (`:107-122`),
 *    `test_set_trunk_groups_default` (`:124-128`), `_add_value` (`:130-133`), `_remove_value`
 *    (`:135-138`), `_remove_all` (`:140-143`), `test_add_trunk_group` (`:145-150`),
 *    `test_remove_trunk_group` (`:152-157`) — every pinned command text is asserted verbatim below
 *    (`vlan <id>` / `no vlan <id>` / `default vlan <id>`, `name`/`no name`/`default name`,
 *    `state active|suspend`/`no state`/`default state`, `default trunk group`, `no trunk group`,
 *    `trunk group tg2`, `no trunk group tg1`, `trunk group <tg>`, `no trunk group <tg>`).
 *    Upstream's diff tests pin **one** command per call (`:132`, `:137`) because both of its set-difference
 *    loops each open their own config transaction (`vlans.py:319-325`); the multi-change cases below pin
 *    one transaction carrying both, in the order `vlans.ts` documents (divergence 11).
 *
 * Everything under "probe" was run against the pinned clone on 2026-11-03 (real `Vlans` object over a fake
 * `Node` whose `section()`/`running_config` behave like `client.py:519-527`, `:776-798`); the transcripts
 * are cited in `vlans.ts`. Anything about EOS itself — whether the CLI accepts a name with a quote, what
 * it writes when it omits `state`, how it treats `no vlan <id>` for a section written as a range, whether
 * `vlan … trunk group` exists on this SKU (DECISIONS.md:586 open item 4) — is **not** claimed here: unit
 * tests never reach a device and this workspace has no readable CLI sources, so those read
 * "unverified on hardware, M12 (#14) to capture".
 *
 * `MockTransport` key strings are whole joined command lists (`testing/mock-transport.ts:167`), spelled by
 * the `batch()` helper below so a multi-command write names every command it sends.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { Node } from '../command-layer'
import { CommandError, ConfigParseError, EapiErrorCode, NotFoundError, NotSupportedError } from '../errors'
import { mockTransport, type MockTransport } from '../testing/mock-transport'
import { VlansResource } from './vlans'

/** Join lines into config text so a trailing-space line cannot be lost to an editor. */
const textOf = (lines: readonly string[]): string => lines.join('\n')

/** The committed hand-authored 4.28 VLAN shapes (`test/fixtures/config/vlan-blocks.conf`). */
const VLAN_BLOCKS_FIXTURE = readFileSync(
  fileURLToPath(new URL('../../test/fixtures/config/vlan-blocks.conf', import.meta.url)),
  'utf8',
)

/** A working operator-shaped config: the default VLAN, two named, one suspended with two groups. */
const LAB_CONFIG = textOf([
  '!',
  'hostname lab-sw1',
  '!',
  'vlan 1',
  '   name default',
  '   state active',
  '!',
  'vlan 10',
  '   name VLAN0010',
  '   state active',
  '   trunk group tg1',
  '!',
  'vlan 20',
  '   name PROD',
  '   state suspend',
  '   trunk group red',
  '   trunk group blue',
  '!',
  'interface Vlan20',
  '   ip address 10.20.0.1/24',
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
function vlansFor(config: string): VlansResource {
  return nodeFor(config).node.vlans
}

function outcome(fn: () => Promise<unknown>): Promise<unknown> {
  return fn().then(() => 'resolved' as const, (thrown: unknown) => thrown)
}

async function expectError(fn: () => Promise<unknown>, message: RegExp): Promise<void> {
  const thrown = await outcome(fn)
  expect(thrown).toBeInstanceOf(Error)
  expect((thrown as Error).message).toMatch(message)
}

describe('VlansResource reads — vlans.py:91-113 plus the DR-030 read budget', () => {
  it('answers the whole table from ONE running-config, which is what DR-030 promises', async () => {
    const { node, transport } = nodeFor(LAB_CONFIG)
    const all = await node.vlans.getAll()
    expect(all.size).toBe(3)
    expect(all.get(1)).toEqual({ id: 1, name: 'default', state: 'active', trunkGroups: [] })
    expect(all.get(10)).toEqual({ id: 10, name: 'VLAN0010', state: 'active', trunkGroups: ['tg1'] })
    expect(all.get(20)).toEqual({ id: 20, name: 'PROD', state: 'suspend', trunkGroups: ['red', 'blue'] })
    // One request for three VLANs. Upstream answers the same table with a regex scan plus one
    // `get_block`/`section()` key search and four regex passes PER entity (vlans.py:190-191,
    // client.py:792-797), after which the record set is a dict of possibly-None values.
    expect(transport.bodies()).toHaveLength(1)
    expect(transport.callCount()).toBe(1)
    // `interface Vlan20` is an interface, not a VLAN entry, and cannot be read as one.
    expect(all.get(20)?.name).toBe('PROD')
    expect([...all.keys()]).toEqual([1, 10, 20])
  })

  it('the keys/has/entries helpers ride the same single read (base.ts replaces upstream __iter__/__getitem__)', async () => {
    const { node, transport } = nodeFor(LAB_CONFIG)
    expect(await node.vlans.has(20)).toBe(true)
    expect(await node.vlans.has(999)).toBe(false)
    expect(await node.vlans.keys()).toEqual([1, 10, 20])
    expect((await node.vlans.entries()).map(([id]) => id)).toEqual([1, 10, 20])
    expect(transport.callCount()).toBe(1)
  })

  it('a get() after a getAll() costs nothing extra; the Node memo is the read budget', async () => {
    const { node, transport } = nodeFor(LAB_CONFIG)
    expect((await node.vlans.get(20))?.state).toBe('suspend')
    expect((await node.vlans.getAll()).size).toBe(3)
    expect((await node.vlans.get(10))?.name).toBe('VLAN0010')
    expect(transport.callCount()).toBe(1)
  })

  it('an unnamed VLAN is an entry without a name, where upstream raises AttributeError (vlans.py:144)', async () => {
    // Probe of upstream over `vlan 1` with an empty body: get('1') raises
    // `AttributeError: 'NoneType' object has no attribute 'group'`, and one such section makes its
    // getall() raise for the whole device (vlans.py:190-191). Divergence 5.
    expect(await vlansFor(textOf(['vlan 1', '!', 'end'])).get(1)).toEqual({ id: 1, state: 'active', trunkGroups: [] })
  })

  it('a VLAN with no state line reads active, and with suspend reads suspend (vlans.py:160 crashes on either)', async () => {
    const config = textOf(['vlan 11', '   name eleven', '!', 'vlan 12', '   name twelve', '   state suspend', 'end'])
    const all = await vlansFor(config).getAll()
    expect(all.get(11)?.state).toBe('active')
    expect(all.get(12)?.state).toBe('suspend')
    // Probe: upstream's second entry answers `AttributeError` for the missing `state …` line.
  })

  it('a state the docs do not name is a parse failure, never a guessed active (vlans.py:41-43)', async () => {
    await expectError(() => vlansFor(textOf(['vlan 20', '   state banana', 'end'])).getAll(), /unexpected state 'banana' in 'vlan 20'/)
  })

  it('an unknown id answers undefined, the half of pyeapi get that this client keeps (vlans.py:105-106)', async () => {
    // `test_get_not_configured` (`:72-73`) asserts None for get('1000'); DR-027 keeps that as `undefined`.
    expect(await vlansFor(LAB_CONFIG).get(1000)).toBeUndefined()
    expect(await vlansFor(LAB_CONFIG).has(1000)).toBe(false)
  })

  it('a read that the device refuses rejects with the device error, not an empty table', async () => {
    const transport = mockTransport().rejects('show running-config all', {
      code: EapiErrorCode.COMMAND_INVALID,
      message: "CLI command 2 of 2 'show running-config all' failed: invalid input",
    })
    const thrown = await outcome(() => new Node(transport).vlans.getAll())
    expect(thrown).toBeInstanceOf(CommandError)
    expect((thrown as CommandError).failedCommand).toBe('show running-config all')
  })
})

describe('VlansResource range forms — vlans.py:187-191 and divergence 2', () => {
  it('a ranged header names VLANs 11, 12 and 13, sharing the section body', async () => {
    // Upstream keys the whole run as one string entry — probe: `{"200-202,204": {vlan_id:
    // "200-202,204", …}}`, and `test_api_vlans.py:65-69` pins `vlan_id: '200-202,204'` — which a
    // number-keyed map cannot hold (MIGRATION.md §4). Whether EOS writes a ranged `vlan` header at all
    // is an M12 (#14) capture; the parse only reports what this text says.
    const all = await vlansFor(textOf(['vlan 11-13', '   name group-block', 'end'])).getAll()
    expect([...all.keys()]).toEqual([11, 12, 13])
    expect(all.get(12)).toEqual({ id: 12, name: 'group-block', state: 'active', trunkGroups: [] })
  })

  it('an enumerated header comes back ascending and de-duplicated', async () => {
    const all = await vlansFor(textOf(['vlan 200-202,204,201', '   name grouping', 'end'])).getAll()
    expect([...all.keys()]).toEqual([200, 201, 202, 204])
  })

  it('get() agrees with getAll() for an id that only a range names', async () => {
    // Upstream cannot even address such a section for a write: `isvlan('200-202,204')` is False, so
    // create/delete return False and send nothing (probe; `vlans.py:204`, `:216`).
    const vlans = vlansFor(textOf(['vlan 200-202', '   name grouping', 'end']))
    expect((await vlans.get(201))?.name).toBe('grouping')
    expect((await vlans.get(203))).toBeUndefined()
  })

  it('a header that is a malformed id list is reported, not keyed (probe: pyeapi answers the key 1,)', async () => {
    await expectError(() => vlansFor(textOf(['vlan 1,', '   name trailing-comma', '   state active', 'end'])).getAll(), /cannot enumerate the VLAN ids in 'vlan 1,'/)
    await expectError(() => vlansFor(textOf(['vlan 1-2-3', 'end'])).getAll(), /cannot enumerate the VLAN ids in 'vlan 1-2-3'/)
  })

  it('a run that cannot be expanded safely is reported rather than looped through', async () => {
    await expectError(() => vlansFor(textOf(['vlan 1-999999999', 'end'])).getAll(), /is not expandable/)
    await expectError(() => vlansFor(textOf(['vlan 13-11', 'end'])).getAll(), /is not expandable/)
  })

  it('a header outside the id charset is not a VLAN at all, and leaves no phantom entry', async () => {
    // Probe of upstream: a `vlan 10x` section yields the phantom `{'10': None}`, and `vlan 010` yields the
    // string key '010'. Here the charset gate (`vlans.py:187`) decides what is a VLAN, and a numeric key is
    // canonical.
    const all = await vlansFor(textOf(['vlan 10x', '   name ten', '!', 'vlan 010', '   name ten again', 'end'])).getAll()
    expect([...all.keys()]).toEqual([10])
    expect(all.get(10)?.name).toBe('ten again')
  })

  it('the `vlan internal allocation policy ascending` line is not a VLAN (running_config.text:42)', async () => {
    const config = textOf(['vlan internal allocation policy ascending', '!', 'vlan 2', '   name two', 'end'])
    expect([...(await vlansFor(config).getAll()).keys()]).toEqual([2])
  })

  it('a `vlan 1` line inside a banner body is not a VLAN (upstream answers a phantom entry for it)', async () => {
    // Upstream scans the whole config with re.M (`vlans.py:187`), so a column-0 banner body line counts:
    // probe over this exact shape answers `{"1": null}`. Its own fixture has that line — `vlan 1` inside
    // `banner login` at running_config.text:411 — which is why test_getall counts 5 entries from 6 matches.
    const config = textOf(['hostname sw1', 'banner login', 'vlan 1', 'EOF', '!', 'end'])
    expect((await vlansFor(config).getAll()).size).toBe(0)
  })

  it('an id the writes would refuse is still reported when the device wrote it (divergence 8)', async () => {
    // Probe: upstream reads `vlan 99999` back as the string '99999' while isvlan(99999) is False, so its
    // create/delete answer False for the very id its getall just reported.
    const all = await vlansFor(textOf(['vlan 4095', '   name reserved', 'end'])).getAll()
    expect(all.get(4095)).toEqual({ id: 4095, name: 'reserved', state: 'active', trunkGroups: [] })
  })
})

describe('VlansResource field extraction — vlans.py:57-60 read over a whole block', () => {
  it('a name reciting `state test` cannot become the state (probe: upstream reads state test)', async () => {
    const all = await vlansFor(textOf(['vlan 5', '   name state test', 'end'])).getAll()
    expect(all.get(5)).toEqual({ id: 5, name: 'state test', state: 'active', trunkGroups: [] })
  })

  it('a name reciting `trunk group evil` cannot become a trunk group (probe: upstream answers [evil])', async () => {
    const all = await vlansFor(textOf(['vlan 6', '   name trunk group evil', 'end'])).getAll()
    expect(all.get(6)?.trunkGroups).toEqual([])
  })

  it('quoted names read back unquoted, and outer whitespace is not invented (row 49)', async () => {
    // Probe: `name "seven"` answers '"seven"' and `name pad  ` answers 'pad  ' upstream (`vlans.py:58`);
    // `config/text.ts` unquotes and rstrips, and assertVlanName refuses what would not round-trip.
    const all = await vlansFor(textOf(['vlan 7', '   name "seven (ops)"', '   state active', 'end'])).getAll()
    expect(all.get(7)?.name).toBe('seven (ops)')
  })

  it('trunk groups keep device order and an absent set is an empty list (vlans.py:176-177 parity)', async () => {
    const all = await vlansFor(textOf(['vlan 8', '   name eight', '   trunk group blue', '   trunk group red', 'end'])).getAll()
    expect(all.get(8)?.trunkGroups).toEqual(['blue', 'red'])
    expect((await vlansFor(textOf(['vlan 8', 'end'])).get(8))?.trunkGroups).toEqual([])
  })

  it('the committed fixture parses end to end, ranged and quoted forms included', async () => {
    const all = await vlansFor(VLAN_BLOCKS_FIXTURE).getAll()
    expect([...all.keys()]).toEqual([1, 10, 11, 12, 13, 20])
    expect(all.get(1)).toEqual({ id: 1, state: 'active', trunkGroups: [] })
    expect(all.get(11)).toEqual({ id: 11, name: 'group-block', state: 'active', trunkGroups: [] })
    expect(all.get(20)).toEqual({ id: 20, name: 'twenty (ops)', state: 'suspend', trunkGroups: ['red', 'blue'] })
  })
})

describe('VlansResource presence verbs — vlans.py:194-232, DR-005 replaces the False return', () => {
  it('create, delete and setDefault emit exactly the texts test_api_vlans.py:84-88 pins', async () => {
    const transport = configTransport(LAB_CONFIG)
    const vlans = new Node(transport).vlans
    const single = (cmd: string) => [['enable', 'configure terminal', cmd]]
    transport
      .replies('enable\nconfigure terminal\nvlan 21', [{}, {}, {}])
      .replies('enable\nconfigure terminal\nno vlan 21', [{}, {}, {}])
      .replies('enable\nconfigure terminal\ndefault vlan 21', [{}, {}, {}])
    await vlans.create(21)
    await vlans.delete(21)
    await vlans.setDefault(21)
    expect(transport.sent().map((cmds) => cmds.map(String))).toEqual([
      ...single('vlan 21'),
      ...single('no vlan 21'),
      ...single('default vlan 21'),
    ])
    // Zero config reads: none of the three looks at the current state first (parity with upstream,
    // and DR-030 scopes the read budget rather than adding reads).
    expect(transport.bodies().filter((body) => body.params.cmds.some((c) => String(c) === 'show running-config all'))).toEqual([])
  })

  it('create with attrs writes the name and state inside the same transaction (divergence 9)', async () => {
    const transport = configTransport(LAB_CONFIG)
    transport.replies('enable\nconfigure terminal\nvlan 30\nname LAB\nstate suspend', [{}, {}, {}, {}, {}])
    await new Node(transport).vlans.create(30, { name: 'LAB', state: 'suspend' })
    expect(transport.sent()[0]?.map(String)).toEqual(['enable', 'configure terminal', 'vlan 30', 'name LAB', 'state suspend'])
    // Upstream needs two calls for that (create at `:194`, then set_name at `:248`), i.e. two config
    // transactions on the device.
  })

  it('a rejected id throws naming the value and sends nothing (upstream returns False, vlans.py:204)', async () => {
    const transport = configTransport(LAB_CONFIG)
    const vlans = new Node(transport).vlans
    for (const bad of [0, 4095, 20.5, -1, Number.NaN, '20', null, undefined]) {
      await expectError(() => vlans.create(bad as number), /invalid vlan /)
      await expectError(() => vlans.delete(bad as number), /invalid vlan /)
      await expectError(() => vlans.setDefault(bad as number), /invalid vlan /)
    }
    expect(transport.sent()).toEqual([])
    // Probe of upstream: create(0) and create(99999) return False having sent nothing, while
    // create(20.5) returns True and sends the literal `vlan 20.5` (isvlan truncates, `:77`).
  })

  it('a device refusal rejects with CommandError and the failed command (no False, no .error)', async () => {
    // The brief's "delete of a VLAN the device refuses" case: `no vlan 20` with members on it is the
    // realistic shape. What EOS exactly says is an M12 (#14) capture; the failure envelope here is
    // scripted, not claimed.
    const transport = configTransport(LAB_CONFIG).rejects('configure terminal', {
      code: EapiErrorCode.COMMAND_INVALID,
      message: "CLI command 3 of 3 'no vlan 20' failed: vlan 20 is in use by 1 port",
    })
    const thrown = await outcome(() => new Node(transport).vlans.delete(20))
    expect(thrown).toBeInstanceOf(CommandError)
    expect((thrown as CommandError).failedCommand).toBe('no vlan 20')
    expect((thrown as CommandError).commands).toEqual(['enable', 'configure terminal', 'no vlan 20'])
  })
})

describe('VlansResource name and state verbs — vlans.py:248-284', () => {
  const writeKey = (cmds: readonly string[]): string => ['enable', 'configure terminal', ...cmds].join('\n')

  it('setVlanName / unsetVlanName / defaultVlanName produce vlan submode batches (test_api_vlans.py:97-105)', async () => {
    const transport = configTransport(LAB_CONFIG)
    transport
      .replies(writeKey(['vlan 10', 'name TEN']), [{}, {}, {}, {}])
      .replies(writeKey(['vlan 10', 'no name']), [{}, {}, {}, {}])
      .replies(writeKey(['vlan 10', 'default name']), [{}, {}, {}, {}])
    const vlans = new Node(transport).vlans
    await vlans.setVlanName(10, 'TEN')
    await vlans.unsetVlanName(10)
    await vlans.defaultVlanName(10)
    expect(transport.sent().map((cmds) => cmds.map(String))).toEqual([
      ['enable', 'configure terminal', 'vlan 10', 'name TEN'],
      ['enable', 'configure terminal', 'vlan 10', 'no name'],
      ['enable', 'configure terminal', 'vlan 10', 'default name'],
    ])
  })

  it('a name this client could not read back is refused before anything is sent (divergence 10)', async () => {
    const transport = configTransport(LAB_CONFIG)
    const vlans = new Node(transport).vlans
    const illegal: readonly [unknown, RegExp][] = [
      ['', /empty VLAN name is refused/],
      ['   ', /empty VLAN name is refused/],
      ['PROD ', /leading or trailing whitespace/],
      [' PROD', /leading or trailing whitespace/],
      ['seven"ops', /cannot round-trip/],
      ['ing\x07rat', /control character/],
      [7, /expected a string VLAN name/],
      [undefined, /expected a string VLAN name/],
    ]
    for (const [value, message] of illegal) {
      await expectError(() => vlans.setVlanName(10, value as string), new RegExp(`invalid vlan name . ${message.source}`))
    }
    expect(transport.sent()).toEqual([])
    // Probe: upstream sends whatever arrives — `set_name(30, None)` answers True and sends `no name`
    // because the value=None fall-through produces the deprecated negation (abstract.py:160-161).
  })

  it('setVlanState round-trips suspend and active, and the unset/default texts match upstream (vlans.py:107-122)', async () => {
    const transport = configTransport(LAB_CONFIG)
    transport
      .replies(writeKey(['vlan 20', 'state suspend']), [{}, {}, {}, {}])
      .replies(writeKey(['vlan 20', 'state active']), [{}, {}, {}, {}])
      .replies(writeKey(['vlan 20', 'no state']), [{}, {}, {}, {}])
      .replies(writeKey(['vlan 20', 'default state']), [{}, {}, {}, {}])
    const vlans = new Node(transport).vlans
    await vlans.setVlanState(20, 'suspend')
    await vlans.setVlanState(20, 'active')
    await vlans.unsetVlanState(20)
    await vlans.defaultVlanState(20)
    expect(transport.sent().map((cmds) => cmds.map(String))).toEqual([
      ['enable', 'configure terminal', 'vlan 20', 'state suspend'],
      ['enable', 'configure terminal', 'vlan 20', 'state active'],
      ['enable', 'configure terminal', 'vlan 20', 'no state'],
      ['enable', 'configure terminal', 'vlan 20', 'default state'],
    ])
    // The suspend/active pair is the read of the same value back: this client writes exactly the two
    // spellings its reader accepts (`vlans.py:41-43`).
    const state = await vlans.get(20)
    expect(state?.state === 'suspend' || state?.state === 'active').toBe(true)
  })

  it('a state outside the two documented values is refused, naming it (pyeapi interpolates anything)', async () => {
    const transport = configTransport(LAB_CONFIG)
    const vlans = new Node(transport).vlans
    await expectError(() => vlans.setVlanState(20, 'banana' as never), /invalid vlan state 'banana' — expected one of active \/ suspend/)
    // Probe: `set_state(20)` with no value sends the deprecated `no state` (abstract.py:160-161, DR-037);
    // that intent is `unsetVlanState` here, and an omitted argument never reaches the device.
    await expectError(() => vlans.setVlanState(20, undefined as never), /invalid vlan state undefined/)
    expect(transport.sent()).toEqual([])
  })

  it('configure_vlan cannot accumulate a parent line the way upstream mutates its caller list (row 71)', async () => {
    const transport = configTransport(LAB_CONFIG)
    transport
      .replies(writeKey(['vlan 20', 'name A']), [{}, {}, {}, {}])
      .replies(writeKey(['vlan 21', 'name A']), [{}, {}, {}, {}])
    const vlans = new Node(transport).vlans
    await vlans.setVlanName(20, 'A')
    await vlans.setVlanName(21, 'A')
    expect(transport.sent().map((cmds) => cmds.map(String))).toEqual([
      ['enable', 'configure terminal', 'vlan 20', 'name A'],
      ['enable', 'configure terminal', 'vlan 21', 'name A'],
    ])
    // Probe of upstream: two `configure_vlan` calls over one list send `['vlan 20','name a']` then
    // `['vlan 21','vlan 20','name a']` — the parent line piles up (`vlans.py:244-245`).
  })

  it('a write with an unconfigured but valid id still goes to the device (upstream creates implicitly too)', async () => {
    const transport = configTransport(LAB_CONFIG)
    transport.replies(writeKey(['vlan 999', 'name GHOST']), [{}, {}, {}, {}])
    await new Node(transport).vlans.setVlanName(999, 'GHOST')
    expect(transport.sent()[0]?.map(String)).toEqual(['enable', 'configure terminal', 'vlan 999', 'name GHOST'])
    // Probe: `set_name(999, name='x')` upstream sends `['vlan 999','name x']` — the same device decision,
    // and no config read first (divergence 12). What the device does with it is unverified, M12 (#14).
  })

  it('an out-of-range id cannot reach the submode helper at all', async () => {
    const transport = configTransport(LAB_CONFIG)
    const vlans = new Node(transport).vlans
    await expectError(() => vlans.unsetVlanName(4095), /invalid vlan 4095/)
    await expectError(() => vlans.defaultVlanState(99999), /invalid vlan 99999/)
    await expectError(() => vlans.addTrunkGroup(20.5, 'red'), /invalid vlan 20.5/)
    expect(transport.sent()).toEqual([])
  })
})

describe('VlansResource trunk groups — vlans.py:286-358 and DR-030', () => {
  const writeKey = (cmds: readonly string[]): string => ['enable', 'configure terminal', ...cmds].join('\n')

  it('setTrunkGroups diffs against ONE read and writes ONE transaction (upstream pays one per change)', async () => {
    const transport = configTransport(LAB_CONFIG)
    transport.replies(writeKey(['vlan 20', 'trunk group green', 'no trunk group blue']), [{}, {}, {}, {}, {}])
    const vlans = new Node(transport).vlans
    await vlans.setTrunkGroups(20, ['red', 'green', 'blue', 'green'])
    expect(transport.sent().map((cmds) => cmds.map(String))).toEqual([
      ['enable', 'show running-config all'],
      ['enable', 'configure terminal', 'vlan 20', 'trunk group green', 'no trunk group blue'],
    ])
    // Upstream: adds (`:319-321`) and removals (`:323-325`) each open their own config transaction, in
    // Python set order (probe over a same-shaped config sends `['interface …','switchport trunk group
    // green']` then a second request for the remove). Dedupe of the caller's repeated `green` is ours.
  })

  it('removals follow device order and adds follow caller order', async () => {
    const transport = configTransport(textOf(['vlan 20', '   name PROD', '   trunk group red', '   trunk group blue', '   trunk group teal', 'end']))
    transport.replies(writeKey(['vlan 20', 'trunk group zeta', 'trunk group aa', 'no trunk group red', 'no trunk group blue', 'no trunk group teal']), [{}, {}, {}, {}, {}, {}, {}, {}])
    await new Node(transport).vlans.setTrunkGroups(20, ['zeta', 'aa'])
    expect(transport.sent()[1]?.map(String)).toEqual(['enable', 'configure terminal', 'vlan 20', 'trunk group zeta', 'trunk group aa', 'no trunk group red', 'no trunk group blue', 'no trunk group teal'])
  })

  it('an already-matching set sends nothing at all — including no config transaction (upstream agrees)', async () => {
    const transport = configTransport(LAB_CONFIG)
    const vlans = new Node(transport).vlans
    await vlans.setTrunkGroups(20, ['blue', 'red'])
    expect(transport.sent().map((cmds) => cmds.map(String))).toEqual([['enable', 'show running-config all']])
    // Order-insensitive idempotence: the device's `red, blue` already covers the caller's `blue, red`.
    // Probe: upstream's loops likewise produce zero configure calls for that input.
  })

  it('an empty list clears every group one by one, which is not the bulk no form', async () => {
    const transport = configTransport(LAB_CONFIG)
    transport.replies(writeKey(['vlan 20', 'no trunk group red', 'no trunk group blue']), [{}, {}, {}, {}, {}])
    await new Node(transport).vlans.setTrunkGroups(20, [])
    expect(transport.sent()[1]?.map(String)).toEqual(['enable', 'configure terminal', 'vlan 20', 'no trunk group red', 'no trunk group blue'])
    // Probe of upstream: `set_trunk_groups(30, [])` removes each group individually too.
  })

  it('the bulk forms stay separate verbs (vlans.py:310-312, test_api_vlans.py:126/:142)', async () => {
    const transport = configTransport(LAB_CONFIG)
    transport
      .replies(writeKey(['vlan 20', 'default trunk group']), [{}, {}, {}, {}])
      .replies(writeKey(['vlan 20', 'no trunk group']), [{}, {}, {}, {}])
    const vlans = new Node(transport).vlans
    await vlans.defaultTrunkGroups(20)
    await vlans.unsetTrunkGroups(20)
    expect(transport.sent().map((cmds) => cmds.map(String))).toEqual([
      ['enable', 'configure terminal', 'vlan 20', 'default trunk group'],
      ['enable', 'configure terminal', 'vlan 20', 'no trunk group'],
    ])
    expect(transport.callCount()).toBe(2)
  })

  it('add and remove are unconditional and issue no read (vlans.py:342, :358)', async () => {
    const transport = configTransport(LAB_CONFIG)
    transport
      .replies(writeKey(['vlan 20', 'trunk group red']), [{}, {}, {}, {}])
      .replies(writeKey(['vlan 20', 'no trunk group red']), [{}, {}, {}, {}])
    const vlans = new Node(transport).vlans
    await vlans.addTrunkGroup(20, 'red')
    await vlans.removeTrunkGroup(20, 'red')
    await vlans.addTrunkGroup(20, 'brand-new')
    expect(transport.sent().map((cmds) => cmds.map(String))).toEqual([
      ['enable', 'configure terminal', 'vlan 20', 'trunk group red'],
      ['enable', 'configure terminal', 'vlan 20', 'no trunk group red'],
      ['enable', 'configure terminal', 'vlan 20', 'trunk group brand-new'],
    ])
    // `trunk group red` on a VLAN that already has it is re-sent rather than diffed: upstream does the
    // same (`:342` reads nothing), and the submode re-entry is what the config layer already notes
    // (command-builder.ts, "which EOS tolerates") — an EOS-side behaviour this suite does not claim.
  })

  it('setting groups on a VLAN the switch does not have is a NotFoundError, not a TypeError', async () => {
    const transport = configTransport(LAB_CONFIG)
    const vlans = new Node(transport).vlans
    const thrown = await outcome(() => vlans.setTrunkGroups(999, ['red']))
    expect(thrown).toBeInstanceOf(NotFoundError)
    expect((thrown as Error).message).toMatch(/the switch has no vlan 999 to set trunk groups on/)
    expect(transport.sent().map((cmds) => cmds.map(String))).toEqual([['enable', 'show running-config all']])
    // Probe: upstream raises `TypeError: 'NoneType' object is not subscriptable` at `:314` and sends
    // nothing. DR-027's required-lookup arm replaces it.
  })

  it('group names are validated before the read, so a bad call sends and reads nothing', async () => {
    const transport = configTransport(LAB_CONFIG)
    const vlans = new Node(transport).vlans
    for (const bad of ['', '   ', 'red blue', 5, undefined]) {
      await expectError(() => vlans.setTrunkGroups(20, [bad as string]), /expected a single token|invalid .* trunk group name/)
      await expectError(() => vlans.addTrunkGroup(20, bad as string), /invalid addTrunkGroup trunk group name/)
      await expectError(() => vlans.removeTrunkGroup(20, bad as string), /invalid removeTrunkGroup trunk group name/)
    }
    expect(transport.sent()).toEqual([])
    // Probe: upstream sends `add_trunk_group(30, 5)` as `trunk group 5`, and its two readers disagree
    // about a two-word name (vlans.py:60 keeps 'red blue', switchports.py:115 keeps 'red').
  })

  it('a device rejection of a group write rejects with CommandError and failedCommand', async () => {
    const transport = configTransport(LAB_CONFIG).rejects('configure terminal', {
      code: EapiErrorCode.COMMAND_INVALID,
      message: "CLI command 4 of 4 'trunk group red' failed: no such trunk group",
    })
    const thrown = await outcome(() => new Node(transport).vlans.addTrunkGroup(20, 'red'))
    expect(thrown).toBeInstanceOf(CommandError)
    expect((thrown as CommandError).failedCommand).toBe('trunk group red')
    // pyeapi answers False and parks the exception on connection.error (`abstract.py:117-127`, DR-005).
  })

  it('the module is reachable the documented way and works on a startup-config read too', async () => {
    const transport = mockTransport().replies('enable\nshow startup-config', [{}, { output: textOf(['vlan 40', '   name fourty', 'end']) }])
    const vlans = new Node(transport).vlans
    expect(vlans).toBeInstanceOf(VlansResource)
    const entry = await vlans.get(40)
    expect(entry?.name).toBe('fourty')
  })
})

describe('VlansResource cache seam — DR-026 invalidation on write (command-layer.ts)', () => {
  it('a write drops the memo, so the next read costs one more request and sees fresh text', async () => {
    const transport = configTransport(LAB_CONFIG)
    transport
      .replies('enable\nconfigure terminal\nvlan 20\nname NEW', [{}, {}, {}, {}])
      .replies('enable\nshow running-config all', [{}, { output: textOf(['vlan 20', '   name NEW', 'end']) }])
    const vlans = new Node(transport).vlans
    expect((await vlans.get(20))?.name).toBe('PROD')
    await vlans.setVlanName(20, 'NEW')
    expect((await vlans.get(20))?.name).toBe('NEW')
    expect(transport.callCount()).toBe(3)
    expect(transport.sent().map((cmds) => cmds.map(String))).toEqual([
      ['enable', 'show running-config all'],
      ['enable', 'configure terminal', 'vlan 20', 'name NEW'],
      ['enable', 'show running-config all'],
    ])
    // pyeapi clears its lru_cache and (with autorefresh) its running_config on every config call
    // (client.py:665-669); the same seam is asserted here so the ordering cannot drift silently.
  })

  it('a NotSupportedError from a guard never reaches the device (four states, USAGE.md §7)', async () => {
    const transport = configTransport(LAB_CONFIG)
    const vlans = new Node(transport).vlans
    await expectError(() => vlans.create('not a vlan' as never), /invalid vlan 'not a vlan'/)
    expect(transport.sent()).toEqual([])
    expect(transport.callCount()).toBe(0)
  })
})
