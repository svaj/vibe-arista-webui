/**
 * Type-level and behavioural pins for the shared read union (issue #64, F2). The typecheck gate
 * (`tsc -b` over `src`) is part of the assertion here: `summarize` below only compiles because the
 * `kind` discriminant narrows, and the `expectTypeOf` pins are what F6 (#68) and the S1–S15 screens
 * rely on when they switch on a `LoadState` instead of the union `SwitchManager` declares inline.
 */
import { describe, expect, expectTypeOf, it } from 'vitest'

import { errorMessage, errorState, isLoadError, isLoading, isReady, loadingState, readyState } from './load-state'
import type { LoadErrorState, LoadState, LoadingState, ReadyState } from './load-state'

type Inventory = { readonly vlans: readonly number[] }

/** Reads `state.data` only on the branch the discriminant allows — compiling this file is the proof. */
function summarize(state: LoadState<Inventory>): string {
  if (state.kind === 'loading') return 'loading'
  if (state.kind === 'error') return state.message
  return `${state.data.vlans.length} VLANs`
}

describe('LoadState union', () => {
  it('is an object-literal discriminated union with exactly the three screen states', () => {
    expectTypeOf<LoadState<Inventory>['kind']>().toEqualTypeOf<'loading' | 'error' | 'ready'>()
    expectTypeOf<LoadingState>().toEqualTypeOf<{ readonly kind: 'loading' }>()
    expectTypeOf<LoadErrorState>().toEqualTypeOf<{ readonly kind: 'error'; readonly message: string }>()
    expectTypeOf<ReadyState<Inventory>>().toEqualTypeOf<{ readonly kind: 'ready'; readonly data: Inventory }>()
    expectTypeOf<Extract<LoadState<Inventory>, { kind: 'ready' }>['data']>().toEqualTypeOf<Inventory>()
    // An `enum` would be a syntax error under `erasableSyntaxOnly`; the runtime shape is a plain tag.
    expect(loadingState()).toEqual({ kind: 'loading' })
    expect(errorState('device unreachable')).toEqual({ kind: 'error', message: 'device unreachable' })
    expect(readyState<Inventory>({ vlans: [1, 20] })).toEqual({ kind: 'ready', data: { vlans: [1, 20] } })
  })

  it('narrows by discriminant so a screen never invents a payload for a failed read', () => {
    expect(summarize(loadingState())).toBe('loading')
    expect(summarize(errorState('1003 no json model'))).toBe('1003 no json model')
    expect(summarize(readyState<Inventory>({ vlans: [] }))).toBe('0 VLANs')
  })

  it('keeps a successful empty read on the ready branch, never the error branch', () => {
    const empty = readyState<Inventory>({ vlans: [] })
    const failed = errorState('eAPI connection refused')

    expect(isReady(empty)).toBe(true)
    expect(isLoadError(failed)).toBe(true)
    expect(isLoading(loadingState())).toBe(true)
    expect(isReady(failed)).toBe(false)
    expect(isLoadError(empty)).toBe(false)
    expect(isLoading(empty)).toBe(false)
    // The guards narrow, which is why a screen can use them inside JSX conditionals.
    expectTypeOf(isReady(empty) ? empty.data.vlans.length : -1).toEqualTypeOf<number>()
  })

  it('normalises every rejection shape to device text instead of a blank message', () => {
    expect(errorMessage(new Error('command rejected'))).toBe('command rejected')
    expect(errorMessage('command rejected')).toBe('command rejected')
    expect(errorMessage(undefined)).toBe('undefined')
    expect(errorMessage({ toString: () => 'eAPI error 1002' })).toBe('eAPI error 1002')
    expectTypeOf(errorMessage).parameter(0).toEqualTypeOf<unknown>()
  })
})
