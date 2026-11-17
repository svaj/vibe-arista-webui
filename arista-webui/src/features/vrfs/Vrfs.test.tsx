/**
 * S16 (#90): the VRF manager, offline through hand-rolled fake client seams — the `Ntp.test.tsx`
 * shape. No test here contacts a device.
 *
 * The acceptance lines #90 grades, pinned below:
 * - every staged batch is pinned BYTE-EXACT at `session.run()` argv, copied from the vrfs.test.ts
 *   pins and the run-9 captures (create+rd, rd/description sections in-mode, all six routing arms,
 *   bind/unbind in BOTH the `vrf` and `vrf forwarding` forms, delete);
 * - the DR-099 form rule: an instance entry anywhere in the read drives `vrf instance`, a
 *   definition-only config drives `vrf definition` + `vrf forwarding`, and an EMPTY table says out
 *   loud that the keyword is the client convention, not device evidence;
 * - guards mirror the client refusals in-form at ZERO sessions (name grammar, rd one-token,
 *   description round-trip incl. the quote rule, create-existing, no-op set/clear/routing/bind);
 * - run-9 honesty: a device refusal raised by `run()` surfaces as the device's own error and the
 *   commit stays locked behind the unread diff;
 * - delete lists the config-assigned members, is destructive-confirmed, and declining sends nothing;
 * - four states + soft-read degradation (a failed `show vrf` costs only the device columns).
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Interface, Vrf } from '@devhax-heavy-industries/arista-eapi'

import type { ShowVrfReply } from '../../eapi/show-contracts'
import { Vrfs } from './Vrfs'

type TestNode = NonNullable<Parameters<typeof Vrfs>[0]['node']>

const vrfFixture = (over: Partial<Vrf> & { readonly name: string }): Vrf => ({
  definitionForm: 'instance',
  ipv4Routing: false,
  ipv6Routing: false,
  ...over,
})

const ifaceFixture = (name: string, vrf?: string): Interface =>
  ({ name, ...(vrf === undefined ? {} : { ethernet: { vrf } }) }) as unknown as Interface

/** The 7050TX inventory capture of `show vrf`, verbatim (`show-vrf--hw-inventory.json`). */
const deviceReply: ShowVrfReply = {
  vrfs: {
    default: {
      routeDistinguisher: '',
      vrfState: 'up',
      interfacesV6: [],
      interfacesV4: ['Management1'],
      interfaces: ['Management1'],
      protocols: {
        ipv4: { routingState: 'down', protocolState: 'up', supported: true },
        ipv6: { routingState: 'down', protocolState: 'up', supported: true },
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
  readonly vrfs?: readonly Vrf[] | Error
  readonly interfaces?: readonly Interface[] | Error
  readonly device?: ShowVrfReply | Error
  readonly versionFails?: boolean
  readonly diff?: string
  readonly diffRead?: boolean
  readonly runError?: Error
  readonly commitError?: Error
}

const defaultVrfs: readonly Vrf[] = [
  vrfFixture({ name: 'BLUE', rd: '10:10', description: 'campus', ipv4Routing: true }),
  vrfFixture({ name: 'RED' }),
]
const defaultIfaces: readonly Interface[] = [
  ifaceFixture('Ethernet1', 'BLUE'),
  ifaceFixture('Ethernet2'),
  ifaceFixture('Management1'),
]

function makeFakes(overrides: Overrides = {}) {
  const session = {
    name: 'ui-s16-session',
    state: 'diffed',
    isOpen: false,
    run: vi.fn(async () => {
      if (overrides.runError !== undefined) throw overrides.runError
      return []
    }),
    diff: vi.fn(async () => overrides.diff ?? '+vrf instance GREEN'),
    hasDiffBeenRead: vi.fn(() => overrides.diffRead ?? true),
    commit: vi.fn(async () => {
      if (overrides.commitError !== undefined) throw overrides.commitError
      return []
    }),
    abort: vi.fn(async () => []),
  }
  const getAllVrfs = vi.fn(async () => {
    if (overrides.vrfs instanceof Error) throw overrides.vrfs
    return new Map((overrides.vrfs ?? defaultVrfs).map((entry) => [entry.name, entry]))
  })
  const getAllInterfaces = vi.fn(async () => {
    if (overrides.interfaces instanceof Error) throw overrides.interfaces
    return new Map((overrides.interfaces ?? defaultIfaces).map((entry) => [entry.name, entry]))
  })
  const show = vi.fn(async (command: string) => {
    if (command === 'version') {
      if (overrides.versionFails === true) throw new Error('SYNTHETIC show version exploded')
      return versionBase
    }
    if (command === 'vrf') {
      if (overrides.device instanceof Error) throw overrides.device
      return overrides.device ?? deviceReply
    }
    throw new Error(`SYNTHETIC unexpected show: ${command}`)
  })
  const configSession = vi.fn(async () => session)
  const node = { vrfs: { getAll: getAllVrfs }, interfaces: { getAll: getAllInterfaces }, show, configSession } as unknown as TestNode
  return { node, session, getAllVrfs, getAllInterfaces, show, configSession }
}

function renderScreen(fakes: ReturnType<typeof makeFakes>) {
  return render(<Vrfs node={fakes.node} proxyConfigured />)
}

async function readyVrfs(): Promise<void> {
  // The per-row Manage button is the unique readiness anchor — VRF names also appear as
  // <option>s in the assignment selector, so raw text would be ambiguous by design.
  await screen.findByRole('button', { name: 'Manage BLUE' })
}

async function stageReady(fakes: ReturnType<typeof makeFakes>): Promise<void> {
  await waitFor(() => expect(fakes.session.run).toHaveBeenCalled())
  await screen.findByText(/Review the device diff before committing/u)
}

async function manage(name: string): Promise<void> {
  // a reload (after commit/abort) lands on the loading arm, so wait for the row to exist
  fireEvent.click(await screen.findByRole('button', { name: `Manage ${name}` }))
}

const nameField = () => screen.getByLabelText(/VRF name/u)
const rdField = () => screen.getByLabelText(/Route distinguisher — optional/u)
const descField = () => screen.getByLabelText(/Description — optional/u)
const editRdField = () => screen.getByLabelText(/Route distinguisher \(one token/u)
const editDescField = () => screen.getByLabelText(/^Description$/u)
const ifaceSelect = () => screen.getByLabelText('Interface', { exact: true })
const targetSelect = () => screen.getByLabelText(/Target VRF/u)

// ====================================================================================================
// Four states + soft-read degradation
// ====================================================================================================

describe('Vrfs — four states, nothing contacted unless asked', () => {
  it('no proxy: prompt, every control disabled, and getAll()/show()/configSession() stay at zero calls', () => {
    const fakes = makeFakes()
    render(<Vrfs node={fakes.node} proxyConfigured={false} />)

    expect(screen.getByRole('alert')).toHaveTextContent('Local proxy is not configured')
    expect(screen.getByRole('button', { name: 'Stage create VRF' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Reload device state' })).toBeDisabled()
    expect(fakes.getAllVrfs).not.toHaveBeenCalled()
    expect(fakes.getAllInterfaces).not.toHaveBeenCalled()
    expect(fakes.show).not.toHaveBeenCalled()
    expect(fakes.configSession).not.toHaveBeenCalled()
  })

  it('loading: while the config reads are in flight the screen shows its own read copy', () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    expect(screen.getByText(/VRF sections and per-port VRF assignments/u)).toBeInTheDocument()
  })

  it('ready: config rows with rd/description/routing flags, the config-truth members, and the capture-backed device table', async () => {
    const fakes = makeFakes()
    const { container } = renderScreen(fakes)
    await readyVrfs()

    // configured table — the write-driving source (scoped: names double as assignment options)
    const table = screen.getByRole('table', { name: 'Configured VRFs' })
    expect(within(table).getByText('BLUE')).toBeInTheDocument()
    expect(within(table).getByText('10:10')).toBeInTheDocument()
    expect(within(table).getByText('campus')).toBeInTheDocument()
    // members are the parsed-interface truth (Ethernet1 carries `vrf BLUE`), listed under BLUE
    expect(screen.getByRole('table', { name: 'Configured VRFs' })).toHaveTextContent('Ethernet1')
    // show vrf (capture-verbatim) drives the device panel; `default` is marked built-in
    expect(screen.getByRole('table', { name: 'VRF device state (show vrf)' })).toHaveTextContent('Management1')
    expect(screen.getByText('(built-in)')).toBeInTheDocument()
    // BLUE has no `show vrf` entry (neither capture carries any VRF besides default) — blank cell, not invented
    expect(screen.getAllByText('no read')).toHaveLength(2)
    // identity chip from the soft show('version')
    expect(container.querySelector('.device-identity')).not.toBeNull()
    // DR-099: an instance entry exists, so the keyword is device-spoken
    expect(screen.getByText(/written config text speaks \(DR-099\)/u)).toBeInTheDocument()
  })

  it('an empty VRF table is a normal configured state, and the keyword note admits it is a convention', async () => {
    const fakes = makeFakes({ vrfs: [], interfaces: [] })
    renderScreen(fakes)

    const empty = await screen.findByText(/No non-default VRFs are configured/u)
    expect(empty).toBeInTheDocument()
    expect(screen.getByText(/client\u2019s convention default \(DR-099\)/u)).toBeInTheDocument()
    expect(screen.getByText(/startup-config is never written, DR-024/u)).toBeInTheDocument()
    expect(screen.queryByText(/The VRF reads failed/u)).toBeNull()
  })

  it('a failed hard read is an error, never a blank table: alert copy, controls locked, zero sessions', async () => {
    const fakes = makeFakes({ vrfs: new Error('SYNTHETIC vrf read exploded') })
    renderScreen(fakes)

    expect(await screen.findByRole('alert')).toHaveTextContent('SYNTHETIC vrf read exploded')
    expect(screen.getByRole('button', { name: 'Stage create VRF' })).toBeDisabled()
    expect(fakes.getAllVrfs).toHaveBeenCalledTimes(1)
    expect(fakes.configSession).not.toHaveBeenCalled()
  })

  it('the interfaces read failing is ALSO a hard failure (membership is config truth, not decoration)', async () => {
    const fakes = makeFakes({ interfaces: new Error('SYNTHETIC interfaces exploded') })
    renderScreen(fakes)
    expect(await screen.findByRole('alert')).toHaveTextContent('SYNTHETIC interfaces exploded')
  })

  it('a failed `show vrf` costs ONLY the device columns: the config table stays, the panel says unread', async () => {
    const fakes = makeFakes({ device: new Error('SYNTHETIC show vrf exploded') })
    renderScreen(fakes)
    await readyVrfs()

    expect(within(screen.getByRole('table', { name: 'Configured VRFs' })).getByText('BLUE')).toBeInTheDocument()
    expect(screen.getByText(/No `show vrf` read has answered/u)).toBeInTheDocument()
    expect(screen.queryByRole('table', { name: 'VRF device state (show vrf)' })).toBeNull()
    // no fabricated device labels anywhere in the configured table
    expect(screen.getAllByText('no read')).toHaveLength(2)
  })

  it('a failed `show version` costs the identity chip only — the writes stay live', async () => {
    const fakes = makeFakes({ versionFails: true })
    const { container } = renderScreen(fakes)
    await readyVrfs()

    expect(container.querySelector('.device-identity')).toBeNull()
    // writes stay live: the create field is editable, and the button arms the moment a name exists
    // (the empty-name disable is the same gate every other screen keeps, proxy or no version)
    expect(nameField()).toBeEnabled()
    fireEvent.change(nameField(), { target: { value: 'GREEN' } })
    expect(screen.getByRole('button', { name: 'Stage create VRF' })).toBeEnabled()
  })

  it('a device reply with no VRF entries renders EMPTY, not config-text fallback rows', async () => {
    const fakes = makeFakes({ device: { vrfs: {} } })
    renderScreen(fakes)
    await readyVrfs()

    expect(screen.getByText(/answered with no VRF entries/u)).toBeInTheDocument()
  })
})

// ====================================================================================================
// Create — composition + guards
// ====================================================================================================

describe('Vrfs — create stages the run-9-proven composition', () => {
  it('name + rd + description: one named session, header-first batch byte-exact, risky-free commit flow', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyVrfs()

    fireEvent.change(nameField(), { target: { value: 'GREEN' } })
    fireEvent.change(rdField(), { target: { value: '65000:1' } })
    fireEvent.change(descField(), { target: { value: 'leaf' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stage create VRF' }))
    await stageReady(fakes)

    expect(fakes.configSession).toHaveBeenCalledWith({ description: 'webui vrf create' })
    expect(fakes.session.run).toHaveBeenCalledWith(['vrf instance GREEN', 'rd 65000:1', 'description leaf'])

    fireEvent.click(screen.getByRole('button', { name: 'Commit to running-config' }))
    fireEvent.click(await screen.findByRole('button', { name: /Commit despite the risk: vrf instance GREEN/u }))
    await waitFor(() => expect(fakes.session.commit).toHaveBeenCalled())
    await waitFor(() => expect(fakes.getAllVrfs).toHaveBeenCalledTimes(2))
    expect(screen.getByText(/Startup-config was not changed/u)).toBeInTheDocument()
  })

  it('name only: a bare header line with no trailing empties', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyVrfs()

    fireEvent.change(nameField(), { target: { value: 'GREEN' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stage create VRF' }))
    await stageReady(fakes)

    expect(fakes.session.run).toHaveBeenCalledWith(['vrf instance GREEN'])
  })

  it('refuses a bad name, a two-token rd, and a quote-carrying description — each at ZERO sessions', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyVrfs()

    fireEvent.change(nameField(), { target: { value: 'bad name' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stage create VRF' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('numbers, letters and underscore')

    fireEvent.change(nameField(), { target: { value: 'GREEN' } })
    fireEvent.change(rdField(), { target: { value: '65000: 1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stage create VRF' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('one token')

    fireEvent.change(rdField(), { target: { value: '' } })
    fireEvent.change(descField(), { target: { value: 'say "hi"' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stage create VRF' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('cannot round-trip')

    expect(fakes.configSession).not.toHaveBeenCalled()
  })

  it('refuses to re-create an existing VRF — the config read is the same source the guard cites', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyVrfs()

    fireEvent.change(nameField(), { target: { value: 'BLUE' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stage create VRF' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('already exists in the running-config')
    expect(fakes.configSession).not.toHaveBeenCalled()
  })

  it('a definition-only config stages `vrf definition` — and the batch note cites the run-9 deprecation', async () => {
    const fakes = makeFakes({ vrfs: [vrfFixture({ name: 'OLD', definitionForm: 'definition' })] })
    renderScreen(fakes)
    await screen.findByRole('button', { name: 'Manage OLD' })

    fireEvent.change(nameField(), { target: { value: 'GREEN' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stage create VRF' }))
    await stageReady(fakes)

    expect(fakes.session.run).toHaveBeenCalledWith(['vrf definition GREEN'])
    expect(screen.getByText(/refusing `vrf definition` as deprecated/u)).toBeInTheDocument()
  })

  it('a device refusal raised by run() stays THE DEVICE verdict: failure copy, commit locked behind the diff', async () => {
    const fakes = makeFakes({ runError: new Error('SYNTHETIC (1002): % Command entered is wrong syntax') })
    renderScreen(fakes)
    await readyVrfs()

    fireEvent.change(nameField(), { target: { value: 'GREEN' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stage create VRF' }))

    expect(await screen.findByText(/The device did not take that/u)).toBeInTheDocument()
    expect(screen.getByText(/wrong syntax/u)).toBeInTheDocument()
    expect(screen.getByText(/Reading the device diff/u)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Commit to running-config' })).toBeDisabled()
    expect(fakes.session.commit).not.toHaveBeenCalled()
  })
})

// ====================================================================================================
// Manage: rd / description / routing / delete
// ====================================================================================================

describe('Vrfs — per-VRF section writes stay inside the header, exactly like the client', () => {
  it('Manage seeds the fields from the read; Set rd stages [header, rd]; Clear rd stages [header, no rd]', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyVrfs()
    await manage('BLUE')

    expect(editRdField()).toHaveValue('10:10')
    // same-value is a no-op the buttons disable before any session opens
    expect(screen.getByRole('button', { name: 'Set rd' })).toBeDisabled()

    fireEvent.change(editRdField(), { target: { value: '1:9' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set rd' }))
    await stageReady(fakes)
    expect(fakes.configSession).toHaveBeenCalledWith({ description: 'webui vrf set rd' })
    expect(fakes.session.run).toHaveBeenCalledWith(['vrf instance BLUE', 'rd 1:9'])
  })

  it('Clear rd (BLUE has one) stages the negation form; RED without an rd gets a disabled button', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyVrfs()
    await manage('RED')
    expect(screen.getByRole('button', { name: 'Clear rd' })).toBeDisabled()

    await manage('BLUE')
    fireEvent.click(screen.getByRole('button', { name: 'Clear rd' }))
    await stageReady(fakes)
    expect(fakes.session.run).toHaveBeenCalledWith(['vrf instance BLUE', 'no rd'])
  })

  it('description set/clear mirror setVrfDescription inside the section', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyVrfs()
    await manage('BLUE')

    expect(editDescField()).toHaveValue('campus')
    fireEvent.change(editDescField(), { target: { value: 'ops net-vrf' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set description' }))
    await stageReady(fakes)
    expect(fakes.session.run).toHaveBeenCalledWith(['vrf instance BLUE', 'description ops net-vrf'])
  })

  it('the six routing arms stage the six bare top-level lines, with no-op arms disabled', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyVrfs()
    await manage('BLUE') // ipv4Routing true, ipv6Routing false

    expect(screen.getByRole('button', { name: 'Enable IPv4 routing' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Disable IPv6 routing' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Disable IPv4 routing' }))
    await stageReady(fakes)
    expect(fakes.configSession).toHaveBeenCalledWith({ description: 'webui vrf disable ipv4 routing' })
    expect(fakes.session.run).toHaveBeenCalledWith(['no ip routing vrf BLUE'])

    fireEvent.click(screen.getByRole('button', { name: 'Abort staged changes' }))
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Abort staged changes' })).toHaveLength(2))
    fireEvent.click(screen.getAllByRole('button', { name: 'Abort staged changes' }).at(-1)!)
    await waitFor(() => expect(fakes.session.abort).toHaveBeenCalled())
    await manage('BLUE')

    fireEvent.click(screen.getByRole('button', { name: 'Enable IPv6 routing' }))
    await stageReady(fakes)
    expect(fakes.session.run).toHaveBeenCalledWith(['ipv6 unicast-routing vrf BLUE'])
    fireEvent.click(screen.getByRole('button', { name: 'Abort staged changes' }))
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Abort staged changes' })).toHaveLength(2))
    fireEvent.click(screen.getAllByRole('button', { name: 'Abort staged changes' }).at(-1)!)
    await waitFor(() => expect(fakes.session.abort).toHaveBeenCalledTimes(2))
    await manage('BLUE')

    fireEvent.click(screen.getByRole('button', { name: 'Default IPv4 routing' }))
    await stageReady(fakes)
    expect(fakes.session.run).toHaveBeenCalledWith(['default ip routing vrf BLUE'])
  })

  it('delete: destructive batch naming the config-assigned members; declining sends nothing', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyVrfs()
    await manage('BLUE')

    fireEvent.click(screen.getByRole('button', { name: 'Delete BLUE' }))
    await stageReady(fakes)
    expect(fakes.configSession).toHaveBeenCalledWith({ description: 'webui vrf delete' })
    expect(fakes.session.run).toHaveBeenCalledWith(['no vrf instance BLUE'])
    expect(screen.getByText(/Ports the config still assigns to it: Ethernet1/u)).toBeInTheDocument()

    // the panel button OPENED the confirm — declining it (the dialog's Cancel) sends nothing
    fireEvent.click(screen.getByRole('button', { name: 'Commit (risky — review above)' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull())

    expect(fakes.session.commit).not.toHaveBeenCalled()
    expect(fakes.configSession).toHaveBeenCalledTimes(1)
  })

  it('delete + commit clears the selection and re-reads', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyVrfs()
    await manage('BLUE')

    fireEvent.click(screen.getByRole('button', { name: 'Delete BLUE' }))
    await stageReady(fakes)
    fireEvent.click(screen.getByRole('button', { name: 'Commit (risky — review above)' }))
    fireEvent.click(await screen.findByRole('button', { name: /Commit despite the risk: no vrf instance BLUE/u }))
    await waitFor(() => expect(fakes.session.commit).toHaveBeenCalled())

    expect(screen.getByText('no selection')).toBeInTheDocument()
    await waitFor(() => expect(fakes.getAllVrfs).toHaveBeenCalledTimes(2))
  })

  it('while a draft is open, every other write refuses instead of stacking sessions', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyVrfs()

    fireEvent.change(nameField(), { target: { value: 'GREEN' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stage create VRF' }))
    await stageReady(fakes)

    fireEvent.click(screen.getByRole('button', { name: 'Manage BLUE' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete BLUE' }))
    expect(await screen.findByText(/staged session is already open/u)).toBeInTheDocument()
    expect(fakes.configSession).toHaveBeenCalledTimes(1)
  })

  it('commit failure keeps the recovery copy and never re-arms the button', async () => {
    const fakes = makeFakes({ commitError: new Error('SYNTHETIC commit exploded') })
    renderScreen(fakes)
    await readyVrfs()

    fireEvent.change(nameField(), { target: { value: 'GREEN' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stage create VRF' }))
    await stageReady(fakes)

    fireEvent.click(screen.getByRole('button', { name: 'Commit to running-config' }))
    fireEvent.click(await screen.findByRole('button', { name: /Commit despite the risk: vrf instance GREEN/u }))
    expect(await screen.findByText(/refresh device state before taking another action/u)).toBeInTheDocument()
    expect(screen.getByText(/Transaction Center/u)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Commit to running-config' })).toBeDisabled()
  })
})

// ====================================================================================================
// Interface assignment
// ====================================================================================================

describe('Vrfs — port assignment pins both keyword arms and the no-op guards', () => {
  it('bind pins [interface, vrf NAME] on this box (the run-9 pair), destructive-confirmed', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyVrfs()

    fireEvent.change(ifaceSelect(), { target: { value: 'Ethernet2' } })
    fireEvent.change(targetSelect(), { target: { value: 'BLUE' } })
    fireEvent.click(screen.getByRole('button', { name: 'Assign port to VRF' }))
    await stageReady(fakes)

    expect(fakes.configSession).toHaveBeenCalledWith({ description: 'webui vrf assign interface' })
    expect(fakes.session.run).toHaveBeenCalledWith(['interface Ethernet2', 'vrf BLUE'])
    // the staged risk cites the run-9 verdict (the panel note also carries the captured refusal —
    // this asserts the risk copy itself, which is the unique phrasing)
    expect(screen.getByText(/checks VRF existence when the assignment line RUNS/u)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Commit (risky — review above)' }))
    fireEvent.click(await screen.findByRole('button', { name: /Commit despite the risk: Ethernet2/u }))
    await waitFor(() => expect(fakes.session.commit).toHaveBeenCalled())
  })

  it('bind is disabled when the port already carries that VRF in config; unbind is disabled for an unassigned port', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyVrfs()

    fireEvent.change(ifaceSelect(), { target: { value: 'Ethernet1' } })
    fireEvent.change(targetSelect(), { target: { value: 'BLUE' } })
    expect(screen.getByRole('button', { name: 'Assign port to VRF' })).toBeDisabled()
    // Ethernet1 DOES carry a vrf — unbind is eligible there, and NOT eligible on Ethernet2:
    expect(screen.getByRole('button', { name: 'Unassign (return to default VRF)' })).toBeEnabled()

    fireEvent.change(ifaceSelect(), { target: { value: 'Ethernet2' } })
    expect(screen.getByRole('button', { name: 'Unassign (return to default VRF)' })).toBeDisabled()
    expect(fakes.configSession).not.toHaveBeenCalled()
  })

  it('unbind on an instance-form box stages the bare `no vrf` arm', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyVrfs()

    fireEvent.change(ifaceSelect(), { target: { value: 'Ethernet1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Unassign (return to default VRF)' }))
    await stageReady(fakes)
    expect(fakes.configSession).toHaveBeenCalledWith({ description: 'webui vrf unassign interface' })
    expect(fakes.session.run).toHaveBeenCalledWith(['interface Ethernet1', 'no vrf'])
  })

  it('a definition-form box binds/unbinds with `vrf forwarding` / `no vrf forwarding`', async () => {
    const fakes = makeFakes({
      vrfs: [vrfFixture({ name: 'OLD', definitionForm: 'definition' })],
      interfaces: [ifaceFixture('Ethernet9')],
    })
    renderScreen(fakes)
    await screen.findByRole('button', { name: 'Manage OLD' })

    fireEvent.change(ifaceSelect(), { target: { value: 'Ethernet9' } })
    fireEvent.change(targetSelect(), { target: { value: 'OLD' } })
    fireEvent.click(screen.getByRole('button', { name: 'Assign port to VRF' }))
    await stageReady(fakes)
    expect(fakes.session.run).toHaveBeenCalledWith(['interface Ethernet9', 'vrf forwarding OLD'])
  })

  it('Management1 is offered, and the risk copy names the in-band platform fact plainly', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyVrfs()

    fireEvent.change(ifaceSelect(), { target: { value: 'Management1' } })
    fireEvent.change(targetSelect(), { target: { value: 'BLUE' } })
    fireEvent.click(screen.getByRole('button', { name: 'Assign port to VRF' }))
    await stageReady(fakes)
    expect(screen.getByText(/Management1 is the usual in-band port on this platform/u)).toBeInTheDocument()
  })

  it('the empty-state copy promises no fabricated state: nothing device-shaped renders from config alone', async () => {
    const fakes = makeFakes({ vrfs: [] })
    renderScreen(fakes)
    await waitFor(() => expect(screen.queryByText(/VRF sections and per-port/u)).toBeNull())

    expect(screen.getByText(/No non-default VRFs are configured/u)).toBeInTheDocument()
    // device panel still only ever shows what `show vrf` answered — the built-in default row
    expect(screen.getByRole('table', { name: 'VRF device state (show vrf)' })).toHaveTextContent('default')
    expect(screen.getByRole('table', { name: 'VRF device state (show vrf)' })).not.toHaveTextContent('BLUE')
  })
})
