/**
 * S10 (#80): the pure rules behind the static-route manager — the client's own `staticroute`
 * grammar mirrored for in-form refusal, the fixed-segment line composer, and the two guards the
 * issue grades as hard (default-route removal, and removal of a route riding a gateway the read
 * table itself spells). No React, no device call: `static-route-rules.test.ts` pins this file
 * against the REAL client composition.
 *
 * ## Why the screen composes lines instead of calling the resource verbs
 *
 * #80's Writes contract is `named session; preview → diff() → confirm → commit` (DR-022/DR-048), and
 * the resource verbs cannot honour it: `create`/`delete`/`setTag`/`setRouteName` each fall through
 * `configure()` and reach the device immediately — their own spec pins one transaction per call and
 * that a static-route write never reads first (`staticroute.test.ts`, "_build_commands/_set_route
 * (:299-371), one line per transaction"). So this screen stages the same text through
 * {@link routeLine} below, in the client's **fixed segment order** — dest, next hop, next-hop-ip,
 * distance, `tag`, `name` (`_build_commands`, `staticroute.py:317-327`, kept by the private
 * `routeCommand`) — prefixed `no ` for a removal exactly the way `_set_route:357-358` does. The
 * equivalence is pinned, not claimed: `static-route-rules.test.ts` runs the real
 * `StaticRouteResource` over the client's `mockTransport` and asserts that for the same inputs the
 * client's sent `cmd` equals the line staged here, character for character. Nothing in this file
 * invents a command form, and every refusal below names the client guard it mirrors.
 *
 * ## What is refused, and by whom (the copy says this out loud, it is not buried)
 *
 * | refusal | owner |
 * | --- | --- |
 * | the `A.B.C.D/E` destination shape, the single-token next hop, the `\\d+` distance/tag, the single-token name | the client (`assertIpDest`/`assertNextHop`/`assertUnsignedSegment`/`assertRouteName`, `resources/staticroute.ts` — divergence 4: pyeapi validates nothing and interpolates whatever arrives). Mirrored here so a refusal costs zero sessions |
 * | octet > 255 and prefix bits > 32 | IPv4 arithmetic (DR-032). The client checks only the dotted shape, so a client call would compose `ip route 999.0.0.0/8 …`; the screen does not stage it, and the device's CLI answer stays the referee for everything inside those bounds |
 * | an IPv6-shaped destination | the client: `staticroute.ts` has no IPv6 grammar anywhere (`staticroute.py:68-74` is the whole module grammar, divergence 4), and its own `get`/`create`/`delete` throw this refusal before any round trip |
 * | an IPv6-shaped next hop | **this screen**: the client's token guard (`.+ \S+`, `staticroute.py:70`) would let it ride, but no `staticroute.ts` pin and no committed capture names an IPv6 next hop behind an IPv4 `ip route` line, so staging one would be a guess about the device contract |
 * | a `vrf`-carrying prefix | the screen, for the client's reason: the module's grammar has no VRF slot, and its reader cannot see `ip route vrf …` lines at all (divergence 6), so this app can neither write nor re-read them |
 * | a distance-less add | **this screen**: the client WOULD compose the bare line (its own spec pins `ip route 222.22.222.0/24 Null0`), and `staticroute.test.ts` pins that a device rejected a distance-less line as a `CommandError`. Because the reader requires the `\\d+` group, a line without a distance is invisible to every later read of this table — an un-echoable write is what the standing rules refuse |
 * | clearing a tag or a name | neither: the client has no `no tag`/`no name` verb for a route leaf, only `set_tag`/`set_route_name` re-sends (`staticroute.py:247-297`). #80 names only `setTag`/`setRouteName`, so this screen offers no clearing write |
 *
 * ## The two hard guards (#80's "Guard" section) and the honesty limit
 *
 * `routeGuard` marks a removal destructive when it targets the default route `0.0.0.0/0`, or when
 * the route's next hop (or next-hop address) is a value the read table **itself** spells as a
 * default-route next hop — a candidate set derived only from data this screen fetched, never from a
 * guess about the management path. The note says plainly what the screen cannot see: it has no
 * interface table, no RIB and no management-API answer in front of it, so it can name the shared
 * gateway, not promise the path survives. Adding a second `0.0.0.0/0` is destructive for the same
 * reason, stated separately.
 */

/** The four writes #80 scopes to this screen. */
export type RouteAction = 'add-route' | 'remove-route' | 'set-tag' | 'set-name'

export const ROUTE_ACTIONS: readonly RouteAction[] = ['add-route', 'remove-route', 'set-tag', 'set-name']

export const ROUTE_ACTION_LABELS: Readonly<Record<RouteAction, string>> = {
  'add-route': 'Add a route (ip route <prefix> <next-hop> <distance> [tag N] [name X])',
  'remove-route': 'Remove one route (no ip route …, exact-match)',
  'set-tag': 'Re-send a route line with a new tag',
  'set-name': 'Re-send a route line with a new name',
}

/**
 * Structurally the client's `StaticRoute` record (`resources/staticroute.ts`: `ipDest`, `nextHop`,
 * `nextHopIp?`, `distance`, `tag?`, `routeName?`), restated here so no client type crosses the view
 * boundary — the rule every sibling view follows. Absent optional fields mean upstream's `None`
 * (client divergence 2), and `tag: 0` is a value, not absence (divergence 3).
 */
export interface RouteRow {
  readonly ipDest: string
  readonly nextHop: string
  readonly nextHopIp?: string
  readonly distance: number
  readonly tag?: number
  readonly routeName?: string
}

/** Everything the form holds. Device-side rows are selected by {@link routeKey}, never typed by hand. */
export interface RouteFields {
  readonly action: RouteAction
  readonly routeKey: string
  readonly prefix: string
  readonly nextHop: string
  readonly distance: string
  readonly tag: string
  readonly routeName: string
}

export const EMPTY_ROUTE_FIELDS: RouteFields = {
  action: 'add-route',
  routeKey: '',
  prefix: '',
  nextHop: '',
  distance: '',
  tag: '',
  routeName: '',
}

/** The default-route prefix — the one line whose loss can take the routed path with it. */
export const DEFAULT_PREFIX = '0.0.0.0/0'

// The client's own grammar, copied from `resources/staticroute.ts` (`IP_DEST`/`IP_QUAD`, and the
// groups of upstream's `ROUTES_RE`, staticroute.py:69-73). Kept as separate constants so a reader
// can see the mirror point by point.
const IP_DEST = /^\d+\.\d+\.\d+\.\d+\/\d+$/u
const DIGITS_ONLY = /^\d+$/u
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u
/** The row-74 line-boundary set the client uses for a single config line. */
const LINE_BOUNDARY = /[\r\n\v\f\u0085\u2028\u2029]/u
/** A token with a colon is IPv6-shaped; the module this screen writes has no v6 grammar at all. */
const IPV6_SHAPED = /:/u

const quote = (value: string): string => JSON.stringify(value)

/**
 * Mirrors `assertIpDest`. Every sentence is the client's reason (its wording is what
 * `staticroute.test.ts` pins), plus the two DR-032 arithmetic bounds this screen adds on top.
 */
export function ipDestRefusal(value: string): string | undefined {
  const dest = value.trim()
  if (dest === '') {
    return `This client refuses an empty static-route destination: it must be the dotted A.B.C.D/E shape this client and pyeapi both READ back (the first group of ROUTES_RE, staticroute.py:69) — anything else writes a line no getall() will ever show (mirrors assertIpDest).`
  }
  if (/\bvrf\b/iu.test(dest)) {
    return `VRF-scoped static routes are outside this client's staticroute module entirely: its grammar matches a CIDR immediately behind \`ip route\` and has no VRF slot (staticroute.py:69, divergence 6), so \`ip route vrf …\` lines are invisible to the read as well as unwritable from here. The client's own guard throws this refusal — this screen neither writes nor claims them.`
  }
  if (IPV6_SHAPED.test(dest)) {
    return `This client refuses the destination ${quote(dest)}: IPv6 static routes are outside this module entirely — no IPv6 grammar exists at staticroute.py:68-74 (divergence 4), and the client's own get/create/delete verbs throw this refusal before any round trip. That is the client/device contract refusing, not this page's opinion: whether 4.28 would accept an IPv6 route is an uncaptured device question.`
  }
  if (!IP_DEST.test(dest)) {
    return `This client refuses the destination ${quote(dest)}: it must be the dotted A.B.C.D/E shape this client and pyeapi both READ back (the first group of ROUTES_RE, staticroute.py:69) — a bare address, a mask alone, or trailing text writes a line no getall() will ever show (mirrors assertIpDest).`
  }
  const [address, bits] = dest.split('/')
  for (const octet of (address ?? '').split('.')) {
    if (Number(octet) > 255) {
      return `The octet ${octet} in ${quote(dest)} is outside 0..255 — an IPv4-address fact, not an EOS claim (DR-032). staticroute.ts checks only the dotted shape, so a client call would compose that line; this screen does not stage it, and the device's CLI answer is the referee for every value inside the bounds.`
    }
  }
  if (Number(bits) > 32) {
    return `The prefix length ${String(bits)} in ${quote(dest)} is outside 0..32 for an IPv4 prefix — an IPv4 fact, not a claim about this build (DR-032, the same bound the addressing screen's guard applies).`
  }
  return undefined
}

/**
 * Mirrors `assertNextHop`, then adds the IPv6-token refusal this screen owns (see the header table:
 * the client's `\\S+` group would let it through).
 */
export function nextHopRefusal(value: string): string | undefined {
  const hop = value.trim()
  if (hop === '') {
    return `This client refuses an empty static-route next hop: an empty next hop would put two spaces in the line and read back as no route at all (the \` \\S+\` group, staticroute.py:70; mirrors assertNextHop).`
  }
  if (/\s/u.test(value)) {
    return `This client refuses the next hop ${quote(value)}: a next hop with inner whitespace splits the line the writer sends; the reader captures one \\S+ token (staticroute.py:70) — pyeapi would interpolate it verbatim anyway (staticroute.py:317; mirrors assertNextHop).`
  }
  if (CONTROL_CHARS.test(value) || LINE_BOUNDARY.test(value)) {
    return `This client refuses the next hop ${quote(value)}: control characters and line boundaries have no place in a single config line (MIGRATION.md §5 row 74; mirrors assertNextHop).`
  }
  if (IPV6_SHAPED.test(hop)) {
    return `This screen refuses the IPv6-shaped next hop ${quote(hop)}: \`staticroute.ts\` is the IPv4 module and pins no IPv6 form anywhere (its whole grammar lives at staticroute.py:68-74, and \`ipv6 route\` lines are read by nobody in this client), and no committed capture names an IPv6 next hop behind an IPv4 \`ip route\` line. The client's token guard would let the token ride, so this refusal is this screen's — what 4.28 accepts stays the device's answer.`
  }
  return undefined
}

/**
 * Mirrors `assertUnsignedSegment`: digit strings and numbers pass (upstream's own pins hand in both
 * spellings), zero passes (divergence 3), and leading zeros pass because `010` matches `\\d+` and
 * `int('010')` is 10 (client spec pins it). Fractions, signs, spaces and oversized runs refuse.
 */
export function unsignedSegmentRefusal(label: 'distance' | 'tag', value: string): string | undefined {
  const raw = value.trim()
  if (raw === '') return undefined
  if (!DIGITS_ONLY.test(raw) || !Number.isSafeInteger(Number(raw))) {
    return `This client refuses ${quote(raw)} as a ${label}: a ${label} must be an unsigned integer the \\d+ group can read back (staticroute.py:72${label === 'tag' ? '/:166' : '/:162'}) — fractions, negatives, inner spaces and above-trusted-size numerics cannot round-trip through pyeapi's int() either (mirrors assertUnsignedSegment). Zero is deliberately a value here, and it composes.`
  }
  return undefined
}

/** Mirrors `assertRouteName`: one token, no control characters, never empty. */
export function routeNameRefusal(value: string): string | undefined {
  const name = value.trim()
  if (name === '') return undefined
  if (/\s/u.test(value)) {
    return `This client refuses the route name ${quote(value)}: a name with inner whitespace splits the line; the reader captures one \\S+ token (the \`name (\\S+)\` group, staticroute.py:73) — pyeapi does not care, and its own docstring warns the name is a single field (mirrors assertRouteName).`
  }
  if (CONTROL_CHARS.test(value) || LINE_BOUNDARY.test(value)) {
    return `This client refuses the route name ${quote(value)}: control characters and line boundaries have no place in a single config line (MIGRATION.md §5 row 74; mirrors assertRouteName).`
  }
  return undefined
}

/** The client's fixed segment order (`routeCommand`, mirroring `staticroute.py:317-327`). */
function routeLine(dest: string, hop: string, nextHopIp: string | undefined, distance: string, tag: string | undefined, name: string | undefined): string {
  let line = `ip route ${dest} ${hop}`
  if (nextHopIp !== undefined) line += ` ${nextHopIp}`
  if (distance !== '') line += ` ${distance}`
  if (tag !== undefined) line += ` tag ${tag}`
  if (name !== undefined) line += ` name ${name}`
  return line
}

/** The whole line a read row would compose, so a removal/replacement is comparable to the config. */
export function lineOfRow(row: RouteRow): string {
  return routeLine(row.ipDest, row.nextHop, row.nextHopIp, String(row.distance), row.tag === undefined ? undefined : String(row.tag), row.routeName)
}

/**
 * `no ip route …` — the client prefixes the WHOLE composed line (`_set_route:357-358`, pinned by
 * `staticroute.test.ts` as `no ip route 33.34.35.0/24 44.44.44.0 20 tag 1 name test1`), and every
 * segment comes from the row the device answered, so the removal addresses that whole line and not
 * a shorter prefix of it.
 */
export function removalLineOf(row: RouteRow): string {
  return `no ${lineOfRow(row)}`
}

/**
 * A full replacement line for `set_tag`/`set_route_name` (the client re-sends the leaf line through
 * the same `routeCommand`, `staticroute.py:247-297`). Unlike the client's typed verbs — whose spec
 * pins the SPARSE line and whose own docstring warns that upstream "the tag will be reset by the
 * call to EOS" when the other field is not re-passed — this screen restates every segment it read.
 * The line is a whole-line replacement on the device, so restating is the only way to change one
 * field without silently erasing the other, and the pinned command text is the proof.
 */
export function replacementLineOf(row: RouteRow, patch: { readonly tag?: string; readonly routeName?: string }): string {
  return routeLine(
    row.ipDest,
    row.nextHop,
    row.nextHopIp,
    String(row.distance),
    patch.tag !== undefined ? patch.tag.trim() : row.tag === undefined ? undefined : String(row.tag),
    patch.routeName !== undefined ? patch.routeName.trim() : row.routeName,
  )
}

/** The row's identity the client itself uses (`routesByDest`'s 4-tuple, divergence 2), joined with
 *  printable separators — EOS names and dotted quads cannot contain `|`, so it cannot collide. */
export function routeKey(row: RouteRow): string {
  return `${row.ipDest}|${row.nextHop}|${row.nextHopIp ?? ''}|${String(row.distance)}`
}

/** Operator-facing row label. One line, built from what the read answered. */
export function routeLabel(row: RouteRow): string {
  const parts = [`${row.ipDest} via ${row.nextHop}`]
  if (row.nextHopIp !== undefined) parts.push(`next-hop ${row.nextHopIp}`)
  parts.push(`distance ${String(row.distance)}`)
  if (row.tag !== undefined) parts.push(`tag ${String(row.tag)}`)
  if (row.routeName !== undefined) parts.push(`name ${row.routeName}`)
  return parts.join(' · ')
}

export function isDefaultRoute(row: RouteRow): boolean {
  return row.ipDest === DEFAULT_PREFIX
}

/**
 * The gateway candidates #80's in-band guard needs, derived ONLY from the static-route table this
 * screen read: every next hop (and next-hop address) the device spells behind its own
 * `0.0.0.0/0` line(s). No interface table, no RIB, no management-API answer is consulted — that is
 * the whole point of the candidate set, and also its limit, which {@link routeGuard} says out loud.
 */
export function gatewayCandidates(rows: readonly RouteRow[]): ReadonlySet<string> {
  const found = new Set<string>()
  for (const row of rows) {
    if (!isDefaultRoute(row)) continue
    found.add(row.nextHop)
    if (row.nextHopIp !== undefined) found.add(row.nextHopIp)
  }
  return found
}

export type GuardKind = 'default-route' | 'shared-gateway'

export interface RouteGuard {
  readonly kind: GuardKind
  /** Operator copy: what is at risk, and what this screen cannot see. */
  readonly note: string
}

/**
 * Is removing this row destructive-capable? `default-route` is the row itself; `shared-gateway` is
 * any other row riding a next hop the read table spells as its default-route next hop. Neither
 * claim is stronger than the evidence: this screen reads one table, so it names the shared gateway
 * and never asserts that the management path does or does not ride it.
 */
export function routeGuard(row: RouteRow, candidates: ReadonlySet<string>): RouteGuard | undefined {
  if (isDefaultRoute(row)) {
    return {
      kind: 'default-route',
      note: `${DEFAULT_PREFIX} is the default route in the table the device just answered. Removing it changes where this switch sends traffic it has no other route for — and if this UI's eAPI path is routed rather than a directly-connected or \`Management<N>\` address, that includes the requests this page is making right now. This screen reads ONLY the static-route table: it has no interface table, no routing table and no management-API answer in front of it, so it cannot promise the path survives. \`show ip interface brief\` and \`show management api http-commands\` (S1/S6) are where that evidence lives, and the device's own answer outranks this note.`,
    }
  }
  const shared = candidates.has(row.nextHop) || (row.nextHopIp !== undefined && candidates.has(row.nextHopIp))
  if (!shared) return undefined
  const token = candidates.has(row.nextHop) ? row.nextHop : (row.nextHopIp as string)
  return {
    kind: 'shared-gateway',
    note: `This route's next hop ${quote(token)} is the same value this device spells behind its own ${DEFAULT_PREFIX} line(s) in the read table, so removing it changes traffic that rides that gateway. The candidate came from data this screen read — it is not a claim about where eAPI is served: this page cannot see the interface table, so it cannot say whether that gateway carries the management path. Treat it as possibly in-band.`,
  }
}

/** The same hard risk on the add side: a second default route re-decides the same path. */
export function addDefaultGuard(prefix: string): RouteGuard | undefined {
  if (prefix.trim() !== DEFAULT_PREFIX) return undefined
  return {
    kind: 'default-route',
    note: `Adding another ${DEFAULT_PREFIX} line changes which next hop the device picks for destination-less traffic — the same path decision as removing one, and this screen cannot see whether this UI's own eAPI requests ride it. Review the device diff closely: with an existing default route already in the table, what 4.28 does with a second line is a device answer this app has not captured.`,
  }
}

export interface StagedIntent {
  /** The one command line the session stages (#80: never more than one at a time). */
  readonly command: string
  /** Which read row the action targets, for the review copy. */
  readonly row?: RouteRow
  readonly guard?: RouteGuard
}

export type StageOutcome = { readonly refusal: string } | { readonly intent: StagedIntent }

function findRow(rows: readonly RouteRow[], key: string): RouteRow | undefined {
  return rows.find((row) => routeKey(row) === key)
}

/**
 * A read row's own segments, re-checked against the **client's** write guards (`assertIpDest`'s
 * `A.B.C.D/E` shape, `assertNextHop`'s one-token/no-control rule, `assertRouteName`'s same) — and
 * deliberately not against the two bounds this screen adds on top (DR-032 arithmetic, the IPv6 token
 * refusal): a line the device really has is not refused by those, only a line this form would invent.
 * The reader's grammar (`\S+` for a next hop, an end-open tail) can in principle capture something the
 * writer's guards refuse, and this screen composes from the row — so the honest answer is to refuse
 * that removal/replacement rather than stage a line the client itself would not send. Same
 * read/write-split posture as DR-059's display-preserved ids.
 */
function rowSegmentRefusal(row: RouteRow): string | undefined {
  const badSegment = (label: string, value: string, shapeProblem: boolean): string | undefined => {
    if (!shapeProblem) return undefined
    return `The ${label} this read answered (${quote(value)}) is one this client\u2019s own write guards refuse, so this screen will not stage a removal or replacement built from it. The row stays listed for display (the read/write split, DR-059); closing that gap belongs to the client\u2019s staticroute module, not to a re-spelled command line here.`
  }
  const controlOrBreak = (value: string): boolean => CONTROL_CHARS.test(value) || LINE_BOUNDARY.test(value) || /\s/u.test(value)
  const segment = badSegment('destination', row.ipDest, !IP_DEST.test(row.ipDest))
  if (segment !== undefined) return segment
  const hop = badSegment('next hop', row.nextHop, controlOrBreak(row.nextHop))
  if (hop !== undefined) return hop
  if (row.nextHopIp !== undefined) {
    const inner = badSegment('next-hop address', row.nextHopIp, controlOrBreak(row.nextHopIp))
    if (inner !== undefined) return inner
  }
  return badSegment('route name', row.routeName ?? '', row.routeName !== undefined && controlOrBreak(row.routeName))
}

/**
 * Validate, compose and guard in one pure step, so the refusal ORDER is pinned too: field guards
 * first (zero sessions paid for), then the no-op check, then the destructive decision. The container
 * turns an {@link StagedIntent} into a named session; it never composes text itself.
 */
export function stageRoute(fields: RouteFields, rows: readonly RouteRow[]): StageOutcome {
  switch (fields.action) {
    case 'add-route': {
      const destProblem = ipDestRefusal(fields.prefix)
      if (destProblem !== undefined) return { refusal: destProblem }
      const hopProblem = nextHopRefusal(fields.nextHop)
      if (hopProblem !== undefined) return { refusal: hopProblem }
      const dest = fields.prefix.trim()
      if (fields.distance.trim() === '') {
        return { refusal: `This screen requires a distance on a new route: the client's reader needs the \\d+ group (staticroute.py:72), so a line written without one is invisible to every later read of this table — upstream distance-required is divergence 6, pinned in staticroute.test.ts. The client itself would compose the bare line (its spec pins ip route 222.22.222.0/24 Null0), and its own error-path pin shows a device refusing a distance-less one, so this screen keeps the field required and the device keeps authority over every distance value.` }
      }
      const distanceProblem = unsignedSegmentRefusal('distance', fields.distance)
      if (distanceProblem !== undefined) return { refusal: distanceProblem }
      const tagProblem = unsignedSegmentRefusal('tag', fields.tag)
      if (tagProblem !== undefined) return { refusal: tagProblem }
      if (fields.routeName !== '' && routeNameRefusal(fields.routeName) !== undefined) {
        return { refusal: routeNameRefusal(fields.routeName) as string }
      }
      const command = routeLine(
        dest,
        fields.nextHop.trim(),
        undefined,
        fields.distance.trim(),
        fields.tag.trim() === '' ? undefined : fields.tag.trim(),
        fields.routeName.trim() === '' ? undefined : fields.routeName.trim(),
      )
      if (rows.some((row) => lineOfRow(row) === command)) {
        return { refusal: `${command} is already one of the lines this read answered — staging it again opens a named session that would change nothing. A second next hop for the same destination is a different line and is still offered.` }
      }
      const guard = addDefaultGuard(dest)
      return { intent: guard === undefined ? { command } : { command, guard } }
    }

    case 'remove-route': {
      const row = findRow(rows, fields.routeKey)
      if (row === undefined) return { refusal: 'The selection does not match a route the device answered. Reload the table before removing anything — this screen will not stage a removal it cannot see.' }
      const unwriteable = rowSegmentRefusal(row)
      if (unwriteable !== undefined) return { refusal: unwriteable }
      const command = removalLineOf(row)
      const guard = routeGuard(row, gatewayCandidates(rows))
      return { intent: guard === undefined ? { command, row } : { command, row, guard } }
    }

    case 'set-tag':
    case 'set-name': {
      const row = findRow(rows, fields.routeKey)
      if (row === undefined) return { refusal: 'The selection does not match a route the device answered. Reload the table first — a replacement line is built from the read row, and this screen will not invent its segments.' }
      const unwriteable = rowSegmentRefusal(row)
      if (unwriteable !== undefined) return { refusal: unwriteable }
      if (fields.action === 'set-tag') {
        if (fields.tag.trim() === '') return { refusal: 'Setting a tag needs a value. This client has no verb that clears a route tag: staticroute.py only ever re-sends the leaf line WITH a `tag N` segment (set_tag, :247-271), and #80 asks for setTag/setRouteName only — so no clearing write is offered here. That is the client contract refusing, not this page tidying.' }
        const problem = unsignedSegmentRefusal('tag', fields.tag)
        if (problem !== undefined) return { refusal: problem }
        if (row.tag !== undefined && Number(row.tag) === Number(fields.tag.trim())) {
          return { refusal: `This route already carries tag ${String(row.tag)} in the read table, so staging ${replacementLineOf(row, { tag: fields.tag })} would change nothing. (Digit spellings such as 010 compare equal: the client composes the digits given, and its reader answers the int.)` }
        }
        return { intent: { command: replacementLineOf(row, { tag: fields.tag }), row } }
      }
      if (fields.routeName === '') return { refusal: 'Setting a route name needs a value. The client composes no name negation for a static-route leaf (there is no `no name` verb in staticroute.py:247-297), so this screen offers no way to clear one — the device contract owns that gap, not this UI.' }
      const problem = routeNameRefusal(fields.routeName)
      if (problem !== undefined) return { refusal: problem }
      if (row.routeName !== undefined && row.routeName === fields.routeName.trim()) {
        return { refusal: `This route already carries name ${row.routeName} in the read table, so staging the replacement would change nothing.` }
      }
      return { intent: { command: replacementLineOf(row, { routeName: fields.routeName }), row } }
    }
  }
}

/** The whole-table honesty note the view prints: absence here is NOT absence on the device. */
export const READ_SCOPE_NOTE = 'The table is the parsed running-config, not the active RIB: this client has no show-model for static routes at all (no `show ip route` extraction exists), so nothing here says a route is installed or working. The read grammar is the client\u2019s own \u2014 an `ip route vrf \u2026` line, an `ipv6 route` line, or an `ip route` line with no distance is invisible to it (staticroute.ts divergences 4 and 6) \u2014 so an empty table means "none this client can read", not "none configured".'
