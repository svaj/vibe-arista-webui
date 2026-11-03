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
 * identity. M3 (#5) adds the connection-profile layer and the option-bag factories (`createNode`,
 * `createConnection`): an INI parser plus a `ProfileStore` here, with profiles supplied by the
 * application (`createProfiles`) because **this entry has no filesystem** — reading an `eapi.conf`
 * from disk is `./node` (`src/node-profiles.ts`, DR-038/DR-044). `new Node(createTransport(…))` still
 * works for callers who want to hold the transport themselves.
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
// The two kinds a browser build may construct, plus the contracts M4's `Node` (#6), M3's profile
// bridge and the webui hold. The Node-only kinds are *reachable as type names* here (so a profile
// object can be typed once) but `createTransport` refuses them at runtime with a `NotSupportedError`
// that names the `./node` import (DR-002/DR-013/DR-014/DR-018) — asserted in
// `src/browser-safety.test.ts`, and again one layer up in `src/profiles.test.ts` for profiles.
import { createTransport } from './transports/create'

export { createTransport }
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

// --- connection profiles (M3 #5, src/profiles.ts, DR-038/DR-044) --------------------------------
// pyeapi's `Config` / `config_for` / `hosts_for_tag` (`client.py:127-367`) without the file: an INI
// parser, a typed store, and the profile → M2 transport-options bridge. The **filesystem** half of
// DR-038 lives in `src/node-profiles.ts` behind `./node`, so nothing reachable from this entry reads
// `node:fs`, a browser app's profiles come from its own config (`createProfiles`), and neither the
// implicit `[connection:localhost]` socket profile nor any default host exists here (DR-008).
export {
  acceptedTransportNames,
  CONNECTION_SECTION_PREFIX,
  createProfiles,
  DEFAULT_LOCAL_CONNECTION_NAME,
  DEFAULT_PROFILE_TRANSPORT,
  normalizeProfile,
  parseEapiConf,
  ProfileStore,
  profileNodeSettings,
  profileToTransportOptions,
  type ConnectionProfile,
  type ParsedEapiConf,
  type ParseEapiConfOptions,
  type ProfileEntry,
  type ProfileFieldValue,
  type ProfileFields,
  type ProfileIssue,
  type ProfileIssueKind,
  type ProfileRecord,
  type ProfileTransportOptions,
} from './profiles'

// --- the `connect()` / `connect_to()` equivalents (M3 #5) ---------------------------------------
// pyeapi's `connect(transport=…, host=…, return_node=True)` (`client.py:394-461`) and
// `connect_to(name)` (`client.py:1040-1067`), rebuilt as validated option bags: M1/M2's allow-lists
// decide which keys exist, `return_node` disappears because the function name says it, and a
// pyeapi-spelled profile (`transport = socket`, `http_session`, `https_certs`) still resolves to the
// right kind through `TRANSPORT_ALIASES`.
//
// Two forms, one function each:
//
// ```ts
// // explicit connection bag — what M4's `new Node(createTransport(…))` callers already write
// const node = createNode({ kind: 'https', host: 'sw1.lan', username: 'ui-ro', password: pw })
// // a profile from application config (DR-038's browser half)
// const store = createProfiles({ lab: { transport: 'https', host: '10.0.0.30', tags: 'rack-a' } })
// const fromName = createNode({ profileName: 'lab', store, configDefaults: false })
// const fromObject = createNode({ profile: store.get('lab')! })
// ```
//
// A profile-*name* form needs an explicit `store` **here**: this entry has no filesystem to fall
// back to, so `@devhax-heavy-industries/arista-eapi/node` is where `eapi.conf` lookup lives
// (DR-002/DR-038). `Transport`/`Node` are re-exported above, so `new Node(createTransport(…))` keeps
// working for callers who want to hold the transport themselves.
export {
  connectionFromOptions,
  connectionFromProfile,
  nodeFromOptions,
  nodeFromProfile,
  profileNotFound,
  type ConnectionOptions,
  type NodeFactoryOptions,
  type ProfileConnectionOptions,
  type ProfileObjectOptions,
  type TransportFactory,
} from './internal/conf-builder'
import { connectionFromOptions, nodeFromOptions, type NodeFactoryOptions } from './internal/conf-builder'
// `Node` and `Transport` are re-exported above for consumers, but `export … from` does **not** put a
// name in this module's own scope, which is why the two factories below used to fail to compile
// (TS2304/TS2552). They need their own `import type`, and `verbatimModuleSyntax` requires it to be
// type-only so nothing extra is emitted into the browser bundle.
import type { Node } from './command-layer'
import type { Transport } from './transports/contract'

/**
 * A transport for one EOS endpoint — pyeapi's `connect()`, browser kinds only (`https`, or `http`
 * with the loopback/`allowInsecureTransport` rule). An unnamed host is refused rather than defaulted
 * to `localhost` the way `client.py:394` does (MIGRATION.md §5 row 8).
 */
export function createConnection(options: NodeFactoryOptions): Transport {
  return connectionFromOptions(options, createTransport, 'browser')
}

/**
 * The command layer over one endpoint — pyeapi's `connect(..., return_node=True)`. Nothing has been
 * sent yet: a `Node` this builds is connected on the first `await`, and every failure that follows is
 * a typed error carrying `commands` + `requestId` (M2's rule, ARCHITECTURE §4).
 */
export function createNode(options: NodeFactoryOptions): Node {
  return nodeFromOptions(options, createTransport, 'browser')
}
