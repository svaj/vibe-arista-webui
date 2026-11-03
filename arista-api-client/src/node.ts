/**
 * `@devhax-heavy-industries/arista-eapi/node` — Node-only entry point (DR-002).
 *
 * This is the **only** module in the package allowed to reach `node:net` / `node:tls` / `node:fs`, and
 * it is where the Node-only capabilities register:
 *  - `kind: 'https'` with real TLS trust — CA bundle, client cert/key, SNI, **fingerprint pinning**,
 *    and the loud `dangerouslyDisableTlsVerification` escape hatch (DR-013);
 *  - `kind: 'session'` — `POST /login` → reuse `Set-Cookie` → `POST /logout` (DR-018, pyeapi never
 *    logs out), covering pyeapi's `http_session` and `https_session` in one kind;
 *  - `kind: 'https-client-cert'` — pyeapi `https_certs`;
 *  - `kind: 'unix'` (`/var/run/command-api.sock`) and `kind: 'http-local'` (`127.0.0.1:8080`, plain
 *    HTTP only — 4.28 has no 8443 listener, so `DEFAULT_HTTPS_LOCAL_PORT` is dropped, DR-014), each
 *    requiring `allowLocalUnauthenticated: true` and printing the DR-014 warning (DR-008).
 *
 * Still ahead: the on-disk config-session journal M5 (#7 / DR-022), the resource layer M8-M11 and the
 * live/recorded suite M12 (#14). What has landed here is the command layer (M4, #6 — `Node` lives in
 * `src/command-layer.ts`) and the profile factories M3 (#5) below, which is where a `Node` over
 * `kind: 'session'`, `kind: 'unix'` or a name from a real `eapi.conf` can be built.
 *
 * Requires Node >= 20 (`engines`) because `fetch` must be global.
 */

import { createNodeTransport } from './transports/node-create'
import {
  connectionFromOptions,
  connectionFromProfileStore,
  nodeFromOptions,
  nodeFromProfileStore,
  type NodeFactoryOptions,
  type ProfileConnectionOptions,
} from './internal/conf-builder'
import { loadEapiConf, type NodeLoadEapiConfOptions } from './node-profiles'
import type { Node, NodeSettings } from './command-layer'
import type { ProfileFields, ProfileStore } from './profiles'
import type { Transport, TransportOptions } from './transports/contract'

/**
 * The Node factory is the same name as the browser one and accepts the same `TransportOptions` union —
 * what differs is which kinds it will build. Local (explicit) exports take precedence over `export *`
 * in ESM, so this deliberately shadows the browser entry's narrower `createTransport`: every `./node`
 * consumer gets the exhaustive Node switch, and `kind: 'unix'` etc. really do construct.
 */
export function createTransport(options: TransportOptions): Transport {
  return createNodeTransport(options)
}

export { ClientCertTransport } from './transports/node-client-cert'
export { HttpLocalTransport, LOCAL_HOST } from './transports/node-http-local'
export { LOGIN_PATH, LOGOUT_PATH, SessionCookieTransport } from './transports/node-cookie'
export { TlsTransport } from './transports/node-https'
export { UnixSocketTransport, unixAddress } from './transports/node-unix'
export { fingerprintAlgorithm, normalizeFingerprint, resolveTlsConnect } from './transports/node-tls'
export type { NodeTlsConnect, ResolvedTlsMaterial, TlsMode, TlsTarget } from './transports/node-tls'
export { assertCleartextAllowed, assertLocalOptIn, assertNoCredentials } from './transports/local'
export { wantsNodeTls } from './transports/create'

/** The browser-safe surface, so `./node` is a strict superset of `.` (one import per app is enough). */
export * from './index'

// --- the M3 (#5) filesystem half, only reachable from this entry (DR-002/DR-038/DR-044) ----------
// `loadEapiConf` is the *only* function in the package that reads a file, and `node-profiles.ts` is
// the only module that imports `node:fs` for profiles. The decisions (search order, `$EAPI_CONF`, `~`,
// the implicit-`localhost` toggle) live in `src/internal/eapi-conf.ts` with the filesystem injected,
// so a unit test never touches a disk and the browser entry never sees any of this.
export {
  CONFIG_SEARCH_PATH,
  EAPI_CONF_ENV_VAR,
  eapiConfSearchPath,
  expandHome,
  loadEapiConf,
  nodeConfFileSystem,
} from './node-profiles'
export type {
  ConfFileSystem,
  EapiConfCandidate,
  LoadedEapiConf,
  LoadEapiConfOptions,
  NodeLoadEapiConfOptions,
} from './node-profiles'

/**
 * Options for the name-based factories below — `createNodeFor`/`createConnectionFor` are pyeapi's
 * `connect_to(name)` (`client.py:1040-1067`), which reads a module-global `Config` nobody asked for
 * (row 54). Here the store is either handed over or loaded through the seams in
 * {@link NodeLoadEapiConfOptions}, and a test injects its own `fs` instead of a home directory.
 */
export interface NodeProfileOptions extends NodeSettings {
  /** Profiles to look the name up in. Loaded from `eapi.conf` when omitted (`conf` configures that). */
  readonly store?: ProfileStore | undefined
  /** Per-call overrides of the profile's own fields — how a caller states `allow_local_unauthenticated`. */
  readonly overrides?: ProfileFields | undefined
  /**
   * Add pyeapi's implicit `[connection:localhost] transport = socket` when the store has no
   * `localhost` (`client.py:214-221`). Default **`true`** on this entry (DR-008's Node half); the
   * profile still cannot become a transport until `allow_local_unauthenticated` is stated (DR-014).
   */
  readonly implicitLocalhost?: boolean | undefined
  /** Seams for the `eapi.conf` search when `store` is omitted: `fs`, `env`, `paths`, `filename`, `warn`. */
  readonly conf?: NodeLoadEapiConfOptions | undefined
}

/** Profiles from disk — {@link loadEapiConf} reduced to just the store it filled. */
export function loadProfileStore(options: NodeLoadEapiConfOptions = {}): ProfileStore {
  const { store } = loadEapiConf(options)
  return store
}

function profileConnectionOptions(name: string, options: NodeProfileOptions): ProfileConnectionOptions {
  const { store, overrides, implicitLocalhost, conf } = options
  // The toggle has to reach the **disk load** too: `loadEapiConf` injects pyeapi's implicit
  // `[connection:localhost]` by default on this entry, and if the factory-level `false` only
  // suppressed the second injection in `conf-builder`, the loaded store would still carry an
  // unrequested localhost profile and the refusal the caller asked for would never happen.
  // (The same half-off would leak through `conf: { implicitLocalhost: false }` alone, because
  // `optionsFromProfileName` then re-injects at its own `entry === 'node'` default.)
  const effectiveImplicit = implicitLocalhost ?? conf?.implicitLocalhost
  return {
    profileName: name,
    store:
      store ??
      loadProfileStore({
        ...(conf ?? {}),
        ...(effectiveImplicit === undefined ? {} : { implicitLocalhost: effectiveImplicit }),
      }),
    ...(overrides === undefined ? {} : { overrides }),
    ...(effectiveImplicit === undefined ? {} : { implicitLocalhost: effectiveImplicit }),
    ...splitNodeSettings(options),
  }
}

/** The `Node` settings out of a {@link NodeProfileOptions} bag, so they are not lost on the way in. */
function splitNodeSettings(options: NodeProfileOptions): NodeSettings {
  const { enablePassword, autorefresh, configDefaults } = options
  return {
    ...(enablePassword === undefined ? {} : { enablePassword }),
    ...(autorefresh === undefined ? {} : { autorefresh }),
    ...(configDefaults === undefined ? {} : { configDefaults }),
  }
}

/**
 * The command layer over an option bag or a profile — pyeapi's `connect(..., return_node=True)` and
 * `connect_to(name)` in one function (`client.py:394-461`, `:1040-1067`).
 *
 * It replaces the M0/M4 placeholder, and differs from the browser entry's `createNode` in exactly one
 * way: **which kinds it can build** (`createNodeTransport` handles `session`, `https-client-cert`,
 * `unix` and `http-local` — DR-002/DR-013/DR-014/DR-018), plus the fact that a profile **name** with no
 * `store` resolves against disk `eapi.conf` files here, where the browser entry has no filesystem to
 * fall back to. Nothing has been sent yet: a `Node` is connected on the first `await`.
 *
 * ```ts
 * import { createNode } from '@devhax-heavy-industries/arista-eapi/node'
 *
 * const direct = createNode({ kind: 'session', host: 'sw1.lan', username: 'ui', password: pw })
 * const withEnable = createNode({ kind: 'https', host: 'sw1.lan', username: 'ui', password: pw, enablePassword: 'en' })
 * const fromConf = createNode({ profileName: 'lab', store: loadProfileStore({ warn: true }) })
 * ```
 */
export function createNode(options: NodeFactoryOptions): Node {
  return nodeFromOptions(options, createNodeTransport, 'node')
}

/** The transport alone over the same bag — pyeapi's `connect()` without `return_node` (`client.py:452-461`). */
export function createConnection(options: NodeFactoryOptions): Transport {
  return connectionFromOptions(options, createNodeTransport, 'node')
}

/**
 * pyeapi `connect_to(name)` (`client.py:1040-1067`): `eapi.conf` lookup by name, on the Node side
 * where the file exists. `overrides`/`store`/`conf` in {@link NodeProfileOptions} are how a caller
 * keeps that deterministic — pass `conf: { paths: [...] }` or `conf: { fs: fakeFs, ... }` and no real
 * home directory is read (the unit suite does exactly that; nothing here touches a disk on its own).
 *
 * An unknown name throws {@link profileNotFound}'s `NotSupportedError`, listing the profiles that *do*
 * exist — pyeapi raises a bare `AttributeError('connection profile not found in config')`.
 */
export function createNodeFor(name: string, options: NodeProfileOptions = {}): Node {
  return nodeFromProfileStore(profileConnectionOptions(name, options), createNodeTransport, 'node')
}

/** The transport for that same profile name, with no command layer over it. */
export function createConnectionFor(name: string, options: NodeProfileOptions = {}): Transport {
  return connectionFromProfileStore(profileConnectionOptions(name, options), createNodeTransport, 'node')
}
