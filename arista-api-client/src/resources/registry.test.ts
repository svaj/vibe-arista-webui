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

  it('a typed key with no factory is refused too (declaration merging can add a row the map lacks)', () => {
    // The dangerous case MIGRATION.md §5 row 72 calls out: `ResourceKinds` gains a type row while
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

  it('the built-in factory table is empty at M7 (#9) and frozen', () => {
    // Honest empty: no wave-1 module exists yet (M8 #10, M9 #11, M10 #12 own system/vlans/
    // switchports/interfaces), and a mutable module-level registry is what ARCHITECTURE.md §7 forbids.
    expect(Object.isFrozen(RESOURCE_FACTORIES)).toBe(true)
    const { node } = nodeWith()
    expect(new ResourceRegistry(RESOURCE_FACTORIES, node).names()).toEqual([])
  })
})

describe('Node.resource / Node.hasResource — the typed replacement for node.api(name)', () => {
  it('hasResource answers false for every name while the built-in map is empty', () => {
    const { node } = nodeWith()
    expect(node.hasResource('vlans')).toBe(false)
    expect(node.hasResource('system')).toBe(false)
    expect(node.hasResource('interfaces')).toBe(false)
    expect(node.hasResource('probe')).toBe(false)
  })

  it('asking for an unregistered resource throws with the "no module has shipped yet" answer, not undefined', () => {
    const { node } = nodeWith()
    // `ResourceName` is `never` at M7, so this call cannot be written type-correctly from TS — which is
    // the point. The cast is the JS/table-column path the runtime check exists for (row 72).
    const untyped = 'vlans' as never
    expect(() => node.resource(untyped)).toThrow(NotSupportedError)
    expect(() => node.resource(untyped)).toThrow(/No resource module has shipped yet \(M8 #10, M9 #11, M10 #12\)/)
  })

  it('every failed resource call sends nothing to the device (a registry miss is not a device error)', () => {
    const { node, transport } = nodeWith()
    expect(() => node.resource('vlans' as never)).toThrow(NotSupportedError)
    expect(transport.sent()).toEqual([])
    expect(transport.callCount()).toBe(0)
  })

  it('two Nodes do not share a resource memo (ARCHITECTURE.md §7, pyeapi DR-038 counter-example)', () => {
    const first = nodeWith()
    const second = nodeWith()
    expect(first.node.hasResource('vlans')).toBe(false)
    expect(second.node.hasResource('vlans')).toBe(false)
    expect(() => first.node.resource('vlans' as never)).toThrow(/no factory is registered/)
  })
})
