/**
 * Transport contracts — M2 (#4), the seam that makes the dual-runtime decision work (DR-002).
 *
 * ## How this relates to M1's `WireSender` (deliberate reconciliation, PR #…)
 *
 * M1 (#3) shipped `WireSender` (`src/types/eapi.ts`): `send(request) => Promise<string> | string`,
 * raw text in / raw text out. That seam is **kept unchanged** — it is the byte-level seam the pure
 * codec (`buildRequest` → send → `parseResponse`) sits on, and it is what makes the codec testable
 * without I/O (the only M1 implementation is `src/testing/fake-sender.ts`).
 *
 * `Transport` (this file) is the *public* abstraction PLAN.md M2 asks for. It composes the codec
 * rather than replacing it: every M2 transport implements one `WireSender` (fetch, `node:https`,
 * a unix socket, an in-process script) and hands it to `createCodecTransport` in
 * `src/transports/base.ts`, which runs `sendRequest()` from M1 over it. So:
 *
 *   Transport (kind, execute, close)  ← public, what M4's `Node` and the webui hold
 *      └── sendRequest (M1: buildRequest + 1003 text retry + parseResponse)
 *             └── WireSender (M1: one byte-level round trip, raw text)
 *
 * `execute()` returns M1's `SendRequestResult` rather than the `Promise<EapiReply>` sketched in
 * ARCHITECTURE §2, because that union is the honest shape of a device round trip: it carries the
 * request that was built, the encoding that actually answered (json, or text after the DR-012
 * fallback) and either the result array or the typed parse failure — i.e. success/error/loading
 * states without a thrown exception being the only channel. Nothing in M1's public surface moved.
 *
 * pyeapi cross-reference: `EapiConnection` + its 7 subclasses (`eapilib.py:68-757`) and
 * `client.TRANSPORTS` (`client.py:112-121`). MIGRATION.md §2 maps the class names, §5 the semantics.
 */

import type { SendRequestOptions, SendRequestResult } from '../internal/wire'
import type { CommandSpec } from '../types/eapi'

/**
 * Transport kinds, named after what they *are*, not after pyeapi's spelling.
 * pyeapi `TRANSPORTS` keys map through {@link TRANSPORT_ALIASES} (M3 #5 needs that for `eapi.conf`).
 *
 * `mock` is a kind so the factory switch stays exhaustive, but the mock is a test helper: it lives in
 * `src/testing/` and `createTransport` refuses to build it (construct `MockTransport` directly).
 */
export type TransportKind =
  | 'https'
  | 'http'
  | 'session'
  | 'https-client-cert'
  | 'unix'
  | 'http-local'
  | 'mock'

/** Kinds the browser-safe entry can construct (DR-002: `fetch` + `AbortController` only). */
export type BrowserTransportKind = 'https' | 'http'

/** Kinds that exist only behind `./node` (unix sockets, TLS client certs, cookie jars — DR-002/013/014/018). */
export type NodeOnlyTransportKind = 'session' | 'https-client-cert' | 'unix' | 'http-local'

/**
 * Defaults, ported from pyeapi (`eapilib.py:60-66`) with one **deliberate omission**:
 * `DEFAULT_HTTPS_LOCAL_PORT = 8443` is dropped — 4.28.13.1M generates exactly one loopback
 * listener, plain HTTP on 8080 (DR-014, verified in `SuperServerPlugin/HttpService.py:563-565`).
 * Do not resurrect it: the [device sweep](../../docs/STATUS.md) has not seen an 8443 listener
 * either, and claiming one would be an unverified assumption.
 */
export const DEFAULT_HTTPS_PORT = 443
export const DEFAULT_HTTP_PORT = 80
export const DEFAULT_HTTP_LOCAL_PORT = 8080
export const DEFAULT_HTTP_PATH = '/command-api'
export const DEFAULT_UNIX_PATH = '/var/run/command-api.sock'

/** DR-019: pyeapi's `timeout=60` **seconds** becomes 60 000 **ms**, which is what `AbortController` wants. */
export const DEFAULT_TIMEOUT_MS = 60_000

/**
 * pyeapi `client.TRANSPORTS` keys (and `eapi.conf`'s `transport = …` values) → our kinds.
 * `http_session`/`https_session` collapse into the single `session` kind whose scheme comes from the
 * endpoint, because pyeapi's two classes differ only in the `http.client` base class they mix in
 * (`eapilib.py:750-756`) — MIGRATION.md §5 row 23.
 */
export const TRANSPORT_ALIASES: Readonly<Record<string, TransportKind>> = Object.freeze({
  socket: 'unix',
  http_local: 'http-local',
  http: 'http',
  http_session: 'session',
  https: 'https',
  https_certs: 'https-client-cert',
  https_session: 'session',
  unix: 'unix',
  'http-local': 'http-local',
  session: 'session',
  'https-client-cert': 'https-client-cert',
  mock: 'mock',
})

/** Resolve a pyeapi-style transport name to a {@link TransportKind}; `undefined` when it is unknown. */
export function normalizeTransportKind(name: string): TransportKind | undefined {
  return TRANSPORT_ALIASES[name]
}

/** A log sink for wire bodies. Supplied by the caller; **bodies are already redacted** (see below). */
export type WireTraceSink = (entry: WireTraceRecord) => void

export type WireTraceDirection = 'request' | 'response' | 'failure'

export interface WireTraceRecord {
  readonly direction: WireTraceDirection
  /** Where it went (URL, or `unix:/var/run/command-api.sock`). Never contains credentials. */
  readonly endpoint: string
  readonly requestId: string
  /**
   * Request or response text, already run through `redactWireText` (DR-011).
   * This is a **logging** redaction only: the outgoing request is deliberately sent to the device
   * untouched, because an `enable` `input` has to reach the CLI for authentication to work.
   */
  readonly body: string
}

/** Options every transport accepts, whatever the kind. */
export interface TransportBaseOptions {
  /**
   * Client deadline for one byte-level round trip, in **ms** (pyeapi's `timeout` is seconds —
   * MIGRATION.md §5 row 22). Default {@link DEFAULT_TIMEOUT_MS} (DR-019). Not the same thing as the
   * `requestTimeout` *parameter* of `runCmds`, which is a server-side budget (M1, DR-016).
   */
  readonly timeoutMs?: number | undefined
  /** Request-id client segment (DR-017). A nonce makes ids traceable end to end. */
  readonly nonce?: string | undefined
  /** Pin the random part of the request id — deterministic ids for tests and recorded fixtures. */
  readonly seed?: string | undefined
  /** First sequence number this connection hands out; default 1. */
  readonly idStart?: number | undefined
  /** Opt-in wire logging. Every body handed to the sink has been through `redactWireText` (DR-011). */
  readonly trace?: WireTraceSink | undefined
}

/** Endpoint shape shared by every network kind (pyeapi `host` / `port` / `path`). */
export interface EndpointOptions {
  /** Host name or address of the switch's eAPI listener. */
  readonly host?: string | undefined
  /** Listener port; defaults to the kind's port (443 `https`, 80 `http`, 8080 `http-local`). */
  readonly port?: number | undefined
  /** Request path. Default `/command-api`. pyeapi *accepts* this option and then ignores it — row 24. */
  readonly path?: string | undefined
  /**
   * Full origin (optionally with a path prefix) instead of host/port — the DR-036 dev-proxy path
   * (`http://127.0.0.1:5173`) and the direct-TLS path (`https://sw1.lan`) both use this.
   */
  readonly baseUrl?: string | undefined
}

/** Basic-auth credentials (pyeapi `authentication(username, password)`). */
export interface CredentialOptions {
  readonly username?: string | undefined
  readonly password?: string | undefined
}

/**
 * Keys that only the `./node` entry understands. They are `never` on the browser entry's option
 * types so a browser-facing call site fails to compile rather than silently dropping TLS trust
 * configuration (DR-013). `createTransport` also refuses them at runtime for browser kinds, which is
 * what a JS caller (or an `as any`) gets instead.
 */
export interface NodeOnlyTlsOptions {
  readonly ca?: never | undefined
  readonly cert?: never | undefined
  readonly key?: never | undefined
  readonly serverName?: never | undefined
  readonly fingerprint?: never | undefined
  readonly dangerouslyDisableTlsVerification?: never | undefined
}

/** TLS trust material, Node only (DR-013). A string is inline PEM or a file path — see `node-tls.ts`. */
export interface TlsMaterialOptions {
  /** CA bundle(s) used to verify the device certificate. */
  readonly ca?: string | readonly string[] | undefined
  /** Client certificate (mTLS). */
  readonly cert?: string | undefined
  /** Client private key (mTLS). */
  readonly key?: string | undefined
  /** SNI/verification name when it must differ from `host` (a NAT or proxy address in front of the switch). */
  readonly serverName?: string | undefined
  /** Pin the device certificate by SHA-1 (40 hex) or SHA-256 (64 hex) fingerprint, colons optional. */
  readonly fingerprint?: string | undefined
  /**
   * The loud escape hatch. `true` disables certificate verification **and** prints a one-line
   * process warning; it is never implied by anything else (DR-013).
   */
  readonly dangerouslyDisableTlsVerification?: boolean | undefined
}

/** Cleartext opt-in, for the `http` kind only. */
export interface InsecureTransportGate {
  /** Required to use `http` against a **non-loopback** address. Also emits the warning (DR-008/013). */
  readonly allowInsecureTransport?: boolean | undefined
}

/**
 * Local listeners (`unix`, `http-local`) are switch-local **and** unauthenticated priv-15 on 4.28 —
 * EOS marks them `DISABLE_AAA` (`HttpServicePlugin/Capi.py:83-124`). The flag is a required literal
 * `true`, so omitting it is a compile error, not a runtime surprise (DR-008).
 */
export interface LocalTrustGate {
  readonly allowLocalUnauthenticated: true
}

// --- per-kind option records ---------------------------------------------------------------------

/**
 * `https` over `fetch` (browser) or `node:https` (Node, when TLS trust options are supplied).
 *
 * TLS material is **allowed on this kind**, which is what makes DR-013 pinning and row 28 possible:
 * `kind: 'https'` must be able to carry `ca`/`fingerprint` from the `./node` entry, or the only way
 * to express trust would be to switch to `https-client-cert`/`session`, whose auth semantics are
 * different. A browser-facing call site that passes them is refused **at runtime** by
 * `assertOptionKeys(..., 'browser')` in `createTransport` with a message naming the entry that does
 * accept them; the `never`-typed compile-time variant of that guard is kept on `http`, where TLS
 * material is meaningless rather than entry-dependent.
 */
export interface HttpsTransportOptions
  extends TransportBaseOptions, EndpointOptions, CredentialOptions, TlsMaterialOptions {
  readonly kind: 'https'
}

/** `http` (cleartext). Loopback-only unless `allowInsecureTransport: true` + a warning. Replaces pyeapi `http`. */
export interface HttpTransportOptions
  extends TransportBaseOptions, EndpointOptions, CredentialOptions, InsecureTransportGate, NodeOnlyTlsOptions {
  readonly kind: 'http'
}

/** Cookie-session auth over `http` or `https` — pyeapi `http_session` + `https_session` (Node-only, DR-018). */
export interface SessionTransportOptions
  extends TransportBaseOptions, EndpointOptions, CredentialOptions, InsecureTransportGate, TlsMaterialOptions {
  readonly kind: 'session'
  /** Local-only guard for completeness: a switch-local cookie session still needs opting in (DR-008). */
  readonly allowLocalUnauthenticated?: never | undefined
  readonly socketPath?: never | undefined
}

/** Client-certificate auth — pyeapi `https_certs` (Node-only). `cert` + `key` are required: row 25. */
export interface ClientCertTransportOptions
  extends TransportBaseOptions, EndpointOptions, CredentialOptions, TlsMaterialOptions {
  readonly kind: 'https-client-cert'
  readonly cert: string
  readonly key: string
  readonly socketPath?: never | undefined
  readonly allowInsecureTransport?: never | undefined
  readonly allowLocalUnauthenticated?: never | undefined
}

/** Unix socket eAPI (`/var/run/command-api.sock`) — pyeapi `socket` (Node-only, DR-014). */
export interface UnixTransportOptions extends TransportBaseOptions, LocalTrustGate {
  readonly kind: 'unix'
  /** Socket path. Default {@link DEFAULT_UNIX_PATH}. pyeapi calls this `path` — row 24. */
  readonly socketPath?: string | undefined
  // Not applicable to a socket: these are `never` so `{ kind: 'unix', host: 'sw1' }` is a compile
  // error (docs/TESTING.md §6), instead of an option that quietly does nothing.
  readonly host?: never | undefined
  readonly port?: never | undefined
  readonly path?: never | undefined
  readonly baseUrl?: never | undefined
  readonly username?: never | undefined
  readonly password?: never | undefined
  readonly allowInsecureTransport?: never | undefined
}

/** Switch-local cleartext eAPI, `http://127.0.0.1:8080` (Node-only, DR-014 — there is no 8443). */
export interface HttpLocalTransportOptions extends TransportBaseOptions, LocalTrustGate {
  readonly kind: 'http-local'
  readonly port?: number | undefined
  readonly path?: string | undefined
  readonly host?: never | undefined
  readonly baseUrl?: never | undefined
  readonly username?: never | undefined
  readonly password?: never | undefined
  readonly socketPath?: never | undefined
  readonly allowInsecureTransport?: never | undefined
}

/** Rejected by `createTransport` with `NotSupportedError` — build `MockTransport` from `src/testing/`. */
export interface MockTransportOptions extends TransportBaseOptions {
  readonly kind: 'mock'
}

/** Everything `createTransport` accepts: the exhaustive union over {@link TransportKind}. */
export type TransportOptions =
  | HttpsTransportOptions
  | HttpTransportOptions
  | SessionTransportOptions
  | ClientCertTransportOptions
  | UnixTransportOptions
  | HttpLocalTransportOptions
  | MockTransportOptions

/** Per-call options for {@link Transport.execute}: the `runCmds` parameters plus transport knobs. */
export interface TransportExecOptions extends SendRequestOptions {
  /** Override this call's deadline (ms). */
  readonly timeoutMs?: number | undefined
  /** Cancel an in-flight device call from the UI. Aborting produces `TransportError`, not a silent hang. */
  readonly signal?: AbortSignal | undefined
  /**
   * DR-019: this request is safe to re-send, so one retry is allowed on `ConnectError` (nothing was
   * written to the device). Default `false` — configuration writes are never retried.
   */
  readonly readOnly?: boolean | undefined
}

/** A device round trip: commands in, M1's parsed result-or-typed-failure out. */
export interface Transport {
  /** The pyeapi-equivalent transport name, as data (ARCHITECTURE §2). */
  readonly kind: TransportKind
  /**
   * Where this transport posts: `https://sw1:443/command-api`, `http://127.0.0.1:8080/command-api`,
   * or `unix:/var/run/command-api.sock`. Used in error messages and asserted by the ported
   * `test_create_*_connection` cases (pyeapi reached for `str(instance.transport)` for the same).
   */
  readonly address: string
  /** build → send → parse for one batch of commands. Never throws for a device error envelope. */
  execute(commands: CommandSpec | readonly CommandSpec[], options?: TransportExecOptions): Promise<SendRequestResult>
  /** Idempotent. Cookie transports also `POST /logout` here (DR-018 — pyeapi never logs out). */
  close(): Promise<void>
  /** pyeapi `__str__`/`__repr__` equivalent, secret-free (no password is ever rendered). */
  toString(): string
}

/**
 * The exhaustiveness guard for the factory switches. If a {@link TransportKind} is added without a
 * `case`, the argument stops narrowing to `never` and this **fails to compile** (PLAN M2: "compile
 * error when a kind is unimplemented"). At runtime it still throws, for a caller coming from JS or a
 * cast profile file.
 */
export function assertTransportKindsExhaustive(kind: never): never {
  const received = (kind as { kind?: unknown } | undefined)?.kind
  throw new TypeError(`unknown transport kind ${JSON.stringify(received ?? kind)}`)
}
