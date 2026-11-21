/**
 * #87 (route-map slice): the route-map clause editor (`#/routing/routemaps`), offline through
 * hand-rolled fake client seams (the `VrrpManager.test.tsx` shape — no test here contacts a
 * device). The routemaps client is SEND-ONLY, so unlike the VRRP screen there are no setter spies:
 * every staged line is asserted byte-for-byte against the sequence the client's own verbs compose,
 * which `routemaps.test.ts` pins client-side (the mirroring convention, SPEC-routemap-editor.md).
 *
 * The acceptance lines SPEC-routemap-editor.md names, pinned below:
 * - create stages ONE bare header line; replace stages the exact diff batch (header per body line,
 *   removals first); description stages the clear-then-set pair with ZERO confirmations; continue
 *   stages header + one line; delete stages the `no route-map …` literal with the hard confirm;
 * - creating an existing clause, an empty replace diff, and already-said description/continue
 *   values are all refused at ZERO coordinator appends;
 * - four states: the HARD `routemaps.getAll()` failure fails the screen; an EMPTY table is a
 *   normal ready state; the SOFT `ospf.get()` failure mutes the references panel and arms the
 *   unknown copy in every confirm; the SOFT `show route-map` failure mutes only its panel;
 * - the screen itself renders NO commit/abort control (#141: Transaction Center owns them);
 * - no-proxy idles on the prompt and contacts nothing.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Node, OspfState, RoutemapEntryAttrs } from '@devhax-heavy-industries/arista-eapi'

import { TransactionProvider, useTransactionSnapshot } from '../sessions/TransactionContext'
import type { TransactionSnapshot } from '../sessions/transaction'
import { RouteMapManager } from './RouteMapManager'
import type { RoutemapClauses } from './routemap-rules'
import type { ShowRouteMapReply } from '../../eapi/show-contracts'

type TestNode = NonNullable<Parameters<typeof RouteMapManager>[0]['node']>

const attrs = (over: Partial<RoutemapEntryAttrs> = {}): RoutemapEntryAttrs => ({ match: [], set: [], ...over })

/** The one configured clause the default fixture carries — the unblock batch's own shape. */
const configuredTable = (): Map<string, RoutemapClauses> => new Map<string, RoutemapClauses>([
  ['LAB-UNBLOCK', new Map<string, Map<number, RoutemapEntryAttrs>>([
    ['permit', new Map<number, RoutemapEntryAttrs>([
      [10, attrs({ match: ['ip address prefix-list PL1'], set: ['community 65000:1'], description: 'gw' })],
    ])],
  ])],
])

const configuredOspf: OspfState = {
  ospfProcessId: 1,
  vrf: 'default',
  routerId: '10.156.0.1',
  networks: [],
  redistributions: [{ protocol: 'connected', routeMap: 'LAB-UNBLOCK' }],
  shutdown: false,
}

/** cEOS-lab `show route-map` (result half): the same map, one clause. */
const routeMapReply: ShowRouteMapReply = {
  routeMaps: {
    'LAB-UNBLOCK': {
      entries: {
        '10': { filterType: 'permit', matchRules: { prefixList: 'PL1' }, setRules: { community: '65000:1' }, subRouteMap: { name: '', invert: false }, description: ['gw'] },
      },
    },
  },
}

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
  /** Error = the HARD read fails; Map = the configured table (default: one LAB-UNBLOCK clause). */
  readonly table?: Map<string, RoutemapClauses> | Error
  /** Error = the SOFT reference read fails (panel mutes, confirms arm the unknown copy). */
  readonly ospf?: OspfState | Error
  /** Absent key = the default OSPF state; explicit undefined = no OSPF process (normal). */
  readonly noOspf?: boolean
  /** Error = the SOFT show read fails (its panel mutes only). */
  readonly showRouteMapFails?: boolean
}

function makeFakes(overrides: Overrides = {}) {
  const getAll = vi.fn(async () => {
    if (overrides.table instanceof Error) throw overrides.table
    return overrides.table ?? configuredTable()
  })
  const ospfGet = vi.fn(async () => {
    if (overrides.ospf instanceof Error) throw overrides.ospf
    if (overrides.noOspf === true) return undefined
    return overrides.ospf ?? configuredOspf
  })
  const show = vi.fn(async (command: string) => {
    if (command === 'version') return versionBase
    if (command === 'route-map') {
      if (overrides.showRouteMapFails === true) throw new Error('SYNTHETIC show route-map refused')
      return routeMapReply
    }
    throw new Error(`SYNTHETIC unexpected show: ${command}`)
  })
  // The shared coordinator opens ONE named session on the first append; this screen never calls
  // configSession itself (the #141 boundary the last test pins on the DOM).
  const session = {
    name: 'ui-routemap-session',
    state: 'opened',
    isOpen: true,
    run: vi.fn(async () => []),
    diff: vi.fn(async () => '+route-map LAB-UNBLOCK permit 10\n+ set community 65000:1'),
    hasDiffBeenRead: vi.fn(() => true),
    commit: vi.fn(async () => []),
    abort: vi.fn(async () => []),
  }
  const configSession = vi.fn(async () => session)
  const node = {
    routemaps: { getAll },
    ospf: { get: ospfGet },
    show,
    configSession,
  } as unknown as TestNode
  return { node, getAll, ospfGet, show, configSession, session }
}

function SnapshotProbe() {
  const snapshot = useTransactionSnapshot()
  return <output data-testid="transaction-snapshot">{JSON.stringify(snapshot)}</output>
}

function renderScreen(fakes: ReturnType<typeof makeFakes>) {
  return render(
    <TransactionProvider node={fakes.node as Node}>
      <RouteMapManager node={fakes.node} proxyConfigured />
      <SnapshotProbe />
    </TransactionProvider>,
  )
}

function snapshot(): TransactionSnapshot {
  return JSON.parse(screen.getByTestId('transaction-snapshot').textContent ?? '{}') as TransactionSnapshot
}

/** Readiness probe: the configured table only lands after the HARD read resolves. */
async function readyTable(): Promise<void> {
  await screen.findByRole('table', { name: 'Configured route-map clauses' })
}

const createName = () => screen.getByLabelText('Map name (one token, no spaces)')
const createAction = () => screen.getByLabelText('Action')
const createSeqno = () => screen.getByLabelText('Sequence number (digits)')
const replaceTarget = () => screen.getByLabelText('Clause', { selector: '#rmm-replace-target' })
const replaceKeyword = () => screen.getByLabelText('Statement list')
const replaceText = () => screen.getByLabelText(/the whole list this clause should end with/u)
const descriptionTarget = () => screen.getByLabelText('Clause', { selector: '#rmm-description-target' })
const descriptionValue = () => screen.getByLabelText('New description')
const continueTarget = () => screen.getByLabelText('Clause', { selector: '#rmm-continue-target' })
const continueMode = () => screen.getByLabelText('Operation')
const continueValue = () => screen.getByLabelText('Continue value (positive integer)')
const deleteTarget = () => screen.getByLabelText('Clause to delete')

function fillCreate(over: { name?: string; action?: string; seqno?: string } = {}) {
  fireEvent.change(createName(), { target: { value: over.name ?? 'LAB-NEW' } })
  fireEvent.change(createAction(), { target: { value: over.action ?? 'permit' } })
  fireEvent.change(createSeqno(), { target: { value: over.seqno ?? '10' } })
}

describe('RouteMapManager — reads and states', () => {
  it('ready: the configured table renders every clause field and the referenced arm verbatim', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyTable()

    const table = screen.getByRole('table', { name: 'Configured route-map clauses' })
    expect(table).toHaveTextContent('LAB-UNBLOCK')
    expect(table).toHaveTextContent('permit')
    expect(table).toHaveTextContent('ip address prefix-list PL1')
    expect(table).toHaveTextContent('community 65000:1')
    expect(table).toHaveTextContent('gw')
    expect(table).toHaveTextContent('referenced (redistribute connected)')
    expect(fakes.getAll).toHaveBeenCalledTimes(1)
  })

  it('an EMPTY table is a NORMAL ready state, stated as such — create stays usable, pickers do not', async () => {
    renderScreen(makeFakes({ table: new Map() }))
    await waitFor(() => expect(screen.getByText(/No `route-map` section exists in the running-config/u)).toBeInTheDocument())
    expect(screen.queryByRole('table', { name: 'Configured route-map clauses' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stage clause create' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Stage statement replace' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Stage description' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Stage continue change' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Stage clause delete' })).toBeDisabled()
  })

  it('the HARD routemaps.getAll() failure fails the screen with its message, never a blank table', async () => {
    renderScreen(makeFakes({ table: new Error('SYNTHETIC config read exploded') }))
    expect(await screen.findByRole('alert')).toHaveTextContent('SYNTHETIC config read exploded')
    expect(screen.queryByRole('table', { name: 'Configured route-map clauses' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stage clause create' })).toBeDisabled()
  })

  it('the SOFT ospf.get() failure mutes the references panel with the named note — table and forms stay usable', async () => {
    renderScreen(makeFakes({ ospf: new Error('SYNTHETIC ospf read exploded') }))
    await readyTable()
    expect(await screen.findByText(/ospf\.get\(\)` reference read did not answer/u)).toBeInTheDocument()
    const table = screen.getByRole('table', { name: 'Configured route-map clauses' })
    expect(table).toHaveTextContent('reference check unavailable')
    expect(screen.getByRole('button', { name: 'Stage clause create' })).toBeEnabled()
  })

  it('no OSPF process (a normal undefined) reads as "no reference this UI can see", not a failure', async () => {
    renderScreen(makeFakes({ noOspf: true }))
    await readyTable()
    const table = screen.getByRole('table', { name: 'Configured route-map clauses' })
    expect(table).toHaveTextContent('no reference this UI can see')
    expect(screen.queryByText(/reference read did not answer/u)).not.toBeInTheDocument()
  })

  it('the SOFT show route-map failure mutes only its panel — the table and forms stay usable', async () => {
    renderScreen(makeFakes({ showRouteMapFails: true }))
    await readyTable()
    expect(await screen.findByText(/SYNTHETIC show route-map refused/u)).toBeInTheDocument()
    expect(screen.getByRole('table', { name: 'Configured route-map clauses' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stage clause create' })).toBeEnabled()
  })

  it('no-proxy: the prompt, and nothing contacted', () => {
    const fakes = makeFakes()
    render(
      <TransactionProvider node={undefined}>
        <RouteMapManager node={undefined} proxyConfigured={false} />
      </TransactionProvider>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('EAPI_HOST')
    expect(fakes.getAll).not.toHaveBeenCalled()
    expect(fakes.ospfGet).not.toHaveBeenCalled()
    expect(fakes.show).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Stage clause create' })).toBeDisabled()
  })
})

describe('RouteMapManager — create staging (the client create() text, byte-for-byte)', () => {
  it('stages ONE bare header line with the referenced-arm second confirm', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyTable()

    fillCreate({ name: 'LAB-NEW', action: 'permit', seqno: '10' })
    fireEvent.click(screen.getByRole('button', { name: 'Stage clause create' }))

    await waitFor(() => expect(snapshot().entries).toHaveLength(1))
    const [entry] = snapshot().entries
    expect(entry.source).toBe('/routing/routemaps')
    expect(entry.action).toBe('create route-map LAB-NEW permit 10')
    expect(entry.display).toEqual(['route-map LAB-NEW permit 10'])
    expect(entry.confirmations).toHaveLength(1)
    expect(entry.confirmations[0].title).toBe('Second confirm: route-map clause LAB-NEW permit 10')
    // LAB-NEW is a fresh name — the OSPF read names no redistribute for it: the unreferenced arm.
    expect(entry.confirmations[0].body).toMatch(/No reference this UI can see/u)
    expect(entry.risks.some((risk) => /byte-for-byte the line sequence the client/u.test(risk))).toBe(true)
  })

  it('editing an EXISTING referenced map carries the referenced arm with the container-only proxy', async () => {
    renderScreen(makeFakes())
    await readyTable()

    fillCreate({ name: 'LAB-UNBLOCK', action: 'permit', seqno: '20' })
    fireEvent.click(screen.getByRole('button', { name: 'Stage clause create' }))

    await waitFor(() => expect(snapshot().entries).toHaveLength(1))
    const [entry] = snapshot().entries
    expect(entry.confirmations[0].body).toContain('redistribute connected route-map LAB-UNBLOCK')
    expect(entry.confirmations[0].body).toMatch(/67 ms/u)
    expect(entry.confirmations[0].body).toMatch(/6170 ms/u)
    expect(entry.confirmations[0].body).toMatch(/NOT a route-map edit/u)
  })

  it('creating a clause the read ALREADY lists is refused at zero appends', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyTable()

    fillCreate({ name: 'LAB-UNBLOCK', action: 'permit', seqno: '10' })
    fireEvent.click(screen.getByRole('button', { name: 'Stage clause create' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('already exists')
    expect(snapshot().entries).toHaveLength(0)
  })

  it('an out-of-grammar name is refused in-form at zero appends (client-guard copy)', async () => {
    renderScreen(makeFakes())
    await readyTable()

    fillCreate({ name: 'LAB NEW', action: 'permit', seqno: '10' })
    fireEvent.click(screen.getByRole('button', { name: 'Stage clause create' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('carries whitespace')
    expect(snapshot().entries).toHaveLength(0)
  })
})

describe('RouteMapManager — replace staging (the client replaceStatements diff)', () => {
  it('prefills the textarea from the read and stages the exact diff batch', async () => {
    renderScreen(makeFakes())
    await readyTable()

    fireEvent.change(replaceTarget(), { target: { value: 'LAB-UNBLOCK/permit/10' } })
    fireEvent.change(replaceKeyword(), { target: { value: 'set' } })
    // Prefilled with 'community 65000:1' — replace it with the new list (one removed, one added).
    expect(replaceText()).toHaveValue('community 65000:1')
    fireEvent.change(replaceText(), { target: { value: 'community 65001:2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stage statement replace' }))

    await waitFor(() => expect(snapshot().entries).toHaveLength(1))
    const [entry] = snapshot().entries
    expect(entry.action).toBe('replace set statements on route-map LAB-UNBLOCK permit 10')
    expect(entry.display).toEqual([
      'route-map LAB-UNBLOCK permit 10',
      'no set community 65000:1',
      'route-map LAB-UNBLOCK permit 10',
      'set community 65001:2',
    ])
    expect(entry.confirmations).toHaveLength(1)
    expect(entry.confirmations[0].title).toBe('Second confirm: route-map set replace LAB-UNBLOCK permit 10')
    // The clause's map IS referenced by the default OSPF state.
    expect(entry.confirmations[0].body).toContain('redistribute connected route-map LAB-UNBLOCK')
  })

  it('a draft list equal to the current statements is refused at zero appends (the client sends nothing)', async () => {
    renderScreen(makeFakes())
    await readyTable()

    fireEvent.change(replaceTarget(), { target: { value: 'LAB-UNBLOCK/permit/10' } })
    fireEvent.change(replaceKeyword(), { target: { value: 'set' } })
    // Leave the prefilled text untouched — the diff is empty.
    fireEvent.click(screen.getByRole('button', { name: 'Stage statement replace' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('already equals')
    expect(snapshot().entries).toHaveLength(0)
  })
})

describe('RouteMapManager — description staging (the clear-then-set pair, risks only)', () => {
  it('stages the client-pinned pair with ZERO confirmations', async () => {
    renderScreen(makeFakes())
    await readyTable()

    fireEvent.change(descriptionTarget(), { target: { value: 'LAB-UNBLOCK/permit/10' } })
    fireEvent.change(descriptionValue(), { target: { value: 'new text' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stage description' }))

    await waitFor(() => expect(snapshot().entries).toHaveLength(1))
    const [entry] = snapshot().entries
    expect(entry.action).toBe('set description on route-map LAB-UNBLOCK permit 10')
    expect(entry.display).toEqual([
      'route-map LAB-UNBLOCK permit 10',
      'no description',
      'route-map LAB-UNBLOCK permit 10',
      'description new text',
    ])
    expect(entry.confirmations).toHaveLength(0)
    expect(entry.risks.length).toBeGreaterThan(0)
  })

  it('staging the description the clause ALREADY says is refused at zero appends', async () => {
    renderScreen(makeFakes())
    await readyTable()

    fireEvent.change(descriptionTarget(), { target: { value: 'LAB-UNBLOCK/permit/10' } })
    fireEvent.change(descriptionValue(), { target: { value: 'gw' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stage description' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('already says exactly that')
    expect(snapshot().entries).toHaveLength(0)
  })
})

describe('RouteMapManager — continue staging (set / clear)', () => {
  it('a continue set stages header + the one line with the second confirm', async () => {
    renderScreen(makeFakes())
    await readyTable()

    fireEvent.change(continueTarget(), { target: { value: 'LAB-UNBLOCK/permit/10' } })
    fireEvent.change(continueMode(), { target: { value: 'set' } })
    fireEvent.change(continueValue(), { target: { value: '20' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stage continue change' }))

    await waitFor(() => expect(snapshot().entries).toHaveLength(1))
    const [entry] = snapshot().entries
    expect(entry.action).toBe('set continue on route-map LAB-UNBLOCK permit 10')
    expect(entry.display).toEqual(['route-map LAB-UNBLOCK permit 10', 'continue 20'])
    expect(entry.confirmations).toHaveLength(1)
    expect(entry.confirmations[0].title).toBe('Second confirm: route-map continue set LAB-UNBLOCK permit 10')
  })

  it('clearing a continue the clause never carried is refused at zero appends', async () => {
    renderScreen(makeFakes())
    await readyTable()

    fireEvent.change(continueTarget(), { target: { value: 'LAB-UNBLOCK/permit/10' } })
    fireEvent.change(continueMode(), { target: { value: 'unset' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stage continue change' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('carries no `continue` line to clear')
    expect(snapshot().entries).toHaveLength(0)
  })
})

describe('RouteMapManager — delete staging (the client delete() literal)', () => {
  it('stages `no route-map …` with the whole-clause hard confirm', async () => {
    renderScreen(makeFakes())
    await readyTable()

    fireEvent.change(deleteTarget(), { target: { value: 'LAB-UNBLOCK/permit/10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stage clause delete' }))

    await waitFor(() => expect(snapshot().entries).toHaveLength(1))
    const [entry] = snapshot().entries
    expect(entry.action).toBe('delete route-map LAB-UNBLOCK permit 10')
    expect(entry.display).toEqual(['no route-map LAB-UNBLOCK permit 10'])
    expect(entry.confirmations).toHaveLength(1)
    expect(entry.confirmations[0].title).toBe('Second confirm: delete route-map LAB-UNBLOCK permit 10')
    expect(entry.confirmations[0].subject).toBe('no route-map LAB-UNBLOCK permit 10')
    expect(entry.confirmations[0].body).toMatch(/deletes the name/u)
  })

  it('a failed reference read arms the UNKNOWN copy in the confirm body', async () => {
    renderScreen(makeFakes({ ospf: new Error('SYNTHETIC ospf read exploded') }))
    await readyTable()

    fireEvent.change(deleteTarget(), { target: { value: 'LAB-UNBLOCK/permit/10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stage clause delete' }))

    await waitFor(() => expect(snapshot().entries).toHaveLength(1))
    expect(snapshot().entries[0].confirmations[0].body).toMatch(/Treat it as referenced/u)
  })
})

describe('RouteMapManager — the #141 boundary', () => {
  it('the screen renders NO commit/abort control anywhere', async () => {
    renderScreen(makeFakes())
    await readyTable()
    expect(screen.queryByRole('button', { name: /commit/iu })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /abort/iu })).not.toBeInTheDocument()
    expect(screen.getByText(/only stage into the shared transaction/u)).toBeInTheDocument()
  })
})
