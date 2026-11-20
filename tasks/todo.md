# Tasks: Multi-Change Transaction Staging (#141)

Spec: `docs/SPEC-transaction-staging.md` (approved 2026-11-19)

- [x] **T1: Transaction coordinator**
  - Acceptance: one named session is opened lazily; appends are serialized and ordered; diff refresh, commit, abort, and uncertain states follow the spec.
  - Verify: focused coordinator/provider tests, `npm run typecheck`.
  - Files: `arista-webui/src/features/sessions/transaction*.ts*` and focused tests.

- [x] **T2: App lifetime and shell indicator**
  - Acceptance: transaction state survives route changes, resets its in-memory handle on node replacement, and the shell exposes an accessible link with entry count/state.
  - Verify: route/navigation and AppShell tests, `npm test -w arista-webui -- --run src/App.test.tsx`.
  - Files: `App.tsx`, `components/AppShell*`, session provider files.

- [x] **T3: VLAN assignment proving slice**
  - Acceptance: VLAN assignment appends into the shared session and no longer commits/aborts locally; navigation back retains the entry; no second session opens.
  - Verify: VLAN assignment + App tests and focused lint.
  - Files: `features/vlans/VlanAssignment.tsx`, presentation/test files as needed.

- [x] **T4: Transaction Center ownership**
  - Acceptance: ordered entries, command review copy, risks, combined device diff, refresh, confirmed commit, and confirmed abort render; uncertain state blocks unsafe actions; existing journal/verify/orphan flows remain intact.
  - Verify: TransactionCenter container/view/rule tests.
  - Files: `features/sessions/TransactionCenter.tsx`, `TransactionCenterView.tsx`, tests, `App.css`.

- [x] **T5: Migrate system and simple screen group**
  - Acceptance: System, NTP, VLAN management, addressing, interfaces, and static routes append to the coordinator with their exact existing command/risk contracts and no local ordinary commit/abort.
  - Verify: touched screen test suites; `npm run typecheck`; lint.
  - Files: the listed feature containers and their tests/views as required (split into PR-sized commits if needed).

- [x] **T6: Migrate remaining write screens**
  - Acceptance: trunks, Port-Channels, users, ACLs, STP, and VRFs use the shared coordinator; no migrated screen opens an independent ordinary session.
  - Verify: touched screen test suites; `npm run typecheck`; lint.
  - Files: the listed feature containers and their tests/views as required (split into PR-sized commits if needed).

- [x] **T7: Cross-screen integration and recovery hardening**
  - Acceptance: an offline integration test stages from two screens and commits once in Transaction Center; uncertain commit, failed append, reconnect, reload guidance, no-proxy, and secret non-persistence are covered.
  - Verify: focused integration test plus full `npm test`.
  - Files: App/session integration tests and any small coordinator fixes they expose.

- [x] **T8: Documentation and final gate**
  - Acceptance: roadmap/features docs describe the multi-change workflow; #141 acceptance is traceable; #89 exclusions remain explicit.
  - Verify: `npm test`, `npm run typecheck`, `npm run lint`, `npm run lint:scripts`, `npm run docs:check`, `npm run build`, `git diff --check`.
  - Files: `docs/features.md`, relevant issue/roadmap notes if maintained in-repo, and final touched tests.
