/**
 * S5 (#75): the presentation half of the Port-Channel / LAG manager.
 *
 * Same rule as `TrunkEditorView.tsx`: no client type crosses this boundary. Every value is a plain
 * string/number/array the container produced from device reads, so the markup is testable by building
 * props — and the honesty rules live here visibly:
 *
 * - **The capacity row is not rendered.** Issue #75's rule is "capacity limits only from a captured
 *   source, or not at all", and DECISIONS open item 6 retired the 16-ports/64-members prose as
 *   wrong-SKU matrix text. What the panel DOES show is the device's own answer to
 *   `show port-channel dense` (`numberOfChannelsInUse`/`numberOfAggregators`) — a measurement,
 *   labeled as the device's answer, never paired with an invented maximum.
 * - **Config state and device state stay in different columns.** Members/mode/min-links/fallback come
 *   from parsed running-config lines (the client's channel-group relation, DR-075); `linkState`,
 *   `protocol`, and each member's `lagMember`/LACP flags come only from the dense reply, and an
 *   absent dense read renders "the device did not answer", never a derived pill.
 * - **Probe-gated vocabulary is visibly gated.** The four LACP-fallback controls render (the operator
 *   can see what the screen could do), but the fields stay disabled and the capability panel says what
 *   the verdict is, what it costs (an always-aborted config session, DR-063) and what it proves
 *   (grammar presence on this box — never capacity or licence depth).
 * - **The flap warning is honest about its own status.** Joining or detaching a member is stated as
 *   what the STAGED TEXT does (enter the member's submode, add/remove the `channel-group` line) and
 *   what EOS is generally expected to do with it (brief detach), marked as model-general reasoning —
 *   the client composes no `shutdown` command, and this repo has never captured the flap behaviour on
 *   this unit. (Issue #75 paraphrased a "member shutdown before joining" batch; the pinned upstream
 *   `set_members` carries none — see the container header.)
 */
import type { FormEvent } from 'react'
import type { ReactElement } from 'react'

import { ConnectionHeader } from '../../components/ui/ConnectionHeader'
import { DataTable } from '../../components/ui/DataTable'
import type { DataTableColumn } from '../../components/ui/DataTable'
import { EmptyState } from '../../components/ui/EmptyState'
import { StatePill } from '../../components/ui/StatePill'
import type { DeviceIdentity } from '../../shared/identity'

/** Everything the operator can ask this screen to stage. One intent = one named session. */
export type LagAction =
  | 'create-lag'
  | 'delete-lag'
  | 'set-members'
  | 'set-lacp-mode'
  | 'set-min-links'
  | 'clear-min-links'
  | 'default-min-links'
  | 'set-lacp-fallback'
  | 'clear-lacp-fallback'
  | 'set-lacp-timeout'

export const LAG_ACTIONS: readonly LagAction[] = [
  'create-lag',
  'delete-lag',
  'set-members',
  'set-lacp-mode',
  'set-min-links',
  'clear-min-links',
  'default-min-links',
  // The fallback/timeout arms sit last: they are probe-gated, and a member edit is the more common
  // intent on this screen (declaration order is the `<select>` order).
  'set-lacp-fallback',
  'clear-lacp-fallback',
  'set-lacp-timeout',
]

export const LAG_ACTION_LABELS: Readonly<Record<LagAction, string>> = {
  'create-lag': 'Create a Port-Channel (interface Port-Channel<N>)',
  'delete-lag': 'Delete the Port-Channel (no interface …)',
  'set-members': 'Set members (diff: unbundle removals, then join adds)',
  'set-lacp-mode': 'Re-form every member with a new LACP mode (detaches the LAG)',
  'set-min-links': 'Set minimum-links (port-channel min-links <n>)',
  'clear-min-links': 'Clear minimum-links (no port-channel min-links)',
  'default-min-links': 'Default minimum-links (default port-channel min-links)',
  'set-lacp-fallback': 'Set LACP fallback (port-channel lacp fallback …) — probe-gated',
  'clear-lacp-fallback': 'Clear LACP fallback (no port-channel lacp fallback) — probe-gated',
  'set-lacp-timeout': 'Set LACP fallback timeout — probe-gated',
}

/** A LAG row, fully translated. `device*` values exist only when `show port-channel dense` answered. */
export interface LagRow {
  readonly name: string
  /** The group id digits the client extracts to key the channel-group relation (`GROUP_ID`). */
  readonly group: string
  /** Parsed running-config members (DR-075 relation). Absent means the relation named none. */
  readonly members?: readonly string[]
  /** The mode carried by the members' `channel-group … mode <x>` lines, when one did. */
  readonly lacpMode?: string
  readonly minimumLinks?: number
  /** Raw parsed remainder of the `port-channel lacp fallback <word>` line. */
  readonly lacpFallback?: string
  /** Raw parsed remainder of the `port-channel lacp fallback timeout <n>` line. */
  readonly lacpTimeout?: number
  readonly l2Mode?: string
  /** The bundle carries an `ip address`, so it is a candidate management path. */
  readonly address?: string
  /** `show port-channel dense` answers (device state), present only when that read answered for this LAG. */
  readonly deviceLinkState?: string
  readonly deviceProtocol?: string
  readonly deviceInactive?: boolean
  /** True when the dense reply names ports whose names this screen's config set does not list (or vice versa). */
  readonly deviceMembersDisagree?: boolean
}

/** One physical port from the running-config, plus its bundling state as the device answered it. */
export interface PortRow {
  readonly name: string
  /** The Port-Channel whose config relation names this port, when one does. */
  readonly groupOf?: string
  /** Device answer only: the name appears in the dense reply for this LAG. */
  readonly deviceBundled?: boolean
  readonly deviceMisconfig?: string
  /** `true`/`false` bundling flags, `undefined` = the dense read did not answer this port. */
  readonly deviceLinkDown?: boolean
  readonly carriesAddress: boolean
  /** Whether this client can put the name behind `interface <name>` (DECISIONS open item 7). */
  readonly clientWritableName: boolean
}

export interface LagSessionRow {
  readonly name: string
  readonly state: string
}

/** The result of the live-membership check (`show port-channel <id> all-ports`, DR-075's separate verb). */
export interface LagLiveCheck {
  readonly name: string
  readonly members?: readonly string[]
  readonly error?: string
}

export interface LagCapabilityView {
  readonly feature: string
  readonly display: string
  readonly reason: string
  readonly candidates: readonly string[]
}

export interface LagFields {
  readonly action: LagAction
  /** Group number for `create-lag` (digits only). */
  readonly group: string
  readonly description: string
  /** Port names checked in the membership editor. */
  readonly members: readonly string[]
  /** Explicit mode arm for joins/re-forms; `''` means "not chosen". */
  readonly mode: string
  readonly minLinks: string
  readonly fallbackMode: string
  readonly timeout: string
}

export interface LagManagerViewProps {
  readonly state: LagLoadState
  readonly identity?: DeviceIdentity
  readonly proxyPrompt?: string
  readonly rows: readonly LagRow[]
  readonly ports: readonly PortRow[]
  readonly sessions: readonly LagSessionRow[]
  readonly fields: LagFields
  readonly onChange: (fields: LagFields) => void
  /** Membership edits go through this, not `onChange`: the container needs to know when the operator
   *  has actually touched the picker versus just changing another field (the checkbox set starts as the
   *  truth of the selected bundle and stays synced until the first toggle). */
  readonly onMemberToggle: (name: string, checked: boolean) => void
  readonly selected: string
  readonly onSelect: (name: string) => void
  readonly onPreview: (event: FormEvent<HTMLFormElement>) => void
  readonly onAbortPending: (session: LagSessionRow) => void
  readonly onVerify: () => void
  readonly live?: readonly LagLiveCheck[]
  readonly messages: LagMessage
  readonly busy: boolean
  readonly gate: LagGate
  readonly capabilities: readonly LagCapabilityView[]
  readonly onProbe: () => void
  readonly onAbortProbeSessions: () => void
}

export type LagLoadState = 'loading' | 'ready' | 'failed'

export interface LagMessage {
  readonly notice: string
  readonly failure: string
  readonly readError?: string
  readonly denseError?: string
  readonly managementError?: string
}

/** What the gated LACP-fallback controls need to know: the current verdict and whether it opens them. */
export interface LagGate {
  /** True only for an `available` verdict on the feature the current action needs. */
  readonly open: boolean
  /** Text rendered under the disabled fields when the gate is shut. */
  readonly blocked: string
}

const orNote = (value: string | undefined, note: string) => value ?? <span className="cell-note">{note}</span>

const lagColumns: readonly DataTableColumn<LagRow>[] = [
  { header: 'Port-Channel', cell: (row) => <><strong>{row.name}</strong><span className="cell-note">group {row.group}</span></> },
  {
    header: 'Members (running-config)',
    cell: (row) => row.members === undefined || row.members.length === 0
      ? <span className="cell-note">None configured</span>
      : <span>{row.members.join(', ')}</span>,
  },
  { header: 'Mode (config lines)', cell: (row) => row.lacpMode === undefined ? <span className="cell-note">No mode line</span> : <StatePill value={row.lacpMode} /> },
  { header: 'min-links', numeric: true, cell: (row) => row.minimumLinks ?? <span className="cell-note">Not configured</span> },
  { header: 'lacp fallback', cell: (row) => orNote(row.lacpFallback, 'Not configured') },
  { header: 'fallback timeout', numeric: true, cell: (row) => row.lacpTimeout ?? <span className="cell-note">Not configured</span> },
  { header: 'L2 mode', cell: (row) => row.l2Mode === undefined ? <span className="cell-note">Not reported</span> : <StatePill value={row.l2Mode} /> },
  { header: 'Address', cell: (row) => row.address === undefined ? <span className="cell-note">None</span> : <code className="band-address">{row.address}</code> },
  { header: 'Link (device answer)', cell: (row) => row.deviceLinkState === undefined ? <span className="cell-note">dense did not answer</span> : <StatePill value={row.deviceLinkState} /> },
  { header: 'Protocol (device answer)', cell: (row) => row.deviceProtocol === undefined ? <span className="cell-note">dense did not answer</span> : <>{row.deviceProtocol}{row.deviceInactive === true && <span className="cell-note">inactive</span>}</> },
  {
    header: 'Config vs device',
    cell: (row) => row.deviceMembersDisagree === undefined
      ? <span className="cell-note">no device answer to compare</span>
      : row.deviceMembersDisagree
        ? <span className="cell-note">the dense answer names a different port set than the config relation — shown, not resolved</span>
        : <span className="cell-note">agree</span>,
  },
]

const portColumns: readonly DataTableColumn<PortRow>[] = [
  { header: 'Port', cell: (row) => <><strong>{row.name}</strong>{!row.clientWritableName && <span className="cell-note">name this client cannot parse</span>}</> },
  { header: 'Group (config relation)', cell: (row) => row.groupOf ?? <span className="cell-note">Not a member</span> },
  {
    header: 'Bundled (device answer)',
    cell: (row) => row.deviceBundled === undefined
      ? <span className="cell-note">dense did not answer</span>
      : row.deviceBundled
        ? <StatePill value="bundled" />
        : <><StatePill value="unbundled" />{row.deviceMisconfig !== undefined && <span className="cell-note">{row.deviceMisconfig}</span>}</>,
  },
  { header: 'Carries an IP address', cell: (row) => row.carriesAddress ? <span className="band-flag band-flag-addressed">ip address</span> : <span className="cell-note">No</span> },
]

/**
 * The membership editor's port list. A port already in ANOTHER group is offered with a visible notice:
 * joining it rebundles it, and the staged `channel-group <this>` line is exactly what the client's own
 * verb composes — the device decides whether EOS moves the port atomically (uncaptured on this unit).
 */
function MemberPicker({ ports, selectedRow, fields, onMemberToggle }: Pick<LagManagerViewProps, 'ports' | 'fields' | 'onMemberToggle'> & { readonly selectedRow?: LagRow }): ReactElement {
  const current = new Set(selectedRow?.members ?? [])
  const chosen = new Set(fields.members)
  return <div className="lag-members" role="group" aria-label="Member ports">
    {ports.map((port) => {
      const inThis = current.has(port.name)
      const inOther = port.groupOf !== undefined && port.groupOf !== selectedRow?.name
      const checked = chosen.has(port.name)
      const state = inThis || checked ? 'checked' : 'unchecked'
      return <label key={port.name} className={`lag-member${inThis ? ' is-current' : ''}${inOther ? ' is-foreign' : ''}`}>
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onMemberToggle(port.name, event.target.checked)}
        />
        <span>{port.name}</span>
        <span className="cell-note">{inThis ? 'configured here' : inOther ? `currently in ${port.groupOf}` : 'not a member'} · {state}</span>
        {port.carriesAddress && <span className="band-flag band-flag-addressed">ip address</span>}
      </label>
    })}
    {ports.length === 0 && <p className="cell-note">The running-config named no Ethernet sections to choose from.</p>}
  </div>
}

export function LagManagerView({
  state,
  identity,
  proxyPrompt,
  rows,
  ports,
  sessions,
  fields,
  onChange,
  onMemberToggle,
  selected,
  onSelect,
  onPreview,
  onAbortPending,
  onVerify,
  live,
  messages,
  busy,
  gate,
  capabilities,
  onProbe,
  onAbortProbeSessions,
}: LagManagerViewProps): ReactElement {
  const selectedRow = rows.find((row) => row.name === selected)
  const canPick = rows.length > 0
  const stagingOpen = fields.action !== 'create-lag'

  return <>
    <div className="screen-connection">
      <ConnectionHeader
        state={state === 'ready' ? 'connected' : state === 'failed' ? 'error' : 'connecting'}
        {...(identity !== undefined ? { identity } : {})}
        connectedLabel="Device state read"
        connectingLabel={state === 'loading' ? 'Reading device state' : identity === undefined ? 'Connecting' : undefined}
      />
    </div>

    <section className="workspace" aria-labelledby="workspace-title">
      <div className="workspace-heading">
        <div>
          <p className="eyebrow">LINK AGGREGATION</p>
          <h2 id="workspace-title">Port-Channel manager</h2>
        </div>
        <button className="quiet-button" type="button" onClick={onVerify} disabled={state !== 'ready' || busy || rows.length === 0}>
          Check membership on the device
        </button>
      </div>

      {proxyPrompt !== undefined && <div className="notice notice-error" role="alert"><strong>Local proxy is not configured.</strong><p>{proxyPrompt}</p></div>}
      {state === 'loading' && <p className="notice" role="status" aria-busy="true">Reading Port-Channel sections, the channel-group relation, interface addresses, the LAG status model, and configuration sessions…</p>}
      {/* The disabled-read arm of `useDeviceRead` carries the SAME proxy text, so rendering both alerts
          would duplicate one message; the proxy prompt owns that channel, this alert is for real read
          failures with the proxy configured. */}
      {state === 'failed' && proxyPrompt === undefined && <div className="notice notice-error" role="alert"><strong>Device state could not be read.</strong><p>{messages.readError ?? messages.failure}</p></div>}

      {state === 'ready' && <>
        {messages.denseError !== undefined && <p className="notice notice-warning" role="status">The LAG status read (<code>show port-channel dense</code>) failed: <code className="read-error">{messages.denseError}</code> Device columns below say so per row — no status pill is derived from the configuration instead.</p>}
        {messages.managementError !== undefined && <p className="notice notice-warning" role="status">The management-API read failed: <code className="read-error">{messages.managementError}</code> The “carries an IP address” flag stays the only in-band signal this screen has.</p>}

        <div className="inventory-strip" aria-label="LAG inventory">
          <div><span className="metric-label">Port-Channels (config)</span><strong>{rows.length}</strong></div>
          <div><span className="metric-label">Bundled members (device answer)</span><strong>{rows.reduce((sum, row) => sum + (row.members?.length ?? 0), 0)}</strong></div>
          <div><span className="metric-label">Channels in use (dense)</span><strong>{rows.some((row) => row.deviceLinkState !== undefined) ? new Set(rows.filter((row) => row.deviceLinkState !== undefined).map((row) => row.name)).size : 'No answer'}</strong></div>
          <div><span className="metric-label">Pending sessions</span><strong>{sessions.filter((session) => session.state === 'pending').length}</strong></div>
        </div>
        <p className="field-note">Per-LAG counts above are the device's own answers to <code>show port-channel dense</code> where that read answered. This screen deliberately shows <strong>no platform capacity limit</strong>: the 16-ports/64-members figure in older matrix prose is wrong-SKU lineage (DECISIONS open item 6) and no capture exists for this unit's maximum.</p>

        <section className="panel" aria-labelledby="lag-table-title">
          <div className="panel-heading"><div><p className="eyebrow">RUNNING CONFIG + LAG MODEL</p><h3 id="lag-table-title">Every Port-Channel</h3></div><span className="panel-index">{rows.length.toString().padStart(2, '0')}</span></div>
          {rows.length === 0
            ? <EmptyState heading="The device has no Port-Channel sections in its running-config." hint="Use “Create a Port-Channel” below to form one — a device with no LAGs configured is an empty answer, not a failed read." />
            : <DataTable columns={lagColumns} rows={rows} rowKey={(row) => row.name} label="Port-Channel inventory" />}
        </section>

        <section className="panel" aria-labelledby="port-table-title">
          <div className="panel-heading"><div><p className="eyebrow">MEMBER RELATION</p><h3 id="port-table-title">Ethernet ports and where they bundle</h3></div><span className="panel-index">{ports.length.toString().padStart(2, '0')}</span></div>
          <DataTable columns={portColumns} rows={ports} rowKey={(row) => row.name} label="Ethernet membership" />
          <p className="field-note">Members come from the parsed <code>channel-group</code> lines in each port's own section (the client reads the relation from running-config, DR-075); the bundling columns come only from <code>show port-channel dense</code>, and “dense did not answer” is not read as “not bundled”.</p>
        </section>

        {live !== undefined && live.length > 0 && <section className="panel" aria-labelledby="live-title">
          <div className="panel-heading"><div><p className="eyebrow">SEPARATE LIVE VERB</p><h3 id="live-title">Membership as the device answers it now</h3></div></div>
          <ul className="group-list" aria-label="Live membership checks">
            {live.map((check) => <li key={check.name}>
              <strong>{check.name}</strong>
              {check.error !== undefined
                ? <span className="cell-note">read failed: {check.error}</span>
                : <span className="cell-note">device says: {check.members !== undefined && check.members.length > 0 ? check.members.join(', ') : 'no member ports answered'}</span>}
            </li>)}
          </ul>
          <p className="field-note">This is <code>show port-channel &lt;id&gt; all-ports</code> scraped by the client — offered per request (DR-075), never the table's source.</p>
        </section>}

        <section className="panel" aria-labelledby="lag-write-title">
          <div className="panel-heading"><div><p className="eyebrow">STAGED CHANGE</p><h3 id="lag-write-title">Change one LAG</h3></div><span className="panel-index">02</span></div>
          {state === 'ready' && rows.length === 0 && fields.action !== 'create-lag' && <EmptyState heading="There is no Port-Channel to select, so only “Create a Port-Channel” can be staged." />}
          <form onSubmit={onPreview}>
            {stagingOpen && <>
              <label htmlFor="lag-select">Port-Channel</label>
              <select id="lag-select" name="lag-select" value={selected} onChange={(event) => onSelect(event.target.value)} disabled={!canPick}>
                {rows.map((row) => <option key={row.name} value={row.name}>{row.name} · group {row.group}</option>)}
              </select>
            </>}

            <label htmlFor="lag-action">Change</label>
            <select id="lag-action" name="lag-action" value={fields.action} onChange={(event) => onChange({ ...fields, action: event.target.value as LagAction })}>
              {LAG_ACTIONS.map((action) => <option key={action} value={action}>{LAG_ACTION_LABELS[action]}</option>)}
            </select>

            {fields.action === 'create-lag' && <>
              <label htmlFor="lag-group">Group number</label>
              <input id="lag-group" name="lag-group" value={fields.group} inputMode="numeric" onChange={(event) => onChange({ ...fields, group: event.target.value })} />
              <p className="field-note">The client's <code>assertPortChannelName</code> requires digits to key the channel-group relation (resources/interfaces.ts). Whether this unit accepts a given number is a device answer, not a client bound — no capacity limit is claimed here.</p>
              <label htmlFor="lag-description">Description (optional)</label>
              <input id="lag-description" name="lag-description" value={fields.description} onChange={(event) => onChange({ ...fields, description: event.target.value })} />
            </>}

            {fields.action === 'set-members' && <>
              {selectedRow !== undefined && <p className="current-state">Currently configured here: <strong>{selectedRow.members !== undefined && selectedRow.members.length > 0 ? selectedRow.members.join(', ') : 'nothing'}</strong></p>}
              <MemberPicker ports={ports} selectedRow={selectedRow} fields={fields} onMemberToggle={onMemberToggle} />
              <label htmlFor="lag-join-mode">Mode for joining ports (optional when the group already names one)</label>
              <select id="lag-join-mode" name="lag-join-mode" value={fields.mode} onChange={(event) => onChange({ ...fields, mode: event.target.value })}>
                <option value="">Reuse the group's current mode</option>
                <option value="active">active</option>
                <option value="passive">passive</option>
                <option value="on">on (static, no LACP)</option>
              </select>
              <p className="field-note">Removing a member stages <code>interface &lt;port&gt;</code> + <code>no channel-group &lt;id&gt;</code>; adding stages <code>channel-group &lt;id&gt; mode &lt;mode&gt;</code> — the exact two-stage order the client pins (DR-080: removals first, then adds, in ONE batch here because this screen stages, while the client's standalone verb splits a mode change into two transactions). EOS is generally expected to briefly detach a port as its <code>channel-group</code> line appears or disappears; whether it administratively flaps on this unit is <strong>not captured</strong> — no <code>shutdown</code> command is staged by anything in this batch.</p>
            </>}

            {fields.action === 'set-lacp-mode' && <>
              <label htmlFor="lag-mode-select">New mode for every current member</label>
              <select id="lag-mode-select" name="lag-mode-select" value={fields.mode} onChange={(event) => onChange({ ...fields, mode: event.target.value })}>
                <option value="">Choose a mode</option>
                <option value="active">active</option>
                <option value="passive">passive</option>
                <option value="on">on (static, no LACP)</option>
              </select>
              <p className="field-note">Staged as <code>no channel-group</code> for <strong>every</strong> member first, then the re-adds — the whole LAG is detached and re-attached within one transaction window (#75's guard: this can drop the bundle; the confirm names the members).</p>
            </>}

            {fields.action === 'set-min-links' && <>
              <label htmlFor="lag-min-links">Minimum links</label>
              <input id="lag-min-links" name="lag-min-links" value={fields.minLinks} inputMode="numeric" onChange={(event) => onChange({ ...fields, minLinks: event.target.value })} />
              <p className="field-note">A positive whole number is a client-side bound (the client's <code>assertPortBandValue</code>); the platform range is a device answer. Setting it <strong>below</strong> the current member count is offered with a destructive confirm, because it can permit the bundle to keep coming up while links are missing — or drop it, depending on which way the count then moves.</p>
            </>}

            {(fields.action === 'set-lacp-fallback' || fields.action === 'set-lacp-timeout') && !gate.open && <p className="notice notice-warning" role="status">This vocabulary is not enabled: {gate.blocked}</p>}
            {fields.action === 'set-lacp-fallback' && <>
              <label htmlFor="lag-fallback-mode">Fallback mode</label>
              <select id="lag-fallback-mode" name="lag-fallback-mode" value={fields.fallbackMode} onChange={(event) => onChange({ ...fields, fallbackMode: event.target.value })} disabled={!gate.open}>
                <option value="">Choose a mode</option>
                <option value="individual">individual</option>
                <option value="static">static</option>
              </select>
              <p className="field-note">Clearing is a separate action (<code>no port-channel lacp fallback</code>), because a mode string and a negation are different intents — the client's own rule (DR-037/DR-077).</p>
            </>}
            {fields.action === 'clear-lacp-fallback' && <>
              {!gate.open && <p className="notice notice-warning" role="status">This vocabulary is not enabled: {gate.blocked}</p>}
              <p className="current-state">This will stage <code>no port-channel lacp fallback</code> on {selected}.</p>
            </>}
            {fields.action === 'set-lacp-timeout' && <>
              <label htmlFor="lag-timeout">Fallback timeout (seconds)</label>
              <input id="lag-timeout" name="lag-timeout" value={fields.timeout} inputMode="numeric" disabled={!gate.open} onChange={(event) => onChange({ ...fields, timeout: event.target.value })} />
              <p className="field-note">Positive whole number, client-side bound only. The client's record keeps an unconfigured timeout <strong>absent</strong> rather than inventing a default 90 (DR-076), and this screen inherited that rule.</p>
            </>}

            <div className="review-actions">
              {/* S3's gate shape: the controls stay visible and the Preview button stays live for gated
                  intents, so the refusal comes through `plan()` as an explained message — the write-layer
                  gate — rather than a silently dead button. */}
              <button className="primary-button" type="submit" disabled={state !== 'ready' || busy}>Add to transaction</button>
            </div>
          </form>


          {messages.notice !== '' && <p className="notice notice-success operation-result" role="status">{messages.notice}</p>}
          {messages.failure !== '' && <div className="notice notice-error operation-result" role="alert"><strong>The device or this screen refused that.</strong><p>{messages.failure}</p></div>}
        </section>

        <section className="panel" aria-labelledby="lag-probe-title">
          <div className="panel-heading"><div><p className="eyebrow">F5 CAPABILITY</p><h3 id="lag-probe-title">Is this LACP vocabulary on this box?</h3></div></div>
          <p className="field-note">The probe stages these lines inside a config session the client <strong>always aborts</strong> (DR-063): presence of the grammar on this unit, never capacity or licence depth (epic open item 6). A <code>pending</code> session the probe left behind is aborted here, never committed.</p>
          <div className="review-actions"><button className="quiet-button" type="button" onClick={onProbe} disabled={busy}>Run the probe</button>
            {sessions.length > 0 && <button className="danger-button" type="button" onClick={onAbortProbeSessions} disabled={busy}>Abort probe sessions</button>}</div>
          {capabilities.length === 0 ? <EmptyState heading="No capability answer has been recorded for this screen yet." hint="Press “Run the probe” to ask the device. Until then the gated LACP controls stay shut — unknown is never read as supported." /> : null}
          <ul className="group-list" aria-label="Capability verdicts">
            {capabilities.map((entry) => <li key={entry.feature}>
              <strong>{entry.feature}</strong>: <StatePill value={entry.display} />
              <span className="cell-note">{entry.reason}</span>
              <span className="cell-note">candidates: {entry.candidates.join(' · ')}</span>
            </li>)}
          </ul>
        </section>

        {sessions.length > 0 && <section className="panel" aria-labelledby="lag-sessions-title">
          <div className="panel-heading"><div><p className="eyebrow">DEVICE SESSIONS</p><h3 id="lag-sessions-title">Configuration sessions on the device</h3></div></div>
          <ul className="session-list" aria-label="Configuration sessions">
            {sessions.map((session) => <li key={session.name}>
              <code>{session.name}</code> <span className="session-state">{session.state}</span>
              {session.state === 'pending' && <button className="danger-button" type="button" onClick={() => onAbortPending(session)} disabled={busy}>Abort pending session</button>}
            </li>)}
          </ul>
        </section>}
      </>}
    </section>
  </>
}
