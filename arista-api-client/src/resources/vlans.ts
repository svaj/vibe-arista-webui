/**
 * `vlans` — the VLAN resource collection, M9 (#11): `vlan <id>` sections read from the running-config,
 * plus the create/delete/default and name/state/trunk-group writes, built entirely on the M7 (#9)
 * framework (`EntityCollection`, `ResourceBase.configSections` / `configure` / `commandBuilder`,
 * `parseConfigBlock`, the DR-026 `Node` memo, the registry) and M6's (#8) config engine.
 *
 * Port of `pyeapi/api/vlans.py` (372 lines, BSD-3-Clause, Arista Networks — DR-001). Every `pyeapi`
 * range in this file was opened in the pinned clone `/home/svaj/development/arista/pyeapi`
 * (1.0.4-rc0, `develop` @ `6816d9e`) on 2026-11-03, and every behavioural claim below is what the
 * upstream code **actually answers** — the probes are runs of the real classes over a fake `Node` whose
 * `section()` reproduces `client.py:776-798` — not what its docstrings say. Nothing here cites EOS
 * image internals, and nothing here claims what the DCS-7050TX-64 accepts: this workspace has no
 * readable CLI sources and unit tests never reach a device, so every EOS-side rule reads
 * "unverified on hardware, M12 (#14) to capture".
 *
 * | pyeapi (verified refs) | here |
 * |---|---|
 * | `Vlans(EntityCollection)` (`:83`) | {@link VlansResource} extends `EntityCollection<Vlan, number, VlanAttrs>` (`base.ts:217`) |
 * | `getall` (`:179-192`): `re.compile(r'(?<=^vlan\s)[\d,\-]+', re.M)` (`:187`) over the **whole** config text, then `response[vid] = self.get(vid)` per hit (`:190-191`) | {@link vlansFromSections} — one pass over the chunked document's **indent-0 section keys**, zero extra reads (DR-030) |
 * | `get` (`:91-113`): `get_block('vlan %s')`, `if not config: return None` (`:105-106`), then four `_parse_*` one-key dicts merged with `dict.update` (`:108-112`) | {@link VlansResource.getAll} / {@link VlansResource.get}; the record is typed, not stringly (MIGRATION.md §4, DR-003), and a missing entry is `undefined` (DR-027) |
 * | `_parse_vlan_id` (`:115-129`): `VLAN_ID_RE.search(config).group('value')` (`:128`) — the first `vlan\s` anywhere in the block, whole remainder | the **section header** of the entry (`vlan 20` → `20`), parsed to numbers — see divergence 1 |
 * | `NAME_RE` / `STATE_RE` / `TRUNK_GROUP_RE` (`:58-60`) + `_parse_name` (`:131-145`), `_parse_state` (`:147-161`), `_parse_trunk_groups` (`:163-177`: `findall`, `[]` when none) | {@link getVlanFields} — `valueAfterKeyword`/`valuesAfterKeyword` (`config-block.ts`) scoped to the block **body lines**, cut at the keyword |
 * | `create` / `delete` / `default` (`:194-232`): `'vlan %s'` / `'no vlan %s'` / `'default vlan %s'`, each `return self.configure(command) if isvlan(vid) else False` (`:204`, `:216`, `:232`) | {@link VlansResource.create} / {@link VlansResource.delete} / {@link VlansResource.setDefault} — the same three command texts, with `assertVlanId` and a **throw** instead of `False` (DR-005); `delete` **additionally refuses VLAN 1** before the wire — the default-VLAN carve-out (divergence 13, DR-139) |
 * | `configure_vlan` (`:234-246`): `make_iterable` + `commands.insert(0, 'vlan %s')` (`:244-245`) | {@link VlansResource.configureVlan} over `submodeCommands` (`command-builder.ts`, row 71) — never mutates the caller's list |
 * | `set_name` (`:248-265`), `set_state` (`:267-284`): `command_builder('name'\|'state', value=…, default=…, disable=…)` (`:263`, `:282`) | `setVlanName` / `unsetVlanName` / `defaultVlanName`, `setVlanState` / `unsetVlanState` / `defaultVlanState` — the `default=`/`disable=` kwargs become the mode table in `command-builder.ts` (DR-037) |
 * | `set_trunk_groups` (`:286-327`): `default trunk group` (`:310`), `no trunk group` (`:312`), else `self.get(vid)['trunk_groups']` (`:314`) and one `configure_vlan` **per** add (`:319-321`) and per remove (`:323-325`) | {@link VlansResource.setTrunkGroups} — one read, one diff, **one** transaction; `defaultTrunkGroups` / `unsetTrunkGroups` are the two flag branches |
 * | `add_trunk_group` (`:329-342`), `remove_trunk_group` (`:344-358`): `'trunk group %s'` / `'no trunk group %s'` | {@link VlansResource.addTrunkGroup} / {@link VlansResource.removeTrunkGroup} — same texts, same zero reads |
 * | `isvlan` (`:63-80`): `int(value)` then `value in range(1, 4095)` (`:77-78`) | `assertVlanId` (`validators.ts:91`) — no string coercion, no float truncation (row 76) |
 * | `instance(node)` (`:361-372`) | the `RESOURCE_FACTORIES.vlans` row plus `Node.vlans` (DR-006/DR-052) |
 *
 * Upstream's own suite is `test/unit/test_api_vlans.py` — **15** test methods (counted by AST on
 * 2026-11-03): `test_isvlan_with_string` (`:51-52`), `test_isvlan_valid_value` (`:54-55`),
 * `test_isvlan_invalid_value` (`:57-58`), `test_get` (`:60-70`), `test_get_not_configured` (`:72-73`),
 * `test_getall` (`:75-78`), `test_vlan_functions` (`:80-90`), `test_set_name` (`:92-105`),
 * `test_set_state` (`:107-122`), `test_set_trunk_groups_default` (`:124-128`),
 * `test_set_trunk_groups_add_value` (`:130-133`), `test_set_trunk_groups_remove_value` (`:135-138`),
 * `test_set_trunk_groups_remove_all` (`:140-143`), `test_add_trunk_group` (`:145-150`),
 * `test_remove_trunk_group` (`:152-157`). Every command text they pin (`vlan <v>` / `no vlan <v>` /
 * `default vlan <v>` at `:84-88`; `name`/`no name`/`default name` at `:97-104`;
 * `state active|suspend` / `no state` / `default state` at `:112-121`; `default trunk group` `:126`;
 * `trunk group tg2` `:132`; `no trunk group tg1` `:137`; `no trunk group` `:142`;
 * `trunk group <tg>` `:148`; `no trunk group <tg>` `:155`) is reproduced verbatim here.
 *
 * ## Divergences this file owns (raw material for MIGRATION.md §5; the rows are the orchestrator's)
 *
 * 1. **the id comes from the section header, not from a re-scan of the block.** Upstream's
 *    `_parse_vlan_id` reports the remainder of the **first `vlan\s` anywhere in the block text**
 *    (`vlan_id` at `:128`, `VLAN_ID_RE` at `:57`), so its answer is a *string* — `'11-13'` for a ranged
 *    header — and it is only correct because the header happens to be the first line. Here the id is the
 *    header's value parsed to numbers, and `Vlan.id` is a `number` (MIGRATION.md §4).
 * 2. **a ranged or enumerated header covers each id it names.** Upstream's `getall` keys the raw run of
 *    `[\d,\-]` characters as **one** entry (`vlans.py:187-191`; probe over a `vlan 200-202,204` section:
 *    `{"200-202,204": {vlan_id: "200-202,204", …}}`), which no `number`-keyed map can hold. Here the
 *    section's parsed fields attach to every member id (200, 201, 202, 204) in ascending order. That the
 *    body of a ranged section applies to each member is what the header form *means* upstream ("RE to find
 *    standalone and grouped (ranged, enumerated) vlans (#197)", `:186`); whether EOS writes or accepts a
 *    ranged `vlan` header is an M12 (#14) capture, and `docs/features.md` does not settle it.
 *    Consequence upstream cannot express: its `create`/`delete`/`default` all run `isvlan` on the key, and
 *    `isvlan('200-202,204')` is `False` (probe: `create`/`delete` return `False` and send **nothing**), so
 *    a ranged section can never be deleted through pyeapi. Here `delete(201)` sends `no vlan 201` — what
 *    the device does with that for a section written as a range is unverified on hardware, M12 (#14).
 * 3. **phantom entries are gone.** Upstream scans the *whole* config text with `re.M`, so any line that
 *    *begins* `vlan <digits>` is a VLAN: a `vlan 1` line inside a `banner login` body yields the entry
 *    `{"1": None}` (probe — banner bodies are written at column 0, and upstream's own fixture has exactly
 *    that line at `pyeapi/test/fixtures/running_config.text:411`, which is why its `test_getall` counts 5
 *    entries from **6** regex hits, `:75-78`). A header of `vlan 10x` yields `{"10": null}` (probe) and a
 *    header of `vlan 1,` yields the bogus key `'1,'` with a full record (probe). Here the source is the
 *    chunked document (`config/chunk.ts`, whose indent-0 keys are actual commands, `client.py:741-747`),
 *    so a banner body line and an indented copy never speak for a VLAN, and a header the id grammar cannot
 *    read is reported rather than dropped: a value outside upstream's `[\d,\-]` charset is not a VLAN
 *    section at all (parity with `:187` producing no match), a value inside it that the grammar cannot
 *    parse (`vlan 1,`, `vlan 1-`) is a {@link ConfigParseError} naming the section — upstream answers
 *    `'1,'` or crashes with `AttributeError` (probe).
 * 4. **one read for the whole collection, and one parse per section.** Upstream pays a `section()` key
 *    scan plus a `re.compile` plus four regex passes **per entity** (`:190-191` → `get` → `get_block` →
 *    `client.py:792-797`), and pyeapi's own `running_config`/`_chunkify` memos (`client.py:519-527`,
 *    `:697`) keep the *wire* cost down only until the next write clears them (`client.py:665-669`). DR-030
 *    is implemented as the wire guarantee `vlans.test.ts` measures: one `show running-config` per
 *    collection operation, including a `get()` that reuses the same memo.
 * 5. **a missing `name` or `state` line is a field answer, not a crash.** Both readers call
 *    `.group(...)` on the bare result of `re.search` (`:144`, `:160`), so `get` on a section without a
 *    `name …` line raises `AttributeError: 'NoneType' object has no attribute 'group'` — probe over a
 *    realistic config: `get('1')` on `vlan 1` with an empty body raises, `get('12')` on
 *    `name twelve` with no state line raises, and `getall()` **raises for the whole collection** because
 *    one such section is enough (`:190-191`). Here `name` is optional and `state` defaults to `'active'`.
 *    The default is a client rule with upstream's own words behind it — "It has two valid values: active
 *    or suspend" (`:41-43`) — and the observation that the pinned fixture writes `state active` for every
 *    VLAN (`running_config.text:383`, `:388`, `:394`, `:399`, `:404`); whether EOS omits the line is an
 *    M12 (#14) capture, and an omitted line is **not** evidence of an unconfigured state.
 * 6. **fields cannot read each other.** Upstream's four regexes (`:57-60`) are unanchored and run over the
 *    whole block, so a value in one field is read by another: `name state test` answers
 *    `{name: 'state test', state: 'test'}` and `name trunk group evil` answers `trunk_groups: ['evil']`
 *    (probe). Here every field is a keyword-anchored lookup over the block's parsed body lines
 *    (`valueAfterKeyword`/`valuesAfterKeyword`, `config-block.ts`), so `name …` can only answer `name` — which is also
 *    the shape `test_api_vlans.py` implicitly assumes and the shape a config diff has to be to be
 *    reviewable.
 * 7. **name values are unquoted and trimmed on the way in.** Upstream keeps the raw remainder of the line
 *    (`NAME_RE` at `:58`, `(?:name\s)(?P<value>.*)$`): probe — `name pad  ` answers `'pad  '`, and
 *    `name "seven"` answers `'"seven"'`. The read cuts the value at the keyword, drops the whitespace run
 *    after it and `unquote`s a balanced pair ({@link valueAfterKeyword} → `describeLine`/`lstrip`/`unquote`,
 *    `config-block.ts`, `config/text.ts:92`, `:150`, `:235`), so this module answers `pad` and
 *    `seven`. Round-tripping is why
 *    {@link assertVlanName} refuses a name with outer whitespace or a quote character (divergence 10).
 * 8. **ids outside `1..4094` are reported, not invented.** The read keeps whatever the device wrote
 *    (probe: upstream reads `vlan 99999` back as `'99999'`), because answering nothing about a section the
 *    switch has would be the wrong kind of lie (DR-027). The write side keeps `assertVlanId`'s range:
 *    `delete(99999)` throws naming it, where upstream returns `False` after `isvlan` says no
 *    (`:216`; probe: `create(99999)` returns `False` and sends nothing). A *run* whose endpoints sit
 *    outside that range is refused with a {@link ConfigParseError} instead of expanded — expanding
 *    `vlan 1-999999999` from device text is unbounded work for a client-side answer, and DR-032 is about
 *    not claiming a platform ceiling, not about looping forever. `4094` is the number pyeapi itself uses
 *    (`range(1, 4095)`, `:78`) and `validators.ts:35-36` already pins it.
 * 9. **`create` takes attributes.** Upstream's `create(self, vid)` (`:194`) creates a bare VLAN and there
 *    is no attrs form anywhere in the module. `VlanAttrs { name?, state? }` is PLAN.md §M9's
 *    "`create(vid)` … create with `name`" requirement: the extra fields go **inside** the `vlan <id>`
 *    submode in the same transaction, which is exactly what `set_name`/`set_state` do separately
 *    (`:263-265`, `:282-284`), and it costs one config transaction (upstream needs two calls).
 * 10. **input guards where upstream has none.** Nothing validates a name (`:248-265` interpolates
 *     whatever arrives into `'name %s'` through `command_builder` at `:263`), a state
 *     (`set_state(vid)` with no value sends the deprecated `no state` — probe; `abstract.py:160-161`,
 *     DR-037), a trunk-group name (`add_trunk_group(30, 5)` sends `trunk group 5` — probe) or an id on the
 *     `set_*`/group verbs (`set_name(999, …)` on an absent VLAN sends `['vlan 999', 'name x']` and thereby
 *     creates it — probe). {@link assertVlanName}, {@link assertVlanState}, {@link assertTrunkGroupName}
 *     and `assertVlanId` refuse those inputs with `NotSupportedError` naming the rejected value
 *     (DR-053's pattern, and no new error class — DR-005/DR-010, the same call M8 made in `system.ts:96`).
 *     The `1..4094` bound is a *write-side* policy; `vlan 20.5` is unreachable here, while upstream's
 *     `isvlan(20.5)` is `True` and its `create` interpolates the original, sending `vlan 20.5` (probe).
 * 11. **`setTrunkGroups` is one transaction with a deterministic order.** Upstream's loops iterate
 *     `set(...).difference(...)` (`:319-325`), so with more than one group the wire order is Python's hash
 *     order (per-process, not caller order), and each change is its **own** config transaction (probe:
 *     `set_trunk_groups('Ethernet1', ['red','green'])`-shaped calls send one `configure` per add and per
 *     remove). Here adds follow the caller's order first, removals follow device order, and all of them go
 *     out in a single `configure()` — and, as upstream does when the sets already match, **nothing** goes
 *     out at all (probe: `set_trunk_groups(30, ['red'])` where the VLAN already has only `red` sends no
 *     commands). A VLAN the switch does not have used to be a `TypeError: 'NoneType' object is not
 *     subscriptable` at `:314` (probe); it is a `NotFoundError` (DR-027's "required lookup" arm).
 * 12. **no existence pre-check on writes.** `delete`, `setDefault`, `setVlanName`, `setVlanState` and the
 *     two single-group verbs send their command without reading the config first — upstream does the same
 *     (`:204`, `:216`, `:232`, `:265`, `:284`, `:342`, `:358` issue zero reads), the device decides, and a
 *     rejected write rejects with its `CommandError` including `failedCommand` (DR-005).
 * 13. **`delete` refuses VLAN 1.** `assertVlanId` admits `1..4094` for every verb and must keep doing it:
 *     `create(1)` and `setDefault(1)` legitimately name the default VLAN (a `vlan 1` stanza with
 *     `name`/`state` lines is ordinary config), and the read path runs no write-guard at all (DR-059).
 *     `no vlan 1` is different — it attacks the VLAN every port starts on and every trunk carries by
 *     default — and whether the device rejects it (`1002`), silently accepts it, or rewrites interface
 *     state on the way is **uncaptured**: no answer exists in the 2026-11-08 supervised session or the
 *     cEOS catalog (#122 open question 1), and even a future probe of command *presence* is not evidence
 *     about deletion *semantics* (DR-043). Under DR-005's "refuse, don't soften" posture `delete(1)`
 *     throws `NotSupportedError` **before a transaction opens** — same class as the range guard, no new
 *     error type (DR-010). The lab lane already encoded the same reasoning: `requireScratchVlan` refuses
 *     spare ids below 2 (`live-guard.ts:674`, "vlan 1 is the default every port begins on and is never a
 *     scratch"). The webui S2 screen keeps its own matching guard as belt and braces (#122, DR-139).
 */

import { ConfigParseError, NotFoundError, NotSupportedError } from '../errors'
import { pythonRepr } from '../internal/wire'
import { expandRange } from '../config/ranges'
import { parseBlock } from '../config/text'
import { valueAfterKeyword, valuesAfterKeyword } from './config-block'
import { EntityCollection } from './base'
import { submodeCommands } from './command-builder'
import { assertVlanId } from './validators'
import type { ConfigBlock } from '../config/text'
import type { ConfigSections } from '../config/chunk'
import type { CommandInput } from './types'
import type { ResourceTable } from './types'

/**
 * The two VLAN states. Upstream's module docstring states the set — "It has two valid values: active or
 * suspend" (`vlans.py:41-43`) — but never checks it: `set_state(vid, value='banana')` interpolates
 * (`:282-284`). The read side honours the same two values and reports anything else as a parse failure
 * (divergence 5); whether the CLI has other spellings is an M12 (#14) capture.
 */
export type VlanState = 'active' | 'suspend'

/** The states in wire/parse order, for the runtime guard's message. */
const VLAN_STATES: readonly VlanState[] = ['active', 'suspend']

/**
 * One VLAN entry, as this client reads it. `id` is the numeric id the section header names
 * (MIGRATION.md §4: VLAN ids are numbers, unlike upstream's string `vlan_id`, `vlans.py:128`); `name` is
 * absent when the section has no `name` line (divergence 5) rather than pyeapi's crash or `None`;
 * `state` defaults to `active`; `trunkGroups` is the list in device order, empty when the switch has none
 * (upstream parity, `:176-177`).
 */
export interface Vlan {
  /** The VLAN id this entry describes. */
  readonly id: number
  /** The `name …` line's value, unquoted (row 49) — absent when the section carries no name. */
  readonly name?: string
  /** `state …` as written, defaulting to `active` when the line is absent (divergence 5). */
  readonly state: VlanState
  /** The `trunk group …` values, in device order. Support on the 7050TX-64 is DECISIONS open item 4. */
  readonly trunkGroups: readonly string[]
}

/**
 * What {@link VlansResource.create} may configure alongside the `vlan <id>` line itself. Upstream's
 * `create(self, vid)` (`:194`) has no attributes; these two come from PLAN.md §M9 ("create with `name`")
 * and are the same commands the separate field verbs send (divergence 9).
 *
 * A type alias rather than an interface on purpose: `EntityCollection`'s third parameter is constrained to
 * `ResourceAttrs` (`types.ts:67`), which is `Readonly<Record<string, …>>`, and TypeScript gives the
 * implicit index signature only to an object type literal — an interface would be a compile error there.
 */
export type VlanAttrs = {
  /** `name <value>` inside the new VLAN's submode. */
  readonly name?: string
  /** `state <value>` inside the new VLAN's submode. */
  readonly state?: VlanState
}

/** A section header that names VLANs: `vlan 20`, `vlan 11-13`, `vlan 200-202,204`. */
const VLAN_SECTION = /^vlan (\S+)$/u

/**
 * The header value pyeapi's `getall` accepts as a VLAN: one or more digits, commas and dashes
 * (`(?<=^vlan\s)[\d,\-]+`, `vlans.py:187`). Anything else — `vlan internal allocation policy ascending`
 * (the real fixture line at `running_config.text:42`), `vlan 10x` — produces no id at all upstream, so it
 * is not a VLAN section here either (divergence 3 keeps the **half** of that behaviour which is a rule
 * about commands, and drops the half which is a phantom entry).
 */
const UPSTREAM_ID_CHARSET = /^[\d,-]+$/u

/** A header value this client can enumerate: ids separated by commas, a run written `start-end`. */
const VLAN_ID_LIST = /^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/u

/** One enumerated run inside a header value. */
const VLAN_RUN = /^(\d+)-(\d+)$/u

/** Inclusive VLAN id ceiling used for the read-side run guard — pyeapi's own bound (`vlans.py:78`). */
const VLAN_ID_RUN_MAX = 4094

/** One VLAN section's field extraction, as {@link getVlanFields} answers it. */
type VlanFields = {
  name: string | undefined
  state: string | undefined
  trunkGroups: string[]
}

/** One `vlan …` block's fields: the body's keyword lines only, header excluded (divergence 6). */
function getVlanFields(block: ConfigBlock): VlanFields {
  return {
    name: valueAfterKeyword(block.body, 'name'),
    state: valueAfterKeyword(block.body, 'state'),
    trunkGroups: valuesAfterKeyword(block.body, 'trunk group'),
  }
}

/** A rejected argument is named in the message, rendered pyeapi's way — the `refuse` pattern from `validators.ts` (DR-053). */
function refuse(label: string, value: unknown, because: string): never {
  throw new NotSupportedError(`invalid ${label} ${pythonRepr(value)} — ${because}`, { cause: value })
}

/**
 * Refuse a VLAN name this client could not read back.
 *
 * Upstream validates nothing (`set_name(vid, name=None …)` at `:248` interpolates through
 * `command_builder('name', …)` at `:263`; probe — `set_name(30, None)` sends `no name` because the
 * `value=None` fall-through produces the deprecated negation, `abstract.py:160-161`), and a name with a
 * line boundary would be interpolated into a second command line (row 74 — `commandBuilder` refuses that
 * part too). The rules below are this client's round-trip contract, mirroring M8's `assertHostname`: the
 * read side takes the text after the `name` keyword, whitespace-trimmed and unquoted
 * ({@link valueAfterKeyword}, `config-block.ts`; M6 gives it rstripped at `describeLine`, `config/text.ts:150`
 * and unquoted at `unquote`, `:235` — row 49), so an outer space
 * or a balanced quote pair cannot survive a write/read cycle. Whether EOS itself accepts those characters
 * — or quotes them the way `description " WAN uplink "` is quoted — is unverified on hardware,
 * M12 (#14) to capture.
 */
function assertVlanName(value: unknown): asserts value is string {
  if (typeof value !== 'string') refuse('vlan name', value, 'expected a string VLAN name (pyeapi checks nothing at vlans.py:248-265)')
  if (value.trim() === '') {
    refuse('vlan name', value, 'an empty VLAN name is refused — clear it with unsetVlanName() (pyeapi `no name`, vlans.py:259) rather than an empty value (DR-037)')
  }
  if (value !== value.trim()) {
    refuse('vlan name', value, 'leading or trailing whitespace cannot read back: `name …` is read as the text after the keyword, whitespace-trimmed (valueAfterKeyword, config-block.ts) — pyeapi keeps it verbatim (probe: `name pad  ` answers `pad  `, vlans.py:58)')
  }
  if (hasControlCharacter(value)) {
    refuse('vlan name', value, 'a control character would break the config line this client reads back (the same reason command-builder.ts refuses a value with a line boundary, row 74)')
  }
  if (value.includes('"')) {
    refuse('vlan name', value, 'a name containing a quote cannot round-trip through this reader, which unquotes a balanced pair (valueAfterKeyword → unquote, config-block.ts / config/text.ts:235, MIGRATION.md §5 row 49). Legality on EOS is unverified on hardware, M12 (#14) to capture — pyeapi would answer `"seven"` with the quotes in it (probe, vlans.py:58)')
  }
}

/** C0 controls plus DEL, checked code-unit by code-unit — the same test M8's `hasControlCharacter` uses (`system.ts:178-184`). */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/**
 * A trunk group name must be one token.
 *
 * Upstream's two trunk-group parsers disagree about what a name is, and that disagrees with what its
 * writers send: `vlans.py:60` (`trunk\sgroup\s(?P<value>.*)$`) keeps the whole line remainder — probe:
 * `trunk group red blue` reads back as `'red blue'` — while `switchports.py:115`
 * (`switchport trunk group ([^\s]+)`) keeps only the first token — probe: `'red'`. Neither checks the
 * value on the way out (`add_trunk_group(vid, name)` interpolates at `:342`; probe:
 * `add_trunk_group(30, 5)` sends `trunk group 5`), so a non-string would silently become a name. The
 * single-token intersection is the only spelling both readers agree on, so it is what this module writes.
 * Whether `switchport trunk group` / `vlan … trunk group` exist on the DCS-7050TX-64 at all is
 * DECISIONS.md open item 4 (M11 #13 probes it); nothing here claims they do.
 */
function assertTrunkGroupName(verb: string, value: unknown): asserts value is string {
  if (typeof value !== 'string') refuse(`${verb} trunk group name`, value, 'expected a string trunk group name — pyeapi interpolates whatever arrives into the command (vlans.py:342, switchports.py:389)')
  if (value.trim() === '') refuse(`${verb} trunk group name`, value, 'an empty trunk group name is refused — clear every group with unsetTrunkGroups()/defaultTrunkGroups() (pyeapi `no trunk group` / `default trunk group`, vlans.py:310-312)')
  if (/\s/u.test(value)) {
    refuse(`${verb} trunk group name`, value, 'expected a single token: the two upstream readers disagree about a multi-word name (vlans.py:60 keeps the remainder, switchports.py:115 keeps the first token only)')
  }
  if (hasControlCharacter(value)) refuse(`${verb} trunk group name`, value, 'a control character would break the config line this client reads back (command-builder.ts refuses a value with a line boundary for the same reason, row 74)')
}

/**
 * Require one of the two documented VLAN states.
 *
 * `set_state(vid, value=…)` interpolates anything (`:282-284`) and, with **no** value, falls through to
 * the deprecated `'no %s'` (`abstract.py:160-161`) — probe: `set_state(20)` sends `no state` and
 * `set_state(20, 'banana')` would send `state banana`. Those two forms are `unsetVlanState` and a thrown
 * `NotSupportedError` here (DR-037, DR-005/DR-010).
 */
function assertVlanState(value: unknown): asserts value is VlanState {
  if (VLAN_STATES.includes(value as VlanState)) return
  refuse('vlan state', value, `expected one of ${VLAN_STATES.join(' / ')} — pyeapi does not check (vlans.py:267-284) and its docstring states the same two values (vlans.py:41-43)`)
}

/**
 * The state a section answers. `undefined` (no `state …` line) means `active` — divergence 5.
 *
 * @throws {ConfigParseError} a `state …` line whose value is neither documented spelling. The device wrote
 *   something this model does not have, and answering `active` for it would show an operator a state the
 *   switch did not write (the same "never answer a missing field for a parse failure" rule
 *   `config-block.ts` states).
 */
function vlanStateOf(value: string | undefined, sectionKey: string): VlanState {
  if (value === undefined) return 'active'
  if (value === 'active' || value === 'suspend') return value
  throw new ConfigParseError(
    `vlans: unexpected state ${pythonRepr(value)} in ${pythonRepr(sectionKey)} — the VLAN state has two documented values, active or suspend (pyeapi api/vlans.py:41-43), and this client refuses to guess a third`,
    { sectionKey },
  )
}

/** A numeric id inside a run whose endpoints are outside the VLAN range pyeapi itself uses. */
function isRunnableVlanId(id: number): boolean {
  return id >= 1 && id <= VLAN_ID_RUN_MAX
}

/**
 * The ids a section header names, ascending and de-duplicated. `undefined` means "not a VLAN section" —
 * the header value is outside upstream's own character set (`vlans.py:187`), which is how
 * `vlan internal allocation policy ascending` (`running_config.text:42`) is not a VLAN anywhere.
 *
 * @throws {ConfigParseError} the value is inside that character set but is not an id list this client can
 *   enumerate (`vlan 1,`, `vlan 1-2-3`) or a run reaching outside `1..4094`. Upstream answers a bogus
 *   `'1,'` key for the first (probe) and raises `AttributeError` for the second (probe); either way it is
 *   not a report about the switch (divergence 3, and the bounded-work note in divergence 8).
 */
function vlanIdsOf(headerValue: string, sectionKey: string): number[] | undefined {
  if (!UPSTREAM_ID_CHARSET.test(headerValue)) return undefined
  if (!VLAN_ID_LIST.test(headerValue)) {
    throw new ConfigParseError(
      `vlans: cannot enumerate the VLAN ids in ${pythonRepr(sectionKey)} — pyeapi accepts the raw run of digits, commas and dashes as one key (api/vlans.py:187-191; probe: a 'vlan 1,' header answers the key '1,' with a full record) and this client reports it instead of inventing members`,
      { sectionKey },
    )
  }
  for (const token of headerValue.split(',')) {
    const run = VLAN_RUN.exec(token)
    if (run?.[1] === undefined || run[2] === undefined) continue
    const start = Number(run[1])
    const end = Number(run[2])
    if (!isRunnableVlanId(start) || !isRunnableVlanId(end) || end < start) {
      throw new ConfigParseError(
        `vlans: the id run ${pythonRepr(token)} in ${pythonRepr(sectionKey)} is not expandable (expected an ascending run inside 1..${String(VLAN_ID_RUN_MAX)}, the range pyeapi itself tests at api/vlans.py:78) — expanding device text without bound is not defensible, and neither is claiming the members`,
        { sectionKey },
      )
    }
  }
  // `VLAN_ID_LIST` requires at most one `-` per token, so every token here is either `id` or `start-end`
  // and `expandRange` cannot reach its "not a single range" branch (`config/ranges.ts:95-98`), which is
  // where a `1-2-3` header used to land before the grammar was tightened.
  const ids = new Set<number>()
  // `expandRange` is M6's (#8) range vocabulary: ',' values, '-' inclusive runs, canonical decimal
  // endpoints (config/ranges.ts, ports of utils.py:175-195 including its documented oddities — row 47 is
  // deliberately NOT relitigated here, and the grammar check above means it cannot throw on this input).
  for (const member of expandRange(headerValue)) ids.add(Number(member))
  return [...ids].sort((a, b) => a - b)
}


/**
 * Every VLAN in a chunked running-config, in one pass and **one** device read (DR-030).
 *
 * Iteration order is the document's, which is what makes `keys()` "device order" (the contract
 * `base.ts:255-258` sets for `EntityCollection.keys`, replacing pyeapi's `__iter__` at `abstract.py:217-218`
 * — and pyeapi's own order is the regex's, not the config's, once a section is ranged).
 */
function vlansFromSections(sections: ConfigSections): Map<number, Vlan> {
  const vlans = new Map<number, Vlan>()
  for (const [key, sectionText] of sections) {
    const header = VLAN_SECTION.exec(key)?.[1]
    if (header === undefined) continue
    const ids = vlanIdsOf(header, key)
    if (ids === undefined) continue
    const fields = getVlanFields(parseBlock(sectionText))
    const state = vlanStateOf(fields.state, key)
    for (const id of ids) {
      const vlan: Vlan = {
        id,
        state,
        trunkGroups: fields.trunkGroups,
        ...(fields.name === undefined ? {} : { name: fields.name }),
      }
      vlans.set(id, vlan)
    }
  }
  return vlans
}

/**
 * `node.vlans` — the VLANs configured on one switch.
 *
 * `EntityCollection<Vlan, number, VlanAttrs>` (pyeapi's `Vlans(EntityCollection)`, `vlans.py:82`): the
 * key is a `number` because that is what a VLAN *is* to this client and to the webui's table
 * (MIGRATION.md §4), unlike upstream's string keys — which is also divergence 2's root cause, since a
 * ranged header cannot be a `number`.
 */
export class VlansResource extends EntityCollection<Vlan, number, VlanAttrs> {
  /**
   * Every VLAN, keyed by id — pyeapi's `getall()` (`vlans.py:179-192`) as a `ResourceTable` (row 78).
   *
   * One `show running-config` for the whole collection, proven in `vlans.test.ts` from the transport's
   * request list. Upstream answers a `dict` whose values can be `None` while the key came from the same
   * scan (probe: `{"10": null}` for a `vlan 10x` header) and cannot answer at all when one section lacks a
   * `name`/`state` line (divergence 5); neither is possible here.
   */
  override async getAll(): Promise<ResourceTable<number, Vlan>> {
    return vlansFromSections(await this.configSections())
  }

  /**
   * One VLAN, or `undefined` when the switch has no such VLAN (DR-027 — pyeapi's `get` returns `None` for
   * an absent block at `:105-106`, which is the half of its behaviour this port keeps; its
   * `AttributeError` for a *present but incomplete* block, `:144`/`:160`, is divergence 5).
   *
   * This is a lookup in the same one-read table, so `get(20)` and `getAll()` agree by construction and
   * `get` never re-reads the device. No range guard here on purpose: a read answers what the switch has,
   * including an id `assertVlanId` would refuse to write (divergence 8), and "not configured" is the
   * ordinary answer a UI branches on.
   */
  override async get(name: number): Promise<Vlan | undefined> {
    return (await this.getAll()).get(name)
  }

  /**
   * Create a VLAN: `vlan <id>`, plus `name …` / `state …` inside the same submode when `attrs` carries
   * them (divergence 9). pyeapi's `create(self, vid)` (`:194-204`) sends the bare command only after
   * `isvlan` passes, and answers `False` when it does not — probe: `create(0)` and `create(99999)` return
   * `False` having sent nothing, and `create(20.5)` sends `vlan 20.5`. Here a rejected id throws
   * `NotSupportedError` naming it, and a device refusal rejects with its `CommandError` (DR-005).
   */
  override async create(name: number, attrs?: VlanAttrs): Promise<void> {
    assertVlanId(name)
    const commands: string[] = []
    if (attrs?.name !== undefined) {
      assertVlanName(attrs.name)
      commands.push(this.commandBuilder('name', { value: attrs.name }))
    }
    if (attrs?.state !== undefined) {
      assertVlanState(attrs.state)
      commands.push(this.commandBuilder('state', { value: attrs.state }))
    }
    await this.configure(submodeCommands(`vlan ${String(name)}`, commands))
  }

  /**
   * `no vlan <id>` — pyeapi's `delete` (`:206-216`), whose `return … if isvlan(vid) else False` is the
   * `False` DR-005 removes.
   *
   * **VLAN 1 is refused here.** `assertVlanId` admits the whole 1..4094 write range — it is the shared
   * guard for every verb on this class, and `create`/`setDefault` legitimately name any id in it — so the
   * carve-out lives in this method alone. VLAN 1 is the default VLAN: present on every switch, the default
   * member of every trunk, the access VLAN every port starts on. Whether the device would reject `no vlan 1`
   * with a `1002`, silently accept it, or rewrite the interface table as a side effect is an uncaptured
   * claim (issue #122 open question 1: neither the 2026-11-08 supervised hardware session nor the cEOS
   * captures answer it, and an observation of the command's presence on some SKU would not be a statement
   * about 7050TX-64 deletion *semantics*). Under DR-005's "refuse, don't soften" posture the client refuses
   * to send it on a caller's behalf, and `NotSupportedError` is the same class `assertVlanId` already uses
   * (row 10 above, and no new error class — DR-010). `VlanManagement.tsx` (the S2 screen shipped in #72)
   * keeps its own matching guard as belt-and-braces, and its copy names the client's refusal so the screen
   * never overstates or understates the lane.
   */
  override async delete(name: number): Promise<void> {
    assertVlanId(name)
    if (name === 1) {
      throw new NotSupportedError(
        'refuse to delete vlan 1: VLAN 1 is the default VLAN, present on every switch and the default member of every trunk. This client never sends `no vlan 1` (DR-005: refuse rather than soften). A caller who specifically wants to probe the device\'s answer should use a lower-level `configSession`.',
      )
    }
    await this.configure(this.commandBuilder(`vlan ${String(name)}`, { mode: 'no' }))
  }

  /** `default vlan <id>` — pyeapi's `default` (`:218-232`), the top-level form, not the submode one. */
  override async setDefault(name: number): Promise<void> {
    assertVlanId(name)
    await this.configure(this.commandBuilder(`vlan ${String(name)}`, { mode: 'default' }))
  }

  /**
   * Enter `vlan <id>` and send commands inside it — pyeapi's `configure_vlan` (`:234-246`), whose
   * `make_iterable` + `commands.insert(0, …)` pair (`:244-245`) mutates the caller's array. Probe: two
   * `configure_vlan` calls on one list send `['vlan 20', 'name a']` then `['vlan 21', 'vlan 20', 'name a']`
   * — the parent line accumulates. {@link submodeCommands} builds a fresh list per call (row 71).
   *
   * The id is asserted first, so `setVlanName(99999, …)` cannot reach the wire: upstream checks nothing
   * here and probe-confirmed `set_name(999, name='x')` creates the VLAN as a side effect of writing to it.
   */
  private async configureVlan(id: number, commands: CommandInput): Promise<void> {
    assertVlanId(id)
    await this.configure(submodeCommands(`vlan ${String(id)}`, commands))
  }

  /** `name <value>` — pyeapi's `set_name(vid, name=…)` (`:248-265`); `test_api_vlans.py:97` pins the text. */
  async setVlanName(id: number, value: string): Promise<void> {
    assertVlanName(value)
    await this.configureVlan(id, [this.commandBuilder('name', { value })])
  }

  /** `no name` — upstream's `set_name(vid, disable=True)` (`:259`; `test_api_vlans.py:102`). */
  async unsetVlanName(id: number): Promise<void> {
    await this.configureVlan(id, [this.commandBuilder('name', { mode: 'no' })])
  }

  /** `default name` — upstream's `set_name(vid, default=True)` (`:261`; `test_api_vlans.py:105`). */
  async defaultVlanName(id: number): Promise<void> {
    await this.configureVlan(id, [this.commandBuilder('name', { mode: 'default' })])
  }

  /**
   * `state active` / `state suspend` — pyeapi's `set_state(vid, value=…)` (`:267-284`), with the two-value
   * guard upstream lacks (divergence 10). `test_api_vlans.py:112` pins both command texts.
   */
  async setVlanState(id: number, value: VlanState): Promise<void> {
    assertVlanState(value)
    await this.configureVlan(id, [this.commandBuilder('state', { value })])
  }

  /** `no state` — upstream's `set_state(vid, disable=True)` (`:278`; `test_api_vlans.py:117`), which probe-confirmed is also what `set_state(vid)` with no value produces (`abstract.py:160-161`, DR-037). */
  async unsetVlanState(id: number): Promise<void> {
    await this.configureVlan(id, [this.commandBuilder('state', { mode: 'no' })])
  }

  /** `default state` — upstream's `set_state(vid, default=True)` (`:280`; `test_api_vlans.py:121`). */
  async defaultVlanState(id: number): Promise<void> {
    await this.configureVlan(id, [this.commandBuilder('state', { mode: 'default' })])
  }

  /**
   * Make the VLAN's trunk groups exactly `groups`: one read of the current state, one diff, one
   * transaction (divergence 11). The diff direction matches upstream's loops — additions
   * (`:319-321`) before removals (`:323-325`) — while the order inside each direction is ours rather than
   * a Python set's.
   *
   * A no-op when the sets already agree: probe-confirmed upstream sends nothing in that case too
   * (`set_trunk_groups(30, ['red'])` on a VLAN that already has only `red`), and this client does not open
   * a config transaction for a change that does not exist. An empty list clears every group, which is
   * upstream's `set_trunk_groups(30, [])` answer — probe: `['vlan 30', 'no trunk group red']` — and is
   * deliberately *not* the `no trunk group` / `default trunk group` bulk forms, which are
   * {@link unsetTrunkGroups} and {@link defaultTrunkGroups}.
   *
   * @throws {NotFoundError} the switch has no such VLAN. Upstream's `self.get(vid)['trunk_groups']`
   *   (`:314`) raises `TypeError: 'NoneType' object is not subscriptable` in the same situation (probe).
   *   This is DR-027's *required* lookup: the diff is meaningless without a current value, and writing
   *   groups to a VLAN this client has not seen would create one as a side effect.
   * @throws {NotSupportedError} a group name that is not a single token ({@link assertTrunkGroupName}).
   */
  async setTrunkGroups(id: number, groups: readonly string[]): Promise<void> {
    assertVlanId(id)
    const wanted: string[] = []
    for (const group of groups) {
      assertTrunkGroupName('setTrunkGroups', group)
      if (!wanted.includes(group)) wanted.push(group)
    }
    const current = await this.get(id)
    if (current === undefined) {
      throw new NotFoundError(
        `vlans: the switch has no vlan ${String(id)} to set trunk groups on — pyeapi reads ` +
          "self.get(vid)['trunk_groups'] here and raises TypeError on the None (api/vlans.py:314)",
        { cause: id },
      )
    }
    const adds = wanted.filter((group) => !current.trunkGroups.includes(group))
    const removes = current.trunkGroups.filter((group) => !wanted.includes(group))
    if (adds.length === 0 && removes.length === 0) return
    await this.configureVlan(id, [
      ...adds.map((group) => this.commandBuilder('trunk group', { value: group })),
    // The name has to sit **inside** the command text for a negation: `commandBuilder(text, { mode: 'no' })`
    // is pyeapi's `disable=True` arm, which returns `no %s` and drops the value entirely
    // (`abstract.py:154-155`, pinned in `command-builder.ts`'s table: `{ mode: 'no', value: 'x' }` answers
    // `no ip routing`). Upstream's `remove_trunk_group` never calls `command_builder` — it formats
    // `'no trunk group %s' % name` directly (`vlans.py:358`), and `test_api_vlans.py:137` pins
    // `no trunk group tg1` — so the name goes into the stem here to produce that same text.
    ...removes.map((group) => this.commandBuilder(`trunk group ${group}`, { mode: 'no' })),
    ])
  }

  /**
   * `trunk group <name>` — pyeapi's `add_trunk_group` (`:329-342`, `test_api_vlans.py:148`). No read first:
   * the command is idempotent on the device and re-reading the config to find out would cost a round trip
   * to save nothing (parity with upstream, divergence 12).
   */
  async addTrunkGroup(id: number, group: string): Promise<void> {
    assertTrunkGroupName('addTrunkGroup', group)
    await this.configureVlan(id, [this.commandBuilder('trunk group', { value: group })])
  }

  /** `no trunk group <name>` — pyeapi's `remove_trunk_group` (`:344-358`, `test_api_vlans.py:155`). */
  async removeTrunkGroup(id: number, group: string): Promise<void> {
    assertTrunkGroupName('removeTrunkGroup', group)
    await this.configureVlan(id, [this.commandBuilder(`trunk group ${group}`, { mode: 'no' })])
  }

  /** `no trunk group` (every group for this VLAN) — pyeapi's `set_trunk_groups(vid, disable=True)` branch (`:311-312`; `test_api_vlans.py:142`). */
  async unsetTrunkGroups(id: number): Promise<void> {
    await this.configureVlan(id, [this.commandBuilder('trunk group', { mode: 'no' })])
  }

  /** `default trunk group` — pyeapi's `set_trunk_groups(vid, default=True)` branch (`:309-310`; `test_api_vlans.py:126`). */
  async defaultTrunkGroups(id: number): Promise<void> {
    await this.configureVlan(id, [this.commandBuilder('trunk group', { mode: 'default' })])
  }
}
