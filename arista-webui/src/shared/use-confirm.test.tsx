import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ConfirmProvider, useConfirm } from './use-confirm'
import type { ConfirmOptions } from './use-confirm'

const abortPrompt = {
  title: 'Abort pending device session',
  body: 'Abort pending device session stale-pending? Its staged changes will be discarded.',
  confirmLabel: 'Abort pending session',
  destructive: true,
  subject: 'stale-pending',
} satisfies ConfirmOptions

const commitPrompt = {
  title: 'Commit to running-config',
  body: 'Commit session ui-test-session? This changes running-config only.',
  confirmLabel: 'Commit now',
  destructive: true,
  subject: 'ui-test-session',
} satisfies ConfirmOptions

function Consumer({ deviceCall, results, prompts = [abortPrompt] }: { readonly deviceCall: () => void; readonly results: boolean[]; readonly prompts?: readonly ConfirmOptions[] }) {
  const confirm = useConfirm()
  const [decisions, setDecisions] = useState<string>('idle')

  async function ask() {
    const answers: string[] = []
    for (const prompt of prompts) {
      const confirmed = await confirm(prompt)
      answers.push(String(confirmed))
      results.push(confirmed)
      if (confirmed) deviceCall()
    }
    setDecisions(answers.join(','))
  }

  return <>
    <button type='button' onClick={() => void ask()}>Act on device</button>
    <p role='status'>{decisions}</p>
  </>
}

function setup(prompts?: readonly ConfirmOptions[]) {
  const deviceCall = vi.fn()
  const results: boolean[] = []
  const view = render(<ConfirmProvider><Consumer deviceCall={deviceCall} results={results} {...(prompts === undefined ? {} : { prompts })} /></ConfirmProvider>)
  return { deviceCall, results, ...view }
}

afterEach(() => vi.restoreAllMocks())

describe('useConfirm', () => {
  it('renders a single dialog carrying the prompt copy and the named device subject', async () => {
    const user = userEvent.setup()
    setup()

    await user.click(screen.getByRole('button', { name: 'Act on device' }))

    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    const prompt = screen.getByRole('dialog', { name: 'Abort pending device session' })
    expect(within(prompt).getByRole('heading', { name: 'Abort pending device session', level: 2 })).toBeInTheDocument()
    expect(within(prompt).getByText('Abort pending device session stale-pending? Its staged changes will be discarded.')).toBeInTheDocument()
    // The destructive copy names its subject inside the dialog's accessible description.
    expect(prompt).toHaveAttribute('aria-describedby', 'confirm-dialog-subject confirm-dialog-body')
    expect(within(prompt).getByText('stale-pending')).toBeInTheDocument()
    // The control that reaches the device is the danger-styled primary — and it is not focused,
    // so neither Enter nor Escape can trigger it.
    expect(within(prompt).getByRole('button', { name: 'Abort pending session' })).toHaveClass('is-destructive')
    expect(within(prompt).getByRole('button', { name: 'Cancel' })).toHaveFocus()
  })

  it('resolves true and issues exactly one device call on an explicit danger-confirm click', async () => {
    const user = userEvent.setup()
    const { deviceCall, results } = setup()

    await user.click(screen.getByRole('button', { name: 'Act on device' }))
    await user.click(screen.getByRole('button', { name: 'Abort pending session' }))

    expect(deviceCall).toHaveBeenCalledOnce()
    expect(results).toEqual([true])
    expect(await screen.findByRole('status')).toHaveTextContent('true')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('resolves false with zero device calls when Escape dismisses the prompt', async () => {
    const user = userEvent.setup()
    const { deviceCall, results } = setup()
    const trigger = screen.getByRole('button', { name: 'Act on device' })

    await user.click(trigger)
    await user.keyboard('{Escape}')

    expect(deviceCall).not.toHaveBeenCalled()
    expect(results).toEqual([false])
    expect(await screen.findByRole('status')).toHaveTextContent('false')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // Focus returns to the control the operator was working at.
    expect(trigger).toHaveFocus()
  })

  it('resolves false with zero device calls when the backdrop is clicked', async () => {
    const user = userEvent.setup()
    const { deviceCall, results } = setup()

    await user.click(screen.getByRole('button', { name: 'Act on device' }))
    await user.click(screen.getByRole('dialog'))

    expect(deviceCall).not.toHaveBeenCalled()
    expect(results).toEqual([false])
    expect(await screen.findByRole('status')).toHaveTextContent('false')
  })

  it('resolves false with zero device calls on the Cancel button', async () => {
    const user = userEvent.setup()
    const { deviceCall, results } = setup()

    await user.click(screen.getByRole('button', { name: 'Act on device' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(deviceCall).not.toHaveBeenCalled()
    expect(results).toEqual([false])
    expect(await screen.findByRole('status')).toHaveTextContent('false')
  })

  it('prompts in sequence without stacking dialogs and acts on each decision once', async () => {
    const user = userEvent.setup()
    const { deviceCall, results } = setup([abortPrompt, commitPrompt])

    await user.click(screen.getByRole('button', { name: 'Act on device' }))
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByRole('dialog', { name: 'Abort pending device session' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Abort pending session' }))
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByRole('dialog', { name: 'Commit to running-config' })).toBeInTheDocument()

    await user.keyboard('{Escape}')

    expect(results).toEqual([true, false])
    expect(deviceCall).toHaveBeenCalledOnce()
    expect(await screen.findByRole('status')).toHaveTextContent('true,false')
  })

  it('replaces an unanswered prompt instead of showing two modal dialogs', async () => {
    const user = userEvent.setup()
    const deviceCall = vi.fn()
    const results: boolean[] = []

    function Concurrent() {
      const confirm = useConfirm()
      async function askBoth() {
        const decisions = await Promise.all([confirm(abortPrompt), confirm(commitPrompt)])
        results.push(...decisions)
        if (decisions.some((confirmed) => confirmed)) deviceCall()
      }
      return <button type='button' onClick={() => void askBoth()}>Act on device</button>
    }

    render(<ConfirmProvider><Concurrent /></ConfirmProvider>)

    await user.click(screen.getByRole('button', { name: 'Act on device' }))

    // The second request superseded the first — whose await resolved false with no device call —
    // so only the newest prompt is ever on screen.
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByRole('dialog', { name: 'Commit to running-config' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Abort pending device session' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Commit now' }))

    expect(results).toEqual([false, true])
    expect(deviceCall).toHaveBeenCalledOnce()
  })

  it('resolves false when the host unmounts with a prompt open, leaving no await hanging', async () => {
    const user = userEvent.setup()
    const { deviceCall, results, unmount } = setup()

    await user.click(screen.getByRole('button', { name: 'Act on device' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    unmount()

    await vi.waitFor(() => expect(results).toEqual([false]))
    expect(deviceCall).not.toHaveBeenCalled()
  })

  it('refuses to run without a ConfirmProvider ancestor instead of silently dropping the prompt', () => {
    expect(() => render(<Consumer deviceCall={vi.fn()} results={[]} />)).toThrow(/ConfirmProvider/u)
  })
})
