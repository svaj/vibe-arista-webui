/**
 * #87 (OSPF slice): the OSPF process editor (`#/routing/ospf`), offline through hand-rolled fake
 * client seams (the `RouteMapManager.test.tsx` harness shape — no test here contacts a device).
 * The ospf client is SEND-ONLY, so unlike the VRRP screen there are no setter spies: every staged
 * line is asserted byte-for-byte against the sequence the client's own verbs compose, which
 * `ospf.test.ts`'s `sentScripts` pins client-side (the DR-153 mirroring convention).
 *
 * The acceptance lines SPEC-ospf-editor.md names, pinned below:
 * - create stages ONE line; every submode batch is header-ONCE + the client's line (router-id,
 *   networks, redistributions, shutdown); delete stages the `no router ospf <pid>` literal with the
 *   whole-process hard confirm;
 * - create over an existing process, already-said router-id/shutdown, duplicate network/
 *   redistribution lines, and clearing what does not exist are all refused at ZERO appends;
 * - four states: the HARD `ospf.get()` failure fails the screen; NO PROCESS (`undefined`) is a
 *   normal ready state (create enabled, every other form disabled); the SOFT show failures mute
 *   only their panels; the SOFT routemaps read only annotates (never refuses, never blocks);
 * - a redistribution naming an unlisted route-map stages with the dangling-reference risk line,
 *   and says "unverified" when the route-map read failed;
 * - the screen itself renders NO commit/abort control (#141: Transaction Center owns them);
 * - no-proxy idles on the prompt and contacts nothing.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Node, OspfState, RoutemapEntry } from '@devhax-heavy-industries/arista-eapi'

import { TransactionProvider, useTransactionSnapshot } from '../sessions/TransactionContext'
import type { TransactionSnapshot } from '../sessions/transaction'
import { OspfManager } from './OspfManager'
import type { ShowIpOspfNeighborReply, ShowIpOspfReply } from '../../eapi/show-contracts'

type TestNode = NonNullable<Parameters<typeof OspfManager>[0]['node']>

/** The configured process the default fixture carries — the client test's own shape. */
const configuredState = (): OspfState => ({
  ospfProcessId: 65000,
  vrf: 'default',
  routerId: '10.156.0.1',
  networks: [{ network: '172.16.10.0', netmask: '24', area: '0.0.0.0' }],
  redistributions: [{ protocol: 'bgp', routeMap: 'RM-IN' }],
  shutdown: false,
})

/** cEOS-lab `show ip ospf` (result half): one instance in the default VRF. */
const ospfShowReply: ShowIpOspfReply = {
  vrfs: { default: { instList: { '1': { instanceId: 1, vrf: 'default', routerId: '10.156.0.1', shutDown: false, numAreas: 1, numBackboneNeighbors: 0 } } } },
}

/** cEOS-lab `show ip ospf neighbor` (result half): empty neighbor list — the captured shape. */
const neighborReply: ShowIpOspfNeighborReply = {
  vrfs: { default: { instList: { '1': { ospfNeighborEntries: [] } } } },
}

const routeMapsAnswer = (): Map<string, RoutemapEntry> => new Map<string, RoutemapEntry>([
  ['RM-IN', new Map([['permit', new Map([[10, { match: [], set: [] }]])]])],
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
  /** Error = the HARD read fails; undefined = no `router ospf` section (a NORMAL state). */
  readonly state?: OspfState | Error
  /** Error = the SOFT `show ip ospf` read fails (its panel mutes only). */
  readonly ospfShowFails?: boolean
  /** Error = the SOFT `show ip ospf neighbor` read fails (the count mutes only). */
  readonly neighborFails?: boolean
  /** Error = the SOFT `routemaps.getAll()` annotation read fails (the annotation says unverified). */
  readonly routeMapsFails?: boolean
}

function makeFakes(overrides: Overrides = {}) {
  const ospfGet = vi.fn(async () => {
    if (overrides.state instanceof Error) throw overrides.state
    return 'state' in overrides ? overrides.state : configuredState()
  })
  const routemapsGetAll = vi.fn(async () => {
    if (overrides.routeMapsFails === true) throw new Error('SYNTHETIC routemaps read exploded')
    return routeMapsAnswer()
  })
  const show = vi.fn(async (command: string) => {
    if (command === 'version') return versionBase
    if (command === 'ip ospf') {
      if (overrides.ospfShowFails === true) throw new Error('SYNTHETIC show ip ospf refused')
      return ospfShowReply
    }
    if (command === 'ip ospf neighbor') {
      if (overrides.neighborFails === true) throw new Error('SYNTHETIC show ip ospf neighbor refused')
      return neighborReply
    }
    throw new Error(`SYNTHETIC unexpected show: ${command}`)
  })
  // The shared coordinator opens ONE named session on the first append; this screen never calls
  // configSession itself (the #141 boundary the last test pins on the DOM).
  const session = {
    name: 'ui-ospf-session',
    state: 'opened',
    isOpen: true,
    run: vi.fn(async () => []),
    diff: vi.fn(async () => '+router ospf 65000\n+ router-id 10.156.0.9'),
    hasDiffBeenRead: vi.fn(() => true),
    commit: vi.fn(async () => []),
    abort: vi.fn(async () => []),
  }
  const configSession = vi.fn(async () => session)
  const node = {
    ospf: { get: ospfGet },
    routemaps: { getAll: routemapsGetAll },
    show,
    configSession,
  } as unknown as TestNode
  return { node, ospfGet, routemapsGetAll, show, configSession, session }
}

function SnapshotProbe() {
  const snapshot = useTransactionSnapshot()
  return <output data-testid="transaction-snapshot">{JSON.stringify(snapshot)}</output>
}

function renderScreen(fakes: ReturnType<typeof makeFakes>) {
  return render(
    <TransactionProvider node={fakes.node as Node}>
      <OspfManager node={fakes.node} proxyConfigured />
      <SnapshotProbe />
    </TransactionProvider>,
  )
}

function snapshot(): TransactionSnapshot {
  return JSON.parse(screen.getByTestId('transaction-snapshot').textContent ?? '{}') as TransactionSnapshot
}

/** Readiness probe: the process table only lands after the HARD read resolves WITH a process. */
async function readyProcess(): Promise<void> {
  await screen.findByRole('table', { name: 'Configured OSPF process fields' })
}

/** Readiness probe for the no-process normal state. */
async function readyEmpty(): Promise<void> {
  await waitFor(() => expect(screen.getByText(/No `router ospf` section exists in the running-config/u)).toBeInTheDocument())
}

const createPid = () => screen.getByLabelText('Process id (digits, 1-65535)')
const createVrf = () => screen.getByLabelText('VRF name (blank = default VRF)')
const routerIdMode = () => screen.getByLabelText('Operation', { selector: '#ospf-routerid-mode' })
const routerIdValue = () => screen.getByLabelText(/Router-id \(one token/u)
const networkMode = () => screen.getByLabelText('Operation', { selector: '#ospf-network-mode' })
const networkAddress = () => screen.getByLabelText('Network address')
const networkMask = () => screen.getByLabelText('Mask length (digits after /)')
const networkArea = () => screen.getByLabelText('Area (dotted quad or bare digits)')
const networkTarget = () => screen.getByLabelText('Statement to remove')
const redistMode = () => screen.getByLabelText('Operation', { selector: '#ospf-redist-mode' })
const redistProtocol = () => screen.getByLabelText('Protocol')
const redistRouteMap = () => screen.getByLabelText('Route-map name (blank = none)')
const redistTarget = () => screen.getByLabelText('Line to remove')
const shutdownMode = () => screen.getByLabelText('Target state')

describe('OspfManager — reads and states', () => {
  it('ready: the process fields, networks, and redistributions render verbatim', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyProcess()

    const fields = screen.getByRole('table', { name: 'Configured OSPF process fields' })
    expect(fields).toHaveTextContent('65000')
    expect(fields).toHaveTextContent('10.156.0.1')
    expect(fields).toHaveTextContent('no shutdown')
    expect(screen.getByRole('table', { name: 'Configured OSPF networks' })).toHaveTextContent('172.16.10.0')
    expect(screen.getByRole('table', { name: 'Configured OSPF redistributions' })).toHaveTextContent('RM-IN')
    expect(screen.getByRole('table', { name: 'show ip ospf instances' })).toBeInTheDocument()
    expect(fakes.ospfGet).toHaveBeenCalledTimes(1)
  })

  it('NO PROCESS (ospf.get() answering undefined) is a NORMAL ready state — create enabled, everything else disabled', async () => {
    renderScreen(makeFakes({ state: undefined }))
    await readyEmpty()
    expect(screen.queryByRole('table', { name: 'Configured OSPF process fields' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stage process create' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Stage process delete' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Stage router-id change' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Stage network change' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Stage redistribution change' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Stage shutdown change' })).toBeDisabled()
  })

  it('the HARD ospf.get() failure fails the screen with its message, never a blank table', async () => {
    renderScreen(makeFakes({ state: new Error('SYNTHETIC ospf read exploded') }))
    expect(await screen.findByRole('alert')).toHaveTextContent('SYNTHETIC ospf read exploded')
    expect(screen.queryByRole('table', { name: 'Configured OSPF process fields' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stage process create' })).toBeDisabled()
  })

  it('the SOFT show failures mute only their panels — the process table and forms stay usable', async () => {
    renderScreen(makeFakes({ ospfShowFails: true, neighborFails: true }))
    await readyProcess()
    expect(await screen.findByText(/SYNTHETIC show ip ospf refused/u)).toBeInTheDocument()
    expect(screen.getByText(/SYNTHETIC show ip ospf neighbor refused/u)).toBeInTheDocument()
    expect(screen.getByRole('table', { name: 'Configured OSPF process fields' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stage router-id change' })).toBeEnabled()
  })

  it('the SOFT routemaps failure only says the annotation is unavailable — nothing blocks', async () => {
    renderScreen(makeFakes({ routeMapsFails: true }))
    await readyProcess()
    expect(await screen.findByText(/routemaps\.getAll\(\)` read did not answer/u)).toBeInTheDocument()
    fireEvent.change(redistMode(), { target: { value: 'add' } })
    expect(screen.getByRole('button', { name: 'Stage redistribution change' })).toBeEnabled()
  })

  it('no-proxy: the prompt, and nothing contacted', () => {
    const fakes = makeFakes()
    render(
      <TransactionProvider node={undefined}>
        <OspfManager node={undefined} proxyConfigured={false} />
      </TransactionProvider>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('EAPI_HOST')
    expect(fakes.ospfGet).not.toHaveBeenCalled()
    expect(fakes.routemapsGetAll).not.toHaveBeenCalled()
    expect(fakes.show).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Stage process create' })).toBeDisabled()
  })
})

describe('OspfManager — process create/delete staging (the client verb text, byte-for-byte)', () => {
  it('create stages ONE line with the posture confirm (no fabricated blast)', async () => {
    renderScreen(makeFakes({ state: undefined }))
    await readyEmpty()

    fireEvent.change(createPid(), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stage process create' }))

    await waitFor(() => expect(snapshot().entries).toHaveLength(1))
    const [entry] = snapshot().entries
    expect(entry.source).toBe('/routing/ospf')
    expect(entry.action).toBe('create router ospf 1')
    expect(entry.display).toEqual(['router ospf 1'])
    expect(entry.confirmations).toHaveLength(1)
    expect(entry.confirmations[0].title).toBe('Second confirm: OSPF create router ospf 1')
    expect(entry.confirmations[0].body).toMatch(/no ip routing/u)
    expect(entry.confirmations[0].body).toMatch(/zero `router ospf` sections/u)
  })

  it('create with a vrf appends the vrf arm verbatim', async () => {
    renderScreen(makeFakes({ state: undefined }))
    await readyEmpty()

    fireEvent.change(createPid(), { target: { value: '10' } })
    fireEvent.change(createVrf(), { target: { value: 'mgmt' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stage process create' }))

    await waitFor(() => expect(snapshot().entries).toHaveLength(1))
    expect(snapshot().entries[0].display).toEqual(['router ospf 10 vrf mgmt'])
  })

  it('a second create over the read process is refused at zero appends (divergence 7)', async () => {
    renderScreen(makeFakes())
    await readyProcess()

    fireEvent.change(createPid(), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stage process create' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('ONE process')
    expect(snapshot().entries).toHaveLength(0)
  })

  it('an out-of-bound pid is refused in-form at zero appends (client-guard copy)', async () => {
    renderScreen(makeFakes({ state: undefined }))
    await readyEmpty()

    fireEvent.change(createPid(), { target: { value: '66000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stage process create' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('outside 1-65535')
    expect(snapshot().entries).toHaveLength(0)
  })

  it('delete stages `no router ospf <pid>` with the whole-process hard confirm', async () => {
    renderScreen(makeFakes())
    await readyProcess()

    fireEvent.click(screen.getByRole('button', { name: 'Stage process delete' }))

    await waitFor(() => expect(snapshot().entries).toHaveLength(1))
    const [entry] = snapshot().entries
    expect(entry.action).toBe('delete router ospf 65000')
    expect(entry.display).toEqual(['no router ospf 65000'])
    expect(entry.confirmations).toHaveLength(1)
    expect(entry.confirmations[0].subject).toBe('no router ospf 65000')
    expect(entry.confirmations[0].body).toMatch(/WHOLE process/u)
    expect(entry.confirmations[0].body).toMatch(/32636 ms/u)
  })
})

describe('OspfManager — submode staging (header ONCE + the client line)', () => {
  it('a router-id set stages the two-line batch with the unmeasured-mechanism confirm', async () => {
    renderScreen(makeFakes())
    await readyProcess()

    fireEvent.change(routerIdMode(), { target: { value: 'set' } })
    fireEvent.change(routerIdValue(), { target: { value: '10.156.0.9' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stage router-id change' }))

    await waitFor(() => expect(snapshot().entries).toHaveLength(1))
    const [entry] = snapshot().entries
    expect(entry.action).toBe('set router-id 10.156.0.9 on router ospf 65000')
    expect(entry.display).toEqual(['router ospf 65000', 'router-id 10.156.0.9'])
    expect(entry.confirmations[0].body).toMatch(/NOT measured for this verb/u)
  })

  it('staging the router-id the process ALREADY says is refused at zero appends', async () => {
    renderScreen(makeFakes())
    await readyProcess()

    fireEvent.change(routerIdMode(), { target: { value: 'set' } })
    fireEvent.change(routerIdValue(), { target: { value: '10.156.0.1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stage router-id change' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('already says')
    expect(snapshot().entries).toHaveLength(0)
  })

  it('clearing a router-id the process never carried is refused at zero appends', async () => {
    renderScreen(makeFakes({ state: { ...configuredState(), routerId: undefined } }))
    await readyProcess()

    fireEvent.change(routerIdMode(), { target: { value: 'clear' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stage router-id change' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('carries no `router-id` line to clear')
    expect(snapshot().entries).toHaveLength(0)
  })

  it('a network add stages header + the statement, defaulting the area to the round-tripping 0.0.0.0', async () => {
    renderScreen(makeFakes())
    await readyProcess()

    fireEvent.change(networkMode(), { target: { value: 'add' } })
    fireEvent.change(networkAddress(), { target: { value: '10.155.0.0' } })
    fireEvent.change(networkMask(), { target: { value: '30' } })
    // The area field arrives prefilled with the spec's default.
    expect(networkArea()).toHaveValue('0.0.0.0')
    fireEvent.click(screen.getByRole('button', { name: 'Stage network change' }))

    await waitFor(() => expect(snapshot().entries).toHaveLength(1))
    const [entry] = snapshot().entries
    expect(entry.display).toEqual(['router ospf 65000', 'network 10.155.0.0/30 area 0.0.0.0'])
    expect(entry.confirmations[0].body).toMatch(/ADVERTISES the prefix/u)
    expect(entry.confirmations[0].body).toMatch(/67 ms/u)
  })

  it('a duplicate network statement is refused at zero appends', async () => {
    renderScreen(makeFakes())
    await readyProcess()

    fireEvent.change(networkMode(), { target: { value: 'add' } })
    fireEvent.change(networkAddress(), { target: { value: '172.16.10.0' } })
    fireEvent.change(networkMask(), { target: { value: '24' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stage network change' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('already in the read')
    expect(snapshot().entries).toHaveLength(0)
  })

  it('a network remove stages the exact `no network` triple from the picker', async () => {
    renderScreen(makeFakes())
    await readyProcess()

    fireEvent.change(networkMode(), { target: { value: 'remove' } })
    fireEvent.change(networkTarget(), { target: { value: '172.16.10.0/24@0.0.0.0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stage network change' }))

    await waitFor(() => expect(snapshot().entries).toHaveLength(1))
    const [entry] = snapshot().entries
    expect(entry.display).toEqual(['router ospf 65000', 'no network 172.16.10.0/24 area 0.0.0.0'])
    // The exact measured mechanism, quoted.
    expect(entry.confirmations[0].body).toMatch(/no network <net>\/<mask> area <area>` removal withdrew a route in 67 ms/u)
  })

  it('a redistribution add stages header + the qualified line', async () => {
    renderScreen(makeFakes())
    await readyProcess()

    fireEvent.change(redistMode(), { target: { value: 'add' } })
    fireEvent.change(redistProtocol(), { target: { value: 'connected' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stage redistribution change' }))

    await waitFor(() => expect(snapshot().entries).toHaveLength(1))
    expect(snapshot().entries[0].display).toEqual(['router ospf 65000', 'redistribute connected'])
  })

  it('a redistribution naming an UNLISTED route-map stages with the dangling-reference risk line', async () => {
    renderScreen(makeFakes())
    await readyProcess()

    fireEvent.change(redistMode(), { target: { value: 'add' } })
    fireEvent.change(redistProtocol(), { target: { value: 'static' } })
    fireEvent.change(redistRouteMap(), { target: { value: 'RM-GONE' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stage redistribution change' }))

    await waitFor(() => expect(snapshot().entries).toHaveLength(1))
    const [entry] = snapshot().entries
    expect(entry.display).toEqual(['router ospf 65000', 'redistribute static route-map RM-GONE'])
    // The read-back risk also quotes the staged line (which names RM-GONE),
    // so find the annotation by its own words, not by the name.
    const dangling = entry.risks.find((risk) => /does not name route-map/u.test(String(risk)))
    expect(dangling).toBeDefined()
    expect(String(dangling)).toMatch(/does not name route-map/u)
    expect(String(dangling)).toMatch(/dangling route-map reference at stage time/u)
    expect(entry.confirmations[0].body).toMatch(/RM-GONE/u)
  })

  it('with the route-map read failed, the annotation says unverified — and the line still stages', async () => {
    renderScreen(makeFakes({ routeMapsFails: true }))
    await readyProcess()

    fireEvent.change(redistMode(), { target: { value: 'add' } })
    fireEvent.change(redistProtocol(), { target: { value: 'static' } })
    fireEvent.change(redistRouteMap(), { target: { value: 'RM-ANY' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stage redistribution change' }))

    await waitFor(() => expect(snapshot().entries).toHaveLength(1))
    expect(snapshot().entries[0].display).toEqual(['router ospf 65000', 'redistribute static route-map RM-ANY'])
    expect(snapshot().entries[0].risks.some((risk) => /Treat the name as unverified/u.test(String(risk)))).toBe(true)
  })

  it('a redistribution remove stages the BARE negation with the divergence-10 confirm', async () => {
    renderScreen(makeFakes())
    await readyProcess()

    fireEvent.change(redistMode(), { target: { value: 'remove' } })
    fireEvent.change(redistTarget(), { target: { value: 'bgp/RM-IN' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stage redistribution change' }))

    await waitFor(() => expect(snapshot().entries).toHaveLength(1))
    const [entry] = snapshot().entries
    expect(entry.display).toEqual(['router ospf 65000', 'no redistribute bgp'])
    expect(entry.confirmations[0].body).toMatch(/divergence 10/u)
  })

  it('shutdown stages header + `shutdown` with the adjacency-scoped confirm', async () => {
    renderScreen(makeFakes())
    await readyProcess()

    fireEvent.change(shutdownMode(), { target: { value: 'shutdown' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stage shutdown change' }))

    await waitFor(() => expect(snapshot().entries).toHaveLength(1))
    const [entry] = snapshot().entries
    expect(entry.display).toEqual(['router ospf 65000', 'shutdown'])
    expect(entry.confirmations[0].body).toMatch(/tears down every adjacency/u)
    expect(entry.confirmations[0].body).toMatch(/NOT by the command being staged here/u)
  })

  it('staging shutdown on a process the read already shows shut down is refused at zero appends', async () => {
    renderScreen(makeFakes({ state: { ...configuredState(), shutdown: true } }))
    await readyProcess()

    fireEvent.change(shutdownMode(), { target: { value: 'shutdown' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stage shutdown change' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('already shut down')
    expect(snapshot().entries).toHaveLength(0)
  })
})

describe('OspfManager — the #141 boundary', () => {
  it('the screen renders NO commit/abort control anywhere and never opens a session itself', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyProcess()
    expect(screen.queryByRole('button', { name: /commit/iu })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /abort/iu })).not.toBeInTheDocument()
    expect(screen.getByText(/only stage into the shared transaction/u)).toBeInTheDocument()
    expect(fakes.configSession).not.toHaveBeenCalled()
  })
})
