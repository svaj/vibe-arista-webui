/**
 * S16 (#90): the presentation half of the VRF manager — route `#/vrfs`. Pure props, same split as
 * `NtpView` (#82): every device string arrives as a plain value and nothing here contacts a client.
 *
 * The two read sources are named where they render: the write-driving table is parsed
 * running-config (`node.vrfs.getAll()` + `node.interfaces.getAll()`), and the "Device (show vrf)"
 * columns come only from the capture-backed `show vrf` reply — no protocol claim is made from
 * config text, and when that soft read has not answered the columns say exactly that.
 *
 * Configured text renders as trusted `<code>`; the only untrusted free text is the config diff,
 * which renders in a real `<pre>` — the wave-wide pin shape.
 */
import type { FormEvent } from 'react'
import type { ReactElement } from 'react'

import { ConnectionHeader } from '../../components/ui/ConnectionHeader'
import type { ConnectionState } from '../../components/ui/ConnectionHeader'
import { DataTable } from '../../components/ui/DataTable'
import type { DataTableColumn } from '../../components/ui/DataTable'
import { EmptyState } from '../../components/ui/EmptyState'
import { StatePill } from '../../components/ui/StatePill'

export interface VrfsRowView {
  readonly name: string
  readonly definitionForm: string
  readonly rd?: string
  readonly description?: string
  readonly ipv4Routing: boolean
  readonly ipv6Routing: boolean
  /** Ports the parsed running-config assigns to this VRF (config truth, not device state). */
  readonly members: readonly string[]
  /** Composed from the `show vrf` reply only — `undefined` until that soft read answers. */
  readonly deviceState?: string
  readonly onManage: (name: string) => void
}

export interface VrfsSelectedView {
  readonly name: string
  readonly definitionForm: string
  readonly rd?: string
  readonly description?: string
  readonly ipv4Routing: boolean
  readonly ipv6Routing: boolean
  readonly members: readonly string[]
}

export interface VrfsDeviceRowView {
  readonly name: string
  readonly isDefault: boolean
  readonly vrfState: string
  readonly interfaces: readonly string[]
  readonly ipv4: string
  readonly ipv6: string
}

export interface VrfsInterfaceOptionView {
  readonly name: string
  /** The VRF the parsed config assigns this port to — `undefined` = the default VRF. */
  readonly current?: string
}

export interface VrfsDraftView {
  readonly sessionName: string
  readonly effectLabel: string
  readonly batch: readonly string[]
  readonly risks: readonly string[]
  /** `undefined` while the device `diff()` has not come back yet. */
  readonly diff?: string
  readonly canCommit: boolean
  readonly destructive: boolean
}

export interface VrfsViewProps {
  readonly state: 'loading' | 'ready' | 'failed'
  readonly readError?: string
  readonly proxyPrompt?: string
  readonly identity?: { hostname: string; version: string; model: string }

  // --- configured VRFs (parsed running-config) ---------------------------------------------------
  readonly vrfsKnown: boolean
  readonly rows: readonly VrfsRowView[]
  readonly vrfCount: number
  /** The keyword form writes will use, per the client&#39;s DR-099 config-evidence rule. */
  readonly writeForm: string
  /** False when no VRF section exists yet — the form is then the client convention, not device text. */
  readonly writeFormFromConfig: boolean

  // --- create panel -------------------------------------------------------------------------------
  readonly createNameDraft: string
  readonly createRdDraft: string
  readonly createDescDraft: string
  readonly createError?: string
  readonly onCreateNameChange: (value: string) => void
  readonly onCreateRdChange: (value: string) => void
  readonly onCreateDescChange: (value: string) => void
  readonly onCreate: (event: FormEvent<HTMLFormElement>) => void

  // --- manage-editor panel (selected VRF) -----------------------------------------------------------
  readonly selected?: VrfsSelectedView
  readonly rdDraft: string
  readonly descDraft: string
  readonly selectedError?: string
  readonly onRdDraftChange: (value: string) => void
  readonly onDescDraftChange: (value: string) => void
  readonly onSetRd: (event: FormEvent<HTMLFormElement>) => void
  readonly onUnsetRd: () => void
  readonly onSetDescription: (event: FormEvent<HTMLFormElement>) => void
  readonly onUnsetDescription: () => void
  readonly onRouting: (family: 'ipv4' | 'ipv6', arm: 'set' | 'no' | 'default') => void
  readonly onDeleteSelected: () => void

  // --- interface-assignment panel -----------------------------------------------------------------
  readonly interfaceOptions: readonly VrfsInterfaceOptionView[]
  readonly assignInterface: string
  readonly assignVrf: string
  readonly vrfOptions: readonly string[]
  readonly assignError?: string
  readonly onAssignInterfaceChange: (value: string) => void
  readonly onAssignVrfChange: (value: string) => void
  readonly onBind: () => void
  readonly onUnbind: () => void

  // --- device columns (show vrf) ------------------------------------------------------------------
  readonly deviceStateKnown: boolean
  readonly deviceRows: readonly VrfsDeviceRowView[]

  // --- staged review ----------------------------------------------------------------------------
  readonly draft?: VrfsDraftView
  readonly busy: boolean
  readonly canAct: boolean
  readonly notice: string
  readonly failure: string
  readonly connection: ConnectionState
  readonly connectionLabel: string
  readonly onCommitDraft: () => void
  readonly onAbortDraft: () => void
  readonly onReload: () => void
}

export function VrfsView(props: VrfsViewProps): ReactElement {
  const {
    state,
    readError,
    proxyPrompt,
    identity,
    vrfsKnown,
    rows,
    vrfCount,
    writeForm,
    writeFormFromConfig,
    createNameDraft,
    createRdDraft,
    createDescDraft,
    createError,
    onCreateNameChange,
    onCreateRdChange,
    onCreateDescChange,
    onCreate,
    selected,
    rdDraft,
    descDraft,
    selectedError,
    onRdDraftChange,
    onDescDraftChange,
    onSetRd,
    onUnsetRd,
    onSetDescription,
    onUnsetDescription,
    onRouting,
    onDeleteSelected,
    interfaceOptions,
    assignInterface,
    assignVrf,
    vrfOptions,
    assignError,
    onAssignInterfaceChange,
    onAssignVrfChange,
    onBind,
    onUnbind,
    deviceStateKnown,
    deviceRows,
    draft,
    busy,
    canAct,
    notice,
    failure,
    connection,
    connectionLabel,
    onCommitDraft,
    onAbortDraft,
    onReload,
  } = props

  const vrfColumns: readonly DataTableColumn<VrfsRowView>[] = [
    { header: 'Name', cell: (row) => <code>{row.name}</code> },
    { header: 'Form', cell: (row) => <code>{row.definitionForm}</code> },
    { header: 'RD', cell: (row) => row.rd === undefined ? <span className="field-note">none</span> : <code>{row.rd}</code> },
    { header: 'Description', cell: (row) => row.description ?? <span className="field-note">—</span> },
    { header: 'IPv4 routing', cell: (row) => <StatePill value={row.ipv4Routing ? 'enabled' : 'disabled'} /> },
    { header: 'IPv6 routing', cell: (row) => <StatePill value={row.ipv6Routing ? 'enabled' : 'disabled'} /> },
    { header: 'Members (config)', cell: (row) => row.members.length === 0 ? <span className="field-note">none</span> : row.members.map((m) => <code key={m}>{m}</code>) },
    { header: 'Device (show vrf)', cell: (row) => row.deviceState ?? <span className="field-note">no read</span> },
    { header: 'Action', cell: (row) => <button className="quiet-button" type="button" onClick={() => row.onManage(row.name)} disabled={!canAct || busy}>Manage {row.name}</button> },
  ]

  const deviceColumns: readonly DataTableColumn<VrfsDeviceRowView>[] = [
    { header: 'VRF', cell: (row) => <>{row.isDefault ? <><code>{row.name}</code> <span className="field-note">(built-in)</span></> : <code>{row.name}</code>}</> },
    { header: 'State', cell: (row) => <StatePill value={row.vrfState} /> },
    { header: 'Interfaces (device)', cell: (row) => row.interfaces.length === 0 ? <span className="field-note">none</span> : row.interfaces.map((i) => <code key={i}>{i}</code>) },
    { header: 'IPv4', cell: (row) => row.ipv4 },
    { header: 'IPv6', cell: (row) => row.ipv6 },
  ]

  const selectedIface = interfaceOptions.find((option) => option.name === assignInterface)

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
        <p className="eyebrow">ROUTING / FORWARDING</p>
        <h2 id="workspace-title">VRF manager</h2>
      </div>
      <button className="quiet-button" type="button" onClick={onReload} disabled={!canAct || busy}>Reload device state</button>
    </div>

    {proxyPrompt !== undefined && <div className="notice notice-error" role="alert"><strong>Local proxy is not configured.</strong><p>{proxyPrompt}</p></div>}

    <p className="notice notice-warning" role="status">
      This screen edits <strong>VRF configuration</strong> read from parsed running-config
      (<code>node.vrfs.getAll()</code> and per-port <code>vrf</code> assignments); the columns marked
      <em> Device (show vrf) </em>come only from the capture-backed <code>show vrf</code> reply. Writes
      stage a named config session, show the device&#39;s own <code>diff()</code>, then commit to
      running-config only (startup-config is never written, DR-024). The guards here mirror what
      <em> this client</em> composes and refuses (DR-057/DR-141); the device keeps the final say — a
      staged line the CLI rejects returns as its own <code>CommandError</code>.
    </p>

    {state === 'loading' && <p className="notice" role="status">Reading the running-config (VRF sections and per-port VRF assignments come from parsed config)…</p>}
    {readError !== undefined && <div className="notice notice-error" role="alert"><strong>The VRF reads failed.</strong><p>{readError}</p><button className="quiet-button" type="button" onClick={onReload} disabled={busy}>Try again</button></div>}

    {/* Configured VRFs */}
    <section className="panel" aria-labelledby="vrfs-table-title">
      <div className="panel-heading">
        <div><p className="eyebrow">CONFIGURED</p><h3 id="vrfs-table-title">VRFs (running-config)</h3></div>
        <span className="panel-index">{!vrfsKnown ? 'unread' : vrfCount === 0 ? 'none' : vrfCount.toString().padStart(2, '0')}</span>
      </div>

      <p className="field-note">
        New VRFs on this device will be staged with the <code>vrf {writeForm}</code> header
        {!writeFormFromConfig
          ? ' — no VRF section exists in the config yet, so this is the client\u2019s convention default (DR-099), not a keyword read off the device; a device that rejects it answers with its own error.'
          : ' — the keyword the device\u2019s own written config text speaks (DR-099). On the supervised run this box refused `vrf definition` as deprecated (1002), and this screen only stages the definition form when the device\u2019s config already speaks it.'}
        {' '}The <code>default</code> VRF is the built-in one: it appears in <code>show vrf</code> below, never in this table, because no config section defines it.
      </p>

      {!vrfsKnown
        ? <p className="field-note">No VRF read has answered yet, so the list is unknown — not empty.</p>
        : vrfCount === 0
          ? <EmptyState heading="No non-default VRFs are configured." hint="A device with only the built-in default VRF is a normal configured state, not an error. Create one below — the run-9 hardware probe staged this exact composition successfully." />
          : <DataTable columns={vrfColumns} rows={rows} rowKey={(row) => row.name} label="Configured VRFs" />}
    </section>

    {/* Create */}
    <section className="panel" aria-labelledby="vrfs-create-title">
      <div className="panel-heading">
        <div><p className="eyebrow">NAMED SESSION</p><h3 id="vrfs-create-title">Create a VRF</h3></div>
        <span className="panel-index">add</span>
      </div>
      <form onSubmit={onCreate}>
        <label htmlFor="vrf-create-name">VRF name (numbers, letters, underscore)</label>
        <input id="vrf-create-name" name="vrf-create-name" value={createNameDraft} spellCheck={false} autoComplete="off" onChange={(event) => onCreateNameChange(event.target.value)} disabled={!canAct || busy} />
        <label htmlFor="vrf-create-rd">Route distinguisher — optional, one token (e.g. <code>65000:1</code>)</label>
        <input id="vrf-create-rd" name="vrf-create-rd" value={createRdDraft} spellCheck={false} autoComplete="off" onChange={(event) => onCreateRdChange(event.target.value)} disabled={!canAct || busy} />
        <label htmlFor="vrf-create-desc">Description — optional</label>
        <input id="vrf-create-desc" name="vrf-create-desc" value={createDescDraft} spellCheck={false} autoComplete="off" onChange={(event) => onCreateDescChange(event.target.value)} disabled={!canAct || busy} />
        <p className="field-note">
          Staged lines: <code>{`vrf ${writeForm} <name>`}</code>{createRdDraft.trim() !== '' && <> then <code>rd {createRdDraft.trim()}</code></>}{createDescDraft.trim() !== '' && <> then <code>description {createDescDraft.trim()}</code></>}.
          The header and the <code>rd</code> line travel in one batch, the way <code>vrfs.create</code>
          sends them — the supervised run 9 proved this exact composition stages FULL on this box.
          On a fresh VRF the device&#39;s own diff added <code>no ip routing vrf &lt;name&gt;</code>: whether
          routing is on for the new VRF is the device&#39;s choice, read back after commit, never claimed here.
        </p>
        <div className="review-actions">
          <button className="primary-button" type="submit" disabled={!canAct || busy || createNameDraft.trim() === ''}>Stage create VRF</button>
        </div>
      </form>
      {createError !== undefined && <p className="notice notice-error" role="alert">{createError}</p>}
    </section>

    {/* Manage selected VRF */}
    {selected === undefined
      ? <section className="panel" aria-labelledby="vrfs-manage-title">
        <div className="panel-heading">
          <div><p className="eyebrow">NAMED SESSION</p><h3 id="vrfs-manage-title">Manage a VRF</h3></div>
          <span className="panel-index">no selection</span>
        </div>
        <p className="field-note">Pick <strong>Manage</strong> on a row above to edit its rd, description, routing flags, or delete it. Every action stages its own named session.</p>
      </section>
      : <section className="panel" aria-labelledby="vrfs-manage-title">
        <div className="panel-heading">
          <div><p className="eyebrow">NAMED SESSION</p><h3 id="vrfs-manage-title">Managing <code>{selected.name}</code></h3></div>
          <span className="panel-index">{selected.definitionForm}</span>
        </div>
        <p className="field-note">
          Current config read: rd <strong>{selected.rd ?? '(none)'}</strong>, description <strong>{selected.description ?? '(none)'}</strong>,
          IPv4 routing <strong>{selected.ipv4Routing ? 'enabled' : 'disabled'}</strong>, IPv6 routing <strong>{selected.ipv6Routing ? 'enabled' : 'disabled'}</strong>.
          {selected.members.length > 0 && <> Ports assigned by config: {selected.members.map((m) => <code key={m}>{m}</code>)}.</>}
        </p>

        <form onSubmit={onSetRd}>
          <label htmlFor="vrf-rd-field">Route distinguisher (one token; use Clear to remove via <code>no rd</code>)</label>
          <input id="vrf-rd-field" name="vrf-rd-field" value={rdDraft} spellCheck={false} autoComplete="off" onChange={(event) => onRdDraftChange(event.target.value)} disabled={!canAct || busy} />
          <div className="review-actions">
            <button className="primary-button" type="submit" disabled={!canAct || busy || rdDraft.trim() === '' || rdDraft.trim() === selected.rd}>Set rd</button>
            <button className="quiet-button" type="button" onClick={onUnsetRd} disabled={!canAct || busy || selected.rd === undefined}>Clear rd</button>
          </div>
        </form>

        <form onSubmit={onSetDescription}>
          <label htmlFor="vrf-desc-field">Description</label>
          <input id="vrf-desc-field" name="vrf-desc-field" value={descDraft} spellCheck={false} autoComplete="off" onChange={(event) => onDescDraftChange(event.target.value)} disabled={!canAct || busy} />
          <div className="review-actions">
            <button className="primary-button" type="submit" disabled={!canAct || busy || descDraft.trim() === '' || descDraft.trim() === selected.description}>Set description</button>
            <button className="quiet-button" type="button" onClick={onUnsetDescription} disabled={!canAct || busy || selected.description === undefined}>Clear description</button>
          </div>
        </form>

        <fieldset disabled={!canAct || busy}>
          <legend>Routing flags (top-level lines — the client never enters the VRF section for these)</legend>
          <div className="review-actions">
            <button className="quiet-button" type="button" onClick={() => onRouting('ipv4', 'set')} disabled={selected.ipv4Routing}>Enable IPv4 routing</button>
            <button className="danger-button" type="button" onClick={() => onRouting('ipv4', 'no')} disabled={!selected.ipv4Routing}>Disable IPv4 routing</button>
            <button className="quiet-button" type="button" onClick={() => onRouting('ipv4', 'default')}>Default IPv4 routing</button>
            <button className="quiet-button" type="button" onClick={() => onRouting('ipv6', 'set')} disabled={selected.ipv6Routing}>Enable IPv6 routing</button>
            <button className="danger-button" type="button" onClick={() => onRouting('ipv6', 'no')} disabled={!selected.ipv6Routing}>Disable IPv6 routing</button>
            <button className="quiet-button" type="button" onClick={() => onRouting('ipv6', 'default')}>Default IPv6 routing</button>
          </div>
          <p className="field-note">
            Enable stages the bare stem (<code>ip routing vrf {selected.name}</code> /
            <code> ipv6 unicast-routing vrf {selected.name}</code> — divergence 9, never inside the
            section). The table&#39;s flag columns are computed the way the client&#39;s reader computes them:
            from the presence of a <code>no …</code> line, so after commit the refresh reports what the
            device kept. <code>default</code> returns the flag to the device default, which this screen
            cannot predict.
          </p>
        </fieldset>

        <div className="review-actions">
          <button className="danger-button" type="button" onClick={onDeleteSelected} disabled={!canAct || busy}>Delete {selected.name}</button>
        </div>
        {selectedError !== undefined && <p className="notice notice-error" role="alert">{selectedError}</p>}
      </section>}

    {/* Interface assignment */}
    <section className="panel" aria-labelledby="vrfs-assign-title">
      <div className="panel-heading">
        <div><p className="eyebrow">NAMED SESSION</p><h3 id="vrfs-assign-title">Port ↦ VRF assignment</h3></div>
        <span className="panel-index">{interfaceOptions.filter((option) => option.current !== undefined).length.toString().padStart(2, '0')}</span>
      </div>
      <label htmlFor="vrf-assign-iface">Interface</label>
      <select id="vrf-assign-iface" name="vrf-assign-iface" value={assignInterface} onChange={(event) => onAssignInterfaceChange(event.target.value)} disabled={!canAct || busy || interfaceOptions.length === 0}>
        <option value="">(choose an interface)</option>
        {interfaceOptions.map((option) => <option key={option.name} value={option.name}>{option.name} — {option.current === undefined ? 'default VRF' : option.current}</option>)}
      </select>
      <label htmlFor="vrf-assign-target">Target VRF (configured names only — an un-configured name is refused by the device when the line runs)</label>
      <select id="vrf-assign-target" name="vrf-assign-target" value={assignVrf} onChange={(event) => onAssignVrfChange(event.target.value)} disabled={!canAct || busy || vrfOptions.length === 0}>
        <option value="">(choose a VRF)</option>
        {vrfOptions.map((name) => <option key={name} value={name}>{name}</option>)}
      </select>
      <p className="field-note">
        Current assignment for the picked port: <strong>{assignInterface === '' ? '(no port picked)' : selectedIface?.current ?? 'default VRF'}</strong>.
        The bind stages <code>{`interface ${assignInterface === '' ? '<iface>' : assignInterface}`}</code> +
        <code> {interfaceVrfKeywordPreview(props)} &lt;vrf&gt;</code>; unbind stages the <code>no</code> arm.
        Whether the target VRF exists is checked when the line <em>runs</em> — run 9 captured this box
        answering a missing VRF with <code>VRF UNBLOCK-VRF not configured.</code>. Moving a port can move
        an address and the traffic that follows it; whether a port carries this UI&#39;s own eAPI path is
        <strong> not observable from this screen</strong> — the confirm names the port, the judgement is yours.
      </p>
      <div className="review-actions">
        <button className="danger-button" type="button" onClick={onBind} disabled={!canAct || busy || assignInterface === '' || assignVrf === '' || selectedIface?.current === assignVrf}>Assign port to VRF</button>
        <button className="danger-button" type="button" onClick={onUnbind} disabled={!canAct || busy || assignInterface === '' || selectedIface?.current === undefined}>Unassign (return to default VRF)</button>
      </div>
      {assignError !== undefined && <p className="notice notice-error" role="alert">{assignError}</p>}
    </section>

    {/* Device view (show vrf) */}
    <section className="panel" aria-labelledby="vrfs-device-title">
      <div className="panel-heading">
        <div><p className="eyebrow">DEVICE STATE</p><h3 id="vrfs-device-title">show vrf</h3></div>
        <span className="panel-index">{!deviceStateKnown ? 'unread' : deviceRows.length.toString().padStart(2, '0')}</span>
      </div>
      {!deviceStateKnown
        ? <EmptyState
          heading="No `show vrf` read has answered — operational state unknown."
          hint="`show vrf` is capture-backed on both targets, so a reload normally recovers this; until it answers, no state, protocol, or device-interface claim is made anywhere on this screen."
        />
        : deviceRows.length === 0
          ? <EmptyState heading="The device answered with no VRF entries." hint="An empty reply is shown as empty — the screen does not fall back to config text to invent rows." />
          : <DataTable columns={deviceColumns} rows={deviceRows} rowKey={(row) => row.name} label="VRF device state (show vrf)" />}
    </section>

    {/* Staged review panel */}
    {draft !== undefined && <section className="panel" aria-labelledby="vrfs-draft-title">
      <div className="panel-heading">
        <div><p className="eyebrow">NAMED SESSION {draft.sessionName}</p><h3 id="vrfs-draft-title">Staged: {draft.effectLabel}</h3></div>
        <span className="panel-index">{draft.batch.length.toString().padStart(2, '0')}</span>
      </div>
      <p className="field-note">Staged batch: {draft.batch.map((line) => <code key={line}>{line}</code>)}</p>
      {draft.risks.length > 0 && <ul className="ref-list" aria-label="Staged risks">
        {draft.risks.map((risk) => <li key={risk}><span>{risk}</span></li>)}
      </ul>}
      {draft.diff === undefined
        ? <EmptyState heading="Reading the device diff…" hint="Commit stays locked until the device answers its own diff()." />
        : <pre className="diff-output">{draft.diff}</pre>}
      <div className="review-actions">
        <button className={draft.destructive ? 'danger-button' : 'primary-button'} type="button" onClick={onCommitDraft} disabled={!draft.canCommit || busy} aria-busy={busy}>
          {draft.destructive ? 'Commit (risky — review above)' : 'Commit to running-config'}
        </button>
        <button className="quiet-button" type="button" onClick={onAbortDraft} disabled={busy}>Abort staged changes</button>
      </div>
    </section>}

    {notice !== '' && <p className="notice notice-success operation-result" role="status">{notice}</p>}
    {failure !== '' && <div className="notice notice-error operation-result" role="alert"><strong>The device did not take that.</strong><p>{failure}</p></div>}
  </section>
}

/** Keyword preview for the assignment copy — same per-form rule as `bindInterfaceLines`. */
function interfaceVrfKeywordPreview(props: Pick<VrfsViewProps, 'writeForm'>): string {
  return props.writeForm === 'instance' ? 'vrf' : 'vrf forwarding'
}
