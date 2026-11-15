/**
 * S14 (#84): the pure rules behind the READ-ONLY MLAG status screen. No React, no device call,
 * no writes anywhere — this screen ships none (MLAG configuration spans a PAIRED device, so the
 * #84 scope line closes editing outright; the banner in ./MlagView.tsx says so to the operator).
 *
 * ## The two sources, never merged (the acceptance shape #84 grades)
 *
 * - `node.mlag.get()` (client `resources/mlag.ts`, W2d/#43) is parsed running-config: the
 *   `mlag configuration` section plus every `interface Po…` block carrying an `mlag <digits>`
 *   line. Absent section ⇒ every config field absent and `shutdown` absent with it
 *   (divergence 1/3 there); section present ⇒ `shutdown` ALWAYS has a value because the client
 *   derives it from the missing `no shutdown` line. That asymmetry is {@link isMlagUnconfigured}
 *   and {@link describeShutdownFlag} below — both copied from the client’s documented behaviour,
 *   not invented here.
 * - `node.show('mlag')` is the capture-backed device-state read (`src/eapi/show-contracts.ts`,
 *   `ShowMlagReply`, cEOS-lab 4.28.14M capture). The contract comment assigns the display
 *   narrowing to the screen: “Statuses stay raw device strings (DR-032); the MLAG panel narrows
 *   them for display.” That narrowing is {@link deviceStateView} — and it maps ONLY the `state`
 *   key that the capture actually carries. The captured payload has no consistency-check key, so
 *   this file composes no consistency value of any kind; the view states the absence instead.
 */
import type { MlagGlobalConfig } from '@devhax-heavy-industries/arista-eapi'
import type { ShowMlagReply } from '../../eapi/show-contracts'

/** What a config field with no line reads as on this screen — absence, never a guessed default. */
export const NOT_CONFIGURED = '(not configured)'

/** Pill token {@link deviceStateView} falls back to when the `show mlag` read did not answer. */
export const UNKNOWN_PILL_VALUE = 'unknown'

/**
 * The five `show mlag` state tokens this screen maps to a human label — the list issue #84 names.
 * The mapping is display-only: the raw device string is always rendered ALONGSIDE the label, and a
 * token outside this map is shown verbatim and marked unrecognised (DR-032: an invented label
 * would be a claim about the device, and the captured vocabulary for an enabled domain is a
 * hardware question M12 (#14) still owes).
 */
export const KNOWN_MLAG_STATE_LABELS: Readonly<Record<string, string>> = {
  active: 'Active',
  disabled: 'Disabled',
  inactive: 'Inactive',
  paused: 'Paused',
  misconfigured: 'Misconfigured',
}

/**
 * How the status pill renders. `reported` echoes the device’s own `state` string; `unknown` is
 * the arm for an unanswered or rejected (e.g. `Error [1002]`) `show mlag` — the screen’s
 * acceptance line is that this is NEVER an error wall.
 */
export type MlagStateView =
  | { readonly kind: 'reported'; readonly raw: string; readonly label: string; readonly recognised: boolean }
  | { readonly kind: 'unknown'; readonly reason: string }

/**
 * Narrow the captured `state` field for display. `show === undefined` means the soft read folded
 * a failure (or never came back); `showFailure` is the device/client text for it, verbatim, so a
 * 1002 refusal reaches the operator as the 1002 message rather than a crash.
 */
export function deviceStateView(show: ShowMlagReply | undefined, showFailure: string | undefined): MlagStateView {
  if (show === undefined) {
    return { kind: 'unknown', reason: showFailure ?? 'The `show mlag` read did not answer.' }
  }
  const raw = show.state
  if (raw === '') {
    return { kind: 'reported', raw, recognised: false, label: 'The device answered with an empty state string.' }
  }
  const label = KNOWN_MLAG_STATE_LABELS[raw]
  if (label === undefined) {
    return { kind: 'reported', raw, recognised: false, label: 'Unrecognised device token \u2014 shown exactly as the device sent it.' }
  }
  return { kind: 'reported', raw, label, recognised: true }
}

/**
 * “MLAG not configured” — the shape the captured sample answers. True exactly when the client’s
 * read saw no `mlag configuration` section (every field absent; `shutdown` is absent ONLY with the
 * section, divergence 3 in resources/mlag.ts) and no Port-Channel carries an `mlag` id. This is a
 * NORMAL ready state, not an error — the view renders it with EmptyState copy.
 */
export function isMlagUnconfigured(config: MlagGlobalConfig, interfaceCount: number): boolean {
  return (
    config.domainId === undefined
    && config.localInterface === undefined
    && config.peerAddress === undefined
    && config.peerLink === undefined
    && config.shutdown === undefined
    && interfaceCount === 0
  )
}

/** String or absence, as displayed. An absent value never borrows a sibling’s meaning. */
export function fieldText(value: string | undefined): string {
  return value ?? NOT_CONFIGURED
}

/** Boolean or absence, as displayed. The show contract’s flags are required, so `undefined` is only reachable for unmodelled reads. */
export function flagText(value: boolean | undefined): string {
  if (value === undefined) return '(not reported)'
  return value ? 'Yes' : 'No'
}

/**
 * The shutdown flag’s three-way answer, in its own words because the three arms mean different
 * things (client resources/mlag.ts, divergences 1 and 3): explicit `no shutdown` line ⇒ false;
 * section without that line ⇒ true (the client’s DERIVATION, not a captured device claim); no
 * section at all ⇒ absent.
 */
export function describeShutdownFlag(value: boolean | undefined): string {
  if (value === undefined) {
    return 'Not reported \u2014 the running-config carries no `mlag configuration` section, so the flag itself is unknown (resources/mlag.ts divergence 1).'
  }
  if (value === false) {
    return 'No \u2014 the section carries an explicit `no shutdown` line.'
  }
  return 'Yes \u2014 the section carries no `no shutdown` line. That is how this client DERIVES the flag when the section exists (resources/mlag.ts divergence 3); the screen claims nothing about device defaults.'
}
