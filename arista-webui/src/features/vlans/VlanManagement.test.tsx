/**
 * S2 (#72): VLAN management, offline through mock client seams (the CAP-TESTING rule: no test here
 * touches a device or a proxy). The mock node is deliberately a **single** object that satisfies both
 * the screen's read/write seam and the F5 probe seam (`activeConfigSession`, `configSession`,
 * `runCommands`, `refresh`, `autorefresh`, `connection.address`, `listSessions`, `abortSession`), so
 * the probe gate is exercised through the real `useCapabilities` wrapper rather than a stubbed verdict —
 * which is what makes "sends nothing while unknown" a meaningful assertion.
 *
 * The scenarios mirror captured device state without claiming hardware support
 * (`hardwareEvidence: none`, DR-043): VLANs 1/10/20/100 with the lab's switchport references, and
 * `show management api http-commands` answering the padded `Vlan100     : …` token from the cEOS
 * capture. Trunk-group support stays a probe question (DECISIONS open item 4): the probe candidates the
 * screen sends are asserted verbatim, and each verdict arm is driven by a scripted
 * `validateChanges` outcome — accepted, `1002`, or a thrown failure.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConfigSession, Switchport, Vlan } from '@devhax-heavy-industries/arista-eapi'

import { VlanManagement, allowedNamesVlan, VLAN_TRUNK_PROBE } from './VlanManagement'
import type { VlanAction } from './VlanManagement'

type TestNode = NonNullable<Parameters<typeof VlanManagement>[0]['node']>

/** The probe session and the write session are the same fake: `validateChanges`/`isOpen` for the
 *  former, `run`/`diff`/`commit`/`abort` for the latter. */
interface Overrides {
  readonly vlans?: Map<number, Vlan> | Error | 'pending'
  readonly show?: () => Promise<unknown>
  readonly listSessions?: () => Promise<{ sessions: readonly unknown[] }>
}

function makeFakes(probeOutcome: 'accepted' | 'rejected-1002' | 'failed' | 'pending' = 'accepted', overrides: Overrides = {}) {
  const session = {
    name: 'ui-s2-session',
    state: 'diffed',
    isOpen: true,
    run: vi.fn(async () => []),
    diff: vi.fn(async () => '+vlan 20\n+   name VOICE'),
    hasDiffBeenRead: vi.fn(() => true),
    commit: vi.fn(async () => []),
    abort: vi.fn(async () => []),
    validateChanges: vi.fn((_commands: readonly string[], _extensions: Record<string, unknown>) => {
      if (probeOutcome === 'pending') return new Promise(() => {})
      if (probeOutcome === 'failed') return Promise.reject(new Error('device unreachable'))
      if (probeOutcome === 'rejected-1002') {
        return {
          ok: false,
          failures: [{ cmd: 'trunk group webui-probe', code: 1002, message: 'Invalid input at trunk group keyword' }],
          error: { code: 1002, message: 'SYNTHETIC 1002 COMMAND_INVALID while probing' },
        }
      }
      return { ok: true, applied: [] }
    }),
  } as unknown as ConfigSession & { isOpen: boolean; validateChanges: ReturnType<typeof vi.fn>; abort: ReturnType<typeof vi.fn>; run: ReturnType<typeof vi.fn>; diff: ReturnType<typeof vi.fn>; commit: ReturnType<typeof vi.fn> }

  const defaultVlans = new Map<number, Vlan>([
    [1, { id: 1, name: 'default', state: 'active', trunkGroups: [] }],
    [10, { id: 10, name: 'MGMT-NATIVE', state: 'active', trunkGroups: [] }],
    [20, { id: 20, name: 'VOICE', state: 'active', trunkGroups: [] }],
    [100, { id: 100, name: 'EAPI', state: 'active', trunkGroups: ['LABGRP'] }],
  ])

  const node = {
    vlans: {
      getAll: vi.fn(async () => {
        if (overrides.vlans === 'pending') await new Promise(() => undefined)
        if (overrides.vlans instanceof Error) throw overrides.vlans
        return overrides.vlans ?? defaultVlans
      }),
    },
    switchports: {
      getAll: vi.fn(async () => new Map<string, Switchport>([
        ['Ethernet1', { interfaceName: 'Ethernet1', mode: 'access', accessVlan: 20, trunkGroups: [] }],
        ['Port-Channel1', { interfaceName: 'Port-Channel1', mode: 'trunk', trunkNativeVlan: 10, trunkAllowedVlans: '10-12,20', trunkGroups: ['LABGRP'] }],
        ['Port-Channel10', { interfaceName: 'Port-Channel10', mode: 'trunk', trunkAllowedVlans: 'all', trunkGroups: [] }],
      ])),
    },
    configSession: vi.fn(async () => session),
    abortSession: vi.fn(async () => []),
    show: vi.fn(async () => (overrides.show !== undefined
      ? overrides.show()
      : {
        urls: ['Vlan100     : https://10.0.100.1:443'], vrf: 'default', vrfs: ['default'], enabled: true,
        httpsServer: { running: true, configured: true, port: 443 },
        httpServer: { running: false, configured: false, port: 80 },
        localHttpServer: { running: false, configured: false, port: 8080 },
        unixSocketServer: { running: false, configured: false },
        tlsProtocol: ['1.2'], users: {}, corsOrigins: [], iframeAncestors: [], logLevel: 'none',
        dscpValue: 0, fipsEnabled: false, bytesIn: 0, bytesOut: 0, commandCount: 0, executionTime: 0, hitCount: 0, requestCount: 0,
      })),
    listSessions: vi.fn(async () => overrides.listSessions?.() ?? { sessions: [] }),
    // The F5 seam (`CapabilityProbeTarget` + the two cleanup handles).
    activeConfigSession: undefined,
    runCommands: vi.fn(async () => [{ result: {} }]),
    refresh: vi.fn(),
    autorefresh: true,
    connection: { address: 'https://sw1.test:443/command-api' },
  } as unknown as TestNode

  return { node, session }
}

async function ready(node: TestNode | undefined, proxyConfigured?: boolean) {
  render(<VlanManagement node={node} {...(proxyConfigured === undefined ? {} : { proxyConfigured })} />)
  await screen.findByRole('heading', { name: 'VLAN table' })
  return screen.findByLabelText('Action')
}

async function chooseAction(name: VlanAction) {
  await userEvent.selectOptions(await screen.findByLabelText('Action'), name)
}

afterEach(() => vi.restoreAllMocks())

describe('VlanManagement — the VLAN table', () => {
  it('announces loading while the device reads are unresolved', () => {
    const { node } = makeFakes('accepted', { vlans: 'pending' })
    render(<VlanManagement node={node} />)

    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByText(/Reading VLANs/u)).toBeInTheDocument()
  })

  it('does not contact an eAPI target when the local proxy is unconfigured', async () => {
    const { node } = makeFakes()
    render(<VlanManagement node={node} proxyConfigured={false} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('EAPI_HOST')
    expect(node.vlans.getAll).not.toHaveBeenCalled()
    expect(node.switchports.getAll).not.toHaveBeenCalled()
    expect(node.listSessions).not.toHaveBeenCalled()
    expect(node.configSession).not.toHaveBeenCalled()
  })

  it('lists every VLAN with its name, state pill, trunk groups and the referencing config lines', async () => {
    await ready(makeFakes().node)

    for (const header of ['VLAN', 'Name', 'State', 'Trunk groups', 'Referenced by', 'Flags']) {
      expect(screen.getByRole('columnheader', { name: header })).toBeInTheDocument()
    }
    // The reference is shown as the running-config line that creates it, not as a count the operator
    // has to trust.
    expect(screen.getByText('Ethernet1 switchport access vlan 20')).toBeInTheDocument()
    expect(screen.getByText('Port-Channel1 switchport trunk native vlan 10')).toBeInTheDocument()
    // The enumerated list is one line shared by every VLAN it covers — showing lines rather than a count
    // is the point, so the same line legitimately appears on more than one row.
    expect(screen.getAllByText('Port-Channel1 switchport trunk allowed vlan 10-12,20')).toHaveLength(2)
    expect(screen.getByText('LABGRP')).toBeInTheDocument()
    // An `all` spelling is a question this client cannot answer, so it is flagged on the rows it might
    // touch and never resolved into a membership claim.
    expect(screen.getAllByText('allowed-vlan spelling not enumerable')).toHaveLength(4)
    expect(screen.queryByText(/Port-Channel10 switchport trunk allowed vlan/u)).toBeNull()
    expect(screen.getAllByText('No switchport reference found').length).toBeGreaterThan(0)
    expect(screen.getByText('reserved')).toBeInTheDocument()
    // The device's own answer, not a guess: the cEOS capture names Vlan100 as the eAPI interface.
    expect(screen.getByText('Management VLAN')).toBeInTheDocument()
  })

  it('flags an allowed-vlan spelling this client cannot enumerate, without guessing through it', async () => {
    // The note text only ever reaches the operator through the review panel, where the VLAN being changed
    // is known; the table carries the short flag. So the flag is asserted on the rows, and the honesty
    // check is the absence: no membership line is invented for `all`.
    await ready(makeFakes().node)

    expect(screen.getAllByText('allowed-vlan spelling not enumerable')).toHaveLength(4)
    expect(screen.queryByText(/Port-Channel10 switchport trunk allowed vlan/u)).toBeNull()
  })

  it('an empty VLAN table is empty, not an error, and says a failed read would look different', async () => {
    const { node } = makeFakes('accepted', { vlans: new Map<number, Vlan>() })
    await ready(node)

    expect(await screen.findByText('The device returned no VLAN entries.')).toBeInTheDocument()
    expect(screen.getByText(/a failed read renders as an error above/u)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('a failed read is an error with a retry, and never an empty table', async () => {
    const { node } = makeFakes('accepted', { vlans: new Error('device unreachable') })
    render(<VlanManagement node={node} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('device unreachable')
    expect(screen.getByRole('button', { name: 'Retry read' })).toBeInTheDocument()
    expect(screen.queryByText('The device returned no VLAN entries.')).not.toBeInTheDocument()
  })

  it('a failed management-API read flags nothing and says that is not a promise', async () => {
    const { node } = makeFakes('accepted', { show: async () => { throw new Error('1002 command invalid') } })
    await ready(node)

    expect(await screen.findByText(/The management-API read failed/u)).toBeInTheDocument()
    expect(screen.getByText('1002 command invalid')).toBeInTheDocument()
    expect(screen.queryByText('Management VLAN')).not.toBeInTheDocument()
    expect(screen.getByText(/which is not a promise that none is/u)).toBeInTheDocument()
  })

  it('allowedNamesVlan answers membership, absence and the keyword forms separately (DR-028)', () => {
    expect(allowedNamesVlan('10-12,20', 11)).toBe('yes')
    expect(allowedNamesVlan('10-12,20', 20)).toBe('yes')
    expect(allowedNamesVlan('10-12,20', 13)).toBe('no')
    expect(allowedNamesVlan('all', 7)).toBe('unknown')
    expect(allowedNamesVlan('except 5', 5)).toBe('unknown')
    expect(allowedNamesVlan(undefined, 5)).toBe('no')
    expect(allowedNamesVlan('10,twenty', 11)).toBe('unknown')
  })
})

describe('VlanManagement — the trunk-group capability gate (#67 F5)', () => {
  it('probes on mount with this screen\u2019s own candidates and never leaves the probe session behind', async () => {
    const { node, session } = makeFakes('accepted')
    await ready(node)

    expect(VLAN_TRUNK_PROBE.vlanTrunkGroups).toEqual(['vlan 4090', 'trunk group webui-probe'])
    expect(session.validateChanges).toHaveBeenCalledWith(['vlan 4090', 'trunk group webui-probe'], {})
    expect(await screen.findByText(/The device accepted the probe commands/u)).toBeInTheDocument()
    // DR-063's guarantee, seen from the caller's side: a probe validates and aborts, and never commits.
    expect(session.abort).toHaveBeenCalledOnce()
    expect(session.commit).not.toHaveBeenCalled()
    await chooseAction('add-trunk-group')
    expect(await screen.findByLabelText('Trunk group')).toBeEnabled()
  })

  it('sends nothing while the verdict is unresolved: an in-flight probe keeps the group controls shut', async () => {
    const { node, session } = makeFakes('pending')
    await ready(node)

    expect(screen.getByText(/^Verdict:/u)).not.toHaveTextContent('available')
    expect(session.validateChanges).toHaveBeenCalledOnce()
    await chooseAction('add-trunk-group')
    expect(await screen.findByLabelText('Trunk group')).toBeDisabled()

    await userEvent.click(screen.getByRole('button', { name: 'Preview change' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/probe-gated/u)
    // The gate guards the write path, not only the disabled input: nothing was run or committed, and the
    // only session this screen opened is the probe's own.
    expect(session.run).not.toHaveBeenCalled()
    expect(session.commit).not.toHaveBeenCalled()
  })

  it('a repeat probe request inside the rate-limit window opens no second config session', async () => {
    const { node, session } = makeFakes('accepted')
    await ready(node)
    await screen.findByText(/The device accepted the probe commands/u)

    await userEvent.click(screen.getByRole('button', { name: 'Re-run capability probe' }))

    expect(await screen.findByText(/rate-limit window/u)).toBeInTheDocument()
    expect(session.validateChanges).toHaveBeenCalledOnce()
  })

  it('a 1002 on a candidate reads unavailable, and the gate stays shut', async () => {
    const { node, session } = makeFakes('rejected-1002')
    await ready(node)

    expect(await screen.findByText(/^Verdict:/u)).toHaveTextContent('unavailable')
    expect(screen.getByText(/trunk group webui-probe/u)).toBeInTheDocument()
    expect(session.abort).toHaveBeenCalledOnce()
    await chooseAction('add-trunk-group')
    expect(await screen.findByLabelText('Trunk group')).toBeDisabled()
  })

  it('a probe that fails outright is reported as a failure, not as an answer', async () => {
    const { node } = makeFakes('failed')
    await ready(node)

    expect(await screen.findByRole('alert')).toHaveTextContent('Probe failed: device unreachable')
    expect(screen.getByText(/^Verdict:/u)).toHaveTextContent('unknown')
  })

  it('choosing a trunk-group action without an available verdict stages nothing and writes nothing', async () => {
    const { node, session } = makeFakes('rejected-1002')
    await ready(node)
    // The `Verdict:` line splits across a <strong>, so the verdict word is asserted as content rather than
    // as an anchored whole-string match.
    expect(await screen.findByText(/^Verdict:/u)).toHaveTextContent('unavailable')

    await chooseAction('remove-trunk-group')
    await userEvent.click(screen.getByRole('button', { name: 'Preview change' }))

    expect((await screen.findAllByRole('alert')).some((n) => /probe-gated/u.test(n.textContent ?? ''))).toBe(true)
    // Nothing was staged, so there is no draft to review and no session ran a command.
    expect(session.run).not.toHaveBeenCalled()
    expect(session.commit).not.toHaveBeenCalled()
    expect(screen.queryByText(/Review the device diff/u)).toBeNull()
  })

  it('after an available verdict, group adds and removals stage the vlan-submode forms the client pins', async () => {
    const { node, session } = makeFakes('accepted')
    await ready(node)
    await screen.findByText(/The device accepted the probe commands/u)

    await chooseAction('add-trunk-group')
    await userEvent.type(await screen.findByLabelText('Trunk group'), 'LABGRP')
    await userEvent.click(screen.getByRole('button', { name: 'Preview change' }))
    await screen.findByText(/Review the device diff/u)
    expect(session.run).toHaveBeenLastCalledWith(['vlan 1', 'trunk group LABGRP'])

    await userEvent.click(screen.getByRole('button', { name: 'Abort staged changes' }))
    const abortPrompt = await screen.findByRole('dialog', { name: 'Abort staged changes' })
    await userEvent.click(within(abortPrompt).getByRole('button', { name: 'Abort staged changes' }))

    // `type` appends (the earlier click already put a name in a field the abort does not clear), and the
    // value is asserted below through the staged argv rather than through the input.
    await chooseAction('remove-trunk-group')
    await userEvent.clear(await screen.findByLabelText('Trunk group'))
    await userEvent.type(screen.getByLabelText('Trunk group'), 'LABGRP')
    await userEvent.click(screen.getByRole('button', { name: 'Preview change' }))
    await screen.findByText(/Review the device diff/u)
    expect(session.run).toHaveBeenLastCalledWith(['vlan 1', 'no trunk group LABGRP'])
  })

  it('multi-word trunk-group names are refused before a write, naming the client rule', async () => {
    const { node, session } = makeFakes('accepted')
    await ready(node)
    await screen.findByText(/The device accepted the probe commands/u)

    await chooseAction('add-trunk-group')
    await userEvent.type(await screen.findByLabelText('Trunk group'), 'two words')
    await userEvent.click(screen.getByRole('button', { name: 'Preview change' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/single token/u)
    expect(session.run).not.toHaveBeenCalled()
  })
})

describe('VlanManagement — staged writes and the in-use guard', () => {
  it('creating a VLAN is one transaction with the pinned name and state lines', async () => {
    const { node, session } = makeFakes()
    await ready(node)

    await chooseAction('create')
    await userEvent.type(screen.getByLabelText('New VLAN id'), '40')
    await userEvent.type(screen.getByLabelText('Name'), 'LAB40')
    await userEvent.selectOptions(screen.getByLabelText('State'), 'active')
    await userEvent.click(screen.getByRole('button', { name: 'Preview change' }))

    await screen.findByText(/Review the device diff/u)
    expect(session.run).toHaveBeenCalledWith(['vlan 40', 'name LAB40', 'state active'])
    expect(session.diff).toHaveBeenCalledOnce()
  })

  it('rename, clear name, state and delete stage exactly the pyeapi-pinned texts', async () => {
    const { node, session } = makeFakes()
    await ready(node)

    await userEvent.selectOptions(screen.getByLabelText('VLAN'), '20')
    await userEvent.type(screen.getByLabelText('Name'), 'TELEPHONY')
    await userEvent.click(screen.getByRole('button', { name: 'Preview change' }))
    await screen.findByText(/Review the device diff/u)
    expect(session.run).toHaveBeenLastCalledWith(['vlan 20', 'name TELEPHONY'])

    await userEvent.click(screen.getByRole('button', { name: 'Abort staged changes' }))
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Abort staged changes' })).getByRole('button', { name: 'Abort staged changes' }))

    await chooseAction('clear-name')
    await userEvent.click(screen.getByRole('button', { name: 'Preview change' }))
    await screen.findByText(/Review the device diff/u)
    expect(session.run).toHaveBeenLastCalledWith(['vlan 20', 'no name'])

    await userEvent.click(screen.getByRole('button', { name: 'Abort staged changes' }))
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Abort staged changes' })).getByRole('button', { name: 'Abort staged changes' }))

    await chooseAction('set-state')
    await userEvent.selectOptions(screen.getByLabelText('State'), 'suspend')
    await userEvent.click(screen.getByRole('button', { name: 'Preview change' }))
    await screen.findByText(/Review the device diff/u)
    expect(session.run).toHaveBeenLastCalledWith(['vlan 20', 'state suspend'])

    await userEvent.click(screen.getByRole('button', { name: 'Abort staged changes' }))
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Abort staged changes' })).getByRole('button', { name: 'Abort staged changes' }))

    await chooseAction('delete')
    await userEvent.click(screen.getByRole('button', { name: 'Preview change' }))
    await screen.findByText(/Review the device diff/u)
    expect(session.run).toHaveBeenLastCalledWith(['no vlan 20'])
  })

  it('deleting a VLAN in use shows the referencing lines in the panel and repeats them in the confirm', async () => {
    const { node, session } = makeFakes()
    await ready(node)

    await userEvent.selectOptions(screen.getByLabelText('VLAN'), '20')
    await chooseAction('delete')
    // In-before-you-delete: the reference warning is visible before the change is even staged.
    expect(screen.getByText(/is referenced by 2 config line\(s\)/u)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Preview change' }))
    await screen.findByRole('list', { name: 'Config that references this VLAN' })
    expect(within(screen.getByRole('list', { name: 'Config that references this VLAN' })).getByText('Ethernet1 switchport access vlan 20')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Commit to running-config' }))
    const prompt = await screen.findByRole('dialog', { name: 'Confirm VLAN 20 change' })
    expect(within(prompt).getByText('ui-s2-session · vlan 20')).toBeInTheDocument()
    expect(within(prompt).getByText(/referenced by 2 config line/iu)).toBeInTheDocument()
    await userEvent.click(within(prompt).getByRole('button', { name: 'Cancel' }))
    expect(session.commit).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'Commit to running-config' }))
    const confirm2 = await screen.findByRole('dialog', { name: 'Confirm VLAN 20 change' })
    await userEvent.click(within(confirm2).getByRole('button', { name: 'Delete VLAN 20' }))
    expect(session.commit).toHaveBeenCalledOnce()
    expect(await screen.findByText('Changes committed to running-config. Startup-config was not changed.')).toBeInTheDocument()
  })

  it('the management VLAN is named as such in the warning and the confirm', async () => {
    const { node } = makeFakes()
    await ready(node)

    await userEvent.selectOptions(screen.getByLabelText('VLAN'), '100')
    await chooseAction('delete')
    expect(screen.getByText(/is the interface this device reports serving eAPI on/u)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Preview change' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Commit to running-config' }))
    const prompt = await screen.findByRole('dialog', { name: 'Confirm VLAN 100 change' })
    // The management fact came from the device's own answer, and it rides into the confirm as a note.
    expect(within(prompt).getByText(/the device reports serving eAPI on/u)).toBeInTheDocument()
    await userEvent.click(within(prompt).getByRole('button', { name: 'Cancel' }))
  })

  it('refuses to delete VLAN 1 and says plainly that the client does not', async () => {
    const { node, session } = makeFakes()
    await ready(node)

    await userEvent.selectOptions(screen.getByLabelText('VLAN'), '1')
    await chooseAction('delete')
    expect(screen.getByText(/client does not refuse/i)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Preview change' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/refused on this screen/u)
    expect(session.run).not.toHaveBeenCalled()
  })

  it('refuses an empty name and an out-of-range id without staging a command', async () => {
    const { node, session } = makeFakes()
    await ready(node)

    await userEvent.click(screen.getByRole('button', { name: 'Preview change' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/A name needs a value/u)

    await chooseAction('create')
    await userEvent.type(screen.getByLabelText('New VLAN id'), '9999')
    await userEvent.type(screen.getByLabelText('Name'), 'TOOBIG')
    await userEvent.click(screen.getByRole('button', { name: 'Preview change' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/outside the 1\.\.4094 write range/u)
    expect(session.run).not.toHaveBeenCalled()
  })

  it('an id the read produced but the client cannot write is displayed and refused, not re-formed', async () => {
    const { node, session } = makeFakes('accepted', {
      vlans: new Map<number, Vlan>([[4095, { id: 4095, name: 'BOGUS', state: 'active', trunkGroups: [] }]]),
    })
    await ready(node)

    expect(screen.getByText('not writable here')).toBeInTheDocument()
    await chooseAction('delete')
    await userEvent.click(screen.getByRole('button', { name: 'Preview change' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/outside the 1\.\.4094 write range/u)
    expect(session.run).not.toHaveBeenCalled()
  })

  it('a commit that fails keeps the session marked attempted and repeats the refresh warning', async () => {
    const { node, session } = makeFakes()
    await ready(node)

    session.commit.mockRejectedValueOnce(new Error('socket hang up'))
    await userEvent.selectOptions(screen.getByLabelText('VLAN'), '10')
    await chooseAction('set-state')
    await userEvent.selectOptions(screen.getByLabelText('State'), 'suspend')
    await userEvent.click(screen.getByRole('button', { name: 'Preview change' }))
    await screen.findByText(/Review the device diff/u)
    await userEvent.click(screen.getByRole('button', { name: 'Commit to running-config' }))
    const prompt = await screen.findByRole('dialog')
    await userEvent.click(within(prompt).getByRole('button', { name: 'Commit to running-config' }))

    const alert = (await screen.findAllByRole('alert')).find((n) => /socket hang up/u.test(n.textContent ?? ''))
    expect(alert).toBeDefined()
    expect(alert).toHaveTextContent('Commit was attempted; refresh device state before taking another action.')
    expect(screen.getAllByText(/Commit was attempted/u).length).toBe(2)
    expect(screen.getByRole('button', { name: 'Commit to running-config' })).toBeDisabled()
  })

  it('a pending session offers the config-lock cleanup and writes nothing until it is confirmed', async () => {
    const { node } = makeFakes('accepted', {
      listSessions: async () => ({ sessions: [{ name: 'stale-pending', state: 'pending', instances: [] }] }),
    })
    await ready(node)

    const abort = await screen.findByRole('button', { name: 'Abort pending session' })
    await userEvent.click(abort)
    const prompt = await screen.findByRole('dialog', { name: 'Abort pending device session' })
    expect(within(prompt).getByText(/holds the config lock/u)).toBeInTheDocument()
    await userEvent.click(within(prompt).getByRole('button', { name: 'Cancel' }))
    expect(node.abortSession).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'Abort pending session' }))
    const confirmPrompt = await screen.findByRole('dialog', { name: 'Abort pending device session' })
    await userEvent.click(within(confirmPrompt).getByRole('button', { name: 'Abort pending session' }))
    expect(node.abortSession).toHaveBeenCalledWith('stale-pending')
  })
})
