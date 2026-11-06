/**
 * `AclsResource` / `StandardAclsResource` / `ExtendedAclsResource` and the two conversion helpers — W2b
 * (#37), the access-list surface on the M7 (#9) framework. Driven through `MockTransport` over the real
 * `Node` (`node.acls`), so every read answer is device text and every write answer is an exact command list
 * (docs/TESTING.md §3). Fixture config comes from `test/fixtures/config/acl-sections.conf` (hand-authored per
 * its `manifest.json.provenance`: never captured from the 7050TX-64, modelled on pyeapi's own
 * `test/fixtures/running_config.text:2012-2031`) plus inline config for the shapes upstream cannot read.
 *
 * ## Upstream port ledger
 *
 * `pyeapi/test/unit/test_api_acl.py` — **32** test methods (verified by `grep -n 'def test'` on 2026-11-05;
 * the spans are in `acl.ts`'s header): `TestApiAclFunctions` (`:43-51`, 2), `TestApiAcls` (`:54-124`, 12),
 * `TestApiStandardAcls` (`:126-192`, 9), `TestApiExtendedAcls` (`:194-271`, 9). Ported as behaviour rather
 * than copy, because several upstream assertions pin answers this client refuses to give:
 *  - `test_mask_to_prefixlen` (`:45-47`) / `test_prefixlen_to_mask` (`:49-51`) — ported verbatim, and pinned
 *    against real netaddr (1.3.0) for the netmask-or-32 rule the helper actually implements (§5 row 159).
 *  - `test_instance` (`:61-63`) — `node.acls` is the registry row; asserted in `registry.test.ts` and by the
 *    identity test at the bottom of this file.
 *  - `test_getall` (`:65-69`) — upstream's `{'standard': {…}, 'extended': {…}}` nested dict answers
 *    `test`/`exttest`; here one flat table keyed by name with `type` on the record, and the nested shape is
 *    reconstructible by grouping on that field (DR-093, row 158). `test_get` (`:74-77`) /
 *    `test_get_not_configured` (`:71-72`) — `name`/`type`/`entries` and `None` → `undefined` (DR-027), both
 *    below. `test_get_instance` (`:79-90`) / `test_create_instance_standard` / `_extended` (`:92-100`) — the
 *    class identity they assert is the `type` field plus the two named accessors, and the `_instances` count
 *    is this facade's **two** per-kind objects rather than upstream's per-name dict (probes: `get('std.*')`
 *    invents a record named `std.*`, and `get_instance` caches per name).
 *  - `test_create_standard` (`:102-105`) / `test_create_extended` (`:107-110`) — both texts verbatim.
 *    `test_create_unknown_type_creates_standard` (`:112-115`) — **not** ported as behaviour: probe confirms
 *    `create('test', 'unknown')` sends `ip access-list standard test`, and a typo'd kind writing the *other*
 *    kind of ACL is refused here instead (divergence 8, §5 row 163 — the widened-guard pattern rows 73/76 use).
 *  - `test_proxy_method_success` (`:117-119`) / `test_proxy_method_raises_attribute_error` (`:121-124`) — the
 *    `__getattr__`/`marshall` half of the facade is not ported (DR-006/DR-068/**DR-092**); their intent is kept
 *    twice over: the kind-resolving facade verbs below, and a test that a name the switch does not have is a
 *    `NotFoundError` where probe shows upstream raising
 *    `'{'unconfigured': None}' object has no attribute 'add_entry'`.
 *  - every standard text in `test_acl_functions` (`:142-151`), `test_update_entry` (`:153-158`) /
 *    `_no_log` (`:160-165`), `test_remove_entry` (`:167-170`), `test_add_entry` (`:172-177`) / `_no_log`
 *    (`:179-184`) / `_with_seqno` (`:186-192`) and every extended mirror (`:222-231`, `:233-238`, `:240-245`,
 *    `:247-250`, `:252-257`, `:259-264`, `:266-271`) is reproduced **verbatim** below — including `no <seq>`
 *    ahead of the replacement line, the `%s/%s` prefixlen form, and the trailing `exit`.
 *  - `TestApiExtendedAcls.test_get` (`:201-217`) asserts upstream's fixture entries 50 and 70 field by field,
 *    with `srclen: None` beside `srclen: '24'` and `other: 'urg ttl eq 24 fragments tracked log'`. Those
 *    assertions are the evidence for divergence 1 (row 158): the same lines read here are an `AclMatch` with a
 *    `number` prefixlen, an `options` remainder and a `log` flag lifted out of it (divergence 10).
 *
 * Probe claims were run on 2026-11-05 against the pinned clone with upstream's own harness
 * (`Node(None)` + `_running_config` + a mocked `node.config`, `test/lib/testlib.py:73-84`) — including the
 * regex-level claims about `[p|d]` (`:154`, `:221`), the unanchored `\d+ [p|d].*$` rule probe (`:172`, `:244`),
 * the `match.groups()` crash on `10 p` (`:174`), and the `/None` texts upstream formats out of its own read
 * model (`:207`, `:285-292`). Nothing here claims what the DCS-7050TX-64 accepts: whether `0.0.0.0/32` is a
 * legal standard source, whether the two kinds share one name namespace, what a `description`-like line inside
 * an ACL block looks like, and every other EOS-side rule reads "unverified on hardware, M12 (#14) to capture".
 * `docs/features.md` keeps `Layer 3 access lists` open for the same reason — this module is the client half.
 *
 * `MockTransport` key strings are whole joined command lists (`testing/mock-transport.ts:83-88`), spelled by
 * the `writeKey()` helper below so a multi-command write names every command it sends.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { Node } from '../command-layer'
import { CommandError, ConfigParseError, EapiErrorCode, NotFoundError, NotSupportedError } from '../errors'
import { mockTransport, type MockTransport } from '../testing/mock-transport'
import {
  ACL_TYPES,
  AclsResource,
  ExtendedAclsResource,
  StandardAclsResource,
  isAclType,
  maskToPrefixlen,
  prefixlenToMask,
  type Acl,
  type AclMatchInput,
} from './acl'

/** Join lines into config text so a trailing-space line cannot be lost to an editor. */
const textOf = (lines: readonly string[]): string => lines.join('\n')

/** The committed hand-authored fixture: two standard sections, one extended, one empty. */
const ACL_FIXTURE = readFileSync(
  fileURLToPath(new URL('../../test/fixtures/config/acl-sections.conf', import.meta.url)),
  'utf8',
)

/** Inline config using upstream's own ACL names, so a pinned command list is textually comparable to its test. */
const UPSTREAM_NAMES = textOf([
  'ip access-list standard test',
  '   10 permit any',
  '!',
  'ip access-list exttest',
  '   10 permit ip any any',
  '!',
  'end',
])

/** Every command list a `Node` write sends, from the opener pyeapi's `enable`/`configure terminal` pair. */
const writeKey = (cmds: readonly string[]): string => ['enable', 'configure terminal', ...cmds].join('\n')

function configTransport(config: string): MockTransport {
  return mockTransport().replies('enable\nshow running-config all', [{}, { output: config }])
}

function nodeFor(config: string): { node: Node; transport: MockTransport } {
  const transport = configTransport(config)
  return { node: new Node(transport), transport }
}

/** The subject the way a caller reaches it: the `Node`'s static accessor (DR-052). */
function aclsFor(config: string): AclsResource {
  return nodeFor(config).node.acls
}

/** The entry values of one ACL, as plain objects — the shape this module promises for both kinds. */
function entriesOf(acl: Acl | undefined): unknown[] {
  return acl === undefined ? [] : [...acl.entries.values()]
}

function outcome(fn: () => Promise<unknown>): Promise<unknown> {
  return fn().then(() => 'resolved' as const, (thrown: unknown) => thrown)
}

async function expectError(fn: () => Promise<unknown>, message: RegExp): Promise<void> {
  const thrown = await outcome(fn)
  expect(thrown).toBeInstanceOf(Error)
  expect((thrown as Error).message).toMatch(message)
}

describe('maskToPrefixlen / prefixlenToMask — acl.py:55-79, the helpers PLAN.md §4 schedules with this module', () => {
  it("upstream's two assertions, ported verbatim — test_api_acl.py:45-51", () => {
    expect(maskToPrefixlen('255.255.255.0')).toBe(24)
    expect(prefixlenToMask(24)).toBe('255.255.255.0')
    // Its docstring promises a str back from mask_to_prefixlen (`:62`) and gets netaddr's int; here the
    // answer is a number and the round trip is stable in both directions (§5 row 159).
    expect(maskToPrefixlen(prefixlenToMask(24))).toBe(24)
  })

  it('the netaddr rule is "contiguous ones from the top, otherwise the width" — probed, not guessed', () => {
    // Every value below was printed by the real pyeapi helper over netaddr 1.3.0 on 2026-11-05. This is the
    // reason the parser never calls the helper: a standard ACL writes **wildcards**, and 32 is what the
    // helper answers for every one of them (divergence 2, §5 row 159).
    expect(maskToPrefixlen('255.255.255.255')).toBe(32)
    expect(maskToPrefixlen('255.255.255.128')).toBe(25)
    expect(maskToPrefixlen('255.255.255.254')).toBe(31)
    expect(maskToPrefixlen('255.255.0.0')).toBe(16)
    expect(maskToPrefixlen('128.0.0.0')).toBe(1)
    expect(maskToPrefixlen('0.0.0.0')).toBe(0)
    for (const notANetmask of ['255.0.255.0', '0.0.0.255', '0.255.255.255', '0.0.255.255', '192.168.0.0', '10.0.0.0', '1.2.3.4', '0.0.0.1', '10.20.0.0']) {
      expect(maskToPrefixlen(notANetmask)).toBe(32)
    }
    // The standard-ACL wildcard from the committed fixture, side by side with the netmask the same fixture
    // form would convert to — the pair that makes the divergence visible.
    expect(maskToPrefixlen('0.0.255.255')).toBe(32)
    expect(maskToPrefixlen('255.255.0.0')).toBe(16)
  })

  it('undefined and the empty string take upstream /255 default; a non-address is a refusal, not AddrFormatError', () => {
    expect(maskToPrefixlen(undefined)).toBe(32)
    expect(maskToPrefixlen('')).toBe(32)
    // Probe: acl.py:64's `mask = mask or '255.255.255.255'` is what that default is, and non-dotted-quad text
    // raises `netaddr.AddrFormatError: failed to detect a valid IP address from '32'` / `'banana'` upstream.
    // This taxonomy has no AddrFormatError and does not grow one (DR-005/DR-010), so it becomes a
    // NotSupportedError naming the value.
    for (const bad of ['banana', '32', '24', '256.0.0.0', '1.2.3', '1.2.3.4.5']) {
      expect(() => maskToPrefixlen(bad)).toThrow(NotSupportedError)
      expect(() => maskToPrefixlen(bad)).toThrow(/invalid subnet mask/)
    }
  })

  it('prefix lengths render a dotted quad; the numeric 0 is 0.0.0.0, not upstream /255 default', () => {
    // Probe: `prefixlen = prefixlen or '32'` (acl.py:77) treats the **integer 0** as false, so
    // prefixlen_to_mask(0) answers '255.255.255.255' while prefixlen_to_mask('0') answers '0.0.0.0'. Here 0 is
    // 0.0.0.0 and only `undefined`/empty take the default — §5 row 159 records the split.
    expect(prefixlenToMask(0)).toBe('0.0.0.0')
    expect(prefixlenToMask('0')).toBe('0.0.0.0')
    expect(prefixlenToMask(undefined)).toBe('255.255.255.255')
    expect(prefixlenToMask('')).toBe('255.255.255.255')
    expect(prefixlenToMask('   ')).toBe('255.255.255.255')
    expect(prefixlenToMask(1)).toBe('128.0.0.0')
    expect(prefixlenToMask(8)).toBe('255.0.0.0')
    expect(prefixlenToMask(31)).toBe('255.255.255.254')
    expect(prefixlenToMask(32)).toBe('255.255.255.255')
    expect(prefixlenToMask('24')).toBe('255.255.255.0')
  })

  it('out-of-range or non-integral lengths are refusals, naming the value — probe: AddrFormatError upstream', () => {
    // Prefixes are pinned per value on purpose: a single loop over a mixed union would hide a case.
    for (const bad of ['33', '30.5', 'banana', 33, -1, 2.5, Number.MAX_SAFE_INTEGER]) {
      expect(() => prefixlenToMask(bad)).toThrow(NotSupportedError)
      expect(() => prefixlenToMask(bad)).toThrow(/invalid prefix length/)
    }
    // `Infinity`/`NaN` are the two the guard's `Number.isSafeInteger` test is really about (and TS 7 has no
    // `Number.Infinity` to reach for — the global is the only spelling).
    for (const bad of [Infinity, -Infinity, NaN]) {
      expect(() => prefixlenToMask(bad)).toThrow(/invalid prefix length/)
    }
  })

  it('isAclType / ACL_TYPES are the runtime half of the AclType union (VALID_ACLS, acl.py:52)', () => {
    expect(ACL_TYPES).toEqual(['standard', 'extended'])
    expect(isAclType('standard')).toBe(true)
    expect(isAclType('extended')).toBe(true)
    expect(isAclType('Standard')).toBe(false)
    expect(isAclType('ipv6')).toBe(false)
    expect(isAclType(undefined)).toBe(false)
    expect(isAclType(7)).toBe(false)
  })
})

describe('AclsResource reads — acl.py:88-112 over the committed fixture', () => {
  it('one read answers every ACL of both kinds, in document order (DR-030)', async () => {
    const { node, transport } = nodeFor(ACL_FIXTURE)
    const all = await node.acls.getAll()
    expect([...all.keys()]).toEqual(['ADMIN-STD', 'SNMP-EXT', 'EMPTY-STD'])
    expect(all.get('ADMIN-STD')?.type).toBe('standard')
    expect(all.get('SNMP-EXT')?.type).toBe('extended')
    expect(all.get('EMPTY-STD')?.type).toBe('standard')
    expect([...all.values()].map((acl) => acl.name)).toEqual(['ADMIN-STD', 'SNMP-EXT', 'EMPTY-STD'])
    expect(transport.callCount()).toBe(1)
    expect(transport.sent()).toEqual([['enable', 'show running-config all']])
    // Upstream scans the whole config text (`:104`) and then does one `get_block` per hit
    // (`:105-111` → `:88-89` → `client.py:776-798`), i.e. four requests for this fixture.
  })

  it('a standard section parses host / wildcard / any rules exactly as written (divergences 1-3)', async () => {
    const acl = await aclsFor(ACL_FIXTURE).get('ADMIN-STD')
    expect(acl?.name).toBe('ADMIN-STD')
    expect(acl?.type).toBe('standard')
    expect(entriesOf(acl)).toEqual([
      { seqno: 10, action: 'permit', src: { kind: 'host', address: '10.10.0.7' }, log: true },
      { seqno: 20, action: 'permit', src: { kind: 'address', address: '10.20.0.0', mask: '0.0.255.255' } },
      { seqno: 30, action: 'deny', src: { kind: 'any' } },
    ])
    // Upstream over pyeapi's own equivalent lines (`running_config.text:2015-2017`, probe):
    //   10 → srcaddr '1.2.3.4', srclen 32 (int)  — the `host` marker is dropped, so a host and a bare quad
    //                                              answer identically;
    //   20 → srcaddr '1.2.3.4', srclen 16 — the second token is read as a NETMASK, so the fixture's
    //      `255.255.0.0` becomes a /16 and a real wildcard (`0.0.255.255`) would become a 32, i.e. one host;
    //   30 → `deny any` becomes srcaddr '0.0.0.0' + srclen 32 — `any` and one host collapse together.
    // `kind` is what says which of the three the line actually was, and `mask` keeps the wildcard verbatim.
  })

  it('an extended section parses operators, options and log (divergence 10)', async () => {
    const acl = await aclsFor(ACL_FIXTURE).get('SNMP-EXT')
    expect(entriesOf(acl)).toEqual([
      {
        seqno: 10,
        action: 'permit',
        protocol: 'tcp',
        src: { kind: 'host', address: '10.10.0.5', operator: 'eq 161' },
        dst: { kind: 'host', address: '10.40.0.1' },
        log: true,
      },
      {
        seqno: 20,
        action: 'permit',
        protocol: 'udp',
        src: { kind: 'address', address: '172.16.4.0', prefixlen: 24, operator: 'neq snmp' },
        dst: { kind: 'host', address: '172.16.9.9', operator: 'lt 1024' },
        options: 'fragments',
      },
      {
        seqno: 30,
        action: 'permit',
        protocol: 'icmp',
        src: { kind: 'address', address: '192.168.0.0', prefixlen: 16 },
        dst: { kind: 'any' },
        options: 'ttl eq 1 tracked',
      },
      { seqno: 40, action: 'permit', protocol: 'ip', src: { kind: 'any' }, dst: { kind: 'any' } },
    ])
    // `no statistics per-entry` is a body line this grammar is not about, and upstream agrees it is not a
    // rule — its `\d+ [p|d].*$` probe (`:244`) skips it — but upstream's own fixture line
    // `70 permit tcp 8.8.8.0/24 neq irc host 3.3.3.3 lt ipp urg ttl eq 24 fragments tracked log` answers
    // `other: 'urg ttl eq 24 fragments tracked log'`, i.e. `log` buried in the remainder (probe); here
    // `log: true` is its own field and `options` keeps only what the verb would not re-emit.
  })

  it('prefix lengths are numbers, not the strings upstream answers beside its ints (divergence 1, row 158)', async () => {
    const acl = await aclsFor(ACL_FIXTURE).get('SNMP-EXT')
    const entry20 = acl?.entries.get(20)
    expect(entry20?.src.prefixlen).toBe(24)
    expect(typeof entry20?.src.prefixlen).toBe('number')
    // Probe of upstream's same fixture region: entry 40 of the standard `test` ACL answers srclen '24' (a
    // **string**, from the `/<NN>` capture) while entry 20 answers 16 (an int, from mask_to_prefixlen) — so
    // its `srclen` is not comparable without a type test first, and `None` means "the line said any/host".
  })

  it('an empty ACL is an entry set with nothing in it, not a missing ACL', async () => {
    const acl = await aclsFor(ACL_FIXTURE).get('EMPTY-STD')
    expect(acl).toBeDefined()
    expect(acl?.type).toBe('standard')
    expect(acl?.entries.size).toBe(0)
    expect(entriesOf(acl)).toEqual([])
  })

  it('the flat table reconstructs upstream /27 nested dict (test_getall, :65-69)', async () => {
    const all = await aclsFor(ACL_FIXTURE).getAll()
    const nested: Record<'standard' | 'extended', string[]> = { standard: [], extended: [] }
    for (const acl of all.values()) nested[acl.type].push(acl.name)
    expect(nested).toEqual({ standard: ['ADMIN-STD', 'EMPTY-STD'], extended: ['SNMP-EXT'] })
    // Upstream's answer for its own fixture is {'standard': {'test': …}, 'extended': {'exttest': …}} — grouping
    // on `type` is lossless, and a flat Map is what `get(name)` and a UI table need (DR-068/DR-093).
  })

  it('the per-kind collections answer only their own kind', async () => {
    const { node } = nodeFor(ACL_FIXTURE)
    expect([...(await node.acls.standard.getAll()).keys()]).toEqual(['ADMIN-STD', 'EMPTY-STD'])
    expect([...(await node.acls.extended.getAll()).keys()]).toEqual(['SNMP-EXT'])
    // A kind-pinned `get` on a name of the other kind is "not mine", not "not there" — and it is how upstream's
    // `get_instance`/`ACL_CLASS_MAP` pair (`:126-142`, `:299)`) picks a class before asking it.
    expect(await node.acls.standard.get('SNMP-EXT')).toBeUndefined()
    expect(await node.acls.extended.get('ADMIN-STD')).toBeUndefined()
    expect(await node.acls.standard.get('ADMIN-STD')).toBeDefined()
    expect(node.acls.standard).toBeInstanceOf(StandardAclsResource)
    expect(node.acls.extended).toBeInstanceOf(ExtendedAclsResource)
  })

  it('a name the switch does not have is undefined — test_get_not_configured (:71-72)', async () => {
    const acls = aclsFor(ACL_FIXTURE)
    expect(await acls.get('unconfigured')).toBeUndefined()
    // A padded name is refused outright rather than looked up: a section key is the rstripped line
    // (`client.py:741-747`), so `ADMIN-STD ` can never be the name of a section the switch has.
    await expectError(() => acls.get('ADMIN-STD '), /leading or trailing whitespace/)
    expect(await acls.has('NOPE')).toBe(false)
    expect(await acls.keys()).toEqual(['ADMIN-STD', 'SNMP-EXT', 'EMPTY-STD'])
    expect((await acls.entries()).map(([name]) => name)).toEqual(['ADMIN-STD', 'SNMP-EXT', 'EMPTY-STD'])
  })

  it('a name is a name, not a pattern — probe: upstream reads get("ADMIN.STD") as a regex', async () => {
    // `get_instance` builds `^ip access-list (?:(standard) )?(%s)$` out of the caller's string (`:129-130`) and
    // `get_block` splices `%s` the same way (`:163` → `client.py:793-797`), so upstream answers a complete
    // record **named after the pattern**: probe on a config with only `ip access-list standard stdname` gives
    // get('std.*') → {name: 'std.*', …}. Here the key must be equal, so the phantom name is simply absent
    // (divergence 5, §5 row 160).
    const acls = aclsFor(ACL_FIXTURE)
    expect(await acls.get('ADMIN.STD')).toBeUndefined()
    expect(await acls.get('ADMIN-STD.*')).toBeUndefined()
    // A name with inner whitespace stays readable, because that is an ACL upstream can both write and read
    // back as the same section key (probe: create('has space') and its matching section).
    const spacey = textOf(['ip access-list standard has space', '   10 permit any', '!', 'end'])
    expect((await aclsFor(spacey).get('has space'))?.type).toBe('standard')
  })

  it('section keys that are not ACL headers are ignored, including an IPv6 ACL and similar commands', async () => {
    // acl.py:104 only ever reads `ip access-list …`, so this port reads no IPv6 surface either: an
    // `ipv6 access-list` section is not an ACL row here, and inventing one is a device question (divergence
    // 11, DR-032 — the features.md IPv6 items stay open for the M11 #13/M12 #14 capture lanes).
    const config = textOf([
      'ipv6 access-list V6LIST',
      '   10 permit ipv6 any any',
      '!',
      'ip access-list-neighbor PREFIX_LIST',
      '!',
      'ip access-group ADMIN-STD in',
      '!',
      'end',
    ])
    expect((await aclsFor(config).getAll()).size).toBe(0)
    // The header grammar reads no ACL of either kind, and a name lookup finds nothing to hang a kind on.
    expect(await aclsFor(config).get('V6LIST')).toBeUndefined()
  })

  it('a header with no name reads as an extended ACL named “standard”, on both sides (probe parity)', async () => {
    // `(standard) ` needs its trailing space, so a bare `ip access-list standard` header falls through to the
    // `(.+)` alternative: probe of upstream over exactly this text answers
    // {"standard": {}, "extended": {"standard": {name: 'standard', type: 'extended', …}}}, and
    // `get_instance('standard')` hands back an ExtendedAcls. The artifact is the shared header charset
    // (`:104`/`:129`), so it is pinned rather than quietly differing from upstream (§5 row 158) — and the
    // rule inside it is where the two clients part: upstream invents `protocol: 'any'`, `srcaddr: 'any'` and
    // `dstaddr: 'any'` for `10 permit any`, while this parser reports the line (§5 rows 160-161, divergence 6).
    const bare = textOf(['ip access-list standard', '   10 permit any', '!', 'end'])
    await expectError(() => aclsFor(bare).getAll(), /cannot read the rule '10 permit any' in 'ip access-list standard' — an extended rule needs a source and a destination/)
    const oneLine = textOf(['ip access-list standard', '!', 'end'])
    const acl = await aclsFor(oneLine).get('standard')
    expect(acl?.type).toBe('extended')
    expect(acl?.entries.size).toBe(0)
    expect(await aclsFor(oneLine).standard.get('standard')).toBeUndefined()
  })

  it('the entry order is device document order, and the seqno key is the number the line starts with (row 166)', async () => {
    const outOfOrder = textOf([
      'ip access-list ordered',
      '   30 permit ip any any',
      '   10 permit ip any any',
      '   20 permit ip any any',
      '!',
      'end',
    ])
    const acl = await aclsFor(outOfOrder).get('ordered')
    // No sorting, no renumbering: this client reads what the switch has, and DR-093 makes the keys the
    // seqnos themselves.
    expect([...(acl?.entries.keys()) ?? []]).toEqual([30, 10, 20])
    expect(acl?.entries.get(10)?.seqno).toBe(10)
  })
})

describe('ACL parse failures — what upstream invents, crashes on, or silently drops (rows 160-162)', () => {
  it('a rule line must start with a sequence number: upstream /27 probe finds rules anywhere in a line', async () => {
    // Probe: `\d+ [p|d].*$` with re.M (`:172`, `:244`) plus `[p|d]` as the character class p, |, d (`:154`,
    // `:221`) turn prose into policy — an extended block with `description matches 1500 permit everything`
    // answers an entry 1500 (action permit, protocol 'everything'), and a standard block with
    // `name 20 permit me` answers entry 20 as `permit 0.0.0.0/32`.
    const ext = textOf(['ip access-list prose', '   description matches 1500 permit everything', '!', 'end'])
    expect(entriesOf(await aclsFor(ext).get('prose'))).toEqual([])
    const std = textOf(['ip access-list standard prose', '   name 20 permit me', '!', 'end'])
    expect(entriesOf(await aclsFor(std).get('prose'))).toEqual([])
  })

  it('a rule this grammar cannot read is reported for both kinds — upstream crashes or answers nothing', async () => {
    // Probe: `10 p` raises `AttributeError: 'NoneType' object has no attribute 'groups'` from the standard
    // parser (`:173-174`, no `if match:` guard) and answers `{}` from the extended one (`:246`). Divergence 6.
    await expectError(() => aclsFor(textOf(['ip access-list standard bad', '   10 p', '!', 'end'])).getAll(), /cannot read the rule '10 p' in 'ip access-list standard bad' — the action token 'p' is not permit or deny/)
    await expectError(() => aclsFor(textOf(['ip access-list bad', '   10 p', '!', 'end'])).getAll(), /the action token 'p' is not permit or deny/)
    // Probe: upstream's extended parser answers NO entry at all for `10 permit` — its regex simply ends the
    // match — and invents `dstaddr: 'any'` for `10 permit tcp any` (`:250`, `:253`).
    await expectError(() => aclsFor(textOf(['ip access-list bad', '   10 permit', '!', 'end'])).getAll(), /needs a protocol token/)
    await expectError(() => aclsFor(textOf(['ip access-list bad', '   10 permit tcp any', '!', 'end'])).getAll(), /an extended rule needs a source and a destination/)
    // `host` with nothing after it, a bare operator, and a `range` with one port are the same class of
    // unreadable line. Probe: upstream's `(?: (host))?` group (`:156`) is optional, so `10 permit host` reads
    // there as `permit 0.0.0.0/32` — another invented rule out of an incomplete one.
    await expectError(() => aclsFor(textOf(['ip access-list standard bad', '   10 permit host', '!', 'end'])).getAll(), /`host` needs a dotted-quad address/)
    await expectError(() => aclsFor(textOf(['ip access-list bad', '   10 permit tcp host', '!', 'end'])).getAll(), /`host` needs a dotted-quad address/)
    await expectError(() => aclsFor(textOf(['ip access-list bad', '   10 permit tcp eq 161 any any', '!', 'end'])).getAll(), /is neither `any`, `host <address>` nor a dotted quad/)
    await expectError(() => aclsFor(textOf(['ip access-list bad', '   10 permit tcp any range 1024', '!', 'end'])).getAll(), /the `range` operator needs two ports/)
    // A trailing operator with no operand: upstream's `((?:eq|gt|lt|neq|range) [\w-]+)` requires both.
    await expectError(() => aclsFor(textOf(['ip access-list bad', '   10 permit tcp any eq', '!', 'end'])).getAll(), /the port operator 'eq' needs one operand/)
  })

  it('an address that is not a dotted quad is reported, never half-read', async () => {
    await expectError(() => aclsFor(textOf(['ip access-list standard bad', '   10 permit 1.2.3', '!', 'end'])).getAll(), /'1\.2\.3' is neither/)
    await expectError(() => aclsFor(textOf(['ip access-list standard bad', '   10 permit 1.2.3.4/33', '!', 'end'])).getAll(), /the prefix length 33 is outside 0\.\.32/)
    await expectError(() => aclsFor(textOf(['ip access-list standard bad', '   10 permit 256.0.0.1', '!', 'end'])).getAll(), /'256\.0\.0\.1' is neither/)
    // Probe: upstream reads `5.6.7.0/33` happily and answers srclen '33' (its prefix group is [0-9]{1,2},
    // `:158`), so an impossible prefix length is a value its own write verbs then send back out.
  })

  it('a port operator after `any` stays a port operator, not part of the remainder', async () => {
    // Upstream's port groups sit after each address group (`:226`, `:231`), so it reads
    // `permit tcp any eq 80 any` as srcaddr 'any' + srcport 'eq 80'. A reader that stopped at `any` would put
    // `eq 80` into `options`, which is where unmodelled text belongs and mis-attributed text does not.
    // Whether 4.28 writes a source port after `any` is unverified on hardware, M12 (#14) to capture.
    const config = textOf(['ip access-list ports', '   10 permit tcp any eq 80 any neq 1024 log', '!', 'end'])
    expect(entriesOf(await aclsFor(config).get('ports'))).toEqual([
      {
        seqno: 10,
        action: 'permit',
        protocol: 'tcp',
        src: { kind: 'any', operator: 'eq 80' },
        dst: { kind: 'any', operator: 'neq 1024' },
        log: true,
      },
    ])
    // `range` takes two ports, and the fixture's `lt 1024`/`eq 161` shapes take one — an operator with a
    // missing operand is a refusal on both sides, because guessing an open-ended port would be inventing one.
    await expectError(() => aclsFor(textOf(['ip access-list bad', '   10 permit tcp any range 1024', '!', 'end'])).getAll(), /the `range` operator needs two ports/)
  })

  it('duplicate sequence numbers are a parse failure, not a silent overwrite (divergence 7)', async () => {
    // Probe over `10 permit ip any any` / `20 permit tcp any any eq 80` / `10 deny ip any any log`: upstream
    // answers TWO entries and its 10 is the `deny`, i.e. the first rule has vanished from the answer while the
    // switch still has it (`dict` keyed by seqno, `:180`, `:257`).
    const dup = textOf([
      'ip access-list dup',
      '   10 permit ip any any',
      '   20 permit tcp any any eq 80',
      '   10 deny ip any any log',
      '!',
      'end',
    ])
    await expectError(() => aclsFor(dup).getAll(), /the sequence number 10 appears more than once/)
  })

  it('a sequence number this client cannot key is reported — upstream keys with an unbounded int', async () => {
    await expectError(() => aclsFor(textOf(['ip access-list big', `   ${'9'.repeat(20)} permit ip any any`, '!', 'end'])).getAll(), /has more digits than this client can key a rule by/)
  })

  it('the same ACL name twice is reported rather than one of them being picked (row 162)', async () => {
    const clash = textOf([
      'ip access-list standard CLASH',
      '   10 permit any',
      '!',
      'ip access-list CLASH',
      '   10 permit ip any any',
      '!',
      'end',
    ])
    const thrown = await outcome(() => aclsFor(clash).getAll())
    expect(thrown).toBeInstanceOf(ConfigParseError)
    expect((thrown as Error).message).toMatch(/the name 'CLASH' appears twice in the running-config/)
    // Whether the two forms share a namespace on this SKU is unverified on hardware, M12 (#14) to capture —
    // which is exactly why the client reports instead of choosing silently.
  })

  it('an unreadable rule names its section, so the failure is reviewable (rows 161-162)', async () => {
    const partial = textOf([
      'ip access-list standard good',
      '   10 permit any',
      '!',
      'ip access-list standard broken',
      '   20 maybe',
      '!',
      'end',
    ])
    const thrown = await outcome(() => aclsFor(partial).getAll())
    expect(thrown).toBeInstanceOf(ConfigParseError)
    expect((thrown as ConfigParseError).sectionKey).toBe('ip access-list standard broken')
    expect((thrown as ConfigParseError).shortLine).toBe('20 maybe')
    // Upstream either crashes on the line (`:173-174`) or drops it, and never says which section it was in.
  })
})

describe('ACL writes — the command lists test_api_acl.py pins, reproduced verbatim', () => {
  it('facade create with the upstream default and the extended kind (:102-110)', async () => {
    const transport = mockTransport()
      .replies(writeKey(['ip access-list standard test']), [{}, {}, {}])
      .replies(writeKey(['ip access-list exttest']), [{}, {}, {}])
    const acls = new Node(transport).acls
    await acls.create('test')
    await acls.create('exttest', { type: 'extended' })
    expect(transport.sent().map((cmds) => cmds.map(String))).toEqual([
      ['enable', 'configure terminal', 'ip access-list standard test'],
      ['enable', 'configure terminal', 'ip access-list exttest'],
    ])
  })

  it('an unknown ACL kind is refused, not quietly turned into a standard ACL (divergence 8, row 163)', async () => {
    // Upstream's own test (`:112-115`) and `create_instance` (`:137-142`) make `'unknown'` a standard ACL;
    // probe confirms `create('test', 'unknown')` sends `ip access-list standard test`. Writing a different
    // kind of ACL than the operator asked for is the class of mistake this module refuses instead (§5 row 163,
    // the same shape as rows 73/76).
    const transport = configTransport(UPSTREAM_NAMES)
    const acls = new Node(transport).acls
    for (const bad of ['ipv6', 'Standard', '', 7]) {
      await expectError(() => acls.create('test', { type: bad as never }), /invalid ACL type/)
    }
    // An ABSENT type is not an unknown one: `attrs?.type ?? 'standard'` keeps upstream's `type='standard'`
    // default (acl.py:144), which the first write test above pins.
    // The runtime guard also covers `isAclType`'s negative half. The type is resolved before any read, so a
    // rejected kind costs zero requests.
    expect(transport.sent()).toEqual([])
  })

  it('standard create / delete / setDefault — test_acl_functions (:142-151)', async () => {
    const transport = mockTransport()
      .replies(writeKey(['ip access-list standard test']), [{}, {}, {}])
      .replies(writeKey(['no ip access-list standard test']), [{}, {}, {}])
      .replies(writeKey(['default ip access-list standard test']), [{}, {}, {}])
    const standard = new Node(transport).acls.standard
    await standard.create('test')
    await standard.delete('test')
    await standard.setDefault('test')
    expect(transport.sent().map((cmds) => cmds.map(String))).toEqual([
      ['enable', 'configure terminal', 'ip access-list standard test'],
      ['enable', 'configure terminal', 'no ip access-list standard test'],
      ['enable', 'configure terminal', 'default ip access-list standard test'],
    ])
  })

  it('extended create / delete / setDefault — test_acl_functions (:222-231)', async () => {
    const transport = mockTransport()
      .replies(writeKey(['ip access-list exttest']), [{}, {}, {}])
      .replies(writeKey(['no ip access-list exttest']), [{}, {}, {}])
      .replies(writeKey(['default ip access-list exttest']), [{}, {}, {}])
    const extended = new Node(transport).acls.extended
    await extended.create('exttest')
    await extended.delete('exttest')
    await extended.setDefault('exttest')
    expect(transport.sent().map((cmds) => cmds.map(String))).toEqual([
      ['enable', 'configure terminal', 'ip access-list exttest'],
      ['enable', 'configure terminal', 'no ip access-list exttest'],
      ['enable', 'configure terminal', 'default ip access-list exttest'],
    ])
  })

  it('standard updateEntry with and without log — test_update_entry / _no_log (:153-165)', async () => {
    const transport = mockTransport()
      .replies(writeKey(['ip access-list standard test', 'no 10', '10 permit 0.0.0.0/32 log', 'exit']), [{}, {}, {}, {}, {}, {}])
      .replies(writeKey(['ip access-list standard test', 'no 10', '10 permit 0.0.0.0/32', 'exit']), [{}, {}, {}, {}, {}, {}])
    const standard = new Node(transport).acls.standard
    await standard.updateEntry('test', 10, { action: 'permit', src: { address: '0.0.0.0', prefixlen: 32 }, log: true })
    await standard.updateEntry('test', 10, { action: 'permit', src: { address: '0.0.0.0', prefixlen: 32 } })
    expect(transport.sent().map((cmds) => cmds.map(String))).toEqual([
      ['enable', 'configure terminal', 'ip access-list standard test', 'no 10', '10 permit 0.0.0.0/32 log', 'exit'],
      ['enable', 'configure terminal', 'ip access-list standard test', 'no 10', '10 permit 0.0.0.0/32', 'exit'],
    ])
    // Upstream takes the seqno as a **string** in its own test (`function('update_entry', 'test', '10', …)`) and
    // interpolates it; here it is a number, and the same number keys the read model's entries.
  })

  it('standard addEntry, bare / without log / with a seqno — (:172-192)', async () => {
    const transport = mockTransport()
      .replies(writeKey(['ip access-list standard test', 'permit 0.0.0.0/32 log', 'exit']), [{}, {}, {}, {}, {}])
      .replies(writeKey(['ip access-list standard test', 'permit 0.0.0.0/32', 'exit']), [{}, {}, {}, {}, {}])
      .replies(writeKey(['ip access-list standard test', '30 permit 0.0.0.0/32 log', 'exit']), [{}, {}, {}, {}, {}])
    const standard = new Node(transport).acls.standard
    await standard.addEntry('test', { action: 'permit', src: { address: '0.0.0.0', prefixlen: 32 }, log: true })
    await standard.addEntry('test', { action: 'permit', src: { address: '0.0.0.0', prefixlen: 32 }, log: false })
    await standard.addEntry('test', { action: 'permit', src: { address: '0.0.0.0', prefixlen: 32 }, log: true, seqno: 30 })
    expect(transport.sent().map((cmds) => cmds.map(String))).toEqual([
      ['enable', 'configure terminal', 'ip access-list standard test', 'permit 0.0.0.0/32 log', 'exit'],
      ['enable', 'configure terminal', 'ip access-list standard test', 'permit 0.0.0.0/32', 'exit'],
      ['enable', 'configure terminal', 'ip access-list standard test', '30 permit 0.0.0.0/32 log', 'exit'],
    ])
    // `log: false` is the spelling of upstream's `log=False` default here (exactOptionalPropertyTypes keeps a
    // `log: undefined` spread from typechecking, and `false` is what the upstream signature actually says).
    // The absent seqno is upstream's `seqno=None` default too: the **device** numbers it, and nothing in
    // acl.py computes a sequence number client-side, so neither does this module (DR-093).
  })

  it('standard removeEntry — test_remove_entry (:167-170)', async () => {
    const transport = mockTransport().replies(writeKey(['ip access-list standard test', 'no 10', 'exit']), [{}, {}, {}, {}, {}])
    await new Node(transport).acls.standard.removeEntry('test', 10)
    expect(transport.sent()).toEqual([['enable', 'configure terminal', 'ip access-list standard test', 'no 10', 'exit']])
  })

  it('extended updateEntry with and without log — test_update_entry / _no_log (:233-245)', async () => {
    const transport = mockTransport()
      .replies(writeKey(['ip access-list exttest', 'no 10', '10 permit ip 0.0.0.0/32 1.1.1.1/32 log', 'exit']), [{}, {}, {}, {}, {}, {}])
      .replies(writeKey(['ip access-list exttest', 'no 10', '10 permit ip 0.0.0.0/32 1.1.1.1/32', 'exit']), [{}, {}, {}, {}, {}, {}])
    const extended = new Node(transport).acls.extended
    await extended.updateEntry('exttest', 10, { action: 'permit', protocol: 'ip', src: { address: '0.0.0.0', prefixlen: 32 }, dst: { address: '1.1.1.1', prefixlen: 32 }, log: true })
    await extended.updateEntry('exttest', 10, { action: 'permit', protocol: 'ip', src: { address: '0.0.0.0', prefixlen: 32 }, dst: { address: '1.1.1.1', prefixlen: 32 }, log: false })
    expect(transport.sent().map((cmds) => cmds.map(String))).toEqual([
      ['enable', 'configure terminal', 'ip access-list exttest', 'no 10', '10 permit ip 0.0.0.0/32 1.1.1.1/32 log', 'exit'],
      ['enable', 'configure terminal', 'ip access-list exttest', 'no 10', '10 permit ip 0.0.0.0/32 1.1.1.1/32', 'exit'],
    ])
  })

  it('extended addEntry, bare / without log / with a seqno, and removeEntry — (:247-271)', async () => {
    const transport = mockTransport()
      .replies(writeKey(['ip access-list exttest', 'permit ip 0.0.0.0/32 1.1.1.1/32 log', 'exit']), [{}, {}, {}, {}, {}])
      .replies(writeKey(['ip access-list exttest', 'permit ip 0.0.0.0/32 1.1.1.1/32', 'exit']), [{}, {}, {}, {}, {}])
      .replies(writeKey(['ip access-list exttest', '30 permit ip 0.0.0.0/32 1.1.1.1/32 log', 'exit']), [{}, {}, {}, {}, {}])
      .replies(writeKey(['ip access-list exttest', 'no 10', 'exit']), [{}, {}, {}, {}, {}])
    const extended = new Node(transport).acls.extended
    await extended.addEntry('exttest', { action: 'permit', protocol: 'ip', src: { address: '0.0.0.0', prefixlen: 32 }, dst: { address: '1.1.1.1', prefixlen: 32 }, log: true })
    await extended.addEntry('exttest', { action: 'permit', protocol: 'ip', src: { address: '0.0.0.0', prefixlen: 32 }, dst: { address: '1.1.1.1', prefixlen: 32 }, log: false })
    await extended.addEntry('exttest', { action: 'permit', protocol: 'ip', src: { address: '0.0.0.0', prefixlen: 32 }, dst: { address: '1.1.1.1', prefixlen: 32 }, log: true, seqno: 30 })
    await extended.removeEntry('exttest', 10)
    expect(transport.sent().map((cmds) => cmds.map(String))).toEqual([
      ['enable', 'configure terminal', 'ip access-list exttest', 'permit ip 0.0.0.0/32 1.1.1.1/32 log', 'exit'],
      ['enable', 'configure terminal', 'ip access-list exttest', 'permit ip 0.0.0.0/32 1.1.1.1/32', 'exit'],
      ['enable', 'configure terminal', 'ip access-list exttest', '30 permit ip 0.0.0.0/32 1.1.1.1/32 log', 'exit'],
      ['enable', 'configure terminal', 'ip access-list exttest', 'no 10', 'exit'],
    ])
  })

  it('the four match arms render the spellings a device writes (divergence 9)', async () => {
    const transport = mockTransport()
      .replies(writeKey(['ip access-list exttest', 'permit ip any any', 'exit']), [{}, {}, {}, {}, {}])
      .replies(writeKey(['ip access-list exttest', 'permit tcp host 1.1.1.1 host 2.2.2.2', 'exit']), [{}, {}, {}, {}, {}])
      .replies(writeKey(['ip access-list exttest', 'permit tcp 3.3.3.0/24 4.4.4.0/24', 'exit']), [{}, {}, {}, {}, {}])
      .replies(writeKey(['ip access-list standard test', 'permit 10.20.0.0 0.0.255.255', 'exit']), [{}, {}, {}, {}, {}])
      .replies(writeKey(['ip access-list standard test', 'permit host 1.2.3.4 log', 'exit']), [{}, {}, {}, {}, {}])
    const acls = new Node(transport).acls
    await acls.extended.addEntry('exttest', { action: 'permit', protocol: 'ip', src: { any: true }, dst: { any: true } })
    await acls.extended.addEntry('exttest', { action: 'permit', protocol: 'tcp', src: { host: '1.1.1.1' }, dst: { host: '2.2.2.2' } })
    await acls.extended.addEntry('exttest', { action: 'permit', protocol: 'tcp', src: { address: '3.3.3.0', prefixlen: 24 }, dst: { address: '4.4.4.0', prefixlen: 24 } })
    // The `<addr> <mask>` arm is the standard-ACL wildcard spelling from the committed fixture, kept verbatim
    // rather than converted (divergence 2), and `host <addr>` is how the device wrote that fixture's first
    // standard rule. Both arms exist on the standard side only — the refusal of the mask arm on the extended
    // side is the next test.
    await acls.standard.addEntry('test', { action: 'permit', src: { address: '10.20.0.0', mask: '0.0.255.255' } })
    await acls.standard.addEntry('test', { action: 'permit', src: { host: '1.2.3.4' }, log: true })
    expect(transport.sent().map((cmds) => cmds.map(String))).toEqual([
      ['enable', 'configure terminal', 'ip access-list exttest', 'permit ip any any', 'exit'],
      ['enable', 'configure terminal', 'ip access-list exttest', 'permit tcp host 1.1.1.1 host 2.2.2.2', 'exit'],
      ['enable', 'configure terminal', 'ip access-list exttest', 'permit tcp 3.3.3.0/24 4.4.4.0/24', 'exit'],
      ['enable', 'configure terminal', 'ip access-list standard test', 'permit 10.20.0.0 0.0.255.255', 'exit'],
      ['enable', 'configure terminal', 'ip access-list standard test', 'permit host 1.2.3.4 log', 'exit'],
    ])
  })

  it('the mask arm on the extended side and the protocol field on the standard side are refused', async () => {
    // Upstream has no guard here at all: probe shows `add_entry('x','permit','ip','any',None,'1.1.1.2',None)`
    // sending `permit ip any/None 1.1.1.2/None` and the standard form sending `permit any/None` — the `/None`
    // text that its own reader produced for `any`/`host`, i.e. upstream cannot round-trip its own read model.
    const transport = configTransport(UPSTREAM_NAMES)
    const acls = new Node(transport).acls
    await expectError(
      () => acls.extended.addEntry('exttest', { action: 'permit', protocol: 'ip', src: { address: '1.1.1.0', mask: '0.0.0.255' }, dst: { any: true } }),
      /the `<address> <mask>` arm is a standard-ACL spelling/,
    )
    await expectError(() => acls.standard.addEntry('test', { action: 'permit', protocol: 'ip', src: { any: true } }), /a standard ACL rule has no protocol field/)
    await expectError(() => acls.standard.addEntry('test', { action: 'permit', src: { any: true }, dst: { any: true } }), /a standard ACL rule has no destination field/)
    await expectError(() => acls.extended.addEntry('exttest', { action: 'permit', protocol: 'ip', src: { any: true } }), /an extended ACL rule needs a destination/)
    // The kind-pinned collections need no read to know what header to write, so a rejected argument costs
    // zero requests — the half of the four-state rule that lets a form show an error without a device call.
    expect(transport.sent()).toEqual([])
  })

  it('every argument guard names the value it rejected, before any write', async () => {
    const transport = configTransport(UPSTREAM_NAMES)
    const extended = new Node(transport).acls.extended
    // Actions: upstream's `[p|d]\w+` (`:154`, `:221`) would happily send `pwn`.
    for (const bad of ['pwn', 'PERMIT', '', 'grant']) {
      await expectError(() => extended.addEntry('exttest', { action: bad as never, protocol: 'ip', src: { any: true }, dst: { any: true } }), /invalid ACL action/)
    }
    // Protocols: one token, or a refusal. `47` (number) is what upstream's fixture-style decimal protocol reads
    // as, and the guard needs the string form.
    for (const bad of ['ip tcp', '', 47, undefined]) {
      await expectError(() => extended.addEntry('exttest', { action: 'permit', protocol: bad as never, src: { any: true }, dst: { any: true } }), /invalid ACL protocol/)
    }
    // Addresses, prefix lengths and the match shape itself.
    await expectError(() => extended.addEntry('exttest', { action: 'permit', protocol: 'ip', src: { address: 'banana', prefixlen: 24 }, dst: { any: true } }), /invalid source address/)
    await expectError(() => extended.addEntry('exttest', { action: 'permit', protocol: 'ip', src: { host: '1.1.1' }, dst: { any: true } }), /invalid source host address/)
    await expectError(() => extended.addEntry('exttest', { action: 'permit', protocol: 'ip', src: { any: true }, dst: { host: 'nope' } }), /invalid destination host address/)
    await expectError(() => extended.addEntry('exttest', { action: 'permit', protocol: 'ip', src: { address: '1.1.1.0', prefixlen: 33 }, dst: { any: true } }), /invalid ACL prefix length 33/)
    // A prefix length typed as a string by a decoded form is the case the type system cannot catch (MIGRATION
    // §5's TS note: `as unknown as number`, not a bare `as number`, which is itself a type error).
    await expectError(() => extended.addEntry('exttest', { action: 'permit', protocol: 'ip', src: { address: '1.1.1.0', prefixlen: '20' as unknown as number }, dst: { any: true } }), /invalid ACL prefix length '20'/)
    await expectError(() => extended.addEntry('exttest', { action: 'permit', protocol: 'ip', src: undefined as never, dst: { any: true } }), /invalid source match/)
    await expectError(() => extended.addEntry('exttest', { action: 'permit', protocol: 'ip', src: {} as unknown as AclMatchInput, dst: { any: true } }), /invalid source match/)
    await expectError(() => extended.addEntry('exttest', { action: 'permit', protocol: 'ip', src: { address: '1.1.1.0' } as never, dst: { any: true } }), /an address needs either a prefix length or a mask/)
    // Sequence numbers: 0 is legal (probe: upstream's `add_entry(..., seqno=0)` sends `0 permit …`), a negative
    // or fractional one is not.
    await expectError(() => extended.updateEntry('exttest', -1, { action: 'permit', protocol: 'ip', src: { any: true }, dst: { any: true } }), /invalid ACL sequence number -1/)
    await expectError(() => extended.updateEntry('exttest', 1.5, { action: 'permit', protocol: 'ip', src: { any: true }, dst: { any: true } }), /invalid ACL sequence number 1.5/)
    await expectError(() => extended.removeEntry('exttest', '10' as never), /invalid ACL sequence number '10'/)
    // ACL names: empty, padded, control characters, non-strings. Probe: upstream's create('') sends
    // `ip access-list standard ` with a trailing space, which the header grammar cannot read back.
    for (const bad of ['', '   ', ' pad ', 'pad\x07', 5, undefined]) {
      await expectError(() => extended.create(bad as never), /invalid ACL name/)
      await expectError(() => extended.addEntry(bad as never, { action: 'permit', protocol: 'ip', src: { any: true }, dst: { any: true } }), /invalid ACL name/)
    }
    expect(transport.sent()).toEqual([])
    expect(transport.callCount()).toBe(0)
  })

  it('facade verbs read the kind from the switch, then write the right header text', async () => {
    const transport = mockTransport()
      .replies('enable\nshow running-config all', [{}, { output: ACL_FIXTURE }])
      .replies(writeKey(['ip access-list SNMP-EXT', 'no 40', '40 permit ip any any', 'exit']), [{}, {}, {}, {}, {}, {}])
      .replies('enable\nshow running-config all', [{}, { output: ACL_FIXTURE }])
      .replies(writeKey(['no ip access-list SNMP-EXT']), [{}, {}, {}])
      .replies('enable\nshow running-config all', [{}, { output: ACL_FIXTURE }])
      .replies(writeKey(['ip access-list standard ADMIN-STD', 'no 30', 'exit']), [{}, {}, {}, {}, {}])
      .replies('enable\nshow running-config all', [{}, { output: ACL_FIXTURE }])
      .replies(writeKey(['default ip access-list standard ADMIN-STD']), [{}, {}, {}])
    const acls = new Node(transport).acls
    await acls.updateEntry('SNMP-EXT', 40, { action: 'permit', protocol: 'ip', src: { any: true }, dst: { any: true } })
    await acls.deleteAcl('SNMP-EXT')
    await acls.removeEntry('ADMIN-STD', 30)
    await acls.setDefaultAcl('ADMIN-STD')
    expect(transport.sent().map((cmds) => cmds.map(String))).toEqual([
      ['enable', 'show running-config all'],
      ['enable', 'configure terminal', 'ip access-list SNMP-EXT', 'no 40', '40 permit ip any any', 'exit'],
      ['enable', 'show running-config all'],
      ['enable', 'configure terminal', 'no ip access-list SNMP-EXT'],
      ['enable', 'show running-config all'],
      ['enable', 'configure terminal', 'ip access-list standard ADMIN-STD', 'no 30', 'exit'],
      ['enable', 'show running-config all'],
      ['enable', 'configure terminal', 'default ip access-list standard ADMIN-STD'],
    ])
  })

  it('the abstract delete / setDefault on the facade are the kind-reading verbs, not a silent standard', async () => {
    const transport = mockTransport()
      .replies('enable\nshow running-config all', [{}, { output: ACL_FIXTURE }])
      .replies(writeKey(['no ip access-list SNMP-EXT']), [{}, {}, {}])
      .replies(writeKey(['default ip access-list SNMP-EXT']), [{}, {}, {}])
    const acls = new Node(transport).acls
    await acls.delete('SNMP-EXT')
    await acls.setDefault('SNMP-EXT')
    expect(transport.sent().map((cmds) => cmds.map(String))).toEqual([
      ['enable', 'show running-config all'],
      ['enable', 'configure terminal', 'no ip access-list SNMP-EXT'],
      // The second verb re-reads: the write in between dropped the Node memo (DR-026), and the kind has to be
      // known before either header text can be built.
      ['enable', 'show running-config all'],
      ['enable', 'configure terminal', 'default ip access-list SNMP-EXT'],
    ])
    // Upstream would have reached `create_instance`'s fallback here (`:137-142`) and, via `marshall`, whatever
    // class the name happened to map to.
  })

  it('a write against a name the switch does not have is a NotFoundError — probe: AttributeError upstream', async () => {
    const transport = configTransport(ACL_FIXTURE)
    const acls = new Node(transport).acls
    const thrown = await outcome(() => acls.addEntry('unconfigured', { action: 'permit', protocol: 'ip', src: { any: true }, dst: { any: true } }))
    expect(thrown).toBeInstanceOf(NotFoundError)
    expect((thrown as Error).message).toMatch(/the switch has no ACL named 'unconfigured'/)
    expect(transport.sent()).toEqual([['enable', 'show running-config all']])
    // Probe: upstream stores `{name: None}` (`:135`) and then fails its own hasattr test with
    // `'{'unconfigured': None}' object has no attribute 'add_entry'` (`:117-124`).
  })

  it('the ports and option tail a read reports are deliberately not re-emitted by the write verbs (row 164)', async () => {
    // The fixture's entry 10 is `permit tcp host 10.10.0.5 eq 161 host 10.40.0.1 log`. Rewriting that seqno
    // through this module writes the matches it can name — the operator and `options` are read-only fields,
    // because silently dropping them would be worse and emitting them is not a shape this client has pinned
    // against a device. The comment states what the wire does **not** do; §5 row 164 is the record.
    const transport = mockTransport()
      .replies('enable\nshow running-config all', [{}, { output: ACL_FIXTURE }])
      .replies(writeKey(['ip access-list SNMP-EXT', 'no 10', '10 permit tcp host 10.10.0.5 host 10.40.0.1 log', 'exit']), [{}, {}, {}, {}, {}, {}])
    const acls = new Node(transport).acls
    const entry = (await acls.get('SNMP-EXT'))?.entries.get(10)
    expect(entry?.src.operator).toBe('eq 161')
    await acls.updateEntry('SNMP-EXT', 10, { action: 'permit', protocol: 'tcp', src: { host: '10.10.0.5' }, dst: { host: '10.40.0.1' }, log: true })
    expect(transport.sent()[1]?.map(String)).toEqual(['enable', 'configure terminal', 'ip access-list SNMP-EXT', 'no 10', '10 permit tcp host 10.10.0.5 host 10.40.0.1 log', 'exit'])
  })

  it('a device rejection rejects with CommandError including failedCommand (DR-005, no False + .error)', async () => {
    const transport = mockTransport().rejects('permit any', {
        code: EapiErrorCode.COMMAND_INVALID,
        message: "CLI command 4 of 5 'permit any' failed: invalid source address",
      })
    const thrown = await outcome(() => new Node(transport).acls.standard.addEntry('test', { action: 'permit', src: { any: true } }))
    expect(thrown).toBeInstanceOf(CommandError)
    expect((thrown as CommandError).failedCommand).toBe('permit any')
  })
})

describe('ACL wiring and read budget', () => {
  it('the facade and both collections are ONE object per Node (DR-052, and upstream’s _instances)', async () => {
    const { node, transport } = nodeFor(ACL_FIXTURE)
    expect(node.acls).toBeInstanceOf(AclsResource)
    expect(node.acls).toBe(node.acls)
    expect(node.acls).toBe(node.resource('acls'))
    expect(node.acls.standard).toBe(node.acls.standard)
    expect(node.acls.extended).toBe(node.acls.extended)
    await node.acls.standard.getAll()
    await node.acls.extended.getAll()
    await node.acls.getAll()
    // Upstream's `_instances` is keyed by ACL name and rebuilt per class per name (`:126-142`, probe: two
    // entries after a getall of its two-ACL fixture). Here the per-Node registry memo plus two per-kind
    // collections replace that dict, and three collection reads cost one request (DR-026/DR-030).
    expect(transport.callCount()).toBe(1)
  })

  it('a fresh read after a write costs one more request — the cache seam every UI state depends on', async () => {
    const transport = mockTransport()
      .repliesOnce('enable\nshow running-config all', [{}, { output: ACL_FIXTURE }])
      .replies(writeKey(['ip access-list standard NEW-STD', 'exit']), [{}, {}, {}, {}])
      .repliesOnce('enable\nshow running-config all', [{}, { output: textOf(['ip access-list standard NEW-STD', '!', 'end']) }])
      .replies('enable\nconfigure terminal\nip access-list standard NEW-STD', [{}, {}, {}])
    const acls = new Node(transport).acls
    expect(await acls.get('NEW-STD')).toBeUndefined()
    await acls.create('NEW-STD')
    const after = await acls.get('NEW-STD')
    expect(after?.type).toBe('standard')
    expect(after?.entries.size).toBe(0)
    expect(transport.callCount()).toBe(3)
  })

  it('a guard failure never reaches the device, so the UI can render a form error (USAGE.md §7)', async () => {
    const transport = configTransport(ACL_FIXTURE)
    const thrown = await outcome(() => acls_transport(transport).create('bad\x00'))
    expect(thrown).toBeInstanceOf(NotSupportedError)
    expect(transport.callCount()).toBe(0)
  })

  it('a config the ACL grammar cannot parse is a typed error with the section named, not a crash', async () => {
    // `10 permit ip host any any` is an extended rule whose source is the word `host` without an address —
    // upstream reads it as protocol ip / srcaddr any / dstaddr any (probe: its regexes are optional groups,
    // and `match.group(5) or 'any'` covers what the line never said, `:250`/`:253`).
    const thrown = await outcome(() => aclsFor(textOf(['ip access-list bad', '   10 permit ip host any any', '!', 'end'])).getAll())
    expect(thrown).toBeInstanceOf(ConfigParseError)
    expect((thrown as ConfigParseError).sectionKey).toBe('ip access-list bad')
  })
})

/** Small seam: run a verb against an already-built transport. */
function acls_transport(transport: MockTransport): AclsResource {
  return new Node(transport).acls
}
