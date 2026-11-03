/**
 * The resource registry — DR-006's replacement for pyeapi's `Node.api()` string autoload
 * (`pyeapi/client.py:927-950`, verified by opening the file: it calls `load_module('pyeapi.api.<name>')`,
 * then runs the module's `initialize(node)` and `instance(node)` if they exist — i.e. a resource name is
 * a **filesystem path**, resolved at runtime, with a typo surfacing as an import error).
 *
 * Here a resource name is a key of a closed map, and the map is checked two ways:
 *  - at **compile time** by {@link ResourceKinds}, an augmentable interface in the same style as
 *    `ShowContracts` (`src/types/eapi.ts`) — `node.resource('bogus')` does not typecheck;
 *  - at **runtime** by {@link ResourceRegistry.get}, because a name can also arrive from JS
 *    (the webui's dynamic tables hold a `string` column, ARCHITECTURE.md §9 item 2) and because
 *    declaration merging can add a *type* row without a factory ever being registered for it. That
 *    second case is the dangerous one: TypeScript would report a resource, and the caller would get
 *    `undefined`. It throws a `NotSupportedError` listing the registered names instead.
 *
 * MIGRATION.md §5 row 79 records the shape, including what M7 deliberately leaves empty: **no wave-1
 * resource module exists yet** (M8 #10, M9 #11, M10 #12 own `system`/`vlans`/`switchports`/`interfaces`),
 * so `node.vlans` is not a thing today and `node.resource('vlans')` throws both statically and at
 * runtime. The registry lands now because the framework, not the modules, is what needs the plumbing —
 * PLAN.md M7's exit gate is "the first resource module (M8) requires ~30 lines of new plumbing at most",
 * and `base.test.ts` measures that cost against a throwaway entity.
 *
 * Instances are memoised **per `Node`**, not globally: `ResourceRegistry` is constructed with the `Node`
 * it drives, so two switches get two resource objects and no module-level mutable singleton exists
 * (docs/ARCHITECTURE.md §7's rule, which pyeapi's import-time `config = Config()` violates — DR-038).
 */

import { NotSupportedError } from '../errors'
import type { Node } from '../command-layer'

/** A resource constructor: the `Node` it operates on in, the resource instance out (pyeapi's `instance(node)`). */
export type ResourceFactory<T> = (node: Node) => T

/**
 * The closed set of names `node.resource(name)` accepts.
 *
 * Augment it from an app the same way `ShowContracts` is augmented
 * (`docs/USAGE.md` §4, `arista-webui/src/eapi-show-contracts.test.ts` shows the consumer form):
 *
 * ```ts
 * declare module '@devhax-heavy-industries/arista-eapi' {
 *   interface ResourceKinds {
 *     myThing: MyThingResource   // and register a factory for it in your own ResourceRegistry
 *   }
 * }
 * ```
 *
 * **Empty at M7 (#9)** — the built-in rows arrive with M8 (#10), M9 (#11) and M10 (#12), each in
 * {@link RESOURCE_FACTORIES}. A name in this interface without a factory there is a bug in this package,
 * and {@link ResourceRegistry.get} throws rather than returning `undefined` (row 79).
 */
export interface ResourceKinds {
  // Intentionally no members: no resource module has landed yet. Keeping this empty is what makes the
  // exit-gate proof honest — M8 adds one row here plus one factory below.
}

/** Any name `node.resource()` may be asked for. `never` while {@link ResourceKinds} is empty. */
export type ResourceName = keyof ResourceKinds

/** The factory map implied by a kinds map — exhaustive, so a kind without a factory is a compile error. */
export type ResourceFactories<K extends object> = {
  readonly [P in keyof K]: ResourceFactory<K[P]>
}

/** A resource instance, as the memo stores it. Heterogeneous by design: one map per `Node`. */
type AnyResource = unknown

/**
 * The built-in factories. Frozen, because a mutable module-level registry is what ARCHITECTURE.md §7
 * forbids and what would let one screen's registration change another's behaviour.
 * App-defined resources go in their own {@link ResourceRegistry} instead.
 */
export const RESOURCE_FACTORIES: ResourceFactories<ResourceKinds> = Object.freeze({})

/**
 * A per-`Node` resource cache over a factory map. One instance is held by each `Node`
 * (`command-layer.ts`); apps building their own resources construct their own.
 */
export class ResourceRegistry<K extends object = ResourceKinds> {
  private readonly factories: ResourceFactories<K>
  private readonly node: Node
  private readonly instances: Map<keyof K, AnyResource> = new Map()

  constructor(factories: ResourceFactories<K>, node: Node) {
    this.factories = factories
    this.node = node
  }

  /** Every name this registry can answer with — the list a UI can build a table of resources from. */
  names(): Array<keyof K> {
    return Object.keys(this.factories) as Array<keyof K>
  }

  /**
   * Does this name have a factory? Takes any property key on purpose: this is the check for a name that
   * is only known at runtime (a table column, a URL parameter), which is precisely what the typed union
   * cannot express. `name is keyof K` lets a caller narrow and then call {@link get} without a cast.
   */
  has(name: PropertyKey): name is keyof K {
    return Object.prototype.hasOwnProperty.call(this.factories, name)
  }

  /**
   * The resource for `name`, created on first use and the same instance thereafter — pyeapi's
   * `node.api('vlans')` builds a fresh object on every call (`client.py:946-949`), which is how
   * `Interfaces`' own `_instances` dict (`interfaces.py:122`, `:129-137`) ended up being the thing that
   * actually caches anything across calls.
   *
   * @throws {NotSupportedError} no factory is registered for `name`, naming it and listing the names
   *   that are. Reaching this with a typed call means {@link ResourceKinds} and
   *   {@link RESOURCE_FACTORIES} disagree — the runtime check exists so a declaration-merging row can
   *   never produce an `undefined` resource.
   */
  get<P extends keyof K>(name: P): K[P] {
    const cached = this.instances.get(name)
    if (cached !== undefined) return cached as K[P]
    const factory = this.factories[name]
    if (factory === undefined) {
      const known = this.names().map(String)
      throw new NotSupportedError(
        `unknown resource ${String(name)} — no factory is registered for it${
          known.length === 0 ? '. No resource module has shipped yet (M8 #10, M9 #11, M10 #12), so only a custom ResourceRegistry can answer one today.' : `; registered: ${known.join(', ')}`
        }`,
        { cause: name },
      )
    }
    const created = factory(this.node)
    this.instances.set(name, created)
    return created as K[P]
  }
}

/** Convenience for app-defined registries: `createResourceRegistry({ myThing: (node) => new MyThing(node) }, node)`. */
export function createResourceRegistry<K extends object>(
  factories: ResourceFactories<K>,
  node: Node,
): ResourceRegistry<K> {
  return new ResourceRegistry(factories, node)
}
