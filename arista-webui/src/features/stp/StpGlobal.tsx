/**
 * B3 (#88) step 2: the spanning-tree GLOBAL screen — route `#/stp/global`. Container half of the
 * S8/S15 split: it owns the reads, the form state, and the staging calls; every composed string
 * comes from ./stp-global-rules.ts (capture-pinned, never invented — see that header for the
 * evidence each line cites and the recorded convention deviation).
 *
 * ## Reads (SPEC-stp-global-editor.md, "Screen contract")
 *
 * - `node.stp.get()` — HARD: the verbatim `spanning-tree mode` token (client §5 row 167, DR-096
 *   read side). Its failure fails the screen; nothing can be staged against an unread mode.
 * - `node.chunkConfig()` — SOFT: the `spanning-tree mst configuration` section. Its failure mutes
 *   ONLY the region panel with a named reason ({@link STP_REGION_READ_UNAVAILABLE_NOTE}); the mode
 *   form stays usable. The section is absent on a box with no region configured — that is a
 *   normal ready state rendered as "no MST region configured", never an error.
 * - `node.show('version')` — silent soft identity chip (the standing pattern).
 *
 * ## Writes
 *
 * Both forms stage through the shared transaction coordinator (#141) and open no session
 * themselves; commit/abort belong to the Transaction Center. Mode changes and region
 * name/revision changes are `destructive` and carry a per-entry second confirm whose body quotes
 * the captured blast facts (DR-149: facts, not adjectives; no hygiene gate — the far-end sentence
 * is a note, not a check). `rapid-pvst` is offered ONLY with its container-only-acceptance
 * disclosure visible in-form before staging (owner decision 2026-11-21); a device refusal returns
 * as the device's own `CommandError` at commit time (DR-057) and changes nothing.
 */
import { useState } from 'react'
import type { FormEvent } from 'react'
import { submodeCommands } from '@devhax-heavy-industries/arista-eapi'
import type { CommandSpec, Node, StpSettings as DeviceSettings } from '@devhax-heavy-industries/arista-eapi'

import { softRead, softValue, useDeviceRead } from '../../shared/use-device-read'
import type { DeviceIdentity } from '../../shared/identity'
import { identityFrom } from '../../shared/identity'
import { useOperation } from '../../shared/use-operation'
import { TransactionScope, useTransaction, useTransactionSnapshot } from '../sessions/TransactionContext'
import { stageLines } from '../staged-batch'
import { StpGlobalView } from './StpGlobalView'
import type { StpGlobalViewProps } from './StpGlobalView'
import {
  isStpGlobalModeChoice,
  parseStpRegionSection,
  stpModeConfirmation,
  stpModeLine,
  stpModeRisks,
  stpRegionChildLines,
  stpRegionDraftIsEmpty,
  stpRegionIdentityConfirmation,
  stpRegionRisks,
  validateStpInstanceId,
  validateStpRegionName,
  validateStpRegionRevision,
  validateStpVlanRanges,
} from './stp-global-rules'
import type { MstRegionDraft, MstRegionView } from './stp-global-rules'

// The typed `show('version')` overload — same augmentation S6/S8/S15 import.
import '../../eapi/show-contracts'

export type StpGlobalClient = Pick<Node, 'stp' | 'show' | 'chunkConfig' | 'configSession'>

export interface StpGlobalProps {
  readonly node: StpGlobalClient | undefined
  readonly proxyConfigured?: boolean
}

/** The chunker key the MST region block hangs under (the capture's indent-0 header, verbatim). */
const REGION_SECTION_KEY = 'spanning-tree mst configuration'

/** Named reason when the SOFT region read failed — the mode form stays usable (spec contract). */
const STP_REGION_READ_UNAVAILABLE_NOTE =
  'The `running-config` region read did not answer on this device, so the MST region panel is muted and the region form is disabled. This is a read failure on this device right now, not a claim that no region is configured — reload to retry.'

interface ReadData {
  readonly settings: DeviceSettings
  readonly identity?: DeviceIdentity
  /** True once the soft chunk read resolved — the panel distinguishes "unread" from "no block". */
  readonly regionKnown: boolean
  /** The parsed block, or `undefined` when the running-config carries no region section. */
  readonly region?: MstRegionView & { readonly unmodelledLines: number }
  readonly regionUnavailable?: boolean
}

interface PendingStage {
  readonly effectLabel: string
  readonly specs: readonly CommandSpec[]
  readonly display: readonly string[]
  readonly risks: readonly string[]
  readonly confirmations: readonly { title: string; body: string; label: string; subject: string }[]
}

const PROXY_PROMPT = 'Local proxy is not configured. Set EAPI_HOST, EAPI_USER, and EAPI_PASS in arista-webui/.env.local, then restart Vite.'

export function StpGlobal(props: StpGlobalProps) {
  return <TransactionScope node={props.node}><StpGlobalWorkspace {...props} /></TransactionScope>
}

function StpGlobalWorkspace({ node, proxyConfigured = true }: StpGlobalProps) {
  const operation = useOperation()
  const { busy, notice, failure } = operation
  const transaction = useTransaction()
  const transactionState = useTransactionSnapshot()
  const transactionBusy = transactionState.status === 'opening' || transactionState.status === 'staging' || transactionState.status === 'committing' || transactionState.status === 'aborting'
  const canAct = proxyConfigured && node !== undefined && transaction !== undefined && transactionState.status !== 'uncertain'

  const [selectedMode, setSelectedMode] = useState('')
  const [modeError, setModeError] = useState<string | undefined>(undefined)

  const [regionName, setRegionName] = useState('')
  const [regionRevision, setRegionRevision] = useState('')
  const [instanceRows, setInstanceRows] = useState<readonly { id: string; vlans: string }[]>([])
  const [instanceIdDraft, setInstanceIdDraft] = useState('')
  const [instanceVlansDraft, setInstanceVlansDraft] = useState('')
  // Instance ids marked for removal, taken from the READ block only — the removal line is the
  // capture-backed bare `no instance <id>` (rea-q2, unblock-grammar-ceos.json).
  const [removeInstanceIds, setRemoveInstanceIds] = useState<readonly string[]>([])
  const [regionError, setRegionError] = useState<string | undefined>(undefined)

  const read = useDeviceRead<ReadData>(
    async () => {
      if (node === undefined) throw new Error('no device client')
      const settings = await node.stp.get()
      const version = softValue(await softRead(node.show('version'), { silent: true }))
      // The region block is config text (the show JSON carries no region fields — verified in the
      // cEOS capture), read SOFT: its failure mutes the region panel only, never the mode form.
      const chunks = softValue(await softRead(node.chunkConfig()))
      const section = chunks?.get(REGION_SECTION_KEY)
      return {
        settings,
        ...(version === undefined ? {} : { identity: identityFrom(version) }),
        regionKnown: chunks !== undefined,
        ...(chunks === undefined ? { regionUnavailable: true } : {}),
        ...(chunks === undefined || section === undefined ? {} : { region: parseStpRegionSection(section) }),
      }
    },
    [node],
    { enabled: canAct, disabledMessage: '' },
  )
  const data = read.state.kind === 'ready' ? read.state.data : undefined
  const settings = data?.settings

  function clearErrors() {
    setModeError(undefined)
    setRegionError(undefined)
    operation.clear()
  }

  async function stage(stage: PendingStage) {
    if (busy || transactionBusy || !canAct || transaction === undefined) return
    await operation.run(() => transaction.append({
      source: '/stp/global',
      action: stage.effectLabel,
      commands: stage.specs,
      display: stage.display,
      risks: stage.risks,
      ...(stage.confirmations.length > 0 ? { confirmations: stage.confirmations } : {}),
    }), {
      progress: 'Adding the spanning-tree change to the shared transaction…',
      success: 'Spanning-tree change added to the transaction. Review the device diff, then commit in Transaction Center — the second confirm repeats the blast facts.',
    })
  }

  /** Refuse a write while another staged batch owns this screen; returns true when blocked. */
  function stagingBusy(): boolean {
    if (busy || transactionBusy || !canAct || node === undefined) return true
    if (settings === undefined) {
      operation.run(async () => { throw new Error('The spanning-tree read has not answered, so nothing can be compared or staged against it.') }).catch(() => undefined)
      return true
    }
    return false
  }

  function beginModeChange(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    clearErrors()
    if (stagingBusy()) return
    if (!isStpGlobalModeChoice(selectedMode)) {
      setModeError('Choose a target mode first — this screen stages exactly one `spanning-tree mode …` line, and only the three values whose evidence is on record.')
      return
    }
    const current = settings?.mode
    if (current !== undefined && current === selectedMode) {
      setModeError(`The running-config already says \`${current}\` — staging the same mode again would be a no-op line, so this screen refuses it at zero sessions.`)
      return
    }
    const specs: readonly CommandSpec[] = [stpModeLine(selectedMode)]
    const lines = stageLines(specs)
    void stage({
      effectLabel: `spanning-tree mode ${selectedMode}`,
      specs,
      display: lines,
      risks: stpModeRisks(selectedMode, lines),
      confirmations: [stpModeConfirmation(selectedMode)],
    })
  }

  /** The Add-row button is a plain button (not a submit): the outer form's submit is the staging
      action, and a draft row is only a form-local value until `Stage region edit` composes it. */
  function addInstanceRow(): void {
    clearErrors()
    const refusal = validateStpInstanceId(instanceIdDraft) ?? (instanceVlansDraft === '' ? validateStpVlanRanges(instanceVlansDraft) : undefined)
    if (refusal !== undefined) { setRegionError(refusal); return }
    setInstanceRows((rows) => [...rows, { id: instanceIdDraft, vlans: instanceVlansDraft }])
    setInstanceIdDraft('')
    setInstanceVlansDraft('')
  }

  function removeInstanceRow(index: number): void {
    setInstanceRows((rows) => rows.filter((_, i) => i !== index))
  }

  /** Toggle a READ mapping's removal mark. The id comes from the parsed block, never the form. */
  function toggleRemoveInstance(id: string): void {
    clearErrors()
    setRemoveInstanceIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]))
  }

  function beginRegionChange(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    clearErrors()
    if (stagingBusy()) return
    const draft: MstRegionDraft = {
      ...(regionName === '' ? {} : { name: regionName }),
      ...(regionRevision === '' ? {} : { revision: regionRevision }),
      instances: instanceRows,
      ...(removeInstanceIds.length === 0 ? {} : { removeInstances: removeInstanceIds.map((id) => ({ id })) }),
    }
    if (stpRegionDraftIsEmpty(draft)) {
      setRegionError('Nothing to stage — change the name or revision, add an instance mapping row, or mark a read mapping for removal. This screen never stages an empty `spanning-tree mst configuration` block.')
      return
    }
    // An id can be added and removed in one draft only by accident — the two lines would fight
    // inside one session. Refuse at zero appends; the operator picks one intent per instance.
    const collision = removeInstanceIds.find((id) => instanceRows.some((row) => row.id === id))
    if (collision !== undefined) {
      setRegionError(`Instance ${collision} is both an added row and marked for removal — one draft stages one intent per instance id.`)
      return
    }
    const nameRefusal = validateStpRegionName(regionName) ?? validateStpRegionRevision(regionRevision)
    const rowRefusal = instanceRows.flatMap((row) => [validateStpInstanceId(row.id), validateStpVlanRanges(row.vlans)]).find((r) => r !== undefined)
    if (nameRefusal !== undefined || rowRefusal !== undefined) { setRegionError(nameRefusal ?? rowRefusal); return }
    const childLines = stpRegionChildLines(draft)
    // The parent line comes from the client's own composer (`submodeCommands`) — the same
    // in-submode framing every hardware-staged submode batch this app has sent uses.
    const specs = submodeCommands(REGION_SECTION_KEY, childLines)
    const lines = stageLines(specs)
    const identity = draft.name !== undefined || draft.revision !== undefined
    void stage({
      effectLabel: `MST region edit (${childLines.length} line(s))`,
      specs,
      display: lines,
      risks: stpRegionRisks(draft, lines),
      confirmations: identity
        ? [stpRegionIdentityConfirmation([draft.name === undefined ? '' : `name ${draft.name}`, draft.revision === undefined ? '' : `revision ${draft.revision}`].filter((s) => s !== '').join(', '))]
        : [],
    })
    setRegionName('')
    setRegionRevision('')
    setInstanceRows([])
    setRemoveInstanceIds([])
  }

  const state = !canAct || read.state.kind === 'error' ? 'failed' : read.state.kind === 'loading' ? 'loading' : 'ready'

  const viewProps: StpGlobalViewProps = {
    state,
    ...(read.state.kind === 'error' && read.state.message !== '' ? { readError: read.state.message } : {}),
    ...(proxyConfigured ? {} : { proxyPrompt: PROXY_PROMPT }),
    ...(data?.identity === undefined ? {} : { identity: data.identity }),
    modeKnown: settings !== undefined,
    ...(settings === undefined || settings.mode === undefined ? {} : { mode: settings.mode }),
    regionKnown: data?.regionKnown ?? false,
    ...(data?.region === undefined ? {} : { region: data.region }),
    ...(data?.regionUnavailable === true ? { regionUnavailable: true, regionUnavailableNote: STP_REGION_READ_UNAVAILABLE_NOTE } : {}),
    selectedMode,
    ...(modeError === undefined ? {} : { modeError }),
    onModeChange: (mode) => { setSelectedMode(mode); setModeError(undefined) },
    onModePreview: beginModeChange,
    regionName,
    regionRevision,
    instanceRows,
    instanceIdDraft,
    instanceVlansDraft,
    removeInstanceIds,
    ...(regionError === undefined ? {} : { regionError }),
    onRegionNameChange: (value) => { setRegionName(value); setRegionError(undefined) },
    onRegionRevisionChange: (value) => { setRegionRevision(value); setRegionError(undefined) },
    onInstanceIdDraftChange: (value) => { setInstanceIdDraft(value); setRegionError(undefined) },
    onInstanceVlansDraftChange: (value) => { setInstanceVlansDraft(value); setRegionError(undefined) },
    onAddInstanceRow: addInstanceRow,
    onRemoveInstanceRow: removeInstanceRow,
    onToggleRemoveInstance: toggleRemoveInstance,
    onRegionPreview: beginRegionChange,
    busy: busy || transactionBusy,
    canAct: canAct && state === 'ready',
    notice,
    failure,
    connection: !canAct || state === 'failed' ? 'error' : state === 'loading' || busy || transactionBusy ? 'connecting' : 'connected',
    connectionLabel: !canAct
      ? 'Local proxy is not configured'
      : state === 'loading'
        ? 'Reading the running-config…'
        : state === 'failed'
          ? 'The spanning-tree read did not come back'
          : 'Global spanning-tree state read from the parsed running-config',
    onReload: () => { clearErrors(); read.reload() },
  }

  return <StpGlobalView {...viewProps} />
}
