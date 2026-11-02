/**
 * The request/response id correlation contract — M2 (#4), DR-017.
 *
 * M1 (#3) shipped request ids but never compared them; PR #19 recorded that as the gap M2 had to
 * decide. The decision is: **the transport refuses a reply that answers a different request**, in
 * `src/transports/correlate.ts`, and it fails as a `ProtocolError` rather than being returned as a
 * wrong answer, because the three ways this happens are all silent-wrong-answer bugs:
 *  - a proxy that replayed a cached answer (the DR-036 dev proxy makes that reachable by accident);
 *  - two switches behind one address (a load balancer, or a stale DHCP reservation);
 *  - a scripted test double wired to the wrong body.
 *
 * On a switch, "the answer you rendered belongs to another device" means configuring one switch
 * while looking at another, so it is worth a hard failure. pyeapi has nothing to compare: its `reqid`
 * is `id(self)`, a CPython memory address (`eapilib.py:354`), and the reply's `id` is discarded.
 * Recorded as MIGRATION.md §5 row 29.
 *
 * Offline: the loopback listener is `127.0.0.1` on an ephemeral port, closed in `afterEach`.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { buildRequest, createRequestIds, MAX_RAW_BODY } from '../internal/wire'
import { REDACTED } from '../internal/redact'
import { ProtocolError } from '../errors'
import { assertResponseIdMatches } from './correlate'
import { createTransport } from './create'
import { healthyDevice, listenHttp, type LoopbackDevice, type LoopbackResponder } from '../testing/loopback-device'
import type { JsonRpcRequest } from '../types/eapi'

/** A deterministic request, so the id under test can be written literally. */
function request(id = 'paired-1'): JsonRpcRequest {
  return buildRequest('show version', { ids: createRequestIds({ seed: 'paired', start: 0 }), id })
}

function successBody(id?: string | number): string {
  return JSON.stringify({ jsonrpc: '2.0', result: [{}], ...(id === undefined ? {} : { id }) })
}

/** Run `fn`, expecting a `ProtocolError`, and hand it to the assertions. */
function protocolFailureFrom(fn: () => void): InstanceType<typeof ProtocolError> {
  try {
    fn()
  } catch (error) {
    if (error instanceof ProtocolError) return error
    throw new Error(`expected a ProtocolError, got ${String(error)}`)
  }
  throw new Error('expected a ProtocolError, but nothing was thrown')
}

describe('the correlation check itself', () => {
  it('passes when the reply echoes the id it is answering', () => {
    expect(() => assertResponseIdMatches(request('paired-1'), successBody('paired-1'))).not.toThrow()
  })

  it('refuses a reply whose id belongs to another request', () => {
    expect(() => assertResponseIdMatches(request('paired-1'), successBody('paired-99'))).toThrow(ProtocolError)
  })

  it('names both ids and the DR-017 reason, and says what could be replying', () => {
    const failure = protocolFailureFrom(() => assertResponseIdMatches(request('paired-1'), successBody('other-client-4')))
    expect(failure.name).toBe('ProtocolError')
    expect(failure.message).toMatch(/response id "other-client-4"/u)
    expect(failure.message).toMatch(/request id "paired-1"/u)
    expect(failure.message).toMatch(/DR-017/u)
    // The diagnosis is the point of the message: an operator has to be told what to go and look for,
    // not merely that two strings differ.
    expect(failure.message).toMatch(/proxy cache/u)
    expect(failure.message).toMatch(/second switch/u)
  })

  it('types the failure as -32600 and carries the request id plus the offending commands', () => {
    const failure = protocolFailureFrom(() => assertResponseIdMatches(request('paired-1'), successBody('paired-2')))
    expect(failure.code).toBe(-32600)
    expect(failure.requestId).toBe('paired-1')
    expect(failure.commands).toEqual(['show version'])
  })

  it('tolerates a response with no id at all', () => {
    // Deliberate, and the reason is scope rather than sloppiness: this check exists to refuse a body
    // that answers *someone else's* request, so it can only act on an id it can see. `undefined` means
    // "cannot tell", and "cannot tell" must never be reported as "wrong". The envelope types already
    // model `id` as optional (`JsonRpcSuccess`/`JsonRpcFailure` in src/types/eapi.ts) and
    // `parseResponse` accepts an id-less body — `ResponseContext.requestId` then fills the id onto any
    // error the codec builds, so the operator still gets one to grep for (DR-017). Refusing an absent
    // id would tighten the codec's contract from the transport seam, which is the wrong layer.
    // Whether EOS itself can omit the echoed id is a device-sweep question (docs/STATUS.md §3), not
    // something this offline suite can settle.
    expect(() => assertResponseIdMatches(request('paired-1'), successBody(undefined))).not.toThrow()
  })

  it('tolerates a numeric echo of a string id, because that is re-serialisation, not impersonation', () => {
    // The comparison is stringified on purpose: EOS echoes the exact token it was handed, so a JSON
    // number means something between us and the switch re-parsed the body. Odd, but not the
    // "another device answered" condition this check exists to catch.
    expect(() => assertResponseIdMatches(request('7'), successBody(7))).not.toThrow()
    // A different value is still a different value, quoted or not.
    expect(() => assertResponseIdMatches(request('7'), successBody('07'))).toThrow(ProtocolError)
  })

  it('stays out of the way of a body that is not JSON — the codec owns that failure', () => {
    // `parseResponse` reports a non-JSON 200 body as `-32700` with the raw text attached (asserted in
    // fetch.test.ts). Throwing here would replace that diagnosis with a bogus pairing failure.
    expect(() => assertResponseIdMatches(request('paired-1'), '<html>proxy error</html>')).not.toThrow()
    expect(() => assertResponseIdMatches(request('paired-1'), '[1,2,3]')).not.toThrow()
    expect(() => assertResponseIdMatches(request('paired-1'), '')).not.toThrow()
  })

  it('redacts the body it keeps and the commands it attaches (DR-011)', () => {
    const secretRequest = buildRequest([{ cmd: 'enable', input: 'hunter2' }, 'username admin secret plain s3cret'], {
      ids: createRequestIds({ seed: 'paired', start: 0 }),
      id: 'paired-1',
    })
    // A body shaped like the one that actually leaks an enable secret: a `{cmd: "enable", input: …}`
    // object echoed back by an intermediary. `truncate()` runs it through `redactWireText`, which
    // redacts `input` exactly where `cmd` says `enable` (src/internal/redact.ts) — no more, no less.
    const body = JSON.stringify({ jsonrpc: '2.0', result: [{ cmd: 'enable', input: 'hunter2' }], id: 'paired-2' })
    const failure = protocolFailureFrom(() => assertResponseIdMatches(secretRequest, body))
    expect(failure.rawBody).not.toContain('hunter2')
    expect(failure.rawBody).toContain(REDACTED)
    expect(JSON.stringify(failure.commands)).not.toContain('s3cret')
    const firstCommand = failure.commands?.[0] as { input?: string } | undefined
    expect(firstCommand?.input).toBe(REDACTED)
  })

  it('bounds the body it keeps at the codec limit, so the error stays loggable', () => {
    const huge = JSON.stringify({ jsonrpc: '2.0', result: [{ output: 'x'.repeat(MAX_RAW_BODY * 3) }], id: 'paired-2' })
    const failure = protocolFailureFrom(() => assertResponseIdMatches(request('paired-1'), huge))
    expect(failure.rawBody ?? '').toContain('truncated')
    expect((failure.rawBody ?? '').length).toBeLessThanOrEqual(MAX_RAW_BODY + 64)
  })
})

describe('correlation where it bites: a live round trip', () => {
  let device: LoopbackDevice | undefined

  afterEach(async () => {
    await device?.close()
    device = undefined
  })

  function started(): LoopbackDevice {
    if (device === undefined) throw new Error('the loopback listener was not started by this case')
    return device
  }

  it('accepts the answer a listener echoes back, which is what healthyDevice() does', async () => {
    device = await listenHttp(healthyDevice())
    const transport = createTransport({ kind: 'http', baseUrl: started().origin, allowInsecureTransport: true, seed: 'paired' })
    const outcome = await transport.execute('show version')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.request.id).toBe('paired-1')
  })

  it('refuses a reply that replays an earlier answer — the proxy-replay case', async () => {
    let firstId: string | undefined
    device = await listenHttp((entry) => {
      const { id } = JSON.parse(entry.body) as { id: string }
      firstId ??= id
      // From the second call on, the listener answers with the *first* request id again.
      return { status: 200, headers: { 'content-type': 'application/json' }, body: successBody(firstId) }
    })
    const transport = createTransport({ kind: 'http', baseUrl: started().origin, allowInsecureTransport: true, seed: 'paired', idStart: 5 })
    const first = await transport.execute('show version')
    expect(first.ok).toBe(true)
    const failure = await transport.execute('show version').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ProtocolError)
    const typed = failure as InstanceType<typeof ProtocolError>
    expect(typed.message).toMatch(/request id "paired-7"/u)
    expect(typed.message).toMatch(/response id "paired-6"/u)
    expect(started().callCount()).toBe(2)
  })

  it('does not let a correlation failure be dressed up as a device error envelope', async () => {
    // `sendRequest` deliberately *returns* a device `error` envelope (`ok: false`) rather than throwing.
    // A mismatched id is not that: the body is not this request's answer, so the round trip rejects —
    // a caller must never be handed `ok: false` carrying another batch's error.
    device = await listenHttp(() => ({ status: 200, headers: { 'content-type': 'application/json' }, body: successBody('someone-else-1') }))
    const transport = createTransport({ kind: 'http', baseUrl: started().origin, allowInsecureTransport: true, seed: 'paired' })
    await expect(transport.execute('show version')).rejects.toBeInstanceOf(ProtocolError)
    expect(started().callCount()).toBe(1)
  })
})

describe("the DR-012 1003 → 'text' retry correlates against the right request", () => {
  let device: LoopbackDevice | undefined

  afterEach(async () => {
    await device?.close()
    device = undefined
  })

  function started(): LoopbackDevice {
    if (device === undefined) throw new Error('the loopback listener was not started by this case')
    return device
  }

  /**
   * 1003 on the json attempt, a normal answer on the text attempt. `echoRealId` decides whether the
   * text answer carries the id of the request that asked for it (DR-012 re-issues with a **fresh**
   * id from the same policy, so the two bodies must not be interchangeable).
   */
  function unconvertedThenText(echoRealId: boolean): LoopbackResponder {
    let firstId: string | undefined
    return (entry) => {
      const { id, params } = JSON.parse(entry.body) as { id: string; params: { format: string } }
      firstId ??= id
      if (params.format === 'json') {
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', error: { code: 1003, message: 'Command not converted to CLI', data: [] }, id }),
        }
      }
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', result: [{ output: 'text answer' }], id: echoRealId ? id : firstId }),
      }
    }
  }

  it('gives the retry a fresh id from the same policy and pairs it with its own answer', async () => {
    device = await listenHttp(unconvertedThenText(true))
    const transport = createTransport({ kind: 'http', baseUrl: started().origin, allowInsecureTransport: true, seed: 'paired' })
    const outcome = await transport.execute('show session-config diffs')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.viaTextRetry).toBe(true)
    expect(outcome.encoding).toBe('text')
    // Two byte-level round trips, two ids, each answer checked against the request it answers.
    expect(started().callCount()).toBe(2)
    expect(started().requests().map((entry) => (JSON.parse(entry.body) as { id: string }).id)).toEqual(['paired-1', 'paired-2'])
  })

  it('refuses a text answer that still carries the json attempt id', async () => {
    device = await listenHttp(unconvertedThenText(false))
    const transport = createTransport({ kind: 'http', baseUrl: started().origin, allowInsecureTransport: true, seed: 'paired' })
    const failure = await transport.execute('show session-config diffs').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ProtocolError)
    const typed = failure as InstanceType<typeof ProtocolError>
    expect(typed.message).toMatch(/request id "paired-2"/u)
    expect(typed.message).toMatch(/response id "paired-1"/u)
    expect(started().callCount()).toBe(2)
  })
})
