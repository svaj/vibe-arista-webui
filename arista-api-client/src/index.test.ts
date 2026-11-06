/**
 * The browser-safe entry's factory surface — rewritten for M3 (#5), which is the milestone that
 * replaced the M0 placeholder these specs used to pin.
 *
 * What is asserted here is the **entry**, not the profile engine: the three accepted bag forms, which
 * kinds this entry can build, the `eapi.conf`-free constraint (DR-002/DR-038: a profile *name* is
 * useless without an explicit `store`, and no implicit `connection:localhost` socket profile exists
 * here — DR-008/DR-014, MIGRATION.md §5 row 55), and the secret discipline the UI depends on (DR-011).
 *
 * pyeapi parity anchors: `connect()` is `client.py:394-461` (positional-or-kwargs, `return_node`
 * defaults False, a silent `host='localhost'` at `:394`), `connect_to(name)` is `client.py:1040-1067`
 * (a module-global `config`, `AttributeError` on a miss, `enablepwd` folded into the `Node` at
 * `:1066`). This entry has no `return_node` flag (DR-005 — the function name says it), no default host
 * (row 8), no module-global config (row 54) and a typed `NotSupportedError` instead of `AttributeError`.
 *
 * The M4-era construction path (`new Node(createTransport(…))`) stays covered: M3 had to add the
 * factories without breaking callers that already write it.
 */

import { describe, expect, it } from 'vitest'

import {
  createConnection,
  createNode,
  createProfiles,
  createTransport,
  Node,
  NotSupportedError,
  ProfileStore,
  type ConnectionProfile,
} from './index'
import { mockTransport } from './testing/mock-transport'

/** The message of the error a call throws, so several assertions can inspect one failure. */
function failureMessage(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected the call to throw, but it returned normally')
}

function requireProfile(store: ProfileStore, name: string): ConnectionProfile {
  const profile = store.configFor(name)
  if (profile === undefined) throw new Error(`test setup: profile ${JSON.stringify(name)} is not in the store`)
  return profile
}

describe('createNode / createConnection from an explicit connection bag', () => {
  it('hands back the M4 command layer over a browser transport', () => {
    const node = createNode({ kind: 'https', host: 'sw1.lan', username: 'ui-ro', password: 'unused-in-tests' })
    expect(node).toBeInstanceOf(Node)
    expect(node.connection.kind).toBe('https')
    expect(node.connection.address).toBe('https://sw1.lan:443/command-api')
    expect(String(node)).toBe('Node(connection=https://sw1.lan:443/command-api)')
  })

  it('hands back a bare transport when no command layer was asked for', async () => {
    const transport = createConnection({ kind: 'https', host: 'sw1.lan', port: 8443 })
    expect(transport).not.toBeInstanceOf(Node)
    expect(transport.address).toBe('https://sw1.lan:8443/command-api')
    await transport.close()
  })

  it("keeps M4's `new Node(createTransport(…))` callers working: same class, same options", () => {
    const handBuilt = new Node(createTransport({ kind: 'https', host: 'sw1.lan' }), { configDefaults: false })
    const fromFactory = createNode({ kind: 'https', host: 'sw1.lan', configDefaults: false })
    expect(handBuilt.configDefaults).toBe(false)
    expect(fromFactory).toBeInstanceOf(Node)
    expect(fromFactory.constructor).toBe(handBuilt.constructor)
    expect(fromFactory.configDefaults).toBe(false)
  })

  it('splits the Node settings out of the bag instead of handing them to the transport (enablepwd)', () => {
    // pyeapi `connect(..., enablepwd='enablepwd', return_node=True)` (`client.py:453-460`, `:504`),
    // asserted upstream by `test_connect_return_node_enablepwd`. Until the M3 wiring was repaired this
    // call threw on every attempt: M2's DR-016 allow-list refuses `enablePassword` on a *transport*
    // bag, so the settings must be routed to the `Node` rather than pasted into the connection bag.
    const node = createNode({
      kind: 'https',
      host: 'sw1.lan',
      username: 'ui-ro',
      password: 'unused-in-tests',
      enablePassword: 'enable-secret',
      autorefresh: false,
    })
    expect(node.settings.enablePassword).toBe('enable-secret')
    expect(node.autorefresh).toBe(false)
    expect(node.configDefaults).toBe(true)
  })

  it('keeps the Basic-auth password out of every rendered string (DR-011)', () => {
    const node = createNode({ kind: 'https', host: 'sw1.lan', username: 'ui-ro', password: 'p@ss-words', enablePassword: 'enable-secret' })
    for (const rendered of [String(node), node.connection.address]) {
      expect(rendered).not.toContain('p@ss-words')
      expect(rendered).not.toContain('ui-ro')
    }
    // `settings` holds the enable password the caller passed — one copy, needed to authenticate. What
    // must never appear is the connection password, which lives only inside the transport.
    expect(node.connection.address).toBe('https://sw1.lan:443/command-api')
  })

  it('refuses to invent a host, unlike pyeapi `connect()` (row 8)', () => {
    expect(failureMessage(() => createConnection({ kind: 'https' }))).toMatch(/never defaults to localhost/u)
  })

  it('refuses a Node-only kind from this entry, naming the ./node import (DR-002/DR-013/DR-014)', () => {
    expect(() => createConnection({ kind: 'unix', allowLocalUnauthenticated: true } as never)).toThrow(NotSupportedError)
    expect(failureMessage(() => createConnection({ kind: 'session', host: 'sw1.lan' } as never))).toContain(
      '@devhax-heavy-industries/arista-eapi/node',
    )
  })
})

describe('createNode / createConnection from a profile', () => {
  const store = (): ProfileStore =>
    createProfiles({
      lab: { transport: 'https', host: '10.0.0.30', username: 'ui-ro', password: 'unused-in-tests', tags: 'rack-a', enablepwd: 'enable-secret' },
      on: { transport: 'socket' },
    })

  it('resolves a pyeapi-spelled profile through TRANSPORT_ALIASES', () => {
    const node = createNode({ profileName: 'lab', store: store(), configDefaults: false })
    expect(node.connection.address).toBe('https://10.0.0.30:443/command-api')
    expect(node.configDefaults).toBe(false)
    // pyeapi `connect_to` folds `enablepwd` into the Node (`client.py:1066` → `client.py:504`).
    expect(node.settings.enablePassword).toBe('enable-secret')
  })

  it('accepts a profile object as well as a name, with per-call overrides', () => {
    const profiles = store()
    const node = createNode({ profile: requireProfile(profiles, 'lab'), overrides: { host: '10.0.0.99' } })
    expect(node.connection.address).toBe('https://10.0.0.99:443/command-api')
  })

  it('requires an explicit store: this entry has no filesystem to fall back to (DR-038/DR-044)', () => {
    // A typed `NotSupportedError` where pyeapi raises AttributeError('connection profile not found in
    // config') (`client.py:1061-1064`, upstream `test_missing_connection_raises_attribute_error`); the
    // message lists the profiles that do exist so the UI can branch on it.
    const message = failureMessage(() => createConnection({ profileName: 'nope', store: new ProfileStore() }))
    expect(message).toMatch(/not defined/u)
    expect(message).toMatch(/Known profiles: none/u)
    expect(message).toContain('AttributeError')
  })

  it('never injects the implicit [connection:localhost] socket profile (DR-008, row 55)', () => {
    const profiles = store()
    expect(profiles.names()).not.toContain('localhost')
    const message = failureMessage(() => createConnection({ profileName: 'localhost', store: profiles }))
    expect(message).toMatch(/not defined/u)
    expect(message.toLowerCase()).not.toContain('/var/run/command-api.sock')
  })

  it('refuses a socket profile with a message naming the entry that can build it (DR-002)', () => {
    const message = failureMessage(() => createConnection({ profileName: 'on', store: store() }))
    expect(message).toMatch(/browser build/u)
    expect(message).toContain('@devhax-heavy-industries/arista-eapi/node')
    expect(message).toMatch(/resolves to kind "unix"/u)
  })

  it('refuses connection options pasted into a profile-name bag rather than ignoring them (row 31)', () => {
    const bag = { profileName: 'lab', store: store(), host: 'elsewhere.lan' }
    const message = failureMessage(() => createNode(bag))
    expect(message).toMatch(/unknown option\(s\) host/u)
    expect(message).toMatch(/profileName form/u)
  })

  it('refuses a profile whose own keys could not be honoured instead of defaulting them (row 59)', () => {
    const broken = createProfiles({ lab: { transport: 'https', host: '10.0.0.30', port: 'not-a-port' } })
    const message = failureMessage(() => createConnection({ profileName: 'lab', store: broken }))
    expect(message).toMatch(/refusing to build a connection from profile/u)
    expect(message).toMatch(/is not a port number/u)
    // Reported by key, never by value: a value at that position could be a secret (DR-011).
    expect(message).not.toContain('not-a-port')
  })
})

describe('what the browser entry exports', () => {
  it('exports the profile surface without exporting a filesystem (DR-002)', async () => {
    const surface = await import('./index')
    expect(typeof surface.Node).toBe('function')
    expect(typeof surface.tryVariants).toBe('function')
    expect(typeof surface.parseVersionProperties).toBe('function')
    expect(typeof surface.parseEapiConf).toBe('function')
    expect(typeof surface.createProfiles).toBe('function')
    expect(typeof surface.acceptedTransportNames).toBe('function')
    // The filesystem half of DR-038 lives only behind `./node` (asserted for the module graph by
    // `src/browser-safety.test.ts`; this is the export-surface half of the same rule).
    const names = Object.keys(surface as unknown as Record<string, unknown>)
    expect(names).not.toContain('loadEapiConf')
    expect(names).not.toContain('nodeConfFileSystem')
  })
  it('exports the M7 (#9) resource framework from the browser-safe entry', async () => {
    // PLAN.md assigned the entry-point wiring to M7, so a consumer can build a wave-1 module without
    // importing package internals. Nothing here touches fs/path: the framework is pure.
    const surface = await import('./index')
    const functions = [
      'ResourceBase', 'Entity', 'EntityCollection', 'ResourceRegistry', 'createResourceRegistry',
      'commandBuilder', 'submodeCommands', 'parseConfigBlock', 'toArray',
      'assertInterfaceName', 'assertVlanId', 'isInterfaceName', 'isVlanId',
      // M8 (#10): the first wave-1 module rides the same entry, so `node.system`/`new SystemResource(node)`
      // are both reachable from `.` (and through `export *` from `./node`) without a deep import.
      'SystemResource',
      // M9 (#11): same for the two collection modules — the webui's VLAN/access-port slice (PLAN.md §M9's
      // exit gate) consumes `node.vlans` / `node.switchports` and the mode vocabulary from `.` only.
      'VlansResource', 'SwitchportsResource', 'isSwitchportMode',
      // M10a (#12): the interfaces facade and the per-kind name parser that §5 row 76 promised, both from
      // `.` (and through `export *` from `./node`) without a deep import.
      'InterfacesResource', 'parseInterfaceName',
      // W2d (#41): the VRF collection module rides the same entry — `node.vrfs` and
      // `new VrfsResource(node)` from `.` with no deep import.
      'VrfsResource',
    ] as const
    for (const name of functions) {
      expect(typeof surface[name], name).toBe('function')
    }
    expect(surface.SWITCHPORT_MODES).toEqual(['access', 'trunk', 'dot1q-tunnel', 'private-vlan'])
    expect(surface.isSwitchportMode('private-vlan')).toBe(true)
    expect(surface.isSwitchportMode('private')).toBe(false)
    // `INTERFACE_KINDS` is a frozen list and `INTERFACE_STATUS_COMMAND` the command literal the hybrid
    // read uses — both pin the same spelling the module header claims (M12 #14 owns the device question).
    expect(surface.INTERFACE_KINDS).toEqual(['Ethernet', 'Management', 'Loopback', 'Port-Channel', 'Vlan', 'Vxlan'])
    expect(surface.INTERFACE_STATUS_COMMAND).toBe('show interfaces status')
    expect(surface.parseInterfaceName('Ethernet1.100')).toEqual({ kind: 'Ethernet', index: 1, name: 'Ethernet1.100', subinterface: 100 })
    // The registry has five rows now: M8's `system`, M9's `vlans`/`switchports`, M10a's `interfaces`
    // and W2d's `vrfs` (§5 row 79).
    expect(Object.keys(surface.RESOURCE_FACTORIES)).toEqual(['system', 'vlans', 'switchports', 'interfaces', 'vrfs'])
    expect(new Node(mockTransport()).system).toBeInstanceOf(surface.SystemResource)
    expect(new Node(mockTransport()).vlans).toBeInstanceOf(surface.VlansResource)
    expect(new Node(mockTransport()).switchports).toBeInstanceOf(surface.SwitchportsResource)
    expect(new Node(mockTransport()).interfaces).toBeInstanceOf(surface.InterfacesResource)
    expect(new Node(mockTransport()).vrfs).toBeInstanceOf(surface.VrfsResource)
    // `assertVlanId` is an assertion function (returns void); the range is pyeapi's —
    // `value in range(1, 4095)`, i.e. VLANs 1..4094 (pyeapi/api/vlans.py:78). M9 (#12) re-checks that
    // bound against the switch's own `switchport access vlan` range on a device.
    expect(() => surface.assertVlanId(4094)).not.toThrow()
    expect(surface.isVlanId(4095)).toBe(false)
    expect(() => surface.assertVlanId(4095)).toThrow(/expected an integer VLAN id 1\.\.4094/)
  })
})
