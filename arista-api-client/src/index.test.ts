import { describe, expect, it } from 'vitest'

import { createNode } from './index'

// M0 (#2) — proves the offline `unit` project runs and the browser-safe entry resolves.
// Replace these with the wire-codec suite when M1 (#3) lands.
describe('browser-safe entry (M0 skeleton)', () => {
  it('createNode is a placeholder that says which milestone implements it', () => {
    expect(() => createNode({ host: 'switch.local' })).toThrow(/M0 placeholder \(#2\)/)
  })

  it('names M4 (#6) as the command-layer milestone and echoes the options it got', () => {
    expect(() => createNode({ host: 'sw1' })).toThrow(/M4 \(#6\)[\s\S]*"host":"sw1"/)
  })
})
