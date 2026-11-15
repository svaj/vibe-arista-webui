/**
 * S6 (#76): the IP addressing screen, offline through hand-rolled fake client seams — the
 * `LagManager.test.tsx` shape minus the capability probe (this screen gates no vocabulary:
 * every verb here is config-backed M text, and staging a probe session for undecided
 * features is exactly what the repo's rules refuse). No test here contacts a device.
 *
 * Scenario data is hand-authored config-shaped data (the addresses/secondaries are not
 * captured payloads). The device columns, however, ride real captures: the JSON form of
 * `show ip interface brief` exists on BOTH targets (`show-ip-interface-brief--hw-inventory
 * .json` and the cEOS live `show-ip-interface-brief.json`), which is what corrected #76's
 * stale "never captured" note — the test fake copies the captured entry SHAPE verbatim and
 * keys scenario VALUES to this file's rows. The `urls[]` padding spellings in `mgmtReply`
 * are likewise the committed ones from both targets. The argv pins are the heart of the
 * file: they prove the screen stages exactly what the client's pinned ipinterfaces verbs
 * compose (`commandBuilder('ip address', …)` framings, upstream's `no ip address` +
 * `switchport` order), and that a refused intent opens NO config session at all.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Interface, IpInterface } from '@devhax-heavy-industries/arista-eapi'

import { IpAddressing, addressFormRefusal, isManagementInterfaceName, liveAgreement, subnetContainment } from './IpAddressing'

type TestNode = NonNullable<Parameters<typeof IpAddressing>[0]['node']>

interface Overrides {
  readonly interfaces?: Map<string, Interface> | Error | 'pending'
  readonly addresses?: Map<string, IpInterface> | Error | 'pending'
  readonly management?: unknown | Error
  readonly brief?: unknown | Error
  readonly served?: readonly string[]
  readonly connAddress?: string
  readonly diffRead?: boolean
}

const sections = (): Map<string, Interface> => new Map([
  ['Ethernet1', { name: 'Ethernet1', kind: 'Ethernet' }],
  ['Ethernet2', { name: 'Ethernet2', kind: 'Ethernet' }],
  // A VRF-bound section: reader-side `ethernet.vrf` this client added; every write must refuse it.
  ['Ethernet3', { name: 'Ethernet3', kind: 'Ethernet', ethernet: { vrf: 'cust-a' } }],
  // Capture-confirmed split-QSFP spelling, outside this client's name grammar (open item 7).
  ['Ethernet49/1', { name: 'Ethernet49/1', kind: null }],
  ['Port-Channel1', { name: 'Port-Channel1', kind: 'Port-Channel' }],
  ['Vlan10', { name: 'Vlan10', kind: 'Vlan' }],
  ['Vlan99', { name: 'Vlan99', kind: 'Vlan' }],
  ['Loopback0', { name: 'Loopback0', kind: 'Loopback' }],
  ['Management1', { name: 'Management1', kind: 'Management' }],
])

const addressTable = (): Map<string, IpInterface> => new Map([
  ['Vlan10', { name: 'Vlan10', address: '10.0.0.1/24', secondary: ['10.9.9.9/24'], mtu: 1500 }],
  ['Vlan99', { name: 'Vlan99' }],
  ['Ethernet1', { name: 'Ethernet1', address: '10.0.20.1/24' }],
  ['Loopback0', { name: 'Loopback0' }],
  ['Management1', { name: 'Management1', address: '10.0.100.99/24' }],
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

const versionReply = { hostname: 'sw1', version: '4.28.13.1M', systemMacAddress: '00:00:00:00:00:00', modelName: 'DCS-7050TX-64', serialNumber: '0000000000', internalVersion: '4.28.13.1M', architecture: 'x86_64', bootupTimestamp: 0, uptime: 0 }

/**
 * The entry SHAPE is the committed captures verbatim (`show-ip-interface-brief--hw-inventory.json`,
 * `show-ip-interface-brief.json`); the VALUES are scenario data keyed to this file's rows — the
 * captures carry only `Management1` (hardware) and `Vlan100`/`Vlan110` (cEOS). `Vlan110` is kept
 * brief-only on purpose: the cEOS capture shows sections-less names are possible answers, and this
 * screen must list them read-only.
 */
const briefReply = () => ({
  interfaces: {
    Vlan10: { name: 'Vlan10', interfaceStatus: 'connected', interfaceAddress: { ipAddr: { maskLen: 24, address: '10.0.0.1' } }, ipv4Routable240: false, lineProtocolStatus: 'up', mtu: 1500 },
    Ethernet1: { name: 'Ethernet1', interfaceStatus: 'connected', interfaceAddress: { ipAddr: { maskLen: 24, address: '10.0.20.1' } }, ipv4Routable240: false, lineProtocolStatus: 'up', mtu: 1500 },
    Management1: { name: 'Management1', interfaceStatus: 'connected', interfaceAddress: { ipAddr: { maskLen: 24, address: '10.0.100.99' } }, ipv4Routable240: false, lineProtocolStatus: 'up', mtu: 1500 },
    Vlan110: { name: 'Vlan110', interfaceStatus: 'notconnect', interfaceAddress: { ipAddr: { maskLen: 24, address: '10.0.110.1' } }, ipv4Routable240: false, lineProtocolStatus: 'lowerLayerDown', mtu: 1500 },
  },
})

function makeFakes(overrides: Overrides = {}) {
  const session = {
    name: 'ui-s6-session',
    state: 'diffed',
    isOpen: false,
    run: vi.fn(async () => []),
    diff: vi.fn(async () => '+interface Vlan99\n+   ip address 10.30.0.1/24'),
    hasDiffBeenRead: vi.fn(() => overrides.diffRead ?? true),
    commit: vi.fn(async () => []),
    abort: vi.fn(async () => []),
  }
  const sectionsData = overrides.interfaces ?? sections()
  const addressesData = overrides.addresses ?? addressTable()
  const node = {
    interfaces: {
      getAll: vi.fn(async () => {
        if (sectionsData === 'pending') await new Promise(() => undefined)
        if (sectionsData instanceof Error) throw sectionsData
        return sectionsData
      }),
    },
    ipinterfaces: {
      getAll: vi.fn(async () => {
        if (addressesData === 'pending') await new Promise(() => undefined)
        if (addressesData instanceof Error) throw addressesData
        return addressesData
      }),
    },
    configSession: vi.fn(async () => session),
    show: vi.fn(async (command: string) => {
      if (command === 'version') return versionReply
      if (command === 'ip interface brief') {
        if (overrides.brief instanceof Error) throw new Error('brief read exploded')
        return overrides.brief ?? briefReply()
      }
      if (command === 'management api http-commands') {
        if (overrides.management instanceof Error) throw overrides.management
        return mgmtReply(overrides.served ?? ['Vlan10     : https://10.0.0.1:443'])
      }
      throw new Error(`this screen must not send ${command}`)
    }),
    connection: { address: overrides.connAddress ?? 'https://10.0.0.9:443/command-api' },
  } as unknown as TestNode

  return { node, session }
}

/** Render and wait for the read batch to LAND. */
async function ready(node: TestNode | undefined, proxyConfigured?: boolean) {
  render(<IpAddressing node={node} {...(proxyConfigured === undefined ? {} : { proxyConfigured })} />)
  await screen.findByRole('heading', { name: 'IP addressing' })
  return screen.findByLabelText('Change')
}

async function chooseAction(action: string) {
  await userEvent.selectOptions(await screen.findByLabelText('Change'), action)
}

async function chooseIface(name: string) {
  await userEvent.selectOptions(await screen.findByLabelText('Interface'), name)
}

async function typeAddress(value: string) {
  const field = await screen.findByLabelText(/Address/u)
  fireEvent.change(field, { target: { value } })
}

function press(name: string) {
  fireEvent.click(screen.getByRole('button', { name }))
}

async function stage(action: string, iface: string, address?: string) {
  await chooseAction(action)
  await chooseIface(iface)
  if (address !== undefined) await typeAddress(address)
  press('Preview and read the diff')
  await screen.findByText('Review the device diff before committing this change.')
}

const stagedArgv = () => screen.getByLabelText('Staged commands')
const table = () => screen.getByRole('table', { name: 'IP interfaces from running-config' })

afterEach(() => vi.restoreAllMocks())

describe('IpAddressing — reads and states', () => {
  it('refuses to act with no proxy, and contacts nothing', async () => {
    render(<IpAddressing node={undefined} proxyConfigured={false} />)
    expect((await screen.findAllByText(/Local proxy is not configured/u)).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Preview and read the diff' })).toBeDisabled()
    expect(screen.queryByRole('table', { name: 'IP interfaces from running-config' })).toBeNull()
  })

  it('builds every column from the parsed config, and says so in the banner', async () => {
    const { node } = makeFakes()
    await ready(node)
    const rows = table()
    expect(within(rows).getByText('Vlan10')).toBeInTheDocument()
    // Config line and live answer coincide for Vlan10, so the string appears once per column:
    expect(within(rows).getAllByText('10.0.0.1/24').length).toBe(2)
    expect(within(rows).getAllByText('10.9.9.9/24')).toHaveLength(1)
    // L2 sections read as "no `no switchport` line", never as an address absence: Ethernet2,
    // Ethernet3 (VRF-bound), Ethernet49/1, Port-Channel1, plus the brief-only Vlan110 (no config
    // section for it) — five rows without the line once the brief is loaded.
    expect(within(rows).getAllByText('no `no switchport` line').length).toBe(5)
    // The device columns render the brief answer, kept separate from the config columns.
    expect(within(rows).getByText('10.0.110.1/24')).toBeInTheDocument() // brief-only Vlan110
    expect(within(rows).getAllByText('notconnect').length).toBe(1)
    // The two-source banner, including the correction of #76's stale capture claim.
    expect(await screen.findByText(/show ip interface brief/u)).toBeInTheDocument()
    expect(document.body.textContent).toMatch(/claim went stale/u)
    const asked = (node.show as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((call) => call[0])
    expect(asked).toEqual(['management api http-commands', 'version', 'ip interface brief'])
  })

  it('handles the address read failing without deriving any address state', async () => {
    const { node } = makeFakes({ addresses: new Error('config parse exploded') })
    await ready(node)
    expect(await screen.findByText(/IP-interface table could not be parsed/u)).toBeInTheDocument()
    expect(table()).toHaveTextContent('Unknown — address read failed')
    // Sections still list, with the kind column intact.
    expect(within(table()).getByText('Loopback0')).toBeInTheDocument()
  })

  it('handles the management read failing as an unknown, not a clean bill', async () => {
    const { node } = makeFakes({ management: new Error('eapi refused') })
    await ready(node)
    expect(await screen.findByText(/management-API read failed/u)).toBeInTheDocument()
    expect(table()).toHaveTextContent('Unknown')
  })

  it('surfaces a hard section-read failure as a failed device state', async () => {
    const { node } = makeFakes({ interfaces: new Error('device unreachable') })
    render(<IpAddressing node={node} />)
    expect(await screen.findByText(/Device state could not be read/u)).toBeInTheDocument()
    expect(await screen.findByText('device unreachable')).toBeInTheDocument()
    expect(screen.queryByRole('table', { name: 'IP interfaces from running-config' })).toBeNull()
  })

  it('shows a busy state while the reads are in flight', async () => {
    const { node } = makeFakes({ interfaces: 'pending' })
    render(<IpAddressing node={node} />)
    const pending = await screen.findByText(/Reading the interface sections/u)
    expect(pending).toHaveAttribute('aria-busy', 'true')
    expect(pending).toHaveAttribute('role', 'status')
    expect(screen.queryByRole('table', { name: 'IP interfaces from running-config' })).toBeNull()
  })

  it('renders the empty answer (no sections) without inventing rows', async () => {
    const { node } = makeFakes({ interfaces: new Map<string, Interface>(), brief: { interfaces: {} } })
    await ready(node)
    expect(await screen.findByText(/no interface sections at all/u)).toBeInTheDocument()
    expect(screen.queryByRole('table', { name: 'IP interfaces from running-config' })).toBeNull()
  })

  it('handles the brief read failing without deriving status from config lines', async () => {
    const { node } = makeFakes({ brief: new Error('nope') })
    await ready(node)
    expect(await screen.findByText(/device-status read \(show ip interface brief\) failed/u)).toBeInTheDocument()
    expect(table()).toHaveTextContent('brief read failed')
    // The brief-only row cannot exist when the brief did not answer.
    expect(within(table()).queryByText('Vlan110')).toBeNull()
  })

  it('prints a config/device disagreement instead of reconciling it', async () => {
    const disagreeing = {
      interfaces: {
        Vlan10: { name: 'Vlan10', interfaceStatus: 'connected', interfaceAddress: { ipAddr: { maskLen: 24, address: '10.9.9.1' } }, ipv4Routable240: false, lineProtocolStatus: 'up', mtu: 1500 },
      },
    }
    const { node } = makeFakes({ brief: disagreeing })
    await ready(node)
    expect(await screen.findByText(/config line and the device answer disagree — not auto-reconciled/u)).toBeInTheDocument()
  })

  it('lists a brief-only name read-only, and refuses to stage writes against it', async () => {
    const { node } = makeFakes()
    await ready(node)
    expect(within(table()).getByText('Device-named, no section in config read')).toBeInTheDocument()
    await chooseAction('set-address')
    await chooseIface('Vlan110')
    await typeAddress('10.0.110.5/24')
    press('Preview and read the diff')
    expect(await screen.findByText(/only the device/u)).toBeInTheDocument()
    expect(node.configSession).not.toHaveBeenCalled()
  })
})

describe('liveAgreement — the one comparison this screen makes', () => {
  it.each([
    ['10.0.0.1/24', { address: '10.0.0.1', maskLen: 24 }, true],
    ['10.0.0.1/24', { address: '10.0.0.1', maskLen: 25 }, false],
    ['10.0.0.1/255.255.255.0', { address: '10.0.0.1', maskLen: 24 }, undefined],
    [undefined, { address: '10.0.0.1', maskLen: 24 }, undefined],
    ['10.0.0.1/24', undefined, undefined],
  ] as const)('agreement %s vs %s -> %s', (config, live, expected) => {
    expect(liveAgreement(config, live)).toBe(expected)
  })
})

describe('addressFormRefusal / subnetContainment / management-name — client-mirror units', () => {
  it.each([
    ['10.1.1.1/24', undefined],
    ['10.1.1.1/24 secondary', undefined],
    ['10.1.1.1', /Expected A\.B\.C\.D\/E/u],
    ['10.1.1.256/24', /octet 256/u],
    ['10.1.1.1/33', /prefix length 33/u],
    ['10.1.1.1/24 tertiary', /single word secondary/u],
    ['10.1.1.1/24 secondary extra', /single word secondary/u],
    ['10.1.1.1/24\u0007', /control character/u],
    ['virtual 10.1.1.1/24', /single word secondary/u],
  ] as const)('validate %s -> %s', (value, expected) => {
    const refusal = addressFormRefusal(value)
    if (expected === undefined) expect(refusal).toBeUndefined()
    else expect(refusal).toMatch(expected)
  })

  it.each([
    ['10.0.0.9', '10.0.0.1/24', true],
    ['10.0.1.9', '10.0.0.1/24', false],
    ['10.0.0.9', '10.0.0.9/32', true],
    ['10.0.0.9', '10.0.0.0/0', true],
    ['sw1.test', '10.0.0.1/24', undefined],
    ['10.0.0.9', 'virtual', undefined],
    ['10.0.0.9', '10.0.0.1/33', undefined],
  ] as const)('containment %s in %s -> %s', (endpoint, token, expected) => {
    expect(subnetContainment(endpoint, token)).toBe(expected)
  })

  it('recognises the Management kind token for the out-of-scope guard', () => {
    expect(isManagementInterfaceName('Management1')).toBe(true)
    expect(isManagementInterfaceName('Mgmt1')).toBe(false)
    expect(isManagementInterfaceName('Vlan10')).toBe(false)
  })
})

describe('IpAddressing — staged batches match the client verbs', () => {
  const runArgv = (session: { run: { mock: { calls: unknown[][] } } }) => session.run.mock.calls[0]?.[0]

  it('stages `interface <X>` + `ip address A/E` for a set-address, through ONE named session', async () => {
    const { node, session } = makeFakes()
    await ready(node)
    await stage('set-address', 'Vlan99', '10.30.0.1/24')
    expect(node.configSession).toHaveBeenCalledWith({ description: 'webui addressing set address on Vlan99' })
    expect(runArgv(session)).toEqual(['interface Vlan99', 'ip address 10.30.0.1/24'])
    expect(stagedArgv()).toHaveTextContent('ip address 10.30.0.1/24')
    expect(await screen.findByText(/\+interface Vlan99/u)).toBeInTheDocument()
    press('Commit')
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Commit to running-config' }))
    await screen.findByText('Changes committed to running-config. Startup-config was not changed.')
    expect(session.commit).toHaveBeenCalledTimes(1)
    // The post-commit re-read starts one React flush AFTER the success text renders, so the second
    // `getAll` may not have reached the mock at the moment of a bare expect — it read 1 on a busy
    // node-24 CI leg (#124's run surfaced this #76-era flake; same commit, node 22 green). Await
    // the reload like TrunkEditor/Mlag already do for their read-count assertions.
    await vi.waitFor(() => expect((node.ipinterfaces.getAll as unknown as { mock: { calls: unknown[][] } }).mock.calls.length).toBeGreaterThan(1))
  })

  it('stages the secondary-suffixed line, appending the word when the operator omitted it', async () => {
    const { node, session } = makeFakes()
    await ready(node)
    await stage('add-secondary', 'Vlan99', '10.9.8.7/24')
    expect(runArgv(session)).toEqual(['interface Vlan99', 'ip address 10.9.8.7/24 secondary'])
  })

  it('stages the bare negation for remove-address', async () => {
    const { node, session } = makeFakes()
    await ready(node)
    await stage('remove-address', 'Vlan10')
    expect(runArgv(session)).toEqual(['interface Vlan10', 'no ip address'])
  })

  it('stages only `no switchport` for the routed-port transition', async () => {
    const { node, session } = makeFakes()
    await ready(node)
    await stage('route-port', 'Ethernet2')
    expect(runArgv(session)).toEqual(['interface Ethernet2', 'no switchport'])
    expect(screen.getAllByText(/switching configuration goes away/u).length).toBeGreaterThan(0)
  })

  it('stages switchport-back in the upstream order: no ip address, then switchport', async () => {
    const { node, session } = makeFakes()
    await ready(node)
    await stage('switchport-back', 'Ethernet1')
    expect(runArgv(session)).toEqual(['interface Ethernet1', 'no ip address', 'switchport'])
  })
})

describe('IpAddressing — refusals open no session at all', () => {
  it('refuses a malformed address before touching the device', async () => {
    const { node, session } = makeFakes()
    await ready(node)
    await chooseAction('set-address')
    await chooseIface('Vlan99')
    await typeAddress('10.30.0.300/24')
    press('Preview and read the diff')
    expect(await screen.findByText(/octet 300/u)).toBeInTheDocument()
    expect(node.configSession).not.toHaveBeenCalled()
    expect(session.run).not.toHaveBeenCalled()
  })

  it('refuses a no-op replace with the address the row already carries', async () => {
    const { node } = makeFakes()
    await ready(node)
    await chooseAction('set-address')
    await chooseIface('Vlan10')
    await typeAddress('10.0.0.1/24')
    press('Preview and read the diff')
    expect(await screen.findByText(/already carries exactly 10\.0\.0\.1\/24/u)).toBeInTheDocument()
    expect(node.configSession).not.toHaveBeenCalled()
  })

  it('refuses re-adding a secondary line the config already names', async () => {
    const { node } = makeFakes()
    await ready(node)
    await chooseAction('add-secondary')
    await chooseIface('Vlan10')
    await typeAddress('10.9.9.9/24')
    press('Preview and read the diff')
    expect(await screen.findByText(/already carries 10\.9\.9\.9\/24 as a secondary/u)).toBeInTheDocument()
    expect(node.configSession).not.toHaveBeenCalled()
  })

  it('refuses an address on a switching port and names the mode-change action instead', async () => {
    const { node } = makeFakes()
    await ready(node)
    await chooseAction('set-address')
    await chooseIface('Ethernet2')
    await typeAddress('10.30.0.1/24')
    press('Preview and read the diff')
    expect(await screen.findByText(/switching port in the parsed config/u)).toBeInTheDocument()
    expect(node.configSession).not.toHaveBeenCalled()
  })

  it('never writes the Management<N> interface, even though the client grammar would allow it', async () => {
    const { node } = makeFakes()
    await ready(node)
    // Listed in the table: Management1 is a real IP interface.
    expect(within(table()).getByText('Management1')).toBeInTheDocument()
    await chooseAction('set-address')
    await chooseIface('Management1')
    await typeAddress('10.0.100.50/24')
    press('Preview and read the diff')
    expect(await screen.findByText(/keeps MGMT-port isolation out of scope/u)).toBeInTheDocument()
    expect(node.configSession).not.toHaveBeenCalled()
  })

  it('refuses every write on a VRF-bound section it cannot fully read back', async () => {
    const { node } = makeFakes()
    await ready(node)
    await chooseAction('route-port')
    await chooseIface('Ethernet3')
    press('Preview and read the diff')
    expect(await screen.findByText(/bound to VRF cust-a/u)).toBeInTheDocument()
    expect(node.configSession).not.toHaveBeenCalled()
  })

  it('refuses the routed-port transition on the interface the device NAMES as serving eAPI', async () => {
    const { node } = makeFakes({ served: ['Ethernet2     : https://10.0.20.2:443'], interfaces: new Map(sections().set('Ethernet2', { name: 'Ethernet2', kind: 'Ethernet' })) })
    await ready(node)
    await chooseAction('route-port')
    await chooseIface('Ethernet2')
    press('Preview and read the diff')
    expect(await screen.findByText(/refused outright on the in-band management interface/u)).toBeInTheDocument()
    expect(node.configSession).not.toHaveBeenCalled()
  })

  it('keeps the split-QSFP name listed but unwritable (open item 7)', async () => {
    const { node } = makeFakes()
    await ready(node)
    expect(within(table()).getByText('Ethernet49/1')).toBeInTheDocument()
    await chooseAction('route-port')
    await chooseIface('Ethernet49/1')
    press('Preview and read the diff')
    // kind is null -> Unrecognised, refused on the kind guard with the grammar note pending.
    expect(await screen.findByText(/Only Ethernet and Port-Channel sections flip/u)).toBeInTheDocument()
    expect(node.configSession).not.toHaveBeenCalled()
  })

  it('refuses switchport-back on a Vlan (kind never had the flip)', async () => {
    const { node } = makeFakes()
    await ready(node)
    await chooseAction('switchport-back')
    await chooseIface('Vlan10')
    press('Preview and read the diff')
    expect(await screen.findByText(/return to switching here/u)).toBeInTheDocument()
    expect(node.configSession).not.toHaveBeenCalled()
  })

  it('refuses to claim what an address negation would remove when the address read failed', async () => {
    const { node } = makeFakes({ addresses: new Error('parse failed') })
    await ready(node)
    await chooseAction('remove-address')
    await chooseIface('Vlan10')
    press('Preview and read the diff')
    expect(await screen.findByText(/cannot say what a negation here would remove/u)).toBeInTheDocument()
    expect(node.configSession).not.toHaveBeenCalled()
  })

  it('refuses an action with no interface selected', async () => {
    const { node } = makeFakes()
    await ready(node)
    press('Preview and read the diff')
    expect(await screen.findByText(/Pick the interface first/u)).toBeInTheDocument()
    expect(node.configSession).not.toHaveBeenCalled()
  })
})

describe('IpAddressing — in-band guard reaches the confirm', () => {
  it('names the device-served interface in the risk list and makes the commit destructive', async () => {
    const { node } = makeFakes()
    await ready(node)
    await stage('set-address', 'Vlan10', '10.0.0.5/24')
    // The note renders twice on purpose: once in the form's in-band banner, once in the staged
    // draft's risk list — both must be present before the destructive confirm can be reached.
    expect((await screen.findAllByText(/names Vlan10 as an interface serving eAPI/u)).length).toBeGreaterThanOrEqual(2)
    press('Commit')
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent(/serving eAPI/u)
    expect(within(dialog).getByRole('button', { name: 'Commit despite the risk on Vlan10' })).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Commit despite the risk on Vlan10' }))
    await screen.findByText('Changes committed to running-config. Startup-config was not changed.')
  })

  it('catches an in-band row through subnet arithmetic even when the answer named nothing', async () => {
    const { node } = makeFakes({ served: [] })
    await ready(node)
    await stage('remove-address', 'Vlan10')
    // arithmetic over the fake endpoint 10.0.0.9 and Vlan10's /24
    expect((await screen.findAllByText(/endpoint this UI dials \(10\.0\.0\.9\) falls inside that prefix/u)).length).toBeGreaterThanOrEqual(2)
  })

  it('a DNS-named endpoint cannot be compared — it warns, never passes silently', async () => {
    const { node } = makeFakes({ served: [], connAddress: 'https://sw1.test:443/command-api' })
    await ready(node)
    await stage('remove-address', 'Ethernet1')
    expect((await screen.findAllByText(/not an IPv4 literal, so it cannot be compared/u)).length).toBeGreaterThanOrEqual(1)
  })

  it('names the uncaptured secondary fate under a bare negation', async () => {
    const { node } = makeFakes()
    await ready(node)
    await stage('remove-address', 'Vlan10')
    expect(await screen.findByText(/carries secondary line\(s\) 10\.9\.9\.9\/24/u)).toBeInTheDocument()
  })
})

describe('IpAddressing — session lifecycle guards', () => {
  it('ignores a second Preview pressed mid-flight', async () => {
    const { node } = makeFakes()
    await ready(node)
    await chooseAction('set-address')
    await chooseIface('Vlan99')
    await typeAddress('10.30.0.1/24')
    press('Preview and read the diff')
    press('Preview and read the diff')
    press('Preview and read the diff')
    await screen.findByText('Review the device diff before committing this change.')
    expect(node.configSession).toHaveBeenCalledTimes(1)
  })

  it('keeps Commit disabled when the session reports the diff was never opened', async () => {
    const { node, session } = makeFakes({ diffRead: false })
    await ready(node)
    await stage('set-address', 'Vlan99', '10.30.0.1/24')
    // hasDiffBeenRead() false is the client-side lock: F6's review gate, independent of the
    // diff string itself having arrived.
    expect(session.hasDiffBeenRead).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Commit' })).toBeDisabled()
  })

  it('a failed commit says the change may still have applied and disarms re-commit', async () => {
    const { node, session } = makeFakes()
    session.commit = vi.fn(async () => {
      throw Object.assign(new Error('config session locked'), { code: 1006, message: 'Another config session is active' })
    })
    await ready(node)
    await stage('set-address', 'Vlan99', '10.30.0.1/24')
    press('Commit')
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Commit to running-config' }))
    expect(await screen.findByText(/Commit may have applied — reconnect and refresh/u)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Commit' })).toBeDisabled()
  })

  it('aborting the staged draft discards the session without committing', async () => {
    const { node, session } = makeFakes()
    await ready(node)
    await stage('set-address', 'Vlan99', '10.30.0.1/24')
    press('Abort session')
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Abort staged changes' }))
    await screen.findByText(/was aborted; nothing was written to the device/u)
    expect(session.abort).toHaveBeenCalledTimes(1)
    expect(session.commit).not.toHaveBeenCalled()
  })

  it('refuses any intent while no interface is selected', async () => {
    const { node } = makeFakes()
    await ready(node)
    // The select only ever holds names the table read — a name the screen did not read is
    // unreachable by construction; this pins the empty-selection arm that guards plan().
    await chooseAction('route-port')
    press('Preview and read the diff')
    expect(await screen.findByText(/Pick the interface first/u)).toBeInTheDocument()
    expect(node.configSession).not.toHaveBeenCalled()
  })
})
