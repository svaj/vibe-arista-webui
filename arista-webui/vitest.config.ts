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
      // #71 (S1, this branch) measured 199 tests, all files 93.59/87.06/97.05/97.47
      // (stmts/branch/funcs/lines), with per-directory aggregates recomputed from
      // `coverage/coverage-final.json` rather than read off the truncated text table:
      //   src/features 89.27 stmts (261) / 86.76 branch (370) · src/features/interfaces
      //   94.21/91.1/100/99.31 (its one uncovered line is `stageLines`' object-spec throw, which no
      //   all-strings stage can reach) · src/features/vlans unchanged 79.54/79.1/82.75/90 ·
      //   src/testing 100/88 (65 stmts) · src/shared 96.94 stmts / 86.40 branch / 99.43 lines.
      // #72 (S2, stacked on S1) measured 227 tests, all files 93.46/87.1/96.56/97.93
      //   (stmts/branch/funcs/lines), with the same JSON-derived per-directory figures:
      //   src/features/vlans now 88.81/84.39/90.8/96.26 across both screens (`VlanAssignment`
      //   79.54/79.1/82.75/90, new `VlanManagement` 92.59/86.85/94.82/98.83 — the two uncovered lines
      //   are the probe's `1006` config-lock notice (:450) and the row of the probe-cleanup section
      //   that only renders when the probe itself listed a pending session (:517). Both arms need a
      //   probe run that reports the lock; the offline seam drives the equivalent cleanup through the
      //   device-state session list instead, so neither line executes in the mocked lane) ·
      //   src/features 100/100/100/100 once `staged-batch.test.ts` pinned the object-spec throw.
      //   Interfaces re-measured 94.67/91.45/100/100 for the same reason: the shared narrowing moved
      //   out of the screen. No new per-directory floor was added for `src/features/vlans/`, because
      //   its measured functions figure (90.8) sits under the global 95 and writing a floor there now
      //   would be a ratchet-down rather than a ratchet-up — the coverage lane (#69) should decide it.
      //   One correction for #69 while it is open: before that narrowing was pinned,
      //   `src/features/staged-batch.ts` reported 66.66 lines and the entry keyed `src/features/`
      //   (lines 90) did NOT fail the leg — so the per-glob keys appear not to be matched the way the
      //   report groups files, and both the `lines` and `branches` per-directory floors are advisory
      //   until that is re-checked. The four global thresholds are what actually gate today.
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
