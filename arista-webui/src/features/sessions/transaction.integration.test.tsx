import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ConfigSession, Node } from '@devhax-heavy-industries/arista-eapi'

import { SystemSettings } from '../system/SystemSettings'
import { VlanAssignment } from '../vlans/VlanAssignment'
import { TransactionCenter } from './TransactionCenter'
import { TransactionProvider } from './TransactionContext'

function makeNode() {
  const run = vi.fn(async () => [])
  const session = {
    name: 'ui-shared-integration',
    state: 'diffed',
    run,
    diff: vi.fn(async () => `combined-${String(run.mock.calls.length)}`),
    hasDiffBeenRead: vi.fn(() => true),
    commit: vi.fn(async () => []),
    abort: vi.fn(async () => []),
  } as unknown as ConfigSession
  const configSession = vi.fn(async () => session)
  const node = {
    connection: { address: 'https://sw1.example:443/command-api' },
    configSession,
    vlans: {
      getAll: vi.fn(async () => new Map([[10, { id: 10, name: 'USERS', state: 'active', trunkGroups: [] }], [20, { id: 20, name: 'VOICE', state: 'active', trunkGroups: [] }]])),
    },
    switchports: {
      getAll: vi.fn(async () => new Map([['Ethernet1', { interfaceName: 'Ethernet1', mode: 'access', accessVlan: 10, trunkGroups: [] }]])),
    },
    interfaces: {
      getStatus: vi.fn(async () => new Map([['Ethernet1', { name: 'Ethernet1', status: 'connected' }]])),
    },
    system: {
      get: vi.fn(async () => ({ hostname: 'sw1', ipRouting: true, banner: {} })),
    },
    listSessions: vi.fn(async () => ({ sessions: [], maxOpenSessions: 5 })),
    abortSession: vi.fn(async () => []),
    recoverOrphans: vi.fn(async () => ({ aborted: [], failed: [], skipped: [], remaining: [], reported: [] })),
    verifyConfig: vi.fn(async () => ({ format: 'json', entries: [], unmatched: [], raw: [] })),
    show: vi.fn(async (command: string) => {
      if (command === 'version') return {
        hostname: 'sw1', version: '4.28.13.1M', systemMacAddress: '00:00:00:00:00:00', modelName: 'DCS-7050TX-64', serialNumber: '', internalVersion: '4.28.13.1M', architecture: 'x86_64', bootupTimestamp: 0, uptime: 0,
      }
      throw new Error(`unexpected show ${command}`)
    }),
  } as unknown as Node
  return { node, session, configSession }
}

function ScreenHarness({ node }: { readonly node: Node }) {
  const [screenName, setScreenName] = useState<'vlan' | 'system' | 'sessions'>('vlan')
  return <TransactionProvider node={node}>
    <nav aria-label="Integration screens">
      <button type="button" onClick={() => setScreenName('vlan')}>VLAN</button>
      <button type="button" onClick={() => setScreenName('system')}>System</button>
      <button type="button" onClick={() => setScreenName('sessions')}>Transactions</button>
    </nav>
    {screenName === 'vlan' && <VlanAssignment node={node} />}
    {screenName === 'system' && <SystemSettings node={node} />}
    {screenName === 'sessions' && <TransactionCenter node={node} />}
  </TransactionProvider>
}

describe('multi-screen transaction integration', () => {
  it('stages actions from two screens in one session and commits once from Transaction Center', async () => {
    const user = userEvent.setup()
    const fakes = makeNode()
    render(<ScreenHarness node={fakes.node} />)

    await user.selectOptions(await screen.findByLabelText('New access VLAN'), '20')
    await user.click(screen.getByRole('button', { name: 'Add to transaction' }))
    expect(await screen.findByText(/Change added to the transaction/u)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'System' }))
    fireEvent.change(await screen.findByLabelText(/New hostname/u), { target: { value: 'sw2' } })
    await user.click(screen.getByRole('button', { name: 'Update hostname' }))
    expect(await screen.findByText(/System change added to the transaction/u)).toBeInTheDocument()

    expect(fakes.configSession).toHaveBeenCalledTimes(1)
    expect(fakes.session.run).toHaveBeenNthCalledWith(1, ['interface Ethernet1', 'switchport mode access', 'switchport access vlan 20'])
    expect(fakes.session.run).toHaveBeenNthCalledWith(2, ['hostname sw2'])

    await user.click(screen.getByRole('button', { name: 'Transactions' }))
    expect(await screen.findByText(/2 staged action\(s\)/u)).toBeInTheDocument()
    expect(screen.getByText('assign VLAN 20 to Ethernet1')).toBeInTheDocument()
    expect(screen.getByText('hostname → sw2')).toBeInTheDocument()
    expect(screen.getByText('combined-2')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Commit transaction to running-config' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(screen.getAllByRole('button', { name: 'Commit transaction to running-config' }).at(-1)!)
    await waitFor(() => expect(fakes.session.commit).toHaveBeenCalledTimes(1))
    expect(dialog).not.toBeInTheDocument()
    expect(screen.queryByText(/2 staged action\(s\)/u)).not.toBeInTheDocument()
  })
})
