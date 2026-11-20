import type { CommandSpec, ConfigSession, ConfigSessionOptions, SessionJournal } from '@devhax-heavy-industries/arista-eapi'

export type TransactionStatus = 'idle' | 'opening' | 'staging' | 'ready' | 'committing' | 'aborting' | 'uncertain'

export interface TransactionConfirmation {
  readonly title: string
  readonly body: string
  readonly label: string
  readonly subject: string
}

export interface StagedTransactionEntry {
  readonly id: number
  readonly source: string
  readonly action: string
  readonly commands: readonly CommandSpec[]
  readonly display: readonly string[]
  readonly risks: readonly string[]
  readonly confirmations: readonly TransactionConfirmation[]
}

export interface StageTransactionInput {
  readonly source: string
  readonly action: string
  readonly commands: readonly CommandSpec[]
  readonly display: readonly string[]
  readonly risks: readonly string[]
  readonly confirmations?: readonly TransactionConfirmation[]
  readonly redactDiff?: (text: string) => string
}

export interface TransactionSnapshot {
  readonly status: TransactionStatus
  readonly sessionName?: string
  readonly entries: readonly StagedTransactionEntry[]
  readonly diff?: string
  readonly canCommit: boolean
  readonly uncertainReason?: string
}

type TransactionSession = Pick<ConfigSession, 'name' | 'run' | 'diff' | 'hasDiffBeenRead' | 'commit' | 'abort'>
export interface TransactionNode {
  configSession(options?: ConfigSessionOptions): Promise<TransactionSession>
}
type SnapshotListener = (snapshot: TransactionSnapshot) => void

const idleSnapshot = (): TransactionSnapshot => ({ status: 'idle', entries: [], canCommit: false })

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class TransactionCoordinator {
  private snapshot = idleSnapshot()
  private session: TransactionSession | undefined
  private queue: Promise<void> = Promise.resolve()
  private nextEntryId = 1
  private readonly listeners = new Set<SnapshotListener>()
  private diffRedactors: readonly ((text: string) => string)[] = []
  private readonly node: TransactionNode
  private readonly journal: SessionJournal | undefined

  constructor(node: TransactionNode, journal: SessionJournal | undefined = undefined) {
    this.node = node
    this.journal = journal
  }

  getSnapshot = (): TransactionSnapshot => this.snapshot

  subscribe = (listener: SnapshotListener): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  append(input: StageTransactionInput): Promise<TransactionSnapshot> {
    return this.serialized(async () => {
      this.assertNotUncertain()
      const session = await this.openSession()
      this.setSnapshot({ ...this.snapshot, status: 'staging' })

      try {
        await session.run(input.commands)
      } catch (error) {
        this.markUncertain(`Staging ${JSON.stringify(input.action)} may have partially applied; refresh the device session before continuing. ${errorText(error)}`)
        throw error
      }

      const entry: StagedTransactionEntry = {
        id: this.nextEntryId,
        source: input.source,
        action: input.action,
        commands: [...input.commands],
        display: [...input.display],
        risks: [...input.risks],
        confirmations: [...(input.confirmations ?? [])],
      }
      if (input.redactDiff !== undefined) this.diffRedactors = [...this.diffRedactors, input.redactDiff]
      this.nextEntryId += 1
      this.setSnapshot({ ...this.snapshot, entries: [...this.snapshot.entries, entry] })

      const diff = await this.readDiff(session, 'The change was staged, but the combined diff could not be read')
      this.setSnapshot({ status: 'ready', sessionName: session.name, entries: this.snapshot.entries, diff, canCommit: session.hasDiffBeenRead() })
      return this.snapshot
    })
  }

  refreshDiff(): Promise<TransactionSnapshot> {
    return this.serialized(async () => {
      this.assertNotUncertain()
      if (this.session === undefined) throw new Error('There is no active transaction to refresh.')
      const diff = await this.readDiff(this.session, 'The combined diff could not be refreshed')
      this.setSnapshot({ ...this.snapshot, status: 'ready', diff, canCommit: this.session.hasDiffBeenRead() })
      return this.snapshot
    })
  }

  commit(): Promise<void> {
    return this.serialized(async () => {
      this.assertNotUncertain()
      if (this.session === undefined) throw new Error('There is no active transaction to commit.')
      if (!this.session.hasDiffBeenRead() || this.snapshot.entries.length === 0) {
        throw new Error('Commit is refused until the latest combined device diff has been read.')
      }
      this.setSnapshot({ ...this.snapshot, status: 'committing' })
      try {
        await this.session.commit()
      } catch (error) {
        this.markUncertain(`Commit may have applied; refresh the device state before taking another action. ${errorText(error)}`)
        throw error
      }
      this.session = undefined
      this.nextEntryId = 1
      this.diffRedactors = []
      this.setSnapshot(idleSnapshot())
    })
  }

  abort(): Promise<void> {
    return this.serialized(async () => {
      this.assertNotUncertain()
      if (this.session === undefined) throw new Error('There is no active transaction to abort.')
      this.setSnapshot({ ...this.snapshot, status: 'aborting' })
      try {
        await this.session.abort()
      } catch (error) {
        this.markUncertain(`Abort may have applied; refresh the device session list before taking another action. ${errorText(error)}`)
        throw error
      }
      this.session = undefined
      this.nextEntryId = 1
      this.diffRedactors = []
      this.setSnapshot(idleSnapshot())
    })
  }

  private async openSession(): Promise<TransactionSession> {
    if (this.session !== undefined) return this.session
    this.setSnapshot({ ...this.snapshot, status: 'opening' })
    try {
      const session = await this.node.configSession({
        description: 'webui shared transaction',
        ...(this.journal === undefined ? {} : { journal: this.journal }),
      })
      this.session = session
      this.setSnapshot({ ...this.snapshot, sessionName: session.name })
      return session
    } catch (error) {
      this.setSnapshot(idleSnapshot())
      throw error
    }
  }

  private async readDiff(session: TransactionSession, reason: string): Promise<string> {
    try {
      const raw = await session.diff()
      return this.diffRedactors.reduce((text, redact) => redact(text), raw)
    } catch (error) {
      this.markUncertain(`${reason}; refresh the device session before continuing. ${errorText(error)}`)
      throw error
    }
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  private assertNotUncertain(): void {
    if (this.snapshot.status === 'uncertain') {
      throw new Error(this.snapshot.uncertainReason ?? 'The active transaction is uncertain. Refresh the device state before continuing.')
    }
  }

  private markUncertain(message: string): void {
    this.setSnapshot({ ...this.snapshot, status: 'uncertain', uncertainReason: message })
  }

  private setSnapshot(snapshot: TransactionSnapshot): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener(snapshot)
  }
}
