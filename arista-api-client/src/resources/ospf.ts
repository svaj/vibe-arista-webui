/**
 * `ospf` — the OSPF process entity, W3a (#48). One `router ospf …` section read from the running-config
 * plus the process-level writes (create/delete, router-id, networks, redistributions, shutdown), built
 * on the M7 (#9) framework like `mlag.ts` / `vrfs.ts`: `Entity` from `base.ts`, `commandBuilder` /
 * `submodeCommands` from `command-builder.ts`, M6's chunked document (`configSections`), validators
 * local to this file (DR-053's pattern), and no new error classes (DR-005/DR-010).
 *
 * Port of `pyeapi/api/ospf.py` (362 lines, BSD-3-Clause, Arista Networks — DR-001). Every `pyeapi` ref
 * below was re-opened in the pinned clone `/home/svaj/development/arista/pyeapi`
 * (1.0.4-rc0, `develop` @ `6816d9e`) on 2026-11-06 and says what the code **does** — nothing here cites
 * EOS image internals, and nothing claims what the DCS-7050TX-64 accepts: unit tests never reach a
 * device, so every EOS-side question reads "unverified on hardware, M12 (#14) to capture". OSPF
 * feature-licensing on this SKU is device territory (DECISIONS.md open items).
 *
 * | pyeapi (verified refs) | here |
 * |---|---|
 * | `Ospf(Entity)` (`:43`), `instance(api)` (`:359-362`) | {@link OspfResource} extends `Entity<OspfState \| undefined>`; the `RESOURCE_FACTORIES.ospf` row plus `Node.ospf` replaces the factory (DR-006/DR-052) |
 * | `get(vrf=None)` (`:51-88`): `get_block('^router ospf .*')` (`:71-75`, `+ ' vrf %s'` when a vrf is passed at `:73-74`), six `_parse_*` merges (`:78-86`), `None` for a missing block (`:76-77`) | {@link OspfResource.get} — first `router ospf …` chunk key in device order (the same first-match `section()` semantics, `config/section.ts`), `undefined` when the switch runs no OSPF process (divergence 1) |
 * | `_parse_ospf_process_id` (`:90-99`): `re.search(r'^router ospf (\d+)', config)` then `int(match.group(1))` — attribute-crash on `None` when the header has no digits | {@link readProcess}: digits required in the header (divergence 2); process id typed `number`, as upstream's `int()` makes it |
 * | `_parse_vrf` (`:101-112`): `^router ospf \d+ vrf (\w+)` else `vrf='default'` | {@link OspfState.vrf} — always present, `'default'` spelled as upstream spells it; `\w+` truncation of a non-word vrf name is upstream's own reader grammar (divergence 9) |
 * | `_parse_router_id` (`:114-124`): `router-id ([^\s]+)` searched anywhere in the block text | {@link valueAfterKeyword} on the body (divergence 3), `undefined` where upstream answers `None` (DR-029 family) |
 * | `_parse_networks` (`:126-144`): `re.findall(r'network (.+)/(\d+) area (\d+\.\d+\.\d+\.\d+)', config)` | {@link readNetworks} — same capture shape, scoped to body lines; **only dotted-quad areas parse**, so the `area 0` form this module's own `addNetwork` default writes never reads back (divergence 4) |
 * | `_parse_redistribution` (`:146-171`): `findall(r'redistribute .*')`, `split()`, len 2 → `{protocol}`, len 4 → `{protocol, route_map}` (token 3 taken as the route-map whatever it is), any other token count dropped | {@link readRedistributions} — split-token rule kept verbatim, but anchored to body lines so `no redistribute bgp` and description phrases stop voting (divergence 3) |
 * | `_parse_shutdown` (`:173-183`): `shutdown = not ('no shutdown' in config)` — a substring test; a section with NO shutdown line at all reads `True` | {@link OspfState.shutdown} — same derived default, kept line-scoped: a body line exactly `no shutdown` answers `false`, anything else present answers `true` (divergence 3, the mlag divergence-3 family) |
 * | `set_shutdown` (`:185-195`) / `set_no_shutdown` (`:197-208`): literal `'shutdown'` / `'no shutdown'` through `configure_ospf` | {@link OspfResource.shutdown} / {@link OspfResource.noShutdown} — the interfaces/mlag verb naming (`interfaces.ts`'s set_shutdown family), because here the two intents are already two upstream methods, not flag arms |
 * | `delete` (`:210-222`): `get()` first; `True` with no commands when absent; else `no router ospf <pid>` | {@link OspfResource.delete} — void, still zero commands when nothing exists (pinned), same opener text |
 * | `create(ospf_process_id, vrf=None)` (`:224-243`): `int()` + `0 < value < 65536` → `ValueError('ospf as must be between 1 and 65535')` (a bgp-copy paste — OSPF has no "as"), then `'router ospf {raw arg}'` (+ `' vrf %s'`) | {@link OspfResource.create} — same bound, `NotSupportedError` instead of `ValueError` (DR-005/DR-010), corrected message text (divergence 5), digits-normalized opener (divergence 6) |
 * | `configure_ospf(cmd)` (`:244-255`): full `get()` first, then `['router ospf <pid>'] + make_iterable(cmd)` through `super().configure` (= `BaseEntity.configure`, `abstract.py:103`, since `Entity` defines no `configure` — the mlag header's MRO note applies verbatim) | {@link OspfResource.configureOspf} — one read, the pid of the **first**ospf section regardless of which vrf the caller has in mind (divergence 7), {@link submodeCommands} wrapping, and a {@link NotFoundError} where upstream crashes on `None['ospf_process_id']` (`TypeError: 'NoneType' object is not subscriptable` fed by `get` answering `None`, `:252-253`) |
 * | `set_router_id(value=None, default=False, disable=False)` (`:257-269`) — a no-argument call falls through `command_builder`'s falsy chain to the deprecated `no router-id` (`abstract.py:160-161`, pinned by upstream `test_set_router_id`'s bare call) | {@link setRouterId} / {@link unsetRouterId} / {@link defaultRouterId} — DR-037's named trios, the texts unchanged |
 * | `add_network` (`:271-290`) / `remove_network` (`:292-312`): `ValueError('network and mask values may not be empty')` for `''` args; `network`/`remove network {}/{}` `area {raw area}` with param default **`area=0`** — the emitted text is `area 0`, not a dotted quad | {@link addNetwork} / {@link removeNetwork} — same texts (the `area 0` spelling kept verbatim, pinned by upstream's test), guards widened to each reader's grammar (divergences 4/8) |
 * | `add_redistribution` (`:314-336`) / `remove_redistribution` (`:338-357`): allow-list `['bgp','rip','static','connected']` (`:323`, `:347`), `ValueError('redistributed protocol must be' + 'bgp, connected, rip or static')` (mid-word concatenation at `:325`/`:349` — reads "must bebgp"); `redistribute P [route-map R]` / `no redistribute P` | {@link addRedistribution} / {@link removeRedistribution} — same allow-list (widening to 4.28's larger set is a device answer, left alone: DR-032), same texts; a route-map-qualified line negates with the bare `no redistribute P` exactly as upstream sends it (divergence 10) |
 *
 * Upstream's own suite is `pyeapi/test/unit/test_api_ospf.py` — **15** test methods (verified in the
 * pinned clone on 2026-11-06): `test_get_no_vrf` (`:20-26`), `test_get_with_vrf` (`:27-33`),
 * `test_create` (`:34-39`), `test_create_with_vrf` (`:40-46`), `test_create_invalid_id` (`:47-51`),
 * `test_delete` (`:52-56`), `test_add_network` (`:57-67`), `test_remove_network` (`:68-78`),
 * `test_set_router_id` (`:79-96`), `test_set_shutdown` (`:97-105`),
 * `test_add_redistribution_no_route_map` (`:107-115`), `test_add_redistribution_with_route_map`
 * (`:116-124`), `test_delete_redistribution_no_route_map` (`:126-141`), and the negative half
 * `TestApiNegOspf`: `test_no_get` (`:143-145`) + `test_no_delete` (`:147-149`) against
 * `test/fixtures/running_config.bgp`. All fifteen are ported in `ospf.test.ts` with the pinned
 * command texts verbatim. `pyeapi/test/system/test_api_ospf.py` is device-territory and not this
 * lane's surface (docs/TESTING.md §5's honest-skip rule); it is declared skipped, not faked.
 *
 * The fixture half: upstream reads `test/fixtures/running_config.ospf` verbatim for the positive
 * class and `running_config.bgp` for the negative one. This suite does NOT copy those files — the
 * test configs are **inline and hand-reduced from them** (four parallel lanes editing one fixture
 * manifest is exactly what the W2 lanes avoided; `mlag.test.ts` set the precedent and cited the
 * source block instead). Provenance is stated per config below.
 *
 * ## Divergences this file owns (rows 191-196 are this lane's band; under-filled rows are declared skips)
 *
 * 1. **"no OSPF process" is `undefined`, not a crash and not an empty record.** Upstream's `get`
 *    answers `None` for a missing block (`:76-77`, pinned by its own `test_no_get` at `:143-145`) —
 *    so {@link OspfResource.get} is typed `OspfState | undefined`: absence is reported, not
 *    invented (`delete` then resolves with **zero** commands where upstream `return True`s;
 *    `test_no_delete` `:147-149`). `Entity<T>`'s docstring (base.ts) prefers "a global entity always
 *    has an answer" — ospf/bgp are the wave-3 exceptions because upstream itself answers `None`, and
 *    fabricating an empty process would claim a router the switch does not run.
 * 2. **an OSPF header without a process id is reported, where upstream attribute-crashes.**
 *    `get_block('^router ospf .*')` matches `router ospf FOO` but `_parse_ospf_process_id`'s
 *    `re.search(r'^router ospf (\d+)')` (`:96`) then answers `None`, and `None.group(1)` raises
 *    `AttributeError`. Here a matching section whose header has no digits is a
 *    {@link ConfigParseError} naming the section (the vrfs divergence-2 family); a scan never
 *    silently skips past it, because the next ospf section would then be reported under a stale
 *    pattern.
 * 3. **negation/phrases stop voting — line-anchored reads (mlag divergence 2/3/4).** Upstream's
 *    `router-id`/`network`/`redistribute`/`no shutdown` probes are substring matches over block text:
 *    `no redistribute bgp` inside a block reports a bgp redistribution (`findall(r'redistribute .*')`
 *    at `:157` starts matching *inside* the negation), and a `description has router-id 9.9.9.9 here`
 *    line reports `router_id = 9.9.9.9`. Here every reader anchors at a BODY LINE that starts with
 *    the keyword, so negations say nothing and unmodelled phrases cannot vote. The two readings
 *    DISAGREE on those junk shapes; both are pinned, and an EOS config actually carrying them is
 *    unverified on hardware, M12 (#14).
 * 4. **the write/read area asymmetry is kept, not repaired.** `add_network`'s default `area=0`
 *    (`:271`) composes `network X/24 area 0`, but `_parse_networks`' regex (`:141`) only captures
 *    `area (\d+\.\d+\.\d+\.\d+)` — dotted-quad. So THIS module's own default write is invisible to
 *    its own default read, upstream-faithfully, and the pin below demonstrates it. Whether EOS 4.28
 *    renders `area 0` as `area 0.0.0.0` in a real running-config is exactly the kind of question
 *    M12 (#14) captures; no claim either way.
 * 5. **refusals name themselves.** Upstream's `create` message is `ospf as must be between 1 and
 *    65535` (`:239`) — "as" is bgp's noun pasted in — and the allow-list messages concatenate without
 *    a space (`must bebgp`, `:325`/`:349`). The texts here are corrected; the BOUND (1..65535) is
 *    kept verbatim, even though EOS process ids plainly exceed it (4-byte territory) — pyeapi checked
 *    that bound and the image's real range is a device answer (DR-032, open item for M12).
 * 6. **numbers/strings normalize before they reach the wire.** `create`/`add_network`/`remove_network`
 *    interpolate the RAW argument (`:240`, `:286`, `:309`), so upstream accepts `' 65000 '` (a padded
 *    string passes `int()` and then ships `'router ospf  65000 '` with its padding). Here the guard
 *    requires digits and composes the normalized text — a deliberate widening of the refusal, pinned
 *    with zero round trips (DR-053 pattern).
 * 7. **every submode write names the FIRST ospf section's pid — including after `get(vrf)` read a
 *    different one.** Upstream's `configure_ospf` calls `self.get()` with no vrf (`:251`), so on a
 *    switch with `router ospf 65000` and `router ospf 10 vrf test`, a router-id write aimed at the
 *    test process still opens `router ospf 65000`. Kept faithfully (pinned), because "which process
 *    did the operator mean" is not this client's to guess; a vrf-parameterized `configure_ospf` would
 *    be a new API surface pyeapi does not have. Multi-process nodes are a wave-3 review flag (row 193).
 * 8. **input guards where upstream has none.** vrf names (`:243`, `:74`), network/netmask
 *    (beyond `''`), area, and route-map names all interpolate raw into a `CommandSpec`. Each guard
 *    here is the module's own round-trip grammar: vrf is the `\w+` of `_parse_vrf` (`:109`); netmask
 *    is the `\d+` the networks reader captures (`:141`); area is digits or a dotted quad (the one
 *    write shape and the one read shape, divergence 4); network and route-map names are non-empty
 *    single tokens with no control characters (row 74's line-boundary rule). None of these assert an
 *    EOS-side legality — they assert only that what is written can be read back by this module.
 * 9. **a non-word vrf in the config TRUNCATES rather than being reported.** `_parse_vrf`'s `(\w+)`
 *    (`:109`) keeps only the word run, so a hypothetical `router ospf 10 vrf mid-dash` reads
 *    `vrf='mid'`. Faithfully kept (the write side refuses it, so this client can never author one) —
 *    the sibling of vrfs divergence 2, but pinned instead of converted, because unlike VRF names the
 *    ospf reader never keys off this token for lookups; only the display value truncates.
 * 10. **`remove_redistribution` can only negate the bare form.** Upstream takes no route-map argument
 *     (`:338-357`) and always sends `no redistribute P`, even when the config holds `redistribute P
 *     route-map R` twice over (the fixture's doubled bgp lines). Kept; the pin documents it. Whether
 *     `no redistribute bgp` clears BOTH of the fixture's bgp route-map lines on a real 4.28 box is a
 *     capture question, M12 (#14).
 */

import { ConfigParseError, NotFoundError, NotSupportedError } from '../errors'
import { pythonRepr } from '../internal/wire'
import { toArray } from '../internal/collections'
import { Entity } from './base'
import { submodeCommands } from './command-builder'
import { valueAfterKeyword } from './config-block'
import { parseBlock } from '../config/text'
import type { ConfigSections } from '../config/chunk'
import type { CommandInput } from './types'

/** Upstream's block pattern: `get_block('^router ospf .*')` (`ospf.py:71`) — with `_parse_vrf`'s and `_parse_ospf_process_id`'s digit grammar on top (`:96`, `:109`). */
const OSPF_BLOCK = /^router ospf .+$/u

/** The pid capture this module reads; upstream's `^router ospf (\d+)` (`:96`). */
const OSPF_HEADER = /^router ospf (\d+)(?: vrf (\w+))?/u

/** Upstream's `network (.+)/(\d+) area (\d+\.\d+\.\d+\.\d+)` (`:141`), scoped to a body line (divergence 3). */
const OSPF_NETWORK_LINE = /^network (.+)\/(\d+) area (\d+\.\d+\.\d+\.\d+)/u

/** The redistribution line upstream splits into tokens (`:157`, `:159-168`); `no …` lines do not match (divergence 3, kept upstream-side). */
const REDISTRIBUTE_LINE = /^redistribute\b/u

/** `_parse_shutdown`'s substring (`:182`) made whole-line honest, exactly as `mlag.ts` did at its `:175` twin. */
const NO_SHUTDOWN = 'no shutdown'

/**
 * One advertised network. Upstream's rows are `dict(network, netmask, area)` from the regex groups
 * (`:139-140`) — all three are STRINGS there (`match.group`), `ospf.py`'s docstring notwithstanding.
 */
export interface OspfNetwork {
  /** `network <this>/…` — the greedy `(.+)` upstream keeps (`:141`). */
  readonly network: string
  /** The `/…` mask length as written — upstream's `(\d+)`. */
  readonly netmask: string
  /** The `area …` token. ONLY dotted-quad areas are read at all (divergence 4). */
  readonly area: string
}

/** One redistribution. Upstream's `dict(protocol)` / `dict(protocol, route_map)` pair (`:162-169`). */
export interface OspfRedistribution {
  /** `redistribute <this>` — token 1 of upstream's split (`:161`). */
  readonly protocol: string
  /** Token 3 whatever it is (`:167` — upstream takes the 4th token on any four-token line); absent on two-token lines. */
  readonly routeMap?: string
}

/**
 * What one `router ospf …` section answers — upstream's merged response dict (`:78-86`) with
 * snake_case → camelCase (MIGRATION.md §5's naming rows; `ospf_process_id` keeps its noun) and the
 * `None`/crash shapes replaced per divergences 1-3.
 */
export interface OspfState {
  /** The process id — upstream `int()`s it (`:98`), so it is a number here. */
  readonly ospfProcessId: number
  /** `'default'` when the header carries no ` vrf …` (upstream's own answer, `:109-112`). */
  readonly vrf: string
  /** The `router-id …` token. Absent where upstream answers `None` (`:123`). */
  readonly routerId?: string
  /** Dotted-quad-area networks only (divergence 4) — `[]` when none parse, upstream's `[]` (`:134`). */
  readonly networks: readonly OspfNetwork[]
  /** Two- or four-token `redistribute` lines, in device order — other token counts are dropped upstream (`:162-168`) and here. */
  readonly redistributions: readonly OspfRedistribution[]
  /** False exactly when the section has a body line `no shutdown`; TRUE when the section has no shutdown line at all — upstream's substring derivation kept (`:181-183`). */
  readonly shutdown: boolean
}

/** How a rejected argument is described — the `refuse` pattern from `validators.ts` / `mlag.ts` (DR-053). */
function refuse(label: string, value: unknown, because: string): never {
  throw new NotSupportedError(`invalid ${label} ${pythonRepr(value)} — ${because}`, { cause: value })
}

/** C0 controls plus DEL, code-unit by code-unit — the same test `vlans.ts`/`mlag.ts` use. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/**
 * The OSPF process id: a safe non-negative integer, or those same digits as a string — the same
 * number-or-string acceptance `mlag.ts`'s id guard established, because upstream's `int()` accepts
 * both spellings (`test_api_ospf.py:35` loops `['65000', 65000]`) and the reader re-produces
 * `(\d+)` digits (`:96`). The bound upstream enforces is `0 < value < 65536` (`:235-236`) — kept
 * verbatim even though it plainly predates 4-byte AS numbers (divergence 5).
 */
function assertProcessId(value: unknown): asserts value is string | number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) refuse('ospf process id', value, 'a numeric process id must be a safe integer — the reader takes \\d+ digits (ospf.py:96) and floats/negatives/NaN cannot echo back')
  } else if (typeof value !== 'string' || !/^\d+$/u.test(value)) {
    refuse('ospf process id', value, 'expected digits — pyeapi int()-coerces and then INTERPOLATES THE RAW ARGUMENT, so even padded strings ride (ospf.py:237-240); this client composes normalized digits instead (divergence 6)')
  }
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!(0 < numeric && numeric < 65536)) {
    refuse('ospf process id', value, 'must be between 1 and 65535 — pyeapi enforces this very bound (ospf.py:235-236, with a bgp-pasted message saying "as"); whether 4.28 accepts larger process ids is a device question for M12 #14 (DR-032)')
  }
}

/**
 * A vrf name this module can write and still read back: upstream's reader is `(\w+)` (`:109`), so the
 * writer stays inside it (round-trip grammar, DR-053). Upstream checks nothing itself (`:243`'s `'
 * vrf %s' % vrf` interpolation).
 */
function assertVrfName(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^\w+$/u.test(value)) {
    refuse('ospf vrf name', value, 'expected the grammar this module reads back: one or more of numbers, letters and underscore (ospf.py:109 captures (\\w+)); a name outside it TRUNCATES on read (divergence 9) — pyeapi checks nothing at ospf.py:243')
  }
}

/**
 * Network / netmask / route-map-ish token guards (divergences 6/8). Upstream checks only `''`
 * (`:287-288`, `:308-309`) and lets anything else through into the command text. Here: non-empty,
 * one token (the readers capture `(.+)` up to a `/`, `(\d+)`, and `([^\s]+)` shapes), no control
 * characters (row 74). Which of these the CLI would actually reject is the device's to answer (DR-032).
 */
function assertToken(label: string, value: unknown): asserts value is string {
  if (typeof value !== 'string') refuse(label, value, 'expected a string token — pyeapi interpolates whatever arrives (ospf.py:286, :309)')
  if (value === '') refuse(label, value, 'network and mask values may not be empty (this is verbatim the fact pyeapi checks at ospf.py:287-288; the message is DR-037-shaped now — clear a network with removeNetwork(), never an empty argument)')
  if (/\s/u.test(value)) refuse(label, value, 'a token with whitespace splits the command line this module composes and breaks the reader that re-captures it')
  if (hasControlCharacter(value)) refuse(label, value, 'a control character would break the config line this client reads back (row 74)')
}

/** Netmask: the `(\d+)` of `:141` — digits in either spelling (a number normalizes). */
function assertMaskLen(label: string, value: unknown): asserts value is string | number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) refuse(label, value, 'a numeric mask must be a safe non-negative integer — the reads take \\d+ (ospf.py:141, bgp semantics shared) and fractions/negatives cannot echo back')
    return
  }
  if (value === '') {
    refuse(label, value, 'network and mask values may not be empty — pyeapi checks exactly this pair of empty-string arms (ospf.py:287-288, :308-309, as a ValueError); clear a network with removeNetwork(), never an empty argument (DR-037)')
  }
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) {
    refuse(label, value, 'expected digits — the reader captures (\\d+) in the `network X/<len>` line (ospf.py:141); pyeapi only checks the empty string (ospf.py:288) and interpolates anything else')
  }
}

/**
 * Area: EITHER bare digits (this module's write default, `area 0` from `area=0` at `:271`) OR a
 * dotted quad (the only shape the reader sees, `:141`). Pinning the guard to the union of both is
 * not a repair of divergence 4 — a `area 7` write is STILL invisible to the reader — it just keeps a
 * line-unsafe token off the wire.
 */
function assertArea(value: unknown): asserts value is string | number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) refuse('ospf area', value, 'a numeric area must be a safe non-negative integer — bare digits (the `area 0` default writes, ospf.py:276) or a dotted quad (ospf.py:141) are the only shapes this module produces or reads')
    return
  }
  if (typeof value !== 'string' || !(/^(\d+|\d+\.\d+\.\d+\.\d+)$/u.test(value))) {
    refuse('ospf area', value, 'expected digits or a dotted quad — the reader anchors `area (\\d+\\.\\d+\\.\\d+\\.\\d+)` (ospf.py:141) and this module writes bare digits, so anything else composes a line NEITHER side can name (divergence 4 stays open on purpose)')
  }
}

/** Digits or number → the exact text to compose (divergence 6's normalization, as in `mlag.ts`). */
function digitText(value: string | number): string {
  return typeof value === 'number' ? String(value) : value
}

/** The first `router ospf …` chunk key in device order — the section-level twin of `section()`'s first-match rule. `vrf` narrows the exact suffix, never a regex (the getBlock line-39 hazard would otherwise bite). */
function findOspfSection(sections: ConfigSections, vrf?: string): string | undefined {
  for (const key of sections.keys()) {
    if (!OSPF_BLOCK.test(key)) continue
    if (vrf === undefined) return key
    if (key.endsWith(` vrf ${vrf}`)) return key
  }
  return undefined
}

/** One ospf section's text → the upstream merge (`:90-183`), with the crash families replaced. */
function readProcess(key: string, sections: ConfigSections): OspfState {
  const text = sections.get(key)
  if (text === undefined) throw new NotFoundError(`ospf: section ${pythonRepr(key)} vanished from the chunked config`)
  const block = parseBlock(text)
  const header = OSPF_HEADER.exec(block.header)
  if (header?.[1] === undefined) {
    // Upstream: `re.search('^router ospf (\\d+)')` answers None here and `None.group(1)` is an
    // AttributeError crash (`ospf.py:96-98`) — reported instead (divergence 2).
    throw new ConfigParseError(
      `ospf: the section header ${pythonRepr(block.header)} has no digits to name a process — pyeapi renders AttributeError on this shape (ospf.py:96-98), this client reports the section instead`,
      { sectionKey: block.header },
    )
  }
  const routerId = valueAfterKeyword(block.body, 'router-id')
  return {
    ospfProcessId: Number(header[1]),
    vrf: header[2] ?? 'default',
    ...(routerId === undefined ? {} : { routerId }),
    networks: readNetworks(block.body),
    redistributions: readRedistributions(block.body),
    shutdown: !block.body.some((line) => line.text === NO_SHUTDOWN),
  }
}

/** The networks scan — upstream's `re.findall` (`:137-144`) over BODY LINES only (divergence 3). */
function readNetworks(body: readonly { text: string }[]): OspfNetwork[] {
  const networks: OspfNetwork[] = []
  for (const line of body) {
    const found = OSPF_NETWORK_LINE.exec(line.text)
    if (found === null) continue
    networks.push({ network: found[1] as string, netmask: found[2] as string, area: found[3] as string })
  }
  return networks
}

/** The redistribution scan — upstream's token-count rule (`:157-170`) at line scope (divergence 3). */
function readRedistributions(body: readonly { text: string }[]): OspfRedistribution[] {
  const redistributions: OspfRedistribution[] = []
  for (const line of body) {
    if (!REDISTRIBUTE_LINE.test(line.text)) continue
    const tokens = line.text.split(/\s+/u)
    // Upstream checks `len == 2` then `len == 4` with two independent ifs (`:162`, `:166`) — a
    // two-token line never also takes the 4-token arm, so one branch says the same thing.
    if (tokens.length === 2) {
      redistributions.push({ protocol: tokens[1] as string })
    } else if (tokens.length === 4) {
      // Token 3 becomes the route-map WHATEVER it is (`:167`) — upstream never checks the literal
      // `route-map` sits there. Kept, so any four-token redistribute line reads back exactly as
      // upstream would read it; faithfulness over semantic tidying.
      redistributions.push({ protocol: tokens[1] as string, routeMap: tokens[3] as string })
    }
    // Any other token count is dropped upstream (`:162`/`:166` both false — e.g. the real-world
    // `redistribute bgp route-map RM sub-route-map` is 5 tokens and simply vanishes); kept here and
    // pinned in the spec, because "invented a field EOS never wrote" is the worse failure.
  }
  return redistributions
}

/**
 * `node.ospf` — the OSPF configuration of one switch. pyeapi's `Ospf(Entity)` (`:43`): one global-ish
 * entity, NOT an EntityCollection — even though a real node can carry several `router ospf …`
 * processes, upstream (and this port) answers one section per read of one vrf (divergence 7).
 */
export class OspfResource extends Entity<OspfState | undefined> {
  /**
   * The OSPF state, or `undefined` when this switch runs no matching process — pyeapi's
   * `get(vrf=None)` (`:51-88`). `vrf` narrows to sections whose header ends with ` vrf <name>`
   * exactly (upstream appends `' vrf %s'` to the block pattern, `:73-74` — and this port compares
   * the suffix as TEXT instead of interpolating it into a regex, closing the getBlock line-39
   * parent-as-pattern hazard for this caller). No reads happen per field: one `show running-config`
   * (memoised, DR-026) answers the whole record (DR-030, pinned in the spec).
   */
  async get(vrf?: string): Promise<OspfState | undefined> {
    const sections = await this.configSections()
    const key = findOspfSection(sections, vrf)
    if (key === undefined) return undefined
    return readProcess(key, sections)
  }

  /**
   * `router ospf <pid>` (+ `' vrf <name>'`) — pyeapi's `create` (`:224-243`), the texts pinned by
   * `test_api_ospf.py:34-46` (`'router ospf 65000'`, `'router ospf 65000 vrf test'`). Zero reads:
   * upstream has none on this verb (it is the ONLY ospf write that does not read first), and a
   * refusal from the guard above the send costs none either (pinned).
   */
  async create(ospfProcessId: string | number, vrf?: string): Promise<void> {
    assertProcessId(ospfProcessId)
    if (vrf !== undefined) assertVrfName(vrf)
    const command = `router ospf ${digitText(ospfProcessId)}${vrf === undefined ? '' : ` vrf ${vrf}`}`
    await this.configure([command])
  }

  /**
   * Remove the whole process — pyeapi's `delete` (`:210-222`): reads first, `no router ospf <pid>`
   * (`test_api_ospf.py:52-56` pins `no router ospf 65000`), and NOTHING when there is no process
   * (upstream's `return True`, pinned by its `test_no_delete` `:147-149` — here a void with zero
   * command batches, asserted against `transport.sent()`).
   */
  async delete(): Promise<void> {
    const current = await this.get()
    if (current === undefined) return
    await this.configure([`no router ospf ${String(current.ospfProcessId)}`])
  }

  /**
   * Enter the FIRST ospf process and write `commands` — the public upstream wrapper `configure_ospf`
   * (`:244-255`), still public here: its docstring invites raw subcommand lists ("list of OSPF
   * subcommands", `:245-248`), and the pinning tests below show the same two-line shape the named
   * verbs use. One full `get()` first (upstream `:251`) supplies the pid — and it is always the
   * FIRST process on the node, never an operator-selected one (divergence 7).
   *
   * @throws {NotFoundError} no `router ospf` section exists — upstream crashes with `TypeError`
   *   (`None['ospf_process_id']`, fed by `get()` answering None, `:251-253`); this client names the
   *   missing section (divergence family of DR-027).
   */
  async configureOspf(commands: CommandInput): Promise<void> {
    const current = await this.get()
    if (current === undefined) {
      throw new NotFoundError(
        'configure_ospf: this switch has no `router ospf …` section — create() a process first (pyeapi reaches None[\'ospf_process_id\'] here and raises TypeError, ospf.py:251-253)',
      )
    }
    await this.configure(submodeCommands(`router ospf ${String(current.ospfProcessId)}`, toArray(commands)))
  }

  /**
   * `router-id <value>` inside the process — `set_router_id(value=…)` (`:257-269`, pinned
   * `test_api_ospf.py:79-96`'s config arm).
   */
  async setRouterId(value: string): Promise<void> {
    assertToken('ospf router-id', value)
    await this.configureOspf(this.commandBuilder('router-id', { value }))
  }

  /** `no router-id` — upstream spells this a NO-ARGUMENT `set_router_id()` call, whose falsy value falls through to the deprecated `no` form (`abstract.py:160-161`, pinned at `test_api_ospf.py:84-85`/`:91-95`). DR-037 makes the negation a verb. */
  async unsetRouterId(): Promise<void> {
    await this.configureOspf(this.commandBuilder('router-id', { mode: 'no' }))
  }

  /** `default router-id` — upstream's `set_router_id(rid, True)` arm (the third positional slot is `default`, `:257`), pinned at `test_api_ospf.py:86-87`. */
  async defaultRouterId(): Promise<void> {
    await this.configureOspf(this.commandBuilder('router-id', { mode: 'default' }))
  }

  /**
   * Bare `shutdown` — pyeapi's `set_shutdown()` (`:185-195`), pinned `test_api_ospf.py:97-105`'s
   * config arm. Unlike `Bgp.set_shutdown` (`bgp.py:154`, defaulting to NEGATE) there are no flags
   * here at all: this is the plain command.
   */
  async shutdown(): Promise<void> {
    await this.configureOspf('shutdown')
  }

  /** `no shutdown` — pyeapi's separate method `set_no_shutdown()` (`:197-208`), pinned at `test_api_ospf.py:99-104`'s negate arm. */
  async noShutdown(): Promise<void> {
    await this.configureOspf('no shutdown')
  }

  /**
   * `network <net>/<mask> area <area>` — `add_network` (`:271-290`), pinned verbatim at
   * `test_api_ospf.py:57-63` as `network 172.16.10.0/24 area 0`: the default area is the NUMBER 0
   * (`:271`) and composes the bare word `area 0` — which `_parse_networks` then cannot read back
   * (divergence 4, pinned there too). Upstream raises `ValueError` for empty network/mask
   * (`:287-289`); the guard below refuses the same inputs and the line-unsafe ones with them.
   */
  async addNetwork(network: string, netmask: string | number, area: string | number = 0): Promise<void> {
    assertToken('ospf network', network)
    assertMaskLen('ospf netmask', netmask)
    assertArea(area)
    await this.configureOspf(`network ${network}/${digitText(netmask)} area ${digitText(area)}`)
  }

  /** `no network <net>/<mask> area <area>` — `remove_network` (`:292-312`), pinned at `test_api_ospf.py:68-74`. The `area` part of a negation always rides, same default `0` (`:292`). */
  async removeNetwork(network: string, netmask: string | number, area: string | number = 0): Promise<void> {
    assertToken('ospf network', network)
    assertMaskLen('ospf netmask', netmask)
    assertArea(area)
    await this.configureOspf(`no network ${network}/${digitText(netmask)} area ${digitText(area)}`)
  }

  /**
   * `redistribute <protocol>[ route-map <name>]` — `add_redistribution` (`:314-336`), pinned across
   * `test_api_ospf.py:107-124` for all four allow-listed protocols with and without a route-map.
   * The allow-list (`:323`) is pyeapi's own and kept verbatim — 4.28 understands more (`ospf`,
   * `isa…`?) and that widening is a device-capture question this port does not guess (DR-032).
   * Upstream's guard raises `ValueError` with the message `redistributed protocol must bebgp, …`
   * (`:325-326`, a missing space); corrected here (divergence 5), same refusal.
   */
  async addRedistribution(protocol: string, routeMapName?: string): Promise<void> {
    assertProtocol(protocol)
    if (routeMapName !== undefined) assertToken('ospf route-map name', routeMapName)
    await this.configureOspf(
      routeMapName === undefined
        ? `redistribute ${protocol}`
        : `redistribute ${protocol} route-map ${routeMapName}`,
    )
  }

  /**
   * `no redistribute <protocol>` — `remove_redistribution` (`:338-357`), pinned at
   * `test_api_ospf.py:126-141`. The upstream method takes NO route-map argument, so a qualified
   * line negates with whatever comes out of the bare form (divergence 10, pinned in both directions).
   */
  async removeRedistribution(protocol: string): Promise<void> {
    assertProtocol(protocol)
    await this.configureOspf(`no redistribute ${protocol}`)
  }
}

/** Upstream's redistribution allow-list (`:323`, `:347`) — kept as data so both methods and the refusal message agree. */
const REDISTRIBUTION_PROTOCOLS: readonly string[] = ['bgp', 'rip', 'static', 'connected']

function assertProtocol(protocol: unknown): asserts protocol is string {
  if (typeof protocol !== 'string' || !REDISTRIBUTION_PROTOCOLS.includes(protocol)) {
    refuse('ospf redistribution protocol', protocol, `must be one of ${REDISTRIBUTION_PROTOCOLS.join(', ')} — pyeapi hard-codes exactly those four (ospf.py:323/:347) and refuses ValueError otherwise; whether 4.28 redistributes MORE (ospf itself, isis, …) is for M12 #14 to capture, not this client to guess (DR-032)`)
  }
}
