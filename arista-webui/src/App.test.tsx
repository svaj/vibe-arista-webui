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
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

  it('puts the S10 (#80) static-route manager in the nav on #/routes/static', () => {
    render(<App />)

    const staticRoutes = screen.getByRole('link', { name: 'Static routes' })
    expect(staticRoutes).toHaveAttribute('href', '#/routes/static')
    expect(staticRoutes).not.toHaveAttribute('aria-current', 'page')
    // Registering the route must not warm anything up: with no proxy the screen prompts and the one
    // write trigger it offers (Preview, which opens the named session) stays disabled.
    fireEvent.click(staticRoutes)
    expect(screen.getByRole('heading', { level: 2, name: 'Static routes' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('EAPI_HOST')
    expect(screen.getByRole('button', { name: 'Preview and read the device diff' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Reload static routes' })).toBeDisabled()
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

  it('puts the S11 (#81) users and roles screen in the nav on #/users', () => {
    render(<App />)

    const users = screen.getByRole('link', { name: 'Users & roles' })
    expect(users).toHaveAttribute('href', '#/users')
    expect(users).not.toHaveAttribute('aria-current', 'page')
    // Unconfigured: the route registers and the screen prompts, but with no proxy the whole
    // self-lockout surface stays shut — no read, no session, and #81's standing banner is up even
    // before any device answer exists.
    fireEvent.click(users)
    expect(screen.getByRole('heading', { level: 2, name: 'Users & roles' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Preview and read the device diff' })).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent('EAPI_HOST')
    expect(screen.getByText(/Locking yourself out of a privilege-15 account/u)).toBeInTheDocument()
  })

  it('puts the S12 (#82) NTP screen in the nav on #/ntp', () => {
    render(<App />)

    const ntp = screen.getByRole('link', { name: 'NTP' })
    expect(ntp).toHaveAttribute('href', '#/ntp')
    expect(ntp).not.toHaveAttribute('aria-current', 'page')
    // Unconfigured: the route registers and the screen idles on the proxy prompt — visiting `#/ntp`
    // must not open a session or fire a show/version read.
    fireEvent.click(ntp)
    expect(screen.getByRole('heading', { level: 2, name: 'NTP' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add server' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Set source interface' })).toBeDisabled()
  })

  it('puts the S16 (#90) VRF manager in the nav on #/vrfs', () => {
    render(<App />)

    const vrfs = screen.getByRole('link', { name: 'VRF manager' })
    expect(vrfs).toHaveAttribute('href', '#/vrfs')
    expect(vrfs).not.toHaveAttribute('aria-current', 'page')
    // Unconfigured: the route registers and the screen idles on the proxy prompt — visiting
    // `#/vrfs` must not run the config reads or open a session.
    fireEvent.click(vrfs)
    expect(screen.getByRole('heading', { level: 2, name: 'VRF manager' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stage create VRF' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Reload device state' })).toBeDisabled()
  })

  it('puts the S13 (#83) ACL screen in the nav on #/acls', () => {
    render(<App />)

    const acls = screen.getByRole('link', { name: 'ACLs' })
    expect(acls).toHaveAttribute('href', '#/acls')
    expect(acls).not.toHaveAttribute('aria-current', 'page')
    // Unconfigured: the route registers and the screen idles on the proxy prompt — visiting `#/acls`
    // must not run a config read or open a session.
    fireEvent.click(acls)
    expect(screen.getByRole('heading', { level: 2, name: 'ACLs' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create ACL' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Reload device state' })).toBeDisabled()
  })

  it('puts the S14 (#84) read-only MLAG status screen in the nav on #/mlag', () => {
    render(<App />)

    const mlag = screen.getByRole('link', { name: 'MLAG' })
    expect(mlag).toHaveAttribute('href', '#/mlag')
    expect(mlag).not.toHaveAttribute('aria-current', 'page')
    // Unconfigured: the route registers and the screen idles on the proxy prompt — visiting it
    // fires no read, and the standing read-only banner is up before any device answer exists.
    fireEvent.click(mlag)
    expect(screen.getByRole('heading', { level: 2, name: 'MLAG' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reload MLAG state' })).toBeDisabled()
    expect(screen.getByText(/configuration editing is not offered here/u)).toBeInTheDocument()
  })

  it('puts the S15 (#85) spanning-tree screen in the nav on #/stp', () => {
    render(<App />)

    const stp = screen.getByRole('link', { name: 'Spanning tree' })
    expect(stp).toHaveAttribute('href', '#/stp')
    expect(stp).not.toHaveAttribute('aria-current', 'page')
    // Unconfigured: the route registers and the screen idles on the proxy prompt — visiting `#/stp`
    // must not open a session or read anything. And #85's standing boundary holds on the DOM itself:
    // no global-mode control exists anywhere on the screen (mode change is blocked B3 #88).
    fireEvent.click(stp)
    expect(screen.getByRole('heading', { level: 2, name: 'Spanning tree' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Preview change' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Reload spanning-tree state' })).toBeDisabled()
    expect(screen.queryAllByRole('button', { name: /mode/iu })).toHaveLength(0)
    expect(screen.getByRole('alert')).toHaveTextContent('EAPI_HOST')
  })

  // ---- #140a: runtime-connect composition (dev server WITHOUT the env proxy). These render the
  // real App with the probe seam stubbed; nothing here dials a device.
  afterEach(() => {
    vi.unstubAllGlobals()
    window.location.hash = ''
  })

  it('#140a: the Connect nav entry lands on the relay form when env vars are absent', () => {
    window.location.hash = '#/vlans'
    render(<App />)

    const connect = screen.getByRole('link', { name: 'Connect' })
    expect(connect).toHaveAttribute('href', '#/connect')
    fireEvent.click(connect)
    expect(screen.getByRole('heading', { level: 2, name: 'Connect a device' })).toBeInTheDocument()
    // No boot-probe contact is faked here: the honest empty state is still form + prose, no claims.
    expect(screen.queryByText(/Connected/u)).toBeNull()
  })

  it('#140a: when the boot probe reports a live runtime relay, screens leave the proxy prompt', async () => {
    window.location.hash = '#/vlans'
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.includes('/__eapi/status')) {
        return { ok: true, status: 200, json: async () => ({ configured: 'runtime', host: 'https://sw1.lan', username: 'admin' }) } as unknown as Response
      }
      // The screens' device reads then ride the relay path; a 502 keeps them on an honest ERROR,
      // which is what distinguishes "configured + unreachable" from "not configured".
      return { ok: false, status: 502, statusText: 'Bad Gateway', text: async () => '' } as unknown as Response
    }))
    render(<App />)

    await waitFor(() => expect(screen.queryByText(/proxy is not configured/u)).toBeNull())
    expect(await screen.findByRole('alert')).toHaveTextContent('502')
    expect(screen.queryByText(/Connected through/u)).toBeNull()
  })

  it('#140a: connect through the real screen flips the running app, and disconnect returns to the prompt', async () => {
    window.location.hash = '#/connect'
    const versionReply = { version: '4.28.13.1M', modelName: 'DCS-7050TX-64-R', hostname: 'lab-switch' }
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: { body?: string }) => {
      const url = String(input)
      if (url.includes('/__eapi/setup')) {
        return { ok: true, status: 200, json: async () => ({ configured: 'runtime', host: 'https://relayed.lan', username: 'admin' }) } as unknown as Response
      }
      if (url.includes('/__eapi/disconnect')) {
        return { ok: true, status: 200, json: async () => ({ configured: null }) } as unknown as Response
      }
      if (url.includes('/command-api')) {
        // The client sends `["enable", "show version"]` and pops the enable reply — the envelope
        // must carry one result per command, with the id echoed (what real eAPI always does).
        const request = JSON.parse(String(init?.body ?? '{}')) as { id?: string | number }
        const cmds = (JSON.parse(String(init?.body ?? '{}')) as { params?: { cmds?: unknown[] } }).params?.cmds ?? []
        const result = cmds.map((cmd: unknown) => (cmd === 'show version' ? versionReply : {}))
        return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: request.id ?? '1', result }) } as unknown as Response
      }
      return { ok: true, status: 200, json: async () => ({ configured: null }) } as unknown as Response
    }))
    render(<App />)

    fireEvent.change(screen.getByLabelText('Device host'), { target: { value: 'relayed.lan' } })
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'admin' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'never-sent' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    // Connected => the app left the connect screen (navigate home) and home NO LONGER says
    // "not configured"; its reads now flow (the stub answers every command with the version
    // reply, so screens land on parse-shaped states — either way, not the proxy prompt).
    await waitFor(() => expect(screen.queryByText(/Local proxy is not configured/u)).toBeNull())
    // The routed home screen mounts (its own read may still be in flight or on an error arm — the
    // point is the PROXY gate opened, which the screen's chrome proves).
    expect(await screen.findByRole('heading', { level: 2, name: 'VLAN assignment' })).toBeInTheDocument()

    // Disconnect from the (now runtime) connect screen: back to the honest prompt app-wide.
    fireEvent.click(screen.getByRole('link', { name: 'Connect' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }))
    // The connect screen itself has no prompt (it's the form); a real SCREEN must show it again.
    fireEvent.click(screen.getByRole('link', { name: 'VLAN assignment' }))
    expect(await screen.findByText(/Local proxy is not configured/u)).toBeInTheDocument()
  })
})
