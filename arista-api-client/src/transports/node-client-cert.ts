/**
 * `ClientCertTransport` — pyeapi `https_certs` (`HTTPSCertConnection` + `HttpsEapiCertConnection`,
 * `eapilib.py:212-273`, `:675-712`), M2 (#4). Node-only: a browser cannot present a client
 * certificate to a cross-origin request.
 *
 * Behaviour kept from `HTTPSCertConnection.connect()`:
 *  - client `cert` + `key` are mandatory (pyeapi raises `ValueError` in the connection constructor —
 *    here a `TypeError` at construction time, because "you gave me half an mTLS identity" is a
 *    programming mistake, not a device condition: MIGRATION.md §5 row 25);
 *  - with a `ca`, the **server** certificate is verified;
 *  - without a `ca`, it is **not** verified — pyeapi's behaviour, kept deliberately (some deployments
 *    run mTLS with an unverified server side), but now shouted about once per process, because DR-013
 *    exists precisely to make that hole visible.
 *
 * Node-only file.
 */

import { TransportBase, idPolicyFrom } from './base'
import { DEFAULT_HTTPS_PORT, type ClientCertTransportOptions } from './contract'
import { resolveEndpoint, type ResolvedEndpoint } from './endpoint'
import { createNodeSender } from './node-http'
import { resolveTlsConnect } from './node-tls'

/** Never print key material: a path stays a path, inline PEM is described, never echoed. */
function describeMaterial(value: string | undefined): string {
  if (value === undefined) return '<missing>'
  return value.includes('-----BEGIN') ? '<inline PEM>' : value
}

/**
 * pyeapi's `HTTPSCertConnection.__str__` is
 * `'https://host:port//command-api - <key_file>,<cert_file>'` (`eapilib.py:224-232`). The doubled
 * slash is an upstream formatting slip and is not reproduced; the key-then-cert order is.
 */
export function clientCertDescription(endpoint: ResolvedEndpoint, options: ClientCertTransportOptions): string {
  return `${endpoint.address} - ${describeMaterial(options.key)},${describeMaterial(options.cert)}`
}

export class ClientCertTransport extends TransportBase {
  constructor(options: ClientCertTransportOptions) {
    super(clientCertKernel(options))
  }
}

function clientCertKernel(options: ClientCertTransportOptions) {
  if (typeof options.cert !== 'string' || options.cert === '' || typeof options.key !== 'string' || options.key === '') {
    throw new TypeError(
      "for kind 'https-client-cert' both cert and key are required (pyeapi: \"both a key_file and cert_file are required\"), and a ca is recommended — without it the device certificate is not verified",
    )
  }
  const endpoint = resolveEndpoint(options, { scheme: 'https', port: DEFAULT_HTTPS_PORT })
  const tls = resolveTlsConnect(options, { scheme: endpoint.scheme, host: endpoint.host, port: endpoint.port }, 'off-without-ca')
  return {
    kind: 'https-client-cert' as const,
    address: endpoint.address,
    description: clientCertDescription(endpoint, options),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.trace === undefined ? {} : { trace: options.trace }),
    ids: idPolicyFrom(options),
    send: createNodeSender({ endpoint, credentials: options, tls }),
  }
}
