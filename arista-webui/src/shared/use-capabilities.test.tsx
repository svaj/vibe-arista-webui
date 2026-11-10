/**
 * F5 (#67): `src/shared/use-capabilities.ts` pinned offline through the `./testing` seam
 * (`createFakeNode` + `MockTransport`) — docs/TESTING.md §3/CAP-TESTING. Every script below is a
 * wire-level answer, so the real client code runs end-to-end: the config-session opener, the
 * probe batch, the always-abort guarantee, the error-code classification, and the cache. No test
 * here claims anything about a real 7050TX-64 — the envelopes are SYNTHETIC stand-ins, exactly as
 * in the client's own `capabilities.test.ts` (its case-(b) rule: pin OUR mapping, never device prose).
 *
 * The three acceptance behaviours the issue names each get their own case:
 * - a probe that throws still shows `abort` issued (plus the pending-session affordance);
 * - an inconclusive run never renders `available` (and an `unknown` run is never cached);
 * - a cached run issues no second `runCmds`.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { createFakeNode } from '@devhax-heavy-industries/arista-eapi/testing'
import { ConnectError, createCapabilityCache, EapiErrorCode } from '@devhax-heavy-industries/arista-eapi'
import type { CapabilityCache, CommandProbeResult, ProbeCommandsOutcome } from '@devhax-heavy-industries/arista-eapi'

import { capabilityDisplay, candidateList, useCapabilities } from './use-capabilities'
import type { UseCapabilitiesOptions } from './use-capabilities'

const ADDRESS = 'https://sw1.lan:443/command-api'
/** Fixed probe-session name, so the wire keys are deterministic (client DR-047's default has a hex tail). */
const NAME = 'ui-caps'
const OPEN = `configure session ${NAME} no-commit`
/** `Node.runCommands` prepends `enable`; `ConfigSession#send` re-prepends the opener on every batch. */
const probeKey = (tail: readonly string[]): string => ['enable', OPEN, ...tail].join('\n')
const ACK_ABORT = probeKey(['abort'])

/** Empty per-command replies, one per wire command (see `capabilities.test.ts`'s `ack`). */
function ack(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, () => ({}))
}

function Harness({ options }: { readonly options: UseCapabilitiesOptions }) {
  const result = useCapabilities(options)
  const view = result.view
  return <div>
    <p role="status" aria-live="polite">
      probe: {view.status}{view.fromCache ? ' · from cache' : ''}{view.configLocked ? ' · config lock' : ''}
    </p>
    {view.failure !== undefined && <p role="alert">{view.failure}</p>}
    <ul aria-label="Device capabilities">
      {view.features.map((feature) => <li key={feature.name}>{feature.name}: {feature.display} — {feature.reason}</li>)}
    </ul>
    <p>suppressed: {view.suppressedCount}</p>
    <p>source: {view.lastProbeSource ?? 'none'}</p>
    {/* The #77 pass-through: where the answer came from, what the store kept, and the session the
        probe actually opened (name + whether the guaranteed abort landed). */}
    <p>stored: {view.cacheRemainingMs !== undefined ? 'entry' : view.cacheNote ?? 'nothing yet'}</p>
    <p>last session: {view.lastOutcome?.session.name ?? 'none'}/{view.lastOutcome?.session.state ?? '-'} aborted={String(view.lastOutcome?.session.aborted ?? false)} batches={view.lastOutcome?.batchCount ?? 0}</p>
    <p>pending: {view.pendingSessions.length === 0 ? 'none' : view.pendingSessions.map((session) => session.name).join(', ')}</p>
    <button type="button" onClick={() => void result.probe()}>Check again</button>
    <button type="button" onClick={() => void result.abortPendingSessions()} disabled={view.pendingSessions.length === 0}>Abort pending sessions</button>
  </div>
}

/** The device-capability row for one feature, e.g. `trunkGroups: available — …`. */
function renderedRow(name: string): string {
  const items = screen.getAllByRole('listitem')
  const row = items.find((item) => item.textContent?.startsWith(`${name}:`) ?? false)
  if (row === undefined) throw new Error(`SYNTHETIC spec failure: no capability row for ${name} among ${items.map((item) => item.textContent).join(' | ')}`)
  return row.textContent ?? ''
}

/** Probe batches with candidates (the abort batch shares the opener slot, so key on its tail). */
const chunkBatches = (sent: readonly (readonly unknown[])[]): number =>
  sent.filter((list) => list[1] === OPEN && list[list.length - 1] !== 'abort').length

describe('useCapabilities — verdict rendering through the ./testing seam (CAP-TESTING, #67)', () => {
  it('renders available when the device accepts every candidate, dedupes shared commands, and always aborts', async () => {
    const candidates = ['switchport trunk group lab0', 'switchport mode trunk']
    const fake = createFakeNode({}, { transport: { address: ADDRESS } })
    fake.transport
      .replies(probeKey(candidates), ack(candidates.length + 2))
      .replies(ACK_ABORT, ack(3))
    render(<Harness options={{
      node: fake.node,
      sessionName: NAME,
      featureProbeCommands: {
        trunkGroups: ['switchport trunk group lab0'],
        portMode: ['switchport mode trunk', 'switchport trunk group lab0'],
      },
    }} />)

    expect(await screen.findByText(/trunkGroups: available/u)).toBeInTheDocument()
    expect(renderedRow('portMode')).toContain('available')
    // One batch carrying the DEDUPED candidate list, then the guaranteed always-abort.
    expect(fake.transport.sent()).toEqual([
      ['enable', OPEN, ...candidates],
      ['enable', OPEN, 'abort'],
    ])
    expect(screen.getByRole('status')).toHaveTextContent('probe: ready')
    expect(screen.getByRole('status')).not.toHaveTextContent('from cache')
  })

  it('renders unavailable only from a per-command 1002, naming the code that answered', async () => {
    const fake = createFakeNode({}, { transport: { address: ADDRESS } })
    fake.transport
      .rejects(probeKey(['switchport trunk group lab0']), {
        code: EapiErrorCode.COMMAND_INVALID,
        message: 'SYNTHETIC: the batch reported a CLI-grammar rejection',
        data: {
          result: [{}, {}, { errors: ['SYNTHETIC'] }],
          errorDetail: [{ index: 2, code: EapiErrorCode.COMMAND_INVALID, message: 'SYNTHETIC no such trunk group', cmd: 'switchport trunk group lab0' }],
        },
      })
      .replies(ACK_ABORT, ack(3))
    render(<Harness options={{ node: fake.node, sessionName: NAME, featureProbeCommands: { trunkGroups: ['switchport trunk group lab0'] } }} />)

    const row = await screen.findByText(/trunkGroups: unavailable/u)
    expect(row).toHaveTextContent('switchport trunk group lab0')
    expect(row).toHaveTextContent('COMMAND_INVALID')
    // The batch failure rides into the alert slot (honest: something went wrong AND it was a grammar answer).
    expect(await screen.findByRole('alert')).toHaveTextContent('SYNTHETIC: the batch reported a CLI-grammar rejection')
    expect(fake.transport.sent()).toEqual([
      ['enable', OPEN, 'switchport trunk group lab0'],
      ['enable', OPEN, 'abort'],
    ])
  })

  it('an incompatible (1004) answer renders unknown, never available — the eAPI context said no, not the feature', async () => {
    const fake = createFakeNode({}, { transport: { address: ADDRESS } })
    fake.transport
      .rejects(probeKey(['vlan note']), {
        code: EapiErrorCode.COMMAND_FAILED,
        message: 'SYNTHETIC: the batch failed in this context',
        data: {
          result: [{}, {}, {}],
          errorDetail: [{ index: 2, code: EapiErrorCode.COMMAND_INCOMPATIBLE, message: 'SYNTHETIC wrong exec mode', cmd: 'vlan note' }],
        },
      })
      .replies(ACK_ABORT, ack(3))
    render(<Harness options={{ node: fake.node, sessionName: NAME, featureProbeCommands: { vlanNotes: ['vlan note'] } }} />)

    const row = await screen.findByText(/vlanNotes: unknown/u)
    expect(row).toHaveTextContent('incompatible')
    expect(renderedRow('vlanNotes')).not.toMatch(/: (available|unavailable)/u)
  })

  it('an unknown run is NOT cached: re-checking reaches the wire again (rate limit off for the test)', async () => {
    const fake = createFakeNode({}, { transport: { address: ADDRESS } })
    // No per-command mapping this client knows: the `errorDetail` code is unmapped, so every
    // candidate answers `unknown` with the raw batch error carried — and the client cache refuses to
    // store it (isCacheable, DR-063), unlike a `not-rejected` fold.
    fake.transport
      .rejects(probeKey(['vlan note']), {
        code: EapiErrorCode.COMMAND_FAILED,
        message: 'SYNTHETIC unmapped batch failure with an unmapped per-command code',
        data: {
          result: [{}, {}, {}],
          errorDetail: [{ index: 2, code: EapiErrorCode.COMMAND_FAILED, message: 'SYNTHETIC unmapped per-command code', cmd: 'vlan note' }],
        },
      })
      .replies(ACK_ABORT, ack(3))
    render(<Harness options={{ node: fake.node, sessionName: NAME, throttleMs: 0, featureProbeCommands: { vlanNotes: ['vlan note'] } }} />)

    expect(await screen.findByText(/vlanNotes: unknown/u)).toHaveTextContent('not cached')
    await userEvent.click(screen.getByRole('button', { name: 'Check again' }))
    // Two probes reached the device: chunk+abort twice.
    expect(fake.transport.sent()).toHaveLength(4)
    expect(screen.getByRole('status')).not.toHaveTextContent('from cache')
  })

  it('a probe that SETTLES on the config lock still asks which sessions hold it (DR-062 affordance)', async () => {
    // The 1006 the client treats as an ANSWER, not a failure: `configLocked` rides a ready outcome, so the
    // throw path's pending-session question would otherwise never run for the common case (a locked config
    // that is locked precisely because some session is sitting pending).
    const listSessions = vi.fn(async () => ({ sessions: [{ name: 'stale-pending', state: 'pending' as const, description: 'holds the lock' }] }))
    const node = { listSessions, activeConfigSession: undefined } as unknown as UseCapabilitiesOptions['node']
    const locked: ProbeCommandsOutcome = {
      results: [{
        command: 'vlan note',
        verdict: 'config-locked',
        code: EapiErrorCode.COMMAND_CONFIG_LOCKED,
        codeName: 'COMMAND_CONFIG_LOCKED',
        message: 'SYNTHETIC 1006 the configuration is locked',
        batchIndex: 0,
        unavailable: false,
        features: ['vlanNotes'],
      }],
      errorDetail: [],
      batchCount: 1,
      session: { name: NAME, state: 'aborted', aborted: true, noCommit: true, opener: 'ui-caps' },
      configLocked: true,
      probed: true,
      startedAt: 0,
      finishedAt: 1,
      elapsedMs: 1,
      summary: { supported: 0, 'not-rejected': 0, unsupported: 0, incompatible: 0, unauthorized: 0, 'config-locked': 1, unknown: 0 },
    }
    const cache = { peek: () => undefined, probe: async () => locked } as unknown as CapabilityCache

    render(<Harness options={{ node, cache, featureProbeCommands: { vlanNotes: ['vlan note'] } }} />)

    expect(await screen.findByText('probe: ready · config lock')).toBeInTheDocument()
    expect(renderedRow('vlanNotes')).toContain('config-locked')
    await screen.findByText('pending: stale-pending')
    expect(listSessions).toHaveBeenCalledOnce()
    // And the cleanup affordance the row feeds is wired to that answer.
    expect(screen.getByRole('button', { name: 'Abort pending sessions' })).toBeEnabled()
  })

  it('a fresh cache answers without ANY second round trip (the cached run issues no new batches)', async () => {
    const fake = createFakeNode({}, { transport: { address: ADDRESS } })
    fake.transport.replies(probeKey(['vlan note']), ack(3)).replies(ACK_ABORT, ack(3))
    // The default cache this hook builds has the client's 15-min TTL: the second check must be answered
    // from the stored outcome, which is what keeps re-renders off the config lock.
    render(<Harness options={{ node: fake.node, sessionName: NAME, featureProbeCommands: { vlanNotes: ['vlan note'] } }} />)

    expect(await screen.findByText(/vlanNotes: available/u)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(await screen.findByText('probe: ready · from cache')).toBeInTheDocument()
    expect(fake.transport.sent()).toEqual([
      ['enable', OPEN, 'vlan note'],
      ['enable', OPEN, 'abort'],
    ])
    expect(chunkBatches(fake.transport.sent())).toBe(1)
    // The #77 cache-transparency pass-through: the stored entry is reportable with time left on it.
    expect(screen.getByText('source: cache')).toBeInTheDocument()
    expect(screen.getByText('stored: entry')).toBeInTheDocument()
  })

  it('a probe that THROWS still shows the abort issued, surfaces pending sessions, and cleans them up on demand', async () => {
    const fake = createFakeNode({
      // Wire shape per the pinned fixture `show-configuration-sessions--pending-orphans.json`:
      // `sessions` is an OBJECT keyed by session name, each entry carrying state/description/instances.
      replies: { 'show configuration sessions': { sessions: { [NAME]: { state: 'pending', description: '', instances: {} } } } },
    }, { transport: { address: ADDRESS } })
    fake.transport
      .throws(probeKey(['vlan note']), new ConnectError('SYNTHETIC the switch went offline mid-probe'))
      .replies(ACK_ABORT, ack(3))
      .replies(['enable', `configure session ${NAME} abort`].join('\n'), ack(2))
    render(<Harness options={{ node: fake.node, sessionName: NAME, featureProbeCommands: { vlanNotes: ['vlan note'] } }} />)

    // The failure is not left as a bare error: the DR-062 affordance asks the device WHO holds the
    // lock and offers the cleanup.
    expect(await screen.findByRole('alert')).toHaveTextContent('went offline mid-probe')
    expect(await screen.findByText('pending: ui-caps')).toBeInTheDocument()
    const probeBatches = fake.transport.sent()
    expect(probeBatches).toEqual([
      ['enable', OPEN, 'vlan note'],
      ['enable', OPEN, 'abort'],
      // The affordance's own read:
      ['enable', 'show configuration sessions'],
    ])

    await userEvent.click(screen.getByRole('button', { name: 'Abort pending sessions' }))
    // `abortSession(name)` is the exec-mode re-attach form, distinct from the in-session abort the
    // probe itself issues.
    expect(fake.transport.sent()).toContainEqual(['enable', `configure session ${NAME} abort`])
    // The cleanup resets the rate limiter so the forced re-probe actually runs (it throws again here —
    // the device never came back — which is honest, and the alert still shows it).
    expect(await screen.findByRole('alert')).toHaveTextContent('went offline mid-probe')
  })

  it('the rate limiter refuses a probe inside the window and records the refusal, then lets it through', async () => {
    let clockMs = 10_000
    const candidates = ['vlan note']
    const fake = createFakeNode({}, { transport: { address: ADDRESS } })
    fake.transport.replies(probeKey(candidates), ack(3)).replies(ACK_ABORT, ack(3))
    render(<Harness options={{
      node: fake.node,
      sessionName: NAME,
      ttlMs: 0,
      throttleMs: 5_000,
      now: () => clockMs,
      featureProbeCommands: { vlanNotes: candidates },
    }} />)

    expect(await screen.findByText(/vlanNotes: available/u)).toBeInTheDocument()
    expect(fake.transport.sent()).toHaveLength(2)

    // Frozen clock: the re-check never reaches the device and says so.
    await userEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(await screen.findByText('suppressed: 1')).toBeInTheDocument()
    expect(fake.transport.sent()).toHaveLength(2)

    // Outside the window the probe runs again — `ttlMs: 0` proves the throttle, not the cache, gated it.
    clockMs = 20_000
    await userEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await screen.findByText('probe: ready')
    expect(fake.transport.sent()).toHaveLength(4)
    expect(screen.getByText('suppressed: 1')).toBeInTheDocument()
  })

  it('no node (proxy unconfigured): stays idle without a probe or an error', () => {
    render(<Harness options={{ node: undefined, featureProbeCommands: { vlanNotes: ['vlan note'] } }} />)

    expect(screen.getByRole('status')).toHaveTextContent('probe: idle')
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Abort pending sessions' })).toBeDisabled()
  })

  it('an explicit shared cache survives remounts so both screens pay for one session', async () => {
    const shared = createCapabilityCache({ sessionName: NAME })
    const fake = createFakeNode({}, { transport: { address: ADDRESS } })
    fake.transport.replies(probeKey(['vlan note']), ack(3)).replies(ACK_ABORT, ack(3))
    const options: UseCapabilitiesOptions = { node: fake.node, cache: shared, featureProbeCommands: { vlanNotes: ['vlan note'] } }
    render(<Harness options={options} />)
    expect(await screen.findByText(/vlanNotes: available/u)).toBeInTheDocument()

    // A second screen instance (remount) with the same shared cache reads the stored answer.
    const { rerender } = render(<Harness options={options} />)
    rerender(<Harness options={options} />)
    await screen.findByText('probe: ready · from cache')
    expect(fake.transport.sent()).toHaveLength(2)
  })
})

describe('probeTrigger (#123) — "ask, never volunteer" is a knob, not an enabled:false misunderstanding', () => {
  it('manual: the mount opens NO config session, and the operator button then probes for real', async () => {
    const candidates = ['vlan note']
    const fake = createFakeNode({}, { transport: { address: ADDRESS } })
    fake.transport.replies(probeKey(candidates), ack(3)).replies(ACK_ABORT, ack(3))
    render(<Harness options={{
      node: fake.node,
      sessionName: NAME,
      probeTrigger: 'manual',
      featureProbeCommands: { vlanNotes: candidates },
    }} />)

    // Zero wire at mount — the whole point: an uncached probe costs a config session, so a manual
    // screen must not charge it before the operator asks (#123, DR-063).
    expect(screen.getByRole('status')).toHaveTextContent('probe: idle')
    expect(fake.transport.sent()).toHaveLength(0)
    expect(screen.getByText('source: none')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(await screen.findByText(/vlanNotes: available/u)).toBeInTheDocument()
    expect(fake.transport.sent()).toEqual([
      ['enable', OPEN, ...candidates],
      ['enable', OPEN, 'abort'],
    ])
    expect(screen.getByText('source: network')).toBeInTheDocument()
    expect(screen.getByText('stored: entry')).toBeInTheDocument()
    // The outcome pass-through #77's verdict table needs: the session the probe opened, its state,
    // that the guaranteed abort landed, and the batch count.
    expect(screen.getByText(`last session: ${NAME}/aborted aborted=true batches=1`)).toBeInTheDocument()
  })

  it('manual keeps every other F5 behaviour: a second operator click is answered from the cache', async () => {
    const candidates = ['vlan note']
    const fake = createFakeNode({}, { transport: { address: ADDRESS } })
    fake.transport.replies(probeKey(candidates), ack(3)).replies(ACK_ABORT, ack(3))
    render(<Harness options={{ node: fake.node, sessionName: NAME, probeTrigger: 'manual', featureProbeCommands: { vlanNotes: candidates } }} />)

    await userEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await screen.findByText(/vlanNotes: available/u)
    // Throttle window aside, the fresh cache short-circuit answers first — same rule as the auto arm.
    await userEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(await screen.findByText('probe: ready · from cache')).toBeInTheDocument()
    expect(chunkBatches(fake.transport.sent())).toBe(1)
  })

  it('enabled: false stays "never", NOT "not yet" — the #123 trap stays pinned so no screen re-invents it', async () => {
    const candidates = ['vlan note']
    const fake = createFakeNode({}, { transport: { address: ADDRESS } })
    fake.transport.replies(probeKey(candidates), ack(3)).replies(ACK_ABORT, ack(3))
    render(<Harness options={{ node: fake.node, sessionName: NAME, enabled: false, featureProbeCommands: { vlanNotes: candidates } }} />)

    // Mount does nothing (that part is intended)…
    expect(fake.transport.sent()).toHaveLength(0)
    // …and neither does the operator button — `enabled: false` short-circuits `probe()` too, which
    // is exactly why on-demand screens must use `probeTrigger: 'manual'` instead. Silent by design,
    // pinned by the call-count assertions: `status` never leaves `idle`.
    await userEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(screen.getByRole('status')).toHaveTextContent('probe: idle')
    expect(fake.transport.sent()).toHaveLength(0)
  })

  it('a network run the cache refused to store says WHY (DR-063 copy reaches the view, #77 refresh text)', async () => {
    const fake = createFakeNode({}, { transport: { address: ADDRESS } })
    // Unmapped per-command + batch codes: every verdict `unknown`, which the cache never stores.
    fake.transport
      .rejects(probeKey(['vlan note']), {
        code: EapiErrorCode.COMMAND_FAILED,
        message: 'SYNTHETIC unmapped batch failure with an unmapped per-command code',
        data: {
          result: [{}, {}, {}],
          errorDetail: [{ index: 2, code: EapiErrorCode.COMMAND_FAILED, message: 'SYNTHETIC unmapped per-command code', cmd: 'vlan note' }],
        },
      })
      .replies(ACK_ABORT, ack(3))
    render(<Harness options={{ node: fake.node, sessionName: NAME, throttleMs: 0, featureProbeCommands: { vlanNotes: ['vlan note'] } }} />)

    expect(await screen.findByText(/vlanNotes: unknown/u)).toBeInTheDocument()
    expect(await screen.findByText(/^stored: The run answered inconclusive/u)).toHaveTextContent('never stored (DR-063)')
  })
})

describe('capabilityDisplay — the three-way fold is honest about what each verdict means', () => {
  const probeResult = (command: string, verdict: CommandProbeResult['verdict'], codeName?: string, code?: number): CommandProbeResult => ({
    command,
    verdict,
    batchIndex: 0,
    features: ['f'],
    unavailable: verdict === 'unsupported',
    ...(codeName === undefined ? {} : { codeName }),
    ...(code === undefined ? {} : { code }),
  })

  it('nothing probed answers unknown', () => {
    expect(capabilityDisplay([])).toEqual({ display: 'unknown', reason: 'No candidate command was probed for this feature.' })
  })

  it('all-supported answers available', () => {
    expect(capabilityDisplay([probeResult('a', 'supported'), probeResult('b', 'supported')]).display).toBe('available')
  })

  it('a 1002 answers unavailable and names the code, falling back when no symbolic name exists', () => {
    expect(capabilityDisplay([probeResult('a', 'supported'), probeResult('b', 'unsupported', 'COMMAND_INVALID')])).toEqual({
      display: 'unavailable',
      reason: 'b: COMMAND_INVALID',
    })
    expect(capabilityDisplay([probeResult('b', 'unsupported')]).reason).toBe('b: 1002 COMMAND_INVALID')
    // When the client carries the device's numeric answer, the screen quotes it rather than only the
    // name this package chose — an operator reads the code EOS sent (#73).
    expect(capabilityDisplay([probeResult('b', 'unsupported', 'COMMAND_INVALID', 1002)]).reason).toBe('b: 1002 COMMAND_INVALID')
    expect(capabilityDisplay([probeResult('b', 'unsupported', 'COMMAND_FAILED', 1005)]).reason).toBe('b: 1005 COMMAND_FAILED')
  })

  it('not-rejected and config-locked answer unknown — acceptance and accidents are not features', () => {
    const notRejected = capabilityDisplay([probeResult('a', 'supported'), probeResult('b', 'not-rejected')])
    expect(notRejected.display).toBe('unknown')
    expect(notRejected.reason).toContain('never refused the grammar')
    const locked = capabilityDisplay([probeResult('a', 'config-locked')])
    expect(locked.display).toBe('unknown')
    expect(locked.reason).toContain('not cached')
  })
})

describe('candidateList — caller order, de-duplicated across features', () => {
  it('keeps first-seen order across feature lists', () => {
    expect(candidateList({
      b: ['two', 'shared'],
      a: ['one', 'shared'],
    })).toEqual(['two', 'shared', 'one'])
  })
})
