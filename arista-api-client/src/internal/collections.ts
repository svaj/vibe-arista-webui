/**
 * `toArray` — the explicit iterable boundary, M7 (#9). Port of pyeapi `utils.make_iterable`
 * (`pyeapi/utils.py:147-166`), which every upstream resource calls before touching a command list.
 *
 * Upstream's shape is two rules: a `str`, a `dict` or a `CliVariants` marker becomes a one-element list
 * (`:159-161`), anything else must already be iterable or it raises `TypeError('value must be an
 * iterable object')` (`:163-164`). What it does **not** do is copy: `make_iterable` hands back the very
 * list the caller passed, and that is the whole cause of the bug at `api/abstract.py:176-177` —
 * `configure_interface` runs `commands = make_iterable(commands)` and then `commands.insert(0, …)`, so
 * a caller who passes a reusable list of commands gets `interface X` spliced permanently into their own
 * array and sends it twice on the next call. Verified by opening both files on 2026-11-03.
 *
 * So the port keeps the coercion and drops the aliasing: an array in, a **new** array out. DR-041 asks
 * for exactly that ("`make_iterable`'s implicit coercion becomes explicit `toArray()` at the boundary"),
 * and MIGRATION.md §1 already listed `src/internal/collections.ts` as the planned home. MIGRATION.md
 * §5 row 71 records the copy; row 72 records what was deliberately not ported.
 */

import { NotSupportedError } from '../errors'

/** `Array.isArray` behind a predicate, so the generic `T | readonly T[]` narrows without a cast. */
function isValueArray<T>(value: T | readonly T[]): value is readonly T[] {
  return Array.isArray(value)
}

/**
 * Normalise "one command or a list of commands" into a fresh list.
 *
 * `toArray('vlan 20')` → `['vlan 20']`; `toArray(['vlan 20'])` → a copy of the caller's array.
 * The copy is not a style choice — every command-list helper in this package is allowed to prepend or
 * append freely (see the module header), and a caller's array must never be one of the things it mutates.
 *
 * **Not ported (MIGRATION.md §5 row 72):** pyeapi also accepts any Python `Iterable`, so a generator,
 * `set` or dict-of-keys passes through `make_iterable` untouched and silently keeps whatever element
 * shape it had. JS has two iterable families that are not arrays (`Set`, `Map`, generators), and
 * accepting them here would mean guessing whether `toArray(new Set([...]))` means "one value" or
 * "spread it". Callers pass a value or an array (or `Array.from` themselves) — DR-004's
 * "explicit typed methods, no duck typing".
 *
 * @throws {NotSupportedError} `undefined` or `null`, i.e. the caller forgot the value. pyeapi's
 *   `make_iterable(None)` answers… `None`, which is not iterable, so it raises `TypeError` at `:164`;
 *   the equivalent here is an `EapiError` subclass that names what was expected.
 */
export function toArray<T>(value: T | readonly T[]): T[] {
  if (isValueArray(value)) return [...value]
  if (value === undefined || value === null) {
    throw new NotSupportedError(
      'expected a value or an array of values, received nothing — pass the single command, not undefined (pyeapi raises TypeError from utils.make_iterable; MIGRATION.md §5 row 72)',
      { cause: value },
    )
  }
  return [value as T]
}
