/**
 * F6 (#68) composition pin: the app renders **one** chrome tier around the routed screen.
 *
 * Before the split, `AppShell`'s outlet held a screen that opened its own `<main class="shell">` —
 * a second skip link, a second brand topbar, a second connection strip — while App separately fed
 * `AppShell` a static status slot asserting a connection no device read had confirmed. The
 * assertions below are the mechanical proof that duplication is gone. The screen's own behaviours
 * are pinned where the screen lives: `src/features/vlans/VlanAssignment.test.tsx` (the ten cases
 * moved from this file by rename only).
 *
 * `__EAPI_PROXY_CONFIGURED__` is defined `false` for the test project (`vitest.config.ts`), so `App`
 * builds no client at all: the unconfigured path still has to render full chrome plus the proxy
 * prompt, and it must contact nothing.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import App from './App'

describe('App composition (F6 chrome)', () => {
  it('renders one skip link, one topbar and one workspace target', () => {
    render(<App />)

    expect(document.querySelectorAll('.skip-link')).toHaveLength(1)
    expect(document.querySelectorAll('header.topbar')).toHaveLength(1)
    // The screen used to wrap itself in `<main class="shell">` inside the outlet: there is no second
    // shell element now, and the outlet keeps the single `#workspace` the skip link targets.
    expect(document.querySelectorAll('main')).toHaveLength(0)
    expect(document.querySelectorAll('[id="workspace"]')).toHaveLength(1)
    expect(document.querySelector('.shell-outlet')).toHaveAttribute('id', 'workspace')
    expect(document.querySelector('.skip-link')).toHaveAttribute('href', '#workspace')
  })

  it('routes the empty hash to the VLAN screen and marks it current in the nav', () => {
    render(<App />)

    expect(screen.getByRole('heading', { level: 2, name: 'VLAN assignment' })).toBeInTheDocument()
    const navLink = screen.getByRole('link', { name: 'VLAN assignment' })
    expect(navLink).toHaveAttribute('aria-current', 'page')
    expect(document.querySelector('.shell-brand')).toHaveTextContent('Switch workspace')
  })

  it('unconfigured proxy: chrome plus the proxy prompt, no device contact, no identity chip', async () => {
    render(<App />)

    expect(await screen.findByRole('alert')).toHaveTextContent('EAPI_HOST')
    expect(document.querySelector('.device-identity')).toBeNull()
    expect(document.querySelectorAll('.skip-link')).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 2, name: 'VLAN assignment' })).toBeInTheDocument()
  })

  it('puts the S2 (#72) VLAN-management screen in the nav without stealing the home state', () => {
    render(<App />)

    const manage = screen.getByRole('link', { name: 'VLAN management' })
    expect(manage).toHaveAttribute('href', '#/vlans/manage')
    expect(manage).not.toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'VLAN assignment' })).toHaveAttribute('aria-current', 'page')
  })

  it('puts the S5 (#75) Port-Channel manager in the nav on #/lags', () => {
    render(<App />)

    const lags = screen.getByRole('link', { name: 'Port-Channels' })
    expect(lags).toHaveAttribute('href', '#/lags')
    expect(lags).not.toHaveAttribute('aria-current', 'page')
  })

  it('puts the S6 (#76) IP addressing screen in the nav on #/addressing', () => {
    render(<App />)

    const addressing = screen.getByRole('link', { name: 'IP addressing' })
    expect(addressing).toHaveAttribute('href', '#/addressing')
    expect(addressing).not.toHaveAttribute('aria-current', 'page')
    // With no proxy the screen idles on the prompt: registering the route must not warm anything up.
    fireEvent.click(addressing)
    expect(screen.getByRole('heading', { level: 2, name: 'IP addressing' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Preview and read the diff' })).toBeDisabled()
  })

  it('puts the S9 (#79) transaction center in the nav on #/sessions', () => {
    render(<App />)

    const sessions = screen.getByRole('link', { name: 'Sessions' })
    expect(sessions).toHaveAttribute('href', '#/sessions')
    expect(sessions).not.toHaveAttribute('aria-current', 'page')
    fireEvent.click(sessions)
    expect(screen.getByRole('heading', { level: 2, name: 'Transaction center' })).toBeInTheDocument()
    // Unconfigured: every device verb idles disabled; the LOCAL journal button is still offered
    // (reading localStorage contacts nothing).
    expect(screen.getByRole('button', { name: 'Open named session, stage, read diff' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Run orphan recovery' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Read local journal' })).toBeEnabled()
  })

  it('puts the S8 (#78) system settings screen in the nav on #/system', () => {
    render(<App />)

    const system = screen.getByRole('link', { name: 'System settings' })
    expect(system).toHaveAttribute('href', '#/system')
    expect(system).not.toHaveAttribute('aria-current', 'page')
    // Unconfigured: the route registers, the screen prompts, and no read is attempted — visiting
    // `#/system` must not open a session or fire a show.
    fireEvent.click(system)
    expect(screen.getByRole('heading', { level: 2, name: 'System settings' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Update hostname' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Disable ip routing' })).toBeDisabled()
  })

  it('puts the S7 (#77) capability probe panel in the nav on #/capabilities', () => {
    render(<App />)

    const caps = screen.getByRole('link', { name: 'Capabilities' })
    expect(caps).toHaveAttribute('href', '#/capabilities')
    expect(caps).not.toHaveAttribute('aria-current', 'page')
    // Unconfigured: reachable, prompted, and — matching the #123 contract this screen is built on —
    // mounting it opens no config session even if a node WERE present. With no proxy the buttons idle.
    fireEvent.click(caps)
    expect(screen.getByRole('heading', { level: 2, name: 'Capability probe panel' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run capability probe' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add question set' })).toBeDisabled()
  })

  it('puts the S4 (#74) read-only command console in the nav on #/console', () => {
    render(<App />)

    const consoleLink = screen.getByRole('link', { name: 'Command console' })
    expect(consoleLink).toHaveAttribute('href', '#/console')
    expect(consoleLink).not.toHaveAttribute('aria-current', 'page')
    // The unconfigured console is reachable and idles on the proxy prompt — navigating to it must not
    // contact anything, which is the same `node === undefined` arm every other screen proves for itself.
    fireEvent.click(consoleLink)
    expect(screen.getByRole('heading', { level: 2, name: 'Read-only command console' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run command' })).toBeDisabled()
  })
})
