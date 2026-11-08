/**
 * Shared device-read state machine for the Web UI screens (issue #64, F2 of the UI roadmap epic #60).
 *
 * These are the primitives the pre-F6 `src/features/SwitchManager.tsx` hand-rolled — the
 * `{ kind: 'loading' } | { kind: 'error'; message } | { kind: 'ready'; data }` union and the
 * `errorMessage()` normaliser — lifted out so every later screen (#71-#85) inherits the same
 * loading/error/empty discipline instead of re-copying it (the epic's standing screen rule).
 *
 * **Why an object-literal discriminated union:** `tsconfig.app.json` sets `erasableSyntaxOnly`, so a
 * TS `enum` is a compile error in app source, and `verbatimModuleSyntax` means every type import is
 * spelled `import type`. `kind` is the discriminant, every branch is `readonly`, and the branches
 * are separate exported interfaces so a screen can name one (e.g. render a `ReadyState<Data>` prop)
 * without restating the union. See `load-state.test.ts` for the type-level pins.
 *
 * **Error-vs-empty rule (pinned by `VlanAssignment.test.tsx` "renders device read failures as errors,
 * not empty results", moved here with the screen by F6/#68):** a failed read must land on the `error`
 * branch carrying `error.message`, never on a `ready` branch with an empty payload, and never as a
 * blank panel. A *successful but empty* read is `ready` with empty data — the two states stay
 * distinct and are the caller's to render differently.
 *
 * F6 (#68) put the first consumer on these: the VLAN screen imports them directly
 * (`../../shared/load-state`) — this directory deliberately has no `index.ts` barrel.
 */

/** The read has started (or a refresh was requested) and the device has not answered yet. */
export interface LoadingState {
  readonly kind: 'loading'
}

/** The read failed. `message` is device/client text, or a caller-supplied configuration prompt. */
export interface LoadErrorState {
  readonly kind: 'error'
  readonly message: string
}

/** The read succeeded. An empty payload is still this branch — empty is never an error. */
export interface ReadyState<T> {
  readonly kind: 'ready'
  readonly data: T
}

/** The three-state read result every device-backed screen switches on. */
export type LoadState<T> = LoadingState | LoadErrorState | ReadyState<T>

export const loadingState = (): LoadingState => ({ kind: 'loading' })

export const errorState = (message: string): LoadErrorState => ({ kind: 'error', message })

export const readyState = <T>(data: T): ReadyState<T> => ({ kind: 'ready', data })

/**
 * Text for a rejected device call, verbatim from `SwitchManager`'s helper: the client rejects with
 * `Error`s for transport/config failures, but a command rejected by EOS may carry something else,
 * so the fallback is `String(error)` rather than a dropped value.
 */
export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export const isLoading = <T>(state: LoadState<T>): state is LoadingState => state.kind === 'loading'

export const isLoadError = <T>(state: LoadState<T>): state is LoadErrorState => state.kind === 'error'

export const isReady = <T>(state: LoadState<T>): state is ReadyState<T> => state.kind === 'ready'
