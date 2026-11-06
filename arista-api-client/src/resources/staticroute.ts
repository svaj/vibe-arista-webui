/**
 * `staticroute` — the IPv4 static-route collection resource, W2d (#42). It reads the `ip route …`
 * lines of the running-config and writes the exact `ip route` / `no ip route` / `default ip route`
 * line forms, built on the M7 (#9) framework exactly like `vlans.ts` and `vrfs.ts` (DR-026 memo,
 * {@link commandBuilder}-style composition, `commandBuilder`/`submodeCommands` from
 * `./command-builder`, and the registry row that replaces pyeapi's `node.api('staticroute')`
 * autoload — DR-006).
 *
 * Port of `pyeapi/api/staticroute.py` (384 lines, BSD-3-Clause, Arista Networks — DR-001). Every
 * `pyeapi` ref below was re-opened in the pinned clone `/home/svaj/development/arista/pyeapi`
 * (1.0.4-rc0, `develop` @ `6816d9e`) on 2026-11-06 and says what the code **does** — nothing here
 * cites EOS image internals, and nothing claims what the DCS-7050TX-64 accepts: unit tests never
 * reach a device, so every EOS-side question reads "unverified on hardware, M12 (#14) to capture".
 * Whether the static-routing feature itself is licensed on this SKU is an open question the same way
 * (DECISIONS.md open items).
 *
 * | pyeapi (verified refs) | here |
 * |---|---|
 * | `ROUTES_RE` (module level, `:68-74` — comment block at `:60-67`) | {@link ROUTE_LINE}, anchored to section **keys** instead of run with `re.M` over the whole config (divergence 1) |
 * | `StaticRoute(EntityCollection)` (`:77`), `__str__` → `'StaticRoute'` (`:83-84`) | {@link StaticRouteResource} extends `EntityCollection<readonly StaticRoute[], string, StaticRouteAttrs>` (`base.ts`); no `__str__` twin (DR-004 family) |
 * | `get` (`:86-121`): literally `return self.getall().get(name)` (`:121`) | {@link StaticRouteResource.get} — same one-read table, but the destination is grammar-checked first (divergence 4) and an absent destination answers `undefined`, not `None` (DR-027) |
 * | `getall` (`:123-179`): `ROUTES_RE.findall(self.config)` (`:152`), then the nested-dict build (`:155-176`) — `next_hop_ip = None if match[2] == ''` (`:161`), `distance = int(match[3])` (`:162`), `data['tag'] = None if match[4] == '' else int(...)` (`:166`), `route_name` (`:167`), and one **dict assignment per component level** (`:170-176`), so a repeated identical route keeps only the last line | {@link StaticRouteResource.getAll} — one pass over the chunked document's indent-0 keys (DR-030, pinned with a request count), and FLAT typed records instead of the dict-of-dicts (divergence 2) |
 * | `create` (`:182-201`) / `delete` (`:203-223`, `kwargs.update({'delete': True})` at `:222`) / `default` (`:225-245`, `kwargs.update({'default': True})` at `:244`) / `set_tag` (`:247-271`) / `set_route_name` (`:273-297`) — ALL five funnel into `_set_route` unchanged | {@link StaticRouteResource.create} / {@link delete} / {@link setDefault} / {@link setTag} / {@link setRouteName} — same funnel, same line text; `default` → `setDefault` (row 77) |
 * | `_build_commands` (`:299-333`): `"ip route %s %s" % (ip_dest, next_hop)` (`:317`) then the **`is not None`** appends: `" %s" % next_hop_ip`, `" %s" % distance`, `" tag %s" % tag`, `" name %s" % route_name` (`:322-327`) | private {@link routeCommand} — same order, same spacers, and `!== undefined` keeps `0` a real value exactly as upstream's None-checks do (divergence 3, the one sibling of DR-037's falsy family that upstream gets RIGHT) |
 * | `_set_route` (`:335-371`): builds the line first, then prefixes `"no "` (`:357-358`) else `"default "` (`:360-361`), and `self.configure(commands)` (`:363`) — a single top-level line, submode never entered, **no existence check of any kind** | {@link routeCommand} + {@link StaticRouteResource.configure} — same prefixes, same single-line transactions (divergence 5) |
 * | `instance(node)` (`:373-384`) | the `RESOURCE_FACTORIES.staticroute` row plus `Node.staticroute` (DR-006/DR-052) |
 *
 * Upstream's own suite is `pyeapi/test/unit/test_api_staticroute.py` — **8** test methods (verified in
 * the pinned clone on 2026-11-06): `test_instance` (`:53-54`), `test_get` (`:56-101`), `test_getall`
 * (`:103-150`), `test_create` (`:152-189`), `test_delete` (`:191-226`), `test_default` (`:228-263`),
 * `test_set_tag` (`:265-281`), `test_set_route_name` (`:283-299`). All eight are ported: the first as
 * the registry row pinned in `registry.test.ts`/`index.test.ts`, the rest below with the fixture's
 * route lines reproduced (upstream reads `test/fixtures/running_config.text:2045-2048`:
 * `ip route 0.0.0.0/0 192.68.1.254 1 tag 0`, `ip route 1.2.3.0/24 Ethernet1 1.1.1.1 1 tag 1 name test1`,
 * the same with distance `10`, and `… Ethernet1 10.1.1.1 20 tag 1 name test1`). The random-parameter
 * loops (`choice`/`random_int`/`random_string`, `:152-263`) become deterministic pinned cases here — a
 * flaky upstream pattern DR-083's whole joined-key convention exists to end.
 *
 * ## Divergences this file owns (rows 178-180 are the orchestrator's; under-filled rows are declared skips)
 *
 * 1. **routes come from the chunked document, not a `re.M` sweep of the raw text.** Upstream runs
 *    `ROUTES_RE.findall(self.config)` over the WHOLE config (`:152`), so a column-0 line inside a
 *    `banner` body that spells `ip route 1.2.3.0/24 Ethernet1 1 1` is a route for pyeapi, and so is
 *    `ip route …` anywhere at column 0 by construction. Here the candidate lines are the chunker's
 *    indent-0 leaf keys (`config/chunk.ts`, `key = lineRs`) minus their rstrip, so indented copies
 *    and banner bodies cannot vote — the same rule `vlans.ts` divergence 3 and `vrfs.ts` divergence 2
 *    pin. Everything ELSE about the line grammar is kept upstream-first: the leading header is exact,
 *    the distance group stays **required** (an `ip route` line with no distance is invisible to both
 *    readers — divergence 6), the `tag`/`name` segments stay optional in the same order, and the
 *    pattern stays end-open, so a real `ip route …` line with unmodelled trailing text is read up to
 *    the last part both grammars know, exactly as `findall` does.
 * 2. **flat typed records replace the dict-of-dicts.** Upstream's return nests
 *    `{ip_dest: {next_hop: {next_hop_ip: {distance: {tag, route_name}}}}}` (`:170-176`) with a
 *    Python `None` **as a dict key** when the line has no next-hop-ip (`:161`) and integer keys for
 *    the distance (`:162`, `int(match[3])`). A `ReadonlyMap` could technically carry those keys, and
 *    no UI can consume them without re-flattening. Here the key is the destination and the value is
 *    the destination's routes as {@link StaticRoute} records — `nextHopIp`/`tag`/`routeName` absent
 *    where upstream writes `None`, `distance` a `number` where upstream writes the int. The one
 *    behavioural fact the nesting carried — a repeated identical route is ONE entry, the LAST line
 *    winning, because each level is a dict assignment (`:170-176`) — is kept as a last-wins replace on
 *    the `(ipDest, nextHop, nextHopIp, distance)` identity and pinned by a test. §4's "typed records,
 *    not stringly dicts" is the general form; DR-100 records this instance.
 * 3. **`0` is a value here, and upstream agrees.** Static-route kwargs are appended behind
 *    `is not None` guards (`:322-327`), NOT through `command_builder`'s truthiness fall-through
 *    (`abstract.py:155-161`, row 73, DR-037) — so `distance=0` and `tag=0` reach the wire as
 *    `… 0` and `tag 0`, and the pinned fixture's `tag 0` route (`running_config.text:2045` —
 *    parsed back as `tag: 0` via `int('0')`, `:166`) round-trips both ways. The TS port refuses only
 *    what neither side can read or send: `undefined` means "segment absent", `null`/`NaN`/fractional/
 *    negative/oversized numerics and non-numeric strings are refusals (divergence 4's round-trip
 *    rule), and a real `0` is composed. This is the deliberate contrast with `vrfs.create`'s falsy
 *    `if rd:` skip (`vrfs.py:173`, ported there because upstream skips instead of sending).
 * 4. **input guards where upstream has none.** Nothing upstream validates ip_dest, next_hop,
 *    next_hop_ip, distance, tag or route_name — `_build_commands` interpolates whatever arrives
 *    (`:317`, `:322-327`), so `create('a b', 'c')` sends `ip route a b c` and the read re-parses
 *    something else. The guards here are the reader's own grammar, the same round-trip contract as
 *    `vlans.ts`/`vrfs.ts` (DR-053's pattern): the destination must be the dotted `A.B.C.D/E` shape
 *    `ROUTES_RE:69` itself matches (which also means IPv6 `! ipv6 route` lines out of scope for this
 *    module — upstream has NO IPv6 half in the pinned clone: the file's whole grammar lives in
 *    `:68-74`; a v6 port needs a new upstream-shaped module, which M12/M-plan can size), the next
 *    hop a single token (`(\d+\.\d+\.\d+\.\d+|\S+)`, `:70`), the next-hop-ip the dotted form
 *    (`:71`), distance/tag unsigned integers, and route-name a single token (`name (\S+)`, `:73`).
 *    Values with line boundaries are refused by the same argument as row 74 (one CommandSpec per
 *    line); no new error classes (DR-005/DR-010). Guards run **before** any read, so a rejected
 *    argument costs zero round trips (pinned).
 * 5. **no existence checks — upstream's posture kept.** `delete`/`default`/`set_tag`/`set_route_name`
 *    never ask whether the route exists (`:203-245`, `_set_route` at `:335-371` consults nothing),
 *    and `create` does not check for duplicates: the device is the authority, and a refusal arrives as
 *    the `CommandError` with `failedCommand` (DR-005). Upstream's own docstring notes the
 *    `default ip route …` prefix "currently equivalent to the `no ip route …` command"
 *    (`:50-52`) — both command texts stay distinct here because they are what was asked for, and the
 *    note is a hint that the equivalence is an EOS behaviour M12 (#14) should confirm, not a licence
 *    to collapse the verbs.
 * 6. **a route line the regex cannot finish is invisible, upstream included.** Because the distance
 *    group is required (`(\d+)` at `:72`, not `(?P… )?`), `ip route 10.0.0.0/8 Ethernet1` with no
 *    distance is NOT read, and `ip route vrf red 10.0.0.0/8 1.1.1.1 1` fails the CIDR-right-after-the-
 *    header requirement (`:69` matches only in front of the next hop), so **VRF static routes and
 *    `ipv6 route` lines leak out of every read** — while the write verbs happily create lines the
 *    reader will never see. The port keeps both behaviours (write-side only guards against what the
 *    reader itself could not echo back) and the tests pin the leaks, so nobody "fixes" the read
 *    silently; a real `ip route vrf …` fix means a new upstream-shaped capability (vrf-scoped route
 *    records) — owed upward, not decided in this module (DR-100's "not fixed" paragraph).
 * 7. **the accessor and registry name is `staticroute`, one token, upstream's own module name.**
 *    pyeapi autoloads `pyeapi.api.staticroute` by that exact spelling (`client.py:927-950`), the
 *    epic spells it `staticroute`, and the registry keys are already all single-token module names
 *    (`vlans`, `switchports`, `interfaces`, `vrfs`). DR-102 records the naming and the camel-hump
 *    question the one multi-word-looking module raises; `node.staticroute` stays one word to match
 *    `node.resource('staticroute')` character for character.
 */

import { NotSupportedError } from '../errors'
import { pythonRepr } from '../internal/wire'
import { EntityCollection } from './base'
import type { ConfigSections } from '../config/chunk'

/**
 * Upstream `ROUTES_RE` (`staticroute.py:68-74`) with the line start anchored at a section **key**
 * instead of pyeapi's `^` + `re.M` sweep (divergence 1). The groups are verbatim: dest CIDR, next hop
 * (dotted-or-token), optional dotted next-hop-ip, REQUIRED distance, optional `tag`, optional `name`.
 * It stays end-open exactly like upstream — trailing text past the last known segment is ignored, not
 * a parse failure (divergence 6).
 */
const ROUTE_LINE = /^ip route (\d+\.\d+\.\d+\.\d+\/\d+) (\d+\.\d+\.\d+\.\d+|\S+)(?: (\d+\.\d+\.\d+\.\d+))? (\d+)(?: tag (\d+))?(?: name (\S+))?/u

/** The destination grammar upstream's own first group imposes (`:69`). */
const IP_DEST = /^\d+\.\d+\.\d+\.\d+\/\d+$/u
/** The next-hop-ip group (`:71`); a next hop is either that or any single token (`:70`). */
const IP_QUAD = /^\d+\.\d+\.\d+\.\d+$/u

/** How a rejected argument is described — the `refuse` pattern from `validators.ts` (DR-053). */
function refuse(label: string, value: unknown, because: string): never {
  throw new NotSupportedError(`invalid ${label} ${pythonRepr(value)} — ${because}`, { cause: value })
}

/** C0 controls plus DEL, code-unit by code-unit — the same test `vlans.ts`/`vrfs.ts` use. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/** Code points that would end a CLI line — the row 74 set, kept from `command-builder.ts`'s rule. */
const LINE_BOUNDARY = /[\r\n\v\f\u0085\u2028\u2029]/u

/**
 * Require a destination the reader re-matches: `ROUTES_RE`'s first group is dotted-quad-slash-bits
 * (`:69`), and upstream validates nothing at `create`/`delete`/`default` (the interpolation at
 * `:317`/`_set_route` `:349`). IPv6 destinations are refused with the out-of-scope wording: the
 * pinned module has no IPv6 half at all (divergence 4).
 */
function assertIpDest(value: unknown): asserts value is string {
  if (typeof value !== 'string') refuse('static-route destination', value, 'expected a string A.B.C.D/E prefix — pyeapi interpolates whatever arrives (staticroute.py:317)')
  if (!IP_DEST.test(value)) {
    refuse('static-route destination', value, 'a destination must be the dotted A.B.C.D/E shape this client and pyeapi both READ back (the first group of ROUTES_RE, staticroute.py:69) — anything else writes a line no getall() will ever show; IPv6 static routes are outside this module entirely (no IPv6 grammar exists at staticroute.py:68-74)')
  }
}

/**
 * Require a next hop the reader can echo. Upstream's group accepts a dotted quad OR any `\S+` token
 * (`:70`) — an interface name, most often — and validates nothing (`create(ip_dest, next_hop)` at
 * `:182` is purely positional). Inner whitespace would split the interpolated line (`:317`) into two
 * commands, and a line boundary row 74 outlaws anyway.
 */
function assertNextHop(value: unknown): asserts value is string {
  if (typeof value !== 'string') refuse('static-route next hop', value, 'expected a string interface name or address — pyeapi takes it positionally and interpolates it (staticroute.py:182, :317)')
  if (value === '') refuse('static-route next hop', value, 'an empty next hop would put two spaces in the line and read back as no route at all (the ` \\S+` group, staticroute.py:70)')
  if (/\s/u.test(value)) refuse('static-route next hop', value, 'a next hop with inner whitespace splits the line the writer sends; the reader captures one \\S+ token (staticroute.py:70) — pyeapi would interpolate it verbatim anyway (staticroute.py:317)')
  if (hasControlCharacter(value) || LINE_BOUNDARY.test(value)) refuse('static-route next hop', value, 'control characters and line boundaries have no place in a single config line (row 74)')
}

/** The optional next-hop-ip segment: the dotted group at `:71`, and only that — an interface name in this slot makes the REQUIRED distance fail against the same token. */
function assertNextHopIp(value: unknown): asserts value is string {
  if (typeof value !== 'string') refuse('static-route next-hop-ip', value, 'expected a string dotted address — _build_commands appends `" %s" % next_hop_ip` for any non-None value (staticroute.py:322)')
  if (!IP_QUAD.test(value)) {
    refuse('static-route next-hop-ip', value, 'the next-hop-ip slot must be the dotted A.B.C.D group the reader matches (staticroute.py:71); anything else makes the whole line unparseable — the required distance group then faces a non-digit (staticroute.py:72)')
  }
}

/**
 * Distance and tag are both unsigned-integer segments in the read (`(\d+)` at `:72`/`:72-73`) and
 * interpolated raw in the write (`:323`/`:325` — upstream tests hand in ints from `random_int` and,
 * sloppily, the string `'99'` at `test_api_staticroute.py:273`). Both spellings are accepted; what
 * is refused is anything the reader could not produce: fractional or negative numerics, non-digit
 * strings, and numerics above `Number.MAX_SAFE_INTEGER`, where a JS `number` could not echo the
 * digits pyeapi's `int()` would (the `int(match[3])` at `:162` is exact for those digits). **Zero is
 * deliberately not refused** (divergence 3).
 */
function assertUnsignedSegment(label: string, value: unknown, pyRef: string): asserts value is number | string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      refuse(`static-route ${label}`, value, `a ${label} must be an unsigned integer the \\d+ group can read back (staticroute.py:${pyRef}) — fractions, negatives and above-trusted-size numerics cannot round-trip through pyeapi's int() either (staticroute.py:162/:166)`)
    }
    return
  }
  if (typeof value === 'string') {
    if (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value))) {
      refuse(`static-route ${label}`, value, `a ${label} string must be digits the \\d+ group can read back (staticroute.py:${pyRef})`)
    }
    return
  }
  refuse(`static-route ${label}`, value, `expected a number or digit string — pyeapi appends " ${label === 'distance' ? '%s' : '… %s'}" for any non-None value (staticroute.py:${label === 'distance' ? '323' : '325'})`)
}

/** The route name: one token, as `name (\S+)` (`:73`) reads it; upstream interpolates anything (`:327`). */
function assertRouteName(value: unknown): asserts value is string {
  if (typeof value !== 'string') refuse('static-route name', value, 'expected a string route tag name — _build_commands appends `" name %s" % route_name` for any non-None value (staticroute.py:327)')
  if (value === '') refuse('static-route name', value, 'an empty name would put a trailing space in the line and read back as if the segment were absent (the `name (\\S+)` group, staticroute.py:73)')
  if (/\s/u.test(value)) refuse('static-route name', value, 'a name with inner whitespace splits the line; the reader captures one \\S+ token (staticroute.py:73) — pyeapi does not care, and its own docstring warns the name is a single field (`:43`)')
  if (hasControlCharacter(value) || LINE_BOUNDARY.test(value)) refuse('static-route name', value, 'control characters and line boundaries have no place in a single config line (row 74)')
}

/**
 * One parsed route. {@link StaticRouteResource.getAll} answers these in a flat list per destination;
 * the field set is upstream's `data` dict plus the three identifying components of its nested keys
 * (`:157-176`), with `None` becoming absence (divergence 2). `tag` is a `number` because that is what
 * `int(match[4])` (`:166`) computes — the fixture's `tag 0` is `0`, not `'0'`, and not `None` — while
 * writes accept `string | number` (see {@link assertUnsignedSegment}).
 */
export interface StaticRoute {
  /** Upstream's outermost dict key — the destination prefix (`:158`/`:170`). */
  readonly ipDest: string
  /** The second dict key (upstream `match[1]`, `:159`/`:171`) — an interface name or an address. */
  readonly nextHop: string
  /** The third dict key (upstream `match[2]`, `:161`/`:172`) as a string; upstream keys Python `None` here, absence says the same (divergence 2). */
  readonly nextHopIp?: string
  /** The fourth dict key, an int upstream computes with `int(match[3])` (`:162`) and uses as the leaf key (divergence 2). Required in the line grammar — no distance, no route (divergence 6). */
  readonly distance: number
  /** `data['tag']` — `int(match[4])` or `None` (`:166`). Absent means upstream's `None`; `tag 0` reads back as `0`. */
  readonly tag?: number
  /** `data['route_name']` — `match[5]` or `None` (`:167`). */
  readonly routeName?: string
}

/**
 * The kwargs bag pyeapi's `create(ip_dest, next_hop, **kwargs)` honours (`:182`, consumed at
 * `_build_commands` `:320-327` and `_set_route` `:352-361`). Upstream honours exactly five names —
 * `next_hop_ip`, `distance`, `tag`, `route_name`, plus the module-internal `delete`/`default` flags
 * that public callers should never set by hand (the public verbs set them themselves, `:222`/`:244`);
 * anything else in `**kwargs` is silently ignored, and this type simply cannot express it.
 *
 * `nextHop` is optional only because `EntityCollection`'s signature requires one shared attrs type:
 * upstream makes the next hop a POSITIONAL required argument at every entry point (`:182`, `:203`,
 * `:225`), so {@link StaticRouteResource.create} refuses an attrs bag without it before anything is
 * read or sent (divergence 4).
 */
export type StaticRouteAttrs = {
  /** Upstream's positional `next_hop` riding the framework's attrs bag (`staticroute.py:182`). */
  readonly nextHop?: string
  /** `next_hop_ip` (the dotted group at `:71`). */
  readonly nextHopIp?: string
  /** `distance` (required by the line grammar; `0` allowed, divergence 3). */
  readonly distance?: number | string
  /** `tag` (`0` allowed — the pinned fixture's `tag 0`). */
  readonly tag?: number | string
  /** `route_name` (single token). */
  readonly routeName?: string
}

/** The locator the standalone field verbs take positionally, mirroring upstream's `**kwargs` minus the name of the field being SET. */
export interface StaticRouteFields {
  readonly nextHopIp?: string
  readonly distance?: number | string
}

/** Parse one chunked leaf key into a route, or give up exactly where `findall` would have skipped the line (divergences 1/6). */
function routeOfLeafKey(key: string): StaticRoute | undefined {
  const match = ROUTE_LINE.exec(key)
  if (match === null) return undefined
  const [, ipDest, nextHop, nextHopIp, distance, tag, routeName] = match as unknown as (readonly (string | undefined)[])
  const ipDestValue = ipDest as string
  const nextHopValue = nextHop as string
  const route: StaticRoute = {
    ipDest: ipDestValue,
    nextHop: nextHopValue,
    // "" never happens in practice (JS optional groups yield undefined, where Python's findall yields
    // '' — the `match[2] == ''` tests at :161/:166/:167 are the Python-side spelling of the same fact).
    ...(nextHopIp === undefined ? {} : { nextHopIp }),
    distance: Number(distance),
    ...(tag === undefined ? {} : { tag: Number(tag) }),
    ...(routeName === undefined ? {} : { routeName }),
  }
  return route
}

/**
 * All routes in one chunked document, grouped per destination in device order, with upstream's
 * dict-level last-wins collapse on the identifying 4-tuple (divergence 2). The intermediate map is
 * keyed `dest|nextHop|nextHopIp|distance` — the chain of `routes[a] = routes.get(a, {})` assignments
 * at `:170-176` is exactly that identity, and the leaf data dict is REPLACED, so an identical later
 * line wins, position and all.
 */
function routesByDest(sections: ConfigSections): Map<string, StaticRoute[]> {
  const identities = new Map<string, StaticRoute>()
  for (const key of sections.keys()) {
    const route = routeOfLeafKey(key)
    if (route === undefined) continue
    const identity = `${route.ipDest}\u0000${route.nextHop}\u0000${route.nextHopIp ?? ''}\u0000${route.distance}`
    // Map.set on an existing key keeps the FIRST position and stores the LAST value — which is what
    // Python's nested dict assignment does for the same 4-tuple (:170-176). The components came from a
    // tokenizing regex (dots and digits cannot contain the separator), which is why \u0000 is safe as a
    // join marker — an old note about NUL bytes in source is about RAW bytes in files; this is the
    // printable escape in a regex-built key, and vlans.ts predates it.
    identities.set(identity, route)
  }
  const grouped = new Map<string, StaticRoute[]>()
  for (const route of identities.values()) {
    const bucket = grouped.get(route.ipDest)
    if (bucket === undefined) grouped.set(route.ipDest, [route])
    else bucket.push(route)
  }
  return grouped
}

/**
 * `node.staticroute` — the IPv4 static routes in one switch's running-config.
 *
 * pyeapi's `StaticRoute(EntityCollection)` (`:77`) keyed by the destination prefix; the value is the
 * destination's whole route set (an address can have several next hops, upstream's nested
 * `{ip_dest: …}` level, `:170`).
 */
export class StaticRouteResource extends EntityCollection<readonly StaticRoute[], string, StaticRouteAttrs> {
  /**
   * Every route grouped by destination — pyeapi's `getall()` (`:123-179`) as a typed table (row 78).
   * One `show running-config all` for the collection AND for `get` (DR-030); upstream's `get` re-runs
   * the full regex sweep through `getall` (`:121`), which the single `Node` chunk memo already makes
   * unnecessary.
   */
  override async getAll(): Promise<ReadonlyMap<string, readonly StaticRoute[]>> {
    return routesByDest(await this.configSections())
  }

  /**
   * The routes for one destination, or `undefined` — upstream's `get(name)` returning `None` from
   * `getall().get(name)` (`:121`, DR-027's kept half). The destination is grammar-checked first
   * (divergence 4), so a name the reader could never produce rejects without asking the device
   * anything; upstream would have fetched the whole config and answered `None`.
   */
  override async get(name: string): Promise<readonly StaticRoute[] | undefined> {
    assertIpDest(name)
    return (await this.getAll()).get(name)
  }

  /** The five write verbs' shared core — `_build_commands` + `_set_route` (`:299-333`, `:335-371`). */
  private routeCommand(mode: 'set' | 'no' | 'default', ipDest: string, nextHop: string, fields: Pick<StaticRouteAttrs, 'nextHopIp' | 'distance' | 'tag' | 'routeName'>): string {
    assertIpDest(ipDest)
    assertNextHop(nextHop)
    let command = `ip route ${ipDest} ${nextHop}`
    if (fields.nextHopIp !== undefined) {
      assertNextHopIp(fields.nextHopIp)
      command += ` ${fields.nextHopIp}`
    }
    if (fields.distance !== undefined) {
      assertUnsignedSegment('distance', fields.distance, '72/:162')
      command += ` ${String(fields.distance)}`
    }
    if (fields.tag !== undefined) {
      assertUnsignedSegment('tag', fields.tag, '72/:166')
      command += ` tag ${String(fields.tag)}`
    }
    if (fields.routeName !== undefined) {
      assertRouteName(fields.routeName)
      command += ` name ${fields.routeName}`
    }
    // Same prefix order as `_set_route:356-361`: `no` wins, else `default`, else bare — and both apply to
    // the WHOLE composed line (`"no " + commands`), never just the header.
    if (mode === 'no') return `no ${command}`
    if (mode === 'default') return `default ${command}`
    return command
  }

  /**
   * The positional-pair extractor every collection verb needs: upstream's `next_hop` is positional
   * (`:182`/`:203`/`:225`) but the framework carries one attrs bag (`base.ts` create docs), so a bag
   * spelled without `nextHop` is a caller mistake refused before the device sees anything.
   */
  private requireNextHop(attrs: StaticRouteAttrs | undefined): string {
    const nextHop = attrs?.nextHop
    if (nextHop === undefined) {
      refuse('static-route next hop', undefined, 'attrs.nextHop is required — pyeapi takes the next hop as a POSITIONAL argument (staticroute.py:182/:203/:225); the framework moves it into the attrs bag and this client still demands it')
    }
    return nextHop
  }

  /**
   * Add a route — pyeapi's `create(ip_dest, next_hop, **kwargs)` (`:182-201`) via `_set_route`
   * (`:352`). One top-level command line, submode never entered, and no read of any kind first
   * (divergence 5): `test_api_staticroute.py:152-189` pins exactly `ip route <dest> <hop> [nhip]
   * [dist] [tag N] [name X]` and nothing else.
   */
  override async create(name: string, attrs?: StaticRouteAttrs): Promise<void> {
    await this.configure(this.routeCommand('set', name, this.requireNextHop(attrs), attrs ?? {}))
  }

  /**
   * Remove one route spec — pyeapi's `delete` (`:203-223`, the `kwargs.update({'delete': True})`
   * splice at `:222`): the same composed line, prefixed `no ` by `_set_route` (`:357-358`). No
   * existence check (divergence 5); omitting the optional components addresses a DIFFERENT line than
   * a full locator does, exactly as it does upstream — the leaf `ip route` grammar matches whole
   * lines.
   */
  override async delete(name: string, attrs?: StaticRouteAttrs): Promise<void> {
    await this.configure(this.routeCommand('no', name, this.requireNextHop(attrs), attrs ?? {}))
  }

  /**
   * `default ip route …` — pyeapi's `default` (`:225-245`, flag at `:244`), renamed per row 77.
   * Upstream's docstring note says the form is "currently equivalent to" `no ip route …` (`:50-52`);
   * both texts stay distinct here and whether they truly behave the same on 4.28 is M12's (#14)
   * device question, not this port's to answer.
   */
  override async setDefault(name: string, attrs?: StaticRouteAttrs): Promise<void> {
    await this.configure(this.routeCommand('default', name, this.requireNextHop(attrs), attrs ?? {}))
  }

  /**
   * Re-send the route line with a `tag` segment — pyeapi's `set_tag` (`:247-271`), which is literally
   * `_set_route(ip_dest, next_hop, **kwargs)` with NO forced segment: upstream's own test hands the
   * tag in via kwargs (`test_api_staticroute.py:265-281`, tag `'99'` as a string) and its docstring
   * warns that any existing `route_name` must be re-passed "otherwise the tag will be reset by the
   * call to EOS" (`:262-264` — EOS replaces the whole leaf line, so the caller must restate the parts
   * not being changed). The framework's `set<Field>` naming makes the field itself the third argument;
   * `tag` being present is what makes the verb mean anything, and undefined is refused (divergence 4).
   */
  async setTag(ipDest: string, nextHop: string, fields: StaticRouteFields & { tag: number | string }): Promise<void> {
    await this.configure(this.routeCommand('set', ipDest, nextHop, fields))
  }

  /**
   * Re-send the route line with a `name` segment — pyeapi's `set_route_name` (`:273-297`), same
   * no-forced-field shape (`test_api_staticroute.py:283-299` pins `… name test99`) and the mirror
   * warning: any existing `tag` must be re-passed or it resets (`:288-291`).
   */
  async setRouteName(ipDest: string, nextHop: string, fields: StaticRouteFields & { routeName: string }): Promise<void> {
    await this.configure(this.routeCommand('set', ipDest, nextHop, fields))
  }
}
