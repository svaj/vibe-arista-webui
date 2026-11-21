/**
 * #87 (VRRP slice): the VRRP editor screen (`#/routing/vrrp`), offline through hand-rolled fake
 * client seams (the `StpGlobal.test.tsx` shape — no test here contacts a device). The fake
 * setters answer with the SAME modern-family strings the client's own suite pins
 * (`vrrp.test.ts`), so a composition regression fails on the byte the client already guards.
 *
 * The acceptance lines SPEC-vrrp-editor.md names, pinned below:
 * - every staged batch is byte-for-byte `interface <name>` + the client-composed lines (create:
 *   enable line first; edit: the one field line; delete: the client-pinned `no vrrp <n>`);
 * - create and the master-moving edits carry the honest-unmeasured second confirm;
 * - creating an existing (interface, vrid) and staging an already-said value are refused at ZERO
 *   coordinator appends;
 * - four states: the HARD `vrrp.getAll()` failure fails the screen; an EMPTY table is a normal
 *   ready state; the SOFT `ipinterfaces` failure narrows the candidate list with the named note;
 *   the SOFT `show vrrp` failure mutes only the count chip;
 * - the screen itself renders NO commit/abort control (#141: Transaction Center owns them);
 * - no-proxy idles on the prompt and contacts nothing.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { IpInterface, Node, Vrrp, VrrpVridTable } from '@devhax-heavy-industries/arista-eapi'

import { TransactionProvider, useTransactionSnapshot } from '../sessions/TransactionContext'
import type { TransactionSnapshot } from '../sessions/transaction'
import { VrrpManager } from './VrrpManager'

type TestNode = NonNullable<Parameters<typeof VrrpManager>[0]['node']>

const vrrpFixture = (over: Partial<Vrrp> = {}): Vrrp => ({
  enable: true,
  description: '',
  secondaryIp: [],
  preempt: true,
  track: [],
  bfdIp: '',
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

/** The one configured group the default fixture carries — the hardware probe's own shape. */
const configuredTable = (): Map<string, VrrpVridTable> => new Map<string, VrrpVridTable>([
  ['Vlan70', new Map<number, Vrrp>([[10, vrrpFixture({ primaryIp: '10.10.70.50', priority: 150, description: 'gateway for VLAN 70' })]])],
])

const l3Table = (): Map<string, IpInterface> => new Map<string, IpInterface>([
  ['Vlan70', { name: 'Vlan70', address: '10.10.70.1/24' }],
  ['Vlan80', { name: 'Vlan80', address: '10.10.80.1/24' }],
])

interface Overrides {
  /** Error = the HARD read fails; Map = the configured table (default: one Vlan70/10 group). */
  readonly table?: Map<string, VrrpVridTable> | Error
  /** Error = the SOFT ipinterfaces read fails (candidate list narrows with the named note). */
  readonly l3?: Map<string, IpInterface> | Error
  /** Error = the SOFT show read fails (the count chip mutes only). */
  readonly showVrrpFails?: boolean
}

function makeFakes(overrides: Overrides = {}) {
  const getAll = vi.fn(async () => {
    if (overrides.table instanceof Error) throw overrides.table
    return overrides.table ?? configuredTable()
  })
  // The dry-run seam answers with the client's own pinned modern-family strings (vrrp.test.ts).
  const setEnable = vi.fn(async (_name: string, vrid: number, value: boolean) => (value ? `no vrrp ${String(vrid)} disabled` : `vrrp ${String(vrid)} disabled`))
  const setPrimaryIp = vi.fn(async (_name: string, vrid: number, options: { value?: string }) => `vrrp ${String(vrid)} ipv4 ${String(options.value)}`)
  const setPriority = vi.fn(async (_name: string, vrid: number, options: { value?: number }) => `vrrp ${String(vrid)} priority-level ${String(options.value)}`)
  const setDescription = vi.fn(async (_name: string, vrid: number, options: { value?: string }) => `vrrp ${String(vrid)} session description ${String(options.value)}`)
  const setPreempt = vi.fn(async (_name: string, vrid: number, options: { value?: boolean }) => (options.value === true ? `vrrp ${String(vrid)} preempt` : `no vrrp ${String(vrid)} preempt`))
  const setTimersAdvertise = vi.fn(async (_name: string, vrid: number, options: { value?: number }) => `vrrp ${String(vrid)} advertisement interval ${String(options.value)}`)
  const ipGetAll = vi.fn(async () => {
    if (overrides.l3 instanceof Error) throw overrides.l3
    return overrides.l3 ?? l3Table()
  })
  const show = vi.fn(async (command: string) => {
    if (command === 'version') return versionBase
    if (command === 'vrrp') {
      if (overrides.showVrrpFails === true) throw new Error('SYNTHETIC show vrrp refused')
      return { virtualRouters: [] }
    }
    throw new Error(`SYNTHETIC unexpected show: ${command}`)
  })
  // The shared coordinator opens ONE named session on the first append; this screen never calls
  // configSession itself (the #141 boundary the last test pins on the DOM).
  const session = {
    name: 'ui-vrrp-session',
    state: 'opened',
    isOpen: true,
    run: vi.fn(async () => []),
    diff: vi.fn(async () => '+interface Vlan70\n+ vrrp 10 ipv4 10.10.70.50'),
    hasDiffBeenRead: vi.fn(() => true),
    commit: vi.fn(async () => []),
    abort: vi.fn(async () => []),
  }
  const configSession = vi.fn(async () => session)
  const node = {
    vrrp: { getAll, setEnable, setPrimaryIp, setPriority, setDescription, setPreempt, setTimersAdvertise },
    ipinterfaces: { getAll: ipGetAll },
    show,
    configSession,
  } as unknown as TestNode
  return { node, getAll, setEnable, setPrimaryIp, setPriority, setDescription, setPreempt, setTimersAdvertise, ipGetAll, show, configSession, session }
}

function SnapshotProbe() {
  const snapshot = useTransactionSnapshot()
  return <output data-testid="transaction-snapshot">{JSON.stringify(snapshot)}</output>
}

function renderScreen(fakes: ReturnType<typeof makeFakes>) {
  return render(
    <TransactionProvider node={fakes.node as Node}>
      <VrrpManager node={fakes.node} proxyConfigured />
      <SnapshotProbe />
    </TransactionProvider>,
  )
}

function snapshot(): TransactionSnapshot {
  return JSON.parse(screen.getByTestId('transaction-snapshot').textContent ?? '{}') as TransactionSnapshot
}

/** Readiness probe: the configured table only lands after the HARD read resolves. */
async function readyTable(): Promise<void> {
  await screen.findByRole('table', { name: 'Configured VRRP virtual routers' })
}

const createInterface = () => screen.getByLabelText('Interface')
const createVrid = () => screen.getByLabelText('VRID (non-negative integer)')
const createIp = () => screen.getByLabelText('Primary IPv4 address')
const createPriority = () => screen.getByLabelText('Priority 1-254 (blank = no line)')
const createDescription = () => screen.getByLabelText('Description (blank = no line)')
const createPreempt = () => screen.getByLabelText('Preempt (blank = no line)')
const createStart = () => screen.getByLabelText('Start state')
const editTarget = () => screen.getByLabelText('Virtual router')
const editField = () => screen.getByLabelText('Field to change')
const editValue = () => screen.getByLabelText('New value')
const deleteTarget = () => screen.getByLabelText('Virtual router to delete')

function fillCreate(over: { iface?: string; vrid?: string; ip?: string; priority?: string; description?: string; preempt?: string; start?: string } = {}) {
  fireEvent.change(createInterface(), { target: { value: over.iface ?? 'Vlan80' } })
  fireEvent.change(createVrid(), { target: { value: over.vrid ?? '10' } })
  fireEvent.change(createIp(), { target: { value: over.ip ?? '10.10.70.50' } })
  if (over.priority !== undefined) fireEvent.change(createPriority(), { target: { value: over.priority } })
  if (over.description !== undefined) fireEvent.change(createDescription(), { target: { value: over.description } })
  if (over.preempt !== undefined) fireEvent.change(createPreempt(), { target: { value: over.preempt } })
  if (over.start !== undefined) fireEvent.change(createStart(), { target: { value: over.start } })
}

describe('VrrpManager — reads and states', () => {
  it('ready: the configured table renders every modelled field verbatim', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyTable()

    const table = screen.getByRole('table', { name: 'Configured VRRP virtual routers' })
    expect(table).toHaveTextContent('Vlan70')
    expect(table).toHaveTextContent('150')
    expect(table).toHaveTextContent('10.10.70.50')
    expect(table).toHaveTextContent('gateway for VLAN 70')
    expect(table).toHaveTextContent('enabled')
    expect(fakes.getAll).toHaveBeenCalledTimes(1)
  })

  it('an EMPTY table is a NORMAL ready state, stated as such — and the create form stays usable', async () => {
    renderScreen(makeFakes({ table: new Map() }))
    await waitFor(() => expect(screen.getByText(/No interface section carries a/u)).toBeInTheDocument())
    expect(screen.queryByRole('table', { name: 'Configured VRRP virtual routers' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stage create batch' })).toBeEnabled()
    // Edit/delete have no groups to pick, so their triggers are disabled — create is not.
    expect(screen.getByRole('button', { name: 'Stage field edit' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Stage delete' })).toBeDisabled()
  })

  it('the HARD vrrp.getAll() failure fails the screen with its message, never a blank table', async () => {
    renderScreen(makeFakes({ table: new Error('SYNTHETIC config read exploded') }))
    expect(await screen.findByRole('alert')).toHaveTextContent('SYNTHETIC config read exploded')
    expect(screen.queryByRole('table', { name: 'Configured VRRP virtual routers' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stage create batch' })).toBeDisabled()
  })

  it('the SOFT ipinterfaces failure narrows the candidate list to the table names, with the named note', async () => {
    renderScreen(makeFakes({ l3: new Error('SYNTHETIC ipinterfaces exploded') }))
    await readyTable()
    expect(await screen.findByText(/ipinterfaces.getAll\(\)` read did not answer/u)).toBeInTheDocument()
    // Candidates: only Vlan70 (the table's own name) — Vlan80 (L3-only) is absent.
    const select = createInterface() as HTMLSelectElement
    const options = [...select.querySelectorAll('option')].map((option) => option.value).filter((value) => value !== '')
    expect(options).toEqual(['Vlan70'])
  })

  it('the candidate list is the read-driven union: table names first, L3-only names after', async () => {
    renderScreen(makeFakes())
    await readyTable()
    const select = createInterface() as HTMLSelectElement
    const options = [...select.querySelectorAll('option')].map((option) => option.value).filter((value) => value !== '')
    expect(options).toEqual(['Vlan70', 'Vlan80'])
  })

  it('the SOFT show vrrp failure mutes only the count chip — the table and forms stay usable', async () => {
    renderScreen(makeFakes({ showVrrpFails: true }))
    await readyTable()
    expect(await screen.findByText(/SYNTHETIC show vrrp refused/u)).toBeInTheDocument()
    expect(screen.getByRole('table', { name: 'Configured VRRP virtual routers' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stage create batch' })).toBeEnabled()
  })

  it('no-proxy: the prompt, and nothing contacted', () => {
    const fakes = makeFakes()
    render(
      <TransactionProvider node={undefined}>
        <VrrpManager node={undefined} proxyConfigured={false} />
      </TransactionProvider>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('EAPI_HOST')
    expect(fakes.getAll).not.toHaveBeenCalled()
    expect(fakes.ipGetAll).not.toHaveBeenCalled()
    expect(fakes.show).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Stage create batch' })).toBeDisabled()
  })
})

describe('VrrpManager — create staging (client dry-run text, byte-for-byte)', () => {
  it('stages interface + enable-line-first + IP + priority + description + preempt, with the failover second confirm', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyTable()

    fillCreate({ iface: 'Vlan80', vrid: '10', ip: '10.10.70.50', priority: '150', description: 'gw', preempt: 'yes' })
    fireEvent.click(screen.getByRole('button', { name: 'Stage create batch' }))

    await waitFor(() => expect(snapshot().entries).toHaveLength(1))
    const [entry] = snapshot().entries
    expect(entry.source).toBe('/routing/vrrp')
    expect(entry.action).toBe('create vrrp 10 on Vlan80')
    expect(entry.display).toEqual([
      'interface Vlan80',
      'vrrp 10 disabled',
      'vrrp 10 ipv4 10.10.70.50',
      'vrrp 10 priority-level 150',
      'vrrp 10 session description gw',
      'vrrp 10 preempt',
    ])
    // Every field line came from the client seam with { run: false } — never sent, only composed.
    expect(fakes.setEnable).toHaveBeenCalledWith('Vlan80', 10, false, { run: false })
    expect(fakes.setPrimaryIp).toHaveBeenCalledWith('Vlan80', 10, { value: '10.10.70.50', run: false })
    expect(fakes.setPriority).toHaveBeenCalledWith('Vlan80', 10, { value: 150, run: false })
    expect(fakes.setDescription).toHaveBeenCalledWith('Vlan80', 10, { value: 'gw', run: false })
    expect(fakes.setPreempt).toHaveBeenCalledWith('Vlan80', 10, { value: true, run: false })
    // The honest-unmeasured second confirm rides the entry.
    expect(entry.confirmations).toHaveLength(1)
    expect(entry.confirmations[0].title).toBe('Second confirm: VRRP create on Vlan80 (vrid 10)')
    expect(entry.confirmations[0].body).toMatch(/NOT measured on any target/u)
    expect(entry.risks.some((risk) => /no ip routing/u.test(risk))).toBe(true)
  })

  it('the enabled start state composes the negated enable line first', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyTable()

    fillCreate({ iface: 'Vlan80', vrid: '20', ip: '10.10.80.50', start: 'enabled' })
    fireEvent.click(screen.getByRole('button', { name: 'Stage create batch' }))

    await waitFor(() => expect(snapshot().entries).toHaveLength(1))
    expect(snapshot().entries[0].display).toEqual(['interface Vlan80', 'no vrrp 20 disabled', 'vrrp 20 ipv4 10.10.80.50'])
  })

  it('creating an EXISTING (interface, vrid) is refused at zero appends', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyTable()

    fillCreate({ iface: 'Vlan70', vrid: '10', ip: '10.10.70.50' })
    fireEvent.click(screen.getByRole('button', { name: 'Stage create batch' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('already carries `vrrp 10`')
    expect(snapshot().entries).toHaveLength(0)
    expect(fakes.setEnable).not.toHaveBeenCalled()
  })

  it('an out-of-grammar priority is refused in-form at zero appends (client-guard copy)', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyTable()

    fillCreate({ iface: 'Vlan80', vrid: '10', ip: '10.10.70.50', priority: '300' })
    fireEvent.click(screen.getByRole('button', { name: 'Stage create batch' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('outside 1-254')
    expect(snapshot().entries).toHaveLength(0)
  })
})

describe('VrrpManager — edit staging (one field)', () => {
  it('a priority edit stages the ONE client-composed line with the failover confirm', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyTable()

    fireEvent.change(editTarget(), { target: { value: 'Vlan70/10' } })
    fireEvent.change(editField(), { target: { value: 'priority' } })
    fireEvent.change(editValue(), { target: { value: '200' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stage field edit' }))

    await waitFor(() => expect(snapshot().entries).toHaveLength(1))
    const [entry] = snapshot().entries
    expect(entry.action).toBe('edit vrrp 10 on Vlan70: priority')
    expect(entry.display).toEqual(['interface Vlan70', 'vrrp 10 priority-level 200'])
    expect(fakes.setPriority).toHaveBeenCalledWith('Vlan70', 10, { value: 200, run: false })
    expect(entry.confirmations).toHaveLength(1)
  })

  it('a description edit stages its line with risks but NO second confirm', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyTable()

    fireEvent.change(editTarget(), { target: { value: 'Vlan70/10' } })
    fireEvent.change(editField(), { target: { value: 'description' } })
    fireEvent.change(editValue(), { target: { value: 'new text' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stage field edit' }))

    await waitFor(() => expect(snapshot().entries).toHaveLength(1))
    expect(snapshot().entries[0].display).toEqual(['interface Vlan70', 'vrrp 10 session description new text'])
    expect(snapshot().entries[0].confirmations).toHaveLength(0)
  })

  it('staging the value the config ALREADY says is refused at zero appends', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyTable()

    fireEvent.change(editTarget(), { target: { value: 'Vlan70/10' } })
    fireEvent.change(editField(), { target: { value: 'priority' } })
    fireEvent.change(editValue(), { target: { value: '150' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stage field edit' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('already says that value')
    expect(snapshot().entries).toHaveLength(0)
    expect(fakes.setPriority).not.toHaveBeenCalled()
  })
})

describe('VrrpManager — delete staging (the client-pinned literal)', () => {
  it('stages interface + `no vrrp 10` with the whole-group hard confirm', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyTable()

    fireEvent.change(deleteTarget(), { target: { value: 'Vlan70/10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stage delete' }))

    await waitFor(() => expect(snapshot().entries).toHaveLength(1))
    const [entry] = snapshot().entries
    expect(entry.action).toBe('delete vrrp 10 on Vlan70')
    expect(entry.display).toEqual(['interface Vlan70', 'no vrrp 10'])
    expect(entry.confirmations).toHaveLength(1)
    expect(entry.confirmations[0].title).toBe('Second confirm: delete vrrp 10 on Vlan70')
    expect(entry.confirmations[0].body).toMatch(/deletes the whole group/u)
    // No setter was consulted — delete() has no dry-run arm; the line is the client-pinned literal.
    expect(fakes.setEnable).not.toHaveBeenCalled()
  })
})

describe('VrrpManager — the #141 boundary', () => {
  it('the screen renders NO commit/abort control anywhere', async () => {
    renderScreen(makeFakes())
    await readyTable()
    expect(screen.queryByRole('button', { name: /commit/iu })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /abort/iu })).not.toBeInTheDocument()
    expect(screen.getByText(/only stage into the shared transaction/u)).toBeInTheDocument()
  })
})
