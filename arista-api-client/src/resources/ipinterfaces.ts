/**
 * `ipinterfaces` — the layer-3 view of an interface: its `ip address …` lines and the interface `mtu`
 * line, W2c (#39 #40), a port of `pyeapi/api/ipinterfaces.py` (268 lines, BSD-3-Clause, Arista Networks —
 * DR-001) on the M7 (#9) framework and M9's (#11) block extractors.
 *
 * | pyeapi (verified refs) | here |
 * |---|---|
 * | `Ipinterfaces(EntityCollection)` (`:60`) | {@link IpinterfacesResource} extends `EntityCollection<IpInterface, string, IpInterfaceAttrs>` |
 * | `get` (`:62-92`): `get_block('interface %s' % name)` (`:84`), the L2 gate `if name[0:2] in ['Et','Po'] and not SWITCHPORT_RE.search(config, re.M): return None` (`:85-87`, `SWITCHPORT_RE` at `:57`), then `resource = dict(name=name)` plus two `_parse_*` merges (`:89-92`) | {@link IpinterfacesResource.get} / {@link ipInterfaceFromSection} — the same gate re-expressed as a kind test plus a command-line test (row 173), and the same two fields parsed from the block's **body lines** (row 174) |
 * | `_parse_address` (`:94-111`): `re.findall(r'ip address ([^\s]+)', config, re.M)` (`:107`), `primary, secondary = match[0], match[1:]` (`:108-109`), `secondary` key omitted when empty (`:110-111`) | {@link addressesFromBlock} — `valuesAfterKeyword(body, 'ip address')`, and the `secondary` **keyword** decides which address is which (row 174) |
 * | `_parse_mtu` (`:113-127`): `re.search(r'mtu (\d+)')` (`:126`) then `int(match.group(1))` | {@link numberFieldFromBlock} over `valueAfterKeyword(body, 'mtu')` — decimal-checked, reported rather than truncated, and `ip mtu …`/`ipv6 mtu …` cannot answer for the interface `mtu` line (row 174) |
 * | `getall` (`:129-149`): `re.compile(r'^interface\s(.+)', re.M)` (`:142`) over the whole text then `self.get(name)` per hit (`:145-148`) | {@link IpinterfacesResource.getAll} — one chunked read, one pass, `undefined`-safe (row 173) |
 * | `create` (`:151-174`): `commands = ['interface %s' % name, 'no switchport']` | {@link IpinterfacesResource.create} — same two commands, in the same order, with this client's optional attrs lines appended inside the one transaction |
 * | `delete` (`:176-194`): `commands = ['interface %s' % name, 'no ip address', 'switchport']` | {@link IpinterfacesResource.delete} — the same three texts; `switchport` back is what makes an L3 section an L2 one |
 * | `set_address` (`:196-219`): `['interface %s', command_builder('ip address', value, default, disable)]` | {@link setAddress} / {@link unsetAddress} / {@link defaultAddress} — `ip address …`, `no ip address`, `default ip address` |
 * | `set_mtu` (`:222-254`): `if value is not None: value = int(value)` + `IP_MTU_MIN <= value <= IP_MTU_MAX` (`:246-249`, constants `:54-55`), then `['interface %s', command_builder('mtu', …)]` | {@link setMtu} / {@link unsetMtu} / {@link defaultMtu} — `mtu <value>`, `no mtu`, `default mtu`; upstream's `ValueError('invalid mtu value')` becomes `NotSupportedError` naming the value |
 * | `@_interpolate_docstr('IP_MTU_MIN','IP_MTU_MAX')` (`:221`, `pyeapi/utils.py:277-304`) — docstring templating only | not ported (DR-004: no runtime docstring rewriting); the two constants are named in the refusal text instead |
 * | `instance(node)` (`:257-268`) | the `RESOURCE_FACTORIES.ipinterfaces` row plus `Node.ipinterfaces` (DR-006/DR-052) |
 *
 * Upstream's suite is `pyeapi/test/unit/test_api_ipinterfaces.py` — **11** test methods (AST count,
 * 2026-11-05): `test_get` (`:55-63`, pinning `Loopback0` → `1.1.1.1/32`/1500 and `Loopback2` →
 * `secondary: ['3.255.255.1/24', '4.255.255.1/24']` with `mtu: None`), `test_getall` (`:65-68`, four
 * entries in `test/fixtures/running_config.text`), `test_instance_functions` (`:70-79`, the create/delete
 * command lists above), `test_set_address_with_value` (`:81-86`), `test_set_address_with_no_value`
 * (`:88-92`, `no ip address`), `test_set_address_with_default` (`:94-98`),
 * `test_set_address_invalid_value_raises_value_error` (`:100-108` — which does **not** raise: its own
 * comment says "If command_builder fails because value is None, uncomment above lines", `:102-105`, and it
 * pins `no ip address` instead), `test_set_mtu_with_values` (`:110-115`), `test_set_mtu_with_no_value`
 * (`:117-121`), `test_set_mtu_default` (`:123-127`, which despite its name pins only `default mtu` and
 * ignores the `disable` value it computes at `:124-126`), `test_set_mtu_invalid_value_raises_value_error`
 * (`:129-140`, `67`/`65536`/`'a…'` raise, while `None` again answers `no mtu` per its `:135-137`
 * commentary). The spans this header carried when the lane opened were eight lines early from
 * `test_get` on (`:47-55`, `:62-73`, `:106-111`, …) — those are the `INTERFACES` list at `:47-48` and the
 * lines before them; every span above was re-opened in the pinned clone, and the same shift is corrected
 * throughout this file. All 11 are ported in {@link file://./ipinterfaces.test.ts}; the two
 * `command_builder` pre-armed comments (`:102-105`, `:135-137`) are exactly what DR-037's `unset*` verbs
 * realise — MIGRATION.md §5 row 73 counts twelve such sites across upstream, two of them in this file.
 *
 * ## Divergences this file owns (MIGRATION.md §5 rows 173-174)
 *
 * 1. **the L2 gate is a kind test plus a command test, not a two-character test over raw text**
 *    (row 173). Upstream returns `None` for an Ethernet/Port-Channel interface that is **not** routed:
 *    `name[0:2] in ['Et','Po'] and not SWITCHPORT_RE.search(config, re.M)` (`:85-87`). Three things are
 *    wrong with the parts: the prefix admits `Et1`, `Po1` and `Poke1` while excluding the real
 *    `Management1`/`Loopback` kinds from the gate (probe, same split as `stp.py:363`); `no switchport$`
 *    under `re.M` (`:57`) is a substring test needing a line end after it, so an interface block whose
 *    `no switchport` is the last line of the config behaves differently from one followed by `!`
 *    (`switchports.ts` divergence 8 hit the same rule at `switchports.py:80`); and `search(config, re.M)`
 *    passes `re.M` as the compiled pattern's **`pos`** argument (value `8`), not as flags — those are
 *    already baked in at `:57`, so the scan silently starts at offset 8 of the block. Recorded rather than
 *    "fixed": an `interface …` header on its own is ≥ 10 bytes, so no real block can have its
 *    `no switchport` line start before offset 8 (verified by probe on both the real and a one-space-indent
 *    block — probed 2026-11-05). Here the gate is `Ethernet`/`Port-Channel` **as a kind token** plus an
 *    exact `no switchport` body line, and the difference set is the junk-prefix spellings, both halves
 *    probed: an `interface Et1` section **without** `no switchport` is filtered out upstream (its `Et`
 *    prefix fires the gate and the block has no such line) while here `Et1` is not an L2-capable kind
 *    token, so the section is reported — as a record with whatever fields its own lines carry, and none if
 *    it has none. With `no switchport` written, both answer a record.
 * 2. **an absent section never crashes and never hallucinates** (row 173). `get_block` hands back `None`
 *    for a section the switch does not have (`abstract.py:96-101`), and `ipinterfaces.py` then runs that
 *    `None` through `search`/`findall` — probe: `get('Ethernet4')` on a config without that section raises
 *    `TypeError: expected string or bytes-like object, got 'NoneType'`, and so do `get('Vlan20')`/
 *    `get('NoSuch9')` despite the docstring's promise (`:81-83`) that a missing interface returns `None`.
 *    Upstream's `getall` (`:142-148`) can also read an `interface …` line inside a banner body as a name:
 *    the regex is `re.M` over the whole document, and a banner body is unindented text (`client.py:747-750`
 *    keeps it inside the banner *section*, which is what the chunked scan here relies on). The pinned
 *    fixture's banner body carries a column-0 `vlan 1` at `test/fixtures/running_config.text:411` — that is
 *    the probe `vlans.ts` divergence 3 records; it has **no** column-0 `interface` line in a banner body
 *    (verified 2026-11-05: all 14 column-0 `interface` lines in that file are real sections), so the
 *    `getall`-crash-through-a-banner path is pinned in `ipinterfaces.test.ts` on a hand-authored config of
 *    the same shape rather than on vendor fixture text. DR-027's `undefined`
 *    plus the chunked document replace both, at one read per whole table (DR-030).
 * 3. **which address is primary comes from the `secondary` keyword, not from line order** (row 174).
 *    Upstream takes `match[0]` as the primary and calls every later `ip address` token a secondary
 *    (`:108-111`), so the word `secondary` is never read — probes: a `loopback` block with only
 *    `ip address 10.0.0.9/32 secondary` answers `address: '10.0.0.9/32'` with no `secondary` key;
 *    `ip address 172.16.0.1/24 secondary` written **before** `ip address 172.17.0.1/24` makes the
 *    secondary the primary and the primary a secondary; and `ip address virtual Port-Channel1` contributes
 *    the word `virtual` as a secondary **address** (`Vlan81`, probed). Here the token is the first word of
 *    the line's remainder (kept verbatim, so `virtual` still reads as `address: 'virtual'` on a single-line
 *    section — DR-059's keep-the-device-token rule) and a line flags itself secondary by the keyword. A
 *    record with only secondaries has `secondary` set and **no** `address` field, which is a statement the
 *    config actually supports; upstream's answer there is the lie.
 * 4. **negated and commented lines cannot speak for an address** (row 174). The same whole-block
 *    `findall` (`:107`) matches mid-line, so probe: `! ip address 9.9.9.9/32` (an EOS config comment)
 *    answers `address: '9.9.9.9/32'`, and `no ip address 5.5.5.5/32` answers `address: '5.5.5.5/32'`. Here
 *    the lookup is `valuesAfterKeyword(body, 'ip address')` (`config-block.ts`, row 91), whose command-text
 *    anchor excludes both, and the same anchor keeps `no ip address` bare (`:107` cannot match it only
 *    because the pattern needs a non-space character after the space).
 * 5. **the `mtu` line, and the MTU overlap with `interfaces`** (row 174). `mtu (\d+)` (`:126`) is unanchored
 *    over the whole block, so probe: a section carrying only `ip mtu 1400` reads as `mtu: 1400` — an
 *    `ip mtu` value reported as the interface MTU, on top of the truncation DR-059 records (`mtu 1500
 *    extra` → `1500`). Here `mtu` is a body-line keyword lookup, so `ip mtu`/`ipv6 mtu` cannot answer for
 *    the interface's `mtu`, and a non-decimal or oversized value is a {@link ConfigParseError} naming the
 *    section rather than a truncated number. **The overlap is the point of this row**: this `mtu` is the
 *    same indent-1 `mtu <n>` line inside the same `interface <name>` section that the M10a (#12)
 *    `interfaces` resource reads and writes (`interfaces.ts` divergence 7, whose own header admits
 *    `ipinterfaces.py` is the closest upstream twin for that field). Two resources, one line, and this
 *    client adds **no** ownership or coordination mechanism between them — the reads agree because both
 *    parse the same line from the same chunked document, the writes are separate transactions, and the last
 *    one the device accepted is what the next read reports (**DR-097**). What genuinely differs is the
 *    write guard: `ipinterfaces` keeps upstream's `68..65535` IP-MTU check (`:54-55`, `:246-249`), while
 *    `interfaces.setMtu` refuses only non-positive/non-integer input because it did not want to encode an
 *    IP-MTU bound on an L2 field. A UI that reads one resource and writes the other therefore has to know
 *    which guard it is passing, and each refusal says which range it checked. Whether this SKU's routed
 *    ports accept 65535, and what the real L2 minimum is, stay M12 (#14) captures (DR-032).
 * 6. **`set`/`unset`/`default` instead of pyeapi's three flag kwargs** (row 174). Upstream's `set_address`
 *    and `set_mtu` both fold a value-less call into the **negated** command (the `value=None` fall-through
 *    at `abstract.py:160-161`, which its own tests pre-armed with comments at `:99-101` and `:133-135`),
 *    and DR-037 splits those three intents into three named verbs here. `setBpduguard`-style
 *    booleans do not exist in this module: `setAddress` takes the address string, `setMtu` takes the
 *    number, and negation is a different verb.
 * 7. **input guards where upstream has none** (row 174). Nothing in `ipinterfaces.py` checks a name, so
 *    probe-parity is that `create('Nope1')`/`set_address('Vlan77', 'x y')` interpolate whatever arrives
 *    (`:173`, `:216-218`); `set_mtu('Ethernet1', '1500')` **works** upstream because `int(value)` coerces
    (`:247`). Here the name goes through the shared `isInterfaceName` grammar (`validators.ts:267-270`,
    row 76 — the chassis and dotted forms stay refused pending DECISIONS open item 7), the address through
 *    {@link assertInterfaceAddress} (the `A.B.C.D/E` shape the module's own docstring names, `:203-204`,
 *    with the optional `secondary` keyword the CLI writes), and the MTU through
 *    {@link assertInterfaceMtu} (an integer in `68..65535`, no string coercion — a string reaching this
 *    point means a UI forgot to parse a form field). Every refusal is a `NotSupportedError` at zero round
 *    trips, and every verb has a pinned `CommandError` path so the device keeps the final word (DR-005).
 * 8. **`setDefault` refuses** (row 174). `EntityCollection` (`base.ts:221-245`) requires the entry-shape
 *    verbs, and `ipinterfaces.py` implements `create`/`delete` but **no** `default` — where upstream gives
 *    an `AttributeError` (probe-parity with `StpInstances.create`), {@link setDefault} refuses with
 *    `NotSupportedError` and points at the verb that does exist elsewhere in this client:
 *    `node.interfaces.setDefault(name)` sends `default interface <name>`. Inventing a per-field
 *    `default …` composite here would be writing commands upstream never writes.
 */

import { ConfigParseError, NotSupportedError } from '../errors'
import { pythonRepr } from '../internal/wire'
import { parseBlock } from '../config/text'
import { valueAfterKeyword, valuesAfterKeyword } from './config-block'
import { EntityCollection } from './base'
import { isInterfaceName } from './validators'
import type { ConfigBlock } from '../config/text'
import type { ConfigSections } from '../config/chunk'
import type { ResourceTable } from './types'

/**
 * The MTU range this client writes, which is upstream's IP-MTU range verbatim:
 * `IP_MTU_MIN = 68` / `IP_MTU_MAX = 65535` (`ipinterfaces.py:54-55`, checked at `:246-249`, and the words
 * the module docstring uses for the field at `:44-47`).
 *
 * `68` is the IPv4 minimum pyeapi names (its docstring cites RFC 791/8200), not a captured EOS floor, and
 * `65535` is a `uint8`-adjacent round number rather than a measured ceiling — both stay
 * "unverified on hardware, M12 (#14) to capture" (DR-032). The {@link setMtu} guard exists to stop a UI
 * sending an obviously-bad number, and the device still refuses what it refuses. Contrast
 * `interfaces.ts`'s MTU guard, which deliberately does **not** encode this IP-shaped range for an L2 field
 * (row 174 / **DR-097**).
 */
export const IP_MTU_MIN = 68
export const IP_MTU_MAX = 65535

/**
 * One IP interface — upstream's record (`ipinterfaces.py:89-92`, shape documented at `:66-72`), typed per
 * MIGRATION.md §4. `secondary` is present only when the switch has a secondary address, which is upstream's
 * own answer (`:110-111`: the key is omitted, not set to `[]`).
 */
export interface IpInterface {
  /** The interface name, spelled as the section header spells it — not the caller's lookup argument (row 96/DR-029). */
  readonly name: string
  /** The primary `ip address <token>`, as the device wrote it; absent when the section has none. */
  readonly address?: string
  /** Every address line flagged `secondary` on the line itself, in device order (row 174). */
  readonly secondary?: readonly string[]
  /** The interface `mtu <n>` line. Overlaps the `interfaces` resource's field by design — see divergence 5. */
  readonly mtu?: number
}

/**
 * What {@link IpinterfacesResource.create} may configure in the same transaction as the `no switchport`
 * line. Upstream's `create(self, name)` (`:151`) takes no attributes, and neither the `address` nor the
 * `mtu` line is invented when the caller leaves them out — same precedent as `VlanAttrs`/`SwitchportAttrs`
 * (those modules' divergence 9/13). Type alias rather than interface: `ResourceAttrs` (`types.ts:67`) needs
 * the implicit index signature an object literal type has.
 */
export type IpInterfaceAttrs = {
  /** `ip address <A.B.C.D/E>` inside the new L3 section. */
  readonly address?: string
  /** `mtu <n>` inside the new L3 section. */
  readonly mtu?: number
}

/** A section header naming an interface. Anchored, so an indented copy never matches. */
const INTERFACE_SECTION = /^interface (\S+)$/u

/**
 * The kinds that have a switchport mode at all, as a **kind token** rather than pyeapi's two characters
 * (`ipinterfaces.py:85-86`). A section whose name starts with a real kind token is L2-capable, so it only
 * has an IP interface once the block says `no switchport`; `Vlan…`/`Loopback…`/`Management…`/`Vxlan…` never
 * have that line and are reported unconditionally, which is what upstream does for them as well.
 */
const L2_CAPABLE_KIND = /^(?:Ethernet|Port-Channel)/u

/** The negated L2 mode as a whole command line (upstream's test is `no switchport$` under `re.M`, `:57`). */
const NO_SWITCHPORT_COMMAND = 'no switchport'

/** The keyword forms, matched against a parsed body line's command text (row 91's anchor). */
const ADDRESS_KEYWORD = 'ip address'
const MTU_KEYWORD = 'mtu'
const SECONDARY_FLAG = 'secondary'

/** A plain decimal integer, as strict as the reader needs (rows 43/44's report-don't-truncate rule). */
const DECIMAL = /^[0-9]+$/u

/**
 * An address token: IPv4 dotted quad plus a prefix length. The form upstream's docstring names — "The value
 * should be in the format of A.B.C.D/E" (`ipinterfaces.py:203-204`) — which its parser never enforces
 * (`:107` keeps any non-space token) and its writer never checks (`:216-218`).
 */
const ADDRESS_TOKEN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/([0-9]{1,3})$/u

/** A rejected argument is named in the message (the `refuse` pattern from `validators.ts:226-229`, DR-053). */
function refuse(label: string, value: unknown, because: string): never {
  throw new NotSupportedError(`invalid ${label} ${pythonRepr(value)} — ${because}`, { cause: value })
}

/** C0 controls plus DEL — the same check `switchports.ts:395-401` uses for a value that would break the line. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/**
 * Require an interface name this client may write L3 commands to: the shared grammar, and nothing more.
 *
 * Upstream checks nothing in this module — no `isvalidinterface` at all here, unlike
 * `stp.py:346-363`/`interfaces.py:81-83` — so `create('banana')` would send `interface banana` (divergence
 * 7). The six kinds in `validators.ts:65-73` are the kinds pyeapi's own predicate knows, and an
 * `interface Vlan20`/`Loopback0`/`Management1` is genuinely an IP interface (upstream's fixture has all
 * three: `test_get`/`test_getall` at `test_api_ipinterfaces.py:55-68` read `Loopback0`, `Loopback2`,
 * `Management1` and `Vlan10`).
 */
function assertL3InterfaceName(verb: string, value: unknown): asserts value is string {
  if (isInterfaceName(value)) return
  refuse(
    `${verb} interface`,
    value,
    `expected one of the six kinds validators.ts:65-73 knows, spelled in full with an index and no subinterface suffix — pyeapi's ipinterfaces module has no name check at all (api/ipinterfaces.py:151-254 interpolate the name into 'interface %s'), and its own fixture reads Loopback0, Loopback2, Management1 and Vlan10 as IP interfaces (test/unit/test_api_ipinterfaces.py:55-68); the chassis and dotted forms stay refused pending DECISIONS open item 7 until M12 #14 captures them`,
  )
}

/**
 * Require an address value in the `A.B.C.D/E` form, optionally spelled with the `secondary` keyword the
 * CLI writes (which is also what {@link IpInterface.secondary} reads back — row 174).
 *
 * Refused: anything else, including an empty value (that is {@link unsetAddress}, DR-037), a multi-token
 * string other than the `secondary` spelling (`ip address virtual …` is read verbatim but not written,
 * because this module has no verb for a virtual address), and a value with a control character. Upstream
 * interpolates whatever arrives (`:216-218`; probe-parity: `set_address('Vlan77', 'x y')` sends
 * `interface Vlan77` + `ip address x y`). The octet/prefix bounds are the IPv4 form itself, not an EOS
 * claim (DR-032): which addresses this build accepts is the device's to decide, and the `CommandError` path
 * is pinned for every verb.
 */
function assertInterfaceAddress(value: unknown): asserts value is string {
  if (typeof value !== 'string') refuse('ip address', value, 'expected a string address in the form A.B.C.D/E (pyeapi documents that form at api/ipinterfaces.py:203-204 and checks nothing, interpolating at :216-218)')
  if (hasControlCharacter(value)) refuse('ip address', value, 'a control character would break the config line this client reads back (row 74 in MIGRATION.md §5)')
  const tokens = value.split(' ')
  if (tokens.length > 2 || (tokens.length === 2 && tokens[1] !== SECONDARY_FLAG)) {
    refuse('ip address', value, 'expected A.B.C.D/E, optionally followed by the single word secondary — that is the whole shape this client can read back after writing it (see the address parse in row 174)')
  }
  const match = ADDRESS_TOKEN.exec(tokens[0] as string)
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined || match[4] === undefined || match[5] === undefined) {
    refuse('ip address', value, 'expected A.B.C.D/E: four decimal octets, a slash, a prefix length — a prefix/len alone, an interface name, or the word virtual are shapes this client reads back verbatim but will not write')
  }
  const octets = [match[1], match[2], match[3], match[4]].map(Number)
  for (const octet of octets) {
    if (octet > 255) refuse('ip address', value, `the octet ${String(octet)} is outside 0..255 — an IPv4-address fact, not an EOS claim (DR-032)`)
  }
  const prefix = Number(match[5])
  if (prefix > 32) refuse('ip address', value, `the prefix length ${String(prefix)} is outside 0..32 for an IPv4 address — an IPv4 fact, not an EOS claim about this build (DR-032)`)
}

/**
 * Require an MTU in upstream's `IP_MTU_MIN..IP_MTU_MAX` (`:246-249`), and require it to **be** a number:
 * upstream runs `int(value)` first (`:247`), so `set_mtu('Ethernet1', '1500')` succeeds there (probe) while
 * a UI handing a form field straight through would hide that coercion here. A non-integer (`1500.5`, which
 * upstream truncates to `1500` by `int()`, probe-parity through the same line) and a booleans/objects are
 * refused the same way `assertVlanId` refuses a string (`validators.ts:253-257` after `isVlanId` at
 * `:234-241`, row 76).
 *
 * `0` is refused as out of range, which also removes upstream's `value=0` → `else:` → `no mtu` fall-through
 * (`abstract.py:158-161`, DR-037) from this verb — the negation is {@link unsetMtu}.
 */
function assertInterfaceMtu(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    refuse('mtu', value, `expected an integer MTU ${String(IP_MTU_MIN)}..${String(IP_MTU_MAX)} — pyeapi coerces with int(value) at api/ipinterfaces.py:247, which this client does not: a string here means a UI did not parse its form field`)
  }
  if (value < IP_MTU_MIN || value > IP_MTU_MAX) {
    refuse('mtu', value, `expected ${String(IP_MTU_MIN)}..${String(IP_MTU_MAX)}, the range pyeapi checks at api/ipinterfaces.py:246-249 with the constants at :54-55 — those constants are an IP-MTU reading of RFC 791/8200, not a captured floor/ceiling for this SKU (DR-032: unverified on hardware, M12 #14 to capture). Negation is unsetMtu(), which sends pyeapi's 'no mtu'`)
  }
}

/**
 * A numeric field value, or `undefined` when the section carries no such line — the same three-way split as
 * `interfaces.ts`'s reader of the identical line (divergence 5): grammar-shaped → number, outside it →
 * {@link ConfigParseError} naming the section.
 */
function numberFieldFromBlock(value: string | undefined, keyword: string, sectionKey: string): number | undefined {
  if (value === undefined) return undefined
  if (!DECIMAL.test(value)) {
    throw new ConfigParseError(
      `ipinterfaces: cannot read ${pythonRepr(keyword)} in ${pythonRepr(sectionKey)} — ${pythonRepr(value)} is not a decimal number. pyeapi's reader is re.search(r"mtu (\\d+)", config) at api/ipinterfaces.py:126, which truncates a tail and matches an ip mtu / ipv6 mtu line instead, and this client reports rather than guessing`,
      { sectionKey },
    )
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw new ConfigParseError(
      `ipinterfaces: ${pythonRepr(keyword)} in ${pythonRepr(sectionKey)} is ${pythonRepr(value)}, which this client cannot hold as an integer — reporting a rounded value as configuration would be a wrong answer about the device`,
      { sectionKey },
    )
  }
  return parsed
}

/** One address body line: the token, plus the words after it (`secondary` is the only one upstream's CLI writes). */
interface AddressLine {
  readonly token: string
  readonly flagged: boolean
}

/**
 * Every `ip address …` line in the block, in device order, split into its token and its flags.
 *
 * Upstream instead takes the list of first-tokens after the literal `ip address ` (`:107`), decides the
 * primary by **index** (`:108-109`), and never looks at the `secondary` word (probes in divergence 3), while
 * its whole-block scan also matches an EOS comment (`   ! ip address 9.9.9.9/32` → `address:
 * '9.9.9.9/32'`) or a negated line that carries a value (`no ip address 5.5.5.5/32`). The keyword anchor
 * here (`valuesAfterKeyword`, row 91) excludes both, and the flag decides the role.
 */
function addressLinesFrom(block: ConfigBlock): AddressLine[] {
  return valuesAfterKeyword(block.body, ADDRESS_KEYWORD).map((remainder) => {
    const [token = '', ...flags] = remainder.split(/\s+/u)
    return { token, flagged: flags.includes(SECONDARY_FLAG) }
  })
}

/**
 * One `interface …` section's L3 fields. Merged in upstream's order (`:90-91`: address, then mtu).
 */
function ipInterfaceFieldsFrom(block: ConfigBlock, sectionKey: string): Omit<IpInterface, 'name'> {
  const lines = addressLinesFrom(block)
  const primaries = lines.filter((line) => !line.flagged).map((line) => line.token)
  const secondary = lines.filter((line) => line.flagged).map((line) => line.token)
  const mtu = numberFieldFromBlock(valueAfterKeyword(block.body, MTU_KEYWORD), MTU_KEYWORD, sectionKey)
  return {
    ...(primaries.length === 0 ? {} : { address: primaries[0] }),
    ...(secondary.length === 0 ? {} : { secondary }),
    ...(mtu === undefined ? {} : { mtu }),
  }
}

/**
 * Is this section an L3 one? An `Ethernet…`/`Port-Channel…` section only is, and only when its own body
 * states `no switchport`; every other kind is reported as-is (divergence 1, which is the same
 * documented-kinds-versus-prefix-hack correction `switchports.ts` divergence 5 made for the sibling
 * module — here it decides whether an entry exists at all rather than which fields it has).
 */
function isL3Section(name: string, block: ConfigBlock): boolean {
  if (!L2_CAPABLE_KIND.test(name)) return true
  return block.body.some((line) => line.text === NO_SWITCHPORT_COMMAND)
}

function ipInterfaceFromSection(sectionKey: string, name: string, block: ConfigBlock): IpInterface {
  return { name, ...ipInterfaceFieldsFrom(block, sectionKey) }
}

/**
 * Every IP interface in a chunked running-config, one pass and **one** device read (DR-030).
 *
 * Upstream's `getall` (`:142-148`) regex-scans the whole document, calls `get` per hit — each of which
 * redoes the `section()` key scan (`client.py:792-797`) and its own two regex passes — and filters with
 * `if interface:` (`:147`), which is how a `None` from the L2 gate disappears from the table. Its own test
 * pins the count for the pinned fixture at **4** (`test_api_ipinterfaces.py:65-68`), and the four are
 * `Loopback0`, `Loopback2`, `Management1`, `Vlan10`, because every `Ethernet…` section in that file is a
 * switchport (probed 2026-11-05).
 */
function ipInterfacesFromSections(sections: ConfigSections): Map<string, IpInterface> {
  const interfaces = new Map<string, IpInterface>()
  for (const [key, sectionText] of sections) {
    const name = INTERFACE_SECTION.exec(key)?.[1]
    if (name === undefined) continue
    const block = parseBlock(sectionText)
    if (!isL3Section(name, block)) continue
    interfaces.set(name, ipInterfaceFromSection(key, name, block))
  }
  return interfaces
}

/**
 * `node.ipinterfaces` — the layer-3 view: which sections are routed, and what their `ip address`/`mtu`
 * lines say. Port of `Ipinterfaces(EntityCollection)` (`ipinterfaces.py:60`).
 *
 * The boundary with the M10a `interfaces` resource is stated in row 174 rather than left to be discovered:
 * `interfaces` owns the L2/L3-neutral interface facts (`description`, `shutdown`, and its own reading of the
 * same `mtu` line), `switchports` owns the L2 mode, and this module owns the L3 addresses plus the
 * `no switchport`/`switchport` flip that moves a section between the two views.
 */
export class IpinterfacesResource extends EntityCollection<IpInterface, string, IpInterfaceAttrs> {
  /**
   * One interface's L3 state, or `undefined` — pyeapi's `get` (`:62-92`) where it does not raise. Three of
   * upstream's answers collapse here: an absent section (`TypeError`, probe), an L2 Ethernet section
   * (`None`, `:85-87`), and a name spelled with a stray `Et`/`Po` prefix (`None`, same two characters).
   * Reads carry **no** name guard: a section header this client cannot write still gets read
   * (`switchports.ts:510-520`'s read/write asymmetry, row 76's open item).
   */
  override async get(name: string): Promise<IpInterface | undefined> {
    return (await this.getAll()).get(name)
  }

  /**
   * Every IP interface, keyed by section name in device order (row 78), from **one** config read — pyeapi's
   * `getall` (`:129-149`) pays a scan and a parse per entry, and clears `get`'s `TypeError` only when every
   * hit happens to exist.
   */
  override async getAll(): Promise<ResourceTable<string, IpInterface>> {
    return ipInterfacesFromSections(await this.configSections())
  }

  /**
   * Make the section a routed interface: `interface <name>` + `no switchport` — pyeapi's `create`
   * (`:173-174`), the exact pair `test_api_ipinterfaces.py:70-79` pins, with the optional `ip address` and
   * `mtu` lines appended in the **same** transaction (upstream needs three calls: `:174`, `:219`, `:254`).
   * Upstream's note that creating an L3 interface removes an existing switchport (`:159-161`) is the device's
   * behaviour, unchanged here and unverified on this unit (M12 #14).
   */
  override async create(name: string, attrs?: IpInterfaceAttrs): Promise<void> {
    assertL3InterfaceName('create', name)
    const commands: string[] = ['no switchport']
    if (attrs?.address !== undefined) {
      assertInterfaceAddress(attrs.address)
      commands.push(this.commandBuilder(ADDRESS_KEYWORD, { value: attrs.address }))
    }
    if (attrs?.mtu !== undefined) {
      assertInterfaceMtu(attrs.mtu)
      commands.push(this.commandBuilder(MTU_KEYWORD, { value: attrs.mtu }))
    }
    await this.configureInterface(name, commands)
  }

  /**
   * Return the section to L2: `interface <name>` + `no ip address` + `switchport` — pyeapi's `delete`
   * (`:193-194`), verbatim per `test_api_ipinterfaces.py:70-79`. The order is upstream's, and it matters:
   * the address is cleared before the port goes back to switching (whether EOS would refuse the reverse is a
   * device question, M12 #14).
   *
   * There is no `no interface <name>` here — this module deletes the **L3 logical** interface, not the
   * section (`:177-190`). The section itself is {@link IpinterfacesResource.setDefault}'s refusal below and
   * `node.interfaces.delete(name)` upstream (`interfaces.py`'s own entry verbs).
   */
  override async delete(name: string): Promise<void> {
    assertL3InterfaceName('delete', name)
    await this.configureInterface(name, ['no ip address', 'switchport'])
  }

  /**
   * Refused: `ipinterfaces.py` has no default verb at all (its three writers are `create`/`delete`/
   * `set_*`), so there is no upstream command text to port and composing one per field would be inventing
   * device behaviour (divergence 8). For the whole-section form, `node.interfaces.setDefault(name)` sends
   * pyeapi's `default interface <name>`; for a single field, use {@link unsetAddress} /
   * {@link defaultAddress} / {@link unsetMtu} / {@link defaultMtu}.
   */
  override async setDefault(name: string): Promise<void> {
    throw new NotSupportedError(
      `ipinterfaces setDefault(${pythonRepr(name)}) does not exist upstream — api/ipinterfaces.py implements create (:151), delete (:176), set_address (:196) and set_mtu (:222) and no default verb, so this client refuses rather than inventing a command list. Use node.interfaces.setDefault for 'default interface <name>', or the per-field default* verbs`,
      { cause: name },
    )
  }

  /**
   * `interface <name>` + `ip address <value>` — pyeapi's `set_address(value=…)` (`:216-219`,
   * `test_api_ipinterfaces.py:81-86`). The value grammar is divergence 7; upstream's `value=None` arm,
   * which its own test pre-armed with a comment (`:102-105`) before pinning the negation this client names
   * {@link unsetAddress}, is DR-037's deleted fall-through.
   */
  async setAddress(name: string, value: string): Promise<void> {
    assertL3InterfaceName('setAddress', name)
    assertInterfaceAddress(value)
    await this.configureInterface(name, [this.commandBuilder(ADDRESS_KEYWORD, { value })])
  }

  /** `no ip address` — upstream's `set_address(disable=True)` (`:217-219`; `test_api_ipinterfaces.py:88-92`). */
  async unsetAddress(name: string): Promise<void> {
    assertL3InterfaceName('unsetAddress', name)
    await this.configureInterface(name, [this.commandBuilder(ADDRESS_KEYWORD, { mode: 'no' })])
  }

  /** `default ip address` — upstream's `set_address(default=True)` (`test_api_ipinterfaces.py:94-98`). */
  async defaultAddress(name: string): Promise<void> {
    assertL3InterfaceName('defaultAddress', name)
    await this.configureInterface(name, [this.commandBuilder(ADDRESS_KEYWORD, { mode: 'default' })])
  }

  /**
   * `interface <name>` + `mtu <value>` — pyeapi's `set_mtu(value=…)` (`:251-254`,
   * `test_api_ipinterfaces.py:110-115`, which pins the `68` and `65535` edges). This is the **same wire line**
   * `node.interfaces.setMtu` writes, and the two guards differ on purpose (divergence 5, **DR-097**).
   */
  async setMtu(name: string, value: number): Promise<void> {
    assertL3InterfaceName('setMtu', name)
    assertInterfaceMtu(value)
    await this.configureInterface(name, [this.commandBuilder(MTU_KEYWORD, { value })])
  }

  /** `no mtu` — upstream's `set_mtu(disable=True)` (`:252-254`; `test_api_ipinterfaces.py:117-121`), which is also what a value-less upstream call degrades to (`:135-137`'s own comment, DR-037). */
  async unsetMtu(name: string): Promise<void> {
    assertL3InterfaceName('unsetMtu', name)
    await this.configureInterface(name, [this.commandBuilder(MTU_KEYWORD, { mode: 'no' })])
  }

  /** `default mtu` — upstream's `set_mtu(default=True)` (`test_api_ipinterfaces.py:123-127`). */
  async defaultMtu(name: string): Promise<void> {
    assertL3InterfaceName('defaultMtu', name)
    await this.configureInterface(name, [this.commandBuilder(MTU_KEYWORD, { mode: 'default' })])
  }
}
