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
 * Still ahead: `eapi.conf` profiles and the `createNode`/`createConnection` factories M3 (#5 /
 * DR-038) and the live/recorded suite M12 (#14). Shipped since the milestone that planned them: the
 * command layer (M4, #6) in `src/command-layer.ts`, the config-text engine (M6, #8) in `src/config/`,
 * and M5's (#7) config sessions (`src/config-session.ts`) whose **on-disk recovery journal lives
 * only here** (DR-002/DR-022): `FileSessionJournal` at `SESSION_JOURNAL_PATH`, which no module reachable
 * from `src/index.ts` may import — `src/browser-safety.test.ts` and `vite.config.ts` both fail if one
 * ever does. The command layer (M4, #6) is shipped, so this file adds only the Node-only kinds on top of
 * it — which is where a `Node` over `kind: 'session'` or `kind: 'unix'` can be built.
 *
 * Requires Node >= 20 (`engines`) because `fetch` must be global.
 */

import { createNodeTransport } from './transports/node-create'
import type { NodeOptions } from './index'
import type { Transport, TransportOptions } from './transports/contract'

export type { NodeOptions }

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

/**
 * The M5 (#7) recovery journal, Node only (DR-002/DR-022): `~/.config/arista-eapi/sessions.json`
 * (XDG-aware, DR-047's path) holds the name/endpoint/start-time of every session this profile opened, so
 * `node.recoverOrphans({ journal })` can still identify an orphan after the process that made it died.
 * Pass one to `node.configSession({ journal })`; a browser passes
 * `createWebStorageJournal(window.localStorage)` from the `.` entry instead. Never contains a password
 * (DR-011 — the writer re-serialises from an allow-list and refuses secret key names).
 */
export {
  defaultSessionJournal,
  FileSessionJournal,
  SESSION_JOURNAL_DIR_NAME,
  SESSION_JOURNAL_FILE_NAME,
  SESSION_JOURNAL_PATH,
  sessionJournalPath,
} from './node-session-journal'
export type { SessionJournalPathOptions } from './node-session-journal'

/** The browser-safe surface, so `./node` is a strict superset of `.` (one import per app is enough). */
export * from './index'

/**
 * M0 placeholder (#2), still a placeholder after M4 (#6): the *connection/profile* bag this factory
 * will take (and `eapi.conf` lookup) is M3 (#5). The command layer it returns is real now — M4 (#6)
 * shipped `Node` in `src/command-layer.ts`, which `export * from './index'` re-exports here, so a
 * Node-runtime caller can build one over any of the kinds only this entry can construct:
 *
 * ```ts
 * import { createTransport, Node } from '@devhax-heavy-industries/arista-eapi/node'
 *
 * const node = new Node(createTransport({ kind: 'session', host, username, password }))
 * const { versionNumber, modelName } = await node.getVersion()
 * ```
 *
 * Kept deliberately separate from `src/index.ts` so the two entry points stay independently
 * buildable and the browser bundle can never absorb Node built-ins.
 */
export function createNode(options: NodeOptions = {}): never {
  throw new Error(
    `@devhax-heavy-industries/arista-eapi/node: createNode() is an M0 placeholder (#2) and has ` +
      `no implementation yet — Node transports landed in M2 (#4), the command layer landed in ` +
      `M4 (#6), and connection/profile options land in M3 (#5). Construct a transport with ` +
      `createTransport({ kind, … }) and pass it to new Node(transport, settings). ` +
      `Received options: ${JSON.stringify(options)}`,
  )
}
