/**
 * S15 (#85): the pure rules behind the spanning-tree screen. No React, no client import at runtime —
 * these are the frozen client's rules MIRRORED for the UI (the way `ntp-rules.ts` mirrors
 * `resources/ntp.ts`), because a refusal must appear IN-FORM before a config session is paid for,
 * and the DEVICE stays the authority: a write this screen staged but the CLI rejects comes back as
 * the device's own `CommandError` (DR-057).
 *
 * ## Why the command text is composed here rather than by calling `node.stp.interfaces.*`
 *
 * The client's interface verbs each open their OWN transaction (`Entity.configure` →
 * `configureInterface`) with no preview/diff step. The screen wave writes the standing
 * named-session way — session → `run` → device `diff()` → confirm → commit — exactly like S8 (#78)
 * and S12 (#82). So this screen stages plain command LINES whose text is byte-for-byte what the
 * ported verbs would put on the wire. Every string below was read off the pins in
 * `arista-api-client/src/resources/stp.test.ts` (the `sentAsText` batches, each prefixed there by
 * the transport's `['enable', 'configure terminal', …]` framing and here by the session's
 * `interface <port>` parent line), never invented:
 *
 * ```
 * setBpduguard(true)    ['interface Ethernet1', 'spanning-tree bpduguard enable']
 * setBpduguard(false)   ['interface Ethernet1', 'spanning-tree bpduguard disable']   (the WORD, row 172)
 * unsetBpduguard        ['interface Ethernet1', 'no spanning-tree bpduguard']
 * defaultBpduguard      ['interface Ethernet1', 'default spanning-tree bpduguard']
 * setPortfast           ['interface Ethernet1', 'spanning-tree portfast']
 * unsetPortfast         ['interface Ethernet1', 'no spanning-tree portfast']
 * defaultPortfast       ['interface Ethernet1', 'default spanning-tree portfast']
 * setPortfastType(edge)    ['interface Ethernet1', 'spanning-tree portfast edge', 'spanning-tree portfast auto']
 * setPortfastType(network) ['interface Ethernet1', 'spanning-tree portfast network']
 * setPortfastType(normal)  ['interface Ethernet1', 'spanning-tree portfast normal']
 * ```
 *
 * The `spanning-tree portfast auto` partner line on the edge arm is upstream's own
 * (`stp.py:277-279`, pinned at `test_api_stp.py:99-107`) — reproduced verbatim, not invented here.
 *
 * ## What this file deliberately does NOT expose
 *
 * - **No global `spanning-tree mode …` action.** Mode changes are blocked issue B3 (#88); the
 *   screen renders no control for it and {@link STP_MODE_EDIT_NOTE} states that statically.
 * - **No operational fields.** `show spanning-tree` has no capture for this device, so
 *   {@link STP_OPERATIONAL_NOTE} is the only "state" sentence the summary panel carries, and no
 *   per-port operational column exists ({@link StpPortRowView} has exactly the three config-read
 *   fields the frozen reader answers).
 */

import type { StpInterface } from '@devhax-heavy-industries/arista-eapi'

/** The id of every per-port write this screen can stage — the client's verb, kebab-cased. */
export type StpWriteActionId =
  | 'bpduguard-enable'
  | 'bpduguard-disable'
  | 'bpduguard-unset'
  | 'bpduguard-default'
  | 'portfast-enable'
  | 'portfast-unset'
  | 'portfast-default'
  | 'portfast-type-edge'
  | 'portfast-type-network'
  | 'portfast-type-normal'

/**
 * Which hard-confirm boundary an action trips, choosing the risk copy in {@link stageRisks}:
 * - `portfast-loop` — writes an affirmative PortFast form on the port; the loop guard fires.
 * - `reduce-protection` — takes BPDU guard (or its enable line) out of the config.
 * - `device-default` — a `default …` verb whose resulting lines the screen cannot predict.
 * - `null` — no extra boundary; the standing staged-commit confirm still applies.
 */
export type StpConfirmBoundary = 'portfast-loop' | 'reduce-protection' | 'device-default' | null

export interface StpWriteAction {
  readonly id: StpWriteActionId
  /** Option label in the Change selector. */
  readonly label: string
  /** The command lines WITHOUT the `interface <port>` parent — the stp.test.ts pins verbatim. */
  readonly commands: readonly string[]
  /** True when the staged lines reach running-config with PortFast affirmatively set. */
  readonly enablesPortfast: boolean
  /** The hard-confirm boundary; also what makes the commit button use the risky verb. */
  readonly boundary: StpConfirmBoundary
}

/**
 * Every action in selector order. The three PortFast `default`/`unset` texts and the two
 * bpduguard WORDS (`enable`/`disable`, not a negation — divergence 8 of `stp.ts`) are separate
 * actions because DR-037's split verbs keep all command texts distinguishable; the screen never
 * folds them.
 */
export const STP_WRITE_ACTIONS: readonly StpWriteAction[] = [
  { id: 'bpduguard-enable', label: 'Enable BPDU guard', commands: ['spanning-tree bpduguard enable'], enablesPortfast: false, boundary: null },
  { id: 'bpduguard-disable', label: 'BPDU guard: write the disable word', commands: ['spanning-tree bpduguard disable'], enablesPortfast: false, boundary: 'reduce-protection' },
  { id: 'bpduguard-unset', label: 'Unset BPDU guard (no form)', commands: ['no spanning-tree bpduguard'], enablesPortfast: false, boundary: 'reduce-protection' },
  { id: 'bpduguard-default', label: 'Default BPDU guard', commands: ['default spanning-tree bpduguard'], enablesPortfast: false, boundary: 'device-default' },
  { id: 'portfast-enable', label: 'Enable PortFast (bare command)', commands: ['spanning-tree portfast'], enablesPortfast: true, boundary: 'portfast-loop' },
  { id: 'portfast-unset', label: 'Unset PortFast (no form)', commands: ['no spanning-tree portfast'], enablesPortfast: false, boundary: null },
  { id: 'portfast-default', label: 'Default PortFast', commands: ['default spanning-tree portfast'], enablesPortfast: false, boundary: 'device-default' },
  { id: 'portfast-type-edge', label: 'PortFast type: edge', commands: ['spanning-tree portfast edge', 'spanning-tree portfast auto'], enablesPortfast: true, boundary: 'portfast-loop' },
  { id: 'portfast-type-network', label: 'PortFast type: network', commands: ['spanning-tree portfast network'], enablesPortfast: true, boundary: 'portfast-loop' },
  { id: 'portfast-type-normal', label: 'PortFast type: normal', commands: ['spanning-tree portfast normal'], enablesPortfast: true, boundary: 'portfast-loop' },
]

/** Find an action by id; `undefined` for the selector's untouched placeholder. */
export function stpWriteAction(id: string): StpWriteAction | undefined {
  return STP_WRITE_ACTIONS.find((action) => action.id === id)
}

/**
 * The three tokens the client's WRITE side can spell — mirrored from `PORTFAST_TYPES`
 * (`resources/stp.ts` / pyeapi `stp.py:274` minus the refused `None` arm). The READ side keeps any
 * token the device wrote verbatim (`StpInterface.portfastType` is `string`, §5 row 170), so the
 * view uses this only to flag "outside the client's write set" — never to rewrite the token.
 */
export const CLIENT_PORTFAST_TYPES: readonly string[] = ['edge', 'network', 'normal']

/** Is this device-read token one the client itself would write? (`auto` is the known counter-example.) */
export function isClientPortfastType(token: string): boolean {
  return CLIENT_PORTFAST_TYPES.includes(token)
}

/** Row shape for the {@link file://./StpView.tsx} table — the three fields the frozen reader always answers. */
export interface StpPortRowView {
  readonly interfaceName: string
  /** Presence of the exact `spanning-tree bpduguard enable` line (row 170). */
  readonly bpduguard: boolean
  /** Absence of the exact `no spanning-tree portfast` line — default-on, upstream's reading. */
  readonly portfast: boolean
  /** The device's own `spanning-tree portfast <token>`, verbatim, else the fallback-chain token. */
  readonly portfastType: string
}

/** Fold one parsed {@link StpInterface} record into a table row without inventing or dropping fields. */
export function stpPortRowView(row: StpInterface): StpPortRowView {
  return { interfaceName: row.interfaceName, bpduguard: row.bpduguard, portfast: row.portfast, portfastType: row.portfastType }
}

/** Static copy: why there is no mode control anywhere on this screen (blocked issue B3 #88). */
export const STP_MODE_EDIT_NOTE =
  'Global spanning-tree mode editing is not offered on this screen. A mode change (`spanning-tree mode …`) is blocked pending issue B3 (#88), so no control here can stage one — the mode line below is read-only config text.'

/**
 * Static copy: the operational half of STP is not observable from this screen. Carries the exact
 * #85 sentence; a test pins that no operational state vocabulary ever reaches the DOM beside it.
 */
export const STP_OPERATIONAL_NOTE =
  'operational STP state not yet observable — capture pending'

/** Static copy: what this client's MST/instance reader actually is (upstream's 2015 stub, row 171). */
export const STP_INSTANCES_NOTE =
  'MST instances: this client has no reader — pyeapi\u2019s `StpInstances.getall` has been a `return dict()` stub since 2015, so the empty instance table is THIS CLIENT not having read anything, not a claim that the switch runs no instances.'

/**
 * The loop-risk sentence for every affirmative PortFast write (#85's hard-confirm guard). It names
 * the port and states honestly that the UI cannot see the far end — portfast on a non-edge port can
 * loop the bridged network, and "is this port an edge port?" is a physical question no config read
 * on this unit can answer.
 */
export function portfastLoopRisk(port: string): string {
  return `PortFast is being set on ${port}. PortFast makes ${port} come up without the normal converge delay; if a switch, a hub, or a host running bridging software hangs off the far end of ${port}, that fast-up port can loop the bridged network. This UI CANNOT see what is connected on the far end of ${port} — it reads configuration lines only, never operational or physical state — so the edge-port judgement is yours, not a device fact this page can assert.`
}

/**
 * The staged-risk sentences for one action on one port. Always at least one entry: the commit
 * confirm surfaces them, which is what makes the portfast loop guard (and the guard-weakening and
 * unknown-default boundaries) HARD confirms that name the port.
 */
export function stageRisks(action: StpWriteAction, port: string): readonly string[] {
  const texts = action.commands.map((command) => `\`${command}\``).join(' + ')
  const readBack = `The staged line(s) on ${port}: ${texts} — byte-for-byte what the frozen client's \`${action.id}\` verb composes (stp.test.ts pins); the device diff, not this screen, decides what running-config actually keeps.`
  switch (action.boundary) {
    case 'portfast-loop':
      return [readBack, portfastLoopRisk(port)]
    case 'reduce-protection':
      return [
        readBack,
        `This takes BPDU guard out of ${port}'s configuration. With guard off, ${port} no longer errs-out the port when a BPDU arrives on it, per the guard's purpose — a switch grafting onto ${port} could reshape the topology. Whether the device enforces that behavior on EOS 4.28.13.1M is UNVERIFIED on hardware (no operational capture, M12 #14), so this screen states the config change only.`,
      ]
    case 'device-default':
      return [
        readBack,
        `A \`default …\` verb returns ${port}'s spanning-tree line to the device default, which this screen CANNOT predict — the reader only shows what remains after commit. Treat the outcome as unknown until the next refresh, and note that this client's reader counts PortFast as enabled unless the exact \`no spanning-tree portfast\` line is present (row 170).`,
      ]
    default:
      // Only the two null-boundary actions land here: `bpduguard-enable` and `portfast-unset`.
      // Every PortFast-affirmative verb carries the portfast-loop boundary above, so no
      // enablesPortfast action can reach this arm — the type's flag is for the view, not here.
      return [
        readBack,
        action.id === 'portfast-unset'
          ? `This negates PortFast on ${port} — the exact \`no spanning-tree portfast\` line is also the ONE thing this client's reader looks for to report PortFast disabled (row 170), so the flag below flips on refresh. Attached hosts simply wait out the normal converge delay.`
          : `Enables BPDU guard on ${port}: the exact \`spanning-tree bpduguard enable\` line is what the reader treats as guard-on (row 170), so this write is what the next refresh must show. What the device does operationally with guard on is not observable from this screen (\`show spanning-tree\` is uncaptured).`,
      ]
  }
}

/** Whether the commit button for this action must use the risky (hard-confirm) verb. */
export function actionIsDestructive(action: StpWriteAction): boolean {
  return action.boundary !== null
}
