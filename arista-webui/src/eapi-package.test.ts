import { describe, expect, it } from 'vitest'

import { createNode } from '@devhax-heavy-industries/arista-eapi'

// M0 (#2) exit-gate assertion: the webui must resolve the API client **by package name**,
// with no `resolve.alias` and no relative path into the other package. Vite/Vitest resolve
// the `development` export condition to the client's TypeScript source (built `dist/`
// output is used for production builds), so this test also proves dev-mode serving works
// without a prior library build.
describe('@devhax-heavy-industries/arista-eapi resolves from the workspace', () => {
  it('imports the browser-safe entry by name', () => {
    expect(typeof createNode).toBe('function')
  })

  it('is still the M0 placeholder until the command layer lands in M4 (#6)', () => {
    expect(() => createNode({ host: 'sw1' })).toThrow(/M0 placeholder \(#2\)/)
  })
})
