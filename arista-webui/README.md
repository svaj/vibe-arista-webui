# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

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
