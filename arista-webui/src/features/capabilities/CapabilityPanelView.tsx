/**
 * S7 (#77): the presentation half of the capability probe panel. Pure props (the container reduces
 * the client outcome to these rows), matching `CommandConsoleView.tsx`/`TrunkEditorView.tsx`.
 *
 * Accessibility/ownership notes:
 * - verdicts are **text plus a colour class** (`StatePill`), never colour alone (WCAG 1.4.1);
 * - the verdict region and the run-status line are live regions (`aria-live="polite"`), failures use
 *   `role="alert"` — the four-state contract F2 set;
 * - every device-origin string renders as a JSX text child (`<pre>` for the export), never HTML;
 * - the empty state is `EmptyState`, and a failed run never renders through it.
 */
import type { FormEvent } from 'react'
import type { ReactElement } from 'react'

import { ConnectionHeader } from '../../components/ui/ConnectionHeader'
import type { ConnectionState } from '../../components/ui/ConnectionHeader'
import { DataTable } from '../../components/ui/DataTable'
import type { DataTableColumn } from '../../components/ui/DataTable'
import { EmptyState } from '../../components/ui/EmptyState'
import { StatePill } from '../../components/ui/StatePill'

export interface PanelCandidateRow {
  readonly command: string
  /** The client verdict verbatim as the tooltip-quality truth (`supported`, `config-locked`, …). */
  readonly verdict: string
  /** The operator-facing #77 label for that verdict (`available`, `inconclusive`, …). */
  readonly label: string
  /** What this verdict is allowed to claim — the DR-062 non-claim copy. */
  readonly meaning: string
  /** `1002 COMMAND_INVALID`, `no code carried`, etc. */
  readonly codeText: string
  readonly batch: string
}

export interface PanelFeatureRow {
  readonly name: string
  /** The hook's three-way fold: available | unavailable | unknown. */
  readonly display: string
  readonly reason: string
  readonly candidates: readonly PanelCandidateRow[]
}

export interface PanelSessionRow {
  readonly name: string
  readonly state: string
  readonly description: string
}

export interface CapabilityPanelViewProps {
  readonly setName: string
  readonly setCommands: string
  readonly onNameChange: (value: string) => void
  readonly onCommandsChange: (value: string) => void
  readonly onAddSet: (event: FormEvent<HTMLFormElement>) => void
  readonly onRemoveSet: (name: string) => void
  readonly sets: readonly { name: string; commands: readonly string[] }[]
  readonly onProbe: () => void
  readonly onReprobe: () => void
  readonly onAbortPending: (name: string) => void
  readonly onBuildExport: () => void
  readonly onCopyExport: () => void
  readonly busy: boolean
  readonly canAct: boolean
  readonly proxyPrompt?: string
  readonly notice: string
  readonly failure: string
  /** `idle | probing | ready | failed` straight from the hook, for the live line. */
  readonly probeStatus: 'idle' | 'probing' | 'ready' | 'failed'
  readonly fromCache: boolean
  readonly suppressedCount: number
  readonly cacheNote?: string
  readonly connection: ConnectionState
  readonly connectionLabel: string
  readonly statusLine: string
  readonly features: readonly PanelFeatureRow[]
  readonly configLocked: boolean
  readonly pendingSessions: readonly PanelSessionRow[]
  readonly exportText?: string
  readonly exportBlocked?: string
}

const candidateColumns: readonly DataTableColumn<PanelCandidateRow>[] = [
  { header: 'Candidate command', cell: (row) => <code>{row.command}</code> },
  { header: 'Device verdict', cell: (row) => <StatePill value={row.label} /> },
  { header: 'Code', cell: (row) => <code>{row.codeText}</code> },
  { header: 'What it may claim', cell: (row) => <span className="cell-note">{row.meaning}</span> },
  { header: 'Batch', cell: (row) => row.batch },
]

export function CapabilityPanelView({
  setName,
  setCommands,
  onNameChange,
  onCommandsChange,
  onAddSet,
  onRemoveSet,
  sets,
  onProbe,
  onReprobe,
  onAbortPending,
  onBuildExport,
  onCopyExport,
  busy,
  canAct,
  proxyPrompt,
  notice,
  failure,
  probeStatus,
  fromCache,
  suppressedCount,
  cacheNote,
  connection,
  connectionLabel,
  statusLine,
  features,
  configLocked,
  pendingSessions,
  exportText,
  exportBlocked,
}: CapabilityPanelViewProps): ReactElement {
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
        <p className="eyebrow">CAPABILITY EVIDENCE</p>
        <h2 id="workspace-title">Capability probe panel</h2>
      </div>
    </div>

    {proxyPrompt !== undefined && <div className="notice notice-error" role="alert"><strong>Local proxy is not configured.</strong><p>{proxyPrompt}</p></div>}

    <p className="notice notice-warning" role="status">
      This panel answers <strong>command presence</strong> — what the CLI grammar on this exact unit
      accepted inside a probe session. It does <strong>not</strong> prove a feature is licensed,
      sized, or a capacity limit for this switch (epic open item 6), and it never consults a
      feature table: every candidate below is a question <em>you</em> asked (DR-033). Each uncached
      run costs one named config session that this client always aborts (DR-047/DR-063).
    </p>

    <section className="panel" aria-labelledby="probe-editor-title">
      <div className="panel-heading">
        <div><p className="eyebrow">QUESTION SETS</p><h3 id="probe-editor-title">What do you want to ask the device?</h3></div>
        <span className="panel-index">{sets.length.toString().padStart(2, '0')}</span>
      </div>
      <form onSubmit={onAddSet}>
        <label htmlFor="probe-set-name">Feature name (your label)</label>
        <input
          id="probe-set-name"
          name="probe-set-name"
          value={setName}
          spellCheck={false}
          autoComplete="off"
          placeholder="trunkGroups"
          onChange={(event) => onNameChange(event.target.value)}
          disabled={!canAct}
        />
        <label htmlFor="probe-set-commands">Candidate commands, one per line</label>
        <textarea
          id="probe-set-commands"
          name="probe-set-commands"
          className="probe-commands"
          rows={5}
          value={setCommands}
          spellCheck={false}
          autoComplete="off"
          placeholder={'switchport trunk group HWGRP\ninterface Port-Channel999\nport-channel lacp fallback timeout 5 individual'}
          onChange={(event) => onCommandsChange(event.target.value)}
          disabled={!canAct}
        />
        <p className="field-note">
          Candidates are staged inside the throwaway session and never committed. The verbs this
          client always refuses (<code>abort</code>, <code>commit</code>, <code>configure session</code>,
          <code>configure replace</code>, <code>copy running-config startup-config</code>, <code>reload</code>)
          are refused <strong>before</strong> you add the set — <code>probeCommands</code> would throw
          mid-list over them, so refusing here costs zero sessions instead.
        </p>
        <div className="review-actions">
          <button className="primary-button" type="submit" disabled={!canAct}>Add question set</button>
        </div>
      </form>
      {sets.length === 0
        ? <EmptyState heading="No question sets yet — the list starts empty on purpose." hint="DR-033: this app ships no capability table, so nothing here is pre-seeded. Add the question a DECISIONS open item is waiting on." />
        : <ul className="group-list" aria-label="Question sets">
          {sets.map((set) => <li key={set.name}>
            <strong>{set.name}</strong>
            <span className="cell-note">{set.commands.map((command) => <code key={command}>{command}</code>)}</span>
            <button className="quiet-button" type="button" onClick={() => onRemoveSet(set.name)} disabled={!canAct || busy}>Remove {set.name}</button>
          </li>)}
        </ul>}
    </section>

    <section className="panel" aria-labelledby="probe-run-title">
      <div className="panel-heading">
        <div><p className="eyebrow">EXPLICIT — NEVER ON RENDER</p><h3 id="probe-run-title">Run a probe</h3></div>
      </div>
      <p className="field-note">
        This panel is <code>probeTrigger: &#39;manual&#39;</code> (#123): mounting it opened no config
        session and it never will without a click. The button below confirms first because the cost
        is a session on the device&#39;s config lock, not a request.
      </p>
      <div className="review-actions">
        <button className="primary-button" type="button" onClick={onProbe} disabled={!canAct || busy || sets.length === 0} aria-busy={busy}>
          {busy ? 'Probing…' : 'Run capability probe'}
        </button>
        <button className="quiet-button" type="button" onClick={onReprobe} disabled={!canAct || busy || sets.length === 0}>
          Re-probe (fresh — costs a session)
        </button>
        <button className="quiet-button" type="button" onClick={onBuildExport} disabled={!canAct || probeStatus !== 'ready'}>
          Build redacted export
        </button>
      </div>
      <p className="notice" role="status" aria-live="polite">
        {probeStatus === 'idle' && 'No probe has run in this page load. Nothing has been sent to the device.'}
        {probeStatus === 'probing' && 'Probe in flight: a named config session is open on the device; this client aborts it on every path (DR-047).'}
        {probeStatus === 'ready' && `Last run settled${fromCache ? ' — answered from the capability cache, no config session was opened' : ''}.`}
        {probeStatus === 'failed' && 'The last probe did not settle; the failure is shown below.'}
      </p>
      {suppressedCount > 0 && <p className="field-note" role="status">The rate limiter refused the last {suppressedCount.toString()} request(s) inside its window without touching the wire — no extra session was opened by them.</p>}
      {cacheNote !== undefined && <p className="field-note" role="status">Why nothing is cached behind this view: {cacheNote}</p>}
      {configLocked && <div className="notice notice-warning" role="status">A <strong>1006 config lock</strong> answered this probe. Nothing reached the CLI grammar, so no verdict below is usable, and retrying blindly will not help — the pending-session list and its cleanup are the actionable half (#79 builds the full transaction center).</div>}
      {notice !== '' && <p className="notice notice-success operation-result" role="status">{notice}</p>}
      {failure !== '' && <div className="notice notice-error operation-result" role="alert"><strong>Nothing was sent for that.</strong><p>{failure}</p></div>}
    </section>

    <section className="panel" aria-labelledby="probe-verdicts-title">
      <div className="panel-heading">
        <div><p className="eyebrow">SEVEN-VERDICT TAXONOMY</p><h3 id="probe-verdicts-title">What the device answered</h3></div>
        <span className="panel-index">{features.length.toString().padStart(2, '0')}</span>
      </div>
      {probeStatus === 'idle'
        ? <EmptyState heading="No verdicts yet." hint="Add at least one question set and press the probe button — this panel deliberately never probes on its own." />
        : features.length === 0
          ? <EmptyState heading="The run returned no feature rows." hint="This can only happen if the candidate map changed mid-flight; nothing was claimed." />
          : <div className="capability-results" aria-live="polite">
            <p className="field-note" role="status">{statusLine}</p>
            {features.map((feature) => <div key={feature.name} className="capability-feature">
              <p className="capability-feature-head">
                <strong>{feature.name}</strong>
                <StatePill value={feature.display} />
                <span className="cell-note">{feature.reason}</span>
              </p>
              <DataTable columns={candidateColumns} rows={feature.candidates} rowKey={(row) => `${row.command}-${row.batch}`} label={`${feature.name} candidate verdicts`} />
            </div>)}
          </div>}
    </section>

    {pendingSessions.length > 0 && <section className="panel" aria-labelledby="probe-sessions-title">
      <div className="panel-heading">
        <div><p className="eyebrow">CLEANUP</p><h3 id="probe-sessions-title">Pending sessions holding the config lock</h3></div>
        <span className="panel-index">{pendingSessions.length.toString()}</span>
      </div>
      <ul className="session-list">
        {pendingSessions.map((session) => <li key={session.name}>
          <div><strong>{session.name}</strong><span><StatePill value={session.state} />{session.description === '' ? '' : ` · ${session.description}`}</span></div>
          <button className="danger-button" type="button" disabled={!canAct || busy} onClick={() => onAbortPending(session.name)}>Abort pending session {session.name}</button>
        </li>)}
      </ul>
      <p className="field-note">Aborting a pending session is a device write; every abort here passes a confirm first. The transaction center (#79) owns the durable view of these sessions.</p>
    </section>}

    {(exportText !== undefined || exportBlocked !== undefined) && <section className="panel" aria-labelledby="probe-export-title">
      <div className="panel-heading">
        <div><p className="eyebrow">F8-REDACTED (#70)</p><h3 id="probe-export-title">Export for a DECISIONS / open-item note</h3></div>
      </div>
      {exportBlocked !== undefined && <div className="notice notice-error" role="alert"><strong>Export blocked.</strong><p>{exportBlocked}</p></div>}
      {exportText !== undefined && <>
        <p className="field-note">Contains commands, verdicts and codes only — no device message prose, no endpoint name, no enable framing (the export is built that way first, then scanned by the F8 guard as a second net).</p>
        <pre className="diff-output">{exportText}</pre>
        <div className="review-actions"><button className="quiet-button" type="button" onClick={onCopyExport}>Copy to clipboard</button></div>
      </>}
    </section>}
  </section>
}
