#!/usr/bin/env node
/**
 * M13 / #91 — boundary assertion for the browser E2E lane, the Playwright sibling of
 * scripts/assert-live-run.mjs (same philosophy, DR-086/DR-088): the green signal is the
 * REPORTED COUNTS plus a credential/identity scan, never just an exit code.
 *
 * usage: node scripts/assert-e2e-run.mjs [arista-webui/e2e-results/results.json]
 *        [--min-passed N] [--allow-skipped] [--check-secrets] [--artifacts <dir>]
 *
 * Rules (a pass requires ALL of them):
 *   - the Playwright JSON reporter stats exist (missing ⇒ the runner crashed before reporting);
 *   - `unexpected` === 0 and `flaky` === 0;
 *   - `expected` >= --min-passed (default 1): zero executed is RED, per DR-043's "no executed
 *     tests" refusal; an all-skipped run is exactly the fake green the runbook forbids;
 *   - zero skipped unless --allow-skipped: under `npm run e2e` every lane precondition is
 *     exported by scripts/e2e-run.mjs, so a skip means a missing precondition (e.g. running
 *     `e2e:playwright` directly against only part of the harness).
 *
 * `--check-secrets` scans every text artifact under --artifacts (default
 * arista-webui/e2e-results) with assert-live-run.mjs's SECRET_PATTERNS plus the F8 identity
 * rules (MAC with a non-zero device half, non-placeholder serial values). The lane keeps
 * trace/video/HAR OFF (playwright.config.ts) precisely so everything on disk is scannable
 * text; a failure prints only the pattern NAME, file, and line — never the value.
 *
 * Exit codes: 0 asserted · 1 assertion failed · 2 usage / unreadable input.
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

// Deliberately REJECTS values starting with `<` and the F8 placeholder forms, mirroring
// scripts/assert-live-run.mjs so a pattern that is safe in the API lane is safe here.
const SECRET_PATTERNS = [
  { name: 'a harness credential field with a literal value', test: (line) => /["']secret["']\s*:\s*["'](?!<)[^"']{6,}["']/u.test(line) },
  { name: 'a password/token-shaped JSON value', test: (line) => /["'](password|passwd|passphrase|token|authorization)["']\s*:\s*["'](?!<|replace-with-a-lab-only-password$)[^"']{4,}["']/u.test(line) && !/["'](password|passwd|passphrase|token|authorization)["']\s*:\s*["'](never-sent|replace-with-a-lab-only-password)["']/u.test(line) },
  { name: 'EAPI_PASS=<value> in a printed command', test: (line) => /EAPI_PASS=(?!<)[^\s]{4,}/u.test(line) },
  { name: 'a Basic auth header', test: (line) => /authorization\s*:\s*basic\s+[A-Za-z0-9+/=]{8,}/iu.test(line) },
  { name: 'an EOS `secret <hash>` stanza', test: (line) => /\bsecret\s+(?:0|sha512|plaintext)\s+(?!<)[A-Za-z0-9+/.=-]{8,}/iu.test(line) },
  { name: 'PEM key material', test: (line) => /-----BEGIN (?:RSA |EC )?(?:PRIVATE KEY|ENCRYPTED)/u.test(line) },
  {
    name: 'a device-assigned MAC (non-zero last three octets)',
    test: (line) => [...line.matchAll(/(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}/giu)].some((m) => {
      const octets = m[0].split(/[:-]/u)
      return octets.slice(3).some((octet) => octet.toLowerCase().padStart(2, '0') !== '00')
    }),
  },
  {
    name: 'a serial-looking value that is not a redaction placeholder',
    test: (line) => [...line.matchAll(/serial(?:\s?number)?["']?\s*[:=]\s*["']?([^"',\s]+)/giu)].some((m) => {
      const value = m[1].replaceAll(/[^0-9A-Za-z]/gu, '')
      return value !== '' && !/^0+$/u.test(value) && !['redacted', 'redactedserial'].includes(value.toLowerCase())
    }),
  },
]

function parseArgs(argv) {
  const out = { results: 'arista-webui/e2e-results/results.json', artifacts: 'arista-webui/e2e-results', minPassed: 1, allowSkipped: false, checkSecrets: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--check-secrets') out.checkSecrets = true
    else if (arg === '--allow-skipped') out.allowSkipped = true
    else if (arg === '--min-passed') {
      const value = Number(argv[i + 1])
      if (!Number.isInteger(value) || value < 0) { process.stderr.write(`refused: --min-passed needs an integer, got ${JSON.stringify(argv[i + 1])}\n`); out.help = true; return out }
      out.minPassed = value
      i += 1
    } else if (arg === '--artifacts') {
      const value = argv[i + 1]
      if (typeof value !== 'string' || value === '') { process.stderr.write('refused: --artifacts needs a directory\n'); out.help = true; return out }
      out.artifacts = value
      i += 1
    } else if (!arg.startsWith('-')) out.results = arg
    else { process.stderr.write(`refused: unknown flag ${arg}\n`); out.help = true; return out }
  }
  return out
}

function usage() {
  process.stdout.write(
    `assert-e2e-run — fail when the browser E2E lane skipped, broke, or leaked (M13 #91)

usage: node scripts/assert-e2e-run.mjs [results.json] [--min-passed N] [--allow-skipped]
                                       [--check-secrets] [--artifacts <dir>]

exit: 0 asserted · 1 assertion failed · 2 usage / unreadable input
`,
  )
}

/** Recursively list scannable text files (lane policy: trace/video/HAR are OFF, so everything
 * Playwright writes here is text; genuinely binary files are refused as unexpected artifacts). */
function listFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) listFiles(full, out)
    else if (entry.isFile()) out.push(full)
  }
  return out
}

const TEXTISH = /\.(json|txt|log|xml|md|ya?ml|csv|html?)$/iu

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) { usage(); process.exitCode = args.help && process.argv.length > 2 ? 2 : 0; return }

  if (!fs.existsSync(args.results)) {
    process.stderr.write(`assert-e2e-run: REFUSED — results file not found: ${args.results} (the lane must have run)\n`)
    process.exit(1)
  }
  let report
  try {
    report = JSON.parse(fs.readFileSync(args.results, 'utf8'))
  } catch {
    process.stderr.write(`assert-e2e-run: REFUSED — results file is not valid JSON: ${args.results}\n`)
    process.exit(2)
  }
  const stats = report?.stats
  if (stats === undefined || typeof stats.expected !== 'number') {
    process.stderr.write('assert-e2e-run: FAILED — no stats block: the runner crashed before reporting\n')
    process.exit(1)
  }
  const failures = []
  if (stats.unexpected > 0) failures.push(`${stats.unexpected} test(s) FAILED`)
  if (stats.flaky > 0) failures.push(`${stats.flaky} flaky test(s) (retries are disabled — flaky is a bug)`)
  if (stats.expected < args.minPassed) failures.push(`only ${stats.expected} test(s) passed (min ${args.minPassed}) — a lane that executes nothing is red (DR-043)`)
  if (stats.skipped > 0 && !args.allowSkipped) failures.push(`${stats.skipped} test(s) SKIPPED — every skip means a missing lane precondition; rerun through \`npm run e2e\` or pass --allow-skipped deliberately`)
  if (!Array.isArray(report.suites) || report.suites.length === 0) failures.push('no suites in the report')
  if (Array.isArray(report.errors) && report.errors.length > 0) failures.push(`report carries ${report.errors.length} top-level error(s)`)

  if (args.checkSecrets) {
    if (!fs.existsSync(args.artifacts)) {
      failures.push(`--check-secrets given but artifacts dir ${args.artifacts} is missing`)
    } else {
      for (const file of listFiles(args.artifacts)) {
        if (!TEXTISH.test(file)) {
          failures.push(`unexpected non-text artifact ${path.basename(file)} (trace/video/HAR must stay OFF in this lane)`)
          continue
        }
        const lines = fs.readFileSync(file, 'utf8').split('\n')
        for (const pattern of SECRET_PATTERNS) {
          for (let index = 0; index < lines.length; index += 1) {
            if (pattern.test(lines[index])) {
              failures.push(`secret scan: ${pattern.name} in ${path.relative(process.cwd(), file)} line ${index + 1} (value not printed)`)
              break
            }
          }
        }
      }
    }
  }

  const summary = `expected=${stats.expected} skipped=${stats.skipped} unexpected=${stats.unexpected} flaky=${stats.flaky}`
  if (failures.length > 0) {
    process.stderr.write(`assert-e2e-run: FAILED (${summary})\n - ${failures.join('\n - ')}\n`)
    process.exit(1)
  }
  process.stdout.write(`assert-e2e-run: OK (${summary}${args.checkSecrets ? `, secret scan over ${args.artifacts}` : ''})\n`)
}

main()
