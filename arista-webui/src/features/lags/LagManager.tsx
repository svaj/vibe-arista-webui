/**
 * S5 (#75): the Port-Channel / LAG manager — container half.
 *
 * Route `#/lags`. Consumes F1-F7 like the other screens; the write path is the standing
 * named-session shape: preview (session + `run` + device `diff()`) → explicit confirm → commit →
 * reload. Running-config only, `copy run start` never (DR-024).
 *
 * ## What the table is built from
 *
 * - Config side (hard read): `interfaces.getAll({ status: 'skip' })`. The Port-Channel sections carry
 *   the whole `InterfacePortChannelFields` group — members harvested from each member section's
 *   `channel-group <id>[ mode <x>]` body line (the client's relation, **DR-075**), plus this section's
 *   own `port-channel min-links / lacp fallback / lacp fallback timeout` lines. `switchports.getAll()`
 *   joins the bundle's L2 state, `ipinterfaces.getAll()` the in-band guard signal, `listSessions()` the
 *   device-session panel.
 * - Device side (SOFT read): `show port-channel dense`, typed in `src/eapi/show-contracts.ts` from the
 *   two committed positive captures (hardware sweep + cEOS). STATUS.md:143 routes the LAG screens here
 *   specifically because `show lag`/`lag resources` are committed **negatives** on both targets — the
 *   `lag` keys stay a permanent non-contract and no status pill here is ever derived from them. The
 *   dense answer fills ONLY the device columns; its failure is a notice, never an empty table.
 * - Separate on-demand verb: "Check membership on the device" runs `interfaces.getMembers(name)` —
 *   the `show port-channel <id> all-ports` text scrape #75 explicitly keeps out of the default read
 *   (DR-075); the result panel is labelled as that one-off answer.
 *
 * ## Issue #75's "member shutdown before joining" — checked against the source, and it is not there
 *
 * The issue says the client preserves *"the upstream batch that shuts down member interfaces before
 * joining" (pyeapi `interfaces.py:677-717`)*. I re-read the pinned clone: `set_members` composes
 * `interface <m>` + `no channel-group <id>` pairs, then `interface <m>` + `channel-group <id> mode <x>`
 * pairs — **no `shutdown` command anywhere** (`grep shutdown pyeapi/api/interfaces.py` lands only in
 * the Ethernet attribute vocabulary, `:96`/`:268`), and neither does the client
 * (`resources/interfaces.ts`, `setMembers`/`rewriteMembers`) nor the extracted 4.28 grammar of the
 * member-side command itself (`CliPlugin/LagCli.py:440-449`, which is `channel-group`, not
 * `port-group` — `port-group` is the QSFP/SFP optics grouping verb, AlePortGroupCli.py:33). What IS real,
 * source-verified, and what #75's guard is actually about, is §5 row 130 / DR-080: a **mode change is
 * two transactions — every member is detached, then re-attached**, "momentarily detaching the whole
 * LAG". So the screen (a) stages the client's exact text and order, (b) warns in copy that join/leave
 * is generally expected to briefly detach a member — explicitly labelled model-general reasoning, not a
 * capture on this unit — and (c) never claims a `shutdown` line is part of any batch. The correction is
 * recorded on the issue.
 *
 * ## Capacity: never rendered as a limit
 *
 * DECISIONS open item 6 retired the 16-ports/64-members prose (wrong-SKU matrix lineage). The inventory
 * strip shows only what the device itself answered to `show port-channel dense` (counts where the read
 * answered), with a visible note that no platform maximum is claimed anywhere on this screen.
 *
 * ## Gated vocabulary
 *
 * `port-channel lacp fallback [timeout]` presence is F5-probed against a fixed candidate set staged in
 * a config session the client always aborts (DR-063) — the same shape as S3's trunk-group gate, and
 * what an `available` verdict proves is grammar presence only. Until then the fallback/timeout actions
 * are refused in `plan()` as well as disabled in the markup. Unknown is never read as supported.
 */
import { useState } from 'react'
import type { FormEvent } from 'react'
import { commandBuilder, isInterfaceName, submodeCommands } from '@devhax-heavy-industries/arista-eapi'
import type { ConfigSession, FeatureProbeCommands, Interface, Node } from '@devhax-heavy-industries/arista-eapi'

import { identityFrom } from '../../shared/identity'
import type { DeviceIdentity } from '../../shared/identity'
import { softErrorText, softRead, softValue, useDeviceRead } from '../../shared/use-device-read'
import { useOperation } from '../../shared/use-operation'
import { ConfirmProvider, useConfirm } from '../../shared/use-confirm'
import { candidateList, useCapabilities } from '../../shared/use-capabilities'
import type { CapabilityClient } from '../../shared/use-capabilities'
import { managementInterfaces } from '../interfaces/InterfacesDashboard'
import { stageLines } from '../staged-batch'
import { LagManagerView } from './LagManagerView'
import type { LagAction, LagCapabilityView, LagDraftView, LagFields, LagLiveCheck, LagManagerViewProps, LagRow, LagSessionRow, PortRow } from './LagManagerView'
import type { ShowManagementApiHttpCommandsReply, ShowPortChannelDenseAggregator } from '../../eapi/show-contracts'

// The screen contracts ride this import (ARCHITECTURE §9.1 augmentation), so
// `node.show('port-channel dense')` and `node.show('management api http-commands')` type end-to-end.
import '../../eapi/show-contracts'

export type LagManagerClient = Pick<Node, 'interfaces' | 'switchports' | 'ipinterfaces' | 'configSession' | 'listSessions' | 'abortSession' | 'show'>
type Client = LagManagerClient & CapabilityClient

/** The capability questions #75 names as probe-gated, in the S3 idiom: `interface` context line plus
 *  the gated line, staged in a `no-commit` session the client always aborts (DR-063). The group numbers
 *  999/1 are probe-only spellings — the capture lane's own LACP abort evidence staged `channel-group
 *  999` the same way (DECISIONS DR-135), so the staged probe text matches something the box has already
 *  answered inside an aborted session. Both map keys must carry every line exactly as sent
 *  (capabilities.ts:479 attributes by this list — anything missing classifies `unknown`). */
export const LAG_LACP_PROBE: FeatureProbeCommands = {
  portChannelLacpFallback: ['interface Port-Channel999', 'port-channel lacp fallback static'],
  portChannelLacpTimeout: ['interface Port-Channel1', 'port-channel lacp fallback timeout 90'],
}

/**
 * Mirrors the client's module-local `LACP_MODES` / `LACP_FALLBACK_MODES`
 * (`resources/interfaces.ts:658-662`) — they are not re-exported from the package entry, and the
 * standing precedent for mirroring a client rule app-side is `src/shared/allowed-vlans.ts`. The
 * device keeps authority: a token outside these stays a parse/display question, never a coercion.
 */
export const LAG_MODES: readonly string[] = ['active', 'passive', 'on']
export const LAG_FALLBACK_MODES: readonly string[] = ['individual', 'static']

export interface LagManagerProps {
  readonly node: Client | undefined
  readonly proxyConfigured?: boolean
}

const PROXY_PROMPT = 'Local proxy is not configured. Set EAPI_HOST, EAPI_USER, and EAPI_PASS in arista-webui/.env.local, then restart Vite.'
const COMMIT_RECOVERY = 'Commit may have applied — reconnect and refresh before any further action.'

type Session = Pick<ConfigSession, 'name' | 'state' | 'run' | 'diff' | 'hasDiffBeenRead' | 'commit' | 'abort'>

type Draft = { session: Session; batch: readonly string[]; diff?: string; commitAttempted: boolean; risks: readonly string[]; lag: string; destructive: boolean }

type Data = {
  rows: readonly LagRow[]
  ports: readonly PortRow[]
  sessions: readonly LagSessionRow[]
  identity?: DeviceIdentity
  denseError?: string
  managementError?: string
  managementNamed: readonly string[]
}

const DEFAULT_FIELDS: LagFields = {
  action: 'set-members',
  group: '',
  description: '',
  members: [],
  mode: '',
  minLinks: '',
  fallbackMode: '',
  timeout: '',
}

const DEVICE_ORDER = (left: string, right: string) => left.localeCompare(right, undefined, { numeric: true })

/** The channel-group id the client keys the relation by (`GROUP_ID = /([0-9]+)/u` on the name). */
export function groupIdOf(name: string): string {
  return /([0-9]+)/u.exec(name)?.[1] ?? ''
}

const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const point = character.codePointAt(0) ?? 0
    return point <= 0x1f || point === 0x7f
  })

/** The positive-whole-number rule mirrored from the client's `assertPortBandValue`: a safe integer > 0.
 *  The platform range is a device answer and is NOT claimed here. */
function bandValueRefusal(value: string, label: string): string | undefined {
  if (!/^\d+$/u.test(value.trim())) return `${label} must be a whole number — the client's assertPortBandValue refuses anything else in the composed line (resources/interfaces.ts:1045). Bounds above that are device answers; this screen invents none.`
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return `${label} must be a positive whole number the client can carry — same rule as assertPortBandValue; an absent setting stays absent, never a fabricated default (DR-076).`
  return undefined
}

/** Members the config relation names for a LAG row, defaulted so a `Set` diff never sees `undefined`. */
const configMembers = (row: LagRow | undefined): readonly string[] => row?.members ?? []

export function LagManager(props: LagManagerProps) {
  return <ConfirmProvider><LagWorkspace {...props} /></ConfirmProvider>
}

function LagWorkspace({ node, proxyConfigured = true }: LagManagerProps) {
  const confirm = useConfirm()
  const operation = useOperation()
  const { busy, notice, failure } = operation
  const [fields, setFields] = useState<LagFields>(DEFAULT_FIELDS)
  const [selected, setSelected] = useState('')
  // The membership checkboxes start as the truth of the selected bundle (synced below); this flag says
  // when the operator has edited them, so a first-visit auto-selection never reads as "the desired set
  // is empty" and stage a delete-everything diff.
  const [membershipEdited, setMembershipEdited] = useState(false)
  const [draft, setDraft] = useState<Draft>()
  const [live, setLive] = useState<readonly LagLiveCheck[]>()

  const canAct = proxyConfigured && node !== undefined

  const capabilities = useCapabilities({
    ...(node === undefined ? { node: undefined } : { node: node as Client }),
    featureProbeCommands: LAG_LACP_PROBE,
    enabled: canAct,
  })
  const fallbackFeature = capabilities.view.features.find((feature) => feature.name === 'portChannelLacpFallback')
  const timeoutFeature = capabilities.view.features.find((feature) => feature.name === 'portChannelLacpTimeout')

  const read = useDeviceRead<Data>(
    async () => {
      if (node === undefined) throw new Error(PROXY_PROMPT)
      const densePromise = node.show('port-channel dense')
      const managementPromise = node.show('management api http-commands')
      const versionPromise = node.show('version').then(identityFrom)
      const [interfaces, switchports, addresses, sessions, dense, management, version] = await Promise.all([
        node.interfaces.getAll({ status: 'skip' }),
        node.switchports.getAll(),
        node.ipinterfaces.getAll(),
        node.listSessions(),
        softRead(densePromise),
        softRead(managementPromise),
        softRead(versionPromise, { silent: true }),
      ])

      const denseReply = softValue(dense)
      const denseChannels = denseReply?.portChannels ?? {}
      const bundles = new Map<string, Interface>()
      const ethernets = new Map<string, Interface>()
      for (const [name, entered] of interfaces) {
        if (entered.kind === 'Port-Channel') bundles.set(name, entered)
        else if (name.startsWith('Ethernet')) ethernets.set(name, entered)
      }
      // The dense answer can name a channel this unit's config read did not (or vice versa); listing
      // the union and flagging the disagreement is honest, silently taking one side is not.
      const lagNames = [...new Set([...bundles.keys(), ...Object.keys(denseChannels)])].sort(DEVICE_ORDER)

      const membershipByPort = new Map<string, string>()
      for (const name of lagNames) {
        for (const member of bundles.get(name)?.portChannel?.members ?? []) {
          if (!membershipByPort.has(member)) membershipByPort.set(member, name)
        }
      }

      const devicePortsByName = new Map<string, { readonly group: string; readonly bundled: boolean; readonly misconfig?: string; readonly linkDown?: boolean }>()
      for (const [lagName, entry] of Object.entries<ShowPortChannelDenseAggregator | undefined>(denseChannels)) {
        if (entry === undefined) continue
        for (const [port, portEntry] of Object.entries(entry.ports)) {
          devicePortsByName.set(port, {
            group: lagName,
            bundled: portEntry.lagMember,
            // `status` is required on the contract (both captures carry it); an empty string is still
            // the device's answer, so it is passed through rather than treated as absent.
            misconfig: portEntry.lacpMisconfig.status,
            linkDown: portEntry.linkDown,
          })
        }
      }

      const rows: LagRow[] = lagNames.map((name) => {
        const entered = bundles.get(name)
        const device = denseChannels[name]
        const configuredMembers = entered?.portChannel?.members
        const deviceBundled = device === undefined ? undefined : Object.entries(device.ports).filter(([, port]) => port.lagMember).map(([port]) => port).sort(DEVICE_ORDER)
        // A config section with NO members and a dense answer that bundles ports IS a disagreement —
        // comparing against `[]` (not bailing on `undefined`) matters exactly there.
        const disagree = device === undefined
          ? undefined
          : (configuredMembers ?? []).slice().sort(DEVICE_ORDER).join(',') !== deviceBundled?.slice().sort(DEVICE_ORDER).join(',')
        const address = addresses.get(name)
        const switchport = switchports.get(name)
        return {
          name,
          group: groupIdOf(name),
          ...(configuredMembers === undefined ? {} : { members: configuredMembers }),
          ...(entered?.portChannel?.lacpMode === undefined ? {} : { lacpMode: entered.portChannel.lacpMode }),
          ...(entered?.portChannel?.minimumLinks === undefined ? {} : { minimumLinks: entered.portChannel.minimumLinks }),
          ...(entered?.portChannel?.lacpFallback === undefined ? {} : { lacpFallback: entered.portChannel.lacpFallback }),
          ...(entered?.portChannel?.lacpTimeout === undefined ? {} : { lacpTimeout: entered.portChannel.lacpTimeout }),
          ...(switchport?.mode === undefined ? {} : { l2Mode: switchport.mode }),
          ...(address?.address === undefined ? {} : { address: address.address }),
          ...(device === undefined ? {} : {
            deviceLinkState: device.linkState,
            deviceProtocol: device.protocol,
            deviceInactive: device.inactive,
            ...(disagree === undefined ? {} : { deviceMembersDisagree: disagree }),
          }),
        }
      })

      const portNames = [...new Set([...ethernets.keys(), ...devicePortsByName.keys()])].sort(DEVICE_ORDER)
      const ports: PortRow[] = portNames.map((name) => {
        const device = devicePortsByName.get(name)
        const address = addresses.get(name)
        return {
          name,
          ...(membershipByPort.get(name) === undefined ? {} : { groupOf: membershipByPort.get(name) }),
          ...(device === undefined ? {} : {
            deviceBundled: device.bundled,
            ...(device.misconfig === undefined ? {} : { deviceMisconfig: device.misconfig }),
            deviceLinkDown: device.linkDown,
          }),
          carriesAddress: address?.address !== undefined,
          clientWritableName: isInterfaceName(name),
        }
      })

      const identity = softValue(version)
      return {
        rows,
        ports,
        sessions: sessions.sessions.map((session) => ({ name: session.name, state: session.state })),
        ...(identity === undefined ? {} : { identity }),
        ...(softErrorText(dense) === undefined ? {} : { denseError: softErrorText(dense) }),
        ...(softErrorText(management) === undefined ? {} : { managementError: softErrorText(management) }),
        managementNamed: managementInterfaces(softValue(management) as ShowManagementApiHttpCommandsReply | undefined),
      }
    },
    [node],
    { enabled: canAct, disabledMessage: PROXY_PROMPT },
  )

  const data = read.state.kind === 'ready' ? read.state.data : undefined
  const rows = data?.rows ?? []
  const ports = data?.ports ?? []
  const selectedRow = rows.find((row) => row.name === selected) ?? rows[0]
  const lagName = selectedRow?.name ?? ''
  const group = selectedRow?.group ?? groupIdOf(lagName)

  function selectLag(name: string) {
    setSelected(name)
    setLive(undefined)
    setMembershipEdited(false)
  }

  /**
   * The checkbox set starts as the truth of the selected bundle (the synced view fields below) and
   * stays synced until the FIRST toggle, which seeds from that same truth — an untouched form can
   * therefore never stage a delete-everything diff, and `plan()` always diffs against what the operator
   * sees. The diff itself mirrors `setMembers`: uncheck = remove pair, check = add pair, and a no-op
   * selection composes nothing (the client's `if commands else True` rule, DR-080 row 130).
   */
  function memberToggle(name: string, checked: boolean) {
    const base = membershipEdited ? fields.members : [...configMembers(selectedRow)]
    setMembershipEdited(true)
    setFields((current) => ({
      ...current,
      members: checked ? [...base, name].sort(DEVICE_ORDER) : base.filter((member) => member !== name),
    }))
  }

  const desiredMembers = membershipEdited ? fields.members : [...configMembers(selectedRow)]

  function featureFor(action: LagAction) {
    return action === 'set-lacp-timeout' ? timeoutFeature : fallbackFeature
  }
  const gatedAction = fields.action === 'set-lacp-fallback' || fields.action === 'clear-lacp-fallback' || fields.action === 'set-lacp-timeout'
  const gateFeature = gatedAction ? featureFor(fields.action) : undefined
  const gateOpen = gateFeature?.display === 'available'

  /** The staged batch: every text below is the exact spelling a pinned client verb composes —
   *  `setMembers`/`rewriteMembers` (the channel-group pairs, removals-then-adds, DR-080) and the
   *  `port-channel …` keywords (`MIN_LINKS_KEYWORD`/`LACP_FALLBACK_KEYWORD`/`LACP_TIMEOUT_KEYWORD`,
   *  resources/interfaces.ts:774-776) through the same `commandBuilder` framing the verbs use. */
  function plan(): { batch: readonly string[] } | { refusal: string } {
    if (fields.action === 'create-lag') {
      const digits = fields.group.trim()
      if (digits === '' || !/^\d+$/u.test(digits)) {
        return { refusal: 'A Port-Channel needs a whole-number group: the client extracts the digits to key the channel-group relation (assertPortChannelName — resources/interfaces.ts:971). No capacity ceiling is claimed, so any digits are offered; the device decides what it creates.' }
      }
      const name = `Port-Channel${digits}`
      if (rows.some((row) => row.name === name)) return { refusal: `${name} already exists in the running-config — pick the membership or LACP action instead of re-creating it.` }
      const description = fields.description.trim()
      if (fields.description !== '' && description === '') return { refusal: 'A description needs a value, or leave it empty and this stages only the interface line — an empty description is `no description`, never a trailing space (the client refuses it the same way).' }
      if (description.includes('"')) return { refusal: 'This client cannot read a description containing a double quote back (assertInterfaceDescription, MIGRATION.md §5 row 49) — nothing is staged.' }
      if (/[\r\n\u0085\u2028\u2029]/u.test(fields.description) || hasControlCharacter(fields.description)) return { refusal: 'A description may not carry line breaks or control characters — one command line per command.' }
      const tail = description === '' ? [] : [commandBuilder('description', { value: description })]
      return { batch: stageLines(submodeCommands(`interface ${name}`, tail)) }
    }

    if (selectedRow === undefined) return { refusal: 'There is no Port-Channel selected, and this action needs one. Create one first or reload.' }

    switch (fields.action) {
      case 'delete-lag':
        return { batch: [`no interface ${selectedRow.name}`] }
      case 'set-members': {
        const current = configMembers(selectedRow)
        const desired = desiredMembers
        const removals = current.filter((member) => !desired.includes(member))
        const additions = desired.filter((member) => !current.includes(member))
        if (removals.length === 0 && additions.length === 0) {
          return { refusal: 'The checked set already names exactly the members in the running-config. The client composes nothing for a no-change diff (pyeapi `if commands else True`, pinned as DR-080 row 130), so no config session was opened.' }
        }
        const mode = fields.mode === '' ? selectedRow.lacpMode : fields.mode
        if (additions.length > 0 && (mode === undefined || !LAG_MODES.includes(mode))) {
          return { refusal: 'Joining a port needs a mode this client will write: the group\'s own `channel-group` lines carry none, and the client refuses to reuse a mode it cannot read rather than writing pyeapi\'s literal `mode None` (DR-077, resources/interfaces.ts setMembers). Pick active, passive or on.' }
        }
        const batch: string[] = []
        for (const member of removals) batch.push(`interface ${member}`, `no channel-group ${group}`)
        for (const member of additions) batch.push(`interface ${member}`, additions.length > 0 && mode !== undefined ? `channel-group ${group} mode ${mode}` : `channel-group ${group}`)
        return { batch }
      }
      case 'set-lacp-mode': {
        if (!LAG_MODES.includes(fields.mode)) return { refusal: `Mode must be one of ${LAG_MODES.join(' / ')} — the client's assertLacpMode refuses anything else, and a device line carrying a different token fails this table's read rather than being coerced (DR-079).` }
        const members = configMembers(selectedRow)
        if (members.length === 0) return { refusal: `${selectedRow.name} has no members in the config relation, and there is nothing to re-form: the client performs no transaction for a memberless group (DR-080 row 130 — upstream opened an empty 'configure terminal'; this screen stages nothing).` }
        const batch: string[] = []
        for (const member of members) batch.push(`interface ${member}`, `no channel-group ${group}`)
        for (const member of members) batch.push(`interface ${member}`, `channel-group ${group} mode ${fields.mode}`)
        return { batch }
      }
      case 'set-min-links': {
        const refusal = bandValueRefusal(fields.minLinks, 'Minimum-links')
        if (refusal !== undefined) return { refusal }
        return { batch: stageLines(submodeCommands(`interface ${selectedRow.name}`, [commandBuilder('port-channel min-links', { value: Number(fields.minLinks) })])) }
      }
      case 'clear-min-links':
        return { batch: stageLines(submodeCommands(`interface ${selectedRow.name}`, [commandBuilder('port-channel min-links', { mode: 'no' })])) }
      case 'default-min-links':
        return { batch: stageLines(submodeCommands(`interface ${selectedRow.name}`, [commandBuilder('port-channel min-links', { mode: 'default' })])) }
      case 'set-lacp-fallback': {
        if (!gateOpen) return { refusal: gateRefusal(gateFeature, 'lacp fallback') }
        if (!LAG_FALLBACK_MODES.includes(fields.fallbackMode)) return { refusal: `Fallback mode must be one of ${LAG_FALLBACK_MODES.join(' / ')} — the client's assertLacpFallbackMode refuses the rest, including 'disabled', which is the CLEAR action's intent, not a mode (DR-037/DR-077).` }
        return { batch: stageLines(submodeCommands(`interface ${selectedRow.name}`, [commandBuilder('port-channel lacp fallback', { value: fields.fallbackMode })])) }
      }
      case 'clear-lacp-fallback': {
        if (!gateOpen) return { refusal: gateRefusal(gateFeature, 'lacp fallback') }
        return { batch: stageLines(submodeCommands(`interface ${selectedRow.name}`, [commandBuilder('port-channel lacp fallback', { mode: 'no' })])) }
      }
      case 'set-lacp-timeout': {
        if (!gateOpen) return { refusal: gateRefusal(gateFeature, 'lacp fallback timeout') }
        const refusal = bandValueRefusal(fields.timeout, 'The fallback timeout')
        if (refusal !== undefined) return { refusal }
        return { batch: stageLines(submodeCommands(`interface ${selectedRow.name}`, [commandBuilder('port-channel lacp fallback timeout', { value: Number(fields.timeout) })])) }
      }
    }
  }

  function gateRefusal(feature: ReturnType<typeof featureFor>, what: string): string {
    return `The ${what} change is refused before anything is staged: the capability verdict for this vocabulary is ${feature?.display ?? 'unknown'}${feature?.reason === undefined ? '' : ` (${feature.reason})`}. #75 requires an *available* probe answer, and the probe rides a config session the client always aborts (DR-063) — it proves grammar presence only, never capacity.`
  }

  /** Risk sentences for the confirm body — device answers first, model-general reasoning labelled as such. */
  function risksFor(d: { action: LagAction; lag: string; batch: readonly string[] }): readonly string[] {
    const out: string[] = []
    const row = rows.find((candidate) => candidate.name === d.lag)
    const serving = data?.managementNamed ?? []
    if (d.action === 'delete-lag' && row !== undefined && configMembers(row).length > 0) {
      out.push(`The config relation still names members (${configMembers(row).join(', ')}). This unit's own answer to deleting a non-empty bundle is uncaptured; the client's hand-authored fixture shows the expected refusal shape (“port-channel has members”), and if the device refuses, the error below is the device's, not a half deleted bundle.`)
    }
    if (d.action === 'set-members' || d.action === 'set-lacp-mode') {
      const touched = [...new Set(d.batch.filter((line) => line.startsWith('interface ')).map((line) => line.slice('interface '.length)))]
      const addressed = touched.filter((name) => ports.find((port) => port.name === name)?.carriesAddress === true)
      const served = touched.filter((name) => serving.includes(name))
      if (addressed.length > 0) out.push(`${addressed.join(', ')} carries an ip address in the running-config, so unbundling it may move or drop the management path this UI may be riding.`)
      if (served.length > 0) out.push(`${served.join(', ')} is a port the device itself names as serving eAPI (${data?.managementNamed.join(', ') || 'no answer'}): touching it can drop this session — mid-commit loss may still have applied.`)
      out.push('Joining or detaching a member is expected generally to take the member link down briefly (the channel-group line appearing or disappearing is what re-forms it); whether EOS flaps administratively on THIS unit is not captured. Nothing in this batch composes a `shutdown` command — see the container header.')
      if ((row?.minimumLinks ?? 0) > 1 && d.action === 'set-members') {
        out.push(`${d.lag} already has port-channel min-links ${String(row?.minimumLinks)} configured — a membership change that leaves fewer links up can make the bundle itself stop forwarding, depending on which ports the device keeps up.`)
      }
      if (d.action === 'set-lacp-mode') out.push('Every current member is detached and re-attached (the pinned two-stage order, DR-080 §5 row 130) — "momentarily detaching the whole LAG" is the client doc’s own words for what this batch costs.')
      if (data?.managementError !== undefined && (addressed.length > 0 || touched.length > 0)) out.push('The management-API read failed, so “not an eAPI path” cannot be promised for any of these ports.')
    }
    if (d.action === 'set-min-links') {
      const members = configMembers(row).length
      const value = Number(fields.minLinks)
      if (Number.isSafeInteger(value) && value < members) {
        out.push(`This collapses min-links below the ${members} members the config relation currently names (${configMembers(row).join(', ')}). Whether that drops the bundle now or only changes what a later link failure costs is a device answer — #75's guard says name it, so this confirm exists.`)
      }
    }
    if ((d.action === 'set-lacp-fallback' || d.action === 'clear-lacp-fallback' || d.action === 'set-lacp-timeout') && gateFeature?.reason !== undefined) {
      out.push(`Capability answer for this vocabulary: ${gateFeature.display}. ${gateFeature.reason}`)
    }
    return out
  }

  async function preview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || !canAct || node === undefined || draft !== undefined) return
    const staged = plan()
    if ('refusal' in staged) {
      setDraft(undefined)
      await operation.run(async () => { throw new Error(staged.refusal) })
      return
    }
    const lagAtStage = fields.action === 'create-lag' ? `Port-Channel${fields.group.trim()}` : lagName
    const risks = risksFor({ action: fields.action, lag: lagAtStage, batch: staged.batch })
    const destructive = fields.action === 'delete-lag' || fields.action === 'set-lacp-mode' || (fields.action === 'set-min-links' && Number(fields.minLinks) < configMembers(selectedRow).length)
    setDraft(undefined)
    await operation.run(async () => {
      const session = await node.configSession({ description: `webui lag ${fields.action.replace(/-/gu, ' ')} on ${lagAtStage === '' ? 'new' : lagAtStage}` })
      const handle: Session = session
      setDraft({ session: handle, batch: staged.batch, risks, lag: lagAtStage, destructive, commitAttempted: false })
      await handle.run(staged.batch)
      const diff = await handle.diff()
      setDraft({ session: handle, batch: staged.batch, risks, lag: lagAtStage, destructive, diff, commitAttempted: false })
      return diff
    }, {
      progress: 'Staging the change and reading the device diff…',
      success: 'Review the device diff before committing this change.',
    })
  }

  async function commitDraft() {
    if (busy || draft === undefined || draft.diff === undefined || !draft.session.hasDiffBeenRead() || draft.commitAttempted) return
    const risky = draft.destructive || draft.risks.length > 0
    if (!await confirm({
      title: risky ? `Confirm the ${fields.action.replace(/-/gu, ' ')} write on ${draft.lag}` : 'Commit to running-config',
      body: [
        `Commit session ${draft.session.name} for ${draft.lag}? This changes running-config only; the staged text is ${draft.batch.join(' · ')}.`,
        ...(draft.risks.length === 0 ? [] : [`Risk named for this write:\n${draft.risks.map((risk) => `  · ${risk}`).join('\n')}`]),
        'If this session is lost mid-commit, the change may still have applied — reconnect and refresh before any further action.',
      ].join(' '),
      confirmLabel: risky ? `Commit despite the risk on ${draft.lag}` : 'Commit to running-config',
      destructive: true,
      subject: `${draft.session.name} · ${draft.lag}`,
    })) return
    setDraft({ ...draft, commitAttempted: true })
    const committed = await operation.run(() => draft.session.commit(), {
      progress: 'Committing the reviewed change to running-config…',
      success: 'Changes committed to running-config. Startup-config was not changed.',
      failureSuffix: COMMIT_RECOVERY,
    })
    if (committed.ok) {
      setDraft(undefined)
      setLive(undefined)
      setMembershipEdited(false)
      read.reload()
      // A commit that may have re-formed the LAG invalidates any verdict recorded before it for the
      // gated vocabulary — the next read re-asks rather than trusting a stale probe.
      if (gatedAction) void capabilities.probe({ force: true })
    }
  }

  async function abortDraft() {
    if (busy || draft === undefined || (draft.session.state !== 'open' && draft.session.state !== 'diffed')) return
    if (!await confirm({ title: 'Abort staged changes', body: `Abort staged changes in session ${draft.session.name}? Its staged ${draft.batch.join(' · ')} will be discarded.`, confirmLabel: 'Abort staged changes', destructive: true, subject: draft.session.name })) return
    const aborted = await operation.run(async () => {
      await draft.session.abort()
      setDraft(undefined)
      return draft.session.name
    }, { success: `Session ${draft.session.name} was aborted; nothing was written to the device.` })
    if (aborted.ok) read.reload()
  }

  async function abortPending(session: LagSessionRow) {
    if (busy || node === undefined || !/pending/iu.test(session.state)) return
    if (!await confirm({ title: 'Abort pending device session', body: `Abort pending device session ${session.name}? Its staged changes will be discarded. A pending session holds the config lock, which is why a preview (or another switch's config write) fails until it is cleared.`, confirmLabel: 'Abort pending session', destructive: true, subject: session.name })) return
    const aborted = await operation.run(async () => {
      await node.abortSession(session.name)
      return session.name
    }, { success: `Pending session ${session.name} was aborted.` })
    if (aborted.ok) read.reload()
  }

  async function verify() {
    if (busy || !canAct || node === undefined || rows.length === 0) return
    await operation.run(async () => {
      const checks = await Promise.all(rows.map(async (row): Promise<LagLiveCheck> => {
        const read0 = await softRead(node.interfaces.getMembers(row.name))
        return read0.kind === 'ok'
          ? { name: row.name, members: read0.value }
          : { name: row.name, error: read0.error }
      }))
      setLive(checks)
      return checks
    }, {
      progress: 'Asking the device for each bundle’s live member list…',
      success: 'Live membership shown below the table — a separate verb answer, not the table’s source.',
    })
  }

  async function abortProbeSessions() {
    if (busy || node === undefined) return
    if (!await confirm({ title: 'Abort probe sessions', body: 'Abort the pending configuration sessions this screen’s capability probe left on the device? The probe session is meant to be aborted by the client; a leftover still holds the config lock.', confirmLabel: 'Abort probe sessions', destructive: true })) return
    await operation.run(() => capabilities.abortPendingSessions(), { success: 'Probe sessions aborted.' })
    read.reload()
  }

  const draftView: LagDraftView | undefined = draft === undefined ? undefined : { session: draft.session.name, batch: draft.batch, ...(draft.diff === undefined ? {} : { diff: draft.diff }) }

  const view: LagManagerViewProps = {
    state: read.state.kind === 'loading' ? 'loading' : read.state.kind === 'error' ? 'failed' : 'ready',
    ...(data?.identity === undefined ? {} : { identity: data.identity }),
    ...(proxyConfigured ? {} : { proxyPrompt: PROXY_PROMPT }),
    rows,
    ports,
    // Device sessions that matter here: anything a human (or a probe) might still need to abort. The
    // state string is the device's (ConfigSessionSummary#state) — filtered on the known words, shown
    // verbatim, never renamed.
    sessions: data?.sessions.filter((session) => /pending|open|diffed|conflicted/iu.test(session.state)) ?? [],
    // Until the operator touches the picker, the checkbox set mirrors the selected bundle's config
    // relation — the same set `plan()` diffs against, so an untouched form is always a no-op refusal.
    fields: membershipEdited ? fields : { ...fields, members: desiredMembers },
    onChange: setFields,
    onMemberToggle: memberToggle,
    selected: lagName,
    onSelect: selectLag,
    onPreview: (event) => void preview(event),
    onCommit: () => void commitDraft(),
    onAbortDraft: () => void abortDraft(),
    onAbortPending: (session) => void abortPending(session),
    onVerify: () => void verify(),
    ...(live === undefined ? {} : { live }),
    ...(draftView === undefined ? {} : { draft: draftView }),
    messages: {
      notice,
      failure,
      ...(read.state.kind === 'error' ? { readError: read.state.message } : {}),
      ...(data?.denseError === undefined ? {} : { denseError: data.denseError }),
      ...(data?.managementError === undefined ? {} : { managementError: data.managementError }),
    },
    busy,
    gate: {
      open: gateOpen,
      blocked: gateFeature === undefined
        ? 'No capability answer has been recorded — the probe has to run before this vocabulary can be offered.'
        : `the capability verdict is ${gateFeature.display}: ${gateFeature.reason}`,
    },
    capabilities: capabilities.view.features.map((feature): LagCapabilityView => ({
      feature: feature.name,
      display: feature.display,
      reason: feature.reason ?? '',
      candidates: candidateList({ [feature.name]: LAG_LACP_PROBE[feature.name] ?? [] }),
    })),
    onProbe: () => void capabilities.probe({ force: true }),
    onAbortProbeSessions: () => void abortProbeSessions(),
  }

  return <LagManagerView {...view} />
}
