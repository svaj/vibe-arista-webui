/**
 * #87 (VRRP slice): the VRRP virtual-router editor — route `#/routing/vrrp`. Container half of
 * the S8/S15/B3 split: it owns the reads, the three form states, and the staging calls; the
 * command TEXT comes from the CLIENT's own dry-run seam (`{ run: false }` on each field setter,
 * vrrp.ts:560-568) composed in `_vrrp_set` order by ./vrrp-rules.ts — never a field line this
 * screen wrote. The one literal exception is the delete line (client-pinned, vrrp.ts:588 — see
 * that module's header).
 *
 * ## Reads (SPEC-vrrp-editor.md, "Screen contract")
 *
 * - `node.vrrp.getAll()` — HARD: the configured (interface, vrid) table is the screen's subject;
 *   nothing can be compared, edited, or deleted against an unread table. An EMPTY table is a
 *   normal ready state (the switch runs zero groups today), never an error.
 * - `node.ipinterfaces.getAll()` — SOFT: feeds the create form's L3-interface candidate list. Its
 *   failure narrows the candidates to the interfaces the VRRP table already names, with the named
 *   note ({@link VRRP_L3_READ_UNAVAILABLE_NOTE}); the table, edit, and delete forms stay usable.
 * - `node.show('vrrp')` — SOFT: the device-side virtual-router count (the `#/routing` pattern;
 *   the element shape is unmodelled, so only the count renders).
 * - `node.show('version')` — silent soft identity chip (the standing pattern).
 *
 * ## Writes
 *
 * All three forms stage through the shared transaction coordinator (#141) and open no session
 * themselves; commit/abort belong to the Transaction Center. Create, delete, and the
 * enable/priority/preempt edits carry a per-entry second confirm whose body states the failover
 * blast honestly — measured on NO target (owner decision 2026-11-21: honest unmeasured copy, no
 * fabricated number). Description and advertisement-interval edits ship risks only. Creating a
 * (interface, vrid) the read already lists is refused in-form at zero appends; staging the value
 * the config already states is refused the same way (the StpGlobal already-says pattern). A device
 * refusal surfaces as its own `CommandError` at commit time (DR-057) and changes nothing.
 */
import { useState } from 'react'
import type { FormEvent } from 'react'
import { submodeCommands } from '@devhax-heavy-industries/arista-eapi'
import type { CommandSpec, IpInterface, VrrpVridTable } from '@devhax-heavy-industries/arista-eapi'

import { softErrorText, softRead, softValue, useDeviceRead } from '../../shared/use-device-read'
import type { DeviceIdentity } from '../../shared/identity'
import { identityFrom } from '../../shared/identity'
import { useOperation } from '../../shared/use-operation'
import { TransactionScope, useTransaction, useTransactionSnapshot } from '../sessions/TransactionContext'
import { stageLines } from '../staged-batch'
import { VrrpManagerView } from './VrrpManagerView'
import type { VrrpManagerViewProps } from './VrrpManagerView'
import { vrrpDeviceCount } from './routing-rules'
import type { ShowVrrpReply } from '../../eapi/show-contracts'
import {
  composeVrrpCreateLines,
  composeVrrpEditLine,
  parseVrrpCreateDraft,
  parseVrrpEditDraft,
  parseVrrpGroupTarget,
  vrrpCandidateInterfaces,
  vrrpCreateRisks,
  vrrpDeleteConfirmation,
  vrrpDeleteLine,
  vrrpDeleteRisks,
  vrrpEditAlreadySays,
  vrrpEditForcesConfirm,
  vrrpEditRisks,
  vrrpFailoverConfirmation,
  vrrpManagerRows,
  VRRP_L3_READ_UNAVAILABLE_NOTE,
} from './vrrp-rules'
import type { VrrpConfirmation, VrrpManagerNode, VrrpManagerRow } from './vrrp-rules'

// The typed `show('vrrp')` overload — same augmentation Routing/Mlag/Stp import.
import '../../eapi/show-contracts'

export type VrrpManagerClient = VrrpManagerNode

export interface VrrpManagerProps {
  readonly node: VrrpManagerClient | undefined
  readonly proxyConfigured?: boolean
}

interface ReadData {
  readonly table: ReadonlyMap<string, VrrpVridTable>
  /** `undefined` = the SOFT ipinterfaces read FAILED — candidates narrow, with the named note. */
  readonly l3?: ReadonlyMap<string, IpInterface>
  readonly vrrpShow?: ShowVrrpReply
  readonly vrrpShowFailure?: string
  readonly identity?: DeviceIdentity
}

interface PendingStage {
  readonly effectLabel: string
  readonly specs: readonly CommandSpec[]
  readonly display: readonly string[]
  readonly risks: readonly string[]
  readonly confirmations: readonly VrrpConfirmation[]
}

const PROXY_PROMPT = 'Local proxy is not configured. Set EAPI_HOST, EAPI_USER, and EAPI_PASS in arista-webui/.env.local, then restart Vite.'

const EMPTY_CREATE = { interfaceName: '', vrid: '', primaryIp: '', priority: '', description: '', preempt: '', startState: 'disabled' }
const EMPTY_EDIT = { target: '', field: '', value: '' }

export function VrrpManager(props: VrrpManagerProps) {
  return <TransactionScope node={props.node}><VrrpManagerWorkspace {...props} /></TransactionScope>
}

function VrrpManagerWorkspace({ node, proxyConfigured = true }: VrrpManagerProps) {
  const operation = useOperation()
  const { busy, notice, failure } = operation
  const transaction = useTransaction()
  const transactionState = useTransactionSnapshot()
  const transactionBusy = transactionState.status === 'opening' || transactionState.status === 'staging' || transactionState.status === 'committing' || transactionState.status === 'aborting'
  const canAct = proxyConfigured && node !== undefined && transaction !== undefined && transactionState.status !== 'uncertain'

  const [createDraft, setCreateDraft] = useState(EMPTY_CREATE)
  const [createError, setCreateError] = useState<string | undefined>(undefined)
  const [editDraft, setEditDraft] = useState(EMPTY_EDIT)
  const [editError, setEditError] = useState<string | undefined>(undefined)
  const [deleteTarget, setDeleteTarget] = useState('')
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined)

  const read = useDeviceRead<ReadData>(
    async () => {
      if (node === undefined) throw new Error('no device client')
      // The HARD read first: an empty table is the screen's normal state, a failure is the error branch.
      const table = await node.vrrp.getAll()
      // The L3 candidate list is SOFT: its failure narrows the create form only (named note).
      const l3Read = await softRead(node.ipinterfaces.getAll())
      const showRead = await softRead(node.show('vrrp'))
      const versionRead = await softRead(node.show('version'), { silent: true })
      const version = softValue(versionRead)
      const l3 = softValue(l3Read)
      return {
        table,
        ...(l3 === undefined ? {} : { l3 }),
        ...(softValue(showRead) === undefined ? { vrrpShowFailure: softErrorText(showRead) ?? 'The `show vrrp` read did not answer.' } : { vrrpShow: softValue(showRead) }),
        ...(version === undefined ? {} : { identity: identityFrom(version) }),
      }
    },
    [node],
    { enabled: canAct, disabledMessage: '' },
  )
  const data = read.state.kind === 'ready' ? read.state.data : undefined
  const rows: readonly VrrpManagerRow[] = data === undefined ? [] : vrrpManagerRows(data.table)
  const candidates = data === undefined ? [] : vrrpCandidateInterfaces([...data.table.keys()], data.l3 === undefined ? undefined : [...data.l3.keys()])

  function clearErrors() {
    setCreateError(undefined)
    setEditError(undefined)
    setDeleteError(undefined)
    operation.clear()
  }

  async function stage(pending: PendingStage) {
    if (busy || transactionBusy || !canAct || transaction === undefined) return
    await operation.run(() => transaction.append({
      source: '/routing/vrrp',
      action: pending.effectLabel,
      commands: pending.specs,
      display: pending.display,
      risks: pending.risks,
      ...(pending.confirmations.length > 0 ? { confirmations: pending.confirmations } : {}),
    }), {
      progress: 'Adding the VRRP change to the shared transaction…',
      success: 'VRRP change added to the transaction. Review the device diff, then commit in Transaction Center — the second confirm repeats the failover facts (unmeasured on any target).',
    })
  }

  /** Refuse a write while another staged batch owns this screen; returns true when blocked. */
  function stagingBusy(): boolean {
    if (busy || transactionBusy || !canAct || node === undefined) return true
    if (data === undefined) {
      operation.run(async () => { throw new Error('The VRRP table read has not answered, so nothing can be compared or staged against it.') }).catch(() => undefined)
      return true
    }
    return false
  }

  function beginCreate(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    clearErrors()
    if (stagingBusy() || node === undefined) return
    const outcome = parseVrrpCreateDraft(createDraft)
    if ('refusal' in outcome) { setCreateError(outcome.refusal); return }
    const plan = outcome.plan
    // Creating a (interface, vrid) the read already lists is refused at zero appends — the client
    // would re-property the existing group; the operator means Edit instead.
    if (data?.table.get(plan.interfaceName)?.has(plan.vrid) === true) {
      setCreateError(`\`${plan.interfaceName}\` already carries \`vrrp ${String(plan.vrid)}\` — this screen refuses to create over an existing group at zero appends. Use the Edit form (or Delete first) instead.`)
      return
    }
    void (async () => {
      const fieldLines = await composeVrrpCreateLines(node.vrrp, plan)
      const specs = submodeCommands(`interface ${plan.interfaceName}`, fieldLines)
      const lines = stageLines(specs)
      await stage({
        effectLabel: `create vrrp ${String(plan.vrid)} on ${plan.interfaceName}`,
        specs,
        display: lines,
        risks: vrrpCreateRisks(lines, plan.interfaceName),
        confirmations: [vrrpFailoverConfirmation(plan.interfaceName, plan.vrid, 'create')],
      })
      setCreateDraft(EMPTY_CREATE)
    })().catch((error: unknown) => {
      setCreateError(error instanceof Error ? `The client refused to compose that create: ${error.message}` : 'The client refused to compose that create.')
    })
  }

  function beginEdit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    clearErrors()
    if (stagingBusy() || node === undefined) return
    const outcome = parseVrrpEditDraft(editDraft)
    if ('refusal' in outcome) { setEditError(outcome.refusal); return }
    const plan = outcome.plan
    const current = data?.table.get(plan.interfaceName)?.get(plan.vrid)
    if (current === undefined) {
      setEditError(`\`${plan.interfaceName}/${String(plan.vrid)}\` is not in the table this read answered — reload, or use the Create form for a new group.`)
      return
    }
    if (vrrpEditAlreadySays(current, plan)) {
      setEditError(`The running-config already says that value for \`${plan.field}\` on \`${plan.interfaceName}/${String(plan.vrid)}\` — staging the same value again would be a no-op line, so this screen refuses it at zero appends.`)
      return
    }
    void (async () => {
      const line = await composeVrrpEditLine(node.vrrp, plan)
      const specs = submodeCommands(`interface ${plan.interfaceName}`, [line])
      const lines = stageLines(specs)
      await stage({
        effectLabel: `edit vrrp ${String(plan.vrid)} on ${plan.interfaceName}: ${plan.field}`,
        specs,
        display: lines,
        risks: vrrpEditRisks(lines, plan.interfaceName, plan.field),
        confirmations: vrrpEditForcesConfirm(plan.field) ? [vrrpFailoverConfirmation(plan.interfaceName, plan.vrid, plan.field)] : [],
      })
      setEditDraft(EMPTY_EDIT)
    })().catch((error: unknown) => {
      setEditError(error instanceof Error ? `The client refused to compose that edit: ${error.message}` : 'The client refused to compose that edit.')
    })
  }

  function beginDelete(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    clearErrors()
    if (stagingBusy() || node === undefined) return
    const target = parseVrrpGroupTarget(deleteTarget)
    if (target === undefined) { setDeleteError('Choose the virtual router to delete — the picker lists every (interface, VRID) pair this read answered.'); return }
    if (data?.table.get(target.interfaceName)?.has(target.vrid) !== true) {
      setDeleteError(`\`${target.interfaceName}/${String(target.vrid)}\` is not in the table this read answered — nothing was staged.`)
      return
    }
    // The ONE literal this screen composes by hand: delete() has no dry-run arm (vrrp.ts:588), so
    // the line is the client's own era-free literal — see vrrpDeleteLine's citation.
    const specs = submodeCommands(`interface ${target.interfaceName}`, [vrrpDeleteLine(target.vrid)])
    const lines = stageLines(specs)
    void stage({
      effectLabel: `delete vrrp ${String(target.vrid)} on ${target.interfaceName}`,
      specs,
      display: lines,
      risks: vrrpDeleteRisks(lines, target.interfaceName, target.vrid),
      confirmations: [vrrpDeleteConfirmation(target.interfaceName, target.vrid)],
    })
    setDeleteTarget('')
  }

  const state = !canAct || read.state.kind === 'error' ? 'failed' : read.state.kind === 'loading' ? 'loading' : 'ready'

  const viewProps: VrrpManagerViewProps = {
    state,
    ...(read.state.kind === 'error' && read.state.message !== '' ? { readError: read.state.message } : {}),
    ...(proxyConfigured ? {} : { proxyPrompt: PROXY_PROMPT }),
    ...(data?.identity === undefined ? {} : { identity: data.identity }),
    configKnown: data !== undefined,
    rows,
    ...(data === undefined || data.vrrpShow === undefined ? {} : { deviceCount: vrrpDeviceCount(data.vrrpShow) }),
    ...(data?.vrrpShowFailure === undefined ? {} : { deviceCountFailure: data.vrrpShowFailure }),
    candidates,
    l3ReadFailed: data !== undefined && data.l3 === undefined,
    l3ReadNote: VRRP_L3_READ_UNAVAILABLE_NOTE,
    createDraft,
    ...(createError === undefined ? {} : { createError }),
    onCreateChange: (patch) => { setCreateDraft((draft) => ({ ...draft, ...patch })); setCreateError(undefined) },
    onCreateSubmit: beginCreate,
    editDraft,
    ...(editError === undefined ? {} : { editError }),
    onEditChange: (patch) => { setEditDraft((draft) => ({ ...draft, ...patch })); setEditError(undefined) },
    onEditSubmit: beginEdit,
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
        ? 'Reading the configured VRRP table…'
        : state === 'failed'
          ? 'The VRRP table read did not come back'
          : 'Configured VRRP groups read from the parsed running-config',
    onReload: () => { clearErrors(); read.reload() },
  }

  return <VrrpManagerView {...viewProps} />
}
