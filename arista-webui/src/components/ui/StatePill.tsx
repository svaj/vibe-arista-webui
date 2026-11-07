/**
 * F3 (#65) presentation primitive: a device status token rendered as **text plus a colour class**,
 * never colour alone (WCAG 1.4.1; `.github/references/accessibility-checklist.md`: "Color is not
 * the only way to convey information"). It is the extracted form of the two hand-rolled label spans
 * in `src/features/SwitchManager.tsx` — `.state-label` for a VLAN state and `.session-state` for a
 * config-session state — which F6 (#68) swaps in; #65 does not touch that screen.
 *
 * **DR-032 honesty (the reason this file has no enum):** `value` is the device's raw string and is
 * echoed verbatim. The client layer refuses to enumerate device value sets —
 * `arista-api-client/src/resources/interfaces.ts:687` states of `InterfaceStatus.status` that "a
 * status vocabulary is a device question and is never enumerated here" — and an unexpected token
 * must still reach the operator unchanged, because an invented label would be a claim about the
 * device. Narrowing to a union (`isSwitchportMode`, `arista-api-client/src/resources/switchports.ts:195`)
 * stays a container concern.
 *
 * {@link TONE_BY_TOKEN} only chooses cosmetics. It lists tokens this repo already has evidence for:
 * VLAN `state` (`active`/`suspend`, the documented pair at `arista-api-client/src/resources/vlans.ts:330`
 * citing upstream `pyeapi api/vlans.py:41-43`); config-session `state` (`pending`/`conflicted`/
 * `completed` appear verbatim in
 * `arista-api-client/test/fixtures/show/show-configuration-sessions--pending-orphans.json`, and
 * `open`/`diffed`/`committed`/`aborted`/`lost` are the client's own `ConfigSessionState`,
 * `arista-api-client/src/config-session.ts:119`); switchport `mode` (the `SwitchportMode` union,
 * `arista-api-client/src/resources/switchports.ts:189`); and the interface-status spellings this
 * app's screens already display. Any token outside the map renders `state-pill-neutral` — not
 * having a tone is not a claim that the value is unhealthy, and it is never renamed.
 */

/** Cosmetic tone classes; see the class vocabulary appended in `src/App.css`. */
export type StatePillTone = 'neutral' | 'positive' | 'caution' | 'risk' | 'mode'

const TONE_BY_TOKEN: Readonly<Record<string, StatePillTone>> = {
  // Success tokens, from the VLAN/config-session/state evidence above.
  active: 'positive', connected: 'positive', up: 'positive', enabled: 'positive',
  committed: 'positive', completed: 'positive',
  // Staged, half-configured, or administratively down tokens: not a fault, not a green light.
  pending: 'caution', suspend: 'caution', suspended: 'caution', disabled: 'caution',
  shutdown: 'caution', open: 'caution', diffed: 'caution', lost: 'caution',
  // Fault spellings this app has to show honestly. A tone says how an operator should read a token,
  // not what the device believes — an unmatched spelling simply stays neutral below.
  inactive: 'risk', notconnect: 'risk', disconnected: 'risk', errdisabled: 'risk',
  conflicted: 'risk', aborted: 'risk', failed: 'risk', error: 'risk',
  // switchport mode values: a mode is neither good nor bad, so it gets its own accent tone.
  access: 'mode', trunk: 'mode', 'dot1q-tunnel': 'mode', 'private-vlan': 'mode',
}

const toneFor = (value: string): StatePillTone => TONE_BY_TOKEN[value.trim().toLowerCase()] ?? 'neutral'

export interface StatePillProps {
  /** The device token, rendered exactly as received. Empty strings render as an empty pill — the
   *  container decides whether an absent field is 'Not reported' (`SwitchManager.tsx`'s wording). */
  readonly value: string
}

export function StatePill({ value }: StatePillProps) {
  return <span className={`state-pill state-pill-${toneFor(value)}`}>{value}</span>
}
