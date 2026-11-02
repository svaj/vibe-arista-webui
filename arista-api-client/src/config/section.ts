/**
 * `section` / `getBlock` — the two lookups every resource module uses, M6 (#8).
 *
 * Port of pyeapi `Node.section` (`pyeapi/client.py:776-798`) and
 * `BaseResource.get_block` (`pyeapi/api/abstract.py:82-101`). Both are pure here: pyeapi's `section`
 * lives on `Node` because it reaches for `self.running_config` (`client.py:789-791`); this module takes
 * the text (or an already-chunked map) instead, which is what lets M4's `Node`, M7's resource base and
 * the webui's fixture tests all use the same code path. The `Node.section()` method itself is M4's (#6)
 * to wire — see the gap noted in `docs/PLAN.md` M6.
 *
 * Not-found is a **`NotFoundError`**, not a `TypeError` (DR-027): pyeapi raises
 * `TypeError('config section not found')` (`client.py:795`), so a caller cannot distinguish "the switch
 * has no such section" from "I passed the wrong argument type" — and `get_block` papers over it with
 * `except TypeError` (`abstract.py:100`), which also swallows genuine `TypeError`s from a bad pattern.
 * Here `section` throws `NotFoundError` for absence (and only for absence), and `getBlock` returns
 * `undefined`. MIGRATION.md §5 rows 13 (planned) / 38-39 (as implemented).
 */

import { NotFoundError, NotSupportedError } from '../errors'
import { chunkConfig, type ConfigSections } from './chunk'
import type { ConfigChunkCache } from './cache'

/** The lookup target: config text (chunked here), or a chunked document obtained earlier. */
export interface SectionFromText {
  /** Config **text**, e.g. the `output` of `show running-config` (`format: 'text'`). */
  readonly config: string
  /**
   * Optional DR-026 memo. A `Node` (M4 #6) holds one per config cache and `invalidate()`s it on
   * `refresh()`, so a `getAll()` that calls `section()` 48 times chunks the device text once.
   */
  readonly cache?: ConfigChunkCache | undefined
}

export interface SectionFromSections {
  /** A chunked document — `chunkConfig(text)`, or `chunkCache.chunkConfig(text)`. */
  readonly sections: ConfigSections
}

export type SectionOptions = SectionFromText | SectionFromSections

/** pyeapi accepts these two sentinel strings and resolves them against `Node`; there is no Node here. */
const PYEAPI_CONFIG_SENTINELS: readonly string[] = ['running_config', 'startup_config']

/** A pattern for the section-key scan: a string is compiled as a regex, exactly as pyeapi compiles it. */
export type SectionPattern = string | RegExp

function sectionsOf(options: SectionOptions): ConfigSections {
  if ('sections' in options) {
    // Runtime-checked rather than trusted: a JS caller (or a webui state object persisted and restored)
    // can hand us anything, and "sections was not a Map" must not surface as `sections is not iterable`.
    if (!(options.sections instanceof Map)) {
      throw new NotSupportedError('section(): "sections" was provided but is not a chunked config document')
    }
    return options.sections
  }
  const { config } = options
  if (typeof config !== 'string') {
    throw new NotSupportedError('section(): one of "config" (text) or "sections" (chunked) is required')
  }
  if (PYEAPI_CONFIG_SENTINELS.includes(config)) {
    throw new NotSupportedError(
      `section(): config is the pyeapi sentinel ${JSON.stringify(config)}, which needs a Node to resolve. ` +
        'Pass the config text (M4 #6: await node.getRunningConfig()) or a chunkConfig() result.',
    )
  }
  return options.cache === undefined ? chunkConfig(config) : options.cache.chunkConfig(config)
}

/**
 * The first section whose key matches `pattern`, in device order — pyeapi's `section` semantics,
 * including the part everyone forgets: it is a **search over keys**, not over config text, so
 * `^`/`$` anchor the section header (`client.py:792-797`).
 *
 * @throws {NotFoundError} no key matched (DR-027).
 * @throws {NotSupportedError} neither `config` nor `sections` was supplied, or `config` is a pyeapi
 *   sentinel string.
 * @throws {ConfigParseError} the config text hit the chunker's explicit failure mode.
 */
export function section(pattern: SectionPattern, options: SectionOptions): string {
  const sections = sectionsOf(options)
  const regex = typeof pattern === 'string' ? new RegExp(pattern) : pattern
  for (const [key, value] of sections) {
    // `String#search` = Python `re.search` on one key, and unlike `RegExp#test` it never advances
    // `lastIndex`, so a caller who passes a `/g` pattern gets the same answer every call.
    if (key.search(regex) !== -1) return value
  }
  throw new NotFoundError(`config section not found: ${regex.source}`)
}

/**
 * The whole block under an exact section header, or `undefined` — pyeapi's `get_block`
 * (`abstract.py:96-101`), which anchors the parent with `'^%s$'`.
 *
 * The parent is interpolated into the pattern **as written**, upstream parity, with a real consequence:
 * a parent containing regex metacharacters is a pattern, not a name (`interface Ethernet1/1` is safe;
 * `class-map type qos (match-all)` is not, and `.`/`?`/`+` in a name silently widen the match).
 * A caller who needs a literal name passes one without metacharacters or builds the RegExp itself and
 * calls `section()`. Row 39.
 */
export function getBlock(parent: string, options: SectionOptions): string | undefined {
  try {
    return section(`^${parent}$`, options)
  } catch (error) {
    // pyeapi catches `TypeError`, which is also what a bad pattern or a bad argument raises there
    // (`abstract.py:99-101`); catching only NotFoundError keeps those loud.
    if (error instanceof NotFoundError) return undefined
    throw error
  }
}
