/**
 * The narrowing every screen's write path relies on (`staged-batch.ts`, shared by S1 #71 and S2 #72):
 * a staged batch arrives as `CommandSpec[]` and must reach the review panel and the destructive guards
 * as command **lines**. The pass-through case is the ordinary one; the interesting case is the loud one —
 * a composer that ever returns `{ cmd, input }` (a multiline verb) must throw here rather than have an
 * operator read `undefined` where a command should be.
 */
import { describe, expect, it } from 'vitest'

import { stageLines } from './staged-batch'

describe('stageLines', () => {
  it('passes the plain command lines through unchanged, in order', () => {
    expect(stageLines(['interface Ethernet1', 'no shutdown'])).toEqual(['interface Ethernet1', 'no shutdown'])
  })

  it('refuses an object spec instead of rendering an unusable line', () => {
    // `commandBuilder.copyRunToStart()` is the real shape this guard exists for: a spec with an `input`.
    expect(() => stageLines([{ cmd: 'copy running-config startup-config', input: 'agent:secret@host' }])).toThrow(/object spec/u)
  })
})
