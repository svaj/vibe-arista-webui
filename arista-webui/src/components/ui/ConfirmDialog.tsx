/**
 * Accessible replacement for `window.confirm` (issue #66).
 *
 * Built on the native `<dialog>` element: `showModal()` gives the top layer, the
 * scrim (`::backdrop`), `aria-modal` semantics, and the focus trap for free — none
 * of which are reimplemented here, and no scroll-locking dependency is introduced.
 *
 * Safety stance for this app: every prompt this dialog renders guards an eAPI write
 * (a session commit, or an abort that discards staged work), so the choice that
 * touches the device is never the keyboard default:
 * - initial focus lands on **Cancel**, so Enter cannot fire the destructive action;
 * - Escape and a backdrop click dismiss **without** choosing either action;
 * - the confirm control only acts on an explicit click/activation of itself.
 */
import { useEffect, useRef } from 'react'
import type { KeyboardEvent, MouseEvent } from 'react'

export type ConfirmDialogProps = {
  /** Heading inside the dialog; also the dialog's accessible name. */
  readonly title: string
  /** Plain, markdown-free copy explaining what the device operation does. */
  readonly body: string
  /** Verb phrase for the action button. Never relies on colour alone: the label states the action. */
  readonly confirmLabel: string
  readonly cancelLabel?: string
  /** Danger tone for a primary action that writes to, or discards work on, the device. */
  readonly destructive?: boolean
  /** Device-side subject (e.g. a configuration-session name) surfaced in the accessibility tree. */
  readonly subject?: string
  readonly onConfirm: () => void
  /** Fired by every dismiss path that chooses no action: Cancel, Escape, backdrop, native cancel. */
  readonly onCancel: () => void
}

/**
 * `showModal()`/`close()` are Baseline in every browser this app targets, but are not
 * implemented by the jsdom used by `npm test -w arista-webui` (jsdom 30 exposes only the
 * `open` reflected attribute on `HTMLDialogElement`). The guarded fallbacks below keep the
 * component reachable by tests — where `open` plus the explicit focus handling below is the
 * closest available stand-in for the top layer — without shipping anything non-standard.
 */
function openNativeModal(dialog: HTMLDialogElement) {
  if (typeof dialog.showModal === 'function') {
    if (!dialog.open) dialog.showModal()
    return
  }
  dialog.open = true
}

function closeNativeDialog(dialog: HTMLDialogElement) {
  if (typeof dialog.close === 'function') {
    if (dialog.open) dialog.close()
    return
  }
  dialog.open = false
}

export function ConfirmDialog({ title, body, confirmLabel, cancelLabel = 'Cancel', destructive = false, subject, onConfirm, onCancel }: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null)
  const decidedRef = useRef(false)

  // Mounted only while a prompt is pending, so opening/closing/focus-return is this effect.
  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog === null) return undefined
    // The browser restores focus to the trigger on close only for a real modal; recording the
    // opener here makes the return-to-trigger behaviour explicit (and testable) in both cases.
    const opener = document.activeElement
    openNativeModal(dialog)
    // Enter therefore activates Cancel: the destructive confirm is never the default button.
    cancelButtonRef.current?.focus()
    return () => {
      closeNativeDialog(dialog)
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
    }
  }, [])

  /**
   * One gesture can reach several close paths at once (this component's Escape handling plus the
   * browser's own `cancel`/`close` events), so the first decision wins and later ones are dropped:
   * an awaiting caller resolves exactly once and therefore issues at most one device call.
   */
  function choose(confirmed: boolean) {
    if (decidedRef.current) return
    decidedRef.current = true
    if (dialogRef.current !== null) closeNativeDialog(dialogRef.current)
    if (confirmed) onConfirm()
    else onCancel()
  }

  function dismiss() {
    choose(false)
  }

  function confirmChoice() {
    choose(true)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== 'Escape') return
    // Browsers fire a `cancel` event (then close) for Escape; preventDefault collapses that into
    // this one path, so a dismissal resolves exactly once either way.
    event.preventDefault()
    dismiss()
  }

  function handleCancelEvent() {
    // Native Escape handling when it arrives without going through the keydown path above.
    dismiss()
  }

  function handleDialogClick(event: MouseEvent<HTMLDialogElement>) {
    // A click on the `::backdrop` targets the `<dialog>` itself; clicks on its content do not.
    if (event.target !== event.currentTarget) return
    dismiss()
  }

  return <dialog
    ref={dialogRef}
    className="confirm-dialog"
    aria-labelledby='confirm-dialog-title'
    aria-describedby={subject === undefined ? 'confirm-dialog-body' : 'confirm-dialog-subject confirm-dialog-body'}
    onKeyDown={handleKeyDown}
    onCancel={handleCancelEvent}
    onClick={handleDialogClick}
  >
    <h2 id='confirm-dialog-title' className='confirm-dialog-title'>{title}</h2>
    {subject !== undefined && <p id='confirm-dialog-subject' className='confirm-dialog-subject'>Subject <code>{subject}</code></p>}
    <p id='confirm-dialog-body' className='confirm-dialog-body'>{body}</p>
    <div className='confirm-dialog-actions'>
      <button ref={cancelButtonRef} className='confirm-cancel-button' type='button' onClick={dismiss}>{cancelLabel}</button>
      <button className={destructive ? 'confirm-action-button is-destructive' : 'confirm-action-button'} type='button' onClick={confirmChoice}>{confirmLabel}</button>
    </div>
  </dialog>
}
