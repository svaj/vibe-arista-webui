/**
 * `hw-inventory.live.test.ts` — batch-1 read-only inventory capture from the physical 7050TX-64
 * (#14 §3, hardware lane). This is the executor the operator drives during a supervised switch
 * session: every file lands under `test/fixtures/recordings/7050tx-64-4.28.13.1M/` via the existing
 * recorder/writer pair (identity envelope + `findUnredactedEnableInput` gate come free), and the
 * extra hardware redactions of `hw-capture.ts` are applied **before** any bytes are committed
 * (serials everywhere, MACs anywhere, PEM, secret material, and operator-supplied hostname/IP
 * literals from `EAPI_HW_SCRUB`).
 *
 * ## Why this is a live-test file and not a standalone script
 * Everything that decides *whether a switch may be addressed at all* already lives in
 * `live-guard.ts` under `EAPI_TARGET_CLASS=hardware` (named host + port, https only, exact
 * `DCS-7050TX-64`/`4.28.13.1M` pins, the `EAPI_HW_CONSENT` echo) and in
 * `matchesDeviceIdentity` on the device's own `show version` — re-implementing those checks in a
 * script is exactly the drift DR-034/DR-035 forbid. The ordinary lab env keeps skipping this file:
 * `EAPI_TARGET_CLASS=lab` skips loudly (reason printed), same for an unset opt-in flag.
 *
 * ## Loud gates (DR-034 lineage)
 * Runs only with ALL of: `EAPI_LIVE=1`, a complete **hardware** guard environment (see
 * `resolveLiveEnv` refusals), and `EAPI_HW_CAPTURE=1` (the capture-file write opt-in — a passing
 * hardware *readiness* run must never rewrite committed evidence by accident, the same
 * overwrite-discipline `recorder-node.ts:writeRecording` documents). Otherwise: printed skip reason.
 *
 * ## Negatives are captures, not failures
 * Device `CommandError` replies (a `1002` "unsupported on this platform") are exactly what §3 asks
 * which questions to answer — the exchange is recorded (the sink saw the error envelope) and the
 * case is reported as recorded-negative. A **transport-level** failure instead aborts the run:
 * half-captured switch evidence is worse than none.
 *
 * Read-mostly per #14 §3: every command comes from `HW_INVENTORY_CATALOG`, which the unit suite
 * pins read-only-by-construction (`hw-capture.test.ts`).
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { createNode } from './node'
import { CommandError } from './errors'
import { buildRecording, createRecorder } from './testing/recording'
import { writeRecording } from './testing/recorder-node'
import { describeLiveTarget, liveTransportOptions, matchesDeviceIdentity, resolveLiveEnv, unwrapLiveTarget, type LiveTarget } from './testing/live-guard'
import { HW_INVENTORY_CATALOG, HW_TEXT_SCENARIO, hwCaseName, hwDeviceIdentity, sanitizeHwRecording } from './testing/hw-capture'
import type { VersionProperties } from './command-layer'

const resolution = resolveLiveEnv(process.env)
if (!resolution.ok) {
  console.warn(`hw-inventory: SKIPPED (DR-034) — ${resolution.reason}`)
}
const hardwareOptIn = resolution.ok && resolution.targetClass === 'hardware'
if (resolution.ok && resolution.targetClass === 'lab') {
  console.warn('hw-inventory: SKIPPED — EAPI_TARGET_CLASS=lab: this file captures physical-switch evidence only (DR-043). Use scripts/ceos-lab.mjs fixtures for the container lane.')
}
const captureOn = process.env['EAPI_HW_CAPTURE'] === '1'
if (hardwareOptIn && !captureOn) {
  console.warn('hw-inventory: SKIPPED — hardware target accepted for readiness, but writing capture files needs EAPI_HW_CAPTURE=1 (overwriting committed evidence is always explicit, PLAN.md:395 lineage)')
}
const runnable = resolution.ok && hardwareOptIn && captureOn

function extraSecrets(): string[] {
  const raw = process.env['EAPI_HW_SCRUB']
  if (raw === undefined || raw.trim() === '') return []
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

describe.skipIf(!runnable)('hardware batch 1: read-only inventory of the 7050TX-64 (#14 §3)', () => {
  let target: LiveTarget
  let reported: VersionProperties
  let negatives = 0
  let written = 0

  const scrub = extraSecrets()

  beforeAll(async () => {
    target = unwrapLiveTarget(resolution)
    console.log(`hw-inventory: target = ${describeLiveTarget(target)}`)
    if (extraSecrets().length === 0) {
      console.warn('hw-inventory: WARNING — EAPI_HW_SCRUB is unset/empty; hostname and address literals will NOT be scrubbed from config captures. Set it (comma-separated) before committing this tree.')
    }
    // Identity gate once, on a quiet node (no recorder): what the guard requires vs what the device says.
    const probeNode = createNode(liveTransportOptions(target))
    const reportedNow = await probeNode.getVersion()
    const mismatch = matchesDeviceIdentity(target, { version: reportedNow.version, modelName: reportedNow.modelName })
    if (mismatch !== undefined) {
      throw new Error(`hw-inventory: refusing to capture — ${mismatch.reason}`)
    }
    reported = reportedNow
    console.log(`hw-inventory: device self-report ok — version=${reportedNow.version} modelName=${reportedNow.modelName}`)
  })

  it('captures the whole catalog in one session, file-per-case, negatives recorded-not-dropped', async () => {
    const identity = hwDeviceIdentity({ version: reported.version, modelName: reported.modelName }, { topology: 'supervised 7050TX-64 session; single device; recorder per case' })
    const enablePassword = process.env['EAPI_ENABLE_PASS']

    for (const entry of HW_INVENTORY_CATALOG) {
      const scenario = entry.scenario === 'text' ? HW_TEXT_SCENARIO : undefined
      const caseName = hwCaseName(entry.cmd, scenario)
      const recorder = createRecorder()
      const node = createNode({
        ...liveTransportOptions(target),
        ...(enablePassword === undefined || enablePassword === '' ? {} : { enablePassword }),
        trace: recorder.sink,
      })
      let negative: string | undefined
      try {
        const results = await node.exec([entry.cmd], { format: entry.textOnly === true || entry.textPreferred === true ? 'text' : 'json' })
        expect(results.length, `one reply expected for ${caseName}`).toBe(1)
      } catch (err) {
        if (err instanceof CommandError) {
          negatives += 1
          negative = `recorded-negative (device refused — which shows the platform answers is itself §3 evidence): ${err.message.split(/\r?\n/u)[0]}`
        } else {
          throw new Error(`hw-inventory: transport-level failure on ${JSON.stringify(caseName)} — aborting, half-captured switch evidence is worse than none: ${(err as Error).message}`)
        }
      }
      if (recorder.incomplete().length > 0) {
        throw new Error(`hw-inventory: incomplete exchanges recorded for ${JSON.stringify(caseName)} — refusing to write a half-captured case`)
      }
      if (recorder.exchanges().length === 0) {
        throw new Error(`hw-inventory: no wire exchange recorded for ${JSON.stringify(caseName)} — recorder/transport wiring bug`)
      }
      const built = buildRecording(recorder, identity)
      const sanitized = sanitizeHwRecording(built, { extraSecrets: scrub })
      const out = writeRecording(sanitized.fixture, { caseName, overwrite: true })
      written += 1
      console.log(`hw-inventory: ${caseName}: ${out.created ? 'created' : 'refreshed'} (${String(out.bytes)} B, ${String(sanitized.log.length)} scrub(s))${negative === undefined ? '' : ' [negative recorded]'}`)
    }
    console.log(`hw-inventory: DONE — ${String(written)} case file(s), ${String(negatives)} recorded-negative`) 
    expect(written).toBe(HW_INVENTORY_CATALOG.length)
  })
})
