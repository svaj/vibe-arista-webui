/**
 * `UnixSocketTransport` — pyeapi `socket` / `SocketEapiConnection` + `SocketConnection`
 * (`eapilib.py:170-186`, `:696-701`), M2 (#4). Node-only (DR-002) and gated (DR-008/DR-014).
 *
 * The socket is the eAPI listener EOS serves to itself at `/var/run/command-api.sock`
 * (`DEFAULT_UNIX_SOCKET`, `eapilib.py:66`); there is no node runtime in the EOS rootfs, so this is for
 * a process on the switch — which is exactly why it prints the DR-014 warning: that listener is
 * `DISABLE_AAA`, i.e. unauthenticated privilege 15.
 *
 * Wire shape kept from pyeapi: an ordinary cleartext HTTP `POST /command-api` over the socket, with
 * `Host: localhost` (`SocketConnection` calls `HTTPConnection.__init__(self, 'localhost')` and then
 * swaps in an `AF_UNIX` socket). Node's `socketPath` option does the same swap.
 */

import { TransportBase, idPolicyFrom, type TransportKernel } from './base'
import { DEFAULT_UNIX_PATH, type UnixTransportOptions } from './contract'
import { normalizePath, type ResolvedEndpoint } from './endpoint'
import { createNodeSender } from './node-http'
import { assertLocalOptIn, assertNoCredentials } from './local'

/** `unix:/var/run/command-api.sock`, matching pyeapi's `SocketConnection.__str__` (`eapilib.py:181`). */
export function unixAddress(socketPath: string): string {
  return `unix:${socketPath}`
}

function unixEndpoint(socketPath: string, requestPath = '/command-api'): ResolvedEndpoint {
  const path = normalizePath(requestPath)
  return {
    scheme: 'http',
    host: 'localhost',
    port: 0,
    path,
    url: new URL(`http://localhost${path}`),
    address: unixAddress(socketPath),
  }
}

export class UnixSocketTransport extends TransportBase {
  constructor(options: UnixTransportOptions) {
    super(unixKernel(options))
  }
}

function unixKernel(options: UnixTransportOptions): TransportKernel {
  const socketPath = options.socketPath ?? DEFAULT_UNIX_PATH
  // Both gates run before anything is opened: the local listener is unauthenticated priv-15
  // (DR-008/DR-014), and handing it credentials would be a silently ignored option.
  assertNoCredentials('unix', options)
  assertLocalOptIn('unix', unixAddress(socketPath), options.allowLocalUnauthenticated)
  const endpoint = unixEndpoint(socketPath)
  return {
    kind: 'unix',
    address: endpoint.address,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.trace === undefined ? {} : { trace: options.trace }),
    ids: idPolicyFrom(options),
    send: createNodeSender({ endpoint, credentials: {}, socketPath }),
  }
}
