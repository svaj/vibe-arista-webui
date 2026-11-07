/**
 * `interfaces` — the M10a + M10b + M10c slices of `pyeapi/api/interfaces.py` (#12): the
 * {@link InterfacesResource} facade, the {@link BaseInterface} verbs it is built from, the per-kind
 * interface-name parser that replaces M7's single regex, and the `EthernetInterface` /
 * `PortchannelInterface` per-kind fields and verbs.
 *
 * Port of `pyeapi/api/interfaces.py` (1,101 lines, BSD-3-Clause, Arista Networks — DR-001). PLAN.md §M10
 * splits the module into four slices: **M10a** = `Interfaces` + `BaseInterface` + the name parser;
 * **M10b** = `EthernetInterface` (sflow / flowcontrol / vrf, `:330-577`); **M10c** =
 * `PortchannelInterface` (members / LACP / min-links, `:578-813`); **M10d** = `VxlanInterface`
 * (`:814-1090`), landed by W3b lane B (#52) as the {@link Interface.vxlan} field group
 * ({@link vxlanFieldsFromBlock}) and the VXLAN verbs at the end of {@link InterfacesResource} — the
 * DR-068 shape again: a per-kind **field group**, not a per-kind object and not a registry row.
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
 | `EthernetInterface.get` (`:335-365`) with `_parse_sflow` (`:367-379`), `_parse_flowcontrol_send` (`:381-396`) and `_parse_flowcontrol_receive` (`:398-413`) | the {@link Interface.ethernet} field group on an Ethernet-kind section ({@link ethernetFieldsFromBlock}) — sFlow read as whole command lines, flowcontrol read verbatim, VRF read though upstream never reads it — **divergences 13/14/16**, and the port-channel reads' absent-not-defaulted discipline is **DR-076** |
 | `EthernetInterface.set_flowcontrol*` (`:447-472` composing through `set_flowcontrol` at `:513-524`), `set_sflow` (`:526-548`), `set_vrf` (`:550-576`, which picks its keyword with `if self.version_number >= '4.23'` at `:568`) | {@link setFlowcontrol} / {@link setFlowcontrolSend} / {@link setFlowcontrolReceive} and their `unset`/`default` pairs, {@link setSflow} trio, {@link setVrf} trio behind {@link assertEthernetName} — upstream's `ValueError` guards and its two silent-`False` answers become typed refusals (**divergence 17**, DR-077), and the version floor becomes a numeric segment compare (**divergence 18**, DR-078) |
 | `PortchannelInterface.get` (`:583-616`) with `_parse_minimum_links` / `_parse_lacp_fallback` / `_parse_lacp_timeout` (`:618-638`, defaulting to `0` / `'disabled'` / `90`), `get_lacp_mode` (`:639-658`), `get_members` (`:660-675`) | the {@link Interface.portChannel} field group ({@link portChannelFieldsFromBlock} + {@link interfacesFromSections}' group facts) plus {@link getLacpMode} / {@link getMembers} — read values stay absent where upstream substitutes a module constant, and members come from the running-config relation instead of only the text scrape (**DR-076**, divergence 15) |
 | `PortchannelInterface.set_members` (`:677-716`), `set_lacp_mode` (`:718-745`), `set_minimum_links` (`:747-769`), `set_lacp_fallback` (`:771-793`), `set_lacp_timeout` (`:795-811`) | {@link setMembers} / {@link setLacpMode} / {@link setMinimumLinks} trio / {@link setLacpFallback} + {@link unsetLacpFallback} / {@link setLacpTimeout} — same diff and same remove-then-add batch, with the mode-change side call kept as **two** transactions (**divergence 20**, DR-080) |
 | `VxlanInterface.get` (`:822-859`, its own `get_block` call at `:846`, `super()` at `:850`, the six parsers merged at `:853-858`) with `_parse_source_interface` (`:862-878`), `_parse_multicast_group` (`:879-885`), `_parse_multicast_decap` (`:886-890`), `_parse_udp_port` (`:891-895`), `_parse_vlans` (`:896-913`) and `_parse_flood_list` (`:914-919`) | the {@link Interface.vxlan} field group ({@link vxlanFieldsFromBlock}) — upstream's three distinctive reader regexes ported **verbatim with their quirks pinned** (the 3-digit leading octet, the `VLAN-ID` findall, the `[\d. ]` flood class), while its `''`-module-constant defaults, its `NoneType` crash on a missing `udp-port`, its XOR substring decap test and its `frozenset` key order are not (**divergences 21/22**) |
 | `VxlanInterface.set_source_interface` (`:921-941`), `set_multicast_group` (`:943-967`, `CliVariants(cmds_new, cmds_dpr)` at `:966-967`), `set_multicast_decap` (`:969-991`), `set_udp_port` (`:994-1012`), `add_vtep`/`remove_vtep` (`:1014-1056`, the `if not vlan` truth test at `:1030`/`:1052`), `update_vlan` (`:1058-1073`), `remove_vlan` (`:1075-1090`, `CliVariants` with a literal `$` first at `:1088-1090`); the class **overrides no `create`/`delete`/`default`** — those are inherited `BaseInterface` (`:211-254`) | {@link setSourceInterface} trio, {@link setMulticastGroup} trio (the decap-spelling first, legacy fallback — {@link InterfacesResource.configureInterfaceVariants} over `internal/variants.tryVariants`), {@link setMulticastDecap} trio, {@link setUdpPort} trio, {@link addVtep}/{@link removeVtep} with both bare and vlan-scoped spellings, {@link updateVlan}, {@link removeVlan} (**divergences 23/24**); Vxlan presence verbs were already ported by M10a and stay where they are (**divergence 25**) |
 * | `_parse_shutdown` (`:179-191`): `'no shutdown' not in config` (`:190`) | {@link shutdownFromBlock} — a parsed body **command line**, three answers instead of two — divergence 3 |
 * | `_parse_description` (`:193-209`): `re.search(r'description (.+)$', config, re.M)` (`:206`), raw remainder, first match wins | {@link valueAfterKeyword} (`config-block.ts`) over the block body — the shared keyword extractor, so a value can no longer answer for another field (row 91's rule) — divergence 4 |
 * | `create` / `delete` / `default` (`:211-254`): `return self.configure('interface %s')` (`:226`) / `'no interface %s'` (`:243`) / `'default interface %s'` (`:254`) | {@link InterfacesResource.create} / {@link delete} / {@link setDefault} — same three command texts, no `True` to check (DR-005), plus the physical-Ethernet rule from divergence 5 — and Port-Channel create/delete are the same pair on a non-dotted name, since upstream's `PortchannelInterface` inherits `BaseInterface.create`/`delete` rather than overriding them |
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
 * 2026-11-04), of which **M10a's** round (`#12, PR #30`) covered `TestFunctions` (`:48-62`), `TestApiInterfaces` (`:65-91`) and
 * `TestApiBaseInterface` (`:94-171`): `test_isvalidinterface_returns_true` (`:50-53`),
 * `_returns_false` (`:55-58`), `test_instance` (`:60-62`), `test_get_interface_generic` (`:72-75`),
 * `test_get_interface_ethernet` (`:77-79`), `test_get_invalid_interface` (`:81-83`),
 * `test_proxy_method_success` (`:85-87`), `test_proxy_method_raises_attribute_error` (`:89-91`),
 * `test_get` (`:101-105`), `test_set_description_with_value` / `_with_no_value` / `_with_default`
 * (`:107-124`), `test_set_shutdown` / `_with_disable` / `_with_default` (`:126-142`) and the five
 * `test_set_encapsulation_*` (`:144-171`). Every command text they pin is reproduced verbatim in
 * `interfaces.test.ts`; the `AttributeError`/`NotImplementedError` answers are ported as typed
 * refusals. M10b/M10c (#12, this commit) port the two remaining groups: `TestApiEthernetInterface`
 * (`:174-303`) — `test_get` (`:183-189`), `test_instance_functions` (`:191-209`),
 * `test_instance_functions_exceptions` (`:211-224`) and the flowcontrol / sflow / vrf families
 * (`:225-302`) — and `TestApiPortchannelInterface` (`:305-428`) — `test_get` (`:318-326`), the min-links /
 * timeout / fallback families (`:328-373`), `test_get_lacp_mode` (`:375-377`), `test_get_members`
 * (`:379-381`), the five `test_set_members_*` (`:383-414`), `test_set_lacp_mode` (`:416-422`) and
 * `test_set_lacp_mode_invalid_mode` (`:424-427`). M10d (#52, W3b lane B) ports the last class,
 * `TestApiVxlanInterface` (`:429-531`, **19** methods): `test_get` (`:436-442`), the
 * `set_source_interface` / `set_multicast_group` / `set_multicast_decap` / `set_udp_port` quads
 * (`:443-502`, each trio of arms pinning one command text), `test_update_vlan` (`:503-507`),
 * `test_remove_vlan` (`:508-512`), and the four VTEP pins (`:513-531`). Their fixture is
 * `test/fixtures/running_config.vxlan` (50 lines; the six VXLAN families sit at `:39-49`), quoted
 * byte-exactly in `interfaces.test.ts`; the sibling `test/fixtures/vxlan.json` exists upstream but is
 * referenced by **no** upstream test (grep, 2026-11-07 — it appears only in `.git/index`), and this
 * client has no reader that would use it, so it is not ported.
 * Upstream's `EapiConfigUnitTest` mock answers `{}` to anything it was not told about, records only the
 * **last** `config` call (`test/lib/testlib.py:100`), asserts `call_count == 0` for a `cmds=None` pin
 * (`:109`), and drops the command list entirely on an exception pin (`:121-123`) — so several of its
 * pins cannot see half of what the method sent; here an unscripted request is a hard failure, so every
 * batch spells every command and the two-transaction verbs pin both calls
 * (`testing/mock-transport.ts:83-88` compares a string matcher against the **whole joined command
 * list**, not a prefix).
 *
 * ## Divergences this file owns — numbered in MIGRATION.md §5 rows **99-106** (M10a's band) and
 * **125-134** (M10b/M10c's band)
 *
 * Mapping for a reviewer: 1→99, 2→100, 3→101, 4 and 10→102, 5→103, 6→104, 7→105, and 8/9/11/12→106.
 * Decisions taken here are **DR-067** (the per-kind grammar), **DR-068** (per-kind fields, never
 * per-kind objects) and **DR-069** (a recording of the exact command outranks an inferred spelling).
 * M10b/M10c's divergences 13-20 land in the assigned band, rows **125-132** — the band **123-130** that
 * PR #29's merge note tentatively reserved for #12 is **superseded** by the band this lane was given
 * (125-134), and the band's last two numbers are deliberately left unused rather than padded. Second-half mapping (not ascending,
 * because the rows are grouped by what a reviewer reads together):
 * **13→126, 14→132, 15→125, 16→127, 17→128, 18→131, 19→129, 20→130**, and the decisions are
 * **DR-075** (members from the config relation), **DR-076** (absence survives a read), **DR-077** (the
 * refusal replaces upstream's `ValueError` **and** its silent `False`), **DR-078** (the VRF keyword is a
 * numeric version compare, refused when unclassifiable), **DR-079** (the channel-group mode is one type on
 * both sides of the wire) and **DR-080** (a diff verb owns its side effects).
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
 *    a Port-Channel / Vlan / Management / Loopback / Vxlan interface and an Ethernet **subinterface**
 *    (`Ethernet1.100`, the form upstream pins), and cannot create a physical Ethernet or a dotted name of
 *    another kind. Upstream's `default interface Ethernet1` **is** ported
 *    (`:245-254`, pinned positive at `test_api_interfaces.py:191-209`). M10b (#12, this commit) is what
 *    owns the Ethernet pair, so the refusal shrank from "every Ethernet form" to "the physical form" — the
 *    four M10a pins that asserted the wider refusal were re-issued in `interfaces.test.ts` against the new
 *    boundary rather than deleted.
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
 *
 * ## M10b/M10c divergences (this lane, #12) — §5 rows 125-132, decisions DR-075..080
 *
 * 13. **absence is not a value on the Port-Channel reads.** Upstream's three `_parse_*` readers substitute
 *     module constants when the section writes nothing: `minimum_links` → `0` (`:618-624`),
 *     `lacp_fallback` → `DEFAULT_LACP_FALLBACK = 'disabled'` (`:625-631`, `:68`), `lacp_timeout` →
 *     `DEFAULT_LACP_FALLBACK_TIMEOUT = 90` (`:632-638`, `:69`) — and `get_lacp_mode` answers
 *     `DEFAULT_LACP_MODE = 'on'` for a group with no members (`:651-653`, `:67`). Its own `test_get`
 *     (`test_api_interfaces.py:318-326`) pins the three invented answers against the fixture that provokes
 *     them: `running_config.portchannel:18` writes `no port-channel min-links` and reads back `0`; `:19`
 *     writes `no port-channel lacp fallback` and reads back the word `'disabled'`; only `:20`'s
 *     `port-channel lacp fallback timeout 90` is honest. Here a `no` line and an absent line both read
 *     **absent** ({@link numberFieldFromBlock} / {@link lacpFallbackFromBlock} /
 *     {@link portChannelFieldsFromBlock}), because "the switch turned this off" and "the switch has 90 by
 *     default" are different statements a UI must not confuse (DR-029/DR-057) — and the fallback reader
 *     additionally has to skip the `port-channel lacp fallback timeout <n>` line, which a keyword-anchored
 *     value read would otherwise report as the mode `timeout 90`. **DR-076.**
 * 14. **the VRF binding is read back although upstream only ever writes it.** `EthernetInterface.get`
 *     composes only sflow and the two flowcontrol directions (`:335-366` with the parsers at `:367-414`);
 *     `set_vrf` (`:550-576`) has no reader anywhere in the module, so pyeapi cannot answer which VRF a port
 *     is in. {@link vrfFromBlock} reads the same two keyword forms this client's own verb composes
 *     ({@link setVrf}, divergence 18) plus the `vrf DAT` shape pyeapi's fixture already carries
 *     (`running_config.text:1475`, beside the `vrf default` lines at `:2130`/`:2189`), so a
 *     `setVrf` → `getAll` round trip closes. Absence stays absence: whether 4.28.13.1M writes a line for a
 *     port in the default VRF is a device question (DECISIONS.md open item 2's VRF-licensing family), and
 *     reporting `'default'` from silence would be the invention DR-057 names.
 * 15. **members come from the running-config relation, and the live scrape stays a separate verb.**
 *     `get_members` (`:660-675`) takes the group id from the Port-Channel **name** (`:671`), runs
 *     `show port-channel <id> all-ports` as **text** (`:672-673`) and regexes
 *     `\b(?!Peer)Ethernet[\d/]*\b` out of the output (`:674-675`); `get` (`:611`) and `set_members` (`:700`)
 *     both treat that scrape as the member list. The record's `portChannel.members` instead reads the
 *     members' own `channel-group <id> [mode <word>]` lines from the config this read already fetched
 *     ({@link interfacesFromSections}) — which is where upstream's `get_lacp_mode` looks as well
 *     (`:655-658` greps each member's `get_block('^interface %s')`), so the config is upstream's own source
 *     for half of this answer. The scrape is still a verb ({@link getMembers}, its expression ported verbatim
 *     as {@link membersFromOutput}) because "what the switch reports the LAG holds" and "what the
 *     running-config declares" are different facts, and a review screen has to be able to see them
 *     disagree. **DR-075.**
 * 16. **sFlow and flow-control are read as commands, not as characters inside a block.**
 *     `_parse_sflow` is `'no sflow' not in config` (`:367-379`, the assignment at `:378`), a substring search over
 *     the whole block: a section with **no** sflow line reads `sflow: true`, and any line merely containing those
 *     six characters (a description, `no sflow <anything>`, an indented sub-mode) reads `false`. Upstream's own
 *     `test_get` (`test_api_interfaces.py:183-189`) is **not** evidence of the first half: the fixture section it
 *     reads (`test/fixtures/running_config.text:542-675`) really does carry `sflow enable` at `:652`, so its
 *     `sflow: True` is a real line answering — the earlier draft of this note claimed that section carried no
 *     sflow line, and the re-read on 2026-11-05 retired that claim (the fabricated `true` is pinned against a
 *     config of this suite's own instead). Here the two whole body
 *     commands `sflow enable` / `no sflow enable` answer, in device order, and neither present is absent
 *     ({@link sflowFromBlock}, the {@link shutdownFromBlock} shape). The flowcontrol readers (`:381-414`)
 *     hard-code `'off'` when the block writes neither line and take `(\w+)$` when it does, so
 *     `no flowcontrol send` reads back `off` — one answer for three different writes. Here the value is read
 *     behind the keyword ({@link valueAfterKeyword}), so neither the `no` nor the `default` arm answers as a
 *     value, while a device word outside `on|off` is reported **verbatim** rather than coerced: the writer's
 *     pair is client policy ({@link assertFlowcontrolValue}), the reader's job is what the switch wrote
 *     (DR-059/DR-069).
 * 17. **upstream's bad-input answers become typed refusals, and the per-kind surface is stated rather than
 *     dispatched.** This slice's methods refuse bad input three different ways: `ValueError('invalid
 *     flowcontrol value')` (`:513-515`), `ValueError('invalid direction specified')` (`:517-518`), a **bare**
 *     `raise ValueError` carrying no message at all on `set_sflow` (`:542-543`), and `return False` — no
 *     exception, no reason, just a boolean a caller has to remember to check — for an unknown LACP mode
 *     (`set_lacp_mode`, `:731-732`, pinned non-raising at `test_api_interfaces.py:424-427`) or an unknown
 *     fallback mode (`set_lacp_fallback`, `:787-788`, pinned at `:371-373`). DR-005 deletes the boolean and
 *     every case lands as a {@link NotSupportedError} naming what upstream did (DR-010/DR-053). The surface
 *     half of the same decision: upstream's instance methods validate no name — its suite drives
 *     `EthernetInterface` over the module-level six-kind `INTERFACES` list (`:44-45` feeding `:280`, `:286`,
 *     `:292`, `:297`) because `isvalidinterface` guards only `marshall`, the dispatch DR-006 does not port
 *     (`:129-133`) — yet the only surface a caller has is the facade, whose prefix map reaches
 *     `EthernetInterface` for `Et` and produces `AttributeError` for a `Management1` (`:120-127`, `:1093-1097`,
 *     pinned at `:89-91`). {@link assertEthernetName} and {@link assertPortChannelName} model **that** surface
 *     and refuse anything else with a message that says so; whether the 7050TX-64 binds sflow / a VRF / a
 *     channel-group to another kind anyway is an M12 (#14) capture, not a licence to widen the verbs now
 *     (DR-032/DR-057, row 128).
 * 18. **`set_vrf`'s keyword is a numeric release compare, not a string compare.** Upstream picks `vrf` over
 *     `vrf forwarding` with `if self.version_number >= '4.23'` (`:568`, the two arms at `:569-575`) on a
 *     **string**, so `'4.9' >= '4.23'` is true and a 4.9-era device is handed the newer keyword; its suite
 *     cannot see the bug because the mock node pins `'4.17.1.1'` (`test/lib/testlib.py:81`), which is why the
 *     only VRF test pins `vrf forwarding testvrf` (`test_api_interfaces.py:297-302`). {@link vrfKeyword}
 *     compares the two leading segments of the client's parsed {@link VersionProperties.versionNumber} as
 *     numbers ({@link versionFloorCompare}) and **refuses** a version it cannot classify rather than guessing
 *     which command an unnameable device accepts (DR-032/DR-057). The command texts are upstream's verbatim
 *     and the device stays the authority on both forms — a `CommandError` path is pinned. **DR-078.**
 * 19. **the channel-group mode has one type end to end, and no invented answer.** `get_lacp_mode`
 *     (`:639-658`) answers `DEFAULT_LACP_MODE` (`:651-653`) for a group with no members — so a group whose
 *     members are configured `mode active` can be reported as `on` — and otherwise `return`s inside the
 *     **first** loop iteration (`:655-658`), which both stops it from ever looking at a second member and
 *     makes it raise `TypeError` from `re.search(pattern, None)` when that member has no running-config
 *     section (`abstract.py:96-101` answers `None`). `set_members` feeds that answer straight into
 *     `channel-group %s mode %s` (`:712-714`), so a parameterless call on such a group writes the literal
 *     text `channel-group 1 mode None` — and the suite pins that exact command as expected behaviour
 *     (`test_set_members_mode_none`, `test_api_interfaces.py:404-409`). Here the mode token read off a device
 *     line is validated against {@link LACP_MODES} ({@link readChannelGroupMode}): a section writing
 *     `channel-group 1 mode fast` is **reported** as a {@link ConfigParseError}, not published as a mode; the
 *     value is typed `LacpMode` from parse through verb argument (**DR-079**); the scan looks at every member
 *     rather than only the first and answers **absent** when none names a mode; and a `setMembers` call with
 *     no mode and no readable mode refuses rather than composing `mode None` (DR-077).
 * 20. **`setMembers` keeps upstream's side call as its own transaction, and an empty diff is no transaction
 *     at all.** `set_members` calls `self.set_lacp_mode(<grpid>, mode)` (`:702-704` — passing the bare group
 *     id, which works only because that verb re-extracts the digits from it, `:734`) when the requested mode
 *     differs from the current one, *before* composing its own add/remove diff. A mode change is therefore
 *     **two** config transactions: a full remove-then-add of every current member (`:736-745`, which
 *     momentarily detaches the whole LAG) and then the diff (`:706-714`). Upstream's test for exactly that
 *     case (`:397-402`) can only see the last call — `testlib.py:100` inspects `config.call_args` — so the
 *     detach batch is easy to miss in a review of upstream; {@link rewriteMembers} ports it and
 *     `interfaces.test.ts` pins **both** transactions in order. The `return self.configure(commands) if
 *     commands else True` line (`:716`) becomes "send nothing" (upstream pins that shape with `cmds=None`,
 *     which `testlib.py:109` turns into `config.call_count == 0`, at `:411-414`); and where `set_lacp_mode`
 *     with no members would still open a `configure terminal` carrying an empty list (`abstract.py:103-127`),
 *     {@link setLacpMode} performs no transaction for an empty plan. **DR-080.**
 *
 * ## M10d divergences (W3b lane B, #52) — §5 rows to be filed by this lane's ledger round (in-band)
 *
 * The numbers below are owned by this file NOW; the MIGRATION.md §5 rows and the platform-honesty DR
 * note (7050TX-64 VXLAN hardware support **unverified**; capability presence stays a probe question per
 * DR-033 — nothing in this slice claims the SKU does or does not do VXLAN, and every command here is
 * shipped as a **pyeapi-faithful** command text, not as a support statement) land in a later ledger
 * round of the same lane. Until then, `§5 rows 203-212` is the reserved band, and no `§5 row N`
 * citation appears in this slice's code comments.
 *
 * 21. **the Vxlan reads keep this file's absence discipline.** Upstream defaults nothing honestly: an
 *     unconfigured `source_interface`/`multicast_group` answers the module constants
 *     `DEFAULT_SRC_INTF = ''`/`DEFAULT_MCAST_GRP = ''` (`:816-817`, applied at `:877`/`:884`) so "not
 *     configured" and "configured as the empty string" collapse into one answer; `_parse_udp_port` does
 *     neither — it `int()`s the match **without checking** (`value = int(match.group(1))`, `:894`), so a
 *     Vxlan section without a `vxlan udp-port` line raises `AttributeError` on `None.group` and takes
 *     `get`/`getall` down with it (the fixture never provokes it because its `interface Vxlan1` carries
 *     the line at `running_config.vxlan:42`); `_parse_multicast_decap` answers `bool(val1 ^ val2)` over
 *     whole-**block substrings** (`:887-889`); and `_parse_vlans`/`_parse_flood_list` answer `{}`/`[]`
 *     for absence (`:913`, `:919`). Here all six fields follow the {@link Interface.ethernet} rule
 *     (DR-076's family applied to this kind): absence is absence, the missing-`udp-port` crash becomes
 *     an absent field, and a non-decimal or unrepresentable vni is a {@link ConfigParseError} via
 *     {@link numberFieldFromBlock} rather than pyeapi's silent string (it stores `match.group(1)` — a
 *     **str** — at `:906`). {@link multicastDecapFromBlock} reads the two whole command lines like
 *     {@link sflowFromBlock}; upstream's XOR happens to answer the fixture's
 *     `no vxlan multicast-group decap` line (`:49`) as `False` only **by coincidence** — that line also
 *     contains the positive substring, so `val1` and `val2` are both true and `False ^ False`-shaped
 *     reasoning never happens — and it answers `True` for a description that merely carries those
 *     characters, which this reader cannot be fooled by. A block carrying both decap lines is not a
 *     shape EOS is known to write, so the first line wins (divergence 3's rule, restated), where
 *     upstream's order-blind XOR would answer `False` at any order.
 * 22. **three upstream regexes ported verbatim, quirks pinned rather than smoothed.** The
 *     multicast-group reader keeps `([\d]{3}\.[\d]+\.[\d]+\.[\d]+)` (`:881-882`) — the leading octet
 *     must have **exactly three digits**, so a group whose first octet is `224` under any other spelling
 *     and anything 1- or 2-digit-leading reads back as absent (pinned, quirk and all); the per-VLAN scan
 *     keeps the unanchored `vxlan vlan (\d+)` **findall** (`:902`) — which also counts a
 *     `no vxlan vlan 10 …`-shaped line as an entry — and the per-vlan `vni`/`flood` searches keep
 *     upstream's unanchored first-match semantics ({@link firstGroupOf}); and the global flood list
 *     keeps `^ *vxlan flood vtep +([\d. ]+)$` (`:915`), whose character class means a VTEP written in
 *     any other shape makes the **whole line** unread, exactly as upstream, and the field then reports
 *     absent. Two upstream behaviours are replaced rather than ported: the `frozenset` round-trip at
 *     `:901-902` gives an **arbitrary** per-run iteration order, so `vlans` here is keyed by
 *     first-appearance in the section (deterministic and reviewable — pinned order); and reads run over
 *     parsed **body lines**, not the raw block string, so a match can never span a line boundary the way
 *     `re.search` over `get_block` output can. The `''`/`{}`/`[]`/crash answers belong to divergence 21;
 *     the **command texts** all stay upstream's verbatim.
 * 23. **the two `CliVariants` sites become tryVariants, and the pins see BOTH transactions.**
 *     `set_multicast_group` tries the decap spelling **first** and the legacy spelling as fallback
 *     (`CliVariants(cmds_new, cmds_dpr)`, `:966-967`, with `string_new`/`cmds_new` at `:963-965` and
 *     `string_dpr`/`cmds_dpr` at `:960-962`), and `remove_vlan`'s first variant carries a **literal
 *     trailing `$`** (`f'vxlan vlan remove {vid} vni $'`, `:1089` — an artefact upstream really sends;
 *     the clean text is the *second* variant at `:1090`). Upstream splices the marker at
 *     `client.py:644-653` (scan at `:629-634`), first success wins, last `CommandError` re-raised
 *     (`raise err`, `:653`) — which is exactly `internal/variants.ts`'s {@link tryVariants} contract
 *     (row 37's decision), reached per verb through
 *     {@link InterfacesResource.configureInterfaceVariants}. What is **not** ported is upstream's own
 *     test blindness: `test/lib/testlib.py:97-107` expands every variant and accepts a pin matching
 *     **any** of them, which is how `test_set_multicast_group_with_value` (`:458-462`) pins only the
 *     legacy text while the decap attempt runs first on the real client, and how `test_remove_vlan`
 *     (`:508-512`) passes for the `$`-suffixed opener without ever showing it. The spec here pins the
 *     actual pair: first-attempt text, the fallback transaction after a rejection, and the last error
 *     re-raised when both fail — the literal `$` quirk included.
 * 24. **writer guards are reader-derived, the falsy VLAN arm is a pinned truth table, and the device
 *     keeps authority.** Upstream validates nothing on any of these verbs (straight interpolation at
 *     `:939-941`, `:961-967`, `:986-991`, `:1010-1012`, `:1031-1034`, `:1053-1056`, `:1072-1073`,
 *     `:1088-1090`). Here {@link assertVxlanName} makes the facade's `Vx` class-map prefix
 *     (`:1093-1097`) explicit, exactly as {@link assertEthernetName} does for Ethernet (DR-068's
 *     surface argument), and every value guard refuses what THIS module's reader could not read back: a
 *     source-interface that is not one token (upstream's own pattern is `([^\s]+)`, `:876`), a multicast
 *     group outside the leading-3-digit shape its reader can match (divergence 22), a VTEP outside
 *     digits-and-dots (the flood class `[\d. ]`, `:915`), and a vlan scope or vni that is not decimal
 *     ({@link assertVlanScopeToken}/{@link assertVniValue} — client policy: the platform's VNI ceiling
 *     and VXLAN licensing are device answers, DR-032/DR-057; `0`-as-value is DR-037's falsy trap).
 *     `addVtep`/`removeVtep` keep upstream's **truth test** on the scope argument (`if not vlan`,
 *     `:1030`/`:1052`) as an explicit table: `undefined`, `''` and the number `0` take the bare
 *     flood-list arm while the **string `'0'`** composes `vxlan vlan 0 flood vtep …` — four pins, because
 *     "fixing" the falsy number silently changes which command pyeapi-equivalent callers get.
 * 25. **no Vxlan presence verbs — because upstream has none either.** `VxlanInterface` overrides `get`
 *     and the writers only; `create`/`delete`/`default` are inherited unchanged from `BaseInterface`
 *     (`:211-254`, reached through the `Vx` row of `INTERFACE_CLASS_MAP`, `:1096`), so pyeapi composes
 *     `interface Vxlan1` / `no interface Vxlan1` / `default interface Vxlan1` for it exactly as for a
 *     Vlan or Loopback — its suite pins none of them for VXLAN specifically. This client's
 *     {@link assertPresentName} family already accepts every plain `Vxlan<n>`, and the spec already
 *     pins `Vxlan5`/`Vxlan9` inside the create/delete loops from M10a; the refusal-vs-port convention
 *     records that this is a **nothing-to-do** case rather than inventing a Vxlan-only presence verb.
 */
import { ConfigParseError, NotSupportedError, ProtocolError } from '../errors'
import { pythonRepr } from '../internal/wire'
import { parseBlock } from '../config/text'
import { valueAfterKeyword } from './config-block'
import { EntityCollection } from './base'
import { submodeCommands } from './command-builder'
import { assertInterfaceName, assertVlanId, parseInterfaceName } from './validators'
import { tryVariants } from '../internal/variants'
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
   * (`get` at `:583-616` plus the three `_parse_*` readers at `:618-638`, absent-instead-of-defaulted — DR-076). Attached only on a `Port-Channel`-kind section
   * carrying at least one such fact.
   */
  readonly portChannel?: InterfacePortChannelFields
  /**
   * The `VxlanInterface` field group (M10d #52): what pyeapi's own `VxlanInterface.get` adds on top of
   * the base record (`interfaces.py:853-858`, six `_parse_*` readers at `:862-919`) — source-interface,
   * multicast-group (the legacy spelling; the decap sub-form is its own boolean field), multicast
   * decap, udp-port, the vlan→vni/flood map, and the global flood list. Attached only on a
   * `Vxlan`-kind section carrying at least one of those lines (DR-068), with upstream's `''` / `{}` /
   * `[]` / missing-udp-port-crash answers replaced by absence (**divergence 21**) and its distinctive
   * reader regexes ported quirk-for-quirk (**divergence 22**). Reading a `Vxlan1` section is no claim
   * that the 7050TX-64 supports VXLAN at all — hardware support is UNVERIFIED and capability presence
   * is a probe question (DR-033).
   */
  readonly vxlan?: InterfaceVxlanFields
  /** The matching `show interfaces status` row, when it was read (divergence 8). */
  readonly status?: InterfaceStatus
}

/** The VXLAN fields of a Vxlan-kind section (M10d). */
export interface InterfaceVxlanFields {
  /**
   * The `vxlan source-interface <name>` value — absent, never upstream's `DEFAULT_SRC_INTF = ''`
   * (`interfaces.py:816`, applied at `:877`) which collapses "not configured" with "the empty string"
   * (divergence 21). The name is what the section writes; no {@link Interface}-kind relation is imposed
   * on it (a `Loopback0` source is an interface of another kind, and whether the device validates the
   * reference is a device answer).
   */
  readonly sourceInterface?: string
  /**
   * The legacy `vxlan multicast-group <group>` value, read through upstream's verbatim pattern
   * (`:881-882`) — including its leading-octet-exactly-three-digits quirk (divergence 22). The
   * `vxlan multicast-group decap` line never answers here: upstream's regex cannot match it, and
   * {@link multicastDecap} is the field for that command.
   */
  readonly multicastGroup?: string
  /**
   * The `vxlan multicast-group decap` / `no vxlan multicast-group decap` command pair — the first exact
   * body line wins, and a section writing neither leaves the field **absent** rather than answering
   * upstream's `False` from an XOR of whole-block substring tests (`:887-889`, divergence 21).
   */
  readonly multicastDecap?: boolean
  /**
   * The `vxlan udp-port <n>` value as a number — absent when the line is missing, which upstream
   * cannot answer at all: `_parse_udp_port` `int()`s a `None` match and raises (`:894`, divergence 21).
   * A non-decimal or unrepresentable value is a {@link ConfigParseError}, not a truncation (DR-059).
   */
  readonly udpPort?: number
  /**
   * The vlan→VXLAN map, keyed by the decimal run exactly as the section spells it (`vxlan vlan <vid>`,
   * findall ported from `:902`), in **first-appearance order** — replacing the arbitrary per-run order
   * of upstream's `frozenset` round-trip (`:901-902`, divergence 22). A vid found with no `vni` line
   * carries no {@link InterfaceVxlanVlan.vni} (upstream answers `None` at `:906`, DR-076's rule).
   */
  readonly vlans?: Readonly<Record<string, InterfaceVxlanVlan>>
  /**
   * The global `vxlan flood vtep <list>` entries, split on single spaces exactly as upstream does
   * (`match.group(1).split(' ')`, `:918`) under that line's digits-and-dots-only character class
   * (`:915`) — a line the class cannot match reports the field **absent** rather than upstream's
   * empty-list `[]` (divergence 21/22). Per-VLAN flood lists live on the {@link vlans} entries.
   */
  readonly floodList?: string[]
}

/** One `vxlan vlan <vid> …` entry of {@link InterfaceVxlanFields.vlans} (pyeapi's per-vid dict, `:903-911`). */
export interface InterfaceVxlanVlan {
  /**
   * The `vxlan vlan <vid> vni <n>` value as a number — absent when the vid was found (divergence 22's
   * findall sees it in ANY `vxlan vlan <vid>` line, including a `no …` one) but no `vni` line exists.
   * Upstream stores the regex group — a **string** — at `:906`; converting here is the same call
   * {@link numberFieldFromBlock} already makes for `mtu`/`min-links` (DR-059), not a platform claim.
   */
  readonly vni?: number
  /**
   * The per-VLAN flood list from the first `vxlan vlan <vid> flood vtep …` line (`:907-910`), space-split
   * as upstream splits it. An empty array here is ordinary — the vid exists in the section, it just
   * names no VTEPs — where an ABSENT global {@link InterfaceVxlanFields.floodList} means no such line
   * at all (divergence 21).
   */
  readonly floodList: readonly string[]
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
  /**
   * The mode word of the first member line's `channel-group <id> mode <word>`, one of
   * {@link LACP_MODES} — a device line naming anything else is reported by
   * {@link readChannelGroupMode} rather than published as a mode this client cannot write.
   */
  readonly lacpMode?: LacpMode
  /** The `port-channel min-links <n>` line — absent, not `0`, when the section writes no value (DR-076). */
  readonly minimumLinks?: number
  /** The `port-channel lacp fallback <word>` line — absent, not `'disabled'`, for the `no …` form (DR-076). */
  readonly lacpFallback?: string
  /** The `port-channel lacp fallback timeout <n>` line — absent, not `90`, when missing (DR-076). */
  readonly lacpTimeout?: number
}

/** Which flow-control direction a write names — pyeapi's pair, validated at `interfaces.py:517-518`. */
export const FLOWCONTROL_DIRECTIONS: readonly string[] = ['send', 'receive']
/** The flow-control values pyeapi accepts before composing (`interfaces.py:514-516`). */
export const FLOWCONTROL_VALUES: readonly string[] = ['on', 'off']
export type FlowcontrolDirection = 'send' | 'receive'
export type FlowcontrolValue = 'on' | 'off'
/** The `channel-group … mode` values pyeapi accepts (`interfaces.py:731` — the only mode check in the class; `set_members` composes whatever it is handed, `:712-714`, so an unlisted mode reaches the wire there). Also the three values its `set_members`/`set_lacp_mode` docstrings list (`:688`, `:726`). */
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

/** The channel-group relation that stitches members to their group (`interface Ethernet5` writing `channel-group 1 mode on`, `running_config.portchannel:147`; `:278` is `Ethernet6`'s copy). The id and mode runs are captured; anything further on the line is kept out of the mode word. */
const CHANNEL_GROUP_LINE = /^channel-group[ \t]+([0-9]+)(?:[ \t]+mode[ \t]+(\S+?))?(?:[ \t]+\S+)*[ \t]*$/u

/**
 * The mode token of a `channel-group <id> mode <word>` line, validated against {@link LACP_MODES}.
 *
 * Upstream reads this token **unvalidated and verbatim**: `get_lacp_mode`'s
 * `re.search(r'channel-group\s\d+\smode\s(?P<value>.+)', …)` hands back whatever follows `mode `
 * (`interfaces.py:656-658`), and `set_members` interpolates the mode it was handed straight into
 * `channel-group %s mode %s` without a check (`:712-714`). This client reads the token as one of the
 * three modes the LACP verbs accept and **reports the line when it is not one of them** — the
 * {@link numberFieldFromBlock} rule (rows 43/44, restated for this module by DR-059): a table that
 * silently carried `mode fast` would show the operator a value its own write verbs refuse.
 * Refusing the *input* side is {@link assertLacpMode}; this is the read side, so the failure is a
 * {@link ConfigParseError} naming the section, not a caller-facing refusal.
 */
function readChannelGroupMode(token: string | undefined, sectionKey: string): LacpMode | undefined {
  if (token === undefined) return undefined
  if ((LACP_MODES as readonly string[]).includes(token)) return token as LacpMode
  throw new ConfigParseError(
    `interfaces: cannot read the channel-group mode in ${pythonRepr(sectionKey)} — ${pythonRepr(token)} is not one of ${LACP_MODES.join(' / ')}. pyeapi answers the raw word back without checking it (api/interfaces.py:656-658) and set_members writes an unvalidated mode to the wire (:712-714); this client reports the line instead of publishing a mode its own LACP verbs refuse (DR-059)`,
    { sectionKey },
  )
}

/** Keywords the PortchannelInterface fields are read behind. */
const MIN_LINKS_KEYWORD = 'port-channel min-links'
const LACP_FALLBACK_KEYWORD = 'port-channel lacp fallback'
const LACP_TIMEOUT_KEYWORD = 'port-channel lacp fallback timeout'

/** The group id pyeapi extracts from a Port-Channel name for its command texts — the first decimal run (`re.search(r'(\d+)', name).group()`, `interfaces.py:671` in `get_members`, `:699` in `set_members`, `:734` in `set_lacp_mode`; it `.group()`s on `None` and crashes for a name with no digits). */
const GROUP_ID = /([0-9]+)/u

/** The release floor at which pyeapi's `set_vrf` switches from `vrf forwarding` to the bare `vrf` keyword (`interfaces.py:550-576`, the compare itself at `:568` — a **string** compare against `'4.23'`, which divergence 18 replaces with a numeric one). */
const VRF_BARE_FORM_MIN: readonly [number, number] = [4, 23]

/** The command keywords the VxlanInterface fields are read behind and the decap command pair (`interfaces.py:862-919` reads; the same texts are what `:939`/`:963-965`/`:985` compose — upstream spells the enable arm of `set_multicast_decap` as the bare string, `:990`). */
const VXLAN_SOURCE_KEYWORD = 'vxlan source-interface'
const VXLAN_MULTICAST_GROUP_KEYWORD = 'vxlan multicast-group'
const VXLAN_MULTICAST_DECAP_COMMAND = 'vxlan multicast-group decap'
const VXLAN_MULTICAST_DECAP_NO_COMMAND = 'no vxlan multicast-group decap'
const VXLAN_UDP_PORT_KEYWORD = 'vxlan udp-port'

/**
 * The multicast-group read, **verbatim from upstream** (`:881-882`, re-assembled from the two adjacent
 * string literals): the leading octet gets exactly three digits (`[\d]{3}`) while the other three get
 * `[\d]+`. Every multicast range EOS uses sits in `224-239` — three digits — which is presumably why
 * upstream never noticed; a group spelling with a 1- or 2-digit leading octet reads back absent, and
 * that quirk is pinned rather than smoothed (`interfaces.test.ts`, divergence 22). Applied per body
 * line and unanchored, matching `re.search`'s earliest-position first answer.
 */
const VXLAN_MCAST_GROUP_READ = /vxlan multicast-group ([0-9]{3}\.[0-9]+\.[0-9]+\.[0-9]+)/u

/** The same shape anchored, for the write guard: refuse what this reader would drop (divergence 24). */
const VXLAN_MCAST_GROUP_SHAPE = /^[0-9]{3}\.[0-9]+\.[0-9]+\.[0-9]+$/u

/** The per-VLAN id scan — upstream's unanchored findall (`:902`), which also counts `no vxlan vlan <vid> …` lines. */
const VXLAN_VLAN_ID_READ = /vxlan vlan ([0-9]+)/gu

/**
 * The global flood-list line, verbatim (`:915`). The `^ *` prefix is upstream allowing for the block's
 * indent — dedented body lines simply match it empty — and the `[\d. ]` class is the whole vocabulary:
 * any other VTEP spelling makes the line unread and the field absent (divergence 22).
 */
const VXLAN_FLOOD_READ = /^ *vxlan flood vtep +([\d. ]+)$/u

/** A dotted-quad VTEP token: the write-side shape of {@link VXLAN_FLOOD_READ}'s class (pyeapi validates nothing, `:1031-1034`/`:1053-1056`). */
const VXLAN_VTEP_SHAPE = /^([0-9]{1,3}\.){3}[0-9]{1,3}$/u

/** A decimal VLAN/VNI token — the write side of the `vni (\d+)` read (`:905`) and the scope argument interpolated at `:1033`/`:1055`. */
const DECIMAL_TOKEN = /^[0-9]+$/u

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
    'expected a plain `PortChannel<n>` name whose digits carry the channel-group id — members/min-links/LACP are pyeapi PortchannelInterface methods (api/interfaces.py:578-813) reached only through the `PortChannel` prefix of its class map (:120-127, :1093-1097), and its group extraction re.search(r"(\\d+)", name).group() crashes outright on a digit-less name (:671, :699, :734); dotted Port-Channel names stay refused for want of device evidence (DECISIONS.md open item 7)',
  )
}

/**
 * Require a name the **VxlanInterface** verbs may compose (`interfaces.py:814-1090`): the same
 * prefix-dispatch argument as {@link assertEthernetName} — the facade reaches this class only through
 * the `Vx` row of `INTERFACE_CLASS_MAP` (`:120-127`, `:1093-1097`) — with no digit-dependency reason on
 * top: unlike the Port-Channel commands, none of the VXLAN texts extract an id from the name; the index
 * in `Vxlan<n>` only picks which Vxlan interface the `interface` header enters. Whether the
 * 7050TX-64 carries VXLAN interfaces at all is **unverified** (probe question, DR-033) — this guard
 * models the surface, not the platform.
 */
function assertVxlanName(verb: string, value: unknown): asserts value is string {
  const parsed = parseInterfaceName(value)
  if (parsed !== undefined && parsed.kind === 'Vxlan' && parsed.subinterface === undefined) return
  refuse(
    `${verb} interface`,
    value,
    'expected a plain `Vxlan<n>` name — the VXLAN fields and verbs are pyeapi VxlanInterface methods (api/interfaces.py:814-1090) reached only through the `Vx` prefix of its class map (:120-127, :1093-1097); no other kind carries a `vxlan …` sub-mode upstream, and dotted Vxlan names stay refused for want of device evidence (DECISIONS.md open item 7)',
  )
}

/** Require one of pyeapi's two flowcontrol directions (its `ValueError`, `interfaces.py:517-518`, becomes a typed refusal — divergence 17 / DR-077). */
function assertFlowcontrolDirection(value: unknown): asserts value is FlowcontrolDirection {
  if ((FLOWCONTROL_DIRECTIONS as readonly unknown[]).includes(value)) return
  refuse('flowcontrol direction', value, `expected one of ${FLOWCONTROL_DIRECTIONS.join(' / ')} — pyeapi raises ValueError for anything else (api/interfaces.py:517-518; pinned negative by test/unit/test_api_interfaces.py:234-238)`)
}

/** Require one of pyeapi's two flowcontrol values (its `ValueError`, `interfaces.py:513-515`; tests `:239-243`). */
function assertFlowcontrolValue(value: unknown): asserts value is FlowcontrolValue {
  if ((FLOWCONTROL_VALUES as readonly unknown[]).includes(value)) return
  refuse('flowcontrol value', value, `expected one of ${FLOWCONTROL_VALUES.join(' / ')} — pyeapi raises ValueError for anything else (api/interfaces.py:513-515; pinned negative by test/unit/test_api_interfaces.py:239-243)`)
}

/**
 * Require a VRF name this client can read back: a single non-empty token, no surrounding
 * whitespace and no control character.
 *
 * Upstream interpolates whatever it is handed (`interfaces.py:569`/`:573` and `abstract.py:158-159`),
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
  refuse('lacp mode', value, `expected one of ${LACP_MODES.join(' / ')} — pyeapi answers an invalid mode by RETURNING False in set_lacp_mode (api/interfaces.py:731-732, pinned non-raising at test/unit/test_api_interfaces.py:424-427) and does not check one at all in set_members, where an unknown mode reaches the wire as \`channel-group 1 mode <junk>\` (:712-714). Neither answer is usable from TS (DR-005/DR-077): the typed refusal is the third, and it is also the one that keeps a typo out of a LAG`)
}

/** Require a fallback mode that carries a value; the `disabled` intent is the named-verb treatment of pyeapi's `disable` arm (DR-037/DR-077). */
function assertLacpFallbackMode(value: unknown): asserts value is LacpFallbackMode {
  if (value === 'disabled') refuse('lacp fallback mode', value, "the 'disabled' arm composes `no port-channel lacp fallback` (pyeapi maps mode=='disabled' to disable=True at api/interfaces.py:789, composed at :790-792 and pinned by test/unit/test_api_interfaces.py:366-369) — that intent is the verb unsetLacpFallback() here, because the mode strings and the negation are separate questions (DR-037)")
  if ((LACP_FALLBACK_MODES as readonly unknown[]).includes(value)) return
  refuse('lacp fallback mode', value, `expected one of ${LACP_FALLBACK_MODES.join(' / ')} (or unsetLacpFallback() for the \`no\` form) — pyeapi answers any other mode by RETURNING False, with no exception and nothing to inspect (api/interfaces.py:787-788, pinned by the suite's invalid-mode test at test/unit/test_api_interfaces.py:371-374)`)
}

/** Require the positive-integer value a min-links / fallback-timeout write composes. **Client policy** — the platform bound is a device answer (DR-032/DR-057), upstream validates nothing, and `0` is DR-037's falsy trap. */
function assertPortBandValue(value: unknown, label: string): asserts value is number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return
  refuse(label, value, `expected a positive integer — pyeapi interpolates whatever arrives (api/interfaces.py:747-769 min-links / :795-811 lacp timeout have no bound at all), and the DEVICE answers 1002/1003 for a value it genuinely refuses (DR-005). 0 would compose a \`no\` line through pyeapi's falsy fall-through at abstract.py:158-161, which is exactly the surprise DR-037 deletes`)
}

/**
 * Require a source-interface argument the read side can reproduce: the token behind
 * `vxlan source-interface` (upstream's own reader pattern is `([^\s]+)`, `interfaces.py:876`).
 * Upstream validates nothing (`:921-940` interpolates it through `command_builder`); the refusal is
 * reader-derived, and which interface names the device accepts — including whether the referenced
 * interface must exist — is a device answer (the `CommandError` path stays pinned, DR-005).
 */
function assertSourceInterfaceValue(value: unknown): asserts value is string {
  if (typeof value !== 'string') refuse('vxlan source-interface', value, 'expected a string interface name — pyeapi checks nothing (api/interfaces.py:921-940)')
  if (value.trim() === '') refuse('vxlan source-interface', value, 'an empty source-interface is refused — clear the binding with unsetSourceInterface() (the `disable=True` arm composes `no vxlan source-interface`, api/interfaces.py:939-940 pinned at test/unit/test_api_interfaces.py:448-452) rather than an empty value (DR-037)')
  if (/\s/u.test(value)) refuse('vxlan source-interface', value, 'a source-interface must be a single token: the value is read back as one token behind the keyword (`([^\\s]+)`, api/interfaces.py:876), and the device takes one argument here')
  if (CONTROL_CHARACTER.test(value)) refuse('vxlan source-interface', value, 'a control character would break the config line this client reads back (the same rule as row 74 and the VRF/description guards)')
}

/**
 * Require a multicast group in the shape this module can read: `NNN.N.N.N` — the leading octet with
 * **exactly three digits**, because that is upstream's own read pattern verbatim
 * (`([\\d]{3}\\.[\\d]+\\.[\\d]+\\.[\\d]+)`, `interfaces.py:881-882`) and composing anything else writes a
 * line that neither pyeapi nor this client would ever read back (divergence 22/24). The multicast range
 * EOS uses for VXLAN is three digits, `239.10.10.10` being the shape upstream's fixture writes
 * (`running_config.vxlan:39`); whether the device (or a future EOS) accepts another spelling — including
 * IPv6 groups — is an unverified device question (DR-032/DR-057), and `decap` is the sub-form of this
 * keyword, served by {@link setMulticastDecap}, never a group value.
 */
function assertMulticastGroupValue(value: unknown): asserts value is string {
  if (typeof value === 'string' && VXLAN_MCAST_GROUP_SHAPE.test(value)) return
  refuse('vxlan multicast-group', value, 'expected a dotted-quad with a THREE-digit leading octet, the exact shape the reader keeps from pyeapi (api/interfaces.py:881-882) — anything else composes a line neither this client nor pyeapi can read back (divergence 22). The device keeps authority over groups it truly accepts (DR-005), and IPv6 groups are unverified hardware territory (DR-032)')
}

/**
 * Require a VTEP address in the only shape the flood-list reader can see: dotted-quad digits and dots,
 * because upstream's whole vocabulary for a flood entry is the character class `([\\d. ]+)`
 * (`interfaces.py:915`) — an entry in any other spelling vanishes from `show`-free config reads for
 * pyeapi too. Upstream validates nothing on either verb (`:1031-1034`/`:1053-1056` interpolate raw). An
 * IPv6 VTEP would be readable by EOS and unread here: that is a device question (DR-032), and the
 * refusal says so rather than claiming it cannot exist.
 */
function assertVtepValue(value: unknown): asserts value is string {
  if (typeof value === 'string' && VXLAN_VTEP_SHAPE.test(value)) return
  refuse('vxlan vtep', value, 'expected a dotted-quad VTEP address — pyeapi validates nothing and interpolates the raw string (api/interfaces.py:1031-1034 add / :1053-1056 remove), but this module can only read flood entries made of digits and dots (`[\\d. ]+`, :915), so anything else composes an entry that never reads back (divergence 22/24). Whether 4.28.13.1M also floods to IPv6 VTEPs is a capture, not a claim')
}

/**
 * Resolve the optional VLAN scope of {@link addVtep}/{@link removeVtep} — upstream's truth test on
 * `vlan` (`if not vlan:`, `:1030`/`:1052`) as an explicit table: `undefined`, `''` and the number `0`
 * all take the **bare** `vxlan flood vtep …` arm, while the string `'0'` is truthy in Python and
 * composes `vxlan vlan 0 …` (pinned both ways, divergence 24). A kept scope must be decimal — the
 * reader's own token (`vxlan vlan (\\d+)`, `:902`) — and nothing here claims the vlan exists or licenses
 * VXLAN: the device answers that (`CommandError` pinned, DR-005).
 */
function assertVlanScopeToken(vlan: string | number | undefined): string | undefined {
  if (vlan === undefined || vlan === '' || vlan === 0) return undefined
  const token = typeof vlan === 'number' ? (Number.isSafeInteger(vlan) ? String(vlan) : '') : vlan
  if (DECIMAL_TOKEN.test(token)) return token
  refuse('vxlan vlan scope', vlan, `expected a decimal VLAN token (the scope is read back as vxlan vlan (\\d+), api/interfaces.py:902) or the bare-list arm via pyeapi's own falsy spellings \`None\`/\`''\`/\`0\` (:1030, :1052) — an unsafe integer, a fraction or a non-decimal string composes \`vxlan vlan …\` text this client cannot read, which pyeapi would happily send`)
}

/**
 * Require a VNI value: positive decimal safe integer — **client policy only**. Upstream interpolates
 * whatever arrives into `vxlan vlan add %s vni %s` (`:1072`) and its reader keeps `vni (\\d+)`
 * (`:905`); the platform's actual VNI ceiling (if any, licence-permitting) is a device answer
 * (DR-032/DR-057) and `0` is DR-037's falsy trap.
 */
function assertVniValue(value: unknown): asserts value is number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return
  refuse('vni value', value, 'expected a positive integer VNI — pyeapi validates nothing (api/interfaces.py:1058-1073 interpolates vid and vni raw), and this client must at least compose a line its own reader can parse (`vni (\\d+)`, :905). The platform VNI range is a device answer (DR-032/DR-057), not a constant in this file')
}

/**
 * Require a udp-port value: **client policy only**, exactly the {@link assertPortBandValue} reasoning
 * restated for this verb — pyeapi validates nothing (`:994-1011`), and the reader is
 * `vxlan udp-port (\\d+)` + an unguarded `int()` (`:893-894`), so anything non-decimal composes an
 * unreadable line while the platform's port-range/licensing answer stays the device's (DR-032).
 */
function assertUdpPortValue(value: unknown): asserts value is number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return
  refuse('vxlan udp-port value', value, `expected a positive integer port — pyeapi's set_udp_port has no bound at all (api/interfaces.py:994-1011) and a non-decimal value composes a line the reader pattern (vxlan udp-port (\\d+), :893) drops. The device answers 1002/1003 for a port it refuses (DR-005); 0 is DR-037's falsy trap`)
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
 * `value = 'no sflow' not in config` (`interfaces.py:367-379`, the assignment at `:378`): an interface whose block
 * carries **no sflow line at all** reads back ENABLED, and any block containing those six characters anywhere —
 * a description, a nested line, `no sflow something-else` — reads back disabled. Absence is not a state
 * (DR-029/DR-057), so the fabricated `true` is not ported. The pinned suite's `test_get` (`:183-189`) does not
 * demonstrate that fabrication: its fixture section carries `sflow enable` at `running_config.text:652`, so
 * there the answer came from a real line. `interfaces.test.ts` pins the fabricated arm against its own config.
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
  readonly lacpMode: LacpMode | undefined
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

/** The first body line matching `pattern`, capped group 1 — the per-line twin of upstream's `re.search` over the raw block, first match in block order (divergence 22: same answer per pattern, but no match can span a line boundary). `vid` interpolations are always decimal, so the built patterns cannot misfire. */
function firstGroupOf(lines: readonly ConfigLine[], pattern: RegExp): string | undefined {
  for (const line of lines) {
    const match = pattern.exec(line.text)
    if (match !== null) return match[1]
  }
  return undefined
}

/**
 * The multicast-group value: upstream's verbatim read pattern (`:881-882`, including the
 * exactly-three-digit leading octet — divergence 22) applied per body line, first match wins, and
 * `DEFAULT_MCAST_GRP = ''` for absence **not** ported (divergence 21). The `vxlan multicast-group
 * decap` lines can never answer here — the pattern needs a digit after the keyword — which is the same
 * discrimination upstream's regex performs, just pinned here.
 */
function multicastGroupFromBlock(lines: readonly ConfigLine[]): string | undefined {
  return firstGroupOf(lines, VXLAN_MCAST_GROUP_READ)
}

/**
 * The multicast-decap state from the two whole command lines, first in device order winning — the
 * {@link sflowFromBlock} rule, not upstream's substring XOR (`val1 ^ val2` over the raw block,
 * `:887-889`). That XOR reads the fixture's `no vxlan multicast-group decap`
 * (`test/fixtures/running_config.vxlan:49`) as `False` only because the negation line also *contains*
 * the positive substring (both sides true → `False`); it would read `True` for a description that
 * merely carries those characters, and `False` for a section that configures neither — absence dressed
 * as a state (DR-029/DR-057, divergence 21).
 */
function multicastDecapFromBlock(block: ConfigBlock): boolean | undefined {
  for (const line of block.body) {
    if (line.text === VXLAN_MULTICAST_DECAP_NO_COMMAND) return false
    if (line.text === VXLAN_MULTICAST_DECAP_COMMAND) return true
  }
  return undefined
}

/**
 * The vlan→VXLAN map from the unanchored `vxlan vlan (\\d+)` findall ported verbatim (`:902`) — so a vid
 * named by ANY such line, including the fixture's `no vxlan vlan 10 …`-shaped neighbours, gets a
 * profile. Key order is **first appearance in the section**: upstream iterates a `frozenset`
 * (`:901`, `:903`) whose order is arbitrary per run, and an arbitrary order in a reviewable table is a
 * diff-hazard (divergence 22). Per vid, `vni` keeps upstream's unanchored first-match read
 * (`:905`) converted with {@link numberFieldFromBlock}'s rule (upstream stores the string group, `:906`
 * — divergence 21), and the per-VLAN flood list space-splits the first
 * `vxlan vlan <vid> flood vtep …` line exactly as `:909-910` does — `[]` when the vid exists but names
 * no VTEPs, which is a true statement about that entry (contrast the ABSENT global field, divergence
 * 21). A vid of `0` is kept as written: upstream's findall has no range check, and normalising it would
 * be an invented device rule.
 */
function vlanMappingsFromBlock(lines: readonly ConfigLine[], sectionKey: string): Record<string, InterfaceVxlanVlan> | undefined {
  const vids: string[] = []
  for (const line of lines) {
    for (const match of line.text.matchAll(VXLAN_VLAN_ID_READ)) {
      const vid = match[1]
      // The group is mandatory in the pattern, but `noUncheckedIndexedAccess` types it optional and a
      // `vid: undefined` key would be a silent data loss — same binding discipline as CHANNEL_GROUP_LINE.
      if (vid !== undefined && !vids.includes(vid)) vids.push(vid)
    }
  }
  if (vids.length === 0) return undefined
  const vlans: Record<string, InterfaceVxlanVlan> = {}
  for (const vid of vids) {
    const vni = numberFieldFromBlock(firstGroupOf(lines, new RegExp(`vxlan vlan ${vid} vni ([0-9]+)`, 'u')), `vxlan vlan ${vid} vni`, sectionKey)
    const flood = firstGroupOf(lines, new RegExp(`vxlan vlan ${vid} flood vtep (.*)$`, 'u'))
    vlans[vid] = {
      ...(vni === undefined ? {} : { vni }),
      floodList: flood === undefined ? [] : flood.split(' '),
    }
  }
  return vlans
}

/**
 * The global flood list: upstream's verbatim line pattern (`:915`), first match, space-split as `:918`
 * splits it. A VTEP list outside the `([\\d. ]+)` class makes the pattern refuse the whole line —
 * upstream then answers its `values = list()` `[]` default (`:916-919`); here the field reports
 * **absent** instead, because "the device wrote a line this reader cannot parse" is a different
 * statement from "the flood list is empty" (divergence 21/22, DR-029).
 */
function floodListFromBlock(lines: readonly ConfigLine[]): string[] | undefined {
  const found = firstGroupOf(lines, VXLAN_FLOOD_READ)
  return found === undefined ? undefined : found.split(' ')
}

/**
 * The Vxlan-kind field group, or `undefined` when the section names none of it (DR-068 — the same
 * one-object-per-kind shape as {@link ethernetFieldsFromBlock}). Upstream reaches these six reads from
 * its **own** `VxlanInterface.get` (`:822-858`: its own `get_block` at `:846`, then `super()` for the
 * shared header fields at `:850`, then the six merges at `:853-858`) — here the shared fields already
 * come from {@link interfaceFromSection} and only the six kind-specific reads are added, which is the
 * DR-068 pattern M10b/M10c established. Its forced `type='vxlan'` label (`:851`) is divergence 2's
 * `kind`, already on the record.
 */
function vxlanFieldsFromBlock(block: ConfigBlock, sectionKey: string): InterfaceVxlanFields | undefined {
  const sourceInterface = valueAfterKeyword(block.body, VXLAN_SOURCE_KEYWORD)
  const multicastGroup = multicastGroupFromBlock(block.body)
  const multicastDecap = multicastDecapFromBlock(block)
  const udpPort = numberFieldFromBlock(valueAfterKeyword(block.body, VXLAN_UDP_PORT_KEYWORD), VXLAN_UDP_PORT_KEYWORD, sectionKey)
  const vlans = vlanMappingsFromBlock(block.body, sectionKey)
  const floodList = floodListFromBlock(block.body)
  if (sourceInterface === undefined && multicastGroup === undefined && multicastDecap === undefined && udpPort === undefined && vlans === undefined && floodList === undefined) return undefined
  return {
    ...(sourceInterface === undefined ? {} : { sourceInterface }),
    ...(multicastGroup === undefined ? {} : { multicastGroup }),
    ...(multicastDecap === undefined ? {} : { multicastDecap }),
    ...(udpPort === undefined ? {} : { udpPort }),
    ...(vlans === undefined ? {} : { vlans }),
    ...(floodList === undefined ? {} : { floodList }),
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
  const vxlan = parsed?.kind === 'Vxlan' ? vxlanFieldsFromBlock(block, sectionKey) : undefined
  return {
    name,
    kind: parsed?.kind ?? null,
    ...(shutdown === undefined ? {} : { shutdown }),
    ...(description === undefined ? {} : { description }),
    ...(mtu === undefined ? {} : { mtu }),
    ...(encapsulation === undefined ? {} : { encapsulation }),
    ...(ethernet === undefined ? {} : { ethernet }),
    ...(portChannel === undefined ? {} : { portChannel }),
    ...(vxlan === undefined ? {} : { vxlan }),
  }
}

/**
 * Every interface in a chunked running-config — **one** config read (DR-030/DR-055), two in-memory
 * passes over the sections: the first parses each block once and harvests every Ethernet section's
 * `channel-group <id> mode <m>` line into the group facts, the second builds the records (per-kind
 * groups arrive with M10b/M10c/M10d — DR-068) and attaches those facts to the matching Port-Channel
 * section. Members land in running-config order, and the group id is the raw decimal run as written,
 * because that is the token every channel-group command uses (`interfaces.py:671`/`:699`/`:734` extract it
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
  const groups = new Map<string, { members: string[]; firstMode?: LacpMode }>()
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
      // The id group is the key of the fact record, so it has to be bound and checked: `exec` types every
      // capture `string | undefined` under `noUncheckedIndexedAccess` even when the regex makes the group
      // mandatory, and `groups.get(undefined)` would silently key a member under a group no name has.
      const gid = relation[1]
      if (gid === undefined) continue
      const facts = groups.get(gid) ?? { members: [] }
      if (!facts.members.includes(name)) facts.members.push(name)
      // Assign only a real mode: `exactOptionalPropertyTypes` makes `firstMode?: LacpMode` mean
      // "absent or a mode", never "present and undefined", and the first mode-bearing line wins.
      const mode = readChannelGroupMode(relation[2], sectionKey)
      if (facts.firstMode === undefined && mode !== undefined) facts.firstMode = mode
      groups.set(gid, facts)
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
   * `sflow enable` — pyeapi's `set_sflow(name, True)` (`interfaces.py:526-548`, the guard refusing any
   * non-boolean at `:542-543` and the compose at `:545-547`);
   * `test/unit/test_api_interfaces.py:269-278` pins `interface Ethernet1` / `interface Ethernet1/1` +
   * `sflow enable` for the truthy arm.
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
   * `test/unit/test_api_interfaces.py:269-278` (`interfaces.py:542-543` is the only guard on this verb,
   * and it is a **bare** `raise ValueError` with no message; the three arms all compose at `:545-547`).
   * DR-037 keeps one name per intent: this verb is that text, whatever keyword produced it upstream.
   */
  async unsetSflow(name: string): Promise<void> {
    assertEthernetName('unsetSflow', name)
    await this.configureInterface(name, [this.commandBuilder(SFLOW_ON_COMMAND, { mode: 'no' })])
  }

  /** `default sflow enable` — pyeapi's `set_sflow(name, default=True)` (`:545-547` passes `default=default` to `command_builder`; tests `:286-290` pin the text, over the module-level six-kind list). */
  async defaultSflow(name: string): Promise<void> {
    assertEthernetName('defaultSflow', name)
    await this.configureInterface(name, [this.commandBuilder(SFLOW_ON_COMMAND, { mode: 'default' })])
  }

  /**
   * `flowcontrol <direction> <on|off>` — pyeapi's `set_flowcontrol(name, direction, value)`
   * (`interfaces.py:491-524`), whose two guards (`ValueError` for a bad value `:513-515` and for a bad
   * direction `:517-518`, pinned negative at `test_api_interfaces.py`'s
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
   * against the mock node's `'4.17.1.1'`, `test/lib/testlib.py:81` — same commands this verb emits under
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
   * `re.findall(r'\b(?!Peer)Ethernet[\d/]*\b', output)`. The look-around is **weaker than it reads**: it
   * only rejects a match position whose own text starts with `Peer`, and a hyphen is itself a word
   * boundary, so the hyphenated MLAG spelling is scraped as a member — the pinned clone answers
   * `['Ethernet1']` for `'  Peer-Ethernet1'` (probe, 2026-11-05; `interfaces.test.ts` pins it). The class
   * also keeps slot digits, so an `Ethernet1/1`-shaped token comes back verbatim — a name this client's
   * grammar refuses, which is why {@link setMembers} names members it will not compose. Whether either
   * shape appears in 4.28.13.1M's own answer is an M12 (#14) capture (DR-043).
   *
   * Upstream reads `config[0]['result']['output']` positionally off the `enable` answer
   * (`:673-675`) and raises `TypeError`/`IndexError` on a malformed reply; this verb goes through
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

  /** The one device read behind {@link getMembers} and the diff verbs — command literal ported from `interfaces.py:671-672`. */
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
  async getLacpMode(name: string): Promise<LacpMode | undefined> {
    assertPortChannelName('getLacpMode', name)
    const members = await this.getMembers(name)
    return this.lacpModeFromMembers(members)
  }

  /**
   * The shared search behind {@link getLacpMode} — also what {@link setMembers} uses, without paying for
   * the fetch twice. The token is validated by {@link readChannelGroupMode}, so the answer is one of
   * {@link LACP_MODES} or absent: the mode a UI shows and the mode {@link setLacpMode} writes are the same
   * type, which is what keeps a device-carried typo out of the next LAG rewrite.
   */
  private async lacpModeFromMembers(members: readonly string[]): Promise<LacpMode | undefined> {
    for (const member of members) {
      const parsed = parseInterfaceName(member)
      if (parsed === undefined) continue
      const blockKey = `interface ${parsed.name}`
      const block = await this.getBlock(blockKey)
      if (block === undefined) continue
      for (const line of parseBlock(block).body) {
        const relation = CHANNEL_GROUP_LINE.exec(line.text)
        if (relation === null) continue
        const mode = readChannelGroupMode(relation[2], blockKey)
        if (mode !== undefined) return mode
      }
    }
    return undefined
  }

  /**
   * Make exactly `members` the set: a remove/replace **diff**, not a blind rewrite — pyeapi's
   * `set_members` (`interfaces.py:677-717`) computes "the ones now that shouldn't be" as
   * `interface <m>` + `no channel-group <id>` pairs and "the ones that should be and aren't" as
   * `interface <m>` + `channel-group <id> mode <mode>` pairs, in ONE transaction, and sends **nothing**
   * when the two lists come out empty (the `if commands else True` line, `:716` — pinned by
   * `test_set_members_no_changes`, whose `cmds=None` assertion is "no config call happened at all",
   * `test_api_interfaces.py:411-414` against `test/lib/testlib.py:96-97`, which reads
   * `self.node.config.call_args` — the **last** config call only.
   *
   * Upstream's current-members source is the `show port-channel all-ports` scrape, so this verb asks
   * the device ({@link getMembers}) rather than trusting the local table — and its `mode` handling is
   * ported faithfully, including the side effect: when a `mode` is given and differs from the mode the
   * members currently carry, pyeapi first **rewrites every current member** (`self.set_lacp_mode`,
   * `:704`, a full remove-then-add batch of its own — note upstream passes the bare **group id** as
   * `set_lacp_mode`'s `name` argument, which only works because that verb re-extracts the digits) and then
   * composes the diff with the new mode — two config transactions (divergence 20, DR-080; upstream's own
   * `test_set_members_update_mode` test could only see the LAST `configure` call,
   * `test/lib/testlib.py:100-103`, so the first batch is easy to miss in a
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

    let effective: LacpMode | undefined = mode
    if (effective !== undefined) {
      const found = await this.lacpModeFromMembers(current)
      if (found !== undefined && found !== effective) {
        await this.rewriteMembers(current, grpid, effective) // pyeapi's set_lacp_mode side call, :702-704
      }
    } else {
      effective = await this.lacpModeFromMembers(current)
      if (effective === undefined && current.length > 0) {
        throw new NotSupportedError(
          `setMembers(PortChannel ${pythonRepr(name)}): no mode given and no current member names a channel-group mode to reuse — pyeapi would interpolate Python None and write \`channel-group ${grpid} mode None\` (api/interfaces.py:712-714 reached via get_lacp_mode's None answer, :639-658); name the mode instead (DR-077)`,
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
   * it fetches the live member list (`get_members`, called at `:739`) and composes ALL the `no channel-group`
   * removals before ALL the `channel-group <id> mode <new>` re-adds in one flat
   * `remove + add`-ordered transaction (`:740-743`, sent at `:745`), pinned by
   * `test_set_lacp_mode`'s eight-line expectation at `test/unit/test_api_interfaces.py:416-422`.
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
   * `port-channel min-links <n>` — pyeapi's `set_minimum_links(name, value)` (`interfaces.py:747-769`,
   * `test/unit/test_api_interfaces.py:305-428` pin the trio texts and `test_set_minimum_links_with_value`
   * a random 1..16). The positive-integer floor is this client's (see {@link assertPortBandValue}); the
   * platform bound stays the device's.
   */
  async setMinimumLinks(name: string, value: number): Promise<void> {
    assertPortChannelName('setMinimumLinks', name)
    assertPortBandValue(value, 'minimum links value') // pyeapi validates nothing on this verb — interfaces.py:747-769, pinned positive at test_api_interfaces.py:328-333 (min-links random 1..16)
    await this.configureInterface(name, [this.commandBuilder(MIN_LINKS_KEYWORD, { value })])
  }

  /** `no port-channel min-links` — pyeapi's no-value default arm and its `disable=True` arm, one text, one verb (`interfaces.py:765-768` + `abstract.py:154-161`; pinned at test_api_interfaces.py:335-338 and :345-348 — the fixture's own negation line, `running_config.portchannel:18`). */
  async unsetMinimumLinks(name: string): Promise<void> {
    assertPortChannelName('unsetMinimumLinks', name)
    await this.configureInterface(name, [this.commandBuilder(MIN_LINKS_KEYWORD, { mode: 'no' })])
  }

  /** `default port-channel min-links` — pyeapi's `default=True` arm (`:767` + `abstract.py:152-153`; pinned at `test_api_interfaces.py:340-343`). */
  async defaultMinimumLinks(name: string): Promise<void> {
    assertPortChannelName('defaultMinimumLinks', name)
    await this.configureInterface(name, [this.commandBuilder(MIN_LINKS_KEYWORD, { mode: 'default' })])
  }

  /**
   * `port-channel lacp fallback <individual|static>` — pyeapi's `set_lacp_fallback`
   * (`interfaces.py:771-793`, pinned at `test/unit/test_api_interfaces.py:356-359` / `:361-364` /
   * `:366-369` / `:371-373` — individual / static / disabled / invalid): the two value-carrying modes here, and the third — `'disabled'`, which
   * upstream turns into the `no` arm — is {@link unsetLacpFallback}, because a mode string and a
   * negation are different intents (DR-037/DR-077).
   */
  async setLacpFallback(name: string, mode: LacpFallbackMode): Promise<void> {
    assertPortChannelName('setLacpFallback', name)
    assertLacpFallbackMode(mode)
    await this.configureInterface(name, [this.commandBuilder(LACP_FALLBACK_KEYWORD, { value: mode })])
  }

  /** `no port-channel lacp fallback` — upstream's `mode='disabled'` arm (`interfaces.py:789-792`; pinned at `test/unit/test_api_interfaces.py:366-369`, and the config-side mirror is the fixture's line at `running_config.portchannel:19`). */
  async unsetLacpFallback(name: string): Promise<void> {
    assertPortChannelName('unsetLacpFallback', name)
    await this.configureInterface(name, [this.commandBuilder(LACP_FALLBACK_KEYWORD, { mode: 'no' })])
  }

  /**
   * `port-channel lacp fallback timeout <seconds>` — pyeapi's `set_lacp_timeout`
   * (`interfaces.py:795-811`; `test_set_lacp_timeout_with_value` at `test_api_interfaces.py:350-354` and
   * `test_get` at `:318-326` pair the write with the
   * fixture's `port-channel lacp fallback timeout 90`, `running_config.portchannel:20`). No value: the
   * guard, not upstream's fall-through to the **defaulted** reader answer — and the record never
   * reports `90` because that is a module constant, not the device's line (DR-076).
   */
  async setLacpTimeout(name: string, value: number): Promise<void> {
    assertPortChannelName('setLacpTimeout', name)
    assertPortBandValue(value, 'lacp fallback timeout') // pyeapi's only timeout test uses a random 1..16 — interfaces.py:795-811, no bound anywhere
    await this.configureInterface(name, [this.commandBuilder(LACP_TIMEOUT_KEYWORD, { value })])
  }

  // --- VxlanInterface verbs, M10d (#52): interfaces.py:921-1090 --------------------------------
  //
  // Platform honesty, stated once for the whole section: 7050TX-64 VXLAN **hardware support is
  // UNVERIFIED**. Every command text below is a pyeapi-faithful port — not a claim the SKU accepts
  // it; capability presence is a probe question (DR-033), the ledger round records it, and the
  // fixture configs quoted in `interfaces.test.ts` for this section are pyeapi's own test material,
  // never device captures.

  /**
   * `vxlan source-interface <value>` — pyeapi's `set_source_interface`
   * (`interfaces.py:921-941`: the keyword at `:936-938`, `command_builder` at `:939-940`,
   * `configure_interface` at `:941`); `test/unit/test_api_interfaces.py:443-447` pins the pair
   * `interface Vxlan1` / `vxlan source-interface Loopback0`.
   */
  async setSourceInterface(name: string, value: string): Promise<void> {
    assertVxlanName('setSourceInterface', name)
    assertSourceInterfaceValue(value)
    await this.configureInterface(name, [this.commandBuilder(VXLAN_SOURCE_KEYWORD, { value })])
  }

  /** `no vxlan source-interface` — pyeapi's `disable=True` arm (`:939-940` through `abstract.py:154-155`; test `:448-452`). */
  async unsetSourceInterface(name: string): Promise<void> {
    assertVxlanName('unsetSourceInterface', name)
    await this.configureInterface(name, [this.commandBuilder(VXLAN_SOURCE_KEYWORD, { mode: 'no' })])
  }

  /** `default vxlan source-interface` — pyeapi's `default=True` arm (`:939-940` through `abstract.py:152-153`; test `:453-457`). */
  async defaultSourceInterface(name: string): Promise<void> {
    assertVxlanName('defaultSourceInterface', name)
    await this.configureInterface(name, [this.commandBuilder(VXLAN_SOURCE_KEYWORD, { mode: 'default' })])
  }

  /**
   * Configure the multicast group — pyeapi's `set_multicast_group` (`interfaces.py:943-967`), and this
   * module's first **variant** verb: upstream composes both spellings and hands them to
   * `CliVariants(cmds_new, cmds_dpr)` at `:966-967`, i.e. the decap-integrated keyword
   * `vxlan multicast-group decap <value>` is attempted FIRST and the legacy
   * `vxlan multicast-group <value>` (which is what the upstream pin at `:458-462` shows) is the
   * fallback. {@link configureInterfaceVariants} keeps that order and the per-variant
   * `interface <name>` wrapper (`configure_interface` splices the marker INSIDE the submode list,
   * `abstract.py:176-177` + `client.py:646-652`). Upstream's suite cannot see the order —
   * `testlib.py:97-107` accepts any expanded variant — so the spec pins both transactions here
   * (divergence 23). Whether 4.28.13.1M carries the decap-integrated form at all is unverified
   * (DR-033); that is precisely why upstream keeps a fallback rather than a support claim.
   */
  async setMulticastGroup(name: string, value: string): Promise<void> {
    assertVxlanName('setMulticastGroup', name)
    assertMulticastGroupValue(value)
    await this.configureInterfaceVariants(name, [
      [this.commandBuilder(VXLAN_MULTICAST_DECAP_COMMAND, { value })],
      [this.commandBuilder(VXLAN_MULTICAST_GROUP_KEYWORD, { value })],
    ])
  }

  /** `no vxlan multicast-group decap` → fallback `no vxlan multicast-group` — pyeapi's `disable=True` arms of both spellings (`:961-967`; the pin at test `:463-467` shows the legacy arm of a variant pair its testlib accepted either way). */
  async unsetMulticastGroup(name: string): Promise<void> {
    assertVxlanName('unsetMulticastGroup', name)
    await this.configureInterfaceVariants(name, [
      [this.commandBuilder(VXLAN_MULTICAST_DECAP_COMMAND, { mode: 'no' })],
      [this.commandBuilder(VXLAN_MULTICAST_GROUP_KEYWORD, { mode: 'no' })],
    ])
  }

  /** `default vxlan multicast-group decap` → fallback `default vxlan multicast-group` — pyeapi's `default=True` arms (`:961-967`; pin at test `:468-472`). */
  async defaultMulticastGroup(name: string): Promise<void> {
    assertVxlanName('defaultMulticastGroup', name)
    await this.configureInterfaceVariants(name, [
      [this.commandBuilder(VXLAN_MULTICAST_DECAP_COMMAND, { mode: 'default' })],
      [this.commandBuilder(VXLAN_MULTICAST_GROUP_KEYWORD, { mode: 'default' })],
    ])
  }

  /**
   * The bare `vxlan multicast-group decap` command — pyeapi's `set_multicast_decap(name)` with neither
   * flag (`interfaces.py:969-991`, the `cmds = [string]` arm at `:990`); test `:473-477` pins it.
   * Upstream's docstring calls the argument a feature toggle but takes no value: the enable IS the bare
   * keyword, which is why {@link commandBuilder}'s `{ value: true }` row (DR-037's table) is the exact
   * twin.
   */
  async setMulticastDecap(name: string): Promise<void> {
    assertVxlanName('setMulticastDecap', name)
    await this.configureInterface(name, [this.commandBuilder(VXLAN_MULTICAST_DECAP_COMMAND, { value: true })])
  }

  /** `no vxlan multicast-group decap` — pyeapi's `disable=True` arm (`:986-988` compose through `command_builder(value=None, disable)`; test `:478-482`). */
  async unsetMulticastDecap(name: string): Promise<void> {
    assertVxlanName('unsetMulticastDecap', name)
    await this.configureInterface(name, [this.commandBuilder(VXLAN_MULTICAST_DECAP_COMMAND, { mode: 'no' })])
  }

  /** `default vxlan multicast-group decap` — pyeapi's `default=True` arm (`:986-988`; test `:483-487`). */
  async defaultMulticastDecap(name: string): Promise<void> {
    assertVxlanName('defaultMulticastDecap', name)
    await this.configureInterface(name, [this.commandBuilder(VXLAN_MULTICAST_DECAP_COMMAND, { mode: 'default' })])
  }

  /**
   * `vxlan udp-port <value>` — pyeapi's `set_udp_port` (`interfaces.py:994-1012`, keyword `:1009`,
   * compose `:1010-1011`); test `:488-492` pins `vxlan udp-port 1024`. Upstream accepts the string
   * `'1024'`; here the value is a number, with {@link assertUdpPortValue}'s client-policy floor —
   * the platform's own port rules being the device's (DR-032).
   */
  async setUdpPort(name: string, value: number): Promise<void> {
    assertVxlanName('setUdpPort', name)
    assertUdpPortValue(value)
    await this.configureInterface(name, [this.commandBuilder(VXLAN_UDP_PORT_KEYWORD, { value })])
  }

  /** `no vxlan udp-port` — pyeapi's `disable=True` arm (`:1010-1011`; test `:493-497`). */
  async unsetUdpPort(name: string): Promise<void> {
    assertVxlanName('unsetUdpPort', name)
    await this.configureInterface(name, [this.commandBuilder(VXLAN_UDP_PORT_KEYWORD, { mode: 'no' })])
  }

  /** `default vxlan udp-port` — pyeapi's `default=True` arm (`:1010-1011`; test `:498-502`). */
  async defaultUdpPort(name: string): Promise<void> {
    assertVxlanName('defaultUdpPort', name)
    await this.configureInterface(name, [this.commandBuilder(VXLAN_UDP_PORT_KEYWORD, { mode: 'default' })])
  }

  /**
   * Add a VTEP to the flood list — pyeapi's `add_vtep` (`interfaces.py:1014-1034`), whose `if not vlan`
   * truth test at `:1030` picks between the **bare** `vxlan flood vtep add <vtep>` (`:1031`, pinned at
   * test `:513-517`) and the **vlan-scoped** `vxlan vlan <vlan> flood vtep add <vtep>` (`:1033`, pinned
   * at `:518-522`). Both arms are separate command texts and both are pinned; the falsy spellings
   * (`undefined` / `''` / the number `0` → bare; the string `'0'` → scoped `vlan 0`) are upstream's
   * truth table, ported as {@link assertVlanScopeToken} says and pinned in all four combinations
   * (divergence 24). Upstream passes the command as a bare **string** to `configure_interface`
   * (`:1034`) — same wire text as the one-element list used here.
   */
  async addVtep(name: string, vtep: string, vlan?: string | number): Promise<void> {
    assertVxlanName('addVtep', name)
    assertVtepValue(vtep)
    const scoped = assertVlanScopeToken(vlan)
    await this.configureInterface(name, [scoped === undefined ? `vxlan flood vtep add ${vtep}` : `vxlan vlan ${scoped} flood vtep add ${vtep}`])
  }

  /** Remove a VTEP — pyeapi's `remove_vtep` (`interfaces.py:1036-1056`, same truth test at `:1052`, `remove` texts at `:1053`/`:1055`); tests `:523-531` pin both spellings. */
  async removeVtep(name: string, vtep: string, vlan?: string | number): Promise<void> {
    assertVxlanName('removeVtep', name)
    assertVtepValue(vtep)
    const scoped = assertVlanScopeToken(vlan)
    await this.configureInterface(name, [scoped === undefined ? `vxlan flood vtep remove ${vtep}` : `vxlan vlan ${scoped} flood vtep remove ${vtep}`])
  }

  /**
   * Map a VLAN to a VNI — pyeapi's `update_vlan` (`interfaces.py:1058-1073`), a **literal command
   * composition** with no keyword builder: the `%s`-interpolated
   * `vxlan vlan add <vid> vni <vni>` at `:1072`, pinned at test `:503-507` with the ints `10, 10`.
   * Note the asymmetry the field JSDoc warns about: the write carries the word `add`, the config line
   * the {@link vlanMappingsFromBlock} reader parses does not. The name is `update_vlan` upstream
   * although the command ADDs — the repo keeps upstream's name and says what it does
   * ({@link removeVlan} is the counterpart). Upstream validates neither argument
   * ({@link assertVlanId}/{@link assertVniValue} are this client's, divergence 24).
   */
  async updateVlan(name: string, vid: number, vni: number): Promise<void> {
    assertVxlanName('updateVlan', name)
    assertVlanId(vid)
    assertVniValue(vni)
    await this.configureInterface(name, [`vxlan vlan add ${String(vid)} vni ${String(vni)}`])
  }

  /**
   * Remove a VLAN/VNI mapping — pyeapi's `remove_vlan` (`interfaces.py:1075-1090`) and the section's
   * second **variant** site: the first attempt is the literal text
   * `vxlan vlan remove <vid> vni $` — trailing `$` and all, `:1089`, verbatim because pyeapi really
   * sends it (its testlib accepted the clean pin at `:508-512` as *any* variant, divergence 23) — and
   * the fallback is `vxlan vlan remove <vid> vni` (`:1090`). On a real device the first spelling
   * fails and the second runs: the spec pins both transactions and the last-error re-raise. The vid
   * goes through {@link assertVlanId} (upstream interpolates whatever arrives).
   */
  async removeVlan(name: string, vid: number): Promise<void> {
    assertVxlanName('removeVlan', name)
    assertVlanId(vid)
    await this.configureInterfaceVariants(name, [
      [`vxlan vlan remove ${String(vid)} vni $`],
      [`vxlan vlan remove ${String(vid)} vni`],
    ])
  }

  /**
   * Send one of several alternative command sequences for `interface <name>`, first success winning
   * and the last {@link CommandError} re-raised — the resource-side twin of
   * {@link Node.configureVariants} over {@link tryVariants} (`internal/variants.ts`, the re-shaped
   * `CliVariants` port from DR-006/row 37), and the same splice order pyeapi performs at
   * `client.py:644-653`. The name goes through the shared guard BEFORE any variant is attempted
   * (`configureInterface`'s own check, hoisted so a bad name never opens a transaction), and
   * `submodeCommands` wraps every alternative in `interface <name>` exactly once — upstream's
   * `configure_interface` marker splice puts the variants inside the submode
   * (`abstract.py:176-177` + `client.py:646-652`), which is what a fallback re-entering the same
   * submode means on the wire (two complete transactions, both pinned). `tryVariants` itself refuses
   * fewer than two variants — a single-element call is a caller that meant {@link configureInterface}.
   */
  private async configureInterfaceVariants(name: string, variants: readonly (readonly string[])[]): Promise<void> {
    assertInterfaceName(name)
    await tryVariants(
      variants.map((commands) => submodeCommands(`interface ${name}`, commands)),
      (commands) => this.configure(commands),
    )
  }

}

/**
 * Upstream's member-scrape answer, verbatim (`interfaces.py:673-674`): every `Ethernet…` token, keeping
 * slot digits, at a position that does not itself begin with `Peer` — which does **not** exclude a
 * `Peer-Ethernet1` spelling, since the hyphen supplies the word boundary (see {@link InterfacesResource.getMembers}).
 * Exported only for `interfaces.test.ts` to pin the exact look-around semantics — production code reaches it
 * through {@link InterfacesResource.getMembers}.
 */
export function membersFromOutput(output: string): string[] {
  return output.match(/\b(?!Peer)Ethernet[\d/]*\b/gu) ?? []
}
