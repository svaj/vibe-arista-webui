// @vitest-environment node
/**
 * Unit tests for the #140a dev-server relay middleware (`./eapi-relay.ts`) — driven through the
 * exported middleware factory with stream fakes; **no socket is ever opened** (the upstream is the
 * injectable seam) and every credential assertion is a raw-bytes scan of what the relay answered.
 * Lives at the package root (compiled by tsconfig.node, collected by the added vitest include)
 * because it legitimately imports `node:stream`, which app source may never do.
 */
import { PassThrough, Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'

import { createRelayMiddleware } from './eapi-relay.js'
import type { RelayRequest, RelayResponse, UpstreamRequest } from './eapi-relay.js'
import { RELAY_ENDPOINTS } from './src/eapi/relay-protocol.js'

const PASSWORD = 'sentin-relay-P@ss'

class FakeResponse extends PassThrough {
  statusCode = 0
  responseHeaders: Record<string, unknown> = {}
  declaredHeadersSent = false
  private readonly chunks: Buffer[] = []

  constructor() {
    super()
    // Flow from birth: `data` must be captured even when the middleware ends the response
    // synchronously, before any test-side listener could attach.
    this.on('data', (chunk: Buffer) => { this.chunks.push(chunk) })
  }

  /** NOT an override — connect's `writeHead` lives on ServerResponse, not on Writable. */
  writeHead(status: number, headers?: Record<string, unknown>): this {
    this.statusCode = status
    this.responseHeaders = headers ?? {}
    this.declaredHeadersSent = true
    return this
  }

  /** Collected bytes as text; resolves once the relay has ended the response (or at once if it already did). */
  async bodyText(): Promise<string> {
    if (!this.writableEnded) await new Promise<void>((resolve) => this.once('end', () => { resolve() }))
    return Buffer.concat(this.chunks).toString('utf8')
  }

  get headersSent(): boolean {
    return this.declaredHeadersSent
  }
}

function fakeRequest(url: string, method: string, headers: Record<string, string>, body?: string): RelayRequest {
  const req = new PassThrough()
  Object.assign(req, { url, method, headers })
  if (body !== undefined) queueMicrotask(() => { req.end(body) })
  else queueMicrotask(() => { req.end() })
  return req as unknown as RelayRequest
}

function jsonRequest(url: string, body: string, contentType = 'application/json'): RelayRequest {
  return fakeRequest(url, 'POST', { 'content-type': contentType }, body)
}

/** Upstream stub: records every dial and streams back a canned response. */
function stubbedUpstream(script: { status?: number; headers?: Record<string, string>; body?: string; errorCode?: string; emitTimeout?: boolean } = {}): {
  request: UpstreamRequest
  dials: Record<string, unknown>[]
  bodies: string[]
} {
  const dials: Record<string, unknown>[] = []
  const bodies: string[] = []
  const request: UpstreamRequest = (options, onResponse) => {
    dials.push(options as unknown as Record<string, unknown>)
    const up = new PassThrough()
    const collected: Buffer[] = []
    bodies.push('')
    const index = bodies.length - 1
    up.on('data', (chunk: Buffer) => collected.push(chunk))
    up.on('end', () => {
      bodies[index] = Buffer.concat(collected).toString('utf8')
      const response = Readable.from([Buffer.from(script.body ?? '{}', 'utf8')]) as Readable & { statusCode?: number }
      response.statusCode = script.status ?? 200
      onResponse(Object.assign(response, { headers: { 'content-type': 'application/json', ...(script.headers ?? {}) } }))
    })
    if (script.errorCode !== undefined) {
      const error = Object.assign(new Error(`connect ${script.errorCode}`), { code: script.errorCode })
      // node:https destroys the request socket; mirror with an error on the returned stream.
      queueMicrotask(() => up.destroy(error))
    }
    if (script.emitTimeout === true) {
      // node:http only *emits* 'timeout' on the socket deadline — the middleware must destroy.
      queueMicrotask(() => { up.emit('timeout') })
    }
    return up
  }
  return { request, dials, bodies }
}

async function run(mw: ReturnType<typeof createRelayMiddleware>, req: RelayRequest): Promise<{ res: FakeResponse; forwarded: boolean }> {
  const res = new FakeResponse()
  let forwarded = false
  await new Promise<void>((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      resolve()
    }
    // Listeners BEFORE invoking: a synchronous sendJson may end the stream during mw(...) itself.
    res.once('end', finish)
    res.once('close', finish)
    mw(req, res as unknown as RelayResponse, () => { forwarded = true; finish() })
  })
  return { res, forwarded }
}

const setupBody = JSON.stringify({ host: 'switch1.lan:8443', username: 'admin', password: PASSWORD })

describe('relay middleware — inert paths', () => {
  it('unconfigured: status says null, command-api falls through, unknown paths fall through', async () => {
    const mw = createRelayMiddleware({ envProxyConfigured: false })
    const status = await run(mw, fakeRequest(RELAY_ENDPOINTS.status, 'GET', {}))
    expect(status.res.statusCode).toBe(200)
    expect(JSON.parse(await status.res.bodyText())).toEqual({ configured: null })

    const eapi = await run(mw, jsonRequest(RELAY_ENDPOINTS.commandApi, '{}'))
    expect(eapi.forwarded, 'no runtime target => exactly today vite 404 behavior').toBe(true)

    const other = await run(mw, fakeRequest('/anything', 'GET', {}))
    expect(other.forwarded).toBe(true)
  })

  it('env-proxy-authoritative: status reports env, setup/disconnect 409, command-api falls through to the boot proxy', async () => {
    const mw = createRelayMiddleware({ envProxyConfigured: true })
    const status = await run(mw, fakeRequest(RELAY_ENDPOINTS.status, 'GET', {}))
    expect(JSON.parse(await status.res.bodyText())).toEqual({ configured: 'env' })

    const setup = await run(mw, jsonRequest(RELAY_ENDPOINTS.setup, setupBody))
    expect(setup.res.statusCode).toBe(409)
    expect(JSON.parse(await setup.res.bodyText())).toEqual({ error: 'env-proxy-authoritative' })

    const disconnect = await run(mw, jsonRequest(RELAY_ENDPOINTS.disconnect, ''))
    expect(disconnect.res.statusCode).toBe(409)

    const eapi = await run(mw, jsonRequest(RELAY_ENDPOINTS.commandApi, '{"x":1}'))
    expect(eapi.forwarded, 'the env proxy must receive device traffic unchanged').toBe(true)
  })

  it('relay control routes answer 405 on wrong methods', async () => {
    const mw = createRelayMiddleware({ envProxyConfigured: false })
    expect((await run(mw, jsonRequest(RELAY_ENDPOINTS.status, ''))).res.statusCode).toBe(405)
    expect((await run(mw, fakeRequest(RELAY_ENDPOINTS.setup, 'GET', {}))).res.statusCode).toBe(405)
  })
})

describe('relay middleware — setup', () => {
  it('installs a validated target and NEVER echoes the password anywhere in the reply', async () => {
    const mw = createRelayMiddleware({ envProxyConfigured: false })
    const res = await run(mw, jsonRequest(RELAY_ENDPOINTS.setup, setupBody))
    expect(res.res.statusCode).toBe(200)
    const text = await res.res.bodyText()
    expect(JSON.parse(text)).toEqual({ configured: 'runtime', host: 'https://switch1.lan:8443', username: 'admin' })
    expect(text).not.toContain(PASSWORD)
    expect(Buffer.from(res.res.responseHeaders['content-type'] as string).equals(Buffer.from('application/json'))).toBe(true)

    const status = await run(mw, fakeRequest(RELAY_ENDPOINTS.status, 'GET', {}))
    expect(await status.res.bodyText()).not.toContain(PASSWORD)
  })

  it('refuses non-json content-type, malformed bodies, and off-contract shapes', async () => {
    const mw = createRelayMiddleware({ envProxyConfigured: false })
    expect((await run(mw, jsonRequest(RELAY_ENDPOINTS.setup, 'plain', 'text/plain'))).res.statusCode).toBe(415)
    expect((await run(mw, jsonRequest(RELAY_ENDPOINTS.setup, 'not json'))).res.statusCode).toBe(400)
    expect((await run(mw, jsonRequest(RELAY_ENDPOINTS.setup, '[1,2]'))).res.statusCode).toBe(400)
    const extraKeys = JSON.stringify({ host: 'a.lan', username: 'u', password: 'p', extra: 1 })
    expect((await run(mw, jsonRequest(RELAY_ENDPOINTS.setup, extraKeys))).res.statusCode).toBe(400)
    const missing = JSON.stringify({ host: 'a.lan', username: 'u' })
    expect((await run(mw, jsonRequest(RELAY_ENDPOINTS.setup, missing))).res.statusCode).toBe(400)
    const badHost = JSON.stringify({ host: 'http://a.lan', username: 'u', password: 'p' })
    expect((await run(mw, jsonRequest(RELAY_ENDPOINTS.setup, badHost))).res.statusCode).toBe(400)
  })

  it('disconnect clears the installed target', async () => {
    const mw = createRelayMiddleware({ envProxyConfigured: false })
    await run(mw, jsonRequest(RELAY_ENDPOINTS.setup, setupBody))
    const off = await run(mw, jsonRequest(RELAY_ENDPOINTS.disconnect, ''))
    expect(off.res.statusCode).toBe(200)
    const after = await run(mw, jsonRequest(RELAY_ENDPOINTS.commandApi, '{}'))
    expect(after.forwarded).toBe(true)
  })
})

describe('relay middleware — forwarding', () => {
  it('dials the installed target with the proxy-equivalent options and pipes the reply back', async () => {
    const upstream = stubbedUpstream({ status: 201, headers: { 'content-type': 'application/json-rpc' }, body: '{"jsonrpc":"2.0","result":[],"id":7}' })
    const mw = createRelayMiddleware({ envProxyConfigured: false, upstreamRequest: upstream.request })
    await run(mw, jsonRequest(RELAY_ENDPOINTS.setup, setupBody))

    const payload = JSON.stringify({ jsonrpc: '2.0', method: 'runCmds', params: { cmds: [{ cmd: 'show version', revision: 0 }] }, id: 7 })
    const res = await run(mw, jsonRequest(RELAY_ENDPOINTS.commandApi, payload))
    expect(res.res.statusCode).toBe(201)
    expect(res.res.responseHeaders['content-type']).toBe('application/json-rpc')
    expect(await res.res.bodyText()).toContain('"id":7')

    const dial = upstream.dials[0] as Record<string, unknown>
    expect(dial).toMatchObject({
      hostname: 'switch1.lan',
      port: 8443,
      path: RELAY_ENDPOINTS.commandApi,
      method: 'POST',
      rejectUnauthorized: false,
      timeout: 35_000,
    })
    const headers = dial['headers'] as Record<string, string>
    expect(headers['content-type']).toBe('application/json-rpc')
    expect(headers['content-length']).toBe(String(Buffer.byteLength(payload)))
    expect(headers.authorization).toBe(`Basic ${Buffer.from(`admin:${PASSWORD}`, 'utf8').toString('base64')}`)
    expect(upstream.bodies[0]).toBe(payload)
  })

  it('an upstream refusal becomes a credential-free 502 code payload', async () => {
    const upstream = stubbedUpstream({ errorCode: 'ECONNREFUSED' })
    const mw = createRelayMiddleware({ envProxyConfigured: false, upstreamRequest: upstream.request })
    await run(mw, jsonRequest(RELAY_ENDPOINTS.setup, setupBody))
    const res = await run(mw, jsonRequest(RELAY_ENDPOINTS.commandApi, '{}'))
    // Whichever race wins (destroy-error before response), the reply must be the 502 shape:
    const text = await res.res.bodyText()
    expect(res.res.statusCode).toBe(502)
    expect(JSON.parse(text || '{}')).toMatchObject({ error: 'relay-upstream-failed', code: 'ECONNREFUSED' })
    expect(text).not.toContain(PASSWORD)
  })

  it('a socket idle timeout is destroyed as a coded ETIMEDOUT 502, verified live on this host', async () => {
    // Live check (2026-11-17): a dead loopback port here black-holes the connect (WSL mirrored
    // networking), so the dial sits until RELAY_UPSTREAM_TIMEOUT_MS fires node's 'timeout' event.
    // Node does NOT auto-abort on that event; the middleware must destroy, and the 502 must say
    // ETIMEDOUT rather than "unknown" (originally observed live against a black-holed port).
    const upstream = stubbedUpstream({ emitTimeout: true })
    const mw = createRelayMiddleware({ envProxyConfigured: false, upstreamRequest: upstream.request })
    await run(mw, jsonRequest(RELAY_ENDPOINTS.setup, setupBody))
    const res = await run(mw, jsonRequest(RELAY_ENDPOINTS.commandApi, '{}'))
    const text = await res.res.bodyText()
    expect(res.res.statusCode).toBe(502)
    expect(JSON.parse(text || '{}')).toMatchObject({ error: 'relay-upstream-failed', code: 'ETIMEDOUT' })
    expect(text).not.toContain(PASSWORD)
  })

  it('GET on the device path while installed is a 405 (not a fall-through to vite)', async () => {
    const mw = createRelayMiddleware({ envProxyConfigured: false, upstreamRequest: stubbedUpstream().request })
    await run(mw, jsonRequest(RELAY_ENDPOINTS.setup, setupBody))
    const res = await run(mw, fakeRequest(RELAY_ENDPOINTS.commandApi, 'GET', {}))
    expect(res.res.statusCode).toBe(405)
  })
})
