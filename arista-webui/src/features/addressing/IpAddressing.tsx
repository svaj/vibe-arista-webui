/**
 * S6 (#76): IP addressing — routed ports and SVI addresses, container half.
 *
 * Route `#/addressing`. The write path is the standing named-session shape: preview
 * (session + `run` + device `diff()`) → explicit confirm → commit → reload. Running-config
 * only, `copy run start` never (DR-024).
 *
 * ## Where the table comes from — and the issue's capture claim that went stale
 *
 * #76 was written when only the **text** form of `show ip interface brief` existed in the
 * corpus and claimed its JSON form was "never captured" — that is no longer true as of the
 * committed captures: the hardware inventory sweep (`test/fixtures/recordings/
 * 7050tx-64-r-4.28.13.1M/show-ip-interface-brief--hw-inventory.json`) and the cEOS live
 * lane (`test/fixtures/live/ceos-4.28.14M/show-ip-interface-brief.json`) both carry the
 * JSON payload, and the shape is pinned as a screen contract in `src/eapi/show-contracts.ts`.
 * So the issue's CAPTURES-gated summary became buildable, and this screen does it the
 * two-column way the repo already standardized (S5's dense split): the **row identity and
 * every config truth** come from parsed running-config — `ipinterfaces.getAll()` (address
 * lines, secondaries, the `mtu` line) joined onto the `interfaces.getAll({ status: 'skip' })`
 * section list (kind, `vrf`, which Ethernet/Port-Channel sections carry `no switchport`)
 * — while a separate soft read (`show ip interface brief`, never auto-retried into the
 * write path) fills ONLY the "device answer" columns (`interfaceStatus`,
 * `lineProtocolStatus`, live `mtu`, the primary ip the device itself reports). A brief
 * failure leaves those columns claiming nothing; config lines are never renamed live
 * state, and a config/device disagreement is surfaced for the operator to read, never
 * auto-reconciled. The correction to the issue's claim is recorded on #76.
 *
 * ## Deviations recorded up front
 *
 * - The issue lists capability probes under "Consumes: F1-F7", but names no gated
 *   vocabulary for this lane, and `ip address` / `no switchport` / `switchport` are all
 *   config-backed M verbs with no version-conditional spelling in this client (the 4.31+
 *   `address virtual` family stays client-unmodelled). `useCapabilities` is deliberately
 *   not wired: a probe with nothing the screen gates would stage config lines for no
 *   decision (contrast S5, where `port-channel lacp fallback …` is genuinely gated).
 * - No pending-session panel: this screen stages no probe sessions, so the S5 cleanup
 *   section has nothing to clean; a concurrent config lock surfaces as the typed 1006
 *   failure with the standing recovery text instead.
 * - IPv6 is not offered anywhere: the client models neither reading nor writing IPv6
 *   addresses (ipinterfaces module header, "Never modelled"). The table says so once, it
 *   does not fake an empty IPv6 column.
 *
 * ## The in-band guard (#76's self-lockout shape, same family as S1's shutdown guard)
 *
 * Strongest signal is the device's own answer naming where eAPI is served —
 * `show management api http-commands` `urls[]` parsed by {@link managementInterfaces}
 * (InterfacesDashboard, reused verbatim). Next is arithmetic: an address line whose IPv4
 * network (under its own prefix) contains the endpoint host dialed for this session
 * ({@link sharesSubnet} — IPv4 arithmetic, a DR-032-style fact about addresses, not a
 * claim about this build's behaviour). Three honest caveats the UI prints, not buries:
 * the browser's own path can't be observed, a **DNS-named endpoint** can't be compared to
 * an address line at all (so those writes get an "unknown, treat as possibly in-band"
 * warning rather than a clean bill), and a failed management read is never evidence that
 * a row is off-path.
 *
 * Per the issue: `Management<N>` rows are listed but **never writable** (MGMT isolation
 * is a separate, unverified feature.md line), and a `route-port` on an interface the
 * device named as the eAPI listener is refused outright. Address writes on in-band rows
 * hard-confirm as destructive; the commit-failure recovery text matches S1's.
 *
 * ## Client-text mirroring
 *
 * - `ip address …` / `no ip address` / `… secondary`: same `commandBuilder('ip address',
 *   …)` framing the pinned `setAddress`/`unsetAddress` verbs compose, and the form guard
 *   {@link addressFormRefusal} mirrors the client's (module-local, unexported)
 *   `assertInterfaceAddress` token rules — octets 0..255, prefix ≤32, only a single
 *   trailing `secondary`, no control characters. Bounds per DR-032: IPv4 facts, the
 *   device keeps authority over what it accepts.
 * - routed-port transition = the client's `create` framing minus address lines: `interface
 *   <X>` + `no switchport`. Switchport-return = {@link IpinterfacesResource.delete}'s
 *   verbatim pair, `no ip address` before `switchport`, "the order is upstream's, and it
 *   matters" (ipinterfaces.ts:451-453); whether EOS would refuse the reverse is a device
 *   question (M12 #14), and what `no ip address` does to a `secondary` line on this unit
 *   is uncaptured — the screen says both, and offers no per-secondary removal because the
 *   client has no such pin.
 * - A VRF-bound section is refused for every write here: `Interface.vrf` is this client's
 *   reader-side addition (divergence 14) while the eAPI address verbs' interaction with
 *   `vrf forwarding` has no capture; writing an address line into a shape the screen
 *   cannot fully read back is the kind of blind write the standing rules refuse.
 */
import { useState } from 'react'
import type { FormEvent } from 'react'
import { commandBuilder, isInterfaceName, submodeCommands } from '@devhax-heavy-industries/arista-eapi'
import type { CommandSpec, Node } from '@devhax-heavy-industries/arista-eapi'

import { identityFrom } from '../../shared/identity'
import type { DeviceIdentity } from '../../shared/identity'
import { softErrorText, softRead, softValue, useDeviceRead } from '../../shared/use-device-read'
import { useOperation } from '../../shared/use-operation'
import { TransactionScope, useTransaction, useTransactionSnapshot } from '../sessions/TransactionContext'
import { bandPathFor, managementInterfaces } from '../interfaces/InterfacesDashboard'
import { stageLines } from '../staged-batch'
import { AddressingView } from './AddressingView'
import type { AddressingAction, AddressingFields, AddressingRow, AddressingViewProps } from './AddressingView'

// The screen contracts ride this import (ARCHITECTURE §9.1 augmentation), so
// `node.show('management api http-commands')` and `node.show('version')` type end-to-end.
import '../../eapi/show-contracts'

export type AddressingManagerClient = Pick<Node, 'interfaces' | 'ipinterfaces' | 'configSession' | 'show' | 'connection'>

export interface AddressingManagerProps {
  readonly node: AddressingManagerClient | undefined
  readonly proxyConfigured?: boolean
}

const PROXY_PROMPT = 'Local proxy is not configured. Set EAPI_HOST, EAPI_USER, and EAPI_PASS in arista-webui/.env.local, then restart Vite.'

type Data = {
  rows: readonly AddressingRow[]
  endpointHost?: string
  addressReadError?: string
  managementError?: string
  briefError?: string
  managementNamed: readonly string[]
  identity?: DeviceIdentity
}

/**
 * Does the LIVE primary the device reported for a row agree with the config line the table shows?
 * The only comparison made here; `undefined` means "cannot be compared" (either side absent),
 * which the view renders as an explicit note, never as agreement.
 */
export function liveAgreement(configToken: string | undefined, live: { address: string; maskLen: number } | undefined): boolean | undefined {
  if (configToken === undefined || live === undefined) return undefined
  const config = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/u.exec(configToken.trim())
  if (config === null) return undefined
  const mask = Number(config[2])
  return config[1] === live.address.trim() && mask === live.maskLen
}

const DEFAULT_FIELDS: AddressingFields = { action: 'set-address', iface: '', address: '' }

const DEVICE_ORDER = (left: string, right: string) => left.localeCompare(right, undefined, { numeric: true })

/** The issue's out-of-scope guard, spelled from the client's own kind token (validators.ts:82). */
export function isManagementInterfaceName(name: string): boolean {
  return /^Management/u.test(name)
}

/**
 * Mirror of the client's module-local `assertInterfaceAddress` token rules
 * (resources/ipinterfaces.ts — the `ADDRESS_TOKEN` regex plus its octet/prefix bounds and
 * the single-`secondary` allowance), rephrased as a refusal string instead of a throw.
 * The bounds are IPv4 arithmetic, not EOS claims (DR-032): which addresses this build
 * accepts stays the device's to decide, and the CommandError path stays the backstop.
 */
export function addressFormRefusal(value: string): string | undefined {
  if (hasControlCharacter(value)) {
    return 'The address carries a control character — it would break the config line this client reads back (MIGRATION.md §5 row 74; the client refuses it identically).'
  }
  const tokens = value.split(' ')
  if (tokens.length > 2 || (tokens.length === 2 && tokens[1] !== 'secondary')) {
    return 'Expected A.B.C.D/E, optionally followed by the single word secondary — that is the whole shape this client can read back after writing it (ipinterfaces assertInterfaceAddress).'
  }
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/([0-9]{1,3})$/u.exec(tokens[0] as string)
  if (match === null) {
    return 'Expected A.B.C.D/E: four decimal octets, a slash, a prefix length — a bare address, a prefix alone, or the word virtual are shapes this client reads verbatim but will not write (ipinterfaces assertInterfaceAddress).'
  }
  for (const part of [match[1], match[2], match[3], match[4]] as const) {
    if (Number(part) > 255) return `The octet ${String(part)} is outside 0..255 — an IPv4-address fact, not an EOS claim (DR-032).`
  }
  if (Number(match[5]) > 32) return `The prefix length ${String(match[5])} is outside 0..32 for an IPv4 address — an IPv4 fact, not an EOS claim about this build (DR-032).`
  return undefined
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u

function toOctets(value: string): readonly number[] | undefined {
  const match = IPV4.exec(value)
  if (match === null) return undefined
  const octets = [match[1], match[2], match[3], match[4]].map(Number)
  return octets.every((octet) => octet <= 255) ? octets : undefined
}

const toBits = (octets: readonly number[]): number => ((octets[0] ?? 0) * 0x1000000) + ((octets[1] ?? 0) * 0x10000) + ((octets[2] ?? 0) * 0x100) + (octets[3] ?? 0)

/**
 * Does `endpoint` fall inside the network spelled by `A.B.C.D/E`? Pure IPv4 arithmetic
 * (DR-032 discipline), undefined when either side cannot be parsed — including an
 * endpoint spelled as a DNS name, which the caller renders as its OWN honest "cannot
 * compare" warning rather than a pass.
 */
export function subnetContainment(endpoint: string, token: string): boolean | undefined {
  const endpointOctets = toOctets(endpoint.trim())
  if (endpointOctets === undefined) return undefined
  const split = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/u.exec(token.trim())
  if (split === null) return undefined
  const addrOctets = toOctets(split[1] as string)
  const prefix = Number(split[2])
  if (addrOctets === undefined || prefix > 32) return undefined
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return (toBits(addrOctets) & mask) === (toBits(endpointOctets) & mask)
}

/** The host part of the dialed eAPI endpoint URL, or undefined when it is not parseable. */
function endpointFromConnection(node: AddressingManagerClient): string | undefined {
  try {
    return new URL(node.connection.address).hostname
  } catch {
    return undefined
  }
}

const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const point = character.codePointAt(0) ?? 0
    return point <= 0x1f || point === 0x7f
  })

export function IpAddressing(props: AddressingManagerProps) {
  return <TransactionScope node={props.node}><AddressingWorkspace {...props} /></TransactionScope>
}

function AddressingWorkspace({ node, proxyConfigured = true }: AddressingManagerProps) {
  const operation = useOperation()
  const { busy, notice, failure } = operation
  const transaction = useTransaction()
  const transactionState = useTransactionSnapshot()
  const transactionBusy = transactionState.status === 'opening' || transactionState.status === 'staging' || transactionState.status === 'committing' || transactionState.status === 'aborting'
  const [fields, setFields] = useState<AddressingFields>(DEFAULT_FIELDS)

  const canAct = proxyConfigured && node !== undefined && transaction !== undefined && transactionState.status !== 'uncertain'

  const read = useDeviceRead<Data>(
    async () => {
      if (node === undefined) throw new Error(PROXY_PROMPT)
      const managementPromise = node.show('management api http-commands')
      const versionPromise = node.show('version').then(identityFrom)
      // The two-column shape (S5's dense split, same discipline): this read fills ONLY the
      // "device answer" columns. Its failure is a per-row note, never a derived status.
      const briefPromise = node.show('ip interface brief')
      const interfaces = await node.interfaces.getAll({ status: 'skip' })
      const addressesRead = await softRead(node.ipinterfaces.getAll())
      const managementRead = await softRead(managementPromise)
      const versionRead = await softRead(versionPromise, { silent: true })
      const briefRead = await softRead(briefPromise)
      const brief = softValue(briefRead)
      const addresses = softValue(addressesRead)
      const management = softValue(managementRead)
      const version = softValue(versionRead)

      const served = managementInterfaces(management)
      const endpoint = endpointFromConnection(node)
      const briefIfaces = brief?.interfaces
      const rowNames = [...new Set([...interfaces.keys(), ...Object.keys(briefIfaces ?? {})])].sort(DEVICE_ORDER)
      const rows: AddressingRow[] = rowNames.map((name) => {
        const entered = interfaces.get(name)
        const l3 = addresses === undefined ? undefined : addresses.get(name)
        const live = briefIfaces?.[name]
        return {
          name,
          kind: entered !== undefined ? (entered.kind ?? 'Unrecognised') : briefIfaces !== undefined && Object.keys(briefIfaces).includes(name) ? 'Device-named, no section in config read' : 'Unrecognised',
          inSections: interfaces.has(name),
          briefKnown: briefIfaces !== undefined,
          l3Known: addresses !== undefined,
          routed: l3 !== undefined,
          ...(l3?.address === undefined ? {} : { address: l3.address }),
          ...(l3?.secondary === undefined || l3.secondary.length === 0 ? {} : { secondary: l3.secondary }),
          ...(l3?.mtu === undefined ? {} : { mtu: l3.mtu }),
          ...(entered?.ethernet?.vrf === undefined ? {} : { vrf: entered.ethernet.vrf }),
          ...(live?.interfaceStatus === undefined ? {} : { deviceStatus: live.interfaceStatus }),
          ...(live?.lineProtocolStatus === undefined ? {} : { deviceProtocol: live.lineProtocolStatus }),
          ...(live?.mtu === undefined ? {} : { deviceMtu: live.mtu }),
          ...(live?.interfaceAddress?.ipAddr?.address === undefined || live.interfaceAddress.ipAddr.maskLen === undefined
            ? {}
            : { liveAddress: `${live.interfaceAddress.ipAddr.address}/${String(live.interfaceAddress.ipAddr.maskLen)}` }),
          ...(liveAgreement(l3?.address, live?.interfaceAddress?.ipAddr) === undefined ? {} : { liveMatch: liveAgreement(l3?.address, live?.interfaceAddress?.ipAddr) === true }),
          bandPath: bandPathFor(name, l3?.address, served),
        }
      })
      return {
        rows,
        ...(brief === undefined ? { briefError: softErrorText(briefRead) ?? 'the ip-interface-brief read did not come back' } : {}),
        ...(endpoint === undefined ? {} : { endpointHost: endpoint }),
        ...(addresses === undefined ? { addressReadError: softErrorText(addressesRead) ?? 'the ip interface table did not come back from the parsed config' } : {}),
        ...(management === undefined ? { managementError: softErrorText(managementRead) ?? 'the management-api read did not come back' } : {}),
        managementNamed: served,
        ...(version === undefined ? {} : { identity: version }),
      }
    },
    [node],
  )

  const data = read.state.kind === 'ready' ? read.state.data : undefined
  const rows = data?.rows ?? []
  const selectedRow = rows.find((row) => row.name === fields.iface)

  /** The in-band decision for the CURRENT selection: named by the device first, IPv4
   *  arithmetic second, and an unparseable (DNS) endpoint or failed read stays "unknown,
   *  treat as possibly in-band" — never a pass. */
  function inBandFor(row: AddressingRow | undefined): { inBand: boolean; note?: string } {
    if (row === undefined) return { inBand: false }
    const endpoint = data?.endpointHost
    if (data?.managementNamed.includes(row.name) === true) return { inBand: true, note: `The device names ${row.name} as an interface serving eAPI (show management api http-commands). Writing its address may drop the management path this UI is riding.` }
    if (row.address === undefined) return { inBand: false }
    if (endpoint === undefined) return { inBand: false, note: 'The dialed eAPI endpoint could not be read from this session, so whether an address write on this interface drops the management path is unknown — not evidence of safety.' }
    const containment = subnetContainment(endpoint, row.address)
    if (containment === true) return { inBand: true, note: `${row.name} carries ${row.address}, and the endpoint this UI dials (${endpoint}) falls inside that prefix. Writing this interface's address may drop the management path. This is IPv4 arithmetic, not a capture of what this build does to live sessions.` }
    if (containment === undefined) return { inBand: false, note: `The endpoint this UI dials (${endpoint}) is not an IPv4 literal, so it cannot be compared to ${row.address}. Whether a write here drops the management path is unknown — not evidence of safety.` }
    if (data?.managementError !== undefined) return { inBand: false, note: 'The management-path classification read failed; that is not evidence this interface is off the management path.' }
    return { inBand: false }
  }

  /** The staged batch: every text is the exact spelling the client's pinned ipinterfaces
   *  verbs compose (`setAddress`/`unsetAddress` through `commandBuilder('ip address', …)`,
   *  the `create`/`delete` framings quoted in the module header above). */
  function plan(): { batch: readonly string[] } | { refusal: string } {
    if (selectedRow === undefined) {
      return { refusal: fields.iface === '' ? 'Pick the interface first — every action here targets a section that exists in the running-config.' : `${fields.iface} is not in the parsed section list this screen read; it offers no actions for names the device did not report.` }
    }
    if (isManagementInterfaceName(selectedRow.name)) {
      return { refusal: 'Management<N> is listed but never writable from here: #76 keeps MGMT-port isolation out of scope as a separate unverified feature line, even though the client grammar would allow the command.' }
    }
    if (!selectedRow.inSections) {
      return { refusal: `${selectedRow.name} is a name only the device's brief answer reported — the parsed config read showed no section for it. Everything this screen writes is config text, so nothing is staged against an interface the config read did not show.` }
    }
    if (selectedRow.vrf !== undefined) {
      return { refusal: `${selectedRow.name} is bound to VRF ${selectedRow.vrf} (the reader-side vrf field this client added). The address verbs' interaction with vrf forwarding has no capture on either target, so this screen refuses to write L3 lines into a shape it cannot fully read back.` }
    }
    const tailForAddress = (): { tail: readonly CommandSpec[] } | { refusal: string } => {
      const value = fields.address.trim()
      if (value === '') return { refusal: 'An address is needed for this action. The client sends no empty value — clearing is the remove-address action (its bare `no ip address` negation, like ipinterfaces unsetAddress).' }
      const refusal = addressFormRefusal(value)
      if (refusal !== undefined) return { refusal }
      return { tail: [commandBuilder('ip address', { value })] }
    }

    switch (fields.action) {
      case 'set-address': {
        if (!selectedRow.l3Known) return { refusal: 'The address read did not come back, so this screen cannot say whether this section is routed or what it carries. Nothing is staged until the table reloads with its L3 columns.' }
        if (!selectedRow.routed) {
          return { refusal: `${selectedRow.name} is a switching port in the parsed config (its section carries no \`no switchport\` line). Make it routed first — #76 treats that transition as a separate, mode-changing action.` }
        }
        const value = fields.address.trim()
        if (selectedRow.address === value) {
          return { refusal: `${selectedRow.name} already carries exactly ${value} in the running-config — staging the same line wastes a session and lets the UI claim a commit that changed nothing.` }
        }
        const built = tailForAddress()
        if ('refusal' in built) return built
        return { batch: stageLines(submodeCommands(`interface ${selectedRow.name}`, built.tail)) }
      }
      case 'add-secondary': {
        if (!selectedRow.l3Known) return { refusal: 'The address read did not come back — no secondary line is staged against rows whose L3 state is unknown.' }
        if (!selectedRow.routed) return { refusal: `${selectedRow.name} has no routed section to add a secondary line to.` }
        const value = fields.address.trim()
        const bare = value.replace(/ secondary$/u, '').trim()
        if (selectedRow.secondary?.includes(bare) === true) {
          return { refusal: `${selectedRow.name} already carries ${bare} as a secondary address line — nothing to stage.` }
        }
        const token = fields.address.trim().endsWith('secondary') ? fields.address.trim() : `${fields.address.trim()} secondary`
        const refusal = addressFormRefusal(token)
        if (refusal !== undefined) return { refusal }
        return { batch: stageLines(submodeCommands(`interface ${selectedRow.name}`, [commandBuilder('ip address', { value: token })])) }
      }
      case 'remove-address': {
        if (!selectedRow.l3Known) return { refusal: 'The address read did not come back, so this screen cannot say what a negation here would remove. Nothing is staged until the table reloads with its address column.' }
        if (!selectedRow.routed) return { refusal: `${selectedRow.name} has no routed section to negate an address on.` }
        return { batch: stageLines(submodeCommands(`interface ${selectedRow.name}`, [commandBuilder('ip address', { mode: 'no' })])) }
      }
      case 'route-port': {
        if (selectedRow.kind !== 'Ethernet' && selectedRow.kind !== 'Port-Channel') {
          return { refusal: 'Only Ethernet and Port-Channel sections flip between switching and routed here — kind tokens come from the config parser, and the client\'s L2-capable set is exactly those two (ipinterfaces L2_CAPABLE_KIND).' }
        }
        if (!isInterfaceName(selectedRow.name)) {
          return { refusal: `${selectedRow.name} is outside the six spelled-out kinds this client may write names for (open item 7 — the split-QSFP spelling stays unwritable until M12 #14 captures it). It remains listed, read-only.` }
        }
        if (data?.managementNamed.includes(selectedRow.name) === true) {
          return { refusal: `${selectedRow.name} is the interface the device itself names as serving eAPI. #76: routed-port transitions are refused outright on the in-band management interface.` }
        }
        return { batch: stageLines(submodeCommands(`interface ${selectedRow.name}`, ['no switchport'])) }
      }
      case 'switchport-back': {
        if (selectedRow.kind !== 'Ethernet' && selectedRow.kind !== 'Port-Channel') {
          return { refusal: 'Only Ethernet and Port-Channel sections return to switching here — Vlan/Loopback/Management/Vxlan sections never had the flip.' }
        }
        if (!selectedRow.routed) return { refusal: `${selectedRow.name} is not routed in the parsed config — there is nothing to convert back.` }
        if (!isInterfaceName(selectedRow.name)) return { refusal: `${selectedRow.name} is outside the writable name grammar (open item 7); it stays listed, read-only.` }
        // ipinterfaces.delete's verbatim pair, order included: "the address is cleared
        // before the port goes back to switching" (ipinterfaces.ts:451-453).
        return { batch: stageLines(submodeCommands(`interface ${selectedRow.name}`, ['no ip address', 'switchport'])) }
      }
    }
  }

  function risksFor(stage: { action: AddressingAction; iface: AddressingRow | undefined; batch: readonly string[] }): readonly string[] {
    const out: string[] = []
    const band = inBandFor(stage.iface)
    if (band.note !== undefined) out.push(band.note)
    if (stage.action === 'route-port') {
      out.push('Making a port routed erases its switching configuration the way EOS sees it: the client\'s own upstream note says creating an L3 interface removes an existing switchport, marked unverified on this unit (M12 #14; ipinterfaces.ts:432 quoting pyeapi api/ipinterfaces.py:159-161). This batch composes only the `no switchport` line the client writes — nothing else.')
    }
    if (stage.action === 'switchport-back') {
      out.push('`no ip address` before `switchport` is upstream\'s order verbatim (the client keeps it because "whether EOS would refuse the reverse is a device question", ipinterfaces.ts:451-453). What this unit does to a `secondary` address line under the bare negation is NOT captured; the client has no per-secondary removal verb and this screen offers none.')
    }
    if ((stage.action === 'remove-address') && stage.iface?.secondary !== undefined) {
      out.push(`${stage.iface.name} carries secondary line(s) ${stage.iface.secondary.join(', ')} in the parsed config. The device-side effect of \`no ip address\` on them is uncaptured on this unit.`)
    }
    return out
  }

  async function preview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || transactionBusy || !canAct || node === undefined || transaction === undefined) return
    const staged = plan()
    if ('refusal' in staged) {
      await operation.run(async () => { throw new Error(staged.refusal) })
      return
    }
    const risks = risksFor({ action: fields.action, iface: selectedRow, batch: staged.batch })
    await operation.run(() => transaction.append({
      source: '/addressing',
      action: `${fields.action} on ${fields.iface}`,
      commands: staged.batch,
      display: staged.batch,
      risks,
    }), {
      progress: 'Adding the addressing change to the shared transaction…',
      success: 'Addressing change added to the transaction. Review the device diff before committing in Transaction Center.',
    })
  }

  const view: AddressingViewProps = {
    state: read.state.kind === 'loading' ? 'loading' : read.state.kind === 'error' ? 'failed' : 'ready',
    ...(data?.identity === undefined ? {} : { identity: data.identity }),
    ...(proxyConfigured ? {} : { proxyPrompt: PROXY_PROMPT }),
    rows,
    fields,
    onChange: setFields,
    onPreview: (event) => void preview(event),
    onReload: () => read.reload(),
    messages: {
      notice,
      failure,
      ...(read.state.kind === 'error' ? { readError: read.state.message } : {}),
      ...(data?.addressReadError === undefined ? {} : { addressReadError: data.addressReadError }),
      ...(data?.managementError === undefined ? {} : { managementError: data.managementError }),
      ...(data?.briefError === undefined ? {} : { briefError: data.briefError }),
    },
    band: {
      endpointHost: data?.endpointHost ?? 'not readable from this session',
      managementNamed: data?.managementNamed ?? [],
      ...(inBandFor(selectedRow).note === undefined ? {} : { note: inBandFor(selectedRow).note }),
    },
    busy: busy || transactionBusy,
  }

  return <AddressingView {...view} />
}
