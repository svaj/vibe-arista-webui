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
 * These are **input guards, not platform claims**: DR-032/DR-033 keep feature support on the device, and
 * M10 (#12) replaces {@link assertInterfaceName} with the per-kind parser returning a discriminated
 * union (`docs/PLAN.md` M10, "validation split"). MIGRATION.md §5 row 70 records what is stricter here
 * than upstream and what M10 will widen.
 */

import { NotSupportedError } from '../errors'
import { pythonRepr } from '../internal/wire'

/** The EOS VLAN id range — pyeapi `range(1, 4095)` (`vlans.py:78`), and the EOS-wide limit in MIGRATION.md §4. */
const VLAN_ID_MIN = 1
const VLAN_ID_MAX = 4094

/**
 * Interface kinds pyeapi's own predicate accepts (`interfaces.py:71-78`). Deliberately **not** extended
 * here: `Mlag`, `Switch`-style or `Peer-Ethernet` names are wave-2/3 questions, and inventing a kind is
 * exactly the "do not invent eAPI commands" rule this repo follows.
 */
const INTERFACE_KINDS: readonly string[] = [
  'Ethernet',
  'Management',
  'Loopback',
  'Port-Channel',
  'Vlan',
  'Vxlan',
]

/**
 * A full interface name: one of the six kinds, then at least one digit. Anchored, unlike upstream's
 * unanchored `re.match` (`interfaces.py:82`), so `Ethernet1 mode on` — a command line that wandered into
 * a name position — is refused instead of read as the `Ethernet` kind.
 *
 * Deliberately narrow for M7 (#9): a subinterface (`Ethernet1.100`) or a chassis/slot form is **not**
 * accepted yet, because the syntax that is legal differs per kind and per EOS release (DR-042). M10 (#12)
 * owns that matrix and will widen this with the discriminated-union parser rather than a wider regex.
 */
const INTERFACE_NAME = new RegExp(`^(?:${INTERFACE_KINDS.join('|')})[0-9]+$`, 'u')

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
 * Stricter than upstream by design (row 70): pyeapi's `int()` accepts `'20'`, `'0020'` and truncates
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

/** `isvalidinterface` as a predicate (`interfaces.py:81-83`), with the name anchored and an index required. */
export function isInterfaceName(value: unknown): value is string {
  return typeof value === 'string' && INTERFACE_NAME.test(value)
}

/**
 * Require a full EOS interface name (`Ethernet1`, `Port-Channel4`, `Vlan20`, `Management0`,
 * `Loopback12`, `Vxlan1`).
 *
 * Upstream accepts a bare kind with no index and rejects the `Po1`/`Et1` shorthands; both answers are
 * reproduced here (row 70), plus one tightening: the regex is anchored and `<kind><digits>` is required,
 * because `interface Vlan` is not a command an operator can send and pyeapi's unanchored `re.match` also
 * lets a full command line through as a name.
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
    `expected one of ${INTERFACE_KINDS.join(' / ')} followed by an index (pyeapi matches the interface kind against interfaces.py:71-78; the per-kind parser with subinterfaces lands in M10 #12)`,
  )
}
