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
 * Still ahead: `eapi.conf` profiles M3 (#5 / DR-038), the `Node` command layer M4 (#6), the on-disk
 * config-session journal M5 (#7 / DR-022), and the live/recorded suite M12 (#14).
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

/** The browser-safe surface, so `./node` is a strict superset of `.` (one import per app is enough). */
export * from './index'

/**
 * M0 placeholder (#2) — Node sibling of the browser entry's `createNode`.
 *
 * Always throws; the command layer lands in M4 (#6). Kept deliberately separate from `src/index.ts`
 * so the two entry points stay independently buildable and the browser bundle can never absorb Node
 * built-ins.
 */
export function createNode(options: NodeOptions = {}): never {
  throw new Error(
    `@devhax-heavy-industries/arista-eapi/node: createNode() is an M0 placeholder (#2) and has ` +
      `no implementation yet — Node transports land in M2 (#4), the command layer in M4 (#6). ` +
      `Received options: ${JSON.stringify(options)}`,
  )
}
