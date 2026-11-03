/**
 * `commandBuilder` / `submodeCommands` — the command-string builders, M7 (#9).
 *
 * Port of pyeapi `BaseEntity.command_builder` (`pyeapi/api/abstract.py:129-164`) and of the
 * `configure_interface` splice (`abstract.py:166-179`). Upstream's builder takes four positional-or-
 * keyword arguments and evaluates them in the order **default → disable → value** (`:150-159`):
 *
 * ```python
 * if default:            return 'default %s' % string      # :150-151
 * elif disable:          return 'no %s' % string           # :152-153
 * elif value is True:    return string                     # :154-155
 * elif value:            return '%s %s' % (string, value)  # :156-157
 * else:                  return 'no %s' % string           # :158-159, "to be deprecated"
 * ```
 *
 * DR-037 replaces the kwargs with `{ mode, value }` and deletes the last line (upstream itself has the
 * replacement `raise ValueError(...)` commented out at `:162-164`, and `test/unit/test_api_bgp.py:117`
 * and eleven siblings say "If command_builder fails because value is None, uncomment" — i.e. upstream's
 * own tests are pre-armed for the fix this port makes). The **order** still matters and is pinned by
 * command-builder.test.ts: a `mode` always wins over a leftover `value`, because a resource verb that
 * forwards both would otherwise change what gets written to a switch.
 *
 * Two upstream fall-throughs are refused rather than reproduced (MIGRATION.md §5 row 66):
 *  - `value = false` / `value = 0` / `value = ''` — Python's `elif value:` sends the `no` form, so
 *    `set_mtu(0)` becomes `no mtu` and a UI reads back a config the operator never asked for;
 *  - no `mode` and no `value` at all — upstream's deprecated `return 'no %s'`.
 *
 * There is no `test/unit/test_abstract.py` upstream to port: `abstract.py` is covered only by the
 * expectations embedded in each module's tests (`test_api_system.py`, `test_api_switchports.py`, …), so
 * the truth table here is built from the code plus those embedded expectations. MIGRATION.md §6 lists
 * `src/resources/base.test.ts` + `command-builder.test.ts` as the framework's test home.
 */

import { NotSupportedError } from '../errors'
import { pythonRepr } from '../internal/wire'
import type { CommandSpec } from '../types/eapi'
import type { CommandInput, CommandMode, CommandOptions } from './types'
import { toArray } from '../internal/collections'

/** The modes this builder accepts. A runtime string from JS that is not one of these is refused. */
const COMMAND_MODES: readonly CommandMode[] = ['set', 'no', 'default']

/**
 * Code points that would end a CLI line. A `value` carrying one of these would smuggle a second command
 * into a single `CommandSpec` string — pyeapi interpolates blindly (`:157`), so the device would execute
 * something the caller never named. Not an attack model so much as an "a UI pasted the wrong blob" model.
 * The set matches the line boundaries `src/config/text.ts` splits on, minus `\u001c`-`\u001e`.
 * MIGRATION.md §5 row 67 (a multiline command is a `{ cmd, input }` object — DR-015).
 */
const LINE_BOUNDARY = /[\r\n\v\f\u0085\u2028\u2029]/u

/** A command's own text must be present and single-line; the value is checked separately below. */
function assertCommandText(command: string): void {
  if (typeof command !== 'string' || command.trim() === '') {
    throw new NotSupportedError(
      `commandBuilder expects a non-empty command string, received ${pythonRepr(command)}`,
    )
  }
  if (LINE_BOUNDARY.test(command)) {
    throw new NotSupportedError(
      `commandBuilder received a command string containing a line boundary (${pythonRepr(command)}) — one CommandSpec per command line`,
    )
  }
}

/** How a rejected `value` is described: the bad input has to appear in the message (issue #9). */
function refuseValue(command: string, value: unknown, why: string): never {
  throw new NotSupportedError(
    `commandBuilder(${pythonRepr(command)}): rejected ${pythonRepr(value)} — ${why}`,
  )
}

/** `mode` is a union at compile time; a caller arriving from JS (or a decoded profile) can still hand us junk. */
function resolveMode(mode: CommandMode | undefined): CommandMode | undefined {
  if (mode === undefined) return undefined
  if (!COMMAND_MODES.includes(mode)) {
    refuseValue('<mode>', mode, `mode must be one of ${COMMAND_MODES.join(' / ')}`)
  }
  return mode
}

/**
 * Build one command line from a command stem plus an options bag.
 *
 * | input | answer | upstream |
 * |---|---|---|
 * | `{ mode: 'default' }` | `default ip routing` | `default=True` (`:150-151`) |
 * | `{ mode: 'default', value: 'x' }` | `default ip routing` | same — default preempts value |
 * | `{ mode: 'no' }` | `no ip routing` | `disable=True` (`:152-153`) |
 * | `{ mode: 'no', value: 'x' }` | `no ip routing` | same — disable preempts value |
 * | `{ value: true }` | `ip routing` | `value=True` (`:154-155`) |
 * | `{ value: 1500 }` | `mtu 1500` | `value=1500` (`:156-157`) |
 * | `{ value: 'WAN access' }` | `name WAN access` | same |
 * | `{}` · `{ mode: 'set' }` | **throws** | `'no %s'` (`:158-159`, deprecated) |
 * | `{ mode: 'set', value: false }` | **throws** | `'no %s'` (`elif value:`) |
 * | `{ value: 0 }` | `mtu 0` | `'no mtu'` — refused, MIGRATION.md §5 row 66 |
 *
 * `mode` defaults to `'set'`, so a value-only call reads like the pyeapi call it replaces. A `number`
 * `0` is a real value here; `false`, `null`, `undefined`, `NaN`, an object, an array, and an all-whitespace
 * string are refused, each naming the rejected input.
 *
 * @throws {NotSupportedError} always a programming/input mistake, never a device condition —
 *   `docs/ARCHITECTURE.md` §4 reserves the `EapiError` subclasses for those, and `NotSupportedError`
 *   is what §5 of that file already uses for "an option this client refuses".
 */
export function commandBuilder(command: string, options: CommandOptions = {}): string {
  assertCommandText(command)
  const { mode, value } = options
  const resolved = resolveMode(mode)
  // 1. default — `abstract.py:150-151`, preempts everything.
  if (resolved === 'default') return `default ${command}`
  // 2. disable — `abstract.py:152-153`, preempts value.
  if (resolved === 'no') return `no ${command}`
  // 3. value — `abstract.py:154-157`.
  if (value === undefined) {
    if (mode === 'set') {
      refuseValue(command, value, "mode: 'set' needs a value; pass mode: 'no' or mode: 'default' to negate (pyeapi falls through to the deprecated 'no X' — DR-037)")
    }
    refuseValue(command, value, 'no value and no mode — pyeapi returns the deprecated `no` form (abstract.py:158-164); say what you mean with mode: "no" or mode: "default" (DR-037)')
  }
  if (value === true) return command
  if (typeof value !== 'string' && typeof value !== 'number') {
    refuseValue(command, value, 'a value must be a string, a number, or true — negation is mode: "no", not a falsy value (DR-037)')
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    refuseValue(command, value, 'NaN and Infinity are not configuration values')
  }
  const text = String(value)
  if (text.trim() === '') {
    refuseValue(command, value, 'an empty value would send a trailing space and read back as the bare command — use mode: "no" (DR-037)')
  }
  if (LINE_BOUNDARY.test(text)) {
    refuseValue(command, value, 'a value must not contain a line boundary — one command line per CommandSpec; use { cmd, input } for a multiline command (DR-015)')
  }
  return `${command} ${text}`
}

/**
 * Prepend a submode entered on its own line — `interface Ethernet1`, `vlan 20`, `router bgp 65001` — to
 * a command list, **returning a new array**.
 *
 * This is the fixed form of `BaseEntity.configure_interface` (`abstract.py:176-177`) and of
 * `Vlans.configure_vlan` (`vlans.py:243-244`), both of which call `make_iterable` (no copy) and then
 * `commands.insert(0, …)`, mutating the caller's array. A caller who reuses a command list therefore
 * gets the parent line spliced once per call on upstream, and the parent line duplicated in later
 * commands. `toArray` (MIGRATION.md §5 row 64) supplies the copy, so this function can never write
 * through to a caller's array, and wrapping happens exactly once per call.
 *
 * The parent command's text is validated the same way {@link commandBuilder} validates a command stem,
 * because a bad parent (empty, or carrying a newline) is how a resource would otherwise send
 * `interface` alone or two commands in one string (MIGRATION.md §5 row 67). Element shape is not
 * re-validated: the wire codec (`src/internal/wire.ts` → `buildRequest`) already refuses a command
 * object with an unknown key.
 *
 * There is no "already wrapped?" check: passing a list that begins with the parent sends the parent line
 * twice, which EOS tolerates (it re-enters the same submode) and which a module test would catch. Adding
 * a dedupe rule here would hide a module that builds its own parent line in two places.
 */
export function submodeCommands(parent: string, commands: CommandInput): CommandSpec[] {
  if (parent.trim() === '') {
    throw new NotSupportedError('submodeCommands needs a non-empty parent command')
  }
  if (LINE_BOUNDARY.test(parent)) {
    throw new NotSupportedError(
      `submodeCommands received a parent command containing a line boundary (${pythonRepr(parent)}) — one command line per CommandSpec`,
    )
  }
  const list = toArray(commands)
  return [parent, ...list]
}
