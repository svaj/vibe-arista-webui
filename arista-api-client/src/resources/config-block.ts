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
 * extractors themselves stay per-module and pure — usually one call to `findValue`/`findAllValues` from
 * `src/config/text.ts`, which is where the keyword matching and EOS quote handling (`unquote`, row 49)
 * already live. MIGRATION.md §5 row 74 records that there is no upstream twin.
 */

import { parseBlock, type ConfigBlock } from '../config/text'

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
 *   name: (block) => findValue(block.body, 'name'),
 *   trunkGroups: (block) => findAllValues(block.body, 'trunk group'),
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
