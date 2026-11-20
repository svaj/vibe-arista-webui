# Spec: Multi-Change Transaction Staging

## Objective

Let an operator stage several configuration changes from different Web UI screens, review one combined EOS device diff, and commit or abort the whole transaction from the Transaction Center.

Today each write screen opens a session, stages one action, reads its diff, and immediately asks the operator to commit or abort. The new workflow must preserve one live config session across navigation while keeping device-owned state authoritative.

This spec implements issue #141. It does not unblock or implement the persistence/rollback scope of issue #89.

## Approved Product Assumptions

1. The first staged UI change opens one named EOS config session through the existing `Node.configSession()` client API.
2. Later staged changes reuse that same live session until it is committed or aborted.
3. The transaction coordinator is app-wide and lives in memory only. A page reload does not reconstruct or resume a session handle.
4. The session remains pending on the device after a browser reload. The existing journal and Transaction Center recovery flow remain responsible for reporting or cleaning up that orphan.
5. Only the Transaction Center may commit or abort an ordinary staged transaction.
6. Startup configuration, `configure replace`, rollback verbs, commit timers, and session-name policy remain out of scope.

## User Stories

- As an operator, I can stage a valid change on one screen, navigate to another screen, and add another valid change without committing the first one.
- As an operator, I can see a transaction summary, staged actions in insertion order, and a refreshed combined device diff before committing.
- As an operator, I can remove the last staged action while the session is still open, provided it can be removed safely.
- As an operator, I can abort the entire staged transaction with one confirmed action.
- As an operator, I am shown an uncertain/failed state and directed to refresh device state if the session or commit outcome cannot be trusted.

## Scope

### In Scope

- One app-wide staged transaction coordinator for the current browser runtime and node connection.
- A stable shared interface used by all configuration screens instead of each screen owning an independent session lifecycle.
- Staging one or more typed client `CommandSpec` entries through the existing `ConfigSession.run()` API.
- Reading the combined diff after every successful append.
- Ordered transaction entries with source screen/action metadata and review copy.
- Transaction Center summary, combined diff, commit, and abort controls.
- Navigation-level indication that a staged transaction is open.
- Existing loading, error, uncertain commit, proxy-not-configured, and confirm-dialog contracts.
- Focused unit/component tests and one offline integration flow across two representative screens.
- Documentation updates for the transaction workflow.

### Out Of Scope

- Persisting a transaction in browser storage.
- Replaying commands after reconnect or reload.
- Saving to startup configuration.
- `configure replace`, rollback, `copy running-config startup-config`, or commit timers.
- Concurrent independent app transactions.
- Direct commit or abort buttons on feature screens while a shared transaction is active.
- Adding new EOS client verbs or changing `arista-api-client` resource behavior.

## Transaction Contract

The shared transaction surface must expose one-version, hard-to-misuse operations with these semantics:

```ts
interface StagedTransaction {
  readonly status: 'idle' | 'opening' | 'staging' | 'ready' | 'committing' | 'aborting' | 'uncertain'
  readonly sessionName?: string
  readonly entries: readonly StagedTransactionEntry[]
  readonly diff?: string

  append(input: StageTransactionInput): Promise<StageTransactionResult>
  refreshDiff(): Promise<string>
  commit(): Promise<void>
  abort(): Promise<void>
}

interface TransactionConfirmation {
  readonly title: string
  readonly body: string
  readonly label: string
  readonly subject: string
}

interface StageTransactionInput {
  readonly source: string
  readonly action: string
  readonly commands: readonly CommandSpec[]
  readonly display: readonly string[]
  readonly risks: readonly string[]
  readonly confirmations?: readonly TransactionConfirmation[]
  readonly redactDiff?: (text: string) => string
}
```

Implementation may refine these names, but the semantics below are fixed.

### Entry Semantics

- Entries are appended in operator order.
- Duplicate actions are allowed because the CLI sequence and intent may be meaningful.
- A command batch is run only after the existing screen-level guards have passed.
- The coordinator does not silently reinterpret or reorder commands.
- `display` is review copy only; `commands` are the device payload.
- A secret-bearing staged payload must never be copied into logs or browser storage by the coordinator.
- Secret-bearing screens may supply `redactDiff`; the coordinator applies it to every combined diff read so secret text never enters the review UI.
- Screens with additional safety prompts may supply `confirmations`; Transaction Center runs them after the primary commit confirmation and before sending `commit()`.

### Session Semantics

- `append()` serializes calls. A second action cannot stage until the first `run()` and diff refresh settle.
- The first append opens one named session with a description identifying it as an app-wide Web UI transaction.
- A later append calls `run()` on the existing session, then calls `diff()` again.
- `hasDiffBeenRead()` must be true before `commit()` is allowed.
- `commit()` and `abort()` are guarded by the UI confirmation flow and remain single-flight.
- A failed append does not add a logical transaction entry unless the session's device state is known well enough to do so. Ambiguous failures move the transaction to `uncertain` and block further staging until refreshed/recovered.
- A timeout or transport failure during commit does not claim success or failure; it moves to `uncertain` and instructs the operator to refresh device state before another action.

### Diff Semantics

- The displayed diff always comes from the device's `diff()` result.
- A combined diff is refreshed after every append and can be refreshed manually from the Transaction Center.
- Commit stays disabled until the latest append has completed and the latest combined diff has been read.
- A diff is not persisted in browser storage.

### Recovery Semantics

- Reload, reconnect, or node replacement clears only the in-memory coordinator reference; it never pretends to abort the device session.
- The Transaction Center's existing `listSessions()`, journal, and recovery paths report the remaining pending device session.
- Disconnect/connection-change UX warns that the in-memory session handle is no longer available and that recovery must happen through the device session list.

## UX Contract

### Feature Screens

- Staging controls remain on each feature screen and retain their current screen-specific validation.
- The primary label becomes `Add to transaction` for a valid staged action.
- After append succeeds, the screen shows a success state and directs the operator to the Transaction Center for review.
- Feature screens do not clear, commit, or abort the shared transaction as a side effect of navigation or reload.
- Existing immediate one-action flows may be migrated in vertical slices, but while migration is incomplete an action must not create a second concurrent session when a shared transaction is open.

### Transaction Center

- Shows the active session name, source/action entries, command review copy, risks, and the latest combined device diff.
- Shows the first commit/abort controls only after at least one action has staged successfully.
- Provides one confirmed `Commit transaction` action and one confirmed `Abort transaction` action.
- Commit confirmation summarizes all entries and repeats the existing running-config-only copy: startup configuration is not changed.
- Abort confirmation states that all entries in the transaction will be discarded.
- A top-level status indicator in the app shell identifies that a transaction is open and links to the Transaction Center.

### Accessibility

- Loading and busy states use `role="status"`, `aria-live`, or `aria-busy` consistently with existing screens.
- Errors use `role="alert"`.
- Entry order and counts are readable without relying on color.
- Confirm dialogs focus the cancel action by default for commit and abort.
- The transaction indicator is keyboard reachable and exposes the staged entry count in accessible text.

## Architecture

- Add a shared transaction coordinator at the app boundary so route changes do not destroy it.
- Prefer the repo's existing React patterns: container/presentation separation, local helper APIs, and no new runtime dependency.
- The coordinator owns live session lifecycle only; it does not own feature-specific command composition or validation.
- Feature screens pass already validated `CommandSpec` batches and display metadata into the coordinator.
- The Transaction Center consumes the coordinator state and owns ordinary commit/abort actions.
- Existing `staged-batch.ts` helpers remain the command review-display boundary.

A product-approved API shape is not a browser transport API and must not be added to `arista-api-client`. The shared coordinator is a Web UI concern.

## Commands

```bash
npm test
npm run typecheck
npm run lint
npm run lint:scripts
npm run docs:check
npm run build
```

Focused test commands may use the existing Vitest workspace filters, for example:

```bash
npm test -w arista-webui -- --run src/features/sessions
```

## Testing Strategy

Use the existing Vitest 5, React Testing Library, and hand-built fake `Node` seams. No browser E2E is added in this issue.

Required coverage:

- append opens exactly one session for the first action and reuses it for later actions;
- two actions are staged in order and the combined diff is read after each append;
- feature screens refuse a second concurrent append while staging is busy;
- commit is disabled until the latest diff has been read;
- commit sends once, clears the transaction only after a confirmed success, and reloads device state;
- abort sends once and clears the transaction only after confirmed success;
- failed/uncertain transport outcomes do not clear or silently reuse a possibly stale handle;
- reload/reconnect behavior does not claim the device session was aborted;
- no-proxy mode makes no session calls;
- staged secrets are absent from coordinator logs and storage;
- route navigation preserves the active transaction in memory;
- an integration test stages one action from each of two representative screens and reviews both in the Transaction Center.

## Boundaries

### Always

- Preserve existing client command text, validation, and secret handling.
- Keep the device diff authoritative.
- Treat timeout/transport failures as uncertain after a write may have applied.
- Use explicit confirmation for commit and abort.
- Keep startup configuration unchanged and say so in success/confirmation copy.
- Run tests, typecheck, lint, and build before opening a PR.

### Ask First

- Browser persistence of staged commands.
- Startup-config policy.
- Rollback, replace, or commit-timer controls.
- New dependencies.
- Changes to EOS client behavior or public package exports.

### Never

- Commit secrets.
- Persist staged `CommandSpec` values to local storage.
- Auto-commit on navigation, unmount, timeout, or reconnect.
- Claim a failed/uncertain commit succeeded.
- Open multiple ordinary transactions for the current app runtime.
- Smuggle `commit`, `abort`, rollback, replace, reload, or startup-copy lines into staged batches.

## Success Criteria

1. A user can stage at least two actions from different screens before any commit.
2. Both actions execute in one named EOS config session in operator order.
3. The Transaction Center shows both entries and one current device-owned diff.
4. Commit and abort exist only in the Transaction Center for the migrated flow and are confirmation-gated.
5. No page navigation creates a second ordinary transaction.
6. Reload/reconnect never falsely claims the pending device session was removed.
7. No staged command reaches browser storage.
8. `npm test`, typecheck, lint, docs check, and build pass.

## Open Questions

None. Product scope and the app-wide live-session model were approved on 2026-11-19. Technical decomposition begins only after this spec is approved.
