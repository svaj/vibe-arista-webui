/**
 * Fixture-driven chunker parity — M6 (#8) exit gate: the chunker must produce **exactly what upstream
 * pyeapi produces, entry by entry and in order**, for every `.conf` under `test/fixtures/config/`.
 *
 * `pyeapi-oracle.json` is the record of upstream `_chunkify` (pyeapi 1.0.4-rc0, `develop` @
 * 6816d9e, `pyeapi/client.py:698-774` reached via `Node._chunkify.__wrapped__`) run over those bytes
 * by `scripts/config-chunkify-oracle.py`. Order is load-bearing, not cosmetic: `Node.section`
 * (`client.py:793-796`) answers with the **first** matching key and the recursive merge at
 * `client.py:770-771` puts sub-section keys before their parent — so `[key, value]` pairs are compared
 * as ordered lists, never as dicts.
 *
 * The fixtures themselves are **hand-authored** (see `test/fixtures/config/README.md` and
 * `manifest.json.provenance`): the oracle pins *pyeapi's* behaviour on those bytes, which is parity
 * evidence, not device evidence. Device-captured 4.28.14M / 4.28.13.1M config text is M12 (#14).
 *
 * Offline (TESTING.md §1): the only I/O here is reading fixture JSON/text from disk; no device, no
 * container, and deliberately **no Python at test time** — the transcription ship already sailed when
 * the oracle was regenerated.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { ConfigParseError } from '../errors'
import { chunkConfig } from './chunk'

// From `src/config/`: up to the package root, then into `test/fixtures/config`.
const FIXTURE_DIR = fileURLToPath(new URL('../../test/fixtures/config', import.meta.url))

/**
 * The upstream baseline this oracle was generated against — PLAN.md's header pins the same commit
 * ("pyeapi 1.0.4-rc0 (`develop`, `6816d9e`)"). If this guard fires, nobody re-ran the generator after
 * moving the baseline: regenerate DELIBERATELY and update the pin in the same commit, never by
 * editing either file to make a test pass.
 */
const PINNED_UPSTREAM_COMMIT = '6816d9e498f06d773fd97121b805dec198c9f6e2'

interface OracleEntry {
  readonly entries: readonly (readonly [string, string])[]
}
interface OracleError {
  readonly error: { readonly type: string; readonly message: string }
}
type OracleFixture = OracleEntry | OracleError

interface OracleShape {
  readonly provenance: {
    readonly generatedBy: string
    readonly upstream: string
    readonly upstreamRef: { readonly branch: string; readonly commit: string }
    readonly upstreamSource: string
    readonly what: string
  }
  readonly fixtures: Record<string, OracleFixture>
}

interface ManifestShape {
  readonly provenance: { readonly kind: string; readonly deviceVerified: boolean; readonly parityOracle: string }
  readonly fixtures: Record<string, { readonly label: string; readonly forms: readonly string[]; readonly notes?: string; readonly raises?: string }>
}

function readText(name: string): string {
  return readFileSync(`${FIXTURE_DIR}/${name}`, 'utf8')
}

function readJson<T>(name: string): T {
  return JSON.parse(readText(name)) as T
}

const oracle = readJson<OracleShape>('pyeapi-oracle.json')
const manifest = readJson<ManifestShape>('manifest.json')

/** Every `.conf` on disk, sorted — the set the manifest AND the oracle must both match exactly. */
function confFiles(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((entry) => entry.endsWith('.conf'))
    .sort()
}

function hasEntries(fixture: OracleFixture): fixture is OracleEntry {
  return 'entries' in fixture
}

describe('config fixtures — inventory guards (M1 wire-suite pattern)', () => {
  it('every .conf on disk has exactly one manifest entry and one oracle entry — nothing unread may drift', () => {
    const onDisk = confFiles()
    expect(onDisk.length).toBeGreaterThan(0)
    expect(Object.keys(manifest.fixtures).sort()).toEqual(onDisk)
    expect(Object.keys(oracle.fixtures).sort()).toEqual(onDisk)
  })

  it('manifest `raises` markers and oracle error shapes agree — negative fixtures stay negative', () => {
    for (const name of confFiles()) {
      const claimsRaises = manifest.fixtures[name]?.raises === 'ConfigParseError'
      const oracleErrored = !hasEntries(oracle.fixtures[name] as OracleFixture)
      expect(oracleErrored, `${name}: manifest raises=${String(claimsRaises)} but oracle shape disagrees`).toBe(claimsRaises)
    }
  })

  it('the manifest is honest: hand-authored, not device-verified — until M12 (#14) replaces it', () => {
    expect(manifest.provenance.kind).toBe('hand-authored')
    expect(manifest.provenance.deviceVerified).toBe(false)
    // If a device capture ever lands (M12 #14, per test/fixtures/config/README.md "Still owed"), it
    // arrives as NEW bytes under test/fixtures/recordings/, and this guard moves with the manifest —
    // nobody flips this flag from their sofa.
  })
})

describe('oracle provenance — the committed record cannot silently drift', () => {
  it('the pinned upstream commit matches PLAN.md\'s baseline (6816d9e…)', () => {
    expect(oracle.provenance.upstream).toBe('pyeapi')
    expect(oracle.provenance.upstreamRef.commit).toBe(PINNED_UPSTREAM_COMMIT)
    expect(oracle.provenance.upstreamRef.branch).toBe('develop')
    expect(oracle.provenance.upstreamSource).toContain('client.py:698-774')
  })

  it('the oracle says what it is: pyeapi output, NOT device output', () => {
    expect(oracle.provenance.what).toContain('NOT device output')
    expect(oracle.provenance.generatedBy).toBe('arista-api-client/scripts/config-chunkify-oracle.py')
  })

  it('the generator ships a --check mode that re-runs upstream and compares (run it by hand, never from npm test)', () => {
    // Script-level guard: the docstring and README both promise `--check`; if the flag disappears the
    // maintainer's drift tool breaks silently. Checked from the script's own text — no Python invoked.
    const script = readFileSync(fileURLToPath(new URL('../../scripts/config-chunkify-oracle.py', import.meta.url)), 'utf8')
    expect(script).toContain('"--check"')
    expect(script).toContain('Node._chunkify.__wrapped__')
  })
})

describe('chunkConfig — ordered-entry parity with the committed pyeapi oracle', () => {
  /**
   * Failure copy is deliberate: the FIX for a mismatch is to regenerate the oracle with the script
   * (after consciously deciding the engine changed) — never to hand-edit `pyeapi-oracle.json`, which
   * is a transcription of upstream, not an expectation we own.
   */
  function expectOracleEntries(name: string, actual: readonly (readonly [string, string])[]): void {
    const fixture = oracle.fixtures[name] as OracleEntry
    const expected = fixture.entries
    const same = actual.length === expected.length && actual.every(([key, value], i) => expected[i]![0] === key && expected[i]![1] === value)
    if (same) return
    throw new Error(
      `chunkConfig(${name}) no longer matches the committed pyeapi oracle (ordered [key, value] pairs):\n` +
        `  oracle: ${JSON.stringify(expected)}\n` +
        `  ours:   ${JSON.stringify(actual)}\n` +
        `pyeapi-oracle.json is GENERATED from upstream, not hand-authored. If this divergence is real, regenerate it\n` +
        `DELIBERATELY and review the diff:\n` +
        `  python3 arista-api-client/scripts/config-chunkify-oracle.py\n` +
        `(then ` +
        `'--check' must print: oracle matches upstream). Never edit pyeapi-oracle.json to make a failing assertion pass.`,
    )
  }

  for (const name of confFiles()) {
    const fixture = oracle.fixtures[name] as OracleFixture

    if (hasEntries(fixture)) {
      it(`${name}: key-for-key, value-for-value, position-for-position`, () => {
        expectOracleEntries(name, [...chunkConfig(readText(name)).entries()])
      })
      continue
    }

    it(`${name}: upstream raises ${fixture.error.type} — we raise ConfigParseError with byte-identical text`, () => {
      // MIGRATION.md §5 row 52: class ours, wording upstream's, so a device log and this message
      // still diff cleanly. `expect(…).toThrow(string)` is a substring match — assert FULL equality
      // off the caught instance too.
      let thrown: unknown
      try {
        chunkConfig(readText(name))
        thrown = undefined
      } catch (error) {
        thrown = error
      }
      expect(thrown, `${name} must raise, the oracle recorded an error`).toBeInstanceOf(ConfigParseError)
      const parseError = thrown as ConfigParseError
      expect(parseError.message).toBe(fixture.error.message)
      expect(fixture.error.type).toBe('ValueError') // the upstream class, kept visible in the record
    })
  }

  it('re-chunking every positive fixture twice answers identically (the map is a value, not a latch)', () => {
    for (const name of confFiles()) {
      if (!hasEntries(oracle.fixtures[name] as OracleFixture)) continue
      const text = readText(name)
      expect([...chunkConfig(text).entries()]).toEqual([...chunkConfig(text).entries()])
    }
  })
})
