/**
 * The wire contract of the **runtime eAPI relay** (#140a) — one pure, browser-safe module shared
 * by both sides: the browser code below (`relay.ts`, the `#/connect` screen) and the dev-server
 * plugin (`../../eapi-relay.ts`, Node side). Everything that decides *whether a connect request is
 * well-formed* lives here, once, so "the client refuses it" and "the server refuses it" are the
 * same sentence by construction — the same discipline as `shared/allowed-vlans.ts` (DR-053),
 * which refuses pre-wire with the client's own rule text rather than a second guess of the device's.
 *
 * ## What the relay is (owner decision C on #140, 2026-11-17 — "build A now")
 * Today the device target + credentials exist only as `EAPI_HOST/EAPI_USER/EAPI_PASS` read at
 * Vite boot (`vite.config.ts`); `__EAPI_PROXY_CONFIGURED__` is baked from them and the screens are
 * gated on that build-time constant. The relay adds a *runtime* path: the connect screen POSTs
 * host/username/password to the loopback dev server, which keeps them **in process memory only**
 * and forwards `/command-api` to the chosen device exactly as the env-var proxy does (https,
 * `rejectUnauthorized: false` — the identical `secure: false` trust posture, DR-036's trade moved
 * from `.env.local` to a form field on the same machine). The browser never talks to the device
 * directly and the password never enters storage, URLs, or logs.
 *
 * ## What it is NOT
 * - Not a replacement for the env-var proxy: when env vars are configured the plugin answers
 *   `status → {configured:'env'}` and refuses every other route — the boot-time proxy stays
 *   authoritative and the whole lane (dev, e2e, CI) is byte-identical to today.
 * - Not the zero-install browser-direct mode (#140 option B): that needs the device itself to
 *   answer CORS preflight — an open evidence question (DR-013's trust limits) — and is filed as a
 *   separate follow-up. This slice's "relay" is the same-origin **dev server** only.
 */

/** The relay's dev-server endpoints. Distinct from the device path so neither shadows the other. */
export const RELAY_ENDPOINTS = Object.freeze({
  /** `GET` — `{configured: null | 'env' | 'runtime', host?, username?}`. Never returns a password. */
  status: '/__eapi/status',
  /** `POST application/json` — a {@link RelaySetupRequest}; installs (or replaces) the runtime target. */
  setup: '/__eapi/setup',
  /** `POST` — drops the runtime target; the same-origin `/command-api` path returns to inert. */
  disconnect: '/__eapi/disconnect',
  /** The eAPI path the screens already dial; the relay forwards it when a runtime target is installed. */
  commandApi: '/command-api',
} as const)

/**
 * The relay's own upstream wait: deliberately ABOVE the UI deadline (`UI_REQUEST_TIMEOUT_MS`,
 * #153) so the **client** deadline always wins the race and the operator sees the typed
 * timeout path ("timed out after 30000 ms") instead of a raw 502 from its own dev server.
 * The pin against drift is `relay-protocol.test.ts`.
 */
export const RELAY_UPSTREAM_TIMEOUT_MS = 35_000

/** Which mechanism (if any) currently supplies a `/command-api` target on this dev server. */
export type RelayConfiguredBy = 'env' | 'runtime' | null

export interface RelayStatus {
  readonly configured: RelayConfiguredBy
  /** Present only when `configured === 'runtime'` — the host[:port] currently dialed. */
  readonly host?: string
  /** Present only when `configured === 'runtime'`. The password is NOT part of any relay payload. */
  readonly username?: string
}

/** The only body `setup` accepts. Unknown keys are refused, not ignored (DR-016's allow-list shape). */
export interface RelaySetupRequest {
  readonly host: string
  readonly username: string
  readonly password: string
}

/** The parsed outcome of a valid host form: pieces the Node side needs to dial, nothing secret. */
export interface RelayTarget {
  /** Lowercased by `URL` normalization. */
  readonly hostname: string
  /** Numeric port after defaulting (443). */
  readonly port: number
  /** `https://hostname[:port]` — the exact value the status payload echoes. */
  readonly display: string
}

export type RelayHostValidation =
  | { readonly ok: true; readonly target: RelayTarget }
  | { readonly ok: false; readonly refusal: string }

/**
 * Validate a connect-form host the way `vite.config.ts`'s `createEapiProxy` validates `EAPI_HOST`
 * (that function stays the boot-time authority; this is its runtime twin, kept adjacent in meaning):
 * optional `https://` prefix, host or host:port ONLY — no credentials, path, query, fragment;
 * HTTPS-only; port digits within range. Returns the normalized dialing pieces so the server never
 * re-parses user text. This copy is browser-only text logic (`URL`), no node imports — which is
 * what lets the screens and the dev-server plugin enforce byte-identical rules from one source.
 */
export function validateRelayHost(raw: string): RelayHostValidation {
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: false, refusal: 'a device host is required' }
  // eslint-disable-next-line no-control-regex -- the control range IS the refusal condition here
  if (/[\u0000-\u001f\u007f]/u.test(trimmed)) return { ok: false, refusal: 'the host carries control characters' }
  let url: URL
  try {
    url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`)
  } catch {
    return { ok: false, refusal: `"${trimmed}" is not a parsable host` }
  }
  if (url.protocol !== 'https:') return { ok: false, refusal: 'the relay dials https only' }
  if (url.username !== '' || url.password !== '') return { ok: false, refusal: 'credentials belong in the form, not the host' }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return { ok: false, refusal: 'give host[:port] only — no path, query, or fragment' }
  const hostname = url.hostname
  if (hostname === '' ) return { ok: false, refusal: 'the host is empty' }
  // URL accepts odd spellings (double/trailing dots, leading dashes); the device LAN never needs
  // them. Bracketed IPv6 is WHATWG-validated by `URL` itself (bad groups throw at parse), and a
  // BARE IPv6 is ambiguous with a port — `URL` rejects it, so nothing here re-implements that.
  const hostnameWithoutBrackets = hostname.replace(/^\[(.*)\]$/u, '$1')
  const isIpv6 = hostnameWithoutBrackets.includes(':')
  if (!isIpv6 && (hostname.includes('..') || hostname.startsWith('.') || hostname.endsWith('.'))) {
    return { ok: false, refusal: `"${hostname}" is not a valid hostname` }
  }
  const HOSTNAME_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/iu
  if (!isIpv6 && !HOSTNAME_RE.test(hostname)) return { ok: false, refusal: `"${hostname}" is not a valid hostname` }
  const port = url.port === '' ? 443 : Number(url.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, refusal: 'the port must be 1-65535' }
  return {
    ok: true,
    target: { hostname, port, display: port === 443 ? `https://${hostname}` : `https://${hostname}:${String(port)}` },
  }
}

/** Username/password sanity the setup route enforces BEFORE touching the device (never logged). */
export function validateRelayCredentials(
  username: unknown,
  password: unknown,
): { readonly ok: true; readonly username: string; readonly password: string } | { readonly ok: false; readonly refusal: string } {
  // Control characters in a basic-auth pair are how a credential becomes a header-smuggling vector
  // or a log-injection one; the base64 layer would carry them silently, so refuse at the door.
  const badCredential = (value: unknown, label: string): string | undefined =>
    typeof value !== 'string' || value === '' || value.length > 256
      ? `${label} must be a string of 1-256 characters`
      // eslint-disable-next-line no-control-regex -- header/log-injection guard: control chars refuse
      : /[\u0000-\u001f\u007f]/u.test(value)
        ? `${label} carries control characters`
        : undefined
  const userIssue = badCredential(username, 'the username')
  if (userIssue !== undefined) return { ok: false, refusal: userIssue }
  const passIssue = badCredential(password, 'the password')
  if (passIssue !== undefined) return { ok: false, refusal: passIssue }
  return { ok: true, username: username as string, password: password as string }
}

/** A refusal the browser may show for a relay HTTP failure — built ONLY from status codes, never a response body that could echo credentials. */
export function relayFailureText(status: number): string {
  switch (status) {
    case 400: return 'the relay refused the request body (expected a host/username/password object)'
    case 405: return 'the relay only accepts POST for that endpoint'
    case 409: return 'the env-var proxy owns this server; the runtime relay is inert while it is configured'
    case 415: return 'the relay expects an application/json request'
    case 502: return 'the relay could not reach that device — check the host and try again'
    default: return `the relay answered HTTP ${String(status)}`
  }
}
