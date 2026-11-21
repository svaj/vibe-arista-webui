/**
 * #87 (route-map slice): the route-map clause editor — route `#/routing/routemaps`. Container
 * half of the S8/S15/B3 split: it owns the reads, the six form states, and the staging calls;
 * every composed line comes from ./routemap-rules.ts, byte-for-byte the sequence the CLIENT's
 * own `routemaps` verbs would send (the verbs are send-only — no dry-run arm — so mirroring the
 * client's test-pinned composition IS the command-text pin; see that module's header).
 *
 * ## Reads (SPEC-routemap-editor.md, "Screen contract")
 *
 * - `node.routemaps.getAll()` — HARD: the `name → action → seqno` clause table is the screen's
 *   subject; nothing can be compared, edited, or deleted against an unread table. An EMPTY table
 *   is a normal ready state (the box runs zero route maps today), never an error.
 * - `node.ospf.get()` — SOFT: the reference detector. `redistributions[].routeMap` names which
 *   maps are live policy; `undefined` (no OSPF process) is a NORMAL answer meaning "the check ran
 *   and found nothing". Its failure mutes the references panel with a named note and switches
 *   every confirm to the "cannot say — treat as referenced" arm; the table and forms stay usable.
 * - `node.show('route-map')` — SOFT: the device-side count (the `#/routing` pattern).
 * - `node.show('version')` — silent soft identity chip (the standing pattern).
 *
 * ## Writes
 *
 * All six forms stage through the shared transaction coordinator (#141) and open no session
 * themselves; commit/abort belong to the Transaction Center. Create, the two statement replaces,
 * and continue set/unset carry a per-entry second confirm whose body states the reference status
 * as read fact (referenced / unreferenced-in-what-this-UI-can-see / unknown) plus the
 * container-only blast proxy; description edits ship risks only; delete is destructive with the
 * whole-clause + last-clause-deletes-the-name facts. Creating an existing clause, a replace whose
 * diff is empty, and already-said description/continue values are all refused at zero appends. A
 * device refusal surfaces as its own `CommandError` at commit time (DR-057) and changes nothing.
 */
import { useState } from 'react'
import type { FormEvent } from 'react'
import type { Node, OspfState } from '@devhax-heavy-industries/arista-eapi'

import { softErrorText, softRead, softValue, useDeviceRead } from '../../shared/use-device-read'
import type { DeviceIdentity } from '../../shared/identity'
import { identityFrom } from '../../shared/identity'
import { useOperation } from '../../shared/use-operation'
import { TransactionScope, useTransaction, useTransactionSnapshot } from '../sessions/TransactionContext'
import { RouteMapManagerView } from './RouteMapManagerView'
import type { RouteMapManagerViewProps } from './RouteMapManagerView'
import { routeMapDeviceRows } from './routing-rules'
import type { ShowRouteMapReply } from '../../eapi/show-contracts'
import {
  parseRoutemapClauseDraft,
  parseRoutemapClauseTarget,
  parseRoutemapStatementList,
  routemapClauseAttrs,
  routemapCreateLines,
  routemapDeleteConfirmation,
  routemapDeleteLines,
  routemapDeleteRisks,
  routemapDescriptionLines,
  routemapEditConfirmation,
  routemapEditRisks,
  routemapManagerRows,
  routemapReference,
  routemapReplaceLines,
  routemapSetContinueLines,
  routemapUnsetContinueLines,
  ROUTEMAP_OSPF_READ_UNAVAILABLE_NOTE,
  validateRoutemapContinueValue,
  validateRoutemapDescription,
  validateRoutemapStatementList,
} from './routemap-rules'
import type { RoutemapClauses, RoutemapConfirmation, RoutemapManagerRow } from './routemap-rules'

// The typed `show('route-map')` overload — same augmentation Routing/VrrpManager import.
import '../../eapi/show-contracts'

/** The four model seams plus nothing else — the type itself cannot reach a write verb. */
export type RouteMapManagerClient = Pick<Node, 'routemaps' | 'ospf' | 'show' | 'configSession'>

export interface RouteMapManagerProps {
  readonly node: RouteMapManagerClient | undefined
  readonly proxyConfigured?: boolean
}

interface ReadData {
  readonly table: ReadonlyMap<string, RoutemapClauses>
  /** `undefined` = no OSPF process (a NORMAL answer — the check ran and found nothing). */
  readonly ospf?: OspfState
  readonly ospfReadFailed: boolean
  readonly routeMapShow?: ShowRouteMapReply
  readonly routeMapShowFailure?: string
  readonly identity?: DeviceIdentity
}

interface PendingStage {
  readonly effectLabel: string
  readonly lines: readonly string[]
  readonly risks: readonly string[]
  readonly confirmations: readonly RoutemapConfirmation[]
}

const PROXY_PROMPT = 'Local proxy is not configured. Set EAPI_HOST, EAPI_USER, and EAPI_PASS in arista-webui/.env.local, then restart Vite.'

const EMPTY_CREATE = { name: '', action: '', seqno: '' }
const EMPTY_REPLACE = { target: '', keyword: '', text: '' }
const EMPTY_DESCRIPTION = { target: '', value: '' }
const EMPTY_CONTINUE = { target: '', mode: '', value: '' }

export function RouteMapManager(props: RouteMapManagerProps) {
  return <TransactionScope node={props.node}><RouteMapManagerWorkspace {...props} /></TransactionScope>
}

function RouteMapManagerWorkspace({ node, proxyConfigured = true }: RouteMapManagerProps) {
  const operation = useOperation()
  const { busy, notice, failure } = operation
  const transaction = useTransaction()
  const transactionState = useTransactionSnapshot()
  const transactionBusy = transactionState.status === 'opening' || transactionState.status === 'staging' || transactionState.status === 'committing' || transactionState.status === 'aborting'
  const canAct = proxyConfigured && node !== undefined && transaction !== undefined && transactionState.status !== 'uncertain'

  const [createDraft, setCreateDraft] = useState(EMPTY_CREATE)
  const [createError, setCreateError] = useState<string | undefined>(undefined)
  const [replaceDraft, setReplaceDraft] = useState(EMPTY_REPLACE)
  const [replaceError, setReplaceError] = useState<string | undefined>(undefined)
  const [descriptionDraft, setDescriptionDraft] = useState(EMPTY_DESCRIPTION)
  const [descriptionError, setDescriptionError] = useState<string | undefined>(undefined)
  const [continueDraft, setContinueDraft] = useState(EMPTY_CONTINUE)
  const [continueError, setContinueError] = useState<string | undefined>(undefined)
  const [deleteTarget, setDeleteTarget] = useState('')
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined)

  const read = useDeviceRead<ReadData>(
    async () => {
      if (node === undefined) throw new Error('no device client')
      // The HARD read first: an empty table is the screen's normal state, a failure is the error branch.
      const table = await node.routemaps.getAll()
      // The reference detector is SOFT: its failure mutes the panel and arms the unknown copy.
      const ospfRead = await softRead(node.ospf.get())
      const ospfFailed = ospfRead.kind === 'failed'
      const showRead = await softRead(node.show('route-map'))
      const versionRead = await softRead(node.show('version'), { silent: true })
      const version = softValue(versionRead)
      const ospf = softValue(ospfRead)
      return {
        table,
        ...(ospf === undefined || ospfFailed ? {} : { ospf }),
        ospfReadFailed: ospfFailed,
        ...(softValue(showRead) === undefined ? { routeMapShowFailure: softErrorText(showRead) ?? 'The `show route-map` read did not answer.' } : { routeMapShow: softValue(showRead) }),
        ...(version === undefined ? {} : { identity: identityFrom(version) }),
      }
    },
    [node],
    { enabled: canAct, disabledMessage: '' },
  )
  const data = read.state.kind === 'ready' ? read.state.data : undefined
  const rows: readonly RoutemapManagerRow[] = data === undefined ? [] : routemapManagerRows(data.table)

  function referenceFor(name: string) {
    return routemapReference(name, data?.ospf, data?.ospfReadFailed === true)
  }

  function clearErrors() {
    setCreateError(undefined)
    setReplaceError(undefined)
    setDescriptionError(undefined)
    setContinueError(undefined)
    setDeleteError(undefined)
    operation.clear()
  }

  async function stage(pending: PendingStage) {
    if (busy || transactionBusy || !canAct || transaction === undefined) return
    await operation.run(() => transaction.append({
      source: '/routing/routemaps',
      action: pending.effectLabel,
      commands: pending.lines,
      display: pending.lines,
      risks: pending.risks,
      ...(pending.confirmations.length > 0 ? { confirmations: pending.confirmations } : {}),
    }), {
      progress: 'Adding the route-map change to the shared transaction…',
      success: 'Route-map change added to the transaction. Review the device diff, then commit in Transaction Center — the second confirm repeats the reference status and the blast proxy.',
    })
  }

  /** Refuse a write while another staged batch owns this screen; returns true when blocked. */
  function stagingBusy(): boolean {
    if (busy || transactionBusy || !canAct || node === undefined) return true
    if (data === undefined) {
      operation.run(async () => { throw new Error('The route-map table read has not answered, so nothing can be compared or staged against it.') }).catch(() => undefined)
      return true
    }
    return false
  }

  function beginCreate(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    clearErrors()
    if (stagingBusy()) return
    const outcome = parseRoutemapClauseDraft(createDraft)
    if ('refusal' in outcome) { setCreateError(outcome.refusal); return }
    const clause = outcome.clause
    // Creating a clause the read already lists is refused at zero appends — the header line would
    // re-open the existing clause; the operator means the edit forms.
    if (routemapClauseAttrs(data?.table ?? new Map(), clause) !== undefined) {
      setCreateError(`\`${clause.name} ${clause.action} ${clause.seqno}\` already exists — this screen refuses to create over an existing clause at zero appends. Use the statement, description, or continue forms (or Delete first) instead.`)
      return
    }
    const lines = routemapCreateLines(clause)
    void stage({
      effectLabel: `create route-map ${clause.name} ${clause.action} ${clause.seqno}`,
      lines,
      risks: routemapEditRisks(lines, referenceFor(clause.name), clause.name),
      confirmations: [routemapEditConfirmation('clause', clause, referenceFor(clause.name))],
    })
    setCreateDraft(EMPTY_CREATE)
  }

  /** The replace form: one keyword (match or set), the draft list diffed against the read. */
  function beginReplace(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    clearErrors()
    if (stagingBusy()) return
    const target = parseRoutemapClauseTarget(replaceDraft.target)
    if (target === undefined) { setReplaceError('Choose the clause whose statements you are replacing — the picker lists every (name, action, seqno) this read answered.'); return }
    if (replaceDraft.keyword !== 'match' && replaceDraft.keyword !== 'set') { setReplaceError('Choose which statement list to replace — match or set. The other list is never touched by this form.'); return }
    const current = routemapClauseAttrs(data?.table ?? new Map(), target)
    if (current === undefined) { setReplaceError(`\`${target.name}/${target.action}/${target.seqno}\` is not in the table this read answered — reload, or use the Create form for a new clause.`); return }
    const keyword = replaceDraft.keyword
    const wanted = parseRoutemapStatementList(replaceDraft.text)
    const listRefusal = validateRoutemapStatementList(wanted, keyword)
    if (listRefusal !== undefined) { setReplaceError(listRefusal); return }
    const lines = routemapReplaceLines(target, keyword, current[keyword], wanted)
    // The client sends NOTHING for an empty diff (routemaps.ts:501); this screen refuses it at
    // zero appends rather than staging an empty batch.
    if (lines.length === 0) {
      setReplaceError(`The draft list already equals the clause's current \`${keyword}\` statements — staging that diff would send nothing, so this screen refuses it at zero appends.`)
      return
    }
    void stage({
      effectLabel: `replace ${keyword} statements on route-map ${target.name} ${target.action} ${target.seqno}`,
      lines,
      risks: routemapEditRisks(lines, referenceFor(target.name), target.name),
      confirmations: [routemapEditConfirmation(`${keyword} replace`, target, referenceFor(target.name))],
    })
    setReplaceDraft(EMPTY_REPLACE)
  }

  function beginDescription(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    clearErrors()
    if (stagingBusy()) return
    const target = parseRoutemapClauseTarget(descriptionDraft.target)
    if (target === undefined) { setDescriptionError('Choose the clause to describe — the picker lists every (name, action, seqno) this read answered.'); return }
    const refusal = validateRoutemapDescription(descriptionDraft.value)
    if (refusal !== undefined) { setDescriptionError(refusal); return }
    const current = routemapClauseAttrs(data?.table ?? new Map(), target)
    if (current === undefined) { setDescriptionError(`\`${target.name}/${target.action}/${target.seqno}\` is not in the table this read answered — reload, or use the Create form for a new clause.`); return }
    if (current.description === descriptionDraft.value) {
      setDescriptionError(`The clause's description already says exactly that — staging the clear-then-set pair again would be a no-op, so this screen refuses it at zero appends.`)
      return
    }
    const lines = routemapDescriptionLines(target, descriptionDraft.value)
    void stage({
      effectLabel: `set description on route-map ${target.name} ${target.action} ${target.seqno}`,
      lines,
      // A description line changes no policy — risks only, no second confirm (spec copy table).
      risks: routemapEditRisks(lines, referenceFor(target.name), target.name),
      confirmations: [],
    })
    setDescriptionDraft(EMPTY_DESCRIPTION)
  }

  function beginContinue(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    clearErrors()
    if (stagingBusy()) return
    const target = parseRoutemapClauseTarget(continueDraft.target)
    if (target === undefined) { setContinueError('Choose the clause whose continue value you are changing — the picker lists every (name, action, seqno) this read answered.'); return }
    if (continueDraft.mode !== 'set' && continueDraft.mode !== 'unset') { setContinueError('Choose set or clear for the continue value.'); return }
    const current = routemapClauseAttrs(data?.table ?? new Map(), target)
    if (current === undefined) { setContinueError(`\`${target.name}/${target.action}/${target.seqno}\` is not in the table this read answered — reload, or use the Create form for a new clause.`); return }
    if (continueDraft.mode === 'set') {
      const refusal = validateRoutemapContinueValue(continueDraft.value)
      if (refusal !== undefined) { setContinueError(refusal); return }
      if (current.continue === Number(continueDraft.value)) {
        setContinueError(`The clause's continue already says \`${continueDraft.value}\` — staging the same value again would be a no-op line, so this screen refuses it at zero appends.`)
        return
      }
    } else if (current.continue === undefined) {
      setContinueError('The clause carries no `continue` line to clear — staging `no continue` against nothing would be a no-op line, so this screen refuses it at zero appends.')
      return
    }
    const lines = continueDraft.mode === 'set' ? routemapSetContinueLines(target, continueDraft.value) : routemapUnsetContinueLines(target)
    void stage({
      effectLabel: `${continueDraft.mode === 'set' ? 'set' : 'clear'} continue on route-map ${target.name} ${target.action} ${target.seqno}`,
      lines,
      risks: routemapEditRisks(lines, referenceFor(target.name), target.name),
      confirmations: [routemapEditConfirmation(continueDraft.mode === 'set' ? 'continue set' : 'continue clear', target, referenceFor(target.name))],
    })
    setContinueDraft(EMPTY_CONTINUE)
  }

  function beginDelete(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    clearErrors()
    if (stagingBusy()) return
    const target = parseRoutemapClauseTarget(deleteTarget)
    if (target === undefined) { setDeleteError('Choose the clause to delete — the picker lists every (name, action, seqno) this read answered.'); return }
    if (routemapClauseAttrs(data?.table ?? new Map(), target) === undefined) {
      setDeleteError(`\`${target.name}/${target.action}/${target.seqno}\` is not in the table this read answered — nothing was staged.`)
      return
    }
    const lines = routemapDeleteLines(target)
    void stage({
      effectLabel: `delete route-map ${target.name} ${target.action} ${target.seqno}`,
      lines,
      risks: routemapDeleteRisks(lines, referenceFor(target.name), target),
      confirmations: [routemapDeleteConfirmation(target, referenceFor(target.name))],
    })
    setDeleteTarget('')
  }

  /** The replace form's textarea prefills from the read when target+keyword land (spec UX). */
  function replaceDraftText(target: string, keyword: string): string {
    const clause = parseRoutemapClauseTarget(target)
    if (clause === undefined || (keyword !== 'match' && keyword !== 'set')) return ''
    const attrs = routemapClauseAttrs(data?.table ?? new Map(), clause)
    if (attrs === undefined) return ''
    return attrs[keyword].join('\n')
  }

  const state = !canAct || read.state.kind === 'error' ? 'failed' : read.state.kind === 'loading' ? 'loading' : 'ready'

  const viewProps: RouteMapManagerViewProps = {
    state,
    ...(read.state.kind === 'error' && read.state.message !== '' ? { readError: read.state.message } : {}),
    ...(proxyConfigured ? {} : { proxyPrompt: PROXY_PROMPT }),
    ...(data?.identity === undefined ? {} : { identity: data.identity }),
    configKnown: data !== undefined,
    rows,
    references: rows.map((row) => ({ target: `${row.name}/${row.action}/${row.seqno}`, name: row.name, reference: referenceFor(row.name) })),
    ...(data === undefined || data.routeMapShow === undefined ? {} : { deviceRows: routeMapDeviceRows(data.routeMapShow) }),
    ...(data?.routeMapShowFailure === undefined ? {} : { deviceCountFailure: data.routeMapShowFailure }),
    ...(data?.ospfReadFailed === true ? { ospfReadFailed: true, ospfReadNote: ROUTEMAP_OSPF_READ_UNAVAILABLE_NOTE } : {}),
    createDraft,
    ...(createError === undefined ? {} : { createError }),
    onCreateChange: (patch) => { setCreateDraft((draft) => ({ ...draft, ...patch })); setCreateError(undefined) },
    onCreateSubmit: beginCreate,
    replaceDraft,
    ...(replaceError === undefined ? {} : { replaceError }),
    onReplaceChange: (patch) => {
      setReplaceDraft((draft) => {
        const next = { ...draft, ...patch }
        // Prefill the textarea from the read whenever the clause or keyword changes.
        if (patch.target !== undefined || patch.keyword !== undefined) next.text = replaceDraftText(next.target, next.keyword)
        return next
      })
      setReplaceError(undefined)
    },
    onReplaceSubmit: beginReplace,
    descriptionDraft,
    ...(descriptionError === undefined ? {} : { descriptionError }),
    onDescriptionChange: (patch) => { setDescriptionDraft((draft) => ({ ...draft, ...patch })); setDescriptionError(undefined) },
    onDescriptionSubmit: beginDescription,
    continueDraft,
    ...(continueError === undefined ? {} : { continueError }),
    onContinueChange: (patch) => { setContinueDraft((draft) => ({ ...draft, ...patch })); setContinueError(undefined) },
    onContinueSubmit: beginContinue,
    deleteTarget,
    ...(deleteError === undefined ? {} : { deleteError }),
    onDeleteTargetChange: (value) => { setDeleteTarget(value); setDeleteError(undefined) },
    onDeleteSubmit: beginDelete,
    busy: busy || transactionBusy,
    canAct: canAct && state === 'ready',
    notice,
    failure,
    connection: !canAct || state === 'failed' ? 'error' : state === 'loading' || busy || transactionBusy ? 'connecting' : 'connected',
    connectionLabel: !canAct
      ? 'Local proxy is not configured'
      : state === 'loading'
        ? 'Reading the configured route-map clauses…'
        : state === 'failed'
          ? 'The route-map table read did not come back'
          : 'Configured route-map clauses read from the parsed running-config',
    onReload: () => { clearErrors(); read.reload() },
  }

  return <RouteMapManagerView {...viewProps} />
}
