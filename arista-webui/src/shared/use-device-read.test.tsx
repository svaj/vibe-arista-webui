/**
 * Behavioural pins for the shared device-read hook and its soft-read helpers (issue #64, F2).
 * These are the semantics `SwitchManager`'s inlined effect implements today — eager batch, the
 * `active` cancel flag, the `reloadKey` refresh, error-carries-`error.message`, and the soft
 * identity/status reads — expressed against `renderHook` so F6 (#68) can rewire the screen onto the
 * hook without re-deriving them, and so the S1–S15 screens inherit them.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'

import { foldSoftRead, softErrorText, softRead, softValue, useDeviceRead } from './use-device-read'
import type { SoftFold, SoftRead } from './use-device-read'
import type { LoadState } from './load-state'

type Inventory = { readonly vlans: readonly number[] }

/** Exact-type equality (same helper `src/eapi-show-contracts.test.ts` uses) for the contract pins below. */
type Exactly<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Drain the microtask/timer queue inside `act`, so a deliberately dropped resolution cannot leak an act warning. */
async function settle() {
  await act(async () => {
    await new Promise<void>((done) => {
      setTimeout(done, 0)
    })
  })
}

afterEach(() => vi.restoreAllMocks())

describe('useDeviceRead', () => {
  it('holds the loading state while the read batch is unresolved, then publishes the payload once', async () => {
    const read = deferred<Inventory>()
    const loader = vi.fn(() => read.promise)
    const { result } = renderHook(() => useDeviceRead(loader, []))

    expect(result.current.state).toEqual({ kind: 'loading' })
    expect(loader).toHaveBeenCalledOnce()

    read.resolve({ vlans: [1, 20] })
    await waitFor(() => expect(result.current.state).toEqual({ kind: 'ready', data: { vlans: [1, 20] } }))
    await settle()
    expect(loader).toHaveBeenCalledOnce()
  })

  it('holds a successful empty read on the ready branch, never as an error', async () => {
    const loader = vi.fn(async (): Promise<Inventory> => ({ vlans: [] }))
    const { result } = renderHook(() => useDeviceRead(loader, []))

    await waitFor(() => expect(result.current.state).toEqual({ kind: 'ready', data: { vlans: [] } }))
    expect(result.current.state.kind).toBe('ready')
  })

  it('drops a read that lands after the screen unmounted, leaving no state write behind', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const read = deferred<Inventory>()
    const loader = vi.fn(() => read.promise)
    const { result, unmount } = renderHook(() => useDeviceRead(loader, []))
    const lastRendered = result.current.state
    expect(lastRendered).toEqual({ kind: 'loading' })

    unmount()
    read.resolve({ vlans: [1] })
    await settle()

    // React 19 discards updates for an unmounted tree regardless, so the observable contract here is
    // that the hook wrote *nothing*: the last rendered state object is the same object, the loader was
    // not re-invoked, and React logged no act/unmounted-component warning. The `active` flag itself is
    // proved observably by the superseded-read test below, where the tree is still mounted.
    expect(result.current.state).toBe(lastRendered)
    expect(loader).toHaveBeenCalledOnce()
    expect(errors).not.toHaveBeenCalled()
    expect(warnings).not.toHaveBeenCalled()
  })

  it('drops a superseded read so a refresh can never flash stale inventory back', async () => {
    const first = deferred<Inventory>()
    const second = deferred<Inventory>()
    const queue: readonly Promise<Inventory>[] = [first.promise, second.promise]
    let next = 0
    const loader = vi.fn(() => queue[next++] ?? first.promise)
    const { result } = renderHook(() => useDeviceRead(loader, []))
    expect(loader).toHaveBeenCalledOnce()

    act(() => {
      result.current.reload()
    })
    expect(result.current.state).toEqual({ kind: 'loading' })
    expect(loader).toHaveBeenCalledTimes(2)

    first.resolve({ vlans: [99] })
    await settle()
    expect(result.current.state).toEqual({ kind: 'loading' })

    second.resolve({ vlans: [1, 20] })
    await waitFor(() => expect(result.current.state).toEqual({ kind: 'ready', data: { vlans: [1, 20] } }))
  })

  it('reload() re-runs the read batch and replaces the payload', async () => {
    let attempt = 0
    const loader = vi.fn(async () => {
      attempt += 1
      return { attempt }
    })
    const { result } = renderHook(() => useDeviceRead(loader, []))

    await waitFor(() => expect(result.current.state).toEqual({ kind: 'ready', data: { attempt: 1 } }))
    act(() => {
      result.current.reload()
    })
    await waitFor(() => expect(result.current.state).toEqual({ kind: 'ready', data: { attempt: 2 } }))
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('re-reads on a caller dependency change and never loops on the inline loader closure', async () => {
    let reads = 0
    const { result, rerender } = renderHook(({ port }: { port: number }) => useDeviceRead(async () => {
      reads += 1
      return { port }
    }, [port]), { initialProps: { port: 1 } })

    await waitFor(() => expect(result.current.state).toEqual({ kind: 'ready', data: { port: 1 } }))
    rerender({ port: 2 })
    await waitFor(() => expect(result.current.state).toEqual({ kind: 'ready', data: { port: 2 } }))

    // Two more renders hand the hook brand-new loader closures with an unchanged dependency list:
    // re-reading here would be an infinite read loop, so the call count is the assertion.
    rerender({ port: 2 })
    rerender({ port: 2 })
    await settle()
    expect(reads).toBe(2)
  })

  it('turns a hard read failure into the error branch carrying the device message', async () => {
    const loader = vi.fn(async (): Promise<Inventory> => {
      throw new Error('device unreachable')
    })
    const { result } = renderHook(() => useDeviceRead(loader, []))

    await waitFor(() => expect(result.current.state).toEqual({ kind: 'error', message: 'device unreachable' }))
  })

  it('keeps a non-Error rejection and a loader that throws before returning a promise as error text', async () => {
    const rejection = vi.fn(async (): Promise<Inventory> => {
      throw 'eAPI request timed out'
    })
    const { result: rejectionResult } = renderHook(() => useDeviceRead(rejection, []))
    await waitFor(() => expect(rejectionResult.current.state).toEqual({ kind: 'error', message: 'eAPI request timed out' }))

    const syncThrow = vi.fn((): Promise<Inventory> => {
      throw new Error('config session refused')
    })
    const { result: syncResult } = renderHook(() => useDeviceRead<Inventory>(syncThrow, []))
    await waitFor(() => expect(syncResult.current.state).toEqual({ kind: 'error', message: 'config session refused' }))
  })

  it('recovers through reload() after a failed read, the Retry read button shape', async () => {
    let attempt = 0
    const loader = vi.fn(async (): Promise<Inventory> => {
      attempt += 1
      if (attempt === 1) throw new Error('device unreachable')
      return { vlans: [10] }
    })
    const { result } = renderHook(() => useDeviceRead(loader, []))

    await waitFor(() => expect(result.current.state).toEqual({ kind: 'error', message: 'device unreachable' }))
    act(() => {
      result.current.reload()
    })
    await waitFor(() => expect(result.current.state).toEqual({ kind: 'ready', data: { vlans: [10] } }))
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('never contacts the device while the read is disabled and holds the caller prompt instead', async () => {
    const prompt = 'Set EAPI_HOST, EAPI_USER, and EAPI_PASS in arista-webui/.env.local, then restart Vite.'
    const loader = vi.fn(async (): Promise<Inventory> => ({ vlans: [10] }))
    const { result, rerender } = renderHook(({ enabled }: { enabled: boolean }) => useDeviceRead(loader, [], { enabled, disabledMessage: prompt }), { initialProps: { enabled: false } })

    expect(result.current.state).toEqual({ kind: 'error', message: prompt })
    act(() => {
      result.current.reload()
    })
    expect(result.current.state).toEqual({ kind: 'error', message: prompt })
    expect(loader).not.toHaveBeenCalled()

    rerender({ enabled: true })
    await waitFor(() => expect(result.current.state).toEqual({ kind: 'ready', data: { vlans: [10] } }))
    expect(loader).toHaveBeenCalledOnce()
  })

  it('falls back to a neutral prompt when a disabled read supplies no text', async () => {
    const loader = vi.fn(async (): Promise<Inventory> => ({ vlans: [10] }))
    const { result } = renderHook(() => useDeviceRead(loader, [], { enabled: false }))

    expect(result.current.state.kind).toBe('error')
    expect(result.current.state).toEqual({ kind: 'error', message: 'Device read is unavailable.' })
    expect(loader).not.toHaveBeenCalled()
  })

  it('types the hook result exactly as the consuming screens declare it', async () => {
    const loader = async (): Promise<Inventory> => ({ vlans: [10] })
    const { result } = renderHook(() => useDeviceRead(loader, []))

    await waitFor(() => expect(result.current.state.kind).toBe('ready'))
    expectTypeOf(result.current.state).toEqualTypeOf<LoadState<Inventory>>()
    expectTypeOf(result.current.reload).toEqualTypeOf<() => void>()
  })
})

describe('softRead and the fold helpers', () => {
  it('keeps a soft read failure inside the ready payload, exactly like the statusError half of SwitchManager', async () => {
    const getVlans = vi.fn(async () => [10, 20])
    const getStatus = vi.fn(async (): Promise<ReadonlyMap<string, string>> => {
      throw new Error('1002 no output returned')
    })
    const showVersion = vi.fn(async (): Promise<{ readonly hostname: string }> => {
      throw new Error('1003 no json model for show version')
    })
    const { result } = renderHook(() => useDeviceRead(async () => {
      const [vlans, status, version] = await Promise.all([getVlans(), softRead(getStatus()), softRead(showVersion(), { silent: true })])
      return { vlans, ...foldSoftRead('status', status), identity: softValue(version) }
    }, []))

    await waitFor(() => expect(result.current.state.kind).toBe('ready'))
    const state = result.current.state
    if (state.kind !== 'ready') throw new Error(`expected the ready branch, saw ${state.kind}`)
    // The hard reads survive, the unavailable status read reports its device text, and the identity
    // chip is simply absent — no error state, so the workspace the screen needs stays rendered.
    expect(state.data).toEqual({ vlans: [10, 20], statusError: '1002 no output returned', identity: undefined })
    expect(result.current.state.kind).not.toBe('error')
  })

  it('folds a successful soft read into its value key', async () => {
    const statuses = new Map([['Ethernet1', 'connected']])
    const read = await softRead(Promise.resolve(statuses))

    expect(read).toEqual({ kind: 'ok', value: statuses })
    expect(softValue(read)).toBe(statuses)
    expect(softErrorText(read)).toBeUndefined()
    expect(foldSoftRead('status', read)).toEqual({ status: statuses })
    expect(Object.keys(foldSoftRead('status', read))).toEqual(['status'])
  })

  it('folds a non-silent soft read failure into the <name>Error key', async () => {
    const okRead: SoftRead<readonly number[]> = { kind: 'ok', value: [10] }
    const failedRead: SoftRead<readonly number[]> = { kind: 'failed', error: '1002 no output returned' }

    expect(foldSoftRead('vlans', okRead)).toEqual({ vlans: [10] })
    expect(Object.keys(foldSoftRead('vlans', okRead))).toEqual(['vlans'])
    expect(foldSoftRead('vlans', failedRead)).toEqual({ vlansError: '1002 no output returned' })
    expect(Object.keys(foldSoftRead('vlans', failedRead))).toEqual(['vlansError'])
    expect(softValue(failedRead)).toBeUndefined()
    expect(softErrorText(failedRead)).toBe('1002 no output returned')
    // One key or the other, never both — this is what lets a screen test for the error key. The
    // `<name>Error` spelling is part of the contract F6 code against, hence the exact-type pin.
    expectTypeOf<Exactly<SoftFold<'vlans', readonly number[]>, { readonly vlans: readonly number[] } | { readonly vlansError: string }>>().toEqualTypeOf<true>()
  })

  it('silently swallows a best-effort failure, the identity-chip shape', async () => {
    const failed = await softRead(Promise.reject(new Error('1003 no json model')), { silent: true })

    expect(failed).toEqual({ kind: 'failed', error: '' })
    expect(softValue(failed)).toBeUndefined()
    expect(softErrorText(failed)).toBeUndefined()
  })

  it('normalises a non-Error soft rejection through errorMessage and never rejects', async () => {
    const failed = await softRead(Promise.reject('connection reset'))

    if (failed.kind !== 'failed') throw new Error('expected the failed branch')
    expect(failed.error).toBe('connection reset')
    expectTypeOf(softRead(Promise.resolve(10))).toEqualTypeOf<Promise<SoftRead<number>>>()
  })
})
