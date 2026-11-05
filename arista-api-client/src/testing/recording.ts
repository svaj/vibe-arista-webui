/**
 * The fixture recorder — M2 (#4) seam, completed by M12 (#14).
 *
 * The point of putting this in the transport layer (rather than in a device-facing script) is that a
 * recording is a **wire** artefact: `src/transports/base.ts` already runs every traced body through
 * `redactWireText`, so an exchange captured here cannot contain an enable password or a
 * `username … secret …` value (DR-011). TESTING.md §4 requires "every fixture is redacted on write";
 * with this seam, redaction happens on *capture*, which is the safer of the two orders — and
 * {@link buildRecording} runs the same rules a **second** time on the way out, so a fixture cannot be
 * written by a caller who forgot to attach `trace` (see {@link recordSender}).
 *
 * What M12 (#14) added on top of the M2 stub (the pieces its header listed as "deliberately do not
 * exist yet"):
 *  - {@link buildRecording} / {@link recordingText} / {@link parseRecording}: the
 *    `test/fixtures/recordings/<target-slug>/<case>.json` layout of docs/TESTING.md:106-122 and
 *    docs/CEOS.md:143-145, with a version/model-separated slug ({@link targetSlugFor}) so a cEOS
 *    capture can never land in the 7050TX-64 directory (DR-043);
 *  - the identity envelope beside the `{cmds → reply}` map, plus {@link assertRecordingIdentity}, which
 *    is how "a replay can refuse a mismatched device" actually happens;
 *  - {@link findUnredactedEnableInput}, the assertion TESTING.md §4 asks for — enforced on **write and
 *    on load**, so a hand-edited fixture cannot smuggle a password back in;
 *  - {@link replayRecording}, which scripts a fixture onto `MockTransport` for offline replay.
 *
 * Still not here, deliberately: the cEOS provisioning/readiness mechanics (that is the sibling M12
 * lane), and anything touching a socket or a filesystem. Filesystem writes live in
 * `recorder-node.ts`, not here, so this module keeps the browser guarantee (DR-002).
 *
 * Browser-safe (no `node:*`), because the webui's own component tests may record and replay fixtures.
 */

import { parseVersionProperties } from '../command-layer'
import { REDACTED, redactWireText } from '../internal/redact'
import type { WireTraceRecord, WireTraceSink } from '../transports/contract'
import type { CommandResult, CommandSpec, JsonRpcError, JsonRpcRequest, RunCmdsFormat, WireSender } from '../types/eapi'
import type { MockReply } from './mock-transport'

/** One completed request/response (or request/failure) pair, keyed by the DR-017 request id. */
export interface RecordedExchange {
  readonly requestId: string
  readonly endpoint: string
  /** Request text as sent — already redacted, so this is safe to commit. */
  readonly request: string
  /** Response text, when the round trip completed. */
  readonly response?: string | undefined
  /** Mapped failure text, when it did not (`AuthError: …`, `TlsError: …`). */
  readonly failure?: string | undefined
}

export interface Recorder {
  /** Pass this as the transport's `trace` option. */
  readonly sink: WireTraceSink
  /** Completed exchanges, in arrival order. Pending requests are not included. */
  exchanges(): readonly RecordedExchange[]
  /**
   * Request ids whose reply never arrived. M12 (#14) needs this on the interface, not only in
   * `dump()`'s text: a fixture records them so a replay can tell "the device died mid-batch" from
   * "the harness forgot to wait", and so a half-captured case is never silently written as complete.
   */
  incomplete(): readonly string[]
  /** JSON text ready to become a fixture file once M12 (#14) chooses the layout and target metadata. */
  dump(): string
  /** Drop everything captured so far, e.g. between cases in one file. */
  clear(): void
}

/**
 * Create an in-memory recorder:
 *
 * ```ts
 * const recorder = createRecorder()
 * const transport = createTransport({ kind: 'https', host: 'sw1.lan', username: 'api', password: pw, trace: recorder.sink })
 * await transport.execute('show version')
 * recorder.dump()
 * ```
 */
export function createRecorder(): Recorder {
  const partial = new Map<string, { endpoint: string; request?: string; response?: string; failure?: string }>()
  const done: RecordedExchange[] = []

  const sink: WireTraceSink = (entry: WireTraceRecord): void => {
    const record = partial.get(entry.requestId) ?? { endpoint: entry.endpoint }
    if (entry.direction === 'request') partial.set(entry.requestId, { ...record, request: entry.body })
    else if (entry.direction === 'response') {
      partial.delete(entry.requestId)
      done.push({ requestId: entry.requestId, endpoint: entry.endpoint, request: record.request ?? '', response: entry.body })
    } else {
      partial.delete(entry.requestId)
      done.push({ requestId: entry.requestId, endpoint: entry.endpoint, request: record.request ?? '', failure: entry.body })
    }
  }

  return {
    sink,
    exchanges(): readonly RecordedExchange[] {
      return done.map((entry) => ({ ...entry }))
    },
    incomplete(): readonly string[] {
      return [...partial.keys()]
    },
    /**
     * The **debug** view: flat, one entry per round trip, with the wire text as the sink saw it. Use it
     * when a live run misbehaves; use {@link buildRecording} for the file that gets committed, which
     * adds the identity envelope and refuses anything the redaction guard does not like.
     */
    dump(): string {
      return JSON.stringify(
        {
          recorded: done.length,
          // A request with no reply is a live/in-flight or cancelled exchange: recording it half-done
          // would produce a fixture nobody can replay, so it is listed but flagged.
          incomplete: [...partial.keys()],
          exchanges: done,
        },
        null,
        2,
      )
    },
    clear(): void {
      partial.clear()
      done.length = 0
    },
  }
}

// --- the committed fixture format (M12, #14) -------------------------------------------------------

/**
 * Discriminator written into every fixture, so a loader can tell a recording from a hand-authored
 * `test/fixtures/wire/*.json` envelope and from a future `v2` layout, instead of guessing from keys.
 */
export const RECORDING_FORMAT = 'arista-eapi-recording/v1' as const

/**
 * What kind of target produced a capture. DR-043 (`docs/DECISIONS.md:316-350`) is the reason this is
 * part of the file rather than a path convention only: "Record cEOS **4.28.14M** fixtures/capabilities
 * separately from **DCS-7050TX-64 / 4.28.13.1M** evidence", and `docs/CEOS.md:143-145` repeats it as a
 * directory rule. A tool can therefore refuse the crossover by reading the JSON, even when somebody
 * moves a file by hand.
 */
export const TARGET_CLASSES = ['lab', 'hardware'] as const
export type TargetClass = (typeof TARGET_CLASSES)[number]

/**
 * `captured` = a real round trip was recorded. `hand-authored-example` = a person wrote it to
 * demonstrate the layout; per docs/TESTING.md:117-118 such a fixture must be marked, and no test may
 * present it as device evidence.
 */
export type RecordingProvenance = 'captured' | 'hand-authored-example'

/** What the caller asserts about the device it captured from. */
export interface DeviceIdentity {
  /** `modelName` exactly as the device reported it — do not tidy it up here, the slug does that. */
  readonly modelName: string
  /** `version` exactly as the device reported it, e.g. `4.28.14M`. */
  readonly version: string
  readonly targetClass: TargetClass
  /** Image identity/checksum, as `docs/CEOS.md:145` asks for it. */
  readonly image?: string | undefined
  /** Free-form topology note (interface mapping, single-node vs two-node lab). */
  readonly topology?: string | undefined
  /**
   * Capture timestamp, ISO-8601 UTC. Deliberately **not** defaulted: a `Date.now()` in the writer puts
   * a diff in every refresh, and a fixture whose only change is a timestamp trains reviewers to skim
   * past redaction changes. The M12 harness passes the container's own start time.
   */
  readonly capturedAt?: string | undefined
  readonly provenance?: RecordingProvenance | undefined
  /**
   * Optional, and only to assert agreement: the slug must be the one {@link targetSlug} derives from
   * `modelName` + `version`, so a caller cannot file a cEOS capture under a hardware directory.
   */
  readonly slug?: string | undefined
}

/**
 * The envelope as written. Spelled out rather than derived from {@link DeviceIdentity}: the file names
 * the field `aristaVersion` (the device's own `version` string, as `docs/CEOS.md:113` calls it), while a
 * caller hands the guard `version` — one of the two would be a lie if they were the same field.
 */
export interface RecordingIdentity {
  readonly targetSlug: string
  readonly targetClass: TargetClass
  readonly modelName: string
  /** The device's `version`, verbatim. */
  readonly aristaVersion: string
  /** The leading digits-and-dots run, from `command-layer.ts:274` — for a coarse train check at replay. */
  readonly versionNumber: string
  readonly provenance: RecordingProvenance
  /** Where the capture went (`https://localhost:8443/command-api`). Never contains credentials — contract.ts:104-105. */
  readonly endpoint?: string | undefined
  readonly image?: string | undefined
  readonly topology?: string | undefined
  readonly capturedAt?: string | undefined
}

/**
 * One replayable round trip. The request side keeps the **command list** (post-`buildRequest`, already
 * redacted), which is what PLAN.md:391 calls the `{cmds → reply}` map; the reply side keeps the parsed
 * envelope members **without** `jsonrpc`/`id`, because {@link replayRecording} re-ids them through the
 * mock's own DR-017 policy and a stale id would trip `src/transports/correlate.ts`.
 */
export interface RecordingCapture {
  readonly requestId: string
  readonly commands: readonly CommandSpec[]
  /** The `runCmds` encoding that was asked for, when the request spelled one — a text reply is not a JSON reply. */
  readonly format?: RunCmdsFormat | undefined
  /** Success: one reply object per command, verbatim modulo redaction. */
  readonly result?: readonly CommandResult[] | undefined
  /** A device `error` member (`1002`/`1005`/…): the command ran and was refused, no exception was thrown. */
  readonly error?: JsonRpcError | undefined
  /** A body that never parsed (a truncated proxy page, a TLS alert): replayed as raw bytes for `ProtocolError` cases. */
  readonly raw?: string | undefined
  /** The mapped transport failure text (`AuthError: …`), when nothing came back to parse. */
  readonly failure?: string | undefined
}

/** A fixture file's content. */
export interface RecordingFixture {
  readonly format: typeof RECORDING_FORMAT
  readonly identity: RecordingIdentity
  /** Arrival order, which is replay order — sorting would silently reorder a config session's writes. */
  readonly captures: readonly RecordingCapture[]
  /** Request ids that never got a reply. Flagged, never replayed (the M2 stub's `dump().incomplete`). */
  readonly incomplete: readonly string[]
}

/**
 * `https://…`, `unix:/…` — a recording belongs to one endpoint (docs/CEOS.md:127-129, single-flight per target).
 * Lowercase start, and uppercase **only** where a version token needs it: the docs' own directory names
 * keep the train letter (`recordings/ceos-4.28.14M/`, `recordings/7050tx-64-4.28.13.1M/`,
 * docs/CEOS.md:143-144 and docs/TESTING.md:130-131), so a slug that forced full lowercasing would not
 * match the tree the milestone documents.
 */
const SLUG_PATTERN = /^[a-z0-9][a-zA-Z0-9._-]*$/u

/**
 * Model-name families that name the *platform*, not the product line. Stripped because
 * docs/TESTING.md:130-131 spells the hardware directory `7050tx-64-4.28.13.1M` — without `dcs-`.
 */
const MODEL_VENDOR_PREFIX = /^(?:dcs|dps|aes|aex)-/u
/**
 * Lab product families, normalised to one token regardless of the machine id the container reports —
 * matched as a **prefix**, because a lab target's name usually arrives glued to something
 * (`cEOSLab…`), and the tree the docs specify has one directory per family
 * (`recordings/ceos-4.28.14M/`, docs/CEOS.md:143).
 */
const LAB_MODEL_FAMILY = /^(ceos|veos)/u

/**
 * The version/model-separated directory name: `<family>-<version>` (docs/TESTING.md:130-131,
 * docs/CEOS.md:143-144).
 *
 * `DCS-7050TX-64` + `4.28.13.1M` → `7050tx-64-4.28.13.1M`; anything whose model name starts with
 * `cEOS`/`vEOS` → `ceos-4.28.14M`. Two normalisations, both documented in the spelling the docs already
 * use, and both deliberately **lossy in the same direction**: the slug never contains a serial, MAC or
 * hostname, which is the "redact identifying data as well as credentials" half of docs/TESTING.md:131.
 * The verbatim device strings stay in the envelope, so nothing is lost — and no test here claims to know
 * what `modelName` a given cEOS build reports, which is exactly what a live run pins at run time
 * (`live-guard.ts` `EAPI_ALLOW_MODEL`).
 */
export function targetSlug(modelName: string, version: string, targetClass?: TargetClass | undefined): string {
  const trimmedName = modelName.trim()
  const trimmedVersion = version.trim()
  if (trimmedName === '' || trimmedVersion === '') {
    throw new Error(`targetSlug needs a non-empty modelName and version — got ${JSON.stringify(modelName)} / ${JSON.stringify(version)}`)
  }
  const lower = trimmedName.toLowerCase().replace(/[\s_]+/gu, '-')
  let family: string
  const labFamily = LAB_MODEL_FAMILY.exec(lower)
  if (labFamily !== null) family = labFamily[1] === 'veos' ? 'veos' : 'ceos'
  else family = lower.replace(MODEL_VENDOR_PREFIX, '').replace(/[^a-z0-9.]+/gu, '-')
  family = family.replace(/-+/gu, '-').replace(/^-|-$/gu, '')
  // A hardware target cannot honestly report a lab family name; that contradiction is a bug in the
  // harness's identity plumbing, and a directory name is where it should surface.
  if (targetClass === 'hardware' && (family === 'ceos' || family === 'veos')) {
    throw new Error(`targetClass "hardware" with modelName ${JSON.stringify(modelName)} is a contradiction — cEOS/vEOS captures belong under a lab slug (DR-043)`)
  }
  if (family === '') {
    throw new Error(`no usable platform family could be read out of modelName ${JSON.stringify(modelName)} — pass identity.slug explicitly`)
  }
  const slug = `${family}-${trimmedVersion.replace(/^-+|-+$/gu, '')}`
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(`refusing to make a directory name from ${JSON.stringify(slug)} (a version string with spaces or punctuation, e.g. an engineering build) — pin a shorter identity.slug`)
  }
  return slug
}

/** The assertion behind "separate cEOS from hardware captures": the envelope must match its directory. */
export function assertTargetSlug(slug: string, identity: Pick<DeviceIdentity, 'modelName' | 'version' | 'targetClass'>): void {
  const expected = targetSlug(identity.modelName, identity.version, identity.targetClass)
  if (slug === expected) return
  throw new Error(
    `recording identity mismatch: the capture says ${JSON.stringify(identity.modelName)}/${JSON.stringify(identity.version)}, whose slug is ${JSON.stringify(expected)}, but it is filed under ${JSON.stringify(slug)} — a cEOS recording must never land on top of a ${JSON.stringify(identity.targetClass)} fixture (DR-043, docs/CEOS.md:143-145)`,
  )
}

/** The `{cmd, input}` shape the redactor treats as a secret carrier (`src/internal/redact.ts:50`). */
const ENABLE_COMMAND = /^enable(?:\s|$)/iu

/**
 * The text half of the same rule: `input=<value>` as EOS renders it (`src/internal/redact.ts:32`),
 * with the identical quoted/bare alternatives and the identical terminating character class. The
 * bare-token class is what makes the pair provable: `redactCommandText` replaces the value with
 * `REDACTED` (`src/internal/redact.ts:24`), which itself matches the bare-token class, so a body that
 * has been through the redactor can never satisfy this detector.
 */
const TEXT_INPUT_ASSIGNMENT = /(^|[^\w])input\s*=\s*('[^'\\]*(?:\\.[^'\\]*)*'|"[^"\\]*(?:\\.[^"\\]*)*"|[^\s,;)'"\]{}]+)/giu

function isCommandBearingObject(value: unknown): value is { cmd: string; input?: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as { cmd?: unknown }).cmd === 'string'
}

function unquote(raw: string): string {
  const first = raw.charAt(0)
  if ((first === "'" || first === '"') && raw.length > 1 && raw.charAt(raw.length - 1) === first) return raw.slice(1, -1)
  return raw
}

/**
 * The TESTING.md:112 assertion — "a test asserts the fixture tree contains no
 * `input: "<something-that-isn't-redacted>"` for `cmd: 'enable'`" — as a reusable detector.
 *
 * Two halves, both derived from `src/internal/redact.ts` rather than invented:
 *  1. **structural**: any object whose `cmd` matches `redact.ts:50` and which *has* an `input`
 *     property whose value is not exactly `REDACTED` (`redact.ts:24`) — including an `input` of the
 *     wrong type, because `redactCommands` only rewrites string inputs (`redact.ts:84-87`) and a
 *     numeric/array `input` would sail through it.
 *  2. **textual**: any string still containing `input=<value>` where `<value>` ≠ `REDACTED`. JSON
 *     looking text is parsed and walked too, so a `raw` body cannot hide a structured secret.
 *
 * Returns JSONPath-ish locations (`$.captures[0].commands[1].input`) instead of throwing, so the caller
 * decides whether that is a refusal (write/load) or a report (a whole-tree guard test).
 */
export function findUnredactedEnableInput(value: unknown, path = '$'): string[] {
  const found: string[] = []
  if (typeof value === 'string') {
    for (const match of value.matchAll(TEXT_INPUT_ASSIGNMENT)) {
      const captured = match[2]
      if (captured !== undefined && unquote(captured) !== REDACTED) found.push(`${path} (text: input=${unquote(captured)})`)
    }
    const looksLikeJson = /^\s*[[{]/u.test(value)
    if (looksLikeJson) {
      try {
        found.push(...findUnredactedEnableInput(JSON.parse(value) as unknown, `${path}!json`))
      } catch {
        // Not JSON after all — the text pass above already covered it.
      }
    }
    return found
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => found.push(...findUnredactedEnableInput(entry, `${path}[${String(index)}]`)))
    return found
  }
  if (value === null || typeof value !== 'object') return found
  for (const [key, entry] of Object.entries(value)) {
    const child = `${path}.${key}`
    if (key === 'input' && isCommandBearingObject(value) && ENABLE_COMMAND.test((value as { cmd: string }).cmd)) {
      if (entry !== REDACTED) found.push(`${child} (cmd=${JSON.stringify((value as { cmd: string }).cmd)})`)
      continue
    }
    found.push(...findUnredactedEnableInput(entry, child))
  }
  return found
}

/** Write-time / load-time enforcement of {@link findUnredactedEnableInput}. */
function assertNoUnredactedEnableInput(value: unknown, label: string): void {
  const offenders = findUnredactedEnableInput(value)
  if (offenders.length === 0) return
  throw new Error(
    `refusing to ${label}: an unredacted enable input survived at ${offenders.join(', ')} — ` +
      '`enable` is the only command whose `input` is a password (src/internal/redact.ts:50), and redactCommands/redactSecrets replace it with ' +
      `${JSON.stringify(REDACTED)} (src/internal/redact.ts:84-87, :101-103). A fixture that still spells a real value was not run through the redactor (DR-011, docs/TESTING.md:112)`,
  )
}

/** Command text in either wire form — the same two-line helper `command-layer.ts:226-228` uses. */
function commandText(command: CommandSpec): string {
  return typeof command === 'string' ? command : command.cmd
}

/**
 * The key {@link replayRecording} scripts, and the reason a batch key must spell **every** command:
 * `MockTransport.matches()` compares a string matcher against each command *or* the whole list joined
 * with `\\n` (`src/testing/mock-transport.ts:79-88`).
 */
export function recordingMatchKey(commands: readonly CommandSpec[]): string {
  return commands.map(commandText).join('\n')
}

/** Pull the command list out of a recorded request body, refusing anything that is not a `runCmds` request. */
function requestCommands(body: unknown, label: string): { readonly commands: CommandSpec[]; readonly format?: RunCmdsFormat | undefined } {
  const params = (body as { params?: unknown } | null)?.params
  const cmds = (params as { cmds?: unknown } | null)?.cmds
  if (!Array.isArray(cmds)) {
    throw new Error(`refusing to write ${label}: its request body has no params.cmds array, so there is no replayable command list to record (method=${JSON.stringify((body as { method?: unknown } | null)?.method)})`)
  }
  const commands: CommandSpec[] = []
  for (const entry of cmds) {
    if (typeof entry === 'string') commands.push(entry)
    else if (isCommandBearingObject(entry)) {
      const cmd = (entry as { cmd: string; input?: unknown; revision?: unknown })
      commands.push({
        cmd: cmd.cmd,
        ...(typeof cmd.input === 'string' ? { input: cmd.input } : {}),
        ...(typeof cmd.revision === 'number' ? { revision: cmd.revision } : {}),
      })
    } else throw new Error(`refusing to write ${label}: params.cmds contains an entry that is not a command string or {cmd,…} object`)
  }
  const format = (params as { format?: unknown } | null)?.format
  return { commands, ...(format === 'json' || format === 'text' ? { format } : {}) }
}

/** Turn one completed exchange into a capture, redacting on the way out (DR-011, docs/TESTING.md:112). */
function captureOf(exchange: RecordedExchange, index: number): RecordingCapture {
  const label = `fixture entry ${String(index)} (request ${JSON.stringify(exchange.requestId)})`
  const requestText = redactWireText(exchange.request)
  let request: unknown
  try {
    request = JSON.parse(requestText) as unknown
  } catch {
    throw new Error(
      `refusing to write ${label}: its request side is not a JSON-RPC body (${JSON.stringify(requestText.slice(0, 120))}). ` +
        'Every exchange a fixture keeps must be replayable; a request we cannot read cannot be keyed by its commands. ' +
        'The M2 recorder pairs by id only after `src/transports/base.ts:85` traced a real body — this is the guard for a caller who fed the sink by hand',
    )
  }
  const { commands, format } = requestCommands(request, label)
  const capture: RecordingCapture = {
    requestId: exchange.requestId,
    commands,
    ...(format === undefined ? {} : { format }),
  }
  if (exchange.response !== undefined) {
    const responseText = redactWireText(exchange.response)
    let envelope: unknown
    try {
      envelope = JSON.parse(responseText) as unknown
    } catch {
      return { ...capture, raw: responseText }
    }
    const result = (envelope as { result?: unknown } | null)?.result
    const error = (envelope as { error?: unknown } | null)?.error
    if (Array.isArray(result)) return { ...capture, result: result as readonly CommandResult[] }
    if (typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'number') {
      return { ...capture, error: error as JsonRpcError }
    }
    // A JSON body that is neither → keep it raw; `parseResponse` is the only validator (M1's rule), and
    // replaying it verbatim is how an invalid-envelope case stays testable offline.
    return { ...capture, raw: responseText }
  }
  if (exchange.failure !== undefined) return { ...capture, failure: redactWireText(exchange.failure) }
  throw new Error(`refusing to write ${label}: it has neither a response nor a failure — a half-captured case must be recorded in "incomplete", not as a fixture entry`)
}

function isRecorder(source: Recorder | readonly RecordedExchange[]): source is Recorder {
  return 'sink' in source && 'exchanges' in source && 'incomplete' in source
}

function exchangeList(source: Recorder | readonly RecordedExchange[]): readonly RecordedExchange[] {
  return isRecorder(source) ? source.exchanges() : source
}

/**
 * Build the fixture that becomes a file. Redaction is applied **again** here (`redactWireText` is
 * idempotent — the bare-token class at `redact.ts:32` was written so re-running it changes nothing), and
 * the enable-input guard runs before anything can be written, so the refusal is a build-time-of-fixture
 * event rather than a review discovery.
 */
export function buildRecording(source: Recorder | readonly RecordedExchange[], identity: DeviceIdentity): RecordingFixture {
  const exchanges = exchangeList(source)
  if (identity.modelName.trim() === '' || identity.version.trim() === '') {
    throw new Error('a recording needs the device identity it came from (modelName + version) — an unlabelled capture cannot be separated from the hardware lane (DR-043)')
  }
  if (!TARGET_CLASSES.includes(identity.targetClass)) {
    throw new Error(`unknown targetClass ${JSON.stringify(identity.targetClass)} — expected one of ${TARGET_CLASSES.join(', ')}`)
  }
  const props = parseVersionProperties({ version: identity.version, modelName: identity.modelName })
  const derived = targetSlug(props.modelName, props.version, identity.targetClass)
  if (identity.slug !== undefined && identity.slug !== derived) {
    throw new Error(`identity.slug ${JSON.stringify(identity.slug)} disagrees with the slug derived from the reported identity (${JSON.stringify(derived)}). Refusing: filing a capture under a name the device did not earn is how cEOS evidence ends up labelled as hardware (DR-043)`)
  }
  const endpoints = [...new Set(exchanges.map((exchange) => exchange.endpoint).filter((endpoint) => endpoint !== ''))]
  if (endpoints.length > 1) {
    throw new Error(`a recording belongs to one endpoint, this one came from ${endpoints.join(', ')} — split the case (docs/CEOS.md:136 wants one container/network/port per parallel job)`)
  }
  const [observedEndpoint] = endpoints
  const fixture: RecordingFixture = {
    format: RECORDING_FORMAT,
    identity: {
      targetSlug: derived,
      targetClass: identity.targetClass,
      modelName: props.modelName,
      aristaVersion: props.version,
      versionNumber: props.versionNumber,
      provenance: identity.provenance ?? 'captured',
      ...(observedEndpoint === undefined ? {} : { endpoint: observedEndpoint }),
      ...(identity.image === undefined ? {} : { image: identity.image }),
      ...(identity.topology === undefined ? {} : { topology: identity.topology }),
      ...(identity.capturedAt === undefined ? {} : { capturedAt: identity.capturedAt }),
    },
    captures: exchanges.map(captureOf),
    incomplete: isRecorder(source) ? source.incomplete() : [],
  }
  assertNoUnredactedEnableInput(fixture, 'write a recording')
  return fixture
}

/** Deterministic serialisation: fixed key order (insertion, as built above), 2-space, trailing newline. */
export function recordingText(fixture: RecordingFixture): string {
  assertNoUnredactedEnableInput(fixture, 'serialise a recording')
  return `${JSON.stringify(fixture, null, 2)}\n`
}

/** Read what a device reply says, for the envelope: reuses the product parser, invents nothing. */
export function identityFromVersionReply(
  reply: CommandResult,
  rest: Omit<DeviceIdentity, 'modelName' | 'version'>,
): DeviceIdentity {
  const props = parseVersionProperties(reply)
  return { modelName: props.modelName, version: props.version, ...rest }
}

/** What the caller expects before it replays a fixture — usually built from `live-guard`'s pins. */
export interface ExpectedDevice {
  readonly slug?: string | undefined
  readonly modelName?: string | undefined
  readonly version?: string | undefined
  readonly versionNumber?: string | undefined
  readonly targetClass?: TargetClass | undefined
}

/**
 * The "a replay can refuse a mismatched device" behaviour, spelled out: a fixture recorded against
 * 4.28.14M cEOS must not be used to green a test whose target reports 4.28.13.1M on a 7050TX-64
 * (DR-043), and a test written for the hardware lane must not be driven by lab output.
 */
export function assertRecordingIdentity(fixture: RecordingFixture, expected: ExpectedDevice): void {
  const got = fixture.identity
  const wanted = [
    expected.slug === undefined ? undefined : ['targetSlug', got.targetSlug, expected.slug],
    expected.modelName === undefined ? undefined : ['modelName', got.modelName, expected.modelName],
    expected.version === undefined ? undefined : ['aristaVersion', got.aristaVersion, expected.version],
    expected.versionNumber === undefined ? undefined : ['versionNumber', got.versionNumber, expected.versionNumber],
    expected.targetClass === undefined ? undefined : ['targetClass', got.targetClass, expected.targetClass],
  ].filter((entry): entry is [string, string, string] => entry !== undefined)
  const wrong = wanted.filter(([, actual, expect]) => actual !== expect)
  if (wrong.length === 0) return
  throw new Error(
    `recording identity mismatch for ${JSON.stringify(got.targetSlug)}: ${wrong.map(([key, actual, expect]) => `${key} recorded=${JSON.stringify(actual)} expected=${JSON.stringify(expect)}`).join('; ')} — refusing to replay a capture from a different device (DR-043)`,
  )
}

/**
 * Read a fixture's JSON text. The redaction guard runs on the way **in** as well: the committed tree is
 * reviewed by humans, and a hand-edit that pastes a real enable password back in must fail the load,
 * not the review (docs/TESTING.md:112).
 */
export function parseRecording(text: string, label = 'recording'): RecordingFixture {
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const candidate = value as Partial<RecordingFixture> | null
  if (candidate === null || typeof candidate !== 'object' || candidate.format !== RECORDING_FORMAT) {
    throw new Error(
      `${label} is not a ${JSON.stringify(RECORDING_FORMAT)} recording (format=${JSON.stringify(candidate?.format)}) — hand-authored envelope cases belong in test/fixtures/wire/, not in recordings/ (docs/TESTING.md:108-109)`,
    )
  }
  const identity = candidate.identity as Partial<RecordingIdentity> | undefined
  if (identity === undefined || typeof identity !== 'object') throw new Error(`${label} has no identity envelope — a fixture without a target cannot be separated from the other lane (DR-043)`)
  for (const key of ['targetSlug', 'modelName', 'aristaVersion', 'versionNumber'] as const) {
    if (typeof identity[key] !== 'string' || identity[key] === '') throw new Error(`${label} identity.${String(key)} is missing or not a string`)
  }
  if (identity.targetClass === undefined || !TARGET_CLASSES.includes(identity.targetClass)) {
    throw new Error(`${label} identity.targetClass must be one of ${TARGET_CLASSES.join(', ')} (got ${JSON.stringify(identity.targetClass)})`)
  }
  if (identity.provenance !== 'captured' && identity.provenance !== 'hand-authored-example') {
    throw new Error(`${label} identity.provenance must be "captured" or "hand-authored-example" — an unmarked fixture is claimed device evidence (docs/TESTING.md:117)`)
  }
  if (typeof identity.targetSlug !== 'string' || !SLUG_PATTERN.test(identity.targetSlug)) {
    throw new Error(`${label} identity.targetSlug=${JSON.stringify(identity.targetSlug)} is not a usable directory name`)
  }
  // The envelope must be internally consistent with the directory rule, or somebody moved a file.
  assertTargetSlug(identity.targetSlug as string, {
    modelName: identity.modelName as string,
    version: identity.aristaVersion as string,
    targetClass: identity.targetClass,
  })
  if (!Array.isArray(candidate.captures)) throw new Error(`${label} has no captures array`)
  const fixture: RecordingFixture = {
    format: RECORDING_FORMAT,
    identity: {
      targetSlug: identity.targetSlug as string,
      targetClass: identity.targetClass,
      modelName: identity.modelName as string,
      aristaVersion: identity.aristaVersion as string,
      versionNumber: identity.versionNumber as string,
      provenance: identity.provenance,
      ...(typeof identity.endpoint === 'string' ? { endpoint: identity.endpoint } : {}),
      ...(typeof identity.image === 'string' ? { image: identity.image } : {}),
      ...(typeof identity.topology === 'string' ? { topology: identity.topology } : {}),
      ...(typeof identity.capturedAt === 'string' ? { capturedAt: identity.capturedAt } : {}),
    },
    captures: (candidate.captures as readonly RecordingCapture[]).map((capture, index) => {
      if (!Array.isArray(capture?.commands)) throw new Error(`${label} captures[${String(index)}] has no commands array — every fixture entry needs the list to replay against (mock-transport keys on it)`)
      const hasReply = capture.result !== undefined || capture.error !== undefined || capture.raw !== undefined || capture.failure !== undefined
      if (!hasReply) throw new Error(`${label} captures[${String(index)}] has no result/error/raw/failure — an empty capture is not replayable`)
      return capture
    }),
    incomplete: Array.isArray(candidate.incomplete) ? (candidate.incomplete as readonly string[]) : [],
  }
  assertNoUnredactedEnableInput(fixture, `load ${label}`)
  return fixture
}

/** Anything with `replies(match, reply)` — `MockTransport` satisfies it; a stub can too. */
export interface ScriptableMock {
  replies(match: string, reply: MockReply): unknown
}

/** What {@link replayRecording} scripted, and what it deliberately did not. */
export interface ReplayOutcome {
  readonly scripted: number
  /** Keys of `failure` captures. No envelope class survives the trace text (`AuthError: …`), so
   * scripting them would fabricate an error the device never returned; the test scripts those
   * explicitly with the class it is testing. */
  readonly deferredFailures: readonly string[]
  /** Every command-list key now in the mock's script, in fixture order. */
  readonly keys: readonly string[]
}

/**
 * The replay path shared by the offline fixtures and the live lane: identity check first
 * ({@link assertRecordingIdentity}), then script each capture onto a `MockTransport`.
 *
 * The envelope is replayed **without** its recorded `id` on purpose: the mock re-ids the answer from
 * the fresh DR-017 policy, which is what keeps
 * `src/transports/base.ts:89` → `assertResponseIdMatches()` from rejecting a good fixture over a
 * cosmetic id.
 */
export function replayRecording(fixture: RecordingFixture, target: ScriptableMock, expected?: ExpectedDevice | undefined): ReplayOutcome {
  if (expected !== undefined) assertRecordingIdentity(fixture, expected)
  const keys: string[] = []
  const deferredFailures: string[] = []
  let scripted = 0
  for (const capture of fixture.captures) {
    const key = recordingMatchKey(capture.commands)
    if (key === '') {
      throw new Error(`recording ${fixture.identity.targetSlug} has a capture with no commands (request ${JSON.stringify(capture.requestId)}) — nothing to match, and an empty script entry would silently swallow every request`)
    }
    keys.push(key)
    if (capture.raw !== undefined) {
      target.replies(key, capture.raw)
      scripted += 1
      continue
    }
    if (capture.error !== undefined) {
      target.replies(key, { error: capture.error })
      scripted += 1
      continue
    }
    if (capture.result !== undefined) {
      target.replies(key, { result: capture.result })
      scripted += 1
      continue
    }
    if (capture.failure !== undefined) deferredFailures.push(key)
  }
  return { scripted, deferredFailures, keys }
}

/**
 * Wrap an existing {@link WireSender} so its round trips land in a recorder — the "wrap any transport"
 * half of PLAN.md:391 for the byte-level seam, and the fallback when a transport was built without a
 * `trace` option (`transports/contract.ts:130`).
 *
 * It mirrors what `src/transports/base.ts:84-95` does for every real transport: the body is redacted
 * **for the sink only**, never for the device, because an `enable` input has to reach the CLI for
 * authentication to work at all (DR-011).
 */
export function recordSender(sender: WireSender, recorder: Recorder, endpoint: string): WireSender {
  return {
    async send(request: JsonRpcRequest): Promise<string> {
      const requestId = String(request.id)
      recorder.sink({ direction: 'request', endpoint, requestId, body: redactWireText(JSON.stringify(request)) })
      try {
        const text = await sender.send(request)
        recorder.sink({ direction: 'response', endpoint, requestId, body: redactWireText(text) })
        return text
      } catch (error) {
        const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        recorder.sink({ direction: 'failure', endpoint, requestId, body: redactWireText(reason) })
        throw error
      }
    },
  }
}
