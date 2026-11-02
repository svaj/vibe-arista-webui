/**
 * The composition every M2 transport shares — `Transport` over M1's `WireSender` (DR-002 seam).
 *
 * One place owns: the request-id policy for the connection (DR-017), the DR-012 `tolerateErrors`
 * path, wire tracing through `redactWireText` (DR-011), id correlation (PR #19's gap 1), the
 * DR-019 read-only retry, and "no calls after close". A transport contributes exactly one thing: a
 * `RawSend` that performs one byte-level round trip and returns raw text — which is precisely
 * M1's `WireSender`, so the codec in `src/internal/wire.ts` validates device output in exactly one
 * place for all seven transports (and for `MockTransport`).
 *
 * Browser-safe module: no `node:` imports (enforced by `src/browser-safety.test.ts` + the Vite
 * build guard, DR-002).
 */

import { ConnectError, EapiError, TransportError } from '../errors'
import { redactWireText } from '../internal/redact'
import { createRequestIds, sendRequest } from '../internal/wire'
import type { RequestIdOptions } from '../internal/wire'
import type { SendRequestResult } from '../internal/wire'
import type { CommandSpec, JsonRpcRequest, RequestIdPolicy, WireSender } from '../types/eapi'
import { assertResponseIdMatches } from './correlate'
import { DEFAULT_TIMEOUT_MS } from './contract'
import type { Transport, TransportBaseOptions, TransportExecOptions, TransportKind, WireTraceSink } from './contract'

/** One byte-level round trip: request in, raw response text out. Throws the mapped wire error on failure. */
export type RawSend = (request: JsonRpcRequest, context: RawSendContext) => Promise<string>

export interface RawSendContext {
  /** Effective deadline for this attempt, already resolved from per-call over per-connection defaults. */
  readonly timeoutMs: number
  /** Caller-supplied cancellation, already combined with the deadline by the transport's own sender. */
  readonly signal?: AbortSignal | undefined
}

/** What a transport hands the shared composition. */
export interface TransportKernel {
  readonly kind: TransportKind
  /** `https://sw1:443/command-api`, `http://127.0.0.1:8080/command-api`, `unix:/var/run/command-api.sock`. */
  readonly address: string
  /** Overrides `toString()`; pyeapi's `__str__` for the cert transport names the key/cert files. */
  readonly description?: string | undefined
  readonly send: RawSend
  /** Connection deadline (ms). Default `DEFAULT_TIMEOUT_MS` — DR-019, pyeapi's `timeout=60` s. */
  readonly timeoutMs?: number | undefined
  readonly trace?: WireTraceSink | undefined
  /** Reuse an existing id policy (M4's `Node` will want one per connection); else one is created. */
  readonly ids?: RequestIdPolicy | undefined
  /** Id policy options for the connection (`nonce`/`seed`/`start`) when this kernel creates its own. */
  readonly idOptions?: RequestIdOptions | undefined
  /** Release sockets/cookies. Called once by `close()`. */
  readonly onClose?: (() => void | Promise<void>) | undefined
}

/**
 * DR-019: exactly one resend, only for `ConnectError`, and only when the caller said the request is
 * read-only. It wraps the *byte-level* send, so it can never stack on M1's DR-012 `1003` →
 * `format:'text'` retry: a `ConnectError` is thrown before any envelope exists, and a 1003 answer is
 * a parsed envelope that never throws. Re-sending the same request (hence the same id) is correct
 * here because the first attempt never reached the device.
 */
function withReadOnlyRetry(sender: WireSender): WireSender {
  return {
    async send(request: JsonRpcRequest): Promise<string> {
      try {
        return await sender.send(request)
      } catch (error) {
        if (error instanceof ConnectError) return await sender.send(request)
        throw error
      }
    },
  }
}

/** Build the public `Transport` view over a transport's `RawSend`. */
export function createCodecTransport(kernel: TransportKernel): Transport {
  const ids = kernel.ids ?? createRequestIds(kernel.idOptions ?? {})
  const timeoutMs = kernel.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let closed = false

  async function tracedSend(request: JsonRpcRequest, attemptTimeoutMs: number, signal?: AbortSignal): Promise<string> {
    const sink = kernel.trace
    const requestId = String(request.id)
    // The outgoing body is redacted for the *sink* only: the device must receive an `enable` input
    // untouched for authentication to work (DR-011 — redaction is a logging concern, not a wire one).
    sink?.({ direction: 'request', endpoint: kernel.address, requestId, body: redactWireText(JSON.stringify(request)) })
    try {
      const text = await kernel.send(request, { timeoutMs: attemptTimeoutMs, ...(signal === undefined ? {} : { signal }) })
      sink?.({ direction: 'response', endpoint: kernel.address, requestId, body: redactWireText(text) })
      assertResponseIdMatches(request, text)
      return text
    } catch (error) {
      if (sink) {
        const reason = error instanceof EapiError ? `${error.name}: ${error.message}` : String(error)
        sink({ direction: 'failure', endpoint: kernel.address, requestId, body: redactWireText(reason) })
      }
      throw error
    }
  }

  const transport: Transport = {
    kind: kernel.kind,
    address: kernel.address,
    async execute(commands, options: TransportExecOptions = {}) {
      if (closed) {
        throw new TransportError(`transport ${kernel.kind} at ${kernel.address} is closed`, { endpoint: kernel.address })
      }
      const { timeoutMs: callTimeout, signal, readOnly, ...codecOptions }: TransportExecOptions = options
      const attemptTimeoutMs = callTimeout ?? timeoutMs
      let sender: WireSender = {
        send: (request) => tracedSend(request, attemptTimeoutMs, signal),
      }
      if (readOnly === true) sender = withReadOnlyRetry(sender)
      // `codecOptions` is `SendRequestOptions` by construction: the only keys it can carry are the
      // codec's, because the transport-only three above were destructured off first. Passing them to
      // `buildRequest` untouched would trip its own parameter allow-list (DR-016).
      return sendRequest(sender, commands, { ...codecOptions, ids: options.ids ?? ids })
    },
    async close(): Promise<void> {
      if (closed) return
      closed = true
      await kernel.onClose?.()
    },
    toString(): string {
      return kernel.description ?? kernel.address
    },
  }
  return transport
}

/** Merge the connection-level id options into one policy, shared by the transport and its tests. */
export function idPolicyFrom(options: TransportBaseOptions): RequestIdPolicy {
  return createRequestIds({
    ...(options.nonce === undefined ? {} : { nonce: options.nonce }),
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    ...(options.idStart === undefined ? {} : { start: options.idStart }),
  })
}

/**
 * The named transports (`FetchTransport`, `HttpTransport`, `UnixSocketTransport`, …) are classes so a
 * test or a UI can ask what it is holding with `instanceof`, while the behaviour still comes from
 * {@link createCodecTransport} — one composition, seven senders.
 */
export class TransportBase implements Transport {
  readonly kind: TransportKind
  readonly address: string
  protected readonly description: string
  private readonly inner: Transport

  constructor(kernel: TransportKernel) {
    this.kind = kernel.kind
    this.address = kernel.address
    this.description = kernel.description ?? kernel.address
    this.inner = createCodecTransport(kernel)
  }

  execute(commands: CommandSpec | readonly CommandSpec[], options?: TransportExecOptions): Promise<SendRequestResult> {
    return this.inner.execute(commands, options)
  }

  close(): Promise<void> {
    return this.inner.close()
  }

  toString(): string {
    return this.description
  }
}
