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
 */

import { describe, expect, expectTypeOf, it } from 'vitest'

import { findAllValues, findValue } from '../config/text'
import { parseConfigBlock } from './config-block'
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
