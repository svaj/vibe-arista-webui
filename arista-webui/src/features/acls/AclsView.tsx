/**
 * S13 (#83): the presentation half of the ACL screen. Pure props, matching `NtpView` /
 * `SystemSettingsView` — every device string arrives already composed by the container, and nothing
 * here contacts a device.
 *
 * ## What this screen is, said out loud
 *
 * Everything below is **running-config text** read through `node.acls.standard.getAll()` /
 * `node.acls.extended.getAll()` (the parsed `ip access-list …` sections), and the header copy says so.
 * It never claims a device state: no rule has matched traffic, no ACL is applied anywhere, and nothing
 * is committed until the device answers.
 *
 * Two gaps are rendered as statements rather than hidden:
 *
 * - {@link COUNTER_GAP} is the counters panel's hint, because `show access-lists` has no capture for
 *   this target. No table on this screen carries a hit/counter column — a test pins the `<th>` set.
 * - {@link REFERENCE_GAP} is the delete acknowledgement's body text, verbatim, and the staged risks and
 *   the commit confirm repeat it. The screen cannot read `ip access-group`, so it never claims it
 *   checked whether an interface still applies the ACL.
 *
 * ## Edit/refuse, and read-only rules
 *
 * A rule carrying an operator (`eq 161`) or an option tail (`ttl eq 1 tracked`) is shown exactly as
 * configured, its Edit control stays refused, and the reason from `ruleReproducibility` is listed under
 * that ACL. The line remains readable; only a writable rule is editable.
 *
 * Every table goes through the F3 {@link DataTable} primitive (`<th scope="col">`, `.table-scroll`);
 * hand-rolled data tables are banned in this wave.
 */
import type { FormEvent } from 'react'
import type { ReactElement } from 'react'
import type { AclType } from '@devhax-heavy-industries/arista-eapi'

import { ConnectionHeader } from '../../components/ui/ConnectionHeader'
import type { ConnectionState } from '../../components/ui/ConnectionHeader'
import { DataTable } from '../../components/ui/DataTable'
import type { DataTableColumn } from '../../components/ui/DataTable'
import { EmptyState } from '../../components/ui/EmptyState'
import { StatePill } from '../../components/ui/StatePill'
import { COUNTER_GAP, DESTINATION_MODES, MATCH_MODES, REFERENCE_GAP } from './acl-rules'
import type { MatchDraft, MatchMode, RuleDraft } from './acl-rules'

/** One rule of one ACL, every field already composed into display text by the container. */
export interface AclEntryRowView {
  readonly type: AclType
  readonly aclName: string
  readonly seqno: number
  /** The whole rule as the config writes it (`ruleLine`). */
  readonly line: string
  readonly action: string
  /** `''` on a standard rule: that kind has no protocol field. */
  readonly protocol: string
  readonly source: string
  /** `''` on a standard rule: that kind has no destination field. */
  readonly destination: string
  /** `log` plus any remainder the client stores in `options`. Config text, never a counter. */
  readonly flags: string
  /** False when the client's entry verbs cannot re-emit this line, so Edit stays refused. */
  readonly editable: boolean
  onEdit: (type: AclType, name: string, seqno: number) => void
  onRemove: (type: AclType, name: string, seqno: number) => void
}

/** One access list as a block: its header line, its rules, and the read-only notes under it. */
export interface AclBlockView {
  readonly type: AclType
  readonly name: string
  /** The section header the client reads and writes: `ip access-list [standard] <name>`. */
  readonly header: string
  readonly ruleCount: number
  readonly entries: readonly AclEntryRowView[]
  /** One entry per non-reproducible rule: why that rule's Edit is refused, verbatim from the rules module. */
  readonly readonlyNotes: readonly string[]
}

/** The ACL the operator asked to delete, waiting on the acknowledgement that gates Preview. */
export interface DeletePendingView {
  readonly type: AclType
  readonly name: string
  readonly header: string
  readonly ruleCount: number
  readonly ack: boolean
  onAckChange: (next: boolean) => void
  onPreview: () => void
  onCancel: () => void
}

/** The add/replace-rule form. Add offers a sequence number; replace keeps the number it edits. */
export interface RuleFormView {
  /** `add` stages `[header, line, exit]`; `replace` stages `[header, no <seq>, <seq> line, exit]`. */
  readonly mode: 'add' | 'replace'
  /** The ACL this form writes into; the kind decides protocol/destination and the header line. */
  readonly type: AclType
  readonly name: string
  readonly draft: RuleDraft
  readonly error?: string
  onDraftChange: (next: RuleDraft) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onCancel: () => void
}

/** The staged named session, shown between preview and commit (the same shape as `NtpDraftView`). */
export interface AclDraftView {
  readonly sessionName: string
  readonly effectLabel: string
  readonly batch: readonly string[]
  readonly risks: readonly string[]
  /** `undefined` while the device `diff()` has not come back yet. */
  readonly diff?: string
  readonly canCommit: boolean
  readonly destructive: boolean
}

export interface AclsViewProps {
  readonly state: 'loading' | 'ready' | 'failed'
  readonly readError?: string
  readonly proxyPrompt?: string

  /** False until that read answered — an unread list must never render as "confirmed empty". */
  readonly standardKnown: boolean
  readonly extendedKnown: boolean
  readonly standard: readonly AclBlockView[]
  readonly extended: readonly AclBlockView[]

  readonly createNameDraft: string
  readonly createType: AclType
  readonly createError?: string
  onCreateNameChange: (value: string) => void
  onCreateTypeChange: (value: AclType) => void
  onCreateSubmit: (event: FormEvent<HTMLFormElement>) => void

  readonly addRuleForm?: RuleFormView
  readonly replaceRuleForm?: RuleFormView
  readonly deletePending?: DeletePendingView
  readonly draft?: AclDraftView

  readonly onAddRule: (type: AclType, name: string) => void
  readonly onDeleteAcl: (type: AclType, name: string) => void
  readonly onCommitDraft: () => void
  readonly onAbortDraft: () => void
  readonly onReload: () => void

  readonly busy: boolean
  readonly canAct: boolean
  readonly notice: string
  readonly failure: string
  readonly connection: ConnectionState
  readonly connectionLabel: string
}

/** A kind-less field is a shape fact, not missing data — the cell says which. */
const notOnKind = <em>not on this kind</em>
const nothingWritten = <em>nothing written</em>

/**
 * The rule-table column set, declared here so the screen and its test agree. There is deliberately no
 * hit/counter column anywhere ({@link COUNTER_GAP}): `Log / options` is configured text only.
 */
export const ENTRY_COLUMNS: readonly string[] = ['Seq', 'Action', 'Protocol', 'Source', 'Destination', 'Log / options', 'Rule line', 'Actions']

/** The per-kind ACL list column set. Same rule: no statistics column exists. */
export const ACL_COLUMNS: readonly string[] = ['ACL', 'Header line', 'Rules', 'Actions']

export function AclsView(props: AclsViewProps): ReactElement {
  const {
    state,
    readError,
    proxyPrompt,
    standardKnown,
    extendedKnown,
    standard,
    extended,
    createNameDraft,
    createType,
    createError,
    onCreateNameChange,
    onCreateTypeChange,
    onCreateSubmit,
    addRuleForm,
    replaceRuleForm,
    deletePending,
    draft,
    onAddRule,
    onDeleteAcl,
    onCommitDraft,
    onAbortDraft,
    onReload,
    busy,
    canAct,
    notice,
    failure,
    connection,
    connectionLabel,
  } = props

  // F3 (#65) is the only table shape in this wave: both tables are built from DataTable so the
  // `<th scope="col">` + `.table-scroll` markup stays identical everywhere.
  const aclColumns: readonly DataTableColumn<AclBlockView>[] = [
    { header: ACL_COLUMNS[0], cell: (row) => <code>{row.name}</code> },
    { header: ACL_COLUMNS[1], cell: (row) => <code>{row.header}</code> },
    { header: ACL_COLUMNS[2], numeric: true, cell: (row) => row.ruleCount },
    {
      header: ACL_COLUMNS[3],
      cell: (row) => <>
        <button className="quiet-button" type="button" onClick={() => { onAddRule(row.type, row.name) }} disabled={!canAct || busy}>Add rule to {row.name}</button>
        {' '}
        <button className="danger-button" type="button" onClick={() => { onDeleteAcl(row.type, row.name) }} disabled={!canAct || busy}>Delete ACL {row.name}</button>
      </>,
    },
  ]

  const entryColumns: readonly DataTableColumn<AclEntryRowView>[] = [
    { header: ENTRY_COLUMNS[0], numeric: true, cell: (row) => row.seqno },
    { header: ENTRY_COLUMNS[1], cell: (row) => <StatePill value={row.action} /> },
    { header: ENTRY_COLUMNS[2], cell: (row) => (row.protocol === '' ? notOnKind : <code>{row.protocol}</code>) },
    { header: ENTRY_COLUMNS[3], cell: (row) => <code>{row.source}</code> },
    { header: ENTRY_COLUMNS[4], cell: (row) => (row.destination === '' ? notOnKind : <code>{row.destination}</code>) },
    { header: ENTRY_COLUMNS[5], cell: (row) => (row.flags === '' ? nothingWritten : <code>{row.flags}</code>) },
    { header: ENTRY_COLUMNS[6], cell: (row) => <code>{row.line}</code> },
    {
      header: ENTRY_COLUMNS[7],
      cell: (row) => <>
        {/* A refused rule keeps its Edit control disabled and the reason lands in the note list below the table. */}
        <button className="quiet-button" type="button" onClick={() => { row.onEdit(row.type, row.aclName, row.seqno) }} disabled={!canAct || busy || !row.editable || draft !== undefined}>Edit rule {row.seqno}</button>
        {' '}
        <button className="danger-button" type="button" onClick={() => { row.onRemove(row.type, row.aclName, row.seqno) }} disabled={!canAct || busy}>Remove rule {row.seqno}</button>
      </>,
    },
  ]

  return <section className="workspace" aria-labelledby="workspace-title">
    <div className="screen-connection">
      <ConnectionHeader
        state={connection}
        {...(connection === 'connected' ? { connectedLabel: connectionLabel } : {})}
        {...(connection === 'connecting' ? { connectingLabel: connectionLabel } : {})}
        {...(connection === 'error' ? { errorLabel: connectionLabel } : {})}
      />
    </div>

    <div className="workspace-heading">
      <div>
        <p className="eyebrow">ACCESS LISTS</p>
        <h2 id="workspace-title">ACLs</h2>
      </div>
      <button className="quiet-button" type="button" onClick={onReload} disabled={!canAct || busy}>Reload device state</button>
    </div>

    {proxyPrompt !== undefined && <div className="notice notice-error" role="alert"><strong>Local proxy is not configured.</strong><p>{proxyPrompt}</p></div>}

    <p className="notice notice-warning" role="status">
      This screen edits <strong>access lists exactly as the running-config writes them</strong>, read from the parsed
      <code> ip access-list [standard] &lt;name&gt;</code> sections — it is <strong>not</strong> a view of live packet
      filtering, and it claims no device state beyond that config text. Writes stage a named config session, show the
      device&#39;s own <code>diff()</code>, then commit to running-config only (startup-config is never written,
      DR-024). The guards here mirror what <em>this client</em> composes and refuses (DR-057); the device keeps the
      final say — a line this client staged but the CLI rejects returns as the device&#39;s own <code>CommandError</code>.
    </p>

    {state === 'loading' && <p className="notice" role="status">Reading the running-config (access lists come from the parsed config sections)…</p>}
    {readError !== undefined && <div className="notice notice-error" role="alert"><strong>The ACL read failed.</strong><p>{readError}</p><button className="quiet-button" type="button" onClick={onReload} disabled={busy}>Try again</button></div>}

    {/* Create one access list */}
    <section className="panel" aria-labelledby="acl-create-title">
      <div className="panel-heading">
        <div><p className="eyebrow">CONFIGURED SECTIONS</p><h3 id="acl-create-title">Create an access list</h3></div>
        <span className="panel-index">header line</span>
      </div>
      <form onSubmit={onCreateSubmit}>
        <label htmlFor="acl-create-name">ACL name</label>
        <input
          id="acl-create-name"
          name="acl-create-name"
          value={createNameDraft}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => { onCreateNameChange(event.target.value) }}
          disabled={!canAct || busy}
        />
        <label htmlFor="acl-create-type">Kind</label>
        <select id="acl-create-type" name="acl-create-type" value={createType} onChange={(event) => { onCreateTypeChange(event.target.value as AclType) }} disabled={!canAct || busy}>
          <option value="standard">standard — `ip access-list standard &lt;name&gt;`</option>
          <option value="extended">extended — `ip access-list &lt;name&gt;`</option>
        </select>
        <p className="field-note">
          The kind is the whole difference: it decides the header line the client writes and whether a rule may carry
          a protocol and a destination. Inner whitespace in a name stays legal (this client creates such a section and
          reads the same key back), while an empty or padded name is refused in-form because the section key could not
          read back as typed.
        </p>
        <div className="review-actions">
          <button className="primary-button" type="submit" disabled={!canAct || busy || createNameDraft.trim() === ''}>Create ACL</button>
        </div>
      </form>
      {createError !== undefined && <p className="notice notice-error" role="alert">{createError}</p>}
    </section>

    <AclKindSection kind="standard" known={standardKnown} blocks={standard} aclColumns={aclColumns} entryColumns={entryColumns} />
    <AclKindSection kind="extended" known={extendedKnown} blocks={extended} aclColumns={aclColumns} entryColumns={entryColumns} />

    {addRuleForm !== undefined && <RuleFormPanel form={addRuleForm} mode="add" busy={busy} canAct={canAct} />}
    {replaceRuleForm !== undefined && <RuleFormPanel form={replaceRuleForm} mode="replace" busy={busy} canAct={canAct} />}

    {/* Deletion: always destructive, always acknowledged, because references cannot be read from here */}
    {deletePending !== undefined && <section className="panel" aria-labelledby="acl-delete-title">
      <div className="panel-heading">
        <div><p className="eyebrow">DELETION</p><h3 id="acl-delete-title">Delete <code>{deletePending.name}</code></h3></div>
        <span className="panel-index">always destructive</span>
      </div>
      <p className="field-note">
        Staged line: <code>{`no ${deletePending.header}`}</code>. That takes out the whole section — header and all
        {' '}{deletePending.ruleCount.toString()} configured rule(s) — exactly the negation the client&#39;s
        <code> delete</code> verb composes.
      </p>
      <p className="notice notice-error" role="status" id="acl-delete-gap">{REFERENCE_GAP}</p>
      <p id="acl-delete-ack-help" className="field-note">The box gates Preview: check it to enable the button, then review the device&#39;s own <code>diff()</code>, then confirm the commit that repeats this text. Abort discards the staged line.</p>
      <label className="field-note" htmlFor="acl-delete-ack">
        <input
          id="acl-delete-ack"
          name="acl-delete-ack"
          type="checkbox"
          checked={deletePending.ack}
          onChange={(event) => { deletePending.onAckChange(event.target.checked) }}
          aria-describedby="acl-delete-gap acl-delete-ack-help"
          disabled={!canAct || busy}
        />
        {' '}I accept that this screen did <strong>not</strong> check whether any interface still applies <code>{deletePending.name}</code>.
      </label>
      <div className="review-actions">
        <button className="danger-button" type="button" onClick={deletePending.onPreview} disabled={!canAct || busy || !deletePending.ack}>Preview deletion of {deletePending.name}</button>
        {' '}
        <button className="quiet-button" type="button" onClick={deletePending.onCancel} disabled={busy}>Cancel deletion</button>
      </div>
    </section>}

    {/* The counter half stays closed, and says so (#83 CAPTURES gate) */}
    <section className="panel" aria-labelledby="acl-counters-title">
      <div className="panel-heading">
        <div><p className="eyebrow">COUNTERS</p><h3 id="acl-counters-title">Live rule statistics</h3></div>
        <span className="panel-index">not captured</span>
      </div>
      <EmptyState
        heading="Matched-packet statistics are unknown — not captured."
        hint={COUNTER_GAP}
      />
    </section>

    {/* Staged review panel */}
    {draft !== undefined && <section className="panel" aria-labelledby="acl-draft-title">
      <div className="panel-heading">
        <div><p className="eyebrow">NAMED SESSION {draft.sessionName}</p><h3 id="acl-draft-title">Staged: {draft.effectLabel}</h3></div>
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
        {' '}
        <button className="quiet-button" type="button" onClick={onAbortDraft} disabled={busy}>Abort staged changes</button>
      </div>
    </section>}

    {notice !== '' && <p className="notice notice-success operation-result" role="status">{notice}</p>}
    {failure !== '' && <div className="notice notice-error operation-result" role="alert"><strong>The device did not take that.</strong><p>{failure}</p></div>}
  </section>
}

interface AclKindSectionProps {
  readonly kind: AclType
  readonly known: boolean
  readonly blocks: readonly AclBlockView[]
  readonly aclColumns: readonly DataTableColumn<AclBlockView>[]
  readonly entryColumns: readonly DataTableColumn<AclEntryRowView>[]
}

/** One kind: the ACLs of that kind, then each ACL's rules in device document order. */
function AclKindSection({ kind, known, blocks, aclColumns, entryColumns }: AclKindSectionProps): ReactElement {
  const id = `acl-${kind}-title`
  return <section className="panel" aria-labelledby={id}>
    <div className="panel-heading">
      <div><p className="eyebrow">{kind}</p><h3 id={id}>{kind === 'standard' ? 'Standard access lists' : 'Extended access lists'}</h3></div>
      <span className="panel-index">{!known ? 'unread' : blocks.length === 0 ? 'none' : blocks.length.toString().padStart(2, '0')}</span>
    </div>
    {!known
      ? <p className="field-note">No {kind} read has answered yet, so the {kind} list is unknown — not empty.</p>
      : blocks.length === 0
        ? <EmptyState heading={`No ${kind} access lists are configured.`} hint="An empty list is a normal configured state, not an error. Create one above to add the first section of this kind." />
        : <>
          <DataTable columns={aclColumns} rows={blocks} rowKey={(row) => row.name} label={`${kind === 'standard' ? 'Standard' : 'Extended'} access lists in the running-config`} />
          {blocks.map((block) => <div className="panel" key={`${block.type}-${block.name}`}>
            <div className="panel-heading">
              <div><p className="eyebrow">RULES</p><h4 id={`acl-entries-${block.type}-${block.name}`}>Rules in <code>{block.name}</code></h4></div>
              <span className="panel-index">{block.ruleCount === 0 ? 'none' : block.ruleCount.toString().padStart(2, '0')}</span>
            </div>
            <p className="field-note">The header line of this section is in the table above; the rules below are that block&#39;s own lines, in the order the running-config has them.</p>
            {block.entries.length === 0
              ? <EmptyState heading="This access list has no rules." hint="A section header with no body is what the client reads back as an empty entry map. Add a rule to make it filter anything." />
              : <DataTable columns={entryColumns} rows={block.entries} rowKey={(row) => row.seqno} label={`Rules of the ${kind} access list ${block.name}`} />}
            {block.readonlyNotes.length > 0 && <ul className="ref-list" aria-label={`Rules of ${block.name} this screen cannot rewrite`}>
              {block.readonlyNotes.map((note) => <li key={note}><span>{note}</span></li>)}
            </ul>}
          </div>)}
        </>}
  </section>
}

interface RuleFormPanelProps {
  readonly form: RuleFormView
  readonly mode: 'add' | 'replace'
  readonly busy: boolean
  readonly canAct: boolean
}

/** One side of a rule: the arms the client writes, plus only the fields the chosen arm needs. */
function MatchFields(props: {
  readonly side: 'source' | 'destination'
  readonly idPrefix: string
  readonly extended: boolean
  readonly locked: boolean
  readonly value: MatchDraft
  readonly onChange: (patch: Partial<MatchDraft>) => void
}): ReactElement {
  const { side, idPrefix, extended, locked, value, onChange } = props
  const id = `${idPrefix}-${side}`
  const label = side === 'source' ? 'Source' : 'Destination'
  const modes = side === 'source' ? MATCH_MODES : DESTINATION_MODES
  return <>
    <label htmlFor={`${id}-mode`}>{label} form</label>
    <select id={`${id}-mode`} name={`${id}-mode`} value={value.mode} onChange={(event) => { onChange({ mode: event.target.value as MatchMode }) }} disabled={locked}>
      {/* The wildcard arm exists only where the client writes it: a standard source. On the extended
          side its own reader would take the mask token for the destination, so the arm is not offered. */}
      {modes
        .filter((arm) => arm.value === 'untouched' || (extended ? !arm.standardOnly : true))
        .map((arm) => <option key={arm.value} value={arm.value}>{arm.label}</option>)}
    </select>
    {value.mode !== 'any' && value.mode !== 'untouched' && <>
      <label htmlFor={`${id}-address`}>{label} address (dotted quad)</label>
      <input
        id={`${id}-address`}
        name={`${id}-address`}
        value={value.address}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => { onChange({ address: event.target.value }) }}
        disabled={locked}
      />
    </>}
    {value.mode === 'prefix' && <>
      <label htmlFor={`${id}-length`}>{label} prefix length (0..32)</label>
      <input
        id={`${id}-length`}
        name={`${id}-length`}
        value={value.prefixlen}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => { onChange({ prefixlen: event.target.value }) }}
        disabled={locked}
      />
    </>}
    {value.mode === 'wildcard' && <>
      <label htmlFor={`${id}-mask`}>{label} wildcard mask (kept exactly as written)</label>
      <input
        id={`${id}-mask`}
        name={`${id}-mask`}
        value={value.mask}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => { onChange({ mask: event.target.value }) }}
        disabled={locked}
      />
      <p className="field-note">The client keeps a wildcard as the config wrote it and never converts it: its own mask helper counts <em>netmask</em> bits, so <code>0.0.255.255</code> would read back as one host (resources/acl.ts, divergence 2).</p>
    </>}
  </>
}

/**
 * The rule form. Both modes stage through the same named-session preview path; the difference is only
 * the line order the client's verb uses (`addEntry` appends, `updateEntry` negates the old number first).
 */
function RuleFormPanel({ form, mode, busy, canAct }: RuleFormPanelProps): ReactElement {
  const { draft, type, name, error, onDraftChange, onSubmit, onCancel } = form
  const extended = type === 'extended'
  const idPrefix = `acl-${mode}-rule`
  const locked = !canAct || busy

  const set = (patch: Partial<RuleDraft>): void => { onDraftChange({ ...draft, ...patch }) }
  const setMatch = (side: 'source' | 'destination') => (patch: Partial<MatchDraft>): void => {
    onDraftChange({ ...draft, [side]: { ...draft[side], ...patch } })
  }

  return <section className="panel" aria-labelledby={`${idPrefix}-title`}>
    <div className="panel-heading">
      <div>
        <p className="eyebrow">{extended ? 'EXTENDED RULE' : 'STANDARD RULE'}</p>
        <h3 id={`${idPrefix}-title`}>{mode === 'add' ? `Add a rule to ${name}` : `Replace rule ${draft.seqno} in ${name}`}</h3>
      </div>
      <span className="panel-index">{extended ? '2 matches' : '1 match'}</span>
    </div>
    <p className="field-note">
      {mode === 'add'
        ? <>The staged batch is the section header, then the rule line, then <code>exit</code>. No sequence number means the <strong>device</strong> numbers the rule — this client computes none client-side, and neither does this form.</>
        : <>The staged batch is the section header, then <code>{`no ${draft.seqno}`}</code>, then the replacement line carrying {draft.seqno}, then <code>exit</code> — upstream&#39;s order verbatim, which is why the number cannot change here.</>}
    </p>
    <form onSubmit={onSubmit}>
      <label htmlFor={`${idPrefix}-action`}>Action</label>
      <select id={`${idPrefix}-action`} name={`${idPrefix}-action`} value={draft.action} onChange={(event) => { set({ action: event.target.value as RuleDraft['action'] }) }} disabled={locked}>
        <option value="">(choose permit or deny)</option>
        <option value="permit">permit</option>
        <option value="deny">deny</option>
      </select>
      {extended && <>
        <label htmlFor={`${idPrefix}-protocol`}>Protocol token</label>
        <input
          id={`${idPrefix}-protocol`}
          name={`${idPrefix}-protocol`}
          value={draft.protocol}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => { set({ protocol: event.target.value }) }}
          disabled={locked}
        />
        <p className="field-note">One token, as the client's grammar reads it: <code>ip</code>, <code>tcp</code>, <code>udp</code>, <code>icmp</code> or a decimal protocol number such as <code>47</code>. A standard rule has no protocol field, so this form does not show one there.</p>
      </>}
      {mode === 'add' && <>
        <label htmlFor={`${idPrefix}-seqno`}>Sequence number (blank lets the device number the rule)</label>
        <input
          id={`${idPrefix}-seqno`}
          name={`${idPrefix}-seqno`}
          value={draft.seqno}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => { set({ seqno: event.target.value }) }}
          disabled={locked}
        />
        <p className="field-note">Digits only. A number the listing already shows is refused here: the client's own reader reports a duplicated sequence number rather than picking one, so staging a clash would leave this ACL unreadable.</p>
      </>}
      <MatchFields side="source" idPrefix={idPrefix} extended={extended} locked={locked} value={draft.source} onChange={setMatch('source')} />
      {extended && <MatchFields side="destination" idPrefix={idPrefix} extended={extended} locked={locked} value={draft.destination} onChange={setMatch('destination')} />}
      <label className="field-note" htmlFor={`${idPrefix}-log`}>
        <input
          id={`${idPrefix}-log`}
          name={`${idPrefix}-log`}
          type="checkbox"
          checked={draft.log}
          onChange={(event) => { set({ log: event.target.checked }) }}
          disabled={locked}
        />
        {' '}Append <code>log</code> — the only trailing token this client writes.
      </label>
      <p className="field-note">
        Port operators (<code>eq 161</code>, <code>range 1024 2048</code>) and option tails
        (<code>ttl eq 1 tracked</code>) are deliberately not fields here: the client reads them into the record and
        never writes them back, so this screen composes no line that carries them and refuses to rewrite a rule that
        has one.
      </p>
      <div className="review-actions">
        <button className="primary-button" type="submit" disabled={locked}>{mode === 'add' ? `Preview add rule to ${name}` : `Preview replace rule ${draft.seqno}`}</button>
        {' '}
        <button className="quiet-button" type="button" onClick={onCancel} disabled={busy}>Cancel rule form</button>
      </div>
    </form>
    {error !== undefined && <p className="notice notice-error" role="alert">{error}</p>}
  </section>
}
