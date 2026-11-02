/**
 * Wire-codec suite — M1 (#3). Port of the **codec half** of pyeapi `test/unit/test_eapilib.py`
 * (BSD-3-Clause, Arista Networks): 12 of its 38 methods are request/response/error behaviour and are
 * ported here by behaviour, not by copy (DR-003) — each is tagged `[pyeapi <name>]` below. The
 * other 26 are the `http.client`/TLS/cookie transport half and land with M2 (#4).
 *
 * Every test here is offline: the only sender is the M1 `WireSender` fake (`src/testing/fake-sender.ts`),
 * nothing opens a socket (DR-034).
 */

import { describe, expect, it } from 'vitest'
import { expectTypeOf } from 'vitest'

import {
  buildRequest,
  COMMAND_OBJECT_KEYS,
  createRequestIds,
  decorateUnsupportedParam,
  formatErrorDataEntries,
  isUnconvertedCommandFailure,
  MAX_RAW_BODY,
  parseErrorEnvelope,
  parseResponse,
  pythonRepr,
  RUN_CMDS_PARAM_KEYS,
  runRequest,
  sendRequest,
  unwrapResponse,
} from './wire'
import { CommandError, EapiErrorCode, NotSupportedError, ProtocolError } from '../errors'
import { createFakeSender } from '../testing/fake-sender'
import type { CommandSpec, JsonRpcRequest, WireSender } from '../types/eapi'
// `BuildRequestOptions` is `buildRequest`'s own option bag (envelope extras like `id`/`ids` live
// here too), so it is exported from `./wire`, not from the declaration-only `../types/eapi`.
import type { BuildRequestOptions } from './wire'

/** The credential token declared in `test/fixtures/wire/README.md`. Nothing else may look like a password. */
const PROBE_PASSWORD = 'pw-from-fixture-probe'

function envelope(result: readonly unknown[], id = 'ui-7f3a2b9c1d-1'): string {
  return JSON.stringify({ jsonrpc: '2.0', result, id })
}

function failureBody(error: Record<string, unknown>, id = 'ui-7f3a2b9c1d-1'): string {
  return JSON.stringify({ jsonrpc: '2.0', error, id })
}

/** Decode a body that must produce a failure, and hand back the error object. */
function failureOf(text: string, commands?: readonly CommandSpec[]): CommandError | ProtocolError {
  const parsed = parseResponse(text, commands === undefined ? {} : { commands })
  if (parsed.ok) throw new Error(`expected a failure, got a success envelope: ${text}`)
  return parsed.error
}

/**
 * Type identity, not assignability: true only when `A` and `B` are the *same* type in both
 * directions. Used where vitest's branded `toEqualTypeOf` falls down (readonly arrays) or where a
 * looser match would let a contract slip.
 */
type Exactly<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

describe('buildRequest — the runCmds parameter allow-list (DR-016)', () => {
  it('passes cmds through untouched, in order, objects included [pyeapi test_execute_valid_response shape]', () => {
    const request = buildRequest(['enable', { cmd: 'banner motd', input: 'hi\nEOF\n' }], { id: 'fix-1' })
    expect(request.params.cmds).toEqual(['enable', { cmd: 'banner motd', input: 'hi\nEOF\n' }])
    expect(request.method).toBe('runCmds')
    expect(request.jsonrpc).toBe('2.0')
  })

  it('coerces a single string command to an array (pyeapi make_iterable → explicit toArray, DR-041)', () => {
    expect(buildRequest('show version', { id: 'fix-1' }).params.cmds).toEqual(['show version'])
  })

  it('keeps autoComplete on the allow-list [pyeapi test_request_adds_autocomplete]', () => {
    const request = buildRequest(['sh ver'], { autoComplete: true, id: 'fix-1' })
    expect(request.params).toHaveProperty('autoComplete', true)
  })

  it('keeps expandAliases on the allow-list [pyeapi test_request_adds_expandaliases]', () => {
    const request = buildRequest(['test'], { expandAliases: true, id: 'fix-1' })
    expect(request.params).toHaveProperty('expandAliases', true)
  })

  it('forwards timestamps', () => {
    expect(buildRequest(['show clock'], { timestamps: true, id: 'fix-1' }).params).toHaveProperty('timestamps', true)
  })

  it('sends the three params pyeapi drops: stopOnError:false, includeErrorDetail:true, requestTimeout (DR-016)', () => {
    const request = buildRequest(['vlan 20'], {
      stopOnError: false,
      includeErrorDetail: true,
      requestTimeout: 120,
      id: 'fix-1',
    })
    expect(request.params).toMatchObject({ stopOnError: false, includeErrorDetail: true, requestTimeout: 120 })
  })

  it('accepts version:"latest" and a bare revision on a command object', () => {
    const request = buildRequest([{ cmd: 'show vlan', revision: 2 }], { version: 'latest', id: 'fix-1' })
    expect(request.params).toMatchObject({ version: 'latest', format: 'json' })
    expect(request.params.cmds[0]).toEqual({ cmd: 'show vlan', revision: 2 })
  })

  it('omits parameters the caller did not set, so EOS keeps its own defaults', () => {
    const request = buildRequest(['show version'], { id: 'fix-1' })
    expect(request.params).toEqual({ version: 1, cmds: ['show version'], format: 'json' })
  })

  it('never emits streaming, in params or in the envelope (DR-016, MIGRATION.md §7)', () => {
    const request = buildRequest(['show version'], { id: 'fix-1' })
    expect(JSON.stringify(request)).not.toContain('streaming')
    expect(RUN_CMDS_PARAM_KEYS).not.toContain('streaming')
  })

  it('rejects an unknown parameter instead of dropping it silently [pyeapi test_request_ignores_unknown_param]', () => {
    // pyeapi filters unknown kwargs away (eapilib.py:352-355), so a typo is invisible until the
    // device answers -32602. Ours refuses at the call site, naming the parameter.
    const options = { bogus: true } as BuildRequestOptions
    expect(() => buildRequest(['show version'], options)).toThrow(NotSupportedError)
    expect(() => buildRequest(['show version'], options)).toThrow(/unsupported runCmds parameter 'bogus'/)
  })

  it('rejects a fourth key on a command object — only cmd/input/revision exist server-side', () => {
    const commands = [{ cmd: 'show vlan', streaming: false }] as unknown as [{ cmd: string; streaming: boolean }]
    expect(() => buildRequest(commands)).toThrow(NotSupportedError)
    expect(() => buildRequest(commands)).toThrow(/unsupported command parameter 'streaming'/)
    expect(COMMAND_OBJECT_KEYS).toEqual(['cmd', 'input', 'revision'])
  })

  it('rejects a format that is not json or text [pyeapi test_execute_raises_type_error]', () => {
    expect(() => buildRequest(['show version'], { format: 'yaml' as 'json' })).toThrow(TypeError)
    expect(() => buildRequest(['show version'], { format: 'yaml' as 'json' })).toThrow(/format must be one of \[json, text\]/)
  })

  it('rejects a version other than 1 or "latest"', () => {
    expect(() => buildRequest(['show version'], { version: 2 as 1 })).toThrow(/version must be 1 or 'latest'/)
  })

  it('rejects a requestTimeout that is not a positive number of seconds', () => {
    for (const value of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => buildRequest(['show version'], { requestTimeout: value })).toThrow(TypeError)
    }
  })

  it('rejects commands that are empty, non-string, or malformed objects', () => {
    expect(() => buildRequest(['   '])).toThrow(/command 0 must not be empty/)
    expect(() => buildRequest([42 as unknown as string])).toThrow(/command 0 must be a string or/)
    expect(() => buildRequest([{ cmd: '' }])).toThrow(/missing a non-empty 'cmd'/)
    expect(() => buildRequest([{ cmd: 'banner motd', input: 7 as unknown as string }])).toThrow(/non-string 'input'/)
    expect(() => buildRequest([{ cmd: 'show vlan', revision: 1.5 }])).toThrow(/non-integer 'revision'/)
  })

  it('does not mutate the caller’s command array', () => {
    const commands = ['show version']
    buildRequest(commands, { id: 'fix-1' })
    expect(commands).toEqual(['show version'])
  })
})

describe('request id policy (DR-017)', () => {
  it('is monotonic per connection and formatted <clientId>-<seq>', () => {
    const ids = createRequestIds({ seed: '7f3a2b9c1d', nonce: 'ui' })
    expect(ids.clientId).toBe('ui-7f3a2b9c1d')
    expect([ids.next(), ids.next(), ids.next()]).toEqual(['ui-7f3a2b9c1d-1', 'ui-7f3a2b9c1d-2', 'ui-7f3a2b9c1d-3'])
  })

  it('works without a nonce and still increments', () => {
    const ids = createRequestIds({ seed: 'a1b2c3' })
    expect(ids.next()).toBe('a1b2c3-1')
    expect(ids.next()).toBe('a1b2c3-2')
  })

  it('honours a start offset, for resuming a connection after a reconnect', () => {
    const ids = createRequestIds({ seed: 'a1b2c3', start: 40 })
    expect(ids.next()).toBe('a1b2c3-41')
  })

  it('generates a distinct random client segment per policy (no module-level singleton, ARCHITECTURE §7)', () => {
    const first = createRequestIds().clientId
    const second = createRequestIds().clientId
    expect(first).not.toBe(second)
    expect(first).toMatch(/^[0-9a-f]{12}$|^[0-9a-z]+$/)
  })

  it('buildRequest takes the next id from the policy, and an explicit id wins', () => {
    const ids = createRequestIds({ seed: '7f3a2b9c1d' })
    expect(buildRequest(['show version'], { ids }).id).toBe('7f3a2b9c1d-1')
    expect(buildRequest(['show version'], { ids }).id).toBe('7f3a2b9c1d-2')
    expect(buildRequest(['show version'], { ids, id: 'pinned' }).id).toBe('pinned')
    expect(buildRequest(['show version'], { ids }).id).toBe('7f3a2b9c1d-3')
  })

  it('gives a call with no policy a one-shot id of the same shape', () => {
    expect(buildRequest(['show version']).id).toMatch(/^[0-9a-z]+-1$/)
  })
})

describe('parseResponse — success envelopes (never throws for a device error)', () => {
  it('returns the decoded result array and echoes the id [pyeapi test_execute_valid_response]', () => {
    const parsed = parseResponse(envelope([{}, { hostname: 'sw1' }], 'ui-7f3a2b9c1d-9'))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('unreachable')
    expect(parsed.envelope.result).toEqual([{}, { hostname: 'sw1' }])
    expect(parsed.envelope.id).toBe('ui-7f3a2b9c1d-9')
  })

  it('accepts an empty result array', () => {
    const parsed = parseResponse(envelope([]))
    expect(parsed.ok).toBe(true)
  })

  it('unwrapResponse returns results for a success envelope and throws for a failure', () => {
    expect(unwrapResponse(parseResponse(envelope([{ hostname: 'sw1' }])))).toEqual([{ hostname: 'sw1' }])
    const failure = parseResponse(failureBody({ code: 1002, message: 'invalid command' }))
    expect(() => unwrapResponse(failure)).toThrow(CommandError)
  })
})

describe('parseResponse — malformed envelopes become ProtocolError, not a crash', () => {
  it('carries the raw body, truncated to MAX_RAW_BODY, when the JSON is unparseable', () => {
    const body = `{"jsonrpc": "2.0", "result": [${'x'.repeat(MAX_RAW_BODY * 2)}`
    const error = failureOf(body)
    expect(error).toBeInstanceOf(ProtocolError)
    const rawBody = (error as ProtocolError).rawBody ?? ''
    const suffix = `… [truncated ${body.length - MAX_RAW_BODY} chars]`
    expect(rawBody).toHaveLength(MAX_RAW_BODY + suffix.length)
    expect(rawBody.endsWith(suffix)).toBe(true)
    expect(error).toMatchObject({ name: 'ProtocolError', code: EapiErrorCode.PARSE_ERROR })
    expect((error as ProtocolError).code).toBe(EapiErrorCode.PARSE_ERROR)
  })

  it('rejects a body that is not an object', () => {
    expect(failureOf('[]')).toMatchObject({ message: /must be a JSON object/ })
    expect(failureOf('"show version"')).toMatchObject({ message: /must be a JSON object/ })
  })

  it('rejects a response with both result and error, or with neither', () => {
    expect(failureOf('{"jsonrpc":"2.0","result":[],"error":{"code":1002,"message":"x"}}')).toMatchObject({
      name: 'ProtocolError',
      code: EapiErrorCode.INVALID_REQUEST,
    })
    expect(failureOf('{"jsonrpc":"2.0"}')).toMatchObject({ code: EapiErrorCode.INVALID_REQUEST })
  })

  it('rejects a result that is not an array of objects', () => {
    expect(failureOf('{"jsonrpc":"2.0","result":{"hostname":"sw1"}}')).toMatchObject({
      message: /result must be an array of per-command objects/,
    })
    expect(failureOf('{"jsonrpc":"2.0","result":[[]]}')).toMatchObject({
      message: /result must be an array of per-command objects/,
    })
  })

  it('rejects an error envelope without a numeric code or without a message', () => {
    expect(failureOf('{"jsonrpc":"2.0","error":{"message":"no code"}}')).toMatchObject({
      message: /missing a numeric code/,
    })
    expect(failureOf('{"jsonrpc":"2.0","error":{"code":"1002","message":"string code"}}')).toMatchObject({
      message: /missing a numeric code/,
    })
    expect(failureOf('{"jsonrpc":"2.0","error":{"code":1002}}')).toMatchObject({
      message: /missing a message/,
    })
  })

  it('rejects an unexpected jsonrpc version but tolerates the key being absent', () => {
    expect(failureOf('{"jsonrpc":"1.0","result":[]}')).toMatchObject({
      message: /unsupported jsonrpc version '1.0'/,
    })
    expect(parseResponse('{"result":[{}]}').ok).toBe(true)
  })

  it('attaches the commands that produced a protocol failure, redacted', () => {
    const error = failureOf('not json', [{ cmd: 'enable', input: PROBE_PASSWORD }, 'username admin secret pw-from-fixture-probe'])
    expect(error.commands).toEqual([
      { cmd: 'enable', input: '<redacted>' },
      'username admin secret <redacted>',
    ])
    expect(JSON.stringify(error)).not.toContain(PROBE_PASSWORD)
  })
})

describe('error envelopes — one assertion set per code (DR-010)', () => {
  const cases: readonly { code: number; message: string; data?: unknown }[] = [
    { code: 1000, message: "CLI command 1 of 2 'write' failed: permission denied", data: [{}, { errors: ['permission denied'] }] },
    { code: 1001, message: "CLI command 2 of 2 'show tech' failed: internal exception", data: [{}, { errors: ['internal exception'] }] },
    { code: 1002, message: "CLI command 2 of 3 'vlan 4095' failed: invalid command", data: [{}, { errors: ['invalid command'] }] },
    { code: 1003, message: "CLI command 1 of 1 'show session-config diffs' failed: not JSON convertible" },
    { code: 1004, message: "CLI command 2 of 3 'reload' failed: incompatible with eAPI", data: [{}, { errors: ['incompatible'] }] },
    { code: 1005, message: "CLI command 1 of 1 'enable' failed: Command unauthorized" },
    { code: 1006, message: "CLI command 2 of 4 'configure session x' failed: config locked", data: [{}, { errors: ['config locked'] }] },
    { code: -32700, message: 'parse error' },
    { code: -32600, message: 'invalid request' },
    { code: -32601, message: 'method not found: runCmd' },
    { code: -32602, message: "runCmds() got an unexpected keyword argument 'autoComplete'" },
    { code: -32603, message: 'internal error' },
    { code: 9999, message: 'some future code we have never seen', data: [{ errors: ['test'] }] },
  ]

  for (const fixture of cases) {
    const bracketed = [1000, 1001, 1002, 1004].includes(fixture.code)
    it(`${fixture.code} → CommandError with a pyeapi-comparable message`, () => {
      const parsed = parseResponse(failureBody({ code: fixture.code, message: fixture.message, ...(fixture.data === undefined ? {} : { data: fixture.data }) }), {
        commands: ['show version'],
      })
      const error = parsed.ok ? undefined : parsed.error
      expect(error).toBeInstanceOf(CommandError)
      const command = error as CommandError
      expect(command.code).toBe(fixture.code)
      expect(command.name).toBe('CommandError')
      const decorated =
        fixture.code === -32602 ? ". autoComplete parameter is not supported in this version of EOS." : ''
      const prefix = `Error [${fixture.code}]: ${fixture.message}${decorated}`
      expect(command.message.startsWith(prefix)).toBe(true)
      // 1000/1001/1002/1004 with data carry the `[...]` suffix; every other code does not.
      const suffix = command.message.slice(prefix.length)
      expect(suffix).toBe(bracketed && fixture.data !== undefined ? ` [${command.commandError ?? ''}]` : '')
      expect(command.results.length).toBe(Array.isArray(fixture.data) ? fixture.data.length : 0)
    })
  }

  it('a failure envelope does not throw out of parseResponse [pyeapi test_send_raises_command_error]', () => {
    const parsed = parseResponse(failureBody({ code: 9999, message: 'test', data: [{ errors: ['test'] }] }))
    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error('unreachable')
    expect(parsed.envelope?.error.code).toBe(9999)
    expect(parsed.error).toBeInstanceOf(CommandError)
  })

  it('there is no 1007 in the code map, and the legacy EAPI_E_* names are absent (DR-010)', () => {
    const codes = Object.values(EapiErrorCode)
    expect(codes).toEqual([-32700, -32600, -32601, -32602, -32603, 1000, 1001, 1002, 1003, 1004, 1005, 1006])
    expect(codes).not.toContain(1007)
    expect(Object.keys(EapiErrorCode)).not.toContain('EAPI_E_COMMAND_FAILED')
    expect(Object.isFrozen(EapiErrorCode)).toBe(true)
  })
})

describe('error.data — both shapes (DR-010, DR-011)', () => {
  it('array shape: results are the per-command outputs and commandError matches pyeapi’s err text', () => {
    const data = [{ hostname: 'sw1' }, { errors: ["invalid command input='pw-from-fixture-probe'"] }]
    const error = parseErrorEnvelope({
      jsonrpc: '2.0',
      id: 'ui-7f3a2b9c1d-1',
      error: { code: 1002, message: "CLI command 2 of 2 'vlan 4095' failed: invalid command", data },
    })
    expect(error.results).toEqual([{ hostname: 'sw1' }, { errors: ['invalid command input=<redacted>'] }])
    expect(error.commandError).toBe("hostname: 'sw1', errors: ['invalid command input=<redacted>']")
    expect(error.message).toBe(
      "Error [1002]: CLI command 2 of 2 'vlan 4095' failed: invalid command [hostname: 'sw1', errors: ['invalid command input=<redacted>']]",
    )
  })

  it('array shape without an enable secret is rendered exactly as pyeapi would (%r of each value)', () => {
    const error = parseErrorEnvelope({
      jsonrpc: '2.0',
      error: { code: 1002, message: 'invalid command', data: [{}, { errors: ['invalid command'] }] },
    })
    expect(error.commandError).toBe("errors: ['invalid command']")
  })

  it('includeErrorDetail shape: {result[], errorDetail[]} — the branch pyeapi cannot parse', () => {
    const error = parseErrorEnvelope({
      jsonrpc: '2.0',
      id: 'ui-7f3a2b9c1d-2',
      error: {
        code: 1002,
        message: "CLI command 3 of 4 'vlan 4095' failed: invalid command",
        data: {
          result: [{}, { name: 'probe' }, { errors: ['invalid command'] }],
          errorDetail: [{ index: 2, code: 1002, message: 'invalid command', cmd: 'vlan 4095' }],
        },
      },
    })
    expect(error.errorDetail).toEqual([{ index: 2, code: 1002, message: 'invalid command', cmd: 'vlan 4095' }])
    expect(error.results).toHaveLength(3)
    expect(error.failedCommand).toBe('vlan 4095')
    expect(error.commandError).toBe("index: 2, code: 1002, message: 'invalid command', cmd: 'vlan 4095'")
  })

  it('includeErrorDetail shape without errorDetail still yields results from data.result', () => {
    const error = parseErrorEnvelope({
      jsonrpc: '2.0',
      error: { code: 1004, message: 'incompatible', data: { result: [{}, {}] } },
    })
    expect(error.errorDetail).toBeUndefined()
    expect(error.results).toHaveLength(2)
  })

  it('data omitted: no [...] suffix, empty results (pyeapi prints the literal None — MIGRATION §5)', () => {
    const error = parseErrorEnvelope({ jsonrpc: '2.0', error: { code: 1002, message: 'invalid command' } })
    expect(error.commandError).toBeUndefined()
    expect(error.results).toEqual([])
    expect(error.message).toBe('Error [1002]: invalid command')
    expect(error.failedCommand).toBeUndefined()
  })

  it('failedCommand falls back to the CLI command index when the payload carries no marker', () => {
    const error = parseErrorEnvelope(
      {
        jsonrpc: '2.0',
        error: { code: 1002, message: "CLI command 3 of 4 'vlan 4095' failed: invalid command", data: [] },
      },
      { commands: ['enable', 'configure', 'vlan 4095', 'name x'] },
    )
    expect(error.failedCommand).toBe('vlan 4095')
  })

  it('failedCommand is redacted when the failing command itself carries a secret', () => {
    const error = parseErrorEnvelope(
      { jsonrpc: '2.0', error: { code: 1002, message: 'invalid command', data: [{}, { errors: ['nope'] }] } },
      { commands: ['enable', 'username admin privilege 15 secret pw-from-fixture-probe'] },
    )
    expect(error.failedCommand).toBe('username admin privilege 15 secret <redacted>')
    expect(JSON.stringify(error)).not.toContain(PROBE_PASSWORD)
  })
})

describe('the -32602 decoration (DR-016 UX) [pyeapi test_send_raises_*_command_error]', () => {
  it('explains an unexpected autoComplete keyword [pyeapi test_send_raises_autocomplete_command_error]', () => {
    const message = "runCmds() got an unexpected keyword argument 'autoComplete'"
    const error = parseErrorEnvelope({ jsonrpc: '2.0', error: { code: 9999, message, data: [{ errors: ['test'] }] } })
    expect(error.message).toContain('autoComplete parameter is not supported in this version of EOS.')
  })

  it('explains an unexpected expandAliases keyword [pyeapi test_send_raises_expandaliases_command_error]', () => {
    const message = "runCmds() got an unexpected keyword argument 'expandAliases'"
    const parsed = parseResponse(failureBody({ code: -32602, message }))
    const error = parsed.ok ? undefined : parsed.error
    expect(error?.message).toContain('expandAliases parameter is not supported in this version of EOS.')
  })

  it('appends pyeapi’s sentence byte-for-byte, and leaves other messages alone', () => {
    expect(decorateUnsupportedParam("runCmds() got an unexpected keyword argument 'timestamps'")).toBe(
      "runCmds() got an unexpected keyword argument 'timestamps'. timestamps parameter is not supported in this version of EOS.",
    )
    expect(decorateUnsupportedParam('CLI command 1 of 1 failed')).toBe('CLI command 1 of 1 failed')
  })
})

describe('pyeapi %r rendering parity (MessageFormat of CommandError)', () => {
  it('renders JSON values the way Python repr() would', () => {
    expect(pythonRepr('x')).toBe("'x'")
    expect(pythonRepr("it's")).toBe('"it\'s"')
    expect(pythonRepr('a\nb\tc\x01d')).toBe("'a\\nb\\tc\\x01d'")
    expect(pythonRepr([1, 'a', null, true, false])).toBe("[1, 'a', None, True, False]")
    expect(pythonRepr({ errors: ['bad'], n: 2 })).toBe("{'errors': ['bad'], 'n': 2}")
    expect(pythonRepr({})).toBe('{}')
    expect(pythonRepr([])).toBe('[]')
    expect(pythonRepr(0.5)).toBe('0.5')
  })

  it('flattens every key of every data entry into "k: repr(v)" pairs, joined with ", "', () => {
    expect(formatErrorDataEntries([{ a: 1 }, { b: 'x', c: [1, 2] }])).toBe("a: 1, b: 'x', c: [1, 2]")
    expect(formatErrorDataEntries([])).toBe('')
    expect(formatErrorDataEntries(['bare'])).toBe('<unparsed entry: \'bare\'>')
  })

  it('redacts the rendered data text even when the secret is not in an input= form', () => {
    const rendered = formatErrorDataEntries([{ cmd: 'enable', input: PROBE_PASSWORD }])
    expect(rendered).toBe("cmd: 'enable', input: '<redacted>'")
    expect(rendered).not.toContain(PROBE_PASSWORD)
  })
})

describe('DR-011 redaction inside error objects — asserted on the serialised error', () => {
  const leakyEnvelope = failureBody({
    code: 1002,
    message: `CLI command 1 of 3 'enable' failed: invalid command input='${PROBE_PASSWORD}'`,
    data: [
      { errors: [`input='${PROBE_PASSWORD}'`] },
      { cmd: 'username admin secret sha512 $6$rounds$hashedvalue' },
    ],
  })

  it('a secret never reaches message, toString, stack or toJSON — for a non-1005 code', () => {
    const parsed = parseResponse(leakyEnvelope, { commands: [{ cmd: 'enable', input: PROBE_PASSWORD }, 'show version'] })
    const error = parsed.ok ? undefined : parsed.error
    expect(error).toBeInstanceOf(CommandError)
    const serialised = [error?.message, String(error), error?.stack ?? '', JSON.stringify(error)].join('\n')
    expect(serialised).not.toContain(PROBE_PASSWORD)
    expect(error?.message).toContain('input=<redacted>')
  })

  it('pyeapi only scrubbed 1005; we scrub every code, and the [..] suffix too', () => {
    for (const code of [1000, 1001, 1002, 1004, 1005, 1006]) {
      const parsed = parseResponse(
        failureBody({ code, message: `boom input='${PROBE_PASSWORD}'`, data: [{ errors: [`input=${PROBE_PASSWORD}`] }] }),
      )
      const error = parsed.ok ? undefined : parsed.error
      expect(JSON.stringify(error)).not.toContain(PROBE_PASSWORD)
      expect(error?.message).toContain(`Error [${code}]: boom input=<redacted>`)
    }
  })

  it('the data copy stored on the error is redacted, so a re-serialised error cannot leak', () => {
    const parsed = parseResponse(leakyEnvelope)
    if (parsed.ok) throw new Error('unreachable')
    expect(JSON.stringify((parsed.error as CommandError).results)).not.toContain(PROBE_PASSWORD)
    expect(JSON.stringify(parsed.envelope?.error.data)).not.toContain(PROBE_PASSWORD)
  })

  it('username … secret … is redacted in message, commands and errorDetail', () => {
    const parsed = parseResponse(
      failureBody({
        code: 1002,
        message: "CLI command 2 of 3 'username admin privilege 15 secret plain s3cr3t-admin' failed: invalid command",
        data: { result: [], errorDetail: [{ index: 1, code: 1002, message: "username admin secret plain 's3cr3t-admin' rejected", cmd: 'username admin secret plain s3cr3t-admin' }] },
      }),
      { commands: ['enable', 'username admin privilege 15 secret plain s3cr3t-admin', 'show version'] },
    )
    const serialised = JSON.stringify(parsed.ok ? null : parsed.error)
    expect(serialised).not.toContain('s3cr3t-admin')
    const error = parsed.ok ? undefined : (parsed.error as CommandError)
    expect(error?.failedCommand).toBe('username admin secret plain <redacted>')
    expect(error?.errorDetail?.[0]?.cmd).toBe('username admin secret plain <redacted>')
    expect(error?.commands?.[1]).toBe('username admin privilege 15 secret plain <redacted>')
  })

  it('isUnconvertedCommandFailure recognises exactly 1003', () => {
    const unconverted = failureOf(failureBody({ code: 1003, message: 'no json model' }))
    const other = failureOf(failureBody({ code: 1002, message: 'invalid' }))
    expect(isUnconvertedCommandFailure(unconverted)).toBe(true)
    expect(isUnconvertedCommandFailure(other)).toBe(false)
    expect(isUnconvertedCommandFailure(new Error('plain'))).toBe(false)
    expect(isUnconvertedCommandFailure(undefined)).toBe(false)
  })
})

describe('the 1003 → format:"text" fallback hook (DR-012) over the WireSender seam', () => {
  const unconverted = failureBody({ code: 1003, message: "CLI command 1 of 1 'show session-config diffs' failed: not convertible" }, 'ui-7f3a2b9c1d-1')
  const textAnswer = envelope([{ output: '-- -- -- session-config diff\n+vlan 4000\n' }], 'ui-7f3a2b9c1d-2')

  it('re-issues the same command with format:"text" and reports the encoding it actually got', async () => {
    const ids = createRequestIds({ seed: '7f3a2b9c1d', nonce: 'ui' })
    const fake = createFakeSender([unconverted, textAnswer])
    const outcome = await sendRequest(fake.sender, ['show session-config diffs'], { ids })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.viaTextRetry).toBe(true)
    expect(outcome.encoding).toBe('text')
    expect(outcome.result[0]).toMatchObject({ output: expect.stringContaining('+vlan 4000') })
    expect(fake.requests.map((request) => request.params.format)).toEqual(['json', 'text'])
    expect(fake.requests.map((request) => request.id)).toEqual(['ui-7f3a2b9c1d-1', 'ui-7f3a2b9c1d-2'])
  })

  it('tolerateErrors:false returns the 1003 and sends nothing else (the runRequest form throws)', async () => {
    const fake = createFakeSender([unconverted])
    const outcome = await sendRequest(fake.sender, ['show session-config diffs'], { tolerateErrors: false })
    expect(outcome.ok).toBe(false)
    expect(fake.requests).toHaveLength(1)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.error).toMatchObject({ code: 1003 })
    const second = createFakeSender([unconverted])
    await expect(runRequest(second.sender, ['show session-config diffs'], { tolerateErrors: false })).rejects.toThrow(CommandError)
    expect(second.requests).toHaveLength(1)
  })

  it('does not retry any other code', async () => {
    const fake = createFakeSender([failureBody({ code: 1002, message: 'invalid command' })])
    const outcome = await sendRequest(fake.sender, ['vlan 4095'])
    expect(outcome.ok).toBe(false)
    expect(fake.requests).toHaveLength(1)
  })

  it('a retry that also fails reports the text attempt, so the operator keeps the newest error', async () => {
    const fake = createFakeSender([unconverted, failureBody({ code: 1003, message: 'still not convertible' })])
    const outcome = await sendRequest(fake.sender, ['show session-config diffs'])
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.viaTextRetry).toBe(true)
    expect(outcome.error.message).toContain('still not convertible')
    expect(fake.requests).toHaveLength(2)
  })

  it('reuses a caller-pinned id for the retry instead of inventing one', async () => {
    const fake = createFakeSender([unconverted, textAnswer])
    await sendRequest(fake.sender, ['show session-config diffs'], { id: 'pinned-7' })
    expect(fake.requests.map((request) => request.id)).toEqual(['pinned-7', 'pinned-7'])
  })

  it('runRequest returns results on the happy path and propagates a failing sender [pyeapi test_execute_valid_response / test_execute_raises_connection_error]', async () => {
    const ok = await runRequest(createFakeSender([envelope([{ hostname: 'sw1' }])]).sender, ['show version'])
    expect(ok).toEqual([{ hostname: 'sw1' }])

    const boom: WireSender = {
      send(): Promise<string> {
        return Promise.reject(new Error('socket closed'))
      },
    }
    await expect(runRequest(boom, ['show version'])).rejects.toThrow('socket closed')
  })

  it('runRequest raises the CommandError a failure envelope produced [pyeapi test_execute_raises_command_error]', async () => {
    const fake = createFakeSender([failureBody({ code: 9999, message: 'test', data: [{ errors: ['test'] }] })])
    await expect(runRequest(fake.sender, ['test'])).rejects.toThrow(/Error \[9999\]: test/)
  })
})

describe('type-level contract (expectTypeOf)', () => {
  it('the option object is closed to the nine runCmds params plus id/ids', () => {
    expectTypeOf<BuildRequestOptions>().toHaveProperty('stopOnError')
    expectTypeOf<BuildRequestOptions>().toHaveProperty('includeErrorDetail')
    expectTypeOf<BuildRequestOptions>().toHaveProperty('requestTimeout')
    expectTypeOf<BuildRequestOptions>().not.toHaveProperty('streaming')
    // Compile-time half of "rejected at compile time *and* runtime" (DR-016): the excess-property
    // check catches the typo, and buildRequest's runtime allow-list catches it again for callers
    // who reach it through an `as` cast or a dynamically built object.
    // @ts-expect-error - 'stopOnEr' is not a property of BuildRequestOptions
    const bogus: BuildRequestOptions = { stopOnEr: false }
    expect(() => buildRequest(['show version'], bogus)).toThrow(/unsupported runCmds parameter 'stopOnEr'/)
  })

  it('a command object cannot gain a fourth key', () => {
    // @ts-expect-error - 'straming' is not a key of CommandObject (only cmd/input/revision exist)
    const commands: CommandSpec[] = [{ cmd: 'show vlan', straming: true }]
    expect(() => buildRequest(commands)).toThrow(/unsupported command parameter 'straming'/)
  })

  it('cmds is a readonly array of CommandSpec, and format/version are literal unions', () => {
    const request = buildRequest(['show version'])
    // `expectTypeOf(...).toEqualTypeOf<readonly (…)[]>()` cannot take a readonly *array* type
    // argument here — vitest's branded comparator degrades it to `never[]` (TS4104). The identity
    // check below is the stricter form anyway: it pins `cmds` to the `CommandSpec` alias itself, so
    // renaming or widening that contract fails this assertion instead of quietly passing.
    expectTypeOf<Exactly<typeof request.params.cmds, readonly CommandSpec[]>>().toEqualTypeOf<true>()
    expectTypeOf(request.params.format).toEqualTypeOf<'json' | 'text'>()
    expectTypeOf(request.params.version).toEqualTypeOf<1 | 'latest'>()
  })

  it('parseResponse narrows on ok, and unwrapResponse yields CommandResult[]', () => {
    const parsed = parseResponse(envelope([{}]))
    if (parsed.ok) {
      expectTypeOf(parsed.envelope.result).toEqualTypeOf<readonly Record<string, unknown>[]>()
    } else {
      expectTypeOf(parsed.error).toEqualTypeOf<CommandError | ProtocolError>()
    }
    expectTypeOf(unwrapResponse(parsed)).toEqualTypeOf<readonly Record<string, unknown>[]>()
  })

  it('sendRequest narrows ok/false so the error is reachable without a cast', async () => {
    const outcome = await sendRequest(createFakeSender([envelope([{}])]).sender, ['show version'])
    if (outcome.ok) {
      expectTypeOf(outcome.result).toEqualTypeOf<readonly Record<string, unknown>[]>()
    } else {
      expectTypeOf(outcome.error).toEqualTypeOf<CommandError | ProtocolError>()
    }
  })

  it('an injected WireSender is structurally satisfied by a synchronous fake', () => {
    const sender: WireSender = { send: () => envelope([{}]) }
    expectTypeOf(sender.send).parameter(0).toEqualTypeOf<JsonRpcRequest>()
  })
})
