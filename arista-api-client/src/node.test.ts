import { describe, expect, it } from 'vitest'

import { createNode } from './node'
import { Node as BrowserNode } from './index'

// The Node build target (DR-002) must not be an alias of the browser entry: it carries its own
// placeholder text, and it is the only entry that registers the Node-only transport kinds.
describe('Node entry point', () => {
  it('createNode is a placeholder naming the milestone that owns the option bag', () => {
    expect(() => createNode()).toThrow(/arista-eapi\/node: createNode\(\) is an M0 placeholder/)
  })

  it('names M2 (#4) as done, M4 (#6) as the command layer and M3 (#5) as the missing piece', () => {
    expect(() => createNode()).toThrow(/Node transports landed in M2 \(#4\), the command layer landed in M4 \(#6\)/)
    expect(() => createNode()).toThrow(/connection\/profile options land in M3 \(#5\)/)
  })

  it('is a strict superset of the browser entry: the M4 Node class is the same class', async () => {
    // `export * from './index'` is what makes `./node` usable as the only import an app needs.
    const nodeEntry = await import('./node')
    expect(nodeEntry.Node).toBe(BrowserNode)
  })
})
