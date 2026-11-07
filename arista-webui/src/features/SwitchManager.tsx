import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { ConfigSession, ConfigSessionSummary, InterfaceStatus, Node, Switchport, Vlan } from '@devhax-heavy-industries/arista-eapi'

type Client = Pick<Node, 'vlans' | 'switchports' | 'interfaces' | 'configSession' | 'listSessions' | 'abortSession'>
type Session = Pick<ConfigSession, 'name' | 'state' | 'run' | 'diff' | 'hasDiffBeenRead' | 'commit' | 'abort'>
type Data = { vlans: readonly Vlan[]; ports: ReadonlyMap<string, Switchport>; statuses: ReadonlyMap<string, InterfaceStatus>; sessions: readonly ConfigSessionSummary[]; statusError?: string }
type LoadState = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; data: Data }
type Draft = { session: Session; diff?: string; commitAttempted: boolean }

const PHYSICAL_ETHERNET = /^Ethernet[0-9]+$/u
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)
const writableVlan = (vlan: Vlan) => Number.isInteger(vlan.id) && vlan.id >= 1 && vlan.id <= 4094

export function SwitchManager({ node, proxyConfigured = true }: { readonly node: Client | undefined; readonly proxyConfigured?: boolean }) {
  const [reloadKey, setReloadKey] = useState(0)
  const [load, setLoad] = useState<LoadState>(() => proxyConfigured && node !== undefined
    ? { kind: 'loading' }
    : { kind: 'error', message: 'Local proxy is not configured. Set EAPI_HOST, EAPI_USER, and EAPI_PASS in arista-webui/.env.local, then restart Vite.' })
  const [portChoice, setPortChoice] = useState('')
  const [vlanChoice, setVlanChoice] = useState('')
  const [draft, setDraft] = useState<Draft>()
  const [notice, setNotice] = useState('')
  const [failure, setFailure] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    if (!proxyConfigured || node === undefined) return () => { active = false }
    const statusResult = node.interfaces.getStatus()
      .then((statuses) => ({ statuses }))
      .catch((error: unknown) => ({ statusError: errorMessage(error) }))
    void Promise.all([node.vlans.getAll(), node.switchports.getAll(), node.listSessions(), statusResult])
      .then(([vlans, ports, sessions, status]) => {
        if (!active) return
        setLoad({
          kind: 'ready',
          data: {
            vlans: [...vlans.values()].sort((left, right) => left.id - right.id),
            ports,
            statuses: 'statuses' in status ? status.statuses : new Map(),
            sessions: sessions.sessions,
            ...('statusError' in status ? { statusError: status.statusError } : {}),
          },
        })
      })
      .catch((error: unknown) => { if (active) setLoad({ kind: 'error', message: errorMessage(error) }) })
    return () => { active = false }
  }, [node, proxyConfigured, reloadKey])

  const data = load.kind === 'ready' ? load.data : undefined
  const vlans = data?.vlans.filter(writableVlan) ?? []
  const ports = data === undefined ? [] : [...new Set([...data.statuses.keys(), ...data.ports.keys()])]
    .filter((name) => PHYSICAL_ETHERNET.test(name))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
  const selectedPort = ports.includes(portChoice) ? portChoice : (ports[0] ?? '')
  const selectedVlan = vlans.some((vlan) => String(vlan.id) === vlanChoice) ? vlanChoice : String(vlans[0]?.id ?? '')
  const currentPort = data?.ports.get(selectedPort)
  const draftOpen = draft !== undefined && (draft.session.state === 'open' || draft.session.state === 'diffed')

  function reload() {
    if (!proxyConfigured || node === undefined) return
    setLoad({ kind: 'loading' })
    setReloadKey((key) => key + 1)
  }

  async function preview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || node === undefined || selectedPort === '' || selectedVlan === '') return
    setFailure('')
    setNotice('Staging the change and reading the device diff…')
    setDraft(undefined)
    setBusy(true)
    try {
      const session = await node.configSession({ description: `webui access vlan ${selectedVlan} on ${selectedPort}` })
      const handle: Session = session
      setDraft({ session: handle, commitAttempted: false })
      await handle.run([`interface ${selectedPort}`, 'switchport mode access', `switchport access vlan ${selectedVlan}`])
      const diff = await handle.diff()
      setDraft({ session: handle, diff, commitAttempted: false })
      setNotice('Review the device diff before committing this change.')
    } catch (error) { setFailure(errorMessage(error)) }
    finally { setBusy(false) }
  }

  async function abortDraft() {
    if (busy || draft === undefined || !draftOpen || !window.confirm(`Abort staged changes in session ${draft.session.name}?`)) return
    setFailure('')
    setBusy(true)
    try {
      await draft.session.abort()
      setDraft(undefined)
      setNotice(`Session ${draft.session.name} was aborted.`)
      setLoad({ kind: 'loading' })
      setReloadKey((key) => key + 1)
    } catch (error) { setFailure(errorMessage(error)) }
    finally { setBusy(false) }
  }

  async function commitDraft() {
    if (busy || draft?.diff === undefined || !draft.session.hasDiffBeenRead() || draft.commitAttempted) return
    if (!window.confirm(`Commit session ${draft.session.name}? This changes running-config only.`)) return
    setDraft({ ...draft, commitAttempted: true })
    setFailure('')
    setNotice('Committing the reviewed change to running-config…')
    setBusy(true)
    try {
      await draft.session.commit()
      setDraft(undefined)
      setNotice('Changes committed to running-config. Startup-config was not changed.')
      setLoad({ kind: 'loading' })
      setReloadKey((key) => key + 1)
    } catch (error) { setFailure(`${errorMessage(error)} Commit was attempted; refresh device state before taking another action.`) }
    finally { setBusy(false) }
  }

  async function abortPending(session: ConfigSessionSummary) {
    if (busy || node === undefined || session.state !== 'pending' || !window.confirm(`Abort pending device session ${session.name}? Its staged changes will be discarded.`)) return
    setFailure('')
    setNotice('')
    setBusy(true)
    try {
      await node.abortSession(session.name)
      setNotice(`Pending session ${session.name} was aborted.`)
      setLoad({ kind: 'loading' })
      setReloadKey((key) => key + 1)
    } catch (error) { setFailure(errorMessage(error)) }
    finally { setBusy(false) }
  }

  return <main className="shell">
    <a className="skip-link" href="#workspace">Skip to switch workspace</a>
    <header className="topbar"><div className="brand-lockup"><span className="brand-mark" aria-hidden="true">E</span><div><p className="eyebrow">EOS CONTROL</p><h1>Switch workspace</h1></div></div><div className="connection-state"><span className={`status-dot ${load.kind === 'error' ? 'is-error' : load.kind === 'loading' ? 'is-pending' : ''}`} />{load.kind === 'ready' ? 'Connected through local proxy' : load.kind === 'error' ? 'Connection failed' : 'Connecting through local proxy'}</div></header>
    <section className="workspace" id="workspace" aria-labelledby="workspace-title">
      <div className="workspace-heading"><div><p className="eyebrow">CONFIGURATION</p><h2 id="workspace-title">VLAN assignment</h2></div><button className="quiet-button" type="button" onClick={reload} disabled={load.kind === 'loading' || busy || !proxyConfigured || node === undefined}>Refresh state</button></div>
      {load.kind === 'loading' && <p className="notice" role="status" aria-busy="true">Reading VLANs, interfaces, and configuration sessions…</p>}
      {load.kind === 'error' && <div className="notice notice-error" role="alert"><strong>Device state could not be read.</strong><p>{load.message}</p>{proxyConfigured && node !== undefined && <button type="button" onClick={reload}>Retry read</button>}</div>}
      {data !== undefined && <>
        {data.statusError !== undefined && <p className="notice notice-warning" role="status">Interface status is unavailable: {data.statusError} Configured Ethernet interfaces remain selectable.</p>}
        <div className="inventory-strip" aria-label="Device inventory"><div><span className="metric-label">VLANs</span><strong>{data.vlans.length}</strong></div><div><span className="metric-label">Ethernet interfaces</span><strong>{ports.length}</strong></div><div><span className="metric-label">Pending sessions</span><strong>{data.sessions.filter((session) => session.state === 'pending').length}</strong></div></div>
        <div className="work-grid">
          <section className="panel assignment-panel" aria-labelledby="assignment-title">
            <div className="panel-heading"><div><p className="eyebrow">ACCESS PORT</p><h3 id="assignment-title">Assign a VLAN</h3></div><span className="panel-index">01</span></div>
            {ports.length === 0 && <p className="empty-state">{data.statusError === undefined ? 'No supported Ethernet interfaces were returned.' : 'No configured Ethernet interfaces are available; status inventory could not be read.'}</p>}
            {vlans.length === 0 && <p className="empty-state">No writable VLANs (IDs 1–4094) are available.</p>}
            <form onSubmit={preview}>
              <label htmlFor="port-select">Interface</label><select id="port-select" value={selectedPort} onChange={(event) => setPortChoice(event.target.value)} disabled={ports.length === 0}>{ports.map((name) => <option key={name}>{name}</option>)}</select>
              <div className="current-state"><span>Current mode <strong>{currentPort?.mode ?? 'Not configured'}</strong></span><span>Current access VLAN <strong>{currentPort?.accessVlan ?? 'Not configured'}</strong></span>{data.statuses.get(selectedPort)?.status !== undefined && <span>Link state <strong>{data.statuses.get(selectedPort)?.status}</strong></span>}</div>
              <label htmlFor="vlan-select">New access VLAN</label><select id="vlan-select" value={selectedVlan} onChange={(event) => setVlanChoice(event.target.value)} disabled={vlans.length === 0}>{vlans.map((vlan) => <option key={vlan.id} value={vlan.id}>{vlan.id} · {vlan.name ?? 'Unnamed VLAN'}</option>)}</select>
              <button className="primary-button" type="submit" disabled={ports.length === 0 || vlans.length === 0 || draft !== undefined || busy}>{busy ? 'Working…' : 'Preview change'}</button>
            </form>
          </section>
          <section className="panel vlan-panel" aria-labelledby="vlan-title">
            <div className="panel-heading"><div><p className="eyebrow">RUNNING CONFIG</p><h3 id="vlan-title">VLAN inventory</h3></div><span className="panel-index">02</span></div>
            {data.vlans.length === 0 ? <p className="empty-state">The device returned no VLAN entries.</p> : <div className="table-scroll"><table><thead><tr><th scope="col">ID</th><th scope="col">Name</th><th scope="col">State</th></tr></thead><tbody>{data.vlans.map((vlan) => <tr key={vlan.id}><td className="numeric-cell">{vlan.id}</td><td>{vlan.name ?? '—'}</td><td><span className="state-label">{vlan.state ?? 'Not reported'}</span></td></tr>)}</tbody></table></div>}
          </section>
        </div>
        {data.sessions.length > 0 && <section className="session-list" aria-labelledby="sessions-title"><div className="panel-heading"><div><p className="eyebrow">DEVICE STATE</p><h3 id="sessions-title">Configuration sessions</h3></div><span className="panel-index">{data.sessions.length.toString().padStart(2, '0')}</span></div><ul>{data.sessions.map((session) => <li key={session.name}><div><strong>{session.name}</strong><span>{session.state}{session.description ? ` · ${session.description}` : ''}</span></div>{session.state === 'pending' && (draft === undefined || draft.session.name !== session.name) && <button className="danger-button" type="button" disabled={busy} onClick={() => void abortPending(session)}>Abort pending session</button>}</li>)}</ul></section>}
      </>}
      {draft !== undefined && <section className="review-panel" aria-labelledby="review-title"><div className="panel-heading"><div><p className="eyebrow">CHANGE REVIEW</p><h3 id="review-title">Session {draft.session.name}</h3></div><span className="session-state">{draft.session.state}</span></div>{draft.diff === undefined ? <p className="notice">The change is staged or its outcome is uncertain. A diff is required before commit.</p> : <pre className="diff-output" aria-label="Configuration diff">{draft.diff || 'No configuration differences returned.'}</pre>}{draft.commitAttempted && <p className="notice notice-warning">Commit was attempted. Refresh device state before taking another action.</p>}<div className="review-actions"><button className="primary-button" type="button" onClick={() => void commitDraft()} disabled={draft.diff === undefined || !draft.session.hasDiffBeenRead() || draft.commitAttempted || busy}>Commit to running-config</button><button className="danger-button" type="button" onClick={() => void abortDraft()} disabled={!draftOpen || busy}>Abort staged changes</button></div></section>}
      {failure !== '' && <p className="notice notice-error operation-result" role="alert">{failure}</p>}{notice !== '' && <p className="notice notice-success operation-result" role="status" aria-live="polite">{notice}</p>}
    </section>
  </main>
}