/**
 * `interfaces` — the M10a slice of `pyeapi/api/interfaces.py` (#12): the {@link InterfacesResource}
 * facade, the {@link BaseInterface} verbs it is built from, and the per-kind interface-name parser that
 * replaces M7's single regex.
 *
 * Port of `pyeapi/api/interfaces.py` (1,101 lines, BSD-3-Clause, Arista Networks — DR-001). This is the
 * first of the four slices PLAN.md §M10 splits the module into: **M10a** = `Interfaces` +
 * `BaseInterface` + the name parser; M10b = `EthernetInterface` (sflow / flowcontrol / vrf); M10c =
 * `PortchannelInterface` (members / LACP); M10d = `VxlanInterface`, deferred to wave 3. The parts of the
 * upstream file that belong to those slices are **not** ported or hinted at here.
 *
 * Every `pyeapi` range in this file was opened in the pinned clone
 * `/home/svaj/development/arista/pyeapi` (1.0.4-rc0, `develop` @ `6816d9e`) on 2026-11-04, and every
 * behavioural claim below is what the upstream code **actually does** — usually with the upstream unit
 * test that pins the same command text next to it — not what its docstring says. Nothing here cites EOS
 * image internals, and nothing claims what the DCS-7050TX-64 / 4.28.13.1M accepts: unit tests never reach
 * a device and this workspace has no readable CLI sources, so every EOS-side rule reads
 * "unverified on hardware, M12 (#14) to capture". Where a rule is **this client's** it says so (DR-057).
 *
 * | pyeapi (verified refs) | here |
 * |---|---|
 * | `Interfaces(EntityCollection)` (`:86-140`), whose `__getattr__`/`marshall` (`:117-139`) dispatch a method name to a per-kind instance chosen by `interface[0:2]` (`:120-127`, `INTERFACE_CLASS_MAP` `:1093-1097`) | {@link InterfacesResource} — one class, explicit verbs, and the per-kind question answered by {@link parseInterfaceName}'s `kind` (DR-006 does not port the dynamic dispatch; `validators.ts:11-19` records why) |
 * | `isvalidinterface` (`:81-83`): `re.match(r'([EPVLM][a-z-C]+)', value)` ∩ `VALID_INTERFACES` (`:71-78`) | `parseInterfaceName` / `isInterfaceName` / `assertInterfaceName` (`validators.ts`) — one anchored pattern per kind returning a discriminated union (PLAN.md §M10 "validation split") |
 * | `Interfaces.get` (`:92-93`) → `get_instance(name)[name]`, i.e. `__getitem__` → `get` (`abstract.py:211-212`) | {@link InterfacesResource.get} — a lookup in the same one-read table, so `get`/`getAll()` cannot disagree |
 * | `Interfaces.getall` (`:95-115`): `re.compile(r'(?<=^interface\s)(.+)$', re.M)` (`:108`) over the whole config, then `self.get(name)` per hit with an `if interface:` filter (`:111-114`) | {@link interfacesFromSections} over the chunked document's section keys (DR-055: the chunker, not a module regex, decides what is a top-level command) — divergence 1 |
 * | `BaseInterface.get` (`:147-177`): `get_block('^interface %s')` (`:170`), `if not config: return None` (`:171-172`), then `name` / `type='generic'` (`:174`) + two `_parse_*` merged with `dict.update` (`:175-176`) | {@link interfaceFromSection}; `type` (the answering **class**) is replaced by `kind` (what the name **is**) — divergence 2 |
 * | `_parse_shutdown` (`:179-191`): `'no shutdown' not in config` (`:190`) | {@link shutdownFromBlock} — a parsed body **command line**, three answers instead of two — divergence 3 |
 * | `_parse_description` (`:193-209`): `re.search(r'description (.+)$', config, re.M)` (`:206`), raw remainder, first match wins | {@link valueAfterKeyword} (`config-block.ts`) over the block body — the shared keyword extractor, so a value can no longer answer for another field (row 91's rule) — divergence 4 |
 * | `create` / `delete` / `default` (`:211-254`): `return self.configure('interface %s')` (`:226`) / `'no interface %s'` (`:243`) / `'default interface %s'` (`:254`) | {@link InterfacesResource.create} / {@link delete} / {@link setDefault} — same three command texts, no `True` to check (DR-005), plus the Ethernet refusal M10b owns — divergence 5 |
 * | `EthernetInterface.create` / `delete` (`:415-445`): `raise NotImplementedError` unless the name has a `.` (`:425-428`, `:441-444`); `test_api_interfaces.py:211-224` pins both | the refusal inside {@link assertPresentName} (divergence 5) |
 * | `set_encapsulation` (`:256-282`): `NotImplementedError` unless `'.' in name` (`:271-273`) and `name[0:2] in ['Et','Po']` (`:274-277`); `['interface %s']` (`:278`) + `command_builder('encapsulation dot1q vlan', str(vid), default, disable)` (`:279-281`) then `configure` (`:282`) | {@link setEncapsulation} / {@link unsetEncapsulation} / {@link defaultEncapsulation} — the prefix test becomes a consequence of the grammar, and there is no upstream reader for this field — divergence 6 |
 * | `set_description` (`:284-303`): `command_builder('description', …)` (`:301-302`) + `configure_interface` (`:303`) | `setDescription` / `unsetDescription` / `defaultDescription` (DR-037's mode table; `test_api_interfaces.py:107-124` pins all three texts) |
 * | `set_shutdown` (`:305-327`): `['interface %s']` (`:324`) + `command_builder('shutdown', value=True, default, disable)` (`:325-326`), with **`disable=True` as the default** (`:305`) | {@link shutdown} / {@link noShutdown} / {@link defaultShutdown} — PLAN's "`noShutdown` semantics via `disable`" box: upstream's no-argument call is the `no shutdown` arm, so the two intents are two named verbs |
 * | `EntityCollection` (`abstract.py:198-224`) `Mapping`/`__call__`/`__len__`/`__iter__`/`__getitem__` | `has` / `keys` / `entries` on `EntityCollection` (`base.ts`), one `getAll()` round trip each (DR-004, row 78) |
 * | `instance(api)` (`:1100-1101`), which `Node.api('interfaces')` reaches through a filesystem import (`client.py:927-950`) | the `RESOURCE_FACTORIES.interfaces` row plus `Node.interfaces` (DR-006/DR-052) |
 * | **no upstream twin** | {@link getStatus} and the `show interfaces status` half of {@link InterfacesResource.getAll} (DR-031's hybrid read) — divergence 8 |
 * | **no upstream twin** | the `mtu` field on the read and `setMtu` / `unsetMtu` / `defaultMtu` — the closest upstream code is a *different module and a different command*, `ipinterfaces.py:113-127` / `:222-256` — divergence 7 |
 *
 * Upstream's own suite is `test/unit/test_api_interfaces.py` — **72** test methods (re-counted by AST on
 * 2026-11-04), of which the M10a scope is `TestFunctions` (`:48-62`), `TestApiInterfaces` (`:65-91`) and
 * `TestApiBaseInterface` (`:94-171`): `test_isvalidinterface_returns_true` (`:50-53`),
 * `_returns_false` (`:55-58`), `test_instance` (`:60-62`), `test_get_interface_generic` (`:72-75`),
 * `test_get_interface_ethernet` (`:77-79`), `test_get_invalid_interface` (`:81-83`),
 * `test_proxy_method_success` (`:85-87`), `test_proxy_method_raises_attribute_error` (`:89-91`),
 * `test_get` (`:101-105`), `test_set_description_with_value` / `_with_no_value` / `_with_default`
 * (`:107-124`), `test_set_shutdown` / `_with_disable` / `_with_default` (`:126-142`) and the five
 * `test_set_encapsulation_*` (`:144-171`). Every command text they pin is reproduced verbatim in
 * `interfaces.test.ts`; the `AttributeError`/`NotImplementedError` answers are ported as typed
 * refusals, and the slices M10a excludes (`TestApiEthernetInterface` from `:174`,
 * `TestApiPortchannelInterface` from `:305`, `TestApiVxlanInterface` from `:429`) are not ported at all.
 * Upstream drives all of it through `EapiConfigUnitTest`, whose `MockConnection` answers `{}` to anything
 * it was not told about — here an unscripted request is a hard failure, so every batch below spells every
 * command (`testing/mock-transport.ts:83-88` compares a string matcher against the **whole joined command
 * list**, not a prefix).
 *
 * ## Divergences this file owns — numbered in MIGRATION.md §5 rows **99-106** (M10a's band)
 *
 * Mapping for a reviewer: 1→99, 2→100, 3→101, 4 and 10→102, 5→103, 6→104, 7→105, and 8/9/11/12→106.
 * Decisions taken here are **DR-067** (the per-kind grammar), **DR-068** (per-kind fields, never
 * per-kind objects) and **DR-069** (a recording of the exact command outranks an inferred spelling).
 * M10b/M10c continue the ledger at rows **123-130**, which PR #29 reserved for this issue.
 *
 * 1. **membership comes from the chunker, and a name must be one token.** Upstream regex-scans the whole
 *    config text with `(?<=^interface\s)(.+)$` (`:108`) under `re.M`, so *any* line that begins with the word
 *    is a name — a `banner` body line reading `interface Ethernet99` included, and M9 verified banner bodies
 *    are written at column 0 (its `vlans.ts` divergence 3, with upstream's own `vlan 1` banner line at
 *    `running_config.text:411`). Here the source is the chunked document (DR-055), whose banner handling
 *    swallows everything after a column-0 `banner …` until `EOF` (`src/config/chunk.ts:97-102`), so no banner
 *    body line is ever a section key. `(.+)` also keeps the **whole remainder**, so
 *    `interface link tracking group 1` is a name upstream will look up; here the identifier must be a single
 *    token, because a name this client cannot put into `interface <name>` cannot be an entry a UI can act on.
 *    Cost stated plainly: a header whose identifier is multi-token is **skipped**, and `show running-config`
 *    forms of that shape have never been captured here (DECISIONS.md open item 7, M12 #14).
 * 2. **`kind` replaces `type`, and the facade reads every kind the same way.** Upstream answers
 *    `type: 'generic'` / `'ethernet'` / `'portchannel'` / `'vxlan'` — the *class* that answered
 *    (`:174`, `:361`, `:609`, `:851`) — and `Interfaces.get` routes by `name[0:2]` (`:121`), a substring
 *    test that sends `Vlan1`, `Loopback0` and `Management1` to `BaseInterface` because the class map has
 *    only `Et`/`Po`/`Vx` rows (`:1093-1097`). Here {@link Interface.kind} is what the *name* is,
 *    read by the parser, and M10b/M10c will add the kind-specific **fields** (sflow, members) instead of a
 *    label. Consequence: `get('Ethernet1').kind === 'Ethernet'` on today's build, where upstream answers
 *    `type: 'ethernet'` only in M10b — the record's fields are the shared `BaseInterface` set either way.
 *    A name the grammar cannot read still gets a row, with `kind: null` (divergence 1's membership rule).
 * 3. **three answers for `shutdown`, not two.** `'no shutdown' not in config` (`:190`) is a substring test
 *    over the whole block, so it reads the bare command `shutdown` as "up" and **any** block without that
 *    exact line as "down" — including one that writes neither, and including one carrying
 *    `default shutdown`, a form upstream itself emits (`set_shutdown(name, default=True)`, `:325-326`;
 *    `test_api_interfaces.py:138-142` pins the text). That is not an edge case in the pinned fixture: of
 *    its 14 `interface` sections, 13 carry `no shutdown` and `interface Loopback2` (`:1600`) carries
 *    neither line — so upstream answers `shutdown: True` for a Loopback interface from the absence of a
 *    line alone, and its suite never looks at that section (`test_api_interfaces.py:72-75` checks
 *    `type` for `Loopback0` only). Here the reader takes the exact body commands `no shutdown` → `false`
 *    and `shutdown` → `true`, in device order, and answers **absent** when the block has neither:
 *    deriving "the EOS default" from config text is the unverifiable claim DR-057 refuses to make. What
 *    EOS writes for an administratively-down port, whether `default shutdown` survives into a
 *    running-config, and whether the interface's own `shutdown` line can appear inside a nested sub-mode
 *    are M12 (#14) captures; see divergence 10 for the body-line scoping that question decides.
 * 4. **fields cannot read each other, and a description is unquoted on the way in.** Upstream's
 *    `description (.+)$` (`:206`) is unanchored and runs over the whole block, so a line whose *value*
 *    contains the word `description` answers for the field and a quoted `description " WAN "` keeps its
 *    quotes. Here both `description` and `mtu` go through `valueAfterKeyword` (row 91's extractor: cut at
 *    the keyword, `lstrip`, `unquote`), which also means the **first** keyword line wins for `description`
 *    (upstream's `re.search` also takes the first, `:206`) and the same inner whitespace survives. The
 *    quoting rule both sides need is stated by {@link assertInterfaceDescription}: a value with outer
 *    whitespace or a `"` cannot survive a write/read cycle through this reader, so those inputs are refused
 *    (DR-057-style client rule; whether EOS quotes a description at all is an M12 capture).
 * 5. **create/delete refuse a physical Ethernet, and say who owns it.** Upstream's `BaseInterface.create`
 *    (`:211-226`) would send `interface Ethernet1` — the facade never reaches it for Ethernet because
 *    `EthernetInterface.create` raises `NotImplementedError` first (`:425-428`;
 *    `test_api_interfaces.py:211-224` pins that, and pins `interface Ethernet1.1` as the form it *does*
 *    send). Here the refusal is explicit in {@link assertPresentName} and subinterfaces are refused too,
 *    because the shared name guard still refuses the dotted form (open item 7) — so this client can create
 *    a Port-Channel / Vlan / Management / Loopback / Vxlan interface and cannot create any Ethernet form
 *    until M10b (#12) owns `EthernetInterface`. Upstream's `default interface Ethernet1` **is** ported
 *    (`:245-254`, pinned positive at `test_api_interfaces.py:191-209`).
 * 6. **`encapsulation` is read as well as written, and the kind rule is free.** Upstream writes
 *    `encapsulation dot1q vlan <vid>` with an `Et`/`Po`-prefix test (`:274-277`) and never reads the field
 *    back. The prefix test is what the per-kind grammar makes unnecessary: only the Ethernet and
 *    Port-Channel arms can carry a suffix at all, so "it parsed and it has a subinterface" *is* upstream's
 *    two conditions. Reading the field is new, and its refusals are reader-derived: the value must be a
 *    decimal VLAN id ({@link assertVlanId}), and the `default encapsulation dot1q vlan` line pyeapi's own
 *    fixture writes in `interface Ethernet1` (`test/fixtures/running_config.text:565`) — like its sibling
 *    `no l2-protocol encapsulation dot1q vlan 0` at `:566` — is **not** a value, because
 *    {@link valueAfterKeyword} anchors at the keyword's start. The positive form is in that fixture too,
 *    on the section it writes for a subinterface: `interface Ethernet48.2044` (`:1468`) carrying
 *    `encapsulation dot1q vlan 2044` (`:1473`), which is the round trip `interfaces.test.ts` pins.
 *    Whether the 7050TX-64 has subinterfaces at all is open item 7; nothing here claims it does.
 * 7. **`mtu` is a client-side addition with a client-side bound.** `interfaces.py` has no MTU verb at all
 *    — the closest code is `ipinterfaces.py:113-127` (`mtu (\d+)`, a truncated read) and `set_mtu`
 *    (`:222-256`), which validates `IP_MTU_MIN`(68) `<= value <= IP_MTU_MAX`(65535) (`:54-55`) for the
 *    **IP** MTU of a routed interface, and `68`/`9214`/`9216` appear nowhere in `interfaces.py`. PLAN.md
 *    §M10's "bounds 68..9214 … read from `show interfaces` rather than a hard-coded constant" is therefore
 *    not encodable here (DR-032), and inventing an L2 ceiling would be the failure DR-057 names. What this
 *    client encodes is reader-derivable only: a **positive safe integer** ({@link assertInterfaceMtu}),
 *    labelled in its own refusal message as client policy, with `0` refused because a zero MTU is exactly
 *    the falsy-value case DR-037 refuses (`set_mtu(0)` upstream produces `no mtu`, `abstract.py:158-161`).
 *    The device keeps the authority: every verb has a pinned `CommandError` path. `mtu` is read from the
 *    `mtu <n>` line (the form pyeapi's own fixture uses inside `interface Loopback0` at
 *    `test/fixtures/running_config.text:1573` and `interface Management1` at `:1922`) and reported as a non-decimal
 *    {@link ConfigParseError} rather than a truncation (contrast `ipinterfaces.py:126`).
 * 8. **the hybrid read never lets the enrichment decide existence.** {@link getAll} keys its table from
 *    the running-config sections, then *attaches* a `show interfaces status` row when the device answers
 *    the model. Reading the show first and driving from it would (a) inherit column spellings whose only
 *    capture is the **sibling** `show interfaces` command (`pyeapi/test/fixtures/show_interfaces.json`,
 *    vendor-shipped) while this command's own model membership stays a device question — DR-031's confirmed
 *    model-backed list does not include `show interfaces status` — and (b) strand a port the model lists but
 *    the config has no block for,
 *    for which this client has no honest `shutdown` answer. So: config = existence + configuration, status
 *    = operational enrichment, and a status failure of any kind (1003 with no JSON model and a text-only
 *    retry, 1002 on a unit without the command, a shape this reader cannot use) leaves the config table
 *    intact ({@link InterfaceStatusMode} `'auto'`). Since PR #29 merged, {@link statusRowsFrom} reads this
 *    command's **own captured shape** — the cEOS-lab 4.28.14M recording
 *    `test/fixtures/live/ceos-4.28.14M/show-interfaces-status.json` (`interfaceStatuses` / `linkStatus`),
 *    lab evidence only, `hardwareEvidence: "none"` per DR-043 — with the sibling command's names as the
 *    fallback; the 7050TX-64 spelling is still owed to the STATUS §3 sweep. `getStatus()` is the verb for a
 *    UI that wants to say "status unavailable" instead of showing nothing.
 * 9. **`getAll()` is 2-3 requests, not 1 — and `{ status: 'skip' }` is the way back to 1.** pyeapi pays a
 *    `section()` key scan plus two regex passes per interface (`:110-113` → `get` → `get_block`);
 *    M9's modules cost exactly one `show running-config`. Two reads here is the price of DR-031's hybrid,
 *    three on a unit whose show answers `1003` because M2's codec re-issues it with `format:'text'`
 *    (`internal/wire.ts:550-567`, DR-012). Every count is pinned in `interfaces.test.ts` and
 *    {@link InterfaceStatusMode} `'skip'` is the documented opt-out, so nothing pays for a column a screen
 *    does not show.
 * 10. **what the writers refuse, and how far a body line reaches.** Upstream validates no name on any
 *     `BaseInterface` verb (its `isvalidinterface` check lives in `marshall`, `:129-133`, the dispatch path
 *     DR-006 does not port — `set_description('Nope1', 'x')` happily sends `interface Nope1`), no
 *     description, and no encapsulation VLAN id. Here every verb calls {@link assertInterfaceName} (or
 *     {@link assertEncapsulationName}), and {@link assertInterfaceDescription} / {@link assertInterfaceMtu}
 *     / {@link assertVlanId} refuse what this client could not read back — DR-053's pattern, no new error
 *     class (DR-005/DR-010). The reads keep M9's scoping rule and its limitation: a field is a keyword
 *     match over **every** body line of the section (`valueAfterKeyword`, row 91), and `ConfigLine.indent`
 *     (`config/text.ts:112-113`) is deliberately not filtered, because M9's shipped extractors do not
 *     filter it either and a per-module divergence would be worse than a shared limitation. So a nested
 *     sub-mode of an interface carrying its own `mtu` / `shutdown` line would answer for the interface —
 *     which is exactly what pyeapi's whole-block substring and regex reads already do (`:190`, `:206`), and
 *     the pinned fixture proves such nesting is real config text: `management api http-commands` →
 *     `vrf default` → `default shutdown` (`test/fixtures/running_config.text:2131`). M12 (#14) must say
 *     whether interface sub-modes carry these commands; if they do, the fix is one indent bound in
 *     `config-block.ts` for every module, not a rule invented here.
 * 11. **`type`-shaped junk in a status row is absent, not zero.** A `null` mtu in JSON is `object` to
 *     `typeof`, so a `typeof === 'number'` test is what keeps {@link InterfaceStatus.mtu} honest; the wrong
 *     type reads as "not reported" (which a UI shows as unknown) rather than `0`, the value pyeapi's
 *     habit of `int()`-ing anything would produce.
 * 12. **`show interfaces status` answers a different map than `show interfaces`, and the reader takes the
 *     captured spelling first.** The only recording of this exact command in the evidence set is
 *     cEOS-lab 4.28.14M — `test/fixtures/live/ceos-4.28.14M/show-interfaces-status.json`
 *     (identity/redaction envelope in its own `metadata`, `hardwareEvidence: "none"`) — and it keys its rows
 *     `interfaceStatuses`, with the operational column spelled `linkStatus` (`"connected"`, matching the
 *     paired `--text` capture's `Status` column) and **no** `mtu`, `hardware` or `interfaceStatus` key at
 *     all. pyeapi's vendor-shipped `show_interfaces.json` capture of the *sibling* command uses `interfaces`
 *     / `interfaceStatus` / `hardware` / `mtu`. So {@link statusRowsFrom} looks both up in capture order
 *     ({@link STATUS_ROW_MAP_KEYS}) and reads the link column in capture order
 *     ({@link STATUS_LINK_COLUMNS}); when a reply carries both maps the recorded one wins, and the
 *     capture-only columns stay absent rather than being synthesised from `interfaceType` (which answers
 *     `EbraTestPhyPort` on that container — a PHY type, not the sibling capture's `ethernet` port-class).
 *     Whether 4.28.13.1M on the 7050TX-64 answers the same key set is a STATUS §3 capture, not an
 *     assumption; nothing here claims the container spelling is the hardware spelling (DR-043).
 */
import { ConfigParseError, NotSupportedError, ProtocolError } from '../errors'
import { pythonRepr } from '../internal/wire'
import { parseBlock } from '../config/text'
import { valueAfterKeyword } from './config-block'
import { EntityCollection } from './base'
import { submodeCommands } from './command-builder'
import { assertInterfaceName, assertVlanId, INTERFACE_KINDS, parseInterfaceName } from './validators'
import type { ConfigBlock, ConfigLine } from '../config/text'
import type { ConfigSections } from '../config/chunk'
import type { InterfaceKind, ParsedInterfaceName } from './validators'
import type { ResourceTable } from './types'

/**
 * The `show` whose model, when the device has one, carries the operational half of the picture
 * (DR-031). **Client-side command literal**: whether 4.28.13.1M models this command is unverified —
 * DR-031's list of confirmed model-backed shows does not include it.
 */
export const INTERFACE_STATUS_COMMAND = 'show interfaces status'

/** How {@link InterfacesResource.getAll} should treat the status read (divergence 8/9). */
export type InterfaceStatusMode =
  /** Read it, and fall back to config-only when the device cannot answer the model. The default. */
  | 'auto'
  /** One `show running-config` and nothing else — the read for a table that shows no operational column. */
  | 'skip'
  /** Read it and let its failure throw: the mode for a screen whose whole subject is the status table. */
  | 'require'

/**
 * Options for the two read verbs — about the read this client performs, never about what the device
 * supports (DR-032). `ResourceBase.config({ config: 'startup-config' })` is the way to read the saved
 * config (row 75); this table is built from a `configSections()` call and does not offer a second source
 * until a caller needs one.
 */
export interface InterfacesReadOptions {
  /** How to treat the `show interfaces status` read. Default `'auto'`. */
  readonly status?: InterfaceStatusMode | undefined
}

/**
 * One interface, as this client reads it: the shared `BaseInterface` field set
 * (`name` / `shutdown` / `description`, `interfaces.py:174-176`) plus the `mtu` and `encapsulation` lines
 * the module reads for the UI (divergences 6/7), plus the optional status enrichment.
 *
 * Absent means "the section does not carry that line" — DR-027's ordinary control flow, and the reason
 * absence is never `false`/`0`/`''`: only `shutdown` and `description` exist upstream as `False`/`None`
 * (`:190`, `:208`), and a UI that cannot tell "off" from "not configured" is the failure DR-029 records.
 */
export interface Interface {
  /** The name exactly as the running-config's section header spells it (so `keys()` is device order/spelling). */
  readonly name: string
  /**
   * What the name is, per {@link parseInterfaceName} — or `null` when the device wrote an interface header
   * this client's grammar does not have (`Peer-Ethernet1`, `Ethernet1/1`: DECISIONS.md open item 7). The
   * row is kept and its fields reported either way (divergence 2); no verb accepts such a name yet.
   */
  readonly kind: InterfaceKind | null
  /**
   * The administrative state, from the `no shutdown` / `shutdown` command lines — `undefined` when the
   * block writes neither, which is not the same statement as `true` (divergence 3).
   */
  readonly shutdown?: boolean
  /** The `description …` value, unquoted (row 49). Absent for the `no description` line EOS writes. */
  readonly description?: string
  /** The `mtu <n>` line. No upstream twin in this module (divergence 7). */
  readonly mtu?: number
  /** The `encapsulation dot1q vlan <vid>` line, on a subinterface section. No upstream twin (divergence 6). */
  readonly encapsulation?: number
  /**
   * The `EthernetInterface` field group (M10b #12): what pyeapi's
   * `EthernetInterface.get` adds to the base record (`interfaces.py:335-366` — sflow and the two
   * flowcontrol directions, :367-414) plus the VRF binding the class **writes but never reads**
   * (`set_vrf`, `:550-577`; reading it back is this client's addition, divergence 14). Attached only
   * on an `Ethernet`-kind section and only when the block carries at least one of those lines
   * (DR-068's per-kind fields — never a per-kind object or label).
   */
  readonly ethernet?: InterfaceEthernetFields
  /**
   * The `PortchannelInterface` field group (M10c #12): `members` and `lacpMode` stitched from the
   * members' own `channel-group <id> mode <m>` body lines (`get_lacp_mode`'s per-member block read,
   * `interfaces.py:639-658`, reached through the running-config instead of upstream's `show port-channel
   * all-ports` scrape — divergence 15) plus this section's own min-links / LACP-fallback lines
   * (`:583-637`, absent-instead-of-defaulted — DR-076). Attached only on a `Port-Channel`-kind section
   * carrying at least one such fact.
   */
  readonly portChannel?: InterfacePortChannelFields
  /** The matching `show interfaces status` row, when it was read (divergence 8). */
  readonly status?: InterfaceStatus
}

/** The sFlow / flow-control / VRF fields of an Ethernet-kind section (M10b). */
export interface InterfaceEthernetFields {
  /**
   * `sflow enable` → `true`, `no sflow enable` → `false`, first exact line wins; absent when the
   * block writes neither. Upstream's reader is a **substring** test — `'no sflow' not in config` — that
   * calls any block without those characters enabled (DR-076, divergence 13).
   */
  readonly sflow?: boolean
  /** The `flowcontrol send <word>` value, verbatim — upstream's `on|off` pair is not enforced on reads. */
  readonly flowcontrolSend?: string
  /** The `flowcontrol receive <word>` value, verbatim (same as {@link flowcontrolSend}). */
  readonly flowcontrolReceive?: string
  /**
   * The name behind a `vrf <name>` / `vrf forwarding <name>` body line — the binding
   * {@link InterfacesResource.setVrf} writes. **No upstream reader exists** (`EthernetInterface.get`
   * parses only sflow/flowcontrol, `interfaces.py:335-366`), so this field is this client's addition
   * (divergence 14); the single-token value mirrors what `setVrf` can write back.
   */
  readonly vrf?: string
}

/** The member / LACP fields of a Port-Channel-kind section (M10c). */
export interface InterfacePortChannelFields {
  /**
   * The interfaces whose own sections carry `channel-group <id> …` naming this group, in
   * running-config order. Absent only when the group has no members. Upstream sources members from a
   * **text scrape** of `show port-channel <id> all-ports` (`:660-675`) — here they are the config the
   * same members show; the live read stays a verb ({@link InterfacesResource.getMembers}, divergence 15).
   */
  readonly members?: string[]
  /** The mode word of the first member line's `channel-group <id> mode <word>`. */
  readonly lacpMode?: string
  /** The `port-channel min-links <n>` line — absent, not `0`, when the section writes no value (DR-076). */
  readonly minimumLinks?: number
  /** The `port-channel lacp fallback <word>` line — absent, not `'disabled'`, for the `no …` form (DR-076). */
  readonly lacpFallback?: string
  /** The `port-channel lacp fallback timeout <n>` line — absent, not `90`, when missing (DR-076). */
  readonly lacpTimeout?: number
}

/** Which flow-control direction a write names — pyeapi's pair, validated at `interfaces.py:518-519`. */
export const FLOWCONTROL_DIRECTIONS: readonly string[] = ['send', 'receive']
/** The flow-control values pyeapi accepts before composing (`interfaces.py:514-516`). */
export const FLOWCONTROL_VALUES: readonly string[] = ['on', 'off']
export type FlowcontrolDirection = 'send' | 'receive'
export type FlowcontrolValue = 'on' | 'off'
/** The `channel-group … mode` values pyeapi accepts (`interfaces.py:727-729` and `:741`). */
export const LACP_MODES: readonly string[] = ['active', 'passive', 'on']
export type LacpMode = 'active' | 'passive' | 'on'
/** The fallback modes that carry a value (the `disabled` intent is a verb: {@link InterfacesResource.unsetLacpFallback}). */
export const LACP_FALLBACK_MODES: readonly string[] = ['individual', 'static']
export type LacpFallbackMode = 'individual' | 'static'

/**
 * One `show interfaces status` row, as {@link statusRowsFrom} reads it.
 *
 * **Two spellings, because the evidence set has two captures and only one of them is this command.**
 * The recording of `show interfaces status` itself is cEOS-lab **4.28.14M**,
 * `test/fixtures/live/ceos-4.28.14M/show-interfaces-status.json` — `interfaceStatuses` keyed by interface,
 * whose row carries `linkStatus` (`"connected"`, the same word its paired `--text` capture prints in the
 * `Status` column), `lineProtocolStatus` (`"up"`), `description` (`""` on its only port), `bandwidth`,
 * `duplex`, `interfaceType`, `autoNegotiateActive` and a `vlanInformation{}` — and carries **no** `mtu`,
 * `hardware` or `interfaceStatus` key. The older vendor-shipped capture
 * `pyeapi/test/fixtures/show_interfaces.json` belongs to the **sibling** `show interfaces` command and
 * spells the map `interfaces` and the link column `interfaceStatus` (`:63`, re-read 2026-11-04,
 * `lineProtocolStatus` `:65`, `mtu` `:66`, `hardware` `:10`, and `Management1`'s `description` is `""`).
 * {@link statusRowsFrom} therefore reads both, recorded-spelling first ({@link STATUS_ROW_MAP_KEYS},
 * {@link STATUS_LINK_COLUMNS}) — divergence 12. Neither capture settles the DCS-7050TX-64 answer, and the
 * container file states `hardwareEvidence: "none"` (DR-043); the hardware spelling stays a STATUS §3 capture.
 *
 * Columns outside those two captures are **not** read at all, so a column this client cannot find reads as
 * absent — honest — rather than as a value guessed from a similar-sounding key: the container's
 * `interfaceType` (`"EbraTestPhyPort"`) is a PHY name, not the sibling capture's `ethernet` port class, and
 * {@link InterfaceStatus.hardware} stays the latter's. Likewise this client reads **no** name neither file
 * carries, and pyeapi never reads this command (its only `show interfaces` use is `get_members`' text
 * scrape, `interfaces.py:660-675`). {@link InterfaceStatus.status}/{@link InterfaceStatus.protocol} are the
 * device's raw strings: a status vocabulary is a device question and is never enumerated here (DR-032/DR-057).
 *
 * Absent means "the answer did not carry that column in a type this client can use" (divergence 11).
 */
export interface InterfaceStatus {
  /** The interface this row is for: the member key of the status map (divergence 12's two spellings). */
  readonly name: string
  /**
   * The `description` column, verbatim — quotes and all, and an empty string when the device wrote one
   * (both captures carry an empty description: `Management1` in the sibling, the container's only port).
   * {@link Interface.description} is the configured half, which this client refuses to write empty.
   */
  readonly description?: string
  /**
   * The operational-state column: `linkStatus` in the recorded cEOS-lab answer, `interfaceStatus` in the
   * sibling capture ({@link STATUS_LINK_COLUMNS}). {@link Interface.shutdown} is the configured half of the
   * same story; the value set is the device's (DR-032).
   */
  readonly status?: string
  /** The `lineProtocolStatus` column — spelled identically in both captures. */
  readonly protocol?: string
  /** The sibling capture's `hardware` column (`ethernet`, `loopback`, …); absent on a lab-shaped row. */
  readonly hardware?: string
  /** The sibling capture's `mtu` column, when the answer carries it as a number. The lab capture has none. */
  readonly mtu?: number
}

/** What {@link InterfacesResource.create} may configure in the same transaction as `interface <name>`. */
export type InterfaceAttrs = {
  /** `description <value>` inside the new interface's submode. */
  readonly description?: string
  /** `mtu <value>` inside the new interface's submode. */
  readonly mtu?: number
}

/** A section header naming an interface. Anchored, so an indented copy of the word never matches (divergence 1). */
const INTERFACE_SECTION = /^interface (\S+)$/u

/** The two administrative-state command lines this client reads, matched as whole commands (divergence 3). */
const NO_SHUTDOWN_COMMAND = 'no shutdown'
const SHUTDOWN_COMMAND = 'shutdown'

/** The command keywords read out of a block body. */
const DESCRIPTION_KEYWORD = 'description'
const MTU_KEYWORD = 'mtu'
const ENCAPSULATION_KEYWORD = 'encapsulation dot1q vlan'

/** A field value that must be a plain decimal number. */
const DECIMAL = /^[0-9]+$/u

/** The two sFlow command lines this client reads, matched as whole body commands — divergence 16. */
const SFLOW_ON_COMMAND = 'sflow enable'
const SFLOW_NO_COMMAND = 'no sflow enable'

/** The command keywords the EthernetInterface fields are read behind. */
const FLOWCONTROL_SEND_KEYWORD = 'flowcontrol send'
const FLOWCONTROL_RECEIVE_KEYWORD = 'flowcontrol receive'

/** A `vrf <name>` or `vrf forwarding <name>` body line — the two shapes {@link InterfacesResource.setVrf} writes, and the `vrf DAT` form the 4.13.7M fixture already carries (`test/fixtures/running_config.text:1475`). */
const VRF_BODY_LINE = /^vrf(?:[ \t]+forwarding)?[ \t]+(\S+)$/u

/** The channel-group relation that stitches members to their group (`interface Ethernet5` writing `channel-group 1 mode active`, `running_config.portchannel:147`). The id and mode runs are captured; anything further on the line is kept out of the mode word. */
const CHANNEL_GROUP_LINE = /^channel-group[ \t]+([0-9]+)(?:[ \t]+mode[ \t]+(\S+?))?(?:[ \t]+\S+)*[ \t]*$/u

/** Keywords the PortchannelInterface fields are read behind. */
const MIN_LINKS_KEYWORD = 'port-channel min-links'
const LACP_FALLBACK_KEYWORD = 'port-channel lacp fallback'
const LACP_TIMEOUT_KEYWORD = 'port-channel lacp fallback timeout'

/** The group id pyeapi extracts from a Port-Channel name for its command texts — the first decimal run (`re.search(r'(\d+)', name).group()`, `interfaces.py:667`/`:698`/`:739`; it `.group()`s on `None` and crashes for a name with no digits). */
const GROUP_ID = /([0-9]+)/u

/** The release floor at which pyeapi's `set_vrf` switches from `vrf forwarding` to the bare `vrf` keyword (`interfaces.py:550-571` — a **string** compare against `'4.23'`, which divergence 18 replaces with a numeric one). */
const VRF_BARE_FORM_MIN: readonly [number, number] = [4, 23]

/**
 * The key holding the per-interface status rows, in capture order (divergence 12).
 *
 * `interfaceStatuses` is the spelling this client has actually recorded for **this** command —
 * `test/fixtures/live/ceos-4.28.14M/show-interfaces-status.json` — and `interfaces` is the sibling
 * command's spelling from pyeapi's vendor-shipped `test/fixtures/show_interfaces.json`, kept as the
 * fallback so a unit answering that shape still reads. A reply carrying both takes the recorded one.
 */
const STATUS_ROW_MAP_KEYS: readonly string[] = ['interfaceStatuses', 'interfaces']

/** The operational-state column, in capture order: `linkStatus` (recorded) then `interfaceStatus` (sibling). */
const STATUS_LINK_COLUMNS: readonly string[] = ['linkStatus', 'interfaceStatus']

/** The first of `keys` that holds an object in `source`. */
function pickRecord(source: Record<string, unknown> | undefined, keys: readonly string[]): Record<string, unknown> | undefined {
  for (const key of keys) {
    const found = asRecord(source?.[key])
    if (found !== undefined) return found
  }
  return undefined
}

/** The first of `keys` that holds a string in `row`. */
function pickText(row: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = textColumn(row, key)
    if (value !== undefined) return value
  }
  return undefined
}

/** A control character anywhere in an operator-supplied value. One expression, same rule as `system.ts:178-184`'s loop. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u

/** A rejected argument is named in the message, rendered pyeapi's way — the `refuse` pattern from `validators.ts` (DR-053). */
function refuse(label: string, value: unknown, because: string): never {
  throw new NotSupportedError(`invalid ${label} ${pythonRepr(value)} — ${because}`, { cause: value })
}

/**
 * Require a name {@link InterfacesResource.create} / {@link delete} may act on.
 *
 * Three rules, one per upstream shape: the name must parse; a non-Ethernet name must carry **no**
 * subinterface suffix (that is the shared guard, open item 7); and an Ethernet name must carry one —
 * because `EthernetInterface.create`/`delete` raise `NotImplementedError` for a physical name
 * (`interfaces.py:415-445`, pinned negative at `test_api_interfaces.py:211-224`) and send the bare
 * `interface <name>` / `no interface <name>` only for the dotted form (pinned positive at `:191-209`,
 * the half M10b (#12) owns). The refusal states the split instead of leaving it as a surprise.
 */
function assertPresentName(verb: 'create' | 'delete', value: unknown): void {
  const parsed = parseInterfaceName(value)
  if (parsed?.kind === 'Ethernet' ? parsed.subinterface !== undefined : parsed !== undefined && parsed.subinterface === undefined) return
  refuse(
    `${verb} interface`,
    value,
    `expected a non-Ethernet name with no subinterface suffix, or an Ethernet SUBINTERFACE name such as \`Ethernet1.1\` — pyeapi's EthernetInterface raises NotImplementedError for a physical Ethernet interface name (api/interfaces.py:415-445, pinned by test/unit/test_api_interfaces.py:211-224) and its own create/delete pins send the dotted form (test_api_interfaces.py:191-209 — ported here by M10b, #12); a dotted name of any other kind stays refused for want of device evidence (DECISIONS.md open item 7)`,
  )
}

/**
 * Require the one name form `encapsulation dot1q vlan <vid>` can be sent on.
 *
 * Upstream states the rule as two tests — `'.' not in name` and `name[0:2] not in ['Et','Po']` both raise
 * `NotImplementedError` (`interfaces.py:271-277`, pinned by `test_api_interfaces.py:144-154`) — and the
 * per-kind grammar makes the second one unnecessary: Ethernet and Port-Channel are the only arms that can
 * carry a suffix at all, so "it parsed and it has a subinterface" *is* the pair of conditions. The refusal
 * is a {@link NotSupportedError}, not a `NotImplementedError`, because that is what "this client refuses an
 * input" means in this package (DR-005/DR-010, the call M8 made in `system.ts` and M9 in `vlans.ts`).
 */
function assertEncapsulationName(verb: string, value: unknown): asserts value is string {
  const parsed = parseInterfaceName(value)
  if (parsed !== undefined && parsed.subinterface !== undefined) return
  refuse(
    `${verb} interface`,
    value,
    'expected an Ethernet or Port-Channel subinterface (`Ethernet1.100`, `Port-Channel1.1`): pyeapi raises NotImplementedError for a name with no dot and for any other kind (api/interfaces.py:271-277). Every other verb still goes through assertInterfaceName, which refuses the dotted form until M12 #14 captures the grammar (DECISIONS.md open item 7)',
  )
}

/**
 * Require a description this client can read back.
 *
 * Upstream interpolates whatever arrives (`:302` through `command_builder`, `abstract.py:158-159`), so
 * `set_description(name, '  ')` sends `description` with a trailing space and
 * `set_description(name, '"x"')` sends the quotes — which this reader would then strip (row 49). The
 * refusals below are reader-derived, and `commandBuilder` independently refuses a value containing a line
 * boundary (row 74). Whether EOS accepts a leading space or an unbalanced quote in a description is
 * unverified on hardware, M12 (#14) to capture.
 */
function assertInterfaceDescription(value: unknown): asserts value is string {
  if (typeof value !== 'string') refuse('interface description', value, 'expected a string description — pyeapi checks nothing (api/interfaces.py:284-303)')
  if (value.trim() === '') refuse('interface description', value, 'an empty description is refused — clear it with unsetDescription() (pyeapi `no description`, abstract.py:154-155 reached via api/interfaces.py:301; test/unit/test_api_interfaces.py:114-118) rather than an empty value (DR-037)')
  if (value !== value.trim()) refuse('interface description', value, 'leading or trailing whitespace cannot read back: `description …` is read as the text after the keyword, whitespace-trimmed and unquoted (valueAfterKeyword, config-block.ts) — pyeapi keeps it verbatim (api/interfaces.py:206)')
  if (CONTROL_CHARACTER.test(value)) refuse('interface description', value, 'a control character would break the config line this client reads back (the same reason command-builder.ts refuses a value with a line boundary, row 74)')
  if (value.includes('"')) refuse('interface description', value, 'a description containing a quote cannot round-trip through this reader, which unquotes a balanced pair (config/text.ts:235, MIGRATION.md §5 row 49). Legality on EOS is unverified on hardware, M12 (#14) to capture — pyeapi would answer the quotes as part of the value (api/interfaces.py:206)')
}

/**
 * Require a usable MTU value: a positive safe integer.
 *
 * **Client policy, and deliberately not a platform bound.** PLAN.md §M10 asks for "68..9214 on this
 * platform — read from `show interfaces` rather than a hard-coded constant" (DR-032), and neither half is
 * available offline: no capture exists, and 68 is pyeapi's floor for a *different command* —
 * `IP_MTU_MIN`/`IP_MTU_MAX` `68`/`65535` in `ipinterfaces.py:54-55`, which its `set_mtu` checks at
 * `:248-249`. Encoding 68 here would read an IP-MTU constant as an L2 fact, and encoding 9214 would cite a
 * number found nowhere in the pinned clone. What **is** derivable is that a non-integer, a zero, a negative
 * or an unrepresentable value is not a configuration value: `0` in particular is the falsy value DR-037
 * removes (upstream `set_mtu(name, 0)` produces `no mtu` through `elif value:` at `abstract.py:158-161`).
 * The device keeps the authority: it answers 1002/1003 and that arrives as a `CommandError`.
 */
function assertInterfaceMtu(value: unknown): asserts value is number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return
  refuse('interface mtu', value, 'expected a positive integer MTU — this bound is client-side policy and NOT an EOS ceiling (DR-032/DR-057): the platform min/max is read from the device, and pyeapi has no MTU verb in api/interfaces.py at all, only IP_MTU_MIN 68 / IP_MTU_MAX 65535 for `ip mtu` in api/ipinterfaces.py:54-55. The device refuses anything it does not accept (DR-005)')
}

/**
 * Require a name the **EthernetInterface** verbs may compose: the class methods of
 * `interfaces.py:330-577` (`set_sflow`, `set_flowcontrol*`, `set_vrf`, and the Ethernet-side
 * create/delete) reach an instance only through the facade's prefix dispatch (`get_instance`'s
 * `interface[0:2]` test, `:120-127`, with `INTERFACE_CLASS_MAP` `:1093-1097`), so the surface this
 * client models is Ethernet names. The dotted subinterface form still fails the shared guard —
 * open item 7 — and the refusal below says so.
 *
 * Upstream's own suite shows what the class **would** do if handed another kind: its
 * `set_sflow_with_no_value` / `set_sflow_with_default` / `set_sflow_invalid_value` / `set_vrf` loops
 * drive `EthernetInterface` instances over the module-level `INTERFACES` list —
 * `Ethernet1, Ethernet1/1, Vlan1234, Management1, Port-Channel1, Vxlan1`
 * (`test/unit/test_api_interfaces.py:44-45` feeding `:280/:286/:292/:297`) — because the raw class
 * instance checks no name at all (the `isvalidinterface` guard lives in `ValueError` inside
 * `marshall`, `interfaces.py:129-133` — the dispatch this port does not have, DR-006). Both halves of
 * upstream are therefore true: the facade restricts these verbs to Ethernet names, the instance does
 * not. This client models the **surface** (the facade is what `node.interfaces` reaches, DR-068's
 * note), refuses the rest, and leaves the cross-kind binding question where it belongs — an M12 (#14)
 * device capture (DR-032/DR-057, row 128).
 */
function assertEthernetName(verb: string, value: unknown): asserts value is string {
  const parsed = parseInterfaceName(value)
  if (parsed !== undefined && parsed.kind === 'Ethernet' && parsed.subinterface === undefined) return
  refuse(
    `${verb} interface`,
    value,
    `expected a plain \`Ethernet<digits>\` name — sflow, flowcontrol and VRF are pyeapi's EthernetInterface methods (api/interfaces.py:330-577) and its facade reaches them only for the \`Ethernet\` prefix (:120-127, :1093-1097); other kinds have no upstream twin behind those verbs, and the dotted form keeps failing assertInterfaceName until M12 #14 captures the subinterface grammar (DECISIONS.md open item 7)`,
  )
}

/**
 * Require a name the **PortchannelInterface** verbs may compose (`interfaces.py:578-813`): the same
 * prefix-dispatch argument as {@link assertEthernetName}, with one extra reason — the commands embed a
 * decimal group id extracted from the name (`GROUP_ID` below), so a name with no digits is
 * uncomposable, not merely unfashioned.
 */
function assertPortChannelName(verb: string, value: unknown): asserts value is string {
  const parsed = parseInterfaceName(value)
  if (parsed !== undefined && parsed.kind === 'Port-Channel' && parsed.subinterface === undefined && GROUP_ID.test(parsed.name)) return
  refuse(
    `${verb} interface`,
    value,
    'expected a plain `PortChannel<n>` name whose digits carry the channel-group id — members/min-links/LACP are pyeapi PortchannelInterface methods (api/interfaces.py:578-813) reached only through the `PortChannel` prefix of its class map (:120-127, :1093-1097), and its group extraction re.search(r"(\\d+)", name).group() crashes outright on a digit-less name (:667, :698, :739); dotted Port-Channel names stay refused for want of device evidence (DECISIONS.md open item 7)',
  )
}

/** Require one of pyeapi's two flowcontrol directions (its `ValueError`, `interfaces.py:518-519`, becomes a typed refusal — DR-077). */
function assertFlowcontrolDirection(value: unknown): asserts value is FlowcontrolDirection {
  if ((FLOWCONTROL_DIRECTIONS as readonly unknown[]).includes(value)) return
  refuse('flowcontrol direction', value, `expected one of ${FLOWCONTROL_DIRECTIONS.join(' / ')} — pyeapi raises ValueError for anything else (api/interfaces.py:518-519; pinned negative by test/unit/test_api_interfaces.py:234-238)`)
}

/** Require one of pyeapi's two flowcontrol values (its `ValueError`, `interfaces.py:514-517`; tests `:239-243`). */
function assertFlowcontrolValue(value: unknown): asserts value is FlowcontrolValue {
  if ((FLOWCONTROL_VALUES as readonly unknown[]).includes(value)) return
  refuse('flowcontrol value', value, `expected one of ${FLOWCONTROL_VALUES.join(' / ')} — pyeapi raises ValueError for anything else (api/interfaces.py:514-517; pinned negative by test/unit/test_api_interfaces.py:239-243)`)
}

/**
 * Require a VRF name this client can read back: a single non-empty token, no surrounding
 * whitespace and no control character.
 *
 * Upstream interpolates whatever it is handed (`interfaces.py:569/574` and `abstract.py:158-159`),
 * tests name it `'testvrf'` (:297), and the fixture carries the single-token forms `vrf DAT`
 * (`test/fixtures/running_config.text:1475`) and `vrf default` (`:2130`/`:2189`). A spaced or
 * padded name would compose a command whose read-back this module's `VRF_BODY_LINE` cannot reproduce,
 * so the refusal is reader-derived (the {@link assertInterfaceDescription} pattern). What VRF names
 * EOS itself permits is an open item, not a claim made here.
 */
function assertVrfValue(value: unknown): asserts value is string {
  if (typeof value !== 'string') refuse('interface vrf', value, 'expected a string VRF name — pyeapi checks nothing and interpolates it (api/interfaces.py:550-577)')
  if (value.trim() === '') refuse('interface vrf', value, 'an empty VRF name is refused — clear the binding with unsetVrf() (the `disable=True` arm of set_vrf, api/interfaces.py:550-577, composes `no vrf`/`no vrf forwarding`) rather than an empty value (DR-037)')
  if (value !== value.trim()) refuse('interface vrf', value, 'leading or trailing whitespace cannot read back: the binding is read as the single token after the `vrf`/`vrf forwarding` keyword (VRF_BODY_LINE)')
  if (/\s/u.test(value)) refuse('interface vrf', value, 'a VRF name with inner whitespace cannot round-trip through the single-token reader (VRF_BODY_LINE) — pyeapi would interpolate it verbatim into the command')
  if (CONTROL_CHARACTER.test(value)) refuse('interface vrf', value, 'a control character would break the config line this client reads back (the same rule as the MTU/description guards and row 74)')
}

/** Require one of the three channel-group modes, for either side of the LACP verbs. */
function assertLacpMode(value: unknown): asserts value is LacpMode {
  if ((LACP_MODES as readonly unknown[]).includes(value)) return
  refuse('lacp mode', value, `expected one of ${LACP_MODES.join(' / ')} — pyeapi answers an invalid mode by RETURNING False in set_lacp_mode (api/interfaces.py:727-729, pinned non-raising at test/unit/test_api_interfaces.py:424-428) and does not check one at all in set_members, where an unknown mode reaches the wire as \`channel-group 1 mode <junk>\` (:704-707). Neither answer is usable from TS (DR-005/DR-077): the typed refusal is the third, and it is also the one that keeps a typo out of a LAG`)
}

/** Require a fallback mode that carries a value; the `disabled` intent is the named-verb treatment of pyeapi's `disable` arm (DR-037/DR-077). */
function assertLacpFallbackMode(value: unknown): asserts value is LacpFallbackMode {
  if (value === 'disabled') refuse('lacp fallback mode', value, "the 'disabled' arm composes `no port-channel lacp fallback` (pyeapi maps mode=='disabled' to disable=True, api/interfaces.py:782-789, pinned test/unit/test_api_interfaces.py:366-370) — that intent is the verb unsetLacpFallback() here, because the mode strings and the negation are separate questions (DR-037)")
  if ((LACP_FALLBACK_MODES as readonly unknown[]).includes(value)) return
  refuse('lacp fallback mode', value, `expected one of ${LACP_FALLBACK_MODES.join(' / ')} (or unsetLacpFallback() for the \`no\` form) — pyeapi answers any other mode by RETURNING False, with no exception and nothing to inspect (api/interfaces.py:779-781, pinned at test/unit/test_api_interfaces.py:371-374)`)
}

/** Require the positive-integer value a min-links / fallback-timeout write composes. **Client policy** — the platform bound is a device answer (DR-032/DR-057), upstream validates nothing, and `0` is DR-037's falsy trap. */
function assertPortBandValue(value: unknown, label: string): asserts value is number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return
  refuse(label, value, `expected a positive integer — pyeapi interpolates whatever arrives (api/interfaces.py:760-770 min-links / :806-813 lacp timeout have no bound at all), and the DEVICE answers 1002/1003 for a value it genuinely refuses (DR-005). 0 would compose a \`no\` line through pyeapi's falsy fall-through at abstract.py:160-161, which is exactly the surprise DR-037 deletes`)
}

/**
 * The numeric reading of pyeapi's version floor — {@link VRF_BARE_FORM_MIN} compared **by segment**,
 * because upstream's test is a raw string compare on `version_number >= '4.23'`
 * (`interfaces.py:550`-region: `if self.version_number >= '4.23':`), and `'4.9' >= '4.23'` is true
 * character-wise while 4.9 predates 4.23 by years (divergence 18). `undefined` means the
 * {@link VersionProperties.versionNumber} cannot be read as `major.minor` at all; the caller refuses
 * rather than guessing a command form for a device it cannot classify.
 */
function versionFloorCompare(versionNumber: string, floor: readonly [number, number]): boolean | undefined {
  const parts = /^([0-9]+)\.([0-9]+)/u.exec(versionNumber)
  if (parts === null) return undefined
  const major = Number(parts[1])
  const minor = Number(parts[2])
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) return undefined
  return major - floor[0] !== 0 ? major > floor[0] : minor >= floor[1]
}

/**
 * The block's sFlow state: the first exact `sflow enable` / `no sflow enable` body **command line**,
 * in device order, `undefined` when the block writes neither — the {@link shutdownFromBlock} rule
 * applied to the M10b field (divergence 16).
 *
 * Upstream's reader is not a command match — it is a substring search over the whole block text,
 * `value = 'no sflow' not in config` (`interfaces.py:367-380`): an interface whose block carries
 * **no sflow line at all** reads back ENABLED (the answer `test/unit/test_api_interfaces.py:183-190`
 * pins for the fixture's `interface Ethernet1`, `test/fixtures/running_config.text:542-675`, which
 * carries no sflow line), and any block containing those six characters anywhere — a description,
 * a nested line, `no sflow something-else` — reads back disabled. Absence is not a state
 * (DR-029/DR-057), so the fabricated `true` is not ported.
 */
function sflowFromBlock(block: ConfigBlock): boolean | undefined {
  for (const line of block.body) {
    if (line.text === SFLOW_NO_COMMAND) return false
    if (line.text === SFLOW_ON_COMMAND) return true
  }
  return undefined
}

/**
 * The VRF binding named in the block, as a single token — or absent.
 *
 * **Upstream has no reader for this field at all**: `EthernetInterface.get` composes only
 * sflow/flowcontrol (`interfaces.py:335-366`), and `set_vrf` (`:550-577`) never round-trips. Reading
 * it back is this client's addition (divergence 14), with the vocabulary taken from the two forms
 * `setVrf` itself writes and the fixture's pre-existing 4.13-era line (`vrf DAT`,
 * `test/fixtures/running_config.text:1475`).
 */
function vrfFromBlock(block: ConfigBlock): string | undefined {
  for (const line of block.body) {
    const match = VRF_BODY_LINE.exec(line.text)
    if (match !== null) return match[1]
  }
  return undefined
}

/** The Ethernet-kind field group, or `undefined` when the section names none of it (DR-068). */
function ethernetFieldsFromBlock(block: ConfigBlock): InterfaceEthernetFields | undefined {
  const sflow = sflowFromBlock(block)
  const flowcontrolSend = valueAfterKeyword(block.body, FLOWCONTROL_SEND_KEYWORD)
  const flowcontrolReceive = valueAfterKeyword(block.body, FLOWCONTROL_RECEIVE_KEYWORD)
  const vrf = vrfFromBlock(block)
  if (sflow === undefined && flowcontrolSend === undefined && flowcontrolReceive === undefined && vrf === undefined) return undefined
  return {
    ...(sflow === undefined ? {} : { sflow }),
    ...(flowcontrolSend === undefined ? {} : { flowcontrolSend }),
    ...(flowcontrolReceive === undefined ? {} : { flowcontrolReceive }),
    ...(vrf === undefined ? {} : { vrf }),
  }
}

/**
 * The `port-channel lacp fallback` value, skipping the `timeout` sub-command's line.
 *
 * Upstream's reader is `re.search(r'lacp fallback (static|individual)', config)` — unanchored,
 * only ever two words, and it answers the module constant `DEFAULT_LACP_FALLBACK = 'disabled'`
 * for ANY other content including a plain `no port-channel lacp fallback` line
 * (`interfaces.py:624-631`, `:67-69`; the fixture's real negation at `running_config.portchannel:19`
 * pinned as `'disabled'` by its `test_get` at `test/unit/test_api_interfaces.py:318`). Here the word
 * after the keyword is read verbatim when it is not `timeout …`, and absence stays absence (DR-076).
 */
function lacpFallbackFromBlock(lines: readonly ConfigLine[]): string | undefined {
  for (const line of lines) {
    if (!line.text.startsWith(LACP_FALLBACK_KEYWORD)) continue
    const next = line.text.charAt(LACP_FALLBACK_KEYWORD.length)
    if (next !== '' && next !== ' ' && next !== '\t') continue
    const rest = line.text.slice(LACP_FALLBACK_KEYWORD.length).trim()
    if (rest === '' || rest === 'timeout' || /^timeout[\s]/u.test(rest)) continue
    return rest
  }
  return undefined
}

/** The block's administrative state: the first exact `no shutdown` / `shutdown` body command line in
 * device order answers, and a block carrying neither is `undefined` (divergence 3).
 *
 * Not a search for the `no shutdown` **substring** with one fallback value, which is what upstream does
 * (`interfaces.py:190`) and what makes `interface Loopback2` in its own fixture read as administratively
 * shut. A block carrying both forms is not a shape EOS is known to write, so the first line wins rather
 * than a rule, and no read of one strange section can take the whole table down with it.
 */
function shutdownFromBlock(block: ConfigBlock): boolean | undefined {
  for (const line of block.body) {
    if (line.text === NO_SHUTDOWN_COMMAND) return false
    if (line.text === SHUTDOWN_COMMAND) return true
  }
  return undefined
}

/**
 * A numeric field value, or `undefined` when the section carries no such line.
 *
 * @throws {ConfigParseError} the value is not a plain decimal, or too large to represent — pyeapi's
 *   readers truncate (`mtu (\d+)`, `ipinterfaces.py:126`) and its `int()` would happily return a float for
 *   JSON-shaped input; a resource that truncates device text cannot show a reviewable diff (rows 43/44's
 *   rule, restated for this module in DR-059's terms).
 */
function numberFieldFromBlock(value: string | undefined, keyword: string, sectionKey: string): number | undefined {
  if (value === undefined) return undefined
  if (!DECIMAL.test(value)) {
    throw new ConfigParseError(
      `interfaces: cannot read ${pythonRepr(keyword)} in ${pythonRepr(sectionKey)} — ${pythonRepr(value)} is not a decimal number. pyeapi either has no reader for this field (api/interfaces.py) or truncates at the first non-digit (api/ipinterfaces.py:126), and this client reports instead of guessing`,
      { sectionKey },
    )
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw new ConfigParseError(
      `interfaces: ${pythonRepr(keyword)} in ${pythonRepr(sectionKey)} is ${pythonRepr(value)}, which this client cannot hold as an integer index — reporting a rounded value as configuration would be a wrong answer about the device`,
      { sectionKey },
    )
  }
  return parsed
}

/** The cross-section facts of one channel-group id, collected from the members' own body lines. */
interface GroupFacts {
  readonly members: readonly string[]
  readonly lacpMode: string | undefined
}

/** The Port-Channel-kind field group: this section's own min-links/LACP lines plus its group's members/mode. */
function portChannelFieldsFromBlock(block: ConfigBlock, group: GroupFacts | undefined, sectionKey: string): InterfacePortChannelFields | undefined {
  const minimumLinks = numberFieldFromBlock(valueAfterKeyword(block.body, MIN_LINKS_KEYWORD), MIN_LINKS_KEYWORD, sectionKey)
  const lacpTimeout = numberFieldFromBlock(valueAfterKeyword(block.body, LACP_TIMEOUT_KEYWORD), LACP_TIMEOUT_KEYWORD, sectionKey)
  const lacpFallback = lacpFallbackFromBlock(block.body)
  const members = group !== undefined && group.members.length > 0 ? group.members : undefined
  const lacpMode = group?.lacpMode
  if (members === undefined && lacpMode === undefined && minimumLinks === undefined && lacpFallback === undefined && lacpTimeout === undefined) return undefined
  return {
    ...(members === undefined ? {} : { members: [...members] }),
    ...(lacpMode === undefined ? {} : { lacpMode }),
    ...(minimumLinks === undefined ? {} : { minimumLinks }),
    ...(lacpFallback === undefined ? {} : { lacpFallback }),
    ...(lacpTimeout === undefined ? {} : { lacpTimeout }),
  }
}

/** One `interface …` section into a record. `group` carries the cross-section channel-group facts when this section names a Port-Channel (`interfacesFromSections` builds them first). */
function interfaceFromSection(sectionKey: string, name: string, parsed: ParsedInterfaceName | undefined, block: ConfigBlock, group?: GroupFacts): Interface {
  const description = valueAfterKeyword(block.body, DESCRIPTION_KEYWORD)
  const mtu = numberFieldFromBlock(valueAfterKeyword(block.body, MTU_KEYWORD), MTU_KEYWORD, sectionKey)
  const encapsulation = numberFieldFromBlock(valueAfterKeyword(block.body, ENCAPSULATION_KEYWORD), ENCAPSULATION_KEYWORD, sectionKey)
  const shutdown = shutdownFromBlock(block)
  const ethernet = parsed?.kind === 'Ethernet' ? ethernetFieldsFromBlock(block) : undefined
  const portChannel = parsed?.kind === 'Port-Channel' ? portChannelFieldsFromBlock(block, group, sectionKey) : undefined
  return {
    name,
    kind: parsed?.kind ?? null,
    ...(shutdown === undefined ? {} : { shutdown }),
    ...(description === undefined ? {} : { description }),
    ...(mtu === undefined ? {} : { mtu }),
    ...(encapsulation === undefined ? {} : { encapsulation }),
    ...(ethernet === undefined ? {} : { ethernet }),
    ...(portChannel === undefined ? {} : { portChannel }),
  }
}

/**
 * Every interface in a chunked running-config — **one** config read (DR-030/DR-055), two in-memory
 * passes over the sections: the first parses each block once and harvests every Ethernet section's
 * `channel-group <id> mode <m>` line into the group facts, the second builds the records (per-kind
 * groups arrive with M10b/M10c — DR-068) and attaches those facts to the matching Port-Channel
 * section. Members land in running-config order, and the group id is the raw decimal run as written,
 * because that is the token every channel-group command uses (`interfaces.py:667`/`:699` extract it
 * from the Port-Channel *name* — a header spelled `PortChannel01` therefore looks for the id `01`
 * exactly as upstream would write it; whether EOS normalizes the two spellings together is an M12 (#14)
 * capture, not a claim here).
 *
 * Upstream's `getall` (`:95-115`) costs a `section()` key scan and two regex passes per interface, drops
 * whatever its `get` answers falsy (`if interface:`, `:174`) and cannot answer at all when one `_parse_*`
 * crashes. Here the only filter is the section header, and a section that fails to parse throws a
 * {@link ConfigParseError} naming it rather than vanishing from the table (DR-059). Nested-submode body
 * lines still answer for their section (divergence 10's shared limitation): `ConfigLine.indent` is not
 * filtered here any more than it is by M9's extractors, so an indented `channel-group` / `vrf` line
 * inside one interface's sub-mode would join the group — the same reach `get_block` +
 * `re.search` give upstream (`interfaces.py:639-658`).
 */
function interfacesFromSections(sections: ConfigSections): Map<string, Interface> {
  const parsedSections = new Map<string, { sectionKey: string; parsed: ParsedInterfaceName | undefined; block: ConfigBlock }>()
  const groups = new Map<string, { members: string[]; firstMode?: string }>()
  for (const [sectionKey, sectionText] of sections) {
    const name = INTERFACE_SECTION.exec(sectionKey)?.[1]
    if (name === undefined) continue
    const parsed = parseInterfaceName(name)
    const block = parseBlock(sectionText)
    parsedSections.set(name, { sectionKey, parsed, block })
    if (parsed?.kind !== 'Ethernet') continue
    for (const line of block.body) {
      const relation = CHANNEL_GROUP_LINE.exec(line.text)
      if (relation === null) continue
      const facts = groups.get(relation[1]) ?? { members: [] }
      if (!facts.members.includes(name)) facts.members.push(name)
      if (facts.firstMode === undefined && relation[2] !== undefined) facts.firstMode = relation[2]
      groups.set(relation[1], facts)
    }
  }
  const interfaces = new Map<string, Interface>()
  for (const [name, entered] of parsedSections) {
    const groupKey = entered.parsed?.kind === 'Port-Channel' ? GROUP_ID.exec(entered.parsed.name)?.[1] : undefined
    const facts = groupKey === undefined ? undefined : groups.get(groupKey)
    interfaces.set(name, interfaceFromSection(entered.sectionKey, name, entered.parsed, entered.block, facts === undefined ? undefined : { members: facts.members, lacpMode: facts.firstMode }))
  }
  return interfaces
}

/** Is this a JSON object we can read members from? `null` is `object` to `typeof`, hence the null check. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/** A status column as a string, or absent when the answer did not carry it as one (divergence 11). */
function textColumn(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key]
  return typeof value === 'string' ? value : undefined
}

/** A status column as a number, or absent. `null` is `object`, so a JSON null never becomes 0. */
function numberColumn(row: Record<string, unknown>, key: string): number | undefined {
  const value = row[key]
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

/**
 * The rows of a `show interfaces status` reply, keyed by interface name.
 *
 * **The captured spellings decide what is read, in capture order (divergence 12).** The row map is
 * {@link STATUS_ROW_MAP_KEYS} — `interfaceStatuses` from the cEOS-lab recording of this command, else
 * `interfaces` from the sibling capture — and the link column is {@link STATUS_LINK_COLUMNS}. Both
 * captures agree on `description` and `lineProtocolStatus`; `hardware` and `mtu` exist only in the
 * sibling, so a lab-shaped row honestly reports them absent. A missing column is ordinary (the sibling
 * capture's `Loopback0` row carries no `duplex`, `physicalAddress` or `autoNegotiate` at all), but a reply
 * with **no** row map means the device did not answer this command's model at all, which the caller has to
 * be able to distinguish from "every column is empty" (DR-027).
 *
 * @throws {ProtocolError} the reply is not a `show interfaces status` model, including the `format:'text'`
 *   answer M2's codec produces for a `1003 COMMAND_UNCONVERTED` (`internal/wire.ts:550-567`): an
 *   `{ output: … }` block is not this map, and silently reading nothing from it would look like a switch
 *   with no interfaces.
 *
 * The parameter is `unknown`, not `CommandResult`, because that is what the seam actually hands
 * back: `Node.show` types an unmodelled command as `unknown` rather than `any`
 * (`src/types/eapi.ts:142-145`, `ShowReply`), so this is the edge where a device reply has to be
 * shape-checked instead of asserted. `CommandResult` is `Record<string, unknown>`, i.e. a *claim* that the
 * reply is an object — and a reply that is not an object is precisely the {@link ProtocolError} case below,
 * which an asserted parameter type would turn into a `TypeError` reading a property off `null`.
 */
function statusRowsFrom(reply: unknown): Map<string, InterfaceStatus> {
  const answer = asRecord(reply)
  const table = pickRecord(answer, STATUS_ROW_MAP_KEYS)
  if (table === undefined) {
    const text = typeof answer?.['output'] === 'string'
      ? ' — the reply is a `format: \'text\'` output block, i.e. the CLI has no JSON model for this command (DR-012/DR-031)'
      : ''
    throw new ProtocolError(
      `${INTERFACE_STATUS_COMMAND} reply has no \`${STATUS_ROW_MAP_KEYS.join('` or `')}\` object, so no status row can be read${text}. Row spellings come from the cEOS-lab recording of this command and pyeapi's sibling-command capture; the 7050TX-64 spelling is still owed to M12 (#14) per DR-043, and this client refuses to substitute an empty table`,
      { commands: [INTERFACE_STATUS_COMMAND] },
    )
  }
  const rows = new Map<string, InterfaceStatus>()
  for (const [key, member] of Object.entries(table)) {
    const row = asRecord(member)
    // A member that is not an object is not a row. Skipping keeps the good rows readable; the map as a
    // whole was already required to exist above.
    if (row === undefined) continue
    const description = textColumn(row, 'description')
    const status = pickText(row, STATUS_LINK_COLUMNS)
    const protocol = textColumn(row, 'lineProtocolStatus')
    const hardware = textColumn(row, 'hardware')
    const mtu = numberColumn(row, 'mtu')
    rows.set(key, {
      name: key,
      ...(description === undefined ? {} : { description }),
      ...(status === undefined ? {} : { status }),
      ...(protocol === undefined ? {} : { protocol }),
      ...(hardware === undefined ? {} : { hardware }),
      ...(mtu === undefined ? {} : { mtu }),
    })
  }
  return rows
}

/**
 * `node.interfaces` — every interface on one switch: existence and configuration from the
 * running-config, operational state from `show interfaces status` where the device models it.
 *
 * `EntityCollection<Interface, string, InterfaceAttrs>` (pyeapi's `Interfaces(EntityCollection)`,
 * `:86`), keyed by interface name. Where pyeapi answers by routing a method name to one of four classes
 * (`:120-138`), this class answers with named verbs and a per-kind name parser, and the places where a
 * kind genuinely behaves differently are statements in the code: {@link assertPresentName} (Ethernet) and
 * {@link setEncapsulation} (Ethernet/Port-Channel subinterfaces).
 */
export class InterfacesResource extends EntityCollection<Interface, string, InterfaceAttrs> {
  /**
   * Every interface — pyeapi's `getall()` (`interfaces.py:95-115`) as a `ResourceTable` (row 78), with
   * DR-031's hybrid read on top.
   *
   * Request counts, all pinned in `interfaces.test.ts`: 1 with `{ status: 'skip' }`, 2 against a device
   * that models `show interfaces status`, 3 against one that answers `1003` and is re-read as text
   * (divergence 9). The config half always succeeds or throws; the status half only ever *adds*
   * (divergence 8), so a screen listing configuration is never broken by a missing CLI model.
   */
  override async getAll(options: InterfacesReadOptions = {}): Promise<ResourceTable<string, Interface>> {
    const interfaces = interfacesFromSections(await this.configSections())
    const rows = await this.statusRows(options.status ?? 'auto')
    if (rows === undefined) return interfaces
    const merged = new Map<string, Interface>()
    for (const [name, entered] of interfaces) {
      const status = rows.get(name)
      merged.set(name, status === undefined ? entered : { ...entered, status })
    }
    return merged
  }

  /**
   * One interface, or `undefined` — a lookup in exactly the table {@link getAll} builds, so the two can
   * never disagree and a name the grammar cannot read (`Po1`, `Foo1`) is simply not a key. That is also
   * upstream's answer for an unknown name: `Interfaces.get('Foo1')` is `None`
   * (`test_api_interfaces.py:81-83`), reached — unlike ours — by a `get_block` for a section that does
   * not exist, because the facade's `get` validates nothing (`:92-93`).
   *
   * Note the read cost follows {@link InterfacesReadOptions}: this is `getAll` keyed once, not a cheaper
   * path, and `{ status: 'skip' }` is how a caller asks for one config read.
   */
  override async get(name: string, options: InterfacesReadOptions = {}): Promise<Interface | undefined> {
    return (await this.getAll(options)).get(name)
  }

  /**
   * The `show interfaces status` table on its own, keyed by interface name — the verb for a link-status
   * panel, and the one that reports a status problem instead of hiding it (divergence 8).
   *
   * Upstream's only `show interfaces`-shaped read is `PortchannelInterface.get_members`
   * (`interfaces.py:660-675`), which scrapes a **text** output with
   * `re.findall(r'\b(?!Peer)Ethernet[\d/]*\b', …)` — M10c's problem, not a twin of this.
   *
   * @throws {ProtocolError} the device answered something that is not this command's model.
   * @throws {CommandError} the device refused the command (1002 on a unit without it, or a role that may
   *   not run it) — the code, message and `failedCommand` arrive intact (DR-005).
   */
  async getStatus(): Promise<ResourceTable<string, InterfaceStatus>> {
    return statusRowsFrom(await this.node.show(INTERFACE_STATUS_COMMAND))
  }

  /**
   * The status rows, honouring {@link InterfaceStatusMode}. `undefined` means "no enrichment": the skip
   * mode, and the auto mode's fallback for any status failure.
   *
   * The catch is the whole point of `'auto'`, so it is deliberately not narrower than `unknown`: a unit
   * without the command (1002), a command with no JSON model (1003 → a text retry that is still not a
   * model), an unreachable device mid-render, or a shape this client cannot read must all leave the
   * configuration table alone. A caller who needs to know *why* asks {@link getStatus}.
   */
  private async statusRows(mode: InterfaceStatusMode): Promise<ResourceTable<string, InterfaceStatus> | undefined> {
    if (mode === 'skip') return undefined
    if (mode === 'require') return await this.getStatus()
    try {
      return await this.getStatus()
    } catch {
      return undefined
    }
  }

  /**
   * Bring an interface into existence: `interface <name>`, plus `description …` / `mtu …` inside the same
   * submode when `attrs` carries them. pyeapi's `create(self, name)` (`:211-226`) sends the bare command
   * and answers `True`; the attributes are this client's addition, in the shape the separate field verbs
   * already use (M9's `create(vid, attrs)` precedent, one transaction instead of upstream's two calls).
   *
   * Like upstream, this is not an existence check: `interface Ethernet1`-style "the port already exists"
   * is a non-event on the device, and {@link assertPresentName} states the M10b split — an Ethernet name
   * may only be created as a subinterface (`Ethernet1.1`, the form `test_api_interfaces.py:191-209` pins),
   * never as a physical port, which is exactly where pyeapi itself raises. A device refusal rejects with
   * its `CommandError` (DR-005).
   */
  override async create(name: string, attrs?: InterfaceAttrs): Promise<void> {
    assertPresentName('create', name)
    const commands: string[] = []
    if (attrs?.description !== undefined) {
      assertInterfaceDescription(attrs.description)
      commands.push(this.commandBuilder(DESCRIPTION_KEYWORD, { value: attrs.description }))
    }
    if (attrs?.mtu !== undefined) {
      assertInterfaceMtu(attrs.mtu)
      commands.push(this.commandBuilder(MTU_KEYWORD, { value: attrs.mtu }))
    }
    await this.configure(submodeCommands(`interface ${name}`, commands))
  }

  /**
   * `no interface <name>` — pyeapi's `delete` (`:228-243`), whose docstring notes it answers `True` even
   * when there was nothing to delete. Same command text, no `True` to check (DR-005), and the same
   * M10b Ethernet shape rule as {@link create}: only the dotted form composes, physical names are
   * refused where pyeapi itself raises.
   */
  override async delete(name: string): Promise<void> {
    assertPresentName('delete', name)
    await this.configure(this.commandBuilder(`interface ${name}`, { mode: 'no' }))
  }

  /**
   * `default interface <name>` — pyeapi's `default` (`:245-254`; `test_api_interfaces.py:191-209` pins the
   * text for `Ethernet1` **and** `Ethernet1/1`, which the shared name guard still refuses — open item 7).
   * Renamed per `base.ts`'s verb table, because `default` reads as a keyword in a call chain (row 77).
   * Unlike {@link create}/{@link delete} this verb is available for every kind, Ethernet included.
   */
  override async setDefault(name: string): Promise<void> {
    assertInterfaceName(name)
    await this.configure(this.commandBuilder(`interface ${name}`, { mode: 'default' }))
  }

  /**
   * `description <value>` — pyeapi's `set_description` (`:284-303`), which reaches the wire through
   * `configure_interface` (`abstract.py:166-178`); `test_api_interfaces.py:107-112` pins the pair
   * `interface <name>` / `description <value>` for every kind upstream lists
   * (`:44-45`: Ethernet, Ethernet1/1, Vlan, Management, Port-Channel, Vxlan — the chassis form is the one
   * this client still refuses, row 76).
   */
  async setDescription(name: string, value: string): Promise<void> {
    assertInterfaceName(name)
    assertInterfaceDescription(value)
    await this.configureInterface(name, [this.commandBuilder(DESCRIPTION_KEYWORD, { value })])
  }

  /** `no description` — pyeapi's `set_description(name, disable=True)` (`:301-302` → `no` at abstract.py:154-155; `test_api_interfaces.py:114-118`). */
  async unsetDescription(name: string): Promise<void> {
    assertInterfaceName(name)
    await this.configureInterface(name, [this.commandBuilder(DESCRIPTION_KEYWORD, { mode: 'no' })])
  }

  /** `default description` — pyeapi's `set_description(name, default=True)` (`:301-302` → `default` at abstract.py:152-153; `test_api_interfaces.py:120-124`). */
  async defaultDescription(name: string): Promise<void> {
    assertInterfaceName(name)
    await this.configureInterface(name, [this.commandBuilder(DESCRIPTION_KEYWORD, { mode: 'default' })])
  }

  /**
   * `shutdown` — pyeapi's `set_shutdown(name, default=False, disable=False)` (`:305-327`,
   * `test_api_interfaces.py:126-130`). Note upstream's **default is the opposite** (`disable=True`, `:305`),
   * which is why this family has no `setShutdown(…, { disable })` twin: the two intents are
   * {@link shutdown} and {@link noShutdown} (DR-037, PLAN's "`noShutdown` semantics via `disable`").
   */
  async shutdown(name: string): Promise<void> {
    assertInterfaceName(name)
    await this.configureInterface(name, [this.commandBuilder('shutdown', { value: true })])
  }

  /** `no shutdown` — pyeapi's `set_shutdown(name)` with its default `disable=True` (`:305`, `:324-326`; `test_api_interfaces.py:132-136`). */
  async noShutdown(name: string): Promise<void> {
    assertInterfaceName(name)
    await this.configureInterface(name, [this.commandBuilder('shutdown', { mode: 'no' })])
  }

  /** `default shutdown` — pyeapi's `set_shutdown(name, default=True)` (`:324-326`; `test_api_interfaces.py:138-142`). */
  async defaultShutdown(name: string): Promise<void> {
    assertInterfaceName(name)
    await this.configureInterface(name, [this.commandBuilder('shutdown', { mode: 'default' })])
  }

  /**
   * `mtu <value>` — no upstream twin in this module (divergence 7). `configure_interface`-shaped like
   * pyeapi's own `ipinterfaces.set_mtu` does it (`:251-254`), with {@link assertInterfaceMtu}'s
   * client-policy bound instead of upstream's `68..65535` IP-MTU check (`:248-249`).
   */
  async setMtu(name: string, value: number): Promise<void> {
    assertInterfaceName(name)
    assertInterfaceMtu(value)
    await this.configureInterface(name, [this.commandBuilder(MTU_KEYWORD, { value })])
  }

  /** `no mtu` — the DR-037 negation of a field this client can read. Upstream spells such intents `disable=True`. */
  async unsetMtu(name: string): Promise<void> {
    assertInterfaceName(name)
    await this.configureInterface(name, [this.commandBuilder(MTU_KEYWORD, { mode: 'no' })])
  }

  /** `default mtu` — the DR-037 defaulting form, matching what EOS writes as `default mtu`-style lines elsewhere (unverified on hardware: M12 #14). */
  async defaultMtu(name: string): Promise<void> {
    assertInterfaceName(name)
    await this.configureInterface(name, [this.commandBuilder(MTU_KEYWORD, { mode: 'default' })])
  }

  /**
   * `encapsulation dot1q vlan <vid>` on a subinterface — pyeapi's `set_encapsulation` (`:256-282`,
   * `test_api_interfaces.py:156-159`), including its two refusals, which the grammar makes structural
   * ({@link assertEncapsulationName}). The vid goes through `assertVlanId`: pyeapi calls `str(vid)` and
   * validates nothing (`:280`), so `set_encapsulation('Ethernet1.1', 'abc')` sends
   * `encapsulation dot1q vlan abc`, and a float reaches the wire as `str(20.5)`.
   */
  async setEncapsulation(name: string, vlanId: number): Promise<void> {
    assertEncapsulationName('setEncapsulation', name)
    assertVlanId(vlanId)
    await this.configure(submodeCommands(`interface ${name}`, [this.commandBuilder(ENCAPSULATION_KEYWORD, { value: vlanId })]))
  }

  /** `no encapsulation dot1q vlan` — pyeapi's `set_encapsulation(name, vid, disable=True)` (`:279`; `test_api_interfaces.py:161-165`). The vid is not part of the negation upstream itself emits. */
  async unsetEncapsulation(name: string): Promise<void> {
    assertEncapsulationName('unsetEncapsulation', name)
    await this.configure(submodeCommands(`interface ${name}`, [this.commandBuilder(ENCAPSULATION_KEYWORD, { mode: 'no' })]))
  }

  /** `default encapsulation dot1q vlan` — pyeapi's `set_encapsulation(name, vid, default=True)` (`:278`; `test_api_interfaces.py:167-171`). */
  async defaultEncapsulation(name: string): Promise<void> {
    assertEncapsulationName('defaultEncapsulation', name)
    await this.configure(submodeCommands(`interface ${name}`, [this.commandBuilder(ENCAPSULATION_KEYWORD, { mode: 'default' })]))
  }

  // --- EthernetInterface verbs, M10b (#12): interfaces.py:330-577 ---------------------------------

  /**
   * `sflow enable` — pyeapi's `set_sflow(name, True)` (`interfaces.py:526-545`;
   * `test_api_interfaces.py` pins enable on `interface Ethernet1`/`interface Ethernet1-23` blocks at
   * the `set_sflow_with_value` group).
   */
  async setSflow(name: string): Promise<void> {
    assertEthernetName('setSflow', name)
    await this.configureInterface(name, [this.commandBuilder(SFLOW_ON_COMMAND, { value: true })])
  }

  /**
   * `no sflow enable` — pyeapi spells this intent **three ways at once**: `set_sflow(name, False)`
   * (falsy value → `no` arm through `command_builder`'s `elif value:` fall-through,
   * `abstract.py:158-161`), `set_sflow(name)` with no value at all (the deprecated `no` line), and
   * `set_sflow(name, disable=True)` — and its suite pins the `False` arm's text at
   * `test/unit/test_api_interfaces.py` under `test_set_sflow_with_value` (`interfaces.py:538-542`).
   * DR-037 keeps one name per intent: this verb is that text, whatever keyword produced it upstream.
   */
  async unsetSflow(name: string): Promise<void> {
    assertEthernetName('unsetSflow', name)
    await this.configureInterface(name, [this.commandBuilder(SFLOW_ON_COMMAND, { mode: 'no' })])
  }

  /** `default sflow enable` — pyeapi's `set_sflow(name, default=True)` (`:539-540`; tests `test_set_sflow_with_default`). */
  async defaultSflow(name: string): Promise<void> {
    assertEthernetName('defaultSflow', name)
    await this.configureInterface(name, [this.commandBuilder(SFLOW_ON_COMMAND, { mode: 'default' })])
  }

  /**
   * `flowcontrol <direction> <on|off>` — pyeapi's `set_flowcontrol(name, direction, value)`
   * (`interfaces.py:491-525`), whose two guards (`ValueError` for a bad value `:514-517` and for a bad
   * direction `:518-519`, pinned negative at `test_api_interfaces.py`'s
   * `test_set_flowcontrol_with_invalid_*` pair) become typed refusals, and whose command text the
   * `test_set_flowcontrol_with_value` loops pin for both directions and both values.
   */
  async setFlowcontrol(name: string, direction: FlowcontrolDirection, value: FlowcontrolValue): Promise<void> {
    assertEthernetName('setFlowcontrol', name)
    assertFlowcontrolDirection(direction)
    assertFlowcontrolValue(value)
    await this.configureInterface(name, [this.commandBuilder(`flowcontrol ${direction}`, { value })])
  }

  /** `no flowcontrol send|receive` — pyeapi's `disable=True` arm **and** its no-value fall-through (both compose this text, `:521-523` + `abstract.py:154-161`; tests pin `test_set_flowcontrol_with_disable`). */
  async unsetFlowcontrol(name: string, direction: FlowcontrolDirection): Promise<void> {
    assertEthernetName('unsetFlowcontrol', name)
    assertFlowcontrolDirection(direction)
    await this.configureInterface(name, [this.commandBuilder(`flowcontrol ${direction}`, { mode: 'no' })])
  }

  /** `default flowcontrol send|receive` — pyeapi's `default=True` arm (`:522` + `abstract.py:152-153`; tests pin `test_set_flowcontrol_with_default`). */
  async defaultFlowcontrol(name: string, direction: FlowcontrolDirection): Promise<void> {
    assertEthernetName('defaultFlowcontrol', name)
    assertFlowcontrolDirection(direction)
    await this.configureInterface(name, [this.commandBuilder(`flowcontrol ${direction}`, { mode: 'default' })])
  }

  /** The `send` wrapper of {@link setFlowcontrol} — pyeapi's `set_flowcontrol_send` (`interfaces.py:447-450`). */
  async setFlowcontrolSend(name: string, value: FlowcontrolValue): Promise<void> {
    await this.setFlowcontrol(name, 'send', value)
  }

  /** pyeapi's `set_flowcontrol_send(name, disable=True)`/no-value arms as one verb (`interfaces.py:447-450` → :521-523). */
  async unsetFlowcontrolSend(name: string): Promise<void> {
    await this.unsetFlowcontrol(name, 'send')
  }

  /** pyeapi's `set_flowcontrol_send(name, default=True)` (`:447-450` → :522). */
  async defaultFlowcontrolSend(name: string): Promise<void> {
    await this.defaultFlowcontrol(name, 'send')
  }

  /** The `receive` wrapper of {@link setFlowcontrol} — pyeapi's `set_flowcontrol_receive` (`interfaces.py:469-472`). */
  async setFlowcontrolReceive(name: string, value: FlowcontrolValue): Promise<void> {
    await this.setFlowcontrol(name, 'receive', value)
  }

  /** pyeapi's `set_flowcontrol_receive(name, disable=True)`/no-value arms as one verb (`:469-472` → :521-523). */
  async unsetFlowcontrolReceive(name: string): Promise<void> {
    await this.unsetFlowcontrol(name, 'receive')
  }

  /** pyeapi's `set_flowcontrol_receive(name, default=True)` (`:469-472` → :522). */
  async defaultFlowcontrolReceive(name: string): Promise<void> {
    await this.defaultFlowcontrol(name, 'receive')
  }

  /**
   * Bind a VRF: `vrf <name>` on **EOS 4.23 and later**, `vrf forwarding <name` below it — the exact
   * keyword split pyeapi composes at `interfaces.py:550-577`, which picks the keyword from
   * `self.version_number >= '4.23'`, a **raw string compare** on a device version string. This client
   * asks {@link Node.getVersion} (one memoised `show version` per `Node`) and compares the
   * `major.minor` segments **as numbers**: for 4.9-era devices the two answers genuinely differ, and
   * the numeric one is what a real release ordering implies — a recorded divergence, not a silent fix
   * (divergence 18, DR-078).
   *
   * Upstream validates no name on the wire path at all (its `tests loop` the method over six different
   * kinds, `test_api_interfaces.py` module-level `INTERFACES` `:44-45`); the per-kind refusal is the
   * facade's `Et`-prefix dispatch, which is the only upstream user surface (DR-006). The test-era
   * answer this client ports is `test_set_vrf` at `:297` (`interface X` + `vrf forwarding testvrf`
   * against the mock node's `'4.17.1.1'`, `test/lib/testlib.py` — same commands this verb emits under
   * a pre-4.23 version).
   */
  async setVrf(name: string, vrf: string): Promise<void> {
    assertEthernetName('setVrf', name)
    assertVrfValue(vrf)
    const keyword = await this.vrfKeyword()
    await this.configureInterface(name, [this.commandBuilder(keyword, { value: vrf })])
  }

  /** `no vrf` / `no vrf forwarding` — pyeapi's `set_vrf(name, vrf, disable=True)`; the name argument does not survive the negation upstream either (`command_builder`'s disable arm returns `no <keyword>` bare, `:550-577` + `abstract.py:154-155`). Whether a name-carrying `no vrf <name>` is valid is unverified on hardware, M12 (#14); this client composes exactly the text upstream composes. */
  async unsetVrf(name: string): Promise<void> {
    assertEthernetName('unsetVrf', name)
    const keyword = await this.vrfKeyword()
    await this.configureInterface(name, [this.commandBuilder(keyword, { mode: 'no' })])
  }

  /** `default vrf` / `default vrf forwarding` — pyeapi's `set_vrf(name, vrf, default=True)` (the default arm drops the name, `abstract.py:152-153`; pinned by its `set_vrf` group's default tests). */
  async defaultVrf(name: string): Promise<void> {
    assertEthernetName('defaultVrf', name)
    const keyword = await this.vrfKeyword()
    await this.configureInterface(name, [this.commandBuilder(keyword, { mode: 'default' })])
  }

  /**
   * The version-selected VRF keyword. The floor is pyeapi's own `'4.23'` literal, read from
   * `VersionProperties.versionNumber` (the client's parsed leading-digits form, not pyeapi's raw
   * device string); an unclassifiable version is **refused**, because either arm could be the wrong
   * command for the box in front of us (DR-032/DR-057, divergence 18).
   */
  private async vrfKeyword(): Promise<'vrf' | 'vrf forwarding'> {
    const info = await this.node.getVersion()
    const atLeast = versionFloorCompare(info.versionNumber, VRF_BARE_FORM_MIN)
    if (atLeast === undefined) {
      throw new NotSupportedError(
        `cannot pick the VRF command form: this device's version ${pythonRepr(info.version)} (parsed number ${pythonRepr(info.versionNumber)}) has no leading major.minor to compare against ${pythonRepr(VRF_BARE_FORM_MIN.join('.'))} — pyeapi would string-compare whatever it was given against '4.23' (api/interfaces.py:550-577) and this client refuses to guess which \`vrf\` command a device it cannot name accepts (DR-032/DR-057)`,
      )
    }
    return atLeast ? 'vrf' : 'vrf forwarding'
  }

  // --- PortchannelInterface verbs, M10c (#12): interfaces.py:578-813 ------------------------------

  /**
   * The live member list, from `show port-channel <id> all-ports` — pyeapi's `get_members`
   * (`interfaces.py:660-675`) ported with its **text scrape** and its exact regular expression,
   * `re.findall(r'\b(?!Peer)Ethernet[\d/]*\b', output)`: the negative look-ahead is why a
   * `Peer-Ethernet` MLAG peer name is not a member, and the class keeps slot digits, so an
   * `Ethernet1/1`-shaped token in the output is read verbatim — a name this client's grammar refuses,
   * which is why {@link setMembers} names members it will not compose.
   *
   * Upstream reads `config[0]['result']['output']` positionally off the `enable` answer
   * (`:672-675`) and raises `TypeError`/`IndexError` on a malformed reply; this verb goes through
   * `Node.showText`, whose own shape checks produce the typed `ProtocolError`/`CommandError` instead
   * (DR-005/DR-010). The record's `portChannel.members` is the config-side relation
   * ({@link interfacesFromSections}, divergence 15); this is the device read the PLAN names.
   *
   * @throws {NotSupportedError} a name the Port-Channel guard refuses.
   * @throws {CommandError} the device refuses the show (1002/1003 or role) — the failure is reported,
   *   not swallowed into an empty member list, because "no members" and "no answer" are different
   *   statements a UI must be able to tell apart (DR-029).
   */
  async getMembers(name: string): Promise<string[]> {
    assertPortChannelName('getMembers', name)
    return membersFromOutput(await this.showPortChannelText(name))
  }

  /** The one device read behind {@link getMembers} and the diff verbs — command literal ported from `interfaces.py:667/672`. */
  private async showPortChannelText(name: string): Promise<string> {
    const grpid = GROUP_ID.exec(name)?.[1] ?? ''
    return this.node.showText(`show port-channel ${grpid} all-ports`)
  }

  /**
   * The live LACP mode: ask the device which members it has, then read the first of them this client
   * can parse a channel-group mode from — pyeapi's `get_lacp_mode` (`interfaces.py:639-658`) runs the
   * same search (`channel-group<whitespace><digits><whitespace>mode<whitespace>(.+)`) on the **first
   * member it fetched** and answers `DEFAULT_LACP_MODE = 'on'` when the member list is empty
   * (`:67`/`:653`) even though the group mode may be `active` or `passive`, and raises `TypeError`
   * from re.search(pattern, None) when that member has no running-config section
   * (`:655-658` + `abstract.py:96-101`). Both answers are refusals to look further; this client scans
   * its members and answers **absent** when none of the blocks name a mode (divergence 19).
   */
  async getLacpMode(name: string): Promise<string | undefined> {
    assertPortChannelName('getLacpMode', name)
    const members = await this.getMembers(name)
    return this.lacpModeFromMembers(members)
  }

  /** The shared search behind {@link getLacpMode} — also what {@link setMembers} uses, without paying for the fetch twice. */
  private async lacpModeFromMembers(members: readonly string[]): Promise<string | undefined> {
    for (const member of members) {
      const parsed = parseInterfaceName(member)
      if (parsed === undefined) continue
      const block = await this.getBlock(`interface ${parsed.name}`)
      if (block === undefined) continue
      for (const line of parseBlock(block).body) {
        const relation = CHANNEL_GROUP_LINE.exec(line.text)
        if (relation !== null && relation[2] !== undefined) return relation[2]
      }
    }
    return undefined
  }

  /**
   * Make exactly `members` the set: a remove/replace **diff**, not a blind rewrite — pyeapi's
   * `set_members` (`interfaces.py:677-717`) computes "the ones now that shouldn't be" as
   * `interface <m>` + `no channel-group <id>` pairs and "the ones that should be and aren't" as
   * `interface <m>` + `channel-group <id> mode <mode>` pairs, in ONE transaction, and sends **nothing**
   * when the two lists come out empty (the `if commands else True` line, `:717` — pinned by
   * `test_set_members_no_changes`, whose `cmds=None` assertion is "no config call happened at all",
   * `test/lib/testlib.py`).
   *
   * Upstream's current-members source is the `show port-channel all-ports` scrape, so this verb asks
   * the device ({@link getMembers}) rather than trusting the local table — and its `mode` handling is
   * ported faithfully, including the side effect: when a `mode` is given and differs from the mode the
   * members currently carry, pyeapi first **rewrites every current member** (`self.set_lacp_mode`,
   * `:713`, a full remove-then-add batch of its own) and then composes the diff with the new mode —
   * two config transactions (divergence 20, DR-080; upstream's own `:997-1009` test could only see
   * the LAST `configure` call, `test/lib/testlib.py:79`, so the first batch is easy to miss in a
   * review). When no mode is given and none can be read from any member, the verb refuses instead of
   * writing pyeapi's `channel-group 1 mode None` string (divergence 19/DR-077).
   *
   * The member names this verb composes into `interface <member>` lines deliberately get **no name
   * guard**: upstream validates none, and a member scraped from the device that this client's grammar
   * does not have (`Ethernet1/1`) must still be removable — the device is the authority on whether the
   * line works (DR-005), a client-side guard would silently strand it.
   */
  async setMembers(name: string, members: readonly string[], mode?: LacpMode): Promise<void> {
    assertPortChannelName('setMembers', name)
    if (mode !== undefined) assertLacpMode(mode)
    const grpid = GROUP_ID.exec(name)?.[1] ?? ''
    const current = await this.getMembers(name)

    let effective = mode
    if (effective !== undefined) {
      const found = await this.lacpModeFromMembers(current)
      if (found !== undefined && found !== effective) {
        await this.rewriteMembers(current, grpid, effective) // pyeapi's set_lacp_mode side call, :713
      }
    } else {
      effective = await this.lacpModeFromMembers(current)
      if (effective === undefined && current.length > 0) {
        throw new NotSupportedError(
          `setMembers(PortChannel ${pythonRepr(name)}): no mode given and no current member names a channel-group mode to reuse — pyeapi would interpolate Python None and write \`channel-group ${grpid} mode None\` (api/interfaces.py:704-707 reached via get_lacp_mode's None answer, :639-658); name the mode instead (DR-077)`,
        )
      }
    }

    const commands: string[] = []
    for (const member of current) {
      if (members.includes(member)) continue
      commands.push(`interface ${member}`, `no channel-group ${grpid}`)
    }
    for (const member of members) {
      if (current.includes(member)) continue
      commands.push(`interface ${member}`, effective === undefined ? `channel-group ${grpid}` : `channel-group ${grpid} mode ${effective}`)
    }
    if (commands.length === 0) return
    await this.configure(commands)
  }

  /**
   * Set the LACP mode on **every current member** — pyeapi's `set_lacp_mode` (`interfaces.py:718-746`):
   * it fetches the live member list (`get_members`, `:732-733`) and composes ALL the `no channel-group`
   * removals before ALL the `channel-group <id> mode <new>` re-adds in one flat
   * `remove + add`-ordered transaction (`:745`), pinned by test_set_lacp_mode's eight-line expectation.
   * With no members upstream would send `configure([])` (one bare `configure terminal`); this client
   * treats an empty plan as no transaction — pinning that difference is the row, DR-077's refusal
   * family.
   */
  async setLacpMode(name: string, mode: LacpMode): Promise<void> {
    assertPortChannelName('setLacpMode', name)
    assertLacpMode(mode)
    const grpid = GROUP_ID.exec(name)?.[1] ?? ''
    await this.rewriteMembers(await this.getMembers(name), grpid, mode)
  }

  /** The shared remove-then-add batch behind {@link setLacpMode} and {@link setMembers}' mode-change side effect. */
  private async rewriteMembers(members: readonly string[], grpid: string, mode: LacpMode): Promise<void> {
    if (members.length === 0) return
    const remove: string[] = []
    const add: string[] = []
    for (const member of members) {
      remove.push(`interface ${member}`, `no channel-group ${grpid}`)
      add.push(`interface ${member}`, `channel-group ${grpid} mode ${mode}`)
    }
    await this.configure([...remove, ...add])
  }

  /**
   * `port-channel min-links <n>` — pyeapi's `set_minimum_links(name, value)` (`interfaces.py:747-759`,
   * `test/unit/test_api_interfaces.py:305-428` pin the trio texts and `test_set_minimum_links_with_value`
   * a random 1..16). The positive-integer floor is this client's (see {@link assertPortBandValue}); the
   * platform bound stays the device's.
   */
  async setMinimumLinks(name: string, value: number): Promise<void> {
    assertPortChannelName('setMinimumLinks', name)
    assertPortBandValue(value, 'minimum links value') // pyeapi validates nothing on this verb — interfaces.py:747-759, pinned positive at test_api_interfaces.py:305-428 (min-links random 1..16)
    await this.configureInterface(name, [this.commandBuilder(MIN_LINKS_KEYWORD, { value })])
  }

  /** `no port-channel min-links` — pyeapi's no-value default arm and its `disable=True` arm, one text, one verb (`interfaces.py:752-753` + `abstract.py:154-161`; both pinned by the min-links `with_no_value` / `with_disable` tests — the fixture's own negation line, `running_config.portchannel:18`). */
  async unsetMinimumLinks(name: string): Promise<void> {
    assertPortChannelName('unsetMinimumLinks', name)
    await this.configureInterface(name, [this.commandBuilder(MIN_LINKS_KEYWORD, { mode: 'no' })])
  }

  /** `default port-channel min-links` — pyeapi's `default=True` arm (`:752` + `abstract.py:152-153`; pinned by `test_set_minimum_links_with_default`). */
  async defaultMinimumLinks(name: string): Promise<void> {
    assertPortChannelName('defaultMinimumLinks', name)
    await this.configureInterface(name, [this.commandBuilder(MIN_LINKS_KEYWORD, { mode: 'default' })])
  }

  /**
   * `port-channel lacp fallback <individual|static>` — pyeapi's `set_lacp_fallback`
   * (`interfaces.py:771-805`, pinned by the `with_individual` / `with_static` / `with_disabled` /
   * `invalid_mode` group): the two value-carrying modes here, and the third — `'disabled'`, which
   * upstream turns into the `no` arm — is {@link unsetLacpFallback}, because a mode string and a
   * negation are different intents (DR-037/DR-077).
   */
  async setLacpFallback(name: string, mode: LacpFallbackMode): Promise<void> {
    assertPortChannelName('setLacpFallback', name)
    assertLacpFallbackMode(mode)
    await this.configureInterface(name, [this.commandBuilder(LACP_FALLBACK_KEYWORD, { value: mode })])
  }

  /** `no port-channel lacp fallback` — upstream's `mode='disabled'` arm (`interfaces.py:786-789`; pinned by `test/unit/test_api_interfaces.py`'s `test_set_lacp_fallback_with_disabled`, and the config-side mirror is the fixture's line at `running_config.portchannel:19`). */
  async unsetLacpFallback(name: string): Promise<void> {
    assertPortChannelName('unsetLacpFallback', name)
    await this.configureInterface(name, [this.commandBuilder(LACP_FALLBACK_KEYWORD, { mode: 'no' })])
  }

  /**
   * `port-channel lacp fallback timeout <seconds>` — pyeapi's `set_lacp_timeout`
   * (`interfaces.py:806-813`; `test_set_lacp_timeout_with_value` and `test_get` pair the write with the
   * fixture's `port-channel lacp fallback timeout 90`, `running_config.portchannel:20`). No value: the
   * guard, not upstream's fall-through to the **defaulted** reader answer — and the record never
   * reports `90` because that is a module constant, not the device's line (DR-076).
   */
  async setLacpTimeout(name: string, value: number): Promise<void> {
    assertPortChannelName('setLacpTimeout', name)
    assertPortBandValue(value, 'lacp fallback timeout') // pyeapi's only timeout test uses a random 1..16 — interfaces.py:806-813, no bound anywhere
    await this.configureInterface(name, [this.commandBuilder(LACP_TIMEOUT_KEYWORD, { value })])
  }

}

/**
 * Upstream's member-scrape answer, verbatim (`interfaces.py:673-674`): every `Ethernet…` token that is
 * not introduced by `Peer`, keeping slot digits. Exported only for `interfaces.test.ts` to pin the
 * exact look-around semantics — production code reaches it through
 * {@link InterfacesResource.getMembers}.
 */
export function membersFromOutput(output: string): string[] {
  return output.match(/\b(?!Peer)Ethernet[\d/]*\b/gu) ?? []
}
