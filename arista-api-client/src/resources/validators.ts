/**
 * Runtime validators for resource arguments, M7 (#9). DR-004's replacement for upstream's duck-typed
 * guards: pyeapi scatters ad-hoc boolean predicates across the api modules and then returns `False`
 * (or raises a bare `ValueError`) when one fails —
 *
 *  - `isvlan(value)` — `pyeapi/api/vlans.py:63-80`: `int(value)` and `value in range(1, 4095)`, so a
 *    numeric string is accepted (`isvlan('0020')` is `True`), a float is silently truncated
 *    (`isvlan(20.5)` is `True`, verified by running the function), and `isvlan(None)` raises
 *    `TypeError` from `int()` rather than answering `False` (the `except` catches only `ValueError`).
 *    Call sites then convert that to the swallowed failure DR-005 removes:
 *    `return self.configure(command) if isvlan(vid) else False` (`vlans.py:204`, `:216`, `:232`).
 *  - two *different* `isvalidinterface` predicates: `interfaces.py:81-83` matches
 *    `re.match(r'([EPVLM][a-z-C]+)', value)` and requires the match to be one of
 *    `VALID_INTERFACES` (`interfaces.py:71-78` — Ethernet, Management, Loopback, Port-Channel, Vlan,
 *    Vxlan), while `stp.py:346-363` tests `value[0:2] in ['Et', 'Po']`. Both were opened and run
 *    against the real Python 3 `re` on 2026-11-03: the `[a-z-C]` class is accepted by Python 3 (it is
 *    `a-z`, a literal `-`, and `C`), so `Ethernet1` → `Ethernet`, `Port-Channel1` → `Port-Channel`,
 *    `Po1` → `Po` (rejected by the set test) and `Et1` → no match. A bare `Vlan` with no digits passes.
 *
 * Ours: one name per concept, `assert`-shaped, throwing an `EapiError` subclass whose message names the
 * rejected value (`docs/ARCHITECTURE.md` §4). pyeapi's `__getattr__`/`marshall` dispatch
 * (`interfaces.py:117`, `:131`, `acl.py:114`) is not ported at all (DR-006), so these guards are the only
 * validation layer left standing — and the only guard that is not a compile error.
 *
 * These are **input guards, not platform claims**: DR-032/DR-033 keep feature support on the device.
 * MIGRATION.md §5 row 76 records what is stricter here than upstream.
 *
 * ## The interface-name half, M10a (#12)
 *
 * PLAN.md §M10's "validation split" box asks for pyeapi's single `isvalidinterface` regex
 * (`interfaces.py:81-83`) to become *a parser per kind returning a discriminated union*. That parser is
 * {@link parseInterfaceName} below: one anchored pattern per kind, each arm carrying the kind and its
 * numeric index, and only the two kinds upstream allows a `.<n>` suffix on
 * (`interfaces.py:272-277`, and its own fixture section header `interface Ethernet48.2044`,
 * `test/fixtures/running_config.text:1468`) carrying {@link ParsedInterfaceName.subinterface}. A module
 * that needs to know what a name *is* — which kinds can be created, which carry an L2 state, which takes
 * a subinterface encapsulation — switches on `kind` instead of re-reading prefixes, which is the whole
 * point of the split: pyeapi answers the same question with `interface[0:2]` (`interfaces.py:122`), a
 * substring test that silently routes `Vlan1`/`Loopback0`/`Management1` to `BaseInterface`.
 *
 * {@link assertInterfaceName} keeps its **existing** accepts/refuses — it is now "the parser answered,
 * and the name has no subinterface". That is deliberate rather than convenient: what a 7050TX-64 /
 * 4.28.13.1M actually writes for a subinterface, a slot/chassis number or a `Peer-Ethernet` endpoint is
 * DECISIONS.md open item 7, whose own words are "refused here rather than guessed", and M9's
 * `switchports.test.ts:405` and `validators.test.ts:100-120` pin today's boundary. Widening is a capture
 * question (M12 #14), not a parser question; `interfaces.ts` states what is still owed where those pins
 * are recorded.
 */

import { NotSupportedError } from '../errors'
import { pythonRepr } from '../internal/wire'

/** The EOS VLAN id range — pyeapi `range(1, 4095)` (`vlans.py:78`), and the EOS-wide limit in MIGRATION.md §4. */
const VLAN_ID_MIN = 1
const VLAN_ID_MAX = 4094

/**
 * The interface kinds pyeapi's own predicate accepts (`interfaces.py:71-78`). Deliberately **not**
 * extended here: `Mlag`, `Switch`-style or `Peer-Ethernet` names are wave-2/3 questions, and inventing a
 * kind is exactly the "do not invent eAPI commands" rule this repo follows.
 *
 * The order is load-bearing: it is what {@link assertInterfaceName}'s refusal message lists, and
 * `validators.test.ts:100` pins that spelling.
 */
export const INTERFACE_KINDS: readonly InterfaceKind[] = [
  'Ethernet',
  'Management',
  'Loopback',
  'Port-Channel',
  'Vlan',
  'Vxlan',
]

/**
 * The kinds {@link parseInterfaceName} reads: the six names in {@link INTERFACE_KINDS}.
 *
 * `Vxlan` is included because `VALID_INTERFACES` lists it (`interfaces.py:71-78`) and
 * `validators.test.ts:96` already accepts `Vxlan1` — reading a `Vxlan1` section is not the same claim as
 * configuring VXLAN, whose hardware capability on this SKU is unverified and whose module is deferred to
 * wave 3 by PLAN.md §M10 (M10d).
 */
export type InterfaceKind = 'Ethernet' | 'Management' | 'Loopback' | 'Port-Channel' | 'Vlan' | 'Vxlan'

/**
 * A parsed `<kind><index>` name. The `{ subinterface?: undefined }` arm marker is what lets a consumer
 * read `parsed.subinterface` off the union without a cast — the plain kinds genuinely have no such part.
 */
export interface PlainInterfaceName<K extends InterfaceKind> {
  /** Which kind's pattern read the name — the discriminator every per-kind rule switches on. */
  readonly kind: K
  /**
   * The decimal the name carries, as a number: `Ethernet12` → `12`, `Ethernet01` → `1`. A leading zero is
   * preserved in {@link ParsedInterfaceName.name}, which is what a section key or a command text needs,
   * and dropped here, which is what arithmetic needs.
   */
  readonly index: number
  /** The name exactly as it was handed in — this parser does not normalise spelling or case. */
  readonly name: string
  readonly subinterface?: undefined
}

/** A parsed name for a kind that may carry a `.<n>` subinterface suffix (Ethernet, Port-Channel). */
export interface SubinterfaceCapableInterfaceName<K extends InterfaceKind> extends PlainInterfaceName<K> {
  /**
   * The decimal after the dot (`Ethernet1.100` → `100`), or `undefined` for the plain form. Only these two
   * kinds have that form anywhere in pyeapi: `set_encapsulation` demands a `.` and an `Et`/`Po` prefix
   * (`interfaces.py:272-277`) and `EthernetInterface.create` names the subinterface form in its docstring
   * (`:415-425`, "Ex: Ethernet1.1"). Whether a VLAN or Loopback can carry one on this unit is open item 7,
   * so the grammar says `false` for those kinds rather than answering the question.
   */
  readonly subinterface: number | undefined
}

/** @see SubinterfaceCapableInterfaceName */
export type EthernetInterfaceName = SubinterfaceCapableInterfaceName<'Ethernet'>
/** @see SubinterfaceCapableInterfaceName */
export type PortChannelInterfaceName = SubinterfaceCapableInterfaceName<'Port-Channel'>
/** @see PlainInterfaceName */
export type ManagementInterfaceName = PlainInterfaceName<'Management'>
/** @see PlainInterfaceName */
export type LoopbackInterfaceName = PlainInterfaceName<'Loopback'>
/** @see PlainInterfaceName */
export type VlanInterfaceName = PlainInterfaceName<'Vlan'>
/** @see PlainInterfaceName */
export type VxlanInterfaceName = PlainInterfaceName<'Vxlan'>

/**
 * What {@link parseInterfaceName} answers for a name it could read: one arm per kind, so a per-kind rule
 * narrows by `kind` instead of re-testing prefixes.
 */
export type ParsedInterfaceName =
  | EthernetInterfaceName
  | PortChannelInterfaceName
  | ManagementInterfaceName
  | LoopbackInterfaceName
  | VlanInterfaceName
  | VxlanInterfaceName

/** One row of the grammar table: the pattern plus the arm it builds. */
interface InterfaceGrammar {
  readonly pattern: RegExp
  readonly read: (name: string, index: number, subinterface: number | undefined) => ParsedInterfaceName | undefined
}

/**
 * The grammar, one fully-anchored pattern per kind.
 *
 * Per kind rather than one `^(?:A|B|C)[0-9]+$` alternation (what M7 shipped) because the *suffix* differs
 * per kind and an alternation cannot express that without a follow-up test: `Ethernet`/`Port-Channel` may
 * carry `.\d+`, the other four may not. Fully anchored, unlike upstream's unanchored `re.match`
 * (`interfaces.py:82`) — `Ethernet1 mode on`, a command line that wandered into a name position, is refused
 * rather than read as the `Ethernet` kind (row 76). `[0-9]` and not `\d`: `\d` would do the same thing
 * here, and the explicit class keeps the grammar readable next to the EOS command syntax it models.
 *
 * The kinds are pairwise non-overlapping even as prefixes — `Vlan(\d+)` cannot match `Vxlan1` — so no row
 * shadows another and the table order is presentation only.
 */
const INTERFACE_GRAMMAR: readonly InterfaceGrammar[] = [
  { pattern: /^Ethernet([0-9]+)(?:\.([0-9]+))?$/u, read: (name, index, subinterface) => ({ kind: 'Ethernet', index, name, subinterface }) },
  { pattern: /^Port-Channel([0-9]+)(?:\.([0-9]+))?$/u, read: (name, index, subinterface) => ({ kind: 'Port-Channel', index, name, subinterface }) },
  { pattern: /^Management([0-9]+)$/u, read: (name, index) => ({ kind: 'Management', index, name }) },
  { pattern: /^Loopback([0-9]+)$/u, read: (name, index) => ({ kind: 'Loopback', index, name }) },
  { pattern: /^Vlan([0-9]+)$/u, read: (name, index) => ({ kind: 'Vlan', index, name }) },
  { pattern: /^Vxlan([0-9]+)$/u, read: (name, index) => ({ kind: 'Vxlan', index, name }) },
]

/**
 * A decimal run as a number, or `undefined` when it is not one a caller can act on.
 *
 * The safe-integer bound is this client's, not the platform's: `Ethernet999999999999999999999` is a token,
 * not an interface, and an index that cannot survive `String(index)` could not be reported, compared, or
 * rendered by a table. Refusing it is the same bounded-work rule `vlans.ts` states for a `vlan 1-999999999`
 * header (its divergence 8) — nothing here claims what index a given EOS release stops accepting.
 */
function interfaceIndex(digits: string | undefined): number | undefined {
  if (digits === undefined) return undefined
  const value = Number(digits)
  return Number.isSafeInteger(value) ? value : undefined
}

/**
 * Read an interface name with the per-kind grammar: `{ kind, index, name }`, plus `subinterface` for the two
 * kinds that have that form.
 *
 * `undefined` — not a throw — for anything the grammar cannot read, because this is the function a *reader*
 * calls when it is deciding what a section header means: `interfaces.ts` reports a section name it cannot
 * parse (`kind: null`) rather than dropping an interface the switch has, and
 * {@link isInterfaceName}/{@link assertInterfaceName} are the write-side use of the same answer.
 *
 * The result is deliberately not a *validated* name: a `Vlan9999` index is a legal name to the grammar and
 * an illegal VLAN id to `assertVlanId`, which is a different question on a different verb
 * (DR-053: one guard per concept, and a name guard cannot know which verbs care about which fields).
 */
export function parseInterfaceName(value: unknown): ParsedInterfaceName | undefined {
  if (typeof value !== 'string') return undefined
  for (const { pattern, read } of INTERFACE_GRAMMAR) {
    const match = pattern.exec(value)
    if (match === null) continue
    const index = interfaceIndex(match[1])
    // An out-of-range decimal is a failed parse, not a partial one: answering `{ kind: 'Ethernet' }` for a
    // name whose index this client cannot hold would be the invention DR-059 forbids.
    if (index === undefined) return undefined
    const hasSuffix = match[2] !== undefined
    const subinterface = hasSuffix ? interfaceIndex(match[2]) : undefined
    if (hasSuffix && subinterface === undefined) return undefined
    return read(value, index, subinterface)
  }
  return undefined
}


/** A rejected argument is always named in the message, rendered the way pyeapi renders it (`%r`). */
function refuse(label: string, value: unknown, because: string): never {
  throw new NotSupportedError(
    `invalid ${label} ${pythonRepr(value)} — ${because}`,
    { cause: value },
  )
}

/** `isvlan` as a predicate (`vlans.py:63-80`), minus the float truncation and the string coercion. */
export function isVlanId(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= VLAN_ID_MIN &&
    value <= VLAN_ID_MAX
  )
}

/**
 * Require a usable VLAN id: an integer `1..4094`.
 *
 * Stricter than upstream by design (row 76): pyeapi's `int()` accepts `'20'`, `'0020'` and truncates
 * `20.5`; a TS caller passes a `number`, and a string reaching this point means a UI forgot to parse
 * what a form field gave it — so `assertVlanId(20)` is fine and `assertVlanId('20')` throws naming it.
 *
 * @throws {NotSupportedError} anything that is not an integer in range. pyeapi's call sites return
 *   `False` in that case (`vlans.py:204`) with nothing to inspect (DR-005).
 */
export function assertVlanId(value: unknown): asserts value is number {
  if (isVlanId(value)) return
  refuse('vlan', value, `expected an integer VLAN id ${String(VLAN_ID_MIN)}..${String(VLAN_ID_MAX)} (pyeapi tests int(value) in range(1, 4095) at vlans.py:78)`)
}

/**
 * Is `value` a name every verb in this package accepts — the per-kind grammar's answer **without** a
 * subinterface suffix?
 *
 * Same accepts/refuses as M7's regex (`interfaces.py:81-83` with an anchor and an index required), now
 * produced by {@link parseInterfaceName}: `Ethernet1`, `Port-Channel4`, `Vlan20`, `Management0`,
 * `Loopback12`, `Vxlan1` yes; `Po1`/`Et1`, a bare kind, a command line, `Ethernet1/1` and
 * `Ethernet1.100` no (row 76, and DECISIONS.md open item 7 for the two forms this client still refuses).
 */
export function isInterfaceName(value: unknown): value is string {
  const parsed = parseInterfaceName(value)
  return parsed !== undefined && parsed.subinterface === undefined
}

/**
 * Require a full EOS interface name in the spelling every verb accepts: `Ethernet1`, `Port-Channel4`,
 * `Vlan20`, `Management0`, `Loopback12`, `Vxlan1`.
 *
 * Upstream accepts a bare kind with no index and rejects the `Po1`/`Et1` shorthands; both answers are
 * reproduced here (row 76), plus the two tightenings M7 pinned: the match is anchored and `<kind><digits>`
 * is required, because `interface Vlan` is not a command an operator can send and pyeapi's unanchored
 * `re.match` also lets a full command line through as a name.
 *
 * A **subinterface** name still fails this guard. It is not that the spelled form is unknown — pyeapi
 * writes `interface Ethernet1.1` in its own tests (`test/unit/test_api_interfaces.py:156-176`) and its
 * fixture has an `interface Ethernet48.2044` section (`test/fixtures/running_config.text:1468`) — it is
 * that this is the guard *every* verb shares, and which of the six kinds accepts a dotted header on
 * 4.28.13.1M is DECISIONS.md open item 7 ("refused here rather than guessed"). The two verbs that can
 * legitimately name a subinterface say so themselves and check the narrower rule:
 * `interfaces.ts`'s `setEncapsulation` (upstream allows it on Ethernet/Port-Channel subinterfaces only,
 * `interfaces.py:272-277`) and nothing else. {@link parseInterfaceName} does read the suffix, so widening
 * this guard is a one-line change once M12 (#14) captures the answer, not a parser rewrite.
 *
 * @throws {NotSupportedError} any other string, naming it. pyeapi raises `ValueError('invalid interface
 *   {}')` from `marshall` (`interfaces.py:131`) — but only for the dynamic-dispatch path, which this port
 *   does not have (DR-006), so every resource verb that takes a name calls this guard explicitly instead.
 */
export function assertInterfaceName(value: unknown): asserts value is string {
  if (isInterfaceName(value)) return
  refuse(
    'interface',
    value,
    `expected one of ${INTERFACE_KINDS.join(' / ')} followed by an index, with no subinterface suffix (pyeapi matches the interface kind against interfaces.py:71-78; DECISIONS.md open item 7 keeps the dotted and chassis forms refused on this unit until M12 #14 captures them, and parseInterfaceName already reads the dotted form for setEncapsulation)`,
  )
}
