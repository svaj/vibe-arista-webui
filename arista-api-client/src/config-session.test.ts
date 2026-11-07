/**
 * Evidence note: any `*Cli.py:NNN` reference in this file names Arista EOS **image internals**
 * that are not present in this workspace (see `src/config-session.ts` for the full status);
 * they are carried claims to re-capture in M12 (#14), not re-verifiable citations here.
 */
/**
 * Config sessions & change safety — M5 (#7). Offline only: `MockTransport` scripted replies plus the
 * hand-authored `show configuration sessions` sample in `test/fixtures/show/` (DR-034: `npm test` never
 * touches a device, a container or cEOS — which is not installed on this machine).
 *
 * ## Upstream port ledger — the honest version
 *
 * The task brief pointed at session cases in `pyeapi/test/unit/test_client.py`. **There are none**:
 * `grep -in "session|diff|commit|abort" test/unit/test_client.py` over `develop` `6816d9e` matches only
 * prose inside `test_config_with_single_multiline` (`:178`, `:187`), and the brief's
 * `client.py::ConfigSession` at "~1155-1205" does not exist — `client.py` is 1067 lines and ends after
 * `connect_to`. pyeapi's entire session surface is `configure_session`/`diff`/`commit`/`abort`
 * (`client.py:1003-1035`) riding on `_configure_session` (`:676-693`), and upstream exercises none of it.
 *
 * So every case below is **new**, written against the command lists those four methods build, with the
 * divergences recorded in MIGRATION.md §5 rows 61-70. A `[pyeapi …]` tag names the upstream *method*
 * whose command list is being pinned, not an upstream test id.
 *
 * Device behaviour that this suite cannot settle — a second `commit` confirming a `commit timer`, name
 * length limits, description quoting depth, `copy running-config startup-config` on this exact build —
 * stays open in DECISIONS.md (open item 5) and STATUS.md §3. Tests assert what the client *sends* and
 * what it *refuses to send*; they never claim what EOS did with it.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { Node } from './command-layer'
import {
  ConfigSession,
  COPY_RUNNING_TO_STARTUP,
  MAX_SESSION_NAME_LENGTH,
  createWebStorageJournal,
  generateSessionName,
  parseConfigurationSessions,
  type SessionJournalEntry,
  type WebStorageLike,
} from './config-session'
import { CommandError, ConnectError, EapiErrorCode, NotSupportedError, ProtocolError, SessionError } from './errors'
import { mockTransport, type MockTransport } from './testing/mock-transport'
import type { NodeSettings } from './command-layer'
import type { CommandResult, CommandSpec, JsonRpcRequest } from './types/eapi'

const FIXTURE_DIR = fileURLToPath(new URL('../test/fixtures/show', import.meta.url))

interface SessionsReply {
  readonly sessions: Record<string, unknown>
  readonly maxSavedSessions: number
  readonly maxOpenSessions: number
}

function showFixture<T>(name: string): T {
  return JSON.parse(readFileSync(`${FIXTURE_DIR}/${name}`, 'utf8')) as T
}

/** Field names are image-grounded, values are synthetic — see `test/fixtures/show/README.md`. */
const SESSIONS_FIXTURE: SessionsReply = showFixture('show-configuration-sessions--pending-orphans.json')
const SESSION_NAMES: readonly string[] = Object.keys(JSON.parse(JSON.stringify(SESSIONS_FIXTURE)).sessions as Record<string, unknown>).sort()

/** The full wire list of every scripted request in this file starts with `enable` (pyeapi `send_enable` default). */
const ENABLED: CommandResult[] = [{}]

function sessionsReply(excluding: readonly string[] = []): CommandResult[] {
  const clone: SessionsReply = JSON.parse(JSON.stringify(SESSIONS_FIXTURE))
  const kept: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(clone.sessions)) {
    if (!excluding.includes(name)) kept[name] = value
  }
  return [...ENABLED, { ...clone, sessions: kept }]
}

/** Fixed transport address, so generated names and journal endpoints are assertable (M2 keeps credentials out of it by contract). */
const ADDRESS = 'https://sw1.lan:443/command-api'

/** One empty reply per command in the request: "the device ran all of them and said nothing back". */
function ack(count: number): CommandResult[] {
  return Array.from({ length: count }, () => ({}))
}

function scripted(): MockTransport {
  return mockTransport({ address: ADDRESS })
}

/** `createNode()` is still M3's placeholder (DR-038), so the working shape is an explicit Transport. */
function nodeFor(transport: MockTransport, settings: NodeSettings = {}): Node {
  return new Node(transport, settings)
}

/** Matches an exec-mode `configure session <name> abort` request (one command, no re-enter). */
function isAbortOf(name: string): (commands: readonly CommandSpec[]) => boolean {
  return (commands) => commands.length === 2 && String(commands[1]) === `configure session ${name} abort`
}

/** A tiny in-memory `Storage`: the browser journal half of M5 has to be testable in the node environment. */
class MemoryStorage implements WebStorageLike {
  private readonly map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
  /** What a browser would really persist — the place a secret would turn up. */
  raw(key: string): string | null {
    return this.map.get(key) ?? null
  }
  keys(): string[] {
    return [...this.map.keys()]
  }
}

/** Recovered a rejected promise, typed. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => undefined,
    (error: unknown) => error,
  )
}

describe('configSession(): naming and laziness (DR-022, DR-047 — §5 row 61)', () => {
  it('sends no request at all: the device-side session is created by the first batch, as in pyeapi (client.py:1003-1006)', async () => {
    const t = scripted()
    const session = await nodeFor(t).configSession({ name: 'ui-x' })
    expect(t.sent()).toEqual([])
    expect(t.callCount()).toBe(0)
    expect(session.name).toBe('ui-x')
    expect(session.state).toBe('open')
    expect(session.isOpen).toBe(true)
    expect(nodeFor(t).activeConfigSession).toBeUndefined()
  })

  it('defaults the name to ui-<host>-p<pid>-<hex8> instead of pyeapi bare uuid4 (client.py:1006)', async () => {
    const session = await nodeFor(scripted()).configSession()
    expect(session.name).toMatch(/^ui-sw1-lan-p\d+-[0-9a-f]{8}$/u)
    expect(session.name.length).toBeLessThanOrEqual(MAX_SESSION_NAME_LENGTH)
    expect(generateSessionName('unix:/var/run/command-api.sock')).toMatch(/^ui-var-run-command-api-sock-p\d+-[0-9a-f]{8}$/u)
    expect(generateSessionName('mock://device')).toMatch(/^ui-device-p\d+-[0-9a-f]{8}$/u)
    expect(generateSessionName('http://127.0.0.1:5173/command-api')).toMatch(/^ui-127-0-0-1-p\d+-[0-9a-f]{8}$/u)
    // An address with no host at all still gets a name — `device` rather than `ui--p123-abcd1234`, which
    // would put two dashes where the prefix ends and silently stop matching `recoverOrphans()`'s prefix filter.
    expect(generateSessionName('')).toMatch(/^ui-device-p\d+-[0-9a-f]{8}$/u)
    expect(generateSessionName('https://[::1]:443/command-api')).toMatch(/^ui-[a-z0-9_-]+-p\d+-[0-9a-f]{8}$/u)
    for (const endpoint of ['https://sw1.lan:443/command-api', 'https://sw2.lan:443/command-api']) {
      expect(generateSessionName(endpoint)).toMatch(/^ui-sw[12]-lan-p/u)
    }
  })

  it('never leaks credentials or a path into a generated name', () => {
    const name = generateSessionName('https://admin:s3crete@sw1.lan:443/command-api')
    expect(name).not.toMatch(/s3crete|admin/u)
    expect(name).toMatch(/^ui-sw1-lan/u)
  })

  it('refuses unsafe names with zero round trips, because the name is spliced into every batch (EOS matches it with \\S+, SessionCli.py:31)', async () => {
    const t = scripted()
    const node = nodeFor(t)
    for (const bad of ['bad name', 'a"b', "a'b", 'x;abort', 'back\\slash', 'ui-x#comment', 'ui-x\t', 'ui-x\nabort']) {
      expect(await rejection(node.configSession({ name: bad })), bad).toBeInstanceOf(NotSupportedError)
    }
    expect((await rejection(node.configSession({ name: '' })) as Error).message).toMatch(/may not be empty/u)
    expect((await rejection(node.configSession({ name: 'u'.repeat(MAX_SESSION_NAME_LENGTH + 1) })) as Error).message).toMatch(/longer than 64 characters/u)
    expect(t.callCount()).toBe(0)
  })

  it('refuses a description containing a control character before anything is sent', async () => {
    const t = scripted()
    expect(await rejection(nodeFor(t).configSession({ name: 'ui-x', description: 'one\nvlan 20' }))).toBeInstanceOf(NotSupportedError)
    expect(t.callCount()).toBe(0)
  })

  it('description: pyeapi has none; the CLI form is rendered with the quoting rules this port owns (SessionCli.py:269, :218-221)', async () => {
    // The script keys the batch the session actually sends: `configure session <name> description "…"` is
    // cmds[1], never a request of its own, because `abort()` re-attaches with the same opener (`client.py:687`).
    const t = scripted().replies('enable\nconfigure session ui-x description "webui 42f0"\nabort', ack(3))
    const session = await nodeFor(t).configSession({ name: 'ui-x', description: 'webui 42f0' })
    await session.abort()
    expect(t.sent()).toEqual([['enable', 'configure session ui-x description "webui 42f0"', 'abort']])
  })

  it('a quote inside a description is escaped, not terminated', async () => {
    const t = scripted().replies('enable\nconfigure session ui-x description "say \\"hi\\""\nabort', ack(3))
    const session = await nodeFor(t).configSession({ name: 'ui-x', description: 'say "hi"' })
    await session.abort()
    expect(t.sent()[0]).toEqual(['enable', 'configure session ui-x description "say \\"hi\\""', 'abort'])
  })

  it('noCommit: the hidden keyword rides the opener, and commit() is refused locally (§5 row 64, SessionCli.py:295-311)', async () => {
    const t = scripted()
      .replies('enable\nconfigure session ui-x no-commit\nvlan 20', ack(3))
      .replies('enable\nconfigure session ui-x no-commit\nabort', ack(3))
    const node = nodeFor(t)
    const session = await node.configSession({ name: 'ui-x', noCommit: true })
    await session.run(['vlan 20'])
    expect(t.sent()[0]).toEqual(['enable', 'configure session ui-x no-commit', 'vlan 20'])
    expect(await rejection(session.commit())).toBeInstanceOf(SessionError)
    // Both commit attempts are local: no new request went out.
    expect(t.callCount()).toBe(1)
    await session.abort()
    expect(t.sent()[1]).toEqual(['enable', 'configure session ui-x no-commit', 'abort'])
    expect(session.state).toBe('aborted')
  })
})

describe('every session command re-sends the opener (DR-022 — PLAN §M5 box 2)', () => {
  it('sends pyeapi _configure_session command list (client.py:687) and strips both prepended replies (:693)', async () => {
    const t = scripted().replies('enable\nconfigure session ui-x\nvlan 20\nname PROD', [
      { cmd: 'enable' },
      { cmd: 'configure session ui-x' },
      { output: 'A' },
      { output: 'B' },
    ])
    const session = await nodeFor(t).configSession({ name: 'ui-x' })
    const results = await session.run(['vlan 20', 'name PROD'])
    expect(t.sent()).toEqual([['enable', 'configure session ui-x', 'vlan 20', 'name PROD']])
    expect(results).toEqual([{ output: 'A' }, { output: 'B' }])
    expect(session.state).toBe('open')
  })

  it('sendEnable: false works from a session too (DR-009 priv-15 path)', async () => {
    const t = scripted().replies('configure session ui-x\nvlan 20', [{ cmd: 'configure session ui-x' }, { output: 'ok' }])
    const session = await nodeFor(t).configSession({ name: 'ui-x' })
    expect(await session.run(['vlan 20'], { sendEnable: false })).toEqual([{ output: 'ok' }])
    expect(t.sent()).toEqual([['configure session ui-x', 'vlan 20']])
  })

  it('re-attaches by re-sending the same name — and a live handle blocks a second one (DR-025)', async () => {
    const t = scripted()
      .replies('enable\nconfigure session ui-resume\nvlan 30', ack(3))
      .replies('enable\nconfigure session ui-resume\nabort', ack(3))
    const node = nodeFor(t)
    const first = await node.configSession({ name: 'ui-resume' })
    await first.run(['vlan 30'])
    expect(await rejection(node.configSession({ name: 'ui-resume' }))).toBeInstanceOf(SessionError)
    // The crash-recovery shape: a different Node over the same transport says the same first command.
    const revived = await nodeFor(t).configSession({ name: 'ui-resume' })
    await revived.run(['vlan 30'])
    await revived.abort()
    expect(t.sent()).toEqual([
      ['enable', 'configure session ui-resume', 'vlan 30'],
      ['enable', 'configure session ui-resume', 'vlan 30'],
      ['enable', 'configure session ui-resume', 'abort'],
    ])
  })

  it('two sequential handles on one node: the second opener is re-sent after the first ended [pyeapi client.py:687]', async () => {
    const t = scripted()
      .replies('enable\nconfigure session ui-x\nabort', ack(3))
      .replies('enable\nconfigure session ui-x\nvlan 40', ack(3))
    const node = nodeFor(t)
    const first = await node.configSession({ name: 'ui-x' })
    await first.abort()
    const second = await node.configSession({ name: 'ui-x' })
    await second.run(['vlan 40'])
    expect(node.activeConfigSession).toBe(second)
    expect(second.state).toBe('open')
    expect(t.sent()).toEqual([
      ['enable', 'configure session ui-x', 'abort'],
      ['enable', 'configure session ui-x', 'vlan 40'],
    ])
  })

  it('commands() is the alias of run() and takes a single command as well', async () => {
    const t = scripted().replies('enable\nconfigure session ui-x\ninterface Ethernet1', ack(3))
    const session = await nodeFor(t).configSession({ name: 'ui-x' })
    expect(await session.commands('interface Ethernet1')).toEqual([{}])
    expect(t.sent()).toEqual([['enable', 'configure session ui-x', 'interface Ethernet1']])
  })

  it('a successful answer with no result object names the opener instead of assuming the session was entered', async () => {
    const t = scripted().replies('enable\nconfigure session ui-x\nvlan 20', [])
    const session = await nodeFor(t).configSession({ name: 'ui-x' })
    const failure = await rejection(session.run(['vlan 20']))
    expect(failure).toBeInstanceOf(ProtocolError)
    expect((failure as InstanceType<typeof ProtocolError>).message).toMatch(/configure session ui-x/u)
    expect(session.state).toBe('open')
  })
})

describe('diff(): the text-forced read (DR-012 — §5 row 64, PLAN §M5 box 3)', () => {
  it('forces format:text in exactly one round trip, with pyeapi command list (client.py:1013-1014)', async () => {
    const t = scripted().replies('enable\nconfigure session ui-x\nshow session-config diffs', [
      { cmd: 'enable' },
      { cmd: 'configure session ui-x' },
      { output: '+vlan 40\n+   name ORPHANS' },
    ])
    const session = await nodeFor(t).configSession({ name: 'ui-x' })
    expect(await session.diff()).toBe('+vlan 40\n+   name ORPHANS')
    expect(t.callCount()).toBe(1)
    expect(t.bodies()[0]?.params.format).toBe('text')
    expect(t.bodies()[0]?.params.cmds).toEqual(['enable', 'configure session ui-x', 'show session-config diffs'])
    expect(session.state).toBe('diffed')
    expect(session.hasDiffBeenRead()).toBe(true)
  })

  it('the same command asked without the forced encoding is answered 1003, which is what the option prevents (§5 row 64)', async () => {
    // The device reality: `show session-config diffs` declares no cliModel
    // (ConfigSessionShowCli.py:66-81), so a JSON ask for it is a 1003. The mock keys on the command list
    // only, which is exactly the point — the encoding knob is the whole difference, and it is visible in
    // `bodies()` rather than inferable from the commands.
    const t = scripted().rejects('enable\nconfigure session ui-x\nshow session-config diffs', {
      code: EapiErrorCode.COMMAND_UNCONVERTED,
      message: "CLI command 3 of 4 'show session-config diffs' failed: command has not been converted",
      data: [{}, {}, { errors: ['command has not been converted'] }],
    })
    const session = await nodeFor(t).configSession({ name: 'ui-x' })
    const failure = await rejection(session.run(['show session-config diffs']))
    expect(failure).toBeInstanceOf(CommandError)
    expect((failure as InstanceType<typeof CommandError>).code).toBe(1003)
    expect(t.bodies()[0]?.params.format).toBe('json')
    expect(t.callCount()).toBe(1)
  })

  it('showSessionConfig() stays JSON, because that command does declare a model (ConfigSessionShowCli.py:40-62, :57)', async () => {
    const t = scripted().replies('enable\nconfigure session ui-x\nshow session-config', [{}, {}, { output: 'vlan 40\n   name ORPHANS\nend' }])
    const session = await nodeFor(t).configSession({ name: 'ui-x' })
    const reply = await session.showSessionConfig()
    expect(t.bodies()[0]?.params.format).toBe('json')
    expect(t.sent()).toEqual([['enable', 'configure session ui-x', 'show session-config']])
    expect(reply).toEqual({ output: 'vlan 40\n   name ORPHANS\nend' })
    expect(session.state).toBe('diffed')
  })

  it('a text reply with no string output member is a ProtocolError naming the command, never an empty diff', async () => {
    const t = scripted().replies('enable\nconfigure session ui-x\nshow session-config diffs', [{}, {}, { note: 'no output member' }])
    const session = await nodeFor(t).configSession({ name: 'ui-x' })
    const failure = await rejection(session.diff())
    expect(failure).toBeInstanceOf(ProtocolError)
    expect((failure as InstanceType<typeof ProtocolError>).message).toMatch(/show session-config diffs/u)
  })
})

describe('commit / abort / exit, and the transitions nothing survives (DR-025, DR-048 — §5 rows 62-63)', () => {
  it('commit(): re-enter, then in-session commit — pyeapi client.py:1021 command list', async () => {
    const t = scripted().replies('enable\nconfigure session ui-x\ncommit', ack(3))
    const session = await nodeFor(t).configSession({ name: 'ui-x' })
    await session.commit()
    expect(t.sent()).toEqual([['enable', 'configure session ui-x', 'commit']])
    expect(session.state).toBe('committed')
    expect(session.isOpen).toBe(false)
  })

  it('abort(): pyeapi client.py:1026 command list, and unlike upstream the handle ends (§5 row 63)', async () => {
    const t = scripted().replies('enable\nconfigure session ui-x\nabort', ack(3))
    const session = await nodeFor(t).configSession({ name: 'ui-x' })
    await session.abort()
    expect(t.sent()).toEqual([['enable', 'configure session ui-x', 'abort']])
    expect(session.state).toBe('aborted')
    const before = t.callCount()
    // pyeapi would re-send `configure session ui-x` here and recreate a session EOS already destroyed,
    // because abort() leaves _session_name set (client.py:1023-1026). Ours refuses client-side: 0 round trips.
    for (const attempt of [session.abort(), session.run(['vlan 20']), session.diff()]) {
      expect(await rejection(attempt)).toBeInstanceOf(SessionError)
    }
    expect(t.callCount()).toBe(before)
  })

  it('a terminal state explains the way back instead of throwing a bare message', async () => {
    const t = scripted().replies('enable\nconfigure session ui-x\ncommit', ack(3))
    const session = await nodeFor(t).configSession({ name: 'ui-x' })
    await session.commit()
    const message = (await rejection(session.commit())) as Error
    expect(message.message).toMatch(/config session "ui-x" is committed/u)
    expect(message.message).toMatch(/Open a new session with node\.configSession/u)
  })

  it('exit() sends nothing, ends the handle as lost, and leaves the journal record because the device still has the session', async () => {
    const journal = createWebStorageJournal(new MemoryStorage())
    const t = scripted()
    const session = await nodeFor(t).configSession({ name: 'ui-x', journal })
    expect(t.callCount()).toBe(0)
    session.exit()
    expect(session.state).toBe('lost')
    expect(session.isOpen).toBe(false)
    expect(t.callCount()).toBe(0)
    expect((await journal.read()).map((entry) => entry.name)).toEqual(['ui-x'])
    const message = await rejection(session.run(['vlan 20'])) as Error
    expect(message.message).toMatch(/is lost/u)
    expect(message.message).toMatch(/node\.listSessions/u)
    session.exit() // idempotent
    expect(session.state).toBe('lost')
  })

  it('a staged write clears hasDiffBeenRead(), so a Commit button cannot approve a diff that is no longer current', async () => {
    const t = scripted()
      .replies('enable\nconfigure session ui-x\nshow session-config diffs', [{}, {}, { output: '+vlan 40' }])
      .replies('enable\nconfigure session ui-x\nvlan 50', ack(3))
    const session = await nodeFor(t).configSession({ name: 'ui-x' })
    await session.diff()
    expect(session.hasDiffBeenRead()).toBe(true)
    expect(session.state).toBe('diffed')
    await session.run(['vlan 50'])
    expect(session.hasDiffBeenRead()).toBe(false)
    expect(session.state).toBe('open')
  })
})

describe('commit timer / revert (DR-050 — §5 row 67; the device semantics stay an open item)', () => {
  it('sends commit timer hh:mm:ss inside the session, the in-session grammar (SessionCli.py:385-404)', async () => {
    const t = scripted().replies('enable\nconfigure session ui-x\ncommit timer 00:05:00', ack(3))
    const session = await nodeFor(t).configSession({ name: 'ui-x' })
    await session.commitWithRevertTimer('00:05:00')
    expect(t.sent()).toEqual([['enable', 'configure session ui-x', 'commit timer 00:05:00']])
    expect(session.state).toBe('committed')
  })

  it('refuses hh:mm — the spelling the task brief suggested — because the CLI matcher takes three components (DateTimeRule.py:44-47)', async () => {
    const t = scripted()
    const session = await nodeFor(t).configSession({ name: 'ui-x' })
    for (const bad of ['00:05', '5m', '5:00:00:0', 'pt5m']) {
      expect(await rejection(session.commitWithRevertTimer(bad)), bad).toBeInstanceOf(NotSupportedError)
    }
    expect((await rejection(session.commitWithRevertTimer('00:05')) as Error).message).toMatch(/hh:mm:ss/u)
    expect(t.callCount()).toBe(0)
  })

  it('refuses 00:00:00 with the devices own wording (SessionCli.py:92-94) and accepts the 1-2 digit form the matcher allows', async () => {
    const t = scripted().replies('enable\nconfigure session ui-x\ncommit timer 1:5:30', ack(3))
    const session = await nodeFor(t).configSession({ name: 'ui-x' })
    expect((await rejection(session.commitWithRevertTimer('00:00:00')) as Error).message).toMatch(/Time value cannot be zero/u)
    await session.commitWithRevertTimer('1:5:30')
    expect(t.sent()).toEqual([['enable', 'configure session ui-x', 'commit timer 1:5:30']])
    expect(t.callCount()).toBe(1)
  })

  it('confirmRevertTimer() is a second commit on a fresh handle — named as intent, not as verified device behaviour', async () => {
    const t = scripted()
      .replies('enable\nconfigure session ui-x\ncommit timer 01:00:00', ack(3))
      .replies('enable\nconfigure session ui-x\ncommit', ack(3))
    const first = await nodeFor(t).configSession({ name: 'ui-x' })
    await first.commitWithRevertTimer('01:00:00')
    // The handle is terminal after a timed commit, so the confirmation is a NEW handle on the same name —
    // which is also exactly what a page reload does.
    const second = await nodeFor(t).configSession({ name: 'ui-x' })
    await second.confirmRevertTimer()
    expect(t.sent()).toEqual([
      ['enable', 'configure session ui-x', 'commit timer 01:00:00'],
      ['enable', 'configure session ui-x', 'commit'],
    ])
    expect(first.state).toBe('committed')
    expect(second.state).toBe('committed')
  })
})

describe('DR-025: one live session per node, and the verbs it blocks', () => {
  it('configure() is refused while a session is live, with 0 round trips', async () => {
    const t = scripted()
    const node = nodeFor(t)
    await node.configSession({ name: 'ui-x' })
    const failure = await rejection(node.configure(['vlan 20']))
    expect(failure).toBeInstanceOf(SessionError)
    expect((failure as InstanceType<typeof SessionError>).message).toMatch(/while config session "ui-x" is open/u)
    expect((failure as InstanceType<typeof SessionError>).commands).toEqual(['configure terminal'])
    expect(t.callCount()).toBe(0)
  })

  it('pyeapi reroutes the write into the session instead (client.py:635-636); this port refuses until the handle ends', async () => {
    const t = scripted()
      .replies('enable\nconfigure session ui-x\nvlan 20', ack(3))
      .replies('enable\nconfigure terminal\nvlan 20', ack(3))
    const node = nodeFor(t)
    const session = await node.configSession({ name: 'ui-x' })
    await session.run(['vlan 20']) // the honest way to reach the session
    session.exit() // only after the handle ends is terminal mode legal again
    await node.configure(['vlan 20'])
    expect(t.sent()).toEqual([
      ['enable', 'configure session ui-x', 'vlan 20'],
      ['enable', 'configure terminal', 'vlan 20'],
    ])
  })

  it('configureReplace() is refused too, because the command exits sessions it finds (ConfigSessionCli.py:57)', async () => {
    const t = scripted()
    const node = nodeFor(t)
    await node.configSession({ name: 'ui-x' })
    expect(await rejection(node.configureReplace('flash:clean.cfg'))).toBeInstanceOf(SessionError)
    expect(t.callCount()).toBe(0)
  })

  it('exec() keeps refusing every configure … spelling, which is why the session path uses runCommands (§5 row 32 still true)', async () => {
    const t = scripted()
    expect(await rejection(nodeFor(t).exec(['configure session ui-x']))).toBeInstanceOf(NotSupportedError)
    expect(t.callCount()).toBe(0)
  })
})

describe('1006 COMMAND_CONFIG_LOCKED becomes SessionError (DR-023 — §5 row 66)', () => {
  it('carries the offending session, the device code, and the cleanup verbs — and marks the handle lost', async () => {
    const t = scripted().rejects('enable\nconfigure session ui-locked\nvlan 20', {
      code: EapiErrorCode.COMMAND_CONFIG_LOCKED,
      message: "CLI command 2 of 4 'configure session ui-locked' failed: The configuration is locked by session ui-sw1-lan-p1001-aaaa1111",
      data: [{}, { errors: ['The configuration is locked by session ui-sw1-lan-p1001-aaaa1111'] }],
    })
    const session = await nodeFor(t).configSession({ name: 'ui-locked' })
    const failure = await rejection(session.run(['vlan 20']))
    expect(failure).toBeInstanceOf(SessionError)
    const wrapped = failure as InstanceType<typeof SessionError>
    expect(wrapped.message).toContain('config locked for session "ui-locked"')
    expect(wrapped.message).toContain('held by "ui-sw1-lan-p1001-aaaa1111"')
    expect(wrapped.message).toMatch(/recoverOrphans/u)
    expect(wrapped.cause).toBeInstanceOf(CommandError)
    expect((wrapped.cause as InstanceType<typeof CommandError>).code).toBe(1006)
    expect(session.state).toBe('lost')
    expect(t.callCount()).toBe(1)
  })

  it('maps on the code alone when the wording is not one this port has seen (DR-010: code is the contract)', async () => {
    const t = scripted().rejects('enable\nconfigure session ui-locked\ncommit', {
      code: 1006,
      message: 'Configuration is locked, please retry when no other session is active',
      data: [],
    })
    const session = await nodeFor(t).configSession({ name: 'ui-locked' })
    const failure = await rejection(session.commit())
    expect(failure).toBeInstanceOf(SessionError)
    expect((failure as InstanceType<typeof SessionError>).message).toMatch(/config locked for session "ui-locked" — device reply:/u)
    expect(session.state).toBe('lost')
    expect(t.callCount()).toBe(1)
  })

  it('a rejection of a non-opener command leaves the session open, so abort() is still available', async () => {
    const t = scripted()
      .rejects('enable\nconfigure session ui-x\nvlan 4095', {
        code: EapiErrorCode.COMMAND_INVALID,
        message: "CLI command 3 of 4 'vlan 4095' failed: invalid command",
        data: [{}, {}, { errors: ['invalid command'] }],
      })
      .replies('enable\nconfigure session ui-x\nabort', ack(3))
    const session = await nodeFor(t).configSession({ name: 'ui-x' })
    expect(await rejection(session.run(['vlan 4095']))).toBeInstanceOf(CommandError)
    expect(session.state).toBe('open')
    await session.abort()
    expect(session.state).toBe('aborted')
  })

  it('a rejection of the opener itself marks the handle lost (max pending reached, or the name is stale)', async () => {
    const t = scripted().rejects('enable\nconfigure session ui-gone\nvlan 20', {
      code: EapiErrorCode.COMMAND_FAILED,
      message: "CLI command 2 of 4 'configure session ui-gone' failed: Maximum number of pending sessions has been reached. Please commit or abort previous sessions before creating a new one.",
      data: [{}, { errors: ['Maximum number of pending sessions has been reached.'] }],
    })
    const session = await nodeFor(t).configSession({ name: 'ui-gone' })
    expect(await rejection(session.run(['vlan 20']))).toBeInstanceOf(CommandError)
    expect(session.state).toBe('lost')
    // A lost handle cannot be reused; recovery is the only way forward.
    expect(await rejection(session.commit())).toBeInstanceOf(SessionError)
    expect(t.callCount()).toBe(1)
  })

  it('a transport failure changes no state and re-raises the transport error untouched', async () => {
    const t = scripted().connectFailure()
    const session = await nodeFor(t).configSession({ name: 'ui-x' })
    expect(await rejection(session.run(['vlan 20']))).toBeInstanceOf(ConnectError)
    expect(session.state).toBe('open')
  })
})

describe('DR-019 in the session path: a rejected command is never re-sent', () => {
  it('a 1002 rejection is exactly one round trip', async () => {
    const t = scripted().rejects('enable\nconfigure session ui-x\nvlan 4095', {
      code: EapiErrorCode.COMMAND_INVALID,
      message: "CLI command 3 of 4 'vlan 4095' failed: invalid command",
      data: [{}, {}, { errors: ['invalid command'] }],
    })
    const session = await nodeFor(t).configSession({ name: 'ui-x' })
    expect(await rejection(session.run(['vlan 4095']))).toBeInstanceOf(CommandError)
    expect(t.callCount()).toBe(1)
  })

  it('a terminal-mode rejection is also one round trip (control for the rule above)', async () => {
    const t = scripted().rejects('enable\nconfigure terminal\nvlan 4095', {
      code: EapiErrorCode.COMMAND_INVALID,
      message: "CLI command 3 of 4 'vlan 4095' failed: invalid command",
      data: [{}, {}, { errors: ['invalid command'] }],
    })
    expect(await rejection(nodeFor(t).configure(['vlan 4095']))).toBeInstanceOf(CommandError)
    expect(t.callCount()).toBe(1)
  })

  it('the 1003 text repair is off inside a session, even when a caller asks: re-issuing the whole changeset would run it twice', async () => {
    const unconverted = {
      code: EapiErrorCode.COMMAND_UNCONVERTED,
      message: "CLI command 3 of 4 'show session-config all' failed: command has not been converted",
      data: [{}, {}, { errors: ['command has not been converted'] }],
    }
    const t = scripted()
      .rejects('enable\nconfigure session ui-x\nshow session-config all', unconverted)
      .rejects('enable\nconfigure session ui-y\nshow session-config all', unconverted)
    const session = await nodeFor(t).configSession({ name: 'ui-x' })
    expect(await rejection(session.run(['show session-config all']))).toBeInstanceOf(CommandError)
    expect(t.callCount()).toBe(1)
    // Asking for the repair buys nothing here: `send()` forces `tolerateErrors: false` *after* the caller's
    // options, because `sendRequest` repairs a 1003 by re-issuing the same command list
    // (internal/wire.ts:521-566) and inside a session that list is `enable` + the opener + the staged
    // changeset — so a repair would apply every command the device already ran a second time. One request,
    // still `format: 'json'`; the honest text read is `diff()`, which sends one read command.
    const other = await nodeFor(t).configSession({ name: 'ui-y' })
    expect(await rejection(other.run(['show session-config all'], { tolerateErrors: true }))).toBeInstanceOf(CommandError)
    expect(t.callCount()).toBe(2)
    expect(t.sent()[1]).toEqual(['enable', 'configure session ui-y', 'show session-config all'])
    expect(t.bodies().every((body) => body.params.format === 'json')).toBe(true)
  })

  it('readOnly is forced off for a session batch even when a caller asks, so a ConnectError is not retried', async () => {
    const t = scripted().connectFailure()
    const session = await nodeFor(t).configSession({ name: 'ui-x' })
    expect(await rejection(session.run(['vlan 20'], { readOnly: true }))).toBeInstanceOf(ConnectError)
    expect(t.callCount()).toBe(1)
  })

  it('a read outside the session keeps the DR-019 opt-in (the control that proves the forcing above is the difference)', async () => {
    const t = scripted().connectFailure()
    expect(await rejection(nodeFor(t).show('version'))).toBeInstanceOf(ConnectError)
    expect(t.callCount()).toBe(2)
  })
})

describe('listSessions / abortSession / recoverOrphans (DR-023 — §5 rows 66, 70)', () => {
  it('asks for show configuration sessions in JSON and parses the model (ConfigSessionShowCli.py:84-97, ConfigSessionModel.py:15-41)', async () => {
    const t = scripted().replies('enable\nshow configuration sessions', sessionsReply())
    const list = await nodeFor(t).listSessions()
    expect(t.sent()).toEqual([['enable', 'show configuration sessions']])
    expect(t.bodies()[0]?.params.format).toBe('json')
    expect(list.maxOpenSessions).toBe(5)
    expect(list.maxSavedSessions).toBe(10)
    expect(list.sessions.map((session) => session.name)).toEqual([...SESSION_NAMES])
    const armed = list.sessions.find((session) => session.name === 'ui-sw1-lan-p1004-ffff6666')
    expect(armed?.commitBy).toBe(1793671200)
    const completed = list.sessions.find((session) => session.name === '2026-11-01-ui-sw1-lan-p1000-eeee5555')
    expect(completed?.completedTime).toBe(1793577600)
    expect(completed?.commitUser).toBe('ui-ro')
    const ours = list.sessions.find((session) => session.name === 'ui-sw1-lan-p1001-aaaa1111')
    expect(ours?.instances).toEqual([{ pid: 1001, user: 'ui-ro', terminal: 'unknown', currentTerminal: false }])
    expect(ours?.description).toContain('vlan 40')
    expect(list.raw).toMatchObject({ maxOpenSessions: 5 })
  })

  it('detail: true asks for the detail form (SessionCli.py:84-89 of the show plugin)', async () => {
    const t = scripted().replies('enable\nshow configuration sessions detail', sessionsReply())
    await nodeFor(t).listSessions({ detail: true })
    expect(t.sent()).toEqual([['enable', 'show configuration sessions detail']])
  })

  it('a reply without a sessions object is a ProtocolError, never an empty table: "no pending sessions" would be a lie', async () => {
    // One reply per command, as always: `enable` plus `show configuration sessions`. The device answered
    // successfully but with an object that has no `sessions` member at all — the model
    // (ConfigSessionModel.py:36-41) always carries it, so this is a protocol failure, not an empty device.
    const t = scripted().replies('enable\nshow configuration sessions', [{ cmd: 'enable' }, { hostname: 'sw1', maxSavedSessions: 10, maxOpenSessions: 5 }])
    const failure = await rejection(nodeFor(t).listSessions())
    expect(failure).toBeInstanceOf(ProtocolError)
    expect((failure as InstanceType<typeof ProtocolError>).message).toMatch(/no 'sessions' object/u)
  })

  it('a session reported without a state is refused by the parser rather than guessed at', () => {
    expect(() => parseConfigurationSessions({ sessions: { 'ui-x': { description: 'no state member' } } })).toThrow(/no 'state'/u)
    expect(() => parseConfigurationSessions({ sessions: 'not-an-object' })).toThrow(/no 'sessions' object/u)
    expect(() => parseConfigurationSessions({ sessions: { 'ui-x': [] } })).toThrow(/without an object/u)
    // Unknown keys survive in `raw`, so a newer EOS field is not lost.
    const parsed = parseConfigurationSessions({ sessions: { 'ui-x': { state: 'pending', futureField: 7 } }, futureTop: true })
    expect(parsed.sessions[0]).toMatchObject({ name: 'ui-x', state: 'pending' })
    expect((parsed.raw as Record<string, unknown>)['futureTop']).toBe(true)
  })

  it('listSessions refuses the 1003 text fallback, because recovery needs structure (DR-012 boundary)', async () => {
    const t = scripted().rejects('enable\nshow configuration sessions', {
      code: EapiErrorCode.COMMAND_UNCONVERTED,
      message: "CLI command 2 of 2 'show configuration sessions' failed: command has not been converted",
      data: [{}, { errors: ['command has not been converted'] }],
    })
    expect(await rejection(nodeFor(t).listSessions())).toBeInstanceOf(CommandError)
    expect(t.callCount()).toBe(1)
    expect(t.bodies().every((body) => body.params.format === 'json')).toBe(true)
  })

  it('abortSession(name) is one exec-mode command, not a re-enter pair (SessionCli.py:345-372)', async () => {
    const t = scripted().replies(isAbortOf('ui-orphan'), ack(2))
    await nodeFor(t).abortSession('ui-orphan')
    expect(t.sent()).toEqual([['enable', 'configure session ui-orphan abort']])
    expect(t.callCount()).toBe(1)
  })

  it('abortSession() validates the name before sending, like every other spliced token', async () => {
    const t = scripted()
    expect(await rejection(nodeFor(t).abortSession('ui-orphan abort'))).toBeInstanceOf(NotSupportedError)
    expect(t.callCount()).toBe(0)
  })

  it('recoverOrphans() aborts the pending sessions it can identify and leaves everything else alone', async () => {
    const t = scripted()
      .repliesOnce('enable\nshow configuration sessions', sessionsReply())
      .replies(isAbortOf('ui-sw1-lan-p1001-aaaa1111'), ack(2))
      .replies(isAbortOf('ui-sw1-lan-p1002-bbbb2222'), ack(2))
      .replies('enable\nshow configuration sessions', sessionsReply(['ui-sw1-lan-p1001-aaaa1111', 'ui-sw1-lan-p1002-bbbb2222']))
    const outcome = await nodeFor(t).recoverOrphans()
    expect(t.sent()).toEqual([
      ['enable', 'show configuration sessions'],
      ['enable', 'configure session ui-sw1-lan-p1001-aaaa1111 abort'],
      ['enable', 'configure session ui-sw1-lan-p1002-bbbb2222 abort'],
      ['enable', 'show configuration sessions'],
    ])
    expect(outcome.aborted).toEqual(['ui-sw1-lan-p1001-aaaa1111', 'ui-sw1-lan-p1002-bbbb2222'])
    expect(outcome.failed).toEqual([])
    expect(outcome.skipped.map((candidate) => candidate.name)).toEqual([
      '2026-11-01-ui-sw1-lan-p1000-eeee5555',
      'crash-recovery-01',
      'maintenance-window',
      'ui-sw1-lan-p1003-cccc3333',
      'ui-sw1-lan-p1004-ffff6666',
    ])
    expect(outcome.skipped.find((candidate) => candidate.name === 'ui-sw1-lan-p1004-ffff6666')?.reason).toMatch(/commit timer revert is armed until 2026-11-03T02:00:00/u)
    expect(outcome.skipped.find((candidate) => candidate.name === '2026-11-01-ui-sw1-lan-p1000-eeee5555')?.reason).toMatch(/not matched by the "ui-" prefix/u)
    expect(outcome.skipped.find((candidate) => candidate.name === 'ui-sw1-lan-p1003-cccc3333')?.reason).toMatch(/"conflicted"/u)
    // `remaining` is the device's answer, foreign names included: recovery only declines to *act* on them,
    // and the `skipped` reasons are what explain that. A UI clearing a config lock needs the switch's truth,
    // not a list filtered to what this call considers its own sessions (DR-023: the device is authoritative).
    expect(outcome.remaining.map((session) => session.name)).toEqual([
      'crash-recovery-01',
      'maintenance-window',
      'ui-sw1-lan-p1004-ffff6666',
    ])
    expect(outcome.reported).toHaveLength(SESSION_NAMES.length)
    expect(t.callCount()).toBe(4)
  })

  it('a journal widens the candidate set beyond the prefix and forgets the names that were cleaned up', async () => {
    const journal = createWebStorageJournal(new MemoryStorage())
    const day = '2026-11-02T00:00:00.000Z'
    await journal.record({ name: 'crash-recovery-01', endpoint: ADDRESS, startedAt: day })
    await journal.record({ name: 'ui-sw1-lan-p1002-bbbb2222', endpoint: ADDRESS, startedAt: day })
    await journal.record({ name: 'not-reported-by-the-device', endpoint: ADDRESS, startedAt: day })
    const t = scripted()
      .repliesOnce('enable\nshow configuration sessions', sessionsReply())
      .replies(isAbortOf('crash-recovery-01'), ack(2))
      .replies(isAbortOf('ui-sw1-lan-p1001-aaaa1111'), ack(2))
      .replies(isAbortOf('ui-sw1-lan-p1002-bbbb2222'), ack(2))
      .replies('enable\nshow configuration sessions', sessionsReply(['crash-recovery-01', 'ui-sw1-lan-p1001-aaaa1111', 'ui-sw1-lan-p1002-bbbb2222']))
    const outcome = await nodeFor(t).recoverOrphans({ journal })
    expect(outcome.aborted).toEqual(['crash-recovery-01', 'ui-sw1-lan-p1001-aaaa1111', 'ui-sw1-lan-p1002-bbbb2222'])
    // A name the device does not report is never touched, journaled or not: the device is authoritative.
    expect(outcome.reported.map((session) => session.name)).not.toContain('not-reported-by-the-device')
    expect((await journal.read()).map((entry) => entry.name)).toEqual(['not-reported-by-the-device'])
  })

  it('a journaled name the device has already dropped is pruned instead of retried (SessionCli.py:358-360)', async () => {
    const journal = createWebStorageJournal(new MemoryStorage())
    await journal.record({ name: 'ui-vanished', endpoint: ADDRESS, startedAt: '2026-11-02T00:00:00.000Z' })
    const gone = {
      sessions: { 'ui-vanished': { state: 'pending', description: '', instances: {} } },
      maxSavedSessions: 10,
      maxOpenSessions: 5,
    }
    const t = scripted()
      .repliesOnce('enable\nshow configuration sessions', [{}, gone])
      .rejects(isAbortOf('ui-vanished'), {
        code: EapiErrorCode.COMMAND_FAILED,
        message: "CLI command 2 of 2 'configure session ui-vanished abort' failed: Cannot abort non-existent session ui-vanished.",
        data: [{}, { errors: ['Cannot abort non-existent session ui-vanished.'] }],
      })
      .replies('enable\nshow configuration sessions', [{}, gone])
    const outcome = await nodeFor(t).recoverOrphans({ journal })
    expect(outcome.aborted).toEqual([])
    expect(outcome.failed.map((candidate) => candidate.name)).toEqual(['ui-vanished'])
    expect(outcome.failed[0]?.reason).toMatch(/non-existent session/u)
    expect(await journal.read()).toEqual([])
  })

  it('olderThan applies to journaled sessions only, and an un-journaled pending name has no age to compare (ConfigSessionModel.py:21-34)', async () => {
    const journal = createWebStorageJournal(new MemoryStorage())
    await journal.record({ name: 'ui-sw1-lan-p1001-aaaa1111', endpoint: ADDRESS, startedAt: new Date(Date.now() - 72 * 3_600_000).toISOString() })
    await journal.record({ name: 'ui-sw1-lan-p1002-bbbb2222', endpoint: ADDRESS, startedAt: new Date().toISOString() })
    const t = scripted()
      .repliesOnce('enable\nshow configuration sessions', sessionsReply())
      .replies(isAbortOf('ui-sw1-lan-p1001-aaaa1111'), ack(2))
      .replies('enable\nshow configuration sessions', sessionsReply(['ui-sw1-lan-p1001-aaaa1111']))
    const outcome = await nodeFor(t).recoverOrphans({ journal, olderThan: 3_600_000 })
    expect(outcome.aborted).toEqual(['ui-sw1-lan-p1001-aaaa1111'])
    expect(outcome.skipped.find((candidate) => candidate.name === 'ui-sw1-lan-p1002-bbbb2222')?.reason).toMatch(/below the 3600000 ms threshold/u)
    // A journaled endpoint matters: an entry recorded against a different switch is not this recovery's business.
    expect(outcome.skipped.find((candidate) => candidate.name === 'ui-sw1-lan-p1003-cccc3333')?.reason).toMatch(/"conflicted"/u)
  })

  it('olderThan without a journal aborts nothing — there is no age to prove, so nothing is destroyed on a guess', async () => {
    const t = scripted().replies('enable\nshow configuration sessions', sessionsReply())
    const outcome = await nodeFor(t).recoverOrphans({ olderThan: 1 })
    expect(outcome.aborted).toEqual([])
    expect(outcome.skipped.filter((candidate) => candidate.reason.includes('age unknown')).map((candidate) => candidate.name)).toEqual([
      'ui-sw1-lan-p1001-aaaa1111',
      'ui-sw1-lan-p1002-bbbb2222',
    ])
    expect(t.callCount()).toBe(1)
  })

  it('namePrefix: "" considers every pending name, which is what a single-operator lab wants', async () => {
    const t = scripted()
      .repliesOnce('enable\nshow configuration sessions', sessionsReply())
      .replies((commands) => commands.length === 2 && String(commands[1]).endsWith(' abort'), ack(2))
      .replies('enable\nshow configuration sessions', sessionsReply(['crash-recovery-01', 'maintenance-window', 'ui-sw1-lan-p1001-aaaa1111', 'ui-sw1-lan-p1002-bbbb2222']))
    const outcome = await nodeFor(t).recoverOrphans({ namePrefix: '' })
    expect(outcome.aborted).toEqual([
      'crash-recovery-01',
      'maintenance-window',
      'ui-sw1-lan-p1001-aaaa1111',
      'ui-sw1-lan-p1002-bbbb2222',
    ])
  })

  it('recoverOrphans() re-reads only when it changed something, so a clean device costs one round trip', async () => {
    const t = scripted().replies('enable\nshow configuration sessions', [{}, { sessions: {}, maxSavedSessions: 10, maxOpenSessions: 5 }])
    const outcome = await nodeFor(t).recoverOrphans()
    expect(outcome.aborted).toEqual([])
    expect(outcome.remaining).toEqual([])
    expect(outcome.reported).toEqual([])
    expect(t.callCount()).toBe(1)
  })
})

describe('durability and rollback verbs (DR-024 — §5 rows 68, 70)', () => {
  it('copyRunningToStartup() and writeMemory() send the same single command', async () => {
    const t = scripted().replies(`enable\n${COPY_RUNNING_TO_STARTUP}`, ack(2))
    const node = nodeFor(t)
    await node.copyRunningToStartup()
    await node.writeMemory()
    expect(t.sent()).toEqual([
      ['enable', COPY_RUNNING_TO_STARTUP],
      ['enable', COPY_RUNNING_TO_STARTUP],
    ])
    expect(COPY_RUNNING_TO_STARTUP).toBe('copy running-config startup-config')
  })

  it('commit() never saves to startup-config on its own — the data-loss-safe default (DR-024, PLAN §M5 test 5)', async () => {
    const t = scripted()
      .replies('enable\nconfigure session ui-x\nvlan 20', ack(3))
      .replies('enable\nconfigure session ui-x\ncommit', ack(3))
    const node = nodeFor(t)
    const session = await node.configSession({ name: 'ui-x' })
    await session.run(['vlan 20'])
    await session.commit()
    expect(t.callCount()).toBe(2)
    expect(t.sent().flat()).not.toContain(COPY_RUNNING_TO_STARTUP)
  })

  it('commit({persist:true}) adds a separate second round trip, so a failure can name which half happened', async () => {
    const t = scripted()
      .replies('enable\nconfigure session ui-x\ncommit', ack(3))
      .replies(`enable\n${COPY_RUNNING_TO_STARTUP}`, ack(2))
    const session = await nodeFor(t).configSession({ name: 'ui-x' })
    await session.commit({ persist: true })
    expect(t.sent()).toEqual([
      ['enable', 'configure session ui-x', 'commit'],
      ['enable', COPY_RUNNING_TO_STARTUP],
    ])
  })

  it('when the save fails, the message says committed-but-not-saved and the session stays committed', async () => {
    const t = scripted()
      .replies('enable\nconfigure session ui-x\ncommit', ack(3))
      .rejects(`enable\n${COPY_RUNNING_TO_STARTUP}`, { code: 1000, message: 'copy failed: no space left on device', data: [{}] })
    const session = await nodeFor(t).configSession({ name: 'ui-x' })
    const failure = await rejection(session.commit({ persist: true }))
    expect(failure).toBeInstanceOf(SessionError)
    expect((failure as InstanceType<typeof SessionError>).message).toMatch(/committed, but 'copy running-config startup-config' failed/u)
    expect((failure as InstanceType<typeof SessionError>).cause).toBeInstanceOf(CommandError)
    expect(session.state).toBe('committed')
  })

  it('autorefresh governs the config cache after a commit, and a staged write never invalidates it (client.py:668-669, :1028-1035)', async () => {
    for (const autorefresh of [true, false]) {
      const t = scripted()
        .replies('enable\nshow running-config all', [{}, { output: '!\nend' }])
        .replies('enable\nconfigure session ui-x\nvlan 20', ack(3))
        .replies('enable\nconfigure session ui-x\ncommit', ack(3))
      const node = nodeFor(t, { autorefresh })
      await node.getRunningConfig()
      const session = await node.configSession({ name: 'ui-x' })
      await session.run(['vlan 20'])
      // The staged changes are not in running-config yet, so the cached text must still count as valid.
      await node.getRunningConfig()
      const beforeCommit = t.callCount()
      await session.commit()
      await node.getRunningConfig()
      const rereads = t.sent().filter((batch) => batch.includes('show running-config all')).length
      expect(rereads, `autorefresh: ${String(autorefresh)}`).toBe(autorefresh ? 2 : 1)
      expect(t.callCount()).toBe(beforeCommit + 1 + (autorefresh ? 1 : 0))
    }
  })

  it('abort() does not refresh the cached configs either — nothing changed (contrast with commit)', async () => {
    const t = scripted()
      .replies('enable\nshow running-config all', [{}, { output: '!\nend' }])
      .replies('enable\nconfigure session ui-x\nabort', ack(3))
    const node = nodeFor(t)
    await node.getRunningConfig()
    const session = await node.configSession({ name: 'ui-x' })
    await session.abort()
    await node.getRunningConfig()
    expect(t.sent().filter((batch) => batch.includes('show running-config all'))).toHaveLength(1)
  })

  it('configureReplace() renders the device keywords exactly and refuses bad tokens before sending', async () => {
    const t = scripted().replies((commands) => String(commands[1] ?? '').startsWith('configure replace'), ack(2))
    const node = nodeFor(t)
    await node.configureReplace('flash:prod.cfg')
    await node.configureReplace('clean-config', { ignoreErrors: true, skipCheckpoint: true })
    await node.configureReplace('session:/config', { force: true, md5: '0123456789abcdef0123456789abcdef' })
    expect(t.sent()).toEqual([
      ['enable', 'configure replace flash:prod.cfg'],
      ['enable', 'configure replace clean-config ignore-errors skip-checkpoint'],
      ['enable', 'configure replace session:/config force md5 0123456789abcdef0123456789abcdef'],
    ])
    const before = t.callCount()
    expect(await rejection(node.configureReplace('flash:a b.cfg'))).toBeInstanceOf(NotSupportedError)
    expect((await rejection(node.configureReplace('flash:x', { md5: 'nope' }))) as Error).toBeInstanceOf(Error)
    expect((await rejection(node.configureReplace('flash:x', { md5: 'nope' })) as Error).message).toMatch(/\[0-9a-f\]\{32\}/u)
    expect(await rejection(node.configureReplace(''))).toBeInstanceOf(NotSupportedError)
    expect(t.callCount()).toBe(before)
  })

  it('the devices own pending-commit-timer refusal becomes SessionError naming the session (§5 row 69)', async () => {
    const t = scripted().rejects('enable\nconfigure replace flash:prod.cfg', {
      code: EapiErrorCode.COMMAND_FAILED,
      message: "CLI command 2 of 2 'configure replace flash:prod.cfg' failed: Cannot configure replace while session ui-sw1-lan-p1004-ffff6666 is pending commit timer",
      data: [{}, { errors: ['Cannot configure replace while session ui-sw1-lan-p1004-ffff6666 is pending commit timer'] }],
    })
    const failure = await rejection(nodeFor(t).configureReplace('flash:prod.cfg'))
    expect(failure).toBeInstanceOf(SessionError)
    expect((failure as InstanceType<typeof SessionError>).message).toMatch(/is pending commit timer/u)
    expect((failure as InstanceType<typeof SessionError>).cause).toBeInstanceOf(CommandError)
  })

  it('rollbackCleanConfig() stages inside a session and never commits it (§5 row 70)', async () => {
    const t = scripted().replies('enable\nconfigure session ui-rb\nrollback clean-config', ack(3))
    const node = nodeFor(t)
    const session = await node.rollbackCleanConfig({ name: 'ui-rb' })
    expect(t.sent()).toEqual([['enable', 'configure session ui-rb', 'rollback clean-config']])
    expect(session.state).toBe('open')
    expect(t.sent().flat()).not.toContain('commit')
    expect(node.activeConfigSession).toBe(session)
  })

  it('rollbackCleanConfig({groups}) renders the brace form the CLI declares (SessionCli.py:445-451)', async () => {
    const t = scripted().replies('enable\nconfigure session ui-rb\nrollback clean-config { management default }', ack(3))
    await nodeFor(t).rollbackCleanConfig({ name: 'ui-rb', groups: ['management', 'default'] })
    expect(t.sent()).toEqual([['enable', 'configure session ui-rb', 'rollback clean-config { management default }']])
  })

  it('an unsafe group token is refused before any request at all, opener included (§5 row 70 guard)', async () => {
    const t = scripted()
    expect(await rejection(nodeFor(t).rollbackCleanConfig({ name: 'ui-rb', groups: ['bad group'] }))).toBeInstanceOf(NotSupportedError)
    expect(t.callCount()).toBe(0)
    expect(t.sent()).toEqual([])
  })

  it('rollbackToSession(name) is the in-session rollback of a previously committed session (SessionCli.py:43-47)', async () => {
    const t = scripted().replies('enable\nconfigure session ui-rb2\nrollback 2026-11-01-ui-x', ack(3))
    await nodeFor(t).rollbackToSession('2026-11-01-ui-x', { name: 'ui-rb2' })
    expect(t.sent()).toEqual([['enable', 'configure session ui-rb2', 'rollback 2026-11-01-ui-x']])
  })

  it('an abort after a staged rollback discards it, which is the whole point of staging it (DR-024)', async () => {
    const t = scripted()
      .replies('enable\nconfigure session ui-rb\nrollback clean-config', ack(3))
      .replies('enable\nconfigure session ui-rb\ndiff', [{}, {}, { output: '-all\n+nothing' }])
      .replies('enable\nconfigure session ui-rb\nabort', ack(3))
    const node = nodeFor(t)
    const session = await node.rollbackCleanConfig({ name: 'ui-rb' })
    await session.run(['diff'])
    await session.abort()
    expect(session.state).toBe('aborted')
    expect(t.sent()[2]).toEqual(['enable', 'configure session ui-rb', 'abort'])
  })
})

describe('changeset validation mode (PLAN §M5 box 8)', () => {
  it('one batch with stopOnError false and includeErrorDetail true — the pair DR-016 opened on the wire', async () => {
    // One reply per command, whole-batch order: `enable`, the session opener, then the three caller
    // commands. `vlan 20` answers the empty config-mode object, `vlan 4095` is the one the device refused.
    const t = scripted().replies('enable\nconfigure session ui-x\nvlan 20\nname PROD\nvlan 4095', [
      {},
      {},
      {},
      { name: 'PROD' },
      { errors: ['invalid command'] },
    ])
    const session = await nodeFor(t).configSession({ name: 'ui-x' })
    const outcome = await session.validateChanges(['vlan 20', 'name PROD', 'vlan 4095'])
    const request: JsonRpcRequest = t.bodies()[0] as JsonRpcRequest
    expect(request.params).toMatchObject({ stopOnError: false, includeErrorDetail: true })
    expect(t.callCount()).toBe(1)
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.applied).toEqual([{}, { name: 'PROD' }, { errors: ['invalid command'] }])
  })

  it('a rejected changeset comes back as errorDetail rather than a throw, and the session stays abortable', async () => {
    const t = scripted().rejects('enable\nconfigure session ui-x\nvlan 4095', {
      code: EapiErrorCode.COMMAND_INVALID,
      message: "CLI command 3 of 4 'vlan 4095' failed: invalid command",
      data: {
        result: [{}, {}, { errors: ['invalid command'] }],
        errorDetail: [{ index: 2, code: 1002, message: 'invalid command', cmd: 'vlan 4095' }],
      },
    })
    const session = await nodeFor(t).configSession({ name: 'ui-x' })
    const outcome = await session.validateChanges(['vlan 4095'])
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.failures).toEqual([{ index: 2, code: 1002, message: 'invalid command', cmd: 'vlan 4095' }])
      // Whole-batch order, so index 0 is the enable reply and index 1 the session opener (trace() pairs
      // them the same way); `failures` is what a UI should render.
      expect(outcome.staged).toHaveLength(2)
      expect(outcome.error).toBeInstanceOf(CommandError)
      expect(outcome.error.failedCommand).toBe('vlan 4095')
    }
    expect(session.state).toBe('open')
    t.replies('enable\nconfigure session ui-x\nabort', ack(3))
    await session.abort()
    expect(session.state).toBe('aborted')
  })

  it('a changeset offered to a session the device already rejected is an error, not an empty outcome', async () => {
    const t = scripted().rejects('enable\nconfigure session ui-x\nvlan 20', {
      code: EapiErrorCode.COMMAND_INVALID,
      message: "CLI command 2 of 3 'configure session ui-x' failed: invalid command",
      data: [{}, { errors: ['invalid command'] }],
    })
    const session = await nodeFor(t).configSession({ name: 'ui-x' })
    // `configSession()` is lazy (§5 row 61), so the rejection of the *opener* is only observable once a
    // batch has been sent — and that first offer answers as a device failure, not as a `ChangesetOutcome`,
    // because "the session does not exist" is not the same report as "these commands were refused".
    expect(await rejection(session.validateChanges(['vlan 20']))).toBeInstanceOf(CommandError)
    expect(session.state).toBe('lost')
    expect(t.callCount()).toBe(1)
    // The second offer never reaches the wire: a dead handle is a `SessionError` (DR-048), never the
    // `{ ok: false, failures: [], staged: [] }` a UI would render as "nothing to review".
    expect(await rejection(session.validateChanges(['vlan 20']))).toBeInstanceOf(SessionError)
    expect(t.callCount()).toBe(1)
  })
})

describe('the journaled session surface (DR-022 browser half)', () => {
  it('records, replaces and forgets one entry per name, keyed by the caller', async () => {
    const storage = new MemoryStorage()
    const journal = createWebStorageJournal(storage)
    await journal.record({ name: 'ui-a', endpoint: ADDRESS, startedAt: '2026-11-03T00:00:00.000Z' })
    await journal.record({ name: 'ui-a', endpoint: ADDRESS, startedAt: '2026-11-03T00:01:00.000Z', description: 're-recorded' })
    await journal.record({ name: 'ui-b', endpoint: 'https://sw2:443/command-api', startedAt: '2026-11-03T00:02:00.000Z' })
    const entries = await journal.read()
    expect(entries).toHaveLength(2)
    expect(entries.find((entry) => entry.name === 'ui-a')?.startedAt).toBe('2026-11-03T00:01:00.000Z')
    await journal.forget('ui-a')
    expect((await journal.read()).map((entry) => entry.name)).toEqual(['ui-b'])
    expect(storage.keys()).toEqual(['arista-eapi:sessions'])
  })

  it('writes only allow-listed keys, so an enablePassword cannot ride along from a JS caller (DR-011)', async () => {
    const storage = new MemoryStorage()
    const journal = createWebStorageJournal(storage)
    const sneaky = {
      name: 'ui-x',
      endpoint: ADDRESS,
      startedAt: '2026-11-03T00:00:00.000Z',
      enablePassword: 'hunter2',
      password: 'hunter2',
    } as unknown as SessionJournalEntry
    await journal.record(sneaky)
    expect(storage.raw('arista-eapi:sessions')).not.toMatch(/hunter2|enablePassword/u)
    expect(await journal.read()).toEqual([{ name: 'ui-x', endpoint: ADDRESS, startedAt: '2026-11-03T00:00:00.000Z' }])
  })

  it('a corrupted record reads as empty instead of breaking the recovery path', async () => {
    const storage = new MemoryStorage()
    storage.setItem('arista-eapi:sessions', '{ not json')
    expect(await createWebStorageJournal(storage).read()).toEqual([])
    storage.setItem('arista-eapi:sessions', '{"not":"an array"}')
    expect(await createWebStorageJournal(storage).read()).toEqual([])
  })

  it('a journal passed to configSession() records the name, drops it on commit, and keeps it on exit', async () => {
    const journal = createWebStorageJournal(new MemoryStorage())
    const t = scripted().replies('enable\nconfigure session ui-j\ncommit', ack(3))
    const node = nodeFor(t)
    const committed = await node.configSession({ name: 'ui-j', journal })
    expect((await journal.read()).map((entry) => entry.name)).toEqual(['ui-j'])
    await committed.commit()
    expect(await journal.read()).toEqual([])
    const detached = await node.configSession({ name: 'ui-k', journal })
    detached.exit()
    expect((await journal.read()).map((entry) => entry.name)).toEqual(['ui-k'])
  })

  it('the journal entry never contains the enable password, even when the Node has one', async () => {
    const storage = new MemoryStorage()
    const journal = createWebStorageJournal(storage)
    const node = nodeFor(scripted(), { enablePassword: 'sup3rsecret' })
    await node.configSession({ name: 'ui-secrettest', journal, description: 'rotating the enable password' })
    expect(storage.raw('arista-eapi:sessions')).not.toMatch(/sup3rsecret/u)
    expect((await journal.read())[0]?.description).toBe('rotating the enable password')
  })
})

describe('ConfigSession over a structural host (no Node involved — the seam ARCHITECTURE §1 asks for)', () => {
  it('drives any SessionCommandTarget, so M7 resources can stage into a session without holding a Node', async () => {
    const sent: (readonly CommandSpec[])[] = []
    let refreshes = 0
    const host = {
      async runCommands(commands: readonly CommandSpec[]): Promise<CommandResult[]> {
        sent.push(commands)
        return commands.map(() => ({}))
      },
      refresh(): void {
        refreshes += 1
      },
      autorefresh: true,
      connection: { address: 'https://sw9:443/command-api' },
    }
    const session = new ConfigSession(host, { name: 'ui-standalone' })
    await session.run(['vlan 77'], { sendEnable: false })
    await session.commit()
    expect(sent).toEqual([
      ['configure session ui-standalone', 'vlan 77'],
      ['configure session ui-standalone', 'commit'],
    ])
    expect(refreshes).toBe(1)
    expect(session.name).toBe('ui-standalone')
  })

  it('a generated default name is endpoint-scoped, so two switches cannot collide', () => {
    expect(generateSessionName('https://sw-one/command-api').startsWith('ui-sw-one-')).toBe(true)
    expect(generateSessionName('https://sw-two/command-api').startsWith('ui-sw-two-')).toBe(true)
  })
})
