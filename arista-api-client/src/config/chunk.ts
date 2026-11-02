/**
 * `chunkConfig` — the indent-aware EOS config chunker, M6 (#8).
 *
 * Port of pyeapi `Node._chunkify` (`pyeapi/client.py:697-774`, decorator at `:697`, body `:698-774`),
 * minus the `@lru_cache` (DR-026 — the cache is `src/config/cache.ts`) and minus the `indent`
 * parameter, which is **not** part of the public contract here:
 *
 * > "it's imperative that the most outer call is made with `indent=0`, as the indent parameter defines
 * > processing of nested sub-sections" (`client.py:716-720`)
 *
 * In pyeapi that invariant is only a docstring comment on a *public-ish* method, and the recursion
 * reaches back into the same cached function. Here the recursion is a module-private function, so a
 * caller physically cannot pass a non-zero indent and get a half-chunked document back. The invariant
 * is now structural instead of aspirational — MIGRATION.md §5 row 31.
 *
 * Output shape (the docstring example at `client.py:705-714`, verified against upstream by the oracle
 * in `test/fixtures/config/`): a map from **section key** (the rstripped header line, indentation
 * included for a sub-section) to **the section text** (header line plus its body, terminators intact).
 * Both sections and sub-sections are keys, and iteration order is load-bearing: `section()` takes the
 * *first* key that matches (DR-027), and the recursive merge puts a parent's sub-section keys **before**
 * the parent key. That ordering is reproduced exactly, not approximated.
 */

import { ConfigParseError } from '../errors'
import { pythonRepr } from '../internal/wire'
import { lineIndent, lstrip, rstrip, splitLines, splitLinesKeepends } from './text'

/** A chunked config: every section and sub-section key mapped to its text. Keys are device-order. */
export type MutableSections = Map<string, string>

/**
 * The chunked document handed to callers. `ReadonlyMap` on purpose: pyeapi hands out the live
 * `lru_cache` dict, so one `sections.pop()` in a resource module corrupts every later read of that
 * config. The cache (DR-026) hands the same map to many callers, so mutation is excluded at compile
 * time instead of being a comment.
 */
export type ConfigSections = ReadonlyMap<string, string>

/** A section header at indent 0 — `hostname`, `interface Ethernet1`, `vlan 20`. */
const INDENT_ZERO = 0

/**
 * pyeapi's `code unit` marker (`client.py:752`): a `control-functions` code block whose body is EOS
 * policy-script, not CLI. Its lines are arbitrary (braces, indentation, blank-ish lines) and the block
 * runs to an `EOF` line, so the chunker has to swallow it whole — otherwise its indentation is read as
 * nested CLI and the parse dies in `hasSubsectionLines` below.
 */
const CODE_UNIT_PREFIX = 'code unit '

/** EOF-terminated literal block opener at indent 0 (`banner motd`, `banner login`) — `client.py:747`. */
const BANNER_PREFIX = 'banner '

/** The terminator line pyeapi compares after `rstrip` (`client.py:744`). */
const EOF_LINE = 'EOF'

/**
 * Split a device config into sections and sub-sections.
 *
 * @param config config **text** — the `output` string of `show running-config` with `format: 'text'`.
 *   Not a `show` JSON object, and not the `'running_config'` sentinel pyeapi accepts
 *   (`client.py:789-790`): this module has no `Node` to resolve it against, so a caller holding a
 *   `Node` passes `node.getRunningConfig()` (M4 #6).
 * @returns section key → section text, in device order, as a read-only map.
 * @throws {ConfigParseError} a line inside an indented block is shorter than that block's indent, or a
 *   config begins with an indented line. Both are "the device wrote something we do not model"
 *   answers — see the two failure-mode notes below.
 */
export function chunkConfig(config: string): ConfigSections {
  return chunkAtIndent(config, INDENT_ZERO)
}

/**
 * The recursive worker. `indent` is the nesting level of the lines being scanned; `config` is the
 * **whole section text** of the parent (header line included), which is why the first line is dropped
 * when recursing (`client.py:738`'s `[ indent > 0: ]` slice).
 */
function chunkAtIndent(config: string, indent: number): MutableSections {
  let sections: MutableSections = new Map<string, string>()
  let key: string | undefined
  /** Set while an EOF-terminated literal block (banner / code unit) is being swallowed. */
  let multiline: string | undefined
  const lines = splitLinesKeepends(config)
  if (indent > INDENT_ZERO) lines.shift()

  for (let position = 0; position < lines.length; position += 1) {
    const line = lines[position] as string
    const lineRs = rstrip(line)

    if (multiline !== undefined) {
      // pyeapi appends unconditionally (`client.py:741`); the key always exists because the opener
      // created it, so the `?? ''` is a no-op kept for the compiler, not a repair path.
      sections.set(multiline, `${sections.get(multiline) ?? ''}${line}`)
      if (lineRs === EOF_LINE) multiline = undefined
      continue
    }

    // `banner motd` / `banner login` at the outer level: the text after it is free-form until `EOF`.
    // Tested on the *raw* line, exactly as pyeapi does (`client.py:747`), so an indented line that
    // happens to read "banner " is not mistaken for the opener.
    if (indent === INDENT_ZERO && line.startsWith(BANNER_PREFIX)) {
      multiline = lineRs
      sections.set(multiline, line)
      continue
    }

    if (lstrip(lineRs).startsWith(CODE_UNIT_PREFIX)) {
      if (key === undefined) {
        key = lineRs
        sections.set(key, line)
      } else {
        sections.set(key, `${sections.get(key) ?? ''}${line}`)
      }
      multiline = key
      continue
    }

    if (lineIndent(lineRs) > indent) {
      if (key === undefined) {
        // pyeapi's `sections[key] += line` with `key` still `None` raises `KeyError: None`
        // (`client.py:763`, whose comment assumes "key is always expected to be set by now" — it is
        // not, for a config whose first line is indented). A crash with no line number is not an
        // answer we can show an operator: MIGRATION.md §5 row 32.
        throw new ConfigParseError(
          `Unable to parse config: line ${position + 1} ${pythonRepr(lineRs)} is indented but no ` +
            'section header precedes it',
          { line: position + 1, indent, shortLine: lineRs },
        )
      }
      sections.set(key, `${sections.get(key) ?? ''}${line}`)
      continue
    }

    // A new sibling (or, at indent 0, a new top-level section). Before closing the previous one, see
    // whether its body carries a deeper nest worth re-chunking — `client.py:765-771`.
    const current = key === undefined ? '' : (sections.get(key) ?? '')
    const subsection = splitLines(current).slice(1)
    if (subsection.length > 0) {
      const first = subsection[0] as string
      const subIndent = lineIndent(first)
      if (hasSubsectionLines(subsection, subIndent, key ?? '')) {
        const parsed = chunkAtIndent(current, subIndent)
        // `parsed.update(sections)` (`client.py:770-771`): sub-section keys first, then the outer keys —
        // and an outer key wins a collision. Map.set reproduces both halves of that, order included.
        for (const [outerKey, outerValue] of sections) parsed.set(outerKey, outerValue)
        sections = parsed
      }
    }

    key = lineRs
    sections.set(key, line)
  }

  return sections
}

/**
 * pyeapi's `is_subsection_present` (`client.py:720-730`). The name undersells it: it does not merely
 * look for a deeper line, it **raises** when a body line is shorter than the block's own indent,
 * because that shape is what an unmodelled multiline literal block looks like once the chunker has
 * folded free-form text into an indented section.
 *
 * Keeping the raise is the difference between "the parse said something false" and "the parse said it
 * could not parse" — PLAN.md's M6 line "keep the explicit failure mode … rather than a wrong answer".
 * The message wording is upstream's, so a device-vs-pyeapi comparison still lines up; the class is
 * ours: `ConfigParseError` instead of a bare `ValueError` — MIGRATION.md §5 row 33.
 */
function hasSubsectionLines(section: readonly string[], indent: number, sectionKey: string): boolean {
  for (const line of section) {
    if (line.length <= indent) {
      throw new ConfigParseError(
        `Unable to parse section ${pythonRepr(sectionKey)} at indent ${indent} due to short line `
        + `${pythonRepr(line)}; likely unhandled multiline literal block (EOF-terminated)`,
        { sectionKey, indent, shortLine: line },
      )
    }
    if (line[indent] === ' ') return true
  }
  return false
}
