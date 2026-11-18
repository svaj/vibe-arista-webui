/**
 * The connect screen's host book (#140a): a small localStorage list of *which devices this browser
 * has connected to*, implementing exactly the remember-scope issue #140 asked for — "a
 * session/cookie remembers a **user and host**". A password is never one of those fields: the
 * entry type has no such key, writes are built by copying whitelisted fields, and a load strips
 * anything extra a hand-edited or legacy blob might carry. The value never reaches the wire —
 * the browser only ever sends credentials to the same-origin relay body.
 *
 * Storage itself is an explicit parameter (the `StorageLike` seam below): screens can render
 * without a working localStorage (private mode throws on write), and tests can pin persistence
 * behavior with a Map instead of jsdom globals. Corrupt JSON is not an error state — it answers
 * "empty book", the same absence posture the load-state union uses for empties.
 */

export interface HostbookEntry {
  /** Operator's label ("Office switch"); falls back to the host when left blank. */
  readonly name: string
  /** The exact validated host[:port] string stored at connect time. */
  readonly host: string
  readonly username: string
  /** `Date.now()` at last successful connect — the list orders by this, newest first. */
  readonly addedAt: number
}

export type HostbookStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** Sole storage key; the `.v1` suffix is the migration hook if the shape ever changes. */
export const HOSTBOOK_KEY = 'arista-webui.connect.hostbook.v1'

const isEntry = (value: unknown): value is HostbookEntry => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record['host'] === 'string' && record['host'] !== ''
    && typeof record['username'] === 'string' && record['username'] !== ''
    && typeof record['name'] === 'string'
    && typeof record['addedAt'] === 'number' && Number.isFinite(record['addedAt'])
}

/** Copy of the whitelist fields ONLY — unknown keys (an accidental `password`) cannot ride along. */
const project = (entry: HostbookEntry): HostbookEntry => ({
  name: entry.name,
  host: entry.host,
  username: entry.username,
  addedAt: entry.addedAt,
})

/** Reads the book; anything unparseable or malformed answers as if absent (never throws). */
export function loadHostbook(storage: HostbookStorage): readonly HostbookEntry[] {
  try {
    const raw = storage.getItem(HOSTBOOK_KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isEntry).map(project).sort((a, b) => b.addedAt - a.addedAt)
  } catch {
    return []
  }
}

function saveHostbook(storage: HostbookStorage, entries: readonly HostbookEntry[]): void {
  try {
    if (entries.length === 0) storage.removeItem(HOSTBOOK_KEY)
    else storage.setItem(HOSTBOOK_KEY, JSON.stringify(entries.map(project)))
  } catch {
    // Quota/private-mode: the connect itself already succeeded; a lost book must never mask that.
  }
}

/**
 * Record a successful connect: upsert by `host + username` (re-connecting refreshes recency and
 * the label when one is given), capped so the list stays a list, not a ledger.
 */
export function upsertHostbookEntry(
  storage: HostbookStorage,
  entry: { host: string; username: string; name?: string },
  now: number = Date.now(),
): readonly HostbookEntry[] {
  const label = entry.name !== undefined && entry.name.trim() !== '' ? entry.name.trim() : entry.host
  const rest = loadHostbook(storage).filter((candidate) => !(candidate.host === entry.host && candidate.username === entry.username))
  const next: HostbookEntry[] = [{ name: label, host: entry.host, username: entry.username, addedAt: now }, ...rest].slice(0, 12)
  saveHostbook(storage, next)
  return next
}

/** Forget one device from the book (this browser only — it disconnects nothing on the relay). */
export function forgetHostbookEntry(storage: HostbookStorage, host: string, username: string): readonly HostbookEntry[] {
  const next = loadHostbook(storage).filter((candidate) => !(candidate.host === host && candidate.username === username))
  saveHostbook(storage, next)
  return next
}
