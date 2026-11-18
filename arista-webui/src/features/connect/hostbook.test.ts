// The hostbook (#140a): name/host/username storage whose contract is "a password CANNOT live
// here" — enforced by field projection on both read and write, not by convention. Storage is the
// injected Map, so the pins below are about shape and hygiene, not jsdom behavior.
import { describe, expect, it } from 'vitest'

import {
  HOSTBOOK_KEY,
  forgetHostbookEntry,
  loadHostbook,
  upsertHostbookEntry,
} from './hostbook'
import type { HostbookStorage } from './hostbook'

function memoryStorage(initial: Record<string, string> = {}): HostbookStorage & { dump(): Record<string, string> } {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value) },
    removeItem: (key) => { map.delete(key) },
    dump: () => Object.fromEntries(map),
  }
}

describe('loadHostbook (#140a)', () => {
  it('answers empty for absent, corrupt, and non-array payloads — never throws', () => {
    expect(loadHostbook(memoryStorage())).toEqual([])
    expect(loadHostbook(memoryStorage({ [HOSTBOOK_KEY]: 'not json' }))).toEqual([])
    expect(loadHostbook(memoryStorage({ [HOSTBOOK_KEY]: '{"host":"x"}' }))).toEqual([])
  })

  it('drops malformed entries but keeps valid ones, newest first', () => {
    const raw = JSON.stringify([
      { name: 'Old', host: 'old.lan', username: 'u', addedAt: 100 },
      { name: 'Broken', host: '', username: 'u', addedAt: 200 },
      null,
      [1, 2],
      'string',
      { name: 'New', host: 'new.lan', username: 'u', addedAt: 300 },
      { host: 'no-fields.lan' },
    ])
    const entries = loadHostbook(memoryStorage({ [HOSTBOOK_KEY]: raw }))
    expect(entries.map((entry) => entry.name)).toEqual(['New', 'Old'])
  })

  it('strips keys outside the whitelist — including a hand-injected password', () => {
    const raw = JSON.stringify([{ name: 'Evil', host: 'a.lan', username: 'u', addedAt: 5, password: 'never-sent' }])
    const entry = loadHostbook(memoryStorage({ [HOSTBOOK_KEY]: raw }))[0]
    expect(entry).toEqual({ name: 'Evil', host: 'a.lan', username: 'u', addedAt: 5 })
    expect(Object.keys(entry as object)).not.toContain('password')
  })
})

describe('upsertHostbookEntry (#140a)', () => {
  const storage = () => memoryStorage()

  it('labels with the given name, or the host when the name is blank', () => {
    const entries = upsertHostbookEntry(storage(), { host: 'https://a.lan', username: 'admin', name: '  Office ' }, 999)
    expect(entries).toEqual([{ name: 'Office', host: 'https://a.lan', username: 'admin', addedAt: 999 }])
    const anon = upsertHostbookEntry(storage(), { host: 'https://b.lan', username: 'admin' }, 1)
    expect(anon[0]?.name).toBe('https://b.lan')
  })

  it('upserts by host+username: same pair refreshes position, different user is its own row', () => {
    const storageRef = storage()
    upsertHostbookEntry(storageRef, { host: 'a.lan', username: 'u1', name: 'First' }, 10)
    const withSecond = upsertHostbookEntry(storageRef, { host: 'b.lan', username: 'u1', name: 'Second' }, 20)
    expect(withSecond.map((entry) => entry.host)).toEqual(['b.lan', 'a.lan'])
    const renamed = upsertHostbookEntry(storageRef, { host: 'a.lan', username: 'u1', name: 'Renamed' }, 30)
    expect(renamed.map((entry) => entry.host)).toEqual(['a.lan', 'b.lan'])
    expect(renamed[0]).toMatchObject({ name: 'Renamed', addedAt: 30 })
    const otherUser = upsertHostbookEntry(storageRef, { host: 'a.lan', username: 'u2' }, 40)
    expect(otherUser).toHaveLength(3)
  })

  it('caps the list at twelve and NEVER writes a password, even one smuggled into storage', () => {
    const storageRef = storage()
    for (let i = 0; i < 13; i += 1) upsertHostbookEntry(storageRef, { host: `h${String(i)}.lan`, username: 'u' }, i)
    expect(loadHostbook(storageRef).length, 'a rebuilt 13th upsert still lists at most 12').toBeLessThanOrEqual(12)

    // Seed a hand-tampered blob whose one row carries an extra `password` key; any later write
    // re-projects every row — the smuggled field cannot survive it.
    storageRef.setItem(HOSTBOOK_KEY, JSON.stringify([
      { name: 'A', host: 'a.lan', username: 'u', addedAt: 1, password: 'never-sent' },
    ]))
    upsertHostbookEntry(storageRef, { host: 'b.lan', username: 'u' }, 2)
    expect(storageRef.dump()[HOSTBOOK_KEY]).toBeDefined()
    expect(storageRef.dump()[HOSTBOOK_KEY]).not.toContain('never-sent')
  })
})

describe('forgetHostbookEntry (#140a)', () => {
  it('removes exactly one host+username row and clears the key when emptied', () => {
    const storageRef = memoryStorage()
    upsertHostbookEntry(storageRef, { host: 'a.lan', username: 'u1' }, 1)
    upsertHostbookEntry(storageRef, { host: 'a.lan', username: 'u2' }, 2)
    const after = forgetHostbookEntry(storageRef, 'a.lan', 'u1')
    expect(after.map((entry) => entry.username)).toEqual(['u2'])
    forgetHostbookEntry(storageRef, 'a.lan', 'u2')
    expect(storageRef.dump()[HOSTBOOK_KEY], 'emptied book removes the key').toBeUndefined()
  })
})
