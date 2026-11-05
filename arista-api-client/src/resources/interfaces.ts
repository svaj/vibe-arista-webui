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
 * command (`testing/mock-transport.ts:167` compares a string matcher against the **whole joined command
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
 *    (`internal/wire.ts:553-567`, DR-012). Every count is pinned in `interfaces.test.ts` and
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
import type { ConfigBlock } from '../config/text'
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
  /** The matching `show interfaces status` row, when it was read (divergence 8). */
  readonly status?: InterfaceStatus
}

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
 * Two rules in one refusal, because the second is a property of the same name: it has to parse
 * (`assertInterfaceName`, row 76), and it must not be an Ethernet. Upstream splits those across classes —
 * `EthernetInterface.create`/`delete` raise `NotImplementedError` for a name without a dot (`:415-445`,
 * pinned by `test_api_interfaces.py:211-224`) — and the dotted form that class **does** support is still
 * refused by the shared guard until M12 (#14) captures the subinterface grammar (open item 7). So today
 * no Ethernet create/delete is possible, which is stated in the message rather than left as a surprise.
 */
function assertPresentName(verb: 'create' | 'delete', value: unknown): void {
  const parsed = parseInterfaceName(value)
  if (parsed !== undefined && parsed.subinterface === undefined && parsed.kind !== 'Ethernet') return
  refuse(
    `${verb} interface`,
    value,
    `expected a name \`assertInterfaceName\` accepts — one of ${INTERFACE_KINDS.join(' / ')} followed by an index, with no subinterface suffix — and not an Ethernet: pyeapi's EthernetInterface refuses create/delete for a physical interface (api/interfaces.py:415-445, pinned by test/unit/test_api_interfaces.py:211-224) and M10b (#12) owns that half, while the Ethernet subinterface form it does allow is still refused for want of device evidence (DECISIONS.md open item 7)`,
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
 * The block's administrative state: the first exact `no shutdown` / `shutdown` body command line in
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

/** One `interface …` section into a record. Exactly one section, so `sections` is the chunked document. */
function interfaceFromSection(sectionKey: string, name: string, block: ConfigBlock): Interface {
  const parsed: ParsedInterfaceName | undefined = parseInterfaceName(name)
  const description = valueAfterKeyword(block.body, DESCRIPTION_KEYWORD)
  const mtu = numberFieldFromBlock(valueAfterKeyword(block.body, MTU_KEYWORD), MTU_KEYWORD, sectionKey)
  const encapsulation = numberFieldFromBlock(valueAfterKeyword(block.body, ENCAPSULATION_KEYWORD), ENCAPSULATION_KEYWORD, sectionKey)
  const shutdown = shutdownFromBlock(block)
  return {
    name,
    kind: parsed?.kind ?? null,
    ...(shutdown === undefined ? {} : { shutdown }),
    ...(description === undefined ? {} : { description }),
    ...(mtu === undefined ? {} : { mtu }),
    ...(encapsulation === undefined ? {} : { encapsulation }),
  }
}

/**
 * Every interface in a chunked running-config, in one pass and **one** config read (DR-030/DR-055).
 *
 * Upstream's `getall` (`:95-115`) costs a `section()` key scan and two regex passes per interface, drops
 * whatever its `get` answers falsy (`if interface:`, `:174`) and cannot answer at all when one `_parse_*`
 * crashes. Here the only filter is the section header, and a section that fails to parse throws a
 * {@link ConfigParseError} naming it rather than vanishing from the table (DR-059).
 */
function interfacesFromSections(sections: ConfigSections): Map<string, Interface> {
  const interfaces = new Map<string, Interface>()
  for (const [key, sectionText] of sections) {
    const name = INTERFACE_SECTION.exec(key)?.[1]
    if (name === undefined) continue
    interfaces.set(name, interfaceFromSection(key, name, parseBlock(sectionText)))
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
 *   answer M2's codec produces for a `1003 COMMAND_UNCONVERTED` (`internal/wire.ts:544-562`): an
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
   * is a non-event on the device, and the Ethernet refusal in {@link assertPresentName] says which cases
   * this client will not attempt at all. A device refusal rejects with its `CommandError` (DR-005).
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
   * when there was nothing to delete. Same command text, no `True` to check (DR-005), same refusal for a
   * physical Ethernet as {@link create}.
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

}
