/**
 * `tryVariants` — the DR-006 re-shaping of pyeapi's `CliVariants` (`utils.py:235-274`), unit-tested
 * with a fake sender (no device, no transport: the sequencing is the behaviour under test).
 * MIGRATION.md §5 row 37 records the shape change and what was not ported.
 */

import { describe, expect, it } from 'vitest'

import { CommandError, EapiErrorCode, ProtocolError, TransportError } from '../errors'
import { tryVariants, type CliVariant } from './variants'
import type { CommandSpec } from '../types/eapi'

/** Records what each attempt was asked to send, and answers per attempt. */
function senderThat(results: readonly ('ok' | CommandError | Error)[]) {
  const calls: (readonly CommandSpec[])[] = []
  let attempt = 0
  return {
    calls,
    send: async (commands: readonly CommandSpec[]) => {
      calls.push(commands)
      const outcome = results[attempt] ?? 'ok'
      attempt += 1
      if (outcome instanceof Error) throw outcome
      return { commands, outcome }
    },
  }
}

function commandError(message: string, code: number = EapiErrorCode.COMMAND_INVALID): CommandError {
  return new CommandError(code, message, { commands: ['configure terminal'] })
}

describe('tryVariants — first success wins (pyeapi client.py:641-654)', () => {
  it('stops at the first variant that succeeds and never sends the rest', async () => {
    const sender = senderThat(['ok', commandError('no such command')])
    const result = await tryVariants([['vlan 20'], ['vlan 21']], sender.send)
    expect(sender.calls).toEqual([['vlan 20']])
    expect(result).toEqual({ commands: ['vlan 20'], outcome: 'ok' })
  })

  it('tries every variant in the order given', async () => {
    const sender = senderThat([commandError('one'), commandError('two'), 'ok'])
    await tryVariants([['a'], ['b'], ['c']], sender.send)
    expect(sender.calls).toEqual([['a'], ['b'], ['c']])
  })

  it('coerces a single-command variant to a list on the way in (DR-041 explicit toArray)', async () => {
    const sender = senderThat([commandError('first'), 'ok'])
    const variants: CliVariant[] = ['vrf instance mgmt', ['vrf definition mgmt', 'description x']]
    await tryVariants(variants, sender.send)
    expect(sender.calls).toEqual([['vrf instance mgmt'], ['vrf definition mgmt', 'description x']])
  })

  it('lets a variant be empty, which is how a caller says "this spelling needs no command at all"', async () => {
    const sender = senderThat([commandError('not here'), 'ok'])
    await tryVariants([['service routing protocols model multi-agent'], []], sender.send)
    expect(sender.calls).toEqual([['service routing protocols model multi-agent'], []])
  })
})

describe('tryVariants — failure handling', () => {
  it('re-raises the LAST CommandError when every variant fails (pyeapi `raise err`, client.py:654)', async () => {
    const last = commandError('last failure', EapiErrorCode.COMMAND_FAILED)
    const sender = senderThat([commandError('first failure'), commandError('second failure'), last])
    const error = await tryVariants([['a'], ['b'], ['c']], sender.send).catch((thrown: unknown) => thrown)
    expect(error).toBe(last)
    expect(sender.calls).toEqual([['a'], ['b'], ['c']])
  })

  it('does not try another variant for a transport failure — device state would be unknown (DR-019)', async () => {
    const refused = new TransportError('nothing listening', { endpoint: 'mock://device', retryable: true })
    const sender = senderThat([refused, 'ok'])
    await expect(tryVariants([['a'], ['b']], sender.send)).rejects.toThrow(/nothing listening/)
    expect(sender.calls).toEqual([['a']])
  })

  it('does not try another variant for a protocol failure either: that is a client bug, not a CLI spelling', async () => {
    const sender = senderThat([new ProtocolError('malformed envelope'), 'ok'])
    await expect(tryVariants([['a'], ['b']], sender.send)).rejects.toBeInstanceOf(ProtocolError)
    expect(sender.calls).toEqual([['a']])
  })

  it('carries the failed commands on the error it re-raises, so the last attempt is still debuggable', async () => {
    const sender = senderThat([commandError('one'), commandError('two')])
    const error = await tryVariants([['a'], ['b']], sender.send).catch((thrown: unknown) => thrown)
    expect((error as CommandError).code).toBe(EapiErrorCode.COMMAND_INVALID)
    expect((error as CommandError).commands).toEqual(['configure terminal'])
  })
})

describe('tryVariants — argument hygiene (pyeapi asserts the same, utils.py:260/272)', () => {
  it('refuses fewer than two variants instead of silently looping once', async () => {
    await expect(tryVariants([['only']], () => Promise.resolve('x'))).rejects.toThrow(TypeError)
    await expect(tryVariants([['only']], () => Promise.resolve('x'))).rejects.toThrow(/2 or more command variants/)
    await expect(tryVariants([], () => Promise.resolve('x'))).rejects.toThrow(/got 0/)
  })

  it('refuses a non-array variant set, which is what a pyeapi caller passing CliVariants would look like', async () => {
    const notAnArray = { variants: [['a'], ['b']] } as unknown as readonly CliVariant[]
    await expect(tryVariants(notAnArray, () => Promise.resolve('x'))).rejects.toThrow(/array of command variants/)
  })

  it('does not send anything when the guard fires', async () => {
    const sender = senderThat(['ok'])
    await expect(tryVariants([], sender.send)).rejects.toThrow(TypeError)
    expect(sender.calls).toEqual([])
  })
})
