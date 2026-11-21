/**
 * B2 (#87): pure rules for the READ-ONLY routing status screen (`#/routing`). No fetches, no
 * device handles — every function here maps an already-read payload to renderable rows, so the
 * honesty rules are testable without a fake client.
 *
 * ## The evidence standing these rules encode (docs/BLOCKED-ISSUES-AUDIT.md, CAPTURES)
 *
 * - `show ip ospf` / `show ip ospf neighbor`: JSON captured on **cEOS-lab 4.28.14M only** (the
 *   7050TX sweep captured text-form empty output — the command RUNS on the switch, its JSON field
 *   set is not established there, DR-043). Every instance key is therefore optional and a missing
 *   key renders as "the answer carried no …", never a guess.
 * - Neighbor ENTRIES: both committed captures carry `ospfNeighborEntries: []`, so the entry shape
 *   is modelled as `unknown` and this screen renders only the COUNT. The two-node blast evidence
 *   (`docs/evidence/ospf-two-node.ceos.json`) records a real entry shape, but that is review
 *   evidence, not a committed fixture — no screen reads into these elements.
 * - `show route-map` / `show vrrp`: positive JSON on BOTH targets; the hardware answers are empty
 *   containers (`routeMaps: {}`, `virtualRouters: []`). VRRP element shape is carried by no
 *   capture, so the VRRP configured columns come from the typed `node.vrrp.getAll()` reader.
 * - `show bgp summary` / `show bgp neighbors`: the DOUBLE NEGATIVE stands (hardware `Error [1000]
 *   % Not supported`, cEOS `errors: ["Not supported"]`). The commands are UNMODELLED — this screen
 *   states the negative verbatim and renders no BGP data panel.
 *
 * Configured state always comes from the parsed running-config readers (`node.ospf.get()`,
 * `node.routemaps.getAll()`, `node.vrrp.getAll()`); device state always from the soft `show`
 * reads. The two are never merged (S14/#84 convention).
 */
import type { OspfState, RoutemapEntry, RoutemapEntryAttrs, Vrrp, VrrpVridTable } from '@devhax-heavy-industries/arista-eapi'

import type { ShowIpOspfNeighborReply, ShowIpOspfReply, ShowRouteMapReply, ShowVrrpReply } from '../../eapi/show-contracts'

/** Standing banner: why this screen has no editor, in every state (#87's own gate). Narrowed
 *  when #87's VRRP slice shipped `#/routing/vrrp` — VRRP writes now live there, so this banner
 *  names only the protocols whose editors the per-protocol blast review still holds. */
export const ROUTING_READ_ONLY_NOTE =
  'Routing configuration editors are not offered on THIS screen: OSPF, route-map, and BGP writes stay blocked behind #87\u2019s per-protocol blast-radius review, because these are the most traffic-impacting edits available on this switch. VRRP has its own editor at #/routing/vrrp. This screen reads status only.'

/** The BGP negative, stated verbatim — no BGP panel data exists to render. */
export const BGP_NOT_MODELLED_NOTE =
  'BGP status is not rendered: `show bgp summary` and `show bgp neighbors` are a recorded double negative on both targets — the 7050TX-64 answers `Error [1000] % Not supported` and the cEOS-lab capture answers `errors: ["Not supported"]`. The commands stay unmodelled (no invented shape), so no BGP panel is shown rather than a guessed one.'

/** The DR-043 floor on the OSPF JSON reads. */
export const OSPF_JSON_STANDING_NOTE =
  'The `show ip ospf` / `show ip ospf neighbor` JSON shapes are captured on cEOS-lab 4.28.14M only; the 7050TX-64 sweep captured these commands in text form with empty output. The commands run on the switch — its JSON field set is simply not established here, so every field below is "whatever the device answer carried", and an absent field is stated as absent.'

/** Why neighbor entries render as a count. */
export const OSPF_NEIGHBOR_SHAPE_NOTE =
  'Neighbor entries are shown as a count only: both committed captures carry an empty `ospfNeighborEntries` array, so no per-neighbor field set is modelled. (The two-node cEOS blast evidence records a real adjacency entry shape, but review evidence is not a committed fixture.)'

/** Why VRRP device state renders as a count while configured state renders fields. */
export const VRRP_SHAPE_NOTE =
  'The `show vrrp` capture answers `virtualRouters: []` on BOTH targets, so the device-side element shape is unmodelled and only the count renders. The configured columns below come from the typed `node.vrrp.getAll()` running-config reader, which is fully modelled.'

/** One flattened `show ip ospf` instance row (per VRF × instance). */
export interface OspfDeviceRow {
  readonly vrf: string
  readonly instance: string
  readonly routerId: string
  readonly numAreas: string
  readonly numBackboneNeighbors: string
  readonly shutDown: string
}

/** A configured-OSPF field row from {@link ospfConfigRows}. */
export interface OspfConfigRowShape {
  readonly field: string
  readonly value: string
}

/** A configured `network … area …` row from {@link ospfNetworkRows}. */
export interface OspfNetworkRow {
  readonly network: string
  readonly area: string
}

/** A configured `redistribute …` row from {@link ospfRedistributionRows}. */
export interface OspfRedistributionRow {
  readonly protocol: string
  readonly routeMap: string
}

/** The literal the rows carry when the device answer omitted a key — stated, never guessed. */
const ABSENT = '(the answer carried no value)'

/** Flatten `show ip ospf`'s `vrfs[*].instList[*]` into display rows. Keys stay optional per the contract. */
export function ospfDeviceRows(reply: ShowIpOspfReply | undefined): readonly OspfDeviceRow[] {
  if (reply === undefined) return []
  const rows: OspfDeviceRow[] = []
  for (const [vrfName, vrfBody] of Object.entries(reply.vrfs ?? {})) {
    for (const [instanceId, inst] of Object.entries(vrfBody.instList ?? {})) {
      rows.push({
        vrf: vrfName,
        instance: instanceId,
        routerId: inst.routerId ?? ABSENT,
        numAreas: inst.numAreas === undefined ? ABSENT : String(inst.numAreas),
        numBackboneNeighbors: inst.numBackboneNeighbors === undefined ? ABSENT : String(inst.numBackboneNeighbors),
        shutDown: inst.shutDown === undefined ? ABSENT : inst.shutDown ? 'yes' : 'no',
      })
    }
  }
  return rows
}

export interface OspfNeighborSummary {
  /** Total entries across every instance the answer named. */
  readonly total: number
  /** Instances whose answer omitted `ospfNeighborEntries` entirely — unknown, NOT zero. */
  readonly instancesOmittingList: number
}

/**
 * Count `show ip ospf neighbor` entries without ever reading into an element (the shape is
 * unmodelled). An instance that omits the list key is counted separately: "no key" is not "zero
 * neighbors" (the same absent-vs-empty discipline the screens' empty-state rules enforce).
 */
export function ospfNeighborSummary(reply: ShowIpOspfNeighborReply | undefined): OspfNeighborSummary | undefined {
  if (reply === undefined) return undefined
  let total = 0
  let omitting = 0
  let instances = 0
  for (const vrfBody of Object.values(reply.vrfs ?? {})) {
    for (const inst of Object.values(vrfBody.instList ?? {})) {
      instances += 1
      const entries = inst.ospfNeighborEntries
      if (entries === undefined) omitting += 1
      else total += entries.length
    }
  }
  // An answer with no instances at all is a clean zero-neighbor answer, not an omission.
  return { total, instancesOmittingList: instances === 0 ? 0 : omitting }
}

/** One `show route-map` name row (device side). */
export interface RouteMapDeviceRow {
  readonly name: string
  readonly clauseCount: string
}

/** Flatten `show route-map`'s `routeMaps` into name rows. Entries omitted → stated, not zero. */
export function routeMapDeviceRows(reply: ShowRouteMapReply | undefined): readonly RouteMapDeviceRow[] {
  if (reply === undefined) return []
  return Object.entries(reply.routeMaps ?? {}).map(([name, body]) => ({
    name,
    clauseCount: body.entries === undefined ? ABSENT : String(Object.keys(body.entries).length),
  }))
}

/** `show vrrp` element count — the only device-side VRRP read this screen may make (see VRRP_SHAPE_NOTE). */
export function vrrpDeviceCount(reply: ShowVrrpReply | undefined): number | undefined {
  return reply === undefined ? undefined : (reply.virtualRouters ?? []).length
}

/** Configured-OSPF summary rows from `node.ospf.get()` (`undefined` = not configured — normal). */
export function ospfConfigRows(state: OspfState | undefined): readonly { field: string; value: string }[] {
  if (state === undefined) return []
  return [
    { field: 'process id', value: String(state.ospfProcessId) },
    { field: 'vrf', value: state.vrf },
    { field: 'router-id', value: state.routerId ?? '(no router-id line in the section)' },
    // The reader keeps upstream's substring derivation (ospf.ts): `false` exactly when the section
    // carries a `no shutdown` line, `true` when it carries none. Rendered as that raw fact.
    { field: 'shutdown', value: state.shutdown ? 'no `no shutdown` line in the section' : '`no shutdown` line present' },
  ]
}

/** The `network … area …` rows the OSPF reader keeps (dotted-quad areas only, divergence 4). */
export function ospfNetworkRows(state: OspfState | undefined): readonly { network: string; area: string }[] {
  return (state?.networks ?? []).map((n) => ({ network: `${n.network}/${n.netmask}`, area: n.area }))
}

/** The `redistribute …` rows (two- or four-token lines only, per the reader). */
export function ospfRedistributionRows(state: OspfState | undefined): readonly { protocol: string; routeMap: string }[] {
  return (state?.redistributions ?? []).map((r) => ({ protocol: r.protocol, routeMap: r.routeMap ?? '(none named)' }))
}

/** One configured route-map clause row, flattened from `RoutemapEntry` (action → seqno → attrs). */
export interface RouteMapClauseRow {
  readonly name: string
  readonly action: string
  readonly seqno: string
  readonly matchCount: number
  readonly setCount: number
  readonly description: string
}

/** Flatten the configured route-map table into clause rows, config order preserved (Map iteration). */
export function routeMapClauseRows(table: ReadonlyMap<string, RoutemapEntry>): readonly RouteMapClauseRow[] {
  const rows: RouteMapClauseRow[] = []
  for (const [name, entry] of table) {
    for (const [action, clauses] of entry) {
      for (const [seqno, attrs] of clauses) {
        rows.push(describeClause(name, action, seqno, attrs))
      }
    }
  }
  return rows
}

function describeClause(name: string, action: string, seqno: number, attrs: RoutemapEntryAttrs): RouteMapClauseRow {
  return {
    name,
    action,
    seqno: String(seqno),
    matchCount: attrs.match.length,
    setCount: attrs.set.length,
    description: attrs.description ?? '',
  }
}

/** One configured VRRP group row, flattened from `node.vrrp.getAll()` (interface → vrid → Vrrp). */
export interface VrrpConfigRow {
  readonly interfaceName: string
  readonly vrid: number
  readonly enabled: string
  readonly priority: string
  readonly preempt: string
  readonly primaryIp: string
  readonly description: string
}

/** Flatten the configured VRRP table. Every column is a modelled `Vrrp` key — absent renders stated. */
export function vrrpConfigRows(table: ReadonlyMap<string, VrrpVridTable>): readonly VrrpConfigRow[] {
  const rows: VrrpConfigRow[] = []
  for (const [interfaceName, vrids] of table) {
    for (const [vrid, vrrp] of vrids) {
      rows.push(describeVrrp(interfaceName, vrid, vrrp))
    }
  }
  return rows
}

function describeVrrp(interfaceName: string, vrid: number, vrrp: Vrrp): VrrpConfigRow {
  return {
    interfaceName,
    vrid,
    enabled: vrrp.enable ? 'enabled' : 'disabled',
    priority: vrrp.priority === undefined ? '(no priority line)' : String(vrrp.priority),
    preempt: vrrp.preempt ? 'yes' : 'no',
    primaryIp: vrrp.primaryIp ?? '(no ip line)',
    description: vrrp.description,
  }
}
