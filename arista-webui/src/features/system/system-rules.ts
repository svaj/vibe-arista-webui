/**
 * S8 (#78): the pure rules behind the system-settings screen — hostname and banner guards, plus
 * the byte-exact banner framing. No React, no client import at runtime: these are the client's
 * rules MIRRORED for the UI (the way S2–S7 mirror their resources' `assert*` guards), because the
 * refusals must appear in the form before a config session is paid for — and the DEVICE stays the
 * authority: a `CommandError` from a write this client allowed renders as the device's own answer
 * (DR-057 / §5 row 89: the client's hostname rules are client policy, unverified on hardware).
 */

export type BannerKind = 'login' | 'motd' | 'exec'

/** The closed kind set the client accepts (`assertBannerKind`, resources/system.ts — pyeapi
 *  interpolates `banner %s` with NO check at system.py:171, which is how a name becomes part of
 *  a command line; the client's runtime re-check is the model for this one). */
export const BANNER_KINDS: readonly BannerKind[] = ['login', 'motd', 'exec']

/** Mirrors `HOSTNAME_MAX_LENGTH` (resources/system.ts:170) — "a generous local bound… the exact
 *  EOS limit is unverified on hardware, M12 (#14) to capture". */
export const HOSTNAME_MAX_LENGTH = 128

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u

/**
 * Why this hostname input is refused by THIS CLIENT, or `undefined` when the client would stage
 * it. Each message is prefixed to make the policy split legible in the UI: these are the client's
 * rules (`assertHostname`), not captured EOS rules — the device's answer outranks them.
 */
export function hostnameRule(value: string): string | undefined {
  if (value.trim() === '') return 'This client refuses an empty hostname — use "Remove hostname" (`no hostname`) instead of staging a blank value (mirrors assertHostname, resources/system.ts, pyeapi parses `^hostname ([^\\s]+)$`, system.py:82).'
  if (value.length > HOSTNAME_MAX_LENGTH) return `This client refuses hostnames over ${String(HOSTNAME_MAX_LENGTH)} characters; the exact EOS limit is unverified on hardware (M12 #14), so only clearly oversized input is refused here (mirrors assertHostname).`
  if (/\s/u.test(value) || CONTROL_CHARS.test(value)) return 'This client refuses a hostname that is not a single token: whitespace or a control character could not be read back (pyeapi parses `^hostname ([^\\s]+)$`, system.py:82 — mirrored by assertHostname).'
  if (value.includes('"')) return 'This client refuses a hostname containing a double quote: the reader unquotes a balanced pair, so the value could not round-trip (MIGRATION.md §5 row 49, mirrored by assertHostname). Legality on EOS is unverified on hardware (M12 #14) — if you believe the device accepts it, the hostname read after commit is the referee.'
  if (/^[0-9]/u.test(value)) return 'This client refuses a hostname starting with a digit — a purely client-side rule (pyeapi checks nothing at system.py:118-134; unverified on hardware, M12 #14). The device keeps authority: the client lets the command through and its `^hostname ([^\\s]+)$` reader then decides what reads back.'
  return undefined
}

export type BannerFraming = { readonly refusal: string } | { readonly body: string; readonly input: string }

/**
 * The client's body rules + byte-exact terminator framing (`assertBannerBody` + `setBanner`,
 * resources/system.ts:255-271, :431-437; DR-015/DR-056). The input is always `${body}\nEOF\n`,
 * and one trailing newline from the caller is folded so `x` and `x\n` are byte-identical on the
 * wire — which is what makes the acceptance line "banner payload byte-for-byte" pinnable here.
 */
export function bannerFraming(kind: BannerKind, text: string): BannerFraming {
  if (text.includes('\r')) return { refusal: `This client refuses a ${kind} banner body containing a carriage return: its reader treats CR as a line boundary, so the stored block could not read back as written (config/text.ts parity with CPython splitlines; how EOS itself treats CR in a banner is uncaptured on this unit, M12 #14). (mirrors assertBannerBody)` }
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  if (body.trimEnd() === '') return { refusal: `This client refuses an empty ${kind} banner body: a blank write is refused (DR-037), so clear the block explicitly with "no banner ${kind}" using the Remove button instead (mirrors assertBannerBody / command-builder's empty-value refusal).` }
  for (const line of body.split('\n')) {
    if (line.replace(/\s+$/u, '') === 'EOF') return { refusal: `A ${kind} banner body line reading "EOF" would end the block early — the very terminator rule this client's reader applies (client.py:743, mirrored by assertBannerBody). Shorten the text above that line, or remove the banner instead.` }
  }
  return { body, input: `${body}\nEOF\n` }
}

/** The three banner section labels used in copy. */
export const BANNER_LABEL: Record<BannerKind, string> = {
  login: 'login (pre-auth)',
  motd: 'motd (message of the day)',
  exec: 'exec (per-session)',
}
