/**
 * S9 (#79): pure-rule pins for the transaction center — the stage guard that keeps commit/abort as
 * the confirmed buttons, and the honest renderers for recovery buckets and verify labelling.
 */
import { describe, expect, it } from 'vitest'

import {
  describeRecovery,
  describeSessionRow,
  draftBatchRefusal,
  parseDraftLines,
  VERIFY_LABEL,
} from './session-rules'

describe('parseDraftLines', () => {
  it('splits, trims, drops blanks (CRLF too)', () => {
    expect(parseDraftLines('interface Vlan77\r\n  description tx\r\n\r\n')).toEqual(['interface Vlan77', 'description tx'])
  })
})

describe('draftBatchRefusal — commit/abort stay outside the batch (DR-050)', () => {
  it('empty batch refuses at zero sessions', () => {
    expect(draftBatchRefusal([])).toMatch(/at least one config line/u)
  })
  it('the session-hijacking verbs are refused with reasons; words merely containing them pass', () => {
    for (const verb of ['commit', 'abort', 'configure session', 'configure replace', 'rollback', 'reload']) {
      expect(draftBatchRefusal([`${verb} now`]), verb).toMatch(/transaction center refuses/u)
    }
    expect(draftBatchRefusal(['copy running-config startup-config'])).toMatch(/DR-024/u)
    expect(draftBatchRefusal(['commit-buffer tail', 'rollback-time note'])).toBeUndefined()
  })
  it('control characters and absurd lengths are refused', () => {
    expect(draftBatchRefusal(['vlan 9\u0007'])).toMatch(/control character/u)
    expect(draftBatchRefusal(['a'.repeat(513)])).toMatch(/512 characters/u)
  })
  it('a clean config batch is accepted', () => {
    expect(draftBatchRefusal(['interface Vlan77', 'description tx center', 'no shutdown'])).toBeUndefined()
  })
})

describe('describeSessionRow — pending/timer/state are TEXT claims the confirm copy can quote', () => {
  it('pending names the lock; an armed timer upgrades the label and the note (never auto-abort)', () => {
    expect(describeSessionRow({ name: 'ui-a', state: 'pending', instances: [] }).label).toMatch(/holds the config lock/u)
    const armed = describeSessionRow({ name: 'ui-a', state: 'pending', commitBy: 123, instances: [] })
    expect(armed.label).toMatch(/COMMIT TIMER is armed/u)
    expect(armed.timerNote).toMatch(/never aborts a timer-armed session/u)
    expect(armed.dangerous).toBe(true)
  })
  it('a non-pending state is echoed, not renamed (DR-032)', () => {
    const row = describeSessionRow({ name: 'x', state: 'SYNTHETIC-future-state', instances: [] })
    expect(row.label).toBe('SYNTHETIC-future-state')
    expect(row.dangerous).toBe(false)
  })
})

describe('describeRecovery — every bucket rides, nothing dropped', () => {
  it('renders one line per NON-EMPTY bucket, naming members and reasons', () => {
    const lines = describeRecovery({
      aborted: ['ui-old'],
      failed: [{ name: 'ui-refused', reason: 'already gone' }],
      skipped: [{ name: 'ui-timer' }, { name: 'ui-new', reason: 'too new' }],
      remaining: [{ name: 'ui-timer', state: 'pending' }],
      reported: [{ name: 'saved-1', state: 'completed' }],
    })
    expect(lines).toHaveLength(5)
    expect(lines[0]).toBe('aborted by this run (1): ui-old')
    expect(lines[1]).toContain('already gone')
    // The skipped bucket's title is the sentence that explains WHY things were left alone.
    expect(lines[2]).toMatch(/left alone .*\(2\): ui-timer, ui-new — too new/u)
    expect(lines[3]).toContain('ui-timer [pending]')
    expect(lines[4]).toContain('ignored by design')
  })
  it('empty buckets contribute nothing (a clean recovery says so in the header, not five zeros)', () => {
    const lines = describeRecovery({ aborted: ['x'], failed: [], skipped: [], remaining: [], reported: [] })
    expect(lines).toEqual(['aborted by this run (1): x'])
  })
})

describe('verify labelling', () => {
  it('the standing label names the clean-config origin AND forbids the pre-flight misreading (DR-061)', () => {
    expect(VERIFY_LABEL).toMatch(/CLEAN config/u)
    expect(VERIFY_LABEL).toMatch(/does NOT show what your change would do/u)
  })
})
