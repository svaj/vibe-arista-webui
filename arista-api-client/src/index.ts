/**
 * `@devhax-heavy-industries/arista-eapi` — browser-safe entry point (DR-002).
 *
 * M1 (#3) put the wire protocol core behind this entry: the `runCmds` codec, the error taxonomy
 * and DR-011 redaction. Transports are M2 (#4), profiles M3 (#5) and the `Node` command layer
 * M4 (#6). Nothing exported here performs I/O — `WireSender` is the injected seam M2 implements,
 * and no file reachable from this module may import a `node:` built-in (DR-002, docs/ARCHITECTURE.md §5).
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
