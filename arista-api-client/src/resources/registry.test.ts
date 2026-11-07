/**
 * The per-`Node` resource registry, M7 (#9) — DR-006's replacement for pyeapi's `Node.api(name)`
 * string autoload (`pyeapi/client.py:927-950`).
 *
 * ## Upstream port ledger
 *
 * Upstream has no `EntityCollection`-style registry test: `test/unit/test_client.py:210`
 * (`test_api_autoloader`) asserts that `node.api('vlans')` returns an object for a module **name**, and
 * DR-006 drops that mechanism (MIGRATION.md §7), so the case has nothing to port to — which is why
 * `src/command-layer.test.ts` lists it under "Not ported". What is ported instead is the *intent*
 * (name → resource bound to this `Node`), with the name as a closed map key checked at compile time
 * (`ResourceKinds`) and again at runtime ({@link ResourceRegistry.get}).
 *
 * Verified upstream refs in this file: `client.py:927` (`def api(self, name, namespace='pyeapi.api')`),
 * `client.py:946-949` (the object is built fresh on every call), and `interfaces.py:122`/`:129-137`
 * (upstream's own `_instances` dict, i.e. the ad-hoc cache that exists because `api()` does not memoise).
 *
 * The invariant this suite exists to pin: **one instance per name per `Node`**, so a wave-1 module that
 * later grows internal state cannot be re-created under a caller's feet, and no module-level mutable
 * registry can leak one switch's resources into another's (docs/ARCHITECTURE.md §7, which pyeapi's
 * import-time `Config()` singleton violates — DR-038).
 */

import { describe, expect, it } from 'vitest'

import { Node } from '../command-layer'
import { NotSupportedError } from '../errors'
import { mockTransport } from '../testing/mock-transport'
import { ResourceBase } from './base'
import { createResourceRegistry, RESOURCE_FACTORIES, ResourceRegistry } from './registry'
import type { ConfigSections } from '../config/chunk'
import type { ResourceFactories } from './registry'

/**
 * The smallest thing a registry can hold: a `ResourceBase` subclass with no verbs of its own.
 * It also exposes the one framework read a registry test needs, to prove the factory received the
 * `Node` it was registered with rather than some other switch's.
 */
class Probe extends ResourceBase {
  sections(): Promise<ConfigSections> {
    return this.configSections({ config: 'startup-config' })
  }
}

interface ProbeKinds {
  probe: Probe
}

function nodeWith(script = 'hostname sw1\n!\nend'): { node: Node; transport: ReturnType<typeof mockTransport> } {
  const transport = mockTransport().replies('enable\nshow startup-config', [{}, { output: script }])
  return { node: new Node(transport), transport }
}

describe('ResourceRegistry — DR-006 replaces pyeapi node.api() (client.py:927-950)', () => {
  it('an accessor returns the SAME instance twice; the factory runs once', () => {
    let created = 0
    const { node } = nodeWith()
    const registry = createResourceRegistry<ProbeKinds>({ probe: (target) => { created += 1; return new Probe(target) } }, node)
    const first = registry.get('probe')
    const second = registry.get('probe')
    expect(first).toBe(second)
    expect(created).toBe(1)
    // pyeapi answers a brand-new object every call (`client.py:946-949`), which is why upstream had to
    // build its own `_instances` dict inside `Interfaces` (`interfaces.py:122`, `:129-137`).
    expect(registry.get('probe')).toBe(first)
  })

  it('an unknown name throws, naming it and listing what IS registered (never undefined)', () => {
    const { node } = nodeWith()
    const registry = createResourceRegistry<ProbeKinds>({ probe: (target) => new Probe(target) }, node)
    // A name outside the map only arrives from JS (an untyped table column), hence the assertion.
    const bogus = 'noth' as unknown as keyof ProbeKinds
    expect(() => registry.get(bogus)).toThrow(NotSupportedError)
    expect(() => registry.get(bogus)).toThrow(/unknown resource noth/)
    expect(() => registry.get(bogus)).toThrow(/registered: probe/)
  })

  it('a registry holding no factories at all says that, instead of listing an empty name set', () => {
    // M8 (#10) filled the built-in map, so the "nothing registered anywhere" wording is now reachable only
    // through an app-defined registry that has not registered anything yet — the case a UI hits when it
    // wires its own table of resources before adding rows.
    const { node } = nodeWith()
    const empty = createResourceRegistry<Record<string, never>>({}, node)
    expect(empty.names()).toEqual([])
    expect(() => empty.get('anything' as never)).toThrow(NotSupportedError)
    expect(() => empty.get('anything' as never)).toThrow(/This registry holds no factories at all/)
    expect(() => empty.get('anything' as never)).toThrow(/createResourceRegistry\(factories, node\)/)
  })

  it('a typed key with no factory is refused too (declaration merging can add a row the map lacks)', () => {
    // The dangerous case MIGRATION.md §5 row 79 calls out: `ResourceKinds` gains a type row while
    // RESOURCE_FACTORIES does not gain the factory, so TypeScript reports a resource and the caller
    // would receive undefined. The runtime check turns that into an error naming the name.
    const { node } = nodeWith()
    type Merged = ProbeKinds & { vlan: Probe }
    const withoutVlan = { probe: (target: Node) => new Probe(target) } as ResourceFactories<Merged>
    const registry = new ResourceRegistry<Merged>(withoutVlan, node)
    expect(registry.has('vlan')).toBe(false)
    expect(() => registry.get('vlan')).toThrow(/unknown resource vlan — no factory is registered/)
    expect(() => registry.get('vlan')).toThrow(/registered: probe/)
  })

  it('names() lists exactly the registered names, has() narrows for the caller', () => {
    const { node } = nodeWith()
    const registry = createResourceRegistry({ alpha: (t) => new Probe(t), beta: (t) => new Probe(t) }, node)
    expect(registry.names()).toEqual(['alpha', 'beta'])
    expect(registry.has('alpha')).toBe(true)
    expect(registry.has('gamma')).toBe(false)
    expect(registry.has('toString')).toBe(false)
    expect(registry.has(Symbol.iterator)).toBe(false)
    if (registry.has('beta')) expect(registry.get('beta')).toBeInstanceOf(Probe)
  })

  it('two registries on one Node stay separate, and one registry per Node never shares instances', () => {
    const a = nodeWith()
    const b = nodeWith()
    const one = createResourceRegistry({ probe: (t) => new Probe(t) }, a.node)
    const two = createResourceRegistry({ probe: (t) => new Probe(t) }, a.node)
    expect(one.get('probe')).not.toBe(two.get('probe'))
    const other = createResourceRegistry({ probe: (t) => new Probe(t) }, b.node)
    expect(other.get('probe')).not.toBe(one.get('probe'))
  })

  it('the factory receives the Node it was registered with — its reads go to that switch', async () => {
    const { node, transport } = nodeWith('hostname sw1\n!\nend')
    const registry = createResourceRegistry({ probe: (t) => new Probe(t) }, node)
    await registry.get('probe').sections()
    expect(transport.sent()).toEqual([['enable', 'show startup-config']])
  })

  it('a config write does NOT drop the memoised instance (the memo is per Node, not per config)', async () => {
    const transport = mockTransport()
      .replies('enable\nshow startup-config', [{}, { output: 'hostname sw1\n!\nend' }])
      .replies('enable\nconfigure terminal\nhostname sw2', [{}, {}, {}])
    const node = new Node(transport)
    const registry = createResourceRegistry({ probe: (t) => new Probe(t) }, node)
    const before = registry.get('probe')
    await node.configure('hostname sw2')
    expect(registry.get('probe')).toBe(before)
  })

  it('the built-in factory table is frozen and holds exactly the rows shipped so far (M8 #10 `system`, M9 #11 `vlans`/`switchports`, M10a #12 `interfaces`, W2a #35 `users`/`ntp`, W2b #37/#38 `acls`/`varp`, W2c #39/#40 `stp`/`ipinterfaces`, W2d #41/#42/#43 `vrfs`/`staticroute`/`mlag`)', () => {
    // M7 (#9) shipped this table honest-but-empty; each milestone since claimed its rows at the END of
    // the table (the cross-lane merge rule), so the ordered assertion carries them in merge order rather
    // than in a lane-chosen slot. A name in `ResourceKinds` without a row here would be a package bug
    // (row 79). A mutable module-level registry is what ARCHITECTURE.md §7 forbids. The NEGATIVE CONTROL
    // has moved twice: `mlag` held the slot through waves 1-2 (W2d #43 collected it), `stp` briefly
    // during W2d's own development (W2c #39 shipped it mid-lane), and `ospf` now — pyeapi's
    // `api/ospf.py`, owed to wave 3 (#17), the honest "still owed" name.
    expect(Object.isFrozen(RESOURCE_FACTORIES)).toBe(true)
    const { node } = nodeWith()
    expect(new ResourceRegistry(RESOURCE_FACTORIES, node).names()).toEqual(['system', 'vlans', 'switchports', 'interfaces', 'users', 'ntp', 'acls', 'varp', 'stp', 'ipinterfaces', 'vrfs', 'staticroute', 'mlag', 'routemaps'])
    expect(new ResourceRegistry(RESOURCE_FACTORIES, node).has('vlans')).toBe(true)
    expect(new ResourceRegistry(RESOURCE_FACTORIES, node).has('interfaces')).toBe(true)
    expect(new ResourceRegistry(RESOURCE_FACTORIES, node).has('users')).toBe(true)
    expect(new ResourceRegistry(RESOURCE_FACTORIES, node).has('ntp')).toBe(true)
    expect(new ResourceRegistry(RESOURCE_FACTORIES, node).has('acls')).toBe(true)
    expect(new ResourceRegistry(RESOURCE_FACTORIES, node).has('varp')).toBe(true)
    expect(new ResourceRegistry(RESOURCE_FACTORIES, node).has('stp')).toBe(true)
    expect(new ResourceRegistry(RESOURCE_FACTORIES, node).has('ipinterfaces')).toBe(true)
    expect(new ResourceRegistry(RESOURCE_FACTORIES, node).has('vrfs')).toBe(true)
    // W2d (#42): one token, exactly like the registry key (DR-102). (#43): `mlag` was this suite's
    // favorite unregistered name for two waves; it is a real row now.
    expect(new ResourceRegistry(RESOURCE_FACTORIES, node).has('staticroute')).toBe(true)
    expect(new ResourceRegistry(RESOURCE_FACTORIES, node).has('mlag')).toBe(true)
    // `routemaps` joined the table this milestone (W3b #50, lane B).
    expect(new ResourceRegistry(RESOURCE_FACTORIES, node).has('routemaps')).toBe(true)
    // The registry's NEGATIVE CONTROL has moved forward a row again: `routemaps` joined the table (W3b
    // #50, lane B — this branch), so the standing "still owed" exemplar is now lane C's `vrrp` (issue
    // #51, on a sibling branch not yet merged here). pyeapi's `api/vrrp.py` exists and is unregistered in
    // THIS tree, which is exactly the runtime case the check pins.
    expect(new ResourceRegistry(RESOURCE_FACTORIES, node).has('vrrp')).toBe(false)
  })
})

describe('Node.resource / Node.hasResource — the typed replacement for node.api(name)', () => {
  it('hasResource answers true for every shipped row and false for a name no milestone has shipped', () => {
    const { node } = nodeWith()
    expect(node.hasResource('system')).toBe(true)
    expect(node.hasResource('vlans')).toBe(true)
    expect(node.hasResource('switchports')).toBe(true)
    expect(node.hasResource('interfaces')).toBe(true)
    expect(node.hasResource('users')).toBe(true)
    expect(node.hasResource('ntp')).toBe(true)
    expect(node.hasResource('acls')).toBe(true)
    expect(node.hasResource('varp')).toBe(true)
    expect(node.hasResource('stp')).toBe(true)
    expect(node.hasResource('ipinterfaces')).toBe(true)
    expect(node.hasResource('vrfs')).toBe(true)
    expect(node.hasResource('staticroute')).toBe(true)
    expect(node.hasResource('mlag')).toBe(true)
    // `routemaps` joined this lane's table (W3b #50, lane B); the standing "not shipped" exemplar is
    // `vrrp` — lane C's module on a sibling branch, unregistered here (`ospf`, lane A's, likewise).
    expect(node.hasResource('routemaps')).toBe(true)
    expect(node.hasResource('vrrp')).toBe(false)
    expect(node.hasResource('probe')).toBe(false)
  })

  it('M8/M9/M10a\'s static accessors are the memoised registry instances, not a second cache (DR-052)', () => {
    const { node } = nodeWith()
    // PLAN.md M7's "static accessors instead of node.api('vlans')" box was left unticked because a
    // getter needs a module class to name; `system` is the first one (M8 #10) and `vlans`/`switchports`
    // are the next two (M9 #11). The values have to come from the per-Node registry, so an accessor, its
    // `node.resource(name)` twin and a second read of the getter are one object — pyeapi builds a new one
    // per `node.api()` call (`client.py:946-949`).
    expect(node.system).toBe(node.system)
    expect(node.resource('system')).toBe(node.system)
    expect(node.system.constructor.name).toBe('SystemResource')
    expect(node.vlans).toBe(node.vlans)
    expect(node.vlans).toBe(node.resource('vlans'))
    expect(node.vlans.constructor.name).toBe('VlansResource')
    expect(node.switchports).toBe(node.switchports)
    expect(node.switchports).toBe(node.resource('switchports'))
    expect(node.switchports.constructor.name).toBe('SwitchportsResource')
    // M10a (#12) is the fourth row: `node.interfaces` is the accessor the webui's interface screens use.
    expect(node.interfaces).toBe(node.interfaces)
    expect(node.interfaces).toBe(node.resource('interfaces'))
    expect(node.interfaces.constructor.name).toBe('InterfacesResource')
    // W2a (#35) appended the fifth and sixth rows: `node.users` (collection) and `node.ntp` (global
    // entity, the `node.system` sibling), each its registry twin under the same memo.
    expect(node.users).toBe(node.users)
    expect(node.users).toBe(node.resource('users'))
    expect(node.users.constructor.name).toBe('UsersResource')
    expect(node.ntp).toBe(node.ntp)
    expect(node.ntp).toBe(node.resource('ntp'))
    expect(node.ntp.constructor.name).toBe('NtpResource')
    // W2b (#37 #38) are the seventh and eighth rows. `node.acls.standard`/`.extended` and
    // `node.varp.interfaces` are the pyeapi sub-objects (`acl.py:126-142`'s `_instances`,
    // `varp.py:59-63`'s property memo) that the per-Node memo replaces: one object each, identity stable.
    expect(node.acls).toBe(node.acls)
    expect(node.acls).toBe(node.resource('acls'))
    expect(node.acls.constructor.name).toBe('AclsResource')
    expect(node.acls.standard).toBe(node.acls.standard)
    expect(node.acls.extended).toBe(node.acls.extended)
    expect(node.varp).toBe(node.varp)
    expect(node.varp).toBe(node.resource('varp'))
    expect(node.varp.constructor.name).toBe('VarpResource')
    expect(node.varp.interfaces).toBe(node.varp.interfaces)
    expect(node.varp.interfaces.constructor.name).toBe('VarpInterfacesResource')
    // W2d (#41-#43) are the eleventh, twelfth and thirteenth rows: `node.vrfs`, `node.staticroute`
    // (one token exactly like the registry key, DR-102), and `node.mlag` — the name that served as this
    // suite's negative control for two waves is a real row now.
    expect(node.vrfs).toBe(node.vrfs)
    expect(node.vrfs).toBe(node.resource('vrfs'))
    expect(node.vrfs.constructor.name).toBe('VrfsResource')
    expect(node.staticroute).toBe(node.staticroute)
    expect(node.staticroute).toBe(node.resource('staticroute'))
    expect(node.staticroute.constructor.name).toBe('StaticRouteResource')
    expect(node.mlag).toBe(node.mlag)
    expect(node.mlag).toBe(node.resource('mlag'))
    expect(node.mlag.constructor.name).toBe('MlagResource')
  })

  it('asking for an unregistered resource throws, listing the rows that DO exist', () => {
    const { node } = nodeWith()
    // `ResourceName` is the closed map key union, so this call cannot be written type-correctly from TS —
    // which is the point. The cast is the JS/table-column path the runtime check exists for (row 79).
    // `ospf` was this suite's unregistered name through wave 2 (W2d #43 shipped `mlag`, W3b #50 lane B
    // shipped `routemaps`). The new unregistered exemplar in this tree is `vrrp` — lane C's #51 module,
    // absent here because its row will land on a sibling branch until the W3 merge order completes.
    const untyped = 'vrrp' as never
    expect(() => node.resource(untyped)).toThrow(NotSupportedError)
    // The NEGATIVE CONTROL: `ospf` was this suite's name for waves 1-2, `mlag` (W2d #43) and `routemaps`
    // (W3b #50 lane B) became rows; the next module NOT shipped in this tree is pyeapi's `api/vrrp.py`
    // (lane C's #51 module, unregistered in this branch). Same cast, same runtime contract.
    const untyped = 'vrrp' as never
    expect(() => node.resource(untyped)).toThrow(NotSupportedError)
    expect(() => node.resource(untyped)).toThrow(/unknown resource vrrp — no factory is registered/)
    expect(() => node.resource(untyped)).toThrow(/registered: system, vlans, switchports, interfaces, users, ntp, acls, varp, stp, ipinterfaces, vrfs, staticroute, mlag, routemaps/)
  })

  it('every failed resource call sends nothing to the device (a registry miss is not a device error)', () => {
    const { node, transport } = nodeWith()
    expect(() => node.resource('vrrp' as never)).toThrow(NotSupportedError)
    expect(transport.sent()).toEqual([])
    expect(transport.callCount()).toBe(0)
  })

  it('two Nodes do not share a resource memo (ARCHITECTURE.md §7, pyeapi DR-038 counter-example)', () => {
    const first = nodeWith()
    const second = nodeWith()
    expect(first.node.vlans).not.toBe(second.node.vlans)
    expect(first.node.switchports).not.toBe(second.node.switchports)
    expect(first.node.interfaces).not.toBe(second.node.interfaces)
    expect(first.node.vrfs).not.toBe(second.node.vrfs)
    expect(first.node.staticroute).not.toBe(second.node.staticroute)
    expect(first.node.mlag).not.toBe(second.node.mlag)
    // W3b #50 (lane B) appended a row: routemaps is real now; lane C's `vrrp` row was never shipped in
    // this tree, so the first Node's `routemaps` instance must not be the second Node's resource object
    // either (ARCHITECTURE.md §7). Same memo isolation the other rows have.
    expect(first.node.routemaps).not.toBe(second.node.routemaps)
    expect(second.node.routemaps).toBe(second.node.routemaps)
    expect(() => first.node.resource('vrrp' as never)).toThrow(/no factory is registered/)
  })
})
