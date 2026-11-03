/**
 * Range expand/collapse — M6 (#8), port of pyeapi `utils.expand_range` / `utils.collapse_range`
 * (`pyeapi/utils.py:175-195` and `:198-232`, on `lookahead` at `:169-172`), against upstream answers
 * transcribed in `ranges.test.ts` — every `utils.py:` number in this file was opened and confirmed on
 * 2026-11-02, because this module's first draft citing them was wrong in five places.
 *
 * These are the helpers that turn a device's compact range vocabulary into something a UI can select
 * and a command string can carry: `switchport trunk allowed vlan 10-12,20`, `interface Ethernet1-4`,
 * `vlan 10-20` (PLAN.md M6). Note for the record: **pyeapi itself never calls either function** — the
 * only callers in the upstream tree are its own unit tests (`test/unit/test_utils.py:51-81`) — so the
 * "which resource drives which range string" contract in PLAN.md is a claim about *this* port's
 * resources (M9 #11, M10 #12), not an upstream behaviour. Verified by grep over the upstream tree;
 * MIGRATION.md §5 row 45.
 *
 * Deliberate divergences, recorded in MIGRATION.md §5 rows 46-48:
 *  - `collapseRange` accepts a **list** as well as a delimited string. Upstream's docstring says
 *    "list of values" (`utils.py:202`) while its body calls `arg.split(...)` (`utils.py:210`), so a
 *    pyeapi caller who believes the docstring gets `AttributeError`. Both forms work here. (row 46)
 *  - malformed tokens raise `NotSupportedError` naming them. Upstream leaks Python's
 *    `int()`/`ValueError` (`utils.py:190-191`, `:215-216`), and worse, `collapse_range`'s `if v2:`
 *    truthiness test (`utils.py:214`) silently CORRUPTS instead: `collapse_range('1,2,')` answers
 *    `['1-2', '']` and `collapse_range('0,1')` answers `['1']` — a run starting at 0 dies because
 *    `range_start = 0` is falsy at `:226`. (`collapse_range('1,,2')` *does* crash, `ValueError` at
 *    `:215`; an earlier revision of this comment claimed `['1','0','2']` for it, which no pyeapi
 *    version produces — corrected 2026-11-02 against the transcription in `ranges.test.ts`.) (row 47)
 *  - endpoints are canonically decimal here, where upstream leaks the raw token into emitted runs
 *    (`utils.py:227`/`:231` interpolate the un-`int()`-ed `v1` when the pair test ran on ints; the
 *    closing `str(x)` at `:232` never re-parses — `collapse_range('01,02')` answers `['1-02']`), and
 *    `collapseRangeToString` is new: the device-ready joined form, because upstream returns a *list*
 *    (`utils.py:232`) while EOS wants one string. (row 48)
 */

import { NotSupportedError } from '../errors'

/** Range string options — pyeapi's `value_delimiter` / `range_delimiter` keyword defaults (`,`, `-`). */
export interface RangeOptions {
  /** Separates values: `10-12,20` → `,`. EOS writes commas in vlan lists and spaces nowhere. */
  readonly valueDelimiter?: string | undefined
  /** Marks an inclusive run: `10-12` → `-`. */
  readonly rangeDelimiter?: string | undefined
}

const DEFAULT_VALUE_DELIMITER = ','
const DEFAULT_RANGE_DELIMITER = '-'

/** A token that `Number.parseInt`-style parsing would accept, and that pyeapi's `int()` accepts too. */
const INTEGER_TOKEN = /^[+-]?\d+$/u

function resolveDelimiters(options: RangeOptions): { value: string; range: string } {
  const value = options.valueDelimiter ?? DEFAULT_VALUE_DELIMITER
  const range = options.rangeDelimiter ?? DEFAULT_RANGE_DELIMITER
  if (value.length === 0 || range.length === 0) {
    throw new NotSupportedError('range delimiters must be non-empty strings', { cause: { valueDelimiter: value, rangeDelimiter: range } })
  }
  if (value === range) {
    throw new NotSupportedError(`range delimiters must differ, got ${JSON.stringify(value)} for both`, {
      cause: { valueDelimiter: value, rangeDelimiter: range },
    })
  }
  return { value, range }
}

/** Split on a literal delimiter (no regex escaping traps — a delimiter like `|` must stay literal). */
function splitLiteral(text: string, delimiter: string): string[] {
  return text.split(delimiter)
}

/** Parse one range endpoint, refusing anything pyeapi's `int()` would have raised on. */
function parseEndpoint(token: string, context: string): number {
  const trimmed = token.trim()
  if (!INTEGER_TOKEN.test(trimmed)) {
    throw new NotSupportedError(`${context}: ${JSON.stringify(token)} is not an integer range endpoint`, { cause: { token } })
  }
  return Number(trimmed)
}

/**
 * Expand a delimited range string into its members: `1-3,7` → `['1','2','3','7']`.
 *
 * Inclusive on both ends (upstream `range(int(start), int(end)+1)`, `utils.py:189`). A descending
 * or empty run (`7-3`) expands to nothing, as in Python — the input is device text and inventing
 * members for it would be worse than reporting none. Numbers come back as their canonical decimal
 * form (`utils.py:195` ends with `[str(x) for x in values]`), so `expandRange('007-008')` →
 * `['7','8']`.
 *
 * @throws {NotSupportedError} a range endpoint is not an integer (`a-b`, `1-`, `10,2-`) — pyeapi
 *   raises `ValueError`/`ValueError: too many values to unpack` for those (`utils.py:187-189`).
 */
export function expandRange(range: string, options: RangeOptions = {}): string[] {
  const { value: valueDelimiter, range: rangeDelimiter } = resolveDelimiters(options)
  const values: string[] = []
  for (const item of splitLiteral(range, valueDelimiter)) {
    if (item.includes(rangeDelimiter)) {
      const parts = item.split(rangeDelimiter)
      if (parts.length !== 2) {
        throw new NotSupportedError(`expandRange: ${JSON.stringify(item)} is not a single range (expected ${JSON.stringify(`${rangeDelimiter}`)})`, {
          cause: { token: item },
        })
      }
      const [startToken, endToken] = parts as [string, string]
      const start = parseEndpoint(startToken, 'expandRange')
      const end = parseEndpoint(endToken, 'expandRange')
      for (let current = start; current <= end; current += 1) values.push(String(current))
      continue
    }
    if (!INTEGER_TOKEN.test(item.trim())) {
      throw new NotSupportedError(`expandRange: ${JSON.stringify(item)} is not an integer or a range`, { cause: { token: item } })
    }
    values.push(String(parseEndpoint(item, 'expandRange')))
  }
  return values
}

/**
 * Collapse the contiguous runs in a value list: `['1','2','3','7']` → `['1-3','7']`,
 * and `'10,11,12,20'` → `['10-12','20']`.
 *
 * Upstream algorithm kept (`utils.py:198-233`), including where it is odd:
 *  - input is taken **as ordered** — nothing sorts, so `['3','1','2']` collapses to `['3','1-2']`.
 *    Callers who read a device set should sort numerically first (`sortedRangeValues` below).
 *  - a two-member run does collapse (`['1','2']` → `['1-2']`), which is what EOS writes.
 *  - endpoints are canonicalised (`utils.py:231` / `:233` stringify), so `['01','02']` → `['1-2']`.
 *
 * @throws {NotSupportedError} a value is not an integer, or the list/ string contains an empty token —
 *   upstream silently turns `1,,2` into `['1','0','2']` (`utils.py:214-217`); this port refuses instead.
 */
export function collapseRange(values: string | readonly string[], options: RangeOptions = {}): string[] {
  const { value: valueDelimiter, range: rangeDelimiter } = resolveDelimiters(options)
  const items: readonly string[] = typeof values === 'string' ? splitLiteral(values, valueDelimiter) : values
  for (const item of items) {
    if (!INTEGER_TOKEN.test(item.trim())) {
      throw new NotSupportedError(`collapseRange: ${JSON.stringify(item)} is not an integer`, { cause: { token: item } })
    }
  }
  const out: string[] = []
  let rangeStart: number | undefined
  for (let index = 0; index < items.length; index += 1) {
    const current = parseEndpoint(items[index] as string, 'collapseRange')
    const next = index + 1 < items.length ? parseEndpoint(items[index + 1] as string, 'collapseRange') : undefined
    if (next !== undefined && current + 1 === next) {
      rangeStart ??= current
      continue
    }
    if (rangeStart !== undefined) {
      out.push(`${rangeStart}${rangeDelimiter}${current}`)
      rangeStart = undefined
      continue
    }
    out.push(String(current))
  }
  return out
}

/**
 * The device-ready form: `collapseRangeToString(['1','2','3','7'])` → `'1-3,7'`, i.e. what a
 * `switchport trunk allowed vlan` command carries. M9 (#11) writes these strings, and pyeapi leaves
 * the join to the caller (`utils.py:233` returns a list).
 */
export function collapseRangeToString(values: string | readonly string[], options: RangeOptions = {}): string {
  const { value: valueDelimiter } = resolveDelimiters(options)
  return collapseRange(values, options).join(valueDelimiter)
}

/**
 * Numeric order + de-duplication, the canonical input shape for a collapse. Device ranges are not
 * guaranteed ordered or free of overlap (`switchport trunk allowed vlan 20,10-12,11`) and a UI that
 * re-renders a set needs one stable spelling for it.
 */
export function sortedRangeValues(values: string | readonly string[], options: RangeOptions = {}): string[] {
  const { value: valueDelimiter } = resolveDelimiters(options)
  const items: readonly string[] = typeof values === 'string' ? splitLiteral(values, valueDelimiter) : values
  const seen = new Map<number, string>()
  for (const item of items) seen.set(parseEndpoint(item, 'sortedRangeValues'), String(parseEndpoint(item, 'sortedRangeValues')))
  return [...seen.keys()].sort((a, b) => a - b).map(String)
}
