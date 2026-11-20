// @ts-check
/**
 * Reversible physical-switch CORS evidence for #159.
 *
 * This file never runs in ordinary tests. The operator runner additionally requires an exact-origin
 * consent echo. It temporarily commits one `cors allowed-origin <origin>` entry, checks a real HTTP
 * OPTIONS preflight and JSON-RPC POST, then removes that exact origin in a `finally` path and verifies
 * the model no longer lists it. Any cleanup failure makes the run fail loudly.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createNode } from './node'
import type { Node } from './command-layer'
import { resolveTlsConnect } from './transports/node-tls'
import { describeLiveTarget, liveTransportOptions, matchesDeviceIdentity, resolveLiveEnv, unwrapLiveTarget } from './testing/live-guard'

interface HttpReply {
  readonly status: number
  readonly headers: Record<string, string | readonly string[] | undefined>
  readonly body: string
}

const resolution = resolveLiveEnv(process.env)
const captureOn = process.env['EAPI_HW_CORS_CAPTURE'] === '1'
const origin = String(process.env['EAPI_HW_CORS_ORIGIN'] ?? '')
const consent = String(process.env['EAPI_HW_CORS_CONSENT'] ?? '')
const hardware = resolution.ok && resolution.targetClass === 'hardware'
const runnable = hardware && captureOn && consent === origin && validOrigin(origin)

function validOrigin(value: string): boolean {
  try {
    const parsed = new URL(value)
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.origin === value && parsed.username === '' && parsed.password === '' && value !== '*'
  } catch {
    return false
  }
}

if (!resolution.ok) console.warn(`cors-hardware: SKIPPED (DR-034) — ${resolution.reason}`)
else if (!hardware) console.warn('cors-hardware: SKIPPED — physical hardware target required; never run this on cEOS')
else if (!captureOn) console.warn('cors-hardware: SKIPPED — EAPI_HW_CORS_CAPTURE=1 required')
else if (!validOrigin(origin)) console.warn('cors-hardware: SKIPPED — EAPI_HW_CORS_ORIGIN must be one exact http(s) origin with no path')
else if (consent !== origin) console.warn('cors-hardware: SKIPPED — EAPI_HW_CORS_CONSENT must exactly echo the origin')

let node: Node | undefined
let added = false
let removed = false
const observations: Array<Record<string, unknown>> = []

function material(value: string | readonly string[] | undefined): string | readonly string[] | undefined {
  return value
}

function httpsRequest(target: ReturnType<typeof unwrapLiveTarget>, options: { method: string; headers: Record<string, string>; body?: string }): Promise<HttpReply> {
  const transport = liveTransportOptions(target)
  if (transport.kind !== 'https') throw new Error('CORS capture requires HTTPS')
  const tls = resolveTlsConnect(
    {
      ca: material(transport.ca),
      fingerprint: transport.fingerprint,
      serverName: transport.serverName,
    },
    { scheme: 'https', host: target.host, port: target.port },
    'system',
  )
  return new Promise((resolve, reject) => {
    const body = options.body ?? ''
    const req = https.request({
      host: target.host,
      port: target.port,
      path: target.path,
      method: options.method,
      ...tls.connect,
      headers: { ...options.headers, ...(body === '' ? {} : { 'Content-Length': String(Buffer.byteLength(body)) }) },
    }, (res) => {
      let response = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { response += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: response }))
    })
    req.on('error', reject)
    if (body !== '') req.write(body)
    req.end()
  })
}

function header(headers: HttpReply['headers'], name: string): string {
  const value = headers[name.toLowerCase()]
  return Array.isArray(value) ? value.join(', ') : String(value ?? '')
}

async function corsOrigins(current: Node): Promise<readonly string[]> {
  const [reply] = await current.exec(['show management api http-commands'], { format: 'json' })
  const result = (reply as { result?: { corsOrigins?: readonly string[] } }).result ?? {}
  return result.corsOrigins ?? []
}

async function configureOrigin(current: Node, line: string, sessionName: string): Promise<void> {
  const session = await current.configSession({ name: sessionName, description: '#159 browser-direct CORS evidence' })
  try {
    await session.run(['management api http-commands', line])
    await session.diff()
    await session.commit()
  } finally {
    if (session.isOpen) await session.abort().catch(() => undefined)
  }
}

beforeAll(async () => {
  if (!runnable || !resolution.ok) return
  const target = unwrapLiveTarget(resolution)
  node = createNode(liveTransportOptions(target))
  console.log(`cors-hardware: target=${describeLiveTarget(target)} origin=${origin}`)
  const identity = await node.getVersion()
  const mismatch = matchesDeviceIdentity(target, { version: identity.version, modelName: identity.modelName })
  expect(mismatch, `hardware identity gate: ${JSON.stringify(identity)}`).toBeUndefined()
})

afterAll(async () => {
  if (added && !removed && node !== undefined) {
    try {
      await configureOrigin(node, `no cors allowed-origin ${origin}`, 'hw-cors-cleanup')
      removed = !(await corsOrigins(node)).includes(origin)
    } catch (error) {
      console.error(`cors-hardware: CLEANUP FAILED for ${origin}: ${(error as Error).message}`)
    }
  }
  await node?.close().catch(() => undefined)
  expect(added && !removed, 'the exact-origin CORS entry must be removed after the capture').toBe(false)
  if (!runnable) return
  const out = path.resolve(process.cwd(), 'docs', 'evidence', 'cors-hardware.json')
  mkdirSync(path.dirname(out), { recursive: true })
  writeFileSync(out, `${JSON.stringify({ generatedAt: new Date().toISOString(), origin, observations, cleanupRemovedOrigin: removed }, null, 2)}\n`, 'utf8')
  console.log(`cors-hardware: wrote ${out}`)
})

describe.skipIf(!runnable || !resolution.ok)('hardware browser-direct CORS evidence (#159)', () => {
  it('temporarily allows one exact origin, answers browser preflight + JSON-RPC, and removes it', { timeout: 120_000 }, async () => {
    const target = unwrapLiveTarget(resolution)
    expect(node).toBeDefined()
    const before = await corsOrigins(node as Node)
    expect(before, 'the probe must not overwrite an existing identical origin rule').not.toContain(origin)

    await configureOrigin(node as Node, `cors allowed-origin ${origin}`, 'hw-cors-apply')
    added = true
    expect(await corsOrigins(node as Node), 'the origin must be present after the commit').toContain(origin)

    const preflight = await httpsRequest(target, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    })
    observations.push({ step: 'preflight', status: preflight.status, allowOrigin: header(preflight.headers, 'access-control-allow-origin'), allowMethods: header(preflight.headers, 'access-control-allow-methods'), allowHeaders: header(preflight.headers, 'access-control-allow-headers') })
    expect(preflight.status).toBe(204)
    expect(header(preflight.headers, 'access-control-allow-origin')).toBe(origin)
    expect(header(preflight.headers, 'access-control-allow-methods').toLowerCase()).toContain('post')
    expect(header(preflight.headers, 'access-control-allow-headers').toLowerCase()).toContain('authorization')
    expect(header(preflight.headers, 'access-control-allow-headers').toLowerCase()).toContain('content-type')

    const body = JSON.stringify({ jsonrpc: '2.0', method: 'runCmds', params: { version: 1, format: 'json', cmds: ['show version'] }, id: 'cors-hardware' })
    const post = await httpsRequest(target, {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json-rpc',
        Authorization: `Basic ${Buffer.from(`${target.username}:${target.password}`).toString('base64')}`,
      },
      body,
    })
    observations.push({ step: 'json-rpc', status: post.status, allowOrigin: header(post.headers, 'access-control-allow-origin'), bodyHasResult: post.body.includes('result') })
    expect(post.status).toBe(200)
    expect(header(post.headers, 'access-control-allow-origin')).toBe(origin)
    expect(post.body).toContain('result')

    await configureOrigin(node as Node, `no cors allowed-origin ${origin}`, 'hw-cors-remove')
    removed = !(await corsOrigins(node as Node)).includes(origin)
    expect(removed, 'cleanup must remove the exact-origin entry').toBe(true)
  })
})
