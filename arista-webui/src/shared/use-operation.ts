/**
 * The shared operation primitive (issue #64, F2 of epic #60): the `busy`/`notice`/`failure` triplet
 * every mutating action in the pre-F6 `src/features/SwitchManager.tsx` re-implemented (`preview`, `commitDraft`,
 * `abortDraft`, `abortPending` each do `setFailure('')` → optional progress `setNotice(…)` →
 * `setBusy(true)` → `try`/`catch (setFailure(errorMessage(error)))` → `finally setBusy(false)`).
 *
 * The hook is deliberately text-free: it never bakes in switch wording. `success`/`progress` are
 * caller strings, and the commit-recovery pairing
 * (`"… Commit was attempted; refresh device state before taking another action."`, currently
 * hard-wired inside `commitDraft`) is expressed by {@link OperationOptions.failureSuffix}, so F6
 * (#68) keeps that exact compound message by passing it, while a screen whose failure needs no
 * follow-up passes nothing.
 *
 * Rendering contract for screens (the pattern `SwitchManager` already renders): `failure` is a
 * `role="alert"` block, `notice` is a `role="status" aria-live="polite"` block, and an in-flight
 * operation sets `aria-busy` from `busy`.
 *
 * Two small deviations from the copy-paste idiom, intentional and pinned by the tests:
 * - Every `run()` clears the notice slot on entry (the inlined `abortDraft` left a previous success
 *   notice showing while its own failure alert rendered), and a failure clears the notice too, so
 *   the status slot never claims progress that already failed.
 * - Re-entrant calls are refused outright rather than racing a second device write, matching the
 *   `if (busy || …) return` guard the current handlers lead with.
 */
import { useCallback, useRef, useState } from 'react'

import { errorMessage } from './load-state'

/** What a caller gets back from {@link OperationResult.run}: the task's value, or the failure text. */
export type OperationOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string }

export interface OperationOptions {
  /** Notice text to show once the task resolves successfully. Left as-is when omitted. */
  readonly success?: string
  /** Notice text to show while the task is in flight (e.g. "Staging the change and reading the device diff…"). */
  readonly progress?: string
  /** Appended to the failure text, space-separated — the commit-attempted/refresh-before-acting pairing shape. */
  readonly failureSuffix?: string
}

export interface OperationResult {
  /** True while a task is in flight. Gate the triggering control with it (`aria-busy`, `disabled`). */
  readonly busy: boolean
  /** Success or in-progress text; `''` means render nothing. */
  readonly notice: string
  /** Device/client failure text; `''` means render nothing. */
  readonly failure: string
  /**
   * Run one device-touching task with the triplet managed around it. Resolves — it never rejects —
   * so the caller can branch on the outcome (e.g. call `reload()` only after a committed change).
   */
  readonly run: <T>(task: () => PromiseLike<T>, options?: OperationOptions) => Promise<OperationOutcome<T>>
  /** Drop both message slots (e.g. when a screen unmounts its result panel or starts a new wizard step). */
  readonly clear: () => void
}

const alreadyBusy = 'Another operation is already running.'

export function useOperation(): OperationResult {
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [failure, setFailure] = useState('')
  // `busy` state drives the UI; this mirror makes the re-entry guard exact even when two calls land
  // before React commits, which a state read alone cannot promise.
  const busyRef = useRef(false)

  const run = useCallback(async <T>(task: () => PromiseLike<T>, options: OperationOptions = {}): Promise<OperationOutcome<T>> => {
    if (busyRef.current) return { ok: false, error: alreadyBusy }
    busyRef.current = true
    setBusy(true)
    setFailure('')
    setNotice(options.progress ?? '')
    try {
      const value = await Promise.resolve(task())
      if (options.success !== undefined) setNotice(options.success)
      return { ok: true, value }
    } catch (error: unknown) {
      const message = errorMessage(error)
      setFailure(options.failureSuffix === undefined ? message : `${message} ${options.failureSuffix}`)
      setNotice('')
      return { ok: false, error: message }
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [])

  function clear() {
    setNotice('')
    setFailure('')
  }

  return { busy, notice, failure, run, clear }
}
