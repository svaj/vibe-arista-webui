/**
 * F3 (#65) presentation primitive: the connection cluster on the right of the top bar, extracted
 * from `src/features/SwitchManager.tsx` (`<div className="connection-state">…` with the
 * `.status-dot` plus label text plus the optional `.device-identity` chip).
 *
 * It is a *cluster*, not the whole bar: F1's `AppShell` (#63) owns `<header className="topbar">`
 * and the brand lockup, and renders this inside it. It takes an **already-read** identity and never
 * fetches — the soft-failure contract from SwitchManager stays a container concern: a failed
 * `show version` means the container simply omits `identity`, which yields no chip and no alert, so
 * the workspace remains intact.
 *
 * The status colour never carries the meaning alone (WCAG 1.4.1): the dot is decorative and the
 * same state is spelled out as adjacent text. Label text defaults to SwitchManager's current copy
 * so F6 can swap this in without changing a visible string; screens behind a different transport
 * can override them.
 */
import type { DeviceIdentity } from '../../shared/identity'

export type ConnectionState = 'connected' | 'connecting' | 'error'

export interface ConnectionHeaderProps {
  /** Device reachability as decided by the container; this component reads nothing. */
  readonly state: ConnectionState
  /** Present only when `show version` succeeded — see the soft-failure contract above. */
  readonly identity?: DeviceIdentity
  /** Override for `state === 'connected'`. */
  readonly connectedLabel?: string
  /** Override for `state === 'connecting'`. */
  readonly connectingLabel?: string
  /** Override for `state === 'error'`. */
  readonly errorLabel?: string
}

export function ConnectionHeader({ state, identity, connectedLabel, connectingLabel, errorLabel }: ConnectionHeaderProps) {
  const label = state === 'connected'
    ? connectedLabel ?? 'Connected through local proxy'
    : state === 'error'
      ? errorLabel ?? 'Connection failed'
      : connectingLabel ?? 'Connecting through local proxy'

  return <div className="connection-state">
    {/* The dot is decorative by itself, so it is hidden from AT; the adjacent label text is the message. */}
    <span className={`status-dot ${state === 'error' ? 'is-error' : state === 'connecting' ? 'is-pending' : ''}`} aria-hidden="true" />
    {label}
    {identity !== undefined && <span className="device-identity">{identity.hostname} · EOS {identity.version} · {identity.model}</span>}
  </div>
}
