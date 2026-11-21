/**
 * #87 (VRRP slice): the presentation half of the VRRP virtual-router editor
 * (`#/routing/vrrp`). Pure props (the StpGlobalView/NtpView pattern); every device string arrives
 * as a plain value and no `Vrrp`, `VrrpVridTable`, `IpInterface`, or `CommandSpec` crosses this
 * boundary.
 *
 * ## What this view may claim
 *
 * - The configured table comes from the parsed running-config reader (`node.vrrp.getAll()`); the
 *   device-side count comes from the soft `show vrrp` read and renders as a COUNT only (the
 *   element shape is unmodelled on both targets — the `#/routing` VRRP_SHAPE_NOTE carries why).
 *   The two are separate panels and never merged.
 * - An empty table is a NORMAL ready state (the switch runs zero groups today), never an error;
 *   a failed HARD read renders the error wall, never a blank table.
 * - The advanced fields (secondary IPs, advertisement interval, mac-adv-interval, ip-version,
 *   tracked objects, BFD, delays) render read-only — v1 shows what exists and never edits it
 *   (spec intake 1). The edit form offers exactly the five bounded fields.
 * - The create form's interface list is the read-driven candidate union; when the SOFT
 *   `ipinterfaces` read failed, the named note says the list narrowed and why.
 * - No commit/abort control exists anywhere on this screen (#141: the Transaction Center owns
 *   them); the three forms only stage.
 */
import type { FormEvent, ReactElement } from 'react'

import { ConnectionHeader } from '../../components/ui/ConnectionHeader'
import type { ConnectionState } from '../../components/ui/ConnectionHeader'
import { DataTable } from '../../components/ui/DataTable'
import type { DataTableColumn } from '../../components/ui/DataTable'
import { EmptyState } from '../../components/ui/EmptyState'
import { VRRP_EDITOR_STANDING_NOTE, VRRP_EDIT_FIELDS } from './vrrp-rules'
import type { VrrpCreateDraft, VrrpEditDraft, VrrpManagerRow } from './vrrp-rules'

export interface VrrpManagerViewProps {
  readonly state: 'loading' | 'ready' | 'failed'
  readonly readError?: string
  readonly proxyPrompt?: string
  readonly identity?: { hostname: string; version: string; model: string }

  /** True once the HARD `vrrp.getAll()` read resolved (distinguishes unread from empty). */
  readonly configKnown: boolean
  readonly rows: readonly VrrpManagerRow[]
  /** The soft `show vrrp` count — `undefined` while unread; the failure note renders beside it. */
  readonly deviceCount?: number
  readonly deviceCountFailure?: string

  /** The create form's interface candidates (table names ∪ L3 names; narrowed when l3ReadFailed). */
  readonly candidates: readonly string[]
  readonly l3ReadFailed: boolean
  readonly l3ReadNote: string

  readonly createDraft: VrrpCreateDraft
  readonly createError?: string
  readonly onCreateChange: (patch: Partial<VrrpCreateDraft>) => void
  readonly onCreateSubmit: (event: FormEvent<HTMLFormElement>) => void

  readonly editDraft: VrrpEditDraft
  readonly editError?: string
  readonly onEditChange: (patch: Partial<VrrpEditDraft>) => void
  readonly onEditSubmit: (event: FormEvent<HTMLFormElement>) => void

  readonly deleteTarget: string
  readonly deleteError?: string
  readonly onDeleteTargetChange: (value: string) => void
  readonly onDeleteSubmit: (event: FormEvent<HTMLFormElement>) => void

  readonly busy: boolean
  readonly canAct: boolean
  readonly notice: string
  readonly failure: string
  readonly connection: ConnectionState
  readonly connectionLabel: string
  readonly onReload: () => void
}

export function VrrpManagerView(props: VrrpManagerViewProps): ReactElement {
  const {
    state,
    readError,
    proxyPrompt,
    identity,
    configKnown,
    rows,
    deviceCount,
    deviceCountFailure,
    candidates,
    l3ReadFailed,
    l3ReadNote,
    createDraft,
    createError,
    onCreateChange,
    onCreateSubmit,
    editDraft,
    editError,
    onEditChange,
    onEditSubmit,
    deleteTarget,
    deleteError,
    onDeleteTargetChange,
    onDeleteSubmit,
    busy,
    canAct,
    notice,
    failure,
    connection,
    connectionLabel,
    onReload,
  } = props

  const groupOptions = rows.map((row) => `${row.interfaceName}/${String(row.vrid)}`)
  const editFieldKind = VRRP_EDIT_FIELDS.find((field) => field.value === editDraft.field)?.kind ?? 'text'

  const configColumns: readonly DataTableColumn<VrrpManagerRow>[] = [
    { header: 'Interface', cell: (row) => <code>{row.interfaceName}</code> },
    { header: 'VRID', cell: (row) => <code>{String(row.vrid)}</code>, numeric: true },
    { header: 'State', cell: (row) => row.enabled },
    { header: 'Priority', cell: (row) => row.priority, numeric: true },
    { header: 'Preempt', cell: (row) => row.preempt },
    { header: 'Primary IPv4', cell: (row) => <code>{row.primaryIp}</code> },
    { header: 'Description', cell: (row) => row.description },
  ]

  const advancedColumns: readonly DataTableColumn<VrrpManagerRow>[] = [
    { header: 'Interface', cell: (row) => <code>{row.interfaceName}</code> },
    { header: 'VRID', cell: (row) => <code>{String(row.vrid)}</code>, numeric: true },
    { header: 'Secondary IPs', cell: (row) => row.secondaryIps },
    { header: 'Adv. interval', cell: (row) => row.advertiseInterval },
    { header: 'MAC adv. interval', cell: (row) => row.macAdvInterval },
    { header: 'IP version', cell: (row) => row.ipVersion },
    { header: 'Tracked objects', cell: (row) => row.tracks },
    { header: 'BFD IP', cell: (row) => row.bfdIp },
    { header: 'Delays', cell: (row) => row.delays },
  ]

  const formsDisabled = !canAct || busy

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
        <h2 id="workspace-title">VRRP virtual routers</h2>
      </div>
      <button className="quiet-button" type="button" onClick={onReload} disabled={!canAct || busy}>Reload VRRP state</button>
    </div>

    {proxyPrompt !== undefined && <div className="notice notice-error" role="alert"><strong>Local proxy is not configured.</strong><p>{proxyPrompt}</p></div>}

    <p className="notice notice-warning" role="status">{VRRP_EDITOR_STANDING_NOTE} <a href="#/routing">Routing status</a> shows the read-only device-side view.</p>

    {state === 'loading' && <p className="notice" role="status">Reading the configured VRRP table (parsed running-config)…</p>}
    {readError !== undefined && <div className="notice notice-error" role="alert"><strong>The VRRP table read failed.</strong><p>{readError}</p><button className="quiet-button" type="button" onClick={onReload} disabled={busy}>Try again</button></div>}

    {/* Configured groups — the HARD parsed-config table */}
    <section className="panel" aria-labelledby="vrrm-config-title">
      <div className="panel-heading">
        <div><p className="eyebrow">CONFIGURED (PARSED RUNNING-CONFIG)</p><h3 id="vrrm-config-title">Virtual routers</h3></div>
        <span className="panel-index">{!configKnown ? 'unread' : rows.length === 0 ? 'none' : rows.length.toString().padStart(2, '0')}</span>
      </div>
      {!configKnown
        ? <p className="field-note">No <code>vrrp.getAll()</code> read has answered yet.</p>
        : rows.length === 0
          ? <EmptyState heading="No interface section carries a `vrrp &lt;vrid&gt;` line." hint="A normal configured state — this unit runs zero VRRP groups today. The Create form below stages the first one; every composed line comes from the client's own dry-run setters." />
          : <DataTable columns={configColumns} rows={rows} rowKey={(row) => `${row.interfaceName}/${String(row.vrid)}`} label="Configured VRRP virtual routers" />}
      {rows.length > 0 && <>
        <h4>Advanced fields (read-only in v1)</h4>
        <p className="field-note">Secondary IPs, advertisement intervals, IP version, tracked objects, BFD, and the delays are shown as the reader parsed them. This screen edits none of them (spec intake 1) — their client verbs exist, and editing them is a v2 candidate.</p>
        <DataTable columns={advancedColumns} rows={rows} rowKey={(row) => `${row.interfaceName}/${String(row.vrid)}`} label="VRRP advanced fields (read-only)" />
      </>}
    </section>

    {/* Device side — the soft show count, never merged with config */}
    <section className="panel" aria-labelledby="vrrm-device-title">
      <div className="panel-heading">
        <div><p className="eyebrow">DEVICE REPLY (SOFT SHOW READ)</p><h3 id="vrrm-device-title">show vrrp</h3></div>
        <span className="panel-index">{deviceCountFailure !== undefined ? 'no answer' : deviceCount === undefined ? 'unread' : `${String(deviceCount)} group(s)`}</span>
      </div>
      {deviceCountFailure !== undefined && <p className="field-note" role="status">{deviceCountFailure}</p>}
      {deviceCountFailure === undefined && deviceCount !== undefined && <p className="field-note" role="status">Virtual routers the device answer names: <strong>{String(deviceCount)}</strong>. The element shape is unmodelled on both targets, so only the count renders.</p>}
    </section>

    {/* Create form */}
    <section className="panel" aria-labelledby="vrrm-create-title">
      <div className="panel-heading">
        <div><p className="eyebrow">WRITE (STAGES ONLY)</p><h3 id="vrrm-create-title">Create a virtual router</h3></div>
      </div>
      <p className="field-note">Every line is composed by the client&#39;s own dry-run setters in <code>_vrrp_set</code> order (the enable line first — <code>create</code> always carries one); the modern/legacy family spelling is the client&#39;s config-text detection (DR-116), never this form&#39;s choice.</p>
      {l3ReadFailed && <p className="field-note" role="status">{l3ReadNote}</p>}
      <form onSubmit={onCreateSubmit}>
        <div className="field-row">
          <div>
            <label htmlFor="vrrm-create-interface">Interface</label>
            <select id="vrrm-create-interface" name="vrrm-create-interface" value={createDraft.interfaceName} onChange={(event) => onCreateChange({ interfaceName: event.target.value })} disabled={formsDisabled}>
              <option value="">— choose an interface —</option>
              {candidates.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="vrrm-create-vrid">VRID (non-negative integer)</label>
            <input id="vrrm-create-vrid" name="vrrm-create-vrid" type="text" inputMode="numeric" value={createDraft.vrid} onChange={(event) => onCreateChange({ vrid: event.target.value })} disabled={formsDisabled} maxLength={9} />
          </div>
          <div>
            <label htmlFor="vrrm-create-ip">Primary IPv4 address</label>
            <input id="vrrm-create-ip" name="vrrm-create-ip" type="text" value={createDraft.primaryIp} onChange={(event) => onCreateChange({ primaryIp: event.target.value })} disabled={formsDisabled} placeholder="10.10.70.50" />
          </div>
        </div>
        <div className="field-row">
          <div>
            <label htmlFor="vrrm-create-priority">Priority 1-254 (blank = no line)</label>
            <input id="vrrm-create-priority" name="vrrm-create-priority" type="text" inputMode="numeric" value={createDraft.priority} onChange={(event) => onCreateChange({ priority: event.target.value })} disabled={formsDisabled} maxLength={3} />
          </div>
          <div>
            <label htmlFor="vrrm-create-preempt">Preempt (blank = no line)</label>
            <select id="vrrm-create-preempt" name="vrrm-create-preempt" value={createDraft.preempt} onChange={(event) => onCreateChange({ preempt: event.target.value })} disabled={formsDisabled}>
              <option value="">— no preempt line —</option>
              <option value="yes">yes — `vrrp N preempt`</option>
              <option value="no">no — `no vrrp N preempt`</option>
            </select>
          </div>
          <div>
            <label htmlFor="vrrm-create-start">Start state</label>
            <select id="vrrm-create-start" name="vrrm-create-start" value={createDraft.startState} onChange={(event) => onCreateChange({ startState: event.target.value })} disabled={formsDisabled}>
              <option value="disabled">disabled — `vrrp N disabled` (the create default)</option>
              <option value="enabled">enabled — `no vrrp N disabled`</option>
            </select>
          </div>
        </div>
        <div className="field-row">
          <div>
            <label htmlFor="vrrm-create-description">Description (blank = no line)</label>
            <input id="vrrm-create-description" name="vrrm-create-description" type="text" value={createDraft.description} onChange={(event) => onCreateChange({ description: event.target.value })} disabled={formsDisabled} maxLength={240} />
          </div>
        </div>
        {createError !== undefined && <p className="notice notice-error" role="alert">{createError}</p>}
        <div className="review-actions">
          <button className="primary-button" type="submit" disabled={formsDisabled}>Stage create batch</button>
        </div>
      </form>
    </section>

    {/* Edit form — one field of an existing group */}
    <section className="panel" aria-labelledby="vrrm-edit-title">
      <div className="panel-heading">
        <div><p className="eyebrow">WRITE (STAGES ONLY)</p><h3 id="vrrm-edit-title">Edit one field of an existing group</h3></div>
      </div>
      <form onSubmit={onEditSubmit}>
        <div className="field-row">
          <div>
            <label htmlFor="vrrm-edit-target">Virtual router</label>
            <select id="vrrm-edit-target" name="vrrm-edit-target" value={editDraft.target} onChange={(event) => onEditChange({ target: event.target.value, value: '' })} disabled={formsDisabled || groupOptions.length === 0}>
              <option value="">— choose a group —</option>
              {groupOptions.map((target) => <option key={target} value={target}>{target}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="vrrm-edit-field">Field to change</label>
            <select id="vrrm-edit-field" name="vrrm-edit-field" value={editDraft.field} onChange={(event) => onEditChange({ field: event.target.value, value: '' })} disabled={formsDisabled || groupOptions.length === 0}>
              <option value="">— choose a field —</option>
              {VRRP_EDIT_FIELDS.map((field) => <option key={field.value} value={field.value}>{field.label}</option>)}
            </select>
          </div>
          <div>
            {editFieldKind === 'boolean' && <>
              <label htmlFor="vrrm-edit-value">New value</label>
              <select id="vrrm-edit-value" name="vrrm-edit-value" value={editDraft.value} onChange={(event) => onEditChange({ value: event.target.value })} disabled={formsDisabled || editDraft.field === ''}>
                <option value="">— choose —</option>
                <option value="true">yes</option>
                <option value="false">no</option>
              </select>
            </>}
            {editFieldKind === 'number' && <>
              <label htmlFor="vrrm-edit-value">New value</label>
              <input id="vrrm-edit-value" name="vrrm-edit-value" type="text" inputMode="numeric" value={editDraft.value} onChange={(event) => onEditChange({ value: event.target.value })} disabled={formsDisabled || editDraft.field === ''} maxLength={4} />
            </>}
            {editFieldKind === 'text' && <>
              <label htmlFor="vrrm-edit-value">New value</label>
              <input id="vrrm-edit-value" name="vrrm-edit-value" type="text" value={editDraft.value} onChange={(event) => onEditChange({ value: event.target.value })} disabled={formsDisabled || editDraft.field === ''} maxLength={240} />
            </>}
          </div>
        </div>
        {editError !== undefined && <p className="notice notice-error" role="alert">{editError}</p>}
        <div className="review-actions">
          <button className="primary-button" type="submit" disabled={formsDisabled || groupOptions.length === 0}>Stage field edit</button>
        </div>
      </form>
    </section>

    {/* Delete form — the whole group, hard confirm */}
    <section className="panel" aria-labelledby="vrrm-delete-title">
      <div className="panel-heading">
        <div><p className="eyebrow">WRITE (STAGES ONLY, DESTRUCTIVE)</p><h3 id="vrrm-delete-title">Delete a virtual router</h3></div>
      </div>
      <p className="field-note">Deletes the whole group — <code>no vrrp &lt;vrid&gt;</code> under the interface, the client&#39;s own era-free literal (its <code>delete()</code> has no dry-run arm). The Transaction Center runs a second confirm naming the interface and VRID.</p>
      <form onSubmit={onDeleteSubmit}>
        <div className="field-row">
          <div>
            <label htmlFor="vrrm-delete-target">Virtual router to delete</label>
            <select id="vrrm-delete-target" name="vrrm-delete-target" value={deleteTarget} onChange={(event) => onDeleteTargetChange(event.target.value)} disabled={formsDisabled || groupOptions.length === 0}>
              <option value="">— choose a group —</option>
              {groupOptions.map((target) => <option key={target} value={target}>{target}</option>)}
            </select>
          </div>
        </div>
        {deleteError !== undefined && <p className="notice notice-error" role="alert">{deleteError}</p>}
        <div className="review-actions">
          <button className="primary-button" type="submit" disabled={formsDisabled || groupOptions.length === 0}>Stage delete</button>
        </div>
      </form>
    </section>

    {/* Staged review panel — the standing pattern; commit/abort live in Transaction Center only */}
    {notice !== '' && <p className="notice notice-success operation-result" role="status">{notice}</p>}
    {failure !== '' && <div className="notice notice-error operation-result" role="alert"><strong>The device did not take that.</strong><p>{failure}</p></div>}
    <p className="field-note">The forms above only stage into the shared transaction — nothing on this screen commits or aborts (issue #141: the Transaction Center owns those).</p>
  </section>
}
