/**
 * F6 (#68): the VLAN-assignment workflow, extracted from `src/features/SwitchManager.tsx` with its
 * behaviour pinned by the moved `App.test.tsx` cases (now `VlanAssignment.test.tsx`).
 *
 * What the split changed is **ownership, not behaviour**:
 * - The chrome the old screen owned (`<main class="shell">`, the skip link, the brand topbar) is
 *   F1's `AppShell` (`src/components/AppShell.tsx`) exactly once. A screen renders inside its
 *   `#workspace` outlet, so it never opens a second shell — that is the two-tier duplication
 *   #68 exists to remove.
 * - The connection cluster and identity chip are now the F3 `ConnectionHeader` primitive, fed from
 *   this container's read state. The component "reads nothing" by contract, and the soft-failure
 *   rule (a failed `show version` simply omits `identity`: no chip, no alert, workspace intact) is
 *   kept here, where the read happens.
 * - The eager read batch, the busy/notice/failure triplet and the confirm prompts come from F2
 *   (`useDeviceRead` + `softRead`/`foldSoftRead`, `useOperation`) and F4 (`useConfirm`) rather than
 *   five hand-rolled copies of the same state machine.
 * - The VLAN table, diff block, empty inventory and status tokens are the F3 primitives.
 *
 * Every visible string, role and disabled-gate that `App.test.tsx` asserted is unchanged: proxy
 * prompt text, `role="status" aria-busy` loading announcement, the exact staged argv, commit gated
 * on `session.hasDiffBeenRead()`, "Startup-config was not changed.", device-only abort of pending
 * sessions, error-vs-empty separation, and the soft identity read. The container props stay
 * `{ node?: Client; proxyConfigured?: boolean }` so the existing fake-node harness keeps compiling.
 */
import { useState } from 'react'
import type { FormEvent } from 'react'
import type { ConfigSessionSummary, InterfaceStatus, Node, Switchport, Vlan } from '@devhax-heavy-industries/arista-eapi'

import { ConnectionHeader } from '../../components/ui/ConnectionHeader'
import { DataTable } from '../../components/ui/DataTable'
import type { DataTableColumn } from '../../components/ui/DataTable'
import { EmptyState } from '../../components/ui/EmptyState'
import { StatePill } from '../../components/ui/StatePill'
import { identityFrom } from '../../shared/identity'
import type { DeviceIdentity } from '../../shared/identity'
import { softRead, softValue, useDeviceRead } from '../../shared/use-device-read'
import { useOperation } from '../../shared/use-operation'

// Device writes are gated behind an accessible native-<dialog> prompt instead of the blocking,
// unstyled `window.confirm` (#66): the awaiting flow only reaches eAPI after an explicit click.
import { ConfirmProvider, useConfirm } from '../../shared/use-confirm'
import { TransactionScope, useTransaction, useTransactionSnapshot } from '../sessions/TransactionContext'

// The M13 screen contracts ride this file into the compilation (ARCHITECTURE §9.1 augmentation), so
// `node.show('version')` types end-to-end through `ShowContracts['version']`. The module is
// type-level only (no runtime exports); the side-effect import is what carries the augmentation.
import '../../eapi/show-contracts'

/** The client seam, unchanged from `SwitchManager`: only the handles this screen touches. */
export type VlanAssignmentClient = Pick<Node, 'vlans' | 'switchports' | 'interfaces' | 'configSession' | 'listSessions' | 'abortSession' | 'show'>

type Data = {
  vlans: readonly Vlan[]
  ports: ReadonlyMap<string, Switchport>
  statuses: ReadonlyMap<string, InterfaceStatus>
  sessions: readonly ConfigSessionSummary[]
  statusError?: string
  identity?: DeviceIdentity
}

const PHYSICAL_ETHERNET = /^Ethernet[0-9]+$/u
const PROXY_PROMPT = 'Local proxy is not configured. Set EAPI_HOST, EAPI_USER, and EAPI_PASS in arista-webui/.env.local, then restart Vite.'

const writableVlan = (vlan: Vlan) => Number.isInteger(vlan.id) && vlan.id >= 1 && vlan.id <= 4094
const naturalOrder = (left: string, right: string) => left.localeCompare(right, undefined, { numeric: true })

export interface VlanAssignmentProps {
  readonly node: VlanAssignmentClient | undefined
  readonly proxyConfigured?: boolean
}

/** Hosts the single confirm dialog used by this screen's three device-writing actions (#66). */
export function VlanAssignment(props: VlanAssignmentProps) {
  return <TransactionScope node={props.node}><ConfirmProvider><VlanAssignmentWorkspace {...props} /></ConfirmProvider></TransactionScope>
}

function VlanAssignmentWorkspace({ node, proxyConfigured = true }: VlanAssignmentProps) {
  const confirm = useConfirm()
  const operation = useOperation()
  const { busy, notice, failure } = operation
  const transaction = useTransaction()
  const transactionState = useTransactionSnapshot()
  const [portChoice, setPortChoice] = useState('')
  const [vlanChoice, setVlanChoice] = useState('')

  const read = useDeviceRead<Data>(
    async () => {
      if (node === undefined) throw new Error(PROXY_PROMPT)
      // Both reads start before the join, exactly as the old inline effect did: a best-effort read
      // folds its failure into the payload instead of failing the whole batch. The identity read is
      // SILENT (`catch(() => ({}))` in the old code) — absence, not an error string, is what tells
      // `ConnectionHeader` to skip the chip.
      const statusPromise = node.interfaces.getStatus()
      const versionPromise = node.show('version').then(identityFrom)
      const [vlans, ports, sessions, status, version] = await Promise.all([
        node.vlans.getAll(),
        node.switchports.getAll(),
        node.listSessions(),
        softRead(statusPromise),
        softRead(versionPromise, { silent: true }),
      ])
      const identity = softValue(version)
      return {
        vlans: [...vlans.values()].filter(writableVlan).sort((left, right) => left.id - right.id),
        ports,
        statuses: status.kind === 'ok' ? status.value : new Map<string, InterfaceStatus>(),
        sessions: sessions.sessions,
        ...(status.kind === 'failed' ? { statusError: status.error } : {}),
        ...(identity === undefined ? {} : { identity }),
      }
    },
    [node],
    {
      enabled: proxyConfigured && node !== undefined,
      disabledMessage: PROXY_PROMPT,
    },
  )

  const data = read.state.kind === 'ready' ? read.state.data : undefined
  const vlans = data?.vlans ?? []
  const ports = data === undefined ? [] : [...new Set([...data.statuses.keys(), ...data.ports.keys()])]
    .filter((name) => PHYSICAL_ETHERNET.test(name))
    .sort(naturalOrder)
  const selectedPort = ports.includes(portChoice) ? portChoice : (ports[0] ?? '')
  const selectedVlan = vlans.some((vlan) => String(vlan.id) === vlanChoice) ? vlanChoice : String(vlans[0]?.id ?? '')
  const currentPort = data?.ports.get(selectedPort)
  const canAct = proxyConfigured && node !== undefined && transaction !== undefined
  const transactionBusy = transactionState.status === 'opening' || transactionState.status === 'staging' || transactionState.status === 'committing' || transactionState.status === 'aborting'
  const transactionBlocked = transactionState.status === 'uncertain'

  async function preview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || transaction === undefined || transactionBusy || transactionBlocked || selectedPort === '' || selectedVlan === '') return
    const commands = [`interface ${selectedPort}`, 'switchport mode access', `switchport access vlan ${selectedVlan}`]
    await operation.run(() => transaction.append({
      source: '/vlans',
      action: `assign VLAN ${selectedVlan} to ${selectedPort}`,
      commands,
      display: commands,
      risks: [],
    }), {
      progress: 'Adding the change to the shared transaction and reading the device diff…',
      success: 'Change added to the transaction. Review the combined diff in Transaction Center.',
    })
  }

  async function abortPending(session: ConfigSessionSummary) {
    if (busy || node === undefined || session.state !== 'pending') return
    if (!await confirm({ title: 'Abort pending device session', body: `Abort pending device session ${session.name}? Its staged changes will be discarded.`, confirmLabel: 'Abort pending session', destructive: true, subject: session.name })) return
    const aborted = await operation.run(async () => {
      await node.abortSession(session.name)
      return session.name
    }, { success: `Pending session ${session.name} was aborted.` })
    if (aborted.ok) read.reload()
  }

  const vlanColumns: readonly DataTableColumn<Vlan>[] = [
    { header: 'ID', numeric: true, cell: (vlan) => vlan.id },
    { header: 'Name', cell: (vlan) => vlan.name ?? '—' },
    { header: 'State', cell: (vlan) => <StatePill value={vlan.state ?? 'Not reported'} /> },
  ]

  return <>
    <div className="screen-connection">
      <ConnectionHeader
        state={read.state.kind === 'ready' ? 'connected' : read.state.kind === 'error' ? 'error' : 'connecting'}
        {...(data?.identity !== undefined ? { identity: data.identity } : {})}
      />
    </div>
    <section className="workspace" aria-labelledby="workspace-title">
      <div className="workspace-heading"><div><p className="eyebrow">CONFIGURATION</p><h2 id="workspace-title">VLAN assignment</h2></div><button className="quiet-button" type="button" onClick={read.reload} disabled={read.state.kind === 'loading' || busy || !canAct}>Refresh state</button></div>
      {read.state.kind === 'loading' && <p className="notice" role="status" aria-busy="true">Reading VLANs, interfaces, and configuration sessions…</p>}
      {read.state.kind === 'error' && <div className="notice notice-error" role="alert"><strong>Device state could not be read.</strong><p>{read.state.message}</p>{canAct && <button type="button" onClick={read.reload}>Retry read</button>}</div>}
      {data !== undefined && <>
        {data.statusError !== undefined && <p className="notice notice-warning" role="status">Interface status is unavailable: {data.statusError} Configured Ethernet interfaces remain selectable.</p>}
        <div className="inventory-strip" aria-label="Device inventory"><div><span className="metric-label">VLANs</span><strong>{data.vlans.length}</strong></div><div><span className="metric-label">Ethernet interfaces</span><strong>{ports.length}</strong></div><div><span className="metric-label">Pending sessions</span><strong>{data.sessions.filter((session) => session.state === 'pending').length}</strong></div></div>
        <div className="work-grid">
          <section className="panel assignment-panel" aria-labelledby="assignment-title">
            <div className="panel-heading"><div><p className="eyebrow">ACCESS PORT</p><h3 id="assignment-title">Assign a VLAN</h3></div><span className="panel-index">01</span></div>
            {ports.length === 0 && <EmptyState heading={data.statusError === undefined ? 'No supported Ethernet interfaces were returned.' : 'No configured Ethernet interfaces are available; status inventory could not be read.'} />}
            {vlans.length === 0 && <EmptyState heading="No writable VLANs (IDs 1–4094) are available." />}
            <form onSubmit={preview}>
              <label htmlFor="port-select">Interface</label><select id="port-select" value={selectedPort} onChange={(event) => setPortChoice(event.target.value)} disabled={ports.length === 0}>{ports.map((name) => <option key={name}>{name}</option>)}</select>
              <div className="current-state"><span>Current mode <strong>{currentPort?.mode ?? 'Not configured'}</strong></span><span>Current access VLAN <strong>{currentPort?.accessVlan ?? 'Not configured'}</strong></span>{data.statuses.get(selectedPort)?.status !== undefined && <span>Link state <strong>{data.statuses.get(selectedPort)?.status}</strong></span>}</div>
              <label htmlFor="vlan-select">New access VLAN</label><select id="vlan-select" value={selectedVlan} onChange={(event) => setVlanChoice(event.target.value)} disabled={vlans.length === 0}>{vlans.map((vlan) => <option key={vlan.id} value={vlan.id}>{vlan.id} · {vlan.name ?? 'Unnamed VLAN'}</option>)}</select>
              <button className="primary-button" type="submit" disabled={ports.length === 0 || vlans.length === 0 || busy || transactionBusy || transactionBlocked || transaction === undefined}>{busy || transactionBusy ? 'Working…' : 'Add to transaction'}</button>
            </form>
          </section>
          <section className="panel vlan-panel" aria-labelledby="vlan-title">
            <div className="panel-heading"><div><p className="eyebrow">RUNNING CONFIG</p><h3 id="vlan-title">VLAN inventory</h3></div><span className="panel-index">02</span></div>
            {data.vlans.length === 0
              ? <EmptyState heading="The device returned no VLAN entries." />
              : <DataTable columns={vlanColumns} rows={data.vlans} rowKey={(vlan) => vlan.id} label="VLAN inventory" />}
          </section>
        </div>
        {data.sessions.length > 0 && <section className="session-list" aria-labelledby="sessions-title"><div className="panel-heading"><div><p className="eyebrow">DEVICE STATE</p><h3 id="sessions-title">Configuration sessions</h3></div><span className="panel-index">{data.sessions.length.toString().padStart(2, '0')}</span></div><ul>{data.sessions.map((session) => <li key={session.name}><div><strong>{session.name}</strong><span><StatePill value={session.state} />{session.description ? ` · ${session.description}` : ''}</span></div>{session.state === 'pending' && session.name !== transactionState.sessionName && <button className="danger-button" type="button" disabled={busy || transactionBusy} onClick={() => void abortPending(session)}>Abort pending session</button>}</li>)}</ul></section>}
      </>}
      {transactionBlocked && <div className="notice notice-error" role="alert"><strong>The transaction outcome is uncertain.</strong><p>{transactionState.uncertainReason}</p></div>}
      {failure !== '' && <p className="notice notice-error operation-result" role="alert">{failure}</p>}{notice !== '' && <p className="notice notice-success operation-result" role="status" aria-live="polite">{notice}</p>}
    </section>
  </>
}
