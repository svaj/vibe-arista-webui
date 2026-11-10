/**
 * S8 (#78): unit pins for the mirrored client rules. These are the client's OWN rules transcribed
 * for in-form refusal (the header of ./system-rules.ts states the mirror contract: the client is
 * policy, the device is authority — these tests pin the mirror, not EOS).
 */
import { describe, expect, it } from 'vitest'

import { bannerFraming, BANNER_KINDS, hostnameRule, HOSTNAME_MAX_LENGTH } from './system-rules'

describe('hostnameRule — mirrors assertHostname (resources/system.ts), label-first messages', () => {
  it('accepts a plain token', () => {
    expect(hostnameRule('sw1-lab')).toBeUndefined()
  })
  it('refuses empty/blank with the Remove-hostname pointer', () => {
    expect(hostnameRule('   ')).toMatch(/refuses an empty hostname.*`no hostname`/su)
  })
  it('refuses over-length at the same bound as the client (128)', () => {
    expect(HOSTNAME_MAX_LENGTH).toBe(128)
    expect(hostnameRule('a'.repeat(128))).toBeUndefined()
    expect(hostnameRule('a'.repeat(129))).toMatch(/128 characters/)
  })
  it('refuses whitespace and control characters', () => {
    expect(hostnameRule('two words')).toMatch(/single token/u)
    // eslint-disable-next-line no-control-regex
    expect(hostnameRule('bell\u0007name')).toMatch(/single token/u)
  })
  it('refuses the quote round-trip hazard, labelled unverified', () => {
    expect(hostnameRule('quote"name')).toMatch(/double quote.*unverified on hardware/u)
  })
  it('refuses a leading digit and names the rule as purely client-side', () => {
    const refusal = hostnameRule('9lives')
    expect(refusal).toMatch(/starting with a digit/u)
    expect(refusal).toMatch(/purely client-side rule/u)
    expect(refusal).toMatch(/device keeps authority|referee/iu)
  })
})

/** Extract the refusal text from a framing result, or `undefined` when it framed cleanly. */
function refusalOf(framed: ReturnType<typeof bannerFraming>): string | undefined {
  return 'refusal' in framed ? framed.refusal : undefined
}

describe('bannerFraming — the byte-exact EOF payload (DR-015/DR-056) and the early-EOF guard', () => {
  it('frames the input byte-for-byte as body + \\nEOF\\n', () => {
    const framed = bannerFraming('motd', 'Authorized access only.')
    expect(framed).toEqual({ body: 'Authorized access only.', input: 'Authorized access only.\nEOF\n' })
  })
  it('folds ONE trailing caller newline so x and x\\n are wire-identical (the client keeps this pin)', () => {
    const bare = bannerFraming('motd', 'text')
    const crlfed = bannerFraming('motd', 'text\n')
    expect(bare).toEqual(crlfed)
    // A genuinely blank extra line survives — only ONE trailing newline is folded.
    const two = bannerFraming('motd', 'text\n\n')
    expect(two).not.toEqual(bare)
    expect('input' in two && two.input).toBe('text\n\nEOF\n')
  })
  it('refuses a carriage return with the read-back reason', () => {
    expect(refusalOf(bannerFraming('motd', 'a\r\nb'))).toMatch(/carriage return/u)
  })
  it('refuses an empty or whitespace-only body, pointing at Remove', () => {
    expect(refusalOf(bannerFraming('login', ''))).toMatch(/empty login banner body/u)
    expect(refusalOf(bannerFraming('login', '   \n'))).toMatch(/empty login banner body/u)
  })
  it('refuses any body line reading EOF, rstripped like the chunker compares it (client.py:743)', () => {
    expect(refusalOf(bannerFraming('motd', 'hi\nEOF\nthere'))).toMatch(/end the block early/u)
    expect(refusalOf(bannerFraming('motd', 'hi\nEOF  \nthere'))).toMatch(/end the block early/u)
    // Words CONTAINING EOF are fine — parity with the client's whole-line rstrip comparison.
    expect(bannerFraming('motd', 'EOF-marker note')).toEqual({ body: 'EOF-marker note', input: 'EOF-marker note\nEOF\n' })
  })
  it('the kind set is the closed triple mirroring assertBannerKind/BANNER_KINDS', () => {
    expect(BANNER_KINDS).toEqual(['login', 'motd', 'exec'])
  })
})
