import { describe, expect, it, vi } from 'vitest'

import { TransactionCoordinator } from './transaction'
import type { StageTransactionInput } from './transaction'

function input(source: string, action: string, command: string): StageTransactionInput {
  return { source, action, commands: [command], display: [command], risks: [] }
}

function makeFakes() {
  let diffRead = false
  const run = vi.fn(async () => { diffRead = false; return [] })
  const session = {
    name: 'ui-shared',
    run,
    diff: vi.fn(async () => { diffRead = true; return `diff-${String(run.mock.calls.length)}` }),
    hasDiffBeenRead: vi.fn(() => diffRead),
    commit: vi.fn(async () => []),
    abort: vi.fn(async () => []),
  }
  const node = {
    connection: { address: 'https://sw1.example/command-api' },
    configSession: vi.fn(async () => session),
  }
  return { node, session, coordinator: new TransactionCoordinator(node) }
}

describe('TransactionCoordinator', () => {
  it('opens one session lazily and appends actions in order with a fresh device diff', async () => {
    const fakes = makeFakes()

    const first = await fakes.coordinator.append(input('vlans', 'rename', 'vlan 20'))
    expect(first.status).toBe('ready')
    expect(first.diff).toBe('diff-1')

    const second = await fakes.coordinator.append(input('system', 'hostname', 'hostname sw2'))
    expect(fakes.node.configSession).toHaveBeenCalledTimes(1)
    expect(fakes.node.configSession).toHaveBeenCalledWith({ description: 'webui shared transaction' })
    expect(fakes.session.run).toHaveBeenNthCalledWith(1, ['vlan 20'])
    expect(fakes.session.run).toHaveBeenNthCalledWith(2, ['hostname sw2'])
    expect(fakes.session.diff).toHaveBeenCalledTimes(2)
    expect(second.entries.map((entry) => entry.action)).toEqual(['rename', 'hostname'])
    expect(second.diff).toBe('diff-2')
  })

  it('serializes concurrent appends so only one session and one write can be in flight', async () => {
    const fakes = makeFakes()
    await Promise.all([
      fakes.coordinator.append(input('vlans', 'one', 'vlan 10')),
      fakes.coordinator.append(input('system', 'two', 'hostname sw2')),
    ])

    expect(fakes.node.configSession).toHaveBeenCalledTimes(1)
    expect(fakes.session.run).toHaveBeenCalledTimes(2)
    expect(fakes.coordinator.getSnapshot().entries.map((entry) => entry.action)).toEqual(['one', 'two'])
  })

  it('commits only after the latest diff and clears state after confirmed success', async () => {
    const fakes = makeFakes()
    await fakes.coordinator.append(input('vlans', 'rename', 'vlan 20'))
    await fakes.coordinator.commit()

    expect(fakes.session.commit).toHaveBeenCalledTimes(1)
    expect(fakes.coordinator.getSnapshot()).toEqual({ status: 'idle', entries: [], canCommit: false })
  })

  it('marks a failed write uncertain and refuses another append until state is reconciled', async () => {
    const fakes = makeFakes()
    vi.mocked(fakes.session.run).mockRejectedValueOnce(new Error('connection dropped'))

    await expect(fakes.coordinator.append(input('vlans', 'rename', 'vlan 20'))).rejects.toThrow('connection dropped')
    expect(fakes.coordinator.getSnapshot().status).toBe('uncertain')
    await expect(fakes.coordinator.append(input('system', 'hostname', 'hostname sw2'))).rejects.toThrow(/may have partially applied/u)
    expect(fakes.node.configSession).toHaveBeenCalledTimes(1)
    expect(fakes.session.run).toHaveBeenCalledTimes(1)
  })

  it('does not claim commit success when the commit outcome is uncertain', async () => {
    const fakes = makeFakes()
    vi.mocked(fakes.session.commit).mockRejectedValueOnce(new Error('commit reply lost'))
    await fakes.coordinator.append(input('vlans', 'rename', 'vlan 20'))

    await expect(fakes.coordinator.commit()).rejects.toThrow('commit reply lost')
    expect(fakes.coordinator.getSnapshot().status).toBe('uncertain')
    expect(fakes.coordinator.getSnapshot().entries).toHaveLength(1)
  })

  it('carries entry confirmations and redacts the combined diff without changing the wire payload', async () => {
    const fakes = makeFakes()
    vi.mocked(fakes.session.diff).mockResolvedValueOnce('username bob secret sha512 hunter2')
    const command = 'username bob secret sha512 hunter2'
    const confirmation = { title: 'Second confirm: bob', body: 'Verify another admin first.', label: 'I verified another admin', subject: 'bob' }

    const snapshot = await fakes.coordinator.append({
      ...input('users', 'delete admin', command),
      confirmations: [confirmation],
      redactDiff: (text) => text.replace('hunter2', '<redacted>'),
    })

    expect(fakes.session.run).toHaveBeenCalledWith([command])
    expect(snapshot.entries[0]?.confirmations).toEqual([confirmation])
    expect(snapshot.diff).toBe('username bob secret sha512 <redacted>')
  })
})
