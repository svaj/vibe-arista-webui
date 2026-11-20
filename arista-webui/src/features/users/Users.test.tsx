/**
 * S11 (#81): the users / SSH-keys / roles screen, offline through hand-rolled fake client seams — the
 * `SystemSettings.test.tsx` shape: the read seam is `users.getAll()`, scripted with hand-authored
 * config-shaped `User` records in the shapes `arista-api-client/src/resources/users.test.ts` parses,
 * never captured payloads. No test here contacts a device or a proxy.
 *
 * The acceptance lines this file pins, in #81's own words:
 * - **"user create/privilege/role/delete command texts pinned"**: the fake session's `run()` argv,
 *   character-for-character against the client's own pins — `username X secret <fmt> <v>`,
 *   `username X secret *`, `username X nopassword`, `username X privilege N`, `username X role R`,
 *   `username X ssh-key K` / `username X sshkey K`, and the `no`/`default username X …` family;
 * - **"the never-demote-last-admin refusal has a test"**: zero `configSession()` calls, next to the
 *   built-in-`admin`, privilege-15-create and unknown-version-spelling guards on the same footing;
 * - **"a test that cancel performs no `no username`"**: declining the confirm resolves false, the
 *   staged delete is aborted, and `commit()` stays at zero calls;
 * - **"no AAA/TACACS+/RADIUS commands reachable here"**: no offered action label carries that
 *   vocabulary, and every staged batch is scanned before a session opens;
 * - **"four states"**: no-proxy, loading, failed read (the device's own text), ready — plus the empty
 *   read, which is an empty state and never an error.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Node, User } from '@devhax-heavy-industries/arista-eapi'

import { TransactionProvider, useTransactionSnapshot } from '../sessions/TransactionContext'
import type { TransactionSnapshot } from '../sessions/transaction'
import { Users, SECRET_ENCODINGS, loginLabelFor } from './Users'
import { LOCKOUT_BANNER } from './users-rules'

type TestNode = NonNullable<Parameters<typeof Users>[0]['node']>
type Fakes = ReturnType<typeof makeFakes>

/** Hand-authored in the shapes the client's parser answers (`users.test.ts:52-57`), keeping its absence
 *  rule: a field the config does not carry is absent, never an invented default (row 151). `admin` and
 *  `test15` are the two admins; `test15` also carries the one configured SSH key in the table. */
const CONFIGURED: readonly User[] = [
  { name: 'admin', privilege: 1, role: 'network-admin', nopassword: true },
  { name: 'eapi', privilege: 1, nopassword: false, secretFormat: '5' },
  { name: 'ops', privilege: 5, role: 'ops', nopassword: false, secretFormat: 'sha512' },
  { name: 'test15', privilege: 15, role: 'network-admin', nopassword: false, sshKey: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQDoperator key@rack' },
  { name: 'test3', privilege: 9, role: 'ops', nopassword: true },
]

/** One admin on the table: the last-admin guards fire on it and nothing else. */
const SOLE_ADMIN: readonly User[] = [
  { name: 'eapi', privilege: 1, nopassword: true },
  { name: 'test15', privilege: 15, role: 'network-admin', nopassword: false },
]

/** No privilege-15 / network-admin account at all: a privilege-15 create is the guarded case, and so is
 *  any demote-by-default shape. */
const NO_ADMINS: readonly User[] = [
  { name: 'eapi', privilege: 1, nopassword: true },
  { name: 'ops', privilege: 3, role: 'ops', nopassword: false },
]

const versionReply = (version: string) => ({
  hostname: 'sw1', version, systemMacAddress: '00:00:00:00:00:00', modelName: 'DCS-7050TX-64-R',
  serialNumber: '0000000000', internalVersion: version, architecture: 'x86_64', bootupTimestamp: 0, uptime: 0,
})

interface Overrides {
  readonly table?: readonly User[] | Error | 'pending'
  readonly version?: string | 'unreadable'
  readonly diff?: string | 'pending'
  readonly diffRead?: boolean
}

function makeFakes(overrides: Overrides = {}) {
  // Every session call lands in one list, so the run -> diff -> commit ordering #81 asks for is pinned
  // as data instead of inferred from a success string.
  const order: string[] = []
  const session = {
    name: 'webui-users-s11',
    state: 'diffed',
    run: vi.fn(async (specs: readonly string[]) => {
      order.push(`run[${specs.join(' ; ')}]`)
      return []
    }),
    diff: vi.fn(async () => {
      order.push('diff')
      const answer = overrides.diff ?? '+username ops privilege 5'
      // A diff that never answers is how the "a diff is required before commit" arm is exercised.
      if (answer === 'pending') await new Promise<never>(() => undefined)
      return answer
    }),
    hasDiffBeenRead: vi.fn(() => overrides.diffRead ?? true),
    commit: vi.fn(async () => {
      order.push('commit')
      return []
    }),
    abort: vi.fn(async () => {
      order.push('abort')
      return []
    }),
  }
  const getAll = vi.fn(async (): Promise<Map<string, User>> => {
    const table = overrides.table ?? CONFIGURED
    if (table === 'pending') {
      // A read that never settles is how the loading arm is exercised; the awaited promise never
      // resolves, so the second guard below is control flow the test can never reach.
      await new Promise<never>(() => undefined)
    }
    if (table === 'pending') throw new Error('unreachable: the pending read never settles')
    if (table instanceof Error) throw table
    return new Map(table.map((user) => [user.name, user]))
  })
  const show = vi.fn(async (command: string) => {
    if (command !== 'version') throw new Error(`SYNTHETIC unexpected show: ${command}`)
    if (overrides.version === 'unreadable') throw new Error('SYNTHETIC this role cannot run show version')
    return versionReply(overrides.version ?? '4.28.13.1M')
  })
  const configSession = vi.fn(async () => session)
  const node = { users: { getAll }, show, configSession } as unknown as TestNode
  return { node, session, getAll, show, configSession, order }
}

function SnapshotProbe() {
  const snapshot = useTransactionSnapshot()
  const visible = {
    ...snapshot,
    entries: snapshot.entries.map((entry) => ({ ...entry, commands: entry.display })),
  }
  return <output data-testid="transaction-snapshot">{JSON.stringify(visible)}</output>
}

async function ready(fakes: Fakes) {
  const view = render(
    <TransactionProvider node={fakes.node as Node}>
      <Users node={fakes.node} proxyConfigured />
      <SnapshotProbe />
    </TransactionProvider>,
  )
  await screen.findByRole('heading', { level: 2, name: 'Users & roles' })
  return view
}

function snapshot(): TransactionSnapshot {
  return JSON.parse(screen.getByTestId('transaction-snapshot').textContent ?? '{}') as TransactionSnapshot
}

/** Stage a write and wait until the shared coordinator has appended and diffed the entry. */
async function staged(fakes: Fakes, entries = 1) {
  await waitFor(() => expect(fakes.configSession).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(snapshot().entries).toHaveLength(entries))
  await screen.findByText(/User change added to the transaction/u)
}

function chooseAction(action: string) {
  fireEvent.change(screen.getByLabelText(/^Action$/u), { target: { value: action } })
}

function chooseAccount(name: string) {
  fireEvent.change(screen.getByLabelText(/^Account$/u), { target: { value: name } })
}

function type(field: RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(field), { target: { value } })
}

function preview() {
  fireEvent.click(screen.getByRole('button', { name: 'Preview and read the device diff' }))
}

/** Wait until a refusal has landed in one of the screen's alert slots (an in-form field error, the
 *  operation summary, or both) and return their joined text for further pins. */
async function refusalCopy(pattern: RegExp): Promise<string> {
  await waitFor(() => expect(alerts()).toMatch(pattern))
  return alerts()
}

function alerts(): string {
  return screen.getAllByRole('alert').map((element) => element.textContent ?? '').join('\n')
}

describe('Users — four states, and nothing contacted without the operator asking', () => {
  it('no proxy: the proxy prompt plus #81\u2019s standing banner, every write control disabled, and getAll/show/configSession at zero calls', () => {
    const fakes = makeFakes()
    render(<Users node={fakes.node} proxyConfigured={false} />)

    expect(screen.getByRole('alert')).toHaveTextContent('Local proxy is not configured')
    expect(screen.getByRole('button', { name: 'Preview and read the device diff' })).toBeDisabled()
    expect(screen.getByLabelText(/^Action$/u)).toBeDisabled()
    expect(fakes.getAll).not.toHaveBeenCalled()
    expect(fakes.show).not.toHaveBeenCalled()
    expect(fakes.configSession).not.toHaveBeenCalled()
    // The lockout banner is not conditional on a device answer: it stands in the unconfigured state too.
    expect(screen.getByText(LOCKOUT_BANNER)).toBeInTheDocument()
  })

  it('loading: the read is announced as in flight, the counts stay unknown, and no write is offered', () => {
    const fakes = makeFakes({ table: 'pending' })
    const { container } = render(<Users node={fakes.node} proxyConfigured />)

    expect(screen.getByText(/Reading the running-config for the local user table/u)).toHaveAttribute('aria-busy', 'true')
    expect(container.querySelector('.inventory-strip')?.textContent).toContain('?')
    expect(screen.getByRole('button', { name: 'Preview and read the device diff' })).toBeDisabled()
    expect(fakes.configSession).not.toHaveBeenCalled()
  })

  it('a failed user read is the device\u2019s own error text, never an empty table, and every write stays locked', async () => {
    const fakes = makeFakes({ table: new Error('1005 unauthorized: this account cannot read the configuration') })
    const { container } = await ready(fakes)

    expect(await screen.findByRole('alert')).toHaveTextContent('1005 unauthorized: this account cannot read the configuration')
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.getByText('The user read did not come back')).toBeInTheDocument()
    expect(container.querySelector('.inventory-strip')?.textContent).toContain('?')
    expect(screen.getByRole('button', { name: 'Preview and read the device diff' })).toBeDisabled()
    expect(fakes.configSession).not.toHaveBeenCalled()
  })

  it('ready: the parsed-config table with its markers, the admin flags, and a configured SSH key as <pre> TEXT', async () => {
    const { container } = await ready(makeFakes())

    for (const header of ['Username', 'Privilege', 'Role', 'Login secret', 'SSH key', 'Admin guard']) {
      expect(screen.getByRole('columnheader', { name: header })).toBeInTheDocument()
    }
    // Absence is reported as absence (divergence 2), and a read secret is only ever a format marker (DR-089).
    expect(screen.getByText('secret 5 (md5 hash)')).toBeInTheDocument()
    expect(screen.getAllByText('nopassword (no login secret configured)')).toHaveLength(2)
    expect(screen.getByText('secret sha512 (hash form)')).toBeInTheDocument()
    expect(screen.getByText('no secret line read')).toBeInTheDocument()
    // A privilege line the config carries is a number, not the string pyeapi reports (row 151).
    expect(screen.getByText('15')).toBeInTheDocument()
    expect(screen.getAllByText('privilege-15 / network-admin')).toHaveLength(2)
    expect(screen.getAllByText('not an admin by this read')).toHaveLength(3)
    expect(screen.getByText('the client refuses to delete this name')).toBeInTheDocument()
    expect(screen.getByText(/lower bound, not a device promise/u)).toBeInTheDocument()
    // The identity chip rides the soft version read, and the inventory counts what the read named.
    expect(container.querySelector('.device-identity')).not.toBeNull()
    expect(container.querySelector('.inventory-strip')?.textContent).toContain('5')
    // Untrusted device text renders as a real <pre>, and nothing device-shaped becomes HTML.
    expect(screen.getByText(/ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQDoperator/u).tagName).toBe('PRE')
    expect(container.querySelector('img')).toBeNull()
    // #81's two standing notices.
    expect(screen.getByText(LOCKOUT_BANNER)).toBeInTheDocument()
    expect(screen.getByText(/local users only/u)).toBeInTheDocument()
  })

  it('a config with no username lines is an empty state, not an error \u2014 and the guards still refuse a demote', async () => {
    const fakes = makeFakes({ table: [] })
    await ready(fakes)

    expect(screen.getByText('The device returned no local username entries.')).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()

    chooseAction('set-privilege')
    type(/Privilege level/u, '7')
    preview()
    expect(await screen.findByRole('alert')).toHaveTextContent(/this action needs one the read answered/u)
    expect(fakes.configSession).not.toHaveBeenCalled()
  })
})

describe('Users \u2014 every staged command is the client\u2019s own text, pinned at the session run() argv', () => {
  it('create-secret stages the pinned sha512 create line plus the optional privilege line in one named session', async () => {
    const fakes = makeFakes({ diff: '+username newadmin secret sha512 materialtheuihasneverseen\n+username newadmin privilege 15' })
    await ready(fakes)
    expect(SECRET_ENCODINGS).toEqual(['cleartext', 'md5', 'sha512'])

    type(/New username/u, 'newadmin')
    type(/Secret encoding to send/u, 'sha512')
    type(/Secret \(typed once/u, 'materialtheuihasneverseen')
    type(/Optional privilege for the new account/u, '15')
    preview()
    await staged(fakes)

    expect(fakes.configSession).toHaveBeenCalledWith(expect.objectContaining({ description: 'webui shared transaction' }))
    // The exact create text (users.py:198 through ENCRYPTION_MAP :58) and the exact set_privilege text
    // (users.py:262 through command_builder), as users.test.ts pins them.
    expect(fakes.session.run).toHaveBeenCalledWith([
      'username newadmin secret sha512 materialtheuihasneverseen',
      'username newadmin privilege 15',
    ])
    expect(snapshot().entries[0]?.display).toEqual([
      'username newadmin secret sha512 [secret redacted by this UI]',
      'username newadmin privilege 15',
    ])
    expect(document.body.textContent).not.toContain('materialtheuihasneverseen')
  })

  it('create-nologin and create-nopassword stage the two-token lock-out and the nopassword lines', async () => {
    const fakes = makeFakes({ table: NO_ADMINS })
    await ready(fakes)

    type(/New username/u, 'svc')
    chooseAction('create-nologin')
    preview()
    await staged(fakes)
    expect(fakes.session.run).toHaveBeenLastCalledWith(['username svc secret *'])

    chooseAction('create-nopassword')
    type(/New username/u, 'svc2')
    preview()
    await staged(fakes, 2)
    expect(fakes.session.run).toHaveBeenLastCalledWith(['username svc2 nopassword'])
    expect(fakes.configSession).toHaveBeenCalledTimes(1)
  })

  it('the create form’s optional privilege is held to the same pin, so nothing stages when it fails', async () => {
    const fakes = makeFakes({ table: NO_ADMINS })
    await ready(fakes)
    chooseAction('create-nologin')
    type(/New username/u, 'svc')
    type(/Optional privilege for the new account/u, '99')
    preview()
    await refusalCopy(/Privilege 99 is outside 0/u)
    expect(fakes.configSession).not.toHaveBeenCalled()
    expect(fakes.session.run).not.toHaveBeenCalled()
  })

  it('the Reload slot re-runs the parsed-config read rather than trusting the first answer', async () => {
    const fakes = makeFakes()
    await ready(fakes)
    fireEvent.click(screen.getByRole('button', { name: 'Reload device state' }))
    await waitFor(() => expect(fakes.getAll).toHaveBeenCalledTimes(2))
    expect(within(screen.getByRole('table', { name: /Local user accounts/u })).getAllByRole('row')).toHaveLength(6)
  })

  it('privilege set / clear / default stage the three pinned privilege forms', async () => {
    const fakes = makeFakes()
    await ready(fakes)

    chooseAction('set-privilege')
    chooseAccount('ops')
    type(/Privilege level/u, '7')
    preview()
    await staged(fakes)
    expect(fakes.session.run).toHaveBeenLastCalledWith(['username ops privilege 7'])

    chooseAction('unset-privilege')
    chooseAccount('ops')
    preview()
    await staged(fakes, 2)
    expect(fakes.session.run).toHaveBeenLastCalledWith(['no username ops privilege'])

    chooseAction('default-privilege')
    chooseAccount('ops')
    preview()
    await staged(fakes, 3)
    expect(fakes.session.run).toHaveBeenLastCalledWith(['default username ops privilege'])
    expect(fakes.configSession).toHaveBeenCalledTimes(1)
  })

  it('role set / clear / default stage the trio pyeapi\u2019s own suite pins, and the vocabulary stays the device\u2019s', async () => {
    const fakes = makeFakes()
    await ready(fakes)

    chooseAction('set-role')
    chooseAccount('test3')
    type(/^Role token/u, 'network-operator')
    preview()
    await staged(fakes)
    expect(fakes.session.run).toHaveBeenLastCalledWith(['username test3 role network-operator'])

    chooseAction('unset-role')
    chooseAccount('test3')
    preview()
    await staged(fakes, 2)
    expect(fakes.session.run).toHaveBeenLastCalledWith(['no username test3 role'])

    chooseAction('default-role')
    chooseAccount('test3')
    preview()
    await staged(fakes, 3)
    expect(fakes.session.run).toHaveBeenLastCalledWith(['default username test3 role'])
    expect(fakes.configSession).toHaveBeenCalledTimes(1)
  })

  it('the ssh-key family is one INLINE line, spelled by the version read: 4.28 answers the dashed form', async () => {
    const fakes = makeFakes()
    const { container } = await ready(fakes)

    chooseAction('set-ssh-key')
    chooseAccount('ops')
    type(/Public SSH key/u, 'ssh-ed25519 AAAA3 noc@rack')
    preview()
    await staged(fakes)
    // The framing #81\u2019s W2 note asks to verify before offering the control: users.py:290-315 interpolates
    // inline and its suite pins the inline texts, so there is no {cmd, input} pair to frame here.
    expect(fakes.session.run).toHaveBeenLastCalledWith(['username ops ssh-key ssh-ed25519 AAAA3 noc@rack'])
    expect(container.textContent).toMatch(/not a `\{cmd, input\}` pair/u)
    expect(container.textContent).toMatch(/Staged spelling: ssh-key/u)

    chooseAction('unset-ssh-key')
    chooseAccount('ops')
    preview()
    await staged(fakes, 2)
    expect(fakes.session.run).toHaveBeenLastCalledWith(['no username ops ssh-key'])

    chooseAction('default-ssh-key')
    chooseAccount('ops')
    preview()
    await staged(fakes, 3)
    expect(fakes.session.run).toHaveBeenLastCalledWith(['default username ops ssh-key'])
    expect(fakes.configSession).toHaveBeenCalledTimes(1)
  })

  it('a pre-4.23 release is handed the undashed spelling (the client\u2019s numeric floor, DR-078)', async () => {
    const old = makeFakes({ version: '4.17.1.1' })
    await ready(old)
    chooseAction('unset-ssh-key')
    chooseAccount('ops')
    preview()
    await staged(old)
    expect(old.session.run).toHaveBeenLastCalledWith(['no username ops sshkey'])
  })

  it('a version read that answers nothing refuses the ssh-key action instead of guessing a spelling', async () => {
    const unknown = makeFakes({ version: 'unreadable' })
    await ready(unknown)
    // The soft version read failing costs the chip and the ssh-key spelling, and claims nothing else (F3).
    expect(document.querySelector('.device-identity')).toBeNull()
    chooseAction('set-ssh-key')
    chooseAccount('ops')
    type(/Public SSH key/u, 'ssh-ed25519 AAAA3 noc@rack')
    preview()
    expect(await refusalCopy(/version read has not answered/u)).toMatch(/cannot pick `ssh-key` from `sshkey`/u)
    expect(alerts()).toMatch(/SSH-key spelling could not be decided/u)
    expect(document.body.textContent).toMatch(/Staged spelling: unknown until the version read answers/u)
    expect(unknown.configSession).not.toHaveBeenCalled()
    expect(unknown.session.run).not.toHaveBeenCalled()
  })

  it('delete and default of an ordinary account append the two bare verbs to one session', async () => {
    const fakes = makeFakes({ diff: '-username ops privilege 5\n-username ops role ops\n-username ops secret sha512 materialtheuihasneverseen' })
    await ready(fakes)

    chooseAction('delete-user')
    chooseAccount('ops')
    preview()
    await staged(fakes)
    expect(fakes.session.run).toHaveBeenLastCalledWith(['no username ops'])
    expect(fakes.session.commit).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /Commit/u })).not.toBeInTheDocument()

    chooseAction('default-user')
    chooseAccount('ops')
    preview()
    await staged(fakes, 2)
    expect(fakes.session.run).toHaveBeenLastCalledWith(['default username ops'])
    expect(fakes.configSession).toHaveBeenCalledTimes(1)
    expect(fakes.order).toEqual(['run[no username ops]', 'diff', 'run[default username ops]', 'diff'])
  })

  it('a device diff that echoes a secret is redacted in the coordinator snapshot', async () => {
    const fakes = makeFakes({ diff: '+username ops secret sha512 materialtheuihasneverseen' })
    await ready(fakes)
    chooseAction('set-privilege')
    chooseAccount('ops')
    type(/Privilege level/u, '9')
    preview()
    await staged(fakes)

    expect(snapshot().diff).toBe('+username ops secret sha512 [secret redacted by this UI]')
    expect(document.body.textContent).not.toContain('materialtheuihasneverseen')
  })

  it('the login markers a re-read can report, in the client\u2019s own vocabulary (DR-089 never hands back a value)', () => {
    expect(CONFIGURED.map((user) => loginLabelFor(user))).toEqual([
      'nopassword (no login secret configured)',
      'secret 5 (md5 hash)',
      'secret sha512 (hash form)',
      'no secret line read',
      'nopassword (no login secret configured)',
    ])
    expect(loginLabelFor({ name: 'lock', nopassword: false, secretFormat: 'nologin' })).toContain('locked out')
    expect(loginLabelFor({ name: 'hidden', nopassword: false, secretFormat: '7' })).toContain('hidden/reversible')
    expect(loginLabelFor({ name: 'plain', nopassword: false, secretFormat: '0' })).toContain('cleartext')
  })
})

describe('Users \u2014 the self-lockout guards refuse before a session is paid for', () => {
  it('the last admin cannot be demoted: the refusal names what the browser cannot know, at zero sessions', async () => {
    const fakes = makeFakes({ table: SOLE_ADMIN })
    await ready(fakes)
    chooseAction('set-privilege')
    chooseAccount('test15')
    type(/Privilege level/u, '3')
    preview()

    expect((await screen.findByRole('alert')).textContent).toMatch(/is refused here: it is the only privilege-15/u)
    expect(alerts()).toMatch(/the local proxy signs eAPI requests with/u)
    expect(fakes.configSession).not.toHaveBeenCalled()
    expect(fakes.session.run).not.toHaveBeenCalled()
  })

  it('the last admin cannot be deleted either: no session opens, so no `no username` is ever staged', async () => {
    const fakes = makeFakes({ table: SOLE_ADMIN })
    await ready(fakes)
    chooseAction('delete-user')
    chooseAccount('test15')
    preview()

    expect((await screen.findByRole('alert')).textContent).toMatch(/Deleting `test15` is refused here/u)
    expect(fakes.configSession).not.toHaveBeenCalled()
    expect(fakes.session.run).not.toHaveBeenCalled()
  })

  it('the whole-account default of the last admin is refused too: `default username` drops the admin lines', async () => {
    const fakes = makeFakes({ table: SOLE_ADMIN })
    await ready(fakes)
    chooseAction('default-user')
    chooseAccount('test15')
    preview()

    expect((await screen.findByRole('alert')).textContent).toMatch(/is refused here: it is the only privilege-15/u)
    expect(fakes.configSession).not.toHaveBeenCalled()
  })

  it('the built-in admin is refused on the client\u2019s own guard, never on a guess about who is logged in', async () => {
    const fakes = makeFakes()
    await ready(fakes)
    chooseAction('delete-user')
    chooseAccount('admin')
    preview()

    expect((await screen.findByRole('alert')).textContent).toMatch(/refuses to delete the built-in `admin` account/u)
    expect(alerts()).toMatch(/users\.py:230-231/u)
    expect(fakes.configSession).not.toHaveBeenCalled()
  })

  it('a privilege-15 create needs another admin in the read; the refusal says so, and a lower level stages', async () => {
    const fakes = makeFakes({ table: NO_ADMINS })
    await ready(fakes)

    type(/New username/u, 'newadmin')
    type(/Secret \(typed once/u, 'materialtheuihasneverseen')
    type(/Optional privilege for the new account/u, '15')
    preview()
    expect(await screen.findByRole('alert')).toHaveTextContent(/no other privilege-15/u)
    expect(fakes.configSession).not.toHaveBeenCalled()

    type(/Optional privilege for the new account/u, '5')
    preview()
    await staged(fakes)
    expect(fakes.session.run).toHaveBeenLastCalledWith([
      'username newadmin secret sha512 materialtheuihasneverseen',
      'username newadmin privilege 5',
    ])
  })

  it('an admin-affecting write carries named confirmation metadata into the shared transaction', async () => {
    const fakes = makeFakes()
    await ready(fakes)
    chooseAction('delete-user')
    chooseAccount('test15')
    preview()
    await staged(fakes)

    const entry = snapshot().entries[0]
    expect(entry?.risks.join('\n')).toMatch(/This read does show another admin/u)
    expect(entry?.confirmations).toHaveLength(1)
    expect(entry?.confirmations[0]?.title).toBe('Second confirm: test15')
    expect(entry?.confirmations[0]?.label).toBe('I verified another admin: commit for test15')
    expect(entry?.confirmations[0]?.subject).toMatch(/test15/u)
    expect(entry?.confirmations[0]?.body).toMatch(/cannot see which account the local proxy signs eAPI requests with/u)
    expect(fakes.session.commit).not.toHaveBeenCalled()
    expect(fakes.order).toEqual(['run[no username test15]', 'diff'])
  })

  it('an admin role change keeps confirmation metadata and never commits locally', async () => {
    const fakes = makeFakes()
    await ready(fakes)
    chooseAction('set-role')
    chooseAccount('test15')
    type(/^Role token/u, 'network-operator')
    preview()
    await staged(fakes)

    expect(fakes.session.run).toHaveBeenLastCalledWith(['username test15 role network-operator'])
    expect(snapshot().entries[0]?.confirmations[0]?.label).toBe('I verified another admin: commit for test15')
    expect(fakes.session.commit).not.toHaveBeenCalled()
    expect(fakes.session.abort).not.toHaveBeenCalled()
  })

  it('an ordinary delete stages without feature-local cancel, commit, or abort', async () => {
    const fakes = makeFakes()
    await ready(fakes)
    chooseAction('delete-user')
    chooseAccount('eapi')
    preview()
    await staged(fakes)

    expect(fakes.session.run).toHaveBeenLastCalledWith(['no username eapi'])
    expect(fakes.session.commit).not.toHaveBeenCalled()
    expect(fakes.session.abort).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /Commit|Abort|Cancel/u })).not.toBeInTheDocument()
  })

  it('a diff the session has not read back keeps the coordinator commit gate closed', async () => {
    const fakes = makeFakes({ diffRead: false })
    await ready(fakes)
    chooseAction('set-privilege')
    chooseAccount('ops')
    type(/Privilege level/u, '5')
    preview()
    await staged(fakes)

    expect(fakes.session.hasDiffBeenRead).toHaveBeenCalled()
    expect(snapshot().canCommit).toBe(false)
    expect(screen.queryByRole('button', { name: /Commit/u })).not.toBeInTheDocument()
    expect(fakes.session.commit).not.toHaveBeenCalled()
  })
})

describe('Users \u2014 no AAA vocabulary is reachable, and a secret reaches the transport only', () => {
  it('none of the 14 actions this screen offers names aaa, tacacs, radius or authentication', async () => {
    await ready(makeFakes())
    const labels = within(screen.getByLabelText(/^Action$/u)).getAllByRole('option').map((option) => option.textContent ?? '')
    expect(labels).toHaveLength(14)
    expect(labels.filter((label) => /aaa|tacacs|radius|authentication|authorization/iu.test(label))).toEqual([])
  })

  it('every staged batch is scanned: a value that would compose an AAA-shaped line is refused at zero sessions', async () => {
    const fakes = makeFakes()
    await ready(fakes)
    chooseAction('set-role')
    chooseAccount('ops')
    type(/^Role token/u, 'radius')
    preview()

    expect((await screen.findByRole('alert')).textContent).toMatch(/composes local-user commands only/u)
    expect(alerts()).toMatch(/aaa authentication/u)
    expect(fakes.configSession).not.toHaveBeenCalled()
    expect(fakes.session.run).not.toHaveBeenCalled()
  })

  async function secretSplit(encryption: string, marker: string) {
    const typed = 'materialtheuihasneverseen'
    const fakes = makeFakes({ table: NO_ADMINS, diff: `+username svc secret ${marker} ${typed}` })
    const { container } = await ready(fakes)

    type(/New username/u, 'svc')
    type(/Secret encoding to send/u, encryption)
    type(/Secret \(typed once/u, typed)
    preview()
    await staged(fakes)

    expect(fakes.session.run).toHaveBeenLastCalledWith([`username svc secret ${marker} ${typed}`])
    expect(snapshot().entries[0]?.display).toEqual([
      `username svc secret ${marker} [secret redacted by this UI]`,
    ])
    expect(snapshot().diff).toBe(`+username svc secret ${marker} [secret redacted by this UI]`)
    expect(container.textContent).not.toContain(typed)
    expect(screen.getByLabelText(/Secret \(typed once/u)).toHaveAttribute('type', 'password')
    await screen.findByText(/the only place it is displayed after this commit/u)
  }

  it('a sha512 secret reaches the fake transport in full and appears nowhere in the rendered page', async () => {
    await secretSplit('sha512', 'sha512')
  })

  it('a cleartext secret stages the `secret 0 <value>` line and is still never rendered', async () => {
    await secretSplit('cleartext', '0')
  })

  it('a write the device itself rejects arrives as the device\u2019s text, and commit is never reached', async () => {
    const fakes = makeFakes()
    // The client raises CommandError with the failed line; the screen renders that answer verbatim.
    fakes.session.run.mockRejectedValue(new Error("CLI command 3 of 3 'username ops privilege 7' failed: Invalid input (permission denied) at the privilege keyword"))
    await ready(fakes)
    chooseAction('set-privilege')
    chooseAccount('ops')
    type(/Privilege level/u, '7')
    preview()

    expect((await screen.findByRole('alert')).textContent).toMatch(/Invalid input \(permission denied\) at the privilege keyword/u)
    expect(fakes.session.commit).not.toHaveBeenCalled()
    expect(snapshot().status).toBe('uncertain')
    expect(screen.queryByRole('button', { name: /Commit/u })).not.toBeInTheDocument()
  })
})

describe('Users \u2014 in-form refusals cost zero sessions, and one shared transaction owns repeated actions', () => {
  it('a malformed username, privilege, role or key is refused in-form, naming the client rule it mirrors', async () => {
    const fakes = makeFakes()
    await ready(fakes)

    type(/New username/u, 'two words')
    type(/Secret \(typed once/u, 'anything')
    preview()
    expect(await refusalCopy(/A username must be one token/u)).toMatch(/username was refused in-form/u)
    expect(fakes.configSession).not.toHaveBeenCalled()

    chooseAction('set-privilege')
    chooseAccount('ops')
    type(/Privilege level/u, '16')
    preview()
    await refusalCopy(/is outside 0\.\.15/u)
    type(/Privilege level/u, '')
    preview()
    await refusalCopy(/A privilege level needs a value/u)
    type(/Privilege level/u, 'nine')
    preview()
    await refusalCopy(/is not a whole number/u)
    expect(fakes.configSession).not.toHaveBeenCalled()

    chooseAction('set-role')
    chooseAccount('ops')
    type(/^Role token/u, '')
    preview()
    await refusalCopy(/A role needs a value/u)
    type(/^Role token/u, 'two words')
    preview()
    await refusalCopy(/A role must be one token/u)
    expect(fakes.configSession).not.toHaveBeenCalled()

    chooseAction('set-ssh-key')
    chooseAccount('ops')
    type(/Public SSH key/u, '   ')
    preview()
    await refusalCopy(/An SSH key needs a value/u)
    type(/Public SSH key/u, 'ssh-rsa AAAA\nssh-rsa BBBB')
    preview()
    await refusalCopy(/An SSH key is one line/u)
    expect(fakes.configSession).not.toHaveBeenCalled()
  })

  it('an empty secret and an unknown encoding are refused in-form too, pointing at the actions that do exist', async () => {
    const fakes = makeFakes()
    await ready(fakes)

    type(/New username/u, 'svc')
    type(/Secret \(typed once/u, '   ')
    preview()
    expect(await refusalCopy(/An empty secret is refused/u)).toMatch(/secret was refused in-form/u)

    type(/Secret \(typed once/u, 'materialtheuihasneverseen')
    type(/Secret encoding to send/u, 'sha256')
    preview()
    expect(await refusalCopy(/outside the encodings this screen composes/u)).toMatch(/encoding was refused in-form/u)
    expect(fakes.configSession).not.toHaveBeenCalled()
  })

  it('a second action appends to the one shared session without committing locally', async () => {
    const fakes = makeFakes()
    await ready(fakes)
    chooseAction('set-privilege')
    chooseAccount('ops')
    type(/Privilege level/u, '4')
    preview()
    await staged(fakes)

    type(/Privilege level/u, '6')
    preview()
    await staged(fakes, 2)
    expect(fakes.session.run).toHaveBeenLastCalledWith(['username ops privilege 6'])
    expect(fakes.configSession).toHaveBeenCalledTimes(1)
    expect(fakes.session.commit).not.toHaveBeenCalled()
    expect(fakes.session.abort).not.toHaveBeenCalled()
  })
})
