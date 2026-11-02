/**
 * `@devhax-heavy-industries/arista-eapi` — browser-safe entry point (DR-002).
 *
 * M1 (#3) put the wire protocol core behind this entry: the `runCmds` codec, the error taxonomy and
 * DR-011 redaction. M2 (#4) adds the browser-capable transports: `FetchTransport` (`https`) and
 * `HttpTransport` (`http`, loopback-gated). Profiles are M3 (#5) and the `Node` command layer M4 (#6).
 *
 * Two properties are enforced, not just intended:
 *  - no file reachable from this module imports a `node:` built-in — checked by
 *    `src/browser-safety.test.ts` **and** by the Vite build guard in `vite.config.ts`, which fails the
 *    build if `dist/index.js` ever references one (DR-002);
 *  - nothing here performs I/O except through a `Transport` you construct explicitly, and the
 *    switch-local kinds (`unix`, `http-local`) cannot be built from this entry at all (DR-008/DR-014).
 */

// --- wire codec (src/internal/wire.ts; internals are not an import path, but the codec, error and
//     redaction helpers re-exported here are the public surface — DR-040) -------------------------
// `pythonRepr`, `formatErrorDataEntries` and `decorateUnsupportedParam` stay internal: they exist to
// keep pyeapi message rendering comparable (tested directly) and are not a consumer contract.
export {
  buildRequest,
  createRequestIds,
  isUnconvertedCommandFailure,
  MAX_RAW_BODY,
  parseErrorEnvelope,
  parseResponse,
  runRequest,
  sendRequest,
  unwrapResponse,
  type BuildRequestOptions,
  type ParsedResponse,
  type RequestIdOptions,
  type ResponseContext,
  type SendRequestOptions,
  type SendRequestResult,
} from './internal/wire'
export { REDACTED, redactCommandText, redactCommands, redactSecrets, redactWireText } from './internal/redact'

// --- error taxonomy (DR-010, DR-011) ------------------------------------------------------------
export {
  AuthError,
  CommandError,
  ConnectError,
  EapiError,
  EapiErrorCode,
  eapiErrorName,
  NotSupportedError,
  ProtocolError,
  renderCommandError,
  SessionError,
  TimeoutError,
  TlsError,
  TransportError,
  type CommandErrorOptions,
  type EapiErrorOptions,
  type ProtocolErrorOptions,
  type TraceEntry,
} from './errors'

// --- wire contracts (src/types/eapi.ts, declaration-only) ---------------------------------------
export type {
  CommandObject,
  CommandResult,
  CommandSpec,
  EapiResponse,
  ErrorDetailData,
  ErrorDetailEntry,
  JsonRpcError,
  JsonRpcFailure,
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcSuccess,
  RequestIdPolicy,
  RunCmdsFormat,
  RunCmdsParams,
  RunCmdsVersion,
  ShowContracts,
  ShowReply,
  WireSender,
} from './types/eapi'

// --- transports (M2 #4, DR-002) -------------------------------------------------------------------
// The two kinds a browser build may construct, plus the contracts M4's `Node` (#6) and the webui hold.
// The Node-only kinds are *reachable as type names* here (so a profile object can be typed once) but
// `createTransport` refuses them at runtime with a `NotSupportedError` that names the `./node` import
// (DR-002/DR-013/DR-014/DR-018) — asserted in `src/browser-safety.test.ts`.
export { createTransport } from './transports/create'
export { EAPI_CONTENT_TYPE, FetchTransport, HttpTransport } from './transports/fetch'
export { basicAuth, authorizationHeader } from './transports/auth'
export {
  DEFAULT_HTTP_PATH,
  DEFAULT_HTTP_PORT,
  DEFAULT_HTTPS_PORT,
  DEFAULT_HTTP_LOCAL_PORT,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_UNIX_PATH,
  normalizeTransportKind,
  TRANSPORT_ALIASES,
} from './transports/contract'
export { isLoopbackHost } from './transports/endpoint'
export type {
  BrowserTransportKind,
  ClientCertTransportOptions,
  CredentialOptions,
  EndpointOptions,
  HttpLocalTransportOptions,
  HttpTransportOptions,
  HttpsTransportOptions,
  InsecureTransportGate,
  LocalTrustGate,
  MockTransportOptions,
  NodeOnlyTlsOptions,
  NodeOnlyTransportKind,
  SessionTransportOptions,
  TlsMaterialOptions,
  Transport,
  TransportBaseOptions,
  TransportExecOptions,
  TransportKind,
  TransportOptions,
  UnixTransportOptions,
  WireTraceDirection,
  WireTraceRecord,
  WireTraceSink,
} from './transports/contract'

/**
 * Placeholder for the connection options `createNode` will take.
 * The real shape (transport selection, TLS trust, profiles) is defined by M2/M3.
 */
export interface NodeOptions {
  /** Host or address of the switch's eAPI endpoint (`POST /command-api`). */
  readonly host?: string
}

/**
 * M0 placeholder (#2). Creates a client for one switch.
 *
 * Always throws: the command layer it is supposed to return arrives in M4 (#6).
 * Its only job is to make the package resolvable and importable by name from
 * `arista-webui` — see `arista-webui/src/eapi-package.test.ts`.
 */
export function createNode(options: NodeOptions = {}): never {
  throw new Error(
    `@devhax-heavy-industries/arista-eapi: createNode() is an M0 placeholder (#2) and has no ` +
      `implementation yet — the command layer lands in M4 (#6). Received options: ` +
      `${JSON.stringify(options)}`,
  )
}
