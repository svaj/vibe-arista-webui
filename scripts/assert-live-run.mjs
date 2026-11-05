#!/usr/bin/env node
/**
 * Summary-line assertion for the cEOS live lane (M12, issue #14) — the check that turns
 * "the live job is green" into "real device tests actually executed".
 *
 * Why this exists: DR-034 makes an unconsented local live run print a reason and **exit 0** with the
 * whole suite skipped, by design. That convention is correct locally and dangerous in CI —
 * docs/CEOS.md: "An explicitly requested CI cEOS/E2E job must fail on missing image, credentials,
 * readiness, trust, target mismatch, zero executed tests, or teardown failure", and TESTING.md §8
 * spells out that `passWithNoTests: false` cannot detect an all-skipped suite. So the exit code of
 * `vitest run --project live` is NOT the signal here; the reported counts are. This script reads the
 * captured vitest output and asserts on the summary lines themselves.
 *
 * Rules (a pass requires ALL of them):
 *   - a `Tests` summary line exists (no summary ⇒ vitest crashed, or the harness refused before the
 *     child ever started — either way nothing was executed and the job must not be green);
 *   - zero failed tests and zero failed files;
 *   - at least `--min-passed` (default 1, never 0) passing tests, i.e. executed > 0;
 *   - zero skipped tests, because in this lane every skip is a guard refusal or an unported case and
 *     a job that "passed" while skipping everything is the exact fake green the runbook forbids.
 * It also prints the skip/refusal lines it found, so a red job explains itself (diagnostics before
 * teardown, per docs/CEOS.md §Browser E2E and CI plan item 4).
 *
 * `--check-secrets` runs the artifact-hygiene scan over the same log: the lab prints its one-time
 * credentials in `up`'s JSON, so a log destined for an artifact must be produced under
 * `npm run lab:run -- --quiet`. A leak fails with the pattern NAME and line number only — never the
 * value (the same rule `src/testing/live-guard.ts` applies to its refusal reasons).
 *
 * Dependency-free like scripts/dist-smoke.mjs: node: builtins only, so it runs on a runner that has
 * this repo checked out and nothing installed.
 *
 * Exit codes: 0 asserted · 1 assertion failed · 2 usage / log unreadable.
 */

import fs from 'node:fs'
import process from 'node:process'

/**
 * Credential-shaped text. Names are printed on failure; the matched value never is.
 *
 * Deliberately written so the harness's own safe output does NOT match: every pattern rejects a
 * value starting with `<`, which is what `--quiet` and `redactCopy` substitute (`<withheld: …>`,
 * `<redacted-lab-secret>`), and `EAPI_PASS_VAR=EAPI_LAB_PW` is excluded because live-guard reasons
 * name the **variable**, never a value — printing that name is correct behavior, not a leak.
 */
const SECRET_PATTERNS = [
  { name: 'a harness credential field with a literal value', re: /["']secret["']\s*:\s*["'](?!<)[^"']{6,}["']/u },
  { name: 'a password/token-shaped JSON value', re: /["'](password|passwd|passphrase|token|authorization)["']\s*:\s*["'](?!<)[^"']{4,}["']/u },
  { name: 'EAPI_PASS=<value> in a printed command', re: /EAPI_PASS=(?!<)[^\s]{4,}/u },
  { name: 'a Basic auth header', re: /authorization\s*:\s*basic\s+[A-Za-z0-9+/=]{8,}/iu },
  { name: 'an EOS `secret <hash>` stanza', re: /\bsecret\s+(?:0|sha512|plaintext)\s+(?!<)[A-Za-z0-9+/.=-]{8,}/iu },
  { name: 'PEM key material', re: /-----BEGIN (?:RSA |EC )?(?:PRIVATE KEY|ENCRYPTED)/u },
]

/** @param {string[]} argv */
function parseArgs(argv) {
  const out = { log: 'live-run.log', minPassed: 1, checkSecrets: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--check-secrets') out.checkSecrets = true
    else if (arg === '--min-passed') {
      const value = Number(argv[i + 1])
      if (!Number.isInteger(value) || value < 0) {
        process.stderr.write(`refused: --min-passed needs an integer, got ${JSON.stringify(argv[i + 1])}\n`)
        process.exitCode = 2
        return out
      }
      out.minPassed = value
      i += 1
    } else if (!arg.startsWith('-')) out.log = arg
    else {
      process.stderr.write(`refused: unknown flag ${arg}\n`)
      process.exitCode = 2
      return out
    }
  }
  return out
}

function usage() {
  process.stdout.write(
    `assert-live-run — fail when a live lane skipped instead of ran (M12 #14)

usage: node scripts/assert-live-run.mjs <vitest-output.log> [--min-passed N] [--check-secrets]

  reads the captured \`vitest run --project live\` output and asserts the summary counts:
  a summary must exist, nothing may be failed, at least N tests must have PASSED
  (default 1 — pass 0 only to allow an intentionally empty lane), and NOTHING may be
  skipped, because a skip here means a guard refusal or an unported case.
  --check-secrets additionally scans the log for credential-shaped text and names the
  pattern (never the value) that matched.

exit: 0 asserted · 1 assertion failed · 2 usage / unreadable log
`,
  )
}

/**
 * Vitest prints the counts on two summary lines, e.g.
 *   `      Tests  3 passed | 1 skipped (4)` or ` Test Files  1 skipped (1)`.
 * Parse the word/number pairs rather than a fixed sentence, so a reporter wording change
 * (or an added `todo` bucket) does not silently make the assertion vacuous — a missing
 * `Tests` line is itself a failure rule.
 * @param {string} text
 * @param {'Tests' | 'Test Files'} label
 */
function summaryCounts(text, label) {
  const lines = text.split('\n').filter((line) => new RegExp(`^\\s+${label}\\s`, 'u').test(line))
  if (lines.length === 0) return undefined
  const line = lines[lines.length - 1]
  /** @type {Record<string, number>} */
  const counts = {}
  for (const match of line.matchAll(/(\d+)\s+([a-z]+)/gu)) counts[match[2]] = Number(match[1])
  const totalsMatch = /\((\d+)\)/u.exec(line)
  return { line: line.trim(), counts, total: totalsMatch ? Number(totalsMatch[1]) : undefined }
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  usage()
  process.exitCode = 0
} else if (process.exitCode !== 2) {
  if (!fs.existsSync(args.log)) {
    process.stderr.write(`refused: cannot read the live log at ${args.log} — the live step must tee its output there\n`)
    process.exitCode = 2
  } else {
    const text = fs.readFileSync(args.log, 'utf8')
    const tests = summaryCounts(text, 'Tests')
    const files = summaryCounts(text, 'Test Files')
    const problems = []

    process.stdout.write(`live log: ${args.log}\n`)
    for (const entry of [files, tests]) {
      if (entry) process.stdout.write(`  summary: ${entry.line}\n`)
    }

    if (!tests) {
      problems.push('the live suite printed no "Tests" summary line — vitest never reported a result, so nothing can be claimed as executed (a harness refusal or a crash looks identical to a green job if only the exit code is consulted)')
    } else {
      const { counts } = tests
      const failed = (counts.failed ?? 0) + (counts.error ?? 0)
      const passed = counts.passed ?? 0
      const skipped = counts.skipped ?? 0
      if (failed > 0) problems.push(`the live suite reported ${String(failed)} failed test(s)`)
      if (passed === 0) {
        problems.push(`no test executed: ${String(passed)} passed, ${String(skipped)} skipped, total ${String(tests.total ?? '(unknown)')} — DR-034 makes an unconsented local run exit 0 with everything skipped, and this lane must NOT inherit that leniency (docs/CEOS.md: zero executed tests fails the job)`)
      } else if (passed < args.minPassed) {
        problems.push(`only ${String(passed)} passed test(s), below --min-passed ${String(args.minPassed)}`)
      }
      if (skipped > 0) {
        problems.push(`${String(skipped)} skipped test(s): in this lane a skip is a guard refusal or an unported case, never acceptable coverage (an unsupported cEOS feature is documented in TESTING.md §5, not silently skipped)`)
      }
      if (files && ((files.counts.failed ?? 0) > 0 || (files.counts.error ?? 0) > 0)) {
        problems.push(`${String((files.counts.failed ?? 0) + (files.counts.error ?? 0))} failed test file(s)`)
      }
    }

    if (args.checkSecrets) {
      const lines = text.split('\n')
      for (const { name, re } of SECRET_PATTERNS) {
        const hit = lines.findIndex((line) => re.test(line))
        if (hit >= 0) problems.push(`artifact hygiene: the log appears to carry ${name} at line ${String(hit + 1)} (value withheld) — run the lab with --quiet and re-collect before uploading`)
      }
    }

    // Print the refusal/skip evidence the harness or guard produced, so the failure is actionable.
    const skipLines = text
      .split('\n')
      .filter((line) => /skipped:|refused \(exit|REFUSED|EAPI_[A-Z_]+ is not set|no device test will run/u.test(line))
      .slice(0, 8)
    if (skipLines.length > 0) {
      process.stdout.write('  skip/refusal evidence found in the log:\n')
      for (const line of skipLines) process.stdout.write(`    ${line.trim().slice(0, 240)}\n`)
    }

    if (problems.length > 0) {
      process.stdout.write(`FAIL live lane did not demonstrate executed device tests:\n`)
      for (const problem of problems) process.stdout.write(`  - ${problem}\n`)
      process.exitCode = 1
    } else {
      const passedCount = tests?.counts.passed ?? 0
      process.stdout.write(
        `ok live lane executed ${String(passedCount)} test(s) with zero skipped and zero failed — this run may be reported as cEOS coverage (container evidence only, DR-043)\n`,
      )
      process.exitCode = 0
    }
  }
}
