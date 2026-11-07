import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { ConfirmDialog } from './ConfirmDialog'
import type { ConfirmDialogProps } from './ConfirmDialog'

function setup(overrides: Partial<ConfirmDialogProps> = {}) {
  const handlers = { onConfirm: vi.fn<() => void>(), onCancel: vi.fn<() => void>() }
  render(<ConfirmDialog
    title='Abort pending device session'
    body='Abort pending device session stale-pending? Its staged changes will be discarded.'
    confirmLabel='Abort pending session'
    destructive
    subject='stale-pending'
    {...handlers}
    {...overrides}
  />)
  return handlers
}

const dialog = () => screen.getByRole('dialog', { name: 'Abort pending device session' })
const confirmButton = () => screen.getByRole('button', { name: 'Abort pending session' })
const cancelButton = () => screen.getByRole('button', { name: 'Cancel' })

describe('ConfirmDialog', () => {
  it('opens as a native modal dialog named by its heading, with the session subject in the a11y tree', () => {
    setup()
    const prompt = dialog()

    expect(prompt).toBeInTheDocument()
    expect(prompt.tagName.toLowerCase()).toBe('dialog')
    // `showModal()` is absent in jsdom, so the guarded shim leaves the element open; browsers
    // additionally expose aria-modal/top layer from the modal open path.
    expect(prompt).toHaveAttribute('open')
    expect(screen.getByRole('heading', { name: 'Abort pending device session', level: 2 })).toBeInTheDocument()
    expect(screen.getByText('Abort pending device session stale-pending? Its staged changes will be discarded.')).toBeInTheDocument()
    // Destructive copy names its subject, so it is reachable from the dialog's description.
    expect(prompt).toHaveAttribute('aria-describedby', 'confirm-dialog-subject confirm-dialog-body')
    expect(screen.getByText('stale-pending')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Abort pending session' })).toBeInTheDocument()
  })

  it('focuses Cancel on open so Enter dismisses instead of acting on the device', async () => {
    const user = userEvent.setup()
    const { onConfirm, onCancel } = setup()

    expect(cancelButton()).toHaveFocus()

    await user.keyboard('{Enter}')

    expect(onConfirm).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('dismisses on Escape without choosing either action', async () => {
    const user = userEvent.setup()
    const { onConfirm, onCancel } = setup()

    await user.keyboard('{Escape}')

    expect(onCancel).toHaveBeenCalledOnce()
    expect(onConfirm).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('dismisses exactly once when the browser also fires its native cancel event for Escape', async () => {
    const user = userEvent.setup()
    const { onConfirm, onCancel } = setup()
    const prompt = dialog()

    await user.keyboard('{Escape}')
    // A browser that also runs its own Escape path must not produce a second decision. The `cancel`
    // event is dispatched at the dialog (bubbled, so React reaches it either way).
    fireEvent(prompt, new Event('cancel', { cancelable: true, bubbles: true }))

    expect(onCancel).toHaveBeenCalledOnce()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('dismisses on a backdrop click and never activates an action', () => {
    const { onConfirm, onCancel } = setup()

    // A click on the ::backdrop targets the <dialog> element itself.
    fireEvent.click(dialog())

    expect(onCancel).toHaveBeenCalledOnce()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('ignores clicks inside the dialog content so they cannot dismiss it', async () => {
    const user = userEvent.setup()
    const { onConfirm, onCancel } = setup()

    await user.click(screen.getByText('stale-pending'))

    expect(onCancel).not.toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
    expect(dialog()).toBeInTheDocument()
  })

  it('acts only on an explicit click of the danger confirm', async () => {
    const user = userEvent.setup()
    const { onConfirm, onCancel } = setup()
    // Captured before the click: once the dialog closes it leaves the accessibility tree, so the
    // assertions below work from the references rather than re-querying.
    const action = confirmButton()

    expect(action).toHaveClass('is-destructive')

    await user.click(action)

    expect(onConfirm).toHaveBeenCalledOnce()
    expect(onCancel).not.toHaveBeenCalled()
    // The tone is never the only cue — the label itself states the device action.
    expect(action.textContent).toBe('Abort pending session')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('uses the non-danger primary tone when the prompt is not destructive', () => {
    setup({ destructive: false, confirmLabel: 'Continue' })

    expect(screen.getByRole('button', { name: 'Continue' })).not.toHaveClass('is-destructive')
  })

  it('renders no subject line when the caller supplies none', () => {
    setup({ subject: undefined })

    expect(screen.queryByText('Subject')).not.toBeInTheDocument()
    expect(dialog()).toHaveAttribute('aria-describedby', 'confirm-dialog-body')
  })

  it('honours a custom cancel label', () => {
    setup({ cancelLabel: 'Keep staged changes' })

    const customCancel = screen.getByRole('button', { name: 'Keep staged changes' })
    expect(customCancel).toBeInTheDocument()
    expect(customCancel).toHaveFocus()
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
  })

  it('returns focus to the trigger that opened it', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    const onCancel = vi.fn()

    function Harness() {
      const [open, setOpen] = useState(false)
      return <>
        <button type='button' onClick={() => setOpen((current) => !current)}>Abort pending session</button>
        {open && <ConfirmDialog
          title='Abort pending device session'
          body='Abort pending device session stale-pending? Its staged changes will be discarded.'
          confirmLabel='Confirm abort'
          destructive
          subject='stale-pending'
          onConfirm={() => { setOpen(false); onConfirm() }}
          onCancel={() => { setOpen(false); onCancel() }}
        />}
      </>
    }

    render(<Harness />)
    const trigger = screen.getByRole('button', { name: 'Abort pending session' })
    await user.click(trigger)

    expect(cancelButton()).toHaveFocus()

    await user.click(screen.getByRole('button', { name: 'Confirm abort' }))

    expect(onConfirm).toHaveBeenCalledOnce()
    expect(trigger).toHaveFocus()
  })
})
