/**
 * The Node-entry config-session journal — M5 (#7), DR-022/DR-023's recovery record.
 *
 * Every case runs against a `mkdtemp` directory: this suite must never read or write a real home
 * directory, and `sessionJournalPath()` takes injectable env/home inputs precisely so the documented
 * default path is assertable without touching it. Offline by construction (DR-034).
 *
 * The security half matters as much as the round trip: a recovery journal sits in a home directory that
 * is often synced or backed up, so DR-011's "never persist a secret" rule is asserted both structurally
 * (allow-listed keys) and behaviourally (a password handed in from JS never reaches the bytes).
 */

import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Node } from './command-layer'
import {
  FileSessionJournal,
  SESSION_JOURNAL_DIR_NAME,
  SESSION_JOURNAL_FILE_NAME,
  SESSION_JOURNAL_PATH,
  defaultSessionJournal,
  sessionJournalPath,
} from './node-session-journal'
import { mockTransport } from './testing/mock-transport'
import type { CommandResult } from './types/eapi'

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'arista-eapi-journal-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function ack(count: number): CommandResult[] {
  return Array.from({ length: count }, () => ({}))
}

describe('the documented path (PLAN §M5, DR-047)', () => {
  it('is $HOME/.config/arista-eapi/sessions.json with no XDG_CONFIG_HOME', () => {
    expect(sessionJournalPath({ env: {}, homeDir: '/home/tester' })).toBe(
      join('/home/tester', '.config', SESSION_JOURNAL_DIR_NAME, SESSION_JOURNAL_FILE_NAME),
    )
  })

  it('honours XDG_CONFIG_HOME, and treats an empty value as unset (the XDG base spec wording)', () => {
    expect(sessionJournalPath({ env: { XDG_CONFIG_HOME: '/xdg' }, homeDir: '/home/tester' })).toBe(
      join('/xdg', SESSION_JOURNAL_DIR_NAME, SESSION_JOURNAL_FILE_NAME),
    )
    expect(sessionJournalPath({ env: { XDG_CONFIG_HOME: '' }, homeDir: '/home/tester' })).toContain('/home/tester/.config/')
  })

  it('the module constant agrees with the function under the real environment', () => {
    expect(SESSION_JOURNAL_PATH).toBe(sessionJournalPath())
    expect(SESSION_JOURNAL_PATH).toMatch(new RegExp(`arista-eapi[\\\\/]${SESSION_JOURNAL_FILE_NAME}$`))
    expect(SESSION_JOURNAL_DIR_NAME).toBe('arista-eapi')
    expect(SESSION_JOURNAL_FILE_NAME).toBe('sessions.json')
  })

  it('defaultSessionJournal() points at it, and an explicit path wins', () => {
    expect(defaultSessionJournal().path).toBe(SESSION_JOURNAL_PATH)
    expect(new FileSessionJournal(join(dir, 'x.json')).path).toBe(join(dir, 'x.json'))
    expect(String(new FileSessionJournal('/tmp/j.json'))).toBe('FileSessionJournal(/tmp/j.json)')
  })
})

describe('read/write round trip', () => {
  it('records an entry, creates the parent directory, and reads it back', async () => {
    const path = join(dir, 'nested', 'deeper', SESSION_JOURNAL_FILE_NAME)
    const journal = new FileSessionJournal(path)
    expect(await journal.read()).toEqual([])
    await journal.record({ name: 'ui-sw1-p1-abcd1234', endpoint: 'https://sw1:443/command-api', startedAt: '2026-11-03T09:00:00.000Z', pid: 4242, description: 'vlan 40 change' })
    const text = await readFile(path, 'utf8')
    expect(text).toContain('ui-sw1-p1-abcd1234')
    expect(await journal.read()).toEqual([
      { name: 'ui-sw1-p1-abcd1234', endpoint: 'https://sw1:443/command-api', startedAt: '2026-11-03T09:00:00.000Z', pid: 4242, description: 'vlan 40 change' },
    ])
  })

  it('replaces an entry with the same name and keeps the others', async () => {
    const journal = new FileSessionJournal(join(dir, SESSION_JOURNAL_FILE_NAME))
    await journal.record({ name: 'ui-a', endpoint: 'e', startedAt: '2026-11-03T00:00:00.000Z' })
    await journal.record({ name: 'ui-b', endpoint: 'e', startedAt: '2026-11-03T00:01:00.000Z' })
    await journal.record({ name: 'ui-a', endpoint: 'e', startedAt: '2026-11-03T00:02:00.000Z', description: 're-recorded' })
    const entries = await journal.read()
    expect(entries.map((entry) => entry.name)).toEqual(['ui-b', 'ui-a'])
    expect(entries.find((entry) => entry.name === 'ui-a')?.startedAt).toBe('2026-11-03T00:02:00.000Z')
  })

  it('forgets a name, and forgetting an unknown name changes nothing', async () => {
    const path = join(dir, SESSION_JOURNAL_FILE_NAME)
    const journal = new FileSessionJournal(path)
    await journal.record({ name: 'ui-a', endpoint: 'e', startedAt: '2026-11-03T00:00:00.000Z' })
    await journal.forget('ui-nope')
    expect((await journal.read()).map((entry) => entry.name)).toEqual(['ui-a'])
    await journal.forget('ui-a')
    expect(await journal.read()).toEqual([])
    await journal.forget('ui-a') // idempotent on an empty file
    expect(await journal.read()).toEqual([])
  })

  it('prunes by endpoint, which is how a removed profile stops leaving records behind', async () => {
    const journal = new FileSessionJournal(join(dir, SESSION_JOURNAL_FILE_NAME))
    await journal.record({ name: 'ui-a', endpoint: 'https://sw1:443/command-api', startedAt: '2026-11-03T00:00:00.000Z' })
    await journal.record({ name: 'ui-b', endpoint: 'https://sw2:443/command-api', startedAt: '2026-11-03T00:00:00.000Z' })
    expect(await journal.prune('https://sw1:443/command-api')).toBe(1)
    expect((await journal.read()).map((entry) => entry.name)).toEqual(['ui-b'])
  })

  it('never leaves a partial file: the write goes through a temp file plus a rename', async () => {
    const path = join(dir, SESSION_JOURNAL_FILE_NAME)
    const journal = new FileSessionJournal(path)
    await journal.record({ name: 'ui-a', endpoint: 'e', startedAt: '2026-11-03T00:00:00.000Z' })
    // No `.tmp` sibling survives a completed write, so a crash mid-write can only leave the old file.
    expect(await readdir(dir)).toEqual([SESSION_JOURNAL_FILE_NAME])
  })
})

describe('broken input is handled without blocking recovery', () => {
  it('a missing file reads as empty', async () => {
    expect(await new FileSessionJournal(join(dir, 'nope', SESSION_JOURNAL_FILE_NAME)).read()).toEqual([])
  })

  it('an empty or whitespace file reads as empty', async () => {
    const path = join(dir, SESSION_JOURNAL_FILE_NAME)
    await writeFile(path, '   \n', 'utf8')
    expect(await new FileSessionJournal(path).read()).toEqual([])
  })

  it('corrupt JSON reads as empty rather than throwing from a cleanup path', async () => {
    const path = join(dir, SESSION_JOURNAL_FILE_NAME)
    await writeFile(path, '[ {"name": "ui-a", ', 'utf8')
    expect(await new FileSessionJournal(path).read()).toEqual([])
  })

  it('an entry missing a required field is dropped, and a non-array document is empty', async () => {
    const path = join(dir, SESSION_JOURNAL_FILE_NAME)
    await writeFile(path, JSON.stringify([{ name: 'ui-a' }, { name: 'ui-b', endpoint: 'e', startedAt: 'x' }]), 'utf8')
    expect(await new FileSessionJournal(path).read()).toEqual([{ name: 'ui-b', endpoint: 'e', startedAt: 'x' }])
    await writeFile(path, JSON.stringify({ name: 'ui-a' }), 'utf8')
    expect(await new FileSessionJournal(path).read()).toEqual([])
  })

  it('a path that is a directory surfaces the read error instead of pretending the journal is empty', async () => {
    const path = join(dir, 'subdir', SESSION_JOURNAL_FILE_NAME)
    await mkdir(path, { recursive: true })
    await expect(new FileSessionJournal(join(dir, 'subdir')).read()).rejects.toBeDefined()
  })
})

describe('DR-011: a journal file must never hold a secret', () => {
  for (const secretKey of ['password', 'enablePassword', 'enable_password', 'enablepwd', 'secret', 'passkey', 'token', 'cookie']) {
    it(`refuses to write an entry carrying ${secretKey}`, async () => {
      const journal = new FileSessionJournal(join(dir, SESSION_JOURNAL_FILE_NAME))
      const sneaky = { name: 'ui-x', endpoint: 'e', startedAt: '2026-11-03T00:00:00.000Z', [secretKey]: 'hunter2' } as never
      await expect(journal.record(sneaky)).rejects.toBeInstanceOf(TypeError)
      await expect(journal.record(sneaky)).rejects.toThrow(/must never contain a password/u)
    })
  }

  it('drops fields that are not on the allow-list instead of storing them', async () => {
    const journal = new FileSessionJournal(join(dir, SESSION_JOURNAL_FILE_NAME))
    await journal.record({
      name: 'ui-x',
      endpoint: 'e',
      startedAt: '2026-11-03T00:00:00.000Z',
      extra: 'not a journal field',
      note: 'neither is this',
    } as never)
    expect(await journal.read()).toEqual([{ name: 'ui-x', endpoint: 'e', startedAt: '2026-11-03T00:00:00.000Z' }])
  })

  it('an entry with no name or no startedAt is refused outright', async () => {
    const journal = new FileSessionJournal(join(dir, SESSION_JOURNAL_FILE_NAME))
    await expect(journal.record({ endpoint: 'e', startedAt: 'x' } as never)).rejects.toThrow(/non-empty string `name`/u)
    await expect(journal.record({ name: 'ui-x', startedAt: 'x' } as never)).rejects.toThrow(/string `endpoint`/u)
    await expect(journal.record({ name: 'ui-x', endpoint: 'e' } as never)).rejects.toThrow(/string `startedAt`/u)
  })

  it('the file mode keeps the inventory private (0600 file in a 0700 directory)', async () => {
    const path = join(dir, 'private', SESSION_JOURNAL_FILE_NAME)
    const journal = new FileSessionJournal(path)
    await journal.record({ name: 'ui-x', endpoint: 'https://sw1:443/command-api', startedAt: '2026-11-03T00:00:00.000Z' })
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('end to end: a Node that holds an enable password writes a journal file that does not', async () => {
    const transport = mockTransport({ address: 'https://sw1:443/command-api' }).replies('enable\nconfigure session ui-x\ncommit', ack(3))
    const journal = new FileSessionJournal(join(dir, SESSION_JOURNAL_FILE_NAME))
    const node = new Node(transport, { enablePassword: 'sup3rsecret' })
    const session = await node.configSession({ name: 'ui-x', journal, description: 'rotate the switch password' })
    const text = await readFile(join(dir, SESSION_JOURNAL_FILE_NAME), 'utf8')
    expect(text).not.toMatch(/sup3rsecret/u)
    expect(text).toMatch(/rotate the switch password/u)
    expect(text).not.toMatch(/"password"|enablePassword/u)
    await session.commit()
    expect(await journal.read()).toEqual([])
  })
})

describe('the journal plugs into the session lifecycle from the Node entry (DR-022)', () => {
  it('configSession() records, commit() forgets, and a closed handle keeps the record so recovery can find it', async () => {
    const journal = new FileSessionJournal(join(dir, SESSION_JOURNAL_FILE_NAME))
    const transport = mockTransport({ address: 'https://sw1:443/command-api' })
      .replies('enable\nconfigure session ui-j1\ncommit', ack(3))
      .replies('enable\nconfigure session ui-j2\nvlan 20', ack(3))
    const node = new Node(transport)
    const first = await node.configSession({ name: 'ui-j1', journal })
    expect((await journal.read()).map((entry) => entry.name)).toEqual(['ui-j1'])
    await first.commit()
    expect(await journal.read()).toEqual([])

    const second = await node.configSession({ name: 'ui-j2', journal })
    await second.run(['vlan 20'])
    second.exit()
    const kept = await journal.read()
    expect(kept.map((entry) => entry.name)).toEqual(['ui-j2'])
    expect(kept[0]?.endpoint).toBe('https://sw1:443/command-api')
    expect(kept[0]?.pid).toBe(process.pid)
    expect(kept[0]?.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u)
  })

  it('two journal instances over the same file see each others entries (the crash-recovery case)', async () => {
    const path = join(dir, SESSION_JOURNAL_FILE_NAME)
    const writer = new FileSessionJournal(path)
    await writer.record({ name: 'ui-old-process', endpoint: 'https://sw1:443/command-api', startedAt: '2026-11-01T00:00:00.000Z' })
    const reader = new FileSessionJournal(path)
    expect((await reader.read()).map((entry) => entry.name)).toEqual(['ui-old-process'])
  })
})
