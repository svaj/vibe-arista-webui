/**
 * Basic-auth header parity with pyeapi — M2 (#4), the first bullet of PLAN's M2 test list:
 * "byte-exact base64 parity for `admin:` basic auth and no auth header when credentials are absent".
 *
 * The expected values are **not** hand-computed: they were produced by pyeapi's own formula
 * (`base64.encodebytes(f'{u}:{p}'.encode()).decode().replace('\n','')`, `eapilib.py:300-302`) run
 * against this baseline, which is what makes them a parity contract rather than a guess. The
 * long-credential row exists because `encodebytes` wraps at 76 columns and the `replace('\n','')`
 * unwraps it — a naive base64 of a >57-char credential would otherwise differ invisibly.
 */

import { describe, expect, it } from 'vitest'

import { base64Utf8, authorizationHeader, basicAuth } from './auth'

describe('basic auth header (pyeapi parity)', () => {
  it('is byte-exact for admin: — the priv-15 API user with an empty password (DR-009)', () => {
    expect(basicAuth('admin', '')).toBe('Basic YWRtaW46')
  })

  it('matches pyeapi for a normal username/password pair', () => {
    expect(basicAuth('username', 'password')).toBe('Basic dXNlcm5hbWU6cGFzc3dvcmQ=')
  })

  it('base64-encodes the UTF-8 bytes, like .encode() in pyeapi — not the UTF-16 code units of JS', () => {
    expect(base64Utf8('api:päss-word')).toBe('YXBpOnDDpHNzLXdvcmQ=')
    expect(basicAuth('api', 'päss-word')).toBe('Basic YXBpOnDDpHNzLXdvcmQ=')
  })

  it('keeps separators inside the credential intact (a colon in a username, a newline in a password)', () => {
    expect(basicAuth('a:b', 'c\nd')).toBe('Basic YTpiOmMKZA==')
  })

  it('does not line-wrap long credentials, which is what encodebytes + replace("\\n","") produces', () => {
    // pyeapi's own output for `x:` + 100 `y` is 136 characters: `base64.encodebytes` would have
    // wrapped it at 76 columns with newlines, and its `.replace('\n','')` unwraps it. The expected
    // value is spelled structurally ('eDp5' for "x:y", then 33 groups of "yy y") so the assertion
    // cannot be broken by a transcription slip, and the newline check is the actual point.
    const expected = `Basic ${'eDp5' + 'eXl5'.repeat(33)}`
    const header = basicAuth('x', 'y'.repeat(100))
    expect(header).toBe(expected)
    expect(header.length).toBe(142)
    expect(header).not.toContain('\n')
    expect(header).not.toContain('\r')
  })

  it('defaults the password to the empty string, so "admin" alone means "admin:"', () => {
    expect(basicAuth('admin')).toBe('Basic YWRtaW46')
  })
})

describe('when the Authorization header is sent at all', () => {
  it('omits it entirely when no username is configured — local listeners and proxy-injected auth (DR-036)', () => {
    expect(authorizationHeader({})).toBeUndefined()
    expect(authorizationHeader({ username: undefined, password: undefined })).toBeUndefined()
  })

  it('sends it for an empty password, which is a real EOS user with no password', () => {
    expect(authorizationHeader({ username: 'admin', password: '' })).toBe('Basic YWRtaW46')
  })

  it('refuses a password with no username instead of guessing one (pyeapi sends the string "None:None")', () => {
    expect(() => authorizationHeader({ password: 'hunter2' })).toThrow(TypeError)
    expect(() => authorizationHeader({ password: 'hunter2' })).toThrow(/username/)
  })
})
