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
})
