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
      thresholds: {
        'src/internal/': { lines: 90, branches: 85 },
        'src/transports/': { lines: 85, branches: 80 },
        'src/resources/': { lines: 85, branches: 80 },
        // M6 (#8) added this one once src/config/ measured 100/93.75/100/100 (stmts/branch/funcs/
        // lines) under its new suites — same strength as the src/internal gate, both strictly
        // above the global 85/75 floor. It exists so M7-M10 consumption cannot erode the engine's
        // coverage back to the 34% that failed this milestone's gate.
        'src/config/': { lines: 90, branches: 85 },
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
