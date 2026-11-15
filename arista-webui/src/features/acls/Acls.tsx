/**
 * S13 (#83): the ACL viewer/editor — route `#/acls`. Container half of the S8 (#78) split: it owns the
 * reads, the form/draft state machines, the confirm calls, and the wiring to the command composition in
 * ./acl-rules.ts (read that file for why the text lives there and what the client refuses).
 *
 * ## Reads
 *
 * `node.acls.standard.getAll()` and `node.acls.extended.getAll()` (client `resources/acl.ts`: the parsed
 * `ip access-list [standard] <name>` sections) are the two hard reads, and both are config-backed: the
 * loading and failure copy names the running-config as the source, and an empty list for a kind is a
 * normal `ready` payload rendered with `EmptyState`, never an error. Either read failing fails the
 * screen — one half-read ACL page would invite a write against a listing the operator never saw.
 *
 * No `show` read is attempted. There is no `show access-lists` capture for this target, so this screen
 * shows no statistics ({@link COUNTER_GAP}), and no read in this client covers `ip access-group`, so it
 * never learns — and never claims — whether an interface applies an ACL ({@link REFERENCE_GAP}).
 *
 * ## Writes (named session; preview → device `diff()` → confirm → commit)
 *
 * Exactly the S12 (#82) shape: open a named session (`webui acl <action>`), stage the plain command
 * lines ./acl-rules.ts composes from the client's own builders, read the device `diff()`, then commit to
 * running-config only (startup-config never touched, DR-024; abort always offered). One staged session
 * at a time, and commit stays locked until the diff has actually been read.
 *
 * Deleting a section is ALWAYS destructive here: the risk list and the commit confirm both carry
 * {@link REFERENCE_GAP} verbatim and Preview is gated on an explicit acknowledgement that the check did
 * not happen. Entry writes are refused in-form — at zero sessions — whenever the client's own guards
 * would refuse them, whenever a rule carries text the verbs cannot re-emit
 * ({@link ruleReproducibility}), and whenever a sequence number would clash with one just listed.
 *
 * ## The arms no offline test can reach
 *
 * Some guards sit behind a control the view disables in exactly that state (an un-acknowledged
 * `Preview deletion of …`, an `Edit rule` on a non-reproducible rule, a row that no longer exists after
 * a refresh), and `preview`/`sessionBusy` re-check the same conditions the disabled controls express.
 * They stay as the last line of defence in the code that composes the write, which is why they are the
 * uncovered lines in this file: `#acls` measures the mocked lane, and the sibling screens
 * (`system`/`sessions`/`lags`) record the identical shape.
 */
import { useState } from 'react'
import type { FormEvent } from 'react'
import type { Acl, AclEntry, AclType, CommandSpec, ConfigSession, Node } from '@devhax-heavy-industries/arista-eapi'

import { useDeviceRead } from '../../shared/use-device-read'
import { useOperation } from '../../shared/use-operation'
import { ConfirmProvider, useConfirm } from '../../shared/use-confirm'
import { stageDisplay } from '../staged-batch'
import { AclsView } from './AclsView'
import type { AclBlockView, AclDraftView, AclEntryRowView, AclsViewProps, RuleFormView } from './AclsView'
import {
  aclNameRefusal,
  aclStemOf,
  addEntryLines,
  createLines,
  deleteLines,
  duplicateSeqRefusal,
  EMPTY_RULE,
  matchDisplay,
  REFERENCE_GAP,
  removeEntryLines,
  replaceEntryLines,
  ruleBody,
  ruleDraftFromEntry,
  ruleLine,
  ruleReproducibility,
  seqnoRefusal,
  sessionDescription,
} from './acl-rules'
import type { RuleDraft } from './acl-rules'

export type AclsClient = Pick<Node, 'acls' | 'configSession'>

export interface AclsProps {
  readonly node: AclsClient | undefined
  readonly proxyConfigured?: boolean
}

type Session = Pick<ConfigSession, 'name' | 'state' | 'run' | 'diff' | 'hasDiffBeenRead' | 'commit' | 'abort'>

interface PendingStage {
  readonly description: string
  readonly effectLabel: string
  readonly specs: readonly CommandSpec[]
  readonly display: readonly string[]
  readonly risks: readonly string[]
  readonly destructive: boolean
}

interface DraftState extends PendingStage {
  readonly session: Session
  readonly diff?: string
  readonly commitAttempted: boolean
}

interface ReadData {
  readonly standard: readonly Acl[]
  readonly extended: readonly Acl[]
}

interface RuleFormState {
  readonly mode: 'add' | 'replace'
  readonly type: AclType
  readonly name: string
  readonly draft: RuleDraft
}

interface DeleteTarget {
  readonly type: AclType
  readonly name: string
}

const PROXY_PROMPT = 'Local proxy is not configured. Set EAPI_HOST, EAPI_USER, and EAPI_PASS in arista-webui/.env.local, then restart Vite.'
const COMMIT_RECOVERY = 'Commit was attempted; refresh device state before taking another action.'

export function Acls(props: AclsProps) {
  return <ConfirmProvider><AclsWorkspace {...props} /></ConfirmProvider>
}

function AclsWorkspace({ node, proxyConfigured = true }: AclsProps) {
  const confirm = useConfirm()
  const operation = useOperation()
  const { busy, notice, failure } = operation
  const canAct = proxyConfigured && node !== undefined

  const [createNameDraft, setCreateNameDraft] = useState('')
  const [createType, setCreateType] = useState<AclType>('standard')
  const [createError, setCreateError] = useState<string | undefined>(undefined)
  const [ruleForm, setRuleForm] = useState<RuleFormState | undefined>(undefined)
  const [ruleError, setRuleError] = useState<string | undefined>(undefined)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | undefined>(undefined)
  const [deleteAck, setDeleteAck] = useState(false)
  const [draft, setDraft] = useState<DraftState | undefined>(undefined)

  const read = useDeviceRead<ReadData>(
    async () => {
      if (node === undefined) throw new Error('no device client')
      // One read per kind over the same parsed config document, in the client's own section order.
      // Neither is a `show`, so nothing on this screen can report live state.
      const [standard, extended] = await Promise.all([node.acls.standard.getAll(), node.acls.extended.getAll()])
      return { standard: [...standard.values()], extended: [...extended.values()] }
    },
    [node],
    { enabled: canAct, disabledMessage: '' },
  )
  const data = read.state.kind === 'ready' ? read.state.data : undefined

  function clearErrors(): void {
    setCreateError(undefined)
    setRuleError(undefined)
    operation.clear()
  }

  function closeForms(): void {
    setRuleForm(undefined)
    setRuleError(undefined)
    setDeleteTarget(undefined)
    setDeleteAck(false)
  }

  /** Refuse a write while another staged session owns this screen; returns true when blocked. */
  function sessionBusy(): boolean {
    if (busy || !canAct || node === undefined) return true
    if (draft !== undefined) {
      operation.run(async () => { throw new Error('A staged session is already open on this screen; commit or abort it before staging another change.') }).catch(() => undefined)
      return true
    }
    if (data === undefined) {
      operation.run(async () => { throw new Error('The ACL read has not answered, so nothing here can be compared or staged against it.') }).catch(() => undefined)
      return true
    }
    return false
  }

  async function preview(stage: PendingStage): Promise<void> {
    if (busy || !canAct || node === undefined || draft !== undefined) return
    await operation.run(async () => {
      const session = await node.configSession({ description: stage.description })
      const handle: Session = session
      setDraft({ ...stage, session: handle, commitAttempted: false })
      await handle.run(stage.specs)
      const diff = await handle.diff()
      setDraft({ ...stage, session: handle, diff, commitAttempted: false })
      return diff
    }, {
      progress: 'Staging the change and reading the device diff…',
      success: 'Review the device diff before committing this change.',
    })
  }

  /** One ACL of one kind from the read this screen is already showing. */
  function aclOf(type: AclType, name: string): Acl | undefined {
    return (type === 'standard' ? data?.standard : data?.extended)?.find((acl) => acl.name === name)
  }

  /** The sequence numbers a block currently carries, in document order. */
  function seqnosOf(type: AclType, name: string): readonly number[] {
    return [...(aclOf(type, name)?.entries.values() ?? [])].map((entry) => entry.seqno)
  }

  // --------------------------------------------------------------------------- create / delete
  function beginCreate(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    clearErrors()
    if (sessionBusy()) return
    const refusal = aclNameRefusal(createNameDraft)
    if (refusal !== undefined) { setCreateError(refusal); return }
    const name = createNameDraft.trim()
    // The client keys ACLs by NAME alone and reports a name written as both kinds rather than picking
    // one, so a clash with either kind is refused in-form instead of buying a ConfigParseError later.
    const clash = aclOf('standard', name) ?? aclOf('extended', name)
    if (clash !== undefined) {
      setCreateError(`${name} already exists as a ${clash.type} access list in the running-config, and this client keys access lists by name — a second header with the same name would make the block unreadable rather than create a second list. Edit the rules of ${name} instead.`)
      return
    }
    const specs = createLines(createType, name)
    const display = stageDisplay(specs)
    void preview({
      description: sessionDescription('create'),
      effectLabel: display[0] ?? name,
      specs,
      display,
      destructive: false,
      risks: [
        'A new section carries no rules, so it filters nothing until a rule line is added. Whether any interface points at it is not readable from this screen: no client read covers `ip access-group`.',
      ],
    })
  }

  /**
   * Stage the deletion of the acknowledged section.
   *
   * The view keeps `Preview deletion of …` disabled until the box is ticked, so the check here is the
   * same rule stated once more where the write is actually composed: a later control change cannot open
   * an un-acknowledged deletion. Both arms — the disabled control and this refusal — are pinned (the
   * refusal by the acknowledgement test, which asserts the disabled control plus zero sessions).
   */
  function beginDeletePending(): void {
    const target = deleteTarget
    clearErrors()
    if (target === undefined) return
    if (sessionBusy()) return
    if (!deleteAck) {
      operation.run(async () => { throw new Error('This deletion needs the acknowledgement ticked first: the screen cannot check whether an interface still applies the ACL, so the consent has to be explicit before a session opens.') }).catch(() => undefined)
      return
    }
    const specs = deleteLines(target.type, target.name)
    const display = stageDisplay(specs)
    const ruleCount = aclOf(target.type, target.name)?.entries.size ?? 0
    void preview({
      description: sessionDescription('delete'),
      effectLabel: display[0] ?? target.name,
      specs,
      display,
      // Always destructive, whatever the block holds: this is the one write whose blast radius this
      // screen genuinely cannot bound, because the reference half of the config is unreadable here.
      destructive: true,
      risks: [
        `Deletion removes the whole section — the header and every rule under it (${ruleCount === 0 ? 'no rules were read' : `${String(ruleCount)} rule(s) read`}). The device diff is the only evidence of what the write actually took out.`,
        REFERENCE_GAP,
      ],
    })
    setDeleteTarget(undefined)
    setDeleteAck(false)
  }

  // ------------------------------------------------------------------------ entry add/replace
  function beginAddRule(type: AclType, name: string): void {
    clearErrors()
    if (sessionBusy()) return
    setDeleteTarget(undefined)
    setDeleteAck(false)
    setRuleForm({ mode: 'add', type, name, draft: { ...EMPTY_RULE } })
  }

  function beginEditRule(type: AclType, name: string, seqno: number): void {
    clearErrors()
    if (sessionBusy()) return
    const entry = aclOf(type, name)?.entries.get(seqno)
    if (entry === undefined) {
      setRuleError(`Rule ${String(seqno)} is not in the ${name} listing this screen read, so there is nothing to prefill — reload the device state before writing.`)
      return
    }
    // The control is disabled exactly when this fires; the check stays as the last line of defence.
    const refusal = ruleReproducibility(entry)
    if (refusal !== undefined) { setRuleError(refusal); return }
    setDeleteTarget(undefined)
    setDeleteAck(false)
    setRuleForm({ mode: 'replace', type, name, draft: ruleDraftFromEntry(entry) })
  }

  function beginRemoveRule(type: AclType, name: string, seqno: number): void {
    clearErrors()
    if (sessionBusy()) return
    const entry = aclOf(type, name)?.entries.get(seqno)
    if (entry === undefined) {
      setRuleError(`Rule ${String(seqno)} is not in the ${name} listing this screen read, so nothing was staged — reload the device state before writing.`)
      return
    }
    const specs = removeEntryLines(type, name, String(seqno))
    void preview({
      description: sessionDescription('remove entry'),
      effectLabel: `no ${String(seqno)} in ${name}`,
      specs,
      display: stageDisplay(specs),
      destructive: true,
      risks: [
        `This negates one rule of ${name}. The line it takes out is the one this screen read: ${ruleLine(entry)}.`,
        'Whether the section is applied on an interface is outside what this screen can read (no client read covers `ip access-group`), so removing a rule can change live filtering — the confirm does not claim it checked.',
      ],
    })
    closeForms()
  }

  function submitRuleForm(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (ruleForm === undefined) return
    const form = ruleForm
    setRuleError(undefined)
    if (sessionBusy()) return
    const composed = ruleBody(form.type, form.draft)
    if ('refusal' in composed) { setRuleError(composed.refusal); return }
    const seqno = form.draft.seqno.trim()
    if (form.mode === 'add') {
      const badSeq = seqnoRefusal(seqno)
      if (badSeq !== undefined) { setRuleError(badSeq); return }
      const clash = duplicateSeqRefusal(seqnosOf(form.type, form.name), seqno)
      if (clash !== undefined) { setRuleError(clash); return }
    }
    const specs = form.mode === 'add'
      ? addEntryLines(form.type, form.name, composed.body, seqno)
      : replaceEntryLines(form.type, form.name, seqno, composed.body)
    void preview({
      description: sessionDescription(form.mode === 'add' ? 'add entry' : 'replace entry'),
      effectLabel: form.mode === 'add' ? `${form.name}: ${composed.body}` : `${form.name}: replace ${seqno}`,
      specs,
      display: stageDisplay(specs),
      destructive: form.mode === 'replace',
      risks: form.mode === 'add'
        ? [
          seqno === ''
            ? 'No sequence number was given, so the DEVICE numbers this rule. This client composes no number client-side and this screen does not guess one; the read after commit reports what the device chose.'
            : `The rule is staged with the number ${seqno}, which the listing did not already show. A line the CLI rejects — an option this client does not write, or a number the device will not take — comes back as the device's own error, not a silent success.`,
          'Whether this section is applied anywhere is outside what this screen can read: no client read covers `ip access-group`.',
        ]
        : [
          `A replace negates ${seqno} before writing the replacement, so a commit the device accepts takes the current line out whatever the new line then does.`,
          'Only rules whose every token the client verbs can re-emit reach this form; a rule carrying an operator or an option tail is refused for editing instead of rewritten without it. The device still decides what it accepts.',
        ],
    })
    closeForms()
  }

  // ----------------------------------------------------------------------------- commit/abort
  async function commitDraft(): Promise<void> {
    if (busy || draft === undefined || draft.diff === undefined || !draft.session.hasDiffBeenRead() || draft.commitAttempted) return
    const risky = draft.destructive || draft.risks.length > 0
    const label = draft.effectLabel
    if (!await confirm({
      title: risky ? `Confirm: ${label}` : 'Commit to running-config',
      body: [
        `Commit session ${draft.session.name}, which stages ${draft.display.join(' · ')}? This changes running-config only; startup-config is never written by this screen (DR-024).`,
        ...(draft.risks.length === 0 ? [] : [`Risk named for this write:\n${draft.risks.map((risk) => `  · ${risk}`).join('\n')}`]),
        'If this session is lost mid-commit, the change may still have applied — reconnect and refresh before any further action.',
      ].join(' '),
      confirmLabel: risky ? `Commit despite the risk: ${label}` : 'Commit to running-config',
      destructive: true,
      subject: `${draft.session.name} · ${label}`,
    })) return
    setDraft({ ...draft, commitAttempted: true })
    const committed = await operation.run(() => draft.session.commit(), {
      progress: 'Committing the reviewed change to running-config…',
      success: 'Changes committed to running-config. Startup-config was not changed.',
      failureSuffix: COMMIT_RECOVERY,
    })
    if (committed.ok) {
      setDraft(undefined)
      setCreateNameDraft('')
      closeForms()
      read.reload()
    }
  }

  async function abortDraft(): Promise<void> {
    if (busy || draft === undefined || (draft.session.state !== 'open' && draft.session.state !== 'diffed')) return
    if (!await confirm({ title: 'Abort staged changes', body: `Abort staged changes in session ${draft.session.name}? Its staged ${draft.display.join(' · ')} will be discarded.`, confirmLabel: 'Abort staged changes', destructive: true, subject: draft.session.name })) return
    const aborted = await operation.run(async () => {
      await draft.session.abort()
      setDraft(undefined)
      return draft.session.name
    }, { success: `Session ${draft.session.name} was aborted; nothing was written to the device.` })
    if (aborted.ok) {
      closeForms()
      read.reload()
    }
  }

  // ------------------------------------------------------------------------------- view props
  function rowsFor(acl: Acl): readonly AclEntryRowView[] {
    return [...acl.entries.values()].map((entry: AclEntry) => ({
      type: acl.type,
      aclName: acl.name,
      seqno: entry.seqno,
      line: ruleLine(entry),
      action: entry.action,
      protocol: entry.protocol ?? '',
      source: matchDisplay(entry.src),
      destination: entry.dst === undefined ? '' : matchDisplay(entry.dst),
      // `log` plus the client's `options` remainder: configured text, read off the block, nothing computed.
      flags: [entry.log === true ? 'log' : '', entry.options ?? ''].filter((part) => part !== '').join(' '),
      editable: ruleReproducibility(entry) === undefined,
      onEdit: beginEditRule,
      onRemove: beginRemoveRule,
    }))
  }

  function blocksFor(acls: readonly Acl[]): readonly AclBlockView[] {
    return acls.map((acl) => ({
      type: acl.type,
      name: acl.name,
      header: aclStemOf(acl.type, acl.name),
      ruleCount: acl.entries.size,
      entries: rowsFor(acl),
      readonlyNotes: [...acl.entries.values()]
        .map((entry) => ruleReproducibility(entry))
        .filter((note): note is string => note !== undefined),
    }))
  }

  const ruleFormView: RuleFormView | undefined = ruleForm === undefined ? undefined : {
    mode: ruleForm.mode,
    type: ruleForm.type,
    name: ruleForm.name,
    draft: ruleForm.draft,
    ...(ruleError === undefined ? {} : { error: ruleError }),
    onDraftChange: (next) => { setRuleForm({ ...ruleForm, draft: next }); setRuleError(undefined) },
    onSubmit: submitRuleForm,
    onCancel: () => { setRuleForm(undefined); setRuleError(undefined) },
  }

  const draftView: AclDraftView | undefined = draft === undefined ? undefined : {
    sessionName: draft.session.name,
    effectLabel: draft.effectLabel,
    batch: draft.display,
    risks: draft.risks,
    ...(draft.diff === undefined ? {} : { diff: draft.diff }),
    canCommit: draft.diff !== undefined && draft.session.hasDiffBeenRead() && !draft.commitAttempted,
    destructive: draft.destructive,
  }

  const state = !canAct || read.state.kind === 'error' ? 'failed' : read.state.kind === 'loading' ? 'loading' : 'ready'

  const viewProps: AclsViewProps = {
    state,
    ...(read.state.kind === 'error' && read.state.message !== '' ? { readError: read.state.message } : {}),
    ...(proxyConfigured ? {} : { proxyPrompt: PROXY_PROMPT }),
    standardKnown: data?.standard !== undefined,
    extendedKnown: data?.extended !== undefined,
    standard: blocksFor(data?.standard ?? []),
    extended: blocksFor(data?.extended ?? []),
    createNameDraft,
    createType,
    ...(createError === undefined ? {} : { createError }),
    onCreateNameChange: (value) => { setCreateNameDraft(value); setCreateError(undefined) },
    onCreateTypeChange: setCreateType,
    onCreateSubmit: beginCreate,
    ...(ruleFormView === undefined ? {} : ruleForm !== undefined && ruleForm.mode === 'add' ? { addRuleForm: ruleFormView } : { replaceRuleForm: ruleFormView }),
    ...(deleteTarget === undefined ? {} : {
      deletePending: {
        type: deleteTarget.type,
        name: deleteTarget.name,
        header: aclStemOf(deleteTarget.type, deleteTarget.name),
        ruleCount: aclOf(deleteTarget.type, deleteTarget.name)?.entries.size ?? 0,
        ack: deleteAck,
        onAckChange: setDeleteAck,
        onPreview: beginDeletePending,
        onCancel: () => { setDeleteTarget(undefined); setDeleteAck(false) },
      },
    }),
    ...(draftView === undefined ? {} : { draft: draftView }),
    onAddRule: beginAddRule,
    onDeleteAcl: (type: AclType, name: string) => { clearErrors(); setRuleForm(undefined); setRuleError(undefined); setDeleteTarget({ type, name }); setDeleteAck(false) },
    onCommitDraft: () => { void commitDraft() },
    onAbortDraft: () => { void abortDraft() },
    onReload: () => { clearErrors(); closeForms(); read.reload() },
    busy,
    canAct: canAct && state === 'ready',
    notice,
    failure,
    connection: !canAct || state === 'failed' ? 'error' : state === 'loading' || busy ? 'connecting' : 'connected',
    connectionLabel: !canAct
      ? 'Local proxy is not configured'
      : state === 'loading'
        ? 'Reading the running-config…'
        : state === 'failed'
          ? 'The ACL read did not come back'
          : 'Access lists read from the parsed running-config',
  }

  return <AclsView {...viewProps} />
}
