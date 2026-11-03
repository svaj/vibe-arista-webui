/**
 * Resource argument guards, M7 (#9). DR-004's replacement for pyeapi's duck-typed predicates.
 *
 * ## Upstream port ledger
 *
 * There is no `test/unit/test_api_abstract.py`-style home for these — the predicates are covered by the
 * assertions embedded in each module's own tests:
 *
 * * `isvlan` — `pyeapi/api/vlans.py:63-80` (opened 2026-11-03): `value = int(value)` (`:77`) then
 *   `value in range(1, 4095)` (`:78`), `except ValueError: return False` (`:79-80`). Call sites convert
 *   a `False` into the swallowed failure DR-005 removes:
 *   `return self.configure(command) if isvlan(vid) else False` (`vlans.py:204`, `:216`, `:232`).
 *   Ran against the real Python 3 in that clone (`python3 -c "from pyeapi.api.vlans import isvlan; …"`):
 *   `isvlan(20.5) is True` (truncated), `isvlan('0020') is True` (coerced), and `isvlan(None)` **raises
 *   `TypeError`** from `int()` — the `except` catches only `ValueError`, so upstream's "predicate" is not
 *   total. `test/unit/test_api_vlans.py` never exercises those holes.
 * * `isvalidinterface` — `pyeapi/api/interfaces.py:81-83`:
 *   `re.match(r'([EPVLM][a-z-C]+)', value)` and the match must be in `VALID_INTERFACES`
 *   (`interfaces.py:71-78`). Ran against the same interpreter: Python 3 **accepts** that odd character
 *   class (it is `a-z`, a literal `-`, and `C`), and `re.match` is unanchored, so `Ethernet1` →
 *   `Ethernet`, `Port-Channel1` → `Port-Channel`, `Po1` → `Po` (then rejected by the set test),
 *   `Et1` → no match, and a bare `Vlan` (no index) **passes**. Upstream raises `ValueError` only from
 *   `marshall` (`interfaces.py:131`), i.e. only on the dynamic-dispatch path DR-006 does not port — a
 *   static call to `vlans.set_name(…)` with a bad interface name is never checked at all.
 *
 * Everything marked "stricter" below is MIGRATION.md §5 row 76; M10 (#12) owns the per-kind parser that
 * widens {@link assertInterfaceName} to subinterfaces, and this suite pins the boundary it starts from.
 */

import { describe, expect, it } from 'vitest'

import { NotSupportedError } from '../errors'
import { assertInterfaceName, assertVlanId, isInterfaceName, isVlanId } from './validators'

describe('assertVlanId / isVlanId — pyeapi vlans.isvlan (vlans.py:63-80)', () => {
  it('accepts the ends of the EOS VLAN range (upstream range(1, 4095) is 1..4094, vlans.py:78)', () => {
    expect(() => assertVlanId(1)).not.toThrow()
    expect(() => assertVlanId(20)).not.toThrow()
    expect(() => assertVlanId(4094)).not.toThrow()
    expect(isVlanId(4094)).toBe(true)
  })

  it('rejects the id just outside the range, naming it (upstream answers False and the caller returns False)', () => {
    for (const bad of [0, 4095, 4096, -1]) {
      expect(() => assertVlanId(bad)).toThrow(NotSupportedError)
      expect(() => assertVlanId(bad)).toThrow(new RegExp(`invalid vlan ${String(bad)} —`))
      expect(isVlanId(bad)).toBe(false)
    }
  })

  it('rejects a numeric string instead of coercing it (divergence: isvlan accepts int("0020"), vlans.py:77)', () => {
    // Upstream: `isvlan('20')` and `isvlan('0020')` are both True. Here a string means a UI forgot to
    // parse a form field, and the error names the quoted value so that is visible in one line.
    for (const bad of ['20', '0020', ' 20 ', '20abc']) {
      expect(() => assertVlanId(bad)).toThrow(new RegExp(`invalid vlan '${bad}' —`))
    }
    expect(isVlanId('20')).toBe(false)
  })

  it('rejects a non-integer number rather than truncating it (divergence: isvlan(20.5) is True upstream)', () => {
    expect(() => assertVlanId(20.5)).toThrow(/invalid vlan 20.5 —/)
    expect(() => assertVlanId(Number.NaN)).toThrow(/invalid vlan NaN —/)
    expect(() => assertVlanId(Number.POSITIVE_INFINITY)).toThrow(/invalid vlan Infinity —/)
    // 2**53 is no longer a safe integer, so a decoded JSON number that large cannot be a VLAN id anyway.
    expect(isVlanId(Number.MAX_SAFE_INTEGER + 2)).toBe(false)
  })

  it('rejects the values that make pyeapi raise TypeError from int() rather than answer False (vlans.py:79 catches only ValueError)', () => {
    for (const bad of [undefined, null, true, false, {}, [], () => undefined]) {
      expect(() => assertVlanId(bad)).toThrow(NotSupportedError)
    }
    // `pythonRepr` rendering, so the message reads like pyeapi's own `%r`: None / True / {} / [].
    expect(() => assertVlanId(undefined)).toThrow(/invalid vlan None —/)
    expect(() => assertVlanId(null)).toThrow(/invalid vlan None —/)
    expect(() => assertVlanId(true)).toThrow(/invalid vlan True —/)
    expect(() => assertVlanId([])).toThrow(/invalid vlan \[\] —/)
  })

  it('states the accepted range in the message, so a UI can show it without re-deriving it', () => {
    expect(() => assertVlanId(4095)).toThrow(/expected an integer VLAN id 1\.\.4094/)
  })
})

describe('assertInterfaceName / isInterfaceName — pyeapi interfaces.isvalidinterface (interfaces.py:81-83)', () => {
  it('accepts every kind pyeapi lists (VALID_INTERFACES, interfaces.py:71-78) when an index follows', () => {
    for (const name of ['Ethernet1', 'Ethernet48', 'Management1', 'Management0', 'Loopback0', 'Loopback12', 'Port-Channel4', 'Vlan20', 'Vxlan1']) {
      expect(() => assertInterfaceName(name)).not.toThrow()
      expect(isInterfaceName(name)).toBe(true)
    }
  })

  it('rejects the shorthands upstream rejects too (Po1/Et1 match the regex but are not VALID_INTERFACES)', () => {
    for (const shorthand of ['Po1', 'Po111', 'Eth1', 'Et1', 'man1', 'ethernet1']) {
      expect(() => assertInterfaceName(shorthand)).toThrow(NotSupportedError)
      expect(() => assertInterfaceName(shorthand)).toThrow(new RegExp(`invalid interface '${shorthand}' —`))
    }
  })

  it('requires an index — stricter than upstream, whose unanchored re.match answers True for a bare kind (row 76)', () => {
    // Verified upstream: `isvalidinterface('Vlan')` is True, because re.match yields 'Vlan' and that is
    // in VALID_INTERFACES. `interface Vlan` is not a command an operator can send, so it is refused here.
    for (const bare of ['Vlan', 'Ethernet', 'interface Ethernet1', 'vlan 20', 'Port-Channel']) {
      expect(() => assertInterfaceName(bare)).toThrow(/expected one of Ethernet \/ Management \/ Loopback \/ Port-Channel \/ Vlan \/ Vxlan followed by an index/)
    }
  })

  it('anchors the match: a command line cannot masquerade as a name (upstream re.match accepts it, interfaces.py:82)', () => {
    // `re.match(r'([EPVLM][a-z-C]+)', 'Ethernet1 mode on')` matches `Ethernet` and passes the set test,
    // so upstream accepts a whole command in the name position. Anchoring refuses it.
    for (const notAName of ['Ethernet1 mode on', 'Ethernet1.100', 'Ethernet1/2', 'Vlan20 name PROD', 'Ethernet ', 'Ethernet1 ']) {
      expect(() => assertInterfaceName(notAName)).toThrow(NotSupportedError)
      expect(isInterfaceName(notAName)).toBe(false)
    }
  })

  it('leaves the per-kind syntax matrix to M10 (#12): subinterfaces and chassis forms are refused for now', () => {
    // DR-042: what is legal differs per kind and per EOS release, and inventing support is the one thing
    // this repo's rules forbid. M10 replaces this regex with the discriminated-union parser.
    for (const future of ['Ethernet1.100', 'Port-Channel4.10', 'EtherNetsw1 slots 1', 'Peer-Ethernet1', 'Mlag1']) {
      expect(() => assertInterfaceName(future)).toThrow(NotSupportedError)
    }
    expect(isInterfaceName('Peer-Ethernet1')).toBe(false)
  })

  it('refuses non-strings, naming the rejected value the way pyeapi renders %r', () => {
    for (const bad of [undefined, null, 42, {}, [], true]) {
      expect(() => assertInterfaceName(bad)).toThrow(NotSupportedError)
    }
    expect(() => assertInterfaceName(undefined)).toThrow(/invalid interface None —/)
    expect(() => assertInterfaceName(42)).toThrow(/invalid interface 42 —/)
    expect(() => assertInterfaceName('')).toThrow(/invalid interface '' —/)
  })

  it('is an assertion: a guarded name narrows for the rest of the block (compile-time contract, no cast)', () => {
    const guarded: unknown = 'Ethernet8'
    assertInterfaceName(guarded)
    const name: string = guarded
    expect(name).toBe('Ethernet8')
  })
})
