/**
 * S12 (#82): the pure rules behind the NTP screen. These mirror the frozen client contract, so
 * `arista-api-client/src/resources/ntp.test.ts`'s pinned command texts are the authority — every
 * command string asserted here is copied from those pins, never invented.
 */
import { describe, expect, it } from 'vitest'

import { serverAddLine, serverAddressRule, sourceStem, versionFloorAtLeast } from './ntp-rules'

describe('versionFloorAtLeast — the client\u2019s floor compare (resources/ntp.ts, DR-078)', () => {
  it('picks local-interface at/above 4.23 and source below, comparing numerically not lexically', () => {
    for (const [version, atLeast] of [
      ['4.28.13.1M', true],
      ['4.23.1F', true],
      ['5.0.1F', true],
      ['4.22.2F', false],
      // The character-compare trap: '4.9' >= '4.23' is true lexically, but 4.9 predates 4.23.
      ['4.9.13.1F', false],
      ['3.21.1F', false],
    ] as const) {
      expect(versionFloorAtLeast(version, [4, 23]), version).toBe(atLeast)
    }
  })

  it('a version with no leading major.minor is unclassifiable (undefined → the caller must refuse)', () => {
    for (const bad of ['software-version-string', '4', 'v4.23']) {
      expect(versionFloorAtLeast(bad, [4, 23]), bad).toBeUndefined()
    }
  })

  it('a structurally-parsable but non-safe-integer major is refused (guards Number precision)', () => {
    expect(versionFloorAtLeast('99999999999999999999.5', [4, 23])).toBeUndefined()
  })
})

describe('sourceStem — mirrors sourceKeyword, refuses rather than guessing', () => {
  it('4.28 (this target) takes the dashed 4.23 form', () => {
    expect(sourceStem('4.28.13.1M')).toEqual({ ok: true, stem: 'ntp local-interface' })
  })
  it('a pre-4.23 release keeps the old `ntp source` stem', () => {
    expect(sourceStem('4.17.1.1')).toEqual({ ok: true, stem: 'ntp source' })
  })
  it('an unclassifiable version refuses to compose a source command', () => {
    const result = sourceStem('software-version-string')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal).toMatch(/cannot classify the device version/)
  })
  it('a missing version read (silent failure) also refuses — the floor needs some number', () => {
    const result = sourceStem(undefined)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal).toMatch(/show version.{0,40}did not answer/u)
  })
})

describe('serverAddressRule — mirrors assertServerAddress (single token, non-empty)', () => {
  it('accepts a normal one-token address', () => {
    expect(serverAddressRule('1.1.1.1')).toBeUndefined()
    expect(serverAddressRule('  clock.example  ')).toBeUndefined()
  })
  it('refuses empty / whitespace-only with pyeapi\u2019s message context', () => {
    expect(serverAddressRule('')).toMatch(/empty NTP server address/)
    expect(serverAddressRule('   ')).toMatch(/empty NTP server address/)
  })
  it('refuses a spaced address — the un-ported option spellings (#82 acceptance)', () => {
    for (const bad of ['1.1.1.1 prefer', '1.2.3.4 iburst', '1.2.3.4 version 4']) {
      expect(serverAddressRule(bad), bad).toMatch(/trailing option spellings are/)
    }
  })

  it('refuses a control character inside the address (mirrors assertServerAddress)', () => {
    expect(serverAddressRule('1.2.3.4\u0007')).toMatch(/control character/)
  })
})

describe('serverAddLine — the exact wire text the client composes (ntp.test.ts pins)', () => {
  it('plain and preferred forms are byte-identical to the client', () => {
    expect(serverAddLine('1.1.1.1', false)).toBe('ntp server 1.1.1.1')
    expect(serverAddLine('1.1.1.1', true)).toBe('ntp server 1.1.1.1 prefer')
  })
})
