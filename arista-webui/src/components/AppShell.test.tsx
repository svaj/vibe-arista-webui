import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AppShell } from './AppShell'
import type { RouteRegistry } from '../router'

const routes: RouteRegistry = {
  '/vlans': { element: <p>vlan screen</p>, title: 'VLAN assignment' },
  '/interfaces': { element: <p>interface screen</p>, title: 'Interface status' },
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

describe('AppShell navigation', () => {
  it('exposes a named navigation landmark with one hash anchor per route', () => {
    setHash('#/vlans')
    render(<AppShell homePath="/vlans" routes={routes} />)

    const nav = screen.getByRole('navigation', { name: 'Switch workspace sections' })
    const links = screen.getAllByRole('link', { name: /VLAN assignment|Interface status/u })
    expect(links).toHaveLength(2)
    expect(nav).toContainElement(links[0])
    expect(links[0]).toHaveAttribute('href', '#/vlans')
    expect(links[1]).toHaveAttribute('href', '#/interfaces')
  })

  it('accepts a custom landmark name', () => {
    render(<AppShell homePath="/vlans" navLabel="Screens" routes={routes} />)
    expect(screen.getByRole('navigation', { name: 'Screens' })).toBeInTheDocument()
  })

  it('marks the deep-linked route with aria-current', () => {
    setHash('#/interfaces')
    render(<AppShell homePath="/vlans" routes={routes} />)

    expect(screen.getByRole('link', { name: 'Interface status' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'VLAN assignment' })).not.toHaveAttribute('aria-current')
  })

  it('highlights the home route while an empty hash redirects to it', () => {
    render(<AppShell homePath="/vlans" routes={routes} />)
    expect(screen.getByRole('link', { name: 'VLAN assignment' })).toHaveAttribute('aria-current', 'page')
  })

  it('switches screens and moves aria-current when a nav link is clicked', async () => {
    const user = userEvent.setup()
    setHash('#/vlans')
    render(<AppShell homePath="/vlans" routes={routes} />)

    await user.click(screen.getByRole('link', { name: 'Interface status' }))

    expect(screen.getByText('interface screen')).toBeInTheDocument()
    expect(screen.queryByText('vlan screen')).not.toBeInTheDocument()
    expect(window.location.hash).toBe('#/interfaces')
    expect(screen.getByRole('link', { name: 'Interface status' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'VLAN assignment' })).not.toHaveAttribute('aria-current')
  })

  it('operates from the keyboard alone', async () => {
    const user = userEvent.setup()
    setHash('#/interfaces')
    render(<AppShell homePath="/vlans" routes={routes} status={{ label: 'Reading through the local proxy' }} />)

    await user.tab()
    expect(screen.getByRole('link', { name: 'Skip to switch workspace' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('link', { name: 'VLAN assignment' })).toHaveFocus()
    await user.keyboard('{Enter}')

    expect(screen.getByText('vlan screen')).toBeInTheDocument()
    expect(window.location.hash).toBe('#/vlans')

    await user.tab()
    expect(screen.getByRole('link', { name: 'Interface status' })).toHaveFocus()
    await user.keyboard('{Enter}')

    expect(screen.getByText('interface screen')).toBeInTheDocument()
  })
})

describe('AppShell chrome', () => {
  it('keeps the skip link aimed at the routed outlet', () => {
    setHash('#/vlans')
    const { container } = render(<AppShell homePath="/vlans" routes={routes} />)

    const skipLink = screen.getByRole('link', { name: 'Skip to switch workspace' })
    expect(skipLink).toHaveClass('skip-link')
    expect(skipLink).toHaveAttribute('href', '#workspace')
    const outlet = container.querySelector<HTMLElement>('#workspace')
    expect(outlet).not.toBeNull()
    expect(skipLink).not.toContainElement(outlet)
    expect(outlet).toContainElement(screen.getByText('vlan screen'))
  })

  it('renders the connection status strip from props, never a fetch', () => {
    setHash('#/vlans')
    render(<AppShell homePath="/vlans" routes={routes} status={{ detail: '/command-api', label: 'Reading through the local proxy', tone: 'ok' }} />)

    expect(screen.getByText('Reading through the local proxy')).toBeInTheDocument()
    expect(screen.getByText('/command-api')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'VLAN assignment' })).toBeInTheDocument()
  })
  it('shows a pending dot for a warning tone (#124: the arm the floored directory missed)', () => {
    setHash('#/vlans')
    const { container } = render(<AppShell homePath="/vlans" routes={routes} status={{ label: 'Some ports are not writable on this unit', tone: 'warn' }} />)

    expect(screen.getByText('Some ports are not writable on this unit')).toBeInTheDocument()
    expect(container.querySelector('.status-dot.is-pending')).not.toBeNull()
  })
  it('shows a pending dot for an unconfigured proxy', () => {
    setHash('#/vlans')
    const { container } = render(<AppShell homePath="/vlans" routes={routes} status={{ label: 'Local proxy is not configured', tone: 'error' }} />)

    expect(screen.getByText('Local proxy is not configured')).toBeInTheDocument()
    expect(container.querySelector('.status-dot.is-error')).not.toBeNull()
  })

  it('omits the status strip entirely when no status is supplied', () => {
    setHash('#/vlans')
    const { container } = render(<AppShell homePath="/vlans" routes={routes} />)

    expect(container.querySelector('.shell-status')).toBeNull()
  })

  it('exposes an accessible transaction link only while changes are staged', () => {
    setHash('#/vlans')
    const { rerender } = render(<AppShell homePath="/vlans" routes={routes} transaction={{ count: 0, status: 'idle' }} />)
    expect(screen.queryByRole('link', { name: /Open transaction/u })).not.toBeInTheDocument()

    rerender(<AppShell homePath="/vlans" routes={routes} transaction={{ count: 2, status: 'ready' }} />)
    const link = screen.getByRole('link', { name: 'Open transaction: 2 staged change(s), ready' })
    expect(link).toHaveAttribute('href', '#/sessions')
    expect(link).toHaveTextContent('2')
  })
})

describe('AppShell outlet routing', () => {
  it('renders the deep-linked screen first and then the navigated one', async () => {
    const user = userEvent.setup()
    setHash('#/interfaces')
    render(<AppShell homePath="/vlans" routes={routes} />)

    expect(screen.getByText('interface screen')).toBeInTheDocument()

    await user.click(screen.getByRole('link', { name: 'VLAN assignment' }))

    expect(screen.getByText('vlan screen')).toBeInTheDocument()
  })

  it('falls back to a not-found view with a way home for an unknown hash', async () => {
    const user = userEvent.setup()
    setHash('#/missing')
    render(<AppShell homePath="/vlans" routes={routes} />)

    const heading = await screen.findByRole('heading', { name: 'No screen is registered for /missing' })
    expect(heading).toBeInTheDocument()
    expect(screen.getByText('Switch workspace')).toBeInTheDocument()
    expect(screen.queryByText('vlan screen')).not.toBeInTheDocument()

    await user.click(screen.getByRole('link', { name: 'Back to /vlans' }))

    expect(screen.getByText('vlan screen')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'VLAN assignment' })).toHaveAttribute('aria-current', 'page')
  })

  it('leaves the workspace intact when the hash holds an in-page fragment', async () => {
    setHash('#/vlans')
    render(<AppShell homePath="/vlans" routes={routes} />)
    expect(screen.getByText('vlan screen')).toBeInTheDocument()

    // The shell's own skip link lands in the hash; that must not be read as an unknown route.
    await act(async () => {
      setHash('#workspace')
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(window.location.hash).toBe('#workspace')
    expect(screen.getByText('vlan screen')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /No screen is registered/u })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'VLAN assignment' })).toHaveAttribute('aria-current', 'page')
  })
})
