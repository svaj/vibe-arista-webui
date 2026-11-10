/**
 * S4 (#74): the read-only command console — container half.
 *
 * Route `#/console`. It consumes F1 (routing), F2 (`useOperation`, `errorMessage`), F3 (`ConnectionHeader`,
 * `EmptyState`, `StatePill`, `DataTable`) and the client's M11 verbs (`exec`, `getCompletions`,
 * `getCommandHelp`). It deliberately does **not** consume F5 (`useCapabilities`) or F4 (`useConfirm`):
 * there is nothing to confirm and nothing to probe — a run either reaches the CLI or it does not, and the
 * answer is the proof.
 *
 * ## Why there is no read at mount
 *
 * Every other screen opens with an eager read batch, so it can claim a connection state. This screen
 * exists to run a command an operator chooses, so it contacts nothing until they press something
 * (`!proxyConfigured` and mounted-but-idle are both "no calls", pinned in the tests). The connection
 * cluster therefore reports what the last command proved, never what the proxy might be able to do:
 * `No command sent yet`, `Device answered the last command`, or `Last command did not come back`.
 *
 * ## The guard is the contract
 *
 * `command-guard.ts` decides what may be sent; this file only ever sends what it approved, as a plain
 * string command spec — never `{cmd, input}`, because `input` is the multi-line CLI channel
 * (`JsonCli.py:36-38`: `cmd`/`revision`/`input`), and a console that can hand the device a configlet is
 * not read-only. Because the guard is an allow-list (`show`/`sh`, at most one built-in pipe filter, no
 * shell or redirect characters, no `;`, no control characters), the screen may make the DR-019 claim
 * that `exec()` itself does not: `readOnly: true`. That is what allows a single safe re-send when nothing
 * reached the switch, and the tests pin that the console passes it.
 *
 * ## Completions and help are queries, not commands
 *
 * `getCommandCompletions`/`getCommandHelp` ask the CLI about a line; the server does not execute that
 * line (`JsonCli.py:174-203` → `CliApi.py:623-648`, `:442-462`). They are sent for whatever the operator
 * has typed — including an unfinished or unrunnable line — because completing `conf` is how you learn
 * what the device has. What is NOT offered here is `preamble`: the server runs each preamble entry as a
 * real CLI command (`CliApi.py:656-663`), which is a command execution wearing a completions costume, and
 * the client will not even let such a call be marked read-only (`command-layer.ts:1269-1272`). If a later
 * screen adds config-mode completion, the client's own preamble refusals (control characters, empty
 * entries) surface through this same failure slot.
 *
 * ## Every state, honestly
 *
 * - in flight: `aria-busy` on the Run button plus the operation's `role="status"` progress text;
 * - device refused it: a transcript entry with the mapped meaning of the code (`command-guard.ts`,
 *   `CODE_MEANING`) — 1002 is the only code allowed to read as "not available" (DR-062) — plus the
 *   request id for correlation with a device log (DR-017);
 * - answered with nothing renderable: `empty answer`, which is not a failure and not a blank panel;
 * - the `1003 → format:'text'` repair: labelled `text fallback (not model-backed)`, because the client
 *   reports `encoding`/`fellBack` for exactly this (DR-012, §5 rows 1/33);
 * - client/transport failure: the copy says plainly that the CLI never ran it.
 *
 * Nothing here persists across a reload, and nothing here writes.
 */
import { useState } from 'react'
import type { FormEvent } from 'react'
import type { CommandCompletions, Node } from '@devhax-heavy-industries/arista-eapi'

import {
  applyCompletion,
  completionComplete,
  completenessHint,
  describeFailure,
  guardConsoleCommand,
  helpFacts,
  lineShapeRefusal,
  renderExecEntry,
} from './command-guard'
import type { ConsoleFailureFacts } from './command-guard'
import { CommandConsoleView } from './CommandConsoleView'
import type { ConsoleCompletionPanel, ConsoleHelpPanel, ConsoleRunView } from './CommandConsoleView'

/** The three client verbs this screen drives. Nothing else on `Node` is reachable from here. */
export type ConsoleClient = Pick<Node, 'exec' | 'getCompletions' | 'getCommandHelp'>

export interface CommandConsoleProps {
  readonly node: ConsoleClient | undefined
  readonly proxyConfigured?: boolean
}

const PROXY_PROMPT = 'Local proxy is not configured. Set EAPI_HOST, EAPI_USER, and EAPI_PASS in arista-webui/.env.local, then restart Vite.'

/** F2's `useOperation` is deliberately NOT used for these three calls. `run()` collapses a failure to a
 *  string, and this screen must render the failure as STRUCTURE — the code, `eapiErrorName`, the mapped
 *  meaning (DR-062's rule that only 1002 may read as "unavailable") and the request id (DR-017). The
 *  triplet state below is the same shape and the same live-region contract; only the catch keeps the
 *  typed facts. Re-entry is refused the same way (`busy` gates every control). */

/** The alert text for a failed call: what the device said, plus which code it was and what it means. */
function failureText(facts: ConsoleFailureFacts): string {
  return facts.code === undefined
    ? `${facts.message} ${facts.meaning}`
    : `${facts.message} This console maps ${facts.code} ${facts.codeName ?? ''}: ${facts.meaning}`
}

const completionNote = (asked: CommandCompletions): string => {
  const parts: string[] = []
  if (asked.unparsed.length > 0) {
    parts.push(`the device sent a non-string help value for ${asked.unparsed.join(', ')} — the CLI assigns a guard code there (CliApi.py:646-650, flagged as a bug in Arista's own comment), so this client keeps it in the raw reply rather than turning it into ''`)
  }
  const extra = Object.keys(asked.extra)
  if (extra.length > 0) parts.push(`keys this client does not model: ${extra.join(', ')}`)
  if (asked.errors !== undefined && !(typeof asked.errors === 'object' && asked.errors !== null && Object.keys(asked.errors).length === 0)) {
    parts.push(`the device answered with an \`errors\` member: ${JSON.stringify(asked.errors)}`)
  }
  if (parts.length === 0) {
    return 'The device hides `<cr>`, `|`, `>`, and `>>` from a completion list (`JsonCli.py:35`), so a pipe or a redirect will never be offered here even though the grammar parses them.'
  }
  return `Reported, not rendered: ${parts.join('; ')}.`
}

export function CommandConsole({ node, proxyConfigured = true }: CommandConsoleProps) {
  const [line, setLine] = useState('')
  const [runs, setRuns] = useState<readonly ConsoleRunView[]>([])
  const [completions, setCompletions] = useState<ConsoleCompletionPanel>()
  const [help, setHelp] = useState<ConsoleHelpPanel>()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [failure, setFailure] = useState('')
  const [nextId, setNextId] = useState(1)

  const canAct = proxyConfigured && node !== undefined
  const last = runs[0]

  const connection = !canAct
    ? 'error'
    : busy
      ? 'connecting'
      : last === undefined
        ? 'connecting'
        : last.status === 'failed'
          ? 'error'
          : 'connected'
  const connectionLabel = !canAct
    ? 'Local proxy is not configured'
    : busy
      ? 'Waiting for the switch to answer'
      : last === undefined
        ? 'No command sent yet — this console reads only when you send one'
        : last.status === 'failed'
          ? 'Last command did not come back from the CLI'
          : `Device answered \`${last.command}\``

  function clearMessages() {
    setFailure('')
    setNotice('')
  }

  /**
   * One device call, with the failure facts captured on the way out so the transcript can render the
   * code, its name, its meaning and the request id — while the alert slot carries the same facts
   * composed into one sentence, which is the single message channel the other screens use.
   */
  async function deviceCall<T>(task: () => PromiseLike<T>, progress: string): Promise<{ ok: true; value: T } | { ok: false; facts: ConsoleFailureFacts }> {
    setFailure('')
    setNotice(progress)
    setBusy(true)
    try {
      const value = await Promise.resolve(task())
      setBusy(false)
      return { ok: true, value }
    } catch (error: unknown) {
      const facts = describeFailure(error)
      setFailure(failureText(facts))
      setBusy(false)
      return { ok: false, facts }
    }
  }

  function appendRun(view: ConsoleRunView) {
    setRuns((current) => [view, ...current])
  }

  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canAct || busy || node === undefined) return
    const guard = guardConsoleCommand(line)
    if (!guard.ok) {
      // A guard refusal never reaches the device, and says so in the same slot a device refusal uses.
      clearMessages()
      setFailure(guard.refusal)
      return
    }
    const { command } = guard
    const outcome = await deviceCall(() => node.exec(command, { readOnly: true }), 'Asking the switch to run that read…')
    if (!outcome.ok) {
      const { facts } = outcome
      appendRun({
        id: nextId,
        command,
        status: 'failed',
        encodingLabel: 'the CLI produced no answer for this line',
        ...(facts.code === undefined ? {} : { errorLabel: `${facts.code} ${facts.codeName ?? 'unknown'}` }),
        message: facts.message,
        meaning: facts.meaning,
        ...(facts.requestId === undefined ? {} : { requestId: facts.requestId }),
      })
      setNextId((id) => id + 1)
      return
    }
    const entries = outcome.value
    const entry = entries[0]
    // `exec()` documents one entry per command (it re-frames `enable` per request under the default
    // `tolerateErrors`); anything else is a client lie worth stopping on rather than guessing at.
    if (entries.length !== 1 || entry === undefined) {
      setNotice('')
      setFailure(`The client returned ${entries.length} answers for the one command this console sends. \`exec()\` promises one \`{command, result, encoding, fellBack}\` entry per command, so the console refuses to guess which one to show.`)
      return
    }
    const output = renderExecEntry(entry)
    appendRun({
      id: nextId,
      command,
      status: output.empty ? 'empty' : 'ok',
      encodingLabel: output.fellBack
        ? 'text fallback (not model-backed)'
        : output.json
          ? 'model-backed JSON answer, shown as JSON text'
          : `${output.encoding} answer`,
      output: output.text,
      ...(output.json && output.fields !== undefined ? { jsonFields: output.fields } : {}),
    })
    setNextId((id) => id + 1)
    setNotice(output.fellBack
      ? 'The device has no JSON model for that command, so the transcript entry came back as text (the client\'s 1003 → format:text repair, DR-012).'
      : '')
  }

  async function complete() {
    if (!canAct || busy || node === undefined) return
    // A query line only has to be ONE line: the device is being asked about the text, not told to run it
    // (no `preamble` is ever sent — see the header). An empty or trailing-space line is a legitimate
    // question, and the answer for it is a real completion set (`wire.ts`, `buildGetCommandCompletionsRequest`).
    const shape = lineShapeRefusal(line)
    if (shape !== undefined) {
      clearMessages()
      setFailure(shape.refusal)
      return
    }
    // Sent exactly as typed, trailing whitespace included: the device only ever answers the completeness
    // question when the line ends with whitespace (`CliApi.py:631-637`), so trimming it here would make
    // `complete` unobservable.
    const asked = line
    const outcome = await deviceCall(() => node.getCompletions(asked), 'Asking the device what that line could still become…')
    if (!outcome.ok) return
    const reply = outcome.value
    const note = completionNote(reply)
    setCompletions({
      asked,
      runs: reply.completions.map((completion) => ({ name: completion.name, help: completion.help })),
      complete: completionComplete(reply),
      hint: completenessHint(asked),
      note,
    })
    setNotice('')
  }

  async function showHelp() {
    if (!canAct || busy || node === undefined) return
    const shape = lineShapeRefusal(line)
    if (shape !== undefined) {
      clearMessages()
      setFailure(shape.refusal)
      return
    }
    const asked = line.trim()
    const outcome = await deviceCall(() => node.getCommandHelp(asked), 'Reading the device help for each token of that line…')
    if (!outcome.ok) return
    const facts = helpFacts(outcome.value)
    const notes: string[] = []
    if (facts.hidden.length > 0) notes.push(`hidden structural tokens: ${facts.hidden.join(', ')}`)
    if (facts.unparsed.length > 0) notes.push(`non-string help values reported, not rendered: ${facts.unparsed.join(', ')}`)
    setHelp({
      asked,
      rows: facts.entries.map((entry) => ({ name: entry.name, help: entry.help })),
      ...(notes.length === 0 ? {} : { note: `Reported, not rendered: ${notes.join('; ')}.` }),
    })
    setNotice('')
  }

  function insert(completion: string) {
    if (!canAct) return
    setLine((current) => applyCompletion(current, completion))
    setCompletions(undefined)
  }

  return <CommandConsoleView
    line={line}
    onLineChange={setLine}
    onRun={(event) => void run(event)}
    onComplete={() => void complete()}
    onHelp={() => void showHelp()}
    onInsert={insert}
    busy={busy}
    canAct={canAct}
    {...(proxyConfigured ? {} : { proxyPrompt: PROXY_PROMPT })}
    notice={notice}
    failure={failure}
    connection={connection}
    connectionLabel={connectionLabel}
    runs={runs}
    {...(completions === undefined ? {} : { completions })}
    {...(help === undefined ? {} : { help })}
  />
}
