/**
 * `parseConfigBlock` — the shared "one section body in, typed record out" shape, M7 (#9).
 * PLAN.md M7 asks for exactly this helper; pyeapi has no twin, which is the divergence
 * (MIGRATION.md §5 row 81): every upstream api module re-runs its own regexes over the raw block it was
 * handed — `vlans.py:57-60` (`VLAN_ID_RE`/`NAME_RE`/`STATE_RE`/`TRUNK_GROUP_RE`), `interfaces.py:65`
 * (`MIN_LINKS_RE`, whose lookbehind hard-codes three spaces of indent), `interfaces.py:206`
 * (`description (.+)$`) — each merged by a `_parse_*` method returning a one-key dict
 * (`vlans.py:108-113`, `:115-201`). All of those refs verified by opening the files on 2026-11-03.
 *
 * So this suite pins the *plumbing* only: the block is tokenised once by M6's `parseBlock`, each
 * extractor is handed the tokenised block (never raw text), and the returned record's keys come from the
 * parser map. The extractors themselves are M6's (`src/config/text.ts`) and are tested there.
 *
 * One M6 contract gap is pinned here rather than fixed: `describeLine` splits a line at the FIRST
 * whitespace run and keeps the rest verbatim, so `line.value` retains the whitespace after the keyword
 * (`name PROD` → `' PROD'`) and, for a two-word keyword, the tail of the keyword too
 * (`trunk group red` → `' group red'`). `findValue`'s own docstring promises `WAN access` and `red`
 * (`src/config/text.ts:193-198`); `text.test.ts` pins the as-built leading-space behaviour and
 * MIGRATION.md §5 row 49 flags it as a decision M7 (#9) must make **in `src/config/text.ts`** (a
 * one-line `lstrip`) with that test updated in the same change.
 *
 * This milestone deliberately leaves M6's primitive alone while PR #23 is in review — re-deciding a
 * shipped, pinned rule from a sibling branch is the kind of silent re-decision this repo's rules
 * forbid. So the framework records the consequence here, the assertions below are the as-built values,
 * and the follow-up (M7's second commit, or M9 when `vlans` needs it) flips the primitive plus these
 * expectations in one step. A wave-1 module that needs a clean value today strips or re-splits in its
 * own extractor, which is the escape hatch row 49 implies.
 *
 * M9 (#11) is the first real reader and took that escape hatch exactly once rather than per module:
 * {@link valueAfterKeyword} / {@link valuesAfterKeyword} (exported from this file) cut the value **at the
 * keyword** — `lstrip` plus `unquote` applied there instead of in `describeLine` — and are what
 * `vlans.ts:232-234` and `switchports.ts:292-296` call. `src/config/**` is untouched, so every as-built
 * pin above stays as it shipped. Because those two extractors are exports of the file this suite belongs
 * to, they get direct specs below (MIGRATION.md's `_parse_*` row: extractors are "pure, unit-tested
 * directly") instead of riding only on the indirect exercise through `switchports.test.ts` / `vlans.test.ts`.
 */

import { describe, expect, expectTypeOf, it } from 'vitest'

import { findAllValues, findValue, parseBlock } from '../config/text'
import { parseConfigBlock, valueAfterKeyword, valuesAfterKeyword } from './config-block'
import type { ConfigBlock, ConfigLine } from '../config/text'

const VLAN_20 = 'vlan 20\n   name PROD\n   trunk group red\n   trunk group blue\n!\n'
const ETHERNET_1 = [
  'interface Ethernet1',
  '   description WAN uplink',
  '   mtu 1500',
  '   switchport access vlan 20',
  '   switchport mode trunk',
  '!',
].join('\n')

describe('parseConfigBlock — PLAN.md M7 (no upstream twin, §5 row 81)', () => {
  it('assembles one field per parser entry, in the order the parsers are declared', () => {
    const parsed = parseConfigBlock(VLAN_20, {
      name: (block) => findValue(block.body, 'name'),
      trunkGroups: (block) => findAllValues(block.body, 'trunk group'),
    })
    // As-built values, incl. the whitespace M6 keeps (see this file's header): a single-word keyword
    // leaves `' PROD'`; a two-word keyword leaves the keyword's own tail, `' group red'`.
    expect(parsed).toEqual({ name: ' PROD', trunkGroups: [' group red', ' group blue'] })
  })

  it('hands each extractor the section header, so a module can read the key it was matched on', () => {
    const parsed = parseConfigBlock(ETHERNET_1, {
      header: (block) => block.header,
      description: (block) => findValue(block.body, 'description'),
    })
    expect(parsed.header).toBe('interface Ethernet1')
    expect(parsed.description).toBe(' WAN uplink')
  })

  it('the record type comes from the parser map (no second interface to keep in sync)', () => {
    const parsed = parseConfigBlock(ETHERNET_1, {
      mtu: (block) => findValue(block.body, 'mtu'),
      // A two-word keyword matches whole-word, but the value still begins after the FIRST token — the
      // ' access vlan' tail is why a wave-1 module reads `line.text` for these (row 49's follow-up).
      vlans: (block) => findAllValues(block.body, 'switchport access vlan'),
      enabled: () => true,
    })
    expectTypeOf(parsed).toEqualTypeOf<{ readonly mtu: string | undefined; readonly vlans: string[]; readonly enabled: boolean }>()
    // A module declares its resource entry type once and assigns the parse result to it — this is the
    // compile-time half of the "~30 lines of plumbing" exit gate in PLAN.md M7.
    interface SwitchportEntry {
      readonly mtu: string | undefined
      readonly vlans: string[]
      readonly enabled: boolean
    }
    const entry: SwitchportEntry = parsed
    expect(entry.mtu).toBe(' 1500')
    expect(entry.vlans).toEqual([' access vlan 20'])
    expect(entry.enabled).toBe(true)
  })

  it('an empty block parses to an empty body rather than throwing (DR-027: getBlock answers undefined for "absent")', () => {
    const seen: ConfigBlock[] = []
    const parsed = parseConfigBlock('', {
      probe: (block) => {
        seen.push(block)
        return block.body.length
      },
      name: (block) => findValue(block.body, 'name'),
    })
    expect(seen[0]).toEqual({ header: '', body: [] })
    expect(parsed).toEqual({ probe: 0, name: undefined })
  })

  it('a header-only section yields no body lines, and the header survives', () => {
    expect(parseConfigBlock('router bgp 65001', { header: (block) => block.header, lines: (block) => block.body.length })).toEqual({
      header: 'router bgp 65001',
      lines: 0,
    })
  })

  it('extractors receive tokenised lines (indent/token/value), so a module never re-splits text', () => {
    const shape = parseConfigBlock(ETHERNET_1, {
      lines: (block) => block.body.map((line: ConfigLine) => [line.indent, line.token, line.value ?? '']),
    })
    expect(shape.lines.slice(0, 2)).toEqual([
      [3, 'description', ' WAN uplink'],
      [3, 'mtu', ' 1500'],
    ])
  })

  it('describes the header for a section matched from a chunkConfig key', () => {
    // Both M6 outputs are accepted as `body`: a `chunkConfig` value (which keeps the header line, per
    // `chunk.ts`) and a `getBlock` result — the same call shape either way.
    const parsed = parseConfigBlock(VLAN_20, { header: (block) => block.header })
    expect(parsed.header).toBe('vlan 20')
  })

  it('the `!` separator line count is what a module uses to spot an explicit blank', () => {
    const parsed = parseConfigBlock(VLAN_20, { seps: (block) => block.body.filter((line) => line.token === '!').length })
    expect(parsed).toEqual({ seps: 1 })
  })

  it('parses a CRLF section body the same way (M6 splits on CPython line boundaries, §5 row 52-53)', () => {
    const crlf = 'vlan 30\r\n   name ENGINEERING\r\n!\r\n'
    expect(parseConfigBlock(crlf, { header: (block) => block.header, name: (block) => findValue(block.body, 'name') })).toEqual({
      header: 'vlan 30',
      name: ' ENGINEERING',
    })
  })

  it('a keyword match is whole-word, so `no name x` and `nameplate` do not answer for `name` (M6 rule)', () => {
    const parsed = parseConfigBlock('vlan 40\n   nameplate odd\n   no name legacy\n', {
      name: (block) => findValue(block.body, 'name'),
    })
    expect(parsed.name).toBeUndefined()
  })

  it('an extractor failure propagates rather than becoming a missing field (a parse problem is reported, DR-005)', () => {
    expect(() =>
      parseConfigBlock(VLAN_20, {
        boom: () => {
          throw new TypeError('extractor bug')
        },
      }),
    ).toThrow(/extractor bug/)
  })

  it('a parser that ignores the block still runs, and later parsers keep receiving it (no short-circuit)', () => {
    let calls = 0
    const parsed = parseConfigBlock(VLAN_20, {
      first: () => {
        calls += 1
        return 'always'
      },
      second: (block) => {
        calls += 1
        return block.header
      },
    })
    expect(calls).toBe(2)
    expect(parsed).toEqual({ first: 'always', second: 'vlan 20' })
  })
})

describe('valueAfterKeyword / valuesAfterKeyword — M9 (#11) keyword-position reads, the reader row 81 deferred to this milestone (vlans.ts:232-234, switchports.ts:292-296)', () => {
  // Both extractors take a **parsed body**, which is what `parseConfigBlock` hands its extractors; going
  // through `parseBlock` here keeps the lines device-shaped (dedented, rstripped by `describeLine`,
  // `config/text.ts:150`) instead of hand-built `ConfigLine` objects that could drift from it.
  const lines = (section: string): readonly ConfigLine[] => parseBlock(section).body

  it('a keyword with one value answers that value, and nothing else on the line (vlans.py:58 NAME_RE, :59 STATE_RE)', () => {
    const body = lines('vlan 20\n   name WAN\n   state active\n!\n')
    expect(valueAfterKeyword(body, 'name')).toBe('WAN')
    expect(valueAfterKeyword(body, 'state')).toBe('active')
  })

  it('valuesAfterKeyword answers every repeat of the keyword in device order, ignoring the lines between (vlans.py:176 findall)', () => {
    const body = lines('vlan 20\n   trunk group red\n   name PROD\n   trunk group blue\n!\n')
    expect(valuesAfterKeyword(body, 'trunk group')).toEqual(['red', 'blue'])
  })

  it('a two-word keyword keeps no tail of itself — the gap findValue leaves (row 49, pinned at text.test.ts:279-281)', () => {
    // M6's as-behaviour, unchanged: `ConfigLine.value` is everything past the line's FIRST token, so the
    // two-word keyword carries its own second word (`findValue(body, 'trunk group')` → `' group red'`)
    // and the same happens for the interface spelling, whose first token is `switchport`.
    const vlanBody = lines('vlan 20\n   trunk group red\n!\n')
    expect(findValue(vlanBody, 'trunk group')).toBe(' group red')
    expect(valuesAfterKeyword(vlanBody, 'trunk group')).toEqual(['red'])
    const ethernetBody = lines('interface Ethernet1\n   switchport trunk group red\n!\n')
    expect(findValue(ethernetBody, 'switchport trunk group')).toBe(' trunk group red')
    expect(valueAfterKeyword(ethernetBody, 'switchport trunk group')).toBe('red')
  })

  it('collapses only the whitespace run between keyword and value, so inner whitespace survives (lstrip, text.ts:92)', () => {
    const body = lines('vlan 30\n   name    WAN\n   description WAN uplink\n!\n')
    // `describeLine` keeps the leading run in `value` (`name    ten` → `'    ten'`, text.test.ts:224),
    // which is the half of the gap a VLAN name cannot afford:
    expect(findValue(body, 'name')).toBe('    WAN')
    expect(valueAfterKeyword(body, 'name')).toBe('WAN')
    expect(valueAfterKeyword(body, 'description')).toBe('WAN uplink')
    expect(valuesAfterKeyword(body, 'description')).toEqual(['WAN uplink'])
  })

  it('reaches unquote at the keyword, where describeLine never can — a balanced pair comes off (text.ts:235, row 49)', () => {
    const body = lines('interface Ethernet1\n   description "WAN uplink"\n!\n')
    // The leading space is what makes `value`'s unquote unreachable (`startsWith('"')` sees a space), so
    // the quote handling only ever fires for a reader that strips the run first:
    expect(findValue(body, 'description')).toBe(' "WAN uplink"')
    expect(valueAfterKeyword(body, 'description')).toBe('WAN uplink')
  })

  it('leaves an unbalanced quote verbatim rather than repairing the device\'s quoting (unquote rule, row 49)', () => {
    expect(valueAfterKeyword(lines('interface Ethernet1\n   description "WAN uplink\n!\n'), 'description')).toBe('"WAN uplink')
    expect(valueAfterKeyword(lines('interface Ethernet1\n   description WAN uplink"\n!\n'), 'description')).toBe('WAN uplink"')
  })

  it('refuses a keyword that merely prefixes the token, or that appears after `no` — whole-word rule (matchesKeyword, text.ts:215)', () => {
    const body = lines('vlan 40\n   nameplate nope\n   no name shadowed\n!\n')
    expect(valueAfterKeyword(body, 'name')).toBeUndefined()
    expect(valuesAfterKeyword(body, 'name')).toEqual([])
    // the refusal is the boundary, not the line being skipped altogether:
    expect(valueAfterKeyword(body, 'nameplate')).toBe('nope')
  })

  it('a bare keyword line contributes nothing — the keyword alone names no value (switchports.py:115 `[^\\s]+` needs one)', () => {
    // NB: `parseBlock` spends the section's first line on `header`, so the bare keyword has to be a body
    // line here — a fixture that put it first would silently test nothing.
    // (`vlans.py:60` is looser than the JSDoc's "both agree": its `\s` demands a separator but the capture
    // is `.*`, so a raw `trunk group ` with a trailing space would answer `''` there. `describeLine`
    // rstrips, so no device-shaped body reaches that case here — reported, not re-decided.)
    const body = lines('vlan 20\n   name\n!\n')
    expect(valueAfterKeyword(body, 'name')).toBeUndefined()
    expect(valuesAfterKeyword(body, 'name')).toEqual([])
  })

  it('a bare keyword among real ones is skipped, not answered as undefined — later lines still answer (switchports.py:115)', () => {
    const body = lines('vlan 20\n   trunk group\n   trunk group red\n!\n')
    expect(valuesAfterKeyword(body, 'trunk group')).toEqual(['red'])
    expect(valueAfterKeyword(body, 'trunk group')).toBe('red')
  })

  it('a keyword the block never uses answers undefined / an empty list — never a throw, never an empty string (vlans.py:176-177)', () => {
    const body = lines('interface Ethernet1\n   mtu 1500\n   description link\n!\n')
    expect(valueAfterKeyword(body, 'name')).toBeUndefined()
    expect(valuesAfterKeyword(body, 'name')).toEqual([])
    expect(valueAfterKeyword(body, 'trunk group')).toBeUndefined()
    expect(valuesAfterKeyword(body, 'trunk group')).toEqual([])
  })

  it('a block whose every matching line is valueless answers nothing at all (no empty-string entry leaks out)', () => {
    const body = lines('interface Ethernet1\n   switchport trunk group\n   switchport trunk group\n!\n')
    expect(valueAfterKeyword(body, 'switchport trunk group')).toBeUndefined()
    expect(valuesAfterKeyword(body, 'switchport trunk group')).toEqual([])
  })

  it('reads an explicitly empty quoted value as no value at all — as-built pin, not blessed (reported for #11)', () => {
    // `keywordValue` (config-block.ts) unquotes first and only then asks whether anything is left, so
    // `name ""` empties into the same "valueless" bucket as a bare `name`. The JSDoc's rule is about a
    // keyword that "stands alone on the line", which does not obviously cover a pair the device wrote;
    // reported upward rather than re-decided here. The quoting depth EOS actually emits is M12 (#14)'s
    // capture, per row 49.
    const body = lines('vlan 20\n   name ""\n!\n')
    expect(valueAfterKeyword(body, 'name')).toBeUndefined()
    expect(valuesAfterKeyword(body, 'name')).toEqual([])
  })

  it('composes with parseConfigBlock exactly as the module parsers do — a bare repeat drops out of the record', () => {
    const parsed = parseConfigBlock('vlan 20\n   name WAN\n   trunk group\n   trunk group red\n   trunk group blue\n!\n', {
      name: (block) => valueAfterKeyword(block.body, 'name'),
      trunkGroups: (block) => valuesAfterKeyword(block.body, 'trunk group'),
    })
    expectTypeOf(parsed).toEqualTypeOf<{ readonly name: string | undefined; readonly trunkGroups: string[] }>()
    expect(parsed).toEqual({ name: 'WAN', trunkGroups: ['red', 'blue'] })
  })
})
