/**
 * Fixture-driven envelope suite — M1 (#3) exit gate: "encode + decode are pure (no I/O), fully
 * covered, and **fixture-driven**" (docs/PLAN.md M1, and the M1 test bullet "Every envelope sample in
 * `test/fixtures/wire/*.json`").
 *
 * Every `.json` file in `test/fixtures/wire/` is enumerated from disk and driven through the codec by
 * the manifest below; an inventory test fails if a fixture appears without a manifest entry (or the
 * reverse), so the samples can never drift back to being unread.
 *
 * Layer split with `src/internal/wire.test.ts`, kept on purpose:
 *  - `wire.test.ts` = unit-level behaviour from inline envelopes the test builds itself (what the
 *    codec decides for a synthetic input, including shapes no device sample is handy for);
 *  - this file = recorded-sample fidelity (what the codec does to the *saved* samples that docs and
 *    M12 (#14) recordings will be diffed against, exact rendered `[...]` text, which fixture ids and
 *    key sets survive, and the credential probe the fixture README declares).
 *
 * Offline (DR-034): the only sender here is `src/testing/fake-sender.ts`, the only I/O is reading
 * fixture JSON, and nothing opens a socket — M1 owns no transport (M2, #4). The `node:fs`/`node:url`
 * imports are test-only: no module reachable from `src/index.ts` may touch a Node built-in (DR-002).
 */

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  buildRequest,
  COMMAND_OBJECT_KEYS,
  createRequestIds,
  MAX_RAW_BODY,
  parseResponse,
  RUN_CMDS_PARAM_KEYS,
  runRequest,
  sendRequest,
  type BuildRequestOptions,
  type ParsedResponse,
} from './wire'
import { redactWireText } from './redact'
import { CommandError, EapiErrorCode, eapiErrorName, ProtocolError } from '../errors'
import { createFakeSender } from '../testing/fake-sender'
import type { CommandResult, CommandSpec, ErrorDetailEntry, JsonRpcId } from '../types/eapi'

/** The credential token declared in `test/fixtures/wire/README.md` — the only one allowed in a fixture. */
const PROBE = 'pw-from-fixture-probe'

/** The request-id client segment every sample in this directory assumes (DR-017 `<clientId>-<seq>`). */
const CLIENT_ID = 'ui-7f3a2b9c1d'

// From `src/internal/`: up to the package root, then into `test/fixtures/wire`.
const FIXTURE_DIR = fileURLToPath(new URL('../../test/fixtures/wire', import.meta.url))

function readFixture(name: string): string {
  return readFileSync(`${FIXTURE_DIR}/${name}`, 'utf8')
}

/** A fixture as parsed JSON. Fixtures are the *input* here, never the expectation, so `unknown` is fine. */
function fixtureJson(name: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFixture(name))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`fixture ${name} must contain a JSON object`)
  }
  return value as Record<string, unknown>
}

/** Every `.json` file in the directory, sorted — the set the manifest must match exactly. */
function listedFixtures(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((entry) => entry.endsWith('.json'))
    .sort()
}

function expectFailure(parsed: ParsedResponse): Extract<ParsedResponse, { ok: false }> {
  if (parsed.ok) throw new Error('expected a failure, got a success envelope')
  return parsed
}

// --- expectation shapes -----------------------------------------------------------------------

interface SuccessExpectation {
  readonly kind: 'success'
  readonly id: JsonRpcId
  readonly resultLength: number
  /** Exact JSON key set of each per-command object in the recorded reply, in reply order. */
  readonly resultKeys: readonly (readonly string[])[]
  /** Value pins for fields the resource layer (M8, #10) reads off this sample. */
  readonly resultValues?: readonly Record<string, unknown>[]
}

interface FailureExpectation {
  readonly kind: 'failure'
  readonly code: number
  /** `error.message` as the device wrote it, after DR-011 redaction — what the envelope keeps. */
  readonly envelopeMessage: string
  /** `CommandError#message`, i.e. `Error [code]: msg [err]` — what pyeapi prints (MIGRATION.md §5). */
  readonly rendered: string
  readonly commandError: string | undefined
  readonly resultsLength: number
  readonly failedCommand: CommandSpec | undefined
  readonly dataShape: 'absent' | 'array' | 'error-detail'
  readonly errorDetail?: readonly ErrorDetailEntry[]
  /** The `error.data` copy stored on the error, after DR-011 redaction. */
  readonly redactedData?: readonly CommandResult[]
  /** Extra `commands` context for this sample only, to exercise `failedCommand` derivation. */
  readonly commands?: readonly CommandSpec[]
}

interface ProtocolExpectation {
  readonly kind: 'protocol'
  readonly message: string
}

interface UnparseableExpectation {
  readonly kind: 'unparseable'
}

interface RequestExpectation {
  readonly kind: 'request'
  readonly id: JsonRpcId
  readonly commands: readonly CommandSpec[]
  readonly options: BuildRequestOptions
}

type FixtureExpectation =
  | SuccessExpectation
  | FailureExpectation
  | ProtocolExpectation
  | UnparseableExpectation
  | RequestExpectation

// --- the manifest: one entry per recorded sample ----------------------------------------------

const EXPECTATIONS = {
  // --- success envelopes
  'runCmds--success-two-commands.json': {
    kind: 'success',
    id: 'ui-7f3a2b9c1d-1',
    resultLength: 2,
    resultKeys: [
      [],
      ['hostname', 'version', 'systemMacAddress', 'modelName', 'serialNumber', 'internalVersion', 'memTotal', 'bootupTimestamp', 'uptime'],
    ],
    resultValues: [{}, { hostname: 'sw1', version: '4.28.13.1M', modelName: 'DCS-7050TX-64', serialNumber: '0123ABCD56789' }],
  },
  'runCmds--success-empty-result.json': {
    kind: 'success',
    id: 'ui-7f3a2b9c1d-2',
    resultLength: 0,
    resultKeys: [],
  },
  // The `format: "text"` answer a DR-012 retry receives — `output` text, no JSON fields at all.
  'runCmds--text-success-diff.json': {
    kind: 'success',
    id: 'ui-7f3a2b9c1d-4',
    resultLength: 1,
    resultKeys: [['output']],
  },

  // --- device-reported failures: one sample per code (PLAN M1 "one assertion per code 1000-1006")
  'runCmds--error-1000-command-failed.json': {
    kind: 'failure',
    code: EapiErrorCode.COMMAND_FAILED,
    envelopeMessage: "CLI command 2 of 3 'copy running-config startup-config' failed: Failed to write startup-config (no space left on device)",
    rendered: "Error [1000]: CLI command 2 of 3 'copy running-config startup-config' failed: Failed to write startup-config (no space left on device) [errors: ['Failed to write startup-config (no space left on device)']]",
    commandError: "errors: ['Failed to write startup-config (no space left on device)']",
    resultsLength: 2,
    failedCommand: 'copy running-config startup-config',
    dataShape: 'array',
  },
  'runCmds--error-1001-command-exception.json': {
    kind: 'failure',
    code: EapiErrorCode.COMMAND_EXCEPTION,
    envelopeMessage: "CLI command 3 of 4 'show tech-support internals' failed: internal exception while converting command output",
    rendered: "Error [1001]: CLI command 3 of 4 'show tech-support internals' failed: internal exception while converting command output [hostname: 'sw1', version: '4.28.13.1M', errors: ['internal exception while converting command output']]",
    commandError: "hostname: 'sw1', version: '4.28.13.1M', errors: ['internal exception while converting command output']",
    resultsLength: 3,
    failedCommand: 'show tech-support internals',
    dataShape: 'array',
  },
  // pyeapi's `%r` picks double quotes when the value contains an apostrophe — pinned here on a sample.
  'runCmds--error-1002-data-array.json': {
    kind: 'failure',
    code: EapiErrorCode.COMMAND_INVALID,
    envelopeMessage: "CLI command 2 of 3 'vlan 4095' failed: invalid command (did you mean 'vlan 4094'?)",
    rendered: `Error [1002]: CLI command 2 of 3 'vlan 4095' failed: invalid command (did you mean 'vlan 4094'?) [errors: ["invalid command (did you mean 'vlan 4094'?)"]]`,
    commandError: `errors: ["invalid command (did you mean 'vlan 4094'?)"]`,
    resultsLength: 2,
    failedCommand: 'vlan 4095',
    dataShape: 'array',
  },
  // the `includeErrorDetail: true` shape pyeapi cannot parse (DR-010)
  'runCmds--error-1002-error-detail.json': {
    kind: 'failure',
    code: EapiErrorCode.COMMAND_INVALID,
    envelopeMessage: "CLI command 3 of 4 'vlan 4095' failed: invalid command",
    rendered: "Error [1002]: CLI command 3 of 4 'vlan 4095' failed: invalid command [index: 2, code: 1002, message: 'invalid command', cmd: 'vlan 4095']",
    commandError: "index: 2, code: 1002, message: 'invalid command', cmd: 'vlan 4095'",
    resultsLength: 3,
    failedCommand: 'vlan 4095',
    dataShape: 'error-detail',
    errorDetail: [{ index: 2, code: 1002, message: 'invalid command', cmd: 'vlan 4095' }],
  },
  'runCmds--error-1003-unconverted.json': {
    kind: 'failure',
    code: EapiErrorCode.COMMAND_UNCONVERTED,
    envelopeMessage: "CLI command 1 of 1 'show session-config diffs' failed: Command did not produce a JSON convertible output (no cliModel for this command)",
    rendered: "Error [1003]: CLI command 1 of 1 'show session-config diffs' failed: Command did not produce a JSON convertible output (no cliModel for this command)",
    commandError: undefined,
    resultsLength: 0,
    failedCommand: 'show session-config diffs',
    dataShape: 'absent',
  },
  'runCmds--error-1004-incompatible.json': {
    kind: 'failure',
    code: EapiErrorCode.COMMAND_INCOMPATIBLE,
    envelopeMessage: "CLI command 2 of 3 'reload' failed: command is incompatible with the eAPI context",
    rendered: "Error [1004]: CLI command 2 of 3 'reload' failed: command is incompatible with the eAPI context [errors: ['command is incompatible with the eAPI context']]",
    commandError: "errors: ['command is incompatible with the eAPI context']",
    resultsLength: 2,
    failedCommand: 'reload',
    dataShape: 'array',
  },
  'runCmds--error-1005-unauthorized.json': {
    kind: 'failure',
    code: EapiErrorCode.COMMAND_UNAUTHORIZED,
    envelopeMessage: "CLI command 1 of 3 'enable' failed: Command unauthorized: user has insufficient permissions to run the command",
    rendered: "Error [1005]: CLI command 1 of 3 'enable' failed: Command unauthorized: user has insufficient permissions to run the command",
    commandError: undefined,
    resultsLength: 0,
    failedCommand: 'enable',
    dataShape: 'absent',
  },
  // DR-011 probe sample: the enable password is echoed in `message` **and** in `error.data`.
  'runCmds--error-1005-enable-input.json': {
    kind: 'failure',
    code: EapiErrorCode.COMMAND_UNAUTHORIZED,
    envelopeMessage: "CLI command 1 of 3 'enable' failed: Command unauthorized: user has insufficient permissions to run the command input=<redacted>",
    rendered: "Error [1005]: CLI command 1 of 3 'enable' failed: Command unauthorized: user has insufficient permissions to run the command input=<redacted>",
    commandError: "errors: ['Command unauthorized'], cmd: 'enable', input: '<redacted>', errors: ['invalid input']",
    resultsLength: 2,
    failedCommand: { cmd: 'enable', input: '<redacted>' },
    dataShape: 'array',
    redactedData: [
      { errors: ['Command unauthorized'], cmd: 'enable', input: '<redacted>' },
      { errors: ['invalid input'] },
    ],
    commands: [{ cmd: 'enable', input: PROBE }, 'show version', 'show interfaces status'],
  },
  'runCmds--error-1006-config-locked.json': {
    kind: 'failure',
    code: EapiErrorCode.COMMAND_CONFIG_LOCKED,
    envelopeMessage: "CLI command 2 of 4 'configure session maintenance-2026-11-01' failed: The configuration is locked by session arista-ui-sw1-9f2c1a7b",
    // 1006 is not in pyeapi's bracketed set, so the rendered text carries no `[...]` even though
    // `error.data` exists — it stays available on `.commandError` for the UI to show deliberately.
    rendered: "Error [1006]: CLI command 2 of 4 'configure session maintenance-2026-11-01' failed: The configuration is locked by session arista-ui-sw1-9f2c1a7b",
    commandError: "errors: ['The configuration is locked by session arista-ui-sw1-9f2c1a7b']",
    resultsLength: 2,
    failedCommand: 'configure session maintenance-2026-11-01',
    dataShape: 'array',
  },
  'runCmds--error-32700-parse-error.json': {
    kind: 'failure',
    code: EapiErrorCode.PARSE_ERROR,
    envelopeMessage: 'parse error: Expecting property name enclosed in double quotes: line 1 column 42 (char 41)',
    rendered: 'Error [-32700]: parse error: Expecting property name enclosed in double quotes: line 1 column 42 (char 41)',
    commandError: undefined,
    resultsLength: 0,
    failedCommand: undefined,
    dataShape: 'absent',
  },
  'runCmds--error-32600-invalid-request.json': {
    kind: 'failure',
    code: EapiErrorCode.INVALID_REQUEST,
    envelopeMessage: 'invalid request: jsonrpc must be 2.0',
    rendered: 'Error [-32600]: invalid request: jsonrpc must be 2.0',
    commandError: undefined,
    resultsLength: 0,
    failedCommand: undefined,
    dataShape: 'absent',
  },
  'runCmds--error-32601-method-not-found.json': {
    kind: 'failure',
    code: EapiErrorCode.METHOD_NOT_FOUND,
    envelopeMessage: 'method not found: runCmd',
    rendered: 'Error [-32601]: method not found: runCmd',
    commandError: undefined,
    resultsLength: 0,
    failedCommand: undefined,
    dataShape: 'absent',
  },
  'runCmds--error-32602-unexpected-keyword.json': {
    kind: 'failure',
    code: EapiErrorCode.INVALID_PARAMS,
    envelopeMessage: "runCmds() got an unexpected keyword argument 'streaming'",
    rendered: "Error [-32602]: runCmds() got an unexpected keyword argument 'streaming'. streaming parameter is not supported in this version of EOS.",
    commandError: undefined,
    resultsLength: 0,
    failedCommand: undefined,
    dataShape: 'absent',
  },
  'runCmds--error-32603-internal-error.json': {
    kind: 'failure',
    code: EapiErrorCode.INTERNAL_ERROR,
    envelopeMessage: 'internal error: CLI process unavailable',
    rendered: 'Error [-32603]: internal error: CLI process unavailable',
    commandError: undefined,
    resultsLength: 0,
    failedCommand: undefined,
    dataShape: 'absent',
  },

  // --- the two degenerate `error.data` cases PLAN M1 names: empty array, and omitted entirely
  'runCmds--error-no-data.json': {
    kind: 'failure',
    code: EapiErrorCode.COMMAND_INVALID,
    envelopeMessage: "CLI command 1 of 2 'vlan forty' failed: invalid command",
    // pyeapi prints the literal `None` here; we drop the brackets instead (MIGRATION.md §5 row 19).
    rendered: "Error [1002]: CLI command 1 of 2 'vlan forty' failed: invalid command",
    commandError: undefined,
    resultsLength: 0,
    failedCommand: 'vlan forty',
    dataShape: 'absent',
  },
  'runCmds--error-empty-data-array.json': {
    kind: 'failure',
    code: EapiErrorCode.COMMAND_INVALID,
    envelopeMessage: "CLI command 1 of 1 'show bogus' failed: invalid command",
    rendered: "Error [1002]: CLI command 1 of 1 'show bogus' failed: invalid command []",
    commandError: '',
    resultsLength: 0,
    failedCommand: 'show bogus',
    dataShape: 'array',
  },

  // --- bodies the codec cannot use at all
  'runCmds--malformed-unclosed-brace.json': { kind: 'unparseable' },
  'invalid--result-and-error.json': {
    kind: 'protocol',
    message: 'eAPI response must carry exactly one of result/error (got result=true, error=true)',
  },
  'invalid--no-result-or-error.json': {
    kind: 'protocol',
    message: 'eAPI response must carry exactly one of result/error (got result=false, error=false)',
  },
  'invalid--result-not-array.json': {
    kind: 'protocol',
    message: 'eAPI result must be an array of per-command objects',
  },
  'invalid--error-without-code.json': {
    kind: 'protocol',
    message: 'eAPI error envelope is missing a numeric code',
  },
  'invalid--jsonrpc-1.0.json': {
    kind: 'protocol',
    message: "unsupported jsonrpc version '1.0'",
  },

  // --- encoder samples: exactly what `buildRequest` must produce (DR-016 allow-list + DR-017 ids).
  //     Declaration order is the send order on one connection, which is what pins the id sequence.
  'request--two-commands.json': {
    kind: 'request',
    id: 'ui-7f3a2b9c1d-1',
    commands: ['enable', 'show version'],
    options: {},
  },
  'request--all-supported-params.json': {
    kind: 'request',
    id: 'ui-7f3a2b9c1d-2',
    commands: [{ cmd: 'banner motd', input: 'line one\nline two\nEOF\n', revision: 2 }, 'show version'],
    options: {
      version: 'latest',
      format: 'text',
      autoComplete: true,
      expandAliases: true,
      timestamps: true,
      stopOnError: false,
      includeErrorDetail: true,
      requestTimeout: 120,
    },
  },
} satisfies Record<string, FixtureExpectation>

type FixtureName = keyof typeof EXPECTATIONS
type FailureFixture = Extract<ParsedResponse, { ok: false }>

function group<Kinds extends FixtureExpectation['kind'], Out extends FixtureExpectation>(kind: Kinds): [FixtureName, Out][] {
  return Object.entries(EXPECTATIONS as Record<string, FixtureExpectation>).filter(
    (entry): entry is [FixtureName, Out] => entry[1].kind === kind,
  )
}

// --- inventory guard: a fixture cannot exist without a driver ----------------------------------

describe('fixture inventory — all 27 samples are driven', () => {
  it('the manifest covers exactly the files on disk, and nothing else', () => {
    expect(Object.keys(EXPECTATIONS).sort()).toEqual(listedFixtures())
    expect(listedFixtures()).toHaveLength(27)
  })

  it('file names follow the `<method>--<scenario>.json` convention (TESTING.md §4)', () => {
    for (const name of listedFixtures()) {
      expect(name).toMatch(/^(?:runCmds|invalid|request)--[a-z0-9.-]+\.json$/)
    }
  })

  it('every manifest kind has a generator in this file, so a new kind cannot go undriven', () => {
    const driven = [...group('success'), ...group('failure'), ...group('protocol'), ...group('unparseable'), ...group('request')]
      .map(([name]) => name)
      .sort()
    expect(driven).toEqual(listedFixtures())
    expect(group<'failure', FailureExpectation>('failure')).toHaveLength(16)
    expect(group<'success', SuccessExpectation>('success')).toHaveLength(3)
    expect(group<'protocol', ProtocolExpectation>('protocol')).toHaveLength(5)
    expect(group<'unparseable', UnparseableExpectation>('unparseable')).toHaveLength(1)
    expect(group<'request', RequestExpectation>('request')).toHaveLength(2)
  })

  it('the samples share one request-id client segment, matching the DR-017 id policy', () => {
    // `runCmds--malformed-unclosed-brace.json` is not parseable, so it has no readable id.
    const parseable = listedFixtures().filter((name) => !name.startsWith('runCmds--malformed'))
    const responseIds = parseable.filter((name) => !name.startsWith('request--')).map((name) => String(fixtureJson(name)['id']))
    const requestIds = group<'request', RequestExpectation>('request').map(([, expected]) => String(expected.id))
    expect(responseIds).toHaveLength(24)
    expect(requestIds).toHaveLength(2)
    for (const id of [...responseIds, ...requestIds]) expect(id).toMatch(new RegExp(`^${CLIENT_ID}-\\d+$`))
    // Reply ids are unique, so an operator's log line points at exactly one exchange (DR-017).
    expect(new Set(responseIds).size).toBe(responseIds.length)
  })
})

// --- decoding: success envelopes ---------------------------------------------------------------

describe('success fixtures — decode to results, never throw', () => {
  for (const [name, expected] of group<'success', SuccessExpectation>('success')) {
    it(`${name}: result[] of ${expected.resultLength} per-command object(s)`, () => {
      const parsed = parseResponse(readFixture(name))
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) throw new Error('unreachable: asserted above')
      const recorded = fixtureJson(name)
      expect(parsed.envelope.jsonrpc).toBe('2.0')
      expect(parsed.envelope.id).toBe(expected.id)
      expect(recorded['id']).toBe(expected.id)
      expect(parsed.envelope.result).toHaveLength(expected.resultLength)
      expect(parsed.envelope.result).toEqual(recorded['result'])
      for (const [index, keys] of expected.resultKeys.entries()) {
        expect(Object.keys(parsed.envelope.result[index] ?? {}).sort()).toEqual([...keys].sort())
      }
      if (expected.resultValues !== undefined) expect(parsed.envelope.result).toMatchObject(expected.resultValues)
      // No pyeapi `response` key is invented on the way through the codec (DR-007).
      expect(JSON.stringify(parsed.envelope)).not.toContain('"response"')
    })
  }

  it('runCmds--success-two-commands.json pins the target device identity (7050TX-64 / 4.28.13.1M)', () => {
    const parsed = parseResponse(readFixture('runCmds--success-two-commands.json'))
    if (!parsed.ok) throw new Error('unreachable')
    const reply = parsed.envelope.result[1] as CommandResult
    expect(reply['version']).toBe('4.28.13.1M')
    expect(reply['modelName']).toBe('DCS-7050TX-64')
    expect(reply['internalVersion']).toBe('4.28.13.1M-43620574.428131M')
  })

  it('runCmds--text-success-diff.json carries text only — the shape a DR-012 retry produces', () => {
    const parsed = parseResponse(readFixture('runCmds--text-success-diff.json'))
    if (!parsed.ok) throw new Error('unreachable')
    const [first] = parsed.envelope.result
    expect(Object.keys(first ?? {})).toEqual(['output'])
    expect(String(first?.['output'])).toContain('+vlan 4000')
    expect(String(first?.['output'])).toContain('+   name probe-vlan')
  })
})

// --- decoding: device-reported failures --------------------------------------------------------

describe('failure fixtures — class + .code + rendered message, one test per sample', () => {
  for (const [name, expected] of group<'failure', FailureExpectation>('failure')) {
    it(`${name}: CommandError ${expected.code} (${eapiErrorName(expected.code)})`, () => {
      const context = expected.commands === undefined ? {} : { commands: expected.commands }
      // A device error must not throw out of the codec: the caller decides (PLAN M1).
      const parsed = expectFailure(parseResponse(readFixture(name), context))
      const error = parsed.error
      expect(error).toBeInstanceOf(CommandError)
      expect(error.name).toBe('CommandError')
      if (!(error instanceof CommandError)) throw new Error('unreachable: asserted above')

      expect(error.code).toBe(expected.code)
      expect(error.message).toBe(expected.rendered)
      expect(error.commandError).toBe(expected.commandError)
      expect(error.results).toHaveLength(expected.resultsLength)
      expect(error.failedCommand).toEqual(expected.failedCommand)
      expect(error.requestId).toBe(fixtureJson(name)['id'])
      if (expected.redactedData !== undefined) expect(error.results).toEqual(expected.redactedData)

      // The returned envelope keeps the device's own text — redacted, but *not* decorated with the
      // -32602 explanation, which belongs to the error message only.
      const envelope: FailureFixture['envelope'] = parsed.envelope
      if (envelope === undefined) throw new Error(`expected a failure envelope for ${name}`)
      expect(envelope.jsonrpc).toBe('2.0')
      expect(envelope.error.code).toBe(expected.code)
      expect(envelope.error.message).toBe(expected.envelopeMessage)

      switch (expected.dataShape) {
        case 'absent':
          expect(envelope.error.data).toBeUndefined()
          expect(error.errorDetail).toBeUndefined()
          break
        case 'array':
          expect(Array.isArray(envelope.error.data)).toBe(true)
          expect(error.errorDetail).toBeUndefined()
          break
        case 'error-detail':
          expect(Object.keys(envelope.error.data as Record<string, unknown>).sort()).toEqual(['errorDetail', 'result'])
          expect(error.errorDetail).toEqual(expected.errorDetail)
          break
      }

      // Structured form for the webui error panel: the code is machine-readable, the name derived.
      expect(JSON.parse(JSON.stringify(error))).toMatchObject({
        name: 'CommandError',
        code: expected.code,
        codeName: eapiErrorName(expected.code),
        message: expected.rendered,
        requestId: fixtureJson(name)['id'],
      })
    })
  }
})

describe('`failedCommand` derivation on two of the samples', () => {
  it('runCmds--error-1006: the `errors` marker index and the `CLI command N of M` text agree', () => {
    const name = 'runCmds--error-1006-config-locked.json'
    const bare = parseResponse(readFixture(name))
    const withCommands = parseResponse(readFixture(name), {
      commands: ['enable', 'configure session maintenance-2026-11-01', 'vlan 4000', 'name probe-vlan'],
    })
    const bareError = bare.ok ? undefined : bare.error
    const indexedError = withCommands.ok ? undefined : withCommands.error
    expect(bareError).toBeInstanceOf(CommandError)
    expect(indexedError).toBeInstanceOf(CommandError)
    if (!(bareError instanceof CommandError) || !(indexedError instanceof CommandError)) {
      throw new Error('unreachable: asserted above')
    }
    // `deriveFailedCommand` prefers the `errorDetail`/`errors`-marker index and only then falls back
    // to the message prefix; on this sample both paths land on the same command, so the recorded
    // message and position in the command list must not disagree.
    expect(indexedError.failedCommand).toBe(bareError.failedCommand)
    expect(indexedError.commands).toEqual([
      'enable',
      'configure session maintenance-2026-11-01',
      'vlan 4000',
      'name probe-vlan',
    ])
  })

  it('runCmds--error-1002-error-detail: trace() pairs device output with every sent command', () => {
    const name = 'runCmds--error-1002-error-detail.json'
    const commands: readonly CommandSpec[] = ['enable', 'configure', 'vlan 4095', 'name probe']
    const parsed = expectFailure(parseResponse(readFixture(name), { commands }))
    const error = parsed.error as CommandError
    // MIGRATION.md §5 row 20: pyeapi's `if index:` guard drops the tail; ours keeps command 4.
    expect(error.trace()).toEqual([
      { command: 'enable', output: {} },
      { command: 'configure', output: { name: 'probe' } },
      { command: 'vlan 4095', output: { errors: ['invalid command'] } },
      { command: 'name probe', output: undefined },
    ])
  })
})

// --- decoding: unusable bodies -----------------------------------------------------------------

describe('invalid--* and malformed fixtures — ProtocolError carries the raw body', () => {
  for (const [name, expected] of group<'protocol', ProtocolExpectation>('protocol')) {
    it(`${name}: ProtocolError ${EapiErrorCode.INVALID_REQUEST} with the body attached`, () => {
      const text = readFixture(name)
      const parsed = expectFailure(parseResponse(text, { commands: ['show version'] }))
      const error = parsed.error
      expect(error).toBeInstanceOf(ProtocolError)
      expect(error instanceof CommandError).toBe(false)
      expect(error.name).toBe('ProtocolError')
      expect((error as ProtocolError).code).toBe(EapiErrorCode.INVALID_REQUEST)
      expect(error.message).toContain(expected.message)
      expect((error as ProtocolError).rawBody).toBe(text)
      expect((error as ProtocolError).rawBody).not.toHaveLength(0)
      expect(error.message).not.toContain(PROBE)
      // The codec could validate the shape, so it can still return the failure — it does not throw.
      expect(parsed.envelope).toBeUndefined()
      // Asserted known M1 limit, so it cannot slip silently: the id in these bodies is not lifted
      // onto the error. M2 (#4) owns request/response id correlation.
      expect(error.requestId).toBeUndefined()
    })
  }

  it('runCmds--malformed-unclosed-brace.json: unparseable body → ProtocolError -32700, raw text kept', () => {
    const text = readFixture('runCmds--malformed-unclosed-brace.json')
    const parsed = expectFailure(parseResponse(text, { commands: ['show version'] }))
    const error = parsed.error
    expect(error).toBeInstanceOf(ProtocolError)
    if (!(error instanceof ProtocolError)) throw new Error('unreachable: asserted above')
    expect(error.code).toBe(EapiErrorCode.PARSE_ERROR)
    expect(error.message).toBe('eAPI response is not valid JSON')
    expect(error.rawBody).toBe(text)
    expect(error.rawBody ?? '').toHaveLength(text.length)
    expect(text.length).toBeLessThan(MAX_RAW_BODY)
    expect(parsed.envelope).toBeUndefined()
    // A truncated body keeps the limit and says how much was dropped (the inline suite pins the math).
    expect(error.rawBody).not.toContain('… [truncated')
  })

  it('a body larger than MAX_RAW_BODY is truncated by the codec, fixture plus padding', () => {
    const text = readFixture('runCmds--malformed-unclosed-brace.json')
    const padded = `${text} ${'x'.repeat(MAX_RAW_BODY)}`
    const parsed = expectFailure(parseResponse(padded))
    const error = parsed.error as ProtocolError
    expect(error.rawBody).toBe(
      `${padded.slice(0, MAX_RAW_BODY)}… [truncated ${padded.length - MAX_RAW_BODY} chars]`,
    )
  })
})

// --- encoding: request fixtures pin buildRequest ----------------------------------------------

describe('request fixtures — buildRequest output is pinned sample-for-sample', () => {
  const requestFixtures = group<'request', RequestExpectation>('request')

  it('one id policy produces the recorded id sequence', () => {
    const ids = createRequestIds({ nonce: 'ui', seed: '7f3a2b9c1d' })
    for (const [name, expected] of requestFixtures) {
      const request = buildRequest(expected.commands, { ...expected.options, ids })
      expect(request.id).toBe(expected.id)
      expect(request.id).toMatch(new RegExp(`^${CLIENT_ID}-\\d+$`))
      // The recorded sample is the whole expected envelope, keys included.
      expect(request).toEqual(fixtureJson(name))
      expect(Object.keys(request).sort()).toEqual(['id', 'jsonrpc', 'method', 'params'])
      expect(request.jsonrpc).toBe('2.0')
      expect(request.method).toBe('runCmds')
    }
    expect(ids.next()).toBe(`${CLIENT_ID}-3`)
  })

  for (const [name, expected] of requestFixtures) {
    it(`${name}: buildRequest reproduces the recorded envelope`, () => {
      // Id pinned explicitly, so this test is about the envelope *shape*; the id policy itself is the
      // test above.
      const request = buildRequest(expected.commands, { ...expected.options, id: expected.id })
      expect(request).toEqual(fixtureJson(name))
      expect(JSON.parse(JSON.stringify(request))).toEqual(fixtureJson(name))
      expect(request.params.cmds).toEqual(expected.commands)
      expect(JSON.stringify(request)).not.toContain('streaming')
    })
  }

  it('params stay inside the DR-016 allow-list and command objects inside the three server keys', () => {
    for (const [name, expected] of requestFixtures) {
      const recorded = fixtureJson(name)
      const params = recorded['params'] as Record<string, unknown>
      for (const key of Object.keys(params)) {
        expect(RUN_CMDS_PARAM_KEYS).toContain(key)
      }
      for (const command of params['cmds'] as readonly unknown[]) {
        if (typeof command === 'object' && command !== null) {
          for (const key of Object.keys(command)) expect(COMMAND_OBJECT_KEYS).toContain(key)
        }
      }
      expect(JSON.stringify(recorded)).not.toContain('streaming')
      // DR-015: a multiline `input` survives the encoder untouched, newlines and EOF sentinel.
      if (name === 'request--all-supported-params.json') {
        expect(expected.commands[0]).toEqual({ cmd: 'banner motd', input: 'line one\nline two\nEOF\n', revision: 2 })
      }
    }
  })
})

// --- the two codec behaviours that need a sender: DR-012 retry and the run seam ----------------

describe('DR-012 fallback driven by fixture pairs', () => {
  it('runCmds--error-1003-unconverted.json + runCmds--text-success-diff.json retry once at format:"text"', async () => {
    const ids = createRequestIds({ nonce: 'ui', seed: '7f3a2b9c1d' })
    const fake = createFakeSender([
      readFixture('runCmds--error-1003-unconverted.json'),
      readFixture('runCmds--text-success-diff.json'),
    ])
    const outcome = await sendRequest(fake.sender, ['show session-config diffs'], { ids })
    expect(fake.requests).toHaveLength(2)
    expect(fake.requests.map((request) => request.params.format)).toEqual(['json', 'text'])
    expect(fake.requests.map((request) => request.id)).toEqual([`${CLIENT_ID}-1`, `${CLIENT_ID}-2`])
    expect(fake.requests[1]?.params.cmds).toEqual(['show session-config diffs'])
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable: asserted above')
    expect(outcome.viaTextRetry).toBe(true)
    expect(outcome.encoding).toBe('text')
    expect(outcome.result[0]).toEqual({ output: expect.stringContaining('+vlan 4000') })
  })

  it('tolerateErrors:false keeps the 1003 sample as the answer and sends nothing else', async () => {
    const fake = createFakeSender([readFixture('runCmds--error-1003-unconverted.json')])
    const outcome = await sendRequest(fake.sender, ['show session-config diffs'], { tolerateErrors: false })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable: asserted above')
    expect(outcome.error).toBeInstanceOf(CommandError)
    expect((outcome.error as CommandError).code).toBe(EapiErrorCode.COMMAND_UNCONVERTED)
    expect(outcome.error.message).toContain('no cliModel for this command')
    expect(fake.requests).toHaveLength(1)
  })

  it('no other fixture triggers a retry — 1004/1006/1002 fail as sent', async () => {
    for (const name of ['runCmds--error-1004-incompatible.json', 'runCmds--error-1006-config-locked.json', 'runCmds--error-1002-data-array.json']) {
      const fake = createFakeSender([readFixture(name)])
      const outcome = await sendRequest(fake.sender, ['show version'])
      expect(outcome.ok).toBe(false)
      expect(fake.requests).toHaveLength(1)
    }
  })

  it('runRequest throws the CommandError the runCmds--error-1006 sample describes', async () => {
    const fake = createFakeSender([readFixture('runCmds--error-1006-config-locked.json')])
    const error = await runRequest(fake.sender, ['enable', 'configure session maintenance-2026-11-01']).catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(CommandError)
    const commandError = error as CommandError
    expect(commandError.code).toBe(EapiErrorCode.COMMAND_CONFIG_LOCKED)
    expect(commandError.failedCommand).toBe('configure session maintenance-2026-11-01')
    expect(commandError.requestId).toBe(`${CLIENT_ID}-13`)
  })

  it('runRequest returns the results from runCmds--success-two-commands.json', async () => {
    const fake = createFakeSender([readFixture('runCmds--success-two-commands.json')])
    const results = await runRequest(fake.sender, ['enable', 'show version'], { id: 'ui-7f3a2b9c1d-1' })
    expect(results).toHaveLength(2)
    expect((results[1] as CommandResult)['hostname']).toBe('sw1')
  })
})

// --- the credential probe the fixture README declares ------------------------------------------

/** Mirrors `redact.ts`'s rules: `input` is a secret only when the sibling `cmd` is `enable`. */
const ENABLE_COMMAND = /^enable(?:\s|$)/i
const CREDENTIAL_KEY = /^(?:secret|password|passphrase|passwd)$/i
/** Device-text forms that leak a secret: `input=%r` and `username … secret|password <value>`. */
const TEXT_SECRET =
  /(?:\binput\s*=\s*|\busername[^\n]*?\b(?:secret|password)(?:[^\S\n]+(?:plain|sha512|md5|text|both|encrypted|[057]))?[^\S\n]+)(?:'([^']*)'|"([^"]*)"|([^\s,;)'"\]{}]+))/gi

interface CredentialSite {
  readonly where: string
  readonly secret: string
}

function structuredSites(value: unknown, key: string, parent: Record<string, unknown> | null, name: string, out: CredentialSite[]): CredentialSite[] {
  if (typeof value === 'string') {
    if (CREDENTIAL_KEY.test(key)) out.push({ where: `${name}#${key}`, secret: value })
    else if (key === 'input' && parent !== null && typeof parent['cmd'] === 'string' && ENABLE_COMMAND.test(parent['cmd'])) {
      out.push({ where: `${name}#enable-input`, secret: value })
    }
    return out
  }
  if (Array.isArray(value)) {
    for (const entry of value) structuredSites(entry, key, parent, name, out)
    return out
  }
  if (value !== null && typeof value === 'object') {
    for (const [childKey, entry] of Object.entries(value as Record<string, unknown>)) {
      structuredSites(entry, childKey, value as Record<string, unknown>, name, out)
    }
  }
  return out
}

function allCredentialSites(): CredentialSite[] {
  const sites: CredentialSite[] = []
  for (const name of listedFixtures()) {
    // The unparseable sample is scanned as text only — there is no object to walk.
    if (!name.startsWith('runCmds--malformed')) structuredSites(fixtureJson(name), '', null, name, sites)
    for (const match of readFixture(name).matchAll(TEXT_SECRET)) {
      sites.push({ where: `${name}:text`, secret: (match[1] ?? match[2] ?? match[3] ?? '').trim() })
    }
  }
  return sites
}

describe('DR-011 credential probe — the invariant test/fixtures/wire/README.md declares', () => {
  it('`pw-from-fixture-probe` lives in exactly one fixture, twice', () => {
    const withProbe = listedFixtures().filter((name) => readFixture(name).includes(PROBE))
    expect(withProbe).toEqual(['runCmds--error-1005-enable-input.json'])
    expect((readFixture(withProbe[0] ?? '').match(new RegExp(PROBE, 'g')) ?? []).length).toBe(2)
  })

  it('every credential-shaped value in every fixture is the probe token — no real password is committed', () => {
    const sites = allCredentialSites()
    expect(sites.length).toBeGreaterThan(0)
    for (const site of sites) expect(site.secret, site.where).toBe(PROBE)
  })

  it('a non-enable `input` (the multiline banner in request--all-supported-params) is not a secret', () => {
    const inputs: { where: string; cmd: string; input: string }[] = []
    for (const name of listedFixtures()) {
      const text = readFixture(name)
      for (const match of text.matchAll(/"cmd":\s*"([^"]*)",\s*"input":\s*"([^"]*)"/g)) {
        inputs.push({ where: name, cmd: match[1] ?? '', input: match[2] ?? '' })
      }
      for (const match of text.matchAll(/"input":\s*"([^"]*)",\s*"cmd":\s*"([^"]*)"/g)) {
        inputs.push({ where: name, cmd: match[2] ?? '', input: match[1] ?? '' })
      }
    }
    expect(inputs.map((entry) => `${entry.where}:${entry.cmd}`).sort()).toEqual([
      'request--all-supported-params.json:banner motd',
      'runCmds--error-1005-enable-input.json:enable',
    ])
    const banner = inputs.find((entry) => entry.cmd === 'banner motd')
    expect(banner?.input).toBe('line one\\nline two\\nEOF\\n')
    const enable = inputs.find((entry) => entry.cmd === 'enable')
    expect(enable?.input.replaceAll('\\', '')).toBe(PROBE)
  })

  it('no fixture body is log-safe-secret-free until redactWireText sees it', () => {
    const body = readFixture('runCmds--error-1005-enable-input.json')
    expect(body).toContain(PROBE)
    expect(redactWireText(body)).not.toContain(PROBE)
    expect(redactWireText(body)).toContain('<redacted>')
  })

  it('decoding any fixture cannot emit the probe into an error or envelope', () => {
    const commands: readonly CommandSpec[] = [{ cmd: 'enable', input: PROBE }, 'show version']
    for (const name of listedFixtures()) {
      const parsed = parseResponse(readFixture(name), { commands })
      const surfaces: string[] = parsed.ok
        ? [JSON.stringify(parsed.envelope)]
        : [
            parsed.error.message,
            String(parsed.error),
            JSON.stringify(parsed.error),
            parsed.error.stack ?? '',
            parsed.envelope === undefined ? '' : JSON.stringify(parsed.envelope),
          ]
      const joined = surfaces.join('\n')
      expect(joined, name).not.toContain(PROBE)
      if (!parsed.ok && parsed.error instanceof CommandError) {
        expect(JSON.stringify(parsed.error.failedCommand ?? ''), name).not.toContain(PROBE)
      }
    }
  })

  it('the 1005 probe sample leaks nothing through the send seam, and the password still reaches the device', async () => {
    const commands: readonly CommandSpec[] = [{ cmd: 'enable', input: PROBE }, 'show version', 'show interfaces status']
    const fake = createFakeSender([readFixture('runCmds--error-1005-enable-input.json')])
    const outcome = await sendRequest(fake.sender, commands, { id: `${CLIENT_ID}-12` })
    expect(outcome.ok).toBe(false)
    // Redaction is for errors and logs, not for the request: the device needs the real password.
    expect(JSON.stringify(fake.requests)).toContain(PROBE)
    expect(redactWireText(JSON.stringify(fake.requests[0]))).not.toContain(PROBE)
    if (outcome.ok) throw new Error('unreachable: asserted above')
    const error = outcome.error as CommandError
    expect(error.code).toBe(EapiErrorCode.COMMAND_UNAUTHORIZED)
    expect(error.commands).toEqual([{ cmd: 'enable', input: '<redacted>' }, 'show version', 'show interfaces status'])
    expect(error.commandError).toContain("input: '<redacted>'")
    expect(`${error.message}\n${error.stack ?? ''}\n${JSON.stringify(error)}\n${String(error)}`).not.toContain(PROBE)
  })

  it('every fixture, sent through the fake as if it were a device reply, either decodes or fails typed', async () => {
    for (const name of listedFixtures()) {
      if (name.startsWith('request--')) continue
      const fake = createFakeSender([readFixture(name)])
      const outcome = await sendRequest(fake.sender, ['show version'], { tolerateErrors: false })
      expect(outcome.ok).toBe(name.startsWith('runCmds--success') || name === 'runCmds--text-success-diff.json')
      if (outcome.ok) {
        expect(Array.isArray(outcome.result)).toBe(true)
      } else {
        expect(outcome.error instanceof CommandError || outcome.error instanceof ProtocolError).toBe(true)
      }
    }
  })
})
