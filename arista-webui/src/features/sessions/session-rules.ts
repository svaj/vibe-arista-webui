/**
 * S9 (#79): the pure rules behind the transaction center — what a staged draft batch may contain,
 * how a device session row is rendered honestly, and the labelling contract for `verifyConfig()`
 * previews. No React, no device calls (the `command-guard.ts`/`system-rules.ts` pattern).
 *
 * ## Why the stage guard exists at all (the blast-radius answer, not a deny-list reflex)
 *
 * A draft batch types straight into a live config session, so the lines that must never come from
 * the textarea are the ones that HIJACK the review pipeline itself: `commit` would land what the
 * earlier lines staged before `diff()` was ever read (DR-050 exists precisely because commit is a
 * separate, confirmed act), `abort` would end the reviewing session from inside it, and
 * `configure session …`/`configure replace`/`rollback` move or rewrite sessions wholesale. The same
 * reasoning carries `copy running-config startup-config` (durability is always explicit, DR-024 —
 * and #79 names it OUT of scope, B4 territory) and `reload` (nothing in a reviewer reboots the
 * switch). The client would happily stage every one of these; the transaction center is the screen
 * that says no, so the commit/abort buttons stay the only exits from a draft.
 */

export const SESSION_NAME_PREFIX = 'ui-'

/** Prefix → reason, mirroring the shape of S7's `FORBIDDEN_CANDIDATES` but for a WRITE session.
 *  Matched whole-word-prefix over a line, client `PROBE_FORBIDDEN_PATTERN` style. */
export const DRAFT_FORBIDDEN_LINES: Readonly<Record<string, string>> = Object.freeze({
  commit: 'it commits inside the batch: this screen commits only through its own confirmed button, after the device diff has been READ (DR-050 — a preview that can silently write is the failure mode the whole session pipeline exists to prevent)',
  abort: 'it ends the very session reviewing the change, so diff/commit buttons would act on a dead handle',
  'configure session': 'it switches to a different named session mid-batch — your staged lines, and this screen\'s abort guarantee, would belong to the wrong session',
  'configure replace': 'wholesale config replacement is a B4 decision (#78/#79 explicit out-of-scope): it needs per-platform captures before any UI may reach for it',
  rollback: 'rollbacks (clean-config or to-a-session) are B4 out-of-scope pending capture of commit-timer semantics — the center stages, shows, and lets YOU decide',
  'copy running-config startup-config': 'durability is always explicit in this stack (DR-024); this screen writes running-config only and says so',
  reload: 'rebooting is never part of a staged review',
})

function forbiddenHit(line: string): readonly [verb: string, why: string] | undefined {
  for (const [verb, why] of Object.entries(DRAFT_FORBIDDEN_LINES)) {
    const escaped = verb.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    if (new RegExp(`^(?:${escaped})(?:\\s|$)`, 'u').test(line)) return [verb, why]
  }
  return undefined
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f\u2028\u2029]/u

/** Why this staged batch cannot be previewed, or `undefined` when it can. Refusals happen BEFORE
 *  any session opens — pinned at `configSession` call count 0 in the screen's tests. */
export function draftBatchRefusal(lines: readonly string[]): string | undefined {
  if (lines.length === 0) return 'A draft review needs at least one config line: an empty batch opens a session that can only diff nothing.'
  for (const line of lines) {
    if (CONTROL_CHARS.test(line)) return `A staged line carries a control character (${JSON.stringify(line.slice(0, 24))}… shown truncated). Config lines go to the CLI verbatim, so the batch is refused before any session opens.`
    if (line.length > 512) return 'A staged line exceeds 512 characters — that is not config vocabulary; it is somebody pasting a blob, and this screen reviews line-shaped changes.'
    const hit = forbiddenHit(line)
    if (hit !== undefined) return `Line ${JSON.stringify(line)} starts with \`${hit[0]}\`, which the transaction center refuses: ${hit[1]}.`
  }
  return undefined
}

/** Split the textarea on line boundaries and trim — blank lines are dropped (the CLI skips them). */
export function parseDraftLines(text: string): readonly string[] {
  return text.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== '')
}

/** One `show configuration sessions` row reduced to render-safe strings. Device state stays
 *  verbatim (DR-032: the value set is a device enum the port has only confirmed for `pending`), and
 *  the fields that make abort DANGEROUS (armed commit timer) are surfaced for the confirm text. */
export function describeSessionRow(session: {
  readonly name: string
  readonly state: string
  readonly description?: string
  readonly commitBy?: number
  readonly completedTime?: number
  readonly commitUser?: string
  readonly instances?: readonly unknown[]
}): { label: string; dangerous: boolean; timerNote?: string } {
  const timerActive = session.commitBy !== undefined
  const label = session.state === 'pending'
    ? (timerActive ? 'pending — a COMMIT TIMER is armed: its change is live and a revert is scheduled' : 'pending — holds the config lock')
    : session.state
  return {
    label,
    dangerous: timerActive || session.state === 'pending',
    ...(timerActive ? { timerNote: `commitBy epoch ${String(session.commitBy)}s — recovery never aborts a timer-armed session (DR-050): that is a decision to present, not cleanup to perform` } : {}),
  }
}

/** The `recoverOrphans()` outcome reduced to text lines: every bucket the client separates is
 *  reported, nothing is dropped (the same "unknown fields survive" rule as the wire codec). */
export function describeRecovery(outcome: {
  aborted: readonly string[]
  failed: readonly { name: string; reason?: string }[]
  skipped: readonly { name: string; reason?: string }[]
  remaining: readonly { name: string; state: string }[]
  reported: readonly { name: string; state: string }[]
}): readonly string[] {
  const bucket = (title: string, rows: readonly (string | { name: string; state?: string; reason?: string })[]): readonly string[] =>
    rows.length === 0 ? [] : [`${title} (${String(rows.length)}): ${rows.map((row) => typeof row === 'string' ? row : `${row.name}${row.state === undefined ? '' : ` [${row.state}]`}${row.reason === undefined ? '' : ` — ${row.reason}`}`).join(', ')}`]
  return [
    ...bucket('aborted by this run', outcome.aborted),
    ...bucket('device refused / not ours to touch', outcome.failed),
    ...bucket('identified but left alone (state not understood, too new, or timer-armed)', outcome.skipped),
    ...bucket('still pending afterwards', outcome.remaining),
    ...bucket('reported by the device, ignored by design (completed or foreign names)', outcome.reported),
  ]
}

/** The standing label `verifyConfig` answers must wear (DR-061, §5 row 118): the device builds the
 *  preview from `rollback clean-config`, NOT from the current running-config. */
export const VERIFY_LABEL = 'normalised configlet preview from the CLEAN config — it does NOT show what your change would do to this switch\'s running-config'
