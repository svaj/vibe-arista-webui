/**
 * `createTransport` for the browser-safe entry — M2 (#4).
 *
 * PLAN's requirement is a factory with an **exhaustive switch**, so adding a `TransportKind` without
 * implementing it is a compile error rather than a runtime surprise. That is what
 * {@link assertTransportKindsExhaustive} in the `default` arm buys: the argument stops narrowing to
 * `never` the moment a kind loses its `case`.
 *
 * The same names carry a second, safer job at runtime. A browser build must not quietly accept
 * `ca`/`fingerprint`/`dangerouslyDisableTlsVerification` (DR-013) or build a unix socket
 * (DR-002/DR-014), and a JS caller — or an `eapi.conf` profile object handed over by M3 (#5) — has no
 * compile-time check at all. So every kind also runs its options through an allow-list, mirroring
 * `buildRequest`'s parameter allow-list from M1 (DR-016): an unknown option key is a
 * `NotSupportedError` naming the key, never an option that silently does nothing.
 */

import { NotSupportedError } from '../errors'
import {
  assertTransportKindsExhaustive,
  TLS_MATERIAL_KEYS,
  type NodeOnlyTransportKind,
  type Transport,
  type TransportOptions,
} from './contract'
import { FetchTransport, HttpTransport } from './fetch'

/** Option keys accepted per kind — the union over both entry points; the browser adds its own refusals. */
const OPTION_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  common: ['timeoutMs', 'nonce', 'seed', 'idStart', 'trace'],
  https: ['host', 'port', 'path', 'baseUrl', 'username', 'password'],
  http: ['host', 'port', 'path', 'baseUrl', 'username', 'password', 'allowInsecureTransport'],
  session: ['host', 'port', 'path', 'baseUrl', 'username', 'password', 'allowInsecureTransport'],
  'https-client-cert': ['host', 'port', 'path', 'baseUrl', 'username', 'password'],
  unix: ['socketPath', 'allowLocalUnauthenticated'],
  'http-local': ['port', 'path', 'allowLocalUnauthenticated'],
  mock: [],
})

/** Kinds whose Node-side option record carries {@link TLS_MATERIAL_KEYS}. */
const TLS_CAPABLE_KINDS: readonly string[] = ['https', 'session', 'https-client-cert']

/** Everything a browser-build kind must never be handed (DR-013 trust, DR-002/DR-014 local access). */
const NODE_ONLY_KEYS: readonly string[] = [...TLS_MATERIAL_KEYS, 'socketPath', 'allowLocalUnauthenticated']

export type TransportEntry = 'browser' | 'node'

/** Reject unknown (or entry-inappropriate) option keys, in the same tone as `buildRequest` (DR-016). */
export function assertOptionKeys(kind: string, options: object, entry: TransportEntry): void {
  const allowed = new Set<string>([...(OPTION_KEYS['common'] ?? []), ...(OPTION_KEYS[kind] ?? []), 'kind'])
  if (entry === 'node' && TLS_CAPABLE_KINDS.includes(kind)) {
    for (const key of TLS_MATERIAL_KEYS) allowed.add(key)
  }
  for (const key of Object.keys(options)) {
    if (allowed.has(key)) continue
    if (entry === 'browser' && NODE_ONLY_KEYS.includes(key)) {
      throw new NotSupportedError(
        `option '${key}' is not available for transport kind '${kind}' in the browser build: TLS trust is a Node-or-proxy concern (DR-013) — import createTransport from '@devhax-heavy-industries/arista-eapi/node' to set it`,
      )
    }
    throw new NotSupportedError(
      `unsupported option '${key}' for transport kind '${kind}': it accepts ${[...allowed].sort().join(', ')} (unknown options are refused rather than ignored, as with runCmds parameters — DR-016)`,
    )
  }
}

/** `createTransport` refuses to invent a mock: a test double has to be an explicit dependency. */
export function mockKindRefusal(): never {
  throw new NotSupportedError(
    "transport kind 'mock' is not built by createTransport: import { mockTransport } from the package's testing helpers (src/testing/mock-transport.ts), so production code cannot reach a scripted device by accident",
  )
}

/** The browser entry's refusal for a Node-only kind (ARCHITECTURE §5: local transports are absent there). */
export function nodeOnlyRefusal(kind: NodeOnlyTransportKind): never {
  throw new NotSupportedError(
    `transport kind '${kind}' is Node-only: import createTransport from '@devhax-heavy-industries/arista-eapi/node' (DR-002). The browser build has no unix sockets, no client certificates and no cookie jar (DR-013/DR-014/DR-018)`,
  )
}

/**
 * Keys whose presence means the caller wants Node's TLS-capable `https` sender rather than `fetch`
 * (row 28). This is {@link TLS_MATERIAL_KEYS} itself — one list, owned by `contract.ts`, because the
 * question "did the caller set DR-013 trust material?" has exactly one answer.
 */
export function wantsNodeTls(options: object): boolean {
  return TLS_MATERIAL_KEYS.some((key) => (options as Record<string, unknown>)[key] !== undefined)
}

/**
 * Browser-safe factory. `https`/`http` construct; every Node-only kind (and `mock`) refuses with a
 * message naming the import path that *would* work; the `default` arm is the compile-time guard.
 */
export function createTransport(options: TransportOptions): Transport {
  switch (options.kind) {
    case 'https':
      assertOptionKeys('https', options, 'browser')
      return new FetchTransport(options)
    case 'http':
      assertOptionKeys('http', options, 'browser')
      return new HttpTransport(options)
    case 'mock':
      return mockKindRefusal()
    case 'session':
    case 'https-client-cert':
    case 'unix':
    case 'http-local':
      return nodeOnlyRefusal(options.kind)
    default:
      return assertTransportKindsExhaustive(options)
  }
}
