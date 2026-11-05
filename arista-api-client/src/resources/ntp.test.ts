/**
 * `NtpResource` — W2a (#35), the port of `pyeapi/test/unit/test_api_ntp.py`'s **11** test methods
 * plus the specs the divergences require (MIGRATION.md §5 rows 155-157, DR-090).
 *
 * Sibling-brief citation corrected: the upstream file is `test_api_ntp.py`, not `test_ntp.py`
 * (verified by listing `test/unit/` in the pinned clone on 2026-11-05). Method refs below are that
 * file's def lines as re-read with `grep -n` on 2026-11-05: `test_instance` `:51-53`, `test_get`
 * `:55-67`, `test_create` `:69-72`, `test_delete` `:74-77`, `test_default` `:79-82`,
 * `test_set_source_interface` `:84-87`, `test_add_server` `:89-92`, `test_add_server_prefer`
 * `:94-97`, `test_add_server_invalid` `:99-104`, `test_remove_server` `:106-109`,
 * `test_remove_all_servers` `:111-114`.
 *
 * Two upstream quirks that change the SHAPE of the port, both recorded in ntp.ts's header:
 *  - `test_create`/`test_delete`/`test_default` alias the SOURCE-interface write/negate/default
 *    (DR-090/row 157): their pinned commands (`ntp source Ethernet2` / `no ntp source` /
 *    `default ntp source`) are ported against {@link NtpResource.setSourceInterface} /
 *    {@link NtpResource.unsetSourceInterface} / {@link NtpResource.defaultSourceInterface} — the
 *    same texts on the same 4.17 mock identity upstream uses.
 *  - `test_get`'s expectation dict (`:56-64`) lists a server keyed `joe` that exists neither in the
 *    fixture nor in its parser's probe output over that fixture, and OMITS `192.168.1.32` (the
 *    `iburst` line) which the parser DOES return — upstream never compares that dict, so its suite
 *    stays green around a stale expectation. Row 156 records the probe; the full server list below
 *    is the corrected one, and it is compared WHOLE this time.
 *
 * `ntpFixture()` reuses upstream's own `ntp …` block (`pyeapi/test/fixtures/running_config.text:242-251`,
 * byte-for-byte, provenance: upstream, re-read 2026-11-05). Every other config is hand-authored here
 * (no new file under `test/fixtures/config/`, so the manifest is unchanged), and no test claims
 * anything about 4.28.13.1M hardware (DR-043).
 */

import { describe, expect, it } from 'vitest'

import { Node } from '../command-layer'
import { NotSupportedError } from '../errors'
import { mockTransport, type MockReply, type MockTransport } from '../testing/mock-transport'
import { NtpResource } from './ntp'

const textOf = (lines: readonly string[]): string => lines.join('\n')

/** Upstream's whole `ntp` block verbatim (`running_config.text:242-251`) — negations included. */
function ntpFixture(): string {
  return textOf([
    'no ntp trusted-key',
    'no ntp authenticate',
    'ntp source Loopback1',
    'ntp server 1.2.3.4 prefer',
    'ntp server 10.20.30.40',
    'ntp server 11.22.33.44',
    'ntp server 123.33.22.11 prefer',
    'ntp server 123.44.55.66',
    'ntp server 192.168.1.32 iburst',
    'no ntp serve all',
    '!',
    'end',
  ])
}

function configTransport(config: string): MockTransport {
  return mockTransport().replies('enable\nshow running-config all', [{}, { output: config }])
}

function nodeFor(config: string): { node: Node; transport: MockTransport } {
  const transport = configTransport(config)
  return { node: new Node(transport), transport }
}

/** The one `show version` read behind the source keyword choice — the `interfaces.test.ts` helper shape. */
const versionKey = 'enable\nshow version'
const versionReply = (version: string): MockReply => [{}, { version, modelName: 'DCS-7050TX-64' }]

const writeKey = (cmds: readonly string[]): string => ['enable', 'configure terminal', ...cmds].join('\n')
const okFor = (cmds: readonly string[]): MockReply => Array.from({ length: cmds.length + 2 }, () => ({}))
function scriptWrite(transport: MockTransport, cmds: readonly string[]): MockTransport {
  return transport.replies(writeKey(cmds), okFor(cmds))
}

function sentAsText(transport: MockTransport): string[][] {
  return transport.sent().map((cmds) => cmds.map((command) => (typeof command === 'string' ? command : command.cmd)))
}

async function outcome(fn: () => Promise<unknown>): Promise<unknown> {
  return fn().then(() => 'resolved' as const, (thrown: unknown) => thrown)
}

async function expectRefusal(fn: () => Promise<unknown>, message: RegExp): Promise<void> {
  const thrown = await outcome(fn)
  expect(thrown).toBeInstanceOf(NotSupportedError)
  expect((thrown as Error).message).toMatch(message)
}

// ====================================================================================================
// get — pyeapi api/ntp.py:53-105 (test_api_ntp.py:55-67; row 156)
// ====================================================================================================

describe('NtpResource.get — pyeapi api/ntp.py:53-105 (row 155 reader arm, row 156)', () => {
  it('node.ntp is the memoised NtpResource instance (parity for test_instance, :51-53, via the registry rather than a class check)', async () => {
    const { node } = nodeFor(ntpFixture())
    expect(node.ntp).toBeInstanceOf(NtpResource)
    expect(node.ntp).toBe(node.ntp)
    expect(node.resource('ntp')).toBe(node.ntp)
  })

  it('the whole record from upstream\'s own ntp block — the CORRECTED server list, compared whole (row 156)', async () => {
    const { node, transport } = nodeFor(ntpFixture())
    expect(await node.ntp.get()).toEqual({
      sourceInterface: 'Loopback1',
      servers: [
        { address: '1.2.3.4', prefer: true },
        { address: '10.20.30.40', prefer: false },
        { address: '11.22.33.44', prefer: false },
        { address: '123.33.22.11', prefer: true },
        { address: '123.44.55.66', prefer: false },
        // The `iburst` line: upstream's own findall over this fixture returns this server (probe,
        // 2026-11-05) even though its :56-64 expectation omits it — and named 'joe', which the probe
        // never produced. The expectation is stale; the parser's real answer is pinned here.
        { address: '192.168.1.32', prefer: false },
      ],
    })
    expect(sentAsText(transport)).toEqual([['enable', 'show running-config all']])
    // One read for the whole record, unlike pyeapi's per-property `_parse_*` scans (row 15), and NO
    // `show version`: the reader takes whichever source spelling the TEXT uses (divergence 3).
  })

  it('a config with no ntp lines answers an empty record, not None (upstream\'s :69-70 and its None-fabricated source key)', async () => {
    const { node } = nodeFor(textOf(['hostname sw1', '!', 'end']))
    expect(await node.ntp.get()).toEqual({ servers: [] })
  })

  it('negated and sub-mode copies are NOT servers (row 156: upstream\'s substring findall counts both)', async () => {
    // Hand-authored: `no ntp server 1.1.1.9` (an explicit removal) and copies indented under
    // submodes. Probe of `ntp.py:99` over the negation form answers ('1.1.1.9','') — the unanchored
    // pattern matches inside `no ntp server …`; the indented copies match the same way. Here neither.
    const config = textOf([
      'ntp server 1.1.1.1',
      'no ntp server 1.1.1.9',
      'ntp server 1.1.1.2 attribute 3',
      'interface Vlan42',
      '   ntp server 10.9.9.9',
      'router bgp 1',
      '  no ntp server 1.1.1.1',
      'end',
    ])
    expect((await nodeFor(config).node.ntp.get()).servers).toEqual([
      { address: '1.1.1.1', prefer: false },
      { address: '1.1.1.2', prefer: false },
    ])
  })

  it('prefer needs the SECOND token — the double-space line upstream cannot flag either (quirk parity)', async () => {
    // `ntp.py:99`'s ` ?(prefer)?` takes AT MOST one space, so `1.2.3.4  prefer` (two) parses as a
    // plain server upstream; both `attribute`-style and second-position junk answer the same here.
    const servers = (await nodeFor(textOf([
      'ntp server 1.2.3.4  prefer',
      'ntp server 5.6.7.8 prefer junk',
      'ntp server 9.9.9.9 attribute prefer',
      'end',
    ])).node.ntp.get()).servers
    expect(servers).toEqual([
      { address: '1.2.3.4', prefer: false },
      { address: '5.6.7.8', prefer: true },
      { address: '9.9.9.9', prefer: false },
    ])
  })

  it('the first source line wins; the dashed 4.23 spelling reads from the text regardless — pinned for row 155 reader arm', async () => {
    const settings = await nodeFor(textOf([
      'ntp source Loopback0',
      'ntp local-interface Vlan4094',
      'end',
    ])).node.ntp.get()
    expect(settings.sourceInterface).toBe('Loopback0')
    const dashed = await nodeFor(textOf(['ntp local-interface Mgmt1', 'end'])).node.ntp.get()
    expect(dashed).toEqual({ sourceInterface: 'Mgmt1', servers: [] })
  })

  it('duplicate server lines are both kept, in document order (parity with the findall, ntp.py:99-104)', async () => {
    const servers = (await nodeFor(textOf(['ntp server a.example', 'ntp server b.example', 'ntp server a.example prefer', 'end'])).node.ntp.get()).servers
    expect(servers).toEqual([
      { address: 'a.example', prefer: false },
      { address: 'b.example', prefer: false },
      { address: 'a.example', prefer: true },
    ])
  })
})

// ====================================================================================================
// source-interface verbs — pyeapi api/ntp.py:107-155 (test_api_ntp.py:69-87; DR-090, row 155/157)
// ====================================================================================================

describe('NtpResource source verbs — pyeapi api/ntp.py:107-155', () => {
  it('setSourceInterface on a 4.17-era device sends `ntp source Vlan50` (:84-87)', async () => {
    const transport = configTransport('end').replies(versionKey, versionReply('4.17.1.1'))
    scriptWrite(transport, ['ntp source Vlan50'])
    await new Node(transport).ntp.setSourceInterface('Vlan50')
    expect(sentAsText(transport)).toEqual([
      ['enable', 'show version'],
      ['enable', 'configure terminal', 'ntp source Vlan50'],
    ])
  })

  it('the DR-090 decision: upstream\'s create(name) alias (`:107-116`, pinned at :69-72 as `ntp source Ethernet2`) is the SAME single write — no create/delete/default aliases are composed', async () => {
    const transport = configTransport('end').replies(versionKey, versionReply('4.17.1.1'))
    scriptWrite(transport, ['ntp source Ethernet2'])
    await new Node(transport).ntp.setSourceInterface('Ethernet2')
    // The Ntp surface has no `create`/`delete`/`default` methods to alias into (DR-090/row 157):
    // the Entity base (base.ts) exposes only `get`, and the class adds exactly the seven verbs.
    const ntp = new Node(transport).ntp
    expect(ntp).not.toHaveProperty('create')
    expect(ntp).not.toHaveProperty('delete')
    expect(ntp).not.toHaveProperty('default')
    expect(sentAsText(transport)).toEqual([
      ['enable', 'show version'],
      ['enable', 'configure terminal', 'ntp source Ethernet2'],
    ])
  })

  it('unsetSourceInterface / defaultSourceInterface send `no`/`default ntp source` on the old form (:74-82 upstream\'s delete/default names)', async () => {
    const transport = configTransport('end').replies(versionKey, versionReply('4.17.1.1'))
    for (const cmds of [['no ntp source'], ['default ntp source']]) scriptWrite(transport, cmds)
    const ntp = new Node(transport).ntp
    await ntp.unsetSourceInterface()
    await ntp.defaultSourceInterface()
    expect(sentAsText(transport)).toEqual([
      ['enable', 'show version'],
      ['enable', 'configure terminal', 'no ntp source'],
      ['enable', 'configure terminal', 'default ntp source'],
    ])
  })

  it('4.23+ gets `ntp local-interface`; 4.9 keeps `ntp source` where upstream\'s string compare takes the dashed arm (row 155, DR-078 restated for ntp.py:119/:131/:143)', async () => {
    for (const [version, stem] of [
      ['4.23.1F', 'ntp local-interface'],
      ['4.28.13.1M', 'ntp local-interface'],
      ['5.0.1F', 'ntp local-interface'],
      ['4.22.2F', 'ntp source'],
      ['4.9.13.1F', 'ntp source'],
      ['3.21.1F', 'ntp source'],
    ] as const) {
      const transport = configTransport('end').replies(versionKey, versionReply(version))
      scriptWrite(transport, [`${stem} Loopback1`])
      await new Node(transport).ntp.setSourceInterface('Loopback1')
      expect(sentAsText(transport), version).toEqual([
        ['enable', 'show version'],
        ['enable', 'configure terminal', `${stem} Loopback1`],
      ])
    }
  })

  it('a version this client cannot classify composes no source command at all (DR-032/DR-057)', async () => {
    for (const version of ['software-version-string', '4', 'v4.23'] as const) {
      const transport = configTransport('end').replies(versionKey, versionReply(version))
      const thrown = await outcome(() => new Node(transport).ntp.setSourceInterface('Loopback1'))
      expect(thrown, version).toBeInstanceOf(NotSupportedError)
      expect((thrown as Error).message, version).toMatch(/cannot pick the NTP source command form/)
      expect(sentAsText(transport), version).toEqual([['enable', 'show version']])
    }
  })

  it('the version read is the Node\'s memo — three source verbs, one `show version`', async () => {
    const transport = configTransport('end').replies(versionKey, versionReply('4.28.13.1M'))
    for (const cmds of [['ntp local-interface Loopback0'], ['no ntp local-interface'], ['default ntp local-interface']]) scriptWrite(transport, cmds)
    const ntp = new Node(transport).ntp
    await ntp.setSourceInterface('Loopback0')
    await ntp.unsetSourceInterface()
    await ntp.defaultSourceInterface()
    expect(transport.bodies().filter((body) => body.params.cmds.some((c) => String(c) === 'show version'))).toHaveLength(1)
  })

  it('junk source-interface names are refused before the version read even runs (validators.ts grammar, row 76)', async () => {
    const transport = configTransport('end').replies(versionKey, versionReply('4.28.13.1M'))
    await expectRefusal(() => new Node(transport).ntp.setSourceInterface('Ethernet/1 nonsense'), /interface/)
    expect(transport.sent()).toEqual([])
  })
})

// ====================================================================================================
// server verbs — pyeapi api/ntp.py:157-196 (test_api_ntp.py:89-114; row 155/156)
// ====================================================================================================

describe('NtpResource server verbs — pyeapi api/ntp.py:157-196', () => {
  it('addServer sends `ntp server 1.1.1.1` (:89-92)', async () => {
    const transport = configTransport('end')
    scriptWrite(transport, ['ntp server 1.1.1.1'])
    await new Node(transport).ntp.addServer('1.1.1.1')
    expect(sentAsText(transport)).toEqual([['enable', 'configure terminal', 'ntp server 1.1.1.1']])
  })

  it('addServer with prefer composes the value upstream composes — `ntp server 1.1.1.1 prefer` (:94-97, ntp.py:170-171)', async () => {
    const transport = configTransport('end')
    scriptWrite(transport, ['ntp server 1.1.1.1 prefer'])
    await new Node(transport).ntp.addServer('1.1.1.1', { prefer: true })
    expect(sentAsText(transport)).toEqual([['enable', 'configure terminal', 'ntp server 1.1.1.1 prefer']])
  })

  it('empty or whitespace addresses are refused with upstream\'s message (its ValueError at ntp.py:169; :99-104)', async () => {
    for (const bad of ['', ' ']) {
      const transport = configTransport('end')
      await expectRefusal(
        () => new Node(transport).ntp.addServer(bad as never, { prefer: true }),
        /ntp server name must be specified/,
      )
      expect(transport.sent(), bad).toEqual([])
    }
  })

  it('a spaced-out address like `1.1.1.1 prefer` is refused — the preference is an option, not an embedded word (row 156 round trip)', async () => {
    const transport = configTransport('end')
    await expectRefusal(() => new Node(transport).ntp.addServer('1.1.1.1 prefer'), /single token/)
    expect(transport.sent()).toEqual([])
  })

  it('removeServer sends `no ntp server 1.1.1.1` (:106-109) — no version read: the negated stem is version-free upstream (:182-183)', async () => {
    const transport = configTransport('end')
    scriptWrite(transport, ['no ntp server 1.1.1.1'])
    await new Node(transport).ntp.removeServer('1.1.1.1')
    expect(sentAsText(transport)).toEqual([['enable', 'configure terminal', 'no ntp server 1.1.1.1']])
  })

  it('removeServer guards the same round trip as addServer (negating an unparseable address is the same mistake)', async () => {
    const transport = configTransport('end')
    await expectRefusal(() => new Node(transport).ntp.removeServer('  '), /ntp server name must be specified/)
    expect(transport.sent()).toEqual([])
  })

  it('removeAllServers sends the single `no ntp` line exactly as upstream builds it (:111-114, ntp.py:193-195)', async () => {
    const transport = configTransport('end')
    scriptWrite(transport, ['no ntp'])
    await new Node(transport).ntp.removeAllServers()
    expect(sentAsText(transport)).toEqual([['enable', 'configure terminal', 'no ntp']])
    // Upstream's comment claims this "removes all server entries" (ntp.py:192-193); what `no ntp`
    // actually covers on 4.28.13.1M is unverified on hardware, M12 (#14) to capture — the docs of
    // this verb say so, and no test claims the scope.
  })

  it('writes cost one transaction each and never read the config (DR-005 no-existence rule, upstream parity)', async () => {
    const transport = configTransport('text that is never read')
    scriptWrite(transport, ['ntp server clock.example prefer'])
    scriptWrite(transport, ['no ntp server clock.example'])
    const ntp = new Node(transport).ntp
    await ntp.addServer('clock.example', { prefer: true })
    await ntp.removeServer('clock.example')
    expect(sentAsText(transport)).toEqual([
      ['enable', 'configure terminal', 'ntp server clock.example prefer'],
      ['enable', 'configure terminal', 'no ntp server clock.example'],
    ])
  })
})
