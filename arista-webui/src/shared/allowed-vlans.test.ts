/**
 * The shared allowed-VLAN grammar (S3, #73), pinned offline. Every expectation here is transcribed
 * against the client source it mirrors — `arista-api-client/src/resources/switchports.ts`
 * (`VLAN_ID_LIST`/`VLAN_RUN`/`ID_LIST_CHARSET`/`allowedVlansValueOf`) and
 * `arista-api-client/src/config/ranges.ts` (`sortedRangeValues` + `collapseRangeToString`) — and the
 * collapse forms (`[10,20,21,22]` → `10,20-22`) are the same ones the client suite pins
 * (`switchports.test.ts:513-515` pins a raw string going out **verbatim**, which is why the
 * canonicalisation below is asserted for a *computed* set, not for a passed-through spelling).
 *
 * Nothing here is a hardware claim: which spellings the 7050TX-64 accepts is a device answer this repo
 * has no capture for (DR-028 / DECISIONS open item 4), so the keyword arms assert only that this app
 * refuses to invent members for them.
 */
import { describe, expect, it } from 'vitest'

import { VLAN_ID_MAX, VLAN_ID_MIN, applyAllowedVlansEdit, formatAllowedVlans, hasControlOrLineBoundary, parseAllowedVlans, trunkGroupNameRefusal } from './allowed-vlans'

describe('parseAllowedVlans — the id-list grammar', () => {
  it('reads a plain list into runs and members', () => {
    const parsed = parseAllowedVlans('10-12,20')
    expect(parsed.kind).toBe('ids')
    if (parsed.kind !== 'ids') return
    expect(parsed.ranges).toEqual([{ start: 10, end: 12 }, { start: 20, end: 20 }])
    expect(parsed.ids).toEqual([10, 11, 12, 20])
    expect(parsed.display).toBe('10-12,20')
  })

  it('expands the device verbatim pin, and collapses only for display', () => {
    // The client sends `1,2,3-5,6,7` unchanged when handed that string (switchports.test.ts:513-515);
    // this screen parses it, so the members are what an edit operates on and the display is collapsed.
    const parsed = parseAllowedVlans('1,2,3-5,6,7')
    expect(parsed.kind).toBe('ids')
    if (parsed.kind !== 'ids') return
    expect(parsed.raw).toBe('1,2,3-5,6,7')
    expect(parsed.ids).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(parsed.display).toBe('1-7')
  })

  it('de-duplicates an overlapping device list without reordering the runs it read', () => {
    const parsed = parseAllowedVlans('20,10-12,11')
    expect(parsed.kind).toBe('ids')
    if (parsed.kind !== 'ids') return
    expect(parsed.ranges).toEqual([{ start: 20, end: 20 }, { start: 10, end: 12 }, { start: 11, end: 11 }])
    expect(parsed.ids).toEqual([10, 11, 12, 20])
  })

  it('keeps the boundary ids it is allowed to write, and refuses the ones outside them', () => {
    expect(parseAllowedVlans(`${String(VLAN_ID_MIN)},${String(VLAN_ID_MAX)}`).kind).toBe('ids')
    const tooBig = parseAllowedVlans('10,9999999')
    expect(tooBig.kind).toBe('invalid')
    if (tooBig.kind !== 'invalid') return
    expect(tooBig.message).toContain('outside 1..4094')
    expect(parseAllowedVlans('0').kind).toBe('invalid')
  })

  it('refuses a malformed list rather than passing a typo through', () => {
    for (const raw of ['1,', '1-', '1-2-3', ',1', '1,,2']) {
      const parsed = parseAllowedVlans(raw)
      expect(parsed.kind, raw).toBe('invalid')
      if (parsed.kind !== 'invalid') continue
      expect(parsed.message, raw).toContain('looks like an id list but is not one')
    }
  })

  it('refuses a descending run as unproven rather than guessing its members', () => {
    const parsed = parseAllowedVlans('5-3')
    expect(parsed.kind).toBe('invalid')
    if (parsed.kind !== 'invalid') return
    expect(parsed.message).toContain('descending run')
    expect(parsed.message).toContain('unproven on this box (no hardware pin)')
  })

  it('names the config-line rule for a control character or a line separator', () => {
    for (const point of ['\u0007', '\u2028']) {
      const parsed = parseAllowedVlans(`10${point}20`)
      expect(parsed.kind).toBe('invalid')
      if (parsed.kind !== 'invalid') continue
      expect(parsed.message).toContain('control character, line break or line separator')
    }
  })

  it('empty and whitespace-only are refusals, not an empty set', () => {
    for (const raw of ['', '   ']) {
      const parsed = parseAllowedVlans(raw)
      expect(parsed.kind).toBe('invalid')
      if (parsed.kind !== 'invalid') continue
      expect(parsed.message).toContain('needs a value')
    }
  })

  it('leaves a keyword spelling unenumerable (DR-028)', () => {
    for (const raw of ['all', 'forward all', 'except 5', 'UNTYPED-KEYWORD']) {
      const parsed = parseAllowedVlans(raw)
      expect(parsed.kind, raw).toBe('keyword')
      if (parsed.kind !== 'keyword') continue
      expect(parsed.raw, raw).toBe(raw)
    }
  })
})

describe('formatAllowedVlans — M6 canonical form', () => {
  it('sorts, de-duplicates and joins runs the way the client does', () => {
    expect(formatAllowedVlans([10, 20, 21, 22])).toBe('10,20-22')
    expect(formatAllowedVlans([22, 10, 21, 10, 20])).toBe('10,20-22')
    // A two-member run collapses, per `config/ranges.ts` — that is what EOS writes.
    expect(formatAllowedVlans([1, 2])).toBe('1-2')
    expect(formatAllowedVlans([1, 2, 3, 4, 5, 6, 7])).toBe('1-7')
    expect(formatAllowedVlans([4094])).toBe('4094')
    expect(formatAllowedVlans([1, 3, 5])).toBe('1,3,5')
  })

  it('throws on an id it would have to invent, rather than clamping it', () => {
    expect(() => formatAllowedVlans([0])).toThrow(/not a VLAN id/)
    expect(() => formatAllowedVlans([4095])).toThrow(/assertVlanId/)
    expect(() => formatAllowedVlans([1.5])).toThrow(/not a VLAN id/)
  })
})

describe('applyAllowedVlansEdit — the range editor algebra', () => {
  it('adds to the set the read produced', () => {
    const edit = applyAllowedVlansEdit('add', [10, 20, 21, 22], '23,30-31')
    expect(edit.ok).toBe(true)
    if (!edit.ok) return
    expect(edit.text).toBe('10,20-23,30-31')
    expect(edit.changed).toBe(true)
  })

  it('removes from the set the read produced, run-aware', () => {
    const edit = applyAllowedVlansEdit('remove', [10, 11, 12, 20], '10-12')
    expect(edit.ok).toBe(true)
    if (!edit.ok) return
    expect(edit.text).toBe('20')
    expect(edit.ids).toEqual([20])
    expect(edit.changed).toBe(true)
  })

  it('reports a no-op so the screen can refuse a pointless session', () => {
    expect(applyAllowedVlansEdit('add', [10, 11], '10-11').ok).toBe(true)
    const unchanged = applyAllowedVlansEdit('add', [10, 11], '11')
    expect(unchanged.ok).toBe(true)
    if (!unchanged.ok) return
    expect(unchanged.text).toBe('10-11')
    expect(unchanged.changed).toBe(false)

    const sameReplace = applyAllowedVlansEdit('replace', [10, 11, 12], '10-12')
    expect(sameReplace.ok).toBe(true)
    if (!sameReplace.ok) return
    expect(sameReplace.changed).toBe(false)
  })

  it('replace does not need an enumerable current set', () => {
    const edit = applyAllowedVlansEdit('replace', undefined, '5-6,9')
    expect(edit.ok).toBe(true)
    if (!edit.ok) return
    expect(edit.text).toBe('5-6,9')
    expect(edit.changed).toBe(true)
  })

  it('refuses add/remove over a keyword spelling instead of guessing its members', () => {
    for (const kind of ['add', 'remove'] as const) {
      const edit = applyAllowedVlansEdit(kind, undefined, '20')
      expect(edit.ok, kind).toBe(false)
      if (edit.ok) continue
      expect(edit.message, kind).toContain('no enumerable allowed-VLAN set')
      expect(edit.message, kind).toContain('DR-028')
    }
  })

  it('refuses an edit that would empty the list and names the client rule plus the way out', () => {
    const edit = applyAllowedVlansEdit('remove', [10, 11], '10-11')
    expect(edit.ok).toBe(false)
    if (edit.ok) return
    expect(edit.message).toContain('refuses an empty allowed-VLAN list')
    expect(edit.message).toContain('Clear allowed VLAN list')
  })

  it('refuses an invalid or keyword edit value with the parse reason', () => {
    const malformed = applyAllowedVlansEdit('replace', [10], '1,')
    expect(malformed.ok).toBe(false)
    if (malformed.ok) return
    expect(malformed.message).toContain('looks like an id list but is not one')

    const keyword = applyAllowedVlansEdit('replace', [10], 'all')
    expect(keyword.ok).toBe(false)
    if (keyword.ok) return
    expect(keyword.message).toContain('ids and runs only')
  })
})

describe('trunkGroupNameRefusal — the client assertTrunkGroupName mirror, one copy for both screens', () => {
  it('accepts a plain token', () => {
    expect(trunkGroupNameRefusal('LABGRP')).toBeUndefined()
    expect(trunkGroupNameRefusal('webui-probe')).toBeUndefined()
  })

  it('refuses an empty or whitespace-only name, naming the client rule', () => {
    for (const value of ['', '   ']) {
      const refusal = trunkGroupNameRefusal(value)
      expect(refusal).toBeDefined()
      // Both screens compose `A trunk-group name ${refusal}.`, so this branch has to read as a predicate
      // of that subject ('is empty …'), not as a bare 'needed …'.
      expect(refusal).toContain('is empty')
      expect(refusal).toContain('assertTrunkGroupName')
    }
  })

  it('refuses a multi-word name and cites the upstream disagreement it mirrors', () => {
    const refusal = trunkGroupNameRefusal('two words')
    expect(refusal).toContain('single token')
    expect(refusal).toContain('switchports.py:115')
    expect(refusal).toContain('vlans.py:60')
  })

  it('refuses control characters and line separators by code point', () => {
    // The client checks control characters before the whitespace rule, so a BEL is named as a
    // control-character violation even though it is whitespace-shaped too — and a plain space still
    // reaches the single-token rule.
    for (const point of ['\u0007', '\u2028', '\n']) {
      expect(trunkGroupNameRefusal(`A${point}B`)).toContain('control character, line break or line separator')
    }
    expect(trunkGroupNameRefusal('two words')).toContain('single token')
    expect(trunkGroupNameRefusal('x\u0007')).toContain('control character, line break or line separator')
  })
})

describe('hasControlOrLineBoundary — the one code-point scan every screen reuses', () => {
  it('covers C0, DEL and the line boundaries, and nothing else', () => {
    for (const point of ['\u0000', '\u001f', '\u007f', '\u0085', '\u2028', '\u2029', '\r', '\n', '\u000b']) {
      expect(hasControlOrLineBoundary(`a${point}b`)).toBe(true)
    }
    for (const clean of ['LAB40', 'a b', 'A-MEM', 'ünïcode', '\u00a0nbsp'.slice(0, 10)]) {
      expect(hasControlOrLineBoundary(clean)).toBe(false)
    }
  })
})
