/**
 * Test-only seams for the `eapi.conf` filesystem search — M3 (#5).
 *
 * `src/internal/eapi-conf.ts` takes the filesystem as an argument ({@link ConfFileSystem}) precisely so
 * the unit suite can assert search order, `$EAPI_CONF` precedence, `~` expansion and the missing-file
 * path **without touching a disk** (docs/TESTING.md §1: the unit tier is offline; DR-034). This helper
 * is the in-memory implementation of that seam, plus a reader for the committed fixtures under
 * `test/fixtures/eapi.conf/`.
 *
 * Nothing here is a public contract: `src/testing/**` is not an import path (#DR-040), it is excluded
 * from the published declarations and from the coverage denominators. The `node:fs`/`node:url` imports
 * are test-support only — no module reachable from `src/index.ts` may touch a built-in (DR-002,
 * enforced by `src/browser-safety.test.ts` and the Vite build guard).
 */

import { readdirSync, readFileSync } from 'node:fs'

import { fileURLToPath } from 'node:url'

import type { ConfFileSystem } from '../internal/eapi-conf'

/**
 * An in-memory directory. A `string` value is the file's text; an `Error` value makes the candidate
 * **exist but fail to read**, which is how a directory (pyeapi's `os.path.exists` is true for one —
 * `client.py:178-183`) or an unreadable file behaves.
 */
export type ConfFiles = Readonly<Record<string, string | Error>>

export interface FakeConfFileSystem extends ConfFileSystem {
  /** Every path `readText` was asked for, in order — the audit trail the tests assert on. */
  readonly reads: readonly string[]
}

/** A {@link ConfFileSystem} backed by `files`. `homeDirectory` is what `~` expands to. */
export function fakeConfFileSystem(files: ConfFiles, options: { homeDirectory?: string | undefined } = {}): FakeConfFileSystem {
  const reads: string[] = []
  const { homeDirectory } = options
  return {
    reads,
    exists: (path: string): boolean => Object.prototype.hasOwnProperty.call(files, path),
    readText: (path: string): string => {
      reads.push(path)
      const entry: string | Error | undefined = files[path]
      if (typeof entry === 'string') return entry
      if (entry instanceof Error) throw entry
      throw new TypeError(`fake fs: no such file ${JSON.stringify(path)}`)
    },
    homeDirectory: (): string | undefined => homeDirectory,
  }
}

/** The committed `eapi.conf` corpus. From `src/testing/`: up to the package root, then into `test/`. */
const FIXTURE_DIR = fileURLToPath(new URL('../../test/fixtures/eapi.conf', import.meta.url))

/** One fixture's text, by file name. */
export function confFixture(name: string): string {
  return readFileSync(`${FIXTURE_DIR}/${name}`, 'utf8')
}

/** Every fixture in the directory, sorted — the set a manifest test must match exactly. */
export function listedConfFixtures(extension = '.conf'): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((entry) => entry.endsWith(extension))
    .sort()
}

/** The fixtures as an in-memory directory, keyed by their absolute path. */
export function confFixtureDirectory(names: readonly string[], directory = FIXTURE_DIR): Record<string, string> {
  const files: Record<string, string> = {}
  for (const name of names) files[`${directory}/${name}`] = confFixture(name)
  return files
}

/** The fixture directory's absolute path, for tests that build their own candidate list. */
export function confFixturePath(name: string): string {
  return `${FIXTURE_DIR}/${name}`
}
