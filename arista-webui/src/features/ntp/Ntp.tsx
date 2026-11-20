/**
 * S12 (#82): the NTP configuration screen — route `#/ntp`. Container half of the S8 (#78) split:
 * it owns the read, the draft/named-session state machine, the confirm calls, and the command-line
 * composition that mirrors the frozen `node.ntp` verbs (see ./ntp-rules.ts for the rules).
 *
 * ## Reads
 *
 * `node.ntp.get()` (client `resources/ntp.ts`, §5 rows 155-157) is the single hard read: it is parsed
 * `running-config all`, so the loading/failure copy names the source, and an empty server list is a
 * normal `ready` payload rendered with `EmptyState`, never an error. The identity chip and the source
 * form decision ride a soft `show version` read — its failure removes the chip and, because the client
 * refuses to guess between `ntp source` and `ntp local-interface`, hard-REFUSES the three source verbs
 * (server add/remove/remove-all are version-free and stay live). Server-write controls stay gated only
 * on the hard read.
 *
 * ## Writes (named session; preview → device `diff()` → confirm → commit)
 *
 * Every write opens a named config session, stages ONE plain command line that is byte-identical to
 * what the ported verb would send (`ntp server <addr>` / `… prefer` / `no ntp server <addr>` / `no ntp`
 * / `<form> <iface>` / `no <form>` / `default <form>`), reads the device `diff()`, then commits to
 * running-config only (startup-config never touched, DR-024; abort always offered). Command text comes
 * from ./ntp-rules.ts (mirrored from ntp.test.ts pins), never invented; option spellings the client
 * did not port (`version`/`iburst`/…) are refused in-form by {@link serverAddressRule}, naming the
 * client contract as the reason.
 *
 * ## The two hard-confirm boundaries #82 grades
 *
 * - `removeAllServers` (`no ntp`) is bulk-destructive: it goes through the destructive commit confirm
 *   whose risk copy names the EXACT current server list, and the client flags what `no ntp` covers on
 *   4.28 as unverified on hardware (M12 #14) — the screen sends only the one line pyeapi sends and
 *   claims nothing wider.
 * - Any `ntp source` change is destructive here: the screen cannot see which interface carries the
 *   eAPI session, so the confirm names the interface `node.ntp.get()` reported as currently configured
 *   and states that the in-band judgement is the operator's, not a device fact.
 *
 * ## The half #82 keeps closed
 *
 * `show ntp status` / `show ntp associations` have no capture for this device, so no contract key is
 * fabricated and the synchronisation panel is a permanent "not captured" statement (the CAPTURES gate),
 * never stratum/peer/offset fields. See NtpView: a test pins that vocabulary never reaches the DOM.
 */
import { useState } from 'react'
import type { FormEvent } from 'react'
import { isInterfaceName } from '@devhax-heavy-industries/arista-eapi'
import type { CommandSpec, Node, NtpSettings as DeviceSettings } from '@devhax-heavy-industries/arista-eapi'

import { softRead, softValue, useDeviceRead } from '../../shared/use-device-read'
import type { DeviceIdentity } from '../../shared/identity'
import { identityFrom } from '../../shared/identity'
import { useOperation } from '../../shared/use-operation'
import { ConfirmProvider } from '../../shared/use-confirm'
import { TransactionScope, useTransaction, useTransactionSnapshot } from '../sessions/TransactionContext'
import { stageDisplay } from '../staged-batch'
import { NtpView } from './NtpView'
import type { NtpServerRowView, NtpViewProps } from './NtpView'
import { serverAddLine, serverAddressRule, sourceStem } from './ntp-rules'

// The typed `show('version')` overload (the F-tier extension) — same augmentation S6/S8 import.
import '../../eapi/show-contracts'

export type NtpClient = Pick<Node, 'ntp' | 'show' | 'configSession'>

export interface NtpProps {
  readonly node: NtpClient | undefined
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
  /** The raw `show version` string when that soft read succeeded — the source-form floor needs it. */
  readonly version?: string
  readonly identity?: DeviceIdentity
}

const PROXY_PROMPT = 'Local proxy is not configured. Set EAPI_HOST, EAPI_USER, and EAPI_PASS in arista-webui/.env.local, then restart Vite.'

export function Ntp(props: NtpProps) {
  return <TransactionScope node={props.node}><ConfirmProvider><NtpWorkspace {...props} /></ConfirmProvider></TransactionScope>
}

function NtpWorkspace({ node, proxyConfigured = true }: NtpProps) {
  const operation = useOperation()
  const { busy, notice, failure } = operation
  const transaction = useTransaction()
  const transactionState = useTransactionSnapshot()
  const transactionBusy = transactionState.status === 'opening' || transactionState.status === 'staging' || transactionState.status === 'committing' || transactionState.status === 'aborting'
  const canAct = proxyConfigured && node !== undefined && transaction !== undefined && transactionState.status !== 'uncertain'

  const [newAddressDraft, setNewAddressDraft] = useState('')
  const [newPreferDraft, setNewPreferDraft] = useState(false)
  const [newServerError, setNewServerError] = useState<string | undefined>(undefined)
  const [sourceDraft, setSourceDraft] = useState('')
  const [sourceErrorField, setSourceErrorField] = useState<string | undefined>(undefined)

  const read = useDeviceRead<ReadData>(
    async () => {
      if (node === undefined) throw new Error('no device client')
      const settings = await node.ntp.get()
      // The identity chip and the source-form floor both come from this one soft read. Silent would
      // claim nothing; we keep the error folded so the source verbs can refuse honestly when it is
      // missing, while a failed version still leaves the settings/config reads intact.
      const versionRead = await softRead(node.show('version'))
      const version = softValue(versionRead)
      return {
        settings,
        ...(version === undefined ? {} : { version: version.version, identity: identityFrom(version) }),
      }
    },
    [node],
    { enabled: canAct, disabledMessage: '' },
  )
  const data = read.state.kind === 'ready' ? read.state.data : undefined
  const settings = data?.settings

  const stemInfo = sourceStem(data?.version)

  function clearErrors() {
    setNewServerError(undefined)
    setSourceErrorField(undefined)
    operation.clear()
  }

  function plan(stage: PendingStage): void {
    void preview(stage)
  }

  async function preview(stage: PendingStage) {
    if (busy || transactionBusy || !canAct || transaction === undefined) return
    await operation.run(() => transaction.append({
      source: '/ntp',
      action: stage.effectLabel,
      commands: stage.specs,
      display: stage.display,
      risks: stage.risks,
    }), {
      progress: 'Adding the change to the shared transaction and reading the device diff…',
      success: 'NTP change added to the transaction. Review the combined diff in Transaction Center.',
    })
  }

  function sessionBusy(): boolean {
    if (busy || transactionBusy || !canAct || node === undefined) return true
    if (settings === undefined) {
      operation.run(async () => { throw new Error('The NTP read has not answered, so nothing can be compared or staged against it.') }).catch(() => undefined)
      return true
    }
    return false
  }

  function beginAddServer() {
    clearErrors()
    if (sessionBusy()) return
    const refusal = serverAddressRule(newAddressDraft)
    if (refusal !== undefined) { setNewServerError(refusal); return }
    const addr = newAddressDraft.trim()
    const line = serverAddLine(addr, newPreferDraft)
    const already = settings !== undefined && settings.servers.some((row) => row.address === addr)
    plan({
      description: 'webui ntp add server',
      effectLabel: line,
      specs: [line],
      display: stageDisplay([line]),
      risks: [
        already
          ? `${addr} already appears in the parsed config; \`ntp server ${addr}${newPreferDraft ? ' prefer' : ''}\` is what the client stages, and it is the DEVICE that decides whether a repeat line replaces or duplicates the entry — the read after commit reports what it kept (row 156 keeps duplicates).`
          : 'This adds a configured server line only; whether the device actually reaches or trusts it, and its clock state, is synchronisation state this screen does not read (§5 rows 155-157).',
      ],
      destructive: false,
    })
  }

  function beginRemoveServer(address: string) {
    clearErrors()
    if (sessionBusy()) return
    const line = `no ntp server ${address}`
    plan({
      description: 'webui ntp remove server',
      effectLabel: line,
      specs: [line],
      display: stageDisplay([line]),
      risks: [`This negates one configured server (\`${line}\`, pyeapi \`remove_server\`, ntp.test.ts). The remaining server list after commit is whatever the device keeps — refresh to read it.`],
      destructive: false,
    })
  }

  function beginRemoveAllServers() {
    clearErrors()
    if (sessionBusy()) return
    if (settings === undefined || settings.servers.length === 0) {
      setNewServerError('There are no configured NTP servers for this client\u2019s reader — there is nothing to remove.')
      return
    }
    const list = settings.servers.map((row) => `${row.address}${row.prefer ? ' (preferred)' : ''}`).join(', ')
    plan({
      description: 'webui ntp remove all servers',
      effectLabel: 'no ntp',
      specs: ['no ntp'],
      display: stageDisplay(['no ntp']),
      risks: [
        `bulk removal via the single \`no ntp\` line (pyeapi \`remove_all_servers\`). It would take out every currently configured server: ${list}.`,
        '`no ntp` is ONE command whose exact scope on EOS 4.28.13.1M is UNVERIFIED on hardware (M12 #14) — it may reach more than the server lines. This client sends only the line pyeapi sends and claims nothing wider; the device diff is the evidence of what it actually drops.',
      ],
      destructive: true,
    })
  }

  /** Resolve the version-conditional source stem or refuse — the three source verbs share this gate. */
  function resolveStem(): string | undefined {
    if (!stemInfo.ok) { setSourceErrorField(stemInfo.refusal); return undefined }
    return stemInfo.stem
  }

  function beginSetSource() {
    clearErrors()
    if (sessionBusy()) return
    const stem = resolveStem()
    if (stem === undefined) return
    const iface = sourceDraft.trim()
    if (!isInterfaceName(iface)) {
      setSourceErrorField(`"${iface}" is not an interface name this client accepts — the source interface is validated by the same grammar \`setSourceInterface\` runs (assertInterfaceName, resources/validators.ts). Fix the name before staging.`)
      return
    }
    if (settings !== undefined && settings.sourceInterface === iface) {
      setSourceErrorField(`${iface} is already the configured NTP source — staging \`${stem} ${iface}\` opens a session that would change nothing.`)
      return
    }
    const line = `${stem} ${iface}`
    plan({
      description: 'webui ntp set source',
      effectLabel: line,
      specs: [line],
      display: stageDisplay([line]),
      risks: sourceRisk(settings?.sourceInterface, `sets the NTP source interface to ${iface}`),
      destructive: true,
    })
  }

  function beginUnsetSource() {
    clearErrors()
    if (sessionBusy()) return
    if (settings === undefined || settings.sourceInterface === undefined) {
      setSourceErrorField('The running-config carries no configured NTP source \u2014 there is nothing to unset.')
      return
    }
    const stem = resolveStem()
    if (stem === undefined) return
    const line = `no ${stem}`
    plan({
      description: 'webui ntp unset source',
      effectLabel: line,
      specs: [line],
      display: stageDisplay([line]),
      risks: sourceRisk(settings.sourceInterface, 'removes the NTP source line'),
      destructive: true,
    })
  }

  function beginDefaultSource() {
    clearErrors()
    if (sessionBusy()) return
    const stem = resolveStem()
    if (stem === undefined) return
    const line = `default ${stem}`
    plan({
      description: 'webui ntp default source',
      effectLabel: line,
      specs: [line],
      display: stageDisplay([line]),
      risks: sourceRisk(settings?.sourceInterface, 'returns the NTP source to the device default (which this screen cannot predict)'),
      destructive: true,
    })
  }

  function sourceRisk(current: string | undefined, what: string): readonly string[] {
    const now = current === undefined ? 'No source is currently configured (the reader saw no `ntp source` / `ntp local-interface` line).' : `The source currently configured is \`${current}\`.`
    return [
      `${what}. ${now} NTP source changes are treated as high-risk: they move the interface the device uses for NTP, and if that happens to be the interface carrying this UI\u2019s own eAPI path, the page can lose its device path.`,
      'Which interface actually carries the eAPI session is NOT observable from this screen — the only interface it can name is the one `node.ntp.get()` reported above. The confirm names that configured source; whether it is in-band is your call, not a device fact this page can assert.',
    ]
  }

  const serverRows: readonly NtpServerRowView[] = (settings?.servers ?? []).map((row) => ({
    address: row.address,
    prefer: row.prefer,
    onRemove: beginRemoveServer,
  }))

  const state = !canAct || read.state.kind === 'error' ? 'failed' : read.state.kind === 'loading' ? 'loading' : 'ready'

  const viewProps: NtpViewProps = {
    state,
    ...(read.state.kind === 'error' && read.state.message !== '' ? { readError: read.state.message } : {}),
    ...(proxyConfigured ? {} : { proxyPrompt: PROXY_PROMPT }),
    ...(data?.identity === undefined ? {} : { identity: data.identity }),
    serversKnown: settings !== undefined,
    servers: serverRows,
    serverCount: settings?.servers.length ?? 0,
    newAddressDraft,
    newPreferDraft,
    ...(newServerError === undefined ? {} : { newServerError }),
    sourceFormKnown: stemInfo.ok,
    ...(stemInfo.ok ? { sourceStem: stemInfo.stem } : {}),
    onNewAddressChange: (value) => { setNewAddressDraft(value); setNewServerError(undefined) },
    onNewPreferChange: (value) => { setNewPreferDraft(value) },
    onAddServer: (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); beginAddServer() },
    onRemoveAllServers: beginRemoveAllServers,
    sourceKnown: settings !== undefined,
    ...(settings !== undefined && settings.sourceInterface !== undefined ? { sourceInterface: settings.sourceInterface } : {}),
    sourceDraft,
    ...(sourceErrorField === undefined ? {} : { sourceError: sourceErrorField }),
    onSourceChange: (value) => { setSourceDraft(value); setSourceErrorField(undefined) },
    onSetSource: (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); beginSetSource() },
    onUnsetSource: beginUnsetSource,
    onDefaultSource: beginDefaultSource,
    busy: busy || transactionBusy,
    canAct: canAct && state === 'ready',
    notice,
    failure,
    connection: !canAct || state === 'failed' ? 'error' : state === 'loading' || busy || transactionBusy ? 'connecting' : 'connected',
    connectionLabel: !canAct
      ? 'Local proxy is not configured'
      : state === 'loading'
        ? 'Reading the running-config\u2026'
        : state === 'failed'
          ? 'The NTP read did not come back'
          : 'NTP settings read from the parsed running-config',
    onReload: () => { clearErrors(); read.reload() },
  }

  return <NtpView {...viewProps} />
}
