/**
 * B2 (#87): the presentation half of the READ-ONLY routing status screen. Pure props (the
 * `MlagView`/`NtpView` F-tier split); every device string arrives as a plain value and this file
 * owns no fetch, no session, and no write.
 *
 * ## What this view may claim
 *
 * - Configured panels come from the parsed running-config readers (`node.ospf.get()`,
 *   `node.routemaps.getAll()`, `node.vrrp.getAll()`); device panels from the capture-backed
 *   `show` contracts. The two are rendered as SEPARATE panels and never merged.
 * - A soft `show` read that refused renders its folded device text beside the panel's count —
 *   never an error wall, and never a guessed value (the `SoftFailure` arms).
 * - OSPF device fields may each be absent (the JSON shape is cEOS-only, DR-043): the rows carry
 *   the stated-absent literal, and {@link OSPF_JSON_STANDING_NOTE} says why.
 * - Neighbor entries and VRRP elements render as COUNTS only — no committed capture carries their
 *   element shapes, so no per-entry column exists ({@link OSPF_NEIGHBOR_SHAPE_NOTE},
 *   {@link VRRP_SHAPE_NOTE}).
 * - BGP renders the recorded double negative verbatim ({@link BGP_NOT_MODELLED_NOTE}) — no panel,
 *   no read, no invented shape.
 *
 * The read-only banner ({@link ROUTING_READ_ONLY_NOTE}) renders in EVERY state, including loading
 * and failed: the operator never has to reach a device answer to learn this screen writes nothing.
 * Every table goes through F3 `DataTable`.
 */
import type { ReactElement } from 'react'

import { ConnectionHeader } from '../../components/ui/ConnectionHeader'
import type { ConnectionState } from '../../components/ui/ConnectionHeader'
import { DataTable } from '../../components/ui/DataTable'
import type { DataTableColumn } from '../../components/ui/DataTable'
import { EmptyState } from '../../components/ui/EmptyState'

import type {
  OspfConfigRowShape,
  OspfDeviceRow,
  OspfNeighborSummary,
  OspfNetworkRow,
  OspfRedistributionRow,
  RouteMapClauseRow,
  RouteMapDeviceRow,
  VrrpConfigRow,
} from './routing-rules'
import {
  BGP_NOT_MODELLED_NOTE,
  OSPF_JSON_STANDING_NOTE,
  OSPF_NEIGHBOR_SHAPE_NOTE,
  ROUTING_READ_ONLY_NOTE,
  VRRP_SHAPE_NOTE,
} from './routing-rules'

/** A soft read's folded failure, narrowed for presentation. */
export interface SoftFailure {
  readonly reason: string
}

export interface RoutingViewProps {
  readonly state: 'loading' | 'ready' | 'failed'
  readonly readError?: string
  readonly proxyPrompt?: string
  readonly identity?: { hostname: string; version: string; model: string }
  /** The config reads answered at all. */
  readonly configKnown: boolean
  /** `node.ospf.get()` found a `router ospf` section (false = not configured — a normal state). */
  readonly ospfConfigured: boolean
  readonly ospfConfigRows: readonly OspfConfigRowShape[]
  readonly ospfNetworkRows: readonly OspfNetworkRow[]
  readonly ospfRedistributionRows: readonly OspfRedistributionRow[]
  readonly routeMapClauseRows: readonly RouteMapClauseRow[]
  readonly vrrpConfigRows: readonly VrrpConfigRow[]
  readonly ospfDeviceRows: readonly OspfDeviceRow[]
  /** `undefined` = the soft neighbor read did not answer (unknown, NOT zero). */
  readonly ospfNeighbor?: OspfNeighborSummary
  readonly routeMapDeviceRows: readonly RouteMapDeviceRow[]
  /** `undefined` = the soft `show vrrp` read did not answer. */
  readonly vrrpDeviceCount?: number
  readonly ospfShowFailure?: SoftFailure
  readonly ospfNeighborShowFailure?: SoftFailure
  readonly routeMapShowFailure?: SoftFailure
  readonly vrrpShowFailure?: SoftFailure
  readonly canAct: boolean
  readonly connection: ConnectionState
  readonly connectionLabel: string
  readonly onReload: () => void
}

const fieldColumns: readonly DataTableColumn<{ field: string; value: string }>[] = [
  { header: 'Field', cell: (row) => <code>{row.field}</code> },
  { header: 'Value', cell: (row) => row.value },
]

const ospfDeviceColumns: readonly DataTableColumn<OspfDeviceRow>[] = [
  { header: 'VRF', cell: (row) => row.vrf },
  { header: 'Instance', cell: (row) => row.instance },
  { header: 'Router ID', cell: (row) => row.routerId },
  { header: 'Areas', cell: (row) => row.numAreas },
  { header: 'Backbone neighbors', cell: (row) => row.numBackboneNeighbors },
  { header: 'Shutdown', cell: (row) => row.shutDown },
]

const networkColumns: readonly DataTableColumn<OspfNetworkRow>[] = [
  { header: 'Network', cell: (row) => <code>{row.network}</code> },
  { header: 'Area', cell: (row) => row.area },
]

const redistributionColumns: readonly DataTableColumn<OspfRedistributionRow>[] = [
  { header: 'Protocol', cell: (row) => row.protocol },
  { header: 'Route map', cell: (row) => row.routeMap },
]

const routeMapClauseColumns: readonly DataTableColumn<RouteMapClauseRow>[] = [
  { header: 'Route map', cell: (row) => <code>{row.name}</code> },
  { header: 'Action', cell: (row) => row.action },
  { header: 'Seq', numeric: true, cell: (row) => row.seqno },
  { header: 'match lines', numeric: true, cell: (row) => String(row.matchCount) },
  { header: 'set lines', numeric: true, cell: (row) => String(row.setCount) },
  { header: 'Description', cell: (row) => row.description },
]

const routeMapDeviceColumns: readonly DataTableColumn<RouteMapDeviceRow>[] = [
  { header: 'Route map (device answer)', cell: (row) => <code>{row.name}</code> },
  { header: 'Clauses', cell: (row) => row.clauseCount },
]

const vrrpConfigColumns: readonly DataTableColumn<VrrpConfigRow>[] = [
  { header: 'Interface', cell: (row) => <code>{row.interfaceName}</code> },
  { header: 'VRID', numeric: true, cell: (row) => String(row.vrid) },
  { header: 'State', cell: (row) => row.enabled },
  { header: 'Priority', cell: (row) => row.priority },
  { header: 'Preempt', cell: (row) => row.preempt },
  { header: 'Primary IP', cell: (row) => row.primaryIp },
  { header: 'Description', cell: (row) => row.description },
]

/** The folded refusal of a soft read, rendered beside the panel it belongs to. */
function SoftRefusal({ label, failure }: { readonly label: string; readonly failure: SoftFailure }): ReactElement {
  return <p className="field-note" role="status"><strong>{label} did not answer.</strong> Raw device text: <code>{failure.reason}</code> — the panel stays unknown rather than guessing.</p>
}

export function RoutingView(props: RoutingViewProps): ReactElement {
  const {
    state,
    readError,
    proxyPrompt,
    identity,
    configKnown,
    ospfConfigured,
    ospfConfigRows,
    ospfNetworkRows,
    ospfRedistributionRows,
    routeMapClauseRows,
    vrrpConfigRows,
    ospfDeviceRows,
    ospfNeighbor,
    routeMapDeviceRows,
    vrrpDeviceCount,
    ospfShowFailure,
    ospfNeighborShowFailure,
    routeMapShowFailure,
    vrrpShowFailure,
    canAct,
    connection,
    connectionLabel,
    onReload,
  } = props

  return <section className="workspace" aria-labelledby="workspace-title">
    <div className="screen-connection">
      <ConnectionHeader
        state={connection}
        {...(identity === undefined ? {} : { identity })}
        {...(connection === 'connected' ? { connectedLabel: connectionLabel } : {})}
        {...(connection === 'connecting' ? { connectingLabel: connectionLabel } : {})}
        {...(connection === 'error' ? { errorLabel: connectionLabel } : {})}
      />
    </div>

    <div className="workspace-heading">
      <div>
        <p className="eyebrow">SWITCH ROUTING</p>
        <h2 id="workspace-title">Routing status</h2>
      </div>
      <button className="quiet-button" type="button" onClick={onReload} disabled={!canAct}>Reload routing state</button>
    </div>

    {proxyPrompt !== undefined && <div className="notice notice-error" role="alert"><strong>Local proxy is not configured.</strong><p>{proxyPrompt}</p></div>}

    {/* The standing read-only banner — present in EVERY state, before any device answer exists. */}
    <p className="notice notice-warning" role="status">
      <strong>Read-only screen.</strong> {ROUTING_READ_ONLY_NOTE} Configured state comes from the
      parsed running-config; device state from the captured <code>show</code> replies. The two stay
      separate panels, and where they disagree both are shown verbatim rather than merged.
    </p>

    {state === 'loading' && <p className="notice" role="status">Reading routing state (parsed running-config plus <code>show ip ospf</code>, <code>show ip ospf neighbor</code>, <code>show route-map</code>, <code>show vrrp</code>)&#8230;</p>}
    {readError !== undefined && <div className="notice notice-error" role="alert"><strong>A routing read failed.</strong><p>{readError}</p><button className="quiet-button" type="button" onClick={onReload}>Try again</button></div>}

    {/* OSPF — configured half */}
    <section className="panel" aria-labelledby="routing-ospf-config-title">
      <div className="panel-heading">
        <div><p className="eyebrow">CONFIGURED (PARSED RUNNING-CONFIG)</p><h3 id="routing-ospf-config-title">OSPF process</h3></div>
        <span className="panel-index">{!configKnown ? 'unread' : ospfConfigured ? 'configured' : 'none'}</span>
      </div>
      {!configKnown && <p className="field-note">No <code>ospf.get()</code> read has answered yet, so the OSPF configuration is unknown — not empty.</p>}
      {configKnown && !ospfConfigured && <EmptyState
        heading="No `router ospf` section exists in the running-config."
        hint="This is a normal configured state, not an error: the device simply runs no OSPF process. The reader addresses one process in one VRF (resources/ospf.ts); a multi-process box is outside what this client models."
      />}
      {configKnown && ospfConfigured && <>
        <DataTable columns={fieldColumns} rows={ospfConfigRows} rowKey={(row) => row.field} label="Configured OSPF process fields" />
        {ospfNetworkRows.length === 0
          ? <p className="field-note">No <code>network &lt;addr&gt; &lt;mask&gt; area &lt;dotted-quad&gt;</code> lines were read (dotted-quad areas only — the reader drops other area spellings, divergence 4).</p>
          : <DataTable columns={networkColumns} rows={ospfNetworkRows} rowKey={(row) => `${row.network}@${row.area}`} label="Configured OSPF networks" />}
        {ospfRedistributionRows.length > 0 && <DataTable columns={redistributionColumns} rows={ospfRedistributionRows} rowKey={(row) => `${row.protocol}/${row.routeMap}`} label="Configured OSPF redistributions" />}
      </>}
    </section>

    {/* OSPF — device half */}
    <section className="panel" aria-labelledby="routing-ospf-device-title">
      <div className="panel-heading">
        <div><p className="eyebrow">DEVICE REPLY (SOFT SHOW READS)</p><h3 id="routing-ospf-device-title">show ip ospf / neighbor</h3></div>
        <span className="panel-index">{ospfDeviceRows.length === 0 && ospfShowFailure !== undefined ? 'no answer' : `${String(ospfDeviceRows.length)} instance(s)`}</span>
      </div>
      {ospfShowFailure !== undefined && <SoftRefusal label="`show ip ospf`" failure={ospfShowFailure} />}
      {ospfShowFailure === undefined && ospfDeviceRows.length === 0 && <p className="field-note">The <code>show ip ospf</code> answer named no instances.</p>}
      {ospfDeviceRows.length > 0 && <DataTable columns={ospfDeviceColumns} rows={ospfDeviceRows} rowKey={(row) => `${row.vrf}/${row.instance}`} label="show ip ospf instances" />}
      {ospfNeighborShowFailure !== undefined
        ? <SoftRefusal label="`show ip ospf neighbor`" failure={ospfNeighborShowFailure} />
        : ospfNeighbor === undefined
          ? <p className="field-note">The <code>show ip ospf neighbor</code> read has not answered, so the neighbor count is unknown — not zero.</p>
          : <p className="field-note" role="status">Adjacency count across every instance the answer named: <strong>{String(ospfNeighbor.total)}</strong>{ospfNeighbor.instancesOmittingList > 0 ? ` (plus ${String(ospfNeighbor.instancesOmittingList)} instance(s) whose answer omitted the neighbor list — unknown, not zero)` : ''}.</p>}
      <p className="field-note">{OSPF_NEIGHBOR_SHAPE_NOTE}</p>
      <p className="field-note">{OSPF_JSON_STANDING_NOTE}</p>
    </section>

    {/* Route maps — configured half */}
    <section className="panel" aria-labelledby="routing-routemap-config-title">
      <div className="panel-heading">
        <div><p className="eyebrow">CONFIGURED (PARSED RUNNING-CONFIG)</p><h3 id="routing-routemap-config-title">Route-map clauses</h3></div>
        <span className="panel-index">{!configKnown ? 'unread' : routeMapClauseRows.length === 0 ? 'none' : routeMapClauseRows.length.toString().padStart(2, '0')}</span>
      </div>
      {!configKnown
        ? <p className="field-note">No <code>routemaps.getAll()</code> read has answered yet.</p>
        : routeMapClauseRows.length === 0
          ? <EmptyState heading="No `route-map` section exists in the running-config." hint="A normal configured state: route maps appear once configured. Editing them is blocked behind #87's per-protocol blast-radius review." />
          : <DataTable columns={routeMapClauseColumns} rows={routeMapClauseRows} rowKey={(row) => `${row.name}/${row.action}/${row.seqno}`} label="Configured route-map clauses" />}
    </section>

    {/* Route maps — device half */}
    <section className="panel" aria-labelledby="routing-routemap-device-title">
      <div className="panel-heading">
        <div><p className="eyebrow">DEVICE REPLY (SOFT SHOW READ)</p><h3 id="routing-routemap-device-title">show route-map</h3></div>
        <span className="panel-index">{routeMapShowFailure !== undefined ? 'no answer' : `${String(routeMapDeviceRows.length)} map(s)`}</span>
      </div>
      {routeMapShowFailure !== undefined && <SoftRefusal label="`show route-map`" failure={routeMapShowFailure} />}
      {routeMapShowFailure === undefined && routeMapDeviceRows.length === 0 && <p className="field-note">The <code>show route-map</code> answer carried an empty <code>routeMaps</code> container — the command runs (both targets answer it) and none are configured.</p>}
      {routeMapDeviceRows.length > 0 && <DataTable columns={routeMapDeviceColumns} rows={routeMapDeviceRows} rowKey={(row) => row.name} label="show route-map names" />}
    </section>

    {/* VRRP — configured half */}
    <section className="panel" aria-labelledby="routing-vrrp-config-title">
      <div className="panel-heading">
        <div><p className="eyebrow">CONFIGURED (PARSED RUNNING-CONFIG)</p><h3 id="routing-vrrp-config-title">VRRP groups</h3></div>
        <span className="panel-index">{!configKnown ? 'unread' : vrrpConfigRows.length === 0 ? 'none' : vrrpConfigRows.length.toString().padStart(2, '0')}</span>
      </div>
      {!configKnown
        ? <p className="field-note">No <code>vrrp.getAll()</code> read has answered yet.</p>
        : vrrpConfigRows.length === 0
          ? <EmptyState heading="No interface section carries a `vrrp &lt;vrid&gt;` line." hint="A normal configured state. VRRP writes live on the VRRP editor (#/routing/vrrp) — this screen never edits them." />
          : <DataTable columns={vrrpConfigColumns} rows={vrrpConfigRows} rowKey={(row) => `${row.interfaceName}/${String(row.vrid)}`} label="Configured VRRP groups" />}
      {/* #87's VRRP slice shipped the editor — the panel points at it instead of the old
          "this screen never edits them" dead end. */}
      <p className="field-note">To create, edit, or delete these groups, use the <a href="#/routing/vrrp">VRRP editor</a>.</p>
    </section>

    {/* VRRP — device half */}
    <section className="panel" aria-labelledby="routing-vrrp-device-title">
      <div className="panel-heading">
        <div><p className="eyebrow">DEVICE REPLY (SOFT SHOW READ)</p><h3 id="routing-vrrp-device-title">show vrrp</h3></div>
        <span className="panel-index">{vrrpShowFailure !== undefined ? 'no answer' : vrrpDeviceCount === undefined ? 'unread' : `${String(vrrpDeviceCount)} group(s)`}</span>
      </div>
      {vrrpShowFailure !== undefined && <SoftRefusal label="`show vrrp`" failure={vrrpShowFailure} />}
      {vrrpShowFailure === undefined && vrrpDeviceCount !== undefined && <p className="field-note" role="status">Virtual routers the device answer names: <strong>{String(vrrpDeviceCount)}</strong>.</p>}
      <p className="field-note">{VRRP_SHAPE_NOTE}</p>
    </section>

    {/* BGP — the recorded double negative, stated not guessed */}
    <section className="panel" aria-labelledby="routing-bgp-title">
      <div className="panel-heading">
        <div><p className="eyebrow">RECORDED NEGATIVE</p><h3 id="routing-bgp-title">BGP</h3></div>
        <span className="panel-index">not modelled</span>
      </div>
      <p className="field-note">{BGP_NOT_MODELLED_NOTE}</p>
    </section>
  </section>
}
