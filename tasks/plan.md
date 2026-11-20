# Plan: Multi-Change Transaction Staging (#141)

Status: implemented on 2026-11-19; all slices are tracked in `tasks/todo.md` and the final offline gate is recorded in the implementation PR.

## Goal

Implement `docs/SPEC-transaction-staging.md`: one in-memory live EOS config session shared across routed screens, with ordered staged entries, a combined device diff, and commit/abort owned by the Transaction Center.

## Architecture

### Shared Transaction Boundary

Create a Web UI coordinator in `arista-webui/src/features/sessions/`:

- owns the active `ConfigSession` handle;
- serializes append/refresh/commit/abort;
- retains ordered entries and the latest device diff;
- exposes explicit `idle`, `opening`, `staging`, `ready`, `committing`, `aborting`, and `uncertain` states;
- never persists command payloads;
- clears state only after a confirmed successful commit/abort;
- rejects reuse after an uncertain write outcome until the operator refreshes/reconnects and handles the device session through the existing recovery flow.

The coordinator consumes already validated `CommandSpec[]` batches. It does not compose feature commands or duplicate screen-level guards.

### App Lifetime

Host the coordinator in a provider above the route outlet in `App.tsx`. The provider is re-created only when the `Node` instance changes. Route navigation therefore preserves the active transaction while reconnecting clears only the in-memory handle.

Expose a small context hook to routed feature containers. Presentation views receive plain review fields/callbacks; `ConfigSession` and `CommandSpec` objects do not cross that boundary unless the existing container already owns them.

### Migration Pattern

For each existing write screen:

1. Keep read state, form validation, command composition, and risk copy local.
2. Replace local `configSession()` + `session.run()` + `session.diff()` with `transaction.append(...)`.
3. On append success, clear/refresh the screen form as appropriate and direct the operator to the Transaction Center.
4. Remove ordinary commit/abort controls from the migrated screen.
5. Preserve `listSessions`/orphan cleanup behavior, except the active shared session must not be offered as an unrelated pending-session abort.

Migrate one simple screen first (`VlanAssignment`) to prove navigation and shared ownership, then use the same pattern across the remaining write screens.

### Transaction Center

Extend the current S9 screen to display:

- active session name/state;
- ordered entries with source/action, command review copy, and risks;
- combined device diff;
- refresh-diff, confirmed commit, and confirmed abort controls;
- uncertain-state recovery copy that points operators to the device session table;
- existing journal, verify, and orphan-recovery sections unchanged.

The existing direct textarea draft may either append through the coordinator or remain a coordinator-backed source named `manual transaction draft`; it must not open an independent ordinary session.

### App Shell

Add an optional transaction indicator to the shell header:

- hidden when idle;
- keyboard-reachable link to `#/sessions`;
- accessible count and state text;
- no device calls in the shell.

## Build Order

1. **Coordinator state machine**
   - Define transaction types and the reducer/state machine.
   - Add a provider/hook and a serialized command seam.
   - Cover first-open/reuse, ordered append, diff refresh, commit, abort, and uncertain states.

2. **App lifetime + shell indicator**
   - Mount the provider around routed screens.
   - Recreate on node identity changes only.
   - Add the app-shell transaction link/count indicator.

3. **Proving migration: VLAN assignment**
   - Replace the local single-action session with `append()`.
   - Remove its commit/abort review actions.
   - Pin navigation-preserved transaction state and no second session.

4. **Transaction Center transaction controls**
   - Consume coordinator entries/diff/status.
   - Move ordinary commit/abort ownership here.
   - Preserve direct draft, journal, verify, and orphan workflows.

5. **Remaining write-screen migration**
   - Migrate config screens using the established append helper: system, NTP, addressing, interfaces, trunks, VLAN management, Port-Channels, static routes, users, ACLs, STP, VRFs.
   - Preserve each screen's exact command composition, risk copy, and validation.
   - Remove only local ordinary transaction lifecycle code.

6. **Integration and documentation**
   - Test a two-screen offline transaction and Transaction Center commit.
   - Check uncertain/reconnect/no-proxy cases.
   - Update feature docs and issue references.
   - Run the full quality gate.

## Key Risks

- **Ambiguous write outcome:** a failed `run()` or `commit()` may still have applied. Mitigation: explicit uncertain state, no automatic retry, device refresh guidance, and no clearing of the transaction on failure.
- **Screen migration drift:** command composition is distributed across many screens. Mitigation: screens keep all composition/validation local; only session lifecycle moves behind the coordinator.
- **Pending-session confusion:** the shared active session appears in `listSessions()` while also owned in memory. Mitigation: compare active session name and suppress duplicate cleanup affordances where appropriate; Transaction Center remains authoritative.
- **Secret-bearing payloads:** banners and users can carry arbitrary content. Mitigation: provider stores payload only in the live client session/entry metadata and never writes entries to logging, local storage, or operation notices.
- **Coverage migration size:** many screens currently own identical lifecycle code. Mitigation: first pin one complete vertical slice, then migrate in small groups with targeted tests after each group.
- **Node replacement:** an old pending session can outlive the in-memory handle. Mitigation: node change invalidates the coordinator, while journal/session-list recovery remains visible and honest.

## Verification Checkpoints

After coordinator and provider work:

```bash
npm test -w arista-webui -- --run src/features/sessions
npm run typecheck
```

After the VLAN assignment slice:

```bash
npm test -w arista-webui -- --run src/features/vlans/VlanAssignment.test.tsx
npm test -w arista-webui -- --run src/App.test.tsx
```

After each migration batch:

```bash
npm test -w arista-webui -- --run <touched-test-paths>
npm run lint
```

Final:

```bash
npm test
npm run typecheck
npm run lint
npm run lint:scripts
npm run docs:check
npm run build
git diff --check
```

## Done When

All success criteria in the approved spec are met, the full offline gate passes, and no screen can create a second ordinary config session while the app-wide transaction is active.
