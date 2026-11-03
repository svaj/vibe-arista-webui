/**
 * The Node binding of the `eapi.conf` loader — M3 (#5), the only module in the package whose profile
 * code may touch `node:fs`/`node:os`/`process.env` (DR-002; `src/browser-safety.test.ts` keeps
 * `src/index.ts` free of it, and this file is reachable only from `@devhax-heavy-industries/arista-eapi/node`).
 *
 * The search *rules* are asserted in `src/internal/eapi-conf.test.ts`; what is under test here is the
 * binding: the loader defaults (`env` = `process.env`, `implicitLocalhost = true` — DR-008's Node
 * half), the `warn` seam's console output, and `nodeConfFileSystem`'s own behaviour against the
 * repo-committed fixture corpus only. No user home directory, no device, no network (DR-034); the
 * rules say unit tests never read the real config filesystem, and the single "real" path exercised
 * here is `test/fixtures/eapi.conf/`, a file this repository ships.
 */

import { homedir } from 'node:os'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { loadEapiConf, nodeConfFileSystem } from './node-profiles'
import { clearWarningRegistry } from './internal/warn'
import { confFixture, confFixturePath, fakeConfFileSystem } from './testing/fake-conf-fs'
import { ProfileStore } from './profiles'

const LAB = `[connection:switch]
host: 10.0.0.7
password: binding-probe-secret
`

describe('loadEapiConf — the Node defaults the internal layer refuses to assume', () => {
  beforeEach(() => {
    clearWarningRegistry()
  })

  it('defaults the environment seam to process.env, honouring EAPI_CONF', () => {
    // vi.stubEnv keeps this deterministic on any machine (an `EAPI_CONF` in the developer's real
    // shell can help or hurt otherwise) and vitest restores it after the test.
    vi.stubEnv('EAPI_CONF', '/from-process-env/eapi.conf')
    const fs = fakeConfFileSystem({ '/from-process-env/eapi.conf': LAB, '/mnt/flash/eapi.conf': '[connection:nover]' })
    const loaded = loadEapiConf({ fs })
    expect(loaded.filename).toBe('/from-process-env/eapi.conf') // client.py:171-172 wins over the path list
    expect(fs.reads).toEqual(['/from-process-env/eapi.conf'])
  })

  it('with no EAPI_CONF anywhere, searches the pyeapi path against the real home — but an injected fs', () => {
    vi.stubEnv('EAPI_CONF', undefined)
    const fs = fakeConfFileSystem({}, { homeDirectory: '/no/such/home' })
    const loaded = loadEapiConf({ fs })
    expect(loaded.filename).toBeUndefined()
    expect(loaded.searched.map((entry) => entry.path)).toEqual(['/no/such/home/.eapi.conf', '/mnt/flash/eapi.conf'])
    // DR-008 Node half: with no file at all, pyeapi still has a localhost socket profile
    // (`client.py:184`, `:214-221`) — injected here, inert until the DR-014 risk is stated.
    expect(loaded.store.get('localhost')?.transport).toBe('socket')
  })

  it('injects the implicit localhost by default and keeps it out when told to', () => {
    const fs = fakeConfFileSystem({ '/x/eapi.conf': LAB })
    const on = loadEapiConf({ fs, env: {}, paths: ['/x/eapi.conf'] })
    expect(on.store.names()).toEqual(['switch', 'localhost'])
    const off = loadEapiConf({ fs, env: {}, paths: ['/x/eapi.conf'], implicitLocalhost: false })
    expect(off.store.names()).toEqual(['switch'])
  })

  it('warns once per distinct issue, through console.warn, with no credential in sight (DR-011)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const loaded = loadEapiConf({ fs: fakeConfFileSystem({ '/m/eapi.conf': confFixture('malformed.conf') }), env: {}, paths: ['/m/eapi.conf'], warn: true })
    expect(loaded.issues.length).toBeGreaterThan(4)
    expect(warn).toHaveBeenCalledTimes(loaded.issues.length) // one line per issue: the file's problems, all of them
    const printed = warn.mock.calls.map((call) => String(call[0])).join('\n')
    expect(printed).toContain('[arista-eapi]')
    expect(printed).not.toContain('nowhere') // `host: nowhere` under the dead [connection:] header stays in the file
    expect(printed).not.toContain('10.0.0.5')
    // The default is silent: an operator inspecting a file is not a licence to spray stdout of a UI.
    warn.mockClear()
    loadEapiConf({ fs: fakeConfFileSystem({ '/m/eapi.conf': confFixture('malformed.conf') }), env: {}, paths: ['/m/eapi.conf'] })
    expect(warn).not.toHaveBeenCalled()
  })

  it('passes filename, store and applyHostDefault through to the internal loader', () => {
    const fs = fakeConfFileSystem({ '/one/named.conf': LAB, '/a.conf': '[connection:ignored]\nhost: nope\n' })
    const byName = loadEapiConf({ fs, env: {}, filename: '/one/named.conf', paths: ['/a.conf'] })
    expect(byName.filename).toBe('/one/named.conf')
    const store = new ProfileStore()
    store.addConnection('keepme', { host: 'kept' })
    const merged = loadEapiConf({ fs: fakeConfFileSystem({ '/x.conf': confFixture('nohost.conf') }), env: {}, paths: ['/x.conf'], store, implicitLocalhost: false })
    expect(merged.store).toBe(store)
    expect(store.names()).toEqual(['keepme', 'test'])
    const strict = loadEapiConf({ fs: fakeConfFileSystem({ '/x.conf': confFixture('nohost.conf') }), env: {}, paths: ['/x.conf'], applyHostDefault: false, implicitLocalhost: false })
    expect(strict.store.get('test')?.host).toBeUndefined()
  })
})

describe('nodeConfFileSystem — the seam bound to node:fs (test reads the shipped fixture corpus only)', () => {
  const fixtureFile = confFixturePath('dut.conf')
  const fixtureDir = fixtureFile.replace(/\/dut\.conf$/u, '')

  it('exists() is true for a real file and false for a missing one — and false for a directory (row 54)', () => {
    // pyeapi decides candidate-ness with os.path.exists (client.py:178), which says TRUE for a
    // directory — the source of the "config that was never read" bug. isFile() is the fix.
    expect(nodeConfFileSystem.exists(fixtureFile)).toBe(true)
    expect(nodeConfFileSystem.exists(fixtureDir)).toBe(false)
    expect(nodeConfFileSystem.exists('/definitely/not/here/eapi.conf')).toBe(false)
  })

  it('readText() reads the file, byte-for-byte matching the test-support reader', () => {
    expect(nodeConfFileSystem.readText(fixtureFile)).toBe(confFixture('dut.conf'))
  })

  it('homeDirectory() reports the real home for ~ expansion — the fs seam, not a config read', () => {
    const real = homedir()
    expect(nodeConfFileSystem.homeDirectory()).toBe(real === '' ? undefined : real)
  })

  it('readText() of a missing path throws, which is what the search turns into a skip', () => {
    expect(() => nodeConfFileSystem.readText('/definitely/not/here/eapi.conf')).toThrow()
  })
})
