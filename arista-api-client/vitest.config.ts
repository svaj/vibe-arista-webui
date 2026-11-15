import { defineConfig } from 'vitest/config'

// Mirrors docs/TESTING.md §2. Two projects:
//   unit — offline contract suite (`npm test`); never a device, never a container.
//   live — `*.live.test.ts` only, single-flight, run only via `npm run test:live` (DR-034/DR-035/DR-043).
export default defineConfig({
  test: {
    globals: false, // explicit imports; matches webui
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      // TESTING.md §2 writes `include: ['src/**']`; narrowed to `.ts` because the M0 skeleton
      // keeps README.md stubs inside src/ dirs (a directory that cannot be committed empty),
      // and the v8 provider tries to parse everything the glob matches → PARSE_ERROR.
      include: ['src/**/*.ts'],
      exclude: ['src/testing/**', 'src/**/*.test.ts', 'src/**/*.live.test.ts', 'src/types/**'],
      // #146 (2026-11-15): these keys are **picomatch patterns matched against the
      // workspace-relative file path** (vitest 5.0.5 `resolveThresholds`: `pm(glob)` over
      // `relative(root, file)`). The legacy `'src/internal/'`-style trailing-slash form is a
      // LITERAL pattern that matches zero files — the entry aggregated the empty set and the leg
      // exited 0 over a directory at any percentage. This is the client mirror of #124 (PR #145)
      // on the webui side, where the same defect was found and fixed; #146 was filed from it.
      // Reproduced here before the fix: an uncovered probe under `src/config/` drove that
      // directory's direct-files aggregate to 83.21 lines / 63.08 branches — both under the
      // floors below — yet `npm run coverage` still exited 0 with no error line (the key was inert).
      //
      // `'dir/*'` (single `*`) binds to a directory's DIRECT files and is the form used here
      // because all four floored client directories are FLAT (no subdirectories), so the direct-
      // files aggregate equals the whole subtree — and equals the historical per-directory figure
      // the istanbul text-table printed (istanbul's report grouping is per-directory, never
      // nested). If a subdirectory is ever added under any of these, a matching entry is needed
      // (a `dir/*` key does NOT recurse) — the same direct-vs-subtree split #124 documents for the
      // webui, which has nested screen dirs and so carries both levels.
      //
      // Floors are the values the previous block already intended; #146 re-measured each directory
      // on a clean tree and all four clear their floor once binding (tightest: src/transports at
      // 96.86 lines / 87.21 branches vs its 85/80 floor; src/config 100/93.75 vs its 90/85). No
      // floor was lowered and no coverage gap surfaced — unlike #124's webui case, where binding
      // the keys exposed one genuine miss that a new spec closed. Every entry below was
      // mutation-checked the same day: a fresh uncovered probe in each directory produced its own
      // `ERROR: Coverage for <metric> (<x>%) does not meet "src/<dir>/*" threshold (<n>%)` line,
      // then restored; clean tree exits 0 at these floors (all files 98.15/94.16/99.35/99.16).
      // M6 (#8) had written the `src/config/` floor "so M7-M10 consumption cannot erode the
      // engine's coverage back to the 34%" — that guarantee is only true as of this change; before
      // it the key never fired.
      thresholds: {
        'src/internal/*': { lines: 90, branches: 85 },
        'src/transports/*': { lines: 85, branches: 80 },
        'src/resources/*': { lines: 85, branches: 80 },
        // M6 (#8) added this one once src/config/ measured 100/93.75/100/100 (stmts/branch/funcs/
        // lines) under its new suites — same strength as the src/internal gate, both strictly
        // above the global 85/75 floor.
        'src/config/*': { lines: 90, branches: 85 },
        lines: 85,
        branches: 75,
        functions: 60,
      },
    },
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts', 'src/**/*.fixture.test.ts'],
          exclude: ['src/**/*.live.test.ts'],
        },
      },
      {
        test: {
          name: 'live',
          environment: 'node',
          include: ['src/**/*.live.test.ts'],
          pool: 'forks',
          fileParallelism: false,
          maxWorkers: 1,
          testTimeout: 60_000,
        },
      },
    ],
  },
})
