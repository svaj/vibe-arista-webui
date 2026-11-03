/**
 * `@devhax-heavy-industries/arista-eapi` — browser-safe entry point (DR-002).
 *
 * M1 (#3) put the wire protocol core behind this entry: the `runCmds` codec, the error taxonomy and
 * DR-011 redaction. M2 (#4) adds the browser-capable transports: `FetchTransport` (`https`) and
 * `HttpTransport` (`http`, loopback-gated). M4 (#6) adds the `Node` command layer
 * (`src/command-layer.ts`): `exec` / `show` / `showText` / `configure` / cached configs / device
 * identity. M5 (#7) adds config sessions (`src/config-session.ts`): `node.configSession()` with the
 * DR-025 state machine, `diff()`/`commit()`/`abort()`, orphan discovery and the explicit durability
 * verbs — all browser-safe, with the journal itself behind an injected interface (the file
 * implementation is in `./node`). Connection profiles and the option-bag factories (`createNode`,
 * `createConnection`) — i.e. `eapi.conf` lookup and the transport-plus-settings bag — are M3 (#5), so
 * until then a `Node` is built from an explicit `Transport`.
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

// --- command layer (M4 #6, src/command-layer.ts) ------------------------------------------------
// pyeapi's `client.Node`, ported by behaviour rather than by shape (DR-003): `runCommands`, `exec`
// (= pyeapi `enable`, no duplicate `response` key — DR-007), the typed `show` shell over the
// augmentable `ShowContracts` map, `configure`, the async config accessors (DR-005) and the lazily
// parsed device identity. `parseVersionProperties` and `tryVariants` are exported because TESTING.md
// §6 keeps parsers pure and unit-testable without a device (DR-006 for variants).
export { Node, parseVersionProperties } from './command-layer'
export { tryVariants } from './internal/variants'
export type {
  ConfigOutput,
  ConfigTarget,
  ExecResult,
  GetConfigOptions,
  NodeRequestOptions,
  NodeSettings,
  ShowOptions,
  ShowTextOptions,
  VersionProperties,
} from './command-layer'
export type { CliVariant, VariantSender } from './internal/variants'

// --- config sessions & change safety (M5 #7, src/config-session.ts) ------------------------------
// `node.configSession()` and the verbs above it are the usual way in; the free functions and the parsed
// `show configuration sessions` view are exported because a UI renders them directly (a pending-session
// table, a diff review screen) and because the journal seam is an interface with two implementations:
// `FileSessionJournal` behind `./node` (DR-002) and `createWebStorageJournal(localStorage)` here.
// `parseConfigurationSessions`/`generateSessionName` are exported for the same reason M4 exported
// `parseVersionProperties`: pure, testable without a device (TESTING.md §6).
export {
  assertNoSessionConflict,
  assertTerminalModeAllowed,
  ConfigSession,
  COPY_RUNNING_TO_STARTUP,
  createConfigSession,
  createWebStorageJournal,
  generateSessionName,
  MAX_SESSION_NAME_LENGTH,
  parseConfigurationSessions,
  SESSION_JOURNAL_STORAGE_KEY,
  SESSION_NAME_PREFIX,
} from './config-session'
export type {
  ChangesetOutcome,
  ConfigSessionInstance,
  ConfigSessionOptions,
  ConfigSessionState,
  ConfigSessionSummary,
  ConfigurationSessions,
  ConfigureReplaceOptions,
  ListSessionsOptions,
  RecoveryCandidate,
  RecoverOrphansOptions,
  RecoverOrphansOutcome,
  SessionCommandTarget,
  SessionCommitOptions,
  SessionJournal,
  SessionJournalEntry,
  SessionRequestOptions,
  WebStorageLike,
} from './config-session'

/**
 * Placeholder for the **connection** options `createNode` will take, i.e. how to reach the switch
 * (transport selection, TLS trust, credentials, profile name). M2 (#4) shipped the real shape for a
 * transport ({@link TransportOptions}); the combined bag — those options plus the per-node settings
 * below — is defined by M3 (#5), which owns profiles and the `client.connect()` equivalent
 * (PLAN.md M3: "`createConnection(profile)` and `createNode(profile)`").
 *
 * The per-`Node` behaviour bag is {@link NodeSettings}, and it is not the same thing: it is the second
 * argument of `new Node(transport, settings)` (pyeapi's `Node(connection, **kwargs)`,
 * `client.py:495-507`).
 */
export interface NodeOptions {
  /** Host or address of the switch's eAPI endpoint (`POST /command-api`). */
  readonly host?: string
}

/**
 * M0 placeholder (#2), still unimplemented after M4 (#6): building a client from *connection options*
 * is pyeapi's `connect(..., return_node=True)`, and PLAN.md assigns that to M3 (#5), together with
 * `eapi.conf` profiles — a profile is where `transport`/`host`/`enablepwd` come from.
 *
 * What M4 did land is the thing this function would return: construct it from an explicit transport
 * in the meantime —
 *
 * ```ts
 * const node = new Node(createTransport({ kind: 'https', host, username, password }), {
 *   configDefaults: true,
 * })
 * ```
 *
 * Its other job, unchanged since M0, is to make the package resolvable and importable by name from
 * `arista-webui` — see `arista-webui/src/eapi-package.test.ts`.
 */
export function createNode(options: NodeOptions = {}): never {
  throw new Error(
    `@devhax-heavy-industries/arista-eapi: createNode() is an M0 placeholder (#2) — connection/profile ` +
      `options land in M3 (#5). The command layer it would hand back exists now (M4, #6): ` +
      `new Node(createTransport({ kind, … }), { enablePassword, autorefresh, configDefaults }). ` +
      `Received options: ${JSON.stringify(options)}`,
  )
}
