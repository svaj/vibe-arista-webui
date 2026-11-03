/**
 * Config sessions & change safety — M5 (#7).
 *
 * pyeapi's session support is four small methods on `Node` and one private helper
 * (`pyeapi/client.py`, BSD-3-Clause, Arista Networks — DR-001). Every line below was read in the
 * upstream tree at `develop` `6816d9e`; the refs are as verified there:
 *
 * | pyeapi | what it does | here |
 * |---|---|---|
 * | `client.py:676-693` `_configure_session` | refuses with `CommandError(-1, 'Not currently in a session')` (`:680-681`), puts `configure session <name>` at `cmds[0]` (`:687`), clears the chunkify cache (`:690`), pops the prepended reply (`:693`) | {@link ConfigSession#run}, with `SessionError` replacing the invented `-1` code (row 58) and no cache to clear (DR-026) |
 * | `client.py:1003-1006` `configure_session` | `self._session_name = self._session_name or uuid4()` — **no command is sent**; the name exists only in the client | {@link ConfigSession} is also lazy, but the name is prefixed, host-scoped and journaled (DR-022/DR-047, row 54) |
 * | `client.py:1008-1016` `diff` | `_configure_session(['show session-config diffs'], encoding='text')` (`:1013-1014`) and `response[0]['output']` | {@link ConfigSession#diff} — same commands, and the same `format:'text'` choice, now *stated in the option* rather than smuggled through `**kwargs` (DR-012, row 57) |
 * | `client.py:1018-1021` `commit` | `_configure_and_exit_session(['commit'])` | {@link ConfigSession#commit} (row 61) |
 * | `client.py:1023-1026` `abort` | `_configure_session(['abort'])` — and **leaves `_session_name` set**, so a later call re-enters a session the device has already destroyed | {@link ConfigSession#abort} ends the state machine (row 56) |
 * | `client.py:635-636` `config` | `cfg_call = self._configure_session if self._session_name else self._configure_terminal` — terminal writes are silently rerouted into the open session | `Node.configure()` **throws** `SessionError` (DR-025, row 55) |
 * | `client.py:1028-1035` `_configure_and_exit_session` | refresh when `autorefresh`, then `_session_name = None` | {@link ConfigSession#commit} refreshes; {@link ConfigSession#exit} only detaches (row 56) |
 *
 * There is **no `ConfigSession` class upstream** (`client.py` is 1067 lines and ends after
 * `connect_to`), and **`eapilib.py` has no session code at all**: `grep -rn retry` over the upstream
 * tree returns nothing, and `1006` appears nowhere in pyeapi. The state machine, the 1006 mapping,
 * `listSessions`/`abortSession`/`recoverOrphans`, the journal, `writeMemory`, `configureReplace` and
 * the rollback verbs are this port's, not a translation — MIGRATION.md §1/§2/§5 rows 54-63 record
 * each as new.
 *
 * ## EOS 4.28 grammar this models (read out of the 4.28.14M image, not from a manual)
 *
 *  - `configure session [ <sessionName> ] [ description <description> ]` and the hidden
 *    `configure session <sessionName> no-commit [ description <description> ]`
 *    (`CliPlugin/SessionCli.py:268-282`, `:295-311`) — re-entering an existing name is how EOS
 *    re-attaches (`enterConfigSession`, `:224-267`), which is why **every** batch opens with it.
 *  - `configure session <name> commit [ timer <hh:mm:ss> ]` / in-session `commit [ timer … ]`
 *    (`:316-341`, `:385-404`), `configure session <name> abort` / in-session `abort`
 *    (`:345-372`, `:407-418`), and `rollback clean-config [ { <configGroups> } ]`, which is registered
 *    on `ConfigSessionMode` only (`:445-480`) — i.e. it exists **inside** a session, never in exec mode
 *    (row 63).
 *  - `show session-config …` is model-backed (`cliModel = ShowRunOutputModel.Mode`,
 *    `CliPlugin/ConfigSessionShowCli.py:40-62`, the model line at `:57`), so JSON works;
 *    `show session-config … diffs` declares **no `cliModel`** (`:66-81`), which is exactly why a JSON
 *    request answers `1003 COMMAND_UNCONVERTED` (`CliCommon.py:29`, DR-012) and `diff()` forces
 *    `format:'text'` instead of leaning on the codec's repair.
 *  - `show configuration sessions [ detail ]` **is** model-backed
 *    (`cliModel = ConfigSessionModel.Sessions`, `:84-97`, the model line at `:91`) with the field set of
 *    `CliPlugin/ConfigSessionModel.py:15-40`. That model has **no start time**, which is why
 *    {@link Node.recoverOrphans}'s `olderThan` can only be evaluated against a journal entry (row 63).
 *  - `configure replace SURL [ ignore-errors | force ] [ debug-attribute ] [ md5 MD5 ]
 *    [ skip-checkpoint ]` (`CliPlugin/ConfigSessionCli.py:129-155`); `force` implies `ignore-errors`
 *    in the handler (`:141`) and `md5` is matched by `[0-9a-f]{32}` (`:139`). Its
 *    pending-commit-timer refusal is a *message*: `'Cannot configure replace while session %s is
 *    pending commit timer'` (`:77-79`), so row 62 documents our message-based mapping.
 *  - A config lock raises `ConfigMountProhibitedError.CONFIG_LOCKED` (`SessionCli.py:113-115`,
 *    `ConfigSessionCli.py:52-54`), which the CLI layer reports as **1006** (`CliCommon.py:33`).
 *    pyeapi has no handling for it; {@link ConfigSession} turns it into `SessionError` (DR-023, row 59).
 *
 * ## What is still device-verified only in principle (never asserted here)
 *
 * `commit timer` is implemented by native code below this Python (`CliSession.commitSession`), so
 * whether a second `commit` before the deadline *confirms* the change (as the `COMMIT_TIMER_UPDATED`
 * log at `SessionCli.py:141-145` hints) is unverified: DECISIONS.md open item 5 / STATUS.md §3 stay
 * open, and DR-050 records what we do and do not claim. Name length, description quoting depth and
 * `copy running-config startup-config` on this exact build are the same class of open item.
 *
 * ## State machine (DR-025, DR-048)
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> open: configSession() (no round trip)
 *   open --> open: run/commands/validateChanges
 *   open --> diffed: diff() / showSessionConfig()
 *   diffed --> open: run/commands/validateChanges
 *   open --> committed: commit() / commitWithRevertTimer()
 *   diffed --> committed: commit() / commitWithRevertTimer()
 *   open --> aborted: abort()
 *   diffed --> aborted: abort()
 *   open --> lost: exit(), 1006, opener rejected by the device
 *   diffed --> lost: exit(), 1006, opener rejected by the device
 *   committed --> [*]
 *   aborted --> [*]
 *   lost --> [*]
 * ```
 *
 * `open`/`diffed` differ only in "a diff has been read since the last write", which is what lets a UI
 * ask `hasDiffBeenRead()` before enabling a Commit button. Every other transition is terminal, and a
 * verb called on a dead handle throws `SessionError` **without touching the device** — an operator who
 * commits twice must not get a second `configure session <name>` that re-creates the session EOS just
 * destroyed (`SessionCli.py:245-247` creates one when the name is absent).
 *
 * No `node:*` import lives in this file: it is reachable from the browser entry (DR-002). Only the
 * journal *interface* is declared here, and {@link SessionJournal} is an injected object — the
 * filesystem implementation sits behind `./node` (`src/node-session-journal.ts`), and
 * `src/browser-safety.test.ts` fails if the browser graph ever reaches it.
 */

import { CommandError, EapiErrorCode, NotSupportedError, ProtocolError, SessionError } from './errors'
import { redactCommands } from './internal/redact'
import type { TransportExecOptions } from './transports/contract'
import type { CommandResult, CommandSpec, ErrorDetailEntry, RunCmdsFormat } from './types/eapi'

/**
 * The five states PLAN §M5 fixes for a session handle. `lost` means "this handle can no longer drive
 * the device-side session" — after {@link ConfigSession#exit} (detached, session still pending), after
 * a 1006 config-lock rejection, or after the device rejects the `configure session <name>` opener
 * itself. The journal keeps its entry in all three cases so `recoverOrphans()` can still find it.
 */
export type ConfigSessionState = 'open' | 'diffed' | 'committed' | 'aborted' | 'lost'

/** States a handle can still be used from. Everything else is terminal. */
function isLiveState(state: ConfigSessionState): boolean {
  switch (state) {
    case 'open':
    case 'diffed':
      return true
    case 'committed':
    case 'aborted':
    case 'lost':
      return false
  }
}

/**
 * The runCmds knobs a session call forwards, written without importing `command-layer.ts`: this module
 * sits *below* `Node` in the graph (ARCHITECTURE.md §1), and a runtime import back up into
 * `command-layer.ts` would be the cycle `import/no-cycle` exists to refuse. `Node` satisfies the
 * structural {@link SessionCommandTarget} below, which is the same seam `Transport` is for `Node`.
 */
export interface SessionRequestOptions extends TransportExecOptions {
  /** Prepend `enable` (pyeapi `send_enable`, `client.py:913-917`). Default `true`, DR-009. */
  readonly sendEnable?: boolean | undefined
}

/** What a `ConfigSession` needs from its owner. `Node` implements it; a test can too. */
export interface SessionCommandTarget {
  /** Batched send with `enable` handled and its reply popped — `Node.runCommands` (M4, #6). */
  runCommands(commands: CommandSpec | readonly CommandSpec[], options?: SessionRequestOptions): Promise<readonly CommandResult[]>
  /** Drop cached config text (`Node.refresh`, pyeapi `client.py:991-1001`). */
  refresh(): void
  /** pyeapi `autorefresh` (`client.py:505`): a *committed* write invalidates the cached configs. */
  readonly autorefresh: boolean
  /** The transport address (never contains credentials — `transports/contract.ts`), used to name a session. */
  readonly connection: { readonly address: string }
}

/** Creation options for {@link Node.configSession}. pyeapi has no equivalent: it only makes a `uuid4`. */
export interface ConfigSessionOptions {
  /**
   * Session name. Omit it and the client builds `ui-<host>-p<pid>-<hex8>` (or without the `p<pid>` token
   * where there is no process, i.e. a browser) — DR-022's "named, not anonymous" rule, with DR-047 fixing
   * the prefix spelling. A supplied name **re-attaches** to that device-side session if one exists
   * (`SessionCli.py:224-267` re-enters by name) instead of failing.
   */
  readonly name?: string | undefined
  /** `description "<text>"` on the opener (`SessionCli.py:269`, `:218-221`). */
  readonly description?: string | undefined
  /**
   * `no-commit` on the opener (`SessionCli.py:295-311`). A **hidden** node in 4.28 — exposed because a
   * review-only screen wants it — so {@link ConfigSession#commit} refuses it locally instead of letting
   * the device answer, and the EOS support for it is not documented (STATUS.md §3 sweep).
   */
  readonly noCommit?: boolean | undefined
  /**
   * Where to record the session name so a crash or a closed tab does not orphan it (DR-022/DR-023).
   * Node: `new FileSessionJournal(SESSION_JOURNAL_PATH)` from `./node`. Browser: a web-storage journal
   * (see `createWebStorageJournal`). Nothing is written unless a journal is injected — the core performs
   * no I/O of its own (ARCHITECTURE.md §1, DR-002).
   */
  readonly journal?: SessionJournal | undefined
}

/** Extra options for {@link ConfigSession#commit} / {@link ConfigSession#commitWithRevertTimer}. */
export interface SessionCommitOptions extends SessionRequestOptions {
  /**
   * Run `copy running-config startup-config` **after** the commit succeeded (DR-024). Default `false`,
   * and nothing else in this package ever sends that command implicitly: a committed session changes
   * running-config only, and deciding when to make it durable is the UI's job. Sent as its own second
   * round trip, so a failure says which half happened.
   */
  readonly persist?: boolean | undefined
}

/** One entry of the recovery journal (DR-022/DR-023). Secrets are structurally impossible here. */
export interface SessionJournalEntry {
  readonly name: string
  /** The transport address the session was opened against, e.g. `https://sw1:443/command-api`. */
  readonly endpoint: string
  /** ISO-8601 creation time — the only age a session has, since EOS exposes none (row 63). */
  readonly startedAt: string
  /** Owning process, where one exists (absent in a browser). */
  readonly pid?: number | undefined
  /** Copied through so `recoverOrphans()` can show an operator what a pending session was for. */
  readonly description?: string | undefined
}

/**
 * The journal seam. `read`/`record`/`forget` are async so the Node file implementation and a browser
 * storage implementation are the same type; {@link SessionJournalEntry} has no field that could hold a
 * password, and the file writer re-serialises from an allow-list rather than spreading a caller's bag.
 */
export interface SessionJournal {
  read(): Promise<readonly SessionJournalEntry[]>
  record(entry: SessionJournalEntry): Promise<void>
  forget(name: string): Promise<void>
}

/** The default-name prefix — also `recoverOrphans()`'s default filter for unlabeled sessions. */
export const SESSION_NAME_PREFIX = 'ui-'

/** Client-side cap on a session name. Ours, not the device's (the EOS limit is unverified — §3 sweep). */
export const MAX_SESSION_NAME_LENGTH = 64

/**
 * Characters that may **not** appear in a session name. EOS takes `\S+`
 * (`SessionCli.py:31`, `:176-177` of `ConfigSessionCli.py`), so whitespace is a parse break rather than
 * a bad character — and `configure session <name>` is the first entry of every batch we send, so a name
 * like `x abort` would inject a second CLI command. Quotes, backslash, backtick, `#` and `;` are refused
 * with it because they all end or comment a CLI token.
 */
const UNSAFE_SESSION_NAME = /[\s"'`\\#;\u0000-\u001f\u007f]/u

/** `hh:mm:ss` only: the device's matcher is `(\d?\d):(\d?\d):(\d?\d)$` (`DateTimeRule.py:44-47`). */
const REVERT_TIMER = /^\d{1,2}:\d{1,2}:\d{1,2}$/u

/** `configure replace … md5 MD5` pattern, verbatim from `ConfigSessionCli.py:139`. */
const MD5_DIGITS = /^[0-9a-f]{32}$/u

/** A URL token for `configure replace SURL`: any CLI word, so no whitespace/control characters. */
const UNSAFE_URL_TOKEN = /[\s"'`\\#\u0000-\u001f\u007f]/u

/**
 * Best-effort extraction of the session that holds the lock out of a 1006 message. The **code** is the
 * contract (DR-010); the wording is ours until M12 (#14) records a capture (`test/fixtures/wire/
 * runCmds--error-1006-config-locked.json` is hand-authored), so a miss only costs detail — the
 * `SessionError` is raised either way.
 */
const LOCKED_BY_SESSION = /locked by session (\S+)/u

/**
 * The device refuses `commit timer 00:00:00` with this text (`SessionCli.py:92-94`). Kept as a client
 * pre-check because the value is meaningless rather than device-dependent, and the string is quoted so a
 * device answer and ours diff cleanly.
 */
const ZERO_TIMER_MESSAGE = 'Time value cannot be zero.'

/** Validate a caller-supplied session name (or any name spliced into a CLI command). */
function assertSessionName(name: string): string {
  if (name === '') {
    throw new NotSupportedError('a config session name may not be empty — pass a name or omit `name` to get a generated one')
  }
  if (UNSAFE_SESSION_NAME.test(name)) {
    throw new NotSupportedError(
      `unsafe config session name ${JSON.stringify(name)}: whitespace, quotes, backslash, backtick, '#', ';' and control characters are refused because 'configure session <name>' is the first command of every batch (EOS matches the name with \\S+, SessionCli.py:31)`,
    )
  }
  if (name.length > MAX_SESSION_NAME_LENGTH) {
    throw new NotSupportedError(
      `config session name ${JSON.stringify(name)} is longer than ${String(MAX_SESSION_NAME_LENGTH)} characters — a bound this client imposes so names stay readable in 'show configuration sessions'; EOS's own limit is unverified (STATUS.md §3)`,
    )
  }
  return name
}

/**
 * Quote a `description` value for the CLI (`CliMatcher.StringMatcher`, `SessionCli.py:218-221`). The
 * quoting *rules* are ours — how deep EOS nests quotes inside a session description is an M12 (#14)
 * capture question — so a newline or control character is refused outright instead of being escaped in a
 * way this client cannot prove the CLI accepts.
 */
function assertDescriptionText(text: string): void {
  if (/[\u0000-\u001f\u007f]/u.test(text)) {
    throw new NotSupportedError('a config session description may not contain control characters (a newline would end the command)')
  }
}

function quoteDescription(text: string): string {
  assertDescriptionText(text)
  return `"${text.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`
}

/**
 * The host token of DR-047's default name: the part of an endpoint that says **which switch** a session
 * belongs to, which is the whole point of scoping a name (pyeapi's bare `uuid4`, `client.py:1006`, says
 * nothing, so two switches' orphans are indistinguishable in a shared report).
 *
 * A scheme URL contributes its hostname **only**: `Transport#address` always spells an explicit port and
 * request path (`transports/endpoint.ts:131`), and a session name cannot carry the separator that would
 * make a port readable — the CLI matches the name with `\S+` (`SessionCli.py:216`), so `:` is impossible
 * and `sw1.lan-443` reads as a hostname with a made-up suffix. Uniqueness comes from the `-p<pid>-<hex8>`
 * tail; this token only has to tell different switches apart, and stay short enough to read in
 * `show configuration sessions`.
 *
 * A `unix:` address has no host at all, so its socket path *is* the identity and its separators become
 * dots (`unix:/var/run/command-api.sock` → `var.run.command-api.sock`). An IPv6 literal collapses to its
 * digits for the same separator reason — again, the tail is what disambiguates.
 *
 * Userinfo is dropped in every case. `address` is secret-free by contract (`transports/contract.ts`), and
 * a generated name is written onto a switch, so it must stay secret-free even when handed an address that
 * is not (DR-011).
 */
function addressToHostToken(address: string): string {
  const socketPath = /^unix:(\/.*)$/u.exec(address)?.[1]
  if (socketPath !== undefined) return safeHostToken(socketPath.replace(/^\/+|\/+$/gu, '').replace(/\//gu, '.'))
  const afterScheme = address.includes('://') ? address.slice(address.indexOf('://') + 3) : address
  const authority = afterScheme.split('/')[0] ?? ''
  const host = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority
  const bracketEnd = host.indexOf(']')
  const withoutPort = host.startsWith('[') ? (bracketEnd === -1 ? host.slice(1) : host.slice(1, bracketEnd)) : host.replace(/:\d*$/u, '')
  return safeHostToken(withoutPort)
}

/** Clamp a host token to the character set and length a session name can carry. */
function safeHostToken(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/gu, '-').replace(/^[-.]+|[-.]+$/gu, '')
  return safe === '' ? 'device' : safe.slice(0, 32)
}

/** Where a `pid` token comes from in a shared module: Node has one, a browser has none, and no built-in is imported. */
function processToken(): number | undefined {
  const candidate = (globalThis as { process?: { pid?: unknown } }).process
  const pid = candidate?.pid
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : undefined
}

/** 8 hex characters, from `crypto` when a runtime provides it and from `Math.random` when it does not. */
function randomToken(): string {
  const cryptoLike = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => unknown } }).crypto
  const bytes = new Uint8Array(4)
  if (typeof cryptoLike?.getRandomValues === 'function') {
    cryptoLike.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256)
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * DR-047's default name: `ui-<host>-p<pid>-<hex8>`, or `ui-<host>-<hex8>` where there is no process
 * (a browser). pyeapi's `uuid4()` (`client.py:1006`) is unfindable afterwards, which is the whole
 * orphan problem DR-023 exists for. The prefix is also `recoverOrphans()`'s default filter, so it is
 * spelled with its trailing dash and the segments are appended to it — joining `ui-` with `-` would put
 * two dashes where the prefix ends and the host begins, and a name that does not start with the prefix
 * spelled this way silently stops matching the recovery filter.
 */
export function generateSessionName(endpoint: string): string {
  const segments = [addressToHostToken(endpoint)]
  const pid = processToken()
  if (pid !== undefined) segments.push(`p${String(pid)}`)
  segments.push(randomToken())
  return SESSION_NAME_PREFIX + segments.join('-')
}

/**
 * Validate a `commit timer` value. The device's own matcher is `(\d?\d):(\d?\d):(\d?\d)$`
 * (`DateTimeRule.py:44-47`) — three components, each one or two digits — and it explicitly does **not**
 * range-check them ("The values for hour, min, seconds must be validated by library user",
 * `DateTimeRule.py:15`). So `hh:mm` is refused here (it matches nothing, and the Python handler would
 * then unpack two values into three names at `SessionCli.py:90`), and a zero duration is refused with the
 * device's own wording.
 */
function assertRevertTimer(value: string): string {
  if (!REVERT_TIMER.test(value)) {
    throw new NotSupportedError(
      `commit timer ${JSON.stringify(value)} is not hh:mm:ss — the CLI's TimeMatcher pattern is (\\d?\\d):(\\d?\\d):(\\d?\\d)$ (DateTimeRule.py:44-47); 'hh:mm' does not match it`,
    )
  }
  const [hours = '0', minutes = '0', seconds = '0'] = value.split(':')
  if (Number(hours) === 0 && Number(minutes) === 0 && Number(seconds) === 0) {
    throw new NotSupportedError(`commit timer 00:00:00 is refused: ${ZERO_TIMER_MESSAGE} (SessionCli.py:92-94)`)
  }
  return value
}

/** Turn one `{ output }`-style text reply into a string. Mirrors `command-layer.ts#outputText`; local because importing it would be the forbidden cycle. */
function textMember(reply: CommandResult, command: string): string {
  const output = reply['output']
  if (typeof output !== 'string') {
    throw new ProtocolError(
      `eAPI text reply for ${JSON.stringify(command)} has no string 'output' member (got ${output === undefined ? 'nothing' : typeof output})`,
      { commands: redactCommands([command]) },
    )
  }
  return output
}

/** The one reply object for a one-command read, named by its `cmd` when it is missing (M4's empty-state rule). */
function singleResult(results: readonly CommandResult[], command: CommandSpec): CommandResult {
  const reply = results[0]
  if (reply === undefined) {
    throw new ProtocolError(
      `eAPI returned a successful reply with no result object for ${JSON.stringify(commandText(command))} — refusing to substitute an empty object`,
      { commands: redactCommands([command]) },
    )
  }
  return reply
}

function commandText(command: CommandSpec): string {
  return typeof command === 'string' ? command : command.cmd
}

/** The CLI text of a `CommandError`'s failing command, when the device identified one. */
function failedCommandText(error: CommandError): string | undefined {
  const failed = error.failedCommand
  return failed === undefined ? undefined : commandText(failed)
}

/**
 * Did the device reject the `configure session <name>` opener itself? When it did, the handle cannot be
 * used again: either the session does not exist (a stale journal entry), or something else holds the
 * config lock. A rejection of a *later* command leaves the session open — EOS keeps it (DR-023), which
 * is precisely what makes `abort()` still possible after a bad changeset.
 */
function openerRejected(error: CommandError, opener: string): boolean {
  const failed = failedCommandText(error)
  if (failed !== undefined) return failed === opener
  return error.results.length === 0
}

// --- `show configuration sessions` parsing -------------------------------------------------------

/** One terminal/PID instance attached to a device-side session (`Instance`, `ConfigSessionModel.py:15-19`). */
export interface ConfigSessionInstance {
  /** The dictionary key in the device reply (an `int` in the model, a string in JSON). */
  readonly pid?: number | undefined
  readonly user?: string | undefined
  readonly terminal?: string | undefined
  /** `true` for the session on the CLI that ran the command (`currentTerminal`, `:18`). */
  readonly currentTerminal?: boolean | undefined
}

/** One session as `show configuration sessions` reports it (`Session`, `ConfigSessionModel.py:21-34`). */
export interface ConfigSessionSummary {
  readonly name: string
  /**
   * Verbatim `state` from the device. The value set is `Tac.Type('Cli::Session::SessionState')` and the
   * model does not inline it (`ConfigSessionModel.py:22`), so this stays `string`; only
   * `'pending'` is confirmed in the image (`SessionCli.py:67`), which is why recovery acts on that and
   * reports anything else instead of guessing.
   */
  readonly state: string
  readonly description?: string | undefined
  /** Epoch seconds; present while a `commit timer` revert is pending (`:25`). */
  readonly commitBy?: number | undefined
  /** Epoch seconds of a completed session (`:24`). */
  readonly completedTime?: number | undefined
  readonly commitUser?: string | undefined
  readonly instances: readonly ConfigSessionInstance[]
}

/** The parsed answer to `show configuration sessions [detail]`. */
export interface ConfigurationSessions {
  /** Every session the device reports, pending or completed, sorted by name. */
  readonly sessions: readonly ConfigSessionSummary[]
  /** `maxSavedSessions` (`ConfigSessionModel.py:38`) — how many completed sessions are kept. */
  readonly maxSavedSessions?: number | undefined
  /** `maxOpenSessions` (`:40`) — the pending cap; hitting it is what makes a new session fail (row 59). */
  readonly maxOpenSessions?: number | undefined
  /** The device's own reply object, for a screen that needs a field this view has not modelled. */
  readonly raw: CommandResult
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function parseInstance(key: string, value: unknown): ConfigSessionInstance {
  const record = asRecord(value) ?? {}
  const pid = /^\d+$/u.test(key) ? Number(key) : undefined
  const user = readString(record['user'])
  const terminal = readString(record['terminal'])
  const currentTerminal = readBoolean(record['currentTerminal'])
  return {
    ...(pid === undefined ? {} : { pid }),
    ...(user === undefined ? {} : { user }),
    ...(terminal === undefined ? {} : { terminal }),
    ...(currentTerminal === undefined ? {} : { currentTerminal }),
  }
}

/**
 * Runtime-validate the `show configuration sessions` reply at the edge (DR-010/PLAN's "validate device
 * responses, surface parse failures as typed errors"). The model is documented
 * (`ConfigSessionModel.py:21-41`) but the CLI is free to add fields, so unknown keys survive in `raw`
 * and an answer without a `sessions` object is a `ProtocolError` naming the command — never an empty
 * table rendered as "no pending sessions".
 */
export function parseConfigurationSessions(reply: CommandResult): ConfigurationSessions {
  const holder = asRecord(reply['sessions'])
  if (holder === undefined) {
    throw new ProtocolError(
      "show configuration sessions reply has no 'sessions' object, so pending sessions cannot be enumerated — refusing to report 'none' (the model in ConfigSessionModel.py:36-41 always carries it)",
      { commands: ['show configuration sessions'] },
    )
  }
  const sessions: ConfigSessionSummary[] = []
  for (const [name, value] of Object.entries(holder)) {
    const record = asRecord(value)
    if (record === undefined) {
      throw new ProtocolError(
        `show configuration sessions reported session ${JSON.stringify(name)} without an object, which this client cannot interpret`,
        { commands: ['show configuration sessions'] },
      )
    }
    const state = readString(record['state'])
    if (state === undefined) {
      throw new ProtocolError(
        `show configuration sessions reported session ${JSON.stringify(name)} with no 'state', which would make any cleanup decision a guess`,
        { commands: ['show configuration sessions'] },
      )
    }
    const description = readString(record['description'])
    const commitBy = readNumber(record['commitBy'])
    const completedTime = readNumber(record['completedTime'])
    const commitUser = readString(record['commitUser'])
    const instances = asRecord(record['instances'])
    const parsedInstances = instances === undefined ? [] : Object.entries(instances).map(([key, instance]) => parseInstance(key, instance))
    sessions.push({
      name,
      state,
      ...(description === undefined ? {} : { description }),
      ...(commitBy === undefined ? {} : { commitBy }),
      ...(completedTime === undefined ? {} : { completedTime }),
      ...(commitUser === undefined ? {} : { commitUser }),
      instances: parsedInstances,
    })
  }
  sessions.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  const maxSavedSessions = readNumber(reply['maxSavedSessions'])
  const maxOpenSessions = readNumber(reply['maxOpenSessions'])
  return {
    sessions,
    ...(maxSavedSessions === undefined ? {} : { maxSavedSessions }),
    ...(maxOpenSessions === undefined ? {} : { maxOpenSessions }),
    raw: reply,
  }
}

// --- the session handle --------------------------------------------------------------------------

/**
 * One config session on one `Node`. The handle is a client-side view of a device-side session: EOS has
 * no connection identity to hold on to across `runCmds` calls, so **every** batch re-attaches with
 * `configure session <name>` as `cmds[0]` — the same thing pyeapi relies on (`client.py:687`) and what
 * makes a session resumable from another process (DR-022).
 */
export class ConfigSession {
  /** The session name as it goes on the wire. */
  readonly name: string
  /** Whether this session was opened `no-commit` (a review-only session). */
  readonly noCommit: boolean
  readonly description: string | undefined

  private readonly host: SessionCommandTarget
  private readonly journal: SessionJournal | undefined
  private sessionState: ConfigSessionState = 'open'

  constructor(host: SessionCommandTarget, options: ConfigSessionOptions = {}) {
    const name = options.name ?? generateSessionName(host.connection.address)
    this.name = assertSessionName(name)
    this.noCommit = options.noCommit === true
    this.description = options.description
    if (this.description !== undefined && this.description !== '') assertDescriptionText(this.description)
    this.host = host
    this.journal = options.journal
  }

  /** The current state (DR-025). Read it; never assign it — the transitions are the verbs. */
  get state(): ConfigSessionState {
    return this.sessionState
  }

  /** `true` while the handle can still send commands. */
  get isOpen(): boolean {
    return isLiveState(this.sessionState)
  }

  /** Set once a diff (or `show session-config`) has been read; cleared by the next staged write. */
  private diffRead = false

  /**
   * Has a diff been read since the last staged write? A UI should gate its Commit button on this: it is
   * the only honest way to promise an operator that the text they reviewed is the text that lands.
   */
  hasDiffBeenRead(): boolean {
    return this.diffRead
  }

  /**
   * The opener — `configure session <name>[ no-commit][ description "…"]`
   * (`SessionCli.py:268-282`, `:295-311`). Sent as `cmds[0]` of **every** batch; that is how EOS
   * re-attaches a named session (`enterConfigSession`, `:224-267`) and it is why two handles, two
   * processes or two page loads reach the same staged changes.
   */
  private opener(): string {
    const parts = [`configure session ${this.name}`]
    if (this.noCommit) parts.push('no-commit')
    if (this.description !== undefined && this.description !== '') parts.push(`description ${quoteDescription(this.description)}`)
    return parts.join(' ')
  }

  /** The state-machine refusal used by every verb, so an illegal transition never reaches the wire. */
  private assertLive(verb: string): void {
    if (isLiveState(this.sessionState)) return
    throw new SessionError(
      `cannot ${verb}: config session ${JSON.stringify(this.name)} is ${this.sessionState}. ` +
        (this.sessionState === 'lost'
          ? 'Re-attach with node.configSession({ name }) to resume it, or node.listSessions()/node.abortSession() to clean it up (DR-023).'
          : 'Open a new session with node.configSession().'),
      { commands: [this.opener()] },
    )
  }

  /**
   * One state-machine transition per device failure. 1006 is always fatal for the handle — the config
   * lock means the session is unreachable and the fix is cleanup, not a retry (DR-023) — and a rejection
   * of the opener means the session is gone. Anything else leaves the session as it was, because EOS
   * keeps a session whose commands failed.
   */
  private classifyFailure(error: unknown, commands: readonly CommandSpec[]): Error {
    if (!(error instanceof CommandError)) {
      // A transport failure says nothing about the device side, so the state is left alone and the
      // journal keeps its entry: the operator must be able to find the session afterwards.
      return error instanceof Error ? error : new SessionError(`config session ${JSON.stringify(this.name)} failed`, { commands: redactCommands(commands), cause: error })
    }
    if (error.code === EapiErrorCode.COMMAND_CONFIG_LOCKED) {
      this.sessionState = 'lost'
      const lockedBy = LOCKED_BY_SESSION.exec(error.message)?.[1]
      return new SessionError(
        `config locked for session ${JSON.stringify(this.name)}${lockedBy === undefined ? '' : `: held by ${JSON.stringify(lockedBy)}`}${lockedBy === undefined ? ` — device reply: ${error.message}` : ''}. Pending sessions hold the lock and consume 'service configuration session max pending', so clean up with node.listSessions() / node.abortSession(name) / node.recoverOrphans() (DR-023, pyeapi has no 1006 handling).`,
        { commands: redactCommands(commands), ...(error.requestId === undefined ? {} : { requestId: error.requestId }), cause: error },
      )
    }
    if (openerRejected(error, this.opener())) this.sessionState = 'lost'
    else if (failedCommandText(error) === this.opener()) this.sessionState = 'lost'
    return error
  }

  /**
   * Send `configure session <name>` plus these commands, and return only the callers' replies: the
   * `enable` reply is popped by the command layer (M4) and the opener's own reply is popped here,
   * exactly as pyeapi's `response.pop(0)` does (`client.py:693`).
   */
  private async send(tail: readonly CommandSpec[], options: SessionRequestOptions, format?: RunCmdsFormat): Promise<readonly CommandResult[]> {
    const commands: readonly CommandSpec[] = [this.opener(), ...tail]
    let results: readonly CommandResult[]
    try {
      results = await this.host.runCommands(commands, {
        // A session batch always mutates device state (it creates or re-enters a session), so DR-019's
        // read-only retry is refused here even if a caller asks for it: re-sending a half-applied
        // changeset is exactly the failure that mode exists to prevent.
        //
        // `tolerateErrors` is forced off for the same reason and, unlike everywhere else in the package,
        // it is **not** an opt-in a caller can buy back. At the wire layer that flag is only the DR-012
        // `1003 → format:'text'` repair, and `sendRequest` performs it by re-issuing *the same command
        // list* (`internal/wire.ts:521-566`); inside a session that list is
        // `[enable, configure session <name>, …changeset]`, so a repair would run every command the
        // device has already applied a second time. pyeapi never had this hazard: its repair lives in
        // `enable()` (`client.py:865-871`) and `_configure_session` calls `run_commands`, which has none.
        // A session that answers 1003 gets the `CommandError`; a caller who wants the text encoding gets
        // it where one command is at stake — {@link ConfigSession#diff} or `Node.showText`.
        ...options,
        readOnly: false,
        tolerateErrors: false,
        ...(format === undefined ? {} : { format }),
      })
    } catch (error) {
      throw this.classifyFailure(error, commands)
    }
    if (results.length === 0) {
      throw new ProtocolError(
        `eAPI returned a successful reply with no result object for ${JSON.stringify(this.opener())} — refusing to assume the session was entered`,
        { commands: redactCommands(commands) },
      )
    }
    // A staged write invalidates the diff the operator just read, so the flag is cleared here and set
    // again by diff()/showSessionConfig(). The device answered, so every command in the batch ran.
    //
    // The state goes back the same way, exactly as DR-048's diagram draws it (`diffed --> open` on a
    // write): a handle left in `diffed` would let a UI see `hasDiffBeenRead() === false` while still
    // trusting the state that says the rendered diff is current. The two fields must say one thing.
    // `diff()`/`showSessionConfig()` move back to `diffed` just below, after this returns.
    this.diffRead = false
    if (this.sessionState === 'diffed') this.sessionState = 'open'
    // pyeapi pops the `configure session <name>` reply the same way (`client.py:693`).
    return results.slice(1)
  }

  /**
   * Stage commands in this session. pyeapi reaches for the private `_configure_session`
   * (`client.py:676-696`); this is the public verb. A rejected command throws `CommandError` carrying
   * `failedCommand` and the `results[]` the device managed to produce, and the session **stays open** so
   * `abort()` is still available.
   *
   * Every verb that returns a promise is `async`, state-machine refusals included: a `SessionError` for a
   * dead handle has to arrive as a rejection like every other failure on this path, so that a caller
   * building a promise array (`[session.abort(), session.run([...])]`) gets one error channel instead of
   * a synchronous throw that walks past its `.catch` (and an unhandled rejection for the calls already
   * created in front of it).
   */
  async run(commands: CommandSpec | readonly CommandSpec[], options: SessionRequestOptions = {}): Promise<readonly CommandResult[]> {
    this.assertLive('run commands')
    const tail = Array.isArray(commands) ? (commands as readonly CommandSpec[]) : [commands as CommandSpec]
    return await this.send(tail, options)
  }

  /** Alias of {@link ConfigSession#run} for callers who think of it as "these commands". */
  async commands(batch: CommandSpec | readonly CommandSpec[], options: SessionRequestOptions = {}): Promise<readonly CommandResult[]> {
    return await this.run(batch, options)
  }

  /**
   * `show session-config diffs`, **forced** to `format:'text'`.
   *
   * The reason is in the image, not in a manual: `ShowSessionConfigDiffs`
   * (`CliPlugin/ConfigSessionShowCli.py:66-81`) declares no `cliModel`, so a JSON request is answered
   * `1003 COMMAND_UNCONVERTED` (`CliCommon.py:29`). pyeapi already knows this — its docstring says
   * `"show session-config diffs" doesn't support json encoding` and it passes `encoding='text'`
   * (`client.py:1008-1016`, the call at `:1013-1014`) — but it reaches the wire only through the
   * `**kwargs` allow-list, where a typo'd `encodng` disappears silently (MIGRATION.md §5 row 31). Here
   * the encoding is a typed argument the caller cannot get wrong, and we do **not** depend on the
   * codec's 1003 repair (DR-012): one round trip, asked in the encoding that works. `show session-config`
   * without `diffs` *is* model-backed (`:40-62`, model at `:57`), so {@link showSessionConfig} stays JSON.
   */
  async diff(options: SessionRequestOptions = {}): Promise<string> {
    this.assertLive('read a diff')
    const results = await this.send(['show session-config diffs'], options, 'text')
    const reply = singleResult(results, 'show session-config diffs')
    // `output` is the only member this client reads; the shape after the text encoding is verified by
    // test/fixtures/show/show-running-config--minimal.json's `{output}` form (M4, #6).
    this.diffRead = true
    this.markDiffed()
    return textMember(reply, 'show session-config diffs')
  }

  /**
   * The session's operating configuration as a JSON reply — legal precisely because the command carries a
   * `cliModel` (`ConfigSessionShowCli.py:40-62`), unlike `diffs`. The field set is
   * `ShowRunOutputModel.Mode`, which this milestone has not inspected, so the reply stays a
   * `CommandResult` rather than an invented interface (MIGRATION.md §5 row 57).
   */
  async showSessionConfig(options: SessionRequestOptions = {}): Promise<CommandResult> {
    this.assertLive('read the session configuration')
    const results = await this.send(['show session-config'], options, 'json')
    const reply = singleResult(results, 'show session-config')
    this.diffRead = true
    this.markDiffed()
    return reply
  }

  private markDiffed(): void {
    if (this.sessionState === 'open') this.sessionState = 'diffed'
  }

  /**
   * Whole-changeset validation (PLAN §M5 box 8): one batch, every command attempted, per-command detail
   * returned instead of "command 7 failed". `{ stopOnError: false, includeErrorDetail: true }` is exactly
   * the pair DR-016 opened on the wire, and `CommandError.errorDetail` is the
   * `error.data.errorDetail[]` shape M1's codec already models (`types/eapi.ts:75-88`).
   *
   * A *rejected* command does not make this throw — that is the point — but the session stays open with the
   * commands that did run still staged, so `diff()` shows the partial result and `abort()` undoes it.
   * Nothing about EOS's `stopOnError:false` semantics beyond the envelope shape is claimed here; the
   * dry-run screen (M11 #13, `verifyConfig`) is the device-verified version of this idea.
   */
  async validateChanges(batch: CommandSpec | readonly CommandSpec[], options: SessionRequestOptions = {}): Promise<ChangesetOutcome> {
    this.assertLive('validate a changeset')
    const tail = Array.isArray(batch) ? (batch as readonly CommandSpec[]) : [batch as CommandSpec]
    try {
      const applied = await this.send(tail, { ...options, stopOnError: false, includeErrorDetail: true })
      return { ok: true, applied }
    } catch (error) {
      // A failure that killed the handle (the opener rejected, or 1006) is not a changeset result — it is
      // a reason the session does not exist, and the caller has to hear it as an error.
      if (!isLiveState(this.sessionState)) throw error
      if (!(error instanceof CommandError)) throw error
      return {
        ok: false,
        failures: error.errorDetail ?? [],
        // The per-command replies the device did produce. A failed entry carries an `errors` marker
        // (`test/fixtures/wire/runCmds--error-1002-data-array.json`), which is how M1's codec reads it;
        // `failures` stays the authoritative list, because that marker's spelling is device text.
        staged: error.results.filter((entry) => !('errors' in entry)),
        error,
      }
    }
  }

  /**
   * Commit the session: `configure session <name>` then `commit` — the in-session grammar
   * (`SessionCli.py:385-404`), which is what pyeapi's `_configure_and_exit_session(['commit'])` sends
   * (`client.py:1018-1021`). The handle ends: every later verb throws, so a double commit cannot
   * re-create the session the device just destroyed.
   *
   * With `{ persist: true }` a **second** round trip runs `copy running-config startup-config`
   * (DR-024). It is separate on purpose: if it fails, the message says "committed, not saved" instead of
   * leaving an operator guessing. Without it nothing is written to startup-config — a commit changes
   * running-config only, and auto-save is the footgun DR-024 names.
   */
  async commit(options: SessionCommitOptions = {}): Promise<readonly CommandResult[]> {
    this.assertLive('commit')
    this.assertCommittable('commit')
    const { persist = false, ...request } = options
    const results = await this.send(['commit'], request)
    await this.finish('committed')
    if (persist) {
      try {
        await runOnHost(this.host, [copyRunningToStartupCommand()], request)
      } catch (error) {
        throw new SessionError(
          `config session ${JSON.stringify(this.name)} committed, but 'copy running-config startup-config' failed: the change is live in running-config and is NOT saved to startup-config, so it is lost on reboot (DR-024). Retry node.copyRunningToStartup(), or undo the change deliberately.`,
          { commands: [COPY_RUNNING_TO_STARTUP], cause: error },
        )
      }
    }
    return results
  }

  /**
   * `configure session <name>` then `commit timer <hh:mm:ss>` — EOS commits the change and reverts it if
   * the deadline lapses (the keyword's own help: "commit session with a timeout. If not committed within
   * this time, config will be reverted", `SessionCli.py:318-321`).
   *
   * **What is verified and what is not.** Verified in the image: the grammar (`:316-341`), the value
   * shape (`DateTimeRule.py:44-47`), the zero-value refusal (`SessionCli.py:92-94`), the checkpoint taken
   * on the first timed commit (`:109-111`, `savePreCommitConfig` at `:196-212`), and that a commit while
   * a commit timer runs is logged as `SYS_CONFIG_SESSION_COMMIT_TIMER_UPDATED` (`:139-145`). **Not**
   * verified: that a second `commit` cancels the revert — the timer itself lives in native
   * `CliSession.commitSession`, below this Python — so DECISIONS.md open item 5 and the STATUS.md §3
   * sweep line stay open, and this client exposes `confirmRevertTimer()` as the *intended* call while
   * claiming nothing about what it does on hardware (DR-050, MIGRATION.md §5 row 60).
   */
  async commitWithRevertTimer(timer: string, options: SessionRequestOptions = {}): Promise<readonly CommandResult[]> {
    this.assertLive('commit with a revert timer')
    this.assertCommittable('commit with a revert timer')
    const value = assertRevertTimer(timer)
    const results = await this.send([`commit timer ${value}`], options)
    await this.finish('committed')
    return results
  }

  /**
   * End a pending `commit timer` by committing again — the shape the `COMMIT_TIMER_UPDATED` log implies
   * (`SessionCli.py:139-145`). Unverified device behaviour, so the method name says *intends*: a device
   * that treats the second commit as a plain commit still ends up with the change applied.
   */
  confirmRevertTimer(options: SessionRequestOptions = {}): Promise<readonly CommandResult[]> {
    return this.commit(options)
  }

  /**
   * `configure session <name>` then `abort`. pyeapi's `abort()` (`client.py:1023-1026`) forgets to clear
   * `_session_name`, so a later call re-enters — and re-creates — a session EOS already destroyed;
   * here the transition is terminal (MIGRATION.md §5 row 56). Nothing is refreshed: an aborted session
   * changed no running-config.
   */
  async abort(): Promise<readonly CommandResult[]> {
    this.assertLive('abort')
    const results = await this.send(['abort'], {})
    await this.finish('aborted')
    return results
  }

  /**
   * `rollback clean-config [ { <groups> } ]` inside this session. The command is registered on
   * `ConfigSessionMode` and nowhere else (`SessionCli.py:445-480`, `ConfigSessionMode.addCommandClass` at
   * `:480`), which is why this is a session verb rather than the bare `Node` verb PLAN sketches —
   * {@link rollbackCleanConfigOn} is the convenience that opens a session, stages it, and hands the
   * session back un-committed (row 63).
   */
  async rollbackCleanConfig(groups?: readonly string[]): Promise<readonly CommandResult[]> {
    this.assertLive('roll back to the clean configuration')
    return await this.send([cleanConfigCommand(groups)], {})
  }

  /**
   * `rollback <previously-committed-session-name>` inside this session: EOS re-creates running-config
   * from that session, clean first ("rollback with name also does a clean-config first, in order to add
   * all the roots to this session", `SessionCli.py:43-47`). The `<name>` form's command class is not in
   * the extracted image Python — the header comment at `:38-39` says the rest of these CLIs live in the
   * `ConfigSession` package — so the grammar here rests on that comment, and the paired STATUS.md §3
   * sweep line is open (row 63).
   */
  async rollbackToSession(sessionName: string): Promise<readonly CommandResult[]> {
    this.assertLive('roll back to a committed session')
    return await this.send([`rollback ${assertSessionName(sessionName)}`], {})
  }

  /**
   * Detach this handle without touching the device: eAPI has no CLI session to leave between `runCmds`
   * calls, so there is nothing to send. The session **stays pending on the switch** (and in the journal)
   * until it is committed or aborted — which is why `exit()` lands in `lost` rather than `aborted`, and
   * why a tab that was closed mid-edit is `recoverOrphans()`'s reason for existing (DR-023).
   * pyeapi's equivalent is `_configure_and_exit_session` quietly setting `_session_name = None`
   * (`client.py:1028-1035`), which it does for `commit()` but never for a plain detach.
   */
  exit(): void {
    if (!isLiveState(this.sessionState)) return
    this.sessionState = 'lost'
  }

  private assertCommittable(verb: string): void {
    if (!this.noCommit) return
    throw new SessionError(
      `cannot ${verb}: config session ${JSON.stringify(this.name)} was opened 'no-commit' (SessionCli.py:295-311), which disallows committing it. Use abort() to discard the staged changes, or open the session without noCommit.`,
      { commands: [this.opener()] },
    )
  }

  /**
   * End the handle, drop the journal entry, and refresh the cached configs the way pyeapi's exit path
   * does (`client.py:1028-1035`). Awaited, because a journal write that is still in flight when the UI
   * moves on is how a session ends up reported as pending after it was committed.
   */
  private async finish(state: 'committed' | 'aborted'): Promise<void> {
    this.sessionState = state
    // An aborted session changed no running-config, so the cache stays valid (pyeapi agrees — its
    // `abort()` at `client.py:1023-1026` does not refresh).
    if (state === 'committed' && this.host.autorefresh) this.host.refresh()
    if (this.journal !== undefined) await this.journal.forget(this.name)
  }

  /** Record the session name so a crash cannot orphan it (DR-022/DR-023). Awaited by the factory, not the constructor. */
  async recordInJournal(): Promise<void> {
    if (this.journal === undefined) return
    const pid = processToken()
    await this.journal.record({
      name: this.name,
      endpoint: this.host.connection.address,
      startedAt: new Date().toISOString(),
      ...(pid === undefined ? {} : { pid }),
      ...(this.description === undefined ? {} : { description: this.description }),
    })
  }
}

/**
 * Either branch of {@link ConfigSession#validateChanges}. `staged` is the commands EOS reports as having
 * produced output — with `stopOnError: false` the batch keeps going, so a UI that shows a partial
 * changeset has to say which half landed.
 */
export type ChangesetOutcome =
  | { readonly ok: true; readonly applied: readonly CommandResult[] }
  | {
      readonly ok: false
      /** `error.data.errorDetail[]` (`types/eapi.ts:75-88`): `{index, code, message, cmd}` per rejected command. */
      readonly failures: readonly ErrorDetailEntry[]
      readonly staged: readonly CommandResult[]
      /** The device failure itself, for a caller that wants `code`/`trace()` rather than the summary. */
      readonly error: CommandError
    }

/** What `copy running-config startup-config` is called in one place, so the "never implicit" test has one target. */
export const COPY_RUNNING_TO_STARTUP = 'copy running-config startup-config'

function copyRunningToStartupCommand(): string {
  return COPY_RUNNING_TO_STARTUP
}

/** `rollback clean-config` with the optional brace form (`SessionCli.py:445-451`). */
function cleanConfigCommand(groups?: readonly string[]): string {
  if (groups === undefined || groups.length === 0) return 'rollback clean-config'
  const names = groups.map((group) => {
    if (group === '' || UNSAFE_SESSION_NAME.test(group)) {
      throw new NotSupportedError(`unsafe config group name ${JSON.stringify(group)} — the CLI takes a \\S+ token inside { … } (SessionCli.py:445-451)`)
    }
    return group
  })
  return `rollback clean-config { ${names.join(' ')} }`
}

/** Run a batch that is *not* scoped to a session config-mode subcommand. */
async function runOnHost(host: SessionCommandTarget, commands: readonly CommandSpec[], options: SessionRequestOptions): Promise<readonly CommandResult[]> {
  return await host.runCommands(commands, { ...options, readOnly: false })
}

// --- module-level verbs used by Node's thin delegators -------------------------------------------

/**
 * Create a session and write its journal entry. Split from the constructor because the journal write is
 * async and a constructor cannot await; `Node.configSession()` calls this and remembers the result
 * (DR-025's one-session-per-`Node` rule).
 */
export async function createConfigSession(host: SessionCommandTarget, options: ConfigSessionOptions = {}): Promise<ConfigSession> {
  const session = new ConfigSession(host, options)
  await session.recordInJournal()
  return session
}

/**
 * DR-025's guard. Called from `Node.configure()` (terminal mode) and from
 * {@link Node.configureReplace}: a live config session on this `Node` means two configuration contexts
 * would be driven at once, and `configure replace` additionally exits the session it finds
 * (`ConfigSessionCli.py:57`) — so your staged changes would be stranded in a session this client still
 * believes it owns.
 *
 * pyeapi instead *reroutes* a terminal write into the open session (`client.py:635-636`), which keeps a
 * script working but means the diff an operator approved is no longer the diff that lands — a UI cannot
 * show both at once. MIGRATION.md §5 row 55.
 */
export function assertNoSessionConflict(active: ConfigSession | undefined, verb: string, commands?: readonly CommandSpec[]): void {
  if (active === undefined || !active.isOpen) return
  throw new SessionError(
    `cannot ${verb} while config session ${JSON.stringify(active.name)} is open on this node: EOS drives one configuration context per CLI session, so the staged changes in ${JSON.stringify(active.name)} would no longer be the change an operator reviewed (DR-025). Stage the command in the session (session.run([...])), or end it first (commit() / abort()). pyeapi silently reroutes instead — MIGRATION.md §5 row 55.`,
    { ...(commands === undefined ? {} : { commands: redactCommands(commands) }) },
  )
}

/** {@link assertNoSessionConflict} phrased for the terminal-mode case PLAN §M5 names. */
export function assertTerminalModeAllowed(active: ConfigSession | undefined, commands?: readonly CommandSpec[]): void {
  assertNoSessionConflict(active, 'configure() in terminal mode', commands)
}

/** Options for {@link Node.listSessions}. */
export interface ListSessionsOptions extends SessionRequestOptions {
  /** `show configuration sessions detail` (`ConfigSessionShowCli.py:84-89`) — adds the commit/complete times. */
  readonly detail?: boolean | undefined
}

/**
 * `show configuration sessions [detail]` — model-backed, so JSON is the honest encoding
 * (`ConfigSessionShowCli.py:84-97`, model line `:91`). DR-012's text fallback would answer with an
 * unparseable blob and DR-023's recovery depends on structure, so `tolerateErrors: false` pins the
 * failure loudly if a build ever drops the model.
 */
export async function listSessionsOn(host: SessionCommandTarget, options: ListSessionsOptions = {}): Promise<ConfigurationSessions> {
  const { detail = false, ...request } = options
  const command = detail ? 'show configuration sessions detail' : 'show configuration sessions'
  const results = await host.runCommands([command], { ...request, format: 'json', tolerateErrors: false, readOnly: true })
  return parseConfigurationSessions(singleResult(results, command))
}

/**
 * `configure session <name> abort` from exec mode (`SessionCli.py:345-372`) — the verb for a session this
 * client has no handle for, i.e. an orphan left by a dead process. Distinct from
 * {@link ConfigSession#abort}, which re-enters first and aborts in-session
 * (`client.py:1023-1026`), and the two different command lists are asserted separately in the tests.
 *
 * A session that is already gone is **not** silently swallowed: EOS answers
 * "Cannot abort non-existent session %s." (`SessionCli.py:358-360`), so the caller learns which names
 * were stale — that is how `recoverOrphans()` prunes journal entries instead of trusting them.
 */
export async function abortSessionOn(host: SessionCommandTarget, name: string, options: SessionRequestOptions = {}): Promise<readonly CommandResult[]> {
  return await runOnHost(host, [`configure session ${assertSessionName(name)} abort`], options)
}

/** One candidate decision from {@link recoverOrphansOn}. */
export interface RecoveryCandidate {
  readonly name: string
  readonly reason: string
}

/** What {@link recoverOrphansOn} did, and what it declined to do. */
export interface RecoverOrphansOutcome {
  /** Aborted cleanly by this call. */
  readonly aborted: readonly string[]
  /** Names the device refused to abort (already gone, or not ours to touch). */
  readonly failed: readonly RecoveryCandidate[]
  /** Reported but deliberately untouched: unrecognised state, too new, or not journaled. */
  readonly skipped: readonly RecoveryCandidate[]
  /** Still pending on the device afterwards. */
  readonly remaining: readonly ConfigSessionSummary[]
  /** Sessions the device reports that recovery ignored by design (completed ones, foreign names). */
  readonly reported: readonly ConfigSessionSummary[]
}

/** Options for {@link Node.recoverOrphans}. */
export interface RecoverOrphansOptions extends SessionRequestOptions {
  /** Journal to prune. Without one, only name-prefix matching is possible and `olderThan` cannot be applied. */
  readonly journal?: SessionJournal | undefined
  /**
   * Only abort entries at least this many **milliseconds** old. Age comes from the journal:
   * `show configuration sessions` has no start-time field (`ConfigSessionModel.py:21-34`), so an
   * unlabeled device session has no age and is skipped rather than guessed at (row 63).
   */
  readonly olderThan?: number | undefined
  /** Which names count as ours. Default {@link SESSION_NAME_PREFIX}. Pass `''` to consider every name. */
  readonly namePrefix?: string | undefined
}

/**
 * DR-023's cleanup: find and abort the pending sessions that hold the config lock and produce the next
 * client's **1006**. Pending sessions never age out on their own, and pyeapi discovers none of this —
 * it has neither `show configuration sessions` parsing nor a 1006 path anywhere (`grep 1006` over the
 * upstream tree: no matches).
 *
 * The safety rules: **act only on what can be identified.** `pending` plus the prefix (or a journal hit)
 * is acted on; an unrecognised `state` value is reported, not aborted, because the enum's members come
 * from `Tac.Type('Cli::Session::SessionState')` (`ConfigSessionModel.py:22`) and this offline port has
 * only confirmed `'pending'` (`SessionCli.py:67`). And a session with an armed `commit timer`
 * (`commitBy` set) is **never** aborted: its change is live and a revert is armed, so that is a decision
 * to present, not cleanup to perform (DR-050). Aborting a session we do not understand would be a
 * destructive guess.
 */
export async function recoverOrphansOn(host: SessionCommandTarget, options: RecoverOrphansOptions = {}): Promise<RecoverOrphansOutcome> {
  const { journal, olderThan, namePrefix = SESSION_NAME_PREFIX, ...request } = options
  const reported = await listSessionsOn(host, { ...request, tolerateErrors: false })
  const journaled = journal === undefined ? [] : (await journal.read()).filter((entry) => entry.endpoint === host.connection.address)
  const byName = new Map(journaled.map((entry) => [entry.name, entry]))
  const now = Date.now()
  const aborted: string[] = []
  const failed: RecoveryCandidate[] = []
  const skipped: RecoveryCandidate[] = []
  const reportedSessions: ConfigSessionSummary[] = []

  for (const session of reported.sessions) {
    reportedSessions.push(session)
    const entry = byName.get(session.name)
    const ours = namePrefix === '' || session.name.startsWith(namePrefix) || entry !== undefined
    if (!ours) {
      skipped.push({ name: session.name, reason: `not matched by the ${JSON.stringify(namePrefix)} prefix and not journaled on ${JSON.stringify(host.connection.address)}` })
      continue
    }
    if (session.commitBy !== undefined) {
      // A session with an armed `commit timer` is not an abandoned orphan: EOS has already applied the
      // change and holds a revert checkpoint (SessionCli.py:109-111, savePreCommitConfig at :196-212).
      // Deciding whether it stands or rolls back is a deliberate operator call, so recovery reports the
      // deadline instead of aborting it (DR-050).
      skipped.push({ name: session.name, reason: `a commit timer revert is armed until ${new Date(session.commitBy * 1000).toISOString()}: confirming or reverting is a decision, not cleanup (SessionCli.py:316-341)` })
      continue
    }
    if (session.state !== 'pending') {
      skipped.push({ name: session.name, reason: `state ${JSON.stringify(session.state)} is not the confirmed pending state (SessionCli.py:67) — reported, not aborted` })
      continue
    }
    if (olderThan !== undefined) {
      if (entry === undefined) {
        skipped.push({ name: session.name, reason: 'olderThan requested but the session is not journaled, and EOS reports no start time (ConfigSessionModel.py:21-34) — age unknown' })
        continue
      }
      const age = now - Date.parse(entry.startedAt)
      if (!Number.isFinite(age) || age < olderThan) {
        skipped.push({ name: session.name, reason: `${String(Math.round(Math.max(age, 0) / 1000))} s old, below the ${String(olderThan)} ms threshold` })
        continue
      }
    }
    try {
      await abortSessionOn(host, session.name, request)
      aborted.push(session.name)
      if (journal !== undefined) await journal.forget(session.name)
    } catch (error) {
      failed.push({ name: session.name, reason: error instanceof Error ? error.message : String(error) })
      // A name EOS no longer has is stale by definition, and pruning it is the point of the journal.
      if (error instanceof CommandError && /non-existent session/u.test(error.message) && journal !== undefined) {
        await journal.forget(session.name)
      }
    }
  }

  // Re-read only when something changed: the second `show configuration sessions` is what proves to a UI
  // that the lock is free again, and skipping it when nothing was aborted keeps the round-trip count honest.
  const after = aborted.length > 0 || failed.length > 0 ? await listSessionsOn(host, { ...request, tolerateErrors: false }) : reported
  return {
    aborted,
    failed,
    skipped,
    remaining: after.sessions.filter((session) => session.state === 'pending' || session.commitBy !== undefined),
    reported: reportedSessions,
  }
}

/** `copy running-config startup-config` — DR-024's explicit durability verb, and never called implicitly (row 61). */
export async function copyRunningToStartupOn(host: SessionCommandTarget, options: SessionRequestOptions = {}): Promise<readonly CommandResult[]> {
  return await runOnHost(host, [copyRunningToStartupCommand()], options)
}

/** Options for {@link Node.configureReplace}. */
export interface ConfigureReplaceOptions extends SessionRequestOptions {
  /** `ignore-errors` — "Replace config, ignoring any errors in loading the config" (`ConfigSessionCli.py:134`). */
  readonly ignoreErrors?: boolean | undefined
  /** `force`, the hidden back-compat spelling which the CLI handler turns into `ignore-errors` (`:141`). */
  readonly force?: boolean | undefined
  /** `md5 <32 hex>` — validated against the CLI's own pattern (`:139`) before the request is built. */
  readonly md5?: string | undefined
  /** `skip-checkpoint` — do not checkpoint the current config first (`:150`, `:52-58`). */
  readonly skipCheckpoint?: boolean | undefined
}

/**
 * `configure replace <url> …` from exec mode (`ConfigSessionCli.py:128-155`): the whole-running-config
 * wholesale replace, which pyeapi never exposes. Dangerous by construction, so the option names are the
 * device's own keywords and nothing is defaulted on the caller's behalf.
 *
 * The pending-commit-timer guard is the device's (`:77-79`) and its rejection is a **message** on a
 * generic `1000 COMMAND_FAILED`, so mapping it to `SessionError` means reading that text — the one place
 * in this milestone where MIGRATION.md §5 row 62 allows it, and only after the code has been checked.
 * A client-side pre-flight (`show configuration sessions` first) is deliberately **not** done: EOS's own
 * check is authoritative and race-free, and a read-then-write pair would be stale the moment another
 * operator commits.
 */
export async function configureReplaceOn(host: SessionCommandTarget, url: string, options: ConfigureReplaceOptions = {}): Promise<readonly CommandResult[]> {
  const { force, ignoreErrors, md5, skipCheckpoint, ...request } = options
  if (url === '' || UNSAFE_URL_TOKEN.test(url)) {
    throw new NotSupportedError(`unsafe configure replace source ${JSON.stringify(url)}: whitespace, quotes and control characters would change the command line (the CLI parses a URL expression, ConfigSessionCli.py:132)`)
  }
  const parts = ['configure replace', url]
  if (force === true) parts.push('force')
  else if (ignoreErrors === true) parts.push('ignore-errors')
  if (md5 !== undefined) {
    if (!MD5_DIGITS.test(md5)) {
      throw new NotSupportedError(`md5 ${JSON.stringify(md5)} is not a 32-digit lowercase hex digest — the CLI pattern is [0-9a-f]{32} (ConfigSessionCli.py:139)`)
    }
    parts.push('md5', md5)
  }
  if (skipCheckpoint === true) parts.push('skip-checkpoint')
  const command = parts.join(' ')
  try {
    return await runOnHost(host, [command], request)
  } catch (error) {
    if (error instanceof CommandError && /Cannot configure replace while session (\S+) is pending/u.test(error.message)) {
      throw new SessionError(
        `configure replace refused: ${error.message.trim()} — a session with a pending commit timer must be confirmed or reverted first (ConfigSessionCli.py:77-79). node.listSessions() shows it; node.abortSession(name) or confirmRevertTimer() ends it (DR-050).`,
        { commands: redactCommands([command]), ...(error.requestId === undefined ? {} : { requestId: error.requestId }), cause: error },
      )
    }
    throw error
  }
}

/**
 * The browser-side journal (PLAN §M5's "browser: `localStorage`"), so a reload can find the session the
 * closed tab left pending. No global is touched: the caller injects the storage object
 * (`window.localStorage`), which keeps this testable in a Node environment and honest about DR-002.
 */
export interface WebStorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** Default key for {@link createWebStorageJournal}. */
export const SESSION_JOURNAL_STORAGE_KEY = 'arista-eapi:sessions'

/**
 * DR-011's choke point for the storage journal, mirroring `FileSessionJournal`'s `toRecord`: a record is
 * **rebuilt field by field**, never spread from the caller's object. `SessionJournalEntry` has no field
 * that could hold a password, but a caller arriving from JS with an option bag that happens to carry
 * `enablePassword` would otherwise have it `JSON.stringify`-ed straight into `localStorage` — which is
 * readable by every script on that origin and is often synced. Keys outside the allow-list are dropped
 * rather than rejected here, because unlike the file journal this one also rewrites entries it merely
 * read back, and a recovery path must not die on a stale record.
 */
function toStoredEntry(entry: SessionJournalEntry): SessionJournalEntry {
  const { pid, description } = entry
  return {
    name: entry.name,
    endpoint: entry.endpoint,
    startedAt: entry.startedAt,
    ...(typeof pid === 'number' && Number.isInteger(pid) ? { pid } : {}),
    ...(typeof description === 'string' && description !== '' ? { description } : {}),
  }
}

/**
 * A {@link SessionJournal} over a web storage object. Same allow-list discipline as the Node file
 * journal: a stored record is rebuilt field by field, so a password can never ride along by accident,
 * and corrupt JSON reads as empty rather than throwing in a recovery path.
 */
export function createWebStorageJournal(storage: WebStorageLike, key = SESSION_JOURNAL_STORAGE_KEY): SessionJournal {
  function read(): SessionJournalEntry[] {
    const text = storage.getItem(key)
    if (text === null || text === '') return []
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return []
    }
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((candidate) => {
      const record = asRecord(candidate)
      if (record === undefined) return []
      const name = readString(record['name'])
      const endpoint = readString(record['endpoint'])
      const startedAt = readString(record['startedAt'])
      if (name === undefined || endpoint === undefined || startedAt === undefined) return []
      const pid = readNumber(record['pid'])
      const description = readString(record['description'])
      return [{ name, endpoint, startedAt, ...(pid === undefined ? {} : { pid }), ...(description === undefined ? {} : { description }) }]
    })
  }

  function write(entries: readonly SessionJournalEntry[]): void {
    storage.setItem(key, JSON.stringify(entries.map(toStoredEntry)))
  }

  return {
    async read() {
      return read()
    },
    async record(entry) {
      const others = read().filter((candidate) => candidate.name !== entry.name)
      write([...others, entry])
    },
    async forget(name) {
      write(read().filter((entry) => entry.name !== name))
    },
  }
}
