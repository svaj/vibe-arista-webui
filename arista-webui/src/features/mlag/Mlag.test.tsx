/**
 * S14 (#84): the READ-ONLY MLAG status screen, offline through the hand-rolled fake-client seam —
 * the `Ntp.test.tsx` shape (config-backed M resource: the seams are `mlag.get()` plus the soft
 * `show('mlag')` and the silent `show('version')`). No test here contacts a device.
 *
 * The acceptance lines #84 grades, pinned below:
 * - the status pill maps ONLY the captured `state` key of `ShowMlagReply` — the five tokens get a
 *   label, any other token (or an empty string) is shown verbatim as unrecognised; no invented
 *   field is ever rendered, and the consistency line is stated as not-captured, never fabricated;
 * - the captured NOT-CONFIGURED sample (empty config, no interfaces, `state: "disabled"`) renders
 *   as the normal ready state — “MLAG is not configured”, no role=alert anywhere;
 * - an unanswered or `Error [1002]`-rejected `show mlag` leaves the pill UNKNOWN with the device
 *   text folded in — never an error wall, and the config-side panels still render;
 * - four states: no-proxy, loading, failed hard read, ready (configured and unconfigured arms);
 * - READ-ONLY: the fake node exposes exactly the two model seams; no button offers a write, and
 *   the standing banner saying configuration editing is not offered renders in every state.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { MlagState } from '@devhax-heavy-industries/arista-eapi'

import { Mlag } from './Mlag'
import type { ShowMlagReply } from '../../eapi/show-contracts'

type TestNode = NonNullable<Parameters<typeof Mlag>[0]['node']>

/** The captured not-configured reply verbatim from `test/fixtures/live/ceos-4.28.14M/show-mlag.json` (result half). */
const capturedDisabled: ShowMlagReply = {
  state: 'disabled',
  localInterface: '',
  peerLink: '',
  reloadDelay: 300,
  reloadDelayNonMlag: 300,
  mlagPorts: { Disabled: 0, 'Active-partial': 0, Inactive: 0, Configured: 0, 'Active-full': 0 },
  portsErrdisabled: false,
  dualPrimaryDetectionState: 'disabled',
  dualPrimaryPortsErrdisabled: false,
}

/** Same keys, an active-domain payload — the ENABLED vocabulary is uncaptured, so this is SYNTHETIC shape-faithful data. */
const activeReply = (over: Partial<ShowMlagReply> = {}): ShowMlagReply => ({
  ...capturedDisabled,
  state: 'active',
  localInterface: 'Vlan4094',
  peerLink: 'Port-Channel1',
  mlagPorts: { Disabled: 0, 'Active-partial': 0, Inactive: 0, Configured: 2, 'Active-full': 2 },
  ...over,
})

const configuredDevice = (over: Partial<MlagState> = {}): MlagState => ({
  config: { domainId: 'MLAG-D1', localInterface: 'Vlan4094', peerAddress: '10.0.0.1', peerLink: 'Port-Channel1', shutdown: false },
  interfaces: new Map([['Port-Channel10', { name: 'Port-Channel10', mlagId: '10' }]]),
  ...over,
})

/** The client’s divergence-1 answer on a fresh switch: every field absent, `shutdown` included. */
const notConfiguredDevice = (): MlagState => ({ config: {}, interfaces: new Map() })

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
  readonly device?: MlagState | Error
  readonly showReply?: ShowMlagReply
  readonly showFails?: boolean
  readonly versionFails?: boolean
}

function makeFakes(overrides: Overrides = {}) {
  const get = vi.fn(async () => {
    if (overrides.device instanceof Error) throw overrides.device
    return overrides.device ?? configuredDevice()
  })
  const show = vi.fn(async (command: string) => {
    if (command === 'mlag') {
      if (overrides.showFails === true) throw new Error('Error [1002]: invalid command mlag [SYNTHETIC not modelled on this target]')
      return overrides.showReply ?? capturedDisabled
    }
    if (command === 'version') {
      if (overrides.versionFails === true) throw new Error('SYNTHETIC show version exploded')
      return versionBase
    }
    throw new Error(`SYNTHETIC unexpected show: ${command}`)
  })
  const node = { mlag: { get }, show } as unknown as TestNode
  return { node, get, show }
}

function renderScreen(fakes: ReturnType<typeof makeFakes>) {
  return render(<Mlag node={fakes.node} proxyConfigured />)
}

/** Readiness probe for the configured arm: the config table only lands once both reads resolved. */
async function readyConfigured(): Promise<void> {
  await screen.findByText('MLAG-D1')
}

const statusNote = () => screen.getByText(/Device token:/u)
const domainTable = () => screen.getByRole('table', { name: 'Configured MLAG domain fields' })
const interfaceTable = () => screen.getByRole('table', { name: 'MLAG-assigned interfaces' })
const captureTable = () => screen.getByRole('table', { name: 'Captured show mlag fields' })
const portCountsTable = () => screen.getByRole('table', { name: 'Captured mlagPorts counts by device label' })
const reloadButton = () => screen.getByRole('button', { name: 'Reload MLAG state' })

// ====================================================================================================
// Four states
// ====================================================================================================

describe('Mlag — four states, read-only in every one', () => {
  it('no proxy: prompt, Reload disabled, and mlag.get()/show() stay at zero calls — banner up before any answer', () => {
    const fakes = makeFakes()
    render(<Mlag node={fakes.node} proxyConfigured={false} />)

    expect(screen.getByRole('alert')).toHaveTextContent('Local proxy is not configured')
    expect(reloadButton()).toBeDisabled()
    expect(fakes.get).not.toHaveBeenCalled()
    expect(fakes.show).not.toHaveBeenCalled()
    expect(screen.getByText(/configuration editing is not offered here/u)).toBeInTheDocument()
    // Pending reads are pending, not unknown: the status panel says answer-pending, no pill yet.
    expect(screen.getByText(/device state is pending/u)).toBeInTheDocument()
  })

  it('loading: the read batch is in flight and says so — not a blank workspace', () => {
    // A never-settling first read pins the loading arm; the soft reads cannot even start yet.
    const get = vi.fn((): Promise<MlagState> => new Promise<MlagState>(() => undefined))
    const show = vi.fn(async () => versionBase)
    const node = { mlag: { get }, show } as unknown as TestNode
    render(<Mlag node={node} proxyConfigured />)
    // the connection label also says “Reading MLAG state…”, so pin the full notice arm
    expect(screen.getByText(/Reading MLAG state \(parsed running-config/u)).toBeInTheDocument()
    expect(screen.getByText(/device state is pending/u)).toBeInTheDocument()
    expect(screen.getByText(/rides the same/u)).toBeInTheDocument() // interfaces panel: same-read pending note
  })

  it('ready-configured: pill, the five config fields, the interface table, and the captured show fields', async () => {
    const fakes = makeFakes({ showReply: activeReply() })
    const { container } = renderScreen(fakes)
    await readyConfigured()

    // raw device string AND mapped label, side by side, in the status note
    expect(statusNote()).toHaveTextContent('active')
    expect(statusNote()).toHaveTextContent('Active')
    expect(screen.getByText(/Consistency-check lines are not part of the captured/u)).toBeInTheDocument()

    expect(within(domainTable()).getByText('MLAG-D1')).toBeInTheDocument()
    expect(within(domainTable()).queryByText('Not reported')).toBeNull() // shutdown is answered in this arm
    expect(within(domainTable()).getByText(/No — the section carries an explicit `no shutdown` line/u)).toBeInTheDocument()
    expect(within(domainTable()).getByText('10.0.0.1')).toBeInTheDocument()

    expect(within(interfaceTable()).getByText('Port-Channel10')).toBeInTheDocument()
    expect(within(interfaceTable()).getByText('10')).toBeInTheDocument()

    // every captured key renders; empty strings stay as sent
    expect(within(captureTable()).getByText('Vlan4094')).toBeInTheDocument()
    expect(within(captureTable()).getAllByText('300')).toHaveLength(2)
    expect(within(portCountsTable()).getAllByText('0')).toHaveLength(3)
    expect(within(portCountsTable()).getAllByText('2')).toHaveLength(2)

    // identity chip from the silent show('version') read
    expect(container.querySelector('.device-identity')).not.toBeNull()
    // connection label claims only what the reads confirmed
    expect(screen.getByText(/Reads served: parsed running-config plus the captured show mlag reply/u)).toBeInTheDocument()
  })

  it('THE PRIMARY JOB — the captured not-configured sample is a NORMAL ready state, never an error', async () => {
    const fakes = makeFakes({ device: notConfiguredDevice(), showReply: capturedDisabled })
    renderScreen(fakes)

    expect(await screen.findByText('MLAG is not configured on this device.')).toBeInTheDocument()
    expect(screen.getByText(/No Port-Channel interface carries an mlag id/u)).toBeInTheDocument()
    // the state pill still reports what the device said — captured disabled vocabulary, mapped
    expect(statusNote()).toHaveTextContent('disabled')
    expect(statusNote()).toHaveTextContent('Disabled')
    // and the whole screen carries no alert role anywhere
    expect(screen.queryByRole('alert')).toBeNull()
    // the shutdown field of the section-absent answer is the not-reported arm — but the unconfigured
    // panel shows the EmptyState instead of the table, so the sentence rides its hint
    expect(screen.getByText(/Configuration editing is not offered on this screen/u)).toBeInTheDocument()
  })

  it('a failed hard read is an error, never a blank panel: alert carries the device text, banners stay, reload offered', async () => {
    const fakes = makeFakes({ device: new Error('SYNTHETIC mlag read exploded') })
    renderScreen(fakes)

    expect(await screen.findByRole('alert')).toHaveTextContent('SYNTHETIC mlag read exploded')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    // unread arms, not invented empties
    expect(screen.getByText(/domain settings are unknown — not empty/u)).toBeInTheDocument()
    expect(screen.getByText(/device state is pending/u)).toBeInTheDocument()
    // the read-only banner never depends on a device answer
    expect(screen.getByText(/configuration editing is not offered here/u)).toBeInTheDocument()
    expect(fakes.get).toHaveBeenCalledTimes(1)
  })

  it('Reload re-runs the whole read batch', async () => {
    const fakes = makeFakes({ device: notConfiguredDevice(), showReply: capturedDisabled })
    renderScreen(fakes)
    await screen.findByText('MLAG is not configured on this device.')

    fireEvent.click(reloadButton())
    await vi.waitFor(() => expect(fakes.show).toHaveBeenCalledTimes(4)) // full second batch: mlag+version twice
    expect(fakes.get).toHaveBeenCalledTimes(2)
    expect(fakes.show.mock.calls.map(([command]) => command)).toEqual(['mlag', 'version', 'mlag', 'version'])
  })
})

// ====================================================================================================
// The status pill — mapped only from the captured contract
// ====================================================================================================

describe('Mlag — status pill maps only fields the capture carries', () => {
  it.each([
    ['active', 'Active'],
    ['disabled', 'Disabled'],
    ['inactive', 'Inactive'],
    ['paused', 'Paused'],
    ['misconfigured', 'Misconfigured'],
  ] as const)('device state %s renders the raw token beside the label %s', async (raw, label) => {
    renderScreen(makeFakes({ device: notConfiguredDevice(), showReply: activeReply({ state: raw }) }))
    await screen.findByText('MLAG is not configured on this device.')

    expect(statusNote()).toHaveTextContent(raw)
    // scoped: the port-bucket table also carries device labels like `Inactive`, so the mapped label
    // is asserted inside the status note, where only the pill and its strong label live
    expect(within(statusNote()).getByText(label)).toBeInTheDocument()
    expect(statusNote()).not.toHaveTextContent(/outside the five states/u)
  })

  it('a token outside the five is shown verbatim and marked unrecognised — never renamed', async () => {
    renderScreen(makeFakes({ showReply: activeReply({ state: 'peer-bleeding' }) }))
    await readyConfigured()

    expect(statusNote()).toHaveTextContent('peer-bleeding')
    expect(screen.getByText(/outside the five states this screen maps/u)).toBeInTheDocument()
    // the five names are listed honestly in that same sentence
    expect(screen.getByText(/active, disabled, inactive, paused, misconfigured/u)).toBeInTheDocument()
  })

  it('an empty state string says empty — it does not borrow the disabled meaning', async () => {
    renderScreen(makeFakes({ showReply: activeReply({ state: '' }) }))
    await readyConfigured()

    expect(screen.getByText(/empty state string/u)).toBeInTheDocument()
  })

  it('1002 REPEAT the acceptance line — show mlag answering Error [1002] gives UNKNOWN with the device text, config panels stay live, and nothing alerts', async () => {
    renderScreen(makeFakes({ showFails: true }))
    await readyConfigured() // the config side came back; only the show read is refused

    const unknownNote = screen.getByText(/did not produce a state/u)
    expect(unknownNote).toHaveTextContent('1002')
    expect(screen.getByText(/UNKNOWN by design/u)).toBeInTheDocument()
    // no error wall: the ONLY alert-less posture — query the whole screen
    expect(screen.queryByRole('alert')).toBeNull()
    // and the panels the config read CAN answer still render
    expect(within(domainTable()).getByText('MLAG-D1')).toBeInTheDocument()
    expect(within(interfaceTable()).getByText('Port-Channel10')).toBeInTheDocument()
    // the captured-fields panel states it has no answer instead of guessing
    expect(screen.getByText(/did not answer, so no captured field can be shown/u)).toBeInTheDocument()
    expect(screen.queryAllByRole('table').map((t) => t.getAttribute('aria-label'))).toEqual([
      'Configured MLAG domain fields',
      'MLAG-assigned interfaces',
    ])
  })

  it('a silent show version failure only costs the identity chip', async () => {
    const { container } = renderScreen(makeFakes({ versionFails: true }))
    await readyConfigured()

    expect(container.querySelector('.device-identity')).toBeNull()
    expect(statusNote()).toHaveTextContent('disabled')
  })
})

// ====================================================================================================
// The read-only boundary and the render contract
// ====================================================================================================

describe('Mlag — read-only boundary', () => {
  it('the container type seam is EXACTLY mlag+show: the fake node carries no configSession, and no button offers a write', async () => {
    const fakes = makeFakes()
    expect(Object.keys(fakes.node).sort()).toEqual(['mlag', 'show'])
    renderScreen(fakes)
    await readyConfigured()

    // Every control on the screen: just Reload. Nothing matches a write verb.
    const buttons = screen.getAllByRole('button')
    expect(buttons.map((b) => b.textContent)).toEqual(['Reload MLAG state'])
    for (const forbidden of [/commit/u, /enable/u, /save/u, /configure/u, /edit/u, /apply/u, /delete/u, /remove/u, /add/u]) {
      expect(buttons.some((b) => forbidden.test(b.textContent ?? '')), String(forbidden)).toBe(false)
    }
    // one read of each seam, zero of anything else
    expect(fakes.get).toHaveBeenCalledTimes(1)
    expect(fakes.show).toHaveBeenCalledTimes(2)
  })

  it('every table is a DataTable: real th[scope=col] markup in each rendered table', async () => {
    const fakes = makeFakes()
    const { container } = renderScreen(fakes)
    await readyConfigured()

    const tables = container.querySelectorAll('table')
    expect(tables.length).toBe(4) // domain fields, interfaces, captured fields, port counts
    for (const table of tables) {
      expect(table.querySelectorAll('thead th[scope="col"]').length).toBeGreaterThan(0)
    }
    // and it asked the device at most the two scripted seams
    expect(fakes.get).toHaveBeenCalledTimes(1)
  })

  it('a partially configured section shows the derived-yes shutdown and (not configured) for every absent line', async () => {
    renderScreen(makeFakes({
      device: { config: { domainId: 'PARTIAL', shutdown: true }, interfaces: new Map() },
      showReply: capturedDisabled,
    }))
    await screen.findByText('PARTIAL')

    expect(within(domainTable()).getAllByText('(not configured)')).toHaveLength(3)
    expect(within(domainTable()).getByText(/Yes — the section carries no `no shutdown` line/u)).toBeInTheDocument()
    // section present ⇒ not the unconfigured arm
    expect(screen.queryByText('MLAG is not configured on this device.')).toBeNull()
  })
})
