/**
 * M13 / #91 — opt-in Playwright browser E2E lane (webui-owned, real cEOS-lab 4.28.14M only).
 *
 * This lane is NEVER part of `npm test` or offline CI: it is reached through
 * `npm run e2e` (arista-webui), which wraps `node ../scripts/ceos-lab.mjs run` so the lab
 * lifecycle (create → probe → child → guaranteed teardown, DR-043/DR-129, `scripts/ceos-lab.mjs`
 * `cmdRun`) owns the container, and the child supervisor `scripts/e2e-run.mjs` owns the four
 * dev servers (connected / unconfigured / unreachable / bad-auth) the specs exercise.
 *
 * Credential design (docs/CEOS.md §"Browser E2E and CI plan" item 2): the ONLY configured
 * server's proxy (arista-webui/vite.config.ts `createEapiProxy`) injects `Authorization: Basic`
 * server-side from the vite process env. Passwords never reach the browser, so they cannot
 * exist in any browser-produced artifact. The bad-auth server intentionally carries a bogus
 * credential pair so the device's real 401 is exercised (never a lab secret).
 *
 * Artifact design (item 4 + F8/#70 hygiene): Playwright's trace zip is opaque to this repo's
 * text-boundary scanner (`scripts/assert-e2e-run.mjs`), and a device response body inside a
 * trace would carry interface MACs (device-assigned last halves). So trace/video/HAR/screenshots
 * are ALL off by construction, and failure diagnostics are produced instead by the scrubbed text
 * attachments in `e2e/fixtures.ts` (MAC → 00:00:00:00:00:00, serial → '0000000000',
 * credential-shaped text → <redacted>, matching arista-webui/README.md F8 redacted forms).
 * Every file under e2e-results/ is scanned at the boundary and gitignored.
 */
import { defineConfig } from '@playwright/test'

const connectedServer = process.env['E2E_BASE_URL'] ?? 'http://127.0.0.1:5173'

export default defineConfig({
  testDir: './e2e',
  // Specs are *.e2e.ts OUTSIDE src/ on purpose: webui vitest collects
  // src/**/*.{test,spec}.{ts,tsx} and both coverage includes cover src/**/*.
  // src/e2e-lane-boundary.test.ts pins this split offline.
  testMatch: /\.e2e\.ts$/,
  // One worker per shared target (TESTING.md §1/§8, DR-043 single-flight per endpoint):
  // specs mutate the same disposable container and must never interleave.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 120_000,
  outputDir: 'e2e-results/artifacts',
  reporter: [
    ['list'],
    ['json', { outputFile: 'e2e-results/results.json' }],
  ],
  use: {
    baseURL: connectedServer,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    // recordHar is deliberately absent: a HAR would capture every device response body,
    // which is exactly the identifying text F8 keeps out of artifacts.
    actionTimeout: 30_000,
  },
})
