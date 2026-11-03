/**
 * The `eapi.conf` **search** — M3 (#5), runtime-agnostic half of DR-038/DR-044.
 *
 * `resolveEapiConf` owns where a config comes from: `$EAPI_CONF` > explicit `filename` > the caller's
 * `paths` > pyeapi's `CONFIG_SEARCH_PATH` (`client.py:158-184`, `:112`), with `~` expanded
 * (`client.py:179`) and the first usable candidate winning. The file *format* is `parseEapiConf`
 * (covered by `src/profiles.test.ts`); the real `node:fs` binding is `src/node-profiles.ts`
 * (covered by `src/node-profiles.test.ts`). Everything here runs against the
 * `src/testing/fake-conf-fs.ts` seam — offline, no home directory, no device (DR-034).
 *
 * The divergences asserted here are MIGRATION.md §5 row 47's: pyeapi accepts a candidate as soon as
 * `os.path.exists` says so — true for directories — and then loses configparser's unread error,
 * ending with a config that was never read. This layer reports and continues.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CONFIG_SEARCH_PATH,
  EAPI_CONF_ENV_VAR,
  eapiConfSearchPath,
  expandHome,
  resolveEapiConf,
  type LoadedEapiConf,
} from './eapi-conf'
import { clearWarningRegistry, hasWarned } from './warn'
import { confFixture, confFixtureDirectory, confFixturePath, fakeConfFileSystem } from '../testing/fake-conf-fs'
import { ProfileStore } from '../profiles'

/** In-memory directory under its seam name, so the specs read as searches rather than fs fixtures. */
const fakeFs = fakeConfFileSystem

const LAB = `[connection:switch]
host: 10.0.0.7
username: ui-ro
password: search-probe-secret
`

describe('expandHome', () => {
  it('expands ~ the way os.path.expanduser does, and leaves everything else alone', () => {
    expect(expandHome('~', '/home/op')).toBe('/home/op')
    expect(expandHome('~/.eapi.conf', '/home/op')).toBe('/home/op/.eapi.conf')
    expect(expandHome('~/.eapi.conf', '/home/op/')).toBe('/home/op/.eapi.conf') // trailing-slash home
    expect(expandHome('~/.eapi.conf', undefined)).toBe('~/.eapi.conf') // no home: the candidate cannot resolve
    expect(expandHome('~other/x', '/home/op')).toBe('~other/x') // per-user homes are not a thing here
    expect(expandHome('/mnt/flash/eapi.conf', '/home/op')).toBe('/mnt/flash/eapi.conf')
  })
})

describe('eapiConfSearchPath — autoload precedence (client.py:158-184)', () => {
  it('names the variable and keeps the upstream order', () => {
    expect(EAPI_CONF_ENV_VAR).toBe('EAPI_CONF')
    expect(CONFIG_SEARCH_PATH).toEqual(['~/.eapi.conf', '/mnt/flash/eapi.conf']) // client.py:112
  })

  it('puts $EAPI_CONF above an explicit filename and above the paths list', () => {
    // Verified against upstream behaviour, not assumption: pyeapi's
    // `test_load_config_for_connection_with_env` still reads the env file after `load_config(random)`,
    // because `autoload` checks `os.environ['EAPI_CONF']` **first** (`client.py:171-174`).
    const fromEnv = eapiConfSearchPath({
      env: { EAPI_CONF: ' /env/eapi.conf ' },
      filename: '/given.conf',
      paths: ['/paths.conf'],
    })
    expect(fromEnv).toEqual(['/env/eapi.conf']) // trimmed, single candidate
  })

  it('falls through blank env/filename to the paths, and to the search path', () => {
    expect(eapiConfSearchPath({ env: { EAPI_CONF: '   ' }, filename: '/given.conf' })).toEqual(['/given.conf'])
    expect(eapiConfSearchPath({ env: {}, filename: '  ', paths: ['/p.conf'] })).toEqual(['/p.conf'])
    expect(eapiConfSearchPath()).toEqual(CONFIG_SEARCH_PATH)
  })
})

describe('resolveEapiConf', () => {
  beforeEach(() => {
    clearWarningRegistry()
  })

  it('reads the first existing candidate and records every one it looked at', () => {
    const fs = fakeFs({ '/b/eapi.conf': LAB })
    const loaded = resolveEapiConf({ fs, env: {}, paths: ['/missing/eapi.conf', '/b/eapi.conf', '/never/eapi.conf'] })
    expect(loaded.filename).toBe('/b/eapi.conf')
    expect(loaded.searched.map((entry) => [entry.path, entry.skipped])).toEqual([
      ['/missing/eapi.conf', 'not present'],
      ['/b/eapi.conf', undefined],
    ])
    expect(fs.reads).toEqual(['/b/eapi.conf']) // the search stops at the winner (client.py:178-183)
    expect(loaded.store.names()).toEqual(['switch'])
    expect(loaded.profiles.map((profile) => profile.name)).toEqual(['switch'])
    expect(loaded.issues).toEqual([])
  })

  it('lets $EAPI_CONF override everything, trimmed, through an injected fs', () => {
    const fs = fakeFs({ '/env/eapi.conf': LAB, '/fallback/eapi.conf': '[connection:never]\nhost: x\n' })
    const loaded = resolveEapiConf({ fs, env: { EAPI_CONF: '  /env/eapi.conf  ' }, paths: ['/fallback/eapi.conf'] })
    expect(loaded.filename).toBe('/env/eapi.conf')
    expect(loaded.store.names()).toEqual(['switch'])
  })

  it('expands ~ from the fs seam, not from the process (a browser bundle has no home directory)', () => {
    const fs = fakeFs({ '/home/op/.eapi.conf': LAB }, { homeDirectory: '/home/op' })
    const loaded = resolveEapiConf({ fs, env: {}, paths: ['~/.eapi.conf'] })
    expect(loaded.filename).toBe('/home/op/.eapi.conf')
  })

  it('skips ~ candidates with no home to expand into and never asks the fs about them', () => {
    const fs = fakeFs({})
    const loaded = resolveEapiConf({ fs, env: {}, paths: ['~/.eapi.conf', '/mnt/flash/eapi.conf'] })
    expect(loaded.searched.map((entry) => [entry.path, entry.skipped])).toEqual([
      ['~/.eapi.conf', 'no home directory is available to expand ~'],
      ['/mnt/flash/eapi.conf', 'not present'],
    ])
    expect(loaded.filename).toBeUndefined()
    expect(loaded.profiles).toEqual([])
  })

  it('reports a candidate that exists but cannot be read, warns once, and keeps searching (row 47)', () => {
    // pyeapi would ACCEPT this candidate (os.path.exists is true for a directory) and then lose the
    // error inside configparser, leaving the operator with only the implicit localhost profile and a
    // `filename` pointing at something that was never read (`client.py:178-183`, verified live).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const fs = fakeFs({ '/mnt/flash': new Error('EISDIR: illegal operation on a directory, read'), '/next/eapi.conf': LAB })
    const loaded = resolveEapiConf({ fs, env: {}, paths: ['/mnt/flash', '/next/eapi.conf'] })
    expect(loaded.searched[0]?.skipped).toMatch(/could not be read: EISDIR/u)
    expect(loaded.filename).toBe('/next/eapi.conf')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(hasWarned('eapi-conf-unreadable:/mnt/flash')).toBe(true)
    // DR-011: the warning names the path and the reason — never anything from the file's contents.
    expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).not.toContain('search-probe-secret')
    // The process-wide dedupe really is process-wide: a second search of the same candidate is quiet.
    resolveEapiConf({ fs, env: {}, paths: ['/mnt/flash', '/next/eapi.conf'] })
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('injects the implicit localhost profile only when asked — and never clobbers the author’s (row 48)', () => {
    const withIt = resolveEapiConf({ fs: fakeFs({ '/x/eapi.conf': LAB }), env: {}, paths: ['/x/eapi.conf'], implicitLocalhost: true })
    expect(withIt.store.names()).toEqual(['switch', 'localhost'])
    expect(withIt.store.get('localhost')?.transport).toBe('socket') // client.py:214-221 spelling
    const withoutIt = resolveEapiConf({ fs: fakeFs({ '/x/eapi.conf': LAB }), env: {}, paths: ['/x/eapi.conf'], implicitLocalhost: false })
    expect(withoutIt.store.names()).toEqual(['switch'])
    const defaulted = resolveEapiConf({ fs: fakeFs({ '/x/eapi.conf': LAB }), env: {}, paths: ['/x/eapi.conf'] })
    expect(defaulted.store.names()).toEqual(['switch']) // OFF at this layer — the Node *loader* opts in (DR-008 split)

    const seeded = new ProfileStore()
    seeded.addConnection('localhost', { host: 'the-authors-one' })
    const merged = resolveEapiConf({ fs: fakeFs({ '/x/eapi.conf': LAB }), env: {}, paths: ['/x/eapi.conf'], implicitLocalhost: true, store: seeded })
    expect(merged.store).toBe(seeded)
    expect(seeded.get('localhost')?.host).toBe('the-authors-one') // store.has guard (client.py:184s role)
    expect(seeded.get('localhost')?.transport).toBeUndefined()
  })

  it('merges into a provided store, and streams every issue to onIssue (secret-free)', () => {
    const issuesSeen: string[] = []
    const store = new ProfileStore()
    store.addConnection('existing', { host: 'kept' })
    const loaded = resolveEapiConf({
      fs: fakeFs({ '/x/eapi.conf': confFixture('malformed.conf') }),
      env: {},
      paths: ['/x/eapi.conf'],
      store,
      onIssue: (issue) => issuesSeen.push(issue.message),
    })
    expect(store.names()).toEqual(['existing', 'ok'])
    expect(loaded.issues.length).toBeGreaterThan(4)
    expect(issuesSeen.length).toBe(loaded.issues.length)
    for (const message of issuesSeen) expect(message).not.toContain('10.0.0.5') // issues cite lines/keys, not values (DR-011)
  })

  it('carries the parse-level extras through to the audit record: defaults, otherSections, host defaulting', () => {
    const fs = fakeFs(confFixtureDirectory(['defaults.conf', 'nohost.conf', 'malformed.conf']))
    const withDefaults: LoadedEapiConf = resolveEapiConf({ fs, env: {}, paths: [confFixturePath('defaults.conf')] })
    expect(withDefaults.defaults).toEqual({ username: 'global-user', timeout: '30' })
    expect(withDefaults.otherSections).toEqual([])
    const strict = resolveEapiConf({ fs, env: {}, paths: [confFixturePath('nohost.conf')], applyHostDefault: false })
    expect(strict.profiles[0]?.host).toBeUndefined()
    const loose = resolveEapiConf({ fs, env: {}, paths: [confFixturePath('nohost.conf')] })
    expect(loose.profiles[0]?.host).toBe('test')
    expect(loose.otherSections).toEqual([])
    const nonConnection = resolveEapiConf({ fs, env: {}, paths: [confFixturePath('malformed.conf')] })
    expect(nonConnection.otherSections).toEqual(['other:section'])
    expect(nonConnection.defaults).toBeUndefined() // the conditional spread omits it, callers see absence
  })

  it('treats a zero-byte file as a successful read of an empty config', () => {
    const loaded = resolveEapiConf({ fs: fakeFs(confFixtureDirectory(['empty.conf'])), env: {}, paths: [confFixturePath('empty.conf')] })
    expect(loaded.filename).toBe(confFixturePath('empty.conf'))
    expect(loaded.profiles).toEqual([])
    expect(loaded.issues).toEqual([])
  })

  it('finds the dut.conf profile through the search, pyeapi-spelled transport intact', () => {
    const fs = fakeFs(confFixtureDirectory(['dut.conf']))
    const loaded = resolveEapiConf({ fs, env: {}, paths: [confFixturePath('dut.conf')], implicitLocalhost: true })
    expect(loaded.store.get('veos01')?.transport).toBe('http')
    expect(loaded.store.names()).toEqual(['veos01', 'localhost'])
  })
})


