/**
 * `stp` — global spanning-tree state plus the per-interface spanning-tree (portfast / bpduguard) view,
 * W2c (#39 #40): a port of `pyeapi/api/stp.py` (367 lines, BSD-3-Clause, Arista Networks — DR-001) on
 * top of the M7 (#9) framework (`Entity`, `EntityCollection`, `ResourceBase.configSections` /
 * `configure` / `commandBuilder`, `valueAfterKeyword`, the DR-026 `Node` memo, the registry).
 *
 * Every `pyeapi` range below was opened in the pinned clone `/home/svaj/development/arista/pyeapi`
 * (1.0.4-rc0, `develop` @ `6816d9e`) on 2026-11-05, and every behavioural claim is what the upstream
 * code **actually answers**. The probe column below is not prose: each answer came from running the real
 * classes against a fake `Node` whose `_running_config` is the config text named in the row (the same
 * harness `pyeapi/test/lib/testlib.py:67-124` builds — its fake node is wired in `setUp` at `:74-86` — with
 * `_chunkify`/`section` from `client.py:776-798`
 * reachable), so "upstream answers X" is reproducible, and nothing here claims what the DCS-7050TX-64 or
 * EOS 4.28.13.1M does — unit tests never reach a device, this workspace has no readable CLI sources for
 * the spanning-tree daemon, so every EOS-side rule reads "unverified on hardware, M12 (#14) to capture".
 *
 * | pyeapi (verified refs) | here |
 * |---|---|
 * | `Stp(Entity)` (`:61`), `__init__` caching `_interfaces`/`_instances` (`:88-91`) | {@link StpResource} extends `Entity<StpSettings>` (`base.ts:194-206`); the two sub-resources are memoised the same way — {@link StpResource.interfaces} / {@link StpResource.instances} (`:118-130`) |
 * | `get` (`:93-116`): `return dict(interfaces=self.interfaces.getall(), instances=self.instances.getall())` (`:115-116`) — **no `mode` key**, although the docstring's own shape says `{"mode": [mstp, none], …}` (`:109-113`) | {@link StpResource.get} returns `{ mode?, interfaces, instances }`: the two upstream halves plus the `spanning-tree mode …` line the docstring promises and the code never reads (row 167) |
 * | `set_mode` (`:132-156`): `if not default and not disable:` (`:150`) wraps `if value not in ['mstp', 'none']: raise ValueError` (`:151-153`), so the flag arms skip validation entirely; then `command_builder('spanning-tree mode', value=…, default=…, disable=…)` → `self.configure` (`:154-156`) | {@link StpResource.setMode} / {@link StpResource.unsetMode} / {@link StpResource.defaultMode} — the same three command texts, the `default=`/`disable=` kwargs become the mode table (`command-builder.ts`, DR-037), and upstream's `ValueError` becomes a `NotSupportedError` naming the value (DR-005/DR-053), checked unconditionally (row 167, **DR-096**) |
 * | `StpInstances(EntityCollection)` (`:159`), `getall` (`:167-169`) = `# TODO: (privateip, 20150106) stubbed out, needs implementation` + `return dict()` | {@link StpInstancesResource.getAll} answers an **empty table with zero reads**, and its entry type is `never` — the type-level statement that nothing is read here (row 171) |
 * | `StpInterfaces(EntityCollection)` (`:172`), `get` (`:181-211`): `isvalidinterface` gate (`:203-204`), `get_block(r'^interface\s%s$' % name)` (`:206`), three `_parse_*` merged with `dict.update` (`:207-210`) | {@link StpInterfacesResource.get} — same field set, typed record, `undefined` for absence (DR-027) |
 * | `_parse_bpduguard` (`:213-215`) `'spanning-tree bpduguard enable' in config`, `_parse_portfast` (`:217-219`) `'no spanning-tree portfast' not in config`, `_parse_portfast_type` (`:221-228`) `network`/`normal`/`edge` chain | {@link stpInterfaceFromBlock} — command-line-scoped versions of the same three rules (row 170) |
 * | `getall` (`:230-248`): `re.compile(r'(?<=^interface\s)(.+)$', re.M)` (`:240`) over the whole config, then `if name[0:2] in ['Et','Po']` (`:244`) and a per-name `get` (`:245`) | {@link StpInterfacesResource.getAll} — one chunked read, the same `Et`/`Po` gate, zero per-entry reads (DR-030, row 169) |
 * | `configure_interface` override (`:250-253`): `raise ValueError('invalid interface value specified')` unless `isvalidinterface(name)` | {@link StpInterfacesResource.configureStpInterface}'s guard is {@link assertStpPortName} — a stricter, asserted refusal (row 168) |
 * | `set_portfast_type` (`:255-280`): accept list `['network','edge','normal', None]` (`:274-276`), `cmds = ['spanning-tree portfast %s' % value]` plus `spanning-tree portfast auto` when `value == 'edge'` (`:277-279`) | {@link StpInterfacesResource.setPortfastType} — the same two-line pair for `'edge'`, with `None`/junk refused (row 172) |
 * | `set_portfast` (`:282-312`): `if value is False: disable = True` (`:307-308`) then `command_builder('spanning-tree portfast', …)` (`:309-311`) | {@link StpInterfacesResource.setPortfast} / {@link StpInterfacesResource.unsetPortfast} / {@link StpInterfacesResource.defaultPortfast} — `spanning-tree portfast`, `no spanning-tree portfast`, `default spanning-tree portfast` |
 * | `set_bpduguard` (`:314-343`): `value = 'enable' if value else 'disable'` (`:339`) then `command_builder('spanning-tree bpduguard', …)` (`:340-342`) | {@link StpInterfacesResource.setBpduguard} (boolean → the two **words** upstream uses), {@link StpInterfacesResource.unsetBpduguard} (`disable=True` → `no spanning-tree bpduguard`), {@link StpInterfacesResource.defaultBpduguard} (`default=True`) |
 * | module-level `isvalidinterface(value)` (`:346-363`): `return value[0:2] in ['Et', 'Po']` | **not** the M10 grammar (`validators.ts`'s per-kind parser) — this module's own {@link isStpPortSection} keeps upstream's two-character gate for reads, and the write side guards with {@link assertStpPortName} (row 168) |
 * | `instance(api)` (`:366-367`) | the `RESOURCE_FACTORIES.stp` row plus `Node.stp` (DR-006/DR-052) |
 *
 * Upstream's own suite is `pyeapi/test/unit/test_api_stp.py` — **21** test methods (AST count on
 * 2026-11-05: 7 in `TestApiStp` at `:46-84`, 14 in `TestApiStpInterfaces` at `:86-184`), i.e. the file
 * this lane's brief called `test/unit/test_stp.py`, which does not exist. (The spans this header carried
 * from the lane's dispatch brief were five lines early throughout — `test_instance` was cited `:48-50`,
 * `test_set_mode_invalid_value…` `:77-80`, and the last group `:207-210`; every one is re-opened and
 * corrected below and in `stp.test.ts`.) All 21 are ported in
 * {@link file://./stp.test.ts}: `test_instance` (`:53-55`), `test_interfaces` (`:57-59`),
 * `test_instances` (`:61-63`), `test_set_mode_with_value` (`:65-69`, pinning `spanning-tree mode mstp` /
 * `spanning-tree mode none`), `test_set_mode_with_default` (`:71-74`, `default spanning-tree mode`),
 * `test_set_mode_with_disable` (`:76-79`, `no spanning-tree mode`),
 * `test_set_mode_invalid_value_raises_value_error` (`:81-84`), `TestApiStpInterfaces.test_getall`
 * (`:95-97`), `test_set_portfast_type_with_value` (`:99-107`, including the second
 * `spanning-tree portfast auto` line for `edge`), `test_set_portfast_type_with_no_value` (`:109-113`,
 * `spanning-tree portfast normal`), `test_set_portfast_type_invalid_value_raises_value_error`
 * (`:115-119`), `test_set_portfast_type_invalid_intf_raises_value_error` (`:121-124`),
 * `test_set_bpduguard_with_value` (`:126-133`, the `enable`/`disable` **words**),
 * `test_set_bpduguard_with_no_value` (`:135-139`, `spanning-tree bpduguard disable` — because `value`
 * defaults to `False` at `:314`), `test_set_bpduguard_with_default` (`:141-145`),
 * `test_set_bpduguard_with_disable` (`:147-151`), `test_set_bpduguard_invalid_intf_raises_value_error`
 * (`:153-156`), `test_set_portfast_with_value` (`:158-167`, `spanning-tree portfast` /
 * `no spanning-tree portfast`), `test_set_portfast_with_no_value` (`:169-173`),
 * `test_set_portfast_with_default` (`:175-179`), `test_set_portfast_invalid_intf_raises_value_error`
 * (`:181-184`). Upstream never tests `Stp.get`, `StpInstances`, `StpInterfaces.get` or `getall`'s content —
 * its `test_getall` (`:95-97`) only asserts `isinstance(result, dict)` — so every read assertion here is
 * against a config of our own, probed against upstream first. Upstream's interface list for the writer
 * loops is `['Ethernet1', 'Ethernet1/1', 'Port-Channel1']` (`:88`), and `Ethernet1/1` is writable there and
 * refused here (row 168).
 *
 * ## Divergences this file owns (MIGRATION.md §5 rows 167-172)
 *
 * 1. **`mode` is read** (row 167). Upstream's `get()` has no mode in it (`:115-116`) even though its
 *    docstring shows the key (`:109-113`) and `set_mode` writes it (`:154-155`), so a pyeapi caller cannot
 *    see what mode the switch is in without scanning the config by hand. Here the mode comes from the
 *    chunked document's indent-0 keys, first `spanning-tree mode <token>` in device order, with the token
 *    kept verbatim (`StpSettings.mode` is `string`, narrowed by {@link isStpMode}). Writing is the closed
 *    upstream set: `{@link STP_MODES}` = `mstp`/`none`, which is exactly what `stp.py` itself enumerates
 *    (`:151`) and what its module docstring states for "this version" (`:38-41`). `rapid-pvst` is refused
 *    by name here as it is by upstream — **that refusal in this client is not a hardware claim**: the 4.28
 *    feature matrix derives Rapid-PVSTP/MST presence from the 7050X family, and the feature gate is the
 *    M11 (#13) capability probe, not a hard-coded mode list (DR-005/DR-032, **DR-096**).
 * 2. **`set_mode` refuses a mode this client does not spell** (row 167) with `NotSupportedError` naming
 *    the value. Upstream refuses the same way (`ValueError` at `:151-153`) but **conditionally**: its
 *    `if not default and not disable:` wrapper (`:150`) skips validation for the flag arms, so
 *    `set_mode('anything', disable=True)` sends `no spanning-tree mode` unchecked, while a no-arg
 *    `set_mode()` is the `ValueError` (`None` is not in the list) — the split verbs make the
 *    conditionality meaningless here, so the guard is unconditional. Upstream pins the four texts at
 *    `test_api_stp.py:65-84` (`mstp`/`none` `:65-69`, `default spanning-tree mode` `:71-74`, `no
 *    spanning-tree mode` `:76-79`, invalid value `:81-84`); the two flag kwargs land on the same
 *    command-builder arms (`abstract.py:152-155`), which is what `unsetMode`/`defaultMode` carry.
 * 3. **the spanning-tree name gate is upstream's own, not the M10 grammar** (row 168). `stp.py` ships a
 *    *private* `isvalidinterface` (`:346-363`) that is only `value[0:2] in ['Et','Po']` — a different rule
 *    from `interfaces.py:81-83` and from {@link assertInterfaceName}. Reads keep the two-character gate, so
 *    the accept/refuse split is reproduced: `Ethernet1`, `Ethernet1/1`, `Et1`, `Po1`, `Poke1` pass;
 *    `Vlan20`, `Management1`, `Loopback0`, `Vxlan1` do not (probe, run 2026-11-05). Writes are **narrower**
 *    than upstream on purpose: `assertStpPortName` = the repo's anchored name grammar plus
 *    kind ∈ {Ethernet, Port-Channel}, so the shorthands (`Et1`, `Po1`), the junk prefixes upstream accepts
 *    (`Poke1`) and the chassis/dotted forms (DECISIONS open item 7) all refuse at zero round trips, naming
 *    why. Upstream's own refusals are `ValueError('invalid interface value specified')` for the same family
 *    (`:251-252`, pinned by `test_api_stp.py:121-124`, `:153-156`, `:181-184`).
 * 4. **discovery cannot crash and cannot hallucinate** (row 169). Upstream's `getall` regex-scans the
 *    whole config (`:240`) and calls `get` per hit (`:245`), and `get` runs its substring parsers on
 *    whatever `get_block` returned (`:206-210`) — probe: a column-0 `interface Et1` line inside a
 *    `banner login … EOF` body makes the **whole** `getall()` raise
 *    `TypeError: argument of type 'NoneType' is not iterable` (`_parse_bpduguard`, `:214`), and
 *    `get('Et1')`/`get('Ethernet99')` on a section the switch does not have raise the same way rather than
 *    answering the `None` their docstring promises (`:201-204`). Here membership iterates the chunked
 *    document's indent-0 keys (`config/chunk.ts`, `client.py:741-750`) and an absent name answers
 *    `undefined` (DR-027). One `show running-config all` for the whole table, zero reads for a single-field
 *    write (DR-030).
 * 5. **the records keep the fields, and the defaults are the ones upstream answers** (row 170). An
 *    `interface Ethernet9` section with no spanning-tree line at all reads as
 *    `{ bpduguard: false, portfast: true, portfastType: 'edge' }` (probe against `:213-228`) — that is the
 *    upstream answer, and it is kept rather than "corrected", because inventing an absent marker for a
 *    field upstream always populates would be a different resource. What *is* corrected is the matching: the
 *    three rules test whole command lines (parsed body lines, `config-block.ts`) instead of substring
 *    presence in the raw block, so `no spanning-tree bpduguard`, a `! no spanning-tree portfast` comment, or
 *    the typed negation `no spanning-tree portfast network` no longer answer for their positive forms the
 *    way `in config` does. `portfastType` keeps the token the device wrote — `spanning-tree portfast auto`
 *    alone reads `auto` here, where upstream's chain answers `edge` (probe) — so the declared type is
 *    `string` with {@link isPortfastType} to narrow, exactly like `Switchport.mode` (row 98). Upstream's
 *    record also has **no** `name` key even though `get`'s docstring lists one (`:186`); the entry is named
 *    from the section header as {@link Switchport.interfaceName} is (DR-029's rule, row 96).
 * 6. **`StpInstances` is an honest empty collection** (row 171). Upstream's `getall` has returned
 *    `dict()` since the `TODO (privateip, 20150106)` at `:168`, its `get` inherits
 *    `EntityCollection.get`'s `raise NotImplementedError` (`abstract.py:223-224`), and it never defines
 *    `create`/`delete`/`default` at all — probe: `StpInstances().create(1)` is an `AttributeError`. Here
 *    {@link StpInstancesResource.getAll} answers an empty table **without touching the device** (parity
 *    with a stub), `get` answers `undefined`, and `create`/`delete`/`setDefault` refuse with
 *    `NotSupportedError` naming what is unbuilt. {@link StpInstance} is `never`, so no caller can invent an
 *    MST field this client has never read; filling this in is an M11 (#13) probe plus a spec question.
 * 7. **`create`/`delete`/`setDefault` refuse on both collections** (row 172). pyeapi has no such method on
 *    `StpInterfaces` (its docstring says "spanning-tree interfaces cannot be created or deleted", `:177-178`),
 *    so where those calls are `AttributeError` upstream, this client's `EntityCollection` contract
 * (`base.ts:221-245`, the abstract verbs a collection must answer) forces them to exist and they refuse with the upstream sentence in the message
 *    (DR-005: an explicit refusal, never a half-working verb).
 * 8. **the two flag-shaped writers are split into three verbs** (row 172). `set_portfast(name)` with no
 *    value produces the deprecated negation through `command_builder`'s `else:` arm (`:310-311` →
 *    `abstract.py:160-161`), and `set_bpduguard`'s "no value" arm is a **word**, not a negation, because
 *    `value=False` becomes `'disable'` at `:339` — pinned by `test_api_stp.py:135-139`
 *    (`spanning-tree bpduguard disable`) vs `:147-151` (`no spanning-tree bpduguard`). DR-037's
 *    `set`/`unset`/`default` verbs keep all four command texts distinguishable, and
 *    {@link StpInterfacesResource.setBpduguard} keeps the boolean-to-word mapping upstream has because
 *    those two words are what the config reads back (row 170's reader).
 * 9. **`setPortfastType` has no `None` arm** (row 172). Upstream lists `None` in its accept list (`:274`) and
 *    then interpolates it, so `set_portfast_type('Ethernet1', None)` sends the literal string
 *    `spanning-tree portfast None` (probe: `['interface Ethernet1', 'spanning-tree portfast None']`), and its
 *    `value='normal'` default (`:255`) is what `test_api_stp.py:109-113` pins. Here the value is required and
 *    grammar-checked; a caller wanting `normal` names it.
 */

import { NotSupportedError } from '../errors'
import { pythonRepr } from '../internal/wire'
import { parseBlock } from '../config/text'
import { valueAfterKeyword } from './config-block'
import { Entity, EntityCollection } from './base'
import { assertInterfaceName, parseInterfaceName } from './validators'
import type { ConfigBlock } from '../config/text'
import type { ConfigSections } from '../config/chunk'
import type { ResourceTable } from './types'

/**
 * The spanning-tree modes the **write** side of this client spells, which is the set upstream's
 * `set_mode` checks (`stp.py:151`: `['mstp', 'none']`) and the set its module docstring states for "this
 * version" (`:38-41`). It is a write-side policy, not a platform claim (row 167): which modes an EOS 4.28
 * release accepts on a 7050TX-64 is the M11 (#13) capability probe's answer, and
 * {@link StpSettings.mode} keeps whatever token the device wrote.
 */
export type StpMode = 'mstp' | 'none'

/** The modes in upstream's order (`stp.py:151`), for the runtime guard's message. */
export const STP_MODES: readonly StpMode[] = ['mstp', 'none']

/** Narrow an arbitrary device token to one of the modes this client writes. */
export function isStpMode(value: unknown): value is StpMode {
  return STP_MODES.includes(value as StpMode)
}

/**
 * The three `spanning-tree portfast <type>` values upstream's parse chain can produce (`stp.py:221-228`)
 * and its writer accepts (`:274`: `['network', 'edge', 'normal', None]` — the `None` is divergence 9).
 * `disabled`, which the *module* docstring lists as the accepted `portfast` value (`:49-50`), appears
 * nowhere in the code: the interface docstring at `:189-190` says `"edge", "network", "normal"`, and so
 * does this client's grammar (row 170).
 */
export type PortfastType = 'edge' | 'network' | 'normal'

/** The portfast types in the order the guard message lists them. */
export const PORTFAST_TYPES: readonly PortfastType[] = ['edge', 'network', 'normal']

/**
 * Narrow a device token to one of the three types upstream's chain knows. A read keeps the token
 * verbatim ({@link StpInterface.portfastType} is `string`), so a UI narrows with this instead of the
 * compiler guessing that the device speaks only three words (row 98's rule for `Switchport.mode`).
 */
export function isPortfastType(value: unknown): value is PortfastType {
  return PORTFAST_TYPES.includes(value as PortfastType)
}

/**
 * One interface's spanning-tree state — upstream's `StpInterfaces.get` record (`stp.py:181-211`), minus
 * the `name` key its docstring promises and its code never sets (divergence 5), plus the entry's own name
 * under the key the collection uses (row 96).
 *
 * All three fields are always populated, because upstream's three `_parse_*` methods always return a value
 * (`:213-228`): a section with no spanning-tree line reads `{ bpduguard: false, portfast: true,
 * portfastType: 'edge' }` (probe), and that is what this client reports rather than an invented "absent"
 * (row 170).
 */
export interface StpInterface {
  /** The interface name, spelled as the section header spells it. */
  readonly interfaceName: string
  /** `no spanning-tree portfast` absent from the block → `true`. Upstream's default-on reading (`:218`). */
  readonly portfast: boolean
  /** The first `spanning-tree portfast <token>` value as written, else the negation/`edge` fallback chain (`:221-228`). */
  readonly portfastType: string
  /** `spanning-tree bpduguard enable` present in the block (`:214`). */
  readonly bpduguard: boolean
}

/**
 * A spanning-tree instance (MST). Upstream's `StpInstances.getall` (`:167-169`) has been a stub since
 * 2015, so **nothing is read** here and no field set is claimed — `never` is the honest entry type, not a
 * placeholder to cast through (row 171).
 */
export type StpInstance = never

/**
 * The whole global spanning-tree configuration, as this client reads it — upstream's `Stp.get()` shape
 * (`:115-116`) plus the `mode` its docstring promises and its code omits (row 167).
 */
export interface StpSettings {
  /**
   * The `spanning-tree mode <token>` line's token, device order first, **verbatim** — absent when the
   * running-config carries no such line. {@link isStpMode} narrows it; which values exist on this unit is
   * an M11 (#13) probe (DR-032).
   */
  readonly mode?: string
  /** Every Ethernet / Port-Channel interface's spanning-tree state, keyed by name — `StpInterfaces.getall` (`:230-248`). */
  readonly interfaces: ResourceTable<string, StpInterface>
  /** MST instances — always empty here, because upstream's reader is a stub (row 171). */
  readonly instances: ResourceTable<string, StpInstance>
}

/** A section header naming an interface. Anchored, so an indented copy never matches. */
const INTERFACE_SECTION = /^interface (\S+)$/u

/**
 * Upstream's two-character gate for "this could be a spanning-tree port" (`stp.py:244` in `getall`,
 * `:363` in `isvalidinterface`), applied to a **section name**. Kept as the read-side rule so the
 * accept/refuse split is the one the pinned clone has — `Et1`, `Po1` and `Poke1` included,
 * `Vlan20`/`Management1`/`Loopback0`/`Vxlan1` excluded (row 168). The write side uses
 * {@link assertStpPortName}, which is the repo's kind grammar instead.
 */
function hasStpPortPrefix(name: string): boolean {
  return name.startsWith('Et') || name.startsWith('Po')
}

/** A rejected argument is named in the message (the `refuse` pattern from `validators.ts:226-229`, DR-053). */
function refuse(label: string, value: unknown, because: string): never {
  throw new NotSupportedError(`invalid ${label} ${pythonRepr(value)} — ${because}`, { cause: value })
}

/**
 * Require an interface name this client may write spanning-tree commands to.
 *
 * Two guards, in this order, because they answer different questions and upstream only has the weak one:
 * {@link assertInterfaceName} (`validators.ts:296-301`, the anchored per-kind grammar — DECISIONS open
 * item 7 keeps the chassis and dotted forms refused on this unit until M12 #14 captures them) and the
 * kind test, which is what `stp.py`'s docstring states ("Spanning-tree interfaces are only supported on
 * Ethernet and Port-Channel interfaces", `:194-195`) where its code states a two-character prefix test
 * (`:363`). Upstream validates an STP port name **only** with that prefix test (`:251-252`), so writing to
 * `Et1`/`Poke1` is legal there (`ValueError('invalid interface value specified')` is what `Vlan20` gets —
 * pinned by `test_api_stp.py:121-124`/`:153-156`/`:181-184`). Here both refusals are `NotSupportedError`
 * at zero round trips (row 168).
 */
function assertStpPortName(verb: string, value: unknown): asserts value is string {
  assertInterfaceName(value)
  const kind = parseInterfaceName(value)?.kind
  if (kind === 'Ethernet' || kind === 'Port-Channel') return
  refuse(
    `${verb} interface`,
    value,
    'expected an Ethernet or Port-Channel name — pyeapi documents spanning-tree interfaces on those two kinds only (api/stp.py:194-195) and gates them with value[0:2] in ["Et", "Po"] (api/stp.py:363); the shorthands that test lets through (Et1, Po1, Poke1) are not names this client writes',
  )
}

/** Require one of the modes this client writes ({@link STP_MODES}). */
function assertStpMode(value: unknown): asserts value is StpMode {
  if (isStpMode(value)) return
  refuse(
    'spanning-tree mode',
    value,
    `expected one of ${STP_MODES.join(' / ')} — that is the literal set pyeapi checks at api/stp.py:151 and documents for its own version at :38-41, and it is a write-side policy, NOT a claim about this SKU: Rapid-PVSTP/MST support in the 4.28 feature matrix is 7050X-family-derived, the device decides (DR-032/DR-096), and the feature gate is the M11 #13 capability probe`,
  )
}

/** Require one of the three portfast types upstream's chain knows ({@link PORTFAST_TYPES}). */
function assertPortfastType(value: unknown): asserts value is PortfastType {
  if (isPortfastType(value)) return
  refuse(
    'portfast type',
    value,
    `expected one of ${PORTFAST_TYPES.join(' / ')} — pyeapi accepts ['network','edge','normal', None] at api/stp.py:274 and interpolates the None as the literal word "None" (probe: 'spanning-tree portfast None'), which this client refuses`,
  )
}

/** The keyword forms, matched against a parsed body line's command text (`config-block.ts`). */
const BPDUGUARD_KEYWORD = 'spanning-tree bpduguard'
const PORTFAST_KEYWORD = 'spanning-tree portfast'
const PORTFAST_AUTO_COMMAND = 'spanning-tree portfast auto'
const MODE_KEYWORD = 'spanning-tree mode'

/**
 * The exact negated form of the bare `spanning-tree portfast` command — upstream's test for it is the
 * substring `'no spanning-tree portfast' in config` (`:218`), which also fires on
 * `no spanning-tree portfast network`; here it is one whole command line, so a typed negation cannot flip
 * the bare flag (row 170).
 */
const NO_PORTFAST_COMMAND = 'no spanning-tree portfast'

/**
 * One `interface …` block's spanning-tree fields, in upstream's merge order (`:207-210`).
 *
 * The three rules are the same three upstream rules, scoped to command lines:
 *  - `bpduguard`: some body line is exactly `spanning-tree bpduguard enable` (`:214`).
 *  - `portfast`: **no** body line is exactly `no spanning-tree portfast` (`:218`), i.e. default-on
 *    exactly as upstream answers it for a block with no spanning-tree line at all (probe).
 *  - `portfastType`: the first `spanning-tree portfast <token>` body line's token, kept verbatim, then
 *    upstream's own fallback chain — `normal` when the block negates portfast (`:224-225`), otherwise
 *    `edge` (`:226-227`). Device order decides, which is M10a's rule for a field with two spellings
 *    (row 102), and it differs from upstream's precedence only for a block writing both
 *    `… edge` before `… network` (row 170).
 */
function stpInterfaceFieldsFrom(block: ConfigBlock): Omit<StpInterface, 'interfaceName'> {
  const bpduguardEnabled = block.body.some((line) => line.text === `${BPDUGUARD_KEYWORD} enable`)
  const negated = block.body.some((line) => line.text === NO_PORTFAST_COMMAND)
  const portfastToken = valueAfterKeyword(block.body, PORTFAST_KEYWORD)
  return {
    bpduguard: bpduguardEnabled,
    portfast: !negated,
    portfastType: portfastToken ?? (negated ? 'normal' : 'edge'),
  }
}

/** Parse one section's text into an {@link StpInterface}, using the section key's own spelling. */
function stpInterfaceFrom(name: string, sectionText: string): StpInterface {
  return { interfaceName: name, ...stpInterfaceFieldsFrom(parseBlock(sectionText)) }
}

/** A top-level `spanning-tree mode <token>` command, matched against a section **key** (row 84's rule). */
const MODE_KEY = new RegExp(`^${MODE_KEYWORD} (\\S+)$`, 'u')

/**
 * The global `spanning-tree mode <token>` line, read from the chunked document's **indent-0 section keys**
 * — the same rule DR-055/row 84 established for `hostname`, and the reason a banner body line or an
 * interface sub-mode's indented copy cannot state the switch's mode. First match in device order wins.
 */
function stpModeFromSections(sections: ConfigSections): string | undefined {
  for (const key of sections.keys()) {
    const match = MODE_KEY.exec(key)
    if (match?.[1] !== undefined) return match[1]
  }
  return undefined
}

/**
 * Every spanning-tree interface in a chunked running-config, in one pass and **one** device read (DR-030).
 *
 * Upstream's `getall` (`:240-248`) scans the whole text, keeps any `interface …` hit whose name starts
 * `Et`/`Po`, and calls `get` per name — a `section()` key scan plus four substring tests per entry, and a
 * `TypeError` for a hit that is a banner body line (divergence 4). Here membership is the chunked
 * document's indent-0 header keys, the gate is {@link hasStpPortPrefix}, and a section with no
 * spanning-tree line at all still produces a record, because that is what upstream answers for it
 * (divergence 5) — its `if interface:` filter (`:246`) never drops one.
 */
function stpInterfacesFromSections(sections: ConfigSections): Map<string, StpInterface> {
  const interfaces = new Map<string, StpInterface>()
  for (const [key, sectionText] of sections) {
    const name = INTERFACE_SECTION.exec(key)?.[1]
    if (name === undefined || !hasStpPortPrefix(name)) continue
    interfaces.set(name, stpInterfaceFrom(name, sectionText))
  }
  return interfaces
}

/**
 * `node.stp` — global spanning-tree state, and the entry point to the interface and instance views.
 * Port of `Stp(Entity)` (`stp.py:61`).
 *
 * Unlike the other `Entity` in this package ({@link SystemResource}, which writes global commands through
 * `configure`), the spanning-tree **interface** commands are reached through {@link StpResource.interfaces}
 * — pyeapi's composition (`:118-130`) rather than one flat resource, kept because
 * `StpInterfaces.configure_interface` owns the name gate (`:250-253`) and the parent line
 * (`abstract.py:176-177`).
 */
export class StpResource extends Entity<StpSettings> {
  private interfacesResource: StpInterfacesResource | undefined
  private instancesResource: StpInstancesResource | undefined

  /**
   * The per-interface spanning-tree view — pyeapi's `Stp.interfaces` property (`:118-123`), memoised like
   * upstream's `_interfaces` field (`:90`), so `node.stp.interfaces === node.stp.interfaces` and the view
   * shares this `Node`'s config memo.
   */
  get interfaces(): StpInterfacesResource {
    this.interfacesResource ??= new StpInterfacesResource(this.node)
    return this.interfacesResource
  }

  /**
   * The spanning-tree instances view — pyeapi's `Stp.instances` property (`:125-130`). Same memo, and the
   * same honest emptiness as upstream's stubbed `getall` (row 171).
   */
  get instances(): StpInstancesResource {
    this.instancesResource ??= new StpInstancesResource(this.node)
    return this.instancesResource
  }

  /**
   * The whole spanning-tree configuration in **one** config read: the mode line, every spanning-tree
   * interface, and the (empty) instance table.
   *
   * Upstream pays a `getall` per sub-resource over the lazily re-read `self.config` property
   * (`:93` + `abstract.py:74-76`, row 75) and, per entry, a `section()` scan plus a fresh
   * `re.compile` (`:245` → `get` → `get_block`) — and it never answers `mode` at all (row 167).
   */
  override async get(): Promise<StpSettings> {
    const sections = await this.configSections()
    const interfaces = stpInterfacesFromSections(sections)
    const instances = await this.instances.getAll()
    const mode = stpModeFromSections(sections)
    return {
      interfaces,
      instances,
      ...(mode === undefined ? {} : { mode }),
    }
  }

  /**
   * `spanning-tree mode <mode>` — pyeapi's `set_mode(value=…)` (`:154-155`), whose command texts
   * `test_api_stp.py:65-69` pins (`mstp`, `none`). The value is {@link assertStpMode}-checked with the
   * same list upstream checks (`:151-153`) — but unconditionally, where upstream's check sits inside
   * its `if not default and not disable:` wrapper at `:150` — and the refusal is this client's grammar rather than a hardware
   * statement (DR-096).
   */
  async setMode(mode: StpMode): Promise<void> {
    assertStpMode(mode)
    await this.configure(this.commandBuilder(MODE_KEYWORD, { value: mode }))
  }

  /** `no spanning-tree mode` — upstream's `set_mode(disable=True)` (`:154-155`; `test_api_stp.py:76-79`). */
  async unsetMode(): Promise<void> {
    await this.configure(this.commandBuilder(MODE_KEYWORD, { mode: 'no' }))
  }

  /**
   * `default spanning-tree mode` — upstream's `set_mode(default=True)` (`test_api_stp.py:71-74`), whose
   * docstring flags the parameter as "not defaultable" (`:135-136`) while still emitting the command. This
   * client sends what its own verb names and lets the device answer (DR-005); whether EOS 4.28 accepts
   * `default spanning-tree mode` is an M12 (#14) capture, and the pinned upstream test only proves
   * pyeapi **sends** it.
   */
  async defaultMode(): Promise<void> {
    await this.configure(this.commandBuilder(MODE_KEYWORD, { mode: 'default' }))
  }
}

/**
 * `node.stp.instances` — the MST instance view, pyeapi's `StpInstances` (`stp.py:159`).
 *
 * It is empty, and says so: upstream's only method is a stub (`getall` at `:167-169`, with
 * `# TODO: (privateip, 20150106) stubbed out, needs implementation` at `:168`), `get` comes from the base
 * class as `raise NotImplementedError` (`abstract.py:223-224`), and `create`/`delete`/`default` do not
 * exist on the class at all (probe: `AttributeError`). Row 171 owns that;
 * {@link StpInstance} = `never` keeps anyone from filling the gap with guesses.
 */
export class StpInstancesResource extends EntityCollection<StpInstance, string> {
  /**
   * An empty table, with **zero** device reads — parity with upstream's `return dict()` (`stp.py:169`),
   * which never touches `self.config`. A caller must not read this as "the switch has no MST instances":
   * it is this client not having implemented the reader (row 171).
   */
  override async getAll(): Promise<ResourceTable<string, StpInstance>> {
    return new Map<string, never>()
  }

  /** Nothing is readable, so nothing is found. Upstream's `get` raises `NotImplementedError` (`abstract.py:223-224`). */
  override async get(name: string): Promise<StpInstance | undefined> {
    return (await this.getAll()).get(name)
  }

  /** Refused: neither pyeapi nor this client can create an MST instance (row 171). */
  override async create(name: string): Promise<void> {
    throw this.unimplemented('create', name)
  }

  /** Refused: neither pyeapi nor this client can delete an MST instance (row 171). */
  override async delete(name: string): Promise<void> {
    throw this.unimplemented('delete', name)
  }

  /** Refused: neither pyeapi nor this client can default an MST instance (row 171). */
  override async setDefault(name: string): Promise<void> {
    throw this.unimplemented('setDefault', name)
  }

  private unimplemented(verb: string, name: string): NotSupportedError {
    const error = new NotSupportedError(
      `stp instances: ${verb}(${pythonRepr(name)}) is not implemented — pyeapi's StpInstances.getall is a stub that returns an empty dict (api/stp.py:167-169, TODO at :168), its get() raises NotImplementedError (abstract.py:223-224) and it defines no ${verb === 'setDefault' ? 'default' : verb} at all (probe: AttributeError). Reading spanning-tree instances needs an M11 #13 capability probe and a spec first (row 171)`,
      { cause: name },
    )
    return error
  }
}

/**
 * `node.stp.interfaces` — the per-interface spanning-tree view, pyeapi's `StpInterfaces`
 * (`stp.py:172`), the module's own §5-row-168 name gate and its three portfast/bpduguard writers.
 *
 * A {@link StpInterface} record cannot be created or deleted, here or upstream: "Note that spanning-tree
 * interfaces cannot be created or deleted" (`:177-178`). What spans the two kinds is the *verb* — a
 * `spanning-tree …` line inside an interface section, which the L2/L3 state of that section (the
 * `switchports`/`ipinterfaces` resources) does not touch.
 */
export class StpInterfacesResource extends EntityCollection<StpInterface, string> {
  /**
   * One interface's spanning-tree state, or `undefined` — pyeapi's `get` (`:181-211`) with the crash and
   * the `None` of `:203-206` replaced by DR-027's absence (`get('Vlan20')` and `get('Ethernet99')` both
   * answer `undefined` here; upstream answers `None` for the first and raises `TypeError` for the second,
   * divergence 4).
   *
   * No name guard on the read path, deliberately: a read reports the device, including a section spelled
   * `interface Et1` that this client would refuse to write (row 168's asymmetry, the same split
   * `switchports.ts:510-520` documents).
   */
  override async get(name: string): Promise<StpInterface | undefined> {
    return (await this.getAll()).get(name)
  }

  /**
   * Every spanning-tree interface, keyed by section name in device order — pyeapi's `getall` (`:230-248`)
   * as a `ResourceTable` (row 78) with **one** config read (DR-030) instead of a read-plus-scan per entry.
   * Upstream's own test only checks the type (`test_api_stp.py:95-97`), so the content here comes from
   * probed upstream answers.
   */
  override async getAll(): Promise<ResourceTable<string, StpInterface>> {
    return stpInterfacesFromSections(await this.configSections())
  }

  /** Refused, with upstream's own words: spanning-tree interfaces cannot be created (`stp.py:177-178`). */
  override async create(name: string): Promise<void> {
    throw this.noEntryVerbs('create', name)
  }

  /** Refused, with upstream's own words: spanning-tree interfaces cannot be deleted (`stp.py:177-178`). */
  override async delete(name: string): Promise<void> {
    throw this.noEntryVerbs('delete', name)
  }

  /** Refused: there is no entry-level `default interface …` in this module upstream (row 172). */
  override async setDefault(name: string): Promise<void> {
    throw this.noEntryVerbs('setDefault', name)
  }

  private noEntryVerbs(verb: string, name: string): NotSupportedError {
    const error = new NotSupportedError(
      `stp interfaces: ${verb}(${pythonRepr(name)}) is not a thing a spanning-tree interface is — pyeapi's StpInterfaces docstring says spanning-tree interfaces cannot be created or deleted (api/stp.py:177-178) and implements no such method (probe: AttributeError). The entry belongs to the interface itself: see node.interfaces / node.switchports`,
      { cause: name },
    )
    return error
  }

  /**
   * Enter `interface <name>` and send `cmds` — pyeapi's `configure_interface` override (`:250-253`), which
   * raises `ValueError('invalid interface value specified')` unless its two-character gate passes. Here the
   * gate is {@link assertStpPortName} and the parent line comes from the non-mutating
   * {@link ResourceBase.configureInterface} (`base.ts:179-182`, row 71).
   */
  protected async configureStpInterface(name: string, commands: readonly string[]): Promise<void> {
    assertStpPortName('configure_interface', name)
    await this.configureInterface(name, commands)
  }

  /**
   * `spanning-tree portfast <type>`, plus `spanning-tree portfast auto` for `'edge'` — pyeapi's
   * `set_portfast_type` (`:255-280`). The two-line pair is upstream's, pinned by
   * `test_api_stp.py:99-107`, and is reproduced verbatim; so is the single line for `network`/`normal`.
   *
   * `value` is required and grammar-checked: upstream's accept list admits `None` (`:274`) and then
   * stringifies it, so upstream's `set_portfast_type('Ethernet1', None)` really sends
   * `spanning-tree portfast None` (probe) — refused here (divergence 9). Upstream's `value='normal'`
   * **default** (`:255`) is what `test_api_stp.py:109-113` pins for a value-less call; here the caller
   * names `normal`, because DR-037 refuses a verb whose meaning changes when an argument is left out.
   */
  async setPortfastType(name: string, value: PortfastType): Promise<void> {
    assertPortfastType(value)
    const commands = [this.commandBuilder(PORTFAST_KEYWORD, { value })]
    if (value === 'edge') commands.push(PORTFAST_AUTO_COMMAND)
    await this.configureStpInterface(name, commands)
  }

  /**
   * `spanning-tree portfast` — pyeapi's `set_portfast(name, value=True)` (`:309-311`,
   * `test_api_stp.py:158-167`). The bare command is the whole affirmative form; there is no value to pass.
   */
  async setPortfast(name: string): Promise<void> {
    await this.configureStpInterface(name, [this.commandBuilder(PORTFAST_KEYWORD, { value: true })])
  }

  /**
   * `no spanning-tree portfast` — upstream spells this two ways, `value=False` (`:307-308` folds it into
   * `disable=True`, pinned at `test_api_stp.py:158-167`) and `disable=True` itself (`:169-173`); a **value-less** call
   * reaches the deprecated fall-through (`abstract.py:160-161`) and lands on the same `no …` text, which is
   * the ambiguity DR-037 removes by naming the intent.
   */
  async unsetPortfast(name: string): Promise<void> {
    await this.configureStpInterface(name, [this.commandBuilder(PORTFAST_KEYWORD, { mode: 'no' })])
  }

  /** `default spanning-tree portfast` — upstream's `set_portfast(default=True)` (`test_api_stp.py:175-179`). */
  async defaultPortfast(name: string): Promise<void> {
    await this.configureStpInterface(name, [this.commandBuilder(PORTFAST_KEYWORD, { mode: 'default' })])
  }

  /**
   * `spanning-tree bpduguard enable` / `spanning-tree bpduguard disable` — pyeapi's `set_bpduguard`
   * (`:339-343`), which turns the boolean into one of two **words** rather than into a negated command, and
   * defaults `value=False` (`:314`) so a value-less call writes the disable word (pinned separately by
   * `test_api_stp.py:135-139`; the enable/disable pair itself is `:126-133`). Keeping the mapping is a read-back contract: {@link StpInterface.bpduguard}
   * is the presence of the `enable` line (row 170).
   */
  async setBpduguard(name: string, value: boolean): Promise<void> {
    await this.configureStpInterface(name, [this.commandBuilder(BPDUGUARD_KEYWORD, { value: value ? 'enable' : 'disable' })])
  }

  /** `no spanning-tree bpduguard` — upstream's `set_bpduguard(disable=True)` (`test_api_stp.py:147-151`). */
  async unsetBpduguard(name: string): Promise<void> {
    await this.configureStpInterface(name, [this.commandBuilder(BPDUGUARD_KEYWORD, { mode: 'no' })])
  }

  /** `default spanning-tree bpduguard` — upstream's `set_bpduguard(default=True)` (`test_api_stp.py:141-145`). */
  async defaultBpduguard(name: string): Promise<void> {
    await this.configureStpInterface(name, [this.commandBuilder(BPDUGUARD_KEYWORD, { mode: 'default' })])
  }
}
