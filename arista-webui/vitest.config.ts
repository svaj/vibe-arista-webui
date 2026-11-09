import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Plain React transform for tests — no need for the React Compiler preset here.
  plugins: [react()],
  // `src/App.tsx` reads this build-time flag (vite.config.ts defines it from the proxy env). Tests
  // pin the UNCONFIGURED path through the real composition (#68): App must render chrome plus the
  // proxy prompt and build no client. A live-proxy leg belongs to the browser E2E lane, not here.
  define: { __EAPI_PROXY_CONFIGURED__: 'false' },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/setupTests.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/**/*.spec.{ts,tsx}', 'src/setupTests.ts', 'src/**/*.d.ts'],
      // #69 (F7) measured the first baseline: 87.33/83.03/91.86/90.35 (stmts/branch/funcs/lines),
      // src/components 100/92.3 · src/components/ui 87.71/86.2 · src/features 75/78.43 ·
      // src/shared 99.15/88.52, with `src/eapi` carrying only type-level modules (compiler-checked,
      // no runtime statements) so it contributes no rows and gets no per-dir floor.
      // #68 (F6 split) raised `src/features/vlans/` onto the shared hooks and made `src/App.tsx`
      // reachable to a unit test, re-measured on this branch (142 tests):
      //   all files 91.71/84.46/95.61/95.66 · src/components 100/92.3 · src/components/ui
      //   87.71/86.2/100/91.11 · src/features/vlans 79.54/79.1/82.75/90 · src/shared
      //   99.15/88.52/100/100 · src/App.tsx 100/50/100/100 (the half-branch at :12 is the
      //   proxy-configured arm, which no offline test can take — the live arm belongs to the
      //   browser E2E lane).
      // #70 (F8) added the redaction guard (175 tests) and measured 93.38/84.67/96.1/96.82, leaving
      // the floors untouched so the ratchet would land with the screen wave.
      // #71 (S1, this branch) measured 198 tests, all files 93.53/87.1/97.02/97.45
      // (stmts/branch/funcs/lines), with per-directory aggregates recomputed from
      // `coverage/coverage-final.json` rather than read off the truncated text table:
      //   src/features 89.02 stmts (255) / 86.81 branch (364) · src/features/interfaces
      //   94.01/91.3/100/99.29 · src/features/vlans unchanged 79.54/79.1/82.75/90 ·
      //   src/testing 100/88 (65 stmts) · src/shared 96.94 stmts / 86.40 branch / 99.43 lines.
      // Floors below are set ~2-4 points under those figures (ratchet up, never down). Two notes for
      // the coverage-lane owner (#69): (1) `src/shared/` branch coverage is 86.40 while that entry
      // asks for 87, and the leg still exits 0 — the per-glob `branches` figure does not appear to be
      // enforced the way `lines` is, so treat per-dir branch floors as advisory until #69 re-checks;
      // (2) the text table truncates directory names, so per-directory claims come from the JSON.
      thresholds: {
        'src/components/': { lines: 98, branches: 90 },
        'src/components/ui/': { lines: 90, branches: 84 },
        'src/features/': { lines: 90, branches: 84 },
        'src/features/interfaces/': { lines: 96, branches: 88 },
        'src/shared/': { lines: 98, branches: 87 },
        'src/testing/': { lines: 96, branches: 82 },
        lines: 95,
        branches: 85,
        functions: 95,
        statements: 90,
      },
    },
  },
})
