/**
 * `SwitchportsResource` — M9 (#11), the second `EntityCollection` module on the M7 framework.
 * Driven through `MockTransport` over the real `Node` (`node.switchports`), so every read answer is device
 * text and every write answer is an exact `cmds` list (docs/TESTING.md §3). Fixture config comes from
 * `test/fixtures/config/switchport-trunk.conf` (hand-authored per its `manifest.json.provenance`: never
 * captured from the 7050TX-64) plus inline config for the edge shapes.
 *
 * ## Upstream port ledger
 *
 * `pyeapi/test/unit/test_api_switchports.py` has **21** test methods (counted by AST on 2026-11-03; the
 * spans are listed in `switchports.ts`'s header and every one below was re-opened in the pinned clone):
 *  - `test_get` (`:54-58`) — upstream asserts the record has exactly the six keys `name`/`mode`/
 *    `access_vlan`/`trunk_native_vlan`/`trunk_allowed_vlans`/`trunk_groups`, which is only true because the
 *    pinned fixture's `interface Ethernet1` carries all of them. It cannot survive a real access port:
 *    `_parse_mode`/`_parse_trunk_native_vlan`/`_parse_trunk_allowed_vlans` call `.group(…)` on the bare
 *    `re.search` result (`switchports.py:103`, `:143`, `:157`) and raise `AttributeError` (divergence 2).
 *    Re-expressed below as "every field is a field answer, and one access port does not break the table".
 *  - `test_getall` (`:60-68`) — nine interfaces from `(?<=^interface\s)([Et|Po][^.\s]+)$` (`:169`). That
 *    class is `[Et|Po]` — a *character* class — so `interface t1` counts and `interface Vlan20` does not
 *    (probe, divergence 5). Below, the membership rule is the documented one (Ethernet/Port-Channel,
 *    `:70-71`) and is asserted positively on our own fixture.
 *  - `test_instance_functions` (`:70-85`), `test_set_mode` (`:87-92`), `_with_no_value` (`:94-98`),
 *    `_with_default` (`:100-104`), `test_set_access_vlan` (`:106-111`), `_with_no_value` (`:113-117`),
 *    `_with_default` (`:119-123`), `test_set_trunk_native_vlan` (`:125-131`), `_with_no_value`
 *    (`:133-137`), `_with_default` (`:139-144`), `test_set_trunk_allowed_vlans` (`:146-152`),
 *    `_with_no_value` (`:154-159`), `test_set_allowed_vlans_with_default` (`:161-166`),
 *    `test_set_trunk_groups_with_default` (`:168-173`), `_with_no` (`:175-180`), `_with_add` (`:182-187`),
 *    `_with_remove` (`:189-194`), `test_add_trunk_group` (`:196-201`), `test_remove_trunk_group`
 *    (`:203-208`) — every pinned command text is asserted verbatim below, including the exact three-command
 *    lists of the presence verbs (`interface X` / `no ip address` / `switchport`, `:74-75`;
 *    `interface X` / `no switchport`, `:78`; `interface X` / `no ip address` / `default switchport`,
 *    `:81-82`) and the `no`/`default` pairs each upstream kwarg produces. Upstream's two diff tests pin
 *    **one** command per call (`:184-185`, `:191-192`) because `set_trunk_groups` opens a separate
 *    `configure_interface` per add and per remove (`:369-375`); the multi-change case below pins one
 *    transaction carrying both directions, in the order `switchports.ts` documents (divergence 9).
 *  - Upstream drives everything through `EapiConfigUnitTest`, whose `MockConnection` answers `{}` to
 *    anything it was not told about (docs/TESTING.md §3). Here an unscripted request is a hard failure, so
 *    every batch below spells every command it sends — `testing/mock-transport.ts:83-90` compares a string
 *    matcher against the **whole joined command list** (`texts.join('\n')`), never a prefix.
 *
 * Everything under "probe" was run against the pinned clone on 2026-11-03 (the real `Switchports` object
 * over a fake `Node` whose `section()`/`running_config` behave like `client.py:519-527`, `:776-798`); the
 * transcripts are cited in `switchports.ts`. Anything about EOS itself — whether the 7050TX-64 has
 * `switchport trunk group` at all (DECISIONS.md open item 4), what a device does with an
 * `allowed vlan` keyword form, what an L2 port defaults to when no `switchport mode` line is written — is
 * **not** claimed here: unit tests never reach a device and this workspace has no readable CLI sources, so
 * those read "unverified on hardware, M12 (#14) to capture".
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { Node } from '../command-layer'
import { CommandError, ConfigParseError, EapiErrorCode, NotFoundError, NotSupportedError } from '../errors'
import { mockTransport, type MockReply, type MockTransport } from '../testing/mock-transport'
import { isSwitchportMode, SwitchportsResource, SWITCHPORT_MODES } from './switchports'

/** Join lines into config text so a trailing-space line cannot be lost to an editor. */
const textOf = (lines: readonly string[]): string => lines.join('\n')

/** The committed hand-authored 4.28 switchport shapes (`test/fixtures/config/switchport-trunk.conf`). */
const SWITCHPORT_FIXTURE = readFileSync(
  fileURLToPath(new URL('../../test/fixtures/config/switchport-trunk.conf', import.meta.url)),
  'utf8',
)

/**
 * A working operator-shaped L2 config: one routed trunk with groups, one access port whose mode line is
 * absent, one interface turned off with `no switchport`, and an L3 `interface Vlan20` that must never read
 * as a switchport.
 */
const L2_CONFIG = textOf([
  'hostname lab-sw1',
  '!',
  'vlan 20',
  '   name PROD',
  '!',
  'interface Ethernet1',
  '   description uplink to core',
  '   switchport mode trunk',
  '   switchport trunk native vlan 99',
  '   switchport trunk allowed vlan 10-12,20',
  '   switchport trunk group red',
  '   switchport trunk group blue',
  '!',
  'interface Ethernet3',
  '   switchport access vlan 20',
  '!',
  'interface Ethernet4',
  '   no switchport',
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
function switchportsFor(config: string): SwitchportsResource {
  return nodeFor(config).node.switchports
}

/** A batch key: `configure()` prepends `enable` + `configure terminal`, and `configureInterface` the parent line. */
const writeKey = (cmds: readonly string[]): string => ['enable', 'configure terminal', ...cmds].join('\n')

/** Empty per-command replies for a successful config transaction: `enable`, `configure terminal`, then the batch. */
const okFor = (cmds: readonly string[]): MockReply => Array.from({ length: cmds.length + 2 }, () => ({}))

/** Script a whole config transaction, keyed by the exact command list it must carry. */
function scriptWrite(transport: MockTransport, cmds: readonly string[]): MockTransport {
  return transport.replies(writeKey(cmds), okFor(cmds))
}

function outcome(fn: () => Promise<unknown>): Promise<unknown> {
  return fn().then(() => 'resolved' as const, (thrown: unknown) => thrown)
}

async function expectError(fn: () => Promise<unknown>, message: RegExp): Promise<void> {
  const thrown = await outcome(fn)
  expect(thrown).toBeInstanceOf(Error)
  expect((thrown as Error).message).toMatch(message)
}

/**
 * A guard rejection: the class, then the message. The refusal form is `invalid <label> <repr> — <why>`
 * (`refuse` in `switchports.ts`, the same shape as `validators.ts:64-69`), so `label` is a substring pin on
 * the labelled argument and `why` is a substring or a pattern. M8 pins the identical shape
 * (`system.test.ts:355-359`), which is why no assertion here re-types a fabricated message.
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

describe('SwitchportsResource reads — switchports.py:57-89, :159-176 and the DR-030 read budget', () => {
  it('parses the committed fixture into three switchports from ONE running-config', async () => {
    const { node, transport } = nodeFor(SWITCHPORT_FIXTURE)
    const all = await node.switchports.getAll()
    // `interface Management1` is an interface but not a switchport (`:70-71` documents the two kinds,
    // `:169` tries to say so with a botched character class — divergence 5), and the lowercase
    // `port-channel 1` block is a global command, not an interface section.
    expect([...all.keys()]).toEqual(['Ethernet1', 'Ethernet3', 'Port-Channel1'])
    expect(all.get('Ethernet1')).toEqual({
      interfaceName: 'Ethernet1',
      trunkGroups: [],
      mode: 'trunk',
      trunkNativeVlan: 99,
      trunkAllowedVlans: '10-12,20,30-33',
    })
    // The access port with no trunk lines at all: upstream's `get` raises AttributeError here
    // (`:103`/`:143`/`:157` on a bare `re.search`) and its `getall` therefore cannot answer the device
    // (divergence 2). Here every field is a field answer.
    expect(all.get('Ethernet3')).toEqual({ interfaceName: 'Ethernet3', trunkGroups: [], accessVlan: 20 })
    expect(all.get('Port-Channel1')).toEqual({ interfaceName: 'Port-Channel1', trunkGroups: [], mode: 'trunk', trunkNativeVlan: 99 })
    // One request for the whole table. Upstream pays a `section()` key scan, a `re.compile` and five regex
    // passes PER interface (`:172-173` → `get` → `get_block` → `client.py:792-797`).
    expect(transport.callCount()).toBe(1)
    expect(sentAsText(transport)).toEqual([['enable', 'show running-config all']])
  })

  it('get() after getAll() costs nothing extra, and keys/has/entries ride the same single read', async () => {
    const { node, transport } = nodeFor(L2_CONFIG)
    expect((await node.switchports.get('Ethernet1'))?.mode).toBe('trunk')
    expect((await node.switchports.getAll()).size).toBe(2)
    expect(await node.switchports.has('Ethernet3')).toBe(true)
    expect(await node.switchports.has('Ethernet4')).toBe(false)
    expect(await node.switchports.keys()).toEqual(['Ethernet1', 'Ethernet3'])
    expect((await node.switchports.entries()).map(([name]) => name)).toEqual(['Ethernet1', 'Ethernet3'])
    expect(transport.callCount()).toBe(1)
  })

  it('an interface the switch does not have answers undefined, where upstream raises TypeError (switchports.py:80)', async () => {
    // Probe: `get('Ethernet99')` evaluates `'no switchport\n' in config` on the `None` from `get_block`
    // (`abstract.py:96-101`) → `TypeError: argument of type 'NoneType' is not iterable`. DR-027 keeps
    // absence as ordinary control flow (divergence 1) — and no name guard runs on a read, so a lookup of a
    // name this client would refuse to write answers the device rather than throwing.
    const { node, transport } = nodeFor(L2_CONFIG)
    expect(await node.switchports.get('Ethernet99')).toBeUndefined()
    expect(await node.switchports.get('Ethernet1/1')).toBeUndefined()
    expect(transport.callCount()).toBe(1)
  })

  it('an L3 interface section is not a switchport, and the L3/Vlan kind cannot be written either', async () => {
    const { node, transport } = nodeFor(L2_CONFIG)
    expect(await node.switchports.get('Vlan20')).toBeUndefined()
    expect(await node.switchports.get('Management1')).toBeUndefined()
    // Upstream's `:169` class also excludes `Vlan20`, but as an accident of `[Et|Po]` — probe: it accepts
    // `interface t1` on the same terms. Ours refuses the kind on the write path instead (divergence 5).
    await expectRefusal(() => node.switchports.setAccessVlan('Vlan20', 20), "invalid setAccessVlan interface 'Vlan20'", /expected an Ethernet or Port-Channel name/)
    // Both lookups share one read — the DR-026 memo (`command-layer.ts`, row 80) — and the refused write
    // never reaches the device (divergence 10).
    expect(sentAsText(transport)).toEqual([['enable', 'show running-config all']])
  })

  it('DR-029: an interface section with no switchport line at all is in the table, with every field absent', async () => {
    // Upstream masks exactly this: `resource = dict(name=name)` (`:83`) means a record is always truthy,
    // while `getall`'s `if interface:` filter (`:174`) drops whatever is falsy — so the caller cannot tell
    // "no such interface" from "interface with nothing configured" (the failure DR-029 records, and
    // divergence 7 here). Note the entry is named from the section header, not from the caller's argument:
    // probe — pyeapi answers `{'name': 'Po1', …}` back to `get('Po1')` for a config that spells it that way.
    const switchports = switchportsFor(textOf(['interface Ethernet7', '   mtu 9214', '!', 'end']))
    expect([...(await switchports.getAll()).keys()]).toEqual(['Ethernet7'])
    expect(await switchports.get('Ethernet7')).toEqual({ interfaceName: 'Ethernet7', trunkGroups: [] })
  })

  it('the `no switchport` exclusion is a command line, not a newline-anchored substring (switchports.py:80)', async () => {
    // Mid-block, upstream agrees (`:80-81`). At the END of the section text it does not: `'no switchport\n'`
    // needs a terminator immediately after (`:80`), so probe answers a record for it and then crashes in
    // `_parse_mode` (`:103`). Here the check is a parsed body line, so the exclusion does not depend on how
    // the text happens to be terminated (divergence 8) — and `getRunningConfig` trims the device text
    // either way (`command-layer.ts`, pyeapi `client.py:986-987`).
    expect(await switchportsFor(L2_CONFIG).get('Ethernet4')).toBeUndefined()
    const unterminated = await switchportsFor(textOf(['interface Ethernet4', '   no switchport'])).getAll()
    expect([...unterminated.keys()]).toEqual([])
    // `no switchport mode` is a different command and must not trigger the exclusion.
    const negated = await switchportsFor(textOf(['interface Ethernet5', '   no switchport mode', '   switchport access vlan 12', 'end'])).getAll()
    expect(negated.get('Ethernet5')).toEqual({ interfaceName: 'Ethernet5', trunkGroups: [], accessVlan: 12 })
  })

  it('a read the device refuses rejects with the device error, not an empty table', async () => {
    const transport = mockTransport().rejects('show running-config all', {
      code: EapiErrorCode.COMMAND_INVALID,
      message: "CLI command 2 of 2 'show running-config all' failed: invalid input",
    })
    const thrown = await outcome(() => new Node(transport).switchports.getAll())
    expect(thrown).toBeInstanceOf(CommandError)
    expect((thrown as CommandError).failedCommand).toBe('show running-config all')
  })
})

describe('SwitchportsResource field extraction — the five regexes at switchports.py:102-157', () => {
  it('mode keeps the whole token the device wrote, where upstream stops at the hyphen (:102)', async () => {
    // `switchport mode (\w+)` matches `[A-Za-z0-9_]`, so probe: a `switchport mode private-vlan` line
    // answers `mode: 'private'` upstream. `dot1q-tunnel` survives here because the value is the text after
    // the keyword (divergence 3), and `isSwitchportMode` narrows it for a UI without losing the read.
    for (const mode of SWITCHPORT_MODES) {
      const all = await switchportsFor(textOf(['interface Ethernet2', `   switchport mode ${mode}`, 'end'])).getAll()
      expect(all.get('Ethernet2')?.mode, mode).toBe(mode)
    }
    // A token outside the four this client writes is still reported rather than dropped or guessed.
    const exotic = await switchportsFor(textOf(['interface Ethernet2', '   switchport mode some-future-thing', 'end'])).getAll()
    expect(exotic.get('Ethernet2')?.mode).toBe('some-future-thing')
    expect(isSwitchportMode(exotic.get('Ethernet2')?.mode)).toBe(false)
    expect(isSwitchportMode('trunk')).toBe(true)
    expect(isSwitchportMode('private')).toBe(false) // upstream's truncation, `:102` — not a value this client writes
  })

  it('a negated line never answers for its positive form (probe: upstream reads the negation)', async () => {
    // Upstream's five patterns are unanchored `re.search`/`re.findall` over the whole block (`:102`, `:115`,
    // `:128`, `:142`, `:156`), so probe over `no switchport trunk allowed vlan 7` + `switchport mode trunk`
    // answers `trunk_allowed_vlans: '7'`, and `no switchport trunk group red` answers `trunk_groups: ['red']`.
    const config = textOf([
      'interface Ethernet1',
      '   no switchport trunk allowed vlan 7',
      '   no switchport trunk group red',
      '   no switchport access vlan 5',
      '   switchport mode trunk',
      'end',
    ])
    const entry = await switchportsFor(config).get('Ethernet1')
    expect(entry).toEqual({ interfaceName: 'Ethernet1', trunkGroups: [], mode: 'trunk' })
  })

  it('fields cannot read each other, and a quoted description cannot leak (contrast :102-157)', async () => {
    const entry = await switchportsFor(textOf([
      'interface Ethernet2',
      '   description switchport mode trunk',
      '   switchport access vlan 20',
      'end',
    ])).get('Ethernet2')
    expect(entry).toEqual({ interfaceName: 'Ethernet2', trunkGroups: [], accessVlan: 20 })
  })

  it('DR-028: the allowed-vlan value is the raw line remainder, keyword spellings included', async () => {
    // `switchports.py:156` is `switchport trunk allowed vlan (.+)$` — the whole remainder, and it is read
    // from the running-config (DECISIONS DR-028 keeps this; see that entry's note about
    // `forwarding:trunk:allowed-vlans`, which does not exist in this pinned clone — grep `forwarding` over
    // `pyeapi/`). So `all`, `except 5` and `red blue` are all readable values, and none is interpreted here.
    for (const raw of ['all', 'except 5', 'forward all', '10,20-25', 'none']) {
      const entry = await switchportsFor(textOf(['interface Ethernet1', '   switchport mode trunk', `   switchport trunk allowed vlan ${raw}`, 'end'])).get('Ethernet1')
      expect(entry?.trunkAllowedVlans, raw).toBe(raw)
    }
  })

  it('trunk groups keep device order; an absent set is an empty list (:105-116 parity)', async () => {
    const config = textOf(['interface Ethernet1', '   switchport trunk group blue', '   switchport trunk group red', 'end'])
    expect((await switchportsFor(config).get('Ethernet1'))?.trunkGroups).toEqual(['blue', 'red'])
    expect((await switchportsFor(textOf(['interface Ethernet1', '   switchport mode access', 'end'])).get('Ethernet1'))?.trunkGroups).toEqual([])
  })

  it('a trunk-group value with a space keeps the remainder, unlike switchports.py:115 (divergence 10 note)', async () => {
    // Probe over `switchport trunk group red blue`: `:115` (`([^\s]+)`) answers `['red']`, while
    // `vlans.py:60` (`(?P<value>.*)$`) answers `'red blue'`. The read keeps what the switch wrote; only the
    // *writers* enforce the single-token spelling both can round-trip (assertTrunkGroupName), and whether
    // the CLI has such a form at all is DECISIONS open item 4 — M12 (#14) to capture.
    const entry = await switchportsFor(textOf(['interface Ethernet1', '   switchport trunk group red blue', 'end'])).get('Ethernet1')
    expect(entry?.trunkGroups).toEqual(['red blue'])
  })

  it('a bare keyword line answers nothing rather than an empty value', async () => {
    // `valuesAfterKeyword`/`valueAfterKeyword` (`config-block.ts`) require at least one character after the
    // keyword, which is what both upstream trunk-group patterns require too (`:115`, `vlans.py:60`).
    const entry = await switchportsFor(textOf(['interface Ethernet1', '   switchport mode', '   switchport trunk group', 'end'])).get('Ethernet1')
    expect(entry).toEqual({ interfaceName: 'Ethernet1', trunkGroups: [] })
  })

  it('a numeric field that is not exactly decimal is a parse failure naming the section (:128 truncates)', async () => {
    // Probe: `switchport access vlan 20 extra` answers `'20'` upstream — `(\d+)` at `:128` matches the
    // prefix and the rest of the line is never looked at. Reporting is the `config-block.ts` rule: a parse
    // failure is never answered with a missing field (divergence 4).
    const thrown = await outcome(() => switchportsFor(textOf(['interface Ethernet1', '   switchport access vlan 20 extra', 'end'])).getAll())
    expect(thrown).toBeInstanceOf(ConfigParseError)
    expect((thrown as Error).message).toContain("switchports: cannot read 'switchport access vlan' in 'interface Ethernet1'")
    await expectError(
      () => switchportsFor(textOf(['interface Ethernet2', '   switchport trunk native vlan ninety-nine', 'end'])).getAll(),
      /cannot read 'switchport trunk native vlan' in 'interface Ethernet2'/,
    )
    // A VLAN id the writes would refuse still reads back as written, exactly as `vlans.ts` divergence 8 does.
    const wide = await switchportsFor(textOf(['interface Ethernet3', '   switchport access vlan 4095', 'end'])).get('Ethernet3')
    expect(wide?.accessVlan).toBe(4095)
  })

  it('the chassis form reads, subinterfaces do not, and a global `port-channel` block is not an interface', async () => {
    // `[^.\s]+` (`:169`) lets `Ethernet1/1` through and keeps subinterfaces out — upstream commit `7aecc8c`
    // "Ignore subinterfaces on switchports.getall()", kept here on the read side (divergence 5). The
    // `port-channel 1` block (lowercase, no `interface` header) is a global command section.
    const config = textOf([
      'interface Ethernet1/1',
      '   switchport mode trunk',
      '!',
      'interface Ethernet1.100',
      '   switchport access vlan 10',
      '!',
      'port-channel 1',
      '   member interface Ethernet1/1',
      'end',
    ])
    const all = await switchportsFor(config).getAll()
    expect([...all.keys()]).toEqual(['Ethernet1/1'])
    expect(all.get('Ethernet1.100')).toBeUndefined()
  })
})

describe('SwitchportsResource presence verbs — switchports.py:178-240, the exact lists test_api_switchports.py:73-82 pins', () => {
  it('create, delete and setDefault send upstream\'s command lists and issue zero reads', async () => {
    const transport = configTransport(L2_CONFIG)
    scriptWrite(transport, ['interface Ethernet1', 'no ip address', 'switchport'])
    scriptWrite(transport, ['interface Ethernet1', 'no switchport'])
    scriptWrite(transport, ['interface Ethernet1', 'no ip address', 'default switchport'])
    const switchports = new Node(transport).switchports
    await switchports.create('Ethernet1')
    await switchports.delete('Ethernet1')
    await switchports.setDefault('Ethernet1')
    // `no ip address` is upstream's own (`:196-197`, `:238-239`) and stays: it is what makes the create
    // mean "L2, not L3". `configureInterface` supplies the parent line once, never twice (row 71).
    // `test_api_switchports.py:74-82` / `switchports.py:196-198`, `:218-219`, `:238-240`.
    const batches = [
      ['enable', 'configure terminal', 'interface Ethernet1', 'no ip address', 'switchport'],
      ['enable', 'configure terminal', 'interface Ethernet1', 'no switchport'],
      ['enable', 'configure terminal', 'interface Ethernet1', 'no ip address', 'default switchport'],
    ]
    expect(sentAsText(transport)).toEqual([...batches])
    expect(transport.bodies().filter((body) => body.params.cmds.some((c) => String(c) === 'show running-config all'))).toEqual([])
  })

  it('create with attrs appends the field lines to the SAME transaction (divergence 12/13, no upstream twin)', async () => {
    const transport = configTransport(L2_CONFIG)
    const cmds = ['interface Ethernet1', 'no ip address', 'switchport', 'switchport mode access', 'switchport access vlan 20', 'switchport trunk native vlan 99']
    scriptWrite(transport, cmds)
    await new Node(transport).switchports.create('Ethernet1', { mode: 'access', accessVlan: 20, nativeVlan: 99 })
    expect(sentAsText(transport)).toEqual([['enable', 'configure terminal', ...cmds]])
    // Upstream's create takes no attributes at all (`:178`) and needs a second transaction per field
    // (`set_mode` at `:265`, `set_access_vlan` at `:290`).
  })

  it('a name this client cannot use as a switchport is refused before anything is sent (divergence 10)', async () => {
    const transport = configTransport(L2_CONFIG)
    const switchports = new Node(transport).switchports
    // Upstream checks nothing anywhere in the module: probe — `create('Nope1')` sends
    // `['interface Nope1', 'no ip address', 'switchport']`, and `set_trunk_groups('Nope1', …)` reaches the
    // `TypeError` at `:364` instead of a refusal that names the argument.
    // Two different guards, two different label sets. `assertInterfaceName` (`validators.ts:114-127`) runs
    // first and its label is verb-independent; the switchport-kind guard above it names the verb, because
    // `assertSwitchportName(verb, …)` includes the caller in the message.
    const badShape: readonly string[] = ['Nope1', 't1', 'Po1', 'Et1', 'Port-Channel', 'Ethernet1.100', 'Ethernet1/1', '']
    for (const name of badShape) {
      await expectRefusal(() => switchports.create(name), `invalid interface '${name}'`, /expected one of Ethernet/)
      await expectRefusal(() => switchports.delete(name), `invalid interface '${name}'`)
    }
    const wrongKind: readonly string[] = ['Management1', 'Vlan20', 'Loopback1', 'Vxlan1']
    for (const name of wrongKind) {
      // These are real interface names to this client — they just cannot be switchports, which is what
      // upstream's own `get` docstring documents at `:70-71` and its `:169` class attempts (badly).
      await expectRefusal(() => switchports.create(name), `invalid create interface '${name}'`, 'expected an Ethernet or Port-Channel name')
      await expectRefusal(() => switchports.setDefault(name), `invalid setDefault interface '${name}'`)
    }
    expect(transport.sent()).toEqual([])
    // Readable but unwritable, on purpose: upstream's own suite writes `Ethernet1/1`
    // (`test_api_switchports.py:47`, `:71-85`), and `validators.ts:57-61` refuses the chassis form until
    // M10 (#12) owns the per-kind name matrix (row 76). A UI can therefore select a row this client will not
    // write — reported, not silently accommodated.
    await expectRefusal(() => switchports.setMode('Ethernet1/1', 'access'), "invalid interface 'Ethernet1/1'")
  })
})

describe('SwitchportsResource mode and VLAN fields — switchports.py:242-342 and the DR-037 unset/default pairs', () => {
  it('setMode writes the four PLAN.md §M9 modes verbatim, and refuses a mode it has not chosen', async () => {
    const transport = configTransport(L2_CONFIG)
    for (const mode of SWITCHPORT_MODES) {
      scriptWrite(transport, ['interface Ethernet1', `switchport mode ${mode}`])
    }
    const switchports = new Node(transport).switchports
    for (const mode of SWITCHPORT_MODES) await switchports.setMode('Ethernet1', mode)
    expect(sentAsText(transport)).toEqual(
      SWITCHPORT_MODES.map((mode) => ['enable', 'configure terminal', 'interface Ethernet1', `switchport mode ${mode}`]),
    )
    // `test_api_switchports.py:89` exercises only `access`/`trunk`; upstream checks nothing (`:263-264`),
    // so probe answers `switchport mode banana`. Here the word is refused and nothing reaches the wire.
    await expectRefusal(() => switchports.setMode('Ethernet1', 'banana' as never), 'invalid switchport mode', /expected one of access \/ trunk \/ dot1q-tunnel \/ private-vlan/)
    expect(sentAsText(transport)).toHaveLength(SWITCHPORT_MODES.length)
  })

  it('unsetMode and defaultMode are their own verbs (set_mode with no value sends `no switchport mode` upstream, :262-265)', async () => {
    const transport = configTransport(L2_CONFIG)
    scriptWrite(transport, ['interface Ethernet1', 'no switchport mode'])
    scriptWrite(transport, ['interface Ethernet1', 'default switchport mode'])
    const switchports = new Node(transport).switchports
    await switchports.unsetMode('Ethernet1')
    await switchports.defaultMode('Ethernet1')
    // `test_api_switchports.py:96` / `:102`. DR-037: upstream's `set_mode(intf)` with no value produces the
    // `disable=` arm through the deprecated fall-through (`abstract.py:160-161`); here that intent is a named verb.
    expect(sentAsText(transport)).toEqual([
      ['enable', 'configure terminal', 'interface Ethernet1', 'no switchport mode'],
      ['enable', 'configure terminal', 'interface Ethernet1', 'default switchport mode'],
    ])
  })

  it('setAccessVlan is one round trip and zero config reads (PLAN.md §M9\'s access-port flow)', async () => {
    const transport = configTransport(L2_CONFIG)
    scriptWrite(transport, ['interface Ethernet1', 'switchport access vlan 20'])
    const switchports = new Node(transport).switchports
    await switchports.setAccessVlan('Ethernet1', 20)
    expect(sentAsText(transport)).toEqual([['enable', 'configure terminal', 'interface Ethernet1', 'switchport access vlan 20']])
    // `test_api_switchports.py:107-111` pins the text over a random vlan; upstream never range-checks the
    // value it interpolates at `:288`, so probe answers `switchport access vlan 99999` for that id.
    for (const bad of [0, 4095, 20.5, '20']) {
      await expectRefusal(() => switchports.setAccessVlan('Ethernet1', bad as number), 'invalid vlan', 'expected an integer VLAN id 1..4094')
    }
    // The rejected argument is named in `pythonRepr`, which quotes a string (`internal/wire.ts:216`) — the
    // rendering `validators.test.ts:55` pins for the same guard, and the reason a string id is a separate
    // mistake from an out-of-range number (upstream's `int('20')` accepts it; `assertVlanId` does not).
    // The string is a runtime-only caller mistake, so it reaches the guard through `unknown` rather than a
    // sound-looking `'20' as number` (the form `base.test.ts:418` uses for the same `assertVlanId` refusal).
    await expectRefusal(() => switchports.setAccessVlan('Ethernet1', '20' as unknown as number), "invalid vlan '20'")
    expect(sentAsText(transport)).toHaveLength(1)
  })

  it('unset/default for access vlan and trunk native vlan match upstream\'s kwarg arms (:288-290, :314-316)', async () => {
    const transport = configTransport(L2_CONFIG)
    const batches: string[][] = [
      ['interface Ethernet1', 'no switchport access vlan'],
      ['interface Ethernet1', 'default switchport access vlan'],
      ['interface Ethernet1', 'switchport trunk native vlan 99'],
      ['interface Ethernet1', 'no switchport trunk native vlan'],
      ['interface Ethernet1', 'default switchport trunk native vlan'],
    ]
    for (const batch of batches) scriptWrite(transport, batch)
    const switchports = new Node(transport).switchports
    await switchports.unsetAccessVlan('Ethernet1')
    await switchports.defaultAccessVlan('Ethernet1')
    await switchports.setTrunkNativeVlan('Ethernet1', 99)
    await switchports.unsetTrunkNativeVlan('Ethernet1')
    await switchports.defaultTrunkNativeVlan('Ethernet1')
    // `test_api_switchports.py:115`, `:121`, `:128-129`, `:135`, `:141-142`.
    expect(sentAsText(transport)).toEqual(batches.map((batch) => ['enable', 'configure terminal', ...batch]))
  })

  it('a native vlan the writes would refuse is refused without a round trip, and a range is sent as written', async () => {
    const transport = configTransport(L2_CONFIG)
    await expectRefusal(() => switchportsFor(L2_CONFIG).setTrunkNativeVlan('Ethernet1', 4095), 'invalid vlan 4095', /expected an integer VLAN id/)
    scriptWrite(transport, ['interface Ethernet1', 'switchport trunk native vlan 4094'])
    await new Node(transport).switchports.setTrunkNativeVlan('Ethernet1', 4094)
    expect(sentAsText(transport)).toEqual([['enable', 'configure terminal', 'interface Ethernet1', 'switchport trunk native vlan 4094']])
  })
})

describe('SwitchportsResource trunk allowed vlans — switchports.py:318-342 with M6\'s range vocabulary', () => {
  it('an id-list string goes out byte-identical to upstream\'s pin (:149-150)', async () => {
    const transport = configTransport(L2_CONFIG)
    scriptWrite(transport, ['interface Ethernet1', 'switchport trunk allowed vlan 1,2,3-5,6,7'])
    await new Node(transport).switchports.setTrunkAllowedVlans('Ethernet1', '1,2,3-5,6,7')
    expect(sentAsText(transport)).toEqual([['enable', 'configure terminal', 'interface Ethernet1', 'switchport trunk allowed vlan 1,2,3-5,6,7']])
  })

  it('a number list is sorted, de-duplicated and collapsed by M6\'s helpers (divergence 11, row 45)', async () => {
    const transport = configTransport(L2_CONFIG)
    const cases: readonly [readonly number[], string][] = [
      [[10, 20, 21, 22], '10,20-22'],
      [[20, 10, 10, 11], '10-11,20'],
      [[4094], '4094'],
      [[1, 2, 3, 5, 6, 7], '1-3,5-7'],
    ]
    const switchports = new Node(transport).switchports
    const expected: string[][] = []
    for (const [ids, text] of cases) {
      const batch = ['interface Ethernet1', `switchport trunk allowed vlan ${text}`]
      scriptWrite(transport, batch)
      await switchports.setTrunkAllowedVlans('Ethernet1', ids)
      expected.push(['enable', 'configure terminal', ...batch])
    }
    expect(sentAsText(transport)).toEqual(expected)
    // pyeapi neither sorts, collapses nor joins — it interpolates whatever string the caller built
    // (`:340-342`), and never calls its own range helpers at all (`config/ranges.ts` header, row 45).
    // M6's deliberately-ported quirks (row 47: `collapse_range('0,1')` → `['1']`) are not exercised here,
    // because this module only ever hands `collapseRange` sorted, de-duplicated, grammar-checked ids.
  })

  it('DR-028\'s keyword forms are passed through verbatim — the device keeps the authority to refuse (DR-032)', async () => {
    // Probe: upstream `value='all'` produces `switchport trunk allowed vlan all`. Keeping that pass-through
    // is DR-028's decision; the vocabulary is DECISIONS open item 4, so this client neither invents a
    // keyword grammar nor pretends the spelling is wrong.
    const transport = configTransport(L2_CONFIG)
    for (const raw of ['all', 'forward all', 'except 5', 'none']) {
      scriptWrite(transport, ['interface Ethernet1', `switchport trunk allowed vlan ${raw}`])
    }
    const switchports = new Node(transport).switchports
    for (const raw of ['all', 'forward all', 'except 5', 'none']) await switchports.setTrunkAllowedVlans('Ethernet1', raw)
    expect(transport.callCount()).toBe(4)
    // Read it back through the DR-028 read side and the same words are there.
    const entry = await switchportsFor(textOf(['interface Ethernet1', '   switchport trunk allowed vlan forward all', 'end'])).get('Ethernet1')
    expect(entry?.trunkAllowedVlans).toBe('forward all')
  })

  it('a value that looks like an id list but is not one is refused, and expansion is bounded (divergence 11)', async () => {
    const transport = configTransport(L2_CONFIG)
    const switchports = new Node(transport).switchports
    const bad: readonly [unknown, RegExp][] = [
      ['1,', /looks like an id list but is not one/],
      ['1-', /looks like an id list but is not one/],
      ['1-2-3', /looks like an id list but is not one/],
      [',10', /looks like an id list but is not one/],
      ['10,9999999', /the VLAN id 9999999 in that list is outside 1\.\.4094/],
      ['1-999999999', /the VLAN id 999999999 in that list is outside 1\.\.4094/],
      ['', /an empty value would send a trailing space/],
      [[], /an empty VLAN list is refused/],
      [[4095], /invalid vlan 4095/],
      [[20.5], /invalid vlan 20.5/],
      [7, /expected a range string or an array of VLAN ids/],
      ['red\x07blue', /control character/],
      ['10\nswitchport mode trunk', /control character/],
    ]
    for (const [value, message] of bad) {
      // Two different refusers, depending on where the value is caught: the module's own
      // `allowedVlansValueOf` guard labels it `switchports: invalid switchport trunk allowed vlan …`, and a
      // value that survives that guard is refused by `commandBuilder`, which labels the command
      // (`command-builder.ts`'s `refuseValue`: `commandBuilder("switchport trunk allowed vlan"): rejected …`).
      const thrown = await outcome(() => switchports.setTrunkAllowedVlans('Ethernet1', value as string))
      expect(thrown, String(value)).toBeInstanceOf(NotSupportedError)
      expect((thrown as Error).message).toMatch(message)
    }
    expect(transport.sent()).toEqual([])
    // Upstream sends all of these: probe `value='1,'` produces `switchport trunk allowed vlan 1,`, and its
    // own range helper corrupts the same shape (`collapse_range('1,2,')` → `['1-2','']`, `utils.py:214` —
    // MIGRATION.md §5 row 47, deliberately not relitigated here).
  })

  it('unset and default for the allowed list are the bulk negations no id-list value can produce (:340-342)', async () => {
    const transport = configTransport(L2_CONFIG)
    const batches: string[][] = [
      ['interface Ethernet1', 'no switchport trunk allowed vlan'],
      ['interface Ethernet1', 'default switchport trunk allowed vlan'],
    ]
    for (const batch of batches) scriptWrite(transport, batch)
    const switchports = new Node(transport).switchports
    await switchports.unsetTrunkAllowedVlans('Ethernet1')
    await switchports.defaultTrunkAllowedVlans('Ethernet1')
    // `test_api_switchports.py:156-157`, `:163-164`.
    expect(sentAsText(transport)).toEqual(batches.map((batch) => ['enable', 'configure terminal', ...batch]))
  })

  it('setTrunk configures mode, native and allowed in ONE transaction (divergence 12 — no upstream twin)', async () => {
    const transport = configTransport(L2_CONFIG)
    const cmds = ['interface Ethernet1', 'switchport mode trunk', 'switchport trunk native vlan 99', 'switchport trunk allowed vlan 10-12,20']
    scriptWrite(transport, cmds)
    await new Node(transport).switchports.setTrunk('Ethernet1', { nativeVlan: 99, allowedVlans: '10-12,20' })
    expect(sentAsText(transport)).toEqual([['enable', 'configure terminal', ...cmds]])
    // Upstream needs three calls and three config transactions for the same result (`:265`, `:316`, `:342`).
    // With no attrs the verb still writes the mode line alone, and an array goes through the same
    // canonicalisation `setTrunkAllowedVlans` applies.
    const bare = configTransport(L2_CONFIG)
    scriptWrite(bare, ['interface Ethernet2', 'switchport mode trunk'])
    const withIds = configTransport(L2_CONFIG)
    scriptWrite(withIds, ['interface Ethernet2', 'switchport mode trunk', 'switchport trunk allowed vlan 10,20-22'])
    await new Node(bare).switchports.setTrunk('Ethernet2')
    await new Node(withIds).switchports.setTrunk('Ethernet2', { allowedVlans: [22, 10, 20, 21] })
    expect(sentAsText(bare)).toEqual([['enable', 'configure terminal', 'interface Ethernet2', 'switchport mode trunk']])
    expect(sentAsText(withIds)).toEqual([['enable', 'configure terminal', 'interface Ethernet2', 'switchport mode trunk', 'switchport trunk allowed vlan 10,20-22']])
  })
})

describe('SwitchportsResource trunk groups — switchports.py:344-403, DR-030 and DR-027', () => {
  const GROUPS_CONFIG = textOf([
    'interface Ethernet1',
    '   switchport mode trunk',
    '   switchport trunk group red',
    '   switchport trunk group blue',
    'end',
  ])

  it('setTrunkGroups diffs against ONE read and writes ONE transaction carrying both directions', async () => {
    const transport = configTransport(GROUPS_CONFIG)
    const cmds = ['interface Ethernet1', 'switchport trunk group green', 'no switchport trunk group blue']
    scriptWrite(transport, cmds)
    const switchports = new Node(transport).switchports
    // The device has `red, blue`; the caller wants `red, green` — one add, one removal — and the caller's
    // repeated `green` must not become two lines (dedupe is ours; upstream iterates a `set`, `:369-373`).
    await switchports.setTrunkGroups('Ethernet1', ['red', 'green', 'green'])
    expect(sentAsText(transport)).toEqual([
      ['enable', 'show running-config all'],
      ['enable', 'configure terminal', ...cmds],
    ])
    // Upstream opens a separate `configure_interface` per add (`:369-371`) and per remove (`:373-375`), so
    // its own tests can only ever pin one command each (`test_api_switchports.py:184-185`, `:191-192`).
  })

  it('an already-matching set sends nothing at all — including no config transaction (probe: upstream agrees)', async () => {
    const transport = configTransport(GROUPS_CONFIG)
    await new Node(transport).switchports.setTrunkGroups('Ethernet1', ['blue', 'red'])
    expect(sentAsText(transport)).toEqual([['enable', 'show running-config all']])
  })

  it('an empty list clears every group one by one, named — which is not the bulk no form', async () => {
    const transport = configTransport(GROUPS_CONFIG)
    const cmds = ['interface Ethernet1', 'no switchport trunk group red', 'no switchport trunk group blue']
    scriptWrite(transport, cmds)
    await new Node(transport).switchports.setTrunkGroups('Ethernet1', [])
    expect(sentAsText(transport)[1]?.map(String)).toEqual(['enable', 'configure terminal', ...cmds])
    // The named form is upstream's, because `remove_trunk_group` never goes through `command_builder` — it
    // formats `'no switchport trunk group {}'.format(value)` (`:402`), pinned at `:191-192`/`:205-206`.
    // Probe of upstream over the same config: `set_trunk_groups('Ethernet1', [])` removes each group too.
  })

  it('removals follow device order and adds follow caller order', async () => {
    const transport = configTransport(textOf([
      'interface Port-Channel4',
      '   switchport trunk group red',
      '   switchport trunk group blue',
      '   switchport trunk group teal',
      'end',
    ]))
    const cmds = ['interface Port-Channel4', 'switchport trunk group zeta', 'switchport trunk group aa', 'no switchport trunk group red', 'no switchport trunk group blue', 'no switchport trunk group teal']
    scriptWrite(transport, cmds)
    await new Node(transport).switchports.setTrunkGroups('Port-Channel4', ['zeta', 'aa'])
    expect(sentAsText(transport)[1]?.map(String)).toEqual(['enable', 'configure terminal', ...cmds])
  })

  it('the bulk forms are separate verbs and take no name (:357-362; test_api_switchports.py:170, :177)', async () => {
    const transport = configTransport(GROUPS_CONFIG)
    const batches: string[][] = [
      ['interface Ethernet1', 'default switchport trunk group'],
      ['interface Ethernet1', 'no switchport trunk group'],
    ]
    for (const batch of batches) scriptWrite(transport, batch)
    const switchports = new Node(transport).switchports
    await switchports.defaultTrunkGroups('Ethernet1')
    await switchports.unsetTrunkGroups('Ethernet1')
    expect(sentAsText(transport)).toEqual(batches.map((batch) => ['enable', 'configure terminal', ...batch]))
    expect(transport.callCount()).toBe(2)
  })

  it('add and remove are unconditional, issue no read, and the negation keeps the name (:389, :402)', async () => {
    const transport = configTransport(GROUPS_CONFIG)
    const batches: string[][] = [
      ['interface Ethernet1', 'switchport trunk group red'],
      ['interface Ethernet1', 'no switchport trunk group red'],
      ['interface Ethernet1', 'switchport trunk group brand-new'],
    ]
    for (const batch of batches) scriptWrite(transport, batch)
    const switchports = new Node(transport).switchports
    await switchports.addTrunkGroup('Ethernet1', 'red')
    await switchports.removeTrunkGroup('Ethernet1', 'red')
    await switchports.addTrunkGroup('Ethernet1', 'brand-new')
    // `test_api_switchports.py:198-199`, `:205-206`. Re-adding a group the interface already has is sent
    // rather than diffed: `:390`/`:402` read nothing first, and a config read to find out would cost a
    // round trip to save nothing (parity, and DR-030 scopes the read budget rather than adding reads).
    expect(sentAsText(transport)).toEqual(batches.map((batch) => ['enable', 'configure terminal', ...batch]))
    expect(transport.bodies().filter((body) => body.params.cmds.some((c) => String(c) === 'show running-config all'))).toEqual([])
  })

  it('setting groups on a switchport the table does not have is a NotFoundError, not a TypeError (:364)', async () => {
    const transport = configTransport(GROUPS_CONFIG)
    const switchports = new Node(transport).switchports
    const thrown = await outcome(() => switchports.setTrunkGroups('Ethernet9', ['red']))
    expect(thrown).toBeInstanceOf(NotFoundError)
    expect((thrown as Error).message).toMatch(/the switch has no switchport Ethernet9 to set trunk groups on/)
    expect(sentAsText(transport)).toEqual([['enable', 'show running-config all']])
    // Probe: upstream raises `TypeError: 'NoneType' object is not subscriptable` at `:364` and sends
    // nothing. DR-027's required-lookup arm replaces it, because writing group lines to an interface this
    // client has not seen would invent an entry — and on a `no switchport` interface contradict the device.
    await expectError(() => switchportsFor(L2_CONFIG).setTrunkGroups('Ethernet4', ['red']), /the switch has no switchport Ethernet4/)
  })

  it('group names are validated before the read, so a bad call sends and reads nothing', async () => {
    const transport = configTransport(GROUPS_CONFIG)
    const switchports = new Node(transport).switchports
    // BEL is not `\s`, so a control character reaches the third guard rather than the single-token one —
    // the same reason `command-builder.ts` refuses a value with a line boundary (MIGRATION.md §5 row 74).
    for (const bad of ['', '   ', 'red blue', 'red\x07blue', 5, undefined]) {
      await expectRefusal(() => switchports.addTrunkGroup('Ethernet1', bad as string), 'invalid addTrunkGroup trunk group name', /invalid addTrunkGroup trunk group name/)
      await expectRefusal(() => switchports.removeTrunkGroup('Ethernet1', bad as string), 'invalid removeTrunkGroup trunk group name', /invalid removeTrunkGroup trunk group name/)
      await expectRefusal(() => switchports.setTrunkGroups('Ethernet1', [bad as string]), 'invalid setTrunkGroups trunk group name', /expected a single token|invalid setTrunkGroups trunk group name|an empty trunk group name/)
    }
    expect(transport.sent()).toEqual([])
    // Probe: upstream sends `add_trunk_group(intf, 5)` as `switchport trunk group 5` (`:389` formats
    // whatever arrives), and its two readers disagree about a two-word name (`:115` keeps `red`,
    // `vlans.py:60` keeps `red blue`) — so the single-token intersection is what this module writes.
  })

  it('a device rejection of a group write rejects with CommandError and failedCommand', async () => {
    // The brief's "refused write" case. What EOS actually says is an M12 (#14) capture; whether the
    // 7050TX-64 has `switchport trunk group` at all is DECISIONS open item 4 — the failure envelope here is
    // scripted, not claimed, and DR-005 is why there is no `False` + `.error` to check instead.
    const transport = configTransport(GROUPS_CONFIG).rejects('configure terminal', {
      code: EapiErrorCode.COMMAND_INVALID,
      message: "CLI command 4 of 4 'switchport trunk group red' failed: no such trunk group",
    })
    const thrown = await outcome(() => new Node(transport).switchports.addTrunkGroup('Ethernet1', 'red'))
    expect(thrown).toBeInstanceOf(CommandError)
    expect((thrown as CommandError).failedCommand).toBe('switchport trunk group red')
    expect((thrown as CommandError).commands).toEqual(['enable', 'configure terminal', 'interface Ethernet1', 'switchport trunk group red'])
  })

  it('a refused allowed-vlan write rejects with the device error and the command that failed', async () => {
    const transport = configTransport(L2_CONFIG).rejects('configure terminal', {
      code: EapiErrorCode.COMMAND_INVALID,
      message: "CLI command 4 of 4 'switchport trunk allowed vlan 999' failed: vlan 999 does not exist",
    })
    const thrown = await outcome(() => new Node(transport).switchports.setTrunkAllowedVlans('Ethernet1', '999'))
    expect(thrown).toBeInstanceOf(CommandError)
    expect((thrown as CommandError).failedCommand).toBe('switchport trunk allowed vlan 999')
    // pyeapi answers `False` and parks the exception on `connection.error` (`abstract.py:117-127`, DR-005);
    // `999` is in `1..4094`, so this client sends it and lets the device decide (DR-032).
  })
})

describe('SwitchportsResource cache seam and surface — DR-026 invalidation on write (command-layer.ts)', () => {
  it('a write drops the memo, so the next read costs one more request and sees fresh text', async () => {
    // `repliesOnce` for the reads: `MockTransport.script.find` (`mock-transport.ts:242`) takes the first
    // unconsumed match, and a sticky entry would answer both reads with the same text.
    const transport = mockTransport()
      .repliesOnce('enable\nshow running-config all', [{}, { output: L2_CONFIG }])
      .replies(writeKey(['interface Ethernet3', 'switchport access vlan 30']), okFor(['interface Ethernet3', 'switchport access vlan 30']))
      .repliesOnce('enable\nshow running-config all', [{}, { output: textOf(['interface Ethernet3', '   switchport mode access', '   switchport access vlan 30', 'end']) }])
    const switchports = new Node(transport).switchports
    expect((await switchports.get('Ethernet3'))?.accessVlan).toBe(20)
    await switchports.setAccessVlan('Ethernet3', 30)
    expect((await switchports.get('Ethernet3'))?.accessVlan).toBe(30)
    expect((await switchports.get('Ethernet3'))?.mode).toBe('access')
    expect(transport.callCount()).toBe(3)
    expect(sentAsText(transport)).toEqual([
      ['enable', 'show running-config all'],
      ['enable', 'configure terminal', 'interface Ethernet3', 'switchport access vlan 30'],
      ['enable', 'show running-config all'],
    ])
    // pyeapi clears its `lru_cache` and (with autorefresh) its `running_config` on every config call
    // (`client.py:665-669`); the same seam is asserted here so the ordering cannot drift silently.
  })

  it('the collection reads the source the base offers, and the registry reaches it the documented way', async () => {
    const transport = mockTransport().replies('enable\nshow running-config all', [{}, { output: L2_CONFIG }])
    const node = new Node(transport)
    const switchports = node.switchports
    expect(switchports).toBeInstanceOf(SwitchportsResource)
    // One memoised instance per Node (DR-052) — the accessor and `resource()` are the same object, which is
    // how the M8 header describes the seam (`command-layer.ts:617`, `:621`, `:631`, `:639`).
    expect(node.switchports).toBe(switchports)
    expect(node.resource('switchports')).toBe(switchports)
    // No config-source option exists on the collection verbs (`base.ts:227`); `{ config: 'startup-config' }`
    // is a `ResourceBase` argument (`base.ts:105`, `:114`; pinned for the base at `base.test.ts:216-222`).
    const startup = mockTransport().replies('enable\nshow startup-config', [{}, { output: textOf(['interface Ethernet8', '   switchport access vlan 8', 'end']) }])
    expect([...(await new Node(startup).switchports.configSections({ config: 'startup-config' })).keys()]).toEqual(['interface Ethernet8', 'end'])
    expect(startup.sent()).toEqual([['enable', 'show startup-config']])
  })

  it('an unregistered resource name still throws, and `vlans`/`switchports` are separate instances', async () => {
    const node = new Node(configTransport(L2_CONFIG))
    expect(() => node.resource('interfaces' as never)).toThrow(/interfaces/)
    expect(node.switchports).not.toBe(node.vlans)
    expect(await node.vlans.get(20)).toEqual({ id: 20, name: 'PROD', state: 'active', trunkGroups: [] })
  })
})
