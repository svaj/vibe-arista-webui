/**
 * Browser-side calls for the runtime relay (#140a) — thin fetch wrappers over the same-origin
 * dev-server endpoints defined in `relay-protocol.ts`. Kept separate from the screen so the
 * endpoint paths, the JSON discipline, and the "status/network failure never throws at a
 * component" behavior are testable directly.
 *
 * None of these touch the device: they speak to the dev server on `window.location.origin`
 * (loopback by the Vite config). Device traffic keeps flowing through the eAPI client via
 * `/command-api` — including the #153 `UI_REQUEST_TIMEOUT_MS` deadline and the client's typed
 * error taxonomy. That split is the whole point: the relay is plumbing, not a second transport.
 */
import {
  RELAY_ENDPOINTS,
  relayFailureText,
  type RelaySetupRequest,
  type RelayStatus,
} from './relay-protocol'

export { RELAY_ENDPOINTS, relayFailureText, validateRelayCredentials, validateRelayHost } from './relay-protocol'
export type { RelayStatus, RelaySetupRequest } from './relay-protocol'

/** Per-request cap for the control endpoints: loopback, tiny bodies — a hang here is a dead server. */
const CONTROL_TIMEOUT_MS = 5_000

async function relayFetch(path: string, init?: { method?: string; body?: string; headers?: Record<string, string> }): Promise<Response> {
  // `AbortSignal.timeout` is absent in jsdom (and older engines): degrade to unbounded there rather
  // than throw — the callers treat a dead server as null/failure, so an environment without the
  // timer loses the bound, never the correctness.
  const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(CONTROL_TIMEOUT_MS) : undefined
  return await fetch(path, signal === undefined ? init : { ...init, signal })
}

/**
 * `GET /__eapi/status` — the app-boot probe. **Never throws**: a missing endpoint (no plugin —
 * e.g. a static build with no dev server), a network failure, or a malformed body all answer
 * `{configured: null}`, which leaves the app in exactly today's honest "not configured" state.
 */
export async function fetchRelayStatus(): Promise<RelayStatus> {
  try {
    const response = await relayFetch(RELAY_ENDPOINTS.status)
    if (!response.ok) return { configured: null }
    const parsed: unknown = await response.json()
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { configured: null }
    const record = parsed as Record<string, unknown>
    const configured = record['configured']
    if (configured !== 'env' && configured !== 'runtime') return { configured: null }
    const host = typeof record['host'] === 'string' ? record['host'] : undefined
    const username = typeof record['username'] === 'string' ? record['username'] : undefined
    return configured === 'runtime' ? { configured, ...(host !== undefined ? { host } : {}), ...(username !== undefined ? { username } : {}) } : { configured }
  } catch {
    return { configured: null }
  }
}

export type RelaySetupOutcome = { readonly ok: true; readonly status: RelayStatus } | { readonly ok: false; readonly message: string }

/**
 * `POST /__eapi/setup` — installs the runtime target. The password leaves this page exactly once
 * (this body, to the loopback origin) and is never written to storage or rendered; every failure
 * path is built from `relayFailureText` (status codes only), so a hostile/echoing server body
 * cannot smuggle the credential back into the DOM.
 */
export async function setupRelay(request: RelaySetupRequest): Promise<RelaySetupOutcome> {
  try {
    const response = await relayFetch(RELAY_ENDPOINTS.setup, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: request.host, username: request.username, password: request.password }),
    })
    if (!response.ok) return { ok: false, message: relayFailureText(response.status) }
    const parsed: unknown = await response.json().catch(() => null)
    const record = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
    const host = typeof record['host'] === 'string' ? record['host'] : request.host
    return { ok: true, status: { configured: 'runtime', host } }
  } catch {
    return { ok: false, message: 'the local dev server did not answer — is Vite still running?' }
  }
}

/** `POST /__eapi/disconnect` — drop the runtime target; success is idempotent either way. */
export async function disconnectRelay(): Promise<boolean> {
  try {
    const response = await relayFetch(RELAY_ENDPOINTS.disconnect, { method: 'POST' })
    return response.ok
  } catch {
    return false
  }
}
