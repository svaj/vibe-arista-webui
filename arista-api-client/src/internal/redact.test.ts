/**
 * DR-011 redaction suite — M1 (#3). pyeapi's own behaviour here is 1005-only
 * (`test/unit/test_eapilib.py` has no coverage for the leak on other codes), so these cases are
 * authored from the verified EOS message building (`JsonCli.py:437-444`, `CliApi.py:277-287`) and
 * extended to every code, per DR-011.
 */

import { describe, expect, it } from 'vitest'

import { REDACTED, redactCommandText, redactCommands, redactSecrets, redactWireText } from './redact'
import type { CommandSpec } from '../types/eapi'

const SECRET = 'pw-from-fixture-probe'

describe('redactCommandText — the input= echo EOS appends', () => {
  it('redacts a single-quoted repr value', () => {
    expect(redactCommandText(`CLI command 1 of 3 'enable' failed: unauthorized input='${SECRET}'`)).toBe(
      `CLI command 1 of 3 'enable' failed: unauthorized input=${REDACTED}`,
    )
  })

  it('redacts double-quoted, bare and spaced-around-= forms, in any case', () => {
    expect(redactCommandText(`input="${SECRET}"`)).toBe('input=<redacted>')
    expect(redactCommandText(`input=${SECRET}`)).toBe('input=<redacted>')
    expect(redactCommandText(`input = '${SECRET}'`)).toBe('input = <redacted>')
    expect(redactCommandText(`INPUT=${SECRET}`)).toBe('INPUT=<redacted>')
  })

  it('keeps a quoted value that contains spaces together', () => {
    expect(redactCommandText("input='two word value'")).toBe('input=<redacted>')
  })

  it('redacts a multiline input repr without swallowing the sentence after it', () => {
    expect(redactCommandText(`input='line1\\nline2\\n' and then something else`)).toBe(
      'input=<redacted> and then something else',
    )
  })

  it('leaves repr punctuation alone so a second pass cannot mangle an already-redacted string', () => {
    const once = redactCommandText(`errors: ['input=${SECRET}']`)
    expect(once).toBe("errors: ['input=<redacted>']")
    expect(redactCommandText(once)).toBe(once)
  })

  it('is idempotent for a value that carries no secret', () => {
    const text = "CLI command 2 of 3 'vlan 4095' failed: invalid command"
    expect(redactCommandText(redactCommandText(text))).toBe(text)
    expect(redactCommandText(text)).toBe(text)
  })
})

describe('redactCommandText — username … secret/password …', () => {
  it('keeps the algorithm keyword and drops the value', () => {
    expect(redactCommandText('username admin privilege 15 secret plain s3cr3t-admin')).toBe(
      'username admin privilege 15 secret plain <redacted>',
    )
    expect(redactCommandText('username admin secret sha512 $6$rounds$abcdef')).toBe('username admin secret sha512 <redacted>')
    expect(redactCommandText('username operator password operator-pass')).toBe('username operator password <redacted>')
    expect(redactCommandText('username role network-admin secret 5 $1$x$y')).toBe('username role network-admin secret 5 <redacted>')
  })

  it('redacts a quoted credential value including spaces', () => {
    expect(redactCommandText("username admin secret 'two word pass'")).toBe('username admin secret <redacted>')
  })

  it('does not reach across a newline when a username line has no credential keyword', () => {
    const config = 'username admin role network-admin\naaa authorization console\nip ssh password-timeout 3\n'
    expect(redactCommandText(config)).toBe(config)
  })
})

describe('redactCommands — the request body shape', () => {
  it('replaces the input of an enable command', () => {
    const commands: CommandSpec[] = [{ cmd: 'enable', input: SECRET }, 'show version']
    expect(redactCommands(commands)).toEqual([{ cmd: 'enable', input: REDACTED }, 'show version'])
  })

  it('keeps a non-secret multiline input (banner) intact — redaction stays narrow, DR-011', () => {
    const commands: CommandSpec[] = [{ cmd: 'banner motd', input: 'keep this text\nEOF\n', revision: 1 }]
    expect(redactCommands(commands)).toEqual(commands)
  })

  it('redacts secrets inside command strings, including the `enable <arg>` form', () => {
    expect(redactCommands(['enable secret-ish x', 'username bob secret plain pw123'])).toEqual([
      'enable secret-ish x',
      'username bob secret plain <redacted>',
    ])
  })

  it('does not mutate the caller’s array or objects', () => {
    const command = { cmd: 'enable', input: SECRET }
    const commands = [command]
    redactCommands(commands)
    expect(command.input).toBe(SECRET)
  })

  it('enable detection is case-insensitive', () => {
    expect(redactCommands([{ cmd: 'ENABLE', input: SECRET }])).toEqual([{ cmd: 'ENABLE', input: REDACTED }])
  })
})

describe('redactSecrets — deep structural form (logs, fixtures, error data)', () => {
  it('walks nested arrays and objects, redacting enable inputs at any depth', () => {
    const value = {
      params: { cmds: [{ cmd: 'enable', input: SECRET }, 'username admin secret md5 deadbeef'] },
      nested: [[{ note: 'input=whatever' }]],
    }
    expect(redactSecrets(value)).toEqual({
      params: { cmds: [{ cmd: 'enable', input: REDACTED }, 'username admin secret md5 <redacted>'] },
      nested: [[{ note: 'input=<redacted>' }]],
    })
  })

  it('redacts a JSON member whose key names a credential, without touching the username', () => {
    // The `/login` body the cookie transports post (DR-018) and any proxy error page reflected into
    // an error's rawBody. Key-based, so it does not depend on guessing where a secret ends.
    expect(redactSecrets({ username: 'api', password: 'hunter2' })).toEqual({
      username: 'api',
      password: REDACTED,
    })
    for (const key of ['passwd', 'secret', 'enablePassword', 'api_key', 'token', 'Authorization']) {
      expect(redactSecrets({ [key]: 'hunter2', keep: 'visible' })).toEqual({ [key]: REDACTED, keep: 'visible' })
    }
    // Nested and inside arrays, because a login body is rarely the top-level object we are shown.
    expect(redactSecrets({ request: { body: [{ authorization: 'Basic aGFudDoy' }] } })).toEqual({
      request: { body: [{ authorization: REDACTED }] },
    })
    // An empty value stays empty: redacting it would invent a secret that was never there.
    expect(redactSecrets({ password: '' })).toEqual({ password: '' })
    // Wire text that is not JSON still goes through the text pass.
    expect(redactWireText('{"username":"api","password":"hunter2"}')).toBe(
      `{"username":"api","password":"${REDACTED}"}`,
    )
  })

  it('preserves non-string scalars and key order', () => {
    expect(redactSecrets({ b: 1, a: true, c: null, d: 2.5 })).toEqual({ b: 1, a: true, c: null, d: 2.5 })
    // `redactSecrets` returns `unknown` by contract (it accepts `unknown`), so the object-ness has to
    // be re-asserted here rather than widened away in the implementation.
    const reordered = redactSecrets({ z: 'x', a: 'y' }) as Record<string, unknown>
    expect(Object.keys(reordered)).toEqual(['z', 'a'])
  })

  it('passes scalars through and survives null', () => {
    expect(redactSecrets(null)).toBeNull()
    expect(redactSecrets(7)).toBe(7)
    expect(redactSecrets(undefined)).toBeUndefined()
  })
})

describe('redactWireText — what reaches a log line', () => {
  it('redacts a request body structurally and keeps it parseable (pyeapi _sanitize_request, widened)', () => {
    const request = JSON.stringify({
      jsonrpc: '2.0',
      method: 'runCmds',
      id: 'ui-1',
      params: { version: 1, cmds: [{ cmd: 'enable', input: SECRET }, 'show version'], format: 'json' },
    })
    const redacted = redactWireText(request)
    expect(redacted).not.toContain(SECRET)
    expect(JSON.parse(redacted)).toMatchObject({
      params: { cmds: [{ cmd: 'enable', input: REDACTED }, 'show version'] },
    })
  })

  it('redacts a response body too — pyeapi logs that one raw (eapilib.py:445)', () => {
    const response = JSON.stringify({
      jsonrpc: '2.0',
      error: { code: 1002, message: `CLI command 1 of 2 'enable' failed: nope input='${SECRET}'`, data: [] },
      id: 'ui-2',
    })
    expect(redactWireText(response)).not.toContain(SECRET)
  })

  it('falls back to a text pass when the body is not JSON at all', () => {
    const html = '<html>502 Bad Gateway</html> diagnostic input=pw-from-fixture-probe'
    expect(redactWireText(html)).toBe('<html>502 Bad Gateway</html> diagnostic input=<redacted>')
  })

  it('is idempotent, so a redactor applied twice cannot corrupt the payload', () => {
    const once = redactWireText(`{"cmds":[{"cmd":"enable","input":"${SECRET}"}]}`)
    expect(redactWireText(once)).toBe(once)
  })
})
