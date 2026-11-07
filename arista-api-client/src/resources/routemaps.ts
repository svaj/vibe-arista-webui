/**
 * `routemaps` — the route-map collection resource, W3b (#50). It reads the `route-map <name> <action>
 * <seqno>` clause blocks of the running-config and writes the exact `route-map` / `no route-map` /
 * `default route-map` header commands plus the per-clause `match` / `set` / `continue` / `description`
 * bodies, built on the M7 (#9) framework exactly like `staticroute.ts` (the composite-identity sibling)
 * and `vrfs.ts` (DR-026 memo, {@link commandBuilder}/{@link submodeCommands}, the config-block extractors
 * from `./config-block`, and the registry row that replaces pyeapi's `node.api('routemaps')` autoload —
 * DR-006).
 *
 * Port of `pyeapi/api/routemaps.py` (357 lines, BSD-3-Clause, Arista Networks — DR-001). Every `pyeapi`
 * ref below was re-opened in the pinned clone `/home/svaj/development/arista/pyeapi`
 * (1.0.4-rc0, `develop` @ `6816d9e`) on 2026-11-06 and says what the code **does** — nothing here cites
 * EOS image internals, and nothing claims what the DCS-7050TX-64 accepts: unit tests never reach a
 * device, so every EOS-side question reads "unverified on hardware, M12 (#14) to capture". Policy-based
 * routing itself being licensed/available on this SKU is a device question the same way.
 *
 * ## The identity is a TRIPLE — name + action + seqno (divergence 0, the typing decision)
 *
 * This is the first resource whose entity identity is three coordinates, not one: pyeapi's collection
 * key is the route-map **name** (`getall` keys `resources[name]`, `:101-109`), but an individual clause
 * — the thing `create`/`delete`/`default`/every field verb addresses — is `(name, action, seqno)`. Upstream
 * `get(name)` answers that nested shape directly (`:57-99` docstring, materialised by `_parse_entries`
 * `:110-128` + `_merge_entries` `:130-139`): `{ action: { seqno(int): {match,set,continue,description} } }`.
 * **The per-entry `name`/`action`/`seqno` fields `_parse_entries` builds (`:121`) are DISCARDED by
 * `_merge_entries`**, which reads only `e['action']`/`e['seqno']` as coordinates (`:133-134`, `seqno`
 * coerced with `int()`) and stores only `e['attr']` at `response[action][seqno]` (`:137`) — the
 * three coordinates survive purely as the two levels of the returned dict nesting, never as fields on the
 * leaf. The TS port keeps that faithful shape: a route-map **name** is the collection key (`K = string`),
 * {@link RoutemapsResource.get} returns a {@link RoutemapEntry} keyed
 * `action → seqno(number) → {@link RoutemapEntryAttrs}` — two nesting levels, exactly upstream's
 * dict-of-dicts — the leaf attributes are the four `attr` keys, and the triple is NOT flattened into the
 * leaf (no invented `name`/`action`/`seqno` fields on the attr record, where upstream has none). This is
 * the `§4` "typed records, not stringly dicts" instance for a triple, and it is §5 row 203 of
 * `docs/MIGRATION.md`, decided by **DR-111**: DR-093 (a name-keyed table carrying a number-keyed Map in
 * device document order) and DR-100 (`staticroute`'s flat records for a composite identity) are the two
 * sibling arities it joins.
 *
 * | pyeapi (verified refs) | here |
 * |---|---|
 * | `Routemaps(EntityCollection)` (`:50`) | {@link RoutemapsResource} extends `EntityCollection<RoutemapEntry \| undefined, string, RoutemapClauseAttrs>` (`base.ts`) — `K` is the name, the nested entry is `T` |
 * | `get(name)` (`:57-99`): `if not self.get_block(r'route-map\s%s\s\w+\s\d+' % name): return None` (`:96-97`) then `_parse_entries(name)` (`:99`) | {@link RoutemapsResource.get} — the whole name's entry from the shared table; existence is the table lookup, and the name is **never** interpolated into a regex (divergence 1, §5 row 204) |
 * | `getall()` (`:101-109`): `re.compile(r'^route-map\s([\w-]+)\s\w+\s\d+$', re.M).findall(self.config)` (`:103`), `resources[name] = self.get(name)` per hit — N re-scans | {@link RoutemapsResource.getAll} — one pass over the chunked document's `route-map …` section keys (DR-030, request-count pinned), keyed by name with clause-order preserved |
 * | `_parse_entries` (`:110-128`): `^route-map\s%s\s(\w+)\s(\d+)$` findall (`:112-113`, driving `findall` at `:115`), a get_block per clause (`:118-119`), the four `_parse_*` merges (`:121-125`) | private {@link readOneClause} + {@link readAttrs} — one pass, the same keyword-anchored body extraction `vlans.ts`/`staticroute.ts` use (match/set findAll, continue/description first-match) |
 * | `_merge_entries` (`:130-139`): `seqno = int(e['seqno'])` at `:134`, then `response[action][seqno] = e['attr']` at `:137` — the LAST clause for a repeated `(action, seqno)` REPLACES the whole attr dict, and the entry's own `name`/`action`/`seqno` fields are never stored | private table build: `clauses.set(Number(seqno), attrs)` keeps the first clause's POSITION but the last one's attrs — the identical Map-level rule `staticroute.ts`'s divergence-2 note spells out, pinned against the fixture's doubled `FOOBAR permit 20` (`:24`,`:30` of `test/fixtures/running_config.routemaps`) |
 * | `_parse_match_statements` (`:141-143`, `^\s+match\s(.+)$` findall) / `_parse_set_statements` (`:145-147`) / `_parse_continue_statement` (`:149-153`, `^\s+continue\s(\d+)$` search → int else None) / `_parse_description` (`:155-158`, `^\s+description\s(.+)$` search, first only) | {@link readAttrs} via `valuesAfterKeyword` (all) and `valueAfterKeyword` (first) from `./config-block`, with `continue` coerced to a `number` only when it is all-digits — the `None` answers become field ABSENCE (DR-027/DR-029 family) |
 * | `create/delete/default(name, action, seqno)` (`:161-220`): bare `'route-map %s %s %s'` (`:178`), `'no route-map …'` (`:197`), `'default route-map …'` (`:219`) | {@link RoutemapsResource.create}/{@link delete}/{@link setDefault} (row 77 rename) — same three command texts, one transaction, submode never entered, **no existence check** (upstream's own doc notes say so verbatim: "regardless if the routemap exists or not" at `:164-167`, and the delete/default "does not exist … still return True" notes at `:183-186`/`:203-208`) |
 * | `set_match_statements` (`:222-257`) / `set_set_statements` (`:259-293`): read the CURRENT clause statements in `try: current_statements = self.get(name)[action][seqno]['match'|'set']` / `except Exception: current_statements = []` (`:240-243` and `:276-279`) — emit `route-map …` + `no match X` for each REMOVED entry (`:247-250` / `:283-286`), then `route-map …` + `match X` for each ADDED entry (`:252-255` / `:288-291`); `self.configure(commands) if commands else True` (`:257` / `:293`) | {@link setMatch}/{@link setSet} — the same removed-then-added diff, opening the clause header once per emitted statement line — the **replace** verb, not an add verb (divergence 3, the delicate one) |
 * | `set_continue(name, action, seqno, value, default, disable)` (`:295-321`): header at `:310`, then `default continue` (`:311-312`) / `no continue` (`:313-314`) / `continue %s` (`:319`), guarded by `if not str(value).isdigit() or value < 1: raise ValueError('seqno must be a positive integer …')` (`:316-318`) | {@link setContinue}/{@link unsetContinue}/{@link defaultContinue} — same three texts; the positive-integer guard throws DR-005's `NotSupportedError` and its message keeps upstream's mislabel ("**seqno** must be …", a copy-paste of the `create` docstring — the guard is on the CONTINUE value, pinned verbatim) |
 * | `set_description(name, action, seqno, value, default, disable)` (`:323-344`): header at `:338`; **if `value is not None` push `'no description'` FIRST** (`:339-341`, `command_builder('description', disable=True)`), then `command_builder('description', value, default, disable)` (`:342-343`) and `configure` at `:344` — and `value=None` with no flag sends `'no description'` (its OWN test pins that at `test/unit/test_api_routemaps.py:151-158` with the pre-armed "uncomment if command_builder fails" comment) | {@link setDescription}/{@link unsetDescription}/{@link defaultDescription} — the same clear-before-set ordering when a value is written; `unset` is the named-negation verb DR-037 splits out of the `value=None`/`disable` arms |
 * | `instance(node)` (`:347-357`; `return Routemaps(node)` at `:357`) | the `RESOURCE_FACTORIES.routemaps` row plus `Node.routemaps` (DR-006/DR-052) |
 *
 * Upstream's own suite is `test/unit/test_api_routemaps.py` (clone-relative; the `pyeapi` package dir
 * holds the module, the top-level `test/` the suites) — **18** test methods (verified in the
 * pinned clone on 2026-11-06): `test_instance` (`:51-53`), `test_get` (`:55-58`),
 * `test_get_not_configured` (`:60-61`), `test_getall` (`:63-68`), `test_routemaps_functions`
 * (`:70-79`), `test_set_set_statement_clean` (`:81-85`), `test_set_set_statement_remove_extraneous`
 * (`:87-94`), `test_set_match_statement_clean` (`:96-100`), `test_set_match_statement_remove_extraneous`
 * (`:102-109`), `test_set_continue` (`:111-114`), `test_set_continue_with_invalid_integer`
 * (`:116-118`), `test_set_continue_with_invalid_string` (`:120-122`), `test_set_continue_to_default`
 * (`:124-127`), `test_negate_continue` (`:129-132`), `test_set_description_with_value` (`:134-139`, the
 * only `random_string()` site), `test_negate_description` (`:141-144`), `test_set_description_with_default`
 * (`:146-149`), `test_set_description_with_invalid_value` (`:151-158`). All 18 are ported in
 * `routemaps.test.ts`; the `random_string()` slot becomes a fixed multi-word description.
 *
 * ## Divergences this file owns (filed in `docs/MIGRATION.md` §5: row 203 is the identity/typing decision
 * above, row 204 is divergence 1, row 205 is divergence 2, row 206 is divergence 3, row 207 covers
 * divergences 4 and 5; the durable decisions are **DR-111** (the triple), **DR-112** (the inline fixture
 * and its one declared edit) and **DR-113** (the replace verb), all in `docs/DECISIONS.md`)
 *
 * 1. **a name is never interpolated into a section pattern.** Upstream's existence probe and per-clause
 *    reads build `get_block(r'route-map\s%s\s\w+\s\d+' % name)` (`:96`) and
 *    `r'^route-map\s%s\s(\w+)\s(\d+)$' % name` (`:112-113`) — the name rides a REGEX. `get('TE')` is safe
 *    (the name is followed by `\s`, and `get_block` anchors `^%s$`, so a prefix does not match), but
 *    `get('RM.X')` widens: the `.` is a regex wildcard, so a device clause named `RM1X` would be answered
 *    for the query `RM.X`. Here the collection reads the chunked document's section **keys** with one
 *    anchored pattern (`^route-map (\S+) (\w+) (\d+)$` on an indent-0 key, never a caller string joined
 *    into a RegExp), and `get(name)` is a `Map` lookup on the name it was asked for — so no metacharacter
 *    in a name can widen it. Same round-trip-posture-not-regex-injection rule as `staticroute.ts`
 *    divergence 1 / `vrfs.ts` divergence 2, and the same `assertRoutemapName` guard the writers need
 *    anyway (divergence 5) is what lets the read keep the chunker's key path.
 * 2. **`getAll()` answers the name, with the clause nesting `get(name)` returns.** Upstream `getall`
 *    `getall()` scans for names with `re.compile(r'^route-map\s([\w-]+)\s\w+\s\d+$', re.M).findall` (`:103-104`),
 *    then re-runs the whole `get` per name (`:105-107`, up to `O(names)` re-reads), and
 *    because the regex is over raw `self.config`, a column-0 `route-map Ghost permit 1` line inside a
 *    `banner` body is a route-map for pyeapi. Here the names AND the clauses come from the chunker's
 *    indent-0 section keys in one pass (DR-030, request-count pinned), banner bodies cannot vote (a
 *    `banner …` section carries its body inside the one key, so an indented `route-map Ghost permit 1` is
 *    a body line the loop never matches), and the doubled `route-map FOOBAR permit 20` of the fixture
 *    (`:24` and `:30`) collapses to ONE `permit`/`20` entry by the last-wins Map rule — matching
 *    `_merge_entries` (`:133-137`) rather than the config's literal line count. `getall`'s `if routemap:`
 *    truthiness skip (`:106-107`) has no live branch to port here: a matched clause header always produces
 *    a non-empty entry (`{ match: [], set: [] }` at minimum), so upstream's skip is unreachable for any
 *    name its own `findall` returned — this is a documented no-op rather than a divergence, and the
 *    getAll order/merge pins stand in for it. `getAll()` answers names in config-line order.
 * 3. **`setMatch`/`setSet` (upstream's `set_match_statements`/`set_set_statements`) are REPLACE verbs —
 *    that is what upstream does, and the naming has to say so.** (§5 row 206, **DR-113**.) Upstream diffs the clause's current statements against the passed list and
 *    emits `no match`/`no set` for everything in current-but-not-passed and `match`/`set` for everything
 *    in passed-but-not-current (`:247-255` for match, `:283-291` for set); the final config equals the passed list exactly.
 *    The framework's naming rule (`base.ts` header) reserves `add<X>`/`remove<X>` for membership, so the
 *    upstream method name `set_match_statements` maps to {@link setMatch} (a `set<Field>` verb) and
 *    NOT an `add` verb — pinning that the verb replaces the set, and the two pinned `_remove_extraneous`
 *    upstream tests (`:87-94`, `:102-109`) become the "an omitted statement is removed" pins here. The
 *    order of emitted lines is upstream's: **all removals first (header per removal), then all additions
 *    (header per addition)**, and upstream opens the `route-map …` clause before EVERY emitted body line
 *    (it appends the header inside each loop, `:249`/`:254` for match and `:285`/`:290` for set) rather
 *    than once per transaction — preserved verbatim, because the MockTransport joined-key pins in
 *    `routemaps.test.ts` compare the whole script. A diff that nets to zero commands sends nothing
 *    (upstream's `if commands else True`, `:257` / `:293`), so a no-op `setMatch` is ZERO writes.
 * 4. **`continue` is a number here; `description` is first-match-wins; the negated body lines do not
 *    vote.** Upstream's `continue` parser casts to `int` only when its `^\s+continue\s(\d+)$` matched
 *    (`:149-153`, the coercion at `:152`); here `continue` is `number | undefined`
 *    and only an all-digits value coerces — a body line `continue 100` yields `100`, but `continue` with
 *    a non-digit tail (unmodelled on EOS, unverified, M12) is left ABSENT, not a `NaN`, because upstream's
 *    `(\d+)$` would not have matched it either. `description` reads the FIRST `description …` line
 *    (upstream `search`, `:157`) and `match`/`set` read ALL their lines (upstream `findall`, `:143`/`:147`)
 *    — that asymmetry is deliberate and pinned. A `no description`/`no continue`/`no match …`/
 *    `no set …` body line is a negation and contributes nothing, the same keyword-anchored rule every
 *    wave-2 sibling uses (`valueAfterKeyword` skips it because `no …` is not the bare keyword).
 * 5. **input guards where upstream has none — and the continue guard's own message.** `create`/`delete`/
 *    `default`/every field verb interpolate `name`/`action`/`seqno` with no validation (`:178`, `:197`,
 *    `:219`, `:249`/`:254`, `:285`/`:290`, `:310`) and never touch `value` (`:319`, `:342-343`), and
 *    `set_continue`'s only check is the `str(value).isdigit()` +
 *    `< 1` guard that raises a `ValueError` whose TEXT says "seqno" although it is testing the CONTINUE
 *    value (`:316-318` — a copy-paste from `create`'s docstring; `test_api_routemaps.py:116-122` only
 *    checks the exception TYPE, never the message). Here {@link assertRoutemapName} /
 *    {@link assertRoutemapAction} / {@link assertRoutemapSeqno} keep every interpolated coordinate inside
 *    the grammar the READER itself reproduces (`\S+` name, `\w+` action, digits seqno — DR-053's
 *    round-trip pattern, `NotSupportedError`, no new error classes DR-005/DR-010), and the guards run
 *    BEFORE any read or write so a bad argument costs zero round trips (pinned). {@link setContinue}'s
 *    positive-integer refusal reuses upstream's wording verbatim, including the "seqno" mislabel, so a
 *    caller comparing against an upstream error string sees the same text — the mislabel is upstream's,
 *    not this port's invention, and this port does not silently fix a user-visible string. `seqno` accepts
 *    a `number` or a digit `string` (upstream's `:104` findall yields the digit string, and `int(seqno)`
 *    at `:134` decides) and refuses negatives, fractions and oversized numerics that neither the reader
 *    nor `\d+` can echo back. Whether EOS enforces a seqno step (typically 10) or a name length is a
 *    device answer (DR-032); nothing here claims one.
 *
 * ## Verbs the port does NOT ship: upstream's `add`/`remove` half does not exist for routemaps
 *
 * The issue text asks about an add/remove pair: there is none in `pyeapi/api/routemaps.py` at this
 * revision. The module's only statement-level writers are `set_match_statements`/`set_set_statements`
 * (`:222`, `:259`), and they are the diff-replace form (divergence 3). There is no `add_match_entry` /
 * `remove_match_entry` (contrast `switchports.ts`'s real upstream verb pair `add_trunk_group`/
 * `remove_trunk_group`, `switchports.py:379` and `:392`), so the framework's `add<X>/remove<X>` naming has nothing to map onto and is
 * NOT invented here. Whether EOS itself offers a bare `match <single>` under a clause is true of the CLI
 * but pyeapi never models it as a verb, and this port models pyeapi — an additive single-statement verb
 * would be a NEW capability needing a pyeapi-shaped decision and its own §5 row (row 206 records the
 * replace verb that DOES exist), owned upward, not decided in this module.
 */

import { NotSupportedError } from '../errors'
import { pythonRepr } from '../internal/wire'
import { parseBlock } from '../config/text'
import { EntityCollection } from './base'
import { valueAfterKeyword, valuesAfterKeyword } from './config-block'
import type { ConfigSections } from '../config/chunk'

/**
 * One `route-map` clause header line, read as a chunked section KEY. `(\S+)` is the name — route-map
 * names carry no spaces (upstream's own `getall` regex restricts to `[\w-]+`, `:103`), so `(\S+)` and
 * `([\w-]+)` agree on every legal name and `\S+` is what lets {@link readOneClause} stay a pure
 * key-parse with no name interpolation (divergence 1). `(\w+)` action, `(\d+)` seqno are upstream's
 * `_parse_entries` groups verbatim (`:112-113`).
 */
const ROUTE_MAP_KEY = /^route-map (\S+) (\w+) (\d+)$/u

/** A `continue` body line is a number only when it is all digits — upstream's `int(\d+)`, `:149-152`. */
const DIGITS_ONLY = /^\d+$/u

/** The action set upstream itself documents and its 18 tests exercise; the reader's own `\w+` is looser. */
export const ROUTE_MAP_ACTIONS = Object.freeze(['permit', 'deny'] as const)
export type RoutemapAction = (typeof ROUTE_MAP_ACTIONS)[number]

/**
 * True for an `action` this client will address. pyeapi takes the action as a free string and lets the
 * device reject it, but every read regex matches only `\w+` and `getall`'s probe expects
 * `route-map NAME \w+ \d+` — the two actions the module docstring and its whole test suite use are
 * `permit`/`deny`. This is a client-side vocabulary DR-032 (the device is the authority), not a claim
 * these are the only tokens the CLI accepts.
 */
export function isRoutemapAction(value: unknown): value is RoutemapAction {
  return typeof value === 'string' && (ROUTE_MAP_ACTIONS as readonly string[]).includes(value)
}

/**
 * The four attributes of one clause — exactly upstream's `attr` dict keys (`_merge_entries` stores
 * `e['attr']`, `:137`, built by the four `_parse_*` merges at `:124-127`), with the per-entry
 * `name`/`action`/`seqno` fields `_parse_entries` also sets on the *entry* (`:124`) NOT carried here
 * because `_merge_entries` discards them and keys the nesting by them instead (`:135-138`).
 *
 * `match`/`set` are ALWAYS present as arrays (upstream's `findAll` is `[]` when nothing matched — the
 * docstring's own example shows `'set': []`). `continue`/`description` are absent, not `null`, where
 * upstream answers `None` (`:152`, `:157` — DR-027/DR-029: absence is a field answer).
 */
export interface RoutemapEntryAttrs {
  /** Every `match …` body line's argument, device order; the leading `match` is stripped (`:141-143`). */
  readonly match: readonly string[]
  /** Every `set …` body line's argument, device order; the leading `set` is stripped (`:145-147`). */
  readonly set: readonly string[]
  /** The `continue <n>` value as a number. Absent when no digits-only continue line exists (`:149-153`). */
  readonly continue?: number
  /** The FIRST `description …` value. Absent when there is none (`:155-158`). */
  readonly description?: string
}

/**
 * One route-map name's clauses: `action → seqno(number) → attributes`, the faithful two-level nesting of
 * upstream's `get(name)` answer (`:57-99` docstring, `{action: {seqno: attr}}`). The seqno key is a
 * `number` because `_merge_entries` coerces it (`int(e['seqno'])`, `:137`) and then indexes with it.
 *
 * Type alias (not an interface) throughout: `Map` cannot be an `interface`, and the framework's tables are
 * `ReadonlyMap` (`base.ts`/`types.ts` row 78).
 */
export type RoutemapEntry = ReadonlyMap<string, ReadonlyMap<number, RoutemapEntryAttrs>>

/**
 * The clause coordinate the presence verbs address — `create(name, action, seqno)`
 * (`staticroute.py`'s positional identity `next_hop` rides the same way per DR-100; the number-keyed
 * Map shape is DR-093's, decided — **DR-111**.)
 *
 * `action`/`seqno` are required for every clause verb, but `EntityCollection.create`'s signature only
 * carries `name`, and {@link RoutemapsResource.create}/delete/setDefault share one attrs bag with the
 * framework contract, so the two coordinates are OPTIONAL on the type (what `create` can express) and
 * runtime-REQUIRED ({@link requireClause} refuses a bag missing either half — the framework's
 * single-argument `delete`/`setDefault` cannot name a clause otherwise).
 */
export type RoutemapClauseAttrs = {
  /** The `permit`/`deny` half of the clause identity (upstream's positional `action`). */
  readonly action?: RoutemapAction
  /** The sequence-number half (upstream's positional `seqno`; digits or a safe non-negative integer). */
  readonly seqno?: number | string

}

/** How a rejected argument is described — the `refuse` pattern from `validators.ts`/`vrfs.ts` (DR-053). */
function refuse(label: string, value: unknown, because: string): never {
  throw new NotSupportedError(`invalid ${label} ${pythonRepr(value)} — ${because}`, { cause: value })
}

/** C0 controls plus DEL, code-unit by code-unit — the same test `vlans.ts`/`vrfs.ts`/`mlag.ts` use. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/**
 * A route-map name: one `[\w-]`-style token, no whitespace. Upstream validates nothing and interpolates
 * the name into both the existence probe and the clause regex (`:96`, `:112-113`, `:117-118`), which is
 * how a name with a regex metacharacter would widen the pattern and let one clause answer for another
 * (divergence 1). Keeping the name a whitespace-free token is also what makes the single chunker-key
 * pattern (`ROUTE_MAP_KEY`) parse it back whole, and `[\w-]+` is upstream's own `getall` name grammar
 * (`:103`) so a name the writer can compose is a name the reader can reproduce. A leading `!` or a name
 * holding whitespace is impossible for an EOS route-map, and refused here before any round trip. Max
 * NAME LENGTH is deliberately unbounded: pyeapi asserts none and the image's real limit is a device
 * answer (DR-032).
 */
function assertRoutemapName(value: unknown): asserts value is string {
  if (typeof value !== 'string') refuse('route-map name', value, 'expected a string route-map name — pyeapi interpolates whatever arrives (routemaps.py:96, :112-113, :178, :197, :219)')
  if (value.trim() === '' || /\s/u.test(value)) {
    refuse('route-map name', value, 'a route-map name must have no whitespace — the reader parses the whole name as one `\\S+` token in the `route-map <name> <action> <seqno>` header (routemaps.py:103 `getall` is `[\\w-]+`), and a name with spaces would parse as a different clause')
  }
  if (value.startsWith('!') || value.startsWith('no ') || value.startsWith('route-map')) {
    refuse('route-map name', value, 'a route-map name cannot begin with a config marker/keyword — it would collide with the indent-0 section-key space the reader separates clauses by (routemaps.py:103)')
  }
  if (hasControlCharacter(value)) refuse('route-map name', value, 'a control character would break the config line this client reads back (row 74)')
}

/**
 * A clause `action`: one of the documented two (divergence 5's vocabulary note). Kept narrow to the
 * `permit`/`deny` set the module docstring uses and its `test_routemaps_functions` loop exercises — the
 * reader would echo ANY `\w+` here, but an action that is not permit/deny is a policy typo a UI should
 * see as a refusal, not a command sent to a switch (DR-032: this is a client convention, the device's
 * command-rejection stays available via `CommandError` for actions this list does not name but the CLI
 * might accept).
 */
function assertRoutemapAction(value: unknown): asserts value is RoutemapAction {
  if (!isRoutemapAction(value)) {
    refuse('route-map action', value, `expected one of ${ROUTE_MAP_ACTIONS.join(' / ')} — the presence-verb family names a clause by it (routemaps.py:178 interpolates it unvalidated); the reader matches any \\\\w+, and an action beyond this pair is a device question, M12 (#14)`)
  }
}

/**
 * A clause sequence number, accepting the digit `string` upstream's `findall` yields or a safe integer,
 * normalised to digits. Upstream checks nothing and `int(seqno)` decides (`:137`); the READER regex is
 * `(\d+)` (`:112`, `:103`), so only unsigned digits round-trip. Negatives (`-1` fails the `(\d+)$` read),
 * fractions and oversized numerics that cannot echo back as their own `\d+` are refused; `seqno` is an
 * identifier, not arithmetic. Whether EOS enforces a step of 10 or a max is unverified on hardware,
 * M12 (#14) — pyeapi enforces nothing, so this guard mirrors the reader, not a device rule.
 */
function assertRoutemapSeqno(value: unknown): asserts value is string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      refuse('route-map seqno', value, 'a numeric seqno must be a safe non-negative integer — the reader captures `(\\d+)` (routemaps.py:112), so signs/fractions/oversized numerics cannot echo back. Whether a step of 10 is enforced is a device answer (DR-032), not a claim here')
    }
    return
  }
  if (typeof value !== 'string' || !DIGITS_ONLY.test(value)) {
    refuse('route-map seqno', value, 'expected digits — readers and getall capture the seqno as `(\\d+)` (routemaps.py:103, :112). pyeapi computes `int(seqno)` (routemaps.py:137) and validates nothing, so a looser value composes a line no clause read will find')
  }
}

/** Normalize a number-or-string seqno to the exact digits to compose and to compare against the table. */
function seqnoText(value: string | number): string {
  return typeof value === 'number' ? String(value) : value
}

/** Digits → the `number` table key `_merge_entries` would have produced with `int(seqno)` (`:137`). */
function seqnoKey(value: string): number {
  return Number(value)
}

/**
 * A single match/set body-line argument: the line remainder past the keyword, stripped of leading
 * whitespace. Upstream stores/compares these as bare strings (`:141-151`), and the diff verbs key on set
 * membership (`:240`, `:246`) — so a statement with an embedded newline is refused here (`commandBuilder`
 * refuses one at the line level too, row 74), and an empty statement is refused because `no match `+`match`
 * for a zero-argument entry is a line the reader's `(.+)$` would not produce.
 */
function assertStatement(value: unknown, keyword: 'match' | 'set'): asserts value is string {
  const label = `route-map ${keyword} statement`
  if (typeof value !== 'string') refuse(label, value, `expected a string \`${keyword}\` argument — pyeapi diffs these as list elements (\`set(current).difference(statements)\`, routemaps.py:240/:277) and interpolates each whole`)
  const trimmed = value.trim()
  if (trimmed === '') refuse(label, value, `an empty ${keyword} statement composes \`${keyword} \`, which the reader's \`^\\s+${keyword}\\s(.+)$\` never matches back (routemaps.py:141/:145, :147) — omit the statement, or use the negation the diff verb itself emits`)
  if (/[\r\n]/u.test(value)) refuse(label, value, `a ${keyword} statement must be a single line — one command per line (row 74), and the reader anchors each \`${keyword}\` to its own body line`)
  if (hasControlCharacter(trimmed)) refuse(label, value, 'a control character would break the config line this client reads back (row 74)')
}

/**
 * `node.routemaps` — the route-maps configured on one switch, keyed by name with their clauses nested.
 *
 * pyeapi's `Routemaps(EntityCollection)` (`:50`) keyed by name; the clause coordinate rides each verb's
 * args (the framework's single-key `create`/`delete` cannot express a triple, so the presence verbs take
 * a {@link RoutemapClauseAttrs} bag — divergence 0).
 */
export class RoutemapsResource extends EntityCollection<RoutemapEntry, string, RoutemapClauseAttrs> {
  /**
   * Every route-map in the config, keyed by name and in config-line order — pyeapi's
   * `getall()` (`:101-109`) as a `ResourceTable` (row 78), built from the chunked document in ONE pass
   * rather than a `findall` of names followed by a full `get` per name (upstream's O(names) re-scans,
   * `:105-107`; DR-030 pinned by a request-count assertion). The doubled `FOOBAR permit 20` line collapses
   * to one clause like `_merge_entries` collapses it (`:134`/`:137`).
   */
  override async getAll(): Promise<ReadonlyMap<string, RoutemapEntry>> {
    return this.buildTable(await this.configSections())
  }

  /**
   * One route-map's clauses, or `undefined` — pyeapi's `get(name)` returning `None` for a name the probe
   * at `:96-97` could not anchor (DR-027's kept half). The whole name comes from the same one-read table
   * (upstream's `get` re-runs the section scans per name once asked, `:99` — the single `Node` chunk memo
   * already makes that unnecessary), and the table lookup is exact, so a name containing a regex
   * metacharacter matches only its own clause (divergence 1).
   */
  override async get(name: string): Promise<RoutemapEntry | undefined> {
    assertRoutemapName(name)
    return (await this.getAll()).get(name)
  }

  /**
   * The chunked pass. Iteration order is the document's (`config/chunk.ts`, device-order keys), so the
   * names come out in config order; within a name the action→seqno nesting is built clause-by-clause and
   * a repeated `(action, seqno)` REPLACES the prior `attr` at the same position — the exact Map rule
   * `staticroute.ts` documents for upstream's nested dict assignment (`_merge_entries` `:134`/`:137`).
   */
  private buildTable(sections: ConfigSections): Map<string, Map<string, Map<number, RoutemapEntryAttrs>>> {
    const byName = new Map<string, Map<string, Map<number, RoutemapEntryAttrs>>>()
    for (const [key, text] of sections) {
      const clause = readOneClause(key)
      if (clause === undefined) continue
      const { name, action, seqno } = clause
      let actions = byName.get(name)
      if (actions === undefined) {
        actions = new Map()
        byName.set(name, actions)
      }
      let clauses = actions.get(action)
      if (clauses === undefined) {
        clauses = new Map()
        actions.set(action, clauses)
      }
      // `Map.set` keeps this Map's insertion position but stores the LAST value — the faithful stand-in
      // for pyeapi's `response[action][seqno] = e['attr']` assignment (`:137`), following its
      // `seqno = int(e['seqno'])` coercion at `:134`; a later clause with the same action + seqno
      // overwrites the earlier one's whole attr dict. Keeping the Map's leaf key a NUMBER is what matches
      // upstream's int coercion (`:137`) and makes the `get`/{@link setMatch}/{@link setSet} lookups agree
      // with the section-header parse: `readOneClause`'s `(\d+)` capture guarantees `Number(...)` here is
      // round-trip-safe (the same digits the composed header re-emits). `staticroute.ts`'s identity-map
      // note records the same Map-semantics rule one level down.
      clauses.set(Number(seqno), readAttrs(text))
    }
    return byName
  }

  /**
   * Bring a clause into existence — pyeapi's `create(name, action, seqno)` (`:161-179`), whose own
   * docstring states it creates "regardless if the routemap exists or not" and returns True (idempotent,
   * `:164-167`). One bare line, no read first, submode not entered — the device opens the clause when
   * asked to configure it.
   */
  override async create(name: string, attrs?: RoutemapClauseAttrs): Promise<void> {
    const clause = requireClause(name, attrs)
    await this.configure(clauseHeader(clause))
  }

  /**
   * Remove one clause — pyeapi's `delete(name, action, seqno)` (`:180-198`), unconditional and True even
   * when the clause is absent (`:183-186`). The whole `no route-map NAME ACTION SEQNO` line, not a
   * name-only negation: an EOS route-map name exists only through its clauses, so deleting the last one is
   * how a name disappears. `name`-only would be a capability neither pyeapi nor the framework models.
   */
  override async delete(name: string, attrs?: RoutemapClauseAttrs): Promise<void> {
    const clause = requireClause(name, attrs)
    await this.configure(`no ${clauseHeader(clause)}`)
  }

  /**
   * `default route-map NAME ACTION SEQNO` — pyeapi's `default` (`:199-220`), renamed `setDefault` per
   * row 77. Upstream's docstring note (`:203-208`) is explicit that since route-maps do not exist by
   * default the default is "essentially a negation": the removal of the clause. The TEXT stays distinct
   * from {@link delete} because that is what was asked for; whether EOS treats the two identically here is
   * M12's (#14) device question, not this port's to collapse.
   */
  override async setDefault(name: string, attrs?: RoutemapClauseAttrs): Promise<void> {
    const clause = requireClause(name, attrs)
    await this.configure(`default ${clauseHeader(clause)}`)
  }

  /**
   * Replace the clause's `match` statements — pyeapi's `set_match_statements(name, action, seqno,
   * statements)` (`:222-257`). It is a **replace** verb (divergence 3): it reads the clause's current
   * match list, then emits `no match <old>` for everything not in the passed list and `match <new>` for
   * everything not already there, opening the clause header before EVERY emitted body line (`:247-255`).
   * The current list comes straight from `self.get(name)[action][seqno]['match']` (`:241`); if the clause
   * does not exist it is empty (`:240-243`'s `try`/`except Exception → []`), which is exactly what a
   * table miss yields here. A no-op diff sends nothing (upstream's
   * `self.configure(commands) if commands else True`, `:257`).
   */
  async setMatch(name: string, action: RoutemapAction, seqno: number | string, statements: readonly string[]): Promise<void> {
    await this.replaceStatements('match', name, action, seqno, statements)
  }

  /**
   * Replace the clause's `set` statements — pyeapi's `set_set_statements` (`:259-293`), same replace
   * semantics as {@link setMatch} with `set`/`no set` (upstream's *inline comments* in **both** bodies
   * say "set" — `:247`/`:252` inside `set_match_statements` read "remove set statements"/"add new set
   * statements" even though the emitted text there is `no match`/`match`: a copy-paste in the comments,
   * and the EMITTED text at `:250`/`:255` is correct for the verb its body is in. Not a divergence — the
   * composition faithfully follows upstream's emitted text; only its comments are sloppy).
   */
  async setSet(name: string, action: RoutemapAction, seqno: number | string, statements: readonly string[]): Promise<void> {
    await this.replaceStatements('set', name, action, seqno, statements)
  }

  /**
   * Shared diff-replace core for the two statement verbs. Order-preserving diff against the current
   * list, NOT a Python-`set` rebuild: pyeapi uses `set(...).difference(...)` so its emitted-line ORDER for
   * multiple changes is CPython-set-dependent (non-deterministic across runs); here the diff is
   * order-stable (current order for removals, input order for additions), which preserves the SET of
   * commands and makes the MockTransport join-key pins real. This is the one place ordering was
   * deliberately tightened without widening behaviour: the command MULTiset is identical, only its sequence
   * is now deterministic (divergence 3's second half) — §5 row 206, **DR-113**.
   */
  private async replaceStatements(
    keyword: 'match' | 'set',
    name: string,
    action: RoutemapAction,
    seqno: number | string,
    statements: readonly string[],
  ): Promise<void> {
    assertRoutemapName(name)
    assertRoutemapAction(action)
    assertRoutemapSeqno(seqno)
    if (!Array.isArray(statements)) {
      refuse(`route-map ${keyword} statements`, statements, 'expected an array of statements — pyeapi iterates it with `set(statements).difference(...)` (routemaps.py:253, :289), so a non-iterable is a programming error, not a device condition')
    }
    const wanted = [...statements]
    for (const statement of wanted) assertStatement(statement, keyword)

    const current = await this.currentStatements(keyword, name, action, seqnoText(seqno))
    const wantedSet = new Set(wanted)
    const currentSet = new Set(current)
    const header = clauseHeader({ name, action, seqno: seqnoText(seqno) })

    const commands: string[] = []
    // Removals first, in current order (upstream's first loop: `:248-250` in set_match_statements,
    // `:284-286` in set_set_statements — each appends the clause header per removed statement).
    for (const statement of current) {
      if (wantedSet.has(statement)) continue
      commands.push(header)
      commands.push(`no ${keyword} ${statement}`)
    }
    // Then additions, in the argument's order (upstream's second loop: `:253-255` and `:289-291`).
    for (const statement of wanted) {
      if (currentSet.has(statement)) continue
      commands.push(header)
      commands.push(`${keyword} ${statement}`)
    }
    if (commands.length === 0) return // upstream `self.configure(commands) if commands else True`, :257/:293
    await this.configure(commands)
  }

  /** The clause's current match/set list from the table — upstream's `get(name)[action][seqno]['match'|'set']`, `:241`/`:277`. */
  private async currentStatements(
    keyword: 'match' | 'set',
    name: string,
    action: string,
    seqno: string,
  ): Promise<readonly string[]> {
    const entry = await this.get(name)
    const clauses = entry?.get(action)
    const attrs = clauses?.get(seqnoKey(seqno))
    if (attrs === undefined) return [] // upstream's `except Exception: current_statements = []`, :242-243 / :278-279
    return keyword === 'match' ? attrs.match : attrs.set
  }

  /**
   * `continue <n>` under the clause — pyeapi's `set_continue(..., value=…)` (`:295-321`). The value must
   * be a positive integer: upstream guards `if not str(value).isdigit() or value < 1: raise ValueError(
   * 'seqno must be a positive integer unless default or disable is specified')` (`:316-318`), and that
   * message says **seqno** although it tests the continue value. The refusal keeps that text verbatim
   * (divergence 5) and `setContinue` refuses negatives/zero, `NaN`, `Infinity`, fractions and non-digit
   * strings.
   */
  async setContinue(name: string, action: RoutemapAction, seqno: number | string, value: number | string): Promise<void> {
    assertRoutemapName(name)
    assertRoutemapAction(action)
    assertRoutemapSeqno(seqno)
    assertContinueValue(value)
    await this.configure([clauseHeader({ name, action, seqno: seqnoText(seqno) }), `continue ${seqnoText(value)}`])
  }

  /** Named negation of the continue value — pyeapi's `set_continue(..., disable=True)` → `no continue` (`:314-315`). */
  async unsetContinue(name: string, action: RoutemapAction, seqno: number | string): Promise<void> {
    await this.configure([clauseHeader(requireClauseShape(name, action, seqno)), 'no continue'])
  }

  /** `default continue` — pyeapi's `set_continue(..., default=True)` (`:312-313`), renamed per DR-037's verb split. */
  async defaultContinue(name: string, action: RoutemapAction, seqno: number | string): Promise<void> {
    await this.configure([clauseHeader(requireClauseShape(name, action, seqno)), 'default continue'])
  }

  /**
   * Write the clause `description` — pyeapi's `set_description(..., value=…)` (`:323-344`). The quirk is
   * real and upstream-pinned: when a value is provided, it first pushes a `no description` line to clear
   * any existing one (`:339-341`), THEN the new `description <value>` (`:342-343`). Both lines ride one
   * transaction, header first (`:338`). `test_api_routemaps.py:134-139` pins exactly `['route-map TEST
   * permit 10', 'no description', 'description <value>']`.
   */
  async setDescription(name: string, action: RoutemapAction, seqno: number | string, value: string): Promise<void> {
    assertRoutemapName(name)
    assertRoutemapAction(action)
    assertRoutemapSeqno(seqno)
    assertRoutemapDescription(value)
    const header = clauseHeader({ name, action, seqno: seqnoText(seqno) })
    // Clear first, then set — the ordering upstream's own value test pins: `:339` (`value is not None`)
    // gates the `no description` append at `:341`, and the value line follows at `:342-343`.
    await this.configure([header, 'no description', `description ${value}`])
  }

  /**
   * Negate the clause `description` — pyeapi reaches this two ways: `set_description(..., disable=True)`
   * (`:342-343` via `command_builder`'s `disable` arm) sends `no description`, and so does the
   * `value=None`-with-no-flag fall-through that `test/unit/test_api_routemaps.py:151-158` pins as `['route-map TEST
   * permit 10', 'no description']` (upstream's own test comments at `:152-155` show the ValueError arm is
   * disabled because its `command_builder` would fail on `None`). DR-037 splits that fall-through into THIS
   * named verb, so a caller never reaches the deprecated `no <bare>` arm accidentally. Same header-first
   * one line.
   */
  async unsetDescription(name: string, action: RoutemapAction, seqno: number | string): Promise<void> {
    await this.configure([clauseHeader(requireClauseShape(name, action, seqno)), 'no description'])
  }

  /** `default description` — pyeapi's `set_description(..., default=True)` (`:341` via `command_builder default`). */
  async defaultDescription(name: string, action: RoutemapAction, seqno: number | string): Promise<void> {
    await this.configure([clauseHeader(requireClauseShape(name, action, seqno)), 'default description'])
  }
}

/** One parsed clause header — the identity coordinates, from a section key. */
interface ClauseRef {
  readonly name: string
  readonly action: string
  readonly seqno: string
}

/** Parse a single chunked section key into clause coordinates, or `undefined` when it is not a clause. */
function readOneClause(key: string): ClauseRef | undefined {
  const match = ROUTE_MAP_KEY.exec(key)
  if (match === null) return undefined
  const [, name, action, seqno] = match as unknown as readonly (string | undefined)[]
  const nameValue = name as string
  const actionValue = action as string
  const seqnoValue = seqno as string
  return { name: nameValue, action: actionValue, seqno: seqnoValue }
}

/** The four `attr`s of one clause from its section text (divergence 4's asymmetric match/set vs continue/description reads). */
function readAttrs(sectionText: string): RoutemapEntryAttrs {
  const block = parseBlock(sectionText)
  const continueValue = valueAfterKeyword(block.body, 'continue')
  const descriptionValue = valueAfterKeyword(block.body, 'description')
  return {
    match: valuesAfterKeyword(block.body, 'match'),
    set: valuesAfterKeyword(block.body, 'set'),
    ...(continueValue !== undefined && DIGITS_ONLY.test(continueValue) ? { continue: seqnoKey(continueValue) } : {}),
    ...(descriptionValue === undefined ? {} : { description: descriptionValue }),
  }
}

/** The clause header line every clause verb composes: `route-map NAME ACTION SEQNO` (upstream `:178`). */
function clauseHeader(clause: { name: string; action: string; seqno: string }): string {
  return `route-map ${clause.name} ${clause.action} ${clause.seqno}`
}

/**
 * Validate the framework `create`/`delete`/`setDefault` bag: the name plus BOTH required clause
 * coordinates. The framework's single-key signature cannot express a triple (divergence 0), so
 * action/seqno ride the attrs bag and their ABSENCE is refused here rather than composing a truncated
 * `route-map NAME` line that would target the wrong section (the reader keys `route-map NAME \\w+ \\d+`,
 * `:103` — a two-token line is not a clause any verb can address). Guards run first, so a refusal costs
 * zero round trips.
 */
function requireClause(name: string, attrs?: RoutemapClauseAttrs): { name: string; action: string; seqno: string } {
  assertRoutemapName(name)
  const action = attrs?.action
  const seqno = attrs?.seqno
  if (action === undefined || seqno === undefined) {
    refuse('route-map clause', attrs, 'a route-map clause needs BOTH `action` and `seqno` in the attrs bag — the presence verbs address a clause by the (name, action, seqno) triple (routemaps.py:161/:180/:199 take all three positionally); the framework\'s single-key `create`/`delete`/`setDefault` moves the extra coordinates into the bag and this client still demands them (DR-093, staticroute precedent of the same kind)')
  }
  assertRoutemapAction(action)
  assertRoutemapSeqno(seqno)
  return { name, action, seqno: seqnoText(seqno) }
}

/** The (name, action, seqno) the standalone verbs take positionally — validate each half, return the header ref. */
function requireClauseShape(name: string, action: RoutemapAction, seqno: number | string): { name: string; action: string; seqno: string } {
  assertRoutemapName(name)
  assertRoutemapAction(action)
  assertRoutemapSeqno(seqno)
  return { name, action, seqno: seqnoText(seqno) }
}

/**
 * The `continue` value: a positive integer. Upstream's guard is `not str(value).isdigit() or value < 1`
 * (`:316`) — a digit string of length ≥1 and value ≥1, so `0` is refused. The message mislabels it
 * "seqno" (divergence 5); kept verbatim so an upstream error string still matches. Negative/zero/fraction
 * /oversized/non-digit are all refusals; a `number` must be an exact positive integer (a float like
 * `10.5` would satisfy `str(10.5).isdigit()`? No — pyeapi's `str(10.5)` is `'10.5'`, isdigit false, so
 * upstream RAISES for a float too. So a non-integer float is out on both sides.).
 */
function assertContinueValue(value: unknown): asserts value is number | string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new NotSupportedError(
        `seqno must be a positive integer unless default or disable is specified — received ${pythonRepr(value)} (this is pyeapi's guard message, mislabelled "seqno" while testing the continue value, routemaps.py:316-318; kept verbatim, zero/negative/fraction non-integer values are refused by \`str(value).isdigit() or value < 1\` at :316)`,
        { cause: value },
      )
    }
    return
  }
  if (typeof value !== 'string' || !DIGITS_ONLY.test(value) || Number(value) < 1) {
    throw new NotSupportedError(
      `seqno must be a positive integer unless default or disable is specified — received ${pythonRepr(value)} (pyeapi's guard message, mislabelled "seqno", kept verbatim; routemaps.py:316-318 refuses a non-digit or a value < 1)`,
      { cause: value },
    )
  }
}

/**
 * A route-map description the reader can hand back whole: non-empty after trim, no line boundary, no
 * control characters, and no leading/trailing whitespace (the value after the keyword is lstripped and
 * the line rstripped before the reader sees it, config/text.ts `describeLine`) or a balanced quote it
 * could not re-emit. Upstream validates nothing and interpolates (`:343`), so this is the round-trip
 * contract every wave-2 sibling uses (`assertVrfDescription`, DR-053) — clearing goes through
 * {@link unsetDescription}/{@link defaultDescription}, never an empty value (DR-037).
 */
function assertRoutemapDescription(value: unknown): asserts value is string {
  if (typeof value !== 'string') refuse('route-map description', value, 'expected a string description — pyeapi interpolates whatever arrives into `description %s` (routemaps.py:343)')
  if (value.trim() === '') refuse('route-map description', value, 'an empty description is refused — clear it with unsetDescription()/defaultDescription() rather than an empty value (DR-037). pyeapi reaches its own empty-value fall-through differently (test/unit/test_api_routemaps.py:151-158)')
  if (value !== value.trim()) refuse('route-map description', value, 'leading or trailing whitespace cannot read back: the value is the rstripped, keyword-cut line remainder (valueAfterKeyword; config/text.ts describeLine rstrips)')
  if (/[\r\n]/u.test(value)) refuse('route-map description', value, 'a description must be one line (row 74, one CommandSpec per line)')
  if (hasControlCharacter(value)) refuse('route-map description', value, 'a control character would break the config line this client reads back (row 74)')
}
