# Arista EOS Switch Workspace

An operational web UI for an Arista switch, backed by the workspace eAPI client.
Routed screens: `#/interfaces` (S1 #71 — every interface with link/protocol/admin state, MTU, LAG
membership, the management-path answer, and staged `description` / `mtu` / `shutdown` writes),
`#/vlans/manage` (S2 #72 — the VLAN table with referencing config lines, staged create / rename /
clear-name / state / delete writes, and trunk groups gated on the #67 capability verdict), and
`#/vlans` (F6 #68 — VLAN inventory and access-port assignment).
In dev with no `EAPI_*` env there is additionally `#/connect` (see the relay section below).
Changes are staged in a named EOS config session and require a reviewed device diff plus explicit
confirmation before commit. Commits affect running-config only; startup-config is never saved implicitly.

## Local Development

Create the ignored `arista-webui/.env.local` file with an authorized lab target and
lab-only account:

```ini
EAPI_HOST=localhost:8443
EAPI_USER=eapi-test
EAPI_PASS=replace-with-a-lab-only-password
```

From the workspace root, run `npm run dev -w arista-webui`. Vite binds to `127.0.0.1`
and proxies `/command-api` to the configured HTTPS host. The current development proxy
does not verify the upstream certificate (`secure: false`); use it only on a trusted
development host with an authorized lab endpoint. Credentials stay in the Vite process,
not the browser bundle. See the [eAPI connectivity guide](../arista-api-client/docs/CONNECTIVITY.md).

With all three variables absent, the UI renders its unconfigured state and makes no
eAPI requests. Partial configuration is rejected; there is no default switch target.

### Runtime connect — the dev-server relay (#140a)

Without `EAPI_*`, the dev server also serves a small **loopback-only relay** so you can attach to a
switch from the browser instead of editing `.env.local`: open `#/connect`, submit
host + username + password once, and the UI probes the device (`show version`) through the relay
before landing on the workspace. Details, in order of consequence:

- The Vite plugin (`eapi-relay.ts`) holds the target **in the dev-server process memory only** —
  never a file, never localStorage, never a response body. `POST /__eapi/setup` installs it,
  `POST /__eapi/disconnect` clears it, `GET /__eapi/status` echoes at most `{host, username}`.
- While installed, the relay forwards `POST /command-api` to `https://<host>/command-api` with the
  **exact posture of the env-var proxy**: Basic auth injected server-side, `rejectUnauthorized:
  false` (self-signed device certs, DR-036), a 35 s upstream ceiling that bounds black-holed
  connects (DR-019), and credential-free `502 {error:'relay-upstream-failed', code}` failures.
- **The env-var proxy remains authoritative.** With `EAPI_*` set, the relay refuses
  setup/disconnect with `409` and reports `{configured:'env'}`; when unset it never answers
  `/command-api` itself. Nothing about the deployed-product threat model changes: this is a dev
  tool in the same trust class as the existing proxy (DR-013/DR-027), not a production mode —
  the browser still never holds the device password, and the connect hostbook
  (`arista-webui.connect.hostbook.v1` in localStorage) stores labels/hosts/usernames only.
- Pre-wire refusals (`https://`-prefixed hosts, credential-bearing URLs, oversized fields) are
  computed client-side and **no request is sent at all** for them (DR-053).

## Credentials and test artifacts (F8, issue #70)

The browser never sees a credential: Vite injects `Authorization: Basic …` server-side and the app
only reads the build-time `__EAPI_PROXY_CONFIGURED__` flag. Tests and artifacts are the leak surface,
so the contract is:

- **(a) Offline tests never carry a target.** `npm test -w arista-webui` runs with no `EAPI_*` env and
  contacts nothing. Template: `proxyConfigured={false}` + "zero read calls" in
  `src/features/vlans/VlanAssignment.test.tsx`.
- **(b) Fixtures use already-redacted capture values only** — `systemMacAddress: '00:00:00:00:00:00'`,
  `serialNumber: '0000000000'` (or `''`) — as in `src/eapi/show-contracts.test.ts`. Device payloads
  belong in a `fixtures` directory next to the screen that reads them (loaded with Vite `?raw`), not
  in prose.
- **(c) Never assert or dump cleartext from `transport.sent()` / `transport.bodies()`** — both are
  un-redacted and carry the `enable` `input` (the client's `node-session-journal` allow-list rule,
  DR-011). Assert the detector instead: `findUnredactedEnableInput` / `scanValue`.
- **(d) `.env.local` stays gitignored; #91 artifacts** (trace/video/HAR/coverage) must scrub host,
  user, serial and MAC before upload. See the [cEOS runbook](../docs/CEOS.md).

[`src/testing/redaction-guard.test.ts`](src/testing/redaction-guard.test.ts) enforces (b) and (c):
it scans every committed fixture payload and test source for an un-redacted enable secret, a MAC with
a non-zero device half, a spelled-out serial, or a credential outside the placeholder list
(`never-sent`, `replace-with-a-lab-only-password`). It reports clean today and fails the moment one
lands; exemptions are marker-based and pinned to an empty allow-list.

## Typed show contracts (M13)

The client ships an **empty** `ShowContracts` map on purpose (ARCHITECTURE.md §9.1); this app
widens it by declaration merging in [`src/eapi/show-contracts.ts`](src/eapi/show-contracts.ts),
so `node.show('version')` and friends type end-to-end without an upstream release. The modelled
commands are the M13 screens' five literals — `version`, `interfaces status`, `vlan`, `mlag` and
`lag` — **except `lag`, which is held until a `show lag` capture exists** (it stays `unknown`;
narrow on purpose or wait for the STATUS §3 hardware sweep), **plus
`'management api http-commands'`**, added for S1 (#71): that command's `urls[]` names the interface
the device is actually serving eAPI on — `Management1` in the 7050TX-64 capture, `Vlan100` in the
cEOS-lab one (endpoint host left redacted by the capture lane) — which is the readable half of the
dashboard's shutdown guard. Every modelled field was read out of
a recorded reply under `arista-api-client/test/fixtures/`, and
`src/eapi/show-contracts.test.ts` pins each contract against verbatim copies of those captures —
a contract that drifts from real device output fails `npm run typecheck`. The header renders a
best-effort identity chip (`hostname · EOS version · model`) from the typed `show version` reply;
that read failing never breaks the workspace.

## Tests

Component tests use mocked client interfaces and stay offline:

```bash
npm test -w arista-webui
npm run typecheck -w arista-webui
npm run lint -w arista-webui
npm run build -w arista-webui
```

Browser-to-cEOS Playwright tests remain a separate opt-in follow-up. See the
[cEOS runbook](../docs/CEOS.md); container results do not establish
7050TX-64 hardware support or exact 4.28.13.1M behavior.

## Testing

Tests run with [Vitest](https://vitest.dev/) (jsdom + Testing Library). Config lives in
`vitest.config.ts`, matcher/setup wiring in `src/setupTests.ts`, and tests are colocated
as `src/**/*.test.{ts,tsx}`.

```bash
npm test          # single run (vitest run)
npm run test:watch
```

Vitest is the project's current test runner — Jest knowledge/patterns can be reused as
guidance (`jest.*` → `vi.*`) but Jest itself is not used here.

### Real-EOS browser E2E tests (opt-in, #91)

Component tests stay mocked and offline. The separate **Playwright** lane drives the real
app against disposable **cEOS-lab 4.28.14M** through the UI's same-origin dev proxy, and
`src/e2e-lane-boundary.test.ts` fails offline CI if that ever stops being true.

Preflight: Docker running with the pinned `arista/ceos:4.28.14M` image imported
(see the [cEOS runbook](../docs/CEOS.md)), then once per machine
`npx playwright install chromium`; keep `:5173-5176` free and `npm run lab:list` quiet.

```bash
npm run e2e -w arista-webui        # lab up → preflight → 4 dev servers → Playwright → teardown
node scripts/assert-e2e-run.mjs arista-webui/e2e-results/results.json --check-secrets
```

`scripts/e2e-run.mjs` (the `lab:run` child) serves the connected state plus the three
failure states the specs assert against — unconfigured proxy, unreachable target, and a
real device 401 (placeholder credentials; the lab pair never leaves the proxy process, so
browser artifacts are credential-free by construction). trace/video/HAR/screenshots are
off; failure diagnostics are scrubbed text attachments (F8). The mutating commit/read-back
spec is gated on `EAPI_LAB_FULL_WRITE` and touches only `EAPI_SCRATCH_INTERFACE`.
Do not direct browser E2E tests at the physical switch; the lane refuses `EAPI_TARGET_CLASS=hardware`.
cEOS coverage does not prove 7050TX-64 hardware capabilities or exact 4.28.13.1M behavior.
The trusted `workflow_dispatch` CI job (docs/CEOS.md plan item 5) is tracked as a follow-up

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is enabled on this template. See [this documentation](https://react.dev/learn/react-compiler) for more information.

Note: This will impact Vite dev & build performances.
You can also try [the experimental native React Compiler support in plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react/README.md#rust-react-compiler) by using `compiler: true` in the plugin options instead of using the Babel plugin.

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.
