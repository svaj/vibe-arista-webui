/**
 * The ten `App.test.tsx` behaviours F6 (#68) promised to keep green, moved here with the screen and
 * changed by **rename only** — the fake-node harness (`makeClient`, the verbatim 7050TX-64
 * `show version` capture), every assertion, and every copy string are the ones #66/#64 pinned.
 * `src/App.test.tsx` now pins the composition instead (one chrome tier, one `#workspace`).
 *
 * The two `vi.spyOn(window,'confirm')` cases the issue mentions already migrated to the F4 dialog in
 * #66, which is why they drive `role="dialog"` here; nothing in this file needs a device or a proxy.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConfigSession } from '@devhax-heavy-industries/arista-eapi'

import { VlanAssignment } from './VlanAssignment'

type TestNode = NonNullable<Parameters<typeof VlanAssignment>[0]['node']>

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
    // Verbatim DCS-7050TX-64 / 4.28.13.1M `show version` capture (see src/eapi/show-contracts.test.ts).
    show: vi.fn(async () => ({
      hostname: 'sw1',
      version: '4.28.13.1M',
      systemMacAddress: '00:00:00:00:00:00',
      modelName: 'DCS-7050TX-64',
      serialNumber: '0000000000',
      internalVersion: '4.28.13.1M',
      architecture: 'x86_64',
      bootupTimestamp: 0,
      uptime: 0,
    })),
    ...overrides,
  } as unknown as TestNode
  return { node, session }
}

afterEach(() => vi.restoreAllMocks())

describe('VlanAssignment', () => {
  it('announces loading while the device reads are unresolved', () => {
    const { node } = makeClient({
      vlans: { getAll: vi.fn(() => new Promise(() => {})) },
    })
    render(<VlanAssignment node={node} />)

    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByText(/Reading VLANs/u)).toBeInTheDocument()
  })

  it('does not contact an eAPI target when the local proxy is unconfigured', async () => {
    const { node } = makeClient()
    render(<VlanAssignment node={node} proxyConfigured={false} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('EAPI_HOST')
    expect(node.vlans.getAll).not.toHaveBeenCalled()
    expect(node.listSessions).not.toHaveBeenCalled()
  })

  it('loads device state and previews a staged access VLAN change', async () => {
    const user = userEvent.setup()
    const { node, session } = makeClient()
    render(<VlanAssignment node={node} />)

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
    render(<VlanAssignment node={node} />)

    await user.click(await screen.findByRole('button', { name: 'Preview change' }))

    expect(await screen.findByText(/switchport access vlan 20/u)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Commit to running-config' })).toBeDisabled()
  })

  it('requires explicit commit confirmation and does not persist startup-config', async () => {
    const user = userEvent.setup()
    const { node, session } = makeClient()
    render(<VlanAssignment node={node} />)

    await user.click(await screen.findByRole('button', { name: 'Preview change' }))
    const commitTrigger = screen.getByRole('button', { name: 'Commit to running-config' })
    await user.click(commitTrigger)

    // #66: the prompt is an accessible native <dialog>, not the blocking window.confirm.
    const prompt = await screen.findByRole('dialog', { name: 'Commit to running-config' })
    expect(within(prompt).getByText(/This changes running-config only/u)).toBeInTheDocument()
    // The destructive copy names the session it acts on, inside the accessible tree.
    expect(within(prompt).getByText('ui-test-session')).toBeInTheDocument()
    // Enter cannot reach the commit: the dialog opens with focus on Cancel.
    expect(within(prompt).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    expect(session.commit).not.toHaveBeenCalled()

    await user.click(within(prompt).getByRole('button', { name: 'Commit to running-config' }))

    expect(session.commit).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(await screen.findByRole('status')).toHaveTextContent('Startup-config was not changed.')
  })

  it('offers confirmed recovery only for sessions marked pending', async () => {
    const user = userEvent.setup()
    const { node } = makeClient({
      listSessions: vi.fn(async () => ({ sessions: [
        { name: 'stale-pending', state: 'pending', instances: [] },
        { name: 'unknown-state', state: 'conflicted', instances: [] },
      ] })),
    })
    render(<VlanAssignment node={node} />)

    expect(await screen.findByText('unknown-state')).toBeInTheDocument()
    const abortButtons = screen.getAllByRole('button', { name: 'Abort pending session' })
    expect(abortButtons).toHaveLength(1)

    // Dismissing the prompt leaves the device untouched (#66).
    await user.click(abortButtons[0]!)
    const prompt = await screen.findByRole('dialog', { name: 'Abort pending device session' })
    expect(within(prompt).getByText('stale-pending')).toBeInTheDocument()
    expect(within(prompt).getByText(/staged changes will be discarded/u)).toBeInTheDocument()
    await user.click(within(prompt).getByRole('button', { name: 'Cancel' }))
    expect(node.abortSession).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // Dismissing hands keyboard focus back to the session row the operator was on.
    expect(abortButtons[0]).toHaveFocus()

    // Aborting requires an explicit click on the danger confirm, and then runs exactly once.
    await user.click(screen.getByRole('button', { name: 'Abort pending session' }))
    const confirmPrompt = await screen.findByRole('dialog', { name: 'Abort pending device session' })
    expect(within(confirmPrompt).getByRole('button', { name: 'Abort pending session' })).toHaveClass('is-destructive')
    await user.click(within(confirmPrompt).getByRole('button', { name: 'Abort pending session' }))

    expect(node.abortSession).toHaveBeenCalledWith('stale-pending')
    expect(node.abortSession).toHaveBeenCalledOnce()
    expect(await screen.findByRole('status')).toHaveTextContent('was aborted')
  })

  it('renders device read failures as errors, not empty results', async () => {
    const { node } = makeClient({
      vlans: { getAll: vi.fn(async () => { throw new Error('device unreachable') }) },
    })
    render(<VlanAssignment node={node} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('device unreachable')
    expect(screen.queryByText('The device returned no VLAN entries.')).not.toBeInTheDocument()
  })

  it('shows the device identity from the typed `show version` reply', async () => {
    render(<VlanAssignment node={makeClient().node} />)

    expect(await screen.findByText('sw1 · EOS 4.28.13.1M · DCS-7050TX-64')).toBeInTheDocument()
  })

  it('a failed identity read stays soft: no error alert, no chip, workspace intact', async () => {
    const { node } = makeClient({
      show: vi.fn(async () => { throw new Error('1003 no json model') }),
    })
    render(<VlanAssignment node={node} />)

    expect(await screen.findByRole('heading', { name: 'VLAN assignment' })).toBeInTheDocument()
    expect(screen.queryByText(/DCS-7050TX-64/u)).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('renders a successful empty inventory as empty rather than as an error', async () => {
    const { node } = makeClient({
      vlans: { getAll: vi.fn(async () => new Map()) },
      switchports: { getAll: vi.fn(async () => new Map()) },
      interfaces: { getStatus: vi.fn(async () => new Map()) },
    })
    render(<VlanAssignment node={node} />)

    expect(await screen.findByText('The device returned no VLAN entries.')).toBeInTheDocument()
    expect(screen.getByText('No supported Ethernet interfaces were returned.')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
