/**
 * #87 (route-map slice): the presentation half of the route-map clause editor
 * (`#/routing/routemaps`). Pure props (the `VrrpManagerView`/`StpGlobalView` pattern); every
 * device string arrives as a plain value and no `RoutemapEntry`, `RoutemapEntryAttrs`,
 * `OspfState`, or `CommandSpec` crosses this boundary.
 *
 * ## What this view may claim
 *
 * - The configured clause table comes from the parsed running-config reader
 *   (`node.routemaps.getAll()`); the device-side count comes from the soft `show route-map` read.
 *   The two are separate panels and never merged (the S14/#84 convention).
 * - An empty table is a NORMAL ready state (the box runs zero route maps today), never an error;
 *   a failed HARD read renders the error wall, never a blank table.
 * - The references panel states only what the SOFT `ospf.get()` read established: which
 *   `redistribute … route-map <name>` lines name a map, "no reference this UI can see", or the
 *   named read-failure note. It never claims a map is inert as a measurement.
 * - The statement forms are free-text one-per-line lists prefilled from the read (owner intake
 *   2026-11-21: the keyword vocabulary is the device's answer, so no dropdown is invented).
 * - No commit/abort control exists anywhere on this screen (#141: the Transaction Center owns
 *   them); the five forms only stage.
 */
import type { FormEvent, ReactElement } from 'react'

import { ConnectionHeader } from '../../components/ui/ConnectionHeader'
import type { ConnectionState } from '../../components/ui/ConnectionHeader'
import { DataTable } from '../../components/ui/DataTable'
import type { DataTableColumn } from '../../components/ui/DataTable'
import { EmptyState } from '../../components/ui/EmptyState'
import { ROUTEMAP_EDITOR_STANDING_NOTE, routemapClauseTarget } from './routemap-rules'
import type { RoutemapClauseDraft, RoutemapManagerRow, RoutemapReference } from './routemap-rules'

/** One row's reference verdict, keyed by the picker's `<name>/<action>/<seqno>` value. */
export interface RoutemapRowReference {
  readonly target: string
  readonly name: string
  readonly reference: RoutemapReference
}

export interface RouteMapManagerViewProps {
  readonly state: 'loading' | 'ready' | 'failed'
  readonly readError?: string
  readonly proxyPrompt?: string
  readonly identity?: { hostname: string; version: string; model: string }

  /** True once the HARD `routemaps.getAll()` read resolved (distinguishes unread from empty). */
  readonly configKnown: boolean
  readonly rows: readonly RoutemapManagerRow[]
  readonly references: readonly RoutemapRowReference[]
  /** The soft `show route-map` device rows — absent while unread; the failure note renders. */
  readonly deviceRows?: readonly { name: string; clauseCount: string }[]
  readonly deviceCountFailure?: string

  /** True when the SOFT `ospf.get()` reference read FAILED — the panel mutes with the note. */
  readonly ospfReadFailed?: boolean
  readonly ospfReadNote?: string

  readonly createDraft: RoutemapClauseDraft
  readonly createError?: string
  readonly onCreateChange: (patch: Partial<RoutemapClauseDraft>) => void
  readonly onCreateSubmit: (event: FormEvent<HTMLFormElement>) => void

  readonly replaceDraft: { target: string; keyword: string; text: string }
  readonly replaceError?: string
  readonly onReplaceChange: (patch: { target?: string; keyword?: string; text?: string }) => void
  readonly onReplaceSubmit: (event: FormEvent<HTMLFormElement>) => void

  readonly descriptionDraft: { target: string; value: string }
  readonly descriptionError?: string
  readonly onDescriptionChange: (patch: { target?: string; value?: string }) => void
  readonly onDescriptionSubmit: (event: FormEvent<HTMLFormElement>) => void

  readonly continueDraft: { target: string; mode: string; value: string }
  readonly continueError?: string
  readonly onContinueChange: (patch: { target?: string; mode?: string; value?: string }) => void
  readonly onContinueSubmit: (event: FormEvent<HTMLFormElement>) => void

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

/** The reference verdict, stated in the table's own column — never a colour alone. */
function referenceText(reference: RoutemapReference): string {
  switch (reference.status) {
    case 'referenced': return `referenced (redistribute ${reference.protocols.join(' / ')})`
    case 'unreferenced': return 'no reference this UI can see'
    case 'unknown': return 'reference check unavailable'
  }
}

export function RouteMapManagerView(props: RouteMapManagerViewProps): ReactElement {
  const {
    state,
    readError,
    proxyPrompt,
    identity,
    configKnown,
    rows,
    references,
    deviceRows,
    deviceCountFailure,
    ospfReadFailed,
    ospfReadNote,
    createDraft,
    createError,
    onCreateChange,
    onCreateSubmit,
    replaceDraft,
    replaceError,
    onReplaceChange,
    onReplaceSubmit,
    descriptionDraft,
    descriptionError,
    onDescriptionChange,
    onDescriptionSubmit,
    continueDraft,
    continueError,
    onContinueChange,
    onContinueSubmit,
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

  const referenceByTarget = new Map(references.map((entry) => [entry.target, entry.reference]))
  const clauseOptions = rows.map((row) => routemapClauseTarget({ name: row.name, action: row.action as 'permit' | 'deny', seqno: row.seqno }))

  const clauseColumns: readonly DataTableColumn<RoutemapManagerRow>[] = [
    { header: 'Name', cell: (row) => <code>{row.name}</code> },
    { header: 'Action', cell: (row) => row.action },
    { header: 'Seq', cell: (row) => <code>{row.seqno}</code>, numeric: true },
    { header: 'Match statements', cell: (row) => row.matchStatements },
    { header: 'Set statements', cell: (row) => row.setStatements },
    { header: 'Continue', cell: (row) => row.continueValue },
    { header: 'Description', cell: (row) => row.description },
    { header: 'References', cell: (row) => {
      const reference = referenceByTarget.get(`${row.name}/${row.action}/${row.seqno}`)
      return reference === undefined ? '(unknown)' : referenceText(reference)
    } },
  ]

  const formsDisabled = !canAct || busy
  const noClauses = clauseOptions.length === 0

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
        <h2 id="workspace-title">Route maps</h2>
      </div>
      <button className="quiet-button" type="button" onClick={onReload} disabled={!canAct || busy}>Reload route-map state</button>
    </div>

    {proxyPrompt !== undefined && <div className="notice notice-error" role="alert"><strong>Local proxy is not configured.</strong><p>{proxyPrompt}</p></div>}

    <p className="notice notice-warning" role="status">{ROUTEMAP_EDITOR_STANDING_NOTE} <a href="#/routing">Routing status</a> shows the read-only device-side view.</p>

    {state === 'loading' && <p className="notice" role="status">Reading the configured route-map clauses (parsed running-config)…</p>}
    {readError !== undefined && <div className="notice notice-error" role="alert"><strong>The route-map table read failed.</strong><p>{readError}</p><button className="quiet-button" type="button" onClick={onReload} disabled={busy}>Try again</button></div>}

    {/* Configured clauses — the HARD parsed-config table, with the reference column */}
    <section className="panel" aria-labelledby="rmm-config-title">
      <div className="panel-heading">
        <div><p className="eyebrow">CONFIGURED (PARSED RUNNING-CONFIG)</p><h3 id="rmm-config-title">Clauses</h3></div>
        <span className="panel-index">{!configKnown ? 'unread' : rows.length === 0 ? 'none' : rows.length.toString().padStart(2, '0')}</span>
      </div>
      {!configKnown
        ? <p className="field-note">No <code>routemaps.getAll()</code> read has answered yet.</p>
        : rows.length === 0
          ? <EmptyState heading="No `route-map` section exists in the running-config." hint="A normal configured state — this unit runs zero route maps today. The Create form below stages the first clause; every line mirrors the client's own verb text." />
          : <DataTable columns={clauseColumns} rows={rows} rowKey={(row) => `${row.name}/${row.action}/${row.seqno}`} label="Configured route-map clauses" />}
      {ospfReadFailed === true && ospfReadNote !== undefined && <p className="field-note" role="status">{ospfReadNote}</p>}
      {ospfReadFailed !== true && rows.length > 0 && <p className="field-note">The <strong>References</strong> column states only what the <code>ospf.get()</code> read established — <code>redistribute … route-map &lt;name&gt;</code> lines. Interface-attached policies and BGP are invisible to this unit&#39;s reads, so "no reference this UI can see" is not a claim that none exists.</p>}
    </section>

    {/* Device side — the soft show count, never merged with config */}
    <section className="panel" aria-labelledby="rmm-device-title">
      <div className="panel-heading">
        <div><p className="eyebrow">DEVICE REPLY (SOFT SHOW READ)</p><h3 id="rmm-device-title">show route-map</h3></div>
        <span className="panel-index">{deviceCountFailure !== undefined ? 'no answer' : deviceRows === undefined ? 'unread' : `${String(deviceRows.length)} map(s)`}</span>
      </div>
      {deviceCountFailure !== undefined && <p className="field-note" role="status">{deviceCountFailure}</p>}
      {deviceCountFailure === undefined && deviceRows !== undefined && deviceRows.length === 0 && <p className="field-note">The <code>show route-map</code> answer carried an empty <code>routeMaps</code> container — the command runs (both targets answer it) and none are installed in the forwarding policy.</p>}
      {deviceRows !== undefined && deviceRows.length > 0 && <DataTable
        columns={[{ header: 'Map', cell: (row: { name: string; clauseCount: string }) => <code>{row.name}</code> }, { header: 'Clauses', cell: (row: { name: string; clauseCount: string }) => row.clauseCount, numeric: true }]}
        rows={deviceRows}
        rowKey={(row) => row.name}
        label="show route-map names"
      />}
    </section>

    {/* Create clause */}
    <section className="panel" aria-labelledby="rmm-create-title">
      <div className="panel-heading">
        <div><p className="eyebrow">WRITE (STAGES ONLY)</p><h3 id="rmm-create-title">Create a clause</h3></div>
      </div>
      <p className="field-note">One line: <code>route-map &lt;name&gt; &lt;permit|deny&gt; &lt;seqno&gt;</code> — the client&#39;s <code>create()</code> text (a clause comes into existence when the device is asked to configure it; the map name exists only through its clauses).</p>
      <form onSubmit={onCreateSubmit}>
        <div className="field-row">
          <div>
            <label htmlFor="rmm-create-name">Map name (one token, no spaces)</label>
            <input id="rmm-create-name" name="rmm-create-name" type="text" value={createDraft.name} onChange={(event) => onCreateChange({ name: event.target.value })} disabled={formsDisabled} maxLength={64} />
          </div>
          <div>
            <label htmlFor="rmm-create-action">Action</label>
            <select id="rmm-create-action" name="rmm-create-action" value={createDraft.action} onChange={(event) => onCreateChange({ action: event.target.value })} disabled={formsDisabled}>
              <option value="">— choose —</option>
              <option value="permit">permit</option>
              <option value="deny">deny</option>
            </select>
          </div>
          <div>
            <label htmlFor="rmm-create-seqno">Sequence number (digits)</label>
            <input id="rmm-create-seqno" name="rmm-create-seqno" type="text" inputMode="numeric" value={createDraft.seqno} onChange={(event) => onCreateChange({ seqno: event.target.value })} disabled={formsDisabled} maxLength={10} />
          </div>
        </div>
        {createError !== undefined && <p className="notice notice-error" role="alert">{createError}</p>}
        <div className="review-actions">
          <button className="primary-button" type="submit" disabled={formsDisabled}>Stage clause create</button>
        </div>
      </form>
    </section>

    {/* Replace match/set — the client's diff, prefilled from the read */}
    <section className="panel" aria-labelledby="rmm-replace-title">
      <div className="panel-heading">
        <div><p className="eyebrow">WRITE (STAGES ONLY)</p><h3 id="rmm-replace-title">Replace a clause&#39;s match or set statements</h3></div>
      </div>
      <p className="field-note">One statement per line, prefilled with what the read parsed. Staging sends the client&#39;s <strong>diff</strong> — <code>no {replaceDraft.keyword === 'set' ? 'set' : 'match'} &lt;removed&gt;</code> first (current order), then <code>{replaceDraft.keyword === 'set' ? 'set' : 'match'} &lt;added&gt;</code> (your order), each under its own <code>route-map …</code> header line. Deleting a line from the box removes that statement. Which keywords this SKU accepts is the device&#39;s answer (only <code>set community &lt;v:v&gt;</code> is hardware-proven here).</p>
      <form onSubmit={onReplaceSubmit}>
        <div className="field-row">
          <div>
            <label htmlFor="rmm-replace-target">Clause</label>
            <select id="rmm-replace-target" name="rmm-replace-target" value={replaceDraft.target} onChange={(event) => onReplaceChange({ target: event.target.value })} disabled={formsDisabled || noClauses}>
              <option value="">— choose a clause —</option>
              {clauseOptions.map((target) => <option key={target} value={target}>{target}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="rmm-replace-keyword">Statement list</label>
            <select id="rmm-replace-keyword" name="rmm-replace-keyword" value={replaceDraft.keyword} onChange={(event) => onReplaceChange({ keyword: event.target.value })} disabled={formsDisabled || noClauses}>
              <option value="">— choose —</option>
              <option value="match">match</option>
              <option value="set">set</option>
            </select>
          </div>
        </div>
        <div className="field-row">
          <div>
            <label htmlFor="rmm-replace-text">Statements (one per line — the whole list this clause should end with)</label>
            <textarea id="rmm-replace-text" name="rmm-replace-text" rows={5} value={replaceDraft.text} onChange={(event) => onReplaceChange({ text: event.target.value })} disabled={formsDisabled || replaceDraft.target === '' || replaceDraft.keyword === ''} />
          </div>
        </div>
        {replaceError !== undefined && <p className="notice notice-error" role="alert">{replaceError}</p>}
        <div className="review-actions">
          <button className="primary-button" type="submit" disabled={formsDisabled || noClauses || replaceDraft.target === '' || replaceDraft.keyword === ''}>Stage statement replace</button>
        </div>
      </form>
    </section>

    {/* Description — the clear-then-set pair, risks only */}
    <section className="panel" aria-labelledby="rmm-description-title">
      <div className="panel-heading">
        <div><p className="eyebrow">WRITE (STAGES ONLY)</p><h3 id="rmm-description-title">Set a clause description</h3></div>
      </div>
      <p className="field-note">Stages the client&#39;s clear-then-set pair (<code>no description</code> then <code>description &lt;value&gt;</code>, each under its own header) — the ordering the client&#39;s own test pins. A description changes no policy, so this form carries risks but no second confirm.</p>
      <form onSubmit={onDescriptionSubmit}>
        <div className="field-row">
          <div>
            <label htmlFor="rmm-description-target">Clause</label>
            <select id="rmm-description-target" name="rmm-description-target" value={descriptionDraft.target} onChange={(event) => onDescriptionChange({ target: event.target.value })} disabled={formsDisabled || noClauses}>
              <option value="">— choose a clause —</option>
              {clauseOptions.map((target) => <option key={target} value={target}>{target}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="rmm-description-value">New description</label>
            <input id="rmm-description-value" name="rmm-description-value" type="text" value={descriptionDraft.value} onChange={(event) => onDescriptionChange({ value: event.target.value })} disabled={formsDisabled || noClauses} maxLength={240} />
          </div>
        </div>
        {descriptionError !== undefined && <p className="notice notice-error" role="alert">{descriptionError}</p>}
        <div className="review-actions">
          <button className="primary-button" type="submit" disabled={formsDisabled || noClauses}>Stage description</button>
        </div>
      </form>
    </section>

    {/* Continue — set or clear */}
    <section className="panel" aria-labelledby="rmm-continue-title">
      <div className="panel-heading">
        <div><p className="eyebrow">WRITE (STAGES ONLY)</p><h3 id="rmm-continue-title">Set or clear a clause continue</h3></div>
      </div>
      <p className="field-note"><code>continue &lt;n&gt;</code> makes a matching clause fall through to the next sequence number — it changes evaluation order, so it carries the second confirm.</p>
      <form onSubmit={onContinueSubmit}>
        <div className="field-row">
          <div>
            <label htmlFor="rmm-continue-target">Clause</label>
            <select id="rmm-continue-target" name="rmm-continue-target" value={continueDraft.target} onChange={(event) => onContinueChange({ target: event.target.value })} disabled={formsDisabled || noClauses}>
              <option value="">— choose a clause —</option>
              {clauseOptions.map((target) => <option key={target} value={target}>{target}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="rmm-continue-mode">Operation</label>
            <select id="rmm-continue-mode" name="rmm-continue-mode" value={continueDraft.mode} onChange={(event) => onContinueChange({ mode: event.target.value })} disabled={formsDisabled || noClauses}>
              <option value="">— choose —</option>
              <option value="set">set a value</option>
              <option value="unset">clear it (`no continue`)</option>
            </select>
          </div>
          <div>
            <label htmlFor="rmm-continue-value">Continue value (positive integer)</label>
            <input id="rmm-continue-value" name="rmm-continue-value" type="text" inputMode="numeric" value={continueDraft.value} onChange={(event) => onContinueChange({ value: event.target.value })} disabled={formsDisabled || noClauses || continueDraft.mode !== 'set'} maxLength={10} />
          </div>
        </div>
        {continueError !== undefined && <p className="notice notice-error" role="alert">{continueError}</p>}
        <div className="review-actions">
          <button className="primary-button" type="submit" disabled={formsDisabled || noClauses}>Stage continue change</button>
        </div>
      </form>
    </section>

    {/* Delete — one clause, hard confirm */}
    <section className="panel" aria-labelledby="rmm-delete-title">
      <div className="panel-heading">
        <div><p className="eyebrow">WRITE (STAGES ONLY, DESTRUCTIVE)</p><h3 id="rmm-delete-title">Delete a clause</h3></div>
      </div>
      <p className="field-note">One top-level line: <code>no route-map &lt;name&gt; &lt;action&gt; &lt;seqno&gt;</code> — the client&#39;s <code>delete()</code> text. Deleting a name&#39;s LAST clause deletes the name; the Transaction Center runs a second confirm stating that and the reference status.</p>
      <form onSubmit={onDeleteSubmit}>
        <div className="field-row">
          <div>
            <label htmlFor="rmm-delete-target">Clause to delete</label>
            <select id="rmm-delete-target" name="rmm-delete-target" value={deleteTarget} onChange={(event) => onDeleteTargetChange(event.target.value)} disabled={formsDisabled || noClauses}>
              <option value="">— choose a clause —</option>
              {clauseOptions.map((target) => <option key={target} value={target}>{target}</option>)}
            </select>
          </div>
        </div>
        {deleteError !== undefined && <p className="notice notice-error" role="alert">{deleteError}</p>}
        <div className="review-actions">
          <button className="primary-button" type="submit" disabled={formsDisabled || noClauses}>Stage clause delete</button>
        </div>
      </form>
    </section>

    {/* Staged review panel — the standing pattern; commit/abort live in Transaction Center only */}
    {notice !== '' && <p className="notice notice-success operation-result" role="status">{notice}</p>}
    {failure !== '' && <div className="notice notice-error operation-result" role="alert"><strong>The device did not take that.</strong><p>{failure}</p></div>}
    <p className="field-note">The forms above only stage into the shared transaction — nothing on this screen commits or aborts (issue #141: the Transaction Center owns those).</p>
  </section>
}
