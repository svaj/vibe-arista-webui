/**
 * `runGuardedLiveWriteSession` — the write-side half of DR-035, closed by M12a (#14).
 *
 * DR-035 (`docs/DECISIONS.md`, and the target-class/evidence rules it now carries as DR-043) says a live
 * lane may mutate a device only **deliberately**: inside a *named* config session, rolled back if the
 * write did not fully land, and **never** persisted to startup-config. `src/testing/live-guard.ts` already
 * gates *which* endpoint and *which* scratch interface a live run may touch; this module gates *how a write
 * is applied* once that gate has been passed. DR-035(c) forbids `copy running-config startup-config` in
 * the live lane (the container recipe reboots fresh instead — `docs/CEOS.md:83-84`), and this helper is the
 * point where that ban is *mechanical* rather than a comment: every batch is passed through
 * {@link assertNoPersistenceCommand} before the session is even opened.
 *
 * ## What the helper guarantees
 * 1. **Named session, never anonymous.** `name` is required. pyeapi's `configure_session()` lazily makes a
 *    bare `uuid4` (`client.py:1003-1006`) that no operator could name on the CLI; DR-022/DR-047 make our
 *    sessions addressable, and a live test that cannot name its session cannot find it in
 *    `node.listSessions()` after a crash. (Requiring the name here also makes both
 *    `run`/`commit`/`abort` wire shapes deterministic enough to script offline — see the unit tests.)
 * 2. **Commit on success, abort on failure — abort is in a `finally`.** A session that is left open holds
 *    the config lock and consumes `service configuration session max pending`, which is how the *next*
 *    client's write comes back `1006` (DR-023). The cleanup is therefore unconditional: if the batch or the
 *    commit threw and the handle is still live, {@link ConfigSession#abort} runs before the original error
 *    propagates. After a successful `commit()` the handle is no longer `isOpen`, so the `finally` correctly
 *    does nothing rather than re-issuing `configure session <name> abort` against a session EOS destroyed
 *    (`SessionCli.py:245-247` would *re-create* it — that is MIGRATION.md §5 row 63's bug, which the state
 *    machine refuses and this helper also avoids by construction).
 * 3. **Never persists.** It calls `commit()` with **no** `{ persist: true }` ({@link SessionCommitOptions},
 *    DR-024) and refuses a batch that itself contains `copy run[ning-config] star[tup-config]`
 *    ({@link assertNoPersistenceCommand}) before touching the device.
 *
 * Every device-facing verb it uses (`configSession`, `run`, `commit`, `abort`) is `async`, so a state-machine
 * refusal (a dead handle) or a device `CommandError` arrives as a rejection on the one promise this helper
 * returns — never as a synchronous throw that would walk past a caller's `.catch` (the hazard spelled out
 * at `config-session.ts`'s `run`).
 *
 * Browser-safe (DR-002): it imports no `node:*` module — only the browser-safe command layer and the guard.
 * It is not reachable from `src/index.ts` either; `src/testing/**` is a test seam.
 */

import { NotSupportedError } from '../errors'
import { assertNoPersistenceCommand } from './live-guard'
import type { Node } from '../command-layer'
import type { CommandResult, CommandSpec } from '../types/eapi'

/** One guarded live write. */
export interface LiveWriteSessionOptions {
  /**
   * The config-session name (DR-022/DR-047). Required, not defaulted: the whole point of the live lane
   * being auditable is that a session an operator sees in `show configuration sessions` is one this test
   * named, so it can be aborted by hand if the harness dies between the batch and the `finally`.
   */
  readonly name: string
  /**
   * The commands to stage, in apply order — the mutation this helper is responsible for.
   *
   * Passed as **data** rather than an open-ended callback precisely so {@link assertNoPersistenceCommand}
   * can inspect every command before anything reaches the wire: a callback that decided
   * `session.run([...])` at runtime could smuggle a `copy run start` past a name-only policy. A live test
   * builds this list from a scratch-interface name it already cleared through
   * {@link requireScratchInterface}, so `interface <scratch>` plus its field commands are the expected
   * contents — and the config-session opener (`configure session <name>`) is supplied by the session
   * itself, never included here.
   */
  readonly commands: readonly CommandSpec[]
  /** Optional `description "<text>"` on the opener — how a run labels its scratch sessions. */
  readonly description?: string | undefined
}

/** What a guarded write reports back: the handle name plus the device replies to the staged commands. */
export interface LiveWriteSessionOutcome {
  /** The session name, so a caller can assert it survived (`node.listSessions()` after a forced failure). */
  readonly sessionName: string
  /**
   * The device replies to `options.commands`, opener and `enable` replies already popped by
   * {@link ConfigSession#run} (`config-session.ts`, pyeapi `client.py:693` parity). The `commit` reply is
   * not included — a successful commit is reported by the promise resolving, not by a value to inspect.
   */
  readonly results: readonly CommandResult[]
  /** `true` when the batch committed; the only value on the success path (a commit that did not happen is a throw). */
  readonly committed: true
}

/**
 * Run one live write in a named config session with DR-035's guarantees (named / always-abort-on-failure /
 * never-persist). Throws before any request lands when the batch contains a persistence command.
 *
 * @throws {NotSupportedError} `commands` contains `copy running-config startup-config` (DR-035(c)), or the
 *   session name is unacceptable — the latter surfaces from `node.configSession()`'s own name guard.
 * @throws whatever the device returns (`CommandError`) or the transport raises; the session is aborted
 *   first when the handle is still live, so an aborted-on-failure batch never leaves the config lock held.
 */
export async function runGuardedLiveWriteSession(node: Node, options: LiveWriteSessionOptions): Promise<LiveWriteSessionOutcome> {
  const { name, commands, description } = options

  // Ban the persistence command BEFORE opening anything: a live lane that would boot a fresh container
  // instead of saving (`docs/CEOS.md:83-84`) must not send `copy run start` even once. `assertNoPersistenceCommand`
  // is the guard's own check (DR-035(c)); a refusal is turned into the package's input-error type, not a
  // new error class (DR-005/DR-010).
  const persistence = assertNoPersistenceCommand(commands)
  if (persistence !== undefined) {
    throw new NotSupportedError(`live write refuses to run: ${persistence.reason}`, { cause: commands })
  }

  // A named session is opened lazily — no request yet — so this await only runs the name guard and the
  // (optional) journal write. The device-side session is created by the first batch's opener.
  const session = await node.configSession({
    name,
    ...(description === undefined ? {} : { description }),
  })

  let committed = false
  try {
    const results = await session.run(commands)
    // No `{ persist: true }` — DR-024 keeps durability an explicit, separate decision, and DR-035(c)
    // forbids it in the live lane outright, so committing here changes running-config only.
    await session.commit()
    committed = true
    return { sessionName: session.name, results, committed: true }
  } finally {
    // The rollback. Only while the handle is still live: after a successful `commit()` the session is
    // terminal (`committed`), and `abort()` on it would be a state-machine throw that masks the real
    // outcome — and after a failure that killed the handle (`lost`) there is nothing on the wire to abort.
    // `session.isOpen` is exactly "open" or "diffed", so this aborts a batch that partially applied or a
    // commit that the device refused, and no-ops on the success path and on already-dead handles.
    // On the success path this can only be reached if `commit()` threw after setting nothing; `committed`
    // records whether the promise resolved, so the finally never aborts a session we just committed.
    if (!committed && session.isOpen) {
      await session.abort()
    }
  }
}
