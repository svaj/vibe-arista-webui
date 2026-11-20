/**
 * S10 (#80): the static-route manager screen, offline through hand-rolled fake client seams — the
 * `SystemSettings.test.tsx` shape. The seam IS `staticroute.getAll()` (a config-backed M read, scripted
 * as a `ReadonlyMap<destination, routes>` exactly like the client answers it) plus the
 * `configSession()` write path. No test here contacts a device or a proxy, and every fixture value is
 * hand-authored config-shaped data — the same values the client's own `staticroute.test.ts` reads off
 * its hand-written config text, so the pinned command strings match the client's pins rather than
 * inventing any (CAP-TESTING, DR-043: no hardware support or behaviour is claimed).
 *
 * The #80 acceptance lines this file pins:
 * - "route/no-route/tag/name command texts pinned": the `run()` argv for
 *   `ip route 11.111.11.0/24 Ethernet2 5 tag 42 name netB`,
 *   `no ip route 0.0.0.0/0 192.68.1.254 1 tag 0`,
 *   `no ip route 1.2.3.0/24 Ethernet1 10.1.1.1 20 tag 1 name test1`,
 *   `ip route 192.168.7.0/24 Null0 5 tag 99` and the tag-restating name change
 *   `ip route 1.2.3.0/24 Ethernet1 10.1.1.1 20 tag 1 name newname`;
 * - "prefix + next-hop input validated (client guards surfaced)": each mirrored refusal carries the
 *   client's own reason and costs zero sessions;
 * - "delete shows the exact route string in the confirm": the F4 body paragraph states the exact
 *   staged `no ip route …` text, and declining it leaves `commit()` never called;
 * - "four states": no-proxy (nothing contacted), loading arm, failed read (alert + every write
 *   locked), empty, ready — plus the `<pre>` pin for device text and the XSS control for device text
 *   in the table;
 * - "table scoped": the table's accessible name is its own, and the guard flags ride the rows the
 *   read produced.
 *
 * Guard (a) and (b) are both pinned: removing `0.0.0.0/0`, and removing a row whose next hop the read
 * table spells as its own default-route next hop, each need the acknowledgement and the destructive
 * commit variant; an unguarded row needs neither.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StaticRoute } from '@devhax-heavy-industries/arista-eapi'

import { StaticRoutes } from './StaticRoutes'
import { routeKey } from './static-route-rules'

type TestNode = NonNullable<Parameters<typeof StaticRoutes>[0]['node']>

/** Grouped exactly the way `StaticRouteResource.getAll()` answers it: one bucket per destination,
 *  device order preserved, `tag: 0` a value (client divergence 3). */
function routeMap(rows: readonly StaticRoute[]): Map<string, readonly StaticRoute[]> {
  const grouped = new Map<string, StaticRoute[]>()
  for (const entry of rows) {
    const bucket = grouped.get(entry.ipDest)
    if (bucket === undefined) grouped.set(entry.ipDest, [entry])
    else bucket.push(entry)
  }
  return grouped
}

const DEFAULT_ROW: StaticRoute = { ipDest: '0.0.0.0/0', nextHop: '192.68.1.254', distance: 1, tag: 0 }
const SHARED_ROW: StaticRoute = { ipDest: '10.9.0.0/16', nextHop: '192.68.1.254', distance: 20 }
const NAMED_ROW: StaticRoute = { ipDest: '1.2.3.0/24', nextHop: 'Ethernet1', nextHopIp: '1.1.1.1', distance: 1, tag: 1, routeName: 'test1' }
const SECOND_ROW: StaticRoute = { ipDest: '1.2.3.0/24', nextHop: 'Ethernet1', nextHopIp: '10.1.1.1', distance: 20, tag: 1, routeName: 'test1' }
const BLACKHOLE_ROW: StaticRoute = { ipDest: '192.168.7.0/24', nextHop: 'Null0', distance: 5 }
const ROUTES: readonly StaticRoute[] = [DEFAULT_ROW, SHARED_ROW, NAMED_ROW, SECOND_ROW, BLACKHOLE_ROW]

const versionReply = { hostname: 'sw1', version: '4.28.13.1M', systemMacAddress: '00:00:00:00:00:00', modelName: 'DCS-7050TX-64', serialNumber: '0000000000', internalVersion: '4.28.13.1M', architecture: 'x86_64', bootupTimestamp: 0, uptime: 0 }

const DIFF_TEXT = '+ip route 11.111.11.0/24 Ethernet2 5 tag 42 name netB'

interface Overrides {
  readonly routes?: readonly StaticRoute[] | Error | 'pending'
  readonly diff?: string
  readonly diffRead?: boolean
  readonly runFailure?: Error
  readonly versionFailure?: Error
}

function makeFakes(overrides: Overrides = {}) {
  const session = {
    name: 'ui-s10-session',
    state: 'diffed',
    isOpen: false,
    run: vi.fn(async (commands: readonly string[]) => {
      if (overrides.runFailure !== undefined) throw overrides.runFailure
      return commands
    }),
    diff: vi.fn(async () => overrides.diff ?? DIFF_TEXT),
    hasDiffBeenRead: vi.fn(() => overrides.diffRead ?? true),
    commit: vi.fn(async () => []),
    abort: vi.fn(async () => []),
  }
  const getAll = vi.fn(async () => {
    const answer = overrides.routes
    if (answer instanceof Error) throw answer
    if (answer === 'pending') return await new Promise<Map<string, readonly StaticRoute[]>>(() => undefined)
    return routeMap(answer ?? ROUTES)
  })
  const show = vi.fn(async (command: string) => {
    if (command !== 'version') throw new Error(`SYNTHETIC unexpected show: ${command}`)
    if (overrides.versionFailure !== undefined) throw overrides.versionFailure
    return versionReply
  })
  const configSession = vi.fn(async () => session)
  const node = { staticroute: { getAll }, show, configSession } as unknown as TestNode
  return { node, session, getAll, show, configSession }
}

function renderScreen(fakes: ReturnType<typeof makeFakes>) {
  return render(<StaticRoutes node={fakes.node} proxyConfigured />)
}

/** Wait for the read to answer. */
async function ready(): Promise<void> {
  await screen.findByRole('table', { name: 'Static routes read from running-config' })
}

async function chooseAction(action: string): Promise<void> {
  await userEvent.selectOptions(screen.getByLabelText('Action'), action)
}

async function chooseRoute(row: StaticRoute): Promise<void> {
  await userEvent.selectOptions(screen.getByLabelText('Route from the read table'), routeKey(row))
}

function fill(fields: { prefix?: string, nextHop?: string, distance?: string, tag?: string, routeName?: string }): void {
  if (fields.prefix !== undefined) fireEvent.change(screen.getByLabelText('Destination prefix (A.B.C.D/E)'), { target: { value: fields.prefix } })
  if (fields.nextHop !== undefined) fireEvent.change(screen.getByLabelText('Next hop on this switch'), { target: { value: fields.nextHop } })
  if (fields.distance !== undefined) fireEvent.change(screen.getByLabelText('Distance (required here)'), { target: { value: fields.distance } })
  if (fields.tag !== undefined) fireEvent.change(screen.getByLabelText('Route tag (optional)'), { target: { value: fields.tag } })
  if (fields.routeName !== undefined) fireEvent.change(screen.getByLabelText('Route name (optional)'), { target: { value: fields.routeName } })
}

async function staged(): Promise<void> {
  await screen.findByText(/Static-route change added to the transaction/u)
}

afterEach(() => vi.restoreAllMocks())

describe('StaticRoutes — the four states, and nothing contacted unasked', () => {
  it('no proxy: prompt, every write locked, and getAll()/show()/configSession() stay at zero calls', () => {
    const fakes = makeFakes()
    render(<StaticRoutes node={fakes.node} proxyConfigured={false} />)

    expect(screen.getByRole('alert')).toHaveTextContent('Local proxy is not configured')
    expect(screen.getByRole('button', { name: 'Add to transaction' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Reload static routes' })).toBeDisabled()
    expect(fakes.getAll).not.toHaveBeenCalled()
    expect(fakes.show).not.toHaveBeenCalled()
    expect(fakes.configSession).not.toHaveBeenCalled()
  })

  it('loading: the read is announced, the table region says unread rather than empty', () => {
    const fakes = makeFakes({ routes: 'pending' })
    render(<StaticRoutes node={fakes.node} proxyConfigured />)

    expect(screen.getByText(/the static-route table is parsed config/u)).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByText(/No read has answered yet/u)).toBeInTheDocument()
    expect(screen.getByText('unread')).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
    expect(fakes.configSession).not.toHaveBeenCalled()
  })

  it('a failed read is an alert carrying the device\u2019s own text, never a blank table: every write stays locked', async () => {
    const fakes = makeFakes({ routes: new Error('eAPI request failed: ECONNREFUSED 10.0.100.1') })
    renderScreen(fakes)

    expect(await screen.findByRole('alert')).toHaveTextContent('ECONNREFUSED 10.0.100.1')
    expect(screen.getByText('The table is unread — the read failure is above, and nothing below is inferred from it.')).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.getByRole('button', { name: 'Add to transaction' })).toBeDisabled()
    expect(fakes.configSession).not.toHaveBeenCalled()
  })

  it('an empty read is an empty state naming the reader\u2019s blind spots, and an add is still offered', async () => {
    const fakes = makeFakes({ routes: [] })
    renderScreen(fakes)
    await screen.findByText(/no ip route lines this client can read/u)

    expect(screen.getByText(/A route the client cannot read back is also a route it will not write/u)).toBeInTheDocument()
    expect(screen.getAllByText(/none this client can read/u).length).toBeGreaterThan(0)
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.getByText('00')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add to transaction' })).toBeEnabled()
    // A selection-based action with no rows is refused by the disabled select plus its own note.
    await chooseAction('remove-route')
    expect(screen.getByRole('combobox', { name: 'Route from the read table' })).toBeDisabled()
    expect(screen.getByText(/The select is empty because the read answered no readable routes/u)).toBeInTheDocument()
    expect(fakes.configSession).not.toHaveBeenCalled()
  })

  it('ready: a scoped, headed table with every segment and both guard flags drawn from the read rows', async () => {
    renderScreen(makeFakes())
    const table = await screen.findByRole('table', { name: 'Static routes read from running-config' })

    for (const header of ['Destination', 'Next hop', 'Next-hop address', 'Distance', 'Tag', 'Name']) {
      expect(within(table).getByRole('columnheader', { name: header })).toBeInTheDocument()
    }
    expect(within(table).getAllByRole('row')).toHaveLength(6) // header + 5 read rows
    expect(screen.getByText('05')).toBeInTheDocument()
    expect(within(table).getByText('10.1.1.1')).toBeInTheDocument()
    expect(within(table).getAllByText('test1')).toHaveLength(2)
    expect(within(table).getByText('0')).toBeInTheDocument() // `tag 0` is a value, not absence
    expect(within(table).getByText('default route')).toBeInTheDocument()
    expect(within(table).getByText("shares the default route's next hop")).toBeInTheDocument()
    // Config truth, not RIB truth — the scope note is printed, not hidden in a header.
    expect(screen.getByText(/not the active RIB/u)).toBeInTheDocument()
    // Identity chip from the soft show('version') read.
    expect(document.querySelector('.device-identity')).not.toBeNull()
  })

  it('Reload asks the device again and still opens no session', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await screen.findByRole('table', { name: 'Static routes read from running-config' })
    expect(fakes.getAll).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Reload static routes' }))
    await waitFor(() => expect(fakes.getAll).toHaveBeenCalledTimes(2))
    await screen.findByRole('table', { name: 'Static routes read from running-config' })
    expect(fakes.configSession).not.toHaveBeenCalled()
  })

  it('device text never reaches an HTML sink: the name cell is text, and a route name that looks like markup does not parse', async () => {
    const evil: StaticRoute = { ipDest: '10.7.7.0/24', nextHop: 'Ethernet4', distance: 5, routeName: '<img src=x onerror=alert(1)>' }
    const { container } = renderScreen(makeFakes({ routes: [evil] }))
    await ready()

    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument()
  })

  it('a failed show(version) soft-folds: the identity chip disappears, the table and its claims survive, and no alert is raised for it', async () => {
    renderScreen(makeFakes({ versionFailure: new Error('SYNTHETIC no such command') }))
    await ready()

    expect(document.querySelector('.device-identity')).toBeNull()
    expect(screen.getByRole('table', { name: 'Static routes read from running-config' })).toBeInTheDocument()
    expect(screen.queryByText(/no such command/u)).toBeNull()
  })
})

describe('StaticRoutes — exact shared-transaction batches', () => {
  it('adds the client\u2019s fixed segment order to the shared transaction', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await ready()

    fill({ prefix: '11.111.11.0/24', nextHop: 'Ethernet2', distance: '5', tag: '42', routeName: 'netB' })
    fireEvent.click(screen.getByRole('button', { name: 'Add to transaction' }))
    await staged()

    expect(fakes.configSession).toHaveBeenCalledWith(expect.objectContaining({ description: 'webui shared transaction' }))
    expect(fakes.session.run).toHaveBeenCalledTimes(1)
    expect(fakes.session.run).toHaveBeenCalledWith(['ip route 11.111.11.0/24 Ethernet2 5 tag 42 name netB'])
    expect(fakes.session.diff).toHaveBeenCalledTimes(1)
    expect(fakes.session.commit).not.toHaveBeenCalled()
    expect(fakes.session.abort).not.toHaveBeenCalled()
  })

  it('removes with the exact-match negation of the whole read line', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await ready()

    await chooseAction('remove-route')
    await chooseRoute(SECOND_ROW)
    expect(screen.queryByRole('checkbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Add to transaction' }))
    await staged()

    expect(fakes.session.run).toHaveBeenCalledWith(['no ip route 1.2.3.0/24 Ethernet1 10.1.1.1 20 tag 1 name test1'])
    expect(fakes.session.run.mock.calls[0]?.[0]).toHaveLength(1)
    expect(screen.getByText(/default ip route/u)).toBeInTheDocument()
    expect(fakes.session.run.mock.calls[0]?.[0]?.every((line) => line.startsWith('no ip route '))).toBe(true)
    expect(fakes.session.commit).not.toHaveBeenCalled()
    expect(fakes.session.abort).not.toHaveBeenCalled()
  })

  it('reuses one config session for whole-line tag and name replacements', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await ready()

    await chooseAction('set-tag')
    await chooseRoute(BLACKHOLE_ROW)
    fill({ tag: '99' })
    fireEvent.click(screen.getByRole('button', { name: 'Add to transaction' }))
    await waitFor(() => expect(fakes.session.run).toHaveBeenCalledTimes(1))
    expect(fakes.session.run).toHaveBeenNthCalledWith(1, ['ip route 192.168.7.0/24 Null0 5 tag 99'])

    await chooseAction('set-name')
    await chooseRoute(SECOND_ROW)
    fill({ routeName: 'newname' })
    fireEvent.click(screen.getByRole('button', { name: 'Add to transaction' }))
    await waitFor(() => expect(fakes.session.run).toHaveBeenCalledTimes(2))

    expect(fakes.configSession).toHaveBeenCalledTimes(1)
    expect(fakes.session.run).toHaveBeenNthCalledWith(2, ['ip route 1.2.3.0/24 Ethernet1 10.1.1.1 20 tag 1 name newname'])
    expect(fakes.session.commit).not.toHaveBeenCalled()
    expect(fakes.session.abort).not.toHaveBeenCalled()
  })

  it('a device refusal mid-stage renders the device\u2019s own sentence and never claims success', async () => {
    const fakes = makeFakes({
      runFailure: new Error("CLI command 3 of 3 'ip route 1.2.3.0/24 Ethernet1' failed: % Invalid input (interpreted by the device)"),
    })
    renderScreen(fakes)
    await ready()

    await chooseAction('remove-route')
    await chooseRoute(NAMED_ROW)
    fireEvent.click(screen.getByRole('button', { name: 'Add to transaction' }))

    expect(await screen.findByText(/Invalid input \(interpreted by the device\)/u)).toBeInTheDocument()
    expect(screen.queryByText(/Static-route change added to the transaction/u)).toBeNull()
    expect(fakes.session.commit).not.toHaveBeenCalled()
    expect(fakes.session.abort).not.toHaveBeenCalled()
  })
})

describe('StaticRoutes — the guard set #80 grades as hard', () => {
  it('guard (a): removing the default route needs acknowledgement before staging its exact negation', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await ready()

    await chooseAction('remove-route')
    expect(screen.getByText(/In-band guard:/u)).toBeInTheDocument()
    expect(screen.getByText(/is the default route in the table the device just answered/u)).toBeInTheDocument()
    expect(screen.getByText(/cannot promise the path survives/u)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add to transaction' })).toBeDisabled()

    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Add to transaction' }))
    await staged()

    expect(fakes.session.run).toHaveBeenCalledWith(['no ip route 0.0.0.0/0 192.68.1.254 1 tag 0'])
    expect(fakes.session.commit).not.toHaveBeenCalled()
    expect(fakes.session.abort).not.toHaveBeenCalled()
  })

  it('guard (b): a route riding the read table gateway is treated as possibly in-band', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await ready()

    await chooseAction('remove-route')
    await chooseRoute(SHARED_ROW)
    expect(screen.getByText(/is the same value this device spells behind its own/u)).toHaveTextContent('192.68.1.254')
    expect(screen.getByText(/not a claim about where eAPI is served/u)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add to transaction' })).toBeDisabled()

    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Add to transaction' }))
    await staged()

    expect(fakes.session.run).toHaveBeenCalledWith(['no ip route 10.9.0.0/16 192.68.1.254 20'])
    expect(fakes.session.commit).not.toHaveBeenCalled()
    expect(fakes.session.abort).not.toHaveBeenCalled()
  })

  it('changing the selection or action withdraws an acknowledgement, so consent cannot be reused', async () => {
    renderScreen(makeFakes())
    await ready()

    await chooseAction('remove-route')
    fireEvent.click(screen.getByRole('checkbox'))
    expect(screen.getByRole('checkbox')).toBeChecked()
    await chooseRoute(SECOND_ROW)
    expect(screen.queryByRole('checkbox')).toBeNull()
    await chooseRoute(SHARED_ROW)
    expect(screen.getByRole('checkbox')).not.toBeChecked()
  })

  it('adding a second default route is staged with its guard risk and never committed here', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await ready()

    fill({ prefix: '0.0.0.0/0', nextHop: '192.68.1.9', distance: '3' })
    fireEvent.click(screen.getByRole('button', { name: 'Add to transaction' }))
    await staged()

    expect(fakes.session.run).toHaveBeenCalledWith(['ip route 0.0.0.0/0 192.68.1.9 3'])
    expect(fakes.session.commit).not.toHaveBeenCalled()
    expect(fakes.session.abort).not.toHaveBeenCalled()
  })
})

describe('StaticRoutes — refusals are the client\u2019s, and they cost zero sessions', () => {
  it('the prefix and next-hop guards surface the client\u2019s own reasons in the form', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await ready()

    fill({ prefix: '2001:db8::/32', nextHop: 'Ethernet1', distance: '5' })
    fireEvent.click(screen.getByRole('button', { name: 'Add to transaction' }))
    expect(await screen.findByText(/IPv6 static routes are outside this module/u)).toBeInTheDocument()

    fill({ prefix: '10.0.0.0' })
    fireEvent.click(screen.getByRole('button', { name: 'Add to transaction' }))
    expect(await screen.findByText(/dotted A\.B\.C\.D\/E shape this client and pyeapi both READ back/u)).toBeInTheDocument()

    fill({ prefix: '10.0.0.0/8', nextHop: 'has space' })
    fireEvent.click(screen.getByRole('button', { name: 'Add to transaction' }))
    expect(await screen.findByText(/inner whitespace splits the line the writer sends/u)).toBeInTheDocument()

    fill({ nextHop: '2001:db8::1' })
    fireEvent.click(screen.getByRole('button', { name: 'Add to transaction' }))
    expect(await screen.findByText(/This screen refuses the IPv6-shaped next hop/u)).toBeInTheDocument()
    expect(await screen.findByText(/client's token guard would let the token ride/u)).toBeInTheDocument()

    fill({ nextHop: 'Ethernet1', distance: '' })
    fireEvent.click(screen.getByRole('button', { name: 'Add to transaction' }))
    expect(await screen.findByText(/This screen requires a distance on a new route/u)).toBeInTheDocument()

    fill({ distance: '5', tag: '9 9' })
    fireEvent.click(screen.getByRole('button', { name: 'Add to transaction' }))
    expect(await screen.findByText(/must be an unsigned integer the \\d\+ group can read back/u)).toBeInTheDocument()

    fill({ tag: '', routeName: 'two words' })
    fireEvent.click(screen.getByRole('button', { name: 'Add to transaction' }))
    expect(await screen.findByText(/the reader captures one \\S\+ token/u)).toBeInTheDocument()

    expect(fakes.configSession).not.toHaveBeenCalled()
    expect(fakes.session.run).not.toHaveBeenCalled()
  })

  it('the untouched add form is refused by the guard, not by a disabled button, at zero sessions', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await ready()

    expect(screen.getByRole('button', { name: 'Add to transaction' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Add to transaction' }))
    expect(await screen.findByText(/empty static-route destination/u)).toBeInTheDocument()
    expect(fakes.configSession).not.toHaveBeenCalled()
    expect(fakes.session.run).not.toHaveBeenCalled()
  })

  it('no-op writes are refused before a session is paid for, for all four actions', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await ready()

    fill({ prefix: '10.9.0.0/16', nextHop: '192.68.1.254', distance: '20' })
    fireEvent.click(screen.getByRole('button', { name: 'Add to transaction' }))
    expect(await screen.findByText(/is already one of the lines this read answered/u)).toBeInTheDocument()

    await chooseAction('set-tag')
    await chooseRoute(NAMED_ROW)
    fill({ tag: '1' })
    fireEvent.click(screen.getByRole('button', { name: 'Add to transaction' }))
    expect(await screen.findByText(/already carries tag 1/u)).toBeInTheDocument()

    await chooseAction('set-name')
    fill({ routeName: 'test1' })
    fireEvent.click(screen.getByRole('button', { name: 'Add to transaction' }))
    expect(await screen.findByText(/already carries name test1/u)).toBeInTheDocument()

    await chooseAction('set-tag')
    fill({ tag: '' })
    fireEvent.click(screen.getByRole('button', { name: 'Add to transaction' }))
    expect(await screen.findByText(/no verb that clears a route tag/u)).toBeInTheDocument()

    expect(fakes.configSession).not.toHaveBeenCalled()
  })

  it('the forms #80 leaves out are stated as out of scope, not silently available', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await ready()

    expect(screen.getByText(/default ip route/u)).toBeInTheDocument()
    expect(screen.getByText(/currently equivalent to/u)).toBeInTheDocument()
    expect(screen.getByText(/no tag- or name-clearing verb in/u)).toBeInTheDocument()

    await chooseAction('remove-route')
    await chooseRoute(BLACKHOLE_ROW)
    fireEvent.click(screen.getByRole('button', { name: 'Add to transaction' }))
    await staged()
    expect(fakes.session.run).toHaveBeenCalledWith(['no ip route 192.168.7.0/24 Null0 5'])
    expect(fakes.session.run.mock.calls.every((call) => call[0].every((line) => !line.startsWith('default ip route')))).toBe(true)
  })
})
