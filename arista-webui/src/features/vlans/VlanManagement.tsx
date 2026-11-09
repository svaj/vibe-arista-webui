/**
 * S2 (#72): VLAN management — create / rename / state / delete, with the trunk-group controls behind
 * the F5 capability gate. The assignment workflow stays where #68 put it (`VlanAssignment.tsx`); this
 * screen is `#/vlans/manage`, because "manage the VLAN table" and "put a port in a VLAN" are different
 * jobs an operator comes to at different moments.
 *
 * ## The writes are literal, staged, and one transaction each (§ standing rules)
 *
 * Every action opens a named config session, stages the pinned text, reads the device `diff()`, shows
 * it, and only then offers a commit the operator confirms; abort is always available. The texts are the
 * ones `arista-api-client/src/resources/vlans.ts` ports from pyeapi and pins against upstream's suite —
 * the resource verbs themselves (`create`/`setVlanName`/`setVlanState`/`addTrunkGroup`/…) write
 * immediately, so this screen composes the same lines instead of calling them:
 *
 * | action | staged batch |
 * | --- | --- |
 * | create | `['vlan 40']` + `name LAB40` + `state active` when supplied — one transaction, the client's `create(id, attrs)` shape |
 * | rename / clear name | `['vlan 40', 'name LAB40']` / `['vlan 40', 'no name']` |
 * | state | `['vlan 40', 'state active']` / `['vlan 40', 'state suspend']` |
 * | delete | `['no vlan 40']` |
 * | trunk group add / remove | `['vlan 40', 'trunk group G']` / `['vlan 40', 'no trunk group G']` — behind the probe gate |
 *
 * Startup-config is never written (DR-024), and the success text says so.
 *
 * ## Reads and the dependency list
 *
 * `vlans.getAll()` is the table (ids outside `1..4094` are display-preserved read-side per DR-059's
 * read/write split; writes still refuse them). `switchports.getAll()` — one `show running-config`
 * (DR-030) — supplies the references the guard needs: `accessVlan`, `trunkNativeVlan`,
 * `trunkAllowedVlans` (raw device spelling, DR-028) and `trunkGroups`. Deleting a VLAN that any of
 * those names is **not blocked**, because EOS may leave the reference dangling and the operator may
 * legitimately want to clean one up — but it cannot be done blind: the preview panel lists every
 * referencing interface and line, and the confirm repeats them (`showing the referencing config and a
 * hard confirm`, per the issue).
 *
 * The **management VLAN** is decided by the device, not guessed: `show management api http-commands`
 * `urls[]` names the serving interface, and on the lab capture that interface is `Vlan100`, so VLAN 100
 * is the management VLAN there and gets the same hard-confirm treatment as an in-use VLAN. On a unit
 * where eAPI rides `Management1` (the 7050TX-64 capture), no front-panel VLAN is claimed. If the read
 * fails the screen says the answer is unknown and still requires the hard confirm for an in-use VLAN.
 *
 * **VLAN 1 is refused here.** `VlansResource.delete` is gated only by `assertVlanId`, so the client does
 * NOT refuse `no vlan 1` today (checked for this issue: `vlans.ts:466-471` → `assertVlanId` → 1..4094).
 * Rather than silently send it, the screen refuses and says the gap belongs to the client lane.
 *
 * ## The trunk-group section is probe-gated, and the probe is explicit
 *
 * DECISIONS open item 4 says trunk-group support on this SKU is unproven, and the hardware sweep only
 * ever **staged and aborted** `switchport trunk group HWGRP` (batch
 * `configure-session-trunk-groups--hw-session-probe.json`); the VLAN-side line has never been probed on
 * the box at all. So the section uses `useCapabilities` (#67) with an operator-pressable probe and
 * `enabled: false` — no probe happens on render, because every uncached probe costs a config session:
 *
 * ```
 * featureProbeCommands: { vlanTrunkGroups: ['vlan 4090', 'trunk group webui-probe'] }
 * ```
 *
 * `4090` is the scratch id the §3 sweep already used for a VLAN-block probe
 * (`configure-session-vlan-block-form--hw-session-probe.json`), and `probeCommands` stages in a
 * `no-commit` session it always aborts (DR-063) — the F5 wrapper adds the cache, the rate limit, and
 * the `1006`/pending-session affordance. While the verdict is anything other than `available`, the
 * trunk-group controls are **disabled and say why**; an inconclusive run never reads as supported, and
 * the section states that a green probe proves command presence, never capacity (epic open item 6).
 *
 * ## Client-side guards are mirrors, and labelled as such
 *
 * `assertVlanName` / `assertVlanState` / `assertTrunkGroupName` / `assertVlanId` are module-local to the
 * client, so this screen restates them (id range, two-word state vocabulary, single-token group names,
 * the name round-trip rules) and each message names the client rule it mirrors. Refusals surface in the
 * same failure slot as a device error — and no session is opened to produce one. `#70`'s rule that a
 * probe or a name cannot mint a device claim still applies: nothing here asserts what the SKU supports.
 */
import { useState } from 'react'
import type { FormEvent } from 'react'
import { commandBuilder, submodeCommands } from '@devhax-heavy-industries/arista-eapi'
import type { ConfigSession, ConfigSessionSummary, FeatureProbeCommands, Node, Switchport, Vlan } from '@devhax-heavy-industries/arista-eapi'

import { ConnectionHeader } from '../../components/ui/ConnectionHeader'
import { ConfigDiff } from '../../components/ui/ConfigDiff'
import { DataTable } from '../../components/ui/DataTable'
import type { DataTableColumn } from '../../components/ui/DataTable'
import { EmptyState } from '../../components/ui/EmptyState'
import { StatePill } from '../../components/ui/StatePill'
import { softErrorText, softRead, softValue, useDeviceRead } from '../../shared/use-device-read'
import { useOperation } from '../../shared/use-operation'
import { ConfirmProvider, useConfirm } from '../../shared/use-confirm'
import { useCapabilities } from '../../shared/use-capabilities'
import type { CapabilityClient } from '../../shared/use-capabilities'
import { managementInterfaces } from '../interfaces/InterfacesDashboard'
import { stageLines } from '../staged-batch'
import type { ShowManagementApiHttpCommandsReply } from '../../eapi/show-contracts'

import '../../eapi/show-contracts'

type InterfacesManageClient = Pick<Node, 'vlans' | 'switchports' | 'configSession' | 'listSessions' | 'abortSession' | 'show'>
type Session = Pick<ConfigSession, 'name' | 'state' | 'run' | 'diff' | 'hasDiffBeenRead' | 'commit' | 'abort'>

export type VlanAction = 'create' | 'rename' | 'clear-name' | 'set-state' | 'delete' | 'add-trunk-group' | 'remove-trunk-group'

/** The two states the client's `setVlanState` accepts (`vlans.ts:315`, from pyeapi's own docstring). */
export const VLAN_STATES: readonly string[] = ['active', 'suspend']

/** The probe question this screen asks. A map of feature name → candidate commands: the app owns the
 *  vocabulary, the client owns the probe mechanics (DR-033). */
export const VLAN_TRUNK_PROBE: FeatureProbeCommands = {
  vlanTrunkGroups: ['vlan 4090', 'trunk group webui-probe'],
}

export interface VlanRow {
  readonly id: number
  readonly name?: string
  readonly state?: string
  readonly trunkGroups: readonly string[]
  /** Interfaces whose switchport config names this VLAN (access / native / allowed). */
  readonly referencedBy: readonly string[]
  /** `trunkAllowedVlans` written as a keyword (`all`, `except …`) cannot be enumerated here. */
  readonly allowedKeywords: readonly string[]
  readonly managementVlan: boolean
  readonly reserved: boolean
  /** An id the read produced that `assertVlanId` would refuse to write (DR-059's read/write split). */
  readonly unwritable: boolean
}

type Data = {
  vlans: readonly VlanRow[]
  sessions: readonly ConfigSessionSummary[]
  managementError?: string
  managementInterfacesNamed: readonly string[]
}
type Draft = { session: Session; batch: readonly string[]; diff?: string; commitAttempted: boolean; references: readonly string[]; notes: readonly string[] }

const PROXY_PROMPT = 'Local proxy is not configured. Set EAPI_HOST, EAPI_USER, and EAPI_PASS in arista-webui/.env.local, then restart Vite.'
const COMMIT_RECOVERY = 'Commit was attempted; refresh device state before taking another action.'

/** Does a raw `switchport trunk allowed vlan …` spelling name this VLAN? `unknown` for the keyword
 *  forms this client deliberately does not enumerate (DR-028). */
export function allowedNamesVlan(raw: string | undefined, id: number): 'yes' | 'no' | 'unknown' {
  if (raw === undefined) return 'no'
  const text = raw.trim()
  // The keyword forms are an open device question (DR-028): `all`, `forward all` and `except …` cannot
  // be enumerated from here, so the honest answer is "unknown" rather than a yes/no over a guess.
  if (text === '' || /^(all|forward all|except)/iu.test(text)) return 'unknown'
  for (const part of text.split(',')) {
    const [start, end] = part.trim().split('-')
    const from = Number(start)
    const to = end === undefined ? from : Number(end)
    if (!Number.isInteger(from) || !Number.isInteger(to)) return 'unknown'
    if (from <= id && id <= to) return 'yes'
  }
  return 'no'
}

/** A VLAN's referencing lines, spelled the way the running-config spells them. */
function referencesFor(id: number, switchports: ReadonlyMap<string, Switchport>): { lines: string[]; keywords: string[] } {
  const lines: string[] = []
  const keywords: string[] = []
  for (const port of switchports.values()) {
    if (port.accessVlan === id) lines.push(`${port.interfaceName} switchport access vlan ${String(id)}`)
    if (port.trunkNativeVlan === id) lines.push(`${port.interfaceName} switchport trunk native vlan ${String(id)}`)
    const allowed = allowedNamesVlan(port.trunkAllowedVlans, id)
    if (allowed === 'yes') lines.push(`${port.interfaceName} switchport trunk allowed vlan ${String(port.trunkAllowedVlans)}`)
    if (allowed === 'unknown' && port.trunkAllowedVlans !== undefined) {
      keywords.push(`${port.interfaceName}: allowed-vlan spelling ${JSON.stringify(port.trunkAllowedVlans)} is not enumerable here`)
    }
  }
  return { lines, keywords }
}

/**
 * Mirrors the two client rules that keep a value on one config line: C0 controls plus DEL
 * (`hasControlCharacter`, `vlans.ts:275`) and any line boundary the composer refuses
 * (DR-015). Checked by code point rather than regex so the lint rule about control characters in
 * patterns stays honest, and scanned on the raw field so a trailing boundary cannot hide.
 */
function hasControlOrLineBoundary(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0
    if (point < 0x20 || point === 0x7f || point === 0x85 || point === 0x2028 || point === 0x2029) return true
  }
  return false
}

const vlanIdOf = (vlan: Vlan): number => Number(vlan.id)
const writableId = (id: number): boolean => Number.isInteger(id) && id >= 1 && id <= 4094

export interface VlanManagementProps {
  readonly node: InterfacesManageClient & CapabilityClient | undefined
  readonly proxyConfigured?: boolean
}

/** Hosts the single confirm dialog this screen's writes, aborts and pending-session cleanup use. */
export function VlanManagement(props: VlanManagementProps) {
  return <ConfirmProvider><VlanManagementWorkspace {...props} /></ConfirmProvider>
}

function VlanManagementWorkspace({ node, proxyConfigured = true }: VlanManagementProps) {
  const confirm = useConfirm()
  const operation = useOperation()
  const { busy, notice, failure } = operation
  const [action, setAction] = useState<VlanAction>('rename')
  const [vlanChoice, setVlanChoice] = useState('')
  const [newId, setNewId] = useState('')
  const [name, setName] = useState('')
  const [state, setState] = useState<string>('active')
  const [group, setGroup] = useState('')
  const [draft, setDraft] = useState<Draft>()

  // Every device interaction on this screen — the reads, the capability probe and the staged write — is
  // gated by this one condition, so an unconfigured proxy performs no eAPI I/O at all. Declared first
  // because `useCapabilities` reads it during the same pass.
  const canAct = proxyConfigured && node !== undefined

  const read = useDeviceRead<Data>(
    async () => {
      if (node === undefined) throw new Error(PROXY_PROMPT)
      const managementPromise = node.show('management api http-commands')
      const [vlans, switchports, sessions, management] = await Promise.all([
        node.vlans.getAll(),
        node.switchports.getAll(),
        node.listSessions(),
        softRead(managementPromise),
      ])
      const named = managementInterfaces(softValue(management) as ShowManagementApiHttpCommandsReply | undefined)
      const managementVlanIds = named.filter((token) => /^Vlan(\d+)$/iu.test(token)).map((token) => Number(token.slice(4)))
      const rows: VlanRow[] = [...vlans.values()]
        .map((vlan) => {
          const id = vlanIdOf(vlan)
          const refs = referencesFor(id, switchports)
          return {
            id,
            ...(vlan.name === undefined ? {} : { name: vlan.name }),
            ...(vlan.state === undefined ? {} : { state: vlan.state }),
            trunkGroups: vlan.trunkGroups ?? [],
            referencedBy: refs.lines,
            allowedKeywords: refs.keywords,
            managementVlan: managementVlanIds.includes(id),
            reserved: id === 1,
            unwritable: !writableId(id),
          }
        })
        .sort((left, right) => left.id - right.id)
      const managementError = softErrorText(management)
      return {
        vlans: rows,
        sessions: sessions.sessions,
        managementInterfacesNamed: named,
        ...(managementError === undefined ? {} : { managementError }),
      }
    },
    [node],
    { enabled: proxyConfigured && node !== undefined, disabledMessage: PROXY_PROMPT },
  )

  const capabilities = useCapabilities({
    ...(node === undefined ? { node: undefined } : { node }),
    featureProbeCommands: VLAN_TRUNK_PROBE,
    // `enabled: false` in this hook short-circuits `probe()` as well as the mount auto-probe, so the knob
    // cannot mean "only when the operator asks" — it means never. The auto-probe (one cached, throttled
    // config session per node + candidate set, which the client always aborts) is therefore gated by the
    // same condition the reads use, so an unconfigured proxy performs no eAPI I/O at all.
    enabled: canAct,
  })
  const trunk = capabilities.view.features.find((feature) => feature.name === 'vlanTrunkGroups')
  const trunkAvailable = trunk?.display === 'available'

  const data = read.state.kind === 'ready' ? read.state.data : undefined
  const rows = data?.vlans ?? []
  const selectedRow = rows.find((row) => String(row.id) === vlanChoice) ?? rows.find((row) => !row.unwritable) ?? rows[0]
  const selectedId = selectedRow === undefined ? '' : String(selectedRow.id)
  const draftOpen = draft !== undefined && (draft.session.state === 'open' || draft.session.state === 'diffed')
  const usesTargetSelect = action !== 'create'
  const usesNameField = action === 'create' || action === 'rename'
  const usesGroupField = action === 'add-trunk-group' || action === 'remove-trunk-group'

  const trim = (value: string): string => value.trim()

  /** The staged batch for this intent, composed by the client's own `commandBuilder`/`submodeCommands`
   *  so the text is exactly the pyeapi-pinned form and the composer's refusals (empty value, a value
   *  with a line boundary) reach the operator as the client's own message. */
  function stage(): readonly string[] {
    switch (action) {
      case 'create': {
        const attrs: string[] = []
        if (trim(name) !== '') attrs.push(commandBuilder('name', { value: trim(name) }))
        attrs.push(commandBuilder('state', { value: trim(state) }))
        return stageLines(submodeCommands(`vlan ${trim(newId)}`, attrs))
      }
      case 'rename': return stageLines(submodeCommands(`vlan ${selectedId}`, [commandBuilder('name', { value: trim(name) })]))
      case 'clear-name': return stageLines(submodeCommands(`vlan ${selectedId}`, [commandBuilder('name', { mode: 'no' })]))
      case 'set-state': return stageLines(submodeCommands(`vlan ${selectedId}`, [commandBuilder('state', { value: trim(state) })]))
      case 'delete': return [`no vlan ${selectedId}`]
      case 'add-trunk-group': return stageLines(submodeCommands(`vlan ${selectedId}`, [commandBuilder('trunk group', { value: trim(group) })]))
      case 'remove-trunk-group': return stageLines(submodeCommands(`vlan ${selectedId}`, [commandBuilder(`trunk group ${trim(group)}`, { mode: 'no' })]))
    }
  }

  /** Client-side refusals this screen mirrors from the client's module-local guards. Each message names
   *  the rule it mirrors, so the operator can tell an app gate from a device answer. */
  function refusal(): string | undefined {
    const target = action === 'create' ? newId.trim() : selectedId
    const id = Number(target)
    if (target === '' || !Number.isInteger(id)) return 'A VLAN id must be a whole number — the client refuses anything else (assertVlanId, pyeapi `isvlan` range 1..4094).'
    if (id < 1 || id > 4094) return `VLAN ${String(id)} is outside the 1..4094 write range — assertVlanId refuses it (pyeapi "isvlan", vlans.py:77-78). Ids a READ produced outside that range stay listed for display (DR-059 read/write split).`
    if (action === 'delete' && id === 1) return 'Deleting VLAN 1 is refused on this screen. The client does not refuse it: `VlansResource.delete` (vlans.ts:468-472) is gated only by assertVlanId, so `no vlan 1` would reach the device. Closing that gap is a client-lane task; until then the refusal lives here.'
    if (action === 'delete' && selectedRow?.unwritable === true) return 'This VLAN id is one the client can read but not write (DR-059); the delete is refused rather than silently re-forming an id the device wrote strangely.'
    if ((action === 'create' || action === 'rename') && name.trim() === '') return 'A name needs a value. Clear a name with the "Clear name" action instead of sending an empty value (DR-037: the client refuses `name` with no value).'
    if (usesNameField && /\s$/u.test(name)) return 'A name with trailing whitespace cannot read back through this client (it reads the text after the keyword) — pyeapi keeps it verbatim.'
    if (hasControlOrLineBoundary(usesNameField ? name : group)) return 'A VLAN name or trunk-group value cannot contain a control character, line break or line separator — one config line per command (command-builder.ts, DR-015), and the client refuses a control character in a name for the same reason (assertVlanName).'
    if (usesGroupField) {
      // The capability answer is the first question for these two actions: without an `available` verdict
      // this screen sends nothing at all, so no command text is even examined (DECISIONS open item 4).
      if (!trunkAvailable) return 'Trunk-group changes are probe-gated: the capability answer is not `available` (DECISIONS open item 4), so this screen sends nothing.'
      const value = group.trim()
      if (value === '') return 'A trunk-group name needs a value (assertTrunkGroupName).'
      if (/\s/u.test(value)) return 'Trunk-group names must be a single token — the client enforces it because the upstream readers disagree on multi-word names (switchports.py:115 keeps token 1, vlans.py:60 the rest).'
    }
    if (action === 'set-state' && !VLAN_STATES.includes(state)) return `State must be one of ${VLAN_STATES.join(' / ')} — the client refuses anything else (assertVlanState, vlans.ts:315; pyeapi does not check).`
    return undefined
  }

  async function preview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || node === undefined || !canAct) return
    const reason = refusal()
    if (reason !== undefined) {
      setDraft(undefined)
      await operation.run(async () => { throw new Error(reason) })
      return
    }
    const targetId = action === 'create' ? Number(newId.trim()) : Number(selectedId)
    const row = rows.find((candidate) => candidate.id === targetId)
    const references = [...(row?.referencedBy ?? [])]
    // Two different things, kept apart because the second is not a reference: the config lines that name
    // this VLAN, and notes about what the read could not settle (an `all`/`except` spelling, or the
    // device's own management-API answer). Only the first is counted as "referenced by N config line(s)".
    const notes = [
      ...(row?.allowedKeywords ?? []),
      ...(row?.managementVlan === true ? [`VLAN ${String(targetId)} is the interface the device reports serving eAPI on`] : []),
    ]
    const batch = stage()
    setDraft(undefined)
    await operation.run(async () => {
      const session = await node.configSession({ description: `webui vlan ${action} ${String(targetId)}` })
      const handle: Session = session
      setDraft({ session: handle, batch, commitAttempted: false, references, notes })
      await handle.run(batch)
      const diff = await handle.diff()
      setDraft({ session: handle, batch, diff, commitAttempted: false, references, notes })
      return diff
    }, { progress: 'Staging the change and reading the device diff…', success: 'Review the device diff before committing this change.' })
  }

  function confirmBody(d: Draft, id: string): string {
    const base = `Commit session ${d.session.name} for VLAN ${id}? This changes running-config only.`
    const parts = [base]
    if (d.references.length > 0) {
      parts.push(`This VLAN is referenced by ${String(d.references.length)} config line(s):\n${d.references.map((line) => `  · ${line}`).join('\n')}`)
      parts.push('Deleting or changing it can leave those references dangling on the device. If this VLAN carries the management path, this session may drop mid-commit.')
    }
    if (d.notes.length > 0) parts.push(`Notes from the device read:\n${d.notes.map((line) => `  · ${line}`).join('\n')}`)
    return parts.join(' ')
  }

  async function commitDraft() {
    if (busy || draft?.diff === undefined || !draft.session.hasDiffBeenRead() || draft.commitAttempted) return
    const id = action === 'create' ? newId.trim() : selectedId
    const risky = draft.references.length > 0 || draft.notes.length > 0 || (action === 'set-state' || action === 'delete' || action === 'clear-name')
    if (!await confirm({
      title: risky ? `Confirm VLAN ${id} change` : 'Commit to running-config',
      body: confirmBody(draft, id),
      confirmLabel: action === 'delete' ? `Delete VLAN ${id}` : 'Commit to running-config',
      destructive: true,
      subject: `${draft.session.name} · vlan ${id}`,
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
      // A committed change is exactly when a cached capability answer must be re-asked, not trusted.
      if (usesGroupField) void capabilities.probe({ force: true })
    }
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

  async function abortPending(session: ConfigSessionSummary) {
    if (busy || node === undefined || !/pending/iu.test(session.state)) return
    if (!await confirm({ title: 'Abort pending device session', body: `Abort pending device session ${session.name}? Its staged changes will be discarded. A pending session holds the config lock, which is why a preview or a probe fails until it is cleared.`, confirmLabel: 'Abort pending session', destructive: true, subject: session.name })) return
    const aborted = await operation.run(async () => {
      await node.abortSession(session.name)
      return session.name
    }, { success: `Pending session ${session.name} was aborted.` })
    if (aborted.ok) read.reload()
  }

  const columns: readonly DataTableColumn<VlanRow>[] = [
    { header: 'VLAN', numeric: true, cell: (row) => <>{String(row.id)}{row.reserved && <span className="cell-note">reserved</span>}{row.unwritable && <span className="cell-note">not writable here</span>}</> },
    { header: 'Name', cell: (row) => row.name ?? <span className="cell-note">None configured</span> },
    { header: 'State', cell: (row) => row.state === undefined ? <span className="cell-note">Not reported</span> : <StatePill value={row.state} /> },
    { header: 'Trunk groups', cell: (row) => row.trunkGroups.length === 0 ? <span className="cell-note">None</span> : <span className="group-list">{row.trunkGroups.join(', ')}</span> },
    { header: 'Referenced by', cell: (row) => row.referencedBy.length === 0
      ? <span className="cell-note">No switchport reference found</span>
      : <ul className="ref-list">{row.referencedBy.map((line) => <li key={line}><code>{line}</code></li>)}</ul> },
    { header: 'Flags', cell: (row) => <>{row.managementVlan && <span className="band-flag band-flag-eapi-served">Management VLAN</span>}{row.allowedKeywords.length > 0 && <span className="cell-note">allowed-vlan spelling not enumerable</span>}</> },
  ]

  const trunkLabel = trunk?.display ?? 'unknown'

  return <>
    <div className="screen-connection">
      <ConnectionHeader state={read.state.kind === 'ready' ? 'connected' : read.state.kind === 'error' ? 'error' : 'connecting'} />
    </div>
    <section className="workspace" aria-labelledby="workspace-title">
      <div className="workspace-heading">
        <div><p className="eyebrow">VLAN MANAGEMENT</p><h2 id="workspace-title">VLAN table</h2></div>
        <button className="quiet-button" type="button" onClick={read.reload} disabled={read.state.kind === 'loading' || busy || !canAct}>Refresh state</button>
      </div>

      {read.state.kind === 'loading' && <p className="notice" role="status" aria-busy="true">Reading VLANs, switchport references, configuration sessions, and the management path…</p>}
      {read.state.kind === 'error' && <div className="notice notice-error" role="alert"><strong>Device state could not be read.</strong><p>{read.state.message}</p>{canAct && <button type="button" onClick={read.reload}>Retry read</button>}</div>}

      {data !== undefined && <>
        {data.managementError !== undefined && <p className="notice notice-warning" role="status">The management-API read failed: <code className="read-error">{data.managementError}</code> No VLAN is flagged as the management VLAN, which is not a promise that none is.</p>}
        <div className="inventory-strip" aria-label="VLAN inventory">
          <div><span className="metric-label">VLANs</span><strong>{rows.length}</strong></div>
          <div><span className="metric-label">In use by a switchport</span><strong>{rows.filter((row) => row.referencedBy.length > 0).length}</strong></div>
          <div><span className="metric-label">Pending sessions</span><strong>{data.sessions.filter((session) => /pending/iu.test(session.state)).length}</strong></div>
        </div>

        <section className="panel" aria-labelledby="table-title">
          <div className="panel-heading"><div><p className="eyebrow">RUNNING CONFIG</p><h3 id="table-title">Every VLAN</h3></div><span className="panel-index">{rows.length.toString().padStart(2, '0')}</span></div>
          {rows.length === 0
            ? <EmptyState heading="The device returned no VLAN entries." hint="An unconfigured device, not a read failure — a failed read renders as an error above." />
            : <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} label="VLAN inventory" />}
        </section>

        <section className="panel" aria-labelledby="trunk-title">
          <div className="panel-heading"><div><p className="eyebrow">CAPABILITY</p><h3 id="trunk-title">Trunk groups on this device</h3></div><span className="panel-index">02</span></div>
          <p className="notice" role="status">
            Verdict: <strong>{trunkLabel}</strong>. {trunk?.reason ?? 'No probe has run, so the answer is unknown.'}
            {capabilities.view.fromCache ? ' This answer came from the capability cache — no config session was opened for it.' : ''}
          </p>
          <p className="field-note">Support is unproven on the 7050TX-64 (DECISIONS open item 4): the sweep only ever <em>staged and aborted</em> <code>switchport trunk group …</code>, and the VLAN-side line has never been probed on the box. A probe runs the candidate commands inside a <code>no-commit</code> config session that is always aborted (DR-063), and proves command presence only — never how many groups the SKU allows (epic open item 6).</p>
          <div className="review-actions">
            <button className="quiet-button" type="button" disabled={busy || capabilities.view.status === 'probing' || !canAct} onClick={() => void capabilities.probe({ force: true })}>{capabilities.view.status === 'probing' ? 'Probing…' : 'Re-run capability probe'}</button>
          </div>
          {/* F5's rate limiter is part of the contract: a repeat probe inside the window costs no second
              config session, and the screen says so instead of leaving the button looking broken. */}
          {capabilities.view.suppressedCount > 0 && <p className="field-note" role="status">The last {String(capabilities.view.suppressedCount)} probe request(s) fell inside the rate-limit window, so no config session was opened for them. The verdict above is unchanged.</p>}
          {capabilities.view.configLocked && <p className="notice notice-warning" role="status">The probe reported the config lock (1006): nothing was probed. {capabilities.view.pendingSessions.length === 0 ? 'No pending session was listed by this run — check `show configuration sessions`.' : `Pending: ${capabilities.view.pendingSessions.map((session) => session.name).join(', ')}`}</p>}
          {capabilities.view.failure !== undefined && <p className="notice notice-error" role="alert">Probe failed: {capabilities.view.failure}</p>}
          {trunkAvailable && <p className="notice notice-success" role="status" aria-live="polite">The device accepted the probe commands, so the trunk-group controls below are enabled.</p>}
          {!trunkAvailable && <p className="notice notice-warning" role="status">Trunk-group controls are disabled while the verdict is {trunkLabel}. An inconclusive probe is never treated as support.</p>}
        </section>

        <section className="panel" aria-labelledby="write-title">
          <div className="panel-heading"><div><p className="eyebrow">STAGED CHANGE</p><h3 id="write-title">Change a VLAN</h3></div><span className="panel-index">03</span></div>
          <form onSubmit={preview}>
            <label htmlFor="vlan-action">Action</label>
            <select id="vlan-action" value={action} onChange={(event) => setAction(event.target.value as VlanAction)}>
              <option value="create">Create VLAN</option>
              <option value="rename">Rename (name …)</option>
              <option value="clear-name">Clear name (no name)</option>
              <option value="set-state">Set state</option>
              <option value="delete">Delete (no vlan …)</option>
              <option value="add-trunk-group">Add trunk group</option>
              <option value="remove-trunk-group">Remove trunk group</option>
            </select>

            {action === 'create' ? <>
              <label htmlFor="vlan-new-id">New VLAN id</label>
              <input id="vlan-new-id" value={newId} onChange={(event) => setNewId(event.target.value)} inputMode="numeric" />
            </> : <>
              <label htmlFor="vlan-select">VLAN</label>
              <select id="vlan-select" value={selectedId} onChange={(event) => setVlanChoice(event.target.value)} disabled={rows.length === 0}>
                {rows.map((row) => <option key={row.id} value={String(row.id)}>{String(row.id)}{row.name === undefined ? '' : ` · ${row.name}`}</option>)}
              </select>
            </>}

            {usesNameField && <>
              <label htmlFor="vlan-name">Name</label>
              <input id="vlan-name" value={name} onChange={(event) => setName(event.target.value)} />
              <p className="field-note">This client reads the text after <code>name</code> and unquotes a balanced pair, so a value with outer whitespace cannot round-trip (row 49). The device keeps authority over what it accepts.</p>
            </>}
            {(action === 'create' || action === 'set-state') && <>
              <label htmlFor="vlan-state">State</label>
              <select id="vlan-state" value={state} onChange={(event) => setState(event.target.value)}>
                {VLAN_STATES.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </>}
            {usesGroupField && <>
              <label htmlFor="vlan-group">Trunk group</label>
              <input id="vlan-group" value={group} onChange={(event) => setGroup(event.target.value)} disabled={!trunkAvailable || busy} />
              <p className="field-note">One token. Enabled only when the capability probe above answers <code>available</code>.</p>
            </>}

            {usesTargetSelect && selectedRow !== undefined && selectedRow.referencedBy.length > 0 && <p className="notice notice-warning" role="status">VLAN {String(selectedRow.id)} is referenced by {String(selectedRow.referencedBy.length)} config line(s): {selectedRow.referencedBy.join(' · ')}</p>}
            {usesTargetSelect && selectedRow?.managementVlan && <p className="notice notice-warning" role="status">VLAN {String(selectedRow.id)} is the interface this device reports serving eAPI on. Changing or deleting it may drop this session.</p>}
            {selectedRow?.reserved && action === 'delete' && <p className="notice notice-warning" role="status">VLAN 1 cannot be deleted from this screen: the client does not refuse <code>no vlan 1</code>, so the refusal lives here until the client lane closes it.</p>}

            <button className="primary-button" type="submit" disabled={draft !== undefined || busy || (rows.length === 0 && action !== 'create')}>{busy ? 'Working…' : 'Preview change'}</button>
          </form>
        </section>

        {draft !== undefined && <section className="review-panel" aria-labelledby="review-title">
          <div className="panel-heading"><div><p className="eyebrow">CHANGE REVIEW</p><h3 id="review-title">Session {draft.session.name}</h3></div><span className="session-state">{draft.session.state}</span></div>
          <p className="staged-argv">{draft.batch.map((command) => <code key={command}>{command}</code>)}</p>
          <ConfigDiff diff={draft.diff} />
          {draft.references.length > 0 && <ul className="ref-list" aria-label="Config that references this VLAN">{draft.references.map((line) => <li key={line}><code>{line}</code></li>)}</ul>}
          {draft.commitAttempted && <p className="notice notice-warning">{COMMIT_RECOVERY}</p>}
          <div className="review-actions">
            <button className="primary-button" type="button" onClick={() => void commitDraft()} disabled={draft.diff === undefined || !draft.session.hasDiffBeenRead() || draft.commitAttempted || busy}>Commit to running-config</button>
            <button className="danger-button" type="button" onClick={() => void abortDraft()} disabled={!draftOpen || busy}>Abort staged changes</button>
          </div>
        </section>}

        {capabilities.view.pendingSessions.length > 0 && <section className="session-list" aria-labelledby="probe-sessions-title"><div className="panel-heading"><div><p className="eyebrow">PROBE CLEANUP</p><h3 id="probe-sessions-title">Sessions the probe found pending</h3></div><span className="panel-index">{String(capabilities.view.pendingSessions.length)}</span></div><ul>{capabilities.view.pendingSessions.map((session) => <li key={session.name}><div><strong>{session.name}</strong><span><StatePill value={session.state} />{session.description ? ` · ${session.description}` : ''}</span></div><button className="danger-button" type="button" disabled={busy} onClick={() => void abortPending(session)}>Abort pending session</button></li>)}</ul></section>}

        {data.sessions.length > 0 && <section className="session-list" aria-labelledby="sessions-title"><div className="panel-heading"><div><p className="eyebrow">DEVICE STATE</p><h3 id="sessions-title">Configuration sessions</h3></div><span className="panel-index">{data.sessions.length.toString().padStart(2, '0')}</span></div><ul>{data.sessions.map((session) => <li key={session.name}><div><strong>{session.name}</strong><span><StatePill value={session.state} />{session.description ? ` · ${session.description}` : ''}</span></div>{/pending/iu.test(session.state) && (draft === undefined || draft.session.name !== session.name) && <button className="danger-button" type="button" disabled={busy} onClick={() => void abortPending(session)}>Abort pending session</button>}</li>)}</ul></section>}
      </>}

      {failure !== '' && <p className="notice notice-error operation-result" role="alert">{failure}</p>}
      {notice !== '' && <p className="notice notice-success operation-result" role="status" aria-live="polite">{notice}</p>}
    </section>
  </>
}


