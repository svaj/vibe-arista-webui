/**
 * B2 (#87): the READ-ONLY routing status screen — route `#/routing`. Container half of the standing
 * S8 (#78) split: it owns the reads and nothing else. There is deliberately NO write path, no config
 * session, and no confirm flow here: #87 keeps every routing write blocked behind a per-protocol
 * blast-radius review, so the container's seam is `Pick<Node, 'ospf' | 'routemaps' | 'vrrp' | 'show'>`
 * — it cannot even see a `configSession` — and the view renders a standing banner saying editors are
 * not offered.
 *
 * ## Reads (and which may fail without blanking the screen)
 *
 * Configured state (the HARD reads — a failure here is the error branch):
 * - `node.ospf.get()` (`resources/ospf.ts`) — the `router ospf` section, or `undefined` when no
 *   OSPF process is configured. `undefined` is a NORMAL ready payload, never an error.
 * - `node.routemaps.getAll()` / `node.vrrp.getAll()` — parsed-config tables; an empty table is a
 *   normal configured state.
 *
 * Device state (SOFT reads through `softRead`/`softErrorText` — each folds its own failure into the
 * payload so one unmodelled or refused `show` never blanks the screen):
 * - `node.show('ip ospf')`, `node.show('ip ospf neighbor')`, `node.show('route-map')`,
 *   `node.show('vrrp')` — the capture-backed contracts in `src/eapi/show-contracts.ts`.
 * - `node.show('version')` — silent soft read for the identity chip only (Ntp/S6/Mlag pattern).
 *
 * BGP is NOT read at all: `show bgp summary`/`show bgp neighbors` are a recorded double negative on
 * both targets (hardware `Error [1000] % Not supported`, cEOS `errors: ["Not supported"]`), so the
 * commands stay unmodelled and the view states the negative rather than issuing a doomed read or
 * inventing a shape (DR-043). ./routing-rules.ts carries the standing notes and every row mapping.
 */
import type { Node, OspfState, RoutemapEntry, VrrpVridTable } from '@devhax-heavy-industries/arista-eapi'

import { softErrorText, softRead, softValue, useDeviceRead } from '../../shared/use-device-read'
import type { DeviceIdentity } from '../../shared/identity'
import { identityFrom } from '../../shared/identity'
import { RoutingView } from './RoutingView'
import type { SoftFailure } from './RoutingView'
import {
  ospfConfigRows,
  ospfDeviceRows,
  ospfNeighborSummary,
  ospfNetworkRows,
  ospfRedistributionRows,
  routeMapClauseRows,
  routeMapDeviceRows,
  vrrpConfigRows,
  vrrpDeviceCount,
} from './routing-rules'

// The typed `show(...)` overloads — same augmentation the Mlag/Stp/Vrfs screens import.
import '../../eapi/show-contracts'
import type { ShowIpOspfNeighborReply, ShowIpOspfReply, ShowRouteMapReply, ShowVrrpReply } from '../../eapi/show-contracts'

/** The four model seams plus nothing else — the type itself cannot reach a config session. */
export type RoutingClient = Pick<Node, 'ospf' | 'routemaps' | 'vrrp' | 'show'>

export interface RoutingProps {
  readonly node: RoutingClient | undefined
  readonly proxyConfigured?: boolean
}

interface ReadData {
  /** `undefined` = no OSPF process configured (a normal state, distinct from "unread"). */
  readonly ospfConfig?: OspfState
  readonly routeMapConfig: ReadonlyMap<string, RoutemapEntry>
  readonly vrrpConfig: ReadonlyMap<string, VrrpVridTable>
  readonly ospfShow?: ShowIpOspfReply
  readonly ospfShowFailure?: string
  readonly ospfNeighborShow?: ShowIpOspfNeighborReply
  readonly ospfNeighborShowFailure?: string
  readonly routeMapShow?: ShowRouteMapReply
  readonly routeMapShowFailure?: string
  readonly vrrpShow?: ShowVrrpReply
  readonly vrrpShowFailure?: string
  readonly identity?: DeviceIdentity
}

const PROXY_PROMPT = 'Local proxy is not configured. Set EAPI_HOST, EAPI_USER, and EAPI_PASS in arista-webui/.env.local, then restart Vite.'

export function Routing({ node, proxyConfigured = true }: RoutingProps) {
  const canAct = proxyConfigured && node !== undefined

  const read = useDeviceRead<ReadData>(
    async () => {
      if (node === undefined) throw new Error('no device client')
      // The three configured-state reads first: an unconfigured answer is the screen's normal state.
      const [ospfConfig, routeMapConfig, vrrpConfig] = await Promise.all([
        node.ospf.get(),
        node.routemaps.getAll(),
        node.vrrp.getAll(),
      ])
      // The device-state reads are independent soft reads — each folds its own refusal text.
      const ospfRead = await softRead(node.show('ip ospf'))
      const neighborRead = await softRead(node.show('ip ospf neighbor'))
      const routeMapRead = await softRead(node.show('route-map'))
      const vrrpRead = await softRead(node.show('vrrp'))
      const versionRead = await softRead(node.show('version'), { silent: true })
      const version = softValue(versionRead)
      return {
        ...(ospfConfig === undefined ? {} : { ospfConfig }),
        routeMapConfig,
        vrrpConfig,
        ...(softValue(ospfRead) === undefined ? { ospfShowFailure: softErrorText(ospfRead) ?? 'The `show ip ospf` read did not answer.' } : { ospfShow: softValue(ospfRead) }),
        ...(softValue(neighborRead) === undefined ? { ospfNeighborShowFailure: softErrorText(neighborRead) ?? 'The `show ip ospf neighbor` read did not answer.' } : { ospfNeighborShow: softValue(neighborRead) }),
        ...(softValue(routeMapRead) === undefined ? { routeMapShowFailure: softErrorText(routeMapRead) ?? 'The `show route-map` read did not answer.' } : { routeMapShow: softValue(routeMapRead) }),
        ...(softValue(vrrpRead) === undefined ? { vrrpShowFailure: softErrorText(vrrpRead) ?? 'The `show vrrp` read did not answer.' } : { vrrpShow: softValue(vrrpRead) }),
        ...(version === undefined ? {} : { identity: identityFrom(version) }),
      }
    },
    [node],
    { enabled: canAct, disabledMessage: '' },
  )

  const data = read.state.kind === 'ready' ? read.state.data : undefined
  const state = !canAct || read.state.kind === 'error' ? 'failed' : read.state.kind === 'loading' ? 'loading' : 'ready'

  const soft = (value: string | undefined): SoftFailure | undefined => (value === undefined ? undefined : { reason: value })

  return <RoutingView
    state={state}
    {...(read.state.kind === 'error' && read.state.message !== '' ? { readError: read.state.message } : {})}
    {...(proxyConfigured ? {} : { proxyPrompt: PROXY_PROMPT })}
    {...(data?.identity === undefined ? {} : { identity: data.identity })}
    configKnown={data !== undefined}
    ospfConfigured={data?.ospfConfig !== undefined}
    ospfConfigRows={ospfConfigRows(data?.ospfConfig)}
    ospfNetworkRows={ospfNetworkRows(data?.ospfConfig)}
    ospfRedistributionRows={ospfRedistributionRows(data?.ospfConfig)}
    routeMapClauseRows={data === undefined ? [] : routeMapClauseRows(data.routeMapConfig)}
    vrrpConfigRows={data === undefined ? [] : vrrpConfigRows(data.vrrpConfig)}
    ospfDeviceRows={ospfDeviceRows(data?.ospfShow)}
    {...(data === undefined || data.ospfNeighborShow === undefined ? {} : { ospfNeighbor: ospfNeighborSummary(data.ospfNeighborShow) })}
    routeMapDeviceRows={routeMapDeviceRows(data?.routeMapShow)}
    {...(data === undefined || data.vrrpShow === undefined ? {} : { vrrpDeviceCount: vrrpDeviceCount(data.vrrpShow) })}
    {...(data === undefined || data.ospfShowFailure === undefined ? {} : { ospfShowFailure: soft(data.ospfShowFailure) })}
    {...(data === undefined || data.ospfNeighborShowFailure === undefined ? {} : { ospfNeighborShowFailure: soft(data.ospfNeighborShowFailure) })}
    {...(data === undefined || data.routeMapShowFailure === undefined ? {} : { routeMapShowFailure: soft(data.routeMapShowFailure) })}
    {...(data === undefined || data.vrrpShowFailure === undefined ? {} : { vrrpShowFailure: soft(data.vrrpShowFailure) })}
    canAct={canAct}
    connection={!canAct || state === 'failed' ? 'error' : state === 'loading' ? 'connecting' : 'connected'}
    connectionLabel={!canAct
      ? 'Local proxy is not configured'
      : state === 'loading'
        ? 'Reading routing state\u2026'
        : state === 'failed'
          ? 'A routing config read did not come back'
          : 'Reads served: parsed running-config plus the captured routing show replies'}
    onReload={() => read.reload()}
  />
}
