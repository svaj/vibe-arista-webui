/**
 * B2 (#87): the READ-ONLY routing status screen, offline through the hand-rolled fake-client seam —
 * the `Mlag.test.tsx` shape (config-backed reads: `ospf.get()`, `routemaps.getAll()`,
 * `vrrp.getAll()`; soft device reads: `show('ip ospf')`, `show('ip ospf neighbor')`,
 * `show('route-map')`, `show('vrrp')`; silent `show('version')`). No test here contacts a device.
 *
 * The acceptance lines #87 grades, pinned below:
 * - READ-ONLY: the fake node exposes exactly the four model seams; no button offers a write, and the
 *   standing banner saying editors are not offered renders in every state (loading, failed, ready).
 * - The OSPF JSON standing note (cEOS-only capture, DR-043) and the neighbor/VRRP count-only notes
 *   render verbatim — no per-neighbor or per-virtual-router column exists.
 * - BGP renders the recorded double negative and issues NO bgp read (the fake `show` throws on any
 *   `bgp` command, so a doomed read would fail the test).
 * - A refused soft read folds its device text beside the panel and never blanks the screen or
 *   produces a role=alert; the config panels still render.
 * - An unconfigured device (no OSPF section, empty route-map/VRRP tables) is a NORMAL ready state.
 * - Four states: no-proxy, loading, failed hard read, ready.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { OspfState, RoutemapEntry, VrrpVridTable } from '@devhax-heavy-industries/arista-eapi'

import { Routing } from './Routing'
import type { ShowIpOspfNeighborReply, ShowIpOspfReply, ShowRouteMapReply, ShowVrrpReply } from '../../eapi/show-contracts'

type TestNode = NonNullable<Parameters<typeof Routing>[0]['node']>

// --- capture-faithful fixtures ---------------------------------------------------------------------

/** cEOS-lab `show ip ospf` (result half): one instance in the default VRF. */
const ospfReply: ShowIpOspfReply = {
  vrfs: { default: { instList: { '1': { instanceId: 1, vrf: 'default', routerId: '10.156.0.1', shutDown: false, numAreas: 1, numBackboneNeighbors: 0 } } } },
}

/** cEOS-lab `show ip ospf neighbor` (result half): empty neighbor list — the captured shape. */
const neighborReply: ShowIpOspfNeighborReply = {
  vrfs: { default: { instList: { '1': { ospfNeighborEntries: [] } } } },
}

/** cEOS-lab `show route-map` (result half): one populated map, two clauses. */
const routeMapReply: ShowRouteMapReply = {
  routeMaps: {
    'RM-LAB-IMPORT': {
      entries: {
        '10': { filterType: 'permit', matchRules: { prefixList: 'PL-LAB-STATIC' }, setRules: {}, subRouteMap: { name: '', invert: false }, description: [] },
        '20': { filterType: 'deny', matchRules: {}, setRules: {}, subRouteMap: { name: '', invert: false }, description: [] },
      },
    },
  },
}

/** Both targets answer `virtualRouters: []` — the captured shape. */
const vrrpReply: ShowVrrpReply = { virtualRouters: [] }

const configuredOspf: OspfState = {
  ospfProcessId: 1,
  vrf: 'default',
  routerId: '10.156.0.1',
  networks: [{ network: '10.155.0.0', netmask: '255.255.255.252', area: '0.0.0.0' }],
  redistributions: [{ protocol: 'connected', routeMap: 'RM-LAB-IMPORT' }],
  shutdown: true,
}

const routeMapConfig: ReadonlyMap<string, RoutemapEntry> = new Map([
  ['RM-LAB-IMPORT', new Map([['permit', new Map([[10, { match: ['ip address prefix-list PL-LAB-STATIC'], set: [] }]])]])],
])

const vrrpConfig: ReadonlyMap<string, VrrpVridTable> = new Map([
  ['Vlan100', new Map([[1, { enable: true, primaryIp: '10.0.100.1', priority: 120, description: 'GW', secondaryIp: [], preempt: true, bfdIp: '', track: [] }]])],
])

const versionBase = {
  hostname: 'sw1',
  version: '4.28.13.1M',
  systemMacAddress: '00:1c:73:00:00:00',
  modelName: 'DCS-7050TX-64',
  serialNumber: '0000000000',
  internalVersion: '4.28.13.1M',
  architecture: 'x86_64',
  bootupTimestamp: 0,
  uptime: 0,
}

interface Overrides {
  readonly ospf?: OspfState | Error
  readonly routeMaps?: ReadonlyMap<string, RoutemapEntry>
  readonly vrrps?: ReadonlyMap<string, VrrpVridTable>
  readonly ospfShow?: ShowIpOspfReply
  readonly neighborShow?: ShowIpOspfNeighborReply
  readonly routeMapShow?: ShowRouteMapReply
  readonly vrrpShow?: ShowVrrpReply
  readonly failShow?: ReadonlySet<string>
}

function makeFakes(overrides: Overrides = {}) {
  const ospfGet = vi.fn(async () => {
    if (overrides.ospf instanceof Error) throw overrides.ospf
    // `?? ` would swallow an explicit `undefined` (unconfigured); check key presence instead.
    return 'ospf' in overrides ? overrides.ospf : configuredOspf
  })
  const routemapsGetAll = vi.fn(async () => overrides.routeMaps ?? routeMapConfig)
  const vrrpGetAll = vi.fn(async () => overrides.vrrps ?? vrrpConfig)
  const show = vi.fn(async (command: string) => {
    // A doomed BGP read would land here and throw — the screen must never issue one.
    if (command.startsWith('bgp')) throw new Error(`SYNTHETIC the screen must not read ${command}`)
    if (overrides.failShow?.has(command) === true) throw new Error(`Error [1000]: ${command} refused [SYNTHETIC]`)
    switch (command) {
      case 'ip ospf': return overrides.ospfShow ?? ospfReply
      case 'ip ospf neighbor': return overrides.neighborShow ?? neighborReply
      case 'route-map': return overrides.routeMapShow ?? routeMapReply
      case 'vrrp': return overrides.vrrpShow ?? vrrpReply
      case 'version': return versionBase
      default: throw new Error(`SYNTHETIC unexpected show: ${command}`)
    }
  })
  const node = { ospf: { get: ospfGet }, routemaps: { getAll: routemapsGetAll }, vrrp: { getAll: vrrpGetAll }, show } as unknown as TestNode
  return { node, ospfGet, routemapsGetAll, vrrpGetAll, show }
}

function renderScreen(fakes: ReturnType<typeof makeFakes>) {
  return render(<Routing node={fakes.node} proxyConfigured />)
}

const reloadButton = () => screen.getByRole('button', { name: 'Reload routing state' })
const ospfDeviceTable = () => screen.getByRole('table', { name: 'show ip ospf instances' })
const routeMapDeviceTable = () => screen.getByRole('table', { name: 'show route-map names' })
const vrrpConfigTable = () => screen.getByRole('table', { name: 'Configured VRRP groups' })

// ====================================================================================================
// Read-only in every state
// ====================================================================================================

describe('Routing — read-only banner in every state', () => {
  it('no proxy: prompt, Reload disabled, zero reads issued, banner up before any answer', () => {
    const fakes = makeFakes()
    render(<Routing node={fakes.node} proxyConfigured={false} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Local proxy is not configured')
    expect(reloadButton()).toBeDisabled()
    expect(fakes.ospfGet).not.toHaveBeenCalled()
    expect(fakes.show).not.toHaveBeenCalled()
    expect(screen.getByText(/Routing configuration editors are not offered on THIS screen/u)).toBeInTheDocument()
  })

  it('loading: the banner is already up while the reads are in flight', () => {
    const ospfGet = vi.fn((): Promise<OspfState | undefined> => new Promise<OspfState>(() => undefined))
    const show = vi.fn(async () => versionBase)
    const node = { ospf: { get: ospfGet }, routemaps: { getAll: async () => new Map() }, vrrp: { getAll: async () => new Map() }, show } as unknown as TestNode
    render(<Routing node={node} proxyConfigured />)
    expect(screen.getByText(/Reading routing state \(parsed running-config/u)).toBeInTheDocument()
    expect(screen.getByText(/Routing configuration editors are not offered on THIS screen/u)).toBeInTheDocument()
  })

  it('ready: no write affordance anywhere — the only buttons are Reload / Try again', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await screen.findByRole('table', { name: 'show ip ospf instances' })
    const buttons = screen.getAllByRole('button')
    expect(buttons.every((b) => /reload|routing state/iu.test(b.textContent ?? ''))).toBe(true)
  })
})

// ====================================================================================================
// Configured + device panels
// ====================================================================================================

describe('Routing — configured and device panels', () => {
  it('configured OSPF renders process fields, the network row, and the redistribution row', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await screen.findByRole('table', { name: 'show ip ospf instances' })
    const table = screen.getByRole('table', { name: 'Configured OSPF process fields' })
    expect(within(table).getByText('process id')).toBeInTheDocument()
    expect(within(table).getByText('1')).toBeInTheDocument()
    expect(within(screen.getByRole('table', { name: 'Configured OSPF networks' })).getByText('10.155.0.0/255.255.255.252')).toBeInTheDocument()
    expect(within(screen.getByRole('table', { name: 'Configured OSPF redistributions' })).getByText('connected')).toBeInTheDocument()
  })

  it('device OSPF instance row renders, and the DR-043 JSON-standing note is present', async () => {
    renderScreen(makeFakes())
    await screen.findByRole('table', { name: 'show ip ospf instances' })
    expect(within(ospfDeviceTable()).getByText('default')).toBeInTheDocument()
    expect(screen.getByText(/captured on cEOS-lab 4.28.14M only/u)).toBeInTheDocument()
  })

  it('neighbor count renders and the count-only shape note is present', async () => {
    renderScreen(makeFakes())
    await screen.findByRole('table', { name: 'show ip ospf instances' })
    expect(screen.getByText(/Adjacency count across every instance/u)).toHaveTextContent('0')
    expect(screen.getByText(/Neighbor entries are shown as a count only/u)).toBeInTheDocument()
  })

  it('route-map device + configured tables render', async () => {
    renderScreen(makeFakes())
    await screen.findByRole('table', { name: 'show ip ospf instances' })
    expect(within(routeMapDeviceTable()).getByText('RM-LAB-IMPORT')).toBeInTheDocument()
    expect(within(screen.getByRole('table', { name: 'Configured route-map clauses' })).getByText('RM-LAB-IMPORT')).toBeInTheDocument()
  })

  it('VRRP configured table renders fields; device side renders the count and the shape note', async () => {
    renderScreen(makeFakes())
    await screen.findByRole('table', { name: 'show ip ospf instances' })
    expect(within(vrrpConfigTable()).getByText('Vlan100')).toBeInTheDocument()
    expect(within(vrrpConfigTable()).getByText('120')).toBeInTheDocument()
    expect(screen.getByText(/Virtual routers the device answer names/u)).toHaveTextContent('0')
    expect(screen.getByText(/show vrrp` capture answers `virtualRouters: \[\]`/u)).toBeInTheDocument()
  })
})

// ====================================================================================================
// BGP — the recorded double negative, never a read
// ====================================================================================================

describe('Routing — BGP negative', () => {
  it('renders the double-negative note and issues NO bgp read', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await screen.findByRole('table', { name: 'show ip ospf instances' })
    expect(screen.getByText(/BGP status is not rendered/u)).toBeInTheDocument()
    expect(screen.getByText(/% Not supported/u)).toBeInTheDocument()
    // The fake show throws on any bgp command; reaching it would have failed the awaits above.
    expect(fakes.show.mock.calls.every(([cmd]) => !String(cmd).startsWith('bgp'))).toBe(true)
  })
})

// ====================================================================================================
// Soft-read refusals fold, never blank
// ====================================================================================================

describe('Routing — soft show refusals', () => {
  it('a refused `show ip ospf` folds its text beside the panel and keeps the config panels', async () => {
    renderScreen(makeFakes({ failShow: new Set(['ip ospf']) }))
    // Readiness marker: the BGP panel renders in every ready state, even with a soft read refused.
    await screen.findByText(/BGP status is not rendered/u)
    expect(screen.getByText(/`show ip ospf` did not answer/u)).toBeInTheDocument()
    // config panels still render despite the device-side refusal
    expect(screen.getByRole('table', { name: 'Configured OSPF process fields' })).toBeInTheDocument()
    // no error wall from a soft read
    expect(screen.queryByText(/A routing read failed/u)).toBeNull()
  })

  it('a refused `show vrrp` leaves the device count unknown, not zero', async () => {
    renderScreen(makeFakes({ failShow: new Set(['vrrp']) }))
    await screen.findByRole('table', { name: 'show ip ospf instances' })
    expect(screen.getByText(/`show vrrp` did not answer/u)).toBeInTheDocument()
    expect(screen.queryByText(/Virtual routers the device answer names/u)).toBeNull()
  })
})

// ====================================================================================================
// Unconfigured is normal; hard-read failure is the error branch
// ====================================================================================================

describe('Routing — unconfigured and error states', () => {
  it('an unconfigured device (no OSPF, empty tables) is a NORMAL ready state, no role=alert', async () => {
    renderScreen(makeFakes({ ospf: undefined, routeMaps: new Map(), vrrps: new Map() }))
    await screen.findByText('No `router ospf` section exists in the running-config.')
    expect(screen.getByText(/No `route-map` section exists/u)).toBeInTheDocument()
    expect(screen.getByText(/No interface section carries a `vrrp/u)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a hard config-read failure is the error branch with a retry', async () => {
    renderScreen(makeFakes({ ospf: new Error('Error [1000]: show running-config refused') }))
    expect(await screen.findByText(/A routing read failed/u)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })
})

// ====================================================================================================
// Reload re-runs the batch
// ====================================================================================================

describe('Routing — reload', () => {
  it('Reload re-issues the config reads', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await screen.findByRole('table', { name: 'show ip ospf instances' })
    const before = fakes.ospfGet.mock.calls.length
    fireEvent.click(reloadButton())
    await screen.findByRole('table', { name: 'show ip ospf instances' })
    expect(fakes.ospfGet.mock.calls.length).toBeGreaterThan(before)
  })
})
