/**
 * S15 (#85): the spanning-tree screen, offline through hand-rolled fake client seams — the
 * `Ntp.test.tsx` shape (config-backed M resource: the seam is `stp.get()` plus soft
 * `show('version')`/`show('spanning-tree')` reads; scenario values are hand-authored config-shaped
 * data plus the verbatim cEOS `show spanning-tree` capture body). No test here contacts a device.
 * B3 (#88) step 1 closed the capture gap the original header named: `show spanning-tree` is
 * capture-backed on both targets, so the operational panel is now a rendered, tested half.
 *
 * The acceptance lines #85 names, pinned below (the operational line updated by #88 step 1):
 * - "the EXACT command texts stp.ts pins" — every session `run()` argv is byte-for-byte the
 *   `stp.test.ts` batch (parent line `interface <port>` plus the enable/disable WORDS, the `no`
 *   and `default` forms, the bare/edge(+auto)/network/normal PortFast texts);
 * - "hard-confirm guard on enabling portfast" — the confirm dialog names the port and states the
 *   far end is not visible to this UI; declining it leaves `commit()` at zero calls;
 * - the operational panel renders the live read model verbatim when `show spanning-tree` answers,
 *   and names its own failure (never a blank, never "unsupported") when the soft read fails;
 * - "NO global mode control renders" — no button (or staged batch) names a spanning-tree mode;
 * - the row-168 read/write asymmetry: the parsed `interface Et1` section is listed but refuses
 *   writes at ZERO sessions;
 * - "four states" — no-proxy, loading, failed read, ready (empty table is a normal ready state);
 * - the config diff renders in a real `<pre>` (tagName pin).
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Node, StpInterface, StpSettings as DeviceSettings } from '@devhax-heavy-industries/arista-eapi'

import { TransactionProvider, useTransactionSnapshot } from '../sessions/TransactionContext'
import type { TransactionSnapshot } from '../sessions/transaction'
import type { ShowSpanningTreeReply } from '../../eapi/show-contracts'
import { Stp, stpWriteGuard } from './Stp'

type TestNode = NonNullable<Parameters<typeof Stp>[0]['node']>

/**
 * Config-shaped payload from §5 row 170's reading rules: Ethernet1 carries the enable line and a
 * typed `network` PortFast line; Ethernet2 is the bare-enable shape; Ethernet3 proves the reader
 * keeps a device token (`auto`) outside the client's write set; Port-Channel1 proves the negated
 * arm (`portfast: false, type: 'normal'`); `Et1` is row 168's asymmetry — the read-side Et/Po
 * prefix gate lets the shorthand section in, the write grammar refuses it.
 */
const stpFixture = (over: Partial<DeviceSettings> = {}): DeviceSettings => ({
  mode: 'mstp',
  interfaces: new Map<string, StpInterface>([
    ['Ethernet1', { interfaceName: 'Ethernet1', bpduguard: true, portfast: true, portfastType: 'network' }],
    ['Ethernet2', { interfaceName: 'Ethernet2', bpduguard: false, portfast: true, portfastType: 'edge' }],
    ['Ethernet3', { interfaceName: 'Ethernet3', bpduguard: false, portfast: true, portfastType: 'auto' }],
    ['Port-Channel1', { interfaceName: 'Port-Channel1', bpduguard: false, portfast: false, portfastType: 'normal' }],
    ['Et1', { interfaceName: 'Et1', bpduguard: false, portfast: true, portfastType: 'edge' }],
  ]),
  instances: new Map<string, never>(),
  ...over,
})

const emptyFixture = (): DeviceSettings => stpFixture({ mode: undefined, interfaces: new Map<string, StpInterface>() })

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
  readonly settings?: DeviceSettings | Error
  readonly versionFails?: boolean
  /** B3 (#88) step 1: the soft `show spanning-tree` reply. Default: a configured MST0 shape. */
  readonly spanningTree?: ShowSpanningTreeReply | Error
  /** Force the soft read to fail (the operational-unavailable state). */
  readonly spanningTreeFails?: boolean
  readonly diff?: string
  readonly diffRead?: boolean
  readonly runError?: Error
}

/** The MST0 instance the fake answers for `show spanning-tree` — the verbatim cEOS-lab capture body
 * (`live/ceos-4.28.14M/show-spanning-tree.json`). */
const spanningTreeFixture = (): ShowSpanningTreeReply => ({
  spanningTreeInstances: {
    MST0: {
      protocol: 'mstp',
      bridge: { priority: 4096, macAddress: '00:00:00:00:00:00', systemIdExtension: 0, forwardDelay: 15, helloTime: 2, maxAge: 20 },
      interfaces: {
        Ethernet1: {
          priority: 128, linkType: 'p2p', state: 'forwarding', cost: 20000, role: 'designated',
          inconsistentFeatures: { loopGuard: false, rootGuard: false, mstPvstBorder: false, bridgeAssurance: false },
          portNumber: 1, isEdgePort: true, boundaryType: 'none',
        },
      },
    },
  },
})

function makeFakes(overrides: Overrides = {}) {
  const session = {
    name: 'ui-s15-session',
    state: 'diffed',
    isOpen: false,
    run: vi.fn(async () => {
      if (overrides.runError !== undefined) throw overrides.runError
      return []
    }),
    diff: vi.fn(async () => overrides.diff ?? '+interface Ethernet1\n+ spanning-tree bpduguard enable'),
    hasDiffBeenRead: vi.fn(() => overrides.diffRead ?? true),
    commit: vi.fn(async () => []),
    abort: vi.fn(async () => []),
  }
  const get = vi.fn(async () => {
    if (overrides.settings instanceof Error) throw overrides.settings
    return overrides.settings ?? stpFixture()
  })
  const show = vi.fn(async (command: string) => {
    if (command === 'spanning-tree') {
      if (overrides.spanningTreeFails === true) throw new Error('SYNTHETIC show spanning-tree exploded')
      if (overrides.spanningTree instanceof Error) throw overrides.spanningTree
      return overrides.spanningTree ?? spanningTreeFixture()
    }
    if (command !== 'version') throw new Error(`SYNTHETIC unexpected show: ${command}`)
    if (overrides.versionFails === true) throw new Error('SYNTHETIC show version exploded')
    return versionBase
  })
  const configSession = vi.fn(async () => session)
  const node = { stp: { get }, show, configSession } as unknown as TestNode
  return { node, session, get, show, configSession }
}

function SnapshotProbe() {
  const snapshot = useTransactionSnapshot()
  return <output data-testid="transaction-snapshot">{JSON.stringify(snapshot)}</output>
}

function renderScreen(fakes: ReturnType<typeof makeFakes>) {
  return render(
    <TransactionProvider node={fakes.node as Node}>
      <Stp node={fakes.node} proxyConfigured />
      <SnapshotProbe />
    </TransactionProvider>,
  )
}

function snapshot(): TransactionSnapshot {
  return JSON.parse(screen.getByTestId('transaction-snapshot').textContent ?? '{}') as TransactionSnapshot
}

/** Readiness probe: the parsed port table only lands after `stp.get()` resolves. */
async function readyPorts(): Promise<void> {
  await screen.findByRole('table', { name: 'Per-port spanning-tree configuration' })
}

async function stageReady(fakes: ReturnType<typeof makeFakes>): Promise<void> {
  await waitFor(() => expect(fakes.session.run).toHaveBeenCalled())
  await screen.findByText(/STP change added to the transaction/u)
}

const portSelect = () => screen.getByLabelText('Port')
const actionSelect = () => screen.getByLabelText('Change')
const previewButton = () => screen.getByRole('button', { name: 'Preview change' })

function choose(action: string, port?: string): void {
  if (port !== undefined) fireEvent.change(portSelect(), { target: { value: port } })
  fireEvent.change(actionSelect(), { target: { value: action } })
  fireEvent.click(previewButton())
}

/** Stage one action and wait for the device diff review to be on screen. */
async function stage(fakes: ReturnType<typeof makeFakes>, action: string, port?: string): Promise<void> {
  choose(action, port)
  await stageReady(fakes)
}

// ====================================================================================================
// Write pins — the exact batches `arista-api-client/src/resources/stp.test.ts` sends
// ====================================================================================================

/** `[actionId, port, expected session batch]` with the `stp.test.ts` pins. */
const PINS: readonly [string, string, readonly string[]][] = [
  ['bpduguard-enable', 'Ethernet1', ['interface Ethernet1', 'spanning-tree bpduguard enable']],
  ['bpduguard-disable', 'Ethernet1', ['interface Ethernet1', 'spanning-tree bpduguard disable']],
  ['bpduguard-unset', 'Ethernet1', ['interface Ethernet1', 'no spanning-tree bpduguard']],
  ['bpduguard-default', 'Ethernet1', ['interface Ethernet1', 'default spanning-tree bpduguard']],
  ['portfast-enable', 'Ethernet2', ['interface Ethernet2', 'spanning-tree portfast']],
  ['portfast-unset', 'Ethernet2', ['interface Ethernet2', 'no spanning-tree portfast']],
  ['portfast-default', 'Ethernet2', ['interface Ethernet2', 'default spanning-tree portfast']],
  ['portfast-type-edge', 'Port-Channel1', ['interface Port-Channel1', 'spanning-tree portfast edge', 'spanning-tree portfast auto']],
  ['portfast-type-network', 'Ethernet1', ['interface Ethernet1', 'spanning-tree portfast network']],
  ['portfast-type-normal', 'Ethernet1', ['interface Ethernet1', 'spanning-tree portfast normal']],
]

describe('Stp — every verb stages the stp.test.ts-pinned batch in a named session', () => {
  for (const [action, port, batch] of PINS) {
    it(`${action} on ${port}: description webui stp ${action} + run ${JSON.stringify(batch)}`, async () => {
      const fakes = makeFakes()
      renderScreen(fakes)
      await readyPorts()

      await stage(fakes, action, port)

      expect(fakes.configSession).toHaveBeenCalledWith(expect.objectContaining({ description: 'webui shared transaction' }))
      expect(fakes.session.run).toHaveBeenCalledWith(batch)
      expect(fakes.configSession).toHaveBeenCalledTimes(1)
    })
  }

  it('the edge arm shows BOTH pinned lines in the staged review (upstream pair, not an invention)', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyPorts()

    await stage(fakes, 'portfast-type-edge', 'Port-Channel1')

    expect(snapshot().entries[0]?.display).toEqual([
      'interface Port-Channel1',
      'spanning-tree portfast edge',
      'spanning-tree portfast auto',
    ])
  })

  it('staging a risky verb leaves commit and re-read to Transaction Center', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyPorts()

    await stage(fakes, 'bpduguard-unset', 'Ethernet1')

    expect(fakes.session.commit).not.toHaveBeenCalled()
    expect(fakes.get).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: /Commit/u })).not.toBeInTheDocument()
  })

  it('ordinary verbs also stage without a feature-local commit', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyPorts()

    await stage(fakes, 'bpduguard-enable', 'Ethernet2')
    expect(fakes.session.commit).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /Commit/u })).not.toBeInTheDocument()
  })
})

// ====================================================================================================
// Four states — nothing contacted unless the operator asks
// ====================================================================================================

describe('Stp — four states', () => {
  it('no proxy: prompt, every control disabled, and stp.get()/show()/configSession() stay at zero calls', () => {
    const fakes = makeFakes()
    render(<Stp node={fakes.node} proxyConfigured={false} />)

    expect(screen.getByRole('alert')).toHaveTextContent('Local proxy is not configured')
    expect(previewButton()).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Reload spanning-tree state' })).toBeDisabled()
    expect(fakes.get).not.toHaveBeenCalled()
    expect(fakes.show).not.toHaveBeenCalled()
    expect(fakes.configSession).not.toHaveBeenCalled()
  })

  it('loading: the read is in flight, showing config-read copy — not a blank summary', () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    expect(screen.getByText(/Reading the spanning-tree configuration/u)).toBeInTheDocument()
    expect(fakes.get).toHaveBeenCalledTimes(1)
  })

  it('ready: parsed-config rows with the row-170 pill semantics, the verbatim mode token, the identity chip', async () => {
    const fakes = makeFakes()
    const { container } = renderScreen(fakes)
    await readyPorts()

    // Ethernet1: enable line present + typed `network` token. Scoped to the CONFIG table —
    // the live operational panel also carries an Ethernet1 row once `show spanning-tree` answers.
    const configTable = screen.getByRole('table', { name: 'Per-port spanning-tree configuration' })
    const eth1 = within(configTable).getByRole('row', { name: /Ethernet1/u })
    expect(within(eth1).getAllByText('enabled')).toHaveLength(2)
    expect(within(eth1).getByText('network')).toBeInTheDocument()
    // Port-Channel1: the exact negation reads portfast disabled, fallback type 'normal'.
    const pc1 = within(configTable).getByRole('row', { name: /Port-Channel1/u })
    expect(within(pc1).getAllByText('disabled')).toHaveLength(2)
    expect(within(pc1).getByText('normal')).toBeInTheDocument()
    // Configured mode: the device token verbatim, in a <code>, never translated. Scoped to the
    // summary region — the operational panel renders its own protocol token separately.
    const summary = screen.getByRole('region', { name: 'STP summary' })
    expect(within(summary).getByText('mstp')).toBeInTheDocument()
    expect(container.querySelector('.device-identity')).not.toBeNull()
    // The pill-semantics note is on screen so "disabled" is not read as "configured disabled".
    expect(screen.getByText(/covers the disable word, the negated line, and no line at all/u)).toBeInTheDocument()
  })

  it('an empty port table is a normal configured state, not an error (EmptyState, no alert)', async () => {
    const fakes = makeFakes({ settings: emptyFixture() })
    renderScreen(fakes)

    expect(await screen.findByText(/No Ethernet or Port-Channel section in the running-config/u)).toBeInTheDocument()
    expect(screen.getByText(/none — the running-config carries no `spanning-tree mode` line/u)).toBeInTheDocument()
    expect(screen.queryByRole('alert', { name: /spanning-tree read failed/u })).toBeNull()
    // With no port to pick, Preview explains itself in-form and pays zero sessions.
    fireEvent.click(previewButton())
    expect(await screen.findByRole('alert')).toHaveTextContent(/no spanning-tree port to edit/u)
    expect(fakes.configSession).not.toHaveBeenCalled()
  })

  it('a failed spanning-tree read is an error, never a blank panel: alert copy, controls locked', async () => {
    const fakes = makeFakes({ settings: new Error('SYNTHETIC stp read exploded') })
    renderScreen(fakes)

    expect(await screen.findByRole('alert')).toHaveTextContent('SYNTHETIC stp read exploded')
    expect(previewButton()).toBeDisabled()
    expect(fakes.get).toHaveBeenCalledTimes(1)
    expect(fakes.configSession).not.toHaveBeenCalled()
  })
})

// ====================================================================================================
// The #85 honesty boundaries: operational state, no mode control, read/write name asymmetry
// ====================================================================================================

describe('Stp — summary honesty and the closed halves', () => {
  it('the operational panel renders the live read model verbatim once `show spanning-tree` answers (B3 #88 step 1)', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyPorts()

    // The operational panel exists and carries the device's own tokens — instance key, protocol,
    // and the port row's state/role — rendered verbatim, never translated into UI vocabulary.
    expect(await screen.findByText('MST0')).toBeInTheDocument()
    // 'mstp' appears twice once both panels answer: the configured-mode token (summary) and the
    // live protocol token (operational). Both are the device's own spelling, rendered verbatim.
    expect(screen.getAllByText('mstp').length).toBeGreaterThanOrEqual(2)
    const liveTable = screen.getByRole('table', { name: /Live spanning-tree ports for instance MST0/u })
    const liveRow = within(liveTable).getByRole('row', { name: /Ethernet1/u })
    expect(within(liveRow).getByText('forwarding')).toBeInTheDocument()
    expect(within(liveRow).getByText('designated')).toBeInTheDocument()
    // The retired #85 sentence is gone, and the read is actually issued.
    expect(screen.queryByText(/not yet observable — capture pending/u)).not.toBeInTheDocument()
    expect(fakes.show).toHaveBeenCalledWith('version')
    expect(fakes.show).toHaveBeenCalledWith('spanning-tree')
  })

  it('a FAILED soft `show spanning-tree` mutes the operational panel with the named note and never blanks the screen', async () => {
    const fakes = makeFakes({ spanningTreeFails: true })
    renderScreen(fakes)
    await readyPorts()

    // The config table is still ready (the hard read answered) while the operational panel names
    // its own failure — a read failure, never a "not supported" claim.
    expect(screen.getByText(/did not answer on this device/u)).toBeInTheDocument()
    expect(screen.getByText(/not a claim that the command is unsupported/u)).toBeInTheDocument()
    expect(screen.queryByText('MST0')).not.toBeInTheDocument()
    // The config table still rendered:
    expect(screen.getByRole('row', { name: /Ethernet3/u })).toBeInTheDocument()
  })

  it('NO global-mode control renders anywhere, and the static B3 (#88) note is on screen', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyPorts()

    // No button, and no option in the Change selector, can stage a spanning-tree mode line.
    expect(screen.queryAllByRole('button', { name: /mode/iu })).toHaveLength(0)
    for (const option of within(actionSelect()).getAllByRole('option')) {
      expect(option.textContent).not.toMatch(/mode/u)
    }
    expect(screen.getByText(/Global spanning-tree mode editing is not offered/u)).toHaveTextContent('B3 (#88)')
    // The MST stub sentence never reads as "the switch has no instances".
    expect(screen.getByText(/`return dict\(\)` stub since 2015/u)).toHaveTextContent('not a claim')
  })

  it("a device token outside the client's write set (`auto`) is shown verbatim and flagged", async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyPorts()

    const eth3 = screen.getByRole('row', { name: /Ethernet3/u })
    expect(within(eth3).getByText('auto')).toBeInTheDocument()
    expect(within(eth3).getByText(/outside this client/u)).toBeInTheDocument()
  })

  it('the parsed `Et1` section is listed (read gate) but refuses every write at ZERO sessions (row 168)', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyPorts()

    expect(screen.getByText('Et1')).toBeInTheDocument()
    expect(within(portSelect()).getByRole('option', { name: 'Et1 (read-only here)' })).toBeInTheDocument()

    choose('bpduguard-enable', 'Et1')
    expect(await screen.findByRole('alert')).toHaveTextContent(/stages nothing for it/u)
    expect(screen.getByRole('alert')).toHaveTextContent('read-only here')
    expect(fakes.configSession).not.toHaveBeenCalled()
    expect(fakes.session.run).not.toHaveBeenCalled()
  })

  it('Preview with no change chosen refuses in-form (one verb per session) at zero sessions', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyPorts()

    fireEvent.click(previewButton())
    expect(await screen.findByRole('alert')).toHaveTextContent(/Choose a spanning-tree change/u)
    expect(fakes.configSession).not.toHaveBeenCalled()
  })
})

// ====================================================================================================
// The PortFast hard-confirm — #85's loop guard
// ====================================================================================================

describe('Stp — PortFast risk metadata names the port and admits the far end is invisible', () => {
  it('enabling PortFast carries the port and loop-risk sentence into the transaction', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyPorts()

    await stage(fakes, 'portfast-enable', 'Ethernet2')

    const risks = snapshot().entries[0]?.risks.join('\n') ?? ''
    expect(risks).toMatch(/PortFast is being set on Ethernet2/u)
    expect(risks).toMatch(/CANNOT see what is connected on the far end of Ethernet2/u)
    expect(risks).toMatch(/loop the bridged network/u)
    expect(fakes.session.commit).not.toHaveBeenCalled()
  })

  it('network PortFast stays in one staged session without a local confirm', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyPorts()

    await stage(fakes, 'portfast-type-network', 'Ethernet1')

    expect(fakes.session.commit).not.toHaveBeenCalled()
    expect(fakes.session.abort).not.toHaveBeenCalled()
    expect(fakes.session.run).toHaveBeenCalledTimes(1)
    expect(fakes.configSession).toHaveBeenCalledTimes(1)
  })

  it('the default PortFast arm carries the unpredictable-device-default warning', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyPorts()

    await stage(fakes, 'portfast-default', 'Ethernet1')
    expect(snapshot().entries[0]?.risks.join('\n')).toMatch(/cannot predict|CANNOT predict/u)
    expect(fakes.session.commit).not.toHaveBeenCalled()
  })
})

// ====================================================================================================
// Staging discipline and device-error surfacing (the standing wave pattern)
// ====================================================================================================

describe('Stp — staging discipline and device-error surfacing', () => {
  it('a second action reuses the shared transaction', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyPorts()

    await stage(fakes, 'bpduguard-enable', 'Ethernet1')
    choose('bpduguard-unset', 'Ethernet2')
    await waitFor(() => expect(fakes.session.run).toHaveBeenCalledTimes(2))

    expect(fakes.configSession).toHaveBeenCalledTimes(1)
    expect(snapshot().entries).toHaveLength(2)
  })

  it('the coordinator exposes the diff-read gate without a feature-local commit', async () => {
    const fakes = makeFakes({ diffRead: false })
    renderScreen(fakes)
    await readyPorts()

    await stage(fakes, 'bpduguard-enable', 'Ethernet1')
    expect(snapshot().canCommit).toBe(false)
    expect(screen.queryByRole('button', { name: /Commit/u })).not.toBeInTheDocument()
    expect(fakes.session.commit).not.toHaveBeenCalled()
  })

  it('feature staging never commits or aborts the shared session', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyPorts()

    await stage(fakes, 'portfast-unset', 'Ethernet2')
    expect(fakes.session.commit).not.toHaveBeenCalled()
    expect(fakes.session.abort).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /Commit|Abort/u })).not.toBeInTheDocument()
  })

  it('Reload device state re-runs the read', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyPorts()

    fireEvent.click(screen.getByRole('button', { name: 'Reload spanning-tree state' }))
    await waitFor(() => expect(fakes.get).toHaveBeenCalledTimes(2))
    await readyPorts()
  })

  it('a command the device rejects surfaces the device text and never commits', async () => {
    const fakes = makeFakes({ runError: new Error('Command rejected: spanning-tree not valid here') })
    renderScreen(fakes)
    await readyPorts()

    choose('bpduguard-enable', 'Ethernet1')

    expect(await screen.findByRole('alert')).toHaveTextContent(/Command rejected: spanning-tree not valid here/u)
    expect(snapshot().status).toBe('uncertain')
    expect(fakes.session.commit).not.toHaveBeenCalled()
  })

  it('the coordinator stores the device diff without rendering a local review', async () => {
    const fakes = makeFakes({ diff: '+interface Ethernet1\n+  spanning-tree bpduguard enable' })
    renderScreen(fakes)
    await readyPorts()

    await stage(fakes, 'bpduguard-enable', 'Ethernet1')

    expect(snapshot().diff).toBe('+interface Ethernet1\n+  spanning-tree bpduguard enable')
    expect(screen.queryByText(/\+  spanning-tree bpduguard enable/u)).not.toBeInTheDocument()
  })

  it('a failed show-version read only drops the chip — no write here is version-conditional', async () => {
    const fakes = makeFakes({ versionFails: true })
    const { container } = renderScreen(fakes)
    await readyPorts()

    expect(container.querySelector('.device-identity')).toBeNull()
    await stage(fakes, 'bpduguard-enable', 'Ethernet1')
    expect(fakes.session.run).toHaveBeenCalledWith(['interface Ethernet1', 'spanning-tree bpduguard enable'])
    expect(screen.getByText(/STP change added to the transaction/u)).toBeInTheDocument()
  })
})

// ====================================================================================================
// The exported name guard, unit-tested for BOTH arms: in-screen inputs (Et/Po read gate) can only
// reach the first, so the row-168 kind refusal is pinned directly — same export-for-pin pattern as
// InterfacesDashboard's helpers.
// ====================================================================================================

describe('stpWriteGuard — mirrors assertStpPortName (resources/stp.ts, row 168)', () => {
  it('accepts exactly the two documented spanning-tree kinds', () => {
    expect(stpWriteGuard('Ethernet1')).toBeUndefined()
    expect(stpWriteGuard('Ethernet2')).toBeUndefined()
    expect(stpWriteGuard('Port-Channel1')).toBeUndefined()
  })

  it('grammar failures name the interface grammar and the read/write asymmetry (first arm)', () => {
    for (const name of ['Et1', 'Po1', 'Poke1', 'Ethernet1/1', 'Ethernet1.100', 'et1', '']) {
      const refusal = stpWriteGuard(name)
      expect(refusal, name).toMatch(/not an interface name this client can put behind/u)
      expect(refusal, name).toMatch(/stages nothing for it/u)
    }
  })

  it('a shaped-but-wrong-kind name gets the client\u2019s documented two-kinds refusal (second arm)', () => {
    for (const name of ['Vlan20', 'Management1', 'Loopback0']) {
      const refusal = stpWriteGuard(name)
      expect(refusal, name).toMatch(/not as an Ethernet or Port-Channel/u)
      expect(refusal, name).toMatch(/api\/stp\.py:194-195/u)
    }
  })
})
