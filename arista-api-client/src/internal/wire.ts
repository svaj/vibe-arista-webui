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
  GetCommandCompletionsParams,
  GetCommandCompletionsRequest,
  GetCommandHelpRequest,
  JsonRpcFailure,
  JsonRpcId,
  JsonRpcMethodRequest,
  JsonRpcObjectSuccess,
  JsonRpcRequest,
  JsonRpcSuccess,
  MethodWireSender,
  NonRunCmdsMethodName,
  RequestIdPolicy,
  RunCmdsFormat,
  RunCmdsParams,
  RunCmdsVersion,
  VerifyConfigParams,
  VerifyConfigRequest,
  WireMethodCall,
  WireMethodResultOf,
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
 * What the shared envelope reader found, before the method-specific gate on the shape of `result`.
 * `invalid` means the body is not a usable envelope at all; `error` is a device failure envelope,
 * already turned into the typed error M1's codec produces.
 */
type EnvelopeReading =
  | { readonly kind: 'invalid'; readonly error: ProtocolError }
  | { readonly kind: 'error'; readonly envelope: JsonRpcFailure; readonly error: CommandError }
  /** `result` is deliberately **unvalidated** — array or object is the caller's method-dependent decision. */
  | { readonly kind: 'success'; readonly result: unknown; readonly id: JsonRpcId | undefined }

/**
 * The one place an eAPI body is checked for being an envelope: JSON, an object, a `2.0` version, an
 * optional scalar `id`, and **exactly one** of `result`/`error` (a `result`-and-`error` body is
 * pyeapi's duplicate-key shape, DR-007, and is refused). Shared by {@link parseResponse} and
 * {@link parseMethodResponse} so the two gates cannot drift apart.
 */
function readEnvelope(text: string, context: ResponseContext): EnvelopeReading {
  let decoded: unknown
  try {
    decoded = JSON.parse(text)
  } catch {
    return { kind: 'invalid', error: protocolError('eAPI response is not valid JSON', text, context, EapiErrorCode.PARSE_ERROR) }
  }

  if (!isRecord(decoded)) {
    return { kind: 'invalid', error: protocolError('eAPI response must be a JSON object', text, context, EapiErrorCode.INVALID_REQUEST) }
  }
  if ('jsonrpc' in decoded && decoded['jsonrpc'] !== '2.0') {
    return { kind: 'invalid', error: protocolError(`unsupported jsonrpc version ${pythonRepr(decoded['jsonrpc'])}`, text, context, EapiErrorCode.INVALID_REQUEST) }
  }

  const id = readId(decoded['id'])
  const hasError = 'error' in decoded
  const hasResult = 'result' in decoded
  if (hasError === hasResult) {
    return {
      kind: 'invalid',
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
      return { kind: 'invalid', error: protocolError('eAPI error envelope is missing a numeric code', text, context, EapiErrorCode.INVALID_REQUEST) }
    }
    if (typeof error['message'] !== 'string') {
      return { kind: 'invalid', error: protocolError('eAPI error envelope is missing a message', text, context, EapiErrorCode.INVALID_REQUEST) }
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
    return { kind: 'error', envelope, error: parseErrorEnvelope(envelope, context) }
  }

  return { kind: 'success', result: decoded['result'], id }
}

/**
 * Decode one eAPI response body. **Never throws for an error envelope** — it returns the failure
 * and lets the caller decide (PLAN M1). Only a body that is not a usable envelope fails, and it
 * fails as a `ProtocolError` carrying the redacted, truncated raw text.
 *
 * The `result` gate here is runCmds' shape: an array of per-command objects. That is right for
 * `runCmds` and for `verifyConfig` (both server procedures return a list, `JsonRpcBase.py:160`), and wrong
 * for the dict-returning methods — those go through {@link parseMethodResponse}.
 */
export function parseResponse(text: string, context: ResponseContext = {}): ParsedResponse {
  const reading = readEnvelope(text, context)
  if (reading.kind === 'invalid') return { ok: false, error: reading.error }
  if (reading.kind === 'error') return { ok: false, envelope: reading.envelope, error: reading.error }

  const result = reading.result
  if (!Array.isArray(result) || !result.every(isRecord)) {
    return { ok: false, error: protocolError('eAPI result must be an array of per-command objects', text, context, EapiErrorCode.INVALID_REQUEST) }
  }
  const envelope: JsonRpcSuccess = { jsonrpc: '2.0', result: result as readonly CommandResult[], ...(reading.id === undefined ? {} : { id: reading.id }) }
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

// --- the non-`runCmds` methods (M11, #13) -----------------------------------------------------------
//
// `runCmds` is the only method pyeapi speaks (`eapilib.py:326-327`, `:362`), so this section has no
// upstream twin: the parameter names, the required parameter, and the shape of each reply were read
// out of Arista's own server-side Python for **EOS 4.28.13.1M** (`JsonCli.py`, extracted from
// `/home/svaj/development/arista/_rea_swi/Base.sqsh`; the JSON-RPC dispatch and envelope writer are in
// `JsonRpcBase.py` next to it). The rules that matter here:
//
//  - an unknown *named* parameter is not rejected by the parameter validator — it reaches
//    `procedure(**params)` and Python raises, which the dispatcher reports as **`-32603`**
//    `INTERNAL_ERROR` with the text `got an unexpected keyword argument 'x'`
//    (`JsonRpcBase.py:163-166`, `:311-314`). pyeapi only decorates that text (`eapilib.py:459-466`).
//    A missing mandatory parameter is **`-32602`** (`JsonRpcBase.py:288-293`).
//  - the envelope is written from the procedure's **return value verbatim** (`JsonRpcBase.py:156-160`),
//    so a method that returns a dict answers with a `result` **object**. `verifyConfig` returns a list
//    and therefore answers like `runCmds`. That one fact is why this file has two result gates.
//
// Same DR-016 rule as `buildRequest`: anything outside a method's declared parameters is refused here,
// before a byte is sent, because the device's answer for a typo is an opaque `-32603`.

/** `verifyConfig(configList, format, timestamps, stopOnError, version)` — `JsonCli.py:275-279`. */
export const VERIFY_CONFIG_PARAM_KEYS: readonly string[] = ['configList', 'format', 'timestamps', 'stopOnError', 'version']

/** `getCommandCompletions(command, preamble)` — `JsonCli.py:174`. */
export const GET_COMMAND_COMPLETIONS_PARAM_KEYS: readonly string[] = ['command', 'preamble']

/** `getCommandHelp(command)` — `JsonCli.py:200`. */
export const GET_COMMAND_HELP_PARAM_KEYS: readonly string[] = ['command']

/** What the codec needs to know about one non-`runCmds` method. */
export interface WireMethodSpec {
  readonly method: NonRunCmdsMethodName
  /** The parameters the server's own signature declares. Anything else is refused locally. */
  readonly paramKeys: readonly string[]
  /** The parameter `JsonRpcBase.py:288-293` requires, i.e. the one with no server-side default. */
  readonly requiredParam: keyof VerifyConfigParams | keyof GetCommandCompletionsParams | 'command'
  /** `'array'`: `result` is a per-command list. `'object'`: `result` is one object. See `WireMethodResultOf`. */
  readonly resultShape: 'array' | 'object'
}

/** The method table {@link buildMethodRequest} and {@link sendMethodRequest} both read, so they cannot disagree. */
export const WIRE_METHODS: Readonly<Record<NonRunCmdsMethodName, WireMethodSpec>> = Object.freeze({
  verifyConfig: {
    method: 'verifyConfig',
    paramKeys: VERIFY_CONFIG_PARAM_KEYS,
    requiredParam: 'configList',
    resultShape: 'array',
  },
  getCommandCompletions: {
    method: 'getCommandCompletions',
    paramKeys: GET_COMMAND_COMPLETIONS_PARAM_KEYS,
    requiredParam: 'command',
    resultShape: 'object',
  },
  getCommandHelp: {
    method: 'getCommandHelp',
    paramKeys: GET_COMMAND_HELP_PARAM_KEYS,
    requiredParam: 'command',
    resultShape: 'object',
  },
})

/** Envelope-level build options: the same two keys `buildRequest` reserves (`DR-017`). */
const METHOD_ENVELOPE_KEYS: readonly string[] = ['id', 'ids']

export interface BuildMethodRequestOptions {
  /** Pin a specific id (replays, fixture matching). Otherwise the `ids` policy decides. */
  readonly id?: JsonRpcId | undefined
  /** The per-connection id policy (DR-017). Supplied by the transport, which owns the sequence. */
  readonly ids?: RequestIdPolicy | undefined
}

/** The `verifyConfig` parameters, without the envelope knobs. Deliberately **no**
 * `includeErrorDetail`: the server hard-codes it off for this method (`JsonCli.py:326`), so
 * `error.data` is always the plain per-command-array shape. */
export interface BuildVerifyConfigParamsOptions {
  readonly format?: RunCmdsFormat | undefined
  readonly timestamps?: boolean | undefined
  readonly stopOnError?: boolean | undefined
  readonly version?: RunCmdsVersion | undefined
}

/** Options for {@link buildVerifyConfigRequest}: the method's parameters plus the envelope knobs. */
export interface BuildVerifyConfigRequestOptions extends BuildVerifyConfigParamsOptions, BuildMethodRequestOptions {}

/** The `getCommandCompletions` parameters, without the envelope knobs. */
export interface BuildCompletionsParamsOptions {
  /**
   * CLI commands the device **executes** before completing the partial line, to enter the mode it
   * belongs in (`CliApi.py:656-668`, the loop at `:659-663`), e.g. `['interface Ethernet1']`. They run
   * in the caller's privilege, so this is not a read-only-looking option: it is a command list in
   * disguise (DR-032).
   */
  readonly preamble?: readonly string[] | undefined
}

/** Options for {@link buildGetCommandCompletionsRequest}. */
export interface BuildCompletionsRequestOptions extends BuildCompletionsParamsOptions, BuildMethodRequestOptions {}

function assertAllowedMethodOptions(method: NonRunCmdsMethodName, options: Record<string, unknown>): void {
  const spec = WIRE_METHODS[method]
  for (const key of Object.keys(options)) {
    if (METHOD_ENVELOPE_KEYS.includes(key) || spec.paramKeys.includes(key)) continue
    throw new NotSupportedError(
      `unsupported ${method} parameter '${key}': the server declares ${spec.paramKeys.join(', ')} (JsonCli.py), and an undeclared named parameter is answered -32603 'got an unexpected keyword argument' (JsonRpcBase.py:163-166) — refusing before sending (DR-016)`,
    )
  }
}

function assertMethodBoolean(method: string, key: string, value: unknown): boolean {
  // The server would accept any truthy/falsy Python object; a JSON caller means `true`/`false`.
  if (typeof value !== 'boolean') {
    throw new TypeError(`${method} parameter '${key}' must be a boolean, got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * A configlet list. The device requires a **list** (`JsonCli.py:291-292`) and each element becomes the
 * `input` of a `copy terminal: session-config` command (`JsonCli.py:309-310`), where
 * `COMMAND_ATTRIBUTES` requires a string (`JsonCli.py:36-39`, enforced at `:397-423`).
 * Refusing an empty list is **ours**, not the device's: zero configlets is a review screen that shows
 * nothing and could be mistaken for a clean answer.
 */
function assertConfigList(configList: string | readonly string[]): readonly string[] {
  const list = Array.isArray(configList) ? (configList as readonly string[]) : [configList as string]
  if (list.length === 0) {
    throw new TypeError(
      'verifyConfig needs at least one configlet — an empty configList stages nothing (our rule, not the device\'s: JsonCli.py:291-292 only requires a list)',
    )
  }
  for (const [index, configlet] of list.entries()) {
    if (typeof configlet !== 'string') {
      throw new TypeError(
        `verifyConfig configlet ${String(index)} must be a string of configuration text, got ${JSON.stringify(configlet)} — the server puts it in a command object's 'input', which must be a string (JsonCli.py:36-39)`,
      )
    }
    if (configlet === '') {
      throw new TypeError(`verifyConfig configlet ${String(index)} is empty — pass the config text, or drop the entry`)
    }
  }
  return list
}

/** A `command` parameter. Unlike a config session name this is a JSON **value**, not a spliced CLI token. */
function assertMethodCommand(method: string, command: unknown): string {
  if (typeof command !== 'string') {
    // `_validateStringOption` (`JsonCli.py:48-55`) raises `InvalidParamsError` for exactly this, i.e. -32602.
    throw new TypeError(`${method} parameter 'command' must be a string, got ${JSON.stringify(command)}`)
  }
  return command
}

/**
 * A preamble entry **is** a CLI command line (`CliApi.py:659-663`), so a newline in it would be the
 * end of that line and the start of another. Refused outright — same reasoning as a session name.
 */
function assertPreamble(preamble: readonly string[] | undefined): readonly string[] | undefined {
  if (preamble === undefined) return undefined
  if (!Array.isArray(preamble)) {
    throw new TypeError(`getCommandCompletions parameter 'preamble' must be an array of command strings, got ${JSON.stringify(preamble)}`)
  }
  for (const [index, command] of preamble.entries()) {
    if (typeof command !== 'string' || command.trim() === '') {
      throw new TypeError(`getCommandCompletions preamble ${String(index)} must be a non-empty command string, got ${JSON.stringify(command)}`)
    }
    if (/[\u0000-\u001f\u007f]/u.test(command)) {
      throw new NotSupportedError(
        `getCommandCompletions preamble ${String(index)} contains a control character — the device executes each preamble entry as one CLI command line (CliApi.py:659-663), and a newline ends it`,
      )
    }
  }
  return preamble
}

function methodId(options: BuildMethodRequestOptions): JsonRpcId {
  return options.id ?? (options.ids ?? createRequestIds()).next()
}

/**
 * The validated `params` for `verifyConfig`, without the envelope. Exported because
 * {@link Node.verifyConfig} sends the `{method, params}` pair through `Transport#callMethod` and then
 * parses the reply **against these same configlets** — so the pairing rule and the wire rule are
 * decided once, not twice (`JsonCli.py:307-311` is what makes the reply positions mean what this
 * parser says they mean).
 */
export function buildVerifyConfigParams(
  configList: string | readonly string[],
  options: BuildVerifyConfigParamsOptions = {},
): VerifyConfigParams {
  assertAllowedMethodOptions('verifyConfig', options as Record<string, unknown>)
  const params: { -readonly [K in keyof VerifyConfigParams]: VerifyConfigParams[K] } = {
    configList: assertConfigList(configList),
  }
  // The server's own defaults (`JsonCli.py:276-279`) stay the server's: only send what was asked for.
  if (options.format !== undefined) params.format = assertAllowedFormat(options.format)
  if (options.timestamps !== undefined) params.timestamps = assertMethodBoolean('verifyConfig', 'timestamps', options.timestamps)
  if (options.stopOnError !== undefined) params.stopOnError = assertMethodBoolean('verifyConfig', 'stopOnError', options.stopOnError)
  if (options.version !== undefined) params.version = assertAllowedVersion(options.version)
  return params
}

/**
 * Build a `verifyConfig` request (M11 #13, PLAN §M11 box 1). The dry run the M5 note in
 * `config-session.ts` points here for: the device applies each configlet inside its own `no-commit`
 * config session, reads `show session-config` after each application, and **aborts** that session
 * (`JsonCli.py:293-326`), so running-config is untouched. Note what that is *not*: the server's
 * pre-commands send a bare `enable` with **no** input (`JsonCli.py:296`), so unlike `runCmds` this
 * method cannot carry an enable password — a non-priv-15 API user gets a privilege failure.
 */
export function buildVerifyConfigRequest(
  configList: string | readonly string[],
  options: BuildVerifyConfigRequestOptions = {},
): VerifyConfigRequest {
  assertAllowedMethodOptions('verifyConfig', options as Record<string, unknown>)
  return { jsonrpc: '2.0', method: 'verifyConfig', id: methodId(options), params: buildVerifyConfigParams(configList, options) }
}

/** The validated `params` for `getCommandCompletions` — see {@link buildVerifyConfigParams}. */
export function buildGetCommandCompletionsParams(
  command: string,
  options: BuildCompletionsParamsOptions = {},
): GetCommandCompletionsParams {
  assertAllowedMethodOptions('getCommandCompletions', options as Record<string, unknown>)
  const params: { -readonly [K in keyof GetCommandCompletionsParams]: GetCommandCompletionsParams[K] } = {
    command: assertMethodCommand('getCommandCompletions', command),
  }
  const preamble = assertPreamble(options.preamble)
  if (preamble !== undefined) params.preamble = preamble
  return params
}

/**
 * Build a `getCommandCompletions` request. `command` may be empty — completing `''` is how a UI asks
 * for the command set of the current mode; the device answers with a `completions` object
 * (`JsonCli.py:174-192`).
 */
export function buildGetCommandCompletionsRequest(
  command: string,
  options: BuildCompletionsRequestOptions = {},
): GetCommandCompletionsRequest {
  assertAllowedMethodOptions('getCommandCompletions', options as Record<string, unknown>)
  return {
    jsonrpc: '2.0',
    method: 'getCommandCompletions',
    id: methodId(options),
    params: buildGetCommandCompletionsParams(command, options),
  }
}

/** Build a `getCommandHelp` request (`JsonCli.py:199-203`; the answer is a token → help object). */
export function buildGetCommandHelpRequest(command: string, options: BuildMethodRequestOptions = {}): GetCommandHelpRequest {
  assertAllowedMethodOptions('getCommandHelp', options as Record<string, unknown>)
  const params = { command: assertMethodCommand('getCommandHelp', command) }
  return { jsonrpc: '2.0', method: 'getCommandHelp', id: methodId(options), params }
}

/**
 * Build any non-`runCmds` request from a `{method, params}` pair — the shape `Transport#callMethod`
 * stamps with the connection's id policy, exactly as `execute()` stamps `buildRequest` (DR-017).
 * Every parameter check above still runs, because the allow-list is what makes this the last chance
 * to refuse a bad call.
 */
export function buildMethodRequest(call: WireMethodCall, options: BuildMethodRequestOptions = {}): JsonRpcMethodRequest {
  const spec = WIRE_METHODS[call.method]
  if (!(spec.requiredParam in call.params)) {
    // The device answers -32602 for this (`JsonRpcBase.py:290-293`); it costs nothing to say it earlier.
    throw new TypeError(`${call.method} requires the '${spec.requiredParam}' parameter (JsonCli.py)`)
  }
  switch (call.method) {
    case 'verifyConfig': {
      const { configList, ...rest } = call.params
      return buildVerifyConfigRequest(configList, { ...rest, ...options })
    }
    case 'getCommandCompletions': {
      const { command, ...rest } = call.params
      return buildGetCommandCompletionsRequest(command, { ...rest, ...options })
    }
    case 'getCommandHelp': {
      const { command, ...rest } = call.params
      // Forward the siblings of `command` rather than dropping them: the allow-list is the last chance to
      // refuse a typo'd parameter, and silently discarding one would answer with help for a line the
      // caller did not ask about. `rest` is typed away here because `getCommandHelp` declares no
      // parameter beyond `command`, so anything in it is by definition refused downstream.
      return buildGetCommandHelpRequest(command, { ...rest, ...options } as BuildMethodRequestOptions & Record<string, unknown>)
    }
  }
}

/** The `commands` an error from a method call should carry, redacted (DR-011). Never a lie about `cmds`. */
function methodErrorCommands(request: JsonRpcMethodRequest): readonly CommandSpec[] {
  const params = request.params
  if ('configList' in params) {
    // A configlet is CLI text and routinely contains credentials (`username … secret …`).
    return redactCommands(params.configList)
  }
  if ('command' in params) {
    // A half-typed CLI line: it is what the operator was typing, and DR-011 still applies to it.
    return [redactCommandText(params.command)]
  }
  return []
}

/** Context for {@link parseMethodResponse}: the shared response context plus the method being answered. */
export type MethodResponseContext = ResponseContext & { readonly method: NonRunCmdsMethodName }

export type ParsedMethodResponse =
  | { readonly ok: true; readonly envelope: JsonRpcObjectSuccess }
  | { readonly ok: false; readonly envelope?: JsonRpcFailure; readonly error: CommandError | ProtocolError }

/** How to name an unexpected `result` value in a refusal, without printing the device's whole body. */
function shapeOf(value: unknown): string {
  if (Array.isArray(value)) return 'an array'
  if (value === null) return 'null'
  return `a ${typeof value}`
}

/**
 * Decode a reply whose `result` is a **single object** — the dict-returning methods
 * (`getCommandCompletions`, `getCommandHelp`, `getPrompt`). Same envelope rules as
 * {@link parseResponse}, which shares {@link readEnvelope} with it, and the same rule that an error
 * envelope never throws.
 *
 * `verifyConfig` does **not** come through here: the method returns a list, so its reply is an
 * array-shaped success and `parseResponse` is the correct gate (`JsonCli.py:321-326`,
 * `JsonRpcBase.py:156-160`).
 */
export function parseMethodResponse(text: string, context: MethodResponseContext): ParsedMethodResponse {
  const reading = readEnvelope(text, context)
  if (reading.kind === 'invalid') return { ok: false, error: reading.error }
  if (reading.kind === 'error') return { ok: false, envelope: reading.envelope, error: reading.error }
  if (!isRecord(reading.result)) {
    return {
      ok: false,
      error: protocolError(
        `eAPI result for '${context.method}' must be a single JSON object, not ${shapeOf(reading.result)} — this client refuses to guess a shape it cannot verify (DR-032)`,
        text,
        context,
        EapiErrorCode.INVALID_REQUEST,
      ),
    }
  }
  const envelope: JsonRpcObjectSuccess = { jsonrpc: '2.0', result: reading.result, ...(reading.id === undefined ? {} : { id: reading.id }) }
  return { ok: true, envelope }
}

/** A method round trip: the request that was built, plus either the typed reply or the typed failure. */
export type SentMethodCall<R = CommandResult | readonly CommandResult[]> =
  | { readonly ok: true; readonly request: JsonRpcMethodRequest; readonly result: R }
  | { readonly ok: false; readonly request: JsonRpcMethodRequest; readonly error: CommandError | ProtocolError }

/**
 * build → send → parse for one non-`runCmds` method.
 *
 * There is **no** `tolerateErrors` here, deliberately: DR-012's repair re-issues a *command list* with
 * `format:'text'`, and none of these methods takes a command list — `verifyConfig` has its own `format`
 * parameter the caller chose, and the completion/help methods have no encoding at all. Inventing a
 * retry for a method whose failure modes are unmeasured would be the kind of claim DR-050 refuses.
 */
export async function sendMethodRequest<C extends WireMethodCall>(
  sender: MethodWireSender,
  call: C,
  options: BuildMethodRequestOptions = {},
): Promise<SentMethodCall<WireMethodResultOf<C>>> {
  const request = buildMethodRequest(call, options)
  const context: ResponseContext = { requestId: request.id, commands: methodErrorCommands(request) }
  const text = await sender.sendMethod(request)
  if (WIRE_METHODS[request.method].resultShape === 'array') {
    const parsed = parseResponse(text, context)
    if (parsed.ok) {
      return { ok: true, request, result: parsed.envelope.result as WireMethodResultOf<C> }
    }
    return { ok: false, request, error: parsed.error }
  }
  const parsed = parseMethodResponse(text, { ...context, method: request.method })
  if (parsed.ok) {
    return { ok: true, request, result: parsed.envelope.result as WireMethodResultOf<C> }
  }
  return { ok: false, request, error: parsed.error }
}

/** {@link sendMethodRequest}, but a failure throws instead of being returned — what `Node` calls. */
export async function runMethodRequest<R = CommandResult | readonly CommandResult[]>(
  sender: MethodWireSender,
  call: WireMethodCall,
  options: BuildMethodRequestOptions = {},
): Promise<R> {
  const outcome = await sendMethodRequest(sender, call, options)
  if (!outcome.ok) throw outcome.error
  return outcome.result as R
}
