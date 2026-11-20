/**
 * S9 (#79): the presentation half of the transaction center — pure props, like every sibling view.
 * Device-origin text (session names, descriptions, diffs, normalised configlets) renders as JSX text
 * children (`<pre>` for multi-line), never HTML; session state is a text+colour `StatePill`; the
 * notice/alert/status live-region contract follows F2.
 */
import type { ReactElement } from 'react'

import { DataTable } from '../../components/ui/DataTable'
import type { DataTableColumn } from '../../components/ui/DataTable'
import { EmptyState } from '../../components/ui/EmptyState'
import { StatePill } from '../../components/ui/StatePill'
import type { StagedTransactionEntry } from './transaction'

export interface SessionRowView {
  readonly name: string
  readonly state: string
  readonly description: string
  /** The client-screen's honest reading of the row (incl. the armed-timer warning), text not colour. */
  readonly rowLabel: string
  readonly dangerous: boolean
  readonly timerNote?: string
  readonly instanceCount: number
}

export interface JournalRowView {
  readonly name: string
  readonly endpoint: string
  readonly startedAt: string
  readonly description?: string
}

export interface DraftView {
  readonly sessionName: string
  readonly entries: readonly StagedTransactionEntry[]
  readonly diff?: string
  readonly uncertainReason?: string
  readonly canCommit: boolean
}

export interface VerifyEntryView {
  readonly index: number
  readonly configlet: string
  readonly normalised?: string
  readonly missingAnswer: boolean
}

export interface TransactionCenterViewProps {
  readonly state: 'loading' | 'ready' | 'failed'
  readonly readError?: string
  readonly proxyPrompt?: string
  readonly sessions: readonly SessionRowView[]
  readonly endpoint: string
  readonly draftText: string
  readonly onDraftTextChange: (value: string) => void
  readonly onPreviewDraft: () => void
  readonly draft?: DraftView
  readonly onCommitDraft: () => void
  readonly onAbortDraft: () => void
  readonly onAbortSession: (name: string, label: string, timerNote?: string) => void
  readonly onRecovery: () => void
  readonly recoveryLines: readonly string[]
  readonly journalRows: readonly JournalRowView[]
  readonly journalLoaded: boolean
  readonly onReadJournal: () => void
  readonly journalError?: string
  readonly verifyText: string
  readonly onVerifyTextChange: (value: string) => void
  readonly onVerify: () => void
  readonly verifyLabel: string
  readonly verifyEntries?: readonly VerifyEntryView[]
  readonly verifyUnmatched?: number
  readonly verifyFormat?: string
  readonly busy: boolean
  readonly canAct: boolean
  readonly notice: string
  readonly failure: string
  readonly onReload: () => void
}

const journalColumns: readonly DataTableColumn<JournalRowView>[] = [
  { header: 'Session name', cell: (row) => <code>{row.name}</code> },
  { header: 'Endpoint', cell: (row) => <code>{row.endpoint}</code> },
  { header: 'Started (journal)', cell: (row) => row.startedAt },
  { header: 'Description', cell: (row) => row.description ?? '' },
]

export function TransactionCenterView({
  state,
  readError,
  proxyPrompt,
  sessions,
  endpoint,
  draftText,
  onDraftTextChange,
  onPreviewDraft,
  draft,
  onCommitDraft,
  onAbortDraft,
  onAbortSession,
  onRecovery,
  recoveryLines,
  journalRows,
  journalLoaded,
  onReadJournal,
  journalError,
  verifyText,
  onVerifyTextChange,
  onVerify,
  verifyLabel,
  verifyEntries,
  verifyUnmatched,
  verifyFormat,
  busy,
  canAct,
  notice,
  failure,
  onReload,
}: TransactionCenterViewProps): ReactElement {
  return <section className="workspace" aria-labelledby="workspace-title">
    <div className="workspace-heading">
      <div>
        <p className="eyebrow">CONFIG SESSIONS</p>
        <h2 id="workspace-title">Transaction center</h2>
      </div>
      <button className="quiet-button" type="button" onClick={onReload} disabled={!canAct || busy}>Refresh device + journal</button>
    </div>

    {proxyPrompt !== undefined && <div className="notice notice-error" role="alert"><strong>Local proxy is not configured.</strong><p>{proxyPrompt}</p></div>}

    <p className="notice notice-warning" role="status">
      The durable half of the transaction story (#89, B4) stays out: no startup-config writes
      (DR-024), no <code>configure replace</code>, no rollback verbs, no commit-timer editing. The
      cEOS-lab timer capture (<code>docs/evidence/commit-timer-persistence.ceos.json</code>) has
      since landed — its exits are abort-with-revert or letting the timer fire, and the physical
      persistence verbs still wait on an owner authorization decision — so this screen stays view,
      staged review, and confirm-gated abort. Persistence/rollback decisions that need per-platform
      evidence are tracked on #89.
    </p>

    {state === 'loading' && <p className="notice" role="status">Reading <code>show configuration sessions</code>…</p>}
    {readError !== undefined && <div className="notice notice-error" role="alert"><strong>The session read failed.</strong><p>{readError}</p></div>}

    <section className="panel" aria-labelledby="tx-sessions-title">
      <div className="panel-heading">
        <div><p className="eyebrow">DEVICE-REPORTED</p><h3 id="tx-sessions-title">Sessions on the switch</h3></div>
        <span className="panel-index">{sessions.length.toString().padStart(2, '0')}</span>
      </div>
      {state === 'ready' && sessions.length === 0 && <EmptyState heading="The device reports no configuration sessions." hint="A clean slate: no pending lock, nothing to abort." />}
      {sessions.length > 0 && <ul className="session-list" aria-label="Device configuration sessions">
        {sessions.map((session) => <li key={session.name}>
          <div>
            <strong>{session.name}</strong>
            <span><StatePill value={session.state} /> · {session.rowLabel}{session.description === '' ? '' : ` · “${session.description}”`}{session.instanceCount === 0 ? '' : ` · ${String(session.instanceCount)} instance(s)`}</span>
            {session.timerNote !== undefined && <span className="cell-note">{session.timerNote}</span>}
          </div>
          <button className="danger-button" type="button" disabled={!canAct || busy} onClick={() => { onAbortSession(session.name, session.rowLabel, ...(session.timerNote === undefined ? [] : [session.timerNote])) }}>Abort session {session.name}</button>
        </li>)}
      </ul>}
    </section>

    <section className="panel" aria-labelledby="tx-draft-title">
      <div className="panel-heading">
        <div><p className="eyebrow">STAGED REVIEW — RUNNING-CONFIG ONLY</p><h3 id="tx-draft-title">Draft a change, read its diff, decide</h3></div>
      </div>
      <label htmlFor="tx-draft-text">Config lines (one per line)</label>
      <textarea
        id="tx-draft-text"
        name="tx-draft-text"
        className="probe-commands"
        rows={6}
        value={draftText}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => { onDraftTextChange(event.target.value) }}
        disabled={!canAct || busy || draft?.uncertainReason !== undefined}
      />
      <p className="field-note">
        The session name is generated by this client's sanitized generator (DR-047's <code>ui-&lt;host&gt;-&lt;hex8&gt;</code>,
        which <code>recoverOrphans()</code> can later find — the acceptance line #79 carries). Lines starting with
        <code>commit</code>, <code>abort</code>, <code>configure session/replace</code>, <code>rollback</code>,
        <code>copy running-config startup-config</code> or <code>reload</code> are refused before any session opens:
        commit and abort are this panel's confirmed buttons, never smuggled batch text.
      </p>
      <div className="review-actions">
        <button className="primary-button" type="button" onClick={onPreviewDraft} disabled={!canAct || busy || draft?.uncertainReason !== undefined} aria-busy={busy}>{draft === undefined ? 'Open shared session and stage draft' : 'Add draft to transaction'}</button>
      </div>
      {draft !== undefined && <div className="draft-review">
        <p className="field-note">Named session <code>{draft.sessionName}</code> · {String(draft.entries.length)} staged action(s)</p>
        <ol className="transaction-entries" aria-label="Staged transaction entries">
          {draft.entries.map((entry) => <li key={entry.id}>
            <strong>{entry.action}</strong><span>{entry.source}</span>
            {entry.display.map((line, index) => <code key={`${String(entry.id)}-${String(index)}`}>{line}</code>)}
            {entry.risks.map((risk) => <p className="cell-note" key={risk}>{risk}</p>)}
          </li>)}
        </ol>
        {draft.uncertainReason !== undefined && <div className="notice notice-error" role="alert"><strong>The transaction outcome is uncertain.</strong><p>{draft.uncertainReason}</p></div>}
        {draft.diff === undefined
          ? <EmptyState heading="Reading the device diff…" hint="Commit stays locked until the device answers its own diff()." />
          : <pre className="diff-output">{draft.diff}</pre>}
        <div className="review-actions">
          <button className="primary-button" type="button" onClick={onCommitDraft} disabled={!draft.canCommit || busy} aria-busy={busy}>Commit transaction to running-config</button>
          <button className="quiet-button" type="button" onClick={onAbortDraft} disabled={busy || draft.uncertainReason !== undefined}>Abort transaction</button>
        </div>
      </div>}
    </section>

    <section className="panel" aria-labelledby="tx-recovery-title">
      <div className="panel-heading">
        <div><p className="eyebrow">ORPHANS — DR-023</p><h3 id="tx-recovery-title">Browser journal + recovery</h3></div>
        <span className="panel-index">{journalRows.length.toString().padStart(2, '0')}</span>
      </div>
      <p className="field-note">
        This browser's local journal (fields stay inside the client's allow-list, DR-011 — the screen
        adds nothing). {journalLoaded ? '' : 'Not read yet — reads nothing from the device.'}
      </p>
      <div className="review-actions">
        <button className="quiet-button" type="button" onClick={onReadJournal} disabled={busy}>Read local journal</button>
        <button className="danger-button" type="button" onClick={onRecovery} disabled={!canAct || busy}>Run orphan recovery</button>
      </div>
      {journalError !== undefined && <p className="notice notice-error" role="alert">Journal unreadable: {journalError}</p>}
      {journalRows.length > 0 && <DataTable columns={journalColumns} rows={journalRows} rowKey={(row) => `${row.name}-${row.startedAt}`} label="Journaled sessions" />}
      {recoveryLines.length > 0 && <div aria-live="polite">
        <p className="eyebrow">RECOVERY RESULT</p>
        <ul className="ref-list" aria-label="Recovery outcome buckets">
          {recoveryLines.map((line) => <li key={line}><span>{line}</span></li>)}
        </ul>
      </div>}
    </section>

    <section className="panel" aria-labelledby="tx-verify-title">
      <div className="panel-heading">
        <div><p className="eyebrow">verifyConfig() — LABELLED HONESTLY</p><h3 id="tx-verify-title">Configlet normalisation preview</h3></div>
      </div>
      <p className="notice notice-warning" role="status"><strong>This preview answers:</strong> {verifyLabel}. The device opens its own session and aborts it — no orphan, no lock (DR-061).</p>
      <label htmlFor="tx-verify-text">Configlet text</label>
      <textarea
        id="tx-verify-text"
        name="tx-verify-text"
        className="probe-commands"
        rows={5}
        value={verifyText}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => { onVerifyTextChange(event.target.value) }}
        disabled={!canAct || busy}
      />
      <div className="review-actions"><button className="quiet-button" type="button" onClick={onVerify} disabled={!canAct || busy}>Ask the device to normalise it</button></div>
      {verifyEntries !== undefined && <div aria-live="polite">
        <p className="field-note">format {verifyFormat} · {String(verifyEntries.length)} configlet answer(s) · {String(verifyUnmatched ?? 0)} unmatched reply row(s) reported (nothing silently trimmed)</p>
        {verifyEntries.map((entry) => <div key={entry.index} className="capability-feature">
          <p className="capability-feature-head"><strong>configlet {String(entry.index + 1)}</strong>{entry.missingAnswer ? <StatePill value="no answer" /> : <StatePill value="answered" />}</p>
          <pre className="diff-output">{entry.configlet}</pre>
          {entry.normalised !== undefined && <pre className="diff-output">{entry.normalised}</pre>}
        </div>)}
      </div>}
    </section>

    <p className="field-note">Current endpoint: <code>{endpoint === '' ? 'not read' : endpoint}</code>. Out of scope until #89 (B4) lands its captures: startup-config policy toggle, configure replace, rollbacks, commit-timer UX, session-name-limit changes.</p>

    {notice !== '' && <p className="notice notice-success operation-result" role="status">{notice}</p>}
    {failure !== '' && <div className="notice notice-error operation-result" role="alert"><strong>That did not run.</strong><p>{failure}</p></div>}
  </section>
}
