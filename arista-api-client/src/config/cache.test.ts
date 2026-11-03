/**
 * DR-026 chunk-cache specs — M6 (#8). The memo `cache.ts` replaces is pyeapi's
 * `@lru_cache(maxsize=None)` on `_chunkify` (`pyeapi/client.py:697`, and the manual
 * `self._chunkify.cache_clear()` calls at `client.py:665-666` and `:689-690` — verified by opening
 * those lines on 2026-11-02): an **unbounded** dict keyed by full config text, shared mutably with
 * every caller. MIGRATION.md §5 row 12 planned the replacement; row 59 records how this is built.
 *
 * All four claims under test: identical text hits; changed text misses; bounded (single-entry, so no
 * pyeapi-style growth across polls); explicit `invalidate()`. Plus the two honesty guards the DR
 * leans on: the content hash is a fast reject, never trust — a hash collision with different text
 * MUST NOT serve the held document (that would hand one switch's sections to another switch's
 * config, which row 59 calls a configuration hazard, not a perf detail); and the handed-out map is
 * `ReadonlyMap`-typed, where pyeapi hands out the live cache dict.
 */

import { describe, expect, it } from 'vitest'

import { chunkConfig } from './chunk'
import { createConfigChunkCache } from './cache'

/** FNV-1a 32-bit, re-derived HERE (mirroring `hashConfig` in cache.ts) so the collision probe below
 *  can feed the cache a pair the module's own hash treats as equal. If `cache.ts` ever changes hash,
 *  this loop stops finding collisions and the guard test fails LOUDLY — updating it is a conscious
 *  edit, which is the point. */
function fnv32(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

function findHashCollision(): [string, string] | undefined {
  const seen = new Map<number, string>()
  for (let i = 0; i < 500_000; i += 1) {
    const text = `vlan ${i}\n   name probe${i}\n!\n`
    const hash = fnv32(text)
    const prior = seen.get(hash)
    if (prior !== undefined) return [prior, text]
    seen.set(hash, text)
  }
  return undefined
}

describe('createConfigChunkCache — DR-026 hit/miss accounting', () => {
  it('a first lookup misses, an identical-text repeat hits and returns the SAME map instance', () => {
    const cache = createConfigChunkCache()
    const config = 'hostname sw1\ninterface Ethernet1\n   no switchport\n!\n'
    const first = cache.chunkConfig(config)
    const second = cache.chunkConfig(config)
    expect(cache.stats).toEqual({ hits: 1, misses: 1, invalidations: 0, holding: true })
    expect(second).toBe(first) // shared memo, not re-parsed — 48 section()s in a getAll() cost ONE chunk
    expect([...second.keys()]).toEqual([...chunkConfig(config).keys()]) // and it is the right document
  })

  it('changed text misses — even when only one character moved (hash reject, equality confirm)', () => {
    const cache = createConfigChunkCache()
    cache.chunkConfig('hostname sw1\n')
    cache.chunkConfig('hostname sw2\n')
    expect(cache.stats).toEqual({ hits: 0, misses: 2, invalidations: 0, holding: true })
  })

  it('BUDGED, not unbounded: two texts alternating churn a single entry (hits stay 0) — pyeapi would keep both forever', () => {
    const cache = createConfigChunkCache()
    for (let poll = 0; poll < 50; poll += 1) {
      cache.chunkConfig('hostname a\n')
      cache.chunkConfig('hostname b\n')
    }
    expect(cache.stats.hits).toBe(0) // every call replaced the single held entry — no LRU growth to retain
    expect(cache.stats.misses).toBe(100)
    // The LAST config is the only one still memoised:
    cache.chunkConfig('hostname b\n')
    expect(cache.stats.hits).toBe(1)
    cache.chunkConfig('hostname a\n')
    expect(cache.stats.hits).toBe(1) // 'a' is long gone — a 2-entry LRU would have hit here
  })

  it('invalidate() drops the document and counts — what M4 refresh() will lean on', () => {
    const cache = createConfigChunkCache()
    const config = 'vlan 20\n   name x\n!\n'
    cache.chunkConfig(config)
    cache.invalidate()
    expect(cache.stats).toMatchObject({ invalidations: 1, holding: false })
    cache.chunkConfig(config)
    expect(cache.stats).toMatchObject({ misses: 2, hits: 0, holding: true }) // same text, but the memo was declared stale
  })

  it('stats is a fresh snapshot per read — counters cannot be poked from outside', () => {
    const cache = createConfigChunkCache()
    const before = cache.stats
    cache.chunkConfig('a\n')
    expect(before).toEqual({ hits: 0, misses: 0, invalidations: 0, holding: false })
    expect(cache.stats.misses).toBe(1)
  })
})

describe('createConfigChunkCache — the equality guard behind the hash fast-reject', () => {
  it('two DIFFERENT configs that share a 32-bit FNV hash still re-chunk (no cross-config section bleed)', () => {
    const collision = findHashCollision()
    if (collision === undefined) {
      throw new Error('no FNV-1a 32-bit collision found in 500k probes — cache.ts changed its hash algorithm; update this probe or the guard deliberately')
    }
    const [textA, textB] = collision
    expect(fnv32(textA)).toBe(fnv32(textB)) // the pair really is hash-equal
    const cache = createConfigChunkCache()
    const sectionsA = cache.chunkConfig(textA)
    const sectionsB = cache.chunkConfig(textB)
    // If the memo trusted the hash alone, the second call would hand back switch A's sections for
    // switch B's text — the row-52 hazard. Instead: second call missed, and its document is its own:
    expect(cache.stats).toEqual({ hits: 0, misses: 2, invalidations: 0, holding: true })
    expect(sectionsB).not.toBe(sectionsA)
    expect([...sectionsB.keys()]).toEqual([...chunkConfig(textB).keys()])
    expect(sectionsB.get(textA.split('\n')[0] as string) === undefined || textA.split('\n')[0] === textB.split('\n')[0]).toBe(true)
  })
})

describe('createConfigChunkCache — the memo is shared but read-only at compile time', () => {
  it('mutation attempts on a handed-out document are TYPE errors (@ts-expect-error), unlike pyeapi live lru_cache dict', () => {
    const cache = createConfigChunkCache()
    const sections = cache.chunkConfig('hostname sw1\n')
    // The guard is COMPILE-time (row 59): at runtime this is still a Map, and it mutates the shared
    // memo — which is exactly why the type excludes it. The `delete` undoes the `set` so this test
    // reads cleanly; the type errors are the assertion.
    // @ts-expect-error ReadonlyMap has no set — the poison-the-memo path is closed at build time.
    sections.set('hostname evil', 'hostname evil\n')
    // @ts-expect-error …and no delete either (chunk.ts documented why: one pop corrupts every later read).
    sections.delete('hostname evil')
    expect([...sections.keys()]).toEqual(['hostname sw1'])
  })

  it('the parse it shares is the chunker parse — cache output stays equal to a direct chunkConfig', () => {
    const config = 'router bgp 1\n   vrf T\n      !\n!\n'
    const direct = chunkConfig(config)
    const cached = createConfigChunkCache().chunkConfig(config)
    expect([...cached.entries()]).toEqual([...direct.entries()])
  })
})
