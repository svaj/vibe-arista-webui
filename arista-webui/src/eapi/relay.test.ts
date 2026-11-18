// The browser relay client (#140a): endpoint plumbing whose *failure shapes* are the product —
// a missing endpoint must answer `{configured: null}` not throw (the app-boot probe relies on
// that), and no error path may ever surface relay-controlled body text (the credential-echo
// guard). fetch is stubbed; nothing here opens a socket.
import { afterEach, describe, expect, it, vi } from 'vitest'

import { disconnectRelay, fetchRelayStatus, setupRelay } from './relay'
import { RELAY_ENDPOINTS } from './relay-protocol'

afterEach(() => {
  vi.unstubAllGlobals()
})

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
}

describe('fetchRelayStatus (#140a)', () => {
  it('GETs the status endpoint and passes the runtime payload through (host + username)', async () => {
    const fetchMock = vi.fn(async (_input: string, _init?: { signal?: AbortSignal | undefined }) =>
      jsonResponse({ configured: 'runtime', host: 'https://sw1.lan', username: 'admin' }))
    vi.stubGlobal('fetch', fetchMock)
    const status = await fetchRelayStatus()
    expect(fetchMock.mock.calls[0]?.[0]).toBe(RELAY_ENDPOINTS.status)
    const init = fetchMock.mock.calls[0]?.[1]
    // The boot probe must be bounded wherever the engine offers timers (jsdom lacks
    // AbortSignal.timeout; relay.ts deliberately degrades to unbounded there — pinned by typeof).
    if (typeof AbortSignal.timeout === 'function') expect(init?.signal).toBeDefined()
    expect(status).toEqual({ configured: 'runtime', host: 'https://sw1.lan', username: 'admin' })
  })

  it('answers env and null verbatim', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ configured: 'env' })))
    expect(await fetchRelayStatus()).toEqual({ configured: 'env' })
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ configured: null })))
    expect(await fetchRelayStatus()).toEqual({ configured: null })
  })

  it('NEVER throws: network failure, HTTP failure, and malformed bodies all answer null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError(' Failed to fetch') }))
    expect(await fetchRelayStatus()).toEqual({ configured: null })
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, 500)))
    expect(await fetchRelayStatus()).toEqual({ configured: null })
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse('nonsense')))
    expect(await fetchRelayStatus()).toEqual({ configured: null })
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ configured: 'runtime', host: 42, username: null })))
    expect(await fetchRelayStatus()).toEqual({ configured: 'runtime' })
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ configured: 'telepathy' })))
    expect(await fetchRelayStatus()).toEqual({ configured: null })
  })
})

describe('setupRelay (#140a)', () => {
  const request = { host: 'https://sw1.lan', username: 'admin', password: 'never-sent' }

  it('POSTs exactly the three allow-listed fields with json content-type', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ configured: 'runtime', host: 'https://sw1.lan' }))
    vi.stubGlobal('fetch', fetchMock)
    const outcome = await setupRelay(request)
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.status).toEqual({ configured: 'runtime', host: 'https://sw1.lan' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { method: string; headers: Record<string, string>; body: string }]
    expect(url).toBe(RELAY_ENDPOINTS.setup)
    expect(init.method).toBe('POST')
    expect(init.headers['content-type']).toBe('application/json' as never)
    expect(Object.keys(JSON.parse(init.body) as Record<string, unknown>).sort()).toEqual(['host', 'password', 'username'])
    // The credential crosses in EXACTLY this body — pinned against the sanctioned placeholder so the
    // F8 scanned-source convention holds while the wire contract stays byte-checked.
    expect(JSON.parse(init.body) as Record<string, unknown>).toEqual({ host: 'https://sw1.lan', username: 'admin', password: 'never-sent' })
  })

  it('maps failures through relayFailureText and never surfaces a response body', async () => {
    const bodyEchoingSecret = { error: 'bad', detail: 'credential never-sent rejected' }
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(bodyEchoingSecret, 502)))
    const outcome = await setupRelay(request)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.message).toMatch(/could not reach/u)
      expect(outcome.message).not.toContain('never-sent')
    }
  })

  it('a dropped connection answers with the dev-server sentence, not a stack', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('socket hang up') }))
    const outcome = await setupRelay(request)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toMatch(/is Vite still running/u)
  })
})

describe('disconnectRelay (#140a)', () => {
  it('POSTs disconnect and reports success/failure as a boolean', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ configured: null })))
    expect(await disconnectRelay()).toBe(true)
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, 500)))
    expect(await disconnectRelay()).toBe(false)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down') }))
    expect(await disconnectRelay()).toBe(false)
  })
})
