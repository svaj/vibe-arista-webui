/**
 * S13 (#83): the ACL screen, offline through hand-rolled fake client seams — the `Ntp.test.tsx` shape
 * (a config-backed resource: the seam is `acls.standard.getAll()` / `acls.extended.getAll()` plus
 * `configSession()`, and the scenario values are hand-authored config-shaped records, not captured
 * payloads). No test here contacts a device, and nothing fabricates a `show access-lists` contract.
 *
 * The acceptance lines #83 grades, pinned below:
 * - "pinned command texts at session.run" — each staged argv is copied from a pin in
 *   `arista-api-client/src/resources/acl.test.ts` (create `:524-525`, delete `:557`/`:573`, add `:603-605`
 *   and `:644-646`, replace `:586`/`:627`, remove `:616`/`:647`), with the session description on the
 *   `webui acl <action>` convention;
 * - "always-destructive delete with the gap text" — deletion needs an acknowledgement before Preview,
 *   stages behind the risky commit control, and its confirm carries {@link REFERENCE_GAP} verbatim; the
 *   refusal arm is pinned too: without the box ticked ZERO sessions open;
 * - "cancelling the confirm sends nothing" — declining leaves `commit()` at zero calls;
 * - "reproducibility refusal" — a rule carrying an operator keeps its Edit control disabled and the
 *   reason is rendered next to it, at zero sessions;
 * - "four states" — no-proxy, loading, failed read, ready, with an empty list as a normal ready state;
 * - "no counters" — the `<th>` set of every table is pinned, and no header reads like a statistic;
 * - the config diff renders in a real `<pre>` (tagName pin).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Acl, AclEntry, AclType } from '@devhax-heavy-industries/arista-eapi'

import { Acls } from './Acls'
import { COUNTER_GAP, REFERENCE_GAP } from './acl-rules'
import { ENTRY_COLUMNS } from './AclsView'

type TestNode = NonNullable<Parameters<typeof Acls>[0]['node']>

// ====================================================================================================
// Fixtures: config-shaped records, written the way the client's own reader keys them
// ====================================================================================================

const standardEntry = (over: Partial<AclEntry> & { seqno: number, action: 'permit' | 'deny', src: AclEntry['src'] }): AclEntry => ({ ...over })

const STANDARD_TEST: Acl = {
  name: 'test',
  type: 'standard',
  entries: new Map<number, AclEntry>([
    [10, standardEntry({ seqno: 10, action: 'permit', src: { kind: 'host', address: '1.2.3.4' }, log: true })],
    [20, standardEntry({ seqno: 20, action: 'permit', src: { kind: 'address', address: '10.20.0.0', mask: '0.0.255.255' } })],
  ]),
}

/** A section header with no body: what the client reads back as an empty entry map. */
const STANDARD_EMPTY: Acl = { name: 'quiet', type: 'standard', entries: new Map<number, AclEntry>() }

const EXTENDED_TEST: Acl = {
  name: 'exttest',
  type: 'extended',
  entries: new Map<number, AclEntry>([
    [30, standardEntry({ seqno: 30, action: 'deny', protocol: 'ip', src: { kind: 'any' }, dst: { kind: 'any' }, log: true })],
    // A port operator the read model carries and the write verbs never re-emit (divergence 9).
    [60, standardEntry({ seqno: 60, action: 'permit', protocol: 'tcp', src: { kind: 'host', address: '1.1.1.1', operator: 'eq 161' }, dst: { kind: 'host', address: '2.2.2.2' } })],
  ]),
}

function table(kind: AclType, acls: readonly Acl[]): ReadonlyMap<string, Acl> {
  for (const acl of acls) {
    if (acl.type !== kind) throw new Error(`fixture ${acl.name} is a ${acl.type} block, not ${kind}`)
  }
  return new Map(acls.map((acl) => [acl.name, acl]))
}

interface Overrides {
  readonly standard?: readonly Acl[] | Error
  readonly extended?: readonly Acl[] | Error
  readonly diff?: string
  readonly diffRead?: boolean
  readonly commitError?: Error
  /** The client session's state at review time; `committed` is the one the abort guard refuses. */
  readonly sessionState?: 'open' | 'diffed' | 'committed'
  /** A `diff()` that has not answered: the review panel must show a wait, not a commit affordance. */
  readonly diffPending?: boolean
}

/** Set while a case is exercising a `diff()` the device has not answered yet. */
let pendingDiffResolve: ((value: string) => void) | undefined

function makeFakes(overrides: Overrides = {}) {
  const session = {
    name: 'ui-s13-session',
    state: overrides.sessionState ?? 'diffed',
    isOpen: false,
    run: vi.fn(async () => []),
    diff: vi.fn(overrides.diffPending === true
      // Deliberately unresolved; the test below releases it so nothing outlives the case.
      ? () => new Promise<string>((resolve) => { pendingDiffResolve = resolve })
      : async () => overrides.diff ?? '+ip access-list standard test'),
    hasDiffBeenRead: vi.fn(() => overrides.diffRead ?? true),
    commit: vi.fn(async () => {
      if (overrides.commitError !== undefined) throw overrides.commitError
      return []
    }),
    abort: vi.fn(async () => []),
  }
  const standardGetAll = vi.fn(async () => {
    if (overrides.standard instanceof Error) throw overrides.standard
    return table('standard', overrides.standard ?? [STANDARD_TEST, STANDARD_EMPTY])
  })
  const extendedGetAll = vi.fn(async () => {
    if (overrides.extended instanceof Error) throw overrides.extended
    return table('extended', overrides.extended ?? [EXTENDED_TEST])
  })
  const configSession = vi.fn(async () => session)
  const node = { acls: { standard: { getAll: standardGetAll }, extended: { getAll: extendedGetAll } }, configSession } as unknown as TestNode
  return { node, session, standardGetAll, extendedGetAll, configSession }
}

function renderScreen(fakes: ReturnType<typeof makeFakes>) {
  return render(<Acls node={fakes.node} proxyConfigured />)
}

/** Readiness probe: the ready payload only lands after BOTH kind reads resolve. */
async function readyScreen(): Promise<void> {
  await screen.findByText('10 permit host 1.2.3.4 log')
}

async function stageReady(fakes: ReturnType<typeof makeFakes>): Promise<void> {
  await waitFor(() => expect(fakes.session.run).toHaveBeenCalled())
  await screen.findByText(/Review the device diff before committing this change/u)
}

/** The confirm dialog's body text, which is where a promise about the device has to be true. */
function confirmBody(): string {
  return document.getElementById('confirm-dialog-body')?.textContent ?? ''
}

const nameField = () => screen.getByLabelText('ACL name')
const kindField = () => screen.getByLabelText('Kind')
const actionField = () => screen.getByLabelText('Action')
const protocolField = () => screen.getByLabelText('Protocol token')
const seqField = () => screen.getByLabelText('Sequence number (blank lets the device number the rule)')
const srcModeField = () => screen.getByLabelText('Source form')
const srcAddressField = () => screen.getByLabelText('Source address (dotted quad)')
const srcLengthField = () => screen.getByLabelText(/prefix length/u)
const srcMaskField = () => screen.getByLabelText(/wildcard mask/u)
const dstModeField = () => screen.getByLabelText('Destination form')
const logField = () => screen.getByLabelText(/Append/u)
const ackField = () => screen.getByLabelText(/I accept that this screen did/u)

/** Fill the add-rule form for `permit tcp host 1.1.1.1 host 2.2.2.2 log`, sequence number aside. */
function fillExtendedHosts(): void {
  fireEvent.change(actionField(), { target: { value: 'permit' } })
  fireEvent.change(protocolField(), { target: { value: 'tcp' } })
  fireEvent.change(srcModeField(), { target: { value: 'host' } })
  fireEvent.change(srcAddressField(), { target: { value: '1.1.1.1' } })
  fireEvent.change(dstModeField(), { target: { value: 'host' } })
  fireEvent.change(screen.getByLabelText('Destination address (dotted quad)'), { target: { value: '2.2.2.2' } })
  fireEvent.click(logField())
}

// ====================================================================================================
// Four states — nothing contacted unless the operator asks
// ====================================================================================================

describe('Acls — four states', () => {
  it('no proxy: prompt, every control disabled, and both getAll() plus configSession() stay at zero calls', () => {
    const fakes = makeFakes()
    render(<Acls node={fakes.node} proxyConfigured={false} />)

    expect(screen.getByRole('alert')).toHaveTextContent('Local proxy is not configured')
    expect(screen.getByRole('button', { name: 'Create ACL' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Reload device state' })).toBeDisabled()
    expect(fakes.standardGetAll).not.toHaveBeenCalled()
    expect(fakes.extendedGetAll).not.toHaveBeenCalled()
    expect(fakes.configSession).not.toHaveBeenCalled()
  })

  it('loading: the read is in flight and the copy names the running-config as the source', () => {
    makeFakes()
    renderScreen(makeFakes())
    expect(screen.getByText(/Reading the running-config \(access lists come from the parsed config sections/u)).toBeInTheDocument()
  })

  it('ready: both kinds are shown as the config writes them, with header lines and rule lines', async () => {
    renderScreen(makeFakes())
    await readyScreen()

    // the two section headers, spelled the way the client composes them
    expect(screen.getByText('ip access-list standard test')).toBeInTheDocument()
    expect(screen.getByText('ip access-list exttest')).toBeInTheDocument()
    // rules as config text, including the standard wildcard arm kept verbatim
    expect(screen.getByText('20 permit 10.20.0.0 0.0.255.255')).toBeInTheDocument()
    expect(screen.getByText('30 deny ip any any log')).toBeInTheDocument()
    // the operator-carrying rule is shown exactly as read, operator and all
    expect(screen.getByText('60 permit tcp host 1.1.1.1 eq 161 host 2.2.2.2')).toBeInTheDocument()
    // the empty section is a configured state, not a gap in the read
    expect(screen.getByText('This access list has no rules.')).toBeInTheDocument()
    // and the screen says what it is
    expect(screen.getByText(/access lists exactly as the running-config writes them/u)).toBeInTheDocument()
  })

  it('an empty device is a normal ready state for both kinds, with no alert', async () => {
    renderScreen(makeFakes({ standard: [], extended: [] }))
    await screen.findByText(/No standard access lists are configured/u)

    expect(screen.getByText(/No extended access lists are configured/u)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('either read failing is an error, never a blank panel: alert copy, controls locked, no session', async () => {
    const fakes = makeFakes({ extended: new Error('SYNTHETIC config read exploded') })
    renderScreen(fakes)

    expect(await screen.findByRole('alert')).toHaveTextContent('SYNTHETIC config read exploded')
    expect(screen.getByRole('button', { name: 'Create ACL' })).toBeDisabled()
    // Both kinds are marked unread rather than rendered as empty lists, and no listing is invented.
    expect(screen.getByText(/No standard read has answered yet/u)).toBeInTheDocument()
    expect(screen.getByText(/No extended read has answered yet/u)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add rule to test' })).toBeNull()
    expect(fakes.configSession).not.toHaveBeenCalled()
  })

  it('no counters: the <th> set of every table is pinned, and no header reads like a statistic', async () => {
    const { container } = renderScreen(makeFakes())
    await readyScreen()

    // The gap statement about counters appears exactly once, verbatim, before any staged write exists.
    expect(screen.getByText(COUNTER_GAP, { exact: true })).toBeInTheDocument()
    const headers = [...container.querySelectorAll('table th')].map((th) => th.textContent ?? '')
    // every header is one of the declared column sets
    expect(new Set(headers)).toEqual(new Set([...ENTRY_COLUMNS, 'ACL', 'Header line', 'Rules', 'Actions']))
    // nothing that could be mistaken for a counter column, and no counter value in a cell
    expect(headers.filter((header) => /hit|counter|packet|matched/iu.test(header))).toEqual([])
    for (const code of container.querySelectorAll('table code')) {
      expect(code.textContent).not.toMatch(/^\s*\d+\s*$/u)
    }
  })

  it('the screen never claims live filtering or interface application', async () => {
    const { container } = renderScreen(makeFakes())
    await readyScreen()
    expect(container.textContent).toContain('not a view of live packet filtering')
    expect(container.textContent).toMatch(/statistics are unknown — not captured/u)
    // The only 'applied' wording on the page is the statement that this screen cannot see application:
    // no rule is ever presented as active on an interface.
    expect(screen.queryByText(/applied on (Ethernet|Management)/u)).toBeNull()
    expect(REFERENCE_GAP).toMatch(/no read in this client covers `ip access-group`/u)
  })
})

// ====================================================================================================
// Section writes: create, and the always-destructive delete
// ====================================================================================================

describe('Acls — section verbs stage the client-pinned argv', () => {
  it('create standard: session `webui acl create` runs exactly `ip access-list standard test` (acl.test.ts:524)', async () => {
    // The name `test` is free here: the client's pin text is what this asserts, and a name the read
    // already lists is refused (the clash test below), so this leg starts from one standard section.
    const fakes = makeFakes({ standard: [STANDARD_EMPTY] })
    renderScreen(fakes)
    await screen.findByText(/No rules were read|This access list has no rules/u)

    fireEvent.change(nameField(), { target: { value: 'test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create ACL' }))
    await stageReady(fakes)

    expect(fakes.configSession).toHaveBeenCalledWith({ description: 'webui acl create' })
    expect(fakes.session.run).toHaveBeenCalledWith(['ip access-list standard test'])
  })

  it('create extended: `ip access-list exttest` (acl.test.ts:525) in the same named-session shape', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyScreen()

    fireEvent.change(nameField(), { target: { value: 'brandnew' } })
    fireEvent.change(kindField(), { target: { value: 'extended' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create ACL' }))
    await stageReady(fakes)

    expect(fakes.session.run).toHaveBeenCalledWith(['ip access-list brandnew'])
    fireEvent.click(screen.getByRole('button', { name: 'Commit to running-config' }))
    fireEvent.click(await screen.findByRole('button', { name: /Commit despite the risk: ip access-list brandnew/u }))
    await waitFor(() => expect(fakes.session.commit).toHaveBeenCalled())
    await waitFor(() => expect(fakes.standardGetAll).toHaveBeenCalledTimes(2))
    expect(screen.getByText(/Startup-config was not changed/u)).toBeInTheDocument()
  })

  it('delete: the gap text is up front and Preview stays locked until the acknowledgement', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyScreen()

    fireEvent.click(screen.getByRole('button', { name: 'Delete ACL test' }))
    // The verbatim gap statement, before any session exists.
    expect(screen.getByText(REFERENCE_GAP, { exact: true })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Preview deletion of test' })).toBeDisabled()
    expect(fakes.configSession).not.toHaveBeenCalled()

    fireEvent.click(ackField())
    fireEvent.click(screen.getByRole('button', { name: 'Preview deletion of test' }))
    await stageReady(fakes)

    expect(fakes.configSession).toHaveBeenCalledWith({ description: 'webui acl delete' })
    expect(fakes.session.run).toHaveBeenCalledWith(['no ip access-list standard test'])
  })

  it('delete is ALWAYS destructive and its confirm repeats the gap text verbatim', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyScreen()

    fireEvent.click(screen.getByRole('button', { name: 'Delete ACL quiet' }))
    fireEvent.click(ackField())
    fireEvent.click(screen.getByRole('button', { name: 'Preview deletion of quiet' }))
    await stageReady(fakes)

    // the risk list carries the gap statement as its own bullet…
    expect(screen.getAllByText(REFERENCE_GAP).length).toBeGreaterThan(0)
    // …and so does the diff-less review before the confirm
    fireEvent.click(screen.getByRole('button', { name: 'Commit (risky — review above)' }))
    await screen.findByRole('button', { name: /Commit despite the risk: no ip access-list standard quiet/u })
    expect(confirmBody()).toContain('no ip access-list standard quiet')
    expect(confirmBody()).toContain(REFERENCE_GAP)
  })

  it('declining the delete confirm writes nothing: commit() and abort() stay at zero, one session only', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyScreen()

    fireEvent.click(screen.getByRole('button', { name: 'Delete ACL test' }))
    fireEvent.click(ackField())
    fireEvent.click(screen.getByRole('button', { name: 'Preview deletion of test' }))
    await stageReady(fakes)

    fireEvent.click(screen.getByRole('button', { name: 'Commit (risky — review above)' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))

    expect(fakes.session.commit).not.toHaveBeenCalled()
    expect(fakes.session.abort).not.toHaveBeenCalled()
    expect(fakes.configSession).toHaveBeenCalledTimes(1)
  })

  it('cancelling the delete panel before Preview opens no session at all', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyScreen()

    fireEvent.click(screen.getByRole('button', { name: 'Delete ACL test' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel deletion' }))

    expect(fakes.configSession).not.toHaveBeenCalled()
    expect(screen.queryByText(REFERENCE_GAP, { exact: true })).toBeNull()
  })

  it('a create that clashes with a name the read already shows is refused in-form at zero sessions', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyScreen()

    fireEvent.change(nameField(), { target: { value: 'exttest' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create ACL' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/already exists as an? extended access list/u)
    expect(fakes.configSession).not.toHaveBeenCalled()
  })

  it('a blank ACL name keeps the control disabled, and a padded one is refused by the client grammar', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyScreen()

    // Blank never reaches the client at all: the control itself is the first guard.
    fireEvent.change(nameField(), { target: { value: '   ' } })
    expect(screen.getByRole('button', { name: 'Create ACL' })).toBeDisabled()
    expect(fakes.configSession).not.toHaveBeenCalled()

    // Whitespace the client's assertAclName refuses (a section key could not read back as typed).
    fireEvent.change(nameField(), { target: { value: ' spaced ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create ACL' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/leading or trailing whitespace/u)
    expect(fakes.configSession).not.toHaveBeenCalled()
  })
})

// ====================================================================================================
// Entry verbs
// ====================================================================================================

describe('Acls — entry verbs stage the client-pinned argv', () => {
  it('remove rule: `no 10` inside the section (acl.test.ts:616), behind the risky commit control', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyScreen()

    fireEvent.click(screen.getByRole('button', { name: 'Remove rule 10' }))
    await stageReady(fakes)

    expect(fakes.configSession).toHaveBeenCalledWith({ description: 'webui acl remove entry' })
    expect(fakes.session.run).toHaveBeenCalledWith(['ip access-list standard test', 'no 10', 'exit'])
    // The refusal copy never claims an interface check happened.
    expect(screen.getByText(/no client read covers `ip access-group`/u)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Commit (risky — review above)' })).toBeEnabled()
  })

  it('add rule with a sequence number (acl.test.ts:605): header, numbered line, exit', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyScreen()

    fireEvent.click(screen.getByRole('button', { name: 'Add rule to test' }))
    fireEvent.change(actionField(), { target: { value: 'deny' } })
    fireEvent.change(seqField(), { target: { value: '40' } })
    fireEvent.change(srcModeField(), { target: { value: 'prefix' } })
    fireEvent.change(srcAddressField(), { target: { value: '172.16.0.0' } })
    fireEvent.change(srcLengthField(), { target: { value: '16' } })
    fireEvent.click(screen.getByRole('button', { name: 'Preview add rule to test' }))
    await stageReady(fakes)

    expect(fakes.configSession).toHaveBeenCalledWith({ description: 'webui acl add entry' })
    expect(fakes.session.run).toHaveBeenCalledWith(['ip access-list standard test', '40 deny 172.16.0.0/16', 'exit'])
  })

  it('add rule with no sequence number: the device numbers it (acl.test.ts:603) — no client-side number appears', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyScreen()

    fireEvent.click(screen.getByRole('button', { name: 'Add rule to quiet' }))
    fireEvent.change(actionField(), { target: { value: 'permit' } })
    fireEvent.change(srcModeField(), { target: { value: 'any' } })
    fireEvent.click(screen.getByRole('button', { name: 'Preview add rule to quiet' }))
    await stageReady(fakes)

    expect(fakes.session.run).toHaveBeenCalledWith(['ip access-list standard quiet', 'permit any', 'exit'])
    expect(screen.getByText(/the DEVICE numbers this rule/u)).toBeInTheDocument()
  })

  it('add extended rule with hosts and log (acl.test.ts:646 mirrored on the host arms)', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyScreen()

    fireEvent.click(screen.getByRole('button', { name: 'Add rule to exttest' }))
    fillExtendedHosts()
    fireEvent.change(seqField(), { target: { value: '40' } })
    fireEvent.click(screen.getByRole('button', { name: 'Preview add rule to exttest' }))
    await stageReady(fakes)

    expect(fakes.session.run).toHaveBeenCalledWith(['ip access-list exttest', '40 permit tcp host 1.1.1.1 host 2.2.2.2 log', 'exit'])
  })

  it('the client-pinned `permit ip any any` stays reachable by choosing the destination', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyScreen()

    fireEvent.click(screen.getByRole('button', { name: 'Add rule to exttest' }))
    fireEvent.change(actionField(), { target: { value: 'permit' } })
    fireEvent.change(protocolField(), { target: { value: 'ip' } })
    fireEvent.change(dstModeField(), { target: { value: 'any' } })
    fireEvent.click(screen.getByRole('button', { name: 'Preview add rule to exttest' }))
    await stageReady(fakes)

    expect(fakes.session.run).toHaveBeenCalledWith(['ip access-list exttest', 'permit ip any any', 'exit'])
  })

  it('replace rule: prefill from the read and stage `no 20` before the numbered replacement (acl.test.ts:586)', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyScreen()

    fireEvent.click(screen.getByRole('button', { name: 'Edit rule 20' }))
    // the form came back from the config text, not from a guess
    expect(actionField()).toHaveValue('permit')
    expect(srcMaskField()).toHaveValue('0.0.255.255')
    fireEvent.click(screen.getByRole('button', { name: 'Preview replace rule 20' }))
    await stageReady(fakes)

    expect(fakes.configSession).toHaveBeenCalledWith({ description: 'webui acl replace entry' })
    expect(fakes.session.run).toHaveBeenCalledWith(['ip access-list standard test', 'no 20', '20 permit 10.20.0.0 0.0.255.255', 'exit'])
    // a replace is a negation first, so it confirms as a risky write
    expect(screen.getByRole('button', { name: 'Commit (risky — review above)' })).toBeEnabled()
  })

  it('cancel rule form stages nothing and clears the panel', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyScreen()

    fireEvent.click(screen.getByRole('button', { name: 'Add rule to test' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel rule form' }))

    expect(fakes.configSession).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Preview add rule to test' })).toBeNull()
  })
})

// ====================================================================================================
// In-form refusals — every one of them costs zero sessions
// ====================================================================================================

describe('Acls — refusals happen in-form', () => {
  it('a rule carrying an operator or an option tail keeps Edit disabled and says why, at zero sessions', async () => {
    renderScreen(makeFakes())
    await readyScreen()

    expect(screen.getByRole('button', { name: 'Edit rule 60' })).toBeDisabled()
    const note = await screen.findByText(/source operator "eq 161"/u)
    expect(note.textContent).toMatch(/never written back/u)
    expect(note.textContent).toMatch(/Deciding what 4\.28 accepts for that tail is a capture question/u)
    // Remove stays available: taking the whole line out IS something this screen can do honestly.
    expect(screen.getByRole('button', { name: 'Remove rule 60' })).toBeEnabled()
  })

  it('a duplicated sequence number is refused by this screen (the client has no such guard)', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyScreen()

    fireEvent.click(screen.getByRole('button', { name: 'Add rule to test' }))
    fireEvent.change(actionField(), { target: { value: 'permit' } })
    fireEvent.change(seqField(), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Preview add rule to test' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/already used in this ACL/u)
    expect(fakes.configSession).not.toHaveBeenCalled()
  })

  it('a non-numeric sequence number is refused by the client grammar', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyScreen()

    fireEvent.click(screen.getByRole('button', { name: 'Add rule to test' }))
    fireEvent.change(actionField(), { target: { value: 'permit' } })
    fireEvent.change(seqField(), { target: { value: '1e3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Preview add rule to test' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/digits only/u)
    expect(fakes.configSession).not.toHaveBeenCalled()
  })

  it('an untouched destination is refused in-form, and the mask arm is not even offered on the extended side', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyScreen()

    fireEvent.click(screen.getByRole('button', { name: 'Add rule to exttest' }))
    fireEvent.change(actionField(), { target: { value: 'permit' } })
    fireEvent.click(screen.getByRole('button', { name: 'Preview add rule to exttest' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/destination is untouched/u)
    expect(fakes.configSession).not.toHaveBeenCalled()

    // `<address> <mask>` is a standard-ACL spelling: this client's extended reader would take the mask
    // token for the destination, so the form gives the operator no way to ask for it (the rules module
    // carries the matching refusal, pinned in acl-rules.test.ts).
    const dstMode = dstModeField() as HTMLSelectElement
    expect([...dstMode.options].some((option) => option.value === 'wildcard')).toBe(false)
    expect([...(srcModeField() as HTMLSelectElement).options].some((option) => option.value === 'wildcard')).toBe(false)
    expect(fakes.configSession).not.toHaveBeenCalled()
  })

  it('a multi-word protocol token is refused before the line is composed', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyScreen()

    fireEvent.click(screen.getByRole('button', { name: 'Add rule to exttest' }))
    fireEvent.change(actionField(), { target: { value: 'permit' } })
    fireEvent.change(protocolField(), { target: { value: 'tcp 80' } })
    fireEvent.click(screen.getByRole('button', { name: 'Preview add rule to exttest' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/single protocol token/u)
    expect(fakes.configSession).not.toHaveBeenCalled()
  })

  it('a source address the client grammar refuses is refused in-form, at zero sessions', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyScreen()

    fireEvent.click(screen.getByRole('button', { name: 'Add rule to test' }))
    fireEvent.change(actionField(), { target: { value: 'permit' } })
    // The host arm needs a dotted quad; pyeapi would interpolate whatever arrived straight into the line,
    // so both the blank case and the malformed case are refused before a session is paid for.
    fireEvent.change(srcModeField(), { target: { value: 'host' } })
    fireEvent.click(screen.getByRole('button', { name: 'Preview add rule to test' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/source address is empty/u)

    fireEvent.change(srcAddressField(), { target: { value: '1.2.3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Preview add rule to test' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/dotted-quad IPv4 address for the source/u))

    expect(fakes.configSession).not.toHaveBeenCalled()
  })

  it('no action chosen is the client guard speaking first', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyScreen()

    fireEvent.click(screen.getByRole('button', { name: 'Add rule to test' }))
    fireEvent.click(screen.getByRole('button', { name: 'Preview add rule to test' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/Choose permit or deny/u)
    expect(fakes.configSession).not.toHaveBeenCalled()
  })

  it('a standard rule composes no protocol field at all — the field is not even rendered', async () => {
    renderScreen(makeFakes())
    await readyScreen()

    fireEvent.click(screen.getByRole('button', { name: 'Add rule to test' }))
    expect(screen.queryByLabelText('Protocol token')).toBeNull()
    expect(screen.queryByLabelText('Destination form')).toBeNull()
  })
})

// ====================================================================================================
// Staging discipline and device-error surfacing
// ====================================================================================================

describe('Acls — staging discipline and device-error surfacing', () => {
  it('a second write while a session is staged is refused (one transaction at a time)', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyScreen()

    fireEvent.click(screen.getByRole('button', { name: 'Remove rule 10' }))
    await stageReady(fakes)

    // A second line for the same ACL is its own transaction, so the container refuses it by name rather
    // than opening a second session — the review panel stays up with the first diff.
    fireEvent.click(screen.getByRole('button', { name: 'Remove rule 20' }))
    expect(await screen.findByText(/A staged session is already open/u)).toBeInTheDocument()
    expect(fakes.configSession).toHaveBeenCalledTimes(1)
    expect(fakes.session.run).toHaveBeenCalledTimes(1)
  })

  it('commit stays locked until the device diff has been read', async () => {
    const fakes = makeFakes({ diffRead: false })
    renderScreen(fakes)
    await readyScreen()

    fireEvent.click(screen.getByRole('button', { name: 'Remove rule 10' }))
    await stageReady(fakes)

    // An entry removal is a risky write, so the review panel offers the risky verb — and it is locked.
    expect(screen.getByRole('button', { name: 'Commit (risky — review above)' })).toBeDisabled()
    expect(fakes.session.commit).not.toHaveBeenCalled()
  })

  it('the staged review renders the device diff inside a real <pre> (untrusted text, not HTML)', async () => {
    const fakes = makeFakes({ diff: '-   10 permit host 1.2.3.4 log' })
    const { container } = renderScreen(fakes)
    await readyScreen()

    fireEvent.click(screen.getByRole('button', { name: 'Remove rule 10' }))
    await stageReady(fakes)

    const pre = container.querySelector('pre.diff-output')
    expect(pre).not.toBeNull()
    expect(pre?.tagName).toBe('PRE')
    // The device's own text, leading whitespace and all — the diff is rendered, not normalised.
    expect(pre?.textContent).toBe('-   10 permit host 1.2.3.4 log')
  })

  it('abort discards the staged line and writes nothing', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyScreen()

    fireEvent.click(screen.getByRole('button', { name: 'Remove rule 10' }))
    await stageReady(fakes)

    fireEvent.click(screen.getByRole('button', { name: 'Abort staged changes' }))
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Abort staged changes' })).toHaveLength(2))
    fireEvent.click(screen.getAllByRole('button', { name: 'Abort staged changes' }).at(-1)!)

    await waitFor(() => expect(fakes.session.abort).toHaveBeenCalled())
    expect(fakes.session.commit).not.toHaveBeenCalled()
  })

  it('a write the device rejects surfaces the device text plus the commit-recovery warning (never a false success)', async () => {
    const fakes = makeFakes({ commitError: new Error('Command rejected: 40 deny 172.16.0.0/16 not valid here') })
    renderScreen(fakes)
    await readyScreen()

    fireEvent.click(screen.getByRole('button', { name: 'Remove rule 10' }))
    await stageReady(fakes)
    // Taking a configured rule out is a destructive write, so the review panel offers the risky verb.
    fireEvent.click(screen.getByRole('button', { name: 'Commit (risky — review above)' }))
    fireEvent.click(await screen.findByRole('button', { name: /Commit despite the risk: no 10 in test/u }))

    const alert = await screen.findByText(/Command rejected: 40 deny 172\.16\.0\.0\/16 not valid here/u)
    expect(alert.textContent).toContain('Commit was attempted; refresh device state')
    expect(screen.queryByText(/Startup-config was not changed/u)).toBeNull()
  })

  it('an abort is refused once the session is no longer open, and sends nothing', async () => {
    const fakes = makeFakes({ sessionState: 'committed' })
    renderScreen(fakes)
    await readyScreen()

    fireEvent.click(screen.getByRole('button', { name: 'Remove rule 10' }))
    await stageReady(fakes)
    // The client's session is `committed`, so there is nothing left to discard: the screen refuses
    // before even asking, and neither device verb is sent.
    fireEvent.click(screen.getByRole('button', { name: 'Abort staged changes' }))
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Abort staged changes' })).toHaveLength(1))
    expect(fakes.session.abort).not.toHaveBeenCalled()
    expect(fakes.session.commit).not.toHaveBeenCalled()
  })

  it('commit stays locked while the device has not answered its own diff', async () => {
    const fakes = makeFakes({ diffPending: true })
    renderScreen(fakes)
    await readyScreen()

    fireEvent.click(screen.getByRole('button', { name: 'Remove rule 10' }))
    await waitFor(() => expect(fakes.session.run).toHaveBeenCalled())

    // The staged batch is up, the diff is not: review says it is waiting and offers no commit.
    expect(await screen.findByText('Reading the device diff…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Commit (risky — review above)' })).toBeDisabled()
    expect(fakes.session.commit).not.toHaveBeenCalled()

    // Release the device so the case leaves nothing in flight.
    pendingDiffResolve?.('+ip access-list standard test')
    pendingDiffResolve = undefined
  })

  it('a standard rule can be staged with the wildcard arm, kept exactly as typed', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyScreen()

    fireEvent.click(screen.getByRole('button', { name: 'Add rule to quiet' }))
    fireEvent.change(actionField(), { target: { value: 'deny' } })
    fireEvent.change(srcModeField(), { target: { value: 'wildcard' } })
    fireEvent.change(srcAddressField(), { target: { value: '192.168.0.0' } })
    fireEvent.change(srcMaskField(), { target: { value: '0.0.0.255' } })
    fireEvent.click(screen.getByRole('button', { name: 'Preview add rule to quiet' }))
    await stageReady(fakes)

    // The wildcard is the standard-only spelling the client both reads and writes (acl.test.ts:672), and
    // the helper never converts it: the mask goes out as typed, not as a prefix length.
    expect(fakes.session.run).toHaveBeenCalledWith(['ip access-list standard quiet', 'deny 192.168.0.0 0.0.0.255', 'exit'])
  })

  it('a rule carrying both the log token and an option tail shows them as one configured tail', async () => {
    // The client splits a trailing `log` into its own field and keeps the rest of the tail verbatim
    // (divergence 10), so the screen shows both, in the order the config writes them, as config text.
    const combined: AclEntry = { seqno: 80, action: 'deny', protocol: 'ip', src: { kind: 'any' }, dst: { kind: 'any' }, log: true, options: 'urg ttl eq 24 fragments tracked' }
    const withCombined: Acl = { name: 'tailtest', type: 'extended', entries: new Map<number, AclEntry>([[80, combined]]) }
    renderScreen(makeFakes({ extended: [withCombined] }))
    await screen.findByText('80 deny ip any any log urg ttl eq 24 fragments tracked')

    expect(screen.getByText('log urg ttl eq 24 fragments tracked')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit rule 80' })).toBeDisabled()
    // Nothing in that cell is a number: it is the tail the reader kept, never a counter.
    expect(screen.getByText('log urg ttl eq 24 fragments tracked').textContent).not.toMatch(/^\d+$/u)
  })

  it('declining the abort confirm leaves the staged session exactly where it was', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyScreen()

    fireEvent.click(screen.getByRole('button', { name: 'Remove rule 10' }))
    await stageReady(fakes)

    fireEvent.click(screen.getByRole('button', { name: 'Abort staged changes' }))
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Abort staged changes' })).toHaveLength(2))
    // The dialog's own Cancel: neither device verb is sent and the diff stays under review.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(fakes.session.abort).not.toHaveBeenCalled()
    expect(fakes.session.commit).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Commit (risky — review above)' })).toBeEnabled()
    expect(fakes.configSession).toHaveBeenCalledTimes(1)
  })

  it('a read that fails on reload takes the controls away instead of leaving a stale listing editable', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyScreen()

    fakes.standardGetAll.mockImplementationOnce(async () => { throw new Error('SYNTHETIC refresh failed') })
    fireEvent.click(screen.getByRole('button', { name: 'Reload device state' }))

    // The failure is shown as a failure: no leftover rows to act on, and nothing staged behind them.
    expect(await screen.findByRole('alert')).toHaveTextContent('SYNTHETIC refresh failed')
    expect(screen.getByRole('button', { name: 'Create ACL' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Remove rule 10' })).toBeNull()
    expect(fakes.configSession).not.toHaveBeenCalled()
  })

  it('a rule the client only reports in `options` is shown as configured text and refuses the edit', async () => {
    const tailOnly: AclEntry = { seqno: 70, action: 'permit', protocol: 'tcp', src: { kind: 'any' }, dst: { kind: 'any' }, options: 'ttl eq 1 tracked' }
    const withTail: Acl = { name: 'opttest', type: 'extended', entries: new Map<number, AclEntry>([[70, tailOnly]]) }
    renderScreen(makeFakes({ extended: [withTail] }))
    await screen.findByText('70 permit tcp any any ttl eq 1 tracked')

    // The tail reaches the Log / options column verbatim — it is config text, never a statistic — and
    // the rule cannot be rewritten, because the client's verbs would drop the tail.
    expect(screen.getByText('ttl eq 1 tracked')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit rule 70' })).toBeDisabled()
    expect(screen.getByText(/option tail "ttl eq 1 tracked"/u)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove rule 70' })).toBeEnabled()
  })

  it('a log-only rule shows the token without any remainder, and stays editable', async () => {
    renderScreen(makeFakes())
    await readyScreen()

    // Entries 10 (standard) and 30 (extended) carry only `log`, so two Log / options cells spell that
    // token and nothing else. The rule-line cells hold the whole line, which is a different string.
    expect(screen.getAllByText('log')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Edit rule 10' })).toBeEnabled()
    // Entry 20 writes neither log nor options: the cell says nothing was written rather than showing 0,
    // and there is no read-only note for either standard rule.
    expect(screen.getAllByText('nothing written').length).toBeGreaterThan(0)
    expect(screen.queryByRole('list', { name: 'Rules of test this screen cannot rewrite' })).toBeNull()
  })

  it('reload re-reads both kinds without opening anything', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyScreen()

    fireEvent.click(screen.getByRole('button', { name: 'Reload device state' }))
    await waitFor(() => expect(fakes.standardGetAll).toHaveBeenCalledTimes(2))
    expect(fakes.extendedGetAll).toHaveBeenCalledTimes(2)
    expect(fakes.configSession).not.toHaveBeenCalled()
  })

  it('a row action on a kind the read did not answer is refused rather than guessed', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyScreen()

    // The screen knows the ACL only through the read; a name it never listed has no row at all.
    expect(screen.queryByRole('button', { name: 'Delete ACL never-configured' })).toBeNull()
    expect(fakes.configSession).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Delete ACL test' })).toBeEnabled()
  })
})
