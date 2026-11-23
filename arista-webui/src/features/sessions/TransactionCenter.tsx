/**
 * S9 (#79): the transaction center — the view/abort/preview half. One place an operator can see
 * every config-session fact the device reports and act on it with the same staged-review pipeline
 * the feature screens use, plus the standalone draft reviewer those screens never had.
 *
 * ## The pipeline, kept honest
 *
 * `configSession` (name from the client's own sanitized generator — DR-047's `ui-<host>-<hex8>`
 * shape, `generateSessionName(endpoint)`; #79's acceptance says reuse PR #58's generator, do not
 * re-invent it) → stage the operator's lines → the DEVICE's `diff()` → `hasDiffBeenRead()`-gated
 * commit, F4-confirmed, "Startup-config was not changed" (DR-024). The textarea cannot smuggle
 * session-control verbs (see {@link draftBatchRefusal}, session-rules.ts) — commit/abort stay the
 * screen's confirmed buttons and the only exits from a draft.
 *
 * ## Orphans (DR-023) and the label rule
 *
 * `recoverOrphans({ journal })` runs against this browser's journal
 * (`createWebStorageJournal(localStorage)` — fields stay inside the client's allow-list, DR-011;
 * the screen records nothing beyond what the client wrote), and every result bucket is reported.
 * Unlabeled device sessions without a journal age are skipped, not guessed at, and a timer-armed
 * session is never auto-aborted — the client already enforces that; the screen shows WHY.
 *
 * ## verifyConfig() keeps its label (DR-061 / §5 row 118)
 *
 * The device answers from `rollback clean-config`, so the preview is labelled "normalised configlet
 * preview from the CLEAN config" everywhere it appears, never as pre-flight for a specific diff.
 * `unmatched` and `raw` counts are reported, never trimmed away.
 *
 * ## Durability (B4, #89 → DR-160 §1): ONE explicit Save, everything else still fenced
 *
 * `copyRunningToStartup()` rides this screen as the app's only startup-config write — a first-class
 * confirmed button, separate from commit, whose success is judged by the follow-up
 * `show startup-config` read because the copy's eAPI reply text is empty on this image (DR-150).
 * Commit still writes running-config only (DR-024 — the Save button is the only thing that ever
 * changes startup, and only when an operator confirms it). `configure replace` stays a scripted
 * operator act with no UI (DR-160 §2), `rollback*` waits on the S1 capture (#182, DR-160 §3), and
 * commit-timer authoring stays surfacing-only (DR-160 §4). This screen names those boundaries
 * rather than half-implementing them.
 *
 * No `useOperation` collapse on the recovery path either? It does use it — the center shows TEXT
 * results (the recovery outcome buckets), which is exactly what `run()`'s string channel serves.
 */
import { useMemo, useState } from 'react'
import { createWebStorageJournal } from '@devhax-heavy-industries/arista-eapi'
import type { Node, SessionJournal, VerifyConfigOutcome } from '@devhax-heavy-industries/arista-eapi'

import { useDeviceRead } from '../../shared/use-device-read'
import { useOperation } from '../../shared/use-operation'
import { ConfirmProvider, useConfirm } from '../../shared/use-confirm'
import { TransactionCenterView } from './TransactionCenterView'
import { useTransaction, useTransactionSnapshot } from './TransactionContext'
import type { DraftView, JournalRowView, SessionRowView, VerifyEntryView } from './TransactionCenterView'
import { describeRecovery, describeSessionRow, draftBatchRefusal, parseDraftLines, VERIFY_LABEL } from './session-rules'

export type TransactionCenterClient = Pick<Node, 'listSessions' | 'abortSession' | 'recoverOrphans' | 'verifyConfig' | 'connection' | 'copyRunningToStartup' | 'getConfig'>

export interface TransactionCenterProps {
  readonly node: TransactionCenterClient | undefined
  readonly proxyConfigured?: boolean
}

const PROXY_PROMPT = 'Local proxy is not configured. Set EAPI_HOST, EAPI_USER, and EAPI_PASS in arista-webui/.env.local, then restart Vite.'
const COMMIT_RECOVERY_NOTE = 'If this session is lost mid-commit, the change may still have applied — refresh the session table before any further action.'
/** The whole-running-config blast, quoted verbatim in the Save confirm (#181 acceptance). */
const SAVE_BLAST = 'This writes the WHOLE current running-config to flash with `copy running-config startup-config` — every change on this switch, not only the staged transaction — and it overwrites whatever startup-config is there now. It is a separate act from commit and is not part of any transaction.'
/** Why success comes from a second read, not the verb's reply (#181, DR-150/DR-160 §1). */
const SAVE_REPLY_FACT = 'On this EOS build the copy\u2019s eAPI reply text comes back empty, so success is judged by the follow-up `show startup-config` read (format=text), never by the verb reply.'

export function TransactionCenter(props: TransactionCenterProps) {
  return <ConfirmProvider><TransactionWorkspace {...props} /></ConfirmProvider>
}

function TransactionWorkspace({ node, proxyConfigured = true }: TransactionCenterProps) {
  const confirm = useConfirm()
  const operation = useOperation()
  const { busy, notice, failure } = operation
  const transaction = useTransaction()
  const transactionState = useTransactionSnapshot()
  const canAct = proxyConfigured && node !== undefined && transaction !== undefined
  const transactionBusy = transactionState.status === 'opening' || transactionState.status === 'staging' || transactionState.status === 'committing' || transactionState.status === 'aborting'

  const [draftText, setDraftText] = useState('')
  const [verifyText, setVerifyText] = useState('')
  const [recoveryLines, setRecoveryLines] = useState<readonly string[]>([])
  const [verify, setVerify] = useState<{ outcome: VerifyConfigOutcome; label: string } | undefined>(undefined)
  const [startupSave, setStartupSave] = useState<{ lines: number; characters: number } | undefined>(undefined)

  // The journal is browser-local: reading it contacts nothing, and with no proxy it still answers
  // "what did THIS browser leave behind?" — which is exactly the orphan question.
  const journal = useMemo<SessionJournal>(() => createWebStorageJournal(window.localStorage), [])
  const [journalRows, setJournalRows] = useState<readonly JournalRowView[]>([])
  const [journalError, setJournalError] = useState<string | undefined>(undefined)
  const [journalLoaded, setJournalLoaded] = useState(false)

  function loadJournal() {
    void journal.read().then(
      (entries) => {
        setJournalRows(entries.map((entry) => ({ name: entry.name, endpoint: entry.endpoint, startedAt: entry.startedAt, ...(entry.description === undefined ? {} : { description: entry.description }) })))
        setJournalError(undefined)
        setJournalLoaded(true)
      },
      (error: unknown) => {
        setJournalError(error instanceof Error ? error.message : String(error))
        setJournalLoaded(true)
      },
    )
  }

  const read = useDeviceRead<{ sessions: readonly SessionRowView[]; endpoint: string }>(
    async () => {
      if (node === undefined) throw new Error('no device client')
      const listed = await node.listSessions()
      return {
        endpoint: node.connection.address,
        sessions: listed.sessions.map((session) => {
          const described = describeSessionRow(session)
          return {
            name: session.name,
            state: session.state,
            description: session.description ?? '',
            rowLabel: described.label,
            dangerous: described.dangerous,
            ...(described.timerNote === undefined ? {} : { timerNote: described.timerNote }),
            instanceCount: session.instances.length,
          }
        }),
      }
    },
    [node],
    { enabled: canAct, disabledMessage: '' },
  )
  const data = read.state.kind === 'ready' ? read.state.data : undefined

  async function previewDraft() {
    if (busy || transactionBusy || !canAct || transaction === undefined || node === undefined || transactionState.status === 'uncertain') return
    const lines = parseDraftLines(draftText)
    const refusal = draftBatchRefusal(lines)
    if (refusal !== undefined) {
      // Zero sessions for a refused batch — the same free-refusal contract every screen pins.
      await operation.run(async () => { throw new Error(refusal) })
      return
    }
    await operation.run(() => transaction.append({
      source: '/sessions',
      action: `manual draft (${String(lines.length)} line(s))`,
      commands: lines,
      display: lines,
      risks: [],
    }), {
      progress: 'Adding the draft to the shared transaction and reading the device diff…',
      success: 'Draft added; review the combined device diff before committing the transaction.',
    })
  }

  async function commitDraft() {
    if (busy || transactionBusy || transaction === undefined || transactionState.entries.length === 0 || transactionState.diff === undefined || transactionState.status !== 'ready') return
    const sessionName = transactionState.sessionName ?? 'shared transaction'
    const summary = transactionState.entries.map((entry) => `${entry.source}: ${entry.action}`).join(' · ')
    if (!await confirm({
      title: `Commit transaction ${sessionName}`,
      body: `Commit config session ${sessionName} (${String(transactionState.entries.length)} staged action(s): ${summary})? This writes RUNNING-CONFIG only \u2014 Startup-config was not changed, and this screen changes it only through the separate confirmed Save to startup action (DR-024 / DR-160 \u00a71). ${COMMIT_RECOVERY_NOTE}`,
      confirmLabel: 'Commit transaction to running-config',
      destructive: true,
      subject: sessionName,
    })) return
    const extraConfirmations = transactionState.entries.flatMap((entry) => entry.confirmations)
    for (const extra of extraConfirmations) {
      if (!await confirm({
        title: extra.title,
        body: extra.body,
        confirmLabel: extra.label,
        destructive: true,
        subject: extra.subject,
      })) return
    }
    const done = await operation.run(() => transaction.commit(), {
      progress: 'Committing the reviewed transaction…',
      success: 'Transaction committed to running-config. Startup-config was not changed (DR-024).',
      failureSuffix: COMMIT_RECOVERY_NOTE,
    })
    if (done.ok) read.reload()
  }

  async function abortDraft() {
    if (busy || transactionBusy || transaction === undefined || transactionState.entries.length === 0 || transactionState.status === 'uncertain') return
    const sessionName = transactionState.sessionName ?? 'shared transaction'
    if (!await confirm({ title: 'Abort this transaction', body: `Abort config session ${sessionName} and discard all ${String(transactionState.entries.length)} staged action(s)?`, confirmLabel: 'Abort transaction', destructive: true, subject: sessionName })) return
    const done = await operation.run(() => transaction.abort(), { success: `Session ${sessionName} was aborted; nothing was written to the device.` })
    if (done.ok) read.reload()
  }

  async function abortSession(name: string, dangerousLabel: string, timerNote?: string) {
    if (busy || !canAct || node === undefined) return
    if (!await confirm({
      title: `Abort pending session ${name}`,
      body: `Abort device session ${name} (${dangerousLabel})? Its staged changes are discarded. ${timerNote ?? 'A pending session holds the config lock, which is why new sessions keep failing with 1006 until it is cleared.'}`,
      confirmLabel: 'Abort pending session',
      destructive: true,
      subject: name,
    })) return
    const done = await operation.run(() => node.abortSession(name), { success: `Session ${name} was aborted on the device.` })
    if (done.ok) read.reload()
  }

  async function runRecovery() {
    if (busy || !canAct || node === undefined) return
    if (journalError !== undefined) {
      await operation.run(async () => { throw new Error(`The browser journal is unreadable (${journalError}); recovery would run without ages and abort nothing you actually own. Fix the storage before running it.`) })
      return
    }
    if (!await confirm({
      title: 'Run orphan recovery',
      body: 'recoverOrphans() lists the device sessions matching this client\'s ui- prefix and aborts the identifiable PENDING ones (journal-backed ages when present). Sessions with an armed commit timer or an unrecognised state are reported, never touched (DR-023/DR-050). Aborts are device writes.',
      confirmLabel: 'Show and abort identified pending sessions',
      destructive: true,
    })) return
    const done = await operation.run(async () => {
      const outcome = await node.recoverOrphans({ journal })
      const lines = describeRecovery(outcome as Parameters<typeof describeRecovery>[0])
      setRecoveryLines(lines)
      return lines
    }, { progress: 'Recovering orphan sessions…', success: 'Recovery finished; every bucket is listed below — nothing was dropped.' })
    if (done.ok) read.reload()
  }

  /**
   * #181 (DR-160 §1, option B): the app's ONLY startup-config write. Direct client verb, never a
   * draft-textarea line (the `DRAFT_FORBIDDEN_LINES` guard stays). Confirm default-cancels; cancel
   * performs no write. The copy reply is empty on this image, so the follow-up text read IS the
   * proof \u2014 an empty read fails loudly rather than claiming a save the reads cannot confirm.
   */
  async function saveToStartup() {
    if (busy || !canAct || node === undefined) return
    if (!await confirm({
      title: 'Save running-config to startup-config',
      body: `${SAVE_BLAST} ${SAVE_REPLY_FACT}`,
      confirmLabel: 'Copy running-config to startup-config',
      destructive: true,
    })) return
    const done = await operation.run(async () => {
      await node.copyRunningToStartup()
      const startup = await node.getConfig({ config: 'startup-config', as: 'string' })
      const text = startup.trim()
      if (text === '') {
        throw new Error('The copy command was sent, but the follow-up `show startup-config` read answered empty \u2014 on this image the copy reply text is empty, so the read is the only evidence, and an empty read cannot confirm the flash write. Verify startup-config on the device before trusting it.')
      }
      const evidence = { lines: text.split('\n').length, characters: text.length }
      setStartupSave(evidence)
      return evidence
    }, {
      progress: 'Copying running-config to startup-config and re-reading startup-config\u2026',
      success: 'Startup-config saved: the copy ran and the follow-up `show startup-config` read confirms it (DR-160 \u00a71 \u2014 the copy reply itself is empty on this image, so the read is the evidence).',
    })
    return done
  }

  async function runVerify() {
    if (busy || !canAct || node === undefined) return
    const configlet = verifyText
    if (configlet.trim() === '') {
      await operation.run(async () => { throw new Error('A verify preview needs configlet text; an empty one answers nothing.') })
      return
    }
    await operation.run(async () => {
      const outcome = await node.verifyConfig(configlet)
      setVerify({ outcome, label: VERIFY_LABEL })
      return outcome.entries.length
    }, { progress: 'Asking the device to normalise the configlet…', success: 'Preview answered — labelled below as clean-config normalisation, never as pre-flight for a specific diff (DR-061).' })
  }

  const draftView: DraftView | undefined = transactionState.sessionName === undefined ? undefined : {
    sessionName: transactionState.sessionName,
    entries: transactionState.entries,
    ...(transactionState.diff === undefined ? {} : { diff: transactionState.diff }),
    ...(transactionState.uncertainReason === undefined ? {} : { uncertainReason: transactionState.uncertainReason }),
    canCommit: transactionState.status === 'ready' && transactionState.canCommit,
  }

  const verifyUnmatched = verify?.outcome.unmatched.length
  const verifyFormat = verify === undefined ? undefined : String(verify.outcome.format)
  const verifyEntries: readonly VerifyEntryView[] | undefined = verify === undefined ? undefined : verify.outcome.entries.map((entry) => ({
    index: entry.index,
    configlet: entry.configlet,
    ...(entry.sessionConfigText === undefined ? {} : { normalised: entry.sessionConfigText }),
    missingAnswer: entry.sessionConfig === undefined,
  }))

  const state = !canAct || read.state.kind === 'error' ? 'failed' : read.state.kind === 'loading' ? 'loading' : 'ready'

  return <TransactionCenterView
    state={state}
    {...(read.state.kind === 'error' && read.state.message !== '' ? { readError: read.state.message } : {})}
    {...(proxyConfigured ? {} : { proxyPrompt: PROXY_PROMPT })}
    sessions={data?.sessions ?? []}
    endpoint={data?.endpoint ?? ''}
    draftText={draftText}
    onDraftTextChange={(value) => { setDraftText(value) }}
    onPreviewDraft={() => void previewDraft()}
    {...(draftView === undefined ? {} : { draft: draftView })}
    onCommitDraft={() => void commitDraft()}
    onAbortDraft={() => void abortDraft()}
    onAbortSession={(name, label, timer) => void abortSession(name, label, timer)}
    onRecovery={() => void runRecovery()}
    recoveryLines={recoveryLines}
    journalRows={journalRows}
    journalLoaded={journalLoaded}
    onReadJournal={loadJournal}
    {...(journalError === undefined ? {} : { journalError })}
    verifyText={verifyText}
    onVerifyTextChange={setVerifyText}
    onVerify={() => void runVerify()}
    verifyLabel={VERIFY_LABEL}
    onSaveToStartup={() => void saveToStartup()}
    {...(startupSave === undefined ? {} : { startupSave })}
    {...(verifyEntries === undefined || verifyUnmatched === undefined || verifyFormat === undefined ? {} : { verifyEntries, verifyUnmatched, verifyFormat })}
    busy={busy}
    canAct={canAct}
    notice={notice}
    failure={failure}
    onReload={() => { operation.clear(); read.reload(); loadJournal() }}
  />
}
