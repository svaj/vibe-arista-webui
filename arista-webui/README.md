# Arista EOS Switch Workspace

An operational web UI for VLAN inventory and access-port VLAN assignment, backed by the
workspace eAPI client. Changes are staged in a named EOS config session and require a
reviewed device diff plus explicit confirmation before commit. Commits affect
running-config only; startup-config is never saved implicitly.

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

### Planned real-EOS browser E2E tests

Keep component tests mocked and offline. Use **Playwright** in a separate opt-in lane
against disposable **cEOS-lab 4.28.14M**, with the UI's same-origin proxy targeting the
lab's HTTPS eAPI endpoint. See the [cEOS runbook](../docs/CEOS.md) for the local image,
bootstrap/readiness, credentials/TLS, isolation, CI restrictions, cleanup, and test flows.
The proxy wiring and Playwright/cEOS harness are planned, not installed or runnable yet.
Assert real EOS state after preview/abort and isolated commit/read-back flows, not just
UI success messages. Do not direct browser E2E tests at the physical switch. cEOS
coverage does not prove 7050TX-64 hardware capabilities or exact 4.28.13.1M behavior.

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
