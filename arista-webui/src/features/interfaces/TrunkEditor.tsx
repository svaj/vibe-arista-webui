/**
 * S3 (#73): the trunk-port editor — `switchport mode`, `switchport access vlan`,
 * `switchport trunk native vlan` and `switchport trunk allowed vlan` for one Ethernet or
 * Port-Channel section at a time, staged in a **named config session**: preview → device `diff()`
 * read → explicit hard confirm → commit. Running-config only; startup-config is never saved here
 * (DR-024), and the success text says so.
 *
 * This file is the **container**: it owns every device read, the staged batch, the session handle,
 * the pre-wire refusals and the risk sentences. Rendering lives in `TrunkEditorView.tsx`, which sees
 * only plain strings/numbers/arrays — no `Switchport`, `Vlan`, `Interface`, `ConfigSession` or
 * `ConfigSessionSummary` crosses that boundary.
 *
 * ## Where the values come from, and what that does not prove
 *
 * `switchports.getAll()` is one `show running-config` read the client parses (DR-030). The client's
 * own header records that its `switchport-trunk.conf` fixture is **hand-authored** and that there is
 * **no** device-side `show interfaces switchport` JSON capture (DECISIONS/PLAN around M9 #11 and M12
 * #14), so this screen is showing parsed config text and must not imply model-backed trunk state —
 * the view states that above the table. `interfaces.getAll({ status: 'skip' })` supplies the section
 * names and the client's kind parse, `vlans.getAll()` supplies suggestion ids, `ipinterfaces.getAll()`
 * the candidate-management-path signal S1 (#71) uses, and `show management api http-commands` is the
 * device's own answer for where eAPI is served (capture-backed twice over:
 * `Management1 :` on the 7050TX-64, `Vlan100     :` on cEOS-lab; the padded token is why the shared
 * {@link managementInterfaces} parser takes the leading token rather than splitting on one space).
 *
 * ## Command text is the client's, not this screen's
 *
 * Every batch is composed with the client's `commandBuilder`/`submodeCommands` — the same pair
 * S1/S2 use — so the text is the pyeapi-pinned form and the composer's own refusals (an empty value,
 * a value with a line boundary) reach the operator as the client's message. The pinned framing per
 * port is `interface <name>` **inside the session batch**: that is the client's `configureInterface`
 * shape (`submodeCommands`, resources/command-builder.ts), and it is why a config-mode prompt never
 * appears in the staged argv. `switchports.getAll()` values are read verbatim, and a `mode` token
 * outside the client's four is kept as a raw string for display and narrowed with `isSwitchportMode`
 * — never coerced, never offered for a write.
 *
 * ```
 * set-mode        ['interface Ethernet1', 'switchport mode trunk']
 * no-mode         ['interface Ethernet1', 'no switchport mode']
 * access-vlan     ['interface Ethernet1', 'switchport access vlan 20']
 * native-vlan     ['interface Ethernet1', 'switchport trunk native vlan 100']
 * no-native-vlan  ['interface Ethernet1', 'no switchport trunk native vlan']
 * allowed-*       ['interface Ethernet1', 'switchport trunk allowed vlan <recomputed list>']
 * no-allowed      ['interface Ethernet1', 'no switchport trunk allowed vlan']
 * ```
 *
 * The allowed-VLAN list is always written **whole**: the client ports pyeapi's `set`/`disable`/
 * `default` forms only (`switchports.ts:633-648`), so there is no `add`/`remove` verb to use, and this
 * screen computes the resulting set (via `src/shared/allowed-vlans.ts`) and collapses it the way the
 * client canonicalises a `number[]` (`[10,20,21,22]` → `10,20-22`). Note the asymmetry the client test
 * pins (`switchports.test.ts:513-515`): handing `setTrunkAllowedVlans` the raw string `1,2,3-5,6,7`
 * sends it **verbatim**, while the same members computed as a set emit `1-7`. Both are the same set;
 * the argv test asserts the second, because this screen computed it.
 *
 * ## Guards, and what each one is evidence for
 *
 * - **Native VLAN vs the management path** (the issue's F4 case): if the port's current native VLAN is
 *   an id the device's own `management api http-commands` answer maps to a front-panel VLAN, or the id
 *   being written is that VLAN, the commit gets a hard confirm whose title, body and button label name
 *   the VLAN. Cancelling it opens nothing.
 * - **Mode → trunk with a management-adjacent access VLAN**, same shape: the port's current access VLAN
 *   is the eAPI VLAN, or the section carries an `ip address`. The consequence is phrased as a
 *   possibility ("may drop the path this UI is using"), because the EOS-side behaviour of re-forming an
 *   access port as a trunk is model-general reasoning, not a capture on this unit — unproven on this
 *   box (no hardware pin).
 * - An **empty allowed-VLAN result** is refused with the client's own reason and points at the
 *   `no switchport trunk allowed vlan` action this screen offers instead.
 * - A **keyword spelling** (`all`, `except …`, `forward all`) is shown verbatim, flagged as not
 *   enumerable (DR-028 / DECISIONS open item 4), and add/remove against it is refused rather than
 *   guessed at. `replace` is still offered, because then the operator is writing an explicit list.
 * - A name this client cannot put behind `interface <name>` is listed with the write controls shut
 *   (DECISIONS open item 7), and a section with no switchport line says that no such line was read —
 *   whether that means a bare `no switchport` or an unconfigured section is the device's answer.
 *
 * ## Trunk groups: probe-gated exactly like S2 (#72)
 *
 * Group support on this SKU is unproven (DECISIONS open item 4). The 2026-11-06 sweep **did** stage and
 * abort `interface Ethernet22` + `switchport mode trunk` + `switchport trunk group HWGRP`
 * (`arista-api-client/test/fixtures/recordings/7050tx-64-r-4.28.13.1M/configure-session-trunk-groups--hw-session-probe.json`),
 * so the add/remove command forms have hardware staging evidence — but never a commit, and nothing about
 * capacity. So the screen uses `useCapabilities` with a candidate that mirrors that accepted block:
 *
 * ```
 * switchportTrunkGroups: ['interface Ethernet22', 'switchport trunk group webui-probe']
 * ```
 *
 * `Ethernet22` is the scratch port that capture names, and the probe rides a `no-commit` session the
 * client always aborts (DR-063) — it proves command presence, never how many groups the SKU allows (epic
 * open item 6). On a box without that interface the probe answers at token 1, and the copy says so rather
 * than dressing a probe miss as platform support. Until the verdict is `available` the two group actions
 * are refused in `plan()` — controls stay visible, like the out-of-vocabulary mode row — and an
 * inconclusive answer never reads as support. The read side shows each port's parsed `switchport trunk
 * group …` lines (running-config text, not model-backed), with a probe offered before any commit.
 */
import { useState } from 'react'
import type { FormEvent } from 'react'
import { commandBuilder, isInterfaceName, isSwitchportMode, submodeCommands, SWITCHPORT_MODES } from '@devhax-heavy-industries/arista-eapi'
import type { ConfigSession, ConfigSessionSummary, FeatureProbeCommands, Interface, IpInterface, Node, Switchport, Vlan } from '@devhax-heavy-industries/arista-eapi'

import { identityFrom } from '../../shared/identity'
import type { DeviceIdentity } from '../../shared/identity'
import { applyAllowedVlansEdit, parseAllowedVlans, trunkGroupNameRefusal, VLAN_ID_MAX, VLAN_ID_MIN } from '../../shared/allowed-vlans'
import type { AllowedVlanEditKind, AllowedVlanParse } from '../../shared/allowed-vlans'
import { softErrorText, softRead, softValue, useDeviceRead } from '../../shared/use-device-read'
import { useOperation } from '../../shared/use-operation'
import { ConfirmProvider, useConfirm } from '../../shared/use-confirm'
import { candidateList, useCapabilities } from '../../shared/use-capabilities'
import type { CapabilityClient } from '../../shared/use-capabilities'
import { managementInterfaces } from './InterfacesDashboard'
import { stageLines } from '../staged-batch'
import { TrunkEditorView } from './TrunkEditorView'
import type { TrunkAction, TrunkCapabilityView, TrunkDraftView, TrunkFields, TrunkLoadState, TrunkMessage, TrunkPortRow, TrunkSessionRow, TrunkVlanOption } from './TrunkEditorView'
import type { ShowManagementApiHttpCommandsReply } from '../../eapi/show-contracts'

// The screen contracts ride this import (ARCHITECTURE §9.1 augmentation), so
// `node.show('management api http-commands')` and `node.show('version')` type end-to-end.
import '../../eapi/show-contracts'

/** The client seam for this screen: mirrors `InterfacesManageClient` in `VlanManagement.tsx`. */
export type TrunkEditorClient = Pick<Node, 'interfaces' | 'ipinterfaces' | 'switchports' | 'vlans' | 'configSession' | 'listSessions' | 'abortSession' | 'show'>

/** The second caller of the same F5 seam as `VlanManagement.tsx`: the probe mechanism is the
 *  client's (`probeCommands` on a config session it always aborts); this app names the feature. */
type TrunkCapabilityClient = TrunkEditorClient & CapabilityClient

/** The capability question this screen asks, mirroring the accepted hardware staging block
 *  (`interface Ethernet22` + `switchport trunk group HWGRP`, aborted in the 2026-11-06 sweep). A box
 *  without Ethernet22 answers at token 1, and the copy says so. */
export const TRUNK_GROUP_PROBE: FeatureProbeCommands = {
  switchportTrunkGroups: [
    // The candidates are the sweep's accepted block verbatim — one `interface` context line plus the
    // group line — staged and aborted on the box (DR-063 sends this text through `validateChanges`).
    // The client stamps `result.features` by matching the candidate against THIS list
    // (capabilities.ts:479 `labels[command]`), so both entries must appear here exactly as sent or the
    // row classifies `unknown` with 'No candidate command was probed' and the gate never opens
    // (#72 hand-off: a bare map looked stuck at `unknown` with a passing probe on the wire).
    'interface Ethernet22',
    'switchport trunk group webui-probe',
  ],
}
type Session = Pick<ConfigSession, 'name' | 'state' | 'run' | 'diff' | 'hasDiffBeenRead' | 'commit' | 'abort'>

const PROXY_PROMPT = 'Local proxy is not configured. Set EAPI_HOST, EAPI_USER, and EAPI_PASS in arista-webui/.env.local, then restart Vite.'
const COMMIT_RECOVERY = 'Commit was attempted; refresh device state before taking another action.'
const REREAD_NOTICE = 'Device state was re-read from the running-config after the commit. The values above are the device’s answer again, not what this form staged.'
const LOCAL_EDIT_NOTICE = 'These edits are local. Nothing has been staged or committed: Preview change opens a named config session, and the device diff is what decides what a commit would do.'
const NO_SWITCHPORT_RECORD_NOTE = 'No switchport line was read for this section. The client skips a section whose block carries a bare `no switchport` (divergence 8 in resources/switchports.ts), so whether this port is routed or simply unconfigured is the device’s answer — unproven on this box (no hardware pin).'

const TRUNK_GROUP_UNAVAILABLE = 'Trunk-group changes are probe-gated: the capability answer is not `available` (DECISIONS open item 4), so this screen sends nothing.'
const DEVICE_ORDER = (left: string, right: string) => left.localeCompare(right, undefined, { numeric: true })

/** The form's initial edit: a trunk mode write on whatever port the read put first. */
const INITIAL_FIELDS: TrunkFields = { port: '', action: 'set-mode', mode: 'trunk', accessVlan: '', nativeVlan: '', allowedRanges: '', trunkGroup: '' }

interface TrunkData {
  readonly rows: readonly TrunkPortRow[]
  readonly vlanOptions: readonly TrunkVlanOption[]
  readonly sessions: readonly TrunkSessionRow[]
  readonly managementInterfacesNamed: readonly string[]
  readonly managementVlanIds: readonly number[]
  /** Per-port parse of the raw allowed-VLAN spelling, so an edit operates on a set or refuses honestly. */
  readonly allowed: ReadonlyMap<string, AllowedVlanParse>
  readonly managementError?: string
  readonly identity?: DeviceIdentity
}

interface Draft {
  readonly session: Session
  readonly batch: readonly string[]
  readonly risks: readonly string[]
  readonly port: string
  /** The VLAN a hard confirm has to name, decided from the device read **at staging time** — re-reading
   *  the fields at commit time could name a different port's VLAN than the staged batch touches. */
  readonly riskVlan?: number
  readonly diff?: string
  readonly commitAttempted: boolean
}

type Plan = { readonly batch: readonly string[] } | { readonly refusal: string }

/** Why a VLAN field cannot be written, naming the client rule it mirrors (DR-053's throw-guards). */
const notWholeId = (label: string, value: string): string => `${label} ${JSON.stringify(value)} is not a whole VLAN id: this client refuses anything but an integer in ${String(VLAN_ID_MIN)}..${String(VLAN_ID_MAX)} (assertVlanId, pyeapi “isvlan” at api/vlans.py:77-78). That bound is the client rule mirrored here, not a captured platform range — the device keeps authority over what it answers.`

const outOfWriteRange = (id: number): string => `VLAN ${String(id)} is outside the ${String(VLAN_ID_MIN)}..${String(VLAN_ID_MAX)} write range — assertVlanId refuses it (pyeapi “isvlan”). An id a READ produced outside that range stays listed for display (DR-059's read/write split), it is not re-formed here.`

/** The screen's three allowed-VLAN intents mapped onto the parser's edit vocabulary. */
const EDIT_KIND: Readonly<Record<'allowed-replace' | 'allowed-add' | 'allowed-remove', AllowedVlanEditKind>> = {
  'allowed-replace': 'replace',
  'allowed-add': 'add',
  'allowed-remove': 'remove',
}

/**
 * Which VLAN the hard confirm has to name for this intent, from the device's own answers. `written`
 * is the id being written, when the intent writes one. `undefined` means "this screen has no
 * management-VLAN signal for this change", which is not a claim that the change is safe — the
 * `managementError` arm says so when the read itself failed.
 */
function riskVlanFor(row: TrunkPortRow, action: TrunkAction, managementVlanIds: readonly number[], written?: number): number | undefined {
  if (action === 'native-vlan' || action === 'no-native-vlan') {
    if (row.nativeVlan !== undefined && managementVlanIds.includes(row.nativeVlan)) return row.nativeVlan
    if (written !== undefined && Number.isInteger(written) && managementVlanIds.includes(written)) return written
    return undefined
  }
  if (action === 'set-mode' && row.accessVlan !== undefined && managementVlanIds.includes(row.accessVlan)) return row.accessVlan
  return undefined
}

export interface TrunkEditorProps {
  readonly node: TrunkEditorClient | undefined
  readonly proxyConfigured?: boolean
}

/** Hosts the single confirm dialog this screen's writes, aborts and pending-session cleanup use. */
export function TrunkEditor(props: TrunkEditorProps) {
  return <ConfirmProvider><TrunkEditorWorkspace {...props} /></ConfirmProvider>
}

function TrunkEditorWorkspace({ node, proxyConfigured = true }: TrunkEditorProps) {
  const confirm = useConfirm()
  const operation = useOperation()
  const { busy, notice, failure } = operation
  const [fields, setFields] = useState<TrunkFields>(INITIAL_FIELDS)
  const [draft, setDraft] = useState<Draft>()
  const [rereadNotice, setRereadNotice] = useState('')
  const [portSwitchNotice, setPortSwitchNotice] = useState('')

  const canAct = proxyConfigured && node !== undefined

  // F5 seam, same discipline as S2 (#72): the auto-probe (one cached, throttled config session the
  // client always aborts, DR-063) rides the same gate as the reads, so an unconfigured proxy performs
  // no eAPI I/O at all — and selecting a trunk-group action forces a fresh answer, because the operator
  // just asked the question this screen cares about.
  const capabilities = useCapabilities({
    ...(node === undefined ? { node: undefined } : { node: node as TrunkCapabilityClient }),
    featureProbeCommands: TRUNK_GROUP_PROBE,
    enabled: canAct,
  })
  const groupFeature = capabilities.view.features.find((feature) => feature.name === 'switchportTrunkGroups')
  // `useCapabilities` auto-probes once per (node, candidate set) while `enabled` — which is this
  // screen's `canAct` — so the question is already on the record by the time the first read lands.
  // Selecting a group intent below forces a fresh answer; no mount-time probe call is needed here.
  const groupAvailable = groupFeature?.display === 'available'

  const read = useDeviceRead<TrunkData>(
    async () => {
      if (node === undefined) throw new Error(PROXY_PROMPT)
      // The status/management/identity reads are SOFT exactly as in S1/S2: one command this unit has no
      // JSON model for, or a show the operator's role may not run, must not blank a table the
      // running-config read can still build. The identity read is SILENT — no chip, not an alert.
      const managementPromise = node.show('management api http-commands')
      const versionPromise = node.show('version').then(identityFrom)
      const [interfaces, switchports, vlans, addresses, sessions, management, version] = await Promise.all([
        node.interfaces.getAll({ status: 'skip' }),
        node.switchports.getAll(),
        node.vlans.getAll(),
        node.ipinterfaces.getAll(),
        node.listSessions(),
        softRead(managementPromise),
        softRead(versionPromise, { silent: true }),
      ])

      const named = managementInterfaces(softValue(management) as ShowManagementApiHttpCommandsReply | undefined)
      const managementVlanIds = named.filter((token) => /^Vlan([0-9]+)$/u.test(token)).map((token) => Number(token.slice(4)))
      const allowed = new Map<string, AllowedVlanParse>()
      for (const [name, entry] of switchports) {
        if (entry.trunkAllowedVlans === undefined) continue
        allowed.set(name, parseAllowedVlans(entry.trunkAllowedVlans))
      }

      const names = [...new Set([...interfaces.keys(), ...switchports.keys()])]
        .filter((name) => isCandidate(interfaces.get(name), switchports.has(name)))
        .sort(DEVICE_ORDER)

      const rows: TrunkPortRow[] = names.map((name) => rowFor(name, interfaces, switchports, allowed, addresses, managementVlanIds))
      const managementError = softErrorText(management)
      const identity = softValue(version)

      return {
        rows,
        vlanOptions: [...vlans.values()].map(vlanOption).sort((left, right) => left.id - right.id),
        sessions: sessions.sessions.map(sessionRow),
        managementInterfacesNamed: named,
        managementVlanIds,
        allowed,
        ...(managementError === undefined ? {} : { managementError }),
        ...(identity === undefined ? {} : { identity }),
      }
    },
    // `node` is the loader's only identity input: it closes over `node` plus pure helpers and derives
    // its own allowed/rows maps from fresh reads. Listing the capability state here would re-arm the
    // read on every capability write — the device would be read twice per mount.
    [node],
    { enabled: canAct, disabledMessage: PROXY_PROMPT },
  )

  const data: TrunkData | undefined = read.state.kind === 'ready' ? read.state.data : undefined
  const rows = data === undefined ? [] : data.rows
  const port = rows.some((row) => row.name === fields.port) ? fields.port : (rows[0]?.name ?? '')
  const selectedRow = rows.find((row) => row.name === port)
  const draftView: TrunkDraftView | undefined = draft === undefined ? undefined : {
    sessionName: draft.session.name,
    sessionState: draft.session.state,
    batch: draft.batch,
    ...(draft.diff === undefined ? {} : { diff: draft.diff }),
    commitAttempted: draft.commitAttempted,
    diffRead: draft.session.hasDiffBeenRead(),
    canAbort: draft.session.state === 'open' || draft.session.state === 'diffed',
    risks: draft.risks,
  }

  /** One guard for every text field: changing the port discards the typed edits, because a value typed
   *  for `Ethernet1` must never be staged against a different port. Nothing reached the device. */
  function changeField(field: keyof TrunkFields, value: string): void {
    if (field === 'action' && (value === 'add-trunk-group' || value === 'remove-trunk-group')) {
      // Selecting a group intent IS the question — take the freshest answer the client's cache/rate
      // limiter allows, exactly as S2 does. The write path (plan) never trusts anything but `available`.
      void capabilities.probe({ force: true })
    }
    if (field === 'port') {
      const abandoned = port
      // #123: a typed value must never follow the selection to a different port. Every VALUE field is
      // blanked — the fields carry deltas and ids (`allowed-add` takes the ranges to add, not the port's
      // whole list), so re-seeding them from the new port would silently change the meaning of what is
      // typed next. The new port's own current values are what the table above already lists, and
      // `currentGroups` echoes them for the group field, so nothing here has to carry them.
      setFields((current) => ({
        ...current,
        port: value,
        accessVlan: '',
        nativeVlan: '',
        allowedRanges: '',
        trunkGroup: '',
      }))
      setPortSwitchNotice(abandoned === value ? 'The same port is still selected; no edit was discarded.' : `Edits for ${abandoned} were cleared without being staged, so nothing reached the device. The form now edits ${value}.`)
      return
    }
    setFields((current) => ({ ...current, [field]: value }))
  }

  /** The set an allowed-VLAN edit may operate on, or `undefined` when the spelling is a DR-028 keyword
   *  (no members to add to or take away from). An invalid spelling refuses with its own parse message. */
  function allowedBase(row: TrunkPortRow): { readonly ids: readonly number[] | undefined } | { readonly refusal: string } {
    const parsed = data?.allowed.get(row.name)
    if (parsed === undefined) return { ids: [] }
    if (parsed.kind === 'ids') return { ids: parsed.ids }
    if (parsed.kind === 'invalid') return { refusal: `The allowed-VLAN line on ${row.name} is not something this client would write, so there is no set to add to or remove from: ${parsed.message}` }
    return { ids: undefined }
  }

  /** The staged batch, or the reason nothing is staged. Client-side refusals mirror the client's own
   *  guards and name the rule, so an operator can tell an app gate from a device answer. */
  function plan(): Plan {
    if (selectedRow === undefined) return { refusal: 'There is no Layer 2 port to select, so nothing can be staged.' }
    if (!selectedRow.editable) return { refusal: `${selectedRow.name} is listed but not writable here: this client refuses to put that name behind interface <name> (DECISIONS.md open item 7), so the split-port name stays unreadable rather than half-written.` }

    const one = (verb: Parameters<typeof commandBuilder>): Plan => ({ batch: stageLines(submodeCommands(`interface ${selectedRow.name}`, [commandBuilder(verb[0], verb[1])])) })

    switch (fields.action) {
      case 'set-mode': {
        if (!isSwitchportMode(fields.mode)) return { refusal: `Mode must be one of ${SWITCHPORT_MODES.join(' / ')} — the client’s assertSwitchportMode refuses anything else (resources/switchports.ts:600-603). A spelling outside those four is shown in the table and never written (never coerced).` }
        return one(['switchport mode', { value: fields.mode }])
      }
      case 'no-mode': return one(['switchport mode', { mode: 'no' }])
      case 'access-vlan': {
        const id = Number(fields.accessVlan)
        if (fields.accessVlan.trim() === '' || !Number.isInteger(id)) return { refusal: notWholeId('An access VLAN', fields.accessVlan) }
        if (id < VLAN_ID_MIN || id > VLAN_ID_MAX) return { refusal: outOfWriteRange(id) }
        return one(['switchport access vlan', { value: id }])
      }
      case 'native-vlan': {
        const id = Number(fields.nativeVlan)
        if (fields.nativeVlan.trim() === '' || !Number.isInteger(id)) return { refusal: notWholeId('A native VLAN', fields.nativeVlan) }
        if (id < VLAN_ID_MIN || id > VLAN_ID_MAX) return { refusal: outOfWriteRange(id) }
        return one(['switchport trunk native vlan', { value: id }])
      }
      case 'no-native-vlan': return one(['switchport trunk native vlan', { mode: 'no' }])
      case 'allowed-replace':
      case 'allowed-add':
      case 'allowed-remove': {
        const base = allowedBase(selectedRow)
        if ('refusal' in base) return { refusal: base.refusal }
        const edit = applyAllowedVlansEdit(EDIT_KIND[fields.action], base.ids, fields.allowedRanges)
        if (!edit.ok) return { refusal: edit.message }
        if (!edit.changed) return { refusal: `The recomputed list (${edit.text}) is the set this port’s allowed-VLAN line already gives. Nothing would change, so no config session was opened.` }
        return one(['switchport trunk allowed vlan', { value: edit.text }])
      }
      case 'no-allowed': return one(['switchport trunk allowed vlan', { mode: 'no' }])
      case 'add-trunk-group':
      case 'remove-trunk-group': {
        // The gate is the write path itself, not only the disabled input: without an `available`
        // verdict nothing is staged, so no group command text reaches a config session (#67's rule).
        if (!groupAvailable) return { refusal: TRUNK_GROUP_UNAVAILABLE }
        const value = fields.trunkGroup.trim()
        const groupProblem = trunkGroupNameRefusal(value)
        if (groupProblem !== undefined) return { refusal: `A trunk-group name ${groupProblem}.` }
        if (fields.action === 'add-trunk-group') return one(['switchport trunk group', { value }])
        return one([`switchport trunk group ${value}`, { mode: 'no' }])
      }
    }
  }

  /** Risk sentences for the current selection/action — device answers first, phrased as possibilities. */
  function risksFor(row: TrunkPortRow, action: TrunkAction): readonly string[] {
    const management = data?.managementVlanIds ?? []
    const out: string[] = []
    const touchesNative = action === 'native-vlan' || action === 'no-native-vlan'
    const promotesToTrunk = action === 'set-mode' && fields.mode === 'trunk'
    if (data?.managementError !== undefined && (touchesNative || promotesToTrunk || row.hasAddress)) {
      out.push('The management-API read failed, so this app cannot say whether this port carries the in-band path. It asks for this confirm anyway rather than assuming the port is out-of-band.')
    }
    if (touchesNative && row.nativeVlan !== undefined && management.includes(row.nativeVlan)) {
      out.push(`VLAN ${String(row.nativeVlan)} is the trunk native VLAN on ${row.name}, and it is a VLAN the device reports serving eAPI on (show management api http-commands named ${data?.managementInterfacesNamed.join(', ') || 'nothing'}). Changing or clearing it may drop the management path this UI is using.`)
    }
    if (action === 'native-vlan') {
      const next = Number(fields.nativeVlan)
      if (Number.isInteger(next) && management.includes(next)) out.push(`The native VLAN you are writing, VLAN ${String(next)}, is a VLAN the device reports serving eAPI on. Making it native on this trunk may move or drop the in-band path.`)
    }
    if (promotesToTrunk && row.accessVlan !== undefined && management.includes(row.accessVlan)) {
      out.push(`${row.name} is currently an access port in VLAN ${String(row.accessVlan)}, which the device reports as a VLAN serving eAPI. Re-forming it as a trunk moves that membership to the allowed/native vocabulary — unproven on this box (no hardware pin) what EOS does to the in-band path mid-session, so this confirm exists because the answer could be “it drops”.`)
    }
    if ((touchesNative || promotesToTrunk) && row.hasAddress) {
      out.push(`${row.name} carries an ip address in the running-config, so it is a candidate management path independent of any VLAN read.`)
    }
    if (action === 'set-mode' && !row.editable) out.push(`${row.name} is selected but this client cannot write its name.`)
    if ((action === 'add-trunk-group' || action === 'remove-trunk-group') && groupFeature?.reason !== undefined) {
      out.push(`Capability answer for trunk groups: ${groupFeature.display}. ${groupFeature.reason}`)
    }
    if (action === 'add-trunk-group' && row.trunkGroups.includes(fields.trunkGroup.trim())) out.push(`${row.name} already carries the group ${fields.trunkGroup.trim()} in the parsed running-config. A device-side duplicate reply for re-adding it is unproven on this box (no hardware pin) — the probe proves presence, not this.`)
    return out
  }

  async function preview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || !canAct || node === undefined || draft !== undefined || selectedRow === undefined) return
    const staged = plan()
    if ('refusal' in staged) {
      setDraft(undefined)
      // A client-side refusal rides the same failure slot as a device error — and no session was opened.
      await operation.run(async () => { throw new Error(staged.refusal) })
      return
    }
    const portAtStage = selectedRow.name
    const risks = risksFor(selectedRow, fields.action)
    const riskVlan = riskVlanFor(selectedRow, fields.action, data?.managementVlanIds ?? [], Number(fields.nativeVlan))
    setRereadNotice('')
    setDraft(undefined)
    await operation.run(async () => {
      const session = await node.configSession({ description: `webui trunk ${fields.action.replace(/-/gu, ' ')} on ${portAtStage}` })
      const handle: Session = session
      setDraft({ session: handle, batch: staged.batch, risks, port: portAtStage, ...(riskVlan === undefined ? {} : { riskVlan }), commitAttempted: false })
      await handle.run(staged.batch)
      const diff = await handle.diff()
      setDraft({ session: handle, batch: staged.batch, risks, port: portAtStage, ...(riskVlan === undefined ? {} : { riskVlan }), diff, commitAttempted: false })
      return diff
    }, {
      progress: 'Staging the change and reading the device diff…',
      success: 'Review the device diff before committing this change.',
    })
  }

  function confirmLabelFor(row: TrunkPortRow, action: TrunkAction): string {
    const risky = row.name
    switch (action) {
      case 'native-vlan': return `Set native VLAN ${String(row.nativeVlan ?? fields.nativeVlan)} on ${risky}`
      case 'no-native-vlan': return `Clear the native VLAN on ${risky}`
      case 'set-mode': return `Set ${fields.mode} on ${risky}`
      case 'no-mode': return `Clear the mode on ${risky}`
      case 'access-vlan': return `Set access VLAN ${fields.accessVlan} on ${risky}`
      case 'no-allowed': return `Clear the allowed VLAN list on ${risky}`
      case 'allowed-replace':
      case 'allowed-add':
      case 'allowed-remove': return `Write the allowed VLAN list on ${risky}`
      case 'add-trunk-group': return `Add trunk group ${fields.trunkGroup.trim()} on ${risky}`
      case 'remove-trunk-group': return `Remove trunk group ${fields.trunkGroup.trim()} on ${risky}`
    }
  }

  function confirmBody(d: Draft, label: string): string {
    const parts = [`Commit session ${d.session.name} to ${d.port}? This changes running-config only, and ${label} is what the device answered as staged.`]
    if (d.risks.length > 0) parts.push(`Risk named by the device read:\n${d.risks.map((risk) => `  · ${risk}`).join('\n')}`)
    if (d.batch.some((line) => /allowed vlan/u.test(line))) parts.push('The device keeps the vocabulary question: which keyword forms (all / except … / forward all) it accepts is unclaimed here (DR-028), which is why this write carries an explicit id list.')
    parts.push('If this session is lost mid-commit, the change may still have applied — reconnect and refresh before any further action.')
    return parts.join(' ')
  }

  async function commitDraft() {
    if (busy || draft === undefined || draft.diff === undefined || !draft.session.hasDiffBeenRead() || draft.commitAttempted) return
    const row = rows.find((candidate) => candidate.name === draft.port)
    const hard = draft.risks.length > 0
    const label = row === undefined ? 'Commit to running-config' : confirmLabelFor(row, fields.action)
    const confirmLabel = hard && draft.riskVlan !== undefined ? `Commit despite the VLAN ${String(draft.riskVlan)} risk` : label
    if (!await confirm({
      title: hard ? `Confirm management-path risk on ${draft.port}` : 'Commit to running-config',
      body: confirmBody(draft, label),
      confirmLabel,
      destructive: true,
      subject: `${draft.session.name} · ${draft.port}`,
    })) return
    setDraft({ ...draft, commitAttempted: true })
    const committed = await operation.run(() => draft.session.commit(), {
      progress: 'Committing the reviewed change to running-config…',
      success: 'Changes committed to running-config. Startup-config was not changed.',
      failureSuffix: COMMIT_RECOVERY,
    })
    if (committed.ok) {
      setDraft(undefined)
      setRereadNotice(REREAD_NOTICE)
      read.reload()
    }
  }

  async function abortDraft() {
    if (busy || draft === undefined || draftView?.canAbort !== true) return
    if (!await confirm({ title: 'Abort staged changes', body: `Abort staged changes in session ${draft.session.name}? Its staged ${draft.batch.join(' · ')} will be discarded.`, confirmLabel: 'Abort staged changes', destructive: true, subject: draft.session.name })) return
    const aborted = await operation.run(async () => {
      await draft.session.abort()
      setDraft(undefined)
      return draft.session.name
    }, { success: `Session ${draft.session.name} was aborted; nothing was written to the device.` })
    if (aborted.ok) read.reload()
  }

  async function abortPending(session: TrunkSessionRow) {
    if (busy || node === undefined || !/pending/iu.test(session.state)) return
    if (!await confirm({ title: 'Abort pending device session', body: `Abort pending device session ${session.name}? Its staged changes will be discarded. A pending session holds the config lock, which is why a preview fails until it is cleared.`, confirmLabel: 'Abort pending session', destructive: true, subject: session.name })) return
    const aborted = await operation.run(async () => {
      await node.abortSession(session.name)
      return session.name
    }, { success: `Pending session ${session.name} was aborted.` })
    if (aborted.ok) read.reload()
  }

  const messages: readonly TrunkMessage[] = selectedRow === undefined || data === undefined ? [] : [
    ...(rereadNotice === '' ? [] : [{ tone: 'success' as const, text: rereadNotice }]),
    ...(portSwitchNotice === '' ? [] : [{ tone: 'info' as const, text: portSwitchNotice }]),
    ...(!selectedRow.hasSwitchportRecord ? [{ tone: 'warning' as const, text: NO_SWITCHPORT_RECORD_NOTE }] : []),
    ...(selectedRow.allowedRaw !== undefined && !selectedRow.allowedEnumerable ? [{ tone: 'warning' as const, text: `The allowed-VLAN spelling on ${selectedRow.name} is not enumerable here (DR-028): ${selectedRow.allowedNote ?? selectedRow.allowedRaw}. A write here must name the ids explicitly.` }] : []),
    ...risksFor(selectedRow, fields.action).map((text) => ({ tone: 'risk' as const, text })),
    ...(hasLocalEdits(fields, selectedRow) ? [{ tone: 'info' as const, text: LOCAL_EDIT_NOTICE }] : []),
  ]

  const capabilityView: TrunkCapabilityView = {
    verdict: groupFeature?.display ?? 'unknown',
    // The shared classifier's reason already quotes the device's own numeric answer
    // (`switchport trunk group webui-probe: 1002 COMMAND_INVALID`), so it is passed through unchanged —
    // appending the code again would print the same number twice (#73).
    ...(groupFeature?.reason === undefined ? {} : { reason: groupFeature.reason }),
    status: capabilities.view.status,
    fromCache: capabilities.view.fromCache,
    configLocked: capabilities.view.configLocked,
    probePendingSessions: capabilities.view.pendingSessions.map(sessionRow),
    probeFailure: capabilities.view.failure ?? '',
    // One pending session, one control: the device-session panel below lists what the read found, so the
    // probe-cleanup section explains the same rows instead of offering a second identical write button.
    pendingSessionsRendered: (data?.sessions ?? []).some((row) => capabilities.view.pendingSessions.some((session) => session.name === row.name)),
    candidates: candidateList(TRUNK_GROUP_PROBE),
    suppressedCount: capabilities.view.suppressedCount,
    canProbe: canAct,
    probeBusy: busy || capabilities.view.status === 'probing',
  }

  const load: TrunkLoadState = read.state.kind === 'loading'
    ? { kind: 'loading' }
    : read.state.kind === 'error'
      ? { kind: 'error', message: read.state.message }
      : { kind: 'ready', data: {
        rows: data?.rows ?? [],
        vlanOptions: data?.vlanOptions ?? [],
        sessions: data?.sessions ?? [],
        managementInterfaces: data?.managementInterfacesNamed ?? [],
        ...(data?.managementError === undefined ? {} : { managementError: data.managementError }),
      } }

  const identity = data?.identity

  return <TrunkEditorView
    load={load}
    connection={read.state.kind === 'ready' ? 'connected' : read.state.kind === 'error' ? 'error' : 'connecting'}
    {...(identity === undefined ? {} : { identity })}
    fields={{ ...fields, port }}
    modes={SWITCHPORT_MODES}
    {...(draftView === undefined ? {} : { draft: draftView })}
    canWrite={canAct}
    busy={busy}
    messages={messages}
    failure={failure}
    notice={notice}
    onFieldChange={changeField}
    onPreview={preview}
    onCommit={() => void commitDraft()}
    onAbortDraft={() => void abortDraft()}
    onReload={read.reload}
    onAbortPending={(session) => void abortPending(session)}
    currentGroups={selectedRow?.trunkGroups ?? []}
    capability={capabilityView}
    onProbe={() => void capabilities.probe({ force: true })}
    onAbortProbePending={() => void capabilities.abortPendingSessions()}
  />
}

function rowFor(
  name: string,
  interfaces: ReadonlyMap<string, Interface>,
  switchports: ReadonlyMap<string, Switchport>,
  allowed: ReadonlyMap<string, AllowedVlanParse>,
  addresses: ReadonlyMap<string, IpInterface>,
  managementVlanIds: readonly number[],
): TrunkPortRow {
  const entered = interfaces.get(name)
  const entry = switchports.get(name)
  const parsed = allowed.get(name)
  const mode = entry?.mode
  // The client's own kind parse answers `null` for a name its grammar has no form for (open item 7).
  // That is kept as `Unrecognised` here rather than inferred from the switchport record, so the note an
  // operator sees comes from the same grammar decision the write gate makes.
  const kind = entered === undefined
    ? (entry === undefined ? 'Unrecognised' : 'Switchport section')
    : entered.kind === null
      ? 'Unrecognised'
      : entered.kind
  return {
    name,
    kind,
    trunkGroups: entry?.trunkGroups ?? [],
    editable: isInterfaceName(name),
    ...(mode === undefined ? {} : { mode }),
    modeKnown: isSwitchportMode(mode),
    ...(entry?.accessVlan === undefined ? {} : { accessVlan: entry.accessVlan }),
    ...(entry?.trunkNativeVlan === undefined ? {} : { nativeVlan: entry.trunkNativeVlan }),
    ...(entry?.trunkAllowedVlans === undefined ? {} : { allowedRaw: entry.trunkAllowedVlans }),
    allowedEnumerable: parsed?.kind === 'ids',
    ...(parsed === undefined || parsed.kind === 'ids' ? {} : { allowedNote: parsed.kind === 'keyword' ? 'keyword spelling, not enumerable here (DR-028)' : parsed.message }),
    ...(parsed?.kind === 'ids' ? { allowedDisplay: parsed.display } : {}),
    nativeIsManagement: entry?.trunkNativeVlan !== undefined && managementVlanIds.includes(entry.trunkNativeVlan),
    accessIsManagement: entry?.accessVlan !== undefined && managementVlanIds.includes(entry.accessVlan),
    hasAddress: addresses.has(name),
    hasSwitchportRecord: entry !== undefined,
  }
}

/** Which sections this screen offers: every switchport record, plus every Ethernet / Port-Channel
 *  section the running-config named. The split mirrors the client's own switchport-section grammar;
 *  it says nothing about what the SKU supports. */
function isCandidate(entered: Interface | undefined, hasSwitchport: boolean): boolean {
  if (hasSwitchport) return true
  return entered?.kind === 'Ethernet' || entered?.kind === 'Port-Channel'
}

const vlanOption = (vlan: Vlan): TrunkVlanOption => ({ id: Number(vlan.id), ...(vlan.name === undefined ? {} : { name: vlan.name }) })
const sessionRow = (session: ConfigSessionSummary): TrunkSessionRow => ({ name: session.name, state: session.state, ...(session.description === undefined ? {} : { description: session.description }) })

/** Whether the current action's field holds a value the device has not been told about. */
function hasLocalEdits(fields: TrunkFields, row: TrunkPortRow): boolean {
  switch (fields.action) {
    case 'add-trunk-group':
    case 'remove-trunk-group': {
      const value = fields.trunkGroup.trim()
      if (value === '') return false
      return fields.action === 'add-trunk-group' ? !row.trunkGroups.includes(value) : row.trunkGroups.includes(value)
    }
    case 'set-mode': return (row.mode ?? '') !== fields.mode
    case 'access-vlan': return fields.accessVlan.trim() !== '' && row.accessVlan !== Number(fields.accessVlan)
    case 'native-vlan': return fields.nativeVlan.trim() !== '' && row.nativeVlan !== Number(fields.nativeVlan)
    case 'allowed-replace':
    case 'allowed-add':
    case 'allowed-remove': return fields.allowedRanges.trim() !== ''
    case 'no-mode':
    case 'no-native-vlan':
    case 'no-allowed': return false
  }
}
