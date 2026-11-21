/**
 * B3 (#88) step 2: the spanning-tree GLOBAL screen (`#/stp/global`), offline through hand-rolled
 * fake client seams (the `Stp.test.tsx` shape — no test here contacts a device). Scenario values
 * are the capture's own sample data (`LAB-UNBLOCK` / `1` / `instance 1 vlan 100,110` from
 * hardware batch `unblock-stp-mst-region-grammar`).
 *
 * The acceptance lines SPEC-stp-global-editor.md names, pinned below:
 * - every staged batch is byte-for-byte the capture-pinned lines (mode line alone; region parent
 *   via `submodeCommands` + only the changed/added child lines);
 * - `rapid-pvst` shows its container-only disclosure IN-FORM before staging, and its staged entry
 *   carries the second confirm; `mstp`/`none` carry theirs; a pure instance remap carries none;
 * - staging the mode the config already states is refused at ZERO coordinator appends;
 * - four states on both reads: the hard `stp.get()` failure fails the screen; the SOFT region
 *   read failure mutes ONLY the region panel (mode form still stages); no-block is a normal ready
 *   state ("No MST region is configured"); absent mode line renders the not-found copy;
 * - the screen itself renders NO commit/abort control (#141: Transaction Center owns them);
 * - no-proxy idles on the prompt and contacts nothing.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Node, StpSettings as DeviceSettings } from '@devhax-heavy-industries/arista-eapi'

import { TransactionProvider, useTransactionSnapshot } from '../sessions/TransactionContext'
import type { TransactionSnapshot } from '../sessions/transaction'
import { StpGlobal } from './StpGlobal'

type TestNode = NonNullable<Parameters<typeof StpGlobal>[0]['node']>

const stpFixture = (over: Partial<DeviceSettings> = {}): DeviceSettings => ({
  mode: 'mstp',
  interfaces: new Map(),
  instances: new Map<string, never>(),
  ...over,
})

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

const regionSection = [
  'spanning-tree mst configuration',
  '   name LAB-UNBLOCK',
  '   revision 1',
  '   instance 1 vlan 100,110',
].join('\n')

interface Overrides {
  readonly settings?: DeviceSettings | Error
  /** The chunk map the soft `chunkConfig()` answers. Default: the capture-shaped region block. */
  readonly chunks?: ReadonlyMap<string, string>
  /** Force the SOFT region read to fail (the region-muted state). */
  readonly chunkFails?: boolean
  readonly diff?: string
}

function makeFakes(overrides: Overrides = {}) {
  const get = vi.fn(async () => {
    if (overrides.settings instanceof Error) throw overrides.settings
    return overrides.settings ?? stpFixture()
  })
  const show = vi.fn(async (command: string) => {
    if (command !== 'version') throw new Error(`SYNTHETIC unexpected show: ${command}`)
    return versionBase
  })
  const chunkConfig = vi.fn(async (): Promise<ReadonlyMap<string, string>> => {
    if (overrides.chunkFails === true) throw new Error('SYNTHETIC chunkConfig exploded')
    return overrides.chunks ?? new Map<string, string>([['spanning-tree mst configuration', regionSection]])
  })
  // The shared coordinator opens ONE named session on the first append; this screen never calls
  // configSession itself (the #141 boundary the last test pins on the DOM).
  const session = {
    name: 'ui-stpg-session',
    state: 'opened',
    isOpen: true,
    run: vi.fn(async () => []),
    diff: vi.fn(async () => overrides.diff ?? '+spanning-tree mode change'),
    hasDiffBeenRead: vi.fn(() => true),
    commit: vi.fn(async () => []),
    abort: vi.fn(async () => []),
  }
  const configSession = vi.fn(async () => session)
  const node = { stp: { get }, show, chunkConfig, configSession } as unknown as TestNode
  return { node, get, show, chunkConfig, configSession, session }
}

function SnapshotProbe() {
  const snapshot = useTransactionSnapshot()
  return <output data-testid="transaction-snapshot">{JSON.stringify(snapshot)}</output>
}

function renderScreen(fakes: ReturnType<typeof makeFakes>) {
  return render(
    <TransactionProvider node={fakes.node as Node}>
      <StpGlobal node={fakes.node} proxyConfigured />
      <SnapshotProbe />
    </TransactionProvider>,
  )
}

function snapshot(): TransactionSnapshot {
  return JSON.parse(screen.getByTestId('transaction-snapshot').textContent ?? '{}') as TransactionSnapshot
}

/** Readiness probe: the region table only lands after BOTH reads resolve (hard + soft). */
async function readyRegion(): Promise<void> {
  await screen.findByRole('table', { name: 'Configured MST instance-to-VLAN mappings' })
}

const modeSelect = () => screen.getByLabelText('Target mode')

describe('StpGlobal — reads and states', () => {
  it('ready: the verbatim mode token and the parsed region block (name/revision/instances verbatim)', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyRegion()

    expect(screen.getByText('mstp')).toBeInTheDocument()
    expect(screen.getByText('LAB-UNBLOCK')).toBeInTheDocument()
    expect(screen.getByText('100,110')).toBeInTheDocument()
    expect(fakes.chunkConfig).toHaveBeenCalledTimes(1)
  })

  it('an absent mode line renders the not-found copy, never a guess', async () => {
    renderScreen(makeFakes({ settings: stpFixture({ mode: undefined }) }))
    await readyRegion()
    expect(screen.getByText(/none — the running-config carries no `spanning-tree mode` line/u)).toBeInTheDocument()
  })

  it('no region block is a NORMAL ready state, stated as such', async () => {
    renderScreen(makeFakes({ chunks: new Map<string, string>() }))
    await waitFor(() => expect(screen.getByText(/No MST region is configured/u)).toBeInTheDocument())
    expect(screen.queryByRole('table', { name: 'Configured MST instance-to-VLAN mappings' })).not.toBeInTheDocument()
  })

  it('the SOFT region read failing mutes ONLY the region panel — the mode form still stages', async () => {
    renderScreen(makeFakes({ chunkFails: true }))
    await waitFor(() => expect(screen.getByText(/region read did not answer/u)).toBeInTheDocument())

    expect(screen.getByRole('button', { name: 'Stage region edit' })).toBeDisabled()
    // The mode form is untouched by the region failure:
    fireEvent.change(modeSelect(), { target: { value: 'none' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stage mode change' }))
    await waitFor(() => expect(snapshot().entries).toHaveLength(1))
  })

  it('the HARD stp.get() failure fails the screen with its message', async () => {
    renderScreen(makeFakes({ settings: new Error('SYNTHETIC config read exploded') }))
    expect(await screen.findByRole('alert')).toHaveTextContent('SYNTHETIC config read exploded')
    expect(screen.getByRole('button', { name: 'Stage mode change' })).toBeDisabled()
  })

  it('no-proxy: the prompt, and nothing contacted', () => {
    const fakes = makeFakes()
    render(<StpGlobal node={fakes.node} proxyConfigured={false} />)
    expect(screen.getByRole('alert')).toHaveTextContent('EAPI_HOST')
    expect(fakes.get).not.toHaveBeenCalled()
    expect(fakes.chunkConfig).not.toHaveBeenCalled()
  })
})

describe('StpGlobal — mode staging (capture-pinned lines, DR-149 confirms)', () => {
  it('stages exactly the one mode line with the blast facts and the second confirm', async () => {
    renderScreen(makeFakes())
    await readyRegion()

    fireEvent.change(modeSelect(), { target: { value: 'rapid-pvst' } })
    // The disclosure is IN-FORM before anything stages (owner decision 2026-11-21).
    expect(screen.getByText(/proven on cEOS-lab 4.28.14M only/u)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Stage mode change' }))
    await waitFor(() => expect(snapshot().entries).toHaveLength(1))
    const entry = snapshot().entries[0]
    expect(entry?.commands).toEqual(['spanning-tree mode rapid-pvst'])
    expect(entry?.display).toEqual(['spanning-tree mode rapid-pvst'])
    expect(entry?.risks.join('\n')).toMatch(/~67 ms/u)
    expect(entry?.risks.join('\n')).toMatch(/not measured on this 7050TX-64-R \(DR-043\)/u)
    expect(entry?.confirmations).toHaveLength(1)
    expect(entry?.confirmations[0]?.title).toMatch(/spanning-tree mode rapid-pvst/u)
  })

  it('mstp carries the measured-blast confirm; none carries the no-protection sentence', async () => {
    // Fixture mode is `rapid-pvst` (a device token outside the write set — DR-096 read side) so
    // neither staged target trips the already-says guard.
    renderScreen(makeFakes({ settings: stpFixture({ mode: 'rapid-pvst' }) }))
    await readyRegion()

    fireEvent.change(modeSelect(), { target: { value: 'mstp' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stage mode change' }))
    await waitFor(() => expect(snapshot().entries).toHaveLength(1))
    expect(snapshot().entries[0]?.confirmations[0]?.body).toMatch(/~67 ms/u)

    fireEvent.change(modeSelect(), { target: { value: 'none' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stage mode change' }))
    await waitFor(() => expect(snapshot().entries).toHaveLength(2))
    expect(snapshot().entries[1]?.confirmations[0]?.body).toMatch(/Disables spanning-tree on every port/u)
  })

  it('staging the mode the config already states is refused at ZERO appends', async () => {
    renderScreen(makeFakes())
    await readyRegion()

    fireEvent.change(modeSelect(), { target: { value: 'mstp' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stage mode change' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('already says `mstp`')
    expect(snapshot().entries).toHaveLength(0)
  })

  it('choosing no mode refuses in-form with zero appends', async () => {
    renderScreen(makeFakes())
    await readyRegion()
    fireEvent.click(screen.getByRole('button', { name: 'Stage mode change' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose a target mode')
    expect(snapshot().entries).toHaveLength(0)
  })
})

describe('StpGlobal — region staging (parent + only changed lines)', () => {
  it('stages the parent via submodeCommands plus ONLY the changed name and the added row', async () => {
    renderScreen(makeFakes())
    await readyRegion()

    fireEvent.change(screen.getByLabelText(/Region name/), { target: { value: 'LAB-UNBLOCK' } })
    fireEvent.change(screen.getByLabelText('Instance id 0-64'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText(/VLANs \(comma list/), { target: { value: '200-210' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add row' }))
    expect(screen.getByText('instance 2 vlan 200-210')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Stage region edit' }))
    await waitFor(() => expect(snapshot().entries).toHaveLength(1))
    const entry = snapshot().entries[0]
    // Revision untouched → no `revision` line (incremental staging; the diff is the proof).
    expect(entry?.commands).toEqual(['spanning-tree mst configuration', 'name LAB-UNBLOCK', 'instance 2 vlan 200-210'])
    expect(entry?.risks.join('\n')).toMatch(/forces spanning-tree re-convergence on all MST instances/u)
    expect(entry?.confirmations).toHaveLength(1)
    expect(entry?.confirmations[0]?.subject).toBe('MST region name LAB-UNBLOCK')
  })

  it('a pure instance remap stages without the identity second confirm', async () => {
    renderScreen(makeFakes())
    await readyRegion()

    fireEvent.change(screen.getByLabelText('Instance id 0-64'), { target: { value: '3' } })
    fireEvent.change(screen.getByLabelText(/VLANs \(comma list/), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add row' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stage region edit' }))
    await waitFor(() => expect(snapshot().entries).toHaveLength(1))
    expect(snapshot().entries[0]?.commands).toEqual(['spanning-tree mst configuration', 'instance 3 vlan 30'])
    expect(snapshot().entries[0]?.confirmations).toHaveLength(0)
    expect(snapshot().entries[0]?.risks.join('\n')).toMatch(/Re-maps VLANs to MST instances/u)
  })

  it('a removal-only draft stages the parent + the BARE `no instance <id>` with the removal fact', async () => {
    renderScreen(makeFakes())
    await readyRegion()

    // The read block carries `instance 1 vlan 100,110`; its Remove button is the only way in —
    // the id is never typed, so a removal can only name a mapping the device actually has.
    fireEvent.click(screen.getByRole('button', { name: 'Remove no instance 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stage region edit' }))

    await waitFor(() => expect(snapshot().entries).toHaveLength(1))
    const entry = snapshot().entries[0]
    expect(entry?.commands).toEqual(['spanning-tree mst configuration', 'no instance 1'])
    expect(entry?.risks.join('\n')).toMatch(/Removes the `instance … vlan …` mapping line/u)
    expect(entry?.risks.join('\n')).toMatch(/container evidence, not this unit, DR-043/u)
    // Same blast class as a remap (narrower than an identity change): risks carry the facts, no
    // second confirm — the DR-149 posture the pure-remap test above pins.
    expect(entry?.confirmations).toHaveLength(0)
  })

  it('marking a removal is undoable before staging (aria-pressed toggles)', async () => {
    renderScreen(makeFakes())
    await readyRegion()

    const toggle = screen.getByRole('button', { name: 'Remove no instance 1' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(toggle)
    expect(await screen.findByRole('button', { name: 'Undo remove no instance 1' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Undo remove no instance 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stage region edit' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Nothing to stage')
    expect(snapshot().entries).toHaveLength(0)
  })

  it('an id both added and marked for removal is refused at ZERO appends', async () => {
    renderScreen(makeFakes())
    await readyRegion()

    fireEvent.change(screen.getByLabelText('Instance id 0-64'), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText(/VLANs \(comma list/), { target: { value: '999' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add row' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove no instance 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stage region edit' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('one intent per instance id')
    expect(snapshot().entries).toHaveLength(0)
  })

  it('an empty region draft is refused at ZERO appends', async () => {
    renderScreen(makeFakes())
    await readyRegion()
    fireEvent.click(screen.getByRole('button', { name: 'Stage region edit' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Nothing to stage')
    expect(snapshot().entries).toHaveLength(0)
  })

  it('a malformed instance row is refused by the Add-row button before it can join the draft', async () => {
    renderScreen(makeFakes())
    await readyRegion()
    fireEvent.change(screen.getByLabelText('Instance id 0-64'), { target: { value: '65' } })
    fireEvent.change(screen.getByLabelText(/VLANs \(comma list/), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add row' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('0 to 64')
    expect(screen.queryByText('instance 65 vlan 10')).not.toBeInTheDocument()
  })

  it('a draft row can be removed again before staging (it was never on the device)', async () => {
    renderScreen(makeFakes())
    await readyRegion()
    fireEvent.change(screen.getByLabelText('Instance id 0-64'), { target: { value: '4' } })
    fireEvent.change(screen.getByLabelText(/VLANs \(comma list/), { target: { value: '40' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add row' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove from draft' }))
    expect(screen.queryByText('instance 4 vlan 40')).not.toBeInTheDocument()
  })

  it('the screen renders NO commit/abort control anywhere (#141 boundary)', async () => {
    renderScreen(makeFakes())
    await readyRegion()
    expect(screen.queryAllByRole('button', { name: /commit|abort/iu })).toHaveLength(0)
  })
})
