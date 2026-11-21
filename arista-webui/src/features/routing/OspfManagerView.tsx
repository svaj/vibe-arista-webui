/**
 * #87 (OSPF slice): the presentation half of the OSPF process editor (`#/routing/ospf`). Pure props
 * (the `RouteMapManagerView`/`VrrpManagerView` pattern); no `OspfState`, `OspfNetwork`,
 * `OspfRedistribution`, or `CommandSpec` crosses this boundary.
 *
 * ## What this view may claim
 *
 * - The configured process comes from the parsed running-config reader (`node.ospf.get()`); the
 *   device-side instance rows and the adjacency COUNT come from the soft show reads. The two sides
 *   are separate panels and never merged (the S14/#84 convention) — on a multi-process node the
 *   device panel may list instances the config read does not (divergence 7 says so).
 * - No process (`ospf.get()` answering `undefined`) is a NORMAL ready state (this box runs zero
 *   OSPF processes today), never an error; a failed HARD read renders the error wall.
 * - The neighbor read is a COUNT only — the entry shape is carried by no capture, so no per-entry
 *   column exists here.
 * - The route-map annotation on the redistribution form states only what the running-config read
 *   could check; a failed read says "unverified", never "missing".
 * - No commit/abort control exists anywhere on this screen (#141: the Transaction Center owns
 *   them); the six forms only stage.
 */
import type { FormEvent, ReactElement } from 'react'

import { ConnectionHeader } from '../../components/ui/ConnectionHeader'
import type { ConnectionState } from '../../components/ui/ConnectionHeader'
import { DataTable } from '../../components/ui/DataTable'
import type { DataTableColumn } from '../../components/ui/DataTable'
import { EmptyState } from '../../components/ui/EmptyState'
import {
  OSPF_AREA_ASYMMETRY_NOTE,
  OSPF_EDITOR_STANDING_NOTE,
  OSPF_SINGLE_PROCESS_NOTE,
} from './ospf-rules'
import type { OspfNetworkRow, OspfRedistributionRow } from './ospf-rules'
import type { OspfNeighborSummary } from './routing-rules'

export interface OspfProcessSummary {
  readonly processId: string
  readonly vrf: string
  readonly routerId: string
  readonly shutdown: string
}

export interface OspfManagerViewProps {
  readonly state: 'loading' | 'ready' | 'failed'
  readonly readError?: string
  readonly proxyPrompt?: string
  readonly identity?: { hostname: string; version: string; model: string }

  /** True once the HARD `ospf.get()` read resolved (distinguishes unread from no-process). */
  readonly configKnown: boolean
  /** Absent = no `router ospf` section (a NORMAL state). */
  readonly process?: OspfProcessSummary
  readonly networkRows: readonly OspfNetworkRow[]
  readonly redistributionRows: readonly OspfRedistributionRow[]

  /** The soft `show ip ospf` device rows — absent while unread; the failure note renders. */
  readonly deviceRows?: readonly { vrf: string; instance: string; routerId: string; numAreas: string; numBackboneNeighbors: string; shutDown: string }[]
  readonly deviceFailure?: string
  readonly neighbor?: OspfNeighborSummary
  readonly neighborFailure?: string
  /** Present when the SOFT `routemaps.getAll()` annotation read failed. */
  readonly routeMapReadNote?: string

  readonly protocols: readonly string[]

  readonly createDraft: { processId: string; vrf: string }
  readonly createError?: string
  readonly onCreateChange: (patch: { processId?: string; vrf?: string }) => void
  readonly onCreateSubmit: (event: FormEvent<HTMLFormElement>) => void

  readonly deleteDraftEnabled: boolean
  readonly onDeleteSubmit: (event: FormEvent<HTMLFormElement>) => void

  readonly routerIdDraft: { mode: string; value: string }
  readonly routerIdError?: string
  readonly onRouterIdChange: (patch: { mode?: string; value?: string }) => void
  readonly onRouterIdSubmit: (event: FormEvent<HTMLFormElement>) => void

  readonly networkDraft: { mode: string; network: string; mask: string; area: string; target: string }
  readonly networkError?: string
  readonly onNetworkChange: (patch: Partial<{ mode: string; network: string; mask: string; area: string; target: string }>) => void
  readonly onNetworkSubmit: (event: FormEvent<HTMLFormElement>) => void

  readonly redistributionDraft: { mode: string; protocol: string; routeMap: string; target: string }
  readonly redistributionError?: string
  readonly onRedistributionChange: (patch: Partial<{ mode: string; protocol: string; routeMap: string; target: string }>) => void
  readonly onRedistributionSubmit: (event: FormEvent<HTMLFormElement>) => void

  readonly shutdownDraft: { mode: string }
  readonly shutdownError?: string
  readonly onShutdownChange: (patch: { mode?: string }) => void
  readonly onShutdownSubmit: (event: FormEvent<HTMLFormElement>) => void

  readonly busy: boolean
  readonly canAct: boolean
  readonly notice: string
  readonly failure: string
  readonly connection: ConnectionState
  readonly connectionLabel: string
  readonly onReload: () => void
}

export function OspfManagerView(props: OspfManagerViewProps): ReactElement {
  const {
    state,
    readError,
    proxyPrompt,
    identity,
    configKnown,
    process,
    networkRows,
    redistributionRows,
    deviceRows,
    deviceFailure,
    neighbor,
    neighborFailure,
    routeMapReadNote,
    protocols,
    createDraft,
    createError,
    onCreateChange,
    onCreateSubmit,
    deleteDraftEnabled,
    onDeleteSubmit,
    routerIdDraft,
    routerIdError,
    onRouterIdChange,
    onRouterIdSubmit,
    networkDraft,
    networkError,
    onNetworkChange,
    onNetworkSubmit,
    redistributionDraft,
    redistributionError,
    onRedistributionChange,
    onRedistributionSubmit,
    shutdownDraft,
    shutdownError,
    onShutdownChange,
    onShutdownSubmit,
    busy,
    canAct,
    notice,
    failure,
    connection,
    connectionLabel,
    onReload,
  } = props

  const formsDisabled = !canAct || busy
  const noProcess = process === undefined

  // The process summary renders as the Routing screen's field/value table shape.
  const processFieldRows = process === undefined ? [] : [
    { field: 'Process id', value: process.processId },
    { field: 'VRF', value: process.vrf },
    { field: 'Router-id', value: process.routerId },
    { field: 'Shutdown state', value: process.shutdown },
  ]
  const processFieldColumns: readonly DataTableColumn<{ field: string; value: string }>[] = [
    { header: 'Field', cell: (row) => row.field },
    { header: 'Value', cell: (row) => <code>{row.value}</code> },
  ]

  const networkColumns: readonly DataTableColumn<OspfNetworkRow>[] = [
    { header: 'Network', cell: (row) => <code>{row.network}</code> },
    { header: 'Mask', cell: (row) => `/${row.mask}` },
    { header: 'Area', cell: (row) => <code>{row.area}</code> },
  ]

  const redistributionColumns: readonly DataTableColumn<OspfRedistributionRow>[] = [
    { header: 'Protocol', cell: (row) => row.protocol },
    { header: 'Route-map', cell: (row) => row.routeMap },
  ]

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
        <p className="eyebrow">ROUTING</p>
        <h2 id="workspace-title">OSPF process</h2>
      </div>
      <button className="quiet-button" type="button" onClick={onReload} disabled={!canAct || busy}>Reload OSPF state</button>
    </div>

    {proxyPrompt !== undefined && <div className="notice notice-error" role="alert"><strong>Local proxy is not configured.</strong><p>{proxyPrompt}</p></div>}

    <p className="notice notice-warning" role="status">{OSPF_EDITOR_STANDING_NOTE} <a href="#/routing">Routing status</a> shows the read-only device-side view.</p>

    {state === 'loading' && <p className="notice" role="status">Reading the configured OSPF process (parsed running-config)…</p>}
    {readError !== undefined && <div className="notice notice-error" role="alert"><strong>The OSPF read failed.</strong><p>{readError}</p><button className="quiet-button" type="button" onClick={onReload} disabled={busy}>Try again</button></div>}

    {/* Configured process — the HARD parsed-config read */}
    <section className="panel" aria-labelledby="ospf-config-title">
      <div className="panel-heading">
        <div><p className="eyebrow">CONFIGURED (PARSED RUNNING-CONFIG)</p><h3 id="ospf-config-title">router ospf</h3></div>
        <span className="panel-index">{!configKnown ? 'unread' : process === undefined ? 'none' : process.processId}</span>
      </div>
      {!configKnown
        ? <p className="field-note">No <code>ospf.get()</code> read has answered yet.</p>
        : process === undefined
          ? <EmptyState heading="No `router ospf` section exists in the running-config." hint="A normal configured state — this unit runs zero OSPF processes today. The Create form below stages the first one; every line mirrors the client's own verb text." />
          : <>
            <DataTable columns={processFieldColumns} rows={processFieldRows} rowKey={(row) => row.field} label="Configured OSPF process fields" />
            {networkRows.length === 0
              ? <p className="field-note">The section carries no <code>network … area …</code> line this reader can parse (only dotted-quad areas parse — module divergence 4; see the network form note).</p>
              : <DataTable columns={networkColumns} rows={networkRows} rowKey={(row) => row.target} label="Configured OSPF networks" />}
            {redistributionRows.length === 0
              ? <p className="field-note">The section carries no <code>redistribute …</code> line.</p>
              : <DataTable columns={redistributionColumns} rows={redistributionRows} rowKey={(row) => row.target} label="Configured OSPF redistributions" />}
          </>}
      <p className="field-note">{OSPF_SINGLE_PROCESS_NOTE}</p>
      {routeMapReadNote !== undefined && <p className="field-note" role="status">{routeMapReadNote}</p>}
    </section>

    {/* Device side — the soft show reads, never merged with config */}
    <section className="panel" aria-labelledby="ospf-device-title">
      <div className="panel-heading">
        <div><p className="eyebrow">DEVICE REPLY (SOFT SHOW READS)</p><h3 id="ospf-device-title">show ip ospf / neighbor</h3></div>
        <span className="panel-index">{deviceFailure !== undefined ? 'no answer' : deviceRows === undefined ? 'unread' : `${String(deviceRows.length)} instance(s)`}</span>
      </div>
      {deviceFailure !== undefined && <p className="field-note" role="status">{deviceFailure}</p>}
      {deviceFailure === undefined && deviceRows !== undefined && deviceRows.length === 0 && <p className="field-note">The <code>show ip ospf</code> answer named no instances.</p>}
      {deviceRows !== undefined && deviceRows.length > 0 && <DataTable
        columns={[
          { header: 'VRF', cell: (row: { vrf: string }) => row.vrf },
          { header: 'Instance', cell: (row: { instance: string }) => <code>{row.instance}</code> },
          { header: 'Router-id', cell: (row: { routerId: string }) => row.routerId },
          { header: 'Areas', cell: (row: { numAreas: string }) => row.numAreas, numeric: true },
          { header: 'Backbone neighbors', cell: (row: { numBackboneNeighbors: string }) => row.numBackboneNeighbors, numeric: true },
          { header: 'Shutdown', cell: (row: { shutDown: string }) => row.shutDown },
        ]}
        rows={deviceRows}
        rowKey={(row) => `${row.vrf}/${row.instance}`}
        label="show ip ospf instances"
      />}
      {neighborFailure !== undefined
        ? <p className="field-note" role="status">{neighborFailure}</p>
        : neighbor === undefined
          ? <p className="field-note">The <code>show ip ospf neighbor</code> read has not answered, so the adjacency count is unknown — not zero.</p>
          : <p className="field-note" role="status">Adjacency count across every instance the answer named: <strong>{String(neighbor.total)}</strong>{neighbor.instancesOmittingList > 0 ? ` (plus ${String(neighbor.instancesOmittingList)} instance(s) whose answer omitted the neighbor list — unknown, not zero)` : ''}. The neighbor entry shape is carried by no capture, so only the count is shown.</p>}
    </section>

    {/* Create process */}
    <section className="panel" aria-labelledby="ospf-create-title">
      <div className="panel-heading">
        <div><p className="eyebrow">WRITE (STAGES ONLY)</p><h3 id="ospf-create-title">Create a process</h3></div>
      </div>
      <p className="field-note">One line: <code>router ospf &lt;pid&gt;</code> (+ <code>vrf &lt;name&gt;</code>) — the client&#39;s <code>create()</code> text, sent with zero reads. The process id bound 1-65535 is pyeapi&#39;s own; the image&#39;s real range is the device&#39;s answer (DR-032).</p>
      <form onSubmit={onCreateSubmit}>
        <div className="field-row">
          <div>
            <label htmlFor="ospf-create-pid">Process id (digits, 1-65535)</label>
            <input id="ospf-create-pid" name="ospf-create-pid" type="text" inputMode="numeric" value={createDraft.processId} onChange={(event) => onCreateChange({ processId: event.target.value })} disabled={formsDisabled} maxLength={5} />
          </div>
          <div>
            <label htmlFor="ospf-create-vrf">VRF name (blank = default VRF)</label>
            <input id="ospf-create-vrf" name="ospf-create-vrf" type="text" value={createDraft.vrf} onChange={(event) => onCreateChange({ vrf: event.target.value })} disabled={formsDisabled} maxLength={32} />
          </div>
        </div>
        {createError !== undefined && <p className="notice notice-error" role="alert">{createError}</p>}
        <div className="review-actions">
          <button className="primary-button" type="submit" disabled={formsDisabled}>Stage process create</button>
        </div>
      </form>
    </section>

    {/* Delete process — destructive, hard confirm */}
    <section className="panel" aria-labelledby="ospf-delete-title">
      <div className="panel-heading">
        <div><p className="eyebrow">WRITE (STAGES ONLY, DESTRUCTIVE)</p><h3 id="ospf-delete-title">Delete the process</h3></div>
      </div>
      <p className="field-note">One top-level line: <code>no router ospf &lt;pid&gt;</code> — the client&#39;s <code>delete()</code> text. Removes the WHOLE process (adjacencies, advertised networks, redistributions); the Transaction Center runs a second confirm stating the measured adjacency proxy.</p>
      <form onSubmit={onDeleteSubmit}>
        {deleteDraftEnabled && process !== undefined
          ? <p className="field-note">This deletes <code>router ospf {process.processId}</code> (VRF {process.vrf}) — the process this read shows.</p>
          : <p className="field-note">No process was read, so there is nothing to delete.</p>}
        <div className="review-actions">
          <button className="primary-button" type="submit" disabled={formsDisabled || !deleteDraftEnabled}>Stage process delete</button>
        </div>
      </form>
    </section>

    {/* Router-id */}
    <section className="panel" aria-labelledby="ospf-routerid-title">
      <div className="panel-heading">
        <div><p className="eyebrow">WRITE (STAGES ONLY)</p><h3 id="ospf-routerid-title">Set or clear the router-id</h3></div>
      </div>
      <p className="field-note">Header + <code>router-id &lt;value&gt;</code> / <code>no router-id</code> — the client&#39;s two-line transaction. A live router-id change re-originates the router LSA and re-forms adjacencies; that blast is NOT measured for this verb, and the confirm says so.</p>
      <form onSubmit={onRouterIdSubmit}>
        <div className="field-row">
          <div>
            <label htmlFor="ospf-routerid-mode">Operation</label>
            <select id="ospf-routerid-mode" name="ospf-routerid-mode" value={routerIdDraft.mode} onChange={(event) => onRouterIdChange({ mode: event.target.value })} disabled={formsDisabled || noProcess}>
              <option value="">— choose —</option>
              <option value="set">set a value</option>
              <option value="clear">clear it (`no router-id`)</option>
            </select>
          </div>
          <div>
            <label htmlFor="ospf-routerid-value">Router-id (one token — dotted-quad by convention)</label>
            <input id="ospf-routerid-value" name="ospf-routerid-value" type="text" value={routerIdDraft.value} onChange={(event) => onRouterIdChange({ value: event.target.value })} disabled={formsDisabled || noProcess || routerIdDraft.mode !== 'set'} maxLength={64} />
          </div>
        </div>
        {routerIdError !== undefined && <p className="notice notice-error" role="alert">{routerIdError}</p>}
        <div className="review-actions">
          <button className="primary-button" type="submit" disabled={formsDisabled || noProcess}>Stage router-id change</button>
        </div>
      </form>
    </section>

    {/* Networks — add / remove */}
    <section className="panel" aria-labelledby="ospf-network-title">
      <div className="panel-heading">
        <div><p className="eyebrow">WRITE (STAGES ONLY)</p><h3 id="ospf-network-title">Add or remove a network statement</h3></div>
      </div>
      <p className="field-note">Header + <code>network &lt;net&gt;/&lt;mask&gt; area &lt;area&gt;</code> (or its <code>no</code> form) — the client&#39;s two-line transaction. {OSPF_AREA_ASYMMETRY_NOTE}</p>
      <form onSubmit={onNetworkSubmit}>
        <div className="field-row">
          <div>
            <label htmlFor="ospf-network-mode">Operation</label>
            <select id="ospf-network-mode" name="ospf-network-mode" value={networkDraft.mode} onChange={(event) => onNetworkChange({ mode: event.target.value })} disabled={formsDisabled || noProcess}>
              <option value="">— choose —</option>
              <option value="add">add a statement</option>
              <option value="remove">remove one (picker)</option>
            </select>
          </div>
          {networkDraft.mode === 'remove'
            ? <div>
              <label htmlFor="ospf-network-target">Statement to remove</label>
              <select id="ospf-network-target" name="ospf-network-target" value={networkDraft.target} onChange={(event) => onNetworkChange({ target: event.target.value })} disabled={formsDisabled || noProcess || networkRows.length === 0}>
                <option value="">— choose a statement —</option>
                {networkRows.map((row) => <option key={row.target} value={row.target}>{row.network}/{row.mask} area {row.area}</option>)}
              </select>
            </div>
            : <>
              <div>
                <label htmlFor="ospf-network-address">Network address</label>
                <input id="ospf-network-address" name="ospf-network-address" type="text" value={networkDraft.network} onChange={(event) => onNetworkChange({ network: event.target.value })} disabled={formsDisabled || noProcess || networkDraft.mode !== 'add'} maxLength={39} />
              </div>
              <div>
                <label htmlFor="ospf-network-mask">Mask length (digits after /)</label>
                <input id="ospf-network-mask" name="ospf-network-mask" type="text" inputMode="numeric" value={networkDraft.mask} onChange={(event) => onNetworkChange({ mask: event.target.value })} disabled={formsDisabled || noProcess || networkDraft.mode !== 'add'} maxLength={2} />
              </div>
              <div>
                <label htmlFor="ospf-network-area">Area (dotted quad or bare digits)</label>
                <input id="ospf-network-area" name="ospf-network-area" type="text" value={networkDraft.area} onChange={(event) => onNetworkChange({ area: event.target.value })} disabled={formsDisabled || noProcess || networkDraft.mode !== 'add'} maxLength={15} />
              </div>
            </>}
        </div>
        {networkError !== undefined && <p className="notice notice-error" role="alert">{networkError}</p>}
        <div className="review-actions">
          <button className="primary-button" type="submit" disabled={formsDisabled || noProcess || networkDraft.mode === ''}>Stage network change</button>
        </div>
      </form>
    </section>

    {/* Redistributions — add / remove */}
    <section className="panel" aria-labelledby="ospf-redist-title">
      <div className="panel-heading">
        <div><p className="eyebrow">WRITE (STAGES ONLY)</p><h3 id="ospf-redist-title">Add or remove a redistribution</h3></div>
      </div>
      <p className="field-note">Header + <code>redistribute &lt;protocol&gt;[ route-map &lt;name&gt;]</code> / the bare <code>no redistribute &lt;protocol&gt;</code> (the client&#39;s only negation form — divergence 10, stated in the confirm). The protocol list is the client&#39;s own allow-list; what 4.28 additionally redistributes is a device-capture question (DR-032).</p>
      <form onSubmit={onRedistributionSubmit}>
        <div className="field-row">
          <div>
            <label htmlFor="ospf-redist-mode">Operation</label>
            <select id="ospf-redist-mode" name="ospf-redist-mode" value={redistributionDraft.mode} onChange={(event) => onRedistributionChange({ mode: event.target.value })} disabled={formsDisabled || noProcess}>
              <option value="">— choose —</option>
              <option value="add">add a redistribution</option>
              <option value="remove">remove one (picker)</option>
            </select>
          </div>
          {redistributionDraft.mode === 'remove'
            ? <div>
              <label htmlFor="ospf-redist-target">Line to remove</label>
              <select id="ospf-redist-target" name="ospf-redist-target" value={redistributionDraft.target} onChange={(event) => onRedistributionChange({ target: event.target.value })} disabled={formsDisabled || noProcess || redistributionRows.length === 0}>
                <option value="">— choose a line —</option>
                {redistributionRows.map((row) => <option key={row.target} value={row.target}>redistribute {row.protocol}{row.routeMap === '(none)' ? '' : ` route-map ${row.routeMap}`}</option>)}
              </select>
            </div>
            : <>
              <div>
                <label htmlFor="ospf-redist-protocol">Protocol</label>
                <select id="ospf-redist-protocol" name="ospf-redist-protocol" value={redistributionDraft.protocol} onChange={(event) => onRedistributionChange({ protocol: event.target.value })} disabled={formsDisabled || noProcess || redistributionDraft.mode !== 'add'}>
                  <option value="">— choose —</option>
                  {protocols.map((protocol) => <option key={protocol} value={protocol}>{protocol}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="ospf-redist-routemap">Route-map name (blank = none)</label>
                <input id="ospf-redist-routemap" name="ospf-redist-routemap" type="text" value={redistributionDraft.routeMap} onChange={(event) => onRedistributionChange({ routeMap: event.target.value })} disabled={formsDisabled || noProcess || redistributionDraft.mode !== 'add'} maxLength={64} />
              </div>
            </>}
        </div>
        {redistributionError !== undefined && <p className="notice notice-error" role="alert">{redistributionError}</p>}
        <div className="review-actions">
          <button className="primary-button" type="submit" disabled={formsDisabled || noProcess || redistributionDraft.mode === ''}>Stage redistribution change</button>
        </div>
      </form>
    </section>

    {/* Shutdown state */}
    <section className="panel" aria-labelledby="ospf-shutdown-title">
      <div className="panel-heading">
        <div><p className="eyebrow">WRITE (STAGES ONLY)</p><h3 id="ospf-shutdown-title">Move the shutdown state</h3></div>
      </div>
      <p className="field-note">Header + <code>shutdown</code> / <code>no shutdown</code> — the client&#39;s two methods. Shutting down tears down every adjacency and withdraws every advertised route at once; the confirm quotes the measured adjacency proxy and says what actually produced it.</p>
      <form onSubmit={onShutdownSubmit}>
        <div className="field-row">
          <div>
            <label htmlFor="ospf-shutdown-mode">Target state</label>
            <select id="ospf-shutdown-mode" name="ospf-shutdown-mode" value={shutdownDraft.mode} onChange={(event) => onShutdownChange({ mode: event.target.value })} disabled={formsDisabled || noProcess}>
              <option value="">— choose —</option>
              <option value="shutdown">shut the process down</option>
              <option value="no-shutdown">bring it up (`no shutdown`)</option>
            </select>
          </div>
        </div>
        {shutdownError !== undefined && <p className="notice notice-error" role="alert">{shutdownError}</p>}
        <div className="review-actions">
          <button className="primary-button" type="submit" disabled={formsDisabled || noProcess}>Stage shutdown change</button>
        </div>
      </form>
    </section>

    {/* Staged review panel — the standing pattern; commit/abort live in Transaction Center only */}
    {notice !== '' && <p className="notice notice-success operation-result" role="status">{notice}</p>}
    {failure !== '' && <div className="notice notice-error operation-result" role="alert"><strong>The device did not take that.</strong><p>{failure}</p></div>}
    <p className="field-note">The forms above only stage into the shared transaction — nothing on this screen commits or aborts (issue #141: the Transaction Center owns those).</p>
  </section>
}
