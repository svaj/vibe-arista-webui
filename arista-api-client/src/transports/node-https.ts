/**
 * `TlsTransport` — the Node `kind: 'https'` sender (M2 #4, DR-013).
 *
 * The browser entry's `https` is `FetchTransport`; the Node entry keeps **one implementation per kind**
 * and uses this one whenever the caller supplied any DR-013 trust option, because `fetch`/undici gives
 * no accessible handle on the peer certificate (so fingerprint pinning cannot be expressed there).
 * `createTransport` in `./node` picks between the two; the `kind` string stays `'https'` either way —
 * MIGRATION.md §5 row 28.
 *
 * pyeapi equivalent: `HttpsEapiConnection` (`eapilib.py:646-673`), minus `context=` and
 * `enforce_verification` (MIGRATION.md §7 — those knobs invert the default and expose Python SSL
 * internals) and, crucially, minus its habit of building an **unverified** SSL context by default.
 */

import { TransportBase } from './base'
import { DEFAULT_HTTPS_PORT, type HttpsTransportOptions } from './contract'
import { resolveEndpoint } from './endpoint'
import { createNodeKernel } from './node-http'

export class TlsTransport extends TransportBase {
  constructor(options: HttpsTransportOptions) {
    super(
      createNodeKernel({
        kind: 'https',
        endpoint: resolveEndpoint(options, { scheme: 'https', port: DEFAULT_HTTPS_PORT }),
        connection: options,
      }),
    )
  }
}
