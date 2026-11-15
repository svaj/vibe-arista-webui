/**
 * S14 (#84): the pure rules behind the read-only MLAG status screen. The authority for every
 * shape here is the FROZEN client (`arista-api-client/src/resources/mlag.ts`, divergences 1/3
 * quoted below) and the captured contract (`src/eapi/show-contracts.ts`, `ShowMlagReply`) —
 * nothing in this spec invents a field, a default, or a device behaviour.
 */
import { describe, expect, it } from 'vitest'

import {
  describeShutdownFlag,
  deviceStateView,
  fieldText,
  flagText,
  isMlagUnconfigured,
  KNOWN_MLAG_STATE_LABELS,
  NOT_CONFIGURED,
} from './mlag-rules'
import type { ShowMlagReply } from '../../eapi/show-contracts'

/** The captured not-configured reply, keys and values verbatim from `test/fixtures/live/ceos-4.28.14M/show-mlag.json` (result half). */
const capturedDisabled: ShowMlagReply = {
  state: 'disabled',
  localInterface: '',
  peerLink: '',
  reloadDelay: 300,
  reloadDelayNonMlag: 300,
  mlagPorts: { Disabled: 0, 'Active-partial': 0, Inactive: 0, Configured: 0, 'Active-full': 0 },
  portsErrdisabled: false,
  dualPrimaryDetectionState: 'disabled',
  dualPrimaryPortsErrdisabled: false,
}

describe('deviceStateView — maps ONLY the captured state key, echoes raw always', () => {
  it.each([
    ['active', 'Active'],
    ['disabled', 'Disabled'],
    ['inactive', 'Inactive'],
    ['paused', 'Paused'],
    ['misconfigured', 'Misconfigured'],
  ] as const)('the five mapped tokens report raw %s beside the label %s', (raw, label) => {
    const view = deviceStateView({ ...capturedDisabled, state: raw }, undefined)
    expect(view).toEqual({ kind: 'reported', raw, label, recognised: true })
  })

  it('a token outside the five is shown verbatim and marked unrecognised (no invented label)', () => {
    const view = deviceStateView({ ...capturedDisabled, state: 'peer-link-bleh' }, undefined)
    expect(view.kind).toBe('reported')
    if (view.kind !== 'reported') return
    expect(view.raw).toBe('peer-link-bleh')
    expect(view.recognised).toBe(false)
    expect(view.label).toMatch(/shown exactly as the device sent it/u)
  })

  it('case is kept honest: the capture vocabulary is lowercase, a capitalised spelling is unrecognised, not folded', () => {
    const view = deviceStateView({ ...capturedDisabled, state: 'Active' }, undefined)
    if (view.kind !== 'reported') throw new Error('expected a reported arm')
    expect(view.recognised).toBe(false)
    expect(view.raw).toBe('Active')
  })

  it('an empty state string reports itself as empty rather than borrowing the disabled meaning', () => {
    const view = deviceStateView({ ...capturedDisabled, state: '' }, undefined)
    if (view.kind !== 'reported') throw new Error('expected a reported arm')
    expect(view.recognised).toBe(false)
    expect(view.label).toMatch(/empty state string/u)
  })

  it('an unanswered read yields the unknown arm with a default reason (never a crash, never a claim)', () => {
    expect(deviceStateView(undefined, undefined)).toEqual({
      kind: 'unknown',
      reason: 'The `show mlag` read did not answer.',
    })
  })

  it('a folded failure — e.g. the Error [1002] refusal — rides verbatim into the unknown arm', () => {
    const view = deviceStateView(undefined, 'Error [1002]: invalid command mlag [SYNTHETIC]')
    expect(view.kind).toBe('unknown')
    if (view.kind !== 'unknown') return
    expect(view.reason).toContain('1002')
  })

  it('the mapped-token table is exactly the five #84 names (a sixth sneaks in only with the issue)', () => {
    expect(Object.keys(KNOWN_MLAG_STATE_LABELS)).toEqual(['active', 'disabled', 'inactive', 'paused', 'misconfigured'])
  })
})

describe('isMlagUnconfigured — the client\u2019s divergence-1 section-absence test', () => {
  it('all five fields absent and no interfaces is not-configured (the captured sample shape)', () => {
    expect(isMlagUnconfigured({}, 0)).toBe(true)
  })

  it.each(['domainId', 'localInterface', 'peerAddress', 'peerLink'] as const)('a present %s line means the domain is configured', (key) => {
    expect(isMlagUnconfigured(key === 'peerAddress' ? { peerAddress: '10.0.0.1' } : { [key]: 'values-dont-matter' }, 0)).toBe(false)
  })

  it('shutdown ALONE flips the answer: a present section always carries the derived flag (divergence 3)', () => {
    expect(isMlagUnconfigured({ shutdown: true }, 0)).toBe(false)
    expect(isMlagUnconfigured({ shutdown: false }, 0)).toBe(false)
  })

  it('interfaces alone flip the answer even with no global section', () => {
    expect(isMlagUnconfigured({}, 1)).toBe(false)
  })
})

describe('flag/field display helpers — absence is its own answer', () => {
  it('fieldText keeps a present value and marks absence without guessing a default', () => {
    expect(fieldText('Vlan4094')).toBe('Vlan4094')
    expect(fieldText(undefined)).toBe(NOT_CONFIGURED)
  })

  it('flagText says Yes/No for the booleans and (not reported) for absence', () => {
    expect(flagText(true)).toBe('Yes')
    expect(flagText(false)).toBe('No')
    expect(flagText(undefined)).toBe('(not reported)')
  })

  it('describeShutdownFlag keeps the three arms distinct: explicit no-shutdown, derived yes, absent section', () => {
    expect(describeShutdownFlag(false)).toMatch(/explicit `no shutdown` line/u)
    expect(describeShutdownFlag(true)).toMatch(/DERIVES/u)
    expect(describeShutdownFlag(undefined)).toMatch(/no `mlag configuration` section/u)
  })
})
