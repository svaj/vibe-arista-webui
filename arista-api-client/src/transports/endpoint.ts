/**
 * Endpoint resolution — M2 (#4).
 *
 * pyeapi builds the request target from `host` / `port` / `path` and hard-codes `POST /command-api`
 * in `send()` (`eapilib.py:431`), so its `path` option is accepted and then ignored. We keep the
 * same defaults but **honour** `path`, and add `baseUrl` for the same-origin dev-proxy topology
 * (DR-036). Divergence recorded in MIGRATION.md §5 row 24.
 *
 * Browser-safe: no Node built-ins, only WHATWG `URL`.
 */

import type { EndpointOptions } from './contract'

export type EndpointScheme = 'http' | 'https'

export interface ResolvedEndpoint {
  readonly scheme: EndpointScheme
  readonly host: string
  readonly port: number
  readonly path: string
  /** Absolute URL to POST the JSON-RPC body to. */
  readonly url: URL
  /**
   * Secret-free display form with an **explicit** port, e.g. `https://sw1.lan:443/command-api`.
   * This is what transport errors quote and what the ported `test_create_*_connection` assertions
   * check. pyeapi's `__str__` renders the same shape with a stray `//` before the path
   * (`'http://%s:%s/%s' % (host, port, path)`) — cosmetic, not reproduced.
   */
  readonly address: string
}

/** `localhost`, the `127.0.0.0/8` block, and IPv6 loopback — the only hosts `http` may assume (DR-008). */
export function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase()
  if (value === 'localhost' || value === 'localhost.localdomain' || value === 'ip6-localhost' || value === '::1') {
    return true
  }
  // Bracketed IPv6 literal, with or without the zone id.
  const unbracketed = value.replace(/^\[(.*)\]$/, '$1')
  if (unbracketed !== value) {
    return unbracketed === '::1' || unbracketed.startsWith('::ffff:127.')
  }
  // IPv4 dotted quad inside 127/8. Deliberately strict: `127.1` is *not* accepted, because a host
  // string that only *looks* loopback should not silently pass the cleartext gate.
  const parts = value.split('.')
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part)) && parts[0] === '127'
}

/** Normalise a request path to a single leading slash, no doubled slashes. */
export function normalizePath(path: string, label = 'path'): string {
  if (path === '') return '/'
  if (!path.startsWith('/')) throw new TypeError(`${label} must start with '/': got ${JSON.stringify(path)}`)
  const collapsed = path.replace(/\/{2,}/g, '/')
  return collapsed.length > 1 ? collapsed.replace(/\/$/, '') : collapsed
}

function assertPort(port: number): number {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError(`port must be an integer in 0..65535, got ${String(port)}`)
  }
  return port
}

/**
 * Join a `baseUrl` path prefix with a request path. `new URL(path, base)` is *not* used for this,
 * because it replaces the base's path outright — the dev proxy lives under a prefix
 * (`http://127.0.0.1:5173/command-api` when Vite is told to forward it) and that prefix must survive.
 */
function joinPaths(prefix: string, path: string): string {
  const base = normalizePath(prefix, 'baseUrl path')
  if (base === '/') return path
  return `${base}${path === '/' ? '' : path}`
}

export interface ResolveEndpointDefaults {
  /** Scheme used when nothing in the options says otherwise. */
  readonly scheme: EndpointScheme
  /** Port used when neither `port` nor `baseUrl` supplies one. */
  readonly port: number
  /** Request path when `path` is omitted (default `/command-api`, pyeapi `DEFAULT_HTTP_PATH`). */
  readonly path?: string
  /** Host required? Local kinds resolve their own fixed host and set this `false`. */
  readonly requireHost?: boolean
}

/**
 * Resolve the pyeapi-style `host`/`port`/`path` trio, or the DR-036 `baseUrl`, into one endpoint.
 * `host` is required unless `baseUrl` carries it — pyeapi defaults `host` to `'localhost'`, which
 * DR-008 forbids us from inventing in the browser build, so an omitted host is an error here
 * (MIGRATION.md §5 row 8).
 */
export function resolveEndpoint(options: EndpointOptions, defaults: ResolveEndpointDefaults): ResolvedEndpoint {
  const requestPath = normalizePath(options.path ?? defaults.path ?? '/command-api')

  let scheme = defaults.scheme
  let host = options.host?.trim() ?? ''
  let port = options.port === undefined ? undefined : assertPort(options.port)
  let prefix = '/'

  if (options.baseUrl !== undefined) {
    let base: URL
    try {
      base = new URL(options.baseUrl)
    } catch {
      throw new TypeError(`baseUrl is not a valid absolute URL: ${JSON.stringify(options.baseUrl)}`)
    }
    if (base.protocol !== 'http:' && base.protocol !== 'https:') {
      throw new TypeError(`baseUrl must be http: or https:, got ${JSON.stringify(base.protocol)}`)
    }
    scheme = base.protocol === 'https:' ? 'https' : 'http'
    if (host === '') host = base.hostname
    if (port === undefined) port = base.port === '' ? schemePort(scheme) : Number(base.port)
    prefix = base.pathname
  }

  if (host === '') {
    throw new TypeError(
      'a transport needs an explicit host (or a baseUrl): this client never defaults to localhost ' +
        'outside the switch-local kinds (DR-008)',
    )
  }
  const resolvedPort = assertPort(port ?? defaults.port)
  const path = joinPaths(prefix, requestPath)
  const url = new URL(`${scheme}://${host}:${resolvedPort}${path}`)
  return {
    scheme,
    host,
    port: resolvedPort,
    path,
    url,
    address: `${scheme}://${host}:${resolvedPort}${path}`,
  }
}

function schemePort(scheme: EndpointScheme): number {
  return scheme === 'https' ? 443 : 80
}
