import { describe, expect, it } from 'vitest'

import { createNode } from './node'

// Wiring proof for the `live` vitest project (#2). The real device suites arrive with
// M12 (#14); until then this file only shows that the project is selectable and that it
// honours DR-034's "skip loudly, never silently" opt-in gate.
const liveRequested = process.env['EAPI_LIVE'] === '1'

if (!liveRequested) {
  console.warn(
    'live project: no device test will run — EAPI_LIVE!=1 (DR-034). ' +
      'M12 (#14) adds the endpoint/model/version guards; nothing here touches the switch.',
  )
}

describe.skipIf(!liveRequested)('live project wiring (M0, #2)', () => {
  it('only executes when explicitly opted in', () => {
    expect(() => createNode()).toThrow(/M0 placeholder/)
  })
})
