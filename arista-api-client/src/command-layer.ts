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
 *    (`test_client.py::test_api_autoloader`) has nothing to port to.
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
import { redactCommands } from './internal/redact'
import { toCommandSpecArray } from './internal/wire'
import { tryVariants } from './internal/variants'
import type { CliVariant } from './internal/variants'
import type { Transport, TransportExecOptions } from './transports/contract'
import type { CommandResult, CommandSpec, RunCmdsFormat, ShowContracts, ShowReply } from './types/eapi'

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
    // pyeapi clears the `_chunkify` lru_cache here (`client.py:666`) and refreshes only when
    // `autorefresh` is on (`client.py:668-669`). M4 owns no derived cache to clear, and M6's
    // replacement memo is keyed by config content (DR-026), so the stale-parse class of bug cannot
    // exist on this side of the seam.
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
   */
  refresh(): void {
    this.runningConfig = undefined
    this.startupConfig = undefined
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
}
