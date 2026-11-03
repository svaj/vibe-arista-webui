/**
 * Shared resource-framework types, M7 (#9). The framework itself is `base.ts` (port of
 * `pyeapi/api/abstract.py`); this file holds the shapes that several framework modules — and every
 * wave-1/wave-2 resource module (#10-#17) — need, so none of them re-declares them.
 *
 * Nothing here is a decorative alias: each type is a parameter or return position that
 * `command-builder.ts` / `base.ts` / `registry.ts` actually use at runtime, and DR-040 keeps the public
 * surface to what `src/index.ts` re-exports.
 */

import type { CommandSpec } from '../types/eapi'

/**
 * What a verb should do to a command line. DR-037 replaced pyeapi's four positional arguments
 * (`command_builder(string, value, default, disable)`, `abstract.py:129`) with this union, and
 * `commandBuilder` keeps upstream's evaluation order — `default` before `no` before `value` — so a
 * caller who passes a leftover value cannot change the answer of an explicitly negated command.
 */
export type CommandMode = 'set' | 'no' | 'default'

/**
 * A value a command may carry. `true` means "the bare command" (`abstract.py:156-157`, e.g.
 * `ip routing`); `false` is **not** representable, because negation needs a mode — see
 * {@link CommandOptions}. Numbers are stringified by the builder.
 */
export type CommandValue = string | number | true

/**
 * The one options bag replacing pyeapi's `value=` / `default=` / `disable=` kwargs (DR-037).
 *
 * Both fields are optional because both halves of pyeapi's call sites exist: an explicit
 * `{ mode: 'default' }` and a value-only `command_builder('mtu', value=1500)`. What is **not** accepted
 * is neither field — upstream falls through to `'no %s'` there (`abstract.py:160-165`, with the
 * `ValueError` commented out beside it, i.e. upstream itself calls that path deprecated), and this
 * client throws instead.
 */
export interface CommandOptions {
  /** The value to append, or `true` for the bare command. Ignored when `mode` is `'no'`/`'default'`. */
  readonly value?: CommandValue | undefined
  /** Which form to emit. Absent means `'set'`, i.e. `value` is required. */
  readonly mode?: CommandMode | undefined
}

/** A command list a resource verb may hand to the device — pyeapi's "list or bare string" input. */
export type CommandInput = CommandSpec | readonly CommandSpec[]

/** Keys of a resource collection: VLAN ids are numbers, interface names are strings (MIGRATION.md §4). */
export type ResourceKey = string | number

/**
 * A device table: `getAll()`'s answer. pyeapi returns a Python `dict`
 * (`EntityCollection.getall`, `abstract.py:220`) and this port returns a `Map` — MIGRATION.md §5 row 78
 * — because a numeric VLAN id must stay a number and DR-004's explicit membership verbs (`has`, `keys`,
 * `entries`) fall out of the same shape instead of being re-derived from an object's key list.
 */
export type ResourceTable<K extends ResourceKey, T> = ReadonlyMap<K, T>

/**
 * The attribute bag a `create` verb accepts. Upstream either has no attributes at all
 * (`vlans.create(self, vid)` — `vlans.py:194`) or spells them as extra kwargs
 * (`staticroute.create(self, ip_dest, next_hop, **kwargs)` — `staticroute.py:182`;
 * `users.create(self, name, nopassword=None, secret=None, encryption=None)` — `users.py:151`;
 * `vrfs.create(self, vrf_name, rd=None)` — `vrfs.py:152`). Kept deliberately wide at the framework
 * level: each module narrows it to a named interface (MIGRATION.md §4 "one `options` object per
 * method"), and M9 (#11) defines the first real one.
 */
export type ResourceAttrs = Readonly<Record<string, string | number | boolean>>
