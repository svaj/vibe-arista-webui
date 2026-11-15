/**
 * Offline guard for the M13/#91 browser E2E lane (extends the DR-034/DR-043 "npm test stays
 * device-free" rule to Playwright). These assertions run in the ordinary vitest project and
 * fail the offline CI leg if the lane ever stops being strictly opt-in:
 *
 *  1. no E2E spec may live under src/ (vitest collects src/**\/*.{test,spec}.{ts,tsx} and both
 *     coverage includes count src\/**\/*.ts);
 *  2. nothing named `test`/`coverage`/`build`/`typecheck`/`lint` may reference playwright/e2e
 *     (root or workspace package.json), while the `e2e` opt-in entry point exists;
 *  3. playwright.config.ts must stay single-worker with every identifying-artifact container
 *     OFF (trace/video/HAR/screenshots), because scripts/assert-e2e-run.mjs can only scan text.
 */
// File enumeration follows src/testing/redaction-guard.test.ts: `import.meta.glob` + `?raw`,
// because the app tsconfig project deliberately carries no node types (browser purity).
import { describe, expect, it } from 'vitest'

import webuiManifestRaw from '/package.json?raw'
import rootManifestRaw from '../../package.json?raw'
import playwrightConfigRaw from '/playwright.config.ts?raw'
import vitestConfigRaw from '/vitest.config.ts?raw'

/** Root-relative keys (lazy globs: keys only, contents never loaded). */
const srcFiles = Object.keys(import.meta.glob('/src/**/*'))
const e2eFiles = Object.keys(import.meta.glob('/e2e/**/*'))

interface Manifest { scripts: Record<string, string> }
const webuiPkg = JSON.parse(webuiManifestRaw) as Manifest
const rootPkg = JSON.parse(rootManifestRaw) as Manifest

const E2E_HELPERS: readonly string[] = ['/e2e/device.ts', '/e2e/fixtures.ts', '/e2e/interactions.ts', '/e2e/scrub.ts']

describe('E2E lane boundary (#91)', () => {
  it('keeps every Playwright spec out of src/ and on the .e2e.ts suffix', () => {
    expect(srcFiles.filter((f) => f.includes('.e2e.'))).toEqual([])
    expect(e2eFiles.length, 'the lane directory must keep existing').toBeGreaterThan(0)
    for (const file of e2eFiles) {
      const ok = file.endsWith('.e2e.ts') || E2E_HELPERS.includes(file)
      expect(ok, `e2e file ${file} must be *.e2e.ts or a known helper`).toBe(true)
    }
    // The vitest collection glob can never reach the lane dir:
    expect(vitestConfigRaw).toContain("include: ['src/**/*.{test,spec}.{ts,tsx}']")
  })

  it('keeps the aggregate test scripts device-free and playwright-blind', () => {
    for (const pkg of [webuiPkg, rootPkg]) {
      for (const name of ['test', 'coverage', 'build', 'typecheck', 'lint'] as const) {
        expect(pkg.scripts[name] ?? '', `script ${name} must not reach the E2E lane`).not.toMatch(/playwright|\be2e\b/iu)
      }
    }
    // …while the opt-in entry point itself exists at both levels (mirrors test:live/lab:*):
    expect(webuiPkg.scripts['e2e']).toContain('ceos-lab.mjs run')
    expect(webuiPkg.scripts['e2e']).toContain('e2e-run.mjs')
    expect(rootPkg.scripts['e2e']).toContain('-w arista-webui')
  })

  it('pins the artifact-hygiene and single-flight settings of playwright.config.ts', () => {
    expect(playwrightConfigRaw).toMatch(/workers:\s*1/u)
    expect(playwrightConfigRaw).toMatch(/fullyParallel:\s*false/u)
    expect(playwrightConfigRaw).toMatch(/retries:\s*0/u)
    expect(playwrightConfigRaw).toMatch(/trace:\s*'off'/u)
    expect(playwrightConfigRaw).toMatch(/video:\s*'off'/u)
    expect(playwrightConfigRaw).toMatch(/screenshot:\s*'off'/u)
    // Checked as a SETTING, not as prose — the config header mentions recordHar to explain its absence:
    expect(playwrightConfigRaw).not.toMatch(/recordHar: /u)
  })
})
