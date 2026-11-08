/**
 * `bgp` — the BGP router entity plus its neighbours sub-collection, W3a (#49), built on the M7 (#9)
 * framework like `mlag.ts` / `vrfs.ts` / `varp.ts`: `Entity` + `EntityCollection` from `base.ts`,
 * `commandBuilder` / `submodeCommands` from `command-builder.ts`, M6's chunked document, local guards
 * (DR-053's pattern), no new error classes (DR-005/DR-010).
 *
 * Port of `pyeapi/api/bgp.py` (341 lines, BSD-3-Clause, Arista Networks — DR-001). Every `pyeapi` ref
 * below was re-opened in the pinned clone `/home/svaj/development/arista/pyeapi`
 * (1.0.4-rc0, `develop` @ `6816d9e`) on 2026-11-06 and says what the code **does** — no EOS-internals
 * citation, no DCS-7050TX-64 acceptance claim: unit tests never reach a device and every EOS-side
 * question reads "unverified on hardware, M12 (#14) to capture".
 *
 * | pyeapi (verified refs) | here |
 * |---|---|
 * | `Bgp(Entity)` (`:47`), `_neighbors` memo (`:51-54`), the `neighbors` **property** (`:55-60`), `instance(api)` (`:340-341`) | {@link BgpResource} extends `Entity<BgpState \| undefined>`; the {@link BgpResource.neighbors} getter holds the one {@link BgpNeighborsResource} (pyeapi's lazy `_neighbors`, replaced by the per-`Node` registry memo parent, DR-052 — the same shape `varp.ts:353-371` shipped); the registry row + `Node.bgp` replaces `instance` (DR-006). `BgpNeighbors` is a SUB-collection reached through the entity — NOT a registry row (brief; the `acls`/`varp`/`stp` precedent) |
 * | `get` (`:62-78`): `get_block('^router bgp .*')` (`:68`), five `_parse_*` merges (`:71-75`), then `response['neighbors'] = self.neighbors.getall()` (`:77`); `None` when the block is missing (`:69-70`) | {@link BgpResource.get} — first `router bgp …` chunk key in device order, `undefined` when the switch runs no BGP (divergence 1), and the neighbours table from the SAME one-read document (DR-030) |
 * | `_parse_bgp_as` (`:80-83`): `(?<=^router bgp ).*` then `int(…)` when `str.isnumeric()()` ELSE the raw string | {@link BgpState.bgpAs} `number \| string` with the SAME split: all-ASCII-digits → number, anything else → the WHOLE header remainder, vrf tail included (`router bgp 100 vrf MGMT` → `'100 vrf MGMT'`, divergence 2 — and the two halves of the module then open DIFFERENT `router bgp …` lines, divergence 3) |
 * | `_parse_router_id` (`:84-88`): `router-id ([^\s]+)` anywhere | {@link valueAfterKeyword} at the body line (the ospf module's divergence-3 rule, applied here too) |
 * | `_parse_max_paths` (`:89-94`): `maximum-paths\s+(\d+)\s+ecmp\s+(\d+)` — a bare `maximum-paths N` is INVISIBLE, and both keys are always present (`None`/`None` or both set: a PAIR) | {@link BgpState.maximumPaths} / {@link BgpState.maximumEcmpPaths} — same pair regex, same invisibility (divergence 4), both absent where upstream answers `None` |
 * | `_parse_shutdown` (`:95-98`): `shutdown = not ('no shutdown' in config)` substring rule | derived-true default kept, line-scoped (the mlag divergence-3 family): a body line exactly `no shutdown` answers `false`, anything else present answers `true` (divergence 5) |
 * | `_parse_networks` (`:99-107`): `network (.+)/(\d+)(?: route-map (\w+))*` (the `*` is upstream's — a second `route-map` phrase would loop, `''`/unset group → None) | {@link BgpNetwork} rows: same regex semantics, line-scoped; a route-map NAME running past `\w` (e.g. `RM-OUT`) reads TRUNCATED to the word run (`RM`) — Python's `\w+` + `*` loop does exactly this (pattern probed against the pinned clone 2026-11-06) — kept (divergence 6) |
 * | `configure_bgp(cmd)` (`:108-113`): full `get()` first (`:109` — which also runs `neighbors.getall()`), then `['router bgp <bgp_as>'] + make_iterable(cmd)` | private {@link configureBgp}: one header-only read for the AS (the neighbors half is not needed to open a submode — the divergence-2 remainder text is still what opens it), {@link submodeCommands}, and a {@link NotFoundError} where upstream `None['bgp_as']`-TypeErrors |
 * | `create(bgp_as)` (`:114-120`): `int()` + `0 < value < 65536` → `ValueError('bgp as must be between 1 and 65535')`; raw-argument interpolation | {@link BgpResource.create} — same bound (4-byte AS territory is the device's to answer, DR-032), digits normalized (the ospf divergence-6 rule), `NotSupportedError` instead of `ValueError` (DR-005/DR-010) |
 * | `delete` (`:121-127`) / `default` (`:128-134`): `get()` first, `True` no-op when the block is absent, else `no/default router bgp <bgp_as>` | {@link delete} / {@link setDefault} (framework naming of upstream's bare `default()`, row 77) — same texts built from the SAME (possibly non-numeric) `bgpAs` value, pinned (divergence 2) |
 * | `set_router_id` (`:135-139`), `set_maximum_paths` (`:140-153`, incl. the `TypeError('Cannot use maximum_ecmp_paths without providing max_path')` guard at `:142-144` and the `'{} ecmp {}'` value composition `:148-150`), `set_shutdown` (`:154-162`, **`default=False, disable=True` as PARAMETER defaults** — a zero-argument call NEGATES), `add_network`/`remove_network` (`:163-181`, both append `' route-map %s'` when one is given — a NEGATED removal keeps it) | the DR-037 verb trios: {@link setRouterId}/{@link unsetRouterId}/{@link defaultRouterId}; {@link setMaximumPaths}/{@link unsetMaximumPaths}/{@link defaultMaximumPaths}; {@link shutdown}/{@link noShutdown}/{@link defaultShutdown} (the inverted default pinned); {@link addNetwork}/{@link removeNetwork} with the route-map arm kept on BOTH (upstream's `test_add_network`/`test_remove_network` at `:78-99` pin it) |
 * | `BgpNeighbors(EntityCollection)` (`:182`): `get(name)` (`:184-196` — an ENTRY FOR EVERY NAME, fields `None`-filled), `getall()` (`:197-205`: `get_block` + `re.findall(r'neighbor ([^\s]+)')` + `self.get(name)` per hit), eight per-name `_parse_*` (`:207-254`) | {@link BgpNeighborsResource} extends `EntityCollection<BgpNeighbor, string, …>`: reads parse `neighbor …` BODY LINES once into one table (divergence 7); `get(name)` answers a table row or `undefined` (no all-`None` phantom rows); `getall()`'s `None` becomes the empty table |
 * | `_parse_peer_group` (`:207-215`): the spelling keyed on `self.version_number >= '4.23'` (lexicographic — `'4.9' >= '4.23'` is True, the DR-078/DR-099 bug class) | the reader accepts BOTH spellings and records which one the device used ({@link BgpNeighbor.peerGroupForm}); writers follow {@link detectPeerGroupForm} from the device's own block with a modern fallback (divergence 8, DR-107's lineage) |
 * | `ispeergroup` (`:255-261`): `netaddr.IPAddress(name)` → False on success, True on `AddrFormatError` | {@link BgpNeighborsResource.isPeerGroup} — a dependency-free IPv4/IPv6 literal check (divergence 9, DR-110), same polarity and name |
 * | `create(name)` (`:262-264`): literally `self.set_shutdown(name, default=False, disable=False)` | {@link create} — pinned through that wiring: it emits the BARE `neighbor <name> shutdown`, which is a SHUTDOWN, not an enablement (divergence 10, DR-109: kept verbatim, flagged loudly, not "fixed") |
 * | `delete(name)` (`:265-275`): `configure('no neighbor X')`; when upstream's `configure` swallowed a `CommandError` into `False` (`abstract.py:118-127`), retry `no neighbor X peer group` (≥4.23) / `peer-group` | {@link delete} — `CommandError` from the first attempt caught (and ONLY that class — DR-005's throws keep other failures loud), fallback retried, a second failure rethrows (divergence 11) |
 * | `configure(cmd)` (`:276-282`): `re.search(r'router bgp (\d+)', self.config)` over the RAW whole-config text, `ValueError('bgp is not configured')` on no match; opener `router bgp <digits>` | private {@link configureNeighbor} — the digits come from a chunk SECTION KEY (a phrase inside a banner/description cannot be an opener anchor, divergence 7), and "not configured" is the taxonomy's {@link NotFoundError} — the same text, kept |
 * | `command_builder(name, cmd, value, default, disable)` override (`:283-287`): prefixes the stem with `neighbor <name>` before handing it to the base builder — nothing else changes | the verbs below build stems `neighbor <name> <cmd>` and pass them to the repo {@link commandBuilder}: M7's precedence table (default → no → value, DR-037) carries over UNCHANGED, exactly as MLAG's header proved for the inherited builder |
 * | nine `set_*` verbs (`:288-338`) taking `(name, value, default, disable)` — `set_peer_group` returns bare `False` when `ispeergroup(name)` (only IP-named neighbours can join a group, `:290-298`); `set_shutdown`'s param defaults are (again) `disable=True` (`:303`); `set_route_map_in/out` suffix the built command with `' in'`/`' out'` AFTER the builder, so even the negated/default arms read `no neighbor X route-map in` (`:323-333`) | the verb trios below with the same texts; `set_peer_group`'s silent `False` became a {@link NotSupportedError} refusal (divergence 12); `set_route_map_in/out` keep the suffix on all three arms, pinned |
 *
 * Upstream's own suite is `pyeapi/test/unit/test_api_bgp.py` — **22** test methods (verified in the
 * pinned clone on 2026-11-06): entity half `TestApiBgp`: `test_get` (`:51-55`), `test_create`
 * (`:56-62`), `test_create_invalid_as` (`:63-67`), `test_delete` (`:68-72`), `test_default`
 * (`:73-77`), `test_add_network` (`:78-88`), `test_remove_network` (`:89-99`), `test_set_router_id`
 * (`:100-122`), `test_maximum_paths_just_max_path` (`:123-145`), `test_maximum_paths_max_path_and_ecmp`
 * (`:146-164`), `test_set_shutdown` (`:165-184`); neighbours half `TestApiBgpNeighbor` (constructed as
 * `BgpNeighbors(None)` at `:188`): `test_getall` (`:186-189`), `test_get` (`:191-196`), `test_delete`
 * (`:198-202`), `test_set_peer_group` (`:203-228`), `test_set_remote_as` (`:229-253`),
 * `test_set_shutdown` (`:254-272`), `test_set_send_community` (`:273-298`),
 * `test_set_next_hop_self` (`:299-324`), `test_set_route_map_in` (`:325-350`),
 * `test_set_route_map_out` (`:351-376`), `test_set_description` (`:377-391`). All 22 are ported in
 * `bgp.test.ts` with pinned texts verbatim — including every one of upstream's
 * "If command_builder fails because value is None, uncomment" arms, which are DR-037's named verbs
 * here (and command-builder.ts's header already cites `test_api_bgp.py:117` as exhibit A).
 * Upstream's `test/system/test_api_bgp.py` is device-territory: declared skipped for this offline
 * lane, not faked (docs/TESTING.md §5).
 *
 * The fixture half: upstream reads `test/fixtures/running_config.bgp` verbatim. Like the sibling W2/W3
 * suites this one uses **inline, hand-reduced** config text derived from that file (lines 4-16 of the
 * pinned copy: bgp 65000 with neighbours `test`/`test1`/`172.16.10.1` and two networks) — no fixture
 * file is added by this lane, and the reduction is stated at each config below. The peer-group
 * SPELLING in that fixture is `peer-group` (the old arm); the modern `peer group` arm gets its own
 * config below rather than inheriting upstream's fake-version `'4.17.1.1'` (`test/lib/testlib.py:75`)
 * which could only ever pin one spelling.
 *
 * ## Divergences this file owns (rows 197-202 are this lane's band; under-filled rows are declared skips)
 *
 * 1. **"no BGP process" is `undefined`, and "no neighbours" is the empty table.** Upstream's
 *    `Bgp.get` answers `None` for a missing block (`:69-70`) and `BgpNeighbors.getall` answers
 *    `None` the same way (`:198-200`). Here: `Bgp.get` → `undefined` (dr-ospf-1's family, DR-106),
 *    `neighbors.getAll()` → an EMPTY table (a table shape that `has`/`keys` keep working on), and
 *    `neighbors.get(name)` never returns upstream's all-`None` phantom record for a name the switch
 *    does not configure (`:184-196` has no existence check) — an absent neighbour is absence.
 * 2. **`bgpAs` keeps upstream's split typing.** `int()` when the whole header remainder is numeric,
 *    otherwise the RAW remainder string (`:82-83`), so `router bgp 100 vrf MGMT` yields
 *    `bgpAs = '100 vrf MGMT'` and `create`-style bounds are enforced on the CREATE argument only,
 *    never on the readback. The Python predicate is `str.isnumeric()` (unicode digits included); the
 *    TS predicate is ASCII `\d+` (a unicode-digit header falls to the STRING arm instead of the
 *    number — no crash either way, pinned as a narrowing).
 * 3. **the entity half and the neighbours half can open DIFFERENT `router bgp` lines on the same
 *    config.** Entity writes use `get()`'s `bgpAs` — the whole header remainder (`:110-112`);
 *    neighbour writes use `re.search(r'router bgp (\d+)')` — the first DIGITS run anywhere in the
 *    config (`:277`). On `router bgp 100 vrf MGMT` that is `router bgp 100 vrf MGMT` vs
 *    `router bgp 100`; the port keeps both faithfully and pins the split. (Upstream's neighbours'
 *    search is unanchored — a config line PHRASE containing `router bgp 123` would anchor it there;
 *    only real section keys can here, divergence 7.)
 * 4. **a bare `maximum-paths N` is invisible to `get()`, and the two fields are a pair.** Upstream's
 *    only max-paths regex requires the `… ecmp M` tail (`:91`); both dict keys are always emitted
 *    (`None`/`None` otherwise, `:93-94`). Kept: absent-both is the shape, and the pin records that a
 *    config line `maximum-paths 8` reads NOTHING.
 * 5. **shutdown reads line-scoped, derivation kept.** Same family as mlag divergence 3 / ospf
 *    divergence 3: `no shutdown` anywhere-in-block (`:97`) becomes a body-line rule; a block with no
 *    shutdown line at all still derives `true` (upstream's answer — pinned both ways; whether 4.28
 *    writes a bare `shutdown` under a `router bgp` is M12 territory).
 * 6. **route-map names past the first word run TRUNCATE on read — upstream's own regex quirk kept,
 *    quirk probed against Python itself on 2026-11-06.** `(?: route-map (\w+))*` (`:101`) on
 *    `network 10.0.0.0/24 route-map RM-OUT`: the `\w+` capture stops at the hyphen, the `*` loop takes
 *    that one rep, and `-OUT` silently drops — Python answers `route_map='RM'` (the probe output, and
 *    the JS port answers the identical `RM`), NOT None and not the full name. A line with NO
 *    route-map yields the unset group → None upstream → absent here. The write side accepts `\S+`, so
 *    this client CAN write `RM-OUT` and read back `RM` — pinned as the honest asymmetry; whether
 *    4.28 renders hyphenated route-map names inside `network` lines at all is M12 (#14) capture.
 * 7. **the neighbour table is parsed from `neighbor …` body lines once — phrase-names and
 *    negation-values stop voting.** Upstream's `getall` keys come from `re.findall(r'neighbor ([^\s]+)')`
 *    over the whole block (`:203`): a description that SAYS `neighbor ghost` adds a `ghost` entry, and
 *    the per-name parsers then match substrings inside NEGATIONS — `no neighbor X peer-group Y` reports
 *    `peer_group: Y` (`:211`/`:213` search anywhere), `no neighbor X description hello` reports
 *    `description: 'hello'` (`:234`). Here keys come from lines that BEGIN `neighbor …` (or
 *    `no neighbor …` — the name is still mentioned, as upstream's key scan would count it), and a
 *    negation sets NO field value; the boolean reads that upstream builds from the negation form
 *    (`send-community`, `next-hop-self`, `shutdown`) keep their polarity exactly.
 *    One read per table (DR-030, pinned) — upstream pays one `get_block` scan per name (`:204-205`).
 * 8. **the `peer group` vs `peer-group` spelling is a DEVICE READ, not a version string compare.**
 *    Upstream gates three sites on `self.version_number >= '4.23'` (`:209`, `:267`, `:271`, `:292` —
 *    the same bug class DR-078/DR-099 record: `'4.9' >= '4.23'` is True character-wise). Here the
 *    reader matches either spelling and records the one used ({@link BgpNeighbor.peerGroupForm}, no
 *    upstream twin — the `VrfDefinitionForm` precedent); writers follow the FIRST spelling the block
 *    itself contains ({@link detectPeerGroupForm}, latched per instance like `VrfsResource`'s form),
 *    defaulting to the modern `peer group` (this repo's 4.28 floor, held as a client convention — a
 *    device that only speaks the old keyword answers its own `CommandError`, DR-005/DR-032). DR-107.
 * 9. **`isPeerGroup` parses IP literals without netaddr.** Upstream hands the name to
 *    `netaddr.IPAddress` (`:257`), which besides dotted quads/IPv6 also accepts PARTIAL dotted forms
 *    (`'1.2.3'` → 1.2.0.3), plain decimal and hex integers, etc. Dependency policy says no new
 *    dependency (DR-110), so the port checks a full IPv4 dotted quad or a colon-bearing IPv6 address;
 *    exotic netaddr-valid spellings now read as "a group name" where upstream read "an address" —
 *    pinned in the refusal direction only (this client refuses FEWER writes overall than a full
 *    netaddr port would, never more).
 * 10. **`create(name)` emits the bare SHUTDOWN because that is literally what upstream calls
 *     (`:262-264`)** — `set_shutdown(name, default=False, disable=False)` → command_builder value
 *     `True` → `neighbor <name> shutdown`. It declares the neighbour in the running-config AND shuts
 *     it down. This port does NOT quietly "fix" the wiring (faithful-port rule; DR-109): the verb is
 *     pinned with its real text and a doc that says the operator who means "enable this peer" wants
 *     {@link unsetShutdown} (upstream's zero-arg default, `:303`'s `disable=True`). The device stays
 *     authoritative on whether the line even creates anything (DR-032).
 * 11. **the delete fallback retries on a REAL device refusal, and a second failure throws.**
 *     Upstream's chain is a `False` from the swallowed-error `configure` (`abstract.py:118-127`).
 *     Here the first batch's `CommandError` is caught (and ONLY `CommandError`: a connect/TLS/auth
 *     failure is not a command refusal and must not trigger a second write), then the group-keyword
 *     retry runs with the detected spelling; if THAT fails the retry's `CommandError` propagates —
 *     replacing upstream's `return False`, which the taxonomy made unreachable anyway (DR-005).
 * 12. **`setPeerGroup` on a non-address name refuses out loud where upstream returned `False`
 *     silently** (`:290`/`:298`: the gate is `if not self.ispeergroup(name)` — only IP-named
 *     neighbours can join a group; a group name gets nothing and no error). A silent no-op write is
 *     exactly what a UI operator misreads as success; the refusal names the reason and costs zero
 *     round trips (pinned). Deliberate widening, asserted (COMMON's rule), recorded in row 202.
 */

import { CommandError, ConfigParseError, NotFoundError, NotSupportedError } from '../errors'
import { pythonRepr } from '../internal/wire'
import { Entity, EntityCollection } from './base'
import { submodeCommands } from './command-builder'
import { valueAfterKeyword } from './config-block'
import { parseBlock } from '../config/text'
import type { Node } from '../command-layer'
import type { ConfigSections } from '../config/chunk'
import type { CommandInput, CommandValue } from './types'
import type { ResourceTable } from './types'

/** Upstream's block pattern `get_block('^router bgp .*')` (`bgp.py:68`, `:199`). */
const BGP_BLOCK = /^router bgp .+$/u

/** The header remainder whose numeric-vs-string shape decides `bgpAs` (`_parse_bgp_as`, `:80-83`). */
const BGP_HEADER_AS = /^router bgp (.+)$/u

/** The neighbours-half opener: first DIGITS run — upstream's `re.search(r'router bgp (\d+)', self.config)` (`:277`), anchored to section keys (divergence 7). */
const BGP_HEADER_DIGITS = /^router bgp (\d+)/u

/** The max-paths PAIR regex (`:91`) — nothing else about maximum-paths is read, upstream-faithfully (divergence 4). */
const MAX_PATHS_LINE = /^maximum-paths\s+(\d+)\s+ecmp\s+(\d+)/u

/** Upstream's `network (.+)/(\d+)(?: route-map (\w+))*` (`:101`) — the `*` and the `\w` quirk kept verbatim (divergence 6). */
const BGP_NETWORK_LINE = /^network (.+)\/(\d+)(?: route-map (\w+))*/u

/** `_parse_shutdown`'s substring (`:97`) made whole-line honest (divergence 5). */
const NO_SHUTDOWN = 'no shutdown'

/** One `network …` row — upstream's `dict(prefix, masklen, route_map)` (`:104-106`). */
export interface BgpNetwork {
  /** Greedy upstream `(.+)` up to the LAST `/` — `prefix`. */
  readonly prefix: string
  /** `(\d+)` — a STRING, as upstream's match group is (`masklen`). */
  readonly masklen: string
  /** TRUNCATED at the first non-word character (divergence 6 — `RM-OUT` reads as `RM`, Python-probed); absent when the line carries no route-map at all — upstream's `None`. */
  readonly routeMap?: string
}

/** Which `peer group` spelling the device's own lines used (divergence 8). No upstream twin — the `VrfDefinitionForm` shape. */
export type PeerGroupForm = 'peer group' | 'peer-group'

/**
 * One neighbour as the BLOCK describes it — upstream's `get(name)` record (`:186-195`) with the
 * `None` fields replaced by absence (DR-029 family) and each parser's substring rule replaced by
 * body-line anchors (divergence 7). The two booleans keep upstream's DERIVED defaults: `send-community`
 * and `next-hop-self` are true unless the block carries the `no …` negation (`:221-225`, `:238-242`),
 * `shutdown` is false unless the bare positive line exists (`:226-231`'s lookbehind rule).
 */
export interface BgpNeighbor {
  readonly name: string
  /** The group this neighbour belongs to. Absent for the bare `neighbor X peer-group` DECLARATION lines (upstream sees no value there either, `:211-214`). */
  readonly peerGroup?: string
  /** The spelling that carried the membership line — only present with `peerGroup` (divergence 8). */
  readonly peerGroupForm?: PeerGroupForm
  /** `remote-as …`'s whole line remainder, as the `.*` lookbehind kept it (`:216-220`) — string, even for numeric ASNs. */
  readonly remoteAs?: string
  /** `description …`'s raw remainder, quotes included if the device wrote them (`:232-237`). */
  readonly description?: string
  readonly sendCommunity: boolean
  readonly nextHopSelf: boolean
  readonly shutdown: boolean
  readonly routeMapIn?: string
  readonly routeMapOut?: string
}

/** What {@link BgpResource.get} answers — upstream's merged dict (`:71-77`), typed. */
export interface BgpState {
  /** Number when the header remainder is ASCII digits, otherwise the WHOLE remainder string — including a ` vrf …` tail (divergence 2; the two-opener split that follows from it is divergence 3). */
  readonly bgpAs: number | string
  readonly routerId?: string
  /** Present only in PAIRS and only for the `… ecmp …` form (divergence 4). */
  readonly maximumPaths?: number
  readonly maximumEcmpPaths?: number
  /** The derived default: true unless the block carries a body line `no shutdown` (divergence 5). */
  readonly shutdown: boolean
  /** `[]` when none parse — upstream's answer for no matches (`:100`, `:107`). */
  readonly networks: readonly BgpNetwork[]
  /** Every `neighbor …`-mentioned name in device order — `getall()`'s dict, as a table (row 78). */
  readonly neighbors: ReadonlyMap<string, BgpNeighbor>
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

function assertBgpAsInput(value: unknown): asserts value is string | number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) refuse('bgp as', value, 'a numeric AS must be a safe integer — the reader takes \\d+ (bgp.py:82) and floats/NaN cannot echo back')
  } else if (typeof value !== 'string' || !/^\d+$/u.test(value)) {
    refuse('bgp as', value, 'expected digits — pyeapi int()-coerces but INTERPOLATES THE RAW ARGUMENT (bgp.py:119-120), so padded strings ride upstream; this client composes normalized digits (the ospf divergence-6 rule)')
  }
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!(0 < numeric && numeric < 65536)) {
    refuse('bgp as', value, 'must be between 1 and 65535 — pyeapi enforces exactly this bound (bgp.py:116-118); 4-byte AS numbers are a device answer for M12 #14, not a bound this client lifts (DR-032)')
  }
}

/**
 * A neighbour name as this module can write and re-read it: the getall grammar is `neighbor ([^\s]+)`
 * (`:203`), so: one non-empty token, no control characters. Everything else (dots, colons, IPv6 forms,
 * group names) rides through — reads never interpolate the name into a regex (the table lookup
 * replaces upstream's regex-per-name, divergence 7), and writes compose it as a single token.
 * pyeapi validates NOTHING (`:263`, `:266`, `:272`, `:278`, `:289-334` all interpolate raw).
 */
function assertNeighborName(value: unknown): asserts value is string {
  if (typeof value !== 'string') refuse('bgp neighbor name', value, 'expected a string name — pyeapi interpolates whatever arrives (bgp.py:289-334)')
  if (value === '') refuse('bgp neighbor name', value, 'an empty name composes `neighbor  …` — the reader captures (\\S+) tokens and never an empty one (bgp.py:203); a neighbour that does not exist is not addressed by an empty string')
  if (/\s/u.test(value)) refuse('bgp neighbor name', value, 'a name with whitespace splits the command line and could never re-read as one token (bgp.py:203 captures [^\\s]+)')
  if (hasControlCharacter(value)) refuse('bgp neighbor name', value, 'a control character would break the config line this client reads back (row 74)')
}

/** A single-token value (route-map names, peer-group names): the reader grammar `([^\s]+)` at `:211`/`:245`/`:249`, extended to reject '' upstream lets through its falsy fall-through (`abstract.py:160-161`). */
function assertValueToken(label: string, value: unknown): asserts value is string {
  if (typeof value !== 'string') refuse(label, value, 'expected a string token — pyeapi interpolates whatever arrives non-falsy (bgp.py:288-338 via abstract.py:158-159)')
  if (value === '') refuse(label, value, 'an empty value is refused — clear the field with the verb that means it (pyeapi falls through to the deprecated `no …` form, abstract.py:160-161, DR-037)')
  if (/\s/u.test(value)) refuse(label, value, 'a value with whitespace splits the command line; these readers capture one [^\\s]+ token (bgp.py:211, :245, :249)')
  if (hasControlCharacter(value)) refuse(label, value, 'a control character would break the config line this client reads back (row 74)')
}

/** remote-as: the `.*` remainder grammar (`:218`) — non-empty, no outer whitespace, inner single spaces tolerated. Upstream's own test value is the STRING '65000' (`test_api_bgp.py:230`); a number normalizes. */
function assertRemainderValue(label: string, value: unknown): asserts value is string | number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) refuse(label, value, 'NaN/Infinity are not configuration values')
    return
  }
  if (typeof value !== 'string') refuse(label, value, 'expected a string — the reader keeps the whole line remainder (bgp.py:218) and pyeapi sends whatever interpolation produced')
  if (value.trim() === '') refuse(label, value, 'an empty remainder composes a trailing space the reader then rstrips away — clear the field with the unset verb instead (DR-037)')
  if (value !== value.trim()) refuse(label, value, 'outer whitespace cannot read back: the value is the rstripped line remainder (bgp.py:218 via .* on a device config; describeLine rstrips here)')
  if (hasControlCharacter(value)) refuse(label, value, 'a control character would break the config line this client reads back (row 74)')
}

/** A max-paths count: digits both spellings (`:91` reads `(\d+)`). */
function assertDigits(label: string, value: unknown): asserts value is string | number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) refuse(label, value, 'a numeric path count must be a safe non-negative integer — readers take \\d+ (bgp.py:91); negatives/fractions cannot echo back. The number 0 COMPOSES a literal 0 — pyeapi would NEGATE it through the falsy fall-through (abstract.py:160-161, DR-037): see the pin')
    return
  }
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) {
    refuse(label, value, 'expected digits — pyeapi formats whatever arrives (`{}`.format, bgp.py:148) and only its own truthiness test filters inputs; this client matches the reader instead (DR-053 pattern)')
  }
}

function digitText(value: string | number): string {
  return typeof value === 'number' ? String(value) : value
}

/** First matching chunk key — the section twin of both `get_block('^router bgp .*')` call sites (`:68`, `:199`). */
function findRouterBgpSection(sections: ConfigSections): string | undefined {
  for (const key of sections.keys()) {
    if (BGP_BLOCK.test(key)) return key
  }
  return undefined
}

/**
 * A conservative IP-literal test standing in for `netaddr.IPAddress` (`:257`, divergence 9 / DR-110):
 * a full IPv4 dotted quad (each octet 0-255, no padding beyond 3 digits) or an IPv6 address in colon
 * notation (one `::` compression, up to eight hextets of ≤4 hex digits — embedded IPv4 tails and
 * zone ids are NOT accepted, and neither are netaddr's partial-dotted / decimal-integer / hex forms,
 * all of which read here as ordinary group names).
 */
function isIpAddressLiteral(value: string): boolean {
  const ipv4 = /^(\d{1,3})(?:\.(\d{1,3})){3}$/u.exec(value)
  if (ipv4 !== null) {
    return (ipv4.slice(1) as string[]).every((octet) => octet !== undefined && Number(octet) <= 255)
  }
  if (!value.includes(':')) return false
  // IPv6: at most one `::`, groups of 1-4 hex digits, and the two sides must not OVERFLOW eight
  // groups. `::` alone is the unspecified address, valid for netaddr. Leading/trailing `:` pairs that
  // would make the split start/end with empty groups are structural parts of `::`, not defects.
  const halves = value.split('::')
  if (halves.length > 2) return false
  const hextets = (side: string): string[] => (side === '' ? [] : side.split(':'))
  const check = (groups: readonly string[]): boolean =>
    groups.every((group) => /^[0-9a-fA-F]{1,4}$/u.test(group))
  if (halves.length === 2) {
    const head = hextets(halves[0] as string)
    const tail = hextets(halves[1] as string)
    return check(head) && check(tail) && head.length + tail.length <= 7
  }
  const groups = hextets(value)
  return groups.length === 8 && check(groups)
}

/** Mutable while the neighbour table is being assembled from body lines — a writable projection of {@link BgpNeighbor} (the public interface itself stays `readonly`). */
type MutableNeighbor = {
  name: string
  peerGroup?: string
  peerGroupForm?: PeerGroupForm
  remoteAs?: string
  description?: string
  sendCommunity: boolean
  nextHopSelf: boolean
  shutdown: boolean
  routeMapIn?: string
  routeMapOut?: string
}

/** One `neighbor …` body line, parsed to a keyword group; `negated` covers upstream's `no` prefix (whose regexes match THROUGH it — divergence 7 stops the value from voting but keeps the name). */
const NEIGHBOR_LINE = /^(no )?neighbor (\S+)(?: (\S.*))?$/u

/** The per-verb keyword groups the eight upstream parsers stand for (`:207-254`), now at line scope. */
const PEER_GROUP_MODERN_MEMBERSHIP = /^peer group (\S+)$/u
const PEER_GROUP_LEGACY_MEMBERSHIP = /^peer-group (\S+)$/u
const REMOTE_AS_REST = /^remote-as (\S.*)$/u
const DESCRIPTION_REST = /^description(?: (.*))?$/u
const ROUTE_MAP_LINE = /^route-map (\S+) (in|out)$/u

/**
 * The whole neighbour table from ONE block's body lines — pyeapi's per-name regex passes (`:184-254`)
 * fused into one scan (divergence 7/DR-030). Names appear for any `neighbor …`/`no neighbor …` line
 * (upstream's `getall` keys exactly those, `:203`); fields only from POSITIVE lines with the right
 * shape; the `send-community`/`next-hop-self` DERIVATIONS key off the negated lines, because that is
 * literally what upstream's substring probes read (`:221-225`, `:238-242`).
 */
function neighborsFromBody(body: readonly { text: string }[]): Map<string, MutableNeighbor> {
  const neighbors = new Map<string, MutableNeighbor>()
  const draftFor = (name: string): MutableNeighbor => {
    let draft = neighbors.get(name)
    if (draft === undefined) {
      draft = { name, sendCommunity: true, nextHopSelf: true, shutdown: false }
      neighbors.set(name, draft)
    }
    return draft
  }
  for (const line of body) {
    const found = NEIGHBOR_LINE.exec(line.text)
    if (found === null) continue
    const negated = found[1] !== undefined
    const name = found[2] as string
    const rest = found[3]
    const draft = draftFor(name)
    if (rest === undefined) continue // a line reading just `neighbor X` mentions the name, nothing else
    const modern = PEER_GROUP_MODERN_MEMBERSHIP.exec(rest)
    const legacy = PEER_GROUP_LEGACY_MEMBERSHIP.exec(rest)
    if (modern?.[1] !== undefined || legacy?.[1] !== undefined) {
      // Upstream reports the value THROUGH the negation (`no neighbor X peer-group Y` reads Y,
      // `:211`-search-anywhere); a negation names the neighbour but sets nothing here (divergence 7).
      if (!negated) {
        draft.peerGroup = (modern?.[1] ?? legacy?.[1]) as string
        draft.peerGroupForm = modern?.[1] !== undefined ? 'peer group' : 'peer-group'
      }
      continue
    }
    if (rest === 'peer group' || rest === 'peer-group') continue // a bare group DECLARATION: name kept, no membership value — upstream reads None (`:211-214`)
    const remote = REMOTE_AS_REST.exec(rest)
    if (remote !== null) {
      if (!negated) draft.remoteAs = remote[1] as string // a bare `remote-as` line answers '' upstream — absence here (divergence 7 family)
      continue
    }
    const description = DESCRIPTION_REST.exec(rest)
    if (description !== null) {
      if (!negated && description[1] !== undefined && description[1] !== '') draft.description = description[1] as string
      continue
    }
    if (/^send-community(\s|$)/u.test(rest)) {
      if (negated) draft.sendCommunity = false
      continue
    }
    // THE bare knob line votes; everything else this device hangs off `next-hop-self` is a SUB-FEATURE.
    // The executed corpus (run 7, 2026-11-08) showed the default body renders
    // `no neighbor X next-hop-self receive-only`, `… source-interface`, `… received-evpn-routes route-type
    // ip-prefix [inter-domain]` as standing negative lines — negation-anchored on the wrong half of a
    // compound name, they once voted nextHopSelf false even after a successful positive write. Only
    // `next-hop-self` alone (with or without `no `) is this client's `nextHopSelf`; the sub-modes stay
    // unmodelled, like upstream's eight parsers leave them (a §3 hardware-sweep candidate if ever typed).
    if (rest === 'next-hop-self') {
      draft.nextHopSelf = !negated
      continue
    }
    if (rest.startsWith('next-hop-self ')) continue
    if (rest === 'shutdown') {
      if (!negated) draft.shutdown = true // upstream's `(?<!no )` lookbehind (`:228`) does the same bookkeeping
      continue
    }
    const routeMap = ROUTE_MAP_LINE.exec(rest)
    if (routeMap !== null) {
      if (!negated) {
        if (routeMap[2] === 'in') draft.routeMapIn = routeMap[1] as string
        else draft.routeMapOut = routeMap[1] as string
      }
      continue
    }
    // Any other neighbour verb (`maximum-routes …`, `ttl …`, …) mentions the name and stays
    // unmodelled — upstream's eight parsers likewise report None for it.
  }
  return neighbors
}

/**
 * `node.bgp` — the BGP router configuration of one switch. pyeapi's `Bgp(Entity)` (`:47`): a single
 * entity (NOT an EntityCollection — one matching `router bgp …` section per read, per the ospf
 * module's divergence-7 note about upstream's first-match block lookups), with the neighbours
 * hanging off it as a sub-collection exactly like `varp` hangs `interfaces` off `Varp`.
 */
export class BgpResource extends Entity<BgpState | undefined> {
  private readonly neighborsResource: BgpNeighborsResource

  constructor(node: Node) {
    super(node)
    // pyeapi's lazy `_neighbors` memo (`:51-54`, `:55-60`): the registry already memoises this
    // instance per Node (DR-052), so one child built in the constructor answers `neighbors
    // === neighbors` with no lazy branch — the varp.ts:355-361 precedent.
    this.neighborsResource = new BgpNeighborsResource(node)
  }

  /** The per-neighbour view — pyeapi's `neighbors` **property** (`:55-60`), read and written through {@link BgpNeighborsResource}. */
  get neighbors(): BgpNeighborsResource {
    return this.neighborsResource
  }

  /**
   * The router record, or `undefined` when this switch runs no BGP process — pyeapi's `get()`
   * (`:62-78`), one config read for the WHOLE record including the neighbour table (DR-030,
   * pinned; upstream re-reads per neighbour name at `:204-205` — and its `configure_bgp` pays that
   * full parse as a side effect of opening a submode, `:109`).
   */
  override async get(): Promise<BgpState | undefined> {
    const sections = await this.configSections()
    const key = findRouterBgpSection(sections)
    if (key === undefined) return undefined
    const text = sections.get(key)
    if (text === undefined) throw new NotFoundError(`bgp: section ${pythonRepr(key)} vanished from the chunked config`)
    const block = parseBlock(text)
    const header = BGP_HEADER_AS.exec(block.header)
    if (header?.[1] === undefined) {
      // Unreachable while findRouterBgpSection owns the pattern — loud instead of silent (the vrfs
      // divergence-2 family): an unparseable header must not answer a half-record.
      throw new ConfigParseError(`bgp: the section header ${pythonRepr(block.header)} has no remainder to name an AS`, { sectionKey: block.header })
    }
    const asText = header[1]
    const maxLine = block.body.find((line) => MAX_PATHS_LINE.test(line.text))
    const pair = maxLine === undefined ? null : MAX_PATHS_LINE.exec(maxLine.text)
    const networks = readNetworks(block.body)
    // Upstream always emits the key with a None value (:87 → :88's dict); exactOptionalPropertyTypes
    // wants the whole key absent instead — the same fold every wave-1/2 module uses (DR-029 family).
    const routerId = valueAfterKeyword(block.body, 'router-id')
    const state: BgpState = {
      bgpAs: /^\d+$/u.test(asText) ? Number(asText) : asText, // divergence 2 (`isnumeric`, `:83`) — ASCII digits only, narrowing noted
      ...(routerId === undefined ? {} : { routerId }),
      ...(pair === null || pair[1] === undefined || pair[2] === undefined
        ? {}
        : { maximumPaths: Number(pair[1]), maximumEcmpPaths: Number(pair[2]) }),
      shutdown: !block.body.some((line) => line.text === NO_SHUTDOWN),
      networks,
      neighbors: await this.neighborsResource.getAll(),
    }
    return state
  }

  /**
   * `router bgp <as>` — pyeapi's `create` (`:114-120`), pinned at `test_api_bgp.py:56-62` for both
   * the string and the number spelling; zero reads, exactly like upstream (this verb never touches
   * `get()`). The range guard refuses 66000 both ways (`test_create_invalid_as`, `:63-67`), as
   * `ValueError` upstream → the taxonomy's refusal here (DR-005/DR-010).
   */
  async create(bgpAs: string | number): Promise<void> {
    assertBgpAsInput(bgpAs)
    await this.configure([`router bgp ${digitText(bgpAs)}`])
  }

  /**
   * `no router bgp <bgpAs>` — pyeapi's `delete` (`:121-127`): reads first and removes **with the
   * as-read value**, i.e. including a non-numeric header remainder (divergence 2/3 pinned in the
   * spec); resolves with no command when there is no process (upstream's `return True`, `:123-125`).
   */
  async delete(): Promise<void> {
    const current = await this.getBgpAsText()
    if (current === undefined) return
    await this.configure([`no router bgp ${current}`])
  }

  /** `default router bgp <bgpAs>` — pyeapi's bare `default()` (`:128-134`) under the framework's verb naming (row 77), pinned at `test_api_bgp.py:73-77`. Same as-read-value opening, same no-op when absent. */
  async setDefault(): Promise<void> {
    const current = await this.getBgpAsText()
    if (current === undefined) return
    await this.configure([`default router bgp ${current}`])
  }

  /** `router-id <value>` inside the process — `set_router_id(value=…)` (`:135-139`, config arm pinned `test_api_bgp.py:100-110`). */
  async setRouterId(value: string): Promise<void> {
    assertValueToken('bgp router-id', value) // upstream's reader is `router-id ([^\s]+)` (`:86`) — token grammar
    await this.configureBgp(this.commandBuilder('router-id', { value }))
  }

  /** `no router-id` — upstream spells this `set_router_id(None, False, True)` (`test_api_bgp.py:111-113`) and ALSO answers `no router-id` for a fully-defaulted call through the deprecated falsy fall-through (`test_api_bgp.py:117-121`, the "uncomment when command_builder raises" block beside it). DR-037: the negation is a verb, and the fall-through is a refusal (checked in command-builder.test.ts). */
  async unsetRouterId(): Promise<void> {
    await this.configureBgp(this.commandBuilder('router-id', { mode: 'no' }))
  }

  /** `default router-id` — the `default=True` arm (`test_api_bgp.py:114-116`). */
  async defaultRouterId(): Promise<void> {
    await this.configureBgp(this.commandBuilder('router-id', { mode: 'default' }))
  }

  /**
   * `maximum-paths <n>[ ecmp <m>]` — `set_maximum_paths` (`:140-153`). The third and fourth
   * positional slots upstream takes are `default`/`disable` (`:140-141`) — NOT an
   * "all-path-list" kwarg some dispatch notes claimed (reported upward: no such parameter exists at
   * `6816d9e`). Upstream's own guard (`:142-144`) refuses ecmp without max — kept as a refusal;
   * the truthiness composition at `:147-150` means upstream ALSO drops an ecmp `0` silently and
   * NEGATES a max `0` into `no maximum-paths`: this client composes literal 0s where the reader can
   * bring them back (`maximum-paths (\d+) ecmp (\d+)` matches `0`), pinned at both arms (the mlag
   * divergence-6 family, DR-037).
   */
  async setMaximumPaths(maxPaths?: string | number, maxEcmpPaths?: string | number): Promise<void> {
    if (maxPaths === undefined && maxEcmpPaths !== undefined) {
      refuse('bgp maximum-ecmp-paths', maxEcmpPaths, 'cannot use maximum_ecmp_paths without providing max_path — verbatim upstream guard (bgp.py:142-144, raised TypeError there; test_api_bgp.py:162-163 pins it)')
    }
    if (maxPaths === undefined) {
      // Upstream composes NOTHING (value stays None → falsy fall-through → `no maximum-paths`,
      // pinned by test_api_bgp.py:140-144). Here that call shape is the negation verb.
      await this.unsetMaximumPaths()
      return
    }
    assertDigits('bgp maximum-paths', maxPaths)
    let value = digitText(maxPaths)
    if (maxEcmpPaths !== undefined) {
      assertDigits('bgp maximum-ecmp-paths', maxEcmpPaths)
      value += ` ecmp ${digitText(maxEcmpPaths)}`
    }
    await this.configureBgp(this.commandBuilder('maximum-paths', { value }))
  }

  /** `no maximum-paths` — upstream's `set_maximum_paths(disable=True)` arm (`test_api_bgp.py:133-134`) and the falsy-fall-through answer for a fully-defaulted call (`:140-144`). */
  async unsetMaximumPaths(): Promise<void> {
    await this.configureBgp(this.commandBuilder('maximum-paths', { mode: 'no' }))
  }

  /** `default maximum-paths` — the `default=True` arm (`test_api_bgp.py:136-138`). */
  async defaultMaximumPaths(): Promise<void> {
    await this.configureBgp(this.commandBuilder('maximum-paths', { mode: 'default' }))
  }

  /**
   * Bare `shutdown` — upstream gets there only via `set_shutdown(default=False, disable=False)`
   * (`test_api_bgp.py:165-184`'s config arm), because this module's `set_shutdown` parameter DEFAULTS
   * are `default=False, disable=True` (`:154-156`) — i.e. the INVERTED defaults this repo flagged:
   * the NO-ARGUMENT call is `noShutdown()`, not `shutdown()`. Pin below; compare `mlag.ts:255`, which
   * shares the inverted default, and `ospf.py:185`, whose separate methods take no flags at all.
   */
  async shutdown(): Promise<void> {
    await this.configureBgp(this.commandBuilder('shutdown', { value: true }))
  }

  /** `no shutdown` — upstream's ZERO-ARGUMENT `set_shutdown()` (the `disable=True` parameter default, `:154`), pinned at `test_api_bgp.py:171-173`. */
  async noShutdown(): Promise<void> {
    await this.configureBgp(this.commandBuilder('shutdown', { mode: 'no' }))
  }

  /** `default shutdown` — the `default=True` arm (`test_api_bgp.py:175-177`). */
  async defaultShutdown(): Promise<void> {
    await this.configureBgp(this.commandBuilder('shutdown', { mode: 'default' }))
  }

  /**
   * `network <prefix>/<len>[ route-map <name>]` — `add_network` (`:163-171`), pinned WITH the
   * route-map at `test_api_bgp.py:78-83`. Upstream's empty check (`:165-166`) is the guard's floor;
   * the token/digit guards (DR-053 pattern) match this module's readers (`(.+)/(\d+)`, `:101`), and
   * route-map NAMES may run past `\w` on the write side even though `_parse_networks` reads those
   * back TRUNCATED at the first non-word character (divergence 6, pinned as an honest asymmetry).
   */
  async addNetwork(prefix: string, length: string | number, routeMapName?: string): Promise<void> {
    assertNetworkArgs(prefix, length)
    if (routeMapName !== undefined) assertValueToken('bgp route-map name', routeMapName)
    await this.configureBgp(`network ${prefix}/${digitText(length)}${routeMapName === undefined ? '' : ` route-map ${routeMapName}`}`)
  }

  /** `no network <prefix>/<len>[ route-map <name>]` — `remove_network` (`:172-181`), pinned WITH the route-map at `test_api_bgp.py:89-94`: the negation KEEPS the route-map arm upstream-side, unlike ospf's redistribution negation (module divergence 10 over there). */
  async removeNetwork(prefix: string, length: string | number, routeMapName?: string): Promise<void> {
    assertNetworkArgs(prefix, length)
    if (routeMapName !== undefined) assertValueToken('bgp route-map name', routeMapName)
    await this.configureBgp(`no network ${prefix}/${digitText(length)}${routeMapName === undefined ? '' : ` route-map ${routeMapName}`}`)
  }

  /**
   * The AS text the ENTITY half composes openers with — `_parse_bgp_as`'s value (`:80-83`), header
   * remainder and all (divergences 2/3). `undefined` when there is no `router bgp` section: upstream
   * then crashes on `None['bgp_as']` (`TypeError`, `:110-112` for `configure_bgp`; `delete`/`default`
   * short-circuit to `True`, `:123-125`/`:130-132` — which is why only the write verbs raise here).
   */
  private async getBgpAsText(): Promise<BgpState['bgpAs'] | undefined> {
    const sections = await this.configSections()
    const key = findRouterBgpSection(sections)
    if (key === undefined) return undefined
    const header = BGP_HEADER_AS.exec(key) // the chunk key IS the header line (chunk.ts), so no block parse is needed for the AS
    const asText = header?.[1]
    if (asText === undefined) {
      throw new ConfigParseError(`bgp: the section header ${pythonRepr(key)} has no remainder to name an AS`, { sectionKey: key })
    }
    return /^\d+$/u.test(asText) ? Number(asText) : asText
  }

  /** The shared entity-write transaction — `configure_bgp` (`:108-113`) with the opener text from {@link getBgpAsText}. Upstream runs the FULL `get()` first (`:109`), which also parses every neighbour (`:77`) — this client needs only the header the same config read already carries (DR-030's read budget; the neighbour-table pin measures it). */
  private async configureBgp(commands: CommandInput): Promise<void> {
    const current = await this.getBgpAsText()
    if (current === undefined) {
      throw new NotFoundError(
        'bgp is not configured — this switch has no `router bgp …` section. create() a process first (pyeapi reaches None[\'bgp_as\'] for these verbs, a TypeError at bgp.py:110-112, and its neighbours half raises the loud one, ValueError(\'bgp is not configured\'), at bgp.py:276-281)',
      )
    }
    await this.configure(submodeCommands(`router bgp ${String(current)}`, commands))
  }
}

/** Upstream's `_parse_networks` scan (`:99-107`) at body-line scope; the `'' → None` route_map fold is kept (`:103`). */
function readNetworks(body: readonly { text: string }[]): BgpNetwork[] {
  const networks: BgpNetwork[] = []
  for (const line of body) {
    const found = BGP_NETWORK_LINE.exec(line.text)
    if (found === null) continue
    const routeMap = found[3]
    networks.push({
      prefix: found[1] as string,
      masklen: found[2] as string,
      ...(routeMap === undefined || routeMap === '' ? {} : { routeMap }),
    })
  }
  return networks
}

/** The add/remove-network empty check upstream performs verbatim (`:165-166`, `:174-175`) plus the reader-grammar widening. */
function assertNetworkArgs(prefix: unknown, length: unknown): void {
  if (prefix === '' || length === '') {
    refuse('bgp network', prefix === '' ? prefix : length, 'network prefix and length values may not be empty — pyeapi checks exactly this ValueError pair (bgp.py:165-166, :174-175); clear a network with removeNetwork(), never an empty argument (DR-037)')
  }
  if (typeof prefix !== 'string' || /\s/u.test(prefix) || hasControlCharacter(prefix)) {
    refuse('bgp network prefix', prefix, 'expected a single token the reader can re-capture (`network (.+)/…`, bgp.py:101) — pyeapi only checks the empty string and interpolates anything else')
  }
  assertDigits('bgp network length', length)
}

/**
 * `node.bgp.neighbors` — the per-neighbour view, pyeapi's `BgpNeighbors(EntityCollection)` (`:182`).
 * NOT a registry row: it is reached through the entity (the `varp`/`acls`/`stp` sub-object precedent,
 * DR-068's surface rule), and that is also how upstream builds it (`:55-60`'s property memo).
 *
 * Upstream's `get(name)`/`getall()`/`create(name)`/`delete(name)` are the base collection verbs plus
 * this class's own wiring; there is NO `default` verb — the inherited one raises `NotImplementedError`
 * (`abstract.py:208-224`), and {@link setDefault} below refuses rather than inventing a command
 * (the stp `StpInstancesResource` precedent).
 */
export class BgpNeighborsResource extends EntityCollection<BgpNeighbor, string, Record<string, never>> {
  /** Latched like `VrfsResource`'s form (DR-099's shape): the keyword spelling the device's own block speaks (divergence 8, DR-107). */
  private peerGroupForm: PeerGroupForm | undefined

  /**
   * Every neighbour the FIRST `router bgp …` section mentions, keyed by name in device order —
   * pyeapi's `getall()` (`:197-205`) as a `ResourceTable` (row 78) in ONE pass over one read
   * (DR-030, pinned; upstream pays a `get_block` scan per name). Upstream answers `None` for a
   * missing block (`:198-200`); the table is simply empty here (divergence 1).
   */
  override async getAll(): Promise<ResourceTable<string, BgpNeighbor>> {
    return neighborsFromSections(await this.configSections())
  }

  /**
   * One neighbour, or `undefined` — pyeapi's `get(name)` (`:184-196`) minus the all-`None` phantom
   * record (divergence 1: an absent neighbour is absence, DR-027's family). Upstream answers a
   * full-keyed record for ANY name, even one the block never mentions.
   */
  override async get(name: string): Promise<BgpNeighbor | undefined> {
    assertNeighborName(name)
    return (await this.getAll()).get(name)
  }

  /**
   * pyeapi's `create(name)` (`:262-264`) — and that is the WHOLE story: it literally calls
   * `self.set_shutdown(name, default=False, disable=False)`, so it composes the BARE
   * `neighbor <name> shutdown` (divergence 10, DR-109). Read that text as what it does: it mentions
   * the neighbour AND sets it administratively DOWN. There is no `neighbor X` declaration-only line
   * in this port because upstream has none, and the operator intent "bring this peer UP" is
   * {@link unsetShutdown} — upstream's own zero-argument default (`:303`'s `disable=True`). Pinned
   * faithfully with the exact wire text; NOT "fixed", because silently re-pointing a migration at a
   * different EOS effect than the ported library performs is the worse failure.
   */
  override async create(name: string): Promise<void> {
    await this.setShutdown(name)
  }

  /**
   * `no neighbor <name>`, with pyeapi's group-keyword fallback (`:265-275`): when the bare negation
   * is refused by the DEVICE, upstream retries `no neighbor X peer group` (≥4.23) /
   * `no neighbor X peer-group`. Here the retry triggers on the real `CommandError` that replaced the
   * swallowed-`False` idiom (DR-005), uses the detected spelling (divergence 8), and lets a second
   * refusal propagate (divergence 11: upstream would `return False`; this taxonomy has no silent
   * answer). Non-`CommandError` failures (auth/connect/TLS) do NOT retry — they are not command
   * refusals, and a second blind write behind a failed transport is exactly what this client never
   * does (ARCHITECTURE §2's send discipline stays with the `Node`).
   */
  override async delete(name: string): Promise<void> {
    try {
      await this.configureNeighbor(name, `no neighbor ${name}`)
    } catch (error) {
      if (!(error instanceof CommandError)) throw error
      const form = await this.resolvePeerGroupForm()
      await this.configureNeighbor(name, `no neighbor ${name} ${form}`)
    }
  }

  /** Refused: there is no entry-level `default neighbor …` verb upstream — `BgpNeighbors` never overrides `EntityCollection`'s inherited stub (`abstract.py:208-224` raises `NotImplementedError`), and inventing a command is not on this migration's menu (the stp `StpInstancesResource` precedent; pinned refusal). */
  override async setDefault(name: string): Promise<void> {
    refuse('bgp neighbor setDefault', name, 'no `default neighbor …` verb exists upstream (bgp.py:182-338 implements none; EntityCollection.default is an inherited NotImplementedError stub, abstract.py:208-224) — per-field defaults live on the named verbs (defaultShutdown, defaultRemoteAs, …)')
  }

  /**
   * The pyeapi polarity (`:255-261`): TRUE when `name` does NOT parse as an address (i.e. it is
   * group-shaped), FALSE when it does. The netaddr dependency is not ported (divergence 9/DR-110):
   * the check is a conservative IPv4-dotted-quad / IPv6-colon literal test, so netaddr's exotic
   * accepted forms (`'1.2.3'` partial, decimal/hex integers) read as group names HERE while
   * upstream read them as addresses.
   */
  isPeerGroup(name: string): boolean {
    assertNeighborName(name)
    return !isIpAddressLiteral(name)
  }

  /**
   * `neighbor <ip> <peer-group-keyword> <group>` — pyeapi's `set_peer_group` (`:288-298`). The gate
   * (`:290`, `if not self.ispeergroup(name)`) means ONLY address-named neighbours can join a group;
   * upstream answers a silent `False` for a group-shaped name (`:298`), which here is a refusal —
   * deliberate widening, pinned at zero round trips (divergence 12, COMMON's "widen with an
   * asserted refusal" allowance). The keyword spelling is the detected one (divergence 8); upstream's
   * tests pin the legacy `peer-group` texts because its fake node lies about the version
   * (`test/lib/testlib.py:75`'s `'4.17.1.1'`), and this suite pins the SAME texts from the legacy
   * form plus the modern form from a modern-spelling config.
   */
  async setPeerGroup(name: string, peerGroup: string): Promise<void> {
    assertNeighborName(name)
    assertValueToken('bgp peer-group name', peerGroup)
    this.requireAddressName(name)
    const form = await this.resolvePeerGroupForm()
    await this.configureNeighbor(name, this.commandBuilder(`neighbor ${name} ${form}`, { value: peerGroup }))
  }

  /** `no neighbor <ip> peer-group|peer group` — upstream's `disable=True` arm (`:292-296`, pinned `test_api_bgp.py:215-217`) with the same keyword detection, and the same address-only gate. */
  async unsetPeerGroup(name: string): Promise<void> {
    assertNeighborName(name)
    this.requireAddressName(name)
    const form = await this.resolvePeerGroupForm()
    await this.configureNeighbor(name, this.commandBuilder(`neighbor ${name} ${form}`, { mode: 'no' }))
  }

  /** `default neighbor <ip> peer-group|peer group` — the `default=True` arm (`test_api_bgp.py:219-223`; upstream's third positional slot is `default`, and its test passes the value WITH it — default preempts, `abstract.py:152-153`). Same address-only gate (`set_peer_group` is the whole arm, `bgp.py:292-296`). */
  async defaultPeerGroup(name: string): Promise<void> {
    assertNeighborName(name)
    this.requireAddressName(name)
    const form = await this.resolvePeerGroupForm()
    await this.configureNeighbor(name, this.commandBuilder(`neighbor ${name} ${form}`, { mode: 'default' }))
  }

  /**
   * `neighbor <name> remote-as <value>` — `set_remote_as` (`:299-302`), pinned at
   * `test_api_bgp.py:229-253` with the value as the STRING '65000' (the reader keeps `.*` remainders,
   * `:218`, so a number normalizes but a multi-word remainder like `internal` rides). Upstream
   * applies NO ispeergroup gate here — every name shape is valid for remote-as (its own tests use
   * the group-shaped name 'test') — kept.
   */
  async setRemoteAs(name: string, value: string | number): Promise<void> {
    assertNeighborName(name)
    assertRemainderValue('bgp remote-as', value)
    await this.configureNeighbor(name, this.commandBuilder(`neighbor ${name} remote-as`, { value }))
  }

  /** `no neighbor <name> remote-as` — the `disable=True` arm (`test_api_bgp.py:237-242`), and what upstream's value-None fall-through also produced (`:248-252`, the pre-armed comment). DR-037. */
  async unsetRemoteAs(name: string): Promise<void> {
    assertNeighborName(name)
    await this.configureNeighbor(name, this.commandBuilder(`neighbor ${name} remote-as`, { mode: 'no' }))
  }

  /** `default neighbor <name> remote-as` — the `default=True` arm (`test_api_bgp.py:243-246`). */
  async defaultRemoteAs(name: string): Promise<void> {
    assertNeighborName(name)
    await this.configureNeighbor(name, this.commandBuilder(`neighbor ${name} remote-as`, { mode: 'default' }))
  }

  /**
   * Bare `neighbor <name> shutdown` — upstream's `set_shutdown(name, default=False, disable=False)`
   * arm (`test_api_bgp.py:254-272`'s 'config' state) AND the exact text {@link create} emits
   * (`:262-264`). This method's own parameter defaults on upstream (`:303`, `disable=True`) make the
   * ZERO-ARGUMENT call the negation — so the no-argument intent here is {@link unsetShutdown}
   * (the inverted-default family: bgp entity AND bgp neighbours both invert; ospf has no flags).
   */
  async setShutdown(name: string): Promise<void> {
    assertNeighborName(name)
    await this.configureNeighbor(name, this.commandBuilder(`neighbor ${name} shutdown`, { value: true }))
  }

  /** `no neighbor <name> shutdown` — upstream's zero-argument default arm (`:303`'s `disable=True`), pinned twice in its own suite (`test_api_bgp.py:254-272`: the 'negate' AND 'false' states are the same text). */
  async unsetShutdown(name: string): Promise<void> {
    assertNeighborName(name)
    await this.configureNeighbor(name, this.commandBuilder(`neighbor ${name} shutdown`, { mode: 'no' }))
  }

  /** `default neighbor <name> shutdown` — the `default=True` arm (`test_api_bgp.py:265-269`). */
  async defaultShutdown(name: string): Promise<void> {
    assertNeighborName(name)
    await this.configureNeighbor(name, this.commandBuilder(`neighbor ${name} shutdown`, { mode: 'default' }))
  }

  /**
   * `neighbor <name> send-community[ <value>]` — `set_send_community` (`:311-316`). The upstream
   * suite's config arm passes `value=True` (the bare command, `test_api_bgp.py:276-281`); a token
   * like `both`/`ipv4`/`ipv6` rides the same builder (the boolean READ at `:221-225` only ever
   * probes the negation, so any positive spelling reads true).
   */
  async setSendCommunity(name: string, value: CommandValue = true): Promise<void> {
    assertNeighborName(name)
    if (typeof value === 'string') assertValueToken('bgp send-community value', value)
    await this.configureNeighbor(name, this.commandBuilder(`neighbor ${name} send-community`, { value }))
  }

  /**
   * `no neighbor <name> send-community` — the negate arm (`test_api_bgp.py:283-287`) and upstream's
   * value-None fall-through answer (`:293-298`). The upstream 'default' state oddly passes
   * `value=False, default=True` (`:288-291`) — default preempts, and that is what
   * {@link defaultSendCommunity} sends: no falsy value ever changes an explicitly-modeled command
   * (DR-037's precedence, pinned in command-builder.test.ts).
   */
  async unsetSendCommunity(name: string): Promise<void> {
    assertNeighborName(name)
    await this.configureNeighbor(name, this.commandBuilder(`neighbor ${name} send-community`, { mode: 'no' }))
  }

  /** `default neighbor <name> send-community` — the `default=True` arm (`test_api_bgp.py:288-291`). */
  async defaultSendCommunity(name: string): Promise<void> {
    assertNeighborName(name)
    await this.configureNeighbor(name, this.commandBuilder(`neighbor ${name} send-community`, { mode: 'default' }))
  }

  /** `neighbor <name> next-hop-self[ <value>]` — `set_next_hop_self` (`:317-322`), pinned like send-community at `test_api_bgp.py:299-324`. */
  async setNextHopSelf(name: string, value: CommandValue = true): Promise<void> {
    assertNeighborName(name)
    if (typeof value === 'string') assertValueToken('bgp next-hop-self value', value)
    await this.configureNeighbor(name, this.commandBuilder(`neighbor ${name} next-hop-self`, { value }))
  }

  /** `no neighbor <name> next-hop-self` — the negate arm (`test_api_bgp.py:306-311`). */
  async unsetNextHopSelf(name: string): Promise<void> {
    assertNeighborName(name)
    await this.configureNeighbor(name, this.commandBuilder(`neighbor ${name} next-hop-self`, { mode: 'no' }))
  }

  /** `default neighbor <name> next-hop-self` — the `default=True` arm, upstream again with the throwaway `value=False` (`test_api_bgp.py:312-317`; DR-037 precedence makes the value irrelevant). */
  async defaultNextHopSelf(name: string): Promise<void> {
    assertNeighborName(name)
    await this.configureNeighbor(name, this.commandBuilder(`neighbor ${name} next-hop-self`, { mode: 'default' }))
  }

  /**
   * `neighbor <name> route-map <value> in` — `set_route_map_in` (`:323-327`), pinned at
   * `test_api_bgp.py:325-350`. Upstream appends `' in'` to the BUILT command, i.e. after the
   * `no`/`default` prefix too (`:324-326`) — so the negate is `no neighbor X route-map in` and the
   * default is `default neighbor X route-map in`. Kept verbatim (pinned); the suffix-after-builder
   * order is exactly what the `command_builder` override at `:283-287` enables — and the override
   * changes NOTHING ELSE (it only prefixes the stem, so M7's builder semantics carry over: the
   * brief's "read what it changes" answer).
   */
  async setRouteMapIn(name: string, routeMap: string): Promise<void> {
    assertNeighborName(name)
    assertValueToken('bgp route-map name', routeMap)
    await this.configureNeighbor(name, `${this.commandBuilder(`neighbor ${name} route-map`, { value: routeMap })} in`)
  }

  /** `no neighbor <name> route-map in` — the negate arm (`test_api_bgp.py:331-335`), the suffix riding OUTSIDE the `no` prefix (pinned). Upstream's value-None fall-through (`:345-350`) produced this same text. */
  async unsetRouteMapIn(name: string): Promise<void> {
    assertNeighborName(name)
    await this.configureNeighbor(name, `${this.commandBuilder(`neighbor ${name} route-map`, { mode: 'no' })} in`)
  }

  /** `default neighbor <name> route-map in` — the `default=True` arm (`test_api_bgp.py:336-340`). */
  async defaultRouteMapIn(name: string): Promise<void> {
    assertNeighborName(name)
    await this.configureNeighbor(name, `${this.commandBuilder(`neighbor ${name} route-map`, { mode: 'default' })} in`)
  }

  /** `neighbor <name> route-map <value> out` — `set_route_map_out` (`:328-333`), pinned at `test_api_bgp.py:351-376`. */
  async setRouteMapOut(name: string, routeMap: string): Promise<void> {
    assertNeighborName(name)
    assertValueToken('bgp route-map name', routeMap)
    await this.configureNeighbor(name, `${this.commandBuilder(`neighbor ${name} route-map`, { value: routeMap })} out`)
  }

  /** `no neighbor <name> route-map out` — the negate arm (`test_api_bgp.py:357-361`). */
  async unsetRouteMapOut(name: string): Promise<void> {
    assertNeighborName(name)
    await this.configureNeighbor(name, `${this.commandBuilder(`neighbor ${name} route-map`, { mode: 'no' })} out`)
  }

  /** `default neighbor <name> route-map out` — the `default=True` arm (`test_api_bgp.py:362-366`). */
  async defaultRouteMapOut(name: string): Promise<void> {
    assertNeighborName(name)
    await this.configureNeighbor(name, `${this.commandBuilder(`neighbor ${name} route-map`, { mode: 'default' })} out`)
  }

  /**
   * `neighbor <name> description <value>` — `set_description` (`:334-338`), pinned at
   * `test_api_bgp.py:377-391` with a THREE-WORD value (`'this is a test'` next to `:379`): inner
   * spaces ride, because the READ keeps the whole line remainder (`:234`'s `(.*)$`, mirrored by
   * this module's description parser). Outer whitespace/control characters cannot read back, and
   * clearing is {@link unsetDescription} (DR-037).
   */
  async setDescription(name: string, value: string): Promise<void> {
    assertNeighborName(name)
    assertRemainderValue('bgp neighbor description', value)
    await this.configureNeighbor(name, this.commandBuilder(`neighbor ${name} description`, { value }))
  }

  /** `no neighbor <name> description` — the negate arm (`test_api_bgp.py:382-387`). */
  async unsetDescription(name: string): Promise<void> {
    assertNeighborName(name)
    await this.configureNeighbor(name, this.commandBuilder(`neighbor ${name} description`, { mode: 'no' }))
  }

  /** `default neighbor <name> description` — the `default=True` arm, with upstream's ignored value alongside (`test_api_bgp.py:388-391`). */
  async defaultDescription(name: string): Promise<void> {
    assertNeighborName(name)
    await this.configureNeighbor(name, this.commandBuilder(`neighbor ${name} description`, { mode: 'default' }))
  }

  /**
   * The neighbours-half transaction — pyeapi's `configure(cmd)` override (`:276-282`): the opener is
   * the first `router bgp <digits>` SECTION (upstream searches the raw whole-config TEXT, so a phrase
   * in a banner could anchor it — this port keys off chunk headers, divergence 7), and "bgp is not
   * configured" keeps upstream's own text while its `ValueError` becomes the taxonomy's
   * {@link NotFoundError} (DR-005/DR-010; the message names both halves' behaviours).
   */
  private async configureNeighbor(name: string, command: string): Promise<void> {
    assertNeighborName(name)
    const sections = await this.configSections()
    const key = findRouterBgpSection(sections)
    const digits = key === undefined ? undefined : BGP_HEADER_DIGITS.exec(key)?.[1]
    if (digits === undefined) {
      throw new NotFoundError(
        'bgp is not configured — no `router bgp <digits>` section exists to enter (pyeapi\'s BgpNeighbors.configure raises ValueError with this very text at bgp.py:276-281; its search runs over raw config TEXT, so it can also lock onto a `router bgp 123` PHRASE — chunk keys cannot, divergence 7)',
      )
    }
    await this.configure(submodeCommands(`router bgp ${digits}`, [command]))
  }

  /** The peer-group trio's shared gate — divergence 12's refusal, worded at the call site. */
  private requireAddressName(name: string): void {
    if (isIpAddressLiteral(name)) return
    refuse('bgp peer-group target', name, `neighbor ${pythonRepr(name)} is not an address — only address-named neighbours can join a peer group (pyeapi's gate is \`if not self.ispeergroup(name)\` at bgp.py:288-298 and answers a SILENT False otherwise; this client refuses out loud instead. Declaring a NEW group is a different device question this port does not guess — create()/the shutdown arm mentions a name the way upstream's does, and the group keyword line itself is written by the device as membership lines, unverified on hardware, M12 #14)`)
  }

  /**
   * Which `peer group`/`peer-group` spelling the device speaks (divergence 8/DR-107): the FIRST
   * membership or declaration line in that same first bgp section decides; a block carrying neither
   * spelling defaults to the modern form — this repo's floor (EOS 4.28; upstream's own ≥4.23 gate
   * also lands there, `bgp.py:209`), held as a client convention, the device staying authoritative
   * via its own `CommandError` (DR-005/DR-032). Latched per instance exactly like
   * `VrfsResource.resolveVrfForm`'s rule.
   */
  private async resolvePeerGroupForm(): Promise<PeerGroupForm> {
    if (this.peerGroupForm !== undefined) return this.peerGroupForm
    const sections = await this.configSections()
    const key = findRouterBgpSection(sections)
    if (key !== undefined) {
      const text = sections.get(key)
      if (text !== undefined) {
        const block = parseBlock(text)
        for (const line of block.body) {
          if (/^(?:no )?neighbor \S+ peer group\b/u.test(line.text)) {
            this.peerGroupForm = 'peer group'
            return this.peerGroupForm
          }
          if (/^(?:no )?neighbor \S+ peer-group\b/u.test(line.text)) {
            this.peerGroupForm = 'peer-group'
            return this.peerGroupForm
          }
        }
      }
    }
    this.peerGroupForm = 'peer group'
    return this.peerGroupForm
  }
}

/** First bgp section → neighbour table; empty table when the switch runs no BGP (divergence 1). */
function neighborsFromSections(sections: ConfigSections): Map<string, BgpNeighbor> {
  const key = findRouterBgpSection(sections)
  if (key === undefined) return new Map<string, BgpNeighbor>()
  const text = sections.get(key)
  if (text === undefined) return new Map<string, BgpNeighbor>()
  return neighborsFromBody(parseBlock(text).body)
}
