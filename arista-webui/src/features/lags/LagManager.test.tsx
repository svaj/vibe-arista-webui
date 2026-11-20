/**
 * S5 (#75): the Port-Channel / LAG manager, offline through hand-rolled fake client seams — the
 * `TrunkEditor.test.tsx` shape: the fake node answers BOTH the container's read/write seam and the F5
 * probe seam (`configSession({ noCommit: true })` + `validateChanges` rows, which the client always
 * aborts, DR-063). No test here contacts a device.
 *
 * Scenario data mirrors captured spellings where captures exist and says out loud where they don't:
 * the config side uses the cEOS-lab 4.28.14M running-config shape (`Port-Channel1` +
 * `Ethernet1/Ethernet2 channel-group 1 mode active`) plus the client fixture's LACP keyword spellings
 * (`port-channel min-links 2`, `port-channel lacp fallback individual`, `… timeout 90` —
 * hand-authored config fixtures, DR-043); the dense answer's key set is copied verbatim from the
 * committed positives (`show-port-channel-dense--hw-inventory.json`,
 * `show-port-channel-dense.json`). The LAG-mode-change flap and the delete-with-members refusal are
 * NOT captured on the unit; the screen's copy says so, and these pins assert the copy, not device truth.
 *
 * The argv pins are the heart of the file: they prove the screen stages the exact text and order the
 * client's pinned verbs compose (DR-080: per-port `interface …` pairs, all `no channel-group` removals
 * before the adds), and that a refused intent opens NO config session (zero write-session `run` calls).
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConfigSession, Interface, IpInterface, Switchport } from '@devhax-heavy-industries/arista-eapi'

import { LagManager, groupIdOf, LAG_LACP_PROBE } from './LagManager'

type TestNode = NonNullable<Parameters<typeof LagManager>[0]['node']>

interface Overrides {
  readonly interfaces?: Map<string, Interface> | Error | 'pending'
  readonly probe?: 'accepted' | 'rejected-1002' | 'failed' | 'off'
  readonly dense?: unknown | Error
  readonly show?: (command: string) => Promise<unknown>
  readonly listSessions?: () => Promise<{ sessions: readonly { name: string; state: string }[] }>
  readonly membersCheck?: (name: string) => Promise<readonly string[]>
}

const configSections = (): Map<string, Interface> => new Map([
  ['Ethernet1', { name: 'Ethernet1', kind: 'Ethernet' }],
  ['Ethernet2', { name: 'Ethernet2', kind: 'Ethernet' }],
  ['Ethernet3', { name: 'Ethernet3', kind: 'Ethernet' }],
  // Capture-confirmed split-QSFP spelling, outside this client's name grammar (DECISIONS open item 7):
  // it stays a listed candidate with the note, because the channel-group pair lines need no name guard.
  ['Ethernet49/1', { name: 'Ethernet49/1', kind: null }],
  ['Port-Channel1', { name: 'Port-Channel1', kind: 'Port-Channel', portChannel: { members: ['Ethernet1', 'Ethernet2'], lacpMode: 'active' } }],
  ['Port-Channel5', { name: 'Port-Channel5', kind: 'Port-Channel', portChannel: { members: ['Ethernet3'], lacpMode: 'on', minimumLinks: 2, lacpFallback: 'individual', lacpTimeout: 90 } }],
  ['Port-Channel7', { name: 'Port-Channel7', kind: 'Port-Channel', portChannel: { members: [] } }],
  ['Management1', { name: 'Management1', kind: 'Management' }],
])

const switchportTable = (): Map<string, Switchport> => new Map([
  ['Port-Channel1', { interfaceName: 'Port-Channel1', mode: 'trunk', trunkGroups: [] }],
  ['Ethernet1', { interfaceName: 'Ethernet1', mode: 'trunk', trunkGroups: [] }],
])

/** Verbatim key set from the committed dense positives; the values here are scenario data. */
const denseReply = () => ({
  numberOfAggregators: 2,
  numberOfChannelsInUse: 1,
  portChannels: {
    'Port-Channel1': {
      inactive: false,
      protocol: 'lacp',
      lacpMode: 'active',
      linkState: 'up',
      ports: {
        Ethernet1: { staticLag: false, lacpState: { collecting: true, distributing: true, synchronization: true, defaulted: false, timeout: false, activity: true, expired: false, aggregation: true }, intf: 'Ethernet1', suspended: false, lagMember: true, lacpMisconfig: { status: 'bundled' }, exceedsMaxWeight: false, linkDown: false },
        Ethernet2: { staticLag: false, lacpState: { collecting: false, distributing: false, synchronization: false, defaulted: true, timeout: false, activity: true, expired: false, aggregation: true }, intf: 'Ethernet2', suspended: false, lagMember: false, lacpMisconfig: { status: 'noAgg' }, exceedsMaxWeight: false, linkDown: false },
      },
    },
    'Port-Channel10': {
      inactive: false,
      protocol: 'lacp',
      lacpMode: 'active',
      linkState: 'up',
      ports: {
        Ethernet3: { staticLag: false, lacpState: { collecting: true, distributing: true, synchronization: true, defaulted: false, timeout: false, activity: true, expired: false, aggregation: true }, intf: 'Ethernet3', suspended: false, lagMember: true, lacpMisconfig: { status: 'bundled' }, exceedsMaxWeight: false, linkDown: false },
      },
    },
  },
})

const mgmtReply = (urls: readonly string[]) => ({
  urls, vrf: 'default', vrfs: ['default'], enabled: true,
  httpsServer: { running: true, configured: true, port: 443 },
  httpServer: { running: false, configured: false, port: 80 },
  localHttpServer: { running: false, configured: false, port: 8080 },
  unixSocketServer: { running: false, configured: false },
  tlsProtocol: ['1.2'], users: {}, corsOrigins: [], iframeAncestors: [], logLevel: 'none',
  dscpValue: 0, fipsEnabled: false, bytesIn: 0, bytesOut: 0, commandCount: 0, executionTime: 0, hitCount: 0, requestCount: 0,
})

const versionReply = { hostname: 'sw1', version: '4.28.13.1M', systemMacAddress: '00:00:00:00:00:00', modelName: 'DCS-7050TX-64', serialNumber: '0000000000', internalVersion: '4.28.13.1M', architecture: 'x86_64', bootupTimestamp: 0, uptime: 0 }

/** One `validateChanges` row in the shape the client's classifier consumes (S3's helper, re-declared
 *  here because the candidate TEXTS differ — the LAG probe asks its own vocabulary). */
function changesRow(command: string, verdict: 'supported' | 'unsupported', feature: string, code?: number) {
  return {
    command,
    verdict,
    ...(code === undefined ? {} : { code, codeName: 'COMMAND_INVALID', message: 'Invalid input at the port-channel keyword' }),
    batchIndex: 0,
    unavailable: verdict === 'unsupported',
    features: [feature],
  }
}

/** The rows the fake device returns for this screen's own candidates — both features' lines, plus the
 *  client's `session:`-prefixed duplicates (capabilities attribute rows by the candidate text, so any
 *  row this fake omits classifies `unknown`, and that trap is what the S3 hand-off warned about). */
function probeRows(lacpFallbackSupported: boolean) {
  const features: readonly (readonly [string, string])[] = [
    ['interface Port-Channel999', 'portChannelLacpFallback'],
    ['port-channel lacp fallback static', 'portChannelLacpFallback'],
    ['interface Port-Channel1', 'portChannelLacpTimeout'],
    ['port-channel lacp fallback timeout 90', 'portChannelLacpTimeout'],
  ]
  const rows = features.flatMap(([command, feature]) => {
    const unsupported = feature === 'portChannelLacpFallback' && command === 'port-channel lacp fallback static' && !lacpFallbackSupported
    return [
      changesRow(command, unsupported ? 'unsupported' : 'supported', feature, ...(unsupported ? [1002] : [])),
      changesRow(`session:${command}`, unsupported ? 'unsupported' : 'supported', feature, ...(unsupported ? [1002] : [])),
    ]
  })
  return rows
}

function makeFakes(overrides: Overrides = {}, diffRead = true) {
  const session = {
    name: 'ui-s5-session',
    state: 'diffed',
    isOpen: false,
    run: vi.fn(async () => []),
    diff: vi.fn(async () => '+interface Port-Channel1\n+   port-channel min-links 4'),
    hasDiffBeenRead: vi.fn(() => diffRead),
    commit: vi.fn(async () => []),
    abort: vi.fn(async () => []),
  }
  const probeSession = {
    name: 'ui-s5-probe',
    state: 'open',
    isOpen: true,
    run: vi.fn(async () => []),
    diff: vi.fn(async () => ''),
    hasDiffBeenRead: vi.fn(() => false),
    commit: vi.fn(async () => { throw new Error('a no-commit probe session must never reach commit') }),
    abort: vi.fn(async () => []),
    validateChanges: vi.fn(() => {
      if (overrides.probe === 'failed') return Promise.reject(new Error('device unreachable'))
      if (overrides.probe === 'rejected-1002') {
        return Promise.resolve({
          ok: false,
          failures: [{ cmd: 'port-channel lacp fallback static', code: 1002, message: 'Invalid input at the port-channel keyword' }],
          error: { code: 1002, message: 'SYNTHETIC 1002 COMMAND_INVALID while probing' },
          results: probeRows(false),
        })
      }
      return Promise.resolve({ ok: true, applied: [], results: probeRows(true) })
    }),
  } as unknown as ConfigSession

  const interfaces = overrides.interfaces ?? configSections()
  const node = {
    interfaces: {
      getAll: vi.fn(async () => {
        if (interfaces === 'pending') await new Promise(() => undefined)
        if (interfaces instanceof Error) throw interfaces
        return interfaces
      }),
      getMembers: vi.fn(async (name: string) => {
        if (overrides.membersCheck !== undefined) return overrides.membersCheck(name)
        return name === 'Port-Channel1' ? ['Ethernet1', 'Ethernet2'] : ['Ethernet3']
      }),
    },
    switchports: { getAll: vi.fn(async () => switchportTable()) },
    ipinterfaces: {
      getAll: vi.fn(async () => new Map<string, IpInterface>([
        ['Management1', { name: 'Management1', address: '10.0.100.99/24' }],
        // An addressed member — the in-band guard has to notice this one when it is unbundled.
        ['Ethernet2', { name: 'Ethernet2', address: '10.0.20.1/24' }],
      ])),
    },
    configSession: vi.fn(async (options?: { noCommit?: boolean }) => (options?.noCommit === true ? probeSession : session)),
    listSessions: vi.fn(overrides.listSessions ?? (async () => ({ sessions: [] }))),
    abortSession: vi.fn(async () => []),
    show: vi.fn(async (command: string) => {
      if (overrides.show !== undefined) return overrides.show(command)
      if (command === 'version') return versionReply
      if (command === 'port-channel dense') {
        if (overrides.dense instanceof Error) throw overrides.dense
        return overrides.dense ?? denseReply()
      }
      return mgmtReply(['Management1 : https://<hw-redacted>:443'])
    }),
    // The F5 probe seam (S3's shape): target handles the client's `probeCommands` drives.
    activeConfigSession: undefined,
    runCommands: vi.fn(async () => [{ result: {} }]),
    refresh: vi.fn(),
    autorefresh: true,
    connection: { address: 'https://sw1.test:443/command-api' },
    address: 'https://sw1.test:443/command-api',
  } as unknown as TestNode

  return { node, session, probe: probeSession }
}

/** Render and wait for the read batch to LAND — the heading renders while reads are in flight. */
async function ready(node: TestNode | undefined, proxyConfigured?: boolean) {
  render(<LagManager node={node} {...(proxyConfigured === undefined ? {} : { proxyConfigured })} />)
  await screen.findByRole('heading', { name: 'Port-Channel manager' })
  return screen.findByLabelText('Change')
}

async function chooseAction(action: string) {
  await userEvent.selectOptions(await screen.findByLabelText('Change'), action)
}

async function chooseLag(name: string) {
  await userEvent.selectOptions(await screen.findByLabelText('Port-Channel'), name)
}

function press(name: string) {
  fireEvent.click(screen.getByRole('button', { name }))
}

function addToTransaction() {
  press('Add to transaction')
}

const portTable = () => screen.getByRole('table', { name: 'Ethernet membership' })

afterEach(() => vi.restoreAllMocks())

describe('LagManager — reads', () => {
  it('builds the table from the config relation and the dense answer without ever sending a write', async () => {
    const { node, session } = makeFakes()
    await ready(node)

    const table = screen.getByRole('table', { name: 'Port-Channel inventory' })
    expect(within(table).getByText('Port-Channel1')).toBeInTheDocument()
    expect(within(table).getByText('Ethernet1, Ethernet2')).toBeInTheDocument()
    expect(within(table).getByText('min-links')).toBeInTheDocument()
    expect(within(table).getAllByText('Not configured').length).toBeGreaterThan(0)
    // Device bundling words live in the port table only; the LAG table's device columns stay separate.
    expect(within(portTable()).getAllByText('bundled', { exact: true }).length).toBe(2)
    expect(within(portTable()).getAllByText('unbundled', { exact: true }).length).toBe(1)
    // Port-Channel5 carries the whole LACP keyword set from the client fixture spellings.
    expect(within(table).getByText('Port-Channel5')).toBeInTheDocument()
    expect(within(table).getByText('individual')).toBeInTheDocument()
    expect(within(table).getByText('90')).toBeInTheDocument()
    expect(within(table).getByText('2')).toBeInTheDocument()
    // Dense-only bundles join the union and are labelled as such, not silently adopted as config truth.
    expect(within(table).getByText('Port-Channel10')).toBeInTheDocument()
    // TWO rows disagree by construction: Po10 (dense named it, config has no section) and Po1 (the
    // device reports Ethernet2 unbundled while the config relation still names it). The screen shows
    // the mismatch, it does not resolve it.
    expect(within(table).getAllByText(/dense answer names a different port set/u).length).toBe(2)
    expect(session.run).not.toHaveBeenCalled()
    expect(session.commit).not.toHaveBeenCalled()
  })

  it('renders port bundling ONLY as the dense answer, and says so when that read fails', async () => {
    const { node } = makeFakes({ dense: new Error('Error [1003]: unconverted command') })
    await ready(node)

    // The failure text is the soft read's own, surfaced beside the command name that failed.
    const failed = await screen.findByText(/unconverted command/u)
    expect(failed.textContent).toContain('1003')
    expect(failed.closest('p')).toHaveTextContent('show port-channel dense')
    expect(within(portTable()).getAllByText('dense did not answer').length).toBeGreaterThan(0)
    // Columns must not be silently dropped: the config-relation column is still there and unchanged.
    expect(within(portTable()).getAllByText('Port-Channel1').length).toBe(2)
  })

  it('a failed hard read is an error state with the device text, never an empty table', async () => {
    const { node } = makeFakes({ interfaces: new Error('connect ECONNREFUSED') })
    render(<LagManager node={node} />)
    await screen.findByRole('alert')

    expect(screen.getByRole('alert')).toHaveTextContent('Device state could not be read')
    expect(screen.getByRole('alert')).toHaveTextContent('ECONNREFUSED')
    expect(screen.queryByLabelText('Change')).toBeNull()
  })

  it('does not contact an eAPI target when the local proxy is unconfigured', async () => {
    render(<LagManager node={undefined} proxyConfigured={false} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('EAPI_HOST')
    // Exactly ONE alert: the disabled-read arm of `useDeviceRead` carries the same proxy text, and the
    // view deliberately does not re-render it as a "device state could not be read" duplicate.
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('heading', { name: 'Port-Channel manager' })).toBeInTheDocument()
    // No node, no reads, no staging form at all — the panel stays unrendered.
    expect(screen.queryByLabelText('Change')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add to transaction' })).toBeNull()
  })

  it('offers the live membership check as the SEPARATE verb and reports its answer per bundle', async () => {
    const { node } = makeFakes({ membersCheck: async (name) => { if (name === 'Port-Channel7') throw new Error('Error [1002]: invalid command'); return ['Ethernet1', 'Ethernet9'] } })
    await ready(node)

    press('Check membership on the device')
    const panel = await screen.findByRole('region', { name: 'Membership as the device answers it now' })
    // The panel reports the device's answer verbatim — including an extra port the config relation does
    // not name — and each read's own failure, without touching the table's config source.
    expect(within(panel).getAllByText(/device says: Ethernet1, Ethernet9/u).length).toBe(3)
    expect(within(panel).getByText(/1002/u)).toBeInTheDocument()
    expect(panel).toHaveTextContent(/all-ports/u)
  })
})

describe('LagManager — exact shared-transaction batches', () => {
  it('diffs membership into removals-then-adds and never commits or aborts here', async () => {
    const { node, session } = makeFakes()
    await ready(node)
    fireEvent.click(screen.getByRole('checkbox', { name: /Ethernet2configured here/u }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Ethernet3currently in Port-Channel5/u }))
    addToTransaction()

    await vi.waitFor(() => expect(session.run).toHaveBeenCalledTimes(1))
    expect(session.run).toHaveBeenCalledWith(['interface Ethernet2', 'no channel-group 1', 'interface Ethernet3', 'channel-group 1 mode active'])
    expect(session.diff).toHaveBeenCalledTimes(1)
    expect(session.commit).not.toHaveBeenCalled()
    expect(session.abort).not.toHaveBeenCalled()
  })

  it('a no-change membership selection stages nothing and opens no write session', async () => {
    const { node, session } = makeFakes()
    await ready(node)
    addToTransaction()
    expect(await screen.findByRole('alert')).toHaveTextContent('no config session was opened')
    expect(session.run).not.toHaveBeenCalled()
    expect(vi.mocked(node.configSession).mock.calls.filter(([options]) => options?.noCommit !== true)).toHaveLength(0)
  })

  it('refuses a join without a readable mode, then stages the explicit mode once supplied', async () => {
    const { node, session } = makeFakes()
    await ready(node)
    await chooseLag('Port-Channel7')
    fireEvent.click(screen.getByRole('checkbox', { name: /Ethernet49\/1not a member/u }))
    addToTransaction()
    expect(await screen.findByRole('alert')).toHaveTextContent(/Joining a port needs a mode/u)
    expect(session.run).not.toHaveBeenCalled()

    await userEvent.selectOptions(screen.getByLabelText(/Mode for joining ports/u), 'active')
    addToTransaction()
    await vi.waitFor(() => expect(session.run).toHaveBeenCalledWith(['interface Ethernet49/1', 'channel-group 7 mode active']))
  })

  it('reuses one session for exact mode and keyword batches', async () => {
    const { node, session } = makeFakes()
    await ready(node)

    await chooseAction('set-lacp-mode')
    await userEvent.selectOptions(screen.getByLabelText('New mode for every current member'), 'passive')
    addToTransaction()
    await vi.waitFor(() => expect(session.run).toHaveBeenCalledTimes(1))

    await chooseAction('set-min-links')
    await userEvent.type(screen.getByLabelText('Minimum links'), '4')
    addToTransaction()
    await vi.waitFor(() => expect(session.run).toHaveBeenCalledTimes(2))

    await chooseAction('clear-min-links')
    addToTransaction()
    await vi.waitFor(() => expect(session.run).toHaveBeenCalledTimes(3))

    await chooseAction('default-min-links')
    addToTransaction()
    await vi.waitFor(() => expect(session.run).toHaveBeenCalledTimes(4))

    expect(vi.mocked(node.configSession).mock.calls.filter(([options]) => options?.noCommit !== true)).toHaveLength(1)
    expect(session.run).toHaveBeenNthCalledWith(1, [
      'interface Ethernet1', 'no channel-group 1',
      'interface Ethernet2', 'no channel-group 1',
      'interface Ethernet1', 'channel-group 1 mode passive',
      'interface Ethernet2', 'channel-group 1 mode passive',
    ])
    expect(session.run).toHaveBeenNthCalledWith(2, ['interface Port-Channel1', 'port-channel min-links 4'])
    expect(session.run).toHaveBeenNthCalledWith(3, ['interface Port-Channel1', 'no port-channel min-links'])
    expect(session.run).toHaveBeenNthCalledWith(4, ['interface Port-Channel1', 'default port-channel min-links'])
    expect(session.commit).not.toHaveBeenCalled()
    expect(session.abort).not.toHaveBeenCalled()
  })

  it('refuses a full-mode rewrite of a memberless bundle at zero sessions', async () => {
    const { node, session } = makeFakes()
    await ready(node)
    await chooseLag('Port-Channel7')
    await chooseAction('set-lacp-mode')
    await userEvent.selectOptions(screen.getByLabelText('New mode for every current member'), 'on')
    addToTransaction()

    expect(await screen.findByRole('alert')).toHaveTextContent(/nothing to re-form/u)
    expect(session.run).not.toHaveBeenCalled()
  })

  it('guards non-numeric min-links before staging the exact keyword batch', async () => {
    const { node, session } = makeFakes()
    await ready(node)
    await chooseAction('set-min-links')
    await userEvent.type(screen.getByLabelText('Minimum links'), '2.5')
    addToTransaction()
    expect(await screen.findByRole('alert')).toHaveTextContent(/whole number/u)
    expect(session.run).not.toHaveBeenCalled()

    await userEvent.clear(screen.getByLabelText('Minimum links'))
    await userEvent.type(screen.getByLabelText('Minimum links'), '4')
    addToTransaction()
    await vi.waitFor(() => expect(session.run).toHaveBeenCalledWith(['interface Port-Channel1', 'port-channel min-links 4']))
  })

  it('creates the interface and description lines in commandBuilder order', async () => {
    const { node, session } = makeFakes()
    await ready(node)
    await chooseAction('create-lag')
    await userEvent.type(screen.getByLabelText('Group number'), '1')
    addToTransaction()
    expect(await screen.findByRole('alert')).toHaveTextContent(/already exists in the running-config/u)

    await userEvent.clear(screen.getByLabelText('Group number'))
    await userEvent.type(screen.getByLabelText('Group number'), '12')
    await userEvent.type(screen.getByLabelText('Description (optional)'), 'lab bundle')
    addToTransaction()
    await vi.waitFor(() => expect(session.run).toHaveBeenCalledWith(['interface Port-Channel12', 'description lab bundle']))
  })

  it('stages the delete line verbatim without taking over its commit path', async () => {
    const { node, session } = makeFakes()
    await ready(node)
    await chooseAction('delete-lag')
    addToTransaction()

    await vi.waitFor(() => expect(session.run).toHaveBeenCalledWith(['no interface Port-Channel1']))
    expect(session.commit).not.toHaveBeenCalled()
    expect(session.abort).not.toHaveBeenCalled()
  })

  it('clears the fallback via the negation line, never a mode string', async () => {
    const { node, session } = makeFakes()
    await ready(node)
    await chooseAction('clear-lacp-fallback')
    addToTransaction()
    await vi.waitFor(() => expect(session.run).toHaveBeenCalledWith(['interface Port-Channel1', 'no port-channel lacp fallback']))
  })

  it('composes the timeout line under the same gate and refuses invalid values first', async () => {
    const { node, session } = makeFakes()
    await ready(node)
    await chooseAction('set-lacp-timeout')
    await userEvent.type(screen.getByLabelText('Fallback timeout (seconds)'), 'soon')
    addToTransaction()
    expect(await screen.findByRole('alert')).toHaveTextContent(/whole number/u)
    expect(session.run).not.toHaveBeenCalled()

    await userEvent.clear(screen.getByLabelText('Fallback timeout (seconds)'))
    await userEvent.type(screen.getByLabelText('Fallback timeout (seconds)'), '0')
    addToTransaction()
    expect(await screen.findByRole('alert')).toHaveTextContent(/positive whole number/u)

    await userEvent.clear(screen.getByLabelText('Fallback timeout (seconds)'))
    await userEvent.type(screen.getByLabelText('Fallback timeout (seconds)'), '90')
    addToTransaction()
    await vi.waitFor(() => expect(session.run).toHaveBeenCalledWith(['interface Port-Channel1', 'port-channel lacp fallback timeout 90']))
  })

  it('creates a bare bundle as exactly the interface line after refusing an existing name', async () => {
    const { node, session } = makeFakes()
    await ready(node)
    await chooseAction('create-lag')
    await userEvent.type(screen.getByLabelText('Group number'), '1')
    addToTransaction()
    expect(await screen.findByRole('alert')).toHaveTextContent(/already exists in the running-config/u)
    expect(session.run).not.toHaveBeenCalled()

    await userEvent.clear(screen.getByLabelText('Group number'))
    await userEvent.type(screen.getByLabelText('Group number'), '40')
    addToTransaction()
    await vi.waitFor(() => expect(session.run).toHaveBeenCalledWith(['interface Port-Channel40']))
  })
})

describe('LagManager — the capability gate on LACP fallback vocabulary', () => {
  it('records an available probe and opens the gated actions on the candidate answer alone', async () => {
    const { node, session } = makeFakes()
    await ready(node)
    await chooseAction('set-lacp-fallback')

    // The auto-probe (enabled with canAct, like S3) answers `available` from the scripted rows.
    const verdict = await screen.findByText('portChannelLacpFallback')
    expect(verdict.closest('li')).toHaveTextContent('available')
    expect(verdict.closest('li')).toHaveTextContent('candidates: interface Port-Channel999')
    await userEvent.selectOptions(await screen.findByLabelText('Fallback mode'), 'static')
    addToTransaction()
    await vi.waitFor(() => expect(session.run).toHaveBeenCalledWith(['interface Port-Channel1', 'port-channel lacp fallback static']))
    expect(session.commit).not.toHaveBeenCalled()
    expect(session.abort).not.toHaveBeenCalled()
  })

  it('refuses a gated action outright when the probe says the grammar is 1002-absent, and never opens a write session', async () => {
    const { node, session } = makeFakes({ probe: 'rejected-1002' })
    await ready(node)
    await chooseAction('set-lacp-fallback')

    const verdict = await screen.findByText('portChannelLacpFallback')
    expect(verdict.closest('li')).toHaveTextContent('unavailable')
    // The gate has two layers, both pinned: the input is disabled, AND `plan()` refuses the intent even
    // when reached (S3's rule — the write path refuses, not just the markup), so no gated command text
    // can reach a config session.
    expect(screen.getByLabelText('Fallback mode')).toBeDisabled()
    addToTransaction()
    expect(await screen.findByRole('alert')).toHaveTextContent(/refused before anything is staged/u)
    expect(screen.getByRole('alert')).toHaveTextContent('unavailable')
    expect(session.run).not.toHaveBeenCalled()
  })

  it('keeps gated actions shut while the probe is inconclusive: no features, no gate, no session', async () => {
    const { node, session } = makeFakes({ probe: 'failed' })
    await ready(node)
    await chooseAction('set-lacp-timeout')

    // The device never answered the probe (transport failure), so nothing may be classified: no feature
    // list renders at all, and every gated control stays shut — an inconclusive run is not evidence.
    expect(await screen.findByText(/No capability answer has been recorded for this screen yet/u)).toBeInTheDocument()
    expect(screen.getByLabelText('Fallback timeout (seconds)')).toBeDisabled()
    addToTransaction()
    expect(await screen.findByRole('alert')).toHaveTextContent(/refused before anything is staged/u)
    expect(session.run).not.toHaveBeenCalled()
  })
})

describe('LagManager — orphan cleanup', () => {
  it('lists a pending device session and aborts it only through a destructive confirm', async () => {
    const { node } = makeFakes({ listSessions: async () => ({ sessions: [{ name: 'capiVerify-77', state: 'pending' }] }) })
    await ready(node)

    expect(await screen.findByText('capiVerify-77')).toBeInTheDocument()
    press('Abort pending session')
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent(/holds the config lock/u)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Abort pending session' }))
    await screen.findByText('Pending session capiVerify-77 was aborted.')
    expect(node.abortSession).toHaveBeenCalledWith('capiVerify-77')
  })
})

describe('LagManager — helper facts pinned as data', () => {
  it('groupIdOf is the client GROUP_ID extraction, not a prefix strip', () => {
    expect(groupIdOf('Port-Channel10')).toBe('10')
    expect(groupIdOf('PortChannel01')).toBe('01')
    expect(groupIdOf('Port-Channel')).toBe('')
  })

  it('the probe map carries every composed candidate line under the feature that owns it', () => {
    // (capabilities.ts:479 attributes rows by this exact map — a line missing here silently strands
    // the verdict at `unknown`, the trap the #72 hand-off recorded for S3.)
    expect(LAG_LACP_PROBE.portChannelLacpFallback).toEqual(['interface Port-Channel999', 'port-channel lacp fallback static'])
    expect(LAG_LACP_PROBE.portChannelLacpTimeout).toEqual(['interface Port-Channel1', 'port-channel lacp fallback timeout 90'])
  })
})
