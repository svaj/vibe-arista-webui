/**
 * The M11 (#13) method seam of the **transport composition**: `createCodecTransport(...).callMethod` and
 * the {@link TransportBase} delegation that gives all seven device transports the same behaviour from one
 * implementation. Offline — the byte-level `RawSend` here is a closure that returns text.
 *
 * Why this file exists next to `src/internal/wire.methods.test.ts`: the codec tests pin the envelope and
 * the parse. The claims only the composition can prove are (i) a method request goes out over the **same**
 * sender, deadline, trace sink and id policy as `runCmds` (DR-011/DR-017/DR-019); (ii) id pairing applies to
 * a reply that carries no `cmds` — the M11 widening of `PairableRequest` in `correlate.ts`; and (iii)
 * `readOnly` is **off** for a method call unless the caller asks, because "verifyConfig writes nothing" is
 * kept by a server-side config session (`JsonCli.py:293-305`), not by anything in our request.
 *
 * Every scripted body here echoes the request id, because the composition *does* compare them: several of
 * the cases below exist precisely to prove that a method reply is not exempt.
 */

import { describe, expect, it } from 'vitest'

import { TransportBase, createCodecTransport, idPolicyFrom, type RawRequest, type TransportKernel } from './base'
import { ConnectError, EapiErrorCode, ProtocolError, TransportError } from '../errors'
import type { Transport, WireTraceSink } from './contract'
import type { CommandResult, JsonRpcId, JsonRpcMethodRequest, WireMethodCall } from '../types/eapi'

const ADDRESS = 'https://sw1.lan:443/command-api'

const HELP_CALL: WireMethodCall = { method: 'getCommandHelp', params: { command: 'show' } }

/** SYNTHETIC device body — `JsonCli.py:199-203` returns a dict and `JsonRpcBase.py:160` writes it verbatim. */
function helpBody(id: JsonRpcId): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result: { show: 'Set show command' } })
}

function asMethod(request: RawRequest | undefined): JsonRpcMethodRequest {
  if (request === undefined || request.method === 'runCmds') throw new Error('expected a non-runCmds request')
  return request
}

interface HarnessOptions {
  readonly trace?: WireTraceSink
  readonly timeoutMs?: number
  readonly onClose?: () => void
  /** Refuse the first N calls at the byte level, so the DR-019 retry rule is observable. */
  readonly fails?: number
  /** Custom answer (a mismatched id, a 502 page, an error envelope). Defaults to an id-echoing help reply. */
  readonly reply?: (request: RawRequest) => string
}

/** A transport over a byte sender that records every envelope it was handed and never touches a socket. */
function harness(options: HarnessOptions = {}): { readonly transport: ReturnType<typeof createCodecTransport>; readonly seen: RawRequest[] } {
  const seen: RawRequest[] = []
  const fails = options.fails ?? 0
  const kernel: TransportKernel = {
    kind: 'https',
    address: ADDRESS,
    ids: idPolicyFrom({ seed: 'comp', idStart: 100 }),
    send: async (request: RawRequest) => {
      seen.push(request)
      if (seen.length <= fails) throw new ConnectError('mock scripted connection refusal', { endpoint: ADDRESS, retryable: true })
      return options.reply?.(request) ?? helpBody(request.id)
    },
    ...(options.trace === undefined ? {} : { trace: options.trace }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.onClose === undefined ? {} : { onClose: options.onClose }),
  }
  return { transport: createCodecTransport(kernel), seen }
}

describe('createCodecTransport().callMethod — one composition, two envelope kinds', () => {
  it('hands the byte sender the built method envelope and returns the parsed object result', async () => {
    const { transport, seen } = harness()
    const outcome = await transport.callMethod(HELP_CALL)
    expect(outcome.ok).toBe(true)
    expect(seen).toHaveLength(1)
    expect(asMethod(seen[0])).toEqual({ jsonrpc: '2.0', method: 'getCommandHelp', id: 'comp-101', params: { command: 'show' } })
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.result).toEqual({ show: 'Set show command' })
    expect(outcome.request.method).toBe('getCommandHelp')
  })

  it('stamps the connection id policy, incremented across runCmds and method calls alike (DR-017)', async () => {
    const { transport, seen } = harness({
      reply: (request) => (request.method === 'runCmds' ? JSON.stringify({ jsonrpc: '2.0', id: request.id, result: [{ version: '4.28.13.1M' }] }) : helpBody(request.id)),
    })
    await transport.execute(['show version'])
    await transport.callMethod(HELP_CALL)
    await transport.callMethod({ method: 'getCommandCompletions', params: { command: 'sh' } })
    expect(seen.map((request) => request.id)).toEqual(['comp-101', 'comp-102', 'comp-103'])
    expect(seen.map((request) => request.method)).toEqual(['runCmds', 'getCommandHelp', 'getCommandCompletions'])
  })

  it('does not re-send a method call on ConnectError unless the caller says readOnly (DR-019 default off)', async () => {
    const { transport, seen } = harness({ fails: 1 })
    await expect(transport.callMethod(HELP_CALL)).rejects.toBeInstanceOf(ConnectError)
    expect(seen).toHaveLength(1)
  })

  it('re-sends a readOnly method call exactly once, with the same id, when the connection was refused before the device saw it', async () => {
    const { transport, seen } = harness({ fails: 1 })
    const outcome = await transport.callMethod(HELP_CALL, { readOnly: true })
    expect(outcome.ok).toBe(true)
    expect(seen).toHaveLength(2)
    expect(new Set(seen.map((request) => request.id)).size).toBe(1)
  })

  it('keeps a verifyConfig call out of the automatic resend path even though the method promises not to write running-config', async () => {
    const { transport, seen } = harness({ fails: 99 })
    await expect(transport.callMethod({ method: 'verifyConfig', params: { configList: ['vlan 20'] } }, { readOnly: false })).rejects.toBeInstanceOf(ConnectError)
    expect(seen).toHaveLength(1)
    expect(asMethod(seen[0]).params).toEqual({ configList: ['vlan 20'] })
  })

  it('never re-sends for a device-side failure (only ConnectError is a resend candidate)', async () => {
    const { transport, seen } = harness({
      reply: (request) => JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: EapiErrorCode.COMMAND_INVALID, message: '% Invalid input' } }),
    })
    const outcome = await transport.callMethod({ method: 'verifyConfig', params: { configList: ['vlan 20'] } }, { readOnly: true })
    expect(outcome.ok).toBe(false)
    expect(seen).toHaveLength(1)
  })

  it('refuses a callMethod after close(), and calls the kernel onClose exactly once', async () => {
    let closes = 0
    const { transport } = harness({ onClose: () => void (closes += 1) })
    await transport.close()
    await transport.close()
    expect(closes).toBe(1)
    await expect(transport.callMethod(HELP_CALL)).rejects.toBeInstanceOf(TransportError)
    await expect(transport.execute(['show version'])).rejects.toBeInstanceOf(TransportError)
  })

  it('pairs the reply id for a method request too, and reports no command list because there is none (correlate.ts)', async () => {
    const { transport } = harness({ reply: () => JSON.stringify({ jsonrpc: '2.0', id: 'someone-elses-request', result: { show: 'Set show command' } }) })
    // Rejected, not returned: id pairing is a round-trip property, so `correlate.ts` throws at the
    // transport seam for both envelope kinds — the same way it already does for `execute()`. What M11 had
    // to widen is the request type, and the widened `attached()` must not invent a `cmds` list.
    const error = await transport.callMethod(HELP_CALL).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )
    expect(error).toBeInstanceOf(ProtocolError)
    expect((error as ProtocolError).message).toMatch(/does not match the request id/u)
    expect((error as ProtocolError).commands).toEqual([])
    expect((error as ProtocolError).rawBody).toContain('someone-elses-request')
  })

  it('tolerates a method reply that echoes no id at all, exactly as the runCmds gate does', async () => {
    const { transport } = harness({ reply: () => JSON.stringify({ jsonrpc: '2.0', result: { show: 'Set show command' } }) })
    const outcome = await transport.callMethod(HELP_CALL)
    expect(outcome.ok).toBe(true)
  })

  it('runs a method call through the wire trace with the body redacted for the sink only (DR-011)', async () => {
    const events: { direction: string; requestId: string; body: string }[] = []
    const sink: WireTraceSink = (event) => events.push({ direction: event.direction, requestId: event.requestId, body: event.body })
    const { transport } = harness({
      trace: sink,
      reply: (request) => JSON.stringify({ jsonrpc: '2.0', id: request.id, result: [{}, { outputInline: ['username admin secret plain <redacted>'] }] }),
    })
    const outcome = await transport.callMethod({ method: 'verifyConfig', params: { configList: ['username admin secret plain Sup3rSec'] } })
    expect(outcome.ok).toBe(true)
    expect(events.map((event) => event.direction)).toEqual(['request', 'response'])
    expect(events[0]?.requestId).toBe('comp-101')
    expect(events[0]?.body).toContain('verifyConfig')
    // The device must receive the real configlet; only the logged copy is redacted (DR-011 is a logging rule).
    expect(events[0]?.body).not.toContain('Sup3rSec')
    expect(events[1]?.body).toContain('comp-101')
  })

  it('emits a failure trace event for a method call that never got a body back', async () => {
    const directions: string[] = []
    const sink: WireTraceSink = (event) => directions.push(event.direction)
    const { transport } = harness({ trace: sink, fails: 1 })
    await expect(transport.callMethod(HELP_CALL)).rejects.toBeInstanceOf(ConnectError)
    expect(directions).toEqual(['request', 'failure'])
  })

  it('keeps the per-call timeout knob out of params (it is transport policy, not a method parameter)', async () => {
    const { transport, seen } = harness({ timeoutMs: 250 })
    const outcome = await transport.callMethod(HELP_CALL, { timeoutMs: 10 })
    expect(outcome.ok).toBe(true)
    expect(asMethod(seen[0])?.params).toEqual({ command: 'show' })
    expect(JSON.stringify(seen[0])).not.toContain('timeoutMs')
  })

  it('reports an unparseable method body as the typed protocol failure instead of an empty help object', async () => {
    const { transport } = harness({ reply: () => '<html>502 Bad Gateway</html>' })
    const outcome = await transport.callMethod(HELP_CALL)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('expected a failure')
    const error = outcome.error
    expect(error).toBeInstanceOf(ProtocolError)
    // narrowing, not a cast: `rawBody` exists on ProtocolError only, which is itself the assertion.
    if (!(error instanceof ProtocolError)) throw new Error('expected a ProtocolError')
    expect(error.code).toBe(EapiErrorCode.PARSE_ERROR)
    expect(error.rawBody).toContain('502 Bad Gateway')
  })

  it('answers an error envelope as a failure result rather than throwing out of the composition', async () => {
    const { transport } = harness({
      reply: (request) => JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: EapiErrorCode.METHOD_NOT_FOUND, message: "Invalid 'method' specified: 'getCommandHelp'" } }),
    })
    const outcome = await transport.callMethod(HELP_CALL)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('expected a failure')
    expect(outcome.error.code).toBe(EapiErrorCode.METHOD_NOT_FOUND)
  })

  it('applies the object-result gate through the transport: an array reply to a dict method is refused', async () => {
    const { transport } = harness({ reply: (request) => JSON.stringify({ jsonrpc: '2.0', id: request.id, result: [{ show: 'Set show command' }] }) })
    const outcome = await transport.callMethod(HELP_CALL)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('expected a failure')
    expect(outcome.error.message).toMatch(/must be a single JSON object, not an array/u)
  })
})

describe('TransportBase.callMethod — the one delegation behind all seven named transports', () => {
  /** A named transport in exactly the shape the real seven use: a kernel in, the composition out. */
  class FakeHttpsTransport extends TransportBase {}

  function named(result: unknown, description = 'FakeHttpsTransport(mock)'): { readonly transport: FakeHttpsTransport; readonly seen: RawRequest[] } {
    const seen: RawRequest[] = []
    const transport = new FakeHttpsTransport({
      kind: 'https',
      address: ADDRESS,
      description,
      ids: idPolicyFrom({ seed: 'named', idStart: 5 }),
      send: async (request) => {
        seen.push(request)
        return JSON.stringify({ jsonrpc: '2.0', id: request.id, result })
      },
    })
    return { transport, seen }
  }

  it('delegates a method call to the same composition execute() uses, with the same id sequence', async () => {
    const { transport, seen } = named({ show: 'Set show command' })
    const outcome = await transport.callMethod(HELP_CALL)
    expect(outcome.ok).toBe(true)
    expect(asMethod(seen[0]).id).toBe('named-6')
    expect(transport.kind).toBe('https')
    expect(transport.address).toBe(ADDRESS)
    expect(transport.toString()).toBe('FakeHttpsTransport(mock)')
  })

  it('answers verifyConfig through the named transport with the array gate, so a dry run is not object-parsed', async () => {
    const rows: readonly CommandResult[] = [{}, { outputInline: ['vlan 20'] }]
    const { transport, seen } = named(rows)
    const outcome = await transport.callMethod({ method: 'verifyConfig', params: { configList: ['vlan 20'] } })
    expect(outcome.ok).toBe(true)
    expect(asMethod(seen[0]).method).toBe('verifyConfig')
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.result).toEqual(rows)
  })

  it('shares close() with execute(), and a closed named transport refuses both without sending', async () => {
    const { transport, seen } = named({ show: 'Set show command' })
    await transport.close()
    await expect(transport.callMethod(HELP_CALL)).rejects.toBeInstanceOf(TransportError)
    expect(seen).toEqual([])
  })

  it('keeps callMethod optional on the Transport contract yet always present on a composed transport', () => {
    // `Transport#callMethod` is optional on purpose (`contract.ts`) so a pre-M11 hand-rolled transport still
    // type-checks — which is what lets `Node` refuse those instead of faking the call with `runCmds`. A
    // transport built by this composition can never be in that group: `ComposedTransport` says so in types,
    // and `TransportBase` provides the member, so the runtime check in `Node` never fires for it.
    const { transport } = named({ show: 'Set show command' })
    const view: Transport = transport
    expect(typeof view.callMethod).toBe('function')
  })
})
