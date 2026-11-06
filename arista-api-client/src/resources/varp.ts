/**
 * `varp` — the virtual-ARP (VMARP) surface, W2b (#38): the global `ip virtual-router mac-address` line,
 * the per-interface `ip virtual-router address` lines under `interface …` sections, and the reads/writes
 * over both. Built on the M7 (#9) framework like every other resource module (`Entity`,
 * `EntityCollection`, `ResourceBase.configSections` / `configure`, `parseBlock`, `valuesAfterKeyword`,
 * the DR-026 `Node` memo, the registry).
 *
 * Port of `pyeapi/api/varp.py` (213 lines, BSD-3-Clause, Arista Networks — DR-001). Every `pyeapi` range
 * below was opened in the pinned clone `/home/svaj/development/arista/pyeapi` (1.0.4-rc0, `develop` @
 * `6816d9e`) on 2026-11-05, and every behavioural claim marked **probe** is a run of the real classes over
 * `Node(None)` with `_running_config` set and `node.config` mocked — the same harness pyeapi's own unit
 * tests use (`test/lib/testlib.py:73-84`) — not what the docstrings say. Nothing here reads EOS image
 * sources and nothing here claims what the DCS-7050TX-64 accepts: unit tests never reach a device, so
 * every EOS-side rule reads "unverified on hardware, M12 (#14) to capture". `docs/features.md` carries
 * `Virtual ARP / virtual-router` as an open item, which is the product framing: this module is the client
 * half, the device half is a capture question.
 *
 * | pyeapi (verified refs) | here |
 * |---|---|
 * | `Varp(EntityCollection)` (`:53`) with the `_interfaces` memo (`:55-57`) and the `interfaces` **property** (`:59-63`); `instance(node)` returns a `Varp` (`:202`) | {@link VarpResource} — one `Node`-bound row in `RESOURCE_FACTORIES`, and the {@link VarpResource.interfaces} getter holds the one {@link VarpInterfacesResource} it hands out (the registry already memoises the parent per `Node`, DR-052, so upstream's inner memo has nothing left to cache) |
 * | `Varp.get` (`:66-93` → `_parse_mac_address` + `_parse_interfaces`), and the record docstring's shape (`:79-90`) | {@link VarpResource.get} — one `show running-config`, one record. Upstream's `EntityCollection` base is inherited but never implemented (`getall`/`create`/`delete`/`default` are absent, and `__call__` would raise `NotImplementedError`); here that half is simply not on the type (DR-068: the surface says what exists) |
 * | `_parse_mac_address` (`:95-100`): `re.compile(r'^ip\svirtual-router\smac-address\s((?:[a-f0-9]{2}:){5}[a-f0-9]{2})$', re.M)` (`:96-97`) with `.search(self.config)` — the whole config text, first hit, else `None` | {@link readMacAddress} over the **chunked document's section keys** ({@link MAC_KEY}), so a body line cannot vote (divergence 1); a `mac-address` line the grammar cannot read is a {@link ConfigParseError}, not a silent `None` (divergence 2) |
 * | `_parse_interfaces` (`:102-104`): builds a **second** `VarpInterfaces(self.node)` and calls `getall()` | the same table through {@link readInterfaces} — one section walk, zero extra reads (DR-030) |
 * | `set_mac_address(mac_address=None, default=False, disable=False)` (`:106-141`): validates only the value arm, re-reads the **current** mac into the command for the negating arms (`:135-138`), then `command_builder` + `configure` (`:139-141`) | {@link VarpResource.setMacAddress} / {@link VarpResource.unsetMacAddress} / {@link VarpResource.defaultMacAddress} — DR-037 turns the two flags into two methods, so the arms that upstream can contradict each other cannot be requested at all (divergence 4). Every command text is reproduced verbatim, current-mac suffix included (row 165) |
 * | `VarpInterfaces(EntityCollection)` (`:144`), `get(name)` (`:148-157`: `get_block('interface %s' % name)`, `None` when absent) | {@link VarpInterfacesResource.get} — an **exact** section-key match (divergence 6), `undefined` for a miss (DR-027) |
 * | `getall()` (`:159-166`): `re.compile(r'^interface\s(Vlan\d+)$', re.M)` (`:161`) over the whole config, then one `get()` **per hit** | {@link VarpInterfacesResource.getAll} — one read over the section keys, Vlan-only parity kept (divergence 1) |
 * | `set_addresses(name, addresses=None, default=False, disable=False)` (`:168-194`): `interface %s` opener, then one of the four arms; the diff arm reads `self.get(name)['addresses']` inside `try/except Exception` (`:178-182`) and loops two `set(...).difference(...)`s (`:185-190`); **no `exit`** | {@link VarpInterfacesResource.setAddresses} / {@link VarpInterfacesResource.unsetAddresses} / {@link VarpInterfacesResource.defaultAddresses} — same texts; removals in device order, adds in caller order, deduped, one transaction (divergence 8). An unchanged list sends **nothing** here (row 166) |
 * | `_parse_virtual_addresses(config)` (`:196-198`): `^\s+ip\svirtual-router\saddress\s(\S+)$` (`:197-198`) | {@link readAddresses} — `valuesAfterKeyword` (`config-block.ts`) over the parsed block **body**, so the keyword is cut at the keyword and an unreadable value is reported (divergence 7) |
 * | the `{addresses: {}}` seed that `get` overwrites (`:155`) | `VarpInterface.addresses`, always a list; `[]` when the interface has no VARP address (parity with `findall` → `[]`; probe: `get('Vlan4003')` answers `{'addresses': []}`) |
 *
 * ## Upstream's own suite, and what porting it meant
 *
 * `pyeapi/test/unit/test_api_varp.py` — **17** test methods (`grep -n 'def test'` on 2026-11-05):
 * `TestApiVarp` (`:44-101`, 10) and `TestApiVarpInterfaces` (`:103-148`, 7). Their spans:
 * `test_instance` (`:51-53`), `test_get` (`:55-60`), `test_get_interfaces_none` (`:62-65`),
 * `test_get_interfaces_already_defined` (`:67-70`), `test_set_mac_address_with_value` (`:72-76`),
 * `_with_positional_value` (`:78-82`), `_with_disable` (`:84-87`), `_with_no_value` (`:89-91`),
 * `_with_bad_value` (`:93-95`), `_with_default` (`:97-100`); `test_get_with_no_interface` (`:110-114`),
 * `test_add_address_with_value` (`:116-120`), `_when_interface_does_not_exist` (`:122-127`),
 * `_with_no_value` (`:129-132`), `_with_empty_list` (`:134-137`), `_with_default` (`:139-142`),
 * `_with_disable` (`:144-147`). Note the file name again: this lane's brief cited `test_api_varp.py`
 * helpers (`get_varp` / `get_varp_interfaces` / `VarpAddresses` / `set_address` at `:110-:206`) that **do
 * not exist** upstream — `varp.py` has no module-level helpers, no `VarpAddresses` class and no
 * `set_address`; the spans above are the real ones.
 *
 * Ported as behaviour, because several upstream assertions pin answers this client refuses to give:
 *  - `test_instance` (`:51-53`) — the `varp` row in `RESOURCE_FACTORIES` plus `Node.varp` (DR-006/DR-052);
 *    `test_get` (`:55-60`) — one record with both halves, and `test_get_interfaces_none` /
 *    `_already_defined` (`:62-70`, which call the `interfaces` **property** and then `()` it, i.e.
 *    `EntityCollection.__call__` → `getall()`, `abstract.py:208-209`) are the two paths of the memo below,
 *    asserted as identity of `node.varp.interfaces` plus one read for the table.
 *  - `test_set_mac_address_with_value` / `_with_positional_value` (`:72-82`) — one method here, so the two
 *    spellings collapse; `ip virtual-router mac-address aa:bb:cc:dd:ee:ff` pinned verbatim.
 *  - `test_set_mac_address_with_disable` / `_with_default` (`:84-87`, `:97-100`) — both texts pinned
 *    verbatim **with the current mac appended**: `no ip virtual-router mac-address 00:11:22:33:44:55` and
 *    `default ip virtual-router mac-address 00:11:22:33:44:55` (probe). That suffix is why these two verbs
 *    read the config first when the switch has a value, and when it does not they send the bare command
 *    (probe) — row 165.
 *  - `test_set_mac_address_with_no_value` (`:89-91`) and `_with_bad_value` (`:93-95`) assert `ValueError`;
 *    here a `MAC`-shaped refusal is a `NotSupportedError` naming the value (DR-005/DR-010 — no new error
 *    class), and the guard is **end-anchored**, which upstream's is not: probe —
 *    `set_mac_address('aa:bb:cc:dd:ee:ffXX')` is accepted upstream and writes that exact text, while
 *    `'AA:BB:CC:DD:EE:FF'` raises (so an uppercase mac is unwritable **and** unreadable, probe: reading a
 *    config that writes `AA:BB:CC:DD:EE:FF` answers `mac_address: None`). Divergences 3 and 4.
 *  - `test_get_with_no_interface` (`:110-114`) — with `self.config = ''`, `get('Vlan1000')` is `None`;
 *    `undefined` here (DR-027), and `test_add_address_when_interface_does_not_exist` (`:122-127`) pins the
 *    other half: writing to an interface with no section still sends `['interface Vlan10', 'ip
 *    virtual-router address 1.1.1.4']`, so "no section" is not "no interface" and is **not** a
 *    `NotFoundError` (probe: upstream reaches it by swallowing `TypeError: 'NoneType' object is not
 *    subscriptable` in the bare `except Exception` at `:181-182`).
 *  - every `set_addresses` text in `:116-147` is reproduced verbatim, including the absence of a trailing
 *    `exit` and the removal-before-add shape. Upstream's own diff test pins one removal (`1.1.1.2`) and one
 *    add (`1.1.1.4`) because a one-element set has one order; the multi-change order is Python's hash
 *    order — probe over the five-address fixture:
 *    `no 1.1.2.4 / no 1.1.2.2 / no 1.1.2.5 / no 1.1.2.3 / add 9.9.9.9 / add 1.1.2.1`, i.e. neither device
 *    nor caller order. Here removals follow device order and adds follow caller order (row 166), the same
 *    call `vlans.ts` divergence 11 made.
 *  - `test_add_address_with_no_value` (`:129-132`) and `_with_empty_list` (`:134-137`) are two different
 *    arms upstream merges into "no addresses": the bare `no ip virtual-router address` and the per-address
 *    negation of every address the interface has. Here they are two named verbs —
 *    {@link VarpInterfacesResource.unsetAddresses} and
 *    {@link VarpInterfacesResource.setAddresses}`(name, [])`, each pinned.
 *
 * ## Divergences this file owns (raw material for MIGRATION.md §5; rows 164-166 are this lane's VARP half)
 *
 * 1. **the table is Vlan-only, and both readers know it.** Upstream's collection scan is
 *    `^interface\s(Vlan\d+)$` (`:161`), while its per-name read takes **any** interface
 *    (`get_block('interface %s')`, `:149`). Probe over a routed-port config:
 *    `getall()` answers `{}` for an `interface Ethernet1` carrying `ip virtual-router address 10.99.0.2`,
 *    and `get('Ethernet1')` answers that address. The committed fixture
 *    `test/fixtures/config/varp-virtual-router.conf` keeps that exact shape, so the asymmetry is pinned by
 *    data rather than invented. Here both halves keep the Vlan-only rule for `getAll`, and
 *    {@link VarpInterfacesResource.get} answers any `interface …` section the switch has — which means
 *    `getAll()` is **not** the truth about VARP state, and {@link VarpResource.get}'s record says so by
 *    being documented as the VLAN table. Whether the 7050TX-64 runs VARP on routed ports is unverified on
 *    hardware, M12 (#14) to capture; widening `getAll` is that capture's call, not this module's (row 164).
 * 2. **a section the switch wrote, this client reads — and a line it cannot read is reported.** Both
 *    upstream readers scan the **whole config text** with `re.M` (`:96-97` for the mac, `:197-198` inside
 *    the block for the addresses). Probe: an `ip virtual-router mac-address 11:22:33:44:55:66` line written
 *    at column 0 inside a `banner login` body is answered as the device's `mac_address`, because banner
 *    bodies go to column 0 (`client.py:747-752`) and `search` has no structural idea of a section. Here the
 *    mac comes from the chunked document's indent-0 **keys** and the addresses come from one parsed block
 *    body (`config/chunk.ts`, DR-030), so a banner body line and an indented copy cannot speak for VARP —
 *    the same fix `vlans.ts` divergence 3 made for VLANs. A `mac-address` line whose remainder
 *    this client cannot read (empty, uppercase hex, dashes instead of colons) is a {@link ConfigParseError}
 *    naming the key, where upstream answers `None`, i.e. "the switch has none" (row 165).
 * 3. **the MAC grammar is one value, and it is the same on both sides.** Upstream validates with
 *    `re.match(r'(?:[a-f0-9]{2}:){5}[a-f0-9]{2}', …)` (`:127-128`) — anchored at the start, **not** at the
 *    end, lowercase-only; and parses with the same charset plus `^…$` (`:96-97`). So
 *    `aa:bb:cc:dd:ee:ffXX` writes (probe) and can never be read back (`:96-97` rejects it too), and
 *    `AA:BB:CC:DD:EE:FF` is refused on the write (`ValueError`, probe) while also being invisible on the
 *    read (probe). Here {@link MAC_TOKEN} is one end-anchored pattern used by both paths: a value this
 *    client writes is by construction a value it can read back, uppercase/dashed forms are refused, and a
 *    device that wrote one is reported rather than answered as unconfigured (row 165).
 * 4. **the three arms of `set_mac_address` are three methods, because their flags can lie.** Upstream's
 *    guard `if default or disable and not mac_address:` (`:135`) parses as `default or (disable and not
 *    mac_address)`, and `command_builder` evaluates default before disable before value
 *    (`abstract.py:152-159`). Probe, on a device whose mac is `00:11:22:33:44:55`:
 *    `set_mac_address(mac_address='aa:bb:cc:dd:ee:ff', default=True)` → `default ip virtual-router
 *    mac-address 00:11:22:33:44:55` (the new value is **dropped**), and
 *    `set_mac_address(mac_address='aa:bb:cc:dd:ee:ff', disable=True)` → `no ip virtual-router mac-address`
 *    (the current one is **not** named, the opposite of the `disable=True`-alone text). Neither contradiction is
 *    expressible here; the argument type cannot arrive on the negating verbs at all (DR-037). The validation
 *    asymmetry disappears with them: upstream only validates in the value arm (`:125-134`), so
 *    `set_mac_address(disable=True)` reaches the wire unchecked — it happens to be harmless because that
 *    arm sends no value.
 * 5. **`unset`/`default` cost a read, and the text keeps upstream's suffix.** Both negating verbs re-read
 *    the config to build the command (`:135-138`), so `unsetMacAddress()` on a switch with
 *    `00:1b:1b:00:00:01` sends `no ip virtual-router mac-address 00:1b:1b:00:00:01`, and on a switch with
 *    nothing it sends `no ip virtual-router mac-address` (probe; `default` the same two ways). Reproduced
 *    verbatim rather than "cleaned up" to the bare form: `command_builder`'s output is what
 *    `test_api_varp.py:84-87`, `:97-100` pin, and a negation that names the current value is the safer of
 *    the two texts anyway. The read is part of the contract, and `setMacAddress` alone sends without reading
 *    (parity with `:139-141`, which never reads in the value arm).
 * 6. **an interface name is a name, not a pattern.** Upstream interpolates the caller's string into
 *    `get_block`'s regex (`:149` → `abstract.py:98` → `client.py:793-797`), so probe: with only
 *    `interface Ethernet1` configured, `get('Ether.*')` answers that interface's addresses. Here the
 *    section key has to equal `interface <name>`, and every write goes through
 *    `assertInterfaceName` (`validators.ts:296`) first — the same call `base.ts`'s `configureInterface`
 *    makes, and `varp.ts` does not re-implement it (row 164).
 * 7. **an address value the grammar cannot read is reported, and never re-written.** Upstream's read takes
 *    `(\S+)$` (`:197-198`), so `ip virtual-router address 2.2.2.2 junk` matches **no** line and silently
 *    disappears (probe: that line is absent from the answer), while `ip virtual-router address 1.1.1.1/24`
 *    is kept verbatim (probe). Here a keyword line whose remainder is not one token is a
 *    {@link ConfigParseError} naming the section (the {@link valuesAfterKeyword} cut makes the remainder
 *    visible instead of unmatched); a `/len` form is kept as written, so the switch's state is reportable,
 *    and the write side refuses to re-add anything that is not a bare dotted quad — such a token can still
 *    be **removed**, because the removal operand is the device's own text. Read-side tolerance plus
 *    write-side refusal is the same split `vlans.ts` divergence 8 records (row 166).
 * 8. **the write surface says what it means, and an unchanged set writes nothing.** Upstream's
 *    `set_addresses(name)` with no `addresses` sends the bare `no …` (`:191-192`), and
 *    `addresses=[]` sends the per-address negations (`:185-186`) — probe: `set_addresses('Vlan4001',
 *    addresses=[])` → `['interface Vlan4001', 'no ip virtual-router address 1.1.1.2']` — while a set that
 *    already matches still sends the opener: probe `['interface Vlan4002']`, one `configure` transaction
 *    that changes nothing. Here the three arms are three verbs, `[]` is exactly the per-address arm, a
 *    duplicate in the caller's list is deduped (upstream's `set(...)` dedupes too, by accident), and an
 *    unchanged list sends **nothing at all**. `create` / `delete` / `setDefault` — which the base class
 *    requires and `varp.py` never implements — are mapped onto those texts rather than invented:
 *    {@link VarpInterfacesResource.create} enters the submode and writes the caller's addresses, and
 *    {@link VarpInterfacesResource.delete} is the `no ip virtual-router address` arm, **not** `no
 *    interface …` (that verb lives in `interfaces.ts`). DR-095 records the mapping, because "delete" on an
 *    interface-scoped collection reads like destroying an interface (row 166).
 *
 * ## What is NOT claimed
 *
 * Whether VARP exists on every port on the 7050TX-64, whether the CLI takes a `/len` form of
 * `ip virtual-router address`, what it writes for `default ip virtual-router address`, and whether
 * `no ip virtual-router mac-address` needs the value argument are all **unverified on hardware,
 * M12 (#14) to capture**. `docs/features.md` keeps the feature open. The fixtures under
 * `test/fixtures/config/varp-virtual-router.conf` are hand-authored per that directory's
 * `manifest.json.provenance` (`deviceVerified: false`), modelled on pyeapi's own
 * `test/fixtures/running_config.varp` — which is vendor test data, not a capture.
 */

import { ConfigParseError, NotSupportedError } from '../errors'
import { pythonRepr } from '../internal/wire'
import { lstrip, parseBlock } from '../config/text'
import { Entity, EntityCollection } from './base'
import { commandBuilder, submodeCommands } from './command-builder'
import { assertInterfaceName } from './validators'
import type { ConfigLine } from '../config/text'
import type { ConfigSections } from '../config/chunk'
import type { Node } from '../command-layer'
import type { ResourceTable } from './types'

/** The global setting's command stem — pyeapi's `base_command` (`varp.py:124`). */
const MAC_KEYWORD = 'ip virtual-router mac-address'

/** The per-interface command stem, `:175`/`:177`/`:186`/`:190`/`:192` and the `:197-198` read. */
const ADDRESS_KEYWORD = 'ip virtual-router address'

/**
 * A section key carrying the global mac-address line. Upstream finds it by scanning the whole config text
 * with `^ip\svirtual-router\smac-address\s<mac>$` (`:96-97`); here it is a key of the chunked document, so
 * an indented copy or a banner body line cannot vote (divergence 2). The `<mac>` half is
 * {@link MAC_TOKEN}'s charset — `[a-f0-9]`, as upstream has it — and the remainder group exists so an
 * unreadable value is reported rather than answered as `None` (divergence 3).
 */
const MAC_KEY = /^ip virtual-router mac-address(?:\s+(.*))?$/u

/** Which interfaces {@link VarpInterfacesResource.getAll} reads — pyeapi's `^interface\s(Vlan\d+)$` (`:161`). */
const VLAN_INTERFACE_KEY = /^interface (Vlan\d+)$/u

/** A MAC this client both writes and reads: end-anchored, colon-separated, lowercase (divergence 3). */
const MAC_TOKEN = /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/u

/** One address as the switch wrote it: a single token, no inner whitespace (divergence 7). */
const ADDRESS_TOKEN = /^[^\s]+$/u

/** A dotted-quad IPv4 address, each octet 0-255 — the only form this module will **add** (divergence 7). */
const IPV4 = /^(?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])(?:\.(?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])){3}$/u

/** A rejected caller argument — the `refuse` shape the sibling resources use (DR-053, no new error class). */
function refuse(label: string, value: unknown, because: string): never {
  throw new NotSupportedError(`varp: invalid ${label} ${pythonRepr(value)} — ${because}`, { cause: value })
}

/** Refuse a MAC the read side could not report back (divergence 3: write the set the reader can read). */
function assertMacAddress(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !MAC_TOKEN.test(value)) {
    refuse('virtual-router mac address', value, 'expected six lowercase hex octets as aa:bb:cc:dd:ee:ff — pyeapi anchors this pattern only at the start (varp.py:127-128), so probe: set_mac_address("aa:bb:cc:dd:ee:ffXX") writes that text and the same value can never be read back (varp.py:96-97); an uppercase form is rejected there too, so both spellings are refused here')
  }
}

/** Refuse a VARP address the writer would not recognise. */
function assertAddress(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !IPV4.test(value)) {
    refuse('virtual-router address', value, 'expected a dotted-quad IPv4 address (each octet 0..255) — pyeapi checks nothing on this path: set_addresses interpolates the caller string straight into the command (varp.py:188)')
  }
}

/** A device line this client cannot model (divergences 2 and 7). */
function cannotParse(sectionKey: string, found: string, because: string): never {
  throw new ConfigParseError(`varp: cannot read ${pythonRepr(found)} in ${pythonRepr(sectionKey)} — ${because}`, { sectionKey, shortLine: found })
}

/**
 * The global virtual-router MAC address, or `undefined` when the switch has no such line —
 * `Varp._parse_mac_address` (`:95-100`) minus its whole-text scan (divergence 2).
 *
 * First matching key in document order wins, which is upstream's `.search` semantics (`:98`) — the two
 * agree because the chunker's keys are in document order (`client.py:737-771`). A key that spells the
 * command but not a readable value is reported: `mac_address: None` would tell an operator the switch has
 * no virtual-router MAC when it has one this client cannot name (divergence 3).
 */
function readMacAddress(sections: ConfigSections): string | undefined {
  for (const key of sections.keys()) {
    const match = MAC_KEY.exec(key)
    const value = match?.[1]
    if (match === null) continue
    if (value === undefined) cannotParse(key, key, 'the line carries no mac address — pyeapi requires whitespace plus six hex octets here and otherwise answers mac_address None, i.e. "the switch has none" (varp.py:96-99)')
    if (!MAC_TOKEN.test(value)) cannotParse(key, key, `the value ${pythonRepr(value)} is not six lowercase hex octets (aa:bb:cc:dd:ee:ff) — upstream's pattern is the same charset, so it answers mac_address None for this line and refuses to write it back (probe; varp.py:96-97, :127-128)`)
    return value
  }
  return undefined
}

/**
 * The `ip virtual-router address` values of one interface body, in device order (divergence 7).
 *
 * The keyword cut is the same one `valueAfterKeyword`/`valuesAfterKeyword` make (`config-block.ts:127-160`)
 * — the keyword, then the whitespace run — except that it is inlined here so the **offending line** can be
 * named in the parse failure, which `valuesAfterKeyword` cannot report: it hands back values, not lines.
 * A bare `ip virtual-router address` (no value) contributes nothing, which is what that helper does too and
 * what upstream's `\S+$` requires (`:197-198`).
 */
function readAddresses(body: readonly ConfigLine[], sectionKey: string): readonly string[] {
  const addresses: string[] = []
  for (const line of body) {
    if (!line.text.startsWith(ADDRESS_KEYWORD)) continue
    const rest = line.text.slice(ADDRESS_KEYWORD.length)
    if (rest.length > 0 && !/^\s/u.test(rest)) continue
    const value = lstrip(rest)
    if (value.length === 0) continue
    if (!ADDRESS_TOKEN.test(value)) {
      cannotParse(sectionKey, line.text, `this address line carries more than one token — upstream's read requires the value to end the line (\\S+$, varp.py:197-198), and probe confirms such a line simply vanishes from its answer; guessing \`1.1.1.1\` out of \`1.1.1.1 junk\` would be inventing device state`)
    }
    addresses.push(value)
  }
  return addresses
}

/** Every Vlan interface with VARP state — pyeapi's `VarpInterfaces.getall` (`:159-166`) over section keys. */
function interfacesFromSections(sections: ConfigSections): Map<string, VarpInterface> {
  const found = new Map<string, VarpInterface>()
  for (const [key, sectionText] of sections) {
    const header = VLAN_INTERFACE_KEY.exec(key)
    const name = header?.[1]
    if (header === null || name === undefined) continue
    const addresses = readAddresses(parseBlock(sectionText).body, key)
    found.set(name, { name, addresses })
  }
  return found
}

/**
 * One interface's VARP record. `name` is repeated alongside the key it is stored under, as `Acl.name` and
 * `Switchport.interfaceName` do — upstream's record is only `{addresses: […]}` (`:155`, `:156`).
 *
 * {@link addresses} is whatever the switch wrote after the keyword, in device order, and is empty when the
 * interface has no virtual-router address (probe: `VarpInterfaces.get('Vlan4003')` answers
 * `{'addresses': []}` — a section that exists with none). A token carrying a `/len` is kept as written
 * (divergence 7).
 */
export interface VarpInterface {
  /** The interface the `interface …` section names. */
  readonly name: string
  /** The `ip virtual-router address` values, in device order. */
  readonly addresses: readonly string[]
}

/**
 * The whole VARP picture: one global knob plus the per-interface table. Port of `Varp.get`'s record
 * (`:66-93`), whose docstring shape (`:79-90`) is the only contract upstream states — `mac_address` here is
 * absent rather than `None` when the switch has no such line (DR-027), and `interfaces` is up to date
 * because both halves come from the same read.
 */
export interface VarpSettings {
  /** The `ip virtual-router mac-address` value, absent when the switch has none. */
  readonly macAddress?: string
  /** The Vlan interfaces with VARP state, keyed by interface name in document order (divergence 1). */
  readonly interfaces: ResourceTable<string, VarpInterface>
}

/**
 * What {@link VarpInterfacesResource.create} may give the new VARP interface. Upstream has no `create` at
 * all on this class, so this bag is a deliberate client-side surface mapped onto the address arm of
 * `set_addresses` (`:189-190`) — DR-095.
 *
 * A type alias rather than an interface for the reason `VlanAttrs` gives: an object-type literal gets the
 * implicit index signature `EntityCollection`'s attribute parameter needs (`types.ts:67`), and this bag
 * deliberately carries a list, which that constraint cannot express — so the class pins its attribute
 * parameter to `Record<string, never>` and this type arrives on {@link VarpInterfacesResource.create}
 * alone.
 */
export type VarpAttrs = {
  /** The addresses to write inside the new interface's submode, in caller order. */
  readonly addresses?: readonly string[]
}

/**
 * `node.varp` — the global half of VARP, and the door to {@link VarpInterfacesResource}. Port of
 * `Varp(EntityCollection)` (`:53-141`) with the `instance(node)` factory (`:202`) replaced by the registry
 * row (DR-006/DR-052).
 *
 * Upstream extends `EntityCollection` and implements **none** of it: no `getall`, no `create`, no `delete`,
 * no `default`, so `node.api('varp')` inherits four `NotImplementedError` methods and a `__call__` that
 * raises (`abstract.py:208-224`). That is why this class extends `Entity` — one global record, always an
 * answer — and hands the collection-shaped half to {@link VarpInterfacesResource}. The `interfaces()`
 * calls in `test_api_varp.py:62-70` are the property plus upstream's `__call__` → `getall()`, which here
 * are an explicit getter and `getAll()` (DR-004).
 */
export class VarpResource extends Entity<VarpSettings> {
  private readonly interfacesResource: VarpInterfacesResource

  constructor(node: Node) {
    super(node)
    // pyeapi builds this object lazily and caches it in `_interfaces` (`:55-63`, probe: two `interfaces`
    // accesses answer the same object). The per-`Node` registry memo already makes `node.varp` one object,
    // so holding one child here gives the same identity with no lazy branch to test.
    this.interfacesResource = new VarpInterfacesResource(node)
  }

  /**
   * The interfaces carrying virtual-router addresses — pyeapi's `interfaces` **property** (`:59-63`), which
   * is the object its `_parse_interfaces` (`:102-104`) separately rebuilds on every `get()`. Here one
   * instance, and its reads ride the same `Node` memo.
   */
  get interfaces(): VarpInterfacesResource {
    return this.interfacesResource
  }

  /**
   * The global MAC plus the per-interface table, in one read — `Varp.get` (`:66-93`). Upstream pays more:
   * `self.config` re-runs a `show running-config` on each access (`abstract.py:74-76`, row 15) and its
   * `_parse_interfaces` constructs a **second** `VarpInterfaces` whose `getall` then does one `get_block`
   * per interface (`:103` → `:159-166` → `:149` → `client.py:792-797`).
   */
  override async get(): Promise<VarpSettings> {
    const sections = await this.configSections()
    const macAddress = readMacAddress(sections)
    const interfaces = interfacesFromSections(sections)
    return { ...(macAddress === undefined ? {} : { macAddress }), interfaces }
  }

  /**
   * Set the global virtual-router MAC address — `ip virtual-router mac-address <mac>`, which is what
   * `set_mac_address(mac_address=…)` sends through `command_builder` (`:139`, `abstract.py:158-159`) and
   * what `test_api_varp.py:72-82` pins. Zero reads first, as upstream has none on this arm.
   *
   * @throws {NotSupportedError} `macAddress` is not six lowercase hex octets. Upstream raises `ValueError`
   *   for `None` and `'0011.2233.4455'` (`:125-134`, and its own tests `:89-95` assert exactly that); the
   *   taxonomy has no `ValueError`, and a non-string argument reaches upstream as
   *   `TypeError: expected string or bytes-like object` (probe) — both become this (DR-005/DR-010).
   */
  async setMacAddress(macAddress: string): Promise<void> {
    assertMacAddress(macAddress)
    await this.configure(commandBuilder(MAC_KEYWORD, { value: macAddress }))
  }

  /**
   * Remove the global virtual-router MAC address. Upstream spells this `set_mac_address(disable=True)`
   * (`:106`), and the text it sends **names the value it is removing** — `no ip virtual-router mac-address
   * 00:11:22:33:44:55`, probe and `test_api_varp.py:84-87` — because it reads the current value into the
   * command stem first (`:135-138`). That read is reproduced, including the second shape: a switch with no
   * MAC configured gets the bare `no ip virtual-router mac-address` (probe). Row 165.
   */
  async unsetMacAddress(): Promise<void> {
    await this.configure(negatedMacAddress(await readMacAddress(await this.configSections()), 'no'))
  }

  /**
   * Return the global setting to the device default — `set_mac_address(default=True)` (`:106`), whose text
   * is `default ip virtual-router mac-address <current>` when the switch has one and the bare command when
   * it does not (probe; `test_api_varp.py:97-100`). Upstream's `default=True` **also** drops a
   * `mac_address` argument the caller passed (probe) — a contradiction the three-method split makes
   * unrepresentable (divergence 4).
   */
  async defaultMacAddress(): Promise<void> {
    await this.configure(negatedMacAddress(await readMacAddress(await this.configSections()), 'default'))
  }
}

/** `no`/`default` + the mac-address stem, with the current value appended when the switch has one (`:135-138`). */
function negatedMacAddress(current: string | undefined, mode: 'no' | 'default'): string {
  // Upstream only suffixes when the re-read found a value (`:136-138`), and its `command_builder` puts
  // `default`/`no` in front of whatever stem it was handed (`abstract.py:152-155`).
  return commandBuilder(current === undefined ? MAC_KEYWORD : `${MAC_KEYWORD} ${current}`, { mode })
}

/**
 * `node.varp.interfaces` — the per-interface half, port of `VarpInterfaces(EntityCollection)` (`:144-198`).
 *
 * Upstream has `get`/`getall`/`set_addresses` only; the collection base's other four methods (`:214-224`)
 * stay inherited and raising. This class implements the base's contract honestly by mapping `create` /
 * `delete` / `setDefault` onto the three arms of `set_addresses` — documented on each verb, and
 * specifically **not** interface lifecycle: `delete` removes the VARP addresses, `no interface …` lives in
 * `interfaces.ts` (DR-095).
 */
export class VarpInterfacesResource extends EntityCollection<VarpInterface, string, Record<string, never>> {
  /**
   * Every **Vlan** interface with VARP state, keyed by name in document order — pyeapi's `getall`
   * (`:159-166`), with its `^interface\s(Vlan\d+)$` scan (`:161`) kept as the rule (divergence 1) and its
   * one-`get_block`-per-hit cost removed (DR-030: one request for the whole table, asserted in the tests).
   */
  override async getAll(): Promise<ResourceTable<string, VarpInterface>> {
    return interfacesFromSections(await this.configSections())
  }

  /**
   * One interface's VARP record, or `undefined` — `get(name)` (`:148-157`), whose `get_block` answers `None`
   * for a section the switch does not have (`:150-152`; probe over an empty config:
   * `get('Vlan1000')` → `None`, which `test_get_with_no_interface` asserts).
   *
   * Unlike {@link getAll}, this takes **any** interface name, because upstream does the same (`:149`):
   * probe — `get('Ethernet1')` answers the address on a routed port that `getall()` cannot see. Divergence 1
   * is pinned by the committed fixture rather than closed by widening the table.
   */
  override async get(name: string): Promise<VarpInterface | undefined> {
    assertInterfaceName(name)
    const sections = await this.configSections()
    const key = `interface ${name}`
    const sectionText = sections.get(key)
    if (sectionText === undefined) return undefined
    return { name, addresses: readAddresses(parseBlock(sectionText).body, key) }
  }

  /**
   * Give an interface virtual-router addresses: `interface <name>` plus one
   * `ip virtual-router address <addr>` line each — the add arm of `set_addresses` (`:189-190`) with the diff
   * skipped, since a new entry has nothing to diff against. Zero reads: unlike {@link setAddresses}, this
   * verb never looks at the device first.
   *
   * `attrs.addresses` empty or absent is a refusal, not a bare `interface <name>` transaction: writing no
   * address is not creating an entry, and upstream's no-op arm (`['interface Vlan4002']`, probe) is
   * something this class does not offer (divergence 8, DR-095).
   */
  override async create(name: string, attrs?: VarpAttrs): Promise<void> {
    assertInterfaceName(name)
    const addresses = attrs?.addresses
    if (addresses === undefined || addresses.length === 0) {
      refuse('addresses', addresses, 'create needs the addresses to give this interface — an `interface <name>` line on its own is VARP state no operator asked for (drift from pyeapi, which has no create on this class at all)')
    }
    addresses.forEach(assertAddress)
    await this.configure(submodeCommands(`interface ${name}`, addresses.map((address) => commandBuilder(ADDRESS_KEYWORD, { value: address }))))
  }

  /**
   * Remove the interface's virtual-router addresses: `interface <name>` + `no ip virtual-router address` —
   * upstream's `set_addresses(name)` arm with no arguments (`:191-192`), pinned by
   * `test_api_varp.py:129-132`. It does **not** remove the interface; that is
   * `node.interfaces`/'`no interface …`' territory, and reading this verb as interface lifecycle would be
   * a destructive surprise (DR-095).
   */
  override async delete(name: string): Promise<void> {
    assertInterfaceName(name)
    await this.configure(submodeCommands(`interface ${name}`, [commandBuilder(ADDRESS_KEYWORD, { mode: 'no' })]))
  }

  /** `interface <name>` + `default ip virtual-router address` — the `default=True` arm (`:174-175`, test `:139-142`). */
  override async setDefault(name: string): Promise<void> {
    assertInterfaceName(name)
    await this.configure(submodeCommands(`interface ${name}`, [commandBuilder(ADDRESS_KEYWORD, { mode: 'default' })]))
  }

  /**
   * Make the interface's virtual-router addresses exactly `addresses`, in one transaction — upstream's
   * `set_addresses(name, addresses=[…])` diff (`:178-190`).
   *
   * Upstream reads the current list through `self.get(name)['addresses']` inside a bare
   * `except Exception` (`:179-182`, probe: on an absent section that is `TypeError: 'NoneType' object is
   * not subscriptable` → `[]`), then iterates two `set(...).difference(...)` loops, so with more than one
   * change the wire order is Python's hash order — probe over the five-address fixture:
   * `no 1.1.2.4 / 1.1.2.2 / 1.1.2.5 / 1.1.2.3` then `add 9.9.9.9 / 1.1.2.1`. Here the read is explicit,
   * removals follow **device** order, adds follow the **caller's** order, duplicates in the caller's list
   * collapse to one line each, and nothing at all is sent when the interface already matches (row 166).
   * An address this client read with a `/len` is negated with the device's own text and never re-added
   * (divergence 7). No `exit` line, because upstream sends none (`:172-192`) — matching how `vlans.ts` and
   * `interfaces.ts` close a submode on this client.
   */
  async setAddresses(name: string, addresses: readonly string[]): Promise<void> {
    assertInterfaceName(name)
    addresses.forEach(assertAddress)
    const current = (await this.get(name))?.addresses ?? []
    const wanted = new Set(addresses)
    const keep = new Set(current)
    const commands: string[] = []
    for (const address of current) {
      // The operand stays **in** the command stem, because `commandBuilder`'s `no` mode drops any `value`
      // it is handed (command-builder.ts, DR-037's precedence) — and upstream's removal text names the
      // address (`'no ip virtual-router address %s'`, `:186`). The device's own token is what gets negated,
      // even a `/len` form this client would refuse to add (divergence 7).
      if (!wanted.has(address)) commands.push(commandBuilder(`${ADDRESS_KEYWORD} ${address}`, { mode: 'no' }))
    }
    for (const address of addresses) {
      if (keep.has(address)) continue
      keep.add(address)
      commands.push(commandBuilder(ADDRESS_KEYWORD, { value: address }))
    }
    if (commands.length === 0) return
    await this.configure(submodeCommands(`interface ${name}`, commands))
  }

  /** {@link VarpInterfacesResource.delete}'s field-shaped twin — the same `no ip virtual-router address` text (DR-095). */
  async unsetAddresses(name: string): Promise<void> {
    await this.delete(name)
  }

  /** {@link VarpInterfacesResource.setDefault}'s field-shaped twin — the same `default ip virtual-router address` text. */
  async defaultAddresses(name: string): Promise<void> {
    await this.setDefault(name)
  }
}
