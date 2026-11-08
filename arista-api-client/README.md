# Arista API Client — `@devhax-heavy-industries/arista-eapi`

A TypeScript eAPI client for Arista EOS, ported from (and deliberately **not** a line-by-line port of)
Arista's Python [pyeapi](https://github.com/arista-eosplus/pyeapi). It is the library
[`arista-webui/`](../arista-webui/) uses to talk to the DCS-7050TX-64 / EOS 4.28.13.1M switch.

> **Status (2026-11-08): M1–M11 shipped, M12 in parts** — wire protocol, transports, profiles,
> command layer, config sessions, text-config engine, resource framework (`system`/`vlans`/`switchports`,
> M10 `interfaces` partly), capability work in flight; the live lane runs against disposable cEOS
> (30 provisioned captures on main), and the **hardware capture lane is built but never executed**
> ([docs/HARDWARE-CAPTURE.md](./docs/HARDWARE-CAPTURE.md) is the runbook for the supervised
> 7050TX-64 session). Progress board: [docs/STATUS.md](./docs/STATUS.md); pyeapi 1.0.4-rc0 remains
> the inventory baseline (≈9 k LOC source, 436 unit + 284 system test methods).

## Read these

| Doc | What it's for |
|---|---|
| [docs/PLAN.md](./docs/PLAN.md) | The implementation plan: 14 milestones (M0–M13) + 2 module waves, each with a task list, the tests to write, and an exit gate. Checkboxes track progress. |
| [docs/STATUS.md](./docs/STATUS.md) | Live board: milestone state, per-module pyeapi parity, cEOS availability, discovery sweep, and separate scratch-session experiment. |
| [docs/DECISIONS.md](./docs/DECISIONS.md) | DR-001…DR-043: why the API looks the way it does, plus the eAPI facts verified against the 4.28.13.1M image, plus what still needs a device to settle. |
| [docs/MIGRATION.md](./docs/MIGRATION.md) | pyeapi → TypeScript map, file by file and symbol by symbol, incl. 18 intentional behaviour changes and everything dropped on purpose. |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | Layers, types, error taxonomy, the browser/Node split, concurrency rules. |
| [docs/TESTING.md](./docs/TESTING.md) | Vitest tiers (unit / fixture / live), `MockTransport`, fixture policy, coverage thresholds, live-device safety policy. |
| [docs/HARDWARE-CAPTURE.md](./docs/HARDWARE-CAPTURE.md) | Switch-session runbook: the `hardware` guard class gates, batch-1 inventory, reviewed session probes, scrubs — how to capture real 7050TX-64 evidence safely. |
| [docs/USAGE.md](./docs/USAGE.md) | User guide: connect, read, change-review-commit, errors, capabilities, testing your own code. Written ahead of the code as the API target. |
| [docs/CONNECTIVITY.md](./docs/CONNECTIVITY.md) | What to enable on the switch (eAPI, `cors allowed-origin`, TLS) and whether to go through a proxy. |
| [cEOS lab runbook](../docs/CEOS.md) | Preferred planned real-EOS integration/live and browser E2E target: local cEOS-lab 4.28.14M, setup, readiness, safety, CI, and hardware limitations. |

## Shape of the thing

- **Dual runtime:** browser-safe core (`fetch` only) + `@devhax-heavy-industries/arista-eapi/node` for unix
  sockets, client certs, cert pinning, cookie auth, and `eapi.conf` profiles.
- **Idiomatic TS, not Python with braces:** typed `show` contracts (augmentable),
  `node.vlans.get(20) → VlanEntry | undefined`, errors thrown instead of stashed,
  explicit `setX`/`unsetX`/`defaultX` instead of negation-by-`None`.
- **Safer by construction than pyeapi:** named and journaled config sessions with orphan recovery,
  unconditional password redaction (pyeapi only redacts on error 1005), TLS verification on by default,
  capability probing instead of a hard-coded feature matrix, `verifyConfig` dry-run.
- **Tooling matches the webui:** npm workspaces, Vite/Rolldown lib build, `tsc` declarations,
  Vitest 5, oxlint, ESM-only, Node ≥ 20.

## Working on it

```bash
npm install                      # repo root, workspaces (single lockfile lives at the root)
npm run typecheck --workspaces   # or: npm run typecheck  (fans out to both packages)
npm run lint    -w @devhax-heavy-industries/arista-eapi
npm test        -w @devhax-heavy-industries/arista-eapi # never touches the switch (vitest --project unit)
npm run test:watch -w @devhax-heavy-industries/arista-eapi
npm run coverage -w @devhax-heavy-industries/arista-eapi # unit project only, v8 thresholds
npm run test:live -w @devhax-heavy-industries/arista-eapi   # gated: EAPI_LIVE=1 + creds + EAPI_TARGET_CLASS=lab (container) or =hardware (runbook: docs/HARDWARE-CAPTURE.md)
npm run build   -w @devhax-heavy-industries/arista-eapi # vite lib build + tsc declarations
node arista-api-client/scripts/create-issues.mjs   # mirror PLAN.md milestones to GitHub issues (idempotent)
```

Definition of done per milestone — code + tests + coverage threshold + this README/STATUS/MIGRATION
updated in the same commit — is spelled out in [docs/PLAN.md §6](./docs/PLAN.md#6-definition-of-done-per-milestone).

## Attribution

Derived from Arista Networks' pyeapi (BSD-3-Clause). Baseline commit: `6816d9e` (`1.0.4-rc0`),
local clone at `/home/svaj/development/arista/pyeapi`. Files that are direct translations of pyeapi
functions carry the upstream copyright header; see [docs/DECISIONS.md DR-001](./docs/DECISIONS.md#dr-001--license-and-attribution).
Since M0 (#2) the licensing paperwork is in the package itself: [`LICENSE`](./LICENSE) (BSD-3-Clause,
Arista's copyright retained) and [`NOTICE`](./NOTICE) (upstream attribution).
