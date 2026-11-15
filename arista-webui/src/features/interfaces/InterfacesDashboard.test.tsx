/**
 * S1 (#71): the interfaces dashboard, offline through mock client seams exactly like
 * `VlanAssignment.test.tsx` (the `./testing` seam is used for the one read that proves the committed
 * capture rows normalize the way the screen assumes). No test here contacts a device.
 *
 * What the mocks are built from: the interface stanzas and status rows of the recorded cEOS-lab
 * 4.28.14M captures (`Ethernet1` access VLAN 100, `Ethernet2` `channel-group 1 mode active`,
 * `Port-Channel1` trunk with `description LAB-LACP` and `switchport trunk group LABGRP`), plus the
 * 7050TX-64 hardware capture's spellings where the screen depends on them — the split-QSFP name
 * `Ethernet49/1`, `mtu 9214` on a front-panel port, and `urls: ["Management1 : https://…"]` with the
 * host left redacted by the capture lane (F8 #70 contract d). A `Management1` IP address below is
 * illustrative test scenario data — the hardware capture redacts it — because what the test pins is
 * that the device's own `urls` answer, not an invented rule, decides the Management-path column.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeNode } from '@devhax-heavy-industries/arista-eapi/testing'
import type { ConfigSession, Interface, InterfaceStatus, IpInterface, Switchport } from '@devhax-heavy-industries/arista-eapi'

import { InterfacesDashboard, bandPathFor, managementInterfaces } from './InterfacesDashboard'
import type { InterfacesClient } from './InterfacesDashboard'
import statusRowsCapture from './fixtures/show-interfaces-status--ceos-4.28.14M.json?raw'

type TestNode = NonNullable<Parameters<typeof InterfacesDashboard>[0]['node']>

/** The verbatim cEOS `interfaceStatuses` map, as the client would answer it for `getStatus()`. */
const captureStatuses = (): Map<string, InterfaceStatus> => new Map([
  ['Ethernet1', { name: 'Ethernet1', status: 'connected', protocol: 'up', description: '' }],
  ['Ethernet2', { name: 'Ethernet2', status: 'connected', protocol: 'up', description: '' }],
  ['Port-Channel1', { name: 'Port-Channel1', status: 'notconnect', protocol: 'lowerLayerDown', description: 'LAB-LACP' }],
])

const configRows = (): Map<string, Interface> => new Map([
  ['Ethernet1', { name: 'Ethernet1', kind: 'Ethernet', description: 'to-desk-12' }],
  ['Ethernet2', { name: 'Ethernet2', kind: 'Ethernet', shutdown: false, mtu: 9214 }],
  ['Ethernet22', { name: 'Ethernet22', kind: 'Ethernet', shutdown: true, mtu: 9214 }],
  // Capture-confirmed on the unit (`show running-config`/status maps name it), refused by this
  // client's name grammar (DECISIONS open item 7) — the row must appear and be read-only.
  ['Ethernet49/1', { name: 'Ethernet49/1', kind: null }],
  ['Port-Channel1', { name: 'Port-Channel1', kind: 'Port-Channel', shutdown: false, description: 'LAB-LACP', portChannel: { members: ['Ethernet2'], lacpMode: 'active' } }],
  ['Management1', { name: 'Management1', kind: 'Management', shutdown: false }],
  ['Vlan100', { name: 'Vlan100', kind: 'Vlan', shutdown: false }],
])

const mgmtReply = (urls: readonly string[]) => ({
  urls, vrf: 'default', vrfs: ['default'], enabled: true,
  httpsServer: { running: true, configured: true, port: 443 },
  httpServer: { running: false, configured: false, port: 80 },
  localHttpServer: { running: false, configured: false, port: 8080 },
  unixSocketServer: { running: false, configured: false },
  tlsProtocol: ['1.2'], users: {}, corsOrigins: [], iframeAncestors: [], logLevel: 'none',
  dscpValue: 0, fipsEnabled: false, bytesIn: 0, bytesOut: 0, commandCount: 0, executionTime: 0, hitCount: 0, requestCount: 0,
})

function makeClient(overrides: Record<string, unknown> = {}, diffRead = true) {
  const session = {
    name: 'ui-s1-session',
    state: 'diffed',
    run: vi.fn(async () => []),
    diff: vi.fn(async () => '+interface Ethernet1\n+ description to-desk-12'),
    hasDiffBeenRead: vi.fn(() => diffRead),
    commit: vi.fn(async () => []),
    abort: vi.fn(async () => []),
  } as unknown as ConfigSession
  const node = {
    interfaces: {
      getAll: vi.fn(async () => configRows()),
      getStatus: vi.fn(async () => captureStatuses()),
    },
    switchports: {
      getAll: vi.fn(async () => new Map<string, Switchport>([
        ['Ethernet1', { interfaceName: 'Ethernet1', mode: 'access', accessVlan: 100, trunkGroups: [] }],
        ['Port-Channel1', { interfaceName: 'Port-Channel1', mode: 'trunk', trunkGroups: ['LABGRP'] }],
      ])),
    },
    ipinterfaces: {
      getAll: vi.fn(async () => new Map<string, IpInterface>([
        ['Management1', { name: 'Management1', address: '10.0.100.99/24' }],
        ['Vlan100', { name: 'Vlan100', address: '10.0.100.1/24' }],
      ])),
    },
    configSession: vi.fn(async () => session),
    listSessions: vi.fn(async () => ({ sessions: [] })),
    abortSession: vi.fn(async () => []),
    show: vi.fn(async (command: string) => command === 'version'
      // Verbatim DCS-7050TX-64 / 4.28.13.1M `show version` capture (see src/eapi/show-contracts.test.ts).
      ? { hostname: 'sw1', version: '4.28.13.1M', systemMacAddress: '00:00:00:00:00:00', modelName: 'DCS-7050TX-64', serialNumber: '0000000000', internalVersion: '4.28.13.1M', architecture: 'x86_64', bootupTimestamp: 0, uptime: 0 }
      // Hardware capture shape; the endpoint host stays the capture lane's redaction marker.
      : mgmtReply(['Management1 : https://<hw-redacted>:443'])),
    ...overrides,
  } as unknown as TestNode
  return { node, session }
}

/**
 * Render and wait for the read batch to LAND, not merely for the shell to mount: the heading renders
 * while the reads are in flight, so a test that drives the form must wait for the form itself.
 */
async function ready(node: InterfacesClient | undefined, proxyConfigured?: boolean) {
  render(<InterfacesDashboard node={node} {...(proxyConfigured === undefined ? {} : { proxyConfigured })} />)
  await screen.findByRole('heading', { name: 'Interfaces dashboard' })
  return screen.findByLabelText('Interface')
}

afterEach(() => vi.restoreAllMocks())

describe('InterfacesDashboard — reads', () => {
  it('announces loading while the device reads are unresolved', () => {
    const { node } = makeClient({ interfaces: { getAll: vi.fn(() => new Promise(() => {})), getStatus: vi.fn(async () => captureStatuses()) } })
    render(<InterfacesDashboard node={node} />)

    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByText(/Reading interfaces/u)).toBeInTheDocument()
  })

  it('does not contact an eAPI target when the local proxy is unconfigured', async () => {
    const { node } = makeClient()
    render(<InterfacesDashboard node={node} proxyConfigured={false} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('EAPI_HOST')
    expect(node.interfaces.getAll).not.toHaveBeenCalled()
    expect(node.interfaces.getStatus).not.toHaveBeenCalled()
    expect(node.ipinterfaces.getAll).not.toHaveBeenCalled()
    expect(node.listSessions).not.toHaveBeenCalled()
  })

  it('lists every configured interface with scoped headers and the capture-shaped status tokens', async () => {
    const { node } = makeClient()
    await ready(node)

    expect(screen.getByRole('table', { name: 'Interface inventory' })).toBeInTheDocument()
    for (const header of ['Interface', 'Link', 'Line protocol', 'Admin state', 'Description', 'MTU', 'Mode', 'LAG member', 'Management path']) {
      expect(screen.getByRole('columnheader', { name: header })).toBeInTheDocument()
    }
    // Device tokens verbatim, never renamed (DR-032), and text-plus-colour (WCAG 1.4.1).
    expect(screen.getByRole('cell', { name: 'notconnect' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: 'lowerLayerDown' })).toBeInTheDocument()
    // Config-side answers the status command does not carry on either target:
    expect(screen.getAllByText('9214').length).toBeGreaterThan(1)          // mtu line from running-config
    expect(screen.getByRole('cell', { name: 'down' })).toBeInTheDocument()  // Ethernet22 has the `shutdown` line
    // Absence is a third answer (DR-029): a block writing neither `shutdown` nor `no shutdown` reads
    // `Not reported`, never `up` and never `down`. Ethernet1 is that row.
    expect(screen.getAllByText('Not reported').length).toBeGreaterThanOrEqual(9)
    expect(screen.getByRole('cell', { name: 'to-desk-12' })).toBeInTheDocument()
    // DR-075's relation, inverted: the member row names its group. Two cells carry that token — the
    // `Port-Channel1` row's own name cell and `Ethernet2`'s LAG-member column. The name cell's
    // accessible name gained the #126 deep link (`Edit trunk settings for Port-Channel1`), so the
    // match anchors on the leading token instead of the whole string.
    expect(screen.getAllByRole('cell', { name: /^Port-Channel1/u })).toHaveLength(2)
    expect(node.interfaces.getAll).toHaveBeenCalledWith({ status: 'skip' })
  })

  it('renders an unreadable interface name as a listed, write-disabled row', async () => {
    const user = userEvent.setup()
    const { node } = makeClient()
    await ready(node)

    expect(screen.getByText('name this client cannot parse')).toBeInTheDocument()
    expect(screen.getByText('Ethernet49/1')).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Interface'), 'Ethernet49/1')
    expect(screen.getByText(/cannot be edited here/u)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Preview change' })).toBeDisabled()
    expect(node.configSession).not.toHaveBeenCalled()
  })

  it('a failed status read is a warning beside the config rows, never an error and never an empty table', async () => {
    const { node } = makeClient({ interfaces: { getAll: vi.fn(async () => configRows()), getStatus: vi.fn(async () => { throw new Error('1003 no json model') }) } })
    await ready(node)

    expect(await screen.findByText(/Interface status is unavailable/u)).toBeInTheDocument()
    expect(screen.getByText('1003 no json model')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('cell', { name: 'to-desk-12' })).toBeInTheDocument()
  })

  it('an empty inventory is empty, not an error, and says it does not mean the ports do not exist', async () => {
    const { node } = makeClient({
      interfaces: { getAll: vi.fn(async () => new Map<string, Interface>()), getStatus: vi.fn(async () => new Map<string, InterfaceStatus>()) },
      switchports: { getAll: vi.fn(async () => new Map<string, Switchport>()) },
      ipinterfaces: { getAll: vi.fn(async () => new Map<string, IpInterface>()) },
    })
    await ready(node)

    expect(await screen.findByText('The device returned no interfaces at all.')).toBeInTheDocument()
    expect(screen.getByText(/it does not mean the ports do not exist/u)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('a failed config read is an error with a retry, not an empty table', async () => {
    const { node } = makeClient({ interfaces: { getAll: vi.fn(async () => { throw new Error('device unreachable') }), getStatus: vi.fn(async () => captureStatuses()) } })
    render(<InterfacesDashboard node={node} />)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('device unreachable')
    expect(screen.getByRole('button', { name: 'Retry read' })).toBeInTheDocument()
  })

  it('the Management path column follows the device answer, not an invented rule', async () => {
    await ready(makeClient().node)

    expect(screen.getByText('eAPI served here')).toBeInTheDocument()          // Management1 is the captured url
    expect(screen.getByText('Carries an IP address')).toBeInTheDocument()     // Vlan100 has an address, not a url
    expect(screen.getByText('10.0.100.1/24')).toBeInTheDocument()             // the address reads beside the flag
    // Every other row (the five Ethernets and the LAG) answers the honest negative: the device named a
    // DIFFERENT interface as its listener, which is evidence, not an assumption about these ports.
    expect(screen.getAllByText('Not an eAPI path')).toHaveLength(5)
  })

  it('a failed management read reports Unknown and says what Unknown is not', async () => {
    // Both show reads fail: the identity chip is silently absent, the management column says Unknown.
    const { node } = makeClient({ show: vi.fn(async () => { throw new Error('1002 command invalid') }) })
    await ready(node)

    expect(await screen.findByText(/The management-API read failed/u)).toBeInTheDocument()
    expect(screen.getByText('1002 command invalid')).toBeInTheDocument()
    expect(screen.queryByText('eAPI served here')).not.toBeInTheDocument()
    expect(screen.getAllByText('Unknown').length).toBeGreaterThan(0)
    expect(screen.getByText(/is not a promise that a port is safe to shut down/u)).toBeInTheDocument()
  })

  it('managementInterfaces tolerates the device padding and bandPathFor answers the four cases', () => {
    expect(managementInterfaces(mgmtReply(['Vlan100     : https://10.0.100.1:443', 'Management1 : https://x:443']) as never)).toEqual(['Vlan100', 'Management1'])
    expect(managementInterfaces(undefined)).toEqual([])
    // A url this parser cannot read names nothing, which answers `unknown` rather than "safe".
    expect(managementInterfaces(mgmtReply(['nonsense-without-colon']) as never)).toEqual([])
    expect(bandPathFor('Ethernet1', undefined, ['Management1'])).toBe('not-eapi-path')
    expect(bandPathFor('Management1', '10.0.100.99/24', ['Management1'])).toBe('eapi-served')
    expect(bandPathFor('Ethernet1', '10.0.5.5/24', [])).toBe('addressed')
    expect(bandPathFor('Ethernet1', undefined, [])).toBe('unknown')
  })

  it('the committed capture rows normalize to the columns the screen reads, through the real client (CAP-TESTING)', async () => {
    const parsed = JSON.parse(statusRowsCapture) as { interfaceStatuses: Record<string, unknown> }
    expect(Object.keys(parsed.interfaceStatuses)).toEqual(['Ethernet2', 'Port-Channel1', 'Ethernet1'])

    const { node } = createFakeNode({ replies: { 'show interfaces status': { interfaceStatuses: parsed.interfaceStatuses } } })
    const statuses = await node.interfaces.getStatus()

    expect(statuses.get('Port-Channel1')).toMatchObject({ name: 'Port-Channel1', status: 'notconnect', protocol: 'lowerLayerDown', description: 'LAB-LACP' })
    expect(statuses.get('Ethernet1')?.status).toBe('connected')
    // `show interfaces status` answers no MTU column on either target — the screen must read it from config.
    expect(statuses.get('Ethernet1')?.mtu).toBeUndefined()
  })
})

describe('InterfacesDashboard — staged writes', () => {
  it('previews a description change and stages exactly the pinned command pair', async () => {
    const user = userEvent.setup()
    const { node, session } = makeClient()
    await ready(node)

    await user.selectOptions(screen.getByLabelText('Interface'), 'Ethernet2')
    await user.selectOptions(screen.getByLabelText('Change'), 'set-description')
    await user.clear(screen.getByLabelText('Description'))
    await user.type(screen.getByLabelText('Description'), 'uplink-to-dist')
    await user.click(screen.getByRole('button', { name: 'Preview change' }))

    expect(await screen.findByText(/Review the device diff/u)).toBeInTheDocument()
    expect(session.run).toHaveBeenCalledWith(['interface Ethernet2', 'description uplink-to-dist'])
    expect(session.diff).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Commit to running-config' })).toBeEnabled()
  })

  it('clears and sets MTU with the no-form and the set-form pinned separately', async () => {
    const user = userEvent.setup()
    const { node, session } = makeClient()
    await ready(node)

    await user.selectOptions(screen.getByLabelText('Interface'), 'Ethernet22')
    await user.selectOptions(screen.getByLabelText('Change'), 'set-mtu')
    await user.type(screen.getByLabelText('MTU'), '1500')
    await user.click(screen.getByRole('button', { name: 'Preview change' }))
    await screen.findByText(/Review the device diff/u)
    expect(session.run).toHaveBeenLastCalledWith(['interface Ethernet22', 'mtu 1500'])

    await user.click(screen.getByRole('button', { name: 'Abort staged changes' }))
    const abortPrompt = await screen.findByRole('dialog', { name: 'Abort staged changes' })
    await user.click(within(abortPrompt).getByRole('button', { name: 'Abort staged changes' }))

    // An abort reloads device state, so the screen passes through loading before the form returns.
    await user.selectOptions(await screen.findByLabelText('Change'), 'reset-mtu')
    await user.click(screen.getByRole('button', { name: 'Preview change' }))
    await screen.findByText(/Review the device diff/u)
    expect(session.run).toHaveBeenLastCalledWith(['interface Ethernet22', 'no mtu'])
  })

  it('stages no description and no shutdown as their own negation forms', async () => {
    const user = userEvent.setup()
    const { node, session } = makeClient()
    await ready(node)

    await user.selectOptions(screen.getByLabelText('Change'), 'clear-description')
    await user.click(screen.getByRole('button', { name: 'Preview change' }))
    await screen.findByText(/Review the device diff/u)
    expect(session.run).toHaveBeenLastCalledWith(['interface Ethernet1', 'no description'])

    await user.click(screen.getByRole('button', { name: 'Abort staged changes' }))
    const abortPrompt = await screen.findByRole('dialog', { name: 'Abort staged changes' })
    await user.click(within(abortPrompt).getByRole('button', { name: 'Abort staged changes' }))

    // Same loading pass as above: the next control is awaited, not assumed present.
    await user.selectOptions(await screen.findByLabelText('Change'), 'no-shutdown')
    await user.click(screen.getByRole('button', { name: 'Preview change' }))
    await screen.findByText(/Review the device diff/u)
    expect(session.run).toHaveBeenLastCalledWith(['interface Ethernet1', 'no shutdown'])
  })

  it('never commits before the displayed diff has been read by the device', async () => {
    const user = userEvent.setup()
    const { node } = makeClient({}, false)
    await ready(node)

    // `no shutdown` carries no value, so the form cannot be intercepted by a value refusal first.
    await user.selectOptions(screen.getByLabelText('Change'), 'no-shutdown')
    await user.click(screen.getByRole('button', { name: 'Preview change' }))
    await screen.findByText(/Review the device diff/u)
    expect(screen.getByRole('button', { name: 'Commit to running-config' })).toBeDisabled()
  })

  it('a shutdown goes through its own confirm naming the port, and cancelling writes nothing', async () => {
    const user = userEvent.setup()
    const { node, session } = makeClient()
    await ready(node)

    await user.selectOptions(screen.getByLabelText('Interface'), 'Ethernet22')
    await user.selectOptions(screen.getByLabelText('Change'), 'shutdown')
    await user.click(screen.getByRole('button', { name: 'Preview change' }))
    await screen.findByText(/Review the device diff/u)
    expect(session.run).toHaveBeenLastCalledWith(['interface Ethernet22', 'shutdown'])
    // One interface per session: the batch never spans ports.
    const staged = await screen.findAllByText('interface Ethernet22')
    expect(staged).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: 'Commit to running-config' }))
    const prompt = await screen.findByRole('dialog', { name: 'Shut down interface' })
    // The prompt names both the session and the port it will shut down (the subject element).
    expect(within(prompt).getByText('ui-s1-session · Ethernet22')).toBeInTheDocument()
    // Ethernet22 is not the eAPI interface but the guard still says what it cannot promise.
    expect(within(prompt).getByText(/dependent path/iu)).toBeInTheDocument()
    expect(within(prompt).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    await user.click(within(prompt).getByRole('button', { name: 'Cancel' }))

    expect(session.commit).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('names the management risk in the confirm when the device itself reports eAPI on that port', async () => {
    const user = userEvent.setup()
    const { node, session } = makeClient()
    await ready(node)

    await user.selectOptions(screen.getByLabelText('Interface'), 'Management1')
    await user.selectOptions(screen.getByLabelText('Change'), 'shutdown')
    await user.click(screen.getByRole('button', { name: 'Preview change' }))
    await screen.findByText(/may drop the eAPI path/u)

    await user.click(screen.getByRole('button', { name: 'Commit to running-config' }))
    const prompt = await screen.findByRole('dialog', { name: 'Shut down interface' })
    expect(within(prompt).getByText(/eAPI is served on Management1/u)).toBeInTheDocument()
    await user.click(within(prompt).getByRole('button', { name: 'Shut down Management1' }))
    expect(session.commit).toHaveBeenCalledOnce()
  })

  it('a lost commit reports the reconnect-and-refresh recovery and keeps the draft marked attempted', async () => {
    const user = userEvent.setup()
    const { node, session } = makeClient()
    await ready(node)

    vi.mocked(session.commit).mockRejectedValueOnce(new Error('socket hang up'))
    await user.selectOptions(screen.getByLabelText('Change'), 'no-shutdown')
    await user.click(screen.getByRole('button', { name: 'Preview change' }))
    await screen.findByText(/Review the device diff/u)
    await user.click(screen.getByRole('button', { name: 'Commit to running-config' }))
    const prompt = await screen.findByRole('dialog', { name: 'Commit to running-config' })
    await user.click(within(prompt).getByRole('button', { name: 'Commit to running-config' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('socket hang up')
    expect(alert).toHaveTextContent('Commit may have applied — reconnect and refresh before any further action.')
    // The recovery text appears twice on purpose: in the failure alert and in the still-open draft panel,
    // because the draft itself stays marked attempted so a second commit cannot be re-armed by accident.
    expect(screen.getAllByText(/Commit may have applied/u)).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Commit to running-config' })).toBeDisabled()
  })

  it('surfaces the client-side description refusal and opens no session to do it', async () => {
    const user = userEvent.setup()
    const { node } = makeClient()
    await ready(node)

    await user.clear(screen.getByLabelText('Description'))
    await user.type(screen.getByLabelText('Description'), 'say "hi"')
    await user.click(screen.getByRole('button', { name: 'Preview change' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/cannot read a description containing a double quote/u)
    expect(node.configSession).not.toHaveBeenCalled()
  })

  it('refuses a description that cannot be one config line, again without opening a session', async () => {
    const user = userEvent.setup()
    const { node } = makeClient()
    await ready(node)

    // Set directly rather than typing: a newline through `user.type` is a key press, not text. And the
    // value is U+2028 rather than `\n`, because an `<input>`'s value sanitization strips CR/LF — this
    // is the character class the client's own line-boundary guard (row 74 / DR-015) refuses.
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'uplink\u2028to-dist' } })
    await user.click(screen.getByRole('button', { name: 'Preview change' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/may not contain a line break or line separator/u)
    expect(node.configSession).not.toHaveBeenCalled()
  })

  it('refuses an unusable MTU with the client-policy wording instead of inventing a platform ceiling', async () => {
    const user = userEvent.setup()
    const { node } = makeClient()
    await ready(node)

    await user.selectOptions(screen.getByLabelText('Change'), 'set-mtu')
    await user.type(screen.getByLabelText('MTU'), '0')
    await user.click(screen.getByRole('button', { name: 'Preview change' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('MTU must be a positive whole number')
    expect(screen.getByText(/Client-side bound, device keeps authority/u)).toBeInTheDocument()
    expect(node.configSession).not.toHaveBeenCalled()
  })

  it('commits once and says plainly that startup-config was not touched', async () => {
    const user = userEvent.setup()
    const { node, session } = makeClient()
    await ready(node)

    await user.clear(screen.getByLabelText('Description'))
    await user.type(screen.getByLabelText('Description'), 'desk-12')
    await user.click(screen.getByRole('button', { name: 'Preview change' }))
    await screen.findByText(/Review the device diff/u)
    await user.click(screen.getByRole('button', { name: 'Commit to running-config' }))
    const prompt = await screen.findByRole('dialog', { name: 'Commit to running-config' })
    expect(within(prompt).getByText(/running-config only/u)).toBeInTheDocument()
    await user.click(within(prompt).getByRole('button', { name: 'Commit to running-config' }))

    expect(session.commit).toHaveBeenCalledOnce()
    expect(await screen.findByRole('status')).toHaveTextContent('Startup-config was not changed.')
  })

  it('offers the pending-session abort a 1006 needs, and writes nothing until it is confirmed', async () => {
    const user = userEvent.setup()
    const { node } = makeClient({
      listSessions: vi.fn(async () => ({ sessions: [{ name: 'stale-pending', state: 'pending', instances: [] }] })),
    })
    await ready(node)

    const abort = await screen.findByRole('button', { name: 'Abort pending session' })
    await user.click(abort)
    const prompt = await screen.findByRole('dialog', { name: 'Abort pending device session' })
    expect(within(prompt).getByText(/holds the config lock/u)).toBeInTheDocument()
    await user.click(within(prompt).getByRole('button', { name: 'Cancel' }))
    expect(node.abortSession).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Abort pending session' }))
    const confirmPrompt = await screen.findByRole('dialog', { name: 'Abort pending device session' })
    await user.click(within(confirmPrompt).getByRole('button', { name: 'Abort pending session' }))
    expect(node.abortSession).toHaveBeenCalledWith('stale-pending')
  })
})

describe('per-port deep link into the trunk editor (#126)', () => {
  it('linkable rows carry a real anchor whose accessible name and href name the port', async () => {
    const { node } = makeClient()
    await ready(node)

    for (const name of ['Ethernet1', 'Ethernet2', 'Ethernet22', 'Port-Channel1']) {
      const link = screen.getByRole('link', { name: `Edit trunk settings for ${name}` })
      // A REAL anchor (#63's rule): the raw href is what makes middle-click and open-in-new-tab
      // carry the deep link, not just the router's own click.
      expect(link).toHaveAttribute('href', `#/switches/manage?port=${name}`)
    }
    // The link sits beside the name it belongs to — the cell keeps the name node.
    expect(within(screen.getByRole('cell', { name: /Ethernet22/u })).getByRole('link', { name: 'Edit trunk settings for Ethernet22' })).toBeInTheDocument()
  })

  it('no link for a name the editor will not write, and none for sections S3 does not list', async () => {
    const { node } = makeClient()
    await ready(node)
    // Ethernet49/1 fails the client's own name grammar (same predicate behind the editor's shut
    // controls); Management1/Vlan100 are not Ethernet/Port-Channel sections at all. A row S3 cannot
    // edit must not get a link dead-ending into a disabled form (#126 acceptance).
    for (const name of ['Ethernet49/1', 'Management1', 'Vlan100']) {
      expect(screen.queryByRole('link', { name: `Edit trunk settings for ${name}` })).toBeNull()
    }
    // And the unrecognised-name note still rides its row — no link replaced it.
    expect(screen.getByText('name this client cannot parse')).toBeInTheDocument()
  })

  it('a plain click routes through the hash channel with the parameter intact', async () => {
    const user = userEvent.setup()
    const { node } = makeClient()
    await ready(node)
    await user.click(screen.getByRole('link', { name: 'Edit trunk settings for Ethernet22' }))
    expect(window.location.hash).toBe('#/switches/manage?port=Ethernet22')
    window.location.hash = ''
  })
})
