/**
 * Behavioural pins for the shared operation hook (issue #64, F2). `SwitchManager`'s four mutating
 * handlers (`preview`, `commitDraft`, `abortDraft`, `abortPending`) each hand-roll the same
 * `setFailure('')` → optional progress notice → `setBusy(true)` → `catch setFailure(errorMessage(…))`
 * → `finally setBusy(false)` block; this file pins the single version F6 (#68) rewires them onto,
 * including the commit-recovery pairing the current `commitDraft` catch clause hard-codes.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'

import { useOperation } from './use-operation'
import type { OperationOptions, OperationOutcome } from './use-operation'

/** The exact call signature F6 (#68) and every mutating screen code against. */
type RunFn = <T>(task: () => PromiseLike<T>, options?: OperationOptions) => Promise<OperationOutcome<T>>

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

afterEach(() => vi.restoreAllMocks())

describe('useOperation', () => {
  it('starts idle with empty message slots, so a screen renders neither status nor alert', () => {
    const { result } = renderHook(() => useOperation())

    expect(result.current.busy).toBe(false)
    expect(result.current.notice).toBe('')
    expect(result.current.failure).toBe('')
    expectTypeOf(result.current.run).toEqualTypeOf<RunFn>()
  })

  it('publishes the caller success text and resolves with the task value', async () => {
    const { result } = renderHook(() => useOperation())
    let outcome!: OperationOutcome<string>

    await act(async () => {
      outcome = await result.current.run(async () => 'session ui-test-session committed', {
        success: 'Changes committed to running-config. Startup-config was not changed.',
      })
    })

    expect(result.current.notice).toBe('Changes committed to running-config. Startup-config was not changed.')
    expect(result.current.failure).toBe('')
    expect(result.current.busy).toBe(false)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('expected the ok branch')
    expect(outcome.value).toBe('session ui-test-session committed')
  })

  it('surfaces the thrown device message as the failure and clears the status slot', async () => {
    const { result } = renderHook(() => useOperation())
    let outcome!: OperationOutcome<unknown>

    await act(async () => {
      outcome = await result.current.run(async () => {
        throw new Error('Command aborted: no JSON model for "show lag"')
      }, { progress: 'Staging the change and reading the device diff…' })
    })

    expect(outcome).toEqual({ ok: false, error: 'Command aborted: no JSON model for "show lag"' })
    expect(result.current.failure).toBe('Command aborted: no JSON model for "show lag"')
    // A failure owns the message slot: the in-progress notice never lingers as a success line.
    expect(result.current.notice).toBe('')
    expect(result.current.busy).toBe(false)
  })

  it('appends the caller commit-attempted suffix to the failure, the shape commitDraft renders today', async () => {
    const { result } = renderHook(() => useOperation())

    await act(async () => {
      await result.current.run(async () => {
        throw new Error('Commit failed: session was aborted by another operator')
      }, { failureSuffix: 'Commit was attempted; refresh device state before taking another action.' })
    })

    expect(result.current.failure).toBe('Commit failed: session was aborted by another operator Commit was attempted; refresh device state before taking another action.')
  })

  it('normalises a non-Error rejection to text instead of an empty alert', async () => {
    const { result } = renderHook(() => useOperation())

    await act(async () => {
      await result.current.run(async () => {
        throw 'eAPI channel closed'
      })
    })

    expect(result.current.failure).toBe('eAPI channel closed')
  })

  it('flips busy for the whole task and shows the in-progress notice while it runs', async () => {
    const gate = deferred<string>()
    const { result } = renderHook(() => useOperation())
    let running!: Promise<OperationOutcome<string>>

    await act(async () => {
      running = result.current.run(async () => {
        await gate.promise
        return 'diff staged'
      }, { progress: 'Staging the change and reading the device diff…', success: 'Review the device diff before committing this change.' })
    })

    expect(result.current.busy).toBe(true)
    expect(result.current.notice).toBe('Staging the change and reading the device diff…')
    expect(result.current.failure).toBe('')

    await act(async () => {
      gate.resolve('diff staged')
      await running
    })

    expect(result.current.busy).toBe(false)
    expect(result.current.notice).toBe('Review the device diff before committing this change.')
  })

  it('refuses a re-entrant call while busy without touching the message slots', async () => {
    const gate = deferred<string>()
    const second = vi.fn(async () => 'must not run')
    const { result } = renderHook(() => useOperation())
    let running!: Promise<OperationOutcome<string>>

    await act(async () => {
      running = result.current.run(async () => {
        await gate.promise
        return 'first'
      }, { success: 'Session was aborted.' })
    })

    let refused!: OperationOutcome<string>
    await act(async () => {
      refused = await result.current.run(second, { success: 'Second operation.' })
    })

    expect(refused).toEqual({ ok: false, error: 'Another operation is already running.' })
    expect(second).not.toHaveBeenCalled()
    expect(result.current.notice).toBe('')
    expect(result.current.failure).toBe('')

    await act(async () => {
      gate.resolve('first')
      await running
    })
    expect(result.current.notice).toBe('Session was aborted.')
  })

  it('clears the previous failure when a later operation succeeds', async () => {
    const { result } = renderHook(() => useOperation())

    await act(async () => {
      await result.current.run(async () => {
        throw new Error('device unreachable')
      })
    })
    expect(result.current.failure).toBe('device unreachable')

    await act(async () => {
      await result.current.run(async () => 'retry', { success: 'Device state refreshed.' })
    })

    expect(result.current.failure).toBe('')
    expect(result.current.notice).toBe('Device state refreshed.')
  })

  it('clear() drops both message slots without disturbing the busy state', async () => {
    const { result } = renderHook(() => useOperation())

    await act(async () => {
      await result.current.run(async () => {
        throw new Error('abort refused')
      }, { success: 'Pending session stale-pending was aborted.' })
    })
    expect(result.current.failure).toBe('abort refused')

    act(() => {
      result.current.clear()
    })
    expect(result.current.failure).toBe('')
    expect(result.current.notice).toBe('')
    expect(result.current.busy).toBe(false)
  })

  it('leaves the notice untouched on success when the caller supplies no success text', async () => {
    const { result } = renderHook(() => useOperation())

    await act(async () => {
      await result.current.run(async () => 'value', { progress: 'Reading device state…' })
    })

    expect(result.current.notice).toBe('Reading device state…')
    expect(result.current.busy).toBe(false)
  })
})
