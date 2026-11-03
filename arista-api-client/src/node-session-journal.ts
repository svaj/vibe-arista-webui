/**
 * The on-disk config-session journal — M5 (#7), DR-022/DR-023's recovery record, and the reason a
 * crashed CLI or a killed script does not leave a pending session holding the switch's config lock
 * forever (which is what answers the *next* client with **1006**, `CliCommon.py:33`).
 *
 * **Node only.** This module is reachable exclusively through `@devhax-heavy-industries/arista-eapi/node`
 * (DR-002): `src/index.ts` never imports it, `src/browser-safety.test.ts` asserts its absence from the
 * browser module graph, and the Vite build guard (`vite.config.ts`) fails the build if the browser
 * bundle ever references `node:fs`. A browser gets
 * `createWebStorageJournal(window.localStorage)` from the core entry instead (PLAN §M5:
 * "Node: `~/.config/arista-eapi/sessions.json`; browser: `localStorage`").
 *
 * The path is XDG-aware and defaults to exactly the file PLAN §M5 names:
 * `$XDG_CONFIG_HOME/arista-eapi/sessions.json`, else `~/.config/arista-eapi/sessions.json`.
 *
 * Secrets: {@link SessionJournalEntry} has no field that could hold a password, and
 * {@link FileSessionJournal.record} re-serialises through an allow-list plus a key-name assertion, so a
 * caller arriving from JS with `{ enablePassword: 's3cret' }` inside its entry cannot reach the file.
 * DR-011's rule ("never log a secret") applies to a recovery file more than anywhere else, because this
 * one is written to a home directory that is often backed up.
 *
 * Concurrency: read-modify-write, last writer wins. Two processes recording the same second can drop a
 * record; {@link Node.recoverOrphans} does not depend on the journal for *correctness* — the device's
 * `show configuration sessions` is authoritative (DR-023) — it depends on it only for the name and the
 * age, which the model has no field for (`CliPlugin/ConfigSessionModel.py:21-34`).
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { SessionJournal, SessionJournalEntry } from './config-session'

/** Directory name under the config home. */
export const SESSION_JOURNAL_DIR_NAME = 'arista-eapi'
/** File name inside it (PLAN §M5 fixes the spelling). */
export const SESSION_JOURNAL_FILE_NAME = 'sessions.json'

/**
 * Everything that may appear as a key in a journal record. Any extra key is refused at write time:
 * the point is not to filter secrets after the fact, it is to make it impossible for a caller's option
 * bag to be persisted by accident.
 */
const JOURNAL_KEYS: readonly (keyof SessionJournalEntry)[] = ['name', 'endpoint', 'startedAt', 'pid', 'description']

/** Inputs a journal path can be computed from — injectable so tests never touch a real home directory. */
export interface SessionJournalPathOptions {
  /** Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  /** Defaults to `node:os`'s `homedir()`. */
  readonly homeDir?: string | undefined
}

/**
 * Where the journal lives. Resolved per call (not cached) so a test can point it at a temp directory
 * without rewriting module state, and so a `$XDG_CONFIG_HOME` change is honoured the way XDG says it is.
 */
export function sessionJournalPath(options: SessionJournalPathOptions = {}): string {
  const env = options.env ?? (globalThis.process?.env ?? {})
  const home = options.homeDir ?? homedir()
  const configHome = env['XDG_CONFIG_HOME']
  const base = configHome === undefined || configHome === '' ? join(home, '.config') : configHome
  return join(base, SESSION_JOURNAL_DIR_NAME, SESSION_JOURNAL_FILE_NAME)
}

/** The default journal path, computed once for consumers that just want the location (DR-022). */
export const SESSION_JOURNAL_PATH = sessionJournalPath()

/** Keys that would make a journal file a secret-bearing file. Kept separate from {@link JOURNAL_KEYS} so the refusal message can name the offender. */
const SECRET_KEY = /^(enable_?password|enablepwd|password|secret|passkey|token|cookie)$/iu

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Pick only the allow-listed keys, with the types checked — the writer's single choke point (DR-011). */
function toRecord(entry: unknown): SessionJournalEntry {
  const source = (entry ?? {}) as Record<string, unknown>
  for (const key of Object.keys(source)) {
    if (SECRET_KEY.test(key)) {
      throw new TypeError(`refusing to write the journal key ${JSON.stringify(key)}: a recovery journal must never contain a password (DR-011)`)
    }
  }
  const name = source['name']
  const endpoint = source['endpoint']
  const startedAt = source['startedAt']
  if (typeof name !== 'string' || name === '') throw new TypeError('a journal entry needs a non-empty string `name`')
  if (typeof endpoint !== 'string') throw new TypeError('a journal entry needs a string `endpoint`')
  if (typeof startedAt !== 'string') throw new TypeError('a journal entry needs a string `startedAt`')
  const pid = source['pid']
  const description = source['description']
  const record: SessionJournalEntry = {
    name,
    endpoint,
    startedAt,
    ...(typeof pid === 'number' && Number.isInteger(pid) ? { pid } : {}),
    ...(typeof description === 'string' && description !== '' ? { description } : {}),
  }
  const extra = Object.keys(record).filter((key) => !(JOURNAL_KEYS as readonly string[]).includes(key))
  if (extra.length > 0) throw new TypeError(`journal record carries unexpected keys: ${extra.join(', ')}`)
  return record
}

/**
 * A {@link SessionJournal} backed by one small JSON array file.
 *
 * Writes go through a temp file plus an atomic rename, because a journal truncated by a crash in the
 * middle of a write is worse than no journal: it would hide the name of the very session that is holding
 * the config lock. (A corrupt file still reads as empty rather than throwing in a recovery path —
 * recovery should never be blocked by its own bookkeeping.)
 */
export class FileSessionJournal implements SessionJournal {
  /** Where this instance reads and writes. */
  readonly path: string

  constructor(path: string = SESSION_JOURNAL_PATH) {
    this.path = path
  }

  toString(): string {
    return `FileSessionJournal(${this.path})`
  }

  async read(): Promise<readonly SessionJournalEntry[]> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return []
      throw error
    }
    if (text.trim() === '') return []
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return []
    }
    if (!Array.isArray(parsed)) return []
    // A record that fails validation is skipped, not fatal: recovery must not be blocked by its own
    // bookkeeping (a hand-edited or partially written entry should not stop an operator clearing a lock).
    const entries: SessionJournalEntry[] = []
    for (const candidate of parsed) {
      if (!isRecord(candidate)) continue
      try {
        entries.push(toRecord(candidate))
      } catch {
        // skipped — the device's `show configuration sessions` remains the authority (DR-023)
      }
    }
    return entries
  }

  async record(entry: SessionJournalEntry): Promise<void> {
    const record = toRecord(entry)
    const others = (await this.read()).filter((candidate) => candidate.name !== record.name)
    await this.writeEntries([...others, record])
  }

  async forget(name: string): Promise<void> {
    const all = await this.read()
    const others = all.filter((entry) => entry.name !== name)
    if (others.length === all.length) return
    await this.writeEntries(others)
  }

  /** Remove entries for endpoints that no longer matter — a small hygiene verb for long-lived profiles. */
  async prune(endpoint: string): Promise<number> {
    const all = await this.read()
    const kept = all.filter((entry) => entry.endpoint !== endpoint)
    await this.writeEntries(kept)
    return all.length - kept.length
  }

  private async writeEntries(entries: readonly SessionJournalEntry[]): Promise<void> {
    const records = entries.map((entry) => toRecord(entry))
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temp = `${this.path}.${String(process.pid)}.tmp`
    // 0o600: one operator's switch inventory, including the endpoints they manage. Not a world-readable file.
    await writeFile(temp, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 })
    await rename(temp, this.path)
  }
}

/** Convenience for the `./node` entry: the default journal, at the documented path. */
export function defaultSessionJournal(path?: string): FileSessionJournal {
  return new FileSessionJournal(path)
}
