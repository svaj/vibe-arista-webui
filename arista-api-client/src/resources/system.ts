/**
 * `system` — the first wave-1 resource module, M8 (#10): hostname, `ip routing` and the
 * EOF-terminated banners, built entirely on the M7 (#9) framework (`Entity`, `ResourceBase.config` /
 * `configSections` / `configure` / `commandBuilder`, the DR-026 `Node` memo, the registry).
 *
 * Port of `pyeapi/api/system.py` (186 lines, BSD-3-Clause, Arista Networks — DR-001). Every `pyeapi`
 * range in this file was opened in the pinned clone `/home/svaj/development/arista/pyeapi` on
 * 2026-11-03; every behavioural claim is what the upstream code **actually answers** (probes noted
 * inline), not what its docstring says. Nothing here cites EOS image internals: this workspace has no
 * readable CLI sources (`arista/_rea_swi` yields one `.py*` file total) and unit tests never touch a
 * device, so any EOS-side rule is written "unverified on hardware, M12 (#14) to capture".
 *
 * | pyeapi (verified refs) | here |
 * |---|---|
 * | `System(Entity)` (`:50`) | {@link SystemResource} extends `Entity<SystemSettings>` (`base.ts:200`) |
 * | `get` (`:57-72`), three `_parse_*` one-key dicts merged with `dict.update` (`:67-70`) | one `get()` built in a single pass over one config read; keys are typed, not stringly (MIGRATION.md §4, DR-003) |
 * | `_parse_hostname` (`:74-85`): `re.search(r'^hostname ([^\s]+)$', self.config, re.M)` (`:82`), fallback `'localhost'` (`:81`) | {@link hostnameFromConfig} — same anchored, single-token rule (plus M6's `unquote`); fallback `''` |
 * | `_parse_iprouting` (`:87-95`): `value = 'no ip routing' not in self.config` (`:94`) | {@link ipRoutingFromConfig} — same default, matched line by line rather than as a substring of the whole document |
 * | `_parse_banners` (`:97-116`): `re.findall(r'^banner\s+(login\|motd)\s?$\n(.*?)$\nEOF$\n', …, re.DOTALL \| re.M)` (`:108-109`), last match wins (`:110-114`), keys `banner_motd` / `banner_login` (`:116`) | {@link bannerBodyFrom} over the chunker's `banner …` sections (`client.py:747` opener, `:743` `EOF` line compared after `rstrip`); kinds `login`/`motd`/`exec`, grouped under `banner` |
 * | `set_hostname` (`:118-134`, `command_builder` at `:132`) | `setHostname` / `unsetHostname` / `defaultHostname` — the verb table in `base.ts`'s header and `docs/USAGE.md` §6 |
 * | `set_iprouting` (`:136-155`; `if value is False: disable = True` at `:151-152`, builder at `:153`) | `setIpRouting(true\|false)` / `unsetIpRouting` / `defaultIpRouting` |
 * | `set_banner` (`:157-181`; `command_string = "banner %s" % banner_type` `:171`, negation branch `:172-175` with `value=None`, write branch `:176-180`: `value = value + "\n"` `:177-178`, `dict(cmd=…, input=value)` `:179`) | `setBanner` / `unsetBanner` / `defaultBanner`; `input` ends with `\nEOF\n` (DR-015) and never doubles a caller's trailing newline |
 * | `instance(api)` (`:183-186`) | the `RESOURCE_FACTORIES.system` row plus `Node.system` (DR-006/DR-052) |
 *
 * Upstream's own suite is `test/unit/test_api_system.py` — **5** tests (`test_get` `:50-55`,
 * `test_set_hostname` `:57-69`, `test_set_iprouting` `:71-82`, `test_set_banner` `:84-89`,
 * `test_set_banner_default_disable` `:91-99`), counted by AST on 2026-11-03. `docs/TESTING.md` §6 already
 * says 5; `docs/PLAN.md` §M8 says 7 and `docs/PLAN.md`'s "→ 12 unit tests" target is not what this module
 * needed — both reported rather than matched silently.
 *
 * ## Divergences this file owns — one per MIGRATION.md §5 rows 83-90, cited at each item below
 *
 * 1. **hostname fallback** (§5 row 83): upstream answers the literal `'localhost'` when the config has no matching
 *    line (`system.py:81`, `value = 'localhost'` before the search). EOS never reports `localhost` for a
 *    configured device and the claim belongs to the CLI, not to pyeapi, so the fallback here is `''` —
 *    an empty field a UI can show as "not read", never a name the switch does not have.
 * 2. **the scalar reads are scoped to top-level sections, not to the whole text** (§5 row 84). Upstream matches
 *    `^hostname ([^\s]+)$` with `re.M` over the entire document (`system.py:80`/`:82`) and tests
 *    `'no ip routing' not in self.config` as a bare substring (`system.py:94`). Probes on the pinned
 *    clone: a config whose only `hostname …` line sits inside a `banner motd` body answers
 *    `'frombanner'`; a banner body reciting `no ip routing` answers `iprouting: False` on a switch with
 *    routing on; and an indented `   no ip routing` inside a sub-mode counts for the substring test too.
 *    Both fields here come from the **chunked** document (`configSections()`, `client.py:741-747`'s
 *    swallow included), so only an actual top-level command answers, a sub-mode's indented copy carries
 *    its indent in the key (`config/chunk.ts`'s output shape) and a banner body can never speak for the
 *    device. One asymmetry, in the other direction: chunker keys are `rstrip`ped, so `hostname sw1 `
 *    (a trailing space) reads as `sw1` here while upstream's `$` refuses it and falls back to
 *    `'localhost'`. Absence of `ip routing` still means enabled — upstream's default (`:94`) and an
 *    EOS-side claim for M12 (#14) to confirm.
 * 3. **banner kinds** (§5 row 85): upstream's character class is `(login|motd)` (`system.py:108`); `exec` is not read
 *    (probe: `banner exec\nshell exit\nEOF\n` → no match, and `test_get` pins the key set to four
 *    entries, `test_api_system.py:51`). This module reads `login`/`motd`/`exec`, because the chunker
 *    gives every `banner ` block a section key (`client.py:747`) and hiding the exec banner from the UI
 *    would be a wrong answer about the device. Whether EOS writes that form is an M12 capture.
 * 4. **banner terminator strictness** (§5 row 86): upstream needs `\nEOF$\n`, i.e. a newline after `EOF`
 *    (`system.py:108`). Probe: `banner motd\nhi\nEOF` with no trailing newline → no match, so a final
 *    banner silently disappears. {@link bannerBodyFrom} accepts `EOF` as the last line of the section.
 *    Upstream also needs the header line to end with at most one space (`\s?$`); probe: `banner motd  `
 *    (two) → no match, while the chunker's key is `rstrip`ped (`client.py:741-747`), so we read it.
 * 5. **empty banner body** (§5 row 87): `banner motd\n\nEOF\n` gives upstream `''` (`system.py:116`), while
 *    `banner motd\nEOF\n` gives **nothing** (probe: no match) — the same "no banner" answer as absence.
 *    Here both are present-with-empty-body (`''`), because the chunker really did see an EOF-terminated
 *    block. Distinguishing "absent" from "present but blank" is DR-027's vocabulary.
 * 6. **banner write payload** (§5 row 88): upstream sends `input = value (+ "\n" if missing)` and **no** `EOF`
 *    (`system.py:177-179`; `test_api_system.py:88` pins `input` to the value with one trailing newline).
 *    DR-015's shape is the one EOS's `banner` needs — `{cmd:'banner motd', input:'text\nEOF\n'}` — so we
 *    append the terminator and **strip** a caller's trailing newline instead of appending one, which is
 *    what keeps `setBanner('motd', 'x')` and `setBanner('motd', 'x\n')` byte-identical on the wire.
 * 7. **no input validation upstream** (§5 row 89): nothing checks a hostname (`system.py:118-134` interpolates through
 *    `command_builder` `:132`), nothing checks `banner_type` (`:171`), and `set_banner('motd', None)`
 *    crashes with `AttributeError` at `:177` (`None.endswith`). {@link assertHostname},
 *    {@link assertBannerKind} and {@link assertBannerBody} refuse those inputs with `NotSupportedError`
 *    naming the rejected value — DR-053's pattern, and no new error class (DR-005/DR-010).
 * 8. **key names** (§5 row 90): upstream's record is flat with snake_case (`hostname`, `iprouting`, `banner_motd`,
 *    `banner_login` — `system.py:116`, `test_api_system.py:51`); ours is `hostname` / `ipRouting` /
 *    `banner.{login,motd,exec}` per MIGRATION.md §4 and DR-003.
 *
 * `parseConfigBlock` (`config-block.ts`) is deliberately **not** used by this module: its extractors run
 * over `parseBlock`, which rstrips each line, drops the leading indent and `unquote`s the value
 * (`config/text.ts`'s `describeLine`). That is right for `name PROD` and wrong for a banner body, which
 * must come back byte-for-byte — the pinned upstream fixture keeps a 9-space line inside `banner login`
 * (`pyeapi/test/fixtures/running_config.text:410`), and a `"` inside a banner must stay a `"`
 * (MIGRATION.md §5 row 49/81's `findValue` caveat is M9 #11's to settle). The hostname and `ip routing`
 * fields are not section-body keywords either, and `parseConfigBlock` drops the first line as the block
 * header — which for a global entity is the `hostname` line itself. What this module reuses is the
 * **chunker** (`configSections`, one device read off the DR-026 memo): its indent-0 section keys are
 * exactly the top-level commands, its `banner ` sections are the EOF-terminated blocks, and
 * `splitLines`/`rstrip`/`unquote` from `config/text.ts` do the byte-level work. That is the same engine
 * `Node.section`/`Node.getBlock` use, so M6's reviewed rules — not a per-module regex over device text —
 * decide what counts as a top-level line.
 */

import { NotSupportedError } from '../errors'
import { pythonRepr } from '../internal/wire'
import { rstrip, splitLines, unquote } from '../config/text'
import { Entity } from './base'
import type { ConfigSections } from '../config/chunk'

/**
 * The banner kinds this module reads and writes. pyeapi's regex spells only `login|motd`
 * (`api/system.py:108`) and its `set_banner` accepts any string at all (`:171`), so the union is not
 * inherited from upstream — it is the closed set this module will put into `banner <kind>` after this
 * milestone. Which of them a given EOS release writes/accepts is unverified on hardware, M12 (#14).
 */
export type SystemBannerKind = 'login' | 'motd' | 'exec'

/** The kinds in wire/parse order, for the runtime guard's message. */
const BANNER_KINDS: readonly SystemBannerKind[] = ['login', 'motd', 'exec']

/** A banner body, exactly as the device wrote it between `banner <kind>` and the `EOF` line. */
export interface SystemBanner {
  /** `banner login` — shown before the login prompt. */
  readonly login?: string
  /** `banner motd` — shown after login. */
  readonly motd?: string
  /** `banner exec` — shown at executive-mode entry. Not read by pyeapi (`system.py:108`, divergence 3). */
  readonly exec?: string
}

/**
 * What `system.get()` answers. `banner` is always present (upstream always emits its two banner keys,
 * `system.py:116`); an individual kind is absent when the device has no such block — `undefined`, not
 * pyeapi's `None`, per DR-027's "absent is ordinary control flow".
 */
export interface SystemSettings {
  /** The configured hostname, or `''` when the running-config has no readable `hostname` line. */
  readonly hostname: string
  /** `no ip routing` absent from the config's top level ⇒ enabled (pyeapi's default, `system.py:94`). */
  readonly ipRouting: boolean
  /** The EOF-terminated banners this module knows about. */
  readonly banner: SystemBanner
}

/**
 * The `hostname` line, matched against a **section key** — which is a whole top-level command line,
 * `rstrip`ped by the chunker (`client.py:741`), not a scan of the document.
 *
 * pyeapi's `^hostname ([^\s]+)$` (`system.py:82`) is reproduced for the unquoted case: one space, one
 * token, nothing else on the line. Verified against the pinned clone (`:82` run over the texts
 * below): `hostname sw1` → `sw1`; `hostname ` → the `'localhost'` fallback; `hostname sw1 ` (trailing
 * space) → fallback, because Python's `$` under `re.M` is a line end, not a position before spaces — the
 * one input where this client answers `sw1` instead, because the key was rstripped first (divergence 2).
 *
 * The added alternative reads EOS's `"quoted value"` form through M6's `unquote` (`config/text.ts`),
 * which row 49 says pyeapi lacks: probe — `hostname "lab sw1"` gives upstream the fallback too. An
 * unbalanced pair is left as written rather than repaired. Whether EOS quotes a hostname is unverified on
 * hardware, M12 (#14) to capture; the parse only says what this client does with the text it was given.
 */
const HOSTNAME_KEY = /^hostname (\S+|"[^"\n]*")$/u

/** The negated form of the routing flag, as an exact top-level section key (`system.py:94` tests a substring instead). An explicit `ip routing` line is indistinguishable from absence here — exactly as upstream's rule makes it, which looks only for the negation. */
const NO_IP_ROUTING_KEY = 'no ip routing'

/** Section key for an EOF-terminated banner block. Anchored, so a sub-mode's indented copy is not read (divergence from nothing — parity with `system.py:108`, and `test/fixtures/config/banner-indented-not-multiline.conf` records that the chunker does not treat an indented opener as multiline either). */
const BANNER_SECTION = /^banner (login|motd|exec)$/u

/**
 * The terminator line of an EOF-delimited block. The chunker compares it after `rstrip`
 * (`client.py:743`), so the read side compares it the same way — `banner-eof.conf` in
 * `test/fixtures/config/` is the committed shape.
 */
const EOF_LINE = 'EOF'

/**
 * Client-side upper bound on a hostname. This is a **policy of this client**, not a captured EOS
 * limit: the CLI's real maximum is not obtainable in this workspace (no readable image sources, no
 * device in unit tests), so the bound is deliberately generous, the device keeps the authority to
 * refuse (DR-032), and M12 (#14) owns the exact figure.
 */
const HOSTNAME_MAX_LENGTH = 128

/** A rejected argument is named in the message, rendered pyeapi's way — the `refuse` pattern from `validators.ts` (DR-053). */
function refuse(label: string, value: unknown, because: string): never {
  throw new NotSupportedError(`invalid ${label} ${pythonRepr(value)} — ${because}`, { cause: value })
}

/** C0 controls plus DEL, checked code-unit by code-unit rather than with a control-character regex class. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/**
 * Require an EOS-shaped hostname.
 *
 * pyeapi has **no** hostname validation anywhere in `api/system.py`: `set_hostname(value=None,
 * default=False, disable=False)` (`:118`) hands `value` straight to `command_builder` (`:132`), which
 * interpolates it (`abstract.py:158-159`) or, for `value=None`, produces the deprecated `no hostname`
 * (`abstract.py:160-161`, DR-037). Whole-file check on 2026-11-03: the module's only `re` use is in the
 * three `_parse_*` readers (`:82`, `:94`, `:108`).
 *
 * Each refusal is a round-trip guarantee about **this** client's reader, not an EOS claim, except where
 * the note says otherwise:
 *  - not a string, or blank after trimming — `commandBuilder` refuses an all-whitespace value the same way
 *    (`command-builder.ts`, "an empty value would send a trailing space");
 *  - any other whitespace or a control character — {@link HOSTNAME_KEY} reads one token, so a name with a
 *    space cannot come back (`system.py:82`'s `[^\s]+` is upstream's version of the same fact). A leading
 *    space is refused by this same rule, not by a special case of its own;
 *  - a `"` anywhere — the read side unquotes a balanced pair, so a name containing one would not round-trip;
 *  - a leading digit — the conventional host-name rule, stated as a client rule: **unverified on hardware,
 *    M12 (#14) to capture** whether EOS rejects it (pyeapi certainly does not);
 *  - longer than {@link HOSTNAME_MAX_LENGTH} — a generous local bound (see above).
 *
 * @throws {NotSupportedError} always a programming/input mistake, never a device condition
 *   (`docs/ARCHITECTURE.md` §4), and no new error class (DR-005/DR-010).
 */
function assertHostname(value: unknown): asserts value is string {
  if (typeof value !== 'string') refuse('hostname', value, 'expected a string hostname')
  if (value.trim() === '') {
    refuse('hostname', value, 'an empty hostname is refused — pass unsetHostname() (pyeapi `no hostname`) rather than an empty value (abstract.py:160-161, DR-037)')
  }
  if (value.length > HOSTNAME_MAX_LENGTH) {
    refuse('hostname', value, `expected at most ${String(HOSTNAME_MAX_LENGTH)} characters — the exact EOS limit is unverified on hardware, M12 (#14) to capture, so this client only refuses clearly oversized input`)
  }
  if (/\s/u.test(value) || hasControlCharacter(value)) {
    refuse('hostname', value, 'expected a single token: whitespace or a control character cannot be read back (pyeapi parses `^hostname ([^\\s]+)$`, system.py:82)')
  }
  if (value.includes('"')) {
    refuse('hostname', value, 'a hostname containing a quote cannot round-trip through this reader, which unquotes a balanced pair (config/text.ts, MIGRATION.md §5 row 49). Legality on EOS is unverified on hardware, M12 (#14) to capture')
  }
  if (/^[0-9]/u.test(value)) {
    refuse('hostname', value, 'a hostname may not start with a digit (client-side rule — pyeapi checks nothing at system.py:118-134; unverified on hardware, M12 (#14) to capture)')
  }
}

/** `banner_type` reaches `"banner %s"` unvalidated upstream (`system.py:171`); here it is a closed set, checked at runtime for JS callers (the same reason `command-builder.ts` re-checks `mode`). */
function assertBannerKind(kind: unknown): asserts kind is SystemBannerKind {
  if (BANNER_KINDS.includes(kind as SystemBannerKind)) return
  refuse('banner kind', kind, `expected one of ${BANNER_KINDS.join(' / ')} — pyeapi interpolates banner_type into "banner %s" with no check at all (system.py:171), which is how a name becomes part of the command line`)
}

/**
 * Validate a banner body and normalise its trailing newline.
 *
 * Upstream's `set_banner` write branch (`system.py:176-180`) does `if not value.endswith("\\n"): value
 * = value + "\\n"` (`:177-178`) and sends that as `input` with no `EOF` (`:179`), so a caller who
 * already supplied the newline gets one copy and a caller who did not gets one appended — a body with a
 * deliberately blank last line is unreachable through pyeapi. `set_banner('motd', None)` raises
 * `AttributeError` there (`None.endswith`), which is DR-053's reason for a guard.
 *
 * Ours takes the body verbatim, drops **one** trailing newline (divergence 6, so `'x'` and `'x\n'` send
 * the same bytes), and refuses the two inputs this client could not read back:
 *  - a line that reads `EOF` after `rstrip` — it would close the block early and turn the rest of the
 *    body into commands; the chunker uses the same comparison (`client.py:743`), and DR-015's `input`
 *    exists precisely because `banner` reads stdin until such a line;
 *  - a carriage return — a lone `CR` is a line boundary for this client's reader (`LINE_BREAK_CHARS`,
 *    `config/text.ts`, CPython `splitlines` parity), so such a body would come back split differently
 *    than it went out. How EOS itself treats it is unverified on hardware, M12 (#14) to capture.
 */
function assertBannerBody(kind: SystemBannerKind, value: unknown): string {
  if (typeof value !== 'string') {
    refuse('banner body', value, `expected the ${kind} banner text as a string — pyeapi raises AttributeError here when set_banner gets None (system.py:177)`)
  }
  if (value.includes('\r')) {
    refuse('banner body', value, 'a carriage return is a line boundary for this client\'s reader (config/text.ts), so the body would not read back as written — unverified on hardware, M12 (#14) to capture')
  }
  const body = value.endsWith('\n') ? value.slice(0, -1) : value
  if (body.trimEnd() === '') {
    refuse('banner body', value, `an empty ${kind} banner is refused — clear it with unsetBanner/defaultBanner ("no banner ${kind}", "default banner ${kind}") instead (command-builder.ts refuses an empty value for the same reason, DR-037)`)
  }
  for (const line of splitLines(body)) {
    if (rstrip(line) === EOF_LINE) {
      refuse('banner body', value, `a body line reading ${EOF_LINE} would end the ${kind} banner block early (the terminator rule the chunker applies too, client.py:743) — send the shorter text, or use unsetBanner`)
    }
  }
  return body
}

/**
 * The hostname, or `''`. Read from the chunked document's **indent-0 section keys**, which is where an
 * actual `hostname …` command lives; upstream scans the whole config text with `re.M` (`system.py:82`
 * + `:82`) and so reads the value out of a `banner` body — probe: a config whose only such line is inside
 * `banner motd … EOF` answers `'frombanner'` upstream. Device order is kept, so the first top-level match
 * wins exactly as `re.search` returns the first match; {@link unquote} handles the quoted form (row 49)
 * and the invented `'localhost'` fallback (`:81`) is dropped (divergence 1).
 */
function hostnameFromSections(sections: ConfigSections): string {
  for (const key of sections.keys()) {
    const match = HOSTNAME_KEY.exec(key)
    if (match?.[1] !== undefined) return unquote(match[1])
  }
  return ''
}

/**
 * Is routing enabled? Upstream's answer is `'no ip routing' not in self.config` (`system.py:94`): a
 * **substring** of the whole document, so a banner body reciting the phrase flips it to `False` (probe)
 * and an indented copy inside any sub-mode counts too. Here the flag is an exact top-level section key,
 * which is also where {@link SystemResource.setIpRouting} writes it. Absence ⇒ `true`, which is upstream's
 * default (`:94`) and an EOS-side statement this workspace cannot verify (M12 #14).
 */
function ipRoutingFromSections(sections: ConfigSections): boolean {
  if (sections.has(NO_IP_ROUTING_KEY)) return false
  return true
}

/** Which banner kind a section key names, or `undefined` when the key is not a banner block. */
function bannerKindOf(key: string): SystemBannerKind | undefined {
  const match = BANNER_SECTION.exec(key)?.[1]
  return match === undefined ? undefined : (match as SystemBannerKind)
}

/**
 * The body of one `banner <kind>` section: the section text minus its header line and minus the `EOF`
 * line, joined **verbatim** (no `rstrip` per line, no `unquote`, indentation kept). Byte fidelity is not
 * decoration — upstream's own fixture carries a 9-space line inside `banner login`
 * (`pyeapi/test/fixtures/running_config.text:407-416`) and the capture keeps it (probe against
 * `system.py:108`: the `login` value ends `…banner:\n         \nvlan 1\n…`).
 *
 * `undefined` when the block is not terminated: the chunker keeps swallowing to the end of the document
 * if `EOF` never arrives, and an unterminated block is not a banner this module can claim. pyeapi needs
 * a newline **after** `EOF` (`\nEOF$\n`, `system.py:108`) and so drops a final banner outright (probe:
 * `banner motd\nhi\nEOF` → no match); here an `EOF` line is recognised in either position (divergence 4).
 */
function bannerBodyFrom(sectionText: string): string | undefined {
  const lines = splitLines(sectionText)
  if (lines.length < 2) return undefined
  const last = lines[lines.length - 1]
  // The `undefined` arm is a compiler narrowing, not a repair path: `length >= 2` guarantees a last line,
  // exactly like the `?? ''` the chunker keeps for the same reason (`config/chunk.ts`).
  if (last === undefined || rstrip(last) !== EOF_LINE) return undefined
  return lines.slice(1, -1).join('\n')
}

/**
 * The banner fields of a chunked document, in one pass and zero extra reads.
 *
 * Last block wins for a repeated kind — pyeapi iterates `re.findall` in order and overwrites
 * (`system.py:110-114`), and the chunker keeps device order in its map (`config/chunk.ts`), so the two
 * agree without this module owning a rule of its own. A kind with no terminated block is left **absent**,
 * which is how `get()` distinguishes "the switch has no such banner" from a blank one (divergence 5).
 */
function bannersFromSections(sections: ConfigSections): SystemBanner {
  const banner: { -readonly [K in keyof SystemBanner]?: SystemBanner[K] } = {}
  for (const [key, text] of sections) {
    const kind = bannerKindOf(key)
    if (kind === undefined) continue
    const body = bannerBodyFrom(text)
    if (body === undefined) continue
    banner[kind] = body
  }
  return banner
}

/**
 * `node.system` — the global system settings of one switch.
 *
 * `Entity<SystemSettings>` (pyeapi's `System(Entity)`, `system.py:50`) rather than a
 * `ResourceBase` with methods, because there is exactly one of these per `Node`: `get()` always answers
 * something (a global with nothing configured still has an answer, `base.ts`'s `Entity` note) and the
 * writes are field verbs, not entry verbs.
 */
export class SystemResource extends Entity<SystemSettings> {
  /**
   * One chunked running-config, three fields. pyeapi's `get` (`system.py:57-72`) merges
   * `_parse_hostname` + `_parse_iprouting` + `_parse_banners`, each of which re-reads `self.config`
   * (`:82`, `:94`, `:109`) — a `show running-config` **per field** (MIGRATION.md §5 row 15). Here the
   * section document comes from the `Node`'s DR-026 memo, so the whole record costs one request, which
   * `system.test.ts` pins from the transport's command list.
   *
   * A device failure throws rather than answering a partly-empty record, and a config that genuinely has
   * nothing global in it still answers: `hostname: ''`, `ipRouting: true`, `banner: {}` (DR-027's
   * empty-versus-absent vocabulary, and `Entity`'s "a global with nothing configured still has an answer").
   */
  async get(): Promise<SystemSettings> {
    const sections = await this.configSections()
    return {
      hostname: hostnameFromSections(sections),
      ipRouting: ipRoutingFromSections(sections),
      banner: bannersFromSections(sections),
    }
  }

  /** `hostname <value>` — pyeapi `set_hostname(value=…)` (`system.py:118-134`). */
  async setHostname(value: string): Promise<void> {
    assertHostname(value)
    await this.configure(this.commandBuilder('hostname', { value }))
  }

  /** `no hostname` — pyeapi spells this `set_hostname(disable=True)` (`abstract.py:154-155`, asserted by `test_api_system.py:64`). */
  async unsetHostname(): Promise<void> {
    await this.configure(this.commandBuilder('hostname', { mode: 'no' }))
  }

  /** `default hostname` — pyeapi's `set_hostname(default=True)` (`abstract.py:152-153`, `test_api_system.py:67`). */
  async defaultHostname(): Promise<void> {
    await this.configure(this.commandBuilder('hostname', { mode: 'default' }))
  }

  /**
   * `ip routing` / `no ip routing`, from a boolean — the port of `set_iprouting(value=…)`, whose
   * `if value is False: disable = True` (`system.py:151-152`) is how upstream turns `False` into the
   * negated command. Everywhere else in this client, falsy is not a value (DR-037) and `commandBuilder`
   * would throw on `value: false` while still honouring the same `{ mode: 'no' }` answer (row 73).
   *
   * @throws {NotSupportedError} a non-boolean, naming it. pyeapi would take `0`/`''`/`None` as
   *   "falsy-but-not-False" and reach the deprecated `no ip routing` fall-through (`abstract.py:158-161`).
   */
  async setIpRouting(value: boolean): Promise<void> {
    if (typeof value !== 'boolean') {
      refuse('ip routing', value, 'expected true or false — pyeapi maps only `value is False` to the no form (system.py:151-152) and lets anything else fall through to the deprecated command (abstract.py:160-161, DR-037)')
    }
    await this.configure(this.commandBuilder('ip routing', value ? { value: true } : { mode: 'no' }))
  }

  /** `no ip routing` — pyeapi's `set_iprouting(disable=True)` (`test_api_system.py:77`). */
  async unsetIpRouting(): Promise<void> {
    await this.configure(this.commandBuilder('ip routing', { mode: 'no' }))
  }

  /** `default ip routing` — pyeapi's `set_iprouting(default=True)` (`test_api_system.py:80`). */
  async defaultIpRouting(): Promise<void> {
    await this.configure(this.commandBuilder('ip routing', { mode: 'default' }))
  }

  /**
   * Write one banner: `{ cmd: 'banner motd', input: 'text\nEOF\n' }` (DR-015).
   *
   * `input` must be terminated the way EOS reads stdin for this command, so the `EOF` line is part of
   * the payload rather than something a caller has to remember; a caller-supplied trailing newline is
   * folded into that terminator instead of producing a blank line before it (divergence 6). The `cmd`
   * text still goes through the builder, so kind validation and the single-line rule stay in one place
   * (`commandBuilder(…, { value: true })` is "the bare command", `abstract.py:156-157`).
   *
   * A rejected write rejects with the device's `CommandError` (`failedCommand` included) — never the
   * `False` pyeapi's `configure` returns (`abstract.py:117-127`, DR-005).
   */
  async setBanner(kind: SystemBannerKind, text: string): Promise<void> {
    assertBannerKind(kind)
    const body = assertBannerBody(kind, text)
    const cmd = this.commandBuilder(`banner ${kind}`, { value: true })
    await this.configure({ cmd, input: `${body}\n${EOF_LINE}\n` })
  }

  /** `no banner <kind>` — pyeapi's `set_banner(kind, value=None, disable=True)` (`system.py:172-175`, `test_api_system.py:98`). */
  async unsetBanner(kind: SystemBannerKind): Promise<void> {
    assertBannerKind(kind)
    await this.configure(this.commandBuilder(`banner ${kind}`, { mode: 'no' }))
  }

  /** `default banner <kind>` — pyeapi's `set_banner(kind, value=None, default=True)` (`system.py:172-175`, `test_api_system.py:94`). */
  async defaultBanner(kind: SystemBannerKind): Promise<void> {
    assertBannerKind(kind)
    await this.configure(this.commandBuilder(`banner ${kind}`, { mode: 'default' }))
  }
}
