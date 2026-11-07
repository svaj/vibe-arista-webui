/**
 * `useConfirm()` — an awaitable, accessible confirmation prompt (issue #66), replacing the
 * three blocking `window.confirm()` call sites in `SwitchManager`.
 *
 * `ConfirmProvider` renders exactly one `ConfirmDialog` host, and `useConfirm()` hands back a
 * function that resolves to the operator's decision:
 *
 * ```ts
 * const confirmed = await confirm({ title, body, confirmLabel, destructive: true, subject })
 * if (!confirmed) return           // Cancel, Escape or a backdrop click: nothing reached the device
 * ```
 *
 * The promise never resolves `true` on its own: only an explicit activation of the confirm
 * control does. Every other close — Cancel, Escape, backdrop, a native `cancel` event, or the
 * host unmounting while a prompt is open — resolves `false`, so an awaited prompt can never hang
 * a device flow nor imply success the device was not asked for.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { ConfirmDialog } from '../components/ui/ConfirmDialog'

export type ConfirmOptions = {
  readonly title: string
  readonly body: string
  readonly confirmLabel: string
  readonly cancelLabel?: string
  readonly destructive?: boolean
  readonly subject?: string
}

export type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>

type PendingRequest = ConfirmOptions & { readonly id: number }
type PendingDecision = { readonly id: number; readonly resolve: (value: boolean) => void }

const ConfirmContext = createContext<ConfirmFn | null>(null)

export function ConfirmProvider({ children }: { readonly children: ReactNode }) {
  const [request, setRequest] = useState<PendingRequest | undefined>(undefined)
  const decisionRef = useRef<PendingDecision | undefined>(undefined)
  const sequenceRef = useRef(0)

  /**
   * Settles a prompt at most once per `id`. A single user gesture can reach several close paths
   * (Escape keydown plus the browser's own `cancel`/`close` events), so the first decision wins and
   * the rest are ignored instead of double-resolving into a second device call.
   */
  function settle(id: number, value: boolean) {
    const pending = decisionRef.current
    if (pending === undefined || pending.id !== id) return
    decisionRef.current = undefined
    setRequest((current) => current?.id === id ? undefined : current)
    pending.resolve(value)
  }

  const confirm = useCallback<ConfirmFn>((options) => new Promise<boolean>((resolve) => {
    // A second prompt replaces an unanswered first one rather than stacking two modal dialogs;
    // the replaced prompt resolves `false` so its awaiting flow stops without touching the device.
    const superseded = decisionRef.current
    if (superseded !== undefined) {
      decisionRef.current = undefined
      superseded.resolve(false)
    }
    const id = sequenceRef.current + 1
    sequenceRef.current = id
    decisionRef.current = { id, resolve }
    setRequest({ ...options, id })
  }), [])

  useEffect(() => () => {
    const pending = decisionRef.current
    if (pending === undefined) return
    decisionRef.current = undefined
    pending.resolve(false)
  }, [])

  return <ConfirmContext.Provider value={confirm}>
    {children}
    {request !== undefined && <ConfirmDialog
      // One host instance per prompt: a replaced or follow-up request must start with a fresh
      // open/focus pass and an unanswered decision, never reuse the previous prompt's.
      key={request.id}
      title={request.title}
      body={request.body}
      confirmLabel={request.confirmLabel}
      {...(request.cancelLabel === undefined ? {} : { cancelLabel: request.cancelLabel })}
      destructive={request.destructive ?? false}
      {...(request.subject === undefined ? {} : { subject: request.subject })}
      onConfirm={() => settle(request.id, true)}
      onCancel={() => settle(request.id, false)}
    />}
  </ConfirmContext.Provider>
}

/** Prompt host for the nearest `ConfirmProvider`. */
export function useConfirm(): ConfirmFn {
  const confirm = useContext(ConfirmContext)
  if (confirm === null) throw new Error('useConfirm requires a <ConfirmProvider> ancestor to render the confirm dialog.')
  return confirm
}
