import { describe, expect, it } from 'vitest'

import { createNode } from './node'

// M0 (#2) — the Node entry must exist as its own build target (DR-002) and must not be an
// alias of the browser entry, so it carries its own placeholder message naming M2 (#4).
describe('Node entry (M0 skeleton)', () => {
  it('createNode is a placeholder that names the Node transport milestone', () => {
    expect(() => createNode()).toThrow(/arista-eapi\/node: createNode\(\) is an M0 placeholder/)
  })

  it('points at M2 (#4) for transports and M4 (#6) for the command layer', () => {
    expect(() => createNode()).toThrow(/M2 \(#4\), the command layer in M4 \(#6\)/)
  })
})
