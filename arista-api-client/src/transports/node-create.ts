/**
 * `createTransport` for the `./node` entry — M2 (#4). Completes pyeapi's `TRANSPORTS` map
 * (`client.py:112-121`) so that **every** upstream transport has a TS equivalent, with an exhaustive
 * switch over {@link TransportKind} exactly like the browser factory (PLAN M2: "compile error when a
 * kind is unimplemented").
 *
 * Which sender a kind gets is an entry-point decision, not a kind decision: `https` is
 * `FetchTransport` in the browser and `TlsTransport` (`node:https`) in Node whenever the caller
 * supplied any DR-013 trust option, because undici gives no handle on the peer certificate and
 * fingerprint pinning cannot be expressed there. `kind` stays `'https'` either way
 * (MIGRATION.md §5 row 28), so a profile that says `transport = https` works from both entries.
 *
 * Node-only file: it is the reason `node:net`/`node:tls`/`node:fs` are reachable at all, and they must
 * never be reachable from `src/index.ts` (DR-002, enforced by `src/browser-safety.test.ts` + the Vite
 * build guard).
 */

import { assertTransportKindsExhaustive, type Transport, type TransportOptions } from './contract'
import { assertOptionKeys, mockKindRefusal, wantsNodeTls } from './create'
import { FetchTransport, HttpTransport } from './fetch'
import { ClientCertTransport } from './node-client-cert'
import { SessionCookieTransport } from './node-cookie'
import { HttpLocalTransport } from './node-http-local'
import { TlsTransport } from './node-https'
import { UnixSocketTransport } from './node-unix'

/** Node's factory: the browser kinds delegate, the Node-only kinds construct, everything else is a compile error. */
export function createNodeTransport(options: TransportOptions): Transport {
  switch (options.kind) {
    case 'https':
      assertOptionKeys('https', options, 'node')
      return wantsNodeTls(options) ? new TlsTransport(options) : new FetchTransport(options)
    case 'http':
      assertOptionKeys('http', options, 'node')
      return new HttpTransport(options)
    case 'session':
      assertOptionKeys('session', options, 'node')
      return new SessionCookieTransport(options)
    case 'https-client-cert':
      assertOptionKeys('https-client-cert', options, 'node')
      return new ClientCertTransport(options)
    case 'unix':
      assertOptionKeys('unix', options, 'node')
      return new UnixSocketTransport(options)
    case 'http-local':
      assertOptionKeys('http-local', options, 'node')
      return new HttpLocalTransport(options)
    case 'mock':
      return mockKindRefusal()
    default:
      return assertTransportKindsExhaustive(options)
  }
}
