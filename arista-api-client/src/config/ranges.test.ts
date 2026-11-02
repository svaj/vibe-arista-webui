/**
 * Range expand/collapse specs — M6 (#8), port of the range cases in upstream
 * `test/unit/test_utils.py:51-81` (six methods, ported by name below) plus the boundary cases
 * PLAN.md M6 asks for (`'*'`, bare `'1'`, reversed runs, non-numeric input, empty string, repeated
 * members, mixed comma+range ordering) and output-ordering pins for `collapseRange`.
 *
 * Every "upstream: …" comment is a value **transcribed from a one-off run of real pyeapi**
 * (1.0.4-rc0, `develop` @ 6816d9e, CPython 3.13.5, 2026-11-02) against
 * `pyeapi/utils.py:175-195` (`expand_range`) and `pyeapi/utils.py:198-232` (`collapse_range`,
 * `lookahead` at `:169-172`). Python is not a runtime dependency of `npm test`; the transcription
 * lives in this file so each assertion is auditable without re-running anything.
 *
 * Where this port deliberately answers differently from upstream, the test says so and cites the
 * MIGRATION.md §5 row (45-48): upstream passes non-integers through `expand_range` unchanged, leaks
 * `ValueError`, and its `if v2:` truthiness test (`utils.py:214`) silently drops zeros —
 * upstream `collapse_range('0,1') === ['1']` and `collapse_range('1,2,') === ['1-2','']` (the old
 * comment in `ranges.ts` claimed `['1','0','2']` for `'1,,2'`; the actual upstream behaviour is
 * `ValueError` at `utils.py:215`, and it is pinned here in its corrected form).
 */

import { describe, expect, it } from 'vitest'
import fc from 'fast-check'

import { NotSupportedError } from '../errors'
import { collapseRange, collapseRangeToString, expandRange, sortedRangeValues } from './ranges'

describe('expandRange — ported test_utils.py cases by name', () => {
  it('test_expand_singles: "1,2,3" round-trips through the join upstream asserts', () => {
    // upstream: expand_range('1,2,3') -> ['1', '2', '3']; ','.join(...) === '1,2,3' (test_utils.py:51-55)
    expect(expandRange('1,2,3')).toEqual(['1', '2', '3'])
    expect(expandRange('1,2,3').join(',')).toBe('1,2,3')
  })

  it('test_expand_range: "1-15" expands inclusive on both ends', () => {
    // upstream: [str(x) for x in range(1, 16)] (test_utils.py:57-61); inclusive range at utils.py:191
    const expected = Array.from({ length: 15 }, (_, i) => String(i + 1))
    expect(expandRange('1-15')).toEqual(expected)
  })

  it('test_expand_mixed: "1,3,5-7,9" keeps comma items and expands the run in place', () => {
    // upstream: ['1', '3', '5', '6', '7', '9'] (test_utils.py:63-66)
    expect(expandRange('1,3,5-7,9')).toEqual(['1', '3', '5', '6', '7', '9'])
  })
})

describe('expandRange — orderings and boundary cases (PLAN M6 test list)', () => {
  it("'1-3,5' is the PLAN-named case: range then singleton, device order preserved", () => {
    // upstream: expand_range('1-3,5') -> ['1', '2', '3', '5']
    expect(expandRange('1-3,5')).toEqual(['1', '2', '3', '5'])
  })

  it('a bare "1" is a one-member list in both implementations', () => {
    // upstream: expand_range('1') -> ['1']
    expect(expandRange('1')).toEqual(['1'])
  })

  it("'*' is REJECTED here, though upstream passes it through as opaque text", () => {
    // upstream: expand_range('*') -> ['*'] — no `int()` ever runs because there is no '-' in the
    // token (utils.py:188-189 takes the passthrough branch). A wildcard is NOT expanded by pyeapi —
    // it survives untouched, so `expand_range('Ethernet*') -> ['Ethernet*']` identically. This port
    // requires integers so a UI never renders `Ethernet*` as if it were a member list
    // (MIGRATION.md §5 row 47). pyeapi itself never calls these functions at all (row 45), so the
    // wildcard "support" was dead code even upstream.
    expect(() => expandRange('*')).toThrowError(NotSupportedError)
    expect(() => expandRange('*')).toThrow('expandRange: "*" is not an integer or a range')
    expect(() => expandRange('Ethernet*')).toThrow('expandRange: "Ethernet*" is not an integer or a range')
  })

  it('an interface WILDERNESS with a real range still fails, as it does upstream', () => {
    // upstream: expand_range('Ethernet1-4') -> ValueError: invalid literal for int() with base 10:
    // 'Ethernet1' (int() at utils.py:191). Same refusal here, typed:
    expect(() => expandRange('Ethernet1-4')).toThrowError(NotSupportedError)
    expect(() => expandRange('Ethernet1-4')).toThrow('expandRange: "Ethernet1" is not an integer range endpoint')
  })

  it('a reversed run expands to NOTHING — matching Python range() exactly', () => {
    // upstream: expand_range('5-3') -> [] (range(5, 4) is empty, utils.py:191)
    expect(expandRange('5-3')).toEqual([])
    expect(expandRange('3-3')).toEqual(['3']) // inclusive single-member run, upstream ['3']
  })

  it('non-numeric input raises instead of leaking through as a member', () => {
    // upstream: expand_range('a-b') -> ValueError "invalid literal for int() with base 10: 'a'";
    // but note expand_range('foo') -> ['foo'] PASSTHROUGH (no range delimiter, no validation).
    // Both shapes are refused here (row 47):
    expect(() => expandRange('a-b')).toThrow('expandRange: "a" is not an integer range endpoint')
    expect(() => expandRange('foo')).toThrow('expandRange: "foo" is not an integer or a range')
  })

  it('the empty string raises, where upstream answers [""]', () => {
    // upstream: expand_range('') -> [''] — an empty token sails through the passthrough branch.
    // Returning [''] would render an empty VLAN member in a UI (row 47).
    expect(() => expandRange('')).toThrowError(NotSupportedError)
    expect(() => expandRange('')).toThrow('expandRange: "" is not an integer or a range')
  })

  it('a run with two range delimiters is refused with the token named', () => {
    // upstream: expand_range('1-2-3') -> ValueError: too many values to unpack (expected 2) —
    // the `start, end = item.split(range_delimiter)` unpack at utils.py:190.
    expect(() => expandRange('1-2-3')).toThrow('expandRange: "1-2-3" is not a single range (expected "-")')
    expect(() => expandRange('1-')).toThrow('expandRange: "" is not an integer range endpoint')
    expect(() => expandRange('10,2-')).toThrow('expandRange: "" is not an integer range endpoint')
  })

  it('repeated members stay repeated — expansion is literal, de-dup is sortedRangeValues job', () => {
    // upstream: expand_range('1,1,2') -> ['1', '1', '2']
    expect(expandRange('1,1,2')).toEqual(['1', '1', '2'])
  })

  it('mixed comma+range ordering follows the SPelling order, not numeric order', () => {
    // upstream: expand_range('1,3,5-7,9,2') -> ['1', '3', '5', '6', '7', '9', '2'] — the trailing
    // singleton keeps its position; nothing sorts.
    expect(expandRange('1,3,5-7,9,2')).toEqual(['1', '3', '5', '6', '7', '9', '2'])
  })

  it("switchport's real spelling expands to the member set M9 (#11) counts", () => {
    // upstream: expand_range('10-12,20,30-33') -> ['10','11','12','20','30','31','32','33']
    expect(expandRange('10-12,20,30-33')).toEqual(['10', '11', '12', '20', '30', '31', '32', '33'])
  })

  it('zero-padded runs expand to canonical decimals like Python str(range(int(...)))', () => {
    // upstream: expand_range('007-008') -> ['7', '8'] (int() then str(x) at utils.py:191/:195)
    expect(expandRange('007-008')).toEqual(['7', '8'])
  })

  it('padded/spacey singletons are canonicalised here, passed through raw upstream', () => {
    // upstream: expand_range(' +1,+2 ') -> [' +1', '+2 '] (passthrough keeps the bytes verbatim).
    expect(expandRange(' +1,+2 ')).toEqual(['1', '2'])
  })
})

describe('collapseRange — ported test_utils.py cases by name', () => {
  it('test_collapse_singles: "1,3,5,7" stays four singletons', () => {
    // upstream: collapse_range('1,3,5,7') -> ['1', '3', '5', '7'] (test_utils.py:68-71)
    expect(collapseRange('1,3,5,7')).toEqual(['1', '3', '5', '7'])
  })

  it('test_collapse_range: "1,2,3,4,5" becomes one run', () => {
    // upstream: collapse_range('1,2,3,4,5') -> ['1-5'] (test_utils.py:73-76)
    expect(collapseRange('1,2,3,4,5')).toEqual(['1-5'])
  })

  it('test_collapse_mixed: "1,3,5,6,7,9" collapses only the contiguous run', () => {
    // upstream: collapse_range('1,3,5,6,7,9') -> ['1', '3', '5-7', '9'] (test_utils.py:78-81)
    expect(collapseRange('1,3,5,6,7,9')).toEqual(['1', '3', '5-7', '9'])
  })
})

describe('collapseRange — output ORDER is pinned (section()/rendering consumers)', () => {
  it('device order is taken as ordered: "3,1,2" collapses to ["3","1-2"], not ["1-3"]', () => {
    // upstream: collapse_range('3,1,2') -> ['3', '1-2'] — the walk never sorts (utils.py:213).
    // Order is load-bearing for this port: a UI that re-renders the set must get one stable
    // spelling per input order, and `sortedRangeValues` is the documented way to canonicalise.
    expect(collapseRange('3,1,2')).toEqual(['3', '1-2'])
    expect(collapseRange('5,4,3')).toEqual(['5', '4', '3']) // upstream ['5', '4', '3'] — no sorting here either
  })

  it('a reversed run string never collapses: "5-3" is refused, where upstream answers ["5-3"]', () => {
    // upstream: collapse_range('5-3') -> ['5-3'] — one passthrough token, garbage in/garbage out.
    // A range token is not a value for the collapse input (row 47):
    expect(() => collapseRange('5-3')).toThrow('collapseRange: "5-3" is not an integer')
  })

  it('two-member runs collapse (this is what EOS writes), and run boundaries keep ORDER', () => {
    expect(collapseRange(['1', '2'])).toEqual(['1-2'])
    expect(collapseRange(['10', '11', '12', '20', '30', '31', '32', '33'])).toEqual(['10-12', '20', '30-33'])
  })

  it('duplicates collapse against their neighbour exactly as upstream: "1,1,2" -> ["1","1-2"]', () => {
    // upstream: collapse_range('1,1,2') -> ['1', '1-2']
    expect(collapseRange('1,1,2')).toEqual(['1', '1-2'])
    expect(collapseRange('1,2,1,2')).toEqual(['1-2', '1-2']) // upstream ['1-2', '1-2'] — duplicated runs in, duplicated out
  })
})

describe('collapseRange — input shapes and the upstream artefacts this port refuses', () => {
  it('accepts a readonly list as well as a delimited string (upstream crashes on lists)', () => {
    // upstream: collapse_range(['1','2','3']) -> AttributeError: 'list' object has no attribute
    // 'split' (`arg.split` at utils.py:210) even though its docstring says "The list of values"
    // (utils.py:202). MIGRATION.md §5 row 46.
    const list: readonly string[] = ['1', '2', '3', '7']
    expect(collapseRange(list)).toEqual(['1-3', '7'])
    expect(collapseRange('1,2,3,7')).toEqual(['1-3', '7'])
  })

  it('the truthiness artefacts: upstream silently corrupts empty tokens and zero-started runs', () => {
    // All transcribed from upstream on 2026-11-02 (utils.py:214/:218/:226 truthiness tests):
    //   collapse_range('1,2,')  -> ['1-2', '']           (trailing empty token survives)
    //   collapse_range('0,1')   -> ['1']                 (range_start = 0 is falsy at :226, the run
    //                                                     closes as a bare singleton — the 0 VANISHES)
    //   collapse_range('1,0,1') -> ['1', '1']            (same bug, second flavour)
    //   collapse_range('1,,2')  -> ValueError: invalid literal for int() with base 10: '' (at :215)
    // The module header previously cited `['1','0','2']` for the last one — that was never upstream's
    // answer; the real artefacts are the first three, and every shape throws here (row 47):
    expect(() => collapseRange('1,2,')).toThrow('collapseRange: "" is not an integer')
    expect(() => collapseRange('1,,2')).toThrow('collapseRange: "" is not an integer')
    expect(() => collapseRange('')).toThrow('collapseRange: "" is not an integer') // upstream ['']
    expect(collapseRange('0,1')).toEqual(['0-1']) // upstream ['1'] — the zero would have been dropped
    expect(collapseRange('1,0,1')).toEqual(['1', '0-1']) // upstream ['1', '1']
  })

  it('endpoints are CANONICALISED here; upstream leaks their raw spelling into ranges', () => {
    // upstream: collapse_range('01,02') -> ['1-02'] — the run start was int()-ified (:215) but the
    // closing token takes the raw-string branch (:227 uses `v1` as the unsplit text when the pair
    // test ran on ints, and :231 keeps strings wholesale), and the final `[str(x) for x in values]`
    // (:232) never re-canonicalises. Ours always emits canonical decimals (MIGRATION.md §5 row 48):
    expect(collapseRange('01,02')).toEqual(['1-2'])
    expect(collapseRange(' +7,+9 ')).toEqual(['7', '9']) // upstream ['7', '+9 '] — spacey bytes leak raw
  })
})

describe('delimiters — pyeapi keyword defaults and the guards upstream lacks', () => {
  it('custom valueDelimiter splits like pyeapi keyword args do', () => {
    // upstream: expand_range('1-3', value_delimiter=':') -> ['1', '2', '3'] (utils.py:175 signature)
    expect(expandRange('1:2:3', { valueDelimiter: ':' })).toEqual(['1', '2', '3'])
    expect(collapseRangeToString('10:11:12', { valueDelimiter: ':' })).toBe('10-12')
  })

  it('custom rangeDelimiter only BUILDS runs here — upstream never parses with it either', () => {
    // upstream: collapse_range('1,2,3', ',', '/') -> ['1/3'] (the delimiter appears only in the
    // '{}'-'{}'-'{}' FORMAT at utils.py:221/:227, never when reading input).
    expect(collapseRange(['1', '2', '3'], { rangeDelimiter: '/' })).toEqual(['1/3'])
    // expandRange DOES read with it — the symmetric form:
    expect(expandRange('1/3', { rangeDelimiter: '/' })).toEqual(['1', '2', '3'])
  })

  it('degenerate delimiters are refused up front, where upstream scrambles silently', () => {
    // upstream: expand_range('1-3', '-', '-') splits on '-' then treats every piece as a range —
    // no guard exists. This port refuses the nonsense configuration itself (row 47):
    expect(() => expandRange('1-3', { valueDelimiter: '-', rangeDelimiter: '-' })).toThrow(
      'range delimiters must differ, got "-" for both',
    )
    expect(() => collapseRange('1-3', { valueDelimiter: '', rangeDelimiter: '-' })).toThrow(
      'range delimiters must be non-empty strings',
    )
  })
})

describe('sortedRangeValues — the canonical pre-collapse shape (#8 addition, no upstream equivalent)', () => {
  it('de-duplicates and numerically sorts, and REFUSES range tokens (expand first)', () => {
    const members = expandRange('20,10-12,11') // [20, 10, 11, 12, 11] exactly as the device spelled it
    expect(sortedRangeValues(members)).toEqual(['10', '11', '12', '20'])
    expect(collapseRangeToString(sortedRangeValues(members))).toBe('10-12,20')
    expect(() => sortedRangeValues('20,10-12,11')).toThrow('sortedRangeValues: "10-12" is not an integer range endpoint')
  })
})

describe('collapseRangeToString — the device-ready join (MIGRATION.md §5 row 48)', () => {
  it('joins with the value delimiter, where upstream returns a list and leaves the join to the caller', () => {
    // upstream: collapse_range('1,2,3,7') -> ['1-3', '7'] and `utils.py:232` is the last line — no
    // joined form exists; EOS wants '1-3,7' inside a `switchport trunk allowed vlan` command.
    expect(collapseRangeToString(['1', '2', '3', '7'])).toBe('1-3,7')
    expect(collapseRangeToString('1,2,3,7')).toBe('1-3,7')
    expect(collapseRangeToString(['1', '2', '3'], { valueDelimiter: ',', rangeDelimiter: '-' })).toBe('1-3')
  })
})

describe('property: collapseRange(expandRange(x)) round-trips (PLAN M6 fast-check box)', () => {
  /**
   * Generator invARIANT — every generated input is something `expandRange` accepts:
   * a non-empty, LEFT-TO-RIGHT ASCENDING list of `a-b` runs and singletons (`next.start > prev.end`,
   * so tokens never overlap or duplicate), `0 <= start <= end <= 4095` written as plain decimals —
   * no signs, no zero padding, no surrounding whitespace. That is precisely the space of well-formed
   * `switchport trunk allowed vlan` / `vlan` range spellings; the padded/negative/spacey shapes the
   * property would also survive are excluded because the invariant must stay checkable by reading
   * the generator, not the implementation.
   *
   * `canonical` recomputes the expected collapsed spelling from the generated (start,end) runs
   * THEMSELVES — an independent walk over number spans — so the property asserts agreement between
   * two unrelated code paths rather than restating the implementation. Adjacent generated runs
   * (`gap === 1`) are allowed on purpose: expansion makes them one contiguous numeric run, and
   * collapsing must MERGE them back, which is exactly what a VLAN range editor needs.
   */
  const runsArb = fc
    .tuple(fc.integer({ min: 0, max: 100 }), fc.array(fc.record({ gap: fc.integer({ min: 1, max: 15 }), len: fc.integer({ min: 0, max: 10 }) }), { minLength: 0, maxLength: 6 }))
    .map(([firstStart, tails]) => {
      const runs: { start: number; end: number }[] = []
      let cursor = firstStart
      let previousEnd: number | undefined
      for (const tail of tails) {
        cursor = (previousEnd ?? cursor - 1) + tail.gap
        runs.push({ start: cursor, end: cursor + tail.len })
        previousEnd = cursor + tail.len
      }
      if (runs.length === 0) runs.push({ start: firstStart, end: firstStart })
      return runs
    })

  function canonical(runs: readonly { start: number; end: number }[]): string[] {
    const out: string[] = []
    let runStart = runs[0]!.start
    let runEnd = runs[0]!.end
    for (const run of runs.slice(1)) {
      if (run.start === runEnd + 1) {
        runEnd = run.end
        continue
      }
      out.push(runStart === runEnd ? `${runStart}` : `${runStart}-${runEnd}`)
      runStart = run.start
      runEnd = run.end
    }
    out.push(runStart === runEnd ? `${runStart}` : `${runStart}-${runEnd}`)
    return out
  }

  it('expands then collapses to the independent canonical form; members are ordered and unique', () => {
    fc.assert(
      fc.property(runsArb, (runs) => {
        const x = runs.map((run) => (run.start === run.end ? `${run.start}` : `${run.start}-${run.end}`)).join(',')
        const members = expandRange(x)
        // every run fully expanded, in token order (the generator's own invariant again, re-checked):
        const expectedMembers = runs.flatMap((run) => Array.from({ length: run.end - run.start + 1 }, (_, k) => String(run.start + k)))
        expect(members).toEqual(expectedMembers)
        expect(collapseRange(members)).toEqual(canonical(runs))
        expect(collapseRangeToString(members)).toBe(canonical(runs).join(','))
      }),
      { numRuns: 300 },
    )
  })
})
