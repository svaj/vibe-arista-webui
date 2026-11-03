/**
 * `section` / `getBlock` specs — M6 (#8), the pyeapi `Node.section` (`pyeapi/client.py:776-798`) and
 * `BaseResource.get_block` (`pyeapi/api/abstract.py:82-101`) parity suite.
 *
 * Inline expectations below were **transcribed from one-off upstream runs on 2026-11-02** (pyeapi
 * 1.0.4-rc0 @ 6816d9e via `Node._chunkify.__wrapped__` + a `section`-shaped helper mirroring
 * `client.py:791-798`: compile → `[k for k in chunked.keys() if r.search(k)]` → first key). The
 * answers, verbatim from that run:
 *
 *   config A = "interface Ethernet10\n   description ten\n   no switchport\n!\n
 *               interface Ethernet1\n   description one\n   switchport mode trunk\n!\n"
 *   section 'interface Ethernet1'  -> 'interface Ethernet10\n   description ten\n   no switchport\n'   <-- FIRST KEY
 *   section '^interface Ethernet1$'-> 'interface Ethernet1\n   description one\n   switchport mode trunk\n'
 *   get_block 'interface Ethernet1'-> same as the anchored answer
 *   get_block 'interface Ethernet99'-> None
 *   section 'nope'                 -> TypeError: config section not found
 *   qos fixture, section 'class gold'      -> '   class gold\n      set ip dscp af11\n      set qos-group 1\n'
 *   qos fixture, get_block 'class gold'    -> None          (the key carries three leading SPACES)
 *   bgp fixture, section 'address-family ipv4'          -> '      address-family ipv4\n         neighbor 172.16.0.1 activate\n'
 *   bgp fixture, section '^   address-family ipv4$'     -> '   address-family ipv4\n      neighbor LEAF activate\n      network 192.0.2.0/24\n'
 *   vlan fixture, get_block 'vlan 20'       -> 'vlan 20\n   name "twenty (ops)"\n   state suspend\n   trunk group red\n   trunk group blue\n'
 *   vlan fixture, section '^vlan 11.13$'    -> 'vlan 11-13\n   name group-block\n'   (the PARENT IS SPLICED INTO THE PATTERN
 *                                                                                     VERBATIM — `.` widens; row 51)
 *   banner fixture, section 'banner motd'   -> 'banner motd\nWelcome to sw1 (lab).\n\nLast config change: nowhere.\nEOF\n'
 *
 * **DR-027 vs upstream — verified at the file, not inherited:** I opened `client.py:776-798` on
 * 2026-11-02. Line 789-791 resolves the `running_config`/`startup_config` sentinels against the
 * Node; 792 compiles the pattern; 793 builds `matching_keys`; **794-795**:
 * `if len(matching_keys) == 0: raise TypeError('config section not found')`; 796-798 take
 * `matching_keys[0]`. So upstream signals "not found" with a **TypeError** — this port raises
 * `NotFoundError` (DR-027, MIGRATION.md §5 row 50), and `getBlock` answers `undefined`
 * where `get_block` swallows the `TypeError` at `abstract.py:100-101` and returns `None`.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { ConfigParseError, NotFoundError, NotSupportedError } from '../errors'
import { createConfigChunkCache } from './cache'
import { chunkConfig } from './chunk'
import { getBlock, section } from './section'
import type { ConfigSections } from './chunk'

const FIXTURE_DIR = fileURLToPath(new URL('../../test/fixtures/config', import.meta.url))

interface OracleShape {
  readonly fixtures: Record<string, { entries?: readonly (readonly [string, string])[]; error?: { type: string; message: string } }>
}
const oracle = JSON.parse(readFileSync(`${FIXTURE_DIR}/pyeapi-oracle.json`, 'utf8')) as OracleShape

/** Config A from the transcription block above. */
const ETHERNETS =
  'interface Ethernet10\n   description ten\n   no switchport\n!\ninterface Ethernet1\n   description one\n   switchport mode trunk\n!\n'

describe('section() — transcribed upstream answers', () => {
  it('unanchored patterns are SEARCHES OVER KEYS, first key wins — the Ethernet1/Ethernet10 prefix trap', () => {
    // Transcribed: upstream answers with **Ethernet10's text** for pattern 'interface Ethernet1',
    // because that key appears first (client.py:793-796). Same here — this is the classic prefix
    // bug, kept as upstream behaviour so a UI cannot trust an unanchored lookup:
    expect(section('interface Ethernet1', { sections: chunkConfig(ETHERNETS) })).toBe(
      'interface Ethernet10\n   description ten\n   no switchport\n',
    )
    // The anchored form is the fix getBlock applies:
    expect(section('^interface Ethernet1$', { sections: chunkConfig(ETHERNETS) })).toBe(
      'interface Ethernet1\n   description one\n   switchport mode trunk\n',
    )
  })

  it('missing key → NotFoundError (upstream raises TypeError at client.py:795 — DR-027)', () => {
    // Transcribed: `TypeError: config section not found`. Our message ADDS the pattern (row 50) so
    // the webui error panel can say which lookup failed without re-deriving the call site:
    expect(() => section('nope', { config: ETHERNETS })).toThrowError(NotFoundError)
    expect(() => section('nope', { config: ETHERNETS })).toThrow('config section not found: nope')
    const caught = ((): unknown => {
      try {
        section('nope', { config: ETHERNETS })
      } catch (error) {
        return error
      }
      return undefined
    })()
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).name).toBe('NotFoundError')
    expect(caught).toBeInstanceOf(NotFoundError)
  })

  it('a RegExp pattern is used as given; /g cannot make calls answer differently (search ignores lastIndex)', () => {
    const pattern = /interface Ethernet\d+$/g
    expect(section(pattern, { sections: chunkConfig(ETHERNETS) })).toBe(
      'interface Ethernet10\n   description ten\n   no switchport\n',
    )
    expect(section(pattern, { sections: chunkConfig(ETHERNETS) })).toBe(
      'interface Ethernet10\n   description ten\n   no switchport\n',
    )
  })

  it('an invalid pattern string throws SyntaxError and stays loud — parity with upstream, which also does not raise TypeError for it', () => {
    // upstream: re.compile('(') raises `re.error` (NOT a TypeError), so `get_block`'s
    // `except TypeError` (abstract.py:100) does NOT swallow it either. Our catch is narrower than
    // pyeapi's on purpose, so both stay visible:
    expect(() => section('(', { config: ETHERNETS })).toThrow(SyntaxError)
    expect(() => getBlock('(', { config: ETHERNETS })).toThrow(SyntaxError)
  })
})

describe('getBlock() — anchored ^…$ lookup, undefined for absence (abstract.py:96-101 twin)', () => {
  it('interface Ethernet1 returns the Ethernet1 block even though unanchored section() hit Ethernet10', () => {
    expect(getBlock('interface Ethernet1', { config: ETHERNETS })).toBe(
      'interface Ethernet1\n   description one\n   switchport mode trunk\n',
    )
    // Transcribed: upstream get_block('interface Ethernet99') -> None; ours undefined, NO throw:
    expect(getBlock('interface Ethernet99', { config: ETHERNETS })).toBeUndefined()
  })

  it('the parent is interpolated AS WRITTEN — metacharacters in a name widen the match (row 51, kept for parity)', () => {
    // Transcribed: section('^vlan 11.13$') finds the `vlan 11-13` section upstream because the `.`
    // is a pattern wildcard, not a literal dash. Same answer here — a caller needing a literal name
    // must build an escaped RegExp themselves (documented on getBlock):
    const vl = readFileSync(`${FIXTURE_DIR}/vlan-blocks.conf`, 'utf8')
    expect(section('^vlan 11.13$', { config: vl })).toBe('vlan 11-13\n   name group-block\n')
    expect(getBlock('vlan 11-13', { config: vl })).toBe('vlan 11-13\n   name group-block\n')
    expect(getBlock('vlan 20', { config: vl })).toBe(
      'vlan 20\n   name "twenty (ops)"\n   state suspend\n   trunk group red\n   trunk group blue\n',
    )
    expect(getBlock('vlan 1', { config: vl })).toBe('vlan 1\n') // degenerate bodyless section, upstream 'vlan 1\n'
  })

  it('the qos `class gold` trap: unanchored hits the SUB-section, anchored finds NOTHING (both transcribed)', () => {
    const qos = readFileSync(`${FIXTURE_DIR}/qos-class-policy-map.conf`, 'utf8')
    expect(section('class gold', { config: qos })).toBe('   class gold\n      set ip dscp af11\n      set qos-group 1\n')
    expect(getBlock('class gold', { config: qos })).toBeUndefined() // upstream: None — keys carry the indent
    expect(getBlock('policy-map type qos QUEUES', { config: qos })).toContain('   class gold\n')
    // The indent is part of the key, so the honest way to fetch the sub-section is spelled with it:
    expect(getBlock('   class gold', { config: qos })).toBe('   class gold\n      set ip dscp af11\n      set qos-group 1\n')
  })

  it('banner sections come back MULTILINE-complete, EOF included (transcribed)', () => {
    const bn = readFileSync(`${FIXTURE_DIR}/banner-eof.conf`, 'utf8')
    expect(section('banner motd', { config: bn })).toBe(
      'banner motd\nWelcome to sw1 (lab).\n\nLast config change: nowhere.\nEOF\n',
    )
  })
})

describe('section()/getBlock() — fixture-driven first-key parity over the whole oracle', () => {
  // For every fixture and every key upstream produced, the upstream selection rule
  // (client.py:793-796: first key whose match is a regex SEARCH) is reproduced over the oracle's
  // ORDERED entries to get the expected value; the implementation under test must agree. The
  // selection rule is transcribed from the source above — the DATA is pyeapi's — so nothing here
  // asks this repo to grade its own homework.
  for (const [name, fixture] of Object.entries(oracle.fixtures)) {
    const oracleEntries = fixture.entries
    if (oracleEntries === undefined) continue
    it(`${name}: first-matching-key answers for every one of its own section keys`, () => {
      const text = readFileSync(`${FIXTURE_DIR}/${name}`, 'utf8')
      const sections = chunkConfig(text)
      for (const [pattern] of oracleEntries) {
        const expected = oracleEntries.find(([key]) => key.search(new RegExp(pattern)) !== -1)?.[1]
        expect(section(pattern, { sections }), `${name} pattern ${JSON.stringify(pattern)}`).toBe(expected)
        // the config-text path must answer identically:
        expect(section(pattern, { config: text })).toBe(expected)
      }
    })
  }
})

describe('section() — option validation and the pyeapi sentinels (no Node on this branch, M4 #6 owns wiring)', () => {
  it('the pyeapi sentinel strings are refused with a message that names what to pass instead', () => {
    // Upstream resolves these against `self.running_config` (client.py:789-791); a pure function
    // cannot, and silently treating the sentinel as CONFIG TEXT would search for sections named
    // 'running_config' — worse than refusing (NotSupportedError is not a NotFoundError in disguise):
    for (const sentinel of ['running_config', 'startup_config']) {
      expect(() => section('!', { config: sentinel })).toThrowError(NotSupportedError)
      expect(() => section('!', { config: sentinel })).toThrow(`config is the pyeapi sentinel ${JSON.stringify(sentinel)}`)
    }
  })

  it('neither source supplied, and a non-Map sections object, both raise NotSupportedError naming the fix', () => {
    expect(() => section('x', {} as never)).toThrow('one of "config" (text) or "sections" (chunked) is required')
    const bogus = { interface: 'Ethernet1' } as unknown as ConfigSections
    expect(() => section('.', { sections: bogus })).toThrow('section(): "sections" was provided but is not a chunked config document')
  })

  it('the chunker failure rides through: a section lookup on a broken config throws ConfigParseError, getBlock does NOT swallow it', () => {
    const broken = readFileSync(`${FIXTURE_DIR}/unhandled-literal-short-line.conf`, 'utf8')
    expect(() => section('anything', { config: broken })).toThrowError(ConfigParseError)
    expect(() => getBlock('anything', { config: broken })).toThrowError(ConfigParseError)
    // getBlock only converts NotFoundError: upstream's catch-all `except TypeError` swallowing a
    // ConfigParseError-shaped failure is exactly what DR-027 removes (rows 52/50).
  })

  it('the DR-026 memo path: {config, cache} chunks the text exactly once across repeated lookups', () => {
    const text = readFileSync(`${FIXTURE_DIR}/router-bgp-address-family.conf`, 'utf8')
    const cache = createConfigChunkCache()
    const first = section('router bgp 43902', { config: text, cache })
    const again = section('^router bgp 43902$', { config: text, cache })
    expect(first).toBe(again)
    expect(cache.stats).toMatchObject({ misses: 1, hits: 1, holding: true })
    cache.invalidate() // what M4's refresh() will call
    expect(section('router bgp', { config: text, cache })).toBe(first)
    expect(cache.stats).toMatchObject({ misses: 2, hits: 1 })
  })
})
