import { createContext, useContext, useMemo, useSyncExternalStore } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { createWebStorageJournal } from '@devhax-heavy-industries/arista-eapi'
import { TransactionCoordinator } from './transaction'
import type { TransactionNode, TransactionSnapshot } from './transaction'

interface TransactionContextValue {
  readonly coordinator?: TransactionCoordinator
}

const TransactionContext = createContext<TransactionContextValue | undefined>(undefined)

export interface TransactionProviderProps {
  readonly node: TransactionNode | undefined
  readonly children: ReactNode
}

export function TransactionProvider({ node, children }: TransactionProviderProps): ReactElement {
  const coordinator = useMemo(
    () => node === undefined ? undefined : new TransactionCoordinator(node, createWebStorageJournal(window.localStorage)),
    [node],
  )
  const value = useMemo<TransactionContextValue>(() => ({ ...(coordinator === undefined ? {} : { coordinator }) }), [coordinator])
  return <TransactionContext.Provider value={value}>{children}</TransactionContext.Provider>
}

export function TransactionScope({ node, children }: TransactionProviderProps): ReactElement {
  const context = useContext(TransactionContext)
  if (context !== undefined) return <>{children}</>
  return <TransactionProvider node={node}>{children}</TransactionProvider>
}

export function useTransaction(): TransactionCoordinator | undefined {
  const context = useContext(TransactionContext)
  if (context === undefined) throw new Error('useTransaction must be used inside TransactionProvider')
  return context.coordinator
}

const unavailableSnapshot: TransactionSnapshot = { status: 'idle', entries: [], canCommit: false }
const subscribeUnavailable = (): (() => void) => () => undefined
const getUnavailableSnapshot = (): TransactionSnapshot => unavailableSnapshot

export function useTransactionSnapshot(): TransactionSnapshot {
  const coordinator = useTransaction()
  return useSyncExternalStore(
    coordinator?.subscribe ?? subscribeUnavailable,
    coordinator?.getSnapshot ?? getUnavailableSnapshot,
  )
}
