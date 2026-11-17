/**
 * #153: the app's eAPI node must carry an explicit UI-path request deadline, so a target whose
 * connection hangs (the vite proxy's eAPI port refused → the proxy never answers) surfaces as a
 * failed read with the timeout as the reason — instead of the browser sitting on
 * "Connecting through local proxy…" until the client's 60 s library default (or, pre-#153, the
 * operator's patience) runs out.
 *
 * This is deliberately NOT a fake-node screen test: it drives the REAL `createNode` →
 * `HttpTransport` → `createFetchSender` path with only `fetch` stubbed, because the behavior under
 * test is exactly how our deadline reaches fetch (AbortController) and how the resulting rejection
 * is typed. The no-device-contact rule (#153 "ordinary offline tests can cover it") holds: nothing
 * here dials a switch; jsdom/undici fetch is replaced wholesale.
 *
 * A response that never settles is the ONLY stub shape that reproduces the incident — a stub that
 * rejects immediately would test the connect-error path, which already worked. The stub therefore
 * mirrors real `fetch` abort semantics: reject with `AbortError` when the signal fires, otherwise
 * hang. `mapWireFailure`'s deadline branch is what this pins the UI node against.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_TIMEOUT_MS, TimeoutError } from '@devhax-heavy-industries/arista-eapi'

import { createAppNode, UI_REQUEST_TIMEOUT_MS } from './app-node'

/** The proxy origin the app would use in dev; loopback keeps the client's cleartext gate open. */
const PROXY_ORIGIN = 'http://127.0.0.1:5199'

/** `fetch` replacement: records the call/hang and rejects with `AbortError` when the signal fires. */
function hangingFetch() {
  return vi.fn((_input: string, init?: { signal?: AbortSignal }) =>
    new Promise<never>((_resolve, reject) => {
      const signal = init?.signal
      if (signal?.aborted === true) {
        reject(new DOMException('This operation was aborted', 'AbortError'))
        return
      }
      signal?.addEventListener('abort', () => {
        reject(new DOMException('This operation was aborted', 'AbortError'))
      }, { once: true })
    }),
  )
}

interface Settled {
  readonly outcome: 'resolved' | 'rejected'
  readonly error?: unknown
}

describe('createAppNode (#153 UI-path request timeout)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('ships a deadline strictly below the client 60 s library default', () => {
    // The whole point of #153: the browser app must not rely on DR-019's scripted-work default.
    // If someone retunes this ABOVE the library default, the UI is slower to fail than the raw
    // client — this pin forces that change to be argued in review, and the tuning note in
    // app-node.ts (floor, not measured margin) to be re-read.
    expect(UI_REQUEST_TIMEOUT_MS).toBeGreaterThan(0)
    expect(UI_REQUEST_TIMEOUT_MS).toBeLessThan(DEFAULT_TIMEOUT_MS)
  })

  it('posts through the proxy /command-api path like the pre-#153 App call did', async () => {
    const fetchMock = hangingFetch()
    vi.stubGlobal('fetch', fetchMock)
    const node = createAppNode(PROXY_ORIGIN)
    void node.vlans.getAll().catch(() => undefined)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // The transport hands fetch a URL object, not a string — stringify before matching.
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${PROXY_ORIGIN}/command-api`)
  })

  it('does NOT fire just before the deadline and rejects exactly at it with a typed TimeoutError', async () => {
    vi.stubGlobal('fetch', hangingFetch())
    const node = createAppNode(PROXY_ORIGIN)

    const settled: Settled[] = []
    const read = node.vlans.getAll()
    void read.then(
      () => settled.push({ outcome: 'resolved' }),
      (error: unknown) => settled.push({ outcome: 'rejected', error }),
    )

    // Kick the microtask queue so the sender has armed its timer and issued fetch.
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(UI_REQUEST_TIMEOUT_MS - 2)
    expect(settled).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toHaveLength(1)
    const first = settled[0]
    expect(first?.outcome).toBe('rejected')
    expect(first?.error).toBeInstanceOf(TimeoutError)
    const error = first?.error as TimeoutError
    // The reason a later e2e assertion (and the operator) stands on: endpoint + expired number.
    expect(error.message).toContain('timed out')
    expect(error.message).toContain(`after ${String(UI_REQUEST_TIMEOUT_MS)} ms`)
    expect(error.message).toContain(`${PROXY_ORIGIN}/command-api`)
    // DR-019: a timed-out request may already have reached the device — never marked retryable.
    expect(error.retryable).toBe(false)
  })
})
