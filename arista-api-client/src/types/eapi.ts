/**
 * Wire-protocol contracts for EOS eAPI `runCmds` — M1 (#3).
 *
 * Declaration-only file (docs/TESTING.md §2 excludes `src/types/**` from coverage). The shapes
 * here mirror the **server** signature verified on EOS 4.28.13.1M, not pyeapi's older, narrower
 * client-side allow-list (DR-016):
 *
 *   runCmds(version, cmds, format, timestamps, stopOnError=True, autoComplete, requestTimeout,
 *           expandAliases, includeErrorDetail, streaming)          // JsonCli.py:335-344
 *
 * `streaming` is deliberately absent: the server's own docstring marks the `runCmds` kwarg
 * `Unused. # BUG652139`, it changes the failure-envelope shape, and it is what pyeapi drops —
 * see DR-016 and MIGRATION.md §7.
 *
 * Attribution: derived from pyeapi 1.0.4-rc0 (`pyeapi/eapilib.py` request/response docstrings),
 * BSD-3-Clause, Arista Networks — see NOTICE / DR-001.
 */

/** JSON-RPC request id. EOS echoes it back; we always send a string (DR-017) but tolerate a number. */
export type JsonRpcId = string | number

/**
 * One command as it appears on the wire. A server-side command object has exactly
 * `cmd`, `input`, `revision` (`JsonCli.py:36-39`) — anything else is rejected by `buildRequest`.
 */
export interface CommandObject {
  readonly cmd: string
  /** Multiline stdin-style payload, e.g. `banner motd` … `EOF` (DR-015). Carries secrets for `enable`. */
  readonly input?: string
  readonly revision?: number
}

export type CommandSpec = string | CommandObject

/** The two `runCmds` encodings. Anything else is refused client-side (pyeapi raises `TypeError`). */
export type RunCmdsFormat = 'json' | 'text'

/** `version: 'latest'` is accepted by EOS and is what the 1003 text fallback relies on staying put. */
export type RunCmdsVersion = 1 | 'latest'

/**
 * The complete `params` object of a `runCmds` request (DR-016 — the four params pyeapi drops are
 * present here: `stopOnError`, `includeErrorDetail`, `requestTimeout`).
 *
 * `autoComplete` is typed `boolean` rather than `false` because the ported upstream tests
 * (`test_request_adds_autocomplete`) prove the parameter is still forwarded; EOS ignores it.
 */
export interface RunCmdsParams {
  readonly version: RunCmdsVersion
  readonly format: RunCmdsFormat
  readonly cmds: readonly CommandSpec[]
  readonly autoComplete?: boolean
  readonly expandAliases?: boolean
  readonly timestamps?: boolean
  /** EOS default is `true`; `buildRequest` does not invent one, so the device keeps its own default. */
  readonly stopOnError?: boolean
  /** Switches `error.data` to the `{ result[], errorDetail[] }` object shape (handled by `parseResponse`). */
  readonly includeErrorDetail?: boolean
  /** **Server-side** timeout in seconds — not the transport timeout (M2 #4, DR-019 keeps 60 s). */
  readonly requestTimeout?: number
}

/** A `runCmds` request envelope. `streaming` is never sent (DR-016). */
export interface JsonRpcRequest {
  readonly jsonrpc: '2.0'
  readonly method: 'runCmds'
  readonly id: JsonRpcId
  readonly params: RunCmdsParams
}

/** One per-command reply object (`show version` output, `{errors: [...]}` for a failed command, …). */
export type CommandResult = Record<string, unknown>

/**
 * `error.data[i]` detail entry, present only when `includeErrorDetail: true` was requested.
 * Field set observed on 4.28: `index`, `code`, `message`, `cmd`. All optional so a partial device
 * answer still parses; unknown keys survive in `JsonRpcError.data`, never in this view.
 */
export interface ErrorDetailEntry {
  readonly index?: number
  readonly code?: number
  readonly message?: string
  readonly cmd?: string
}

/** `error.data` when `includeErrorDetail: true`. */
export interface ErrorDetailData {
  readonly result?: readonly CommandResult[]
  readonly errorDetail?: readonly ErrorDetailEntry[]
}

/** The `error` member of a JSON-RPC failure envelope. `data` has two shapes — see `parseResponse`. */
export interface JsonRpcError {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

export interface JsonRpcSuccess {
  readonly jsonrpc: '2.0'
  readonly result: readonly CommandResult[]
  readonly id?: JsonRpcId
}

export interface JsonRpcFailure {
  readonly jsonrpc: '2.0'
  readonly error: JsonRpcError
  readonly id?: JsonRpcId
}

/** An eAPI reply envelope, exactly as EOS writes it: `result` xor `error` (no pyeapi `response` key, DR-007). */
export type EapiResponse = JsonRpcSuccess | JsonRpcFailure

/**
 * M1's request seam (DR-012): the codec needs to be able to *re-issue* a request for the 1003
 * text fallback, and M1 must not own a transport. `send` takes an already-built request and
 * returns the **raw response text** (not a parsed object) so `parseResponse` stays the single
 * place that validates device output — including the `-32602` decoration and DR-011 redaction.
 *
 * M2 (#4) wires this: `FetchTransport` implements `execute(commands, opts)` as
 * `sendRequest(fetchSender, commands, opts)` over `fetch` + `AbortController`, and M4 (#6) `Node`
 * stacks `enable`/`configure`/caching on top. Nothing implementing this seam in M1 may open a
 * socket — the only senders in the offline suite are local fakes inside test files.
 */
export interface WireSender {
  send(request: JsonRpcRequest): Promise<string> | string
}

/**
 * One command literal → typed reply. M4 (#6) implements the runtime `show()` against this map;
 * it starts empty on purpose and consumers add entries by **declaration merging**
 * (ARCHITECTURE.md §9.1), which is what keeps the webui's screens typed without waiting on us.
 * A consumer writes that augmentation against this package's own name (USAGE.md §4). The in-package
 * type test `src/types/eapi.test.ts` has to target the declaring module instead, because TS2664
 * forbids a package from augmenting its own name; `arista-webui/src/eapi-show-contracts.test.ts`
 * proves the consumer spelling merges through this module's re-export.
 */
export interface ShowContracts {
  // Deliberately no members: this is a declaration-merging target, not a value contract.
}

/** Reply type for a command literal; *unknown* (never `any`) when the command is not in the map. */
export type ShowReply<K extends keyof ShowContracts | string> = K extends keyof ShowContracts
  ? ShowContracts[K]
  : unknown

/**
 * Monotonic-per-connection request-id policy (DR-017). pyeapi's `reqid = id(self)` is a CPython
 * address; ours is `<clientId>-<seq>` so device logs, browser console output and error objects
 * all correlate. `clientId` optionally carries a caller-supplied nonce (e.g. the UI session).
 */
export interface RequestIdPolicy {
  readonly clientId: string
  /** `next()` is called once per request by `buildRequest`; the 1003 text retry takes a fresh one. */
  next(): JsonRpcId
}
// --- the JSON-RPC methods beyond `runCmds` (M11, #13) ---------------------------------------------
//
// pyeapi implements **only** `runCmds`: `grep -rn "verifyConfig\|editConfig\|getCommandCompletions"
// pyeapi/pyeapi/` in the pinned clone (`develop` `6816d9e`) produces no hit, and the only request
// bodies it builds are `{"method": "runCmds"}` (`eapilib.py:326-327`, `:362`). So nothing below is a
// port — the parameter names, defaults and reply shapes were read out of Arista's own server-side
// Python in the **EOS-4.28.13.1M** image, `usr/lib/python3.9/site-packages/JsonCli.py` extracted from
// `/home/svaj/development/arista/_rea_swi/Base.sqsh` (the dispatch/envelope rules are in
// `JsonRpcBase.py` beside it). Those files are vendor-proprietary build content, read for
// interoperability only; no code below was copied from them.
//
// What that extraction does **not** give us is a round trip. The reply shapes below are what the
// server's `return` statements produce, which is the strongest evidence available offline; the
// wording of any error text and every field a native layer fills stay open items for the M12 (#14)
// capture (DR-033/DR-043). Every fixture and parser for these methods says so at its definition.

/** Every JSON-RPC method this package sends. */
export type WireMethodName = 'runCmds' | NonRunCmdsMethodName

/** The methods M11 (#13) adds next to `runCmds`. pyeapi has no twin for any of them. */
export type NonRunCmdsMethodName = 'verifyConfig' | 'getCommandCompletions' | 'getCommandHelp'

/**
 * `verifyConfig(configList, format, timestamps, stopOnError, version)` — `JsonCli.py:275-330`.
 *
 * `configList` is a list of **configlet strings**: the server applies each one in turn inside its own
 * `configure session capiVerify-<pid>-<uuid>` session (`JsonCli.py:293`, opened `no-commit` at
 * `:297-298` on top of `rollback clean-config` at `:299`), reads `show session-config` after each
 * (`:310`), and **aborts that session** when the batch ends (`postCommandsFn`, `:302-305`). The
 * docstring's own example is the contract: `configList=[c1, c2]` returns
 * `[normalized(c1), normalized(c1+c2)]`.
 *
 * There is deliberately no `includeErrorDetail` here: the server hard-codes it to `False` for this
 * method (`JsonCli.py:326`), so `error.data` always answers in the plain per-command-array shape.
 */
export interface VerifyConfigParams {
  /** One entry per configlet; each becomes `{"cmd":"copy terminal: session-config","input":<entry>}`. */
  readonly configList: readonly string[]
  /** `'json'` (default server-side) or `'text'`. Validated client-side exactly as `JsonCli.py:290` does. */
  readonly format?: RunCmdsFormat
  readonly timestamps?: boolean
  /** Defaults to `true` **on the device** (`JsonCli.py:278`); `buildVerifyConfigRequest` invents nothing. */
  readonly stopOnError?: boolean
  readonly version?: RunCmdsVersion
}

/**
 * `getCommandCompletions(command, preamble)` — `JsonCli.py:173-192`.
 *
 * `preamble` is a list of CLI command strings the server executes **before** completing, to move the
 * CLI into the mode the partial line belongs in (`CliApi.py:656-668`, the loop at `:659-663`,
 * e.g. `['interface Ethernet1']`).
 */
export interface GetCommandCompletionsParams {
  readonly command: string
  readonly preamble?: readonly string[]
}

/** `getCommandHelp(command)` — `JsonCli.py:199-203`, answered by `CliApi.py:442-462`. */
export interface GetCommandHelpParams {
  readonly command: string
}

/** The `params` object for any non-`runCmds` method. */
export type WireMethodParams = VerifyConfigParams | GetCommandCompletionsParams | GetCommandHelpParams

/** A JSON-RPC envelope for a non-`runCmds` method. `params` is per-method, so read the two together. */
export interface JsonRpcMethodRequest {
  readonly jsonrpc: '2.0'
  readonly method: NonRunCmdsMethodName
  readonly id: JsonRpcId
  readonly params: WireMethodParams
}

/** The `verifyConfig` envelope. */
export interface VerifyConfigRequest extends JsonRpcMethodRequest {
  readonly method: 'verifyConfig'
  readonly params: VerifyConfigParams
}

/** The `getCommandCompletions` envelope. */
export interface GetCommandCompletionsRequest extends JsonRpcMethodRequest {
  readonly method: 'getCommandCompletions'
  readonly params: GetCommandCompletionsParams
}

/** The `getCommandHelp` envelope. */
export interface GetCommandHelpRequest extends JsonRpcMethodRequest {
  readonly method: 'getCommandHelp'
  readonly params: GetCommandHelpParams
}

/**
 * A `{method, params}` pair *before* the envelope exists — the input `Transport#callMethod` takes,
 * exactly as `execute()` takes a command list and builds the `runCmds` envelope itself with the
 * connection's id policy (DR-017). {@link buildMethodRequest} is the function that stamps it.
 */
export type WireMethodCall =
  | { readonly method: 'verifyConfig'; readonly params: VerifyConfigParams }
  | { readonly method: 'getCommandCompletions'; readonly params: GetCommandCompletionsParams }
  | { readonly method: 'getCommandHelp'; readonly params: GetCommandHelpParams }

/**
 * One member of {@link WireMethodCall}, named. A caller that wants {@link WireMethodResultOf} to
 * resolve to the right reply shape pins the call to one of these, because a bare object literal widens
 * `method` to the whole union.
 */
export type VerifyConfigCall = Extract<WireMethodCall, { readonly method: 'verifyConfig' }>

/** See {@link VerifyConfigCall}. */
export type GetCommandCompletionsCall = Extract<WireMethodCall, { readonly method: 'getCommandCompletions' }>

/** See {@link VerifyConfigCall}. */
export type GetCommandHelpCall = Extract<WireMethodCall, { readonly method: 'getCommandHelp' }>

/**
 * Which reply shape a method produces. **Not a style choice:** `JsonRpcBase.py:156-160` writes
 * `"result": <json of whatever the procedure returned>`, so `verifyConfig` (whose procedure returns a
 * list, `JsonCli.py:321-326`) answers with an **array** while `getCommandCompletions` and
 * `getCommandHelp` return a **dict** and therefore answer with an **object**. M1's `parseResponse`
 * requires an array, which is why the object-shaped methods need {@link JsonRpcObjectSuccess}.
 */
export type WireMethodResultOf<C extends WireMethodCall> = C['method'] extends 'verifyConfig'
  ? readonly CommandResult[]
  : CommandResult

/** A success envelope whose `result` is one object rather than a per-command array. */
export interface JsonRpcObjectSuccess {
  readonly jsonrpc: '2.0'
  readonly result: CommandResult
  readonly id?: JsonRpcId
}

/**
 * Either envelope the transport composition sends: `runCmds` (M1) or one of M11's (#13) non-`runCmds`
 * methods. Both go to the same `/command-api` listener with the same headers, deadline, tracing and id
 * pairing, and differ only inside `params` — which is why the byte-level senders take this union rather
 * than a parallel second sender per kind.
 */
export type RawWireRequest = JsonRpcRequest | JsonRpcMethodRequest

/**
 * The byte-level seam for a non-`runCmds` request: same contract as {@link WireSender} (raw text in,
 * raw text out, `parseResponse`/`parseMethodResponse` the only validators) with a wider request type.
 */
export interface MethodWireSender {
  sendMethod(request: JsonRpcMethodRequest): Promise<string> | string
}
