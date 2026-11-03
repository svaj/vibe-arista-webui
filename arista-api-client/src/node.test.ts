/**
 * The `./node` entry — rewritten for M3 (#5), which replaced the placeholder specs this file used to
 * pin (`createNode()` threw and named the milestone that would implement it).
 *
 * Two things are under test here, and both are entry-specific:
 *  1. **reach** — the kinds only this entry can build (`unix`, `http-local`, `session`,
 *     `https-client-cert`; DR-002/DR-013/DR-014/DR-018), which the browser entry refuses;
 *  2. **the filesystem half of DR-038** — `createNodeFor`/`createConnectionFor` are pyeapi's
 *     `connect_to(name)` (`client.py:1040-1067`) against a real search (`$EAPI_CONF`, `~/.eapi.conf`,
 *     `/mnt/flash/eapi.conf` — `client.py:112`, `:158-184`), driven here through an injected
 *     {@link ConfFileSystem} so no test reads a home directory, and with `env: {}` pinned so an
 *     `EAPI_CONF` in the developer's shell cannot change what the assertions mean.
 *
 * `src/node-profiles.test.ts` and `src/internal/eapi-conf.test.ts` own the search rules themselves;
 * `src/index.test.ts` owns the browser entry's narrower version of the same factories. Keep the three
 * apart: this file is about what a Node-runtime caller actually gets.
 */

import { describe, expect, it } from 'vitest'

import {
  createConnection,
  createConnectionFor,
  createNode,
  createNodeFor,
  createProfiles,
  loadEapiConf,
  nodeConfFileSystem,
  NotSupportedError,
  ProfileStore,
  type LoadedEapiConf,
} from './node'
import { fakeConfFileSystem } from './testing/fake-conf-fs'
import { Node as BrowserNode } from './index'

const LAB_CONF = `[connection:switch]
host: 10.0.0.7
username: ui-ro
password: unused-in-tests
enablepwd: enable-secret
tags: rack-a
`

/** The message of the error a call throws, so one failure can be inspected several ways. */
function failureMessage(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected the call to throw, but it returned normally')
}

describe('the Node entry is a superset of the browser entry', () => {
  it('re-exports the same Node class the browser entry uses', async () => {
    // `export * from './index'` is what makes `./node` the only import an app needs.
    const nodeEntry = await import('./node')
    expect(nodeEntry.Node).toBe(BrowserNode)
  })

  it('exports the profile loader that the browser entry must not have (DR-002/DR-038)', () => {
    expect(typeof loadEapiConf).toBe('function')
    expect(typeof nodeConfFileSystem.exists).toBe('function')
  })

  it('builds a browser kind exactly as the browser entry does', () => {
    const viaNode = createNode({ kind: 'https', host: 'sw1.lan', username: 'ui-ro', password: 'unused-in-tests' })
    expect(viaNode.connection.address).toBe('https://sw1.lan:443/command-api')
    expect(viaNode).toBeInstanceOf(BrowserNode)
  })
})

describe('the kinds only this entry can build (DR-002/DR-013/DR-014/DR-018)', () => {
  it('builds the unix socket, once the switch-local risk is stated out loud', () => {
    const node = createNode({ kind: 'unix', allowLocalUnauthenticated: true })
    expect(node).toBeInstanceOf(BrowserNode)
    expect(node.connection.kind).toBe('unix')
    expect(node.connection.address).toBe('unix:/var/run/command-api.sock')
  })

  it('refuses the same kind with no opt-in, and says why (DR-008/DR-014)', () => {
    const message = failureMessage(() => createConnection({ kind: 'unix' } as never))
    expect(message).toMatch(/DISABLE_AAA/u)
    expect(message).toMatch(/allowLocalUnauthenticated: true/u)
  })

  it('builds a cookie session, which the browser entry refuses outright (DR-018)', () => {
    const transport = createConnection({ kind: 'session', host: 'sw1.lan', username: 'ui-ro', password: 'unused-in-tests', allowInsecureTransport: false })
    expect(transport.kind).toBe('session')
    expect(transport.address).toBe('https://sw1.lan:443/command-api')
  })

  it('builds mTLS from a profile, because cert/key survive the profile round trip (row 59)', () => {
    const store = createProfiles({
      mtls: {
        transport: 'https_certs',
        host: 'sw1.lan',
        cert: '-----BEGIN CERTIFICATE-----\nunused\n-----END CERTIFICATE-----\n',
        key: '-----BEGIN PRIVATE KEY-----\nunused\n-----END PRIVATE KEY-----\n',
      },
    })
    const transport = createConnection({ profileName: 'mtls', store })
    expect(transport.kind).toBe('https-client-cert')
    expect(transport.address).toBe('https://sw1.lan:443/command-api')
    const message = failureMessage(() => createConnection({ profileName: 'mtls', store, overrides: { cert: '' } }))
    expect(message).toMatch(/mTLS needs a client certificate/u)
  })
})

describe('createNodeFor / createConnectionFor: eapi.conf by name, through an injected fs', () => {
  it('reads the named file, not the real home directory, and defaults the transport to https (row 59)', () => {
    const fs = fakeConfFileSystem({ '/lab/eapi.conf': LAB_CONF })
    const node = createNodeFor('switch', { conf: { fs, env: {}, paths: ['/lab/eapi.conf'] } })
    expect(node.connection.address).toBe('https://10.0.0.7:443/command-api')
    // pyeapi folds `enablepwd` into the Node rather than the connection (`client.py:1066`).
    expect(node.settings.enablePassword).toBe('enable-secret')
    expect(fs.reads).toEqual(['/lab/eapi.conf'])
  })

  it('lets the caller keep the settings the profile did not carry', () => {
    const fs = fakeConfFileSystem({ '/lab/eapi.conf': LAB_CONF })
    const node = createNodeFor('switch', { conf: { fs, env: {}, paths: ['/lab/eapi.conf'] }, autorefresh: false, configDefaults: false })
    expect(node.autorefresh).toBe(false)
    expect(node.configDefaults).toBe(false)
    // An explicit `enablePassword` on the call wins over the file's — the caller holds the secret.
    const override = createNodeFor('switch', { conf: { fs, env: {}, paths: ['/lab/eapi.conf'] }, enablePassword: 'from-call' })
    expect(override.settings.enablePassword).toBe('from-call')
  })

  it('hands back a transport, not a command layer, for createConnectionFor', () => {
    const fs = fakeConfFileSystem({ '/lab/eapi.conf': LAB_CONF })
    const transport = createConnectionFor('switch', { conf: { fs, env: {}, paths: ['/lab/eapi.conf'] } })
    expect(transport).not.toBeInstanceOf(BrowserNode)
    expect(transport.kind).toBe('https')
  })

  it('refuses an unknown name with the profiles that do exist, password-free', () => {
    const fs = fakeConfFileSystem({ '/lab/eapi.conf': LAB_CONF })
    const call = () => createNodeFor('nope', { conf: { fs, env: {}, paths: ['/lab/eapi.conf'] } })
    // pyeapi raises a bare AttributeError (`client.py:1061-1064`); this entry promises the typed
    // error the UI branches on, so pin the class and not just the words (`profileNotFound` in
    // `src/internal/conf-builder.ts`, re-exported by `./node`).
    expect(call).toThrow(NotSupportedError)
    const message = failureMessage(call)
    expect(message).toMatch(/connection profile "nope" is not defined/u)
    expect(message).toMatch(/Known profiles: switch, localhost/u)
    expect(message).not.toContain('unused-in-tests')
    expect(message).not.toContain('enable-secret')
  })

  it("carries pyeapi's implicit [connection:localhost] socket profile — inert until the risk is stated", () => {
    // `client.py:214-221` injects it into every config; DR-008 keeps that on this entry only, and
    // DR-014 keeps it unusable until `allow_local_unauthenticated` is stated (MIGRATION.md §5 row 55).
    const store = new ProfileStore()
    const message = failureMessage(() => createNodeFor('localhost', { store }))
    expect(store.get('localhost')?.transport).toBe('socket')
    expect(message).toMatch(/allow_local_unauthenticated/u)
    const node = createNodeFor('localhost', { store, overrides: { allow_local_unauthenticated: true } })
    expect(node.connection.address).toBe('unix:/var/run/command-api.sock')
  })

  it('does not inject it when the caller turns the toggle off', () => {
    const fs = fakeConfFileSystem({ '/lab/eapi.conf': LAB_CONF })
    const message = failureMessage(() =>
      createNodeFor('localhost', { conf: { fs, env: {}, paths: ['/lab/eapi.conf'] }, implicitLocalhost: false }),
    )
    expect(message).toMatch(/not defined/u)
    expect(message).toMatch(/Known profiles: switch/u)
  })

  it('reports what a stored profile is worth for the search: store wins over any file', () => {
    const fs = fakeConfFileSystem({ '/lab/eapi.conf': LAB_CONF })
    const store = createProfiles({ switch: { transport: 'http', host: '127.0.0.1', allow_insecure_transport: true } })
    const node = createNodeFor('switch', { store, conf: { fs, env: {}, paths: ['/lab/eapi.conf'] } })
    expect(node.connection.address).toBe('http://127.0.0.1:80/command-api')
    expect(fs.reads).toEqual([])
  })
})

describe('loadEapiConf through the entry defaults (no device, no real config read)', () => {
  it('is callable with an injected fs and returns the audit trail plus the file it chose', () => {
    const loaded: LoadedEapiConf = loadEapiConf({ fs: fakeConfFileSystem({ '/a/eapi.conf': LAB_CONF }), env: {}, paths: ['/missing/eapi.conf', '/a/eapi.conf', '/b/eapi.conf'] })
    expect(loaded.filename).toBe('/a/eapi.conf')
    expect(loaded.searched.map((entry) => [entry.path, entry.skipped])).toEqual([
      ['/missing/eapi.conf', 'not present'],
      ['/a/eapi.conf', undefined],
    ])
    expect(loaded.store.names()).toEqual(['switch', 'localhost'])
  })
})
