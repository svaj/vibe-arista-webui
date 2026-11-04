/**
 * The M11 (#13) non-`runCmds` section of the codec: the three request builders, the object-result gate,
 * and `sendMethodRequest`/`runMethodRequest`. Entirely offline — every device body below is a string this
 * file wrote.
 *
 * ## Evidence status — read before reusing any shape here
 *
 * pyeapi implements **only** `runCmds` (`eapilib.py:326-327`, `:362` in the pinned clone `develop`
 * `6816d9e`; `grep -rn "verifyConfig\|getCommandCompletions\|getCommandHelp" pyeapi/pyeapi/` matches
 * nothing), so there is **no upstream test to port and no upstream sample to copy**. What is verified here:
 *
 *  - the **request** side, which is this client's own decision plus the server signatures read out of
 *    Arista's Python for **EOS 4.28.13.1M** (`usr/lib/python3.9/site-packages/JsonCli.py`, extracted from
 *    `/home/svaj/development/arista/_rea_swi/Base.sqsh`): `verifyConfig(configList, format, timestamps,
 *    stopOnError, version)` at `:275-279`, `getCommandCompletions(command, preamble=None)` at `:173-192`,
 *    `getCommandHelp(command)` at `:199-203`, and `JsonRpcBase.py:160` writing `result` from the
 *    procedure's return value;
 *  - the **refusals**, which are ours (DR-016 allow-list) and need no device at all.
 *
 * What is **not** verified: every `result`/`error` **body** in this file is hand-authored from those
 * return statements, not captured. `verifyConfig` is the one method whose reply shape follows from
 * evidence (the server builds a list of per-command replies, `JsonCli.py:306-321`, so the array gate
 * applies); the `{errors, complete, completions}` and flat `{token: help}` objects are read from
 * `JsonCli.py:188-192` / `CliApi.py:452` and are **labelled synthetic** at each use. The M12 (#14)
 * device capture replaces them; until then these tests pin *our parse*, not *EOS's prose*.
 *
 * These envelopes are deliberately **inline** rather than files in `test/fixtures/wire/`: that
 * directory's inventory (`src/internal/wire.fixture.test.ts`) pins 27 filenames per kind and drives every
 * one of them through `parseResponse`' array gate, which an object-result method reply cannot pass.
 */

import { describe, expect, it } from 'vitest'

import { CommandError, EapiErrorCode, NotSupportedError, ProtocolError } from '../errors'
import {
  GET_COMMAND_COMPLETIONS_PARAM_KEYS,
  GET_COMMAND_HELP_PARAM_KEYS,
  VERIFY_CONFIG_PARAM_KEYS,
  WIRE_METHODS,
  buildGetCommandCompletionsParams,
  buildGetCommandCompletionsRequest,
  buildGetCommandHelpRequest,
  buildMethodRequest,
  buildVerifyConfigParams,
  buildVerifyConfigRequest,
  createRequestIds,
  parseMethodResponse,
  runMethodRequest,
  sendMethodRequest,
} from './wire'
import type { BuildCompletionsRequestOptions, BuildVerifyConfigRequestOptions } from './wire'
import type { CommandResult, JsonRpcMethodRequest, MethodWireSender, WireMethodCall } from '../types/eapi'

/** The `verifyConfig` configlets used throughout: two review steps, so the reply pairing is checkable. */
const CONFIGLETS = ['interface Ethernet1\n no switchport\n ip address 10.0.0.1/24', 'vlan 20\n name WEB']

/** A recorder-sender: captures every method envelope the codec built and answers with `text`. */
function stubWire(text: string, failures = 0): { readonly sender: MethodWireSender; readonly sent: JsonRpcMethodRequest[] } {
  const sent: JsonRpcMethodRequest[] = []
  return {
    sent,
    sender: {
      sendMethod(request: JsonRpcMethodRequest): string {
        sent.push(request)
        if (failures > sent.length) throw new Error('stub wire exhausted')
        return text
      },
    },
  }
}

/** A body that always answers, so a refusal test can prove nothing was sent. */
const NEVER_ANSWERED: MethodWireSender = {
  sendMethod(): string {
    throw new Error('this test must refuse before the first round trip')
  },
}

/** SYNTHETIC (`JsonCli.py:321-326`): one `copy terminal: session-config` + one `show session-config` per configlet. */
function verifyConfigReply(steps: readonly { readonly copy?: object; readonly show?: object }[]): string {
  const result: object[] = []
  for (const step of steps) result.push(step.copy ?? {}, step.show ?? {})
  return JSON.stringify({ jsonrpc: '2.0', result, id: 'unit-1' })
}

/** SYNTHETIC (`JsonCli.py:188-192`) — needs the M12 (#14) capture. */
const COMPLETIONS_BODY = JSON.stringify({
  jsonrpc: '2.0',
  result: { errors: {}, complete: false, completions: { show: 'Set show command', copy: 'Copy from one file to another' } },
  id: 'unit-1',
})

/** SYNTHETIC (`CliApi.py:452`, `{c.name: c.help}`) — needs the M12 (#14) capture. */
const HELP_BODY = JSON.stringify({ jsonrpc: '2.0', result: { show: 'Set show command', version: 'Display software version' }, id: 'unit-1' })

describe('WIRE_METHODS — the one table the builders and the sender share', () => {
  it('declares exactly the three methods M11 ports, and nothing else', () => {
    expect(Object.keys(WIRE_METHODS)).toEqual(['verifyConfig', 'getCommandCompletions', 'getCommandHelp'])
    // `editConfig` is deliberately absent: this slice ports three methods, and a table entry is the only
    // way a call becomes reachable (`buildMethodRequest` reads nothing else).
    expect(Object.keys(WIRE_METHODS)).not.toContain('editConfig')
    expect(Object.keys(WIRE_METHODS)).not.toContain('runCmds')
  })

  it('freezes the table so a caller cannot widen the method surface at runtime', () => {
    expect(Object.isFrozen(WIRE_METHODS)).toBe(true)
  })

  it('names each method\'s server-side parameters, in the signature order JsonCli.py declares', () => {
    expect(VERIFY_CONFIG_PARAM_KEYS).toEqual(['configList', 'format', 'timestamps', 'stopOnError', 'version'])
    expect(GET_COMMAND_COMPLETIONS_PARAM_KEYS).toEqual(['command', 'preamble'])
    expect(GET_COMMAND_HELP_PARAM_KEYS).toEqual(['command'])
  })

  it('records which parameter JsonRpcBase.py:288-293 requires', () => {
    expect(WIRE_METHODS.verifyConfig.requiredParam).toBe('configList')
    expect(WIRE_METHODS.getCommandCompletions.requiredParam).toBe('command')
    expect(WIRE_METHODS.getCommandHelp.requiredParam).toBe('command')
  })

  it('splits the result gate by the server return type: list → array, dict → object (JsonRpcBase.py:160)', () => {
    expect(WIRE_METHODS.verifyConfig.resultShape).toBe('array')
    expect(WIRE_METHODS.getCommandCompletions.resultShape).toBe('object')
    expect(WIRE_METHODS.getCommandHelp.resultShape).toBe('object')
  })
})

describe('buildVerifyConfigParams — the configList rule', () => {
  it('sends only what the caller asked for: the server defaults stay the server\'s', () => {
    expect(buildVerifyConfigParams(CONFIGLETS)).toEqual({ configList: CONFIGLETS })
  })

  it('wraps a single configlet into the list the device requires (JsonCli.py:291-292), as an explicit coercion (DR-041)', () => {
    expect(buildVerifyConfigParams('vlan 20')).toEqual({ configList: ['vlan 20'] })
  })

  it('keeps multiline configlet text verbatim, including the trailing newline it was written with', () => {
    const params = buildVerifyConfigParams(['vlan 30\n name EAST\n'])
    expect(params.configList).toEqual(['vlan 30\n name EAST\n'])
  })

  it('passes format/timestamps/stopOnError/version through as the wire parameter names the signature uses', () => {
    expect(buildVerifyConfigParams(CONFIGLETS, { format: 'text', timestamps: true, stopOnError: false, version: 'latest' })).toEqual({
      configList: CONFIGLETS,
      format: 'text',
      timestamps: true,
      stopOnError: false,
      version: 'latest',
    })
  })

  it('refuses an empty configList locally, which our rule and not the device\'s — a screen that shows nothing is not a clean answer', () => {
    expect(() => buildVerifyConfigParams([])).toThrow(/at least one configlet/u)
    expect(() => buildVerifyConfigParams([])).toThrow(TypeError)
  })

  it('refuses an empty or non-string configlet: the server puts each one in a command object\'s input (JsonCli.py:36-39)', () => {
    expect(() => buildVerifyConfigParams(['vlan 20', ''])).toThrow(/configlet 1 is empty/u)
    expect(() => buildVerifyConfigParams([42 as unknown as string])).toThrow(/configlet 0 must be a string/u)
    expect(() => buildVerifyConfigParams([{ cmd: 'vlan 20' } as unknown as string])).toThrow(/configlet 0 must be a string/u)
    expect(() => buildVerifyConfigParams(5 as unknown as string)).toThrow(/configlet 0 must be a string/u)
  })

  it('holds the same encoding and version allow-lists as runCmds, rather than inventing a method-specific ones', () => {
    expect(() => buildVerifyConfigParams(CONFIGLETS, { format: 'yaml' as unknown as 'json' })).toThrow(/format must be one of \[json, text\]/u)
    expect(() => buildVerifyConfigParams(CONFIGLETS, { version: 2 as unknown as 1 })).toThrow(/version must be 1 or 'latest'/u)
  })

  it('refuses a non-boolean timestamps/stopOnError with a type error, not a truthy coercion', () => {
    expect(() => buildVerifyConfigParams(CONFIGLETS, { timestamps: 'yes' as unknown as boolean })).toThrow(/parameter 'timestamps' must be a boolean/u)
    expect(() => buildVerifyConfigParams(CONFIGLETS, { stopOnError: 1 as unknown as boolean })).toThrow(/parameter 'stopOnError' must be a boolean/u)
  })

  it('refuses includeErrorDetail: the server hard-codes it off for this method (JsonCli.py:318), so error.data is always the array shape', () => {
    expect(() => buildVerifyConfigParams(CONFIGLETS, { includeErrorDetail: true } as unknown as BuildVerifyConfigRequestOptions)).toThrow(NotSupportedError)
    expect(() => buildVerifyConfigParams(CONFIGLETS, { includeErrorDetail: true } as unknown as BuildVerifyConfigRequestOptions)).toThrow(/unsupported verifyConfig parameter 'includeErrorDetail'/u)
  })
})

describe('verifyConfig parameter allow-list (DR-016) — mutated to prove it bites', () => {
  const offenders: readonly [string, unknown][] = [
    ['enable', true],
    ['sessionName', 'sneak-into-a-session'],
    ['cmds', ['reload']],
    ['writeMemoryOnCommit', true],
    ['streaming', true],
    ['configlist', ['vlan 20']],
  ]

  it('refuses every parameter the server signature does not declare, before a byte is sent', () => {
    for (const [key, value] of offenders) {
      const options = { [key]: value } as unknown as BuildVerifyConfigRequestOptions
      expect(() => buildVerifyConfigParams(CONFIGLETS, options), key).toThrow(NotSupportedError)
      expect(() => buildVerifyConfigRequest(CONFIGLETS, options), key).toThrow(new RegExp(`unsupported verifyConfig parameter '${key}'`, 'u'))
    }
  })

  it('says why: an undeclared named parameter is answered -32603 by the dispatcher, not a helpful message', () => {
    expect(() => buildVerifyConfigParams(CONFIGLETS, { nope: 1 } as unknown as BuildVerifyConfigRequestOptions)).toThrow(/INTERNAL_ERROR|got an unexpected keyword argument|JsonRpcBase\.py:163-166/u)
  })

  it('accepts the two envelope knobs it reserves, and keeps them out of params', () => {
    expect(buildVerifyConfigParams(CONFIGLETS, { id: 'x-1', ids: createRequestIds({ seed: 'aa' }) } as never)).toEqual({ configList: CONFIGLETS })
    const request = buildVerifyConfigRequest(CONFIGLETS, { id: 'x-1' })
    expect(request.id).toBe('x-1')
    expect(Object.keys(request.params)).toEqual(['configList'])
  })
})

describe('buildVerifyConfigRequest — the exact body we send', () => {
  it('is a JSON-RPC 2.0 envelope with method verifyConfig and no runCmds residue', () => {
    const request = buildVerifyConfigRequest(CONFIGLETS, { id: 'probe-1' })
    expect(request).toEqual({
      jsonrpc: '2.0',
      method: 'verifyConfig',
      id: 'probe-1',
      params: { configList: CONFIGLETS },
    })
    expect('cmds' in request.params).toBe(false)
    expect('stopOnError' in request.params).toBe(false)
  })

  it('stamps the connection id policy (DR-017), monotonically, and `id` overrides it', () => {
    const ids = createRequestIds({ seed: 'cafe', start: 40 })
    expect(buildVerifyConfigRequest('vlan 20', { ids }).id).toBe('cafe-41')
    expect(buildVerifyConfigRequest('vlan 30', { ids }).id).toBe('cafe-42')
    expect(buildVerifyConfigRequest('vlan 40', { ids, id: 'pinned' }).id).toBe('pinned')
    expect(buildVerifyConfigRequest('vlan 50', { ids }).id).toBe('cafe-43')
  })

  it('builds the same body from the generic {method, params} pair that Transport#callMethod stamps', () => {
    const call: WireMethodCall = { method: 'verifyConfig', params: { configList: CONFIGLETS, format: 'text' } }
    expect(buildMethodRequest(call, { id: 'g-1' })).toEqual(buildVerifyConfigRequest(CONFIGLETS, { format: 'text', id: 'g-1' }))
  })
})

describe('buildGetCommandCompletionsParams / Request', () => {
  it('sends command and, only when given, preamble', () => {
    expect(buildGetCommandCompletionsParams('sh ver')).toEqual({ command: 'sh ver' })
    expect(buildGetCommandCompletionsParams('sh ver', { preamble: ['interface Ethernet1'] })).toEqual({ command: 'sh ver', preamble: ['interface Ethernet1'] })
  })

  it('allows the empty partial line — completing \'\' asks for the command set of the current mode', () => {
    expect(buildGetCommandCompletionsParams('')).toEqual({ command: '' })
    expect(buildGetCommandCompletionsRequest('', { id: 'c-0' })).toEqual({ jsonrpc: '2.0', method: 'getCommandCompletions', id: 'c-0', params: { command: '' } })
  })

  it('passes the preamble through untouched: it is a CLI list the device executes, so no trimming, dedupe or reordering (CliApi.py:656-668)', () => {
    const preamble = ['interface Ethernet1', '  no switchport', 'interface Ethernet1']
    expect(buildGetCommandCompletionsParams('sw', { preamble }).preamble).toEqual(preamble)
  })

  it('refuses a preamble entry that is not a non-empty command string', () => {
    expect(() => buildGetCommandCompletionsParams('sh', { preamble: 'interface Ethernet1' as unknown as readonly string[] })).toThrow(/must be an array of command strings/u)
    expect(() => buildGetCommandCompletionsParams('sh', { preamble: [''] })).toThrow(/preamble 0 must be a non-empty command string/u)
    expect(() => buildGetCommandCompletionsParams('sh', { preamble: ['   '] })).toThrow(/preamble 0 must be a non-empty command string/u)
    expect(() => buildGetCommandCompletionsParams('sh', { preamble: [7 as unknown as string] })).toThrow(/preamble 0 must be a non-empty command string/u)
  })

  it('refuses a control character in a preamble entry: a newline would end that CLI line and start another', () => {
    expect(() => buildGetCommandCompletionsParams('sh', { preamble: ['interface Ethernet1\nexit'] })).toThrow(NotSupportedError)
    expect(() => buildGetCommandCompletionsParams('sh', { preamble: ['ip address 10.0.0.1/24', 'vlan 20\tname WEB'] })).toThrow(/preamble 1 contains a control character/u)
  })

  it('refuses a non-string command (the device answers -32602 for exactly this, JsonCli.py:48-55)', () => {
    expect(() => buildGetCommandCompletionsParams(undefined as unknown as string)).toThrow(/parameter 'command' must be a string/u)
    expect(() => buildGetCommandCompletionsParams({ cmd: 'show' } as unknown as string)).toThrow(/parameter 'command' must be a string/u)
  })

  it('refuses undeclared parameters — the method takes exactly command and preamble', () => {
    for (const key of ['format', 'version', 'cmds', 'timestamps', 'preambles', 'configList']) {
      expect(() => buildGetCommandCompletionsRequest('sh', { [key]: 1 } as unknown as BuildCompletionsRequestOptions), key).toThrow(/unsupported getCommandCompletions parameter/u)
    }
  })

  it('pins the request body, id included', () => {
    const ids = createRequestIds({ nonce: 'webui', seed: 'beef' })
    expect(buildGetCommandCompletionsRequest('copy run', { ids, preamble: ['enable'] })).toEqual({
      jsonrpc: '2.0',
      method: 'getCommandCompletions',
      id: 'webui-beef-1',
      params: { command: 'copy run', preamble: ['enable'] },
    })
  })
})

describe('buildGetCommandHelpRequest', () => {
  it('sends exactly one parameter, even for a partial line', () => {
    const request = buildGetCommandHelpRequest('show interface status', { id: 'h-1' })
    expect(request).toEqual({ jsonrpc: '2.0', method: 'getCommandHelp', id: 'h-1', params: { command: 'show interface status' } })
    expect(Object.keys(request.params)).toEqual(['command'])
  })

  it('refuses anything beyond command: no format, no revision, no preamble', () => {
    for (const key of ['format', 'revision', 'preamble', 'version', 'command2']) {
      expect(() => buildGetCommandHelpRequest('show', { [key]: 1 } as never), key).toThrow(/unsupported getCommandHelp parameter/u)
    }
    expect(() => buildGetCommandHelpRequest(1 as unknown as string)).toThrow(/parameter 'command' must be a string/u)
  })

  it('accepts an empty command (the help for the current mode\'s keyword set) — refusals there would make a help panel useless', () => {
    expect(buildGetCommandHelpRequest('').params).toEqual({ command: '' })
  })
})

describe('buildMethodRequest — the generic pair form used by Transport#callMethod', () => {
  it('routes all three methods to their own validators', () => {
    expect(buildMethodRequest({ method: 'getCommandHelp', params: { command: 'show' } }, { id: '1' }).method).toBe('getCommandHelp')
    expect(buildMethodRequest({ method: 'getCommandCompletions', params: { command: 'show', preamble: [] } }, { id: '2' }).params).toEqual({ command: 'show', preamble: [] })
    expect(buildMethodRequest({ method: 'verifyConfig', params: { configList: ['vlan 20'] } }, { id: '3' }).params).toEqual({ configList: ['vlan 20'] })
  })

  it('refuses a missing required parameter before the wire, naming it (JsonRpcBase.py:290-293 answers -32602)', () => {
    expect(() => buildMethodRequest({ method: 'verifyConfig', params: {} } as unknown as WireMethodCall)).toThrow(/verifyConfig requires the 'configList' parameter/u)
    expect(() => buildMethodRequest({ method: 'getCommandHelp', params: {} } as unknown as WireMethodCall)).toThrow(/getCommandHelp requires the 'command' parameter/u)
    expect(() => buildMethodRequest({ method: 'getCommandCompletions', params: {} } as unknown as WireMethodCall)).toThrow(/getCommandCompletions requires the 'command' parameter/u)
    expect(() => buildMethodRequest({ method: 'verifyConfig', params: { configList: undefined } } as unknown as WireMethodCall)).toThrow(/configlet 0 must be a string/u)
  })

  it('refuses a parameter the method does not declare, even through the generic form', () => {
    expect(() => buildMethodRequest({ method: 'getCommandHelp', params: { command: 'show', preamble: ['x'] } } as unknown as WireMethodCall)).toThrow(/unsupported getCommandHelp parameter 'preamble'/u)
    expect(() => buildMethodRequest({ method: 'verifyConfig', params: { configList: ['vlan 20'], stopOnError: 'false' } } as unknown as WireMethodCall)).toThrow(/must be a boolean/u)
  })

  it('refuses a method outside the table rather than sending it (runCmds is not a method call)', () => {
    expect(() => buildMethodRequest({ method: 'runCmds', params: { cmds: ['show version'] } } as unknown as WireMethodCall)).toThrow(TypeError)
    expect(() => buildMethodRequest({ method: 'editConfig', params: { cmds: ['vlan 20'] } } as unknown as WireMethodCall)).toThrow(TypeError)
  })
})

describe('parseMethodResponse — the object-result gate (JsonRpcBase.py:160)', () => {
  it('accepts a single object result and keeps the echoed id', () => {
    const parsed = parseMethodResponse(COMPLETIONS_BODY, { method: 'getCommandCompletions' })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('unreachable')
    expect(parsed.envelope.jsonrpc).toBe('2.0')
    expect(parsed.envelope.id).toBe('unit-1')
    expect(Object.keys(parsed.envelope.result).sort()).toEqual(['complete', 'completions', 'errors'])
  })

  it('tolerates a body with no echoed id, exactly as parseResponse does', () => {
    const parsed = parseMethodResponse(JSON.stringify({ jsonrpc: '2.0', result: { show: 'Set show command' } }), { method: 'getCommandHelp' })
    if (!parsed.ok) throw new Error('expected a valid reply')
    expect('id' in parsed.envelope).toBe(false)
  })

  it('refuses an array result for an object-shaped method: this client will not guess which element answers (DR-032)', () => {
    const parsed = parseMethodResponse(JSON.stringify({ jsonrpc: '2.0', result: [{ show: 'Set show command' }], id: 'unit-1' }), { method: 'getCommandHelp', requestId: 'unit-1' })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error('expected a refusal')
    expect(parsed.error).toBeInstanceOf(ProtocolError)
    expect(parsed.error.message).toMatch(/must be a single JSON object, not an array/u)
    expect(parsed.error.code).toBe(EapiErrorCode.INVALID_REQUEST)
  })

  it('names a null/string/number result without printing the body as a shape', () => {
    for (const [value, name] of [['null', 'null'], ['"show"', 'a string'], ['7', 'a number']] as const) {
      const parsed = parseMethodResponse(`{"jsonrpc":"2.0","result":${value},"id":"x"}`, { method: 'getCommandHelp' })
      if (parsed.ok) throw new Error('expected a refusal')
      expect(parsed.error.message, value).toContain(`not ${name}`)
    }
  })

  it('shares the envelope rules with parseResponse instead of restingating them: bad JSON, non-object, wrong version, result+error', () => {
    const cases: readonly [string, RegExp][] = [
      ['{ "jsonrpc": "2.0", "result": {', /not valid JSON/u],
      ['[]', /must be a JSON object/u],
      ['{"jsonrpc":"1.0","result":{},"id":"x"}', /unsupported jsonrpc version/u],
      ['{"jsonrpc":"2.0","result":{},"error":{"code":1002,"message":"x"},"id":"x"}', /exactly one of result\/error/u],
      ['{"jsonrpc":"2.0","id":"x"}', /exactly one of result\/error/u],
    ]
    for (const [body, pattern] of cases) {
      const parsed = parseMethodResponse(body, { method: 'getCommandHelp' })
      if (parsed.ok) throw new Error('expected a refusal')
      expect(parsed.error, body).toBeInstanceOf(ProtocolError)
      expect(parsed.error.message, body).toMatch(pattern)
    }
  })

  it('returns an error envelope instead of throwing, with the typed error attached (PLAN M1: parsing never throws for a device failure)', () => {
    const body = JSON.stringify({ jsonrpc: '2.0', error: { code: EapiErrorCode.METHOD_NOT_FOUND, message: "Invalid 'method' specified: 'getCommandHelpx'" }, id: 'unit-9' })
    const parsed = parseMethodResponse(body, { method: 'getCommandHelp' })
    if (parsed.ok) throw new Error('expected a failure')
    expect(parsed.envelope?.error.code).toBe(EapiErrorCode.METHOD_NOT_FOUND)
    expect(parsed.error).toBeInstanceOf(CommandError)
    expect(parsed.error.requestId).toBe('unit-9')
  })

  it('applies pyeapi\'s -32602 decoration to a method failure too (eapilib.py:460-468)', () => {
    const body = JSON.stringify({ jsonrpc: '2.0', error: { code: EapiErrorCode.INTERNAL_ERROR, message: "getCommandHelp() got an unexpected keyword argument 'format'" }, id: 'u' })
    const parsed = parseMethodResponse(body, { method: 'getCommandHelp' })
    if (parsed.ok) throw new Error('expected a failure')
    expect(parsed.error.message).toMatch(/format parameter is not supported in this version of EOS\./u)
  })
})

describe('sendMethodRequest / runMethodRequest', () => {
  it('builds, sends and returns the typed reply for each method, keeping the request alongside it', async () => {
    const call: WireMethodCall = { method: 'getCommandHelp', params: { command: 'show' } }
    const wire = stubWire(HELP_BODY)
    const outcome = await sendMethodRequest(wire.sender, call, { id: 'unit-1' })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(wire.sent.map((request) => request.method)).toEqual(['getCommandHelp'])
    expect(outcome.request.params).toEqual({ command: 'show' })
    expect(outcome.result).toEqual({ show: 'Set show command', version: 'Display software version' })
  })

  it('routes verifyConfig through the array gate and the dict methods through the object gate', async () => {
    const wrongForVerify = await sendMethodRequest(stubWire(JSON.stringify({ jsonrpc: '2.0', result: { config: true }, id: 'a' })).sender, { method: 'verifyConfig', params: { configList: ['vlan 20'] } })
    expect(wrongForVerify.ok).toBe(false)
    if (wrongForVerify.ok) throw new Error('expected a refusal')
    expect(wrongForVerify.error.message).toMatch(/result must be an array of per-command objects/u)

    const wrongForHelp = await sendMethodRequest(stubWire(verifyConfigReply([{}, {}])).sender, { method: 'getCommandHelp', params: { command: 'show' } })
    expect(wrongForHelp.ok).toBe(false)
    if (wrongForHelp.ok) throw new Error('expected a refusal')
    expect(wrongForHelp.error.message).toMatch(/must be a single JSON object, not an array/u)
  })

  it('accepts a well-formed verifyConfig reply as the per-command array it is', async () => {
    const body = verifyConfigReply([{ copy: {}, show: { outputInline: ['vlan 20'] } }, { copy: {}, show: { outputInline: ['vlan 20', 'vlan 30'] } }])
    const outcome = await sendMethodRequest(stubWire(body).sender, { method: 'verifyConfig', params: { configList: ['vlan 20', 'vlan 30'] } }, { id: 'unit-1' })
    if (!outcome.ok) throw new Error('expected success')
    expect(outcome.result).toHaveLength(4)
    expect((outcome.result as readonly CommandResult[])[3]).toEqual({ outputInline: ['vlan 20', 'vlan 30'] })
  })

  it('has no tolerateErrors repair: no command list to re-issue, so a 1003 answer comes back as the error and exactly one request goes out (DR-012/DR-050)', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', error: { code: EapiErrorCode.COMMAND_UNCONVERTED, message: 'Cannot convert command', data: [{}] }, id: 'unit-1' })
    const wire = stubWire(body)
    const outcome = await sendMethodRequest(wire.sender, { method: 'verifyConfig', params: { configList: ['show tech-support'] } }, { ids: createRequestIds({ seed: 'aa' }) })
    expect(outcome.ok).toBe(false)
    expect(wire.sent).toHaveLength(1)
    if (outcome.ok) throw new Error('expected a failure')
    expect(outcome.error).toBeInstanceOf(CommandError)
    expect(outcome.error.code).toBe(EapiErrorCode.COMMAND_UNCONVERTED)
  })

  it('carries the failure through runMethodRequest as the same typed error', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', error: { code: EapiErrorCode.COMMAND_UNAUTHORIZED, message: 'CLI privilege is insufficient' }, id: 'x-1' })
    const outcome = await sendMethodRequest(stubWire(body).sender, { method: 'getCommandCompletions', params: { command: 'show' } }, { id: 'x-1' })
    if (outcome.ok) throw new Error('expected a failure')
    expect(outcome.error.code).toBe(EapiErrorCode.COMMAND_UNAUTHORIZED)
    await expect(runMethodRequest(stubWire(body).sender, { method: 'getCommandCompletions', params: { command: 'show' } }, { id: 'x-1' })).rejects.toBeInstanceOf(CommandError)
  })

  it('attaches the configlets to a method failure, redacted — a configlet is CLI text and routinely holds a secret (DR-011)', async () => {
    const configList = ['username admin secret plain Sup3rPhr4se', 'vlan 20']
    const body = JSON.stringify({ jsonrpc: '2.0', error: { code: EapiErrorCode.COMMAND_INVALID, message: "CLI command 1 of 2 'copy terminal: session-config' failed: % Invalid input", data: [{}] }, id: 'x-2' })
    const outcome = await sendMethodRequest(stubWire(body).sender, { method: 'verifyConfig', params: { configList } }, { id: 'x-2' })
    if (outcome.ok) throw new Error('expected a failure')
    expect(outcome.error.commands).toEqual(['username admin secret plain <redacted>', 'vlan 20'])
    expect(outcome.error.message).not.toContain('Sup3rPhr4se')
    expect(JSON.stringify(outcome.error)).not.toContain('Sup3rPhr4se')
  })

  it('attaches the half-typed line for the command methods, so an operator sees what they were typing', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', error: { code: EapiErrorCode.COMMAND_INVALID, message: 'nope' }, id: 'x-3' })
    const outcome = await sendMethodRequest(stubWire(body).sender, { method: 'getCommandCompletions', params: { command: 'copy running-config startup-config' } }, { id: 'x-3' })
    if (outcome.ok) throw new Error('expected a failure')
    expect(outcome.error.commands).toEqual(['copy running-config startup-config'])
  })

  it('refuses locally with zero round trips when a caller hands it a bad parameter', async () => {
    const wire = stubWire('never')
    await expect(sendMethodRequest(wire.sender, { method: 'getCommandHelp', params: { command: 1 } } as unknown as WireMethodCall)).rejects.toBeInstanceOf(TypeError)
    expect(wire.sent).toEqual([])
    await expect(runMethodRequest(NEVER_ANSWERED, { method: 'verifyConfig', params: { configList: [] } })).rejects.toBeInstanceOf(TypeError)
    await expect(runMethodRequest(NEVER_ANSWERED, { method: 'getCommandCompletions', params: { command: 'sh', preamble: ['a\nb'] } })).rejects.toBeInstanceOf(NotSupportedError)
  })

  it('stamps ids from the policy the transport owns, monotonically across methods', async () => {
    const ids = createRequestIds({ seed: 'ffff', start: 9 })
    const wire = stubWire(HELP_BODY)
    await sendMethodRequest(wire.sender, { method: 'getCommandHelp', params: { command: 'show' } }, { ids })
    await sendMethodRequest(wire.sender, { method: 'getCommandHelp', params: { command: 'show version' } }, { ids })
    expect(wire.sent.map((request) => request.id)).toEqual(['ffff-10', 'ffff-11'])
  })
})
