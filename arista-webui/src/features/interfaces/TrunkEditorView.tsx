/**
 * S3 (#73): the presentation half of the trunk-port editor. It reads nothing and decides nothing:
 * every value below is a plain string/number/array the container (`TrunkEditor.tsx`) produced from
 * device reads, and every control reports its intent back through `onChange`/`onPreview`/`onCommit`/
 * `onAbortDraft`. No client type crosses this boundary — `Switchport`, `Vlan`, `Interface`,
 * `ConfigSessionSummary` and `ConfigSession` are all translated in the container first, which is why
 * the presentation tests build props by hand instead of building a fake node.
 *
 * What this file owns is **markup, gating that is visible, and vocabulary for the controls**:
 * `TrunkAction` + `TRUNK_ACTIONS`/`TRUNK_ACTION_LABELS` name the intents the operator can ask for, and
 * the container maps those intents to command text. The mode list arrives as `modes: readonly string[]`
 * even though the client models it as a union, because this component must not depend on the client's
 * type to render a `<select>`.
 *
 * Honesty rules the markup enforces (each pair with a container behaviour, pinned in
 * `TrunkEditor.test.tsx`):
 * - a failed read renders as a `role="alert"` with a Retry button, never as an empty table;
 * - an empty table renders an `EmptyState` that says a failed read would have looked different;
 * - the source of every L2 value is stated: these are **parsed `show running-config` lines**, not a
 *   model-backed `show` answer (the client has no device-side trunk JSON capture, and its
 *   `switchport-trunk.conf` fixture is hand-authored);
 * - a keyword allowed-VLAN spelling (`all`, `except …`, `forward all`) is shown verbatim and flagged
 *   as not enumerable — this screen never expands one into members (DR-028);
 * - staged text, the device diff, and the commit gate (`diff` read + not yet attempted) are all
 *   visible before a write; nothing here claims success — the result slots come from the container's
 *   `useOperation` triplet;
 * - trunk-group editing sits behind the F5 capability gate (#67): the two group actions render, but the
 *   field stays disabled and `plan()` refuses while the verdict is anything but `available`, and the
 *   capability panel says what the verdict is, what it costs (an always-aborted config session,
 *   DR-063) and what it proves (command presence only — never capacity, epic open item 6). The
 *   candidates the probe sends are echoed verbatim so the question on the record is this screen.
 */
import type { FormEvent } from 'react'

import { ConnectionHeader } from '../../components/ui/ConnectionHeader'
import type { ConnectionState } from '../../components/ui/ConnectionHeader'
import { DataTable } from '../../components/ui/DataTable'
import type { DataTableColumn } from '../../components/ui/DataTable'
import { EmptyState } from '../../components/ui/EmptyState'
import { StatePill } from '../../components/ui/StatePill'
import type { DeviceIdentity } from '../../shared/identity'

/** The L2 intents this screen can stage. One intent = one named session, mirroring S1/S2. */
export type TrunkAction =
  | 'set-mode'
  | 'no-mode'
  | 'access-vlan'
  | 'native-vlan'
  | 'no-native-vlan'
  | 'allowed-replace'
  | 'allowed-add'
  | 'allowed-remove'
  | 'no-allowed'
  | 'add-trunk-group'
  | 'remove-trunk-group'

/** Declaration order is the order the `<select>` shows, so the risky allowed-VLAN rewrites sit last. */
export const TRUNK_ACTIONS: readonly TrunkAction[] = [
  'set-mode',
  'no-mode',
  'access-vlan',
  'native-vlan',
  'no-native-vlan',
  'allowed-replace',
  'allowed-add',
  'allowed-remove',
  'no-allowed',
  // The group intents sit last: an operator picks a VLAN or mode edit before a probe-gated group
  // write, and declaration order is the `<select>` order (#73).
  'add-trunk-group',
  'remove-trunk-group',
]

export const TRUNK_ACTION_LABELS: Readonly<Record<TrunkAction, string>> = {
  'set-mode': 'Set switchport mode (switchport mode …)',
  'no-mode': 'Clear mode (no switchport mode)',
  'access-vlan': 'Set access VLAN (switchport access vlan …)',
  'native-vlan': 'Set trunk native VLAN (switchport trunk native vlan …)',
  'no-native-vlan': 'Clear native VLAN (no switchport trunk native vlan)',
  'allowed-replace': 'Replace allowed VLAN list (switchport trunk allowed vlan …)',
  'allowed-add': 'Add to allowed list (recomputed, then written whole)',
  'allowed-remove': 'Remove from allowed list (recomputed, then written whole)',
  'no-allowed': 'Clear allowed VLAN list (no switchport trunk allowed vlan)',
  'add-trunk-group': 'Add trunk group (switchport trunk group …) — probe-gated',
  'remove-trunk-group': 'Remove trunk group (no switchport trunk group …) — probe-gated',
}

/** One row of the L2 port table — a translated `Switchport` plus this client's writability answer. */
export interface TrunkPortRow {
  readonly name: string
  /** The client's per-kind parse of the section name; `Unrecognised` when its grammar has no form for it. */
  readonly kind: string
  /** Whether this client will put the name behind `interface <name>` at all (DECISIONS open item 7). */
  readonly editable: boolean
  /** Whether the switchport table carried a record for this section at all. Absent means "no switchport
   *  line was read", which the container explains — it is not the same statement as "this port is
   *  routed", because the client also drops a section carrying a bare `no switchport` line. */
  readonly hasSwitchportRecord: boolean
  /** The raw `switchport mode …` remainder. Absent means the section carries no such line. */
  readonly mode?: string
  /** False when the mode token is outside the four this client names — shown, never coerced. */
  readonly modeKnown: boolean
  readonly accessVlan?: number
  readonly nativeVlan?: number
  /** The raw `switchport trunk allowed vlan …` remainder, exactly as the device wrote it. */
  readonly allowedRaw?: string
  /** True when the raw spelling parsed to an enumerable id set. */
  readonly allowedEnumerable: boolean
  /** Why a spelling is not enumerable (`invalid` grammar, or a DR-028 keyword), when it is not. */
  readonly allowedNote?: string
  /** The collapsed form of the enumerated set — this screen's display, and what a write carries. */
  readonly allowedDisplay?: string
  /** The device's own eAPI answer put this VLAN on this port as its trunk native VLAN. */
  readonly nativeIsManagement: boolean
  /** The device's own eAPI answer put this VLAN on this port as its access VLAN. */
  readonly accessIsManagement: boolean
  /** This interface carries an `ip address`, so it is a candidate management path (S1's rule). */
  readonly hasAddress: boolean
  /** The parsed `switchport trunk group …` lines for this port — running-config text only. Showing
   *  them says nothing about what the SKU enforces (open item 4); the probe panel answers that, and
   *  only after it is asked. */
  readonly trunkGroups: readonly string[]
}

/** A VLAN the operator may reference, from the client's VLAN table — a suggestion list, not a whitelist. */
export interface TrunkVlanOption {
  readonly id: number
  readonly name?: string
}

/** A configuration session as `listSessions()` reported it, translated to plain fields. */
export interface TrunkSessionRow {
  readonly name: string
  readonly state: string
  readonly description?: string
}

/** What a successful read produced. */
export interface TrunkReadyData {
  readonly rows: readonly TrunkPortRow[]
  readonly vlanOptions: readonly TrunkVlanOption[]
  readonly sessions: readonly TrunkSessionRow[]
  /** The interfaces the device itself named as serving eAPI; empty means the answer named nothing. */
  readonly managementInterfaces: readonly string[]
  /** Present when the `show management api http-commands` read failed — a soft read, not a screen error. */
  readonly managementError?: string
}

export type TrunkLoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly data: TrunkReadyData }

/** The form's current edit. Field values are strings because that is what the inputs carry; the
 *  container decides what a string means (and refuses the ones it cannot write). */
export interface TrunkFields {
  readonly port: string
  readonly action: TrunkAction
  readonly mode: string
  readonly accessVlan: string
  readonly nativeVlan: string
  readonly allowedRanges: string
  /** One trunk-group token; the write is refused until the capability verdict says `available`. */
  readonly trunkGroup: string
}

export type TrunkFieldKey = keyof TrunkFields

export type TrunkNoticeTone = 'info' | 'success' | 'warning' | 'risk'

/** @deprecated Transaction Center owns session review; retained only for old presentation-only tests. */
export interface TrunkDraftView {
  readonly sessionName: string
  readonly sessionState: string
  readonly batch: readonly string[]
  readonly diff?: string
  readonly commitAttempted: boolean
  readonly diffRead: boolean
  readonly canAbort: boolean
  readonly risks: readonly string[]
}

/** A container-composed sentence the screen shows as-is (risk reasons, re-read confirmations, …). */
export interface TrunkMessage {
  readonly tone: TrunkNoticeTone
  readonly text: string
}

/** The staged-but-uncommitted session, translated so this file never sees a client session object. */
const NOTICE_CLASS: Readonly<Record<TrunkNoticeTone, string>> = {
  info: 'notice',
  success: 'notice notice-success',
  warning: 'notice notice-warning',
  risk: 'notice notice-warning',
}

export interface TrunkEditorViewProps {
  readonly load: TrunkLoadState
  readonly connection: ConnectionState
  readonly identity?: DeviceIdentity
  readonly fields: TrunkFields
  /** The four modes the client will write (`SWITCHPORT_MODES`), passed down as plain text. */
  readonly modes: readonly string[]
  readonly activeSessionName?: string
  /** @deprecated No production caller should pass this; retained for view-test compatibility. */
  readonly draft?: TrunkDraftView
  /** True while the container has a device handle and a configured proxy. */
  readonly canWrite: boolean
  readonly busy: boolean
  /** A risk/pre-flight sentence for the **current** selection and action, or none. */
  readonly messages?: readonly TrunkMessage[]
  /** Result slots from the container's `useOperation` — this component never invents either. */
  readonly failure: string
  readonly notice: string
  readonly onFieldChange: (field: TrunkFieldKey, value: string) => void
  /**
   * #126: set when the address asked for a port this read does not contain. Rendered as its own
   * status line — the container does not feed an unknown name into the selection, and the screen
   * must say so rather than let the table's first row answer silently.
   */
  readonly deepLinkNotice?: string
  readonly onPreview: (event: FormEvent<HTMLFormElement>) => void
  readonly onCommit?: () => void
  readonly onAbortDraft?: () => void
  readonly onReload: () => void
  readonly onAbortPending: (session: TrunkSessionRow) => void
  /** The groups the selected port carries, from the container's row translation — running-config text,
   *  echoed next to the group field so the operator sees what is already on the port. */
  readonly currentGroups: readonly string[]
  /** The container's F5 answer for trunk groups, translated to plain fields (issue #67's gate). */
  readonly capability: TrunkCapabilityView
  readonly onProbe: () => void
  readonly onAbortProbePending: (session: TrunkSessionRow) => void
}

/** What the container passes down from `useCapabilities`; a plain record, no client type crosses. */
export interface TrunkCapabilityView {
  readonly verdict: string
  readonly reason?: string
  readonly status: string
  readonly fromCache: boolean
  readonly configLocked: boolean
  readonly probePendingSessions: readonly TrunkSessionRow[]
  readonly probeFailure: string
  /** True when the device-session list below already carries these rows; the probe-cleanup section
   *  then stands down, so one pending session never gets two equally-named abort controls. */
  readonly pendingSessionsRendered?: boolean
  readonly suppressedCount: number
  readonly canProbe: boolean
  readonly probeBusy: boolean
  /** This screen's probe candidates, echoed so the question on the record is auditable. */
  readonly candidates: readonly string[]
}

const VLAN_HINT = 'Suggested from the VLAN table this screen just read. The device decides whether an id it was not offered is acceptable — this client issues no config read for these verbs, and the 1..4094 bound is the client rule mirrored here, not a captured platform bound.'

function PortTable({ rows }: { readonly rows: readonly TrunkPortRow[] }) {
  const columns: readonly DataTableColumn<TrunkPortRow>[] = [
    {
      header: 'Interface',
      cell: (row) => <>
        <strong>{row.name}</strong>
        {!row.editable && <span className="cell-note">name this client cannot write</span>}
        {row.kind === 'Unrecognised' && <span className="cell-note">name this client cannot parse</span>}
        {!row.hasSwitchportRecord && <span className="cell-note">no switchport line read</span>}
      </>,
    },
    {
      header: 'Mode',
      cell: (row) => row.mode === undefined
        ? <span className="cell-note">Not reported</span>
        : <><StatePill value={row.mode} />{!row.modeKnown && <span className="cell-note">outside this client’s four modes</span>}</>,
    },
    { header: 'Access VLAN', numeric: true, cell: (row) => row.accessVlan ?? <span className="cell-note">Not configured</span> },
    { header: 'Native VLAN', numeric: true, cell: (row) => row.nativeVlan ?? <span className="cell-note">Not configured</span> },
    {
      header: 'Allowed VLANs',
      cell: (row) => row.allowedRaw === undefined
        ? <span className="cell-note">Not configured</span>
        : <>
          {row.allowedEnumerable && row.allowedDisplay !== undefined && <span className="group-list">{row.allowedDisplay}</span>}
          {/* The device spelling is only repeated when it is not the collapsed form already shown. */}
          {(!row.allowedEnumerable || row.allowedDisplay !== row.allowedRaw) && <code className="read-error">{row.allowedRaw}</code>}
          {row.allowedNote !== undefined && <span className="cell-note">{row.allowedNote}</span>}
        </>,
    },
    {
      header: 'Trunk groups',
      cell: (row) => row.trunkGroups.length === 0
        // The read cannot tell an unconfigured port from an unsupported verb (DR-043: the client's
        // `switchport-trunk.conf` fixture is hand-authored, no device-side trunk JSON capture).
        ? <span className="cell-note">None read — either none configured, or support is absent and the CLI line was probed only, never committed. The probe above answers the presence question.</span>
        : <>
          <span className="group-list">{row.trunkGroups.join(', ')}</span>
          <span className="cell-note">parsed running-config lines; the SKU&apos;s enforcement is unproven on this box (open item 4), and the probe above proves command presence only</span>
        </>,
    },
    {
      header: 'Management path',
      cell: (row) => <>
        {row.nativeIsManagement && <span className="band-flag band-flag-eapi-served">Native VLAN is the eAPI VLAN</span>}
        {row.accessIsManagement && <span className="band-flag band-flag-eapi-served">Access VLAN is the eAPI VLAN</span>}
        {row.hasAddress && <span className="band-flag band-flag-addressed">Carries an IP address</span>}
        {!row.nativeIsManagement && !row.accessIsManagement && !row.hasAddress && <span className="cell-note">No management-path signal read</span>}
      </>,
    },
  ]

  return <DataTable columns={columns} rows={rows} rowKey={(row) => row.name} label="Layer 2 ports" />
}

function MessageList({ messages }: { readonly messages: readonly TrunkMessage[] }) {
  if (messages.length === 0) return null
  // One labelled list rather than loose paragraphs: the notices are the screen's answer for *this*
  // selection, so a test (or a screen reader) can walk them without matching unrelated text.
  return <ul className="ref-list notice-stack" aria-label="What this screen knows about the current selection">
    {messages.map((message) => <li key={message.text}><p className={NOTICE_CLASS[message.tone]} aria-live="polite">{message.text}</p></li>)}
  </ul>
}

/**
 * The whole screen surface. `load.kind` chooses which announcement renders — loading is
 * `role="status" aria-busy`, an error is a `role="alert"` block with a Retry control, and only the
 * `ready` arm renders the table, the form and the session list.
 */
export function TrunkEditorView({
  load,
  connection,
  identity,
  deepLinkNotice,
  fields,
  modes,
  activeSessionName,
  canWrite,
  busy,
  messages,
  failure,
  notice,
  onFieldChange,
  onPreview,
  onReload,
  onAbortPending,
  currentGroups,
  capability,
  onProbe,
  onAbortProbePending,
}: TrunkEditorViewProps) {
  const data = load.kind === 'ready' ? load.data : undefined
  const rows = data?.rows ?? []
  const selected = rows.find((row) => row.name === fields.port)
  const pending = (data?.sessions ?? []).filter((session) => /pending/iu.test(session.state))
  const needsMode = fields.action === 'set-mode'
  const needsAccessVlan = fields.action === 'access-vlan'
  const needsNativeVlan = fields.action === 'native-vlan'
  const needsRanges = fields.action === 'allowed-replace' || fields.action === 'allowed-add' || fields.action === 'allowed-remove'
  const needsGroupField = fields.action === 'add-trunk-group' || fields.action === 'remove-trunk-group'
  const groupWritable = needsGroupField && capability.verdict === 'available'
  const previewDisabled = busy || !canWrite || selected === undefined || rows.length === 0 || !selected.editable

  return <>
    <div className="screen-connection">
      <ConnectionHeader
        state={connection}
        {...(identity === undefined ? {} : { identity })}
      />
    </div>

    <section className="workspace" aria-labelledby="workspace-title">
      <div className="workspace-heading">
        <div><p className="eyebrow">TRUNK PORT EDITOR</p><h2 id="workspace-title">Trunk ports</h2></div>
        <button className="quiet-button" type="button" onClick={onReload} disabled={load.kind === 'loading' || busy || !canWrite}>Refresh state</button>
      </div>

      <p className="field-note">Every value on this screen is a <strong>parsed <code>show running-config</code> line</strong>: the client has no device-side trunk JSON capture of this command (its
        <code>switchport-trunk.conf</code> fixture is hand-authored), so nothing here is model-backed trunk state, and a write is checked by the device diff below. Trunk-group editing sits behind the capability probe below (#67): an `available` answer is command
        presence only — never how many groups the SKU accepts, and never capacity (epic open item 6). The interfaces dashboard (#71) links straight here per port (<code>#/switches/manage?port=&lt;name&gt;</code> — a real anchor since #126, so the selection survives a cold open of the shared URL too); the list below stays the manual path, and a port the read does not have is announced, never guessed.</p>

      {load.kind === 'loading' && <p className="notice" role="status" aria-busy="true">Reading interfaces, switchport config, VLANs, IP addresses, configuration sessions, and the management path…</p>}
      {load.kind === 'error' && <div className="notice notice-error" role="alert"><strong>Device state could not be read.</strong><p>{load.message}</p>{canWrite && <button type="button" onClick={onReload}>Retry read</button>}</div>}

      {load.kind === 'ready' && data !== undefined && <>
        {data.managementError !== undefined && <p className="notice notice-warning" role="status">The management-API read failed: <code className="read-error">{data.managementError}</code> No port is flagged as carrying the eAPI VLAN, which is not a promise that none does — the confirm below still runs either way.</p>}
        <div className="inventory-strip" aria-label="Trunk editing inventory">
          <div><span className="metric-label">L2 ports</span><strong>{rows.length}</strong></div>
          <div><span className="metric-label">Trunks</span><strong>{rows.filter((row) => row.mode === 'trunk').length}</strong></div>
          <div><span className="metric-label">VLANs readable</span><strong>{data.vlanOptions.length}</strong></div>
          <div><span className="metric-label">Pending sessions</span><strong>{pending.length}</strong></div>
        </div>

        <section className="panel" aria-labelledby="capability-title">
          <div className="panel-heading"><div><p className="eyebrow">CAPABILITY</p><h3 id="capability-title">Trunk groups on this device</h3></div><span className="panel-index">01b</span></div>
          <p className="notice notice-probe" role="status" aria-live="polite">
            {/* The label is its own self-contained node, so `getByText('Trunk-group probe:')` names
                exactly one element; the verdict rides the node after it. */}
            <span className="probe-label">Trunk-group probe:</span>
            <span className="probe-verdict"><strong>{capability.verdict}</strong></span>
            {capability.reason === undefined ? <span>No probe result has been recorded for this question yet — the group actions below stay shut until one answers `available`.</span> : <span>{capability.reason}</span>}
            {capability.fromCache ? <span>This answer came from the capability cache — no config session was opened for it.</span> : null}
          </p>
          <p className="field-note">Candidates this screen asks with: {capability.candidates.map((command) => <code key={command}>{command}</code>)} — the same `interface Ethernet22` + group block the 2026-11-06 sweep staged and aborted on the box. The probe runs them inside a `no-commit` session the client always aborts (DR-063): it proves command presence, never how many groups the SKU allows (epic open item 6), and a miss at token 1 on a box without Ethernet22 is a probe miss on the scratch resource, not platform news.</p>
          <div className="review-actions">
            <button className="quiet-button" type="button" disabled={!capability.canProbe || capability.probeBusy} onClick={onProbe}>{capability.status === 'probing' ? 'Probing…' : 'Re-run capability probe'}</button>
          </div>
          {capability.configLocked && <p className="notice notice-warning" role="status">The probe reported the config lock (1006): nothing was probed. {capability.probePendingSessions.length === 0 ? 'No pending session was listed by this run — check `show configuration sessions`.' : `Pending: ${capability.probePendingSessions.map((session) => session.name).join(', ')}`}</p>}
          {capability.probeFailure !== '' && <p className="notice notice-error" role="alert">Probe failed: {capability.probeFailure}</p>}
          {capability.suppressedCount > 0 && <p className="field-note" role="status">The last {String(capability.suppressedCount)} probe request(s) fell inside the rate-limit window, so no config session was opened for them. The verdict above is unchanged.</p>}
          {capability.verdict === 'available' && <p className="notice notice-success" role="status">The device accepted the probe candidates, so the trunk-group actions above are enabled.</p>}
          {capability.verdict !== 'available' && <p className="notice notice-warning" role="status">Trunk-group actions stay refused while the verdict is {capability.verdict}. An inconclusive probe is never treated as support.</p>}
          {capability.probePendingSessions.length > 0 && (capability.pendingSessionsRendered === true
            // One pending session, one control: the device-session list below already carries these exact
            // rows and its abort button reaches the same `abortSession` call, so a second identical
            // control here would only invite a double attempt on the same session (#73 review).
            ? <p className="field-note" role="status">{String(capability.probePendingSessions.length)} pending session(s) the probe found ({capability.probePendingSessions.map((session) => session.name).join(', ')}) are listed under Configuration sessions below — abort them there; this screen does not offer a second control for the same session.</p>
            : <section className="session-list" aria-labelledby="probe-sessions-title"><div className="panel-heading"><div><p className="eyebrow">PROBE CLEANUP</p><h3 id="probe-sessions-title">Sessions the probe found pending</h3></div><span className="panel-index">{String(capability.probePendingSessions.length)}</span></div><ul>{capability.probePendingSessions.map((session) => <li key={session.name}><div><strong>{session.name}</strong><span><StatePill value={session.state} />{session.description === undefined ? '' : ` · ${session.description}`}</span></div><button className="danger-button" type="button" disabled={busy} onClick={() => onAbortProbePending(session)}>Abort pending session</button></li>)}</ul></section>)}
        </section>

        <section className="panel" aria-labelledby="table-title">
          <div className="panel-heading"><div><p className="eyebrow">RUNNING CONFIG</p><h3 id="table-title">Every Layer 2 port</h3></div><span className="panel-index">{rows.length.toString().padStart(2, '0')}</span></div>
          {rows.length === 0
            ? <EmptyState heading="The device configured no Ethernet or Port-Channel switchport section." hint="A running-config read that succeeds with no L2 sections means an unconfigured device — a failed read renders as an error above, not as an empty list." />
            : <PortTable rows={rows} />}
        </section>

        <section className="panel" aria-labelledby="write-title">
          <div className="panel-heading"><div><p className="eyebrow">STAGED CHANGE</p><h3 id="write-title">Change one port</h3></div><span className="panel-index">02</span></div>
          {deepLinkNotice !== undefined && <p className="notice notice-warning" role="status">{deepLinkNotice}</p>}          {selected !== undefined && !selected.editable && <p className="notice notice-warning" role="status">{selected.name} is listed but not writable here: this client refuses to put that name behind <code>interface &lt;name&gt;</code> (DECISIONS.md open item 7), so the write controls below are shut.</p>}
          {data.vlanOptions.length === 0 && <p className="notice notice-warning" role="status">The VLAN table came back empty, so there are no suggested VLAN ids. The fields below still accept an id; the device keeps authority over what it answers.</p>}

          <form onSubmit={onPreview}>
            <label htmlFor="trunk-port">Interface</label>
            <select id="trunk-port" value={fields.port} onChange={(event) => onFieldChange('port', event.target.value)} disabled={rows.length === 0}>
              {rows.map((row) => <option key={row.name} value={row.name}>{row.name}{row.mode === undefined ? '' : ` · ${row.mode}`}</option>)}
            </select>

            <label htmlFor="trunk-action">Change</label>
            <select id="trunk-action" value={fields.action} onChange={(event) => onFieldChange('action', event.target.value)}>
              {TRUNK_ACTIONS.map((action) => <option key={action} value={action}>{TRUNK_ACTION_LABELS[action]}</option>)}
            </select>

            {selected !== undefined && <div className="current-state">
              <span>Current mode <strong>{selected.mode ?? 'Not reported'}</strong></span>
              <span>Current access VLAN <strong>{selected.accessVlan ?? 'Not configured'}</strong></span>
              <span>Current native VLAN <strong>{selected.nativeVlan ?? 'Not configured'}</strong></span>
              <span>Current allowed VLANs <strong>{selected.allowedDisplay ?? selected.allowedRaw ?? 'Not configured'}</strong>{selected.allowedRaw !== undefined && !selected.allowedEnumerable && <em> (device spelling, not enumerable here)</em>}</span>
              <span>Current trunk groups <strong>{selected.trunkGroups.length === 0 ? 'None read' : selected.trunkGroups.join(', ')}</strong>{selected.trunkGroups.length > 0 && <em> (parsed running-config lines; the SKU's enforcement is unproven on this box — open item 4)</em>}{selected.trunkGroups.length === 0 && <em> (either none configured, or support is absent and the CLI line was probed only, never committed — ask the probe above)</em>}</span>
            </div>}

            {needsMode && <>
              <label htmlFor="trunk-mode">Switchport mode</label>
              <select id="trunk-mode" value={fields.mode} onChange={(event) => onFieldChange('mode', event.target.value)}>
                {modes.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
              </select>
              <p className="field-note">These are the four mode tokens this client will write (<code>SWITCHPORT_MODES</code>, resources/switchports.ts). A fifth spelling a read produced is shown in the table but never offered or coerced; which modes 4.28.13.1M accepts on this SKU stays a device answer.</p>
            </>}

            {(needsAccessVlan || needsNativeVlan) && <>
              <label htmlFor={needsAccessVlan ? 'trunk-access-vlan' : 'trunk-native-vlan'}>{needsAccessVlan ? 'Access VLAN' : 'Native VLAN'}</label>
              <input
                id={needsAccessVlan ? 'trunk-access-vlan' : 'trunk-native-vlan'}
                value={needsAccessVlan ? fields.accessVlan : fields.nativeVlan}
                onChange={(event) => onFieldChange(needsAccessVlan ? 'accessVlan' : 'nativeVlan', event.target.value)}
                inputMode="numeric"
                list="trunk-vlan-options"
              />
              <p className="field-note">{VLAN_HINT}</p>
            </>}

            {needsRanges && <>
              <label htmlFor="trunk-allowed">Allowed VLAN ranges</label>
              <input id="trunk-allowed" value={fields.allowedRanges} onChange={(event) => onFieldChange('allowedRanges', event.target.value)} />
              <p className="field-note">Ids and runs only — <code>10,20-22</code>. A write always carries the whole recomputed list, because the range verbs pyeapi’s <code>add</code>/<code>remove</code> forms are not ported in this client; an invalid grammar is refused before a session is opened, and a keyword spelling (<code>all</code>, <code>except …</code>) is never expanded into members (DR-028).</p>
            </>}

            {needsGroupField && <>
              <label htmlFor="trunk-group">Trunk group</label>
              <input id="trunk-group" value={fields.trunkGroup} onChange={(event) => onFieldChange('trunkGroup', event.target.value)} disabled={!groupWritable || busy} />
              <p className="field-note">One token. <strong>probe-gated</strong>: the action is refused — and this field stays disabled — until the capability panel above answers <code>available</code> (#67). Support is unproven on the 7050TX-64 (DECISIONS open item 4).</p>
              {/* What the port carries today is running-config text from the read; the probe panel above
                  still decides whether a group write is offered at all (#73). */}
              <p className="field-note">{currentGroups.length === 0 ? 'This port carries no `switchport trunk group` line in the running-config the screen read.' : `Carried today: ${currentGroups.join(', ')}`} Those lines are what the read parsed; the panel above decides whether the device accepts group writes at all.</p>
            </>}

            {(fields.action === 'no-native-vlan' || fields.action === 'no-allowed' || fields.action === 'no-mode') && <p className="field-note">This sends the negated form of one line. What the device then treats as the effective value (EOS defaults) is the device’s answer, not a claim this screen makes.</p>}

            <datalist id="trunk-vlan-options">
              {data.vlanOptions.map((option) => <option key={option.id} value={String(option.id)}>{option.name === undefined ? '' : option.name}</option>)}
            </datalist>

            {messages !== undefined && messages.length > 0 && <MessageList messages={messages} />}

            <button className="primary-button" type="submit" disabled={previewDisabled}>{busy ? 'Working…' : 'Add to transaction'}</button>
          </form>
        </section>


        {data.sessions.length > 0 && <section className="session-list" aria-labelledby="sessions-title">
          <div className="panel-heading"><div><p className="eyebrow">DEVICE STATE</p><h3 id="sessions-title">Configuration sessions</h3></div><span className="panel-index">{data.sessions.length.toString().padStart(2, '0')}</span></div>
          <ul>{data.sessions.map((session) => <li key={session.name}>
            <div><strong>{session.name}</strong><span><StatePill value={session.state} />{session.description === undefined ? '' : ` · ${session.description}`}</span></div>
            {/pending/iu.test(session.state) && session.name !== activeSessionName && <button className="danger-button" type="button" disabled={busy} onClick={() => onAbortPending(session)}>Abort pending session</button>}
          </li>)}</ul>
        </section>}
      </>}

      {failure !== '' && <p className="notice notice-error operation-result" role="alert">{failure}</p>}
      {notice !== '' && <p className="notice notice-success operation-result" role="status" aria-live="polite">{notice}</p>}
    </section>
  </>
}
