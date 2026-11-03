/**
 * Config-text primitives — M6 (#8).
 *
 * EOS `show running-config` (format `text`) is a line-oriented document whose structure is the
 * **leading whitespace**. Every pyeapi resource module is built on that fact (`api/abstract.py:82`
 * `get_block` + a per-module `re.search(..., re.M)` over a section), and this module is where those
 * primitives live so M7-M10 (#9-#12) never hand-roll a regex against device text.
 *
 * The line-splitting rules are a faithful port of CPython `str.splitlines()` /
 * `str.splitlines(keepends=True)` because pyeapi's `_chunkify` (`client.py:738`, `:765`) is written
 * against them — including the terminator characters EOS never emits (`\v`, `\f`, `\u0085`,
 * `\u2028`, `\u2029`, `\u001c`-`\u001e`), which are kept so a config blob pasted from an odd source
 * parses the same way it would under pyeapi. `rstrip()`/`lstrip()` follow CPython's whitespace rules
 * too — BUT the two whitespace sets differ on `\u0085` and `\u001c`-`\u001f`, which CPython's
 * `str.isspace()` includes and JS `\s` does not (they agree on everything EOS emits, `\u00a0`
 * included). That only bites a terminator byte sitting at the END of a `splitLinesKeepends` line, so
 * the concrete divergence is narrow: an `EOF\u0085` line closes a banner under CPython and under
 * pyeapi, and does not close one here — MIGRATION.md §5 row 53, pinned in `text.test.ts` and at the
 * chunk level in `chunk.test.ts`, never silently "fixed". The parity oracle in
 * `test/fixtures/config/` is what keeps the rest of the claim honest rather than assumed: every
 * fixture is chunked by upstream pyeapi and by `chunkConfig`, and the two outputs are compared entry
 * by entry.
 */

/**
 * Characters CPython treats as line boundaries inside `splitlines`, written as **regex escape text**
 * for interpolation into a character class. Not for direct character comparison — see
 * `LINE_BREAK_CHARS`, which is the same set as actual code points.
 */
const LINE_BREAK_CLASS = '\\r\\n\\v\\f\\u0085\\u2028\\u2029\\u001c\\u001d\\u001e'

/** The same boundaries as real characters, for the scan in `splitLinesKeepends`. */
const LINE_BREAK_CHARS: ReadonlySet<string> = new Set([
  '\n',
  '\v',
  '\f',
  '\u0085',
  '\u2028',
  '\u2029',
  '\u001c',
  '\u001d',
  '\u001e',
])

/**
 * `str.splitlines(keepends=True)`: terminators stay attached, CRLF stays one line.
 *
 * Written as an explicit scan rather than `text.match(/..../gu)` because CPython ends a line at a
 * boundary *character* but reports a trailing boundary as a line of its own only when text follows —
 * the case that decides whether a config blob ending in `\n` yields a phantom final section.
 */
export function splitLinesKeepends(text: string): string[] {
  const lines: string[] = []
  let start = 0
  let index = 0
  while (index < text.length) {
    const char = text[index] as string
    if (char === '\r') {
      const end = text[index + 1] === '\n' ? index + 2 : index + 1
      lines.push(text.slice(start, end))
      start = index = end
      continue
    }
    if (LINE_BREAK_CHARS.has(char)) {
      lines.push(text.slice(start, index + 1))
      start = index + 1
      index = start
      continue
    }
    index += 1
  }
  if (start < text.length) lines.push(text.slice(start))
  return lines
}

/** `str.splitlines()`: same boundaries, terminator removed. */
export function splitLines(text: string): string[] {
  return splitLinesKeepends(text).map(stripLineEnd)
}

/** Remove only a trailing line terminator (CPython boundaries included), not other whitespace. */
export function stripLineEnd(line: string): string {
  return line.replace(new RegExp(`(?:\\r\\n|[${LINE_BREAK_CLASS}])$`, 'u'), '')
}

/** CPython `str.rstrip()` on a single line: drops trailing whitespace, newline included. */
export function rstrip(value: string): string {
  return value.replace(/\s+$/u, '')
}

/** CPython `str.lstrip()`: drops leading whitespace only. */
export function lstrip(value: string): string {
  return value.replace(/^\s+/u, '')
}

/**
 * pyeapi's `get_indent` (`client.py:732-733`), measured on the **raw** line: the number of leading
 * whitespace characters, which is the whole structural signal in EOS config text. EOS emits three
 * spaces per level; `mac security`-style blocks written by other tools differ, so nothing here
 * assumes a width.
 */
export function lineIndent(line: string): number {
  let index = 0
  while (index < line.length && /\s/u.test(line[index] as string)) index += 1
  return index
}

/** A structural token of a section body, pre-decorated so resources do not re-split it. */
export interface ConfigLine {
  /** Line content with the terminator and the leading indentation removed, trailing whitespace trimmed. */
  readonly text: string
  /** Leading-whitespace count of the raw line — the nesting depth signal (`lineIndent`). */
  readonly indent: number
  /**
   * The leading run of non-whitespace characters (`!`, `name`, `address-family`, `switchport`).
   * Empty for a blank or whitespace-only line.
   */
  readonly token: string
  /** Everything after the first whitespace run — already `unquote`d. `undefined` when there is none. */
  readonly value: string | undefined
}

/** A parsed section body: the header line plus its indented body lines, in device order. */
export interface ConfigBlock {
  /** The section header (first line, rstripped). `''` when the block is empty. */
  readonly header: string
  /** Body lines in device order, header excluded. Includes the `!` separator lines EOS writes. */
  readonly body: readonly ConfigLine[]
}

/**
 * Tokenise one section body — the value a `chunkConfig` key maps to, or a `getBlock` result.
 * pyeapi has no equivalent: each api module re-runs its own regex over the raw block
 * (`api/vlans.py:115-201`, `api/interfaces.py:193-206`), which is exactly the bespoke-regex work
 * PLAN.md's M6 exit gate removes.
 */
export function parseBlock(body: string): ConfigBlock {
  if (body.length === 0) return { header: '', body: [] }
  const lines = splitLines(body)
  const header = rstrip(lines[0] ?? '')
  const parsed: ConfigLine[] = []
  for (let index = 1; index < lines.length; index += 1) {
    const raw = lines[index] as string
    parsed.push(describeLine(raw))
  }
  return { header, body: parsed }
}

/** Decorate a single raw line: indent, first token, and the unquoted remainder. */
export function describeLine(rawLine: string): ConfigLine {
  const indent = lineIndent(rawLine)
  const text = rstrip(rawLine.slice(indent))
  const match = /^(\S*)([\s\S]*)$/u.exec(text)
  const token = match?.[1] ?? ''
  const rest = match?.[2] ?? ''
  return {
    text,
    indent,
    token,
    value: rest.length === 0 ? undefined : unquote(rstrip(rest)),
  }
}

/**
 * The first line of `config` the expression matches, terminator removed — pyeapi's
 * `re.search(pattern, self.config, re.M)` idiom, as a named helper.
 *
 * The scan is per line, so `^`/`$` already mean line start/end and the `m` flag changes nothing
 * (`g`/`y` are ignored too: matching uses `String#search`, which does not advance `lastIndex`).
 * A string needle is matched **literally** (substring), never compiled — pyeapi code that passes a
 * bare word is usually asking for that, and a caller who wants an alternation passes a RegExp.
 */
export function findLine(config: string, needle: string | RegExp): string | undefined {
  for (const raw of splitLines(config)) {
    if (typeof needle === 'string') {
      if (raw.includes(needle)) return stripLineEnd(raw)
      continue
    }
    if (raw.search(needle) !== -1) return stripLineEnd(raw)
  }
  return undefined
}

/** Every line `needle` matches, in device order — pyeapi's `re.findall(..., re.M)` as a named helper. */
export function findLines(config: string, needle: string | RegExp): string[] {
  const out: string[] = []
  for (const raw of splitLines(config)) {
    if (typeof needle === 'string' ? raw.includes(needle) : raw.search(needle) !== -1) out.push(stripLineEnd(raw))
  }
  return out
}

/**
 * The value behind a leading keyword in a parsed block, e.g. `findValue(block.body, 'name')` for
 * `name WAN access` → `WAN access`, or `findValue(block.body, 'trunk group')` for the two-word
 * keyword in `trunk group red`. Matched on the line text with a word boundary, so `no name x` does
 * not answer for `name`, and `nameplate` does not either. `undefined` when absent.
 */
export function findValue(lines: readonly ConfigLine[], keyword: string): string | undefined {
  for (const line of lines) {
    if (matchesKeyword(line.text, keyword)) return line.value
  }
  return undefined
}

/** Every value behind a keyword — `trunk group red` / `trunk group blue` → `['red', 'blue']`. */
export function findAllValues(lines: readonly ConfigLine[], keyword: string): string[] {
  const out: string[] = []
  for (const line of lines) {
    if (matchesKeyword(line.text, keyword)) out.push(line.value ?? '')
  }
  return out
}

function matchesKeyword(text: string, keyword: string): boolean {
  if (!text.startsWith(keyword)) return false
  const next = text[keyword.length]
  return next === undefined || /\s/u.test(next)
}

/**
 * Strip EOS's `"quoted string"` wrapper from a config value.
 *
 * EOS keeps the quotes in `show running-config` for values that would otherwise be ambiguous or
 * carry leading/trailing space — `description " WAN uplink "`, `name "vlan ten"`, and the
 * `interface description` text M10 (#12) reads back. pyeapi has **no** quote handling at all
 * (`api/vlans.py` `NAME_RE`, `api/interfaces.py:205-207` `description (.+)$`), so a pyeapi resource
 * hands the UI a value with literal quote characters in it. Divergence: MIGRATION.md §5 row 49.
 *
 * Rules, deliberately conservative: an inner `\"` is unescaped; a value that is not wrapped in a
 * matched pair of double quotes is returned untouched (an apostrophe inside `description Don't do
 * this` is EOS-legal and must survive); a value whose quote is unbalanced stays as-is rather than
 * being "repaired", because inventing the device's quoting is worse than reporting it oddly.
 */
export function unquote(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value
  const inner = value.slice(1, -1)
  if (inner.includes('\\"')) return inner.replace(/\\"/gu, '"')
  if (inner.includes('"')) return value
  return inner
}
