/**
 * S6 (#76): presentation half of the IP addressing screen. Same rule as every sibling
 * view: no client type crosses this boundary — the container translates everything.
 *
 * Honesty rules rendered here, not hidden in the container:
 *
 * - **Two sources, visibly separated.** Row identity and config truth come from parsed
 *   running-config; the `interfaceStatus` / `lineProtocolStatus` / live-MTU / live-address
 *   columns come ONLY from `show ip interface brief` (its JSON form has committed
 *   positives on both targets — the correction to #76's stale "never captured" note is in
 *   the container header and on the issue). A failed brief read leaves per-row notes, a
 *   failed address read leaves per-row Unknowns, and a config/device disagreement is
 *   printed, never auto-reconciled.
 * - The management-path column is S1's classification (`eAPI-served` / `addressed` /
 *   `not-eapi-path` / `Unknown`), and Unknown is never painted as safe. The endpoint the
 *   UI dials is shown verbatim so the operator can see when it is a DNS name and the
 *   screen's subnet arithmetic could not run.
 * - `Management<N>` rows are listed (they are real IP interfaces) but the form refuses
 *   them — #76 keeps MGMT isolation out of scope.
 * - IPv6 gets one stated sentence, not an empty fake column: the client models neither
 *   reading nor writing it.
 */
import type { FormEvent } from 'react'
import type { ReactElement } from 'react'

import { ConnectionHeader } from '../../components/ui/ConnectionHeader'
import { DataTable } from '../../components/ui/DataTable'
import type { DataTableColumn } from '../../components/ui/DataTable'
import { EmptyState } from '../../components/ui/EmptyState'
import { StatePill } from '../../components/ui/StatePill'
import type { DeviceIdentity } from '../../shared/identity'
import type { BandPath } from '../interfaces/InterfacesDashboard'

export type AddressingAction = 'set-address' | 'add-secondary' | 'remove-address' | 'route-port' | 'switchport-back'

export const ADDRESSING_ACTIONS: readonly AddressingAction[] = [
  'set-address',
  'add-secondary',
  'remove-address',
  // The mode-change pair sits last: rarer, harder, and the two the issue says are
  // destructive-capable by construction.
  'route-port',
  'switchport-back',
]

export const ADDRESSING_ACTION_LABELS: Readonly<Record<AddressingAction, string>> = {
  'set-address': 'Set or replace the primary address (ip address A.B.C.D/E)',
  'add-secondary': 'Add a secondary address line (ip address A.B.C.D/E secondary)',
  'remove-address': 'Remove the primary address (no ip address)',
  'route-port': 'Make this switching port routed (no switchport) — mode change',
  'switchport-back': 'Return this routed port to switching (no ip address + switchport) — mode change',
}

export interface AddressingFields {
  readonly action: AddressingAction
  readonly iface: string
  readonly address: string
}

export interface AddressingRow {
  readonly name: string
  readonly kind: string
  /** False for a name only the brief answered — the config read shows no section, so writes refuse. */
  readonly inSections: boolean
  /** False while `show ip interface brief` failed — the device columns then say so per row. */
  readonly briefKnown: boolean
  /** False while the ip-interface read itself failed — then routed/address stay Unknown, never inferred. */
  readonly l3Known: boolean
  /** True when the parsed config reports this section as an L3 one (for Ethernet/Port-Channel: its body carries `no switchport`). */
  readonly routed: boolean
  readonly address?: string
  readonly secondary?: readonly string[]
  readonly mtu?: number
  /** VRF binding this client reads reader-side; every write refuses such a section. */
  readonly vrf?: string
  /** ONLY from `show ip interface brief` — never derived from config lines. */
  readonly deviceStatus?: string
  readonly deviceProtocol?: string
  readonly deviceMtu?: number
  readonly liveAddress?: string
  /** False only when BOTH sides answered and they differ; absent means "not comparable". */
  readonly liveMatch?: boolean
  readonly bandPath: BandPath
}

export type AddressingLoadState = 'loading' | 'ready' | 'failed'

export interface AddressingMessage {
  readonly notice: string
  readonly failure: string
  readonly readError?: string
  readonly addressReadError?: string
  readonly managementError?: string
  readonly briefError?: string
}

export interface AddressingBand {
  readonly endpointHost: string
  readonly managementNamed: readonly string[]
  /** The container's in-band verdict note for the current selection, if any. */
  readonly note?: string
}

export interface AddressingViewProps {
  readonly state: AddressingLoadState
  readonly identity?: DeviceIdentity
  readonly proxyPrompt?: string
  readonly rows: readonly AddressingRow[]
  readonly fields: AddressingFields
  readonly onChange: (fields: AddressingFields) => void
  readonly onPreview: (event: FormEvent<HTMLFormElement>) => void
  readonly onReload: () => void
  readonly messages: AddressingMessage
  readonly band: AddressingBand
  readonly busy: boolean
}

const BAND_LABEL: Record<BandPath, string> = {
  'eapi-served': 'eAPI served here',
  addressed: 'Carries an IP address',
  'not-eapi-path': 'Not an eAPI path',
  unknown: 'Unknown',
}

const needsAddress = (action: AddressingAction): boolean => action === 'set-address' || action === 'add-secondary'

const addressingColumns: readonly DataTableColumn<AddressingRow>[] = [
  { header: 'Interface', cell: (row) => <strong>{row.name}</strong> },
  { header: 'Kind', cell: (row) => <StatePill value={row.kind} /> },
  {
    header: 'L3 state (running-config)',
    cell: (row) => !row.l3Known
      ? <span className="cell-note">Unknown — address read failed</span>
      : row.routed
        ? <StatePill value="routed" />
        : <span className="cell-note">no `no switchport` line</span>,
  },
  {
    header: 'Primary address',
    cell: (row) => !row.l3Known
      ? <span className="cell-note">Unknown — address read failed</span>
      : row.address === undefined
        ? <span className="cell-note">No address line</span>
        : <code>{row.address}</code>,
  },
  {
    header: 'Secondary lines',
    cell: (row) => row.secondary === undefined
      ? <span className="cell-note">None read</span>
      : <span>{row.secondary.map((entry) => <code key={entry}>{entry}</code>)}</span>,
  },
  { header: 'MTU', cell: (row) => row.mtu === undefined ? <span className="cell-note">No mtu line</span> : <span>{String(row.mtu)}</span> },
  { header: 'VRF', cell: (row) => row.vrf === undefined ? <span className="cell-note">Not bound</span> : <StatePill value={row.vrf} /> },
  {
    header: 'Device status (ip interface brief)',
    cell: (row) => !row.briefKnown
      ? <span className="cell-note">brief read failed</span>
      : row.deviceStatus === undefined
        ? <span className="cell-note">the answer named nothing for this row</span>
        : <><StatePill value={row.deviceStatus} />{row.deviceProtocol !== undefined ? <span className="cell-note">protocol: {row.deviceProtocol}</span> : null}</>,
  },
  {
    header: 'Device address / MTU (ip interface brief)',
    cell: (row) => !row.briefKnown
      ? <span className="cell-note">brief read failed</span>
      : row.liveAddress === undefined && row.deviceMtu === undefined
        ? <span className="cell-note">no ipAddr in the answer</span>
        : <>
          {row.liveAddress !== undefined ? <code>{row.liveAddress}</code> : <span className="cell-note">no ipAddr in the answer</span>}
          {row.deviceMtu !== undefined ? <span className="cell-note">mtu {String(row.deviceMtu)}</span> : null}
          {row.liveMatch === false ? <span className="notice notice-warning cell-note">the config line and the device answer disagree — not auto-reconciled</span> : null}
        </>,
  },
  { header: 'Management path', cell: (row) => <StatePill value={BAND_LABEL[row.bandPath]} /> },
]

export function AddressingView({
  state,
  identity,
  proxyPrompt,
  rows,
  fields,
  onChange,
  onPreview,
  onReload,
  messages,
  band,
  busy,
}: AddressingViewProps): ReactElement {
  const selectedRow = rows.find((row) => row.name === fields.iface)
  const canPick = rows.length > 0

  return <>
    <div className="screen-connection">
      <ConnectionHeader
        state={state === 'ready' ? 'connected' : state === 'failed' ? 'error' : 'connecting'}
        {...(identity !== undefined ? { identity } : {})}
        connectedLabel="Running-config read"
        connectingLabel={state === 'loading' ? 'Reading running-config' : identity === undefined ? 'Connecting' : undefined}
      />
    </div>

    <section className="workspace" aria-labelledby="addressing-title">
      <div className="workspace-heading">
        <div>
          <p className="eyebrow">IP ADDRESSING</p>
          <h2 id="addressing-title">IP addressing</h2>
        </div>
        <button className="quiet-button" type="button" onClick={onReload} disabled={state !== 'ready' || busy}>
          Reload running-config
        </button>
      </div>

      {proxyPrompt !== undefined && <div className="notice notice-error" role="alert"><strong>Local proxy is not configured.</strong><p>{proxyPrompt}</p></div>}
      {state === 'loading' && <p className="notice" role="status" aria-busy="true">Reading the interface sections and the parsed IP-interface table from running-config…</p>}
      {state === 'failed' && proxyPrompt === undefined && <div className="notice notice-error" role="alert"><strong>Device state could not be read.</strong><p>{messages.readError ?? messages.failure}</p></div>}

      {state === 'ready' && <>
        <p className="current-state">
          <strong>Sources, kept apart:</strong> row identity and every config column are parsed
          running-config; the two <em>device</em> columns come only from{' '}
          <code>show ip interface brief</code> in JSON form — committed positives on both targets
          (issue #76 wrote that this was uncaptured; that claim went stale and the correction rides
          with this screen). Status words are the device&rsquo;s own spellings, config/device
          disagreements are printed and never auto-reconciled, and a failed read leaves its columns
          claiming nothing. <strong>IPv6</strong> remains out of scope: this client models neither
          reading nor writing it, so it is neither listed nor assumed absent.
        </p>
        {messages.briefError !== undefined && <div className="notice notice-warning" role="alert"><strong>The device-status read (show ip interface brief) failed.</strong><p><code className="read-error">{messages.briefError}</code> The device columns say “brief read failed” per row; nothing down below is derived from config lines instead.</p></div>}
        {messages.addressReadError !== undefined && <div className="notice notice-warning" role="alert"><strong>The IP-interface table could not be parsed from the config read.</strong><p><code className="read-error">{messages.addressReadError}</code> Address, secondary, and MTU columns below say “Unknown — address read failed” per row instead of falling back to anything derived.</p></div>}
        {messages.managementError !== undefined && <p className="notice notice-warning" role="status">The management-API read failed: <code className="read-error">{messages.managementError}</code> The “eAPI served here” column stays Unknown for every row — that is not evidence any interface is off the management path.</p>}
        <p className="field-note">eAPI endpoint this UI dials: <code>{band.endpointHost}</code>. Interfaces the device named as serving eAPI: <strong>{band.managementNamed.length === 0 ? 'the answer named nothing' : band.managementNamed.join(', ')}</strong>.</p>

        {state === 'ready' && rows.length === 0
          ? <EmptyState heading="The running-config lists no interface sections at all." hint="A section-less config is an empty answer, not a failed read. Reload after the device reports sections." />
          : <DataTable columns={addressingColumns} rows={rows} rowKey={(row) => row.name} label="IP interfaces from running-config" />}
      </>}

      {/* The form stays visible even when the read failed (the sibling-screen shape): with no rows
          there is nothing to select, so Preview is disabled rather than the intent hidden. */}
      <section className="panel" aria-labelledby="addressing-form-title">
        <div className="panel-heading"><h3 id="addressing-form-title">Stage an addressing change</h3></div>
        <form onSubmit={onPreview}>
          <label htmlFor="addr-select">Interface</label>
          <select id="addr-select" name="addr-select" value={fields.iface} onChange={(event) => onChange({ ...fields, iface: event.target.value })} disabled={!canPick}>
            {rows.map((row) => <option key={row.name} value={row.name}>{row.name} · {row.kind}</option>)}
          </select>

          <label htmlFor="addr-action">Change</label>
          <select id="addr-action" name="addr-action" value={fields.action} onChange={(event) => onChange({ ...fields, action: event.target.value as AddressingAction })}>
            {ADDRESSING_ACTIONS.map((action) => <option key={action} value={action}>{ADDRESSING_ACTION_LABELS[action]}</option>)}
          </select>

          {selectedRow !== undefined && needsAddress(fields.action) && <>
            <p className="current-state">Now, from the config lines: <strong>{selectedRow.address ?? 'no primary address line'}</strong>{selectedRow.secondary !== undefined ? <> · secondary {selectedRow.secondary.join(', ')}</> : null}</p>
            <label htmlFor="addr-value">Address (A.B.C.D/E)</label>
            <input id="addr-value" name="addr-value" value={fields.address} onChange={(event) => onChange({ ...fields, address: event.target.value })} />
            <p className="field-note">The client&apos;s own guard shape: four decimal octets, a slash, a prefix — optionally the single trailing word <code>secondary</code>. Octet and prefix bounds are IPv4 arithmetic, not EOS claims (DR-032): the device keeps authority and its refusal comes back as a typed CommandError. <code> Management&lt;N&gt;</code> names and VRF-bound sections are refused by this screen before anything is staged.</p>
          </>}

          {fields.action === 'add-secondary' && <p className="field-note">This writes one <code>ip address … secondary</code> line. The client has NO verb for removing an individual secondary address, so this screen offers none; and what the bare <code>no ip address</code> negation does to secondary lines on this unit is uncaptured — it will be named if you stage it.</p>}

          {fields.action === 'route-port' && <p className="notice notice-warning" role="status">Turning a switching port into a routed port is a mode change: EOS&rsquo; general expectation is that the port&rsquo;s switching configuration goes away with the <code>no switchport</code> line, and the client marks its own upstream note about it unverified on this unit. This is refused outright on any interface the device names as serving eAPI. It still confirms as destructive.</p>}

          {fields.action === 'switchport-back' && <p className="notice notice-warning" role="status">This stages exactly <code>no ip address</code> then <code>switchport</code> — the verbatim pair and order from the client&apos;s delete-side port of upstream. The reverse order is a device question (#76 capture gaps), and whether the address is still cleared if EOS refuses mid-pair cannot be answered from captures on this unit. It confirms as destructive.</p>}

          {fields.action === 'remove-address' && <p className="field-note">The single negation the client composes is the bare <code>no ip address</code>. If rows show secondary lines, their fate under it is device state this screen has not captured — the risk list will name that before any commit.</p>}

          {band.note !== undefined && <p className="notice notice-warning" role="status"><strong>In-band note for {fields.iface}:</strong> {band.note}</p>}

          <div className="review-actions">
            <button type="submit" disabled={busy || !canPick}>Add to transaction</button>
          </div>
        </form>

        {messages.notice !== '' && <p className="notice notice-success operation-result" role="status">{messages.notice}</p>}
        {messages.failure !== '' && <div className="notice notice-error operation-result" role="alert"><strong>The device or this screen refused that.</strong><p>{messages.failure}</p></div>}
      </section>
    </section>
  </>
}
