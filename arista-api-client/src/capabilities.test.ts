/**
 * `src/capabilities.ts` — M11 (#13) capability probe + TTL cache, offline Vitest spec (`docs/TESTING.md` §3).
 * Every request in this file is answered by `MockTransport`; there is **zero** real host here — the worktree's
 * physical switch is on the network but none of these scripts reach it (DR-034), and none of these tests
 * claim what a DCS-7050TX-64 would do with a candidate.
 *
 * ## Upstream port ledger: **zero rows**
 *
 * pyeapi has no capability-probe twin (`grep -rn "capability|probe" pyeapi/pyeapi/` matches nothing in the
 * pinned clone at `develop` `6816d9e`), so every case below is new surface built on
 * `src/capabilities.ts`'s `VERDICT_BY_CODE` — DR-010's `1002/1004/1005/1006` map to
 * `unsupported`/`incompatible`/`unauthorized`/`config-locked`; every other code is `unknown` with the
 * raw error carried. Three of the four codes the taxonomy distinguishes are *not* statements about a
 * feature — DR-033's whole reason the taxonomy exists — so 1004/1005/1006 get their own tests below.
 *
 * Three kinds of claim, same idiom as the sibling `command-layer.methods.test.ts`:
 *  - **(a) the wire batches we send** — verified against `src/config-session.ts`: every session batch is
 *    `[enable, configure session <name> no-commit, …chunk]` (`ConfigSession#send` re-prepends the opener on
 *    every request, DR-022; `Node.runCommands` prepends a bare `enable` when `sendEnable` is not overridden).
 *    `MockTransport`'s string matcher compares the **whole joined command list**
 *    (`testing/mock-transport.ts`, `texts.join('\n') === match`), so keys are built here from the same
 *    parts. The probe's abort batch — `[enable, opener, abort]` — is one of the guarantees this module
 *    exists for (the no-orphan invariant), so it is pinned in every path.
 *  - **(b) our parse of a hand-authored `errorDetail` envelope — SYNTHETIC at every use.** The `{result,
 *    errorDetail[]}` `error.data` shape is what `includeErrorDetail: true` asks for (`types/eapi.ts:57`) and
 *    what `wire#parseErrorEnvelope` reads into `CommandError#errorDetail`; the message texts inside are
 *    invented stand-ins, not captures, so each test pins **our** mapping of `code → verdict`, never EOS
 *    prose. M12 (#14) captures real envelopes and replaces these fixtures.
 *  - **(c) refusals** — every guard (`capabilities.ts` and the `config-session.ts` name validator a probe
 *    reaches via `target.configSession()`'s lazy open) runs before the first request, so `sent()` stays
 *    `[]` and `callCount()` stays `0`.
 */

import { describe, expect, it } from 'vitest'

import {
  chunk,
  createCapabilityCache,
  DEFAULT_CAPABILITY_TTL_MS,
  isInconclusiveVerdict,
  isUnavailableVerdict,
  probeCommands,
  type CommandProbeResult,
  type ProbeCommandsOutcome,
} from './capabilities'
import { Node } from './command-layer'
import { CommandError, ConnectError, EapiErrorCode, NotSupportedError, SessionError } from './errors'
import { mockTransport, type MockTransport } from './testing/mock-transport'
import type { CommandSpec } from './types/eapi'

const ADDRESS = 'https://sw1.lan:443/command-api'
const OTHER_ADDRESS = 'https://sw2.lan:443/command-api'

/** Fixed probe-session name, so the wire keys are deterministic (otherwise DR-047's default has a hex tail). */
const NAME = 'ui-probe'
/** Cache probes get a predictable name too — `CapabilityCacheOptions.sessionName` exists for exactly this. */
const CACHE_NAME = 'ui-cached'

/** The opener a probe always asks for, spelled the way `ConfigSession#opener` builds it (`no-commit` fixed in the impl). */
const OPEN = `configure session ${NAME} no-commit`
const CACHE_OPEN = `configure session ${CACHE_NAME} no-commit`
/** {@link ProbeSessionReport#opener} is just the bare re-attach text, without the ` no-commit`. */
const BARE_OPENER = `configure session ${NAME}`

/** A MockTransport batch key: `Node.runCommands` prepends a bare `enable`, then the opener, then the tail. */
const probeKey = (open: string, tail: readonly string[]): string => ['enable', open, ...tail].join('\n')
/**
 * Empty per-command replies for a successful batch — `enable`, `configure session <name> no-commit`, one
 * per candidate. `ConfigSession#send` pops its opener reply and `Node.runCommands` popped the
 * enable reply, so a script reply of the full command-list length keeps the checks from tripping the
 * `results.length === 0` ProtocolError path.
 */
function ack(count: number): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (let index = 0; index < count; index += 1) out.push({})
  return out
}

/** Recovers a rejection, typed — the verb is `async`, so even a pre-request guard arrives as a rejection. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => undefined,
    (error: unknown) => error,
  )
}

/** `probeCommands` default options: fixed clock so `elapsedMs` is 0 and `finishedAt === startedAt`. */
function clock(): number {
  return 0
}

/**
 * This project turns on `noUncheckedIndexedAccess` (`tsconfig.test.json`), so `arr[0]` types as
 * `T | undefined` and reading a verdict would need a `?.` chain on every field. `probeCommands`
 * always ships one verdict per candidate in candidate order, so "no verdict here" can only be a
 * spec-authoring bug — this helper names that rather than papering it over with `!`.
 */
function verdict(outcome: ProbeCommandsOutcome, index = 0): CommandProbeResult {
  const result = outcome.results[index]
  if (result === undefined) throw new TypeError(`SYNTHETIC spec failure: no verdict at index ${index} of \`outcome.results\``)
  return result
}

/** The full command list of the `index`-th request that went on the wire. */
function sentAt(t: MockTransport, index: number): readonly CommandSpec[] {
  const list = t.sent()[index]
  if (list === undefined) throw new TypeError(`SYNTHETIC spec failure: no request at index ${index} on the mock`)
  return list
}

describe('probeCommands classification — error code → verdict (b: SYNTHETIC envelopes, DR-010)', () => {
  it('a batch the device accepts answers `supported`, with no `code`, since there was no failure on the wire', async () => {
    const t = mockTransport({ address: ADDRESS })
      .replies(probeKey(OPEN, ['vlan 20']), ack(3))
      .replies(probeKey(OPEN, ['abort']), ack(3))
    const outcome = await probeCommands(new Node(t), ['vlan 20'], { sessionName: NAME, now: clock })
    const first = verdict(outcome)
    expect(first.verdict).toBe('supported')
    expect('code' in first).toBe(false)
    expect('codeName' in first).toBe(false)
    expect(first.unavailable).toBe(false)
    expect(outcome.summary.supported).toBe(1)
    expect(outcome.session.opener).toBe(BARE_OPENER)
    expect(outcome.session.noCommit).toBe(true)
    expect(t.sent()).toEqual([
      ['enable', OPEN, 'vlan 20'],
      ['enable', OPEN, 'abort'],
    ])
  })

  it('1002 COMMAND_INVALID answers `unsupported` and `unavailable: true`, the only verdict that says a command cannot be used', async () => {
    const t = mockTransport({ address: ADDRESS })
      .rejects(probeKey(OPEN, ['vlan 4095']), {
        code: EapiErrorCode.COMMAND_INVALID,
        message: 'SYNTHETIC: the batch reported a CLI-grammar rejection in this probe session',
        data: {
          result: [{}, {}, { errors: ['SYNTHETIC'] }],
          errorDetail: [{ index: 2, code: EapiErrorCode.COMMAND_INVALID, message: 'SYNTHETIC no such vlan range', cmd: 'vlan 4095' }],
        },
      })
      .replies(probeKey(OPEN, ['abort']), ack(3))
    const outcome = await probeCommands(new Node(t), ['vlan 4095'], { sessionName: NAME, now: clock })
    const first = verdict(outcome)
    expect(first.verdict).toBe('unsupported')
    expect(first.code).toBe(EapiErrorCode.COMMAND_INVALID)
    expect(first.codeName).toBe('COMMAND_INVALID')
    expect(first.codeSource).toBe('errorDetail')
    expect(first.unavailable).toBe(true)
    expect(isUnavailableVerdict(first.verdict)).toBe(true)
    expect(outcome.summary.unsupported).toBe(1)
  })

  it('1004 COMMAND_INCOMPATIBLE answers `incompatible`, and never reads as "unavailable" — the eAPI context, not the feature', async () => {
    const t = mockTransport({ address: ADDRESS })
      .rejects(probeKey(OPEN, ['interface Ethernet1']), {
        code: EapiErrorCode.COMMAND_INCOMPATIBLE,
        message: 'SYNTHETIC: this batch was refused at the CLI-context layer',
        data: {
          result: [{}],
          errorDetail: [{ index: 3, code: EapiErrorCode.COMMAND_INCOMPATIBLE, message: 'SYNTHETIC wrong mode', cmd: 'interface Ethernet1' }],
        },
      })
      .replies(probeKey(OPEN, ['abort']), ack(3))
    const outcome = await probeCommands(new Node(t), ['interface Ethernet1'], { sessionName: NAME, now: clock })
    const first = verdict(outcome)
    expect(first.verdict).toBe('incompatible')
    expect(first.codeSource).toBe('errorDetail')
    expect(first.unavailable).toBe(false)
    expect(isUnavailableVerdict(first.verdict)).toBe(false)
    expect(outcome.summary.incompatible).toBe(1)
    // The session survived the rejection, so the abort still closed it — path 2 of the no-orphan invariant.
    expect(outcome.session.aborted).toBe(true)
    expect(outcome.session.state).toBe('aborted')
  })

  it('1005 COMMAND_UNAUTHORIZED answers `unauthorized`, a privilege question rather than a feature refusal', async () => {
    const t = mockTransport({ address: ADDRESS })
      .rejects(probeKey(OPEN, ['feature x']), {
        code: EapiErrorCode.COMMAND_UNAUTHORIZED,
        message: 'SYNTHETIC: the API user was not priv 15',
        data: {
          result: [{}],
          errorDetail: [{ index: 2, code: EapiErrorCode.COMMAND_UNAUTHORIZED, message: 'SYNTHETIC priv denied', cmd: 'feature x' }],
        },
      })
      .replies(probeKey(OPEN, ['abort']), ack(3))
    const outcome = await probeCommands(new Node(t), ['feature x'], { sessionName: NAME, now: clock })
    const first = verdict(outcome)
    expect(first.verdict).toBe('unauthorized')
    expect(first.code).toBe(EapiErrorCode.COMMAND_UNAUTHORIZED)
    expect(first.codeName).toBe('COMMAND_UNAUTHORIZED')
    expect(first.unavailable).toBe(false)
    expect(outcome.summary.unauthorized).toBe(1)
  })

  it('1006 COMMAND_CONFIG_LOCKED on the per-command detail answers `config-locked`, i.e. nothing was probed', async () => {
    const t = mockTransport({ address: ADDRESS })
      .rejects(probeKey(OPEN, ['vlan 20']), {
        code: EapiErrorCode.COMMAND_FAILED,
        message: 'SYNTHETIC: the batch failed while the config lock was held elsewhere',
        data: {
          result: [{}],
          errorDetail: [{ index: 2, code: EapiErrorCode.COMMAND_CONFIG_LOCKED, message: 'SYNTHETIC lock', cmd: 'vlan 20' }],
        },
      })
      .replies(probeKey(OPEN, ['abort']), ack(3))
    const outcome = await probeCommands(new Node(t), ['vlan 20'], { sessionName: NAME, now: clock })
    expect(verdict(outcome).verdict).toBe('config-locked')
    expect(verdict(outcome).code).toBe(EapiErrorCode.COMMAND_CONFIG_LOCKED)
    expect(verdict(outcome).codeSource).toBe('errorDetail')
    // A per-command 1006 is only a verdict: the handle stayed open, so this run can be re-probed.
    expect(outcome.configLocked).toBe(false)
    expect(isInconclusiveVerdict('config-locked')).toBe(true)
  })

  it('an unmapped code answers `unknown` with the raw batch error carried, so a caller can `switch (e.code)` honestly', async () => {
    const t = mockTransport({ address: ADDRESS })
      .rejects(probeKey(OPEN, ['vlan 20']), {
        code: EapiErrorCode.COMMAND_FAILED,
        message: 'SYNTHETIC: the device reported an exception with an unmapped per-command code',
        data: {
          result: [{}],
          errorDetail: [{ index: 2, code: EapiErrorCode.COMMAND_EXCEPTION, message: 'SYNTHETIC crash', cmd: 'vlan 20' }],
        },
      })
      .replies(probeKey(OPEN, ['abort']), ack(3))
    const outcome = await probeCommands(new Node(t), ['vlan 20'], { sessionName: NAME, now: clock })
    const first = verdict(outcome)
    expect(first.verdict).toBe('unknown')
    expect(first.code).toBe(EapiErrorCode.COMMAND_EXCEPTION)
    expect(first.codeName).toBe('COMMAND_EXCEPTION')
    expect(first.codeSource).toBe('errorDetail')
    expect(first.unavailable).toBe(false)
    expect(first.errorDetail).toEqual({ index: 2, code: EapiErrorCode.COMMAND_EXCEPTION, message: 'SYNTHETIC crash', cmd: 'vlan 20' })
    expect(first.error).toBeInstanceOf(CommandError)
    expect(outcome.error?.code).toBe(EapiErrorCode.COMMAND_FAILED)
    expect(outcome.summary.unknown).toBe(1)
  })

  it('a batch that failed without mentioning the candidate answers `not-rejected`, resting on JsonCli.py:106-127', async () => {
    // The batch-level error is 1000, and the device's `errorDetail` names a command that is on the wire
    // but is not one we offered as a candidate — silence on the candidate text means "not rejected",
    // which is named apart from `supported` precisely because it rests on `JsonCli.py` Python rather
    // than on a capture (the batch did not stop on this candidate).
    const t = mockTransport({ address: ADDRESS })
      .rejects(probeKey(OPEN, ['vlan 20', 'vlan 30']), {
        code: EapiErrorCode.COMMAND_FAILED,
        message: 'SYNTHETIC: the batch reported a failure against an unrelated command text',
        data: {
          result: [{}, {}, {}],
          errorDetail: [{ index: 1, code: EapiErrorCode.COMMAND_FAILED, message: 'SYNTHETIC complaint about a line we did not offer', cmd: 'show bogus' }],
        },
      })
      .replies(probeKey(OPEN, ['abort']), ack(3))
    const outcome = await probeCommands(new Node(t), ['vlan 20', 'vlan 30'], { sessionName: NAME, now: clock })
    expect(outcome.results.map((r) => r.verdict)).toEqual(['not-rejected', 'not-rejected'])
    // The device-reported line survives in outcome.errorDetail untouched even though neither candidate
    // matches it, so the caller can print what actually happened.
    expect(outcome.errorDetail).toEqual([{ index: 1, code: EapiErrorCode.COMMAND_FAILED, message: 'SYNTHETIC complaint about a line we did not offer', cmd: 'show bogus' }])
    expect(outcome.summary['not-rejected']).toBe(2)
    expect(verdict(outcome).codeSource).toBe('batch')
    expect(verdict(outcome).code).toBe(EapiErrorCode.COMMAND_FAILED)
    expect(outcome.session.aborted).toBe(true)
  })
})

/**
 * `src/capabilities.test.ts` — everything below the classification block, in the order the impl reads
 * them. The batch/wire and always-abort groups are the two the reviewer should read first, because
 * they're the ones that carry the DR-022/DR-023/DR-050 reasoning: batch keys pin what the wire
 * literally says, and the "abort was sent" assertions pin that the probe left no orphan behind on every
 * path (`capabilities.ts` lists six paths).
 */

describe('probeCommands batching — one session carries every candidate in script order', () => {
  it('the default batchSize is "all in one batch", so one candidate list ships as one runCmds request', async () => {
    const candidates = ['vlan 20', 'interface Ethernet1', 'no shutdown']
    const t = mockTransport({ address: ADDRESS })
      .replies(probeKey(OPEN, candidates), ack(candidates.length + 2))
      .replies(probeKey(OPEN, ['abort']), ack(3))
    const outcome = await probeCommands(new Node(t), candidates, { sessionName: NAME, now: clock })
    expect(outcome.batchCount).toBe(1)
    // The wire list of the first batch is the whole joined candidate list under the opener —
    // `stopOnError:false` is what keeps all three commands in one request (wire.ts's buildRequest).
    // The MockTransport string matcher joins the whole command list with `\n`, so a key that stopped
    // at the opener would never reach this assertion — see `testing/mock-transport.ts` `matches()`.
    expect(t.sent()).toEqual([
      ['enable', 'configure session ui-probe no-commit', 'vlan 20', 'interface Ethernet1', 'no shutdown'],
      ['enable', 'configure session ui-probe no-commit', 'abort'],
    ])
    const bodies = t.bodies()
    expect(bodies[0]?.params.stopOnError).toBe(false)
    expect(bodies[0]?.params.includeErrorDetail).toBe(true)
    // The abort request is a plain runCmds with the device's own `stopOnError` — the probe's
    // stopOnError:false knob is per batch, not a session-wide property.
    expect('stopOnError' in (bodies[1]?.params ?? {})).toBe(false)
    expect(outcome.results.map((entry) => entry.batchIndex)).toEqual([0, 0, 0])
  })

  it('splitting into smaller batches stamps batchIndex per chunk in send order', async () => {
    const candidates = ['vlan 20', 'vlan 30', 'vlan 40']
    const t = mockTransport({ address: ADDRESS })
      .replies(probeKey(OPEN, ['vlan 20']), ack(3))
      .replies(probeKey(OPEN, ['vlan 30']), ack(3))
      .replies(probeKey(OPEN, ['vlan 40']), ack(3))
      .replies(probeKey(OPEN, ['abort']), ack(3))
    const outcome = await probeCommands(new Node(t), candidates, { sessionName: NAME, batchSize: 1, now: clock })
    expect(outcome.batchCount).toBe(3)
    expect(t.sent()).toEqual([
      ['enable', OPEN, 'vlan 20'],
      ['enable', OPEN, 'vlan 30'],
      ['enable', OPEN, 'vlan 40'],
      ['enable', OPEN, 'abort'],
    ])
    expect(outcome.results.map((entry) => entry.batchIndex)).toEqual([0, 1, 2])
  })

  it('the progress sink runs inside the probe\'s guarantee: once per chunk, context-typed', async () => {
    const seen: { index: number; upper: number; commands: readonly string[]; name: string }[] = []
    const t = mockTransport({ address: ADDRESS })
      .replies(probeKey(OPEN, ['vlan 20', 'vlan 30']), ack(4))
      .replies(probeKey(OPEN, ['abort']), ack(3))
    // The `progress` parameter's type is contextual — `ProbeBatchProgress` in `capabilities.ts`.
    const outcome = await probeCommands(new Node(t), ['vlan 20', 'vlan 30'], {
      sessionName: NAME,
      now: clock,
      onBatch: (progress) => {
        seen.push({
          index: progress.batchIndex,
          upper: progress.batchesUpperBound,
          commands: progress.commands,
          name: progress.sessionName,
        })
      },
    })
    expect(seen).toEqual([{ index: 0, upper: 1, commands: ['vlan 20', 'vlan 30'], name: NAME }])
    expect(outcome.batchCount).toBe(1)
    // The session was still ended: the sink did not skip the abort path — this module guarantees the
    // session is closed even if a caller's own callback throws.
    expect(outcome.session.aborted).toBe(true)
    expect(t.sent()).toEqual([
      ['enable', OPEN, 'vlan 20', 'vlan 30'],
      ['enable', OPEN, 'abort'],
    ])
  })

  it('chunk (exported for the spec) splits deterministically, preserves order, and never drops a candidate', () => {
    expect(chunk(['a', 'b', 'c', 'd'], 3)).toEqual([['a', 'b', 'c'], ['d']])
    expect(chunk(['a', 'b'], 2)).toEqual([['a', 'b']])
    expect(chunk(['a'], 1)).toEqual([['a']])
    expect(chunk([], 3)).toEqual([])
    expect(chunk(['x'], 0)).toEqual([['x']])
  })
})

describe('always-abort / no-orphan invariant: every path ends the session it opened (paths 1-6 in capabilities.ts)', () => {
  it('path 1 — all accepted: the abort batch is the last request on the wire, and `outcome.session.aborted` says so', async () => {
    const t = mockTransport({ address: ADDRESS })
      .replies(probeKey(OPEN, ['vlan 20']), ack(3))
      .replies(probeKey(OPEN, ['abort']), ack(3))
    const outcome = await probeCommands(new Node(t), ['vlan 20'], { sessionName: NAME, now: clock })
    const sent = t.sent()
    expect(sent.length).toBe(2)
    expect(sent[1]?.[2]).toBe('abort')
    expect(outcome.session.aborted).toBe(true)
    expect(outcome.session.noCommit).toBe(true)
  })

  it('path 2 — mixture on ONE batch: a candidate rejected on the detail still leaves the handle live, so abort runs', async () => {
    const t = mockTransport({ address: ADDRESS })
      .rejects(probeKey(OPEN, ['vlan 20', 'vlan 30']), {
        code: EapiErrorCode.COMMAND_INVALID,
        message: 'SYNTHETIC: only vlan 30 was refused on this batch',
        data: {
          result: [{}, {}],
          errorDetail: [{ index: 3, code: EapiErrorCode.COMMAND_INVALID, message: 'SYNTHETIC only this one', cmd: 'vlan 30' }],
        },
      })
      .replies(probeKey(OPEN, ['abort']), ack(3))
    const outcome = await probeCommands(new Node(t), ['vlan 20', 'vlan 30'], { sessionName: NAME, now: clock })
    expect(outcome.results.map((entry) => entry.verdict)).toEqual(['not-rejected', 'unsupported'])
    expect(outcome.summary['not-rejected']).toBe(1)
    expect(outcome.summary.unsupported).toBe(1)
    const sent = t.sent()
    expect(sent.length).toBe(2)
    expect(sent[1]?.[2]).toBe('abort')
    expect(outcome.session.aborted).toBe(true)
  })

  it('path 3 — throw mid-probe: a later batch fails on transport and `abort` was still sent', async () => {
    const t = mockTransport({ address: ADDRESS })
      .replies(probeKey(OPEN, ['vlan 20']), ack(3))
      .throws(probeKey(OPEN, ['vlan 30']), new ConnectError('SYNTHETIC the switch went offline mid-probe'))
      .replies(probeKey(OPEN, ['abort']), ack(3))
    const thrown = await rejection(probeCommands(new Node(t), ['vlan 20', 'vlan 30'], { sessionName: NAME, batchSize: 1, now: clock }))
    expect(thrown).toBeInstanceOf(ConnectError)
    const sent = t.sent()
    expect(sent.length).toBe(3)
    expect(sentAt(t, 0)).toEqual(['enable', OPEN, 'vlan 20'])
    expect(sentAt(t, 1)).toEqual(['enable', OPEN, 'vlan 30'])
    expect(sentAt(t, 2)).toEqual(['enable', OPEN, 'abort'])
  })

  it('path 3b — thrown transport error on the *only* batch: abort was attempted, then probeError is re-thrown', async () => {
    const t = mockTransport({ address: ADDRESS })
      .throws(probeKey(OPEN, ['vlan 20']), new ConnectError('SYNTHETIC unreachable switch'))
      .replies(probeKey(OPEN, ['abort']), ack(3))
    const thrown = await rejection(probeCommands(new Node(t), ['vlan 20'], { sessionName: NAME, now: clock }))
    expect(thrown).toBeInstanceOf(ConnectError)
    // `MockTransport#dispatch` records `commandLists` BEFORE consulting the script (see the tool's
    // implementation), so even a failing batch shows in `sent()` — that is what proves the probe's
    // own abort ran through the mock too.
    expect(t.sent()).toEqual([
      ['enable', OPEN, 'vlan 20'],
      ['enable', OPEN, 'abort'],
    ])
  })

  it('path 4 — 1006 config lock marks the handle lost, so NO abort batch is sent; outcome reports `configLocked: true`', async () => {
    const t = mockTransport({ address: ADDRESS })
      .rejects(probeKey(OPEN, ['vlan 20']), { code: EapiErrorCode.COMMAND_CONFIG_LOCKED, message: 'SYNTHETIC config lock held elsewhere', data: { result: [] } })
    const outcome = await probeCommands(new Node(t), ['vlan 20'], { sessionName: NAME, now: clock })
    // Only one request went out. The handle was already `lost`, so there was nothing this client
    // could abort (the abort would have re-created a session EOS had just destroyed, DR-023).
    expect(t.sent()).toEqual([['enable', OPEN, 'vlan 20']])
    expect(verdict(outcome).verdict).toBe('config-locked')
    expect(verdict(outcome).code).toBe(EapiErrorCode.COMMAND_CONFIG_LOCKED)
    expect(verdict(outcome).codeSource).toBe('batch')
    expect(outcome.configLocked).toBe(true)
    expect(outcome.session.aborted).toBe(false)
    expect(outcome.session.state).toBe('lost')
    // A 1006 is an *answer* the caller can act on: outcome returned normally, not thrown.
    expect(outcome.probed).toBe(true)
  })

  it('a lock after a partial batch: seen verdicts survive; unseen candidates fill as config-locked in candidate order', async () => {
    const t = mockTransport({ address: ADDRESS })
      .replies(probeKey(OPEN, ['vlan 20']), ack(3))
      .rejects(probeKey(OPEN, ['vlan 30']), { code: EapiErrorCode.COMMAND_CONFIG_LOCKED, message: 'SYNTHETIC lock after first chunk', data: { result: [] } })
    const outcome = await probeCommands(new Node(t), ['vlan 20', 'vlan 30', 'vlan 40'], { sessionName: NAME, batchSize: 1, now: clock })
    expect(outcome.results.map((entry) => entry.verdict)).toEqual(['supported', 'config-locked', 'config-locked'])
    expect(outcome.summary.supported).toBe(1)
    expect(outcome.summary['config-locked']).toBe(2)
    expect(outcome.configLocked).toBe(true)
    expect(outcome.session.aborted).toBe(false)
    // No abort batch here — the handle was already `lost`, so the probe reports so rather than pretending.
    expect(t.sent()).toEqual([['enable', OPEN, 'vlan 20'], ['enable', OPEN, 'vlan 30']])
  })

  it('path 5 — an `onBatch` sink throws: abort runs BEFORE the sink error leaves probeCommands', async () => {
    const t = mockTransport({ address: ADDRESS })
      .replies(probeKey(OPEN, ['vlan 20']), ack(3))
      .replies(probeKey(OPEN, ['abort']), ack(3))
    const thrown = await rejection(probeCommands(new Node(t), ['vlan 20'], {
      sessionName: NAME,
      now: clock,
      onBatch: (progress) => {
        void progress.batchIndex
        throw new Error('SYNTHETIC progress sink broke mid-probe')
      },
    }))
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toMatch(/progress sink broke/u)
    // Even so, the session got ended.
    expect(t.sent()).toEqual([
      ['enable', OPEN, 'vlan 20'],
      ['enable', OPEN, 'abort'],
    ])
  })
})

describe('cleanup failure: a probe that cannot abort is NOT reported as success (DR-023)', () => {
  it('happy probe where `abort` itself failed: `SessionError` names the session, outcome is never returned', async () => {
    const t = mockTransport({ address: ADDRESS })
      .replies(probeKey(OPEN, ['vlan 20']), ack(3))
      .throws(probeKey(OPEN, ['abort']), new ConnectError('SYNTHETIC the abort batch itself could not run'))
    const thrown = await rejection(probeCommands(new Node(t), ['vlan 20'], { sessionName: NAME, now: clock }))
    expect(thrown).toBeInstanceOf(SessionError)
    const message = (thrown as Error).message
    // The message names the session so an operator can clean up by hand (DR-023).
    expect(message).toMatch(/capability probe finished but could not abort config session/u)
    expect(message).toMatch(/node\.abortSession/u)
    // `SessionError#commands` carries the exec-mode re-attach form, redacted like every error.
    expect((thrown as InstanceType<typeof SessionError>).commands).toEqual([`configure session ${NAME} abort`])
    expect(t.sent()).toEqual([['enable', OPEN, 'vlan 20'], ['enable', OPEN, 'abort']])
  })

  it('probe already failed AND the abort failed: onCleanupFailure sees the orphan (primary error still thrown)', async () => {
    let reportedSessionName: string | undefined
    let reportedProbeError: unknown
    let reportedAbortError: unknown
    const t = mockTransport({ address: ADDRESS })
      .throws(probeKey(OPEN, ['vlan 20']), new ConnectError('SYNTHETIC batch failed'))
      .throws(probeKey(OPEN, ['abort']), new ConnectError('SYNTHETIC abort failed too'))
    const thrown = await rejection(probeCommands(new Node(t), ['vlan 20'], {
      sessionName: NAME,
      now: clock,
      onCleanupFailure: (failure) => {
        // The `failure` parameter's type comes from `ProbeCleanupFailure` in `capabilities.ts` —
        // contextual, and this module documents it as the one case where a caller has to see both errors.
        reportedSessionName = failure.sessionName
        reportedProbeError = failure.probeError
        reportedAbortError = failure.error
      },
    }))
    expect(thrown).toBeInstanceOf(ConnectError)
    expect((thrown as Error).message).toMatch(/batch failed/u)
    expect(reportedSessionName).toBe(NAME)
    expect(reportedProbeError).toBeInstanceOf(ConnectError)
    expect(reportedAbortError).toBeInstanceOf(ConnectError)
    expect((reportedProbeError as Error).message).toMatch(/batch failed/u)
    expect(t.sent()).toEqual([['enable', OPEN, 'vlan 20'], ['enable', OPEN, 'abort']])
  })
})

describe('named throwaway session: probe owns the name; session-name rule lives in config-session.ts', () => {
  it('an omitted name still gets DR-047\'s `ui-<host>-p<pid>-<hex8>` shape, not pyeapi\'s anonymous uuid4', async () => {
    // Script with the '*' matcher — the generated name has a random hex tail we cannot predict.
    const t = mockTransport({ address: ADDRESS }).replies('*', ack(3))
    const outcome = await probeCommands(new Node(t), ['vlan 20'], { now: clock })
    expect(outcome.session.name).toMatch(/^ui-sw1\.lan-p\d+-[0-9a-f]{8}$/u)
    expect(outcome.session.opener).toBe(`configure session ${outcome.session.name}`)
    expect(outcome.session.name.startsWith('ui-')).toBe(true)
  })

  it('probeCommands refuses an empty session name at zero round trips (assertSessionName)', async () => {
    const t = mockTransport({ address: ADDRESS })
    const thrown = await rejection(probeCommands(new Node(t), ['vlan 20'], { sessionName: '', now: clock }))
    expect(thrown).toBeInstanceOf(NotSupportedError)
    expect((thrown as Error).message).toMatch(/a config session name may not be empty/u)
    expect(t.callCount()).toBe(0)
    expect(t.sent()).toEqual([])
  })

  it('refuses a whitespace-containing name: `configure session <name>` is cmds[1] of every batch', async () => {
    const t = mockTransport({ address: ADDRESS })
    const thrown = (await rejection(probeCommands(new Node(t), ['vlan 20'], { sessionName: 'ui bad', now: clock }))) as Error
    expect(thrown).toBeInstanceOf(NotSupportedError)
    expect(thrown.message).toMatch(/unsafe config session name "ui bad"/u)
    expect(thrown.message).toMatch(/EOS matches the name with .S\+, SessionCli\.py:31/u)
    // The refusal names only the bad string — no wire data and no secret can be echoed on this path.
    expect(thrown.message).not.toMatch(/password|enable|secret|vlan/u)
    expect(t.callCount()).toBe(0)
    expect(t.sent()).toEqual([])
  })

  it('refuses a session name past the client\'s 64-character bound, before any round trip', async () => {
    const t = mockTransport({ address: ADDRESS })
    const long = 'u'.repeat(65)
    const thrown = (await rejection(probeCommands(new Node(t), ['vlan 20'], { sessionName: long, now: clock }))) as Error
    expect(thrown).toBeInstanceOf(NotSupportedError)
    expect(thrown.message).toMatch(/longer than 64 characters/u)
    expect(thrown.message).toMatch(/EOS's own limit is unverified/u)
    // Only the offending name is echoed — no device payload, and nothing on the wire leaks.
    expect(thrown.message).not.toMatch(/password|enable|vlan/u)
    expect(t.callCount()).toBe(0)
    expect(t.sent()).toEqual([])
  })

  it('the caller\'s session name is spliced verbatim into every batch, so batch keys carry it', async () => {
    const t = mockTransport({ address: ADDRESS })
      .replies(probeKey(OPEN, ['vlan 20']), ack(3))
      .replies(probeKey(OPEN, ['abort']), ack(3))
    const outcome = await probeCommands(new Node(t), ['vlan 20'], { sessionName: NAME, now: clock })
    expect(outcome.session.name).toBe(NAME)
    const abortList = sentAt(t, 1)
    expect(abortList[1]).toBe(OPEN)
  })
})

describe('DR-025: the probe owns its session on this node, so a live one blocks it at zero round trips', () => {
  it('cannot probeCommands() while a caller\'s session is open: SessionError, sent() stays empty', async () => {
    const t = mockTransport({ address: ADDRESS })
      .replies('enable\nconfigure session ui-manual\nabort', ack(3))
      .replies(probeKey(OPEN, ['vlan 20']), ack(3))
      .replies(probeKey(OPEN, ['abort']), ack(3))
    const node = new Node(t)
    const manual = await node.configSession({ name: 'ui-manual' })
    const error = await rejection(probeCommands(node, ['vlan 20'], { sessionName: NAME, now: clock }))
    expect(error).toBeInstanceOf(SessionError)
    expect((error as Error).message).toMatch(/cannot probeCommands\(\) while config session "ui-manual" is open/u)
    expect(t.sent()).toEqual([])
    // Once the caller ends theirs, the probe can run on this same node.
    await manual.abort()
    expect(t.sent()).toEqual([['enable', 'configure session ui-manual', 'abort']])
    const outcome = await probeCommands(node, ['vlan 20'], { sessionName: NAME, now: clock })
    expect(verdict(outcome).verdict).toBe('supported')
    expect(t.sent().length).toBe(3)
    expect(sentAt(t, 2)).toEqual(['enable', OPEN, 'abort'])
  })
})

describe('featureProbeCommands label seam: caller-supplied map; malformed maps refuse at zero round trips', () => {
  it('a feature that lists a candidate stamps that name and only that name onto the result', async () => {
    const t = mockTransport({ address: ADDRESS })
      .replies(probeKey(OPEN, ['vlan 20']), ack(3))
      .replies(probeKey(OPEN, ['abort']), ack(3))
    const features: Record<string, readonly string[]> = {
      webui: ['vlan 20'],
      'east-wing': ['vlan 20', 'vlan 30'],
    }
    const outcome = await probeCommands(new Node(t), ['vlan 20'], { sessionName: NAME, featureProbeCommands: features, now: clock })
    expect(verdict(outcome).features).toEqual(['webui', 'east-wing'])
    expect(verdict(outcome).verdict).toBe('supported')
    // `east-wing` also mentions `vlan 30`, but that candidate wasn't offered, so the caller owns that.
  })

  it('a feature that does not name any of the candidates leaves verdicts bare — the package never interprets a name', async () => {
    const features: Record<string, readonly string[]> = { webui: ['vlan 999'] }
    const t = mockTransport({ address: ADDRESS })
      .replies(probeKey(OPEN, ['vlan 20']), ack(3))
      .replies(probeKey(OPEN, ['abort']), ack(3))
    const outcome = await probeCommands(new Node(t), ['vlan 20'], { sessionName: NAME, featureProbeCommands: features, now: clock })
    expect(outcome.results.map((entry) => entry.features)).toEqual([[]])
  })

  it('an empty command list under a named feature refuses: an "empty probed" feature would lie in a UI', async () => {
    const t = mockTransport({ address: ADDRESS })
    const error = await rejection(probeCommands(new Node(t), ['vlan 20'], { sessionName: NAME, now: clock, featureProbeCommands: { webui: [] } }))
    expect(error).toBeInstanceOf(TypeError)
    expect((error as Error).message).toMatch(/featureProbeCommands\["webui"\] must be a non-empty array/u)
    expect(t.callCount()).toBe(0)
    expect(t.sent()).toEqual([])
  })

  it('an empty (or whitespace-only) feature name refuses; zero commands sent', async () => {
    const t = mockTransport({ address: ADDRESS })
    const error = await rejection(probeCommands(new Node(t), ['vlan 20'], { sessionName: NAME, now: clock, featureProbeCommands: { ' ': ['vlan 20'] } }))
    expect(error).toBeInstanceOf(TypeError)
    expect((error as Error).message).toMatch(/featureProbeCommands has an empty feature name/u)
    expect(t.callCount()).toBe(0)
    expect(t.sent()).toEqual([])
  })
})

describe('candidate / batch guards run before the first request (c: zero round trips)', () => {
  it('an empty candidate list is refused: an empty probe would render "0 unsupported" as "all supported"', async () => {
    const t = mockTransport({ address: ADDRESS })
    const error = await rejection(probeCommands(new Node(t), [], { sessionName: NAME, now: clock }))
    expect(error).toBeInstanceOf(TypeError)
    expect((error as Error).message).toMatch(/needs at least one candidate command/u)
    expect(t.callCount()).toBe(0)
    expect(t.sent()).toEqual([])
  })

  it('a non-array candidate list is refused. Cast with `unknown` (bare `as readonly string[]` would hit TS2352)', async () => {
    const t = mockTransport({ address: ADDRESS })
    const error = await rejection(probeCommands(new Node(t), { cmd: 'vlan 20' } as unknown as readonly string[], { sessionName: NAME, now: clock }))
    expect(error).toBeInstanceOf(TypeError)
    expect((error as Error).message).toMatch(/needs an array of candidate command strings, got object/u)
    expect(t.callCount()).toBe(0)
  })

  it('a non-string element in the list is refused: {cmd,input} cannot match the device\'s echoed `cmd`', async () => {
    const t = mockTransport({ address: ADDRESS })
    const error = await rejection(probeCommands(new Node(t), ['vlan 20', { cmd: 'vlan 30' } as unknown as string], { sessionName: NAME, now: clock }))
    expect(error).toBeInstanceOf(TypeError)
    expect((error as Error).message).toMatch(/probe candidate 1 is object, not a command string/u)
    expect(t.callCount()).toBe(0)
  })

  it('an empty-string candidate is refused at its position, not silently dropped', async () => {
    const t = mockTransport({ address: ADDRESS })
    const error = await rejection(probeCommands(new Node(t), ['vlan 20', ''], { sessionName: NAME, now: clock }))
    expect(error).toBeInstanceOf(TypeError)
    expect((error as Error).message).toMatch(/probe candidate 1 is empty/u)
  })

  it('a candidate containing a control character is refused: one CLI line per candidate', async () => {
    const t = mockTransport({ address: ADDRESS })
    const error = await rejection(probeCommands(new Node(t), ['show clock\nabort'], { sessionName: NAME, now: clock }))
    expect(error).toBeInstanceOf(NotSupportedError)
    expect((error as Error).message).toMatch(/contains a control character/u)
    expect(t.callCount()).toBe(0)
  })

  it('a duplicate candidate is refused: verdicts are per command, so a caller zipping by index would double-count', async () => {
    const t = mockTransport({ address: ADDRESS })
    const error = await rejection(probeCommands(new Node(t), ['vlan 20', 'vlan 30', 'vlan 20'], { sessionName: NAME, now: clock }))
    expect(error).toBeInstanceOf(TypeError)
    expect((error as Error).message).toMatch(/appears more than once/u)
    expect(t.callCount()).toBe(0)
  })

  // PROBE_FORBIDDEN_COMMANDS is this client's rule (capabilities.ts), not the device's. The loop is
  // over plain string literals only, so no union-inferred element hides a wrong-typed arg.
  for (const forbidden of ['commit timer 00:05:00', 'abort', 'configure session other-1', 'configure replace flash:x', 'reload', 'copy running-config startup-config']) {
    it(`refuses the forbidden candidate "${forbidden.split(' ')[0]}" — PROBE_FORBIDDEN_COMMANDS prefix rule, zero sends`, async () => {
      const t = mockTransport({ address: ADDRESS })
      const error = await rejection(probeCommands(new Node(t), [forbidden], { sessionName: NAME, now: clock }))
      expect(error).toBeInstanceOf(NotSupportedError)
      expect((error as Error).message).match(/^probe candidate/u)
      expect(t.callCount()).toBe(0)
    })
  }

  it('batchSize 0 is refused: the assertBatchSize positive-integer rule is ours, not a device quirk', async () => {
    const t = mockTransport({ address: ADDRESS })
    const error = await rejection(probeCommands(new Node(t), ['vlan 20'], { sessionName: NAME, batchSize: 0, now: clock }))
    expect(error).toBeInstanceOf(TypeError)
    expect((error as Error).message).toMatch(/batchSize must be a positive integer/u)
    expect(t.callCount()).toBe(0)
  })

  it('a fractional batchSize is refused, so chunk() never silently floors the split point', async () => {
    const t = mockTransport({ address: ADDRESS })
    const error = await rejection(probeCommands(new Node(t), ['vlan 20'], { sessionName: NAME, batchSize: 2.5, now: clock }))
    expect(error).toBeInstanceOf(TypeError)
    expect((error as Error).message).toMatch(/positive integer/u)
    expect(t.callCount()).toBe(0)
  })
})

describe('createCapabilityCache: hit / TTL expiry / keying / DR-032 no-store for inconclusive runs', () => {
  it('a miss probes once, stores one entry, and returns the outcome', async () => {
    const now = () => 0
    const t = mockTransport({ address: ADDRESS })
      .replies(probeKey(CACHE_OPEN, ['vlan 20']), ack(3))
      .replies(probeKey(CACHE_OPEN, ['abort']), ack(3))
    const cache = createCapabilityCache({ now, sessionName: CACHE_NAME })
    const outcome = await cache.probe(new Node(t), ['vlan 20'])
    expect(verdict(outcome).verdict).toBe('supported')
    expect(cache.size).toBe(1)
    expect(cache.endpoints()).toEqual([ADDRESS])
    const peek = cache.peek(ADDRESS, ['vlan 20'])
    expect(peek?.entry.endpoint).toBe(ADDRESS)
    expect(peek?.fresh).toBe(true)
    expect(peek?.remainingMs).toBe(DEFAULT_CAPABILITY_TTL_MS)
    expect(t.sent()).toEqual([['enable', CACHE_OPEN, 'vlan 20'], ['enable', CACHE_OPEN, 'abort']])
  })

  it('a fresh hit returns the stored outcome and opens no new request on the transport', async () => {
    const now = () => 0
    const t = mockTransport({ address: ADDRESS })
      .replies(probeKey(CACHE_OPEN, ['vlan 20']), ack(3))
      .replies(probeKey(CACHE_OPEN, ['abort']), ack(3))
    const cache = createCapabilityCache({ now, sessionName: CACHE_NAME })
    const node = new Node(t)
    const first = await cache.probe(node, ['vlan 20'])
    const before = t.sent().length
    const second = await cache.probe(node, ['vlan 20'])
    expect(second).toEqual(first)
    // Nothing new reached the transport: sent() is unchanged, so no second config session was opened.
    expect(t.sent().length).toBe(before)
    expect(cache.size).toBe(1)
  })

  it('an expired entry re-probes on an injectable clock — cache TTLs are policy, not wall-time', async () => {
    let current = 0
    const now = () => current
    const t = mockTransport({ address: ADDRESS })
      .replies(probeKey(CACHE_OPEN, ['vlan 20']), ack(3))
      .replies(probeKey(CACHE_OPEN, ['abort']), ack(3))
    const cache = createCapabilityCache({ ttlMs: 100, now, sessionName: CACHE_NAME })
    await cache.probe(new Node(t), ['vlan 20'])
    current = 150
    const peek = cache.peek(ADDRESS, ['vlan 20'])
    expect(peek?.fresh).toBe(false)
    // `remainingMs` is signed so a UI can render "stale since 50 ms ago".
    expect(peek?.remainingMs).toBe(-50)
    // Freshness is what a caller checks before trusting an entry: not fresh → re-probe.
    await cache.probe(new Node(t), ['vlan 20'])
    expect(t.sent().length).toBe(4)
  })

  it('two transports are keyed on `Transport#address`, so a second endpoint never reads a first\'s entry', async () => {
    const t1 = mockTransport({ address: ADDRESS }).replies(probeKey(CACHE_OPEN, ['vlan 20']), ack(3)).replies(probeKey(CACHE_OPEN, ['abort']), ack(3))
    const t2 = mockTransport({ address: OTHER_ADDRESS }).replies(probeKey(CACHE_OPEN, ['vlan 20']), ack(3)).replies(probeKey(CACHE_OPEN, ['abort']), ack(3))
    const cache = createCapabilityCache({ sessionName: CACHE_NAME, now: clock })
    await cache.probe(new Node(t1), ['vlan 20'])
    await cache.probe(new Node(t2), ['vlan 20'])
    expect(cache.size).toBe(2)
    expect(cache.endpoints()).toEqual([ADDRESS, OTHER_ADDRESS])
    expect(cache.entries(ADDRESS)).toHaveLength(1)
    expect(cache.entries(OTHER_ADDRESS)).toHaveLength(1)
    // Each probe reached its own transport, so the cached answer for one never answered the other.
    expect(t1.sent().length).toBe(2)
    expect(t2.sent().length).toBe(2)
  })

  it('the candidate list is part of the key: two different probe sets share one endpoint but split entries', async () => {
    const t = mockTransport({ address: ADDRESS })
      .replies(probeKey(CACHE_OPEN, ['vlan 20']), ack(3))
      .replies(probeKey(CACHE_OPEN, ['vlan 30']), ack(3))
      .replies(probeKey(CACHE_OPEN, ['abort']), ack(3))
    const cache = createCapabilityCache({ sessionName: CACHE_NAME })
    const node = new Node(t)
    await cache.probe(node, ['vlan 20'])
    await cache.probe(node, ['vlan 30'])
    expect(cache.size).toBe(2)
    expect(cache.endpoints()).toEqual([ADDRESS])
    // Four probes total: two batch requests + two abort requests.
    const probeCount = t.callCount()
    expect(probeCount).toBe(4)
    expect(t.sent().length).toBe(4)
  })

  it('cache with ttlMs: 0 stores nothing (0 means "cache nothing", not "cache forever")', async () => {
    const t = mockTransport({ address: ADDRESS })
      .replies(probeKey(CACHE_OPEN, ['vlan 20']), ack(3))
      .replies(probeKey(CACHE_OPEN, ['abort']), ack(3))
    const cache = createCapabilityCache({ ttlMs: 0, sessionName: CACHE_NAME, now: clock })
    const outcome = await cache.probe(new Node(t), ['vlan 20'])
    expect(verdict(outcome).verdict).toBe('supported')
    expect(cache.size).toBe(0)
    expect(cache.peek(ADDRESS, ['vlan 20'])).toBeUndefined()
  })

  it('an outcome with an inconclusive verdict is never stored (DR-032: unverifiable ≠ stored fact)', async () => {
    const t = mockTransport({ address: ADDRESS })
      .rejects(probeKey(CACHE_OPEN, ['vlan 20']), {
        code: EapiErrorCode.COMMAND_FAILED,
        message: 'SYNTHETIC: unmapped per-command code on the only candidate',
        data: { result: [{}], errorDetail: [{ index: 2, code: EapiErrorCode.COMMAND_EXCEPTION, message: 'SYNTHETIC crash', cmd: 'vlan 20' }] },
      })
      .replies(probeKey(CACHE_OPEN, ['abort']), ack(3))
    const cache = createCapabilityCache({ sessionName: CACHE_NAME, now: clock })
    const first = await cache.probe(new Node(t), ['vlan 20'])
    expect(verdict(first).verdict).toBe('unknown')
    expect(cache.size).toBe(0)
    // The second call did not hit; it probed again and the transport saw two fresh request pairs.
    const again = await cache.probe(new Node(t), ['vlan 20'])
    expect(t.sent().length).toBe(4)
    expect(verdict(again).verdict).toBe('unknown')
  })

  it('a session-locked run (1006 handle killed) is likewise never stored — a lock is not a feature answer', async () => {
    const t = mockTransport({ address: ADDRESS })
      .rejects(probeKey(CACHE_OPEN, ['vlan 20']), { code: EapiErrorCode.COMMAND_CONFIG_LOCKED, message: 'SYNTHETIC config lock', data: { result: [] } })
    const cache = createCapabilityCache({ sessionName: CACHE_NAME, now: clock })
    const outcome = await cache.probe(new Node(t), ['vlan 20'])
    expect(outcome.configLocked).toBe(true)
    expect(cache.size).toBe(0)
    // Same for the next attempt: re-probed, since nothing was remembered.
    await cache.probe(new Node(t), ['vlan 20'])
    expect(t.sent().length).toBe(2)
  })

  it('invalidate(endpoint) drops exactly one endpoint\'s entries; other endpoints survive', async () => {
    const t1 = mockTransport({ address: ADDRESS }).replies(probeKey(CACHE_OPEN, ['vlan 20']), ack(3)).replies(probeKey(CACHE_OPEN, ['abort']), ack(3))
    const t2 = mockTransport({ address: OTHER_ADDRESS }).replies(probeKey(CACHE_OPEN, ['vlan 20']), ack(3)).replies(probeKey(CACHE_OPEN, ['abort']), ack(3))
    const cache = createCapabilityCache({ sessionName: CACHE_NAME, now: clock })
    await cache.probe(new Node(t1), ['vlan 20'])
    await cache.probe(new Node(t2), ['vlan 20'])
    expect(cache.size).toBe(2)
    const dropped = cache.invalidate(ADDRESS)
    expect(dropped).toBe(1)
    expect(cache.size).toBe(1)
    expect(cache.endpoints()).toEqual([OTHER_ADDRESS])
    // A probe to the invalidated endpoint now hits the store-empty miss path and probes fresh.
    await cache.probe(new Node(t1), ['vlan 20'])
    expect(t1.sent().length).toBe(4)
  })

  it('clear() drops everything and reports how many', async () => {
    const t = mockTransport({ address: ADDRESS }).replies(probeKey(CACHE_OPEN, ['vlan 20']), ack(3)).replies(probeKey(CACHE_OPEN, ['abort']), ack(3))
    const cache = createCapabilityCache({ sessionName: CACHE_NAME, now: clock })
    await cache.probe(new Node(t), ['vlan 20'])
    expect(cache.size).toBe(1)
    expect(cache.clear()).toBe(1)
    expect(cache.size).toBe(0)
    expect(cache.endpoints()).toEqual([])
    expect(cache.entries()).toEqual([])
  })
})

describe('pure helpers: verdict predicates and the TTL default (no device, no MockTransport)', () => {
  it('isUnavailableVerdict answers only `unsupported` — 1004/1005/1006 are not statements about a feature', () => {
    expect(isUnavailableVerdict('unsupported')).toBe(true)
    expect(isUnavailableVerdict('incompatible')).toBe(false)
    expect(isUnavailableVerdict('unauthorized')).toBe(false)
    expect(isUnavailableVerdict('config-locked')).toBe(false)
    expect(isUnavailableVerdict('not-rejected')).toBe(false)
    expect(isUnavailableVerdict('supported')).toBe(false)
    expect(isUnavailableVerdict('unknown')).toBe(false)
  })

  it('isInconclusiveVerdict names what "nothing usable was answered" — `config-locked` and `unknown`', () => {
    expect(isInconclusiveVerdict('config-locked')).toBe(true)
    expect(isInconclusiveVerdict('unknown')).toBe(true)
    expect(isInconclusiveVerdict('supported')).toBe(false)
    expect(isInconclusiveVerdict('not-rejected')).toBe(false)
    // `unsupported` is the negative verdict, not an inconclusive one — it is a feature answer.
    expect(isInconclusiveVerdict('unsupported')).toBe(false)
    expect(isInconclusiveVerdict('incompatible')).toBe(false)
    expect(isInconclusiveVerdict('unauthorized')).toBe(false)
  })

  it('DEFAULT_CAPABILITY_TTL_MS (15 min) is our policy, not a device property, and > 0', () => {
    expect(DEFAULT_CAPABILITY_TTL_MS).toBe(15 * 60_000)
    const cache = createCapabilityCache()
    // Sanity gate: a default cache without `ttlMs` still counts 15 min as cacheable, and
    // `ttlMs: 0` opts out. This test does not wait; it only reads the constant.
    expect(cache.size).toBe(0)
  })
})

