/**
 * `switchports` — the L2 switchport view of an interface, M9 (#11): the `switchport …` lines inside an
 * `interface <name>` section, built on the M7 (#9) framework (`EntityCollection`,
 * `ResourceBase.configSections` / `configureInterface` / `commandBuilder`, the DR-026 `Node` memo, the
 * registry) and M6's (#8) config + range engine.
 *
 * Port of `pyeapi/api/switchports.py` (417 lines, BSD-3-Clause, Arista Networks — DR-001). As in
 * `vlans.ts`, every upstream range below was opened in the pinned clone
 * `/home/svaj/development/arista/pyeapi` (1.0.4-rc0, `develop` @ `6816d9e`) on 2026-11-03, and every
 * behavioural claim is what that code **actually answers** (probe runs of the real classes over a fake
 * `Node` whose `section()` reproduces `client.py:776-798`), not what its docstrings say. Nothing here
 * cites EOS image internals, and nothing here claims what the DCS-7050TX-64 supports: `switchport trunk
 * group` in particular is `docs/DECISIONS.md:586` open item 4, so this module implements the vocabulary
 * generically and asserts no hardware capability (M11 #13 probes it, M12 #14 captures it).
 *
 * **DR-028 and DR-029 as written do not match this pinned clone, and the code says so where it lands.**
 * `docs/DECISIONS.md:208-213` (DR-028) describes `switchports.py:117-124` / `:120` reading
 * `forwarding:trunk:allowed-vlans` out of `show interfaces … json`. In the pinned clone the string
 * `forwarding` appears in `pyeapi/` **only** as the `vrf forwarding` command (`api/interfaces.py:573`,
 * `api/vrfs.py:327`) — grep over the tree on 2026-11-03 — and the allowed-vlan value comes from the
 * running-config at `:156-157`. The **behaviour** DR-028 decides to keep is therefore the running-config
 * read, kept here and pinned by tests: the value is the raw line remainder, including non-numeric
 * spellings (`all`, `except 10`, and the `forward all` form DR-028 names). `docs/DECISIONS.md:214-219`
 * (DR-029) cites `switchports.py:147-151`, which is inside `_parse_trunk_allowed_vlans`'s docstring
 * (`:145-157`); the `name=` fallback it describes is at `:83` (`resource = dict(name=name)`, added in
 * upstream commit `ff007a7`) together with `getall`'s `if interface:` filter (`:174`). Both decisions are
 * implemented at the lines that actually exist here.
 *
 * | pyeapi (verified refs) | here |
 * |---|---|
 * | `Switchports(EntityCollection)` (`:46`) | {@link SwitchportsResource} extends `EntityCollection<Switchport, string, SwitchportAttrs>` (`base.ts:217`) |
 * | `get` (`:57-89`): `get_block('interface %s')` (`:79`), `if 'no switchport\n' in config: return` (`:80-81`), then `dict(name=name)` (`:83`) plus five `_parse_*` merges (`:84-88`) | {@link switchportsFromSections} + {@link SwitchportsResource.get}; negation is an exact command line, and every parse is one keyword pass over the block body |
 * | `_parse_mode` (`:91-103`): `re.search(r'switchport mode (\w+)', config, re.M)` then `value.group(1)` (`:102-103`) | {@link getSwitchportFields} — `findValue(body, 'switchport mode')`, whole remainder kept (divergence 3) |
 * | `_parse_trunk_groups` (`:105-116`): `re.findall(r'switchport trunk group ([^\s]+)', config, re.M)` (`:115`) | `findAllValues(body, 'switchport trunk group')`; single-token names are enforced on the way **out** ({@link assertTrunkGroupName}) |
 * | `_parse_access_vlan` (`:118-129`): `switchport access vlan (\d+)`, `… if value else None` (`:128-129`) | `accessVlan?: number` — the one field upstream tolerates when absent, and the one whose **tail** it silently drops (divergence 4) |
 * | `_parse_trunk_native_vlan` (`:131-143`) and `_parse_trunk_allowed_vlans` (`:145-157`): `match.group(1)` with no guard (`:143`, `:157`) | optional fields; absence is a field answer, not a crash (divergence 2) |
 * | `getall` (`:159-176`): `interfaces_re = re.compile(r'(?<=^interface\s)([Et|Po][^.\s]+)$', re.M)` (`:169`), then `self.get(name)` per hit and `if interface:` (`:172-175`) | one pass over the chunked document's indent-0 keys, **one** read (DR-030), kind-checked name (divergence 5) |
 * | `create` / `delete` / `default` (`:178-240`): `['interface %s', 'no ip address', 'switchport']` (`:196-198`), `['interface %s', 'no switchport']` (`:218-219`), `['interface %s', 'no ip address', 'default switchport']` (`:238-240`) | {@link SwitchportsResource.create} / {@link delete} / {@link setDefault} — the same command lists, via `submodeCommands` |
 * | `set_mode` (`:242-265`), `set_access_vlan` (`:267-290`), `set_trunk_native_vlan` (`:292-316`), `set_trunk_allowed_vlans` (`:318-342`): `command_builder(string, value, default, disable)` + `configure_interface(name, command)` | `setMode` / `setAccessVlan` / `setTrunkNativeVlan` / `setTrunkAllowedVlans` plus the `unset`/`default` pair each `default=`/`disable=` kwarg maps to (DR-037) |
 * | `set_trunk_groups` (`:344-377`): `default switchport trunk group` (`:357-358`), `no switchport trunk group` (`:361-362`), else `self.get(intf)['trunk_groups']` (`:364`) with one `configure_interface` **per** add (`:369-371`) and per remove (`:373-375`) | {@link SwitchportsResource.setTrunkGroups} — one read, one diff, one transaction; `defaultTrunkGroups` / `unsetTrunkGroups` are the two flag branches |
 * | `add_trunk_group` (`:379-390`), `remove_trunk_group` (`:392-403`): `'switchport trunk group {}'` / `'no switchport trunk group {}'` (`:389`, `:402`) | {@link addTrunkGroup} / {@link removeTrunkGroup} — same texts, same zero reads |
 * | `instance(node)` (`:406-417`) | the `RESOURCE_FACTORIES.switchports` row plus `Node.switchports` (DR-006/DR-052) |
 *
 * Upstream's own suite is `test/unit/test_api_switchports.py` — **21** test methods (counted by AST on
 * 2026-11-03): `test_get` (`:54-58`), `test_getall` (`:60-68`), `test_instance_functions` (`:70-85`),
 * `test_set_mode` (`:87-92`), `test_set_mode_with_no_value` (`:94-98`), `test_set_mode_with_default`
 * (`:100-104`), `test_set_access_vlan` (`:106-111`), `test_set_access_vlan_with_no_value` (`:113-117`),
 * `test_set_access_vlan_with_default` (`:119-123`), `test_set_trunk_native_vlan` (`:125-131`),
 * `test_set_trunk_native_vlan_with_no_value` (`:133-137`), `test_set_trunk_native_vlan_with_default`
 * (`:139-144`), `test_set_trunk_allowed_vlans` (`:146-152`),
 * `test_set_trunk_allowed_vlans_with_no_value` (`:154-159`), `test_set_allowed_vlans_with_default`
 * (`:161-166`), `test_set_trunk_groups_with_default` (`:168-173`), `test_set_trunk_groups_with_no`
 * (`:175-180`), `test_set_trunk_groups_with_add` (`:182-187`), `test_set_trunk_groups_with_remove`
 * (`:189-194`), `test_add_trunk_group` (`:196-201`), `test_remove_trunk_group` (`:203-208`). Every
 * command text they pin is reproduced verbatim here: the three presence verbs (`:73-81`), `switchport
 * mode access|trunk` (`:90`), `no switchport mode` (`:96`), `default switchport mode` (`:102`),
 * `switchport access vlan <v>` (`:109`), `no`/`default switchport access vlan` (`:115`, `:121`),
 * `switchport trunk native vlan <v>` (`:129`), `no`/`default switchport trunk native vlan` (`:135`,
 * `:142`), `switchport trunk allowed vlan 1,2,3-5,6,7` (`:149-150`), `no`/`default switchport trunk
 * allowed vlan` (`:156`, `:163`), `default switchport trunk group` (`:170`), `no switchport trunk group`
 * (`:177`), `switchport trunk group bang` (`:184`), `no switchport trunk group foo` (`:191`),
 * `switchport trunk group foo` (`:198`), `no switchport trunk group foo` (`:205`).
 *
 * ## Divergences this file owns (raw material for MIGRATION.md §5; the rows are the orchestrator's)
 *
 * 1. **a switchport that is not there answers `undefined`; upstream raises.** `get_block` returns `None`
 *    for an absent section (`abstract.py:96-101`), and `get` then evaluates `'no switchport\n' in config`
 *    (`:80`) on it — probe: `get('Ethernet99')` raises `TypeError: argument of type 'NoneType' is not
 *    iterable`. DR-027's vocabulary applies: absence is ordinary control flow (`base.ts:224-231`), so the
 *    `no switchport` test is only ever applied to text that exists.
 * 2. **partial blocks are field answers, not crashes.** `_parse_mode`, `_parse_trunk_native_vlan` and
 *    `_parse_trunk_allowed_vlans` each call `.group(…)` on the bare `re.search` result (`:103`, `:143`,
 *    `:157`), so probe: `get` on `interface Ethernet3` with `switchport mode access` + `switchport access
 *    vlan 20` and no trunk lines raises `AttributeError`, and one such interface makes `getall()` raise
 *    for the whole device (`:172-173`) — which is why upstream's `getall` cannot survive a real
 *    access-port config. Here every field is optional except `interfaceName` and `trunkGroups`, and the
 *    pinned fixture `test/fixtures/config/switchport-trunk.conf` (an access port with no trunk lines at
 *    all) parses. **No default is invented** for `mode`: an absent line means the configuration text does
 *    not state a mode, and what EOS defaults an L2 port to is an M11 #13 / M12 #14 question, not a
 *    client-side fact.
 * 3. **`mode` keeps the whole token the device wrote.** `switchport mode (\w+)` (`:102`) stops at the
 *    hyphen — probe: `switchport mode private-vlan` answers `mode: 'private'` — and it is unanchored, so a
 *    negated line answers too: probe over `no switchport trunk allowed vlan 7` + `switchport mode trunk`
 *    answers `trunk_allowed_vlans: '7'`, and `no switchport trunk group red` produces
 *    `trunk_groups: ['red']` (`:115` has no `no` guard either). Here the keyword match is on the command
 *    text (`config/text.ts`), so a `no …` line never answers for its positive form, and the value is the
 *    full remainder (`private-vlan`, not `private`). `Switchport.mode` is typed `string` rather than
 *    {@link SwitchportMode} on purpose: the four values in PLAN.md §M9 are what this client **writes**, and
 *    the EOS vocabulary beyond them is DECISIONS open item 4 — a read must not lose a token the switch
 *    wrote, and a parse failure must not be reported as an absent field. {@link isSwitchportMode} narrows
 *    for a UI.
 * 4. **numeric fields are checked, not truncated.** `switchport access vlan (\d+)` (`:128`) reads `20` and
 *    silently drops the rest of a line — probe: `switchport access vlan 20 extra` answers `'20'`. Here the
 *    value has to be exactly decimal, or the read reports a {@link ConfigParseError} naming the section
 *    (the `config-block.ts` rule: a parse failure is never answered with a missing field). Values come back
 *    as `number`s (MIGRATION.md §4), where upstream returns strings.
 * 5. **which sections are switchports.** Upstream's `(?<=^interface\s)([Et|Po][^.\s]+)$` (`:169`) is a
 *    **character** class — `E`, `t`, `|`, `P`, `o` — so probe: `interface t1` is read as a switchport while
 *    `interface Vlan20` and `interface Management1` are not, and `interface Po1` (a shorthand the rest of
 *    this client refuses) is. The `[^.\s]` half is deliberate (upstream commit `7aecc8c` "Ignore
 *    subinterfaces on switchports.getall()", `git log -- pyeapi/api/switchports.py`). Here the rule is the
 *    documented one — `get`'s own docstring says switchports are supported on Ethernet and Port-Channel
 *    (`:70-71`) — with the subinterface exclusion kept, and `interface Ethernet1/1` (chassis form, which
 *    upstream reads and its own tests write at `test_api_switchports.py:52`) kept on the **read** side.
 * 6. **one config read per operation.** Upstream's `getall` re-runs `section()` — a key scan plus a
 *    `re.compile` (`client.py:792-797`) — and five regexes per interface, and pyeapi's own
 *    `running_config`/`_chunkify` memos (`client.py:519-527`, `:697`) only hold until the next write
 *    clears them (`client.py:665-669`). DR-030 (`docs/DECISIONS.md:220-226`) is the wire guarantee
 *    `switchports.test.ts` measures: one `show running-config` for the whole collection and for a
 *    `get()` that reuses it, and **zero** reads for a single-field write.
 * 7. **DR-029's fallback cannot hide anything here.** Upstream always writes the caller's argument into the
 *    record (`resource = dict(name=name)`, `:83`) and drops falsy records from `getall` (`:174`). The
 *    failure mode DR-029 records — "it silently hides 'interface has no switchport config'" — is real and
 *    is pinned here by a test: an `interface Ethernet7` section with no `switchport …` line at all **is** in
 *    the table, with every field absent. What differs is who names the entry: {@link SwitchportsResource.getAll}
 *    keys and names an entry from the chunked section header, so a shorthand or a mistyped lookup name can
 *    never become a device answer the way `:83` lets it — probe: pyeapi answers `{'name': 'Po1', …}` for a
 *    config that spells the section `interface Po1`, while `assertInterfaceName`/{@link SWITCHPORT_SECTION_NAME}
 *    keep `Po1` out of this client's key space. `undefined` for a missing section replaces the `TypeError`
 *    (divergence 1), which is DR-029's "then fix" half; the real fix (the model-backed
 *    `show interfaces switchport json`) stays blocked on open item 4.
 * 8. **the `no switchport` exclusion is a command line, not a substring.** `'no switchport\n' in config`
 *    (`:80`) needs a newline immediately after, so probe: an interface block that **ends** the config with
 *    the line `   no switchport` is not excluded (and then crashes in `_parse_mode`), while one followed by
 *    any line is. Here the check is a parsed body line equal to `no switchport`, which is what the operator
 *    wrote, and it does not depend on how the text happens to be terminated (`Node.getRunningConfig` trims
 *    the device text either way — `command-layer.ts`, pyeapi `client.py:986-987`).
 * 9. **`setTrunkGroups` is one transaction, deterministically ordered.** Upstream iterates
 *    `set(...).difference(...)` (`:369-375`), so with more than one change the wire order is Python set
 *    order and every add/remove is a **separate** config transaction (probe:
 *    `set_trunk_groups('Ethernet1', ['red','green'])` sent one `configure_interface` for the add and one for
 *    the remove). Here: adds in caller order, then removals in device order, in one transaction — and, as
 *    upstream does when the sets already agree, nothing at all is sent. A lookup that comes up empty used to
 *    be a `TypeError` at `:364` (probe: `set_trunk_groups('Nope1', …)` sends nothing and raises) and is a
 *    `NotFoundError` (DR-027's required-lookup arm).
 * 10. **what the writers refuse.** Upstream validates nothing anywhere in this module: `create('Nope1')`
 *     sends `interface Nope1` (probe), `set_mode(intf, 'banana')` sends `switchport mode banana`
 *     (`:263-265`), `add_trunk_group(intf, value)` interpolates whatever arrives (`:389`), and
 *     `set_trunk_allowed_vlans` passes any string through (`:340-342`; probe: `value='all'` sends
 *     `switchport trunk allowed vlan all`, which is the behaviour DR-028 keeps). Here the interface name
 *     goes through `assertInterfaceName` + {@link SWITCHPORT_SECTION_NAME}, the VLAN ids through
 *     `assertVlanId`, the trunk-group names through {@link assertTrunkGroupName} (single token — the two
 *     upstream readers disagree about a multi-word name: probe gives `'red'` from `:115` but
 *     `'red blue'` from `vlans.py:60`), and `setMode` accepts the four PLAN.md §M9 values
 *     ({@link SWITCHPORT_MODES}), refusing to name a mode the client has not chosen — DR-053's pattern, and
 *     no new error class (DR-005/DR-010, the same call M8 made in `system.ts:208`). **A raw
 *     `switchport trunk allowed vlan` string is deliberately still passed through** (divergence 11): the
 *     vocabulary beyond a plain id list is exactly what open item 4 leaves unknown, the device keeps the
 *     authority to refuse it (DR-032), and upstream does the same.
 * 11. **range strings: canonicalised when the caller names ids, verbatim when the caller spells them.**
 *     Upstream interpolates whatever string arrives (`:340-342`) and its test pins `'1,2,3-5,6,7'`
 *     (`test_api_switchports.py:149-150`). A `readonly number[]` here goes through M6's
 *     `sortedRangeValues` + `collapseRangeToString` (`config/ranges.ts`), i.e. `[10, 20, 21, 22]` becomes
 *     `10,20-22` — the device-ready joined form that exists because pyeapi leaves the join to the caller
 *     (`utils.py:232` returns a list, and `ranges.ts`'s header records that pyeapi itself never calls
 *     either helper). A string is sent as written after the id-list grammar is range-checked, so
 *     `'10,20-25'` is byte-identical to upstream while `'10,9999999'` is refused by `assertVlanId`'s
 *     bound. M6's deliberately-ported range quirks (MIGRATION.md §5 row 47: `collapseRange('0,1')` →
 *     `['1']`, `collapseRange('1,2,')` → `['1-2', '']`) are **not** exercised here — this module only ever
 *     passes sorted, de-duplicated, grammar-checked ids to `collapseRange`, and does not fix row 47.
 * 12. **`setTrunk` has no upstream twin.** PLAN.md §M9 lists "`setTrunk` (native + allowed)" as one verb;
 *     upstream needs three calls (`:265`, `:316`, `:342`), each its own config transaction. One
 *     transaction here emits `switchport mode trunk` first, then the optional native/allowed lines. The
 *     order inside the transaction is this client's choice, not an EOS rule.
 * 13. **`create` takes attributes.** Upstream's `create(self, name)` (`:178-198`) sends the three-command
 *     list and nothing else; `SwitchportAttrs { mode?, accessVlan? }` appends those lines to the same
 *     transaction, mirroring the single-field verbs.
 */

import { ConfigParseError, NotFoundError, NotSupportedError } from '../errors'
import { pythonRepr } from '../internal/wire'
import { collapseRangeToString, expandRange, sortedRangeValues } from '../config/ranges'
import { findAllValues, findValue, parseBlock } from '../config/text'
import { EntityCollection } from './base'
import { assertInterfaceName, assertVlanId, isVlanId } from './validators'
import type { ConfigBlock } from '../config/text'
import type { ConfigSections } from '../config/chunk'
import type { ResourceTable } from './types'

/**
 * The switchport modes this client writes: PLAN.md §M9's "`interfaceMode` enum matching EOS
 * (`access | trunk | dot1q-tunnel | private-vlan`)". The set is a **write-side** policy — upstream checks
 * nothing (`set_mode` interpolates at `:263-264`; probe: `set_mode('Ethernet1', value='private-vlan')`
 * sends `switchport mode private-vlan`) and the modes a given EOS release accepts on this SKU are
 * `docs/DECISIONS.md:586` open item 4 (`vlans`/trunk-group support is probed by M11 #13). Upstream's own
 * tests use only `access` and `trunk` (`test/unit/test_api_switchports.py:89`).
 */
export type SwitchportMode = 'access' | 'trunk' | 'dot1q-tunnel' | 'private-vlan'

/** The modes in declaration order, for the runtime guard's message. */
export const SWITCHPORT_MODES: readonly SwitchportMode[] = ['access', 'trunk', 'dot1q-tunnel', 'private-vlan']

/** Narrow an arbitrary string (a config value, a table cell) to one of the modes this client writes. */
export function isSwitchportMode(value: unknown): value is SwitchportMode {
  return SWITCHPORT_MODES.includes(value as SwitchportMode)
}

/**
 * One switchport: the `switchport …` state of one interface section.
 *
 * Upstream's record is `name` / `mode` / `access_vlan` / `trunk_native_vlan` / `trunk_allowed_vlans` /
 * `trunk_groups` with string values (`:83-88`, `test_api_switchports.py:55-57`); this is the same shape
 * under MIGRATION.md §4's names and types, with every optional field meaning "the section does not carry
 * that line" rather than pyeapi's `None` — and with `mode` kept verbatim for the reason in divergence 3.
 */
export interface Switchport {
  /** The interface name, spelled as the section header spells it (divergence 7). */
  readonly interfaceName: string
  /** The whole `switchport mode …` remainder; {@link isSwitchportMode} narrows it. */
  readonly mode?: string
  /** `switchport access vlan <n>`. */
  readonly accessVlan?: number
  /** `switchport trunk native vlan <n>`. */
  readonly trunkNativeVlan?: number
  /** The raw `switchport trunk allowed vlan …` remainder — DR-028: `10-12,20`, `all`, `except 5`, `forward all`. */
  readonly trunkAllowedVlans?: string
  /** Every `switchport trunk group …` value, in device order. SKU support: open item 4, claimed nowhere. */
  readonly trunkGroups: readonly string[]
}

/**
 * What {@link SwitchportsResource.create} may configure in the same transaction as the `switchport` line
 * itself. Upstream's `create(self, name)` (`:178`) takes no attributes (divergence 13). The allowed-vlan
 * list is deliberately absent: it belongs to {@link TrunkAttrs}, because an access port and a trunk port
 * do not share that line's meaning. (Type alias, not interface: `ResourceAttrs` at `types.ts:67` needs
 * the implicit index signature an object literal type has and an interface does not.)
 */
export type SwitchportAttrs = {
  /** `switchport mode <value>`. */
  readonly mode?: SwitchportMode
  /** `switchport access vlan <id>`. */
  readonly accessVlan?: number
  /** `switchport trunk native vlan <id>` — with no `mode`, the device decides what that means. */
  readonly nativeVlan?: number
}

/** What {@link SwitchportsResource.setTrunk} configures alongside `switchport mode trunk` (divergence 12). */
export interface TrunkAttrs {
  /** `switchport trunk native vlan <id>`. */
  readonly nativeVlan?: number
  /**
   * `switchport trunk allowed vlan …`: either the VLAN ids to allow (collapsed to a device range string by
   * M6's helpers, divergence 11) or the exact spelling to send — an id list, or one of the keyword forms
   * this client cannot enumerate because they are an open device question (open item 4).
   */
  readonly allowedVlans?: string | readonly number[]
}

/** A section header naming an interface. Anchored, so an indented copy of the word never matches. */
const INTERFACE_SECTION = /^interface (\S+)$/u

/**
 * The interface names a switchport can exist on: `Ethernet1`, `Port-Channel4`, and the chassis forms
 * `Ethernet1/1` that upstream reads (`:169`'s `[^.\s]+`, kept by its own tests at
 * `test_api_switchports.py:52`). Subinterfaces (`Ethernet1.100`) stay excluded on upstream's terms — its
 * `.`-exclusion is the point of commit `7aecc8c` — and the shorthand `Po1` is excluded because this client
 * never accepts that spelling as a name (`validators.ts:61`, divergence 5).
 */
const SWITCHPORT_SECTION_NAME = /^(?:Ethernet|Port-Channel)[0-9]+(?:\/[0-9]+)*$/u

/** The negated form of the L2 mode: an exact command line, not a substring of the block (divergence 8). */
const NO_SWITCHPORT_COMMAND = 'no switchport'

/** An access-vlan / native-vlan value: exactly one decimal integer (divergence 4). */
const VLAN_NUMBER = /^[0-9]+$/u

/** The keyword forms of these commands, matched against a block body line's command text. */
const MODE_KEYWORD = 'switchport mode'
const ACCESS_VLAN_KEYWORD = 'switchport access vlan'
const TRUNK_NATIVE_VLAN_KEYWORD = 'switchport trunk native vlan'
const TRUNK_ALLOWED_VLAN_KEYWORD = 'switchport trunk allowed vlan'
const TRUNK_GROUP_KEYWORD = 'switchport trunk group'

/** One interface section's field extraction. */
type SwitchportFields = {
  mode: string | undefined
  accessVlan: string | undefined
  trunkNativeVlan: string | undefined
  trunkAllowedVlans: string | undefined
  trunkGroups: string[]
}

/**
 * One `interface …` block's switchport fields: the body's keyword lines only (header excluded), so
 * `no switchport …` lines never answer for their positive form and a value cannot leak from one field to
 * another (divergence 3 — contrast the five unanchored `re.search`/`re.findall` calls at `:102`, `:115`,
 * `:128`, `:142`, `:156`, all run over the whole block text).
 */
function getSwitchportFields(block: ConfigBlock): SwitchportFields {
  return {
    mode: findValue(block.body, MODE_KEYWORD),
    accessVlan: findValue(block.body, ACCESS_VLAN_KEYWORD),
    trunkNativeVlan: findValue(block.body, TRUNK_NATIVE_VLAN_KEYWORD),
    trunkAllowedVlans: findValue(block.body, TRUNK_ALLOWED_VLAN_KEYWORD),
    trunkGroups: findAllValues(block.body, TRUNK_GROUP_KEYWORD),
  }
}

/** Does this block's body contain the bare `no switchport` command? (pyeapi's test is `:80`.) */
function isNoSwitchport(block: ConfigBlock): boolean {
  for (const line of block.body) {
    if (line.text === NO_SWITCHPORT_COMMAND) return true
  }
  return false
}

/** A rejected argument is named in the message, rendered pyeapi's way — the `refuse` pattern from `validators.ts` (DR-053). */
function refuse(label: string, value: unknown, because: string): never {
  throw new NotSupportedError(`invalid ${label} ${pythonRepr(value)} — ${because}`, { cause: value })
}

/**
 * Require an interface name this client can use, and require it to be a switchport kind.
 *
 * `assertInterfaceName` (`validators.ts:114-127`) is M7's guard and stays the only interface-name parser
 * until M10 (#12) lands the per-kind discriminated union (PLAN.md §M10 "validation split") — this module
 * must not invent that parser. The kind test on top is this module's own contract, stated by upstream's
 * `get` docstring ("Switchports are only supported on Ethernet and Port-Channel interfaces", `:70-71`) and
 * implemented by upstream's (botched) `getall` class (`:169`, divergence 5). Upstream checks nothing on the
 * write path: probe — `create('Nope1')` sends `['interface Nope1', 'no ip address', 'switchport']`, and
 * `set_trunk_groups('Nope1', …)` reaches a `TypeError` reading the absent block.
 *
 * Consequence to keep visible: the chassis form `Ethernet1/1` is readable but unwritable today, because
 * `validators.ts`'s name parser deliberately requires `<kind><digits>` and says so in its own comment
 * (`validators.ts:47-61`: a chassis/slot form "is **not** accepted yet … M10 (#12) owns that matrix"),
 * which MIGRATION.md §5 row 76 records as an honest open item (chassis forms "refused rather than
 * guessed"). Upstream's own tests write `Ethernet1/1` (`test_api_switchports.py:52`), so a UI can select a
 * row this client will not write until M10 #12 lands — reported rather than silently accommodated.
 */
function assertSwitchportName(verb: string, value: unknown): asserts value is string {
  assertInterfaceName(value)
  if (SWITCHPORT_SECTION_NAME.test(value)) return
  refuse(
    `${verb} interface`,
    value,
    'expected an Ethernet or Port-Channel name: pyeapi documents switchports on those two kinds only (api/switchports.py:70-71) and its getall class tries to say so at :169',
  )
}

/** Require one of the modes this client writes ({@link SWITCHPORT_MODES}). */
function assertSwitchportMode(value: unknown): asserts value is SwitchportMode {
  if (isSwitchportMode(value)) return
  refuse('switchport mode', value, `expected one of ${SWITCHPORT_MODES.join(' / ')} — pyeapi interpolates any value into "switchport mode %s" (api/switchports.py:263-264) and reads back only up to the first hyphen (:102)`)
}

/**
 * A trunk group name must be one token.
 *
 * Upstream's two readers disagree about what a name is — `switchports.py:115`
 * (`switchport trunk group ([^\s]+)`) keeps the first token, probe: `switchport trunk group red blue`
 * answers `['red']`, while `vlans.py:60` keeps the whole remainder, probe: `'red blue'` — and neither
 * writer checks the value (`:389` uses `format`). The single-token intersection is the only spelling both
 * readers round-trip, so it is what this module writes. Whether `switchport trunk group` exists on this
 * SKU at all is DECISIONS open item 4 (`:586`); nothing here claims it does.
 */
function assertTrunkGroupName(verb: string, value: unknown): asserts value is string {
  if (typeof value !== 'string') refuse(`${verb} trunk group name`, value, 'expected a string trunk group name — pyeapi formats whatever arrives into the command (api/switchports.py:389)')
  if (value.trim() === '') refuse(`${verb} trunk group name`, value, 'an empty trunk group name is refused — clear every group with unsetTrunkGroups()/defaultTrunkGroups() (pyeapi `no switchport trunk group` / `default switchport trunk group`, api/switchports.py:357-362)')
  if (/\s/u.test(value)) refuse(`${verb} trunk group name`, value, 'expected a single token: the two upstream readers disagree about a multi-word name (switchports.py:115 keeps the first token, vlans.py:60 keeps the remainder)')
  if (hasControlCharacter(value)) refuse(`${verb} trunk group name`, value, 'a control character would break the config line this client reads back (command-builder.ts refuses a value with a line boundary for the same reason, row 74)')
}

/** C0 controls plus DEL, checked code-unit by code-unit — the same test M8's `hasControlCharacter` uses (`system.ts:178-184`). */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/** An allowed-vlan list written as `id` / `id-id` tokens separated by commas. */
const VLAN_ID_LIST = /^\d+(?:[-,]\d+)*$/u
/**
 * The loose "looks like an id list" shape: only digits, commas and dashes. A value inside it but outside
 * {@link VLAN_ID_LIST} (`1,`, `1-`, `1-2-3`) is a malformed list rather than one of the keyword forms, and
 * sending it would leave the device to interpret a typo — upstream sends it (probe: `value='1,'` produces
 * `switchport trunk allowed vlan 1,`) and upstream's own range helper corrupts the same shapes
 * (`collapse_range('1,2,')` → `['1-2','']`, `utils.py:214` — recorded in MIGRATION.md §5 row 47).
 */
const ID_LIST_CHARSET = /^[\d,-]+$/u
/**
 * The text to put after `switchport trunk allowed vlan `.
 *
 * - A `readonly number[]` is each-`assertVlanId`-checked, sorted and de-duplicated
 *   (`sortedRangeValues`), then collapsed to the device's compact form (`collapseRangeToString`):
 *   `[10, 20, 21, 22]` → `10,20-22`. That canonicalisation is this client's, not upstream's — pyeapi
 *   neither sorts nor joins, and never calls its own range helpers at all (`config/ranges.ts` header,
 *   MIGRATION.md §5 row 45).
 * - A plain id-list string is range-checked member by member (so `10,9999999` is refused) and otherwise
 *   sent **verbatim**, which is upstream's behaviour and what its test pins (`test_api_switchports.py:149`).
 * - Any other non-empty single-line string (DR-028's `forward all`, `all`, `except 5`) is sent verbatim
 *   too, on purpose: the keyword vocabulary of this command is an open device question (open item 4), the
 *   device keeps the authority to refuse it (DR-032), and `commandBuilder` still refuses an empty or
 *   multiline value (`command-builder.ts`, row 74).
 */
function allowedVlansValueOf(value: unknown): string {
  if (Array.isArray(value)) {
    const ids: number[] = []
    for (const id of value) {
      assertVlanId(id)
      ids.push(id)
    }
    if (ids.length === 0) {
      refuse('switchport trunk allowed vlan', value, 'an empty VLAN list is refused — clear the setting with unsetTrunkAllowedVlans()/defaultTrunkAllowedVlans() (pyeapi `disable=True` / `default=True`, api/switchports.py:340-342)')
    }
    return collapseRangeToString(sortedRangeValues(ids.map(String)))
  }
  if (typeof value !== 'string') {
    refuse('switchport trunk allowed vlan', value, 'expected a range string or an array of VLAN ids — pyeapi interpolates whatever arrives (api/switchports.py:340-342)')
  }
  if (hasControlCharacter(value)) {
    refuse('switchport trunk allowed vlan', value, 'a control character would break the config line this client reads back (row 74 in MIGRATION.md §5)')
  }
  if (ID_LIST_CHARSET.test(value) && !VLAN_ID_LIST.test(value)) {
    refuse('switchport trunk allowed vlan', value, 'that looks like an id list but is not one: expected ids separated by commas with runs written start-end. pyeapi would interpolate it as-is (api/switchports.py:340-342) and its range helper quietly corrupts the same shape (config/ranges.ts, MIGRATION.md §5 row 47 — deliberately not fixed here)')
  }
  if (VLAN_ID_LIST.test(value)) {
    for (const member of expandRange(value)) {
      const id = Number(member)
      if (!isVlanId(id)) {
        refuse('switchport trunk allowed vlan', value, `the VLAN id ${member} in that list is outside 1..4094 (the bound pyeapi itself uses at api/vlans.py:78; assertVlanId, validators.ts:91)`)
      }
    }
  }
  return value
}

/**
 * Read one numeric VLAN field. `undefined` means the section does not carry the line — upstream's only
 * tolerated absence is `access_vlan`'s (`:129`), and its `(\d+)` drops a line's tail silently (`:128`).
 *
 * @throws {ConfigParseError} the value is present but not exactly decimal (divergence 4).
 */
function vlanNumberOf(value: string | undefined, keyword: string, sectionKey: string): number | undefined {
  if (value === undefined) return undefined
  if (!VLAN_NUMBER.test(value)) {
    throw new ConfigParseError(
      `switchports: cannot read ${pythonRepr(keyword)} in ${pythonRepr(sectionKey)} — ${pythonRepr(value)} is not a decimal VLAN id. pyeapi matches (\\d+) and ignores the rest of the line (api/switchports.py:128, :142; probe: a 'switchport access vlan 20 extra' line answers '20'), and this client reports instead of truncating`,
      { sectionKey },
    )
  }
  return Number(value)
}

/**
 * Every switchport in a chunked running-config, in one pass and **one** device read (DR-030).
 *
 * Upstream builds the same shape by regex-scanning the whole text for interface names then calling `get`
 * per name (`:169-176`), where `get` raises for any interface lacking a trunk line (divergence 2) and the
 * `if interface:` filter (`:174`) silently drops falsy records. Here the filter is exactly the
 * `no switchport` command (divergence 8), and a section with no switchport lines at all is kept as a
 * record with absent fields — DR-029's masked case, made visible instead of hidden (divergence 7).
 */
function switchportsFromSections(sections: ConfigSections): Map<string, Switchport> {
  const switchports = new Map<string, Switchport>()
  for (const [key, sectionText] of sections) {
    const name = INTERFACE_SECTION.exec(key)?.[1]
    if (name === undefined || !SWITCHPORT_SECTION_NAME.test(name)) continue
    const block = parseBlock(sectionText)
    if (isNoSwitchport(block)) continue
    const fields = getSwitchportFields(block)
    const accessVlan = vlanNumberOf(fields.accessVlan, ACCESS_VLAN_KEYWORD, key)
    const trunkNativeVlan = vlanNumberOf(fields.trunkNativeVlan, TRUNK_NATIVE_VLAN_KEYWORD, key)
    const switchport: Switchport = {
      interfaceName: name,
      trunkGroups: fields.trunkGroups,
      ...(fields.mode === undefined ? {} : { mode: fields.mode }),
      ...(accessVlan === undefined ? {} : { accessVlan }),
      ...(trunkNativeVlan === undefined ? {} : { trunkNativeVlan }),
      ...(fields.trunkAllowedVlans === undefined ? {} : { trunkAllowedVlans: fields.trunkAllowedVlans }),
    }
    switchports.set(name, switchport)
  }
  return switchports
}

/**
 * `node.switchports` — the L2 state of each Ethernet / Port-Channel interface on one switch.
 *
 * `EntityCollection<Switchport, string, SwitchportAttrs>` (pyeapi's `Switchports(EntityCollection)`,
 * `:46`), keyed by interface name as `getall` keys it (`:172`). The PLAN.md §M9 exit gate — "the webui can
 * list VLANs, assign an access port, and show a diff before commit" — is served by
 * {@link setAccessVlan}: the UI reads the table, sends one field verb, and the config session's diff
 * (M5 #7) is what the operator reviews before the commit.
 */
export class SwitchportsResource extends EntityCollection<Switchport, string, SwitchportAttrs> {
  /**
   * Every switchport, keyed by interface name — pyeapi's `getall()` (`:159-176`) as a `ResourceTable`
   * (row 78), with device order preserved (`base.ts:255-258`).
   *
   * One `show running-config` for the whole collection, asserted from the transport's request list in
   * `switchports.test.ts` (DR-030). A section the switch has turned off with `no switchport` is not in the
   * table (parity with `:80-81`, reimplemented as a command check in divergence 8).
   */
  override async getAll(): Promise<ResourceTable<string, Switchport>> {
    return switchportsFromSections(await this.configSections())
  }

  /**
   * One interface's switchport state, or `undefined` — DR-027 again, and a lookup in the same one-read
   * table so `get`/`getAll()` agree by construction.
   *
   * Upstream's answer for an interface the switch does not have is a `TypeError` from the
   * `'no switchport\n' in config` test (`:80`; probe), not `None`, and its answer for an interface without
   * trunk lines is an `AttributeError` (divergence 2). No name guard runs here on purpose: reads report the
   * device (including the chassis forms this client cannot write yet, {@link assertSwitchportName}), while
   * every write is guarded.
   */
  override async get(name: string): Promise<Switchport | undefined> {
    return (await this.getAll()).get(name)
  }

  /**
   * Make the interface a L2 switchport: `interface <name>`, `no ip address`, `switchport` — pyeapi's
   * `create` (`:196-198`), the exact three-command list `test_api_switchports.py:76-77` pins, plus the
   * optional `mode`/`accessVlan`/`nativeVlan` lines this client appends inside the same transaction
   * (divergence 13). Upstream's `no ip address` stays: it is what makes the create mean "L2, not L3", and
   * removing it would change what gets written to a switch.
   */
  override async create(name: string, attrs?: SwitchportAttrs): Promise<void> {
    assertSwitchportName('create', name)
    const commands: string[] = ['no ip address', 'switchport']
    if (attrs?.mode !== undefined) {
      assertSwitchportMode(attrs.mode)
      commands.push(this.commandBuilder(MODE_KEYWORD, { value: attrs.mode }))
    }
    if (attrs?.accessVlan !== undefined) {
      assertVlanId(attrs.accessVlan)
      commands.push(this.commandBuilder(ACCESS_VLAN_KEYWORD, { value: attrs.accessVlan }))
    }
    if (attrs?.nativeVlan !== undefined) {
      assertVlanId(attrs.nativeVlan)
      commands.push(this.commandBuilder(TRUNK_NATIVE_VLAN_KEYWORD, { value: attrs.nativeVlan }))
    }
    await this.configureInterface(name, commands)
  }

  /** `interface <name>` + `no switchport` — pyeapi's `delete` (`:218-219`), the L3/L2 switch upstream's docstring describes as "delete the logical layer 2 interface". */
  override async delete(name: string): Promise<void> {
    assertSwitchportName('delete', name)
    await this.configureInterface(name, [NO_SWITCHPORT_COMMAND])
  }

  /** `no ip address` + `default switchport` — pyeapi's `default` (`:238-240`), which keeps the `no ip address` line. */
  override async setDefault(name: string): Promise<void> {
    assertSwitchportName('setDefault', name)
    await this.configureInterface(name, ['no ip address', this.commandBuilder('switchport', { mode: 'default' })])
  }

  /**
   * `switchport mode <mode>` — pyeapi's `set_mode` (`:242-265`), whose `value=` maps to the builder's
   * default mode and whose accepted words upstream never checks (`:263-264`).
   * `test_api_switchports.py:90` pins `switchport mode access` / `switchport mode trunk`.
   */
  async setMode(name: string, mode: SwitchportMode): Promise<void> {
    assertSwitchportName('setMode', name)
    assertSwitchportMode(mode)
    await this.configureInterface(name, [this.commandBuilder(MODE_KEYWORD, { value: mode })])
  }

  /** `no switchport mode` — upstream's `set_mode(disable=True)` (`:262-265`; `test_api_switchports.py:96`), which probe-confirmed is also what `set_mode(intf)` with no value produces (`abstract.py:160-161`, DR-037). */
  async unsetMode(name: string): Promise<void> {
    assertSwitchportName('unsetMode', name)
    await this.configureInterface(name, [this.commandBuilder(MODE_KEYWORD, { mode: 'no' })])
  }

  /** `default switchport mode` — upstream's `set_mode(default=True)` (`:263`; `test_api_switchports.py:102`). */
  async defaultMode(name: string): Promise<void> {
    assertSwitchportName('defaultMode', name)
    await this.configureInterface(name, [this.commandBuilder(MODE_KEYWORD, { mode: 'default' })])
  }

  /**
   * `switchport access vlan <id>` — pyeapi's `set_access_vlan` (`:267-290`,
   * `test_api_switchports.py:109`). The id goes through `assertVlanId` (upstream checks nothing, `:288`),
   * and this verb issues **zero** config reads: the UI's "assign an access port" flow (PLAN.md §M9's exit
   * gate) is one round trip, and the device decides whether the VLAN exists.
   */
  async setAccessVlan(name: string, vlan: number): Promise<void> {
    assertSwitchportName('setAccessVlan', name)
    assertVlanId(vlan)
    await this.configureInterface(name, [this.commandBuilder(ACCESS_VLAN_KEYWORD, { value: vlan })])
  }

  /** `no switchport access vlan` — upstream's `set_access_vlan(disable=True)` (`:288-290`; `test_api_switchports.py:115`). */
  async unsetAccessVlan(name: string): Promise<void> {
    assertSwitchportName('unsetAccessVlan', name)
    await this.configureInterface(name, [this.commandBuilder(ACCESS_VLAN_KEYWORD, { mode: 'no' })])
  }

  /** `default switchport access vlan` — upstream's `set_access_vlan(default=True)` (`:288`; `test_api_switchports.py:121`). */
  async defaultAccessVlan(name: string): Promise<void> {
    assertSwitchportName('defaultAccessVlan', name)
    await this.configureInterface(name, [this.commandBuilder(ACCESS_VLAN_KEYWORD, { mode: 'default' })])
  }

  /** `switchport trunk native vlan <id>` — pyeapi's `set_trunk_native_vlan` (`:292-316`, `test_api_switchports.py:129`). */
  async setTrunkNativeVlan(name: string, vlan: number): Promise<void> {
    assertSwitchportName('setTrunkNativeVlan', name)
    assertVlanId(vlan)
    await this.configureInterface(name, [this.commandBuilder(TRUNK_NATIVE_VLAN_KEYWORD, { value: vlan })])
  }

  /** `no switchport trunk native vlan` — upstream's `set_trunk_native_vlan(disable=True)` (`:314-316`; `test_api_switchports.py:135`). */
  async unsetTrunkNativeVlan(name: string): Promise<void> {
    assertSwitchportName('unsetTrunkNativeVlan', name)
    await this.configureInterface(name, [this.commandBuilder(TRUNK_NATIVE_VLAN_KEYWORD, { mode: 'no' })])
  }

  /** `default switchport trunk native vlan` — upstream's `set_trunk_native_vlan(default=True)` (`:314`; `test_api_switchports.py:142`). */
  async defaultTrunkNativeVlan(name: string): Promise<void> {
    assertSwitchportName('defaultTrunkNativeVlan', name)
    await this.configureInterface(name, [this.commandBuilder(TRUNK_NATIVE_VLAN_KEYWORD, { mode: 'default' })])
  }

  /**
   * `switchport trunk allowed vlan …` — pyeapi's `set_trunk_allowed_vlans` (`:318-342`,
   * `test_api_switchports.py:149-150`). The value handling is divergence 11, and the **read** side keeps
   * DR-028's raw remainder, so a write of an id list followed by a read gives that list back modulo M6's
   * rstrip (upstream keeps a trailing space — probe: `10,20-25 ` answers `'10,20-25 '`).
   */
  async setTrunkAllowedVlans(name: string, value: string | readonly number[]): Promise<void> {
    assertSwitchportName('setTrunkAllowedVlans', name)
    await this.configureInterface(name, [this.commandBuilder(TRUNK_ALLOWED_VLAN_KEYWORD, { value: allowedVlansValueOf(value) })])
  }

  /** `no switchport trunk allowed vlan` — upstream's `set_trunk_allowed_vlans(disable=True)` (`:340-342`; `test_api_switchports.py:156`). */
  async unsetTrunkAllowedVlans(name: string): Promise<void> {
    assertSwitchportName('unsetTrunkAllowedVlans', name)
    await this.configureInterface(name, [this.commandBuilder(TRUNK_ALLOWED_VLAN_KEYWORD, { mode: 'no' })])
  }

  /** `default switchport trunk allowed vlan` — upstream's `set_trunk_allowed_vlans(default=True)` (`:340`; `test_api_switchports.py:163`). */
  async defaultTrunkAllowedVlans(name: string): Promise<void> {
    assertSwitchportName('defaultTrunkAllowedVlans', name)
    await this.configureInterface(name, [this.commandBuilder(TRUNK_ALLOWED_VLAN_KEYWORD, { mode: 'default' })])
  }

  /**
   * Configure a trunk port in one transaction: `switchport mode trunk`, then `switchport trunk native
   * vlan <id>` and `switchport trunk allowed vlan …` when `attrs` carries them. PLAN.md §M9's "setTrunk
   * (native + allowed)" box; upstream has no twin (divergence 12) and needs three `configure_interface`
   * calls (`:265`, `:316`, `:342`).
   */
  async setTrunk(name: string, attrs?: TrunkAttrs): Promise<void> {
    assertSwitchportName('setTrunk', name)
    const commands: string[] = [this.commandBuilder(MODE_KEYWORD, { value: 'trunk' })]
    if (attrs?.nativeVlan !== undefined) {
      assertVlanId(attrs.nativeVlan)
      commands.push(this.commandBuilder(TRUNK_NATIVE_VLAN_KEYWORD, { value: attrs.nativeVlan }))
    }
    if (attrs?.allowedVlans !== undefined) {
      commands.push(this.commandBuilder(TRUNK_ALLOWED_VLAN_KEYWORD, { value: allowedVlansValueOf(attrs.allowedVlans) }))
    }
    await this.configureInterface(name, commands)
  }

  /**
   * Make the interface's trunk groups exactly `groups`: one read for the current value, one diff, one
   * transaction (divergence 9 — upstream pays a `get()` plus one config transaction per change,
   * `:364`-`:375`). Adds follow the caller's order, removals follow device order, and an already-matching
   * set sends nothing (probe-confirmed upstream sends nothing there either).
   *
   * Clearing every group by passing `[]` is upstream's `set_trunk_groups(intf, [])` answer — probe:
   * `['interface Ethernet1', 'no switchport trunk group red']` — and is deliberately **not** the bulk
   * `no switchport trunk group` / `default switchport trunk group` forms, which are
   * {@link unsetTrunkGroups} and {@link defaultTrunkGroups}.
   *
   * @throws {NotFoundError} the switch has no such switchport in this client's table. Upstream reads
   *   `self.get(intf)['trunk_groups']` at `:364` and raises `TypeError` when the section is absent (probe).
   *   Writing group lines to an interface this client has not seen would invent an entry — and on an L3
   *   (`no switchport`) interface it would contradict the device's own state.
   */
  async setTrunkGroups(name: string, groups: readonly string[]): Promise<void> {
    assertSwitchportName('setTrunkGroups', name)
    const wanted: string[] = []
    for (const group of groups) {
      assertTrunkGroupName('setTrunkGroups', group)
      if (!wanted.includes(group)) wanted.push(group)
    }
    const current = await this.get(name)
    if (current === undefined) {
      throw new NotFoundError(
        `switchports: the switch has no switchport ${name} to set trunk groups on — pyeapi reads ` +
          "self.get(intf)['trunk_groups'] here and raises TypeError on the None (api/switchports.py:364)",
        { cause: name },
      )
    }
    const adds = wanted.filter((group) => !current.trunkGroups.includes(group))
    const removes = current.trunkGroups.filter((group) => !wanted.includes(group))
    if (adds.length === 0 && removes.length === 0) return
    await this.configureInterface(name, [
      ...adds.map((group) => this.commandBuilder(TRUNK_GROUP_KEYWORD, { value: group })),
      ...removes.map((group) => this.commandBuilder(TRUNK_GROUP_KEYWORD, { value: group, mode: 'no' })),
    ])
  }

  /** `switchport trunk group <name>` — pyeapi's `add_trunk_group` (`:379-390`, `test_api_switchports.py:198`). No read first (parity with `:390`, divergence 10's last note). */
  async addTrunkGroup(name: string, group: string): Promise<void> {
    assertSwitchportName('addTrunkGroup', name)
    assertTrunkGroupName('addTrunkGroup', group)
    await this.configureInterface(name, [this.commandBuilder(TRUNK_GROUP_KEYWORD, { value: group })])
  }

  /** `no switchport trunk group <name>` — pyeapi's `remove_trunk_group` (`:392-403`, `test_api_switchports.py:205`). */
  async removeTrunkGroup(name: string, group: string): Promise<void> {
    assertSwitchportName('removeTrunkGroup', name)
    assertTrunkGroupName('removeTrunkGroup', group)
    await this.configureInterface(name, [this.commandBuilder(TRUNK_GROUP_KEYWORD, { value: group, mode: 'no' })])
  }

  /** `no switchport trunk group` — pyeapi's `set_trunk_groups(disable=True)` branch (`:361-362`; `test_api_switchports.py:177`). */
  async unsetTrunkGroups(name: string): Promise<void> {
    assertSwitchportName('unsetTrunkGroups', name)
    await this.configureInterface(name, [this.commandBuilder(TRUNK_GROUP_KEYWORD, { mode: 'no' })])
  }

  /** `default switchport trunk group` — pyeapi's `set_trunk_groups(default=True)` branch (`:357-358`; `test_api_switchports.py:170`). */
  async defaultTrunkGroups(name: string): Promise<void> {
    assertSwitchportName('defaultTrunkGroups', name)
    await this.configureInterface(name, [this.commandBuilder(TRUNK_GROUP_KEYWORD, { mode: 'default' })])
  }
}
