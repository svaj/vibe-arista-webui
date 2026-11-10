/**
 * S4 (#74): the presentation half of the read-only command console.
 *
 * No client type crosses this boundary — `ExecResult`, `CommandCompletions`, and `CommandHelp` are
 * reduced to plain strings/arrays by `command-guard.ts` and the container first, so the markup can be
 * tested by handing it props (the same rule `TrunkEditorView.tsx` follows).
 *
 * What the markup owns, beyond the visual:
 *
 * - **Device text is text.** Everything the switch answered renders as a JSX child (`<pre>` for the
 *   output), never as HTML. A reply containing `<img src=x onerror=…>` shows those characters
 *   (issue #74's no-eval/no-XSS acceptance line).
 * - **The encoding label is not decoration.** `model-backed JSON answer` vs `text fallback (not
 *   model-backed)` tells the operator whether a JSON model answered or the client's `1003 → format:
 *   'text'` repair did (DR-012). Hiding that is the failure mode #74 calls out.
 * - **Live regions.** The transcript is a `role="log" aria-live="polite"` list and the completions
 *   panel is `aria-live="polite"`, because both change as the device answers. The failure slot is a
 *   `role="alert"` (the `useOperation` contract); the in-flight notice is `role="status"`.
 * - **Nothing is claimed that the device did not answer.** The connection cluster's label comes from
 *   the last command's outcome — an on-demand screen must not say "connected" before it has spoken.
 */
import type { FormEvent } from 'react'
import type { ReactElement } from 'react'

import { ConnectionHeader } from '../../components/ui/ConnectionHeader'
import type { ConnectionState } from '../../components/ui/ConnectionHeader'
import { DataTable } from '../../components/ui/DataTable'
import type { DataTableColumn } from '../../components/ui/DataTable'
import { EmptyState } from '../../components/ui/EmptyState'
import { StatePill } from '../../components/ui/StatePill'

/** One command this console actually sent, reduced to renderable facts. */
export interface ConsoleRunView {
  readonly id: number
  /** The exact text put on the wire (the typed line, trimmed). */
  readonly command: string
  /** `empty` = the device answered and the answer rendered to nothing — a state, not a failure. */
  readonly status: 'ok' | 'empty' | 'failed'
  /** `model-backed JSON answer` | `text fallback (not model-backed)` | `text answer`. */
  readonly encodingLabel: string
  readonly output?: string
  /** Member count of a model-backed answer shown as JSON text. */
  readonly jsonFields?: number
  /** `1002 COMMAND_INVALID` style label, when the device answered with an error code. */
  readonly errorLabel?: string
  /** The device/client message, verbatim (already redacted by the client — DR-011). */
  readonly message?: string
  /** Screen copy for that code. */
  readonly meaning?: string
  /** The JSON-RPC request id, for correlation with a device log (DR-017). */
  readonly requestId?: string
}

export interface ConsoleCompletionView {
  readonly name: string
  readonly help: string
}

/** The completion panel's state after a `getCommandCompletions` round trip. */
export interface ConsoleCompletionPanel {
  /** The line as it was sent — trailing whitespace included, because that is what the device reads. */
  readonly asked: string
  readonly runs: readonly ConsoleCompletionView[]
  /** `undefined` = the reply did not answer whether the line is complete. */
  readonly complete: boolean | undefined
  readonly hint: string
  /** Anything the parser had to report rather than render: device `errors`, unparsed keys, extra keys. */
  readonly note?: string
}

/** The help panel's state after a `getCommandHelp` round trip. */
export interface ConsoleHelpPanel {
  readonly asked: string
  readonly rows: readonly ConsoleCompletionView[]
  /** Names of structural keys the pane hides (`<cr>`, `|`, `>`, `>>`) and non-string help values. */
  readonly note?: string
}

export interface CommandConsoleViewProps {
  readonly line: string
  readonly onLineChange: (value: string) => void
  readonly onRun: (event: FormEvent<HTMLFormElement>) => void
  readonly onComplete: () => void
  readonly onHelp: () => void
  readonly onInsert: (completion: string) => void
  /** True while any console request is in flight; every control is gated on it. */
  readonly busy: boolean
  /** Proxy configured AND a node exists. Nothing is enabled without it. */
  readonly canAct: boolean
  readonly proxyPrompt?: string
  readonly notice: string
  readonly failure: string
  readonly connection: ConnectionState
  readonly connectionLabel: string
  readonly runs: readonly ConsoleRunView[]
  readonly completions?: ConsoleCompletionPanel
  readonly help?: ConsoleHelpPanel
}

const STATUS_LABEL: Record<ConsoleRunView['status'], string> = {
  ok: 'answered',
  empty: 'empty answer',
  failed: 'refused by device',
}

const completionColumns: readonly DataTableColumn<ConsoleCompletionView>[] = [
  { header: 'Token', cell: (row) => <code>{row.name}</code> },
  { header: 'Help from the device', cell: (row) => row.help === '' ? <span className="cell-note">no help text</span> : row.help },
]

/**
 * The console's connection claim, derived from the last command's outcome rather than from a probe the
 * screen never ran. An on-demand screen has no read at mount, so the default label says exactly that.
 */
function ConnectionCluster({ state, label }: { readonly state: ConnectionState; readonly label: string }): ReactElement {
  return <ConnectionHeader
    state={state}
    connectedLabel={state === 'connected' ? label : undefined}
    connectingLabel={state === 'connecting' ? label : undefined}
    errorLabel={state === 'error' ? label : undefined}
  />
}

export function CommandConsoleView({
  line,
  onLineChange,
  onRun,
  onComplete,
  onHelp,
  onInsert,
  busy,
  canAct,
  proxyPrompt,
  notice,
  failure,
  connection,
  connectionLabel,
  runs,
  completions,
  help,
}: CommandConsoleViewProps): ReactElement {
  return <section className="workspace" aria-labelledby="workspace-title">
    <div className="screen-connection">
      <ConnectionCluster state={connection} label={connectionLabel} />
    </div>

    <div className="workspace-heading">
      <div>
        <p className="eyebrow">COMMAND CONSOLE</p>
        <h2 id="workspace-title">Read-only command console</h2>
      </div>
    </div>

    {proxyPrompt !== undefined && <div className="notice notice-error" role="alert"><strong>Local proxy is not configured.</strong><p>{proxyPrompt}</p></div>}

    <p className="notice notice-warning" role="status">
      This console is <strong>read-only</strong>. It sends one <code>show</code> command per line, never a
      configuration entry, file write, reboot, session, or shell — and it does not offer a way around that.
      A write-capable console is a separate decision that waits on the transaction center (#79).
    </p>

    <section className="panel" aria-labelledby="console-input-title">
      <div className="panel-heading">
        <div><p className="eyebrow">ONE COMMAND</p><h3 id="console-input-title">Send a read to the switch</h3></div>
        <span className="panel-index">{runs.length.toString().padStart(2, '0')}</span>
      </div>

      <form onSubmit={onRun}>
        <label htmlFor="console-command">Command</label>
        <input
          id="console-command"
          name="console-command"
          value={line}
          spellCheck={false}
          autoComplete="off"
          placeholder="show version"
          onChange={(event) => onLineChange(event.target.value)}
          disabled={!canAct}
        />
        <p className="field-note">
          Allowed: <code>show …</code> or <code>sh …</code> (the vendor grammar declares <code>sh</code> as
          an alternate — <code>ShowCommand.py:42-46</code>), optionally with one built-in filter
          (<code>include</code>, <code>exclude</code>, <code>begin</code>, <code>section</code>, <code>nz</code>,
          <code>json</code>, <code>no-more</code>). eAPI does <em>not</em> expand abbreviations for an executed
          command (<code>runCmds</code> defaults <code>autoComplete=false</code>, <code>JsonCli.py:335-339</code>),
          so a short form answers <code>1002</code> instead of running something else. Anything the guard
          refuses never reaches the device.
        </p>
        <div className="review-actions">
          <button className="primary-button" type="submit" disabled={!canAct || busy || line.trim() === ''} aria-busy={busy}>Run command</button>
          <button className="quiet-button" type="button" onClick={onComplete} disabled={!canAct || busy}>Get completions</button>
          <button className="quiet-button" type="button" onClick={onHelp} disabled={!canAct || busy}>Show command help</button>
        </div>
      </form>

      {notice !== '' && <p className="notice notice-success operation-result" role="status">{notice}</p>}
      {failure !== '' && <div className="notice notice-error operation-result" role="alert"><strong>The console did not run that.</strong><p>{failure}</p></div>}
    </section>

    {completions === undefined ? null : <section className="panel" aria-labelledby="completions-title">
      <div className="panel-heading">
        <div><p className="eyebrow">getCommandCompletions</p><h3 id="completions-title">What the device offered for <code>{completions.asked === '' ? '(empty line)' : completions.asked}</code></h3></div>
        <span className="panel-index">{completions.runs.length.toString().padStart(2, '0')}</span>
      </div>
      <p className="notice" role="status" aria-live="polite">
        {completions.complete === true
          ? 'Verdict: the device says this line is a complete command (it offered <cr>).'
          : completions.complete === false
            ? 'Verdict: the device did not offer <cr>, so this line is not a complete command as typed.'
            : `Verdict: the reply did not answer whether the line is complete. ${completions.hint}`}
      </p>
      {completions.runs.length === 0
        ? <EmptyState heading="The device offered no completion for that text." hint="An empty list is a real answer — `show xq` matches nothing — not a failed call." />
        : <ul className="group-list" aria-label="Command completions">
          {completions.runs.map((completion) => (
            <li key={completion.name}>
              <code>{completion.name}</code>
              <span className="cell-note">{completion.help === '' ? 'no help text' : completion.help}</span>
              <button className="quiet-button" type="button" onClick={() => onInsert(completion.name)} disabled={!canAct}>
                Insert {completion.name}
              </button>
            </li>
          ))}
        </ul>}
      <p className="field-note">{completions.note ?? 'The device keys its answer on the last word typed only, and returns whole tokens — inserting replaces that last token rather than appending.'}</p>
    </section>}

    {help === undefined ? null : <section className="panel" aria-labelledby="help-title">
      <div className="panel-heading">
        <div><p className="eyebrow">getCommandHelp</p><h3 id="help-title">Help for <code>{help.asked}</code></h3></div>
        <span className="panel-index">{help.rows.length.toString().padStart(2, '0')}</span>
      </div>
      {help.rows.length === 0
        ? <EmptyState heading="The device returned no help token for that line." hint="An empty answer is a real reply, and this client refuses to invent help text for it." />
        : <DataTable columns={completionColumns} rows={help.rows} rowKey={(row) => row.name} label="Command help tokens" />}
      {help.note !== undefined && <p className="field-note">{help.note}</p>}
    </section>}

    <section className="panel" aria-labelledby="transcript-title">
      <div className="panel-heading">
        <div><p className="eyebrow">THIS SESSION ONLY</p><h3 id="transcript-title">Commands this console ran</h3></div>
        <span className="panel-index">{runs.length.toString().padStart(2, '0')}</span>
      </div>
      <div className="console-transcript-wrap" role="log" aria-live="polite" aria-label="Command transcript">
        {runs.length === 0
          ? <EmptyState heading="Nothing has been sent to the device yet." hint="This console runs nothing at mount: no identity read, no capability probe, no background poll." />
          : <ol className="group-list console-transcript">
            {runs.map((run) => <li key={run.id} className="console-entry">
              <p className="console-entry-head">
                <code className="console-command-sent">{run.command}</code>
                <StatePill value={STATUS_LABEL[run.status]} />
                <span className="cell-note">{run.encodingLabel}</span>
                {run.jsonFields === undefined ? null : <span className="cell-note">{run.jsonFields} model members</span>}
                {run.errorLabel === undefined ? null : <code className="read-error">{run.errorLabel}</code>}
                {run.requestId === undefined ? null : <span className="cell-note">request {run.requestId}</span>}
              </p>
              {run.output === undefined ? null : <pre className="diff-output console-output">{run.output}</pre>}
              {run.message === undefined ? null : <p className="console-message">{run.message}</p>}
              {run.meaning === undefined ? null : <p className="field-note"><strong>Meaning:</strong> {run.meaning}</p>}
            </li>)}
          </ol>}
      </div>
      <p className="field-note">Transcript, output, completions and help all live in this browser session only — nothing is persisted, and a reload clears it. Macros and history are a later decision (#74).</p>
    </section>
  </section>
}
