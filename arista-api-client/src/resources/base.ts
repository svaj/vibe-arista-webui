/**
 * `ResourceBase`, `Entity`, `EntityCollection` — the resource framework, M7 (#9).
 *
 * Port of `pyeapi/api/abstract.py` (224 lines, BSD-3-Clause, Arista Networks — DR-001):
 *
 * | pyeapi (verified refs) | here |
 * |---|---|
 * | `BaseEntity` (`:49`) | {@link ResourceBase} |
 * | `BaseEntity.__init__` (`:67-68`) | `constructor(node)` |
 * | `BaseEntity.version_number` (`:70-72`) | not exposed — call `node.getVersion()` (row 68) |
 * | `BaseEntity.config` property (`:74-76`) | {@link ResourceBase.config} (async, row 68) |
 * | `BaseEntity.error` property (`:78-80`) | **dropped** (DR-005) |
 * | `BaseEntity.get_block` (`:82-101`) | {@link ResourceBase.getBlock} |
 * | `BaseEntity.configure` (`:103-127`) | {@link ResourceBase.configure} — throws, no bool |
 * | `BaseEntity.command_builder` (`:129-164`) | {@link ResourceBase.commandBuilder} → `command-builder.ts` |
 * | `BaseEntity.configure_interface` (`:166-178`) | {@link ResourceBase.configureInterface} — non-mutating |
 * | `Entity` (`:181-196`, `Callable` via `__call__` at `:191`) | {@link Entity} — no `__call__` (DR-004) |
 * | `EntityCollection` (`:198-224`, `Mapping`) | {@link EntityCollection} — no `Mapping`/`__len__`/`__iter__`/`[]` |
 *
 * ## Verb naming rule (fixed — issue #9, PLAN.md M7; mirrored in docs/USAGE.md §6)
 *
 * | verb family | shape | example |
 * |---|---|---|
 * | read | `get()` / `getAll()` | `vlans.get(20)`, `vlans.getAll()` |
 * | write one field | `set<Field>(…)`, `unset<Field>()`, `default<Field>()` | `setMtu(1500)`, `unsetMtu()`, `defaultMtu()` |
 * | presence of an entry | `create(…)`, `delete(…)`, `setDefault(…)` | `create(20, { name: 'PROD' })` |
 * | collection membership | `add<X>(…)`, `remove<X>(…)` | `addTrunkGroup(20, 'red')` |
 *
 * Identical to pyeapi's names wherever pyeapi has them, so a MIGRATION row differs by case only. Two
 * families are **new**, both because DR-037 refuses pyeapi's negation-by-omission: `unset<Field>`/
 * `default<Field>` (upstream spells those as `disable=True`/`default=True` on the same `set_*` method,
 * e.g. `vlans.set_name` at `vlans.py:248-266`). And pyeapi's bare `default(name)` on a collection
 * (`vlans.py:218`) becomes `setDefault(name)`, because a method named `default` reads as a keyword in a
 * call chain. Rows 70/71 record it.
 *
 * Every verb **throws** — there is no return value to check and no `.error` to inspect afterwards
 * (DR-005 kills the `configure()`→`False` + `connection.error` idiom at `abstract.py:78-80`, `:117-127`).
 * A failed write rejects with the `CommandError` the device produced, `failedCommand` included, which is
 * what makes `arista-api-client/docs/USAGE.md` §7's error panel possible.
 *
 * Layering (docs/ARCHITECTURE.md §1): resources depend on `Node`, `Node` on the codec; a resource only
 * ever *builds* command lists and hands them to one `Node` (ARCHITECTURE §2's "emits command strings,
 * never sends them itself" is about not holding a transport — the send always goes through the `Node`,
 * which is where `configure terminal` prepending and cache invalidation live).
 */

import { toArray } from '../internal/collections'
import { commandBuilder, submodeCommands } from './command-builder'
import { assertInterfaceName } from './validators'
import type { ConfigSections } from '../config/chunk'
import type { Node, NodeConfigOptions, NodeRequestOptions } from '../command-layer'
import type { CommandResult } from '../types/eapi'
import type { CommandInput, CommandOptions, ResourceAttrs, ResourceKey, ResourceTable } from './types'

/**
 * The `Node` methods this framework drives. Structural, and checked by {@link assertResourceNode} rather
 * than by `instanceof`, so a test can hand a resource a real `Node` over `MockTransport` (the honest
 * configuration — `docs/TESTING.md §3`) while a JS caller that passes a partial object is refused at
 * construction with an actionable message instead of failing later inside a `configure()`.
 */
const REQUIRED_NODE_METHODS = ['getRunningConfig', 'getStartupConfig', 'chunkConfig', 'configure'] as const

function assertResourceNode(node: Node): void {
  const candidate = node as (Partial<Record<(typeof REQUIRED_NODE_METHODS)[number], unknown>> | undefined) | null
  const missing = REQUIRED_NODE_METHODS.filter((method) => typeof candidate?.[method] !== 'function')
  if (missing.length > 0) {
    throw new TypeError(
      `a resource needs a Node with ${missing.join(', ')} — build one with new Node(createTransport({ … })) (M4 #6) or MockTransport from the ./testing entry (M2 #4)`,
    )
  }
}

/**
 * The base every resource extends: the `Node` it operates on, the cached config text it reads, and the
 * command builders it writes with. Subclasses name their verbs after the rule in this file's header
 * ({@link Entity}, {@link EntityCollection}).
 */
export abstract class ResourceBase {
  /**
   * pyeapi `BaseEntity.node` (`abstract.py:67-68`). Protected in TS: pyeapi's resources reach for
   * `self.node` from everywhere, and `Interfaces.marshall` (`interfaces.py:129-137`) even hands it to
   * other resource instances; this port has no dynamic dispatch to feed, so the field stays inside the
   * class hierarchy and a caller who wants the command layer uses the `Node` they constructed.
   */
  protected readonly node: Node

  constructor(node: Node) {
    assertResourceNode(node)
    this.node = node
  }

  /**
   * The config text this resource should read — pyeapi's `BaseEntity.config` **property**
   * (`abstract.py:74-76`, which returns `node.running_config` and re-runs a `show running-config` on
   * every access, which is what MIGRATION.md §5 row 15 flags).
   *
   * Async here because a TS getter cannot await I/O (DR-005), and already cached: `Node` holds the text
   * until a write invalidates it (`command-layer.ts`, row 73), so ten resource reads in one render pass
   * cost one round trip, not ten. Pass `{ config: 'startup-config' }` for pyeapi's other named source;
   * the `'running_config'`/`'startup_config'` sentinel strings pyeapi resolves against `Node`
   * (`client.py:789-791`) are not accepted — the union is checked by {@link ConfigTarget}.
   */
  async config(options: NodeConfigOptions = {}): Promise<string> {
    const { config = 'running-config' }: NodeConfigOptions = options
    return config === 'startup-config' ? this.node.getStartupConfig() : this.node.getRunningConfig()
  }

  /**
   * The same text, split into section keys — the shape a collection resource iterates
   * (`Vlans.getall`'s `re.findall` over the whole config, `vlans.py:179-192`, is the upstream version of
   * this). Backed by the per-source DR-026 memo on the `Node`, so chunking happens at most once per
   * config text, not per lookup.
   */
  async configSections(options: NodeConfigOptions = {}): Promise<ConfigSections> {
    return this.node.chunkConfig(options)
  }

  /**
   * The text of one section, or `undefined` — pyeapi's `get_block` (`abstract.py:82-101`), which anchors
   * the parent into a regex (`'^%s$' % parent`, `:98`) and converts *any* `TypeError` to `None`
   * (`except TypeError`, `:100-101`).
   *
   * Delegates to {@link Node.getBlock}, i.e. to M6 (#8)'s `getBlock` over this `Node`'s DR-026 memo, so
   * the NotFoundError-only catch (`section.ts`) and the as-written parent splice live in exactly one
   * place: `getBlock('vlan 11.13')` can still answer the `vlan 11-13` section, just as upstream does.
   * `undefined`, not a throw, because a resource deciding "the switch has no such section" is ordinary
   * control flow (DR-027).
   */
  async getBlock(parent: string, options: NodeConfigOptions = {}): Promise<string | undefined> {
    return this.node.getBlock(parent, options)
  }

  /**
   * One section's text, throwing when the switch does not have it — the same `NotFoundError` DR-027 gives
   * `Node.section()`. Use it when a missing section is an error; {@link getBlock} when it is a normal
   * answer.
   */
  async section(pattern: string | RegExp, options: NodeConfigOptions = {}): Promise<string> {
    return this.node.section(pattern, options)
  }

  /**
   * Build one command line. Delegates to the pure {@link commandBuilder} in `command-builder.ts`, which
   * is where the DR-037 precedence table lives and where `command-builder.test.ts` tests it without a
   * `Node`. Kept on the base because every wave-1 verb calls it, exactly as pyeapi's modules call
   * `self.command_builder(...)` (`system.py:132`, `:153`, `:173`; `vlans.py:264`, `:276`, `:288`).
   */
  protected commandBuilder(command: string, options: CommandOptions = {}): string {
    return commandBuilder(command, options)
  }

  /**
   * Send a command list in configuration mode — pyeapi `BaseEntity.configure` (`abstract.py:103-127`).
   *
   * Upstream wraps the send in `try/except` and answers `True`/`False`, stashing the exception on
   * `self.error` (`:117-127`); the docstring even has to explain that a `False` return means "look at the
   * error property". Both are removed (DR-005): a failure rejects with the `CommandError` from the wire
   * (device codes, `failedCommand`, redacted text — M1/M4), and there is no `error` property to forget to
   * check. The `commands` array a caller passes is never mutated (row 64), and `Node.configure` prepends
   * `configure terminal` and pops that command's own reply (`command-layer.ts`, pyeapi `client.py:663`,
   * `:672`), so the answer is the per-command replies to what this verb wrote.
   */
  protected async configure(commands: CommandInput, options: NodeRequestOptions = {}): Promise<readonly CommandResult[]> {
    return this.node.configure(toArray(commands), options)
  }

  /**
   * Enter `interface <name>` and configure it — pyeapi `BaseEntity.configure_interface`
   * (`abstract.py:166-178`), whose `make_iterable` + `commands.insert(0, …)` pair (`:176-177`) mutates
   * the caller's array. Same for `Vlans.configure_vlan` (`vlans.py:234-244`).
   *
   * The array this verb sends is built fresh by {@link submodeCommands}, so calling it twice with one
   * list wraps the parent line exactly once per call (row 64, and `base.test.ts` asserts the
   * non-mutation). The name goes through {@link assertInterfaceName} before anything reaches the wire —
   * the equivalent of pyeapi's `interfaces.isvalidinterface` check (`interfaces.py:81-83`) which upstream
   * applies only inside its `marshall` dispatch (`interfaces.py:131`), i.e. only on the dynamic path this
   * port does not have (DR-006).
   */
  protected async configureInterface(name: string, commands: CommandInput): Promise<readonly CommandResult[]> {
    assertInterfaceName(name)
    return this.configure(submodeCommands(`interface ${name}`, commands))
  }
}

/**
 * A single global-ish entity: one config block, no name to look it up by. pyeapi `Entity`
 * (`abstract.py:181-196`) — candidates upstream names are global spanning-tree style resources, and
 * PLAN.md M7 lists `system`, `ntp`, `mlag`, `ospf`, `bgp` (`system` is M8 #10).
 *
 * pyeapi also makes it callable (`class Entity(BaseEntity, Callable)` with `__call__ = get`, `:181`,
 * `:191-192`). Not ported (DR-004): `system()` reads as a factory and hides an awaited device read, so
 * `get()` is the only read verb.
 */
export abstract class Entity<T> extends ResourceBase {
  /**
   * The entity's current state. Always resolves to a value — a global entity with nothing configured
   * still has an answer (empty strings/arrays/false), which is why `undefined` is not in the return type.
   * A device that cannot be reached throws; the caller's loading/error/empty/success states are all
   * observable from here (docs/USAGE.md §7).
   */
  abstract get(): Promise<T>
}

/**
 * A named collection of entries: VLANs, interfaces, switchports, users. pyeapi `EntityCollection`
 * (`abstract.py:198-224`).
 *
 * Upstream also *is* a `Mapping` (`:198`): `vlans[20]` (`__getitem__`, `:211-212`), `len(vlans)`
 * (`:214-215`) and `for vlan in vlans` (`:217-218`) each trigger a device read, and
 * `__call__` (`:208-209`) is `getall()`. None of that exists in TS (DR-004, MIGRATION.md §7): the
 * membership verbs are {@link has}, {@link keys} and {@link entries}, all explicit about performing a
 * read, and each one is one `getAll()` round trip — never a read per element.
 *
 * `T` is one entry, `K` the key type (VLAN ids are `number`, interface names `string` — MIGRATION.md §4),
 * `A` the attribute bag {@link create} accepts (narrow it to a named interface per module).
 */
export abstract class EntityCollection<T, K extends ResourceKey, A extends ResourceAttrs = ResourceAttrs> extends ResourceBase {
  /** Every entry, keyed — pyeapi `getall()`'s dict, as a `ResourceTable` (row 71). */
  abstract getAll(): Promise<ResourceTable<K, T>>

  /**
   * One entry, or `undefined` when the switch has no such entry — pyeapi `get(name)`
   * (`abstract.py:223-224`). Upstream declares `get(self, name, default=None)` and no module uses that
   * third argument (Vlans.get is `def get(self, value)` at `vlans.py:91`), so the fallback parameter is
   * not ported: `await vlans.get(20) ?? {}` says the same thing in the caller's code (row 70).
   */
  abstract get(name: K): Promise<T | undefined>

  /**
   * Bring an entry into existence — pyeapi's `create` (`vlans.py:194`, `interfaces.py:211`). The
   * attributes upstream spells as extra kwargs (`staticroute.py:182`, `users.py:151`, `vrfs.py:152`) ride
   * in `attrs`. Rejects with `CommandError` if the device refuses; `void` on success because the useful
   * follow-up for a UI is a re-read, not the per-command `configure terminal` replies.
   */
  abstract create(name: K, attrs?: A): Promise<void>

  /** Remove an entry — pyeapi's `delete` (`vlans.py:206`). */
  abstract delete(name: K): Promise<void>

  /**
   * Return an entry's configuration to the device defaults — pyeapi's `default(name)`
   * (`vlans.py:218-232`, which builds `'vlan %s'` + `'default …'`). Named `setDefault` here so the verb
   * reads as an action and does not collide with the keyword (row 70).
   */
  abstract setDefault(name: K): Promise<void>

  /**
   * Does the entry exist? Replaces `vlans[20] != None` and pyeapi's `__getitem__`; costs one `getAll()`
   * round trip, the same as {@link keys}.
   */
  async has(name: K): Promise<boolean> {
    return (await this.getAll()).has(name)
  }

  /** The entry names/ids, in device order — pyeapi's `__iter__` (`abstract.py:217-218`). */
  async keys(): Promise<K[]> {
    return [...(await this.getAll()).keys()]
  }

  /** `[key, entry]` pairs, in device order — pyeapi's `Mapping.items()`. */
  async entries(): Promise<Array<readonly [K, T]>> {
    return [...(await this.getAll()).entries()]
  }
}
