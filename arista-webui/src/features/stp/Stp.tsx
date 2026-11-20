/**
 * S15 (#85): the spanning-tree screen — route `#/stp`. Container half of the S8 (#78) split:
 * it owns the read, the draft/named-session state machine, the confirm calls, and the
 * command-line composition that mirrors the frozen `node.stp.interfaces` verbs (see
 * ./stp-rules.ts for the pinned texts and the risk copy).
 *
 * ## Reads
 *
 * `node.stp.get()` (client `resources/stp.ts`, §5 rows 167-172) is the single hard read: it is
 * parsed `running-config all`, so the loading/failure copy names the source, and an empty
 * interface table is a normal `ready` payload rendered with `EmptyState`, never an error. The
 * identity chip rides a soft, silent `show version` read — its failure only removes the chip,
 * because (unlike S12 #82) no write on this screen is version-conditional. B3 (#88) step 1 closed
 * the capture gap the #85 boundary named: `show spanning-tree` is now capture-backed on BOTH
 * targets (the hw inventory plus the configured-shape cEOS refresh), so a second soft read feeds
 * the OPERATIONAL panel below the config summary. It stays soft — the config table is the hard
 * dependency — and a failed live read mutes the panel with
 * {@link STP_OPERATIONAL_UNAVAILABLE_NOTE}, never a blank and never a "not supported" claim.
 *
 * ## Writes (named session; preview → device `diff()` → confirm → commit)
 *
 * Every write opens a named config session, stages the `interface <port>` parent line plus ONE or
 * TWO plain command lines byte-identical to what the ported verb would send (`stp.test.ts` pins),
 * reads the device `diff()`, then commits to running-config only (startup-config never touched,
 * DR-024; abort always offered). Command text comes from ./stp-rules.ts, never invented. The port
 * selector is IN-SCREEN — the router has no per-port param channel (#126/#63 block deep links), so
 * no URL is composed for a port here.
 *
 * ## The two honest gates #85 grades
 *
 * - **Name gate (row 168).** Reads keep pyeapi's two-character `Et`/`Po` prefix gate, so a section
 *   named `interface Et1` appears in the table; writes are narrower by design — the repo's
 *   anchored name grammar plus kind ∈ {Ethernet, Port-Channel} — and {@link stpWriteGuard}
 *   refuses such a name in-form at ZERO sessions, mirroring `assertStpPortName`.
 * - **PortFast loop guard.** Every affirmative PortFast write (bare, `edge`+`auto`, `network`,
 *   `normal`, and the unpredictable `default` arm) is `destructive`, so its commit runs through
 *   the hard confirm whose body carries {@link portfastLoopRisk}: the dialog names the port and
 *   states that this UI cannot see what is connected on the far end.
 *
 * ## The half #85 keeps closed
 *
 * No global `spanning-tree mode …` control renders anywhere — mode changes are blocked issue
 * B3 (#88), and {@link STP_MODE_EDIT_NOTE} states that in static copy (a test pins that no
 * mode-shaped control exists).
 */
import { useState } from 'react'
import type { FormEvent } from 'react'
import { isInterfaceName, parseInterfaceName, submodeCommands } from '@devhax-heavy-industries/arista-eapi'
import type { CommandSpec, Node, StpSettings as DeviceSettings } from '@devhax-heavy-industries/arista-eapi'

import { softRead, softValue, useDeviceRead } from '../../shared/use-device-read'
import type { DeviceIdentity } from '../../shared/identity'
import { identityFrom } from '../../shared/identity'
import { useOperation } from '../../shared/use-operation'
import { TransactionScope, useTransaction, useTransactionSnapshot } from '../sessions/TransactionContext'
import { stageLines } from '../staged-batch'
import { StpView } from './StpView'
import type { StpViewProps } from './StpView'
import { actionIsDestructive, stageRisks, stpOperationalView, stpPortRowView, stpWriteAction } from './stp-rules'
import type { StpOperationalInstanceView } from './stp-rules'

// The typed `show('version')` overload (the F-tier extension) — same augmentation S6/S8/S12 import.
import '../../eapi/show-contracts'

export type StpClient = Pick<Node, 'stp' | 'show' | 'configSession'>

export interface StpProps {
  readonly node: StpClient | undefined
  readonly proxyConfigured?: boolean
}

interface PendingStage {
  readonly description: string
  readonly effectLabel: string
  readonly specs: readonly CommandSpec[]
  readonly display: readonly string[]
  readonly risks: readonly string[]
  readonly destructive: boolean
}

interface ReadData {
  readonly settings: DeviceSettings
  readonly identity?: DeviceIdentity
  /** B3 (#88) step 1: the live read model, soft — a failure here only mutes the operational panel. */
  readonly operational?: readonly StpOperationalInstanceView[]
  /** Set when the soft `show spanning-tree` read failed; the panel says so instead of showing nothing. */
  readonly operationalUnavailable?: boolean
}

const PROXY_PROMPT = 'Local proxy is not configured. Set EAPI_HOST, EAPI_USER, and EAPI_PASS in arista-webui/.env.local, then restart Vite.'

/**
 * The screen-side mirror of the client's `assertStpPortName` (resources/stp.ts, §5 row 168): the
 * anchored per-kind grammar plus kind ∈ {Ethernet, Port-Channel}. Reads keep pyeapi's looser
 * `Et`/`Po` prefix gate, so the table can contain a name this guard refuses — the editor then says
 * so instead of opening a session the client would reject at zero round trips.
 *
 * Exported for the direct test of the second arm (§5 row 168's kind refusal), which in-screen
 * inputs cannot reach: anything the read-side gate lists starts `Et`/`Po`, and every such name
 * that passes the anchored grammar is Ethernet or Port-Channel. Same helper-export pattern as
 * `InterfacesDashboard`'s `bandPathFor`/`managementInterfaces` pins.
 */
export function stpWriteGuard(name: string): string | undefined {
  if (!isInterfaceName(name)) {
    return `"${name}" is not an interface name this client can put behind \`interface <name>\` — the parsed config carries the section (the reader keeps pyeapi's two-character Et/Po prefix gate, §5 row 168), but the WRITE side is narrower on purpose (assertStpPortName, resources/stp.ts), so this screen stages nothing for it. The row stays read-only here.`
  }
  const kind = parseInterfaceName(name)?.kind
  if (kind === 'Ethernet' || kind === 'Port-Channel') return undefined
  return `"${name}" parses as an interface name but not as an Ethernet or Port-Channel — pyeapi documents spanning-tree interfaces on those two kinds only (api/stp.py:194-195), and this client refuses the rest by name (assertStpPortName, resources/stp.ts). The row stays read-only here.`
}

export function Stp(props: StpProps) {
  return <TransactionScope node={props.node}><StpWorkspace {...props} /></TransactionScope>
}

function StpWorkspace({ node, proxyConfigured = true }: StpProps) {
  const operation = useOperation()
  const { busy, notice, failure } = operation
  const transaction = useTransaction()
  const transactionState = useTransactionSnapshot()
  const transactionBusy = transactionState.status === 'opening' || transactionState.status === 'staging' || transactionState.status === 'committing' || transactionState.status === 'aborting'
  const canAct = proxyConfigured && node !== undefined && transaction !== undefined && transactionState.status !== 'uncertain'

  const [selectedPort, setSelectedPort] = useState('')
  const [selectedAction, setSelectedAction] = useState('')
  const [portRefusal, setPortRefusal] = useState<string | undefined>(undefined)
  const [actionError, setActionError] = useState<string | undefined>(undefined)

  const read = useDeviceRead<ReadData>(
    async () => {
      if (node === undefined) throw new Error('no device client')
      const settings = await node.stp.get()
      // Identity chip only: no write here is version-conditional, so this read fails silently.
      const version = softValue(await softRead(node.show('version'), { silent: true }))
      // B3 (#88) step 1: the operational read is capture-backed on both targets, but it stays a
      // SOFT read — the config table is the screen's hard dependency, and a live-state read that
      // fails must mute the operational panel with a named reason, never blank the screen.
      const stpReply = softValue(await softRead(node.show('spanning-tree'), { silent: true }))
      return {
        settings,
        ...(version === undefined ? {} : { identity: identityFrom(version) }),
        ...(stpReply === undefined ? { operationalUnavailable: true } : { operational: stpOperationalView(stpReply) }),
      }
    },
    [node],
    { enabled: canAct, disabledMessage: '' },
  )
  const data = read.state.kind === 'ready' ? read.state.data : undefined
  const settings = data?.settings

  const ports = [...(settings?.interfaces.keys() ?? [])].map((name) => ({ name, writable: stpWriteGuard(name) === undefined }))
  const rows = [...(settings?.interfaces.values() ?? [])].map(stpPortRowView)
  const effectivePort = ports.find((port) => port.name === selectedPort) ?? ports[0]
  const effectivePortName = effectivePort?.name ?? ''

  function clearErrors() {
    setPortRefusal(undefined)
    setActionError(undefined)
    operation.clear()
  }

  function plan(stage: PendingStage): void {
    void preview(stage)
  }

  async function preview(stage: PendingStage) {
    if (busy || transactionBusy || !canAct || transaction === undefined) return
    await operation.run(() => transaction.append({
      source: '/stp',
      action: stage.effectLabel,
      commands: stage.specs,
      display: stage.display,
      risks: stage.risks,
    }), {
      progress: 'Adding the STP change to the shared transaction…',
      success: 'STP change added to the transaction. Review the device diff before committing in Transaction Center.',
    })
  }

  /** Refuse a write while another staged session owns this screen; returns true when blocked. */
  function sessionBusy(): boolean {
    if (busy || transactionBusy || !canAct || node === undefined) return true
    if (settings === undefined) {
      operation.run(async () => { throw new Error('The spanning-tree read has not answered, so nothing can be compared or staged against it.') }).catch(() => undefined)
      return true
    }
    return false
  }

  function beginPreview(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    clearErrors()
    if (sessionBusy()) return
    const port = effectivePortName
    if (port === '') {
      setActionError('There is no spanning-tree port to edit — the read answered no Ethernet or Port-Channel section, so nothing can be selected. Reload device state after configuring a port.')
      return
    }
    const refusal = stpWriteGuard(port)
    if (refusal !== undefined) { setPortRefusal(refusal); return }
    const action = stpWriteAction(selectedAction)
    if (action === undefined) {
      setActionError('Choose a spanning-tree change for this port first — the screen stages exactly one verb at a time, so it never composes a line you did not pick.')
      return
    }
    // The parent line comes from the client's own composer (`submodeCommands`), the same shape
    // `configureInterface` uses — the pinned texts live in ./stp-rules.ts.
    const specs = submodeCommands(`interface ${port}`, action.commands)
    plan({
      description: `webui stp ${action.id}`,
      effectLabel: `${action.commands[0]} on ${port}`,
      specs,
      display: stageLines(specs),
      risks: stageRisks(action, port),
      destructive: actionIsDestructive(action),
    })
  }

  const state = !canAct || read.state.kind === 'error' ? 'failed' : read.state.kind === 'loading' ? 'loading' : 'ready'

  const viewProps: StpViewProps = {
    state,
    ...(read.state.kind === 'error' && read.state.message !== '' ? { readError: read.state.message } : {}),
    ...(proxyConfigured ? {} : { proxyPrompt: PROXY_PROMPT }),
    ...(data?.identity === undefined ? {} : { identity: data.identity }),
    portsKnown: settings !== undefined,
    ...(settings === undefined || settings.mode === undefined ? {} : { mode: settings.mode }),
    portCount: settings?.interfaces.size ?? 0,
    rows,
    ...(data?.operational === undefined ? {} : { operational: data.operational }),
    ...(data?.operationalUnavailable === true ? { operationalUnavailable: true } : {}),
    ports,
    selectedPort: effectivePortName,
    selectedAction,
    ...(portRefusal === undefined ? {} : { portRefusal }),
    ...(actionError === undefined ? {} : { actionError }),
    onPortChange: (name) => { setSelectedPort(name); setPortRefusal(undefined) },
    onActionChange: (id) => { setSelectedAction(id); setActionError(undefined) },
    onPreview: beginPreview,
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
          : 'Spanning-tree config read from the parsed running-config',
    onReload: () => { clearErrors(); read.reload() },
  }

  return <StpView {...viewProps} />
}
