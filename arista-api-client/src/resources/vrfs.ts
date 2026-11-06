/**
 * `vrfs` — the VRF instance/definition resource collection, W2d (#41): `vrf instance <name>` /
 * `vrf definition <name>` sections read from the running-config, the per-VRF `rd` / `description` /
 * routing-flag writes, and the interface-VRF binding, built on the M7 (#9) framework exactly like
 * `vlans.ts` (DR-026 memo, `commandBuilder` / `submodeCommands`, `valueAfterKeyword` (config-block.ts →
 * `config/text.ts`), and the registry row that replaces pyeapi's `node.api('vrfs')` autoload (DR-006).
 *
 * Port of `pyeapi/api/vrfs.py` (344 lines, BSD-3-Clause, Arista Networks — DR-001). Every `pyeapi` ref
 * below was re-opened in the pinned clone `/home/svaj/development/arista/pyeapi`
 * (1.0.4-rc0, `develop` @ `6816d9e`) on 2026-11-05 and says what the code **does** — nothing here cites
 * EOS image internals, and nothing claims what the DCS-7050TX-64 accepts: unit tests never reach a
 * device, so every EOS-side question reads "unverified on hardware, M12 (#14) to capture". VRF-routing
 * licensing on this SKU is itself DECISIONS.md open item 2.
 *
 * | pyeapi (verified refs) | here |
 * |---|---|
 * | `Vrfs(EntityCollection)` (`:59`) | {@link VrfsResource} extends `EntityCollection<Vrf, string, VrfAttrs>` (`base.ts`) |
 * | `get` (`:67-99`): `version_number >= '4.23'` picks `'vrf instance %s'` else `'vrf definition %s'` (`:79-82`), `if not config: return None` (`:83-84`), `dict(vrf_name=value)` + the two `_parse_*` merges (`:85-87`), then the two routing-flag `get_block`s (`:88-97`) | {@link VrfsResource.getAll} / {@link VrfsResource.get}: the read accepts **either** keyword with no version ask at all (divergence 1), `undefined` for an absent VRF (DR-027), and typed optional fields where upstream's parsers crash or invent (divergences 3/4) |
 * | `version_number` (`:79`, `:142`, `:169`, `:186`, `:201`, `:218`, `:323` — seven call sites), resolved as **`pyeapi/client.py:544-548/566-568`**'s string scraped (or memoised) from `show version` and compared with `>= '4.23'` **character-wise** — so `'4.9' >= '4.23'` is `True` although 4.9 predates 4.23 | {@link resolveVrfForm} — one scan of the device's **own config text** for which `vrf` keyword its sections actually use, defaulting to `instance` when the text is silent (divergence 1, DR-099); no `show version` is consulted and no capability probe is called (that is M11's surface, and calling it from a read verb would add round trips the config memo already makes unnecessary) |
 * | `getall` (`:135-150`): `re.compile(r'(?<=^vrf instance\s)(\w+)', re.M)` / `definition` sibling (`:141-147`) over the whole config, `response[vrf] = self.get(vrf)` per hit (`:149-150`) — up to N re-reads with a `section()` key scan each | {@link VrfsResource.getAll} — one pass over the chunked document's indent-0 keys (DR-030, pinned by a request-count assertion) and a table lookup per `get` |
 * | `create` (`:152-175`): `['vrf instance %s']` / `['vrf definition %s']` (`:169-172`) + `if rd: commands.append('rd %s')` (`:173-174`) | {@link VrfsResource.create} with `VrfAttrs { rd? }` — the same command texts inside the same transaction |
 * | `delete` (`:177-190`, `no vrf instance %s`/`no vrf definition %s` at `:187`/`:189`) / `default` (`:192-205`, `default vrf instance %s`/`default vrf definition %s` at `:202`/`:204`) | {@link VrfsResource.delete} / {@link VrfsResource.setDefault} — same texts, throws instead of returning `False` (DR-005) |
 * | `configure_vrf` (`:207-223`): `make_iterable` + `commands.insert(0, 'vrf … %s')` (`:217-221`, insert at `:219`/`:221`) | private {@link configureVrf} over {@link submodeCommands} — never mutates the caller's list (row 71) |
 * | `set_rd` (`:225-243`), `set_description` (`:245-260`): `command_builder('rd', value=rd)` (`:242`) / `command_builder('description', …)` (`:258-259`) into `configure_vrf` | {@link VrfsResource.setVrfRd} / {@link setVrfDescription} / {@link unsetVrfDescription} / {@link defaultVrfDescription} — `default=`/`disable=` become the mode table (DR-037) |
 * | `set_ipv4_routing` (`:262-281`) / `set_ipv6_routing` (`:283-303`): top-level `ip routing vrf %s` (`:275`) / `ipv6 unicast-routing vrf %s` (`:297`) with the `default`/`no` prefixes (`:276-279` / `:298-301`) — **not** routed through `configure_vrf` | {@link setIpv4Routing} / {@link unsetIpv4Routing} / {@link defaultIpv4Routing} and the IPv6 trio — `commandBuilder` on the composed stem, same one-line transactions, submode never entered |
 * | `set_interface` (`:305-330`): `['interface %s']` (`:322`) + `command_builder('vrf' if ≥4.23 else 'vrf forwarding', …)` (`:323-328`), `configure` at `:329` | {@link setInterface} / {@link unsetInterface} / {@link defaultInterface} — same pair of command texts, keyword from the same detected form (divergence 8) |
 * | `instance(node)` (`:332-344`) | the `RESOURCE_FACTORIES.vrfs` row plus `Node.vrfs` (DR-006/DR-052) |
 *
 * Upstream's own suite is `pyeapi/test/unit/test_api_vrfs.py` — **10** test methods (verified in the pinned
 * clone on 2026-11-05): `test_get` (`:51-60`), `test_get_not_configured` (`:61-62`), `test_getall`
 * (`:64-67`), `test_vrf_functions` (`:69-79`), `test_vrf_create_with_rd` (`:81-86`), `test_set_rd`
 * (`:88-93`), `test_set_description` (`:95-111`), `test_set_ipv4_routing` (`:113-127`),
 * `test_set_ipv6_routing` (`:129-143`), `test_set_interface` (`:145-163`). Their fake node pins
 * `version_number = '4.17.1.1'`
 * (`test/lib/testlib.py:75`), so every one of their `vrf` command texts is the **definition** arm —
 * reproduced verbatim here under a config whose text uses `vrf definition` sections, and the
 * `instance` arm is pinned against a config that uses `vrf instance`. The `instance` arm is
 * unexercised upstream: its suite can never produce it (a 4.17 fake version string), which is exactly
 * the signal the config-text rule replaces.
 *
 * ## Divergences this file owns (rows 175-177 are the orchestrator's; under-filled rows are declared skips)
 *
 * 1. **the keyword comes from the device's own config text, not from a version string compare.**
 *    Upstream gates seven verbs on `self.version_number >= '4.23'` (`:79`, `:142`, `:169`, `:186`,
 *    `:201`, `:218`, `:323`) — a lexicographic compare of whatever `show version` printed, the same bug
 *    class DR-078 records for `interfaces.set_vrf`: `'4.9' >= '4.23'` is true character-wise. Here
 *    {@link resolveVrfForm} looks at which keyword the device's **sections actually use**: any
 *    `vrf instance` header → `instance` (the device demonstrably speaks the newer keyword); only
 *    `vrf definition` headers → `definition`; **no VRF sections at all** → `instance`, this repo's floor
 *    (EOS 4.28 per AGENTS.md and upstream's own ≥4.23 arm) held as a client convention, not a platform
 *    claim — a device that predates the keyword answers its own `CommandError` and the caller sees
 *    `failedCommand` (DR-005). Reads need no form at all: {@link VrfsResource.getAll} accepts both
 *    keywords and records which one the **entry** used ({@link Vrf.definitionForm}), so a mixed config —
 *    an upgraded box keeping `vrf definition` sections while new VRFs get `vrf instance` — is read
 *    truthfully even though writes follow the dominant form. DR-099 records this, including why M11's
 *    capability surface is deliberately NOT consulted from here (a probe is extra round trips and a
 *    throwaway config session; the config text every read already needed carries the same evidence), and
 *    flags the drift question against `interfaces.setVrf`, whose keyword stays version-floored per
 *    DR-078 until M12 (#14) captures which signal the v4 image actually keys on.
 * 2. **no phantom VRFs, and a name the grammar cannot read is reported.** Upstream's two `getall`
 *    regexes (`:142-146`) run over the whole config text with `re.M`, so a column-0 line inside a
 *    `banner` body that reads `vrf instance ghost` is a VRF, and a header of `vrf definition foo bar`
 *    yields key `'foo'` with the `' bar'` silently truncated (`(\w+)`, `:142-146`). Here the section keys
 *    are the source, so banner bodies and indented copies cannot vote (same rule as `vlans.ts`
 *    divergence 3), and a header remainder that is not one `\w`-only token is a {@link ConfigParseError}
 *    naming the section rather than a truncated phantom. `docs/features.md` and upstream's docstring
 *    ("any consecutive sequence of numbers, letters and underscore", `:41-43`) describe the name
 *    grammar; the max length is not asserted anywhere in this port — pyeapi asserts nothing either, and
 *    a length the image enforces is a device answer (DR-032).
 * 3. **`rd` absent is absent, not `rd: None`.** `_parse_rd` (`:101-118`) on no match sets `value = match`
 *    which is `None`, so the record carries `rd=None` — and because `RD_RE` is `(?:\srd\s)(?P<value>.*)$`
 *    (`:55`, unanchored, the leading `\s` matching any whitespace **inside** any line), a body line of
 *    `description has rd inside` answers `rd='inside'` for that VRF. Both are not ported: the read uses
 *    the keyword-anchored body-line extractor (`valueAfterKeyword`), so `rd` is present only when a body
 *    **command line starts with** `rd` + a word boundary, an absent rd is simply absent, and a description
 *    can never invent one. (Write side: {@link assertVrfRd} refuses what the reader could not read back;
 *    the shape note in pyeapi's docstring — "admin_ID:local_assignment", `:158-164` — is quoted, not
 *    enforced, because the image is the authority on rd values, DR-032.)
 * 4. **a missing `description` line is a field answer, not a crash, and negation is absence.**
 *    `_parse_description` (`:120-133`) calls `DESCRIPTION_RE.search(config).group('value')`
 *    unconditionally, so a block with no `description` text **anywhere** raises `AttributeError` on
 *    `None.group` — and `getall` (`:149-150`) funnels that through `get`, so ONE such VRF raises for the
 *    whole collection. Worse, `DESCRIPTION_RE` (`:56`) is `(?:description\s)(?P<value>.*)$`: for the
 *    pinned fixture's `no description` block the `\s` swallows the line break and value matches empty, so
 *    upstream's own test (`test_api_vrfs.py:58-59` pin `description=''` for its
 *    `vrf definition test` block of `rd 200:500` + `no description`)
 *    pins `description=''` for a negated description. Here: the keyword-anchored reader skips `no
 *    description` (it is not a `description …` command line) and skips a bare `description` line, so the
 *    field is **absent** in both cases — the `unsetVrfDescription`/device-default shape (DR-029's "absence
 *    is not a state" family). `''` as a settable value is also refused by {@link assertVrfDescription}
 *    (clear it with `unsetVrfDescription`).
 * 5. **routing flags read from the exact negation line, same as upstream.** Upstream's check is
 *    `get_block('no ip routing vrf %s')` truthy → `False` else `True` (`:92-99`); this port asks the
 *    chunked document whether the exact indent-0 key `no ip routing vrf <name>` (resp.
 *    `no ipv6 unicast-routing vrf <name>`) exists. One consequence of the shared chunker is faithful
 *    upstream shape — those `no …` lines are childless indent-0 lines and the chunker keys every such
 *    line (`config/chunk.ts`, `key = lineRs; sections.set(key, line)`) — and one difference too: keys are exact, so a name cannot be
 *    smuggled by regex widening (the parent-is-a-pattern hazard at `config/section.ts:88-96` row 39)
 *    because {@link assertVrfName} keeps every name it interpolates into `\w+`. A positive line
 *    (`ip routing vrf <name>`) remains irrelevant to the flag exactly as it is upstream. Whether the
 *    image ever omits both lines for a VRF (leaving `True`, upstream's other answer) is unverified on
 *    hardware, M12 (#14).
 * 6. **input guards where upstream has none.** Nothing upstream validates a vrf name
 *    (`create`/`delete`/`default`/`configure_vrf`/`set_interface` interpolate the arms at `:170`/`:172`,
 *    `:187`/`:189`, `:202`/`:204`, `:219`/`:221`, `:324`/`:327`), an rd (`:174`, `:242`), or a description
 *    (`:258`). {@link assertVrfName}, {@link assertVrfRd}
 *    and {@link assertVrfDescription} refuse names outside the `\w+` grammar the reader itself uses
 *    (which also keeps the name regex-metacharacter-free for the section-key lookups), and refuse values
 *    with whitespace/control characters the reader would drop — the same round-trip contract as
 *    `vlans.ts`'s guards (DR-053's pattern; `NotSupportedError`, no new error class, DR-005/DR-010).
 *    The guards run **before** any form detection or read, so a rejected argument costs zero round trips
 *    (pinned with `transport.sent()).toEqual([])`).
 * 7. **`setDefault` is the verb name.** Upstream's presence-default is `default(vrf_name)`
 *    (`:192-205`); the framework renames it `setDefault` (`base.ts` verb rule, row 77) and the pin below
 *    keeps the exact command text.
 * 8. **the interface arm follows the same detected keyword.** Upstream's `set_interface` picks
 *    `'vrf'` above `'vrf forwarding'` below the same broken string compare (`:323-329`). Here the token
 *    comes from the same {@link resolveVrfForm} answer (`instance` ⇒ `vrf <name>`, `definition` ⇒ `vrf
 *    forwarding <name>`), so one device's config text drives both its section writes and its interface
 *    bindings consistently. `interfaces.setVrf` keeps its own DR-078 version-floor until a capture ties
 *    the two signals together — the drift case (a pre-4.23… no VRFs yet… device) is called out in
 *    DR-099 rather than silently harmonised. Upstream also validates no interface name here at all; the
 *    port routes through `configureInterface`, so `assertInterfaceName` applies (the same boundary the
 *    M10a module pins, and DECISIONS open item 7 keeps subinterface/slot forms refused until M12).
 * 9. **`setIpv4Routing`/`setIpv6Routing` do not enter any VRF submode and do not create one.** Upstream
 *    composes a single top-level line and calls `self.configure` directly (the composed arms at
 *    `:275-281` and `:297-303`; its tests pin exactly `ip routing vrf blah` as one bare command,
 *    `test_api_vrfs.py:117`/`:121`/`:125`), contrasting with `set_rd`/`set_description` which wrap in
 *    `configure_vrf` (`:242`, `:258-259`). That
 *    split is preserved — and so is upstream's no-existence-check posture (divergence-12 of `vlans.ts`
 *    in spirit): a flag write to an absent VRF sends the line and the device decides.
 */

import { ConfigParseError, NotSupportedError } from '../errors'
import { pythonRepr } from '../internal/wire'
import { parseBlock } from '../config/text'
import { valueAfterKeyword } from './config-block'
import { EntityCollection } from './base'
import { submodeCommands } from './command-builder'
import type { ConfigSections } from '../config/chunk'
import type { CommandInput } from './types'
import type { ResourceTable } from './types'

/**
 * Which `vrf` header keyword a device's config text speaks. pyeapi chooses it from
 * `version_number >= '4.23'` (`vrfs.py:79` etc., a string compare); this client reads it back off the
 * device (divergence 1, DR-099). The two spellings are exactly upstream's two arms (`vrfs.py:80-83`).
 */
export type VrfDefinitionForm = 'instance' | 'definition'

/**
 * A `vrf instance`/`vrf definition` header line. The name is NOT baked into the pattern: the remainder
 * after the keyword rides along verbatim so a header like `vrf definition foo bar` reaches the
 * {@link ConfigParseError} path below instead of being skipped (divergence 2 — pyeapi would key the
 * phantom name `'foo'`, `vrfs.py:142-146`). A nameless `vrf configuration session`-style line does not
 * match at all: the keyword needs its own word boundary and at least one separator here.
 */
const VRF_HEADER = /^vrf (instance|definition)\s+(.*)$/u

/** Upstream's `getall` name grammar: `(?<=^vrf instance\s)(\w+)`-style captures (`vrfs:142-146`). */
const VRF_NAME = /^\w+$/u

/** The routing-flag negation lines upstream probes with `get_block` (`vrfs.py:92`, `:96`). */
const NO_IP_ROUTING = (name: string): string => `no ip routing vrf ${name}`
const NO_IPV6_ROUTING = (name: string): string => `no ipv6 unicast-routing vrf ${name}`

/**
 * One VRF as this client reads it. Field parity with upstream's record —
 * `dict(vrf_name=value)` (`vrfs.py:85`) plus `rd` (`:118`), `description` (`:133`), `ipv4_routing`
 * (`:94-95`) and `ipv6_routing` (`:98-99`) — with snake_case → camelCase (MIGRATION.md §5's naming rows)
 * and the two parser quirks replaced by absence (divergences 3/4).
 *
 * `definitionForm` has **no upstream twin**: the keyword the device's header line actually used. It is
 * what makes a mixed-form config readable entry-by-entry while writes follow the dominant form
 * (divergence 1).
 */
export interface Vrf {
  /** The VRF name — upstream's `vrf_name` key (`vrfs.py:85`). */
  readonly name: string
  /** The `rd …` line's value. Absent when the section has none — upstream answers `rd: None` (divergence 3). */
  readonly rd?: string
  /** The `description …` line's value. Absent when the section has none or only `no description` (divergence 4). */
  readonly description?: string
  /** True unless the config carries the exact `no ip routing vrf <name>` line (`vrfs.py:92-95`). */
  readonly ipv4Routing: boolean
  /** True unless the config carries the exact `no ipv6 unicast-routing vrf <name>` line (`vrfs.py:96-99`). */
  readonly ipv6Routing: boolean
  /** The header keyword the device used for this entry's section — no upstream twin (divergence 1). */
  readonly definitionForm: VrfDefinitionForm
}

/**
 * What {@link VrfsResource.create} may configure with the header line. Upstream's `create(self,
 * vrf_name, rd=None)` (`:152`) appends `rd %s` inside the same transaction (`:171-174`); the attrs bag
 * is the framework spelling of that kwarg (`base.ts` `create(name, attrs)`).
 *
 * A type alias, not an interface: `EntityCollection`'s attrs parameter must satisfy `ResourceAttrs`
 * (`types.ts`), which only object type literals satisfy with their implicit index signature (the
 * `VlanAttrs` note in `vlans.ts` records the same compiler fact).
 */
export type VrfAttrs = {
  /** `rd <value>` inside the new VRF's section (the `if rd:` arm, `vrfs.py:172-173`). */
  readonly rd?: string
}

/** How a rejected argument is described — the `refuse` pattern from `validators.ts` (DR-053). */
function refuse(label: string, value: unknown, because: string): never {
  throw new NotSupportedError(`invalid ${label} ${pythonRepr(value)} — ${because}`, { cause: value })
}

/** C0 controls plus DEL, code-unit by code-unit — the same test `vlans.ts`/`system.ts` use. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/**
 * Require a VRF name this client can read back and interpolate safely.
 *
 * Upstream checks nothing (`create` at `:171`, `delete` at `:188`, `configure_vrf` at `:220`,
 * `set_interface` at `:327` all interpolate `vrf_name` verbatim), but its own reader only *names* VRFs
 * matching `(\w+)` (`vrfs.py:142-146`) and its module docstring states the grammar — "any consecutive
 * sequence of numbers, letters and underscore" (`vrfs.py:41-43`). Keeping writes inside that grammar is
 * what closes the two upstream holes this port will not reproduce: `create('foo bar')` followed by
 * `getall()` answering a truncated `'foo'` phantom, and a name containing regex metacharacters silently
 * *widening* the `^%s$` parent pattern the flag lookups build (`config/section.ts`'s row-39 note). Max
 * length is deliberately unbounded: pyeapi asserts none, and the image's real limit is a device answer
 * (DR-032, open item 2's VRF licensing sits above even that).
 */
function assertVrfName(value: unknown): asserts value is string {
  if (typeof value !== 'string') refuse('vrf name', value, 'expected a string VRF name — pyeapi checks nothing and interpolates it (vrfs.py:171, :188, :220)')
  if (!VRF_NAME.test(value)) {
    refuse('vrf name', value, 'a VRF name must be the grammar the reader reuses: one or more of numbers, letters and underscore (pyeapi docstring vrfs.py:41-43; getall captures (\\w+) at vrfs.py:142-146 and TRUNCATES anything else — probe of its own regex on "foo bar" yields the key "foo") — metacharacters would also widen the exact section-key lookups this module makes')
  }
}

/**
 * Require an rd the reader can hand back whole. Upstream validates nothing (`if rd:` truthiness only,
 * `:172`; `set_rd` interpolates at `:242`'s `command_builder('rd', value=rd)`), and its `(\s)rd(\s)(.*)$`
 * reader (`:55`) keeps the whole line remainder. A value with a line boundary is already refused by
 * `commandBuilder` (row 74); inner whitespace would be *read back* whole by the line-remainder reader but
 * could never be re-matched as a single token by any consumer, and a leading/trailing space is lost at
 * rstrip before the keyword extractor ever sees it (`config/text.ts` `describeLine`), so the guard is
 * round-trip-derived like `vlans.ts`'s name guard. The docstring's shape note — "admin_ID:local_assignment"
 * (`vrfs.py:158-164`) — is quoted here, not enforced: which rds the CLI accepts is the device's to answer
 * (DR-032), and pyeapi never checked.
 */
function assertVrfRd(value: unknown): asserts value is string {
  if (typeof value !== 'string') refuse('vrf rd', value, 'expected a string route distinguisher — pyeapi checks only truthiness at vrfs.py:172/:242 and interpolates anything')
  if (value.trim() === '') refuse('vrf rd', value, 'an empty rd is refused — clear the value with unsetVrfRd() (the `no rd` form via command_builder disable, abstract.py:154-155) rather than an empty value (DR-037)')
  if (value !== value.trim()) refuse('vrf rd', value, 'leading or trailing whitespace cannot read back: `rd …` is parsed from the rstripped body line (describeLine, config/text.ts) — pyeapi keeps the raw remainder (vrfs.py:55)')
  if (/\s/u.test(value)) refuse('vrf rd', value, 'an rd with inner whitespace produces a line the writer sends but no consumer can treat as one token — pyeapi interpolates it and its reader re-answers the whole remainder (vrfs.py:55)')
  if (hasControlCharacter(value)) refuse('vrf rd', value, 'a control character would break the config line this client reads back (row 74 again)')
}

/**
 * Require a description the reader can reproduce. Same rule as `vlans.ts`'s `assertVlanName` (which cites
 * upstream's probe answers): the read (`:56`, and here `valueAfterKeyword`) gives the whitespace-run-stripped,
 * `unquote`d remainder of the line, so outer whitespace or a balanced quote pair cannot survive
 * write→read. Upstream's `set_description(value=None)` fall-through sends `no description` (its negation arm is
 * the separate `disable=True`, and `test_api_vrfs.py:105-106` pins `no description` only for that) — here clearing
 * is {@link unsetVrfDescription}, never an empty value (DR-037). Whether EOS quotes longer descriptions is
 * unverified on hardware, M12 (#14). The docstring's implied length bound is again the image's, not a claim.
 */
function assertVrfDescription(value: unknown): asserts value is string {
  if (typeof value !== 'string') refuse('vrf description', value, 'expected a string description — pyeapi interpolates whatever arrives into `description %s` (vrfs.py:258)')
  if (value.trim() === '') refuse('vrf description', value, 'an empty description is refused — clear it with unsetVrfDescription() (the `no description` arm upstream pins at test_api_vrfs.py:105-106) (DR-037)')
  if (value !== value.trim()) refuse('vrf description', value, 'leading or trailing whitespace cannot read back: the value is the rstripped line remainder past the keyword (valueAfterKeyword; pyeapi keeps it verbatim, vrfs.py:56)')
  if (hasControlCharacter(value)) refuse('vrf description', value, 'a control character would break the config line this client reads back (row 74)')
  if (value.includes('"')) refuse('vrf description', value, 'a description containing a quote cannot round-trip through this reader, which unquotes a balanced pair (valueAfterKeyword → unquote, config/text.ts row 49). Legality on EOS is unverified on hardware, M12 (#14) to capture — pyeapi would answer the quotes back verbatim on the remainder (vrfs.py:56)')
}

/** One VRF section's field extraction, keyword-anchored over the block body (divergences 3/4). */
function vrfFieldsOf(sectionText: string): { rd: string | undefined; description: string | undefined } {
  const block = parseBlock(sectionText)
  return {
    rd: valueAfterKeyword(block.body, 'rd'),
    description: valueAfterKeyword(block.body, 'description'),
  }
}

/**
 * Every VRF in a chunked running-config, in one pass with **zero** extra reads (DR-030). Section keys
 * already carry the routing-flag lines, so the flags ride the same document (divergence 5).
 */
function vrfsFromSections(sections: ConfigSections): Map<string, Vrf> {
  const vrfs = new Map<string, Vrf>()
  for (const [key, sectionText] of sections) {
    const header = VRF_HEADER.exec(key)
    const keyword = header?.[1]
    const headerValue = header?.[2]
    if (keyword === undefined || headerValue === undefined) continue
    if (!VRF_NAME.test(headerValue)) {
      throw new ConfigParseError(
        `vrfs: cannot read the VRF name in ${pythonRepr(key)} — this client reports the whole header value, where pyeapi's getall silently truncates it to the leading (\\w+) run and keys a phantom name (api/vrfs.py:142-146; probe of its own regexes on \`foo bar\` yields \`foo\`)`,
        { sectionKey: key },
      )
    }
    const name = headerValue
    const fields = vrfFieldsOf(sectionText)
    const vrf: Vrf = {
      name,
      definitionForm: keyword === 'instance' ? 'instance' : 'definition',
      ipv4Routing: !sections.has(NO_IP_ROUTING(name)),
      ipv6Routing: !sections.has(NO_IPV6_ROUTING(name)),
      ...(fields.rd === undefined ? {} : { rd: fields.rd }),
      ...(fields.description === undefined ? {} : { description: fields.description }),
    }
    vrfs.set(name, vrf)
  }
  return vrfs
}

/**
 * `node.vrfs` — the VRFs configured on one switch.
 *
 * pyeapi's `Vrfs(EntityCollection)` (`vrfs.py:59`) keyed by the VRF name (a `string`), unlike
 * `VlansResource`'s numeric VLAN ids (MIGRATION.md §4: keys are whatever the entity *is*).
 */
export class VrfsResource extends EntityCollection<Vrf, string, VrfAttrs> {
  /**
   * Every VRF, keyed by name — pyeapi's `getall()` (`vrfs.py:135-150`) as a `ResourceTable` (row 78).
   * One `show running-config` for the collection AND for `get`, the flags included: upstream pays a
   * `section()` key scan plus two regex passes per entity and up to N get_block re-scans (`:149-150`,
   * `:92-99`), and — because its parsers run through `get` — one `description`-less VRF section makes the
   * whole call raise `AttributeError` (`_parse_description`, `:131-133`; divergence 4). Neither outcome
   * is reachable here, which `vrfs.test.ts` pins with request counts and both arms — and, where upstream's
   * `get` would answer `None` for a `vrf instance` entry on a device it classed as pre-4.23 (`:79-83`),
   * this table finds the entry regardless of form.
   */
  override async getAll(): Promise<ResourceTable<string, Vrf>> {
    return vrfsFromSections(await this.configSections())
  }

  /**
   * One VRF, or `undefined` — pyeapi's `get(value)` returning `None` for an absent block (`:90-91`,
   * DR-027's kept half). The whole record comes from the same one-read table — including both keyword
   * arms (`get` upstream picks ONE arm from the version compare and misses the other keyword's section
   * entirely, `:79-83`; the table here cannot miss a VRF the switch wrote).
   */
  override async get(name: string): Promise<Vrf | undefined> {
    assertVrfName(name)
    return (await this.getAll()).get(name)
  }

  /**
   * The header keyword this device's config text speaks (divergence 1, DR-099). Runs on the chunked
   * document the reads already use — memoised per `Node` (DR-026) — so a form-dependent write costs no
   * extra round trip after any read, and the first VRF on a fresh device costs exactly the one
   * `show running-config` the config memo had to fetch anyway.
   */
  private detectedForm: VrfDefinitionForm | undefined

  private async resolveVrfForm(): Promise<VrfDefinitionForm> {
    // Latched once per resource instance: the keyword a device's config text speaks does not change
    // mid-session, and a config write clears the DR-026 config memo — without the latch every form-
    // dependent verb after a write would pay a re-read the first detection already answered. The
    // device stays authoritative the same way (its own CommandError on a wrong keyword, DR-005).
    if (this.detectedForm !== undefined) return this.detectedForm
    const sections = await this.configSections()
    let sawDefinition = false
    for (const key of sections.keys()) {
      const header = VRF_HEADER.exec(key)
      if (header?.[1] === 'instance') {
        this.detectedForm = 'instance'
        return this.detectedForm
      }
      if (header?.[1] === 'definition') sawDefinition = true
    }
    // No VRF sections at all: the config text carries no evidence either way. The default is this
    // repo's floor (EOS 4.28 per AGENTS.md; upstream's OWN gate also lands on `instance` at ≥4.23),
    // held as a client convention — a device that predates the keyword refuses with its own
    // CommandError, the device staying authoritative (DR-005/DR-032, DR-099).
    this.detectedForm = sawDefinition ? 'definition' : 'instance'
    return this.detectedForm
  }

  /** The exact section-header command for `name` under the detected form — `vrfs.py:169-171` and twins. */
  private async vrfHeader(name: string): Promise<string> {
    const form = await this.resolveVrfForm()
    return `vrf ${form} ${name}`
  }

  /**
   * `vrf <form> <name>` (+ optional `rd …` inside the same transaction) — pyeapi's `create`
   * (`vrfs.py:152-175`); `test_api_vrfs.py:73` pins `vrf definition testvrf` and `:84` pins
   * `['vrf definition testvrfrd', 'rd 10:10']` verbatim (their definition arm exists only because the
   * fake node pins version `'4.17.1.1'`, `test/lib/testlib.py:75`).
   */
  override async create(name: string, attrs?: VrfAttrs): Promise<void> {
    assertVrfName(name)
    const commands: string[] = [await this.vrfHeader(name)]
    if (attrs?.rd !== undefined && attrs.rd !== '') {
      assertVrfRd(attrs.rd)
      commands.push(`rd ${attrs.rd}`)
    }
    await this.configure(commands)
  }

  /** `no vrf <form> <name>` — pyeapi's `delete` (`vrfs.py:177-190`); pinned text `no vrf definition …`. */
  override async delete(name: string): Promise<void> {
    assertVrfName(name)
    await this.configure(`no ${await this.vrfHeader(name)}`)
  }

  /** `default vrf <form> <name>` — pyeapi's `default` (`vrfs.py:192-205`, renamed per row 77). */
  override async setDefault(name: string): Promise<void> {
    assertVrfName(name)
    await this.configure(`default ${await this.vrfHeader(name)}`)
  }

  /**
   * Enter the VRF's section and configure inside it — pyeapi's `configure_vrf` (`vrfs.py:207-223`),
   * whose `commands.insert(0, …)` (`:220-221`) mutates the caller's list upstream (row 71 — two calls
   * over one list pile up parent lines there; this helper builds a fresh array every time via
   * {@link submodeCommands}). A VRF the switch does not have is still entered: upstream creates it
   * implicitly the way `vlans.configure_vlan` does, and the port stays honest to that — the guard is
   * only the name grammar.
   */
  private async configureVrf(name: string, commands: CommandInput): Promise<void> {
    assertVrfName(name)
    await this.configure(submodeCommands(await this.vrfHeader(name), commands))
  }

  /** `rd <value>` inside the VRF section — pyeapi's `set_rd` (`vrfs.py:225-243`), pinned at `['vrf definition testrdvrf', 'rd 10:10']` (test_api_vrfs.py:88-93, cmds at `:91`). */
  async setVrfRd(name: string, rd: string): Promise<void> {
    assertVrfRd(rd)
    await this.configureVrf(name, [this.commandBuilder('rd', { value: rd })])
  }

  /** `no rd` — the `disable=True` arm of upstream's `command_builder('rd', …)` (`vrfs.py:242` via `abstract.py:154-155`). */
  async unsetVrfRd(name: string): Promise<void> {
    await this.configureVrf(name, [this.commandBuilder('rd', { mode: 'no' })])
  }

  /** `default rd` — the `default=True` arm of the same builder (`vrfs.py:242` via `abstract.py:152-153`). */
  async defaultVrfRd(name: string): Promise<void> {
    await this.configureVrf(name, [this.commandBuilder('rd', { mode: 'default' })])
  }

  /** `description <value>` — pyeapi's `set_description` (`vrfs.py:245-260`), pinned at `['vrf definition …', 'description testing']` (test_api_vrfs.py:95-111, cmds at `:100-101`). */
  async setVrfDescription(name: string, description: string): Promise<void> {
    assertVrfDescription(description)
    await this.configureVrf(name, [this.commandBuilder('description', { value: description })])
  }

  /** `no description` — the `disable=True` kwarg of pyeapi's `command_builder('description', …)` (`vrfs.py:258-259`, negation composed at `abstract.py:154-155`), pinned at test_api_vrfs.py:105-106. */
  async unsetVrfDescription(name: string): Promise<void> {
    await this.configureVrf(name, [this.commandBuilder('description', { mode: 'no' })])
  }

  /** `default description` — the `default=True` kwarg of the same builder (`vrfs.py:258-259` via `abstract.py:152-153`), pinned at test_api_vrfs.py:109-110. */
  async defaultVrfDescription(name: string): Promise<void> {
    await this.configureVrf(name, [this.commandBuilder('description', { mode: 'default' })])
  }

  /** The three-arm top-level composer both routing-flag families share (`vrfs.py:268-281`, `:289-303`). */
  private async routingFlag(stem: string, defaultArm: boolean, disableArm: boolean): Promise<void> {
    const mode = defaultArm ? 'default' : disableArm ? 'no' : 'set'
    await this.configure(this.commandBuilder(stem, mode === 'set' ? { value: true } : { mode }))
  }

  /**
   * Enable VRF-aware IPv4 routing: bare `ip routing vrf <name>` at the TOP level — pyeapi's
   * `set_ipv4_routing(vrf)` (`vrfs.py:262-281`); the submode is never entered (divergence 9), and the
   * positive line's presence is irrelevant to how {@link getAll} computes the flag (divergence 5).
   */
  async setIpv4Routing(name: string): Promise<void> {
    assertVrfName(name)
    await this.routingFlag(`ip routing vrf ${name}`, false, false)
  }

  /** `no ip routing vrf <name>` — upstream's `set_ipv4_routing(…, disable=True)` (`vrfs.py:278-279`, pinned at test_api_vrfs.py:121). Reads back as `ipv4Routing: false` (divergence 5). */
  async unsetIpv4Routing(name: string): Promise<void> {
    assertVrfName(name)
    await this.routingFlag(`ip routing vrf ${name}`, false, true)
  }

  /** `default ip routing vrf <name>` — upstream's `set_ipv4_routing(…, default=True)` (`vrfs.py:276-277`, pinned at test_api_vrfs.py:125). */
  async defaultIpv4Routing(name: string): Promise<void> {
    assertVrfName(name)
    await this.routingFlag(`ip routing vrf ${name}`, true, false)
  }

  /** `ipv6 unicast-routing vrf <name>` — pyeapi's `set_ipv6_routing(vrf)` (`vrfs.py:283-303`). */
  async setIpv6Routing(name: string): Promise<void> {
    assertVrfName(name)
    await this.routingFlag(`ipv6 unicast-routing vrf ${name}`, false, false)
  }

  /** `no ipv6 unicast-routing vrf <name>` — upstream's `set_ipv6_routing(…, disable=True)` (`vrfs.py:300-301`, pinned at test_api_vrfs.py:137; reads back as `ipv6Routing: false`). */
  async unsetIpv6Routing(name: string): Promise<void> {
    assertVrfName(name)
    await this.routingFlag(`ipv6 unicast-routing vrf ${name}`, false, true)
  }

  /** `default ipv6 unicast-routing vrf <name>` — upstream's `set_ipv6_routing(…, default=True)` (`vrfs.py:298-299`, pinned at test_api_vrfs.py:141). */
  async defaultIpv6Routing(name: string): Promise<void> {
    assertVrfName(name)
    await this.routingFlag(`ipv6 unicast-routing vrf ${name}`, true, false)
  }

  /**
   * The arm-selecting core of the interface trio — pyeapi's `set_interface` (`vrfs.py:305-330`). The
   * VRF name is validated only on the set arm: upstream's `disable`/`default` paths discard it without
   * ever looking at it (`abstract.py:152-155` composes the bare negation before interpolation is
   * considered), and this client's negation verbs do not ask for one at all.
   */
  private async bindInterfaceVrf(name: string, vrfName: string | undefined, mode: 'set' | 'no' | 'default'): Promise<void> {
    if (mode === 'set') assertVrfName(vrfName)
    const form = await this.resolveVrfForm()
    const keyword = form === 'instance' ? 'vrf' : 'vrf forwarding'
    const command = mode === 'set'
      ? this.commandBuilder(keyword, { value: vrfName as string })
      : this.commandBuilder(keyword, { mode })
    await this.configureInterface(name, [command])
  }

  /**
   * Bind an interface to a VRF: `vrf <name>` on an instance-form device, `vrf forwarding <name>` on a
   * definition-form device — the exact pair pyeapi splits on the same broken version compare at
   * `vrfs.py:322-329`; its pinned text (`test_api_vrfs.py:145-163`, fake version 4.17) is
   * `interface Ethernet1` + `vrf forwarding <name>`, reproduced here under a definition-form config.
   * `interfaces.setVrf` keeps its DR-078 version-floor until a capture ties the signals (divergence 8).
   */
  async setInterface(name: string, vrfName: string): Promise<void> {
    await this.bindInterfaceVrf(name, vrfName, 'set')
  }

  /** `no vrf` / `no vrf forwarding` — the `disable=True` kwarg at `vrfs.py:323-328` (negation via `abstract.py:154-155`); pinned `no vrf forwarding` at test_api_vrfs.py:155-157. The name never survives upstream's negation either. */
  async unsetInterface(name: string): Promise<void> {
    await this.bindInterfaceVrf(name, undefined, 'no')
  }

  /** `default vrf` / `default vrf forwarding` — the `default=True` kwarg at `vrfs.py:323-328` (`abstract.py:152-153` composes it); pinned at test_api_vrfs.py:160-162. */
  async defaultInterface(name: string): Promise<void> {
    await this.bindInterfaceVrf(name, undefined, 'default')
  }
}
