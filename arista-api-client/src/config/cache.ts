/**
 * The DR-026 chunk cache — one parsed document held at a time, keyed by content hash.
 *
 * pyeapi decorates `_chunkify` with `@lru_cache(maxsize=None)` (`pyeapi/client.py:697`) — an
 * **unbounded** map keyed by the full config text, and the only thing keeping it correct is the manual
 * `self._chunkify.cache_clear()` after a config change (`client.py:665-666`, `:689-690`, plus the
 * `configure`/`refresh` paths). A `Node` that reads a 60 kB running-config every poll keeps every
 * version of it forever; and the cache is reachable from the returned dict, so a caller that mutates
 * the dict it was handed corrupts the memo.
 *
 * DR-026's replacement, implemented:
 *  - **single entry**, not unbounded: one parsed document per cache, so a long-lived `Node` or a
 *    webui poll loop cannot grow the heap;
 *  - keyed by a content hash for the fast reject, then compared by **exact string equality** before
 *    the memo is trusted — a 32-bit hash alone would let two different configs answer each other's
 *    lookups, and a config-text cache that returns another switch's sections is a configuration
 *    hazard, not a performance detail;
 *  - invalidated by an explicit `invalidate()` from M4's `refresh()` (`docs/ARCHITECTURE.md` §7:
 *    "All invalidated by `refresh()` or explicitly"), not by a `cache_clear()` call buried in the
 *    transport path.
 *
 * The parsed document is handed out as a `ReadonlyMap` (`chunk.ts`), so "share the memo" and "don't
 * let a caller poison it" are both true at compile time. MIGRATION.md §5 row 12 (planned) is realised
 * here; row 59 records how.
 */

import { chunkConfig, type ConfigSections } from './chunk'

/** FNV-1a, 32-bit. Chosen for being branch-free and dependency-free, not for collision resistance —
 *  which is why every hit is still confirmed by string equality. */
const FNV_OFFSET_BASIS = 0x811c9dc5
const FNV_PRIME = 0x01000193

function hashConfig(config: string): number {
  let hash = FNV_OFFSET_BASIS
  for (let index = 0; index < config.length; index += 1) {
    hash ^= config.charCodeAt(index)
    hash = Math.imul(hash, FNV_PRIME) >>> 0
  }
  return hash >>> 0
}

/** What a cache did, for a test or a debug panel to assert on. Not a performance API. */
export interface ConfigChunkCacheStats {
  /** Lookup hits — calls that reused the parsed document instead of re-chunking. */
  readonly hits: number
  /** Lookup misses — every call, hit or miss, is exactly one `chunkConfig()` cost when it misses. */
  readonly misses: number
  /** Explicit invalidations (`refresh()`). */
  readonly invalidations: number
  /** `true` while a parsed document is held. Always `false` straight after `invalidate()`. */
  readonly holding: boolean
}

/**
 * A single-entry config-chunk memo (DR-026). Create one per config cache — pyeapi's per-`Node`
 * `running_config`/`startup_config` pair maps to two of these, and DR-030's per-operation snapshot
 * maps to a throwaway one.
 */
export interface ConfigChunkCache {
  /** The parsed document for `config`; re-chunks only when the held entry is not this exact text. */
  chunkConfig(config: string): ConfigSections
  /** Drop the held document. M4's `Node.refresh()` calls this after any config write or read. */
  invalidate(): void
  /** A snapshot of the counters — see `ConfigChunkCacheStats`. */
  readonly stats: ConfigChunkCacheStats
}

interface HeldEntry {
  readonly config: string
  readonly hash: number
  readonly sections: ConfigSections
}

export function createConfigChunkCache(): ConfigChunkCache {
  let held: HeldEntry | undefined
  let hits = 0
  let misses = 0
  let invalidations = 0

  const cache: ConfigChunkCache = {
    chunkConfig(config: string): ConfigSections {
      if (held !== undefined && held.hash === hashConfig(config) && held.config === config) {
        hits += 1
        return held.sections
      }
      misses += 1
      const sections = chunkConfig(config)
      held = { config, hash: hashConfig(config), sections }
      return sections
    },
    invalidate(): void {
      held = undefined
      invalidations += 1
    },
    get stats(): ConfigChunkCacheStats {
      return { hits, misses, invalidations, holding: held !== undefined }
    },
  }
  return cache
}
