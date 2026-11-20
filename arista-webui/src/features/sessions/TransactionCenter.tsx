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
 * ## Out of scope (B4, #89 — owner authorization pending)
 *
 * `copy run start` policy, `configure replace`, `rollback*`, commit-timer UX, name-limit editing.
 * This screen names those absences rather than half-implementing them. The 2026-11-20 cEOS timer
 * capture (DR-148) answered the container mechanics — the session rows below surface the armed
 * timer with its abort-with-revert exit — but the physical persistence verbs stay fenced.
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

export type TransactionCenterClient = Pick<Node, 'listSessions' | 'abortSession' | 'recoverOrphans' | 'verifyConfig' | 'connection'>

export interface TransactionCenterProps {
  readonly node: TransactionCenterClient | undefined
  readonly proxyConfigured?: boolean
}

const PROXY_PROMPT = 'Local proxy is not configured. Set EAPI_HOST, EAPI_USER, and EAPI_PASS in arista-webui/.env.local, then restart Vite.'
const COMMIT_RECOVERY_NOTE = 'If this session is lost mid-commit, the change may still have applied — refresh the session table before any further action.'

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
      body: `Commit config session ${sessionName} (${String(transactionState.entries.length)} staged action(s): ${summary})? This writes RUNNING-CONFIG only — Startup-config was not changed and never will be from this screen (DR-024). ${COMMIT_RECOVERY_NOTE}`,
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
    {...(verifyEntries === undefined || verifyUnmatched === undefined || verifyFormat === undefined ? {} : { verifyEntries, verifyUnmatched, verifyFormat })}
    busy={busy}
    canAct={canAct}
    notice={notice}
    failure={failure}
    onReload={() => { operation.clear(); read.reload(); loadJournal() }}
  />
}
