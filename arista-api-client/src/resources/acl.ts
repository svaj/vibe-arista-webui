/**
 * `acls` — the access-list resources, W2b (#37 #38): the `ip access-list [standard] <name>` sections of
 * the running-config, the two type-pinned collections behind them, and the entry verbs that write inside
 * them. Built on the M7 (#9) framework like every other resource module (`EntityCollection`,
 * `ResourceBase.configSections` / `configure`, `parseBlock`, the DR-026 `Node` memo, the registry).
 *
 * Port of `pyeapi/api/acl.py` (303 lines, BSD-3-Clause, Arista Networks — DR-001). Every `pyeapi` range
 * below was opened in the pinned clone `/home/svaj/development/arista/pyeapi` (1.0.4-rc0, `develop` @
 * `6816d9e`) on 2026-11-05, and every behavioural claim marked **probe** is a run of the real classes over
 * a fake `Node` whose `section()`/`config()` reproduce `client.py:776-798` and `abstract.py:103-127` — not
 * what the docstrings say. Nothing here reads EOS image sources and nothing here claims what the
 * DCS-7050TX-64 accepts: unit tests never reach a device, so every EOS-side rule reads
 * "unverified on hardware, M12 (#14) to capture". `docs/features.md` still carries `Layer 3 access lists`
 * as an open item (its line 175 in this tree), which is the product framing: this module is the client
 * half, the device half is a capture question.
 *
 * | pyeapi (verified refs) | here |
 * |---|---|
 * | `VALID_ACLS = frozenset(['standard','extended'])` (`:52`) | {@link ACL_TYPES} plus the {@link AclType} union, and {@link isAclType} for the runtime half |
 * | `mask_to_prefixlen` (`:55-65`) / `prefixlen_to_mask` (`:68-79`) | {@link maskToPrefixlen} / {@link prefixlenToMask} — exported, because PLAN.md §4's "tightly-coupled helpers to schedule with their wave" line names them with this module |
 * | `Acls(EntityCollection)` (`:82`) with `_instances` (`:84-86`) | {@link AclsResource} — the facade; its `standard` / {@link extended} getters hold one `Node`-bound instance each (the memoised registry row already gives it one per `Node`, DR-052) |
 * | `Acls.get` (`:88-89`): `self.get_instance(name)[name]` | {@link AclsResource.get} — one lookup, no `__getitem__` (DR-004), and no regex interpolation of the name (divergence 5) |
 * | `Acls.getall` (`:91-112`): `re.compile(r'^ip access-list (?:(standard) )?(.+)$', re.M)` (`:104`) over the **whole** config text, then one `get()` per hit, into `{'standard': {}, 'extended': {}}` | {@link AclsResource.getAll} — one pass over the chunked document's indent-0 keys, one read for the whole collection, flat `Map<string, Acl>` whose record carries `type` (DR-068/DR-093) |
 * | `__getattr__` (`:114-115`) + `marshall` (`:117-124`) | **not ported** (DR-006/DR-068, and DR-092 here): the facade's verbs are named methods that resolve the ACL's type and call the right collection |
 * | `get_instance` (`:126-135`, whose `acl_re` interpolates the name into a pattern at `:129-130`) and `create_instance` (`:137-142`, `VALID_ACLS` guard → `'standard'`) | {@link AclsResource.resolveType} (exact section-key match) and the {@link AclsResource.for} memo — an unknown type is a refusal, not a silent standard (divergence 8) |
 * | `Acls.create(self, name, type='standard')` (`:144-149`) | {@link AclsResource.create} with `AclAttrs.type` defaulting to `standard` — same default, same texts |
 * | `StandardAcls` (`:151`), `get` (`:162-168`), `_parse_entries` (`:170-181`), `entry_re` (`:153-160`) | {@link StandardAclsResource} and {@link parseStandardEntry} — an `AclEntry` record, not a stringly dict |
 * | `create/delete/default` (`:183-190`: `ip access-list standard %s` / `no …` / `default …`) | {@link StandardAclsResource.create} / {@link delete} / {@link setDefault} — the same three texts through `commandBuilder` (DR-037) |
 * | `update_entry` (`:192-200`), `add_entry` (`:202-211`), `remove_entry` (`:213-216`) | {@link StandardAclsResource.updateEntry} / {@link addEntry} / {@link removeEntry} — same command texts, one options object instead of six positional params (MIGRATION.md §4) |
 * | `ExtendedAcls` (`:218`) with the same six verbs (`:234-297`) and `entry_re` (`:220-232`) | {@link ExtendedAclsResource} and {@link parseExtendedEntry} |
 * | `ACL_CLASS_MAP` (`:300`) / `instance(node)` (`:302-303`) | the `acls` row in `RESOURCE_FACTORIES` and `Node.acls` (DR-006/DR-052) |
 *
 * ## Upstream's own suite, and what porting it meant
 *
 * `pyeapi/test/unit/test_api_acl.py` — **32** test methods (`grep -c 'def test'` on 2026-11-05, in four
 * classes: `TestApiAclFunctions` `:49-57` (2), `TestApiAcls` `:60-149` (12),
 * `TestApiStandardAcls` `:152-215` (9), `TestApiExtendedAcls` `:218-297` (9)). Note the filename: the
 * brief for this lane cited `test/unit/test_acl.py`, which **does not exist** upstream — the real files are
 * `test_api_acl.py` and `test_api_varp.py`. The spans above are from the real file (verified by opening it).
 *
 * Ported as behaviour, not shape-for-shape, because several upstream assertions pin answers this client
 * refuses to give:
 *  - `test_mask_to_prefixlen` (`:50-52`) / `test_prefixlen_to_mask` (`:54-57`) — ported verbatim
 *    (`255.255.255.0` → `24`, `24` → `'255.255.255.0'`) and extended with the netaddr behaviour the two
 *    helpers actually have (`0.0.0.255` → `32`, `'255.0.255.0'` → `32`, `'0.0.0.0'` → `0`,
 *    `'32'`-as-a-mask and `'banana'` → a `NotSupportedError` instead of `netaddr.AddrFormatError`) —
 *    divergences 1 and 2.
 *  - `test_instance` (`:66-68`) — the registry row + `Node.acls` pin the same thing.
 *  - `test_getall` (`:70-75`), `test_get` (`:80-83`), `test_get_not_configured` (`:77-78`) — the nested
 *    `{'standard','extended'}` dict becomes a flat `Map` keyed by name with `type` on the record
 *    (DR-093); `None` becomes `undefined` (DR-027).
 *  - `test_get_instance` (`:85-96`), `test_create_instance_standard`/`_extended` (`:98-105`) — the class
 *    identity they assert (`StandardAcls` vs `ExtendedAcls`) is the `type` field plus the two named
 *    accessors; the `_instances` count they assert is the memo this facade keeps per **type**, not per
 *    name (divergence 5's other half).
 *  - `test_create_standard` (`:107-110`), `test_create_extended` (`:112-115`) — both texts pinned verbatim
 *    (`ip access-list test` for the extended form, `ip access-list standard test` for the default).
 *  - `test_create_unknown_type_creates_standard` (`:117-120`) — **not** ported as a passing behaviour:
 *    probe-confirmed `create('test', 'unknown')` sends `ip access-list standard test`, and
 *    `create_instance('x', 'banana')` returns a `StandardAcls` (probe). A typo'd kind silently writing the
 *    *other* kind of ACL is a config write the operator did not ask for, so this is a refusal with an
 *    asserted test (divergence 8) — the widened-guard pattern rows 73/76 record.
 *  - `test_proxy_method_success` (`:122-124`) and `test_proxy_method_raises_attribute_error` (`:126-129`)
 *    — the dynamic half of the facade, not ported (DR-006/DR-068/DR-092). Their intent is kept two ways:
 *    the named facade verbs below, and a test that a name the switch does not have is a `NotFoundError`
 *    rather than upstream's `AttributeError` (probe: `'<StandardAcls object>' object has no attribute
 *    'nonmethod'`, and `add_entry` on an unconfigured ACL raises
 *    `'{'unconfigured': None}' object has no attribute 'add_entry'`).
 *  - every command text in `TestApiStandardAcls.test_acl_functions` (`:166-173`),
 *    `test_update_entry`/`_no_log` (`:175-185`), `test_add_entry`/`_no_log`/`_with_seqno` (`:187-203`),
 *    `test_remove_entry` (`:183-185` region) and the mirrored `TestApiExtendedAcls` cases
 *    (`:232-239`, `:241-251`, `:253-269`) is reproduced **verbatim** below, including `no <seq>` ahead of
 *    the replacement line and the trailing `exit`.
 *  - `TestApiExtendedAcls.test_get` (`:221-230`) asserts the two fixture entries **field by field**,
 *    `srclen: None` next to `srclen: '24'` and `other: 'urg ttl eq 24 fragments tracked log'`. That test
 *    is the evidence for divergence 1: this module reads the same lines as an `AclMatch` record with
 *    `prefixlen?: number` and an `options` remainder, and the numbers are numbers.
 *
 * ## Divergences this file owns (raw material for MIGRATION.md §5; rows 158-166 are this lane's band)
 *
 * 1. **`srclen`/`dstlen` mixed types become `AclMatch.prefixlen: number | undefined`.** Upstream stores the
 *    source length as **whatever produced it**: a `/<NN>` capture is a string (`'24'`, `'8'`) while a mask
 *    conversion is an `int` (`32`, `16`) — probe over its own fixture: entry 10 (`host 1.2.3.4`) answers
 *    `srclen 32` (int), entry 40 (`5.6.7.0/24`) answers `srclen '24'` (string), entries 20
 *    (`1.2.3.4 255.255.0.0`) answers `16` and `10 permit tcp host 1.1.1.1 …` answers `srclen None`.
 *    `srclen` is never a number you can compare, and `None` means "the line said `host`/`any`", which is a
 *    different fact from "the line said nothing". Here the *how the line wrote it* distinction is
 *    `AclMatch.kind` (`any` / `host` / `address`) and `prefixlen` is a `number` or absent (row 158).
 * 2. **a standard-ACL wildcard mask is kept as written, never converted.** EOS writes standard sources as
 *    `<addr> <wildcard>` (`20 permit 10.20.0.0 0.0.255.255`), and upstream runs that second token through
 *    `mask_to_prefixlen` (`:178`), which counts **netmask** bits — probe: `0.0.0.255` → `32`,
 *    `0.255.255.255` → `32`, `1.2.3.4` → `32`. So a /24-wildcard source reads back as a single host, and
 *    `255.255.0.0` reads as `16` (the fixture's `20 permit 1.2.3.4 255.255.0.0`,
 *    `test/fixtures/running_config.text:2014`). Here the wildcard token is kept verbatim in
 *    `AclMatch.mask` and the conversion helpers are **never** used by the parser (row 159).
 * 3. **`any` is not a host.** Upstream's standard parser throws the `any` marker away:
 *    `entry['srcaddr'] = ip or '0.0.0.0'` and `entry['srclen'] = mlen or mask_to_prefixlen(mask)`
 *    (`:176-177`), so `30 deny any` answers `{srcaddr: '0.0.0.0', srclen: 32}` — a `/32`, i.e. one host —
 *    and `60 permit any log` the same. Here `kind: 'any'` with no address, and `host <addr>` keeps its
 *    marker (`kind: 'host'`), which upstream also discards (probe: `10 permit host 1.2.3.4 log` answers
 *    `srcaddr 1.2.3.4, srclen 32`, identical to a bare address).
 * 4. **the entry line must *start* at the rule.** Upstream finds rules with
 *    `re.finditer(r'\d+ [p|d].*$', config, re.M)` (`:171`, `:243`) — unanchored, and `[p|d]` is the
 *    character class `p`, `|`, `d`. So any line *containing* `<digits> <p…|d…|…>` becomes a rule: probe —
 *    `description matches 1500 permit everything` inside an extended ACL adds the entry
 *    `{"1500": {action: 'permit', protocol: 'everything', srcaddr: 'any', …}}`, and in a standard ACL
 *    `name 20 permit me` adds `{"20": {action: 'permit', srcaddr: '0.0.0.0', srclen: 32}}`. Here a rule is a
 *    body line whose **first** token is a decimal sequence number (row 160).
 * 5. **names are looked up by equality, not as patterns.** Upstream builds a regex out of the caller's ACL
 *    name in `get_instance` (`:129-130`) and passes `%s` into `get_block` the same way (`:163`, `:183`,
 *    `abstract.py:98`), which the M6 `getBlock` contract deliberately keeps **as written** for a parent
 *    string — but a facade `get()` then indexes the answer with the caller's string anyway. Probe:
 *    with only `ip access-list standard stdname` in the config, `get('std.*')` returns a complete record
 *    whose `name` is `'std.*'` — an ACL the switch does not have, with the requested spelling stamped onto
 *    it — and `get_block('ip access-list has.space')` matches the section named `has space`
 *    (`.` matches a character). Here the section key has to equal `ip access-list <name>` or
 *    `ip access-list standard <name>`, and {@link assertAclName} refuses a write-side name with whitespace
 *    or a control character (row 160).
 * 6. **an unparseable rule is reported, by both kinds.** Upstream's extended parser guards with
 *    `if match:` (`:244-245`) while the standard one does not (`:172-173`, `match.groups()` on `None`):
 *    probe — a block with `10 p` answers `{}` from `ExtendedAcls.get` and raises
 *    `AttributeError: 'NoneType' object has no attribute 'groups'` from `StandardAcls.get`. And upstream
 *    *invents* the missing half of an extended rule: `match.group(5) or 'any'` / `group(9) or 'any'`
 *    (`:249`, `:252`), so `10 permit tcp any` answers `dstaddr: 'any'` for a line with no destination.
 *    Here a body line that starts with a sequence number is a rule, and a rule the grammar cannot read is a
 *    `ConfigParseError` naming the section and the line — for both kinds (row 161).
 * 7. **duplicate sequence numbers are a parse failure, not a silent overwrite.** Rules go into a `dict`
 *    keyed by seqno upstream, so a second rule with the same number **replaces** the first: probe over
 *    `10 permit ip any any` / `20 permit tcp any any eq 80` / `10 deny ip any any log` answers **two**
 *    entries, `10` being the `deny`, and the first rule vanishes from the answer while the switch still has
 *    it. Here the same text is a `ConfigParseError` (row 162), because an ACL table that quietly drops a
 *    rule is the failure mode an operator cannot review.
 * 8. **an unknown ACL type is refused.** Upstream falls back to `standard`: `create_instance` (`:137-142`)
 *    maps anything outside `VALID_ACLS` to `StandardAcls`, its own test pins that
 *    (`test_create_unknown_type_creates_standard`, `:117-120`), and probe confirms `create('test',
 *    'unknown')` → `['ip access-list standard test']`. Here `{ type: 'unknown' }` is a `NotSupportedError`
 *    naming it (row 163) — the deliberate-widening convention, guard asserted rather than inherited.
 * 9. **the write surface renders the spellings the device itself writes, and refuses the ones upstream
 *    interpolates as `None`.** Upstream's entry verbs format whatever arrives: probe —
 *    `add_entry('x','permit','ip','any',None,'1.1.1.2',None)` sends
 *    `['ip access-list x', 'permit ip any/None 1.1.1.2/None', 'exit']` and the standard form sends
 *    `permit any/None`. The `/None` text cannot be an IPv4 prefix length, and it is the exact value a
 *    *read* of `host …`/`any` produced, so upstream cannot round-trip its own read model. Here
 *    {@link AclMatchInput} has four arms (`any`, `host <addr>`, `<addr>/<len>`, `<addr> <mask>`), which
 *    reproduce texts seen in device-written ACL blocks (pyeapi's fixture at
 *    `test/fixtures/running_config.text:2013-2018` and the committed `acl-sections.conf`), and a value that
 *    fits no arm is refused with the field named (row 164). The arms upstream could not express at all are
 *    still not writable here: port operators (`eq 161`) and the option tail (`ttl eq 1 tracked`) are read
 *    into `operator`/`options` and deliberately **not** re-emitted by these verbs.
 * 10. **`log` is one field, on both kinds.** Upstream models `log` for standard entries (`:179`) but not
 *    for extended ones, where the word lands in the `other` catch-all (probe: entry 60
 *    `deny ip any any log` answers `other: 'log'`, as does entry 10). Here a trailing `log` token sets
 *    {@link AclEntry.log} on both kinds and is lifted **out of** {@link AclEntry.options}, so the record
 *    does not repeat a token its own write verb re-emits (row 165). Every other option word stays verbatim:
 *    only a standalone trailing `log` is lifted, so `fragments tracked log` answers
 *    `log: true` plus `options: 'fragments tracked'`.
 * 11. **IPv6 has no surface here.** acl.py has none (`ip access-list` at indent 0, `:104`/`:129`), so this
 *    module reads and writes none; an `ipv6 access-list …` section is not an ACL row in this client. The
 *    `docs/features.md` IPv6 items stay open and unimplemented — inventing an `ipv6` verb is a device
 *    question (DR-032, and the M11 #13/M12 #14 capture lanes own what 4.28.13.1M actually writes).
 *
 * ## What is NOT claimed
 *
 * Whether EOS accepts `0.0.0.0/32`-style standard sources (the form upstream's own tests pin), whether it
 * accepts a mask arm written `<addr> <mask>`, what it writes for an ACL with `description`-like lines, and
 * whether `ip access-list standard` and `ip access-list` names share one namespace on this SKU are all
 * **unverified on hardware, M12 (#14) to capture**. The fixtures under
 * `test/fixtures/config/acl-sections.conf` are hand-authored per that directory's
 * `manifest.json.provenance` (`deviceVerified: false`) — modelled on the shapes in pyeapi's own
 * `test/fixtures/running_config.text`, which is itself vendor test data, not a capture.
 */

import { ConfigParseError, NotFoundError, NotSupportedError } from '../errors'
import { pythonRepr } from '../internal/wire'
import { parseBlock } from '../config/text'
import { EntityCollection } from './base'
import { commandBuilder, submodeCommands } from './command-builder'
import type { Node } from '../command-layer'
import type { ConfigLine } from '../config/text'
import type { ConfigSections } from '../config/chunk'
import type { ResourceTable } from './types'

/** The two ACL kinds EOS names in a section header (`VALID_ACLS`, `acl.py:52`). */
export type AclType = 'standard' | 'extended'

/** The kinds in wire order, for the guard's message — mirrors `VALID_ACLS` (`acl.py:52`). */
export const ACL_TYPES: readonly AclType[] = ['standard', 'extended']

/** Runtime half of {@link AclType}: a `string` from a table column or a decoded form is not a kind. */
export function isAclType(value: unknown): value is AclType {
  return ACL_TYPES.includes(value as AclType)
}

/** The two rule actions. Upstream's `[p|d]\w+` (`:155`, `:222`) accepts far more than this (divergence 4). */
export type AclAction = 'permit' | 'deny'

/** The actions in message order. */
const ACL_ACTIONS: readonly AclAction[] = ['permit', 'deny']

/**
 * How one side of a rule was **written**. Upstream collapses this distinction: the `host` marker is
 * captured then dropped (`:157`/`:161`, unused in `_parse_entries`), a missing source becomes
 * `'0.0.0.0'` + `srclen 32` (`:176-177`), and an extended destination that the line does not contain
 * becomes `'any'` (`:249`/`:252`). `kind` is the half of the line that carries meaning, and
 * {@link AclMatch.mask} keeps the rest (divergences 2 and 3).
 */
export type AclMatchKind = 'any' | 'host' | 'address'

/** One side of a rule: `any`, `host <addr>`, or `<addr>` with a prefix length or a mask, plus an operator. */
export interface AclMatch {
  /** Which spelling the line used — the distinction upstream throws away. */
  readonly kind: AclMatchKind
  /** The dotted-quad the line carries, absent for `any`. */
  readonly address?: string
  /** A `/<NN>` written with the address, as a number (upstream answers a string here — divergence 1). */
  readonly prefixlen?: number
  /**
   * A bare dotted-quad written **after** the address — the standard-ACL wildcard form
   * (`permit 10.20.0.0 0.0.255.255`) — kept exactly as the switch wrote it, never converted (divergence 2).
   */
  readonly mask?: string
  /** A port operator pair (`eq 161`, `neq snmp`, `range 1024 2048`), extended only. */
  readonly operator?: string
}

/**
 * One rule inside an ACL, keyed in {@link Acl.entries} by its own {@link seqno}.
 *
 * `protocol`/`dst` are extended-only and `mask`/`operator` follow the kind that can carry them;
 * DR-068's rule (per-kind **fields**, never per-kind objects) is why one record answers both kinds, with
 * {@link Acl.type} saying which fields to expect.
 */
export interface AclEntry {
  /** The sequence number the line starts with — as written, not renumbered (row 166). */
  readonly seqno: number
  /** `permit` or `deny`. */
  readonly action: AclAction
  /** The source match; `mask` only ever appears on a standard rule. */
  readonly src: AclMatch
  /** The protocol token (`ip`, `tcp`, `udp`, `icmp`, or a decimal), extended only. */
  readonly protocol?: string
  /** The destination match, extended only. */
  readonly dst?: AclMatch
  /**
   * The trailing `log` token. Upstream sets it only for standard entries (`:179`) and buries it in
   * `other` for extended ones — here it is one field on both kinds, while an extended entry's
   * {@link options} still shows the word as written (divergence 10).
   */
  readonly log?: boolean
  /**
   * The tokens after the last match, verbatim — `ttl eq 1 tracked log`, `fragments`, or whatever the
   * switch wrote that this model does not name. Upstream calls the same thing `other`
   * (`:256`, `match.group(13)`) for extended entries and **drops** it for standard ones (probe:
   * `1 permit host 1.2.3.4 extra junk` answers no `other`, no `log`, and loses `extra junk`).
   */
  readonly options?: string
}

/** One access list as this client reads it. */
export interface Acl {
  /** The name the section header carries — everything after `ip access-list [standard] `. */
  readonly name: string
  /** Which kind the header names: `standard` only when the header literally writes `standard `. */
  readonly type: AclType
  /** The rules, in **device document order** — the order the lines appear in the block. */
  readonly entries: ReadonlyMap<number, AclEntry>
}

/**
 * What {@link AclsResource.create} may say about the new ACL. A type **alias**, not an interface, for the
 * same reason `VlanAttrs` is: `EntityCollection`'s attribute parameter is constrained to
 * `ResourceAttrs` (`types.ts:67`), and only an object-type literal gets the implicit index signature.
 *
 * Upstream's `create(self, name, type='standard')` (`:144`) takes the kind as a positional argument;
 * MIGRATION.md §4 moves it into an options object, and the default is the same `standard`.
 */
export type AclAttrs = {
  /** Which kind to create. Defaults to `standard`, as `acl.py:144` does. */
  readonly type?: AclType
}

/** A rule to write. `protocol` and `dst` are required for extended ACLs and refused for standard ones. */
export interface AclEntryInput {
  /** `permit` or `deny`. */
  readonly action: AclAction
  /** The source. */
  readonly src: AclMatchInput
  /** The protocol token — extended ACLs only. */
  readonly protocol?: string
  /** The destination — required for extended ACLs, refused for standard ones. */
  readonly dst?: AclMatchInput
  /** Append the `log` token. Upstream's `log=False` keyword default, `:192`/`:202`/`:269`/`:281`. */
  readonly log?: boolean
  /**
   * The sequence number to give the rule. Absent means the line carries none, which is what upstream's
   * `seqno=None` default does (`:204`, `:285`) — the **device** picks the number (there is no
   * client-side numbering anywhere in acl.py).
   */
  readonly seqno?: number
}

/** One side of a rule being written. See this module's header for the four spellings and why (divergence 9). */
export type AclMatchInput =
  | { readonly any: true }
  | { readonly host: string }
  | { readonly address: string; readonly prefixlen: number }
  | { readonly address: string; readonly mask: string }

/** A parsed section header: which kind, and the name it carries. */
type AclHeader = { readonly type: AclType; readonly name: string }

/**
 * The section header grammar, at pyeapi's own charset: `^ip access-list (?:(standard) )?(.+)$`
 * (`:104`/`:129`). Applied to **section keys**, not to the whole config text — the `getall` over-match
 * upstream pays for with a `get_block` per hit is what divergence 4/5's key lookup replaces. A key of
 * `ip access-list standard` (no name) is not an ACL section, which is also upstream's answer
 * (`(standard) ` needs the space, `(.+)` needs a character).
 */
const ACL_HEADER = /^ip access-list (?:(standard) )?(.+)$/u

/** A rule line's first token — the sequence number. Upstream's `(\d+)` (**:154**, **:221**). */
const SEQ_TOKEN = /^[0-9]+$/u

/** A protocol token: `ip`, `tcp`, `udp`, `icmp`, … or a decimal protocol number. Upstream's `(\w+|\d+)` (`:223`). */
const PROTOCOL_TOKEN = /^[A-Za-z0-9]+$/u

/** The port operators EOS writes between a match and its port (`eq|gt|lt|neq|range`, upstream `:227`/`:230`). */
const PORT_OPERATORS: readonly string[] = ['eq', 'gt', 'lt', 'neq', 'range']

/** A dotted-quad IPv4 address, each octet 0-255. Refuses `1.2.3` and `1.2.3.4.5`, which upstream's regexes accept as *some* group. */
const IPV4 = /^(?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])(?:\.(?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])){3}$/u

/** `<addr>/<len>` as one token — upstream reads the prefix with `(/([0-9]{1,2}))?` (`:158`, `:225`), so `33` parses there and is refused here. */
const ADDRESS_PREFIX = /^(\d{1,3}(?:\.\d{1,3}){3})\/([0-9]{1,3})$/u

/** The word that ends a standard rule, upstream `(?: (log))?` (`:160`). */
const LOG_TOKEN = 'log'

/** IPv4's own width — not an EOS claim, and the same bound netaddr's `width` uses in `netmask_bits`. */
const IPV4_BITS = 32

/** `1.2.3.4` → the 32-bit value. Assumes {@link IPV4} already passed. */
function ipv4ToBits(value: string): number {
  let bits = 0
  for (const octet of value.split('.')) bits = bits * 256 + Number(octet)
  return bits
}

/** A bit count as a dotted quad. Assumes `0 <= count <= 32`. */
function bitsToIpv4(bits: number): string {
  const value = bits === 0 ? 0 : (2 ** 32 - 1) << (32 - bits) >>> 0
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.')
}

/** A rejected caller argument, named the way `validators.ts` names one (DR-053's `refuse` shape). */
function refuse(label: string, value: unknown, because: string): never {
  throw new NotSupportedError(`acls: invalid ${label} ${pythonRepr(value)} — ${because}`, { cause: value })
}

/** A device line this client cannot model. Upstream crashes or invents (divergences 4-7). */
function cannotParse(sectionKey: string, line: string, because: string): never {
  throw new ConfigParseError(
    `acls: cannot read the rule ${pythonRepr(line)} in ${pythonRepr(sectionKey)} — ${because}`,
    { sectionKey, shortLine: line },
  )
}

/**
 * Convert a dotted-quad mask to a prefix length — pyeapi's `mask_to_prefixlen` (`:55-65`), which is
 * `netaddr.IPAddress(mask).netmask_bits()`.
 *
 * The **semantics** are netaddr's, verified by reading it (`netaddr 1.3.0`, and the same rule in the
 * versions pyeapi pins): a value whose 1-bits are contiguous from the top is its own bit count
 * (`255.255.255.0` → 24), all-zeros is 0, and **anything else is 32** — probe: `255.0.255.0` → 32,
 * `0.0.0.255` → 32, `0.255.255.255` → 32, `1.2.3.4` → 32. That last group is why this helper is exported
 * but never used by the parser: a standard ACL writes **wildcards**, and this function answers `32` for
 * every one of them (divergence 2, row 159).
 *
 * `undefined` and `''` fall back to `255.255.255.255` → 32, as upstream's `mask = mask or …` (`:63`) does
 * for `None`/empty (probe). A token that is not an IPv4 address is a {@link NotSupportedError} naming it —
 * upstream pays `netaddr.AddrFormatError: failed to detect a valid IP address from '32'` (probe), a foreign
 * exception class this taxonomy has no place for (DR-005/DR-010: no new error classes).
 */
export function maskToPrefixlen(mask: string | undefined): number {
  const value = mask === undefined || mask === '' ? '255.255.255.255' : mask
  if (typeof value !== 'string' || !IPV4.test(value)) {
    refuse('subnet mask', value, 'expected a dotted-quad IPv4 mask (pyeapi hands this string to netaddr, which raises AddrFormatError — acl.py:55-65)')
  }
  const bits = ipv4ToBits(value)
  if (bits === 0) return 0
  // `is_netmask()`: the 1s must be a contiguous run starting at the top bit — netaddr's own test.
  const inverted = (~bits >>> 0) & 0xff_ff_ff_ff
  if ((inverted + 1) & inverted) {
    // Not a valid netmask: netaddr returns the address width, and probe confirms 32 for 255.0.255.0.
    return IPV4_BITS
  }
  let ones = 0
  for (let bit = 0x8000_0000; bit >>> 0 !== 0; bit >>>= 1) {
    if ((bits & bit) === 0) break
    ones += 1
  }
  return ones
}

/**
 * Convert a prefix length to a dotted-quad mask — pyeapi's `prefixlen_to_mask` (`:68-79`), which is
 * `str(netaddr.IPNetwork('0.0.0.0/%s' % prefixlen).netmask)`.
 *
 * Two upstream facts worth pinning, both probe-confirmed: `undefined`/`''` fall back to
 * `'255.255.255.255'` (its `prefixlen = prefixlen or '32'` at `:76`), **and** a numeric `0` falls back the
 * same way because Python's `or` treats 0 as false — so upstream answers `'255.255.255.255'` for `0` and
 * `'0.0.0.0'` for `'0'`. Here `0` is `0.0.0.0` and only `undefined`/`''` take the default (row 159).
 * Out-of-range or non-integral lengths (`33`, `-1`, `'30.5'`, `'banana'`) are refusals rather than
 * `netaddr.AddrFormatError: invalid IPNetwork 0.0.0.0/33` (probe).
 */
export function prefixlenToMask(prefixlen: string | number | undefined): string {
  // `prefixlen = prefixlen or '32'` (`:76`): the empty string and None take the /32 default, and so does
  // the number 0 — the divergence row says why 0 is not treated that way here.
  if (prefixlen === undefined || (typeof prefixlen === 'string' && prefixlen.trim() === '')) return bitsToIpv4(IPV4_BITS)
  const length = typeof prefixlen === 'number' ? prefixlen : Number(prefixlen)
  if (!Number.isSafeInteger(length) || length < 0 || length > IPV4_BITS) {
    refuse('prefix length', prefixlen, `expected an integer prefix length 0..${String(IPV4_BITS)} (pyeapi interpolates anything into '0.0.0.0/%s' for netaddr to reject — probe: 33, -1, '30.5' and 'banana' all raise AddrFormatError, acl.py:68-79)`)
  }
  return bitsToIpv4(length)
}

/** Refuse an ACL name a section key could not carry. */
function assertAclName(value: unknown): asserts value is string {
  if (typeof value !== 'string') refuse('ACL name', value, 'expected a string ACL name — pyeapi interpolates whatever arrives into the command (acl.py:164, :183, :186, :189), and probe-confirmed create("") sends `ip access-list standard ` with a trailing space')
  if (value.trim() === '') refuse('ACL name', value, 'an empty ACL name is refused — `ip access-list standard ` is a command line this client cannot read back as an ACL (the header grammar needs one character after the kind, acl.py:104)')
  if (value !== value.trim()) refuse('ACL name', value, 'leading or trailing whitespace cannot read back: a section key is the rstripped line (client.py:741-747) and the name is the header remainder (acl.py:104)')
  // Inner whitespace stays legal: upstream creates such an ACL (probe: `create('has space')` sends
  // `ip access-list standard has space`) and reads it back as the same section key, so refusing it here
  // would make a name this client can report unmanageable.
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) refuse('ACL name', value, 'a control character would break the config line this client reads back (the same reason command-builder.ts refuses a value with a line boundary, MIGRATION.md §5 row 74)')
  }
}

/** Refuse a sequence number the read model could not key (divergence 7's grammar is the bound). */
function assertAclSeqno(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    refuse('ACL sequence number', value, 'expected a non-negative safe integer — the read side keys rules by the decimal a line starts with (acl.py:154, :221), and upstream interpolates anything: probe `add_entry(…, 0)` sends `0 permit 0.0.0.0/32` and a string seqno would send whatever it spells')
  }
}

/** Refuse an action outside the two ACL actions. */
function assertAclAction(value: unknown): asserts value is AclAction {
  if (!ACL_ACTIONS.includes(value as AclAction)) {
    refuse('ACL action', value, `expected one of ${ACL_ACTIONS.join(' / ')} — upstream's rule regex is the class [p|d] followed by any word (acl.py:155, :222), so it would accept "pwn" and send it`)
  }
}

/** Refuse a protocol token that is not one word. */
function assertAclProtocol(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !PROTOCOL_TOKEN.test(value)) {
    refuse('ACL protocol', value, 'expected one token such as ip / tcp / udp / icmp / 47 — the extended regex reads a single \\w+ word (acl.py:223)')
  }
}

/** Refuse an IPv4-shaped argument (address, host or mask) that is not a dotted quad. */
function assertIpv4(label: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || !IPV4.test(value)) {
    refuse(label, value, 'expected a dotted-quad IPv4 address (each octet 0..255) — pyeapi checks nothing here: it interpolates the token straight into the rule text (acl.py:199, :210, :277, :291)')
  }
}

/** Refuse a prefix length outside IPv4's own width. */
function assertPrefixlen(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > IPV4_BITS) {
    refuse('ACL prefix length', value, `expected an integer 0..${String(IPV4_BITS)} — upstream reads [0-9]{1,2}, so a rule written /33 parses there and answers the string '33' (probe, acl.py:158, :225)`)
  }
}

/** Which arm of {@link AclMatchInput} arrived, and what to write for it. */
function renderMatch(label: string, match: AclMatchInput, allowMask: boolean): string {
  if (typeof match !== 'object' || match === null) {
    refuse(`${label} match`, match, 'expected one of { any: true } / { host } / { address, prefixlen } / { address, mask } — pyeapi takes two positional values and formats None into the command (probe: `permit ip any/None 1.1.1.2/None`, acl.py:281-292)')
  }
  const bag = match as Record<string, unknown>
  if (bag['any'] === true) return 'any'
  if (bag['host'] !== undefined) {
    assertIpv4(`${label} host address`, bag['host'])
    return `host ${bag['host']}`
  }
  if (bag['address'] !== undefined) {
    assertIpv4(`${label} address`, bag['address'])
    if (bag['prefixlen'] !== undefined) {
      assertPrefixlen(bag['prefixlen'])
      return `${bag['address']}/${String(bag['prefixlen'])}`
    }
    if (bag['mask'] !== undefined) {
      if (!allowMask) {
        refuse(`${label} mask`, bag['mask'], 'the `<address> <mask>` arm is a standard-ACL spelling — upstream reads bare quads on the extended side as the **destination** instead (probe: `permit icmp 3.3.3.0 0.0.0.255 any` answers 0.0.0.255 as dstaddr, acl.py:225-230)')
      }
      assertIpv4(`${label} mask`, bag['mask'])
      return `${bag['address']} ${bag['mask']}`
    }
    refuse(`${label} match`, match, `an address needs either a prefix length or a mask — upstream formats the missing one as the string None (probe: \`permit any/None\`, acl.py:207)`)
  }
  refuse(`${label} match`, match, 'expected one of { any: true } / { host } / { address, prefixlen } / { address, mask }')
}

/** One rule line, without the leading sequence number that {@link entryCommand} may prepend. */
function renderEntryBody(type: AclType, entry: AclEntryInput): string {
  assertAclAction(entry.action)
  const parts: string[] = [entry.action]
  if (type === 'extended') {
    assertAclProtocol(entry.protocol)
    parts.push(entry.protocol)
  } else if (entry.protocol !== undefined) {
    refuse('ACL protocol', entry.protocol, 'a standard ACL rule has no protocol field — upstream would format it into the line anyway and the device would decide (acl.py:202-211)')
  }
  parts.push(renderMatch('source', entry.src, type === 'standard'))
  if (type === 'extended') {
    if (entry.dst === undefined) {
      refuse('destination', entry.dst, 'an extended ACL rule needs a destination — upstream defaults it to the string undefined/None in TS terms and to `None` in its own text (probe: `permit ip any any/None`, acl.py:281-292), and its **reader** invents `any` for a line that omits one (acl.py:252)')
    }
    parts.push(renderMatch('destination', entry.dst, false))
  } else if (entry.dst !== undefined) {
    refuse('ACL destination', entry.dst, 'a standard ACL rule has no destination field')
  }
  if (entry.log === true) parts.push(LOG_TOKEN)
  return parts.join(' ')
}

/** The rule line as it goes on the wire: `[<seqno> ]<body>` (upstream `:206-209`, `:288-292`). */
function entryCommand(type: AclType, entry: AclEntryInput): string {
  const body = renderEntryBody(type, entry)
  if (entry.seqno === undefined) return body
  assertAclSeqno(entry.seqno)
  return `${String(entry.seqno)} ${body}`
}

/** The header line for one ACL of one kind — the text upstream builds at `:184`, `:261`. */
function aclStem(type: AclType, name: string): string {
  return type === 'standard' ? `ip access-list standard ${name}` : `ip access-list ${name}`
}

/** A dotted quad, possibly with `/len` glued on, read from a rule line. */
function readAddress(token: string, sectionKey: string, line: string): { readonly match: AclMatch } {
  const combined = ADDRESS_PREFIX.exec(token)
  if (combined?.[1] !== undefined && combined[2] !== undefined) {
    if (!IPV4.test(combined[1])) cannotParse(sectionKey, line, `the address ${pythonRepr(combined[1])} is not a dotted quad`)
    const length = Number(combined[2])
    if (!Number.isSafeInteger(length) || length < 0 || length > IPV4_BITS) {
      cannotParse(sectionKey, line, `the prefix length ${combined[2]} is outside 0..${String(IPV4_BITS)} — upstream keeps this string as it was written (probe: a rule ending \`5.6.7.0/33\` answers srclen '33', acl.py:158)`)
    }
    return { match: { kind: 'address', address: combined[1], prefixlen: length } }
  }
  if (!IPV4.test(token)) cannotParse(sectionKey, line, `${pythonRepr(token)} is neither \`any\`, \`host <address>\` nor a dotted quad`)
  return { match: { kind: 'address', address: token } }
}

/** Read one side of a rule, and report where the next token starts. */
function readMatch(tokens: readonly string[], index: number, options: { readonly allowMask: boolean; readonly allowOperator: boolean }, sectionKey: string, line: string): { readonly match: AclMatch; readonly next: number } {
  const token = tokens[index]
  if (token === undefined) cannotParse(sectionKey, line, options.allowOperator ? 'an extended rule needs a source and a destination' : 'the rule carries no source')
  if (token === 'any') return { match: { kind: 'any' }, next: index + 1 }
  if (token === 'host') {
    const address = tokens[index + 1]
    if (address === undefined || !IPV4.test(address)) cannotParse(sectionKey, line, `\`host\` needs a dotted-quad address (upstream reads the marker and then drops it, acl.py:157, :161)`)
    const match: AclMatch = { kind: 'host', address }
    const operator = readOperator(tokens, index + 2, options, sectionKey, line)
    return operator === undefined ? { match, next: index + 2 } : { match: { ...match, operator: operator.operator }, next: operator.next }
  }
  const read = readAddress(token, sectionKey, line)
  let next = index + 1
  let match = read.match
  const operator = readOperator(tokens, next, options, sectionKey, line)
  if (operator !== undefined) {
    match = { ...match, operator: operator.operator }
    next = operator.next
  } else if (options.allowMask) {
    const mask = tokens[next]
    if (mask !== undefined && IPV4.test(mask)) {
      // The standard-ACL wildcard spelling. Kept verbatim: `mask_to_prefixlen` would answer 32 for
      // 0.0.255.255 and call the source a single host (divergence 2).
      match = { ...match, mask }
      next += 1
    }
  }
  return { match, next }
}

/** `eq 161` / `neq snmp` / `range 1024 2048` — upstream's `((?:eq|gt|lt|neq|range) [\w-]+)` (`:227`, `:230`). */
function readOperator(tokens: readonly string[], index: number, options: { readonly allowOperator: boolean }, sectionKey: string, line: string): { readonly operator: string; readonly next: number } | undefined {
  if (!options.allowOperator) return undefined
  const keyword = tokens[index]
  if (keyword === undefined || !PORT_OPERATORS.includes(keyword)) return undefined
  const operand = tokens[index + 1]
  if (operand === undefined || !/^[\w-]+$/u.test(operand)) cannotParse(sectionKey, line, `the port operator ${pythonRepr(keyword)} needs one operand (upstream's regex requires [\\w-]+ and would end the match before an empty one, acl.py:227)`)
  if (keyword === 'range') {
    const second = tokens[index + 2]
    if (second === undefined || !/^[\w-]+$/u.test(second)) cannotParse(sectionKey, line, 'the `range` operator needs two ports')
    return { operator: `${keyword} ${operand} ${second}`, next: index + 3 }
  }
  return { operator: `${keyword} ${operand}`, next: index + 2 }
}

/** Split a section's body into rules, in document order (upstream `:170-181`, `:242-258`). */
function parseEntries(lines: readonly ConfigLine[], sectionKey: string, type: AclType): Map<number, AclEntry> {
  const entries = new Map<number, AclEntry>()
  for (const line of lines) {
    const tokens = line.text.split(/\s+/u)
    const first = tokens[0] ?? ''
    if (!SEQ_TOKEN.test(first)) continue
    const seqno = Number(first)
    if (!Number.isSafeInteger(seqno)) {
      cannotParse(sectionKey, line.text, `the sequence number ${first} has more digits than this client can key a rule by — upstream keys its dict with Python's unbounded int (acl.py:170-181)`)
    }
    if (entries.has(seqno)) {
      cannotParse(sectionKey, line.text, `the sequence number ${String(seqno)} appears more than once — upstream's rule dict silently keeps the LAST one and drops the earlier rule from its answer entirely (probe: three lines with 10/20/10 answer two entries)`)
    }
    entries.set(seqno, type === 'standard' ? parseStandardEntry(tokens, sectionKey, line.text, seqno) : parseExtendedEntry(tokens, sectionKey, line.text, seqno))
  }
  return entries
}

/** One standard rule (`:170-181`, `entry_re` at `:153-160`). */
function parseStandardEntry(tokens: readonly string[], sectionKey: string, line: string, seqno: number): AclEntry {
  const action = tokens[1]
  if (action !== 'permit' && action !== 'deny') {
    cannotParse(sectionKey, line, `the action token ${pythonRepr(action)} is not permit or deny — upstream's [p|d]\\w+ class accepts any word beginning with p, d or the literal | and its standard parser then crashes with AttributeError when the rest of the line does not fit (probe: a rule \`10 p\` raises, acl.py:171-173)`)
  }
  const source = readMatch(tokens, 2, { allowMask: true, allowOperator: false }, sectionKey, line)
  let index = source.next
  let log: boolean | undefined
  if (tokens[index] === LOG_TOKEN) {
    log = true
    index += 1
  }
  const rest = tokens.slice(index).join(' ')
  return {
    seqno,
    action,
    src: source.match,
    ...(log === undefined ? {} : { log }),
    ...(rest.length === 0 ? {} : { options: rest }),
  }
}

/** One extended rule (`:242-258`, `entry_re` at `:220-232`). */
function parseExtendedEntry(tokens: readonly string[], sectionKey: string, line: string, seqno: number): AclEntry {
  const action = tokens[1]
  if (action !== 'permit' && action !== 'deny') {
    cannotParse(sectionKey, line, `the action token ${pythonRepr(action)} is not permit or deny — upstream silently skips a rule its regex cannot match here, and its own fixture block lines such as \`no statistics per-entry\` are skipped by the \\d+ [p|d] probe instead (acl.py:243-245)`)
  }
  const protocol = tokens[2]
  if (protocol === undefined || !PROTOCOL_TOKEN.test(protocol)) {
    cannotParse(sectionKey, line, `an extended rule needs a protocol token; the line gives ${pythonRepr(protocol)} — upstream reads a missing one by ending the match and answering NO entry for the line at all (probe: \`10 permit\` yields {}), and a bare number protocol such as 47 is legal`)
  }
  const src = readMatch(tokens, 3, { allowMask: false, allowOperator: true }, sectionKey, line)
  const dst = readMatch(tokens, src.next, { allowMask: false, allowOperator: true }, sectionKey, line)
  // Upstream's `other` is `match.group(13)` — the whole tail after the destination regex consumed what it
  // could (`:256`). Everything here after the second match is the same tail, except that a standalone
  // trailing `log` becomes the `log` field and is not duplicated in `options` (divergence 10): probe shows
  // upstream answering `other: 'log'` and no log field at all for entry 60, `deny ip any any log`.
  const tail = tokens.slice(dst.next)
  const logAt = tail.length > 0 && tail[tail.length - 1] === LOG_TOKEN ? tail.length - 1 : -1
  const log = logAt >= 0 ? true : undefined
  if (logAt >= 0) tail.splice(logAt, 1)
  const options = tail.join(' ')
  return {
    seqno,
    action,
    protocol,
    src: src.match,
    dst: dst.match,
    ...(log === undefined ? {} : { log }),
    ...(options.length === 0 ? {} : { options }),
  }
}

/** The ACL sections of a chunked config, in document order, filtered to one kind (`null` = both). */
function aclsFromSections(sections: ConfigSections, wanted: AclType | null): Map<string, Acl> {
  const acls = new Map<string, Acl>()
  for (const [key, sectionText] of sections) {
    const header = ACL_HEADER.exec(key)
    const name = header?.[2]
    if (name === undefined) continue
    const type: AclType = header[1] === 'standard' ? 'standard' : 'extended'
    if (wanted !== null && type !== wanted) continue
    const entries = parseEntries(parseBlock(sectionText).body, key, type)
    const previous = acls.get(name)
    if (previous !== undefined) {
      throw new ConfigParseError(
        `acls: the name ${pythonRepr(name)} appears twice in the running-config, once as ${pythonRepr(previous.type)} and once as ${pythonRepr(type)} (${pythonRepr(key)}) — this client keys ACLs by name, so it reports rather than picking one. Whether EOS allows the two forms to share a name on this SKU is unverified on hardware, M12 (#14) to capture`,
        { sectionKey: key },
      )
    }
    acls.set(name, { name, type, entries })
  }
  return acls
}

/** Does this chunked config hold `name`, and as which kind? Exact key equality — divergence 5. */
function typeOfAcl(sections: ConfigSections, name: string): AclType | undefined {
  for (const key of sections.keys()) {
    const header = ACL_HEADER.exec(key)
    if (header?.[2] === name) return header[1] === 'standard' ? 'standard' : 'extended'
  }
  return undefined
}

/**
 * The type-pinned half of the ACL surface. Both collections read and write one kind, which is what lets
 * the facade stay typed: upstream's two classes are reached through `__getattr__`/`marshall`
 * (`:114-124`), and this is the port that replaces them (DR-092).
 *
 * `attrs` is `never`-keyed because there is nothing to pass: upstream's `StandardAcls.create(self, name)`
 * (`:183`) and `ExtendedAcls.create(self, name)` (`:260`) name a kind already fixed by the class. The kind
 * argument lives on the facade ({@link AclsResource.create}).
 */
abstract class AclCollectionBase extends EntityCollection<Acl, string, Record<string, never>> {
  /** Which kind this collection is — the discriminator for every command text and parser below. */
  protected abstract readonly aclType: AclType

  /** Every ACL of this kind, keyed by name, in document order — upstream's `getall()` half (`:91-112`). */
  override async getAll(): Promise<ResourceTable<string, Acl>> {
    return aclsFromSections(await this.configSections(), this.aclType)
  }

  /** One ACL of this kind, or `undefined` — upstream's `get(name)` returning `None` for an absent block (`:162-166`, `:234-238`). */
  override async get(name: string): Promise<Acl | undefined> {
    assertAclName(name)
    const sections = await this.configSections()
    const found = typeOfAcl(sections, name)
    if (found !== this.aclType) return undefined
    const text = sections.get(this.aclType === 'standard' ? `ip access-list standard ${name}` : `ip access-list ${name}`)
    if (text === undefined) return undefined
    return { name, type: this.aclType, entries: parseEntries(parseBlock(text).body, this.aclType === 'standard' ? `ip access-list standard ${name}` : `ip access-list ${name}`, this.aclType) }
  }

  /** `ip access-list [standard] <name>` — upstream `:183-185` / `:260-262`. */
  override async create(name: string): Promise<void> {
    assertAclName(name)
    await this.configure(commandBuilder(aclStem(this.aclType, name)))
  }

  /** `no ip access-list [standard] <name>` — upstream `:186-188` / `:263-265`. */
  override async delete(name: string): Promise<void> {
    assertAclName(name)
    await this.configure(commandBuilder(aclStem(this.aclType, name), { mode: 'no' }))
  }

  /** `default ip access-list [standard] <name>` — upstream `:189-190` / `:266-267`. */
  override async setDefault(name: string): Promise<void> {
    assertAclName(name)
    await this.configure(commandBuilder(aclStem(this.aclType, name), { mode: 'default' }))
  }

  /**
   * Replace one rule: enter the ACL, negate the old sequence number, write the new line, exit —
   * upstream's `update_entry` (`:192-200` standard, `:269-279` extended), whose command list
   * `test_api_acl.py:175-185` and `:241-251` pin verbatim.
   */
  async updateEntry(name: string, seqno: number, entry: AclEntryInput): Promise<void> {
    assertAclName(name)
    assertAclSeqno(seqno)
    const body = renderEntryBody(this.aclType, entry)
    await this.configure(submodeCommands(aclStem(this.aclType, name), [`no ${String(seqno)}`, `${String(seqno)} ${body}`, 'exit']))
  }

  /**
   * Append a rule — upstream's `add_entry` (`:202-211` standard, `:281-292` extended). With
   * {@link AclEntryInput.seqno} the line carries that number; without it the line carries none, which is
   * what upstream's `seqno=None` default does and lets the **device** number it. Nothing in acl.py
   * computes a sequence number client-side, and this client does not either: guessing the next one would
   * mean re-reading the block and hoping no other operator wrote between the read and the write.
   */
  async addEntry(name: string, entry: AclEntryInput): Promise<void> {
    assertAclName(name)
    await this.configure(submodeCommands(aclStem(this.aclType, name), [entryCommand(this.aclType, entry), 'exit']))
  }

  /** Remove one rule: `no <seqno>` inside the ACL — upstream's `remove_entry` (`:213-216`, `:294-297`). */
  async removeEntry(name: string, seqno: number): Promise<void> {
    assertAclName(name)
    assertAclSeqno(seqno)
    await this.configure(submodeCommands(aclStem(this.aclType, name), [`no ${String(seqno)}`, 'exit']))
  }
}

/** `node.acls.standard` — the `StandardAcls(EntityCollection)` half (`acl.py:151-216`). */
export class StandardAclsResource extends AclCollectionBase {
  protected readonly aclType: AclType = 'standard'
}

/** `node.acls.extended` — the `ExtendedAcls(EntityCollection)` half (`acl.py:218-297`). */
export class ExtendedAclsResource extends AclCollectionBase {
  protected readonly aclType: AclType = 'extended'
}

/**
 * `node.acls` — both kinds behind one name, which is what `node.api('acls')` answers upstream (`:82-149`).
 *
 * The facade keeps upstream's three-class shape and drops its dispatch: `__getattr__` (`:114-115`) and
 * `marshall` (`:117-124`) route any name through `hasattr`/`getattr` and forward the ACL name as
 * `args[0]`, which DR-006 removed for `Interfaces` (DR-068) and removes here too (DR-092). What the
 * facade genuinely owes is the **kind**: the header line differs between standard and extended, so
 * {@link resolveType} reads the section key once and calls the right collection — the same read upstream
 * performs in `get_instance` (`:126-135`), just without the regex made out of the caller's name.
 */
export class AclsResource extends EntityCollection<Acl, string, AclAttrs> {
  private readonly standardCollection: StandardAclsResource
  private readonly extendedCollection: ExtendedAclsResource

  constructor(node: import('../command-layer').Node) {
    super(node)
    this.standardCollection = new StandardAclsResource(node)
    this.extendedCollection = new ExtendedAclsResource(node)
  }

  /** The standard-ACL collection — the object upstream builds at `:139-142` when the header says `standard `. */
  get standard(): StandardAclsResource {
    return this.standardCollection
  }

  /** The extended-ACL collection — `:139-142` for every header that does not say `standard `. */
  get extended(): ExtendedAclsResource {
    return this.extendedCollection
  }

  private for(type: AclType): StandardAclsResource | ExtendedAclsResource {
    return type === 'standard' ? this.standardCollection : this.extendedCollection
  }

  /**
   * Every ACL, of either kind, keyed by name — upstream's `getall()` (`:91-112`) as one flat table.
   *
   * Upstream answers two nested dicts (`{'standard': {…}, 'extended': {…}}`), which is the shape
   * `test_getall` (`:70-75`) asserts; grouping by the `type` field reconstructs it, and a flat table is
   * what a `node.acls.get(name)`-style lookup and a UI table need (DR-068/DR-093, row 158). One
   * `show running-config` for the whole answer, against upstream's scan-plus-a-`get_block`-per-ACL
   * (`:105-111` → `:88-89`/`:162` → `client.py:776-798`).
   */
  override async getAll(): Promise<ResourceTable<string, Acl>> {
    return aclsFromSections(await this.configSections(), null)
  }

  /** One ACL of either kind, or `undefined` — `test_get_not_configured` (`:77-78`) becomes `undefined` (DR-027). */
  override async get(name: string): Promise<Acl | undefined> {
    assertAclName(name)
    const type = typeOfAcl(await this.configSections(), name)
    if (type === undefined) return undefined
    return this.for(type).get(name)
  }

  /**
   * Create an ACL. `attrs.type` defaults to `'standard'`, as `create(self, name, type='standard')`
   * (`:144-149`) does, and an unknown kind is refused rather than quietly writing the other kind
   * (divergence 8 — upstream's own `test_create_unknown_type_creates_standard` pins the fallback).
   */
  override async create(name: string, attrs?: AclAttrs): Promise<void> {
    assertAclName(name)
    const requested = attrs?.type ?? 'standard'
    if (!isAclType(requested)) {
      refuse('ACL type', requested, `expected one of ${ACL_TYPES.join(' / ')} — pyeapi maps anything else to StandardAcls and its own test pins that (acl.py:137-142, test_api_acl.py:117-120)`)
    }
    await this.for(requested).create(name)
  }

  /**
   * The kind of an ACL the switch has. Used by every kind-sensitive verb below.
   *
   * @throws {NotFoundError} the switch has no such ACL. Upstream reaches the same branch and pays an
   *   `AttributeError`: `get_instance` returns `{name: None}` (`:136`) and `marshall` then fails its
   *   `hasattr` test (probe: `'{'unconfigured': None}' object has no attribute 'add_entry'`).
   */
  private async resolveType(name: string): Promise<AclType> {
    assertAclName(name)
    const type = typeOfAcl(await this.configSections(), name)
    if (type === undefined) {
      throw new NotFoundError(
        `acls: the switch has no ACL named ${pythonRepr(name)} — pyeapi hands the miss to marshall(), which raises AttributeError on the None it stored for the name (api/acl.py:126-136, :117-124)`,
        { cause: name },
      )
    }
    return type
  }

  /** Delete an ACL of **either** kind — the header text depends on the kind, so the kind is read (row 163). */
  async deleteAcl(name: string): Promise<void> {
    await this.for(await this.resolveType(name)).delete(name)
  }

  /** `default ip access-list [standard] <name>`, kind read from the switch. */
  async setDefaultAcl(name: string): Promise<void> {
    await this.for(await this.resolveType(name)).setDefault(name)
  }

  /** Append a rule to an ACL of either kind. */
  async addEntry(name: string, entry: AclEntryInput): Promise<void> {
    await this.for(await this.resolveType(name)).addEntry(name, entry)
  }

  /** Replace one rule of an ACL of either kind. */
  async updateEntry(name: string, seqno: number, entry: AclEntryInput): Promise<void> {
    await this.for(await this.resolveType(name)).updateEntry(name, seqno, entry)
  }

  /** Remove one rule from an ACL of either kind. */
  async removeEntry(name: string, seqno: number): Promise<void> {
    await this.for(await this.resolveType(name)).removeEntry(name, seqno)
  }

  /**
   * The `EntityCollection` delete would have to guess the kind, so it is not what a facade caller should
   * call: {@link deleteAcl} reads the header and sends the right text. Kept as an abstract-implementation
   * that refuses, rather than silently picking `standard` the way `create_instance` would (`:137-142`).
   */
  override async delete(name: string): Promise<void> {
    return this.deleteAcl(name)
  }

  /** The {@link setDefaultAcl} counterpart of {@link delete} — see that method for why the kind is read. */
  override async setDefault(name: string): Promise<void> {
    return this.setDefaultAcl(name)
  }
}
