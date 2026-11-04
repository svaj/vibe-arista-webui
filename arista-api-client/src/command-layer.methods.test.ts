/**
 * `Node`'s M11 (#13) method verbs — `verifyConfig`, `getCompletions`, `getCommandHelp` — driven offline
 * through `MockTransport`'s method script (`docs/TESTING.md` §3). No device, no container, no cEOS.
 *
 * ## Upstream port ledger: **zero rows**
 *
 * pyeapi has no twin for any of this. In the pinned clone (`develop` `6816d9e`),
 * `grep -rn "verifyConfig\|getCommandCompletions\|getCommandHelp" pyeapi/pyeapi/` matches nothing:
 * `eapilib.HttpTransport` builds a `runCmds` body and only that body (`eapilib.py:326-327`, `:362`), so
 * there is no upstream request to compare ids against and no upstream expectation this file could
 * inherit. Every case below is **new surface**, in the three kinds the M11 brief allows:
 *
 *  - **(a) the exact request body we send** — verified, because those bytes are ours;
 *  - **(b) our parse of a hand-authored envelope**, marked `SYNTHETIC` at each use. The shapes come from
 *    the server's return statements for **EOS 4.28.13.1M** (`JsonCli.py:188-192` completions,
 *    `:321-326` verifyConfig, `CliApi.py:442-462` help), *not* from a capture; the values inside them are
 *    invented stand-ins. The M12 (#14) capture replaces them, so each of these tests pins *our parse*,
 *    never *EOS's prose*;
 *  - **(c) refusals** — local rules (DR-016 allow-list, DR-032, DR-011 redaction), each asserting **zero**
 *    round trips.
 *
 * Two facts from the vendor Python are load-bearing and get their own tests below: the two dict-returning
 * methods answer with a `result` **object** while `verifyConfig` answers with a per-command **array**
 * (`JsonRpcBase.py:160`), and `verifyConfig`'s server-side `enable` carries no password
 * (`JsonCli.py:296`), so an `enablePassword` on the `Node` must not appear anywhere in the body.
 */

import { describe, expect, it } from 'vitest'

import {
  Node,
  parseCommandCompletions,
  parseCommandHelp,
  parseVerifyConfigReply,
  type CommandCompletions,
  type CommandHelp,
  type VerifyConfigOutcome,
} from './command-layer'
import { AuthError, CommandError, ConnectError, EapiErrorCode, NotSupportedError, ProtocolError } from './errors'
import { mockTransport, type MockReply, type MockTransport } from './testing/mock-transport'
import type { Transport } from './transports/contract'
import type { CommandResult, CommandSpec, JsonRpcRequest } from './types/eapi'

const ADDRESS = 'https://sw1.lan:443/command-api'

function scripted(seed = 'm11'): MockTransport {
  return mockTransport({ address: ADDRESS, seed })
}

function nodeFor(transport: MockTransport): Node {
  return new Node(transport)
}

/** Recovers a rejection, typed — the verbs are `async`, so even a guard refusal arrives as a rejection. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => undefined,
    (error: unknown) => error,
  )
}

/** `params` is a per-method union, so a test reads it as data rather than pretending to know the method. */
function paramsOf(t: MockTransport, index = 0): Record<string, unknown> {
  const call = t.methodCalls()[index]
  if (call === undefined) throw new Error('expected a method call to have been sent')
  return call.params as unknown as Record<string, unknown>
}

/** A scripted **object** `result`, which `MockReply` only produces through its `result` key. */
function objectResult(result: Record<string, unknown>): MockReply {
  return { result }
}

/** A `Transport` from before #13: `execute`/`close` only, no `callMethod` member at all. */
function legacyTransport(): { readonly transport: Transport; readonly calls: readonly (readonly CommandSpec[])[] } {
  const calls: (readonly CommandSpec[])[] = []
  const transport: Transport = {
    kind: 'mock',
    address: ADDRESS,
    async execute(commands) {
      calls.push(Array.isArray(commands) ? [...commands] : [commands])
      // `SendRequestResult` carries the request it sent (M1 wire.ts); a stand-in suffices — the two
      // uses of this helper only count `execute` calls, never the reply.
      const request: JsonRpcRequest = { jsonrpc: '2.0', method: 'runCmds', id: 'legacy-1', params: { version: 1, format: 'json', cmds: [] } }
      return { ok: true, request, result: [], encoding: 'json', viaTextRetry: false }
    },
    close: () => Promise.resolve(),
    toString: () => ADDRESS,
  }
  return { transport, calls }
}

/** SYNTHETIC (`JsonCli.py:306-321`): `copy terminal: session-config` then `show session-config`, per configlet. */
const VERIFY_JSON_RESULT: readonly CommandResult[] = [
  {},
  { source: 'session-config', outputInline: ['vlan 20', '   name WEB'] },
  {},
  { source: 'session-config', outputInline: ['vlan 20', '   name WEB', 'vlan 30', '   name EAST'] },
]

/** The same answer in `format: 'text'`, where each `show` reply is `{output}`. */
const VERIFY_TEXT_RESULT: readonly CommandResult[] = [{ output: 'banner motd\n' }, { output: 'vlan 20\n   name WEB\n' }, { output: 'vlan 20\n' }, { output: 'vlan 20\nvlan 30\n' }]

describe('Node.verifyConfig — the request we send (a: verified)', () => {
  it('sends one verifyConfig method call and no runCmds request at all', async () => {
    const t = scripted().methodReplies('verifyConfig', VERIFY_JSON_RESULT)
    await nodeFor(t).verifyConfig('vlan 20\n name WEB')
    expect(t.sent()).toEqual([])
    expect(t.bodies()).toEqual([])
    expect(t.methodCalls()).toEqual([{ jsonrpc: '2.0', method: 'verifyConfig', id: 'm11-1', params: { configList: ['vlan 20\n name WEB'] } }])
  })

  it('keeps the configlet order, because reply positions are paired by that order (JsonCli.py:307-311)', async () => {
    const configlets = ['vlan 20', 'vlan 30', 'vlan 40']
    const t = scripted().methodReplies('verifyConfig', Array.from({ length: 6 }, () => ({}) as CommandResult))
    await nodeFor(t).verifyConfig(configlets)
    expect(paramsOf(t).configList).toEqual(configlets)
  })

  it("sends only the parameters the caller chose; the server defaults stay the server's", async () => {
    const t = scripted().methodReplies('verifyConfig', VERIFY_JSON_RESULT)
    await nodeFor(t).verifyConfig(['vlan 20'], { format: 'text', timestamps: true, stopOnError: false, version: 1 })
    expect(paramsOf(t)).toEqual({ configList: ['vlan 20'], format: 'text', timestamps: true, stopOnError: false, version: 1 })
  })

  it('carries no enable command and no enable password: the method runs its own bare `enable` (JsonCli.py:296)', async () => {
    const t = scripted().methodReplies('verifyConfig', VERIFY_JSON_RESULT)
    await new Node(t, { enablePassword: 'Sup3rEnablePwd' }).verifyConfig(['vlan 20'])
    const body = JSON.stringify(t.methodCalls())
    expect(body).not.toContain('Sup3rEnablePwd')
    expect(body).not.toMatch(/enable/iu)
    expect(t.sent()).toEqual([])
  })

  it('sends the configlet verbatim and redacts only on the error path (DR-011 is a logging rule, never a wire change)', async () => {
    const t = scripted().methodReplies('verifyConfig', VERIFY_JSON_RESULT)
    await nodeFor(t).verifyConfig(['username admin secret plain abc123'])
    expect(paramsOf(t).configList).toEqual(['username admin secret plain abc123'])
    expect(t.methodCalls()[0]).not.toHaveProperty('enablePassword')
  })

  it('shares the connection id policy with runCmds, so no two requests on one transport collide (DR-017)', async () => {
    const t = scripted('ids')
      .replies('enable\nshow version', [{}, { version: '4.28.13.1M' }])
      .methodReplies('verifyConfig', VERIFY_JSON_RESULT)
      .methodReplies('getCommandHelp', objectResult({ show: 'Set show command' }))
    const node = nodeFor(t)
    await node.runCommands('show version')
    await node.verifyConfig(['vlan 20'])
    await node.getCommandHelp('show')
    expect(t.bodies()[0]?.id).toBe('ids-1')
    expect(t.methodCalls().map((call) => call.id)).toEqual(['ids-2', 'ids-3'])
  })
})

describe('Node.verifyConfig — our parse of a synthetic reply (b: needs the M12 capture)', () => {
  it('pairs each configlet with its copy reply and the aggregated session-config after it', async () => {
    const t = scripted().methodReplies('verifyConfig', VERIFY_JSON_RESULT)
    const outcome = await nodeFor(t).verifyConfig(['vlan 20\n name WEB', 'vlan 30\n name EAST'])
    expect(outcome.format).toBe('json')
    expect(outcome.entries).toHaveLength(2)
    expect(outcome.entries[0]).toEqual({ index: 0, configlet: 'vlan 20\n name WEB', copyReply: {}, sessionConfig: VERIFY_JSON_RESULT[1] })
    expect(outcome.entries[1]?.sessionConfig).toEqual(VERIFY_JSON_RESULT[3])
    expect(outcome.unmatched).toEqual([])
    expect(outcome.raw).toEqual(VERIFY_JSON_RESULT)
  })

  it('reports the normalised text answer as sessionConfigText without inventing a model for the json one', async () => {
    const t = scripted().methodReplies('verifyConfig', VERIFY_TEXT_RESULT)
    const outcome = await nodeFor(t).verifyConfig(['vlan 20', 'vlan 30'], { format: 'text' })
    expect(outcome.format).toBe('text')
    expect(outcome.entries[0]?.sessionConfigText).toBe('vlan 20\n   name WEB\n')
    expect(outcome.entries[1]?.sessionConfigText).toBe('vlan 20\nvlan 30\n')
  })

  it('reports reply objects beyond the last pair as `unmatched` instead of trimming them (PLAN: nothing is dropped)', async () => {
    const extra = [...VERIFY_JSON_RESULT, { outputInline: ['! extra'] }]
    const t = scripted().methodReplies('verifyConfig', extra)
    const outcome = await nodeFor(t).verifyConfig(['vlan 20', 'vlan 30'])
    expect(outcome.unmatched).toEqual([{ outputInline: ['! extra'] }])
    expect(outcome.entries).toHaveLength(2)
  })

  it('leaves the later fields absent, not empty, when the device answers fewer commands than it was given', async () => {
    const t = scripted().methodReplies('verifyConfig', [{}, { outputInline: ['vlan 20'] }, {}])
    const outcome = await nodeFor(t).verifyConfig(['vlan 20', 'vlan 30'])
    expect(outcome.entries[1]).toEqual({ index: 1, configlet: 'vlan 30', copyReply: {} })
    expect('sessionConfig' in (outcome.entries[1] ?? {})).toBe(false)
    expect('sessionConfigText' in (outcome.entries[1] ?? {})).toBe(false)
    expect(outcome.unmatched).toEqual([])
  })

  it('a device error envelope comes back as the typed CommandError, with the configlets redacted (DR-011)', async () => {
    const t = scripted().methodRejects('verifyConfig', {
      code: EapiErrorCode.COMMAND_INVALID,
      message: "CLI command 1 of 3 'copy terminal: session-config' failed: % Invalid input",
      data: [{}, {}, {}],
    })
    const error = (await rejection(nodeFor(t).verifyConfig(['username admin secret plain Sec3ret', 'vlan 20']))) as CommandError
    expect(error).toBeInstanceOf(CommandError)
    expect(error.code).toBe(EapiErrorCode.COMMAND_INVALID)
    expect(error.commands).toEqual(['username admin secret plain <redacted>', 'vlan 20'])
    expect(error.message).not.toContain('Sec3ret')
    expect(error.results).toHaveLength(3)
  })

  it('a non-priv-15 API user gets the privilege failure rather than a silent upgrade (1005 is never read as a clean preview)', async () => {
    const t = scripted().methodRejects('verifyConfig', { code: EapiErrorCode.COMMAND_UNAUTHORIZED, message: 'CLI privilege is insufficient for the command' })
    const error = (await rejection(nodeFor(t).verifyConfig(['vlan 20']))) as CommandError
    expect(error.code).toBe(EapiErrorCode.COMMAND_UNAUTHORIZED)
    expect(error.name).toBe('CommandError')
  })

  it('refuses the wrong result shape in the other direction: an object result for verifyConfig is a ProtocolError, not an empty preview', async () => {
    const t = scripted().methodReplies('verifyConfig', '{ "jsonrpc": "2.0", "result": { "unexpected": true } }')
    const error = (await rejection(nodeFor(t).verifyConfig(['vlan 20']))) as ProtocolError
    expect(error).toBeInstanceOf(ProtocolError)
    expect(error.message).toMatch(/result must be an array of per-command objects/u)
  })

  it("refuses a body that is not JSON as a parse failure with the raw text attached (a proxy's 502 page is not a preview)", async () => {
    const t = scripted().methodReplies('verifyConfig', '<html><body>502 Bad Gateway</body></html>')
    const error = (await rejection(nodeFor(t).verifyConfig(['vlan 20']))) as ProtocolError
    expect(error).toBeInstanceOf(ProtocolError)
    expect(error.message).toMatch(/not valid JSON/u)
    expect(error.rawBody).toContain('502 Bad Gateway')
  })
})

describe('Node.verifyConfig — refusals at zero round trips (c)', () => {
  it('refuses an empty configlet list without sending a byte (our rule: a blank screen is not a clean answer)', async () => {
    const t = scripted()
    expect(await rejection(nodeFor(t).verifyConfig([]))).toBeInstanceOf(TypeError)
    expect(t.callCount()).toBe(0)
    expect(t.methodCalls()).toEqual([])
  })

  it('refuses an empty or non-string configlet, which the server would put in a command object input (JsonCli.py:36-39)', async () => {
    const t = scripted()
    expect(await rejection(nodeFor(t).verifyConfig([{ cmd: 'vlan 20' } as unknown as string]))).toBeInstanceOf(TypeError)
    expect(await rejection(nodeFor(t).verifyConfig(['']))).toBeInstanceOf(TypeError)
    expect(await rejection(nodeFor(t).verifyConfig(['vlan 20', 42 as unknown as string]))).toBeInstanceOf(TypeError)
    expect(t.methodCalls()).toEqual([])
  })

  it('refuses every parameter the method does not declare, including the runCmds-shaped temptations', async () => {
    const t = scripted()
    for (const key of ['sendEnable', 'sessionName', 'cmds', 'includeErrorDetail', 'autoComplete', 'requestTimeout']) {
      const options = { [key]: 'x' } as never
      const error = await rejection(nodeFor(t).verifyConfig(['vlan 20'], options))
      expect(error, key).toBeInstanceOf(NotSupportedError)
      expect((error as Error).message, key).toContain(`unsupported verifyConfig parameter '${key}'`)
    }
    expect(t.methodCalls()).toEqual([])
    expect(t.callCount()).toBe(0)
  })

  it('refuses a bad encoding/version/flag type before the wire, with the same allow-lists runCmds uses', async () => {
    const t = scripted()
    expect(await rejection(nodeFor(t).verifyConfig(['vlan 20'], { format: 'xml' as unknown as 'json' }))).toBeInstanceOf(TypeError)
    expect(await rejection(nodeFor(t).verifyConfig(['vlan 20'], { version: 2 as unknown as 1 }))).toBeInstanceOf(TypeError)
    expect(await rejection(nodeFor(t).verifyConfig(['vlan 20'], { timestamps: 'true' as unknown as boolean }))).toBeInstanceOf(TypeError)
    expect(t.methodCalls()).toEqual([])
  })

  it('refuses with NotSupportedError when the transport predates the M11 seam, naming the member to add', async () => {
    const legacy = legacyTransport()
    const node = new Node(legacy.transport)
    for (const verb of [node.verifyConfig(['vlan 20']), node.getCompletions('sh'), node.getCommandHelp('show')]) {
      const error = await rejection(verb)
      expect(error).toBeInstanceOf(NotSupportedError)
      expect((error as Error).message).toMatch(/does not implement Transport#callMethod/u)
    }
    expect(legacy.calls).toEqual([])
  })

  it('does not fake the call with runCmds: a configlet sent as a command batch would be applied, not previewed', async () => {
    const legacy = legacyTransport()
    await rejection(new Node(legacy.transport).verifyConfig(['vlan 999\n name NOPE']))
    expect(legacy.calls).toEqual([])
  })

  it('accepts the transport knobs (timeoutMs/signal/readOnly) without forwarding them as method parameters', async () => {
    const t = scripted().methodReplies('verifyConfig', VERIFY_JSON_RESULT)
    const controller = new AbortController()
    const outcome = await nodeFor(t).verifyConfig(['vlan 20'], { timeoutMs: 5_000, readOnly: true, signal: controller.signal })
    expect(outcome.entries).toHaveLength(1)
    expect(outcome.entries[0]?.configlet).toBe('vlan 20')
    expect(outcome.unmatched).toHaveLength(2)
    expect(Object.keys(paramsOf(t))).toEqual(['configList'])
  })
})

describe('Node.getCompletions — request, parse, refusal', () => {
  /** SYNTHETIC (`JsonCli.py:188-192`). */
  const COMPLETIONS_RESULT: Record<string, unknown> = { errors: {}, complete: false, completions: { show: 'Set show command', copy: 'Copy from one file to another' } }

  it('sends getCommandCompletions with the partial line and no cmds (a)', async () => {
    const t = scripted().methodReplies('getCommandCompletions', objectResult(COMPLETIONS_RESULT))
    const view = await nodeFor(t).getCompletions('sh')
    expect(t.methodCalls()[0]).toEqual({ jsonrpc: '2.0', method: 'getCommandCompletions', id: 'm11-1', params: { command: 'sh' } })
    expect(view.complete).toBe(false)
    expect(view.completions).toEqual([
      { name: 'show', help: 'Set show command' },
      { name: 'copy', help: 'Copy from one file to another' },
    ])
    expect(view.errors).toEqual({})
    expect(view.extra).toEqual({})
    expect(view.unparsed).toEqual([])
  })

  it('completes the empty line, which is how a UI asks what a mode accepts at all (a/b)', async () => {
    const t = scripted().methodReplies('getCommandCompletions', objectResult({ errors: {}, complete: false, completions: { enable: 'Configure from terminal mode' } }))
    const view = await nodeFor(t).getCompletions('')
    expect(t.methodCalls()[0]?.params).toEqual({ command: '' })
    expect(view.completions).toEqual([{ name: 'enable', help: 'Configure from terminal mode' }])
  })

  it('sends the preamble as a list the device executes — a command list in disguise, not a hint (a; CliApi.py:656-668)', async () => {
    const t = scripted().methodReplies('getCommandCompletions', objectResult({ errors: {}, complete: true, completions: { description: 'Specific interface description' } }))
    const view = await nodeFor(t).getCompletions('desc', { preamble: ['interface Ethernet1'] })
    expect(paramsOf(t)).toEqual({ command: 'desc', preamble: ['interface Ethernet1'] })
    expect(view.complete).toBe(true)
  })

  it("passes a preamble rejection through as the device's own `errors` member instead of inventing a verdict (b)", async () => {
    const t = scripted().methodReplies('getCommandCompletions', objectResult({ errors: { error: ['% Invalid input'] }, complete: false, completions: {} }))
    const view = await nodeFor(t).getCompletions('vlan', { preamble: ['interface Ethernet1', 'no switchport'] })
    expect(view.errors).toEqual({ error: ['% Invalid input'] })
    expect(view.completions).toEqual([])
  })

  it('keeps a reply member we do not model in `extra` rather than dropping it (b: PLAN, unknown fields survive)', async () => {
    const t = scripted().methodReplies('getCommandCompletions', objectResult({ errors: {}, complete: false, completions: { show: 'Set show command' }, eosVersion: '4.28.13.1M' }))
    const view = await nodeFor(t).getCompletions('sh')
    expect(view.extra).toEqual({ eosVersion: '4.28.13.1M' })
    expect(view.raw['complete']).toBe(false)
    expect(view.raw['eosVersion']).toBe('4.28.13.1M')
  })

  it('names a completion whose help is not a string instead of softening it to empty text (b)', async () => {
    const t = scripted().methodReplies('getCommandCompletions', objectResult({ errors: {}, complete: false, completions: { show: 'Set show command', version: 4, aaa: null } }))
    const view = await nodeFor(t).getCompletions('sh')
    expect(view.completions).toEqual([{ name: 'show', help: 'Set show command' }])
    expect(view.unparsed).toEqual(['version', 'aaa'])
  })

  it('leaves `complete` absent when the reply does not answer a boolean — "complete" and "cannot tell" are different answers', async () => {
    const t = scripted().methodReplies('getCommandCompletions', objectResult({ errors: {}, complete: 'maybe', completions: {} }))
    const view = await nodeFor(t).getCompletions('sh')
    expect('complete' in view).toBe(false)
    expect(view.completions).toEqual([])
  })

  it('refuses a reply with no completions object rather than reporting an empty command set (DR-032)', async () => {
    for (const bad of [{ errors: {}, complete: false }, { completions: [] }, { completions: 'show' }, { completions: null }]) {
      const t = scripted().methodReplies('getCommandCompletions', objectResult(bad))
      const error = (await rejection(nodeFor(t).getCompletions('sh'))) as ProtocolError
      expect(error, JSON.stringify(bad)).toBeInstanceOf(ProtocolError)
      expect(error.message, JSON.stringify(bad)).toMatch(/has no 'completions' object/u)
    }
  })

  it('refuses the object/array gate mismatch: an array result for a dict method is a ProtocolError (JsonRpcBase.py:160)', async () => {
    const t = scripted().methodReplies('getCommandCompletions', [{ completions: {} }])
    expect(await rejection(nodeFor(t).getCompletions('sh'))).toBeInstanceOf(ProtocolError)
  })

  it('refuses a preamble that could end its own CLI line, at zero round trips (c)', async () => {
    const t = scripted()
    expect(await rejection(nodeFor(t).getCompletions('sh', { preamble: ['interface Ethernet1\nabort'] }))).toBeInstanceOf(NotSupportedError)
    expect(await rejection(nodeFor(t).getCompletions('sh', { preamble: [''] }))).toBeInstanceOf(TypeError)
    expect(await rejection(nodeFor(t).getCompletions('sh', { preamble: 'interface Ethernet1' as unknown as readonly string[] }))).toBeInstanceOf(TypeError)
    expect(await rejection(nodeFor(t).getCompletions(1 as unknown as string))).toBeInstanceOf(TypeError)
    expect(t.methodCalls()).toEqual([])
    expect(t.callCount()).toBe(0)
  })

  it('refuses undeclared parameters, including the ones runCmds would have accepted (c; DR-016)', async () => {
    const t = scripted()
    for (const key of ['format', 'version', 'timestamps', 'cmds', 'sendEnable', 'preambles']) {
      expect(await rejection(nodeFor(t).getCompletions('sh', { [key]: 1 } as never)), key).toBeInstanceOf(NotSupportedError)
    }
    expect(t.methodCalls()).toEqual([])
  })

  it("surfaces a device 1005 as an answer about the caller's privilege, never as an empty command set", async () => {
    const t = scripted().methodRejects('getCommandCompletions', { code: EapiErrorCode.COMMAND_UNAUTHORIZED, message: '% Permission denied' })
    const error = (await rejection(nodeFor(t).getCompletions('configure terminal'))) as CommandError
    expect(error.code).toBe(EapiErrorCode.COMMAND_UNAUTHORIZED)
    expect(error.commands).toEqual(['configure terminal'])
  })
})

describe('Node.getCommandHelp — request, parse, refusal', () => {
  /** SYNTHETIC (`CliApi.py:442-462`, the flat `{name: help}` comprehension at `:452`). */
  const HELP_RESULT: Record<string, unknown> = { show: 'Set show command', version: 'Display software version information' }

  it('sends getCommandHelp with exactly one parameter (a)', async () => {
    const t = scripted().methodReplies('getCommandHelp', objectResult(HELP_RESULT))
    const help = await nodeFor(t).getCommandHelp('show version')
    expect(t.methodCalls()[0]).toEqual({ jsonrpc: '2.0', method: 'getCommandHelp', id: 'm11-1', params: { command: 'show version' } })
    expect(help.entries).toEqual([
      { token: 'show', help: 'Set show command' },
      { token: 'version', help: 'Display software version information' },
    ])
    expect(help.byToken['version']).toBe('Display software version information')
    expect(help.unparsed).toEqual([])
    expect(help.raw).toEqual(HELP_RESULT)
  })

  it('treats an empty help object as a real answer, not a protocol violation (b)', async () => {
    const t = scripted().methodReplies('getCommandHelp', objectResult({}))
    const help = await nodeFor(t).getCommandHelp('show nodethatdoesnotexist')
    expect(help.entries).toEqual([])
    expect(help.byToken).toEqual({})
    expect(help.unparsed).toEqual([])
  })

  it('reports a non-string help value (the CLI assigns a guard code for some commands, CliApi.py:650) as unparsed (b)', async () => {
    const t = scripted().methodReplies('getCommandHelp', objectResult({ show: 'Set show command', aaa: -1, nested: { a: 1 } }))
    const help = await nodeFor(t).getCommandHelp('show')
    expect(help.entries).toEqual([{ token: 'show', help: 'Set show command' }])
    expect(help.unparsed).toEqual(['aaa', 'nested'])
    expect(help.byToken['aaa']).toBeUndefined()
  })

  it('refuses an unknown parameter through Node too — the generic call form cannot smuggle one past the allow-list (c)', async () => {
    const t = scripted()
    expect(await rejection(nodeFor(t).getCommandHelp('show', { format: 'text' } as never))).toBeInstanceOf(NotSupportedError)
    expect(await rejection(nodeFor(t).getCommandHelp('show', { preamble: ['interface Ethernet1'] } as never))).toBeInstanceOf(NotSupportedError)
    expect(await rejection(nodeFor(t).getCommandHelp(3 as unknown as string))).toBeInstanceOf(TypeError)
    expect(t.methodCalls()).toEqual([])
    expect(t.callCount()).toBe(0)
  })

  it('refuses an array result for this dict-returning method instead of guessing the first element (JsonRpcBase.py:160)', async () => {
    const t = scripted().methodReplies('getCommandHelp', [{ show: 'Set show command' }])
    const error = (await rejection(nodeFor(t).getCommandHelp('show'))) as ProtocolError
    expect(error.message).toMatch(/must be a single JSON object, not an array/u)
  })

  it('keeps the partial line on the error for a help request, redacted like everything else (DR-011)', async () => {
    const t = scripted().methodRejects('getCommandHelp', { code: EapiErrorCode.COMMAND_INVALID, message: '% Invalid input' })
    const error = (await rejection(nodeFor(t).getCommandHelp('username admin secret plain TopSecret'))) as CommandError
    expect(error.commands).toEqual(['username admin secret plain <redacted>'])
  })
})

describe('wire-level failures reach the method calls too (DR-013 status mapping)', () => {
  it('a 401 on a method call is the same AuthError a runCmds 401 produces, with no invented command list', async () => {
    const t = scripted().httpStatus(401)
    const error = await rejection(nodeFor(t).getCommandHelp('show'))
    expect(error).toBeInstanceOf(AuthError)
    expect((error as AuthError).status).toBe(401)
    expect((error as AuthError).commands).toEqual([])
    expect((error as AuthError).endpoint).toBe(ADDRESS)
  })

  it('a connection refusal is a ConnectError naming the endpoint, not a parse failure (DR-019 taxonomy)', async () => {
    const t = scripted().connectFailure()
    const error = (await rejection(nodeFor(t).verifyConfig(['vlan 20']))) as ConnectError
    expect(error).toBeInstanceOf(ConnectError)
    expect(error.retryable).toBe(true)
  })
})

describe('the pure pairing helpers (the part worth pinning without a transport)', () => {
  it('parseVerifyConfigReply pairs by the 2i / 2i+1 rule and defaults the format to json', () => {
    const outcome: VerifyConfigOutcome = parseVerifyConfigReply(VERIFY_JSON_RESULT, { configList: ['a', 'b'] })
    expect(outcome.format).toBe('json')
    expect(outcome.entries.map((entry) => entry.index)).toEqual([0, 1])
    expect(outcome.entries[1]?.configlet).toBe('b')
    expect(outcome.entries[1]?.sessionConfig).toBe(VERIFY_JSON_RESULT[3])
  })

  it('parseVerifyConfigReply with zero replies still answers one entry per configlet, all fields absent', () => {
    const outcome = parseVerifyConfigReply([], { configList: ['a'], format: 'text' })
    expect(outcome.entries).toEqual([{ index: 0, configlet: 'a' }])
    expect(outcome.raw).toEqual([])
    expect(outcome.unmatched).toEqual([])
  })

  it('parseCommandCompletions throws ProtocolError rather than inventing an empty list', () => {
    expect(() => parseCommandCompletions({})).toThrow(ProtocolError)
    expect(() => parseCommandCompletions({ completions: { show: 'x' } })).not.toThrow()
  })

  it('parseCommandHelp keeps device order in entries while byToken is a lookup', () => {
    const help: CommandHelp = parseCommandHelp({ zzz: 'Last keyword', aaa: 'First keyword' })
    expect(help.entries.map((entry) => entry.token)).toEqual(['zzz', 'aaa'])
    expect(Object.keys(help.byToken).sort()).toEqual(['aaa', 'zzz'])
  })

  it('the method view never leaks a half-typed completion list: a CommandCompletions always carries completions', async () => {
    const t = scripted().methodReplies('getCommandCompletions', objectResult({ complete: false, completions: {} }))
    const view: CommandCompletions = await nodeFor(t).getCompletions('sh xq')
    expect(view.completions).toEqual([])
    expect('errors' in view).toBe(false)
  })
})
