/**
 * `HttpLocalTransport` — pyeapi `http_local` / `HttpLocalEapiConnection` (`eapilib.py:703-709`),
 * M2 (#4). Node-only, gated, and **plain HTTP only**.
 *
 * DR-014 is the whole story here: 4.28.13.1M generates exactly one loopback listener, HTTP on 8080
 * (`SuperServerPlugin/HttpService.py:563-565`), and pyeapi's `DEFAULT_HTTPS_LOCAL_PORT = 8443`
 * (`eapilib.py:63`) matches nothing in this build — so there is deliberately **no** `httpsLocal`
 * kind, and this transport cannot be pointed at a TLS port. The constant is dropped
 * (MIGRATION.md §7). The listener is `DISABLE_AAA` → unauthenticated priv-15, so the DR-008 opt-in and
 * the DR-014 warning are mandatory, and credentials are refused rather than ignored.
 */

import { TransportBase, idPolicyFrom, type TransportKernel } from './base'
import { DEFAULT_HTTP_LOCAL_PORT, type HttpLocalTransportOptions } from './contract'
import { resolveEndpoint } from './endpoint'
import { assertLocalOptIn, assertNoCredentials } from './local'
import { createNodeSender } from './node-http'

/** Loopback, always. pyeapi uses the host name `localhost`; we use the literal address so the
 *  cleartext gate cannot be argued about (`127.0.0.1` cannot mean anything else). */
export const LOCAL_HOST = '127.0.0.1'

export class HttpLocalTransport extends TransportBase {
  constructor(options: HttpLocalTransportOptions) {
    super(localKernel(options))
  }
}

function localKernel(options: HttpLocalTransportOptions): TransportKernel {
  assertNoCredentials('http-local', options)
  const endpoint = resolveEndpoint(
    {
      host: LOCAL_HOST,
      ...(options.port === undefined ? {} : { port: options.port }),
      ...(options.path === undefined ? {} : { path: options.path }),
    },
    { scheme: 'http', port: DEFAULT_HTTP_LOCAL_PORT },
  )
  assertLocalOptIn('http-local', endpoint.address, options.allowLocalUnauthenticated)
  return {
    kind: 'http-local',
    address: endpoint.address,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.trace === undefined ? {} : { trace: options.trace }),
    ids: idPolicyFrom(options),
    send: createNodeSender({ endpoint, credentials: {} }),
  }
}
