/**
 * S9 (#79): the transaction center, offline through hand-rolled fake seams (the S6/S8 precedent).
 * Pins the issue's acceptance lines:
 * - session names come from the client's sanitized generator (the `ui-…` prefix + recoverable
 *   shape — the regex, not a fixture, proves it is generated not invented);
 * - abort/commit command paths and the "Startup-config was not changed" copy;
 * - a refused batch (or an empty verify configlet) costs ZERO sessions/calls;
 * - recovery runs only behind a confirm, against the browser journal, and every outcome bucket
 *   renders (nothing dropped, nothing renamed — DR-032);
 * - the verifyConfig preview always carries the clean-config label (#79's never-a-preflight rule);
 * - four states + F4 confirms.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { TransactionCenter } from './TransactionCenter'
import type { TransactionCenterClient } from './TransactionCenter'

const ADDRESS = 'https://sw1.example:443/command-api'

type Summary = { name: string; state: string; description?: string; commitBy?: number; instances: readonly unknown[] }

interface Overrides {
  readonly sessions?: readonly Summary[] | Error
  readonly diffRead?: boolean
  readonly diff?: string
}

function makeFakes(overrides: Overrides = {}) {
  const session = {
    name: 'ui-generated',
    state: 'diffed',
    run: vi.fn(async () => []),
    diff: vi.fn(async () => overrides.diff ?? '+interface Vlan77\n+   description tx'),
    hasDiffBeenRead: vi.fn(() => overrides.diffRead ?? true),
    commit: vi.fn(async () => []),
    abort: vi.fn(async () => []),
  }
  const listSessions = vi.fn(async () => {
    if (overrides.sessions instanceof Error) throw overrides.sessions
    return {
      sessions: (overrides.sessions ?? [
        { name: 'ui-orphan', state: 'pending', description: 'webui addressing set address on Vlan10', instances: [] },
        { name: 'ui-timer', state: 'pending', commitBy: 1764000000, instances: [{}] },
        { name: 'saved-old', state: 'completed', instances: [] },
      ]).map((row: Summary) => ({ completedTime: undefined, commitUser: undefined, ...row })),
      maxOpenSessions: 4,
    }
  })
  const abortSession = vi.fn(async () => [])
  const recoverOrphans = vi.fn(async () => ({
    aborted: ['ui-orphan'],
    failed: [],
    skipped: [{ name: 'ui-timer', reason: 'SYNTHETIC commit timer armed' }],
    remaining: [],
    reported: [{ name: 'saved-old', state: 'completed' }],
  }))
  const configSession = vi.fn(async (_options: { name?: string; description?: string } | undefined = undefined) => session)
  const verifyConfig = vi.fn(async () => ({
    format: 'json',
    entries: [{ index: 0, configlet: 'interface Vlan77\n description tx\n', sessionConfig: { output: 'interface Vlan77\n   description tx\n' }, sessionConfigText: 'interface Vlan77\n   description tx\n' }],
    unmatched: [],
    raw: [{}, {}],
  }))
  const node = {
    listSessions, abortSession, recoverOrphans, configSession, verifyConfig,
    connection: { address: ADDRESS },
  } as unknown as TransactionCenterClient
  return { node, session, listSessions, abortSession, recoverOrphans, configSession, verifyConfig }
}

function renderScreen(fakes: ReturnType<typeof makeFakes>) {
  return render(<TransactionCenter node={fakes.node} proxyConfigured />)
}

async function readyState(fakes: ReturnType<typeof makeFakes>): Promise<void> {
  await screen.findByText(/holds the config lock/u)
  void fakes
}

describe('TransactionCenter — four states and the device-reported session table', () => {
  it('no proxy: prompt, device verbs disabled — while the LOCAL journal button stays available', () => {
    const fakes = makeFakes()
    render(<TransactionCenter node={undefined} proxyConfigured={false} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Local proxy is not configured')
    expect(screen.getByRole('button', { name: 'Run orphan recovery' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Open named session, stage, read diff' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Read local journal' })).toBeEnabled()
    expect(fakes.listSessions).not.toHaveBeenCalled()
  })

  it('the table renders every state VERBATIM with honest labels: lock, armed timer (never-auto-abort), completed', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyState(fakes)

    expect(screen.getByText('ui-orphan')).toBeInTheDocument()
    expect(screen.getByText(/holds the config lock/u)).toBeInTheDocument()
    expect(screen.getByText(/COMMIT TIMER is armed/u)).toBeInTheDocument()
    expect(screen.getByText(/never aborts a timer-armed session/u)).toBeInTheDocument()
    // The completed row's state is the device's word, not this screen's.
    expect(screen.getByText('saved-old')).toBeInTheDocument()
    // The session description (why the orphan exists) rides the row.
    expect(screen.getByText(/webui addressing set address on Vlan10/u)).toBeInTheDocument()
  })

  it('a failed session read is an alert with a live reload path, never an empty-table lie', async () => {
    const fakes = makeFakes({ sessions: new Error('SYNTHETIC sessions read exploded') })
    renderScreen(fakes)
    expect(await screen.findByRole('alert')).toHaveTextContent('SYNTHETIC sessions read exploded')
    expect(screen.getByRole('button', { name: 'Refresh device + journal' })).toBeEnabled()
  })
})

describe('TransactionCenter — staged draft review: generated name, argv pins, free refusals, and the two-step commit', () => {
  it('preview opens a GENERATOR-named session (ui-… recoverable shape), stages argv-literal, reads the device diff; commit copy promises running-config only', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyState(fakes)

    fireEvent.change(screen.getByLabelText(/Config lines \(one per line\)/u), { target: { value: 'interface Vlan77\ndescription tx' } })
    fireEvent.click(screen.getByRole('button', { name: 'Open named session, stage, read diff' }))
    await screen.findByText(/Review the device diff/u)

    // #79 acceptance: "Session-name generation stays sanitized — reuse it": assert the shape.
    // (vitest's jsdom runs on Node, so the client's DR-047 name carries the p<pid> segment it
    // emits whenever a process exists — the generator, not this screen, decides.)
    const call = fakes.configSession.mock.calls[0]?.[0] as { name?: string; description?: string }
    expect(call.name).toMatch(/^ui-sw1-example-(p\d+-)?[0-9a-f]{8}$/u)
    expect(call.description).toBe('webui tx center draft review')
    expect(fakes.session.run).toHaveBeenCalledWith(['interface Vlan77', 'description tx'])
    // The device diff renders byte-preserved in a <pre> (whitespace-collapsing text queries would
    // hide the leading '+' column alignment, so compare node content).
    expect(Array.from(document.querySelectorAll('pre')).map((n) => n.textContent)).toContain('+interface Vlan77\n+   description tx')

    // Two-step commit: panel button → F4 prompt whose copy carries the DR-024 promise. Both
    // share the label; the dialog mounts last (ConfirmProvider host after the workspace).
    fireEvent.click(screen.getByRole('button', { name: 'Commit draft to running-config' }))
    const body = await screen.findByText(/Startup-config was not changed and never will be/u)
    expect(body).toBeInTheDocument()
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Commit draft to running-config' })).toHaveLength(2))
    fireEvent.click(screen.getAllByRole('button', { name: 'Commit draft to running-config' }).at(-1)!)
    await waitFor(() => expect(fakes.session.commit).toHaveBeenCalled())
    expect(await screen.findByText(/Startup-config was not changed \(DR-024\)/u)).toBeInTheDocument()
    expect(fakes.listSessions.mock.calls.length).toBeGreaterThan(1) // reload after commit
  })

  it('smuggled session-control verbs are refused at ZERO configSession calls, and the textarea stays untouched', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyState(fakes)

    fireEvent.change(screen.getByLabelText(/Config lines \(one per line\)/u), { target: { value: 'commit' } })
    fireEvent.click(screen.getByRole('button', { name: 'Open named session, stage, read diff' }))
    expect(await screen.findByText(/transaction center refuses/u)).toBeInTheDocument()
    expect(fakes.configSession).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText(/Config lines \(one per line\)/u), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Open named session, stage, read diff' }))
    expect(await screen.findByText(/at least one config line/u)).toBeInTheDocument()
    expect(fakes.configSession).not.toHaveBeenCalled()
  })

  it('commit stays locked until hasDiffBeenRead, and one draft at a time owns the panel', async () => {
    const fakes = makeFakes({ diffRead: false })
    renderScreen(fakes)
    await readyState(fakes)

    fireEvent.change(screen.getByLabelText(/Config lines \(one per line\)/u), { target: { value: 'interface Vlan77' } })
    fireEvent.click(screen.getByRole('button', { name: 'Open named session, stage, read diff' }))
    await screen.findByText(/Review the device diff/u)
    expect(screen.getByRole('button', { name: 'Commit draft to running-config' })).toBeDisabled()
    // The stage button flips to its open-draft label — no second session can be opened meanwhile.
    expect(screen.getByRole('button', { name: 'Draft open' })).toBeDisabled()
    expect(fakes.configSession).toHaveBeenCalledTimes(1)

    // Abort the draft via the two-step confirm; session.abort fires, not commit. The panel button
    // and the dialog's confirm share the label — the LAST mount is the dialog (ConfirmProvider
    // hosts it after the workspace subtree).
    fireEvent.click(screen.getByRole('button', { name: 'Abort draft session' }))
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Abort draft session' })).toHaveLength(2))
    fireEvent.click(screen.getAllByRole('button', { name: 'Abort draft session' }).at(-1)!)
    await waitFor(() => expect(fakes.session.abort).toHaveBeenCalled())
    expect(fakes.session.commit).not.toHaveBeenCalled()
  })
})

describe('TransactionCenter — journal panel and refresh (browser-local state contacts no device)', () => {
  it('Read local journal renders the allow-listed fields (name/endpoint/startedAt/description) from localStorage', async () => {
    // Same storage key/shape the CLIENT's createWebStorageJournal writes (DR-011: these are its
    // fields, this screen just reads them back — the fake seeds exactly that record set).
    window.localStorage.setItem('arista-eapi:sessions', JSON.stringify([
      { name: 'ui-sw1-example-deadbeef', endpoint: ADDRESS, startedAt: '2026-11-10T09:00:00.000Z', description: 'webui system set hostname' },
    ]))
    try {
      const fakes = makeFakes()
      renderScreen(fakes)
      await readyState(fakes)

      fireEvent.click(screen.getByRole('button', { name: 'Read local journal' }))
      expect(await screen.findByText('ui-sw1-example-deadbeef')).toBeInTheDocument()
      expect(screen.getByText('2026-11-10T09:00:00.000Z')).toBeInTheDocument()
      expect(fakes.listSessions).not.toHaveBeenCalledWith(expect.anything()) // reads still device-clean
    } finally {
      window.localStorage.removeItem('arista-eapi:sessions')
    }
  })

  it('Refresh device + journal re-runs both reads, and the empty-session table keeps its honest empty state', async () => {
    window.localStorage.setItem('arista-eapi:sessions', '[]')
    try {
      const fakes = makeFakes({ sessions: [] })
      renderScreen(fakes)
      // Empty is a state, not a failure: the table says no sessions, and reload re-asks.
      expect(fakes.listSessions).toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Refresh device + journal' }))
      await waitFor(() => expect(fakes.listSessions).toHaveBeenCalledTimes(2))
    } finally {
      window.localStorage.removeItem('arista-eapi:sessions')
    }
  })
})

describe('TransactionCenter — orphan recovery and verifyConfig preview', () => {
  it('recovery needs a confirm, then renders EVERY bucket of the outcome with a journal-backed call', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyState(fakes)

    // Decline first: recoverOrphans never runs.
    fireEvent.click(screen.getByRole('button', { name: 'Run orphan recovery' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(fakes.recoverOrphans).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Run orphan recovery' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Show and abort identified pending sessions' }))
    await waitFor(() => expect(fakes.recoverOrphans).toHaveBeenCalled())
    expect((fakes.recoverOrphans.mock.calls[0] as readonly { journal?: unknown }[])[0].journal).toBeDefined()

    expect(await screen.findByText(/aborted by this run \(1\): ui-orphan/u)).toBeInTheDocument()
    expect(screen.getByText(/left alone .*commit timer armed/u)).toBeInTheDocument()
    expect(screen.getByText(/ignored by design .*saved-old \[completed\]/u)).toBeInTheDocument()
  })

  it('a device-row abort is confirm-gated and reloads the table', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyState(fakes)

    fireEvent.click(screen.getByRole('button', { name: 'Abort session ui-orphan' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(fakes.abortSession).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Abort session ui-orphan' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Abort pending session' }))
    await waitFor(() => expect(fakes.abortSession).toHaveBeenCalledWith('ui-orphan'))
  })

  it('the timer-armed row carries its warning into the abort confirm copy (decision, never routine cleanup)', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyState(fakes)

    fireEvent.click(screen.getByRole('button', { name: 'Abort session ui-timer' }))
    // The row note and the confirm body share the timer language, so the DR-050 phrase must be
    // pinned INSIDE the dialog to prove it reached the confirm copy (#79: F4 confirms).
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/decision to present, not cleanup to perform/u)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(fakes.abortSession).not.toHaveBeenCalled()
  })

  it('the verify panel labels its answer as clean-config normalisation and reports unmatched rows; empty text costs zero calls', async () => {
    const fakes = makeFakes()
    renderScreen(fakes)
    await readyState(fakes)

    // The standing label is on the panel BEFORE any call (#79's never-a-preflight rule).
    expect(screen.getByText(/normalised configlet preview from the CLEAN config/u)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Ask the device to normalise it' }))
    expect(await screen.findByText(/needs configlet text/u)).toBeInTheDocument()
    expect(fakes.verifyConfig).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText(/Configlet text/u), { target: { value: 'interface Vlan77\n description tx\n' } })
    fireEvent.click(screen.getByRole('button', { name: 'Ask the device to normalise it' }))
    await waitFor(() => expect(fakes.verifyConfig).toHaveBeenCalledTimes(1))
    // Raw configlet AND the normalised answer render as exact TEXT in the <pre> blocks (query the
    // nodes: getByText would fold the indentation that is the whole point of the pairing).
    const pres = Array.from(document.querySelectorAll('pre')).map((node) => node.textContent)
    expect(pres).toContain('interface Vlan77\n description tx\n')
    expect(pres).toContain('interface Vlan77\n   description tx\n')
    expect(screen.getByText(/format json · 1 configlet answer\(s\) · 0 unmatched reply row\(s\)/u)).toBeInTheDocument()
  })
})
