/**
 * S12 (#82): the presentation half of the NTP screen. Pure props (matching `SystemSettingsView` /
 * `CommandConsoleView`); every device string arrives as a plain value.
 *
 * ## The boundary this view keeps honest (the #82 acceptance line)
 *
 * Everything here is CONFIGURED state read from `running-config all` via `node.ntp.get()`, and the
 * screen says so in its own header copy. The SYNCHRONIZATION half (stratum, clock offset, which peer
 * is synced) is NOT shown — it awaits `show ntp status` / `show ntp associations` captures that do
 * not exist for this device, so the panel states "not captured" and never fabricates a field. A test
 * pins that the synchronisation vocabulary never reaches the DOM.
 *
 * Configured text (a server address the device wrote) renders as trusted `<code>`; the only untrusted
 * free text that could carry an HTML sink is the config diff, which renders in a real `<pre>` — the
 * same pin shape as the rest of the wave.
 */
import type { FormEvent } from 'react'
import type { ReactElement } from 'react'

import { ConnectionHeader } from '../../components/ui/ConnectionHeader'
import type { ConnectionState } from '../../components/ui/ConnectionHeader'
import { DataTable } from '../../components/ui/DataTable'
import type { DataTableColumn } from '../../components/ui/DataTable'
import { EmptyState } from '../../components/ui/EmptyState'
import { StatePill } from '../../components/ui/StatePill'
import type { SourceStem } from './ntp-rules'

export interface NtpServerRowView {
  readonly address: string
  readonly prefer: boolean
  onRemove: (address: string) => void
}

export interface NtpViewProps {
  readonly state: 'loading' | 'ready' | 'failed'
  readonly readError?: string
  readonly proxyPrompt?: string
  readonly identity?: { hostname: string; version: string; model: string }

  // --- configured servers ---------------------------------------------------------------------
  /** False while no `ntp.get()` has answered — the screen must not show `[]` as "confirmed empty". */
  readonly serversKnown: boolean
  readonly servers: readonly NtpServerRowView[]
  /** The trimmed operator draft for the Add-server field (`''` = untouched). */
  readonly newAddressDraft: string
  readonly newPreferDraft: boolean
  readonly newServerError?: string
  /** Whether this version lets the source verbs run at all (server verbs never depend on it). */
  readonly sourceFormKnown: boolean
  /** The device's version-conditional source stem preview, e.g. `ntp local-interface`. */
  readonly sourceStem?: SourceStem
  readonly onNewAddressChange: (value: string) => void
  readonly onNewPreferChange: (value: boolean) => void
  readonly onAddServer: (event: FormEvent<HTMLFormElement>) => void
  readonly onRemoveAllServers: () => void
  readonly serverCount: number

  // --- configured source ----------------------------------------------------------------------
  readonly sourceKnown: boolean
  /** The currently configured source interface, or `undefined` when none is configured. */
  readonly sourceInterface?: string
  readonly sourceDraft: string
  readonly sourceError?: string
  readonly onSourceChange: (value: string) => void
  readonly onSetSource: (event: FormEvent<HTMLFormElement>) => void
  readonly onUnsetSource: () => void
  readonly onDefaultSource: () => void

  // --- synchronisation (uncaptured) -----------------------------------------------------------
  // Rendered from a fixed panel, no device data — there is nothing to feed.

  readonly busy: boolean
  readonly canAct: boolean
  readonly notice: string
  readonly failure: string
  readonly connection: ConnectionState
  readonly connectionLabel: string
  readonly onReload: () => void
}

export function NtpView(props: NtpViewProps): ReactElement {
  const {
    state,
    readError,
    proxyPrompt,
    identity,
    serversKnown,
    servers,
    newAddressDraft,
    newPreferDraft,
    newServerError,
    sourceFormKnown,
    sourceStem,
    onNewAddressChange,
    onNewPreferChange,
    onAddServer,
    onRemoveAllServers,
    serverCount,
    sourceKnown,
    sourceInterface,
    sourceDraft,
    sourceError,
    onSourceChange,
    onSetSource,
    onUnsetSource,
    onDefaultSource,
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
  const serverColumns: readonly DataTableColumn<NtpServerRowView>[] = [
    { header: 'Address', cell: (row) => <code>{row.address}</code> },
    { header: 'Preference', cell: (row) => row.prefer ? <StatePill value="preferred" /> : 'normal' },
    { header: 'Action', cell: (row) => <button className="danger-button" type="button" onClick={() => row.onRemove(row.address)} disabled={!canAct || busy}>Remove server {row.address}</button> },
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
        <p className="eyebrow">GLOBAL CONFIG</p>
        <h2 id="workspace-title">NTP</h2>
      </div>
      <button className="quiet-button" type="button" onClick={onReload} disabled={!canAct || busy}>Reload device state</button>
    </div>

    {proxyPrompt !== undefined && <div className="notice notice-error" role="alert"><strong>Local proxy is not configured.</strong><p>{proxyPrompt}</p></div>}

    <p className="notice notice-warning" role="status">
      This screen edits <strong>configured NTP state</strong> read from <code>running-config all</code> —
      it is <strong>not</strong> a view of live synchronisation. The writes stage a named config session,
      show the device&#39;s own <code>diff()</code>, then commit to running-config only (startup-config is
      never written, DR-024). The guards here mirror what <em>this client</em> composes and refuses
      (DR-057); the device keeps the final say — a line this client staged but the CLI rejects returns
      as the device&#39;s own <code>CommandError</code>.
    </p>

    {state === 'loading' && <p className="notice" role="status">Reading the running-config (NTP settings come from parsed config, M &#167;5 rows 155-157)…</p>}
    {readError !== undefined && <div className="notice notice-error" role="alert"><strong>The NTP read failed.</strong><p>{readError}</p><button className="quiet-button" type="button" onClick={onReload} disabled={busy}>Try again</button></div>}

    {/* Configured servers */}
    <section className="panel" aria-labelledby="ntp-servers-title">
      <div className="panel-heading">
        <div><p className="eyebrow">CONFIGURED</p><h3 id="ntp-servers-title">NTP servers</h3></div>
        <span className="panel-index">{!serversKnown ? 'unread' : serverCount === 0 ? 'none' : serverCount.toString().padStart(2, '0')}</span>
      </div>

      {!serversKnown
        ? <p className="field-note">No NTP read has answered yet, so the server list is unknown — not empty.</p>
        : serverCount === 0
          ? <EmptyState heading="No NTP servers are configured." hint="An empty server list is a normal configured state, not an error. Add one below to point this device at a clock source." />
          : <DataTable columns={serverColumns} rows={servers} rowKey={(row) => row.address} label="Configured NTP servers" />}

      <form onSubmit={onAddServer}>
        <label htmlFor="ntp-new-server">Add NTP server (one address token)</label>
        <input
          id="ntp-new-server"
          name="ntp-new-server"
          value={newAddressDraft}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => onNewAddressChange(event.target.value)}
          disabled={!canAct || busy}
        />
        <label htmlFor="ntp-new-prefer" className="field-note">
          <input
            id="ntp-new-prefer"
            name="ntp-new-prefer"
            type="checkbox"
            checked={newPreferDraft}
            onChange={(event) => onNewPreferChange(event.target.checked)}
            disabled={!canAct || busy}
          />
          {' '}Prefer this server (the only server option this client composes)
        </label>
        <p className="field-note">
          The <code>addServer</code> port composes only <code>ntp server &lt;address&gt;</code> optionally
          followed by <code>prefer</code>. <code>version 4</code>, <code>iburst</code> and other trailing
          options are not spells this client ports, so the screen refuses them rather than forward an
          un-recognised line — the reason is always the client contract, not a claim about the device.
        </p>
        <div className="review-actions">
          <button className="primary-button" type="submit" disabled={!canAct || busy || newAddressDraft.trim() === ''}>Add server</button>
          <button className="danger-button" type="button" onClick={onRemoveAllServers} disabled={!canAct || busy || !serversKnown || serverCount === 0}>Remove all servers</button>
        </div>
      </form>
      {newServerError !== undefined && <p className="notice notice-error" role="alert">{newServerError}</p>}
    </section>

    {/* Configured source interface */}
    <section className="panel" aria-labelledby="ntp-source-title">
      <div className="panel-heading">
        <div><p className="eyebrow">CONFIGURED</p><h3 id="ntp-source-title">NTP source interface</h3></div>
        <span className="panel-index">{!sourceKnown ? 'unread' : sourceInterface === undefined ? 'unset' : 'set'}</span>
      </div>
      <p className="field-note">
        Current configured source: <strong>{!sourceKnown ? '(no NTP read has answered yet)' : sourceInterface === undefined ? '(none — the running-config carries no `ntp source` / `ntp local-interface` line)' : sourceInterface}</strong>.
        {!sourceFormKnown && ' The `show version` read has not answered, so the screen cannot pick the `ntp source` vs `ntp local-interface` form this device accepts; the source verbs below are refused until a refresh returns a version.'}
        {sourceFormKnown && sourceStem !== undefined && <> The staged line on this device uses the <code>{sourceStem}</code> form (chosen by the client&#39;s version floor, not invented here).</>}
      </p>
      <p className="field-note">
        Changing the source can move where the device sends NTP. Whether the current source is the
        interface carrying this UI&#39;s own eAPI path is <strong>not observable from this screen</strong>:
        the only interface it can see is the one the config already names, so the confirm below names
        that configured interface and you keep the judgement about the in-band path.
      </p>
      <form onSubmit={onSetSource}>
        <label htmlFor="ntp-source-interface">Source interface name</label>
        <input
          id="ntp-source-interface"
          name="ntp-source-interface"
          value={sourceDraft}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => onSourceChange(event.target.value)}
          disabled={!canAct || busy}
        />
        <div className="review-actions">
          <button className="primary-button" type="submit" disabled={!canAct || busy || sourceDraft.trim() === ''}>Set source interface</button>
          <button className="danger-button" type="button" onClick={onUnsetSource} disabled={!canAct || busy || !sourceKnown || sourceInterface === undefined}>Unset source</button>
          <button className="quiet-button" type="button" onClick={onDefaultSource} disabled={!canAct || busy}>Default source</button>
        </div>
      </form>
      {sourceError !== undefined && <p className="notice notice-error" role="alert">{sourceError}</p>}
    </section>

    {/* Synchronisation state — deliberately uncaptured */}
    <section className="panel" aria-labelledby="ntp-sync-title">
      <div className="panel-heading">
        <div><p className="eyebrow">SYNCHRONISATION</p><h3 id="ntp-sync-title">Live NTP state</h3></div>
        <span className="panel-index">not captured</span>
      </div>
      <EmptyState
        heading="Synchronisation state is unknown — not captured."
        hint={'This device has no `show ntp status` / `show ntp associations` capture yet (the CAPTURES gate on issue #82), so clock level, time offset and peer state are not shown and are never guessed. The section lights up only once those captures exist.'}
      />
    </section>

    {notice !== '' && <p className="notice notice-success operation-result" role="status">{notice}</p>}
    {failure !== '' && <div className="notice notice-error operation-result" role="alert"><strong>The device did not take that.</strong><p>{failure}</p></div>}
  </section>
}
