/**
 * The shared device-read hook (issue #64, F2 of epic #60): the eager read batch + cancel-on-unmount
 * `active` flag + `reloadKey` refresh that `src/features/SwitchManager.tsx` inlines today.
 *
 * The hook owns only the state machine, never the read itself: the caller's `loader` is whatever
 * batch of client calls that screen needs (`Promise.all` of `vlans.getAll()`/`switchports.getAll()`/
 * `listSessions()`/… in `SwitchManager`'s effect), so the payload type `T` stays the screen's. The
 * caller also owns the dependency list, mirroring the effect's current `[node, proxyConfigured,
 * reloadKey]` — the hook appends its own keys, so the array length is fixed per call site.
 *
 * Two behaviours are load-bearing and pinned by `use-device-read.test.tsx`:
 * - **A superseded or unmounted read can never write state.** The effect's cleanup flips `active`,
 *   so a late resolution (stale device data after a refresh, a read that lands after the screen
 *   unmounted, or one still in flight when the gate flips off) is dropped instead of flashing old
 *   inventory — or a stale success — back onto the screen.
 * - **A hard read failure is an error state carrying `error.message`**, never a blank/ready payload.
 *
 * Best-effort reads (`getStatus()` half of the VLAN screen, the `show version` identity chip) do
 * *not* go through the error branch — they fold their failure into the success payload via
 * {@link softRead} below, which is the generic form of `SwitchManager`'s `statusResult`/
 * `versionResult` wrappers, so one unavailable model never blanks the workspace.
 */
import { useEffect, useRef, useState } from 'react'

import { errorMessage, errorState, loadingState, readyState } from './load-state'
import type { LoadState } from './load-state'

/**
 * Placeholder used when a read is disabled and the caller supplied no text. The real prompt stays
 * with the screen (F6 passes the "set EAPI_HOST, EAPI_USER, and EAPI_PASS …" proxy instructions),
 * because only the screen knows why its device handle is missing.
 */
const readUnavailable = 'Device read is unavailable.'

export interface DeviceReadOptions {
  /** Gate the read on the screen actually having a device to talk to (mirrors `proxyConfigured && node !== undefined`). */
  readonly enabled?: boolean
  /** Error text to hold while `enabled` is false. The hook never guesses proxy/credential text. */
  readonly disabledMessage?: string
}

export interface DeviceReadResult<T> {
  readonly state: LoadState<T>
  /** Re-run the read from scratch: flips state back to `loading` and bumps the internal reload key. A no-op while disabled. */
  readonly reload: () => void
}

/**
 * Reads device state into a {@link LoadState}, re-running whenever `deps` (plus this hook's own
 * `reloadKey`/`enabled`/`disabledMessage`) change. A dependency change keeps showing the previous
 * payload until the new read resolves — only {@link DeviceReadResult.reload} resets to `loading`,
 * matching the current `SwitchManager` behaviour.
 */
export function useDeviceRead<T>(
  loader: () => PromiseLike<T>,
  deps: readonly unknown[],
  options: DeviceReadOptions = {},
): DeviceReadResult<T> {
  const { enabled = true, disabledMessage = readUnavailable } = options
  const [reloadKey, setReloadKey] = useState(0)
  const [state, setState] = useState<LoadState<T>>(() => (enabled ? loadingState() : errorState(disabledMessage)))
  // The loader closes over this render's props, but its identity must not be a dependency — every
  // screen passes an inline closure. Effects run in declaration order, so this capture lands before
  // the read effect below in the same commit and a dependency change never runs a stale loader.
  const loaderRef = useRef(loader)

  useEffect(() => {
    loaderRef.current = loader
  })

  useEffect(() => {
    let active = true
    if (!enabled) {
      setState((current) => (current.kind === 'error' && current.message === disabledMessage ? current : errorState(disabledMessage)))
      return () => {
        active = false
      }
    }
    let read: PromiseLike<T>
    try {
      read = loaderRef.current()
    } catch (error: unknown) {
      setState(errorState(errorMessage(error)))
      return () => {
        active = false
      }
    }
    void Promise.resolve(read)
      .then((data) => {
        if (active) setState(readyState(data))
      })
      .catch((error: unknown) => {
        if (active) setState(errorState(errorMessage(error)))
      })
    return () => {
      active = false
    }
    // `deps` is the caller's contract (the same list the inlined effect used); the last three are
    // ours. The spread trips `react-hooks/exhaustive-deps` ("complex expression") and the
    // synchronous disabled-slot write trips `set-state-in-effect` — the same warning
    // `src/features/SwitchManager.tsx` already carries for the effect being extracted. Hoisting the
    // list into a variable is worse: it swaps in "dependency list is not an array literal".
  }, [...deps, reloadKey, enabled, disabledMessage])

  function reload() {
    if (!enabled) return
    setState(loadingState())
    setReloadKey((key) => key + 1)
  }

  return { state, reload }
}

/**
 * Outcome of a best-effort read: the generic shape of `SwitchManager`'s two soft-read wrappers,
 * `getStatus().then((statuses) => ({ statuses })).catch((error) => ({ statusError: errorMessage(error) }))`
 * and `show('version').then((version) => ({ identity })).catch(() => ({}))`. Wrapping a read this
 * way keeps its failure inside the `ready` payload, so one unmodelled or unreachable show command
 * cannot blank the screen the way a hard read does.
 */
export type SoftRead<T> = { readonly kind: 'ok'; readonly value: T } | { readonly kind: 'failed'; readonly error: string }

export interface SoftReadOptions {
  /** Swallow the failure text entirely (the `catch(() => ({}))` identity-chip shape): the value is just absent. */
  readonly silent?: boolean
}

/**
 * Start-then-wrap a read, as the current effect does (`node.interfaces.getStatus()` is already in
 * flight before `Promise.all` joins it). The returned promise never rejects — that is the point.
 */
export function softRead<T>(read: PromiseLike<T>, options: SoftReadOptions = {}): Promise<SoftRead<T>> {
  return Promise.resolve(read).then(
    (value) => ({ kind: 'ok', value }),
    (failure: unknown) => ({ kind: 'failed', error: options.silent === true ? '' : errorMessage(failure) }),
  )
}

/** The value a soft read produced, or `undefined` when it failed — the `identity` chip accessor. */
export function softValue<T>(read: SoftRead<T>): T | undefined {
  return read.kind === 'ok' ? read.value : undefined
}

/** The failure text a soft read folded in, or `undefined` when it succeeded or failed silently. */
export function softErrorText(read: SoftRead<unknown>): string | undefined {
  return read.kind === 'failed' && read.error !== '' ? read.error : undefined
}

export type SoftFold<Name extends string, T> = { readonly [K in Name]: T } | { readonly [K in `${Name}Error`]: string }

/**
 * Fold a non-silent soft read into a payload under a name pair, exactly as `SwitchManager` does by
 * hand: success contributes `{ status: … }`, failure contributes `{ statusError: message }`. Only
 * one of the two keys exists, so a screen renders "Interface status is unavailable: …" from the
 * presence of the error key. Use {@link softValue} for silent reads, which contribute nothing.
 */
export function foldSoftRead<Name extends string, T>(name: Name, read: SoftRead<T>): SoftFold<Name, T> {
  if (read.kind === 'ok') {
    return { [name]: read.value } as SoftFold<Name, T>
  }
  return { [`${name}Error`]: read.error } as SoftFold<Name, T>
}
