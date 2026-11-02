/**
 * Error taxonomy for the eAPI client — M1 (#3), port of the error classes in
 * `pyeapi/eapilib.py` (BSD-3-Clause, Arista Networks — DR-001) with the DR-010 code set and the
 * DR-011 redaction contract applied on top.
 *
 * Rules (docs/ARCHITECTURE.md §4):
 *  - every error carries `commands` (the `CommandSpec[]` that produced it) and `requestId` (DR-017);
 *  - message text reaching a user is already redacted — DR-011;
 *  - branch on `code`, never on message text: EOS wording is not API.
 *
 * `erasableSyntaxOnly` forbids `const enum` (TS 7), so the codes are a frozen data map.
 * There is **no 1007** on EOS 4.28.13.1M, and the legacy `EAPI_E_*` names are not in this build
 * (DR-010, verified from `Base.sqsh:/usr/lib/python3.9/site-packages/CliCommon.py:11-33`).
 */

import type { CommandResult, CommandSpec, ErrorDetailEntry, JsonRpcId } from './types/eapi'

/** JSON-RPC spec codes + the EOS `CliCommon` command codes, as data (DR-010). */
export const EapiErrorCode = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  COMMAND_FAILED: 1000,
  COMMAND_EXCEPTION: 1001,
  COMMAND_INVALID: 1002,
  COMMAND_UNCONVERTED: 1003,
  COMMAND_INCOMPATIBLE: 1004,
  COMMAND_UNAUTHORIZED: 1005,
  COMMAND_CONFIG_LOCKED: 1006,
} as const)

/** Codes whose rendering keeps the `[commandError]` suffix, exactly as pyeapi renders them. */
const BRACKETED_CODES: readonly number[] = [
  EapiErrorCode.COMMAND_FAILED,
  EapiErrorCode.COMMAND_EXCEPTION,
  EapiErrorCode.COMMAND_INVALID,
  EapiErrorCode.COMMAND_INCOMPATIBLE,
]

/**
 * `Error [<code>]: <message> [<commandError>]` for 1000/1001/1002/1004, else `Error [<code>]: <message>`.
 * Byte-comparable with pyeapi (`eapilib.py:107-121`) so a device-sourced message can be diffed
 * against a pyeapi run. **Deliberate divergence:** pyeapi renders the literal `None` inside the
 * brackets when there is no `error.data`; we drop the brackets instead — MIGRATION.md §5 row 19.
 */
export function renderCommandError(code: number, message: string, commandError?: string): string {
  if (commandError !== undefined && BRACKETED_CODES.includes(code)) {
    return `Error [${code}]: ${message} [${commandError}]`
  }
  return `Error [${code}]: ${message}`
}

/** Symbolic name for a code — for logs and the capability probe (DR-033). `unknown (<code>)` otherwise. */
export function eapiErrorName(code: number): string {
  for (const [name, value] of Object.entries(EapiErrorCode)) {
    if (value === code) return name
  }
  return `unknown (${code})`
}

export interface EapiErrorOptions {
  /** The commands that produced this failure, exactly as they went on the wire (redacted where needed). */
  readonly commands?: readonly CommandSpec[] | undefined
  /** The id of the request that failed, so a device log line and a browser console line match (DR-017). */
  readonly requestId?: JsonRpcId | undefined
  readonly cause?: unknown
}

/** Base class for everything this package throws. Never raise it directly. */
export class EapiError extends Error {
  readonly commands: readonly CommandSpec[] | undefined
  readonly requestId: JsonRpcId | undefined

  constructor(message: string, options: EapiErrorOptions = {}) {
    super(message, { cause: options.cause })
    this.name = 'EapiError'
    this.commands = options.commands
    this.requestId = options.requestId
  }

  /** Structured form for `JSON.stringify`, log pipelines and the webui's error panel (DR-011 safe). */
  toJSON(): Record<string, unknown> {
    return { name: this.name, message: this.message, requestId: this.requestId, commands: this.commands }
  }
}

/** A command pair from `CommandError#trace()` — pyeapi's `get_trace` entries (`eapilib.py:143-160`). */
export interface TraceEntry {
  readonly command: CommandSpec | undefined
  readonly output?: CommandResult | undefined
}

export interface CommandErrorOptions extends EapiErrorOptions {
  /** pyeapi's `err`: the rendered `error.data` text that goes into the `[...]` suffix. Redacted. */
  readonly commandError?: string | undefined
  /** pyeapi's `output`: the per-command results that came back with the failure (`error.data`). */
  readonly results?: readonly CommandResult[] | undefined
  /** Present only for the `includeErrorDetail: true` shape; absent for the plain-array shape. */
  readonly errorDetail?: readonly ErrorDetailEntry[] | undefined
  readonly failedCommand?: CommandSpec | undefined
}

/**
 * A failure reported *by the device* inside a JSON-RPC `error` envelope — command codes
 * (1000-1006) and the JSON-RPC codes (-327xx) both land here, as in pyeapi, so unknown codes
 * (e.g. 9999 in the upstream tests) stay representable instead of becoming a parse failure.
 */
export class CommandError extends EapiError {
  readonly code: number
  readonly commandError: string | undefined
  readonly results: readonly CommandResult[]
  readonly errorDetail: readonly ErrorDetailEntry[] | undefined
  readonly failedCommand: CommandSpec | undefined

  constructor(code: number, message: string, options: CommandErrorOptions = {}) {
    super(renderCommandError(code, message, options.commandError), options)
    this.name = 'CommandError'
    this.code = code
    this.commandError = options.commandError
    this.results = options.results ?? []
    this.errorDetail = options.errorDetail
    this.failedCommand = options.failedCommand
  }

  /**
   * pyeapi's `get_trace()`: pair each command with the output the device managed to produce, then
   * list the commands that never ran. **Deliberate divergence:** pyeapi's `if index:` guard drops
   * the tail whenever exactly one command produced output, so a 1-of-N failure loses commands 2..N
   * from the trace; ours keeps them — MIGRATION.md §5 row 20.
   */
  trace(): TraceEntry[] {
    const entries: TraceEntry[] = []
    const commands = this.commands ?? []
    const paired = Math.min(commands.length, this.results.length)
    for (let index = 0; index < paired; index += 1) {
      entries.push({ command: commands[index], output: this.results[index] })
    }
    for (let index = paired; index < commands.length; index += 1) {
      entries.push({ command: commands[index] })
    }
    return entries
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      code: this.code,
      codeName: eapiErrorName(this.code),
      commandError: this.commandError,
      failedCommand: this.failedCommand,
      results: this.results,
      errorDetail: this.errorDetail,
    }
  }
}

/**
 * Additions M2 (#4) makes to M1's `TransportError`, all optional and additive — the wire-level facts
 * a UI needs to decide what to render: which endpoint failed, which HTTP status came back, and
 * whether re-sending is safe. pyeapi has nothing comparable: it folds every wire failure into one
 * `ConnectionError(connection_type, message)` and stashes the last one on the connection
 * (`eapilib.py:145-167`, `:425-427`) — MIGRATION.md §5 row 21.
 */
export interface TransportErrorOptions extends EapiErrorOptions {
  /** HTTP status, when the failure came from a real response line (401/403/405/5xx…). */
  readonly status?: number | undefined
  /** Where the request went: `https://sw1:443/command-api`, `unix:/var/run/command-api.sock`. */
  readonly endpoint?: string | undefined
  /**
   * Hint from DR-019's failure taxonomy: `true` means the request never reached the device, so
   * re-sending is safe *and* the client may do it itself when `readOnly: true`. `false` means the
   * device may already have executed the commands (a timeout, or a reset after the body was written),
   * which for a configuration write is the answer that matters. `undefined` = we cannot tell.
   */
  readonly retryable?: boolean | undefined
}

/** Everything below the JSON-RPC layer: DNS, TCP, TLS, HTTP status, timeouts. Subtypes in M2 (#4). */
export class TransportError extends EapiError {
  readonly status: number | undefined
  readonly endpoint: string | undefined
  readonly retryable: boolean | undefined

  constructor(message: string, options: TransportErrorOptions = {}) {
    super(message, options)
    this.name = 'TransportError'
    this.status = options.status
    this.endpoint = options.endpoint
    this.retryable = options.retryable
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), status: this.status, endpoint: this.endpoint, retryable: this.retryable }
  }
}

/** HTTP 401/403 from eAPI (and a bad `/login` for the cookie transports) — pyeapi raises `ConnectionError`. */
export class AuthError extends TransportError {
  constructor(message: string, options: TransportErrorOptions = {}) {
    super(message, options)
    this.name = 'AuthError'
  }
}

/** Handshake / certificate failure. Trust decisions are DR-013, never a silent default. */
export class TlsError extends TransportError {
  constructor(message: string, options: TransportErrorOptions = {}) {
    super(message, options)
    this.name = 'TlsError'
  }
}

/** Refused / unreachable / DNS. The only class M2 may retry once, and only for `readOnly` (DR-019). */
export class ConnectError extends TransportError {
  constructor(message: string, options: TransportErrorOptions = {}) {
    super(message, options)
    this.name = 'ConnectError'
  }
}

/** The request deadline fired (`AbortController` in M2, `requestTimeout` server-side in runCmds). */
export class TimeoutError extends TransportError {
  constructor(message: string, options: TransportErrorOptions = {}) {
    super(message, options)
    this.name = 'TimeoutError'
  }
}

export interface ProtocolErrorOptions extends EapiErrorOptions {
  /** The JSON-RPC code involved when the device supplied one (`-32700` for a body we could not parse). */
  readonly code?: number | undefined
  /** Unparseable response body, redacted then truncated to the `parseResponse` limit (PLAN M1). */
  readonly rawBody?: string | undefined
}

/** The bytes we got back are not a usable eAPI envelope, or a client request is malformed. */
export class ProtocolError extends EapiError {
  readonly code: number | undefined
  readonly rawBody: string | undefined

  constructor(message: string, options: ProtocolErrorOptions = {}) {
    super(message, options)
    this.name = 'ProtocolError'
    this.code = options.code
    this.rawBody = options.rawBody
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), code: this.code, rawBody: this.rawBody }
  }
}

/** Config-session state violations (M5 #7): not open, already open, locked, interleaved with `configure`. */
export class SessionError extends EapiError {
  constructor(message: string, options: EapiErrorOptions = {}) {
    super(message, options)
    this.name = 'SessionError'
  }
}

/** A parameter, transport kind or option this client refuses — the "-32602 class" of programming mistakes. */
export class NotSupportedError extends EapiError {
  constructor(message: string, options: EapiErrorOptions = {}) {
    super(message, options)
    this.name = 'NotSupportedError'
  }
}
