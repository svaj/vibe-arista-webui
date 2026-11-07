import { act, render, renderHook, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  RouteLink,
  Router,
  hrefFor,
  navigate,
  pathFromHash,
  resolveRoutePath,
  toRoutePath,
  useHashRoute,
} from './router'
import type { RouteRegistry } from './router'

const routes: RouteRegistry = {
  '/vlans': { element: <p>vlan screen</p>, title: 'VLAN assignment' },
  '/interfaces': { element: <p>interface screen</p>, title: 'Interface status' },
}

function renderRouter(homePath = '/vlans') {
  return render(<Router homePath={homePath} routes={routes} />)
}

function setHash(hash: string) {
  window.location.hash = hash
}

beforeEach(() => {
  setHash('')
})

afterEach(() => {
  setHash('')
})

describe('hash path helpers', () => {
  it('reads a route path out of a hash', () => {
    expect(pathFromHash('#/vlans')).toBe('/vlans')
    expect(pathFromHash('#/interfaces/')).toBe('/interfaces')
    expect(pathFromHash('#/vlans?sort=name')).toBe('/vlans')
  })

  it('treats an empty hash and in-page fragments as "not a route"', () => {
    expect(pathFromHash('')).toBeUndefined()
    expect(pathFromHash('#')).toBeUndefined()
    expect(pathFromHash('#workspace')).toBeUndefined()
  })

  it('normalises registry keys and navigate targets to one shape', () => {
    expect(toRoutePath('vlans')).toBe('/vlans')
    expect(toRoutePath('/vlans/')).toBe('/vlans')
    expect(hrefFor('vlans')).toBe('#/vlans')
  })

  it('resolves an empty hash to the home route', () => {
    expect(resolveRoutePath('', '/vlans')).toBe('/vlans')
    expect(resolveRoutePath('/interfaces', '/vlans')).toBe('/interfaces')
  })
})

describe('useHashRoute', () => {
  it('reads the deep-linked path on first render', () => {
    setHash('#/interfaces')
    const { result } = renderHook(() => useHashRoute())
    expect(result.current).toBe('/interfaces')
  })

  it('follows navigate() and later hash changes', async () => {
    const { result } = renderHook(() => useHashRoute())
    expect(result.current).toBe('')

    act(() => navigate('/interfaces'))
    expect(result.current).toBe('/interfaces')
    expect(window.location.hash).toBe('#/interfaces')

    // jsdom, like a browser, delivers `hashchange` on a later task.
    await act(async () => {
      setHash('#/vlans')
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(result.current).toBe('/vlans')
  })

  it('leaves the last route in place when the hash becomes an in-page fragment', () => {
    setHash('#/vlans')
    const { result } = renderHook(() => useHashRoute())
    expect(result.current).toBe('/vlans')

    act(() => setHash('#workspace'))
    expect(result.current).toBe('/vlans')
  })
})

describe('Router', () => {
  it('renders the route named by the hash on first load', () => {
    setHash('#/interfaces')
    renderRouter()

    expect(screen.getByText('interface screen')).toBeInTheDocument()
    expect(screen.queryByText('vlan screen')).not.toBeInTheDocument()
  })

  it('redirects an empty hash to the home route', async () => {
    renderRouter()

    expect(screen.getByText('vlan screen')).toBeInTheDocument()
    await waitForHash('#/vlans')
  })

  it('switches screens when navigate() changes the hash', () => {
    setHash('#/vlans')
    renderRouter()

    act(() => navigate('/interfaces'))

    expect(screen.getByText('interface screen')).toBeInTheDocument()
    expect(screen.queryByText('vlan screen')).not.toBeInTheDocument()
  })

  it('re-renders on a hashchange it did not cause, such as back/forward', async () => {
    setHash('#/vlans')
    renderRouter()

    setHash('#/interfaces')
    expect(await screen.findByText('interface screen')).toBeInTheDocument()
  })

  it('shows a fallback view with a link home for an unknown hash', async () => {
    setHash('#/nope')
    renderRouter()

    expect(screen.getByRole('heading', { name: 'No screen is registered for /nope' })).toBeInTheDocument()
    expect(screen.queryByText('vlan screen')).not.toBeInTheDocument()
    expect(screen.getByText('#/nope')).toBeInTheDocument()

    await userEvent.setup().click(screen.getByRole('link', { name: 'Back to /vlans' }))

    expect(screen.getByText('vlan screen')).toBeInTheDocument()
    expect(window.location.hash).toBe('#/vlans')
  })

  it('keeps the current screen mounted when a skip-link fragment lands in the hash', async () => {
    setHash('#/vlans')
    renderRouter()

    await act(async () => {
      setHash('#workspace')
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(window.location.hash).toBe('#workspace')
    expect(screen.getByText('vlan screen')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /No screen is registered/u })).not.toBeInTheDocument()
  })

  it('keeps document.title in sync with the active route', () => {
    setHash('#/interfaces')
    renderRouter()
    expect(document.title).toBe('Interface status · EOS Control')

    act(() => navigate('/nope'))
    expect(document.title).toBe('/nope · not found · EOS Control')
  })
})

describe('RouteLink', () => {
  it('renders a real anchor whose click routes', async () => {
    const user = userEvent.setup()
    setHash('#/vlans')
    renderRouter()
    render(<RouteLink to="/interfaces">Interfaces</RouteLink>)

    const link = screen.getByRole('link', { name: 'Interfaces' })
    expect(link).toHaveAttribute('href', '#/interfaces')

    await user.click(link)

    expect(window.location.hash).toBe('#/interfaces')
    expect(screen.getByText('interface screen')).toBeInTheDocument()
  })

  it('is keyboard operable', async () => {
    const user = userEvent.setup()
    setHash('#/vlans')
    renderRouter()
    render(<RouteLink to="/interfaces">Interfaces</RouteLink>)

    screen.getByRole('link', { name: 'Interfaces' }).focus()
    await user.keyboard('{Enter}')

    expect(screen.getByText('interface screen')).toBeInTheDocument()
  })
})

/** jsdom delivers `hashchange` on a later task, so wait for the location to settle. */
async function waitForHash(hash: string) {
  await act(async () => {
    await Promise.resolve()
  })
  expect(window.location.hash).toBe(hash)
}
