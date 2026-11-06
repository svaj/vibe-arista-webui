/**
 * `VrfsResource` — W2d (#41), the VRF collection module on the M7 framework, sibling of `vlans.ts`.
 * Driven through `MockTransport` over the real `Node` (`node.vrfs`): every read answer is device text,
 * every write answer an exact joined command list (docs/TESTING.md §3, DR-083's full-list keys).
 * Config for the tests is **inline and hand-authored** — deliberately NOT new files under
 * `test/fixtures/config/`, because the sibling W2 lanes are editing that directory's
 * `manifest.json`/`pyeapi-oracle.json` in parallel and a fourth writer would collide; the orchestrator
 * can promote any of these blobs to fixtures at merge. Provenance of every blob below: hand-written
 * from the shapes in pyeapi's own `test/fixtures/running_config.vrf` — never captured from the
 * 7050TX-64, and no EOS-side acceptance is claimed by anything here (M12 #14 owns that).
 *
 * ## Upstream port ledger
 *
 * `pyeapi/test/unit/test_api_vrfs.py` has **10** test methods (verified in the pinned clone on
 * 2026-11-05): `test_get` (`:51-60`), `test_get_not_configured` (`:61-62`), `test_getall` (`:64-67`),
 * `test_vrf_functions` (`:69-79`), `test_vrf_create_with_rd` (`:81-86`), `test_set_rd` (`:88-93`),
 * `test_set_description` (`:95-111`), `test_set_ipv4_routing` (`:113-127`),
 * `test_set_ipv6_routing` (`:129-143`), `test_set_interface` (`:145-163`). All ten are ported below as
 * behaviour, with the pins reproduced verbatim — and note WHICH arm upstream pins: every one of its
 * `vrf`-keyword commands is the **`vrf definition`** arm because the fake node pins
 * `self.node._version_number = '4.17.1.1'` (`test/lib/testlib.py:75`), so upstream's suite can never
 * exercise the `>= '4.23'` true-arm at all. This module picks the keyword from the device's config text
 * instead (DR-099), so both arms are pinned here — the definition arm against a config whose sections
 * say `vrf definition` (upstream's exact command texts), the instance arm against `vrf instance`
 * sections, and the no-VRF case against its documented default.
 *  - `test_get` (`:51-60`) — `get('blah')` answers `{vrf_name, rd, description, ipv4_routing,
 *    ipv6_routing}` and `get('test')` answers `description=''`. Here: same values, camelCase fields,
 *    and `description` **absent** for the `no description` block — upstream's `''` is the artifact of
 *    `DESCRIPTION_RE`'s `\s` swallowing the newline (`vrfs.py:56`), which the keyword-anchored reader
 *    does not reproduce (divergence 4, pinned below).
 *  - `test_get_not_configured` (`:61-62`) — `get('notthere')` is `None`; here `undefined` (DR-027).
 *  - `test_getall` (`:64-67`) — three entries for the pinned fixture; same three here, and the read is
 *    ONE request (DR-030) where upstream's loop (`vrfs.py:149`) pays a `section()` scan + `get_block`
 *    re-read per entry.
 *  - `test_vrf_functions` (`:69-79`) — `vrf definition testvrf` (`:73`), `no vrf definition testvrf`
 *    (`:75`), `default vrf definition testvrf` (`:77`); the same three texts appear under the
 *    definition-form config, and their `vrf instance` twins under the modern-form one.
 *  - `test_vrf_create_with_rd` (`:81-86`) — `['vrf definition testvrfrd', 'rd 10:10']` (`:84`), and the
 *    same one-transaction shape here; upstream's `if rd:` (`vrfs.py:173`) also SKIPS an empty-string rd
 *    (Python falsiness) — pinned below, because it is the one falsy case this client reproduces rather
 *    than refuses (the guard runs only on a non-empty value).
 *  - `test_set_rd` (`:88-93`) — `['vrf definition testrdvrf', 'rd 10:10']` (`:91`).
 *  - `test_set_description` (`:95-111`) — `description testing` / `no description` /
 *    `default description` inside the section (`:100-101`, `:105-106`, `:109-110`).
 *  - `test_set_ipv4_routing` (`:113-127`) — bare top-level `ip routing vrf testipv4vrf` (`:117`),
 *    `no …` (`:121`), `default …` (`:125`). Same three texts, and the negative is the flag the reader
 *    consumes (round-trip pinned).
 *  - `test_set_ipv6_routing` (`:129-143`) — `ipv6 unicast-routing vrf testipv6vrf` (`:133`),
 *    `no …` (`:137`), `default …` (`:141`).
 *  - `test_set_interface` (`:145-163`) — `interface Ethernet1` + `vrf forwarding testintvrf` (`:150-151`),
 *    `no vrf forwarding` (`:155`), `default vrf forwarding` (`:160`) — the definition-era pair; the
 *    `vrf`-only twin is pinned against an instance-form config instead of upstream's unexercised
 *    `>= '4.23'` arm.
 *
 * Everything about EOS itself — whether the image accepts an rd shape, quotes descriptions, writes flag
 * lines for every VRF, or which keyword pair an upgraded box actually keys on — is **not** claimed here:
 * unverified on hardware, M12 (#14) to capture, and DECISIONS.md open item 2 (is VRF routing even
 * licensed on this SKU) sits above the whole module.
 */

import { describe, expect, it } from 'vitest'

import { Node } from '../command-layer'
import { CommandError, ConfigParseError, EapiErrorCode, NotSupportedError } from '../errors'
import { mockTransport, type MockTransport } from '../testing/mock-transport'
import type { Vrf, VrfsResource } from './vrfs'

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

function outcome(fn: () => Promise<unknown>): Promise<unknown> {
  return fn().then(() => 'resolved' as const, (thrown: unknown) => thrown)
}

async function expectError(fn: () => Promise<unknown>, message: RegExp): Promise<void> {
  const thrown = await outcome(fn)
  expect(thrown, 'expected a rejection').toBeInstanceOf(Error)
  expect((thrown as Error).message).toMatch(message)
}

/**
 * Hand-authored from `pyeapi/test/fixtures/running_config.vrf:5-15` + `:169-183` — the definition-form
 * config the upstream suite runs against, reduced to what this module reads. `blah` keeps rd +
 * description, `second`/`test` carry `no description` blocks (upstream reads those as `description=''`;
 * divergence 4 pins the difference) and the flag lines mirror the fixture exactly.
 */
const DEFINITION_CONFIG = textOf([
  '!',
  'hostname lab-sw1',
  '!',
  'vrf definition blah',
  '   rd 10:10',
  '   description blah desc',
  '!',
  'vrf definition second',
  '   no description',
  '!',
  'vrf definition test',
  '   rd 200:500',
  '   no description',
  '!',
  'ip routing vrf blah',
  'no ip routing vrf second',
  'no ip routing vrf test',
  '!',
  'no ipv6 unicast-routing vrf blah',
  'no ipv6 unicast-routing vrf second',
  'ipv6 unicast-routing vrf test',
  '!',
  'interface Ethernet1',
  '   vrf forwarding blah',
  '   ip address 10.10.10.1/24',
  '!',
  'end',
])

/** The modern sections an upgraded 4.2x device writes; DR-099's probe-first evidence. */
const INSTANCE_CONFIG = textOf([
  'hostname lab-sw2',
  'vrf instance red',
  '   rd 65001:1',
  '   description RED',
  '!',
  'vrf instance blue',
  '!',
  'no ip routing vrf blue',
  'interface Ethernet2',
  '   vrf red',
  '!',
  'end',
])

/** A mixed config: legacy sections kept from a pre-4.23 config, modern sections written after. */
const MIXED_CONFIG = textOf([
  'hostname lab-sw3',
  'vrf definition legacy',
  '   rd 1:1',
  '!',
  'vrf instance modern',
  '   rd 2:2',
  '!',
  'end',
])

/** No VRF sections at all — the text-silent case whose documented default is `instance` (DR-099). */
const SILENT_CONFIG = textOf(['hostname lab-sw4', '!', 'interface Management1', '   ip address dhcp', 'end'])

function vrfsFor(config: string): VrfsResource {
  return nodeFor(config).node.vrfs
}

describe('VrfsResource reads — vrfs.py:67-99 + the DR-030 read budget', () => {
  it('answers the definition-form table from ONE running-config (ports test_getall, :64-67)', async () => {
    const { node, transport } = nodeFor(DEFINITION_CONFIG)
    const all = await node.vrfs.getAll()
    expect(all.size).toBe(3)
    expect([...all.keys()]).toEqual(['blah', 'second', 'test'])
    expect(all.get('blah')).toEqual<Vrf>({
      name: 'blah',
      definitionForm: 'definition',
      rd: '10:10',
      description: 'blah desc',
      ipv4Routing: true,
      ipv6Routing: false,
    })
    expect(transport.bodies()).toHaveLength(1)
    expect(transport.callCount()).toBe(1)
    // interface Ethernet1's `   vrf forwarding blah` body line, and the flag lines' `vrf` tokens, are
    // not sections: the table keys from indent-0 headers only (chunk.ts keys include their indent).
  })

  it('test_get’s two entries answer field-by-field, except the upstream description artifact (port :51-60)', async () => {
    const vrfs = vrfsFor(DEFINITION_CONFIG)
    // upstream: dict(rd='10:10', vrf_name='blah', description='blah desc', ipv4_routing=True,
    // ipv6_routing=False) — same values except naming and the addition of definitionForm.
    expect(await vrfs.get('blah')).toEqual<Vrf>({
      name: 'blah',
      definitionForm: 'definition',
      rd: '10:10',
      description: 'blah desc',
      ipv4Routing: true,
      ipv6Routing: false,
    })
    // upstream's second assert (`:55-59`) answers rd='200:500', description='' for the
    // `no description` block — the `''` is DESCRIPTION_RE's `\s` matching the newline and an empty
    // `.*$` at end of string (vrfs.py:56). The keyword-anchored reader skips the negation line, so the
    // honest answer here is ABSENCE (divergence 4, DR-029 family):
    expect(await vrfs.get('test')).toEqual<Vrf>({
      name: 'test',
      definitionForm: 'definition',
      rd: '200:500',
      ipv4Routing: false,
      ipv6Routing: true,
    })
  })

  it('the flag rules are upstream’s, exact-line for exact-line (vrfs.py:88-97; divergence 5)', async () => {
    const all = await vrfsFor(DEFINITION_CONFIG).getAll()
    // blah: no `no ip routing vrf blah` line → true even though the POSITIVE line exists; and the
    // positive ipv6 line's ABSENCE is irrelevant, only `no ipv6 unicast-routing vrf blah` votes → false.
    expect(all.get('blah')?.ipv4Routing).toBe(true)
    expect(all.get('blah')?.ipv6Routing).toBe(false)
    expect(all.get('second')?.ipv4Routing).toBe(false)
    expect(all.get('second')?.ipv6Routing).toBe(false)
    expect(all.get('test')?.ipv4Routing).toBe(false)
    expect(all.get('test')?.ipv6Routing).toBe(true)
  })

  it('get() after getAll() costs nothing extra, and an unknown name is undefined (port test_get_not_configured, :61-62)', async () => {
    const { node, transport } = nodeFor(DEFINITION_CONFIG)
    expect((await node.vrfs.get('blah'))?.rd).toBe('10:10')
    await node.vrfs.getAll()
    expect(await node.vrfs.get('notthere')).toBeUndefined()
    expect(await node.vrfs.has('notthere')).toBe(false)
    expect([...(await node.vrfs.keys())]).toEqual(['blah', 'second', 'test'])
    expect(transport.callCount()).toBe(1)
  })

  it('a version it never asks about cannot mislead the read: both keywords are found in one pass (divergence 1)', async () => {
    const all = await vrfsFor(MIXED_CONFIG).getAll()
    expect([...all.keys()]).toEqual(['legacy', 'modern'])
    expect(all.get('legacy')?.definitionForm).toBe('definition')
    expect(all.get('legacy')?.rd).toBe('1:1')
    expect(all.get('modern')?.definitionForm).toBe('instance')
    // Upstream's `get` picks ONE arm from the string compare (`vrfs.py:79-82`): its suite's 4.17 fake
    // would answer None for `vrf instance modern`, and a miscompared '4.9' >= '4.23' box would answer
    // None for `vrf definition legacy`. Neither miss is possible here.
  })

  it('an instance-form config reads the modern sections and their flags', async () => {
    const all = await vrfsFor(INSTANCE_CONFIG).getAll()
    expect([...all.keys()]).toEqual(['red', 'blue'])
    expect(all.get('red')).toEqual<Vrf>({
      name: 'red',
      definitionForm: 'instance',
      rd: '65001:1',
      description: 'RED',
      ipv4Routing: true,
      ipv6Routing: true,
    })
    // `vrf instance blue` with an empty body: no rd line (upstream would carry rd=None, divergence 3),
    // and NO description line at all — where upstream's _parse_description raises AttributeError and
    // its getall would raise for the WHOLE collection (vrfs.py:132, :149; divergence 4).
    expect(all.get('blue')).toEqual<Vrf>({
      name: 'blue',
      definitionForm: 'instance',
      ipv4Routing: false,
      ipv6Routing: true,
    })
  })

  it('a banner body line at column 0 never speaks for a VRF (divergence 2, same rule as vlans divergence 3)', async () => {
    const config = textOf([
      'vrf instance real',
      '   rd 9:9',
      '!',
      'banner login',
      'Welcome. Type vrf instance ghost carefully.',
      'vrf definition ghost2',
      'EOF',
      '!',
      'end',
    ])
    const all = await vrfsFor(config).getAll()
    expect([...all.keys()]).toEqual(['real'])
    // Upstream's getall regex (vrfs.py:142-146) runs over the whole config with re.M, so `ghost2` is an
    // entry for pyeapi — whose get(ghost2) then raises AttributeError in _parse_description anyway
    // (its block lookup via section() does find the column-0 line, and the "block" is the header alone).
  })

  it('a header the name grammar cannot read is reported, not truncated into a phantom (divergence 2)', async () => {
    const config = textOf(['vrf definition foo bar', '   rd 1:1', 'end'])
    const thrown = await outcome(() => vrfsFor(config).getAll())
    expect(thrown).toBeInstanceOf(ConfigParseError)
    expect((thrown as Error).message).toMatch(/cannot read the VRF name in 'vrf definition foo bar'/)
    // Upstream probes differently: its `(\w+)` capture answers the key 'foo' for that line — a
    // phantom name truncated from what the device wrote (vrfs.py:142-146).
    expect((await vrfsFor(textOf(['vrf instance ok_name9', 'end'])).getAll()).size).toBe(1)
  })

  it('a description mentioning “rd” invents no rd, and rd keeps its whole line remainder (divergence 3)', async () => {
    const all = await vrfsFor(textOf([
      'vrf definition sneaky',
      '   description has rd inside',
      '!',
      'vrf definition wide',
      '   rd 1:2:3 odd remainder',
      'end',
    ])).getAll()
    // Upstream RD_RE is `(?:\srd\s)(?P<value>.*)$` (vrfs.py:55) — unanchored, so the description line's
    // ` rd ` names a route distinguisher for pyeapi: get('sneaky') answers rd='inside'. Here the field
    // is simply absent, and the description keeps its text.
    expect(all.get('sneaky')?.rd).toBeUndefined()
    expect(all.get('sneaky')?.description).toBe('has rd inside')
    // The remainder past the keyword is the value — pyeapi keeps it verbatim the same way (its own
    // probe parity), and it survives as one string for the UI to show even though this module's WRITE
    // guards (assertVrfRd) would refuse to compose it: reading is not writing.
    expect(all.get('wide')?.rd).toBe('1:2:3 odd remainder')
  })
})

describe('VrfsResource keyword detection — DR-099 replaces the version compare', () => {
  it('the presence of ANY instance section drives writes to the modern keyword, even for legacy entries', async () => {
    const { node, transport } = nodeFor(MIXED_CONFIG)
    transport
      .replies(writeKey(['no vrf instance legacy']), [{}, {}, {}])
      .replies(writeKey(['vrf instance fresh', 'rd 3:3']), [{}, {}, {}, {}])
    await node.vrfs.delete('legacy')
    await node.vrfs.create('fresh', { rd: '3:3' })
    // The first form-dependent read (the memo fill) precedes the two writes; the latch (DR-099) keeps
    // the second write from re-reading after the first one cleared the config memo.
    expect(transport.sent().slice(-2).map((cmds) => cmds.map(String))).toEqual([
      ['enable', 'configure terminal', 'no vrf instance legacy'],
      ['enable', 'configure terminal', 'vrf instance fresh', 'rd 3:3'],
    ])
    // Upstream would send 'no vrf definition legacy' on its 4.17 fake and 'vrf instance …' on a
    // ≥4.23 one — and which string comparison decides it is the bug DR-078 records for the sibling
    // module. Here the device's own text decides, and the mixed case resolves toward the newer keyword
    // the demonstrably accepts (its sections are written with it).
  })

  it('a definition-only config writes the legacy keyword — upstream’s pinned texts verbatim', async () => {
    const { node, transport } = nodeFor(DEFINITION_CONFIG)
    transport
      .replies(writeKey(['vrf definition testvrf']), [{}, {}, {}])
      .replies(writeKey(['no vrf definition testvrf']), [{}, {}, {}])
      .replies(writeKey(['default vrf definition testvrf']), [{}, {}, {}])
    await node.vrfs.create('testvrf')
    await node.vrfs.delete('testvrf')
    await node.vrfs.setDefault('testvrf')
    expect(transport.sent().slice(-3).map((cmds) => cmds.map(String))).toEqual([
      ['enable', 'configure terminal', 'vrf definition testvrf'],
      ['enable', 'configure terminal', 'no vrf definition testvrf'],
      ['enable', 'configure terminal', 'default vrf definition testvrf'],
    ])
  })

  it('with no VRF sections the default is instance — stated as client convention, tested by the device (DR-099)', async () => {
    const { node, transport } = nodeFor(SILENT_CONFIG)
    transport.replies(writeKey(['vrf instance firstvrf']), [{}, {}, {}])
    await node.vrfs.create('firstvrf')
    // One implicit config read (the memo had to fill) and one write — detection costs no extra round
    // trip, which is part of why capabilities probing (M11) is NOT consulted here (DR-099's "why").
    expect(transport.callCount()).toBe(2)
    expect(transport.sent()[1]?.map(String)).toEqual(['enable', 'configure terminal', 'vrf instance firstvrf'])
  })

  it('a pre-4.23 device on the default arm refuses with its OWN error — the device stays authoritative', async () => {
    // Honest scripted arm, not a claim about EOS behaviour: the image rejects the keyword it does not
    // know, and the caller sees a CommandError with failedCommand.
    const transport = configTransport(SILENT_CONFIG).rejects('vrf instance futureonly', {
      code: EapiErrorCode.COMMAND_INVALID,
      message: "CLI command 3 of 3 'vrf instance futureonly' failed: invalid parameter",
    })
    const thrown = await outcome(() => new Node(transport).vrfs.create('futureonly'))
    expect(thrown).toBeInstanceOf(CommandError)
    expect((thrown as CommandError).failedCommand).toBe('vrf instance futureonly')
  })

  it('detection rides the memoised chunks: a form-dependent write adds no config read after any first read', async () => {
    const { node, transport } = nodeFor(INSTANCE_CONFIG)
    transport.replies(writeKey(['vrf instance later']), [{}, {}, {}, {}])
    await node.vrfs.getAll() // fills the DR-026 memo
    await node.vrfs.create('later')
    expect(transport.callCount()).toBe(2) // one show + one configure, never two shows
  })
})

describe('VrfsResource create/delete/field verbs — vrfs.py:152-260, both arms pinned', () => {
  it('create with rd is ONE transaction and skips an empty-string rd like upstream’s falsy if (port :81-86)', async () => {
    const { node, transport } = nodeFor(DEFINITION_CONFIG)
    transport
      .replies(writeKey(['vrf definition testvrfrd', 'rd 10:10']), [{}, {}, {}, {}])
      .replies(writeKey(['vrf definition testvrfempty']), [{}, {}, {}])
    await node.vrfs.create('testvrfrd', { rd: '10:10' })
    // vrfs.py:173 is `if rd:` — an empty string is falsy in Python and appends nothing; this client
    // keeps that skip while assertVrfRd still refuses '' if a caller tries to SET one via setVrfRd.
    await node.vrfs.create('testvrfempty', { rd: '' })
    expect(transport.sent().slice(-2).map((cmds) => cmds.map(String))).toEqual([
      ['enable', 'configure terminal', 'vrf definition testvrfrd', 'rd 10:10'],
      ['enable', 'configure terminal', 'vrf definition testvrfempty'],
    ])
  })

  it('setVrfRd enters the section — pyeapi pins exactly this at test_api_vrfs.py:88-93 (vrfs.py:225-243)', async () => {
    const { node, transport } = nodeFor(DEFINITION_CONFIG)
    transport
      .replies(writeKey(['vrf definition testrdvrf', 'rd 10:10']), [{}, {}, {}, {}])
      .replies(writeKey(['vrf definition testrdvrf', 'no rd']), [{}, {}, {}, {}])
      .replies(writeKey(['vrf definition testrdvrf', 'default rd']), [{}, {}, {}, {}])
    await node.vrfs.setVrfRd('testrdvrf', '10:10')
    await node.vrfs.unsetVrfRd('testrdvrf')
    await node.vrfs.defaultVrfRd('testrdvrf')
    expect(transport.sent().slice(-3).map((cmds) => cmds.map(String))).toEqual([
      ['enable', 'configure terminal', 'vrf definition testrdvrf', 'rd 10:10'],
      ['enable', 'configure terminal', 'vrf definition testrdvrf', 'no rd'],
      ['enable', 'configure terminal', 'vrf definition testrdvrf', 'default rd'],
    ])
  })

  it('the description trio matches test_api_vrfs.py:95-111 command texts exactly', async () => {
    const { node, transport } = nodeFor(DEFINITION_CONFIG)
    transport
      .replies(writeKey(['vrf definition testdescvrf', 'description testing']), [{}, {}, {}, {}])
      .replies(writeKey(['vrf definition testdescvrf', 'no description']), [{}, {}, {}, {}])
      .replies(writeKey(['vrf definition testdescvrf', 'default description']), [{}, {}, {}, {}])
    await node.vrfs.setVrfDescription('testdescvrf', 'testing')
    await node.vrfs.unsetVrfDescription('testdescvrf')
    await node.vrfs.defaultVrfDescription('testdescvrf')
    expect(transport.sent().slice(-3).map((cmds) => cmds.map(String))).toEqual([
      ['enable', 'configure terminal', 'vrf definition testdescvrf', 'description testing'],
      ['enable', 'configure terminal', 'vrf definition testdescvrf', 'no description'],
      ['enable', 'configure terminal', 'vrf definition testdescvrf', 'default description'],
    ])
    // Round trip: what this client writes, its own reader answers.
    const after = textOf(DEFINITION_CONFIG.split('\n').slice(0, -1).concat(['vrf definition testdescvrf', '   description testing', 'end']))
    expect((await vrfsFor(after).get('testdescvrf'))?.description).toBe('testing')
  })

  it('two section entries through the shared helper never accumulate a parent line (row 71)', async () => {
    const { node, transport } = nodeFor(DEFINITION_CONFIG)
    transport
      .replies(writeKey(['vrf definition aaa', 'description first']), [{}, {}, {}, {}])
      .replies(writeKey(['vrf definition bbb', 'description second']), [{}, {}, {}, {}])
    await node.vrfs.setVrfDescription('aaa', 'first')
    await node.vrfs.setVrfDescription('bbb', 'second')
    expect(transport.sent().slice(-2).map((cmds) => cmds.map(String))).toEqual([
      ['enable', 'configure terminal', 'vrf definition aaa', 'description first'],
      ['enable', 'configure terminal', 'vrf definition bbb', 'description second'],
    ])
    // Upstream's probe answer (the configure_vlan twin at vrfs.py:219-221 mutates the caller's list):
    // two configure_vrf calls over ONE list send ['vrf definition aaa','description first'] then
    // ['vrf definition bbb','vrf definition aaa','description first'] — the parent line piles up.
    // submodeCommands builds fresh arrays, and each batch above carries its parent exactly once.
  })
})

describe('VrfsResource routing-flag verbs — vrfs.py:262-303 (divergence 9)', () => {
  it('set/unset/default ipv4 pin the bare one-line transactions upstream pins (:113-127)', async () => {
    const { node, transport } = nodeFor(DEFINITION_CONFIG)
    transport
      .replies(writeKey(['ip routing vrf testipv4vrf']), [{}, {}, {}])
      .replies(writeKey(['no ip routing vrf testipv4vrf']), [{}, {}, {}])
      .replies(writeKey(['default ip routing vrf testipv4vrf']), [{}, {}, {}])
    await node.vrfs.setIpv4Routing('testipv4vrf')
    await node.vrfs.unsetIpv4Routing('testipv4vrf')
    await node.vrfs.defaultIpv4Routing('testipv4vrf')
    expect(transport.sent().slice(-3).map((cmds) => cmds.map(String))).toEqual([
      ['enable', 'configure terminal', 'ip routing vrf testipv4vrf'],
      ['enable', 'configure terminal', 'no ip routing vrf testipv4vrf'],
      ['enable', 'configure terminal', 'default ip routing vrf testipv4vrf'],
    ])
    // No 'vrf … testipv4vrf' section line anywhere above: the submode is never entered (vrfs.py:275-281
    // calls configure directly, and this port keeps that split).
  })

  it('the ipv6 trio, and the negations read back as the flag (port :129-143)', async () => {
    const { node, transport } = nodeFor(DEFINITION_CONFIG)
    transport
      .replies(writeKey(['ipv6 unicast-routing vrf testipv6vrf']), [{}, {}, {}])
      .replies(writeKey(['no ipv6 unicast-routing vrf testipv6vrf']), [{}, {}, {}])
      .replies(writeKey(['default ipv6 unicast-routing vrf testipv6vrf']), [{}, {}, {}])
    await node.vrfs.setIpv6Routing('testipv6vrf')
    await node.vrfs.unsetIpv6Routing('testipv6vrf')
    await node.vrfs.defaultIpv6Routing('testipv6vrf')
    expect(transport.sent().slice(-3).map((cmds) => cmds.map(String))).toEqual([
      ['enable', 'configure terminal', 'ipv6 unicast-routing vrf testipv6vrf'],
      ['enable', 'configure terminal', 'no ipv6 unicast-routing vrf testipv6vrf'],
      ['enable', 'configure terminal', 'default ipv6 unicast-routing vrf testipv6vrf'],
    ])
    expect((await vrfsFor(DEFINITION_CONFIG).get('test'))?.ipv6Routing).toBe(true)
  })
})

describe('VrfsResource setInterface — vrfs.py:305-330 (divergence 8)', () => {
  it('a definition-form device gets the forwarding keyword upstream’s fake-4.17 suite pins (:145-163)', async () => {
    const { node, transport } = nodeFor(DEFINITION_CONFIG)
    transport
      .replies(writeKey(['interface Ethernet1', 'vrf forwarding testintvrf']), [{}, {}, {}, {}])
      .replies(writeKey(['interface Ethernet1', 'no vrf forwarding']), [{}, {}, {}, {}])
      .replies(writeKey(['interface Ethernet1', 'default vrf forwarding']), [{}, {}, {}, {}])
    await node.vrfs.setInterface('Ethernet1', 'testintvrf')
    await node.vrfs.unsetInterface('Ethernet1')
    await node.vrfs.defaultInterface('Ethernet1')
    expect(transport.sent().slice(-3).map((cmds) => cmds.map(String))).toEqual([
      ['enable', 'configure terminal', 'interface Ethernet1', 'vrf forwarding testintvrf'],
      ['enable', 'configure terminal', 'interface Ethernet1', 'no vrf forwarding'],
      ['enable', 'configure terminal', 'interface Ethernet1', 'default vrf forwarding'],
    ])
  })

  it('an instance-form device gets the bare keyword instead — the arm upstream could never exercise', async () => {
    const { node, transport } = nodeFor(INSTANCE_CONFIG)
    transport.replies(writeKey(['interface Ethernet3', 'vrf red']), [{}, {}, {}, {}])
    await node.vrfs.setInterface('Ethernet3', 'red')
    expect(transport.sent().at(-1)?.map(String)).toEqual(['enable', 'configure terminal', 'interface Ethernet3', 'vrf red'])
  })
})

describe('VrfsResource guards — vrfs.py validates nothing; refusals cost zero round trips (divergence 6)', () => {
  it('a VRF name outside the reader’s own grammar is refused on every verb, before any read', async () => {
    const { node, transport } = nodeFor(DEFINITION_CONFIG)
    const vrfs = node.vrfs
    const badNames: readonly unknown[] = ['has space', 'has.dot', 'up-dash', '', 'BLAH blah', 7, null, undefined, 'a\nb']
    for (const bad of badNames) {
      await expectError(() => vrfs.get(bad as string), /invalid vrf name/)
      await expectError(() => vrfs.create(bad as string), /invalid vrf name/)
      await expectError(() => vrfs.delete(bad as string), /invalid vrf name/)
      await expectError(() => vrfs.setDefault(bad as string), /invalid vrf name/)
      await expectError(() => vrfs.setVrfRd(bad as string, '1:1'), /invalid vrf name/)
      await expectError(() => vrfs.setInterface('Ethernet1', bad as string), /invalid vrf name/)
    }
    // Upstream interpolates all of these: probe — pyeapi's own regexes would key 'has' as a VRF name,
    // and delete('has.dot') compiles a WIDER regex than the name through get_block's `'^%s$'` parent
    // (abstract.py:98). None of it reaches a device from this client (transport stays silent).
    expect(transport.sent()).toEqual([])
  })

  it('rd and description values are refused exactly where they could not read back', async () => {
    const { node, transport } = nodeFor(DEFINITION_CONFIG)
    transport.replies(writeKey(['vrf definition blah', 'no rd']), [{}, {}, {}, {}])
    const vrfs = node.vrfs
    await expectError(() => vrfs.setVrfRd('blah', '  '), /invalid vrf rd/)
    await expectError(() => vrfs.setVrfRd('blah', 'pad '), /leading or trailing whitespace/)
    await expectError(() => vrfs.setVrfRd('blah', 'in ner'), /one token|inner whitespace/)
    await expectError(() => vrfs.setVrfRd('blah', 1500 as unknown as string), /invalid vrf rd/)
    await expectError(() => vrfs.setVrfDescription('blah', 'PAD '), /leading or trailing whitespace/)
    await expectError(() => vrfs.setVrfDescription('blah', 'has"quote'), /cannot round-trip/)
    await expectError(() => vrfs.setVrfDescription('blah', 'ing\x07rat'), /control character/)
    await expectError(() => vrfs.setVrfDescription('blah', ''), /empty description is refused/)
    // The empty-rd clear intent is the named verb, never a falsy value (DR-037). The earlier refusals
    // sent nothing, so the only traffic here is the detection read and this one write.
    await vrfs.unsetVrfRd('blah')
    expect(transport.sent().at(-1)?.map(String)).toEqual([
      'enable', 'configure terminal', 'vrf definition blah', 'no rd',
    ])
  })

  it('an interface name the framework grammar refuses never reaches the wire (open item 7 boundary)', async () => {
    const { node } = nodeFor(DEFINITION_CONFIG)
    await expectError(() => node.vrfs.setInterface('Ethernet1.100', 'blah'), /invalid interface/)
    await expectError(() => node.vrfs.setInterface('Po1', 'blah'), /invalid interface/)
    await expectError(() => node.vrfs.unsetInterface('Ethernet1/1'), /invalid interface/)
  })

  it('a device refusal on a VRF delete surfaces as CommandError with the failed command (DR-005)', async () => {
    const transport = configTransport(DEFINITION_CONFIG).rejects('no vrf definition blah', {
      code: EapiErrorCode.COMMAND_INVALID,
      message: "CLI command 3 of 3 'no vrf definition blah' failed: vrf blah is attached to 1 interface",
    })
    const thrown = await outcome(() => new Node(transport).vrfs.delete('blah'))
    expect(thrown).toBeInstanceOf(CommandError)
    expect((thrown as CommandError).failedCommand).toBe('no vrf definition blah')
    expect((thrown as CommandError).commands).toEqual(['enable', 'configure terminal', 'no vrf definition blah'])
    // Whether that is what 4.28 says when a VRF is in use is an M12 (#14) capture — the envelope shape,
    // not the wording, is what this pins.
  })
})
