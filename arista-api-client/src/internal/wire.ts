/**
 * The eAPI wire codec — M1 (#3). Pure functions, zero I/O: `docs/ARCHITECTURE.md` §2 puts
 * everything about the JSON-RPC contract here, and the M1 exit gate is "encode + decode are pure
 * (no I/O), fully covered, and fixture-driven".
 *
 * Port of the codec half of `pyeapi/eapilib.py` (`EapiConnection.request` / `send` /
 * `_parse_error_message`, BSD-3-Clause, Arista Networks — DR-001), with the documented fixes
 * DR-010..DR-012 and DR-016/DR-017. The transport subclasses (`http.client`, TLS, cookies, unix
 * sockets) are **not** here — they are M2 (#4). The seam M2 plugs into is `WireSender`.
 */

import {
  CommandError,
  EapiErrorCode,
  NotSupportedError,
  ProtocolError,
  type CommandErrorOptions,
} from '../errors'
import { redactCommandText, redactCommands, redactSecrets } from './redact'
import type {
  CommandResult,
  CommandSpec,
  ErrorDetailData,
  ErrorDetailEntry,
  JsonRpcFailure,
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcSuccess,
  RunCmdsFormat,
  RunCmdsParams,
  RunCmdsVersion,
  RequestIdPolicy,
  WireSender,
} from '../types/eapi'

/** How much of an unparseable body a `ProtocolError` keeps. Enough to debug, bounded for logs (PLAN M1). */
export const MAX_RAW_BODY = 2048

/**
 * The `runCmds` parameter allow-list (DR-016): pyeapi's six (`eapilib.py:352-355`) plus the three
 * the device accepts and pyeapi drops. `streaming` is excluded on purpose — DR-016, MIGRATION.md §7.
 */
export const RUN_CMDS_PARAM_KEYS: readonly string[] = [
  'version',
  'format',
  'cmds',
  'autoComplete',
  'expandAliases',
  'timestamps',
  'stopOnError',
  'includeErrorDetail',
  'requestTimeout',
]

/** A command object has exactly these three keys server-side (`JsonCli.py:36-39`). */
export const COMMAND_OBJECT_KEYS: readonly string[] = ['cmd', 'input', 'revision']

/** `buildRequest` options that belong to the envelope, not to `params`. */
const ENVELOPE_OPTION_KEYS: readonly string[] = ['id', 'ids']

export interface BuildRequestOptions {
  readonly version?: RunCmdsVersion | undefined
  readonly format?: RunCmdsFormat | undefined
  readonly autoComplete?: boolean | undefined
  readonly expandAliases?: boolean | undefined
  readonly timestamps?: boolean | undefined
  readonly stopOnError?: boolean | undefined
  readonly includeErrorDetail?: boolean | undefined
  /** Seconds, server-side (DR-019 keeps the transport timeout separate, in M2). */
  readonly requestTimeout?: number | undefined
  /** Pin a specific id (replays, fixture matching). Otherwise the `ids` policy decides. */
  readonly id?: JsonRpcId | undefined
  /** The per-connection id policy (DR-017). A transport owns one; a one-off call gets a one-shot id. */
  readonly ids?: RequestIdPolicy | undefined
}

export interface RequestIdOptions {
  /** Caller-supplied prefix, e.g. a UI session or a CLI run id, so ids are traceable end to end. */
  readonly nonce?: string | undefined
  /** Override the random client segment — deterministic ids in tests and recorded fixtures. */
  readonly seed?: string | undefined
  /** First sequence number handed out; defaults to 1. */
  readonly start?: number | undefined
}

function randomToken(): string {
  const buffer = globalThis.crypto?.getRandomValues?.(new Uint8Array(6))
  if (buffer) return Array.from(buffer, (byte) => byte.toString(16).padStart(2, '0')).join('')
  // No WebCrypto in the environment: uniqueness is best-effort, still per-connection monotonic after it.
  return Math.random().toString(36).slice(2, 10)
}

/**
 * `<clientId>-<seq>` request ids (DR-017) — monotonic for one connection, with an optional client
 * nonce. pyeapi's default `reqid = id(self)` is a CPython memory address and correlates with nothing.
 */
export function createRequestIds(options: RequestIdOptions = {}): RequestIdPolicy {
  const seed = options.seed ?? randomToken()
  const clientId = options.nonce === undefined ? seed : `${options.nonce}-${seed}`
  let sequence = options.start ?? 0
  return {
    clientId,
    next(): JsonRpcId {
      sequence += 1
      return `${clientId}-${sequence}`
    },
  }
}

function assertAllowedOptions(options: BuildRequestOptions): void {
  for (const key of Object.keys(options)) {
    if (ENVELOPE_OPTION_KEYS.includes(key) || RUN_CMDS_PARAM_KEYS.includes(key)) continue
    throw new NotSupportedError(
      `unsupported runCmds parameter '${key}': EOS accepts only ${RUN_CMDS_PARAM_KEYS.filter(
        (param) => param !== 'cmds',
      ).join(', ')} (DR-016)`,
    )
  }
}

/**
 * DR-041: pyeapi's implicit `make_iterable` coercion (`eapilib.py:353`, `client.py:913`) becomes an
 * **explicit** coercion at the boundary. Exported because the command layer (M4, #6) and every
 * resource module (M7, #9) need the same one coercion — silently coercing inside two layers is how a
 * `undefined` sneaks onto the wire.
 */
export function toCommandSpecArray(commands: CommandSpec | readonly CommandSpec[]): readonly CommandSpec[] {
  return Array.isArray(commands) ? commands : [commands as CommandSpec]
}

function assertCommandSpec(command: unknown, index: number, commands: readonly CommandSpec[]): void {
  if (typeof command === 'string') {
    if (command.trim() === '') {
      throw new TypeError(`command ${index} must not be empty: ${JSON.stringify(commands)}`)
    }
    return
  }
  if (typeof command !== 'object' || command === null || Array.isArray(command)) {
    throw new TypeError(`command ${index} must be a string or {cmd, input?, revision?}: ${JSON.stringify(commands)}`)
  }
  const record = command as unknown as Record<string, unknown>
  if (typeof record['cmd'] !== 'string' || record['cmd'].trim() === '') {
    throw new TypeError(`command ${index} is missing a non-empty 'cmd': ${JSON.stringify(commands)}`)
  }
  for (const key of Object.keys(record)) {
    if (!COMMAND_OBJECT_KEYS.includes(key)) {
      // A stray `streaming`/`revision`-style key is a -32602 waiting to happen on the device.
      throw new NotSupportedError(
        `unsupported command parameter '${key}' in command ${index}: an eAPI command object has exactly ${COMMAND_OBJECT_KEYS.join(', ')}`,
      )
    }
  }
  if ('input' in record && typeof record['input'] !== 'string') {
    throw new TypeError(`command ${index} has a non-string 'input': ${JSON.stringify(commands)}`)
  }
  if ('revision' in record && (typeof record['revision'] !== 'number' || !Number.isInteger(record['revision']))) {
    throw new TypeError(`command ${index} has a non-integer 'revision': ${JSON.stringify(commands)}`)
  }
}

function assertAllowedFormat(format: unknown): RunCmdsFormat {
  // pyeapi raises TypeError('encoding must be one of [json, text]') in `execute` (`eapilib.py:628-629`).
  if (format !== 'json' && format !== 'text') {
    throw new TypeError(`format must be one of [json, text], got ${JSON.stringify(format)}`)
  }
  return format
}

function assertAllowedVersion(version: unknown): RunCmdsVersion {
  if (version !== 1 && version !== 'latest') {
    throw new TypeError(`version must be 1 or 'latest', got ${JSON.stringify(version)}`)
  }
  return version
}

/**
 * Build a `runCmds` request (DR-016/DR-017). Unknown parameters are rejected here rather than
 * silently dropped as pyeapi does (`eapilib.py:352-355`), because a typo'd parameter is otherwise
 * invisible until the device answers `-32602`.
 */
export function buildRequest(
  commands: CommandSpec | readonly CommandSpec[],
  options: BuildRequestOptions = {},
): JsonRpcRequest {
  assertAllowedOptions(options)
  const specs = toCommandSpecArray(commands)
  specs.forEach((command, index) => assertCommandSpec(command, index, specs))

  const params: { -readonly [K in keyof RunCmdsParams]: RunCmdsParams[K] } = {
    version: assertAllowedVersion(options.version ?? 1),
    cmds: specs,
    format: assertAllowedFormat(options.format ?? 'json'),
  }
  // The device's own defaults stay the device's; we only send what the caller asked for.
  for (const key of ['autoComplete', 'expandAliases', 'timestamps', 'stopOnError', 'includeErrorDetail'] as const) {
    const value = options[key]
    if (value !== undefined) params[key] = value
  }
  if (options.requestTimeout !== undefined) {
    if (typeof options.requestTimeout !== 'number' || !Number.isFinite(options.requestTimeout) || options.requestTimeout <= 0) {
      throw new TypeError(`requestTimeout must be a positive number of seconds, got ${String(options.requestTimeout)}`)
    }
    params.requestTimeout = options.requestTimeout
  }

  return {
    jsonrpc: '2.0',
    method: 'runCmds',
    id: options.id ?? (options.ids ?? createRequestIds()).next(),
    params,
  }
}

/** pyeapi's `%r` for a JSON value, so the `[...]` half of a `CommandError` message stays comparable. */
export function pythonRepr(value: unknown): string {
  if (typeof value === 'string') return pythonStringRepr(value)
  if (typeof value === 'number') return Object.is(value, -0) ? '-0.0' : String(value)
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  if (value === null || value === undefined) return 'None'
  if (Array.isArray(value)) return `[${value.map((entry) => pythonRepr(entry)).join(', ')}]`
  if (typeof value === 'object') {
    const parts = Object.entries(value as Record<string, unknown>).map(
      ([key, entry]) => `${pythonStringRepr(key)}: ${pythonRepr(entry)}`,
    )
    return `{${parts.join(', ')}}`
  }
  return String(value)
}

function pythonStringRepr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'"
  let out = ''
  for (const char of value) {
    if (char === quote || char === '\\') out += `\\${char}`
    else if (char === '\n') out += '\\n'
    else if (char === '\r') out += '\\r'
    else if (char === '\t') out += '\\t'
    // Python writes the C0 controls (and \x7f) as \xNN.
    else if (char < ' ') out += `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`
    else out += char
  }
  return `${quote}${out}${quote}`
}

/**
 * pyeapi `_parse_error_message` (`eapilib.py:544-566`): every key of every object in `error.data`
 * flattened into `k: <repr(v)>` pairs and joined with `, `. That string is what pyeapi renders in
 * the `[...]` suffix and it is where EOS echoes `input='<enable password>'` — so it is redacted.
 */
export function formatErrorDataEntries(entries: readonly unknown[]): string {
  const parts: string[] = []
  for (const entry of entries.map((value) => redactSecrets(value))) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      parts.push(`<unparsed entry: ${pythonRepr(entry)}>`)
      continue
    }
    for (const [key, value] of Object.entries(entry as Record<string, unknown>)) {
      parts.push(`${key}: ${pythonRepr(value)}`)
    }
  }
  return redactCommandText(parts.join(', '))
}

const UNSUPPORTED_PARAM = /unexpected keyword argument '(.*)'/
/**
 * pyeapi's `-32602` decoration (`eapilib.py:460-468`): EOS answers an unknown `runCmds` kwarg with
 * `runCmds() got an unexpected keyword argument 'x'`, so append the human explanation pyeapi adds.
 * Applied to whatever code the device used, exactly as pyeapi does.
 */
export function decorateUnsupportedParam(message: string): string {
  const match = UNSUPPORTED_PARAM.exec(message)
  if (!match) return message
  const parameter = match[1] ?? ''
  return `${message}. ${parameter} parameter is not supported in this version of EOS.`
}

export interface ResponseContext {
  /** Attached to the resulting error so it can say *which* commands failed (pyeapi does the same). */
  readonly commands?: readonly CommandSpec[] | undefined
  /**
   * The id of the request this body is answering — M2 (#4) added this, closing the gap PR #19
   * recorded for M1 ("`ProtocolError` currently carries no `requestId`"). EOS echoes `id` back, and
   * when it is present it still wins: this only fills the gap for a body that omits it, so an error
   * object always has something a device log can be grepped for (DR-017).
   *
   * Note what this is **not**: it is not a correlation check. Refusing a response whose id belongs to
   * another request is a property of the round trip, so it lives at the transport seam
   * (`src/transports/correlate.ts`) and keeps the codec pairing-independent — which is what lets the
   * 27 wire fixtures be decoded without reference to the request that produced them.
   */
  readonly requestId?: JsonRpcId | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readId(value: unknown): JsonRpcId | undefined {
  return typeof value === 'string' || typeof value === 'number' ? value : undefined
}

function truncateBody(body: string): string {
  return body.length <= MAX_RAW_BODY
    ? body
    : `${body.slice(0, MAX_RAW_BODY)}… [truncated ${body.length - MAX_RAW_BODY} chars]`
}

function protocolError(message: string, body: string, context: ResponseContext, code?: number): ProtocolError {
  return new ProtocolError(message, {
    code,
    rawBody: truncateBody(redactCommandText(body)),
    commands: safeCommands(context.commands),
    ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
  })
}

/** `error.data` with `includeErrorDetail: true` is an object; the default shape is the per-command array. */
function isErrorDetailData(value: unknown): value is ErrorDetailData {
  if (!isRecord(value)) return false
  return 'result' in value || 'errorDetail' in value
}

function readErrorDetail(value: unknown): readonly ErrorDetailEntry[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter(isRecord).map((entry): ErrorDetailEntry => {
    const detail: { index?: number; code?: number; message?: string; cmd?: string } = {}
    if (typeof entry['index'] === 'number') detail.index = entry['index']
    if (typeof entry['code'] === 'number') detail.code = entry['code']
    // Device detail text repeats `input='<enable password>'` for most codes — DR-011.
    if (typeof entry['message'] === 'string') detail.message = redactCommandText(entry['message'])
    if (typeof entry['cmd'] === 'string') detail.cmd = redactCommandText(entry['cmd'])
    return detail
  })
}

/** Redacted copy of the request's commands, for the `commands` field every error carries. */
function safeCommands(commands: readonly CommandSpec[] | undefined): readonly CommandSpec[] | undefined {
  return commands === undefined ? undefined : redactCommands(commands)
}

/**
 * Best-effort "which command failed", in decreasing trust order: the device's own `errorDetail`
 * entry, then the per-command `errors` marker in `error.data`, then the `CLI command N of M`
 * prefix EOS prints. Codes stay the API — this only fills a display field (`failedCommand`).
 */
function deriveFailedCommand(
  message: string,
  data: unknown,
  detail: readonly ErrorDetailEntry[] | undefined,
  commands: readonly CommandSpec[] | undefined,
): CommandSpec | undefined {
  const at = (index: number | undefined): CommandSpec | undefined =>
    index !== undefined && index >= 0 && commands !== undefined && index < commands.length ? commands[index] : undefined
  const safe = (command: CommandSpec | undefined): CommandSpec | undefined =>
    command === undefined ? undefined : redactCommands([command])[0]

  for (const entry of detail ?? []) {
    if (typeof entry.cmd === 'string') return redactCommandText(entry.cmd)
    const byIndex = at(entry.index)
    if (byIndex !== undefined) return safe(byIndex)
  }
  if (Array.isArray(data)) {
    const flagged = data.findIndex((entry) => isRecord(entry) && 'errors' in entry)
    const byIndex = at(flagged)
    if (byIndex !== undefined) return safe(byIndex)
  }
  const quoted = /CLI command \d+ of \d+ '(.*)' failed/i.exec(message)
  if (quoted?.[1] !== undefined) return redactCommandText(quoted[1])
  const numbered = /CLI command (\d+) of \d+/i.exec(message)
  if (numbered?.[1] !== undefined) return safe(at(Number(numbered[1]) - 1))
  return undefined
}

/**
 * Turn a validated failure envelope into the `CommandError` pyeapi would have raised, with both
 * `error.data` shapes handled (DR-010, DR-011) and the `-32602` decoration applied.
 */
export function parseErrorEnvelope(failure: JsonRpcFailure, context: ResponseContext = {}): CommandError {
  const rawMessage = failure.error.message
  const decorated = decorateUnsupportedParam(rawMessage)
  // One redacted copy of `error.data` feeds the rendered `[...]` text, `results` and the returned
  // envelope, so no path can smuggle an unretouched value out of a serialised error (DR-011).
  const data = redactSecrets(failure.error.data)
  const detail = isErrorDetailData(data) ? readErrorDetail(data.errorDetail) : undefined
  // `data` absent entirely → no `[...]` suffix at all. pyeapi prints the literal `None` there;
  // `data: []` still renders an empty `[]`, exactly as pyeapi's empty join does.
  const hasData = failure.error.data !== undefined

  const options: { -readonly [K in keyof CommandErrorOptions]: CommandErrorOptions[K] } = {
    // The commands an error carries must be redacted too: an `enable` command object is the secret.
    commands: safeCommands(context.commands),
    // The envelope's own id wins; the context id is the fallback for a body that omits one (DR-017).
    requestId: failure.id ?? context.requestId,
    commandError: hasData ? formatErrorDataEntries(errorDataEntries(data)) : undefined,
  }
  if (Array.isArray(data)) {
    options.results = data as readonly CommandResult[]
  } else if (isErrorDetailData(data)) {
    options.results = (data.result ?? []) as readonly CommandResult[]
    options.errorDetail = detail
  }
  // `failedCommand` is derived from the *raw* data (the `errors` marker must survive redaction to be
  // found), then redacted on the way out.
  options.failedCommand = deriveFailedCommand(rawMessage, failure.error.data, detail, context.commands)
  return new CommandError(failure.error.code, redactCommandText(decorated), options)
}

/** The list of objects pyeapi iterated to build its `err` text, for either `error.data` shape. */
function errorDataEntries(data: unknown): readonly unknown[] {
  if (Array.isArray(data)) return data
  if (isErrorDetailData(data)) return data.errorDetail ?? data.result ?? []
  return []
}

export type ParsedResponse = { readonly ok: true; readonly envelope: JsonRpcSuccess } | { readonly ok: false; readonly envelope?: JsonRpcFailure; readonly error: CommandError | ProtocolError }

/**
 * Decode one eAPI response body. **Never throws for an error envelope** — it returns the failure
 * and lets the caller decide (PLAN M1). Only a body that is not a usable envelope fails, and it
 * fails as a `ProtocolError` carrying the redacted, truncated raw text.
 */
export function parseResponse(text: string, context: ResponseContext = {}): ParsedResponse {
  let decoded: unknown
  try {
    decoded = JSON.parse(text)
  } catch {
    return { ok: false, error: protocolError('eAPI response is not valid JSON', text, context, EapiErrorCode.PARSE_ERROR) }
  }

  if (!isRecord(decoded)) {
    return { ok: false, error: protocolError('eAPI response must be a JSON object', text, context, EapiErrorCode.INVALID_REQUEST) }
  }
  if ('jsonrpc' in decoded && decoded['jsonrpc'] !== '2.0') {
    return { ok: false, error: protocolError(`unsupported jsonrpc version ${pythonRepr(decoded['jsonrpc'])}`, text, context, EapiErrorCode.INVALID_REQUEST) }
  }

  const id = readId(decoded['id'])
  const hasError = 'error' in decoded
  const hasResult = 'result' in decoded
  if (hasError === hasResult) {
    return {
      ok: false,
      error: protocolError(
        `eAPI response must carry exactly one of result/error (got result=${String(hasResult)}, error=${String(hasError)})`,
        text,
        context,
        EapiErrorCode.INVALID_REQUEST,
      ),
    }
  }

  if (hasError) {
    const error = decoded['error']
    if (!isRecord(error) || typeof error['code'] !== 'number' || !Number.isFinite(error['code'])) {
      return { ok: false, error: protocolError('eAPI error envelope is missing a numeric code', text, context, EapiErrorCode.INVALID_REQUEST) }
    }
    if (typeof error['message'] !== 'string') {
      return { ok: false, error: protocolError('eAPI error envelope is missing a message', text, context, EapiErrorCode.INVALID_REQUEST) }
    }
    const envelope: JsonRpcFailure = {
      jsonrpc: '2.0',
      error: {
        code: error['code'],
        message: redactCommandText(error['message']),
        ...(error['data'] === undefined ? {} : { data: redactSecrets(error['data']) }),
      },
      ...(id === undefined ? {} : { id }),
    }
    return { ok: false, envelope, error: parseErrorEnvelope(envelope, context) }
  }

  const result = decoded['result']
  if (!Array.isArray(result) || !result.every(isRecord)) {
    return { ok: false, error: protocolError('eAPI result must be an array of per-command objects', text, context, EapiErrorCode.INVALID_REQUEST) }
  }
  const envelope: JsonRpcSuccess = { jsonrpc: '2.0', result: result as readonly CommandResult[], ...(id === undefined ? {} : { id }) }
  return { ok: true, envelope }
}

/** Unwrap a parsed response, throwing the failure the codec declined to raise. */
export function unwrapResponse(parsed: ParsedResponse): readonly CommandResult[] {
  if (parsed.ok) return parsed.envelope.result
  throw parsed.error
}

export interface SendRequestOptions extends BuildRequestOptions {
  /**
   * DR-012 (pyeapi's inverted `strict`): the default `true` keeps pyeapi's `strict=False` behaviour
   * of repairing a `1003 COMMAND_UNCONVERTED` answer by re-issuing the commands with
   * `format: 'text'`; `false` means "do not tolerate it" and the `CommandError` comes back.
   */
  readonly tolerateErrors?: boolean | undefined
}

export type SendRequestResult =
  | {
      readonly ok: true
      readonly request: JsonRpcRequest
      readonly encoding: RunCmdsFormat
      readonly result: readonly CommandResult[]
      /** True when this reply is the result of the DR-012 `format: 'text'` retry. */
      readonly viaTextRetry: boolean
    }
  | { readonly ok: false; readonly request: JsonRpcRequest; readonly error: CommandError | ProtocolError; readonly viaTextRetry: boolean }

interface Attempt {
  readonly request: JsonRpcRequest
  readonly parsed: ParsedResponse
}

/** `tolerateErrors` drives the client-side retry; it is never a `runCmds` parameter (DR-016). */
function wireOptions(options: SendRequestOptions): BuildRequestOptions {
  const { tolerateErrors: _tolerateErrors, ...rest } = options
  return rest
}

async function attempt(sender: WireSender, commands: readonly CommandSpec[], options: SendRequestOptions): Promise<Attempt> {
  const request = buildRequest(commands, wireOptions(options))
  // `requestId` in the context is the fallback id for errors (DR-017); the pairing check itself is the
  // transport's job (`src/transports/correlate.ts`, M2 #4).
  const parsed = parseResponse(await sender.send(request), { commands: request.params.cmds, requestId: request.id })
  return { request, parsed }
}

/**
 * build → send → parse, with the DR-012 `1003` → `format: 'text'` fallback hook. Pure apart from
 * awaiting the injected `WireSender`; the only senders in this milestone are test fakes (M1 has no
 * transport — `FetchTransport` and the Node transports are M2, #4).
 *
 * pyeapi re-issues a *single* command because its `strict=False` path sends one command per request
 * (`client.py:858-874`); the per-command splitting stays with M4's `exec`, which owns `enable`
 * prepending and result bookkeeping.
 */
export async function sendRequest(
  sender: WireSender,
  commands: CommandSpec | readonly CommandSpec[],
  options: SendRequestOptions = {},
): Promise<SendRequestResult> {
  const specs = toCommandSpecArray(commands)
  const first = await attempt(sender, specs, options)
  if (first.parsed.ok) {
    return {
      ok: true,
      request: first.request,
      encoding: first.request.params.format,
      result: first.parsed.envelope.result,
      viaTextRetry: false,
    }
  }
  const tolerate = options.tolerateErrors !== false
  if (!tolerate || !isUnconvertedCommandFailure(first.parsed.error)) {
    return { ok: false, request: first.request, error: first.parsed.error, viaTextRetry: false }
  }
  // Fresh request (hence a fresh id from the same policy) with `format: 'text'` — the only client
  // retry this package performs (DR-019: writes are never auto-retried; 1003 is a *read* of the
  // same command in a different encoding). A pinned `options.id` is reused on purpose.
  const retry = await attempt(sender, specs, { ...options, format: 'text' })
  if (retry.parsed.ok) {
    return {
      ok: true,
      request: retry.request,
      encoding: 'text',
      result: retry.parsed.envelope.result,
      viaTextRetry: true,
    }
  }
  return { ok: false, request: retry.request, error: retry.parsed.error, viaTextRetry: true }
}

/** `sendRequest`, but a failure throws instead of being returned — what M4's command layer calls. */
export async function runRequest(
  sender: WireSender,
  commands: CommandSpec | readonly CommandSpec[],
  options: SendRequestOptions = {},
): Promise<readonly CommandResult[]> {
  const outcome = await sendRequest(sender, commands, options)
  if (!outcome.ok) throw outcome.error
  return outcome.result
}

/**
 * DR-012 test predicate: `1003 COMMAND_UNCONVERTED` means "the CLI has no json model for this
 * command", which is the one failure a `format: 'text'` re-issue can repair.
 */
export function isUnconvertedCommandFailure(error: unknown): error is CommandError {
  return error instanceof CommandError && error.code === EapiErrorCode.COMMAND_UNCONVERTED
}
