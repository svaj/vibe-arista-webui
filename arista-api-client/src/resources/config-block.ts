/**
 * `parseConfigBlock` — the shared "read a config block into a typed record" shape, M7 (#9).
 * PLAN.md M7 asks for exactly this: *"`parseConfigBlock(body, fieldParsers)` — the shape every
 * wave-1/wave-2 module needs (they read running-config, not dedicated `show` commands)."*
 *
 * Upstream has no twin, and that is the point: each api module re-runs its own regexes over the raw
 * section text it was handed — `vlans.py:57-60` (`VLAN_ID_RE`, `NAME_RE`, `STATE_RE`, `TRUNK_GROUP_RE`),
 * `interfaces.py:65` (`MIN_LINKS_RE`, whose lookbehind hard-codes three spaces of indent),
 * `interfaces.py:206` (`description (.+)$`), `interfaces.py:108` (`getall`'s `(?<=^interface\s)(.+)$`),
 * plus a `_parse_*` method per field that each returns a one-key dict to be `dict.update`-merged
 * (`vlans.py:108-113`, `:115-201`). PLAN.md's M6 exit gate is what this replaces: "every wave-1 resource
 * can be parsed from text config with no bespoke regex", and MIGRATION.md §8 item 1 tells the next module
 * author to list verbs and commands rather than write regexes.
 *
 * So this function owns only the plumbing M6 (#8) does not: run the section text through
 * {@link parseBlock} once, hand the parsed block to each field extractor, and assemble the record. The
 * extractors themselves stay per-module and pure — usually one call to {@link valueAfterKeyword} /
 * {@link valuesAfterKeyword} below, which pair M6's keyword matching (`matchesKeyword`, `config/text.ts:215`)
 * with M6's EOS quote handling (`unquote`, row 49) **at the keyword** rather than at the line's first token.
 * MIGRATION.md §5 row 81 records that there is no upstream twin.
 *
 * ## Why a keyword-aware extractor lives here (M9, #11)
 *
 * `config/text.ts`'s `findValue`/`findAllValues` return `ConfigLine.value`, and `describeLine`
 * (`config/text.ts:150`) builds that field from `^\(\S*\)([\s\S]*)$` over the dedented line and then
 * `unquote(rstrip(rest))`. Two consequences, both pinned there as *current behaviour* by M6's own suite
 * (`config/text.test.ts:216`, `:221`, `:224`, `:269`, `:281`): the whitespace run between the token and its
 * value **stays** (`name WAN` → `' WAN'`, so `unquote`'s `startsWith('"')` test sees a space and can never
 * fire), and a two-word keyword keeps its own second word (`findValue(body, 'trunk group')` on
 * `trunk group red` → `' group red'`). The doc on `ConfigLine.value` (`config/text.ts:119-120`) promises the
 * opposite ("Everything after the first whitespace run — already `unquote`d"), and `text.test.ts:204-211`
 * names that gap and defers it — "Nothing consumes parseBlock values yet (M7 #9 owns that) … A one-line
 * implementation fix". The consumer is M9, and `system.ts:83` says the same thing ("MIGRATION.md §5 row
 * 49/81's `findValue` caveat is M9 #11's to settle").
 *
 * M9 does **not** edit `src/config/**` — those pins are M6's contract and re-deciding them is the
 * orchestrator's call, so the gap is reported upward, not patched under this milestone. What M9 does is what
 * those pins tell a resource to do (`text.test.ts:276-278`: "a resource wanting `red`/`blue` must lstrip or
 * re-split"): exactly one shared, keyword-position-aware extractor, so neither `vlans.ts` nor
 * `switchports.ts` hand-rolls a re-split and the two cannot drift apart. It lives here rather than in one
 * module because this file's whole purpose is the block→record shape, and a per-module copy would be two
 * copies of one rule — the M6 exit gate ("no bespoke regex in a resource module") is the reason.
 */

import { lstrip, parseBlock, unquote } from '../config/text'
import type { ConfigBlock, ConfigLine } from '../config/text'

/** One field's extractor. It receives the already-tokenised block, never raw text. */
export type ConfigFieldExtractor<T> = (block: ConfigBlock) => T

/**
 * Field name → extractor. The return type of {@link parseConfigBlock} is derived from this map, so a
 * module's resource type and its parser are the same object — no second interface to keep in sync, and
 * a field the extractor map forgets is a compile error at the call site.
 */
export type ConfigFieldMap = Readonly<Record<string, ConfigFieldExtractor<unknown>>>

/** The record shape implied by a field map: each field typed by its own extractor's return type. */
export type ParsedFields<P extends ConfigFieldMap> = { readonly [K in keyof P]: ReturnType<P[K]> }

/**
 * Parse one config block's text into a record.
 *
 * ```ts
 * const vlan = parseConfigBlock(getBlock('vlan 20', { config }), {
 *   name: (block) => valueAfterKeyword(block.body, 'name'),
 *   trunkGroups: (block) => valuesAfterKeyword(block.body, 'trunk group'),
 * })
 * // → { name: string | undefined, trunkGroups: string[] }
 * ```
 *
 * `body` is a **block's text** — the value a `chunkConfig` key maps to, or a `getBlock` result — so the
 * header line is available to extractors as `block.header` (M6 keeps header plus body in the section
 * text, `chunk.ts`'s documented output shape). An empty string parses to an empty block rather than
 * throwing, because `getBlock` answers `undefined` for a section the switch does not have and a module
 * deciding "absent" vs "present but bare" is a normal wave-1 case (DR-027).
 *
 * @throws {ConfigParseError} the text does not fit the section model — propagated from the chunker by
 *   `parseBlock`'s callers. A parse failure is reported, never answered with a missing field.
 */
export function parseConfigBlock<P extends ConfigFieldMap>(body: string, parsers: P): ParsedFields<P> {
  const block = parseBlock(body)
  const fields: Record<string, unknown> = {}
  for (const [field, extract] of Object.entries<ConfigFieldExtractor<unknown>>(parsers)) {
    fields[field] = extract(block)
  }
  // The only assertion in this function: `Object.entries` cannot carry the mapped-type relationship
  // between `parsers` and `fields`, so the loop is typed as a `Record` and the shape is re-attached
  // here. Every field name and value type still comes from `parsers`, and a module's declared resource
  // type is checked against this call site — `base.test.ts` pins that by assigning the result to a
  // named interface.
  return fields as ParsedFields<P>
}

/**
 * Does this line's command text consist of `keyword` plus a word boundary? The same rule as
 * `config/text.ts`'s private matcher (`matchesKeyword`, `:215`), which is what keeps `no name shadowed` and
 * `nameplate nope` from answering for `name`. Re-implemented rather than imported: that function is not
 * exported and `src/config/**` is not M9's to change.
 */
function isKeywordLine(text: string, keyword: string): boolean {
  if (!text.startsWith(keyword)) return false
  const next = text[keyword.length]
  return next === undefined || /\s/u.test(next)
}

/** The value past the keyword on one body line; `''` when the keyword stands alone on the line. */
function keywordValue(line: ConfigLine, keyword: string): string {
  return unquote(lstrip(line.text.slice(keyword.length)))
}

/**
 * The value behind `keyword`, cut **at the keyword** — `name WAN access` → `WAN access`,
 * `switchport trunk group red` → `red`, and (unlike `findValue`) `switchport mode private-vlan` →
 * `private-vlan` rather than `' mode private-vlan'`.
 *
 * `lines` is a parsed block body, so `text` is already dedented and rstripped by `describeLine`: what is
 * left to normalise is the whitespace run after the keyword (`lstrip`, `config/text.ts:92`) and a balanced
 * `"…"` pair (`unquote`, `:235` — MIGRATION.md §5 row 49), which only becomes reachable once that leading
 * space is gone. Inner whitespace survives, which is what a VLAN name or a description needs.
 *
 * `undefined` when the keyword is absent **or** when every matching line carries no value at all
 * (`switchport trunk group` written bare): a bare keyword names nothing, and both upstream parsers agree —
 * `switchports.py:115` (`switchport trunk group ([^\s]+)`) and `vlans.py:60` (`trunk\sgroup\s(?P<value>.*)$`)
 * require at least one character after the keyword.
 */
export function valueAfterKeyword(lines: readonly ConfigLine[], keyword: string): string | undefined {
  for (const line of lines) {
    if (!isKeywordLine(line.text, keyword)) continue
    const value = keywordValue(line, keyword)
    if (value.length === 0) continue
    return value
  }
  return undefined
}

/**
 * Every value behind `keyword`, in device order — the repeated-line case M9 reads twice
 * (`trunk group red` / `trunk group blue` → `['red', 'blue']`). An empty list means none, which is upstream's
 * answer as well: `vlans.py:176-177` (`[]` when nothing matched) and `switchports.py:105-116`
 * (`re.findall` → `[]`). A bare keyword line contributes no entry, per {@link valueAfterKeyword}.
 */
export function valuesAfterKeyword(lines: readonly ConfigLine[], keyword: string): string[] {
  const out: string[] = []
  for (const line of lines) {
    if (!isKeywordLine(line.text, keyword)) continue
    const value = keywordValue(line, keyword)
    if (value.length === 0) continue
    out.push(value)
  }
  return out
}
