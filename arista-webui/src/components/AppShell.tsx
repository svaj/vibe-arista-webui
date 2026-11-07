import type { ReactElement, ReactNode } from 'react'
import { Router, hashLinkProps, resolveRoutePath, useHashRoute } from '../router'
import type { RouteRegistry } from '../router'

/**
 * F1 application chrome (issue #63): skip link, brand/topbar with anchor-driven navigation, a
 * presentational connection-status slot, and the routed outlet.
 *
 * Nothing here contacts the device — `status` is supplied by the caller (issue #64 wires the real
 * connection state). Issue #66 (F6) later lifts the duplicate chrome out of `SwitchManager`; until then
 * the routed screen renders its own `main.shell` inside this outlet, so the interim UI shows two tiers.
 */

export type ConnectionStatusTone = 'ok' | 'warn' | 'error'

/** Presentational props for the status strip: text plus which dot colour to show. Never fetched here. */
export type ConnectionStatus = { readonly label: string; readonly detail?: string; readonly tone?: ConnectionStatusTone }

export type AppShellProps = {
  readonly routes: RouteRegistry
  readonly homePath: string
  readonly status?: ConnectionStatus
  readonly navLabel?: string
}

const toneClass = (tone: ConnectionStatusTone | undefined): string =>
  tone === undefined || tone === 'ok' ? 'status-dot' : `status-dot is-${tone === 'warn' ? 'pending' : 'error'}`

function StatusStrip({ status }: { readonly status: ConnectionStatus }): ReactElement {
  const detail: ReactNode = status.detail === undefined ? null : <span className="shell-status-detail">{status.detail}</span>
  return <p className="connection-state shell-status"><span className={toneClass(status.tone)} />{status.label}{detail}</p>
}

export function AppShell({ routes, homePath, status, navLabel = 'Switch workspace sections' }: AppShellProps): ReactElement {
  const current = resolveRoutePath(useHashRoute(), homePath)
  return <>
    <a className="skip-link" href="#workspace">Skip to switch workspace</a>
    <header className="topbar shell-header">
      <div className="brand-lockup">
        <span className="brand-mark" aria-hidden="true">E</span>
        <div>
          <p className="eyebrow">EOS CONTROL</p>
          <p className="shell-brand">Switch workspace</p>
        </div>
      </div>
      <nav className="shell-nav" aria-label={navLabel}>
        <ul className="shell-nav-list">
          {Object.entries(routes).map(([to, view]) => (
            <li key={to}>
              <a {...hashLinkProps(to)} className="shell-nav-link" aria-current={to === current ? 'page' : undefined}>{view.title}</a>
            </li>
          ))}
        </ul>
      </nav>
      {status === undefined ? null : <StatusStrip status={status} />}
    </header>
    <div className="shell-outlet" id="workspace">
      <Router homePath={homePath} routes={routes} />
    </div>
  </>
}
