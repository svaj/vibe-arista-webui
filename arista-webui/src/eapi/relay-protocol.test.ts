// Shared contract of the runtime relay (#140a): host/credential validation is the SINGLE rule
// both the browser and the dev-server plugin enforce, and the timeout pin below is what keeps
// the relay's upstream wait above the client deadline (#153) so the operator always sees the
// typed client timeout rather than a raw 502 from their own dev server.
import { describe, expect, it } from 'vitest'

import {
  RELAY_ENDPOINTS,
  RELAY_UPSTREAM_TIMEOUT_MS,
  relayFailureText,
  validateRelayCredentials,
  validateRelayHost,
} from './relay-protocol'
import { UI_REQUEST_TIMEOUT_MS } from './app-node'

describe('validateRelayHost (#140a)', () => {
  it('accepts bare hosts and host:port, defaulting to 443', () => {
    const bare = validateRelayHost('switch1.lan')
    expect(bare.ok).toBe(true)
    if (bare.ok) expect(bare.target).toEqual({ hostname: 'switch1.lan', port: 443, display: 'https://switch1.lan' })
    const ported = validateRelayHost('192.168.1.10:8443')
    expect(ported.ok).toBe(true)
    if (ported.ok) expect(ported.target.display).toBe('https://192.168.1.10:8443')
  })

  it('accepts an explicit https:// prefix and surrounding whitespace', () => {
    const out = validateRelayHost('  https://sw-01.corp.example  ')
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.target.hostname).toBe('sw-01.corp.example')
  })

  it('lowercases the hostname the relay will dial and display', () => {
    const out = validateRelayHost('SW-01.Corp.Example')
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.target.display).toBe('https://sw-01.corp.example')
  })

  it('accepts bracketed IPv6 and rejects bare (ambiguous-with-port) IPv6', () => {
    expect(validateRelayHost('[fd00::1]').ok).toBe(true)
    expect(validateRelayHost('[fd00::1]:8443').ok).toBe(true)
    const bare = validateRelayHost('fd00::1')
    expect(bare.ok).toBe(false)
  })

  it('mirrors createEapiProxy refusals: http scheme, credentials, path/query/fragment', () => {
    for (const bad of ['http://switch1.lan', 'https://user:pw@switch1.lan', 'switch1.lan/path', 'switch1.lan?x=1', 'switch1.lan#f']) {
      const out = validateRelayHost(bad)
      expect(out.ok, bad).toBe(false)
    }
  })

  it('refuses empty, control characters, invalid ports, and malformed hostnames', () => {
    const refusals: readonly (readonly [string, RegExp])[] = [
      ['', /required/u],
      ['   ', /required/u],
      ['switch\u00071.lan', /control characters/u],
      ['switch1.lan:0', /1-65535/u],
      ['switch1.lan:99999', /not a parsable host/u], // URL itself overflows before our range check
      ['-switch.lan', /not a valid hostname/u],
      ['switch..lan', /not a valid hostname/u],
      [':443', /not a parsable host/u],
    ]
    for (const [input, pattern] of refusals) {
      const out = validateRelayHost(input)
      expect(out.ok, input).toBe(false)
      if (!out.ok) expect(out.refusal, input).toMatch(pattern)
    }
  })
})

describe('validateRelayCredentials (#140a)', () => {
  it('accepts an ordinary pair and returns it verbatim', () => {
    const out = validateRelayCredentials('admin', 'never-sent')
    expect(out.ok).toBe(true)
    if (out.ok) expect(out).toMatchObject({ username: 'admin', password: 'never-sent' })
  })

  it('refuses empty, over-length, and control-character credentials', () => {
    expect(validateRelayCredentials('', 'x').ok).toBe(false)
    expect(validateRelayCredentials('u', '').ok).toBe(false)
    expect(validateRelayCredentials('u'.repeat(257), 'x').ok).toBe(false)
    const newline = validateRelayCredentials('admin\r\nX-Injected: 1', 'x')
    expect(newline.ok).toBe(false)
    if (!newline.ok) expect(newline.refusal).toMatch(/control characters/u)
  })

  it('refuses non-string inputs (the JSON body is unknown until checked)', () => {
    expect(validateRelayCredentials(42 as unknown, 'x').ok).toBe(false)
    expect(validateRelayCredentials('u', null as unknown).ok).toBe(false)
  })
})

describe('the shared numbers (#140a)', () => {
  it('pins the relay upstream wait ABOVE the UI request deadline', () => {
    // If someone lowers THIS, client timeouts still win but slow-but-live devices start 502-ing
    // their own reads. If someone raises UI_REQUEST_TIMEOUT_MS past it, the dev server starts
    // answering before the browser decided to give up — the #153 typed-timeout UX would regress.
    expect(RELAY_UPSTREAM_TIMEOUT_MS).toBeGreaterThan(UI_REQUEST_TIMEOUT_MS)
  })

  it('keeps RELAY_ENDPOINTS distinct from the device path it forwards', () => {
    expect(RELAY_ENDPOINTS.commandApi).toBe('/command-api')
    for (const path of [RELAY_ENDPOINTS.status, RELAY_ENDPOINTS.setup, RELAY_ENDPOINTS.disconnect]) {
      expect(path.startsWith('/__eapi/')).toBe(true)
    }
  })
})

describe('relayFailureText (#140a)', () => {
  it('maps each documented status WITHOUT ever quoting a response body', () => {
    expect(relayFailureText(400)).toMatch(/refused the request body/u)
    expect(relayFailureText(405)).toMatch(/POST/u)
    expect(relayFailureText(409)).toMatch(/env-var proxy owns/u)
    expect(relayFailureText(415)).toMatch(/application\/json/u)
    expect(relayFailureText(502)).toMatch(/could not reach/u)
    const odd = relayFailureText(418)
    expect(odd).toBe('the relay answered HTTP 418')
    // Every arm above is static copy built from the numeric status alone — no arm can echo a
    // relay response body, which is the credential-leak class this builder exists to prevent.
  })
})
