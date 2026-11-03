/**
 * How an `eapi.conf` is **found** — M3 (#5), the runtime-agnostic half of DR-038/DR-044.
 *
 * pyeapi decides this in `Config.autoload` (`client.py:158-184`): `$EAPI_CONF` first
 * (`client.py:171-172`), else the instance's own filename, else `CONFIG_SEARCH_PATH`
 * (`client.py:112`), with `~` expanded (`client.py:179`), and the first existing file wins. When
 * nothing exists it injects the implicit `connection:localhost` profile instead
 * (`client.py:184`, `:214-221`).
 *
 * This module contains that decision and nothing else, and it takes the filesystem as an argument,
 * which is what lets the unit tests assert search order, `$EAPI_CONF` precedence and the missing-file
 * path **without touching a disk** — and what keeps the module browser-safe (DR-002), so the same code
 * answers for a browser app that has no files at all. The Node binding — the only place a real
 * `node:fs`, a real `process.env` or a real home directory appears — is `src/node-profiles.ts`.
 *
 * Two verified pyeapi behaviours are **not** reproduced, both in the operator's favour (row 54):
 *  - `os.path.exists` is true for a **directory**, so pyeapi picks the directory as its config file,
 *    `configparser` swallows the resulting error, and the operator is left with only the implicit
 *    localhost profile and a `filename` pointing at something that was never read. Here a candidate
 *    that cannot be read is skipped and the search continues, with a logged warning.
 *  - `os.environ['EAPI_CONF']` may hold several paths in pyeapi's own tests (it is passed through
 *    `make_iterable`), but the real search path is a plain list of strings here.
 */

import { warnOnce } from './warn'
import { ProfileStore } from '../profiles'
import {
  DEFAULT_LOCAL_CONNECTION_NAME,
  parseEapiConf,
  type ConnectionProfile,
  type ParseEapiConfOptions,
  type ParsedEapiConf,
  type ProfileFields,
  type ProfileIssue,
} from '../profiles'

/** pyeapi `CONFIG_SEARCH_PATH` (`client.py:112`), kept in the same order. */
export const CONFIG_SEARCH_PATH: readonly string[] = ['~/.eapi.conf', '/mnt/flash/eapi.conf']

/** pyeapi's override variable name (`client.py:171-172`). */
export const EAPI_CONF_ENV_VAR = 'EAPI_CONF'

/** The filesystem an `eapi.conf` search needs. Everything else is a string decision. */
export interface ConfFileSystem {
  /** Should be `false` for a directory: pyeapi's `os.path.exists` is not, and that is a bug (row 54). */
  exists(path: string): boolean
  /** Returns the file's text. May throw — the caller treats a throw as "not a usable config". */
  readText(path: string): string
  /** Directory `~` expands to. `undefined` means "no home", so a `~/…` candidate is skipped. */
  homeDirectory(): string | undefined
}

export interface LoadEapiConfOptions extends ParseEapiConfOptions {
  /** Filesystem access. Required here: this module never reaches a real disk by itself. */
  readonly fs: ConfFileSystem
  /** Environment, normally `process.env`. `EAPI_CONF` overrides the search path (`client.py:171-172`). */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  /** Overrides {@link CONFIG_SEARCH_PATH} — the test seam, and a CLI's `--config` flag. */
  readonly paths?: readonly string[] | undefined
  /** A config chosen by the caller: a CLI flag, an embedded default. pyeapi's `Config(filename)` (`client.py:173-174`). */
  readonly filename?: string | undefined
  /**
   * Add pyeapi's implicit `[connection:localhost] transport = socket` when the file does not define
   * `localhost` (`client.py:205`, and `:184` when no file was found at all).
   *
   * **Node only, by DR-008** — and even then the resulting profile cannot become a transport until the
   * caller states `allowLocalUnauthenticated` (DR-014), because that listener is unauthenticated
   * priv-15 on 4.28. A browser app passes `false` (row 55).
   */
  readonly implicitLocalhost?: boolean | undefined
  /** Where to put what was found. Lets a caller merge several files, as `Config.read` does per file. */
  readonly store?: ProfileStore | undefined
  /** Called once per problem found in the file(s). Never receives a credential **value** (DR-011). */
  readonly onIssue?: (issue: ProfileIssue) => void
}

/** What a single candidate resolved to. */
export interface EapiConfCandidate {
  readonly path: string
  /** Why this candidate was not used: missing, unreadable, or a directory (`client.py:178-183`). */
  readonly skipped?: string | undefined
  readonly issues?: readonly ProfileIssue[] | undefined
}

export interface LoadedEapiConf {
  /** The store that was filled — the caller's `store` when one was supplied. */
  readonly store: ProfileStore
  /** The file that was read, after `~` expansion. `undefined` when no candidate produced a file. */
  readonly filename: string | undefined
  /** Every expansion attempt in search order, including the ones that were skipped: the audit trail. */
  readonly searched: readonly EapiConfCandidate[]
  /** Profiles read from the file(s), in file order — pyeapi's `config.sections()`. */
  readonly profiles: readonly ConnectionProfile[]
  /** Structure/key problems found while reading, including what {@link onIssue} saw. */
  readonly issues: readonly ProfileIssue[]
  /** Section names that were not `[connection:<name>]`, and the `[DEFAULT]` fields, when present. */
  readonly otherSections: readonly string[]
  readonly defaults?: ProfileFields | undefined
}

/** One path with `~` expanded, the way `os.path.expanduser` does for `~` and `~/…` (`client.py:179`). */
export function expandHome(path: string, homeDirectory: string | undefined): string {
  if (path === '~') return homeDirectory ?? path
  if (path.startsWith('~/')) {
    if (homeDirectory === undefined) return path
    const rest = path.slice(2)
    return homeDirectory.endsWith('/') ? `${homeDirectory}${rest}` : `${homeDirectory}/${rest}`
  }
  return path
}

/**
 * The search order pyeapi's `autoload` implements (`client.py:158-184`), as data, so a caller can log
 * or assert it instead of discovering it from an error message.
 *
 * Precedence, verified by reading the function: `$EAPI_CONF` **wins over an explicitly configured
 * filename**, which is why upstream's `test_load_config_for_connection_with_env` still reads the env
 * file after calling `load_config(random_string())`.
 */
export function eapiConfSearchPath(
  options: { env?: Readonly<Record<string, string | undefined>> | undefined; paths?: readonly string[] | undefined; filename?: string | undefined } = {},
): string[] {
  const fromEnv = options.env?.[EAPI_CONF_ENV_VAR]
  if (fromEnv !== undefined && fromEnv.trim() !== '') return [fromEnv.trim()]
  if (options.filename !== undefined && options.filename.trim() !== '') return [options.filename.trim()]
  return [...(options.paths ?? CONFIG_SEARCH_PATH)]
}

/**
 * Find and read the first usable `eapi.conf`. Tolerant by design, exactly like pyeapi's
 * `Config.read` — which catches configparser errors, logs one line, and carries on
 * (`client.py:198-203`) — and louder where pyeapi is quiet (a directory or an unreadable file is
 * reported and skipped rather than silently accepted, row 54).
 *
 * Nothing is ever logged except through `onIssue` and {@link warnOnce}, and an issue text never
 * contains a credential value (DR-011): the parser names profiles, keys and lines only.
 */
export function resolveEapiConf(options: LoadEapiConfOptions): LoadedEapiConf {
  const { fs, env, paths, filename, store: providedStore } = options
  const store = providedStore ?? new ProfileStore()
  const home = fs.homeDirectory()
  const candidates = eapiConfSearchPath({ ...(env === undefined ? {} : { env }), ...(paths === undefined ? {} : { paths }), ...(filename === undefined ? {} : { filename }) })
    .map((path) => ({ authored: path, expanded: expandHome(path, home) }))

  const searched: EapiConfCandidate[] = []
  const issues: ProfileIssue[] = []
  let profiles: readonly ConnectionProfile[] = []
  let otherSections: readonly string[] = []
  let defaults: LoadedEapiConf['defaults']
  let chosen: string | undefined

  for (const candidate of candidates) {
    if (candidate.expanded.startsWith('~/')) {
      // No home directory to expand into: the candidate can never resolve (pyeapi's `expanduser`
      // leaves `~/…` alone, so `os.path.exists` is false and the loop moves on).
      searched.push({ path: candidate.expanded, skipped: 'no home directory is available to expand ~' })
      continue
    }
    if (!fs.exists(candidate.expanded)) {
      searched.push({ path: candidate.expanded, skipped: 'not present' })
      continue
    }
    let text: string
    try {
      text = fs.readText(candidate.expanded)
    } catch (error) {
      // pyeapi accepts this candidate because `os.path.exists` is true for a directory or an
      // unreadable file, then loses the error inside configparser and silently ends up with only
      // `localhost`. Continuing the search, with a warning, is the honest version (row 54).
      const reason = error instanceof Error ? error.message : String(error)
      searched.push({ path: candidate.expanded, skipped: `could not be read: ${reason}` })
      warnOnce(
        `eapi-conf-unreadable:${candidate.expanded}`,
        `the eapi.conf candidate ${JSON.stringify(candidate.expanded)} exists but could not be read (${reason}); continuing the search. No credential is ever printed here (DR-011)`,
      )
      continue
    }

    const parsed: ParsedEapiConf = parseEapiConf(text, {
      ...(options.applyHostDefault === undefined ? {} : { applyHostDefault: options.applyHostDefault }),
    })
    for (const profile of parsed.profiles) store.add(profile)
    chosen = candidate.expanded
    profiles = parsed.profiles
    otherSections = parsed.otherSections
    issues.push(...parsed.issues)
    searched.push({ path: candidate.expanded, issues: parsed.issues })
    if (parsed.defaults !== undefined) defaults = parsed.defaults
    break
  }

  if (options.implicitLocalhost ?? false) {
    // pyeapi `_add_default_connection` (`client.py:214-221`) — see DR-008/DR-014 and row 55: it exists
    // here so an on-switch `[connection:localhost]` entry keeps working, and it is inert until the
    // caller states the risk, because `profileToTransportOptions` refuses it without the opt-in.
    if (!store.has(DEFAULT_LOCAL_CONNECTION_NAME)) store.addDefaultLocalConnection()
  }

  for (const issue of issues) options.onIssue?.(issue)

  return {
    store,
    // Assigned unconditionally: `LoadedEapiConf['filename']` is a **required** property whose value may
    // be `undefined` (exactOptionalPropertyTypes), so the `{ ...(x === undefined ? {} : { x }) }`
    // idiom used for the genuinely-optional members does not typecheck here (TS2322), and a caller
    // asserting "no file was read" should have to read a `filename`, not probe for a missing key.
    filename: chosen,
    searched,
    profiles,
    issues,
    otherSections,
    ...(defaults === undefined ? {} : { defaults }),
  }
}
