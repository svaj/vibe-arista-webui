/**
 * #87 (OSPF slice): the container behind the OSPF process editor (`#/routing/ospf`). Owns the reads,
 * the form state, and the staging; the presentation half (`OspfManagerView`) is pure props.
 *
 * ## Reads (SPEC-ospf-editor.md, "Screen & UX")
 *
 * - **HARD** `node.ospf.get()` — the configured process. `undefined` is the screen's NORMAL empty
 *   state (this box runs zero OSPF processes today); a failure is the error wall, never a blank table.
 * - **SOFT** `show('ip ospf')` / `show('ip ospf neighbor')` — the device-side panels, never merged
 *   with the config read (the S14/#84 convention). The neighbor read is a COUNT only: the entry shape
 *   is carried by no capture (`src/eapi/show-contracts.ts`).
 * - **SOFT** `node.routemaps.getAll()` — used ONLY to annotate a redistribution's route-map name
 *   that the running-config does not list. Never a refusal (the device accepts dangling references
 *   at stage time — captured, run 9); a failed read says "unverified".
 * - **SOFT silent** `show('version')` — the identity chip.
 *
 * ## Staging (the #141 boundary)
 *
 * Every form appends to the shared transaction through `useTransaction()`; commands are the flat
 * line arrays `ospf-rules.ts` composes byte-for-byte from the client's own verb text (the DR-153
 * mirroring convention — `ospf.ts` verbs are send-only, so there is no dry-run seam to call). This
 * screen never calls `configSession`, never commits, never aborts — Transaction Center owns those.
 */
import { useState } from 'react'
import type { FormEvent } from 'react'
import type { Node, OspfState } from '@devhax-heavy-industries/arista-eapi'

import { softErrorText, softRead, softValue, useDeviceRead } from '../../shared/use-device-read'
import type { DeviceIdentity } from '../../shared/identity'
import { identityFrom } from '../../shared/identity'
import { useOperation } from '../../shared/use-operation'
import { TransactionScope, useTransaction, useTransactionSnapshot } from '../sessions/TransactionContext'
import { OspfManagerView } from './OspfManagerView'
import type { OspfManagerViewProps } from './OspfManagerView'
import { ospfDeviceRows, ospfNeighborSummary } from './routing-rules'
import type { ShowIpOspfNeighborReply, ShowIpOspfReply } from '../../eapi/show-contracts'
import {
  OSPF_ADJACENCY_BLAST_FACT,
  OSPF_REDISTRIBUTION_PROTOCOLS,
  OSPF_ROUTE_BLAST_FACT,
  OSPF_ROUTE_MAP_READ_UNAVAILABLE_NOTE,
  OSPF_ROUTE_MAP_READ_UNKNOWN,
  OSPF_ROUTER_ID_MECHANISM,
  ospfAddNetworkLines,
  ospfAddRedistributionLines,
  ospfCreateConfirmation,
  ospfCreateLines,
  ospfDeleteProcessConfirmation,
  ospfDeleteProcessLines,
  ospfEditRisks,
  ospfNetworkAddConfirmation,
  ospfNetworkPresent,
  ospfNetworkRemoveConfirmation,
  ospfNetworkRows,
  ospfRedistributionAddConfirmation,
  ospfRedistributionPresent,
  ospfRedistributionRemoveConfirmation,
  ospfRedistributionRows,
  ospfRouteMapKnown,
  ospfRouteMapUnlistedFact,
  ospfRouterIdConfirmation,
  ospfRouterIdLines,
  ospfShutdownConfirmation,
  ospfShutdownLines,
  ospfNoShutdownLines,
  ospfRemoveNetworkLines,
  ospfRemoveRedistributionLines,
  ospfUnsetRouterIdLines,
  parseOspfNetworkTarget,
  validateOspfArea,
  validateOspfMaskLen,
  validateOspfProcessId,
  validateOspfProtocol,
  validateOspfToken,
  validateOspfVrfName,
} from './ospf-rules'
import type { OspfConfirmation } from './ospf-rules'

// The typed `show(...)` overloads — same augmentation Routing/VrrpManager/RouteMapManager import.
import '../../eapi/show-contracts'

/** The seams this screen may touch — the type itself cannot reach a write verb. */
export type OspfManagerClient = Pick<Node, 'ospf' | 'routemaps' | 'show' | 'configSession'>

export interface OspfManagerProps {
  readonly node: OspfManagerClient | undefined
  readonly proxyConfigured?: boolean
}

interface ReadData {
  /** `undefined` = no `router ospf` section (a NORMAL state — this box runs zero processes). */
  readonly state?: OspfState
  readonly ospfShow?: ShowIpOspfReply
  readonly ospfShowFailure?: string
  readonly neighborShow?: ShowIpOspfNeighborReply
  readonly neighborShowFailure?: string
  /** `undefined` = the route-map read did not answer (the annotation degrades to "unverified"). */
  readonly routeMapNames?: ReadonlySet<string>
  readonly routeMapReadFailed: boolean
  readonly identity?: DeviceIdentity
}

interface PendingStage {
  readonly effectLabel: string
  readonly lines: readonly string[]
  readonly risks: readonly string[]
  readonly confirmations: readonly OspfConfirmation[]
}

const PROXY_PROMPT = 'Local proxy is not configured. Set EAPI_HOST, EAPI_USER, and EAPI_PASS in arista-webui/.env.local, then restart Vite.'

const EMPTY_CREATE = { processId: '', vrf: '' }
const EMPTY_ROUTER_ID = { mode: '', value: '' }
const EMPTY_NETWORK = { mode: '', network: '', mask: '', area: '0.0.0.0', target: '' }
const EMPTY_REDISTRIBUTION = { mode: '', protocol: '', routeMap: '', target: '' }
const EMPTY_SHUTDOWN = { mode: '' }

export function OspfManager(props: OspfManagerProps) {
  return <TransactionScope node={props.node}><OspfManagerWorkspace {...props} /></TransactionScope>
}

function OspfManagerWorkspace({ node, proxyConfigured = true }: OspfManagerProps) {
  const operation = useOperation()
  const { busy, notice, failure } = operation
  const transaction = useTransaction()
  const transactionState = useTransactionSnapshot()
  const transactionBusy = transactionState.status === 'opening' || transactionState.status === 'staging' || transactionState.status === 'committing' || transactionState.status === 'aborting'
  const canAct = proxyConfigured && node !== undefined && transaction !== undefined && transactionState.status !== 'uncertain'

  const [createDraft, setCreateDraft] = useState(EMPTY_CREATE)
  const [createError, setCreateError] = useState<string | undefined>(undefined)
  const [routerIdDraft, setRouterIdDraft] = useState(EMPTY_ROUTER_ID)
  const [routerIdError, setRouterIdError] = useState<string | undefined>(undefined)
  const [networkDraft, setNetworkDraft] = useState(EMPTY_NETWORK)
  const [networkError, setNetworkError] = useState<string | undefined>(undefined)
  const [redistributionDraft, setRedistributionDraft] = useState(EMPTY_REDISTRIBUTION)
  const [redistributionError, setRedistributionError] = useState<string | undefined>(undefined)
  const [shutdownDraft, setShutdownDraft] = useState(EMPTY_SHUTDOWN)
  const [shutdownError, setShutdownError] = useState<string | undefined>(undefined)

  const read = useDeviceRead<ReadData>(
    async () => {
      if (node === undefined) throw new Error('no device client')
      // The HARD read first: no process is the screen's normal state, a failure is the error branch.
      const state = await node.ospf.get()
      const ospfShowRead = await softRead(node.show('ip ospf'))
      const neighborRead = await softRead(node.show('ip ospf neighbor'))
      // SOFT and annotation-only: its failure never blocks a form, it only says "unverified".
      const routeMapRead = await softRead(node.routemaps.getAll())
      const versionRead = await softRead(node.show('version'), { silent: true })
      const version = softValue(versionRead)
      const routeMaps = softValue(routeMapRead)
      return {
        ...(state === undefined ? {} : { state }),
        ...(softValue(ospfShowRead) === undefined ? { ospfShowFailure: softErrorText(ospfShowRead) ?? 'The `show ip ospf` read did not answer.' } : { ospfShow: softValue(ospfShowRead) }),
        ...(softValue(neighborRead) === undefined ? { neighborShowFailure: softErrorText(neighborRead) ?? 'The `show ip ospf neighbor` read did not answer.' } : { neighborShow: softValue(neighborRead) }),
        ...(routeMaps === undefined ? { routeMapReadFailed: true } : { routeMapNames: new Set(routeMaps.keys()), routeMapReadFailed: false }),
        ...(version === undefined ? {} : { identity: identityFrom(version) }),
      }
    },
    [node],
    { enabled: canAct, disabledMessage: '' },
  )
  const data = read.state.kind === 'ready' ? read.state.data : undefined
  const process = data?.state
  const processId = process === undefined ? '' : String(process.ospfProcessId)

  // The risk line carried by a staged entry naming a route-map. A failed read
  // says UNVERIFIED — never "missing", because the read that would have
  // answered it is the one that failed. The panel note
  // (OSPF_ROUTE_MAP_READ_UNAVAILABLE_NOTE) is a different string for a
  // different surface, and stays on the panel.
  function routeMapFacts(routeMap: string): readonly string[] {
    if (routeMap === '') return []
    if (data?.routeMapReadFailed === true) return [OSPF_ROUTE_MAP_READ_UNKNOWN]
    if (data?.routeMapNames === undefined || ospfRouteMapKnown(data.routeMapNames, routeMap)) return []
    return [ospfRouteMapUnlistedFact(routeMap)]
  }

  function clearErrors() {
    setCreateError(undefined)
    setRouterIdError(undefined)
    setNetworkError(undefined)
    setRedistributionError(undefined)
    setShutdownError(undefined)
    operation.clear()
  }

  async function stage(pending: PendingStage) {
    if (busy || transactionBusy || !canAct || transaction === undefined) return
    await operation.run(() => transaction.append({
      source: '/routing/ospf',
      action: pending.effectLabel,
      commands: pending.lines,
      display: pending.lines,
      risks: pending.risks,
      ...(pending.confirmations.length > 0 ? { confirmations: pending.confirmations } : {}),
    }), {
      progress: 'Adding the OSPF change to the shared transaction…',
      success: 'OSPF change added to the transaction. Review the device diff, then commit in Transaction Center — the second confirm repeats the measured blast proxy and what it did and did not measure.',
    })
  }

  /** Refuse a write while another staged batch owns this screen; returns true when blocked. */
  function stagingBusy(needProcess: boolean): boolean {
    if (busy || transactionBusy || !canAct || node === undefined) return true
    if (data === undefined || (needProcess && process === undefined)) {
      operation.run(async () => { throw new Error(needProcess ? 'No `router ospf` process was read, so there is nothing to edit here — use the Create form (or reload).' : 'The OSPF read has not answered, so nothing can be compared or staged against it.') }).catch(() => undefined)
      return true
    }
    return false
  }

  function beginCreate(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    clearErrors()
    if (stagingBusy(false)) return
    const idRefusal = validateOspfProcessId(createDraft.processId)
    if (idRefusal !== undefined) { setCreateError(idRefusal); return }
    const vrfRefusal = validateOspfVrfName(createDraft.vrf)
    if (vrfRefusal !== undefined) { setCreateError(vrfRefusal); return }
    // The client models ONE process (divergence 7), so a second create is refused at zero appends —
    // this screen cannot address the one it would create.
    if (process !== undefined) {
      setCreateError(`The read already shows \`router ospf ${String(process.ospfProcessId)}\` — this client reads and writes ONE process (module divergence 7), so this screen refuses a second create at zero appends. Delete the existing process first, or use the console for a multi-process node.`)
      return
    }
    const vrf = createDraft.vrf.trim()
    const lines = ospfCreateLines(createDraft.processId, vrf)
    void stage({
      effectLabel: `create router ospf ${createDraft.processId}${vrf === '' ? '' : ` vrf ${vrf}`}`,
      lines,
      risks: ospfEditRisks(lines, ['No adjacency or advertisement blast is measured for a bare process create on any target — the confirm states the captured posture (`no ip routing`, zero processes) instead of a number.']),
      confirmations: [ospfCreateConfirmation(createDraft.processId, vrf)],
    })
    setCreateDraft(EMPTY_CREATE)
  }

  function beginDeleteProcess(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    clearErrors()
    if (stagingBusy(true)) return
    const lines = ospfDeleteProcessLines(processId)
    void stage({
      effectLabel: `delete router ospf ${processId}`,
      lines,
      risks: ospfEditRisks(lines, [`Deleting the process removes its adjacencies, advertised networks, and redistributions at once. ${OSPF_ADJACENCY_BLAST_FACT}`]),
      confirmations: [ospfDeleteProcessConfirmation(processId)],
    })
  }

  function beginRouterId(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    clearErrors()
    if (stagingBusy(true)) return
    if (routerIdDraft.mode !== 'set' && routerIdDraft.mode !== 'clear') { setRouterIdError('Choose set or clear for the router-id.'); return }
    if (routerIdDraft.mode === 'set') {
      const refusal = validateOspfToken('router-id', routerIdDraft.value)
      if (refusal !== undefined) { setRouterIdError(refusal); return }
      if (process?.routerId === routerIdDraft.value) {
        setRouterIdError(`The process's router-id already says \`${routerIdDraft.value}\` — staging the same value again would be a no-op line, so this screen refuses it at zero appends.`)
        return
      }
      const lines = ospfRouterIdLines(processId, routerIdDraft.value)
      void stage({
        effectLabel: `set router-id ${routerIdDraft.value} on router ospf ${processId}`,
        lines,
        risks: ospfEditRisks(lines, [OSPF_ROUTER_ID_MECHANISM, OSPF_ADJACENCY_BLAST_FACT]),
        confirmations: [ospfRouterIdConfirmation(processId, 'set')],
      })
    } else {
      if (process?.routerId === undefined) {
        setRouterIdError('The process carries no `router-id` line to clear — staging `no router-id` against nothing would be a no-op line, so this screen refuses it at zero appends.')
        return
      }
      const lines = ospfUnsetRouterIdLines(processId)
      void stage({
        effectLabel: `clear router-id on router ospf ${processId}`,
        lines,
        risks: ospfEditRisks(lines, [OSPF_ROUTER_ID_MECHANISM, OSPF_ADJACENCY_BLAST_FACT]),
        confirmations: [ospfRouterIdConfirmation(processId, 'clear')],
      })
    }
    setRouterIdDraft(EMPTY_ROUTER_ID)
  }

  function beginNetwork(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    clearErrors()
    if (stagingBusy(true)) return
    if (networkDraft.mode !== 'add' && networkDraft.mode !== 'remove') { setNetworkError('Choose add or remove for the network statement.'); return }
    if (networkDraft.mode === 'add') {
      const netRefusal = validateOspfToken('network address', networkDraft.network)
      if (netRefusal !== undefined) { setNetworkError(netRefusal); return }
      const maskRefusal = validateOspfMaskLen(networkDraft.mask)
      if (maskRefusal !== undefined) { setNetworkError(maskRefusal); return }
      const areaRefusal = validateOspfArea(networkDraft.area)
      if (areaRefusal !== undefined) { setNetworkError(areaRefusal); return }
      if (process !== undefined && ospfNetworkPresent(process, networkDraft.network, networkDraft.mask, networkDraft.area)) {
        setNetworkError(`\`network ${networkDraft.network}/${networkDraft.mask} area ${networkDraft.area}\` is already in the read — staging the same statement again would be a no-op line, so this screen refuses it at zero appends.`)
        return
      }
      const lines = ospfAddNetworkLines(processId, networkDraft.network, networkDraft.mask, networkDraft.area)
      void stage({
        effectLabel: `add network ${networkDraft.network}/${networkDraft.mask} area ${networkDraft.area} on router ospf ${processId}`,
        lines,
        risks: ospfEditRisks(lines, [`A network statement enables OSPF on the matching interface and advertises the prefix. ${OSPF_ROUTE_BLAST_FACT}`]),
        confirmations: [ospfNetworkAddConfirmation(processId, networkDraft.network, networkDraft.mask, networkDraft.area)],
      })
      setNetworkDraft({ ...EMPTY_NETWORK })
      return
    }
    const target = parseOspfNetworkTarget(networkDraft.target)
    if (target === undefined) { setNetworkError('Choose the network statement to remove — the picker lists exactly what this read parsed (only dotted-quad areas appear there; see the area note).'); return }
    const lines = ospfRemoveNetworkLines(processId, target.network, target.netmask, target.area)
    void stage({
      effectLabel: `remove network ${target.network}/${target.netmask} area ${target.area} on router ospf ${processId}`,
      lines,
      risks: ospfEditRisks(lines, [`Removing the statement withdraws the prefix it advertised and can drop the adjacency on that interface. ${OSPF_ROUTE_BLAST_FACT}`]),
      confirmations: [ospfNetworkRemoveConfirmation(processId, target.network, target.netmask, target.area)],
    })
    setNetworkDraft({ ...EMPTY_NETWORK })
  }

  function beginRedistribution(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    clearErrors()
    if (stagingBusy(true)) return
    if (redistributionDraft.mode !== 'add' && redistributionDraft.mode !== 'remove') { setRedistributionError('Choose add or remove for the redistribution.'); return }
    if (redistributionDraft.mode === 'add') {
      const protocolRefusal = validateOspfProtocol(redistributionDraft.protocol)
      if (protocolRefusal !== undefined) { setRedistributionError(protocolRefusal); return }
      const routeMap = redistributionDraft.routeMap.trim()
      if (routeMap !== '') {
        const mapRefusal = validateOspfToken('route-map name', routeMap)
        if (mapRefusal !== undefined) { setRedistributionError(mapRefusal); return }
      }
      if (process !== undefined && ospfRedistributionPresent(process, redistributionDraft.protocol, routeMap)) {
        setRedistributionError(`\`redistribute ${redistributionDraft.protocol}${routeMap === '' ? '' : ` route-map ${routeMap}`}\` is already in the read — staging the same line again would be a no-op, so this screen refuses it at zero appends.`)
        return
      }
      const lines = ospfAddRedistributionLines(processId, redistributionDraft.protocol, routeMap)
      void stage({
        effectLabel: `redistribute ${redistributionDraft.protocol}${routeMap === '' ? '' : ` route-map ${routeMap}`} on router ospf ${processId}`,
        lines,
        risks: ospfEditRisks(lines, [`Redistribution injects routes from another source into OSPF. ${OSPF_ROUTE_BLAST_FACT}`, ...routeMapFacts(routeMap)]),
        confirmations: [ospfRedistributionAddConfirmation(processId, redistributionDraft.protocol, routeMap, routeMapFacts(routeMap))],
      })
      setRedistributionDraft(EMPTY_REDISTRIBUTION)
      return
    }
    if (redistributionDraft.target === '') { setRedistributionError('Choose the redistribution line to remove — the picker lists what this read parsed.'); return }
    const protocol = redistributionDraft.target.split('/')[0] as string
    const qualifiedCount = process === undefined ? 0 : process.redistributions.filter((row) => row.protocol === protocol).length
    const lines = ospfRemoveRedistributionLines(processId, protocol)
    void stage({
      effectLabel: `no redistribute ${protocol} on router ospf ${processId}`,
      lines,
      risks: ospfEditRisks(lines, [`Removing the redistribution withdraws every route it was injecting. ${OSPF_ROUTE_BLAST_FACT}`]),
      confirmations: [ospfRedistributionRemoveConfirmation(processId, protocol, qualifiedCount)],
    })
    setRedistributionDraft(EMPTY_REDISTRIBUTION)
  }

  function beginShutdown(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    clearErrors()
    if (stagingBusy(true)) return
    if (shutdownDraft.mode !== 'shutdown' && shutdownDraft.mode !== 'no-shutdown') { setShutdownError('Choose which way to move the shutdown state.'); return }
    const turningOff = shutdownDraft.mode === 'shutdown'
    if (process !== undefined && process.shutdown === turningOff) {
      setShutdownError(turningOff
        ? 'The process is already shut down in the read — staging `shutdown` again would be a no-op line, so this screen refuses it at zero appends.'
        : 'The process is already up in the read (it carries `no shutdown` or no shutdown line at all is read as up) — staging `no shutdown` again would be a no-op line, so this screen refuses it at zero appends.')
      return
    }
    const lines = turningOff ? ospfShutdownLines(processId) : ospfNoShutdownLines(processId)
    void stage({
      effectLabel: `${turningOff ? 'shutdown' : 'no shutdown'} router ospf ${processId}`,
      lines,
      risks: ospfEditRisks(lines, [turningOff
        ? 'Shutting the process down tears down every adjacency and withdraws every advertised route at once.'
        : 'Bringing the process up starts forming adjacencies and advertising its networks.', OSPF_ADJACENCY_BLAST_FACT]),
      confirmations: [ospfShutdownConfirmation(processId, turningOff)],
    })
    setShutdownDraft(EMPTY_SHUTDOWN)
  }

  const state = !canAct || read.state.kind === 'error' ? 'failed' : read.state.kind === 'loading' ? 'loading' : 'ready'

  const viewProps: OspfManagerViewProps = {
    state,
    ...(read.state.kind === 'error' && read.state.message !== '' ? { readError: read.state.message } : {}),
    ...(proxyConfigured ? {} : { proxyPrompt: PROXY_PROMPT }),
    ...(data?.identity === undefined ? {} : { identity: data.identity }),
    configKnown: data !== undefined,
    ...(process === undefined ? {} : {
      process: {
        processId: String(process.ospfProcessId),
        vrf: process.vrf,
        routerId: process.routerId ?? '(the section carries no `router-id` line)',
        shutdown: process.shutdown ? 'shutdown' : 'no shutdown',
      },
    }),
    networkRows: process === undefined ? [] : ospfNetworkRows(process),
    redistributionRows: process === undefined ? [] : ospfRedistributionRows(process),
    ...(data === undefined || data.ospfShow === undefined ? {} : { deviceRows: ospfDeviceRows(data.ospfShow) }),
    ...(data?.ospfShowFailure === undefined ? {} : { deviceFailure: data.ospfShowFailure }),
    ...(data === undefined || data.neighborShow === undefined ? {} : { neighbor: ospfNeighborSummary(data.neighborShow) }),
    ...(data?.neighborShowFailure === undefined ? {} : { neighborFailure: data.neighborShowFailure }),
    ...(data?.routeMapReadFailed === true ? { routeMapReadNote: OSPF_ROUTE_MAP_READ_UNAVAILABLE_NOTE } : {}),
    protocols: OSPF_REDISTRIBUTION_PROTOCOLS,
    createDraft,
    ...(createError === undefined ? {} : { createError }),
    onCreateChange: (patch) => { setCreateDraft((draft) => ({ ...draft, ...patch })); setCreateError(undefined) },
    onCreateSubmit: beginCreate,
    deleteDraftEnabled: process !== undefined,
    onDeleteSubmit: beginDeleteProcess,
    routerIdDraft,
    ...(routerIdError === undefined ? {} : { routerIdError }),
    onRouterIdChange: (patch) => { setRouterIdDraft((draft) => ({ ...draft, ...patch })); setRouterIdError(undefined) },
    onRouterIdSubmit: beginRouterId,
    networkDraft,
    ...(networkError === undefined ? {} : { networkError }),
    onNetworkChange: (patch) => { setNetworkDraft((draft) => ({ ...draft, ...patch })); setNetworkError(undefined) },
    onNetworkSubmit: beginNetwork,
    redistributionDraft,
    ...(redistributionError === undefined ? {} : { redistributionError }),
    onRedistributionChange: (patch) => { setRedistributionDraft((draft) => ({ ...draft, ...patch })); setRedistributionError(undefined) },
    onRedistributionSubmit: beginRedistribution,
    shutdownDraft,
    ...(shutdownError === undefined ? {} : { shutdownError }),
    onShutdownChange: (patch) => { setShutdownDraft((draft) => ({ ...draft, ...patch })); setShutdownError(undefined) },
    onShutdownSubmit: beginShutdown,
    busy: busy || transactionBusy,
    canAct: canAct && state === 'ready',
    notice,
    failure,
    connection: !canAct || state === 'failed' ? 'error' : state === 'loading' || busy || transactionBusy ? 'connecting' : 'connected',
    connectionLabel: !canAct
      ? 'Local proxy is not configured'
      : state === 'loading'
        ? 'Reading the configured OSPF process…'
        : state === 'failed'
          ? 'The OSPF read did not come back'
          : process === undefined
            ? 'No `router ospf` section in the running-config (a normal state)'
            : `router ospf ${String(process.ospfProcessId)} read from the parsed running-config`,
    onReload: () => { clearErrors(); read.reload() },
  }

  return <OspfManagerView {...viewProps} />
}
