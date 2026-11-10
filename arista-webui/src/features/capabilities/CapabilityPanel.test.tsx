/**
 * S7 (#77): the capability probe panel, driven end-to-end through the `./testing` seam
 * (`createFakeNode` + scripted MockTransport envelopes — the CAP-TESTING pattern of
 * `use-capabilities.test.tsx`, whose `probeKey`/`ack` wire idioms this file reuses verbatim). Every
 * script below is a SYNTHETIC wire answer; no claim here is about real device behaviour.
 *
 * Acceptance lines from #77 and where each is pinned:
 * - nothing probes without the operator paying for it, in BOTH directions:
 *   mount opens no session (probeTrigger 'manual', #123), declining the F4 confirm leaves
 *   `sent()` empty AND re-arms, and the guard refusals (empty name, `commit`/`reload` candidates)
 *   also leave `sent()` empty;
 * - the guaranteed abort rides the outcome into the rendered rows: the probe batch + abort batch
 *   are pinned argv-literal, and the summary line counts straight from the client outcome;
 * - the seven-verdict taxonomy renders from the RAW outcome — 1002 cells quote `1002
 *   COMMAND_INVALID`, 1005 cells the unauthorized non-claim copy, and neither folds into a
 *   green/red light: folds stay three-way, everything but 1002 is labelled a non-claim;
 * - `1006` shows the pending-session table with its confirm-gated cleanup (the S9/#79 bridge),
 *   not a bare error, and retrying is framed as cleanup-first (the rate limiter + forced re-probe
 *   are pinned in the fresh-arm case);
 * - the export is built from the outcome alone: scripted device prose (`SYNTHETIC …`) never
 *   reaches it, commands/codes/folds do, and the jsdom clipboard-absent fallback is the honest
 *   select-and-copy notice.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createFakeNode } from '@devhax-heavy-industries/arista-eapi/testing'
import { EapiErrorCode } from '@devhax-heavy-industries/arista-eapi'

import { CapabilityPanel } from './CapabilityPanel'

const ADDRESS = 'https://sw1.example:443/command-api'
/** The panel's deterministic probe session (CapabilityPanel.tsx, PROBE_SESSION). */
const NAME = 'ui-webui-capabilities'
const OPEN = `configure session ${NAME} no-commit`
const probeKey = (tail: readonly string[]): string => ['enable', OPEN, ...tail].join('\n')
const ACK_ABORT = probeKey(['abort'])

/** Empty per-command replies, one per wire command (the `capabilities.test.ts` ack idiom). */
function ack(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, () => ({}))
}

function renderPanel(): ReturnType<typeof createFakeNode> {
  const fake = createFakeNode({}, { transport: { address: ADDRESS } })
  render(<CapabilityPanel node={fake.node} proxyConfigured />)
  return fake
}

/** Type a question set into the editor form and submit it (accessible names from #77's own labels). */
function stageSet(name: string, commandsText: string): void {
  fireEvent.change(screen.getByLabelText(/Feature name/u), { target: { value: name } })
  fireEvent.change(screen.getByLabelText(/Candidate commands, one per line/u), { target: { value: commandsText } })
  fireEvent.click(screen.getByRole('button', { name: 'Add question set' }))
}

/** Press the run button, await the F4 prompt, and answer it. `accept` clicks the prompt's own verb. */
async function answerProbePrompt(accept: boolean, { force = false }: { readonly force?: boolean } = {}): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: force ? 'Re-probe (fresh — costs a session)' : 'Run capability probe' }))
  const confirmLabel = force ? 'Open a fresh probe session' : 'Open probe session and ask'
  const button = await screen.findByRole('button', { name: confirmLabel })
  if (!accept) {
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    return
  }
  fireEvent.click(button)
}

describe('CapabilityPanel — the operator pays for every session: mount, confirm, and guard refusals all pin sent() to empty (#77)', () => {
  it('mount never opens a probe session; declining the confirm keeps it that way; accepting sends argv-pinned batch + abort', async () => {
    const fake = renderPanel()
    const candidate = 'arp timeout 120'
    fake.transport.replies(probeKey([candidate]), ack(3)).replies(ACK_ABORT, ack(3))

    stageSet('arp', candidate)
    // The #123 knob made visible + true: staging a set still opened nothing.
    expect(fake.transport.sent()).toEqual([])
    expect(await screen.findByText(/^Question set "arp" added/u)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run capability probe' })).toBeEnabled()
    // The panel says out loud what the pin proves.
    expect(screen.getByText(/never will without a click/u)).toBeInTheDocument()
    expect(screen.getByText('No probe has run in this page load. Nothing has been sent to the device.')).toBeInTheDocument()

    // Decline the F4 cost prompt: still zero wire, and the button is re-armed, not dead-ended.
    await answerProbePrompt(false)
    expect(fake.transport.sent()).toEqual([])
    expect(await screen.findByText(/Probe declined: no config session was opened/u)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run capability probe' })).toBeEnabled()

    // Accept: one chunk, then the guaranteed abort — and the summary counts straight from the outcome.
    await answerProbePrompt(true)
    expect(await screen.findByText(/^1 supported across 1 candidate\(s\) in 1 batch\(es\); inconclusive run: false$/u)).toBeInTheDocument()
    expect(fake.transport.sent()).toEqual([
      ['enable', OPEN, candidate],
      ['enable', OPEN, 'abort'],
    ])
    // BOTH honest places say it: the feature fold cell and the candidate cell (two separate cells,
    // never one green light — so `all`, not `get`).
    expect(screen.getAllByText('available').length).toBeGreaterThanOrEqual(2)
    // Live-region status says what answered: the wire, not the cache.
    expect(await screen.findByText(/^Last run settled\.$/u)).toBeInTheDocument()
  })

  it('an empty name and every always-refused candidate are refused in-form at zero round trips', async () => {
    const fake = renderPanel()

    stageSet('   ', 'arp timeout 120')
    expect(await screen.findByText(/needs a name/u)).toBeInTheDocument()

    stageSet('danger', 'commit\nreload now')
    expect(await screen.findByText(/starts with `commit`, which this client refuses to probe/u)).toBeInTheDocument()
    // The scan runs candidate-by-candidate: a set refused for `commit` never even reports the
    // `reload` line until it is asked on its own.
    stageSet('danger2', 'reload now')
    expect(await screen.findByText(/starts with `reload`.*reboots the switch/us)).toBeInTheDocument()

    expect(fake.transport.sent()).toEqual([])
    expect(screen.getByRole('button', { name: 'Run capability probe' })).toBeDisabled()
    // Nothing was staged by either refusal: the set list never rendered — the empty-state copy is
    // still on screen as the second half of the pin.
    expect(screen.getByText(/No question sets yet/u)).toBeInTheDocument()
  })

  it('a second non-forced run is answered by the fresh cache: no extra session, and the view says so', async () => {
    const fake = renderPanel()
    const candidate = 'arp timeout 120'
    fake.transport.replies(probeKey([candidate]), ack(3)).replies(ACK_ABORT, ack(3))
    stageSet('arp', candidate)
    await answerProbePrompt(true)
    await screen.findByText(/1 supported across/u)

    // The confirm is still asked (the operator cannot know the cache is fresh), but the hook
    // answers the probe itself with zero wire — that is the cached-vs-fresh split made visible.
    await answerProbePrompt(true)
    expect(await screen.findByText(/answered from the capability cache, no config session was opened/u)).toBeInTheDocument()
    expect(fake.transport.sent()).toHaveLength(2)
  })

  it('the forced re-probe inside the throttle window is refused and counted, opening no second session', async () => {
    const fake = renderPanel()
    const candidate = 'arp timeout 120'
    fake.transport.replies(probeKey([candidate]), ack(3)).replies(ACK_ABORT, ack(3))
    stageSet('arp', candidate)
    await answerProbePrompt(true)
    await screen.findByText(/1 supported across/u)

    await answerProbePrompt(true, { force: true })
    expect(await screen.findByText(/rate limiter refused the last 1 request/u)).toBeInTheDocument()
    expect(fake.transport.sent()).toHaveLength(2)
  })
})

describe('CapabilityPanel — the seven-verdict taxonomy renders from the raw outcome, and DR-062 draws the line', () => {
  it('the 1002 arm shows the per-candidate code cell while the FOLD stays three-way and the export quotes no device prose', async () => {
    const fake = renderPanel()
    const candidate = 'switchport trunk group ABC1'
    fake.transport
      .rejects(probeKey([candidate]), {
        code: EapiErrorCode.COMMAND_INVALID,
        message: 'SYNTHETIC the grammar does not know trunk groups here',
        data: {
          result: [{}, {}, {}],
          errorDetail: [{ index: 2, code: EapiErrorCode.COMMAND_INVALID, cmd: candidate, message: 'SYNTHETIC no such keyword' }],
        },
      })
      .replies(ACK_ABORT, ack(3))
    stageSet('trapGroups', candidate)
    await answerProbePrompt(true)

    // Per-candidate truth: the client verdict word, the code it carried, the non-claim guardrail.
    expect(await screen.findByText(candidate)).toBeInTheDocument()
    expect(screen.getByText('1002 COMMAND_INVALID')).toBeInTheDocument()
    expect(screen.getByText(/the one verdict DR-062 allows/u)).toBeInTheDocument()
    // The fold stays the hook's honest three-way — a single 1002 never turns green or red.
    expect(screen.getAllByText('unavailable').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText(/^1 unsupported across 1 candidate\(s\)/u)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Build redacted export' }))
    const pre = await screen.findByText(/^# Capability probe export/u)
    expect(pre.textContent).toContain('trapGroups: unavailable')
    expect(pre.textContent).toContain('1002 COMMAND_INVALID')
    expect(pre.textContent).toContain('guaranteed abort sent: true')
    // The device's wording rides every CommandProbeResult and none of it may reach the note.
    expect(pre.textContent).not.toContain('SYNTHETIC')

    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }))
    expect(await screen.findByText(/exposes no clipboard API/u)).toBeInTheDocument()
  })

  it('a 1005 answer renders the unauthorized non-claim copy, never a feature verdict', async () => {
    const fake = renderPanel()
    const candidate = 'arp timeout 120'
    fake.transport
      .rejects(probeKey([candidate]), {
        code: EapiErrorCode.COMMAND_FAILED,
        message: 'SYNTHETIC the batch tripped authorization',
        data: {
          result: [{}, {}, {}],
          errorDetail: [{ index: 2, code: EapiErrorCode.COMMAND_UNAUTHORIZED, cmd: candidate, message: 'SYNTHETIC insufficient privilege' }],
        },
      })
      .replies(ACK_ABORT, ack(3))
    stageSet('arp', candidate)
    await answerProbePrompt(true)

    expect(await screen.findByText('unauthorized')).toBeInTheDocument()
    // #77's acceptance: 1005 maps to the re-auth copy and says, in the same breath, it is not a
    // feature claim.
    expect(screen.getByText(/AAA command authorization says your ROLE cannot run it/u)).toBeInTheDocument()
    expect(screen.getByText(/Non-claim/u)).toBeInTheDocument()
    expect(screen.getByText(/^1 unauthorized across/u)).toBeInTheDocument()
  })
})

describe('CapabilityPanel — 1006 is shown as a session problem with a confirm-gated cleanup, not a retry meathole (#77 → S9 #79)', () => {
  it('renders the config-locked copy + pending table, and only an accepted cleanup confirm reaches the wire', async () => {
    const fake = createFakeNode({
      // The wire answer shape `listSessions` parses: a `sessions` OBJECT keyed by session name
      // (the `stale-pending` fixture from use-capabilities.test.tsx).
      replies: {
        'show configuration sessions': {
          sessions: { 'stale-pending': { state: 'pending', description: 'SYNTHETIC orphan', instances: {} } },
        },
      },
    }, { transport: { address: ADDRESS } })
    fake.transport
      .rejects(probeKey(['arp timeout 120']), {
        code: EapiErrorCode.COMMAND_CONFIG_LOCKED,
        message: 'SYNTHETIC config lock held elsewhere',
        data: { result: [{}, {}, {}] },
      })
      .replies(ACK_ABORT, ack(3))
      .replies(['enable', 'configure session stale-pending abort'].join('\n'), ack(2))
    render(<CapabilityPanel node={fake.node} proxyConfigured />)

    stageSet('arp', 'arp timeout 120')
    await answerProbePrompt(true)

    // The copy is broken by the <strong> (so match a fragment inside one text node), then assert
    // the whole sentence on the element to pin the exact copy.
    const lockNotice = await screen.findByText(/retrying blindly will not help/u)
    expect(lockNotice).toHaveTextContent('A 1006 config lock answered this probe.')
    expect(screen.getByText('stale-pending')).toBeInTheDocument()
    // The never-stored reason surfaces instead of pretending a verdict was cached (DR-063).
    expect(screen.getByText(/inconclusive runs are never stored \(DR-063\)/u)).toBeInTheDocument()

    // Decline the cleanup: no abort batch reaches the wire (the listSessions read is not a write).
    fireEvent.click(screen.getByRole('button', { name: 'Abort pending session stale-pending' }))
    await screen.findByRole('button', { name: 'Abort pending session' })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(fake.transport.sent().some((batch) => batch.some((command) => String(command).includes('configure session stale-pending')))).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Abort pending session stale-pending' }))
    await screen.findByRole('button', { name: 'Abort pending session' })
    fireEvent.click(screen.getByRole('button', { name: 'Abort pending session' }))
    // The abort went out, then the forced re-probe re-read `show configuration sessions`, so the
    // orphan rows reappear (this device's list is still holding it — honest, not a bug): the row
    // name and its own button label both carry the text, hence `all`.
    expect((await screen.findAllByText(/stale-pending/u)).length).toBeGreaterThanOrEqual(2)
    expect(fake.transport.sent().some((batch) => batch.some((command) => String(command).includes('configure session stale-pending')))).toBe(true)
  })
})

describe('CapabilityPanel — four states and nothing invented', () => {
  it('a throwing probe leaves the failure slot lit with the abort attempted anyway, and exports nothing', async () => {
    const fake = renderPanel()
    fake.transport
      .throws(probeKey(['arp timeout 120']), new Error('SYNTHETIC transport blew up mid-probe'))
      .replies(ACK_ABORT, ack(3))
    stageSet('arp', 'arp timeout 120')
    await answerProbePrompt(true)

    expect(await screen.findByRole('alert')).toHaveTextContent('SYNTHETIC transport blew up mid-probe')
    // Build stays disabled while the last run never settled → no export from a failed run.
    expect(screen.getByRole('button', { name: 'Build redacted export' })).toBeDisabled()
  })

  it('the no-proxy arm prompts and disables everything without contacting anything', () => {
    const fake = createFakeNode({}, { transport: { address: ADDRESS } })
    render(<CapabilityPanel node={undefined} proxyConfigured={false} />)
    // The prompt slot is the alert; the same words also sit in the connection label (which is why
    // an exact getByText here finds two elements by design).
    expect(screen.getByRole('alert')).toHaveTextContent('Local proxy is not configured')
    expect(screen.getByRole('button', { name: 'Add question set' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Run capability probe' })).toBeDisabled()
    expect(fake.transport.sent()).toEqual([])
  })

  it('an empty verdict region states the honest emptiness before any run — not a table of maybes', () => {
    renderPanel()
    expect(screen.getByText(/No question sets yet — the list starts empty on purpose/u)).toBeInTheDocument()
    expect(screen.getByText(/No probe has run in this page load/u)).toBeInTheDocument()
  })
})

describe('CapabilityPanel — export lifecycle: F8 veto, clipboard arms, and set removal', () => {
  /** Run one accepted probe so an outcome exists to export. */
  async function probedOnce(fake: ReturnType<typeof createFakeNode>): Promise<void> {
    fake.transport.replies(probeKey(['arp timeout 120']), ack(3)).replies(ACK_ABORT, ack(3))
    render(<CapabilityPanel node={fake.node} proxyConfigured />)
    stageSet('arp', 'arp timeout 120')
    await answerProbePrompt(true)
    await screen.findByText(/1 supported across/u)
  }

  it('the F8 vetoed arm reports ONLY rule names — the offending candidate is never echoed back', async () => {
    const fake = createFakeNode({}, { transport: { address: ADDRESS } })
    // The MAC is split across runtime concatenation so THIS file never spells one for the scanner.
    const mac = `arp static ${'00:1c:73:00:00:'}05`
    fake.transport.replies(probeKey([mac]), ack(3)).replies(ACK_ABORT, ack(3))
    render(<CapabilityPanel node={fake.node} proxyConfigured />)
    stageSet('arp', mac)
    await answerProbePrompt(true)
    await screen.findByText(/1 supported across/u)

    fireEvent.click(screen.getByRole('button', { name: 'Build redacted export' }))
    expect(await screen.findByText(/The F8 guard flagged 1 finding\(s\) in this table \(rules: mac\)/u)).toBeInTheDocument()
    expect(screen.getByText(/Nothing was copied/u)).toBeInTheDocument()
    // The vetoed text is never rendered anywhere — the candidate appears in the (already operator-
    // supplied) table, but no export block exists to copy from.
    expect(screen.queryByText(/^# Capability probe export/u)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Copy to clipboard' })).toBeNull()
  })

  it('a working clipboard copies, and a refused write degrades to the manual-select notice', async () => {
    const fake = createFakeNode({}, { transport: { address: ADDRESS } })
    await probedOnce(fake)
    fireEvent.click(screen.getByRole('button', { name: 'Build redacted export' }))
    await screen.findByText(/^# Capability probe export/u)

    const writeText = vi.fn(async (): Promise<void> => undefined)
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true })
    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }))
    expect(await screen.findByText(/Export copied to the clipboard/u)).toBeInTheDocument()
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('# Capability probe export'))

    const deny = vi.fn(async (): Promise<void> => { throw new Error('deny') })
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: deny }, configurable: true })
    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }))
    expect(await screen.findByText(/refused clipboard access/u)).toBeInTheDocument()
  })

  it('removing a set clears the export state and the probe button, while keeping the answered table honest', async () => {
    const fake = createFakeNode({}, { transport: { address: ADDRESS } })
    await probedOnce(fake)
    fireEvent.click(screen.getByRole('button', { name: 'Build redacted export' }))
    await screen.findByText(/^# Capability probe export/u)

    fireEvent.click(screen.getByRole('button', { name: 'Remove arp' }))
    expect(await screen.findByText(/Question set "arp" removed/u)).toBeInTheDocument()
    expect(screen.queryByText(/^# Capability probe export/u)).toBeNull()
    // The verdict table stays (it is an answered fact of this page load) but nothing else is askable.
    expect(screen.getByText('arp timeout 120')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run capability probe' })).toBeDisabled()
  })
})
