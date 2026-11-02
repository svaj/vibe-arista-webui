/**
 * `MockTransport` — M2 (#4), the offline seam every later test builds on (docs/TESTING.md §3).
 *
 * It is a real `Transport`: it runs through the shared composition in `src/transports/base.ts`, so it
 * exercises the same `buildRequest` → send → `parseResponse` path, the same id policy (DR-017) and the
 * same id correlation as the seven device transports. What it does **not** do is invent envelopes: it
 * scripts the *text* a device would have said, and `parseResponse` stays the only validator (M1's rule,
 * kept on purpose).
 *
 * The one behaviour pyeapi's `MockConnection` gets away with — silently answering `{}` to anything —
 * is refused here: an unmatched command list throws `NotSupportedError` naming the commands
 * (docs/TESTING.md §3: "a loud test failure, never an implicit `{}`"). That is the difference between
 * a test that proves a resource sent the right commands and one that only proves nothing crashed.
 *
 * Browser-safe: no `node:*` import, so `arista-webui` component tests can use it (DR-002).
 * Not reachable from `src/index.ts` either — production code cannot depend on a scripted device, and
 * `createTransport` refuses to build `kind: 'mock'` (see `src/transports/create.ts`).
 */

import {
  ConnectError,
  NotSupportedError,
  TlsError,
  TimeoutError,
  TransportError,
} from '../errors'
import { createCodecTransport, idPolicyFrom, type RawSend, type TransportKernel } from '../transports/base'
import type { Transport, TransportExecOptions } from '../transports/contract'
import { mapHttpStatus } from '../transports/error-map'
import type { SendRequestResult } from '../internal/wire'
import type { CommandResult, CommandSpec, JsonRpcError, JsonRpcId, JsonRpcRequest } from '../types/eapi'

/** Matches a request by its command list. `'*'` matches anything; a predicate matches anything else. */
export type CommandMatcher = string | ((commands: readonly CommandSpec[]) => boolean)

/** What a script entry can do when it matches. */
type ScriptAction =
  | { readonly kind: 'reply'; readonly reply: MockReply }
  | { readonly kind: 'fail'; readonly make: (request: JsonRpcRequest) => Error }

interface ScriptEntry {
  readonly match: CommandMatcher
  readonly action: ScriptAction
  /** `once` entries are consumed by the first match, so a two-step scenario can be scripted exactly. */
  once: boolean
  consumed: boolean
}

/**
 * A scripted device answer. Four shapes, all deliberately explicit:
 *  - `string` → the raw response text verbatim (for malformed/truncated bodies);
 *  - `CommandResult` → `{ result: [<that object>] }`, the common one-command `show` case;
 *  - array → `{ result: […] }`, one entry per command;
 *  - an envelope with `result` or `error` → used as given, with the request's `id` injected when the
 *    script omits one (so correlation passes unless the test is *about* correlation).
 */
export type MockReply =
  | string
  | CommandResult
  | readonly CommandResult[]
  | { jsonrpc?: '2.0'; result?: readonly CommandResult[]; error?: JsonRpcError; id?: JsonRpcId }

/** The same, in failure form: the device's `error` member, not an exception. */
export interface MockFailure {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

export interface MockTransportOptions {
  /** Deterministic request ids (DR-017) — `sent()` output can then be compared literally in a fixture. */
  readonly nonce?: string | undefined
  readonly seed?: string | undefined
  readonly idStart?: number | undefined
  /** Endpoint string reported by the transport; it never touches a socket, but errors quote it. */
  readonly address?: string | undefined
}

function commandTexts(commands: readonly CommandSpec[]): string[] {
  return commands.map((command) => (typeof command === 'string' ? command : command.cmd))
}

function matches(entry: ScriptEntry, commands: readonly CommandSpec[]): boolean {
  const { match } = entry
  if (match === '*') return true
  if (typeof match === 'function') return match(commands)
  const texts = commandTexts(commands)
  return texts.includes(match) || texts.join('\n') === match
}

/** Serialize a scripted answer into response text, echoing the request id when the script does not pin one. */
function replyBody(reply: MockReply, request: JsonRpcRequest): string {
  if (typeof reply === 'string') return reply
  if (Array.isArray(reply)) return JSON.stringify({ jsonrpc: '2.0', result: reply, id: request.id })
  if ('result' in reply || 'error' in reply) {
    const envelope: Record<string, unknown> = { jsonrpc: '2.0', ...reply, id: reply.id ?? request.id }
    return JSON.stringify(envelope)
  }
  return JSON.stringify({ jsonrpc: '2.0', result: [reply], id: request.id })
}

/**
 * A scripted non-2xx answer. Reuses the production status mapper so a mock 401 produces exactly the
 * `AuthError` the real transports would — an error-taxonomy test written against the mock is therefore
 * a test of the mapping, not of the mock's idea of it.
 */
function statusFailure(endpoint: string, status: number, body: string): (request: JsonRpcRequest) => Error {
  return (request) => mapHttpStatus(status, 'Scripted by MockTransport', body, { endpoint, request })
}

/**
 * The transport itself. Script first (`replies` / `rejects` / `fails…`), then assert on
 * {@link MockTransport.sent} and {@link MockTransport.bodies}.
 */
export class MockTransport implements Transport {
  readonly kind = 'mock' as const
  readonly address: string

  private readonly script: ScriptEntry[] = []
  private readonly requests: JsonRpcRequest[] = []
  private readonly commandLists: (readonly CommandSpec[])[] = []
  private readonly inner: Transport
  private closed = false

  constructor(options: MockTransportOptions = {}) {
    this.address = options.address ?? 'mock://device'
    const send: RawSend = async (request, ctx) => this.dispatch(request, ctx)
    const kernel: TransportKernel = {
      kind: 'mock',
      address: this.address,
      send,
      ids: idPolicyFrom({
        ...(options.nonce === undefined ? {} : { nonce: options.nonce }),
        ...(options.seed === undefined ? {} : { seed: options.seed }),
        ...(options.idStart === undefined ? {} : { idStart: options.idStart }),
      }),
    }
    this.inner = createCodecTransport(kernel)
  }

  execute(commands: CommandSpec | readonly CommandSpec[], options?: TransportExecOptions): Promise<SendRequestResult> {
    if (this.closed) return Promise.reject(new TransportError('this MockTransport is closed', { endpoint: this.address }))
    return this.inner.execute(commands, options)
  }

  async close(): Promise<void> {
    this.closed = true
    await this.inner.close()
  }

  toString(): string {
    return `MockTransport(${this.address})`
  }

  // --- scripting (chainable) ---------------------------------------------------------------------

  /** Answer `reply` to every request whose command list matches, for as long as the script lasts. */
  replies(match: CommandMatcher, reply: MockReply): this {
    this.script.push({ match, action: { kind: 'reply', reply }, once: false, consumed: false })
    return this
  }

  /** Answer once, then let later requests fall through to the next matching entry. */
  repliesOnce(match: CommandMatcher, reply: MockReply): this {
    this.script.push({ match, action: { kind: 'reply', reply }, once: true, consumed: false })
    return this
  }

  /** Reply with a device `error` envelope — the command still runs, and `CommandError` comes back. */
  rejects(match: CommandMatcher, failure: MockFailure): this {
    return this.repliesError(match, { code: failure.code, message: failure.message, ...(failure.data === undefined ? {} : { data: failure.data }) })
  }

  /** Lower-level version of {@link MockTransport.rejects}: script the whole `error` member. */
  repliesError(match: CommandMatcher, error: JsonRpcError): this {
    return this.replies(match, { error })
  }

  /** A bare `CommandError`, for the cases where the caller needs the exception rather than the envelope. */
  throws(match: CommandMatcher, error: Error): this {
    this.script.push({ match, action: { kind: 'fail', make: () => error }, once: false, consumed: false })
    return this
  }

  /** HTTP 401/403/404/405/5xx at the wire level, i.e. the mapped error path rather than an envelope. */
  httpStatus(status: number, body = ''): this {
    this.script.push({
      match: '*',
      action: { kind: 'fail', make: statusFailure(this.address, status, body) },
      once: false,
      consumed: false,
    })
    return this
  }

  /** TLS handshake failure (DR-013 mapping). */
  tlsFailure(message = 'mock scripted TLS handshake failure'): this {
    return this.wireFailure(() => new TlsError(message, { endpoint: this.address }))
  }

  /** Connection refused/DNS — the only failure class `readOnly: true` retries (DR-019). */
  connectFailure(message = 'mock scripted connection failure'): this {
    return this.wireFailure(() => new ConnectError(message, { endpoint: this.address, retryable: true }))
  }

  /** A scripted wire-level failure, thrown (not returned) by the byte-level sender. */
  wireFailure(makeFailure: () => Error): this {
    this.script.push({ match: '*', action: { kind: 'fail', make: () => makeFailure() }, once: false, consumed: false })
    return this
  }

  /** Reject the request after `ms` with `TimeoutError` (the DR-019 deadline shape). */
  timeoutAfter(ms: number): this {
    return this.wireFailure(() => new TimeoutError(`mock scripted timeout after ${String(ms)} ms`, { endpoint: this.address, retryable: false }))
  }

  // --- assertions -------------------------------------------------------------------------------

  /**
   * The exact command arrays of every request, in send order — the primary parity surface for the
   * resource modules (docs/TESTING.md §3), post-`buildRequest` coercion included.
   */
  sent(): readonly (readonly CommandSpec[])[] {
    return this.commandLists.map((list) => [...list])
  }

  /** Raw JSON-RPC request objects, for header/parameter assertions (`stopOnError`, `format`, ids). */
  bodies(): readonly JsonRpcRequest[] {
    return this.requests.map((request) => ({ ...request, params: { ...request.params, cmds: [...request.params.cmds] } }))
  }

  /** Every error the mock has produced so far — a scripted failure should be asserted, not logged. */
  callCount(): number {
    return this.requests.length
  }

  // --- internals ---------------------------------------------------------------------------------

  private async dispatch(request: JsonRpcRequest, ctx: { timeoutMs: number }): Promise<string> {
    this.requests.push(request)
    this.commandLists.push([...request.params.cmds])
    const entry = this.script.find((candidate) => !candidate.consumed && matches(candidate, request.params.cmds))
    if (entry === undefined) {
      throw new NotSupportedError(
        `MockTransport has no scripted answer for ${JSON.stringify(commandTexts(request.params.cmds))}. Add .replies(<command>, …) — an unmatched command never falls back to an empty result (docs/TESTING.md §3), and pyeapi's MockConnection silently returning {} is why upstream parse tests are weak.`,
      )
    }
    if (entry.once) entry.consumed = true
    if (entry.action.kind === 'fail') throw entry.action.make(request)
    if (ctx.timeoutMs < 0) throw new TimeoutError('mock scripted negative deadline', { endpoint: this.address })
    return replyBody(entry.action.reply, request)
  }
}

/** Chaining entry point, matching the shape docs/TESTING.md §3 shows (`mockTransport().replies(...)`). */
export function mockTransport(options: MockTransportOptions = {}): MockTransport {
  return new MockTransport(options)
}

/** Build the device `error` envelope text for a scripted failure, with the id of the request that asked. */
export function errorEnvelope(failure: MockFailure, id: JsonRpcId = 'scripted'): string {
  const error: JsonRpcError = { code: failure.code, message: failure.message, ...(failure.data === undefined ? {} : { data: failure.data }) }
  return JSON.stringify({ jsonrpc: '2.0', error, id })
}
