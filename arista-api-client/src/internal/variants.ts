/**
 * Command-sequence variants — M4 (#6), the port of `pyeapi/utils.py` `CliVariants`
 * (`utils.py:235-274`, BSD-3-Clause, Arista Networks — DR-001) **re-shaped** per DR-006:
 * "keep as `tryVariants()` utility, not a type-level magic".
 *
 * Upstream, a `CliVariants` object is a *marker* that `Node.config()` hunts for inside the command
 * list (`client.py:628-633` finds it with a `[type(v) for v in cmds].index(CliVariants)` scan) and
 * then splices into the sequence (`client.py:645-652`), trying each alternative until one succeeds
 * and re-raising the last `CommandError` if all fail. In TypeScript that marker has no honest type:
 * a command list is `CommandSpec[]`, so a foreign object in it would either be `any` or be rejected
 * by `buildRequest`'s command-object check. So the variants are passed **beside** the command list
 * instead of hidden inside it, and there is no type to scan for.
 *
 * What is deliberately **not** ported: `CliVariants.expand` (`utils.py:245-269`), which computes the
 * full cross-product of several `CliVariants` markers in one list. pyeapi's own `config()` never uses
 * it — `client.py:645-652` reads only the *first* marker and its `.variants`, and its docstring says
 * "only a single occurrence of CliVariants type in commands is supported" (`client.py:605-606`).
 * Nesting `tryVariants` calls expresses the same thing with visible control flow.
 * MIGRATION.md §5 row 37.
 *
 * Pure apart from awaiting the injected `send`; the only failure class that advances to the next
 * variant is `CommandError` — a `TransportError`/`ProtocolError` means the round trip itself broke,
 * and trying the next CLI spelling of a command the device never received is how a half-applied
 * change set gets doubled.
 */

import { CommandError } from '../errors'
import { toCommandSpecArray } from './wire'
import type { CommandSpec } from '../types/eapi'

/** One alternative: a command, or the sequence of commands that only work together. */
export type CliVariant = CommandSpec | readonly CommandSpec[]

/** What `tryVariants` calls per attempt — `node.configure` is the usual one (see `Node.configureVariants`). */
export type VariantSender<TResult> = (commands: readonly CommandSpec[]) => Promise<TResult>

/**
 * Try each variant in order, return the first success, re-raise the **last** `CommandError` when all
 * of them fail (pyeapi `client.py:645-652`, including its `raise err` at `:652`).
 *
 * pyeapi asserts the same thing twice (`utils.py:260`, `:272`: "must be initialized with 2 or more
 * arguments"): a single variant is a caller who meant something else, so `TypeError` rather than a
 * silently-degenerate loop of one.
 *
 * @typeParam TResult - whatever the sender returns; `configure()` gives `readonly CommandResult[]`.
 */
export async function tryVariants<TResult>(
  variants: readonly CliVariant[],
  send: VariantSender<TResult>,
): Promise<TResult> {
  if (!Array.isArray(variants)) {
    throw new TypeError('tryVariants expects an array of command variants, e.g. [[cmdA, cmdB], [cmdC]]')
  }
  if (variants.length < 2) {
    throw new TypeError(
      `tryVariants needs 2 or more command variants (pyeapi utils.py:272 says the same); got ${String(variants.length)}`,
    )
  }
  const sequences = variants.map((variant) => toCommandSpecArray(variant))
  let lastFailure: CommandError | undefined
  for (const commands of sequences) {
    try {
      return await send(commands)
    } catch (error) {
      if (!(error instanceof CommandError)) throw error
      lastFailure = error
    }
  }
  // Every attempt failed with a device-side command error. The last one is the most informative:
  // it is the spelling the caller is most likely to recognise (pyeapi re-raises `err`, the last one).
  throw lastFailure as CommandError
}
