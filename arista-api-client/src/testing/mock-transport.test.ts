/**
 * `MockTransport` + the recorder — M2 (#4), docs/TESTING.md §3, and the seam M12 (#14) replays
 * fixtures through.
 *
 * `src/testing/**` is outside the package's public surface and outside the coverage set, so these
 * specs are not about a number: they are about the contract later milestones build on.
 *  - the mock is a **real** `Transport`: it runs through the same composition in
 *    `src/transports/base.ts` (codec, id policy, correlation, error mapping), so a test written against
 *    it cannot drift from the device path;
 *  - it refuses to invent answers (pyeapi's `MockConnection` silently returns `{}`, which is why
 *    upstream's parse tests prove little) — an unmatched command list is a loud `NotSupportedError`
 *    naming the commands;
 *  - the recorded shape (`sent()` / `bodies()`) is what resource specs from M6 (#8) on will assert on,
 *    so it is pinned here, including that `sent()` post-dates `buildRequest` coercion (DR-041), that the
 *    accessors hand back copies, and that ids are deterministic when `seed`/`nonce`/`idStart` are given
 *    (DR-017);
 *  - matching is **per request**, not per command (`texts.includes(match)`): a batch can be answered by
 *    an entry naming one command inside it. That is the matcher as written, and it is pinned below so an
 *    M6 spec cannot mistake it for per-command scripting.
 *
 * Offline throughout: nothing here opens a socket, and the `mock` kind is refused by both factories so
 * production code cannot reach a scripted device by accident (DR-016's "refuse, never ignore" rule).
 */

import { describe, expect, it } from 'vitest'

import { AuthError, CommandError, ConnectError, NotSupportedError, ProtocolError, TimeoutError, TlsError, TransportError } from '../errors'
import { createTransport as createBrowserTransport } from '../transports/create'
import { createNodeTransport } from '../transports/node-create'
import { createCodecTransport } from '../transports/base'
import type { RawSend } from '../transports/base'
import { createRecorder } from './recording'
import { errorEnvelope, mockTransport, MockTransport } from './mock-transport'

describe('scripted replies, matched by command', () => {
  it('answers one command with one CommandResult, which is the common `show` case', async () => {
    const mock = mockTransport().replies('show version', { output: { aristaVersion: '4.28.13M' } })
    const outcome = await mock.execute('show version')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.result).toEqual([{ output: { aristaVersion: '4.28.13M' } }])
    expect(outcome.encoding).toBe('json')
    expect(outcome.viaTextRetry).toBe(false)
  })

  it('answers a whole batch with one result per command', async () => {
    const mock = mockTransport().replies('show version', [{ output: { a: 1 } }, { output: { b: 2 } }] as never)
    const outcome = await mock.execute(['show version', 'show hostname'])
    expect(outcome.ok && outcome.result).toHaveLength(2)
  })

  it('matches by the joined command list, which is how a multi-line config batch is scripted', async () => {
    const mock = mockTransport().replies('configure\nvlan 42', {})
    const outcome = await mock.execute(['configure', { cmd: 'vlan 42', input: 'name red\nEOF\n' }])
    expect(outcome.ok).toBe(true)
    expect(mock.sent()).toEqual([['configure', { cmd: 'vlan 42', input: 'name red\nEOF\n' }]])
  })

  it('matches with a predicate, for the cases where a command string is not enough', async () => {
    const mock = mockTransport().replies((commands) => commands.length === 2, [{ output: { matched: true } }])
    expect((await mock.execute(['show a', 'show b'])).ok).toBe(true)
    expect(mock.sent()).toHaveLength(1)
  })

  it("'*' catches anything, which is what a default answer looks like", async () => {
    const mock = mockTransport().replies('*', [{ output: {} }])
    expect((await mock.execute('show anything')).ok).toBe(true)
  })

  it('the first matching entry wins, so a specific script can sit in front of a catch-all', async () => {
    const mock = mockTransport().replies('show version', [{ output: { specific: true } }]).replies('*', [{ output: { specific: false } }])
    const first = await mock.execute('show version')
    const second = await mock.execute('show hostname')
    expect(first.ok && first.result).toEqual([{ output: { specific: true } }])
    expect(second.ok && second.result).toEqual([{ output: { specific: false } }])
  })

  it('repliesOnce is consumed by the first match and later requests fall through', async () => {
    const mock = mockTransport().repliesOnce('show version', [{ output: { once: true } }]).replies('show version', [{ output: { once: false } }])
    const first = await mock.execute('show version')
    const second = await mock.execute('show version')
    expect(first.ok && first.result).toEqual([{ output: { once: true } }])
    expect(second.ok && second.result).toEqual([{ output: { once: false } }])
  })

  it('a raw string reply is the response text verbatim, for malformed or truncated bodies', async () => {
    const mock = mockTransport().replies('show version', '{"jsonrpc": "2.0", "result": [' as never)
    const outcome = await mock.execute('show version')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error.name).toBe('ProtocolError')
    expect((outcome.error as InstanceType<typeof ProtocolError>).code).toBe(-32700)
  })

  it('a script that omits the id gets the request id injected, so correlation passes by default (DR-017)', async () => {
    const mock = mockTransport({ seed: 'script', nonce: 'n', idStart: 40 }).replies('show version', { output: {} })
    const outcome = await mock.execute('show version')
    expect(outcome.request.id).toBe('n-script-41')
    expect(outcome.ok).toBe(true)
  })

  it('a script that pins a different id is refused: a mock answering someone else is the same bug as a proxy doing it', async () => {
    const mock = mockTransport().replies('show version', { result: [{ output: {} }], id: 'not-the-request' })
    const failure = await mock.execute('show version').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ProtocolError)
    expect((failure as InstanceType<typeof ProtocolError>).message).toMatch(/does not match the request id/u)
    // The mismatch is reported with the id it should have answered, which is what makes it grep-able.
    expect((failure as InstanceType<typeof ProtocolError>).requestId).toBe(mock.bodies()[0]?.id)
  })
})

describe('an unmatched command fails loudly — pyeapi MockConnection returning {} is why upstream parse tests are weak', () => {
  it('NotSupportedError names the exact command list it was asked about', async () => {
    const mock = mockTransport().replies('show version', {})
    const failure = await mock.execute('show ip interface brief').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(NotSupportedError)
    expect((failure as InstanceType<typeof NotSupportedError>).message).toMatch(/no scripted answer/u)
    expect((failure as InstanceType<typeof NotSupportedError>).message).toContain('show ip interface brief')
    // No implicit empty result, ever: the request is still recorded, so the failure is debuggable.
    expect(mock.sent()).toEqual([['show ip interface brief']])
  })

  it('a script entry naming one command answers a batch that contains it — matching is per request, not per command', async () => {
    // Pinned deliberately: the matcher is `texts.includes(match) || texts.join('\n') === match`, so a
    // resource spec that scripts one command of a two-command batch will be answered for both. A test
    // that wants a distinct answer per command has to match the joined list, and the result array is
    // whatever the script supplied.
    const mock = mockTransport().replies('show hostname', [{ output: { hostname: 'sw1' } }, { output: { version: '4.28' } }])
    const outcome = await mock.execute(['show hostname', 'show version'])
    expect(outcome.ok).toBe(true)
    expect(outcome.ok && outcome.result).toHaveLength(2)
    const missing = mockTransport().replies('show hostname', { output: {} })
    await expect(missing.execute(['show interfaces', 'show ip interface brief'])).rejects.toBeInstanceOf(NotSupportedError)
  })
})

describe('the recorded shape M6 (#8) resource specs assert on', () => {
  it('sent() is the post-buildRequest command list, in send order (DR-041 coercion included)', async () => {
    const mock = mockTransport({ seed: 'r' }).replies('*', [{ output: {} }])
    await mock.execute('show version')
    await mock.execute([{ cmd: 'show interfaces', revision: 3 }])
    expect(mock.sent()).toEqual([['show version'], [{ cmd: 'show interfaces', revision: 3 }]])
  })

  it('bodies() exposes the full JSON-RPC request for parameter assertions (DR-016)', async () => {
    const mock = mockTransport({ seed: 'r' }).replies('*', [{ output: {} }])
    await mock.execute('show version', { format: 'text', stopOnError: false, requestTimeout: 15 })
    const [request] = mock.bodies()
    expect(request?.jsonrpc).toBe('2.0')
    expect(request?.params).toMatchObject({ format: 'text', stopOnError: false, requestTimeout: 15 })
    expect(mock.callCount()).toBe(1)
  })

  it('sent()/bodies() are copies, so a resource spec cannot mutate the transcript (M12 #14 replays it)', async () => {
    const mock = mockTransport().replies('*', [{ output: {} }])
    await mock.execute('show version')
    const firstList = mock.sent()[0] as unknown[]
    firstList.push('injected')
    expect(mock.sent()[0]).toEqual(['show version'])
    const body = mock.bodies()[0]
    expect(body).toBeDefined()
    // `bodies()` deep-copies the `cmds` array, so writing through it cannot rewrite the transcript.
    const mutableCmds = body?.params.cmds as unknown[]
    mutableCmds.push('injected')
    expect(mock.bodies()[0]?.params.cmds).toEqual(['show version'])
  })

  it('toString() and address name the scripted device, because errors quote them', () => {
    const mock = new MockTransport({ address: 'mock://sw1' })
    expect(mock.toString()).toBe('MockTransport(mock://sw1)')
    expect(mock.address).toBe('mock://sw1')
    expect(mock.kind).toBe('mock')
  })
})

describe('scripted failures map to the same taxonomy as a real device', () => {
  it('rejects() produces a device error envelope, returned rather than thrown (M1 rule)', async () => {
    const mock = mockTransport({ seed: 'f', nonce: 'x' }).rejects('bad', { code: 1002, message: 'CLI ERROR', data: [{ errors: ['bad'] }] })
    const outcome = await mock.execute('bad')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toBeInstanceOf(CommandError)
    expect((outcome.error as InstanceType<typeof CommandError>).code).toBe(1002)
    expect((outcome.error as InstanceType<typeof CommandError>).message).toContain('CLI ERROR')
    // The batch is still attached, so a resource spec can show what was sent (DR-005).
    expect((outcome.error as InstanceType<typeof CommandError>).commands).toEqual(['bad'])
  })

  it('httpStatus() reuses the production status mapper, so a mock 401 is the real AuthError', async () => {
    const mock = mockTransport().httpStatus(401, '<html>401</html>')
    const failure = await mock.execute('show version').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AuthError)
    expect((failure as InstanceType<typeof AuthError>).status).toBe(401)
    expect((failure as InstanceType<typeof AuthError>).endpoint).toBe('mock://device')
  })

  it('tlsFailure(), connectFailure() and timeoutAfter() carry the wire classes the UI branches on', async () => {
    for (const [maker, Klass] of [
      [(m: MockTransport) => m.tlsFailure(), TlsError],
      [(m: MockTransport) => m.connectFailure(), ConnectError],
      [(m: MockTransport) => m.timeoutAfter(1), TimeoutError],
      [(m: MockTransport) => m.wireFailure(() => new TransportError('scripted', { endpoint: 'mock://device' })), TransportError],
    ] as const) {
      const mock = maker(mockTransport())
      const failure = await mock.execute('show version').catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(Klass)
    }
  })

  it('connectFailure is retryable, which is what readOnly: true keys on (DR-019)', async () => {
    const mock = mockTransport().connectFailure()
    const failure = await mock.execute('show version', { readOnly: true }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ConnectError)
    expect((failure as InstanceType<typeof ConnectError>).retryable).toBe(true)
    // The composition, not the mock, decides: one resend, no more (base.ts withReadOnlyRetry).
    expect(mock.callCount()).toBe(2)
  })

  it('throws() hands back the exact Error the caller scripted', async () => {
    const scripted = new CommandError(1000, 'scripted CommandError', { commands: ['show version'] })
    const mock = mockTransport().throws('show version', scripted)
    await expect(mock.execute('show version')).rejects.toBe(scripted)
  })

  it('errorEnvelope() builds the text a fixture would contain, echoing a chosen id', () => {
    const text = errorEnvelope({ code: 1003, message: 'Command does not have an output model' }, 'cmd-7')
    expect(JSON.parse(text)).toEqual({
      jsonrpc: '2.0',
      error: { code: 1003, message: 'Command does not have an output model' },
      id: 'cmd-7',
    })
  })
})

describe('the mock still behaves like a transport', () => {
  it('close() ends it: further calls are refused rather than silently answering', async () => {
    const mock = mockTransport().replies('*', [{ output: {} }])
    await mock.close()
    await expect(mock.execute('show version')).rejects.toBeInstanceOf(TransportError)
    expect(mock.callCount()).toBe(0)
  })

  it('it walks the DR-012 1003 -> format:text path like any other transport, so text answers are testable', async () => {
    const unconverted = { error: { code: 1003, message: 'Command does not have an output model', data: [] } }
    // `repliesOnce` for the 1003 leg, because a non-consuming `'*'` entry would answer the text retry
    // with the same 1003 forever — the script has to be able to express "first answer, then answer".
    const mock = mockTransport({ seed: 'd12' }).repliesOnce('*', unconverted).replies('*', { result: [{ output: 'Text output' }] })
    const outcome = await mock.execute('show tech-support')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.encoding).toBe('text')
    expect(outcome.viaTextRetry).toBe(true)
    // Two byte-level round trips, and the second carries a fresh id from the same policy (DR-017).
    expect(mock.callCount()).toBe(2)
    expect(mock.bodies()[0]?.id).not.toBe(mock.bodies()[1]?.id)
    expect(mock.bodies()[1]?.params.format).toBe('text')
  })

  it('tolerateErrors: false turns the same 1003 into a returned failure with no second call', async () => {
    const unconverted = { error: { code: 1003, message: 'Command does not have an output model', data: [] } }
    const mock = mockTransport().replies('*', unconverted as never)
    const outcome = await mock.execute('show tech-support', { tolerateErrors: false })
    expect(outcome.ok).toBe(false)
    expect(mock.callCount()).toBe(1)
  })
})

describe('kind: mock is refused by BOTH factories (docs/TESTING.md §3)', () => {
  for (const [entry, factory] of [['browser', createBrowserTransport], ['node', createNodeTransport]] as const) {
    it(`the ${entry} entry refuses to build a scripted device`, () => {
      const build = (): unknown => factory({ kind: 'mock' } as never)
      expect(build).toThrow(NotSupportedError)
      expect(build).toThrow(/is not built by createTransport/u)
      // The refusal states where the mock does come from, so the fix is discoverable.
      expect(build).toThrow(/testing helpers/u)
      expect(build).toThrow(/src\/testing\/mock-transport\.ts/u)
    })
  }

  it('an eapi.conf-style profile name resolves to mock, and still cannot be built (M3 #5 pre-check)', async () => {
    const { normalizeTransportKind } = await import('../transports/contract')
    expect(normalizeTransportKind('mock')).toBe('mock')
    expect(() => createBrowserTransport({ kind: normalizeTransportKind('mock') } as never)).toThrow(NotSupportedError)
    expect(() => createNodeTransport({ kind: normalizeTransportKind('mock') } as never)).toThrow(NotSupportedError)
  })
})

describe('the recorder turns a traced round trip into a fixture candidate (M12 #14)', () => {
  /**
   * The recorder is tested at its own seam: a `createCodecTransport` whose sender returns scripted text
   * (or throws), wired to `recorder.sink`. That is the exact wiring M12 (#14) uses to write a fixture,
   * and it also proves `base.ts` is the place that redacts before the sink sees anything (DR-011).
   */
  function tracedDevice(answerText: string | undefined, failure: Error | undefined, requestId: string): { recorder: ReturnType<typeof createRecorder>; transport: ReturnType<typeof createCodecTransport> } {
    const recorder = createRecorder()
    const send: RawSend = async () => {
      if (failure !== undefined) throw failure
      return answerText as string
    }
    const transport = createCodecTransport({
      kind: 'mock',
      address: 'https://sw1.lan:443/command-api',
      send,
      ids: { clientId: 'rec', next: () => requestId },
      trace: recorder.sink,
    })
    return { recorder, transport }
  }

  function dumpOf(recorder: ReturnType<typeof createRecorder>): DumpedRecord {
    return JSON.parse(recorder.dump()) as DumpedRecord
  }

  it('pairs request and response by id into one exchange, both already redacted (DR-011)', async () => {
    const { recorder, transport } = tracedDevice(`{"jsonrpc":"2.0","result":[{}],"id":"rec-1"}`, undefined, 'rec-1')
    await transport.execute([{ cmd: 'enable', input: 'enable-password\nEOF\n' }])
    const dump = dumpOf(recorder)
    expect(dump.recorded).toBe(1)
    expect(dump.incomplete).toEqual([])
    const [entry] = dump.exchanges
    expect(entry?.requestId).toBe('rec-1')
    expect(entry?.endpoint).toBe('https://sw1.lan:443/command-api')
    // The device must receive the enable input untouched; the *fixture* may never contain it.
    expect(entry?.request).toContain('<redacted>')
    expect(entry?.request).not.toContain('enable-password')
    expect(entry?.response).toContain('"result"')
  })

  it('a failed round trip is recorded as a failure line, not dropped', async () => {
    const { recorder, transport } = tracedDevice(undefined, new AuthError('device said no', { endpoint: 'https://sw1.lan:443/command-api' }), 'rec-2')
    await transport.execute('show version').catch(() => undefined)
    const dump = dumpOf(recorder)
    expect(dump.exchanges[0]?.failure).toMatch(/AuthError: device said no/u)
    expect(dump.exchanges[0]?.request).toContain('show version')
    expect(dump.exchanges[0]?.response).toBeUndefined()
  })

  it('clear() drops everything, so cases in one file do not bleed into the next fixture', async () => {
    const recorder = createRecorder()
    recorder.sink({ direction: 'request', endpoint: 'e', requestId: '1', body: 'a' })
    recorder.sink({ direction: 'response', endpoint: 'e', requestId: '1', body: 'b' })
    expect(recorder.exchanges()).toHaveLength(1)
    recorder.clear()
    expect(recorder.exchanges()).toEqual([])
    expect(dumpOf(recorder).recorded).toBe(0)
  })

  it('a request with no reply is listed as incomplete rather than written as a half fixture', () => {
    const recorder = createRecorder()
    recorder.sink({ direction: 'request', endpoint: 'https://sw1/command-api', requestId: 'open-1', body: 'req' })
    const dump = dumpOf(recorder)
    expect(dump.recorded).toBe(0)
    expect(dump.incomplete).toEqual(['open-1'])
    expect(dump.exchanges).toEqual([])
    // Half an exchange cannot be replayed, so it is flagged instead of silently emitted.
    expect(recorder.exchanges()).toEqual([])
  })

  it('a response that arrives with no request still produces an exchange, with an empty request text', () => {
    const recorder = createRecorder()
    recorder.sink({ direction: 'response', endpoint: 'e', requestId: '9', body: 'resp' })
    expect(recorder.exchanges()).toEqual([{ requestId: '9', endpoint: 'e', request: '', response: 'resp' }])
  })

  it('exchanges() hands back copies, so a test cannot edit a recorded fixture in place', () => {
    const recorder = createRecorder()
    recorder.sink({ direction: 'request', endpoint: 'e', requestId: '1', body: 'req' })
    recorder.sink({ direction: 'response', endpoint: 'e', requestId: '1', body: 'resp' })
    const got = recorder.exchanges() as unknown as { request: string }[]
    got[0]!.request = 'tampered'
    expect(recorder.exchanges()[0]?.request).toBe('req')
  })
})

/** The recording.ts dump shape, asserted in one place so a layout change is a compile error here. */
interface DumpedRecord {
  readonly recorded: number
  readonly incomplete: readonly string[]
  readonly exchanges: readonly { requestId: string; endpoint: string; request: string; response?: string | undefined; failure?: string | undefined }[]
}
