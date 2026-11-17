/**
 * S16 (#90): the VRF manager — route `#/vrfs`. Container half of the S8 (#78) split: it owns the
 * reads, the draft/named-session state machine, the confirm calls, and the wiring to the mirrored
 * grammar in ./vrfs-rules.ts. Issue #90's "blocked" premise was a hardware unknown; the supervised
 * run-9 probes (2026-11-15) answered it, and this screen stages ONLY batch compositions those
 * captures proved (DECISIONS.md DR-141): header + `rd` in one batch (`...vrf-instance`), the
 * interface + `vrf <name>` pair (`...vrf-assignment`), and the per-form keyword rule (DR-099).
 *
 * ## Reads
 *
 * Hard: `node.vrfs.getAll()` + `node.interfaces.getAll()` (both parsed running-config; a port's
 * `vrf` field is the config-truth membership). Soft: `show version` (identity chip) and `show vrf`
 * (operational columns) — either soft read failing costs only its own columns, never the table.
 * An empty VRF table is a normal ready state (the built-in `default` VRF is a `show vrf` row, not
 * a config row, and the view says so).
 *
 * ## Writes (named session; preview → device `diff()` → confirm → commit; DR-024/DR-102)
 *
 * Every action stages its own named session (`webui vrf create`, `webui vrf set rd`, …) with the
 * exact lines ./vrfs-rules.ts composes from `vrfs.test.ts` pins. Destructive flags: delete, the
 * disable/default routing arms, and every bind/unbind — those take the risky-commit confirm
 * unchanged from the #102 decision. Routing flags are refused in-form when the mirrored
 * line-absence computation already matches the requested state (a no-op batch is not opened).
 */
import { useState } from 'react'
import type { FormEvent } from 'react'
import type { CommandSpec, ConfigSession, Interface, Node, Vrf, VrfDefinitionForm } from '@devhax-heavy-industries/arista-eapi'

import type { ShowVrfEntry } from '../../eapi/show-contracts'
import { softRead, softValue, useDeviceRead } from '../../shared/use-device-read'
import type { DeviceIdentity } from '../../shared/identity'
import { identityFrom } from '../../shared/identity'
import { useOperation } from '../../shared/use-operation'
import { ConfirmProvider, useConfirm } from '../../shared/use-confirm'
import { stageDisplay } from '../staged-batch'
import { VrfsView } from './VrfsView'
import type { VrfsDraftView, VrfsRowView, VrfsViewProps } from './VrfsView'
import type { RoutingArm, RoutingFamily } from './vrfs-rules'
import {
  bindInterfaceLines,
  createVrfLines,
  deleteVrfLines,
  pickDefinitionForm,
  routingLines,
  setDescriptionLines,
  setRdLines,
  unbindInterfaceLines,
  unsetDescriptionLines,
  unsetRdLines,
  vrfDescriptionError,
  vrfNameError,
  vrfRdError,
} from './vrfs-rules'

// The typed `show('version')` / `show('vrf')` overloads — same augmentation the other screens import.
import '../../eapi/show-contracts'

export type VrfsClient = Pick<Node, 'vrfs' | 'interfaces' | 'show' | 'configSession'>

export interface VrfsProps {
  readonly node: VrfsClient | undefined
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
  readonly vrfs: readonly Vrf[]
  readonly interfaces: readonly Interface[]
  readonly identity?: DeviceIdentity
  /** The raw `show vrf` map, verbatim — rendered only through modelled contract keys. */
  readonly deviceVrfs?: Readonly<Record<string, ShowVrfEntry>>
}

const PROXY_PROMPT = 'Local proxy is not configured. Set EAPI_HOST, EAPI_USER, and EAPI_PASS in arista-webui/.env.local, then restart Vite.'
const COMMIT_RECOVERY = 'Commit was attempted; refresh device state before taking another action. Sessions left open are visible in the Transaction Center.'

const RUN9 = {
  instance: 'the supervised run-9 probe staged this exact header+rd composition FULL on this box (configure-session-unblock2-vrf-instance--hw-session-probe.json)',
  definition: 'run 9 caught this box refusing `vrf definition` as deprecated (1002, configure-session-unblock2-vrf-definition--hw-session-probe.json); this form is staged only because the device\u2019s own config text speaks it (DR-099)',
  assignment: 'run 9 proved this box checks VRF existence when the assignment line RUNS, answering `VRF UNBLOCK-VRF not configured.` for a missing one (configure-session-unblock2-vrf-assignment--hw-session-probe.json)',
} as const

export function Vrfs(props: VrfsProps) {
  return <ConfirmProvider><VrfsWorkspace {...props} /></ConfirmProvider>
}

function VrfsWorkspace({ node, proxyConfigured = true }: VrfsProps) {
  const confirm = useConfirm()
  const operation = useOperation()
  const { busy, notice, failure } = operation
  const canAct = proxyConfigured && node !== undefined

  const [createNameDraft, setCreateNameDraft] = useState('')
  const [createRdDraft, setCreateRdDraft] = useState('')
  const [createDescDraft, setCreateDescDraft] = useState('')
  const [createErrorField, setCreateErrorField] = useState<string | undefined>(undefined)
  const [selectedName, setSelectedName] = useState<string | undefined>(undefined)
  const [rdDraft, setRdDraft] = useState('')
  const [descDraft, setDescDraft] = useState('')
  const [selectedErrorField, setSelectedErrorField] = useState<string | undefined>(undefined)
  const [assignInterface, setAssignInterface] = useState('')
  const [assignVrf, setAssignVrf] = useState('')
  const [assignErrorField, setAssignErrorField] = useState<string | undefined>(undefined)
  const [draft, setDraft] = useState<DraftState | undefined>(undefined)

  const read = useDeviceRead<ReadData>(
    async () => {
      if (node === undefined) throw new Error('no device client')
      const [vrfs, interfaces] = await Promise.all([node.vrfs.getAll(), node.interfaces.getAll()])
      const versionRead = await softRead(node.show('version'))
      const version = softValue(versionRead)
      const deviceRead = await softRead(node.show('vrf'))
      const device = softValue(deviceRead)
      return {
        vrfs: [...vrfs.values()],
        interfaces: [...interfaces.values()],
        ...(version === undefined ? {} : { identity: identityFrom(version) }),
        ...(device === undefined || device.vrfs === undefined ? {} : { deviceVrfs: device.vrfs }),
      }
    },
    [node],
    { enabled: canAct, disabledMessage: '' },
  )
  const data = read.state.kind === 'ready' ? read.state.data : undefined
  const vrfsKnown = data !== undefined
  const vrfList = data?.vrfs ?? []
  const interfaceList = data?.interfaces ?? []

  // The form comes from the read table through the client's own DR-099 rule — never typed inventively.
  const formInfo = pickDefinitionForm(vrfList)
  const form: VrfDefinitionForm = formInfo.form

  // A selection that no longer exists after a reload (deleted elsewhere) drops silently to none.
  const selected = selectedName === undefined ? undefined : vrfList.find((entry) => entry.name === selectedName)

  /** Port membership is the parsed interface section's `vrf`/`vrf forwarding` line (`Interface.ethernet.vrf`, divergence 14). */
  function vrfOf(iface: Interface): string | undefined {
    return iface.ethernet?.vrf
  }

  function membersOf(name: string): readonly string[] {
    return interfaceList.filter((iface) => vrfOf(iface) === name).map((iface) => iface.name)
  }

  /** The `show vrf` entry for a name — `undefined` while that soft read has not answered. */
  function deviceEntryFor(name: string): ShowVrfEntry | undefined {
    return data?.deviceVrfs?.[name]
  }

  function clearErrors() {
    setCreateErrorField(undefined)
    setSelectedErrorField(undefined)
    setAssignErrorField(undefined)
    operation.clear()
  }

  function plan(stage: PendingStage): void {
    void preview(stage)
  }

  async function preview(stage: PendingStage) {
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

  /** Refuse a write while another staged session owns this screen; returns true when blocked. */
  function sessionBusy(): boolean {
    if (busy || !canAct || node === undefined) return true
    if (draft !== undefined) {
      operation.run(async () => { throw new Error('A staged session is already open on this screen; commit or abort it before staging another change.') }).catch(() => undefined)
      return true
    }
    if (data === undefined) {
      operation.run(async () => { throw new Error('The VRF reads have not answered, so nothing can be compared or staged against them.') }).catch(() => undefined)
      return true
    }
    return false
  }

  function refuseSelected(message: string): void {
    setSelectedErrorField(message)
  }

  // --- create ---------------------------------------------------------------------------------------

  function beginCreate() {
    clearErrors()
    if (sessionBusy()) return
    const name = createNameDraft.trim()
    const nameRefusal = vrfNameError(name)
    if (nameRefusal !== undefined) { setCreateErrorField(nameRefusal); return }
    if (vrfList.some((entry) => entry.name === name)) {
      setCreateErrorField(`A VRF section named ${name} already exists in the running-config — staging \`vrf ${form} ${name}\` again opens a session that would change nothing (the read is the same source the client\u2019s create guard re-checks).`)
      return
    }
    const rd = createRdDraft.trim()
    if (rd !== '') {
      const refusal = vrfRdError(rd)
      if (refusal !== undefined) { setCreateErrorField(refusal); return }
    }
    const description = createDescDraft.trim()
    if (description !== '') {
      const refusal = vrfDescriptionError(description)
      if (refusal !== undefined) { setCreateErrorField(refusal); return }
    }
    const lines = createVrfLines(form, name, {
      ...(rd === '' ? {} : { rd }),
      ...(description === '' ? {} : { description }),
    })
    plan({
      description: 'webui vrf create',
      effectLabel: lines[0] ?? `vrf ${form} ${name}`,
      specs: lines,
      display: stageDisplay(lines),
      risks: [
        `Stages ${lines.map((line) => `\`${line}\``).join(' then ')} in one batch. On this device ${form === 'instance' ? RUN9.instance : RUN9.definition}.`,
        'The device diff for a fresh VRF has been observed to add `no ip routing vrf <name>` on its own — routing state for the new VRF is set by the device, and the refreshed table reports what it kept (this screen claims nothing in advance).',
      ],
      destructive: false,
    })
  }

  // --- manage selected VRF -------------------------------------------------------------------------

  function beginManage(name: string) {
    clearErrors()
    const entry = vrfList.find((candidate) => candidate.name === name)
    if (entry === undefined) return
    setSelectedName(name)
    setRdDraft(entry.rd ?? '')
    setDescDraft(entry.description ?? '')
    setAssignVrf(name)
  }

  function beginSetRd() {
    clearErrors()
    if (sessionBusy() || selected === undefined) return
    const rd = rdDraft.trim()
    const refusal = vrfRdError(rd)
    if (refusal !== undefined) { refuseSelected(refusal); return }
    if (selected.rd === rd) { refuseSelected(`\`${rd}\` is already the configured rd for ${selected.name} — the client would stage a line that changes nothing.`); return }
    const lines = setRdLines(form, selected.name, rd)
    plan({
      description: 'webui vrf set rd',
      effectLabel: `rd ${rd}`,
      specs: lines,
      display: stageDisplay(lines),
      risks: [`Enters the ${selected.name} section and writes \`${lines[1]}\` (vrfs.setVrfRd composition). Changing an rd re-handles every route in the VRF; the device decides, and the refresh reports the rd it kept.`],
      destructive: false,
    })
  }

  function beginUnsetRd() {
    clearErrors()
    if (sessionBusy() || selected === undefined) return
    if (selected.rd === undefined) { refuseSelected(`${selected.name} has no configured rd to clear — the running-config carries no \`rd\` line for it.`); return }
    const lines = unsetRdLines(form, selected.name)
    plan({
      description: 'webui vrf unset rd',
      effectLabel: 'no rd',
      specs: lines,
      display: stageDisplay(lines),
      risks: [`Negates the configured rd with \`${lines[1]}\` (the \`no rd\` arm; the empty-value form is refused by the client, DR-037). Routes in the VRF are re-handled by the device.`],
      destructive: false,
    })
  }

  function beginSetDescription() {
    clearErrors()
    if (sessionBusy() || selected === undefined) return
    const description = descDraft.trim()
    const refusal = vrfDescriptionError(description)
    if (refusal !== undefined) { refuseSelected(refusal); return }
    if (selected.description === description) { refuseSelected(`That is already the configured description of ${selected.name} — nothing to stage.`); return }
    const lines = setDescriptionLines(form, selected.name, description)
    plan({
      description: 'webui vrf set description',
      effectLabel: `description ${description}`,
      specs: lines,
      display: stageDisplay(lines),
      risks: [`Enters the ${selected.name} section and writes the one-line description (vrfs.setVrfDescription composition; a quote-containing value is refused here because this client\u2019s reader cannot round-trip it, not because the device was measured).`],
      destructive: false,
    })
  }

  function beginUnsetDescription() {
    clearErrors()
    if (sessionBusy() || selected === undefined) return
    if (selected.description === undefined) { refuseSelected(`${selected.name} has no configured description to clear.`); return }
    const lines = unsetDescriptionLines(form, selected.name)
    plan({
      description: 'webui vrf unset description',
      effectLabel: 'no description',
      specs: lines,
      display: stageDisplay(lines),
      risks: [`Negates the description with \`${lines[1]}\` (the \`no description\` arm, upstream-pinned).`],
      destructive: false,
    })
  }

  function beginRouting(family: RoutingFamily, arm: RoutingArm) {
    clearErrors()
    if (sessionBusy() || selected === undefined) return
    const current = family === 'ipv4' ? selected.ipv4Routing : selected.ipv6Routing
    if (arm === 'set' && current) { refuseSelected(`IPv${family === 'ipv4' ? '4' : '6'} routing already reads enabled for ${selected.name} — the reader finds no \`no …\` line, so enabling again is a batch that changes nothing.`); return }
    if (arm === 'no' && !current) { refuseSelected(`IPv${family === 'ipv4' ? '4' : '6'} routing already reads disabled for ${selected.name} — a \`no …\` line is already present (divergence 5).`); return }
    const lines = routingLines(family, arm, selected.name)
    plan({
      description: `webui vrf ${arm === 'set' ? 'enable' : arm === 'no' ? 'disable' : 'default'} ${family} routing`,
      effectLabel: lines[0] ?? '',
      specs: lines,
      display: stageDisplay(lines),
      risks: [
        `${lines[0]} is a TOP-level line — the client never enters the VRF section for routing flags (divergence 9).`,
        arm === 'default'
          ? 'The default arm returns the flag to the device default, which this screen cannot predict; the flag column after refresh is the client\u2019s line-absence reading of what the device kept.'
          : arm === 'no'
            ? 'Disabling routing in a VRF tears down its forwarding; if the VRF carries traffic through this UI\u2019s path the session may drop mid-commit — refresh (and the Transaction Center) before further writes, and the device diff is the evidence of what this batch actually touches.'
            : 'Enabling adds routing for this VRF only; the global routing posture is a separate screen (`#/system`), and what the VRF forwards afterwards is device state this screen reads back after commit.',
      ],
      destructive: arm !== 'set',
    })
  }

  function beginDeleteSelected() {
    clearErrors()
    if (sessionBusy() || selected === undefined) return
    const members = membersOf(selected.name)
    const deviceMembers = deviceEntryFor(selected.name)?.interfaces ?? []
    const lines = deleteVrfLines(form, selected.name)
    plan({
      description: 'webui vrf delete',
      effectLabel: lines[0] ?? '',
      specs: lines,
      display: stageDisplay(lines),
      risks: [
        `${lines[0]} removes the VRF section. Ports the config still assigns to it: ${members.length === 0 ? '(none)' : members.join(', ')}${deviceMembers.length > 0 ? `; the last \`show vrf\` answer also named: ${deviceMembers.join(', ')}` : ''}.`,
        'Whether EOS 4.28.13.1M refuses the delete while members exist or detaches them is NOT probed on hardware — the device diff and its error (if any) keep the verdict; refresh after commit to read what remains.',
      ],
      destructive: true,
    })
  }

  // --- interface assignment --------------------------------------------------------------------------

  function beginBind() {
    clearErrors()
    if (sessionBusy()) return
    const iface = interfaceList.find((candidate) => candidate.name === assignInterface)
    if (iface === undefined) { setAssignErrorField('Pick an interface from the list first — names come from the config read, they are not typed here.'); return }
    if (assignVrf === '') { setAssignErrorField('Pick a target VRF from the configured list first.'); return }
    if (vrfOf(iface) === assignVrf) { setAssignErrorField(`${iface.name} is already assigned to ${assignVrf} in the running-config — nothing to stage.`); return }
    const lines = bindInterfaceLines(form, iface.name, assignVrf)
    plan({
      description: 'webui vrf assign interface',
      effectLabel: `${iface.name} \u2192 ${assignVrf}`,
      specs: lines,
      display: stageDisplay(lines),
      risks: [
        `Stages \`${lines[0]}\` then \`${lines[1]}\` — the pair run 9 staged on this box; ${RUN9.assignment}.`,
        `This moves ${iface.name}'s forwarding into ${assignVrf}${vrfOf(iface) === undefined ? ' (it currently sits in the default VRF)' : ` (currently ${vrfOf(iface)})`}. Assigning an address-bearing port detaches its address (device behaviour, read back after commit) — and whether any port carries this UI\u2019s own eAPI path is not observable from here: ${iface.name === 'Management1' ? 'Management1 is the usual in-band port on this platform, so this specific write can cut the connection the session is travelling on' : 'the confirm names the port; the in-band judgement is yours, not a device fact this page can assert'}.`,
      ],
      destructive: true,
    })
  }

  function beginUnbind() {
    clearErrors()
    if (sessionBusy()) return
    const iface = interfaceList.find((candidate) => candidate.name === assignInterface)
    if (iface === undefined) { setAssignErrorField('Pick an interface from the list first.'); return }
    if (vrfOf(iface) === undefined) { setAssignErrorField(`${iface.name} carries no \`vrf\` line in the running-config — it is already in the default VRF, and the client\u2019s negation arm would only open a no-op session.`); return }
    const lines = unbindInterfaceLines(form, iface.name)
    plan({
      description: 'webui vrf unassign interface',
      effectLabel: `${iface.name} \u2192 default`,
      specs: lines,
      display: stageDisplay(lines),
      risks: [
        `Stages \`${lines[0]}\` then \`${lines[1]}\` (vrfs.unsetInterface negation for this device\u2019s form). ${iface.name} returns toward the default VRF by the device\u2019s reading of the negation.`,
        'The port leaves the VRF it names; traffic and addresses follow the device\u2019s interpretation of the negation. Whether the port carries this UI\u2019s path is not observable from this screen.',
      ],
      destructive: true,
    })
  }

  // --- commit / abort -------------------------------------------------------------------------------

  async function commitDraft() {
    if (busy || draft === undefined || draft.diff === undefined || !draft.session.hasDiffBeenRead() || draft.commitAttempted) return
    const risky = draft.destructive || draft.risks.length > 0
    const label = draft.effectLabel
    if (!await confirm({
      title: risky ? `Confirm: ${label}` : 'Commit to running-config',
      body: [
        `Commit session ${draft.session.name}, which stages ${draft.display.join(' \u00b7 ')}? This changes running-config only; startup-config is never written by this screen (DR-024).`,
        ...(draft.risks.length === 0 ? [] : [`Risk named for this write:\n${draft.risks.map((risk) => `  \u00b7 ${risk}`).join('\n')}`]),
        'If this session is lost mid-commit, the change may still have applied \u2014 reconnect, refresh, and check the Transaction Center before any further action.',
      ].join(' '),
      confirmLabel: risky ? `Commit despite the risk: ${label}` : 'Commit to running-config',
      destructive: true,
      subject: `${draft.session.name} \u00b7 ${label}`,
    })) return
    setDraft({ ...draft, commitAttempted: true })
    const committed = await operation.run(() => draft.session.commit(), {
      progress: 'Committing the reviewed change to running-config\u2026',
      success: 'Changes committed to running-config. Startup-config was not changed.',
      failureSuffix: COMMIT_RECOVERY,
    })
    if (committed.ok) {
      const wasDeleted = draft.description === 'webui vrf delete'
      setDraft(undefined)
      setCreateNameDraft('')
      setCreateRdDraft('')
      setCreateDescDraft('')
      setRdDraft('')
      setDescDraft('')
      if (wasDeleted) setSelectedName(undefined)
      read.reload()
    }
  }

  async function abortDraft() {
    if (busy || draft === undefined || (draft.session.state !== 'open' && draft.session.state !== 'diffed')) return
    if (!await confirm({ title: 'Abort staged changes', body: `Abort staged changes in session ${draft.session.name}? Its staged ${draft.display.join(' \u00b7 ')} will be discarded.`, confirmLabel: 'Abort staged changes', destructive: true, subject: draft.session.name })) return
    const aborted = await operation.run(async () => {
      await draft.session.abort()
      setDraft(undefined)
      return draft.session.name
    }, { success: `Session ${draft.session.name} was aborted; nothing was written to the device.` })
    if (aborted.ok) read.reload()
  }

  // --- view wiring ------------------------------------------------------------------------------------

  const draftView: VrfsDraftView | undefined = draft === undefined ? undefined : {
    sessionName: draft.session.name,
    effectLabel: draft.effectLabel,
    batch: draft.display,
    risks: draft.risks,
    ...(draft.diff === undefined ? {} : { diff: draft.diff }),
    canCommit: draft.diff !== undefined && draft.session.hasDiffBeenRead() && !draft.commitAttempted,
    destructive: draft.destructive,
  }

  const rows: readonly VrfsRowView[] = [...vrfList]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const deviceEntry = deviceEntryFor(entry.name)
      return {
        name: entry.name,
        definitionForm: entry.definitionForm,
        ...(entry.rd === undefined ? {} : { rd: entry.rd }),
        ...(entry.description === undefined ? {} : { description: entry.description }),
        ipv4Routing: entry.ipv4Routing,
        ipv6Routing: entry.ipv6Routing,
        members: membersOf(entry.name),
        ...(deviceEntry === undefined ? {} : { deviceState: describeDeviceEntry(deviceEntry) }),
        onManage: beginManage,
      }
    })

  const deviceRows = Object.entries(data?.deviceVrfs ?? {}).map(([name, entry]) => ({
    name,
    isDefault: name === 'default',
    vrfState: entry.vrfState,
    interfaces: entry.interfaces,
    ipv4: describeProtocol(entry.protocols.ipv4),
    ipv6: describeProtocol(entry.protocols.ipv6),
  }))

  const state = !canAct || read.state.kind === 'error' ? 'failed' : read.state.kind === 'loading' ? 'loading' : 'ready'

  const viewProps: VrfsViewProps = {
    state,
    ...(read.state.kind === 'error' && read.state.message !== '' ? { readError: read.state.message } : {}),
    ...(proxyConfigured ? {} : { proxyPrompt: PROXY_PROMPT }),
    ...(data?.identity === undefined ? {} : { identity: data.identity }),
    vrfsKnown,
    rows,
    vrfCount: vrfList.length,
    writeForm: form,
    writeFormFromConfig: formInfo.fromDeviceConfig,
    createNameDraft,
    createRdDraft,
    createDescDraft,
    ...(createErrorField === undefined ? {} : { createError: createErrorField }),
    onCreateNameChange: (value) => { setCreateNameDraft(value); setCreateErrorField(undefined) },
    onCreateRdChange: (value) => { setCreateRdDraft(value); setCreateErrorField(undefined) },
    onCreateDescChange: (value) => { setCreateDescDraft(value); setCreateErrorField(undefined) },
    onCreate: (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); beginCreate() },
    ...(selected === undefined
      ? {}
      : {
        selected: {
          name: selected.name,
          definitionForm: selected.definitionForm,
          ...(selected.rd === undefined ? {} : { rd: selected.rd }),
          ...(selected.description === undefined ? {} : { description: selected.description }),
          ipv4Routing: selected.ipv4Routing,
          ipv6Routing: selected.ipv6Routing,
          members: membersOf(selected.name),
        },
      }),
    rdDraft,
    descDraft,
    ...(selectedErrorField === undefined ? {} : { selectedError: selectedErrorField }),
    onRdDraftChange: (value) => { setRdDraft(value); setSelectedErrorField(undefined) },
    onDescDraftChange: (value) => { setDescDraft(value); setSelectedErrorField(undefined) },
    onSetRd: (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); beginSetRd() },
    onUnsetRd: beginUnsetRd,
    onSetDescription: (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); beginSetDescription() },
    onUnsetDescription: beginUnsetDescription,
    onRouting: (family, arm) => beginRouting(family, arm),
    onDeleteSelected: beginDeleteSelected,
    interfaceOptions: interfaceList.map((iface) => ({
      name: iface.name,
      ...(vrfOf(iface) === undefined ? {} : { current: vrfOf(iface) }),
    })),
    assignInterface,
    assignVrf,
    vrfOptions: [...vrfList].sort((a, b) => a.name.localeCompare(b.name)).map((entry) => entry.name),
    ...(assignErrorField === undefined ? {} : { assignError: assignErrorField }),
    onAssignInterfaceChange: (value) => { setAssignInterface(value); setAssignErrorField(undefined) },
    onAssignVrfChange: (value) => { setAssignVrf(value); setAssignErrorField(undefined) },
    onBind: beginBind,
    onUnbind: beginUnbind,
    deviceStateKnown: data?.deviceVrfs !== undefined,
    deviceRows,
    ...(draftView === undefined ? {} : { draft: draftView }),
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
          ? 'The VRF reads did not come back'
          : 'VRFs read from the parsed running-config',
    onCommitDraft: () => void commitDraft(),
    onAbortDraft: () => void abortDraft(),
    onReload: () => { clearErrors(); read.reload() },
  }

  return <VrfsView {...viewProps} />
}

/** Device-state label from modelled keys only — never a widened claim. */
function describeDeviceEntry(entry: ShowVrfEntry): string {
  return `${entry.vrfState} \u00b7 ipv4 ${describeProtocol(entry.protocols.ipv4)}`
}

function describeProtocol(state: ShowVrfEntry['protocols']['ipv4']): string {
  return `${state.routingState}/${state.protocolState}${state.supported ? '' : ' (unsupported)'}`
}
