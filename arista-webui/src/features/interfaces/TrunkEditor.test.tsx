/**
 * S3 (#73): the trunk-port editor, offline through hand-rolled fake client seams — exactly the
 * `VlanManagement.test.tsx` shape, with no `fetch` mocking and no device or proxy contact. Because
 * this screen has no capability probe (trunk-group editing is not exposed, see the note in
 * `TrunkEditor.tsx`), the fake node only has to satisfy the container's own seam: `interfaces`,
 * `ipinterfaces`, `switchports`, `vlans`, `configSession`, `listSessions`, `abortSession`, `show`.
 *
 * Scenario data mirrors the captured spellings the client's readers are built for (cEOS-lab 4.28.14M
 * `show running-config`: `Ethernet1` access VLAN 100, `Port-Channel1` a trunk with
 * `switchport trunk group LABGRP`; the 7050TX-64 hardware capture's `urls: ["Management1 : …"]`
 * padding shape), and the hand-authored part is said out loud: the client has **no** device-side
 * trunk JSON capture and its `switchport-trunk.conf` fixture is hand-written, so these switchport
 * records are scenario data for a running-config parse, not evidence of what the SKU does
 * (`hardwareEvidence: none`, DR-043). Everything the tests assert is therefore composed argv,
 * gating, and what the screen says it does not know.
 *
 * The presentation describe below renders `TrunkEditorView` with props built by hand — no fake node —
 * which is the payoff of the container/presentation split: the markup arms (load state, per-action
 * fields, review-panel gates, notices) are pinned without a client type in sight.
 *
 * The route wiring in `App.tsx` registers `#/trunk`; the per-port link from S1's table that the issue
 * also names is deliberately not added here, because this task's scope forbids touching S1's screen —
 * the screen carries its own port selector instead, and that gap is stated below.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConfigSession, Interface, IpInterface, Switchport, Vlan } from '@devhax-heavy-industries/arista-eapi'

import { TrunkEditor } from './TrunkEditor'
import type { TrunkEditorClient } from './TrunkEditor'
import { TrunkEditorView, TRUNK_ACTION_LABELS } from './TrunkEditorView'
import type { TrunkCapabilityView } from './TrunkEditorView'
import type { TrunkAction, TrunkDraftView, TrunkFieldKey, TrunkFields, TrunkLoadState, TrunkPortRow, TrunkReadyData } from './TrunkEditorView'

type TestNode = NonNullable<Parameters<typeof TrunkEditor>[0]['node']>
type SessionFakes = { run: ReturnType<typeof vi.fn>; diff: ReturnType<typeof vi.fn>; commit: ReturnType<typeof vi.fn>; abort: ReturnType<typeof vi.fn>; hasDiffBeenRead: ReturnType<typeof vi.fn> }

interface Overrides {
  readonly interfaces?: Map<string, Interface> | Error | 'pending'
  /** What the **probe** session's `validateChanges` answers: accepted, a 1002, a throw, or stuck. */
  readonly probe?: 'accepted' | 'rejected-1002' | 'failed' | 'pending'
  readonly switchports?: Map<string, Switchport> | Error
  readonly vlans?: Map<number, Vlan>
  readonly ipinterfaces?: Map<string, IpInterface>
  readonly show?: (command: string) => Promise<unknown>
  readonly listSessions?: () => Promise<{ sessions: readonly { name: string; state: string; description?: string }[] }>
}

const configSections = (): Map<string, Interface> => new Map([
  ['Ethernet1', { name: 'Ethernet1', kind: 'Ethernet' }],
  ['Ethernet2', { name: 'Ethernet2', kind: 'Ethernet' }],
  // Listed by the running-config, but carrying no switchport line of its own.
  ['Ethernet3', { name: 'Ethernet3', kind: 'Ethernet' }],
  // Capture-confirmed split-QSFP spelling, refused by this client's name grammar (open item 7).
  ['Ethernet49/1', { name: 'Ethernet49/1', kind: null }],
  ['Port-Channel1', { name: 'Port-Channel1', kind: 'Port-Channel' }],
  ['Port-Channel10', { name: 'Port-Channel10', kind: 'Port-Channel' }],
  ['Management1', { name: 'Management1', kind: 'Management' }],
  ['Vlan100', { name: 'Vlan100', kind: 'Vlan' }],
])

const switchportTable = (): Map<string, Switchport> => new Map([
  ['Ethernet1', { interfaceName: 'Ethernet1', mode: 'access', accessVlan: 100, trunkGroups: [] }],
  ['Ethernet2', { interfaceName: 'Ethernet2', mode: 'trunk', trunkNativeVlan: 10, trunkAllowedVlans: '10-12,20', trunkGroups: [] }],
  // The device spelling from the client's verbatim pin; `100` is the VLAN the cEOS capture serves eAPI on.
  ['Port-Channel1', { interfaceName: 'Port-Channel1', mode: 'trunk', trunkNativeVlan: 100, trunkAllowedVlans: '1,2,3-5,6,7', trunkGroups: ['LABGRP'] }],
  ['Port-Channel10', { interfaceName: 'Port-Channel10', mode: 'trunk', trunkAllowedVlans: 'all', trunkGroups: [] }],
  ['Ethernet49/1', { interfaceName: 'Ethernet49/1', mode: 'trunk', trunkNativeVlan: 10, trunkGroups: [] }],
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

function makeFakes(overrides: Overrides = {}, diffRead = true) {
  const session = {
    name: 'ui-s3-session',
    state: 'diffed',
    run: vi.fn(async () => []),
    diff: vi.fn(async () => '+interface Ethernet2\n+ switchport trunk native vlan 200'),
    hasDiffBeenRead: vi.fn(() => diffRead),
    commit: vi.fn(async () => []),
    abort: vi.fn(async () => []),
  }
  // `probeCommands` opens its OWN session with `noCommit: true`, validates candidates through it
  // (never `run`), and always aborts it (DR-063). The discriminator here is the same one the client
  // uses to open it, so the write session's `run`/`commit` pins below stay unambiguous.
  const probeSession = {
    name: 'ui-s3-probe',
    state: 'open',
    isOpen: true,
    run: vi.fn(async () => []),
    diff: vi.fn(async () => ''),
    hasDiffBeenRead: vi.fn(() => false),
    commit: vi.fn(async () => { throw new Error('a no-commit probe session must never reach commit') }),
    abort: vi.fn(async () => []),
    validateChanges: vi.fn(() => {
      if (overrides.probe === 'pending') return new Promise(() => undefined)
      if (overrides.probe === 'failed') return Promise.reject(new Error('device unreachable'))
      if (overrides.probe === 'rejected-1002') {
        return Promise.resolve({
          ok: false,
          failures: [{ cmd: 'switchport trunk group webui-probe', code: 1002, message: 'Invalid input at trunk group keyword' }],
          error: { code: 1002, message: 'SYNTHETIC 1002 COMMAND_INVALID while probing' },
        })
      }
      return Promise.resolve({ ok: true, applied: [] })
    }),
  } as unknown as SessionHandles & { validateChanges: ReturnType<typeof vi.fn> } as unknown as ConfigSession & SessionFakes

  const interfaces = overrides.interfaces ?? configSections()
  const switchports = overrides.switchports ?? switchportTable()
  const node = {
    interfaces: {
      getAll: vi.fn(async () => {
        if (interfaces === 'pending') await new Promise(() => undefined)
        if (interfaces instanceof Error) throw interfaces
        return interfaces
      }),
    },
    switchports: {
      getAll: vi.fn(async () => {
        if (switchports instanceof Error) throw switchports
        return switchports
      }),
    },
    vlans: {
      getAll: vi.fn(async () => overrides.vlans ?? new Map<number, Vlan>([
        [1, { id: 1, name: 'default', state: 'active', trunkGroups: [] }],
        [10, { id: 10, name: 'NATIVE', state: 'active', trunkGroups: [] }],
        [20, { id: 20, name: 'VOICE', state: 'active', trunkGroups: [] }],
        [100, { id: 100, name: 'EAPI', state: 'active', trunkGroups: [] }],
        [200, { id: 200, name: 'SPARE', state: 'active', trunkGroups: [] }],
      ])),
    },
    ipinterfaces: {
      getAll: vi.fn(async () => overrides.ipinterfaces ?? new Map<string, IpInterface>([
        ['Management1', { name: 'Management1', address: '10.0.100.99/24' }],
        ['Vlan100', { name: 'Vlan100', address: '10.0.100.1/24' }],
        ['Ethernet2', { name: 'Ethernet2', address: '10.0.20.1/24' }],
      ])),
    },
    configSession: vi.fn(async (options?: { noCommit?: boolean }) => (options?.noCommit === true ? probeSession : session)),
    listSessions: vi.fn(async () => overrides.listSessions?.() ?? { sessions: [] }),
    abortSession: vi.fn(async () => []),
    // The F5 probe seam: the target handle the client's `probeCommands` needs, plus the node's own
    // refresh surface. No live write session sits on this node, so the probe conflict-refusal passes.
    activeConfigSession: undefined,
    runCommands: vi.fn(async () => [{ result: {} }]),
    refresh: vi.fn(),
    autorefresh: true,
    connection: { address: 'https://sw1.test:443/command-api' },
    address: 'https://sw1.test:443/command-api',
    show: vi.fn(async (command: string) => {
      if (overrides.show !== undefined) return overrides.show(command)
      if (command === 'version') {
        return { hostname: 'sw1', version: '4.28.13.1M', systemMacAddress: '00:00:00:00:00:00', modelName: 'DCS-7050TX-64', serialNumber: '0000000000', internalVersion: '4.28.13.1M', architecture: 'x86_64', bootupTimestamp: 0, uptime: 0 }
      }
      return mgmtReply(['Vlan100     : https://10.0.100.1:443'])
    }),
  } as unknown as TestNode

  return { node, session, probe: probeSession }
}

type SessionHandles = {
  run: ReturnType<typeof vi.fn>
  diff: ReturnType<typeof vi.fn>
  commit: ReturnType<typeof vi.fn>
  abort: ReturnType<typeof vi.fn>
  hasDiffBeenRead: ReturnType<typeof vi.fn>
}

/** Render and wait for the read batch to land, not merely for the shell to mount. */
async function ready(node: TrunkEditorClient | undefined, proxyConfigured?: boolean) {
  render(<TrunkEditor node={node} {...(proxyConfigured === undefined ? {} : { proxyConfigured })} />)
  await screen.findByRole('heading', { name: 'Trunk ports' })
  return screen.findByLabelText('Interface')
}

async function chooseAction(action: TrunkAction) {
  await userEvent.selectOptions(await screen.findByLabelText('Change'), action)
}

/** The labelled notice list the container renders its device-derived messages into. */
function notices() {
  return screen.getByRole('list', { name: 'What this screen knows about the current selection' })
}

async function stage(port: string, action: TrunkAction, fill?: () => Promise<void>) {
  await userEvent.selectOptions(screen.getByLabelText('Interface'), port)
  await chooseAction(action)
  if (fill !== undefined) await fill()
  await userEvent.click(screen.getByRole('button', { name: 'Preview change' }))
}

afterEach(() => vi.restoreAllMocks())

describe('TrunkEditor — device reads', () => {
  it('announces loading while the device reads are unresolved', () => {
    const { node } = makeFakes({ interfaces: 'pending' })
    render(<TrunkEditor node={node} />)

    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByText(/Reading interfaces, switchport config/u)).toBeInTheDocument()
  })

  it('does not contact an eAPI target when the local proxy is unconfigured', async () => {
    const { node, session, probe } = makeFakes()
    render(<TrunkEditor node={node} proxyConfigured={false} />)
    void probe

    expect(await screen.findByRole('alert')).toHaveTextContent('EAPI_HOST')
    expect(node.interfaces.getAll).not.toHaveBeenCalled()
    expect(node.switchports.getAll).not.toHaveBeenCalled()
    expect(node.vlans.getAll).not.toHaveBeenCalled()
    expect(node.ipinterfaces.getAll).not.toHaveBeenCalled()
    expect(node.listSessions).not.toHaveBeenCalled()
    expect(node.show).not.toHaveBeenCalled()
    expect(session.run).not.toHaveBeenCalled()
    expect(session.commit).not.toHaveBeenCalled()
  })

  it('offers only L2 sections, builds columns with scoped headers, and collapses a device range for display', async () => {
    const { node } = makeFakes()
    await ready(node)

    expect(screen.getByRole('table', { name: 'Layer 2 ports' })).toBeInTheDocument()
    for (const header of ['Interface', 'Mode', 'Access VLAN', 'Native VLAN', 'Allowed VLANs', 'Management path']) {
      expect(screen.getByRole('columnheader', { name: header })).toBeInTheDocument()
    }
    // The device spelling stays visible; the collapsed form is this app's display of the same set.
    expect(screen.getByText('1-7')).toBeInTheDocument()
    expect(screen.getByText('1,2,3-5,6,7')).toBeInTheDocument()
    expect(screen.getByText('10-12,20')).toBeInTheDocument()
    // A section with no switchport line is a third answer, not "routed".
    expect(screen.getByText('no switchport line read')).toBeInTheDocument()
    // SVI/mgmt sections are not offered as trunk ports, and the reason is the client's kind parse.
    const portSelect = screen.getByLabelText('Interface')
    expect(within(portSelect).queryByRole('option', { name: /^Management1/u })).toBeNull()
    expect(within(portSelect).queryByRole('option', { name: /^Vlan100/u })).toBeNull()
    expect(within(portSelect).getByRole('option', { name: /Port-Channel10/u })).toBeInTheDocument()
    // The reads this screen promises, promised exactly.
    expect(node.interfaces.getAll).toHaveBeenCalledWith({ status: 'skip' })
    expect(node.switchports.getAll).toHaveBeenCalledOnce()
  })

  it('labels where the values come from, and says trunk groups are out of scope here', async () => {
    await ready(makeFakes().node)

    // The paragraph splits around inline <code>/<strong> elements, so match its start and then assert content.
    const note = await screen.findByText(/^Every value on this screen is a/u)
    expect(note).toHaveTextContent('parsed show running-config line')
    expect(note).toHaveTextContent('no device-side trunk JSON capture')
    expect(note).toHaveTextContent('Trunk-group editing is out of scope')
    expect(note).toHaveTextContent('unproven on this box (no hardware pin)')
  })

  it('flags a keyword allowed-VLAN spelling without inventing its members', async () => {
    await ready(makeFakes().node)

    expect(screen.getAllByText('keyword spelling, not enumerable here (DR-028)')).toHaveLength(1)
    // No membership is manufactured for `all`: the raw token is shown, nothing else.
    expect(screen.getByRole('cell', { name: /^all/u })).toBeInTheDocument()
    expect(screen.queryByText(/^1\./u)).toBeNull()
  })

  it('an empty L2 inventory is empty, not an error, and says a failed read would look different', async () => {
    const { node } = makeFakes({
      interfaces: new Map<string, Interface>(),
      switchports: new Map<string, Switchport>(),
      vlans: new Map<number, Vlan>(),
      ipinterfaces: new Map<string, IpInterface>(),
    })
    await ready(node)

    expect(await screen.findByText('The device configured no Ethernet or Port-Channel switchport section.')).toBeInTheDocument()
    expect(screen.getByText(/a failed read renders as an error above, not as an empty list/u)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.getByText(/The VLAN table came back empty/u)).toBeInTheDocument()
  })

  it('a failed switchports read is an error with a retry, never an empty table', async () => {
    const { node } = makeFakes({ switchports: new Error('eAPI socket hang up') })
    render(<TrunkEditor node={node} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('eAPI socket hang up')
    expect(screen.getByRole('button', { name: 'Retry read' })).toBeInTheDocument()
    expect(screen.queryByText('The device configured no Ethernet or Port-Channel switchport section.')).not.toBeInTheDocument()
  })

  it('a failed management read flags nothing and is labelled as not a promise', async () => {
    const { node } = makeFakes({
      show: async (command: string) => {
        if (command === 'version') return { hostname: 'sw1', version: '4.28.13.1M', systemMacAddress: '00:00:00:00:00:00', modelName: 'DCS-7050TX-64', serialNumber: '0', internalVersion: 'x', architecture: 'x86_64', bootupTimestamp: 0, uptime: 0 }
        throw new Error('1002 command invalid')
      },
    })
    await ready(node)

    expect(await screen.findByText(/^The management-API read failed:/u)).toHaveTextContent('1002 command invalid')
    expect(screen.getByText(/^The management-API read failed:/u)).toHaveTextContent('not a promise that none does')
    expect(screen.queryByText('Native VLAN is the eAPI VLAN')).not.toBeInTheDocument()
    // The soft read did not blank the table the running-config read can still build.
    expect(screen.getByRole('table', { name: 'Layer 2 ports' })).toBeInTheDocument()
  })

  it('the device answer, not a guess, decides the management-path column', async () => {
    await ready(makeFakes().node)

    expect(screen.getAllByText('Native VLAN is the eAPI VLAN')).toHaveLength(1)   // Port-Channel1, native 100
    expect(screen.getAllByText('Access VLAN is the eAPI VLAN')).toHaveLength(1)   // Ethernet1, access 100
    expect(screen.getAllByText('Carries an IP address')).toHaveLength(1)          // Ethernet2
    // Rows with no device signal for either read say so, rather than implying "safe".
    expect(screen.getAllByText('No management-path signal read')).toHaveLength(3)
  })

  it('an out-of-vocabulary mode token is displayed and never coerced', async () => {
    const { node } = makeFakes({
      switchports: new Map<string, Switchport>([['Port-Channel7', { interfaceName: 'Port-Channel7', mode: 'q-in-q', trunkGroups: [] }]]),
    })
    await ready(node)

    expect(screen.getByText('outside this client’s four modes')).toBeInTheDocument()
    await userEvent.selectOptions(screen.getByLabelText('Interface'), 'Port-Channel7')
    await chooseAction('set-mode')
    const modeSelect = screen.getByLabelText('Switchport mode')
    for (const token of ['access', 'trunk', 'dot1q-tunnel', 'private-vlan']) {
      expect(within(modeSelect).getByRole('option', { name: token })).toBeInTheDocument()
    }
    expect(within(modeSelect).queryByRole('option', { name: 'q-in-q' })).toBeNull()
  })

  it('lists an unreadable split-port name with the write controls shut, and flags an empty allowed line', async () => {
    const { node, session } = makeFakes()
    await ready(node)

    expect(screen.getByText('name this client cannot write')).toBeInTheDocument()
    expect(screen.getByText('name this client cannot parse')).toBeInTheDocument()
    await userEvent.selectOptions(screen.getByLabelText('Interface'), 'Ethernet49/1')
    expect(within(notices()).queryByText(/No switchport line was read for this section/u)).toBeNull()
    expect(screen.getByRole('button', { name: 'Preview change' })).toBeDisabled()
    expect(session.run).not.toHaveBeenCalled()
    expect(session.commit).not.toHaveBeenCalled()
    // A section the switchports table has no record for gets that note, because absense is not "routed".
    await userEvent.selectOptions(screen.getByLabelText('Interface'), 'Ethernet3')
    expect(within(notices()).getByText(/No switchport line was read for this section/u)).toHaveTextContent('unproven on this box (no hardware pin)')
  })
})

describe('TrunkEditor — staged writes, refusals and the guards', () => {
  it('switching mode to trunk stages exactly the pinned two lines, and a commit needs an explicit confirm', async () => {
    const { node, session } = makeFakes()
    await ready(node)
    await stage('Ethernet2', 'set-mode', async () => { await userEvent.selectOptions(screen.getByLabelText('Switchport mode'), 'trunk') })

    await screen.findByText(/Review the device diff/u)
    expect(session.run).toHaveBeenCalledWith(['interface Ethernet2', 'switchport mode trunk'])
    expect(session.diff).toHaveBeenCalledOnce()
    expect(session.commit).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'Commit to running-config' }))
    const prompt = await screen.findByRole('dialog')
    expect(within(prompt).getByText('ui-s3-session · Ethernet2')).toBeInTheDocument()
    await userEvent.click(within(prompt).getByRole('button', { name: 'Cancel' }))
    expect(session.commit).not.toHaveBeenCalled()

    // A hard confirm gates every commit, not only the risky ones.
    await userEvent.click(screen.getByRole('button', { name: 'Commit to running-config' }))
    const confirmed = await screen.findByRole('dialog')
    await userEvent.click(within(confirmed).getByRole('button', { name: 'Set trunk on Ethernet2' }))
    expect(session.commit).toHaveBeenCalledOnce()
    expect(await screen.findByText('Changes committed to running-config. Startup-config was not changed.')).toBeInTheDocument()
  })

  it('re-reads the running-config after a commit and says so out loud', async () => {
    const { node, session } = makeFakes()
    await ready(node)
    expect(node.interfaces.getAll).toHaveBeenCalledOnce()

    await stage('Ethernet2', 'no-mode')
    await screen.findByText(/Review the device diff/u)
    expect(session.run).toHaveBeenCalledWith(['interface Ethernet2', 'no switchport mode'])
    await userEvent.click(screen.getByRole('button', { name: 'Commit to running-config' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Clear the mode on Ethernet2' }))

    expect(await screen.findByText(/re-read from the running-config after the commit/u)).toBeInTheDocument()
    await vi.waitFor(() => expect(node.interfaces.getAll).toHaveBeenCalledTimes(2))
  })

  it('mode access, access VLAN and native VLAN each stage the client-pinned text', async () => {
    const { node, session } = makeFakes()
    await ready(node)

    await stage('Port-Channel1', 'set-mode', async () => { await userEvent.selectOptions(screen.getByLabelText('Switchport mode'), 'access') })
    await screen.findByText(/Review the device diff/u)
    expect(session.run).toHaveBeenLastCalledWith(['interface Port-Channel1', 'switchport mode access'])
    await abortDraft(session)

    await stage('Ethernet1', 'access-vlan', async () => { await userEvent.type(screen.getByLabelText('Access VLAN'), '20') })
    await screen.findByText(/Review the device diff/u)
    expect(session.run).toHaveBeenLastCalledWith(['interface Ethernet1', 'switchport access vlan 20'])
    await userEvent.click(screen.getByRole('button', { name: 'Commit to running-config' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Set access VLAN 20 on Ethernet1' }))
    expect(session.commit).toHaveBeenCalledOnce()

    await stage('Ethernet2', 'native-vlan', async () => { await userEvent.type(screen.getByLabelText('Native VLAN'), '200') })
    await screen.findByText(/Review the device diff/u)
    expect(session.run).toHaveBeenLastCalledWith(['interface Ethernet2', 'switchport trunk native vlan 200'])
    expect(session.commit).toHaveBeenCalledTimes(1)
  })

  it('clearing a native VLAN sends the negated line and names it in the confirm', async () => {
    const { node, session } = makeFakes()
    await ready(node)

    await stage('Ethernet2', 'no-native-vlan')
    await screen.findByText(/Review the device diff/u)
    expect(session.run).toHaveBeenLastCalledWith(['interface Ethernet2', 'no switchport trunk native vlan'])
    await userEvent.click(screen.getByRole('button', { name: 'Commit to running-config' }))
    const prompt = await screen.findByRole('dialog')
    expect(within(prompt).getByText(/is what the device answered as staged/u)).toBeInTheDocument()
    await userEvent.click(within(prompt).getByRole('button', { name: 'Clear the native VLAN on Ethernet2' }))
    expect(session.commit).toHaveBeenCalledOnce()
  })

  it('the allowed-VLAN editor adds, removes and replaces by recomputing the whole list', async () => {
    const { node, session } = makeFakes()
    await ready(node)

    await stage('Ethernet2', 'allowed-add', async () => { await userEvent.type(screen.getByLabelText('Allowed VLAN ranges'), '23,30-31') })
    await screen.findByText(/Review the device diff/u)
    expect(session.run).toHaveBeenLastCalledWith(['interface Ethernet2', 'switchport trunk allowed vlan 10-12,20,23,30-31'])
    await abortDraft(session)

    await stage('Ethernet2', 'allowed-remove', async () => { await userEvent.type(screen.getByLabelText('Allowed VLAN ranges'), '11-12') })
    await screen.findByText(/Review the device diff/u)
    expect(session.run).toHaveBeenLastCalledWith(['interface Ethernet2', 'switchport trunk allowed vlan 10,20'])
    await abortDraft(session)

    // A keyword spelling is writeable by explicit replacement only — its members are never assumed.
    await stage('Port-Channel10', 'allowed-replace', async () => { await userEvent.type(screen.getByLabelText('Allowed VLAN ranges'), '5-6,9') })
    await screen.findByText(/Review the device diff/u)
    expect(session.run).toHaveBeenLastCalledWith(['interface Port-Channel10', 'switchport trunk allowed vlan 5-6,9'])
  })

  it('clearing the allowed list sends the negated form instead of an empty list', async () => {
    const { node, session } = makeFakes()
    await ready(node)

    await stage('Ethernet2', 'no-allowed')
    await screen.findByText(/Review the device diff/u)
    expect(session.run).toHaveBeenLastCalledWith(['interface Ethernet2', 'no switchport trunk allowed vlan'])
    await userEvent.click(screen.getByRole('button', { name: 'Commit to running-config' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Clear the allowed VLAN list on Ethernet2' }))
    expect(session.commit).toHaveBeenCalledOnce()
  })

  it('adding onto a port with no allowed line writes the list, and refuses an unreadable current spelling', async () => {
    const switchports = switchportTable()
    switchports.set('Ethernet7', { interfaceName: 'Ethernet7', mode: 'trunk', trunkAllowedVlans: '1,', trunkGroups: [] })
    const { node, session } = makeFakes({ switchports })
    await ready(node)

    // "No line" is an empty set, so an add is a plain write — the screen says so through the argv.
    await stage('Ethernet3', 'allowed-add', async () => { await userEvent.type(screen.getByLabelText('Allowed VLAN ranges'), '5') })
    await screen.findByText(/Review the device diff/u)
    expect(session.run).toHaveBeenLastCalledWith(['interface Ethernet3', 'switchport trunk allowed vlan 5'])
    await abortDraft(session)

    // A current spelling the client would never write is refused by name: no members are inferred from it.
    await stage('Ethernet7', 'allowed-add', async () => { await userEvent.type(screen.getByLabelText('Allowed VLAN ranges'), '20') })
    const alert = await screen.findByText(/is not something this client would write/u)
    expect(alert).toHaveTextContent('looks like an id list but is not one')
    expect(session.run).toHaveBeenLastCalledWith(['interface Ethernet3', 'switchport trunk allowed vlan 5'])
  })

  it('hard-confirms writing the eAPI VLAN as a new native VLAN, naming the id being written', async () => {
    const { node, session } = makeFakes()
    await ready(node)

    await stage('Port-Channel10', 'native-vlan', async () => { await userEvent.type(screen.getByLabelText('Native VLAN'), '100') })
    await screen.findByText(/Review the device diff/u)
    expect(within(notices()).getByText(/The native VLAN you are writing, VLAN 100/u)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Commit to running-config' }))
    const prompt = await screen.findByRole('dialog')
    expect(within(prompt).getByText(/native VLAN you are writing, VLAN 100/u)).toBeInTheDocument()
    await userEvent.click(within(prompt).getByRole('button', { name: 'Commit despite the VLAN 100 risk' }))
    expect(session.run).toHaveBeenLastCalledWith(['interface Port-Channel10', 'switchport trunk native vlan 100'])
    expect(session.commit).toHaveBeenCalledOnce()
  })

  it('an add/remove over a keyword spelling is refused pre-wire, and no session is opened', async () => {
    const { node, session } = makeFakes()
    await ready(node)

    await stage('Port-Channel10', 'allowed-add', async () => { await userEvent.type(screen.getByLabelText('Allowed VLAN ranges'), '20') })

    const alert = await screen.findByText(/no enumerable allowed-VLAN set/u)
    expect(alert).toHaveTextContent('DR-028')
    expect(session.run).not.toHaveBeenCalled()
    expect(session.commit).not.toHaveBeenCalled()
    expect(session.run).not.toHaveBeenCalled()
  })

  it('an edit that empties the allowed list is refused with the client rule and the way out', async () => {
    const { node, session } = makeFakes()
    await ready(node)

    await stage('Ethernet2', 'allowed-remove', async () => { await userEvent.type(screen.getByLabelText('Allowed VLAN ranges'), '10-20') })

    const alert = await screen.findByText(/refuses an empty allowed-VLAN list/u)
    expect(alert).toHaveTextContent('Clear allowed VLAN list')
    expect(session.run).not.toHaveBeenCalled()
  })

  it('an invalid range grammar and a no-op edit are refused before a session, not sent to the device', async () => {
    const { node, session } = makeFakes()
    await ready(node)

    await stage('Ethernet2', 'allowed-add', async () => { await userEvent.type(screen.getByLabelText('Allowed VLAN ranges'), '1,') })
    expect(await screen.findByRole('alert')).toHaveTextContent(/looks like an id list but is not one/u)
    expect(session.run).not.toHaveBeenCalled()

    await chooseAction('allowed-replace')
    await userEvent.clear(screen.getByLabelText('Allowed VLAN ranges'))
    await userEvent.type(screen.getByLabelText('Allowed VLAN ranges'), '10-12,20')
    await userEvent.click(screen.getByRole('button', { name: 'Preview change' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Nothing would change, so no config session was opened/u)

    await userEvent.clear(screen.getByLabelText('Allowed VLAN ranges'))
    await userEvent.click(screen.getByRole('button', { name: 'Preview change' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/needs a value/u)
    expect(session.run).not.toHaveBeenCalled()
    expect(session.run).not.toHaveBeenCalled()
    expect(session.commit).not.toHaveBeenCalled()
  })

  it('a bad VLAN id is refused with the client bound named, without opening a session', async () => {
    const { node, session } = makeFakes()
    await ready(node)

    for (const bad of ['', '0', '12.5', '9999']) {
      await userEvent.selectOptions(screen.getByLabelText('Interface'), 'Ethernet2')
      await chooseAction('native-vlan')
      const field = screen.getByLabelText('Native VLAN') as HTMLInputElement
      // fireEvent rather than userEvent: an empty string is not a keystroke, and the guard must be the
      // only thing standing between this value and the device.
      fireEvent.change(field, { target: { value: bad } })
      await userEvent.click(screen.getByRole('button', { name: 'Preview change' }))
      const alerts = await screen.findAllByRole('alert')
      const message = alerts.map((alert) => alert.textContent ?? '').join(' ')
      expect(/outside the 1\.\.4094 write range|is not a whole VLAN id/u.test(message), bad).toBe(true)
      if (bad === '9999') expect(message).toContain('DR-059')
    }
    expect(session.run).not.toHaveBeenCalled()
    expect(session.run).not.toHaveBeenCalled()
    expect(session.commit).not.toHaveBeenCalled()
  })

  it('hard-confirms a native-VLAN change on the trunk whose native VLAN serves eAPI, naming the VLAN', async () => {
    const { node, session } = makeFakes()
    await ready(node)

    await stage('Port-Channel1', 'native-vlan', async () => { await userEvent.type(screen.getByLabelText('Native VLAN'), '200') })
    await screen.findByText(/Review the device diff/u)
    // The pre-stage warning is visible before anything is staged, exactly like S1/S2's in-before-you-delete rule.
    expect(within(notices()).getByText(/VLAN 100 is the trunk native VLAN on Port-Channel1/u)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Commit to running-config' }))
    const prompt = await screen.findByRole('dialog')
    expect(within(prompt).getByText(/Confirm management-path risk on Port-Channel1/u)).toBeInTheDocument()
    expect(within(prompt).getByText(/VLAN 100 is the trunk native VLAN/u)).toBeInTheDocument()
    expect(within(prompt).getByText(/may drop the management path this UI is using/u)).toBeInTheDocument()
    await userEvent.click(within(prompt).getByRole('button', { name: 'Cancel' }))
    expect(session.commit).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'Commit to running-config' }))
    const again = await screen.findByRole('dialog')
    await userEvent.click(within(again).getByRole('button', { name: 'Commit despite the VLAN 100 risk' }))
    expect(session.commit).toHaveBeenCalledOnce()
    expect(session.abort).not.toHaveBeenCalled()
  })

  it('hard-confirms a trunk-mode write on the access port sitting in the eAPI VLAN', async () => {
    const { node, session } = makeFakes()
    await ready(node)

    await stage('Ethernet1', 'set-mode', async () => { await userEvent.selectOptions(screen.getByLabelText('Switchport mode'), 'trunk') })
    await screen.findByText(/Review the device diff/u)
    const notice = within(notices()).getByText(/is currently an access port in VLAN 100/u)
    expect(notice).toHaveTextContent('unproven on this box (no hardware pin)')

    await userEvent.click(screen.getByRole('button', { name: 'Commit to running-config' }))
    const prompt = await screen.findByRole('dialog')
    expect(within(prompt).getByText(/access port in VLAN 100/u)).toBeInTheDocument()
    await userEvent.click(within(prompt).getByRole('button', { name: 'Commit despite the VLAN 100 risk' }))
    expect(session.run).toHaveBeenLastCalledWith(['interface Ethernet1', 'switchport mode trunk'])
    expect(session.commit).toHaveBeenCalledOnce()
  })

  it('a port with no management-VLAN signal gets the ordinary confirm, and its risks say nothing was claimed', async () => {
    const { node } = makeFakes()
    await ready(node)

    await stage('Ethernet2', 'allowed-add', async () => { await userEvent.type(screen.getByLabelText('Allowed VLAN ranges'), '300') })
    await screen.findByText(/Review the device diff/u)
    await userEvent.click(screen.getByRole('button', { name: 'Commit to running-config' }))
    const prompt = await screen.findByRole('dialog')
    expect(within(prompt).getByRole('button', { name: 'Write the allowed VLAN list on Ethernet2' })).toBeInTheDocument()
    expect(within(prompt).getByText(/which keyword forms/u)).toBeInTheDocument()
    await userEvent.click(within(prompt).getByRole('button', { name: 'Cancel' }))
  })

  it('a staged session blocks another preview and aborts only after a confirm', async () => {
    const { node, session } = makeFakes()
    await ready(node)

    await stage('Ethernet2', 'no-allowed')
    await screen.findByText(/Review the device diff/u)
    expect(screen.getByRole('button', { name: 'Preview change' })).toBeDisabled()
    expect(screen.getByText(/A staged change is already open in session/u)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Abort staged changes' }))
    const prompt = await screen.findByRole('dialog')
    expect(within(prompt).getByText(/no switchport trunk allowed vlan/u)).toBeInTheDocument()
    await userEvent.click(within(prompt).getByRole('button', { name: 'Cancel' }))
    expect(session.abort).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'Abort staged changes' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Abort staged changes' }))
    expect(session.abort).toHaveBeenCalledOnce()
    expect(await screen.findByRole('button', { name: 'Preview change' })).toBeEnabled()
  })

  it('a commit with no diff read cannot be armed, and a failed commit stays marked attempted', async () => {
    const { node, session } = makeFakes({}, false)
    await ready(node)

    await stage('Ethernet2', 'set-mode', async () => { await userEvent.selectOptions(screen.getByLabelText('Switchport mode'), 'trunk') })
    await screen.findByText(/Review the device diff/u)
    expect(screen.getByRole('button', { name: 'Commit to running-config' })).toBeDisabled()
    expect(session.commit).not.toHaveBeenCalled()
  })

  it('switching the port discards unstaged edits so they can never be staged against another port', async () => {
    const { node, session } = makeFakes()
    await ready(node)

    await userEvent.selectOptions(screen.getByLabelText('Interface'), 'Ethernet2')
    await chooseAction('allowed-add')
    await userEvent.type(screen.getByLabelText('Allowed VLAN ranges'), '777')
    expect(within(notices()).getByText(/These edits are local/u)).toBeInTheDocument()

    await userEvent.selectOptions(screen.getByLabelText('Interface'), 'Port-Channel1')
    expect((screen.getByLabelText('Allowed VLAN ranges') as HTMLInputElement).value).toBe('')
    expect(within(notices()).getByText(/Edits for Ethernet2 were cleared without being staged/u)).toBeInTheDocument()

    await userEvent.type(screen.getByLabelText('Allowed VLAN ranges'), '40')
    await userEvent.click(screen.getByRole('button', { name: 'Preview change' }))
    await screen.findByText(/Review the device diff/u)
    // The recomputed list belongs to the newly selected port, never to the abandoned one — and it is the
    // canonical collapsed form, with no trace of the 777 typed for the other port.
    expect(session.run).toHaveBeenLastCalledWith(['interface Port-Channel1', 'switchport trunk allowed vlan 1-7,40'])
    expect(session.commit).not.toHaveBeenCalled()
  })

  it('a name this client cannot write is listed with the write controls shut', async () => {
    const { node, session } = makeFakes()
    await ready(node)

    await userEvent.selectOptions(screen.getByLabelText('Interface'), 'Ethernet49/1')
    expect(await screen.findByText(/is listed but not writable here/u)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Preview change' })).toBeDisabled()
    expect(session.run).not.toHaveBeenCalled()
    expect(session.commit).not.toHaveBeenCalled()
  })

  it('a pending device session offers the config-lock cleanup and writes nothing until confirmed', async () => {
    const { node } = makeFakes({ listSessions: async () => ({ sessions: [{ name: 'stale-pending', state: 'pending', description: 'left over' }] }) })
    await ready(node)

    await userEvent.click(await screen.findByRole('button', { name: 'Abort pending session' }))
    const prompt = await screen.findByRole('dialog')
    expect(within(prompt).getByText(/holds the config lock/u)).toBeInTheDocument()
    await userEvent.click(within(prompt).getByRole('button', { name: 'Cancel' }))
    expect(node.abortSession).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'Abort pending session' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Abort pending session' }))
    expect(node.abortSession).toHaveBeenCalledWith('stale-pending')
  })
})

async function abortDraft(session: ConfigSession & SessionFakes) {
  await userEvent.click(screen.getByRole('button', { name: 'Abort staged changes' }))
  await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Abort staged changes' }))
  await screen.findByText(/was aborted; nothing was written to the device/u)
  expect(session.abort).toHaveBeenCalled()
}

describe('TrunkEditor — the trunk-group capability gate (#67 F5, #73\u2019s probe question)', () => {
  it('asks with exactly this screen\u2019s candidates, in a session that validates and aborts, never commits', async () => {
    const { node, session, probe } = makeFakes()
    await ready(node)

    // The question on the record is this screen's own — the hardware sweep's accepted block, probed
    // (never committed) on the scratch port it used.
    expect(probe.validateChanges).toHaveBeenCalledWith(['interface Ethernet22', 'switchport trunk group webui-probe'], {})
    expect(node.configSession).toHaveBeenCalledOnce()
    expect(session.run).not.toHaveBeenCalled()
    // DR-063 seen from the caller's side: the probe session is aborted and never committed.
    expect(probe.abort).toHaveBeenCalledOnce()
    expect(probe.commit).not.toHaveBeenCalled()
    // And the write session was never opened or committed by the probe.
    expect(session.commit).not.toHaveBeenCalled()
    expect(session.run).not.toHaveBeenCalled()

    expect(await screen.findByText('Trunk-group probe:')).toHaveTextContent('available')
    expect(screen.getByText('The device accepted the probe candidates, so the trunk-group actions above are enabled.')).toBeInTheDocument()
  })

  it('sends no group command while the probe has not answered: a stuck probe keeps the gate shut', async () => {
    const { node, session } = makeFakes({ probe: 'pending' })
    await ready(node)

    expect(screen.getByText('Trunk-group probe:')).toHaveTextContent('unknown')
    await userEvent.selectOptions(screen.getByLabelText('Interface'), 'Ethernet2')
    await chooseAction('add-trunk-group')
    const field = screen.getByLabelText('Trunk group') as HTMLInputElement
    expect(field).toBeDisabled()
    await userEvent.type(field, 'LAB')
    await userEvent.click(screen.getByRole('button', { name: 'Preview change' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Trunk-group changes are probe-gated')
    // The gate is the write path itself: nothing was staged, and the only session opened is the probe's.
    expect(session.run).not.toHaveBeenCalled()
    expect(session.commit).not.toHaveBeenCalled()
  })

  it('a 1002 on the candidate reads unavailable, quotes the probe\u2019s own reason, and keeps the gate shut', async () => {
    const { node, session, probe } = makeFakes({ probe: 'rejected-1002' })
    await ready(node)

    expect(await screen.findByText('Trunk-group probe:')).toHaveTextContent('unavailable')
    expect(screen.getByText(/switchport trunk group webui-probe: 1002/u)).toBeInTheDocument()
    expect(probe.abort).toHaveBeenCalledOnce()

    await chooseAction('remove-trunk-group')
    await userEvent.click(screen.getByRole('button', { name: 'Preview change' }))
    expect((await screen.findAllByRole('alert')).some((n) => /probe-gated/u.test(n.textContent ?? ''))).toBe(true)
    expect(session.run).not.toHaveBeenCalled()
  })

  it('a probe that fails outright is a failure on the record, never an answer', async () => {
    const { node, session } = makeFakes({ probe: 'failed' })
    await ready(node)

    expect(await screen.findByRole('alert')).toHaveTextContent('Probe failed: device unreachable')
    expect(screen.getByText('Trunk-group probe:')).toHaveTextContent('unknown')
    expect(screen.getByText('Trunk-group actions stay refused while the verdict is unknown. An inconclusive probe is never treated as support.')).toBeInTheDocument()
    expect(session.run).not.toHaveBeenCalled()
  })

  it('with an available verdict, group add and remove stage exactly the interface-submode lines the sweep staged', async () => {
    const { node, session, probe } = makeFakes()
    await ready(node)
    await screen.findByText('Trunk-group probe:')

    await userEvent.selectOptions(screen.getByLabelText('Interface'), 'Ethernet2')
    await chooseAction('add-trunk-group')
    const field = screen.getByLabelText('Trunk group')
    expect(field).toBeEnabled()
    await userEvent.type(field, 'LABGRP')
    await userEvent.click(screen.getByRole('button', { name: 'Preview change' }))
    await screen.findByText(/Review the device diff/u)
    expect(session.run).toHaveBeenLastCalledWith(['interface Ethernet2', 'switchport trunk group LABGRP'])

    await userEvent.click(screen.getByRole('button', { name: 'Abort staged changes' }))
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Abort staged changes' })).getByRole('button', { name: 'Abort staged changes' }))

    await chooseAction('remove-trunk-group')
    expect((field as HTMLInputElement).value).toBe('LABGRP') // the field is not silently wiped
    await userEvent.clear(field)
    await userEvent.type(field, 'LABGRP')
    await userEvent.click(screen.getByRole('button', { name: 'Preview change' }))
    await screen.findByText(/Review the device diff/u)
    expect(session.run).toHaveBeenLastCalledWith(['interface Ethernet2', 'no switchport trunk group LABGRP'])

    // Selecting the intent itself re-asks the question (a fresh answer after the sweep of edits),
    // bounded by the client's throttle/cache — every run here went through the same probe session.
    expect(probe.abort).toHaveBeenCalledOnce()
  })

  it('a repeat probe request inside the rate-limit window opens no second config session', async () => {
    const { node, session, probe } = makeFakes()
    await ready(node)
    await screen.findByText('Trunk-group probe:')

    await userEvent.click(screen.getByRole('button', { name: 'Re-run capability probe' }))

    expect(await screen.findByText(/rate-limit window/u)).toBeInTheDocument()
    expect(probe.validateChanges).toHaveBeenCalledOnce()
    expect(node.configSession).toHaveBeenCalledOnce()
    expect(session.run).not.toHaveBeenCalled()
  })

  it('name checks mirror the client after the gate: empty and multi-word group names never reach run()', async () => {
    const { node, session } = makeFakes()
    await ready(node)
    await screen.findByText('Trunk-group probe:')

    await userEvent.selectOptions(screen.getByLabelText('Interface'), 'Ethernet2')
    await chooseAction('add-trunk-group')

    await userEvent.click(screen.getByRole('button', { name: 'Preview change' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('A trunk-group name needs (assertTrunkGroupName)')
    await userEvent.type(screen.getByLabelText('Trunk group'), 'two words')
    await userEvent.click(screen.getByRole('button', { name: 'Preview change' }))
    await screen.findByRole('alert')
    expect((await screen.findAllByRole('alert')).some((n) => /single token/u.test(n.textContent ?? ''))).toBe(true)
    expect(session.run).not.toHaveBeenCalled()
  })

  it('the table shows each port\u2019s parsed group lines as running-config text, with the enforcement question left open', async () => {
    await ready(makeFakes().node)

    // Port-Channel1 carries LABGRP in the parsed running-config...
    expect(screen.getByText('LABGRP')).toBeInTheDocument()
    expect(screen.getAllByText(/parsed running-config lines; the SKU.s enforcement is unproven/u).length).toBeGreaterThan(0)
    // ...and rows with no group line say the read found none, without implying the SKU lacks the verb.
    expect(screen.getAllByText(/none configured, or support is absent and the CLI line was probed only/u).length).toBeGreaterThan(0)
  })

  it('a pending session the probe listed can be aborted, and nothing is written by the cleanup', async () => {
    const { node, probe } = makeFakes({ probe: 'failed', listSessions: async () => ({ sessions: [{ name: 'stale-pending', state: 'pending', description: 'locked' }] }) })
    await ready(node)

    expect(await screen.findByText('Sessions the probe found pending')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Abort pending session' }))
    expect(node.abortSession).toHaveBeenCalledWith('stale-pending')
    expect(probe.commit).not.toHaveBeenCalled()
  })

  it('an unconfigured proxy asks the device nothing at all', async () => {
    const { node, probe } = makeFakes()
    render(<TrunkEditor node={node} proxyConfigured={false} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('EAPI_HOST')
    expect(session.run).not.toHaveBeenCalled()
    expect(session.commit).not.toHaveBeenCalled()
    expect(probe.validateChanges).not.toHaveBeenCalled()
    expect(node.listSessions).not.toHaveBeenCalled()
  })
})

describe('TrunkEditorView — presentation only', () => {
  const baseFields: TrunkFields = { port: 'Ethernet2', action: 'set-mode', mode: 'trunk', accessVlan: '', nativeVlan: '', allowedRanges: '', trunkGroup: '' }
  const noop = () => undefined

  /** The capability verdict this presentation-only harness pretends the container computed. Never
   *  probed here — the point is that the view renders whatever the container answered. */
  const capability: TrunkCapabilityView = {
    verdict: 'unknown',
    status: 'idle',
    fromCache: false,
    configLocked: false,
    probePendingSessions: [],
    probeFailure: '',
    suppressedCount: 0,
    canProbe: true,
    probeBusy: false,
  }

  const rows: readonly TrunkPortRow[] = [
    { name: 'Ethernet1', kind: 'Ethernet', editable: true, mode: 'access', modeKnown: true, accessVlan: 1, nativeIsManagement: false, accessIsManagement: false, hasAddress: false, hasSwitchportRecord: true, allowedEnumerable: false, trunkGroups: [] },
    { name: 'Ethernet2', kind: 'Ethernet', editable: true, mode: 'trunk', modeKnown: true, nativeVlan: 10, allowedRaw: '10-12,20', allowedEnumerable: true, allowedDisplay: '10-12,20', nativeIsManagement: true, accessIsManagement: false, hasAddress: true, hasSwitchportRecord: true, trunkGroups: ['LABGRP'] },
    { name: 'Port-Channel10', kind: 'Port-Channel', editable: true, mode: 'tunnel', modeKnown: false, allowedRaw: 'all', allowedEnumerable: false, allowedNote: 'keyword spelling, not enumerable here (DR-028)', nativeIsManagement: false, accessIsManagement: false, hasAddress: false, hasSwitchportRecord: false, trunkGroups: [] },
    { name: 'Ethernet49/1', kind: 'Unrecognised', editable: false, modeKnown: false, nativeIsManagement: false, accessIsManagement: false, hasAddress: false, hasSwitchportRecord: true, allowedEnumerable: false, trunkGroups: [] },
  ]

  const data: TrunkReadyData = {
    rows,
    vlanOptions: [{ id: 10, name: 'NATIVE' }, { id: 20 }],
    sessions: [{ name: 'ui-s3-session', state: 'pending', description: 'webui trunk set mode' }, { name: 'other', state: 'open' }],
    managementInterfaces: ['Vlan100'],
  }

  const props = (over: Partial<Parameters<typeof TrunkEditorView>[0]> = {}) => ({
    load: { kind: 'ready', data } as TrunkLoadState,
    connection: 'connected' as const,
    fields: baseFields,
    modes: ['access', 'trunk', 'dot1q-tunnel', 'private-vlan'],
    canWrite: true,
    busy: false,
    failure: '',
    notice: '',
    onFieldChange: noop,
    onPreview: noop,
    onCommit: noop,
    onAbortDraft: noop,
    onReload: noop,
    onAbortPending: noop,
    capability,
    probeCandidates: ['interface Ethernet22', 'switchport trunk group webui-probe'],
    onProbe: noop,
    onAbortProbePending: noop,
    ...over,
  })

  /** The view is fully controlled, so an action/arm change only appears when a host feeds `fields` back.
   *  This stand-in host is not the container — no client seam, no reads — it is what proves the
   *  `onFieldChange` contract is the only way a control changes the screen. */
  function Harness(over: Partial<Parameters<typeof TrunkEditorView>[0]>) {
    const [fields, setFields] = useState<TrunkFields>(over.fields ?? baseFields)
    function change(field: TrunkFieldKey, value: string) {
      setFields((current) => ({ ...current, [field]: value }))
      over.onFieldChange?.(field, value)
    }
    return <TrunkEditorView {...props({ ...over, fields, onFieldChange: change })} />
  }

  it('renders the loading arm without a table and the error arm with a retry', () => {
    render(<TrunkEditorView {...props({ load: { kind: 'loading' } })} />)
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh state' })).toBeDisabled()
  })

  it('an error arm is an alert plus a retry control, and no retry without a device handle', async () => {
    const onReload = vi.fn()
    const view = render(<TrunkEditorView {...props({ load: { kind: 'error', message: 'connection refused' }, onReload })} />)
    expect(screen.getByRole('alert')).toHaveTextContent('connection refused')
    await userEvent.click(screen.getByRole('button', { name: 'Retry read' }))
    expect(onReload).toHaveBeenCalledOnce()
    view.unmount()

    render(<TrunkEditorView {...props({ load: { kind: 'error', message: 'no proxy' }, canWrite: false })} />)
    expect(screen.queryByRole('button', { name: 'Retry read' })).not.toBeInTheDocument()
  })

  it('the ready arm labels the reads, states the trunk-group refusal, and keeps the identity chip optional', async () => {
    render(<Harness identity={{ hostname: 'sw1', version: '4.28.13.1M', model: 'DCS-7050TX-64' }} />)

    expect(screen.getByText('Connected through local proxy')).toBeInTheDocument()
    expect(screen.getByText('sw1 · EOS 4.28.13.1M · DCS-7050TX-64')).toBeInTheDocument()
    const note = screen.getByText(/^Every value on this screen is a/u)
    expect(note).toHaveTextContent('Trunk-group editing is out of scope')
    expect(note).toHaveTextContent('parsed show running-config line')
    // The VLAN read reached the datalist the VLAN fields offer, as ids plus names.
    await userEvent.selectOptions(screen.getByLabelText('Interface'), 'Port-Channel10')
    expect(within(screen.getByLabelText('Interface')).getByRole('option', { name: /Port-Channel10/u })).toBeInTheDocument()
    await userEvent.selectOptions(screen.getByLabelText('Change'), 'native-vlan')
    // The VLAN suggestions are wired to the id field, not invented from a fixed range.
    expect(screen.getByLabelText('Native VLAN')).toHaveAttribute('list', 'trunk-vlan-options')
  })

  it('renders every column, the mode-pill tone split, and the honest allowed/management flags', () => {
    render(<TrunkEditorView {...props()} />)

    for (const header of ['Interface', 'Mode', 'Access VLAN', 'Native VLAN', 'Allowed VLANs', 'Management path']) {
      expect(screen.getByRole('columnheader', { name: header })).toBeInTheDocument()
    }
    // A device spelling that already equals the collapsed form is not printed twice in the table (the
    // current-state panel repeats it once, which is a different region).
    expect(within(screen.getByRole('table', { name: 'Layer 2 ports' })).getAllByText('10-12,20')).toHaveLength(1)
    expect(screen.getByText('outside this client’s four modes')).toBeInTheDocument()
    // No mode line at all is a third answer, rendered as words rather than a blank or a guess.
    expect(screen.getByText('Not reported')).toBeInTheDocument()
    expect(screen.getByText('keyword spelling, not enumerable here (DR-028)')).toBeInTheDocument()
    expect(screen.getByText('no switchport line read')).toBeInTheDocument()
    expect(screen.getByText('name this client cannot write')).toBeInTheDocument()
    expect(screen.getByText('name this client cannot parse')).toBeInTheDocument()
    expect(screen.getAllByText('Native VLAN is the eAPI VLAN')).toHaveLength(1)
    expect(screen.getAllByText('Carries an IP address')).toHaveLength(1)
    expect(screen.getAllByText('No management-path signal read')).toHaveLength(3)
    // Absence rendered as text, never as a blank cell or a zero.
    expect(screen.getAllByText('Not configured').length).toBeGreaterThan(1)
  })

  it('shows each action its own field for, with a labelled input and the VLAN suggestions', async () => {
    const onFieldChange = vi.fn()
    render(<Harness onFieldChange={onFieldChange} />)

    const actionSelect = screen.getByLabelText('Change')
    expect(within(actionSelect).getAllByRole('option')).toHaveLength(Object.keys(TRUNK_ACTION_LABELS).length)

    await userEvent.selectOptions(actionSelect, 'access-vlan')
    expect(onFieldChange).toHaveBeenCalledWith('action', 'access-vlan')
    await userEvent.type(screen.getByLabelText('Access VLAN'), '2')
    expect(onFieldChange).toHaveBeenCalledWith('accessVlan', '2')
    expect(screen.getByText(/Suggested from the VLAN table/u)).toBeInTheDocument()

    await userEvent.selectOptions(actionSelect, 'native-vlan')
    await userEvent.type(screen.getByLabelText('Native VLAN'), '3')
    expect(onFieldChange).toHaveBeenCalledWith('nativeVlan', '3')
    expect(screen.queryByLabelText('Access VLAN')).not.toBeInTheDocument()

    await userEvent.selectOptions(actionSelect, 'allowed-remove')
    await userEvent.type(screen.getByLabelText('Allowed VLAN ranges'), '7')
    expect(onFieldChange).toHaveBeenCalledWith('allowedRanges', '7')
    expect(screen.getByText(/never expanded into members \(DR-028\)/u)).toBeInTheDocument()

    await userEvent.selectOptions(actionSelect, 'no-allowed')
    expect(screen.queryByLabelText('Allowed VLAN ranges')).not.toBeInTheDocument()
    expect(screen.getByText(/sends the negated form of one line/u)).toBeInTheDocument()

    await userEvent.selectOptions(actionSelect, 'set-mode')
    await userEvent.selectOptions(screen.getByLabelText('Switchport mode'), 'dot1q-tunnel')
    expect(onFieldChange).toHaveBeenLastCalledWith('mode', 'dot1q-tunnel')

    for (const action of ['add-trunk-group', 'remove-trunk-group'] as const) {
      await userEvent.selectOptions(actionSelect, action)
      const groupField = screen.getByLabelText('Trunk group') as HTMLInputElement
      // The group field is only shut behind a verdict this component does not own: the container passes
      // the capability answer down, and the markup keeps the control visible to say *why* it is off.
      expect(groupField).toBeEnabled()
      await userEvent.type(groupField, 'LAB')
      expect(onFieldChange).toHaveBeenLastCalledWith('trunkGroup', 'LAB')
      expect(screen.getByText(/probe-gated/u)).toBeInTheDocument()
    }
  })

  it('an empty ready arm says so beside the port select and keeps the form honest about it', () => {
    render(<TrunkEditorView {...props({ load: { kind: 'ready', data: { ...data, rows: [], vlanOptions: [], sessions: [] } } })} />)

    expect(screen.getByText('The device configured no Ethernet or Port-Channel switchport section.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Preview change' })).toBeDisabled()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.getByText(/The VLAN table came back empty/u)).toBeInTheDocument()
  })

  it('renders the current state of the selected port, including a non-enumerable allowed spelling', () => {
    render(<TrunkEditorView {...props({ fields: { ...baseFields, port: 'Port-Channel10' } })} />)

    const state = screen.getByText('Current mode').parentElement as HTMLElement
    expect(within(state).getByText('tunnel')).toBeInTheDocument()
    expect(within(state).getByText('all')).toBeInTheDocument()
    expect(within(state).getByText('(device spelling, not enumerable here)')).toBeInTheDocument()
    expect(within(state).getAllByText('Not configured')).toHaveLength(2)

    // A port whose section writes no mode line gets the words, not a blank.
    render(<TrunkEditorView {...props({ fields: { ...baseFields, port: 'Ethernet49/1' } })} />)
    const second = screen.getAllByText('Current mode').at(-1)?.parentElement as HTMLElement
    expect(within(second).getByText('Not reported')).toBeInTheDocument()
    expect(within(second).getAllByText('Not configured')).toHaveLength(3)
  })

  it('surfaces container messages by tone, aria-live, and names the risks in a draft', () => {
    const draft: TrunkDraftView = {
      sessionName: 'ui-s3-session',
      sessionState: 'diffed',
      batch: ['interface Port-Channel1', 'switchport trunk native vlan 200'],
      diff: '+interface Port-Channel1\n+ switchport trunk native vlan 200',
      commitAttempted: false,
      diffRead: true,
      canAbort: true,
      risks: ['VLAN 100 is the trunk native VLAN on Port-Channel1'],
    }
    render(<TrunkEditorView {...props({ fields: { ...baseFields, port: 'Port-Channel1', action: 'native-vlan', nativeVlan: '200' }, draft, messages: [{ tone: 'risk', text: 'VLAN 100 is the trunk native VLAN on Port-Channel1' }, { tone: 'success', text: 'Device state was re-read from the running-config after the commit.' }] })} />)

    expect(screen.getByRole('list', { name: 'Risks named in the confirm prompt' })).toHaveTextContent('VLAN 100 is the trunk native VLAN on Port-Channel1')
    const staged = screen.getByText('interface Port-Channel1')
    expect(within(staged.parentElement as HTMLElement).getByText('switchport trunk native vlan 200')).toBeInTheDocument()
    expect(screen.getByLabelText('Native VLAN')).toHaveValue('200')

    const stack = screen.getByRole('list', { name: 'What this screen knows about the current selection' })
    const live = within(stack).getByText('Device state was re-read from the running-config after the commit.')
    expect(live).toHaveAttribute('aria-live', 'polite')
    expect(live).toHaveClass('notice-success')
    expect(within(stack).getByText('VLAN 100 is the trunk native VLAN on Port-Channel1')).toHaveClass('notice-warning')
  })

  it('gates commit on the diff, its read, and an attempted commit, and abort on the session state', () => {
    const unstaged: TrunkDraftView = { sessionName: 's', sessionState: 'open', batch: ['interface Ethernet2'], commitAttempted: false, diffRead: false, canAbort: true, risks: [] }
    const first = render(<TrunkEditorView {...props({ draft: unstaged })} />)
    expect(screen.getByRole('button', { name: 'Commit to running-config' })).toBeDisabled()
    expect(screen.getByText(/A diff is required before commit/u)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Preview change' })).toBeDisabled()
    expect(screen.getByText(/A staged change is already open in session/u)).toBeInTheDocument()
    first.unmount()

    const attempted: TrunkDraftView = { ...unstaged, diff: '+x', diffRead: true, commitAttempted: true }
    const second = render(<TrunkEditorView {...props({ draft: attempted })} />)
    expect(screen.getByRole('button', { name: 'Commit to running-config' })).toBeDisabled()
    expect(screen.getByText(/Commit was attempted; refresh device state/u)).toBeInTheDocument()
    second.unmount()

    const sealed: TrunkDraftView = { ...unstaged, diff: '+x', diffRead: true, canAbort: false, sessionState: 'aborted' }
    render(<TrunkEditorView {...props({ draft: sealed })} />)
    expect(screen.getByRole('button', { name: 'Abort staged changes' })).toBeDisabled()
  })

  it('fires the callbacks the container wired, for fields, sessions and the operation result slots', async () => {
    const onFieldChange = vi.fn()
    const onCommit = vi.fn()
    const onAbortDraft = vi.fn()
    const onAbortPending = vi.fn()
    const draft: TrunkDraftView = { sessionName: 's', sessionState: 'diffed', batch: ['interface Ethernet2', 'no switchport mode'], diff: '+x', commitAttempted: false, diffRead: true, canAbort: true, risks: [] }
    render(<TrunkEditorView {...props({ draft, onFieldChange, onCommit, onAbortDraft, onAbortPending, failure: 'Preview failed: 1006 config locked', notice: 'Session s was aborted.' })} />)

    await userEvent.selectOptions(screen.getByLabelText('Interface'), 'Ethernet1')
    expect(onFieldChange).toHaveBeenCalledWith('port', 'Ethernet1')
    await userEvent.click(screen.getByRole('button', { name: 'Commit to running-config' }))
    expect(onCommit).toHaveBeenCalledOnce()
    expect(onAbortDraft).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'Abort pending session' }))
    expect(onAbortPending).toHaveBeenCalledWith({ name: 'ui-s3-session', state: 'pending', description: 'webui trunk set mode' })

    expect(screen.getByRole('alert')).toHaveTextContent('Preview failed: 1006 config locked')
    const live = screen.getByText('Session s was aborted.')
    expect(live).toHaveAttribute('role', 'status')
    expect(live).toHaveAttribute('aria-live', 'polite')
  })

  it('shuts the write affordances without a device handle, and while an operation is in flight', () => {
    const first = render(<TrunkEditorView {...props({ canWrite: false })} />)
    expect(screen.getByRole('button', { name: 'Refresh state' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Preview change' })).toBeDisabled()
    first.unmount()

    render(<TrunkEditorView {...props({ busy: true })} />)
    expect(screen.getByRole('button', { name: 'Working…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Refresh state' })).toBeDisabled()
  })
})
