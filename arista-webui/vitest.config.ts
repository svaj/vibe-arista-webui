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
      // #72 (S2, stacked on S1) measured 228 tests, all files 93.61/87.23/96.57/97.94
      //   (stmts/branch/funcs/lines), with the same JSON-derived per-directory figures:
      //   src/features/vlans now 89.32/84.72/90.9/96.32 across both screens (`VlanAssignment`
      //   79.54/79.1/82.75/90, new `VlanManagement` 93.21/87.24/94.91/98.85 — the two uncovered lines
      //   are the probe's `1006` config-lock notice (:464) and the row of the probe-cleanup section
      //   that only renders when the probe itself listed a pending session (:531). Both arms need a
      //   probe run that reports the lock; the offline seam drives the equivalent cleanup through the
      //   device-state session list instead, so neither line executes in the mocked lane) ·
      //   src/features 100/100/100/100 once `staged-batch.test.ts` pinned the object-spec throw.
      //   Interfaces re-measured 94.67/91.45/100/100 for the same reason: the shared narrowing moved
      //   out of the screen. No new per-directory floor was added for `src/features/vlans/`, because
      //   its measured functions figure (90.9) sits under the global 95 and writing a floor there now
      //   would be a ratchet-down rather than a ratchet-up — the coverage lane (#69) should decide it.
      //   One correction for #69 while it is open: before that narrowing was pinned,
      //   `src/features/staged-batch.ts` reported 66.66 lines and the entry keyed `src/features/`
      //   (lines 90) did NOT fail the leg — so the per-glob keys appear not to be matched the way the
      //   report groups files, and both the `lines` and `branches` per-directory floors are advisory
      //   until that is re-checked. The four global thresholds are what actually gate today.
      //   [RE-CHECKED + FIXED by #124, 2026-11-15 — the keys never matched anything; see the
      //   enforcement note at the foot of this block. The 66.66 % case now exits 1 with a named
      //   per-directory error line.]
      // #74 (S4 read-only command console, stacked on main) measured the whole webui suite at
      //   all files 95.07/89.83/97.54/98.55 (stmts/branch/funcs/lines), per-directory from the JSON:
      //   src/features/console 98.03/91.36/100 — the four uncovered statements are the `!canAct || busy`
      //   and `!canAct` early arms of the four handlers, unreachable through real DOM because the same
      //   flags disable the controls (jsdom still dispatches a FireEvent click, and the in-flight test
      //   presses all three buttons to prove no second request starts, but the busy arm for `run` at the
      //   moment of the FIRST click can never be covered by definition). Interfaces re-measured
      //   95.06/92.16/99.24 and vlans 89.44/84.80/90.80 for the same tree, shared rose to 98.18/90.86.
      //   No new floor written for console, and per #124 the per-directory keys stay advisory anyway.
      //   [#124 landed later the same week; entries are live since then.]
      // #75 (S5 Port-Channel manager, stacked on the console lane) measured 404 tests / 28 files:
      //   all files 94.38/89.09/97.24/98.30 — the four GLOBAL legs still pass (94.38 ≥ 90 stmts,
      //   89.09 ≥ 85 branch, 97.24 ≥ 95 funcs, 98.30 ≥ 95 lines). Per-directory from the JSON:
      //   src/features/lags 91.38/86.30/96.08; its uncovered arms are the probe-session cleanup
      //   handler (`abortProbeSessions`, whose confirm flow the S2/S3 lanes already pin) and the
      //   create/description refusals behind the same gate. Still under `src/features/interfaces`'s
      //   advisory 96-line key — which is exactly the #124 case: per-glob keys do not fire, so this
      //   sits as a MEASUREMENT, not a floor, and no new threshold entry was written.
      // #76 (S6 IP addressing, stacked on #74+#75) measured the whole webui suite at 463 tests /
      //   29 files: all files 94.22/89.23/97.34/98.28 (all four global legs pass against the
      //   90/85/95/95 thresholds), with src/features/addressing at 93.07/89.77/98.18/98.16
      //   (stmts/branch/funcs/lines). IpAddressing.tsx (92.2/87.59/96.96/97.9) has four
      //   uncovered lines: the catch for an unparseable
      //   endpoint URL (:206, the fakes always carry a real one), the writable-name-grammar
      //   refusal that never executes because the split-QSFP row fails the kind guard first
      //   (:370), the declined-abort-confirm path (:446), and the Reload click handler (:489).
      //   No new threshold entry (same #124 advisory posture as above).      // #77 (S7 capability probe panel, stacked on the #123 knob branch) measured the whole webui
      //   suite at 499 tests / 31 files: all files 94.38/89.26/97.58/98.36 (stmts/branch/funcs/
      //   lines — all four global legs pass), with src/features/capabilities at 96.57/89.24/100/
      //   100. Statements' misses are all branch-HALVES: the `!canAct || busy` false-sides of the
      //   four handlers (the controls are disabled in exactly those states, the same shape #74
      //   records), the `typeof navigator` half of the clipboard guard, and `??` default arms the
      //   fakes always fill. The #123 hook additions (probeTrigger, lastOutcome/cacheNote pass-
      //   through) ride the existing 15-spec `use-capabilities.test.tsx` arms plus 4 new ones.
      //   No new threshold entry (same #124 advisory posture as above).
      // #78 (S8 system settings, stacked on the #123+#77 branches) measured the whole webui
      //   suite at 527 tests / 33 files: all files 94.02/89.19/96.86/98.23 (stmts/branch/funcs/
      //   lines — all four global legs pass), src/features/system at 88.88/88.75/87.23/96.32
      //   (system-rules.ts is 100 % statements — the mirrored guards are fully pinned; the
      //   container's misses are the DOM-unreachable guard arms again: the loader's
      //   `node === undefined` throw (the read is gated `enabled` in exactly that state), the
      //   preview/begin/commit/abort `busy || !canAct || draft` short-circuits (controls are
      //   disabled then, pinned disabled in the tests), and the `?? ''`/identity default arms
      //   the fakes always fill). `stageDisplay`'s open branch is the non-EOF-terminated
      //   object-spec fallback no current verb produces.
      //   No new threshold entry (same #124 advisory posture as above).
      // #79 (S9 transaction center, stacked on the S8 branch) measured the webui suite at
      //   550 tests / 35 files: all files 93.87/89.12/96.82/98.12, src/features/sessions at
      //   91.66/87.68/96.42/96.37 (session-rules.ts again 100 % statements). The container's
      //   open arms are the same DOM-unreachable guard family (#74-#78 records): the
      //   `busy || draft !== undefined` short-circuits behind enabled/disabled buttons, the
      //   journal-unreadable recovery refusal (jsdom localStorage does not throw), and the
      //   verify `missingAnswer` pill arm. No new threshold entry (#124 posture).
      // #90 (S16 VRF manager, 2026-11-16) measured the whole webui at 93/90.64/95.79/97.86
      //   (stmts/branch/funcs/lines, 951/50). Per-directory from the JSON: src/features/vrfs at
      //   84.02/86.41/91.59/95.2 — vrfs-rules.ts 100/97.56/100/100 (every mirrored guard and each
      //   byte-exact batch pinned), VrfsView.tsx 93.33 lines (the two dead `interfaceOptions.length
      //   === 0` select-disable arms are unreachable when the hard read answered rows, and the
      //   draft-index arm renders per-batch), Vrfs.tsx 94.81 lines (catch arms behind disabled
      //   controls — the same DOM-unreachable guard family the #74-#79 records track). New
      //   `src/features/vrfs/**` entry below holds the subtree at 2+ points under the measurement.
      // Floors below are set ~2-4 points under the measurements above (ratchet up, never down), and
      // as of #124 they GATE: on 2026-11-15 every entry was mutation-checked by dropping that
      // directory's coverage (uncovered probe files; for the two feature-aggregate entries, removing
      // the dashboard/manager suites) and watching each emit its own
      // `ERROR: Coverage for <metric> (<x>%) does not meet "<glob>" threshold (<n>%)` line, then
      // restoring — clean tree exits 0 at these floors, all files 93.75/90.96/96.22/98.05. Two notes
      // for the coverage-lane owner (#69): (1) superseded — the per-glob `branches` figure IS enforced
      // now; the 86.40-vs-87 anecdote reproduced to the digit under a probe the day the keys were
      // fixed (86.4), which is what proved the entries binding rather than decorative; (2) still true:
      // the text table truncates directory names, so per-directory claims come from the JSON — though
      // a failing glob now ALSO prints its pattern and percentages in the error line. #124 further
      // found the historical per-directory numbers were DIRECT-FILES aggregates (istanbul's report
      // grouping never nests), which the literal keys hid; the table below therefore carries both
      // `dir/*` (the directory's own files — what those historical 100/92.3 figures measured) and
      // `dir/*` (the directory's own files — what those historical 100/92.3 figures measured) and
      // `dir/**` (subtree aggregate). Enforcement exposed one genuine floor miss — `src/features/*`
      // direct files at branches 83.33 under the 84 floor, which is `stageDisplay`'s two non-EOF-
      // framing arms, recorded open by #78 as "the object-spec fallback no current verb produces" —
      // closed now with a spec, not a lowered floor. `AppShell`'s `tone: 'warn'` status-dot arm, the
      // last uncovered spot anywhere in `src/components/`, was pinned by the same sweep: the direct
      // files sat at branches 92.31 (passing) while the aggregate sat at 87.32, and that split was
      // the whole reason the two key levels exist rather than one.
      thresholds: {
        // #124: keys are **picomatch patterns matched against the workspace-relative file path**
        // (vitest 5 `resolveThresholds`: `pm(glob)` over `relative(root, file)`). The legacy
        // `'src/features/'` form is a LITERAL pattern matching no file: the entry aggregated the empty
        // set and the leg exited 0 over a directory at 66.66 % (#124's smoking gun, reproduced
        // 2026-11-15: covered files removed from four floored directories, exit still 0). Two forms
        // bind, and they mean different things, so this config now carries both levels per directory:
        //   'dir/*'  — the directory's DIRECT files only (what every historical per-directory figure
        //              in the comments above actually measured, e.g. the `src/features 100/100` that
        //              `staged-batch.ts` earned; a new uncovered sibling cannot hide in the aggregate).
        //   'dir/**' — the whole subtree aggregate (screen directories carry their own entry too).
        // Every entry was mutation-checked the same day (deliberate uncovered probes / dropped suites;
        // each produced its own `does not meet "..." threshold` line, then restored). `components/*`
        // needed one new spec — the `tone: 'warn'` status-dot arm of AppShell, previously never
        // rendered, which is why the parent sat at branches 87.32 under a 90 floor.
        'src/components/*': { lines: 98, branches: 90 },
        'src/components/ui/**': { lines: 90, branches: 84 },
        'src/features/*': { lines: 90, branches: 84 },
        'src/features/**': { lines: 90, branches: 84 },
        'src/features/interfaces/**': { lines: 96, branches: 88 },
        // #90: measured 95.2 lines / 86.41 branches (2026-11-16); floors sit 2.2 / 1.4 under that.
        'src/features/vrfs/**': { lines: 93, branches: 85 },
        'src/shared/**': { lines: 98, branches: 87 },
        'src/testing/**': { lines: 96, branches: 82 },
        lines: 95,
        branches: 85,
        functions: 95,
        statements: 90,
      },
    },
  },
})
