/**
 * S12 (#82): the pure rules behind the NTP screen. No React, no client import at runtime — these
 * are the client's rules MIRRORED for the UI (the way S2–S8 mirror their resources' `assert*`
 * guards), because a refusal must appear IN-FORM before a config session is paid for, and the
 * DEVICE stays the authority: a write this client allowed but the CLI rejects comes back as the
 * device's own `CommandError` (DR-057).
 *
 * ## Why the command text is composed here rather than by calling `node.ntp.*`
 *
 * The client's `addServer`/`removeServer`/`removeAllServers`/`setSourceInterface` verbs each open
 * their OWN transaction (`Entity.configure`) with no preview/diff step. The screen wave writes the
 * standing named-session way — session → `run` → device `diff()` → confirm → commit — exactly like
 * S8 (#78). So this screen stages plain command LINES whose text is byte-for-byte what the ported
 * verbs would put on the wire. Every string below was read off the pins in
 * `arista-api-client/src/resources/ntp.test.ts` (`ntp server 1.1.1.1` / `… 1.1.1.1 prefer` /
 * `no ntp server 1.1.1.1` / `no ntp` / `ntp source <iface>` / `ntp local-interface <iface>` /
 * `no ntp source` / `default ntp source`), never invented.
 *
 * ## The version floor is the one thing the client decides that the UI cannot see from the config
 *
 * `ntp source` vs `ntp local-interface` is chosen by {@link NtpResource.sourceKeyword} from the
 * device version (`resources/ntp.ts`: numeric compare of the leading `major.minor` against `4.23`,
 * refusal when unclassifiable — DR-078/DR-057). {@link sourceStem} mirrors that rule against the
 * soft `show version` read this screen already does for its identity chip. A server write is
 * version-free (the negated/affirmative `ntp server` stem is not version-conditional upstream), so
 * those controls stay live even when the version read fails; ONLY the source verbs need the stem,
 * and they hard-refuse when it cannot be picked — the screen never guesses a command form.
 */

/** The two source stems the client can compose — the dashed 4.23+ form and the older form. */
export type SourceStem = 'ntp source' | 'ntp local-interface'

/** pyeapi's own `'4.23'` literal floor (`ntp.py:91`/`:119`/`:131`/`:143`, kept as the client keeps it). */
const LOCAL_INTERFACE_FORM_MIN: readonly [number, number] = [4, 23]

/**
 * The numeric reading of the floor — the client's rule ported verbatim from `resources/ntp.ts`
 * (`versionFloorCompare`): compare the leading `major.minor`; `'4.9' >= '4.23'` is true
 * character-wise yet 4.9 predates 4.23, so a string compare is the trap this avoids. `undefined`
 * means "no leading major.minor at all" → the caller must refuse, not guess.
 */
export function versionFloorAtLeast(version: string, floor: readonly [number, number]): boolean | undefined {
  const parts = /^([0-9]+)\.([0-9]+)/u.exec(version)
  if (parts === null) return undefined
  const major = Number(parts[1])
  const minor = Number(parts[2])
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) return undefined
  return major - floor[0] !== 0 ? major > floor[0] : minor >= floor[1]
}

/**
 * Pick the source stem from the `show version` string, or refuse when this client cannot classify
 * the release. Mirrors `sourceKeyword` ({@link NtpResource}): on 4.23+ EOS spells the source word
 * `ntp local-interface`, below it `ntp source`; an unclassifiable version composes NO source command.
 *
 * @param version the raw `show version` string, or `undefined` when that read did not come back —
 *   the client-side floor needs SOME version to compare, and the read side is silent on failure, so
 *   a missing version is indistinguishable from a refusal and must hard-refuse the source verbs.
 */
export type StemResult = { readonly ok: true; readonly stem: SourceStem } | { readonly ok: false; readonly refusal: string }

export function sourceStem(version: string | undefined): StemResult {
  if (version === undefined) {
    return {
      ok: false,
      refusal:
        'The `show version` read did not answer, so this screen cannot pick between `ntp source` and `ntp local-interface`. The client refuses to guess which form this device accepts (mirrors sourceKeyword, resources/ntp.ts) — refresh the device state and try again, or make the server changes that do not depend on the version.',
    }
  }
  const atLeast = versionFloorAtLeast(version, LOCAL_INTERFACE_FORM_MIN)
  if (atLeast === undefined) {
    return {
      ok: false,
      refusal: `This client cannot classify the device version ${JSON.stringify(version)} against the 4.23 floor, so it refuses to compose a source command rather than guess the wrong form (mirrors sourceKeyword's unclassifiable-version refusal, resources/ntp.ts / DR-032/DR-057).`,
    }
  }
  return { ok: true, stem: atLeast ? 'ntp local-interface' : 'ntp source' }
}

/** C0 controls plus DEL, code-unit by code-unit — the client's `hasControlCharacter` (ntp.ts) mirrored. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/**
 * Why this server address is refused by THIS CLIENT, or `undefined` when the client would stage it.
 * Mirrors `assertServerAddress` (resources/ntp.ts): pyeapi raises "ntp server name must be
 * specified" for empty/whitespace, and this client further requires ONE token so the line can read
 * back (row 156). The whitespace arm is also where un-ported option spellings get refused: the
 * client's `addServer` port takes only `{ prefer }`, so it composes `ntp server <token>` optionally
 * followed by `prefer` and NOTHING else — a typed `version 4`, `iburst`, `attribute 3`, or an
 * embedded `prefer` is refused here with the client contract named as the reason, not silently
 * forwarded (the #82 acceptance line "refuse option spellings the client didn't port").
 */
export function serverAddressRule(rawValue: string): string | undefined {
  const value = rawValue.trim()
  if (value === '') {
    return 'This client refuses an empty NTP server address — `addServer`/`removeServer` raise pyeapi\u2019s "ntp server name must be specified" refusal (resources/ntp.ts). To take servers out, use the Remove button on a row or Remove all servers.'
  }
  if (/\s/u.test(value)) {
    return 'This client composes only `ntp server <address>`, optionally followed by the single word `prefer` \u2014 `addServer` takes a one-token address plus a { prefer } flag, nothing else. `version 4`, `iburst`, `attribute …` and other trailing option spellings are NOT part of this client\u2019s port, and a second token would not read back off the config (row 156), so this is refused before any session opens. Enter just the address and tick Prefer, or leave the option off entirely.'
  }
  if (hasControlCharacter(value)) {
    return 'This client refuses an NTP server address containing a control character: it would break the config line the client reads back (mirrors assertServerAddress, resources/ntp.ts).'
  }
  return undefined
}

/**
 * The byte-exact server line the client composes: `ntp server <addr>`, or `ntp server <addr> prefer`
 * when Prefer is ticked — pinned at `test_api_ntp.py:89-97` / ntp.test.ts.
 */
export function serverAddLine(address: string, prefer: boolean): string {
  return prefer ? `ntp server ${address} prefer` : `ntp server ${address}`
}
