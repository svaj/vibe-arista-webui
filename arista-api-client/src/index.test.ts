import { describe, expect, it } from 'vitest'

import { createNode } from './index'


describe('browser-safe entry', () => {
  it('createNode is still a placeholder that says which milestone implements it', () => {
    // The phrase `M0 placeholder (#2)` is what `arista-webui/src/eapi-package.test.ts` matches, so the
    // webui keeps proving name-based resolution while the factory itself is unimplemented.
    expect(() => createNode({ host: 'switch.local' })).toThrow(/M0 placeholder \(#2\)/)
  })

  it('points at M3 (#5) for the option bag and at M4 (#6) for the command layer that exists now', () => {
    // PLAN.md M3 owns `createConnection(profile)`/`createNode(profile)`; M4 (#6) shipped `Node`.
    // Merging those two is M3's decision to make, not this milestone's.
    expect(() => createNode({ host: 'sw1' })).toThrow(/M3 \(#5\)/)
    expect(() => createNode({ host: 'sw1' })).toThrow('command layer it would hand back exists now (M4, #6)')
    expect(() => createNode({ host: 'sw1' })).toThrow('new Node(createTransport(')
  })

  it('echoes the options it was handed, so a JS caller can see what it passed', () => {
    expect(() => createNode({ host: 'sw1' })).toThrow(/"host":"sw1"/)
  })

  it('exports the M4 command layer from the browser-safe entry', async () => {
    const surface = await import('./index')
    expect(typeof surface.Node).toBe('function')
    expect(typeof surface.tryVariants).toBe('function')
    expect(typeof surface.parseVersionProperties).toBe('function')
  })
  it('exports the M7 (#9) resource framework from the browser-safe entry', async () => {
    // PLAN.md assigned the entry-point wiring to M7, so a consumer can build a wave-1 module without
    // importing package internals. Nothing here touches fs/path: the framework is pure.
    const surface = await import('./index')
    const functions = [
      'ResourceBase', 'Entity', 'EntityCollection', 'ResourceRegistry', 'createResourceRegistry',
      'commandBuilder', 'submodeCommands', 'parseConfigBlock', 'toArray',
      'assertInterfaceName', 'assertVlanId', 'isInterfaceName', 'isVlanId',
    ] as const
    for (const name of functions) {
      expect(typeof surface[name], name).toBe('function')
    }
    // The registry ships, but empty: M8-M10 (#10-#12) register the modules (§5 row 79).
    expect(Object.keys(surface.RESOURCE_FACTORIES)).toEqual([])
    // `assertVlanId` is an assertion function (returns void); the range is pyeapi's —
    // `value in range(1, 4095)`, i.e. VLANs 1..4094 (pyeapi/api/vlans.py:78). M9 (#12) re-checks that
    // bound against the switch's own `switchport access vlan` range on a device.
    expect(() => surface.assertVlanId(4094)).not.toThrow()
    expect(surface.isVlanId(4095)).toBe(false)
    expect(() => surface.assertVlanId(4095)).toThrow(/expected an integer VLAN id 1\.\.4094/)
  })
})
