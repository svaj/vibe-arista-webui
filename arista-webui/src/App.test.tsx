import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConfigSession } from '@devhax-heavy-industries/arista-eapi'

import { SwitchManager } from './features/SwitchManager'

type TestNode = NonNullable<Parameters<typeof SwitchManager>[0]['node']>

function makeClient(overrides: Record<string, unknown> = {}, diffRead = true) {
  const session = {
    name: 'ui-test-session',
    state: 'diffed',
    run: vi.fn(async () => []),
    diff: vi.fn(async () => '+interface Ethernet1\n+ switchport access vlan 20'),
    hasDiffBeenRead: vi.fn(() => diffRead),
    commit: vi.fn(async () => []),
    abort: vi.fn(async () => []),
  } as unknown as ConfigSession
  const node = {
    vlans: { getAll: vi.fn(async () => new Map([[10, { id: 10, name: 'USERS', state: 'active', trunkGroups: [] }], [20, { id: 20, name: 'VOICE', state: 'active', trunkGroups: [] }]])) },
    switchports: { getAll: vi.fn(async () => new Map([['Ethernet1', { interfaceName: 'Ethernet1', mode: 'access', accessVlan: 10, trunkGroups: [] }]])) },
    interfaces: { getStatus: vi.fn(async () => new Map([['Ethernet1', { name: 'Ethernet1', status: 'connected' }]])) },
    configSession: vi.fn(async () => session),
    listSessions: vi.fn(async () => ({ sessions: [] })),
    abortSession: vi.fn(async () => []),
    ...overrides,
  } as unknown as TestNode
  return { node, session }
}

afterEach(() => vi.restoreAllMocks())

describe('SwitchManager', () => {
  it('announces loading while the device reads are unresolved', () => {
    const { node } = makeClient({
      vlans: { getAll: vi.fn(() => new Promise(() => {})) },
    })
    render(<SwitchManager node={node} />)

    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByText(/Reading VLANs/u)).toBeInTheDocument()
  })

  it('does not contact an eAPI target when the local proxy is unconfigured', async () => {
    const { node } = makeClient()
    render(<SwitchManager node={node} proxyConfigured={false} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('EAPI_HOST')
    expect(node.vlans.getAll).not.toHaveBeenCalled()
    expect(node.listSessions).not.toHaveBeenCalled()
  })

  it('loads device state and previews a staged access VLAN change', async () => {
    const user = userEvent.setup()
    const { node, session } = makeClient()
    render(<SwitchManager node={node} />)

    expect(await screen.findByRole('heading', { name: 'VLAN assignment' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: 'USERS' })).toBeInTheDocument()
    expect(screen.getByLabelText('Interface')).toHaveValue('Ethernet1')
    await user.selectOptions(screen.getByLabelText('New access VLAN'), '20')
    await user.click(screen.getByRole('button', { name: 'Preview change' }))

    expect(await screen.findByText(/switchport access vlan 20/u)).toBeInTheDocument()
    expect(session.run).toHaveBeenCalledWith(['interface Ethernet1', 'switchport mode access', 'switchport access vlan 20'])
    expect(session.diff).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Commit to running-config' })).toBeEnabled()
  })

  it('keeps commit disabled until the exact displayed diff has been read', async () => {
    const user = userEvent.setup()
    const { node } = makeClient({}, false)
    render(<SwitchManager node={node} />)

    await user.click(await screen.findByRole('button', { name: 'Preview change' }))

    expect(await screen.findByText(/switchport access vlan 20/u)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Commit to running-config' })).toBeDisabled()
  })

  it('requires explicit commit confirmation and does not persist startup-config', async () => {
    const user = userEvent.setup()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { node, session } = makeClient()
    render(<SwitchManager node={node} />)

    await user.click(await screen.findByRole('button', { name: 'Preview change' }))
    await user.click(await screen.findByRole('button', { name: 'Commit to running-config' }))

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('This changes running-config only'))
    expect(session.commit).toHaveBeenCalledOnce()
    expect(await screen.findByRole('status')).toHaveTextContent('Startup-config was not changed.')
  })

  it('offers confirmed recovery only for sessions marked pending', async () => {
    const user = userEvent.setup()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { node } = makeClient({
      listSessions: vi.fn(async () => ({ sessions: [
        { name: 'stale-pending', state: 'pending', instances: [] },
        { name: 'unknown-state', state: 'conflicted', instances: [] },
      ] })),
    })
    render(<SwitchManager node={node} />)

    expect(await screen.findByText('unknown-state')).toBeInTheDocument()
    const abortButtons = screen.getAllByRole('button', { name: 'Abort pending session' })
    expect(abortButtons).toHaveLength(1)
    await user.click(abortButtons[0]!)

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('stale-pending'))
    expect(node.abortSession).toHaveBeenCalledWith('stale-pending')
    expect(await screen.findByRole('status')).toHaveTextContent('was aborted')
  })

  it('renders device read failures as errors, not empty results', async () => {
    const { node } = makeClient({
      vlans: { getAll: vi.fn(async () => { throw new Error('device unreachable') }) },
    })
    render(<SwitchManager node={node} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('device unreachable')
    expect(screen.queryByText('The device returned no VLAN entries.')).not.toBeInTheDocument()
  })

  it('renders a successful empty inventory as empty rather than as an error', async () => {
    const { node } = makeClient({
      vlans: { getAll: vi.fn(async () => new Map()) },
      switchports: { getAll: vi.fn(async () => new Map()) },
      interfaces: { getStatus: vi.fn(async () => new Map()) },
    })
    render(<SwitchManager node={node} />)

    expect(await screen.findByText('The device returned no VLAN entries.')).toBeInTheDocument()
    expect(screen.getByText('No supported Ethernet interfaces were returned.')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
