/**
 * B3 (#88) step 2: the presentation half of the spanning-tree GLOBAL screen (`#/stp/global`).
 * Pure props (matching `StpView` / `NtpView`); every device string arrives as a plain value and no
 * `StpSettings`, `ConfigSections`, or `CommandSpec` crosses this boundary.
 *
 * ## The boundaries this view keeps honest (SPEC-stp-global-editor.md)
 *
 * - Both panels are CONFIG-backed (the parsed running-config, via `stp.get()` / `chunkConfig()`).
 *   Nothing here claims live spanning-tree state — that is `#/stp`'s operational panel's job, and
 *   the two screens never mix sources or controls (the audit's #88 "Do Not Do").
 * - The mode form offers exactly the three approved values, each option label carrying its
 *   consequence; choosing `rapid-pvst` reveals the container-only-acceptance disclosure IN-FORM
 *   before anything stages (owner decision 2026-11-21).
 * - The region panel distinguishes four states: unread (chunk read pending), read-failed (named
 *   note, form disabled, mode form still usable), no-block (normal empty: "no MST region
 *   configured", the form offers to create the first), and configured (name/revision/instance
 *   rows verbatim, plus an honest count of lines this screen does not model).
 * - No commit/abort control exists anywhere on this screen (#141: the Transaction Center owns
 *   them); the forms only stage. A read mapping is removable via a per-row toggle that stages the
 *   capture-backed bare `no instance <id>` (rea-q2, unblock-grammar-ceos.json); the added-rows
 *   table is removable because those lines were never on the device.
 */
import type { FormEvent } from 'react'
import type { ReactElement } from 'react'

import { ConnectionHeader } from '../../components/ui/ConnectionHeader'
import type { ConnectionState } from '../../components/ui/ConnectionHeader'
import { DataTable } from '../../components/ui/DataTable'
import type { DataTableColumn } from '../../components/ui/DataTable'
import {
  STP_GLOBAL_MODES,
  STP_FAR_END_NOTE,
  stpRapidPvstDisclosure,
} from './stp-global-rules'
import type { MstRegionView, StpGlobalModeChoice } from './stp-global-rules'

/** One added (not-yet-staged) instance-mapping row in the region form. */
export interface MstInstanceDraftRow {
  readonly id: string
  readonly vlans: string
}

export interface StpGlobalViewProps {
  readonly state: 'loading' | 'ready' | 'failed'
  readonly readError?: string
  readonly proxyPrompt?: string
  readonly identity?: { hostname: string; version: string; model: string }

  // --- mode summary + editor -------------------------------------------------------------------------
  /** False while no `stp.get()` has answered — "no mode line" must never show as confirmed. */
  readonly modeKnown: boolean
  /** The verbatim `spanning-tree mode <token>`; `undefined` when the config carries no such line. */
  readonly mode?: string
  readonly selectedMode: string
  readonly modeError?: string
  readonly onModeChange: (mode: string) => void
  readonly onModePreview: (event: FormEvent<HTMLFormElement>) => void

  // --- MST region panel + editor ----------------------------------------------------------------------
  /** True once the soft `chunkConfig()` read resolved (distinguishes unread from no-block). */
  readonly regionKnown: boolean
  /** The parsed block; `undefined` while unknown OR when the config carries no region section. */
  readonly region?: MstRegionView & { readonly unmodelledLines: number }
  /** True when the soft region read FAILED — the panel names that; the mode form stays usable. */
  readonly regionUnavailable?: boolean
  readonly regionUnavailableNote?: string
  readonly regionName: string
  readonly regionRevision: string
  readonly instanceRows: readonly MstInstanceDraftRow[]
  readonly instanceIdDraft: string
  readonly instanceVlansDraft: string
  readonly regionError?: string
  readonly onRegionNameChange: (value: string) => void
  readonly onRegionRevisionChange: (value: string) => void
  readonly onInstanceIdDraftChange: (value: string) => void
  readonly onInstanceVlansDraftChange: (value: string) => void
  readonly onAddInstanceRow: () => void
  readonly onRemoveInstanceRow: (index: number) => void
  /** Instance ids marked for removal (from the READ block; the bare `no instance <id>` verb). */
  readonly removeInstanceIds: readonly string[]
  readonly onToggleRemoveInstance: (id: string) => void
  readonly onRegionPreview: (event: FormEvent<HTMLFormElement>) => void

  readonly busy: boolean
  readonly canAct: boolean
  readonly notice: string
  readonly failure: string
  readonly connection: ConnectionState
  readonly connectionLabel: string
  readonly onReload: () => void
}

/** Per-option consequence copy — the select itself carries the blast, not just the confirm. */
const MODE_OPTION_COPY: Readonly<Record<StpGlobalModeChoice, string>> = {
  'mstp': 'mstp — Multiple Spanning Tree (this unit boots this way; hardware-verified)',
  'none': 'none — disables spanning-tree on every port (hardware stage-verified; loop protection gone)',
  'rapid-pvst': 'rapid-pvst — Rapid per-VLAN STP (stage-accepted on this unit, DR-159; committed behavior measured on cEOS-lab only)',
}

export function StpGlobalView(props: StpGlobalViewProps): ReactElement {
  const {
    state,
    readError,
    proxyPrompt,
    identity,
    modeKnown,
    mode,
    selectedMode,
    modeError,
    onModeChange,
    onModePreview,
    regionKnown,
    region,
    regionUnavailable,
    regionUnavailableNote,
    regionName,
    regionRevision,
    instanceRows,
    instanceIdDraft,
    instanceVlansDraft,
    regionError,
    onRegionNameChange,
    onRegionRevisionChange,
    onInstanceIdDraftChange,
    onInstanceVlansDraftChange,
    onAddInstanceRow,
    onRemoveInstanceRow,
    removeInstanceIds,
    onToggleRemoveInstance,
    onRegionPreview,
    busy,
    canAct,
    notice,
    failure,
    connection,
    connectionLabel,
    onReload,
  } = props

  const configuredInstanceColumns: readonly DataTableColumn<MstRegionView['instances'][number]>[] = [
    { header: 'Instance', cell: (row) => <code>{row.id}</code> },
    { header: 'VLANs', cell: (row) => <code>{row.vlans}</code> },
    {
      header: 'Remove',
      cell: (row) => (
        <button
          className="quiet-button"
          type="button"
          onClick={() => onToggleRemoveInstance(row.id)}
          disabled={regionFormDisabled}
          aria-pressed={removeInstanceIds.includes(row.id)}
        >
          {removeInstanceIds.includes(row.id) ? `Undo remove no instance ${row.id}` : `Remove no instance ${row.id}`}
        </button>
      ),
    },
  ]

  const regionFormDisabled = !canAct || busy || regionUnavailable === true || !regionKnown

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
        <h2 id="workspace-title">Spanning-tree global</h2>
      </div>
      <button className="quiet-button" type="button" onClick={onReload} disabled={!canAct || busy}>Reload global spanning-tree state</button>
    </div>

    {proxyPrompt !== undefined && <div className="notice notice-error" role="alert"><strong>Local proxy is not configured.</strong><p>{proxyPrompt}</p></div>}

    <p className="notice notice-warning" role="status">
      This screen edits the switch&#39;s <strong>global spanning-tree mode</strong> and <strong>MST
      region</strong> — a mode change re-initializes spanning-tree instances network-wide. The
      measured blast (cEOS-lab 4.28.14M: ~67 ms flip, MST0 replaced by per-VLAN instances) is
      quoted at every confirm; container measurement, not measured on this unit (DR-043). Writes
      stage into the shared transaction; the device&#39;s own <code>diff()</code> is reviewed in
      Transaction Center before <em>that</em> commit, which touches running-config only (DR-024).
      Per-port guard edits live on the <a href="#/stp">Spanning tree</a> screen — the two never mix.
    </p>

    {state === 'loading' && <p className="notice" role="status">Reading the global spanning-tree configuration (parsed running-config)…</p>}
    {readError !== undefined && <div className="notice notice-error" role="alert"><strong>The spanning-tree read failed.</strong><p>{readError}</p><button className="quiet-button" type="button" onClick={onReload} disabled={busy}>Try again</button></div>}

    {/* Mode summary + change form */}
    <section className="panel" aria-labelledby="stpg-mode-title">
      <div className="panel-heading">
        <div><p className="eyebrow">CONFIGURED</p><h3 id="stpg-mode-title">Global spanning-tree mode</h3></div>
        <span className="panel-index">{modeKnown ? 'read' : 'unread'}</span>
      </div>
      <p className="field-note">
        Current mode:{' '}
        <strong>
          {!modeKnown
            ? '(no spanning-tree read has answered yet)'
            : mode === undefined
              ? '(none — the running-config carries no `spanning-tree mode` line)'
              : <code>{mode}</code>}
        </strong>{' '}
        The token is whatever the device wrote, kept verbatim (DR-096 read side).
      </p>
      <p className="field-note">{STP_FAR_END_NOTE}</p>
      <form onSubmit={onModePreview}>
        <div className="field-row">
          <div>
            <label htmlFor="stpg-mode">Target mode</label>
            <select id="stpg-mode" name="stpg-mode" value={selectedMode} onChange={(event) => onModeChange(event.target.value)} disabled={!canAct || busy}>
              <option value="">— choose a mode —</option>
              {STP_GLOBAL_MODES.map((value) => <option key={value} value={value}>{MODE_OPTION_COPY[value]}</option>)}
            </select>
          </div>
        </div>
        {selectedMode === 'rapid-pvst' && <p className="notice notice-warning" role="status">{stpRapidPvstDisclosure()}</p>}
        {modeError !== undefined && <p className="notice notice-error" role="alert">{modeError}</p>}
        <div className="review-actions">
          <button className="primary-button" type="submit" disabled={!canAct || busy}>Stage mode change</button>
        </div>
      </form>
    </section>

    {/* MST region — configured block, read from the chunked running-config (soft) */}
    <section className="panel" aria-labelledby="stpg-region-title">
      <div className="panel-heading">
        <div><p className="eyebrow">CONFIGURED</p><h3 id="stpg-region-title">MST region (`spanning-tree mst configuration`)</h3></div>
        <span className="panel-index">{regionUnavailable === true ? 'unread' : !regionKnown ? 'reading…' : region === undefined ? 'no block' : `${String(region.instances.length)} instance(s)`}</span>
      </div>
      {regionUnavailable === true && <p className="field-note">{regionUnavailableNote}</p>}
      {regionUnavailable !== true && !regionKnown && <p className="notice" role="status">Reading the running-config region block…</p>}
      {regionUnavailable !== true && regionKnown && region === undefined && (
        <p className="field-note">No MST region is configured — the running-config carries no <code>spanning-tree mst configuration</code> section. The form below stages the first block.</p>
      )}
      {region !== undefined && <>
        <p className="field-note">
          Region name: <strong>{region.name === undefined ? '(no `name` line)' : <code>{region.name}</code>}</strong>, revision:{' '}
          <strong>{region.revision === undefined ? '(no `revision` line)' : <code>{region.revision}</code>}</strong>. Tokens are the device&#39;s own, verbatim.
          {region.unmodelledLines > 0 && <> This block also carries <strong>{String(region.unmodelledLines)}</strong> line(s) this screen does not model — they are left untouched by anything staged here.</>}
        </p>
        {region.instances.length === 0
          ? <p className="field-note">The block configures no `instance … vlan …` mappings.</p>
          : <DataTable columns={configuredInstanceColumns} rows={region.instances} rowKey={(row) => row.id} label="Configured MST instance-to-VLAN mappings" />}
      </>}

      {/* Region edit form — stages the parent + only the changed/added/removed lines. Removal of a
          read mapping rides the capture-backed bare `no instance <id>` (rea-q2). */}
      <form onSubmit={onRegionPreview}>
        <div className="field-row">
          <div>
            <label htmlFor="stpg-region-name">Region name (leave blank to leave unchanged)</label>
            <input id="stpg-region-name" name="stpg-region-name" type="text" value={regionName} onChange={(event) => onRegionNameChange(event.target.value)} disabled={regionFormDisabled} maxLength={32} />
          </div>
          <div>
            <label htmlFor="stpg-region-revision">Revision 1-65535 (leave blank to leave unchanged)</label>
            <input id="stpg-region-revision" name="stpg-region-revision" type="text" inputMode="numeric" value={regionRevision} onChange={(event) => onRegionRevisionChange(event.target.value)} disabled={regionFormDisabled} maxLength={5} />
          </div>
        </div>
        <fieldset disabled={regionFormDisabled}>
          <legend>Add an instance-to-VLAN mapping</legend>
          <div className="field-row">
            <div>
              <label htmlFor="stpg-instance-id">Instance id 0-64</label>
              <input id="stpg-instance-id" name="stpg-instance-id" type="text" inputMode="numeric" value={instanceIdDraft} onChange={(event) => onInstanceIdDraftChange(event.target.value)} disabled={regionFormDisabled} maxLength={2} />
            </div>
            <div>
              <label htmlFor="stpg-instance-vlans">VLANs (comma list or A-B spans, e.g. 100,110)</label>
              <input id="stpg-instance-vlans" name="stpg-instance-vlans" type="text" value={instanceVlansDraft} onChange={(event) => onInstanceVlansDraftChange(event.target.value)} disabled={regionFormDisabled} />
            </div>
            <button className="quiet-button" type="button" onClick={onAddInstanceRow} disabled={regionFormDisabled}>Add row</button>
          </div>
        </fieldset>
        {instanceRows.length > 0 && <ul className="stp-draft-rows" aria-label="Instance mapping rows staged by this form">
          {instanceRows.map((row, index) => (
            <li key={`${row.id}-${row.vlans}`}>
              <code>instance {row.id} vlan {row.vlans}</code>{' '}
              <button className="quiet-button" type="button" onClick={() => onRemoveInstanceRow(index)} disabled={regionFormDisabled}>Remove from draft</button>
            </li>
          ))}
        </ul>}
        {removeInstanceIds.length > 0 && (
          <p className="notice" role="status">
            Marked for removal: {removeInstanceIds.map((id) => <code key={id}>{`no instance ${id}`}</code>)}{' '}
            — staged as the bare <code>no instance &lt;id&gt;</code> line (hardware capture
            2026-11-22, DR-159; first proven on the cEOS grammar lane, rea-q2).
          </p>
        )}
        <p className="field-note">
          Staging sends <code>spanning-tree mst configuration</code> plus only the lines you changed,
          added, or marked for removal — the capture-pinned spellings (<code>name</code> /{' '}
          <code>revision</code> / <code>instance 1 vlan 100,110</code>, hardware batch{' '}
          <code>unblock-stp-mst-region-grammar</code>; <code>no instance &lt;id&gt;</code>,{' '}
          <code>unblock-grammar-ceos.json</code>). The device diff decides what the block keeps.
        </p>
        {regionError !== undefined && <p className="notice notice-error" role="alert">{regionError}</p>}
        <div className="review-actions">
          <button className="primary-button" type="submit" disabled={regionFormDisabled}>Stage region edit</button>
        </div>
      </form>
    </section>

    {/* Staged review panel — the standing pattern; commit/abort live in Transaction Center only */}
    {notice !== '' && <p className="notice notice-success operation-result" role="status">{notice}</p>}
    {failure !== '' && <div className="notice notice-error operation-result" role="alert"><strong>The device did not take that.</strong><p>{failure}</p></div>}
    <p className="field-note">The forms above only stage into the shared transaction — nothing on this screen commits or aborts (issue #141: the Transaction Center owns those).</p>
  </section>
}
