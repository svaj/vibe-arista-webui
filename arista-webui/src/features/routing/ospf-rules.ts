/**
 * #87 (OSPF slice): the pure rules behind the OSPF process editor (`#/routing/ospf`). No React, no
 * fetches, no device handles — every composed line here is byte-for-byte the text the CLIENT's own
 * verb sends, cited to its `ospf.ts` body and guarded by the same byte in `ospf.test.ts`'s
 * `sentScripts`.
 *
 * ## Why this screen mirrors instead of calling (SPEC-ospf-editor.md, "Staged-lines contract")
 *
 * `ospf.ts` verbs are **send-only** — unlike `vrrp.ts` (DR-152's dry-run seam), there is no
 * `{ run: false }` arm to ask for the composed text. So the screen stages the same line sequence
 * the client would send: the process opener (`router ospf <pid>`, `ospf.ts` `create`), the
 * submode batches (`configureOspf` → `submodeCommands`, `command-builder.ts:160-171` — the header
 * opens the submode ONCE per verb call, so each batch is `[header, ...subcommands]`, NOT the
 * route-map shape that repeats the header per statement), and the single-line create/delete
 * openers. This is the DR-153 mirroring convention (StaticRoutes/Ntp/routemaps) — every line is a
 * client-verb text pinned by a client test, so mirroring IS the pin (NOT a DR-151 capture deviation).
 *
 * ## What stays closed (the spec's Out of scope)
 *
 * No `default router-id` arm (the client has it; the VRRP/route-map precedent keeps `default` arms
 * out until asked); no `passive-interface` (hardware-proven grammar but NO client verb — inventing
 * its text is the DR-141 failure class); no invented redistribution vocabulary (the client's
 * four-protocol allow-list is the boundary, DR-032); nothing here touches `ip routing` (the audit's
 * #87 Do-Not-Do); nothing here commits (the Transaction Center owns commit/abort, #141).
 */
import type { OspfNetwork, OspfState } from '@devhax-heavy-industries/arista-eapi'

// ------------------------------------------------------------------------------------------------
// Line builders — each cites the client verb whose text it mirrors. The process header appears ONCE
// per batch (the client's submodeCommands shape), unlike the route-map per-statement header.
// ------------------------------------------------------------------------------------------------

/** The process opener / submode header — `router ospf <pid>` (the client's `configureOspf` opener). */
export function ospfProcessHeaderLine(processId: string): string {
  return `router ospf ${processId}`
}

/**
 * The create batch — the client's `create()` (`ospf.ts`, zero reads): ONE line
 * `router ospf <pid>` (+ ` vrf <name>` when a vrf is given), no submode.
 */
export function ospfCreateLines(processId: string, vrf?: string): readonly string[] {
  return [`${ospfProcessHeaderLine(processId)}${vrf === undefined || vrf === '' ? '' : ` vrf ${vrf}`}`]
}

/**
 * The delete-process batch — the client's `delete()` (`ospf.ts`): one top-level
 * `no router ospf <pid>`, no submode. Removes the whole process (adjacencies, advertisements,
 * redistributions) — the client reads first and sends NOTHING when there is no process; the caller
 * refuses that at zero appends instead.
 */
export function ospfDeleteProcessLines(processId: string): readonly string[] {
  return [`no ${ospfProcessHeaderLine(processId)}`]
}

/** The router-id set batch — the client's `setRouterId`: header + `router-id <value>`. */
export function ospfRouterIdLines(processId: string, value: string): readonly string[] {
  return [ospfProcessHeaderLine(processId), `router-id ${value}`]
}

/** The router-id clear batch — the client's `unsetRouterId`: header + `no router-id`. */
export function ospfUnsetRouterIdLines(processId: string): readonly string[] {
  return [ospfProcessHeaderLine(processId), 'no router-id']
}

/** The shutdown batch — the client's `shutdown()`: header + `shutdown`. */
export function ospfShutdownLines(processId: string): readonly string[] {
  return [ospfProcessHeaderLine(processId), 'shutdown']
}

/** The no-shutdown batch — the client's `noShutdown()`: header + `no shutdown`. */
export function ospfNoShutdownLines(processId: string): readonly string[] {
  return [ospfProcessHeaderLine(processId), 'no shutdown']
}

/**
 * The network-add batch — the client's `addNetwork`: header + `network <net>/<mask> area <area>`.
 * The area text is exactly what the caller validated (digits or a dotted quad, divergence 4).
 */
export function ospfAddNetworkLines(processId: string, network: string, mask: string, area: string): readonly string[] {
  return [ospfProcessHeaderLine(processId), `network ${network}/${mask} area ${area}`]
}

/** The network-remove batch — the client's `removeNetwork`: header + `no network <net>/<mask> area <area>`. */
export function ospfRemoveNetworkLines(processId: string, network: string, mask: string, area: string): readonly string[] {
  return [ospfProcessHeaderLine(processId), `no network ${network}/${mask} area ${area}`]
}

/**
 * The redistribution-add batch — the client's `addRedistribution`: header +
 * `redistribute <protocol>[ route-map <name>]`.
 */
export function ospfAddRedistributionLines(processId: string, protocol: string, routeMap?: string): readonly string[] {
  return [ospfProcessHeaderLine(processId), `redistribute ${protocol}${routeMap === undefined || routeMap === '' ? '' : ` route-map ${routeMap}`}`]
}

/**
 * The redistribution-remove batch — the client's `removeRedistribution`: header + the BARE
 * `no redistribute <protocol>` (module divergence 10: the client takes no route-map argument, so a
 * qualified line negates with the bare form — the confirm states what that may cover).
 */
export function ospfRemoveRedistributionLines(processId: string, protocol: string): readonly string[] {
  return [ospfProcessHeaderLine(processId), `no redistribute ${protocol}`]
}

// ------------------------------------------------------------------------------------------------
// Validation — mirrors the client's guards (grammar, not device bounds; DR-120). A value that
// passes these may still be refused by the device; that refusal is the device's own answer
// (DR-057), surfaced verbatim at commit time.
// ------------------------------------------------------------------------------------------------

/** The client's `assertProcessId` (`ospf.ts`): digits, and pyeapi's own 1..65535 bound (DR-032). */
export function validateOspfProcessId(value: string): string | undefined {
  if (value.trim() === '') return 'A process id is required — the process is addressed by `router ospf <pid>`.'
  if (!/^\d+$/u.test(value)) return `Process id \`${value}\` is not digits — the client composes normalized digits only (module divergence 6: pyeapi int()-coerces then interpolates the RAW argument); the reader re-produces \\d+ (ospf.py:96).`
  const numeric = Number(value)
  if (!(numeric >= 1 && numeric <= 65535)) return `Process id \`${value}\` is outside 1-65535 — that is pyeapi's own bound (ospf.py:235-236), kept verbatim even though it predates 4-byte numbers; whether 4.28 accepts larger ids is the device's answer (DR-032).`
  return undefined
}

/** The client's `assertVrfName` (`ospf.ts`): the `\\w+` the reader captures (ospf.py:109). */
export function validateOspfVrfName(value: string): string | undefined {
  if (value === '') return undefined // blank = the default VRF, no vrf arm composed
  if (!/^\w+$/u.test(value)) return `VRF name \`${value}\` is outside the reader grammar — \\w+ (numbers, letters, underscore; ospf.py:109 captures (\\w+)). A name outside it TRUNCATES on read (module divergence 9), so this screen never sends one.`
  return undefined
}

/** The client's `assertToken` (`ospf.ts`): non-empty, one token, no control characters. */
export function validateOspfToken(label: string, value: string): string | undefined {
  if (value.trim() === '') return `A ${label} is required — pyeapi checks only the empty string (ospf.py:287-288) and interpolates anything else; this client refuses the empty and the line-unsafe alike.`
  if (/\s/u.test(value)) return `A ${label} with whitespace splits the command line this client composes and breaks the reader that re-captures it.`
  if (hasControlCharacter(value)) return `A ${label} must not carry a control character — it would break the config line this client reads back.`
  return undefined
}

/** The client's `assertMaskLen` (`ospf.ts`): the `(\\d+)` of the networks reader (ospf.py:141). */
export function validateOspfMaskLen(value: string): string | undefined {
  if (value.trim() === '') return 'A mask length is required — the network line is `network <net>/<mask> area <area>`.'
  if (!/^\d+$/u.test(value)) return `Mask \`${value}\` is not digits — the reader captures (\\d+) in the \`network X/<len>\` line (ospf.py:141).`
  return undefined
}

/** The client's `assertArea` (`ospf.ts`): bare digits OR a dotted quad (the write shape and the read shape, divergence 4). */
export function validateOspfArea(value: string): string | undefined {
  if (!/^(\d+|\d+\.\d+\.\d+\.\d+)$/u.test(value)) return `Area \`${value}\` is neither bare digits nor a dotted quad — the reader anchors \`area (\\d+\\.\\d+\\.\\d+\\.\\d+)\` (ospf.py:141) and the client writes bare digits, so anything else composes a line NEITHER side can name (divergence 4).`
  return undefined
}

/** The client's `assertProtocol` (`ospf.ts`): the four-protocol allow-list (ospf.py:323/:347, DR-032). */
export function validateOspfProtocol(value: string): string | undefined {
  if (!OSPF_REDISTRIBUTION_PROTOCOLS.includes(value)) return `Protocol \`${value}\` is outside the client's redistribution allow-list — this client composes only ${OSPF_REDISTRIBUTION_PROTOCOLS.join(', ')} (pyeapi hard-codes exactly those four, ospf.py:323/:347); whether 4.28 redistributes more (ospf itself, isis, …) is a device-capture question, not this screen's to guess (DR-032).`
  return undefined
}

/** The client's redistribution allow-list (`ospf.ts` `REDISTRIBUTION_PROTOCOLS`), as data for the picker. */
export const OSPF_REDISTRIBUTION_PROTOCOLS: readonly string[] = ['bgp', 'rip', 'static', 'connected']

function hasControlCharacter(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001F\u007F]/u.test(value)
}

// ------------------------------------------------------------------------------------------------
// Reads → rows and duplicate predicates.
// ------------------------------------------------------------------------------------------------

/** One configured network, flattened for display + the remove picker's value. */
export interface OspfNetworkRow {
  readonly network: string
  readonly mask: string
  readonly area: string
  /** The picker value: `<network>/<mask>@<area>` (the whole triple the remove line needs). */
  readonly target: string
}

export function ospfNetworkTarget(network: string, mask: string, area: string): string {
  return `${network}/${mask}@${area}`
}

export function parseOspfNetworkTarget(target: string): OspfNetwork | undefined {
  const match = /^(.+)\/(\d+)@(\d+\.\d+\.\d+\.\d+|\d+)$/u.exec(target)
  if (match === null) return undefined
  return { network: match[1] as string, netmask: match[2] as string, area: match[3] as string }
}

/** The read's networks, flattened. Only dotted-quad areas ever appear here (divergence 4) — the form note says so. */
export function ospfNetworkRows(state: OspfState): readonly OspfNetworkRow[] {
  return state.networks.map((row) => ({
    network: row.network,
    mask: row.netmask,
    area: row.area,
    target: ospfNetworkTarget(row.network, row.netmask, row.area),
  }))
}

/** One configured redistribution, flattened for display + the remove picker's value. */
export interface OspfRedistributionRow {
  readonly protocol: string
  readonly routeMap: string
  /** The picker value: the protocol (+ `/<route-map>` when qualified) — removal composes the bare form. */
  readonly target: string
}

export function ospfRedistributionRows(state: OspfState): readonly OspfRedistributionRow[] {
  return state.redistributions.map((row) => ({
    protocol: row.protocol,
    routeMap: row.routeMap ?? '(none)',
    target: row.routeMap === undefined ? row.protocol : `${row.protocol}/${row.routeMap}`,
  }))
}

/** True when the read already lists this exact network triple (the add form refuses a duplicate). */
export function ospfNetworkPresent(state: OspfState, network: string, mask: string, area: string): boolean {
  return state.networks.some((row) => row.network === network && row.netmask === mask && row.area === area)
}

/** True when the read already lists this protocol (+ route-map when the draft names one). */
export function ospfRedistributionPresent(state: OspfState, protocol: string, routeMap?: string): boolean {
  return state.redistributions.some((row) => row.protocol === protocol && (routeMap === undefined || routeMap === '' ? true : row.routeMap === routeMap))
}

/** The route-map names the running-config read lists — used ONLY to annotate a redistribution's map, never to refuse. */
export function ospfRouteMapKnown(knownNames: ReadonlySet<string>, routeMap: string): boolean {
  return knownNames.has(routeMap)
}

// ------------------------------------------------------------------------------------------------
// Risk / confirm copy (SPEC-ospf-editor.md). Facts, not adjectives (DR-149): the ONLY measured OSPF
// blasts in the repo are the two-node cEOS lane, and each is quoted with its TRUE mechanism — the
// 67 ms / 6170 ms route blast was a `no network … area …` statement removal, the 32636 ms / 12279 ms
// adjacency blast was a transit-network removal, NOT the command being staged. Container evidence,
// never this unit (DR-043). No invented numbers.
// ------------------------------------------------------------------------------------------------

/** The staged-line restatement every entry's risks open with (the S15 `readBack` pattern). */
export function ospfReadBack(lines: readonly string[]): string {
  return `The staged lines: ${lines.map((line) => `\`${line}\``).join(' + ')} — byte-for-byte the line sequence the client's own ospf verbs compose (mirrored per ospf-rules.ts citations; the process header opens the submode once); the device diff, not this screen, decides what running-config actually keeps.`
}

/** The route blast, quoted with its exact mechanism. */
export const OSPF_ROUTE_BLAST_FACT =
  'The closest measured route blast (two-node cEOS-lab 4.28.14M: a route withdrawn in 67 ms, restored in 6170 ms) was produced by a committed `no network <net>/<mask> area <area>` statement — an OSPF advertisement withdrawal. Container evidence, not measured on this unit (DR-043).'

/** The adjacency blast, quoted with its exact mechanism and the honest "not this command" scoping. */
export const OSPF_ADJACENCY_BLAST_FACT =
  'The closest measured adjacency blast (two-node cEOS-lab 4.28.14M: an adjacency dropped in 32636 ms, reformed in 12279 ms) was produced by removing a transit-network `network` statement — NOT by the command being staged here. Container evidence, not measured on this unit (DR-043).'

/** The router-id mechanism, honestly unmeasured for this verb. */
export const OSPF_ROUTER_ID_MECHANISM =
  'A live OSPF process that changes its router-id re-originates its router LSA and re-forms adjacencies; that re-formation blast is NOT measured for this verb on any target — no number is claimed.'

/** The create posture: what the box runs today, so a create is not mistaken for enabling routing. */
export const OSPF_CREATE_POSTURE =
  'This box runs `no ip routing` and zero `router ospf` sections today (captured). Creating a process is configured state and does not by itself enable inter-VLAN routing or form adjacencies until `ip routing` is on and a network statement matches — that inertness is a stated posture, not a measured blast. This screen never touches `ip routing` (#87 Do-Not-Do).'

/** The single-process modeling note (module divergence 7). */
export const OSPF_SINGLE_PROCESS_NOTE =
  'This client reads and writes ONE process — the FIRST `router ospf …` section in the running-config (module divergence 7: `configure_ospf` has no vrf arm). On a multi-process node, every write here lands on that first process; the `show ip ospf` device panel may list instances the config read does not, and the two panels are never merged.'

/** The area asymmetry note (divergence 4), shown on the network form. */
export const OSPF_AREA_ASYMMETRY_NOTE =
  'The area field accepts bare digits or a dotted quad. This client\'s own reader only sees dotted-quad areas (module divergence 4), so a line written with a bare `area 0` never appears back in this table — the console is the escape hatch for removing one. The default here is `0.0.0.0` so a staged line round-trips into the table.'

/** The bare-negation note (divergence 10), shown on the redistribution-remove confirm. */
export function ospfBareNegationFact(protocol: string, qualifiedCount: number): string {
  return `This client negates a redistribution with the BARE \`no redistribute ${protocol}\` (module divergence 10 — it takes no route-map argument). The running-config read lists ${String(qualifiedCount)} line(s) for \`${protocol}\`; whether one bare negation clears all of them on a real 4.28 box is an uncaptured device question, so review the committed diff.`
}

/** The dangling route-map annotation (a risk line, never a refusal). */
export function ospfRouteMapUnlistedFact(routeMap: string): string {
  return `The running-config read does not name route-map \`${routeMap}\`. The device accepts a dangling route-map reference at stage time (captured, run 9) — whether it matters when the redistribution is evaluated is the device's answer. This screen annotates it, it does not block it.`
}

/** The unknown arm when the route-map name list could not be read. */
export const OSPF_ROUTE_MAP_READ_UNKNOWN =
  'The route-map reference check did not answer on this device, so this screen cannot say whether the redistribution\'s route-map name exists. Treat the name as unverified.'

/** The far-end note (non-gating, the DR-149 informational pattern). */
export const OSPF_FAR_END_NOTE =
  'This UI cannot see the peer side of any adjacency, BGP (unmodelled on this SKU), or any route policy beyond the redistribution line and the running-config route-map read.'

export function ospfEditRisks(lines: readonly string[], blastFacts: readonly string[]): readonly string[] {
  return [ospfReadBack(lines), ...blastFacts, OSPF_FAR_END_NOTE]
}

/** The shape the coordinator's per-entry `confirmations` seam takes (TransactionConfirmation). */
export interface OspfConfirmation {
  readonly title: string
  readonly body: string
  readonly label: string
  readonly subject: string
}

function confirmation(what: string, subject: string, body: string, accept: string): OspfConfirmation {
  return {
    title: `Second confirm: OSPF ${what}`,
    body,
    label: `I accept the OSPF blast: commit ${accept}`,
    subject,
  }
}

/** The create confirm — the posture, not a blast. */
export function ospfCreateConfirmation(processId: string, vrf?: string): OspfConfirmation {
  const subject = `router ospf ${processId}${vrf === undefined || vrf === '' ? '' : ` vrf ${vrf}`}`
  return confirmation(`create ${subject}`, subject, OSPF_CREATE_POSTURE, `the process create \`${subject}\``)
}

/** The delete-process confirm — the whole process, with the adjacency blast. */
export function ospfDeleteProcessConfirmation(processId: string): OspfConfirmation {
  const subject = `no router ospf ${processId}`
  return confirmation(`delete process router ospf ${processId}`, subject, `Deleting \`router ospf ${processId}\` removes the WHOLE process — its adjacencies, advertised networks, and redistributions at once. ${OSPF_ADJACENCY_BLAST_FACT} This cannot be undone from the running-config; a prior startup-config save would be the only recovery, and this screen never writes startup (DR-024).`, `the whole-process delete \`${subject}\``)
}

/** The router-id set/clear confirm — the unmeasured re-formation mechanism. */
export function ospfRouterIdConfirmation(processId: string, what: 'set' | 'clear'): OspfConfirmation {
  const subject = `router ospf ${processId}`
  return confirmation(`router-id ${what} on ${subject}`, subject, `Changing the router-id of a running OSPF process re-originates its router LSA and re-forms adjacencies. ${OSPF_ROUTER_ID_MECHANISM} ${OSPF_ADJACENCY_BLAST_FACT}`, `the router-id ${what}`)
}

/** The network-add confirm — the route blast proxy. */
export function ospfNetworkAddConfirmation(processId: string, network: string, mask: string, area: string): OspfConfirmation {
  const subject = `router ospf ${processId}`
  return confirmation(`add network ${network}/${mask} area ${area} on ${subject}`, subject, `Adding a network statement starts OSPF on that interface and ADVERTISES the prefix into the area — it can admit routes. ${OSPF_ROUTE_BLAST_FACT}`, `the network add \`network ${network}/${mask} area ${area}\``)
}

/** The network-remove confirm — the exact measured route-blast mechanism. */
export function ospfNetworkRemoveConfirmation(processId: string, network: string, mask: string, area: string): OspfConfirmation {
  const subject = `router ospf ${processId}`
  return confirmation(`remove network ${network}/${mask} area ${area} on ${subject}`, subject, `Removing a network statement WITHDRAWS the prefix it advertised and can drop the adjacency on that interface. This is the exact verb the measured blast used: a \`no network <net>/<mask> area <area>\` removal withdrew a route in 67 ms (restored in 6170 ms) on the two-node cEOS-lab — container evidence, not this unit (DR-043).`, `the network remove \`no network ${network}/${mask} area ${area}\``)
}

/** The redistribution-add confirm — the route blast + the dangling-map annotation. */
export function ospfRedistributionAddConfirmation(processId: string, protocol: string, routeMap: string | undefined, mapFacts: readonly string[]): OspfConfirmation {
  const subject = `router ospf ${processId}`
  const line = `redistribute ${protocol}${routeMap === undefined || routeMap === '' ? '' : ` route-map ${routeMap}`}`
  return confirmation(`redistribute ${protocol} on ${subject}`, subject, `Redistributing \`${protocol}\` injects routes from another source into OSPF — it can advertise prefixes OSPF would not otherwise carry. ${OSPF_ROUTE_BLAST_FACT} ${mapFacts.join(' ')}`, `the redistribution add \`${line}\``)
}

/** The redistribution-remove confirm — the bare-negation divergence + the route blast. */
export function ospfRedistributionRemoveConfirmation(processId: string, protocol: string, qualifiedCount: number): OspfConfirmation {
  const subject = `router ospf ${processId}`
  return confirmation(`no redistribute ${protocol} on ${subject}`, subject, `Removing the \`${protocol}\` redistribution WITHDRAWS every route it was injecting. ${OSPF_ROUTE_BLAST_FACT} ${ospfBareNegationFact(protocol, qualifiedCount)}`, `the redistribution remove \`no redistribute ${protocol}\``)
}

/** The shutdown / no-shutdown confirm — the adjacency blast, honestly scoped. */
export function ospfShutdownConfirmation(processId: string, turningOff: boolean): OspfConfirmation {
  const subject = `router ospf ${processId}`
  const body = turningOff
    ? `Shutting down the OSPF process tears down every adjacency and withdraws every route it advertises at once. ${OSPF_ADJACENCY_BLAST_FACT}`
    : `Bringing the OSPF process up starts forming adjacencies and advertising its networks — routes appear as adjacencies form. ${OSPF_ADJACENCY_BLAST_FACT}`
  return confirmation(`${turningOff ? 'shutdown' : 'no shutdown'} on ${subject}`, subject, body, `the \`${turningOff ? 'shutdown' : 'no shutdown'}\``)
}

/** The standing banner: what this screen is and what it never does. */
export const OSPF_EDITOR_STANDING_NOTE =
  'This screen edits the OSPF process — the routing that decides which prefixes this switch advertises and which it learns. Every confirm quotes the only measured OSPF blasts in this repo (the two-node cEOS-lab lane) and says exactly what produced each; none was measured on this unit. Writes stage into the shared transaction; the device diff is reviewed in Transaction Center before that commit, which touches running-config only (DR-024). `ip routing` is never touched (#87 Do-Not-Do).'

/** Named reason when the SOFT route-map reference read failed — the annotation degrades to unknown. */
export const OSPF_ROUTE_MAP_READ_UNAVAILABLE_NOTE =
  'The `routemaps.getAll()` read did not answer on this device, so a redistribution\'s route-map name cannot be checked against the running-config — the annotation says "unverified" rather than naming it missing. This is a read failure on this device right now, not a claim the map is absent. The process table and all forms are unaffected.'
