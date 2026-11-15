/**
 * S14 (#84): the presentation half of the READ-ONLY MLAG status screen. Pure props (matching
 * `NtpView` / the F-tier split); every device string arrives as a plain value and this file owns
 * no fetch, no session, and no write.
 *
 * ## What this view may claim
 *
 * - Status comes ONLY from the captured `show mlag` contract (`ShowMlagReply` in
 *   `src/eapi/show-contracts.ts`): the pill maps the single captured `state` key via
 *   ./mlag-rules.ts and echoes the raw device string beside it. An unanswered or 1002-rejected
 *   read renders the `unknown` pill plus the folded device text — never an error wall.
 * - Ports/config come from `node.mlag.get()` (parsed running-config). Absent fields print
 *   “(not configured)”; the whole-section-absent case prints the EmptyState “not configured” arm,
 *   which is a NORMAL state (the captured sample answers exactly this shape).
 * - The captured model carries no consistency-check key, so no consistency value is rendered —
 *   the panel states the absence instead (the #84 acceptance line: inventing a field is a failure).
 *
 * Every table goes through F3 `DataTable` (wave convention, recorded during the S12 review).
 * The read-only banner is rendered in EVERY state, including loading and failed — the operator
 * never has to reach a device answer to learn this screen writes nothing.
 */
import type { ReactElement } from 'react'
import type { MlagGlobalConfig, MlagInterface } from '@devhax-heavy-industries/arista-eapi'

import { ConnectionHeader } from '../../components/ui/ConnectionHeader'
import type { ConnectionState } from '../../components/ui/ConnectionHeader'
import { DataTable } from '../../components/ui/DataTable'
import type { DataTableColumn } from '../../components/ui/DataTable'
import { EmptyState } from '../../components/ui/EmptyState'
import { StatePill } from '../../components/ui/StatePill'
import type { MlagStateView } from './mlag-rules'
import { describeShutdownFlag, fieldText, flagText, KNOWN_MLAG_STATE_LABELS } from './mlag-rules'
import type { ShowMlagReply } from '../../eapi/show-contracts'

export interface MlagFieldRow {
  readonly field: string
  readonly value: string
}

export interface MlagPortCountRow {
  readonly label: string
  readonly count: number
}

export interface MlagViewProps {
  readonly state: 'loading' | 'ready' | 'failed'
  readonly readError?: string
  readonly proxyPrompt?: string
  readonly identity?: { hostname: string; version: string; model: string }
  /** The narrowed device-state read; `undefined` until the reads land — pending, which is NOT the unknown arm. */
  readonly status?: MlagStateView
  /** `node.mlag.get()` answered at all. */
  readonly configKnown: boolean
  /** Config half of the ready payload; undefined until the read answers. */
  readonly config?: MlagGlobalConfig
  /** Interfaces half of the ready payload, in device order; empty until the read answers. */
  readonly interfaces: readonly MlagInterface[]
  /** True while the ready payload is the not-configured shape (a NORMAL state, not an error). */
  readonly unconfigured: boolean
  /** The captured `show mlag` reply when that soft read answered; absent fields are never invented. */
  readonly show?: ShowMlagReply
  readonly canAct: boolean
  readonly connection: ConnectionState
  readonly connectionLabel: string
  readonly onReload: () => void
}

/** The five config knobs `node.mlag.get()` reads, in the order the section writes them. */
function configRows(config: MlagGlobalConfig): readonly MlagFieldRow[] {
  return [
    { field: 'domain-id', value: fieldText(config.domainId) },
    { field: 'local-interface', value: fieldText(config.localInterface) },
    { field: 'peer-address', value: fieldText(config.peerAddress) },
    { field: 'peer-link', value: fieldText(config.peerLink) },
    { field: 'shutdown', value: describeShutdownFlag(config.shutdown) },
  ]
}

/** Every captured `show mlag` key except `mlagPorts`, which gets its own counts table below. */
function showRows(show: ShowMlagReply): readonly MlagFieldRow[] {
  return [
    { field: 'state', value: show.state },
    { field: 'localInterface', value: show.localInterface },
    { field: 'peerLink', value: show.peerLink },
    { field: 'reloadDelay', value: show.reloadDelay.toString() },
    { field: 'reloadDelayNonMlag', value: show.reloadDelayNonMlag.toString() },
    { field: 'portsErrdisabled', value: flagText(show.portsErrdisabled) },
    { field: 'dualPrimaryDetectionState', value: show.dualPrimaryDetectionState },
    { field: 'dualPrimaryPortsErrdisabled', value: flagText(show.dualPrimaryPortsErrdisabled) },
  ]
}

const fieldColumns: readonly DataTableColumn<MlagFieldRow>[] = [
  { header: 'Field', cell: (row) => <code>{row.field}</code> },
  { header: 'Value', cell: (row) => row.value },
]

const portCountColumns: readonly DataTableColumn<MlagPortCountRow>[] = [
  { header: 'Port bucket (device label)', cell: (row) => row.label },
  { header: 'Count', numeric: true, cell: (row) => row.count.toString() },
]

const interfaceColumns: readonly DataTableColumn<MlagInterface>[] = [
  { header: 'Interface', cell: (row) => <code>{row.name}</code> },
  { header: 'MLAG id', numeric: true, cell: (row) => row.mlagId },
]

export function MlagView(props: MlagViewProps): ReactElement {
  const {
    state,
    readError,
    proxyPrompt,
    identity,
    status,
    configKnown,
    config,
    interfaces,
    unconfigured,
    show,
    canAct,
    connection,
    connectionLabel,
    onReload,
  } = props

  // `status === undefined` is the pending arm (no read has answered); the `unknown` kind is
  // distinct: the read batch answered but the soft `show mlag` read folded a failure into it.

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
        <p className="eyebrow">SWITCH FABRIC</p>
        <h2 id="workspace-title">MLAG</h2>
      </div>
      <button className="quiet-button" type="button" onClick={onReload} disabled={!canAct}>Reload MLAG state</button>
    </div>

    {proxyPrompt !== undefined && <div className="notice notice-error" role="alert"><strong>Local proxy is not configured.</strong><p>{proxyPrompt}</p></div>}

    {/* The standing read-only banner — present in EVERY state, before any device answer exists. */}
    <p className="notice notice-warning" role="status">
      <strong>Read-only screen: MLAG configuration editing is not offered here.</strong>{' '}
      An MLAG domain spans two switches and a peer link, and a mis-paired write can take a device
      out of service, so this screen only ever reads: nothing here opens a config session, sends
      an <code>enable</code> command, or edits a line. The two reads behind the panels are the parsed
      running-config (<code>node.mlag.get()</code>) and the captured <code>show mlag</code> reply
      (<code>node.show(&#39;mlag&#39;)</code>) — configured state and device state stay separate
      reads, and where the device answers disagree, both are shown verbatim rather than merged.
    </p>

    {state === 'loading' && <p className="notice" role="status">Reading MLAG state (parsed running-config plus <code>show mlag</code>)&#8230;</p>}
    {readError !== undefined && <div className="notice notice-error" role="alert"><strong>The MLAG read failed.</strong><p>{readError}</p><button className="quiet-button" type="button" onClick={onReload}>Try again</button></div>}

    {/* Device state — the status pill, mapped only from the captured `state` key */}
    <section className="panel" aria-labelledby="mlag-status-title">
      <div className="panel-heading">
        <div><p className="eyebrow">DEVICE STATE</p><h3 id="mlag-status-title">show mlag status</h3></div>
        <span className="panel-index">{status === undefined ? 'unread' : status.kind === 'unknown' ? 'unknown' : 'reported'}</span>
      </div>
      {status === undefined && <p className="field-note">No read has answered yet, so the device state is pending — which is NOT the same as the unknown arm below.</p>}
      {status !== undefined && status.kind === 'unknown' && <>
        <p className="field-note"><StatePill value="unknown" /> — the <code>show mlag</code> read did not produce a state. Raw device text: <strong>{status.reason}</strong></p>
        <p className="field-note">An unanswered or rejected (for example an <code>Error [1002]</code> refusal) answer leaves the state UNKNOWN by design: this screen never treats it as a crash, and the config-side panels below still render whatever the running-config read returned.</p>
      </>}
      {status !== undefined && status.kind === 'reported' && <>
        <p className="field-note">Device token: <StatePill value={status.raw} /> mapped as <strong>{status.label}</strong>{status.recognised ? '' : ' \u2014 this token is outside the five states this screen maps (' + Object.keys(KNOWN_MLAG_STATE_LABELS).join(', ') + '); the raw string above is exactly what the device sent.'}</p>
        <p className="field-note">Consistency-check lines are not part of the captured <code>show mlag</code> model on this screen, so nothing about consistency is rendered or guessed here.</p>
      </>}
    </section>

    {/* Configured domain fields */}
    <section className="panel" aria-labelledby="mlag-domain-title">
      <div className="panel-heading">
        <div><p className="eyebrow">CONFIGURED (PARSED RUNNING-CONFIG)</p><h3 id="mlag-domain-title">MLAG domain settings</h3></div>
        <span className="panel-index">{!configKnown ? 'unread' : unconfigured ? 'none' : 'set'}</span>
      </div>
      {!configKnown && <p className="field-note">No <code>mlag.get()</code> read has answered yet, so the domain settings are unknown — not empty.</p>}
      {configKnown && unconfigured && <EmptyState
        heading="MLAG is not configured on this device."
        hint="This is a normal configured state, not an error: the running-config carries no `mlag configuration` section and no Port-Channel carries an `mlag` id. The captured `show mlag` sample answers exactly this shape. Configuration editing is not offered on this screen."
      />}
      {configKnown && !unconfigured && config !== undefined && <DataTable
        columns={fieldColumns}
        rows={configRows(config)}
        rowKey={(row) => row.field}
        label="Configured MLAG domain fields"
      />}
    </section>

    {/* MLAG-id interfaces from node.mlag.get() */}
    <section className="panel" aria-labelledby="mlag-interfaces-title">
      <div className="panel-heading">
        <div><p className="eyebrow">CONFIGURED (PARSED RUNNING-CONFIG)</p><h3 id="mlag-interfaces-title">Port-Channels with an MLAG id</h3></div>
        <span className="panel-index">{!configKnown ? 'unread' : interfaces.length === 0 ? 'none' : interfaces.length.toString().padStart(2, '0')}</span>
      </div>
      {!configKnown
        ? <p className="field-note">The interface half rides the same <code>mlag.get()</code> read; it has not answered yet.</p>
        : interfaces.length === 0
          ? <EmptyState
            heading="No Port-Channel interface carries an mlag id."
            hint="The reader keeps only `interface Po…` sections with a digits `mlag` line (resources/mlag.ts). An interface appears here once the config assigns it one."
          />
          : <DataTable
            columns={interfaceColumns}
            rows={interfaces}
            rowKey={(row) => row.name}
            label="MLAG-assigned interfaces"
          />}
    </section>

    {/* Captured show-reply fields, verbatim */}
    <section className="panel" aria-labelledby="mlag-capture-title">
      <div className="panel-heading">
        <div><p className="eyebrow">DEVICE REPLY (VERBATIM CAPTURED KEYS)</p><h3 id="mlag-capture-title">show mlag fields</h3></div>
        <span className="panel-index">{show === undefined ? 'no answer' : 'captured'}</span>
      </div>
      {show === undefined
        ? <p className="field-note">The <code>show mlag</code> read did not answer, so no captured field can be shown. The state arm above carries the folded reason; nothing here is filled in by guessing.</p>
        : <>
          <DataTable columns={fieldColumns} rows={showRows(show)} rowKey={(row) => row.field} label="Captured show mlag fields" />
          <DataTable
            columns={portCountColumns}
            rows={Object.entries(show.mlagPorts).map(([label, count]) => ({ label, count }))}
            rowKey={(row) => row.label}
            label="Captured mlagPorts counts by device label"
          />
          <p className="field-note">These are the only keys the recorded <code>show mlag</code> capture models (every one shown; empty strings are kept as the device sent them). Values are device vocabulary — labels, buckets and spellings belong to EOS, not to this screen.</p>
        </>}
    </section>
  </section>
}
