import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Node } from '@devhax-heavy-industries/arista-eapi'

import { TransactionProvider, useTransaction, useTransactionSnapshot } from './TransactionContext'

function Probe() {
  const coordinator = useTransaction()
  const snapshot = useTransactionSnapshot()
  return <>
    <span data-testid="status">{snapshot.status}</span>
    <span data-testid="count">{String(snapshot.entries.length)}</span>
    <button type="button" onClick={() => void coordinator?.append({
      source: 'test',
      action: 'hostname',
      commands: ['hostname sw2'],
      display: ['hostname sw2'],
      risks: [],
    })}>Stage</button>
  </>
}

describe('TransactionProvider', () => {
  it('exposes idle state without a node, publishes updates, and resets its in-memory coordinator on reconnect', async () => {
    const session = {
      name: 'ui-shared',
      run: vi.fn(async () => []),
      diff: vi.fn(async () => '+hostname sw2'),
      hasDiffBeenRead: vi.fn(() => true),
      commit: vi.fn(async () => []),
      abort: vi.fn(async () => []),
    }
    const node = {
      connection: { address: 'https://sw1.example/command-api' },
      configSession: vi.fn(async () => session),
    } as unknown as Node

    const view = render(<TransactionProvider node={undefined}><Probe /></TransactionProvider>)
    expect(screen.getByTestId('status')).toHaveTextContent('idle')
    expect(screen.getByTestId('count')).toHaveTextContent('0')

    view.rerender(<TransactionProvider node={node}><Probe /></TransactionProvider>)
    await act(async () => { screen.getByRole('button', { name: 'Stage' }).click() })

    expect(await screen.findByTestId('status')).toHaveTextContent('ready')
    expect(screen.getByTestId('count')).toHaveTextContent('1')
    expect(node.configSession).toHaveBeenCalledTimes(1)

    view.rerender(<TransactionProvider node={undefined}><Probe /></TransactionProvider>)
    expect(screen.getByTestId('status')).toHaveTextContent('idle')
    expect(screen.getByTestId('count')).toHaveTextContent('0')
  })
})
