/**
 * `vrrp` — the interface-scoped VRRP virtual-router resource collection, W3c (#51): the `vrrp <n> …`
 * lines inside `interface …` sections read from the running-config, and the create/delete/default plus
 * fifteen property writes that maintain them, built on the M7 (#9) framework like `vlans.ts`,
 * `vrfs.ts` and `staticroute.ts` (DR-026 memo, {@link commandBuilder}/{@link submodeCommands} from
 * `./command-builder`, and the registry row that replaces pyeapi's `node.api('vrrp')` autoload (DR-006)).
 *
 * Port of `pyeapi/api/vrrp.py` (1,493 lines, BSD-3-Clause, Arista Networks — DR-001). Every `pyeapi`
 * ref below was re-opened in the pinned clone `/home/svaj/development/arista/pyeapi`
 * (1.0.4-rc0, `develop` @ `6816d9e`) on 2026-11-06 and says what the code **does** — nothing here cites
 * EOS image internals, and nothing claims what the DCS-7050TX-64 accepts: unit tests never reach a
 * device, so every EOS-side question reads "unverified on hardware, M12 (#14) to capture". VRRP
 *feature licensing on this SKU is itself a DECISIONS.md open question the same way.
 *
 * | pyeapi (verified refs) | here |
 * |---|---|
 * | `PROPERTIES` (`:160-161`) — a module-level list **never referenced anywhere in the file** | not ported; the write-order fact it gestures at lives in {@link VrrpResource.vrrpSet}, whose sequence `vrrp.py:1231-1416` itself fixes |
 * | `Vrrp(EntityCollection)` (`:167`) | {@link VrrpResource} extends `ResourceBase` (`base.ts`) — upstream "is" an `EntityCollection` but breaks its own contract: `get` takes an **interface** and answers a per-vrid table (`:174-229`), and `create`/`delete`/`default` take the **pair** `(interface, vrid)` (`:391`, `:418`, `:439`). The framework's single-key `create(name, attrs)`/`delete(name)` cannot express that pair, and `ResourceAttrs` (`types.ts`, values `string \| number \| boolean`) cannot carry the `secondary_ip` list or `track` dicts. Documented divergence (this lane's §5 band, filed by the follow-up round) |
 * | `get(name)` (`:174-229`): empty/None `raise ValueError` (`:188-190`); `get_block('interface %s')` (`:194-196`); vrid census `re.findall(r'^\s+(?:no \|)vrrp (\d+)', config, re.M)` (`:200`); fourteen `self._parse_*(config, vrid)` merges (`:212-226`); `result.update({int(vrid): subd})` (`:226`); `return result if result else None` (`:229`) | {@link VrrpResource.get} → `Map<number, Vrrp> \| undefined`; the guards refuse with `NotSupportedError` (DR-005/DR-010), the census keeps upstream's exact regex (a `default vrrp N …` line is invisible to it — upstream's own default write-back cannot seed its vrid set), and the identity is the **pair** (interface, vrid): the table is keyed by vrid exactly like upstream's `int(vrid)` dict keys |
 * | `getall()` (`:231-249`): `re.findall(r'^interface\s(\S+)', self.config, re.M)` (`:242`), then `self.get(interface)` per interface with the `if vrrp:` update (`:245-249`) | {@link VrrpResource.getAll} — `Map<string, ReadonlyMap<number, Vrrp>>` built from the chunker's indent-0 section keys (same rule as `vlans.ts` divergence 3, `vrfs.ts` divergence 2, `staticroute.ts` divergence 1): indented copies and banner bodies cannot vote, and a header the interface grammar cannot read is a `ConfigParseError` naming the section instead of a phantom leading-token name |
 * | the fourteen `_parse_*` readers (`:253-391`), each gated on `self.version_number >= '4.21.3'` for the keyword family (except `preempt` `:292`, `mac_addr_adv_interval` `:319`, the two `preempt delay` readers `:325`/`:331` and `bfd_ip` `:337`, which are era-independent) | private {@link parseVrrp} + the per-field readers below; the family comes from the config text itself ({@link detectCommandFamily}, the `vrfs.ts`/DR-099 precedent — see divergence 1) |
 * | `create(interface, vrid, **kwargs)` (`:391-417`): `if 'enable' not in kwargs: kwargs['enable'] = False` (`:413-414`) then `_vrrp_set` | {@link VrrpResource.create} — never mutates the caller's attrs object (row 71's non-mutation rule, which upstream's `kwargs[...] =` write breaks in its own frame); defaults `enable` to `false` exactly like `:413-414` |
 * | `delete` (`:418-438`, `vrrp_str = "no vrrp %d"` at `:436`) / `default` (`:439-460`, `"default vrrp %d"` at `:458`) | {@link VrrpResource.delete} / {@link VrrpResource.setDefault} — identical era-independent texts; throw instead of returning `False` (DR-005) |
 * | the fifteen `set_*` methods (`:461-1230`) and `_vrrp_set` (`:1231-1420`) | {@link VrrpResource.setEnable} … {@link VrrpResource.setBfdIp} + private {@link vrrpSet} — sequence-preserving port of the kwarg dispatch table (`:1236-1413`), one `configure_interface` transaction (`:1415`) |
 * | `vrconf_format(vrconfig)` (`:1421-1482`) — the PLAN.md §4 named helper | {@link VrrpResource.vrconfFormat}, ported as part of the module's documented surface: maps a `create`-shape config onto the answers {@link VrrpResource.get} would give after applying it, for "validate an updated config against the device" flows |
 * | `instance(node)` (`:1483-1493`) | the `RESOURCE_FACTORIES.vrrp` row plus `Node.vrrp` (DR-006/DR-052) |
 *
 * Upstream's own suite is `pyeapi/test/unit/test_api_vrrp.py` — **23** test methods (verified in the
 * pinned clone on 2026-11-06; every range below verified by grep of the method defs): `test_instance`
 * (`:147-150`), `test_get` (`:151-159`), `test_get_non_existent_interface` (`:160-165`),
 * `test_get_invalid_parameters` (`:166-172`), `test_getall` (`:173-177`), `test_create` (`:178-300`,
 * three sub-cases), `test_delete` (`:301-313`), `test_default` (`:314-326`), `test_set_enable`
 * (`:327-347`), `test_set_primary_ip` (`:348-374`), `test_set_priority` (`:375-399`),
 * `test_set_description` (`:400-419`), `test_set_ip_version` (`:420-443`), `test_set_secondary_ips`
 * (`:444-496`), `test_set_timers_advertise` (`:497-522`), `test_set_mac_addr_adv_interval`
 * (`:523-549`), `test_set_preempt` (`:550-575`), `test_set_preempt_delay_min` (`:576-604`),
 * `test_set_preempt_delay_reload` (`:605-633`), `test_set_delay_reload` (`:634-659`), `test_set_tracks`
 * (`:660-730`), `test_set_bfd_ip` (`:731-757`), `test_vrconf_format` (`:758-808`). All twenty-three
 * are ported in `vrrp.test.ts`. Their fake node pins
 * `version_number = '4.17.1.1'` (`test/lib/testlib.py:75`), so every command text upstream pins is the
 * **legacy** keyword family — reproduced verbatim here under a config whose `vrrp` lines are legacy, and
 * the modern family is pinned against the `ipv4`-era texts of the same lines (reader modern arms
 * `:255`/`:264`/`:274`/`:284`/`:310`/`:347`/`:357`/`:367`; setter modern arms `:482`/`:487` (enable),
 * `:530`/`:537`/`:542` (primary_ip), `:588` (priority), `:629` (description), `:674` (ip_version),
 * `:746`/`:752` (secondary), `:796` (timers), `:1015` (delay_reload), and `:1156`/`:1172` (tracks)).
 *
 * ## Divergences this file owns
 *
 * The follow-up round of W3c (2026-11-07) recorded them: MIGRATION.md §5 **rows 213-224** and
 * DECISIONS.md **DR-116..121**, and the divergence-pinning tests live in `vrrp.test.ts` under
 * "divergence pins". Row numbers are cited HERE only from the numbered divergence list below, matching
 * the ledger order of that round: divergence 1 → row 213, 2 → 214, 3 → 215, 4 → 216, 5 → 217,
 * 6 → 218, with rows 219-224 covering the diffing-verb, formatter and parser facts the tests pin.
 *
 * 1. **the command family comes from the device's own config text, not from a `version_number`
 *    string compare.** Upstream gates ten readers and the `set_*` command stems on
 *    `self.version_number >= '4.21.3'` — a lexicographic compare (`'4.9' >= '4.21.3'` is `True`
 *    character-wise, the DR-078/DR-099 bug class). {@link detectCommandFamily} instead reads which
 *    family the config **actually spells**: any modern-era `vrrp` line (`ipv4`, `session description`,
 *    `priority-level`, `advertisement interval` with a space, `tracked-object`, `timers delay reload`,
 *    `disabled`) → modern; only legacy-era lines (`shutdown`, `ip …`, `description`, `priority …`,
 *    `timers advertise`, `track …`, `delay reload …`) → legacy; no evidence → modern, this repo's floor
 *    (EOS 4.28 per AGENTS.md; upstream's own `>= 4.21.3` arm for that floor) held as a client
 *    convention, the device staying authoritative with its own `CommandError` (DR-032). Reads decide
 *    per **interface block** (the text the reader is about to run over); form-dependent **writes**
 *    scan the whole config once and latch, like `vrfs.resolveVrfForm`. The era-neutral lines —
 *    `mac-address advertisement-interval` (`vrrp.py:319` uses no version gate), `bfd ip` (`:337`,
 *    `:1192` also ungated), `preempt` and the two `preempt delay` stems (`:292`, `:325`, `:331`),
 *    `authentication`, `ipv6` — speak neither family, matching upstream's ungated readers.
 * 2. **`run=False` is still a string, and `run=True` returns it too.** Upstream's setters return the
 *    formatted command when `run=False`, and `True`/`self.error` when they execute (`:495-503` and its
 *    `if run:` twins on every setter); `_vrrp_set` builds its transaction entirely from `run=False`
 *    calls (`:1231-1420`). Here every setter **always resolves to the command text it composed** (the
 *    list for the two diffing verbs) and executes it unless `options.run === false`;
 *    `True`/`self.error` is replaced by throw-on-failure (DR-005), so the dry-run capability survives
 *    without the falsy-return check the UI could forget.
 * 3. **negation is a mode, not a kwarg** (DR-037): upstream's `disable=True`/`default=True` kwargs
 *    become `options.mode === 'no' | 'default'`, and `commandBuilder` keeps upstream's order
 *    (default → disable → value). One upstream fall-through is NOT reproduced: `set_preempt(False)`
 *    reaches `command_builder` with `value=False`, which in Python takes the deprecated
 *    `elif value:` → `return 'no %s'` path (`abstract.py:155-161`) — a falsy fall-through this client
 *    refuses (row 73). {@link VrrpResource.setPreempt} maps `value: false` to `{ mode: 'no' }` before
 *    composing, so test_api_vrrp.py:556's pinned text `no vrrp 10 preempt` stays verbatim.
 *    `setEnable` never used `command_builder` upstream in the first place (`:461-503` composes four
 *    strings by hand) and keeps that shape.
 * 4. **invalid arguments refuse; upstream crashes in three places and interpolates garbage in two.**
 *    The `set_primary_ip` default/disable arms read the CURRENT primary ip back through
 *    `self.get(name)` then `vrrps[vrid]['primary_ip']` (`:528-529`, `:535-536`) with no guard: on an
 *    interface with no vrrps that is `TypeError: 'NoneType' object is not subscriptable`, and on a vrid
 *    the interface does not have it is a `KeyError` — mid-formula, after the caller already asked to
 *    write. Same unguarded read pairs back `None` when the pair exists but has no primary ip, and
 *    `'%s' % None` then composes the literal command text `no vrrp 10 ip None` for the wire.
 *    {@link currentPrimaryIp} refuses all three shapes with `NotFoundError` naming the pair instead —
 *    a client-side refusal, never a device answer, and pinned by tests. `get('')`/`get(None)` are
 *    upstream `ValueError`s (`:188-190`) and become the framework's `assertInterfaceName` refusal.
 * 5. **numeric guards refuse non-integers where Python coerces.** Upstream's range guards run
 *    `int(value)` inside the condition (`:792`, `:843`, `:927`, `:969`, `:1011` — `int('50')` succeeds,
 *    `int('a')` raises the same ValueError the range test would), and `str(value).isdigit()` for
 *    priority (`:585`). Here the TS parameter type is already `number` and the guard requires
 *    `Number.isInteger(value)` plus upstream's range — a numeric string from JS never silently
 *    coerces, and the refused ranges are upstream's: priority 1-254 (`:585-586`), timers_advertise
 *    1-255 (`:792-794`), mac/`preempt_delay_min`/`preempt_delay_reload`/`delay_reload` 1-3600
 *    (`:843-845`, `:927-929`, `:969-971`, `:1011-1013` — the last three messages SAY "0-3600" while the
 *    code tests `>= 1`; the code wins, quirk preserved and refused), ip_version 2 or 3 (`:674`).
 *    `bfd_ip`/`primary_ip` keep upstream's dotted-quad grammar exactly (`:541`, `:1214`
 *    `^\d+\.\d+\.\d+\.\d+$`) — octet bounds are an IPv4 fact the image cares about, not asserted here
 *    (DR-032).
 * 6. **the read record uses absence for upstream's `None`, keeps its `''` answers, and its quirks.**
 *    Parser `None`s (`primary_ip`, `priority`, `timers_advertise`, `ip_version`, `delay_reload`,
 *    `preempt_delay_min`, `preempt_delay_reload`, `mac_addr_adv_interval`) become absent optional
 *    fields (`vrfs.ts` divergence 3's shape); but the readers that answer `''` keep `''`
 *    (`description` `:308-317`, `bfd_ip` `:337-344` — which answers `None` only when the BARE positive
 *    `vrrp N bfd ip` line exists, kept as `bfdIp: null`), a missing `secondary_ip` answers `[]`
 *    (`:298-306`), and the booleans are never absent (`enable` defaults `True` unless the shutdown/
 *    disabled line votes, `:253-260`; `preempt` defaults `False` unless the positive line votes,
 *    `:292-296`). The `_parse_track` `if amount:` truthiness filter (`:383`) keeps its quirk — a
 *    decrement of `0` parses back WITHOUT the amount, so `vrrp 10 track Foo decrement 0` reads as
 *    `{ name: 'Foo', action: 'decrement' }` — ported as written this round, and paired with the
 *    `vrconf_format`/`set_tracks` round-trip facts the follow-up round pins.
 */

import { ConfigParseError, NotFoundError, NotSupportedError } from '../errors'
import { pythonRepr } from '../internal/wire'
import { ResourceBase } from './base'
import { assertInterfaceName } from './validators'
import type { ConfigSections } from '../config/chunk'
import type { ResourceTable } from './types'

/**
 * The two command families the upstream readers/writers pick from `version_number` (`vrrp.py:253-260`,
 * `:262-270`, `:272-280`, `:282-290`, `:298-306`, `:308-317`, `:345-353`, `:355-363`, `:365-391`,
 * `:461-503`, `:526-551`, `:587-596`, `:628-634`, `:673-680`, `:744-755`, `:795-802`, `:1014-1020`,
 * `:1150-1178`). `modern` is upstream's `>= '4.21.3'` arm (`ipv4`, `session description`,
 * `priority-level`, `advertisement interval`, `tracked-object`, `timers delay reload`, `disabled`);
 * `legacy` is its else arm (`shutdown`, `ip`, `description`, `priority`, `timers advertise`, `track`,
 * `delay reload`). See divergence 1.
 */
type VrrpCommandFamily = 'modern' | 'legacy'

/** The two tracked-object actions upstream accepts (and its write-side verbs re-validate: `:1105`, `:1126`). */
export type VrrpTrackAction = 'decrement' | 'shutdown'

/** One tracked-object entry — upstream's `track` list element (parsed `:374-382`, validated `:1099-1136`). */
export interface VrrpTrack {
  /** The tracked object name, `(\S+)` in both the parser and the command composer (`:367`, `:1148`). */
  readonly name: string
  /** `decrement` or `shutdown` — the only two actions upstream's regexes and validators allow. */
  readonly action: VrrpTrackAction
  /**
   * The decrement amount. Present only when the parsed amount was a truthy integer — upstream's
   * `if amount:` filter (`:383`) drops `0`, and a `shutdown` line has no amount at all.
   */
  readonly amount?: number
}

/**
 * One virtual router as {@link VrrpResource.get} reads it — the fourteen parser merges of
 * `vrrp.py:211-224`, camelCased (MIGRATION.md §5's naming rows). The record carries NO name/vrid field:
 * the identity is the (interface, vrid) PAIR carried by the two table levels, exactly like upstream's
 * nested dicts (`get` keys by `int(vrid)` at `:226`, `getall` by interface at `:246`).
 */
export interface Vrrp {
  /** `false` only when the family's shutdown line is present (`disabled` ≥4.21.3): `:253-260`. */
  readonly enable: boolean
  /** The primary address; absent when the family's positive `ip`/`ipv4` line has no answer (`:262-270`). */
  readonly primaryIp?: string
  /** Absent with no `priority`/`priority-level` line (`:272-280`); `0` is not producible by the guards. */
  readonly priority?: number
  /** Upstream answers `''` (not None) when no positive description line matches — kept verbatim (`:308-317`). */
  readonly description: string
  /** `[]` when no `… secondary` lines match (`:298-306`), in config-line order. */
  readonly secondaryIp: readonly string[]
  /** Absent with no `ip version`/`ipv4 version` line (`:345-353`). */
  readonly ipVersion?: number
  /** Absent with no `timers advertise`/`advertisement interval` line (`:282-290`). */
  readonly timersAdvertise?: number
  /** Absent with no `mac-address advertisement-interval` line — era-independent in upstream (`:319-323`). */
  readonly macAddrAdvInterval?: number
  /** `true` only when the positive `vrrp N preempt` line votes (`:292-296`). */
  readonly preempt: boolean
  /** Absent with no line; `0` parses back as `0` (`:325-329` — the fixture carries zeroes). */
  readonly preemptDelayMin?: number
  /** Absent with no line; `0` parses back as `0` (`:331-335`). */
  readonly preemptDelayReload?: number
  /** Absent with no line (`:355-363`). */
  readonly delayReload?: number
  /** Sorted by `(name, action)` exactly like `sorted(value, key=...)` at `:388`. */
  readonly track: readonly VrrpTrack[]
  /**
   * Upstream's three answers (`:337-344`): `''` when no positive `bfd ip` line matches at all,
   * `null` when the BARE `vrrp N bfd ip` line matches but its address group is empty, and the address
   * string otherwise.
   */
  readonly bfdIp: string | null
}

/** One interface's per-vrid answer table — upstream `get()`'s dict keyed by `int(vrid)` (`:226`). */
export type VrrpVridTable = ReadonlyMap<number, Vrrp>

/** The negation spellings upstream spells as `disable=True` / `default=True` kwargs (DR-037). */
export type VrrpNegation = 'no' | 'default'

/** The dry-run switch every upstream setter carries (`run=True`, e.g. `:461`, `:693`, `:1034`). */
export interface VrrpRunOptions {
  /** False composes (and resolves to) the command WITHOUT sending it — upstream's `run=False` twin. */
  readonly run?: boolean
}

/** Options for the value-taking setters: `{ value }` to set, `{ mode }` to negate, `{ run }` to stage. */
export interface VrrpFieldOptions<T> extends VrrpRunOptions {
  /** The value for the positive arm. Ignored when `mode` is present, exactly as upstream's kwarg order has it. */
  readonly value?: T
  /** `'no'` = upstream's `disable=True` arm, `'default'` = its `default=True` arm. */
  readonly mode?: VrrpNegation
}

/**
 * A `create`-shape attribute bag — upstream's `**kwargs` into `create(interface, vrid, **kwargs)`
 * (`:391`) and thus into `_vrrp_set` (`:1231-1420`). Presence is the trigger: upstream tests
 * `vrconf.get(key, '__NONE__')`; here a field is processed when it is not `undefined` (an explicit
 * `undefined` reads as absent — the nearest honest spelling of "key not in kwargs" once TS types the
 * bag). The sentinel spellings survive verbatim: `'no'` and `null` select upstream's disable arm
 * (`:1248`, `:1261`, `:1273`, `:1286`, `:1305`, `:1322`, `:1353`, `:1369`, `:1385`, `:1404` — and
 * `preempt`'s disable arm additionally lists `False` at `:1341`), `'default'` selects its default arm.
 * The two LIST keys have NO sentinel arms upstream at all — `secondary_ip` reads straight into
 * `set_secondary_ips` (`:1300-:1304`), `track` straight into `set_tracks` (`:1394-:1398`) — so this bag
 * deliberately carries no `'no'`/`'default'` shape for them (§5 row 219).
 */
export interface VrrpAttrs {
  /** Upstream's `enable` kwarg: strict boolean (set_enable raises otherwise, `:490-:492`). */
  readonly enable?: boolean
  readonly primaryIp?: string | VrrpNegation | null
  /** `'no'`/`null`/`'default'` sentinels, or the 1-254 priority when a real number is wanted. */
  readonly priority?: number | VrrpNegation | null
  readonly description?: string | VrrpNegation | null
  /** Replaces the CURRENT secondary set with this list — the diffing verb, see {@link VrrpResource.setSecondaryIps}. */
  readonly secondaryIp?: readonly string[]
  readonly ipVersion?: number | VrrpNegation | null
  readonly timersAdvertise?: number | VrrpNegation | null
  readonly macAddrAdvInterval?: number | VrrpNegation | null
  /** `false` selects upstream's disable arm (`preempt in ('no', False)`, `:1341`). */
  readonly preempt?: boolean | VrrpNegation | null
  readonly preemptDelayMin?: number | VrrpNegation | null
  readonly preemptDelayReload?: number | VrrpNegation | null
  readonly delayReload?: number | VrrpNegation | null
  /** Replaces the CURRENT tracked-object set — the diffing verb, see {@link VrrpResource.setTracks}. */
  readonly track?: readonly VrrpTrack[]
  readonly bfdIp?: string | VrrpNegation | null
}

/**
 * The `vrconf_format` domain (`:1421-1482`): a record that may carry create-shape SENTINELS
 * (`'no'`/`'default'`/`null`) and get-shape values side by side, which the formatter normalizes to the
 * answers {@link VrrpResource.get} would produce after applying the config ("Intended for validating
 * updated vrrp configurations", `:1427-1428`). Upstream indexes every scalar key unguarded
 * (`fixed['primary_ip']` at `:1436` etc.) so a missing key is a `KeyError`; the two list keys are `in`-guarded (`:1445`, `:1472`).
 * Here every key is optional (a missing scalar passes through untouched rather than crashing, and the
 * two list keys keep the guard's meaning). Field names are camelCase twins of upstream's.
 */
export interface VrrpConf {
  /** Passed through untouched upstream — no normalization rule exists for it. */
  readonly enable?: boolean | null
  /** default/no/None become `'0.0.0.0'` — upstream's stated post-apply answer (`:1436-1437`). */
  readonly primaryIp?: string | VrrpNegation | null
  /** → 100 (`:1439-1440`). */
  readonly priority?: number | VrrpNegation | null
  /** → null (`:1442-1443`) — note this is upstream's `None`, WHEREAS the parser's no-line answer is `''`. */
  readonly description?: string | VrrpNegation | null
  /** sorted for comparison, list kept as required (`:1445-1447`). */
  readonly secondaryIp?: readonly string[]
  /** → 2 (`:1449-1450`). */
  readonly ipVersion?: number | VrrpNegation | null
  /** → 1 (`:1452-1453`). */
  readonly timersAdvertise?: number | VrrpNegation | null
  /** → 30 (`:1456-1458`). */
  readonly macAddrAdvInterval?: number | VrrpNegation | null
  /** `'no'`/`'default'` → false — but `null` is NOT in upstream's tuple here (`:1460-1461`), quirk ported. */
  readonly preempt?: boolean | VrrpNegation | null
  /** → 0 (`:1463-1464`). */
  readonly preemptDelayMin?: number | VrrpNegation | null
  /** → 0 (`:1466-1467`). */
  readonly preemptDelayReload?: number | VrrpNegation | null
  /** → 0 (`:1469-1470`). */
  readonly delayReload?: number | VrrpNegation | null
  /** sorted by (name, action) (`:1472-1474`). */
  readonly track?: readonly VrrpTrack[]
  /** → `''` (`:1476-1477`). */
  readonly bfdIp?: string | VrrpNegation | null
}

/** How a rejected argument is described — the `refuse` pattern from `vrfs.ts`/`vlans.ts` (DR-053). */
function refuse(label: string, value: unknown, because: string): never {
  throw new NotSupportedError(`invalid ${label} ${pythonRepr(value)} — ${because}`, { cause: value })
}

/**
 * The dotted-quad grammar upstream itself matches (`re.match(r'^\d+\.\d+\.\d+\.\d+$', …)` at
 * `:541` for primary_ip and `:730`-`:734` for each secondary ip — its `_parse_primary_ip` regexes
 * `:264`/`:267` spell the same shape). Octet bounds (`0..255`) are deliberately NOT asserted: that is
 * the image's business, not this grammar's (DR-032), and upstream never checked it either.
 */
const IPV4_GRAMMAR = /^\d+\.\d+\.\d+\.\d+$/u

/** Upstream's vrid census over an interface block (`:200`), kept exact — including its blind spot. */
const VRRP_VRID_CENSUS = /^\s+(?:no |)vrrp (\d+)/gm

/**
 * `interface …` header lines as the chunker keys them, for {@link VrrpResource.getAll} — the section-key
 * twin of upstream's `re.findall(r'^interface\s(\S+)', self.config, re.M)` (`:242`). A single-token
 * remainder always; a remainder with whitespace is the phantom-name case upstream's `(\S+)` truncates
 * (`interface foo bar` → pyeapi names `foo`) and this client reports instead (divergence 2 of `vrfs.ts`
 * family). Subinterface headers (`interface Ethernet1.100`) ARE candidates here — upstream reads their
 * vrrps too — while the PUBLIC `get`/write guard keeps the framework's dotted-name refusal (DECISIONS
 * open item 7), so a subinterface's vrrps are readable via `getAll` and not addressable by name yet.
 */
const INTERFACE_HEADER = /^interface (.+)$/u

/**
 * Config-text evidence for each command family (divergence 1). Both scan `vrrp <n> <stem>` at any
 * indent, with the `no `/`default ` write-back prefixes allowed, because detection answers "which
 * family does this device spell", not "which commands does pyeapi's parser read". Lines that exist in
 * BOTH families — `bfd ip` (`:337`), `authentication` (never parsed upstream at all),
 * `mac-address advertisement-interval` (`:319`), `preempt`, `preempt delay …` (`:325`, `:331`), `ipv6`
 * — match neither side. `ip(?![-\w])` guards the `ipv4`/`ipv6` false-evidence (`\b` alone would NOT:
 * `ip` is followed by the word-char `v` there, and word chars are exactly what must NOT follow).
 */
const MODERN_EVIDENCE: readonly RegExp[] = [
  /^\s+(?:no |default |)vrrp \d+ ipv4\b/gm,
  /^\s+(?:no |default |)vrrp \d+ session description\b/gm,
  /^\s+(?:no |default |)vrrp \d+ priority-level\b/gm,
  /^\s+(?:no |default |)vrrp \d+ advertisement interval\b/gm,
  /^\s+(?:no |default |)vrrp \d+ tracked-object\b/gm,
  /^\s+(?:no |default |)vrrp \d+ timers delay reload\b/gm,
  /^\s+(?:no |default |)vrrp \d+ disabled\b/gm,
]
const LEGACY_EVIDENCE: readonly RegExp[] = [
  /^\s+(?:no |default |)vrrp \d+ shutdown\b/gm,
  /^\s+(?:no |default |)vrrp \d+ ip(?![-\w])/gm,
  /^\s+(?:no |default |)vrrp \d+ description\b/gm,
  /^\s+(?:no |default |)vrrp \d+ priority(?!-)\b/gm,
  /^\s+(?:no |default |)vrrp \d+ timers advertise\b/gm,
  /^\s+(?:no |default |)vrrp \d+ track\b/gm,
  /^\s+(?:no |default |)vrrp \d+ delay reload\b/gm,
]

/** True when `text` carries at least one match for any pattern (fresh regexes: `lastIndex` is safe). */
function carriesEvidence(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => {
    pattern.lastIndex = 0
    return pattern.test(text)
  })
}

/** Divergence 1's decision function, spelled against upstream's arms: modern-wins, legacy next, else modern. */
function pickFamily(evidence: { modern: boolean; legacy: boolean }): VrrpCommandFamily {
  // Any modern line proves the device accepts the modern keyword (it WROTE it, or accepted it written);
  // a legacy-only config gets the legacy family its own text speaks; silence (no vrrp lines at all, or
  // only era-neutral ones) leaves this repo's floor — EOS 4.28 is ≥ 4.21.3 on upstream's own gate. A
  // device that predates the floor answers ITS OWN CommandError; the device stays authoritative (DR-005).
  if (evidence.modern) return 'modern'
  if (evidence.legacy) return 'legacy'
  return 'modern'
}

/** Upstream's `set_tracks` internal key: `"%s   %s   %s" % (name, action, amount)` with a
 *  `_none_` stand-in (`:1080`, chosen at `:1101`/`:1122`) and the two `tid =` lines (`:1115`, `:1136`), the same
 *  three-space separator; re-extracted by `re.match(r'(\S+)\s+(\S+)\s+(\S+)')` at `:1147`/`:1165`.
 *  The separator is deliberately upstream's, not a fresh encoding — porting the key formula keeps the
 *  set-diffing, and the odd name-with-space round that formula through reproduces upstream's behavior
 *  instead of inventing a different one. */
const TRACK_KEY_UNSET = '_none_'
const trackKey = (name: string, action: string, amount: unknown): string =>
  `${name}   ${action}   ${amount === undefined ? TRACK_KEY_UNSET : String(amount)}`

/** Python `str(x).isdigit()` for the values this module's types allow reaching (`:1107`-`:1109`, `:585`). */
function pythonIsDigit(value: string): boolean {
  return /^\d+$/u.test(value)
}

/**
 * Require a VRID this module can send and read back. Upstream validates NOTHING — it interpolates
 * `vrid` with `"%d"`/`"%s"` (e.g. `"no vrrp %d" % vrid` at `:436`, the enable stems `:482`-`:489`) — and anything not
 * `%d`-formattable raises TypeError mid-verb in Python. The census regex reads back `(\d+)` (`:200`),
 * so a non-negative integer is exactly the grammar the round trip supports; a metacharacter-free
 * id is also what keeps the per-vrid patterns this module builds honest (cf. vrfs divergence 6's
 * same hazard). Whether EOS caps the VRID range is a device answer (DR-032) — no bound is asserted.
 */
function assertVrrpId(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    refuse('vrrp id', value, 'expected a non-negative integer VRID — pyeapi interpolates it with "%d" ("no vrrp %d" at vrrp.py:436) and its census re-reads (\\d+) at vrrp.py:200, so nothing else round-trips; the image\'s real bound is a device answer (DR-032)')
  }
}

/** Require a dotted-quad where upstream `re.match`es one (`:541`, `:730-:734`, `:1214`). */
function assertVrrpAddress(label: string, value: unknown): asserts value is string {
  if (typeof value !== 'string') refuse(label, value, `expected a dotted-quad IPv4 string — pyeapi raises ValueError on non-matching values (vrrp.py:541, :1214) and per-element on every list entry (:730-:734)`)
  if (!IPV4_GRAMMAR.test(value)) refuse(label, value, `a vrrp ${label} must match ${IPV4_GRAMMAR.source} exactly (${pythonRepr(value)} does not — vrrp.py:543 for primary_ip, :728 for secondary_ip, :1214 for bfd_ip; octet bounds belong to the image, DR-032)`)
}

/** Require an integer inside an upstream range; the message carries upstream's own wording and the value. */
function assertIntRange(label: string, value: unknown, min: number, max: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    refuse(label, value, `vrrp property '${label}' must be an integer in the range ${min}-${max}${min === 1 && max === 254 ? '' : ` (pyeapi tests int(value) against ${min}/${max} at its own guard)`}`)
  }
}

/**
 * `node.vrrp` — the VRRP virtual routers configured on one switch, keyed (interface, vrid).
 *
 * Upstream's `Vrrp(EntityCollection)` (`:167`) keeps its dict shapes and this client keeps theirs too:
 * {@link VrrpResource.getAll} is `{ interface: { vrid: data } }` and {@link VrrpResource.get} is
 * `{ vrid: data }` — the two shapes its module docstring documents at `:74-99`, as `Map`s (row 78).
 */
export class VrrpResource extends ResourceBase {
  /**
   * Latched answer for the command family used by WRITES (divergence 1; the `vrfs.ts` DR-099 precedent
   * in `resolveVrfForm`): the family a device's config text speaks does not change mid-session, the
   * whole-config scan runs at most once, and a form-dependent write costs no extra round trip after the
   * config memo has been filled. READS deliberately do NOT use the latch — they pick the family from the
   * interface block they are about to parse, so a read is never betrayed by a stale latch.
   */
  private writeFamilyCache: VrrpCommandFamily | undefined

  /** The whole running-config, scanned once per process lifetime for the write family (divergence 1). */
  private async writeFamily(): Promise<VrrpCommandFamily> {
    if (this.writeFamilyCache !== undefined) return this.writeFamilyCache
    const text = await this.config()
    this.writeFamilyCache = pickFamily({
      modern: carriesEvidence(text, MODERN_EVIDENCE),
      legacy: carriesEvidence(text, LEGACY_EVIDENCE),
    })
    return this.writeFamilyCache
  }

  private async modern(): Promise<boolean> {
    return (await this.writeFamily()) === 'modern'
  }

  /**
   * One interface's vrrp table from the chunked document, with NO name guard — the internal twin that
   * {@link VrrpResource.getAll} uses so subinterface sections stay readable (INTERFACE_HEADER's note),
   * and that every guarded verb shares once its own guard has run.
   *
   * The exact section-key map lookup is where upstream builds a regex instead: `get_block('interface
   * %s' % interface)` anchors `'^%s$' % parent` (`abstract.py:98`), so a name carrying regex
   * metacharacters *widens* the pattern (the `Ethernet1.100` asking-and-getting-`Ethernet1` hazard the
   * chunk map cannot reproduce). Here the key is the header text verbatim.
   */
  private async vrrpsOf(name: string): Promise<VrrpVridTable | undefined> {
    const sections: ConfigSections = await this.configSections()
    const block = sections.get(`interface ${name}`)
    if (block === undefined) return undefined
    // Census FIRST — upstream returns None when the block carries no vrrp lines at all (`:200-203`),
    // and that short-circuit is what keeps a vrrp-less interface out of getAll (`:245-246`).
    const vrids: string[] = []
    for (const match of block.matchAll(VRRP_VRID_CENSUS)) {
      const vrid = match[1]
      if (vrid !== undefined && !vrids.includes(vrid)) vrids.push(vrid)
    }
    if (vrids.length === 0) return undefined
    const family = pickFamily({
      modern: carriesEvidence(block, MODERN_EVIDENCE),
      legacy: carriesEvidence(block, LEGACY_EVIDENCE),
    })
    const table = new Map<number, Vrrp>()
    for (const vrid of vrids) {
      table.set(Number.parseInt(vrid, 10), parseVrrp(block, vrid, family))
    }
    return table
  }

  /**
   * The vrrp configurations on ONE interface — pyeapi's `get(name)` (`:174-229`), name being the
   * interface. `undefined` for an interface the switch does not have or that has no vrrp lines
   * (`:194-196`, `:201-202`, `:229`; DR-027's None→undefined). Upstream raises `ValueError` for an
   * empty/None name (`:188-190`); the framework's `assertInterfaceName` refuses that (and every other
   * name outside the six kinds, DECISIONS open item 7 included) with `NotSupportedError` before any
   * read happens.
   */
  async get(name: string): Promise<VrrpVridTable | undefined> {
    assertInterfaceName(name)
    return this.vrrpsOf(name)
  }

  /**
   * Every interface's vrrp table — pyeapi's `getall()` (`:231-249`), as the nested `Map` its docstring
   * documents (`:83-99`). The candidate interfaces come from the chunker's indent-0 keys, not upstream's
   * `re.M` sweep of the whole config (`:242`) — the shared rule `vlans`/`vrfs`/`staticroute` divergences
   * 1-3 all pin — and a header whose remainder is not one token raises `ConfigParseError` naming the
   * section instead of truncating to a phantom name upstream's `(\S+)` would key.
   */
  async getAll(): Promise<ResourceTable<string, VrrpVridTable>> {
    const sections = await this.configSections()
    const vrrps = new Map<string, VrrpVridTable>()
    for (const key of sections.keys()) {
      const header = INTERFACE_HEADER.exec(key)
      const iface = header?.[1]
      if (iface === undefined) continue
      if (!/^\S+$/u.test(iface)) {
        throw new ConfigParseError(
          `vrrp: cannot read the interface name in ${pythonRepr(key)} — this client reports the whole header remainder, where pyeapi's getall truncates it to the leading (\\S+) run and keys a phantom name (vrrp.py:242; probe of its own regex on \`interface Ethernet 1\` yields \`Ethernet\`)`,
          { sectionKey: key },
        )
      }
      const table = await this.vrrpsOf(iface)
      if (table !== undefined) vrrps.set(iface, table)
    }
    return vrrps
  }

  /**
   * The current primary address of one (interface, vrid) pair, needed by the `default`/`disable` arms
   * upstream composes around it (`:528-529`, `:535-536`: `vrrps = self.get(name)` then
   * `primary_ip = vrrps[vrid]['primary_ip']`). Upstream guards nothing: no-vrrps-on-the-interface is a
   * `TypeError` on `None[vrid]`, an absent pair a `KeyError`, and a pair without a primary ip reads
   * `None` which `'%s' % None` turns into the literal command `no vrrp 10 ip None`. All three are
   * refusals here (divergence 4) — the client declines rather than crashing or sending garbage.
   */
  private async currentPrimaryIp(name: string, vrid: number): Promise<string> {
    const table = await this.get(name)
    if (table === undefined) {
      throw new NotFoundError(`vrrp: interface ${name} has no vrrp configuration, so vrid ${String(vrid)} has no primary_ip to default or negate — pyeapi raises TypeError here (vrrp.py:528-529/:535-536 index a None get-block)`, { cause: `${name}/${String(vrid)}` })
    }
    const entry = table.get(vrid)
    if (entry === undefined) {
      throw new NotFoundError(`vrrp: no vrid ${String(vrid)} on interface ${name}, so there is no primary_ip to default or negate — pyeapi raises KeyError here (vrrp.py:529/:536)`, { cause: `${name}/${String(vrid)}` })
    }
    if (entry.primaryIp === undefined) {
      throw new NotFoundError(`vrrp: vrid ${String(vrid)} on interface ${name} has no primary_ip, so there is no address to name in the negated or defaulted command — pyeapi composes the literal text 'no vrrp … ip None' for the wire here (%s interpolation of the composed strings at vrrp.py:530-532/:537-539, fed by the None/missing pair read at :529/:536)`, { cause: `${name}/${String(vrid)}` })
    }
    return entry.primaryIp
  }

  /**
   * Stage-and-send core for the diffing verbs: returns the sorted command list it composed, sending it
   * as ONE `interface …` transaction unless `run === false` (upstream's `if run:` +
   * `configure_interface(name, cmds)` vs `return cmds`, `:759-768` and `:1182-1191`).
   */
  private async runCommandList(name: string, cmds: readonly string[], run: boolean): Promise<readonly string[]> {
    if (!run) return cmds
    await this.configureInterface(name, [...cmds])
    return cmds
  }

  /** Stage-and-send core for the single-line setters (`:495-503`'s `if run:` twins throughout). */
  private async runCommand(name: string, cmd: string, run: boolean): Promise<string> {
    if (!run) return cmd
    await this.configureInterface(name, [cmd])
    return cmd
  }

  /**
   * Create — or re-property — one virtual router: `create(interface, vrid, **kwargs)` (`:391-417`);
   * Upstream injects `kwargs['enable'] = False` when the key is absent (`:413-414`), mutating its own
   * kwargs frame; here the default rides a copy so the caller's bag is never written through (row 71).
   * Everything then funnels through {@link VrrpResource.vrrpSet}, composing the per-property commands
   * exactly in `_vrrp_set`'s order and sending them as one `interface …` transaction (`:1415`).
   */
  async create(name: string, vrid: number, attrs: VrrpAttrs = {}): Promise<void> {
    assertInterfaceName(name)
    assertVrrpId(vrid)
    const withEnable: VrrpAttrs = attrs.enable === undefined ? { ...attrs, enable: false } : attrs
    await this.vrrpSet(name, vrid, withEnable)
  }

  /** `no vrrp <vrid>` inside the interface — pyeapi's `delete` (`:418-438`, send at `:437`, text at `:436`). Era-free, like upstream's. */
  async delete(name: string, vrid: number): Promise<void> {
    assertInterfaceName(name)
    assertVrrpId(vrid)
    await this.configureInterface(name, [`no vrrp ${String(vrid)}`])
  }

  /** `default vrrp <vrid>` — pyeapi's `default` (`:439-460`, send at `:459`, text at `:458`; `setDefault` per row 77). */
  async setDefault(name: string, vrid: number): Promise<void> {
    assertInterfaceName(name)
    assertVrrpId(vrid)
    await this.configureInterface(name, [`default vrrp ${String(vrid)}`])
  }

  /**
   * Enable/disable the virtual router WITHOUT the generic builder: upstream composes four command
   * strings by hand (`:480-489`) — the two `if value is False:`/`elif value is True:` arms with the
   * era pair at `:482`/`:484` and `:487`/`:489` — `shutdown`/`no shutdown` in the legacy family, `disabled`/
   * `no disabled` in the modern one — and raises `ValueError` for anything that is not exactly
   * `True`/`False` (`:490-492`; its tests hand it `'a'` and `200` at `test_api_vrrp.py:342-346`).
   * Pinned texts reproduced: `vrrp 10 shutdown` / `no vrrp 10 shutdown` (`:331-339`'s cases).
   */
  async setEnable(name: string, vrid: number, value: boolean, options: VrrpRunOptions = {}): Promise<string> {
    assertInterfaceName(name)
    assertVrrpId(vrid)
    if (typeof value !== 'boolean') {
      refuse('enable', value, "vrrp property 'enable' must be true or false — pyeapi raises ValueError otherwise (vrrp.py:490-492), and its tests pass 'a' and 200 to prove it (test_api_vrrp.py:342-346)")
    }
    const keyword = (await this.modern()) ? 'disabled' : 'shutdown'
    const cmd = value ? `no vrrp ${String(vrid)} ${keyword}` : `vrrp ${String(vrid)} ${keyword}`
    return this.runCommand(name, cmd, options.run !== false)
  }

  /**
   * `vrrp <vrid> ip <address>` / `ipv4` — pyeapi's `set_primary_ip` (`:505-560`). The positive arm
   * grammar-checks the value (`:541-548`); the `default`/`disable` arms go through
   * {@link currentPrimaryIp} to name the CURRENT address in the composed line (`:528-545` — upstream
   * `default=True` wins even with `disable=True` too — the `if default is True:` at `:527` precedes
   * the `elif` at `:534`, and `test_api_vrrp.py:354-359` pins exactly that pair. An omitted `value`
   * with no `mode` used to be upstream's `elif disable is True or value is None:` negation arm
   * (`:534`) — an accident of its default
   * kwarg; this client refuses it (DR-037's "say what you mean": pass `mode: 'no'`).
   */
  async setPrimaryIp(name: string, vrid: number, options: VrrpFieldOptions<string> = {}): Promise<string> {
    assertInterfaceName(name)
    assertVrrpId(vrid)
    const stem = `vrrp ${String(vrid)} ${(await this.modern()) ? 'ipv4' : 'ip'}`
    let cmd: string
    if (options.mode === 'default' || options.mode === 'no') {
      const current = await this.currentPrimaryIp(name, vrid)
      cmd = `${options.mode} ${stem} ${current}`
    } else if (options.value === undefined) {
      refuse('primary_ip', options.value, "an omitted value with no mode is upstream's accidental disable arm (vrrp.py:534 `elif disable is True or value is None:`) — say mode: \"no\" or mode: \"default\" (DR-037)")
    } else {
      assertVrrpAddress('primary_ip', options.value)
      cmd = this.commandBuilder(stem, { value: options.value })
    }
    return this.runCommand(name, cmd, options.run !== false)
  }

  /** `vrrp <vrid> priority <n>` / `priority-level` — `:561-606`; guard 1-254 (`:584-587`), negated arms skip it (`:584`). */
  async setPriority(name: string, vrid: number, options: VrrpFieldOptions<number> = {}): Promise<string> {
    assertInterfaceName(name)
    assertVrrpId(vrid)
    const stem = `vrrp ${String(vrid)} ${(await this.modern()) ? 'priority-level' : 'priority'}`
    const cmd = options.mode === undefined
      ? (assertIntRange('priority', options.value, 1, 254), this.commandBuilder(stem, { value: options.value }))
      : this.commandBuilder(stem, { mode: options.mode })
    return this.runCommand(name, cmd, options.run !== false)
  }

  /**
   * `vrrp <vrid> description <text>` / `session description` — `:607-647`. Upstream runs the value
   * through `command_builder` with no guard of its own (`:614-627`), and an omitted value with no mode
   * falls through to the deprecated `'no %s'` arm (`abstract.py:160-161`) — refused HERE (row 73): an
   * unquoted `description` write without a value would silently negate, and this client's answer to
   * that intention is `mode: 'no'`.
   */
  async setDescription(name: string, vrid: number, options: VrrpFieldOptions<string> = {}): Promise<string> {
    assertInterfaceName(name)
    assertVrrpId(vrid)
    const stem = `vrrp ${String(vrid)} ${(await this.modern()) ? 'session description' : 'description'}`
    if (options.mode === undefined && options.value === undefined) {
      refuse('description', options.value, "no value and no mode — pyeapi sends the deprecated 'no description' through command_builder's falsy fall-through (abstract.py:160-161); pass mode: \"no\" (DR-037)")
    }
    const cmd = this.commandBuilder(stem, options.mode === undefined ? { value: options.value } : { mode: options.mode })
    return this.runCommand(name, cmd, options.run !== false)
  }

  /** `vrrp <vrid> ip version <2|3>` / `ipv4 version` — `:648-692`; guard `value not in (2, 3)` (`:671-672`, raise `:672-673`). */
  async setIpVersion(name: string, vrid: number, options: VrrpFieldOptions<number> = {}): Promise<string> {
    assertInterfaceName(name)
    assertVrrpId(vrid)
    const stem = `vrrp ${String(vrid)} ${(await this.modern()) ? 'ipv4 version' : 'ip version'}`
    if (options.mode === undefined && options.value !== 2 && options.value !== 3) {
      refuse('ip_version', options.value, "vrrp property 'ip_version' must be 2 or 3 — pyeapi tests `(2, 3)` membership at vrrp.py:671")
    }
    const cmd = this.commandBuilder(stem, options.mode === undefined ? { value: options.value as number } : { mode: options.mode })
    return this.runCommand(name, cmd, options.run !== false)
  }

  /**
   * Replace the secondary addresses: upstream's `set_secondary_ips` (`:693-768`), the diffing verb
   * PLAN.md §4 flags. Reads the CURRENT list through `self.get(name)` (`:725-727` — guarded there:
   * `if vrrps and vrid in vrrps`, unlike set_primary_ip's unguarded read), grammar-checks EVERY
   * incoming address (`:730-734`), then composes `no`-lines for `current \ new` and positive lines for
   * `new \ current` (`:736-754`) and sends them alphabetically — `cmds = sorted(cmds)` (`:756`). The
   * set-diffing means duplicates collapse and an empty list removes everything (the docstring's own
   * Notes block). Resolves to the composed command list — a no-op diff composes `[]` and, when
   * run, still sends the `interface …` opener exactly as upstream's empty-list `configure_interface`
   * call does (`:759-763`).
   */
  async setSecondaryIps(name: string, vrid: number, secondaryIps: readonly string[], options: VrrpRunOptions = {}): Promise<readonly string[]> {
    assertInterfaceName(name)
    assertVrrpId(vrid)
    const modern = await this.modern()
    const keyword = modern ? 'ipv4' : 'ip'
    const currentTable = await this.get(name)
    const current = currentTable?.get(vrid)?.secondaryIp ?? []
    for (const ip of secondaryIps) {
      assertVrrpAddress('secondary_ip', ip)
    }
    const wanted = new Set(secondaryIps)
    const have = new Set(current)
    const cmds: string[] = []
    for (const ip of have) {
      if (!wanted.has(ip)) cmds.push(`no vrrp ${String(vrid)} ${keyword} ${ip} secondary`)
    }
    for (const ip of wanted) {
      if (!have.has(ip)) cmds.push(`vrrp ${String(vrid)} ${keyword} ${ip} secondary`)
    }
    const sorted = cmds.sort()
    return this.runCommandList(name, sorted, options.run !== false)
  }

  /** `vrrp <vrid> timers advertise <n>` / `advertisement interval` — `:769-816`; guard 1-255 (`:792-794`). */
  async setTimersAdvertise(name: string, vrid: number, options: VrrpFieldOptions<number> = {}): Promise<string> {
    assertInterfaceName(name)
    assertVrrpId(vrid)
    const stem = `vrrp ${String(vrid)} ${(await this.modern()) ? 'advertisement interval' : 'timers advertise'}`
    const cmd = options.mode === undefined
      ? (assertIntRange('timers_advertise', options.value, 1, 255), this.commandBuilder(stem, { value: options.value }))
      : this.commandBuilder(stem, { mode: options.mode })
    return this.runCommand(name, cmd, options.run !== false)
  }

  /**
   * `vrrp <vrid> mac-address advertisement-interval <n>` — `:817-861`. Era-neutral in upstream (no
   * version gate around its stem at `:834-835`, matching its era-neutral parser at `:319-323`); guard
   * 1-3600 (`:830-833`).
   */
  async setMacAddrAdvInterval(name: string, vrid: number, options: VrrpFieldOptions<number> = {}): Promise<string> {
    assertInterfaceName(name)
    assertVrrpId(vrid)
    const stem = `vrrp ${String(vrid)} mac-address advertisement-interval`
    const cmd = options.mode === undefined
      ? (assertIntRange('mac_addr_adv_interval', options.value, 1, 3600), this.commandBuilder(stem, { value: options.value }))
      : this.commandBuilder(stem, { mode: options.mode })
    return this.runCommand(name, cmd, options.run !== false)
  }

  /**
   * `vrrp <vrid> preempt` — `:862-903`, era-neutral stem (`:890`). The interesting arm is
   * `value: false`: upstream passes it to `command_builder`, whose `elif value:` fall-through composes
   * `no vrrp 10 preempt` (abstract.py:155-161 — the falsy path this client refuses, row 73); here it
   * composes the identical text through `mode: 'no'` instead (divergence 3), and non-booleans still
   * refuse as upstream's ValueError does (`:885-888`).
   */
  async setPreempt(name: string, vrid: number, options: VrrpFieldOptions<boolean> = {}): Promise<string> {
    assertInterfaceName(name)
    assertVrrpId(vrid)
    const stem = `vrrp ${String(vrid)} preempt`
    let cmd: string
    if (options.mode !== undefined) {
      cmd = this.commandBuilder(stem, { mode: options.mode })
    } else if (options.value === true) {
      cmd = this.commandBuilder(stem, { value: true })
    } else if (options.value === false) {
      cmd = this.commandBuilder(stem, { mode: 'no' })
    } else {
      refuse('preempt', options.value, "vrrp property 'preempt' must be true or false unless a mode is given — pyeapi raises ValueError otherwise (vrrp.py:885-888)")
    }
    return this.runCommand(name, cmd, options.run !== false)
  }

  /** `vrrp <vrid> preempt delay minimum <n>` — `:904-945`; era-neutral stem (`:931`; range-guard quirk in divergence 5). */
  async setPreemptDelayMin(name: string, vrid: number, options: VrrpFieldOptions<number> = {}): Promise<string> {
    assertInterfaceName(name)
    assertVrrpId(vrid)
    const stem = `vrrp ${String(vrid)} preempt delay minimum`
    const cmd = options.mode === undefined
      ? (assertIntRange('preempt_delay_min', options.value, 1, 3600), this.commandBuilder(stem, { value: options.value }))
      : this.commandBuilder(stem, { mode: options.mode })
    return this.runCommand(name, cmd, options.run !== false)
  }

  /** `vrrp <vrid> preempt delay reload <n>` — `:946-987`; era-neutral stem (`:973`). */
  async setPreemptDelayReload(name: string, vrid: number, options: VrrpFieldOptions<number> = {}): Promise<string> {
    assertInterfaceName(name)
    assertVrrpId(vrid)
    const stem = `vrrp ${String(vrid)} preempt delay reload`
    const cmd = options.mode === undefined
      ? (assertIntRange('preempt_delay_reload', options.value, 1, 3600), this.commandBuilder(stem, { value: options.value }))
      : this.commandBuilder(stem, { mode: options.mode })
    return this.runCommand(name, cmd, options.run !== false)
  }

  /** `vrrp <vrid> delay reload <n>` / `timers delay reload` — `:988-1033`; guard 1-3600 (`:1011-1013`). */
  async setDelayReload(name: string, vrid: number, options: VrrpFieldOptions<number> = {}): Promise<string> {
    assertInterfaceName(name)
    assertVrrpId(vrid)
    const stem = `vrrp ${String(vrid)} ${(await this.modern()) ? 'timers delay reload' : 'delay reload'}`
    const cmd = options.mode === undefined
      ? (assertIntRange('delay_reload', options.value, 1, 3600), this.commandBuilder(stem, { value: options.value }))
      : this.commandBuilder(stem, { mode: options.mode })
    return this.runCommand(name, cmd, options.run !== false)
  }

  /**
   * Validate one track dict the way upstream validates BOTH sides — incoming specs and
   * freshly parsed current entries: unknown-key refusal (`:1085-:1095`), required
   * name+action (`:1092-:1097`), action ∈ {shutdown, decrement} (`:1105`), `shutdown` carrying an
   * amount is invalid (`:1106`), and an amount must be digit-able (`:1107`-`:1109`, re-checked for
   * current entries at `:1124-:1135`). Upstream compares against the `'`-quoted name list at `:1086`
   * (`'name'`/`'action'`/`'amount'` with quotes) while the unknown-key set difference itself matches
   * the bare keys — an unquoted-key variant exists at `:1093` for the required-key message; the
   * refusals here name bare keys exactly like the upstream VALID-keys message. Returns the diff key.
   */
  private trackDiffKey(track: VrrpTrack, label: string): string {
    if (track === null || typeof track !== 'object' || Array.isArray(track)) {
      refuse(label, track, 'vrrp track entries are objects with name/action/amount keys (vrrp.py:1077-1115)')
    }
    const keys = Object.keys(track)
    const extra = keys.filter((key) => key !== 'name' && key !== 'action' && key !== 'amount')
    if (extra.length > 0) {
      throw new NotSupportedError(`invalid vrrp track entry — unknown key(s) ${extra.map((key) => pythonRepr(key)).join(', ')} — valid keys are name, action and amount (pyeapi raises ValueError with the same list at vrrp.py:1084-1090)`, { cause: track })
    }
    if (!keys.includes('name') || !keys.includes('action')) {
      throw new NotSupportedError(`invalid vrrp track entry ${pythonRepr(track)} — a track definition must contain the name and action keys (vrrp.py:1092-1097)`, { cause: track })
    }
    const name = String(track.name)
    const action = track.action
    const hasAmount = keys.includes('amount')
    // Upstream's `amount = track['amount'] if 'amount' in track else unset` (:1099-1101, :1120-1122): a PRESENT key
    // carries its value into validation, and `None` (this client's nearest twin: `null`/`undefined`)
    // is NOT the `_none_` sentinel — it fails the digit test exactly as `'None'.isdigit()` does upstream.
    const amount = track.amount
    let error = false
    if (action !== 'shutdown' && action !== 'decrement') error = true
    if (action === 'shutdown' && hasAmount) error = true
    const amountText = hasAmount ? String(amount) : TRACK_KEY_UNSET
    if (amountText !== TRACK_KEY_UNSET && !pythonIsDigit(amountText)) error = true
    if (error) {
      throw new NotSupportedError(`invalid vrrp track entry ${pythonRepr(track)} — see the format specification pyeapi points at (vrrp.py:1052-1062's docstring; incoming validation :1103-1114, current-side :1124-1135)`, { cause: track })
    }
    return trackKey(name, String(action), amount)
  }

  /**
   * Replace the tracked objects: upstream's `set_tracks` (`:1034-1191`), the second diffing verb.
   * Same shape as {@link VrrpResource.setSecondaryIps} (guarded current read at `:1074-1076`, entry
   * validation on BOTH sides, intersection-diffing at `:1139-1144`, command re-extraction from the
   * triple at `:1148-1177`, `cmds = sorted(cmds)` at `:1179`) — with the multi-word entries the handoff
   * calls out: the diff keys are name/action/amount triples whose command text ends
   * `track <name> <action> <amount?>` (legacy) / `tracked-object …` (modern), and a missing amount is
   * spelled with no trailing space because upstream rstrips the composed line (`:1161`, `:1177`).
   */
  async setTracks(name: string, vrid: number, tracks: readonly VrrpTrack[], options: VrrpRunOptions = {}): Promise<readonly string[]> {
    assertInterfaceName(name)
    assertVrrpId(vrid)
    const modern = await this.modern()
    const keyword = modern ? 'tracked-object' : 'track'
    const currentTable = await this.get(name)
    const current = currentTable?.get(vrid)?.track ?? []
    const wanted = new Set(tracks.map((track) => this.trackDiffKey(track, 'track entry')))
    const have = new Set(current.map((track) => this.trackDiffKey(track, 'current track entry')))
    const triple = /(\S+)\s+(\S+)\s+(\S+)/u
    const compose = (entryKey: string, negate: boolean): string => {
      // trackKey() ALWAYS emits the three-separator triple this re-extraction mirrors, so the exec
      // cannot miss — upstream guards with `if match:` and skips a non-matching tid (`:1148`/`:1164`),
      // a branch this key formula makes unreachable by construction (the rstrip twins keep texts at :1161/:1177).
      const [, objectName, action, rawAmount] = triple.exec(entryKey) as RegExpExecArray
      const amount = rawAmount === TRACK_KEY_UNSET ? '' : ` ${rawAmount}`
      return `${negate ? 'no ' : ''}vrrp ${vrid} ${keyword} ${objectName} ${action}${amount}`.replace(/\s+$/u, '')
    }
    const cmds: string[] = []
    for (const entryKey of have) {
      if (!wanted.has(entryKey)) cmds.push(compose(entryKey, true))
    }
    for (const entryKey of wanted) {
      if (!have.has(entryKey)) cmds.push(compose(entryKey, false))
    }
    const sorted = cmds.sort()
    return this.runCommandList(name, sorted, options.run !== false)
  }

  /** `vrrp <vrid> bfd ip [<address>]` — `:1192-1230`, era-neutral stem (`:1217`); guard = the dotted quad (`:1213-:1216`). */
  async setBfdIp(name: string, vrid: number, options: VrrpFieldOptions<string> = {}): Promise<string> {
    assertInterfaceName(name)
    assertVrrpId(vrid)
    const stem = `vrrp ${String(vrid)} bfd ip`
    const cmd = options.mode === undefined
      ? (assertVrrpAddress('bfd_ip', options.value), this.commandBuilder(stem, { value: options.value }))
      : this.commandBuilder(stem, { mode: options.mode })
    return this.runCommand(name, cmd, options.run !== false)
  }

  /**
   * `_vrrp_set` (`:1231-1420`) — the property dispatch table that `create` funnels through. The
   * sequence is fixed by upstream and pinned by `test_api_vrrp.py:204-222`: enable, primary_ip,
   * priority, description, ip_version, secondary_ip, timers_advertise, mac_addr_adv_interval, preempt,
   * preempt_delay_min, preempt_delay_reload, delay_reload, track, bfd_ip. Every leg composes through
   * the public setter with `run: false`, the two list legs splice their composed lists in whole
   * (`for cmd in cmds: commands.append(cmd)`, `:1300-1301`/`:1399-1400`), and the whole property set
   * ships in ONE `configure_interface` transaction (`:1415`). Sentinels: `'no'`/`null` → disable,
   * `'default'` → default, and `preempt`'s `false` joins the disable arm (`:1341`).
   */
  private async vrrpSet(name: string, vrid: number, attrs: VrrpAttrs): Promise<void> {
    const commands: string[] = []
    const push = (cmd: string | readonly string[]): void => {
      if (typeof cmd === 'string') commands.push(cmd)
      else commands.push(...cmd)
    }
    const scalar = (field: keyof VrrpAttrs): boolean => attrs[field] !== undefined

    if (scalar('enable')) push(await this.setEnable(name, vrid, attrs.enable as boolean, { run: false }))
    if (scalar('primaryIp')) {
      const value = attrs.primaryIp
      if (value === 'no' || value === null) push(await this.setPrimaryIp(name, vrid, { mode: 'no', run: false }))
      else if (value === 'default') push(await this.setPrimaryIp(name, vrid, { mode: 'default', run: false }))
      else push(await this.setPrimaryIp(name, vrid, { value: value as string, run: false }))
    }
    if (scalar('priority')) {
      const value = attrs.priority
      if (value === 'no' || value === null) push(await this.setPriority(name, vrid, { mode: 'no', run: false }))
      else if (value === 'default') push(await this.setPriority(name, vrid, { mode: 'default', run: false }))
      else push(await this.setPriority(name, vrid, { value: value as number, run: false }))
    }
    if (scalar('description')) {
      const value = attrs.description
      if (value === 'no' || value === null) push(await this.setDescription(name, vrid, { mode: 'no', run: false }))
      else if (value === 'default') push(await this.setDescription(name, vrid, { mode: 'default', run: false }))
      else push(await this.setDescription(name, vrid, { value: value as string, run: false }))
    }
    if (scalar('ipVersion')) {
      const value = attrs.ipVersion
      if (value === 'no' || value === null) push(await this.setIpVersion(name, vrid, { mode: 'no', run: false }))
      else if (value === 'default') push(await this.setIpVersion(name, vrid, { mode: 'default', run: false }))
      else push(await this.setIpVersion(name, vrid, { value: value as number, run: false }))
    }
    if (scalar('secondaryIp')) push(await this.setSecondaryIps(name, vrid, attrs.secondaryIp as readonly string[], { run: false }))
    if (scalar('timersAdvertise')) {
      const value = attrs.timersAdvertise
      if (value === 'no' || value === null) push(await this.setTimersAdvertise(name, vrid, { mode: 'no', run: false }))
      else if (value === 'default') push(await this.setTimersAdvertise(name, vrid, { mode: 'default', run: false }))
      else push(await this.setTimersAdvertise(name, vrid, { value: value as number, run: false }))
    }
    if (scalar('macAddrAdvInterval')) {
      const value = attrs.macAddrAdvInterval
      if (value === 'no' || value === null) push(await this.setMacAddrAdvInterval(name, vrid, { mode: 'no', run: false }))
      else if (value === 'default') push(await this.setMacAddrAdvInterval(name, vrid, { mode: 'default', run: false }))
      else push(await this.setMacAddrAdvInterval(name, vrid, { value: value as number, run: false }))
    }
    if (scalar('preempt')) {
      const value = attrs.preempt
      // Upstream's disable arm lists BOTH `'no'` and `False` here (`preempt in ('no', False)`, :1341).
      if (value === 'no' || value === false || value === null) push(await this.setPreempt(name, vrid, { mode: 'no', run: false }))
      else if (value === 'default') push(await this.setPreempt(name, vrid, { mode: 'default', run: false }))
      else push(await this.setPreempt(name, vrid, { value: value as boolean, run: false }))
    }
    if (scalar('preemptDelayMin')) {
      const value = attrs.preemptDelayMin
      if (value === 'no' || value === null) push(await this.setPreemptDelayMin(name, vrid, { mode: 'no', run: false }))
      else if (value === 'default') push(await this.setPreemptDelayMin(name, vrid, { mode: 'default', run: false }))
      else push(await this.setPreemptDelayMin(name, vrid, { value: value as number, run: false }))
    }
    if (scalar('preemptDelayReload')) {
      const value = attrs.preemptDelayReload
      if (value === 'no' || value === null) push(await this.setPreemptDelayReload(name, vrid, { mode: 'no', run: false }))
      else if (value === 'default') push(await this.setPreemptDelayReload(name, vrid, { mode: 'default', run: false }))
      else push(await this.setPreemptDelayReload(name, vrid, { value: value as number, run: false }))
    }
    if (scalar('delayReload')) {
      const value = attrs.delayReload
      if (value === 'no' || value === null) push(await this.setDelayReload(name, vrid, { mode: 'no', run: false }))
      else if (value === 'default') push(await this.setDelayReload(name, vrid, { mode: 'default', run: false }))
      else push(await this.setDelayReload(name, vrid, { value: value as number, run: false }))
    }
    if (scalar('track')) push(await this.setTracks(name, vrid, attrs.track as readonly VrrpTrack[], { run: false }))
    if (scalar('bfdIp')) {
      const value = attrs.bfdIp
      if (value === 'no' || value === null) push(await this.setBfdIp(name, vrid, { mode: 'no', run: false }))
      else if (value === 'default') push(await this.setBfdIp(name, vrid, { mode: 'default', run: false }))
      else push(await this.setBfdIp(name, vrid, { value: value as string, run: false }))
    }
    await this.configureInterface(name, commands)
  }

  /**
   * `vrconf_format` (`:1421-1482`), named exactly upstream's helper — PLAN.md §4 asks for it as part of
   * this module's surface. It turns a config bag written the way `create` takes it (sentinels and all)
   * into the record shape `get`/`getAll` will answer afterwards: `primaryIp`→`'0.0.0.0'` (`:1436-1437`),
   * `priority`→`100` (`:1439-1440`), `description`→`null` (`:1442-1443`), `secondaryIp` sorted
   * (`:1445-1447`), `ipVersion`→`2` (`:1449-1450`), `timersAdvertise`→`1` (`:1452-1453`),
   * `macAddrAdvInterval`→`30` (`:1456-1458`), `preempt`→`false` (`:1460-1461`), the three delays→`0`
   * (`:1463-1470`), `track` sorted by (name, action) (`:1472-1474`), `bfdIp`→`''` (`:1476-1477`).
   * `enable` is untouched (no rule exists upstream for it) — and note the two upstream inconsistencies
   * kept verbatim: `preempt: null` is NOT normalized (`('no', 'default')` at `:1460` names no None,
   * unlike every other scalar's tuple) and
   * `description` normalizes to `null` while the parser's no-line answer is `''` (divergence 6).
   * A shallow copy of the caller's bag (upstream `fixed = dict(vrconfig)`, `:1433`) — never mutated.
   */
  vrconfFormat(vrconfig: VrrpConf): VrrpConf {
    const fixed: Record<string, unknown> = { ...vrconfig }
    const sentinels = (value: unknown, extraNull: boolean): boolean =>
      value === 'no' || value === 'default' || (extraNull && value === null)
    if (sentinels(fixed['primaryIp'], true)) fixed['primaryIp'] = '0.0.0.0'
    if (sentinels(fixed['priority'], true)) fixed['priority'] = 100
    if (sentinels(fixed['description'], true)) fixed['description'] = null
    const secondaryIp = fixed['secondaryIp']
    if (secondaryIp !== undefined) fixed['secondaryIp'] = [...(secondaryIp as readonly string[])].sort()
    if (sentinels(fixed['ipVersion'], true)) fixed['ipVersion'] = 2
    if (sentinels(fixed['timersAdvertise'], true)) fixed['timersAdvertise'] = 1
    if (sentinels(fixed['macAddrAdvInterval'], true)) fixed['macAddrAdvInterval'] = 30
    // :1460 — `('no', 'default')` only; a None preempt rides through upstream's own filter. Faithful.
    if (sentinels(fixed['preempt'], false)) fixed['preempt'] = false
    if (sentinels(fixed['preemptDelayMin'], true)) fixed['preemptDelayMin'] = 0
    if (sentinels(fixed['preemptDelayReload'], true)) fixed['preemptDelayReload'] = 0
    if (sentinels(fixed['delayReload'], true)) fixed['delayReload'] = 0
    const track = fixed['track']
    if (track !== undefined) {
      fixed['track'] = [...(track as readonly VrrpTrack[])].sort((a, b) => `${a.name}\u0000${a.action}` < `${b.name}\u0000${b.action}` ? -1 : `${a.name}\u0000${a.action}` > `${b.name}\u0000${b.action}` ? 1 : 0)
    }
    if (sentinels(fixed['bfdIp'], true)) fixed['bfdIp'] = ''
    return fixed as VrrpConf
  }
}

/**
 * The fourteen-parser merge of `vrrp.py:253-391` applied to one interface block for one vrid string,
 * `subd.update(…)` at `:211-224` reproduced field-by-field. Patterns are copied from upstream's regex
 * literals with the family arm each reader takes (`%s` filled with the census token): `enable`
 * `:253-260`, `primary_ip` `:262-270`, `priority` `:272-280`, `timers_advertise` `:282-290`,
 * `preempt` `:292-296`, `secondary_ip` `:298-306`, `description` `:308-317`,
 * `mac_addr_adv_interval` `:319-323`, `preempt_delay_min` `:325-329`, `preempt_delay_reload`
 * `:331-335`, `bfd_ip` `:337-344`, `ip_version` `:345-353`, `delay_reload` `:355-363`,
 * `track` `:365-391`.
 */
function parseVrrp(config: string, vrid: string, family: VrrpCommandFamily): Vrrp {
  const modern = family === 'modern'
  const first = (pattern: RegExp): RegExpExecArray | null => pattern.exec(config)
  const line = (body: string): RegExp => new RegExp(`^\\s+vrrp ${vrid} ${body}$`, 'm')

  // enable — `disabled` (modern, :255) vs `shutdown` (legacy, :257); absence votes True (:259-260).
  const enable = first(modern ? line('disabled') : line('shutdown')) === null
  // primary_ip — `ipv4 (quad)` (:264) vs `ip (quad)` (:267); None → absent field (:269-270).
  const primary = first(line((modern ? 'ipv4' : 'ip') + ' (\\d+\\.\\d+\\.\\d+\\.\\d+)'))
  // priority — `priority-level` (:274) vs `priority` (:277), int (:279).
  const priority = first(line(modern ? 'priority-level (\\d+)' : 'priority (\\d+)'))
  // timers_advertise — `advertisement interval` (:284) vs `timers advertise` (:287).
  const timers = first(line(modern ? 'advertisement interval (\\d+)' : 'timers advertise (\\d+)'))
  // preempt — the positive line only votes, :293-296.
  const preempt = first(line('preempt')) !== null
  // secondary_ip — findall of the era's `… secondary` line (:300/:303); [] when none (:305-306).
  const secondary: string[] = []
  for (const match of config.matchAll(new RegExp(`^\\s+vrrp ${vrid} ${(modern ? 'ipv4' : 'ip')} (\\d+\\.\\d+\\.\\d+\\.\\d+) secondary$`, 'gm'))) {
    if (match[1] !== undefined) secondary.push(match[1])
  }
  // description — `session description(.*)` (:310) vs `description(.*)` (:313), lstrip at :316, ''-default :317;
  // upstream answers '' (NOT None) with no line, and its `(.*)` + lstrip pair keeps inner spacing.
  const descriptionMatch = first(line((modern ? 'session description' : 'description') + '(.*)'))
  const description = descriptionMatch !== null ? String(descriptionMatch[1]).replace(/^\s+/u, '') : ''
  // mac_addr_adv_interval — era-neutral (:320-322).
  const mac = first(line('mac-address advertisement-interval (\\d+)'))
  // preempt_delay_min/reload — era-neutral (:326-328, :332-334).
  const preMin = first(line('preempt delay minimum (\\d+)'))
  const preRel = first(line('preempt delay reload (\\d+)'))
  // bfd_ip — the address OR the empty alternative, :338-340; three answers (:341-344): no match → '',
  // bare-line match → group undefined → null, match+address → the string.
  const bfd = first(line('bfd ip(?: (\\d+\\.\\d+\\.\\d+\\.\\d+)|)'))
  // ip_version — `ipv4 version` (:347) vs `ip version` (:350).
  const ipVersion = first(line(modern ? 'ipv4 version (\\d+)' : 'ip version (\\d+)'))
  // delay_reload — `timers delay reload` (:357) vs `delay reload` (:360).
  const delay = first(line(modern ? 'timers delay reload (\\d+)' : 'delay reload (\\d+)'))
  // track — :365-391: the era keyword, the `(?:( \d+$|$))` amount tail (:367/:370), the
  // truthiness-filtered amount (:375/:383) and the (name, action) stable sort (:388).
  const tracks: VrrpTrack[] = []
  for (const match of config.matchAll(new RegExp(`^\\s+vrrp ${vrid} ${(modern ? 'tracked-object' : 'track')} (\\S+) (decrement|shutdown)(?:( \\d+$|$))`, 'gm'))) {
    const objectName = match[1]
    const action = match[2]
    const raw = match[3]
    if (objectName === undefined || action === undefined) continue
    const amount = raw === undefined || raw === '' ? null : Number.parseInt(raw, 10)
    const entry: { name: string; action: VrrpTrackAction; amount?: number } = {
      name: objectName,
      action: action as VrrpTrackAction,
    }
    // `if amount:` (:383) — a parsed 0 rides through as NO amount. Quirk ported verbatim (divergence 6).
    if (amount) entry.amount = amount
    tracks.push(entry)
  }
  tracks.sort((a, b) => {
    const key = (entry: VrrpTrack): string => `${entry.name}\u0000${entry.action}`
    return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0
  })

  const num = (match: RegExpExecArray | null): number | undefined =>
    match !== null && match[1] !== undefined ? Number.parseInt(match[1], 10) : undefined
  const primaryIp = primary?.[1]
  const priorityValue = num(priority)
  const timersValue = num(timers)
  const macValue = num(mac)
  const preMinValue = num(preMin)
  const preRelValue = num(preRel)
  const ipVersionValue = num(ipVersion)
  const delayValue = num(delay)
  // Upstream's None-valued fields become ABSENT fields here (divergence 6); its ''/[]/0/boolean answers
  // stay values, and a parsed 0 (the fixture's `preempt delay minimum 0` lines) stays the number 0.
  return {
    enable,
    ...(primaryIp === undefined ? {} : { primaryIp }),
    ...(priorityValue === undefined ? {} : { priority: priorityValue }),
    description,
    secondaryIp: secondary,
    ...(ipVersionValue === undefined ? {} : { ipVersion: ipVersionValue }),
    ...(timersValue === undefined ? {} : { timersAdvertise: timersValue }),
    ...(macValue === undefined ? {} : { macAddrAdvInterval: macValue }),
    preempt,
    ...(preMinValue === undefined ? {} : { preemptDelayMin: preMinValue }),
    ...(preRelValue === undefined ? {} : { preemptDelayReload: preRelValue }),
    ...(delayValue === undefined ? {} : { delayReload: delayValue }),
    track: tracks,
    bfdIp: bfd === null ? '' : bfd[1] === undefined ? null : bfd[1],
  }
}
