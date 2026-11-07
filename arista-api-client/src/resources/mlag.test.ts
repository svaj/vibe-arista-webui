/**
 * `MlagResource` — W2d (#43), the MLAG entity module on the M7 framework, sibling of `system.ts`.
 * `node.mlag` over `MockTransport`: the single hybrid read answers one hand-authored config text,
 * every write pins an exact joined command list (docs/TESTING.md §3, DR-083). Config is inline,
 * **hand-authored** — same four-writers-collide reasoning as `vrfs.test.ts`/`staticroute.test.ts`.
 * Provenance: reduced from pyeapi's own `test/fixtures/running_config.text` (`mlag configuration`
 * block at `:2072-2082`, `interface Port-Channel10` with `mlag 10` at `:423`ff) — never captured from
 * the 7050TX-64; the cEOS-lab `test/fixtures/live/ceos-4.28.14M/show-mlag.json` capture cross-checks
 * the VOCABULARY only (this module reads config text, not that JSON — see the module header), and no
 * EOS-side acceptance is claimed (M12 #14 owns that).
 *
 * ## Upstream port ledger
 *
 * `pyeapi/test/unit/test_api_mlag.py` has **7** test methods (verified in the pinned clone on
 * 2026-11-06): `test_get` (`:48-62`), `test_set_domain_id` (`:64-76`), `test_set_local_interface`
 * (`:78-91`), `test_set_peer_address` (`:93-105`), `test_set_peer_link` (`:107-119`),
 * `test_set_shutdown` (`:121-133`), `test_set_mlag_id` (`:135-148`). All seven are ported below with
 * the pinned command texts verbatim — the three-state loops (config/negate/default) map onto the
 * DR-037 named-verb trios. What is NOT ported, on purpose: `pyeapi/test/system/test_api_mlag.py`'s
 * **21** methods need a PAIRED two-switch MLAG domain (`mlag.py`'s read is per-node config text and
 * every system test asserts cross-peer behavior); this single-node lane cannot honestly exercise
 * them, so they are declared skipped, not faked. DR-101 and the module header record it.
 *  - `test_get` (`:48-62`) — keys `config`/`interfaces` and the five config field names + `mlag_id`
 *    on Port-Channel10: same nouns here as typed fields (config `domainId`/`localInterface`/
 *    `peerAddress`/`peerLink`/`shutdown`, interface `mlagId`), with the fixture block's `no X`
 *    arms answering ABSENCE instead of upstream's `None` (divergence 2) and — the fixture has no
 *    bare shutdown line, it HAS `no shutdown` (`:2081`) — `shutdown === false`, upstream's
 *    derivation kept (divergence 3).
 *  - `test_set_domain_id` (`:64-76`) — `['mlag configuration', 'domain-id test.dom-id string']`
 *    (`:67-69`): a THREE-WORD value, which is why this module's domain-id guard keeps inner spaces.
 *  - `test_set_local_interface` (`:78-91`) — `local-interface Vlan1234` (+`no`/`default` arms).
 *  - `test_set_peer_address` (`:93-105`) — `peer-address 1.2.3.4`. `test_set_peer_link`
 *    (`:107-119`) — `peer-link Ethernet1`.
 *  - `test_set_shutdown` (`:121-133`) — `shutdown` for BOTH flags false, `no shutdown` for the
 *    `disable=True` arm, `default shutdown` for `default=True`; the triad pins why three verbs,
 *    not one with a flag the caller can forget (`set_shutdown`'s PARAMETER default is
 *    `disable=True`, `mlag.py:255`).
 *  - `test_set_mlag_id` (`:135-148`) — `['interface Ethernet1', 'mlag 1']`: the interface opener,
 *    NOT `mlag configuration` — the revision check the module header divergence 5 records.
 */

import { describe, expect, it } from 'vitest'

import { Node } from '../command-layer'
import { AuthError, NotSupportedError } from '../errors'
import { mockTransport, type MockTransport } from '../testing/mock-transport'
import type { MlagInterface, MlagState } from './mlag'

/** Join lines into config text so a trailing-space line cannot be lost to an editor. */
const textOf = (lines: readonly string[]): string => lines.join('\n')

function configTransport(config: string): MockTransport {
  return mockTransport().replies('enable\nshow running-config all', [{}, { output: config }])
}

function nodeFor(config: string): { node: Node; transport: MockTransport } {
  const transport = configTransport(config)
  return { node: new Node(transport), transport }
}

const writeKey = (cmds: readonly string[]): string => ['enable', 'configure terminal', ...cmds].join('\n')

const sentScripts = (transport: MockTransport): string[][] => transport.sent().map((cmds) => cmds.map(String))

function outcome(fn: () => Promise<unknown>): Promise<unknown> {
  return fn().then(() => 'resolved' as const, (thrown: unknown) => thrown)
}

async function expectError(fn: () => Promise<unknown>, message: RegExp): Promise<void> {
  const thrown = await outcome(fn)
  expect(thrown, 'expected a rejection').toBeInstanceOf(Error)
  expect((thrown as Error).message).toMatch(message)
}

/**
 * The upstream fixture's MLAG half (`running_config.text:2072-2082`) plus `interface
 * Port-Channel10 … mlag 10` (`:423` + the `mlag 10` body line): every `no X` field line, a
 * `heartbeat-interval` this module ignores, `no shutdown`, and one Port-Channel. Ethernet2 carries
 * `mlag 4` but is not a `Po…` name — upstream's `:186` filter and this reader agree to skip it.
 */
const MLAG_FIXTURE_CONFIG = textOf([
  'hostname lab-sw1',
  '!',
  'mlag configuration',
  '   no domain-id',
  '   heartbeat-interval 2000',
  '   no local-interface',
  '   no peer-address',
  '   no peer-link',
  '   reload-delay 300',
  '   no reload-delay non-mlag',
  '   no reload-delay mode',
  '   no shutdown',
  '!',
  'interface Port-Channel10',
  '   no description',
  '   no shutdown',
  '   mlag 10',
  '!',
  'interface Ethernet2',
  '   no shutdown',
  '   mlag 4',
  '!',
  'end',
])

/** A fully-configured domain: every field set, a bare `shutdown`, and a second Port-Channel. */
const MLAG_LIVE_CONFIG = textOf([
  'hostname lab-sw2',
  'mlag configuration',
  '   domain-id lab dom string',
  '   local-interface Vlan4094',
  '   peer-address 10.10.10.1',
  '   peer-link Port-Channel99',
  '   shutdown',
  '!',
  'interface Port-Channel99',
  '   mlag 99',
  '   no shutdown',
  '!',
  'interface Port-Channel11',
  '   no mlag 11',
  '!',
  'end',
])

describe('MlagResource reads — one pass over the whole MLAG picture (mlag.py:81-192)', () => {
  it('the fixture half answers config + interfaces, fields absent where upstream says None (port test_get, :48-62)', async () => {
    const { node, transport } = nodeFor(MLAG_FIXTURE_CONFIG)
    const state = await node.mlag.get()
    // Upstream result keys ('config', 'interfaces') and the five config field names survive as typed
    // fields; the four `no X` lines answer ABSENCE, not None (divergence 2), and shutdown is the
    // fixture's derived False (`no shutdown` present, `:175`/`:2081`).
    expect(state.config).toEqual({ shutdown: false })
    // interfaces: Po-filter keeps Port-Channel10 (`mlag 10`), and Ethernet2's `mlag 4` is out of
    // scope like upstream's `Po.+` findall (:186). mlag_id stays a STRING (:191).
    const interfaces = [...state.interfaces.values()]
    expect(interfaces).toEqual<MlagInterface[]>([{ name: 'Port-Channel10', mlagId: '10' }])
    // ONE config read for the whole hybrid — upstream pays get_block scans per interface (`:188`).
    expect(transport.bodies()).toHaveLength(1)
    expect(transport.callCount()).toBe(1)
  })

  it('a fully written domain reads back every field, and the bare shutdown derives true (divergence 3)', async () => {
    const state = await nodeFor(MLAG_LIVE_CONFIG).node.mlag.get()
    // domain-id keeps its REMAINDER — the `(.+)$` at :119 is why setDomainId accepts inner spaces.
    expect(state.config.domainId).toBe('lab dom string')
    expect(state.config.localInterface).toBe('Vlan4094')
    expect(state.config.peerAddress).toBe('10.10.10.1')
    expect(state.config.peerLink).toBe('Port-Channel99')
    // No `no shutdown` line in the section → upstream's substring rule would answer True; so does
    // this exact-line rule. Whether 4.28 actually writes the bare line is M12 (#14)'s capture.
    expect(state.config.shutdown).toBe(true)
    expect([...state.interfaces.keys()]).toEqual(['Port-Channel99'])
  })

  it('a device with no mlag configuration answers a record — where upstream raises TypeError (divergence 1)', async () => {
    const state = await nodeFor(textOf(['hostname lab-sw4', 'interface Ethernet1', '   no shutdown', 'end'])).node.mlag.get()
    // Upstream: get_block → None → re.search(pattern, None) → TypeError (`:119` fed by `:99`), so a
    // fresh switch makes mlag.get() CRASH. Here: every field simply absent — notably NO invented
    // `shutdown: true`, which would be a state the device never spoke (DR-029 family).
    expect(state).toEqual<MlagState>({ config: {}, interfaces: new Map() })
    expect(state.config.shutdown).toBeUndefined()
  })

  it('`no mlag 11` is a negation and says nothing; an unmatched port-channel drops out (divergence 4, kept upstream-side)', async () => {
    const state = await nodeFor(MLAG_LIVE_CONFIG).node.mlag.get()
    expect(state.interfaces.has('Port-Channel11')).toBe(false)
    // Upstream's `re.search(r'mlag (\\d+)')` (:189) is substring-based and WOULD report
    // mlag_id '11' for that negated line — the divergence is pinned in both directions: upstream
    // keeps the row with a phantom id, this reader drops the row like an unmatched one (:190-191).
  })

  it('a `mlag <digits>` phrase inside other text votes here, but only on its own line (divergence 2/4 disagreement pinned)', async () => {
    const state = await nodeFor(textOf([
      'mlag configuration',
      '   no shutdown',
      '!',
      'interface Port-Channel12',
      '   description carries mlag 3 inside',
      '   mlag 9',
      '!',
      'end',
    ])).node.mlag.get()
    // Upstream's search finds the FIRST `mlag <digits>` anywhere in the block (:189) — the
      // description phrase — and reports id '3'. The keyword-anchored reader sees only mlag 9.
    expect([...state.interfaces.values()]).toEqual<MlagInterface[]>([{ name: 'Port-Channel12', mlagId: '9' }])
  })

  it('a column-0 `interface Po…` line inside a banner never joins the interfaces map (chunked keys, upstream re.M would)', async () => {
    const state = await nodeFor(textOf([
      'banner login',
      'interface PoGhost',
      'EOF',
      '!',
      'end',
    ])).node.mlag.get()
    expect([...state.interfaces.keys()]).toEqual([])
  })

  it('a failed read rejects like any device error — no partial record is rendered (loading/error states are the caller’s by construction)', async () => {
    // The wire-level 401 path maps through the production status mapper to the same AuthError the
    // real transports give (`command-layer.methods.test.ts:451-456` pins the shared mapping).
    const transport = mockTransport().httpStatus(401, 'Unauthorized')
    const thrown = await outcome(() => new Node(transport).mlag.get())
    expect(thrown).toBeInstanceOf(AuthError)
    expect((thrown as AuthError).status).toBe(401)
  })
})

describe('MlagResource writes — mlag configuration opener + one built line (mlag.py:194-290)', () => {
  it('setDomainId keeps the three-word value upstream pins, and the negate/default arms follow (port test_set_domain_id, :64-76)', async () => {
    const { node, transport } = nodeFor(MLAG_FIXTURE_CONFIG)
    const set = writeKey(['mlag configuration', 'domain-id test.dom-id string'])
    const neg = writeKey(['mlag configuration', 'no domain-id'])
    const def = writeKey(['mlag configuration', 'default domain-id'])
    transport.replies(set, [{}, {}, {}, {}]).replies(neg, [{}, {}, {}, {}]).replies(def, [{}, {}, {}, {}])
    await node.mlag.setDomainId('test.dom-id string')
    await node.mlag.unsetDomainId()
    await node.mlag.defaultDomainId()
    expect(sentScripts(transport)).toEqual([
      ['enable', 'configure terminal', 'mlag configuration', 'domain-id test.dom-id string'],
      ['enable', 'configure terminal', 'mlag configuration', 'no domain-id'],
      ['enable', 'configure terminal', 'mlag configuration', 'default domain-id'],
    ])
    // No read precedes any of these — pyeapi's _configure_mlag consults nothing (:194-198).
    expect(transport.callCount()).toBe(3)
  })

  it('local-interface Vlan1234 trio, verbatim (port test_set_local_interface, :78-91)', async () => {
    const { node, transport } = nodeFor(MLAG_FIXTURE_CONFIG)
    const keys = [
      writeKey(['mlag configuration', 'local-interface Vlan1234']),
      writeKey(['mlag configuration', 'no local-interface']),
      writeKey(['mlag configuration', 'default local-interface']),
    ]
    for (const key of keys) transport.replies(key, [{}, {}, {}, {}])
    await node.mlag.setLocalInterface('Vlan1234')
    await node.mlag.unsetLocalInterface()
    await node.mlag.defaultLocalInterface()
    expect(sentScripts(transport).map((cmds) => cmds.at(-1))).toEqual(['local-interface Vlan1234', 'no local-interface', 'default local-interface'])
  })

  it('peer-address 1.2.3.4 trio, verbatim (port test_set_peer_address, :93-105)', async () => {
    const { node, transport } = nodeFor(MLAG_FIXTURE_CONFIG)
    const keys = [
      writeKey(['mlag configuration', 'peer-address 1.2.3.4']),
      writeKey(['mlag configuration', 'no peer-address']),
      writeKey(['mlag configuration', 'default peer-address']),
    ]
    for (const key of keys) transport.replies(key, [{}, {}, {}, {}])
    await node.mlag.setPeerAddress('1.2.3.4')
    await node.mlag.unsetPeerAddress()
    await node.mlag.defaultPeerAddress()
    expect(sentScripts(transport).map((cmds) => cmds.at(-1))).toEqual(['peer-address 1.2.3.4', 'no peer-address', 'default peer-address'])
  })

  it('peer-link Ethernet1 trio, verbatim — the docstring prefers Port-Channel, the test says Ethernet, both ride (port test_set_peer_link, :107-119)', async () => {
    const { node, transport } = nodeFor(MLAG_FIXTURE_CONFIG)
    const keys = [
      writeKey(['mlag configuration', 'peer-link Ethernet1']),
      writeKey(['mlag configuration', 'no peer-link']),
      writeKey(['mlag configuration', 'default peer-link']),
    ]
    for (const key of keys) transport.replies(key, [{}, {}, {}, {}])
    await node.mlag.setPeerLink('Ethernet1')
    await node.mlag.unsetPeerLink()
    await node.mlag.defaultPeerLink()
    expect(sentScripts(transport).map((cmds) => cmds.at(-1))).toEqual(['peer-link Ethernet1', 'no peer-link', 'default peer-link'])
  })

  it('the shutdown triad spells the flag kwargs as three verbs — and upstream’s no-arg default is the NO arm (port test_set_shutdown, :121-133)', async () => {
    const { node, transport } = nodeFor(MLAG_FIXTURE_CONFIG)
    const keys = [
      writeKey(['mlag configuration', 'shutdown']),
      writeKey(['mlag configuration', 'no shutdown']),
      writeKey(['mlag configuration', 'default shutdown']),
    ]
    for (const key of keys) transport.replies(key, [{}, {}, {}, {}])
    // Upstream reaches the BARE line only via set_shutdown(default=False, disable=False) — its
    // signature default (disable=True, mlag.py:255) makes the ZERO-argument call the negation.
    // This client has no forgettable flag: shutdown()/noShutdown()/defaultShutdown(), the same naming
    // interfaces.ts chose for set_shutdown (interfaces.ts:1275-1294, the pattern the brief points at).
    await node.mlag.shutdown()
    await node.mlag.noShutdown()
    await node.mlag.defaultShutdown()
    expect(sentScripts(transport).map((cmds) => cmds.at(-1))).toEqual(['shutdown', 'no shutdown', 'default shutdown'])
  })

  it('setMlagId opens the INTERFACE — mlag.py:288 is configure_interface at this revision (port test_set_mlag_id, :135-148)', async () => {
    const { node, transport } = nodeFor(MLAG_FIXTURE_CONFIG)
    const keys = [
      writeKey(['interface Ethernet1', 'mlag 1']),
      writeKey(['interface Ethernet1', 'no mlag']),
      writeKey(['interface Ethernet1', 'default mlag']),
    ]
    for (const key of keys) transport.replies(key, [{}, {}, {}, {}])
    await node.mlag.setMlagId('Ethernet1', '1')
    await node.mlag.unsetMlagId('Ethernet1')
    await node.mlag.defaultMlagId('Ethernet1')
    expect(sentScripts(transport)).toEqual([
      ['enable', 'configure terminal', 'interface Ethernet1', 'mlag 1'],
      ['enable', 'configure terminal', 'interface Ethernet1', 'no mlag'],
      ['enable', 'configure terminal', 'interface Ethernet1', 'default mlag'],
    ])
    // No 'mlag configuration' opener anywhere above: the interface-vs-switch confusion the dispatch
    // refs carried does not exist at 6816d9e and this port reproduces the code that does (divergence 5).
  })

  it('mlag id 0 composes `mlag 0` — where upstream’s command_builder truthiness would have sent `no mlag` (divergence 6)', async () => {
    const { node, transport } = nodeFor(MLAG_FIXTURE_CONFIG)
    const key = writeKey(['interface Port-Channel10', 'mlag 0'])
    transport.replies(key, [{}, {}, {}, {}])
    // abstract.py:155-161: `elif value:` is False for 0, falling through to the deprecated
    // `return 'no %s'` — set_mlag_id(i, 0) on upstream NEGATES. The repo builder (row 73 / DR-037)
    // emits `stem 0`, and the digits-only guard here lets 0 through as the reader's own grammar
    // (mlag.py:189 `(\d+)` matches it). Removal is unsetMlagId, spelled in the refusal wording too.
    await node.mlag.setMlagId('Port-Channel10', 0)
    expect(sentScripts(transport).at(-1)).toEqual(['enable', 'configure terminal', 'interface Port-Channel10', 'mlag 0'])
    // And the line this write produces reads back as the string '0':
    const state = await nodeFor(textOf(['interface Port-Channel10', '   mlag 0', 'end'])).node.mlag.get()
    expect(state.interfaces.get('Port-Channel10')?.mlagId).toBe('0')
  })
})

describe('MlagResource guards — mlag.py validates nothing; refusals cost zero round trips (divergence 7)', () => {
  it('domain-id refuses what the reader cannot return, and keeps what it can', async () => {
    const { node, transport } = nodeFor(MLAG_FIXTURE_CONFIG)
    const mlag = node.mlag
    await expectError(() => mlag.setDomainId(''), /invalid mlag domain-id/)
    await expectError(() => mlag.setDomainId('  '), /empty domain id is refused/)
    await expectError(() => mlag.setDomainId('pad '), /outer whitespace/)
    await expectError(() => mlag.setDomainId('in\u0007visible'), /control character/)
    await expectError(() => mlag.setDomainId(0 as unknown as string), /expected a string domain id/)
    // Upstream would send the NEGATED command for the first two and the empty-interpolated
    // `domain-id ` for padded values (abstract.py:158-161, :159) — the falsy family again.
    expect(transport.sent()).toEqual([])
  })

  it('local-interface, peer-address and peer-link each carry their reader’s grammar', async () => {
    const { node, transport } = nodeFor(MLAG_FIXTURE_CONFIG)
    const mlag = node.mlag
    await expectError(() => mlag.setLocalInterface('vlan-1'), /one \\w\+ token/)
    await expectError(() => mlag.setLocalInterface('Vlan 4094'), /one \\w\+ token/)
    await expectError(() => mlag.setPeerAddress('10.10.10'), /dotted IPv4/)
    await expectError(() => mlag.setPeerAddress('10.10.10.1 standby'), /dotted IPv4/)
    await expectError(() => mlag.setPeerLink('has space'), /inner whitespace/)
    await expectError(() => mlag.setPeerLink(''), /empty peer link/)
    await expectError(() => mlag.setPeerLink(7 as unknown as string), /expected a string interface name/)
    // Out-of-range octets are NOT refused here — the dotted GRAMMAR is this client's guard, the
    // image owns ranges (DR-032; pyeapi checks nothing at :227-239). Unverified on hardware, M12.
    const key = writeKey(['mlag configuration', 'peer-address 999.1.1.1'])
    transport.replies(key, [{}, {}, {}, {}])
    await mlag.setPeerAddress('999.1.1.1')
    expect(transport.callCount()).toBe(1)
  })

  it('mlag ids are digits or safe non-negative numbers; ranges are the image’s and NOT this guard’s', async () => {
    const { node, transport } = nodeFor(MLAG_FIXTURE_CONFIG)
    const mlag = node.mlag
    await expectError(() => mlag.setMlagId('Port-Channel1', 'ten'), /expected digits/)
    await expectError(() => mlag.setMlagId('Port-Channel1', '10 11'), /expected digits/)
    await expectError(() => mlag.setMlagId('Port-Channel1', -1), /safe non-negative integer/)
    await expectError(() => mlag.setMlagId('Port-Channel1', 10.5), /safe non-negative integer/)
    await expectError(() => mlag.setMlagId('Port-Channel1', NaN), /safe non-negative integer/)
    await expectError(() => mlag.setMlagId('Port-Channel1', Infinity), /safe non-negative integer/)
    await expectError(() => mlag.setMlagId('Port-Channel1', Number.MAX_SAFE_INTEGER + 2), /safe non-negative integer/)
    // The docstring's 1..2000 range (:35-36, :277-284) rides through un-enforced, exactly as
    // pyeapi lets it: whether the image balks is M12 (#14)'s capture, and 2500 composes.
    const key = writeKey(['interface Port-Channel1', 'mlag 2500'])
    transport.replies(key, [{}, {}, {}, {}])
    await mlag.setMlagId('Port-Channel1', '2500')
    expect(transport.callCount()).toBe(1)
    // Interface NAMES go through the framework grammar (open item 7 keeps subif/slot forms out;
    // upstream validated nothing at :288 beyond make_iterable).
    await expectError(() => mlag.setMlagId('Po1', 5), /invalid interface/)
    await expectError(() => mlag.unsetMlagId('Ethernet1.100'), /invalid interface/)
    expect(transport.bodies()).toHaveLength(1)
  })

  it('no guard path ever reads the device first — every write verb is opener+line, and refusals are silent', async () => {
    const { node, transport } = nodeFor(MLAG_FIXTURE_CONFIG)
    await expectError(() => node.mlag.setMlagId('Ethernet1', 'bad'), /expected digits/)
    expect(transport.sent()).toEqual([])
    // A typo'd resource name is still impossible: mlag became a real row (W2d #43), and the registry
    // lists it among the fourteen now — W3c (#51) appended `vrrp`, and the permanent negative control
    // for wave 3 is `pim`, a name pyeapi has no module for at all.
    expect(() => node.resource('notamodule' as never)).toThrow(NotSupportedError)
    expect(() => node.resource('notamodule' as never)).toThrow(/registered: system, vlans, switchports, interfaces, users, ntp, acls, varp, stp, ipinterfaces, vrfs, staticroute, mlag, vrrp/)
  })
})
