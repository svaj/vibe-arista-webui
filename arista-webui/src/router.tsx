import { useEffect, useSyncExternalStore } from 'react'
import type { MouseEvent, ReactElement, ReactNode } from 'react'

/**
 * F1 hand-rolled hash router (issue #63) — deliberately dependency-free.
 *
 * The address bar is the only source of truth: `location.hash` names the active route, `hashchange`
 * drives re-render, and every navigation affordance is a real anchor (`<a href="#/vlans">`) so tabs,
 * middle-click, back/forward, and screen readers keep working. Route paths always start with `/`; that
 * marker is what lets an in-page fragment (the `#workspace` skip link) coexist with routing instead of
 * being mistaken for an unknown screen.
 */

/** One entry of the route registry: the title the document gets plus the element to mount. */
export type RouteView = { readonly title: string; readonly element: ReactElement }

/** Registry keyed by route path (`/vlans`), rendered in insertion order. */
export type RouteRegistry = Readonly<Record<string, RouteView>>

/** The route/address marker. A hash without it is an in-page fragment, not a route. */
const ROUTE_MARKER = '/'

const trimTrailingSlash = (path: string): string => (path.length > 1 ? path.replace(/\/+$/u, '') : path)

/** `/vlans` or `vlans` -> `/vlans`. Registry keys, links, and `navigate()` all agree on this shape. */
export function toRoutePath(path: string): string {
  const trimmed = path.trim()
  return trimTrailingSlash(trimmed.startsWith(ROUTE_MARKER) ? trimmed : `${ROUTE_MARKER}${trimmed}`)
}

/**
 * `#/vlans` and `#/vlans?x=1` -> `/vlans`; `` , `#`, and `#workspace` -> `undefined`.
 *
 * `undefined` means "this hash does not name a route", which callers use to leave the current screen
 * mounted: following a skip link must not swap the workspace for a not-found view.
 */
export function pathFromHash(hash: string): string | undefined {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  const [beforeQuery = ''] = raw.split('?')
  const [path = ''] = beforeQuery.split('#')
  if (!path.startsWith(ROUTE_MARKER)) return undefined
  return trimTrailingSlash(path)
}

/** An empty hash means "the home route", so links, the outlet, and the address bar can be reconciled. */
export function resolveRoutePath(hashPath: string, homePath: string): string {
  return hashPath === '' ? toRoutePath(homePath) : hashPath
}

/** Registry lookup that never trusts an unguarded index read. */
export function findRoute(routes: RouteRegistry, path: string): RouteView | undefined {
  return Object.hasOwn(routes, path) ? routes[path] : undefined
}

/** `#/vlans` — the href form used by every navigation affordance. */
export function hrefFor(to: string): string {
  return `#${toRoutePath(to)}`
}

const hashChangeListeners = new Set<() => void>()
let watchingLocation = false

function notifyHashListeners(): void {
  for (const listener of [...hashChangeListeners]) listener()
}

function subscribeToHashChanges(listener: () => void): () => void {
  hashChangeListeners.add(listener)
  if (!watchingLocation) {
    window.addEventListener('hashchange', notifyHashListeners)
    watchingLocation = true
  }
  return () => {
    hashChangeListeners.delete(listener)
    if (hashChangeListeners.size === 0 && watchingLocation) {
      window.removeEventListener('hashchange', notifyHashListeners)
      watchingLocation = false
    }
  }
}

/**
 * Route named by the location, cached so the snapshot stays referentially stable between notifications.
 * A hash that is not route-shaped — an in-page fragment such as the `#workspace` skip link — leaves the
 * remembered path untouched, so following a skip link never swaps the workspace for a fallback view.
 * An empty or bare `#` hash clears it, which the Router resolves to the home route.
 */
let rememberedRoutePath = ''

function readRouteSnapshot(): string {
  const hash = window.location.hash
  const candidate = pathFromHash(hash)
  if (candidate !== undefined) rememberedRoutePath = candidate
  else if (hash === '' || hash === '#') rememberedRoutePath = ''
  return rememberedRoutePath
}

/**
 * Path named by the current hash; `''` means the hash is empty (and therefore the home route) or that
 * nothing route-shaped has been seen yet, e.g. the first load of `example.com/#workspace`.
 */
export function useHashRoute(): string {
  return useSyncExternalStore(subscribeToHashChanges, readRouteSnapshot)
}

/** Programmatic navigation. The anchor path below and browser back/forward both land here too. */
export function navigate(to: string): void {
  const target = toRoutePath(to)
  const href = hrefFor(target)
  if (window.location.hash !== href) window.location.hash = href
  // `hashchange` is delivered asynchronously by the browser (and by jsdom), so notify in the same
  // tick as well. Listeners converge on the same snapshot, and an unchanged string is a React no-op.
  notifyHashListeners()
}

const isPlainLeftClick = (event: MouseEvent<HTMLAnchorElement>): boolean =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey

/**
 * Anchor props for in-app navigation. Modifiers are left to the browser on purpose so
 * "open in a new tab" and "save link as" still behave; a plain click routes.
 */
export function hashLinkProps(to: string): {
  readonly href: string
  readonly onClick: (event: MouseEvent<HTMLAnchorElement>) => void
} {
  return {
    href: hrefFor(to),
    onClick: (event) => {
      if (!isPlainLeftClick(event)) return
      event.preventDefault()
      navigate(to)
    },
  }
}

/** Anchor-driven navigation link — never a div with a click handler. */
export function RouteLink({ to, className, children }: { readonly to: string; readonly className?: string; readonly children: ReactNode }): ReactElement {
  return <a {...hashLinkProps(to)} className={className}>{children}</a>
}

/** Unknown-hash fallback view with a way back to the registered home screen. */
export function UnknownRouteView({ path, homePath }: { readonly path: string; readonly homePath: string }): ReactElement {
  return <section className="route-fallback" aria-labelledby="route-fallback-title">
    <p className="eyebrow">UNKNOWN ADDRESS</p>
    <h2 id="route-fallback-title">No screen is registered for {path}</h2>
    <p className="notice notice-warning">The address <code>{hrefFor(path)}</code> does not match a route in this workspace.</p>
    <RouteLink className="route-fallback-home" to={homePath}>Back to {toRoutePath(homePath)}</RouteLink>
  </section>
}

/**
 * Resolves the current hash against `routes`, redirecting an empty hash to `homePath`, keeping the
 * document title in sync, and falling back to {@link UnknownRouteView} for unregistered paths.
 */
export function Router({ routes, homePath }: { readonly routes: RouteRegistry; readonly homePath: string }): ReactElement {
  const hashPath = useHashRoute()
  const path = resolveRoutePath(hashPath, homePath)
  const route = findRoute(routes, path)

  useEffect(() => {
    if (hashPath === path) return
    navigate(path)
  }, [hashPath, path])

  useEffect(() => {
    document.title = route === undefined ? `${path} · not found · EOS Control` : `${route.title} · EOS Control`
  }, [path, route])

  if (route === undefined) return <UnknownRouteView path={path} homePath={homePath} />
  return route.element
}
