/**
 * The ONE allowed-VLAN range grammar in this app (S3, #73). `TrunkEditor` and `TrunkEditorView`
 * consume these functions and must not carry their own copy — same rule that moved `stageLines`
 * out of S1 into `src/features/staged-batch.ts` when S2 became its second caller.
 *
 * ## Why the grammar lives here rather than being imported
 *
 * The client owns the authoritative version of both halves of this job:
 * - the **write grammar** is module-local to `arista-api-client/src/resources/switchports.ts`
 *   (`VLAN_ID_LIST` at `:374`, `VLAN_RUN` at `:376`, `ID_LIST_CHARSET` at `:382`, and
 *   `allowedVlansValueOf` at `:400-437`, which is DR-053's throw-instead-of-`False` style);
 * - the **canonicalisation** is M6, in `arista-api-client/src/config/ranges.ts`
 *   (`sortedRangeValues` `:169` then `collapseRangeToString` `:159`, i.e. `[10,20,21,22]` →
 *   `10,20-22`).
 *
 * Neither is reachable from this workspace: `switchports.ts` keeps those constants module-local, and
 * the package's `exports` map publishes only `.`, `./node`, `./testing` and `./node/testing`
 * (`arista-api-client/package.json:17-41`), so `config/ranges.ts` has no published subpath. This
 * module is therefore the **app-side mirror** of those two rules, transcribed against the client
 * source and pinned by `allowed-vlans.test.ts`. It mirrors; it does not re-decide: where the client
 * deliberately does something quirky, this module does the same thing, and the comment says so.
 *
 * ## The three answers a device spelling can give
 *
 * `switchports.getAll()` hands over `trunkAllowedVlans` as a **raw device string** (DR-028):
 * `10-12,20`, `all`, `except 5`, `forward all`. So the return type is a discriminated union and the
 * caller must branch — an unenumerable spelling is never silently turned into a set:
 *
 * | spelling | answer | why |
 * | --- | --- | --- |
 * | `10-12,20`, `1,2,3-5,6,7` | `{ kind: 'ids' }` with `ranges` as written and `ids` expanded | grammar-clean, endpoints inside 1..4094 |
 * | `all`, `except 5`, `forward all`, anything with text outside the id-list charset | `{ kind: 'keyword' }` | DR-028's open device question — the client sends such strings verbatim, and this app refuses to guess the members they imply |
 * | `1,`, `1-`, `1-2-3`, `10,9999999`, a control character, an empty value | `{ kind: 'invalid' }` with the client rule named | the client refuses these before a session is opened (DR-053), so the screen says the same thing pre-wire |
 *
 * The branch order below is the client's (`ID_LIST_CHARSET` before `VLAN_ID_LIST`, `switchports.ts:418-421`):
 * a value made only of digits, commas and dashes that is **not** a well-formed list is a typo to be
 * refused, while anything else is left as a keyword rather than interrogated. Expansion is bounded the
 * same way the client bounds it (`:422-425`: endpoints are range-checked token by token, never
 * materialised): with both endpoints inside `1..4094`, the member set can never exceed 4094 entries.
 *
 * The canonical form this module emits for display and for a write is `formatAllowedVlans`, which is
 * what the client produces from a `number[]` (`[10,20,21,22]` → `10,20-22`). A device spelling like
 * `1,2,3-5,6,7` therefore **displays** as `1-7`; the verbatim pin that client test carries
 * (`switchports.test.ts:513-515`, a raw string handed to `setTrunkAllowedVlans` is sent unchanged) is
 * about the client passing a caller's string through, which is not what a screen that *computed* a set
 * does — see the note in `TrunkEditor.tsx`.
 */

/**
 * The client's trunk-group name rule, mirrored once for both screens that write group lines
 * (`switchports.ts:357-362`, `assertTrunkGroupName`): non-empty, single token, no control
 * character. The two upstream readers genuinely disagree on a multi-word name —
 * `switchports.py:115` keeps the first token via `findall(r'switchport trunk group ([^\s]+)')`,
 * while `vlans.py:60` keeps the remainder via `TRUNK_GROUP_RE` — which is why the client enforces
 * one token on the way **out** and these screens refuse anything else pre-wire.
 * Returns the reason, or `undefined` when the name is writable.
 */
export function trunkGroupNameRefusal(value: string): string | undefined {
  if (value.trim() === '') return 'needed (assertTrunkGroupName): an empty group name is refused — clearing groups is done with the negated line, not a blank token (switchports.ts:359)'
  // The client's order, mirrored: control characters first (`assertTrunkGroupName` checks
  // `hasControlCharacter` before the whitespace rule), then the single-token rule.
  if (hasControlOrLineBoundary(value)) return 'cannot contain a control character, line break or line separator — one config line per command (command-builder.ts LINE_BOUNDARY, DR-015; the client refuses it the same way in assertTrunkGroupName)'
  if (/\s/u.test(value)) return 'must be a single token — the client enforces it because the two upstream readers disagree on a multi-word name (switchports.py:115 keeps token 1 via its findall pattern; vlans.py:60 TRUNK_GROUP_RE keeps the rest)'
  return undefined
}

/** The write bound both this module and the client use: pyeapi's `isvlan`, `api/vlans.py:77-78`. */
export const VLAN_ID_MIN = 1
/** Upper end of the same bound. A read may surface an id outside it (DR-059's read/write split). */
export const VLAN_ID_MAX = 4094

/** One inclusive run exactly as the device wrote it: `10-12` → `{ start: 10, end: 12 }`. */
export interface AllowedVlanRange {
  readonly start: number
  readonly end: number
}

/** A well-formed id/range spelling, with both the device's runs and the expanded member set. */
export interface AllowedVlanIds {
  readonly kind: 'ids'
  /** The device spelling, kept verbatim so a panel can show what the config actually says. */
  readonly raw: string
  /** The runs in device order, un-collapsed. */
  readonly ranges: readonly AllowedVlanRange[]
  /** Members, numerically sorted and de-duplicated — the set an edit operates on. */
  readonly ids: readonly number[]
  /** `formatAllowedVlans(ids)`: the collapsed form a command carries and a table displays. */
  readonly display: string
}

/** DR-028: a keyword spelling this app cannot enumerate, and must not pretend to. */
export interface AllowedVlanKeyword {
  readonly kind: 'keyword'
  readonly raw: string
}

/** A spelling the client would refuse to send (DR-053), with the client's reason. */
export interface AllowedVlanInvalid {
  readonly kind: 'invalid'
  readonly raw: string
  readonly message: string
}

export type AllowedVlanParse = AllowedVlanIds | AllowedVlanKeyword | AllowedVlanInvalid

/** One `switchport trunk allowed vlan` operator edit on the current set. */
export type AllowedVlanEditKind = 'add' | 'remove' | 'replace'

export type AllowedVlanEdit =
  | {
      readonly ok: true
      /** The collapsed list to put after the keyword. */
      readonly text: string
      readonly ids: readonly number[]
      /** Whether the edit would change the set the read produced — a no-op gets refused by the screen. */
      readonly changed: boolean
    }
  | { readonly ok: false; readonly message: string }

/* Transcribed from the client: `switchports.ts:374` / `:376` / `:382`. */
const VLAN_ID_LIST = /^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/u
const VLAN_RUN = /^(\d+)-(\d+)$/u
const ID_LIST_CHARSET = /^[\d,-]+$/u

/**
 * A control character or any line boundary would break the config line this client reads back —
 * `hasControlCharacter` (`switchports.ts:412`, mirroring `assertVlanName`/`assertTrunkGroupName`)
 * plus the composer's `LINE_BOUNDARY` (`command-builder.ts:51`, DR-015). Scanned by code point, as
 * `VlanManagement.tsx` does, so the linter's `no-control-regex` rule never needs a disable comment
 * in this repo. Exported because `TrunkEditor.tsx` and the VLAN screen both mirror the same client
 * rule and must not carry diverging copies (the rule that moved `stageLines` to `staged-batch.ts`).
 */
export function hasControlOrLineBoundary(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0
    if (point <= 0x1f || point === 0x7f || point === 0x85 || point === 0x2028 || point === 0x2029) return true
  }
  return false
}

const inWriteRange = (id: number): boolean => Number.isInteger(id) && id >= VLAN_ID_MIN && id <= VLAN_ID_MAX

/**
 * Expand the runs of a grammar-clean list. Bounded by the `1..4094` endpoint check the caller has
 * already applied, so this can never materialise a billion entries (`1-999999999` is refused first,
 * exactly as the client's token-by-token check refuses it at `switchports.ts:427-433`).
 */
function membersOf(ranges: readonly AllowedVlanRange[]): number[] {
  const seen = new Set<number>()
  for (const range of ranges) {
    for (let id = range.start; id <= range.end; id += 1) seen.add(id)
  }
  return [...seen].sort((left, right) => left - right)
}

/**
 * M6's canonical form: sort + de-duplicate (`sortedRangeValues`), then join consecutive members into
 * runs (`collapseRange`/`collapseRangeToString`). A two-member run does collapse — `['1','2']` →
 * `1-2` — because that is what EOS writes (`config/ranges.ts`, the note above its `collapseRange`).
 *
 * @throws {Error} a value is not an integer inside `1..4094`. Reaching this is a programming mistake
 *   in the caller (the parse path refuses such ids), and a silent default here would invent a VLAN.
 */
export function formatAllowedVlans(ids: Iterable<number>): string {
  const values: number[] = []
  for (const id of ids) {
    if (!inWriteRange(id)) {
      throw new Error(`formatAllowedVlans: ${String(id)} is not a VLAN id in ${String(VLAN_ID_MIN)}..${String(VLAN_ID_MAX)} — this client refuses to write anything else (assertVlanId)`)
    }
    values.push(id)
  }
  const sorted = [...new Set(values)].sort((left, right) => left - right)
  const parts: string[] = []
  let runStart: number | undefined
  for (let index = 0; index < sorted.length; index += 1) {
    const current = sorted[index] as number
    const next = index + 1 < sorted.length ? (sorted[index + 1] as number) : undefined
    if (next !== undefined && current + 1 === next) {
      runStart ??= current
      continue
    }
    if (runStart !== undefined) {
      parts.push(`${String(runStart)}-${String(current)}`)
      runStart = undefined
      continue
    }
    parts.push(String(current))
  }
  return parts.join(',')
}

/**
 * Read one device spelling of `switchport trunk allowed vlan …` into an enumerable set, a keyword
 * question, or a refusal. `''` and whitespace-only are refusals: `commandBuilder` refuses an empty
 * value (`resources/command-builder.ts`, DR-037) rather than emitting a trailing space.
 */
export function parseAllowedVlans(raw: string): AllowedVlanParse {
  if (hasControlOrLineBoundary(raw)) {
    return { kind: 'invalid', raw, message: 'an allowed-VLAN value may not contain a control character, line break or line separator — one config line per command (the client refuses it the same way: hasControlCharacter in resources/switchports.ts, and DR-015 for the composer)' }
  }
  if (raw.trim() === '') {
    return { kind: 'invalid', raw, message: 'an allowed-VLAN value needs a value — the client refuses an empty one instead of sending a trailing space (commandBuilder, DR-037). Clear the setting with `no switchport trunk allowed vlan` instead (unsetTrunkAllowedVlans, resources/switchports.ts:639-642)' }
  }
  if (ID_LIST_CHARSET.test(raw) && !VLAN_ID_LIST.test(raw)) {
    return { kind: 'invalid', raw, message: 'that looks like an id list but is not one: expected ids separated by commas with runs written start-end (VLAN_ID_LIST, resources/switchports.ts:374). pyeapi interpolates it as-is and its range helper quietly corrupts the same shape (MIGRATION.md §5 row 47), so this app stages nothing' }
  }
  if (!VLAN_ID_LIST.test(raw)) {
    return { kind: 'keyword', raw }
  }
  const ranges: AllowedVlanRange[] = []
  for (const token of raw.split(',')) {
    const run = VLAN_RUN.exec(token)
    const from = Number(run?.[1] ?? token)
    const to = run?.[2] === undefined ? from : Number(run[2])
    if (!inWriteRange(from) || !inWriteRange(to)) {
      return { kind: 'invalid', raw, message: `the VLAN id ${run !== null ? String(from) + '-' + String(to) : String(from)} in that list is outside ${String(VLAN_ID_MIN)}..${String(VLAN_ID_MAX)} (the bound assertVlanId applies to every endpoint, resources/switchports.ts:430-432)` }
    }
    if (to < from) {
      return { kind: 'invalid', raw, message: `${token} is a descending run. The client's grammar accepts it and range-checks only the endpoints, so what EOS does with it is unproven on this box (no hardware pin); this screen refuses rather than guess the members` }
    }
    ranges.push({ start: from, end: to })
  }
  const ids = membersOf(ranges)
  return { kind: 'ids', raw, ranges, ids, display: formatAllowedVlans(ids) }
}

/** The set an edit was computed against, or why it could not be. */
function currentIds(current: readonly number[] | undefined, kind: AllowedVlanEditKind): { ids: number[] } | { message: string } {
  if (current !== undefined) return { ids: [...current] }
  // A keyword spelling (`all`, `except 5`, `forward all`) is DR-028's open device question, so the
  // honest answer is "there is no set here to operate on", not a guess about its members.
  return { message: `there is no enumerable allowed-VLAN set to ${kind} from: the device spelling this screen read is a keyword form (DR-028: all / except … / forward all), and this app refuses to expand one into members. Choose "Replace allowed VLAN list" and write the list explicitly, or clear the setting` }
}

/**
 * Compute what an edit leaves on the device, in the collapsed form the command carries.
 *
 * `current` is the set the **read** produced for this port (`AllowedVlanIds.ids`), or `undefined`
 * when the read was a keyword or an invalid spelling — in which case `add`/`remove` have nothing to
 * operate on and are refused rather than assumed. `replace` does not need a current set, because the
 * operator is writing the whole list.
 *
 * A `remove` that would empty the list is refused with the client's own reason (an empty list is
 * `unsetTrunkAllowedVlans`, not `switchport trunk allowed vlan ` — `switchports.ts:404-409`), and the
 * screen offers that command as its own action so the operator has a way to finish the job.
 */
export function applyAllowedVlansEdit(kind: AllowedVlanEditKind, current: readonly number[] | undefined, input: string): AllowedVlanEdit {
  const parsed = parseAllowedVlans(input)
  if (parsed.kind === 'invalid') return { ok: false, message: parsed.message }
  if (parsed.kind === 'keyword') {
    return { ok: false, message: `the allowed-VLAN field takes ids and runs only; ${JSON.stringify(parsed.raw)} is a keyword spelling this app passes through on reads but never writes, because that vocabulary is an open device question (DR-028, DECISIONS open item 4) — the ids a write produces are the ones pinned here` }
  }

  if (kind === 'replace') {
    const text = formatAllowedVlans(parsed.ids)
    const before = current === undefined ? undefined : formatAllowedVlans(current)
    return { ok: true, text, ids: parsed.ids, changed: before === undefined || before !== text }
  }

  const based = currentIds(current, kind)
  if ('message' in based) return { ok: false, message: based.message }

  if (kind === 'add') {
    const ids = [...new Set([...based.ids, ...parsed.ids])].sort((left, right) => left - right)
    const text = formatAllowedVlans(ids)
    return { ok: true, text, ids, changed: text !== formatAllowedVlans(based.ids) }
  }

  const removing = new Set(parsed.ids)
  const ids = based.ids.filter((id) => !removing.has(id))
  if (ids.length === 0) {
    return { ok: false, message: 'that leaves no VLAN allowed on the port, and the client refuses an empty allowed-VLAN list rather than sending one (refuse in allowedVlansValueOf, resources/switchports.ts:404-409 — clearing the setting is unsetTrunkAllowedVlans/defaultTrunkAllowedVlans, pyeapi disable=True/default=True). Use "Clear allowed VLAN list" to send no switchport trunk allowed vlan' }
  }
  const text = formatAllowedVlans(ids)
  return { ok: true, text, ids, changed: text !== formatAllowedVlans(based.ids) }
}
