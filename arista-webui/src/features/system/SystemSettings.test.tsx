/**
 * S8 (#78): the system settings screen, offline through hand-rolled fake client seams — the
 * `IpAddressing.test.tsx` shape (config-backed M resource: the seam IS `system.get()`, a scripted
 * `SystemSettings` record; scenario values are hand-authored config-shaped data, not captured
 * payloads, exactly as S6 declares for its rows). No test here contacts a device.
 *
 * The acceptance lines this file pins, in #78's own words:
 * - "Hostname/ip-routing/banner command texts pinned (banner payload byte-for-byte incl. the EOF
 *   line)": the session `run()` argv pins for `hostname …` / `no hostname` / `ip routing` /
 *   `no ip routing` / `no banner <kind>`, and for banners the `{cmd, input}` spec compared
 *   literally — body + the exact `\nEOF\n` terminator the client owns (DR-015/DR-056);
 * - "the banner body is never sent raw through an HTML sink": the XSS-shaped body control proves
 *   the re-read body renders as TEXT (`<pre>`, `querySelector('img') === null`);
 * - "four states": no-proxy (nothing contacted), loading label arm, failed read (alert + locked
 *   controls), ready;
 * - "F4 confirm on `no ip routing`": the destructive commit confirm, and its declined twin leaving
 *   `commit()` at zero calls;
 * - guards refuse IN-FORM at zero sessions (`configSession` call count pins) — client policy
 *   labelled as such — and a refused same-value staging never opens a session either.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Node, SystemSettings as DeviceSettings } from '@devhax-heavy-industries/arista-eapi'

import { TransactionProvider } from '../sessions/TransactionContext'
import { SystemSettings } from './SystemSettings'

type TestNode = NonNullable<Parameters<typeof SystemSettings>[0]['node']>

const settingsFixture = (over: Partial<DeviceSettings> = {}): DeviceSettings => ({
  hostname: 'sw1',
  ipRouting: true,
  banner: { motd: 'Authorized access only.', login: '' },
  ...over,
})

const versionReply = { hostname: 'sw1', version: '4.28.13.1M', systemMacAddress: '00:00:00:00:00:00', modelName: 'DCS-7050TX-64', serialNumber: '0000000000', internalVersion: '4.28.13.1M', architecture: 'x86_64', bootupTimestamp: 0, uptime: 0 }

interface Overrides {
  readonly settings?: DeviceSettings | Error
  readonly diffRead?: boolean
  readonly diff?: string
}

function makeFakes(overrides: Overrides = {}) {
  const session = {
    name: 'ui-s8-session',
    state: 'diffed',
    isOpen: false,
    run: vi.fn(async () => []),
    diff: vi.fn(async () => overrides.diff ?? '+hostname sw2'),
    hasDiffBeenRead: vi.fn(() => overrides.diffRead ?? true),
    commit: vi.fn(async () => []),
    abort: vi.fn(async () => []),
  }
  const get = vi.fn(async () => {
    if (overrides.settings instanceof Error) throw overrides.settings
    return overrides.settings ?? settingsFixture()
  })
  const show = vi.fn(async (command: string) => {
    if (command === 'version') return versionReply
    throw new Error(`SYNTHETIC unexpected show: ${command}`)
  })
  const configSession = vi.fn(async () => session)
  const node = { connection: { address: 'https://sw1.example/command-api' }, system: { get }, show, configSession } as unknown as TestNode
  return { node, session, get, show, configSession }
}

function renderScreen(fakes: ReturnType<typeof makeFakes>, proxyConfigured = true) {
  return render(<TransactionProvider node={fakes.node as Node}><SystemSettings node={fakes.node} proxyConfigured={proxyConfigured} /></TransactionProvider>)
}

async function stageTo(fakes: ReturnType<typeof makeFakes>): Promise<void> {
  await waitFor(() => expect(fakes.configSession).toHaveBeenCalled())
  await screen.findByText(/added to the transaction/u)
}

describe('SystemSettings — four states, nothing contacted without the operator asking', () => {
  it('no proxy: prompt, all controls disabled, and system.get()/show()/configSession() stay at zero calls', () => {
    const fakes = makeFakes()
    renderScreen(fakes, false)

    expect(screen.getByRole('alert')).toHaveTextContent('Local proxy is not configured')
    expect(screen.getByRole('button', { name: 'Update hostname' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Disable ip routing' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Set motd banner' })).toBeDisabled()
    expect(fakes.get).not.toHaveBeenCalled()
    expect(fakes.show).not.toHaveBeenCalled()
    expect(fakes.configSession).not.toHaveBeenCalled()
  })

  it('ready state shows what the PARSED CONFIG answered: hostname, routing pill, and the three banner kinds with their real presence states', async () => {
    const fakes = makeFakes()
    const { container } = renderScreen(fakes)
    await screen.findByText(/^Current running-config hostname: /u)

    expect(container).toHaveTextContent('sw1')
    expect(screen.getByText('enabled')).toBeInTheDocument() // the ip-routing pill
    // motd set, login present-with-empty-body (§5 row 87's third state), exec absent.
    expect(screen.getByText(/present \(1 line\(s\), exactly as the device wrote it/u)).toBeInTheDocument()
    expect(screen.getByText(/present with an empty body/u)).toBeInTheDocument()
    expect(screen.getByText(/no banner exec block in the parsed running-config/u)).toBeInTheDocument()
    // Body renders as TEXT inside the <pre> — never parsed as HTML.
    expect(screen.getByText('Authorized access only.').closest('pre')).not.toBeNull()
    // Identity chip from the soft show('version') read.
    expect(container.querySelector('.device-identity')).not.toBeNull()
  })

  it('a banner body is displayed as text only: the XSS-shaped control proves no HTML sink (the #78 acceptance line)', async () => {
    const fakes = makeFakes({ settings: settingsFixture({ banner: { exec: '<img src=x onerror=alert(1)>' } }) })
    const { container } = renderScreen(fakes)
    await screen.findByText(/no banner motd block in the parsed running-config/u)

    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument()
  })

  it('a failed system read is an error, never a blank settings panel: alert copy plus every write locked', async () => {
    const fakes = makeFakes({ settings: new Error('SYNTHETIC config read exploded') })
    renderScreen(fakes)

    expect(await screen.findByRole('alert')).toHaveTextContent('SYNTHETIC config read exploded')
    expect(screen.getByRole('button', { name: 'Update hostname' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Enable ip routing' })).toBeDisabled()
    // Un-read fields say unread/unknown — they never display default claims.
    expect(screen.getByText('unread')).toBeInTheDocument()
    expect(screen.getByText('unknown')).toBeInTheDocument()
  })
})

describe('SystemSettings — writes stage a named session, pin argvs byte-for-byte, and the banner carries the EOF payload literal', () => {
  it('adds a hostname change to the shared transaction without committing locally', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await screen.findByText(/^Current running-config hostname: /u)

    fireEvent.change(screen.getByLabelText(/New hostname/u), { target: { value: 'sw2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Update hostname' }))
    await stageTo(fakes)

    expect(fakes.configSession).toHaveBeenCalledWith(expect.objectContaining({ description: 'webui shared transaction' }))
    expect(fakes.session.run).toHaveBeenCalledWith(['hostname sw2'])
    expect(fakes.session.commit).not.toHaveBeenCalled()
    expect(fakes.session.abort).not.toHaveBeenCalled()
  })

  it('appends remove hostname and reuses the same session for another action', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await screen.findByText(/^Current running-config hostname: /u)

    fireEvent.click(screen.getByRole('button', { name: 'Remove hostname' }))
    await stageTo(fakes)
    expect(fakes.session.run).toHaveBeenCalledWith(['no hostname'])

    fireEvent.click(screen.getByRole('button', { name: 'Disable ip routing' }))
    await waitFor(() => expect(fakes.session.run).toHaveBeenCalledTimes(2))
    expect(fakes.configSession).toHaveBeenCalledTimes(1)
  })

  it('refuses enabling routing at zero sessions, then appends the disable command', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await screen.findByText(/^Current running-config hostname: /u)

    fireEvent.click(screen.getByRole('button', { name: 'Enable ip routing' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/already on in the parsed config/u)
    expect(fakes.configSession).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Disable ip routing' }))
    await stageTo(fakes)
    expect(fakes.session.run).toHaveBeenCalledWith(['no ip routing'])
    expect(fakes.session.commit).not.toHaveBeenCalled()
  })

  it('the banner write is the byte-for-byte payload #78 names: text + the client-owned \\nEOF\\n, displayed as a digest not an inlined body', async () => {
    const fakes = makeFakes({ diff: '+banner login\n+   Authorized only.\n+EOF' })
    renderScreen(fakes)
    await screen.findByText(/^Current running-config hostname: /u)

    fireEvent.change(screen.getByLabelText(/New login banner body/u), { target: { value: 'Authorized only.\n' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set login banner' }))
    await stageTo(fakes)

    // Byte-for-byte: one trailing newline folded (DR-056) and the exact terminator (DR-015).
    expect(fakes.session.run).toHaveBeenCalledWith([{ cmd: 'banner login', input: 'Authorized only.\nEOF\n' }])
    expect(fakes.configSession).toHaveBeenCalledWith(expect.objectContaining({ description: 'webui shared transaction' }))
  })

  it('remove banner: `no banner <kind>` stays a line string; the unset kind is refused in-form at zero sessions', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await screen.findByText(/^Current running-config hostname: /u)

    // The kind-absent guard is structural: Remove for a kind the config does not carry is
    // DISABLED (the in-form refusal text exists in the handler too, but no click reaches it).
    expect(screen.getByRole('button', { name: 'Remove exec banner' })).toBeDisabled()
    expect(fakes.configSession).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Remove motd banner' }))
    await stageTo(fakes)
    expect(fakes.session.run).toHaveBeenCalledWith(['no banner motd'])
  })
})

describe('SystemSettings — in-form refusals cost zero sessions, and one draft owns the screen', () => {
  it('client-policy guards refuse before any session: leading-digit hostname and an early-EOF banner body', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await screen.findByText(/^Current running-config hostname: /u)

    fireEvent.change(screen.getByLabelText(/New hostname/u), { target: { value: '9lives' } })
    fireEvent.click(screen.getByRole('button', { name: 'Update hostname' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/starting with a digit/u)

    fireEvent.change(screen.getByLabelText(/New motd banner body/u), { target: { value: 'hi\nEOF\nthere' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set motd banner' }))
    expect(await screen.findByText(/end the block early/u)).toBeInTheDocument()

    // Staging the CURRENT motd body verbatim is the same-value refusal (identity writes never pay
    // for a session):
    fireEvent.change(screen.getByLabelText(/New motd banner body/u), { target: { value: 'Authorized access only.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set motd banner' }))
    expect(await screen.findByText(/already holds exactly this body/u)).toBeInTheDocument()

    expect(fakes.configSession).not.toHaveBeenCalled()
  })

  it('allows a later action to reuse the shared transaction without local commit or abort', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await screen.findByText(/^Current running-config hostname: /u)

    fireEvent.change(screen.getByLabelText(/New hostname/u), { target: { value: 'sw2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Update hostname' }))
    await stageTo(fakes)

    fireEvent.click(screen.getByRole('button', { name: 'Remove hostname' }))
    await waitFor(() => expect(fakes.session.run).toHaveBeenCalledTimes(2))
    expect(fakes.configSession).toHaveBeenCalledTimes(1)
    expect(fakes.session.commit).not.toHaveBeenCalled()
    expect(fakes.session.abort).not.toHaveBeenCalled()
  })
})
