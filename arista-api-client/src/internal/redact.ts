/**
 * Secret redaction — DR-011, a deliberate fix over pyeapi (#3 / M1).
 *
 * pyeapi scrubs `input=` from an error message **only for code 1005** (`eapilib.py:111-116`) and
 * sanitises only the outgoing request for its debug log (`eapilib.py:488-500`, `eapilib.py:429`),
 * while logging the raw response body (`eapilib.py:445`). EOS builds the message as
 * `CLI command N of M '<cmd>' failed: …` and `CliCommand.__str__` appends `input=%r` verbatim for
 * *any* code (`JsonCli.py:437-444`, `CliApi.py:277-287`), so an enable password leaks on
 * 1000/1001/1002/1004 as readily as on 1005.
 *
 * This module is narrow and purpose-built: pyeapi's general `json_match` walker
 * (`eapilib.py:502-566`, `_find_sub_json`) is **not** ported (DR-011, MIGRATION.md §7).
 * Redaction keeps structure and replaces the value with `<redacted>`, so the operator can still
 * see which command failed and what kind of secret was attached.
 */

import type { CommandSpec } from '../types/eapi'

/** The replacement token. Kept short and unmistakable in logs, fixtures and error panels. */
export const REDACTED = '<redacted>'

/**
 * `input=<value>` as EOS renders it in error text (`input=%r`): a Python-literal-looking single- or
 * double-quoted string, or a bare token. The closing quote is kept *out* of the replacement so the
 * surrounding text stays readable — pyeapi's replacement (`eapilib.py:115`) swallows it and emits a
 * stray `)`.
 *
 * The bare-token class deliberately stops at quote/bracket/comma characters: the codec renders
 * `error.data` with Python `repr()` semantics first, so a redacted value is followed by `']`/`}` and
 * re-running this rule over that text must not eat the repr's own punctuation (idempotency).
 */
const INPUT_ASSIGNMENT = /(\binput\s*=\s*)(?:'[^'\\]*(?:\\.[^'\\]*)*'|"[^"\\]*(?:\\.[^"\\]*)*"|[^\s,;)'"\]{}]+)/gi

/**
 * `username <name> … secret|password [plain|sha512|md5|text|both|encrypted|0|5|7] <value>` — the
 * algorithm marker is kept (it tells the operator how the credential is stored), the value is not.
 * The value runs to the end of the line, stopping at an unescaped apostrophe so a device message
 * like `CLI command 2 of 3 'username admin secret plain pw' failed: …` keeps its quoting and its
 * trailing prose. A quoted value may contain spaces. Known limit, deliberately not worked around:
 * a password containing an apostrophe is redacted only up to that apostrophe — prefer a priv-15 API
 * user with `sendEnable: false` (DR-009) over any scheme that has to guess where a secret ends.
 *
 * Matched within one line, so a `username` statement without a credential can never reach across
 * into the next section of a config blob.
 */
const USERNAME_CREDENTIAL =
  /(\busername[^\n]*?\b(?:secret|password))((?:[^\S\n]+(?:plain|sha512|md5|text|both|encrypted|[057]))?)([^\S\n]+)(?:'[^'\n]*'|"[^"\n]*"|[^\n']*)/gi

/** `enable` (optionally with arguments) — the only command whose `input` is treated as a secret. */
const ENABLE_COMMAND = /^enable(?:\s|$)/i

/**
 * A JSON member whose **name** declares it holds a credential. eAPI's own envelopes have no such
 * keys, but everything around eAPI does: the `/login` body the cookie transports post (DR-018) and
 * the HTML/JSON an intermediary reflects back into an error's `rawBody`. Matching on the key is the
 * reliable half of DR-011 — unlike the text rules it never has to guess where a secret ends.
 */
const SECRET_KEY = /^(?:password|passwd|password1|secret|enable[_-]?password|api[_-]?key|token|authorization)$/i

/** Redacts secrets inside a single piece of device or command text. Idempotent. */
export function redactCommandText(text: string): string {
  return text
    .replace(INPUT_ASSIGNMENT, `$1${REDACTED}`)
    .replace(USERNAME_CREDENTIAL, `$1$2$3${REDACTED}`)
}

function isCommandObject(value: unknown): value is { cmd: unknown; input?: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'cmd' in value
}

/**
 * Structural redaction of a command list, as it appears in a request body: the `input` of an
 * `enable` command is a password, and every command *string* goes through `redactCommandText`
 * (covering the `username … secret …` form).
 */
export function redactCommands(commands: readonly CommandSpec[]): CommandSpec[] {
  return commands.map((command): CommandSpec => {
    if (typeof command === 'string') return redactCommandText(command)
    const redacted: { cmd: string; input?: string; revision?: number } = {
      ...command,
      cmd: redactCommandText(command.cmd),
    }
    if (typeof command.cmd === 'string' && ENABLE_COMMAND.test(command.cmd) && typeof command.input === 'string') {
      redacted.input = REDACTED
    }
    return redacted
  })
}

/**
 * Deep redaction of an arbitrary JSON value (device `error.data`, recorded fixtures, log payload).
 * Enables an `enable`-style `{cmd, input}` object wherever it is nested, and run every string
 * through `redactCommandText`.
 */
export function redactSecrets(value: unknown): unknown {
  if (typeof value === 'string') return redactCommandText(value)
  if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry))
  if (value === null || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'input' && isCommandObject(value) && typeof value.cmd === 'string' && ENABLE_COMMAND.test(value.cmd)) {
      out[key] = REDACTED
      continue
    }
    if (SECRET_KEY.test(key) && typeof entry === 'string' && entry !== '') {
      out[key] = REDACTED
      continue
    }
    out[key] = redactSecrets(entry)
  }
  return out
}

/**
 * Log-safe rendering of a wire body (request **or** response), the DR-011 replacement for pyeapi's
 * `_sanitize_request` plus the response log pyeapi never sanitised. JSON is redacted structurally
 * and re-serialised; a body that is not JSON (truncated proxy error page, TLS alert text) falls
 * back to a text pass so the secret still cannot escape into a log line.
 */
export function redactWireText(text: string): string {
  try {
    return JSON.stringify(redactSecrets(JSON.parse(text) as unknown))
  } catch {
    return redactCommandText(text)
  }
}
