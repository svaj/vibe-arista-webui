/**
 * Endpoint resolution + the loopback predicate — M2 (#4).
 *
 * These are the pyeapi defaults (`DEFAULT_HTTPS_PORT`/`DEFAULT_HTTP_PORT`/`DEFAULT_HTTP_PATH`,
 * `eapilib.py:60-65`) plus the DR-036 `baseUrl` form the dev proxy needs. Two divergences are asserted
 * here rather than in the transport tests, because they are where the decisions live:
 *  - `path` is honoured (pyeapi accepts it in the connection constructor and then hard-codes
 *    `POST /command-api` in `send`, so the option silently does nothing — MIGRATION.md §5 row 24);
 *  - a missing host is an error, not `'localhost'` (pyeapi defaults the host; DR-008 forbids us from
 *    inventing one outside the switch-local kinds — row 8).
 */

import { describe, expect, it } from 'vitest'

import { isLoopbackHost, normalizePath, resolveEndpoint } from './endpoint'

describe('pyeapi defaults', () => {
  it('https lands on 443 with /command-api', () => {
    const endpoint = resolveEndpoint({ host: 'sw1.lan' }, { scheme: 'https', port: 443 })
    expect(endpoint.address).toBe('https://sw1.lan:443/command-api')
    // `address` is our display/log string and always names the port; `url.href` is the WHATWG
    // normalisation, which drops an explicit default port. Same request, two renderings — the
    // asymmetry is pinned by the dedicated test below.
    expect(endpoint.url.href).toBe('https://sw1.lan/command-api')
    expect(endpoint.url.port).toBe('')
  })

  it('http lands on 80 with /command-api', () => {
    expect(resolveEndpoint({ host: 'sw1.lan' }, { scheme: 'http', port: 80 }).address).toBe('http://sw1.lan:80/command-api')
  })

  it('the display address always names the port, unlike URL.href which drops the default one', () => {
    const endpoint = resolveEndpoint({ host: 'sw1', port: 443 }, { scheme: 'https', port: 443 })
    expect(endpoint.address).toBe('https://sw1:443/command-api')
    expect(endpoint.url.href).toBe('https://sw1/command-api')
  })
})

describe('path and baseUrl (DR-036)', () => {
  it('honours an explicit path (pyeapi ignores it in send)', () => {
    expect(resolveEndpoint({ host: 'sw1', path: '/eapi/v1' }, { scheme: 'https', port: 443 }).path).toBe('/eapi/v1')
  })

  it('accepts a bare origin and appends the request path', () => {
    const endpoint = resolveEndpoint({ baseUrl: 'http://127.0.0.1:5173' }, { scheme: 'https', port: 443 })
    expect(endpoint.scheme).toBe('http')
    expect(endpoint.address).toBe('http://127.0.0.1:5173/command-api')
  })

  it('keeps a path prefix from the baseUrl instead of replacing it, which is how a dev proxy lives', () => {
    const endpoint = resolveEndpoint({ baseUrl: 'https://gw.internal:8443/eapi', path: '/command-api' }, { scheme: 'https', port: 443 })
    expect(endpoint.path).toBe('/eapi/command-api')
  })

  it('lets an explicit host/port override what the baseUrl implies', () => {
    const endpoint = resolveEndpoint({ baseUrl: 'https://gw.internal/eapi', host: '10.0.0.5', port: 443 }, { scheme: 'https', port: 443 })
    expect(endpoint.address).toBe('https://10.0.0.5:443/eapi/command-api')
  })

  it('refuses a baseUrl that is not an http(s) origin', () => {
    expect(() => resolveEndpoint({ baseUrl: 'ws://sw1' }, { scheme: 'https', port: 443 })).toThrow(TypeError)
    expect(() => resolveEndpoint({ baseUrl: 'not a url' }, { scheme: 'https', port: 443 })).toThrow(TypeError)
  })

  it('normalizes a path to one leading slash and no doubled slashes', () => {
    expect(normalizePath('//a//b/')).toBe('/a/b')
    expect(normalizePath('/')).toBe('/')
    expect(() => normalizePath('command-api')).toThrow(TypeError)
  })
})

describe('refusals that keep the caller honest', () => {
  it('requires an explicit host: no invented localhost default (DR-008)', () => {
    expect(() => resolveEndpoint({}, { scheme: 'https', port: 443 })).toThrow(/never defaults to localhost/)
  })

  it('rejects an out-of-range or non-integer port', () => {
    expect(() => resolveEndpoint({ host: 'sw1', port: 70_000 }, { scheme: 'https', port: 443 })).toThrow(TypeError)
    expect(() => resolveEndpoint({ host: 'sw1', port: 443.5 }, { scheme: 'https', port: 443 })).toThrow(TypeError)
  })
})

describe('the loopback gate (DR-008/DR-014)', () => {
  it.each([
    ['127.0.0.1', true],
    ['127.9.9.9', true],
    ['localhost', true],
    ['LOCALHOST', true],
    ['::1', true],
    ['[::1]', true],
    ['ip6-localhost', true],
    ['10.0.0.5', false],
    ['sw1.lan', false],
    ['127.1', false],
    ['::ffff:127.0.0.1', false],
    ['0.0.0.0', false],
  ])('isLoopbackHost(%s) === %s', (host, expected) => {
    expect(isLoopbackHost(host)).toBe(expected)
  })
})
