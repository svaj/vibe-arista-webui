/**
 * The switch-local opt-in gate — M2 (#4), DR-008 + DR-014.
 *
 * On 4.28.13.1M the unix socket (`/var/run/command-api.sock`) and the loopback listener
 * (`127.0.0.1:8080`, plain HTTP only) are configured with `DISABLE_AAA 1`
 * (`HttpServicePlugin/Capi.py:83-124`): **no authentication, privilege 15**. pyeapi not only allows
 * them, it injects a `connection:localhost` → socket profile into every configuration at import time
 * (`client.py:214-221`), so a script that never mentioned a transport silently ends up talking to
 * whatever local listener happens to exist.
 *
 * Therefore: the kind must be *stated*, the opt-in flag must be a literal `true` (a compile-time
 * requirement in `LocalTrustGate`), and the consequence is printed once per process. Browser builds
 * never get here at all — `createTransport` in the browser entry refuses those kinds (DR-002).
 */

import { NotSupportedError } from '../errors'
import { warnOnce } from '../internal/warn'
import { isLoopbackHost } from './endpoint'

/** `allowLocalUnauthenticated` is required; anything else is a refusal, with the reason spelled out. */
export function assertLocalOptIn(kind: 'unix' | 'http-local', address: string, optIn: unknown): void {
  if (optIn !== true) {
    throw new NotSupportedError(
      `refusing to build the '${kind}' transport for ${address}: EOS marks switch-local eAPI listeners DISABLE_AAA, so whatever can open that socket or reach 127.0.0.1 is priv-15 on the switch. Pass allowLocalUnauthenticated: true to accept that out loud (DR-008/DR-014).`,
    )
  }
  warnOnce(
    `local-unauthenticated-${kind}`,
    `the '${kind}' transport at ${address} is unauthenticated priv-15 eAPI on the switch itself (DISABLE_AAA on 4.28). Run it only on the switch, never on a host that exposes that listener (DR-014).`,
  )
}

/** Credentials are meaningless on a DISABLE_AAA listener; accepting them silently would be a lie. */
export function assertNoCredentials(kind: 'unix' | 'http-local', credentials: { username?: string | undefined; password?: string | undefined }): void {
  if (credentials.username !== undefined || credentials.password !== undefined) {
    throw new NotSupportedError(
      `the '${kind}' transport takes no username/password: the switch-local eAPI listener is unauthenticated (DISABLE_AAA), so the credentials would be ignored rather than honoured (DR-014)`,
    )
  }
}

/**
 * One gate for every cleartext endpoint — `kind: 'http'` (pyeapi `http`) and the cookie transport's
 * `http_session` form (pyeapi `http_session`), which is worse still because the `/login` POST carries
 * the password in a body rather than a header.
 *
 * Loopback is allowed quietly-ish (it is the switch's own listener, DR-014, and cannot be reached
 * remotely by definition), but printed once; anything else needs `allowInsecureTransport: true`
 * (DR-008/DR-013). pyeapi has no equivalent check anywhere in `eapilib.py`.
 */
export function assertCleartextAllowed(host: string, port: number, address: string, allowInsecure: unknown): void {
  if (isLoopbackHost(host)) {
    warnOnce(
      'http-loopback',
      `http eAPI at ${address} is the switch-local listener and is cleartext: it belongs on the switch itself, never across a network (DR-014).`,
    )
    return
  }
  if (allowInsecure === true) {
    warnOnce(
      'insecure-transport',
      `allowInsecureTransport: eAPI credentials are going over cleartext http to ${host}:${String(port)} — anyone on the path can read them (DR-013).`,
    )
    return
  }
  throw new NotSupportedError(
    `refusing to speak cleartext http to ${address}: use an https endpoint, or set allowInsecureTransport when cleartext really is intended. Loopback (127.0.0.0/8, ::1, localhost) is allowed without the flag because that is the switch's own listener (DR-008).`,
  )
}
