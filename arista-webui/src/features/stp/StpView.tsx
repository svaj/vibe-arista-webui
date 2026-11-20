/**
 * S15 (#85): the presentation half of the spanning-tree screen. Pure props (matching `NtpView` /
 * `SystemSettingsView`); every device string arrives as a plain value, and no `StpSettings`,
 * `StpInterface` or `ConfigSession` crosses this boundary.
 *
 * ## The boundary this view keeps honest (the #85 acceptance line)
 *
 * Every field here is CONFIG-BACKED: `node.stp.get()` parses `running-config all`
 * (`arista-api-client/src/resources/stp.ts`), and `show spanning-tree` has no capture for this
 * device, so the summary panel shows the configured mode token only and carries
 * {@link STP_OPERATIONAL_NOTE}; a test pins that operational state vocabulary never reaches the
 * DOM. No global-mode control renders anywhere (blocked issue B3 #88) — {@link STP_MODE_EDIT_NOTE}
 * is static copy, not a form. The MST/instance half says what it is: this client's reader is
 * upstream's stub ({@link STP_INSTANCES_NOTE}).
 *
 * Configured text (tokens the device wrote) renders as trusted `<code>`; the only untrusted free
 * text is the config diff, which renders in a real `<pre>` — the same pin shape as the rest of the
 * wave.
 */
import type { FormEvent } from 'react'
import type { ReactElement } from 'react'

import { ConnectionHeader } from '../../components/ui/ConnectionHeader'
import type { ConnectionState } from '../../components/ui/ConnectionHeader'
import { DataTable } from '../../components/ui/DataTable'
import type { DataTableColumn } from '../../components/ui/DataTable'
import { EmptyState } from '../../components/ui/EmptyState'
import { StatePill } from '../../components/ui/StatePill'
import { STP_INSTANCES_NOTE, STP_MODE_EDIT_NOTE, STP_OPERATIONAL_NOTE, STP_WRITE_ACTIONS, isClientPortfastType } from './stp-rules'
import type { StpPortRowView } from './stp-rules'

/** One option in the in-screen port selector. */
export interface StpPortOption {
  readonly name: string
  /** False for a name the client reads (Et/Po prefix gate) but refuses to write (row 168). */
  readonly writable: boolean
}

export interface StpViewProps {
  readonly state: 'loading' | 'ready' | 'failed'
  readonly readError?: string
  readonly proxyPrompt?: string
  readonly identity?: { hostname: string; version: string; model: string }

  // --- summary (configured state only) ----------------------------------------------------------------
  /** False while no `stp.get()` has answered — the screen must not show "no mode" as confirmed. */
  readonly portsKnown: boolean
  /** The verbatim `spanning-tree mode <token>`; `undefined` when the config carries no such line. */
  readonly mode?: string
  readonly portCount: number
  readonly rows: readonly StpPortRowView[]

  // --- per-port editor ------------------------------------------------------------------------------
  readonly ports: readonly StpPortOption[]
  readonly selectedPort: string
  readonly selectedAction: string
  /** Set when the selected port's name is one this client will not write spanning-tree to. */
  readonly portRefusal?: string
  /** Set when Preview was clicked without a change chosen. */
  readonly actionError?: string
  readonly onPortChange: (name: string) => void
  readonly onActionChange: (id: string) => void
  readonly onPreview: (event: FormEvent<HTMLFormElement>) => void

  readonly busy: boolean
  readonly canAct: boolean
  readonly notice: string
  readonly failure: string
  readonly connection: ConnectionState
  readonly connectionLabel: string
  readonly onReload: () => void
}

export function StpView(props: StpViewProps): ReactElement {
  const {
    state,
    readError,
    proxyPrompt,
    identity,
    portsKnown,
    mode,
    portCount,
    rows,
    ports,
    selectedPort,
    selectedAction,
    portRefusal,
    actionError,
    onPortChange,
    onActionChange,
    onPreview,
    busy,
    canAct,
    notice,
    failure,
    connection,
    connectionLabel,
    onReload,
  } = props

  // F3 (#65) is the only table shape in this wave — every screen routes its tabular read through
  // `DataTable`, so the `<th scope="col">` + `table-scroll` markup stays identical here too.
  const portColumns: readonly DataTableColumn<StpPortRowView>[] = [
    { header: 'Interface', cell: (row) => <code>{row.interfaceName}</code> },
    { header: 'BPDU guard', cell: (row) => <StatePill value={row.bpduguard ? 'enabled' : 'disabled'} /> },
    { header: 'PortFast', cell: (row) => <StatePill value={row.portfast ? 'enabled' : 'disabled'} /> },
    {
      header: 'PortFast type',
      cell: (row) => (
        <>
          <code>{row.portfastType}</code>
          {!isClientPortfastType(row.portfastType) && <span className="field-note"> (token the device wrote; outside this client’s write set)</span>}
        </>
      ),
    },
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
        <p className="eyebrow">SWITCHING</p>
        <h2 id="workspace-title">Spanning tree</h2>
      </div>
      <button className="quiet-button" type="button" onClick={onReload} disabled={!canAct || busy}>Reload spanning-tree state</button>
    </div>

    {proxyPrompt !== undefined && <div className="notice notice-error" role="alert"><strong>Local proxy is not configured.</strong><p>{proxyPrompt}</p></div>}

    <p className="notice notice-warning" role="status">
      This screen edits <strong>configured per-port spanning-tree state</strong> read from
      <code>running-config all</code> — it is <strong>not</strong> a view of live spanning-tree
      state. The writes stage a named config session, show the device&#39;s own <code>diff()</code>,
      then commit to running-config only (startup-config is never written, DR-024). The guards here
      mirror what <em>this client</em> composes and refuses (DR-057); the device keeps the final
      say — a line this client staged but the CLI rejects returns as the device&#39;s own
      <code>CommandError</code>.
    </p>

    {state === 'loading' && <p className="notice" role="status">Reading the spanning-tree configuration (parsed running-config, client §5 rows 167-172)…</p>}
    {readError !== undefined && <div className="notice notice-error" role="alert"><strong>The spanning-tree read failed.</strong><p>{readError}</p><button className="quiet-button" type="button" onClick={onReload} disabled={busy}>Try again</button></div>}

    {/* Summary — configured mode only; operational half is uncaptured by contract */}
    <section className="panel" aria-labelledby="stp-summary-title">
      <div className="panel-heading">
        <div><p className="eyebrow">CONFIGURED</p><h3 id="stp-summary-title">STP summary</h3></div>
        <span className="panel-index">{portsKnown ? `${String(portCount)} port(s)` : 'unread'}</span>
      </div>
      <p className="field-note">
        Configured mode:{' '}
        <strong>
          {!portsKnown
            ? '(no spanning-tree read has answered yet)'
            : mode === undefined
              ? '(none — the running-config carries no `spanning-tree mode` line)'
              : <code>{mode}</code>}
        </strong>{' '}
        The token is whatever the device wrote, kept verbatim — this client does not translate it.
      </p>
      <p className="field-note">
        <strong>Operational state is not shown.</strong> <code>show spanning-tree</code> has no
        capture for this device, so per the #85 boundary: {STP_OPERATIONAL_NOTE} (M12 #14). Nothing on
        this panel claims what any port is actually doing.
      </p>
      <p className="field-note">{STP_MODE_EDIT_NOTE}</p>
      <p className="field-note">{STP_INSTANCES_NOTE}</p>
    </section>

    {/* Per-port config table */}
    <section className="panel" aria-labelledby="stp-ports-title">
      <div className="panel-heading">
        <div><p className="eyebrow">CONFIGURED</p><h3 id="stp-ports-title">Per-port spanning-tree config</h3></div>
        <span className="panel-index">{!portsKnown ? 'unread' : portCount === 0 ? 'none' : portCount.toString().padStart(2, '0')}</span>
      </div>

      {!portsKnown
        ? <p className="field-note">No spanning-tree read has answered yet, so the port list is unknown — not empty.</p>
        : portCount === 0
          ? <EmptyState heading="No Ethernet or Port-Channel section in the running-config carries spanning-tree lines." hint="An empty table is a normal configured state, not an error: this client lists interfaces whose section name passes its read gate (Et/Po prefix, row 168) — a port with no section at all is simply not shown." />
          : <>
            <p className="field-note">
              How to read the pills: <strong>BPDU guard &ldquo;enabled&rdquo;</strong> means the exact
              <code>spanning-tree bpduguard enable</code> line was read (§5 row 170); &ldquo;disabled&rdquo;
              covers the disable word, the negated line, and no line at all. <strong>PortFast
              &ldquo;enabled&rdquo;</strong> means no exact <code>no spanning-tree portfast</code> line was
              read — upstream&#39;s default-on reading, so &ldquo;enabled&rdquo; here does not prove anyone
              configured the port that way.
            </p>
            <DataTable columns={portColumns} rows={rows} rowKey={(row) => row.interfaceName} label="Per-port spanning-tree configuration" />
          </>}
    </section>

    {/* Per-port guard editor — its own selector; the router has no per-port param channel */}
    <section className="panel" aria-labelledby="stp-editor-title">
      <div className="panel-heading">
        <div><p className="eyebrow">WRITE (NAMED SESSION)</p><h3 id="stp-editor-title">Per-port guard edits</h3></div>
        <span className="panel-index">{ports.length === 0 ? 'no ports' : `${ports.filter((port) => port.writable).length} writable`}</span>
      </div>
      <form onSubmit={onPreview}>
        <div className="field-row">
          <div>
            <label htmlFor="stp-port">Port</label>
            <select id="stp-port" name="stp-port" value={selectedPort} onChange={(event) => onPortChange(event.target.value)} disabled={!canAct || busy || ports.length === 0}>
              <option value="">— choose a port —</option>
              {ports.map((port) => <option key={port.name} value={port.name}>{port.name}{port.writable ? '' : ' (read-only here)'}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="stp-action">Change</label>
            <select id="stp-action" name="stp-action" value={selectedAction} onChange={(event) => onActionChange(event.target.value)} disabled={!canAct || busy}>
              <option value="">— choose a change —</option>
              {STP_WRITE_ACTIONS.map((action) => <option key={action.id} value={action.id}>{action.label}</option>)}
            </select>
          </div>
        </div>
        <p className="field-note">
          Every change below stages <code>interface &lt;port&gt;</code> plus the exact line(s) the frozen
          client&#39;s verb composes — <code>spanning-tree bpduguard enable</code> / <code>… disable</code>
          (the two WORDS, divergence 8), <code>no</code> / <code>default</code> forms, and the PortFast
          bare/<code>edge</code>+<code>auto</code>/<code>network</code>/<code>normal</code> texts. Enabling
          PortFast is HARD-CONFIRMED: this UI cannot see what is connected on the far end of a port.
        </p>
        {portRefusal !== undefined && <p className="notice notice-error" role="alert">{portRefusal}</p>}
        {actionError !== undefined && <p className="notice notice-error" role="alert">{actionError}</p>}
        <div className="review-actions">
          {/* Deliberately enabled with no action chosen: the in-form refusal copy ("choose a change")
              is the teacher, matching how S12 submits the form to reach its rule messages. */}
          <button className="primary-button" type="submit" disabled={!canAct || busy}>Preview change</button>
        </div>
      </form>
    </section>

    {/* Staged review panel */}
    {notice !== '' && <p className="notice notice-success operation-result" role="status">{notice}</p>}
    {failure !== '' && <div className="notice notice-error operation-result" role="alert"><strong>The device did not take that.</strong><p>{failure}</p></div>}
  </section>
}
