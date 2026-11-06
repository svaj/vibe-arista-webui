/**
 * `Node` — the command layer, M4 (#6). Port of `pyeapi/client.py`'s `Node` class
 * (`client.py:464-1037`, BSD-3-Clause, Arista Networks — DR-001), keeping the **behaviour** and
 * renaming the **shape** per DR-003.
 *
 * Deliberately absent here, because other milestones own them:
 *  - `section()` / `_chunkify()` — the config-text engine, M6 (#8). pyeapi clears an `lru_cache` on
 *    `_chunkify` after every write (`client.py:666`); DR-026 replaces that with a hash-keyed memo, so
 *    a parse cannot outlive the config text it was derived from and needs no invalidation hook here.
 *  - `configure_session` / `diff` / `commit` / `abort` — landed in **M5 (#7)** as `src/config-session.ts`
 *    (`node.configSession()` → a `ConfigSession` state machine, DR-025's guard at the top of
 *    {@link Node.configure}, plus the durability/recovery verbs pyeapi never had). This file keeps only the
 *    thin delegators, so the session semantics live in one reviewed place and the `Node` surface stays flat.
 *  - `api()` module autoload — dropped outright (DR-006, MIGRATION.md §7), so its upstream test
 *    (`test_client.py::test_api_autoloader`) has nothing to port to. {@link Node.resource} is the typed
 *    replacement (M7 #9):
 *    a key of the augmentable `ResourceKinds` map over a frozen factory table, not a module path.
 *
 * Shipped here by M7 (#9) — the pairing PR #23 deferred to this milestone ("Deliberately no
 * `Node.chunkConfig`/`Node.section` wiring — that pairing is M7", STATUS.md §1):
 *  - pyeapi's `section()` / `_chunkify()` (`client.py:697-774`, `:776-798`) on top of M6's engine
 *    (`src/config/`), with pyeapi's `_chunkify.cache_clear()` calls (`client.py:665-666`, `:689-690`)
 *    realised as DR-026's per-source memos — {@link Node.chunkConfig}, {@link Node.section};
 *  - MIGRATION.md §2 promised the method name `configSection()`; as built it is `section()`, matching
 *    pyeapi and M6's own function name (row 80).
 *
 * Layering (docs/ARCHITECTURE.md §1): this file is the `Node` box — it holds a `Transport`
 * **interface** and nothing else at the runtime seam, so the same command layer runs over `fetch`
 * (browser entry) and over the Node senders. `import type` only: `core may not import transports`
 * is about the runtime graph, and `import/no-cycle` proves it holds.
 *
 * Every device call here has four honest outcomes — in flight (the returned promise), success
 * (typed reply), empty (a `result[]` with nothing in it is a `ProtocolError` naming the command,
 * never `undefined` rendered as a blank panel), and failure (a `CommandError`/`TransportError` that
 * already carries `commands` + `requestId` + redacted text from M1/M2).
 */

import {
  abortSessionOn,
  assertNoSessionConflict,
  assertTerminalModeAllowed,
  configureReplaceOn,
  copyRunningToStartupOn,
  createConfigSession,
  listSessionsOn,
  recoverOrphansOn,
  type ConfigSession,
  type ConfigurationSessions,
  type ConfigSessionOptions,
  type ConfigureReplaceOptions,
  type ListSessionsOptions,
  type RecoverOrphansOptions,
  type RecoverOrphansOutcome,
} from './config-session'
import { NotSupportedError, ProtocolError } from './errors'
import { createConfigChunkCache } from './config/cache'
import { getBlock as blockOfSection, section as matchSection } from './config/section'
import { RESOURCE_FACTORIES, ResourceRegistry } from './resources/registry'
import { redactCommands } from './internal/redact'
import { buildGetCommandCompletionsParams, buildVerifyConfigParams, toCommandSpecArray } from './internal/wire'
import type { BuildCompletionsParamsOptions, BuildVerifyConfigParamsOptions } from './internal/wire'
import { tryVariants } from './internal/variants'
import type { CliVariant } from './internal/variants'
import type { ConfigSections } from './config/chunk'
import type { SectionPattern } from './config/section'
import type { AclsResource } from './resources/acl'
import type { InterfacesResource } from './resources/interfaces'
import type { SystemResource } from './resources/system'
import type { SwitchportsResource } from './resources/switchports'
import type { VarpResource } from './resources/varp'
import type { VlansResource } from './resources/vlans'
import type { ResourceKinds, ResourceName } from './resources/registry'
import type { MethodCallOptions, Transport, TransportExecOptions } from './transports/contract'
import type { CommandResult, CommandSpec, RunCmdsFormat, ShowContracts, ShowReply } from './types/eapi'
import type { GetCommandCompletionsCall, GetCommandHelpCall, GetCommandHelpParams, VerifyConfigCall, WireMethodCall, WireMethodResultOf } from './types/eapi'

/** How this `Node` behaves, pyeapi's `Node.__init__` kwargs (`client.py:495-507`) minus `connection`. */
export interface NodeSettings {
  /**
   * The enable-mode password (pyeapi `enablepwd`, `client.py:504`). When set, the prepended enable
   * command becomes `{'cmd':'enable','input':password}` (`client.py:915`) instead of bare `enable`.
   *
   * **The priv-15 shortcut (DR-009):** a Basic-auth user whose `privilege` is 15 already lands in
   * executive mode (`UwsgiRequestContext.py:150-165`), so it needs **no** enable password and no
   * `enable` command at all — pass `sendEnable: false` per call and keep this unset. That is the
   * configuration USAGE.md §4 recommends; `sendEnable` defaults to `true` only for drop-in
   * familiarity with pyeapi.
   */
  readonly enablePassword?: string | undefined
  /**
   * Re-read the cached configs after a write (pyeapi `autorefresh`, default `true`, `client.py:505`).
   * Public and mutable exactly as upstream has it, because turning it off around a batch of writes is
   * the documented way to avoid a `show running-config` per change.
   */
  autorefresh?: boolean | undefined
  /**
   * Ask the device for default values in the running-config (pyeapi `config_defaults`, default
   * `true`, `client.py:506`), i.e. `show running-config all`.
   */
  readonly configDefaults?: boolean | undefined
}

/** The request knobs this layer forwards to the transport unchanged (M1 codec + M2 transport options). */
export type NodeRequestOptions = TransportExecOptions & {
  /**
   * Prepend the enable command (pyeapi `send_enable`, `client.py:913-917`; `run_commands` defaults it
   * to `true`). `false` is what a priv-15 API user should use — DR-009.
   */
  readonly sendEnable?: boolean | undefined
}

/** One command's answer, as pyeapi's `enable()` returned it — without the duplicate `response` key (DR-007, MIGRATION.md §5 row 1). */
export interface ExecResult {
  /** The command as the caller wrote it (not the enable command this layer prepended). */
  readonly command: CommandSpec
  /** The device's per-command reply object. */
  readonly result: CommandResult
  /** The encoding that actually answered: `'json'`, or `'text'` after the DR-012 fallback. */
  readonly encoding: RunCmdsFormat
  /**
   * `true` when a `1003 COMMAND_UNCONVERTED` forced the `format:'text'` retry, i.e. this reply has no
   * JSON structure to index (docs/USAGE.md §4; pyeapi reports nothing — MIGRATION.md §5 row 33).
   */
  readonly fellBack: boolean
}

/** Which stored configuration to read (pyeapi `get_config`'s first positional, `client.py:952`). */
export type ConfigTarget = 'running-config' | 'startup-config'

/** `'string'` = pyeapi `as_string=True`; `'lines'` = its default list return (`client.py:986-989`). */
export type ConfigOutput = 'string' | 'lines'

/** Options for {@link Node.getConfig}. pyeapi's positional `(config, params, as_string)` — row 31 renames them. */
export interface GetConfigOptions extends NodeRequestOptions {
  /** Which config to read. Default `running-config`, as in pyeapi. A union, so a bad name is a compile error (row 36). */
  readonly config?: ConfigTarget | undefined
  /** Keywords appended to the show command — pyeapi `params` (`client.py:982-983`), e.g. `'all'` or `'filtered'`. */
  readonly params?: string | undefined
  /** Return shape. Default `'lines'`, which is pyeapi's default too. */
  readonly as?: ConfigOutput | undefined
}

/** Options for {@link Node.show} / {@link Node.showText}: the encoding is decided by the method, not the caller. */
export type ShowOptions = Omit<NodeRequestOptions, 'format'> & {
  /** Ask for a specific JSON model revision of the command (`JsonCli.py:36-39` allows `revision`). */
  readonly revision?: number | undefined
}

/**
 * Which cached config text an operation reads — the second argument of pyeapi's
 * `Node.section(regex, config='running_config')` (`client.py:776`, resolved at `:789-791`), spelled as
 * the wire union {@link ConfigTarget} instead of the `'running_config'` sentinel string (row 36 kept it
 * this way for `getConfig` too). Added by M7 (#9) for {@link Node.chunkConfig} / {@link Node.section};
 * there is no `params` here because a chunked read is always the whole config, exactly as pyeapi's
 * `_chunkify(self.running_config)` was (`client.py:790-791`).
 */
export interface NodeConfigOptions {
  /** Which config to chunk and search. Default `running-config`, as in pyeapi. */
  readonly config?: ConfigTarget | undefined
}

/** Options for {@link Node.showText} — always `format:'text'`, no revision (text output has none). */
export type ShowTextOptions = Omit<NodeRequestOptions, 'format' | 'revision'>

/**
 * What `show version` says about the device, parsed the way pyeapi parses it
 * (`_get_version_properties`, `client.py:557-575`), with one addition and one fix:
 * `modelName` keeps the device's full string (pyeapi keeps only the four-digit run it derives
 * `model` from, losing `-64`/`-SSD` — DR-032 wants the exact name), and a missing field throws
 * instead of being `str()`-coerced to the literal `'None'`. MIGRATION.md §5 row 35.
 */
export interface VersionProperties {
  /** Verbatim `version` from the device, e.g. `4.28.13.1M` or `4.17.1.1F-3512479.41711F (engineering build)`. */
  readonly version: string
  /** Leading digits-and-dots run of `version` (`client.py:563`), e.g. `4.28.13.1`; the whole string when it does not start numerically. */
  readonly versionNumber: string
  /** First four consecutive digits of `modelName` (`client.py:570`) — pyeapi parity, e.g. `7050`. */
  readonly model: string
  /** Verbatim `modelName` from the device, e.g. `DCS-7050TX-64`. Added here; pyeapi has no equivalent. */
  readonly modelName: string
}

/** pyeapi's `re.match(r'[\d.\d]+', version)` is a leading digits-and-dots run, anchored at the start. */
const VERSION_NUMBER = /^[\d.]+/
/** pyeapi's `re.search(r'\d\d\d\d', modelName)` — the first four-digit run anywhere in the name. */
const MODEL_DIGITS = /\d{4}/

/** One round trip's worth of facts, so `exec` can report which encoding actually answered. */
interface RoundTrip {
  readonly encoding: RunCmdsFormat
  readonly fellBack: boolean
  readonly result: readonly CommandResult[]
}

/** The forms of `configure …` that are configuration mode and therefore refused on `exec` (row 32). */
const CONFIG_MODE_WORD = /^configure\b/i
/** `configure all <interface> <command>` runs in executive mode, so it is legitimate for `exec`. */
const CONFIGURE_ALL = /^all\b/i
/** A `show` literal that already spells its own prefix is sent as written instead of doubled. */
const SHOW_PREFIX = /^show\b/i

/**
 * Which command text a `configure`-mode entry looks like (MIGRATION.md §5 row 32).
 *
 * pyeapi compares the whole list against one literal (`client.py:841`: `if 'configure' in commands`),
 * which catches the bare `configure` string and nothing else — not `{'cmd':'configure terminal'}`, not
 * `configure session X`, not `configure replace flash:x`. This predicate catches every `configure …`
 * **except** `configure all …`, which is an executive-mode command and would otherwise become
 * unsendable. An unrecognised `configure <something>` is refused: the device would apply it to the
 * running config, and a UI that thought it had run a `show` would be lying.
 */
function isConfigModeCommand(command: CommandSpec): boolean {
  const trimmed = commandText(command).trim()
  if (!CONFIG_MODE_WORD.test(trimmed)) return false
  const rest = trimmed.slice('configure'.length).trim()
  if (rest === '') return true
  return !CONFIGURE_ALL.test(rest)
}

/** Refuse config-mode commands on the read paths — pyeapi raises `TypeError`; this is a `NotSupportedError`. */
function assertNotConfigMode(commands: readonly CommandSpec[]): void {
  const offender = commands.find(isConfigModeCommand)
  if (offender === undefined) return
  throw new NotSupportedError(
    `config mode commands are not supported by exec(); '${commandText(offender)}' belongs in configure() (terminal mode) or, from M5 (#7), configSession(). pyeapi raises TypeError here and only for the bare 'configure' literal — MIGRATION.md §5 row 32.`,
    { commands: redactCommands(commands) },
  )
}

/** The CLI text of a command in either wire form — for predicates and for every message below. */
function commandText(command: CommandSpec): string {
  return typeof command === 'string' ? command : command.cmd
}

/** The device answered successfully but produced no reply object for the command that was asked. */
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

/**
 * The `output` member of a `format:'text'` reply. pyeapi `str()`-coerces whatever it finds; we do not.
 * `command` is the string this layer built (only `getConfig`/`showText` reach here), not a caller's
 * object form — which is why it takes `string` rather than `CommandSpec`.
 */
function outputText(reply: CommandResult, command: string): string {
  const output = reply['output']
  if (typeof output !== 'string') {
    throw new ProtocolError(
      `eAPI text reply for ${JSON.stringify(command)} has no string 'output' member (got ${output === undefined ? 'nothing' : typeof output})`,
      { commands: redactCommands([command]) },
    )
  }
  return output
}

function versionField(reply: CommandResult, key: 'version' | 'modelName', command: CommandSpec): string {
  const value = reply[key]
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new ProtocolError(
      `show version reply has no \`${key}\` field, so the device's ${key === 'version' ? 'EOS version' : 'model'} cannot be determined — refusing to report pyeapi's \`str(None)\` answer of "None"`,
      { commands: redactCommands([command]) },
    )
  }
  return String(value)
}

/**
 * Parse the two device strings into the four fields pyeapi's `_get_version_properties` computes
 * (`client.py:557-575`), regexes and fallbacks included: an unmatched version keeps the whole string,
 * an unmatched model name keeps the whole name (so `vEOS` stays `vEOS`, as upstream's
 * `test_get_version_properties_match_version_number_no_match_model` proves).
 *
 * Exported for direct unit testing — TESTING.md §6 keeps parsers pure and tests them without a device.
 */
export function parseVersionProperties(reply: CommandResult, command: CommandSpec = 'show version'): VersionProperties {
  const version = versionField(reply, 'version', command)
  const modelName = versionField(reply, 'modelName', command)
  return {
    version,
    versionNumber: VERSION_NUMBER.exec(version)?.[0] ?? version,
    model: MODEL_DIGITS.exec(modelName)?.[0] ?? modelName,
    modelName,
  }
}

/**
 * The command line for a contract literal (MIGRATION.md §2: `show<T>(command)`):
 * `docs/ARCHITECTURE.md` §3 keys {@link ShowContracts} on the command **without** its `show` prefix
 * (`version`, `'interfaces status'`, `vlan`), and `docs/USAGE.md` §4 calls it as
 * `node.show('vlan 20')`, so the prefix is added here. A literal that already starts with `show` is
 * sent exactly as written — the contract key is always the string the caller passed, and
 * `show show version` is not a command anyone wants on the wire.
 *
 * Parameterised commands are the map's known limit: `'vlan 20'` is one key, `'vlan 30'` another, so a
 * consumer models the literals it renders (or gets `unknown` and narrows on purpose). PLAN M4's
 * "`show('vlan 20')` → …" is satisfied that way, without the type-level pattern matching DR-006
 * refuses. Type tests in `src/command-layer.test.ts` pin both halves.
 */
function showCommand(literal: string): string {
  return SHOW_PREFIX.test(literal.trimStart()) ? literal : `show ${literal.trim()}`
}

/** pyeapi `Node.get_config` raises `TypeError('invalid config name specified')` (`client.py:978-979`). */
function assertConfigTarget(config: string): asserts config is ConfigTarget {
  if (config !== 'running-config' && config !== 'startup-config') {
    throw new NotSupportedError(
      `invalid config name specified: ${JSON.stringify(config)} — only 'running-config' and 'startup-config' exist (pyeapi raises TypeError here; MIGRATION.md §5 row 36)`,
    )
  }
}

/** A JS caller can hand us anything; the constructor says so loudly rather than at the first request. */
function assertTransport(connection: Transport): void {
  const candidate = connection as (Partial<Transport> | undefined) | null
  if (typeof candidate?.execute !== 'function' || typeof candidate?.close !== 'function') {
    throw new TypeError(
      'Node requires a Transport: an object with execute(commands, options) and close(). Build one with createTransport(options), or MockTransport from the ./testing entry for tests.',
    )
  }
}

// --- M11 (#13): the non-`runCmds` methods ----------------------------------------------------------
//
// `verifyConfig`, `getCommandCompletions` and `getCommandHelp` are real eAPI methods that pyeapi never
// exposed (`eapilib.py:326-327` is its only body), so there is no upstream behaviour row for them:
// what is verified below is Arista's own Python in the **EOS-4.28.13.1M** image (`JsonCli.py`,
// `CliApi.py`, `JsonRpcBase.py`, extracted from `Base.sqsh`), and every parse rule cites it. What is
// **not** verified is still what only a round trip gives — the prose of an error message, and whether a
// 7050TX-64 running 4.28.13.1M answers these behind its own AAA/privilege rules. That stays an
// [M12 (#14) capture](../../docs/STATUS.md), so the synthetic sample envelopes in
// `command-layer.methods.test.ts` are labelled as such rather than presented as device output.

/**
 * Options for {@link Node.verifyConfig}: the method's own parameters plus the transport knobs
 * (`MethodCallOptions`). There is no `sendEnable` — this is not a command list, and the `enable` the
 * server runs for itself takes no password argument (`JsonCli.py:296`), so an `enablePassword` set on
 * this `Node` is **not** sent here. A non-priv-15 API user therefore fails with a privilege error
 * rather than being silently upgraded.
 */
export type VerifyConfigOptions = MethodCallOptions & BuildVerifyConfigParamsOptions

/** Options for {@link Node.getCompletions}. */
export type GetCompletionsOptions = MethodCallOptions & BuildCompletionsParamsOptions

/** Options for {@link Node.getCommandHelp} — the method takes one parameter, so this is only transport knobs. */
export type GetCommandHelpOptions = MethodCallOptions

/**
 * One configlet's place in a {@link Node.verifyConfig} answer.
 *
 * The pairing is not a guess: the server stages, for each configlet in order, the
 * `copy terminal: session-config` command and then `show session-config`
 * (`configCmds += [cmd, showSessionCmd]`, `JsonCli.py:307-311`), and `result` is one reply object per
 * command. So reply `2i` belongs to configlet `i`'s `copy` and reply `2i + 1` is the session's
 * **aggregated** configuration after `i` — which is the "normalised(c1), normalised(c1+c2)" behaviour
 * the method's docstring promises (`JsonCli.py:281-286`).
 */
export interface VerifyConfigEntry {
  /** Which configlet this is, in the order they were sent. */
  readonly index: number
  /** The configlet text as the caller wrote it — the diff a review screen shows beside the result. */
  readonly configlet: string
  /** The `copy terminal: session-config` reply. Absent when the device answered fewer commands than that. */
  readonly copyReply?: CommandResult | undefined
  /**
   * The `show session-config` reply after this configlet: the normalised state, i.e. what would land
   * if this configlet were committed on top of the current running-config. Its field set is
   * `ShowRunOutputModel.Mode`, which this package has **not** inspected, so it stays a
   * `CommandResult` rather than an invented interface (same rule as M5's `showSessionConfig`, row 64).
   */
  readonly sessionConfig?: CommandResult | undefined
  /** The same answer in `format: 'text'` mode, where the reply is `{output}`. */
  readonly sessionConfigText?: string | undefined
}

/** A parsed {@link Node.verifyConfig} answer. Nothing is dropped: `raw` and `unmatched` keep the reply. */
export interface VerifyConfigOutcome {
  /** The encoding this call asked for. `'json'` when the caller said nothing, as on the device. */
  readonly format: RunCmdsFormat
  /** One entry per configlet, in send order. A short reply leaves the later fields absent rather than empty. */
  readonly entries: readonly VerifyConfigEntry[]
  /** Reply objects beyond the last configlet pair — reported, never silently trimmed. */
  readonly unmatched: readonly CommandResult[]
  /** The device's array verbatim (redaction applies upstream, in the codec — DR-011). */
  readonly raw: readonly CommandResult[]
}

/**
 * Pair a `verifyConfig` reply with the configlets it answers. Pure and exported for the same reason
 * `parseVersionProperties` is (TESTING.md §6): the pairing rule is the part worth pinning offline.
 */
export function parseVerifyConfigReply(
  result: readonly CommandResult[],
  request: { readonly configList: readonly string[]; readonly format?: RunCmdsFormat | undefined },
): VerifyConfigOutcome {
  const format = request.format ?? 'json'
  const entries: VerifyConfigEntry[] = []
  const consumed = new Set<number>()
  for (const [index, configlet] of request.configList.entries()) {
    const copyReply = result[index * 2]
    const sessionConfig = result[index * 2 + 1]
    if (copyReply !== undefined) consumed.add(index * 2)
    if (sessionConfig !== undefined) consumed.add(index * 2 + 1)
    const sessionConfigText = typeof sessionConfig?.['output'] === 'string' ? (sessionConfig['output'] as string) : undefined
    entries.push({
      index,
      configlet,
      ...(copyReply === undefined ? {} : { copyReply }),
      ...(sessionConfig === undefined ? {} : { sessionConfig }),
      ...(sessionConfigText === undefined ? {} : { sessionConfigText }),
    })
  }
  return {
    format,
    entries,
    unmatched: result.filter((_reply, position) => !consumed.has(position)),
    raw: [...result],
  }
}

/** One completion the CLI offered: the token and the help text beside it (`JsonCli.py:192`). */
export interface CommandCompletion {
  readonly name: string
  readonly help: string
}

/** A parsed `getCommandCompletions` answer. The envelope is `{errors, complete, completions}` (`JsonCli.py:188-192`). */
export interface CommandCompletions {
  /**
   * `true` when the partial line is itself a complete command — the device computes it from a `<cr>`
   * completion (`JsonCli.py:190`). Absent when the reply did not answer a boolean, rather than
   * defaulted to `false`, because "the command is complete" and "we cannot tell" are different answers.
   */
  readonly complete?: boolean | undefined
  /** The offered tokens, in the device's order, as `{name, help}` pairs. */
  readonly completions: readonly CommandCompletion[]
  /**
   * The device's own `errors` member: an empty object for a normal answer, and the CLI's error list
   * when a `preamble` command was rejected (`CliApi.py:659-663`). Un-modelled on purpose — its two
   * shapes are both vendor-side.
   */
  readonly errors?: unknown
  /**
   * Keys of the reply this view does not model. Kept rather than dropped (PLAN: unknown fields survive
   * as data) so a future field is visible in `toJSON()` instead of invisible in a table.
   */
  readonly extra: Readonly<Record<string, unknown>>
  /** Completion keys whose value was not a help string — named, not coerced (compare pyeapi's `str()`). */
  readonly unparsed: readonly string[]
  /** The device's reply object verbatim. */
  readonly raw: CommandResult
}

/** The three keys `getCommandCompletions` writes (`JsonCli.py:188-192`); everything else is `extra`. */
const COMPLETION_KEYS: readonly string[] = ['errors', 'complete', 'completions']

/**
 * Validate + read a `getCommandCompletions` reply. A `completions` member that is missing or is not an
 * object is a `ProtocolError`: an empty completion list is a real answer ("nothing matches `sh xq`"),
 * and reporting one for a malformed reply would make a device surprise look like an empty command set.
 */
export function parseCommandCompletions(reply: CommandResult): CommandCompletions {
  const holder = reply['completions']
  if (typeof holder !== 'object' || holder === null || Array.isArray(holder)) {
    throw new ProtocolError(
      `getCommandCompletions reply has no 'completions' object (got ${shapeOfReplyValue(holder)}) — an empty completion list is a real answer, so this client refuses to report one for a reply it cannot read (JsonCli.py:188-192)`,
      { commands: ['getCommandCompletions'] },
    )
  }
  const completions: CommandCompletion[] = []
  const unparsed: string[] = []
  for (const [name, help] of Object.entries(holder as Record<string, unknown>)) {
    if (typeof help === 'string') completions.push({ name, help })
    else unparsed.push(name)
  }
  const complete = typeof reply['complete'] === 'boolean' ? reply['complete'] : undefined
  const errors = 'errors' in reply ? reply['errors'] : undefined
  const extra = Object.fromEntries(Object.entries(reply).filter(([key]) => !COMPLETION_KEYS.includes(key)))
  return {
    ...(complete === undefined ? {} : { complete }),
    completions,
    ...(errors === undefined ? {} : { errors }),
    extra,
    unparsed,
    raw: reply,
  }
}

/** One token's help line from `getCommandHelp` (`CliApi.py:452`, `{c.name: c.help}`). */
export interface CommandHelpEntry {
  readonly token: string
  readonly help: string
}

/** A parsed `getCommandHelp` answer: the device's `{token: help}` object, ordered, plus the reply itself. */
export interface CommandHelp {
  readonly entries: readonly CommandHelpEntry[]
  /** The same data as a record, for a lookup-by-token screen. */
  readonly byToken: Readonly<Record<string, string>>
  /**
   * Tokens whose value was not a string, so a caller can see what was skipped. Not a curiosity: the
   * CLI assigns a **guard code** to `help` for some commands (`CliApi.py:650`, whose own comment calls
   * that a bug), so a non-string here is the device being honest about "not available".
   */
  readonly unparsed: readonly string[]
  readonly raw: CommandResult
}

/**
 * Validate + read a `getCommandHelp` reply, whose whole `result` **is** the `{token: help}` object
 * (`JsonCli.py:199-203` → `CliApi.py:442-462`). An empty object is a real answer, so only a
 * non-object is a parse failure.
 */
export function parseCommandHelp(reply: CommandResult): CommandHelp {
  const entries: CommandHelpEntry[] = []
  const unparsed: string[] = []
  const byToken: Record<string, string> = {}
  for (const [token, help] of Object.entries(reply)) {
    if (typeof help === 'string') {
      entries.push({ token, help })
      byToken[token] = help
    } else {
      unparsed.push(token)
    }
  }
  return { entries, byToken, unparsed, raw: reply }
}

/** How a `result` member that is not what a method produces should be named in a refusal. */
function shapeOfReplyValue(value: unknown): string {
  if (Array.isArray(value)) return 'an array'
  if (value === null) return 'null'
  return typeof value
}

/**
 * A command layer over one switch's eAPI endpoint: `runCommands` / `exec` / `show` / `showText` for
 * reads, `configure` for writes, plus the lazily-read device identity and the cached config text.
 */
export class Node {
  /**
   * The transport this command layer drives (pyeapi `Node.connection`, `client.py:515-517`) — except
   * that nothing is ever stashed on it: pyeapi's `connection.error` idiom is dropped (DR-005), and
   * `docs/ARCHITECTURE.md` §7 says `Node` holds a `Transport` interface, which is what makes the
   * browser/Node split work.
   */
  readonly connection: Transport

  /** pyeapi `autorefresh` (`client.py:505`): a write invalidates the cached configs unless this is off. */
  autorefresh: boolean

  /** pyeapi `config_defaults` (`client.py:506`): `show running-config all` for the running-config cache. */
  readonly configDefaults: boolean

  /**
   * The settings this instance was built with (pyeapi keeps the raw `**kwargs` in `settings`,
   * `client.py:507`). Closed type — an unrecognised key is a compile error instead of a kwarg that
   * silently reaches `runCmds` and is dropped by pyeapi's allow-list (`eapilib.py:360-361`, row 31).
   */
  readonly settings: Readonly<NodeSettings>

  private enablePassword: string | undefined
  private runningConfig: string | undefined
  private startupConfig: string | undefined
  private versionInfo: VersionProperties | undefined
  /**
   * The one config session this `Node` is responsible for (DR-025: one open session per node, because
   * EOS drives one configuration context per CLI session). Held, not cached: {@link configure} and
   * {@link configureReplace} refuse to interleave with it, and {@link configSession} refuses to open a
   * second one over the same switch.
   */
  private activeSession: ConfigSession | undefined

  /**
   * The DR-026 chunk memos, one per config cache (M7, #9 — the pairing PR #23 deferred here).
   *
   * pyeapi has a single `@lru_cache(maxsize=None)` on `_chunkify` (`client.py:697`) keyed by whichever
   * text is handed to it, so a `Node` that alternates `section(…, 'running_config')` and
   * `section(…, 'startup_config')` (`client.py:789-791`) keeps both forever and evicts neither. Two
   * single-entry memos (`src/config/cache.ts`) match the two text caches they derive from instead.
   */
  private readonly runningChunks = createConfigChunkCache()
  private readonly startupChunks = createConfigChunkCache()

  /**
   * The per-`Node` resource memo — DR-006's typed replacement for pyeapi's `Node.api()` module
   * autoload (`client.py:927-950`). Constructed with this `Node`, so a resource never sees another
   * switch's transport (docs/ARCHITECTURE.md §7 forbids the module-level singleton pyeapi uses).
   */
  private readonly resourceMemo = new ResourceRegistry(RESOURCE_FACTORIES, this)

  constructor(connection: Transport, settings: NodeSettings = {}) {
    assertTransport(connection)
    this.connection = connection
    this.enablePassword = settings.enablePassword
    this.autorefresh = settings.autorefresh ?? true
    this.configDefaults = settings.configDefaults ?? true
    this.settings = Object.freeze({ ...settings })
  }

  /** pyeapi `__str__`/`__repr__` (`client.py:509-513`), secret-free: it names the transport, never a password. */
  toString(): string {
    return `Node(connection=${String(this.connection)})`
  }

  /** pyeapi `Node.close()` does not exist; DR-018's cookie transports do, and a `Node` that cannot release one leaks an authenticated session on the switch. */
  close(): Promise<void> {
    return this.connection.close()
  }

  /**
   * pyeapi `enable_authentication(password)` (`client.py:576-588`): the enable-mode password, trimmed
   * exactly as upstream trims it. An all-whitespace password clears it, because pyeapi's
   * `if self._enablepwd:` (`client.py:914`) would treat the empty string as "no password" anyway.
   */
  setEnablePassword(password: string): void {
    const trimmed = password.trim()
    this.enablePassword = trimmed === '' ? undefined : trimmed
  }

  /**
   * The command this layer prepends when `sendEnable` is on (pyeapi `client.py:913-917`).
   *
   * DR-009: the object form carries the enable password in `input`, which is why DR-011's redaction is
   * applied to every error this layer can produce (`wire.parseResponse` redacts the `commands` it
   * attaches, so `CommandError#commands` never contains the cleartext).
   */
  private enableCommand(): CommandSpec {
    return this.enablePassword ? { cmd: 'enable', input: this.enablePassword } : 'enable'
  }

  /** One batched round trip with the enable command handled, so callers never repeat that logic. */
  private async roundTrip(commands: CommandSpec | readonly CommandSpec[], options: NodeRequestOptions): Promise<RoundTrip> {
    const { sendEnable = true, ...request } = options
    const specs = toCommandSpecArray(commands)
    const wire = sendEnable ? [this.enableCommand(), ...specs] : specs
    const outcome = await this.connection.execute(wire, request)
    if (!outcome.ok) throw outcome.error
    // pyeapi pops the enable reply off the result array under exactly the same condition it was
    // inserted (`client.py:922-923`), and the codecs' 1003 retry tells us which encoding answered
    // (`SendRequestResult.encoding` / `.viaTextRetry`, M1).
    return {
      encoding: outcome.encoding,
      fellBack: outcome.viaTextRetry,
      result: sendEnable ? outcome.result.slice(1) : outcome.result,
    }
  }

  /**
   * pyeapi `run_commands` (`client.py:876-925`): send exactly these commands and return the raw
   * per-command replies, minus the enable reply when one was prepended.
   *
   * The `MULTILINE:` pseudo-syntax is **not** ported (DR-015, MIGRATION.md §5 row 16): a multiline
   * command is a real `{cmd, input}` object on the wire (`JsonCli.py:36-39` allows exactly
   * `cmd`/`input`/`revision`), and text containing `MULTILINE:` is passed through verbatim rather than
   * rewritten behind the caller's back.
   */
  async runCommands(commands: CommandSpec | readonly CommandSpec[], options: NodeRequestOptions = {}): Promise<readonly CommandResult[]> {
    const trip = await this.roundTrip(commands, options)
    return trip.result
  }

  /**
   * pyeapi `enable()` (`client.py:800-874`), renamed because `exec` is what a reader expects next to
   * `show` (MIGRATION.md §2). One entry per command, each carrying the encoding that actually answered.
   *
   * * `tolerateErrors` (default `true`, pyeapi's `strict=False`): **one request per command**, each
   *   with `enable` prepended again — the request count upstream's
   *     `test_enable_with_multiple_commands` asserts. A `1003` answer is repaired by the codec
   *     (`internal/wire.ts` → `format:'text'`, DR-012) and the entry reports `encoding:'text'` +
   *     `fellBack:true`; any other failure throws.
   * * `tolerateErrors: false` (pyeapi's `strict=True`, `client.py:849-856`): **one request with every
   *   command**, `stopOnError` left at the device default, and the first failure throws a
   *   `CommandError` whose `results`/`trace()` say how far it got.
   */
  async exec(commands: CommandSpec | readonly CommandSpec[], options: NodeRequestOptions = {}): Promise<readonly ExecResult[]> {
    const specs = toCommandSpecArray(commands)
    assertNotConfigMode(specs)
    if (options.tolerateErrors === false) {
      const trip = await this.roundTrip(specs, options)
      return specs.map((command, index) => ({
        command,
        result: singleResult(trip.result.slice(index), command),
        encoding: trip.encoding,
        fellBack: trip.fellBack,
      }))
    }
    const entries: ExecResult[] = []
    for (const command of specs) {
      const trip = await this.roundTrip([command], options)
      entries.push({ command, result: singleResult(trip.result, command), encoding: trip.encoding, fellBack: trip.fellBack })
    }
    return entries
  }

  /**
   * One `show` command, typed by the augmentable {@link ShowContracts} map
   * (docs/ARCHITECTURE.md §9.1 — the extension point the webui builds on).
   *
   * A command literal that nobody has modelled resolves to `unknown`, never `any`, so the caller has
   * to say what it thinks the device returned; this is the one place a `CommandResult` is asserted to
   * be a contract reply (`src/types/eapi.test.ts` pins that boundary at type level).
   *
   * Reads default to `readOnly: true` (DR-019) because one cannot mutate device state, so a
   * `ConnectError` that means "nothing reached the switch" may be re-sent once.
   */
  async show<K extends keyof ShowContracts | string>(command: K, options: ShowOptions = {}): Promise<ShowReply<K>> {
    const { revision, ...request } = options
    const text = showCommand(String(command))
    const spec: CommandSpec = revision === undefined ? text : { cmd: text, revision }
    const trip = await this.roundTrip([spec], { format: 'json', readOnly: true, ...request })
    const reply = singleResult(trip.result, spec)
    return reply as unknown as ShowReply<K>
  }

  /**
   * A `show` whose answer has no JSON model, forced to `format:'text'` — the shape
   * `show session-config diffs` has on 4.28 (DR-012: un-modelled shows answer `1003`, and
   * `showText` is how M5's `diff()` stays honest). Returns the device's text block.
   */
  async showText(command: string, options: ShowTextOptions = {}): Promise<string> {
    const spec = showCommand(command)
    const trip = await this.roundTrip([spec], { format: 'text', readOnly: true, ...options })
    return outputText(singleResult(trip.result, spec), spec)
  }

  /**
   * `show running-config` / `show startup-config`, as text.
   *
   * pyeapi `get_config(config, params, as_string)` (`client.py:952-989`); the option names follow the
   * wire vocabulary and `as_string` becomes `as` (MIGRATION.md §5 row 31), while the *default* stays
   * pyeapi's list-ish answer so a port reads directly.
   */
  async getConfig<TAs extends ConfigOutput = 'lines'>(
    options: (GetConfigOptions & { readonly as?: TAs }) | undefined = {},
  ): Promise<TAs extends 'string' ? string : readonly string[]> {
    const { config = 'running-config', params, as = 'lines', ...request } = options
    assertConfigTarget(config)
    const command = params ? `show ${config} ${params}` : `show ${config}`
    const trip = await this.roundTrip([command], { format: 'text', readOnly: true, ...request })
    const text = outputText(singleResult(trip.result, command), command)
    // pyeapi strips for `as_string` (`client.py:986-987`) and does not strip for the list form (`:989`).
    const answer: string | readonly string[] = as === 'string' ? text.trim() : text.split('\n')
    return answer as TAs extends 'string' ? string : readonly string[]
  }

  /**
   * pyeapi's `running_config` **property** (`client.py:519-527`) as an async accessor (DR-005: no
   * synchronous property may perform I/O, and a TS getter cannot `await`). Cached until `refresh()` or
   * a write with `autorefresh` on — MIGRATION.md §5 row 34.
   */
  async getRunningConfig(): Promise<string> {
    if (this.runningConfig !== undefined) return this.runningConfig
    const configDefaults = this.configDefaults
    const config = await this.getConfig({
      config: 'running-config',
      as: 'string',
      ...(configDefaults ? { params: 'all' } : {}),
    })
    this.runningConfig = config
    return config
  }

  /** pyeapi's `startup_config` property (`client.py:528-535`) as an async accessor — no `all` params, as upstream. */
  async getStartupConfig(): Promise<string> {
    if (this.startupConfig !== undefined) return this.startupConfig
    const config = await this.getConfig({ config: 'startup-config', as: 'string' })
    this.startupConfig = config
    return config
  }

  /**
   * The cached config text, split into sections and sub-sections — pyeapi's `_chunkify()`
   * (`client.py:697-774`) reached through {@link getRunningConfig} / {@link getStartupConfig}, and
   * M6 (#8)'s chunker doing the parse. Shipped by M7 (#9): `src/config/` deliberately shipped with no
   * `Node` methods, and PR #23 named this pairing as the milestone that wires it.
   *
   * The memo is DR-026's (one entry per source, hash-checked then confirmed by exact string equality,
   * `src/config/cache.ts`), which is what replaces pyeapi's unbounded `lru_cache` + manual
   * `cache_clear()`. So a `getAll()` that calls {@link section} 48 times over one config text chunks it
   * once, and {@link refresh} / {@link configure} are the only ways the entry is dropped.
   *
   * pyeapi accepts the `'running_config'`/`'startup_config'` sentinel strings and resolves them against
   * `self` (`client.py:789-791`); here the source is the {@link ConfigTarget} union, validated at runtime
   * for a caller arriving from JS exactly as {@link getConfig} validates it (row 36).
   */
  async chunkConfig(options: NodeConfigOptions = {}): Promise<ConfigSections> {
    const { config = 'running-config' }: NodeConfigOptions = options
    assertConfigTarget(config)
    return config === 'startup-config'
      ? this.startupChunks.chunkConfig(await this.getStartupConfig())
      : this.runningChunks.chunkConfig(await this.getRunningConfig())
  }

  /**
   * The text of the first section whose **key** matches `pattern` — pyeapi `Node.section(regex, config)`
   * (`client.py:776-798`), which is a search over section keys, not over config text; a string pattern is
   * compiled as a regex exactly as `client.py:792` compiles it.
   *
   * M6 (#8)'s pure `section()` over this `Node`'s memoized document. Absence is a `NotFoundError`
   * carrying the pattern, replacing pyeapi's `TypeError('config section not found')` (`client.py:795`),
   * which was indistinguishable from a wrong-argument-type `TypeError` (DR-027). A genuine pattern error
   * stays a `SyntaxError` — it is not disguised as "the switch has no such section".
   */
  async section(pattern: SectionPattern, options: NodeConfigOptions = {}): Promise<string> {
    return matchSection(pattern, { sections: await this.chunkConfig(options) })
  }

  /**
   * The whole block under one exact section header, or `undefined` when the switch does not have that
   * section — pyeapi keeps this on the resource base (`abstract.py:82-101`); this client exposes it on
   * `Node` as well (M7 #9) because it is the same `'^%s$'` splice over the same memo, and the parent is
   * interpolated **as written** upstream parity (`abstract.py:98`), so a parent containing regex
   * metacharacters is a pattern rather than a name.
   *
   * `undefined` and not a throw: upstream's `except TypeError` (`abstract.py:100-101`) converted *any*
   * `TypeError` — including a bad pattern — to `None`; this converts only `NotFoundError` (DR-027),
   * so a resource deciding "absent" is ordinary control flow while a mistake stays loud.
   */
  async getBlock(parent: string, options: NodeConfigOptions = {}): Promise<string | undefined> {
    return blockOfSection(parent, { sections: await this.chunkConfig(options) })
  }

  /**
   * The `system` resource — the first of PLAN.md M7's "static accessors instead of `node.api('vlans')`"
   * (`node.system`), which M7 left unticked with a reason: a getter's type must be a module class, and no
   * module class existed until M8 (#10) shipped `src/resources/system.ts`. The value comes from the same
   * per-`Node` {@link resourceMemo} as {@link resource}, so there is no second cache and
   * `node.system === node.system === node.resource('system')` (DR-052). pyeapi has no accessor at all —
   * `node.api('system')` resolves a module path and builds a fresh object per call (`client.py:927-950`).
   */
  get system(): SystemResource {
    return this.resource('system')
  }

  /**
   * The `vlans` resource — the same per-`Node` {@link resourceMemo} as {@link resource}, exactly as M8
   * (#10) wired `node.system` (DR-052): `node.vlans === node.vlans === node.resource('vlans')`. pyeapi's
   * equivalent is `node.api('vlans')`, which resolves a module path and rebuilds the object every call
   * (`client.py:927-950`); the module factory it replaces is `vlans.py:361-372`. Added by M9 (#11).
   */
  get vlans(): VlansResource {
    return this.resource('vlans')
  }

  /**
   * The `switchports` resource — same memo, same reasoning as {@link vlans}; pyeapi's factory is
   * `switchports.py:406-417` and its accessor never was (DR-006). Added by M9 (#11).
   */
  get switchports(): SwitchportsResource {
    return this.resource('switchports')
  }

  /**
   * The `interfaces` resource — same per-`Node` {@link resourceMemo} as {@link system} / {@link vlans} /
   * {@link switchports} (DR-052): `node.interfaces === node.interfaces === node.resource('interfaces')`.
   * pyeapi reaches the same object through `node.api('interfaces')`, which loads `pyeapi.api.interfaces`
   * off the filesystem and calls its `instance(api)` (`interfaces.py:1100-1101`, `client.py:927-950`) —
   * DR-006's target, which is why there is no upstream accessor to name. Added by M10a (#12).
   */
  get interfaces(): InterfacesResource {
    return this.resource('interfaces')
  }

  /**
   * The `acls` resource — same per-`Node` {@link resourceMemo} as {@link interfaces} (DR-052):
   * `node.acls === node.acls === node.resource('acls')`, and its `standard` / `extended` halves are one
   * object each on that instance. pyeapi reaches the same thing through `node.api('acls')`, which loads
   * `pyeapi.api.acl` off the filesystem and calls its `instance(api)` (`acl.py:302-303`,
   * `client.py:927-950`), and then routes every entry verb through `__getattr__`/`marshall` (`:114-124`)
   * — the dispatch DR-092 replaces with named methods. Added by W2b (#37).
   */
  get acls(): AclsResource {
    return this.resource('acls')
  }

  /**
   * The `varp` resource — same memo, same reasoning as {@link acls}. pyeapi's factory is `varp.py:202`
   * (`instance(node)` → `Varp(node)`), reached only as `node.api('varp')`; the per-interface half hangs off
   * it as `node.varp.interfaces`, which is upstream's `interfaces` property (`varp.py:59-63`). Added by
   * W2b (#38).
   */
  get varp(): VarpResource {
    return this.resource('varp')
  }

  /**
   * The resource for `name` — DR-006's replacement for pyeapi's string-keyed `Node.api(name)`
   * (`client.py:927-950`, where the name is a module path loaded off the filesystem). Here it is a key of
   * the augmentable {@link ResourceKinds} map, checked at compile time and again at runtime
   * (`src/resources/registry.ts`), and the instance is memoised per `Node` rather than rebuilt per call
   * (pyeapi builds a fresh object every call, `client.py:946-949`).
   *
   * M7 (#9) shipped the map empty, M8 (#10) claimed the first row, M9 (#11) claimed `vlans` /
   * `switchports`, M10a (#12) claimed `interfaces` and W2b (#37 #38) claimed `acls` / `varp`, so an
   * unregistered name — a typo, or a module a later milestone owes — throws a `NotSupportedError` naming it
   * and listing what is registered. Apps
   * define their own resources with `createResourceRegistry(factories, node)`.
   *
   * @throws {NotSupportedError} no factory is registered for `name`.
   */
  resource<K extends ResourceName>(name: K): ResourceKinds[K] {
    return this.resourceMemo.get(name)
  }

  /**
   * Is there a resource behind `name`? Takes any property key on purpose — this is the check for a name
   * that is only known at runtime (a webui table column), which the typed union cannot express.
   */
  hasResource(name: PropertyKey): boolean {
    return this.resourceMemo.has(name)
  }

  /**
   * The device identity, read once and memoised. pyeapi has three separate lazy properties
   * (`client.py:536-556`) that can each fire their own `show version`, and parses the same answer
   * three times (MIGRATION.md §2, §5 row 35).
   *
   * Not invalidated by {@link refresh}, exactly like pyeapi (`client.py:991-1001` clears only the two
   * configs): a device's model does not change under a connected client, and `refresh()` is a
   * config-cache operation.
   */
  async getVersion(): Promise<VersionProperties> {
    if (this.versionInfo !== undefined) return this.versionInfo
    const trip = await this.roundTrip(['show version'], { format: 'json', readOnly: true })
    const info = parseVersionProperties(singleResult(trip.result, 'show version'))
    this.versionInfo = info
    return info
  }

  /**
   * pyeapi `config()` → `_configure_terminal()` (`client.py:590-674`) with the
   * `configure_session` half left to M5 (#7): `configure terminal` is prepended (pyeapi
   * `client.py:663`), the enable reply is popped by the command layer, and this command's own reply is
   * popped before returning (pyeapi `client.py:672`) — the caller gets exactly the replies to the
   * commands it wrote.
   *
   * pyeapi returns `False`/stashes `.error` in the resource layer; this throws (DR-005). There is no
   * boolean return to check.
   */
  async configure(commands: CommandSpec | readonly CommandSpec[], options: NodeRequestOptions = {}): Promise<readonly CommandResult[]> {
    // M5 (#7, DR-025): a live config session on this Node blocks terminal mode, before any request.
    assertTerminalModeAllowed(this.activeSession, ['configure terminal'])
    const specs = toCommandSpecArray(commands)
    const trip = await this.roundTrip(['configure terminal', ...specs], options)
    // pyeapi clears the `_chunkify` lru_cache unconditionally here (`client.py:665-666`), *before* the
    // `autorefresh` gate at `:668-669`. The same seam, so the ordering is not free to drift: a derived
    // parse must never outlive a write even for an operator who turned `autorefresh` off (row 80).
    this.clearConfigChunks()
    if (this.autorefresh) this.refresh()
    return trip.result.slice(1)
  }

  /**
   * {@link configure} tried once per command variant, first success wins, last `CommandError`
   * re-raised — the port of pyeapi's `CliVariants` splice (`client.py:645-652`) without the marker
   * object inside the command list (DR-006, MIGRATION.md §5 row 37).
   *
   * ```ts
   * await node.configureVariants([
   *   ['vrf instance mgmt'],      // 4.28 form
   *   ['vrf definition mgmt'],    // form this model may reject with 1002
   * ])
   * ```
   */
  configureVariants(variants: readonly CliVariant[], options: NodeRequestOptions = {}): Promise<readonly CommandResult[]> {
    return tryVariants(variants, (commands) => this.configure(commands, options))
  }

  /**
   * pyeapi `refresh()` (`client.py:991-1001`): drop the cached configs so the next read re-fetches
   * them (DR-005/DR-026/DR-030 — the single invalidation point every later cache hangs off).
   * Synchronous and non-throwing by design: it is a cache clear, not a device call.
   *
   * M7 (#9) added the derived half: the chunk memos are cleared here too, because a section document
   * parsed from text that is no longer held cannot be trusted. pyeapi's equivalent is the manual
   * `_chunkify.cache_clear()` at `client.py:666`/`:690` plus `_chunkify`'s own text key.
   */
  refresh(): void {
    this.runningConfig = undefined
    this.startupConfig = undefined
    this.clearConfigChunks()
  }

  /** The one seam both chunk memos hang off, so no later cache can be forgotten by half of it. */
  private clearConfigChunks(): void {
    this.runningChunks.invalidate()
    this.startupChunks.invalidate()
  }

  // --- M5 (#7): config sessions and change safety -------------------------------------------------
  // Every verb below is a thin delegator to `src/config-session.ts`, where the state machine, the
  // `configure session <name>` re-attach rule (DR-022) and the EOS grammar evidence live. Kept thin on
  // purpose: this file is the surface, that file is the policy.

  /**
   * Open (or re-attach to) a config session. Sends **no** request: like pyeapi's `configure_session()`
   * (`client.py:1003-1006`, which only makes a `uuid4`), the device-side session is created by the first
   * batch's `configure session <name>` opener. The promise is the journal write, when a journal is
   * supplied — that record is what lets a later process find this session after a crash (DR-022/DR-023).
   *
   * Refuses to open a second live session on this `Node` (DR-025).
   */
  async configSession(options: ConfigSessionOptions = {}): Promise<ConfigSession> {
    assertTerminalModeAllowed(this.activeSession)
    const session = await createConfigSession(this, options)
    this.activeSession = session
    return session
  }

  /** The session this `Node` is responsible for, if any — read-only handle for a UI's "you have pending changes" banner. */
  get activeConfigSession(): ConfigSession | undefined {
    return this.activeSession
  }

  /** `show configuration sessions [detail]`, parsed and validated (DR-023). A malformed reply is a `ProtocolError`, never an empty table. */
  listSessions(options: ListSessionsOptions = {}): Promise<ConfigurationSessions> {
    return listSessionsOn(this, options)
  }

  /**
   * Abort a session by name from exec mode — the cleanup verb for a session this client has no handle
   * for. pyeapi has nothing equivalent; EOS answers "Cannot abort non-existent session %s." for a stale
   * name, so the caller learns which names were real (`SessionCli.py:358-360`).
   */
  abortSession(name: string, options: NodeRequestOptions = {}): Promise<readonly CommandResult[]> {
    return abortSessionOn(this, name, options)
  }

  /** Find and abort the pending sessions that hold the config lock and produce the next client's 1006 (DR-023). */
  recoverOrphans(options: RecoverOrphansOptions = {}): Promise<RecoverOrphansOutcome> {
    return recoverOrphansOn(this, options)
  }

  /**
   * `copy running-config startup-config` — durability is explicit (DR-024): a committed config session
   * changes running-config only, and nothing in this package ever saves it implicitly. pyeapi has no
   * such verb at all, which is why a pyeapi-driven change disappears on reboot.
   */
  copyRunningToStartup(options: NodeRequestOptions = {}): Promise<readonly CommandResult[]> {
    return copyRunningToStartupOn(this, options)
  }

  /** {@link copyRunningToStartup} under the name operators use. Same command, same explicitness. */
  writeMemory(options: NodeRequestOptions = {}): Promise<readonly CommandResult[]> {
    return this.copyRunningToStartup(options)
  }

  /**
   * `configure replace <url> […]` (`ConfigSessionCli.py:128-155`) — wholesale running-config replace, refused
   * locally while a session is open on this node (the command exits sessions it finds, `:57`). A device
   * rejection for a pending commit timer arrives as `SessionError` naming the session (row 69).
   */
  async configureReplace(url: string, options: ConfigureReplaceOptions = {}): Promise<readonly CommandResult[]> {
    assertNoSessionConflict(this.activeSession, 'configureReplace()', [url])
    return await configureReplaceOn(this, url, options)
  }

  /**
   * Open a session and stage `rollback clean-config [ { groups } ]` in it, returning the session
   * **un-committed**. The command only exists inside a config session
   * (`SessionCli.py:445-480`), and DR-024's rule says a destructive change is staged, shown as a diff,
   * then committed on purpose — never applied by the verb that requested it.
   */
  async rollbackCleanConfig(options: ConfigSessionOptions & { readonly groups?: readonly string[] | undefined } = {}): Promise<ConfigSession> {
    const session = await this.configSession(options)
    await session.rollbackCleanConfig(options.groups)
    return session
  }

  /** {@link rollbackCleanConfig} for a previously committed session name instead of the clean config. */
  async rollbackToSession(name: string, options: ConfigSessionOptions = {}): Promise<ConfigSession> {
    const session = await this.configSession(options)
    await session.rollbackToSession(name)
    return session
  }

  // --- M11 (#13): the non-`runCmds` methods -------------------------------------------------------
  //
  // The three verbs below send a JSON-RPC method the command layer has never sent before. The seam is
  // `Transport#callMethod` (contract.ts), which exists because `execute()` is `runCmds`-shaped by
  // construction and **no amount of command-list gymnastics turns into another method** — the
  // alternatives were a second HTTP stack (duplicating DR-013's TLS trust plumbing) or a verb that
  // only works in tests. Neither is honest for a call the review screen depends on.

  /**
   * One JSON-RPC call that is not `runCmds`, through the transport's method seam.
   *
   * `async` and refusing **inside** the promise: a device-facing verb that throws synchronously breaks
   * every caller's error channel at once (the rule M5 learned, recorded in `config-session.ts`).
   */
  private async callDeviceMethod<C extends WireMethodCall>(call: C, options: MethodCallOptions): Promise<WireMethodResultOf<C>> {
    const transport = this.connection
    if (typeof transport.callMethod !== 'function') {
      throw new NotSupportedError(
        `cannot call ${call.method}(): the transport at ${transport.address} does not implement Transport#callMethod, the M11 (#13) seam for the non-runCmds eAPI methods. Every transport createTransport() builds provides it, and so does MockTransport; a hand-rolled Transport written before #13 needs that one member. This client will not fake the call with runCmds: a configlet sent as a command batch is a configlet that gets applied, whereas verifyConfig runs in a session the device opens and aborts itself (JsonCli.py:293-305).`,
      )
    }
    const outcome = await transport.callMethod(call, options)
    if (!outcome.ok) throw outcome.error
    return outcome.result
  }

  /**
   * `verifyConfig` — the dry run PLAN §M11 asks for, and the reason M5's `validateChanges` is
   * documented as "the device applied these" rather than a preview (DR-050).
   *
   * What the device does, from its own code (`JsonCli.py:275-330`): one `copy terminal: session-config`
   * per configlet inside a server-owned `configure session capiVerify-… no-commit` opened on top of
   * `rollback clean-config`, `show session-config` after each application, and `abort` at the end.
   * So the answer is the **aggregated normalised configlet** for each step, and running-config is
   * untouched — but note `rollback clean-config`: the review starts from the *clean* configuration, not
   * the current running-config, so it answers "what does this configlet text normalise to", not "what
   * would my change do to this switch". That distinction belongs on any UI built over this verb.
   *
   * The device opens and aborts that session itself, so this call leaves no pending session for
   * {@link recoverOrphans} — unlike `probeCommands` in `src/capabilities.ts`, which uses a session this
   * client owns and therefore guarantees its own `abort` on every path.
   */
  async verifyConfig(configlets: string | readonly string[], options: VerifyConfigOptions = {}): Promise<VerifyConfigOutcome> {
    const { timeoutMs, signal, readOnly, ...parameters } = options
    const params = buildVerifyConfigParams(configlets, parameters)
    const call: VerifyConfigCall = { method: 'verifyConfig', params }
    const result = await this.callDeviceMethod(call, { timeoutMs, signal, readOnly })
    return parseVerifyConfigReply(result, { configList: params.configList, ...(params.format === undefined ? {} : { format: params.format }) })
  }

  /**
   * What could the partial line `partial` still become? `getCommandCompletions` (`JsonCli.py:173-192`),
   * for the webui's command input (PLAN §M11 box 3). Pass `preamble` to complete inside a config mode —
   * those commands are **executed** by the device first (`CliApi.py:659-663`), so they run with the
   * caller's privilege and are not a hint.
   *
   * Read-only in the sense that it changes nothing on the device, yet `readOnly` still defaults to
   * `false` (DR-019): the preamble is a command list, and "this call is safe to re-send" is a claim the
   * caller has to make about their own preamble.
   */
  async getCompletions(partial: string, options: GetCompletionsOptions = {}): Promise<CommandCompletions> {
    const { timeoutMs, signal, readOnly, ...parameters } = options
    const params = buildGetCommandCompletionsParams(partial, parameters)
    const call: GetCommandCompletionsCall = { method: 'getCommandCompletions', params }
    const reply = await this.callDeviceMethod(call, { timeoutMs, signal, readOnly })
    return parseCommandCompletions(reply)
  }

  /**
   * The help text beside each token of `command` — `getCommandHelp` (`JsonCli.py:199-203`), whose
   * answer is the device's `{token: help}` object (`CliApi.py:452`). A value here can be a guard code
   * rather than prose on some commands (`CliApi.py:650`, flagged as a bug by Arista's own comment), and
   * anything non-string is reported in {@link CommandHelp.unparsed} rather than softened into ''.
   */
  async getCommandHelp(command: string, options: GetCommandHelpOptions = {}): Promise<CommandHelp> {
    const { timeoutMs, signal, readOnly, ...parameters } = options
    // The method has one parameter, so anything else in `options` is a typo for a parameter it does not
    // have — and DR-016 refuses that rather than ignoring it. Forwarded through `params`, where
    // `buildMethodRequest` runs the allow-list; the positional `command` always wins.
    const call: GetCommandHelpCall = { method: 'getCommandHelp', params: { ...parameters, command } as unknown as GetCommandHelpParams }
    const reply = await this.callDeviceMethod(call, { timeoutMs, signal, readOnly })
    return parseCommandHelp(reply)
  }
}
