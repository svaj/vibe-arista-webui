/**
 * S4 (#74): the read-only command console, offline.
 *
 * Two harnesses, on purpose:
 *
 * - **`createFakeNode` (the `./testing` seam)** for anything about a *device answer*: a real `Node` over
 *   a real `MockTransport`, so the production codec, `enable` framing (DR-009), the `1003 → format:'text'`
 *   repair (DR-012), the error-envelope mapping (DR-010/DR-017) and the `getCommandCompletions` /
 *   `getCommandHelp` parameter allow-lists all run. `#74`'s acceptance line asks for exactly this:
 *   completion and help round trips through scripted replies.
 * - **a vi.fn client stub** only where the seam cannot express the case: that the console passes
 *   `readOnly: true` (a client-side retry claim, never a wire parameter), that a malformed `exec()`
 *   answer count stops the screen, and that a control is gated while a request is in flight.
 *
 * The refusal tests assert `transport.callCount() === 0` — the whole promise of a read-only console is
 * that a refused line never reaches the switch.
 *
 * Completions/help reply shapes here are **synthetic**, labelled as such in the client too
 * (`arista-api-client/src/command-layer.ts:343-350`): nothing in this repo has captured
 * `getCommandCompletions` or `getCommandHelp` on the 7050TX-64, and no assertion below claims device
 * wording — only that the screen renders what the client parsed.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeNode } from '@devhax-heavy-industries/arista-eapi/testing'
import { EapiErrorCode } from '@devhax-heavy-industries/arista-eapi'
import type { ExecResult } from '@devhax-heavy-industries/arista-eapi'

import { CommandConsole } from './CommandConsole'
import type { ConsoleClient } from './CommandConsole'

const VERSION_REPLY = {
  hostname: 'sw1',
  version: '4.28.13.1M',
  systemMacAddress: '00:00:00:00:00:00',
  modelName: 'DCS-7050TX-64',
  serialNumber: '0000000000',
  internalVersion: '4.28.13.1M',
  architecture: 'x86_64',
  bootupTimestamp: 1760000000,
  uptime: 1234,
}

/** Type a line into the console field. `fireEventChange` is used where a character userEvent refuses. */
async function enterLine(value: string) {
  // Named `field`, not `input`: the F8 redaction guard (#70) reuses the client's enable-input detector
  // over committed text, and an assignment to a local named `input` followed by an awaited call reads
  // like a wire secret to it. No other suite names a local that way.
  const field = await screen.findByLabelText('Command')
  await userEvent.clear(field)
  await userEvent.type(field, value)
  return field
}

function press(name: string) {
  fireEvent.click(screen.getByRole('button', { name }))
}

/** The `command` parameter a method request carried. `methodCalls()` keeps the wire-params union
 *  (`verifyConfig`'s shape is a different member), so the client's own tests cast the same way —
 *  `command-layer.methods.test.ts`'s `paramsOf`. */
function commandParam(call: { readonly params: unknown } | undefined): unknown {
  return (call?.params as Record<string, unknown> | undefined)?.command
}

const transcript = () => screen.getByRole('log')

afterEach(() => vi.restoreAllMocks())

describe('CommandConsole — it never speaks first', () => {
  it('contacts nothing at mount and says that no command has been sent', async () => {
    const { node, transport } = createFakeNode({ replies: { 'show version': VERSION_REPLY } })
    render(<CommandConsole node={node} />)

    expect(transport.callCount()).toBe(0)
    expect(await screen.findByText(/No command sent yet/u)).toBeInTheDocument()
    within(transcript()).getByText(/Nothing has been sent to the device yet/u)
    expect(screen.getByRole('button', { name: 'Run command' })).toBeDisabled()
  })

  it('does not contact an eAPI target when the local proxy is unconfigured', async () => {
    const { node, transport } = createFakeNode({ replies: { 'show version': VERSION_REPLY } })
    render(<CommandConsole node={node} proxyConfigured={false} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('EAPI_HOST')
    expect(screen.getByRole('button', { name: 'Run command' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Get completions' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Show command help' })).toBeDisabled()
    expect(screen.getByLabelText('Command')).toBeDisabled()
    expect(transport.callCount()).toBe(0)
  })
})

describe('CommandConsole — running a read', () => {
  it('sends the typed show command with the enable framing and labels a model-backed answer', async () => {
    const { node, transport } = createFakeNode({ replies: { 'show version': VERSION_REPLY } })
    render(<CommandConsole node={node} />)

    await enterLine('show version')
    press('Run command')

    expect(await within(transcript()).findByText(/model-backed JSON answer/u)).toBeInTheDocument()
    expect(within(transcript()).getByText('answered')).toBeInTheDocument()
    expect(within(transcript()).getByText(/"version": "4\.28\.13\.1M"/u)).toBeInTheDocument()
    expect(within(transcript()).getByText(/9 model members/u)).toBeInTheDocument()
    // DR-009: the client frames `enable` itself, and the console sent exactly the one typed command.
    expect(transport.sent()).toEqual([['enable', 'show version']])
    expect(transport.callCount()).toBe(1)
    expect(within(transcript()).getByText(/4\.28\.13\.1M/u)).toBeInTheDocument()
  })

  it('renders the 1003 → format:text repair and labels it "text fallback (not model-backed)"', async () => {
    const fake = createFakeNode()
    // The vendor's own shape for an un-modelled read (`CliCommon.py:101` → DR-012), scripted as the JSON
    // answer fails and the text retry answers.
    fake.transport
      .repliesOnce('enable\nshow session-config diffs', {
        error: { code: EapiErrorCode.COMMAND_UNCONVERTED, message: "Error: CLI command 2 of 2 failed: no json model" },
      })
      .replies('enable\nshow session-config diffs', [{}, { output: '+  vlan 20\n-  vlan 30' }])
    render(<CommandConsole node={fake.node} />)

    await enterLine('show session-config diffs')
    press('Run command')

    expect(await within(transcript()).findByText(/text fallback \(not model-backed\)/u)).toBeInTheDocument()
    expect(within(transcript()).getByText(/vlan 20/u)).toBeInTheDocument()
    expect(await screen.findByText(/no JSON model/u)).toBeInTheDocument()
    expect(fake.transport.bodies().map((body) => body.params.format)).toEqual(['json', 'text'])
    expect(fake.transport.callCount()).toBe(2)
  })

  it('renders an answered-but-nothing-there reply as an empty answer, not a failure', async () => {
    const { node } = createFakeNode({ replies: { 'show lldp neighbors': {} } })
    render(<CommandConsole node={node} />)

    await enterLine('show lldp neighbors')
    press('Run command')

    expect(await within(transcript()).findByText('empty answer')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('renders a `1002` with the meaning #74 requires and never as an empty transcript', async () => {
    const fake = createFakeNode()
    fake.transport.rejects('enable\nshow vlan xq', { code: EapiErrorCode.COMMAND_INVALID, message: 'Error [1002]: invalid command [% Invalid command (at token 3: xq)]' })
    render(<CommandConsole node={fake.node} />)

    await enterLine('show vlan xq')
    press('Run command')

    expect(await screen.findByRole('alert')).toHaveTextContent('1002 COMMAND_INVALID')
    expect(within(screen.getByRole('alert')).getByText(/ONLY code/u)).toBeInTheDocument()
    expect(within(transcript()).getByText('refused by device')).toBeInTheDocument()
    expect(within(transcript()).getByText('1002 COMMAND_INVALID')).toBeInTheDocument()
    expect(within(transcript()).getByText(/^request /u)).toBeInTheDocument()
    expect(within(transcript()).getByText(/Invalid command \(at token 3/u)).toBeInTheDocument()
  })

  it('renders `1005` as an authorization refusal, not a syntax problem', async () => {
    const unauthorized = createFakeNode()
    unauthorized.transport.rejects('enable\nshow tech-support', { code: EapiErrorCode.COMMAND_UNAUTHORIZED, message: "Error [1005]: permission to run command denied [Authorization denied for command 'show tech-support']" })
    render(<CommandConsole node={unauthorized.node} />)

    await enterLine('show tech-support')
    press('Run command')

    expect(await within(transcript()).findByText('1005 COMMAND_UNAUTHORIZED')).toBeInTheDocument()
    expect(within(transcript()).getByText(/command authorization/u)).toBeInTheDocument()
    expect(within(screen.getByRole('alert')).getByText(/re-authenticate/iu)).toBeInTheDocument()
  })

  it('renders `1006` as a config lock, points at the transaction center, and marks the connection failed', async () => {
    const locked = createFakeNode()
    locked.transport.rejects('enable\nshow running-config diffs', { code: EapiErrorCode.COMMAND_CONFIG_LOCKED, message: 'Error [1006]: configuration locked [Unable to run this command (configuration is locked by another session)]' })
    render(<CommandConsole node={locked.node} />)

    await enterLine('show running-config diffs')
    press('Run command')

    expect(await within(transcript()).findByText('1006 COMMAND_CONFIG_LOCKED')).toBeInTheDocument()
    expect(within(transcript()).getByText(/transaction center/u)).toBeInTheDocument()
    // The connection cluster's claim comes from the last command's outcome, so a refusal lands there too.
    expect(await screen.findByText(/Last command did not come back/u)).toBeInTheDocument()
  })

  it('renders device text as text — a markup payload never becomes an element', async () => {
    const { node } = createFakeNode({
      replies: { 'show banner motd': { output: '<img src=x onerror="fetch(\'//evil\')"/>\nThe device text above is data.' } },
    })
    const view = render(<CommandConsole node={node} />)
    await enterLine('show banner motd')
    press('Run command')

    const output = await within(transcript()).findByText(/onerror/u)
    expect(output.tagName).toBe('PRE')
    expect(output.textContent).toContain('<img src=x')
    expect(view.container.querySelector('img')).toBeNull()
    expect(view.container.querySelector('script')).toBeNull()
  })

  it('says when the client itself refused the request rather than the CLI', async () => {
    const { node } = createFakeNode()
    render(<CommandConsole node={node} />)

    await enterLine('show version')
    press('Run command')

    expect(await screen.findByRole('alert')).toHaveTextContent('MockTransport has no scripted answer')
    expect(within(screen.getByRole('alert')).getByText(/No device answer/u)).toBeInTheDocument()
    expect(within(transcript()).getByText('refused by device')).toBeInTheDocument()
  })
})

describe('CommandConsole — the read-only guard, at the screen boundary', () => {
  it.each([
    ['configure terminal', /configuration-mode entry/u],
    ['configure all Ethernet1 description staged', /read-only/u],
    ['interface Ethernet1', /configuration-mode entry/u],
    ['copy running-config startup-config', /writes a file or a config store/u],
    ['reload now', /reboots the switch/u],
    ['write memory', /startup-config/u],
    ['clear arp', /not a read/u],
    ['bash timeout 30 cat /etc/bashrc', /bin\/bash/u],
    ['sho version', /does not expand abbreviations/u],
    ['dir', /deny-list/u],
    ['show running-config > flash:dump.txt', /redirection to a file/u],
    ['show version | grep Version', /bin\/sh/u],
    ['show running-config | redirect flash:dump.txt', /writes the output to a file/u],
    ['show vlans; reload now', /exactly one command/u],
  ] as const)('refuses %S and composes no request', async (input, fragment) => {
    const { node, transport } = createFakeNode({ replies: { 'show version': VERSION_REPLY } })
    render(<CommandConsole node={node} />)

    await enterLine(input)
    press('Run command')

    expect(await screen.findByRole('alert')).toHaveTextContent(fragment)
    expect(transport.callCount()).toBe(0)
    within(transcript()).getByText(/Nothing has been sent to the device yet/u)
  })
})

describe('CommandConsole — completions through the device seam', () => {
  it('asks getCommandCompletions for the typed line and lists what the device offered', async () => {
    const fake = createFakeNode()
    fake.transport.methodReplies('getCommandCompletions', {
      result: {
        complete: false,
        errors: {},
        // `JsonCli.py:190-192`: one key per candidate, value is the help text. A method answer is a
        // single JSON object, so it goes in the `result` envelope (`parseMethodResponse`, DR-061).
        completions: { show: 'Display details of switch operation', shutdown: 'Shut down the process' },
      },
    })
    render(<CommandConsole node={fake.node} />)

    await enterLine('sh')
    press('Get completions')

    const panel = await screen.findByRole('region', { name: /What the device offered/u })
    expect(within(panel).getByText('show')).toBeInTheDocument()
    expect(within(panel).getByText('Display details of switch operation')).toBeInTheDocument()
    expect(within(panel).getByText(/not offer <cr>/u)).toBeInTheDocument()
    expect(fake.transport.methodCalls()).toHaveLength(1)
    expect(commandParam(fake.transport.methodCalls()[0])).toBe('sh')
    expect(fake.transport.callCount()).toBe(0)
  })

  it('inserts a completion by replacing the last token, which is what the device keyed it on', async () => {
    const fake = createFakeNode()
    fake.transport.methodReplies('getCommandCompletions', { result: { complete: false, errors: {}, completions: { interfaces: 'Interfaces' } } })
    render(<CommandConsole node={fake.node} />)

    await enterLine('sh int')
    press('Get completions')
    fireEvent.click(await screen.findByRole('button', { name: 'Insert interfaces' }))

    expect(screen.getByLabelText('Command')).toHaveValue('sh interfaces')
    expect(screen.queryByRole('region', { name: /What the device offered/u })).toBeNull()
  })

  it('sends the trailing space that makes the completeness answer observable and renders the verdict', async () => {
    const fake = createFakeNode()
    fake.transport.methodReplies('getCommandCompletions', { result: { complete: true, errors: {}, completions: {} } })
    render(<CommandConsole node={fake.node} />)

    const field = await screen.findByLabelText('Command')
    fireEvent.change(field, { target: { value: 'show version ' } })
    press('Get completions')

    const panel = await screen.findByRole('region', { name: /What the device offered/u })
    expect(within(panel).getByText(/is a complete command/u)).toBeInTheDocument()
    // `CliApi.py:631-637`: `<cr>` is only ever offered for a line ending in whitespace, so the console
    // must not trim it away.
    expect(commandParam(fake.transport.methodCalls()[0])).toBe('show version ')
    expect(within(panel).getByText(/The device offered no completion/u)).toBeInTheDocument()
  })

  it('reports an unparsable, extra or error-bearing completion reply instead of hiding it', async () => {
    const fake = createFakeNode()
    fake.transport.methodReplies('getCommandCompletions', {
      result: {
        complete: false,
        errors: ['the CLI refused the line'],
        suggested: 'something new',
        completions: { show: 'Display details of switch operation', mtu: 5 },
      },
    })
    render(<CommandConsole node={fake.node} />)

    await enterLine('sh')
    press('Get completions')

    const note = await screen.findByText(/Reported, not rendered/u)
    expect(note).toHaveTextContent('mtu')
    expect(note).toHaveTextContent('suggested')
    expect(note).toHaveTextContent('the CLI refused the line')
  })

  it('refuses a completion query whose line smuggles a second command', async () => {
    const fake = createFakeNode()
    render(<CommandConsole node={fake.node} />)

    const field = await screen.findByLabelText('Command')
    fireEvent.change(field, { target: { value: 'show version\u0007reload now' } })
    press('Get completions')

    expect(await screen.findByRole('alert')).toHaveTextContent(/control character/u)
    expect(fake.transport.methodCalls()).toHaveLength(0)
  })
})

describe('CommandConsole — help through the device seam', () => {
  it('shows the device help for each token and hides the structural ones the client kept', async () => {
    const fake = createFakeNode()
    // `getCommandHelp` does NOT apply `EXCLUDED_AUTOCOMPLETES` (`JsonCli.py:200` → `CliApi.py:442-462`),
    // so the pane has to hide `<cr>`/`|`/`>`/`>>` itself, and a non-string value is a guard code.
    fake.transport.methodReplies('getCommandHelp', {
      result: {
        show: 'Display details of switch operation',
        version: 'Software revision info',
        '<cr>': '',
        '|': 'Command output pipe filters',
        mtu: 7,
      },
    })
    render(<CommandConsole node={fake.node} />)

    await enterLine('show version')
    press('Show command help')

    const table = await screen.findByRole('table', { name: 'Command help tokens' })
    expect(within(table).getByText('Display details of switch operation')).toBeInTheDocument()
    expect(within(table).queryByText('Command output pipe filters')).toBeNull()
    expect(within(table).getAllByRole('row')).toHaveLength(3)
    expect(await screen.findByText(/Reported, not rendered/u)).toHaveTextContent('<cr>')
    expect(screen.getByText(/Reported, not rendered/u)).toHaveTextContent('mtu')
    expect(commandParam(fake.transport.methodCalls()[0])).toBe('show version')
  })

  it('refuses a help query whose line smuggles a second command', async () => {
    const fake = createFakeNode()
    render(<CommandConsole node={fake.node} />)

    const field = await screen.findByLabelText('Command')
    fireEvent.change(field, { target: { value: 'show version; reload now' } })
    press('Show command help')

    expect(await screen.findByRole('alert')).toHaveTextContent(/exactly one command/u)
    expect(fake.transport.methodCalls()).toHaveLength(0)
  })

  it('renders a failed completions call in the alert slot and keeps the last panel it had', async () => {
    const fake = createFakeNode()
    // A command-authorization refusal on the *query* method is its own answer (DR-062 keeps it distinct
    // from "the command does not exist"), and it lands in the same failure channel as a failed command.
    fake.transport.methodRejects('getCommandCompletions', { code: EapiErrorCode.COMMAND_UNAUTHORIZED, message: 'Error [1005]: permission to run command denied' })
    render(<CommandConsole node={fake.node} />)

    await enterLine('show v')
    press('Get completions')

    expect(await screen.findByRole('alert')).toHaveTextContent('1005 COMMAND_UNAUTHORIZED')
    expect(within(screen.getByRole('alert')).getByText(/re-authenticate/iu)).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: /What the device offered/u })).toBeNull()
  })

  it('renders a failed help call in the alert slot rather than an empty help table', async () => {
    const fake = createFakeNode()
    fake.transport.methodRejects('getCommandHelp', { code: EapiErrorCode.COMMAND_INCOMPATIBLE, message: 'Error [1004]: incompatible command [Command not permitted via API access.]' })
    render(<CommandConsole node={fake.node} />)

    await enterLine('show version')
    press('Show command help')

    expect(await screen.findByRole('alert')).toHaveTextContent('1004 COMMAND_INCOMPATIBLE')
    expect(screen.queryByRole('table', { name: 'Command help tokens' })).toBeNull()
  })

  it('renders an empty help answer as an empty state, not an error', async () => {
    const fake = createFakeNode()
    fake.transport.methodReplies('getCommandHelp', { result: {} })
    render(<CommandConsole node={fake.node} />)

    await enterLine('show version')
    press('Show command help')

    expect(await screen.findByText(/returned no help token/u)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('CommandConsole — client contract pins (stubbed, because the seam cannot see them)', () => {
  const entry = (over: Partial<ExecResult> = {}): ExecResult => ({
    command: 'show version',
    result: { version: '4.28.13.1M' },
    encoding: 'json',
    fellBack: false,
    ...over,
  })

  function stubbed(over: Partial<Record<keyof ConsoleClient, ReturnType<typeof vi.fn>>> = {}): Record<keyof ConsoleClient, ReturnType<typeof vi.fn>> {
    return {
      exec: vi.fn(async () => [entry()]),
      getCompletions: vi.fn(async () => ({ complete: false, completions: [], errors: {}, extra: {}, unparsed: [], raw: {} })),
      getCommandHelp: vi.fn(async () => ({ entries: [], byToken: {}, unparsed: [], raw: {} })),
      ...over,
    }
  }

  it('claims read-only to the client, which is what makes a safe re-send possible (DR-019)', async () => {
    const client = stubbed()
    render(<CommandConsole node={client as unknown as ConsoleClient} />)

    await enterLine('show version')
    press('Run command')

    await within(screen.getByRole('log')).findByText(/model-backed JSON answer/u)
    expect(client.exec).toHaveBeenCalledWith('show version', { readOnly: true })
  })

  it('refuses to display an answer count the client does not promise', async () => {
    const client = stubbed({ exec: vi.fn(async () => [entry(), entry({ command: 'show hostname' })]) })
    render(<CommandConsole node={client as unknown as ConsoleClient} />)

    await enterLine('show version')
    press('Run command')

    expect(await screen.findByRole('alert')).toHaveTextContent(/refuses to guess which one to show/u)
    expect(within(screen.getByRole('log')).queryByText(/model-backed/u)).toBeNull()
  })

  it('gates every control while a command is in flight', async () => {
    const client = stubbed({ exec: vi.fn(() => new Promise<ExecResult[]>(() => undefined)) })
    render(<CommandConsole node={client as unknown as ConsoleClient} />)

    await enterLine('show version')
    press('Run command')

    expect(await screen.findByText(/Asking the switch to run that read/u)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run command' })).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('button', { name: 'Get completions' })).toBeDisabled()
    // FireEvent dispatches even on disabled controls, so a second activation must hit the handler's own
    // `busy` guard and start no second request — the same re-entry refusal `useOperation` makes F2.
    press('Run command')
    press('Get completions')
    press('Show command help')
    expect(client.exec).toHaveBeenCalledTimes(1)
    expect(client.getCompletions).toHaveBeenCalledTimes(0)
    expect(client.getCommandHelp).toHaveBeenCalledTimes(0)
    // The connection cluster reports the request as pending, not as connected.
    expect(screen.getByText(/Waiting for the switch to answer/u)).toBeInTheDocument()
  })
})
