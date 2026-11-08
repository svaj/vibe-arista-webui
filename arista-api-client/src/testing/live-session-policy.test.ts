/**
 * Offline unit tests for the DR-035 write-side policy helper, M12a (#14).
 *
 * Like every `src/testing/**` file these run in the **unit** project (`npm run test`), never `live`, and
 * they never touch a device — they script `MockTransport` and assert the *command lists + commit/cleanup
 * discipline* the helper puts on the wire. The helper exists so the `*.live.test.ts` suites can mutate a
 * scratch port at all; what is provable offline is named/abort-on-failure/never-persist, so that is what
 * is asserted here, and the live lane contributes the single real-device validation the lane report covers.
 *
 * ## The script keys — the bug this notes explicitly
 * `MockTransport.matches` accepts a matcher that equals **one** command in the list (`texts.includes`) or
 * the **whole list joined with `\n`** (`texts.join('\n') === match`). A session batch is
 * `[enable, configure session <name>, ...tail]`, so a key that stops at the opener
 * (`configure session <name>`) only matches via `includes` if that exact string is a *single element* —
 * which it is not, because it sits inside a longer list; it never matches, and the request falls through to
 * `NotSupportedError`. Every key below therefore spells the **full joined list**, `enable` and the opener
 * included. `wireCommands(name, tail)` builds the same join the transport will compare against, so the
 * intent (which operation) reads off the test and the exact-spelling hazard is handled once.
 */

import { describe, expect, it } from 'vitest'

import { Node } from '../command-layer'
import { NotSupportedError } from '../errors'
import { mockTransport, type MockTransport } from './mock-transport'
import { labWriteScopeRefusal, runGuardedLiveWriteSession, withLabWriteScope } from './live-session-policy'
import type { CommandResult } from '../types/eapi'

const ADDRESS = 'https://localhost:8443/command-api'

/** The `\n`-joined command list a guarded batch actually puts on the wire (enable + session opener + tail). */
function wireKey(name: string, ...tail: readonly string[]): string {
  return ['enable', `configure session ${name}`, ...tail].join('\n')
}

/** `{}` per wire command — "the device ran all of them and said nothing back" (the codec needs one reply each). */
function ack(wireCommands: number): CommandResult[] {
  return Array.from({ length: wireCommands }, () => ({}) as CommandResult)
}

function node(): { node: Node; transport: MockTransport } {
  const transport = mockTransport({ address: ADDRESS })
  return { node: new Node(transport), transport }
}

describe('runGuardedLiveWriteSession — the happy path is a named session, committed, not persisted', () => {
  it('stages the batch, then commits, each as its own session batch opened by name (DR-022)', async () => {
    const { node: n, transport } = node()
    const tail = ['interface Ethernet3', 'no switchport']
    transport
      .replies(wireKey('m12a-scratch', ...tail), ack(2 + 2))
      .replies(wireKey('m12a-scratch', 'commit'), ack(2 + 1))

    const outcome = await runGuardedLiveWriteSession(n, {
      name: 'm12a-scratch',
      commands: tail,
    })

    expect(outcome.committed).toBe(true)
    expect(outcome.sessionName).toBe('m12a-scratch')
    expect(outcome.results).toHaveLength(tail.length) // opener + enable already popped

    // Exactly two round trips: the staged batch, then the commit. Both re-enter the named session.
    const lists = transport.sent().map((cmds) => cmds.map((c) => (typeof c === 'string' ? c : c.cmd)))
    expect(lists).toEqual([
      ['enable', 'configure session m12a-scratch', 'interface Ethernet3', 'no switchport'],
      ['enable', 'configure session m12a-scratch', 'commit'],
    ])
  })

  it('carries an optional session description onto the opener without changing the batch', async () => {
    const { node: n, transport } = node()
    const opener = 'configure session m12a-note description "live lane"'
    // The opener now includes the description, so the wire key spells it — proving the key really is the
    // full joined list and not just `configure session <name>`.
    transport
      .replies(['enable', opener, 'interface Ethernet3'].join('\n'), ack(3))
      .replies(['enable', opener, 'commit'].join('\n'), ack(3))

    const outcome = await runGuardedLiveWriteSession(n, {
      name: 'm12a-note',
      description: 'live lane',
      commands: ['interface Ethernet3'],
    })
    expect(outcome.committed).toBe(true)
    const first = transport.sent()[0]?.map((c) => (typeof c === 'string' ? c : c.cmd))
    expect(first?.[1]).toBe(opener)
  })

  it('commits WITHOUT copy running-config startup-config — no persist round trip (DR-024/DR-035c)', async () => {
    const { node: n, transport } = node()
    transport
      .replies(wireKey('m12a-a', 'interface Ethernet3'), ack(3))
      .replies(wireKey('m12a-a', 'commit'), ack(3))

    await runGuardedLiveWriteSession(n, { name: 'm12a-a', commands: ['interface Ethernet3'] })

    const joined = transport.sent().map((cmds) => cmds.map((c) => (typeof c === 'string' ? c : c.cmd)).join(' | '))
    expect(joined.some((line) => /copy run/iu.test(line))).toBe(false)
    // No third round trip: commit already happened and nothing persisted it.
    expect(transport.sent()).toHaveLength(2)
  })
})

describe('runGuardedLiveWriteSession — refuses persistence before the session opens (DR-035c)', () => {
  it('refuses a batch containing `copy running-config startup-config` and sends NOTHING to the device', async () => {
    const { node: n, transport } = node()

    const error = await runGuardedLiveWriteSession(n, {
      name: 'm12a-smuggle',
      commands: ['interface Ethernet3', 'copy running-config startup-config'],
    }).then(
      () => undefined,
      (err: unknown) => err,
    )

    expect(error).toBeInstanceOf(NotSupportedError)
    expect((error as Error).message).toMatch(/copy run/iu)
    // Guard first, wire never: no session batch, no opener, not even an enable round trip.
    expect(transport.sent()).toEqual([])
    expect(transport.callCount()).toBe(0)
  })

  it('refuses the shorthand `copy run start` too, matching the guard\'s own regex', async () => {
    const { node: n, transport } = node()
    await expect(runGuardedLiveWriteSession(n, { name: 'm12a-smuggle2', commands: ['copy run start'] })).rejects.toBeInstanceOf(NotSupportedError)
    expect(transport.sent()).toEqual([])
  })
})

describe('runGuardedLiveWriteSession — always aborts a live session when the write fails (DR-035)', () => {
  it('aborts the session when a staged command is rejected by the device', async () => {
    const { node: n, transport } = node()
    const tail: readonly string[] = ['interface Ethernet3', 'switchport mode trunk']

    // The batch is refused with a device 1002 on the second command. Because the reply carries an
    // `errorDetail`, `failedCommand` resolves to the *non*-opener line, so `openerRejected` is false and
    // the state machine leaves the session `open` — the helper's `finally` must then abort it. (A failure
    // with no `errorDetail` would look like an opener rejection and land in `lost`, which is the *other*
    // test below.) The abort itself is scripted under its own full wire key.
    transport
      .rejects(wireKey('m12a-fail', ...tail), {
        code: 1002,
        message: 'Cannot switch to mode',
        data: { errorDetail: [{ index: 3, code: 1002, message: 'Cannot switch to mode', cmd: 'switchport mode trunk' }] },
      })
      .replies(wireKey('m12a-fail', 'abort'), ack(3))

    const error = await runGuardedLiveWriteSession(n, { name: 'm12a-fail', commands: tail }).then(
      () => undefined,
      (err: unknown) => err,
    )
    expect(error).toBeDefined()

    const lists = transport.sent().map((cmds) => cmds.map((c) => (typeof c === 'string' ? c : c.cmd)))
    expect(lists).toEqual([
      ['enable', 'configure session m12a-fail', 'interface Ethernet3', 'switchport mode trunk'],
      ['enable', 'configure session m12a-fail', 'abort'],
    ])
  })

  it('does NOT re-abort a session the commit killed (state machine refuses, and the finally must not mask it)', async () => {
    const { node: n, transport } = node()
    // Commit rejected with 1006 (config locked) makes the handle `lost` — abort would be a state-machine
    // throw, so the finally skips it and the original commit error is what propagates.
    transport
      .replies(wireKey('m12a-lost', 'interface Ethernet3'), ack(3))
      .rejects(wireKey('m12a-lost', 'commit'), { code: 1006, message: 'Config locked by session m12a-lost' })

    const error = await runGuardedLiveWriteSession(n, { name: 'm12a-lost', commands: ['interface Ethernet3'] }).then(
      () => undefined,
      (err: unknown) => err,
    )
    expect(error).toBeDefined()

    const lists = transport.sent().map((cmds) => cmds.map((c) => (typeof c === 'string' ? c : c.cmd)))
    // Only the batch and the failed commit reached the wire — no abort round trip after a `lost` handle.
    expect(lists).toEqual([
      ['enable', 'configure session m12a-lost', 'interface Ethernet3'],
      ['enable', 'configure session m12a-lost', 'commit'],
    ])
  })
})
describe('labWriteScopeRefusal + withLabWriteScope — the self-lockout set before the wire (DR-126)', () => {
  const ctx = { username: 'eapi-lab' }
  const config = (tail: string[]): string[] => ['configure session lane-test', ...tail]

  it('refuses listener, built-in user, in-use user, and management-path config lines', () => {
    for (const line of [
      'management api http-commands',
      'no management api http-commands',
      'username admin privilege 15 secret hashwhatever',
      'no username netadmin',
      'username eapi-lab privilege 15',
      'interface Management1',
      'no interface Management0',
    ]) {
      const refusal = labWriteScopeRefusal(config([line, '   x']), ctx)
      expect(refusal?.code, line).toBe('EAPI_LAB_WRITE_FORBIDDEN')
    }
  })

  it('does not echo the full offending line — only its first two words (secret tails stay unprinted, DR-011)', () => {
    const refusal = labWriteScopeRefusal(config(['username admin privilege 15 secret SUPERSECRETVAL']), ctx)
    expect(refusal?.reason).not.toContain('SUPERSECRETVAL')
    expect(refusal?.reason).toContain('username admin')
  })

  it('refuses persistence inside a config batch too (DR-035(c) survives the widening)', () => {
    expect(labWriteScopeRefusal(config(['copy running-config startup-config']), ctx)?.reason).toMatch(/persistence|copy run/iu)
  })

  it('leaves read batches and legitimate lab writes through', () => {
    expect(labWriteScopeRefusal(['show running-config'], ctx)).toBeUndefined()
    expect(labWriteScopeRefusal(['enable', 'show management api http-commands'], ctx)).toBeUndefined()
    expect(labWriteScopeRefusal(config(['username labuser1 privilege 1 secret x', 'vlan 1000', '   name scratchy', 'interface Vlan1000', 'ip address 10.9.9.1/24', 'hostname lab-dut', 'ntp server 5.5.5.5']), ctx)).toBeUndefined()
    // 'username' as a *word* in a non-config batch (autocomplete probes) is not a write: no marker, no scan.
    expect(labWriteScopeRefusal(['username'], ctx)).toBeUndefined()
  })

  it('checks {cmd,input} framing as well: input lines are scanned line-wise', () => {
    const refusal = labWriteScopeRefusal([{ cmd: 'configure session lane-test', input: 'interface Management1\n ip address dhcp' }], ctx)
    expect(refusal?.code).toBe('EAPI_LAB_WRITE_FORBIDDEN')
  })

  it('withLabWriteScope rejects BEFORE the transport sees the batch, and passes everything else through unchanged', async () => {
    const transport = mockTransport({ address: ADDRESS })
    transport.replies(['configure session lane-test', 'username labuser1 privilege 1 secret x', 'commit'].join('\n'), ack(3))
    const guarded = withLabWriteScope(transport, ctx)
    await expect(guarded.execute(['configure session lane-test', 'username admin secret x'])).rejects.toThrow(NotSupportedError)
    expect(transport.sent()).toHaveLength(0)
    const ok = await guarded.execute(['configure session lane-test', 'username labuser1 privilege 1 secret x', 'commit'])
    expect(ok).toBeTruthy()
    expect(transport.sent()).toHaveLength(1)
    expect(guarded.kind).toBe(transport.kind)
    expect(guarded.address).toBe(transport.address)
  })
})
