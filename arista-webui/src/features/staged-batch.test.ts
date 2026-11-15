/**
 * The narrowing every screen's write path relies on (`staged-batch.ts`, shared by S1 #71 and S2 #72):
 * a staged batch arrives as `CommandSpec[]` and must reach the review panel and the destructive guards
 * as command **lines**. The pass-through case is the ordinary one; the interesting case is the loud one —
 * a composer that ever returns `{ cmd, input }` (a multiline verb) must throw here rather than have an
 * operator read `undefined` where a command should be.
 */
import { describe, expect, it } from 'vitest'

import { stageDisplay, stageLines } from './staged-batch'

describe('stageLines', () => {
  it('passes the plain command lines through unchanged, in order', () => {
    expect(stageLines(['interface Ethernet1', 'no shutdown'])).toEqual(['interface Ethernet1', 'no shutdown'])
  })

  it('refuses an object spec instead of rendering an unusable line', () => {
    // `commandBuilder.copyRunToStart()` is the real shape this guard exists for: a spec with an `input`.
    expect(() => stageLines([{ cmd: 'copy running-config startup-config', input: 'agent:secret@host' }])).toThrow(/object spec/u)
  })
})

describe('stageDisplay (#78: the review copy for batches that may carry multiline specs)', () => {
  it('passes plain lines through exactly like stageLines', () => {
    expect(stageDisplay(['ip routing', 'no banner motd'])).toEqual(['ip routing', 'no banner motd'])
  })

  it('digests the banner framing — a count and the terminator contract, never the inlined body', () => {
    // The byte-exact client framing (system.ts setBanner): body + `\nEOF\n`.
    expect(stageDisplay([{ cmd: 'banner motd', input: 'line one\nline two\nEOF\n' }]))
      .toEqual(['banner motd (multiline input: 2 line(s), EOF-terminated)'])
    expect(stageDisplay([{ cmd: 'banner login', input: '\nEOF\n' }]))
      .toEqual(['banner login (multiline input: 0 line(s), EOF-terminated)'])
  })

  it('digests an input that is not in the client framing by its raw shape (#124: the fallback arms #78 left open)', () => {
    // `setBanner` always sends `body\nEOF\n`, so neither fallback is reachable from this app's own
    // verbs — #78 recorded that. The digester is still contract-bound to it: a batch arriving in a
    // different framing (a replayed journal line, a future verb) must digest its RAW shape, and the
    // copy's "EOF-terminated" phrase names the client convention (the contract the reviewer is
    // accepting), never a claim that the body carried the terminator.
    expect(stageDisplay([{ cmd: 'banner motd', input: 'just one line' }]))
      .toEqual(['banner motd (multiline input: 1 line(s), EOF-terminated)'])
    expect(stageDisplay([{ cmd: 'banner login', input: 'a\nb\n' }]))
      .toEqual(['banner login (multiline input: 2 line(s), EOF-terminated)'])
  })

  it('an object spec without an input renders just its command (and a bare cmd is digest-safe all the same)', () => {
    expect(stageDisplay([{ cmd: 'profile x' }])).toEqual(['profile x'])
  })
})
