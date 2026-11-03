/**
 * `toArray` — the explicit iterable boundary, M7 (#9). Port of pyeapi `utils.make_iterable`
 * (`pyeapi/utils.py:147-166`, verified by opening the file on 2026-11-03).
 *
 * ## Upstream port ledger — `pyeapi/test/unit/test_utils.py` (4 `make_iterable` methods, `:23-41`)
 *
 * MIGRATION.md §6 puts these four on the `test/unit/test_utils.py` row ("4 `make_iterable` → the
 * planned M7 `toArray` boundary"); the §1 table already named `src/internal/collections.ts` as the
 * planned home. Note the file that home's tests is named after the module, which §6 does not spell
 * out — recorded as a documentation gap for the orchestrator, not a code one.
 *
 * * `test_make_iterable_from_string` (`:23-26`) → `it('wraps a string as a one-element array')`
 * * `test_make_iterable_from_unicode` (`:28-31`) → `it('wraps a non-ASCII string the same way')` —
 *   Python 2's two string types are one type in JS, so the two cases collapse to one pair here.
 * * `test_make_iterable_from_iterable` (`:33-36`) → `it('returns a copy of an array it was given')` —
 *   and this is where the port **diverges on purpose**: upstream hands back the caller's own object
 *   (`return value`, `:166`), which is the whole cause of the `configure_interface` mutation bug at
 *   `api/abstract.py:176-177`. Ours copies. MIGRATION.md §5 row 64.
 * * `test_make_iterable_raises_type_error` (`:39-41`) → the `undefined`/`null` cases below, with a
 *   narrower refusal: pyeapi raises on *any* non-`Iterable` (`:163-164`), including `int` and
 *   `object()`, while a `{ cmd, input }` command object is a legitimate single value here (it is a
 *   `dict`, which upstream wraps at `:159-161`). Row 65.
 *
 * Two upstream behaviours are deliberately **not** ported and are pinned below so nobody re-adds
 * them by accident: any-`Iterable` acceptance (a `set`/`dict`-of-keys passes `make_iterable`
 * untouched at `:162` and keeps whatever element shape it had), and the aliasing.
 */

import { describe, expect, it } from 'vitest'

import { NotSupportedError } from '../errors'
import { toArray } from './collections'
import type { CommandSpec } from '../types/eapi'

describe('toArray — pyeapi utils.make_iterable (utils.py:147-166)', () => {
  it('wraps a string as a one-element array [pyeapi test_make_iterable_from_string, utils.py:159-161]', () => {
    expect(toArray('vlan 20')).toEqual(['vlan 20'])
  })

  it('wraps a non-ASCII string the same way (pyeapi test_make_iterable_from_unicode collapses into this — one string type in JS)', () => {
    expect(toArray('description café \u2014 uplink')).toEqual(['description café \u2014 uplink'])
  })

  it('returns an array of the same length it was handed [pyeapi test_make_iterable_from_iterable]', () => {
    expect(toArray(['vlan 20'])).toHaveLength(1)
    expect(toArray(['name PROD', 'trunk group red'])).toEqual(['name PROD', 'trunk group red'])
  })

  it('copies the caller array instead of handing it back (the fix for abstract.py:176-177 — row 64)', () => {
    const caller = ['mtu 1500']
    const result = toArray(caller)
    expect(result).not.toBe(caller)
    expect(result).toEqual(caller)
    result.unshift('interface Ethernet1')
    // Upstream's `make_iterable` + `commands.insert(0, …)` pair leaves `interface Ethernet1` inside the
    // CALLER's array, so the next call with the same list sends the parent line twice.
    expect(caller).toEqual(['mtu 1500'])
  })

  it('preserves command objects verbatim (pyeapi wraps a dict the same way, utils.py:159-161)', () => {
    const banner: CommandSpec = { cmd: 'banner motd', input: 'line one\nEOF\n' }
    expect(toArray(banner)).toEqual([banner])
    expect(toArray(banner)[0]).toBe(banner)
    expect(toArray([banner, 'hostname sw1'])[0]).toBe(banner)
  })

  it('refuses nothing at all, naming what it expected [pyeapi raises TypeError here, utils.py:163-164]', () => {
    // `make_iterable(None)` is not `Iterable`, so upstream raises `TypeError('value must be an
    // iterable object')` from `:164`. DR-010's taxonomy puts that on `NotSupportedError` instead and
    // says what to pass, because the caller's mistake is a missing value, not a wrong type name.
    for (const nothing of [undefined, null]) {
      expect(() => toArray(nothing as never)).toThrow(NotSupportedError)
      expect(() => toArray(nothing as never)).toThrow(/received nothing/)
    }
  })

  it('wraps a plain value rather than testing "is it iterable" (divergence, row 65: pyeapi raises TypeError for int/object)', () => {
    // Upstream: `make_iterable(5)` and `make_iterable(object())` both hit the `not isinstance(value,
    // Iterable)` branch at `utils.py:163-164` and raise. This helper is generic over the value type —
    // it normalises "one or many", it does not validate the element. A `5` in a `CommandSpec` position
    // is refused downstream by the wire codec (`src/internal/wire.ts` → `buildRequest`), which is the
    // single place that knows what a command may be. Pinned so widening it stays a decision.
    expect(toArray(5 as unknown as CommandSpec)).toEqual([5 as unknown as CommandSpec])
    expect(toArray(5 as unknown as CommandSpec)).toHaveLength(1)
  })

  it('does NOT spread a Set or a Map (not ported: pyeapi accepts any Iterable, utils.py:162 — row 65)', () => {
    // `toArray(new Set(['a','b']))` is one value, not two commands. Guessing "spread it" here would
    // make the same call mean two different things depending on the argument's class, which is the
    // duck typing DR-004 removes. A caller who means the elements calls `Array.from(x)` first.
    const set = new Set(['a', 'b'])
    expect(toArray(set)).toEqual([set])
    expect(toArray(set)).toHaveLength(1)
    const map = new Map([['vlan 20', 'name PROD']])
    expect(toArray(map)).toHaveLength(1)
  })

  it('is idempotent: toArray(toArray(x)) keeps the same elements (no double wrapping)', () => {
    expect(toArray(toArray(['vlan 20', 'name PROD']))).toEqual(['vlan 20', 'name PROD'])
  })
})
