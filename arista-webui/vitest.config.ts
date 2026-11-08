import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Plain React transform for tests — no need for the React Compiler preset here.
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/setupTests.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/**/*.spec.{ts,tsx}', 'src/setupTests.ts', 'src/**/*.d.ts'],
      // #69 (F7): measured baseline on the gate branch (run 2026-11-08, 139 tests):
      //   all files 87.33/83.03/91.86/90.35 (stmts/branch/funcs/lines);
      //   src/components 100/92.3/100/100 · src/components/ui 87.71/86.2/100/91.11 ·
      //   src/features 75/78.43/78.94/80.58 · src/shared 99.15/88.52/100/100 ·
      //   src/eapi carries only type-level modules (show-contracts is compiler-checked, no runtime
      //   statements), so it contributes no measurable rows and gets no per-dir floor.
      // Floors sit at the client's style — a few points under measured, so erosion fails the leg
      // while honest rounding of a 379-statement corpus doesn't flap. Screen issues RAISE these
      // floors as they add tests (ratchet up, never down).
      thresholds: {
        'src/components/': { lines: 95, branches: 88 },
        'src/components/ui/': { lines: 88, branches: 82 },
        'src/features/': { lines: 78, branches: 75 },
        'src/shared/': { lines: 96, branches: 85 },
        lines: 88,
        branches: 80,
        functions: 88,
        statements: 85,
      },
    },
  },
})
