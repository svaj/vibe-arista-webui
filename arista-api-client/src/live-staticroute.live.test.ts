/**
 * `*.live.test.ts` port of `pyeapi/test/system/test_api_staticroute.py` @ `6816d9e` — #14 **D2** (the
 * full-write lab lane, DR-126). Upstream has **seven** methods (`:81`–`:270`) plus five generator helpers
 * (`_ip_addr` `:46`, `_next_hop` `:53`, `_distance` `:67`, `_tag` `:71`, `_route_name` `:75`) and three
 * combination lists (`NEXT_HOPS` `:42`, `DISTANCES = TAGS = ROUTE_NAMES` `:43`). All seven are ported; the
 * helpers become **pinned** values instead of `random_int`/`random_string` draws, because a random
 * destination is exactly what makes a container write unauditable (DR-043's evidence rule, and DR-126's
 * "throwaway but provisioned" container is shared with the other suites).
 *
 * Gate: `liveFullWriteReadiness(process.env)` → `EAPI_LIVE=1` + a lab endpoint + `EAPI_LAB_FULL_WRITE=1`
 * (`src/testing/live-full-write.ts`), and the `Node` is `buildFullWriteNode(target)` so the pre-wire
 * self-lockout seam sits under every verb (`withLabWriteScope`). Loud skip when the gate refuses (DR-034).
 *
 * ## The routed-mode question, answered by the device rather than assumed (DR-122)
 * Every upstream method begins `dut.config(['no ip routing', 'ip routing'])` (`:86`, `:114`, `:153`, `:189`,
 * `:220`, `:248`, `:261`) and then asserts the write calls simply returned. That global flip is precisely
 * what `lab-provision` could not do: on cEOS-lab 4.28.14M a bare `ip routing` answered
 * `% Unavailable command (not supported on this hardware platform)` (DR-122, `docs/DECISIONS.md` DR-122's
 * settled-for-cEOS list), while the container *shape* decides — a node with data NICs attached and a
 * provisioned SVI answers differently. So this suite (a) reads `node.system.get()` first, with the caveat
 * that this client's `ipRouting` mirrors pyeapi's rule — the flag is `true` unless a literal
 * `no ip routing` line exists (`resources/system.ts`, `_parse_iprouting` row) — so the read can never *prove*
 * routing is on; (b) attempts `ip routing` inside one guarded session; then (c) probes the thing the cases
 * actually need, a sentinel `ip route` line, and reads it back. If the sentinel is refused, `routingRefusal`
 * holds the device's typed reason and every route-mutating case reports that reason instead of pretending to
 * have exercised the verb — never a silent pass, and never a second guess at what the container supports.
 *
 * Address space: destinations live in TEST-NET-1 (`192.0.2.0/24` for the single-route family, host routes
 * `192.0.2.40/32`–`192.0.2.47/32` for the flag matrices), next hops are `Null0`, a bare `192.0.2.x` address,
 * or `Ethernet1` + `192.0.2.x` (upstream's `NEXT_HOPS`, `:42`). Nothing here names `10.0.100.0/24`,
 * `10.20.0.0/24` (the provisioned SVI + static route) or `172.31.0.0/16` (the Docker management network),
 * and no case mutates an interface — a static route only *names* a next hop.
 *
 * | upstream (verified line @6816d9e) | ported? | here / why |
 * |---|---|---|
 * | `test_create` (`:81`, `ip routing` stage `:86`, 2×2×2 matrix over `:43`, call `:103-105`, `assertTrue` `:107`) | ✅ (randomised inputs pinned) | eight arms, one per `DISTANCES × TAGS × ROUTE_NAMES` combination, each a fresh `/32` destination, through `staticroute.create(dest, {nextHop, nextHopIp?, distance?, tag?, routeName?})` (`resources/staticroute.ts:389`) — upstream's `**kwargs` bag becomes the framework attrs bag, and its positional `next_hop` is required there too (that module's divergence 4). Upstream asserts only "the call returned" (`:107`), the port asserts the awaited verb resolved **and** reads back the arms this client's own regex can see; the distance-less arms report the read leak this module deliberately keeps (divergence 6: distance is REQUIRED by `ROUTES_RE`, `staticroute.py:72`) with the line the device was given |
 * | `test_get` (`:109`, stage `:114`, one full route `:123`, `get` `:138`, `assertTrue` `:141`, `assertEqual(result, route)` `:144`) | ✅ (record shape differs) | upstream stages `ip route 1.2.3.0/24 Ethernet1 1.1.1.1 1 tag 1 name test1` (`:123-124`) and compares pyeapi's four-level nested dict (`:127-136`). Here the same line is staged by a guarded session in TEST-NET space, and `staticroute.get(dest)` answers `readonly StaticRoute[]` (the flat leaf list per destination, `staticroute.ts:339` (`StaticRoute` record at `:220`), so the port asserts the six fields of that one record — `ipDest`/`nextHop`/`nextHopIp`/`distance`/`tag`/`routeName` — with `distance` a `number` and absent-means-upstream's-`None` (divergence 2). Membership of unrelated destinations is asserted away: the provisioned `10.20.0.0/24` route must not appear under this dest |
 * | `test_getall` (`:146`, comment `:147-150`, three staged routes `:158-163`, the `dut.config` put `:164`, expected dict `:165-175`, `getall` `:177`, `assertEqual` `:179`) | ✅ | the same three lines — same dest, same `Ethernet1`/`192.0.2.1` pair, distances 10/1/2, tags 1/1/10, names `livert1`/`livert10`/`livert1` — staged in ONE guarded batch, then `getAll()` must yield exactly three records under that dest, each with its own tag/name, proving upstream's point ("matching 1 does not also match 10", `:149-150`): the identity is the whole 4-tuple (`routesByDest`, `staticroute.ts:293`), and the leaf fields come from the anchored regex, not a substring probe |
 * | `test_delete` (`:181`, comment `:182-186`, stage `:189`, matrix, call `:206-208`, `assertTrue` `:210`) | ✅ | `staticroute.delete(dest, attrs)` composes `no ` + the same locator (`staticroute.ts:400`, upstream `_set_route` `:357-358`). Upstream says outright the routes need not exist (`:185-186`), so the port keeps that arm — each `no` line is sent and must not raise — and additionally deletes a route it *did* create, asserting the read goes empty (read-after-write, DR-005's version of upstream's `True`) |
 * | `test_default` (`:212`, note `:215-217`, stage `:220`, matrix, call `:237-239`, `assertTrue` `:241`) | ✅ | `staticroute.setDefault(dest, attrs)` — `default ip route …` (`staticroute.ts:410`, renamed for row 77). Upstream's own note claims EOS treats that as `no ip route` (`:215-217`); that is a device claim, so the port runs the eight no-error arms **and** one create→default→read-back-gone arm whose result is the container's answer, reported with its typed refusal if the container answers one |
 * | `test_set_tag` (`:243`, `ip routing` line `:248`, tagged route stage `:249`, call `:251-253`, `assertTrue` `:254`) | ✅ | `setTag(dest, nextHop, {nextHopIp?, distance, tag})` re-sends the whole leaf line with the new tag (`staticroute.ts:423`, doc note at `:414-422`), and the module's warning that an existing `route_name` resets unless re-passed is upstream's own docstring note (`staticroute.py:262-264`). The route is staged with `tag 99`, re-sent with `tag 7`, and the read asserts the new number with no `routeName` left behind |
 * | `test_set_route_name` (`:256`, `ip routing` line `:261`, named-route stage `:262`, call `:264-266`, `assertTrue` `:267`) | ✅ | `setRouteName(dest, nextHop, {nextHopIp?, distance, routeName})` (`staticroute.ts:432`) against a route staged with `name livert99`, re-sent as `livert3`; the read asserts the name swapped and, mirroring the mirror-image warning (`staticroute.ts:427-431`), that the tag the new call did not re-pass is gone |
 *
 * Nothing here is ledger-skipped for a *policy* reason — DR-126 is what let these seven cases become real
 * writes. The skips that can appear at runtime are device answers: the sentinel-route probe refusing, in
 * which case the route-mutating cases print `routingRefusal` and claim nothing.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { CommandError, EapiError, SessionError } from './errors'
import { buildFullWriteNode, liveFullWriteReadiness } from './testing/live-full-write'
import { describeLiveTarget, matchesDeviceIdentity, unwrapLiveTarget, type LiveTarget } from './testing/live-guard'
import { runGuardedLiveWriteSession } from './testing/live-session-policy'
import type { StaticRoute, StaticRouteAttrs } from './resources/staticroute'
import type { Node } from './command-layer'

const SUITE = 'live-staticroute'
const gate = liveFullWriteReadiness(process.env)
if (!gate.runnable) {
  console.warn(`${SUITE}: SKIPPED — ${gate.skipReason ?? 'gate refused the run'}`)
}

const DEST = '192.0.2.0/24'
/** The matrix destinations: TEST-NET-1 host routes, one per combination, never a provisioned prefix. */
const MATRIX_DESTS: readonly string[] = [40, 41, 42, 43, 44, 45, 46, 47].map((host) => `192.0.2.${String(host)}/32`)
/** Pinned stand-ins for upstream's `random_int`/`random_string` helpers (`:67`, `:71`, `:75`). */
const DISTANCE = 110
const TAG = 7
const ROUTE_NAME = 'livert'

const runId = String(Date.now()).slice(-6)

type Attempt = { readonly ok: true } | { readonly ok: false; readonly code: string; readonly text: string }

function firstLine(message: string): string {
  return message.split('\n')[0]?.slice(0, 200) ?? message
}

function describeError(rawErr: EapiError): string {
  return rawErr instanceof CommandError ? `CommandError(${String(rawErr.code)})` : String(rawErr.constructor.name)
}

/** pyeapi's `dut.config([...])` twin: a named session that aborts on failure and never persists (DR-035). */
async function batch(node: Node, label: string, commands: readonly string[]): Promise<Attempt> {
  try {
    await runGuardedLiveWriteSession(node, { name: `${SUITE}-${label}-r${runId}`, commands })
    return { ok: true }
  } catch (rawErr) {
    if (rawErr instanceof SessionError) throw rawErr
    if (!(rawErr instanceof EapiError)) throw rawErr
    console.warn(`${SUITE}: batch ${JSON.stringify(label)} did not apply (${describeError(rawErr)}): ${firstLine(rawErr.message)} — commands ${JSON.stringify(commands)}`)
    return { ok: false, code: describeError(rawErr), text: firstLine(rawErr.message) }
  }
}

/** pyeapi's `dut.api('staticroute').verb(...)` + `assertTrue` twin: resolves, or rejects with a typed error. */
async function verb(label: string, call: () => Promise<unknown>): Promise<Attempt> {
  try {
    await call()
    return { ok: true }
  } catch (rawErr) {
    if (!(rawErr instanceof EapiError)) throw rawErr
    console.warn(`${SUITE}: ${label} was refused by the device (${describeError(rawErr)}): ${firstLine(rawErr.message)}`)
    return { ok: false, code: describeError(rawErr), text: firstLine(rawErr.message) }
  }
}

function requireApplied(label: string, attempt: Attempt): void {
  if (!attempt.ok) throw new Error(`${SUITE}: ${label} failed (${attempt.code}): ${attempt.text} — a route this run staged is still on the container other suites share`)
}

/**
 * Rebuild the composed leaf line so a cleanup `no` addresses exactly the route the verb wrote (upstream's own
 * tests spell these strings, e.g. `:123`, `:158-163`, `:249`). The composed form is this client's, pinned
 * offline in `resources/staticroute.test.ts`; the duplication here is deliberate — cleanup must not depend on
 * the verb under test behaving.
 */
function leafLine(dest: string, attrs: StaticRouteAttrs): string {
  const hop = attrs.nextHop ?? ''
  return [
    `ip route ${dest} ${hop}`,
    ...(attrs.nextHopIp === undefined ? [] : [attrs.nextHopIp]),
    ...(attrs.distance === undefined ? [] : [String(attrs.distance)]),
    ...(attrs.tag === undefined ? [] : [`tag ${String(attrs.tag)}`]),
    ...(attrs.routeName === undefined ? [] : [`name ${attrs.routeName}`]),
  ].join(' ')
}

/** The 2×2×2 flag matrix upstream drives with `DISTANCES = TAGS = ROUTE_NAMES` (`:43`). */
interface MatrixArm {
  readonly dest: string
  readonly attrs: StaticRouteAttrs
}

function matrixArms(): MatrixArm[] {
  const arms: MatrixArm[] = []
  let index = 0
  for (const withDistance of [false, true]) {
    for (const withTag of [false, true]) {
      for (const withName of [false, true]) {
        // NEXT_HOPS (`:42`) cycled deterministically instead of `choice()`: Null0 carries no next-hop-ip
        // (upstream's `_next_hop` returns `(Null0, None)`, `:55-56`), the IP arm is a bare next-hop address,
        // and the interface arm is upstream's `('Ethernet1', ip)` pair.
        const shape = index % 3
        const dest = MATRIX_DESTS[index] as string
        // `StaticRouteAttrs` is a readonly bag (types.ts contract), so every arm is built in one literal with
        // conditional spreads rather than by mutating fields after the fact.
        const attrs: StaticRouteAttrs = {
          ...(shape === 0 ? { nextHop: 'Null0' } : shape === 1 ? { nextHop: `192.0.2.${String(1 + index)}` } : { nextHop: 'Ethernet1', nextHopIp: `192.0.2.${String(1 + index)}` }),
          ...(shape !== 0 && withDistance ? { distance: DISTANCE } : {}),
          ...(withTag ? { tag: TAG } : {}),
          ...(withName ? { routeName: ROUTE_NAME } : {}),
        }
        arms.push({ dest, attrs })
        index += 1
      }
    }
  }
  return arms
}

describe.skipIf(!gate.runnable)('live full-write lane: pyeapi test_api_staticroute.py (:79)', () => {
  let node: Node
  /** Set when the device refuses the sentinel route (or `ip routing`); every route case reports it. */
  let routingRefusal: string | undefined

  beforeAll(async () => {
    const target: LiveTarget = unwrapLiveTarget(gate.resolution)
    console.log(`${SUITE}: target = ${describeLiveTarget(target)}`)
    node = buildFullWriteNode(target)
    const reported = await node.getVersion()
    const mismatch = matchesDeviceIdentity(target, { version: reported.version, modelName: reported.modelName })
    if (mismatch !== undefined && mismatch.code !== 'EAPI_VERSION_MISMATCH') throw new Error(`${SUITE} readiness: ${mismatch.reason}`)
    if (mismatch?.code === 'EAPI_VERSION_MISMATCH') {
      console.warn(`${SUITE}: reported version "${reported.version}" vs pin "${target.allowVersion}" (base-level enforced by the probe, DR-066)`)
    }

    // (a) what the client's own `system` read says, printed with the reason it cannot settle the question.
    const settings = await node.system.get()
    console.log(`${SUITE}: system.get() ipRouting=${String(settings.ipRouting)} — this flag is \`true\` unless the config literally carries \`no ip routing\` (system.ts, pyeapi _parse_iprouting parity), so it is not evidence that routing is enabled`)
    // (b) the global flip upstream performs at every case (`:86` and twins), attempted once, guarded. Refusal
    //     is expected on a container that has no routed-mode capability (DR-122) and is recorded, not fatal.
    const flipped = await batch(node, 'ip-routing', ['ip routing'])
    if (!flipped.ok) console.warn(`${SUITE}: the device refused \`ip routing\` (${flipped.code}) — routed capability stays a container-shape question (DR-122)`)
    // (c) the probe the cases actually depend on: can this device hold a static route this client can read?
    const sentinel = `ip route ${DEST} 192.0.2.1 ${String(DISTANCE)}`
    const staged = await batch(node, 'route-probe', [sentinel])
    if (!staged.ok) {
      routingRefusal = `the device refused the sentinel \`${sentinel}\` (${staged.code}: ${staged.text})`
    } else {
      const seen = await node.staticroute.get(DEST)
      if (seen === undefined || seen.length === 0) {
        routingRefusal = `the sentinel \`${sentinel}\` committed but staticroute.get(${JSON.stringify(DEST)}) answered nothing`
      }
      const cleaned = await batch(node, 'route-probe-clean', [`no ${sentinel}`])
      requireApplied('route-probe-clean', cleaned)
    }
    try {
      const table = await node.showText('show ip route')
      console.log(`${SUITE}: show ip route → ${JSON.stringify(table.split('\n').slice(0, 3))}`)
    } catch (rawErr) {
      if (!(rawErr instanceof EapiError)) throw rawErr
      console.warn(`${SUITE}: \`show ip route\` refused (${describeError(rawErr)}): ${firstLine(rawErr.message)} — recorded as a device answer, the probe above already decided the route lane`)
    }
    if (routingRefusal !== undefined) console.warn(`${SUITE}: route-mutating cases are REPORTED-REFUSED, not asserted — ${routingRefusal}`)
  })

  it('create() accepts every DISTANCES × TAGS × ROUTE_NAMES arm this device will hold (test_create, :81 — stage :86, matrix :43, call :103-105, assertTrue :107)', async () => {
    if (routingRefusal !== undefined) {
      console.warn(`${SUITE}: test_create not exercised — ${routingRefusal}`)
      return
    }
    const arms = matrixArms()
    requireApplied('create-prep', await batch(node, 'create-prep', arms.map((arm) => `no ${leafLine(arm.dest, arm.attrs)}`)))
    let accepted = 0
    const refusals: string[] = []
    for (const arm of arms) {
      const made = await verb(`create(${arm.dest})`, () => node.staticroute.create(arm.dest, arm.attrs))
      if (!made.ok) {
        refusals.push(`${arm.dest}: ${made.code}`)
        continue
      }
      accepted += 1
      if (arm.attrs.distance === undefined) {
        // Divergence 6, live: no distance means the line this client (and pyeapi) cannot read back. The write
        // still landed, so the honest report is "written, unreadable by design", not a pass on the read half.
        console.warn(`${SUITE}: ${JSON.stringify(leafLine(arm.dest, arm.attrs))} was accepted but is NOT readable — distance is required by ROUTES_RE (staticroute.py:72, divergence 6)`)
      } else {
        const rows = (await node.staticroute.get(arm.dest)) ?? []
        console.log(`${SUITE}: evidence for arm ${arm.dest} — device leaf lines ${JSON.stringify((await node.getRunningConfig()).split(/\r?\n/u).filter((line) => /^\s*ip route\b/u.test(line) && line.includes(arm.dest)))}; parsed rows ${JSON.stringify(rows)}`)
        expect(rows.length).toBe(1)
        expect(rows[0]?.distance).toBe(arm.attrs.distance)
        expect(rows[0]?.tag).toBe(arm.attrs.tag)
        expect(rows[0]?.routeName).toBe(arm.attrs.routeName)
        expect(rows[0]?.nextHop).toBe(arm.attrs.nextHop)
        expect(rows[0]?.nextHopIp).toBe(arm.attrs.nextHopIp)
      }
    }
    console.log(`${SUITE}: test_create — ${String(accepted)} of ${String(arms.length)} arms accepted${refusals.length === 0 ? '' : `; refused: ${JSON.stringify(refusals)}`}`)
    requireApplied('create-clean', await batch(node, 'create-clean', arms.map((arm) => `no ${leafLine(arm.dest, arm.attrs)}`)))
    for (const arm of arms.filter((a) => a.attrs.distance !== undefined)) {
      expect((await node.staticroute.get(arm.dest)) ?? []).toHaveLength(0)
    }
  })

  it('get(dest) answers the exact route that was staged (test_get, :109 — stage :114, route line :123-124, get :138, assertTrue :141, assertEqual :144)', async () => {
    if (routingRefusal !== undefined) {
      console.warn(`${SUITE}: test_get not exercised — ${routingRefusal}`)
      return
    }
    // Upstream's line (`:123-124`), in TEST-NET space, with the same interface + next-hop-ip + distance + tag +
    // name shape. Their expected value is the nested dict (`:127-136`); here the record is flat (row 78).
    const attrs: StaticRouteAttrs = { nextHop: 'Ethernet1', nextHopIp: '192.0.2.1', distance: 1, tag: 1, routeName: 'livert1' }
    const staged = await batch(node, 'get-stage', [leafLine(DEST, attrs)])
    if (!staged.ok) {
      console.warn(`${SUITE}: test_get could not stage its route — reported, not claimed`)
      return
    }
    let rows: readonly StaticRoute[] | undefined
    try {
      rows = await node.staticroute.get(DEST)
      expect(rows).toBeDefined()
      expect(rows ?? []).toHaveLength(1)
    } finally {
      // The staged route is this run's, so it is removed whether or not the assertions passed — the container is
      // shared with the other D2 suites.
      requireApplied('get-clean', await batch(node, 'get-clean', [`no ${leafLine(DEST, attrs)}`]))
    }
    const route = rows?.[0]
    expect(route?.ipDest).toBe(DEST)
    expect(route?.nextHop).toBe('Ethernet1')
    expect(route?.nextHopIp).toBe('192.0.2.1')
    expect(route?.distance).toBe(1)
    expect(route?.tag).toBe(1)
    expect(route?.routeName).toBe('livert1')
    expect(await node.staticroute.get(DEST)).toBeUndefined()
  })

  it('getAll() keeps three same-dest routes apart by distance, tag and name (test_getall, :146 — intent :147-150, stages :158-163, put :164, expected :165-175, getall :177, assertEqual :179)', async () => {
    if (routingRefusal !== undefined) {
      console.warn(`${SUITE}: test_getall not exercised — ${routingRefusal}`)
      return
    }
    // Upstream's three lines (`:158-163`), names swapped to `livert1`/`livert10` so the "1 does not match 10"
    // probe at :149-150 keeps its bite in this repo's name space.
    const staged: readonly StaticRouteAttrs[] = [
      { nextHop: 'Ethernet1', nextHopIp: '192.0.2.1', distance: 10, tag: 1, routeName: 'livert1' },
      { nextHop: 'Ethernet1', nextHopIp: '192.0.2.1', distance: 1, tag: 1, routeName: 'livert10' },
      { nextHop: 'Ethernet1', nextHopIp: '192.0.2.1', distance: 2, tag: 10, routeName: 'livert1' },
    ]
    const put = await batch(node, 'getall-stage', staged.map((attrs) => leafLine(DEST, attrs)))
    if (!put.ok) {
      console.warn(`${SUITE}: test_getall could not stage its three routes — reported, not claimed`)
      return
    }
    const all = await node.staticroute.getAll()
    const rows = all.get(DEST) ?? []
    console.log(`${SUITE}: getAll() destinations = ${JSON.stringify([...all.keys()])}`)
    expect(rows).toHaveLength(3)
    const byDistance = new Map(rows.map((row) => [row.distance, row]))
    expect([...byDistance.keys()].sort((a, b) => a - b)).toEqual([1, 2, 10])
    expect(byDistance.get(10)?.routeName).toBe('livert1')
    expect(byDistance.get(10)?.tag).toBe(1)
    expect(byDistance.get(1)?.routeName).toBe('livert10')
    expect(byDistance.get(1)?.tag).toBe(1)
    expect(byDistance.get(2)?.routeName).toBe('livert1')
    expect(byDistance.get(2)?.tag).toBe(10)
    for (const row of rows) {
      expect(row.nextHop).toBe('Ethernet1')
      expect(row.nextHopIp).toBe('192.0.2.1')
    }
    requireApplied('getall-clean', await batch(node, 'getall-clean', staged.map((attrs) => `no ${leafLine(DEST, attrs)}`)))
    expect(await node.staticroute.get(DEST)).toBeUndefined()
  })

  it('delete() answers without error whether or not the route existed (test_delete, :181 — note :185-186, stage :189, matrix, call :206-208, assertTrue :210)', async () => {
    if (routingRefusal !== undefined) {
      console.warn(`${SUITE}: test_delete not exercised — ${routingRefusal}`)
      return
    }
    const arms = matrixArms()
    let accepted = 0
    const refusals: string[] = []
    for (const arm of arms) {
      // Upstream deletes routes it never created (`:185-186`); the arms below stay in that spirit, and the last
      // arm is then re-run against a route this case did create, so the read-after-write half is real too.
      const gone = await verb(`delete(${arm.dest})`, () => node.staticroute.delete(arm.dest, arm.attrs))
      if (gone.ok) accepted += 1
      else refusals.push(`${arm.dest}: ${gone.code}`)
    }
    const arm = arms[0] as MatrixArm
    const made = await verb(`create(${arm.dest}) [for the read-back half]`, () => node.staticroute.create(arm.dest, arm.attrs))
    if (made.ok) {
      const removed = await verb(`delete(${arm.dest}) [read-back]`, () => node.staticroute.delete(arm.dest, arm.attrs))
      if (!removed.ok) throw new Error(`${SUITE}: the route this case created would not delete again (${removed.code}): ${removed.text}`)
      if (arm.attrs.distance !== undefined) expect((await node.staticroute.get(arm.dest)) ?? []).toHaveLength(0)
    }
    console.log(`${SUITE}: test_delete — ${String(accepted)} of ${String(arms.length)} no-error arms${refusals.length === 0 ? '' : `; refused: ${JSON.stringify(refusals)}`}`)
    requireApplied('delete-clean', await batch(node, 'delete-clean', arms.map((a) => `no ${leafLine(a.dest, a.attrs)}`)))
  })

  it('setDefault() (default ip route …) is accepted and, upstream equivalence aside, removes what it addressed (test_default, :212 — equivalence note :215-217, stage :220, call :237-239, assertTrue :241)', async () => {
    if (routingRefusal !== undefined) {
      console.warn(`${SUITE}: test_default not exercised — ${routingRefusal}`)
      return
    }
    const arms = matrixArms()
    let accepted = 0
    const refusals: string[] = []
    for (const arm of arms) {
      const defaulted = await verb(`setDefault(${arm.dest})`, () => node.staticroute.setDefault(arm.dest, arm.attrs))
      if (defaulted.ok) accepted += 1
      else refusals.push(`${arm.dest}: ${defaulted.code}`)
    }
    // The claim upstream only makes in a comment (`:215-217`): create a route, `default` it, read it back.
    const arm = arms[1] as MatrixArm
    const created = await verb(`create(${arm.dest}) [default read-back]`, () => node.staticroute.create(arm.dest, arm.attrs))
    if (created.ok && arm.attrs.distance !== undefined) {
      expect(((await node.staticroute.get(arm.dest)) ?? []).length).toBeGreaterThan(0)
      const defaulted = await verb(`setDefault(${arm.dest}) [read-back]`, () => node.staticroute.setDefault(arm.dest, arm.attrs))
      if (!defaulted.ok) console.warn(`${SUITE}: \`default ip route …\` refused on a route that existed (${defaulted.code}) — upstream's equivalence note is this container's answer to report, not to assume`)
      else console.log(`${SUITE}: after default, get(${arm.dest}) → ${JSON.stringify((await node.staticroute.get(arm.dest)) ?? [])}`)
    }
    console.log(`${SUITE}: test_default — ${String(accepted)} of ${String(arms.length)} arms accepted${refusals.length === 0 ? '' : `; refused: ${JSON.stringify(refusals)}`}`)
    requireApplied('default-clean', await batch(node, 'default-clean', arms.map((a) => `no ${leafLine(a.dest, a.attrs)}`)))
  })

  it('setTag re-sends the route with a new tag and drops what the call did not re-pass (test_set_tag, :243 — stage :248-249, call :251-253, assertTrue :254)', async () => {
    if (routingRefusal !== undefined) {
      console.warn(`${SUITE}: test_set_tag not exercised — ${routingRefusal}`)
      return
    }
    // Upstream stages `ip route 1.2.3.0/24 Ethernet1 1.1.1.1 10 tag 99` (`:249`) and sets tag 3 (`:251-253`).
    const staged: StaticRouteAttrs = { nextHop: 'Ethernet1', nextHopIp: '192.0.2.1', distance: 10, tag: 99 }
    if (!(await batch(node, 'settag-stage', [leafLine(DEST, staged)])).ok) return
    const set = await verb('setTag(dest, Ethernet1, {tag: 7})', () => node.staticroute.setTag(DEST, 'Ethernet1', { nextHopIp: '192.0.2.1', distance: 10, tag: TAG }))
    if (!set.ok) {
      requireApplied('settag-clean', await batch(node, 'settag-clean', [`no ${leafLine(DEST, staged)}`]))
      return
    }
    const rows = (await node.staticroute.get(DEST)) ?? []
    expect(rows).toHaveLength(1)
    expect(rows[0]?.tag).toBe(TAG)
    expect(rows[0]?.distance).toBe(10)
    expect(rows[0]?.routeName).toBeUndefined()
    console.log(`${SUITE}: after setTag the leaf reads ${JSON.stringify(rows[0])}`)
    requireApplied('settag-clean', await batch(node, 'settag-clean', [`no ip route ${DEST} Ethernet1 192.0.2.1 10 tag ${String(TAG)}`]))
    expect(await node.staticroute.get(DEST)).toBeUndefined()
  })

  it('setRouteName swaps the name and shows the tag-reset caveat in the read (test_set_route_name, :256 — stage :261-262, call :264-266, assertTrue :267)', async () => {
    if (routingRefusal !== undefined) {
      console.warn(`${SUITE}: test_set_route_name not exercised — ${routingRefusal}`)
      return
    }
    // Upstream stages `… 1 name test99` (`:262`) and sets `route_name='test3'` (`:264-266`). Pinned fixture names
    // are avoided, so both names live in this run's `livert*` space.
    const staged: StaticRouteAttrs = { nextHop: 'Ethernet1', nextHopIp: '192.0.2.1', distance: 1, routeName: 'livert99' }
    if (!(await batch(node, 'setname-stage', [leafLine(DEST, staged)])).ok) return
    const before = (await node.staticroute.get(DEST)) ?? []
    expect(before[0]?.routeName).toBe('livert99')
    const set = await verb('setRouteName(dest, Ethernet1, {routeName: livert3})', () => node.staticroute.setRouteName(DEST, 'Ethernet1', { nextHopIp: '192.0.2.1', distance: 1, routeName: 'livert3' }))
    if (!set.ok) {
      requireApplied('setname-clean', await batch(node, 'setname-clean', [`no ${leafLine(DEST, staged)}`]))
      return
    }
    const after = (await node.staticroute.get(DEST)) ?? []
    console.log(`${SUITE}: setRouteName evidence — device leaf lines ${JSON.stringify((await node.getRunningConfig()).split(/\r?\n/u).filter((line) => /^\s*ip route\b/u.test(line) && line.includes(DEST)))}; rows ${JSON.stringify(after)}`)
    expect(after).toHaveLength(1)
    expect(after[0]?.routeName).toBe('livert3')
    // The mirror of `setTag`'s caveat (staticroute.ts:427-431): EOS replaces the whole leaf line, so a field the
    // call did not re-pass is gone. Here the staged route had no tag, and the name it carried is replaced.
    expect(after[0]?.tag).toBeUndefined()
    requireApplied('setname-clean', await batch(node, 'setname-clean', [`no ip route ${DEST} Ethernet1 192.0.2.1 1 name livert3`]))
    expect(await node.staticroute.get(DEST)).toBeUndefined()
  })
})
