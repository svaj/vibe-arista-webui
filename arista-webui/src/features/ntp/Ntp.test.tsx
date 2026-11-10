/**
 * S12 (#82): the NTP configuration screen, offline through hand-rolled fake client seams — the
 * `SystemSettings.test.tsx` shape (config-backed M resource: the seam is `ntp.get()` plus a soft
 * `show('version')`; scenario values are hand-authored config-shaped data, not captured payloads).
 * No test here contacts a device, and nothing fabricates a `show ntp` contract.
 *
 * The acceptance lines #82 names, pinned below:
 * - "server add/remove + source command texts pinned" — each session `run()` argv pins a command
 *   line byte-for-byte (add, add+prefer, remove, remove-all `no ntp`, and set/unset/default source
 *   in BOTH the `ntp source` and `ntp local-interface` arms), copied from ntp.test.ts's pins;
 * - "refuse option spellings the client didn't port" — a typed `1.2.3.4 iburst` refuses in-form at
 *   ZERO sessions, naming the client contract;
 * - "cancelling the confirm sends nothing" — declining an `F4` confirm leaves `commit()` at zero calls;
 * - "bulk-destructive remove-all names the exact current list" — the risk/confirm copy carries it,
 *   and it goes through the destructive commit confirm;
 * - source change is destructive-confirm and names the currently configured interface (the only one
 *   the screen can see), never an in-band claim;
 * - "sync-status hidden / 'unknown — not captured'; never invent fields" — a panel says not captured
 *   and the synchronisation vocabulary never reaches the DOM;
 * - "four states" — no-proxy, loading, failed read, ready (empty list is a normal ready state).
 * - the config diff renders in a real `<pre>` (tagName pin).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { NtpSettings as DeviceSettings } from '@devhax-heavy-industries/arista-eapi'

import { Ntp } from './Ntp'

type TestNode = NonNullable<Parameters<typeof Ntp>[0]['node']>

const settingsFixture = (over: Partial<DeviceSettings> = {}): DeviceSettings => ({
  sourceInterface: 'Management1',
  servers: [
    { address: '1.2.3.4', prefer: true },
    { address: '10.0.0.1', prefer: false },
  ],
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

interface Overrides {
  readonly settings?: DeviceSettings | Error
  readonly version?: string
  readonly versionFails?: boolean
  readonly diff?: string
  readonly diffRead?: boolean
  readonly commitError?: Error
}

function makeFakes(overrides: Overrides = {}) {
  const session = {
    name: 'ui-s12-session',
    state: 'diffed',
    isOpen: false,
    run: vi.fn(async () => []),
    diff: vi.fn(async () => overrides.diff ?? '+ntp server 10.0.0.1'),
    hasDiffBeenRead: vi.fn(() => overrides.diffRead ?? true),
    commit: vi.fn(async () => {
      if (overrides.commitError !== undefined) throw overrides.commitError
      return []
    }),
    abort: vi.fn(async () => []),
  }
  const get = vi.fn(async () => {
    if (overrides.settings instanceof Error) throw overrides.settings
    return overrides.settings ?? settingsFixture()
  })
  const show = vi.fn(async (command: string) => {
    if (command !== 'version') throw new Error(`SYNTHETIC unexpected show: ${command}`)
    if (overrides.versionFails === true) throw new Error('SYNTHETIC show version exploded')
    return { ...versionBase, ...(overrides.version === undefined ? {} : { version: overrides.version }) }
  })
  const configSession = vi.fn(async () => session)
  const node = { ntp: { get }, show, configSession } as unknown as TestNode
  return { node, session, get, show, configSession }
}

function renderScreen(fakes: ReturnType<typeof makeFakes>) {
  return render(<Ntp node={fakes.node} proxyConfigured />)
}

/** Readiness probe: the ready payload only lands after BOTH `get()` and the soft `show('version')`. */
async function readyServers(): Promise<void> {
  await screen.findByText('1.2.3.4')
}

async function stageReady(fakes: ReturnType<typeof makeFakes>): Promise<void> {
  await waitFor(() => expect(fakes.session.run).toHaveBeenCalled())
  await screen.findByText(/Review the device diff before committing/u)
}

const addField = () => screen.getByLabelText(/Add NTP server/u)
const sourceField = () => screen.getByLabelText(/Source interface name/u)

// ====================================================================================================
// Four states — nothing contacted unless the operator asks
// ====================================================================================================

describe('Ntp — four states', () => {
  it('no proxy: prompt, every control disabled, and ntp.get()/show()/configSession() stay at zero calls', () => {
    const fakes = makeFakes()
    render(<Ntp node={fakes.node} proxyConfigured={false} />)

    expect(screen.getByRole('alert')).toHaveTextContent('Local proxy is not configured')
    expect(screen.getByRole('button', { name: 'Add server' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Set source interface' })).toBeDisabled()
    expect(fakes.get).not.toHaveBeenCalled()
    expect(fakes.show).not.toHaveBeenCalled()
    expect(fakes.configSession).not.toHaveBeenCalled()
  })

  it('loading: the read is in flight, showing config-read copy — not a blank settings panel', () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    // before the async loader resolves the screen is on the loading arm (the source note, not the
    // connection label, which spells the same lead-in on its own)
    expect(screen.getByText(/Reading the running-config \(NTP settings/u)).toBeInTheDocument()
  })

  it('ready: shows the PARSED CONFIG — server rows with their preference, the configured source, and the version-chosen source form', async () => {
    const fakes = makeFakes()
    const { container } = renderScreen(fakes)
    await readyServers()

    expect(screen.getByText('10.0.0.1')).toBeInTheDocument()
    expect(screen.getByText('preferred')).toBeInTheDocument() // the prefer pill on 1.2.3.4
    expect(screen.getByText(/Current configured source: /u)).toHaveTextContent('Management1')
    // identity chip from the soft show('version') read
    expect(container.querySelector('.device-identity')).not.toBeNull()
    // 4.28 -> the dashed form is announced, chosen by the client floor (never invented). The copy
    // wraps the stem in a <code>, so pin the stem element itself.
    expect(screen.getByText('ntp local-interface')).toBeInTheDocument()
  })

  it('an empty server list is a normal configured state, not an error (EmptyState, no alert)', async () => {
    const fakes = makeFakes({ settings: settingsFixture({ sourceInterface: undefined, servers: [] }) })
    renderScreen(fakes)

    expect(await screen.findByText(/No NTP servers are configured/u)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove all servers' })).toBeDisabled()
    // "unset" source panel state, not an error
    expect(screen.getByText(/no `ntp source` \/ `ntp local-interface` line/u)).toBeInTheDocument()
    expect(screen.queryByRole('alert', { name: /NTP read failed/u })).toBeNull()
  })

  it('a failed NTP read is an error, never a blank panel: alert copy, controls locked, unread fields', async () => {
    const fakes = makeFakes({ settings: new Error('SYNTHETIC config read exploded') })
    renderScreen(fakes)

    expect(await screen.findByRole('alert')).toHaveTextContent('SYNTHETIC config read exploded')
    expect(screen.getByRole('button', { name: 'Add server' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Set source interface' })).toBeDisabled()
    expect(fakes.get).toHaveBeenCalledTimes(1)
    expect(fakes.configSession).not.toHaveBeenCalled()
  })
})

// ====================================================================================================
// Server writes — command texts pinned byte-for-byte
// ====================================================================================================

describe('Ntp — server add/remove/remove-all stage the exact client-composed lines', () => {
  it('add server (no prefer): session description + `ntp server 10.0.0.9`, review, risky confirm, re-read', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyServers()

    fireEvent.change(addField(), { target: { value: '10.0.0.9' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }))
    await stageReady(fakes)

    expect(fakes.configSession).toHaveBeenCalledWith({ description: 'webui ntp add server' })
    expect(fakes.session.run).toHaveBeenCalledWith(['ntp server 10.0.0.9'])

    fireEvent.click(screen.getByRole('button', { name: 'Commit to running-config' }))
    fireEvent.click(await screen.findByRole('button', { name: /Commit despite the risk: ntp server 10\.0\.0\.9/u }))
    await waitFor(() => expect(fakes.session.commit).toHaveBeenCalled())
    await waitFor(() => expect(fakes.get).toHaveBeenCalledTimes(2)) // re-read after commit
    expect(screen.getByText(/Startup-config was not changed/u)).toBeInTheDocument()
  })

  it('add server with Prefer: the `prefer` folded into the value line exactly like the client (`ntp server 5.5.5.5 prefer`)', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyServers()

    fireEvent.change(addField(), { target: { value: '5.5.5.5' } })
    fireEvent.click(screen.getByLabelText(/Prefer this server/u))
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }))
    await stageReady(fakes)

    expect(fakes.session.run).toHaveBeenCalledWith(['ntp server 5.5.5.5 prefer'])
  })

  it('remove one server: `no ntp server 1.2.3.4`; not flagged bulk-destructive but still confirmed', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyServers()

    fireEvent.click(screen.getByRole('button', { name: 'Remove server 1.2.3.4' }))
    await stageReady(fakes)
    expect(fakes.configSession).toHaveBeenCalledWith({ description: 'webui ntp remove server' })
    expect(fakes.session.run).toHaveBeenCalledWith(['no ntp server 1.2.3.4'])
  })

  it('remove-all servers: the single `no ntp` line, destructive confirm naming the EXACT current list', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyServers()

    fireEvent.click(screen.getByRole('button', { name: 'Remove all servers' }))
    await stageReady(fakes)

    expect(fakes.configSession).toHaveBeenCalledWith({ description: 'webui ntp remove all servers' })
    expect(fakes.session.run).toHaveBeenCalledWith(['no ntp'])
    // the risk copy names the exact configured set it would take out
    expect(screen.getByText(/1\.2\.3\.4 \(preferred\), 10\.0\.0\.1/u)).toBeInTheDocument()
    // destructive → risky commit verb
    fireEvent.click(screen.getByRole('button', { name: 'Commit (risky — review above)' }))
    fireEvent.click(await screen.findByRole('button', { name: /Commit despite the risk: no ntp/u }))
    await waitFor(() => expect(fakes.session.commit).toHaveBeenCalled())
  })

  it('declining a confirm sends nothing: commit() never fires, no second session opens (#82)', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyServers()

    fireEvent.click(screen.getByRole('button', { name: 'Remove all servers' }))
    await stageReady(fakes)
    fireEvent.click(screen.getByRole('button', { name: 'Commit (risky — review above)' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(fakes.session.commit).not.toHaveBeenCalled()
    // staged (run) but nothing committed; still exactly one session
    expect(fakes.session.run).toHaveBeenCalledTimes(1)
    expect(fakes.configSession).toHaveBeenCalledTimes(1)
  })

  it('un-ported option spellings are refused in-form at ZERO sessions', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyServers()

    fireEvent.change(addField(), { target: { value: '1.2.3.4 iburst' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/trailing option spellings are/u)
    expect(fakes.configSession).not.toHaveBeenCalled()

    fireEvent.change(addField(), { target: { value: '1.2.3.4 version 4' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(fakes.configSession).not.toHaveBeenCalled()
  })
})

// ====================================================================================================
// Source writes — version floor decides the form; the write is destructive-confirm
// ====================================================================================================

describe('Ntp — the source verbs use the client-picked form and hard-confirm', () => {
  it('4.28 set source: `ntp local-interface Vlan50`; the confirm names the CURRENT source (Management1)', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyServers()

    fireEvent.change(sourceField(), { target: { value: 'Vlan50' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set source interface' }))
    await stageReady(fakes)

    expect(fakes.configSession).toHaveBeenCalledWith({ description: 'webui ntp set source' })
    expect(fakes.session.run).toHaveBeenCalledWith(['ntp local-interface Vlan50'])
    expect(screen.getByText(/currently configured is `Management1`/u)).toBeInTheDocument()
    expect(screen.getByText(/not observable from this screen/u)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Commit (risky — review above)' }))
    fireEvent.click(await screen.findByRole('button', { name: /Commit despite the risk: ntp local-interface Vlan50/u }))
    await waitFor(() => expect(fakes.session.commit).toHaveBeenCalled())
  })

  it('pre-4.23 device: the same write composes the OLD form `ntp source Vlan50`', async () => {
    const fakes = makeFakes({ version: '4.17.1.1' })
    renderScreen(fakes)
    await readyServers()
    expect(screen.getByText('ntp source')).toBeInTheDocument()

    fireEvent.change(sourceField(), { target: { value: 'Vlan50' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set source interface' }))
    await stageReady(fakes)
    expect(fakes.session.run).toHaveBeenCalledWith(['ntp source Vlan50'])
  })

  it('unset source (4.28): `no ntp local-interface`, and an abort writes nothing', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyServers()

    fireEvent.click(screen.getByRole('button', { name: 'Unset source' }))
    await stageReady(fakes)
    expect(fakes.session.run).toHaveBeenCalledWith(['no ntp local-interface'])

    // One session at a time: the abort confirm is destructive-true, so the panel button and the
    // dialog confirm share the label — the LAST one is the dialog's.
    fireEvent.click(screen.getByRole('button', { name: 'Abort staged changes' }))
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Abort staged changes' })).toHaveLength(2))
    fireEvent.click(screen.getAllByRole('button', { name: 'Abort staged changes' }).at(-1)!)
    await waitFor(() => expect(fakes.session.abort).toHaveBeenCalled())
    expect(fakes.session.commit).not.toHaveBeenCalled()
  })

  it('default source (4.28): `default ntp local-interface`', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyServers()

    fireEvent.click(screen.getByRole('button', { name: 'Default source' }))
    await stageReady(fakes)
    expect(fakes.session.run).toHaveBeenCalledWith(['default ntp local-interface'])
  })

  it('unset source when none is configured is DISABLED (no session, no blind negation)', async () => {
    const fakes = makeFakes({ settings: settingsFixture({ sourceInterface: undefined }) })
    renderScreen(fakes)
    await readyServers()
    expect(screen.getByRole('button', { name: 'Unset source' })).toBeDisabled()
    expect(fakes.configSession).not.toHaveBeenCalled()
  })

  it('a source change to the SAME interface already configured refuses at zero sessions', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyServers()

    fireEvent.change(sourceField(), { target: { value: 'Management1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set source interface' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/already the configured NTP source/u)
    expect(fakes.configSession).not.toHaveBeenCalled()
  })

  it('a bad interface name is refused by the client grammar at zero sessions', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyServers()

    fireEvent.change(sourceField(), { target: { value: 'Ethernet/1 nonsense' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set source interface' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/not an interface name this client accepts/u)
    expect(fakes.configSession).not.toHaveBeenCalled()
  })
})

// ====================================================================================================
// The version floor refuses rather than guesses — and only for the source verbs
// ====================================================================================================

describe('Ntp — the source form is version-gated; server writes are not', () => {
  it('an unclassifiable version refuses the source write (zero sessions) while a server write still stages', async () => {
    const fakes = makeFakes({ version: 'software-version-string' })
    renderScreen(fakes)
    await readyServers()

    fireEvent.change(sourceField(), { target: { value: 'Vlan50' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set source interface' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot classify the device version/u)
    expect(fakes.configSession).not.toHaveBeenCalled()

    // server add does NOT need the version and still works on the same render
    fireEvent.change(addField(), { target: { value: '8.8.8.8' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }))
    await stageReady(fakes)
    expect(fakes.session.run).toHaveBeenCalledWith(['ntp server 8.8.8.8'])
  })

  it('a failed show-version read removes the chip, claims nothing, and refuses the source verbs at zero sessions', async () => {
    const fakes = makeFakes({ versionFails: true })
    const { container } = renderScreen(fakes)
    await readyServers()
    expect(container.querySelector('.device-identity')).toBeNull()

    fireEvent.change(sourceField(), { target: { value: 'Vlan50' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set source interface' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/show version.{0,40}did not answer/u)
    expect(fakes.configSession).not.toHaveBeenCalled()
  })
})

// ====================================================================================================
// Synchronisation stays uncaptured; the diff renders as a real <pre>
// ====================================================================================================

describe('Ntp — sync state is not-captured, and the device diff renders in a PRE', () => {
  it('the screen labels configured-not-synchronised and states sync state is not captured — inventing no fields', async () => {
    const fakes = makeFakes()
    const { container } = renderScreen(fakes)
    await readyServers()

    expect(screen.getByText(/configured NTP state/u)).toBeInTheDocument()
    expect(screen.getByText('Synchronisation state is unknown — not captured.')).toBeInTheDocument()
    // no stratum / epoch / associating/associated-peer vocabulary may ever reach the DOM
    expect(container.textContent).not.toMatch(/stratum|epoch|associating|associated peer/iu)
    // and no invented status is claimed about the clock
    expect(fakes.show).toHaveBeenCalledWith('version')
    expect(fakes.show.mock.calls.filter(([c]) => String(c).startsWith('ntp'))).toHaveLength(0)
  })

  it('the staged review renders the device diff inside a real <pre> (untrusted text, not HTML)', async () => {
    const fakes = makeFakes({ diff: '+ntp server 10.0.0.9' })
    const { container } = renderScreen(fakes)
    await readyServers()

    fireEvent.change(addField(), { target: { value: '10.0.0.9' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }))
    await stageReady(fakes)

    const pre = container.querySelector('pre.diff-output')
    expect(pre).not.toBeNull()
    expect(pre?.tagName).toBe('PRE')
    expect(screen.getByText('+ntp server 10.0.0.9')).toBeInTheDocument()
  })

  it('commit stays locked until the device diff has been read (hasDiffBeenRead false)', async () => {
    const fakes = makeFakes({ diffRead: false })
    renderScreen(fakes)
    await readyServers()

    fireEvent.change(addField(), { target: { value: '10.0.0.9' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }))
    await stageReady(fakes)
    expect(screen.getByRole('button', { name: /Commit to running-config/u })).toBeDisabled()
    expect(fakes.session.commit).not.toHaveBeenCalled()
  })
})

// ====================================================================================================
// Guard rails #82 leans on: one session at a time, an already-present server is still honest, and a
// device CommandError surfaces with the standing commit-recovery copy.
// ====================================================================================================

describe('Ntp — staging discipline and device-error surfacing', () => {
  it('a second write while a session is staged is refused (one transaction at a time)', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyServers()

    fireEvent.change(addField(), { target: { value: '10.0.0.9' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }))
    await stageReady(fakes)

    fireEvent.change(addField(), { target: { value: '10.0.0.10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }))
    expect(await screen.findByText(/A staged session is already open/u)).toBeInTheDocument()
    expect(fakes.configSession).toHaveBeenCalledTimes(1)
  })

  it('re-adding an address that is already configured stages it (device decides) and says so in the risk', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyServers()

    fireEvent.change(addField(), { target: { value: '1.2.3.4' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }))
    await stageReady(fakes)

    expect(fakes.session.run).toHaveBeenCalledWith(['ntp server 1.2.3.4'])
    expect(screen.getByText(/already appears in the parsed config/u)).toBeInTheDocument()
  })

  it('a write the device rejects surfaces the device text plus the commit-recovery warning (never a false success)', async () => {
    const fakes = makeFakes({ commitError: new Error('Command rejected: ntp server not valid here') })
    renderScreen(fakes)
    await readyServers()

    fireEvent.change(addField(), { target: { value: '10.0.0.9' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }))
    await stageReady(fakes)

    fireEvent.click(screen.getByRole('button', { name: 'Commit to running-config' }))
    fireEvent.click(await screen.findByRole('button', { name: /Commit despite the risk: ntp server 10\.0\.0\.9/u }))

    const alert = await screen.findByText(/Command rejected: ntp server not valid here/u)
    expect(alert.textContent).toContain('Commit was attempted; refresh device state')
    expect(screen.queryByText(/Startup-config was not changed/u)).toBeNull()
  })
})
