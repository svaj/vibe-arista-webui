/**
 * `eapi.conf` on disk — M3 (#5), the **Node-only** half of DR-038/DR-044.
 *
 * This is the only place in the package that reaches `node:fs`, `os.homedir()` or `process.env` for
 * profiles, and it is reachable only from `@devhax-heavy-industries/arista-eapi/node`
 * (enforced by `src/browser-safety.test.ts` and by the Vite build guard in `vite.config.ts`, DR-002).
 * The decisions themselves — search order, `$EAPI_CONF`, `~`, the implicit `localhost` toggle — live in
 * `src/internal/eapi-conf.ts`, which never touches a disk; the file *format* lives in
 * `src/profiles.ts`, which never decides where a file is.
 *
 * pyeapi reads these files through a module-global `Config()` built at import time
 * (`client.py:318`), which is a side effect a bundled browser app cannot have and a hidden default a
 * UI must not inherit (DR-038). Here nothing is read until a caller asks, and a test can hand the
 * search a `ConfFileSystem` of its own instead of a real home directory.
 *
 * Credential discipline (DR-011): the file's text never enters a log line or an error message. The
 * issues `loadEapiConf` reports name profiles, keys and line numbers only; a value cannot be printed
 * by accident because this module does the printing and does not take the text anywhere else.
 */

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'

import { resolveEapiConf, type ConfFileSystem, type LoadedEapiConf } from './internal/eapi-conf'
import type { ProfileIssue, ProfileStore } from './profiles'

/** pyeapi's search order and env var, re-exported for a Node CLI's `--help` text (`client.py:112`, `:171-172`). */
export { CONFIG_SEARCH_PATH, EAPI_CONF_ENV_VAR, expandHome, eapiConfSearchPath } from './internal/eapi-conf'
export type { ConfFileSystem, EapiConfCandidate, LoadedEapiConf, LoadEapiConfOptions } from './internal/eapi-conf'

/**
 * The default filesystem for {@link loadEapiConf}. A candidate that is a directory or unreadable
 * reports itself instead of being skipped silently, because `resolveEapiConf` continues the search
 * (pyeapi's `os.path.exists` + configparser's swallowed error leave an operator with a config that
 * was never read — `client.py:178-183`; MIGRATION.md §5 row 54).
 */
export const nodeConfFileSystem: ConfFileSystem = {
  exists(path: string): boolean {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  },
  readText(path: string): string {
    return readFileSync(path, 'utf8')
  },
  homeDirectory(): string | undefined {
    try {
      // `os.homedir()` in a container without a passwd entry yields '' rather than throwing, so an
      // empty string means "no `~` to expand into" (`client.py:179`'s `expanduser` has no answer for
      // that case either).
      const home = homedir()
      return home === '' ? undefined : home
    } catch {
      return undefined
    }
  },
}

/** {@link loadEapiConf}'s options: the loader's seams, with Node defaults supplied for the ones a CLI omits. */
export interface NodeLoadEapiConfOptions {
  /** Filesystem seam; defaults to {@link nodeConfFileSystem}. Tests inject their own, and touch no disk. */
  readonly fs?: ConfFileSystem | undefined
  /** Environment seam; defaults to `process.env`. Only `EAPI_CONF` is read (`client.py:171-172`). */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  /** Replace the search path instead of reading an environment variable — for a CLI flag or a test. */
  readonly paths?: readonly string[] | undefined
  /** One specific file, as pyeapi's `Config(filename)`/`load_config(filename)` would use (`client.py:235-245`). */
  readonly filename?: string | undefined
  /** Put the profiles into an existing store instead of a fresh one — pyeapi's per-file `read()` merge. */
  readonly store?: ProfileStore | undefined
  /**
   * Add pyeapi's implicit `[connection:localhost] transport = socket` (`client.py:214-221`).
   * Default **`true`**, which is DR-008's Node half of the split: the profile exists, and building a
   * transport out of it still requires `allowLocalUnauthenticated` (DR-014). Pass `false` to keep a
   * host's config strictly to what its file says.
   */
  readonly implicitLocalhost?: boolean | undefined
  /**
   * Keep pyeapi's host defaulting (`client.py:207-211`), on by default. See
   * {@link ParseEapiConfOptions.applyHostDefault}.
   */
  readonly applyHostDefault?: boolean | undefined
  /** Show the file's problems on `console.warn` — once each, secret-free (DR-011). Default `false`. */
  readonly warn?: boolean | undefined
}

/**
 * Read the first `eapi.conf` in pyeapi's order — `$EAPI_CONF`, then an explicit `filename`, then
 * `~/.eapi.conf`, then `/mnt/flash/eapi.conf` (`client.py:112`, `:158-184`) — and return the profiles
 * it holds, plus what was wrong with it.
 *
 * A missing file is not an error: pyeapi returns an empty config plus the implicit localhost profile
 * (`client.py:184`), and a switched-on warning is the only output. The returned `searched` list records
 * every candidate it looked at, so a CLI can tell an operator which files were tried when a profile
 * turns out to be missing.
 */
export function loadEapiConf(options: NodeLoadEapiConfOptions = {}): LoadedEapiConf {
  const issues: ProfileIssue[] = []
  const warned = new Set<string>()
  const onIssue = (issue: ProfileIssue): void => {
    issues.push(issue)
    if (options.warn !== true) return
    const dedupe = `${issue.profile}|${issue.key ?? ''}|${issue.line ?? 0}|${issue.kind}`
    if (warned.has(dedupe)) return
    warned.add(dedupe)
    console.warn(`[arista-eapi] ${issue.message}`)
  }

  const loaded = resolveEapiConf({
    fs: options.fs ?? nodeConfFileSystem,
    ...(options.env === undefined ? { env: process.env as Readonly<Record<string, string | undefined>> } : { env: options.env }),
    ...(options.paths === undefined ? {} : { paths: options.paths }),
    ...(options.filename === undefined ? {} : { filename: options.filename }),
    ...(options.store === undefined ? {} : { store: options.store }),
    ...(options.implicitLocalhost === undefined ? { implicitLocalhost: true } : { implicitLocalhost: options.implicitLocalhost }),
    ...(options.applyHostDefault === undefined ? {} : { applyHostDefault: options.applyHostDefault }),
    onIssue,
  })
  return loaded
}
