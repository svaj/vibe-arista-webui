/**
 * `#/connect` — the runtime connect screen (#140a, owner's option C on #140: build the
 * loopback-relay mode now, browser-direct later). It configures the **dev-server relay**
 * (`../../eapi-relay.ts`), not the device directly: the browser POSTs host/username/password to
 * its own loopback origin, the dev server holds them in process memory, and every eAPI call keeps
 * flowing through the same `/command-api` path (and the same client + #153 timeout) the env-var
 * proxy uses. The app never stores the password anywhere — the hostbook (#140's
 * "remembers a user and host") keeps name/host/username ONLY.
 *
 * Honesty rules this screen lives by, same as every other screen in the lane:
 * - **No device claim before the probe.** Success requires `node.show('version')` to answer THROUGH
 *   the freshly installed relay; a setup that installs but cannot read shows exactly that, and the
 *   app stays un-configured until a real answer lands.
 * - **The password goes out once** (the setup body to the loopback origin) and comes back zero
 *   times: every failure string here is built from status codes (`relayFailureText`) or the
 *   client's own error text — never from a relay response body.
 * - **Env mode is never touched.** With `EAPI_HOST/EAPI_USER/EAPI_PASS` configured at boot the
 *   relay is inert (the server 409s and the screens keep boot truth); this screen says so plainly
 *   and renders no form, because offering a control whose effect the server refuses is its own
 *   kind of false UI.
 *
 * `panel`/`notice` class idiom mirrors the F3/F6 screens (StatePill/ConnectionHeader own the
 * connection cluster; this screen has no device read of its own beyond the one-shot probe).
 */
import { useState } from 'react'
import type { FormEvent } from 'react'

import { createAppNode } from '../../eapi/app-node'
import { errorMessage } from '../../shared/load-state'
import { navigate } from '../../router'
import {
  disconnectRelay,
  setupRelay,
  validateRelayCredentials,
  validateRelayHost,
} from '../../eapi/relay'
import type { RelayStatus } from '../../eapi/relay'
import {
  forgetHostbookEntry,
  loadHostbook,
  upsertHostbookEntry,
} from './hostbook'
import type { HostbookEntry, HostbookStorage } from './hostbook'

export interface ConnectProps {
  /** Live relay state from the app-boot probe (App owns the probe; this screen re-renders on flip). */
  readonly relayStatus: RelayStatus
  /** The build-time env-proxy flag — when true, the relay is inert and no form renders. */
  readonly envConfigured: boolean
  /** Called after setup AND a successful `show version` through the relay (App creates the node and adopts this live-target status). */
  readonly onConnected: (status: RelayStatus) => void
  /** Called after a confirmed disconnect: App drops the node so every screen returns to its prompt. */
  readonly onDisconnected: () => void
  /** Storage seam for tests / no-storage environments; defaults to `window.localStorage`. */
  readonly storage?: HostbookStorage
  /** Where a successful connect lands (App passes its `HOME_PATH`; `#/` alone is a NotFound path). */
  readonly homePath?: string
}

type Phase = 'editing' | 'connecting'

export function Connect({ relayStatus, envConfigured, onConnected, onDisconnected, storage, homePath = '/vlans' }: ConnectProps) {
  const bookStorage: HostbookStorage = storage ?? window.localStorage
  const [entries, setEntries] = useState<readonly HostbookEntry[]>(() => loadHostbook(bookStorage))
  const [name, setName] = useState('')
  const [host, setHost] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [phase, setPhase] = useState<Phase>('editing')
  const [error, setError] = useState<string | null>(null)

  const envAuthoritative = envConfigured || relayStatus.configured === 'env'
  const runtimeHost = relayStatus.configured === 'runtime' ? relayStatus.host : undefined

  const selectEntry = (entry: HostbookEntry): void => {
    setHost(entry.host)
    setUsername(entry.username)
    setName(entry.name === entry.host ? '' : entry.name)
    setError(null)
  }

  const forgetEntry = (entry: HostbookEntry): void => {
    setEntries(forgetHostbookEntry(bookStorage, entry.host, entry.username))
  }

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (phase === 'connecting') return
    // Client-side refusals first — the same functions the relay server runs, so a message shown
    // here is exactly what the wire would have said (shared/allowed-vlans.ts pattern).
    const hostCheck = validateRelayHost(host)
    if (!hostCheck.ok) {
      setError(`Not sent: ${hostCheck.refusal}.`)
      return
    }
    const credentialCheck = validateRelayCredentials(username, password)
    if (!credentialCheck.ok) {
      setError(`Not sent: ${credentialCheck.refusal}.`)
      return
    }
    setPhase('connecting')
    setError(null)
    const installed = await setupRelay({ host: hostCheck.target.display, username, password })
    if (!installed.ok) {
      setError(installed.message)
      setPhase('editing')
      return
    }
    // Install ≠ connect: prove the device answers THROUGH the relay before the app flips.
    const probe = createAppNode(window.location.origin)
    try {
      await probe.show('version')
    } catch (probeError: unknown) {
      setError(`The relay is installed, but the device did not answer: ${errorMessage(probeError)}`)
      setPhase('editing')
      return
    }
    setEntries(upsertHostbookEntry(bookStorage, { host: hostCheck.target.display, username, ...(name.trim() === '' ? {} : { name }) }))
    // The password ends its life here: state cleared before anything else can re-render with it.
    setPassword('')
    onConnected({ configured: 'runtime', host: hostCheck.target.display, username })
    navigate(homePath)
  }

  const disconnect = async (): Promise<void> => {
    if (await disconnectRelay()) {
      setPhase('editing')
      setError(null)
      onDisconnected()
    } else {
      setError('The dev server did not confirm the disconnect — is Vite still running?')
    }
  }

  if (envAuthoritative) {
    return <section className="panel" aria-labelledby="connect-env-title">
      <div className="panel-heading"><h2 id="connect-env-title">Connect</h2></div>
      <p className="notice">This dev server got its device target from <code>EAPI_HOST</code>,{' '}
        <code>EAPI_USER</code>, and <code>EAPI_PASS</code> at startup, so that proxy stays
        authoritative and the runtime relay below is inactive. To use the form instead, clear the
        three variables from <code>arista-webui/.env.local</code> and restart Vite.</p>
    </section>
  }

  return <section className="panel" aria-labelledby="connect-title">
    <div className="panel-heading"><h2 id="connect-title">Connect a device</h2></div>
    <p>Host and credentials go to <strong>this dev server only</strong> (loopback); it keeps them
      in memory and forwards eAPI calls to the switch over HTTPS. Nothing is written to disk and
      no device state is claimed until the switch itself answers.</p>

    {runtimeHost !== undefined && <p className="notice" role="status">Currently connected through
      the relay: <strong>{runtimeHost}</strong>{relayStatus.username !== undefined ? <> as {relayStatus.username}</> : null}.{' '}
      <button type="button" onClick={() => void disconnect()}>Disconnect</button></p>}

    {error !== null && <p className="notice notice-error" role="alert">{error}</p>}

    <form onSubmit={(event) => void submit(event)}>
      <div className="field">
        <label htmlFor="connect-name">Device label (optional)</label>
        <input id="connect-name" type="text" value={name} maxLength={120} autoComplete="off"
          onChange={(event) => setName(event.target.value)} placeholder="Office switch" />
      </div>
      <div className="field">
        <label htmlFor="connect-host">Device host</label>
        <input id="connect-host" type="text" value={host} required maxLength={255} autoComplete="off"
          onChange={(event) => setHost(event.target.value)} placeholder="switch1.lan or 192.168.1.10:443" />
      </div>
      <div className="field">
        <label htmlFor="connect-user">Username</label>
        <input id="connect-user" type="text" value={username} required maxLength={256} autoComplete="username"
          onChange={(event) => setUsername(event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="connect-pass">Password</label>
        {/* Deliberately NO autoComplete="new-password"/autofocus tricks that persist it elsewhere:
            memory-only is the contract; the browser must not build its own copy. */}
        <input id="connect-pass" type="password" value={password} required maxLength={256} autoComplete="off"
          onChange={(event) => setPassword(event.target.value)} />
      </div>
      <p><button type="submit" disabled={phase === 'connecting'}>{phase === 'connecting' ? 'Connecting…' : 'Connect'}</button></p>
    </form>

    {entries.length > 0 && <div className="hostbook" aria-labelledby="connect-book-title">
      <h3 id="connect-book-title">Previously connected</h3>
      <ul>
        {entries.map((entry) => <li key={`${entry.host}::${entry.username}`}>
          <button type="button" onClick={() => selectEntry(entry)}>{entry.name} · {entry.host} · {entry.username}</button>
          {' '}
          <button type="button" onClick={() => forgetEntry(entry)}>Forget</button>
        </li>)}
      </ul>
    </div>}
  </section>
}
