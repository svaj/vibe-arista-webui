/**
 * Error taxonomy — M1 (#3). Includes the port of pyeapi `TestCommandError`
 * (`test/unit/test_eapilib.py::test_create_command_error`, `::test_command_error_trace`) and the
 * class/`toJSON` contract `docs/USAGE.md` §7 promises the webui.
 */

import { describe, expect, it } from 'vitest'

import {
  AuthError,
  CommandError,
  ConnectError,
  EapiError,
  EapiErrorCode,
  eapiErrorName,
  NotSupportedError,
  ProtocolError,
  renderCommandError,
  SessionError,
  TimeoutError,
  TlsError,
  TransportError,
} from './errors'

describe('the code map is data, not an enum (DR-010)', () => {
  it('contains exactly the JSON-RPC spec codes and 1000-1006', () => {
    expect(Object.entries(EapiErrorCode)).toEqual([
      ['PARSE_ERROR', -32700],
      ['INVALID_REQUEST', -32600],
      ['METHOD_NOT_FOUND', -32601],
      ['INVALID_PARAMS', -32602],
      ['INTERNAL_ERROR', -32603],
      ['COMMAND_FAILED', 1000],
      ['COMMAND_EXCEPTION', 1001],
      ['COMMAND_INVALID', 1002],
      ['COMMAND_UNCONVERTED', 1003],
      ['COMMAND_INCOMPATIBLE', 1004],
      ['COMMAND_UNAUTHORIZED', 1005],
      ['COMMAND_CONFIG_LOCKED', 1006],
    ])
  })

  it('is frozen, so a consumer cannot reassign a code at runtime', () => {
    expect(Object.isFrozen(EapiErrorCode)).toBe(true)
    const mutable = EapiErrorCode as Record<string, number>
    expect(() => {
      'use strict'
      mutable.COMMAND_FAILED = 1
    }).toThrow(TypeError)
  })

  it('names a code symbolically, and says so when it does not recognise one', () => {
    expect(eapiErrorName(1003)).toBe('COMMAND_UNCONVERTED')
    expect(eapiErrorName(-32602)).toBe('INVALID_PARAMS')
    expect(eapiErrorName(9999)).toBe('unknown (9999)')
  })
})

describe('renderCommandError — pyeapi message format parity', () => {
  for (const code of [1000, 1001, 1002, 1004]) {
    it(`${code} keeps the [commandError] suffix`, () => {
      expect(renderCommandError(code, 'boom', "errors: ['x']")).toBe(`Error [${code}]: boom [errors: ['x']]`)
    })
  }

  for (const code of [1003, 1005, 1006, -32700, -32600, -32601, -32602, -32603, 9999]) {
    it(`${code} never renders the suffix`, () => {
      expect(renderCommandError(code, 'boom', "errors: ['x']")).toBe(`Error [${code}]: boom`)
    })
  }

  it('drops the brackets when the envelope carried no error.data (pyeapi prints None instead)', () => {
    expect(renderCommandError(1000, 'boom')).toBe('Error [1000]: boom')
    expect(renderCommandError(1000, 'boom', '')).toBe('Error [1000]: boom []')
  })

  it('a CommandError builds the same text through the function', () => {
    const error = new CommandError(1002, 'invalid command', { commandError: "errors: ['bad']" })
    expect(error.message).toBe("Error [1002]: invalid command [errors: ['bad']]")
    expect(error.errorDetail).toBeUndefined()
  })
})

describe('class hierarchy (DR-005: errors throw, nothing is stashed)', () => {
  it('every class is an EapiError and an Error [pyeapi test_create_command_error]', () => {
    // The base is asserted separately on purpose: `EapiError#name` is 'EapiError' by design (it is
    // "never raised directly"), so only the concrete subclasses need a distinct name a caller can
    // branch on in a log line. Checking `!== 'EapiError'` over a list that contains the base
    // contradicts itself; pinning each expected name is the stricter version.
    const subclasses: readonly (readonly [EapiError, string])[] = [
      [new CommandError(1000, 'cmd'), 'CommandError'],
      [new TransportError('transport'), 'TransportError'],
      [new AuthError('auth'), 'AuthError'],
      [new TlsError('tls'), 'TlsError'],
      [new ConnectError('connect'), 'ConnectError'],
      [new TimeoutError('timeout'), 'TimeoutError'],
      [new ProtocolError('protocol'), 'ProtocolError'],
      [new SessionError('session'), 'SessionError'],
      [new NotSupportedError('unsupported'), 'NotSupportedError'],
    ]
    for (const [error, expectedName] of subclasses) {
      expect(error).toBeInstanceOf(EapiError)
      expect(error).toBeInstanceOf(Error)
      expect(error.name).toBe(expectedName)
      expect(error.stack).toContain(error.message)
    }
    const base = new EapiError('base')
    expect(base).toBeInstanceOf(Error)
    expect(base.name).toBe('EapiError')
    expect(base.stack).toContain(base.message)
    expect(subclasses.map(([error]) => error.name)).not.toContain('EapiError')
    expect(new CommandError(1000, 'cmd')).toBeInstanceOf(EapiError)
  })

  it('transport subtypes share the TransportError branch so M2 can catch one type', () => {
    for (const error of [new AuthError('a'), new TlsError('t'), new ConnectError('c'), new TimeoutError('o')]) {
      expect(error).toBeInstanceOf(TransportError)
      expect(error).not.toBeInstanceOf(CommandError)
    }
    expect(new ProtocolError('p')).not.toBeInstanceOf(TransportError)
  })

  it('a caught CommandError is not mistaken for a protocol or session failure', () => {
    const error = new CommandError(1006, 'locked')
    expect(error).not.toBeInstanceOf(SessionError)
    expect(error).not.toBeInstanceOf(ProtocolError)
    expect(error.code).toBe(1006)
  })

  it('names each class so a serialised error is self-describing', () => {
    expect(new ProtocolError('p').name).toBe('ProtocolError')
    expect(new NotSupportedError('n').name).toBe('NotSupportedError')
    expect(new SessionError('s').name).toBe('SessionError')
    expect(String(new AuthError('a'))).toBe('AuthError: a')
  })

  it('keeps the cause that produced a transport failure', () => {
    const cause = new Error('ECONNREFUSED')
    expect(new ConnectError('refused', { cause }).cause).toBe(cause)
  })
})

describe('every error carries commands and requestId (ARCHITECTURE §4)', () => {
  it('attaches both to any subclass', () => {
    const options = { commands: ['show version', { cmd: 'enable', input: '<redacted>' }], requestId: 'ui-7f3a2b9c1d-1' } as const
    for (const error of [new EapiError('a', options), new TransportError('b', options), new ProtocolError('c', options)]) {
      expect(error.commands).toEqual(options.commands)
      expect(error.requestId).toBe('ui-7f3a2b9c1d-1')
    }
  })

  it('omits them when nothing is known, rather than inventing an empty array', () => {
    const error = new ProtocolError('c')
    expect(error.commands).toBeUndefined()
    expect(error.requestId).toBeUndefined()
  })

  it('ProtocolError carries the code and the raw body', () => {
    const error = new ProtocolError('bad body', { code: EapiErrorCode.PARSE_ERROR, rawBody: '{"jsonrpc":' })
    expect(error.code).toBe(-32700)
    expect(error.rawBody).toBe('{"jsonrpc":')
    expect(error.toJSON()).toMatchObject({ name: 'ProtocolError', code: -32700, rawBody: '{"jsonrpc":' })
  })
})

describe('CommandError payload, as the webui error panel reads it (USAGE §7)', () => {
  const error = new CommandError(1002, "CLI command 2 of 3 'vlan 4095' failed: invalid command", {
    commandError: "errors: ['invalid command']",
    commands: ['enable', 'vlan 4095', 'name probe'],
    requestId: 'ui-7f3a2b9c1d-7',
    results: [{}, { errors: ['invalid command'] }],
    errorDetail: [{ index: 1, code: 1002, message: 'invalid command', cmd: 'vlan 4095' }],
    failedCommand: 'vlan 4095',
  })

  it('exposes code, commandError, results, failedCommand and errorDetail', () => {
    expect(error.code).toBe(1002)
    expect(error.commandError).toBe("errors: ['invalid command']")
    expect(error.results).toHaveLength(2)
    expect(error.failedCommand).toBe('vlan 4095')
    expect(error.errorDetail).toEqual([{ index: 1, code: 1002, message: 'invalid command', cmd: 'vlan 4095' }])
  })

  it('serialises through JSON.stringify without leaking internals', () => {
    const parsed = JSON.parse(JSON.stringify(error)) as Record<string, unknown>
    expect(parsed).toMatchObject({
      name: 'CommandError',
      code: 1002,
      codeName: 'COMMAND_INVALID',
      failedCommand: 'vlan 4095',
      requestId: 'ui-7f3a2b9c1d-7',
    })
    expect(Object.keys(parsed.results ?? {})).length(2)
    expect(parsed.errorDetail).toBeInstanceOf(Array)
  })

  it('results default to an empty array, never undefined', () => {
    expect(new CommandError(1003, 'unconverted').results).toEqual([])
  })
})

describe('trace() — pyeapi get_trace, with the tail-drop bug fixed', () => {
  it('pairs commands with whatever output the device produced [pyeapi test_command_error_trace]', () => {
    const commands = ['test command', 'test command', 'test command']
    const error = new CommandError(9999, 'test', { commands, results: [{}, { output: 'test output' }] })
    expect(error.trace()).toEqual([
      { command: 'test command', output: {} },
      { command: 'test command', output: { output: 'test output' } },
      { command: 'test command' },
    ])
  })

  it('keeps the commands after a single-output failure that pyeapi drops', () => {
    // pyeapi's `if index:` guard is false when index === 0, so `strict=False` traces stop at one entry.
    const error = new CommandError(1002, 'boom', { commands: ['enable', 'vlan 4095'], results: [{}] })
    expect(error.trace()).toHaveLength(2)
    expect(error.trace()[1]).toEqual({ command: 'vlan 4095' })
  })

  it('is empty for both missing inputs, and never longer than the command list', () => {
    expect(new CommandError(1002, 'boom').trace()).toEqual([])
    expect(new CommandError(1002, 'boom', { results: [{}, {}], commands: ['only'] }).trace()).toEqual([
      { command: 'only', output: {} },
    ])
  })
})
