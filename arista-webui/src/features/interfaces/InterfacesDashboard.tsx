/**
 * S1 (#71): the interfaces dashboard — every interface the device configured, with the read the VLAN
 * screen already does widened to the whole status table, plus the three wave-1 writes
 * (`description`, `mtu`, `shutdown`/`no shutdown`) staged in a **named config session**:
 * preview → device `diff()` read → explicit confirm → commit. Running-config only; startup-config is
 * never saved here (DR-024).
 *
 * ## What the row is built from, and why each column comes from that read
 *
 * | column | source | rule this honours |
 * | --- | --- | --- |
 * | administrative state (`up` / `down` / `Not reported`) | `interfaces.getAll()` → `Interface.shutdown` | DR-027/DR-029: an absent `shutdown`/`no shutdown` line is a third answer, never `false` |
 * | link + line-protocol | `interfaces.getStatus()` (`show interfaces status`) | DR-031's hybrid read, and the read that **reports** a status problem instead of hiding it (divergence 8) |
 * | MTU | `interfaces.getAll()` → `Interface.mtu` (the config `mtu <n>` line) | the hardware capture of `show interfaces status` (67 rows) carries **no** `mtu` key, and neither does the cEOS one — the MTU column may not come from that command (§5 row 106, DR-069) |
 * | Description | config line first, the status `description` column as a labelled fallback | the config half is what writes change; the show column is what the device is currently running |
 * | L2 mode | `switchports.getAll()` (one `show running-config`, DR-030) | no invented per-port `show interfaces switchport` read — that per-port form has never been captured |
 * | LAG membership | the `Port-Channel` sections' `portChannel.members` relation inverted | DR-075 (members come from the config relation, not a text scrape) |
 * | Management path | `show management api http-commands` `urls[]` + `ipinterfaces.getAll()` | the device names its own serving interface; see the guard below |
 *
 * ## The shutdown guard, stated honestly
 *
 * Bringing a front-panel port down can drop the path this UI is riding. The strongest readable signal
 * is the device's own answer for where eAPI is served: `show management api http-commands` →
 * `urls: ["Management1 : https://…:443"]` on the 7050TX-64 capture, `["Vlan100     : …"]` on cEOS
 * (`src/eapi/show-contracts.ts`). Next: a physical port that carries an `ip address` (`ipinterfaces`)
 * is a candidate; being a member of a `Port-Channel` is a dependency an operator should see before
 * shutting it. What this screen **cannot** know is which interface the browser's own packet took if
 * the answer is missing, so:
 *
 * - every `shutdown` is destructive-capable and goes through the F4 confirm naming the port;
 * - when the port is the named eAPI interface, carries an IP, or the classification reads
 *   `Unknown`, the confirm body says the management path may drop and that a session lost mid-commit
 *   may still have applied;
 * - a commit that fails is reported with exactly that recovery text
 *   ("Commit may have applied — reconnect and refresh before any further action."), and the staged
 *   draft is marked commit-attempted so nothing is re-armed automatically;
 * - a shutdown is **never** batched across ports: one session, one `interface <name>` line, pinned by
 *   the argv tests.
 *
 * ## Client-side bounds say so out loud
 *
 * The MTU field enforces a **positive whole number** and the UI labels it "client-side bound, device
 * keeps authority" — `68..9214` is a platform question this repo has no capture for (DR-032;
 * `arista-api-client/docs/STATUS.md` keeps the bound open), and the device's own refusal arrives as a
 * `1002`/`1003` `CommandError`. Same for descriptions: this app refuses to stage a value the client
 * cannot read back (an empty value, or one containing a `"` — `resources/interfaces.ts`'s
 * `assertInterfaceDescription` rule, which the client applies to its own verbs and which this screen
 * mirrors so the refusal is seen before a session is opened, not after).
 *
 * ## Names this client cannot write
 *
 * The 7050TX-64 spells its split QSFP ports `Ethernet49/1`…`Ethernet52/4` (capture-confirmed), while
 * `assertInterfaceName`'s all-digit rule refuses a slash form (DECISIONS open item 7). Those ports are
 * **listed** (a dashboard that hides 16 front-panel ports is a worse dashboard) with the write controls
 * disabled and the reason stated, rather than silently filtered out the way the VLAN screen does.
 */
import { useState } from 'react'
import type { FormEvent } from 'react'
import { commandBuilder, isInterfaceName, submodeCommands } from '@devhax-heavy-industries/arista-eapi'
import type { CommandSpec, ConfigSession, ConfigSessionSummary, Interface, InterfaceStatus, Node } from '@devhax-heavy-industries/arista-eapi'

import { ConnectionHeader } from '../../components/ui/ConnectionHeader'
import { ConfigDiff } from '../../components/ui/ConfigDiff'
import { DataTable } from '../../components/ui/DataTable'
import type { DataTableColumn } from '../../components/ui/DataTable'
import { EmptyState } from '../../components/ui/EmptyState'
import { StatePill } from '../../components/ui/StatePill'
import { identityFrom } from '../../shared/identity'
import type { DeviceIdentity } from '../../shared/identity'
import { softErrorText, softRead, softValue, useDeviceRead } from '../../shared/use-device-read'
import { useOperation } from '../../shared/use-operation'
import { ConfirmProvider, useConfirm } from '../../shared/use-confirm'
import type { ShowManagementApiHttpCommandsReply } from '../../eapi/show-contracts'

// The M13/S1 screen contracts ride this import (ARCHITECTURE §9.1 augmentation), so
// `node.show('management api http-commands')` types end-to-end through `ShowContracts`.
import '../../eapi/show-contracts'

export type InterfacesClient = Pick<Node, 'interfaces' | 'switchports' | 'ipinterfaces' | 'configSession' | 'listSessions' | 'abortSession' | 'show'>
type Session = Pick<ConfigSession, 'name' | 'state' | 'run' | 'diff' | 'hasDiffBeenRead' | 'commit' | 'abort'>

/** What the operator is asking the device to do — one intent per staged session. */
export type InterfaceAction = 'set-description' | 'clear-description' | 'set-mtu' | 'reset-mtu' | 'shutdown' | 'no-shutdown'

/** The management-path classification for the shutdown guard. Device answer first, config second. */
export type BandPath = 'eapi-served' | 'addressed' | 'not-eapi-path' | 'unknown'

export interface InterfaceRow {
  readonly name: string
  /** The client's per-kind parse of the name (`null` becomes `'Unrecognised'`). */
  readonly kind: string
  /** Whether this client can put the name behind `interface <name>` at all (open item 7). */
  readonly editable: boolean
  readonly link?: string
  readonly protocol?: string
  /** The configured administrative state — `up`/`down`, or `Not reported` when the block writes neither. */
  readonly admin: string
  readonly description?: string
  readonly statusDescription?: string
  readonly mtu?: number
  readonly mode?: string
  /** The Port-Channel whose config names this port as a member (DR-075's relation, inverted). */
  readonly channelGroup?: string
  /** The `ip address` this interface carries, when it carries one. */
  readonly address?: string
  readonly bandPath: BandPath
}

type Data = {
  rows: readonly InterfaceRow[]
  sessions: readonly ConfigSessionSummary[]
  statusError?: string
  managementError?: string
  identity?: DeviceIdentity
}
type Draft = { session: Session; batch: readonly string[]; diff?: string; commitAttempted: boolean; bandPath: BandPath }

const PROXY_PROMPT = 'Local proxy is not configured. Set EAPI_HOST, EAPI_USER, and EAPI_PASS in arista-webui/.env.local, then restart Vite.'
const COMMIT_RECOVERY = 'Commit may have applied — reconnect and refresh before any further action.'

const DEVICE_ORDER = (left: string, right: string) => left.localeCompare(right, undefined, { numeric: true })

/**
 * The interfaces named by `show management api http-commands` `urls[]`. The device pads the interface
 * token before the colon with one **or several** spaces (`"Vlan100     : https://…"` on cEOS,
 * `"Management1 : https://…"` on the switch), so the parser takes the leading token, not a single-space
 * split. Returns `[]` (meaning "the answer named nothing"), which the caller distinguishes from
 * "the read failed".
 */
export function managementInterfaces(reply: ShowManagementApiHttpCommandsReply | undefined): readonly string[] {
  if (reply === undefined) return []
  const named = new Set<string>()
  for (const entry of reply.urls) {
    const [, iface = ''] = /^\s*(\S+)\s*:/u.exec(entry) ?? []
    if (iface !== '') named.add(iface)
  }
  return [...named]
}

/**
 * `submodeCommands`/`commandBuilder` answer `CommandSpec[]` (a spec may be `{ cmd, input }` for a
 * multiline command). Every line this screen stages is a plain string, and the shutdown guard plus the
 * review panel both read the text — so the narrowing is asserted rather than cast, and a future verb
 * that stages an object spec fails loudly here instead of showing the operator `undefined`.
 */
function stageLines(batch: readonly CommandSpec[]): readonly string[] {
  return batch.map((entry) => {
    if (typeof entry === 'string') return entry
    throw new Error(`this screen stages plain command lines; got an object spec for ${JSON.stringify(entry.cmd)}`)
  })
}

/** The channel-group relation inverted: member name → the group whose section names it. */
function membersByGroup(interfaces: ReadonlyMap<string, Interface>): ReadonlyMap<string, string> {
  const found = new Map<string, string>()
  for (const [group, entered] of interfaces) {
    for (const member of entered.portChannel?.members ?? []) {
      if (!found.has(member)) found.set(member, group)
    }
  }
  return found
}

/**
 * One row's management-path answer: the interface the device itself names as the eAPI listener first,
 * then a config address. `unknown` covers both "the read failed" (the screen says so in its own
 * notice) and "the answer named nothing" — and it is NOT evidence that a port is safe to shut down.
 */
export function bandPathFor(name: string, address: string | undefined, served: readonly string[]): BandPath {
  if (served.includes(name)) return 'eapi-served'
  if (address !== undefined) return 'addressed'
  return served.length === 0 ? 'unknown' : 'not-eapi-path'
}

const BAND_LABEL: Record<BandPath, string> = {
  'eapi-served': 'eAPI served here',
  addressed: 'Carries an IP address',
  'not-eapi-path': 'Not an eAPI path',
  unknown: 'Unknown',
}

const ADMIN_LABEL = (iface: Interface): string => (iface.shutdown === undefined ? 'Not reported' : iface.shutdown ? 'down' : 'up')

export interface InterfacesDashboardProps {
  readonly node: InterfacesClient | undefined
  readonly proxyConfigured?: boolean
}

/** Hosts the single confirm dialog this screen's writes and aborts route through (#66). */
export function InterfacesDashboard(props: InterfacesDashboardProps) {
  return <ConfirmProvider><InterfacesWorkspace {...props} /></ConfirmProvider>
}

function InterfacesWorkspace({ node, proxyConfigured = true }: InterfacesDashboardProps) {
  const confirm = useConfirm()
  const operation = useOperation()
  const { busy, notice, failure } = operation
  const [portChoice, setPortChoice] = useState('')
  const [action, setAction] = useState<InterfaceAction>('set-description')
  const [description, setDescription] = useState('')
  const [mtu, setMtu] = useState('')
  const [draft, setDraft] = useState<Draft>()

  const read = useDeviceRead<Data>(
    async () => {
      if (node === undefined) throw new Error(PROXY_PROMPT)
      // The status, management-path and identity reads are SOFT: a unit that has no JSON model for
      // `show interfaces status` (1003), or a `show management api http-commands` the operator's role
      // may not run (1002/1005), must not blank a table the running-config read can still build.
      const configPromise = node.interfaces.getAll({ status: 'skip' })
      const statusPromise = node.interfaces.getStatus()
      const managementPromise = node.show('management api http-commands')
      // The identity read is SILENT (the `catch(() => ({}))` shape): absence of the chip, not an error
      // string, is what tells `ConnectionHeader` to skip it.
      const versionPromise = node.show('version').then(identityFrom)
      const [interfaces, switchports, addresses, sessions, status, management, version] = await Promise.all([
        configPromise,
        node.switchports.getAll(),
        node.ipinterfaces.getAll(),
        node.listSessions(),
        softRead(statusPromise),
        softRead(managementPromise),
        softRead(versionPromise, { silent: true }),
      ])
      const identity = softValue(version)
      const served = managementInterfaces(softValue(management))
      const statuses = softValue(status) ?? new Map<string, InterfaceStatus>()
      const groups = membersByGroup(interfaces)

      const names = [...new Set([...interfaces.keys(), ...statuses.keys(), ...addresses.keys()])].sort(DEVICE_ORDER)
      const rows: InterfaceRow[] = names.map((name) => {
        const entered = interfaces.get(name)
        const link = statuses.get(name)
        const address = addresses.get(name)?.address
        return {
          name,
          kind: entered?.kind ?? 'Unrecognised',
          editable: isInterfaceName(name) && entered !== undefined,
          ...(link?.status === undefined ? {} : { link: link.status }),
          ...(link?.protocol === undefined ? {} : { protocol: link.protocol }),
          admin: ADMIN_LABEL(entered ?? { name, kind: null }),
          ...(entered?.description === undefined ? {} : { description: entered.description }),
          ...(link?.description === undefined || link.description === '' ? {} : { statusDescription: link.description }),
          ...(entered?.mtu === undefined ? {} : { mtu: entered.mtu }),
          ...(switchports.get(name)?.mode === undefined ? {} : { mode: switchports.get(name)?.mode }),
          ...(groups.has(name) ? { channelGroup: groups.get(name) } : {}),
          ...(address === undefined ? {} : { address }),
          bandPath: bandPathFor(name, address, served),
        }
      })

      const statusError = softErrorText(status)
      const managementError = softErrorText(management)
      return {
        rows,
        sessions: sessions.sessions,
        ...(statusError === undefined ? {} : { statusError }),
        ...(managementError === undefined ? {} : { managementError }),
        ...(identity === undefined ? {} : { identity }),
      }
    },
    [node],
    { enabled: proxyConfigured && node !== undefined, disabledMessage: PROXY_PROMPT },
  )

  const data = read.state.kind === 'ready' ? read.state.data : undefined
  const rows = data?.rows ?? []
  const selectedRow = rows.find((row) => row.name === portChoice) ?? rows[0]
  const selected = selectedRow?.name ?? ''
  const draftOpen = draft !== undefined && (draft.session.state === 'open' || draft.session.state === 'diffed')
  const canAct = proxyConfigured && node !== undefined
  const writesDisabled = selectedRow === undefined || !selectedRow.editable || draft !== undefined

  /** The staged batch for the current intent, composed by the CLIENT's own builder so the literal text
   *  is the one the resource verbs use (`interface X` + one line), and the client's composer refusals
   *  (an empty value, a line boundary) reach the operator as the client's own message. */
  function stage(name: string): readonly string[] {
    const tail: readonly CommandSpec[] = (() => {
      switch (action) {
        case 'set-description': return [commandBuilder('description', { value: description })]
        case 'clear-description': return [commandBuilder('description', { mode: 'no' })]
        case 'set-mtu': return [commandBuilder('mtu', { value: Number(mtu) })]
        case 'reset-mtu': return [commandBuilder('mtu', { mode: 'no' })]
        case 'shutdown': return [commandBuilder('shutdown', { value: true })]
        case 'no-shutdown': return [commandBuilder('shutdown', { mode: 'no' })]
      }
    })()
    return stageLines(submodeCommands(`interface ${name}`, tail))
  }

  /** This screen's own pre-wire refusals: the rules the client applies inside its verbs, surfaced
   *  before a config session is opened. Each message names the client rule it mirrors. */
  function refusal(): string | undefined {
    if (action === 'set-description') {
      if (description.trim() === '') return 'A description needs a value. Clear the field with the "Clear description" action instead of sending an empty value (the client refuses it the same way: an empty description is `no description`, not `description `).'
      if (description.includes('"')) return 'This client cannot read a description containing a double quote back: its reader unquotes a balanced pair (resources/interfaces.ts, assertInterfaceDescription — MIGRATION.md §5 row 49). Whether EOS accepts one is unverified on hardware, so the app stages nothing rather than writing something the next read cannot see.'
      if (/[\u0000-\u001f\u007f]/u.test(description)) return 'A description may not contain a control character or a line break — one command line per command (command-builder.ts, DR-015).'
    }
    if (action === 'set-mtu') {
      const value = Number(mtu)
      if (mtu.trim() === '' || !Number.isSafeInteger(value) || value <= 0) return 'MTU must be a positive whole number. This bound is client-side (zero, fractions and negatives are refused); the platform minimum and maximum are device answers, so anything the device rejects comes back as a 1002/1003 command error.'
      if (!Number.isFinite(Number(mtu))) return 'MTU must be a positive whole number — client-side bound, device keeps authority.'
    }
    return undefined
  }

  async function preview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || node === undefined || selected === '' || writesDisabled) return
    // A client-side refusal is reported through the same failure slot as a device error, so the
    // operator sees one kind of message with one kind of styling — and no session was opened.
    const reason = refusal()
    if (reason !== undefined) {
      setDraft(undefined)
      await operation.run(async () => { throw new Error(reason) })
      return
    }
    const batch = stage(selected)
    setDraft(undefined)
    await operation.run(async () => {
      const session = await node.configSession({ description: `webui ${action.replace(/-/gu, ' ')} on ${selected}` })
      const handle: Session = session
      setDraft({ session: handle, batch, commitAttempted: false, bandPath: selectedRow?.bandPath ?? 'unknown' })
      await handle.run(batch)
      const diff = await handle.diff()
      setDraft({ session: handle, batch, diff, commitAttempted: false, bandPath: selectedRow?.bandPath ?? 'unknown' })
      return diff
    }, {
      progress: 'Staging the change and reading the device diff…',
      success: 'Review the device diff before committing this change.',
    })
  }

  async function abortDraft() {
    if (busy || draft === undefined || !draftOpen) return
    if (!await confirm({ title: 'Abort staged changes', body: `Abort staged changes in session ${draft.session.name}? Its staged ${draft.batch.join(' · ')} will be discarded.`, confirmLabel: 'Abort staged changes', destructive: true, subject: draft.session.name })) return
    const aborted = await operation.run(async () => {
      await draft.session.abort()
      setDraft(undefined)
      return draft.session.name
    }, { success: `Session ${draft.session.name} was aborted.` })
    if (aborted.ok) read.reload()
  }

  /** The body for the commit prompt. A `shutdown` says plainly what could drop, and says what the app
   *  cannot know — which interface the browser's own packets took is not readable from here. */
  function commitBody(d: Draft, port: string): string {
    const risk = d.bandPath === 'eapi-served'
      ? `The device reports eAPI is served on ${port}. Shutting it down will very likely drop this session mid-commit; the change may still apply.`
      : d.bandPath === 'addressed'
        ? `${port} carries an IP address, so it may be carrying the management path.`
        : d.bandPath === 'unknown'
          ? 'This app could not read where eAPI is served, so it cannot promise this port is out-of-band.'
          : 'A shutdown can still break a dependent path (a LAG member can take an SVI down with it; that EOS behaviour is model-general reasoning, not a capture on this unit).'
    return `Commit session ${d.session.name} to ${port}? This changes running-config only. ${risk} If the session is lost mid-commit, the change may still have applied — reconnect and refresh before any further action.`
  }

  async function commitDraft() {
    if (busy || draft?.diff === undefined || !draft.session.hasDiffBeenRead() || draft.commitAttempted) return
    const shuttingDown = draft.batch.includes('shutdown')
    if (!await confirm({
      title: shuttingDown ? 'Shut down interface' : 'Commit to running-config',
      body: commitBody(draft, selected),
      confirmLabel: shuttingDown ? `Shut down ${selected}` : 'Commit to running-config',
      destructive: true,
      subject: `${draft.session.name} · ${selected}`,
    })) return
    setDraft({ ...draft, commitAttempted: true })
    const committed = await operation.run(() => draft.session.commit(), {
      progress: 'Committing the reviewed change to running-config…',
      success: 'Changes committed to running-config. Startup-config was not changed.',
      failureSuffix: COMMIT_RECOVERY,
    })
    if (committed.ok) {
      setDraft(undefined)
      read.reload()
    }
  }

  async function abortPending(session: ConfigSessionSummary) {
    if (busy || node === undefined || session.state !== 'pending') return
    if (!await confirm({ title: 'Abort pending device session', body: `Abort pending device session ${session.name}? Its staged changes will be discarded. A pending session holds the config lock, which is why a new preview fails until it is cleared.`, confirmLabel: 'Abort pending session', destructive: true, subject: session.name })) return
    const aborted = await operation.run(async () => {
      await node.abortSession(session.name)
      return session.name
    }, { success: `Pending session ${session.name} was aborted.` })
    if (aborted.ok) read.reload()
  }

  const columns: readonly DataTableColumn<InterfaceRow>[] = [
    { header: 'Interface', cell: (row) => <><strong>{row.name}</strong>{row.kind === 'Unrecognised' && <span className="cell-note">name this client cannot parse</span>}</> },
    { header: 'Link', cell: (row) => row.link === undefined ? <span className="cell-note">Not reported</span> : <StatePill value={row.link} /> },
    { header: 'Line protocol', cell: (row) => row.protocol === undefined ? <span className="cell-note">Not reported</span> : <StatePill value={row.protocol} /> },
    { header: 'Admin state', cell: (row) => <StatePill value={row.admin} /> },
    { header: 'Description', cell: (row) => row.description ?? row.statusDescription ?? <span className="cell-note">None configured</span> },
    { header: 'MTU', numeric: true, cell: (row) => row.mtu ?? <span className="cell-note">Not configured</span> },
    { header: 'Mode', cell: (row) => row.mode === undefined ? <span className="cell-note">Not reported</span> : <StatePill value={row.mode} /> },
    { header: 'LAG member', cell: (row) => row.channelGroup ?? <span className="cell-note">None</span> },
    { header: 'Management path', cell: (row) => <><span className={`band-flag band-flag-${row.bandPath}`}>{BAND_LABEL[row.bandPath]}</span>{row.address === undefined ? null : <code className="band-address">{row.address}</code>}</> },
  ]

  return <>
    <div className="screen-connection">
      <ConnectionHeader
        state={read.state.kind === 'ready' ? 'connected' : read.state.kind === 'error' ? 'error' : 'connecting'}
        {...(data?.identity !== undefined ? { identity: data.identity } : {})}
      />
    </div>
    <section className="workspace" aria-labelledby="workspace-title">
      <div className="workspace-heading">
        <div><p className="eyebrow">INTERFACE STATUS</p><h2 id="workspace-title">Interfaces dashboard</h2></div>
        <button className="quiet-button" type="button" onClick={read.reload} disabled={read.state.kind === 'loading' || busy || !canAct}>Refresh state</button>
      </div>

      {read.state.kind === 'loading' && <p className="notice" role="status" aria-busy="true">Reading interfaces, switchport modes, configuration sessions, and the management path…</p>}
      {read.state.kind === 'error' && <div className="notice notice-error" role="alert"><strong>Device state could not be read.</strong><p>{read.state.message}</p>{canAct && <button type="button" onClick={read.reload}>Retry read</button>}</div>}

      {data !== undefined && <>
        {data.statusError !== undefined && <p className="notice notice-warning" role="status">Interface status is unavailable: <code className="read-error">{data.statusError}</code> Configuration for every interface is still listed below.</p>}
        {data.managementError !== undefined && <p className="notice notice-warning" role="status">The management-API read failed: <code className="read-error">{data.managementError}</code> The Management path column reads Unknown, which is not a promise that a port is safe to shut down.</p>}
        <div className="inventory-strip" aria-label="Interface inventory">
          <div><span className="metric-label">Interfaces</span><strong>{rows.length}</strong></div>
          <div><span className="metric-label">Connected</span><strong>{rows.filter((row) => row.link === 'connected').length}</strong></div>
          <div><span className="metric-label">Administratively down</span><strong>{rows.filter((row) => row.admin === 'down').length}</strong></div>
          <div><span className="metric-label">Pending sessions</span><strong>{data.sessions.filter((session) => session.state === 'pending').length}</strong></div>
        </div>

        <section className="panel" aria-labelledby="table-title">
          <div className="panel-heading"><div><p className="eyebrow">RUNNING CONFIG + STATUS</p><h3 id="table-title">Every interface</h3></div><span className="panel-index">{rows.length.toString().padStart(2, '0')}</span></div>
          {rows.length === 0
            ? <EmptyState heading="The device returned no interfaces at all." hint="A running-config read that succeeds with no interface sections means an unconfigured device — it does not mean the ports do not exist." />
            : <DataTable columns={columns} rows={rows} rowKey={(row) => row.name} label="Interface inventory" />}
        </section>

        <section className="panel" aria-labelledby="write-title">
          <div className="panel-heading"><div><p className="eyebrow">STAGED CHANGE</p><h3 id="write-title">Change one interface</h3></div><span className="panel-index">02</span></div>
          {selectedRow !== undefined && !selectedRow.editable && <p className="notice notice-warning" role="status">{selectedRow.name} cannot be edited here: this client refuses to put that name behind <code>interface &lt;name&gt;</code> (DECISIONS.md open item 7).</p>}
          {data.rows.length === 0 && <EmptyState heading="There is no interface to select, so nothing can be staged." />}
          <form onSubmit={preview}>
            <label htmlFor="interface-select">Interface</label>
            <select id="interface-select" value={selected} onChange={(event) => setPortChoice(event.target.value)} disabled={rows.length === 0}>
              {rows.map((row) => <option key={row.name} value={row.name}>{row.name} · {row.admin}</option>)}
            </select>

            <label htmlFor="interface-action">Change</label>
            <select id="interface-action" value={action} onChange={(event) => setAction(event.target.value as InterfaceAction)}>
              <option value="set-description">Set description</option>
              <option value="clear-description">Clear description (no description)</option>
              <option value="set-mtu">Set MTU</option>
              <option value="reset-mtu">Reset MTU (no mtu)</option>
              <option value="shutdown">Shut down (shutdown)</option>
              <option value="no-shutdown">Bring up (no shutdown)</option>
            </select>

            {action === 'set-description' && <>
              <label htmlFor="description-input">Description</label>
              <input id="description-input" value={description} onChange={(event) => setDescription(event.target.value)} />
              <p className="field-note">A value containing a <code>"</code> is refused: this client cannot read it back, and EOS-side legality is uncaptured.</p>
            </>}
            {action === 'set-mtu' && <>
              <label htmlFor="mtu-input">MTU</label>
              <input id="mtu-input" value={mtu} onChange={(event) => setMtu(event.target.value)} inputMode="numeric" />
              <p className="field-note">Client-side bound, device keeps authority: only a positive whole number is staged; <code>68</code>…<code>9214</code> stays an uncaptured platform question.</p>
            </>}
            {(action === 'shutdown' || action === 'no-shutdown') && <p className="field-note">Affects one interface — this screen never batches a shutdown across ports. Committing a shutdown goes through the confirm below, whatever the Management path column says.</p>}

            {/* The value checks live in `refusal()`, not in this gate: an invalid value must produce the
                client's reason in the failure slot, not a button that silently does nothing. */}
            <button className="primary-button" type="submit" disabled={writesDisabled || busy}>{busy ? 'Working…' : 'Preview change'}</button>
          </form>
        </section>

        {draft !== undefined && <section className="review-panel" aria-labelledby="review-title">
          <div className="panel-heading"><div><p className="eyebrow">CHANGE REVIEW</p><h3 id="review-title">Session {draft.session.name}</h3></div><span className="session-state">{draft.session.state}</span></div>
          <p className="staged-argv">{draft.batch.map((command) => <code key={command}>{command}</code>)}</p>
          <ConfigDiff diff={draft.diff} />
          {draft.bandPath !== 'not-eapi-path' && draft.batch.includes('shutdown') && <p className="notice notice-warning" role="status">Management path: {BAND_LABEL[draft.bandPath]} — shutting this port down may drop the eAPI path this UI is using.</p>}
          {draft.commitAttempted && <p className="notice notice-warning">{COMMIT_RECOVERY}</p>}
          <div className="review-actions">
            <button className="primary-button" type="button" onClick={() => void commitDraft()} disabled={draft.diff === undefined || !draft.session.hasDiffBeenRead() || draft.commitAttempted || busy}>Commit to running-config</button>
            <button className="danger-button" type="button" onClick={() => void abortDraft()} disabled={!draftOpen || busy}>Abort staged changes</button>
          </div>
        </section>}

        {data.sessions.length > 0 && <section className="session-list" aria-labelledby="sessions-title"><div className="panel-heading"><div><p className="eyebrow">DEVICE STATE</p><h3 id="sessions-title">Configuration sessions</h3></div><span className="panel-index">{data.sessions.length.toString().padStart(2, '0')}</span></div><ul>{data.sessions.map((session) => <li key={session.name}><div><strong>{session.name}</strong><span><StatePill value={session.state} />{session.description ? ` · ${session.description}` : ''}</span></div>{/pending/iu.test(session.state) && (draft === undefined || draft.session.name !== session.name) && <button className="danger-button" type="button" disabled={busy} onClick={() => void abortPending(session)}>Abort pending session</button>}</li>)}</ul></section>}
      </>}

      {failure !== '' && <p className="notice notice-error operation-result" role="alert">{failure}</p>}
      {notice !== '' && <p className="notice notice-success operation-result" role="status" aria-live="polite">{notice}</p>}
    </section>
  </>
}
