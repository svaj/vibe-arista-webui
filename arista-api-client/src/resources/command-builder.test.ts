/**
 * `commandBuilder` / `submodeCommands` — the DR-037 command-string builders, M7 (#9).
 *
 * ## Upstream port ledger — there is no `pyeapi/test/unit/test_abstract.py`
 *
 * Verified on 2026-11-03: `pyeapi/test/unit/` holds `test_api_*.py`, `test_client.py`,
 * `test_eapilib.py` and `test_utils.py` — **no** `test_abstract.py`. `abstract.py` is covered only by
 * the expectations embedded in each module's tests (e.g. `test/unit/test_api_system.py:1-58` drives
 * `command_builder` through `set_hostname`/`set_iprouting`/`set_banner`), which is what PLAN.md M6 means
 * by "`test_abstract`-style assertions embedded in each module's tests". So the truth table below is
 * built from the shipped code plus those embedded expectations, and the places this port refuses what
 * upstream answers are marked as divergences with the ref that shows upstream's answer.
 *
 * The branch order is upstream's and stays upstream's — `default`, then `disable`, then `value`
 * (`pyeapi/api/abstract.py:152-159`; the docstring states the order at `:137` and the docstring says
 * "Default preempts disable and value" at `:144-145`, "Disable preempts value" at `:146-147`). DR-037
 * changed the *arguments* (`value=`/`default=`/`disable=` kwargs → `{ mode, value }`), not the
 * precedence, because a resource verb that forwards both must not change what gets written to a switch.
 *
 * Upstream's own tests are pre-armed for the two refusals made here: `test/unit/test_api_bgp.py:117`
 * and its siblings carry the comment "If command_builder fails because value is None, uncomment"
 * beside the assertion that expects the negated form — i.e. Arista already planned to make
 * `command_builder` raise (the raised `ValueError` is commented out at `abstract.py:163-164` right
 * under the `return 'no %s'` it would replace, `:161`, marked "to be deprecated" at `:162`).
 */

import { describe, expect, it } from 'vitest'

import { NotSupportedError } from '../errors'
import { commandBuilder, submodeCommands } from './command-builder'
import type { CommandInput, CommandMode, CommandOptions, CommandValue } from './types'
import type { CommandSpec } from '../types/eapi'

/** A JS/decoded-profile caller can hand a `mode` outside the union; TS-only callers cannot. */
function badMode(mode: string): CommandMode {
  return mode as CommandMode
}

/** Same for a `value`: the union is `string | number | true`, the runtime is not. */
function badValue(value: unknown): CommandValue {
  return value as CommandValue
}

describe('commandBuilder — pyeapi BaseEntity.command_builder (abstract.py:129-164)', () => {
  describe('the truth table (DR-037 replaces the four positional args with { mode, value })', () => {
    const table: ReadonlyArray<readonly [string, string, CommandOptions | undefined, string]> = [
      // --- answers this port shares with upstream ------------------------------------------------
      ['default beats everything', 'ip routing', { mode: 'default' }, 'default ip routing'], // :152-153
      ['default preempts a leftover value', 'ip routing', { mode: 'default', value: 'x' }, 'default ip routing'], // :152 over :158
      ['default preempts value: true', 'ip routing', { mode: 'default', value: true }, 'default ip routing'],
      ['no is the disable form', 'ip routing', { mode: 'no' }, 'no ip routing'], // :154-155
      ['no preempts a leftover value', 'ip routing', { mode: 'no', value: '1500' }, 'no ip routing'], // :154 over :158
      ['no preempts even an invalid value (mode is resolved first)', 'mtu', { mode: 'no', value: badValue(false) }, 'no mtu'],
      ['the bare command', 'ip routing', { value: true }, 'ip routing'], // :156-157
      ['a number is stringified', 'mtu', { value: 1500 }, 'mtu 1500'], // :158-159
      ['a string is appended verbatim', 'name', { value: 'WAN access' }, 'name WAN access'], // :158-159
      ['mode set is the default', 'mtu', { mode: 'set', value: 1500 }, 'mtu 1500'],
      ['value only, no mode', 'description', { value: 'uplink to ISP A' }, 'description uplink to ISP A'],
      // --- deliberate divergences: upstream negates, this port keeps the operator's value --------
      // upstream `elif value:` at :158 is falsy-truthy, so 0 falls through to `return 'no %s'` (:161):
      // `command_builder('mtu', value=0)` answers `no mtu` upstream. `0` is a real EOS value
      // (`mtu 0` is rejected by the device, which is a device answer, not a client invention).
      ['a numeric 0 keeps its value (upstream: `no mtu` — :158/:161)', 'mtu', { value: 0 }, 'mtu 0'],
      ['a numeric 0 with mode set', 'load-interval', { mode: 'set', value: 0 }, 'load-interval 0'],
      ['-1 is a value, not a negation (upstream agrees here: `bool(-1)` is True → :158-159)', 'ttl maximum hops', { value: -1 }, 'ttl maximum hops -1'],
      ['an IPv4 address shaped like a number stays a string', 'ip address', { value: '10.0.0.1/24' }, 'ip address 10.0.0.1/24'],
      ['an EOS-legal quoted value is passed through for the codec', 'description', { value: '" WAN uplink "' }, 'description " WAN uplink "'],
      ['a unicode value survives untouched', 'name', { value: 'värm – 10G' }, 'name värm – 10G'],
      ['an interior space is the device\u2019s to parse', 'name', { value: 'vlan ten' }, 'name vlan ten'],
    ]

    for (const [name, command, options, expected] of table) {
      it(`${name} → \`${expected}\``, () => {
        expect(commandBuilder(command, options)).toBe(expected)
      })
    }
  })

  describe('the evaluation order DR-037 keeps (abstract.py:152-159)', () => {
    it('a `mode` always wins over a `value`, so a verb forwarding both is unambiguous', () => {
      // The upstream docstring says it first ("Default preempts disable and value", `:144-145`).
      expect(commandBuilder('ip Routing', { mode: 'default', value: 'yes' })).toBe('default ip Routing')
      expect(commandBuilder('ip Routing', { mode: 'no', value: 'yes' })).toBe('no ip Routing')
      expect(commandBuilder('ip Routing', { mode: 'default' })).toBe('default ip Routing')
      expect(commandBuilder('ip Routing', { mode: 'no' })).toBe('no ip Routing')
    })

    it('`no` is checked before `value`, exactly as `elif disable:` precedes `elif value:`', () => {
      // A caller passing both gets the disable form even though the value would have been refused.
      expect(commandBuilder('logging', { mode: 'no', value: badValue(undefined) })).toBe('no logging')
    })
  })

  describe('refusals where upstream answers a command (MIGRATION.md §5 row 66)', () => {
    const refusals: ReadonlyArray<readonly [string, string, CommandOptions | undefined, RegExp]> = [
      // upstream: `else: return 'no %s'` (:160-161), marked "to be deprecated" (:162) with the
      // replacement `raise ValueError` sitting commented out beside it (:163-164).
      ["no mode and no value would be upstream's deprecated `no` form", 'mtu', {}, /the deprecated `no` form/],
      ['mode set with no value', 'mtu', { mode: 'set' }, /mode: 'set' needs a value/],
      ['mode set with an explicit undefined', 'mtu', { mode: 'set', value: undefined }, /needs a value/],
      // upstream: `elif value:` is falsy → `no mtu` (:158 → :161). A UI that reads back "no mtu"
      // after an operator typed 0 would be lying.
      ['value false is not a negation', 'mtu', { value: badValue(false) }, /negation is mode: "no"/],
      ['value null is refused', 'mtu', { value: badValue(null) }, /a value must be a string, a number, or true/],
      ['an object value is refused', 'name', { value: badValue({ a: 1 }) }, /a value must be a string, a number, or true/],
      ['an array value is refused', 'name', { value: badValue(['a', 'b']) }, /a value must be a string, a number, or true/],
      ['NaN is not a configuration value', 'mtu', { value: Number.NaN }, /NaN and Infinity/],
      ['Infinity is not a configuration value', 'mtu', { value: Number.POSITIVE_INFINITY }, /NaN and Infinity/],
      // upstream interpolates to `mtu ` + `'  '`, i.e. a trailing-space line that reads back as bare
      // `mtu` (`:157`, `'%s %s'`).
      ['an empty value would send a trailing space', 'mtu', { value: '' }, /an empty value/],
      ['a whitespace-only value likewise', 'name', { value: '   ' }, /an empty value/],
      // DR-015: a multiline command is a `{ cmd, input }` object, never one string with a newline in
      // it — pyeapi interpolates blindly (`:157`) and the device would run a second command.
      ['a value carrying a newline is refused', 'description', { value: 'a\nb' }, /line boundary/],
      ['a value carrying CR is refused', 'description', { value: 'a\rb' }, /line boundary/],
      ['a value carrying NEL is refused', 'description', { value: 'a\u0085b' }, /line boundary/],
      ['a bad mode from JS names the accepted modes', 'mtu', { mode: badMode('unset') }, /mode must be one of set \/ no \/ default/],
    ]

    for (const [name, command, options, message] of refusals) {
      it(`throws: ${name}`, () => {
        expect(() => commandBuilder(command, options)).toThrow(NotSupportedError)
        expect(() => commandBuilder(command, options)).toThrow(message)
      })
    }
  })

  describe('the command stem itself (row 67)', () => {
    it('refuses an empty or whitespace-only command, naming what arrived', () => {
      expect(() => commandBuilder('', { value: 1 })).toThrow(/expects a non-empty command string, received ''/)
      expect(() => commandBuilder('   ', { value: 1 })).toThrow(/non-empty command string/)
      // pythonRepr is how pyeapi renders `%r` in its own messages, so a rejected value is legible.
      expect(() => commandBuilder(42 as unknown as string, { value: 1 })).toThrow(/received 42/)
    })

    it('refuses a command containing a line boundary (one CommandSpec per command line)', () => {
      expect(() => commandBuilder('interface Ethernet1\nmtu 1500', { value: 1 })).toThrow(NotSupportedError)
      expect(() => commandBuilder('interface\x0cEthernet1', { mode: 'no' })).toThrow(/line boundary/)
    })

    it('does not trim or rewrite the command text it was given (the device parser owns that)', () => {
      expect(commandBuilder('ip address dhcp', { value: 'atten' })).toBe('ip address dhcp atten')
      expect(commandBuilder('no', { mode: 'default' })).toBe('default no')
    })
  })
})

describe('submodeCommands — the fixed form of configure_interface (abstract.py:166-178)', () => {
  it('wraps a bare command string in the parent line', () => {
    expect(submodeCommands('interface Ethernet1', 'mtu 1500')).toEqual(['interface Ethernet1', 'mtu 1500'])
  })

  it('wraps once and never writes through to the caller array (upstream `commands.insert(0, …)`, :177)', () => {
    const caller: CommandSpec[] = ['switchport mode access', 'switchport access vlan 20']
    const before = [...caller]
    const first = submodeCommands('interface Ethernet1', caller)
    const second = submodeCommands('interface Ethernet1', caller)
    // Upstream `make_iterable` returns the caller's own list (`utils.py:166`), so `insert(0, …)` splices
    // the parent INTO it: the second call would carry two `interface` lines.
    expect(caller).toEqual(before)
    expect(caller).not.toContain('interface Ethernet1')
    expect(first).toEqual(second)
    expect(first.filter((command) => command === 'interface Ethernet1')).toHaveLength(1)
    expect(first).not.toBe(caller)
  })

  it('wraps exactly once per call when the same list is reused for two interfaces', () => {
    const commands: CommandSpec[] = ['mtu 1500']
    expect(submodeCommands('interface Ethernet1', commands)).toEqual(['interface Ethernet1', 'mtu 1500'])
    expect(submodeCommands('interface Ethernet2', commands)).toEqual(['interface Ethernet2', 'mtu 1500'])
    expect(commands).toEqual(['mtu 1500'])
  })

  it('keeps a { cmd, input } element as an element (DR-015, no MULTILINE: pseudo-syntax)', () => {
    const banner: CommandSpec = { cmd: 'banner motd', input: 'line one\nEOF\n' }
    const wrapped = submodeCommands('line console 0', ['exec-timeout 0 0', banner])
    expect(wrapped).toHaveLength(3)
    expect(wrapped[0]).toBe('line console 0')
    expect(wrapped[2]).toBe(banner)
  })

  it('refuses a parent that is empty, blank or carries a line boundary', () => {
    expect(() => submodeCommands('', 'mtu 1500')).toThrow(NotSupportedError)
    expect(() => submodeCommands('   ', 'mtu 1500')).toThrow(/needs a non-empty parent command/)
    expect(() => submodeCommands('interface Ethernet1\nip address dhcp', 'mtu 1500')).toThrow(/line boundary/)
  })

  it('leaves element shape to the wire codec (no re-validation here — element junk reaches buildRequest)', () => {
    const junk = { cmd: 'mtu 1500', bogus: true } as unknown as CommandSpec
    const wrapped: readonly CommandSpec[] = submodeCommands('interface Ethernet1', junk)
    const list: CommandInput = ['hostname sw1']
    expect(wrapped).toEqual(['interface Ethernet1', junk])
    expect(submodeCommands('configure', list)).toEqual(['configure', 'hostname sw1'])
  })

  it('wraps an empty list to just the parent line (a submode entered with nothing in it)', () => {
    expect(submodeCommands('router bgp 65001', [])).toEqual(['router bgp 65001'])
  })
})
