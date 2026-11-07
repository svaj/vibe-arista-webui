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
 * MIGRATION.md §5 row 79 records the shape, including what M7 deliberately left empty: **no wave-1
 * resource module existed yet** at M7, so `node.vlans` was not a thing and `node.resource('vlans')`
 * threw both statically and at runtime. The registry landed then because the framework, not the modules,
 * is what needs the plumbing — PLAN.md M7's exit gate is "the first resource module (M8) requires ~30
 * lines of new plumbing at most", and `base.test.ts` measures that cost against a throwaway entity.
 * **M8 (#10) claimed the first row** (`system`, with `Node.system` for it), and **M9 (#11) claimed the
 * next two** (`vlans`, `switchports`, with `Node.vlans` / `Node.switchports`), **M10a (#12) claimed the
 * fourth** (`interfaces`, with `Node.interfaces`), and **W2b (#37 #38) claimed the fifth and sixth**
 * (`acls` / `varp`, with `Node.acls` / `Node.varp`) — pyeapi's factories for those two are `acl.py:302-303`
 * and `varp.py:202`, and `acl.py:299`'s `ACL_CLASS_MAP` is the per-kind lookup this table makes unnecessary
 * (DR-068/DR-092).
 *
 * Instances are memoised **per `Node`**, not globally: `ResourceRegistry` is constructed with the `Node`
 * it drives, so two switches get two resource objects and no module-level mutable singleton exists
 * (docs/ARCHITECTURE.md §7's rule, which pyeapi's import-time `config = Config()` violates — DR-038).
 */

import { NotSupportedError } from '../errors'
import { AclsResource } from './acl'
import { InterfacesResource } from './interfaces'
import { IpinterfacesResource } from './ipinterfaces'
import { MlagResource } from './mlag'
import { NtpResource } from './ntp'
import { RoutemapsResource } from './routemaps'
import { StaticRouteResource } from './staticroute'
import { StpResource } from './stp'
import { SwitchportsResource } from './switchports'
import { SystemResource } from './system'
import { UsersResource } from './users'
import { VarpResource } from './varp'
import { VlansResource } from './vlans'
import { VrfsResource } from './vrfs'
// W3a (#48 #49) appended its two imports at the END of this block — the cross-lane take-both merge
// rule (the lane order at merge is A then B then C), so alphabetical order resumes at the merge, not here.
import { OspfResource } from './ospf'
import { BgpResource } from './bgp'
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
 * The first rows are M8's (`system`, #10) and M9's (`vlans`, `switchports`, #11); M10a (#12) added
 * `interfaces`. Wave 2 appended, in merge order, `users`/`ntp` (W2a #35), `acls`/`varp` (W2b #37 #38),
 * `stp`/`ipinterfaces` (W2c #39 #40) and `vrfs`/`staticroute`/`mlag` (W2d #41-#43). A name in this interface without a
 * factory in {@link RESOURCE_FACTORIES} is a bug in this package, and {@link ResourceRegistry.get} throws
 * rather than returning `undefined` (row 79).
 */
export interface ResourceKinds {
  /** The global system settings — `src/resources/system.ts`, port of pyeapi `api/system.py`. */
  system: SystemResource
  /** The VLANs in the running-config — `src/resources/vlans.ts`, port of pyeapi `api/vlans.py`. */
  vlans: VlansResource
  /** The L2 state of each Ethernet / Port-Channel interface — `src/resources/switchports.ts`, port of pyeapi `api/switchports.py`. */
  switchports: SwitchportsResource
  /** Every interface's presence and shared configuration — `src/resources/interfaces.ts`, port of pyeapi `api/interfaces.py` (M10a slice). */
  interfaces: InterfacesResource
  /** The local usernames — `src/resources/users.ts`, port of pyeapi `api/users.py` (W2a #35). */
  users: UsersResource
  /** The global NTP configuration — `src/resources/ntp.ts`, port of pyeapi `api/ntp.py` (W2a #35). */
  ntp: NtpResource
  /** Both kinds of `ip access-list` section — `src/resources/acl.ts`, port of pyeapi `api/acl.py` (W2b slice, #37). */
  acls: AclsResource
  /** The virtual-router MAC plus the per-interface virtual-router addresses — `src/resources/varp.ts`, port of pyeapi `api/varp.py` (W2b slice, #38). */
  varp: VarpResource
  /** Global spanning-tree state plus the per-interface portfast/bpduguard view — `src/resources/stp.ts`, port of pyeapi `api/stp.py` (W2c #39). */
  stp: StpResource
  /** The layer-3 view of each interface (its `ip address` lines and `mtu`) — `src/resources/ipinterfaces.ts`, port of pyeapi `api/ipinterfaces.py` (W2c #40). */
  ipinterfaces: IpinterfacesResource
  /** The VRF definitions/instances in the running-config — `src/resources/vrfs.ts`, port of pyeapi `api/vrfs.py` (W2d slice, #41). */
  vrfs: VrfsResource
  /** The IPv4 static routes in the running-config — `src/resources/staticroute.ts`, port of pyeapi `api/staticroute.py` (W2d slice, #42). */
  staticroute: StaticRouteResource
  /** The MLAG configuration — `src/resources/mlag.ts`, port of pyeapi `api/mlag.py` (W2d slice, #43). */
  mlag: MlagResource
  /** The FIRST `router ospf …` process (multi-process nodes read per-vrf) — `src/resources/ospf.ts`, port of pyeapi `api/ospf.py` (W3a slice, #48). */
  ospf: OspfResource
  /** The `router bgp …` process and its `neighbors` sub-collection — `src/resources/bgp.ts`, port of pyeapi `api/bgp.py` (W3a slice, #49). */
  bgp: BgpResource
  /** The route-maps configured on the switch, keyed by name with the (action, seqno) clauses nested —
   *  `src/resources/routemaps.ts`, port of pyeapi `api/routemaps.py` (W3b lane B, #50). */
  routemaps: RoutemapsResource
}

/** Any name `node.resource()` may be asked for. Grows by one row per resource module (M8-M10). */
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
 *
 * One row per shipped module — pyeapi's `instance(api)` factories (`system.py:183-186`,
 * `vlans.py:361-372`, `switchports.py:406-417`, `acl.py:302-303`, `varp.py:202`) are the thing this table
 * replaces, and pyeapi resolves the
 * the **name** to a module path at call time (`client.py:927-950`), which is what DR-006 removes. `ResourceFactories<ResourceKinds>`
 * is exhaustive, so a `ResourceKinds` row without a factory here is a compile error (row 79).
 */
export const RESOURCE_FACTORIES: ResourceFactories<ResourceKinds> = Object.freeze({
  system: (node) => new SystemResource(node),
  vlans: (node) => new VlansResource(node),
  switchports: (node) => new SwitchportsResource(node),
  interfaces: (node) => new InterfacesResource(node),
  users: (node) => new UsersResource(node),
  ntp: (node) => new NtpResource(node),
  acls: (node) => new AclsResource(node),
  varp: (node) => new VarpResource(node),
  stp: (node) => new StpResource(node),
  ipinterfaces: (node) => new IpinterfacesResource(node),
  vrfs: (node) => new VrfsResource(node),
  staticroute: (node) => new StaticRouteResource(node),
  mlag: (node) => new MlagResource(node),
  ospf: (node) => new OspfResource(node),
  bgp: (node) => new BgpResource(node),
  routemaps: (node) => new RoutemapsResource(node),
})

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
          known.length === 0 ? '. This registry holds no factories at all, which for the built-in map would mean no resource module has been registered (M8 #10 shipped `system`, M9 #11 `vlans`/`switchports`, M10a #12 `interfaces` and W2b #37/#38 `acls`/`varp`) — an app-defined registry is created with createResourceRegistry(factories, node).' : `; registered: ${known.join(', ')}`
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
