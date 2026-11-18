/**
 * `#/connect` behavior pins (#140a). Two contracts dominate: the app flips to configured ONLY
 * after a real device answer (setup success is not connection), and the password never survives
 * into storage or DOM beyond the single POST body. fetch is the relay seam; the probe client is
 * mocked at `createAppNode` so a "device" is one vi.fn.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { Connect } from './Connect'

const { showMock, createAppNodeMock } = vi.hoisted(() => ({
  showMock: vi.fn<() => Promise<unknown>>(async () => ({ hostname: 'sw1', version: '4.28.13.1M', modelName: 'DCS-7050TX-64-R' })),
  createAppNodeMock: vi.fn(() => ({ show: showMock })),
}))

vi.mock('../../eapi/app-node', () => ({ createAppNode: createAppNodeMock }))

// F8 credential convention: fake password values in scanned test sources are the documented
// placeholder (`never-sent`); the leak assertions below prove it never reaches storage or the DOM.
const FAKE_PASSWORD = 'never-sent'

type StorageStub = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void; dump(): Record<string, string> }
function storage(initial: Record<string, string> = {}): StorageStub {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value) },
    removeItem: (key) => { map.delete(key) },
    dump: () => Object.fromEntries(map),
  }
}

/** fetch stub routed by path, exactly like the real dev server. */
function stubRelay(opts: { setupStatus?: number; setupBody?: unknown; disconnectOk?: boolean } = {}): { calls: [string, RequestInit | undefined][] } {
  const calls: [string, RequestInit | undefined][] = []
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    calls.push([url, init])
    const status = url.includes('/status') ? 200 : url.includes('/setup') ? (opts.setupStatus ?? 200) : (opts.disconnectOk ?? true) ? 200 : 500
    const body = url.includes('/setup') ? (opts.setupBody ?? { configured: 'runtime', host: 'https://switch1.lan' }) : { configured: null }
    return { ok: status < 300, status, json: async () => body } as unknown as Response
  }))
  return { calls }
}

function renderConnect(props: Partial<Parameters<typeof Connect>[0]> = {}) {
  const onConnected = vi.fn()
  const onDisconnected = vi.fn()
  const storageStub = storage()
  const view = render(<Connect
    relayStatus={{ configured: null }}
    envConfigured={false}
    onConnected={onConnected}
    onDisconnected={onDisconnected}
    storage={storageStub}
    {...props}
  />)
  return { ...view, onConnected, onDisconnected, storageStub }
}

async function fillAndSubmit(host: string, username = 'admin', secret = FAKE_PASSWORD, label = ''): Promise<void> {
  fireEvent.change(screen.getByLabelText('Device host'), { target: { value: host } })
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: username } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: secret } })
  if (label !== '') fireEvent.change(screen.getByLabelText('Device label (optional)'), { target: { value: label } })
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
}

beforeEach(() => {
  vi.unstubAllGlobals()
  window.location.hash = ''
  showMock.mockClear()
  createAppNodeMock.mockClear()
})

describe('Connect — mode banners', () => {
  it('env-authoritative dev renders the refusal prose and NO form', () => {
    renderConnect({ envConfigured: true, relayStatus: { configured: 'env' } })
    expect(screen.getByText(/authoritative/u)).toBeInTheDocument()
    expect(screen.queryByLabelText('Device host')).toBeNull()
    expect(screen.queryByLabelText('Password')).toBeNull()
  })

  it('relay-answers-env alone (boot-flag false) still renders the inert banner', () => {
    renderConnect({ relayStatus: { configured: 'env' } })
    expect(screen.queryByLabelText('Device host')).toBeNull()
  })

  it('runtime mode shows the live host/username, a Disconnect control, AND the retarget form', async () => {
    const { onDisconnected, storageStub } = renderConnect({ relayStatus: { configured: 'runtime', host: 'https://sw-live.lan', username: 'admin' } })
    expect(screen.getByText('https://sw-live.lan')).toBeInTheDocument()
    expect(screen.getByLabelText('Device host')).toBeInTheDocument()
    stubRelay()
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    await waitFor(() => expect(onDisconnected).toHaveBeenCalledTimes(1))
    expect(storageStub.dump()).toEqual({})
  })
})

describe('Connect — submit path', () => {
  it('refuses a malformed host before any network call', async () => {
    const relay = stubRelay()
    const { onConnected } = renderConnect()
    await fillAndSubmit('http://switch1.lan')
    expect(await screen.findByRole('alert')).toHaveTextContent(/Not sent: the relay dials https only/u)
    expect(relay.calls).toHaveLength(0)
    expect(onConnected).not.toHaveBeenCalled()
  })

  it('refuses control-character credentials before the wire, without echoing them', async () => {
    const relay = stubRelay()
    renderConnect()
    await fillAndSubmit('switch1.lan', 'admin', `x\u0007y`)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/Not sent: the password carries control characters/u)
    expect(alert.textContent).not.toContain('\u0007')
    expect(relay.calls).toHaveLength(0)
  })

  it('success = setup POST, then a real show-version through the node, then flip + hostbook + navigate', async () => {
    const relay = stubRelay({ setupBody: { configured: 'runtime', host: 'https://switch1.lan' } })
    const { onConnected, storageStub } = renderConnect()
    window.location.hash = '#/connect'
    await fillAndSubmit('switch1.lan', 'admin', FAKE_PASSWORD, 'Office switch')
    // Success leaves the button disabled BY DESIGN (the screen navigates away); the flip callback
    // is the event to await. `Connecting…` staying on the button is the correct terminal render.
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1))

    expect(onConnected).toHaveBeenCalledTimes(1)
    expect(createAppNodeMock).toHaveBeenCalledWith(window.location.origin)
    expect(showMock).toHaveBeenCalledTimes(1)
    expect(window.location.hash, "navigates to the default homePath ('/vlans') once the device actually answered").toBe('#/vlans')

    const setupCall = relay.calls.find(([url]) => url.includes('/setup'))
    expect(setupCall).toBeDefined()
    const sent = JSON.parse(String(setupCall?.[1]?.body) as string) as Record<string, unknown>
    expect(sent).toEqual({ host: 'https://switch1.lan', username: 'admin', password: 'never-sent' })

    const bookRaw = storageStub.dump()['arista-webui.connect.hostbook.v1']
    expect(bookRaw).toContain('Office switch')
    expect(bookRaw, 'the password NEVER enters storage').not.toContain(FAKE_PASSWORD)
    // And it leaves the DOM: the controlled field was cleared after success.
    expect((screen.queryByLabelText('Password') as HTMLInputElement | null)?.value ?? '').toBe('')
  })

  it('relay refusal surfaces as status text, no flip, retry stays possible', async () => {
    const relay = stubRelay({ setupStatus: 502 })
    const { onConnected } = renderConnect()
    await fillAndSubmit('switch1.lan')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/could not reach that device/u)
    expect(onConnected).not.toHaveBeenCalled()
    expect(relay.calls.filter(([url]) => url.includes('/setup'))).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled()
  })

  it('installed-but-silent device: setup succeeded, probe failed — the app does NOT flip', async () => {
    stubRelay()
    showMock.mockRejectedValueOnce(new Error('eAPI request timed out after 30000 ms (DR-019)'))
    const { onConnected } = renderConnect()
    await fillAndSubmit('switch1.lan')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/relay is installed, but the device did not answer/u)
    expect(alert).toHaveTextContent(/timed out after 30000 ms/u)
    expect(onConnected).not.toHaveBeenCalled()
    expect(window.location.hash, 'stays on the connect screen').not.toBe('#/vlans')
  })
})

describe('Connect — hostbook interactions', () => {
  const seed = { 'arista-webui.connect.hostbook.v1': JSON.stringify([
    { name: 'Office switch', host: 'https://office.lan:8443', username: 'admin', addedAt: 50 },
    { name: 'rack2', host: 'rack2.lan', username: 'netops', addedAt: 40 },
  ]) }

  it('lists stored devices and selecting one prefills host/user while leaving the password empty', () => {
    renderConnect({ storage: storage(seed) })
    fireEvent.click(screen.getByRole('button', { name: /Office switch/u }))
    expect((screen.getByLabelText('Device host') as HTMLInputElement).value).toBe('https://office.lan:8443')
    expect((screen.getByLabelText('Username') as HTMLInputElement).value).toBe('admin')
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('')
  })

  it('Forget drops only that row from storage', () => {
    const storageStub = storage(seed)
    renderConnect({ storage: storageStub })
    fireEvent.click(screen.getAllByRole('button', { name: 'Forget' })[0] as HTMLElement)
    const left = JSON.parse(storageStub.dump()['arista-webui.connect.hostbook.v1'] ?? '[]') as { name: string }[]
    expect(left.map((entry) => entry.name)).toEqual(['rack2'])
  })
})
